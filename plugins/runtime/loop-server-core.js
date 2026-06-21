/**
 * Loop Server Core — 全局 coordinator 守护进程核心逻辑（WP-190）
 *
 * @module loop-server-core
 *
 * 职责：把 loop-coordinator 从"纯函数聚合"升级为"守护进程能力"——
 *   扫描 per-loop 隔离目录（WP-189 产出）、只读聚合全局视图、按 provider 分桶额度池、
 *   全局熔断指令下发。本模块是**纯逻辑 + 文件 IO**，不含轮询循环（轮询由 CLI 薄壳
 *   bin/commands/loop-server.js 驱动），便于单测。
 *
 * 设计约束（docs/plan/agentic-loop-node-driver-m4m5.md 硬约束）：
 *   - engine 零改动（硬约束 #1）：全程不碰 provider-loop-engine，只读它产出的 .claude-state。
 *   - coordinator 只读各 loop state，不写 loop.{loopId} state（硬约束 #7）：
 *       本模块读各 loop 的 .claude-state（只读聚合），只写自己的 directive.json sidecar
 *       （熔断指令通道）和返回值。绝不写各 loop 的 .claude-state（规避多进程并发写，
 *       state-store.js:19-23 明确不支持）。
 *   - 复用 loop-coordinator.aggregateLoopStates（WP-190 升级时聚合逻辑不动）：
 *       本模块负责"扫 per-loop 目录 → 组装 loopStates 数组 → 喂给 aggregateLoopStates"。
 *
 * 已确认的关键事实（WP-190 探索产出）：
 *   1. loop-coordinator.collectLoopStatesFromStore 是死路（StateStore 无 listByPrefix/listKeys，
 *      只有 keys()；且 per-loop 隔离后各 state 在独立文件）。→ 本模块的 collectLoopStatesFromStateDir
 *      替代它：扫描 stateDir 下的子目录，多文件读，走 aggregateLoopStates({loopStates}) 数组路径。
 *   2. loop state 不含 executor/provider 字段（engine createLoopState 无此字段）。→ provider
 *      归属从 driver 写的 .executor sidecar 读（WP-190 步骤 1 产出）。
 *   3. 熔断跨进程：coordinator 写独立 directive.json sidecar（不碰 .claude-state 规避并发写），
 *      driver 每轮读它命中后调本进程 api.applyDirective。
 *
 * 合规边界（docs/wp/WP-188-research.md §4）：
 *   glm 多 loop 并行仅在"订阅人本人本机 + claude CLI 客户端"场景合规；禁止跨机共享
 *   API Key（智谱使用须知明确账号共享可封号）。额度池仅做本机单订阅人的额度统筹。
 */

'use strict';

var fs = require('fs');
var path = require('path');
var coordinator = require('./loop-coordinator');
var { StateStore } = require('./state-store');
var safePath = require('./safe-path');

// 复用 executor-default 的高峰系数换算（额度池对 glm 按高峰加权）。
// WP-188 重构：executor-glm 已删除，额度逻辑搬到 executor-default；
//   coordinator 从 provider-resolver 的 DEFAULT_PROVIDERS 取 glm quotaConfig 传入。
var defaultExecutor = null;
var providerResolver = null;
try {
  defaultExecutor = require('./executor-default');
  providerResolver = require('./provider-resolver');
} catch (_e) {
  defaultExecutor = null;
  providerResolver = null;
}

// glm quotaConfig（WP-188 评审 P4）：优先读用户 harness-config.yaml 的 loop.providers
//   的 glm profile quota，使 coordinator 高峰加权与 default executor 同源；用户 config 无
//   glm → 回退 provider-resolver DEFAULT_PROVIDERS。daemon 加载时读一次（config 改动需重启）。
function findGlmQuotaIn(providers) {
  if (!Array.isArray(providers)) return null;
  for (var i = 0; i < providers.length; i++) {
    var p = providers[i];
    if (p && p.key === 'glm' && p.quota) return p.quota;
  }
  return null;
}

function resolveGlmQuotaConfig(providers) {
  // 1) 调用方显式传入的 providers 优先（测试注入 / 已读 config）
  var q = findGlmQuotaIn(providers);
  if (q) return q;
  // 2) 读用户 harness-config.yaml 的 loop.providers（与 loop.js 同一读取模式；daemon 加载时一次）
  try {
    var ConfigManager = require('./config-manager');
    var cfg = new ConfigManager().getAll();
    q = findGlmQuotaIn(cfg && cfg.loop ? cfg.loop.providers : null);
    if (q) return q;
  } catch (_e) {
    // config 读失败 → 降级 DEFAULT（不阻断 daemon）
  }
  // 3) 回退 provider-resolver DEFAULT_PROVIDERS（开箱即用，与 default executor 同源）
  return findGlmQuotaIn(providerResolver && providerResolver._DEFAULT_PROVIDERS);
}

var GLM_QUOTA_CONFIG = resolveGlmQuotaConfig();

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

var DEFAULTS = {
  stateDir: '.tackle-state', // per-loop 隔离目录根（与 WP-189 driver 默认一致）
  // 进程存活判定：sidecar 超过此毫秒数未更新视为 disconnected
  heartbeatStaleMs: 5 * 60 * 1000, // 5min
  // 各 provider 的额度上限（5h 窗口 prompts；对齐智谱套餐档位 + claude 通用 100/h）
  // coordinator 额度池是"软"统筹：超限时下发熔断，让各 driver 优雅退出（而非硬限流）
  //
  // 口径对齐（WP-191-1-impl-d）：glm 的 windowPrompts=400 与 executor-glm.quotaWindowPrompts
  //   一致（均取智谱 Pro 档 5h 窗口）。但两者职责不同——executor 内置窗口做"单 loop 降速"
  //   （soft，阈值 0.9），本额度池做"跨 loop 兜底"（hard，阈值 quotaCircuitThreshold=0.95，
  //   显著高于 executor 软阈值，避免双重触发）。详见 applyQuotaPool JSDoc。
  quota: {
    claude: { windowPrompts: 500 }, // 单机多 claude loop 的软上限（≈5h）
    glm: { windowPrompts: 400 },   // 智谱 Pro 档 5h 窗口（docs/wp/WP-188-research.md §3.2）
    local: { windowPrompts: Infinity }, // mock 无额度限制
  },
  // 额度池触发熔断的阈值比例（须 > executor-glm.quotaSoftThreshold=0.9，见上）
  quotaCircuitThreshold: 0.95,
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/**
 * 校验 loopId 安全性并在非法时抛带 code 的错误（S4：路径拼接前校验）。
 *
 * 为什么 core 公开 API 也要自我防御：writeAbortDirective / readLoopState 等是
 * module.exports 公开 API，调用方未必经 CLI 入口（loop-server.js:132 已校验）。
 * 直接 core.writeAbortDirective(stateDir, '../../etc', reason) 会 path.join 逃逸
 * stateDir。与 listLoopIds 的 symlink 过滤（:139）形成一致的深度防御。
 *
 * 抛错风格对齐 createExecutor 未知 provider（loop-executor.js:87 throw new Error），
 * 额外挂 .code='INVALID_LOOP_ID' 便于调用方按 code 分支处理。
 *
 * @param {string} loopId
 * @returns {string} 校验通过的 loopId 原值
 * @throws {Error} 非法时抛错（err.code='INVALID_LOOP_ID'）
 */
function assertSafeLoopId(loopId) {
  var v = safePath.validateSafeName(loopId);
  if (!v.ok) {
    var err = new Error('Invalid loopId: ' + v.reason);
    err.code = 'INVALID_LOOP_ID';
    throw err;
  }
  return loopId;
}

/**
 * 安全读 JSON 文件，失败返回 fallback。
 * @param {string} filePath
 * @param {*} fallback
 * @returns {*}
 */
function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    var raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_e) {
    return fallback;
  }
}

/**
 * 安全写 JSON 文件（原子写：tmp + rename，复用 state-store 的原子写模式）。
 * @param {string} filePath
 * @param {object} data
 */
function writeJsonSafe(filePath, data) {
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_e2) {}
    throw e;
  }
}

/**
 * 列举 stateDir 下的 per-loop 子目录名（每个目录名即 loopId）。
 * 仅返回含 .claude-state 或 .executor 的目录（有效的 loop 工作区）。
 * @param {string} stateDir
 * @returns {string[]}
 */
function listLoopIds(stateDir) {
  if (!fs.existsSync(stateDir)) return [];
  var entries;
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
  var ids = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.isDirectory()) continue;
    var sub = path.join(stateDir, e.name);
    // WP-191-4-impl 项 6：跳过符号链接目录（防信息泄露）。
    //   外部 symlink 指向敏感目录（如 ~/.ssh 或其它项目）被放进 stateDir 时，
    //   若不过滤，coordinator 会读取其 .claude-state/.executor 并聚合到全局视图，
    //   造成跨目录信息泄露。safe-path.isSymlink 用 lstat 精确识别 symlink（含 junction）。
    if (safePath.isSymlink(sub)) continue;
    // 有效 loop 工作区：含 .claude-state 或 .executor
    if (fs.existsSync(path.join(sub, '.claude-state')) ||
        fs.existsSync(path.join(sub, '.executor'))) {
      ids.push(e.name);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 核心：从 per-loop 隔离目录收集 loop 状态
// ---------------------------------------------------------------------------

/**
 * 从 {stateDir}/{loopId}/.claude-state 读单个 loop 的 state（key 仍为 loop.{loopId}）。
 * 读前 invalidate（缓存陷阱：state-store 内存缓存，见 loop.js:25-29 注释）。
 * @param {string} stateDir
 * @param {string} loopId
 * @returns {Promise<object|null>}
 */
async function readLoopState(stateDir, loopId) {
  assertSafeLoopId(loopId);
  var filePath = path.join(stateDir, loopId, '.claude-state');
  if (!fs.existsSync(filePath)) return null;
  var store = new StateStore({ filePath: filePath });
  store.invalidate();
  try {
    return await store.get('loop.' + loopId);
  } catch (_e) {
    return null;
  }
}

/**
 * 读单个 loop 的 provider 归属（从 .executor sidecar）。
 * @param {string} stateDir
 * @param {string} loopId
 * @returns {string|null}
 */
function readLoopProvider(stateDir, loopId) {
  assertSafeLoopId(loopId);
  var data = readJsonSafe(path.join(stateDir, loopId, '.executor'), null);
  if (data && typeof data.provider === 'string') return data.provider;
  return null;
}

/**
 * 读单个 loop 的模型名（从 .executor sidecar，B20）。
 * @param {string} stateDir
 * @param {string} loopId
 * @returns {string|null}
 */
function readLoopModel(stateDir, loopId) {
  assertSafeLoopId(loopId);
  var data = readJsonSafe(path.join(stateDir, loopId, '.executor'), null);
  if (data && typeof data.model === 'string') return data.model;
  return null;
}

/**
 * 读单个 loop 的进程存活信号（.executor sidecar 的 startedAt + pid）。
 * @param {string} stateDir
 * @param {string} loopId
 * @returns {{ provider:string|null, startedAt:string|null, pid:number, mtimeMs:number, sidecarExists:boolean }}
 */
function readLoopHeartbeat(stateDir, loopId) {
  assertSafeLoopId(loopId);
  var sidecarPath = path.join(stateDir, loopId, '.executor');
  var data = readJsonSafe(sidecarPath, null);
  var mtimeMs = 0;
  try {
    if (fs.existsSync(sidecarPath)) mtimeMs = fs.statSync(sidecarPath).mtimeMs;
  } catch (_e) {
    mtimeMs = 0;
  }
  return {
    provider: data && typeof data.provider === 'string' ? data.provider : null,
    startedAt: data && data.startedAt ? data.startedAt : null,
    pid: data && typeof data.pid === 'number' ? data.pid : 0,
    mtimeMs: mtimeMs,
    sidecarExists: !!data,
  };
}

/**
 * 扫描 stateDir 下所有 per-loop 隔离目录，收集 {loopStates, providers, heartbeats}。
 *
 * 替代失效的 loop-coordinator.collectLoopStatesFromStore（StateStore 无 listByPrefix，
 * 且 per-loop 隔离后各 state 在独立文件）。走 aggregateLoopStates({loopStates}) 数组路径。
 *
 * @param {string} stateDir
 * @returns {Promise<{ loopStates:Array<object>, providers:object, models:object, heartbeats:object }>}
 */
async function collectLoopStatesFromStateDir(stateDir) {
  var loopIds = listLoopIds(stateDir);
  var loopStates = [];
  var providers = {};
  var models = {};
  var heartbeats = {};

  for (var i = 0; i < loopIds.length; i++) {
    var lid = loopIds[i];
    var st = await readLoopState(stateDir, lid);
    if (st && st.loopId) {
      loopStates.push(st);
    } else {
      // 有目录但 state 未就绪/损坏：仍记录占位，coordinator 标 disconnected
      loopStates.push({ loopId: lid, status: 'disconnected' });
    }
    providers[lid] = readLoopProvider(stateDir, lid);
    models[lid] = readLoopModel(stateDir, lid);
    heartbeats[lid] = readLoopHeartbeat(stateDir, lid);
  }
  return { loopStates: loopStates, providers: providers, models: models, heartbeats: heartbeats };
}

// ---------------------------------------------------------------------------
// 核心：全局视图聚合（复用 loop-coordinator.aggregateLoopStates，聚合逻辑零改动）
// ---------------------------------------------------------------------------

/**
 * 聚合全局视图：收集 per-loop state → 喂给 coordinator.aggregateLoopStates →
 * 追加 providers / heartbeats / disconnected 标记。
 *
 * @param {string} stateDir
 * @param {object} [opts]
 * @param {string} [opts.sessionId]
 * @returns {Promise<object>} {
 *   ...coordinator 聚合结果（session_id/aggregated_at/total_loops/loops/global）,
 *   providers: { loopId: provider },
 *   heartbeats: { loopId: { provider, startedAt, pid, alive } }
 * }
 */
async function aggregateGlobalView(stateDir, opts) {
  opts = opts || {};
  var collected = await collectLoopStatesFromStateDir(stateDir);
  var aggregated = await coordinator.aggregateLoopStates({
    loopStates: collected.loopStates,
    sessionId: opts.sessionId,
  });

  // 叠加 provider 归属 + 进程存活判定
  var now = Date.now();
  var staleMs = opts.heartbeatStaleMs || DEFAULTS.heartbeatStaleMs;
  var heartbeats = {};
  var loopIds = Object.keys(aggregated.loops || {});
  for (var i = 0; i < loopIds.length; i++) {
    var lid = loopIds[i];
    var hb = collected.heartbeats[lid] || {};
    // 存活判定：sidecar 存在且 mtime 在 staleMs 内视为 alive
    var alive = hb.sidecarExists && (now - hb.mtimeMs) < staleMs;
    // 若 loop 已终态（achieved/timeout 等），视为不再活跃（非 alive 但非 disconnected）
    var summary = aggregated.loops[lid] || {};
    var isTerminal = coordinator.TERMINAL_VERDICTS[summary.status] ||
      (summary.verdict && coordinator.TERMINAL_VERDICTS[summary.verdict]);
    heartbeats[lid] = {
      provider: hb.provider || collected.providers[lid] || 'unknown',
      startedAt: hb.startedAt,
      pid: hb.pid,
      alive: alive && !isTerminal,
      stale: hb.sidecarExists && !alive,
    };
  }

  aggregated.providers = collected.providers;
  aggregated.models = collected.models || {};
  aggregated.heartbeats = heartbeats;
  return aggregated;
}

// ---------------------------------------------------------------------------
// 核心：跨 provider 额度池
// ---------------------------------------------------------------------------

/**
 * 按 provider 分桶计算额度池消耗。
 *
 * 消耗口径：各 loop 的 iteration（≈ dispatch 次数 ≈ 模型调用数）按 provider 求和。
 *   glm 额外按高峰系数加权（复用 executor-glm.quotaCostFactor：高峰 3x / 非高峰 2x，
 *   仅 GLM-5.x；其它 glm 模型 1x）。这是"软"统筹：超阈值时由 CLI 层下发熔断。
 *
 * 双重计量职责澄清（WP-191-1-impl-d，避免与 executor 内置窗口混淆）：
 *   - executor-glm 内置 5h 滚动窗口（createQuotaTracker + quotaSoftThreshold=0.9）= 本进程
 *     降速（soft）：单 loop 接近自身窗口软阈值时返回 quota_exhausted，由 driver 发散检测兜底。
 *   - 本函数 applyQuotaPool = 跨进程兜底（hard）：把同一 provider 的多个 loop 的 iteration
 *     求和，超 quotaCircuitThreshold（0.95）时由 coordinator 下发全局熔断。注意这是"估算"
 *     非精确对账——iteration 是 dispatch 次数近似，不与 executor 的精确 5h 窗口逐条对齐。
 *   - 阈值设计：coordinator 硬阈值（0.95）须显著高于 executor 软阈值（0.9），让单 loop 先
 *     自行降速，仅在多 loop 叠加逼近总配额时才触发全局熔断，避免双重触发抖动。
 *   - windowPrompts 来源：DEFAULTS.quota.{provider}.windowPrompts（glm=400 与 executor-glm
 *     quotaWindowPrompts=400 口径一致，均取智谱 Pro 档 5h 窗口）。调用方可传 quotaConfig 覆盖。
 *
 * @param {object} globalView aggregateGlobalView 返回值
 * @param {object} [quotaConfig] 各 provider 配额（默认 DEFAULTS.quota）
 * @param {Function} [nowFn] 注入时间（测试用）
 * @returns {object} {
 *   pools: { claude:{used,limit,ratio}, glm:{used,limit,ratio}, ... },
 *   overQuota: string[] 超阈值的 provider 列表
 * }
 */
function applyQuotaPool(globalView, quotaConfig, nowFn) {
  var quota = quotaConfig || DEFAULTS.quota;
  var loops = globalView.loops || {};
  var providers = globalView.providers || {};
  var models = globalView.models || {};

  // 按 provider 累加 iteration
  var used = {};
  var providerSet = Object.keys(quota);
  for (var i = 0; i < providerSet.length; i++) used[providerSet[i]] = 0;

  var loopIds = Object.keys(loops);
  for (var j = 0; j < loopIds.length; j++) {
    var lid = loopIds[j];
    var summary = loops[lid] || {};
    var provider = providers[lid] || 'unknown';
    var iters = summary.iteration || 0;
    if (!(provider in used)) used[provider] = 0;
    // glm 高峰系数加权
    if (provider === 'glm' && defaultExecutor &&
        typeof defaultExecutor._quotaCostFactor === 'function' && GLM_QUOTA_CONFIG) {
      // B20: per-loop model from .executor sidecar (e.g. 'glm-5.2'). Falls back
      // to 'glm-5.2' (the current default GLM model) when the sidecar doesn't
      // record a model. The previous hardcoded 'glm-4.6' always yielded a 1x
      // factor, undercounting GLM-5.x loops by 2-3x and thus underestimating
      // circuit-breaker thresholds.
      var model = models[lid] || 'glm-5.2';
      var factor = defaultExecutor._quotaCostFactor(model, GLM_QUOTA_CONFIG, nowFn);
      iters = iters * factor;
    }
    used[provider] += iters;
  }

  var pools = {};
  var overQuota = [];
  var pNames = Object.keys(used);
  for (var k = 0; k < pNames.length; k++) {
    var p = pNames[k];
    var limit = (quota[p] && typeof quota[p].windowPrompts === 'number')
      ? quota[p].windowPrompts : Infinity;
    var u = used[p];
    var ratio = limit === Infinity ? 0 : (limit > 0 ? u / limit : 1);
    pools[p] = { used: u, limit: limit, ratio: ratio };
    if (limit !== Infinity && ratio >= DEFAULTS.quotaCircuitThreshold) {
      overQuota.push(p);
    }
  }
  return { pools: pools, overQuota: overQuota };
}

// ---------------------------------------------------------------------------
// 核心：熔断指令下发（单向 sidecar，不碰 .claude-state）
// ---------------------------------------------------------------------------

/**
 * 对指定 loop 下发 abort 熔断指令（写 directive.json sidecar）。
 *
 * 为什么不直接改 .claude-state：state-store 明确不支持多进程并发写
 * （state-store.js:19-23），coordinator 写 + driver 写会 last-write-wins 丢数据。
 * 独立 directive.json 只 coordinator 写、driver 读（单向），规避并发写。
 *
 * @param {string} stateDir
 * @param {string} loopId
 * @param {string} reason
 * @returns {string} 写入的 directive.json 路径
 */
function writeAbortDirective(stateDir, loopId, reason) {
  assertSafeLoopId(loopId);
  var dir = path.join(stateDir, loopId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var directivePath = path.join(dir, 'directive.json');
  writeJsonSafe(directivePath, {
    action: 'abort_all',
    reason: reason || 'coordinator 全局熔断',
    issuedAt: nowIso(),
  });
  return directivePath;
}

/**
 * 清除指定 loop 的熔断指令（删 directive.json）。
 * @param {string} stateDir
 * @param {string} loopId
 */
function clearAbortDirective(stateDir, loopId) {
  assertSafeLoopId(loopId);
  var p = path.join(stateDir, loopId, 'directive.json');
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_e) {
    // 删除失败忽略
  }
}

/**
 * 清理已消费的熔断指令（WP-191-1-impl-b）。
 *
 * 为什么需要（P0 修复）：coordinator 写 directive.json 后从不检查「driver 是否已消费」，
 * 状态机不闭环。driver 端在 applyDirective 成功后已自行删除本 loop 的 directive.json
 * （loop.js clearAbortDirective），但仍有两类残留需 coordinator 兜底清理：
 *   1. driver 已终态退出（applyDirective 后 crash / kill -9）来不及删除 → directive.json
 *      残留，用户 `--loop-id` 恢复时被二次熔断（loop 永远无法恢复）；
 *   2. coordinator 的 tick 每轮都按 selectLoopsForGlobalCircuitBreak / selectLoopsForQuotaExhaustion
 *      对仍 alive 的 loop 重写 directive.json —— 一旦该 loop 进入终态，残留指令也会卡住恢复。
 *
 * 策略：对全局视图中**已终态**（achieved/timeout/diverged/circuit_broken/aborted）的 loop，
 * 若其工作区残留 directive.json 则删除。只清终态 loop，不影响活跃 loop 的待消费指令。
 *
 * 单向通道语义不变（coordinator 写、driver 读+清理）：本函数只在 loop 已终态（不再活跃）
 * 时清理，是对 driver 端清理的兜底，不引入 coordinator 直接改 .claude-state。
 *
 * @param {string} stateDir
 * @param {object} globalView aggregateGlobalView 返回值
 * @returns {string[]} 本次清理掉的 loopId 列表（供日志/测试断言）
 */
function cleanupConsumedDirectives(stateDir, globalView) {
  var loops = (globalView && globalView.loops) || {};
  var loopIds = Object.keys(loops);
  var cleaned = [];
  for (var i = 0; i < loopIds.length; i++) {
    var lid = loopIds[i];
    var summary = loops[lid] || {};
    var isTerminal = coordinator.TERMINAL_VERDICTS[summary.status] ||
      (summary.verdict && coordinator.TERMINAL_VERDICTS[summary.verdict]);
    if (!isTerminal) continue;
    var directivePath = path.join(stateDir, lid, 'directive.json');
    try {
      if (fs.existsSync(directivePath)) {
        fs.unlinkSync(directivePath);
        cleaned.push(lid);
      }
    } catch (_e) {
      // 删除失败忽略（降级：残留指令不阻断 coordinator，下轮 tick 重试）
    }
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// 守护进程 PID 文件（WP-191-1-impl-c：stop 子命令的进程发现机制）
// ---------------------------------------------------------------------------

/**
 * 守护进程 PID 文件名（落在 stateDir 根，与 per-loop 子目录平级）。
 * @const
 */
var PID_FILENAME = 'loop-server.pid';

/**
 * PID 文件绝对路径。
 * @param {string} stateDir
 * @returns {string}
 */
function pidFilePath(stateDir) {
  return path.join(stateDir, PID_FILENAME);
}

/**
 * 写守护进程 PID 文件（start 时调用）。原子写（复用 writeJsonSafe）。
 * @param {string} stateDir
 * @param {number} pid
 * @returns {string} 写入的 PID 文件路径
 */
function writePidFile(stateDir, pid) {
  var p = pidFilePath(stateDir);
  writeJsonSafe(p, {
    pid: pid,
    startedAt: nowIso(),
  });
  return p;
}

/**
 * 读守护进程 PID 文件，返回 {pid} 或 null（文件不存在/损坏）。
 * @param {string} stateDir
 * @returns {{pid:number} | null}
 */
function readPidFile(stateDir) {
  var data = readJsonSafe(pidFilePath(stateDir), null);
  if (data && typeof data.pid === 'number' && data.pid > 0) {
    return { pid: data.pid };
  }
  return null;
}

/**
 * 清理守护进程 PID 文件（stop 后 / 守护退出时调用）。不存在或失败均忽略。
 * @param {string} stateDir
 */
function clearPidFile(stateDir) {
  try {
    var p = pidFilePath(stateDir);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_e) {
    // 删除失败忽略（降级：不阻断）
  }
}

/**
 * 判定哪些 loop 应被全局熔断（任一 loop circuit_broken → 其它活跃 loop 也熔断）。
 * 返回应下发 abort 的 loopId 列表（不含已终态的 loop）。
 *
 * @param {object} globalView aggregateGlobalView 返回值
 * @returns {string[]} 需熔断的 loopId 列表
 */
function selectLoopsForGlobalCircuitBreak(globalView) {
  var loops = globalView.loops || {};
  var heartbeats = globalView.heartbeats || {};
  var loopIds = Object.keys(loops);

  // 任一 loop 熔断 → 触发全局回退
  var anyCircuit = false;
  for (var i = 0; i < loopIds.length; i++) {
    var s = loops[loopIds[i]] || {};
    if (coordinator.CIRCUIT_VERDICTS[s.verdict] || s.status === 'circuit_broken' || s.status === 'aborted') {
      anyCircuit = true;
      break;
    }
  }
  if (!anyCircuit) return [];

  // 对其它仍活跃（alive）的 loop 下发熔断
  var targets = [];
  for (var j = 0; j < loopIds.length; j++) {
    var lid = loopIds[j];
    var hb = heartbeats[lid] || {};
    if (hb.alive) targets.push(lid);
  }
  return targets;
}

/**
 * 判定哪些 loop 因所属 provider 额度耗尽应被熔断。
 * @param {object} globalView aggregateGlobalView 返回值
 * @param {object} quotaPool applyQuotaPool 返回值
 * @returns {string[]} 需熔断的 loopId 列表
 */
function selectLoopsForQuotaExhaustion(globalView, quotaPool) {
  var overProviders = {};
  (quotaPool.overQuota || []).forEach(function (p) { overProviders[p] = true; });
  if (Object.keys(overProviders).length === 0) return [];

  var loops = globalView.loops || {};
  var providers = globalView.providers || {};
  var heartbeats = globalView.heartbeats || {};
  var targets = [];
  var loopIds = Object.keys(loops);
  for (var i = 0; i < loopIds.length; i++) {
    var lid = loopIds[i];
    var hb = heartbeats[lid] || {};
    var provider = providers[lid];
    if (overProviders[provider] && hb.alive) {
      targets.push(lid);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// 格式化输出（供 CLI 层打印）
// ---------------------------------------------------------------------------

/**
 * 把全局视图格式化为人类可读的表格文本。
 * @param {object} globalView
 * @param {object} quotaPool
 * @returns {string}
 */
function formatGlobalView(globalView, quotaPool) {
  var lines = [];
  var loops = globalView.loops || {};
  var providers = globalView.providers || {};
  var heartbeats = globalView.heartbeats || {};
  var g = globalView.global || {};

  lines.push('=== Loop Coordinator 全局视图 ===');
  lines.push('aggregated: ' + (globalView.aggregated_at || nowIso()));
  lines.push('global verdict: ' + (g.verdict || '?') + ' — ' + (g.reason || ''));
  lines.push('loops: ' + (globalView.total_loops || 0) +
    ' (achieved=' + g.achievedCount + ' circuit=' + g.circuitCount +
    ' failed=' + g.failedCount + ' running=' + g.runningCount +
    ' disconnected=' + g.disconnectedCount + ')');
  lines.push('');

  var loopIds = Object.keys(loops);
  if (loopIds.length === 0) {
    lines.push('（无活跃 loop。用 tackle loop <plan> --loop-id=X 启动隔离 loop）');
  } else {
    lines.push('loopId            provider  iter  prox    verdict          alive');
    lines.push('----------------  --------  ----  ------  ---------------  -----');
    for (var i = 0; i < loopIds.length; i++) {
      var lid = loopIds[i];
      var s = loops[lid] || {};
      var hb = heartbeats[lid] || {};
      var prox = typeof s.proximity === 'number' ? s.proximity.toFixed(3) : '?';
      lines.push(
        pad(lid, 18) + '  ' +
        pad(hb.provider || providers[lid] || '?', 8) + '  ' +
        pad(String(s.iteration || 0), 4) + '  ' +
        pad(prox, 6) + '  ' +
        pad(s.verdict || s.status || '?', 15) + '  ' +
        (hb.alive ? 'yes' : (hb.stale ? 'stale' : 'no'))
      );
    }
  }

  lines.push('');
  lines.push('=== 额度池（按 provider 分桶）===');
  var pools = (quotaPool && quotaPool.pools) || {};
  var pNames = Object.keys(pools);
  for (var k = 0; k < pNames.length; k++) {
    var p = pNames[k];
    var pool = pools[p];
    if (pool.limit === Infinity) continue; // 跳过无限制的（如 local）
    var limitStr = pool.limit === Infinity ? '∞' : String(pool.limit);
    lines.push('  ' + pad(p, 8) + ' used=' + Math.round(pool.used) +
      '/' + limitStr + ' (ratio=' + pool.ratio.toFixed(2) + ')' +
      (pool.ratio >= DEFAULTS.quotaCircuitThreshold ? '  ⚠ OVER' : ''));
  }
  return lines.join('\n');
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s.slice(0, n);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  DEFAULTS: DEFAULTS,
  // 采集
  listLoopIds: listLoopIds,
  readLoopState: readLoopState,
  readLoopProvider: readLoopProvider,
  readLoopModel: readLoopModel,
  readLoopHeartbeat: readLoopHeartbeat,
  collectLoopStatesFromStateDir: collectLoopStatesFromStateDir,
  // 聚合
  aggregateGlobalView: aggregateGlobalView,
  // 额度池
  applyQuotaPool: applyQuotaPool,
  // 熔断
  writeAbortDirective: writeAbortDirective,
  clearAbortDirective: clearAbortDirective,
  cleanupConsumedDirectives: cleanupConsumedDirectives,
  selectLoopsForGlobalCircuitBreak: selectLoopsForGlobalCircuitBreak,
  selectLoopsForQuotaExhaustion: selectLoopsForQuotaExhaustion,
  // 格式化
  formatGlobalView: formatGlobalView,
  // 工具（测试用）
  _readJsonSafe: readJsonSafe,
  _writeJsonSafe: writeJsonSafe,
  _resolveGlmQuotaConfig: resolveGlmQuotaConfig,
  // PID 文件（WP-191-1-impl-c stop 子命令）
  PID_FILENAME: PID_FILENAME,
  pidFilePath: pidFilePath,
  writePidFile: writePidFile,
  readPidFile: readPidFile,
  clearPidFile: clearPidFile,
};
