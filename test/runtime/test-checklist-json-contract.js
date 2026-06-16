/**
 * Unit tests for skill-checklist 机器可读契约 (design.md §5.4 / WP-174-6)
 * Run with: node --test test/runtime/test-checklist-json-contract.js
 *
 * 说明：json:machine-readable block 的"文本→对象"解析由 Claude 在执行
 * skill-checklist 时于运行时完成（非 JS 函数）。本测试覆盖可测的契约层：
 *   1. 构造符合 design.md §5.4.2 格式的 Report 文本（含 json:machine-readable block）
 *   2. 用 JSON.parse 从 block 中提取 CheckResult（模拟运行时解析）
 *   3. 验证提取出的 CheckResult 能被 reflection-evaluator.score 正确消费
 *   4. 验证 item.id 跨轮稳定（同 id 反复解析/评分，failingDrivers 不变）
 *   5. 向后兼容：现有人类可读 Markdown 表格不被 JSON block 破坏
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');

var evaluator = require('../../plugins/runtime/reflection-evaluator');

// ─────────────────────────────────────────────
// 构造符合 design.md §5.4.2 的 Report 文本
// ─────────────────────────────────────────────

function buildReportText(opts) {
  opts = opts || {};
  var humanTable = [
    '# Checklist Report — WP-XXX',
    '',
    '| 类别 | 状态 | 通过/总数 |',
    '|------|------|-----------|',
    '| 代码质量 | ✅ | 2/2 |',
    '| 测试检查 | ❌ | 1/2 |',
    '',
    '**状态**: 部分通过，2 项失败',
    '',
    '<!-- 以下为机器可读判定，供 reflection-evaluator 消费，请勿手改 -->',
  ].join('\n');

  var machine = {
    wpId: opts.wpId || 'WP-XXX',
    checkedAt: '2026-06-12T14:40:00Z',
    passed: opts.passed === undefined ? false : opts.passed,
    summary: opts.summary || { total: 4, passed: 3, failed: 1 },
    categories: opts.categories || [
      { name: '代码质量', passed: true, items: [
        { id: 'code-1', text: '代码符合规范', passed: true },
        { id: 'code-2', text: '无编译错误', passed: true },
      ] },
      { name: '测试检查', passed: false, items: [
        { id: 'test-3', text: '边界情况已覆盖', passed: false, reason: '缺少边界 X' },
        { id: 'test-4', text: '单元测试通过', passed: true },
      ] },
    ],
    failedItems: opts.failedItems || [
      { category: '测试检查', id: 'test-3', reason: '缺少边界 X' },
    ],
  };

  return humanTable + '\n```json:machine-readable\n' + JSON.stringify(machine, null, 2) + '\n```\n';
}

/**
 * 模拟运行时解析：从 Report 文本提取 json:machine-readable block 并 JSON.parse。
 * 这正是 skill-checklist 执行时 Claude 所做的等价操作。
 */
function parseCheckResult(reportText) {
  var m = reportText.match(/```json:machine-readable\n([\s\S]*?)\n```/);
  assert.ok(m, 'Report 应含 json:machine-readable block');
  return JSON.parse(m[1]);
}

// ─────────────────────────────────────────────
// Section 1: Report 文本 → CheckResult 解析
// ─────────────────────────────────────────────

test.describe('Report 文本解析', function () {
  test('从 Report 文本提取 CheckResult，字段完整', function () {
    var text = buildReportText();
    var chk = parseCheckResult(text);
    assert.strictEqual(chk.wpId, 'WP-XXX');
    assert.strictEqual(chk.passed, false);
    assert.strictEqual(chk.summary.total, 4);
    assert.strictEqual(chk.summary.failed, 1);
    assert.strictEqual(chk.categories.length, 2);
    assert.strictEqual(chk.failedItems[0].id, 'test-3');
  });

  test('全过场景：passed=true，failedItems 空', function () {
    var text = buildReportText({
      passed: true,
      summary: { total: 4, passed: 4, failed: 0 },
      categories: [
        { name: '代码质量', passed: true, items: [{ id: 'code-1', passed: true }] },
      ],
      failedItems: [],
    });
    var chk = parseCheckResult(text);
    assert.strictEqual(chk.passed, true);
    assert.deepStrictEqual(chk.failedItems, []);
  });

  test('向后兼容：人类可读 Markdown 表格在 JSON block 之前且完整', function () {
    var text = buildReportText();
    // 表格部分必须在 json block 之前（追加式，不破坏）
    var tableIdx = text.indexOf('| 类别 | 状态 |');
    var blockIdx = text.indexOf('```json:machine-readable');
    assert.ok(tableIdx > -1, '含人类可读表格');
    assert.ok(blockIdx > -1, '含机器可读 block');
    assert.ok(tableIdx < blockIdx, '表格在 block 之前（追加式不破坏现有输出）');
    assert.ok(text.indexOf('# Checklist Report') === 0, '标题仍在开头');
  });
});

// ─────────────────────────────────────────────
// Section 2: CheckResult → reflection-evaluator 消费
// ─────────────────────────────────────────────

test.describe('CheckResult 消费', function () {
  test('解析出的 CheckResult 经 evaluator.score 产出正确 proximity/failingDrivers', async function () {
    var chk = parseCheckResult(buildReportText());
    var snapshot = { lastChecklist: chk };
    var out = await evaluator.score({}, 'loop-1', snapshot, {});
    // proximity = 1 - 1/4 = 0.75
    assert.ok(Math.abs(out.proximity - 0.75) < 1e-9);
    assert.strictEqual(out.allPassed, false);
    assert.strictEqual(out.failingDrivers.length, 1);
    assert.strictEqual(out.failingDrivers[0].wpId, 'WP-XXX');
    assert.strictEqual(out.failingDrivers[0].item, 'test-3');
    assert.strictEqual(out.failingDrivers[0].category, '测试检查');
  });

  test('categoryScores 按类别细分（代码 2/2，测试 1/2）', async function () {
    var chk = parseCheckResult(buildReportText());
    var out = await evaluator.score({}, 'loop-1', { lastChecklist: chk }, {});
    var scoresByName = {};
    out.categoryScores.forEach(function (c) { scoresByName[c.category] = c; });
    assert.strictEqual(scoresByName['代码质量'].ratio, 1);
    assert.strictEqual(scoresByName['测试检查'].ratio, 0.5);
  });

  test('recommendation 含 retry_WP-XXX（失败项驱动 refine）', async function () {
    var chk = parseCheckResult(buildReportText());
    var out = await evaluator.score({}, 'loop-1', { lastChecklist: chk }, {});
    assert.ok(out.recommendation.indexOf('retry_WP-XXX') === 0, out.recommendation);
  });
});

// ─────────────────────────────────────────────
// Section 3: item.id 跨轮稳定（核心场景）
//   同一份 Report 文本（含稳定 id）反复解析 + 评分，
//   failingDrivers 中的 item 字段多轮完全一致 —— 发散检测的前提。
// ─────────────────────────────────────────────

test.describe('item.id 跨轮稳定', function () {
  test('同一 Report 多轮解析：CheckResult.failingItems[0].id 恒为 test-3', function () {
    var text = buildReportText();
    var ids = [];
    for (var i = 0; i < 5; i++) {
      var chk = parseCheckResult(text);
      ids.push(chk.failedItems[0].id);
    }
    ids.forEach(function (id) { assert.strictEqual(id, 'test-3'); });
  });

  test('同一 CheckResult 多轮评分：failingDrivers 完全一致（确定性）', async function () {
    var chk = parseCheckResult(buildReportText());
    var snapshot = { lastChecklist: chk };
    var r1 = await evaluator.score({}, 'loop-1', snapshot, {});
    var r2 = await evaluator.score({}, 'loop-1', snapshot, {});
    var r3 = await evaluator.score({}, 'loop-1', snapshot, {});
    assert.deepStrictEqual(r1.failingDrivers, r2.failingDrivers);
    assert.deepStrictEqual(r2.failingDrivers, r3.failingDrivers);
    assert.strictEqual(r1.proximity, r2.proximity);
  });

  test('不同 Report 但同 id（同一失败项反复失败）→ failingDrivers.item 一致', async function () {
    // 模拟连续两轮：同一 test-3 失败项反复失败（仅 reason 变化）
    var round1 = parseCheckResult(buildReportText({
      failedItems: [{ category: '测试检查', id: 'test-3', reason: '缺少边界 X' }],
    }));
    var round2 = parseCheckResult(buildReportText({
      failedItems: [{ category: '测试检查', id: 'test-3', reason: '仍缺少边界 X（第二轮）' }],
    }));
    var o1 = await evaluator.score({}, 'l', { lastChecklist: round1 }, {});
    var o2 = await evaluator.score({}, 'l', { lastChecklist: round2 }, {});
    assert.strictEqual(o1.failingDrivers[0].item, 'test-3');
    assert.strictEqual(o2.failingDrivers[0].item, 'test-3', '跨轮 id 稳定，发散检测可比对');
  });
});
