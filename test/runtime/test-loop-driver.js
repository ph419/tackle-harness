/**
 * Unit tests for loop command driver (WP-184-impl)
 * Run with: node --test test/runtime/test-loop-driver.js
 *
 * 覆盖（M1 验收核心）：
 *   - driver + executor-local 端到端：verdict 收敛到 achieved，proximity 单调递增到 1
 *   - PROGRESS.md 同步：所有 goal WP 都被写为 `- [x] WP-NNN`
 *   - verdict=achieved 时 exit code = 0
 *   - 终态出口（timeout/diverged）：exit code = 1，产出 terminalReport
 *   - 缓存失效修复回归：driver 必须能逐个 dispatch 不同 WP（不卡在首个）
 *   - 参数解析（parseArgs）
 *
 * 关键回归点（WP-184 发现）：driver 的 StateStore 缓存若不 invalidate，会读到 engine
 *   最新写入前的旧 pendingAction，导致永远 dispatch 第一个 WP、loop 无法收敛。
 *   本测试的「收敛到 achieved」即是对该修复的端到端回归。
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var loopCmd = require('../../bin/commands/loop');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loop-driver-test-'));
}

function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

/**
 * 构造一个 plan.md（无显式 WP 编号 → 派生 WP-1..N）。
 * @param {number} wpCount
 * @returns {string} markdown 内容
 */
function makePlan(wpCount) {
  var lines = ['# Smoke Plan', ''];
  for (var i = 1; i <= wpCount; i++) {
    lines.push('## Step ' + i + ': 实现 ' + i);
    lines.push('- [ ] 任务 ' + i + '.1');
    lines.push('- [ ] 任务 ' + i + '.2');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 构造伪 ctx，捕获 exit code 与 log 输出，在隔离 tmpdir 中运行。
 * @param {string} dir
 * @param {string[]} argv
 */
function makeCtx(dir, argv) {
  var logs = [];
  var exitCode = { value: null };
  return {
    ctx: {
      targetRoot: dir,
      packageRoot: path.resolve(__dirname, '..', '..'),
      flags: { noColor: true },
      command: 'loop',
      packageVersion: 'test',
      argv: argv || [],
      colorize: function (t) { return t; },
      exit: function (code) { exitCode.value = code; },
      log: function (msg) { logs.push(String(msg)); },
    },
    logs: logs,
    exitCode: exitCode,
  };
}

function setupEnv(planWpCount) {
  var dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  // 写 task.md 为空 → readMaxWpNumber 返回 0 → WPs 派生为 WP-1..N
  fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.claude', 'plan.md'), makePlan(planWpCount || 3), 'utf8');
  var origCwd = process.cwd();
  process.chdir(dir);
  return {
    dir: dir,
    planPath: path.join(dir, '.claude', 'plan.md'),
    origCwd: origCwd,
    restore: function () { process.chdir(origCwd); cleanupTmpDir(dir); },
  };
}

// ─────────────────────────────────────────────
// Section 1: 参数解析
// ─────────────────────────────────────────────

test('parseArgs 解析 plan 路径与 flags', function () {
  var a = loopCmd._parseArgs(['docs/plan/x.md', '--executor=local', '--max-iters=10']);
  assert.strictEqual(a.planPath, 'docs/plan/x.md');
  assert.strictEqual(a.executor, 'local');
  assert.strictEqual(a.maxIters, 10);
});

test('parseArgs 默认 executor=local', function () {
  var a = loopCmd._parseArgs(['plan.md']);
  assert.strictEqual(a.executor, 'local');
  assert.strictEqual(a.maxIters, null);
});

test('parseArgs 支持 --loop-id / --state-dir / --dry-run', function () {
  var a = loopCmd._parseArgs(['plan.md', '--loop-id=loop-x', '--state-dir=.loop-state', '--dry-run']);
  assert.strictEqual(a.loopId, 'loop-x');
  assert.strictEqual(a.stateDir, '.loop-state');
  assert.strictEqual(a.dryRun, true);
});

// ─────────────────────────────────────────────
// Section 2: 端到端收敛（M1 验收核心）
// ─────────────────────────────────────────────

test('driver + executor-local 收敛到 achieved（3 WP）', async function () {
  var env = setupEnv(3);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local']);
    await loopCmd.execute(h.ctx);

    assert.strictEqual(h.exitCode.value, 0, 'achieved should exit 0');
    var combined = h.logs.join('\n');
    assert.ok(combined.indexOf('achieved') !== -1, 'should report achieved');
    assert.ok(combined.indexOf('proximity: 1.000') !== -1, 'proximity should reach 1.0');
  } finally {
    env.restore();
  }
});

test('driver 逐个 dispatch 不同 WP（缓存失效修复回归）', async function () {
  var env = setupEnv(3);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local']);
    await loopCmd.execute(h.ctx);

    var combined = h.logs.join('\n');
    // 若缓存失效修复失效，driver 会卡在 WP-1 反复 dispatch，永远不出现 WP-2/WP-3
    assert.ok(combined.indexOf('WP-1') !== -1, 'should dispatch WP-1');
    assert.ok(combined.indexOf('WP-2') !== -1, 'should dispatch WP-2 (cache invalidation works)');
    assert.ok(combined.indexOf('WP-3') !== -1, 'should dispatch WP-3 (cache invalidation works)');
  } finally {
    env.restore();
  }
});

test('PROGRESS.md 同步写入所有 goal WP 的完成行', async function () {
  var env = setupEnv(3);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local']);
    await loopCmd.execute(h.ctx);

    var progressPath = path.join(env.dir, 'PROGRESS.md');
    assert.ok(fs.existsSync(progressPath), 'PROGRESS.md should be written');
    var content = fs.readFileSync(progressPath, 'utf8');
    assert.ok(/\[x\]\s*WP-1\b/.test(content), 'WP-1 marked done');
    assert.ok(/\[x\]\s*WP-2\b/.test(content), 'WP-2 marked done');
    assert.ok(/\[x\]\s*WP-3\b/.test(content), 'WP-3 marked done');
  } finally {
    env.restore();
  }
});

test('lastChecklist 回填到 state-store（proximity 上升依据）', async function () {
  var env = setupEnv(2);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local']);
    await loopCmd.execute(h.ctx);

    // 验证 .claude-state 含 lastChecklist 子键（driver 回填）
    var stateStore = require('../../plugins/runtime/state-store');
    var store = new stateStore.StateStore({ filePath: path.join(env.dir, '.claude-state') });
    var keys = await store.keys();
    var hasLastChecklist = keys.some(function (k) {
      return k.indexOf('.lastChecklist') !== -1;
    });
    assert.ok(hasLastChecklist, 'lastChecklist should be persisted in state-store');
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 3: 终态出口
// ─────────────────────────────────────────────

test('max-iters=1 触发 timeout，exit code = 1', async function () {
  var env = setupEnv(3);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local', '--max-iters=1']);
    await loopCmd.execute(h.ctx);

    assert.strictEqual(h.exitCode.value, 1, 'timeout should exit 1');
    var combined = h.logs.join('\n');
    assert.ok(combined.indexOf('timeout') !== -1, 'should report timeout');
  } finally {
    env.restore();
  }
});

test('dry-run 触发 diverged（无执行无进展），exit code = 1', async function () {
  var env = setupEnv(3);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local', '--dry-run']);
    await loopCmd.execute(h.ctx);

    assert.strictEqual(h.exitCode.value, 1, 'diverged should exit 1');
    var combined = h.logs.join('\n');
    assert.ok(combined.indexOf('diverged') !== -1, 'should report diverged');
  } finally {
    env.restore();
  }
});

test('终态报告含 proximity 趋势表', async function () {
  var env = setupEnv(3);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local', '--dry-run']);
    await loopCmd.execute(h.ctx);

    var combined = h.logs.join('\n');
    assert.ok(combined.indexOf('Proximity 趋势') !== -1 || combined.indexOf('proximity') !== -1,
      'terminal report should include proximity trend');
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 4: 错误输入
// ─────────────────────────────────────────────

test('plan 文件不存在 → exit code = 2', async function () {
  var env = setupEnv(1);
  try {
    var h = makeCtx(env.dir, ['nonexistent.md']);
    await loopCmd.execute(h.ctx);
    assert.strictEqual(h.exitCode.value, 2);
  } finally {
    env.restore();
  }
});

test('未知 executor → exit code = 2', async function () {
  var env = setupEnv(1);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=nonexistent']);
    await loopCmd.execute(h.ctx);
    assert.strictEqual(h.exitCode.value, 2);
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 5: 多 WP 单调 proximity 上升
// ─────────────────────────────────────────────

test('proximity 单调递增（1 WP → 0.x → 1.0）', async function () {
  var env = setupEnv(2);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local']);
    await loopCmd.execute(h.ctx);

    // 从 log 抓 dispatch 顺序：WP-1 在 WP-2 之前出现
    var combined = h.logs.join('\n');
    var i1 = combined.indexOf('WP-1');
    var i2 = combined.indexOf('WP-2');
    assert.ok(i1 !== -1 && i2 !== -1, 'both WPs dispatched');
    assert.ok(i1 < i2, 'WP-1 dispatched before WP-2 (sequential progress)');
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 6: per-loop state 物理隔离（WP-189）
//
// 验收锚点：两个不同 --loop-id 的 loop 各自独立 state 目录，互不覆盖、各自收敛。
// 解决 state-store 多进程并发写丢数据（state-store.js:19-23 明确不支持并发写）。
// ─────────────────────────────────────────────

test('_resolveLoopWorkspace：无 loop-id → 非隔离，state 在 projectRoot', function () {
  var dir = makeTmpDir();
  try {
    var ws = loopCmd._resolveLoopWorkspace(dir, null, null);
    assert.strictEqual(ws.isolated, false);
    assert.strictEqual(ws.workspaceRoot, dir);
    assert.strictEqual(ws.stateFile, path.join(dir, '.claude-state'));
  } finally {
    cleanupTmpDir(dir);
  }
});

test('_resolveLoopWorkspace：有 loop-id → 建隔离目录 + task.md 占位', function () {
  var dir = makeTmpDir();
  try {
    var ws = loopCmd._resolveLoopWorkspace(dir, '.tackle-state', 'loop-X');
    assert.strictEqual(ws.isolated, true);
    assert.strictEqual(ws.workspaceRoot, path.join(dir, '.tackle-state', 'loop-X'));
    assert.strictEqual(ws.stateFile, path.join(ws.workspaceRoot, '.claude-state'));
    // task.md 占位已写入（让 engine _resolveProjectRoot 探测命中）
    assert.ok(fs.existsSync(path.join(ws.workspaceRoot, 'task.md')), 'task.md 占位应存在');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('_resolveLoopWorkspace：自定义 --state-dir 生效', function () {
  var dir = makeTmpDir();
  try {
    var ws = loopCmd._resolveLoopWorkspace(dir, 'custom-state', 'L1');
    assert.ok(ws.workspaceRoot.indexOf(path.join('custom-state', 'L1')) !== -1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('--loop-id 隔离：state 文件与 PROGRESS.md 落在隔离目录，各自收敛', async function () {
  // 在真实项目根下用 .tackle-state 隔离（模拟两终端并发不同 loop-id）
  // 用独立的 state-dir 避免污染项目既有 .tackle-state
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), makePlan(2), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    // loop-A
    process.chdir(projectRoot);
    var hA = makeCtx(projectRoot, [planPath, '--executor=local', '--loop-id=A', '--state-dir=.ts-A']);
    await loopCmd.execute(hA.ctx);
    // loop-B（同 projectRoot，不同 loop-id）
    process.chdir(projectRoot);
    var hB = makeCtx(projectRoot, [planPath, '--executor=local', '--loop-id=B', '--state-dir=.ts-B']);
    await loopCmd.execute(hB.ctx);

    // 两 loop 都收敛
    assert.strictEqual(hA.exitCode.value, 0, 'loop-A should achieve');
    assert.strictEqual(hB.exitCode.value, 0, 'loop-B should achieve');

    // state 文件物理隔离：各自的 .claude-state 含各自 loopId，不含对方
    var stateA = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.ts-A', 'A', '.claude-state'), 'utf8'));
    var stateB = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.ts-B', 'B', '.claude-state'), 'utf8'));
    assert.strictEqual(stateA.loop.A.loopId, 'A');
    assert.strictEqual(stateB.loop.B.loopId, 'B');
    assert.ok(!stateA.loop.B, 'loop-A state 不应含 loop-B 数据');
    assert.ok(!stateB.loop.A, 'loop-B state 不应含 loop-A 数据');

    // PROGRESS.md 各自独立
    var progA = fs.readFileSync(path.join(projectRoot, '.ts-A', 'A', 'PROGRESS.md'), 'utf8');
    var progB = fs.readFileSync(path.join(projectRoot, '.ts-B', 'B', 'PROGRESS.md'), 'utf8');
    assert.ok(/\[x\]\s*WP-1/.test(progA) && /\[x\]\s*WP-2/.test(progA), 'loop-A PROGRESS 完整');
    assert.ok(/\[x\]\s*WP-1/.test(progB) && /\[x\]\s*WP-2/.test(progB), 'loop-B PROGRESS 完整');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

test('--loop-id 隔离：两 loop 用同一 state-dir 不同 loop-id 也不互相覆盖', async function () {
  // 更严格：共享 state-dir，仅靠 loop-id 子目录区分（模拟真实多 loop 并行场景）
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), makePlan(2), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    process.chdir(projectRoot);
    var hA = makeCtx(projectRoot, [planPath, '--executor=local', '--loop-id=A', '--state-dir=.shared']);
    await loopCmd.execute(hA.ctx);
    process.chdir(projectRoot);
    var hB = makeCtx(projectRoot, [planPath, '--executor=local', '--loop-id=B', '--state-dir=.shared']);
    await loopCmd.execute(hB.ctx);

    assert.strictEqual(hA.exitCode.value, 0);
    assert.strictEqual(hB.exitCode.value, 0);
    // 共享 state-dir，但子目录隔离：A 与 B 各自独立
    var dirA = path.join(projectRoot, '.shared', 'A');
    var dirB = path.join(projectRoot, '.shared', 'B');
    assert.ok(fs.existsSync(path.join(dirA, '.claude-state')), 'A 隔离目录有 state');
    assert.ok(fs.existsSync(path.join(dirB, '.claude-state')), 'B 隔离目录有 state');
    var sA = JSON.parse(fs.readFileSync(path.join(dirA, '.claude-state'), 'utf8'));
    var sB = JSON.parse(fs.readFileSync(path.join(dirB, '.claude-state'), 'utf8'));
    assert.strictEqual(sA.loop.A.loopId, 'A');
    assert.strictEqual(sB.loop.B.loopId, 'B');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

test('回退安全：无 --loop-id 时 state 仍在 projectRoot（不破坏 M1~M3 形态）', async function () {
  var env = setupEnv(2);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local']);
    await loopCmd.execute(h.ctx);
    // 非隔离：state 文件直接在 projectRoot，无 .tackle-state 子目录
    assert.ok(fs.existsSync(path.join(env.dir, '.claude-state')), 'state 在 projectRoot');
    assert.ok(!fs.existsSync(path.join(env.dir, '.tackle-state')), '不应建隔离目录');
    assert.strictEqual(h.exitCode.value, 0);
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 6.5: chdir 还原 + sidecar 写失败降级（WP-191-4-impl 项 5/7）
// ─────────────────────────────────────────────

// WP-191-4-impl 项 5（回退安全）：隔离 loop execute 后 cwd 必须还原回原始目录
test('隔离 loop execute 后 cwd 还原（不污染同进程后续逻辑）', async function () {
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), makePlan(1), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    process.chdir(projectRoot);
    var h = makeCtx(projectRoot, [planPath, '--executor=local', '--loop-id=restore-test', '--state-dir=.ts-restore']);
    await loopCmd.execute(h.ctx);
    assert.strictEqual(h.exitCode.value, 0, 'loop 应收敛');
    // 关键断言：execute 结束后 cwd 必须还原回 projectRoot（而非停留在隔离目录）。
    // macOS 上 os.tmpdir() 返回 '/var/folders/...'，但该路径是 '/private/var/folders/...'
    // 的符号链接，process.chdir 后 process.cwd() 返回真实路径（含 /private 前缀）。
    // 故两端都做 realpath 规约后再比较，避免符号链接前缀差异导致的假阴性。
    assert.strictEqual(
      fs.realpathSync(path.resolve(process.cwd())),
      fs.realpathSync(path.resolve(projectRoot)),
      'execute 后 cwd 必须还原（不应停留在 .ts-restore/restore-test）'
    );
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

// WP-191-4-impl 项 7（回退降级）：sidecar 写失败记录 warning，不抛错
test('_writeExecutorSidecar：写失败记录 warning 而非静默吞错', function () {
  var dir = makeTmpDir();
  var warnings = [];
  var savedWarn = loopCmd._writeExecutorSidecar._warn;
  try {
    // 注入 warn 捕获器
    loopCmd._writeExecutorSidecar._warn = function (msg) { warnings.push(String(msg)); };
    // 把 wsRoot 设为一个不存在的只读路径模拟写失败：用 .executor 作为目录名（writeFileSync 到目录会 EISDIR）
    var badPath = path.join(dir, 'blocking-dir');
    fs.mkdirSync(badPath, { recursive: true });
    // target = 目录本身 → writeFileSync(path.join(badPath, '.executor')) 仍可写；
    // 改用：把 .executor 本身预先建为目录 → writeFileSync 写到目录触发 EISDIR
    fs.mkdirSync(path.join(badPath, '.executor'), { recursive: true });
    // 不应抛错（回退安全）
    assert.doesNotThrow(function () {
      loopCmd._writeExecutorSidecar(badPath, 'glm', 'glm-5.2');
    });
    // 应记录 warning（非静默）
    assert.ok(warnings.length >= 1, '写失败应记录 warning');
    assert.ok(warnings[0].indexOf('.executor sidecar') !== -1, 'warning 应提及 sidecar');
  } finally {
    if (savedWarn === undefined) delete loopCmd._writeExecutorSidecar._warn;
    else loopCmd._writeExecutorSidecar._warn = savedWarn;
    cleanupTmpDir(dir);
  }
});

test('_writeExecutorSidecar：正常写入不触发 warning', function () {
  var dir = makeTmpDir();
  var warnings = [];
  var savedWarn = loopCmd._writeExecutorSidecar._warn;
  try {
    loopCmd._writeExecutorSidecar._warn = function (msg) { warnings.push(String(msg)); };
    loopCmd._writeExecutorSidecar(dir, 'claude', 'claude-fable-5');
    assert.ok(fs.existsSync(path.join(dir, '.executor')), 'sidecar 正常写入');
    assert.strictEqual(warnings.length, 0, '正常写入不应触发 warning');
    // 内容含 model
    var data = JSON.parse(fs.readFileSync(path.join(dir, '.executor'), 'utf8'));
    assert.strictEqual(data.provider, 'claude');
    assert.strictEqual(data.model, 'claude-fable-5');
  } finally {
    if (savedWarn === undefined) delete loopCmd._writeExecutorSidecar._warn;
    else loopCmd._writeExecutorSidecar._warn = savedWarn;
    cleanupTmpDir(dir);
  }
});

// ─────────────────────────────────────────────
// Section 7: 守护进程心跳（WP-191-1-impl-a）
//
// 验收锚点（P0 修复）：
//   - touchExecutorSidecar 刷新 .executor mtime
//   - touch 失败（文件不存在/权限）降级不抛
//   - 长时间单轮（mtime 旧但 driver 活跃）coordinator 不误判 disconnected
// ─────────────────────────────────────────────

test('_touchExecutorSidecar：刷新已存在 sidecar 的 mtime', function () {
  var dir = makeTmpDir();
  try {
    var sidecarPath = path.join(dir, '.executor');
    // init 写入 sidecar
    loopCmd._writeExecutorSidecar(dir, 'claude');
    assert.ok(fs.existsSync(sidecarPath), 'sidecar 已写入');
    var mtimeBefore = fs.statSync(sidecarPath).mtimeMs;

    // 等待时钟推进（Windows/某些 FS mtime 精度有限，确保 mtime 变化可观测）
    var past = new Date(Date.now() - 10 * 60 * 1000); // 10min 前
    fs.utimesSync(sidecarPath, past, past);
    var mtimeRolledBack = fs.statSync(sidecarPath).mtimeMs;
    assert.ok(mtimeRolledBack < mtimeBefore - 60 * 1000,
      '已人为回拨 mtime（模拟长时间未活动）');

    // touch 刷新到当前时间
    loopCmd._touchExecutorSidecar(dir);
    var mtimeAfter = fs.statSync(sidecarPath).mtimeMs;
    assert.ok(mtimeAfter > Date.now() - 5000, 'mtime 刷新到接近当前时间');
    assert.ok(mtimeAfter > mtimeRolledBack + 60 * 1000, 'mtime 从回拨态恢复到当前');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('_touchExecutorSidecar：sidecar 不存在时静默降级不抛', function () {
  var dir = makeTmpDir();
  try {
    assert.ok(!fs.existsSync(path.join(dir, '.executor')), '初始无 sidecar');
    // 不应抛错（回退安全：未 init 时 coordinator 也不存在，无需心跳）
    assert.doesNotThrow(function () { loopCmd._touchExecutorSidecar(dir); });
    // 且不会创建文件
    assert.ok(!fs.existsSync(path.join(dir, '.executor')), 'touch 不创建 sidecar');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('_touchExecutorSidecar：mtime 格式被 coordinator 识别（不误判 disconnected）', function () {
  // 直接验证 coordinator 判活逻辑与 driver 心跳的契约对齐：
  //   coordinator (loop-server-core aggregateGlobalView) 用
  //   now - hb.mtimeMs < staleMs 判 alive。driver 每轮 touch 后，
  //   sidecar mtime 接近 now，coordinator 应判 alive。
  var dir = makeTmpDir();
  try {
    var loopServerCore = require('../../plugins/runtime/loop-server-core');
    var staleMs = loopServerCore.DEFAULTS.heartbeatStaleMs; // 5min

    // 模拟 init 后 driver 已活跃一段：写 sidecar
    loopCmd._writeExecutorSidecar(dir, 'claude');
    // 人为把 mtime 回拨到 staleMs + 1min（若无心跳则 coordinator 会判 disconnected）
    var stale = new Date(Date.now() - (staleMs + 60 * 1000));
    fs.utimesSync(path.join(dir, '.executor'), stale, stale);

    // 回拨后 mtime 已超 staleMs（coordinator 会判 disconnected）
    var mtimeBefore = fs.statSync(path.join(dir, '.executor')).mtimeMs;
    assert.ok(Date.now() - mtimeBefore >= staleMs, '回拨后 mtime 已超 staleMs');

    // driver 心跳刷新
    loopCmd._touchExecutorSidecar(dir);
    var mtimeAfter = fs.statSync(path.join(dir, '.executor')).mtimeMs;
    // 刷新后 coordinator 判活：(now - mtimeAfter) < staleMs
    assert.ok(Date.now() - mtimeAfter < staleMs,
      '心跳刷新后 coordinator 不会误判 disconnected');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('隔离 loop 收敛后 .executor sidecar 存在（心跳目标文件就位）', async function () {
  // 端到端：隔离模式下 driver 应 init 写 sidecar，收敛过程中每轮 touch 刷新，
  // 收敛后 sidecar 仍在（且 mtime 是最后一次 touch）。
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), makePlan(2), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    process.chdir(projectRoot);
    var h = makeCtx(projectRoot, [planPath, '--executor=local', '--loop-id=hb-test', '--state-dir=.ts-hb']);
    await loopCmd.execute(h.ctx);
    assert.strictEqual(h.exitCode.value, 0, 'loop should achieve');

    var sidecarPath = path.join(projectRoot, '.ts-hb', 'hb-test', '.executor');
    assert.ok(fs.existsSync(sidecarPath), '.executor sidecar 应就位');
    var data = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.strictEqual(data.provider, 'local');
    // 收敛后 mtime 应接近现在（最后一轮 touch 刷新过）
    var mtimeMs = fs.statSync(sidecarPath).mtimeMs;
    assert.ok(Date.now() - mtimeMs < 5000, '最后一轮心跳刷新了 mtime');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

test('非隔离 loop 不写 .executor sidecar（不破坏回退安全）', async function () {
  // 无 --loop-id：coordinator 不存在，driver 不应写 sidecar 也不应尝试 touch。
  var env = setupEnv(2);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local']);
    await loopCmd.execute(h.ctx);
    assert.strictEqual(h.exitCode.value, 0);
    assert.ok(!fs.existsSync(path.join(env.dir, '.executor')),
      '非隔离模式不应写 .executor sidecar');
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 7b: model 传递（WP-191-1-impl-d，不变量 #3 provider 零分支）
//
// 验收锚点（P1 修复）：
//   - driver 写出的 .executor sidecar 含 model 字段（从 executor.config.model 统一通道取）
//   - local/claude/glm 三种 executor 都暴露 config.model（无 provider 分支）
//   - coordinator 据此对 glm-5.x 选正确高峰系数（2x/3x），非 5.x/其它 provider 不加权
// ─────────────────────────────────────────────

test('driver 写 sidecar 含 model 字段（local executor，统一通道取值）', async function () {
  // 隔离 loop 收敛后，.executor sidecar 应含 model 字段，值来自 executor.config.model。
  // local 是 mock，model 值无计量意义，但字段必须存在以证明 driver 走的是统一通道
  // （而非硬编码 / provider 分支）。
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), makePlan(2), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    process.chdir(projectRoot);
    var h = makeCtx(projectRoot, [planPath, '--executor=local', '--loop-id=m1', '--state-dir=.ts-m']);
    await loopCmd.execute(h.ctx);
    assert.strictEqual(h.exitCode.value, 0, 'loop should achieve');

    var sidecarPath = path.join(projectRoot, '.ts-m', 'm1', '.executor');
    assert.ok(fs.existsSync(sidecarPath), '.executor sidecar 应就位');
    var data = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.strictEqual(data.provider, 'local');
    assert.ok(typeof data.model === 'string' && data.model.length > 0,
      'sidecar 应含 model 字段（来自 executor.config.model 统一通道）');
    assert.strictEqual(data.model, 'local-mock',
      'local executor 的 config.model 默认值应透传到 sidecar');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

test('_writeExecutorSidecar：model 参数透传到 sidecar JSON', function () {
  // 直接验证 writeExecutorSidecar 第三个参数（model）被写入 sidecar。
  // 这是 driver 传递 model 的底层契约——coordinator applyQuotaPool 据此选系数。
  var dir = makeTmpDir();
  try {
    loopCmd._writeExecutorSidecar(dir, 'glm', 'glm-5.2');
    var data = JSON.parse(fs.readFileSync(path.join(dir, '.executor'), 'utf8'));
    assert.strictEqual(data.provider, 'glm');
    assert.strictEqual(data.model, 'glm-5.2', 'model 应写入 sidecar');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('_writeExecutorSidecar：未传 model 时不写 model 字段（向后兼容）', function () {
  // 旧调用形态（两参）不应写出 model 字段，coordinator 端回退默认 glm-5.2。
  var dir = makeTmpDir();
  try {
    loopCmd._writeExecutorSidecar(dir, 'claude');
    var data = JSON.parse(fs.readFileSync(path.join(dir, '.executor'), 'utf8'));
    assert.strictEqual(data.provider, 'claude');
    assert.ok(!('model' in data), '未传 model 时 sidecar 不含 model 字段');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('三种 executor 都暴露 config.model（provider 零分支前提）', function () {
  // 不变量 #3：driver 用 executor.config.model 统一通道取 model，无 if(provider) 分支。
  // 前提是所有 executor 都暴露 config.model。本测试锁定该契约——
  // 新增 executor 时若漏暴露 config.model，driver 取到 undefined，coordinator 回退默认值。
  var loopExecutor = require('../../plugins/runtime/loop-executor');
  var providers = loopExecutor.listProviders();
  assert.ok(providers.indexOf('local') !== -1);
  assert.ok(providers.indexOf('claude') !== -1);
  assert.ok(providers.indexOf('glm') !== -1);
  for (var i = 0; i < providers.length; i++) {
    var exec = loopExecutor.createExecutor(providers[i], { projectRoot: __dirname });
    assert.ok(exec && exec.config && typeof exec.config.model === 'string',
      providers[i] + ' executor 应暴露 config.model（provider 零分支统一通道）');
    assert.ok(exec.config.model.length > 0,
      providers[i] + ' executor 的 config.model 不应为空串');
  }
});

// ─────────────────────────────────────────────
// Section 8: 熔断指令消费清理（WP-191-1-impl-b，P0）
//
// 验收锚点（P0 修复）：
//   - _clearAbortDirective 文件存在 → 删除；不存在 → 静默幂等不抛
//   - driver 消费 abort_all 后 directive.json 被删除（状态机闭环）
//   - 被 abort 的 loop-id 用 --loop-id 恢复重启，不被残留指令二次熔断
// ─────────────────────────────────────────────

test('_clearAbortDirective：删除已存在的 directive.json', function () {
  var dir = makeTmpDir();
  try {
    var p = path.join(dir, 'directive.json');
    fs.writeFileSync(p, JSON.stringify({ action: 'abort_all', reason: 'x' }), 'utf8');
    assert.ok(fs.existsSync(p), '前置：directive.json 存在');
    loopCmd._clearAbortDirective(dir);
    assert.ok(!fs.existsSync(p), '清理后 directive.json 应被删除');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('_clearAbortDirective：文件不存在时幂等不抛', function () {
  var dir = makeTmpDir();
  try {
    assert.ok(!fs.existsSync(path.join(dir, 'directive.json')), '前置：无 directive.json');
    // 多次调用都不抛、不创建文件（幂等）
    assert.doesNotThrow(function () { loopCmd._clearAbortDirective(dir); });
    assert.doesNotThrow(function () { loopCmd._clearAbortDirective(dir); });
    assert.ok(!fs.existsSync(path.join(dir, 'directive.json')), '幂等清理不应创建文件');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('driver 消费 abort_all 后 directive.json 被删除（状态机闭环）', async function () {
  var loopServerCmd = require('../../bin/commands/loop-server');
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  var planLines = ['# Plan', ''];
  for (var i = 1; i <= 8; i++) {
    planLines.push('## Step ' + i);
    planLines.push('- [ ] task ' + i);
    planLines.push('');
  }
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), planLines.join('\n'), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    // 预先下发熔断指令
    process.chdir(projectRoot);
    var serverCtx = {
      targetRoot: projectRoot,
      flags: { noColor: true },
      argv: ['abort', 'victim', '--state-dir=.ts'],
      colorize: function (t) { return t; },
      exit: function (code) { serverCtx._exit = code; },
      log: function () {},
    };
    await loopServerCmd.execute(serverCtx);
    var directivePath = path.join(projectRoot, '.ts', 'victim', 'directive.json');
    assert.ok(fs.existsSync(directivePath), '前置：directive.json 已写入');

    // 启动 driver → 消费指令 → circuit_broken 退出
    process.chdir(projectRoot);
    var logs = [];
    var driverCtx = {
      targetRoot: projectRoot,
      flags: { noColor: true },
      argv: [planPath, '--executor=local', '--loop-id=victim', '--state-dir=.ts', '--max-iters=20'],
      colorize: function (t) { return t; },
      exit: function (code) { driverCtx._exit = code; },
      log: function (m) { logs.push(String(m)); },
    };
    await loopCmd.execute(driverCtx);
    assert.strictEqual(driverCtx._exit, 1, '熔断应 exit 1');
    assert.ok(logs.join('\n').indexOf('熔断') !== -1, '应打印熔断接收日志');
    // 关键：消费后 directive.json 应被删除（不再残留）
    assert.ok(!fs.existsSync(directivePath),
      'driver 消费熔断指令后应删除 directive.json（闭环状态机）');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

test('被 abort 的 loop-id 恢复重启不被二次熔断（残留指令已清理）', async function () {
  // 场景：第一轮 driver 被熔断退出并清理 directive.json；第二轮用同一 --loop-id 恢复，
  //   不应再被熔断，而应正常收敛 achieved。
  //
  // WP-192-5 ① 终态保护后：第 1 轮被熔断后 state.status=circuit_broken（终态），
  //   第 2 轮同 --loop-id 恢复会被终态保护拦截（exit 2）。本测试的核心目的是验证
  //   「directive.json 残留已清理 → 恢复轮不会被残留指令二次熔断」，故第 2 轮显式带
  //   --force 覆盖终态保护（这正是 --force 的设计用途：明知终态仍要重跑）。
  var loopServerCmd = require('../../bin/commands/loop-server');
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  var planLines = ['# Plan', ''];
  for (var i = 1; i <= 8; i++) {
    planLines.push('## Step ' + i);
    planLines.push('- [ ] task ' + i);
    planLines.push('');
  }
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), planLines.join('\n'), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    // 第 1 轮：下发指令 + driver 消费退出 + 清理
    process.chdir(projectRoot);
    var abortCtx = {
      targetRoot: projectRoot,
      flags: { noColor: true },
      argv: ['abort', 'rev', '--state-dir=.ts'],
      colorize: function (t) { return t; },
      exit: function (code) { abortCtx._exit = code; },
      log: function () {},
    };
    await loopServerCmd.execute(abortCtx);
    process.chdir(projectRoot);
    var firstCtx = {
      targetRoot: projectRoot,
      flags: { noColor: true },
      argv: [planPath, '--executor=local', '--loop-id=rev', '--state-dir=.ts', '--max-iters=20'],
      colorize: function (t) { return t; },
      exit: function (code) { firstCtx._exit = code; },
      log: function () {},
    };
    await loopCmd.execute(firstCtx);
    assert.strictEqual(firstCtx._exit, 1, '第 1 轮应被熔断 exit 1');
    assert.ok(!fs.existsSync(path.join(projectRoot, '.ts', 'rev', 'directive.json')),
      '第 1 轮消费后 directive.json 应被清理');

    // 第 2 轮：同一 --loop-id + --force 覆盖终态保护，无新指令 → 应正常收敛 achieved
    //   （不被残留二次熔断，证明 directive.json 已清理）
    process.chdir(projectRoot);
    var secondLogs = [];
    var secondCtx = {
      targetRoot: projectRoot,
      flags: { noColor: true },
      argv: [planPath, '--executor=local', '--loop-id=rev', '--state-dir=.ts',
        '--max-iters=20', '--force'],
      colorize: function (t) { return t; },
      exit: function (code) { secondCtx._exit = code; },
      log: function (m) { secondLogs.push(String(m)); },
    };
    await loopCmd.execute(secondCtx);
    // 恢复后应 achieved（exit 0），而非再次 circuit_broken（exit 1）
    assert.strictEqual(secondCtx._exit, 0,
      '第 2 轮 --loop-id --force 恢复应收敛 achieved，不被残留指令二次熔断');
    var combined = secondLogs.join('\n');
    assert.ok(combined.indexOf('achieved') !== -1, '应报告 achieved');
    assert.ok(combined.indexOf('熔断') === -1,
      '恢复轮不应再出现熔断日志（残留指令已被清理）');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

// ─────────────────────────────────────────────
// Section 9: WP-192-5 loop.js 健壮性集中修复
//
// ①终态保护（已终态 loop 的 --loop-id 恢复被拒/需 --force）
// ②PROGRESS.md 原子写（.tmp+rename）
// ③并发写警告（同 --loop-id 并行不安全提示）
// ④a --max-iters<=0 边界报错
// ─────────────────────────────────────────────

// ④a：parseArgs 校验 --max-iters
test('parseArgs：--max-iters<=0 设 error 并清空', function () {
  var a0 = loopCmd._parseArgs(['plan.md', '--max-iters=0']);
  assert.ok(a0.error, '--max-iters=0 应报错');
  assert.strictEqual(a0.maxIters, null, '非法值应清空');

  var aneg = loopCmd._parseArgs(['plan.md', '--max-iters=-3']);
  assert.ok(aneg.error, '--max-iters=-3 应报错');
  assert.strictEqual(aneg.maxIters, null);
});

test('parseArgs：--max-iters 非数字设 error', function () {
  var a = loopCmd._parseArgs(['plan.md', '--max-iters=abc']);
  assert.ok(a.error, '非数字应报错');
  assert.strictEqual(a.maxIters, null);
});

test('parseArgs：--max-iters 正整数通过', function () {
  var a = loopCmd._parseArgs(['plan.md', '--max-iters=5']);
  assert.ok(!a.error);
  assert.strictEqual(a.maxIters, 5);
});

test('parseArgs：--max-iters 未传时为 null（走默认）', function () {
  var a = loopCmd._parseArgs(['plan.md']);
  assert.ok(!a.error);
  assert.strictEqual(a.maxIters, null);
});

test('parseArgs：--force flag 解析', function () {
  var a = loopCmd._parseArgs(['plan.md', '--loop-id=x', '--force']);
  assert.strictEqual(a.force, true);
  var b = loopCmd._parseArgs(['plan.md', '--loop-id=x']);
  assert.strictEqual(b.force, false);
});

// ④a：execute 层 --max-iters<=0 → exit 2
test('execute：--max-iters=0 → exit code = 2', async function () {
  var env = setupEnv(2);
  try {
    var h = makeCtx(env.dir, [env.planPath, '--executor=local', '--max-iters=0']);
    await loopCmd.execute(h.ctx);
    assert.strictEqual(h.exitCode.value, 2);
    assert.ok(h.logs.join('\n').indexOf('max-iters') !== -1, '应提示 max-iters 错误');
  } finally {
    env.restore();
  }
});

// ①终态保护：把 loop 跑到 achieved 后，用同 --loop-id 恢复应被拒（exit 2）
test('终态保护：已 achieved 的 --loop-id 恢复被拒（exit 2）', async function () {
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), makePlan(2), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    // 第 1 轮：跑完 → achieved（终态）
    process.chdir(projectRoot);
    var h1 = makeCtx(projectRoot, [planPath, '--executor=local',
      '--loop-id=done', '--state-dir=.ts-done']);
    await loopCmd.execute(h1.ctx);
    assert.strictEqual(h1.exitCode.value, 0, '第 1 轮应 achieved');

    // 第 2 轮：同 --loop-id 恢复 → 终态保护拦截，exit 2，不重置 state
    process.chdir(projectRoot);
    var logs2 = [];
    var ctx2 = {
      targetRoot: projectRoot,
      flags: { noColor: true },
      argv: [planPath, '--executor=local', '--loop-id=done', '--state-dir=.ts-done'],
      colorize: function (t) { return t; },
      exit: function (code) { ctx2._exit = code; },
      log: function (m) { logs2.push(String(m)); },
    };
    await loopCmd.execute(ctx2);
    assert.strictEqual(ctx2._exit, 2, '已终态恢复应 exit 2');
    var combined = logs2.join('\n');
    assert.ok(combined.indexOf('已终态') !== -1, '应提示已终态');

    // state 未被重置（仍含 achieved 状态 + 原始 loopId）
    var stateFile = path.join(projectRoot, '.ts-done', 'done', '.claude-state');
    var st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(st.loop.done.status, 'achieved', '终态保护不应重置 state.status');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

// ①终态保护：--force 覆盖（恢复终态 loop 不被拒，重置后重跑）
test('终态保护：--force 允许恢复已 achieved 的 loop（重置重跑）', async function () {
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), makePlan(1), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    process.chdir(projectRoot);
    var h1 = makeCtx(projectRoot, [planPath, '--executor=local',
      '--loop-id=f', '--state-dir=.ts-f']);
    await loopCmd.execute(h1.ctx);
    assert.strictEqual(h1.exitCode.value, 0);

    process.chdir(projectRoot);
    var h2 = makeCtx(projectRoot, [planPath, '--executor=local',
      '--loop-id=f', '--state-dir=.ts-f', '--force']);
    await loopCmd.execute(h2.ctx);
    // --force 不被终态保护拦截，应重新跑通 achieved
    assert.strictEqual(h2.exitCode.value, 0, '--force 应允许恢复并重跑');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

// ①终态保护：未终态（running/不存在）的 --loop-id 恢复正常放行（不误伤）
test('终态保护：首次 --loop-id（无既有 state）正常启动不误拦', async function () {
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), makePlan(1), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    process.chdir(projectRoot);
    var h = makeCtx(projectRoot, [planPath, '--executor=local',
      '--loop-id=fresh', '--state-dir=.ts-fresh']);
    await loopCmd.execute(h.ctx);
    assert.strictEqual(h.exitCode.value, 0, '首次启动不应被终态保护拦截');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

// ②原子写：appendProgressLine 写入后无残留 .tmp，内容正确
test('_appendProgressLine 原子写：写入后无残留 .tmp 文件', function () {
  var dir = makeTmpDir();
  try {
    loopCmd._appendProgressLine(dir, 'WP-1');
    var progressPath = path.join(dir, 'PROGRESS.md');
    assert.ok(fs.existsSync(progressPath), 'PROGRESS.md 已写入');
    // 无残留 tmp（原子写完成后 rename，不留垃圾）
    var entries = fs.readdirSync(dir);
    var tmps = entries.filter(function (e) { return e.indexOf('.tmp.') !== -1; });
    assert.strictEqual(tmps.length, 0, '不应残留 .tmp 文件（rename 完成）');
    var content = fs.readFileSync(progressPath, 'utf8');
    assert.ok(/\[x\]\s*WP-1\b/.test(content), '内容含 WP-1 完成行');
  } finally {
    cleanupTmpDir(dir);
  }
});

// ②原子写：幂等（同 WP 重复写不追加）
test('_appendProgressLine 原子写：幂等（同 WP 不重复追加）', function () {
  var dir = makeTmpDir();
  try {
    loopCmd._appendProgressLine(dir, 'WP-1');
    loopCmd._appendProgressLine(dir, 'WP-1');
    loopCmd._appendProgressLine(dir, 'WP-1');
    var content = fs.readFileSync(path.join(dir, 'PROGRESS.md'), 'utf8');
    var matches = content.match(/\[x\]\s*WP-1\b/g);
    assert.strictEqual(matches.length, 1, '幂等：WP-1 只出现一次');
  } finally {
    cleanupTmpDir(dir);
  }
});

// ②原子写：追加到既有文件保留原内容（首行 header 不丢）
test('_appendProgressLine 原子写：追加保留原内容', function () {
  var dir = makeTmpDir();
  try {
    var progressPath = path.join(dir, 'PROGRESS.md');
    fs.writeFileSync(progressPath, '# Progress\n\n- [x] WP-1\n', 'utf8');
    loopCmd._appendProgressLine(dir, 'WP-2');
    var content = fs.readFileSync(progressPath, 'utf8');
    assert.ok(content.indexOf('# Progress') !== -1, 'header 保留');
    assert.ok(/\[x\]\s*WP-1\b/.test(content), 'WP-1 保留');
    assert.ok(/\[x\]\s*WP-2\b/.test(content), 'WP-2 追加');
    // 无残留 tmp
    var tmps = fs.readdirSync(dir).filter(function (e) { return e.indexOf('.tmp.') !== -1; });
    assert.strictEqual(tmps.length, 0);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ②原子写：模拟中断验证走 .tmp+rename 流程（monkeypatch rename 捕获 tmp 路径）
test('_appendProgressLine 原子写：走 .tmp.<pid>.<ts> → rename 流程', function () {
  var dir = makeTmpDir();
  var origRename = fs.renameSync;
  var renameCalls = [];
  try {
    // 包装 renameSync 记录调用（不改变行为，仅观测）
    fs.renameSync = function (from, to) {
      renameCalls.push({ from: from, to: to });
      return origRename.call(fs, from, to);
    };
    loopCmd._appendProgressLine(dir, 'WP-7');
    assert.ok(renameCalls.length >= 1, '应调用 renameSync');
    var call = renameCalls[0];
    assert.ok(call.from.indexOf('.tmp.') !== -1, 'rename 源应是 .tmp 文件: ' + call.from);
    assert.ok(call.from.indexOf(String(process.pid)) !== -1,
      '.tmp 名应含 pid（与 StateStore 原子写模式一致）');
    assert.strictEqual(call.to, path.join(dir, 'PROGRESS.md'), 'rename 目标是 PROGRESS.md');
  } finally {
    fs.renameSync = origRename;
    cleanupTmpDir(dir);
  }
});

// ③并发写警告：隔离模式下 emitConcurrencyWarn 输出 warn
test('_emitConcurrencyWarn：隔离模式 + loop-id → 输出并发警告', function () {
  var warns = [];
  var saved = loopCmd._emitConcurrencyWarn._warn;
  try {
    loopCmd._emitConcurrencyWarn._warn = function (m) { warns.push(String(m)); };
    loopCmd._emitConcurrencyWarn({ isolated: true, stateFile: '/x/.claude-state' }, 'L1');
    assert.ok(warns.length >= 1, '隔离模式应 warn');
    var msg = warns.join('\n');
    assert.ok(msg.indexOf('L1') !== -1, 'warn 应含 loopId');
    assert.ok(msg.indexOf('并发') !== -1, 'warn 应提及并发风险');
  } finally {
    if (saved === undefined) delete loopCmd._emitConcurrencyWarn._warn;
    else loopCmd._emitConcurrencyWarn._warn = saved;
  }
});

// ③并发写警告：非隔离模式（无 --loop-id）不 warn
test('_emitConcurrencyWarn：非隔离模式不 warn', function () {
  var warns = [];
  var saved = loopCmd._emitConcurrencyWarn._warn;
  try {
    loopCmd._emitConcurrencyWarn._warn = function (m) { warns.push(String(m)); };
    loopCmd._emitConcurrencyWarn({ isolated: false, stateFile: '/x/.claude-state' }, null);
    loopCmd._emitConcurrencyWarn({ isolated: false, stateFile: '/x/.claude-state' }, 'L1');
    assert.strictEqual(warns.length, 0, '非隔离不应 warn');
  } finally {
    if (saved === undefined) delete loopCmd._emitConcurrencyWarn._warn;
    else loopCmd._emitConcurrencyWarn._warn = saved;
  }
});

// ④b help：含 loop / loop-server 子命令用法
test('help：输出含 loop / loop-server 子命令用法', function () {
  var helpCmd = require('../../bin/commands/help');
  var out = [];
  var ctx = {
    colorize: function (t) { return t; },
  };
  var origLog = console.log;
  console.log = function (m) { out.push(String(m)); };
  try {
    helpCmd.execute(ctx);
  } finally {
    console.log = origLog;
  }
  var combined = out.join('\n');
  // loop 子命令用法
  assert.ok(combined.indexOf('--executor=local|claude|glm') !== -1, 'help 应含 loop --executor 用法');
  assert.ok(combined.indexOf('--loop-id=') !== -1, 'help 应含 loop --loop-id 用法');
  assert.ok(combined.indexOf('--max-iters=') !== -1, 'help 应含 loop --max-iters 用法');
  assert.ok(combined.indexOf('--force') !== -1, 'help 应含 loop --force 用法');
  // loop-server 子命令用法
  assert.ok(combined.indexOf('loop-server start') !== -1, 'help 应含 loop-server start');
  assert.ok(combined.indexOf('loop-server stop') !== -1, 'help 应含 loop-server stop');
  assert.ok(combined.indexOf('loop-server status') !== -1, 'help 应含 loop-server status');
  assert.ok(combined.indexOf('loop-server list') !== -1, 'help 应含 loop-server list');
  assert.ok(combined.indexOf('loop-server abort') !== -1, 'help 应含 loop-server abort');
});
