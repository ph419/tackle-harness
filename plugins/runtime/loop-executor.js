/**
 * Loop Executor Factory — provider 路由层（WP-185-impl / WP-188 重构）
 *
 * @module loop-executor
 *
 * 职责：按 `opts.provider`（或 `opts.name`）分发到具体 executor 实现，统一
 * `createExecutor(opts)` 工厂入口。driver 与具体 executor 实现解耦——driver 只认
 * `createExecutor('local'|'default', opts)`，不直接 require 具体 executor 模块。
 *
 * 设计约束（docs/plan/agentic-loop-node-driver.md 硬约束 #3 / 成功标准 #4）：
 *   - provider 解耦点是 `executor.run()`；新增 executor 时，driver 与 engine 零改动——
 *     只需在此注册一行 + 新建 executor 模块。
 *   - 所有 executor 实现同一份接口契约：{ name, run(pendingAction)->Promise<CheckResult>, config }
 *
 * 注册表（REGISTRY）：executor 名 → 模块 require 函数（惰性 require，避免未用 executor
 *   的依赖在 driver 启动时被加载，如 executor-default 在 --executor=local 场景无需 spawn）。
 *
 * 别名：`claude` → `default`（向后兼容 v0.3.4~0.3.8 的 `--executor=claude`；重构后真实
 *   Anthropic 与智谱/mimo 等都走 default，按探测到的模型自动门控额度，故 claude 不再是
 *   独立模块）。listProviders 不列别名（仅暴露真实 executor 名），避免给用户制造"有 claude
 *   和 default 两个"的歧义；但 createExecutor('claude') 静默重定向。
 *
 * BREAKING（v0.3.10）：删除 `glm` executor。`--executor=glm` 现抛 unknown provider。
 *   智谱 GLM 现走 `--executor=default --settings=<glm-profile.json>`，由 provider-resolver
 *   探测到 glm 模型后自动启用 5h 额度感知。详见 CHANGELOG 与 README。
 */

'use strict';

// ---------------------------------------------------------------------------
// executor 注册表（别名在 createExecutor 内解析，不进 REGISTRY）
// ---------------------------------------------------------------------------

/**
 * executor 名 → 惰性 require 工厂。
 * 新增 executor：在此加一行 `'foo': function(){ return require('./executor-foo'); }`。
 */
var REGISTRY = {
  local: function () { return require('./executor-local'); },
  // WP-188 重构：单一真实 executor，spawn claude CLI，按 provider-resolver 探测结果门控额度。
  default: function () { return require('./executor-default'); },
};

// 别名表：alias → 真实 executor 名。listProviders 不列别名（避免歧义）。
var ALIASES = {
  claude: 'default', // 向后兼容 v0.3.4~0.3.8 的 --executor=claude
};

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 列出已注册的 executor 名（供 driver 在「未知 executor」时打印可用列表）。
 * 不列别名（别名是兼容垫片，不应作为推荐用法暴露）。
 * @returns {string[]}
 */
function listProviders() {
  return Object.keys(REGISTRY);
}

/**
 * 创建 executor 实例（路由 + 别名解析）。
 *
 * @param {string} [provider='local'] executor 名（local / default ...）；别名 claude→default
 * @param {object} [opts] 透传给具体 executor.createExecutor 的选项
 * @returns {{ name:string, run:Function, config:object }}
 * @throws {Error} provider 未注册时抛错（driver 捕获后打印可用列表）
 */
function createExecutor(provider, opts) {
  // 兼容 createExecutor(opts) 单参调用（此时 opts.provider 指定 provider）
  if (provider && typeof provider === 'object') {
    opts = provider;
    provider = opts.provider || 'local';
  }
  provider = provider || 'local';

  // 别名解析（claude → default）；别名不在 REGISTRY，避免 listProviders 暴露歧义
  if (!REGISTRY[provider] && ALIASES[provider]) {
    provider = ALIASES[provider];
  }

  var factory = REGISTRY[provider];
  if (!factory) {
    var err = new Error('unknown executor provider: ' + provider +
      ' (available: ' + listProviders().join(', ') + ')');
    err.code = 'UNKNOWN_EXECUTOR';
    err.provider = provider;
    err.available = listProviders();
    throw err;
  }

  var mod;
  try {
    mod = factory();
  } catch (e) {
    var loadErr = new Error('executor module load failed (' + provider + '): ' +
      (e && e.message ? e.message : String(e)));
    loadErr.code = 'EXECUTOR_LOAD_FAILED';
    loadErr.provider = provider;
    throw loadErr;
  }

  if (!mod || typeof mod.createExecutor !== 'function') {
    throw new Error('executor module "' + provider + '" missing createExecutor export');
  }

  return mod.createExecutor(opts);
}

module.exports = {
  createExecutor: createExecutor,
  listProviders: listProviders,
  _REGISTRY: REGISTRY,
  _ALIASES: ALIASES,
};
