/**
 * Loop Actuator — Agentic Loop Act 层执行器（WP-177-1-impl-b）
 *
 * @module loop-actuator
 *
 * 职责：实现 engine `act()` 期望的 actuator 接口
 *   `execute(context, loopId, decision, state) -> { dispatched, checklistResult? }`。
 *
 * 把 engine 的 decision（dispatch / retry / resplit）序列化为「dispatcher 待执行指令」
 * 写入 state-store 子 key `loop.{loopId}.pendingAction`，并注入 failingDrivers，
 * 支持 checklistResult 回填。这是让 `engine.step()` 端到端可跑、移除 `placeholder:true`
 * 占位的核心。
 *
 * 设计约束（docs/wp/WP-177.md「技术方案 actuator 注入架构」）：
 *   - actuator 只产出「指令 + 标记已派发」，不直接 spawn Teamee / 不调 Claude
 *   - pendingAction 是「待 Claude 消费」的指令，不是「已执行结果」
 *   - execute 返回 dispatched:true 表示「指令已就绪」，不代表子代理已跑完
 *   - 实际子代理执行由 Claude 按 skill.md 读取 pendingAction → 调 skill-agent-dispatcher 完成
 *   - dispatcher 执行后回填 CheckResult 到 loop.{loopId}.lastChecklist（由 engine.act 写入）
 *
 * 接入契约（必须匹配 provider-loop-engine/index.js inject 期望，见 :582 / :362-365）：
 *   loopEngine.inject({ actuator: createActuator() })
 *   engine 在 act 阶段调用：actuator.execute(context, loopId, decision, state)
 *
 * failingDrivers 结构（透传 reflection-evaluator.failingDriversFromChecklist 产出）：
 *   [{ wpId, category, item, reason }]
 * 来源是 decision.failingDrivers（engine Think 阶段携带，WP-176 已打通
 * Reflect→state→Think 链路），本模块只透传不重新计算。
 */

'use strict';

var path = require('path');
var { StateStore } = require('./state-store');

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

/**
 * decision.action → dispatcher 指令 mode 映射表。
 * 仅这三种 action 会被序列化为 pendingAction；noop（无可执行项）跳过派发。
 */
var ACTION_TO_MODE = {
  dispatch: 'dispatch',
  retry: 'retry',
  resplit: 'resplit',
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
 * 解析项目根目录（仿 provider-state-store / loop-snapshot：向上找 task.md / .claude）。
 * @returns {string}
 */
function resolveProjectRoot() {
  var dir = process.cwd();
  // 同步向上查找，最多 10 层
  for (var i = 0; i < 10; i++) {
    try {
      var fs = require('fs');
      if (fs.existsSync(path.join(dir, 'task.md'))) return dir;
      if (fs.existsSync(path.join(dir, '.claude'))) return dir;
    } catch (_e) {
      // fs 访问异常：继续向上
    }
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * 包装 provider:state-store 的 factory API 为统一 { get/set } 接口。
 * provider:state-store factory 返回 get(key)/set(key,val) 等。
 * @param {object} providerApi
 * @returns {{ get: Function, set: Function }}
 */
function wrapProviderStore(providerApi) {
  return {
    get: function (key) {
      return providerApi.get(key);
    },
    set: function (key, value) {
      return providerApi.set(key, value);
    },
  };
}

/**
 * 确定一个可用的 state-store 句柄。
 * 优先级：
 *   1. context.getStateStore()（engine 注入的便捷方法，若存在）
 *   2. context.getProvider('provider:state-store')（同步返回的 factory API）
 *   3. 本地 StateStore（.claude-state）
 * @param {PluginContext} context
 * @returns {{ store: object, injected: boolean } | null} 不可用时返回 null
 */
function resolveStore(context) {
  // 1) context.getStateStore() 便捷方法
  if (context && typeof context.getStateStore === 'function') {
    try {
      var direct = context.getStateStore();
      if (direct && (typeof direct.get === 'function' || typeof direct.set === 'function')) {
        return { store: direct, injected: true };
      }
    } catch (_e) {
      // 降级
    }
  }

  // 2) context.getProvider('provider:state-store')（同步）
  if (context && typeof context.getProvider === 'function') {
    try {
      var maybe = context.getProvider('provider:state-store');
      // async getProvider（返回 Promise）无法在同步 resolveStore 内消费，降级
      if (maybe && typeof maybe.then === 'function') {
        // 降级到本地 store
      } else if (maybe && (typeof maybe.get === 'function' || typeof maybe.set === 'function')) {
        return { store: wrapProviderStore(maybe), injected: true };
      }
    } catch (_e) {
      // 降级
    }
  }

  // 3) 本地 StateStore
  try {
    var root = resolveProjectRoot();
    return {
      store: new StateStore({ filePath: path.join(root, '.claude-state') }),
      injected: false,
    };
  } catch (_e) {
    return null; // state-store 完全不可用
  }
}

/**
 * 读取 loop state 下已回填的 lastChecklist（dispatcher 执行后由 engine.act 写入，
 * 见 index.js:372-374；此处用于回填路径——若 actuator 被调用时上一轮结果已就绪）。
 * @param {object} store { get }
 * @param {string} loopId
 * @returns {Promise<object|null>}
 */
async function loadLastChecklist(store, loopId) {
  try {
    var chk = await store.get('loop.' + loopId + '.lastChecklist');
    return chk || null;
  } catch (_e) {
    return null;
  }
}

/**
 * 把 engine decision 序列化为 dispatcher 待执行指令（pendingAction）。
 *
 * @param {string} loopId
 * @param {object} decision engine _think 产出：
 *   { action:'dispatch|retry|resplit|noop', targetWp?, strategy?, context?, failingDrivers?, reason }
 * @returns {object} pendingAction（写入 state-store 子 key loop.{loopId}.pendingAction）
 */
function buildPendingAction(loopId, decision) {
  decision = decision || {};
  var mode = ACTION_TO_MODE[decision.action];
  return {
    wpId: decision.targetWp || '',
    mode: mode, // dispatch | retry | resplit
    strategy: decision.strategy || (mode === 'retry' ? 'checkpoint_resume' : 'full_restart'),
    // checkpoint_resume（retry）时携带 context（如恢复点信息）；其余场景透传
    context: decision.context || null,
    // retry 时重点修复项（承接 WP-176 refine 通道；dispatcher 读取此字段注入 Teamee prompt）
    failingDrivers: (decision.failingDrivers && decision.failingDrivers.length)
      ? decision.failingDrivers.slice()
      : [],
    createdAt: nowIso(),
    loopId: loopId,
  };
}

/**
 * 计算幂等键（按 wpId+mode 去重/覆盖）。
 * 同一 decision 重复 execute 不产生重复 pendingAction——只要 key 相同即覆盖。
 * @param {object} pendingAction
 * @returns {string}
 */
function idempotencyKey(pendingAction) {
  return [pendingAction.mode || '', pendingAction.wpId || ''].join('::');
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 创建一个 actuator 实例（注入 engine.inject({ actuator })）。
 *
 * @param {object} [opts] 可选配置
 * @param {object} [opts.store] 外部预置的 state-store 句柄（测试注入用）
 * @returns {{ execute: Function }}
 */
function createActuator(opts) {
  opts = opts || {};

  return {
    /**
     * 执行 decision：序列化为 dispatcher 指令写入 state-store，并回填 checklistResult。
     *
     * 签名严格匹配 engine act() 调用（index.js:364-365）：
     *   execute(context, loopId, decision, state) -> Promise<{dispatched, checklistResult?}>
     *
     * @param {PluginContext} context loop-engine 注入的 context（含 getProvider / getStateStore）
     * @param {string} loopId loop 运行唯一 ID
     * @param {object} decision engine _think 产出
     * @param {object} state loop state（engine.act 传入）
     * @returns {Promise<{dispatched:boolean, checklistResult?:object, error?:string, placeholder?:boolean}>}
     */
    execute: async function (context, loopId, decision, state) {
      // 容错：state-store 不可用时降级返回，不抛异常中断 step()
      var storeRes = (opts.store)
        ? { store: opts.store, injected: true }
        : resolveStore(context);
      if (!storeRes || !storeRes.store || typeof storeRes.store.set !== 'function') {
        return { dispatched: false, checklistResult: undefined, error: 'state-store unavailable' };
      }
      var store = storeRes.store;

      // decision.action 不在派发集合（如 noop）→ 不产出指令，但仍可回填已就绪的 checklist
      if (!loopId || !decision || !ACTION_TO_MODE[decision.action]) {
        var fallbackChk = await loadLastChecklist(store, loopId);
        return {
          dispatched: false,
          checklistResult: fallbackChk || undefined,
        };
      }

      // 1) 序列化 decision 为 dispatcher 指令（含 failingDrivers）
      var pendingAction = buildPendingAction(loopId, decision);

      // 2) 幂等：按 wpId+mode 覆盖（同一 decision 重复 execute 不产生重复指令）
      //    state-store 的 set 对同一 key 直接覆盖，天然满足幂等；这里显式构造 key。
      var pendingKey = 'loop.' + loopId + '.pendingAction';
      try {
        await store.set(pendingKey, pendingAction);
      } catch (e) {
        return {
          dispatched: false,
          checklistResult: undefined,
          error: 'state-store set failed: ' + (e && e.message ? e.message : String(e)),
        };
      }

      // 3) 回填支持：若 state/已存在 lastChecklist，返回 checklistResult 供 engine 写入
      //    engine.act 在 result.checklistResult 存在时另行写入 lastChecklist（index.js:372-374）。
      //    这里优先 state.lastChecklist（engine 透传），否则读 store 子 key。
      var backfill = (state && state.lastChecklist) || (await loadLastChecklist(store, loopId));

      return {
        dispatched: true,
        checklistResult: backfill || undefined,
        _mode: pendingAction.mode,
        _idempotencyKey: idempotencyKey(pendingAction),
        _storeInjected: storeRes.injected,
      };
    },
  };
}

module.exports = {
  createActuator: createActuator,
  // 暴露内部工具便于单元测试
  _buildPendingAction: buildPendingAction,
  _idempotencyKey: idempotencyKey,
  _ACTION_TO_MODE: ACTION_TO_MODE,
};
