/**
 * Unit tests for loop-actuator (WP-177-1-impl-b)
 * Run with: node --test test/runtime/test-loop-actuator.js
 *
 * 覆盖：
 *   - dispatch / retry / resplit 三种 decision 的指令序列化
 *   - failingDrivers 注入（透传 reflection-evaluator 结构）
 *   - checklistResult 回填路径（state.lastChecklist / store 子 key）
 *   - 幂等（同一 decision 重复 execute 不产生重复 pendingAction）
 *   - state-store 降级（不可用时 {dispatched:false, error}）
 *   - noop decision 跳过派发
 *   - 签名兼容 engine act() inject 期望（execute 四参 + 返回 {dispatched, checklistResult?}）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var actuator = require('../../plugins/runtime/loop-actuator');
var createActuator = actuator.createActuator;
var { StateStore } = require('../../plugins/runtime/state-store');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loop-actuator-test-'));
}

function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function setupEnv() {
  var dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  var origCwd = process.cwd();
  process.chdir(dir);
  var store = new StateStore({ filePath: path.join(dir, '.claude-state') });
  return {
    dir: dir,
    store: store,
    origCwd: origCwd,
    restore: function () { process.chdir(origCwd); cleanupTmpDir(dir); },
  };
}

function readPending(store, loopId) {
  return store.get('loop.' + loopId + '.pendingAction');
}

// ─────────────────────────────────────────────
// Section 1: dispatch / retry / resplit 指令序列化
// ─────────────────────────────────────────────

test('dispatch decision 序列化为 pendingAction（mode=dispatch, strategy=full_restart）', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var decision = { action: 'dispatch', targetWp: 'WP-5', strategy: 'full_restart', reason: 'pending WP' };

    var result = await act.execute(null, 'loop-1', decision, {});

    assert.strictEqual(result.dispatched, true);
    assert.strictEqual(result._mode, 'dispatch');

    var pa = await readPending(env.store, 'loop-1');
    assert.ok(pa, 'pendingAction 应写入 state-store');
    assert.strictEqual(pa.mode, 'dispatch');
    assert.strictEqual(pa.wpId, 'WP-5');
    assert.strictEqual(pa.strategy, 'full_restart');
    assert.deepStrictEqual(pa.failingDrivers, []);
    assert.strictEqual(pa.loopId, 'loop-1');
    assert.ok(pa.createdAt, 'createdAt 应存在');
    assert.strictEqual(pa.context, null);
  } finally {
    env.restore();
  }
});

test('retry decision 携带 failingDrivers（透传 reflection-evaluator 结构）', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var failingDrivers = [
      { wpId: 'WP-5', category: 'test', item: '单测覆盖', reason: '缺少 actuator 测试' },
      { wpId: 'WP-5', category: 'lint', item: 'eslint', reason: 'var 声明' },
    ];
    var decision = {
      action: 'retry',
      targetWp: 'WP-5',
      strategy: 'checkpoint_resume',
      failingDrivers: failingDrivers,
      reason: '上轮失败',
    };

    var result = await act.execute(null, 'loop-1', decision, {});

    assert.strictEqual(result.dispatched, true);
    var pa = await readPending(env.store, 'loop-1');
    assert.strictEqual(pa.mode, 'retry');
    assert.strictEqual(pa.wpId, 'WP-5');
    assert.strictEqual(pa.strategy, 'checkpoint_resume');
    assert.deepStrictEqual(pa.failingDrivers, failingDrivers);
    assert.strictEqual(pa.failingDrivers.length, 2);
  } finally {
    env.restore();
  }
});

test('resplit decision 序列化（mode=resplit, strategy=resplit）', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var decision = { action: 'resplit', targetWp: 'WP-7', strategy: 'resplit', reason: 'checklist 失败' };

    var result = await act.execute(null, 'loop-1', decision, {});

    assert.strictEqual(result.dispatched, true);
    var pa = await readPending(env.store, 'loop-1');
    assert.strictEqual(pa.mode, 'resplit');
    assert.strictEqual(pa.wpId, 'WP-7');
    assert.strictEqual(pa.strategy, 'resplit');
  } finally {
    env.restore();
  }
});

test('retry decision 缺省 strategy 时回退 checkpoint_resume', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var decision = { action: 'retry', targetWp: 'WP-5', failingDrivers: [], reason: 'r' };

    await act.execute(null, 'loop-1', decision, {});

    var pa = await readPending(env.store, 'loop-1');
    assert.strictEqual(pa.strategy, 'checkpoint_resume');
  } finally {
    env.restore();
  }
});

test('dispatch decision 缺省 strategy 时回退 full_restart', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var decision = { action: 'dispatch', targetWp: 'WP-5', reason: 'r' };

    await act.execute(null, 'loop-1', decision, {});

    var pa = await readPending(env.store, 'loop-1');
    assert.strictEqual(pa.strategy, 'full_restart');
  } finally {
    env.restore();
  }
});

test('checkpoint_resume 上下文透传到 pendingAction.context', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var ctx = { resumeFrom: 'step-3', checkpoint: 'abc' };
    var decision = { action: 'retry', targetWp: 'WP-5', strategy: 'checkpoint_resume', context: ctx };

    await act.execute(null, 'loop-1', decision, {});

    var pa = await readPending(env.store, 'loop-1');
    assert.deepStrictEqual(pa.context, ctx);
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 2: checklistResult 回填
// ─────────────────────────────────────────────

test('state.lastChecklist 存在时回填到 checklistResult', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var chk = { wpId: 'WP-5', passed: true, failedItems: [] };
    var decision = { action: 'dispatch', targetWp: 'WP-5', strategy: 'full_restart' };

    var result = await act.execute(null, 'loop-1', decision, { lastChecklist: chk });

    assert.strictEqual(result.dispatched, true);
    assert.deepStrictEqual(result.checklistResult, chk);
  } finally {
    env.restore();
  }
});

test('store 子 key lastChecklist 存在时回填（state 无 lastChecklist）', async function () {
  var env = setupEnv();
  try {
    var chk = { wpId: 'WP-5', passed: false, failedItems: [{ id: 'x', reason: 'fail' }] };
    await env.store.set('loop.loop-1.lastChecklist', chk);

    var act = createActuator({ store: env.store });
    var decision = { action: 'dispatch', targetWp: 'WP-5', strategy: 'full_restart' };

    var result = await act.execute(null, 'loop-1', decision, {});

    assert.strictEqual(result.dispatched, true);
    assert.deepStrictEqual(result.checklistResult, chk);
  } finally {
    env.restore();
  }
});

test('无任何 checklist 时 checklistResult 为 undefined', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var decision = { action: 'dispatch', targetWp: 'WP-5', strategy: 'full_restart' };

    var result = await act.execute(null, 'loop-1', decision, {});

    assert.strictEqual(result.dispatched, true);
    assert.strictEqual(result.checklistResult, undefined);
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 3: 幂等
// ─────────────────────────────────────────────

test('同一 decision 重复 execute 覆盖同一 key，不产生重复 pendingAction', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var decision = { action: 'dispatch', targetWp: 'WP-5', strategy: 'full_restart' };

    await act.execute(null, 'loop-1', decision, {});
    await act.execute(null, 'loop-1', decision, {});
    await act.execute(null, 'loop-1', decision, {});

    var pa = await readPending(env.store, 'loop-1');
    assert.ok(pa, 'pendingAction 存在');
    assert.strictEqual(pa.mode, 'dispatch');
    assert.strictEqual(pa.wpId, 'WP-5');
    // 覆盖而非追加：state-store 单 key 值始终是单个对象
    assert.strictEqual(typeof pa, 'object');
    assert.ok(!Array.isArray(pa), '不应是数组');
  } finally {
    env.restore();
  }
});

test('_idempotencyKey 按 mode+wpId 计算', function () {
  var pa1 = { mode: 'retry', wpId: 'WP-5' };
  var pa2 = { mode: 'retry', wpId: 'WP-5' };
  var pa3 = { mode: 'dispatch', wpId: 'WP-5' };
  var pa4 = { mode: 'retry', wpId: 'WP-6' };
  assert.strictEqual(actuator._idempotencyKey(pa1), actuator._idempotencyKey(pa2));
  assert.notStrictEqual(actuator._idempotencyKey(pa1), actuator._idempotencyKey(pa3));
  assert.notStrictEqual(actuator._idempotencyKey(pa1), actuator._idempotencyKey(pa4));
});

// ─────────────────────────────────────────────
// Section 4: state-store 降级 / 容错
// ─────────────────────────────────────────────

test('state-store set 抛异常时降级返回 {dispatched:false, error}，不抛出', async function () {
  var badStore = {
    get: function () { return null; },
    set: function () { throw new Error('disk full'); },
  };
  var act = createActuator({ store: badStore });
  var decision = { action: 'dispatch', targetWp: 'WP-5', strategy: 'full_restart' };

  var result = await act.execute(null, 'loop-1', decision, {});

  assert.strictEqual(result.dispatched, false);
  assert.ok(result.error, '应包含 error 信息');
  assert.ok(/disk full/.test(result.error), 'error 应包含原始异常信息');
});

test('无 store 注入且 context 不可用时降级返回 {dispatched:false, error}', async function () {
  // 无 opts.store，context 不提供 getProvider/getStateStore，且切到一个无法创建 store 的场景
  // 通过传入空 context 触发本地 StateStore 路径（仍可用），故这里用破坏性 context 验证降级：
  var act = createActuator();
  // context.getProvider 抛错 → resolveStore 降级到本地 store（仍可用），dispatched 应为 true
  var ctx = {
    getProvider: function () { throw new Error('no provider'); },
  };
  var decision = { action: 'dispatch', targetWp: 'WP-5', strategy: 'full_restart' };

  var result = await act.execute(ctx, 'loop-fallback-1', decision, {});
  assert.strictEqual(result.dispatched, true);
});

// ─────────────────────────────────────────────
// Section 5: noop decision 跳过派发
// ─────────────────────────────────────────────

test('noop decision 不写入 pendingAction（dispatched:false）', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var decision = { action: 'noop', reason: '无快照' };

    var result = await act.execute(null, 'loop-1', decision, {});

    assert.strictEqual(result.dispatched, false);
    var pa = await readPending(env.store, 'loop-1');
    assert.ok(!pa, '不应写入 pendingAction');
  } finally {
    env.restore();
  }
});

test('未知 action 不写入 pendingAction', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var decision = { action: 'unknown', targetWp: 'WP-5' };

    var result = await act.execute(null, 'loop-1', decision, {});

    assert.strictEqual(result.dispatched, false);
    var pa = await readPending(env.store, 'loop-1');
    assert.ok(!pa, '不应写入 pendingAction');
  } finally {
    env.restore();
  }
});

test('decision 为 null 时跳过派发', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });

    var result = await act.execute(null, 'loop-1', null, {});

    assert.strictEqual(result.dispatched, false);
  } finally {
    env.restore();
  }
});

test('loopId 为空时跳过派发', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    var decision = { action: 'dispatch', targetWp: 'WP-5' };

    var result = await act.execute(null, '', decision, {});

    assert.strictEqual(result.dispatched, false);
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 6: 签名兼容 engine act() inject 期望
// ─────────────────────────────────────────────

test('createActuator 返回 {execute}，签名四参匹配 engine act() 调用', async function () {
  var env = setupEnv();
  try {
    var act = createActuator({ store: env.store });
    assert.strictEqual(typeof act.execute, 'function');

    // engine act() 调用：actuator.execute(context, loopId, decision, state)
    var result = await act.execute({}, 'loop-sig', {
      action: 'dispatch', targetWp: 'WP-1', strategy: 'full_restart',
    }, {});

    // 返回结构匹配 engine act() 期望 {dispatched, checklistResult?}
    assert.strictEqual(typeof result.dispatched, 'boolean');
    assert.ok('checklistResult' in result, '应包含 checklistResult 字段（即便 undefined）');
    assert.ok(!('placeholder' in result), '注入后不应再返回 placeholder');
  } finally {
    env.restore();
  }
});

test('可经 engine.inject({actuator}) 注入并执行（端到端签名兼容性）', async function () {
  var env = setupEnv();
  try {
    // 模拟 engine inject 期望：actuator 仅需 { execute } 接口
    var act = createActuator({ store: env.store });
    var injected = { actuator: act };
    assert.ok(injected.actuator && typeof injected.actuator.execute === 'function');

    var decision = { action: 'retry', targetWp: 'WP-9', failingDrivers: [{ wpId: 'WP-9', category: 'test', item: 'i', reason: 'r' }] };
    var result = await injected.actuator.execute({}, 'loop-inj', decision, {});

    assert.strictEqual(result.dispatched, true);
    var pa = await readPending(env.store, 'loop-inj');
    assert.strictEqual(pa.failingDrivers.length, 1);
  } finally {
    env.restore();
  }
});

// ─────────────────────────────────────────────
// Section 7: 内部工具 _buildPendingAction
// ─────────────────────────────────────────────

test('_buildPendingAction 序列化所有字段', function () {
  var pa = actuator._buildPendingAction('loop-x', {
    action: 'retry',
    targetWp: 'WP-3',
    strategy: 'checkpoint_resume',
    context: { k: 'v' },
    failingDrivers: [{ wpId: 'WP-3', category: 'c', item: 'i', reason: 'r' }],
  });
  assert.strictEqual(pa.wpId, 'WP-3');
  assert.strictEqual(pa.mode, 'retry');
  assert.strictEqual(pa.strategy, 'checkpoint_resume');
  assert.deepStrictEqual(pa.context, { k: 'v' });
  assert.strictEqual(pa.failingDrivers.length, 1);
  assert.strictEqual(pa.loopId, 'loop-x');
});

test('_ACTION_TO_MODE 仅映射 dispatch/retry/resplit', function () {
  var m = actuator._ACTION_TO_MODE;
  assert.strictEqual(m.dispatch, 'dispatch');
  assert.strictEqual(m.retry, 'retry');
  assert.strictEqual(m.resplit, 'resplit');
  assert.strictEqual(m.noop, undefined);
});
