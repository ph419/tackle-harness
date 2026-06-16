/**
 * loop-report 单元测试（WP-177-1-impl-c）
 *
 * 覆盖：
 *   - 三种终态 verdict（timeout/diverged/circuit_broken）报告生成
 *   - proximity 趋势表生成（最近 N 轮截断 + 全量结构体）
 *   - 失败项明细提取（state.failingDrivers 优先 / lastEval 回退）
 *   - 空 history 降级 / 缺失字段降级 / state 完全缺失降级（不抛异常）
 *   - markdown 格式正确（含表头/建议下一步/截断提示）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var loopReport = require('../../plugins/runtime/loop-report');

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/**
 * 构造一个含多轮 history + failingDrivers 的典型 state（timeout 出口）。
 */
function buildTimeoutState() {
  return {
    loopId: 'loop-abc',
    iteration: 6,
    status: 'timeout',
    lastVerdict: { verdict: 'timeout', reason: '迭代上限已达 max_iterations' },
    history: [
      { iteration: 1, eval: { proximity: 0.3, failedCount: 7 }, verdict: 'continue', timestamp: '2026-06-13T00:00:00.000Z' },
      { iteration: 2, eval: { proximity: 0.5, failedCount: 5 }, verdict: 'continue', timestamp: '2026-06-13T00:01:00.000Z' },
      { iteration: 3, eval: { proximity: 0.6, failedCount: 4 }, verdict: 'continue', timestamp: '2026-06-13T00:02:00.000Z' },
      { iteration: 4, eval: { proximity: 0.6, failedCount: 4 }, verdict: 'continue', timestamp: '2026-06-13T00:03:00.000Z' },
      { iteration: 5, eval: { proximity: 0.6, failedCount: 4 }, verdict: 'continue', timestamp: '2026-06-13T00:04:00.000Z' },
      { iteration: 6, eval: { proximity: 0.6, failedCount: 3 }, verdict: 'timeout', timestamp: '2026-06-13T00:05:00.000Z' },
    ],
    failingDrivers: [
      { wpId: 'WP-5', category: 'lint', item: 'no-unused-vars', reason: 'x 未使用' },
      { wpId: 'WP-5', category: 'test', item: 'case-3', reason: '断言失败' },
      { wpId: 'WP-7', category: 'build', item: 'tsc', reason: '类型错误' },
    ],
  };
}

function buildDivergedState() {
  return {
    loopId: 'loop-div',
    iteration: 4,
    status: 'diverged',
    lastVerdict: { verdict: 'diverged', reason: '连续 3 轮无进展' },
    history: [
      { iteration: 1, eval: { proximity: 0.4, failedCount: 6 }, verdict: 'continue' },
      { iteration: 2, eval: { proximity: 0.4, failedCount: 6 }, verdict: 'continue' },
      { iteration: 3, eval: { proximity: 0.4, failedCount: 6 }, verdict: 'continue' },
      { iteration: 4, eval: { proximity: 0.4, failedCount: 6 }, verdict: 'diverged' },
    ],
    // failingDrivers 缺失，用 lastEval 回退
    lastEval: {
      proximity: 0.4,
      failingDrivers: [
        { wpId: 'WP-9', category: 'review', item: 'missing-tests', reason: '无单测' },
      ],
    },
  };
}

function buildCircuitBrokenState() {
  return {
    loopId: 'loop-cb',
    iteration: 2,
    status: 'circuit_broken',
    lastVerdict: { verdict: 'circuit_broken', reason: 'watchdog 不健康' },
    history: [
      { iteration: 1, eval: { proximity: 0.2, failedCount: 8 }, verdict: 'continue' },
      { iteration: 2, eval: { proximity: 0.2, failedCount: 8 }, verdict: 'circuit_broken' },
    ],
    failingDrivers: [],
    lastEval: { proximity: 0.2, failingDrivers: [] },
  };
}

// ---------------------------------------------------------------------------
// 三种终态 verdict
// ---------------------------------------------------------------------------

test('timeout: 生成含趋势 + 失败明细的报告', function () {
  var report = loopReport.generateTerminalReport(buildTimeoutState());

  assert.equal(report.verdict, 'timeout');
  assert.equal(report.loopId, 'loop-abc');
  assert.equal(report.iteration, 6);
  assert.equal(report.proximityTrend.length, 6);
  assert.equal(report.failedItems.length, 3);
  assert.equal(report.failedCount, 3);
  assert.equal(report.lastProximity, 0.6);
  // 趋势首项与 history 一致
  assert.equal(report.proximityTrend[0].iter, 1);
  assert.equal(report.proximityTrend[0].proximity, 0.3);
  assert.equal(report.proximityTrend[0].verdict, 'continue');
  assert.equal(report.proximityTrend[0].failedCount, 7);
  // 末项
  var last = report.proximityTrend[5];
  assert.equal(last.iter, 6);
  assert.equal(last.proximity, 0.6);
  assert.equal(last.verdict, 'timeout');
});

test('diverged: 从 lastEval 回退失败项明细', function () {
  var report = loopReport.generateTerminalReport(buildDivergedState());

  assert.equal(report.verdict, 'diverged');
  assert.equal(report.proximityTrend.length, 4);
  // failingDrivers 缺失 → 从 lastEval.failingDrivers 取
  assert.equal(report.failedItems.length, 1);
  assert.equal(report.failedItems[0].wpId, 'WP-9');
  assert.equal(report.failedItems[0].item, 'missing-tests');
});

test('circuit_broken: 无失败项时不报错，明细为空', function () {
  var report = loopReport.generateTerminalReport(buildCircuitBrokenState());

  assert.equal(report.verdict, 'circuit_broken');
  assert.equal(report.proximityTrend.length, 2);
  assert.equal(report.failedItems.length, 0);
  assert.equal(report.failedCount, 0);
  assert.equal(report.lastProximity, 0.2);
});

// ---------------------------------------------------------------------------
// 趋势表 / 失败项明细渲染
// ---------------------------------------------------------------------------

test('proximityTrend 按 iteration 排序（乱序 history）', function () {
  var state = buildTimeoutState();
  // 打乱顺序
  state.history = [state.history[5], state.history[0], state.history[3]];
  var report = loopReport.generateTerminalReport(state);

  assert.equal(report.proximityTrend.length, 3);
  assert.equal(report.proximityTrend[0].iter, 1);
  assert.equal(report.proximityTrend[1].iter, 4);
  assert.equal(report.proximityTrend[2].iter, 6);
});

test('trendTableLimit 截断 markdown 趋势表（结构体仍全量）', function () {
  var state = buildTimeoutState();
  var report = loopReport.generateTerminalReport(state, { trendTableLimit: 2 });

  // 结构体含全部 6 轮
  assert.equal(report.proximityTrend.length, 6);
  // markdown 仅显示最近 2 轮 + 截断提示
  assert.match(report.markdown, /\| 5 \|/);
  assert.match(report.markdown, /\| 6 \|/);
  assert.doesNotMatch(report.markdown, /\| 1 \|/);
  assert.match(report.markdown, /仅显示最近 2 轮，共 6 轮/);
});

test('失败项明细各字段归一化（空字段填 -）', function () {
  var state = {
    loopId: 'l',
    iteration: 1,
    lastVerdict: { verdict: 'timeout' },
    history: [{ iteration: 1, eval: { proximity: 0.1, failedCount: 1 }, verdict: 'timeout' }],
    failingDrivers: [
      { wpId: 'WP-1' }, // 缺 category/item/reason
    ],
  };
  var report = loopReport.generateTerminalReport(state);
  assert.equal(report.failedItems[0].wpId, 'WP-1');
  assert.equal(report.failedItems[0].category, '');
  assert.equal(report.failedItems[0].item, '');
  assert.equal(report.failedItems[0].reason, '');
});

// ---------------------------------------------------------------------------
// 降级：空 history / 缺字段 / state 完全缺失
// ---------------------------------------------------------------------------

test('空 history 降级：不抛异常，产出最小报告', function () {
  var state = {
    loopId: 'loop-empty',
    iteration: 0,
    lastVerdict: { verdict: 'timeout' },
  };
  var report = loopReport.generateTerminalReport(state);

  assert.equal(report.verdict, 'timeout');
  assert.equal(report.iteration, 0);
  assert.equal(report.proximityTrend.length, 0);
  assert.equal(report.failedItems.length, 0);
  assert.equal(report.failedCount, 0);
  assert.equal(report.lastProximity, null);
  assert.equal(typeof report.markdown, 'string');
  assert.ok(report.markdown.length > 0);
});

test('缺失 lastVerdict / status：verdict 降级为 timeout', function () {
  var state = { loopId: 'l', iteration: 1, history: [] };
  var report = loopReport.generateTerminalReport(state);
  assert.equal(report.verdict, 'timeout');
});

test('history 项缺 eval.proximity：该轮 proximity 为 null，不影响其他轮', function () {
  var state = {
    loopId: 'l',
    iteration: 2,
    lastVerdict: { verdict: 'timeout' },
    history: [
      { iteration: 1, verdict: 'continue' }, // 无 eval
      { iteration: 2, eval: { proximity: 0.7, failedCount: 1 }, verdict: 'timeout' },
    ],
  };
  var report = loopReport.generateTerminalReport(state);
  assert.equal(report.proximityTrend.length, 2);
  assert.equal(report.proximityTrend[0].proximity, null);
  assert.equal(report.proximityTrend[1].proximity, 0.7);
  // 末轮 proximity 非 null 时 lastProximity 取末轮
  assert.equal(report.lastProximity, 0.7);
});

test('state 完全缺失（null）：降级最小报告不抛异常', function () {
  var report = loopReport.generateTerminalReport(null);
  assert.equal(report.verdict, 'timeout');
  assert.equal(report.iteration, 0);
  assert.equal(report.loopId, '');
  assert.equal(report.proximityTrend.length, 0);
  assert.equal(report.failedItems.length, 0);
  assert.equal(typeof report.markdown, 'string');
});

test('state 完全缺失（undefined）：降级最小报告不抛异常', function () {
  var report = loopReport.generateTerminalReport(undefined);
  assert.equal(report.verdict, 'timeout');
  assert.equal(report.iteration, 0);
});

// ---------------------------------------------------------------------------
// markdown 格式
// ---------------------------------------------------------------------------

test('markdown 含终止原因 / 迭代数 / 趋势表 / 失败明细表 / 建议下一步', function () {
  var report = loopReport.generateTerminalReport(buildTimeoutState());
  var md = report.markdown;

  assert.match(md, /## Agentic Loop 终止报告/);
  assert.match(md, /终止原因\*\*: timeout/);
  assert.match(md, /迭代轮次\*\*: 6/);
  assert.match(md, /### Proximity 趋势/);
  assert.match(md, /\| 轮次 \| proximity \| 失败项数 \| verdict \|/);
  assert.match(md, /### 失败项明细/);
  assert.match(md, /\| WP \| 类别 \| 检查项 \| 原因 \|/);
  assert.match(md, /### 建议下一步/);
  // timeout 建议文案
  assert.match(md, /已达轮次上限未达成/);
});

test('markdown 各 verdict 建议文案正确', function () {
  var timeoutMd = loopReport.generateTerminalReport(buildTimeoutState()).markdown;
  assert.match(timeoutMd, /调高 max_iterations/);

  var divMd = loopReport.generateTerminalReport(buildDivergedState()).markdown;
  assert.match(divMd, /调整目标或拆分失败 WP/);

  var cbMd = loopReport.generateTerminalReport(buildCircuitBrokenState()).markdown;
  assert.match(cbMd, /检查 watchdog\/dispatcher 健康/);
});

test('summary 一句话结论含轮次 / proximity / 失败项数 / verdict 文案', function () {
  var report = loopReport.generateTerminalReport(buildTimeoutState());
  assert.match(report.summary, /第 6 轮/);
  assert.match(report.summary, /timeout/);
  assert.match(report.summary, /proximity=0\.60/);
  assert.match(report.summary, /剩余失败项 3 个/);
});

// ---------------------------------------------------------------------------
// opts 覆盖
// ---------------------------------------------------------------------------

test('opts.loopId / opts.verdict 覆盖 state', function () {
  var state = buildTimeoutState();
  var report = loopReport.generateTerminalReport(state, {
    loopId: 'override-id',
    verdict: 'diverged',
  });
  assert.equal(report.loopId, 'override-id');
  assert.equal(report.verdict, 'diverged');
});

// ---------------------------------------------------------------------------
// 内部工具导出（便于回归）
// ---------------------------------------------------------------------------

test('_normalizeVerdict 未知值降级为 timeout', function () {
  assert.equal(loopReport._normalizeVerdict('foo'), 'timeout');
  assert.equal(loopReport._normalizeVerdict(undefined), 'timeout');
  assert.equal(loopReport._normalizeVerdict('diverged'), 'diverged');
});

test('_VERDICT_SUMMARIES 含三种终态', function () {
  var v = loopReport._VERDICT_SUMMARIES;
  assert.ok(v.timeout);
  assert.ok(v.diverged);
  assert.ok(v.circuit_broken);
});
