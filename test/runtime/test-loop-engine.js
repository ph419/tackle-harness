/**
 * Unit tests for provider-loop-engine (WP-174-2 / WP-174-6)
 * Run with: node --test test/runtime/test-loop-engine.js
 *
 * 覆盖：
 *   - 五阶段状态机（observe/think/act/reflect/decide）状态流转
 *   - step 单步编排（iteration 单调递增）
 *   - applyDirective（pause/abort/abort_all）
 *   - inject 注入路径（注入走 delegate，未注入走 fallback）
 *   - _decide 终止判定优先级（熔断 > 发散 > 上限 > 达成 > 继续）
 *   - 持久化恢复（模拟上下文压缩：新 store 读回断点）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var LoopEngineProvider = require('../../plugins/core/provider-loop-engine');
var { StateStore } = require('../../plugins/runtime/state-store');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loop-engine-test-'));
}

function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }
}

/**
 * 构造一个指向临时目录的 engine 实例 + API。
 * 临时目录含 .claude 标记，使 _resolveProjectRoot 命中。
 */
async function makeEngine(opts) {
  opts = opts || {};
  var dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

  var provider = new LoopEngineProvider();

  // 临时改 cwd 让 _resolveProjectRoot / state-store 命中临时目录
  var origCwd = process.cwd();
  process.chdir(dir);

  var context = {
    config: opts.contextConfig || null,
    getProvider: opts.getProvider || function () { return null; },
  };
  await provider.onActivate(context);
  var api = await provider.factory(context);

  return {
    dir: dir,
    provider: provider,
    api: api,
    origCwd: origCwd,
    restore: function () { process.chdir(origCwd); cleanupTmpDir(dir); },
  };
}

// ─────────────────────────────────────────────
// Section 1: init / createLoopState
// ─────────────────────────────────────────────

test.describe('init', function () {
  test('新建 loop：restored=false，state 字段齐全', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({ teamName: 'team-x', goal: { wpIds: ['WP-1'] } });
      assert.strictEqual(res.restored, false);
      assert.ok(res.loopId.indexOf('loop-') === 0, 'loopId 前缀');
      assert.strictEqual(res.state.status, 'running');
      assert.strictEqual(res.state.iteration, 0);
      assert.strictEqual(res.state.phase, 'init');
      assert.ok(Array.isArray(res.state.history));
      assert.strictEqual(res.state.history.length, 0);
      assert.strictEqual(res.state.teamName, 'team-x');
      assert.deepStrictEqual(res.state.goal.wpIds, ['WP-1']);
    } finally {
      env.restore();
    }
  });

  test('同 loopId 二次 init：status=running 时 restored=true，iteration 不回退', async function () {
    var env = await makeEngine();
    try {
      var res1 = await env.api.init({ teamName: 't' });
      // 模拟已推进若干轮（写回 state-store）
      var st = await env.api.getState(res1.loopId);
      st.iteration = 5;
      st.phase = 'reflect';
      st.history.push({ iteration: 5, verdict: 'continue', proximity: 0.4 });
      st.status = 'running';
      // 直接通过 state-store 持久化（绕过 API 内部，模拟上下文压缩前的落盘）
      await env.provider._store.set('loop.' + res1.loopId, st);

      // 模拟"上下文压缩后重新 init"：用新 store 句柄读回（验证落盘可读）
      var newStore = new StateStore({
        filePath: path.join(env.dir, '.claude-state'),
      });
      var persisted = await newStore.get('loop.' + res1.loopId);
      assert.strictEqual(persisted.iteration, 5, 'iteration 落盘完整');
      assert.strictEqual(persisted.history.length, 1, 'history 落盘完整');

      // 二次 init 同 loopId
      var res2 = await env.api.init({ loopId: res1.loopId });
      assert.strictEqual(res2.restored, true, '应识别为恢复');
      assert.strictEqual(res2.state.iteration, 5, '恢复后 iteration 不回退');
      assert.strictEqual(res2.state.phase, 'reflect', '恢复后 phase 一致');
      assert.strictEqual(res2.state.history.length, 1, '恢复后 history 完整');
    } finally {
      env.restore();
    }
  });

  test('已终止 loop 二次 init：restored=false（重新开始）', async function () {
    var env = await makeEngine();
    try {
      var res1 = await env.api.init({ teamName: 't' });
      var st = await env.api.getState(res1.loopId);
      st.status = 'achieved';
      await env.provider._store.set('loop.' + res1.loopId, st);

      var res2 = await env.api.init({ loopId: res1.loopId });
      assert.strictEqual(res2.restored, false, '非 running 不恢复');
      assert.strictEqual(res2.state.status, 'running', '重新创建为 running');
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 2: observe / think / act / reflect 单阶段
// ─────────────────────────────────────────────

test.describe('observe', function () {
  test('未注入 snapshot delegate 时走 fallback 快照', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({ goal: { wpIds: ['WP-1', 'WP-2'] } });
      var snap = await env.api.observe(res.loopId);
      assert.strictEqual(snap._fallback, true);
      assert.deepStrictEqual(snap.workPackages.pending, ['WP-1', 'WP-2']);
      assert.strictEqual(snap.workPackages.total, 2);
      assert.strictEqual(snap.watchdog.health, 'healthy');

      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.phase, 'observe');
      assert.strictEqual(st.lastSnapshot.workPackages.total, 2);
    } finally {
      env.restore();
    }
  });

  test('注入 snapshot delegate 时走注入路径（无 _fallback 标志）', async function () {
    var env = await makeEngine();
    try {
      var called = false;
      env.api.inject({
        snapshot: {
          aggregate: async function (_ctx, loopId) {
            called = true;
            return {
              loopId: loopId,
              workPackages: { total: 1, pending: ['WP-9'], completed: [], failed: [], blocked: [] },
              lastChecklist: null,
              watchdog: { deployed: true, running: true, health: 'healthy' },
              gitDiff: { changedFiles: 0, insertions: 0, deletions: 0, filesByWp: {} },
              signals: { pendingDirectives: [] },
            };
          },
        },
      });
      var res = await env.api.init({});
      var snap = await env.api.observe(res.loopId);
      assert.strictEqual(called, true, 'delegate 被调用');
      assert.strictEqual(snap._fallback, undefined, '注入路径不应有 _fallback');
      assert.deepStrictEqual(snap.workPackages.pending, ['WP-9']);
    } finally {
      env.restore();
    }
  });

  test('未知 loopId 抛错', async function () {
    var env = await makeEngine();
    try {
      await assert.rejects(function () { return env.api.observe('loop-nonexistent'); }, /unknown loopId/);
    } finally {
      env.restore();
    }
  });
});

test.describe('think', function () {
  test('无快照 → noop', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var decision = await env.api.think(res.loopId, null);
      assert.strictEqual(decision.action, 'noop');
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.phase, 'think');
    } finally {
      env.restore();
    }
  });

  test('failed 非空 → retry（refine 重试优先）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var snap = {
        workPackages: { total: 2, pending: [], completed: [], failed: ['WP-5'], blocked: [] },
        lastChecklist: null,
      };
      var decision = await env.api.think(res.loopId, snap);
      assert.strictEqual(decision.action, 'retry');
      assert.strictEqual(decision.targetWp, 'WP-5');
    } finally {
      env.restore();
    }
  });

  test('pending 在 goal 范围内 → dispatch', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({ goal: { wpIds: ['WP-1', 'WP-2'] } });
      var snap = {
        workPackages: { total: 2, pending: ['WP-1', 'WP-2'], completed: [], failed: [], blocked: [] },
        lastChecklist: null,
      };
      var decision = await env.api.think(res.loopId, snap);
      assert.strictEqual(decision.action, 'dispatch');
      assert.strictEqual(decision.targetWp, 'WP-1');
    } finally {
      env.restore();
    }
  });

  test('pending 不在 goal 范围 → noop（不越界 P0）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] } });
      var snap = {
        workPackages: { total: 3, pending: ['WP-X', 'WP-Y'], completed: [], failed: [], blocked: [] },
        lastChecklist: null,
      };
      var decision = await env.api.think(res.loopId, snap);
      assert.strictEqual(decision.action, 'noop');
      assert.ok(/不越界|不在 goal/.test(decision.reason));
    } finally {
      env.restore();
    }
  });

  test('lastChecklist 失败且无 failed 项 → resplit', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var snap = {
        workPackages: { total: 1, pending: [], completed: [], failed: [], blocked: [] },
        lastChecklist: { wpId: 'WP-7', passed: false },
      };
      var decision = await env.api.think(res.loopId, snap);
      assert.strictEqual(decision.action, 'resplit');
      assert.strictEqual(decision.targetWp, 'WP-7');
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 2b: retry 真实数据流命中（WP-176-3 / 修复偏差1 + engine/运行时落差）
//   关键对齐主线：retry 测试用真实数据流（loop-snapshot.buildWorkPackages
//   从真实 lastChecklist.failedItems 填充 failed → engine._think 消费），
//   非手动构造 failed:['WP-5']（上方 :218 旧式单测直构保留作对照）。
//   覆盖：Reflect 回填 failingDrivers/failed；retry decision 携带 failingDrivers；
//   retry/resplit 优先级；_decide noFailed 真实生效。
// ─────────────────────────────────────────────

test.describe('retry 真实数据流 (WP-176-3)', function () {
  // 真实数据流构造助手：从真实 lastChecklist 出发，经 loop-snapshot 填充 failed
  function buildRealSnapshot(state, progress, checklist) {
    var loopSnapshot = require('../../plugins/runtime/loop-snapshot');
    return {
      workPackages: loopSnapshot._buildWorkPackages(state, progress, checklist),
      lastChecklist: checklist,
    };
  }

  test('真实 failedItems snapshot → _think 走 retry（非 resplit）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({ goal: { wpIds: ['WP-5', 'WP-6'] } });
      var state = { goal: { wpIds: ['WP-5', 'WP-6'] } };
      var progress = { completed: [], incomplete: ['WP-5', 'WP-6'] };
      // 真实 checklist：含 failedItems（wpId 取顶层 WP-5）
      var chk = {
        wpId: 'WP-5', passed: false,
        summary: { total: 2, passed: 0, failed: 2 },
        failedItems: [
          { category: '测试', id: 't1', reason: '缺边界' },
          { category: '文档', id: 'd1', reason: '无注释' },
        ],
      };
      var snap = buildRealSnapshot(state, progress, chk);
      // 断言真实数据流确实填充了 failed（非手工构造）
      assert.deepStrictEqual(snap.workPackages.failed, ['WP-5'], 'snapshot 经真实填充含 failed');

      var decision = await env.api.think(res.loopId, snap);
      assert.strictEqual(decision.action, 'retry', '真实 failed → retry，非 resplit');
      assert.strictEqual(decision.targetWp, 'WP-5');
      assert.strictEqual(decision.strategy, 'full_restart');
    } finally {
      env.restore();
    }
  });

  test('retry decision 携带 Reflect 回填的 failingDrivers（真实 refine 反馈）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({ goal: { wpIds: ['WP-5'] } });
      var realDrivers = [
        { wpId: 'WP-5', category: '测试', item: 't1', reason: '缺边界' },
      ];
      // 模拟 Reflect 回填：把 failingDrivers 写入 state（engine.reflect 真实路径会这么做）
      var st = await env.api.getState(res.loopId);
      st.failingDrivers = realDrivers;
      await env.provider._store.set('loop.' + res.loopId, st);

      var chk = {
        wpId: 'WP-5', passed: false,
        summary: { total: 1, passed: 0, failed: 1 },
        failedItems: [{ category: '测试', id: 't1', reason: '缺边界' }],
      };
      var snap = buildRealSnapshot(
        { goal: { wpIds: ['WP-5'] } },
        { completed: [], incomplete: ['WP-5'] },
        chk
      );
      var decision = await env.api.think(res.loopId, snap);
      assert.strictEqual(decision.action, 'retry');
      assert.deepStrictEqual(decision.failingDrivers, realDrivers,
        'retry decision 携带 state.failingDrivers（refine 反馈明细）');
    } finally {
      env.restore();
    }
  });

  test('retry 优先于 resplit：failed 非空 且 lastChecklist.passed=false → retry', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({ goal: { wpIds: ['WP-5'] } });
      var chk = {
        wpId: 'WP-5', passed: false,
        summary: { total: 1, passed: 0, failed: 1 },
        failedItems: [{ category: '测试', id: 't1', reason: 'r' }],
      };
      var snap = buildRealSnapshot(
        { goal: { wpIds: ['WP-5'] } },
        { completed: [], incomplete: ['WP-5'] },
        chk
      );
      // failed 非空 + passed=false 同时满足 → 应走 retry（优先级高于 resplit）
      var decision = await env.api.think(res.loopId, snap);
      assert.strictEqual(decision.action, 'retry');
    } finally {
      env.restore();
    }
  });

  test('failed 空但 lastChecklist.passed=false → resplit（无显式失败项）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      // passed=false 但 failedItems 空 → snapshot.failed 空 → 走 resplit
      var chk = { wpId: 'WP-7', passed: false, summary: { total: 1, passed: 0, failed: 1 }, failedItems: [] };
      var snap = buildRealSnapshot({ goal: { wpIds: ['WP-7'] } }, { completed: [], incomplete: ['WP-7'] }, chk);
      assert.deepStrictEqual(snap.workPackages.failed, [], '真实填充：failedItems 空 → failed 空');
      var decision = await env.api.think(res.loopId, snap);
      assert.strictEqual(decision.action, 'resplit');
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 3b: Reflect 回填 + Decide noFailed 真实生效（WP-176-3）
// ─────────────────────────────────────────────

test.describe('Reflect 回填 & Decide noFailed (WP-176-3)', function () {
  test('reflect 后 state.failingDrivers 同步 EvalResult.failingDrivers', async function () {
    var env = await makeEngine();
    try {
      var drivers = [
        { wpId: 'WP-5', category: '测试', item: 't1', reason: '缺' },
        { wpId: 'WP-5', category: '文档', item: 'd1', reason: '无' },
      ];
      env.api.inject({
        evaluator: {
          score: async function () {
            return {
              proximity: 0.5, converged: false, diverged: false, divergenceStreak: 1,
              allPassed: false, failingDrivers: drivers,
            };
          },
        },
      });
      var res = await env.api.init({});
      await env.api.reflect(res.loopId, {});
      var st = await env.api.getState(res.loopId);
      assert.deepStrictEqual(st.failingDrivers, drivers, 'reflect 回填 failingDrivers 到 state');
      assert.strictEqual(st.divergenceStreak, 1, 'reflect 回填 divergenceStreak');
      assert.deepStrictEqual(st.lastEval.failingDrivers, drivers, 'lastEval.failingDrivers 同步');
    } finally {
      env.restore();
    }
  });

  test('reflect 回退路径（无 evaluator）也回填 failingDrivers（fallbackEval 产出）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      // fallbackEval 从 snapshot.lastChecklist 派生 failingDrivers
      var chk = {
        wpId: 'WP-5', passed: false,
        summary: { total: 2, passed: 1, failed: 1 },
        failedItems: [{ category: '测试', id: 't1', reason: '缺' }],
      };
      await env.api.reflect(res.loopId, { lastChecklist: chk });
      var st = await env.api.getState(res.loopId);
      assert.ok(Array.isArray(st.failingDrivers), 'fallback 路径也回填 failingDrivers');
      assert.strictEqual(st.failingDrivers.length, 1, '从 failedItems 派生 1 个失败驱动');
      assert.strictEqual(st.failingDrivers[0].wpId, 'WP-5');
    } finally {
      env.restore();
    }
  });

  test('_decide：有 failingDrivers（无 failed WP）时不误判 achieved', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      // 无 pending/failed WP，proximity 达标，但 evalResult.failingDrivers 非空 → noFailed=false
      st.lastSnapshot = {
        workPackages: { total: 1, pending: [], completed: ['WP-1'], failed: [], blocked: [] },
      };
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, {
        divergenceStreak: 0, proximity: 0.95, allPassed: true,
        failingDrivers: [{ wpId: 'WP-1', category: '测试', item: 't1', reason: 'r' }],
      });
      assert.notStrictEqual(verdict.verdict, 'achieved', '有 failingDrivers → 不判 achieved');
      assert.strictEqual(verdict.verdict, 'continue');
    } finally {
      env.restore();
    }
  });

  test('_decide：snapshot.failed 非空时 noFailed=false（WP-176-2 填充联动）', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      // 真实填充的 failed WP 非空 → 即使 allPassed+proximity 满分也不达成
      st.lastSnapshot = {
        workPackages: { total: 2, pending: [], completed: ['WP-1'], failed: ['WP-2'], blocked: [] },
      };
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, {
        divergenceStreak: 0, proximity: 1, allPassed: true, failingDrivers: [],
      });
      assert.notStrictEqual(verdict.verdict, 'achieved', '有 failed WP → 不判 achieved');
    } finally {
      env.restore();
    }
  });
});

test.describe('act', function () {
  test('自动注入 loop-actuator：act() 不返回 placeholder，dispatch decision 产出指令', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] } });
      var out = await env.api.act(res.loopId, { action: 'dispatch', targetWp: 'WP-1' });
      // WP-177-2-impl-b：默认自动注入 loop-actuator，act() 不再返回 placeholder:true
      assert.strictEqual(out.placeholder, undefined, '自动注入后不再有 placeholder 标志');
      assert.strictEqual(out.dispatched, true, 'dispatch decision 经 actuator 序列化为指令');
      // loop-actuator 把 decision 写入 state-store 子 key loop.{loopId}.pendingAction
      var pending = await env.provider._store.get('loop.' + res.loopId + '.pendingAction');
      assert.ok(pending, 'loop-actuator 产出 pendingAction 写入 state-store 子 key');
      assert.strictEqual(pending.mode, 'dispatch');
      assert.strictEqual(pending.wpId, 'WP-1');
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.phase, 'act');
    } finally {
      env.restore();
    }
  });

  test('actuator 不可用（手动置空）→ 降级兜底 dispatched:false，不再 placeholder', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      // 模拟 actuator require 失败/显式置空（_delegates.actuator=null）
      env.provider._delegates.actuator = null;
      var out = await env.api.act(res.loopId, { action: 'dispatch', targetWp: 'WP-1' });
      assert.strictEqual(out.dispatched, false);
      assert.strictEqual(out.placeholder, undefined, '降级分支不再返回 placeholder:true');
      assert.strictEqual(out.degraded, true, '降级标记 degraded:true');
    } finally {
      env.restore();
    }
  });

  test('外部 mock actuator 覆盖自动注入（mock 优先于自动注入）', async function () {
    var env = await makeEngine();
    try {
      var mockCalled = false;
      // 显式 inject 在自动注入之后，应覆盖 _delegates.actuator
      env.api.inject({
        actuator: {
          execute: async function () {
            mockCalled = true;
            return { dispatched: true, checklistResult: undefined };
          },
        },
      });
      var res = await env.api.init({});
      await env.api.act(res.loopId, { action: 'dispatch' });
      assert.strictEqual(mockCalled, true, '外部 mock actuator 被调用（优先于自动注入）');
    } finally {
      env.restore();
    }
  });

  test('注入 actuator 返回 checklistResult → 写入 lastChecklist 子 key', async function () {
    var env = await makeEngine();
    try {
      env.api.inject({
        actuator: {
          execute: async function () {
            return {
              dispatched: true,
              checklistResult: { wpId: 'WP-1', passed: false, summary: { total: 2, passed: 1, failed: 1 } },
            };
          },
        },
      });
      var res = await env.api.init({});
      await env.api.act(res.loopId, { action: 'dispatch' });
      var chk = await env.provider._store.get('loop.' + res.loopId + '.lastChecklist');
      assert.ok(chk, 'checklist 写入独立子 key');
      assert.strictEqual(chk.wpId, 'WP-1');
      assert.strictEqual(chk.passed, false);
    } finally {
      env.restore();
    }
  });
});

test.describe('reflect', function () {
  test('未注入 evaluator → fallback 评分（基于 lastChecklist）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      // 直接写入 lastChecklist 模拟 act 产出
      await env.provider._store.set('loop.' + res.loopId + '.lastChecklist', {
        wpId: 'WP-1', passed: false,
        summary: { total: 4, passed: 3, failed: 1 },
      });
      var evalResult = await env.api.reflect(res.loopId, {});
      assert.strictEqual(evalResult._fallback, true);
      // proximity = 1 - 1/4 = 0.75
      assert.ok(Math.abs(evalResult.proximity - 0.75) < 1e-9, 'proximity 基于失败率');
      assert.strictEqual(evalResult.allPassed, false);
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.phase, 'reflect');
      assert.strictEqual(st.divergenceStreak, evalResult.divergenceStreak, '发散计数同步到 state');
    } finally {
      env.restore();
    }
  });

  test('注入 evaluator → 走 score 路径', async function () {
    var env = await makeEngine();
    try {
      env.api.inject({
        evaluator: {
          score: async function () {
            return { proximity: 0.95, converged: true, diverged: false, divergenceStreak: 0, allPassed: true };
          },
        },
      });
      var res = await env.api.init({});
      var evalResult = await env.api.reflect(res.loopId, {});
      assert.strictEqual(evalResult.proximity, 0.95);
      assert.strictEqual(evalResult._fallback, undefined);
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 3: decide 终止判定优先级
//   优先级：熔断 > 发散 > 上限 > 达成 > 继续
// ─────────────────────────────────────────────

test.describe('decide 优先级', function () {
  test('熔断（watchdog terminated）优先级最高', async function () {
    var env = await makeEngine({
      getProvider: function () {
        return {
          getHealth: function () { return { state: 'terminated', running: false }; },
        };
      },
    });
    try {
      var res = await env.api.init({});
      // 即便发散/上限/达成都满足，熔断应胜出
      var verdict = await env.api.decide(res.loopId, {
        divergenceStreak: 99,
        proximity: 1,
        allPassed: true,
      });
      assert.strictEqual(verdict.verdict, 'circuit_broken');
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.status, 'circuit_broken');
    } finally {
      env.restore();
    }
  });

  test('发散 优先于 上限 与 达成', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({});
      // 把 iteration 推到接近上限，但发散 streak 更高 → 应判 diverged 而非 timeout
      var st = await env.api.getState(res.loopId);
      st.iteration = 5; // 接近默认 max_iterations=6 但 < 上限，发散 streak=3 → 应判 diverged 而非 timeout
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, { divergenceStreak: 3, proximity: 0.3 });
      assert.strictEqual(verdict.verdict, 'diverged', '发散先于上限');
    } finally {
      env.restore();
    }
  });

  test('上限 优先于 达成（iteration 达上限时即便全过也判 timeout）', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      st.iteration = 6; // >= 默认 max_iterations=6
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, {
        divergenceStreak: 0, proximity: 1, allPassed: true,
      });
      assert.strictEqual(verdict.verdict, 'timeout', '上限先于达成');
    } finally {
      env.restore();
    }
  });

  test('达成：全过 + proximity 达标 + 无 pending/failed', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({});
      // 先写一个"无 pending/failed"的快照到 state
      var st = await env.api.getState(res.loopId);
      st.lastSnapshot = {
        workPackages: { total: 2, pending: [], completed: ['WP-1', 'WP-2'], failed: [], blocked: [] },
      };
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, {
        divergenceStreak: 0, proximity: 0.95, allPassed: true,
      });
      assert.strictEqual(verdict.verdict, 'achieved');
      var st2 = await env.api.getState(res.loopId);
      assert.strictEqual(st2.status, 'achieved');
    } finally {
      env.restore();
    }
  });

  test('继续：未达任何终止条件', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      st.lastSnapshot = {
        workPackages: { total: 2, pending: ['WP-1'], completed: [], failed: [], blocked: [] },
      };
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, { divergenceStreak: 0, proximity: 0.5 });
      assert.strictEqual(verdict.verdict, 'continue');
    } finally {
      env.restore();
    }
  });

  test('watchdog degraded 也触发熔断（三态 getHealth 区分 degraded）', async function () {
    var env = await makeEngine({
      getProvider: function () {
        return {
          getHealth: function () { return { state: 'degraded', running: true, stale: true }; },
        };
      },
    });
    try {
      var res = await env.api.init({});
      var verdict = await env.api.decide(res.loopId, { divergenceStreak: 0, proximity: 0.9 });
      assert.strictEqual(verdict.verdict, 'circuit_broken');
    } finally {
      env.restore();
    }
  });

  test('降级 isRunning（旧版无 getHealth）→ terminated 时熔断', async function () {
    var env = await makeEngine({
      getProvider: function () {
        return { isRunning: function () { return false; } };
      },
    });
    try {
      var res = await env.api.init({});
      var verdict = await env.api.decide(res.loopId, { divergenceStreak: 0, proximity: 0.9 });
      assert.strictEqual(verdict.verdict, 'circuit_broken');
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 4: step 单步编排
// ─────────────────────────────────────────────

test.describe('step', function () {
  test('单步推进：iteration +1，history 记录一轮', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] } });
      var out = await env.api.step(res.loopId);
      assert.strictEqual(out.iteration, 1, 'iteration 单调递增');
      assert.ok(out.verdict, '产出 verdict');
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.iteration, 1);
      assert.strictEqual(st.history.length, 1, 'history 写入一轮');
      assert.strictEqual(st.history[0].iteration, 1);
    } finally {
      env.restore();
    }
  });

  test('已终止 loop 不再推进', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      st.status = 'achieved';
      st.iteration = 3;
      await env.provider._store.set('loop.' + res.loopId, st);

      var out = await env.api.step(res.loopId);
      assert.strictEqual(out.iteration, 3, 'iteration 不变');
      assert.strictEqual(out.verdict, 'achieved');
    } finally {
      env.restore();
    }
  });

  test('达到 iteration 上限时 step 直接判 timeout（硬上限）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      st.iteration = 6; // 默认 max_iterations=6
      await env.provider._store.set('loop.' + res.loopId, st);

      var out = await env.api.step(res.loopId);
      assert.strictEqual(out.verdict, 'timeout');
      assert.strictEqual(out.iteration, 6, '不再 +1');
    } finally {
      env.restore();
    }
  });

  test('持续 step 至达成：注入 mock actuator 使 proximity 上升至全过', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      // 注入 actuator 直接产出全过 checklist；注入 evaluator 产出满 proximity
      env.api.inject({
        actuator: {
          execute: async function () {
            return {
              dispatched: true,
              checklistResult: {
                wpId: 'WP-1', passed: true, summary: { total: 2, passed: 2, failed: 0 },
                failedItems: [],
              },
            };
          },
        },
        evaluator: {
          score: async function (_ctx, _id, _snap, state) {
            return {
              proximity: 1, converged: true, diverged: false,
              divergenceStreak: 0, allPassed: true,
              categoryScores: [], failingDrivers: [],
            };
          },
        },
      });
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] } });
      // 注入 snapshot 返回无 pending/failed（满足 achieved 条件）
      env.api.inject({
        snapshot: {
          aggregate: async function () {
            return {
              workPackages: { total: 1, pending: [], completed: ['WP-1'], failed: [], blocked: [] },
              lastChecklist: null,
              watchdog: { health: 'healthy', running: true, deployed: true },
            };
          },
        },
      });
      var out = await env.api.step(res.loopId);
      assert.strictEqual(out.verdict, 'achieved', '注入路径下应达成');
      assert.strictEqual(out.iteration, 1);
    } finally {
      env.restore();
    }
  });

  // ─────────────────────────────────────────────
  // WP-177-2-impl-b：actuator 自动注入后 step() 端到端流转（全程无 placeholder）
  // ─────────────────────────────────────────────

  test('真实 loop-actuator 注入后 step() 端到端流转：observe→think→act→reflect→decide 无 placeholder', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      // 不显式注入 actuator —— 验证自动注入生效（onActivate/factory 已注入 loop-actuator）
      // 仅注入 snapshot/evaluator 让流转可控（act 走真实 loop-actuator 路径）
      env.api.inject({
        snapshot: {
          aggregate: async function () {
            return {
              workPackages: { total: 1, pending: ['WP-1'], completed: [], failed: [], blocked: [] },
              lastChecklist: null,
              watchdog: { health: 'healthy', running: true, deployed: true },
            };
          },
        },
        evaluator: {
          score: async function () {
            return {
              proximity: 0.5, converged: false, diverged: false,
              divergenceStreak: 0, allPassed: false,
              categoryScores: [], failingDrivers: [],
            };
          },
        },
      });
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] } });
      var out = await env.api.step(res.loopId);
      assert.strictEqual(out.iteration, 1, 'iteration +1');

      // act 阶段经真实 loop-actuator 产出 pendingAction（非 placeholder）
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.lastActResult.placeholder, undefined, 'act 不再返回 placeholder');
      assert.strictEqual(st.lastActResult.dispatched, true, 'dispatch decision 经 actuator 派发');
      var pending = await env.provider._store.get('loop.' + res.loopId + '.pendingAction');
      assert.ok(pending, '真实 loop-actuator 产出 pendingAction 写入 state-store');
      assert.strictEqual(pending.mode, 'dispatch');

      // history 写入一轮，verdict 经 reflect→decide 产出（continue，proximity 未达标）
      assert.strictEqual(st.history.length, 1);
      assert.strictEqual(st.history[0].verdict, out.verdict);
    } finally {
      env.restore();
    }
  });

  test('单轮耗时超 max_round_time_ms → step 判 timeout 终止（WP-177-2-impl-a/b）', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      // 用慢 actuator 模拟单轮超时（max_round_time_ms 设极小值 1ms，act 故意耗时 > 1ms）
      await env.api.init({ goal: { wpIds: ['WP-1'] }, maxRoundTimeMs: 1 });
      env.api.inject({
        actuator: {
          execute: async function () {
            await new Promise(function (r) { setTimeout(r, 5); }); // 5ms > 1ms 阈值
            return { dispatched: true, checklistResult: undefined };
          },
        },
        snapshot: {
          aggregate: async function () {
            return {
              workPackages: { total: 1, pending: ['WP-1'], completed: [], failed: [], blocked: [] },
              lastChecklist: null,
              watchdog: { health: 'healthy', running: true, deployed: true },
            };
          },
        },
      });
      // 重新 init 触发 override（init 在 inject 之前调用过，这里用新 loopId）
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] }, maxRoundTimeMs: 1 });
      var out = await env.api.step(res.loopId);
      assert.strictEqual(out.verdict, 'timeout', '单轮超 max_round_time_ms 判 timeout');
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.status, 'timeout');
      assert.ok(/max_round_time_ms/.test(st.lastVerdict.reason), '终止原因含 max_round_time_ms');
      // history 写入超时记录
      assert.strictEqual(st.history[0].eval.roundTimeout, true);
    } finally {
      env.restore();
    }
  });

  test('actuator 自动注入幂等：多次 factory/_ensureStore 不重复覆盖外部 mock', async function () {
    var env = await makeEngine();
    try {
      // onActivate + factory 已自动注入一次 loop-actuator
      assert.ok(env.provider._delegates.actuator, '自动注入 actuator 已就位');
      var autoInjected = env.provider._delegates.actuator;
      // 再次调用 _autoInjectLoopActuator 应幂等（已存在 actuator，不覆盖）
      env.provider._autoInjectLoopActuator();
      assert.strictEqual(env.provider._delegates.actuator, autoInjected, '幂等：不重复注入/覆盖');

      // 外部 mock inject 仍能覆盖
      var mockActuator = { execute: async function () { return { dispatched: true }; } };
      env.api.inject({ actuator: mockActuator });
      assert.strictEqual(env.provider._delegates.actuator, mockActuator, '外部 mock 可覆盖自动注入');
      // 此时再调 _autoInjectLoopActuator 不应覆盖 mock
      env.provider._autoInjectLoopActuator();
      assert.strictEqual(env.provider._delegates.actuator, mockActuator, '有外部 mock 时幂等不覆盖');
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 4b: 出口行为 — verdict 终态生成报告（WP-177-2-impl-c）
//   触顶/发散/熔断自主生成总结报告写 state.terminalReport，不再依赖外部回 P1。
//   覆盖：三类终态各自验证报告、报告含 proximityTrend+failedItems、step 返回 report、
//         require loop-report 降级、applyDirective 人介入通道保留。
// ─────────────────────────────────────────────

test.describe('出口行为 终态报告 (WP-177-2-impl-c)', function () {
  test('decide 判 timeout → state.terminalReport 非空、含趋势+失败明细', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] } });
      // 构造 history（让报告含趋势）+ failingDrivers（含失败明细）
      var st = await env.api.getState(res.loopId);
      st.iteration = 6; // >= 默认 max_iterations=6 → 判 timeout
      st.history = [
        { iteration: 1, eval: { proximity: 0.3, failedCount: 5 }, verdict: 'continue' },
        { iteration: 2, eval: { proximity: 0.4, failedCount: 4 }, verdict: 'continue' },
      ];
      st.failingDrivers = [
        { wpId: 'WP-1', category: '测试', item: 't1', reason: '缺边界' },
      ];
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, {
        divergenceStreak: 0, proximity: 0.4, allPassed: false, failingDrivers: st.failingDrivers,
      });
      assert.strictEqual(verdict.verdict, 'timeout');
      var st2 = await env.api.getState(res.loopId);
      assert.ok(st2.terminalReport, 'timeout 终态生成 report');
      assert.strictEqual(st2.terminalReport.verdict, 'timeout');
      assert.ok(st2.terminalReport.proximityTrend.length >= 2, '报告含 proximityTrend 趋势');
      assert.strictEqual(st2.terminalReport.failedItems.length, 1, '报告含 failedItems 明细');
      assert.ok(st2.terminalReport.markdown, '报告含 markdown');
      assert.strictEqual(st2.status, 'timeout');
    } finally {
      env.restore();
    }
  });

  test('decide 判 diverged → state.terminalReport.verdict=diverged', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      st.iteration = 3; // < max_iterations，但发散 streak=3 → 判 diverged
      st.history = [
        { iteration: 1, eval: { proximity: 0.5 }, verdict: 'continue' },
        { iteration: 2, eval: { proximity: 0.5 }, verdict: 'continue' },
        { iteration: 3, eval: { proximity: 0.4 }, verdict: 'continue' },
      ];
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, { divergenceStreak: 3, proximity: 0.4 });
      assert.strictEqual(verdict.verdict, 'diverged');
      var st2 = await env.api.getState(res.loopId);
      assert.ok(st2.terminalReport, 'diverged 终态生成 report');
      assert.strictEqual(st2.terminalReport.verdict, 'diverged');
      assert.strictEqual(st2.status, 'diverged');
    } finally {
      env.restore();
    }
  });

  test('decide 判 circuit_broken（熔断）→ state.terminalReport.verdict=circuit_broken', async function () {
    var env = await makeEngine({
      getProvider: function () {
        return { getHealth: function () { return { state: 'terminated', running: false }; } };
      },
    });
    try {
      var res = await env.api.init({});
      var verdict = await env.api.decide(res.loopId, { divergenceStreak: 0, proximity: 0.9 });
      assert.strictEqual(verdict.verdict, 'circuit_broken');
      var st = await env.api.getState(res.loopId);
      assert.ok(st.terminalReport, 'circuit_broken 终态生成 report');
      assert.strictEqual(st.terminalReport.verdict, 'circuit_broken');
      assert.strictEqual(st.status, 'circuit_broken');
      // circuit_broken 报告应含「建议检查 watchdog」类提示（loop-report verdict 分支文案）
      assert.ok(/watchdog|dispatcher/.test(st.terminalReport.summary + st.terminalReport.markdown),
        '报告含 watchdog/dispatcher 检查建议');
    } finally {
      env.restore();
    }
  });

  test('decide 判 achieved → 不生成 terminalReport（走 completion，不产终态报告）', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      st.lastSnapshot = {
        workPackages: { total: 1, pending: [], completed: ['WP-1'], failed: [], blocked: [] },
      };
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, {
        divergenceStreak: 0, proximity: 0.95, allPassed: true,
      });
      assert.strictEqual(verdict.verdict, 'achieved');
      var st2 = await env.api.getState(res.loopId);
      assert.ok(!st2.terminalReport, 'achieved 不产终态报告');
    } finally {
      env.restore();
    }
  });

  test('step 提前硬上限 timeout 出口 → 返回值含 report + state.terminalReport 非空', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      st.iteration = 6; // 触发 step 开头 iteration 硬上限提前出口
      st.history = [
        { iteration: 1, eval: { proximity: 0.3 }, verdict: 'continue' },
      ];
      await env.provider._store.set('loop.' + res.loopId, st);

      var out = await env.api.step(res.loopId);
      assert.strictEqual(out.verdict, 'timeout');
      assert.ok(out.report, 'step 返回值含 report');
      assert.strictEqual(out.report.verdict, 'timeout');
      var st2 = await env.api.getState(res.loopId);
      assert.ok(st2.terminalReport, 'state.terminalReport 已写入');
    } finally {
      env.restore();
    }
  });

  test('step 正常流转 diverged → step 返回 report 含末轮趋势（history 完整后生成）', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      // 注入 evaluator 持续高发散 streak 触发 diverged
      env.api.inject({
        evaluator: {
          score: async function () {
            return {
              proximity: 0.4, converged: false, diverged: true, divergenceStreak: 3,
              allPassed: false, failingDrivers: [], failedCount: 2,
            };
          },
        },
        snapshot: {
          aggregate: async function () {
            return {
              workPackages: { total: 1, pending: ['WP-1'], completed: [], failed: [], blocked: [] },
              lastChecklist: null,
              watchdog: { health: 'healthy', running: true, deployed: true },
            };
          },
        },
      });
      // 把阈值调低让单步即达 diverged（divergence_threshold=3）
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] }, divergenceThreshold: 1 });
      var out = await env.api.step(res.loopId);
      assert.strictEqual(out.verdict, 'diverged', 'evaluator streak=3 >= threshold=1 → diverged');
      assert.ok(out.report, 'step diverged 返回 report');
      assert.strictEqual(out.report.verdict, 'diverged');
      // history 完整后生成，趋势含本轮
      assert.ok(out.report.proximityTrend.length >= 1, '报告含本轮 proximityTrend');
      var st = await env.api.getState(res.loopId);
      assert.ok(st.terminalReport, 'state.terminalReport 已写入');
    } finally {
      env.restore();
    }
  });

  test('loop-report require 失败降级：terminalReport.degraded=true，不崩', async function () {
    var env = await makeEngine();
    try {
      // 临时让 engine 的 loopReport 引用失效（模拟 require 失败）：
      //   通过模块缓存替换不可行（已捕获到常量），改为直接置 _generateTerminalReport
      //   内部依赖的 loopReport 为 null —— 用 monkeypatch require 缓存重载 engine。
      var modPath = require.resolve('../../plugins/core/provider-loop-engine');
      delete require.cache[modPath];
      // 劫持 require：engine require loop-report 时抛错
      var Module = require('module');
      var origReq = Module.prototype.require;
      Module.prototype.require = function (id) {
        if (/loop-report$/.test(id)) {
          throw new Error('simulated require failure');
        }
        return origReq.apply(this, arguments);
      };
      var DegradedEngine;
      try {
        DegradedEngine = require('../../plugins/core/provider-loop-engine');
      } finally {
        Module.prototype.require = origReq;
      }
      assert.ok(DegradedEngine, 'engine 仍可加载（require loop-report 失败不阻断）');

      // 在临时环境里跑降级路径
      var dir = makeTmpDir();
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      var origCwd = process.cwd();
      process.chdir(dir);
      try {
        var provider = new DegradedEngine();
        await provider.onActivate({ getProvider: function () { return null; } });
        var api = await provider.factory({ getProvider: function () { return null; } });
        var res = await api.init({ goal: { wpIds: ['WP-1'] } });
        var st = await api.getState(res.loopId);
        st.iteration = 6;
        await provider._store.set('loop.' + res.loopId, st);
        var verdict = await api.decide(res.loopId, { divergenceStreak: 0, proximity: 0.3 });
        assert.strictEqual(verdict.verdict, 'timeout', '终态判定不受影响');
        var st2 = await api.getState(res.loopId);
        assert.ok(st2.terminalReport, '降级仍写 terminalReport 占位');
        assert.strictEqual(st2.terminalReport.degraded, true, '标记 degraded:true');
        assert.strictEqual(st2.terminalReport.verdict, 'timeout');
        assert.strictEqual(st2.status, 'timeout', '终态 status 正确');
      } finally {
        process.chdir(origCwd);
        cleanupTmpDir(dir);
      }
    } finally {
      // 清理劫持缓存，恢复真实 engine 模块供后续测试
      delete require.cache[require.resolve('../../plugins/core/provider-loop-engine')];
      require('../../plugins/core/provider-loop-engine');
      env.restore();
    }
  });

  test('applyDirective pause/abort 人介入通道保留可用（终态报告不破坏人介入）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      // 先人为制造一个已生成报告的 timeout 终态
      var st = await env.api.getState(res.loopId);
      st.status = 'timeout';
      st.terminalReport = { verdict: 'timeout', degraded: false, markdown: 'x' };
      await env.provider._store.set('loop.' + res.loopId, st);

      // 人通过 abort 指令介入（覆盖终态）
      var ok = await env.api.applyDirective(res.loopId, { action: 'abort', reason: '人介入' });
      assert.strictEqual(ok, true, 'abort 指令仍生效');
      var st2 = await env.api.getState(res.loopId);
      assert.strictEqual(st2.status, 'aborted', '人介入通道覆盖终态 status');
      assert.strictEqual(st2.lastVerdict.verdict, 'aborted');

      // pause 通道
      var res2 = await env.api.init({});
      await env.api.applyDirective(res2.loopId, { action: 'pause' });
      var st3 = await env.api.getState(res2.loopId);
      assert.strictEqual(st3.status, 'paused', 'pause 通道可用');
    } finally {
      env.restore();
    }
  });

  test('已终止 loop 再 step：透传已存 terminalReport（report 字段非空）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var st = await env.api.getState(res.loopId);
      st.status = 'diverged';
      st.lastVerdict = { verdict: 'diverged', reason: 'r' };
      st.terminalReport = { verdict: 'diverged', markdown: 'prev report' };
      st.iteration = 4;
      await env.provider._store.set('loop.' + res.loopId, st);

      var out = await env.api.step(res.loopId);
      assert.strictEqual(out.verdict, 'diverged', '已终止不推进');
      assert.ok(out.report, '透传已存 terminalReport');
      assert.strictEqual(out.report.markdown, 'prev report');
    } finally {
      env.restore();
    }
  });
});


test.describe('applyDirective', function () {
  test('pause → status=paused', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var ok = await env.api.applyDirective(res.loopId, { action: 'pause', reason: 'r' });
      assert.strictEqual(ok, true);
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.status, 'paused');
      assert.strictEqual(st.lastDirective.action, 'pause');
    } finally {
      env.restore();
    }
  });

  test('abort → status=aborted, lastVerdict.verdict=aborted', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var ok = await env.api.applyDirective(res.loopId, { action: 'abort', reason: 'r' });
      assert.strictEqual(ok, true);
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.status, 'aborted');
      assert.strictEqual(st.lastVerdict.verdict, 'aborted');
    } finally {
      env.restore();
    }
  });

  test('abort_all → lastVerdict.verdict=circuit_broken', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      await env.api.applyDirective(res.loopId, { action: 'abort_all' });
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.status, 'aborted');
      assert.strictEqual(st.lastVerdict.verdict, 'circuit_broken');
    } finally {
      env.restore();
    }
  });

  test('未知指令 → 返回 false，状态不变', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var ok = await env.api.applyDirective(res.loopId, { action: 'bogus' });
      assert.strictEqual(ok, false);
      var st = await env.api.getState(res.loopId);
      assert.strictEqual(st.status, 'running');
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 6: inject / getConfig / persist / getState
// ─────────────────────────────────────────────

test.describe('inject & misc', function () {
  test('inject 返回 true 并可覆盖 delegate', async function () {
    var env = await makeEngine();
    try {
      var ok = env.api.inject({ evaluator: { score: async function () { return {}; } } });
      assert.strictEqual(ok, true);
      assert.ok(env.provider._delegates.evaluator, 'evaluator 已注入');
    } finally {
      env.restore();
    }
  });

  test('getConfig 返回配置副本（含默认值）', async function () {
    var env = await makeEngine();
    try {
      var cfg = env.api.getConfig();
      assert.strictEqual(cfg.max_iterations, 6);
      assert.strictEqual(cfg.max_round_time_ms, 600000, '默认单轮最长时间 10min');
      assert.strictEqual(cfg.max_wall_time_ms, 3600000);
      assert.strictEqual(cfg.proximity_goal, 0.9);
    } finally {
      env.restore();
    }
  });

  test('init(opts) override 覆盖默认阈值（默认 ← plugin.json ← override）', async function () {
    var env = await makeEngine();
    try {
      await env.api.init({ maxIterations: 3, maxRoundTimeMs: 120000, maxWallTimeMs: 60000 });
      var cfg = env.api.getConfig();
      assert.strictEqual(cfg.max_iterations, 3, 'maxIterations override 生效');
      assert.strictEqual(cfg.max_round_time_ms, 120000, 'maxRoundTimeMs override 生效');
      assert.strictEqual(cfg.max_wall_time_ms, 60000, 'maxWallTimeMs override 生效');
    } finally {
      env.restore();
    }
  });

  test('init(opts) override 使上限判定按新阈值（max_iterations=3）', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      var res = await env.api.init({ maxIterations: 3 });
      var st = await env.api.getState(res.loopId);
      st.iteration = 3; // >= override max_iterations=3
      await env.provider._store.set('loop.' + res.loopId, st);

      var verdict = await env.api.decide(res.loopId, {
        divergenceStreak: 0, proximity: 1, allPassed: true,
      });
      assert.strictEqual(verdict.verdict, 'timeout', 'override 后 iteration=3 即达上限');
    } finally {
      env.restore();
    }
  });

  test('persist 写回（lastUpdatedAt 更新）', async function () {
    var env = await makeEngine();
    try {
      var res = await env.api.init({});
      var before = (await env.api.getState(res.loopId)).lastUpdatedAt;
      // 强制延迟保证时间戳变化
      await new Promise(function (r) { setTimeout(r, 10); });
      await env.api.persist(res.loopId);
      var after = (await env.api.getState(res.loopId)).lastUpdatedAt;
      assert.notStrictEqual(before, after, 'lastUpdatedAt 已更新');
    } finally {
      env.restore();
    }
  });

  test('getState 未知 loopId 抛错', async function () {
    var env = await makeEngine();
    try {
      await assert.rejects(function () { return env.api.getState('nope'); }, /unknown loopId/);
    } finally {
      env.restore();
    }
  });
});
