/**
 * Unit tests for skill-agentic-loop Step 0 路径解析衔接 (WP-178-2-test)
 * Run with: node --test test/runtime/test-agentic-loop-plan-path.js
 *
 * 背景：skill-agentic-loop Step 0 路径 A 的三级路径优先级
 *   （参数路径 > `.claude/plan.md` > docs/plan 扫描）
 * 是 **skill 行为指令**（Claude 在运行时复现），不是某个 JS 函数。因此本测试
 * 以两类断言为主：
 *
 *   1. **plan-reader 路径解析行为**（可 JS 测的部分）：
 *      - 参数路径（planFilePath）优先于默认 `.claude/plan.md`
 *      - 绝对路径 / 相对路径 都能被 resolvePlanPath 正确解析
 *      - 默认无 planFilePath 时回退到 `.claude/plan.md`
 *
 *   2. **文档约定存在性**（grep 验证 skill.md 把三级优先级/输出路径约定写进去了）：
 *      - skill-agentic-loop/skill.md 含三级路径优先级表（优先级 1/2/3 + docs/plan 扫描）
 *      - skill-tackle-plan/skill.md 含输出到 docs/plan/ 的约定
 *      - 两份文档对「参数路径优先级 1」的描述一致
 *
 * 覆盖（对应 WP-178-2-test.md 任务清单）：
 *   - 优先级 1：planFilePath 参数命中
 *   - 优先级 2：默认 .claude/plan.md 命中
 *   - 优先级 3：docs/plan 扫描（行为层用 fs 模拟"取最新 .md"的语义）
 *   - 文档存在性：grep 两份 skill.md
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var planReader = require('../../plugins/runtime/plan-reader');

var AGENTIC_LOOP_SKILL = path.join(__dirname, '..', '..', 'plugins', 'core', 'skill-agentic-loop', 'skill.md');
var TACKLE_PLAN_SKILL = path.join(__dirname, '..', '..', 'plugins', 'core', 'skill-tackle-plan', 'skill.md');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-loop-path-'));
}

function writeFile(dir, relPath, content) {
  var abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

// ─────────────────────────────────────────────
// Section 1: 优先级 1 — 参数路径（planFilePath）命中
// ─────────────────────────────────────────────

test.describe('优先级 1：planFilePath 参数优先', function () {
  test('传入 planFilePath 指向 docs/plan/xxx.md → 读该文件', function () {
    var dir = makeTmpDir();
    try {
      var planContent = [
        '# 计划',
        '',
        '## 模块 A',
        '- [ ] 实现',
        '',
        '## 成功标准',
        '- 完成',
        '',
      ].join('\n');
      // 在 docs/plan/ 下放一份计划（模拟 skill-tackle-plan 的产物）
      var docsPlan = writeFile(dir, path.join('docs', 'plan', 'todo-cli.md'), planContent);
      // 解析时显式传 planFilePath（对应 /skill-agentic-loop docs/plan/todo-cli.md）
      var res = planReader.parsePlanToGoal({ planFilePath: docsPlan, projectRoot: dir });
      assert.strictEqual(res.error, null);
      assert.ok(res.goal.wpIds.length > 0, '应解析出 WP');
      // planFilePath 应指向 docs/plan/todo-cli.md
      assert.ok(res.planFilePath.indexOf('docs') !== -1, 'planFilePath 应反映参数路径');
      assert.ok(res.planFilePath.indexOf('todo-cli') !== -1);
    } finally {
      cleanup(dir);
    }
  });

  test('resolvePlanPath：绝对 planFilePath 原样返回，相对路径按 cwd 解析', function () {
    // 绝对路径（POSIX 风格在所有平台判为绝对）
    assert.strictEqual(planReader.resolvePlanPath({ planFilePath: '/abs/x.md' }), '/abs/x.md');
    // 相对路径 → path.resolve（相对当前 cwd）
    var rel = planReader.resolvePlanPath({ planFilePath: 'docs/plan/todo.md' });
    assert.ok(rel.indexOf('docs') !== -1 && rel.indexOf('todo.md') !== -1);
    assert.strictEqual(path.isAbsolute(rel), true, '相对路径应被解析为绝对路径');
  });
});

// ─────────────────────────────────────────────
// Section 2: 优先级 2 — 默认 .claude/plan.md 命中
// ─────────────────────────────────────────────

test.describe('优先级 2：默认 .claude/plan.md', function () {
  test('无 planFilePath 时回退到 projectRoot/.claude/plan.md', function () {
    var dir = makeTmpDir();
    try {
      var planContent = [
        '## 模块 A',
        '- [ ] 实现',
        '',
        '## 成功标准',
        '- 完成',
        '',
      ].join('\n');
      writeFile(dir, path.join('.claude', 'plan.md'), planContent);
      // 不传 planFilePath → 走默认路径（优先级 2）
      var res = planReader.parsePlanToGoal({ projectRoot: dir });
      assert.strictEqual(res.error, null);
      assert.ok(res.goal.wpIds.length > 0);
      assert.ok(res.planFilePath.indexOf('.claude') !== -1, '默认应读 .claude/plan.md');
      assert.ok(res.planFilePath.indexOf('plan.md') !== -1);
    } finally {
      cleanup(dir);
    }
  });

  test('.claude/plan.md 不存在且无参数 → plan-not-found', function () {
    var dir = makeTmpDir();
    try {
      var res = planReader.parsePlanToGoal({ projectRoot: dir });
      assert.strictEqual(res.error, 'plan-not-found');
      assert.deepStrictEqual(res.goal.wpIds, []);
    } finally {
      cleanup(dir);
    }
  });
});

// ─────────────────────────────────────────────
// Section 3: 优先级 3 — docs/plan 扫描（行为层模拟）
// ─────────────────────────────────────────────

test.describe('优先级 3：docs/plan 扫描语义', function () {
  test('取 docs/plan/ 下最近修改的 .md 作为 planFilePath', function () {
    // skill 行为是"Claude 扫描 docs/plan/*.md 取最新"——本测试用 fs 复现该语义：
    // 确认 (a) 能列出 docs/plan/*.md，(b) 选出的最新文件能被 plan-reader 解析。
    var dir = makeTmpDir();
    try {
      var older = [
        '## 旧计划',
        '- [ ] 旧任务',
        '',
        '## 成功标准',
        '- 旧完成',
        '',
      ].join('\n');
      var newer = [
        '## 新计划',
        '- [ ] 新任务',
        '',
        '## 成功标准',
        '- 新完成',
        '',
      ].join('\n');
      var olderPath = writeFile(dir, path.join('docs', 'plan', 'a-old.md'), older);
      var newerPath = writeFile(dir, path.join('docs', 'plan', 'b-new.md'), newer);
      // 让 b-new.md 的 mtime 明确晚于 a-old.md
      var past = new Date(Date.now() - 60000);
      var now = new Date();
      fs.utimesSync(olderPath, past, past);
      fs.utimesSync(newerPath, now, now);

      // 扫描语义：列 .md → 取最新
      var files = fs.readdirSync(path.join(dir, 'docs', 'plan'))
        .filter(function (f) { return /\.md$/i.test(f); })
        .map(function (f) {
          var p = path.join(dir, 'docs', 'plan', f);
          return { file: f, mtime: fs.statSync(p).mtimeMs, path: p };
        })
        .sort(function (x, y) { return y.mtime - x.mtime; });
      assert.strictEqual(files.length, 2, '应扫描到 2 个 .md');
      assert.strictEqual(files[0].file, 'b-new.md', '最新应是 b-new.md');

      // 选出的最新文件交给 plan-reader，能正常解析
      var res = planReader.parsePlanToGoal({ planFilePath: files[0].path, projectRoot: dir });
      assert.strictEqual(res.error, null);
      assert.ok(res.goal.wpIds.length > 0);
      assert.ok(res.workPackages[0].title.indexOf('新计划') !== -1, '应读到最新的那份');
    } finally {
      cleanup(dir);
    }
  });
});

// ─────────────────────────────────────────────
// Section 4: 文档约定存在性（grep 两份 skill.md）
// ─────────────────────────────────────────────

test.describe('文档约定：三级路径优先级 + 输出路径已写入 skill.md', function () {
  test('skill-agentic-loop/skill.md 含三级路径优先级表（优先级 1/2/3）', function () {
    var md = fs.readFileSync(AGENTIC_LOOP_SKILL, 'utf8');
    // 优先级 1：调用方传入路径参数
    assert.ok(/优先级\s*1|参数路径|planFilePath/.test(md) || /路径参数/.test(md),
      '应描述优先级 1（参数路径）');
    // 优先级 2：.claude/plan.md
    assert.ok(md.indexOf('.claude/plan.md') !== -1, '应描述优先级 2（.claude/plan.md）');
    // 优先级 3：docs/plan 扫描
    assert.ok(/docs\/plan/.test(md), '应描述优先级 3（docs/plan 扫描）');
    // 三级优先级排序语义
    assert.ok(/参数路径\s*>\s*\.claude\/plan\.md\s*>\s*docs\/plan/.test(md) ||
      /三级优先级/.test(md), '应明确三级优先级顺序');
  });

  test('skill-agentic-loop/skill.md 异常处理提示语指向 skill-tackle-plan', function () {
    var md = fs.readFileSync(AGENTIC_LOOP_SKILL, 'utf8');
    // plan-not-found 异常提示应引导用户用 /skill-tackle-plan 生成计划
    assert.ok(/skill-tackle-plan/.test(md), '应提示用 /skill-tackle-plan 生成计划');
  });

  test('skill-tackle-plan/skill.md 含输出到 docs/plan/ 的约定', function () {
    var md = fs.readFileSync(TACKLE_PLAN_SKILL, 'utf8');
    assert.ok(/docs\/plan/.test(md), '应声明输出到 docs/plan/');
    // 输出路径约定应含 slug 形式
    assert.ok(/docs\/plan\/\{?slug/.test(md) || /docs\/plan\/\{主题-slug\}/.test(md) ||
      /\{slug\}\.md/.test(md), '应声明 docs/plan/{slug}.md 命名');
  });

  test('skill-tackle-plan/skill.md 内置格式模板含 plan-reader 契约四要素', function () {
    var md = fs.readFileSync(TACKLE_PLAN_SKILL, 'utf8');
    // 四要素：## section + - [ ] 任务项 + [category] 前缀 + ## 成功标准
    assert.ok(/^## /m.test(md), '模板应含 ## section');
    assert.ok(/- \[ \]/.test(md), '模板应含 - [ ] 任务项');
    assert.ok(/\[acceptance\]|\[unit\]|\[integration\]|\[category\]/.test(md),
      '模板应示范 [category] 前缀');
    assert.ok(/## 成功标准|## 验收标准/.test(md), '模板应含 ## 成功标准 section');
  });

  test('两份文档对"参数路径优先级最高"的描述一致（路径衔接闭环）', function () {
    var loopMd = fs.readFileSync(AGENTIC_LOOP_SKILL, 'utf8');
    var planMd = fs.readFileSync(TACKLE_PLAN_SKILL, 'utf8');
    // skill-tackle-plan 报告里应给出 /skill-agentic-loop docs/plan/xxx.md 调用指令
    assert.ok(/\/skill-agentic-loop\s+docs\/plan/.test(planMd),
      'skill-tackle-plan 应提示用户用 /skill-agentic-loop docs/plan/xxx.md 传参');
    // skill-agentic-loop 应能接受该参数（已在前面断言 planFilePath 优先）
    assert.ok(/docs\/plan/.test(loopMd));
  });
});
