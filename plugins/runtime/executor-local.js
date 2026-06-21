/**
 * Executor (local) — Agentic Loop Act 层 provider 执行单元的本地 mock 实现（WP-185-impl）
 *
 * @module executor-local
 *
 * 职责：实现 driver 期望的 `run(pendingAction) -> CheckResult` 契约的「固定通过」mock，
 *   供 driver 单测与 `--executor=local` 冒烟使用。不调任何真实模型/子进程，零副作用
 *   （除了可选地触摸 PROGRESS.md 由 driver 负责，本模块不写文件）。
 *
 * 设计约束（docs/plan/agentic-loop-node-driver.md 硬约束 #3）：
 *   - provider 解耦点是 `executor.run()`：driver 不直接 spawn claude，
 *     Claude/GLM/local 都是 run() 的不同实现。
 *   - 本模块与 executor-claude.js（WP-185）实现同一份接口契约，可互换。
 *
 * CheckResult 契约（与 reflection-evaluator / loop-snapshot 消费口径一致，
 *   见 reflection-evaluator.js proximityFromChecklist / failingDriversFromChecklist）：
 *   {
 *     wpId: string,
 *     passed: boolean,
 *     summary: { total:number, passed:number, failed:number },
 *     categories: [],            // 本 mock 不细分类别
 *     failedItems: [],           // 空数组表示无失败项
 *   }
 *
 * 限流与超时（WP-185-impl，对齐 Ralph 模式）：
 *   - 单实例默认 100/h 调用上限，超限返回 passed:false + failedItems:[{reason:'rate_limited'}]
 *   - run() 默认无超时（mock 即时返回），opts.timeoutMs 仅作记录
 *   这两项语义与 executor-claude 一致，便于 driver 不感知 provider 差异。
 */

'use strict';

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

var DEFAULTS = {
  rateLimitPerHour: 100, // 单实例每小时调用上限
  timeoutMs: 15 * 60 * 1000, // 15min（mock 不真等，仅记录）
  // model 占位（WP-191-1-impl-d，provider 零分支统一通道）：
  //   mock 不调真实模型，config.model 仅供 driver 写 sidecar 时统一取值
  //   （executor.config.model），与 claude/glm 共用同一通道，无 provider 分支。
  //   coordinator 额度池对 local 无限额（Infinity），此 model 值不参与计量。
  model: 'local-mock',
  // mock 是否模拟失败（测试用）：true 时按 failRate 随机返回 passed:false
  simulateFailure: false,
  failRate: 0.0,
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * ISO 时间戳。
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 生成「固定通过」的 CheckResult（mock 默认行为）。
 * summary 固定 3/3 全过（与 WP-184 验证脚本口径一致，便于 proximity 单调递增回归）。
 * @param {string} wpId
 * @returns {object} CheckResult
 */
function buildPassedChecklist(wpId) {
  return {
    wpId: wpId,
    passed: true,
    summary: { total: 3, passed: 3, failed: 0 },
    categories: [],
    failedItems: [],
  };
}

/**
 * 生成「失败」CheckResult（mock simulateFailure 或 限流场景）。
 * @param {string} wpId
 * @param {string} reason 失败原因
 * @returns {object} CheckResult
 */
function buildFailedChecklist(wpId, reason) {
  return {
    wpId: wpId,
    passed: false,
    summary: { total: 3, passed: 0, failed: 3 },
    categories: [],
    failedItems: [
      { id: 'mock-1', category: 'check', text: 'mock check', reason: reason },
    ],
  };
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 创建一个 local executor 实例。
 *
 * @param {object} [opts]
 * @param {number} [opts.rateLimitPerHour] 调用上限/h
 * @param {number} [opts.timeoutMs] 单次超时（ms）
 * @param {boolean} [opts.simulateFailure] 是否模拟随机失败
 * @param {number} [opts.failRate] 失败概率 [0,1]
 * @returns {{ run: Function, name: string }}
 */
function createExecutor(opts) {
  opts = opts || {};
  var config = {
    rateLimitPerHour: typeof opts.rateLimitPerHour === 'number'
      ? opts.rateLimitPerHour : DEFAULTS.rateLimitPerHour,
    timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULTS.timeoutMs,
    model: opts.model || DEFAULTS.model,
    simulateFailure: opts.simulateFailure === true,
    failRate: typeof opts.failRate === 'number' ? opts.failRate : DEFAULTS.failRate,
  };

  // 限流状态：滑动窗口记录调用时间戳
  var callTimestamps = [];
  var HOUR_MS = 60 * 60 * 1000;

  /**
   * 执行 pendingAction，返回固定通过的 CheckResult（mock）。
   *
   * 签名契约（driver 与 executor-claude 共享）：
   *   run(pendingAction: {wpId, mode, strategy, failingDrivers?, ...}) -> Promise<CheckResult>
   *
   * @param {object} pendingAction loop-actuator 产出的 dispatcher 待执行指令
   * @returns {Promise<object>} CheckResult
   */
  async function run(pendingAction) {
    pendingAction = pendingAction || {};
    var wpId = pendingAction.wpId || 'unknown';

    // 限流：清理 1h 外的旧记录，检查窗口内调用数
    var now = Date.now();
    callTimestamps = callTimestamps.filter(function (ts) {
      return now - ts < HOUR_MS;
    });
    if (callTimestamps.length >= config.rateLimitPerHour) {
      return buildFailedChecklist(wpId, 'rate_limited');
    }
    callTimestamps.push(now);

    // 模拟失败（测试路径）
    if (config.simulateFailure && Math.random() < config.failRate) {
      return buildFailedChecklist(wpId, 'mock_simulated_failure');
    }

    // mock 主路径：固定返回 passed。真实 executor（claude）会在此 spawn 子进程写代码。
    return buildPassedChecklist(wpId);
  }

  return {
    name: 'local',
    run: run,
    config: config,
    // quota 视图（mock 不计量）：与 executor-default 的 quotaAware=false 视图同构，
    // 统一 { name, run, config, quota } 契约——让消费者无分支读 executor.quota.*，
    // 各方法恒返回 0（local 是 mock，无真实额度概念）。
    quota: {
      windowUsed: function () { return 0; },
      weekUsed: function () { return 0; },
      windowRatio: function () { return 0; },
    },
  };
}

module.exports = {
  createExecutor: createExecutor,
  // 暴露内部工具便于单元测试
  _buildPassedChecklist: buildPassedChecklist,
  _buildFailedChecklist: buildFailedChecklist,
  _DEFAULTS: DEFAULTS,
};
