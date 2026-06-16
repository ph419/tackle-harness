/**
 * Loop Snapshot — Agentic Loop 环境感知聚合器（WP-174-3，Observe 层）
 *
 * @module loop-snapshot
 *
 * 聚合四类输入源为统一 LoopSnapshot 对象（design.md §5.2）：
 *   1. state-store     - loop 上下文 + 目标工作包（key: "loop.{loopId}"）
 *   2. progress-tracker - PROGRESS.md 中的 WP 完成标记（降级解析，失败不影响整体）
 *   3. watchdog        - context.getProvider('provider:watchdog')，isRunning/isDeployed
 *   4. git diff        - child_process 'git diff --stat'，本轮变更范围
 *   外加 lastChecklist  - state-store.get("loop.{loopId}.lastChecklist")（Act 阶段写入）
 *
 * 韧性约定（design.md §10 WP-174-3 提示）：任一输入源失败降级（try/catch + warning），
 * 不阻断聚合；缺失的源返回空字段，整体 LoopSnapshot 仍结构完整。
 *
 * 接入契约（必须匹配 provider-loop-engine/index.js inject 期望）：
 *   loopEngine.inject({ snapshot: thisModule })
 *   engine 在 observe 阶段调用：snapshot.aggregate(context, loopId) → LoopSnapshot
 *
 * 设计依据：docs/reports/agentic-loop-design.md §5.2
 */

'use strict';

var fs = require('fs');
var path = require('path');
var { execFileSync } = require('child_process');
var { StateStore } = require('./state-store');

// 复用 reflection-evaluator 的失败项归一化（WP-176-1 的 _failingWpsFromChecklist）。
// 该辅助产出"从 checklist 失败项 → 去重 wpId 候选集"的统一口径；snapshot 在此基础上
// 排除 completed、限定 goal 范围。evaluator 不可用时退化为本地等价实现。
var evaluatorNormalize;
try {
  evaluatorNormalize = require('./reflection-evaluator');
} catch (_e) {
  evaluatorNormalize = null;
}

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

/**
 * watchdog 状态查询超时（ms）。仅用于 fail-fast，watchdog 查询本身是同步的。
 */
var WATCHDOG_QUERY_TIMEOUT_MS = 2000;

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
 * 解析项目根目录（仿 provider-state-store / loop-engine：向上找 task.md / .claude）。
 * @returns {string}
 */
function resolveProjectRoot() {
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

/**
 * 确定一个可用的 state-store 句柄。
 * 优先复用 context 注入的 provider:state-store；否则用本地 StateStore（.claude-state）。
 * @param {PluginContext} context
 * @returns {{ store: StateStore, injected: boolean }}
 */
function resolveStore(context) {
  // 1) 优先 context 注入的 state-store provider（factory 返回的 API 含 get/set）
  if (context && typeof context.getProvider === 'function') {
    try {
      // getProvider 可能是 async（返回 Promise），也可能是同步；两种都兼容
      var maybe = context.getProvider('provider:state-store');
      if (maybe && typeof maybe.then === 'function') {
        // async getProvider 无法在同步 resolveStore 内 await，降级到本地 store
        // （engine 注入的 context 在 reflect/observe 路径下已就绪，但此处保持同步安全）
      } else if (maybe && (typeof maybe.get === 'function' || typeof maybe.getState === 'function')) {
        // provider:state-store 的 factory API 直接暴露 get/set
        return { store: wrapProviderStore(maybe), injected: true };
      }
    } catch (e) {
      // 注入失败，降级
    }
  }
  // 2) 降级：本地 StateStore
  var root = resolveProjectRoot();
  return {
    store: new StateStore({ filePath: path.join(root, '.claude-state') }),
    injected: false,
  };
}

/**
 * 包装 provider:state-store 的 factory API 为统一 { get/set } 接口。
 * provider:state-store factory 返回 get(key)/set(key,val)/getState() 等。
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
 * 查询 watchdog 健康（design.md §5.2.1 watchdog 源 / §6.3.2）。
 * 委托 context.getProvider('provider:watchdog')；失败降级为 { deployed:false, health:'unknown' }。
 * @param {PluginContext} context
 * @returns {{ deployed: boolean, running: boolean, health: string }}
 */
function queryWatchdog(context) {
  var fallback = { deployed: false, running: false, health: 'unknown' };
  if (!context || typeof context.getProvider !== 'function') {
    return fallback;
  }
  var watchdog;
  try {
    watchdog = context.getProvider('provider:watchdog');
  } catch (e) {
    return fallback;
  }
  // getProvider 可能返回 Promise（async provider）
  if (watchdog && typeof watchdog.then === 'function') {
    // 同步上下文无法 await，降级；watchdog 健康非关键路径（engine.decide 也会查）
    return fallback;
  }
  if (!watchdog || typeof watchdog !== 'object') {
    return fallback;
  }
  var deployed = typeof watchdog.isDeployed === 'function' ? !!watchdog.isDeployed() : false;
  var running = typeof watchdog.isRunning === 'function' ? !!watchdog.isRunning() : false;
  var health;
  if (!deployed) {
    health = 'undeployed';
  } else if (!running) {
    health = 'terminated';
  } else {
    health = 'healthy'; // isRunning 只能区分 terminated vs 非 terminated，无法区分 degraded
  }
  return { deployed: deployed, running: running, health: health };
}

/**
 * 解析 git diff 统计（design.md §5.2.1 git diff 源）。
 * 用 execFileSync 同步执行 'git diff --stat'（HEAD 相对未提交变更）。
 * 失败降级为零变更。
 * @param {string} projectRoot
 * @returns {{ changedFiles: number, insertions: number, deletions: number, filesByWp: object }}
 */
function queryGitDiff(projectRoot) {
  var empty = { changedFiles: 0, insertions: 0, deletions: 0, filesByWp: {} };
  var out;
  try {
    // --numstat 输出 "added\tdeleted\tpath"，便于聚合 insertions/deletions
    // stdio 显式 pipe 子进程 stderr：失败时（无 git/无 HEAD/非仓库）捕获到 e.stderr
    // 而不泄露到父进程 stderr（避免 `fatal: ambiguous argument 'HEAD'` 刷屏污染输出）
    out = execFileSync(
      'git',
      ['diff', '--numstat', 'HEAD'],
      { cwd: projectRoot, encoding: 'utf8', timeout: WATCHDOG_QUERY_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    // 无 git / 无 HEAD / 非仓库：静默降级（e.stderr 已被管道捕获，不打印）
    return empty;
  }
  if (!out) return empty;

  var changedFiles = 0;
  var insertions = 0;
  var deletions = 0;
  var lines = out.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var parts = line.split('\t');
    if (parts.length < 3) continue;
    var add = parts[0];
    var del = parts[1];
    var filePath = parts.slice(2).join('\t');
    // 二进制文件显示 "-\t-"，按 0 处理
    insertions += (add === '-' || isNaN(parseInt(add, 10))) ? 0 : parseInt(add, 10);
    deletions += (del === '-' || isNaN(parseInt(del, 10))) ? 0 : parseInt(del, 10);
    changedFiles += 1;
    // filesByWp：尝试从路径提取 WP-XXX 前缀（如 docs/wp/WP-174.md → "WP-174"）
    var wpMatch = String(filePath).match(/WP-?(\d+)/i);
    if (wpMatch) {
      var wpKey = 'WP-' + wpMatch[1];
      if (!empty.filesByWp[wpKey]) empty.filesByWp[wpKey] = [];
      empty.filesByWp[wpKey].push(filePath);
    }
  }
  return {
    changedFiles: changedFiles,
    insertions: insertions,
    deletions: deletions,
    filesByWp: empty.filesByWp,
  };
}

/**
 * 从 PROGRESS.md 解析 WP 完成状态（progress-tracker 源，降级解析）。
 * progress-tracker 没有标准 JSON 输出，仅维护 PROGRESS.md；这里做宽松正则匹配。
 * 匹配形如 "- [x] WP-175 ..." / "- [ ] WP-176 ..." 的行。
 * 失败返回 null（不阻断）。
 * @param {string} projectRoot
 * @returns {{ completed: string[], incomplete: string[] } | null}
 */
function parseProgressMarkdown(projectRoot) {
  var progressPath = path.join(projectRoot, 'PROGRESS.md');
  if (!fs.existsSync(progressPath)) return null;
  var content;
  try {
    content = fs.readFileSync(progressPath, 'utf8');
  } catch (e) {
    return null;
  }
  var completed = [];
  var incomplete = [];
  var lines = content.split(/\r?\n/);
  var reDone = /^\s*[-*]\s*\[[xX✓✔]\]\s*(WP-?\d+)/i;
  var reTodo = /^\s*[-*]\s*\[\s\]\s*(WP-?\d+)/i;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var mDone = line.match(reDone);
    if (mDone) {
      completed.push('WP-' + mDone[1].replace(/^WP-?/i, ''));
      continue;
    }
    var mTodo = line.match(reTodo);
    if (mTodo) {
      incomplete.push('WP-' + mTodo[1].replace(/^WP-?/i, ''));
    }
  }
  return { completed: completed, incomplete: incomplete };
}

/**
 * 从 loop state.goal.wpIds + progress 解析构建 workPackages 视图（design.md §5.2.2）。
 * 规则：
 *   - goal.wpIds 为目标全集（来源 truth）；progress.completed 为已完成的子集
 *   - pending = goalWps 中未在 completed 内的
 *   - failed = 上轮 checklist 失败项聚合出的 wpId（排除 completed、限定 goal 范围）
 *   - blocked 当前来源不足，留空数组（由后续 WP 填充）
 *
 * failed 推导（WP-176-2，修复偏差1）：
 *   从 lastChecklist.failedItems 经 evaluator 归一化得到失败驱动，按 wpId 去重；
 *   再排除已 completed（已通过的不算 failed）、限定 goal.wpIds 范围（越界保护）。
 *   这让 engine `_think` 的 retry 分支（wp.failed.length > 0）有真实数据支撑。
 *
 * @param {object} state loop state
 * @param {{completed:string[],incomplete:string[]}|null} progress
 * @param {object|null} [lastChecklist] 上轮 CheckResult（含 failedItems / wpId）
 * @returns {{total:number,pending:string[],completed:string[],failed:string[],blocked:string[]}}
 */
function buildWorkPackages(state, progress, lastChecklist) {
  var goal = (state && state.goal) || {};
  var goalWps = (goal.wpIds && goal.wpIds.length) ? goal.wpIds.slice() : [];
  var completed = (progress && progress.completed) ? progress.completed.slice() : [];
  var hasCompletion = function (wpId) {
    for (var i = 0; i < completed.length; i++) {
      if (completed[i] === wpId) return true;
    }
    return false;
  };
  // goal 范围集合（越界保护：failed 必须落在 goal.wpIds 内）
  var inGoal = function (wpId) {
    for (var i = 0; i < goalWps.length; i++) {
      if (goalWps[i] === wpId) return true;
    }
    return false;
  };
  var pending = [];
  for (var i = 0; i < goalWps.length; i++) {
    if (!hasCompletion(goalWps[i])) pending.push(goalWps[i]);
  }
  // failed：从 lastChecklist.failedItems 聚合 wpId（WP-176-1 的归一化产候选集，
  // snapshot 再排除 completed + 限定 goal 范围）。这让 engine `_think` retry 分支
  // （wp.failed.length > 0）有真实数据支撑（修复偏差1）。
  var failed = [];
  if (lastChecklist) {
    var candidates = [];
    if (evaluatorNormalize && typeof evaluatorNormalize._failingWpsFromChecklist === 'function') {
      candidates = evaluatorNormalize._failingWpsFromChecklist(lastChecklist);
    } else {
      candidates = failingWpsFromChecklistInline(lastChecklist);
    }
    for (var d = 0; d < candidates.length; d++) {
      var wid = candidates[d];
      if (!wid) continue;
      // 排除已 completed（已通过的不算 failed）；限定 goal 范围（越界保护）
      if (hasCompletion(wid)) continue;
      if (goalWps.length > 0 && !inGoal(wid)) continue;
      failed.push(wid);
    }
  }
  return {
    total: goalWps.length,
    pending: pending,
    completed: completed,
    failed: failed,
    blocked: [],
  };
}

/**
 * 内联的 failedItems → 失败 WP id 列表归一化（evaluator 不可用时的等价兜底）。
 * 与 reflection-evaluator.failingWpsFromChecklist 口径一致：wpId 优先取 fi.wpId，
 * 回退 chk.wpId；空 wpId 丢弃；按首次出现顺序去重。仅产候选集，不排除 completed/范围。
 * @param {object} chk CheckResult
 * @returns {string[]}
 */
function failingWpsFromChecklistInline(chk) {
  if (!chk || !chk.failedItems || !chk.failedItems.length) return [];
  var defaultWpId = chk.wpId || '';
  var seen = {};
  var out = [];
  for (var i = 0; i < chk.failedItems.length; i++) {
    var fi = chk.failedItems[i];
    if (!fi) continue;
    var wid = (typeof fi.wpId === 'string' && fi.wpId) ? fi.wpId : defaultWpId;
    if (!wid || seen[wid]) continue;
    seen[wid] = true;
    out.push(wid);
  }
  return out;
}

/**
 * 读取 loop state（state-store key "loop.{loopId}"），降级为 null。
 * @param {object} store { get, set }
 * @param {string} loopId
 * @returns {Promise<object|null>}
 */
async function loadLoopState(store, loopId) {
  try {
    var state = await store.get('loop.' + loopId);
    return state || null;
  } catch (e) {
    return null;
  }
}

/**
 * 读取上轮 checklist 结果（state-store key "loop.{loopId}.lastChecklist"，design.md §5.4.4）。
 * @param {object} store { get, set }
 * @param {string} loopId
 * @returns {Promise<object|null>}
 */
async function loadLastChecklist(store, loopId) {
  try {
    var chk = await store.get('loop.' + loopId + '.lastChecklist');
    return chk || null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

module.exports = {
  /**
   * 聚合所有输入源为 LoopSnapshot（design.md §5.2.2）。
   *
   * 任一输入源失败降级（不阻断聚合）：
   *   - state-store 读失败 → workPackages 退化为空集
   *   - progress 解析失败 → completed 为空
   *   - watchdog 不可用 → health='unknown'
   *   - git diff 不可用 → 零变更
   *
   * @param {PluginContext} context - loop-engine 注入的 context（含 getProvider）
   * @param {string} loopId - loop 运行唯一 ID
   * @returns {Promise<object>} LoopSnapshot
   */
  aggregate: async function (context, loopId) {
    if (!loopId) {
      throw new Error('loop-snapshot.aggregate: loopId is required');
    }

    var projectRoot = resolveProjectRoot();
    var storeRes = resolveStore(context);
    var store = storeRes.store;

    // 1) loop state（含 goal.wpIds）+ lastChecklist
    var state = await loadLoopState(store, loopId);
    var lastChecklist = await loadLastChecklist(store, loopId);

    // 2) progress（降级解析 PROGRESS.md）
    var progress = null;
    try {
      progress = parseProgressMarkdown(projectRoot);
    } catch (e) {
      progress = null;
    }

    // 3) workPackages 视图
    var workPackages;
    try {
      workPackages = buildWorkPackages(state, progress, lastChecklist);
    } catch (e) {
      workPackages = { total: 0, pending: [], completed: [], failed: [], blocked: [] };
    }

    // 4) watchdog 健康
    var watchdog;
    try {
      watchdog = queryWatchdog(context);
    } catch (e) {
      watchdog = { deployed: false, running: false, health: 'unknown' };
    }

    // 5) git diff
    var gitDiff;
    try {
      gitDiff = queryGitDiff(projectRoot);
    } catch (e) {
      gitDiff = { changedFiles: 0, insertions: 0, deletions: 0, filesByWp: {} };
    }

    // 6) signals（外部指令通道，当前从 loop state 间接推断；预留 daemon-actions 读取）
    var pendingDirectives = [];
    if (state && state.lastDirective && state.lastDirective.action === 'pause') {
      pendingDirectives.push('pause');
    }

    var iteration = (state && typeof state.iteration === 'number') ? state.iteration : 0;

    return {
      loopId: loopId,
      iteration: iteration,
      capturedAt: nowIso(),
      workPackages: workPackages,
      lastChecklist: lastChecklist,
      watchdog: watchdog,
      gitDiff: gitDiff,
      signals: { pendingDirectives: pendingDirectives },
      _storeInjected: storeRes.injected,
    };
  },

  // 暴露内部工具便于单元测试（WP-174-6）
  _resolveProjectRoot: resolveProjectRoot,
  _queryGitDiff: queryGitDiff,
  _parseProgressMarkdown: parseProgressMarkdown,
  _buildWorkPackages: buildWorkPackages,
  _queryWatchdog: queryWatchdog,
};
