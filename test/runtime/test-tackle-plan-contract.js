/**
 * Unit tests for skill-tackle-plan ↔ plan-reader 契约一致性 (WP-178-2-test)
 * Run with: node --test test/runtime/test-tackle-plan-contract.js
 *
 * 守门目的：skill-tackle-plan 生成的 plan（按其内置格式模板）必须能被
 * `plan-reader.parsePlanToGoal()` 正确解析。本测试把 skill-tackle-plan/skill.md
 * Step 5 的格式模板**实例化**为若干样本，逐项断言解析结果，确保两个产物间无契约漂移。
 *
 * 覆盖（对应 WP-178-2-test.md 任务清单）：
 *   - 正向：完整模板样本 → goal.wpIds 非空、checklist 含 category、dependencyGraph 正确、successCriteria 提取
 *   - 显式 WP-NNN 编号 + 派生编号 两种情况
 *   - 反向：缺任务项的 section → plan-no-executable-sections / wpIds 为空
 *   - 反向：循环依赖 → 抛 PLAN_CYCLIC_DEPENDENCY（或 hasCycle=true）
 *   - 反向：越界依赖被白名单过滤忽略（plan-reader.js:185-201）
 *
 * 锚定契约而非实现细节：所有断言基于 plan-reader.js 公开返回结构。
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var planReader = require('../../plugins/runtime/plan-reader');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-plan-contract-'));
}

/**
 * 把 plan 文本写到临时项目根的 .claude/plan.md，返回 {dir, planPath, cleanup}。
 * extra.taskMd 可注入 task.md（控制派生编号起点）。
 */
function setupPlan(content, extra) {
  extra = extra || {};
  var dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  var planPath = path.join(dir, '.claude', 'plan.md');
  if (content !== undefined && content !== null) {
    fs.writeFileSync(planPath, content, 'utf8');
  }
  if (extra.taskMd) {
    fs.writeFileSync(path.join(dir, 'task.md'), extra.taskMd, 'utf8');
  }
  return {
    dir: dir,
    planPath: planPath,
    cleanup: function () {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

/**
 * skill-tackle-plan/skill.md Step 5 格式模板的实例化样本。
 * 模板原文（见 plugins/core/skill-tackle-plan/skill.md:137-159）：
 *   # {标题}
 *   ## {工作单元}  内含 - [ ] 任务项 + [acceptance]/[unit] 前缀
 *   依赖 WP-N
 *   ## 成功标准  内含普通要点
 *
 * 本样本刻意覆盖模板全部契约要素：## section、- [ ]、[category] 前缀、
 * 依赖声明、## 成功标准 section。
 */
function buildTemplateSample() {
  return [
    '# 待办清单 CLI',
    '',
    '把自然语言需求分解为符合 plan-reader 契约的计划。',
    '',
    '## 实现命令解析模块',
    '- [ ] 解析 add/list/done 命令',
    '- [ ] [unit] 命令解析单测全绿',
    '- [ ] [acceptance] CLI 能本地运行且命令全部可用',
    '',
    '## 实现数据持久化',
    '依赖 WP-100',
    '- [ ] 数据持久化到 JSON 文件',
    '- [ ] [integration] 重启后数据仍在',
    '',
    '## 成功标准',
    '- CLI 能本地运行、命令全部可用、数据持久化到文件',
    '- npm test 全绿',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────
// Section 1: 正向 — 完整模板样本解析（核心守门用例）
// ─────────────────────────────────────────────

test.describe('正向：skill-tackle-plan 模板样本可被 plan-reader 正确解析', function () {
  test('完整模板样本 → goal.wpIds 非空且无 error', function () {
    var env = setupPlan(buildTemplateSample(), { taskMd: 'max WP-99' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null, '不应有 error');
      assert.ok(res.goal.wpIds.length > 0, 'goal.wpIds 必须非空（否则下游 loop 不启动）');
      assert.ok(res.workPackages.length === 2, '应解析出 2 个可执行工作单元');
    } finally {
      env.cleanup();
    }
  });

  test('checklist 解析正确：含 category 分类前缀', function () {
    var env = setupPlan(buildTemplateSample(), { taskMd: 'max WP-99' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      var cmd = res.workPackages[0];
      // 模板里的三类前缀：无前缀(默认 check) / [unit] / [acceptance]
      var cats = cmd.checklist.map(function (c) { return c.category; });
      assert.ok(cats.indexOf('check') !== -1, '默认 category=check');
      assert.ok(cats.indexOf('unit') !== -1, '[unit] 前缀被识别');
      assert.ok(cats.indexOf('acceptance') !== -1, '[acceptance] 前缀被识别');
      // item 文本应剥掉前缀
      var acc = cmd.checklist.find(function (c) { return c.category === 'acceptance'; });
      assert.ok(acc.item.indexOf('[acceptance]') === -1, 'item 文本不应残留 [acceptance] 前缀');
      assert.ok(acc.item.indexOf('CLI 能本地运行') !== -1);
    } finally {
      env.cleanup();
    }
  });

  test('dependencyGraph 正确：依赖语义建边 + 拓扑序 + 无环', function () {
    var env = setupPlan(buildTemplateSample(), { taskMd: 'max WP-99' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.dependencyGraph.hasCycle, false);
      // 模板里第二单元声明 依赖 WP-100（第一单元显式 WP-100 编号）
      var firstWp = res.workPackages[0].wpId;
      var secondWp = res.workPackages[1].wpId;
      assert.ok(res.dependencyGraph.nodes[secondWp].dependencies.indexOf(firstWp) !== -1,
        '第二单元应依赖第一单元');
      assert.ok(res.dependencyGraph.nodes[firstWp].dependents.indexOf(secondWp) !== -1,
        '反向 dependents 应含第二单元');
      // 拓扑序：第一单元先于第二单元
      assert.ok(res.dependencyGraph.order.indexOf(firstWp) <
        res.dependencyGraph.order.indexOf(secondWp));
    } finally {
      env.cleanup();
    }
  });

  test('successCriteria 正确：## 成功标准 section 被提取', function () {
    var env = setupPlan(buildTemplateSample(), { taskMd: 'max WP-99' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.ok(res.goal.successCriteria.length > 0, '应提取出成功标准');
      assert.ok(res.goal.successCriteria.some(function (s) { return s.indexOf('CLI 能本地运行') !== -1; }),
        '应含 CLI 运行标准');
      assert.ok(res.goal.successCriteria.some(function (s) { return s.indexOf('npm test 全绿') !== -1; }),
        '应含 npm test 标准');
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 2: 显式 WP-NNN 编号 vs 派生编号
// ─────────────────────────────────────────────

test.describe('编号：显式 WP-NNN 与派生编号两种情况', function () {
  test('显式 WP-NNN 编号：标题含编号则沿用', function () {
    var env = setupPlan(buildTemplateSample(), { taskMd: 'max WP-99' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      // 第一单元标题不含显式 WP-NNN（"实现命令解析模块"），靠派生；但模板第二单元
      // 声明依赖 WP-100——验证显式编号能力，这里单独构造一个显式编号样本更清晰。
      var firstWp = res.workPackages[0].wpId;
      // 第一单元无显式编号，task.md max=99 → 派生 WP-100
      assert.strictEqual(firstWp, 'WP-100');
    } finally {
      env.cleanup();
    }
  });

  test('显式编号样本：## WP-42 标题直接沿用 42', function () {
    var content = [
      '# 计划',
      '',
      '## WP-42: 模块 A',
      '- [ ] 实现 A',
      '',
      '## 模块 B',
      '- [ ] 实现 B',
      '',
      '## 成功标准',
      '- A 和 B 完成',
      '',
    ].join('\n');
    var env = setupPlan(content, { taskMd: 'max WP-99' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.workPackages[0].wpId, 'WP-42', '显式编号沿用');
      assert.strictEqual(res.workPackages[0]._derived, false, '非派生');
      // 第二个无显式编号，派生跳过已被占用的 42
      assert.notStrictEqual(res.workPackages[1].wpId, 'WP-42');
      assert.strictEqual(res.workPackages[1]._derived, true, '派生');
    } finally {
      env.cleanup();
    }
  });

  test('纯派生编号：无显式编号时按 task.md 最大编号 +1 派生', function () {
    var content = [
      '# 计划',
      '',
      '## 单元 A',
      '- [ ] 实现',
      '',
      '## 单元 B',
      '- [ ] 实现',
      '',
      '## 成功标准',
      '- 全部完成',
      '',
    ].join('\n');
    var env = setupPlan(content, { taskMd: '已有 WP-178 和 WP-179' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.workPackages[0].wpId, 'WP-180', 'max=179 → 派生 180');
      assert.strictEqual(res.workPackages[1].wpId, 'WP-181');
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 3: 反向 — 缺任务项 / 无可执行 section
// ─────────────────────────────────────────────

test.describe('反向：缺任务项的 section 导致无可执行单元', function () {
  test('纯叙述 section（无 - [ ] 任务项）→ plan-no-executable-sections', function () {
    // 这是 skill-tackle-plan 红线点名"最常见的失败之一"：
    // section 内只有文字描述、没有 - [ ] 任务项 → goal.wpIds 为空 → loop 不启动
    var content = [
      '# 计划',
      '',
      '## 背景说明',
      '这个计划要做一些事情，但只是叙述，没有任何可勾选任务项。',
      '',
      '## 目标描述',
      '目标是完成 X，但同样没有任务项。',
      '',
      '## 成功标准',
      '- 完成',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, 'plan-no-executable-sections',
        '纯叙述 section 应返回 plan-no-executable-sections');
      assert.deepStrictEqual(res.goal.wpIds, [], 'wpIds 应为空');
      assert.deepStrictEqual(res.workPackages, []);
    } finally {
      env.cleanup();
    }
  });

  test('混合：部分 section 有任务项、部分纯叙述 → 只取可执行的', function () {
    var content = [
      '# 计划',
      '',
      '## 背景说明',
      '纯叙述，无任务项。',
      '',
      '## 实现模块',
      '- [ ] 实现 A',
      '- [ ] 实现 B',
      '',
      '## 成功标准',
      '- A 和 B 完成',
      '',
    ].join('\n');
    var env = setupPlan(content, { taskMd: 'max WP-50' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.workPackages.length, 1, '只应保留含任务项的 1 个 section');
      assert.strictEqual(res.workPackages[0].checklist.length, 2);
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 4: 反向 — 循环依赖
// ─────────────────────────────────────────────

test.describe('反向：循环依赖', function () {
  test('A→B→A 循环依赖默认抛 PLAN_CYCLIC_DEPENDENCY', function () {
    // skill-tackle-plan 红线：生成时必须确保依赖无环；违反则 plan-reader 抛错
    var content = [
      '# 计划',
      '',
      '## WP-1: A',
      '依赖 WP-2',
      '- [ ] 实现 A',
      '',
      '## WP-2: B',
      'depends on WP-1',
      '- [ ] 实现 B',
      '',
      '## 成功标准',
      '- 完成',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      assert.throws(function () {
        planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      }, function (e) {
        return e.code === 'PLAN_CYCLIC_DEPENDENCY' &&
          Array.isArray(e.cycle) && e.cycle.length >= 2;
      }, '应抛 PLAN_CYCLIC_DEPENDENCY 并附 cycle');
    } finally {
      env.cleanup();
    }
  });

  test('throwOnCycle=false 不抛，但 dependencyGraph.hasCycle === true', function () {
    var content = [
      '# 计划',
      '',
      '## WP-1: A',
      '先完成 WP-2',
      '- [ ] 实现 A',
      '',
      '## WP-2: B',
      'requires WP-1',
      '- [ ] 实现 B',
      '',
      '## 成功标准',
      '- 完成',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({
        planFilePath: env.planPath,
        projectRoot: env.dir,
        throwOnCycle: false,
      });
      assert.ok(res.error, '应带 error 字段');
      assert.strictEqual(res.dependencyGraph.hasCycle, true);
      assert.ok(res.dependencyGraph.cycle.length >= 2, 'cycle 应含至少 2 个节点');
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 5: 反向 — 越界依赖被白名单过滤（plan-reader.js:185-201）
// ─────────────────────────────────────────────

test.describe('反向：越界依赖被白名单过滤忽略', function () {
  test('声明指向不存在 WP 的依赖 → 不建边、不报错', function () {
    // skill-tackle-plan 契约说明：派生编号生成时未知，越界依赖被白名单过滤忽略而非报错。
    var content = [
      '# 计划',
      '',
      '## WP-10: 模块',
      '依赖 WP-999（不存在的编号）',
      '- [ ] 实现',
      '',
      '## 成功标准',
      '- 完成',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null, '越界依赖不是错误');
      assert.deepStrictEqual(res.workPackages[0].dependencies, [], '越界依赖不应进入 dependencies');
      assert.strictEqual(res.dependencyGraph.edges.length, 0, '不应建边');
    } finally {
      env.cleanup();
    }
  });
});
