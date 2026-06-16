/**
 * Unit tests for reflection-evaluator (WP-174-3 / WP-174-6)
 * Run with: node --test test/runtime/test-reflection-evaluator.js
 *
 * 覆盖：
 *   - proximity 计算（checklist 优先、降级 workPackages）
 *   - 收敛/发散判定（_computeDivergenceStreak）
 *   - trend（improving/flat/regressing）
 *   - categoryScores / failingDrivers（CheckResult 解析）
 *   - recommendation 生成
 *   - item.id 跨轮稳定性（同 checklist 反复评分，streak 一致）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');

var evaluator = require('../../plugins/runtime/reflection-evaluator');

// ─────────────────────────────────────────────
// Section 1: 内部工具 _computeDivergenceStreak
// ─────────────────────────────────────────────

test.describe('_computeDivergenceStreak', function () {
  test('空序列 → 0', function () {
    assert.strictEqual(evaluator._computeDivergenceStreak([], 0.5), 0);
  });

  test('单元素序列：当前 <= 前驱 → streak=1', function () {
    // all=[0.3, 0.3]，0.3<=0.3 → streak=1（不增即计数）
    assert.strictEqual(evaluator._computeDivergenceStreak([0.3], 0.3), 1);
  });

  test('单元素序列：当前严格 > 前驱 → streak=0', function () {
    assert.strictEqual(evaluator._computeDivergenceStreak([0.3], 0.5), 0);
  });

  test('连续不增 → streak 累加', function () {
    // 历史 [0.5, 0.5]，当前 0.4：0.4<=0.5, 0.5<=0.5 → streak=2
    assert.strictEqual(evaluator._computeDivergenceStreak([0.5, 0.5], 0.4), 2);
  });

  test('遇严格递增即停', function () {
    // 历史 [0.3, 0.5]，当前 0.4：0.4<=0.5(streak1), 0.5>0.3 停 → streak=1
    assert.strictEqual(evaluator._computeDivergenceStreak([0.3, 0.5], 0.4), 1);
  });

  test('全程严格递增 → 0', function () {
    assert.strictEqual(evaluator._computeDivergenceStreak([0.1, 0.2], 0.3), 0);
  });
});

// ─────────────────────────────────────────────
// Section 2: _computeTrend
// ─────────────────────────────────────────────

test.describe('_computeTrend', function () {
  test('无历史 → flat', function () {
    assert.strictEqual(evaluator._computeTrend([], 0.5), 'flat');
  });
  test('上升 → improving', function () {
    assert.strictEqual(evaluator._computeTrend([0.3], 0.5), 'improving');
  });
  test('下降 → regressing', function () {
    assert.strictEqual(evaluator._computeTrend([0.5], 0.3), 'regressing');
  });
  test('相等 → flat', function () {
    assert.strictEqual(evaluator._computeTrend([0.5], 0.5), 'flat');
  });
});

// ─────────────────────────────────────────────
// Section 3: _proximityFromChecklist / _proximityFromWorkPackages
// ─────────────────────────────────────────────

test.describe('_proximityFromChecklist', function () {
  test('null → null', function () {
    assert.strictEqual(evaluator._proximityFromChecklist(null), null);
  });

  test('正常：failed/total → 1 - ratio', function () {
    var chk = { summary: { total: 4, passed: 3, failed: 1 } };
    assert.ok(Math.abs(evaluator._proximityFromChecklist(chk) - 0.75) < 1e-9);
  });

  test('全过 → 1', function () {
    var chk = { summary: { total: 5, passed: 5, failed: 0 } };
    assert.strictEqual(evaluator._proximityFromChecklist(chk), 1);
  });

  test('全失败 → 0', function () {
    var chk = { summary: { total: 5, passed: 0, failed: 5 } };
    assert.strictEqual(evaluator._proximityFromChecklist(chk), 0);
  });

  test('total=0 且 passed=true → 1', function () {
    assert.strictEqual(evaluator._proximityFromChecklist({ summary: { total: 0 }, passed: true }), 1);
  });

  test('failed 钳到 [0,total]', function () {
    // failed 超过 total 钳为 total → proximity 0
    var chk = { summary: { total: 3, passed: 3, failed: 99 } };
    assert.strictEqual(evaluator._proximityFromChecklist(chk), 0);
  });
});

test.describe('_proximityFromWorkPackages', function () {
  test('completed/total', function () {
    var wp = { total: 4, completed: ['a', 'b'] };
    assert.strictEqual(evaluator._proximityFromWorkPackages(wp), 0.5);
  });
  test('total=0 → 0', function () {
    assert.strictEqual(evaluator._proximityFromWorkPackages({ total: 0, completed: [] }), 0);
  });
  test('null → 0', function () {
    assert.strictEqual(evaluator._proximityFromWorkPackages(null), 0);
  });
});

// ─────────────────────────────────────────────
// Section 4: _categoryScoresFromChecklist / _failingDriversFromChecklist
// ─────────────────────────────────────────────

test.describe('_categoryScoresFromChecklist', function () {
  test('按类别细分通过率', function () {
    var chk = {
      categories: [
        { name: '代码', passed: true, items: [{ passed: true }, { passed: true }] },
        { name: '测试', passed: false, items: [{ passed: true }, { passed: false }] },
      ],
    };
    var scores = evaluator._categoryScoresFromChecklist(chk);
    assert.strictEqual(scores.length, 2);
    assert.strictEqual(scores[0].category, '代码');
    assert.strictEqual(scores[0].ratio, 1);
    assert.strictEqual(scores[1].category, '测试');
    assert.strictEqual(scores[1].ratio, 0.5);
  });

  test('无 categories → 空数组', function () {
    assert.deepStrictEqual(evaluator._categoryScoresFromChecklist(null), []);
  });
});

test.describe('_failingDriversFromChecklist', function () {
  test('failedItems → failingDrivers（保留 id/category/reason）', function () {
    var chk = {
      wpId: 'WP-7',
      failedItems: [
        { category: '测试', id: 'test-3', reason: '缺边界' },
        { category: '文档', id: 'doc-1', reason: '无注释' },
      ],
    };
    var drivers = evaluator._failingDriversFromChecklist(chk);
    assert.strictEqual(drivers.length, 2);
    assert.strictEqual(drivers[0].wpId, 'WP-7');
    assert.strictEqual(drivers[0].item, 'test-3');
    assert.strictEqual(drivers[1].category, '文档');
  });

  test('无 failedItems → 空', function () {
    assert.deepStrictEqual(evaluator._failingDriversFromChecklist({ wpId: 'x' }), []);
  });
});

// ─────────────────────────────────────────────
// Section 4b: _failingWpsFromChecklist 归一化（WP-176-1）
//   failedItems → 去重失败 WP id 列表（retry 链路源头归一化）。
// ─────────────────────────────────────────────

test.describe('_failingWpsFromChecklist (WP-176-1)', function () {
  test('多 failedItems 同 wpId（顶层）→ 去重单个', function () {
    var chk = {
      wpId: 'WP-5', passed: false,
      failedItems: [
        { category: '测试', id: 't1', reason: 'r' },
        { category: '文档', id: 'd1', reason: 'r' },
      ],
    };
    assert.deepStrictEqual(evaluator._failingWpsFromChecklist(chk), ['WP-5']);
  });

  test('多 failedItems 各带 fi.wpId → 多个去重 wpId', function () {
    var chk = {
      wpId: 'WP-9', passed: false,
      failedItems: [
        { wpId: 'WP-5', category: '测试', id: 't1', reason: 'r' },
        { wpId: 'WP-6', category: '测试', id: 't2', reason: 'r' },
        { wpId: 'WP-6', category: '文档', id: 'd1', reason: 'r' },
      ],
    };
    assert.deepStrictEqual(evaluator._failingWpsFromChecklist(chk), ['WP-5', 'WP-6']);
  });

  test('fi.wpId 优先于顶层 chk.wpId', function () {
    var chk = {
      wpId: 'WP-9', passed: false,
      failedItems: [{ wpId: 'WP-5', category: '测试', id: 't1', reason: 'r' }],
    };
    assert.deepStrictEqual(evaluator._failingWpsFromChecklist(chk), ['WP-5'], 'fi.wpId 覆盖顶层');
  });

  test('null chk → []', function () {
    assert.deepStrictEqual(evaluator._failingWpsFromChecklist(null), []);
  });

  test('无 failedItems → []', function () {
    assert.deepStrictEqual(evaluator._failingWpsFromChecklist({ wpId: 'WP-5', passed: true }), []);
  });

  test('空 wpId（顶层+fi 均无）→ 失败项丢弃 → []', function () {
    var chk = {
      wpId: '', passed: false,
      failedItems: [{ category: '测试', id: 't1', reason: 'r' }],
    };
    assert.deepStrictEqual(evaluator._failingWpsFromChecklist(chk), [], '无来源失败项无法定位 → 丢弃');
  });

  test('fi.wpId 为空字符串时回退顶层 wpId', function () {
    var chk = {
      wpId: 'WP-5', passed: false,
      failedItems: [
        { wpId: '', category: '测试', id: 't1', reason: 'r' }, // 空 fi.wpId → 回退顶层
      ],
    };
    assert.deepStrictEqual(evaluator._failingWpsFromChecklist(chk), ['WP-5']);
  });
});

// ─────────────────────────────────────────────
// Section 4c: 失败项数辅助（WP-176-5 输入）
//   _failedCountFromChecklist / _prevFailedCountFromHistory / _computeRefineProgress
// ─────────────────────────────────────────────

test.describe('_failedCountFromChecklist (WP-176-5)', function () {
  test('summary.failed 优先', function () {
    var chk = { summary: { total: 5, passed: 3, failed: 2 } };
    assert.strictEqual(evaluator._failedCountFromChecklist(chk), 2);
  });

  test('无 summary.failed 时回退 failedItems.length', function () {
    var chk = { summary: { total: 5, passed: 3 }, failedItems: [{}, {}, {}] };
    assert.strictEqual(evaluator._failedCountFromChecklist(chk), 3);
  });

  test('仅 total/passed → 推导 total-passed', function () {
    var chk = { summary: { total: 5, passed: 2 } };
    assert.strictEqual(evaluator._failedCountFromChecklist(chk), 3);
  });

  test('null chk → null', function () {
    assert.strictEqual(evaluator._failedCountFromChecklist(null), null);
  });

  test('total=0 且无 failed 字段 → null', function () {
    assert.strictEqual(evaluator._failedCountFromChecklist({ summary: { total: 0, passed: 0 } }), null);
  });
});

test.describe('_prevFailedCountFromHistory (WP-176-5)', function () {
  test('末轮 eval.failedCount 存在 → 返回', function () {
    var state = { history: [
      { iteration: 1, eval: { failedCount: 5 } },
      { iteration: 2, eval: { failedCount: 3 } },
    ] };
    assert.strictEqual(evaluator._prevFailedCountFromHistory(state), 3);
  });

  test('末轮无 failedCount → null（无法判定，调用方降级）', function () {
    var state = { history: [{ iteration: 1, eval: { proximity: 0.5 } }] };
    assert.strictEqual(evaluator._prevFailedCountFromHistory(state), null);
  });

  test('无 history → null', function () {
    assert.strictEqual(evaluator._prevFailedCountFromHistory({}), null);
  });

  test('null state → null', function () {
    assert.strictEqual(evaluator._prevFailedCountFromHistory(null), null);
  });
});

test.describe('_computeRefineProgress (WP-176-5)', function () {
  test('本轮严格少于上轮 → true（部分改进）', function () {
    assert.strictEqual(evaluator._computeRefineProgress(2, 5), true);
  });

  test('本轮等于上轮 → false（无效 retry，失败项不变）', function () {
    assert.strictEqual(evaluator._computeRefineProgress(3, 3), false);
  });

  test('本轮多于上轮 → false（回退，失败项增多）', function () {
    assert.strictEqual(evaluator._computeRefineProgress(5, 3), false);
  });

  test('本轮为 null（无 checklist） → false（降级）', function () {
    assert.strictEqual(evaluator._computeRefineProgress(null, 5), false);
  });

  test('上轮为 null（首轮/无 history） → false（降级）', function () {
    assert.strictEqual(evaluator._computeRefineProgress(2, null), false);
  });

  test('两者均 null → false', function () {
    assert.strictEqual(evaluator._computeRefineProgress(null, null), false);
  });
});

// ─────────────────────────────────────────────
// Section 5b: 发散宽容（WP-176-5 / 修复点 D / 修复偏差3）
//   部分改进（失败项减少）的 retry 轮不计入 divergenceStreak；
//   失败项不变/增多才累计。首轮/无 history 降级为 proximity-based 判定。
// ─────────────────────────────────────────────

test.describe('发散宽容 (WP-176-5)', function () {
  test('部分改进（失败项减少）→ streak 归零（不累计发散）', async function () {
    // proximity 不变（[0.5, 0.5]，当前 0.5），但 failedCount 5→3 减少
    var state = {
      history: [
        { iteration: 1, eval: { proximity: 0.5, failedCount: 5 } },
        { iteration: 2, eval: { proximity: 0.5, failedCount: 5 } },
      ],
    };
    // 当前轮：failed=2 → proximity=0.5 不变，但 failedCount 2 < 上轮 5 → 部分改进
    var snapshot = { lastChecklist: { passed: false, summary: { total: 4, passed: 2, failed: 2 } } };
    var out = await evaluator.score({}, 'loop-1', snapshot, state);
    assert.strictEqual(out.divergenceStreak, 0, '部分改进不计发散');
    assert.strictEqual(out.diverged, false);
    // failedCount 应写回，供下轮 prevFailed 比较
    assert.strictEqual(out.failedCount, 2);
  });

  test('无效 retry（失败项不变）→ streak 累计（正常发散）', async function () {
    // proximity 不变，failedCount 也不变（5→5）→ 无效 retry → 累计发散
    var state = {
      history: [
        { iteration: 1, eval: { proximity: 0.5, failedCount: 5 } },
        { iteration: 2, eval: { proximity: 0.5, failedCount: 5 } },
      ],
    };
    // 当前轮 failed=2 → proximity 0.5 不变；但上轮 failedCount=5，本轮 2<5 是部分改进
    // 为验证"不变"路径，上轮 failedCount 设为本轮同等值 2
    var stateFlat = {
      history: [
        { iteration: 1, eval: { proximity: 0.5, failedCount: 2 } },
        { iteration: 2, eval: { proximity: 0.5, failedCount: 2 } },
      ],
    };
    var snapshot = { lastChecklist: { passed: false, summary: { total: 4, passed: 2, failed: 2 } } };
    var out = await evaluator.score({}, 'loop-1', snapshot, stateFlat);
    assert.ok(out.divergenceStreak > 0, '失败项不变 → 累计发散');
    // history proximity [0.5, 0.5]，当前 0.5：all=[0.5,0.5,0.5] → streak=2
    assert.strictEqual(out.divergenceStreak, 2, '历史两轮 + 当前轮 proximity 均不变 → streak=2');
    assert.strictEqual(out.diverged, false, 'streak=2 未达阈值 3');
  });

  test('首轮无 history → refineProgressed=false 降级 proximity 判定', async function () {
    // 无 history，prevFailedCount=null → 降级，行为同旧逻辑（无 streak 累计）
    var snapshot = { lastChecklist: { passed: false, summary: { total: 4, passed: 2, failed: 2 } } };
    var out = await evaluator.score({}, 'loop-1', snapshot, {});
    assert.strictEqual(out.divergenceStreak, 0, '首轮无历史 → streak=0');
    assert.strictEqual(out.failedCount, 2);
  });

  test('无 checklist（curFailedCount=null）→ 降级 proximity 判定', async function () {
    var state = {
      history: [{ iteration: 1, eval: { proximity: 0.5, failedCount: 3 } }],
    };
    // 无 checklist → 基于 WP 完成度；curFailedCount=null → refineProgressed=false
    var snapshot = { workPackages: { total: 4, completed: ['a', 'b'], pending: ['c', 'd'], failed: [] } };
    var out = await evaluator.score({}, 'loop-1', snapshot, state);
    assert.strictEqual(out.failedCount, null);
    // proximity=0.5 = 上轮 0.5 → streak=1（proximity-based，未受 refine 宽容影响）
    assert.strictEqual(out.divergenceStreak, 1);
  });
});

// ─────────────────────────────────────────────
// Section 5: score 主流程
// ─────────────────────────────────────────────

test.describe('score', function () {
  test('无 checklist → 基于 WP 完成度降级', async function () {
    var snapshot = {
      workPackages: { total: 4, completed: ['a', 'b'], pending: ['c', 'd'], failed: [] },
    };
    var out = await evaluator.score({}, 'loop-1', snapshot, {});
    assert.ok(Math.abs(out.proximity - 0.5) < 1e-9);
    assert.strictEqual(out.allPassed, false, '有 pending 不算全过');
    assert.strictEqual(out.trend, 'flat', '无历史 → flat');
  });

  test('无 checklist 且 pending/failed 全空 + 满完成 → allPassed=true', async function () {
    var snapshot = {
      workPackages: { total: 2, completed: ['a', 'b'], pending: [], failed: [] },
    };
    var out = await evaluator.score({}, 'loop-1', snapshot, {});
    assert.strictEqual(out.proximity, 1);
    assert.strictEqual(out.allPassed, true);
  });

  test('有 checklist → proximity 基于失败率，allPassed 跟随 chk.passed', async function () {
    var snapshot = {
      lastChecklist: { wpId: 'WP-1', passed: false, summary: { total: 4, passed: 3, failed: 1 } },
    };
    var out = await evaluator.score({}, 'loop-1', snapshot, {});
    assert.ok(Math.abs(out.proximity - 0.75) < 1e-9);
    assert.strictEqual(out.allPassed, false);
  });

  test('连续 N 轮无进展 → diverged=true（达到阈值 3）', async function () {
    // 构造 history：proximity 序列 [0.5, 0.5]，当前 0.5 → streak=2（未达 3）
    var state2 = { history: [{ iteration: 1, eval: { proximity: 0.5 } }, { iteration: 2, eval: { proximity: 0.5 } }] };
    var snapshot = { lastChecklist: { passed: false, summary: { total: 4, passed: 2, failed: 2 } } }; // proximity 0.5
    var out2 = await evaluator.score({}, 'loop-1', snapshot, state2);
    assert.strictEqual(out2.divergenceStreak, 2);
    assert.strictEqual(out2.diverged, false, 'streak=2 未达阈值 3');

    // 加到 streak=3 → diverged
    var state3 = {
      history: [
        { iteration: 1, eval: { proximity: 0.5 } },
        { iteration: 2, eval: { proximity: 0.5 } },
        { iteration: 3, eval: { proximity: 0.5 } },
      ],
    };
    var out3 = await evaluator.score({}, 'loop-1', snapshot, state3);
    assert.strictEqual(out3.divergenceStreak, 3);
    assert.strictEqual(out3.diverged, true, 'streak=3 达阈值');
  });

  test('proximity 改进 → converged=true, trend=improving, streak 归零', async function () {
    var state = { history: [{ iteration: 1, eval: { proximity: 0.5 } }] };
    var snapshot = { lastChecklist: { passed: false, summary: { total: 4, passed: 3, failed: 1 } } }; // 0.75
    var out = await evaluator.score({}, 'loop-1', snapshot, state);
    assert.strictEqual(out.converged, true);
    assert.strictEqual(out.trend, 'improving');
    assert.strictEqual(out.divergenceStreak, 0);
  });

  test('已达达成态（proximity 满分 + allPassed）不判发散', async function () {
    // streak 本应累积，但 proximity 达 goal + allPassed → streak 归零
    var state = {
      history: [
        { iteration: 1, eval: { proximity: 1 } },
        { iteration: 2, eval: { proximity: 1 } },
      ],
    };
    var snapshot = { lastChecklist: { passed: true, summary: { total: 4, passed: 4, failed: 0 } } };
    var out = await evaluator.score({}, 'loop-1', snapshot, state);
    assert.strictEqual(out.proximity, 1);
    assert.strictEqual(out.allPassed, true);
    assert.strictEqual(out.divergenceStreak, 0, '达成态不发散');
    assert.strictEqual(out.diverged, false);
  });

  test('context.getConfig 提供阈值时覆盖默认', async function () {
    var ctx = {
      getConfig: function () { return { divergence_threshold: 1, proximity_goal: 0.95 }; },
    };
    // 默认阈值 3；这里改为 1：单轮不增即发散
    var state = { history: [{ iteration: 1, eval: { proximity: 0.5 } }] };
    var snapshot = { lastChecklist: { passed: false, summary: { total: 4, passed: 2, failed: 2 } } };
    var out = await evaluator.score(ctx, 'loop-1', snapshot, state);
    assert.strictEqual(out.divergenceStreak, 1);
    assert.strictEqual(out.diverged, true, '阈值 1 时单轮即发散');
  });
});

// ─────────────────────────────────────────────
// Section 6: _buildRecommendation
// ─────────────────────────────────────────────

test.describe('_buildRecommendation', function () {
  test('有失败项 → retry_WP', function () {
    var rec = evaluator._buildRecommendation({
      failingDrivers: [{ wpId: 'WP-3', category: '测试' }],
      proximity: 0.5, proximityGoal: 0.9, allPassed: false,
    });
    assert.ok(rec.indexOf('retry_WP-3') === 0, rec);
  });

  test('同 WP 同 category 重复失败 → resplit_WP（dup 检测）', function () {
    var rec = evaluator._buildRecommendation({
      failingDrivers: [
        { wpId: 'WP-3', category: '测试' },
        { wpId: 'WP-3', category: '测试' },
      ],
      proximity: 0.5, proximityGoal: 0.9, allPassed: false,
    });
    assert.ok(rec.indexOf('resplit_WP-3') === 0, rec);
  });

  test('同 WP 不同 category 失败 → 仍 retry_WP（非重复 category）', function () {
    var rec = evaluator._buildRecommendation({
      failingDrivers: [
        { wpId: 'WP-3', category: '测试' },
        { wpId: 'WP-3', category: '文档' },
      ],
      proximity: 0.5, proximityGoal: 0.9, allPassed: false,
    });
    assert.ok(rec.indexOf('retry_WP-3') === 0, rec);
  });

  test('无失败 + 全过 + proximity 达标 → achieved', function () {
    var rec = evaluator._buildRecommendation({
      failingDrivers: [], proximity: 0.95, proximityGoal: 0.9, allPassed: true,
    });
    assert.strictEqual(rec, 'achieved');
  });

  test('否则 → continue', function () {
    var rec = evaluator._buildRecommendation({
      failingDrivers: [], proximity: 0.5, proximityGoal: 0.9, allPassed: false,
    });
    assert.strictEqual(rec, 'continue');
  });
});

// ─────────────────────────────────────────────
// Section 7: item.id 跨轮稳定（评分侧不变量）
//   同一份 checklist（含稳定 id）反复评分，failingDrivers 中的 item 字段不变。
//   这验证了发散检测依赖的"同一失败项 id"在评分层是确定性的。
// ─────────────────────────────────────────────

test.describe('item.id 跨轮稳定', function () {
  test('相同 checklist 多轮评分 → failingDrivers 的 item 完全一致', async function () {
    var snapshot = {
      lastChecklist: {
        wpId: 'WP-9',
        passed: false,
        summary: { total: 3, passed: 2, failed: 1 },
        failedItems: [{ category: '测试', id: 'test-3', reason: '缺边界' }],
      },
    };
    var state = {};
    var r1 = await evaluator.score({}, 'loop-1', snapshot, state);
    var r2 = await evaluator.score({}, 'loop-1', snapshot, state);
    assert.deepStrictEqual(r1.failingDrivers, r2.failingDrivers, '两轮 failingDrivers 一致');
    assert.strictEqual(r1.failingDrivers[0].item, 'test-3');
  });
});
