/**
 * Loop Report — Agentic Loop 触顶总结报告生成器（WP-177-1-impl-c）
 *
 * @module loop-report
 *
 * 从 loop 运行状态（state.history 各轮 verdict/proximity/failedCount）+ 当前失败项
 * 明细（state.failingDrivers / state.lastEval.failingDrivers）生成结构化总结报告。
 *
 * 当 loop 触顶(timeout)/发散(diverged)/熔断(circuit_broken)时由 engine 出口行为
 * （WP-177-2-impl-c）或 skill.md Step 5（WP-177-3-impl-b）调用，直接输出给用户，
 * 替代「回 P1 human-checkpoint」。
 *
 * 本模块是纯函数式（输入 state，输出报告），无副作用、无 IO，易于测试。
 * 本模块只负责「报告内容」；「是否回 P1」是 engine 出口 / skill.md 的决策，不在此决定。
 *
 * 数据来源：
 *   - state.history（engine step 每轮写入，provider-loop-engine/index.js step()）
 *     每项形如 { iteration, eval:{ proximity, converged, diverged, failedCount }, verdict, timestamp }
 *   - state.failingDrivers（Reflect 回填，reflection-evaluator.js → engine reflect）
 *     每项形如 { wpId, category, item, reason }
 *   - state.lastEval.failingDrivers（降级取最近一次 EvalResult）
 *
 * 设计依据：docs/wp/WP-177.md（改造目标第 5 条「停下输出报告」）、
 *           docs/wp/WP-177-1-impl-c.md
 */

'use strict';

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

var DEFAULTS = {
  // markdown 趋势表只显示最近 N 轮，避免过长（proximityTrend 结构体仍含全部轮次）
  trendTableLimit: 10,
};

// 三种终态 verdict 对应的「建议下一步」文案（design.md 出口行为）
var VERDICT_SUMMARIES = {
  timeout: '已达轮次上限未达成，可手动修复剩余失败项或调高 max_iterations',
  diverged: '连续多轮无进展，建议调整目标或拆分失败 WP',
  circuit_broken: '守护异常，建议检查 watchdog/dispatcher 健康后重试',
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
 * 从 state.history 提取按 iteration 排序的 proximity 趋势（design.md §5.3.1）。
 * 每项形如 { iteration, proximity, verdict, failedCount }。
 *
 * history 通常按追加顺序，但保险起见按 iteration 排序。缺失 eval / proximity 的轮次
 * 被跳过（不破坏趋势序列连续性，但 iteration 仍反映真实轮次）。
 *
 * @param {object} state
 * @returns {Array<{iter:number, proximity:number, verdict:string, failedCount:number|null}>}
 */
function extractProximityTrend(state) {
  if (!state || !state.history || !state.history.length) return [];
  var sorted = state.history.slice().sort(function (a, b) {
    var ia = (a && typeof a.iteration === 'number') ? a.iteration : 0;
    var ib = (b && typeof b.iteration === 'number') ? b.iteration : 0;
    return ia - ib;
  });
  var out = [];
  for (var i = 0; i < sorted.length; i++) {
    var entry = sorted[i];
    if (!entry) continue;
    var ev = entry.eval || {};
    out.push({
      iter: (typeof entry.iteration === 'number') ? entry.iteration : 0,
      proximity: (typeof ev.proximity === 'number') ? ev.proximity : null,
      verdict: entry.verdict || '',
      failedCount: (typeof ev.failedCount === 'number') ? ev.failedCount : null,
    });
  }
  return out;
}

/**
 * 从 state 提取最新失败项明细（failingDrivers）。
 * 优先 state.failingDrivers（Reflect 回填），回退 state.lastEval.failingDrivers。
 * 归一化为 { wpId, category, item, reason }。
 *
 * @param {object} state
 * @returns {Array<{wpId:string, category:string, item:string, reason:string}>}
 */
function extractFailedItems(state) {
  var raw = [];
  if (state) {
    if (state.failingDrivers && state.failingDrivers.length) {
      raw = state.failingDrivers;
    } else if (state.lastEval && state.lastEval.failingDrivers && state.lastEval.failingDrivers.length) {
      raw = state.lastEval.failingDrivers;
    }
  }
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var d = raw[i];
    if (!d) continue;
    out.push({
      wpId: d.wpId || '',
      category: d.category || '',
      item: d.item || '',
      reason: d.reason || '',
    });
  }
  return out;
}

/**
 * 归一化 verdict：未知值降级为 'timeout'（最小可用终态）。
 * @param {string} verdict
 * @returns {string}
 */
function normalizeVerdict(verdict) {
  if (verdict && VERDICT_SUMMARIES[verdict]) return verdict;
  // 兜底：未明确终态时按 timeout 处理（最常见出口）
  return 'timeout';
}

/**
 * 构建一句话结论 summary。
 * @param {object} opts { verdict, iteration, failedCount, lastProximity }
 * @returns {string}
 */
function buildSummary(opts) {
  var verdict = opts.verdict;
  var iter = opts.iteration;
  var failedCount = opts.failedCount;
  var lastProximity = opts.lastProximity;
  var base = VERDICT_SUMMARIES[verdict] || VERDICT_SUMMARIES.timeout;
  var parts = [];
  parts.push('Agentic Loop 在第 ' + iter + ' 轮以「' + verdict + '」终止。');
  if (typeof lastProximity === 'number') {
    parts.push('最终 proximity=' + lastProximity.toFixed(2) + '。');
  }
  if (typeof failedCount === 'number' && failedCount > 0) {
    parts.push('剩余失败项 ' + failedCount + ' 个。');
  }
  parts.push(base);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// markdown 渲染
// ---------------------------------------------------------------------------

/**
 * 把 proximity 趋势渲染为 markdown 表格（最近 N 轮）。
 * @param {Array} trend proximityTrend
 * @param {number} limit 最近 N 轮
 * @returns {string} markdown 片段（含表头），无数据时返回提示行
 */
function renderTrendTable(trend, limit) {
  if (!trend || !trend.length) {
    return '_（无历史轮次数据）_';
  }
  var n = (typeof limit === 'number' && limit > 0) ? limit : DEFAULTS.trendTableLimit;
  var slice = trend.length > n ? trend.slice(trend.length - n) : trend;
  var lines = [];
  lines.push('| 轮次 | proximity | 失败项数 | verdict |');
  lines.push('|------|-----------|----------|---------|');
  for (var i = 0; i < slice.length; i++) {
    var r = slice[i];
    var prox = (typeof r.proximity === 'number') ? r.proximity.toFixed(2) : '-';
    var fc = (typeof r.failedCount === 'number') ? String(r.failedCount) : '-';
    var vd = r.verdict || '-';
    lines.push('| ' + r.iter + ' | ' + prox + ' | ' + fc + ' | ' + vd + ' |');
  }
  if (trend.length > n) {
    lines.push('');
    lines.push('_（仅显示最近 ' + n + ' 轮，共 ' + trend.length + ' 轮）_');
  }
  return lines.join('\n');
}

/**
 * 把失败项明细渲染为 markdown 表格。
 * @param {Array} failedItems
 * @returns {string} markdown 片段（含表头），无数据时返回提示行
 */
function renderFailedItemsTable(failedItems) {
  if (!failedItems || !failedItems.length) {
    return '_（无失败项明细）_';
  }
  var lines = [];
  lines.push('| WP | 类别 | 检查项 | 原因 |');
  lines.push('|----|------|--------|------|');
  for (var i = 0; i < failedItems.length; i++) {
    var f = failedItems[i];
    lines.push(
      '| ' + (f.wpId || '-') + ' | ' + (f.category || '-') +
      ' | ' + (f.item || '-') + ' | ' + (f.reason || '-') + ' |'
    );
  }
  return lines.join('\n');
}

/**
 * 渲染完整 markdown 报告。
 * @param {object} report 结构化报告对象
 * @param {number} [trendTableLimit] markdown 趋势表显示最近 N 轮
 * @returns {string}
 */
function renderMarkdown(report, trendTableLimit) {
  var lines = [];
  lines.push('## Agentic Loop 终止报告');
  lines.push('');
  lines.push('**Loop ID**: `' + report.loopId + '`');
  lines.push('**终止原因**: ' + report.verdict);
  lines.push('**迭代轮次**: ' + report.iteration);
  lines.push('**生成时间**: ' + report.generatedAt);
  lines.push('');
  lines.push('### 结论');
  lines.push('');
  lines.push(report.summary);
  lines.push('');
  lines.push('### Proximity 趋势');
  lines.push('');
  var limit = (typeof trendTableLimit === 'number' && trendTableLimit > 0)
    ? trendTableLimit : DEFAULTS.trendTableLimit;
  lines.push(renderTrendTable(report.proximityTrend, limit));
  lines.push('');
  lines.push('### 失败项明细');
  lines.push('');
  lines.push(renderFailedItemsTable(report.failedItems));
  lines.push('');
  lines.push('### 建议下一步');
  lines.push('');
  lines.push('- ' + (VERDICT_SUMMARIES[report.verdict] || VERDICT_SUMMARIES.timeout));
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

module.exports = {
  /**
   * 生成触顶/发散/熔断总结报告（纯函数，无副作用）。
   *
   * @param {object} state LoopState（design.md §5.1.1），至少含 history / failingDrivers
   * @param {object} [opts] 可选参数
   * @param {string} [opts.loopId] 覆盖 state.loopId（出口调用方已知 loopId 时更可靠）
   * @param {string} [opts.verdict] 覆盖终态判定（出口调用方决定权优先）
   * @param {number} [opts.trendTableLimit] markdown 趋势表显示最近 N 轮
   * @returns {object} 报告对象：
   *   {
   *     loopId, verdict, iteration, proximityTrend, failedItems,
   *     summary, markdown, lastProximity, failedCount, generatedAt
   *   }
   */
  generateTerminalReport: function (state, opts) {
    // 容错：state 完全缺失 → 降级最小报告，不抛异常
    state = state || {};
    opts = opts || {};

    var loopId = opts.loopId || state.loopId || '';
    var verdict = normalizeVerdict(opts.verdict || state.lastVerdictVerdict ||
      (state.lastVerdict && state.lastVerdict.verdict) || state.status);

    var iteration = (typeof state.iteration === 'number') ? state.iteration : 0;

    var proximityTrend = extractProximityTrend(state);
    var failedItems = extractFailedItems(state);

    // 最终 proximity / 失败项数：优先趋势末轮，回退 lastEval
    var lastProximity = null;
    if (proximityTrend.length) {
      lastProximity = proximityTrend[proximityTrend.length - 1].proximity;
    } else if (state.lastEval && typeof state.lastEval.proximity === 'number') {
      lastProximity = state.lastEval.proximity;
    }
    var failedCount = failedItems.length;
    if (typeof failedCount !== 'number') failedCount = 0;

    var summary = buildSummary({
      verdict: verdict,
      iteration: iteration,
      failedCount: failedCount,
      lastProximity: lastProximity,
    });

    // 趋势表行数：opts 覆盖默认（局部变量，不污染模块级 DEFAULTS，保持纯函数）
    var trendTableLimit = (typeof opts.trendTableLimit === 'number' && opts.trendTableLimit > 0)
      ? opts.trendTableLimit : DEFAULTS.trendTableLimit;

    var report = {
      loopId: loopId,
      verdict: verdict,
      iteration: iteration,
      proximityTrend: proximityTrend,
      failedItems: failedItems,
      lastProximity: lastProximity,
      failedCount: failedCount,
      summary: summary,
      markdown: '',
      generatedAt: nowIso(),
    };

    report.markdown = renderMarkdown(report, trendTableLimit);

    return report;
  },

  // 暴露内部工具便于单元测试
  _extractProximityTrend: extractProximityTrend,
  _extractFailedItems: extractFailedItems,
  _normalizeVerdict: normalizeVerdict,
  _buildSummary: buildSummary,
  _renderTrendTable: renderTrendTable,
  _renderFailedItemsTable: renderFailedItemsTable,
  _renderMarkdown: renderMarkdown,
  _VERDICT_SUMMARIES: VERDICT_SUMMARIES,
  _DEFAULTS: DEFAULTS,
};
