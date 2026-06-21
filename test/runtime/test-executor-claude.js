/**
 * Unit tests for executor-claude (WP-185 / WP-187)
 * Run with: node --test test/runtime/test-executor-claude.js
 *
 * 覆盖（用 fake spawn，不真调 claude binary，遵循 codebase DI-over-mocking 哲学）：
 *   - run() spawn claude 参数含 -p / --output-format json / --allowedTools 白名单
 *   - prompt 含 wpId / mode / strategy / json:machine-readable 要求
 *   - stdout JSON → text → json:machine-readable block 解析为 CheckResult
 *   - 解析失败降级（无 block → passed:false + parse reason）
 *   - 限流（rateLimitPerHour 超限返回 rate_limited）
 *   - 超时（timeoutMs 触发 kill → passed:false + timeout）
 *   - spawn 立即失败（ENOENT → passed:false + spawn_failed）
 *   - retry 模式注入 failingDrivers 到 prompt
 *   - WP 文档读取注入（存在/缺失）
 *   - 进展检测（passed=false 且 HEAD 未变 → _noProgress 标注）
 *   - 内部工具：buildPrompt / buildClaudeArgs / extractTextFromClaudeStdout /
 *     parseCheckResult / normalizeCheckResult
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var EventEmitter = require('events');

var executorClaude = require('../../plugins/runtime/executor-claude');
var createExecutor = executorClaude.createExecutor;

// ─────────────────────────────────────────────
// Helpers：fake spawn（模拟 child_process.spawn 返回的子进程）
// ─────────────────────────────────────────────

/**
 * 构造一个 fake spawn 函数，记录调用参数，返回模拟子进程。
 * @param {object} opts
 * @param {string} [opts.stdout] 子进程 stdout 内容（默认空）
 * @param {string} [opts.stderr] 子进程 stderr 内容（默认空）
 * @param {number} [opts.exitCode] 退出码（默认 0）
 * @param {Error} [opts.spawnError] spawn 立即抛错（如 ENOENT）
 * @param {boolean} [opts.emitError] 子进程 'error' 事件而非 close
 * @param {number} [opts.delayMs] close 前延迟（模拟耗时；默认 0）
 */
function makeFakeSpawn(opts) {
  opts = opts || {};
  var calls = [];
  var fakeSpawn = function (binary, args, spOpts) {
    calls.push({ binary: binary, args: args, opts: spOpts });
    if (opts.spawnError) throw opts.spawnError;
    var child = new EventEmitter();
    // 暴露最后一次 spawn 的子进程，供 prompt(stdin) 断言读取 _stdinBuf
    fakeSpawn.lastChild = child;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // 可写的 stdin stub：记录写入内容，供 prompt 走 stdin 的断言读取。
    // 真实子进程的 stdin 是 Writable；这里模拟 write/end/once/on 接口。
    child._stdinBuf = '';
    child.stdin = {
      _buf: child._stdinBuf,
      write: function (data) { child._stdinBuf += String(data); return true; },
      end: function () { child._stdinEnded = true; },
      on: function (_ev, _fn) { return this; },
      once: function (_ev, _fn) { return this; },
    };
    child.killed = false;
    child.kill = function (sig) { child.killed = true; child._killedWith = sig; };
    child._calls = calls;

    var emitClose = function () {
      if (opts.emitError) {
        child.emit('error', new Error('simulated spawn error'));
      } else {
        child.emit('close', opts.exitCode === undefined ? 0 : opts.exitCode);
      }
    };

    if (opts.delayMs && opts.delayMs > 0) {
      setTimeout(function () {
        if (opts.stdout) child.stdout.emit('data', opts.stdout);
        if (opts.stderr) child.stderr.emit('data', opts.stderr);
        emitClose();
      }, opts.delayMs);
    } else {
      // 同步先 emit data 再 close（模拟真实子进程时序）
      process.nextTick(function () {
        if (opts.stdout) child.stdout.emit('data', opts.stdout);
        if (opts.stderr) child.stderr.emit('data', opts.stderr);
        emitClose();
      });
    }
    return child;
  };
  fakeSpawn.calls = calls;
  fakeSpawn.lastChild = null;
  return fakeSpawn;
}

/** 构造含 json:machine-readable block 的 claude stdout（--output-format json）。 */
function makeClaudeStdout(checkResult) {
  var text = '执行完成。\n```json:machine-readable\n' +
    JSON.stringify(checkResult, null, 2) + '\n```\n';
  return JSON.stringify({ type: 'result', result: text });
}

function makePending(wpId, mode, extra) {
  var p = {
    wpId: wpId || 'WP-1',
    mode: mode || 'dispatch',
    strategy: 'full_restart',
    failingDrivers: [],
    createdAt: new Date().toISOString(),
    loopId: 'loop-test',
  };
  if (extra) for (var k in extra) p[k] = extra[k];
  return p;
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exec-claude-test-'));
}

function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

// ─────────────────────────────────────────────
// Section 1: spawn 参数与 prompt 构造
// ─────────────────────────────────────────────

test('run() spawn claude 含 -p / --output-format json / --allowedTools 白名单', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }) });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
  await exec.run(makePending('WP-1'));

  assert.strictEqual(fakeSpawn.calls.length, 1);
  var call = fakeSpawn.calls[0];
  assert.strictEqual(call.binary, 'claude');
  assert.ok(call.args.indexOf('-p') !== -1, '应含 -p');
  var ofIdx = call.args.indexOf('--output-format');
  assert.ok(ofIdx !== -1 && call.args[ofIdx + 1] === 'json', '应含 --output-format json');
  var atIdx = call.args.indexOf('--allowedTools');
  assert.ok(atIdx !== -1, '应含 --allowedTools');
  // 白名单内容应含 Read/Write/Edit/Bash 等
  var toolsStr = call.args[atIdx + 1];
  assert.ok(toolsStr.indexOf('Read') !== -1, 'allowedTools 应含 Read');
  assert.ok(toolsStr.indexOf('Write') !== -1, 'allowedTools 应含 Write');
  assert.ok(toolsStr.indexOf('Bash') !== -1, 'allowedTools 应含 Bash');
});

test('prompt 含 wpId / mode / json:machine-readable 要求', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout({ wpId: 'WP-5', passed: true, summary: { total: 1, passed: 1, failed: 0 } }) });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
  await exec.run(makePending('WP-5', 'dispatch'));

  // S1：prompt 经 stdin 传入，从子进程 stdin 捕获读取
  var promptArg = fakeSpawn.lastChild._stdinBuf;
  assert.ok(promptArg.indexOf('WP-5') !== -1, 'prompt 应含 wpId');
  assert.ok(promptArg.indexOf('dispatch') !== -1, 'prompt 应含 mode');
  assert.ok(promptArg.indexOf('json:machine-readable') !== -1, 'prompt 应要求产出 json:machine-readable block');
});

test('retry 模式 prompt 注入 failingDrivers', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout({ wpId: 'WP-3', passed: true, summary: { total: 1, passed: 1, failed: 0 } }) });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
  var pending = makePending('WP-3', 'retry', {
    failingDrivers: [{ wpId: 'WP-3', category: '测试检查', item: '边界覆盖', reason: '缺少 X' }],
  });
  await exec.run(pending);

  var promptArg = fakeSpawn.lastChild._stdinBuf;
  assert.ok(promptArg.indexOf('refine') !== -1 || promptArg.indexOf('失败项') !== -1, 'retry 应注入失败项段');
  assert.ok(promptArg.indexOf('边界覆盖') !== -1, 'prompt 应含 failingDrivers.item');
  assert.ok(promptArg.indexOf('缺少 X') !== -1, 'prompt 应含 failingDrivers.reason');
});

// ─────────────────────────────────────────────
// Section 2: stdout 解析 → CheckResult
// ─────────────────────────────────────────────

test('stdout JSON → text → block 解析为合法 CheckResult（passed）', async function () {
  var chk = {
    wpId: 'WP-7', passed: true,
    summary: { total: 4, passed: 4, failed: 0 },
    categories: [{ name: '代码质量', passed: true, items: [{ id: 'code-1', text: '规范', passed: true }] }],
    failedItems: [],
  };
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
  var result = await exec.run(makePending('WP-7'));

  assert.strictEqual(result.wpId, 'WP-7');
  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.summary.total, 4);
  assert.strictEqual(result.summary.failed, 0);
  assert.strictEqual(result.categories.length, 1);
  assert.deepStrictEqual(result.failedItems, []);
});

test('部分失败：passed=false，failedItems 透传', async function () {
  var chk = {
    wpId: 'WP-8', passed: false,
    summary: { total: 3, passed: 1, failed: 2 },
    categories: [], failedItems: [
      { category: '测试', id: 'test-1', reason: 'r1' },
      { category: '测试', id: 'test-2', reason: 'r2' },
    ],
  };
  // 用非 git tmpdir 避免 passed=false 触发进展检测追加 progress-1 项
  var dir = makeTmpDir();
  try {
    var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
    var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: dir });
    var result = await exec.run(makePending('WP-8'));

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.summary.failed, 2);
    assert.strictEqual(result.failedItems.length, 2, '应只透传 2 个失败项（非 git 目录不触发 progress 检测）');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('stdout 无 json:machine-readable block → 降级 passed:false', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: JSON.stringify({ type: 'result', result: '完成了但没产出判定块' }),
  });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
  var result = await exec.run(makePending('WP-9'));

  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems.length > 0);
  assert.ok(result.failedItems.some(function (fi) { return fi.reason.indexOf('machine-readable') !== -1; }),
    '应含 parse 失败 reason');
});

test('wpId 兜底：解析出的 chk 无 wpId 时用 pendingAction.wpId', async function () {
  var chk = { passed: true, summary: { total: 1, passed: 1, failed: 0 } }; // 无 wpId
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
  var result = await exec.run(makePending('WP-fallback'));
  assert.strictEqual(result.wpId, 'WP-fallback');
});

// ─────────────────────────────────────────────
// Section 3: 限流
// ─────────────────────────────────────────────

test('rateLimitPerHour 超限返回 rate_limited（不 spawn）', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
  });
  var exec = createExecutor({ spawnFn: fakeSpawn, rateLimitPerHour: 2, projectRoot: process.cwd() });
  await exec.run(makePending('WP-1'));
  await exec.run(makePending('WP-2'));
  var blocked = await exec.run(makePending('WP-3'));

  assert.strictEqual(fakeSpawn.calls.length, 2, '第三次不应再 spawn');
  assert.strictEqual(blocked.passed, false);
  assert.ok(blocked.failedItems.some(function (fi) { return fi.reason === 'rate_limited'; }));
  assert.strictEqual(blocked.wpId, 'WP-3');
});

// ─────────────────────────────────────────────
// Section 4: 超时
// ─────────────────────────────────────────────

test('timeoutMs 触发 kill → passed:false + timeout', async function () {
  var fakeSpawn = makeFakeSpawn({ delayMs: 200, stdout: 'late' });
  var exec = createExecutor({ spawnFn: fakeSpawn, timeoutMs: 30, projectRoot: process.cwd() });
  var result = await exec.run(makePending('WP-slow'));

  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems.some(function (fi) { return fi.reason === 'timeout'; }));
});

test('超时子进程被 kill（SIGTERM）', async function () {
  var killed = { value: false, sig: null };
  var fakeSpawn = function () {
    var child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = function (sig) { killed.value = true; killed.sig = sig; };
    setTimeout(function () { child.emit('close', 0); }, 200);
    return child;
  };
  var exec = createExecutor({ spawnFn: fakeSpawn, timeoutMs: 20, projectRoot: process.cwd() });
  await exec.run(makePending('WP-x'));
  assert.ok(killed.value, '子进程应被 kill');
  assert.strictEqual(killed.sig, 'SIGTERM');
});

// ─────────────────────────────────────────────
// Section 5: spawn 失败
// ─────────────────────────────────────────────

test('spawn 立即抛 ENOENT → passed:false + spawn_failed', async function () {
  var fakeSpawn = makeFakeSpawn({ spawnError: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
  var result = await exec.run(makePending('WP-noexe'));
  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems[0].reason.indexOf('spawn_failed') !== -1);
  assert.ok(result.failedItems[0].reason.indexOf('ENOENT') !== -1);
});

test('子进程 error 事件 → passed:false + spawn_error', async function () {
  var fakeSpawn = makeFakeSpawn({ emitError: true });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
  var result = await exec.run(makePending('WP-err'));
  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems[0].reason.indexOf('spawn_error') !== -1);
});

test('非 0 退出码且无解析结果 → passed:false + claude_exit_<code>', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: 'garbage no block', stderr: 'boom', exitCode: 1 });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
  var result = await exec.run(makePending('WP-fail'));
  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems[0].reason.indexOf('claude_exit_1') !== -1);
});

// ─────────────────────────────────────────────
// Section 5b: 进展检测（WP-187 / WP-191-2-impl，工作树脏度判据）
// ─────────────────────────────────────────────

// 注入式 gitStatusFn：返回固定的 porcelain 输出，控制工作树脏/干净，避免依赖真实 git 状态。
function makeGitStatus(dirty) {
  return function (_args, _opts) {
    return dirty ? ' M src/foo.js\n' : '';
  };
}
// 失败 gitStatusFn：模拟非 git 仓库（git status 抛错）→ readWorktreeDirty 降级返回 null
function makeGitStatusFailing() {
  return function (_args, _opts) {
    throw new Error('not a git repository');
  };
}

test('passed=false 且工作树干净 → noProgress=true + 追加 progress 失败项', async function () {
  var chk = {
    wpId: 'WP-stuck', passed: false,
    summary: { total: 1, passed: 0, failed: 1 },
    categories: [], failedItems: [{ category: '测试', id: 't-1', reason: 'r' }],
  };
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    gitStatusFn: makeGitStatus(false), // 执行前后均干净
  });
  var result = await exec.run(makePending('WP-stuck'));

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.noProgress, true, '工作树干净+passed=false → 无进展');
  assert.strictEqual(result._noProgress, true, '向后兼容字段应同步');
  assert.ok(result.failedItems.some(function (fi) { return fi.category === 'progress'; }),
    '应追加 progress 失败项');
});

test('passed=false 且工作树脏 → noProgress=false（有代码改动即有进展）', async function () {
  var chk = {
    wpId: 'WP-wip', passed: false,
    summary: { total: 1, passed: 0, failed: 1 },
    categories: [], failedItems: [{ category: '测试', id: 't-1', reason: 'r' }],
  };
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    gitStatusFn: makeGitStatus(true), // 执行后工作树脏
  });
  var result = await exec.run(makePending('WP-wip'));

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.noProgress, false, '工作树脏 → 有进展，不判无进展');
  assert.ok(!result.failedItems.some(function (fi) { return fi.category === 'progress'; }),
    '不应追加 progress 失败项');
});

test('passed=true → noProgress=false（达成即有进展）', async function () {
  var chk = { wpId: 'WP-ok', passed: true, summary: { total: 1, passed: 1, failed: 0 }, categories: [], failedItems: [] };
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    gitStatusFn: makeGitStatus(false),
  });
  var result = await exec.run(makePending('WP-ok'));

  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.noProgress, false);
  assert.ok(!result.failedItems.some(function (fi) { return fi.category === 'progress'; }));
});

test('非 git 仓库（git status 失败）→ 降级 noProgress=false，不误判不阻断', async function () {
  var chk = {
    wpId: 'WP-nogit', passed: false,
    summary: { total: 1, passed: 0, failed: 1 },
    categories: [], failedItems: [{ category: '测试', id: 't-1', reason: 'r' }],
  };
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    gitStatusFn: makeGitStatusFailing(),
  });
  var result = await exec.run(makePending('WP-nogit'));

  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.noProgress, false, '降级不误判无进展');
  assert.strictEqual(result._noProgress, undefined, '降级不写兼容字段');
  assert.ok(!result.failedItems.some(function (fi) { return fi.category === 'progress'; }));
});

// ─────────────────────────────────────────────
// Section 6: WP 文档读取注入
// ─────────────────────────────────────────────

test('WP 文档存在 → prompt 注入文档内容', async function () {
  var dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'docs', 'wp'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'wp', 'WP-42.md'), '# WP-42: 测试任务\n\n## 目标\n做 X', 'utf8');
    var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout({ wpId: 'WP-42', passed: true, summary: { total: 1, passed: 1, failed: 0 } }) });
    var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: dir });
    await exec.run(makePending('WP-42'));

    var promptArg = fakeSpawn.lastChild._stdinBuf;
    assert.ok(promptArg.indexOf('做 X') !== -1, 'prompt 应含 WP 文档内容');
    assert.ok(promptArg.indexOf('WP 文档') !== -1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('WP 文档缺失 → prompt 含提示（不阻断）', async function () {
  var dir = makeTmpDir();
  try {
    var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout({ wpId: 'WP-99', passed: true, summary: { total: 1, passed: 1, failed: 0 } }) });
    var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: dir });
    await exec.run(makePending('WP-99'));

    var promptArg = fakeSpawn.lastChild._stdinBuf;
    assert.ok(promptArg.indexOf('未找到') !== -1 || promptArg.indexOf('task-creator') !== -1,
      '缺失文档应有提示');
  } finally {
    cleanupTmpDir(dir);
  }
});

// ─────────────────────────────────────────────
// Section 7: 内部工具
// ─────────────────────────────────────────────

test('_extractTextFromClaudeStdout：result 字段', function () {
  var t = executorClaude._extractTextFromClaudeStdout(JSON.stringify({ result: 'hello' }));
  assert.strictEqual(t, 'hello');
});

test('_extractTextFromClaudeStdout：非 JSON 降级原样返回', function () {
  var t = executorClaude._extractTextFromClaudeStdout('plain text output');
  assert.strictEqual(t, 'plain text output');
});

test('_parseCheckResult：含 block 解析成功', function () {
  var text = '前缀\n```json:machine-readable\n{"wpId":"WP-1","passed":true}\n```\n后缀';
  var chk = executorClaude._parseCheckResult(text);
  assert.ok(chk);
  assert.strictEqual(chk.wpId, 'WP-1');
  assert.strictEqual(chk.passed, true);
});

test('_parseCheckResult：无 block 返回 null', function () {
  assert.strictEqual(executorClaude._parseCheckResult('no block here'), null);
});

test('_normalizeCheckResult：补齐缺失字段', function () {
  var chk = executorClaude._normalizeCheckResult({ wpId: 'WP-2', passed: true }, 'fallback');
  assert.strictEqual(chk.summary.total, 0);
  assert.deepStrictEqual(chk.categories, []);
  assert.deepStrictEqual(chk.failedItems, []);
});

test('_normalizeCheckResult：null 输入 → 解析失败 CheckResult', function () {
  var chk = executorClaude._normalizeCheckResult(null, 'WP-x');
  assert.strictEqual(chk.passed, false);
  assert.strictEqual(chk.wpId, 'WP-x');
  assert.ok(chk.failedItems[0].reason.indexOf('machine-readable') !== -1);
});

test('_buildClaudeArgs：仅 flags，prompt 不进 argv（S1 走 stdin）', function () {
  var args = executorClaude._buildClaudeArgs(['Read', 'Bash']);
  assert.ok(args.indexOf('-p') !== -1);
  // S1：args 不应携带任何 prompt 内容，仅含固定 flags
  assert.strictEqual(args.length, 5, '应为 -p / --output-format json / --allowedTools <tools> 共 5 项');
  var ofIdx = args.indexOf('--output-format');
  assert.strictEqual(args[ofIdx + 1], 'json');
  var atIdx = args.indexOf('--allowedTools');
  assert.strictEqual(args[atIdx + 1], 'Read,Bash', '--allowedTools 应为白名单拼接，且在末位');
  assert.ok(args.indexOf('my prompt') === -1, 'args 不应含 prompt（已改走 stdin）');
});

test('_buildClaudeArgs：传 settingsPath 时追加 --settings（透传 claude 原生 flag）', function () {
  var args = executorClaude._buildClaudeArgs(['Read'], 'C:/x/settings-glm-5.2[1m]max.json');
  var sIdx = args.indexOf('--settings');
  assert.ok(sIdx !== -1, '应含 --settings');
  assert.strictEqual(args[sIdx + 1], 'C:/x/settings-glm-5.2[1m]max.json');
  // 骨架 flags 仍在
  assert.ok(args.indexOf('-p') !== -1);
  // 无 settingsPath 时不追加（回归：长度仍为 5）
  var args2 = executorClaude._buildClaudeArgs(['Read']);
  assert.strictEqual(args2.indexOf('--settings'), -1, '无 settingsPath 时不应含 --settings');
});

test('run() 透传 settingsPath 到 spawn args', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: '{"result":"ok"}', exitCode: 0 });
  var exec = createExecutor({
    spawnFn: fakeSpawn,
    projectRoot: process.cwd(),
    settingsPath: '/tmp/my-profile.json',
  });
  await exec.run({ wpId: 'WP-1' });
  var spawnArgs = fakeSpawn.calls[0].args;
  var sIdx = spawnArgs.indexOf('--settings');
  assert.ok(sIdx !== -1, 'spawn args 应含 --settings');
  assert.strictEqual(spawnArgs[sIdx + 1], '/tmp/my-profile.json');
});
