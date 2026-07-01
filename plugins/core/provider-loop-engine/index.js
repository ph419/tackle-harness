/**
 * Provider: Loop Engine
 *
 * Agentic Loop 决策状态机核心（WP-174-2）。
 * 实现 Observe → Think → Act → Reflect → Decide 五阶段循环。
 *
 * 设计依据：docs/reports/agentic-loop-design.md 第 5.1 节（接口契约）。
 *
 * 关键约定：
 *   - 状态持久化复用 state-store（key: "loop.{loopId}"），不自写文件 IO。
 *   - 每 phase 完成后调 persist()，防上下文压缩丢失（对照 dispatcher-state.json）。
 *   - init() 先读 state-store，status==="running" 则从断点恢复。
 *   - observe/reflect 委托 loop-snapshot / reflection-evaluator（WP-174-3）；
 *     未注入 delegate 时降级为最小可用实现，保证状态流转完整。
 *   - act 委托 agent-dispatcher（WP-174-4 注入），此处留占位接口。
 *   - decide 实现三类终止判定优先级：熔断 > 发散 > 达成 > 上限 > 继续（design.md §6）。
 *
 * Capabilities（factory 返回）：
 *   - init(opts)                 初始化/恢复 loop 运行
 *   - observe(loopId)            聚合环境快照
 *   - think(loopId, snapshot)    基于快照决策下一步
 *   - act(loopId, decision)      执行决策（占位，委托 dispatcher）
 *   - reflect(loopId, snapshot)  评分（委托 reflection-evaluator）
 *   - decide(loopId, evalResult) 三类终止判定
 *   - step(loopId)               单步编排（observe→think→act→reflect→decide）
 *   - persist(loopId)            持久化当前状态
 *   - getState(loopId)           查询 loop 状态
 *   - applyDirective(loopId, d)  外部指令（pause/abort/abort_all）
 *   - inject(delegate)           依赖注入（loop-snapshot / reflection-evaluator / actuator）
 */

'use strict';

var path = require('path');
var fs = require('fs');
var { ProviderPlugin } = require('../../contracts/plugin-interface');
var { StateStore, FileSystemAdapter } = require('../../runtime/state-store');

// loop-report 触顶总结报告生成器（WP-177-1-impl-c）。require 失败降级为 null，
// _generateTerminalReport 会据此产出降级报告（report=null + 告警），保证 engine 不崩。
var loopReport = null;
try {
  loopReport = require('../../runtime/loop-report');
} catch (_e) {
  loopReport = null;
}

// 三类终态 verdict（触发报告生成的判定集合，WP-177-2-impl-c）。
// achieved 不在内 —— achieved 走 completion（skill-completion-report），不产终态报告。
var TERMINAL_REPORT_VERDICTS = { timeout: true, diverged: true, circuit_broken: true };

// ---------------------------------------------------------------------------
// 默认配置（与 plugin.json config 对齐，design.md §5.3.3）
// ---------------------------------------------------------------------------

var DEFAULT_CONFIG = {
  max_iterations: 6, // 10 → 6（用户指定默认，WP-177-2-impl-a）
  max_round_time_ms: 600000, // 新增：单轮最长时间，默认 10min（WP-177-2-impl-a）
  max_wall_time_ms: 3600000, // 1h
  divergence_threshold: 3,
  proximity_goal: 0.9,
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 生成 loop 唯一 ID。
 * @returns {string} e.g. "loop-20260612-143000-abc123"
 */
function generateLoopId() {
  var d = new Date();
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var stamp =
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());
  var rand = Math.random().toString(36).slice(2, 8);
  return 'loop-' + stamp + '-' + rand;
}

/**
 * ISO 时间戳。
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 浅合并配置：默认值 <- plugin.json config <- 用户 override。
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
function mergeConfig(base, override) {
  var out = {};
  var baseKeys = Object.keys(base);
  for (var i = 0; i < baseKeys.length; i++) {
    var k = baseKeys[i];
    out[k] = base[k];
  }
  if (override && typeof override === 'object') {
    var ok = Object.keys(override);
    for (var j = 0; j < ok.length; j++) {
      var kk = ok[j];
      out[kk] = override[kk];
    }
  }
  return out;
}

/**
 * 构造一个新的 LoopState（design.md §5.1.1）。
 * @param {object} opts - { loopId, teamName, goal }
 * @returns {object}
 */
function createLoopState(opts) {
  opts = opts || {};
  var ts = nowIso();
  return {
    loopId: opts.loopId || generateLoopId(),
    teamName: opts.teamName || '',
    goal: opts.goal || {
      wpIds: [],
      checklistSpec: 'default',
      successCriteria: 'all_pass_and_proximity>=goal',
    },
    iteration: 0,
    phase: 'init',
    startedAt: ts,
    lastUpdatedAt: ts,
    status: 'running', // running|achieved|timeout|diverged|circuit_broken|aborted|paused
    history: [],
    divergenceStreak: 0,
    checkpoints: {},
    lastSnapshot: null,
    lastDecision: null,
    lastEval: null,
    lastVerdict: null,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class LoopEngineProvider extends ProviderPlugin {
  constructor() {
    super();
    this.name = 'provider-loop-engine';
    this.version = '1.0.0';
    this.description = 'Agentic Loop 决策状态机 Provider';
    this.provides = 'provider:loop-engine';
    this.dependencies = ['provider:state-store', 'provider:watchdog'];

    /** @type {StateStore|null} */
    this._store = null;
    /** @type {string} */
    this._projectRoot = '';
    /** @type {object} 合并后的运行时配置 */
    this._config = mergeConfig(DEFAULT_CONFIG, {});
    /**
     * 注入的依赖（loop-snapshot / reflection-evaluator / actuator）。
     * 由 WP-174-3 / WP-174-4 注入；未注入时 engine 走降级路径。
     * @type {object}
     */
    this._delegates = {
      snapshot: null, // { aggregate(context, loopId) -> LoopSnapshot }
      evaluator: null, // { score(context, loopId, snapshot, state) -> EvalResult }
      actuator: null, // { execute(context, loopId, decision, state) -> {dispatched, checklistResult?} }
    };
    /** @type {object|null} onActivate 注入的 context */
    this._context = null;
  }

  /**
   * 激活时初始化 state-store 句柄与配置。
   * @param {PluginContext} context
   */
  async onActivate(context) {
    this._context = context;
    this._projectRoot = this._resolveProjectRoot();
    var stateFilePath = path.join(this._projectRoot, '.claude-state');
    this._store = new StateStore({ filePath: stateFilePath });

    // 从 plugin.json / registry config 合并配置（若 context 提供）
    if (context && context.config && typeof context.config.get === 'function') {
      try {
        var pluginCfg = context.config.get('plugins.provider-loop-engine');
        if (pluginCfg && typeof pluginCfg === 'object') {
          this._config = mergeConfig(this._config, pluginCfg);
        }
      } catch (e) {
        // 配置读取失败，沿用默认
      }
    }

    // 自动注入 loop-actuator（WP-177-2-impl-b）：
    //   loop-actuator 是 runtime 模块（非 provider），不走 context.getProvider，直接 require。
    //   幂等：仅当未注入 actuator 时才注入，允许外部 inject({actuator}) 覆盖（mock 优先）。
    //   require 失败（项目结构变化）降级为占位 + console.warn，保证 engine 不崩。
    this._autoInjectLoopActuator();
  }

  /**
   * 自动注入 loop-actuator 作为 actuator delegate（WP-177-2-impl-b）。
   *
   * 设计约束（docs/wp/WP-177.md「技术方案 actuator 注入架构」）：
   *   - loop-actuator 是 runtime 模块（非 provider），不走 context.getProvider，直接 require
   *   - 幂等：仅当 _delegates.actuator 为 null 时才注入（多次 onActivate / factory 不重复注入）
   *   - 外部 inject({actuator}) 优先：若已显式注入则不覆盖（mock/e2e 测试路径优先）
   *   - require 失败降级：console.warn 但不抛，保留 engine 可用性（act() 走降级占位分支）
   *
   * @private
   */
  _autoInjectLoopActuator() {
    if (this._delegates.actuator) return; // 幂等：已注入（含外部 mock）则不覆盖
    try {
      var loopActuator = require('../../runtime/loop-actuator');
      if (loopActuator && typeof loopActuator.createActuator === 'function') {
        this._delegates.actuator = loopActuator.createActuator();
      }
    } catch (e) {
      // 降级：保留 _delegates.actuator=null，act() 走占位分支（dispatched:false）
      // 不抛异常，保证 engine 主流程不崩（design.md §5.1.3 降级语义）
      try {
        console.warn('[provider-loop-engine] auto-inject loop-actuator failed: ' +
          (e && e.message ? e.message : String(e)) + '；act() 将走降级占位');
      } catch (_warnErr) {
        // console 不可用时静默
      }
    }
  }

  /**
   * 生成触顶/发散/熔断终态报告并写入 state.terminalReport（WP-177-2-impl-c）。
   *
   * 出口行为改造：verdict ∈ {timeout, diverged, circuit_broken} 时不再依赖外部
   * 「回 P1 human-checkpoint」，engine 自主调 loop-report 生成总结报告写 state，
   * 供 skill.md Step 5（outputTerminalReport）直接读取输出。
   *
   * 内聚设计：所有终态出口（decide 写终态 status / step 提前 timeout 出口）统一经此，
   * 保证无论哪条路径触顶，state.terminalReport 都被填充。
   *
   * 降级语义：loop-report require 失败 → terminalReport 置为 { degraded:true, verdict,
   * markdown:null } 并 console.warn（不抛、不阻断终态流转）；state 仍标记终态 status。
   *
   * @private
   * @param {object} state 当前 loop state（已含 history/iteration/failingDrivers）
   * @param {{verdict:string, reason?:string}} verdict 终态判定对象（取 .verdict）
   * @returns {object} 写入 state.terminalReport 的报告对象（含 verdict/markdown/degraded）
   */
  _generateTerminalReport(state, verdict) {
    var verdictStr = (verdict && verdict.verdict) ? verdict.verdict : '';
    if (!TERMINAL_REPORT_VERDICTS[verdictStr]) {
      // 非三类终态（achieved/continue 等）不产报告
      return null;
    }

    // 降级：loop-report 模块不可用，仍标记终态但报告为降级占位
    if (!loopReport || typeof loopReport.generateTerminalReport !== 'function') {
      var degraded = {
        degraded: true,
        verdict: verdictStr,
        loopId: state ? state.loopId : '',
        markdown: null,
        summary: '终态报告生成降级：loop-report 模块不可用',
        reason: 'require ../../runtime/loop-report 失败',
      };
      try {
        console.warn('[provider-loop-engine] loop-report unavailable; terminal report degraded');
      } catch (_warnErr) { /* console 不可用时静默 */ }
      if (state) state.terminalReport = degraded;
      return degraded;
    }

    // 主路径：纯函数生成报告（state 内含 history/failingDrivers/lastEval/loopId/iteration）
    try {
      var report = loopReport.generateTerminalReport(state, {
        loopId: state ? state.loopId : '',
        verdict: verdictStr,
      });
      if (state) state.terminalReport = report;
      return report;
    } catch (e) {
      // generateTerminalReport 内部已对 state 缺失做容错，理论上不抛；防御性兜底
      var fallback = {
        degraded: true,
        verdict: verdictStr,
        loopId: state ? state.loopId : '',
        markdown: null,
        summary: '终态报告生成异常：' + (e && e.message ? e.message : String(e)),
      };
      if (state) state.terminalReport = fallback;
      return fallback;
    }
  }

  /**
   * 构造传给 actuator.execute() 的 context（WP-177-2-impl-b）。
   *
   * 在原 context（onActivate 注入 / factory 形参）上叠加 getStateStore()，
   * 返回 engine 自身的 _store 句柄。目的是让 loop-actuator.resolveStore 命中
   * 优先级 1（context.getStateStore()），复用同一 StateStore 实例，避免
   * actuator 自建实例与 engine _store 缓存不共享（pendingAction/lastChecklist
   * 跨实例读写丢失）。
   *
   * 透传原 context 的所有字段（getProvider / config 等），仅追加 getStateStore。
   * @private
   * @param {PluginContext} context 原 context（可能为 null）
   * @returns {object} 带 getStateStore() 的增强 context
   */
  _buildActuatorContext(context) {
    var base = context || {};
    var store = this._store;
    return Object.assign({}, base, {
      getStateStore: function () { return store; },
    });
  }

  /**
   * factory 返回 loop-engine API。
   * @param {PluginContext} context
   * @returns {Promise<object>}
   */
  async factory(context) {
    var self = this;

    // 确保 state-store 已初始化（factory 可能先于 onActivate 调用）
    self._ensureStore();

    // ---- 私有辅助 ----

    /**
     * state-store key 前缀。
     * @param {string} loopId
     * @returns {string}
     */
    function stateKey(loopId) {
      return 'loop.' + loopId;
    }

    /**
     * 读取 loop 状态（state-store）。
     * @param {string} loopId
     * @returns {Promise<object|undefined>}
     */
    function loadState(loopId) {
      return self._store.get(stateKey(loopId));
    }

    /**
     * 写入完整 loop 状态并更新 lastUpdatedAt。
     * @param {object} state
     * @returns {Promise<void>}
     */
    async function saveState(state) {
      state.lastUpdatedAt = nowIso();
      await self._store.set(stateKey(state.loopId), state);
    }

    /**
     * 记录一轮判定到 history（防丢失写回，design.md §8.3 不变量）。
     * @param {object} state
     * @param {object} entry
     */
    function pushHistory(state, entry) {
      state.history.push(entry);
    }

    /**
     * 获取快照聚合 delegate（注入或降级）。
     * @returns {object}
     */
    function getSnapshotDelegate() {
      return self._delegates.snapshot;
    }

    /**
     * 获取评分 delegate（注入或降级）。
     * @returns {object}
     */
    function getEvaluatorDelegate() {
      return self._delegates.evaluator;
    }

    /**
     * 获取执行器 delegate（注入或占位）。
     * @returns {object}
     */
    function getActuatorDelegate() {
      return self._delegates.actuator;
    }

    // ---- 公开 API ----

    /**
     * loop-engine API 对象。step() 通过此引用调用 observe/think/act/reflect/decide，
     * 保证单步编排顺序与每个 phase 的 persist 写回都走同一份实现。
     * @type {object}
     */
    var factoryApi = {
      /**
       * 初始化/恢复一次 loop 运行。
       * 若 state-store 已有 loopId 且 status==="running"，从断点恢复（防上下文压缩）。
       * @param {object} opts - { loopId?, teamName, goal }
       * @returns {Promise<{ loopId: string, restored: boolean, state: object }>}
       */
      init: async function (opts) {
        opts = opts || {};
        var loopId = opts.loopId || generateLoopId();

        // 运行时阈值 override（WP-177-2-impl-a）：
        //   init(opts) 传入的 maxIterations / maxRoundTimeMs / maxWallTimeMs /
        //   divergenceThreshold / proximityGoal 优先级最高（默认 ← plugin.json ← override）。
        //   仅当传入且为合法数值时覆盖，避免污染默认配置；其他 loopId/teamName
        //   共享同一份 self._config，故 override 累积到 engine 实例（单 loop 场景
        //   足够；多 loop 并发共享阈值符合「同一 engine 一套阈值」语义）。
        var override = {};
        if (typeof opts.maxIterations === 'number') override.max_iterations = opts.maxIterations;
        if (typeof opts.maxRoundTimeMs === 'number') override.max_round_time_ms = opts.maxRoundTimeMs;
        if (typeof opts.maxWallTimeMs === 'number') override.max_wall_time_ms = opts.maxWallTimeMs;
        if (typeof opts.divergenceThreshold === 'number') override.divergence_threshold = opts.divergenceThreshold;
        if (typeof opts.proximityGoal === 'number') override.proximity_goal = opts.proximityGoal;
        if (Object.keys(override).length > 0) {
          self._config = mergeConfig(self._config, override);
        }

        var existing = await loadState(loopId);

        if (existing && existing.status === 'running') {
          // 从断点恢复（design.md §8.2 / 5.1.3）
          // 保持 iteration/history/phase 不回退（不变量 §8.3）
          existing.lastUpdatedAt = nowIso();
          return { loopId: loopId, restored: true, state: existing };
        }

        var state = createLoopState({
          loopId: loopId,
          teamName: opts.teamName,
          goal: opts.goal,
        });
        await saveState(state);
        return { loopId: loopId, restored: false, state: state };
      },

      /**
       * Observe 阶段：聚合环境快照。
       * 委托 loop-snapshot（WP-174-3）；未注入时降级为最小快照（仅 loop 自身状态）。
       * @param {string} loopId
       * @returns {Promise<object>} LoopSnapshot（design.md §5.2.2）
       */
      observe: async function (loopId) {
        var state = await loadState(loopId);
        if (!state) {
          throw new Error('loop-engine.observe: unknown loopId ' + loopId);
        }
        state.phase = 'observe';

        var snapshot;
        var snapDelegate = getSnapshotDelegate();
        if (snapDelegate && typeof snapDelegate.aggregate === 'function') {
          snapshot = await snapDelegate.aggregate(self._context || context, loopId);
        } else {
          // 降级：最小可用快照（loop 自身上下文，不含外部源）
          snapshot = self._fallbackSnapshot(loopId, state);
        }

        state.lastSnapshot = snapshot;
        await saveState(state); // observe 后 persist（design.md §5.1.3）
        return snapshot;
      },

      /**
       * Think 阶段：基于快照决策下一步。
       * 决策类型：dispatch / retry / resplit / noop。
       * @param {string} loopId
       * @param {object} snapshot
       * @returns {Promise<object>} { action, targetWp?, strategy?, reason }
       */
      think: async function (loopId, snapshot) {
        var state = await loadState(loopId);
        if (!state) {
          throw new Error('loop-engine.think: unknown loopId ' + loopId);
        }
        state.phase = 'think';

        var decision = self._think(state, snapshot || state.lastSnapshot);

        state.lastDecision = decision;
        await saveState(state); // think 后 persist
        return decision;
      },

      /**
       * Act 阶段：执行决策（驱动 agent-dispatcher + checklist）。
       * 委托注入的 actuator（WP-177-2-impl-b：默认自动注入 loop-actuator）。
       * actuator 不可用时降级记录决策（不返回 placeholder，保留 dispatched:false 兜底）。
       * @param {string} loopId
       * @param {object} decision
       * @returns {Promise<{ dispatched: boolean, checklistResult?: object }>}
       */
      act: async function (loopId, decision) {
        var state = await loadState(loopId);
        if (!state) {
          throw new Error('loop-engine.act: unknown loopId ' + loopId);
        }
        state.phase = 'act';

        // 单轮时长基线（WP-177-2-impl-a/b）：act 是单轮执行主体，记录开始时间供
        // step() 在 act 完成后校验单轮耗时是否超 max_round_time_ms。
        var actStartedAt = Date.now();

        var actuator = getActuatorDelegate();
        var result;
        if (actuator && typeof actuator.execute === 'function') {
          // 主路径：调用注入的 actuator（默认 loop-actuator），序列化 decision 为
          // dispatcher 待执行指令写入 state-store，返回 {dispatched:true, checklistResult?}。
          //
          // 传入增强 context（actuatorContext）：在原 context 上叠加 getStateStore()，
          // 使 loop-actuator.resolveStore 复用 engine 的 _store 实例（避免两个 StateStore
          // 实例缓存不共享导致 pendingAction/lastChecklist 读写不一致，WP-177-2-impl-b）。
          var actuatorContext = self._buildActuatorContext(context);
          result = await actuator.execute(actuatorContext, loopId, decision, state);
        } else {
          // 降级兜底（actuator require 失败 / 显式置空）：不执行副作用，仅记录决策。
          //   注意：不再返回 placeholder:true（WP-177-2-impl-b 移除占位语义）；
          //   dispatched:false 表示本轮无指令产出，step() 仍可继续流转。
          result = { dispatched: false, checklistResult: undefined, degraded: true };
        }

        // 将 checklist 结果写入独立子 key（供 reflection-evaluator 消费，design.md §5.4.4）
        if (result && result.checklistResult) {
          await self._store.set(stateKey(loopId) + '.lastChecklist', result.checklistResult);
        }

        // 单轮耗时记录（供 step() 校验 max_round_time_ms，WP-177-2-impl-a/b）
        if (result) {
          result.roundElapsedMs = Date.now() - actStartedAt;
        }

        state.lastActResult = result;
        await saveState(state); // act 后 persist
        return result;
      },

      /**
       * Reflect 阶段：评分（委托 reflection-evaluator，WP-174-3）。
       * @param {string} loopId
       * @param {object} snapshot
       * @returns {Promise<object>} EvalResult（design.md §5.3.2）
       */
      reflect: async function (loopId, snapshot) {
        var state = await loadState(loopId);
        if (!state) {
          throw new Error('loop-engine.reflect: unknown loopId ' + loopId);
        }
        state.phase = 'reflect';

        var evalDelegate = getEvaluatorDelegate();
        var evalResult;
        if (evalDelegate && typeof evalDelegate.score === 'function') {
          evalResult = await evalDelegate.score(
            self._context || context,
            loopId,
            snapshot || state.lastSnapshot,
            state
          );
        } else {
          // 降级：基于 lastChecklist 的最小评分
          evalResult = self._fallbackEval(loopId, state, snapshot || state.lastSnapshot);
        }

        // 同步发散计数 + 失败驱动到 state（decide / 下轮 Think 依赖，修复点 B / 偏差1）
        //   - divergenceStreak：发散判定输入（design.md §6.3.1）
        //   - failingDrivers：失败项明细，回填后供下轮 Think 的 retry decision 携带、
        //     以及运行时 Claude 从 state 直接读取（偏差1：engine 原先只回填 streak，
        //     失败明细未进 state，retry 反馈链路在 engine 路径断裂）
        state.divergenceStreak = evalResult.divergenceStreak || 0;
        state.failingDrivers = evalResult.failingDrivers || [];
        state.lastEval = evalResult;
        await saveState(state); // reflect 后 persist
        return evalResult;
      },

      /**
       * Decide 阶段：三类终止判定（design.md §6，优先级 熔断>发散>达成>上限>继续）。
       * @param {string} loopId
       * @param {object} evalResult
       * @returns {Promise<{ verdict: string, reason: string }>}
       */
      decide: async function (loopId, evalResult) {
        var state = await loadState(loopId);
        if (!state) {
          throw new Error('loop-engine.decide: unknown loopId ' + loopId);
        }
        state.phase = 'decide';

        // 优先查询 watchdog 健康（熔断判定），失败降级为健康
        var watchdogHealth = await self._queryWatchdogHealth(context);

        var verdict = self._decide(state, evalResult || state.lastEval, watchdogHealth);

        state.lastVerdict = verdict;
        // 终止类 verdict 写终态 status（design.md §6.1-6.3）
        if (verdict.verdict === 'achieved') state.status = 'achieved';
        else if (verdict.verdict === 'timeout') state.status = 'timeout';
        else if (verdict.verdict === 'diverged') state.status = 'diverged';
        else if (verdict.verdict === 'circuit_broken') state.status = 'circuit_broken';

        // WP-177-2-impl-c：三类终态（timeout/diverged/circuit_broken）自主生成报告写 state，
        // 不再依赖外部「回 P1」；achieved 不产报告（走 completion）。
        //   decide 是 timeout/diverged/circuit_broken 的主要产出点（_decide 主体判定），
        //   故在此内聚生成。step() 的提前 timeout 出口另调 _generateTerminalReport 补报告。
        if (TERMINAL_REPORT_VERDICTS[verdict.verdict]) {
          self._generateTerminalReport(state, verdict);
        }

        await saveState(state); // decide 后 persist
        return verdict;
      },

      /**
       * 单步推进：observe→think→act→reflect→decide 一轮。
       * skill-agentic-loop 在 while 循环中调用（design.md §4.1）。
       * @param {string} loopId
       * @returns {Promise<{ verdict: string, iteration: number, state: object }>}
       */
      step: async function (loopId) {
        var state = await loadState(loopId);
        if (!state) {
          throw new Error('loop-engine.step: unknown loopId ' + loopId);
        }
        // 已终止则直接返回，不推进
        if (state.status !== 'running' && state.status !== 'paused') {
          return {
            verdict: state.lastVerdict ? state.lastVerdict.verdict : state.status,
            iteration: state.iteration,
            state: state,
            // 透传已生成的终态报告（终态已在前次出口写入 state.terminalReport）
            report: state.terminalReport || null,
          };
        }

        // 单轮开始前先检查墙钟硬上限。
        //   iteration 上限改由 _decide 在轮末统一判定（修复末轮达成被误判 timeout 的 bug）：
        //   预检在 iteration 递增前、拿不到本轮 evalResult，无法判本轮是否达成；放行让 _decide
        //   用最新 evalResult 判——达成则 achieved、未达成才 timeout（兜底）。max_iterations 硬上限
        //   由 _decide + driver safetyMax 双兜底，不会死循环。
        var wallElapsed = Date.now() - new Date(state.startedAt).getTime();
        if (wallElapsed >= self._config.max_wall_time_ms) {
          var wallVerdict = { verdict: 'timeout', reason: '墙钟上限已达 max_wall_time_ms' };
          state.status = 'timeout';
          state.lastVerdict = wallVerdict;
          self._generateTerminalReport(state, wallVerdict);
          await saveState(state);
          return {
            verdict: 'timeout',
            iteration: state.iteration,
            state: state,
            report: state.terminalReport || null,
          };
        }

        // iteration 单调递增（不变量 §8.3）
        state.iteration = state.iteration + 1;
        await saveState(state);

        // Observe → Think → Act → Reflect → Decide（显式顺序，每个 phase 各自 persist）
        // WP-196-1-impl：五段式阶段级耗时打点（仅观测，决策逻辑零改动）。
        //   各阶段前后用 Date.now() 包裹记 {phase, startMs, endMs, elapsedMs, summary}，
        //   全程 try/catch 降级——观测异常绝不阻断 loop 主流程（承袭 WP-191 心跳降级纪律）。
        var phaseTimings = [];
        function timePhase(name, fn) {
          // 返回 Promise<value>；计时失败时仍返回 fn 结果，仅丢失 timing。
          var startMs = Date.now();
          var p;
          try {
            p = Promise.resolve(fn());
          } catch (e) {
            p = Promise.reject(e);
          }
          return p.then(function (value) {
            try {
              phaseTimings.push({
                phase: name,
                startMs: startMs,
                endMs: Date.now(),
                elapsedMs: Date.now() - startMs,
              });
            } catch (_te) { /* 计时降级：忽略 */ }
            return value;
          });
        }

        var snapshot = await timePhase('observe', function () { return factoryApi.observe(loopId); });
        var decision = await timePhase('think', function () { return factoryApi.think(loopId, snapshot); });
        var actResult = await timePhase('act', function () { return factoryApi.act(loopId, decision); });

        // 单轮时长校验（WP-177-2-impl-a/b）：act 完成后若本轮耗时超过
        // max_round_time_ms，直接判 timeout 终止，跳过 reflect/decide。
        //   act() 已在 lastActResult.roundElapsedMs 记录单轮耗时；这里读取校验。
        //   超时语义：单轮 act 拖过最长时间视为「本轮卡死」，提前终止避免无限挂起。
        var roundMs = (actResult && typeof actResult.roundElapsedMs === 'number')
          ? actResult.roundElapsedMs : 0;
        if (roundMs >= self._config.max_round_time_ms) {
          var stateTimeout = await loadState(loopId);
          stateTimeout.status = 'timeout';
          stateTimeout.lastVerdict = {
            verdict: 'timeout',
            reason: '单轮耗时 ' + roundMs + 'ms 已达上限 max_round_time_ms ' +
              self._config.max_round_time_ms,
          };
          pushHistory(stateTimeout, {
            iteration: stateTimeout.iteration,
            snapshotSummary: self._summarizeSnapshot(snapshot),
            decision: decision,
            eval: { roundTimeout: true, roundElapsedMs: roundMs },
            verdict: 'timeout',
            timestamp: nowIso(),
          });
          // WP-177-2-impl-c：单轮超时出口自主生成报告（history 已写入，报告含本轮趋势）
          self._generateTerminalReport(stateTimeout, stateTimeout.lastVerdict);
          await saveState(stateTimeout);
          return {
            verdict: 'timeout',
            iteration: stateTimeout.iteration,
            state: stateTimeout,
            report: stateTimeout.terminalReport || null,
            // WP-196-1-impl：单轮超时出口已跑完 observe/think/act，附已采集的阶段耗时
            //   （reflect/decide 未执行故缺）。纯观测，driver 落盘用。
            phaseTimings: phaseTimings,
          };
        }

        var evalResult = await timePhase('reflect', function () { return factoryApi.reflect(loopId, snapshot); });
        var verdict = await timePhase('decide', function () { return factoryApi.decide(loopId, evalResult); });

        // 写本轮历史（防丢失，发散检测依赖完整 history）
        var stateFinal = await loadState(loopId);
        pushHistory(stateFinal, {
          iteration: stateFinal.iteration,
          snapshotSummary: self._summarizeSnapshot(snapshot),
          decision: decision,
          eval: {
            proximity: evalResult.proximity,
            converged: evalResult.converged,
            diverged: evalResult.diverged,
            // 本轮失败项数（WP-176-5）：下轮 reflection-evaluator 经
            // prevFailedCountFromHistory 读取，驱动发散宽容（部分改进不计入 streak）。
            failedCount: (typeof evalResult.failedCount === 'number')
              ? evalResult.failedCount : null,
            // 无代码进展信号（WP-191-2-impl）：下轮 reflection-evaluator 经
            // noProgressStreakFromHistory 读取，累计 noProgressStreak 驱动发散熔断。
            noProgress: evalResult.noProgress === true,
          },
          verdict: verdict.verdict,
          timestamp: nowIso(),
        });
        // WP-177-2-impl-c：decide() 已生成报告，但那时 history 缺本轮记录；
        //   此处 history 完整后对三类终态重新生成（覆盖），使 proximityTrend 含末轮。
        //   achieved/continue 不产报告（achieved 走 completion）。
        var finalReport = null;
        if (TERMINAL_REPORT_VERDICTS[verdict.verdict]) {
          finalReport = self._generateTerminalReport(stateFinal, verdict);
        }
        await saveState(stateFinal);

        // WP-196-1-impl：补各阶段产出摘要（仅读取已采集局部变量，不新增决策分支），
        //   并把 phaseTimings 附到返回值供 driver 落盘/可见性输出。全程 try/catch 降级。
        var phaseTimingsWithSummary = phaseTimings;
        try {
          var summaries = self._buildPhaseSummaries({
            snapshot: snapshot,
            decision: decision,
            actResult: actResult,
            evalResult: evalResult,
            verdict: verdict,
          });
          phaseTimingsWithSummary = phaseTimings.map(function (pt) {
            var enriched = Object.assign({}, pt);
            if (summaries[pt.phase] !== undefined) enriched.summary = summaries[pt.phase];
            return enriched;
          });
        } catch (_se) { /* 摘要降级：保留无 summary 的 timings */ }

        return {
          verdict: verdict.verdict,
          iteration: stateFinal.iteration,
          state: stateFinal,
          report: finalReport,
          // WP-196-1-impl：per-round 五段式阶段级耗时（observe/think/act/reflect/decide），
          //   纯观测字段，driver 聚合落盘 .tackle/loop-{loopId}/trace.jsonl。
          phaseTimings: phaseTimingsWithSummary,
        };
      },

      /**
       * 持久化当前 loop 状态（委托 state-store.set）。
       * @param {string} loopId
       * @returns {Promise<void>}
       */
      persist: async function (loopId) {
        var state = await loadState(loopId);
        if (!state) {
          throw new Error('loop-engine.persist: unknown loopId ' + loopId);
        }
        await saveState(state);
      },

      /**
       * 查询 loop 状态。
       * @param {string} loopId
       * @returns {Promise<object>}
       */
      getState: async function (loopId) {
        var state = await loadState(loopId);
        if (!state) {
          throw new Error('loop-engine.getState: unknown loopId ' + loopId);
        }
        return state;
      },

      /**
       * 外部指令（回 P1 人介入触发路径，参考 dispatcher daemon-actions）。
       * action: "pause" | "abort" | "abort_all"
       * @param {string} loopId
       * @param {object} directive - { action, reason }
       * @returns {Promise<boolean>}
       */
      applyDirective: async function (loopId, directive) {
        directive = directive || {};
        var state = await loadState(loopId);
        if (!state) {
          throw new Error('loop-engine.applyDirective: unknown loopId ' + loopId);
        }
        var action = directive.action;
        if (action === 'pause') {
          state.status = 'paused';
          state.lastDirective = directive;
          await saveState(state);
          return true;
        }
        if (action === 'abort' || action === 'abort_all') {
          state.status = 'aborted';
          state.lastDirective = directive;
          state.lastVerdict = {
            verdict: action === 'abort_all' ? 'circuit_broken' : 'aborted',
            reason: directive.reason || ('外部指令 ' + action),
          };
          await saveState(state);
          return true;
        }
        return false; // 未知指令
      },

      /**
       * 依赖注入：注入 loop-snapshot / reflection-evaluator / actuator。
       * 由 WP-174-3 / WP-174-4 调用，未注入时 engine 走降级路径。
       * @param {object} delegate - { snapshot?, evaluator?, actuator? }
       */
      inject: function (delegate) {
        delegate = delegate || {};
        if (delegate.snapshot) self._delegates.snapshot = delegate.snapshot;
        if (delegate.evaluator) self._delegates.evaluator = delegate.evaluator;
        if (delegate.actuator) self._delegates.actuator = delegate.actuator;
        return true;
      },

      /**
       * 获取运行时配置（调试用）。
       * @returns {object}
       */
      getConfig: function () {
        return mergeConfig(self._config, {});
      },
    };

    return factoryApi;
  }

  // -------------------------------------------------------------------------
  // 私有：状态机核心逻辑
  // -------------------------------------------------------------------------

  /**
   * 确保 state-store 已初始化。
   * @private
   */
  _ensureStore() {
    if (this._store) return;
    this._projectRoot = this._resolveProjectRoot();
    var stateFilePath = path.join(this._projectRoot, '.claude-state');
    this._store = new StateStore({ filePath: stateFilePath });
    // factory 可能先于 onActivate 调用：兜底自动注入 loop-actuator（幂等，已注入则跳过）
    this._autoInjectLoopActuator();
  }

  /**
   * Think 核心逻辑：基于快照产出决策。
   * 优先级：失败项重试 > 待执行调度 > 被阻塞 noop。
   * @private
   * @param {object} state
   * @param {object} snapshot
   * @returns {object} { action, targetWp?, strategy?, reason }
   */
  _think(state, snapshot) {
    if (!snapshot) {
      return { action: 'noop', reason: '无快照，等待 observe' };
    }
    var wp = snapshot.workPackages || {};
    var goal = state.goal || {};
    var goalWps = (goal.wpIds && goal.wpIds.length ? goal.wpIds : null);

    // 1) 失败项优先重试（evaluator-refine 反馈驱动，design.md §3.3）
    //    retry 分支命中的真实数据流（修复偏差1 + engine/运行时落差）：
    //      wp.failed 由 loop-snapshot.buildWorkPackages 从 lastChecklist.failedItems
    //      聚合填充（WP-176-2），不再写死空数组；retry decision 携带 failingDrivers
    //      明细（Reflect 回填自 EvalResult.failingDrivers，供运行时 Step 4.2 /
    //      WP-176-4 下发给承接重做的 Teamee 作为 refine 反馈）。
    if (wp.failed && wp.failed.length > 0) {
      var retryWp = wp.failed[0];
      var strategy = (state.checkpoints && state.checkpoints[retryWp])
        ? 'checkpoint_resume'
        : 'full_restart';
      // failingDrivers 明细：优先 Reflect 回填的 state.failingDrivers，
      // 回退最近一次 EvalResult（state.lastEval），二者均为空时降级为空数组
      var failingDrivers = (state.failingDrivers && state.failingDrivers.length)
        ? state.failingDrivers
        : ((state.lastEval && state.lastEval.failingDrivers) || []);
      return {
        action: 'retry',
        targetWp: retryWp,
        strategy: strategy,
        failingDrivers: failingDrivers,
        reason: 'checklist 失败项，执行 refine 重试',
      };
    }

    // 2) 上轮 checklist 失败（failed 为空但 lastChecklist.passed=false）→ resplit 候选
    if (snapshot.lastChecklist && snapshot.lastChecklist.passed === false) {
      return {
        action: 'resplit',
        targetWp: snapshot.lastChecklist.wpId,
        strategy: 'resplit',
        reason: '上轮 checklist 失败且无显式 failed 项，建议拆分当前 WP',
      };
    }

    // 3) 待执行调度（仅在 goal 范围内，不越界 P0，design.md §7.1）
    //    Step 0 拓扑接线（next-dev-plan Batch 1）：第一道保留原越界保护（scope 过滤，
    //    明确 noop reason）；第二道加 readyWave 过滤（candidate 依赖须全 completed）。
    //    降级：dependencyGraph 缺失时跳过第二道，candidate = 越界保护后的 pending[0]，
    //    行为 = v0.3.15。不改 _decide / DEFAULT_CONFIG（Step 0 硬约束）。
    if (wp.pending && wp.pending.length > 0) {
      // 第一道：越界保护（原 scope 过滤，保留「不在 goal 范围」明确 reason）
      var candidate = wp.pending[0];
      if (goalWps && goalWps.indexOf(candidate) === -1) {
        var inScope = null;
        for (var i = 0; i < wp.pending.length; i++) {
          if (goalWps.indexOf(wp.pending[i]) !== -1) { inScope = wp.pending[i]; break; }
        }
        if (!inScope) {
          return { action: 'noop', reason: 'pending WP 不在 goal 范围内，不越界调度' };
        }
        candidate = inScope;
      }
      // 第二道：readyWave 过滤——candidate 依赖须全 completed（仅 dependencyGraph 存在时）
      var depNodes = (goal.dependencyGraph && goal.dependencyGraph.nodes)
        ? goal.dependencyGraph.nodes : null;
      if (depNodes) {
        var completedSet = wp.completed || [];
        var isDepsReady = function (wid) {
          var node = depNodes[wid];
          if (!node) return true; // 节点缺失，视为无依赖
          var deps = node.dependencies || [];
          for (var d = 0; d < deps.length; d++) {
            if (completedSet.indexOf(deps[d]) === -1) return false; // 依赖未完成
          }
          return true;
        };
        if (!isDepsReady(candidate)) {
          // readyWave[0]：遍历 pending 找首个「goal 范围内 + 依赖就绪」的（拓扑序下通常
          // 即 pending[0]，此分支为 pending 排序异常/环的防御兜底）
          var ready = null;
          for (var j = 0; j < wp.pending.length; j++) {
            var pw = wp.pending[j];
            if (goalWps && goalWps.indexOf(pw) === -1) continue; // 跳过越界
            if (isDepsReady(pw)) { ready = pw; break; }
          }
          if (!ready) {
            return { action: 'noop', reason: 'pending WP 依赖未就绪，等待依赖完成（拓扑）' };
          }
          candidate = ready;
        }
      }
      return {
        action: 'dispatch',
        targetWp: candidate,
        strategy: 'full_restart',
        reason: '调度下一个就绪 WP（goal 范围内，依赖就绪）',
      };
    }

    // 4) 全部被阻塞 → noop（等依赖；持续 noop 会由发散/上限判定兜底）
    return { action: 'noop', reason: '无可执行项（pending/failed 均空或全阻塞）' };
  }

  /**
   * Decide 核心逻辑：三类终止判定。
   * 优先级：熔断 > 发散 > 达成 > 上限 > 继续。
   *   （「达成」上提到「上限」之前——修复末轮 iteration==max_iterations 时 proximity 已达标
   *    却被 max_iterations 抢判 timeout 的 bug；末轮达成本轮应判 achieved。）
   * @private
   * @param {object} state
   * @param {object} evalResult
   * @param {{health:string, running:boolean}} watchdogHealth
   * @returns {{ verdict: string, reason: string }}
   */
  _decide(state, evalResult, watchdogHealth) {
    evalResult = evalResult || {};

    // ① 熔断（watchdog terminated / 不运行 / 持续 degraded）
    if (watchdogHealth) {
      if (watchdogHealth.health === 'terminated' || watchdogHealth.running === false) {
        return { verdict: 'circuit_broken', reason: 'watchdog 守护已终止/未运行' };
      }
      if (watchdogHealth.health === 'degraded') {
        return { verdict: 'circuit_broken', reason: 'watchdog 持续 degraded' };
      }
    }

    // ② 发散（连续 N 轮无进展，design.md §6.3.1）
    //    协同判据（WP-191-2-impl，对齐 Ralph 熔断）：proximity 不升 OR 无代码进展，
    //    任一连续 divergence_threshold 轮 → diverged。保留现有 proximity streak 语义，
    //    并列消费 evaluator 计算的 noProgressStreak（来自 executor 工作树脏度信号）。
    var streak = evalResult.divergenceStreak;
    if (streak === undefined || streak === null) streak = state.divergenceStreak || 0;
    var noProgressStreak = (typeof evalResult.noProgressStreak === 'number')
      ? evalResult.noProgressStreak : 0;
    // 阈值统一取 engine 运行时 _config（含 init override），不直接采信 evaluator 的
    // diverged 字段——evaluator 用 DEFAULT_THRESHOLDS，会让其默认阈值 3 绕过 engine
    // 的 override（如测试 configOverride divergence_threshold=99）。两类 streak 都按
    // engine 阈值判定，与原版 proximity-only 行为一致，noProgress 协同同此阈值。
    if (streak >= this._config.divergence_threshold ||
        noProgressStreak >= this._config.divergence_threshold) {
      return {
        verdict: 'diverged',
        reason: '发散：proximity 连续 ' + streak + ' 轮无进展 / 无代码进展连续 ' +
          noProgressStreak + ' 轮（>= divergence_threshold ' +
          this._config.divergence_threshold + '）',
      };
    }

    // ③ 目标达成（checklist 全过 + proximity 达标 + 无 pending/failed，design.md §6.1）
    //    优先级上提到「上限」之前（修复末轮达成被误判 timeout 的 bug）：末轮
    //    iteration==max_iterations 时若 proximity 已达标，应判 achieved 而非 timeout——
    //    目标已达成却报失败违背「目标驱动 self-closing loop」根本语义。
    //    noFailed 现真实生效（修复偏差1 + 落差）：wp.failed 由 WP-176-2 填充，
    //    evalResult.failingDrivers 由 evaluator 从 lastChecklist.failedItems 算出。
    //    二者任一非空都意味着仍有失败项 → 不能判 achieved。
    var proximity = (typeof evalResult.proximity === 'number') ? evalResult.proximity : 0;
    var allPassed = evalResult.allPassed === true ||
      (evalResult.failingDrivers && evalResult.failingDrivers.length === 0 && proximity >= this._config.proximity_goal);
    var snapshot = state.lastSnapshot || {};
    var wp = snapshot.workPackages || {};
    var noPending = (!wp.pending || wp.pending.length === 0);
    var noFailed = (!wp.failed || wp.failed.length === 0) &&
      (!evalResult.failingDrivers || evalResult.failingDrivers.length === 0);
    if (allPassed && proximity >= this._config.proximity_goal && noPending && noFailed) {
      return { verdict: 'achieved', reason: 'checklist 全过且 proximity ' + proximity.toFixed(3) +
        ' >= goal ' + this._config.proximity_goal };
    }

    // ④ 迭代上限 / 墙钟上限（design.md §6.2）—— 兜底：本轮未达成才判 timeout
    if (state.iteration >= this._config.max_iterations) {
      return { verdict: 'timeout', reason: '迭代已达上限 max_iterations ' + this._config.max_iterations };
    }
    var wallElapsed = Date.now() - new Date(state.startedAt).getTime();
    if (wallElapsed >= this._config.max_wall_time_ms) {
      return { verdict: 'timeout', reason: '墙钟已达上限 max_wall_time_ms ' + this._config.max_wall_time_ms };
    }

    // ⑤ 继续
    return { verdict: 'continue', reason: '迭代 ' + state.iteration + ' 继续' };
  }

  /**
   * 查询 watchdog 健康（熔断判定输入，design.md §6.3.2）。
   *
   * 优先调用 WP-174-5 新增的 watchdog.getHealth()（三态：healthy/degraded/terminated，
   * 可区分 degraded），将其 state 字段映射为 engine 内部 health。
   * 若 provider 未提供 getHealth（旧版/降级），回退到 isRunning() 二态判定。
   * 任何异常降级为 healthy（不阻断 loop 主流程）。
   * @private
   * @param {PluginContext} context
   * @returns {Promise<{health:string, running:boolean, stale?:boolean}>}
   */
  async _queryWatchdogHealth(context) {
    try {
      if (!context || typeof context.getProvider !== 'function') {
        return { health: 'healthy', running: true };
      }
      var watchdog = await context.getProvider('provider:watchdog');
      if (!watchdog) {
        return { health: 'healthy', running: true };
      }
      // 优先用三态 getHealth（WP-174-5）
      if (typeof watchdog.getHealth === 'function') {
        var h = watchdog.getHealth();
        if (h && (h.state === 'healthy' || h.state === 'degraded' || h.state === 'terminated')) {
          return { health: h.state, running: h.running === true, stale: h.stale === true };
        }
      }
      // 降级：isRunning() 二态（health !== 'terminated'）
      if (typeof watchdog.isRunning === 'function') {
        var running = watchdog.isRunning();
        return { health: running ? 'healthy' : 'terminated', running: running };
      }
      return { health: 'healthy', running: true };
    } catch (e) {
      return { health: 'healthy', running: true };
    }
  }

  /**
   * 降级快照（无 loop-snapshot 注入时）：仅 loop 自身上下文 + state-store 中的 lastChecklist。
   * @private
   * @param {string} loopId
   * @param {object} state
   * @returns {object}
   */
  _fallbackSnapshot(loopId, state) {
    var goal = state.goal || {};
    return {
      loopId: loopId,
      iteration: state.iteration,
      capturedAt: nowIso(),
      workPackages: {
        total: (goal.wpIds || []).length,
        pending: (goal.wpIds || []).slice(),
        completed: [],
        failed: [],
        blocked: [],
      },
      lastChecklist: null,
      watchdog: { deployed: false, running: true, health: 'healthy' },
      gitDiff: { changedFiles: 0, insertions: 0, deletions: 0, filesByWp: {} },
      signals: { pendingDirectives: [] },
      _fallback: true,
    };
  }

  /**
   * 降级评分（无 reflection-evaluator 注入时）：基于 lastChecklist 算 proximity。
   * @private
   * @param {string} loopId
   * @param {object} state
   * @param {object} snapshot
   * @returns {object}
   */
  _fallbackEval(loopId, state, snapshot) {
    var proximity = 0;
    var allPassed = false;
    var failingDrivers = [];

    var chk = state.lastChecklist ||
      (snapshot && snapshot.lastChecklist) ||
      null;
    if (chk) {
      var summary = chk.summary || {};
      var total = summary.total || 0;
      var passed = summary.passed || 0;
      proximity = total > 0 ? 1 - ((total - passed) / total) : (chk.passed ? 1 : 0);
      allPassed = chk.passed === true;
      if (chk.failedItems) {
        for (var i = 0; i < chk.failedItems.length; i++) {
          var fi = chk.failedItems[i];
          failingDrivers.push({
            wpId: chk.wpId,
            category: fi.category,
            item: fi.id || fi.text,
            reason: fi.reason,
          });
        }
      }
    } else if (snapshot && snapshot.workPackages) {
      // 无 checklist 时按 WP 完成度近似
      var wp = snapshot.workPackages;
      var totalWp = (wp.total || 0);
      var doneWp = (wp.completed ? wp.completed.length : 0);
      proximity = totalWp > 0 ? doneWp / totalWp : 0;
    }

    // 收敛/发散（基于 history 末尾 proximity）
    var converged = false;
    var prevProximity = null;
    if (state.history && state.history.length > 0) {
      var last = state.history[state.history.length - 1];
      if (last && last.eval && typeof last.eval.proximity === 'number') {
        prevProximity = last.eval.proximity;
      }
    }
    if (prevProximity !== null) {
      converged = proximity > prevProximity;
    }

    var streak = state.divergenceStreak || 0;
    if (prevProximity !== null && proximity <= prevProximity) {
      streak = streak + 1;
    } else {
      streak = 0;
    }

    return {
      loopId: loopId,
      iteration: state.iteration,
      proximity: proximity,
      converged: converged,
      diverged: streak >= this._config.divergence_threshold,
      divergenceStreak: streak,
      trend: converged ? 'improving' : (prevProximity === null ? 'flat' : 'regressing'),
      categoryScores: [],
      failingDrivers: failingDrivers,
      allPassed: allPassed,
      recommendation: failingDrivers.length > 0
        ? 'retry_' + (failingDrivers[0].wpId || '')
        : (proximity >= this._config.proximity_goal ? 'achieved' : 'continue'),
      scoredAt: nowIso(),
      _fallback: true,
    };
  }

  /**
   * 压缩快照为 history 摘要（design.md §5.1.1 snapshotSummary）。
   * @private
   * @param {object} snapshot
   * @returns {object}
   */
  _summarizeSnapshot(snapshot) {
    if (!snapshot) return null;
    var wp = snapshot.workPackages || {};
    return {
      pendingWps: (wp.pending || []).length,
      failedChecks: snapshot.lastChecklist && snapshot.lastChecklist.summary
        ? snapshot.lastChecklist.summary.failed
        : 0,
      watchdogHealthy: !!(snapshot.watchdog && snapshot.watchdog.running),
    };
  }

  /**
   * 构建五段式各阶段产出摘要（WP-196-1-impl，纯观测）。
   * 仅读取 step() 已采集的局部变量，不新增任何决策分支；任一字段缺失返回 undefined（driver 据此省略）。
   * @private
   * @param {object} ctx { snapshot, decision, actResult, evalResult, verdict }
   * @returns {object} phase → summary（值可为 string/number/object）
   */
  _buildPhaseSummaries(ctx) {
    ctx = ctx || {};
    var out = {};
    try {
      // observe：pending WP 计数（复用 _summarizeSnapshot 口径，不重复造轮子）
      if (ctx.snapshot) {
        var ss = this._summarizeSnapshot(ctx.snapshot) || {};
        out.observe = { pendingWps: ss.pendingWps, failedChecks: ss.failedChecks };
      }
    } catch (_e) { /* 降级 */ }
    try {
      // think：本轮 decision 的 action + 目标 WP（若有）
      if (ctx.decision) {
        out.think = {
          action: ctx.decision.action || null,
          targetWp: ctx.decision.targetWp || (ctx.decision.wpId) || null,
        };
      }
    } catch (_e) { /* 降级 */ }
    try {
      // act：复用 actResult.roundElapsedMs（act 内部口径，单轮总耗时）+ dispatch WP
      if (ctx.actResult) {
        out.act = {
          roundElapsedMs: (typeof ctx.actResult.roundElapsedMs === 'number')
            ? ctx.actResult.roundElapsedMs : null,
          dispatchedWp: ctx.actResult.wpId || (ctx.decision && (ctx.decision.targetWp || ctx.decision.wpId)) || null,
        };
      }
    } catch (_e) { /* 降级 */ }
    try {
      // reflect：proximity + 发散/收敛信号（history 已记 eval，这里仅复述供 trace 一行可读）
      if (ctx.evalResult) {
        out.reflect = {
          proximity: (typeof ctx.evalResult.proximity === 'number')
            ? ctx.evalResult.proximity : null,
          diverged: ctx.evalResult.diverged === true,
          converged: ctx.evalResult.converged === true,
          failedCount: (typeof ctx.evalResult.failedCount === 'number')
            ? ctx.evalResult.failedCount : null,
        };
      }
    } catch (_e) { /* 降级 */ }
    try {
      // decide：verdict（多数终态出口在提前 return 路径，正常路径 verdict 由 _decide 产出）
      if (ctx.verdict) {
        out.decide = { verdict: ctx.verdict.verdict || null };
      }
    } catch (_e) { /* 降级 */ }
    return out;
  }

  /**
   * 解析项目根目录（仿 provider-state-store）。
   * @private
   * @returns {string}
   */
  _resolveProjectRoot() {
    var dir = process.cwd();
    for (var i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'task.md'))) return dir;
      if (fs.existsSync(path.join(dir, '.claude'))) return dir;
      var parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }
}

module.exports = LoopEngineProvider;
