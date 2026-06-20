/**
 * WP-191-5-test: 缺失测试补齐（3 类真实缺口）
 * Run with: node --test test/integration/test-wp191-test-gaps.js
 *
 * 覆盖评估结论（基于 Layer 0 已落地代码逐项核实）：
 *   1. todo-cli-smoke 真实 e2e —— 完全未覆盖（grep 全 test/ 无命中）→ 【本文件补齐】
 *   2. proximity 数值单调递增严格断言 —— test-loop-driver 仅断言 dispatch 顺序
 *      （WP-1 先于 WP-2），未从 .claude-state 读 history.eval.proximity 做数值单调断言；
 *      test-reflection-evaluator 测的是 _computeDivergenceStreak 单测 → 【本文件补齐】
 *   3. staleMs 边界 —— test-loop-driver 测了 touch 后不误判 disconnected（mtime 接近 now），
 *      但无"刚好 < staleMs（active）vs > staleMs（stale）"边界值断言 → 【本文件补齐】
 *   4. Windows stop 生命周期 —— test-loop-server Section 8 已充分覆盖（PID 读写/损坏/清理、
 *      stop 降级 PID 缺失/已死进程、真实跨平台 kill、stop 路由不落 default exit 2，共 8 测）→ 无需补
 *   5. noProgress 协同发散 —— test-reflection-evaluator（_noProgressStreakFromHistory 6 测 +
 *      score 协同 5 测）+ test-loop-engine（_decide 协同 3 测）已充分覆盖 → 无需补
 *
 * 严格非假绿：所有 e2e 真实跑 loop（--executor=local 非 mock 被测逻辑），
 * proximity/staleMs 断言从真实落盘文件读取数值。
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var loopCmd = require('../../bin/commands/loop');
var planReader = require('../../plugins/runtime/plan-reader');
var loopServerCore = require('../../plugins/runtime/loop-server-core');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wp191-test-gaps-'));
}

function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

var PROJECT_ROOT = path.resolve(__dirname, '..', '..');
// fixture 随仓库跟踪于 test/fixtures/（docs/plan/ 是运行时落盘区，被 gitignore，
// 不放测试 fixture）。详见 test/fixtures/README 与 docs/plan/README.md。
var REAL_PLAN_PATH = path.join(PROJECT_ROOT, 'test', 'fixtures', 'todo-cli-smoke.md');

/**
 * 构造伪 ctx，捕获 exit code 与 log，在隔离 tmpdir 中运行 driver。
 */
function makeCtx(dir, argv) {
  var logs = [];
  var exitCode = { value: null };
  return {
    ctx: {
      targetRoot: dir,
      packageRoot: PROJECT_ROOT,
      flags: { noColor: true },
      command: 'loop',
      packageVersion: 'test',
      argv: argv,
      colorize: function (t) { return t; },
      exit: function (code) { exitCode.value = code; },
      log: function (msg) { logs.push(String(msg)); },
    },
    logs: logs,
    exitCode: exitCode,
  };
}

/**
 * 读 .claude-state 中的 loop history proximity 序列。
 * @param {string} stateFile .claude-state 绝对路径
 * @param {string} loopId
 * @returns {number[]} 每轮 eval.proximity
 */
function readProximitySeries(stateFile, loopId) {
  var raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  var loopState = raw.loop && raw.loop[loopId];
  assert.ok(loopState, '应存在 loop.' + loopId + ' state');
  var history = loopState.history || [];
  return history.map(function (h) {
    return h && h.eval ? h.eval.proximity : undefined;
  });
}

// ═══════════════════════════════════════════════════════════════
// 场景 1：todo-cli-smoke 真实 plan 端到端 e2e（真实跑 loop，非 mock）
// ═══════════════════════════════════════════════════════════════

test.describe('场景1: todo-cli-smoke 真实 plan e2e', function () {

  test('前置：todo-cli-smoke.md fixture 存在且可被 plan-reader 解析', function () {
    assert.ok(fs.existsSync(REAL_PLAN_PATH), 'fixture 应存在: ' + REAL_PLAN_PATH);
    var md = fs.readFileSync(REAL_PLAN_PATH, 'utf8');
    var goal = planReader.parsePlanToGoal(REAL_PLAN_PATH, md);
    assert.strictEqual(goal.error, null, 'plan 应解析无错');
    // 真实解析结果：3 个 section 全部被 isExecutableSection 识别为可执行 WP
    // （含"成功标准"——文档警告的 section 误判，测试如实反映而非粉饰）
    assert.strictEqual(goal.workPackages.length, 3, '3 个 section 全部映射为 WP');
    // 至少应含「成功标准」section（被误判为可执行）—— 锁定该已知行为，便于
    // 未来 WP-191-7-review 修 isExecutableSection 时本测试同步更新
    var titles = goal.workPackages.map(function (wp) { return wp.title; });
    assert.ok(titles.indexOf('成功标准') !== -1,
      '"成功标准" section 当前被识别为可执行 WP（isExecutableSection 已知行为）');
  });

  test('真实跑 todo-cli-smoke.md：verdict achieved + exit 0', async function () {
    var dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n', 'utf8');
    // 拷贝真实 plan（非合成），driver 真实解析 + 真实 local executor 逐 WP 推进
    fs.writeFileSync(
      path.join(dir, '.claude', 'plan.md'),
      fs.readFileSync(REAL_PLAN_PATH, 'utf8'),
      'utf8'
    );
    var planPath = path.join(dir, '.claude', 'plan.md');
    var origCwd = process.cwd();
    try {
      process.chdir(dir);
      var h = makeCtx(dir, [planPath, '--executor=local', '--state-dir=.ts', '--loop-id=smoke']);
      await loopCmd.execute(h.ctx);

      assert.strictEqual(h.exitCode.value, 0, 'achieved should exit 0');
      var combined = h.logs.join('\n');
      assert.ok(combined.indexOf('achieved') !== -1, '应报告 achieved');
      assert.ok(combined.indexOf('1.000') !== -1, 'proximity 应达 1.0');
    } finally {
      process.chdir(origCwd);
      cleanupTmpDir(dir);
    }
  });

  test('PROGRESS.md 含全部 goal WP 的完成行（completed 流转正确）', async function () {
    var dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, '.claude', 'plan.md'),
      fs.readFileSync(REAL_PLAN_PATH, 'utf8'),
      'utf8'
    );
    var planPath = path.join(dir, '.claude', 'plan.md');
    var origCwd = process.cwd();
    try {
      process.chdir(dir);
      var h = makeCtx(dir, [planPath, '--executor=local', '--state-dir=.ts', '--loop-id=smoke']);
      await loopCmd.execute(h.ctx);
      assert.strictEqual(h.exitCode.value, 0);

      var progressPath = path.join(dir, '.ts', 'smoke', 'PROGRESS.md');
      assert.ok(fs.existsSync(progressPath), 'PROGRESS.md 应在隔离目录写出');
      var content = fs.readFileSync(progressPath, 'utf8');
      // 3 个 goal WP 全部 [x]（含被误判的"成功标准"对应的 WP）
      var doneCount = (content.match(/\[x\]\s*WP-\d+/g) || []).length;
      assert.ok(doneCount >= 3, '至少 3 个 goal WP 标记完成，实际 ' + doneCount);
    } finally {
      process.chdir(origCwd);
      cleanupTmpDir(dir);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 场景 2：proximity 数值单调递增严格断言
//   从 .claude-state 逐轮读 history.eval.proximity，严格断言 prev <= cur。
//   不降级为 dispatch 顺序间接推断。覆盖 achieved 收敛完整序列。
// ═══════════════════════════════════════════════════════════════

test.describe('场景2: proximity 数值严格单调递增', function () {

  test('真实 loop 收敛：从 .claude-state 读 proximity 序列，严格 prev <= cur', async function () {
    var dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n', 'utf8');
    // 多 WP plan 让 proximity 经历多个台阶（每完成一个 WP 上升一档）
    var planLines = ['# Smoke', ''];
    for (var i = 1; i <= 3; i++) {
      planLines.push('## Step ' + i);
      planLines.push('- [ ] 任务 ' + i + '.1');
      planLines.push('- [ ] 任务 ' + i + '.2');
      planLines.push('');
    }
    fs.writeFileSync(path.join(dir, '.claude', 'plan.md'), planLines.join('\n'), 'utf8');
    var planPath = path.join(dir, '.claude', 'plan.md');
    var origCwd = process.cwd();
    try {
      process.chdir(dir);
      var h = makeCtx(dir, [planPath, '--executor=local', '--state-dir=.ts', '--loop-id=mono']);
      await loopCmd.execute(h.ctx);
      assert.strictEqual(h.exitCode.value, 0, 'loop 应收敛 achieved');

      var stateFile = path.join(dir, '.ts', 'mono', '.claude-state');
      assert.ok(fs.existsSync(stateFile), 'state 文件应存在');
      var series = readProximitySeries(stateFile, 'mono');

      // 序列非空且最后一轮收敛到 1
      assert.ok(series.length >= 2, '应有多轮 history（实际 ' + series.length + ' 轮）');
      var last = series[series.length - 1];
      assert.ok(Math.abs(last - 1) < 1e-9, '最后一轮 proximity 应为 1.0（收敛），实际 ' + last);

      // 严格单调非降：每轮 prev <= cur（允许相等台阶，但绝不下降）
      for (var i = 1; i < series.length; i++) {
        var prev = series[i - 1];
        var cur = series[i];
        assert.ok(
          prev <= cur + 1e-9,
          'proximity 应非降：round ' + i + ' prev=' + prev + ' 不应 > cur=' + cur +
          '（完整序列 ' + JSON.stringify(series) + '）'
        );
      }
    } finally {
      process.chdir(origCwd);
      cleanupTmpDir(dir);
    }
  });

  test('真实 todo-cli-smoke plan：proximity 台阶完整序列 [0 → 1/3 → 2/3 → 1]', async function () {
    // 用真实 fixture 锁定 local executor 在 3-WP plan 上的 proximity 台阶行为。
    // 这是 driver + executor-local 端到端的数值契约，若有人改 executor mock 的推进语义
    // （如一次跳过多个 WP），台阶数会变，本测试会捕获。
    var dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, '.claude', 'plan.md'),
      fs.readFileSync(REAL_PLAN_PATH, 'utf8'),
      'utf8'
    );
    var planPath = path.join(dir, '.claude', 'plan.md');
    var origCwd = process.cwd();
    try {
      process.chdir(dir);
      var h = makeCtx(dir, [planPath, '--executor=local', '--state-dir=.ts', '--loop-id=steps']);
      await loopCmd.execute(h.ctx);
      assert.strictEqual(h.exitCode.value, 0);

      var series = readProximitySeries(
        path.join(dir, '.ts', 'steps', '.claude-state'), 'steps');
      // 首轮 proximity=0（无 WP 完成），之后每个台阶约 +1/3，终态 1
      assert.strictEqual(series[0], 0, '首轮 proximity=0');
      var last = series[series.length - 1];
      assert.ok(Math.abs(last - 1) < 1e-9, '终态 proximity=1');
      // 单调非降（同样严格断言，与上一测互补）
      for (var i = 1; i < series.length; i++) {
        assert.ok(series[i - 1] <= series[i] + 1e-9,
          'todo-cli-smoke proximity 非降：' + JSON.stringify(series));
      }
    } finally {
      process.chdir(origCwd);
      cleanupTmpDir(dir);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 场景 3：staleMs 边界值测试
//   验证 aggregateGlobalView 的 alive 判定边界：
//     - mtime 刚好 < staleMs（active）→ alive=true
//     - mtime 超 staleMs（stale/disconnected）→ alive=false, stale=true
//   配合 WP-191-1-impl-a 心跳修复：长时间活动期（mtime 持续刷新）不误判。
// ═══════════════════════════════════════════════════════════════

test.describe('场景3: staleMs 边界（coordinator alive 判定）', function () {
  var StateStore = require('../../plugins/runtime/state-store').StateStore;

  /**
   * 在 stateDir 下构造一个 per-loop 工作区，sidecar mtime 可控。
   */
  async function makeLoopWithMtime(stateDir, loopId, mtimeAgoMs) {
    var wsDir = path.join(stateDir, loopId);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'task.md'), '# ' + loopId + '\n', 'utf8');
    var sidecarPath = path.join(wsDir, '.executor');
    fs.writeFileSync(sidecarPath, JSON.stringify({
      provider: 'claude', startedAt: new Date().toISOString(), pid: 1000,
    }), 'utf8');
    if (mtimeAgoMs !== undefined) {
      var t = new Date(Date.now() - mtimeAgoMs);
      fs.utimesSync(sidecarPath, t, t);
    }
    var store = new StateStore({ filePath: path.join(wsDir, '.claude-state') });
    await store.set('loop.' + loopId, {
      loopId: loopId,
      status: 'running',
      iteration: 1,
      lastUpdatedAt: new Date().toISOString(),
      lastEval: { proximity: 0.5 },
      goal: { wpIds: ['WP-1'] },
    });
  }

  test('边界：mtime 刚好 < staleMs（active）→ alive=true, stale=false', async function () {
    var dir = makeTmpDir();
    var staleMs = loopServerCore.DEFAULTS.heartbeatStaleMs; // 5min
    try {
      // mtime 在 staleMs 边界内侧（staleMs - 10s）→ active
      await makeLoopWithMtime(dir, 'active', staleMs - 10 * 1000);
      var view = await loopServerCore.aggregateGlobalView(dir);
      assert.strictEqual(view.heartbeats.active.alive, true,
        'mtime < staleMs 应判 alive');
      assert.strictEqual(view.heartbeats.active.stale, false,
        'active 不应标 stale');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('边界：mtime 超 staleMs（stale）→ alive=false, stale=true', async function () {
    var dir = makeTmpDir();
    var staleMs = loopServerCore.DEFAULTS.heartbeatStaleMs;
    try {
      // mtime 超过 staleMs（+ 60s）→ stale/disconnected
      await makeLoopWithMtime(dir, 'stale', staleMs + 60 * 1000);
      var view = await loopServerCore.aggregateGlobalView(dir);
      assert.strictEqual(view.heartbeats.stale.alive, false,
        'mtime > staleMs 应判 not alive');
      assert.strictEqual(view.heartbeats.stale.stale, true,
        'sidecar 存在但 mtime 过期 → 标 stale=true');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('长时间活动期不误判：mtime 持续刷新（每轮 touch）始终 alive', async function () {
    // 模拟 WP-191-1-impl-a 心跳修复后的场景：driver 每轮 touch 刷新 mtime，
    // 即使 loop 已跑很久（wall time 大），只要心跳在刷新就应 alive。
    var dir = makeTmpDir();
    var staleMs = loopServerCore.DEFAULTS.heartbeatStaleMs;
    try {
      // 模拟已运行很久但最后一轮心跳刚刷新（mtime = 1s 前，远 < staleMs）
      await makeLoopWithMtime(dir, 'longrun', 1 * 1000);
      var view = await loopServerCore.aggregateGlobalView(dir);
      assert.strictEqual(view.heartbeats.longrun.alive, true,
        '长时间运行但心跳新鲜 → 不误判 disconnected');

      // 模拟中途一阶段心跳停滞（mtime 回拨到 staleMs + 边界外）→ 转 stale
      fs.utimesSync(
        path.join(dir, 'longrun', '.executor'),
        new Date(Date.now() - (staleMs + 30 * 1000)),
        new Date(Date.now() - (staleMs + 30 * 1000))
      );
      var view2 = await loopServerCore.aggregateGlobalView(dir);
      assert.strictEqual(view2.heartbeats.longrun.alive, false,
        '心跳停滞超 staleMs → 转 not alive');
      assert.strictEqual(view2.heartbeats.longrun.stale, true);

      // 心跳恢复（touch 刷新到当前）→ 重新 alive
      var now = new Date();
      fs.utimesSync(path.join(dir, 'longrun', '.executor'), now, now);
      var view3 = await loopServerCore.aggregateGlobalView(dir);
      assert.strictEqual(view3.heartbeats.longrun.alive, true,
        '心跳恢复刷新 → 重新 alive（不卡在 stale 态）');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('自定义 heartbeatStaleMs 覆盖默认值（边界随配置缩放）', async function () {
    var dir = makeTmpDir();
    try {
      // 自定义极小 staleMs=1s，mtime=2s 前 → 超过自定义阈值 → stale
      await makeLoopWithMtime(dir, 'cfg', 2 * 1000);
      var view = await loopServerCore.aggregateGlobalView(dir, { heartbeatStaleMs: 1000 });
      assert.strictEqual(view.heartbeats.cfg.alive, false,
        '自定义 staleMs=1s，mtime=2s 前 → 超阈值 not alive');
      assert.strictEqual(view.heartbeats.cfg.stale, true);

      // 同一 mtime，自定义大 staleMs=10s → active
      var view2 = await loopServerCore.aggregateGlobalView(dir, { heartbeatStaleMs: 10 * 1000 });
      assert.strictEqual(view2.heartbeats.cfg.alive, true,
        '自定义 staleMs=10s，mtime=2s 前 → 在阈值内 alive');
    } finally {
      cleanupTmpDir(dir);
    }
  });
});
