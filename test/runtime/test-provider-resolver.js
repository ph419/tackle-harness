/**
 * Unit tests for provider-resolver (WP-188 重构)
 * Run with: node --test test/runtime/test-provider-resolver.js
 *
 * 覆盖（纯函数 + DI，遵循 codebase DI-over-mocking 哲学；用临时文件做真实 fs）：
 *   - 模型探测顺序：settings.model → settings.env.ANTHROPIC_DEFAULT_*_MODEL → 环境变量
 *   - BOM strip（settings 文件带 UTF-8 BOM 仍可解析）
 *   - 坏 JSON 容错（降级到环境变量，不崩）
 *   - provider 匹配：modelRegex 命中 / 未命中 → unknown
 *   - baseUrlRegex 二次确认（端点撞名跳过）
 *   - quota 提取（字段齐全 → quotaConfig；缺字段 → null 降级）
 *   - 无 providers 配置 → 用内置 DEFAULT_PROVIDERS
 *   - 正则编译失败容错（跳过该 profile）
 *   - 内部工具：stripBom / safeParseJson / extractModelFromSettings / safeCompileRegex
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var resolver = require('../../plugins/runtime/provider-resolver');
var resolveProvider = resolver.resolveProvider;

// ─────────────────────────────────────────────
// Helpers：临时 settings 文件
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-test-'));
}
function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}
/** 写一个 settings JSON 文件；bom=true 时加 UTF-8 BOM。返回绝对路径。 */
function writeSettings(dir, name, obj, bom) {
  var p = path.join(dir, name);
  var content = JSON.stringify(obj);
  if (bom) content = '\uFEFF' + content;
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ─────────────────────────────────────────────
// Section 1: 模型探测顺序
// ─────────────────────────────────────────────

test('探测顺序：settings.model 优先于 env 字段和环境变量', function () {
  var dir = makeTmpDir();
  try {
    var p = writeSettings(dir, 's.json', {
      model: 'glm-5.2',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6' },
    });
    var r = resolveProvider({ settingsPath: p, env: { ANTHROPIC_MODEL: 'mimo-x' } });
    assert.strictEqual(r.model, 'glm-5.2', 'settings.model 应胜出');
  } finally { cleanupTmpDir(dir); }
});

test('探测顺序：无 model 字段时回退 settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL', function () {
  var dir = makeTmpDir();
  try {
    var p = writeSettings(dir, 's.json', {
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2' },
    });
    var r = resolveProvider({ settingsPath: p, env: {} });
    assert.strictEqual(r.model, 'glm-4.6');
  } finally { cleanupTmpDir(dir); }
});

test('探测顺序：无 settings 时回退环境变量 ANTHROPIC_MODEL', function () {
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'glm-5.2' } });
  assert.strictEqual(r.model, 'glm-5.2');
});

test('探测顺序：无 ANTHROPIC_MODEL 时回退 ANTHROPIC_DEFAULT_SONNET_MODEL', function () {
  var r = resolveProvider({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro' } });
  assert.strictEqual(r.model, 'mimo-v2.5-pro');
});

test('探测顺序：全无 → model=null, provider=unknown', function () {
  var r = resolveProvider({ env: {} });
  assert.strictEqual(r.model, null);
  assert.strictEqual(r.provider, 'unknown');
  assert.strictEqual(r.features.quotaAware, false);
});

// ─────────────────────────────────────────────
// Section 2: BOM strip + 坏 JSON 容错
// ─────────────────────────────────────────────

test('BOM strip：settings 带 UTF-8 BOM 仍能解析 model', function () {
  var dir = makeTmpDir();
  try {
    var p = writeSettings(dir, 's.json', { model: 'glm-5.2[1m]' }, true);
    var r = resolveProvider({ settingsPath: p, env: {} });
    assert.strictEqual(r.model, 'glm-5.2[1m]');
  } finally { cleanupTmpDir(dir); }
});

test('坏 JSON 容错：降级到环境变量，不崩', function () {
  var dir = makeTmpDir();
  try {
    var p = path.join(dir, 'broken.json');
    fs.writeFileSync(p, '{not valid json', 'utf8');
    var r = resolveProvider({ settingsPath: p, env: { ANTHROPIC_MODEL: 'glm-5.2' } });
    assert.strictEqual(r.model, 'glm-5.2', '坏 JSON 应降级到环境变量');
  } finally { cleanupTmpDir(dir); }
});

test('settings 文件读失败（不存在）→ 降级环境变量', function () {
  var r = resolveProvider({ settingsPath: '/no/such/file.json', env: { ANTHROPIC_MODEL: 'deepseek-chat' } });
  assert.strictEqual(r.model, 'deepseek-chat');
});

// ─────────────────────────────────────────────
// Section 3: provider 匹配（内置 DEFAULT_PROVIDERS）
// ─────────────────────────────────────────────

test('匹配：glm-5.2 → provider=glm, quotaAware=true', function () {
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'glm-5.2' } });
  assert.strictEqual(r.provider, 'glm');
  assert.strictEqual(r.features.quotaAware, true);
  assert.ok(r.quotaConfig, '应有 quotaConfig');
  assert.strictEqual(r.quotaConfig.windowPrompts, 400);
  assert.strictEqual(r.quotaConfig.peakCostFactor, 3);
});

test('匹配：glm-4.6 → provider=glm（在套餐内），quotaAware=true', function () {
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'glm-4.6' } });
  assert.strictEqual(r.provider, 'glm');
  assert.strictEqual(r.features.quotaAware, true);
});

test('匹配：glm-x-preview → provider=unknown（不在套餐正则，纯透传）', function () {
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'glm-x-preview' } });
  assert.strictEqual(r.provider, 'unknown');
  assert.strictEqual(r.features.quotaAware, false);
});

test('匹配：mimo-v2.5-pro → provider=mimo, quotaAware=false', function () {
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'mimo-v2.5-pro' } });
  assert.strictEqual(r.provider, 'mimo');
  assert.strictEqual(r.features.quotaAware, false);
  assert.strictEqual(r.quotaConfig, null);
});

test('匹配：deepseek-chat → provider=deepseek, quotaAware=false', function () {
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'deepseek-chat' } });
  assert.strictEqual(r.provider, 'deepseek');
  assert.strictEqual(r.features.quotaAware, false);
});

test('匹配：未知模型 → provider=unknown', function () {
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'some-custom-model' } });
  assert.strictEqual(r.provider, 'unknown');
});

test('匹配（大小写不敏感，对齐原 /i 语义）：GLM-5.2 / GLM5Turbo → glm + quotaAware', function () {
  // 原 executor-glm quotaCostFactor 用 /^glm[-_]?5(?!\d)/i（带 i），大写变体应命中。
  // modelRegex 编译须传 'i'，否则 GLM-5.2 被判 unknown、不计高峰额度（零漂移断裂）。
  var r1 = resolveProvider({ env: { ANTHROPIC_MODEL: 'GLM-5.2' } });
  assert.strictEqual(r1.provider, 'glm');
  assert.strictEqual(r1.features.quotaAware, true);
  var r2 = resolveProvider({ env: { ANTHROPIC_MODEL: 'GLM5Turbo' } });
  assert.strictEqual(r2.provider, 'glm');
  assert.strictEqual(r2.features.quotaAware, true);
});

test('匹配（大小写不敏感）：MIMO-V2 / DeepSeek-Chat 大写变体命中对应 profile', function () {
  assert.strictEqual(resolveProvider({ env: { ANTHROPIC_MODEL: 'MIMO-V2' } }).provider, 'mimo');
  assert.strictEqual(resolveProvider({ env: { ANTHROPIC_MODEL: 'DeepSeek-Chat' } }).provider, 'deepseek');
});

// ─────────────────────────────────────────────
// Section 4: baseUrlRegex 二次确认
// ─────────────────────────────────────────────

test('baseUrlRegex：端点不匹配 → 视为撞名，跳过 glm 继续匹配', function () {
  var dir = makeTmpDir();
  try {
    // model=glm-5.2 命中 glm，但 baseUrl 是 mimo 端点 → 应跳过 glm
    var p = writeSettings(dir, 's.json', {
      model: 'glm-5.2',
      env: { ANTHROPIC_BASE_URL: 'https://xiaomimimo.com/anthropic' },
    });
    var r = resolveProvider({ settingsPath: p, env: {} });
    assert.strictEqual(r.provider, 'unknown', '端点撞名应跳过 glm');
    assert.strictEqual(r.features.quotaAware, false);
  } finally { cleanupTmpDir(dir); }
});

test('baseUrlRegex：端点匹配 → 正常命中 glm', function () {
  var dir = makeTmpDir();
  try {
    var p = writeSettings(dir, 's.json', {
      model: 'glm-5.2',
      env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic' },
    });
    var r = resolveProvider({ settingsPath: p, env: {} });
    assert.strictEqual(r.provider, 'glm');
    assert.strictEqual(r.features.quotaAware, true);
  } finally { cleanupTmpDir(dir); }
});

test('baseUrlRegex：环境变量场景无 baseUrl → 放行（不因缺端点误拒）', function () {
  // 纯环境变量场景，无 settings → baseUrl=null → baseUrlRegex 不阻断
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'glm-5.2' } });
  assert.strictEqual(r.provider, 'glm');
});

// ─────────────────────────────────────────────
// Section 5: 自定义 providers 配置
// ─────────────────────────────────────────────

test('自定义 providers：传入则用，不用 DEFAULTS', function () {
  var custom = [
    { key: 'mycorp', modelRegex: '^corp-' },
  ];
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'corp-xl' }, providers: custom });
  assert.strictEqual(r.provider, 'mycorp');
  assert.strictEqual(r.features.quotaAware, false);
});

test('自定义 providers：带 quota → quotaAware=true', function () {
  var custom = [
    {
      key: 'mycorp',
      modelRegex: '^corp-',
      quota: {
        windowPrompts: 100, weeklyPrompts: 500, softThreshold: 0.8,
        peakStartHour: 9, peakEndHour: 12, peakCostFactor: 2, offpeakCostFactor: 1,
        costModelRegex: '^corp-x',
      },
    },
  ];
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'corp-xl' }, providers: custom });
  assert.strictEqual(r.provider, 'mycorp');
  assert.strictEqual(r.features.quotaAware, true);
  assert.strictEqual(r.quotaConfig.windowPrompts, 100);
});

test('quota 字段不全 → quotaConfig=null 降级（不崩）', function () {
  var custom = [
    { key: 'mycorp', modelRegex: '^corp-', quota: { windowPrompts: 100 } }, // 缺 weeklyPrompts 等
  ];
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'corp-xl' }, providers: custom });
  assert.strictEqual(r.provider, 'mycorp');
  assert.strictEqual(r.quotaConfig, null, '字段不全应降级');
  assert.strictEqual(r.features.quotaAware, false);
});

/** 合法的自定义 quota（P5 范围校验用例的基准；单字段覆盖非法值）。 */
function validCustomQuota() {
  return {
    windowPrompts: 100, weeklyPrompts: 500, softThreshold: 0.8,
    peakStartHour: 9, peakEndHour: 12, peakCostFactor: 2, offpeakCostFactor: 1,
    costModelRegex: '^corp-x',
  };
}

test('quota 范围非法 → quotaConfig=null 降级（WP-188 评审 P5）', function () {
  var cases = [
    ['peakStartHour 越界(25)', { peakStartHour: 25 }],
    ['peakEndHour 越界(-1)', { peakEndHour: -1 }],
    ['softThreshold<=0', { softThreshold: 0 }],
    ['softThreshold>1', { softThreshold: 1.5 }],
    ['peakCostFactor<=0', { peakCostFactor: -1 }],
    ['offpeakCostFactor<=0', { offpeakCostFactor: 0 }],
    ['windowPrompts<=0', { windowPrompts: 0 }],
    ['weeklyPrompts=NaN', { weeklyPrompts: NaN }],
    ['peakStartHour=Infinity', { peakStartHour: Infinity }],
  ];
  for (var i = 0; i < cases.length; i++) {
    var custom = [{
      key: 'mycorp', modelRegex: '^corp-',
      quota: Object.assign({}, validCustomQuota(), cases[i][1]),
    }];
    var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'corp-xl' }, providers: custom });
    assert.strictEqual(r.quotaConfig, null, cases[i][0] + ' 应降级为 null');
    assert.strictEqual(r.features.quotaAware, false, cases[i][0] + ' quotaAware 应 false');
  }
});

test('正则编译失败 → 跳过该 profile（不崩）', function () {
  var custom = [
    { key: 'bad', modelRegex: '[' }, // 非法正则
    { key: 'good', modelRegex: '^glm' },
  ];
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'glm-5.2' }, providers: custom });
  assert.strictEqual(r.provider, 'good', '坏正则 profile 应跳过，继续匹配 good');
});

test('无 providers 参数 → 用内置 DEFAULT_PROVIDERS', function () {
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'glm-5.2' } });
  assert.strictEqual(r.provider, 'glm');
});

// 缺口-1（WP-193-1-audit §5 误报-4 / §7 缺口-1）：显式空 providers=[] 是真值，
// resolver 不会回退 DEFAULT_PROVIDERS，而是遍历空列表 → 全 unknown。
// 这是用户显式配置（"不匹配任何 provider"）的合理结果，锁定该行为防未来误改
// （如有人把 `Array.isArray(opts.providers) ? ... : DEFAULT` 误加 `.length` 判空）。
test('显式空 providers=[] → 全 unknown（不回退 DEFAULT_PROVIDERS）', function () {
  var r = resolveProvider({ env: { ANTHROPIC_MODEL: 'glm-5.2' }, providers: [] });
  assert.strictEqual(r.provider, 'unknown', '空列表应遍历为空 → 不命中任何 profile');
  assert.strictEqual(r.model, 'glm-5.2', 'model 探测不受 providers 空影响');
  assert.strictEqual(r.features.quotaAware, false);
  assert.strictEqual(r.quotaConfig, null);
});

// ─────────────────────────────────────────────
// Section 6: 内部工具
// ─────────────────────────────────────────────

test('_stripBom：去 UTF-8 BOM', function () {
  assert.strictEqual(resolver._stripBom('\uFEFFhello'), 'hello');
  assert.strictEqual(resolver._stripBom('hello'), 'hello');
  assert.strictEqual(resolver._stripBom(''), '');
});

test('_safeParseJson：strip BOM + 容错', function () {
  assert.deepStrictEqual(resolver._safeParseJson('\uFEFF{"a":1}'), { a: 1 });
  assert.strictEqual(resolver._safeParseJson('not json'), null);
  assert.strictEqual(resolver._safeParseJson(''), null);
});

test('_extractModelFromSettings：model → sonnet → opus → haiku 优先级', function () {
  assert.strictEqual(resolver._extractModelFromSettings({ model: 'top' }), 'top');
  assert.strictEqual(resolver._extractModelFromSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 's' } }), 's');
  assert.strictEqual(resolver._extractModelFromSettings({
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'o' },
  }), 'o');
  assert.strictEqual(resolver._extractModelFromSettings({
    env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h' },
  }), 'h');
  assert.strictEqual(resolver._extractModelFromSettings({}), null);
});

test('_safeCompileRegex：编译失败返回 null', function () {
  assert.ok(resolver._safeCompileRegex('^glm') instanceof RegExp);
  assert.strictEqual(resolver._safeCompileRegex('['), null);
  assert.strictEqual(resolver._safeCompileRegex(''), null);
});

test('_DEFAULT_PROVIDERS：含 glm/mimo/deepseek', function () {
  var keys = resolver._DEFAULT_PROVIDERS.map(function (p) { return p.key; });
  assert.ok(keys.indexOf('glm') !== -1);
  assert.ok(keys.indexOf('mimo') !== -1);
  assert.ok(keys.indexOf('deepseek') !== -1);
});
