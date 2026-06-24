/**
 * Executor (default) — Agentic Loop Act 层的单一真实 executor（WP-188 重构）
 *
 * @module executor-default
 *
 * 职责：spawn Claude Code CLI（`claude -p --output-format json --allowedTools ...`）逐轮写代码，
 *   从 stdout JSON 提取 text，再从 text 里的 `json:machine-readable` fenced block 解析 CheckResult。
 *
 * 为什么取代 executor-claude / executor-glm（去 provider 死标签）：
 *   原 executor-claude（真实 Anthropic）与 executor-glm（智谱）是两个模块，差异仅在：
 *     - glm 追加 --model、注入智谱 env、内置 5h 额度感知。
 *   新模型下端点+认证+model 全部由 --settings 文件（或环境变量）携带，executor 不再注入环境变量；
 *   智谱额度感知改为**按探测到的模型自动启用**（provider-resolver 判定 features.quotaAware）。
 *   故合并为单一 default executor，内部按 features 门控额度逻辑，零 provider 分支。
 *
 * 行为决策（由 loop.js 调 provider-resolver 后透传）：
 *   - features.quotaAware=true（探测到 glm 模型且有 quotaConfig）：
 *       启用 5h 滚动窗口额度感知 + 高峰系数（3x/2x），接近软阈值降速返回 quota_exhausted。
 *   - 否则（mimo/deepseek/unknown）：纯透传 spawn claude，无额度约束。
 *   - settingsPath 非空：追加 `--settings <path>`（透传 claude 原生 flag）；此时 model 由 settings
 *     文件决定，不追加 --model。settingsPath 为空但探测到 model：追加 `--model <model>`（环境变量场景）。
 *
 * SECURITY：
 *   - S1：prompt 走 stdin，不进 argv（与 executor-claude 一致）。
 *   - 不再注入 ANTHROPIC_BASE_URL/AUTH_TOKEN 环境变量（端点+认证由 settings 文件携带，
 *     executor 注入会与 settings 冲突且有泄漏风险）。智谱旧路径 buildAnthropicEnv 已删除。
 *
 * CheckResult 契约（与 executor-claude / executor-local 一致，见 executor-claude.js 头注）。
 *
 * 可测性（遵循 codebase DI-over-mocking）：
 *   - createExecutor({ spawnFn, nowFn, gitStatusFn }) 注入实现，测试传 fake spawn，不真调 claude。
 *   - 额度逻辑（isPeakHour/quotaCostFactor/createQuotaTracker）从 executor-glm 搬迁，零漂移。
 */

'use strict';

var { spawn } = require('child_process');

// 复用 executor-claude 的内部工具（prompt 模板 / checklist 解析 / 进展检测 / WP 文档读取 / buildClaudeArgs）
// —— provider 解耦验证锚点：default 与原 claude 共享同一套 prompt+解析，差异仅在调用目标与可选额度门控。
var claudeInternals = require('./executor-claude');
var buildPrompt = claudeInternals._buildPrompt;
var buildClaudeArgs = claudeInternals._buildClaudeArgs;
var extractTextFromClaudeStdout = claudeInternals._extractTextFromClaudeStdout;
var parseCheckResult = claudeInternals._parseCheckResult;
var normalizeCheckResult = claudeInternals._normalizeCheckResult;
var buildFailedChecklist = claudeInternals._buildFailedChecklist;
// WP-191-2-impl：进展检测复用 claude 的工作树脏度判定 + applyProgressDetection（零漂移）
var readWorktreeDirty = claudeInternals._readWorktreeDirty;
var applyProgressDetection = claudeInternals._applyProgressDetection;

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

var DEFAULTS = {
  binary: 'claude', // Claude Code CLI 可执行名
  timeoutMs: 15 * 60 * 1000, // 单次执行超时 15min（对齐 executor-claude/local）
  rateLimitPerHour: 100, // 单实例每小时调用上限（与 executor-claude 一致）
  allowedTools: [
    // 白名单：允许 Claude 读写代码与跑测试，禁止改动 .claude/ 内部状态（防自篡改）
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
  ],
};

// ---------------------------------------------------------------------------
// 额度感知（从 executor-glm 搬迁，零漂移；仅 features.quotaAware=true 时启用）
// docs/wp/WP-188-research.md §3.3：智谱 GLM Coding Plan 双重限额 + 高峰系数
// ---------------------------------------------------------------------------

/**
 * 判断当前时刻是否落在智谱高峰时段（peakStartHour-peakEndHour，UTC+8 小时数）。
 * 与宿主时区无关。
 * @param {number} peakStartUtc8Hour
 * @param {number} peakEndUtc8Hour
 * @param {Function} [nowFn] 注入时间函数（测试用），返回 Date
 * @returns {boolean}
 */
function isPeakHour(peakStartUtc8Hour, peakEndUtc8Hour, nowFn) {
  var now = (nowFn || function () { return new Date(); })();
  var beijingHour = (now.getUTCHours() + 8) % 24;
  return beijingHour >= peakStartUtc8Hour && beijingHour < peakEndUtc8Hour;
}

/**
 * 计算一次调用消耗的额度系数。
 * costModelRegex 命中（如 glm-5.x）→ 高峰 peakCostFactor / 非高峰 offpeakCostFactor；
 * 不命中（如 glm-4.6）→ 1x（不受高峰系数影响）。
 * @param {string} model 模型名
 * @param {object} quotaConfig { peakStartHour, peakEndHour, peakCostFactor, offpeakCostFactor, costModelRegex }
 * @param {Function} [nowFn]
 * @returns {number}
 */
function quotaCostFactor(model, quotaConfig, nowFn) {
  if (!quotaConfig) return 1;
  var costRe = null;
  // 'i' 标志：对齐原 executor-glm 的 /^glm[-_]?5(?!\d)/i，让 GLM-5.2 / GLM5Turbo 等大写变体
  //   同样命中高峰系数（零漂移搬迁承诺）。
  try { costRe = new RegExp(quotaConfig.costModelRegex, 'i'); } catch (_e) { return 1; }
  if (!costRe.test(model || '')) return 1;
  var peak = isPeakHour(quotaConfig.peakStartHour, quotaConfig.peakEndHour, nowFn);
  return peak ? quotaConfig.peakCostFactor : quotaConfig.offpeakCostFactor;
}

/**
 * 创建滚动窗口额度计数器（从 executor-glm 搬迁，零漂移）。
 * 记录每次调用的 { ts, cost }，提供 usedInWindow / usedInWeek / windowRatio 查询。
 * 进程内存状态（单 loop 一个 executor 实例），不持久化、不跨 loop 共享（跨 loop 归 coordinator）。
 *
 * @param {object} quotaConfig { windowPrompts, weeklyPrompts }
 * @param {Function} [nowFn]
 * @returns {{ record:Function, windowUsed:Function, weekUsed:Function, windowRatio:Function }}
 */
function createQuotaTracker(quotaConfig, nowFn) {
  var WINDOW_MS = 5 * 60 * 60 * 1000; // 5h
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000; // 7d
  var entries = []; // { ts:number, cost:number }
  var windowPrompts = (quotaConfig && quotaConfig.windowPrompts) || 0;
  var weeklyPrompts = (quotaConfig && quotaConfig.weeklyPrompts) || 0;

  var getNow = function () { return (nowFn || function () { return new Date(); })().getTime(); };

  function prune() {
    var now = getNow();
    entries = entries.filter(function (e) { return now - e.ts < WEEK_MS; });
  }

  return {
    record: function (cost) {
      prune();
      entries.push({ ts: getNow(), cost: cost });
    },
    windowUsed: function () {
      var now = getNow();
      var sum = 0;
      for (var i = 0; i < entries.length; i++) {
        if (now - entries[i].ts < WINDOW_MS) sum += entries[i].cost;
      }
      return sum;
    },
    weekUsed: function () {
      var now = getNow();
      var sum = 0;
      for (var i = 0; i < entries.length; i++) {
        if (now - entries[i].ts < WEEK_MS) sum += entries[i].cost;
      }
      return sum;
    },
    windowRatio: function () {
      var w = windowPrompts > 0 ? this.windowUsed() / windowPrompts : 0;
      var k = weeklyPrompts > 0 ? this.weekUsed() / weeklyPrompts : 0;
      return Math.max(w, k);
    },
  };
}

// ---------------------------------------------------------------------------
// args 构造
// ---------------------------------------------------------------------------

/**
 * 构造 claude CLI 参数。
 *   - settingsPath 非空：追加 `--settings <path>`（透传 claude 原生 flag），model 由 settings 文件决定。
 *   - settingsPath 为空但 model 非空：追加 `--model <model>`（环境变量场景需要显式指定）。
 *   - 两者都无：仅 claude 骨架 flags（走 claude 账号默认模型）。
 *
 * SECURITY (S1)：prompt 走 stdin，不进 args（见 executor-claude.buildClaudeArgs）。
 *
 * @param {string[]} allowedTools
 * @param {string} [settingsPath]
 * @param {string} [model] settingsPath 为空时生效
 * @returns {string[]}
 */
function buildDefaultArgs(allowedTools, settingsPath, model) {
  var args = buildClaudeArgs(allowedTools, settingsPath);
  // settings 接管时 model 由文件决定；仅无 settings 才显式 --model（环境变量场景）
  if (!settingsPath && model) {
    args.push('--model', model);
  }
  return args;
}

/**
 * 把 executor 打点 trace 附到 CheckResult 上（WP-196-1-impl，纯观测）。
 * 下划线前缀字段 `_executorTrace` 表示内部观测，reflection-evaluator 不消费；
 * driver 读取后聚合到 round record。全程 try/catch 降级——trace 缺失不影响 checkResult。
 * @param {object} checkResult
 * @param {object} trace { spawnMs, exitCode, timedOut, rateLimited, tokenUsage }
 * @returns {object} 原 checkResult（附 _executorTrace）
 */
function _withTrace(checkResult, trace) {
  try {
    if (checkResult && typeof checkResult === 'object') {
      checkResult._executorTrace = trace || null;
    }
  } catch (_e) { /* 降级：观测失败绝不阻断 */ }
  return checkResult;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 创建一个 default executor 实例。
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn] 注入 spawn（测试用）；默认 child_process.spawn
 * @param {string} [opts.binary] claude 可执行名
 * @param {number} [opts.timeoutMs] 单次超时（ms）
 * @param {number} [opts.rateLimitPerHour] 调用上限/h
 * @param {string[]} [opts.allowedTools] 工具白名单
 * @param {string} [opts.projectRoot] 项目根覆盖（默认自动探测）
 * @param {string} [opts.settingsPath] claude settings 文件路径（透传 --settings）
 * @param {string} [opts.model] 生效模型名（settingsPath 为空时追加 --model；也供额度系数判定）
 * @param {string} [opts.provider] 探测到的 provider key（诊断/日志用，'glm'/'mimo'/'unknown'）
 * @param {object} [opts.quotaConfig] 智谱额度配置（provider-resolver 产出；非空即启用额度感知）
 * @param {Function} [opts.gitStatusFn] 进展检测 git status 注入（测试用）
 * @param {Function} [opts.nowFn] 注入时间函数（测试用，额度窗口与高峰系数）
 * @returns {{ name:string, run:Function, config:object }}
 */
function createExecutor(opts) {
  opts = opts || {};
  var config = {
    binary: opts.binary || DEFAULTS.binary,
    timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULTS.timeoutMs,
    rateLimitPerHour: typeof opts.rateLimitPerHour === 'number'
      ? opts.rateLimitPerHour : DEFAULTS.rateLimitPerHour,
    allowedTools: (opts.allowedTools && opts.allowedTools.length)
      ? opts.allowedTools.slice() : DEFAULTS.allowedTools.slice(),
    projectRoot: opts.projectRoot || claudeInternals._resolveProjectRoot(),
    settingsPath: opts.settingsPath || null,
    model: opts.model || null,
    provider: opts.provider || 'unknown',
    quotaConfig: opts.quotaConfig || null,
  };
  var quotaAware = !!(config.quotaConfig && config.quotaConfig.windowPrompts > 0);
  var spawnFn = opts.spawnFn || spawn;
  var gitStatusFn = typeof opts.gitStatusFn === 'function' ? opts.gitStatusFn : null;
  var nowFn = opts.nowFn;

  // 额度计数器：仅 quotaAware 时实例化（mimo/deepseek/unknown 不创建，省内存）
  var quota = quotaAware
    ? createQuotaTracker(config.quotaConfig, nowFn)
    : null;

  // 限流状态（与 executor-claude 一致）
  var callTimestamps = [];
  var HOUR_MS = 60 * 60 * 1000;

  /**
   * 执行 pendingAction：spawn claude → 收集 stdout → 解析 checklist block。
   *
   * 额度感知流程（仅 quotaAware；对齐原 executor-glm 硬约束 #2"降速返回"）：
   *   1. 调用前查 quotaRatio，超过软阈值 → 返回 quota_exhausted（不 spawn），让 driver 发散检测兜底
   *   2. 调用后按高峰系数计入额度窗口
   *
   * @param {object} pendingAction
   * @returns {Promise<object>} CheckResult
   */
  async function run(pendingAction) {
    pendingAction = pendingAction || {};
    var wpId = pendingAction.wpId || 'unknown';

    // WP-196-1-impl：executor.run 打点（仅观测，不引入 provider 分支）。
    //   采集 {spawnMs, exitCode, timedOut, rateLimited} 附在 checkResult._executorTrace；
    //   全程容错，缺失字段降级为 null。tokenUsage 当前不可获取（claude CLI 不稳定暴露），留 null。
    var trace = { spawnMs: null, exitCode: null, timedOut: false, rateLimited: false, tokenUsage: null };
    var spawnStartMs = Date.now();

    // 限流（与 executor-claude 一致，所有 provider 共用）
    var now = Date.now();
    callTimestamps = callTimestamps.filter(function (ts) { return now - ts < HOUR_MS; });
    if (callTimestamps.length >= config.rateLimitPerHour) {
      trace.rateLimited = true;
      trace.spawnMs = Date.now() - spawnStartMs;
      return _withTrace(buildFailedChecklist(wpId, 'rate_limited'), trace);
    }
    callTimestamps.push(now);

    // 额度前置检查（仅 quotaAware）：接近软上限则降速返回，不 spawn
    if (quotaAware && quota.windowRatio() >= config.quotaConfig.softThreshold) {
      trace.spawnMs = Date.now() - spawnStartMs;
      return _withTrace(buildFailedChecklist(wpId, 'quota_exhausted'), trace);
    }

    // 进展检测基线（WP-191-2-impl，复用 executor-claude 的工作树脏度判定）
    var dirtyBefore = readWorktreeDirty(config.projectRoot, gitStatusFn);

    // 构造 prompt（复用 executor-claude）+ args
    var prompt = buildPrompt(pendingAction, config.projectRoot);
    var args = buildDefaultArgs(config.allowedTools, config.settingsPath, config.model);

    // spawn + 超时控制
    var stdoutBuf = '';
    var stderrBuf = '';
    var timedOut = false;
    // 额度计入闸门（仅 quotaAware；对齐原 executor-glm WP-191-4-impl 项 3）：
    //   spawn 立即失败 / error / close 且 code==null（未真运行）不计额度；
    //   仅 close 且 code!=null（真正启动并退出）或 timedOut 才计。
    var quotaRecorded = false;
    var child;
    try {
      child = spawnFn(config.binary, args, {
        cwd: config.projectRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      trace.spawnMs = Date.now() - spawnStartMs;
      return _withTrace(buildFailedChecklist(wpId, 'spawn_failed: ' + ((e && e.code) || (e && e.message) || String(e))), trace);
    }

    // prompt 走 stdin（S1，与 executor-claude 一致）
    if (child.stdin) {
      child.stdin.on('error', function (_e) {});
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (_writeErr) {
        // 同步写失败：忽略，由 close/error 裁决
      }
    }

    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch (_e) {}
        setTimeout(function () {
          try { child.kill('SIGKILL'); } catch (_e2) {}
        }, 2000);
      }, config.timeoutMs);

      if (child.stdout) {
        child.stdout.on('data', function (chunk) {
          if (chunk) stdoutBuf += chunk.toString();
        });
      }
      if (child.stderr) {
        child.stderr.on('data', function (chunk) {
          if (chunk) stderrBuf += chunk.toString();
        });
      }

      child.on('error', function (err) {
        clearTimeout(timer);
        // spawn_error 路径不计额度（本地未真打到端点）。标记 quotaRecorded 防重复计。
        quotaRecorded = true;
        trace.spawnMs = Date.now() - spawnStartMs;
        trace.exitCode = null;
        resolve(_withTrace(buildFailedChecklist(wpId, 'spawn_error: ' + (err && err.message ? err.message : String(err))), trace));
      });

      child.on('close', function (code) {
        clearTimeout(timer);

        // 额度计入（仅 quotaAware）：仅当子进程真正运行过（code!=null 或 timedOut）才计。
        if (quotaAware && !quotaRecorded && (code != null || timedOut)) {
          var cost = quotaCostFactor(config.model, config.quotaConfig, nowFn);
          quota.record(cost);
          quotaRecorded = true;
        }

        trace.spawnMs = Date.now() - spawnStartMs;
        trace.exitCode = (typeof code === 'number') ? code : null;
        trace.timedOut = timedOut === true;

        if (timedOut) {
          resolve(_withTrace(buildFailedChecklist(wpId, 'timeout'), trace));
          return;
        }
        // 提取 text → 解析 checklist block（复用 executor-claude 解析）
        var text = extractTextFromClaudeStdout(stdoutBuf);
        var raw = parseCheckResult(text);
        var chk = normalizeCheckResult(raw, wpId);

        // 进展检测（WP-191-2-impl，复用 executor-claude.applyProgressDetection）
        var dirtyAfter = readWorktreeDirty(config.projectRoot, gitStatusFn);
        applyProgressDetection(chk, dirtyBefore, dirtyAfter);
        // 非 0 退出码且无解析结果 → 失败
        if (code !== 0 && !raw) {
          resolve(_withTrace(buildFailedChecklist(wpId, 'claude_exit_' + code + ': ' + stderrBuf.slice(0, 200)), trace));
          return;
        }
        resolve(_withTrace(chk, trace));
      });
    });
  }

  return {
    name: 'default',
    run: run,
    config: config,
    // quota 只读视图（供 coordinator 查询；quotaAware=false 时各方法返回 0）
    quota: quotaAware ? {
      windowUsed: quota.windowUsed,
      weekUsed: quota.weekUsed,
      windowRatio: quota.windowRatio,
    } : {
      windowUsed: function () { return 0; },
      weekUsed: function () { return 0; },
      windowRatio: function () { return 0; },
    },
  };
}

module.exports = {
  createExecutor: createExecutor,
  // 暴露内部工具便于单元测试（额度逻辑从 executor-glm 搬迁，签名对齐）
  _buildDefaultArgs: buildDefaultArgs,
  _isPeakHour: isPeakHour,
  _quotaCostFactor: quotaCostFactor,
  _createQuotaTracker: createQuotaTracker,
  _DEFAULTS: DEFAULTS,
};
