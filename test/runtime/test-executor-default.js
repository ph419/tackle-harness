/**
 * Unit tests for executor-default (WP-188 重构)
 * Run with: node --test test/runtime/test-executor-default.js
 *
 * 覆盖（fake spawn + 注入时间，遵循 codebase DI-over-mocking 哲学）：
 *   - args 构造：settings 透传 / 环境变量场景追加 --model / 都无时纯骨架
 *   - quotaAware 门控：glm 模型→启用额度感知（接近上限降速/高峰 3x 计入）
 *   - 非 quotaAware：mimo/unknown 模型→不计额度、不降速
 *   - prompt 走 stdin、checklist 解析（复用 claude 解析）
 *   - 进展检测、限流、超时、spawn 失败降级
 *   - 额度逻辑（isPeakHour/quotaCostFactor/createQuotaTracker）从 executor-glm 搬迁，零漂移
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var EventEmitter = require('events');

var executorDefault = require('../../plugins/runtime/executor-default');
var createExecutor = executorDefault.createExecutor;

// ─────────────────────────────────────────────
// Helpers（风格对齐 test-executor-glm.js，零漂移搬迁）
// ─────────────────────────────────────────────

function makeFakeSpawn(opts) {
  opts = opts || {};
  var calls = [];
  var fakeSpawn = function (binary, args, spOpts) {
    calls.push({ binary: binary, args: args, opts: spOpts });
    if (opts.spawnError) throw opts.spawnError;
    var child = new EventEmitter();
    fakeSpawn.lastChild = child;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child._stdinBuf = '';
    child.stdin = {
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
      // 真延迟分支：用于超时测试（timeoutMs < delayMs，让 close 晚于 kill）
      setTimeout(function () {
        if (opts.stdout) child.stdout.emit('data', opts.stdout);
        if (opts.stderr) child.stderr.emit('data', opts.stderr);
        emitClose();
      }, opts.delayMs);
    } else {
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

function makeClaudeStdout(checkResult) {
  var text = '执行完成。\n```json:machine-readable\n' +
    JSON.stringify(checkResult, null, 2) + '\n```\n';
  return JSON.stringify({ type: 'result', result: text });
}

function makePending(wpId) {
  return {
    wpId: wpId || 'WP-1',
    mode: 'dispatch',
    strategy: 'full_restart',
    failingDrivers: [],
    createdAt: new Date().toISOString(),
    loopId: 'loop-test',
  };
}

/** 构造固定 UTC 小时的 nowFn（测试高峰系数，不受宿主时区影响）。 */
function fixedNowFn(utcHour) {
  return function () { return new Date(Date.UTC(2025, 0, 1, utcHour, 0, 0)); };
}

/** 智谱 Pro 档额度配置（与 resolver DEFAULT_PROVIDERS.glm.quota 同值）。 */
function glmQuotaConfig() {
  return {
    windowPrompts: 400, weeklyPrompts: 2000, softThreshold: 0.9,
    peakStartHour: 14, peakEndHour: 18,
    peakCostFactor: 3, offpeakCostFactor: 2,
    costModelRegex: '^glm[-_]?5(?!\\d)',
  };
}

function passedCheck(wpId) {
  return { wpId: wpId, passed: true, summary: { total: 1, passed: 1, failed: 0 },
    categories: [], failedItems: [] };
}

// ─────────────────────────────────────────────
// Section 1: args 构造（_buildDefaultArgs）
// ─────────────────────────────────────────────

test('_buildDefaultArgs：无 settings 无 model → 纯 claude 骨架', function () {
  var args = executorDefault._buildDefaultArgs(['Read', 'Bash']);
  assert.ok(args.indexOf('-p') !== -1);
  assert.strictEqual(args.indexOf('--settings'), -1);
  assert.strictEqual(args.indexOf('--model'), -1);
});

test('_buildDefaultArgs：有 settings → 追加 --settings，不追加 --model', function () {
  var args = executorDefault._buildDefaultArgs(['Read'], '/tmp/s.json', 'glm-5.2');
  var sIdx = args.indexOf('--settings');
  assert.ok(sIdx !== -1);
  assert.strictEqual(args[sIdx + 1], '/tmp/s.json');
  assert.strictEqual(args.indexOf('--model'), -1, 'settings 接管时 model 由文件决定');
});

test('_buildDefaultArgs：无 settings 有 model → 追加 --model', function () {
  var args = executorDefault._buildDefaultArgs(['Read'], null, 'glm-5.2');
  var mIdx = args.indexOf('--model');
  assert.ok(mIdx !== -1);
  assert.strictEqual(args[mIdx + 1], 'glm-5.2');
});

// 缺口-2（WP-193-1-audit §7 缺口-2）：settingsPath 非空 + model 非空时
// run() 端到端层 spawn 的 args 应①含 --settings 透传路径②不含 --model（model 由 settings
// 文件决定，executor 不重复追加）。此前仅 _buildDefaultArgs 单元层覆盖，此处补 run() 层
// 真实 spawn 捕获 args 断言，锁死"settings 接管时 model 透传不追加"契约。
test('run() 端到端：settingsPath+model → args 含 --settings 不含 --model', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    settingsPath: '/tmp/settings-glm.json',
    model: 'glm-5.2',         // resolver 从 settings 探测出的 model，一并传入
    provider: 'glm',
    quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(2),
  });
  await exec.run(makePending('WP-1'));
  assert.strictEqual(fakeSpawn.calls.length, 1, '应 spawn 一次');
  var args = fakeSpawn.calls[0].args;
  var sIdx = args.indexOf('--settings');
  assert.ok(sIdx !== -1, 'args 应含 --settings（透传 settings 文件）');
  assert.strictEqual(args[sIdx + 1], '/tmp/settings-glm.json');
  assert.strictEqual(args.indexOf('--model'), -1,
    'settings 接管时 model 由文件决定，args 不应重复追加 --model');
});

// ─────────────────────────────────────────────
// Section 2: 非 quotaAware（mimo/unknown）→ 纯透传
// ─────────────────────────────────────────────

test('mimo 模型：不启用额度感知，不计额度', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'mimo-v2.5-pro', provider: 'mimo',
    // 无 quotaConfig → quotaAware=false
  });
  var chk = await exec.run(makePending('WP-1'));
  assert.strictEqual(fakeSpawn.calls.length, 1, '应正常 spawn');
  assert.strictEqual(exec.quota.windowUsed(), 0, 'mimo 不计额度');
  assert.strictEqual(chk.passed, true);
});

test('unknown 模型：无额度约束，连续多次 spawn', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: null, provider: 'unknown',
  });
  await exec.run(makePending('WP-1'));
  await exec.run(makePending('WP-2'));
  await exec.run(makePending('WP-3'));
  assert.strictEqual(fakeSpawn.calls.length, 3);
  assert.strictEqual(exec.quota.windowRatio(), 0);
});

// ─────────────────────────────────────────────
// Section 3: quotaAware（glm）→ 额度感知门控
// ─────────────────────────────────────────────

test('glm 模型：spawn 后按系数计入额度窗口', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'glm-5.2', provider: 'glm', quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(2), // 非高峰 UTC 2 = 北京 10 → offpeak 2x
  });
  await exec.run(makePending('WP-1'));
  assert.strictEqual(exec.quota.windowUsed(), 2, '非高峰 glm-5.2 应计 2x');
});

test('glm 模型：高峰时段（北京 14-18）计 3x', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'glm-5.2', provider: 'glm', quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(7), // UTC 7 = 北京 15 → 高峰 3x
  });
  await exec.run(makePending('WP-1'));
  assert.strictEqual(exec.quota.windowUsed(), 3, '高峰应计 3x');
});

test('glm-4.6：不受高峰系数，计 1x', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'glm-4.6', provider: 'glm', quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(7), // 高峰但 4.6 不受系数
  });
  await exec.run(makePending('WP-1'));
  assert.strictEqual(exec.quota.windowUsed(), 1, 'glm-4.6 恒 1x');
});

test('GLM-5.2 大写变体：高峰 3x / 非高峰 2x（对齐原 /i 语义，零漂移）', async function () {
  // 原 executor-glm quotaCostFactor 用 /^glm[-_]?5(?!\d)/i，大写变体应受高峰系数。
  // costModelRegex 编译须传 'i'，否则 GLM-5.2 / GLM5Turbo 计 1x（断裂）。
  var fakePeak = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var execPeak = createExecutor({
    spawnFn: fakePeak, projectRoot: process.cwd(),
    model: 'GLM-5.2', provider: 'glm', quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(7), // UTC7=北京15 → 高峰 3x
  });
  await execPeak.run(makePending('WP-1'));
  assert.strictEqual(execPeak.quota.windowUsed(), 3, '大写 GLM-5.2 高峰应计 3x');

  var fakeOff = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-2')) });
  var execOff = createExecutor({
    spawnFn: fakeOff, projectRoot: process.cwd(),
    model: 'GLM5Turbo', provider: 'glm', quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(2), // UTC2=北京10 → 非高峰 2x
  });
  await execOff.run(makePending('WP-2'));
  assert.strictEqual(execOff.quota.windowUsed(), 2, '大写 GLM5Turbo 非高峰应计 2x');
});

test('glm 模型：接近软上限 → quota_exhausted 不 spawn', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'glm-5.2', provider: 'glm',
    quotaConfig: Object.assign({}, glmQuotaConfig(), {
      windowPrompts: 2, softThreshold: 0.9, // 极小窗口
    }),
    nowFn: fixedNowFn(2),
  });
  await exec.run(makePending('WP-1')); // 计 2，windowUsed=2 >= 0.9*2=1.8
  await exec.run(makePending('WP-2')); // 应被拦截
  assert.strictEqual(fakeSpawn.calls.length, 1, '第 2 次应被 quota_exhausted 拦截，不 spawn');
});

test('glm 模型：非 0 退出 + 无 checklist 解析 → 失败但计额度', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: 'garbage', exitCode: 1 });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'glm-5.2', provider: 'glm', quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(2),
  });
  var chk = await exec.run(makePending('WP-1'));
  assert.strictEqual(chk.passed, false);
  assert.strictEqual(exec.quota.windowUsed(), 2, '真正运行过（exit 1）应计额度');
});

// ─────────────────────────────────────────────
// Section 4: spawn 失败不计额度（仅 quotaAware）
// ─────────────────────────────────────────────

test('glm：spawn_error 不计额度', async function () {
  var fakeSpawn = makeFakeSpawn({ emitError: true });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'glm-5.2', provider: 'glm', quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(2),
  });
  await exec.run(makePending('WP-1'));
  assert.strictEqual(exec.quota.windowUsed(), 0, 'spawn_error 不计额度');
});

test('glm：spawn 立即抛错（ENOENT）不计额度', async function () {
  var fakeSpawn = makeFakeSpawn({ spawnError: new Error('ENOENT') });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'glm-5.2', provider: 'glm', quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(2),
  });
  await exec.run(makePending('WP-1'));
  assert.strictEqual(exec.quota.windowUsed(), 0);
});

// ─────────────────────────────────────────────
// Section 5: prompt 走 stdin + checklist 解析（复用 claude）
// ─────────────────────────────────────────────

test('prompt 走 stdin（S1），args 不含 prompt 内容', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'glm-5.2', provider: 'glm', quotaConfig: glmQuotaConfig(),
    nowFn: fixedNowFn(2),
  });
  await exec.run(makePending('WP-1'));
  assert.ok(fakeSpawn.lastChild._stdinBuf.indexOf('WP-1') !== -1, 'prompt 应含 wpId');
  assert.ok(fakeSpawn.calls[0].args.indexOf('WP-1') === -1, 'args 不应含 prompt');
});

test('checklist 解析：json:machine-readable block → CheckResult', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), model: 'mimo', provider: 'mimo',
  });
  var chk = await exec.run(makePending('WP-1'));
  assert.strictEqual(chk.passed, true);
  assert.strictEqual(chk.wpId, 'WP-1');
});

test('checklist 解析失败 → 降级 passed:false', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: 'no block here', exitCode: 0 });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), model: 'mimo', provider: 'mimo',
  });
  var chk = await exec.run(makePending('WP-1'));
  assert.strictEqual(chk.passed, false);
});

// ─────────────────────────────────────────────
// Section 6: 限流 + 超时
// ─────────────────────────────────────────────

test('限流：超过 rateLimitPerHour → rate_limited', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(passedCheck('WP-1')) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'mimo', provider: 'mimo', rateLimitPerHour: 1,
  });
  await exec.run(makePending('WP-1'));
  var chk = await exec.run(makePending('WP-2'));
  assert.strictEqual(chk.passed, false);
  assert.ok(chk.failedItems.some(function (f) { return f.reason === 'rate_limited'; }));
});

test('超时：timeoutMs 触发 kill → passed:false + timeout', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout(passedCheck('WP-1')),
    delayMs: 50,
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    model: 'mimo', provider: 'mimo', timeoutMs: 20,
  });
  var chk = await exec.run(makePending('WP-1'));
  assert.strictEqual(chk.passed, false);
  assert.ok(chk.failedItems.some(function (f) { return f.reason === 'timeout'; }));
  assert.ok(fakeSpawn.lastChild.killed, '应 kill 子进程');
});

// ─────────────────────────────────────────────
// Section 7: 接口契约
// ─────────────────────────────────────────────

test('createExecutor 返回接口契约 { name, run, config, quota }', function () {
  var exec = createExecutor({ model: 'mimo', provider: 'mimo' });
  assert.strictEqual(exec.name, 'default');
  assert.strictEqual(typeof exec.run, 'function');
  assert.ok(exec.config && typeof exec.config === 'object');
  assert.ok(exec.quota && typeof exec.quota.windowRatio === 'function');
});

test('quotaAware=false 时 quota 视图各方法返回 0', function () {
  var exec = createExecutor({ model: 'mimo', provider: 'mimo' });
  assert.strictEqual(exec.quota.windowUsed(), 0);
  assert.strictEqual(exec.quota.weekUsed(), 0);
  assert.strictEqual(exec.quota.windowRatio(), 0);
});

// ─────────────────────────────────────────────
// Section 8: 额度逻辑内部工具（从 executor-glm 搬迁，零漂移回归）
// ─────────────────────────────────────────────

test('_isPeakHour：北京 14-18 高峰判定', function () {
  // beijingHour = (utcHour + 8) % 24；peakStartHour/End 是北京小时，左闭右开 [14,18)
  assert.strictEqual(executorDefault._isPeakHour(14, 18, fixedNowFn(6)), true);   // UTC6=北京14（含起点）
  assert.strictEqual(executorDefault._isPeakHour(14, 18, fixedNowFn(7)), true);   // UTC7=北京15
  assert.strictEqual(executorDefault._isPeakHour(14, 18, fixedNowFn(9)), true);   // UTC9=北京17（仍含）
  assert.strictEqual(executorDefault._isPeakHour(14, 18, fixedNowFn(10)), false); // UTC10=北京18（不含终点）
  assert.strictEqual(executorDefault._isPeakHour(14, 18, fixedNowFn(5)), false);  // UTC5=北京13（起点前）
});

test('_quotaCostFactor：非 quotaConfig → 1', function () {
  assert.strictEqual(executorDefault._quotaCostFactor('glm-5.2', null), 1);
});

test('_createQuotaTracker：窗口/周消耗与 prune', function () {
  var baseTime = Date.UTC(2025, 0, 1, 0, 0, 0);
  var t = baseTime;
  var nowFn = function () { return new Date(t); };
  var tracker = executorDefault._createQuotaTracker(
    { windowPrompts: 10, weeklyPrompts: 20 }, nowFn);
  tracker.record(1);
  tracker.record(3);
  assert.strictEqual(tracker.windowUsed(), 4);
  assert.strictEqual(tracker.weekUsed(), 4);
  t = baseTime + 6 * 3600 * 1000; // 推进 6h（超 5h 窗口，仍在周内）
  assert.strictEqual(tracker.windowUsed(), 0, '6h 后窗口应清空');
  assert.strictEqual(tracker.weekUsed(), 4, '周内仍累计');
  assert.strictEqual(tracker.windowRatio(), 0.2, '0/10 vs 4/20 取大 = 0.2');
});
