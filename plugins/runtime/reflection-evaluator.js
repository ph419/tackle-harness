/**
 * Reflection Evaluator — Agentic Loop 反思评分器（WP-174-3，Reflect 层）
 *
 * @module reflection-evaluator
 *
 * 对当前快照评分，产出 EvalResult（design.md §5.3.2）：
 *   - proximity       接近度 [0,1]，1 - (未通过项数 / 总检查项数)
 *   - converged       本轮 proximity 严格大于上一轮（单调改进检测）
 *   - diverged        是否触发发散（连续 divergence_threshold 轮无进展）
 *   - divergenceStreak 连续无进展轮数（engine 在 reflect 后同步到 state）
 *   - trend           improving | flat | regressing
 *   - categoryScores  按 checklist 类别细分
 *   - failingDrivers  失败项 → refine 驱动（evaluator-refine 反馈）
 *   - allPassed       checklist 是否全过（decide §6.1 达成判定依赖）
 *   - recommendation  给 Think 的建议
 *
 * 发散检测（design.md §5.3.1）：读 state.history 末尾 proximity 序列，
 * 连续 divergence_threshold 轮 proximity 不增（含回退）则 diverged=true。
 *
 * 接入契约（必须匹配 provider-loop-engine/index.js inject 期望）：
 *   loopEngine.inject({ evaluator: thisModule })
 *   engine 在 reflect 阶段调用：evaluator.score(context, loopId, snapshot, state) → EvalResult
 *
 * 判定阈值默认值与 design.md §5.3.3 / loop-engine DEFAULT_CONFIG 一致：
 *   proximity_goal=0.9, divergence_threshold=3
 *
 * 设计依据：docs/reports/agentic-loop-design.md §5.3 / §5.4
 */

'use strict';

// ---------------------------------------------------------------------------
// 默认阈值（与 design.md §5.3.3 / provider-loop-engine DEFAULT_CONFIG 对齐）
// ---------------------------------------------------------------------------

var DEFAULT_THRESHOLDS = {
  proximity_goal: 0.9,
  divergence_threshold: 3,
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
 * 从 state.history 提取按迭代排序的 proximity 序列（design.md §5.3.1 趋势/发散依赖）。
 * history 每项形如 { iteration, eval: { proximity, converged, diverged }, ... }。
 * @param {object} state
 * @returns {number[]} proximity 序列（升序迭代）
 */
function extractProximityHistory(state) {
  if (!state || !state.history || !state.history.length) return [];
  var seq = [];
  // history 通常按追加顺序，但保险起见按 iteration 排序
  var sorted = state.history.slice().sort(function (a, b) {
    var ia = (a && typeof a.iteration === 'number') ? a.iteration : 0;
    var ib = (b && typeof b.iteration === 'number') ? b.iteration : 0;
    return ia - ib;
  });
  for (var i = 0; i < sorted.length; i++) {
    var entry = sorted[i];
    if (entry && entry.eval && typeof entry.eval.proximity === 'number') {
      seq.push(entry.eval.proximity);
    }
  }
  return seq;
}

/**
 * 计算连续无进展轮数（divergenceStreak）。
 * 从序列末尾向前数：连续多少个 proximity 严格不大于其前驱。
 * design.md §5.3.1：连续 N 轮 proximity 不增（含回退）。
 *
 * 注意：当前轮 proximity 由本函数入参 curProximity 提供（尚未写入 history），
 * seq 为"截至上一轮"的历史。我们把 curProximity 追加到末尾再计算。
 *
 * @param {number[]} seq 历史 proximity（不含当前轮）
 * @param {number} curProximity 当前轮 proximity
 * @returns {number}
 */
function computeDivergenceStreak(seq, curProximity) {
  var all = seq.slice();
  all.push(curProximity);
  if (all.length < 2) return 0;
  var streak = 0;
  // 从末尾向前：若 all[i] <= all[i-1] 则 streak+1，遇到首个严格递增即停
  for (var i = all.length - 1; i >= 1; i--) {
    if (all[i] <= all[i - 1]) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * 从 lastChecklist 提取"本轮失败项数"（WP-176-5 / 偏差3 发散宽容信号）。
 * 优先用 summary.failed；缺失时回退 failedItems.length。无 checklist → null（无法判定）。
 *
 * 这是发散宽容判定的"本轮"输入：与上轮 failedCount 对比，判定 retry 是否部分改进。
 *
 * @param {object} chk CheckResult
 * @returns {number|null} 失败项数；无 checklist 时 null（调用方降级为 proximity 判定）
 */
function failedCountFromChecklist(chk) {
  if (!chk) return null;
  var summary = chk.summary || {};
  if (typeof summary.failed === 'number') return summary.failed;
  if (chk.failedItems && typeof chk.failedItems.length === 'number') {
    return chk.failedItems.length;
  }
  // summary 仅有 total/passed → 推导
  var total = typeof summary.total === 'number' ? summary.total : 0;
  var passed = typeof summary.passed === 'number' ? summary.passed : 0;
  if (total > 0) return total - passed;
  return null;
}

/**
 * 从 state.history 末轮 eval 提取"上轮失败项数"（WP-176-5 / 偏差3）。
 * history 末轮 eval 由 step() 写入；若含 failedCount 字段直接取，否则降级返回 null。
 *
 * @param {object} state
 * @returns {number|null} 上轮失败项数；无 history 或末轮无 failedCount 时 null
 */
function prevFailedCountFromHistory(state) {
  if (!state || !state.history || !state.history.length) return null;
  var last = state.history[state.history.length - 1];
  if (last && last.eval && typeof last.eval.failedCount === 'number') {
    return last.eval.failedCount;
  }
  return null;
}

/**
 * 判定本轮 retry 是否"部分改进"（WP-176-5 / 修复点 D，修复偏差3）。
 *
 * 发散宽容核心：retry 后失败项数**减少**（部分改进）视为有进展，本轮不计入
 * divergenceStreak；失败项数**不变/增多**（无效 retry）才累计发散。
 *
 * 这区分了"针对性 refine 起作用（每轮修掉一些失败项）"与"原样重做（失败项纹丝不动）"。
 * 前者不应被误判发散回退 P1。
 *
 * 向后兼容：任一输入为 null（无 checklist / 无上轮 failedCount，如首轮或降级路径）
 * → 返回 false（无法判定部分改进），调用方降级为现有 proximity-based 累计逻辑。
 *
 * @param {number|null} curFailedCount 本轮失败项数
 * @param {number|null} prevFailedCount 上轮失败项数
 * @returns {boolean} true=部分改进（失败项严格减少）
 */
function computeRefineProgress(curFailedCount, prevFailedCount) {
  if (curFailedCount === null || prevFailedCount === null) return false;
  if (typeof curFailedCount !== 'number' || typeof prevFailedCount !== 'number') {
    return false;
  }
  // 部分改进：本轮失败项严格少于上轮
  return curFailedCount < prevFailedCount;
}

/**
 * 计算最近 N 轮 proximity 趋势（design.md §5.3.1 trend）。
 * 基于当前轮与上一轮的对比（含当前轮）：
 *   - improving   curProximity > prevProximity
 *   - regressing  curProximity < prevProximity
 *   - flat        相等，或无历史
 * @param {number[]} seq 历史 proximity（不含当前轮）
 * @param {number} curProximity 当前轮
 * @returns {'improving'|'flat'|'regressing'}
 */
function computeTrend(seq, curProximity) {
  if (!seq.length) return 'flat';
  var prev = seq[seq.length - 1];
  if (curProximity > prev) return 'improving';
  if (curProximity < prev) return 'regressing';
  return 'flat';
}

/**
 * 从 lastChecklist（CheckResult，design.md §5.4.2）计算 proximity。
 * proximity = 1 - (failed / total)，区间 [0,1]。total=0 时无检查项 → null（交由调用方兜底）。
 * @param {object} chk CheckResult
 * @returns {number|null}
 */
function proximityFromChecklist(chk) {
  if (!chk) return null;
  var summary = chk.summary || {};
  var total = typeof summary.total === 'number' ? summary.total : 0;
  var passed = typeof summary.passed === 'number' ? summary.passed : 0;
  var failed = typeof summary.failed === 'number' ? summary.failed : (total - passed);
  if (total <= 0) {
    // 无检查项：passed 视为全过 → 1；否则 0
    return chk.passed === true ? 1 : 0;
  }
  if (failed < 0) failed = 0;
  if (failed > total) failed = total;
  var prox = 1 - (failed / total);
  // 钳到 [0,1]
  if (prox < 0) prox = 0;
  if (prox > 1) prox = 1;
  return prox;
}

/**
 * 从 lastChecklist 的 categories 计算按类别细分得分（design.md §5.3.2 categoryScores）。
 * @param {object} chk CheckResult
 * @returns {Array<{category:string,passed:number,total:number,ratio:number}>}
 */
function categoryScoresFromChecklist(chk) {
  if (!chk || !chk.categories || !chk.categories.length) return [];
  var out = [];
  for (var i = 0; i < chk.categories.length; i++) {
    var cat = chk.categories[i];
    if (!cat) continue;
    var items = cat.items || [];
    var total = items.length;
    var passed = 0;
    for (var j = 0; j < items.length; j++) {
      if (items[j] && items[j].passed === true) passed += 1;
    }
    var ratio = total > 0 ? passed / total : (cat.passed === true ? 1 : 0);
    out.push({
      category: cat.name || ('category-' + (i + 1)),
      passed: passed,
      total: total,
      ratio: ratio,
    });
  }
  return out;
}

/**
 * 从 lastChecklist.failedItems 构建 failingDrivers（design.md §5.3.2 / §5.4.4）。
 * 映射：{ wpId, category, item, reason }
 * @param {object} chk CheckResult
 * @returns {Array<{wpId:string,category:string,item:string,reason:string}>}
 */
function failingDriversFromChecklist(chk) {
  if (!chk || !chk.failedItems || !chk.failedItems.length) return [];
  var wpId = chk.wpId || '';
  var out = [];
  for (var i = 0; i < chk.failedItems.length; i++) {
    var fi = chk.failedItems[i];
    if (!fi) continue;
    out.push({
      wpId: wpId,
      category: fi.category || '',
      item: fi.id || fi.text || '',
      reason: fi.reason || '',
    });
  }
  return out;
}

/**
 * 从 lastChecklist.failedItems 按 wpId 聚合，得到去重的失败 WP id 列表（WP-176-1）。
 *
 * 这是 retry 反馈链路的源头归一化（Layer 0）：为 loop-snapshot.buildWorkPackages
 * 推导 `workPackages.failed`（WP-176-2）、engine retry 分支（WP-176-3）提供统一的
 * "从 checklist 失败项 → 失败 WP 列表"推导口径，避免三处重复实现。
 *
 * 聚合规则：
 *   - 每个 failedItem 的 wpId 优先取其自带 `fi.wpId`，否则回退到 CheckResult 顶层 `chk.wpId`
 *   - 空 wpId（无来源）的失败项被丢弃（无法定位到具体 WP）
 *   - 结果按 wpId 去重，保持首次出现顺序
 *
 * 注意：本函数只做 wpId 聚合去重，**不负责**排除 completed WP / 限定 goal 范围——
 * 这些是下游 snapshot 基于完整 workPackages 视图才能判断的职责（WP-176-2）。
 * 这里产出的纯失败 WP 候选集，由 snapshot 再过滤。
 *
 * @param {object} chk CheckResult（design.md §5.4.2），含 failedItems 与 wpId
 * @returns {string[]} 去重后的失败 WP id 列表（如 ['WP-5']）；边界（null chk /
 *                     无 failedItems / 无可定位 wpId）返回 []
 */
function failingWpsFromChecklist(chk) {
  if (!chk || !chk.failedItems || !chk.failedItems.length) return [];
  var defaultWpId = chk.wpId || '';
  var seen = {};
  var out = [];
  for (var i = 0; i < chk.failedItems.length; i++) {
    var fi = chk.failedItems[i];
    if (!fi) continue;
    // 优先 failedItem 自带 wpId，回退 CheckResult 顶层 wpId
    var wid = (typeof fi.wpId === 'string' && fi.wpId) ? fi.wpId : defaultWpId;
    if (!wid) continue; // 无来源的失败项无法定位到 WP，丢弃
    if (seen[wid]) continue;
    seen[wid] = true;
    out.push(wid);
  }
  return out;
}

/**
 * 从 snapshot.workPackages 计算基于 WP 完成度的 proximity（无 checklist 时的降级）。
 * proximity = completed / total。
 * @param {object} workPackages
 * @returns {number}
 */
function proximityFromWorkPackages(workPackages) {
  if (!workPackages) return 0;
  var total = typeof workPackages.total === 'number' ? workPackages.total : 0;
  var completed = (workPackages.completed || []).length;
  if (total <= 0) return 0;
  var prox = completed / total;
  if (prox < 0) prox = 0;
  if (prox > 1) prox = 1;
  return prox;
}

/**
 * 生成给 Think 的建议（recommendation，design.md §5.3.2）。
 * 优先级：失败项重试 > 达成 > 继续。
 * @param {object} opts { failingDrivers, proximity, proximityGoal, allPassed, snapshot }
 * @returns {string}
 */
function buildRecommendation(opts) {
  if (opts.failingDrivers && opts.failingDrivers.length > 0) {
    var firstWp = opts.failingDrivers[0].wpId || '';
    var category = opts.failingDrivers[0].category || '';
    // 同一 WP 多类失败 → resplit；单类 → retry
    if (firstWp) {
      var sameWpCats = {};
      var dup = false;
      for (var i = 0; i < opts.failingDrivers.length; i++) {
        if (opts.failingDrivers[i].wpId === firstWp && opts.failingDrivers[i].category) {
          if (sameWpCats[opts.failingDrivers[i].category]) { dup = true; break; }
          sameWpCats[opts.failingDrivers[i].category] = true;
        }
      }
      var prefix = dup ? 'resplit_' : 'retry_';
      var tag = category ? (prefix + firstWp + '_(' + category + ')') : (prefix + firstWp);
      return tag;
    }
    return 'retry_failed_items';
  }
  if (opts.allPassed && opts.proximity >= opts.proximityGoal) {
    return 'achieved';
  }
  return 'continue';
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

module.exports = {
  /**
   * 对当前快照评分（design.md §5.3.4 评分 API）。
   *
   * @param {PluginContext} context - loop-engine 注入的 context（保留参数，兼容 engine 调用签名）
   * @param {string} loopId
   * @param {object} snapshot - LoopSnapshot（design.md §5.2.2），含 lastChecklist / workPackages
   * @param {object} state - LoopState（design.md §5.1.1），取 history 算趋势/发散；
   *                         engine 已在 reflect 中传入最新 state（含 divergenceStreak 历史）
   * @returns {Promise<object>} EvalResult（design.md §5.3.2）
   */
  score: async function (context, loopId, snapshot, state) {
    if (!loopId) {
      throw new Error('reflection-evaluator.score: loopId is required');
    }
    snapshot = snapshot || {};
    state = state || {};

    // 阈值：优先 engine config（若 context 提供），否则默认
    var thresholds = DEFAULT_THRESHOLDS;
    try {
      if (context && typeof context.getConfig === 'function') {
        var cfg = context.getConfig();
        if (cfg && typeof cfg === 'object') {
          thresholds = {
            proximity_goal: typeof cfg.proximity_goal === 'number'
              ? cfg.proximity_goal : DEFAULT_THRESHOLDS.proximity_goal,
            divergence_threshold: typeof cfg.divergence_threshold === 'number'
              ? cfg.divergence_threshold : DEFAULT_THRESHOLDS.divergence_threshold,
          };
        }
      }
    } catch (e) {
      thresholds = DEFAULT_THRESHOLDS;
    }

    // ---- proximity 计算（优先 checklist，降级 WP 完成度）----
    var chk = snapshot.lastChecklist || null;
    var proximity = proximityFromChecklist(chk);
    var allPassed = chk ? (chk.passed === true) : false;
    var categoryScores = categoryScoresFromChecklist(chk);
    var failingDrivers = failingDriversFromChecklist(chk);

    if (proximity === null) {
      // 无 checklist：基于 WP 完成度降级
      proximity = proximityFromWorkPackages(snapshot.workPackages);
      // 无 checklist 时无法判定 allPassed，仅在 pending/failed 全空且 proximity 满分时近似
      var wp = snapshot.workPackages || {};
      var noPending = !wp.pending || wp.pending.length === 0;
      var noFailed = !wp.failed || wp.failed.length === 0;
      allPassed = noPending && noFailed && proximity >= 1;
    }

    // ---- 趋势 / 收敛 / 发散（基于 state.history）----
    var seq = extractProximityHistory(state);
    var prevProximity = seq.length ? seq[seq.length - 1] : null;
    var converged = prevProximity !== null ? proximity > prevProximity : false;
    var trend = computeTrend(seq, proximity);
    var streak = computeDivergenceStreak(seq, proximity);
    // 若 proximity 持续为满分（已达成），不算发散
    if (proximity >= thresholds.proximity_goal && allPassed) {
      streak = 0;
    }
    // 发散宽容（WP-176-5 / 修复点 D，修复偏差3）：
    //   retry 后失败项数减少（部分改进）→ 视为有进展，本轮不计入 divergenceStreak。
    //   仅失败项不变/增多（无效 retry）才累计发散。
    //   这区分"针对性 refine 起作用（每轮修掉一些失败项）"与"原样重做（纹丝不动）"，
    //   防止偏差1/2 打通后的有效 refine 被误判发散回退 P1。
    //   向后兼容：无 checklist / 无上轮 failedCount（首轮或降级）→ refineProgressed=false，
    //   沿用上方 proximity-based streak，行为不变。
    var curFailedCount = failedCountFromChecklist(chk);
    var prevFailedCount = prevFailedCountFromHistory(state);
    var refineProgressed = computeRefineProgress(curFailedCount, prevFailedCount);
    if (refineProgressed) {
      streak = 0;
    }
    var diverged = streak >= thresholds.divergence_threshold;

    var iteration = typeof state.iteration === 'number' ? state.iteration : 0;

    return {
      loopId: loopId,
      iteration: iteration,
      proximity: proximity,
      converged: converged,
      diverged: diverged,
      divergenceStreak: streak,
      trend: trend,
      categoryScores: categoryScores,
      failingDrivers: failingDrivers,
      allPassed: allPassed,
      // 本轮失败项数（WP-176-5）：供 step() 写入 history.eval.failedCount，
      // 下轮 score 经 prevFailedCountFromHistory 读取，驱动发散宽容判定。
      failedCount: curFailedCount,
      recommendation: buildRecommendation({
        failingDrivers: failingDrivers,
        proximity: proximity,
        proximityGoal: thresholds.proximity_goal,
        allPassed: allPassed,
        snapshot: snapshot,
      }),
      scoredAt: nowIso(),
    };
  },

  // 暴露内部工具便于单元测试（WP-174-6）
  _extractProximityHistory: extractProximityHistory,
  _computeDivergenceStreak: computeDivergenceStreak,
  _computeTrend: computeTrend,
  _failedCountFromChecklist: failedCountFromChecklist,
  _prevFailedCountFromHistory: prevFailedCountFromHistory,
  _computeRefineProgress: computeRefineProgress,
  _proximityFromChecklist: proximityFromChecklist,
  _categoryScoresFromChecklist: categoryScoresFromChecklist,
  _failingDriversFromChecklist: failingDriversFromChecklist,
  _failingWpsFromChecklist: failingWpsFromChecklist,
  _proximityFromWorkPackages: proximityFromWorkPackages,
  _buildRecommendation: buildRecommendation,
  _DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
};
