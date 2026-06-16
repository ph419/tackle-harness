/**
 * Unit tests for plan-reader (WP-177-1-impl-a)
 * Run with: node --test test/runtime/test-plan-reader.js
 *
 * 覆盖（对应 WP-177-1-impl-a.md 任务清单/验收标准）：
 *   - 正常多 section（≥3）解析为 WP 集合
 *   - checklist 提取（id 稳定性 / category / 勾选状态）
 *   - 依赖图构建（邻接 / 拓扑序 / dependents）
 *   - 循环依赖检测（默认抛 + throwOnCycle=false 不抛）
 *   - 空 plan / 缺失文件 / 读失败 降级不抛
 *   - 单 section（无标题兜底 / Step 行切分）
 *   - 任务项勾选状态识别（[ ]/[x]/[✓]/[X]）
 *   - 显式 WP-NNN 标题 vs 派生编号
 *   - 成功标准 section 抽取
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-reader-test-'));
}

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

// ─────────────────────────────────────────────
// Section 1: 正常多 section 解析
// ─────────────────────────────────────────────

test.describe('正常多 section 解析', function () {
  test('含 ≥3 个 section 解析为对应 WP 集合', function () {
    var content = [
      '# 总计划',
      '',
      '## 数据模型',
      '- [ ] 定义 User 表',
      '- [ ] 定义 Order 表',
      '',
      '## API 层',
      '- [ ] 实现 /users 路由',
      '',
      '## 前端组件',
      '- [ ] 创建 UserCard 组件',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      assert.ok(res.workPackages.length >= 3, '应解析出至少 3 个 WP');
      assert.strictEqual(res.workPackages.length, 3);
      assert.strictEqual(res.goal.wpIds.length, 3);
      // 派生编号应唯一且稳定
      var ids = res.workPackages.map(function (w) { return w.wpId; });
      var uniq = ids.filter(function (v, i, a) { return a.indexOf(v) === i; });
      assert.strictEqual(ids.length, uniq.length, 'wpId 唯一');
      // 标题提取正确
      var titles = res.workPackages.map(function (w) { return w.title; });
      assert.ok(titles.indexOf('数据模型') !== -1);
      assert.ok(titles.indexOf('API 层') !== -1);
      assert.ok(titles.indexOf('前端组件') !== -1);
    } finally {
      env.cleanup();
    }
  });

  test('checklist 每项有稳定 id 且跨轮一致', function () {
    var content = [
      '## 解析模块',
      '- [ ] 实现 A',
      '- [x] 实现 B',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var r1 = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      var r2 = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(r1.workPackages[0].checklist.length, 2);
      assert.strictEqual(r1.workPackages[0].checklist[0].id, r2.workPackages[0].checklist[0].id);
      assert.strictEqual(r1.workPackages[0].checklist[1].id, r2.workPackages[0].checklist[1].id);
      // id 形如 {slug}-{序号}
      assert.ok(/-\d+$/.test(r1.workPackages[0].checklist[0].id), 'id 应以序号结尾');
    } finally {
      env.cleanup();
    }
  });

  test('任务项勾选状态识别（[ ]/[x]/[X]/[✓]）', function () {
    var content = [
      '## 验收',
      '- [ ] 未完成项',
      '- [x] 已完成项',
      '- [X] 大写已完成',
      '- [✓] 对勾已完成',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      var chk = res.workPackages[0].checklist;
      assert.strictEqual(chk.length, 4);
      assert.strictEqual(chk[0].checked, false);
      assert.strictEqual(chk[1].checked, true);
      assert.strictEqual(chk[2].checked, true);
      assert.strictEqual(chk[3].checked, true);
    } finally {
      env.cleanup();
    }
  });

  test('category 从 [prefix] 前缀抽取', function () {
    var content = [
      '## 模块',
      '- [ ] [acceptance] 覆盖率达标',
      '- [ ] [unit] 单测全绿',
      '- [ ] 普通项无前缀',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      var chk = res.workPackages[0].checklist;
      assert.strictEqual(chk[0].category, 'acceptance');
      assert.strictEqual(chk[1].category, 'unit');
      assert.strictEqual(chk[2].category, 'check');
      assert.strictEqual(chk[0].item, '覆盖率达标');
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 2: 依赖图构建
// ─────────────────────────────────────────────

test.describe('依赖图构建', function () {
  test('显式 WP-NNN + 依赖语义构建正确依赖图', function () {
    var content = [
      '## WP-10: 基础模块',
      '- [ ] 实现 A',
      '',
      '## WP-11: 上层模块',
      '依赖 WP-10',
      '- [ ] 实现 B',
      '',
      '## WP-12: 最上层',
      'depends on WP-11',
      '- [ ] 实现 C',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      // 拓扑序：WP-10 先于 WP-11 先于 WP-12
      assert.strictEqual(res.dependencyGraph.order.indexOf('WP-10'), 0);
      assert.ok(res.dependencyGraph.order.indexOf('WP-10') < res.dependencyGraph.order.indexOf('WP-11'));
      assert.ok(res.dependencyGraph.order.indexOf('WP-11') < res.dependencyGraph.order.indexOf('WP-12'));
      // 邻接
      assert.ok(res.dependencyGraph.nodes['WP-11'].dependencies.indexOf('WP-10') !== -1);
      assert.ok(res.dependencyGraph.nodes['WP-12'].dependencies.indexOf('WP-11') !== -1);
      // 反向
      assert.ok(res.dependencyGraph.nodes['WP-10'].dependents.indexOf('WP-11') !== -1);
      assert.strictEqual(res.dependencyGraph.hasCycle, false);
    } finally {
      env.cleanup();
    }
  });

  test('依赖引用越界（指向不存在的 WP）被忽略', function () {
    var content = [
      '## WP-20: 模块',
      '依赖 WP-999',
      '- [ ] 实现 X',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.deepStrictEqual(res.workPackages[0].dependencies, []);
      assert.strictEqual(res.dependencyGraph.edges.length, 0);
    } finally {
      env.cleanup();
    }
  });

  test('自引用依赖被排除', function () {
    var content = [
      '## WP-30: 模块',
      '依赖 WP-30',
      '- [ ] 实现 Y',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.deepStrictEqual(res.workPackages[0].dependencies, []);
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 3: 循环依赖检测
// ─────────────────────────────────────────────

test.describe('循环依赖检测', function () {
  test('循环依赖默认抛 PLAN_CYCLIC_DEPENDENCY', function () {
    var content = [
      '## WP-1: A',
      '依赖 WP-2',
      '- [ ] 实现',
      '',
      '## WP-2: B',
      'depends on WP-1',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      assert.throws(function () {
        planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      }, function (e) {
        return e.code === 'PLAN_CYCLIC_DEPENDENCY' && Array.isArray(e.cycle) && e.cycle.length > 0;
      });
    } finally {
      env.cleanup();
    }
  });

  test('throwOnCycle=false 不抛，返回 error + cycle 字段', function () {
    var content = [
      '## WP-1: A',
      '依赖 WP-2',
      '- [ ] 实现',
      '',
      '## WP-2: B',
      '先完成 WP-1',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({
        planFilePath: env.planPath,
        projectRoot: env.dir,
        throwOnCycle: false,
      });
      assert.ok(res.error);
      assert.ok(res.error.indexOf('cyclic') !== -1 || res.error.indexOf('循环') !== -1);
      assert.strictEqual(res.dependencyGraph.hasCycle, true);
      assert.ok(res.dependencyGraph.cycle.length >= 2);
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 4: 容错（空 / 缺失 / 无可执行）
// ─────────────────────────────────────────────

test.describe('容错降级', function () {
  test('plan.md 不存在 → 降级结构不抛', function () {
    var env = setupPlan(undefined);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, 'plan-not-found');
      assert.deepStrictEqual(res.goal.wpIds, []);
      assert.deepStrictEqual(res.workPackages, []);
    } finally {
      env.cleanup();
    }
  });

  test('plan.md 为空 → 降级结构', function () {
    var env = setupPlan('   \n  \n');
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, 'plan-empty');
      assert.deepStrictEqual(res.workPackages, []);
    } finally {
      env.cleanup();
    }
  });

  test('plan.md 纯叙述无可执行 section → 降级', function () {
    var content = [
      '# 计划',
      '',
      '## 背景',
      '这是一个背景介绍，没有任务项。',
      '',
      '## 目标',
      '说明目标，但不包含执行性内容。',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, 'plan-no-executable-sections');
      assert.deepStrictEqual(res.workPackages, []);
    } finally {
      env.cleanup();
    }
  });

  test('读失败不抛（用目录伪装文件）', function () {
    var dir = makeTmpDir();
    try {
      // 把目录当 planPath 传入 → readFileSync 抛 EISDIR
      var res = planReader.parsePlanToGoal({ planFilePath: dir, projectRoot: dir });
      assert.ok(res.error);
      assert.ok(res.error.indexOf('plan-read-error') === 0 || res.error.indexOf('plan-not-found') === 0);
      assert.deepStrictEqual(res.workPackages, []);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
  });
});

// ─────────────────────────────────────────────
// Section 5: 单 section / Step 行切分 / 兜底
// ─────────────────────────────────────────────

test.describe('单 section 与 Step 切分', function () {
  test('单 section 含任务项 → 一个 WP', function () {
    var content = [
      '# 计划',
      '',
      '- [ ] 任务一',
      '- [ ] 任务二',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.workPackages.length, 1);
      assert.strictEqual(res.workPackages[0].checklist.length, 2);
    } finally {
      env.cleanup();
    }
  });

  test('无 section 标题但有 Step N: 行 → 按 Step 切分', function () {
    var content = [
      'Step 1: 实现解析',
      '- [ ] 写 A',
      '',
      'Step 2: 接入测试',
      '- [ ] 写测试',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.workPackages.length, 2);
      // Step 标题文本提取（去掉 "Step N:" 前缀）
      assert.strictEqual(res.workPackages[0].title, '实现解析');
      assert.strictEqual(res.workPackages[1].title, '接入测试');
    } finally {
      env.cleanup();
    }
  });

  test('### 子 section 在父 ## 下正确归属（同级截断）', function () {
    var content = [
      '## 父模块',
      '- [ ] 父任务',
      '',
      '### 子模块 A',
      '- [ ] 子任务 A1',
      '',
      '### 子模块 B',
      '- [ ] 子任务 B1',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      // 父 ## 的 body 在第一个 ### 处截断，故父模块只有 1 个任务项
      var parent = res.workPackages.find(function (w) { return w.title === '父模块'; });
      assert.ok(parent);
      assert.strictEqual(parent.checklist.length, 1);
      // 子模块各成独立 WP
      assert.strictEqual(res.workPackages.length, 3);
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 6: 编号派生 / 显式 WP-NNN
// ─────────────────────────────────────────────

test.describe('WP 编号分配', function () {
  test('task.md 最大编号 +1 派生起点', function () {
    var content = [
      '## 模块 A',
      '- [ ] 实现',
      '',
      '## 模块 B',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content, { taskMd: '已有 WP-176 和 WP-177\n' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      // task.md 最大 = 177 → 派生起点 178
      assert.strictEqual(res.workPackages[0].wpId, 'WP-178');
      assert.strictEqual(res.workPackages[1].wpId, 'WP-179');
    } finally {
      env.cleanup();
    }
  });

  test('无 task.md → 从 WP-1 派生', function () {
    var content = [
      '## 模块 A',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.workPackages[0].wpId, 'WP-1');
    } finally {
      env.cleanup();
    }
  });

  test('显式 WP-NNN 优先于派生', function () {
    var content = [
      '## WP-50: 特殊模块',
      '- [ ] 实现',
      '',
      '## 普通模块',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content, { taskMd: 'max WP-176' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.workPackages[0].wpId, 'WP-50');
      // 第二个派生，跳过已被占用的 50
      assert.notStrictEqual(res.workPackages[1].wpId, 'WP-50');
    } finally {
      env.cleanup();
    }
  });

  test('重复显式 WP-NNN → 第二个降级派生', function () {
    var content = [
      '## WP-60: 模块',
      '- [ ] 实现',
      '',
      '## WP-60: 重复',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content, { taskMd: 'max WP-176' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.workPackages[0].wpId, 'WP-60');
      assert.notStrictEqual(res.workPackages[1].wpId, 'WP-60');
      // wpId 唯一
      var ids = res.workPackages.map(function (w) { return w.wpId; });
      assert.strictEqual(ids.length, new Set(ids).size);
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 7: 成功标准 + checklistSpec + 内部工具
// ─────────────────────────────────────────────

test.describe('成功标准与聚合', function () {
  test('成功标准 section 抽取', function () {
    var content = [
      '## 实现模块',
      '- [ ] 实现 A',
      '',
      '## 成功标准',
      '- 全部单测通过',
      '- 覆盖率 ≥ 70%',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.ok(res.goal.successCriteria.indexOf('全部单测通过') !== -1);
      assert.ok(res.goal.successCriteria.indexOf('覆盖率 ≥ 70%') !== -1);
    } finally {
      env.cleanup();
    }
  });

  test('checklistSpec 聚合所有 WP 的 checklist', function () {
    var content = [
      '## WP-1: A',
      '- [ ] a1',
      '- [ ] a2',
      '',
      '## WP-2: B',
      '- [ ] b1',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.goal.checklistSpec.total, 3);
      assert.ok(res.goal.checklistSpec.byWp['WP-1'].length === 2);
      assert.ok(res.goal.checklistSpec.byWp['WP-2'].length === 1);
      // items 扁平且带 wpId
      assert.strictEqual(res.goal.checklistSpec.items[0].wpId, 'WP-1');
    } finally {
      env.cleanup();
    }
  });
});

test.describe('内部工具（白盒）', function () {
  test('slugify 归一化', function () {
    assert.strictEqual(planReader._slugify('数据 模型！'), 'wp'); // 全非 ASCII 折叠为空 → 'wp'
    assert.strictEqual(planReader._slugify('Data Model'), 'data-model');
    assert.strictEqual(planReader._slugify('  Foo--Bar  '), 'foo-bar');
    assert.strictEqual(planReader._slugify(''), 'wp');
    assert.strictEqual(planReader._slugify(null), 'wp');
  });

  test('parseTaskItem 识别/拒绝', function () {
    assert.deepStrictEqual(planReader._parseTaskItem('- [ ] hello'), { checked: false, text: 'hello' });
    assert.deepStrictEqual(planReader._parseTaskItem('* [x] done'), { checked: true, text: 'done' });
    assert.strictEqual(planReader._parseTaskItem('- not a task'), null);
    assert.strictEqual(planReader._parseTaskItem(''), null);
  });

  test('extractDependencyRefs 多语义 + 去重 + 白名单', function () {
    var text = '依赖 WP-1, depends on WP-2, 先完成 WP-1, after WP-3';
    var refs = planReader._extractDependencyRefs(text, ['WP-1', 'WP-2', 'WP-3']);
    assert.deepStrictEqual(refs, ['WP-1', 'WP-2', 'WP-3']);
    // 白名单过滤
    var refs2 = planReader._extractDependencyRefs(text, ['WP-1']);
    assert.deepStrictEqual(refs2, ['WP-1']);
    // 无白名单 → 全收
    var refs3 = planReader._extractDependencyRefs('依赖 WP-9');
    assert.deepStrictEqual(refs3, ['WP-9']);
    assert.deepStrictEqual(planReader._extractDependencyRefs(''), []);
  });

  test('readMaxWpNumber 扫描 task.md', function () {
    var dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'task.md'), 'WP-5 then WP-12 then WP-3', 'utf8');
      assert.strictEqual(planReader._readMaxWpNumber(dir), 12);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
    // 无 task.md → 0
    var dir2 = makeTmpDir();
    try {
      assert.strictEqual(planReader._readMaxWpNumber(dir2), 0);
    } finally {
      try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  test('buildDependencyGraph 拓扑序稳定', function () {
    var wpDeps = [
      { wpId: 'WP-1', dependencies: [] },
      { wpId: 'WP-2', dependencies: ['WP-1'] },
      { wpId: 'WP-3', dependencies: ['WP-1'] },
    ];
    var g = planReader._buildDependencyGraph(wpDeps);
    assert.strictEqual(g.hasCycle, false);
    assert.strictEqual(g.order[0], 'WP-1');
    // WP-2 / WP-3 都只依赖 WP-1，可在 WP-1 之后任意序但都出现
    assert.ok(g.order.indexOf('WP-2') > 0);
    assert.ok(g.order.indexOf('WP-3') > 0);
    assert.strictEqual(g.edges.length, 2);
  });
});

// ─────────────────────────────────────────────
// Section 8: 默认路径探测
// ─────────────────────────────────────────────

test.describe('默认路径探测', function () {
  test('默认读 .claude/plan.md（projectRoot 下）', function () {
    var env = setupPlan('## M\n- [ ] t\n');
    try {
      var res = planReader.parsePlanToGoal({ projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.workPackages.length, 1);
      assert.ok(res.planFilePath.indexOf('.claude') !== -1);
    } finally {
      env.cleanup();
    }
  });

  test('resolvePlanPath 优先用 planFilePath', function () {
    var p = planReader.resolvePlanPath({ planFilePath: '/abs/plan.md' });
    // POSIX 风格绝对路径在所有平台都判为绝对，原样返回
    assert.strictEqual(p, '/abs/plan.md');
  });
});
