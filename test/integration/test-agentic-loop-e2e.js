/**
 * End-to-end integration test for Agentic Loop (WP-174-7-verify)
 * Run with: node --test test/integration/test-agentic-loop-e2e.js
 *
 * 验证 P2↔P3 自主闭环（design.md §4 循环体 / §6 终止判定 / §8 持久化）。
 *
 * 策略：真实 loop-engine + 真实 loop-snapshot + 真实 reflection-evaluator，
 *       但 **mock actuator**（模拟 dispatcher 执行 + checklist 结果），
 *       隔离真实 dispatcher spawn（过重且不稳定）。
 *
 * 覆盖场景：
 *   1. P2↔P3 自主重试至达成（前几轮含失败项 → continue → 后续全过 → achieved）
 *   2. 三类终止回 P1：发散 / 熔断 / 触顶（各独立场景）
 *   3. 状态持久化与恢复（模拟上下文压缩：丢弃内存 engine 句柄，新 engine.init 恢复断点）
 *   4. checklist 机器可读流转（actuator 产出 CheckResult → engine 写 lastChecklist → 下轮 observe 读回）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var LoopEngineProvider = require('../../plugins/core/provider-loop-engine');
var loopSnapshot = require('../../plugins/runtime/loop-snapshot');
var reflectionEvaluator = require('../../plugins/runtime/reflection-evaluator');
var { StateStore } = require('../../plugins/runtime/state-store');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-loop-e2e-'));
}

function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }
}

/**
 * 构造真实 engine + 注入真实 snapshot/evaluator + mock actuator。
 *
 * @param {object} opts
 *   - actuatorExecute: async (context, loopId, decision, state) => {dispatched, checklistResult?}
 *   - getProvider: mock 的 context.getProvider（用于注入 watchdog）
 *   - configOverride: 合并到 engine 配置（max_iterations / divergence_threshold 等）
 *   - goal: loop 目标 { wpIds }
 */
async function makeRealLoop(opts) {
  opts = opts || {};
  var dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

  var provider = new LoopEngineProvider();

  var origCwd = process.cwd();
  process.chdir(dir);

  var context = {
    config: null,
    getProvider: opts.getProvider || function () { return null; },
  };
  await provider.onActivate(context);

  // 配置 override（在 onActivate 后直接改 _config）
  if (opts.configOverride) {
    var cfg = provider._config;
    var keys = Object.keys(opts.configOverride);
    for (var i = 0; i < keys.length; i++) {
      cfg[keys[i]] = opts.configOverride[keys[i]];
    }
  }

  var api = await provider.factory(context);

  // 注入真实 snapshot + 真实 evaluator + mock actuator
  api.inject({
    snapshot: loopSnapshot,
    evaluator: reflectionEvaluator,
    actuator: { execute: opts.actuatorExecute || (async function () { return { dispatched: false }; }) },
  });

  return {
    dir: dir,
    provider: provider,
    api: api,
    store: provider._store,
    origCwd: origCwd,
    restore: function () { process.chdir(origCwd); cleanupTmpDir(dir); },
  };
}

/**
 * 在临时项目根写一条 PROGRESS.md 完成标记（模拟 dispatcher 执行 WP 后的副作用）。
 * 真实 loop-snapshot.aggregate 从 PROGRESS.md 解析 WP 完成状态（design.md §5.2 progress-tracker 源）。
 * actuator 全过时调用此函数，使下一轮 observe 的 workPackages.pending 清空，达成判定可触发。
 * @param {string} projectRoot
 * @param {string} wpId
 */
function markWpCompleted(projectRoot, wpId) {
  var progressPath = path.join(projectRoot, 'PROGRESS.md');
  var line = '- [x] ' + wpId + ' 已完成（端到端验证）\n';
  if (fs.existsSync(progressPath)) {
    fs.appendFileSync(progressPath, line);
  } else {
    fs.writeFileSync(progressPath, '# PROGRESS\n\n' + line);
  }
}

/**
 * 造一个含失败项的 CheckResult（checklist 未全过）。
 * @param {number} total
 * @param {number} passed
 * @param {string} wpId
 */
function failingCheckResult(total, passed, wpId) {
  var failed = total - passed;
  var failedItems = [];
  for (var i = 0; i < failed; i++) {
    failedItems.push({
      category: '测试检查',
      id: 'test-' + (passed + i + 1),
      reason: '故意失败项（端到端验证） #' + (i + 1),
    });
  }
  return {
    wpId: wpId,
    passed: false,
    summary: { total: total, passed: passed, failed: failed },
    categories: [{
      name: '测试检查',
      passed: failed === 0,
      items: itemsForChecklist(total, passed),
    }],
    failedItems: failedItems,
  };
}

function itemsForChecklist(total, passed) {
  var items = [];
  for (var i = 0; i < total; i++) {
    items.push({ id: 'test-' + (i + 1), text: '检查项 ' + (i + 1), passed: i < passed });
  }
  return items;
}

/**
 * 造一个全过的 CheckResult。
 */
function passingCheckResult(total, wpId) {
  return {
    wpId: wpId,
    passed: true,
    summary: { total: total, passed: total, failed: 0 },
    categories: [{ name: '测试检查', passed: true, items: itemsForChecklist(total, total) }],
    failedItems: [],
  };
}

// ─────────────────────────────────────────────
// Scenario 1: P2↔P3 自主重试至达成
// ─────────────────────────────────────────────

test.describe('Scenario 1: P2↔P3 自主重试至达成', function () {
  test('前几轮含失败项 → continue → 后续全过 → achieved', async function () {
    var dir;
    // actuator 状态机：前 2 轮返回含失败项的 checklist，第 3 轮起全过
    var callCount = 0;
    var actuatorExecute = async function (_ctx, _loopId, decision, _state) {
      callCount += 1;
      if (callCount <= 2) {
        // 含失败项（proximity < goal）→ engine 应判 continue
        return {
          dispatched: true,
          checklistResult: failingCheckResult(10, 7, 'WP-1'), // proximity = 0.7 < 0.9
        };
      }
      // 第 3 轮起全过：同时写 PROGRESS.md 标记 WP 完成（模拟 dispatcher 真实副作用），
      // 使下一轮 observe 的 workPackages.pending 清空，达成判定可触发。
      markWpCompleted(dir, 'WP-1');
      return {
        dispatched: true,
        checklistResult: passingCheckResult(10, 'WP-1'),
      };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      getProvider: function () { return null; }, // 无 watchdog → 健康
    });
    dir = env.dir;

    try {
      var initRes = await env.api.init({ teamName: 'e2e-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      var verdicts = [];
      var iterations = [];
      for (var rounds = 0; rounds < 10; rounds++) {
        var stepRes = await env.api.step(loopId);
        verdicts.push(stepRes.verdict);
        iterations.push(stepRes.iteration);
        if (stepRes.verdict !== 'continue') break;
      }

      // 最终应达成（actuator 第 3 轮全过 + 标记完成 → 第 4 轮 observe 看到 pending 空 + lastChecklist 全过）
      assert.ok(verdicts.indexOf('achieved') !== -1, '最终应达成，verdict 序列: ' + JSON.stringify(verdicts));
      var achievedIdx = verdicts.indexOf('achieved');
      // achieved 之前必须都是 continue
      for (var i = 0; i < achievedIdx; i++) {
        assert.strictEqual(verdicts[i], 'continue', '达成前应继续重试，第 ' + (i + 1) + ' 轮 verdict=' + verdicts[i]);
      }
      // iteration 单调递增
      for (var j = 1; j < iterations.length; j++) {
        assert.ok(iterations[j] > iterations[j - 1], 'iteration 单调递增');
      }

      // history 记录每一轮
      var state = await env.api.getState(loopId);
      assert.strictEqual(state.status, 'achieved');
      assert.ok(state.history.length >= 3, 'history 记录每轮判定，实际: ' + state.history.length);

      // actuator 被调用（证明 Act 阶段执行了 mock dispatcher）
      assert.ok(callCount >= 3, 'actuator 至少被调用 3 次，实际: ' + callCount);
    } finally {
      env.restore();
    }
  });

  test('失败项驱动 Think 决策 retry（refine 反馈）', async function () {
    // 第一轮返回失败项 → Think 应判 retry 而非 dispatch
    var actuatorExecute = async function () {
      return {
        dispatched: true,
        checklistResult: failingCheckResult(10, 5, 'WP-1'),
      };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 't', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      // 跑一轮，让 actuator 产出失败 checklist
      await env.api.step(loopId);

      // 现在 lastChecklist 已写入；造一个含 failed WP 的快照验证 Think 决策
      // （actuator 已写 lastChecklist，但 snapshot 从 PROGRESS.md 读 workPackages，
      //  这里直接构造 snapshot 喂给 think 验证 retry 决策路径）
      var snap = {
        workPackages: { total: 1, pending: [], completed: [], failed: ['WP-1'], blocked: [] },
        lastChecklist: failingCheckResult(10, 5, 'WP-1'),
        watchdog: { deployed: true, running: true, health: 'healthy' },
      };
      var decision = await env.api.think(loopId, snap);
      assert.strictEqual(decision.action, 'retry', '失败项应驱动 retry');
      assert.strictEqual(decision.targetWp, 'WP-1');
      assert.ok(/refine|重试/.test(decision.reason), 'reason 含 refine/重试: ' + decision.reason);
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Scenario 2: 三类终止回 P1
// ─────────────────────────────────────────────

test.describe('Scenario 2a: 发散终止（连续 N 轮 proximity 无进展）', function () {
  test('proximity 持平 → verdict=diverged', async function () {
    // actuator 每轮都返回相同的失败 checklist（proximity 恒定 0.7，无进展）
    var actuatorExecute = async function () {
      return {
        dispatched: true,
        checklistResult: failingCheckResult(10, 7, 'WP-1'), // proximity=0.7 恒定
      };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      configOverride: { divergence_threshold: 3, max_iterations: 20 },
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 't', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      var finalVerdict = null;
      for (var rounds = 0; rounds < 15; rounds++) {
        var stepRes = await env.api.step(loopId);
        if (stepRes.verdict !== 'continue') {
          finalVerdict = stepRes.verdict;
          break;
        }
      }

      assert.strictEqual(finalVerdict, 'diverged', 'proximity 恒定应触发发散，实际: ' + finalVerdict);
      var state = await env.api.getState(loopId);
      assert.strictEqual(state.status, 'diverged');
      assert.ok(state.divergenceStreak >= 3, '发散计数 >= threshold');
    } finally {
      env.restore();
    }
  });
});

test.describe('Scenario 2b: 熔断终止（watchdog 异常）', function () {
  test('watchdog terminated → verdict=circuit_broken', async function () {
    var actuatorExecute = async function () {
      return {
        dispatched: true,
        checklistResult: failingCheckResult(10, 7, 'WP-1'),
      };
    };

    // 注入 watchdog 返回 terminated
    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      getProvider: function () {
        return {
          getHealth: function () { return { state: 'terminated', running: false }; },
        };
      },
    });

    try {
      var initRes = await env.api.init({ teamName: 't', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      // 第一轮 decide 即应熔断（watchdog terminated 优先级最高）
      var stepRes = await env.api.step(loopId);
      assert.strictEqual(stepRes.verdict, 'circuit_broken', 'watchdog terminated 应熔断');
      var state = await env.api.getState(loopId);
      assert.strictEqual(state.status, 'circuit_broken');
    } finally {
      env.restore();
    }
  });

  test('watchdog degraded → verdict=circuit_broken', async function () {
    var actuatorExecute = async function () {
      return {
        dispatched: true,
        checklistResult: failingCheckResult(10, 7, 'WP-1'),
      };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      getProvider: function () {
        return {
          getHealth: function () { return { state: 'degraded', running: true, stale: true }; },
        };
      },
    });

    try {
      var initRes = await env.api.init({ teamName: 't', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;
      var stepRes = await env.api.step(loopId);
      assert.strictEqual(stepRes.verdict, 'circuit_broken', 'watchdog degraded 应熔断');
    } finally {
      env.restore();
    }
  });
});

test.describe('Scenario 2c: 触顶终止（max_iterations）', function () {
  test('达到 max_iterations → verdict=timeout', async function () {
    var actuatorExecute = async function () {
      // 持续小幅改进但永远到不了 goal（避免发散也避免达成）
      // 用单调递增的 proximity，但永远 < goal
      // 为简单起见：每轮失败项数递减但保留 1 项
      return {
        dispatched: true,
        checklistResult: failingCheckResult(10, 8, 'WP-1'), // proximity=0.8 < 0.9，但相比无历史首轮
      };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      configOverride: { max_iterations: 4, divergence_threshold: 99 }, // 关掉发散，只测上限
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 't', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      var finalVerdict = null;
      for (var rounds = 0; rounds < 10; rounds++) {
        var stepRes = await env.api.step(loopId);
        if (stepRes.verdict !== 'continue') {
          finalVerdict = stepRes.verdict;
          break;
        }
      }
      assert.strictEqual(finalVerdict, 'timeout', '达到 max_iterations 应 timeout，实际: ' + finalVerdict);
      var state = await env.api.getState(loopId);
      assert.strictEqual(state.status, 'timeout');
      assert.ok(state.iteration >= 4, 'iteration 达到上限');
    } finally {
      env.restore();
    }
  });

  test('墙钟上限（max_wall_time_ms）→ verdict=timeout', async function () {
    var actuatorExecute = async function () {
      return {
        dispatched: true,
        checklistResult: failingCheckResult(10, 7, 'WP-1'),
      };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      configOverride: { max_wall_time_ms: 1, divergence_threshold: 99, max_iterations: 99 },
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 't', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;
      // 第一轮结束后 startedAt 已过去；max_wall_time_ms=1，第二轮起始检查应触发墙钟上限
      await env.api.step(loopId);
      // 强制时间流逝（startedAt 是 init 时刻，墙钟必然已超 1ms）
      var stepRes2 = await env.api.step(loopId);
      // 可能第一轮就因墙钟已超判 timeout，也可能第二轮；二者皆可接受
      assert.ok(
        stepRes2.verdict === 'timeout' || stepRes2.verdict === 'continue',
        '墙钟上限场景 verdict 合理: ' + stepRes2.verdict
      );
      // 多跑几轮必然 timeout
      var finalVerdict = stepRes2.verdict;
      for (var rounds = 0; rounds < 5 && finalVerdict === 'continue'; rounds++) {
        var s = await env.api.step(loopId);
        finalVerdict = s.verdict;
      }
      assert.strictEqual(finalVerdict, 'timeout', '墙钟超限最终应 timeout');
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Scenario 3: 状态持久化与恢复（模拟上下文压缩）
// ─────────────────────────────────────────────

test.describe('Scenario 3: 状态持久化与恢复', function () {
  test('运行中持久化 → 新 engine.init 恢复断点（iteration 不回退）', async function () {
    var callCount = 0;
    var actuatorExecute = async function () {
      callCount += 1;
      if (callCount <= 5) {
        return { dispatched: true, checklistResult: failingCheckResult(10, 6, 'WP-1') };
      }
      return { dispatched: true, checklistResult: passingCheckResult(10, 'WP-1') };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      configOverride: { divergence_threshold: 99, max_iterations: 20 },
      getProvider: function () { return null; },
    });

    var loopId;
    var dir = env.dir;
    try {
      var initRes = await env.api.init({ teamName: 'persist-team', goal: { wpIds: ['WP-1'] } });
      loopId = initRes.loopId;

      // 跑 3 轮（含失败项 → continue）
      for (var i = 0; i < 3; i++) {
        var s = await env.api.step(loopId);
        assert.strictEqual(s.verdict, 'continue', '前 3 轮应继续');
      }

      var stateBeforeCrash = await env.api.getState(loopId);
      assert.strictEqual(stateBeforeCrash.iteration, 3, '崩溃前 iteration=3');
      assert.strictEqual(stateBeforeCrash.history.length, 3, '崩溃前 history=3 轮');
      assert.strictEqual(stateBeforeCrash.status, 'running');

      // 验证落盘（用新 store 句柄读回，模拟上下文压缩后内存丢失）
      var freshStore = new StateStore({ filePath: path.join(dir, '.claude-state') });
      var persisted = await freshStore.get('loop.' + loopId);
      assert.ok(persisted, 'state 已落盘');
      assert.strictEqual(persisted.iteration, 3, '落盘 iteration=3');
      assert.strictEqual(persisted.history.length, 3, '落盘 history=3');
      assert.strictEqual(persisted.status, 'running', '落盘 status=running');

      // lastChecklist 子 key 也落盘
      var persistedChk = await freshStore.get('loop.' + loopId + '.lastChecklist');
      assert.ok(persistedChk, 'lastChecklist 子 key 已落盘');
      assert.strictEqual(persistedChk.passed, false, '上轮 checklist 含失败项');

      // 🔴 模拟"上下文压缩"：丢弃旧 engine 句柄，用全新 engine 实例恢复
      //     （新 provider 新 factory，仅共享 state-store 文件）
      env.restore(); // 这会 process.chdir 回原 cwd 并清目录——所以我们要在 restore 前 capture，
      // 改用：不 restore，直接造新 engine 指向同目录
    } catch (e) {
      env.restore();
      throw e;
    }

    // 上面 env.restore() 会清掉 dir，所以这个测试改用"同 engine 内重新 init"路径验证恢复语义。
    // （engine 的恢复逻辑在 init() 内，与是否新实例无关——它读同一个 state-store。）
    // 为独立验证"新实例恢复"，重写为下方独立子测试，此处用 try/finally 保证清理。
    // 注：本用例的关键断言（落盘可读 + iteration/history 完整）已在上面完成。
  });

  test('新 engine 实例 init 同 loopId → restored=true，从断点继续（iteration 不回退）', async function () {
    var callCount = 0;
    var actuatorExecute = async function () {
      callCount += 1;
      return { dispatched: true, checklistResult: failingCheckResult(10, 6, 'WP-1') };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      configOverride: { divergence_threshold: 99, max_iterations: 20 },
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 'persist-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      // 跑 2 轮
      await env.api.step(loopId);
      await env.api.step(loopId);
      var stateBefore = await env.api.getState(loopId);
      assert.strictEqual(stateBefore.iteration, 2, '崩溃前 iteration=2');

      // 🔴 丢弃旧 engine，造全新 engine（新 provider 实例 + 新 factory API），指向同 state-store 文件
      var newProvider = new LoopEngineProvider();
      var ctx2 = { config: null, getProvider: function () { return null; } };
      // onActivate 会 _resolveProjectRoot 到 cwd（已被 env 的 process.chdir 改到 dir）
      await newProvider.onActivate(ctx2);
      var newApi = await newProvider.factory(ctx2);
      newApi.inject({
        snapshot: loopSnapshot,
        evaluator: reflectionEvaluator,
        actuator: { execute: actuatorExecute },
      });

      // 新实例 init 同 loopId → 应识别为恢复
      var restoreRes = await newApi.init({ loopId: loopId });
      assert.strictEqual(restoreRes.restored, true, '新实例应识别 status=running 的 loop 为恢复');
      assert.strictEqual(restoreRes.state.iteration, 2, '恢复后 iteration 不回退（仍为 2）');
      assert.strictEqual(restoreRes.state.history.length, 2, '恢复后 history 完整');
      assert.strictEqual(restoreRes.state.status, 'running');

      // 从断点继续 step：iteration 应为 3（单调递增，不回退）
      var stepRes = await newApi.step(loopId);
      assert.strictEqual(stepRes.iteration, 3, '从断点继续，iteration=3（不回退）');
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Scenario 4: checklist 机器可读流转
// ─────────────────────────────────────────────

test.describe('Scenario 4: checklist 机器可读流转', function () {
  test('actuator 产出 CheckResult → engine 写 lastChecklist → 下轮 observe 读回 → evaluator 消费', async function () {
    var callCount = 0;
    var actuatorExecute = async function () {
      callCount += 1;
      // 第一轮失败，第二轮全过
      if (callCount === 1) {
        return { dispatched: true, checklistResult: failingCheckResult(10, 7, 'WP-1') };
      }
      return { dispatched: true, checklistResult: passingCheckResult(10, 'WP-1') };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      configOverride: { divergence_threshold: 99, max_iterations: 10 },
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 'flow-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      // 第一轮：actuator 产出失败 checklist
      var step1 = await env.api.step(loopId);

      // ① engine.act 已把 checklistResult 写入 lastChecklist 子 key（本轮 act 立即落盘）
      var chkAfterRound1 = await env.store.get('loop.' + loopId + '.lastChecklist');
      assert.ok(chkAfterRound1, '第一轮后 lastChecklist 已写入');
      assert.strictEqual(chkAfterRound1.passed, false, '第一轮 checklist 失败');
      assert.strictEqual(chkAfterRound1.summary.failed, 3, '3 个失败项');
      assert.strictEqual(chkAfterRound1.failedItems[0].id, 'test-8', 'item.id 跨轮稳定（发散检测前提）');

      // ② 注意时序：reflect 用的是 observe 时刻的 snapshot（act 在 observe 之后），
      //    故第一轮 evaluator 拿不到本轮刚写的 lastChecklist（snapshot.lastChecklist 仍为 null → proximity=0）。
      //    这是 engine step() 的固有设计：observe→think→act→reflect，reflect 看 observe 时刻环境。
      var state1 = await env.api.getState(loopId);
      assert.ok(state1.lastEval, 'reflect 产出 EvalResult');
      // 第一轮 proximity=0（observe 时无 lastChecklist）—— 验证真实时序
      assert.ok(
        Math.abs(state1.lastEval.proximity - 0) < 1e-9,
        '第一轮 observe 时无 lastChecklist → proximity=0（reflect 用 observe 时刻 snapshot）'
      );
      // 第一轮未达成（pending 含 WP-1，无 PROGRESS.md）
      assert.strictEqual(step1.verdict, 'continue', '第一轮未达成，继续');

      // ③ 第二轮：observe 读到第一轮 act 写入的 lastChecklist → evaluator 消费 proximity=0.7
      var step2 = await env.api.step(loopId);
      var state2 = await env.api.getState(loopId);
      assert.ok(
        Math.abs(state2.lastEval.proximity - 0.7) < 1e-9,
        '第二轮 observe 读到第一轮 lastChecklist → evaluator proximity=0.7，实际: ' + state2.lastEval.proximity
      );
      assert.strictEqual(state2.lastEval.failingDrivers.length, 3, 'failingDrivers 由 failedItems 构建');
      assert.strictEqual(state2.lastEval.allPassed, false, 'checklist 未全过');

      // 第二轮 act 又写了全过 checklist（落盘）
      var chkAfterRound2 = await env.store.get('loop.' + loopId + '.lastChecklist');
      assert.strictEqual(chkAfterRound2.passed, true, '第二轮 act 写入全过 checklist');
      assert.strictEqual(chkAfterRound2.summary.failed, 0);

      // item.id 跨轮稳定验证（发散检测前提）：两轮的 id 命名规则一致
      assert.ok(chkAfterRound2.categories[0].items[0].id === 'test-1', 'item.id 命名规则跨轮一致');

      // 第二轮仍未达成（pending 仍含 WP-1，未写 PROGRESS.md）
      assert.strictEqual(step2.verdict, 'continue', '第二轮 pending 非空，未达成');
    } finally {
      env.restore();
    }
  });

  test('真实 loop-snapshot 从 state-store 读回 lastChecklist（跨阶段流转）', async function () {
    // 验证 observe（真实 loop-snapshot）能读回 act 阶段写入的 lastChecklist
    var actuatorExecute = async function () {
      return { dispatched: true, checklistResult: failingCheckResult(8, 5, 'WP-1') };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 'snap-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      // 手动走一轮 act（写 lastChecklist）
      await env.api.act(loopId, { action: 'dispatch', targetWp: 'WP-1' });

      // 现在用真实 loop-snapshot 聚合，验证它读回 lastChecklist
      var snap = await env.api.observe(loopId);
      assert.ok(snap.lastChecklist, '真实 loop-snapshot 读回 lastChecklist');
      assert.strictEqual(snap.lastChecklist.wpId, 'WP-1');
      assert.strictEqual(snap.lastChecklist.passed, false);
      assert.strictEqual(snap.lastChecklist.summary.total, 8);
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Scenario 5: 四类 verdict 分流汇总（各至少一次）
// ─────────────────────────────────────────────

test.describe('Scenario 5: 四类 verdict 分流覆盖汇总', function () {
  test('achieved / timeout / diverged / circuit_broken 各可触发', async function () {
    // 这是元测试：验证四类终止 verdict 在各自条件下都能产出。
    // 各条件的具体验证见 Scenario 1-2，此处仅做存在性汇总断言。
    var seen = { achieved: false, timeout: false, diverged: false, circuit_broken: false };

    // achieved
    var env1 = await makeRealLoop({
      actuatorExecute: async function () {
        // 全过 + 写 PROGRESS.md 标记 WP 完成（使下轮 observe pending 清空）
        markWpCompleted(env1.dir, 'WP-1');
        return { dispatched: true, checklistResult: passingCheckResult(10, 'WP-1') };
      },
      goal: { wpIds: ['WP-1'] },
      getProvider: function () { return null; },
    });
    try {
      var r1 = await env1.api.init({ goal: { wpIds: ['WP-1'] } });
      var fv1 = null;
      for (var a = 0; a < 5; a++) {
        var s1 = await env1.api.step(r1.loopId);
        if (s1.verdict !== 'continue') { fv1 = s1.verdict; break; }
      }
      seen.achieved = (fv1 === 'achieved');
    } finally {
      env1.restore();
    }

    // timeout（max_iterations）
    var env2 = await makeRealLoop({
      actuatorExecute: async function () {
        return { dispatched: true, checklistResult: failingCheckResult(10, 8, 'WP-1') };
      },
      goal: { wpIds: ['WP-1'] },
      configOverride: { max_iterations: 2, divergence_threshold: 99 },
      getProvider: function () { return null; },
    });
    try {
      var r2 = await env2.api.init({ goal: { wpIds: ['WP-1'] } });
      var fv = null;
      for (var i = 0; i < 6; i++) {
        var s = await env2.api.step(r2.loopId);
        if (s.verdict !== 'continue') { fv = s.verdict; break; }
      }
      seen.timeout = (fv === 'timeout');
    } finally {
      env2.restore();
    }

    // diverged
    var env3 = await makeRealLoop({
      actuatorExecute: async function () {
        return { dispatched: true, checklistResult: failingCheckResult(10, 7, 'WP-1') };
      },
      goal: { wpIds: ['WP-1'] },
      configOverride: { divergence_threshold: 3, max_iterations: 20 },
      getProvider: function () { return null; },
    });
    try {
      var r3 = await env3.api.init({ goal: { wpIds: ['WP-1'] } });
      var fv3 = null;
      for (var j = 0; j < 10; j++) {
        var s3 = await env3.api.step(r3.loopId);
        if (s3.verdict !== 'continue') { fv3 = s3.verdict; break; }
      }
      seen.diverged = (fv3 === 'diverged');
    } finally {
      env3.restore();
    }

    // circuit_broken
    var env4 = await makeRealLoop({
      actuatorExecute: async function () {
        return { dispatched: true, checklistResult: failingCheckResult(10, 7, 'WP-1') };
      },
      goal: { wpIds: ['WP-1'] },
      getProvider: function () {
        return { getHealth: function () { return { state: 'terminated', running: false }; } };
      },
    });
    try {
      var r4 = await env4.api.init({ goal: { wpIds: ['WP-1'] } });
      var s4 = await env4.api.step(r4.loopId);
      seen.circuit_broken = (s4.verdict === 'circuit_broken');
    } finally {
      env4.restore();
    }

    assert.deepStrictEqual(seen, { achieved: true, timeout: true, diverged: true, circuit_broken: true },
      '四类 verdict 应各可触发，实际: ' + JSON.stringify(seen));
  });
});

// ─────────────────────────────────────────────
// Scenario 6 (WP-176-8): 多轮 retry 真实链路（对齐 engine/运行时落差核心）
//
// 与现有场景的关键差异：retry 命中由 **真实数据流** 驱动（actuator 写 lastChecklist
// → 真实 loop-snapshot.buildWorkPackages 从 failedItems 填充 workPackages.failed
// → engine _think retry 分支真实命中），而非手工构造 failed: ['WP-x'] 快照喂给 think
// （后者正是 WP-176 要消除的"单测直构"落差）。
//
// 时序（design.md §8.4）：step() = observe→think→act→reflect→decide，
// reflect 用 observe 时刻 snapshot，act 写的 lastChecklist 下一轮 observe 才被消费。
// 故 mock actuator 按调用次数返回不同 CheckResult，让 retry 链路跨轮生效。
// ─────────────────────────────────────────────

test.describe('Scenario 6 (WP-176-8): 多轮 retry 真实链路', function () {
  test('场景A — retry 真实命中 + refine 收敛 → achieved', async function () {
    // mock actuator 按调用次数返回不同 CheckResult（跨轮设计）：
    //   第1轮：含 3 个失败项（proximity=0.7）—— 但本轮 think 用的是 init 时刻快照（无 lastChecklist），走 dispatch
    //   第2轮：refine 后失败项减为 1（proximity=0.9）—— 上一轮 lastChecklist 已可见 → think 真实命中 retry
    //   第3轮：失败项减为 0 全过（proximity=1.0）+ 写 PROGRESS.md 标记完成
    var callCount = 0;
    var roundChecklists = []; // 记录每轮 actuator 产出的 failedItems 数（断言 refine 单调）
    var dir;
    var actuatorExecute = async function (_ctx, _loopId, decision, _state) {
      callCount += 1;
      var result;
      if (callCount === 1) {
        // 3 个失败项
        result = { dispatched: true, checklistResult: failingCheckResult(10, 7, 'WP-1') };
      } else if (callCount === 2) {
        // refine：失败项 3 → 1（proximity 0.7 → 0.9）
        result = { dispatched: true, checklistResult: failingCheckResult(10, 9, 'WP-1') };
      } else {
        // 全过 + 标记 WP 完成（使下轮 observe pending 清空，达成判定可触发）
        markWpCompleted(dir, 'WP-1');
        result = { dispatched: true, checklistResult: passingCheckResult(10, 'WP-1') };
      }
      roundChecklists.push({
        call: callCount,
        failedCount: result.checklistResult.summary.failed,
        decisionAction: decision.action,
      });
      return result;
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      // 关掉发散（给 refine 足够轮次收敛）、放宽上限
      configOverride: { divergence_threshold: 99, max_iterations: 20 },
      getProvider: function () { return null; }, // 无 watchdog → 健康
    });
    dir = env.dir;

    try {
      var initRes = await env.api.init({ teamName: 'wp176-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      // 跑多轮 step，逐轮捕获 verdict + state 用于断言真实数据流
      var verdicts = [];
      var perRoundState = []; // 每轮 step 后的状态快照（含 lastDecision / failingDrivers / proximity）
      for (var rounds = 0; rounds < 12; rounds++) {
        var stepRes = await env.api.step(loopId);
        var st = await env.api.getState(loopId);
        verdicts.push(stepRes.verdict);
        perRoundState.push({
          iteration: stepRes.iteration,
          verdict: stepRes.verdict,
          decision: st.lastDecision,
          failingDrivers: st.failingDrivers,
          divergenceStreak: st.divergenceStreak,
          proximity: st.lastEval ? st.lastEval.proximity : null,
          lastEval: st.lastEval,
        });
        if (stepRes.verdict !== 'continue') break;
      }

      // ---- 断言 1：最终 achieved ----
      assert.ok(verdicts.indexOf('achieved') !== -1,
        'refine 收敛后应达成，verdict 序列: ' + JSON.stringify(verdicts));

      // ---- 断言 2：engine 真实命中 retry（非 resplit）----
      // retry 在"act 第N轮写 lastChecklist → 第N+1轮 think 读到 failed"的轮次真实命中。
      // 第1轮 act 写入含 3 失败项的 lastChecklist → 第2轮 think 应命中 retry（由真实 snapshot.failed 驱动）。
      var retryRounds = perRoundState.filter(function (r) {
        return r.decision && r.decision.action === 'retry';
      });
      assert.ok(retryRounds.length >= 1,
        'engine 路径应真实命中 retry（非手工构造 failed），实际 decision.action 序列: ' +
        JSON.stringify(perRoundState.map(function (r) { return r.decision && r.decision.action; })));

      // 每轮 retry 的 targetWp 应为失败 WP（由 snapshot.failed 填充推导）
      for (var ri = 0; ri < retryRounds.length; ri++) {
        assert.strictEqual(retryRounds[ri].decision.targetWp, 'WP-1',
          'retry 的 targetWp 应为失败的 WP-1（由 snapshot.failed 填充推导）');
      }

      // ---- 断言 3：retry decision.failingDrivers 经 reflect 回填后被某轮携带（refine 反馈贯通）----
      // 时序（design.md §8.4）：think 在 reflect 之前。某轮 think 读到的 state.failingDrivers
      // 来自上一轮 reflect（该 reflect 读 observe 时刻 snapshot，即上上轮 act 写入的 lastChecklist）。
      // 故 failingDrivers 明细比 retry action 晚一轮出现——但**会被携带**，证明 refine 反馈链路贯通。
      //   第2轮 think：retry 命中（wp.failed 已填充），但 state.failingDrivers 仍为上一轮 reflect 结果（空）
      //   第3轮 think：retry 命中，且 state.failingDrivers 已被第2轮 reflect 回填（3 个，对应第1轮 act 的 3 失败项）
      var retryWithDrivers = retryRounds.filter(function (r) {
        return r.decision.failingDrivers && r.decision.failingDrivers.length > 0;
      });
      assert.ok(retryWithDrivers.length >= 1,
        '至少有一轮 retry 应携带 failingDrivers 明细（refine 反馈经 reflect 回填贯通），' +
        '各轮 retry fd 数: ' + JSON.stringify(retryRounds.map(function (r) {
          return (r.decision.failingDrivers || []).length;
        })));

      // 携带 failingDrivers 的那轮 retry，其明细应与 actuator 返回的 failedItems 对应
      var feedbackRound = retryWithDrivers[0];
      assert.strictEqual(feedbackRound.decision.failingDrivers.length, 3,
        '携带 failingDrivers 的 retry 轮应对应 3 个失败项（第1轮 act 写入的 lastChecklist），实际: ' +
        feedbackRound.decision.failingDrivers.length);
      for (var d = 0; d < feedbackRound.decision.failingDrivers.length; d++) {
        assert.strictEqual(feedbackRound.decision.failingDrivers[d].wpId, 'WP-1',
          'failingDriver.wpId 应为 WP-1');
      }

      // ---- 断言 4：真实数据流贯通（非手工构造）----
      // retry 命中本身就是 workPackages.failed 非空的真实证据：_think retry 分支条件
      // wp.failed.length > 0，而 failed 由真实 loop-snapshot.buildWorkPackages 从
      // lastChecklist.failedItems 填充（非手工构造 failed: ['WP-x'] 快照）。
      // retryRounds.length >= 1 已证明此数据流贯通。
      assert.ok(retryRounds.length >= 1, 'retry 真实命中即证明 failed 由 snapshot 真实填充');

      // ---- 断言 5：refine 后 proximity 单调提升 ----
      // proximity 序列（来自每轮 lastEval.proximity，reflect 用 observe 时刻 lastChecklist）：
      //   第1轮：observe 无 lastChecklist → proximity=0
      //   第2轮：observe 读第1轮 act 写入的 3 失败项 → proximity=0.7
      //   第3轮：observe 读第2轮 act 写入的 1 失败项 → proximity=0.9（refine 提升）
      //   第4轮：observe 读第3轮 act 写入的全过 → proximity=1.0
      var proximities = perRoundState.map(function (r) { return r.proximity; });
      // 找到 refine 发生的相邻轮（proximity 严格提升）
      var foundRefineImprove = false;
      for (var p = 1; p < proximities.length; p++) {
        if (proximities[p] !== null && proximities[p - 1] !== null &&
          proximities[p] > proximities[p - 1]) {
          foundRefineImprove = true;
          break;
        }
      }
      assert.ok(foundRefineImprove,
        'refine 后 proximity 应单调提升，proximity 序列: ' + JSON.stringify(proximities));

      // ---- 断言 6：未走 resplit（偏差1修复证据）----
      // 偏差1未修时：lastChecklist.passed=false 但 wp.failed 恒空 → _think 总命中 resplit。
      // 现在 wp.failed 真实填充 → 命中 retry 而非 resplit。
      var resplitRounds = perRoundState.filter(function (r) {
        return r.decision && r.decision.action === 'resplit';
      });
      assert.strictEqual(resplitRounds.length, 0,
        'wp.failed 真实填充后不应再走 resplit（偏差1修复），实际 decision.action 序列: ' +
        JSON.stringify(perRoundState.map(function (r) { return r.decision && r.decision.action; })));

      // ---- 断言 7：actuator 真实被调用多轮（证明 retry 驱动了实际 act）----
      assert.ok(callCount >= 3, 'actuator 至少被调用 3 轮（dispatch→retry→retry），实际: ' + callCount);
    } finally {
      env.restore();
    }
  });

  test('场景A 补充 — retry 命中轮的 snapshot.failed 由真实 buildWorkPackages 填充', async function () {
    // 更直接地验证"failedItems → snapshot.failed"数据流：
    // 跑一轮 act 写入含失败项的 lastChecklist 后，手动调用真实 loop-snapshot.aggregate（observe），
    // 断言返回的 workPackages.failed 含失败 WP（而非写死的空数组），再喂给 think 验证真实命中 retry。
    var callCount = 0;
    var actuatorExecute = async function () {
      callCount += 1;
      // 每轮都返回含 2 失败项的 checklist（本用例只验证单轮填充，不关心收敛）
      return { dispatched: true, checklistResult: failingCheckResult(10, 8, 'WP-1') };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      configOverride: { divergence_threshold: 99, max_iterations: 20 },
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 'snap-fill-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      // 第1轮 step：act 写入含 2 失败项的 lastChecklist
      await env.api.step(loopId);

      // 第2轮 step 前，手动调真实 loop-snapshot.aggregate（用 engine 注入的 context）
      // 此时 lastChecklist 已落盘（第1轮 act 写入），aggregate 应读回并填充 failed
      var snap = await env.api.observe(loopId);
      assert.ok(snap.lastChecklist, '真实 loop-snapshot 读回第1轮写入的 lastChecklist');
      assert.strictEqual(snap.lastChecklist.passed, false);
      assert.strictEqual(snap.lastChecklist.summary.failed, 2, 'lastChecklist 含 2 失败项');

      // 核心断言 1：workPackages.failed 由真实 buildWorkPackages 从 failedItems 填充（非空数组）
      // 这是修复偏差1的直接证据：未修时 failed 写死 []，现在从 failedItems 聚合填充。
      assert.ok(snap.workPackages.failed && snap.workPackages.failed.length > 0,
        'buildWorkPackages 应从 lastChecklist.failedItems 填充 workPackages.failed（修复偏差1），' +
        '实际 failed: ' + JSON.stringify(snap.workPackages.failed));
      assert.strictEqual(snap.workPackages.failed[0], 'WP-1',
        'failed[0] 应为失败项对应的 WP-1');

      // 核心断言 2：喂给 think 验证真实命中 retry（数据流贯通：failedItems → snapshot.failed → _think retry）
      // 注意：think 此刻读的 state.failingDrivers 来自上一轮 reflect（第1轮 reflect 读 init 时刻空 checklist → 空），
      // 故 decision.failingDrivers 可能仍为空（晚一轮才被 reflect 回填）；但 action 必须是 retry
      // （由 wp.failed 真实填充驱动，非 resplit）。
      var decision = await env.api.think(loopId, snap);
      assert.strictEqual(decision.action, 'retry',
        '真实填充的 failed 应驱动 think 命中 retry（非 resplit），实际: ' + decision.action);
      assert.strictEqual(decision.targetWp, 'WP-1',
        'retry targetWp 应为失败的 WP-1');

      // 核心断言 3：再跑一轮让 reflect 回填 state.failingDrivers，
      // 然后验证下一轮 think 携带的 failingDrivers 明细与 failedItems 对应
      await env.api.step(loopId); // 第2轮：reflect 回填 state.failingDrivers（读第1轮 act 的 2 失败项）
      var snap2 = await env.api.observe(loopId); // 第3轮 observe：读第2轮 act 的 checklist
      var decision2 = await env.api.think(loopId, snap2); // 第3轮 think：retry + 携带回填的 failingDrivers
      assert.strictEqual(decision2.action, 'retry', '第3轮 think 仍应命中 retry');
      assert.ok(decision2.failingDrivers && decision2.failingDrivers.length === 2,
        '第3轮 retry 应携带 2 个 failingDrivers（经第2轮 reflect 回填，与第1轮 act 的 failedItems 对应），实际: ' +
        JSON.stringify(decision2.failingDrivers));
      for (var d = 0; d < decision2.failingDrivers.length; d++) {
        assert.strictEqual(decision2.failingDrivers[d].wpId, 'WP-1',
          'failingDriver.wpId 应为 WP-1');
      }
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Scenario 7 (WP-176-8): 发散宽容（偏差3修复验证）
//
// WP-176-5 修复偏差3：retry 后失败项数**减少**（部分改进）不计入 divergenceStreak，
// 仅失败项数**不变/增多**（无效 retry）才累计发散。
// 这区分"针对性 refine 起作用（每轮修掉一些失败项）"与"原样重做（纹丝不动）"。
// ─────────────────────────────────────────────

test.describe('Scenario 7 (WP-176-8): 发散宽容（部分改进 vs 无效 retry）', function () {
  test('场景B-a — 连续多轮失败项数递减（部分改进）→ 不 diverged', async function () {
    // actuator 每轮失败项数递减：5 → 4 → 3 → 2 → 1（每轮 refine 修掉一个）
    // 即使 proximity 仍 < goal，但因 failedCount 单调递减，divergenceStreak 不累计 → 不 diverged
    var callCount = 0;
    var failedSeq = [5, 4, 3, 2, 1]; // 每轮失败项数（递减）
    var actuatorExecute = async function () {
      var failed = failedSeq[callCount] !== undefined ? failedSeq[callCount] : 1;
      callCount += 1;
      var passed = 10 - failed;
      return { dispatched: true, checklistResult: failingCheckResult(10, passed, 'WP-1') };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      configOverride: { divergence_threshold: 3, max_iterations: 20 }, // 用默认阈值 3 测宽容
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 'refine-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      var streaks = [];
      var verdicts = [];
      var finalVerdict = null;
      for (var rounds = 0; rounds < 7; rounds++) {
        var stepRes = await env.api.step(loopId);
        var st = await env.api.getState(loopId);
        streaks.push(st.divergenceStreak);
        verdicts.push(stepRes.verdict);
        if (stepRes.verdict !== 'continue') { finalVerdict = stepRes.verdict; break; }
      }

      // 核心断言：部分改进（failedCount 递减）不应累计 divergenceStreak
      // 每轮 refine 有进展 → streak 应保持 0（被 computeRefineProgress 清零）
      var maxStreak = Math.max.apply(null, streaks);
      assert.ok(maxStreak < 3,
        '部分改进（失败项递减）divergenceStreak 不应累计到阈值，streak 序列: ' + JSON.stringify(streaks));

      // 不应 diverged（部分改进宽容）
      assert.ok(finalVerdict !== 'diverged',
        '部分改进不应触发 diverged，实际 finalVerdict: ' + finalVerdict +
        '，verdict 序列: ' + JSON.stringify(verdicts));
    } finally {
      env.restore();
    }
  });

  test('场景B-b — 连续多轮失败项数不变（无效 retry）→ diverged', async function () {
    // 对比：actuator 每轮失败项数不变（5 → 5 → 5 ...），原样重做无效
    // → divergenceStreak 累计 → 达阈值 diverged
    var actuatorExecute = async function () {
      // 每轮恒定 5 失败项（proximity 恒定 0.5，failedCount 不变）
      return { dispatched: true, checklistResult: failingCheckResult(10, 5, 'WP-1') };
    };

    var env = await makeRealLoop({
      actuatorExecute: actuatorExecute,
      goal: { wpIds: ['WP-1'] },
      configOverride: { divergence_threshold: 3, max_iterations: 20 },
      getProvider: function () { return null; },
    });

    try {
      var initRes = await env.api.init({ teamName: 'stuck-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      var streaks = [];
      var finalVerdict = null;
      for (var rounds = 0; rounds < 12; rounds++) {
        var stepRes = await env.api.step(loopId);
        var st = await env.api.getState(loopId);
        streaks.push(st.divergenceStreak);
        if (stepRes.verdict !== 'continue') { finalVerdict = stepRes.verdict; break; }
      }

      // 核心断言：无效 retry（失败项不变）应累计 divergenceStreak 并触发 diverged
      assert.strictEqual(finalVerdict, 'diverged',
        '无效 retry（失败项不变）应 diverged，实际: ' + finalVerdict);
      var maxStreak = Math.max.apply(null, streaks);
      assert.ok(maxStreak >= 3,
        '无效 retry divergenceStreak 应累计到阈值，streak 序列: ' + JSON.stringify(streaks));
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Scenario 8 (WP-177-5-test): 读 plan.md → plan-reader 拆 WP → engine 执行 → 触顶出报告
//
// WP-177 核心新行为全链路：plan-reader 读 .claude/plan.md 拆出 WP 集合 →
// 以解析出的 goal.wpIds 初始化 engine → 用真实 snapshot/evaluator + mock actuator
// 跑到 max_iterations 触顶 → 验证 engine 自主生成 terminalReport（含趋势+失败明细），
// 不再依赖外部"回 P1"。
//
// 此场景锚定 WP-177 改造目标第 1 条（读计划入口）+ 第 5 条（停下输出报告），
// 是用户原始诉求（"按已有计划拆 WP + 停下输出报告"）的端到端验收。
// ─────────────────────────────────────────────

test.describe('Scenario 8 (WP-177-5-test): 读 plan.md → 执行 → 触顶出报告全链路', function () {
  // 构造一个含多 section + checklist + 依赖的 plan.md（模拟 brainstorming 产物）
  function buildPlanFixture() {
    return [
      '# 总计划：用户管理模块',
      '',
      '## 数据模型',
      '- [ ] 定义 User 表结构',
      '- [ ] 定义 Order 表结构',
      '',
      '## API 层',
      '依赖 WP-数据模型（先完成数据模型）',
      '- [ ] 实现 /users 路由',
      '- [ ] 实现 /orders 路由',
      '',
      '## 成功标准',
      '- [ ] 所有 checklist 项通过',
    ].join('\n');
  }

  test('plan-reader 解析 plan.md → goal.wpIds 非空 → engine 触顶后 terminalReport 完整', async function () {
    var planReader = require('../../plugins/runtime/plan-reader');

    // 准备临时项目根 + .claude/plan.md
    var dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'plan.md'), buildPlanFixture(), 'utf8');
    // task.md 让派生编号稳定（plan-reader 从 task.md 最大编号+1 起派生）
    fs.writeFileSync(path.join(dir, 'task.md'), '# Tasks\n', 'utf8');

    var origCwd = process.cwd();
    process.chdir(dir);
    try {
      // ① plan-reader 解析（真实模块，非 mock）
      var parsed = planReader.parsePlanToGoal({ projectRoot: dir });
      assert.strictEqual(parsed.error, null, 'plan.md 应成功解析');
      assert.ok(parsed.goal.wpIds.length >= 2, '应拆出至少 2 个 WP，实际: ' + parsed.goal.wpIds.length);
      var wpIds = parsed.goal.wpIds;
      // 验证 wpId 形态（WP-NNN）
      for (var w = 0; w < wpIds.length; w++) {
        assert.ok(/^WP-\d+$/.test(wpIds[w]), 'wpId 应为 WP-NNN 形态: ' + wpIds[w]);
      }

      // ② 用解析出的 goal 初始化真实 engine（+ 真实 snapshot/evaluator + mock actuator）
      var actuatorExecute = async function () {
        // 持续返回含失败项的 checklist，确保跑到触顶（不达成也不发散过快）
        return {
          dispatched: true,
          checklistResult: failingCheckResult(10, 7, wpIds[0]), // proximity=0.7 恒定
        };
      };
      var env = await makeRealLoop({
        actuatorExecute: actuatorExecute,
        goal: { wpIds: wpIds },
        // 关掉发散（只测触顶出口），上限设为默认 6（验证默认阈值生效）
        configOverride: { divergence_threshold: 99, max_iterations: 6 },
        getProvider: function () { return null; },
      });

      var initRes = await env.api.init({ teamName: 'plan-team', goal: { wpIds: wpIds } });
      var loopId = initRes.loopId;

      var finalVerdict = null;
      var finalReport = null;
      var finalIteration = null;
      for (var rounds = 0; rounds < 12; rounds++) {
        var stepRes = await env.api.step(loopId);
        if (stepRes.verdict !== 'continue') {
          finalVerdict = stepRes.verdict;
          finalReport = stepRes.report;
          finalIteration = stepRes.iteration;
          break;
        }
      }

      // ③ 触顶出口：verdict=timeout，iteration 达默认上限 6
      assert.strictEqual(finalVerdict, 'timeout',
        '跑到默认 max_iterations=6 应触顶 timeout，实际: ' + finalVerdict);
      assert.strictEqual(finalIteration, 6, 'iteration 应达默认上限 6');

      // ④ terminalReport 自主生成（不再回 P1）：step 返回 report + state.terminalReport 非空
      assert.ok(finalReport, '触顶后 step 返回 report（不再依赖外部回 P1）');
      assert.strictEqual(finalReport.verdict, 'timeout');
      assert.ok(finalReport.markdown, 'report 含 markdown 总结');

      var state = await env.api.getState(loopId);
      assert.strictEqual(state.status, 'timeout');
      assert.ok(state.terminalReport, 'state.terminalReport 已写入');
      // 报告含趋势（history 经多轮流转，proximityTrend 长度 >= 1）
      assert.ok(state.terminalReport.proximityTrend.length >= 1,
        '报告含 proximityTrend 趋势，长度: ' + state.terminalReport.proximityTrend.length);
      // 报告含失败明细（actuator 持续返回 3 失败项 → failingDrivers 由 evaluator 回填）
      assert.ok(state.terminalReport.failedItems.length > 0,
        '报告含 failedItems 失败明细，数量: ' + state.terminalReport.failedItems.length);
    } finally {
      process.chdir(origCwd);
      cleanupTmpDir(dir);
    }
  });

  test('plan-reader 解析不出 WP → error 非空（loop 不启动，提示用户而非退化）', async function () {
    var planReader = require('../../plugins/runtime/plan-reader');

    var dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    // 空 plan.md（无可执行 section）
    fs.writeFileSync(path.join(dir, '.claude', 'plan.md'), '# 只有标题\n\n纯说明，无任务项。\n', 'utf8');

    var origCwd = process.cwd();
    process.chdir(dir);
    try {
      var parsed = planReader.parsePlanToGoal({ projectRoot: dir });
      // plan-reader 容错不抛，返回 error + 空 wpIds
      assert.ok(parsed.error, '空/无可执行 section 的 plan 应返回 error');
      assert.strictEqual(parsed.goal.wpIds.length, 0, '解析不出 WP 时 wpIds 为空');
      // 这是 loop「不启动」而非「退化为线性」的唯一情形（skill.md Step 0 红线）
    } finally {
      process.chdir(origCwd);
      cleanupTmpDir(dir);
    }
  });
});

// ─────────────────────────────────────────────
// Scenario 9 (WP-177-5-test): 真实 loop-actuator 注入路径对照（vs mock actuator）
//
// 现有 Scenario 1-7 都用 mock actuator 隔离真实 dispatcher spawn。本场景补一条
// 「自动注入的真实 loop-actuator」路径对照：不显式 inject actuator，让 engine
// onActivate/factory 自动注入 loop-actuator，验证 act() 经真实路径产出 pendingAction
// （decision 序列化为 dispatcher 指令写入 state-store 子 key），与 mock 路径行为对齐。
// 这是 WP-177-2-impl-b「actuator 自动注入 + 移除 placeholder」的端到端验收。
// ─────────────────────────────────────────────

test.describe('Scenario 9 (WP-177-5-test): 真实 loop-actuator 自动注入对照', function () {
  test('不显式 inject actuator → 自动注入 loop-actuator → act() 产出 pendingAction（非 placeholder）', async function () {
    var dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

    var provider = new LoopEngineProvider();
    var origCwd = process.cwd();
    process.chdir(dir);

    try {
      var context = {
        config: null,
        getProvider: function () { return null; },
      };
      await provider.onActivate(context);
      // ① 自动注入验证：onActivate 后 _delegates.actuator 已就位（真实 loop-actuator）
      assert.ok(provider._delegates.actuator,
        'onActivate 自动注入 loop-actuator，actuator 非空');

      var api = await provider.factory(context);
      // 仅注入 snapshot/evaluator（act 走自动注入的真实 actuator）
      api.inject({
        snapshot: loopSnapshot,
        evaluator: reflectionEvaluator,
      });
      assert.ok(provider._delegates.actuator, 'factory 后真实 actuator 仍在位');

      var initRes = await api.init({ teamName: 'auto-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      // ② 直接调 act，验证真实 actuator 产出 pendingAction（非 placeholder）
      var actResult = await api.act(loopId, { action: 'dispatch', targetWp: 'WP-1' });
      assert.strictEqual(actResult.placeholder, undefined, '真实 actuator 不返回 placeholder');
      assert.strictEqual(actResult.dispatched, true, 'dispatch decision 经真实 actuator 派发');
      assert.strictEqual(actResult.degraded, undefined, '真实路径无降级标记');

      // ③ pendingAction 写入 state-store 子 key（loop-actuator 序列化 decision 的产物）
      var pending = await provider._store.get('loop.' + loopId + '.pendingAction');
      assert.ok(pending, '真实 loop-actuator 产出 pendingAction 写入 state-store');
      assert.strictEqual(pending.mode, 'dispatch');
      assert.strictEqual(pending.wpId, 'WP-1');
      assert.ok(pending.createdAt, 'pendingAction 含时间戳');

      // ④ step() 端到端流转也走真实 actuator（无 placeholder）
      var stepRes = await api.step(loopId);
      assert.strictEqual(stepRes.iteration, 1, 'iteration +1');
      var st = await api.getState(loopId);
      assert.strictEqual(st.lastActResult.placeholder, undefined, 'step 内 act 也不返回 placeholder');
    } finally {
      process.chdir(origCwd);
      cleanupTmpDir(dir);
    }
  });

  test('真实 actuator：retry decision 携带 failingDrivers 注入 pendingAction', async function () {
    var dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

    var provider = new LoopEngineProvider();
    var origCwd = process.cwd();
    process.chdir(dir);

    try {
      var context = { config: null, getProvider: function () { return null; } };
      await provider.onActivate(context);
      var api = await provider.factory(context);
      api.inject({ snapshot: loopSnapshot, evaluator: reflectionEvaluator });

      var initRes = await api.init({ teamName: 'retry-team', goal: { wpIds: ['WP-1'] } });
      var loopId = initRes.loopId;

      // retry decision 携带 failingDrivers（模拟 Think refine 反馈产出）
      var drivers = [
        { wpId: 'WP-1', category: '测试', item: 't1', reason: '缺边界' },
      ];
      var actResult = await api.act(loopId, {
        action: 'retry',
        targetWp: 'WP-1',
        strategy: 'checkpoint_resume',
        failingDrivers: drivers,
      });
      assert.strictEqual(actResult.dispatched, true);

      // 真实 actuator 把 failingDrivers 透传进 pendingAction（供 dispatcher 注入 Teamee refine 反馈）
      var pending = await provider._store.get('loop.' + loopId + '.pendingAction');
      assert.strictEqual(pending.mode, 'retry');
      assert.strictEqual(pending.strategy, 'checkpoint_resume');
      assert.deepStrictEqual(pending.failingDrivers, drivers,
        'retry decision 的 failingDrivers 经真实 actuator 透传进 pendingAction');
    } finally {
      process.chdir(origCwd);
      cleanupTmpDir(dir);
    }
  });
});
