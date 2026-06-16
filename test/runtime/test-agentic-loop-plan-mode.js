/**
 * Tests for skill-agentic-loop 强制规划入口 (WP-176)
 *
 * 锚定改动：skill-agentic-loop 通过 config.plan_mode_required: true 获得与
 * task-creator 一致的"触发即进 Plan 模式"强制力。用真实 registry + 真实 plugin
 * 目录验证 claude-md-injector（CLAUDE.md 规则块）与 hook-session-start
 * （SessionStart 提示）都能自动识别 skill-agentic-loop。
 *
 * 这是对用户反馈"没规划阶段直接开写"的回归保护：一旦 plan_mode_required 被误删
 * 或字段名写错（如曾经的死字段 metadata.requiresPlanMode），本测试会失败。
 */

'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var injector = require('../../plugins/runtime/claude-md-injector');
var SessionStartHook = require('../../plugins/core/hook-session-start');
var findPlanModeSkills = SessionStartHook.findPlanModeSkills;
var planReader = require('../../plugins/runtime/plan-reader');

// test/runtime -> D:\tackle (package root)
var PACKAGE_ROOT = path.resolve(__dirname, '../..');
var REGISTRY_PATH = path.join(PACKAGE_ROOT, 'plugins', 'plugin-registry.json');
var AGENTIC_LOOP_DIR = path.join(PACKAGE_ROOT, 'plugins', 'core', 'skill-agentic-loop');

function loadRegistryEntries() {
  var registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  return registry.plugins || [];
}

function realResolvePluginDir(entry) {
  return path.join(PACKAGE_ROOT, 'plugins', 'core', entry.source);
}

describe('skill-agentic-loop 强制规划入口 (WP-176)', function () {

  it('plugin.json 应声明 config.plan_mode_required: true', function () {
    var meta = JSON.parse(fs.readFileSync(path.join(AGENTIC_LOOP_DIR, 'plugin.json'), 'utf-8'));
    assert.strictEqual(meta.type, 'skill', '必须是 skill 类型');
    assert.ok(meta.config && meta.config.plan_mode_required === true,
      'config.plan_mode_required 必须为 true（强制 Plan 模式入口）');
  });

  it('plugin.json 不应残留死字段 metadata.requiresPlanMode', function () {
    var meta = JSON.parse(fs.readFileSync(path.join(AGENTIC_LOOP_DIR, 'plugin.json'), 'utf-8'));
    assert.ok(!meta.metadata || meta.metadata.requiresPlanMode === undefined,
      'metadata.requiresPlanMode 是不被消费的死字段，应已移除');
  });

  it('claude-md-injector.buildRuleBlock 用真实 registry 应包含 skill-agentic-loop', function () {
    var entries = loadRegistryEntries();
    var block = injector.buildRuleBlock(entries, realResolvePluginDir);
    assert.ok(block.length > 0, '应生成规则块（存在 plan_mode_required skill）');
    assert.ok(block.indexOf('skill-agentic-loop') !== -1,
      'CLAUDE.md 规则块必须列出 skill-agentic-loop');
    assert.ok(block.indexOf('EnterPlanMode') !== -1, '规则块应含 EnterPlanMode 指令');
    assert.ok(block.indexOf(injector.CLAUDE_MD_MARKER) !== -1, '规则块应被 marker 包裹');
  });

  it('hook-session-start findPlanModeSkills 用真实 packageRoot 应包含 skill-agentic-loop', function () {
    var skills = findPlanModeSkills(PACKAGE_ROOT);
    assert.ok(Array.isArray(skills) && skills.length > 0, '应识别出 plan_mode skill');
    assert.ok(skills.indexOf('skill-agentic-loop') !== -1,
      'SessionStart 提示必须包含 skill-agentic-loop');
  });

  it('回归：现有 plan_mode skill（task-creator / split-work-package）仍被识别', function () {
    var skills = findPlanModeSkills(PACKAGE_ROOT);
    assert.ok(skills.indexOf('skill-task-creator') !== -1, 'task-creator 仍应被识别');
    assert.ok(skills.indexOf('skill-split-work-package') !== -1, 'split-work-package 仍应被识别');
    assert.ok(skills.indexOf('skill-batch-task-creator') !== -1, 'batch-task-creator 仍应被识别');
  });

  it('buildRuleBlock 与 findPlanModeSkills 对 agentic-loop 的识别一致', function () {
    var block = injector.buildRuleBlock(loadRegistryEntries(), realResolvePluginDir);
    var skills = findPlanModeSkills(PACKAGE_ROOT);
    var inBlock = block.indexOf('skill-agentic-loop') !== -1;
    var inList = skills.indexOf('skill-agentic-loop') !== -1;
    assert.strictEqual(inBlock, inList, 'injector 与 hook 对 agentic-loop 的识别应一致');
    assert.ok(inBlock && inList, '两者都应识别 skill-agentic-loop');
  });
});

// ─────────────────────────────────────────────
// plan-reader 入口验证 (WP-177-5-test)
//
// WP-177 改造核心：skill-agentic-loop Step 0 优先读取 .claude/plan.md（经 plan-reader
// 拆为 WP 集合）。此处验证「读 plan.md 入口」与 plan 模式的配合：
//   - plan-reader 能从真实 .claude/plan.md 解析出 WP 集合（loop 启动前提）
//   - 退化路径已删除：单 WP 也不退化（解析出 1 个 WP 即可启动完整闭环，非提示用线性 dispatcher）
//   - plan_mode_required 与 plan-reader 入口共存（触发即规划 + 规划产物可被 loop 消费）
// ─────────────────────────────────────────────

describe('skill-agentic-loop 读 plan.md 入口 (WP-177-5-test)', function () {

  function makeTmpProjectWithPlan(planContent) {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-loop-planmode-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    if (planContent !== undefined && planContent !== null) {
      fs.writeFileSync(path.join(dir, '.claude', 'plan.md'), planContent, 'utf8');
    }
    fs.writeFileSync(path.join(dir, 'task.md'), '# Tasks\n', 'utf8');
    return dir;
  }

  it('plan-reader 从 .claude/plan.md 解析出 WP 集合（loop 启动前提）', function () {
    var planContent = [
      '# 计划',
      '',
      '## 模块A',
      '- [ ] 实现解析',
      '',
      '## 模块B',
      '- [ ] 实现渲染',
    ].join('\n');
    var dir = makeTmpProjectWithPlan(planContent);
    try {
      var parsed = planReader.parsePlanToGoal({ projectRoot: dir });
      assert.strictEqual(parsed.error, null, 'plan.md 应成功解析');
      assert.ok(parsed.goal.wpIds.length >= 2, '应解析出 >=2 个 WP');
      // 默认 plan.md 路径探测（.claude/plan.md）——与 skill.md Step 0 入口路径一致
      assert.ok(/plan\.md$/.test(parsed.planFilePath), '默认读 .claude/plan.md');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  it('退化路径已删除：单 WP 也能解析启动（不因 WP 数量退化）', function () {
    // WP-177 Step 0 红线：WP 数量不构成退化为线性 dispatcher 的理由。
    // 单 section 单 WP 也应解析出来（loop 据此启动完整闭环）。
    var planContent = [
      '# 计划',
      '',
      '## 单一改动',
      '- [ ] 修改某文件',
    ].join('\n');
    var dir = makeTmpProjectWithPlan(planContent);
    try {
      var parsed = planReader.parsePlanToGoal({ projectRoot: dir });
      assert.strictEqual(parsed.error, null);
      assert.strictEqual(parsed.goal.wpIds.length, 1, '单 WP 也应解析出来（不退化）');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  it('plan_mode_required 与 plan-reader 入口共存（触发即规划 + 产物可消费）', function () {
    // 同一 skill 既能强制进 Plan 模式（plan_mode_required:true），
    // 又能消费规划产物（plan-reader 读 .claude/plan.md）。两者不冲突。
    var meta = JSON.parse(fs.readFileSync(path.join(AGENTIC_LOOP_DIR, 'plugin.json'), 'utf-8'));
    assert.strictEqual(meta.config.plan_mode_required, true, '强制规划入口仍在');
    // plan-reader 模块可正常加载（loop 启动前提依赖它）
    assert.strictEqual(typeof planReader.parsePlanToGoal, 'function',
      'plan-reader 模块可用，提供读 plan.md 入口');
  });
});
