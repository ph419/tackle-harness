/**
 * Provider Resolver — 模型探测 + provider profile 匹配（WP-188 重构：去 glm 死标签）
 *
 * @module provider-resolver
 *
 * 职责：在 loop driver 启动时解析"当前实际生效的模型"，并按 harness-config.yaml 的
 *   `loop.providers` 规则匹配到 provider profile，决定 default executor 启用哪些特性
 *   （目前唯一可启用的是智谱 GLM 的 5h 窗口额度感知）。
 *
 * 为什么需要（取代原 executor-glm 的硬编码）：
 *   原 `--executor=glm` 把 provider 名直接焊死成 executor 类型，导致：
 *     (1) 切 mimo/deepseek 需要新建 executor 模块（违背 provider 解耦初衷）；
 *     (2) 智谱额度参数（5h 窗口/高峰系数）硬编码在 executor-glm.js，改套餐档位要改代码。
 *   本模块把"模型名 → provider 归属 → 启用哪些特性"的判定抽成纯函数 + 外置配置：
 *   default executor 只认 resolveProvider() 的输出，不再 if(provider==='glm')。
 *
 * 模型探测顺序（resolveEffectiveModel，用户明确要求"配置文件优先于环境变量"）：
 *   1. --settings 文件的顶层 model 字段
 *   2. --settings 文件的 env.ANTHROPIC_DEFAULT_SONNET_MODEL（fallback OPUS / HAIKU）
 *   3. 进程环境变量 ANTHROPIC_MODEL
 *   4. 进程环境变量 ANTHROPIC_DEFAULT_SONNET_MODEL
 *   5. 都没有 → null（纯透传，不启用任何 provider 特性）
 *
 * 容错（回退安全，绝不阻断 loop 启动）：
 *   - settings 文件读失败 / 坏 JSON / 带 BOM → 当作无 model（strip BOM 后再 parse）
 *   - harness-config 无 loop.providers 段 → 用内置 DEFAULT_PROVIDERS（开箱即用）
 *   - 任何 profile 的正则编译失败 → 跳过该 profile（不崩，记 skip）
 *
 * 可测性（遵循 codebase DI-over-mocking）：
 *   - resolveProvider({ settingsPath, env, fs, providers }) 全部依赖可注入
 *   - fs 默认 require('fs')，env 默认 process.env，providers 默认从 ConfigManager 读
 *
 * SECURITY (S4)：profile.modelRegex / baseUrlRegex 来自用户配置文件，用 new RegExp 编译。
 *   匹配对象（model / baseUrl）已是受信来源（settings 文件/环境变量），无注入风险。
 *   拒绝对正则做 eval，只走 RegExp.test；编译失败静默跳过该 profile。
 */

'use strict';

var fs = require('fs');

// ---------------------------------------------------------------------------
// 内置默认 providers（开箱即用，harness-config 无 loop.providers 段时回退）
// 与 templates/harness-config.yaml 的 loop.providers 保持一致（同值的两个表达；
//   改默认值时两处同步）。对齐原 executor-glm.js DEFAULTS 的额度参数。
// ---------------------------------------------------------------------------

var DEFAULT_PROVIDERS = [
  {
    key: 'glm',
    modelRegex: '^glm[-_]?5(?!\\d)|^glm[-_]?(4\\.[67]|4\\.5-air)',
    baseUrlRegex: 'open\\.bigmodel\\.cn',
    quota: {
      windowPrompts: 400,       // 5h 窗口（Pro 档基准）
      weeklyPrompts: 2000,
      softThreshold: 0.9,
      peakStartHour: 14,        // UTC+8
      peakEndHour: 18,
      peakCostFactor: 3,
      offpeakCostFactor: 2,
      costModelRegex: '^glm[-_]?5(?!\\d)', // 仅 5.x 系列受高峰系数
    },
  },
  {
    key: 'mimo',
    modelRegex: '^mimo',
  },
  {
    key: 'deepseek',
    modelRegex: '^deepseek',
  },
];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * strip UTF-8 BOM（0xFEFF）。claude settings 文件常带 BOM，JSON.parse 直接读会失败。
 * @param {string} content
 * @returns {string}
 */
function stripBom(content) {
  if (typeof content !== 'string' || content.length === 0) return content;
  return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

/**
 * 安全 JSON.parse：strip BOM + 容错。坏 JSON 返回 null（调用方当无 model 处理）。
 * @param {string} raw
 * @returns {object|null}
 */
function safeParseJson(raw) {
  if (!raw) return null;
  try {
    var stripped = stripBom(String(raw));
    var obj = JSON.parse(stripped);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (_e) {
    return null;
  }
}

/**
 * 从 claude settings 对象提取生效模型名。
 * 优先级：顶层 model → env.ANTHROPIC_DEFAULT_SONNET_MODEL → OPUS → HAIKU。
 * （claude 的 tier 映射：sonnet=主力模型，opus=复杂任务，haiku=轻量。loop 取主力。）
 * @param {object} parsed settings 对象
 * @returns {string|null}
 */
function extractModelFromSettings(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.model === 'string' && parsed.model.trim()) {
    return parsed.model.trim();
  }
  var env = parsed.env || {};
  if (typeof env === 'object') {
    var sonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    if (typeof sonnet === 'string' && sonnet.trim()) return sonnet.trim();
    var opus = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    if (typeof opus === 'string' && opus.trim()) return opus.trim();
    var haiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    if (typeof haiku === 'string' && haiku.trim()) return haiku.trim();
  }
  return null;
}

/**
 * 从 claude settings 对象提取 ANTHROPIC_BASE_URL（供 baseUrlRegex 二次确认）。
 * @param {object} parsed
 * @returns {string|null}
 */
function extractBaseUrlFromSettings(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  var env = parsed.env || {};
  if (env && typeof env.ANTHROPIC_BASE_URL === 'string') {
    return env.ANTHROPIC_BASE_URL;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 核心探测与匹配
// ---------------------------------------------------------------------------

/**
 * 解析当前生效的模型名（settings 文件优先 → 环境变量）。
 *
 * @param {object} p
 * @param {string|null} p.settingsPath --settings 文件路径（已校验存在）
 * @param {object} p.env 进程环境变量（默认 process.env）
 * @param {object} [p.fs] fs 实现（测试注入；默认 require('fs')）
 * @returns {{ model:string|null, baseUrl:string|null, settingsParsed:object|null }}
 *   - model: 探测到的模型名，或 null
 *   - baseUrl: settings 文件携带的 ANTHROPIC_BASE_URL（供 baseUrlRegex 确认），或 null
 *   - settingsParsed: 解析后的 settings 对象（供调用方诊断），或 null
 */
function resolveEffectiveModel(p) {
  p = p || {};
  var fsImpl = p.fs || fs;
  var env = p.env || process.env;
  var settingsParsed = null;
  var model = null;
  var baseUrl = null;

  // 1) settings 文件（优先）
  if (p.settingsPath) {
    try {
      var raw = fsImpl.readFileSync(p.settingsPath, 'utf8');
      settingsParsed = safeParseJson(raw);
      if (settingsParsed) {
        model = extractModelFromSettings(settingsParsed);
        baseUrl = extractBaseUrlFromSettings(settingsParsed);
      }
    } catch (_e) {
      // 读失败：降级到环境变量（不阻断）
    }
  }

  // 2) 环境变量（settings 未提供 model 时回退）
  if (!model) {
    if (typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL.trim()) {
      model = env.ANTHROPIC_MODEL.trim();
    } else if (typeof env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'string' &&
               env.ANTHROPIC_DEFAULT_SONNET_MODEL.trim()) {
      model = env.ANTHROPIC_DEFAULT_SONNET_MODEL.trim();
    }
  }

  return { model: model, baseUrl: baseUrl, settingsParsed: settingsParsed };
}

/**
 * 安全编译正则（编译失败返回 null，不抛）。
 * @param {string} pattern
 * @param {string} [flags] 可选正则标志（如 'i'）；默认空串
 * @returns {RegExp|null}
 */
function safeCompileRegex(pattern, flags) {
  if (typeof pattern !== 'string' || !pattern) return null;
  try {
    return new RegExp(pattern, typeof flags === 'string' ? flags : '');
  } catch (_e) {
    return null;
  }
}

/**
 * 按 providers 规则匹配 model → provider profile。
 * 遍历 providers，第一个 modelRegex 命中的胜出；baseUrlRegex（可选）做二次确认。
 *
 * @param {string|null} model 生效模型名
 * @param {string|null} baseUrl settings 携带的端点 URL（供 baseUrlRegex 确认）
 * @param {Array} providers profile 列表（DEFAULT_PROVIDERS 结构）
 * @returns {{ provider:string, profile:object|null }}
 *   - provider: 命中的 key，或 'unknown'
 *   - profile: 命中的 profile 对象（含 quota 等），或 null
 */
function matchProvider(model, baseUrl, providers) {
  if (!model) return { provider: 'unknown', profile: null };
  var list = Array.isArray(providers) ? providers : DEFAULT_PROVIDERS;
  for (var i = 0; i < list.length; i++) {
    var prof = list[i];
    if (!prof || typeof prof !== 'object' || typeof prof.key !== 'string') continue;

    // modelRegex 用 'i'（模型名大小写不敏感）：对齐原 executor-glm 的 /^glm[-_]?5(?!\d)/i，
    //   让 GLM-5.2 / GLM5Turbo 等大写变体同样命中（零漂移搬迁承诺）。
    var modelRe = safeCompileRegex(prof.modelRegex, 'i');
    if (!modelRe) continue; // 正则编译失败 → 跳过该 profile（不崩）
    if (!modelRe.test(model)) continue;

    // baseUrlRegex（可选）：二次确认端点归属，防模型名撞车。
    //   指定了 baseUrlRegex 但 baseUrl 不可得（如纯环境变量场景）→ 放行（不因缺端点误拒）；
    //   指定了且 baseUrl 可得 → 必须匹配，否则视为撞名，跳过该 profile 继续找下一个。
    //   不加 'i'：URL 端点 host 大小写敏感（open.bigmodel.cn vs OPEN.BIGMODEL.CN 应区分），避免误放行。
    if (prof.baseUrlRegex) {
      var urlRe = safeCompileRegex(prof.baseUrlRegex, '');
      if (urlRe && baseUrl && !urlRe.test(baseUrl)) {
        continue; // 端点不匹配，模型名疑似撞车 → 跳过
      }
    }

    return { provider: prof.key, profile: prof };
  }
  return { provider: 'unknown', profile: null };
}

/**
 * 从 profile 提取额度配置（若 profile.quota 存在且字段齐全）。
 * 字段不全 → 返回 null（降级为不启用额度感知，不崩）。
 * @param {object|null} profile
 * @returns {object|null}
 */
function extractQuotaConfig(profile) {
  if (!profile || !profile.quota || typeof profile.quota !== 'object') return null;
  var q = profile.quota;
  // 必备数值字段校验；缺任一 → null（避免 executor 拿到半截配置崩溃）
  var numFields = ['windowPrompts', 'weeklyPrompts', 'softThreshold',
    'peakStartHour', 'peakEndHour', 'peakCostFactor', 'offpeakCostFactor'];
  for (var i = 0; i < numFields.length; i++) {
    if (typeof q[numFields[i]] !== 'number') return null;
  }
  if (typeof q.costModelRegex !== 'string') return null;
  // 范围校验（WP-188 评审 P5）：NaN/Infinity/越界 → null 降级（不崩）。
  //   typeof 已确认 number；Number.isFinite 挡 NaN/Infinity，范围比较挡越界。
  if (!Number.isFinite(q.peakStartHour) || q.peakStartHour < 0 || q.peakStartHour > 23) return null;
  if (!Number.isFinite(q.peakEndHour) || q.peakEndHour < 0 || q.peakEndHour > 23) return null;
  if (!Number.isFinite(q.softThreshold) || q.softThreshold <= 0 || q.softThreshold > 1) return null;
  if (!Number.isFinite(q.peakCostFactor) || q.peakCostFactor <= 0) return null;
  if (!Number.isFinite(q.offpeakCostFactor) || q.offpeakCostFactor <= 0) return null;
  if (!Number.isFinite(q.windowPrompts) || q.windowPrompts <= 0) return null;
  if (!Number.isFinite(q.weeklyPrompts) || q.weeklyPrompts <= 0) return null;
  return {
    windowPrompts: q.windowPrompts,
    weeklyPrompts: q.weeklyPrompts,
    softThreshold: q.softThreshold,
    peakStartHour: q.peakStartHour,
    peakEndHour: q.peakEndHour,
    peakCostFactor: q.peakCostFactor,
    offpeakCostFactor: q.offpeakCostFactor,
    costModelRegex: q.costModelRegex,
  };
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 解析当前生效模型 + 匹配 provider profile，产出 default executor 行为决策。
 *
 * @param {object} opts
 * @param {string|null} [opts.settingsPath] --settings 文件路径（已校验存在）
 * @param {object} [opts.env] 进程环境变量（默认 process.env）
 * @param {object} [opts.fs] fs 实现（测试注入；默认 require('fs')）
 * @param {Array} [opts.providers] provider profile 列表（默认从 ConfigManager 读；
 *   若调用方已知 providers 可直接传入，绕过 ConfigManager）
 * @returns {{ model:string|null, provider:string, profile:object|null,
 *            quotaConfig:object|null, features:{quotaAware:boolean} }}
 */
function resolveProvider(opts) {
  opts = opts || {};
  var providers = Array.isArray(opts.providers) ? opts.providers : DEFAULT_PROVIDERS;

  var resolved = resolveEffectiveModel({
    settingsPath: opts.settingsPath || null,
    env: opts.env || process.env,
    fs: opts.fs || fs,
  });

  var matched = matchProvider(resolved.model, resolved.baseUrl, providers);
  var quotaConfig = extractQuotaConfig(matched.profile);

  return {
    model: resolved.model,
    provider: matched.provider,
    profile: matched.profile,
    quotaConfig: quotaConfig,
    features: {
      // 唯一可门控的特性：智谱额度感知（5h 窗口 + 高峰系数）。
      // 有 quotaConfig 即启用；mimo/deepseek/unknown 的 profile 无 quota 段 → false（纯透传）。
      quotaAware: !!quotaConfig,
    },
    // 诊断字段（非契约，供 loop.js 打日志 + 测试断言）
    _baseUrl: resolved.baseUrl,
    _settingsParsed: resolved.settingsParsed,
  };
}

module.exports = {
  resolveProvider: resolveProvider,
  resolveEffectiveModel: resolveEffectiveModel,
  matchProvider: matchProvider,
  extractQuotaConfig: extractQuotaConfig,
  // 暴露内部工具便于单元测试
  _stripBom: stripBom,
  _safeParseJson: safeParseJson,
  _extractModelFromSettings: extractModelFromSettings,
  _extractBaseUrlFromSettings: extractBaseUrlFromSettings,
  _safeCompileRegex: safeCompileRegex,
  _DEFAULT_PROVIDERS: DEFAULT_PROVIDERS,
};
