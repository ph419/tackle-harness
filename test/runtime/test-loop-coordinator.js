/**
 * Unit tests for loop-coordinator (WP-174-5 / WP-174-6)
 * Run with: node --test test/runtime/test-loop-coordinator.js
 *
 * 覆盖：
 *   - aggregateLoopStates 双入口（loopStates 数组 / store 前缀扫描）
 *   - summarizeLoop 单 loop 摘要（含 disconnected）
 *   - computeGlobalState 四类全局 verdict 优先级：
 *       global_circuit_broken > global_failed > global_achieved > global_running
 *   - 常量 TERMINAL/CIRCUIT/FAILED_VERDICTS
 *   - 辅助判定 isGlobalAchieved / isGlobalCircuitBroken / needsHumanIntervention
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');

var coordinator = require('../../plugins/runtime/loop-coordinator');

// ─────────────────────────────────────────────
// Helpers: 构造 loop state
// ─────────────────────────────────────────────

function loopState(loopId, overrides) {
  return Object.assign({
    loopId: loopId,
    status: 'running',
    iteration: 1,
    history: [],
    divergenceStreak: 0,
    lastVerdict: { verdict: 'continue', reason: 'r' },
    lastEval: { proximity: 0.5, diverged: false, divergenceStreak: 0 },
    lastSnapshot: { watchdog: { health: 'healthy', running: true } },
    lastUpdatedAt: '2026-06-12T00:00:00Z',
  }, overrides || {});
}

// ─────────────────────────────────────────────
// Section 1: 常量
// ─────────────────────────────────────────────

test.describe('常量', function () {
  test('TERMINAL_VERDICTS 含五类终止', function () {
    assert.strictEqual(coordinator.TERMINAL_VERDICTS.achieved, true);
    assert.strictEqual(coordinator.TERMINAL_VERDICTS.timeout, true);
    assert.strictEqual(coordinator.TERMINAL_VERDICTS.diverged, true);
    assert.strictEqual(coordinator.TERMINAL_VERDICTS.circuit_broken, true);
    assert.strictEqual(coordinator.TERMINAL_VERDICTS.aborted, true);
    assert.strictEqual(coordinator.TERMINAL_VERDICTS.continue, undefined);
  });

  test('CIRCUIT_VERDICTS = circuit_broken + aborted', function () {
    assert.strictEqual(coordinator.CIRCUIT_VERDICTS.circuit_broken, true);
    assert.strictEqual(coordinator.CIRCUIT_VERDICTS.aborted, true);
    assert.strictEqual(coordinator.CIRCUIT_VERDICTS.timeout, undefined);
  });

  test('FAILED_VERDICTS = timeout + diverged', function () {
    assert.strictEqual(coordinator.FAILED_VERDICTS.timeout, true);
    assert.strictEqual(coordinator.FAILED_VERDICTS.diverged, true);
    assert.strictEqual(coordinator.FAILED_VERDICTS.achieved, undefined);
  });
});

// ─────────────────────────────────────────────
// Section 2: summarizeLoop
// ─────────────────────────────────────────────

test.describe('summarizeLoop', function () {
  test('正常 state → 提取 verdict/proximity/health', function () {
    var s = coordinator.summarizeLoop('L1', loopState('L1', {
      lastVerdict: { verdict: 'achieved', reason: 'ok' },
      lastEval: { proximity: 0.95, diverged: false, divergenceStreak: 0 },
    }));
    assert.strictEqual(s.loopId, 'L1');
    assert.strictEqual(s.status, 'running');
    assert.strictEqual(s.verdict, 'achieved');
    assert.strictEqual(s.proximity, 0.95);
    assert.strictEqual(s.health, 'healthy');
    assert.strictEqual(s.diverged, false);
  });

  test('state=null → disconnected', function () {
    var s = coordinator.summarizeLoop('L1', null);
    assert.strictEqual(s.status, 'disconnected');
    assert.strictEqual(s.proximity, 0);
    assert.strictEqual(s.verdict, null);
    assert.strictEqual(s.error, 'state-missing');
  });

  test('health 优先取 watchdog.health', function () {
    var s = coordinator.summarizeLoop('L1', loopState('L1', {
      lastSnapshot: { watchdog: { health: 'terminated', running: false } },
    }));
    assert.strictEqual(s.health, 'terminated');
  });

  test('无 watchdog.health 时按 status 推断（circuit_broken → terminated）', function () {
    var s = coordinator.summarizeLoop('L1', loopState('L1', {
      status: 'circuit_broken', lastSnapshot: {},
    }));
    assert.strictEqual(s.health, 'terminated');
  });
});

// ─────────────────────────────────────────────
// Section 3: computeGlobalState 优先级
//   熔断 > 失败 > 达成 > 运行
// ─────────────────────────────────────────────

test.describe('computeGlobalState 优先级', function () {
  function loops() {
    return {
      loopsMap: {},
      ids: [],
      add: function (id, summary) { this.loopsMap[id] = summary; this.ids.push(id); return this; },
    };
  }

  test('熔断优先级最高：1 熔断 + 1 达成 → global_circuit_broken', function () {
    var L = loops()
      .add('a', { status: 'circuit_broken', verdict: 'circuit_broken', proximity: 0, iteration: 1, health: 'terminated' })
      .add('b', { status: 'achieved', verdict: 'achieved', proximity: 1, iteration: 5, health: 'healthy' });
    var g = coordinator.computeGlobalState(L.loopsMap, L.ids);
    assert.strictEqual(g.verdict, 'global_circuit_broken');
    assert.strictEqual(g.circuitCount, 1);
    assert.strictEqual(g.achievedCount, 1);
  });

  test('失败优先于达成：1 失败 + 1 达成 → global_failed', function () {
    var L = loops()
      .add('a', { status: 'timeout', verdict: 'timeout', proximity: 0.4, iteration: 10, health: 'healthy' })
      .add('b', { status: 'achieved', verdict: 'achieved', proximity: 1, iteration: 5, health: 'healthy' });
    var g = coordinator.computeGlobalState(L.loopsMap, L.ids);
    assert.strictEqual(g.verdict, 'global_failed');
    assert.strictEqual(g.failedCount, 1);
  });

  test('全部达成 → global_achieved', function () {
    var L = loops()
      .add('a', { status: 'achieved', verdict: 'achieved', proximity: 1, iteration: 3, health: 'healthy' })
      .add('b', { status: 'achieved', verdict: 'achieved', proximity: 1, iteration: 4, health: 'healthy' });
    var g = coordinator.computeGlobalState(L.loopsMap, L.ids);
    assert.strictEqual(g.verdict, 'global_achieved');
    assert.strictEqual(g.achievedCount, 2);
  });

  test('仍有 running → global_running', function () {
    var L = loops()
      .add('a', { status: 'running', verdict: 'continue', proximity: 0.5, iteration: 2, health: 'healthy' })
      .add('b', { status: 'achieved', verdict: 'achieved', proximity: 1, iteration: 3, health: 'healthy' });
    var g = coordinator.computeGlobalState(L.loopsMap, L.ids);
    assert.strictEqual(g.verdict, 'global_running');
    assert.strictEqual(g.runningCount, 1);
  });

  test('disconnected 不计入达成分母：其余全达成仍 global_achieved', function () {
    var L = loops()
      .add('a', { status: 'disconnected', verdict: null, proximity: 0, iteration: 0, health: 'unknown' })
      .add('b', { status: 'achieved', verdict: 'achieved', proximity: 1, iteration: 3, health: 'healthy' });
    var g = coordinator.computeGlobalState(L.loopsMap, L.ids);
    assert.strictEqual(g.verdict, 'global_achieved');
    assert.strictEqual(g.disconnectedCount, 1);
  });

  test('全 disconnected（无有效 loop）→ global_running（无达成）', function () {
    var L = loops()
      .add('a', { status: 'disconnected', verdict: null, proximity: 0, iteration: 0, health: 'unknown' });
    var g = coordinator.computeGlobalState(L.loopsMap, L.ids);
    assert.strictEqual(g.verdict, 'global_running');
  });

  test('空集 → global_running', function () {
    var g = coordinator.computeGlobalState({}, []);
    assert.strictEqual(g.verdict, 'global_running');
    assert.strictEqual(g.minProximity, 0);
  });

  test('统计 minProximity / maxIteration', function () {
    var L = loops()
      .add('a', { status: 'running', verdict: 'continue', proximity: 0.3, iteration: 7, health: 'healthy' })
      .add('b', { status: 'running', verdict: 'continue', proximity: 0.9, iteration: 2, health: 'healthy' });
    var g = coordinator.computeGlobalState(L.loopsMap, L.ids);
    assert.ok(Math.abs(g.minProximity - 0.3) < 1e-9);
    assert.strictEqual(g.maxIteration, 7);
  });
});

// ─────────────────────────────────────────────
// Section 4: aggregateLoopStates 双入口
// ─────────────────────────────────────────────

test.describe('aggregateLoopStates', function () {
  test('入口一：loopStates 数组', async function () {
    var res = await coordinator.aggregateLoopStates({
      loopStates: [
        loopState('L1', { lastVerdict: { verdict: 'achieved' }, lastEval: { proximity: 1 } }),
        loopState('L2', { lastVerdict: { verdict: 'achieved' }, lastEval: { proximity: 1 } }),
      ],
      sessionId: 'sess-1',
    });
    assert.strictEqual(res.session_id, 'sess-1');
    assert.strictEqual(res.total_loops, 2);
    assert.strictEqual(res.global.verdict, 'global_achieved');
    assert.ok(res.loops.L1, '含 L1 摘要');
    assert.ok(res.loops.L2);
  });

  test('入口二：store 前缀扫描（listByPrefix）', async function () {
    var store = {
      listByPrefix: async function (prefix) {
        assert.strictEqual(prefix, 'loop.');
        return ['loop.L1', 'loop.L2', 'loop.L3.lastChecklist'];
      },
      get: async function (key) {
        if (key === 'loop.L1') return loopState('L1', { lastVerdict: { verdict: 'achieved' }, lastEval: { proximity: 1 } });
        if (key === 'loop.L2') return loopState('L2', { lastVerdict: { verdict: 'achieved' }, lastEval: { proximity: 1 } });
        // loop.L3.lastChecklist 无 loopId → 应被过滤
        if (key === 'loop.L3.lastChecklist') return { wpId: 'WP-1', passed: true };
        return null;
      },
    };
    var res = await coordinator.aggregateLoopStates({ store: store });
    assert.strictEqual(res.total_loops, 2, '脏数据（无 loopId）被过滤');
    assert.ok(res.loops.L1);
    assert.ok(res.loops.L2);
    assert.strictEqual(res.global.verdict, 'global_achieved');
  });

  test('入口二：store 仅 listKeys（降级过滤 loop. 前缀）', async function () {
    var store = {
      listKeys: async function () { return ['loop.L1', 'harness.x', 'loop.L2.lastChecklist']; },
      get: async function (key) {
        if (key === 'loop.L1') return loopState('L1', { lastVerdict: { verdict: 'achieved' }, lastEval: { proximity: 1 } });
        if (key === 'loop.L2.lastChecklist') return { passed: true };
        return null;
      },
    };
    var res = await coordinator.aggregateLoopStates({ store: store });
    assert.strictEqual(res.total_loops, 1, '仅 loop.L1 有效');
    assert.ok(res.loops.L1);
  });

  test('store 无 listKeys/listByPrefix → 空聚合不报错', async function () {
    var res = await coordinator.aggregateLoopStates({ store: { get: async function () { return null; } } });
    assert.strictEqual(res.total_loops, 0);
    assert.strictEqual(res.global.verdict, 'global_running');
  });

  test('store.get 单 loop 失败 → 跳过不阻断', async function () {
    var store = {
      listByPrefix: async function () { return ['loop.L1', 'loop.L2']; },
      get: async function (key) {
        if (key === 'loop.L1') throw new Error('read fail');
        return loopState('L2', { lastVerdict: { verdict: 'achieved' }, lastEval: { proximity: 1 } });
      },
    };
    var res = await coordinator.aggregateLoopStates({ store: store });
    assert.strictEqual(res.total_loops, 1, '失败的 L1 被跳过');
    assert.ok(res.loops.L2);
  });

  test('无 loopId 的 state 被跳过', async function () {
    var res = await coordinator.aggregateLoopStates({
      loopStates: [
        { status: 'running' }, // 无 loopId
        loopState('L1', { lastVerdict: { verdict: 'achieved' }, lastEval: { proximity: 1 } }),
      ],
    });
    assert.strictEqual(res.total_loops, 1);
  });
});

// ─────────────────────────────────────────────
// Section 5: 辅助判定
// ─────────────────────────────────────────────

test.describe('辅助判定', function () {
  test('isGlobalAchieved', async function () {
    var ok = await coordinator.aggregateLoopStates({
      loopStates: [loopState('L1', { lastVerdict: { verdict: 'achieved' }, lastEval: { proximity: 1 } })],
    });
    assert.strictEqual(coordinator.isGlobalAchieved(ok), true);
  });

  test('isGlobalCircuitBroken', async function () {
    var broken = await coordinator.aggregateLoopStates({
      loopStates: [loopState('L1', {
        status: 'circuit_broken',
        lastVerdict: { verdict: 'circuit_broken' },
        lastSnapshot: { watchdog: { health: 'terminated' } },
      })],
    });
    assert.strictEqual(coordinator.isGlobalCircuitBroken(broken), true);
    assert.strictEqual(coordinator.needsHumanIntervention(broken), true);
  });

  test('needsHumanIntervention：failed 也需介入', async function () {
    var failed = await coordinator.aggregateLoopStates({
      loopStates: [loopState('L1', {
        status: 'diverged',
        lastVerdict: { verdict: 'diverged' },
        lastEval: { proximity: 0.3, divergenceStreak: 3 },
      })],
    });
    assert.strictEqual(failed.global.verdict, 'global_failed');
    assert.strictEqual(coordinator.needsHumanIntervention(failed), true);
  });

  test('global_running 不需介入', async function () {
    var running = await coordinator.aggregateLoopStates({
      loopStates: [loopState('L1')],
    });
    assert.strictEqual(coordinator.needsHumanIntervention(running), false);
  });
});
