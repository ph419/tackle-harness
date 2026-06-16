/**
 * Loop Coordinator — 多 Agentic Loop 实例全局协调
 *
 * @module loop-coordinator
 *
 * 复用 multi-window-coordinator.aggregateWindowStates 的聚合模式（design.md §2.1.5、
 * §10 WP-174-5 提示），把每个 loop 实例当作"逻辑窗口"，聚合各 loop 的
 * iteration/proximity/verdict/health，产出全局收敛视角。
 *
 * 职责边界（design.md §6.5 / §7.1）：
 *   - 只读聚合各 loop 状态（不写各 loop 自身状态，避免多进程并发写——state-store.js:19-23
 *     明确不支持多进程并发写）。
 *   - 提供全局 verdict：所有 loop achieved → global_achieved（可进 P4）；
 *     任一 loop circuit_broken/terminated → global_circuit_broken（全局回退）；
 *     任一 loop diverged/timeout → global_failed（回 P1）；否则 global_running。
 *   - 不越界：coordinator 不调度、不拆分、不干预各 loop 内部状态机；仅作全局判定与汇总。
 *
 * 并发策略（design.md §8.3 / state-store CONCURRENCY NOTES）：
 *   - 每 loop 独立 namespace `loop.{loopId}`，由各 loop 进程单写。
 *   - coordinator 通过注入的 store 查询多 loop 状态（listKeys 前缀扫描 + get），
 *     读取失败的单 loop 降级为 disconnected，不阻断聚合。
 *
 * Work package: WP-174-5-impl-converge
 * Design ref: docs/reports/agentic-loop-design.md §2.1.5、§6、§10
 */

'use strict';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 终止类 verdict（design.md §6.1-6.3）。running/continue 视为仍在迭代。
 * 状态字符串与 loop-engine createLoopState().status 对齐。
 */
var TERMINAL_VERDICTS = {
  achieved: true,
  timeout: true,
  diverged: true,
  circuit_broken: true,
  aborted: true,
};

/**
 * 熔断类 verdict（任一出现即触发全局回退，最高优先级）。
 */
var CIRCUIT_VERDICTS = {
  circuit_broken: true,
  aborted: true,
};

/**
 * 失败回退类 verdict（回 P1 人介入，但非熔断）。
 */
var FAILED_VERDICTS = {
  timeout: true,
  diverged: true,
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * ISO 时间戳。
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 从单个 loop 状态提取协调器所需摘要视图（仿 multi-window aggregateSingleWindow）。
 *
 * @param {string} loopId
 * @param {object|null} state - loop-engine 的 LoopState（state-store 中 loop.{loopId}）
 * @returns {object} 单 loop 协调摘要
 */
function summarizeLoop(loopId, state) {
  if (!state) {
    return {
      loopId: loopId,
      status: 'disconnected',
      iteration: 0,
      proximity: 0,
      verdict: null,
      health: 'unknown',
      diverged: false,
      updatedAt: null,
      error: 'state-missing',
    };
  }

  var verdict = state.lastVerdict && state.lastVerdict.verdict
    ? state.lastVerdict.verdict
    : null;
  var evalResult = state.lastEval || {};
  var snapshot = state.lastSnapshot || {};
  var watchdog = snapshot.watchdog || {};

  // health 优先取 watchdog 健康字段，回退 status 推断
  var health = watchdog.health || (state.status === 'circuit_broken' ? 'terminated' : 'healthy');

  return {
    loopId: loopId,
    status: state.status || 'unknown',
    iteration: state.iteration || 0,
    proximity: typeof evalResult.proximity === 'number' ? evalResult.proximity : 0,
    verdict: verdict,
    health: health,
    diverged: !!(evalResult.diverged),
    divergenceStreak: evalResult.divergenceStreak || state.divergenceStreak || 0,
    updatedAt: state.lastUpdatedAt || null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// 聚合器
// ---------------------------------------------------------------------------

/**
 * 聚合多 loop 实例状态为全局协调视图（复用 aggregateWindowStates 模式）。
 *
 * 数据来源：
 *   - 首选 `loopStates` 数组（调用方已通过 state-store.get('loop.{loopId}') 拉取，
 *     适用于明确知道 loopId 集合的场景，跨进程读最安全）。
 *   - 若传入 `store`（state-store 实例）且未提供 loopStates，则尝试前缀扫描
 *     `loop.` 开头的 key 聚合（依赖 store.listKeys/listByPrefix 能力，能力缺失时
 *     返回空聚合，不报错）。
 *
 * @param {object} opts
 * @param {Array<object>} [opts.loopStates] - 各 loop 的 LoopState 数组（loopId 字段必填）
 * @param {object} [opts.store] - state-store 实例（提供 listKeys/get）
 * @param {string} [opts.sessionId] - 可选会话 ID（多 loop 会话标识）
 * @returns {Promise<object>} 全局协调视图（global verdict + 各 loop 摘要 + 全局计数）
 */
async function aggregateLoopStates(opts) {
  opts = opts || {};
  var now = nowIso();

  // 收集 loopState 列表
  var states = [];
  if (Array.isArray(opts.loopStates)) {
    states = opts.loopStates;
  } else if (opts.store) {
    states = await collectLoopStatesFromStore(opts.store);
  }

  // 构建 loop 摘要映射
  var loops = {};
  var loopIds = [];
  for (var i = 0; i < states.length; i++) {
    var st = states[i] || {};
    var lid = st.loopId;
    if (!lid) continue; // 无 loopId 的脏数据跳过
    loops[lid] = summarizeLoop(lid, st);
    loopIds.push(lid);
  }

  // 全局计数
  var global = computeGlobalState(loops, loopIds);

  return {
    session_id: opts.sessionId || ('loop-session-' + now.replace(/[:.]/g, '').slice(0, 15)),
    aggregated_at: now,
    total_loops: loopIds.length,
    loops: loops,
    global: global,
  };
}

/**
 * 从 state-store 收集所有 `loop.` 前缀的 loop 状态（跨 loop 进程的只读聚合）。
 *
 * state-store 不支持 listKeys 时返回空数组（降级，不阻断）。
 * @private
 * @param {object} store
 * @returns {Promise<Array<object>>}
 */
async function collectLoopStatesFromStore(store) {
  if (!store) return [];
  // 优先用显式 listByPrefix（若 store 提供），否则尝试通用 listKeys 过滤
  var keys = [];
  try {
    if (typeof store.listByPrefix === 'function') {
      keys = await store.listByPrefix('loop.');
    } else if (typeof store.listKeys === 'function') {
      var all = await store.listKeys();
      keys = (all || []).filter(function (k) { return String(k).indexOf('loop.') === 0; });
    } else {
      return [];
    }
  } catch (_e) {
    return [];
  }

  var states = [];
  for (var i = 0; i < keys.length; i++) {
    try {
      var st = await store.get(keys[i]);
      if (st && st.loopId) states.push(st);
    } catch (_e2) {
      // 单 loop 读取失败，跳过（不阻断聚合）
    }
  }
  return states;
}

/**
 * 计算全局协调状态（仿 multi-window computeSessionStatus，但语义对齐 loop 终止判定）。
 *
 * 全局 verdict 优先级（与 design.md §6.5 单 loop 优先级一致：熔断 > 失败 > 达成 > 运行）：
 *   1) 任一 loop circuit_broken/aborted/health=terminated → 'global_circuit_broken'
 *   2) 任一 loop timeout/diverged → 'global_failed'
 *   3) 全部 loop achieved → 'global_achieved'
 *   4) 否则 → 'global_running'
 *
 * @param {object} loops - { loopId: summary }
 * @param {string[]} loopIds
 * @returns {object} { verdict, reason, achievedCount, circuitCount, failedCount, runningCount, minProximity, maxIteration }
 */
function computeGlobalState(loops, loopIds) {
  var achievedCount = 0;
  var circuitCount = 0;
  var failedCount = 0;
  var runningCount = 0;
  var disconnectedCount = 0;
  var minProximity = 1;
  var maxIteration = 0;
  var minProximitySet = false;

  for (var i = 0; i < loopIds.length; i++) {
    var s = loops[loopIds[i]];
    if (!s) continue;

    if (s.status === 'disconnected') {
      disconnectedCount++;
      continue;
    }

    // 熔断判定（health terminated 优先，其次 verdict）
    var isCircuit = CIRCUIT_VERDICTS[s.verdict] || s.health === 'terminated' || s.status === 'circuit_broken' || s.status === 'aborted';
    var isFailed = FAILED_VERDICTS[s.verdict] || s.verdict === 'timeout' || s.verdict === 'diverged' || s.status === 'timeout' || s.status === 'diverged';
    var isAchieved = s.verdict === 'achieved' || s.status === 'achieved';

    if (isCircuit) circuitCount++;
    else if (isFailed) failedCount++;
    else if (isAchieved) achievedCount++;
    else runningCount++;

    if (typeof s.proximity === 'number') {
      if (!minProximitySet || s.proximity < minProximity) {
        minProximity = s.proximity;
        minProximitySet = true;
      }
    }
    if (s.iteration > maxIteration) maxIteration = s.iteration;
  }

  if (!minProximitySet) minProximity = 0;

  // 全局 verdict（优先级：熔断 > 失败 > 达成 > 运行）
  var verdict;
  var reason;
  if (circuitCount > 0) {
    verdict = 'global_circuit_broken';
    reason = circuitCount + ' 个 loop 熔断/终止，全局回退';
  } else if (failedCount > 0) {
    verdict = 'global_failed';
    reason = failedCount + ' 个 loop 触顶/发散，回 P1 人介入';
  } else if (loopIds.length > 0 && achievedCount === (loopIds.length - disconnectedCount) && achievedCount > 0) {
    // 所有非 disconnected 的 loop 均达成
    verdict = 'global_achieved';
    reason = '全部 ' + achievedCount + ' 个 loop 达成，可进 P4';
  } else {
    verdict = 'global_running';
    reason = runningCount + ' 个 loop 迭代中';
  }

  return {
    verdict: verdict,
    reason: reason,
    achievedCount: achievedCount,
    circuitCount: circuitCount,
    failedCount: failedCount,
    runningCount: runningCount,
    disconnectedCount: disconnectedCount,
    minProximity: minProximity,
    maxIteration: maxIteration,
  };
}

// ---------------------------------------------------------------------------
// 全局判定辅助
// ---------------------------------------------------------------------------

/**
 * 判定全局是否达成（所有 loop achieved，可进 P4）。
 * @param {object} aggregated - aggregateLoopStates 返回值
 * @returns {boolean}
 */
function isGlobalAchieved(aggregated) {
  return !!(aggregated && aggregated.global && aggregated.global.verdict === 'global_achieved');
}

/**
 * 判定全局是否熔断（任一 loop 熔断，应全局回退）。
 * @param {object} aggregated
 * @returns {boolean}
 */
function isGlobalCircuitBroken(aggregated) {
  return !!(aggregated && aggregated.global && aggregated.global.verdict === 'global_circuit_broken');
}

/**
 * 判定全局是否需要回 P1（熔断或失败）。
 * @param {object} aggregated
 * @returns {boolean}
 */
function needsHumanIntervention(aggregated) {
  if (!aggregated || !aggregated.global) return false;
  var v = aggregated.global.verdict;
  return v === 'global_circuit_broken' || v === 'global_failed';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // 常量（暴露供测试）
  TERMINAL_VERDICTS: TERMINAL_VERDICTS,
  CIRCUIT_VERDICTS: CIRCUIT_VERDICTS,
  FAILED_VERDICTS: FAILED_VERDICTS,

  // 聚合
  aggregateLoopStates: aggregateLoopStates,
  summarizeLoop: summarizeLoop,
  computeGlobalState: computeGlobalState,

  // 全局判定
  isGlobalAchieved: isGlobalAchieved,
  isGlobalCircuitBroken: isGlobalCircuitBroken,
  needsHumanIntervention: needsHumanIntervention,
};
