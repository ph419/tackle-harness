'use strict';

/**
 * loop command — Agentic Loop Node Driver（WP-184-impl）
 *
 * @module bin/commands/loop
 *
 * 把 agentic loop 从「Claude 会话内伪代码循环」升级为「Node 进程级稳态循环」。
 * 本模块是循环的载体（Node 进程，非 skill）：while(!done) step() 直接调 engine JS API，
 * Claude/任意 provider 退化为可替换的 executor（provider 解耦点是 executor.run()）。
 *
 * 主流程（docs/plan/agentic-loop-node-driver.md WP-184）：
 *   解析 --plan → plan-reader 拆 WP → new LoopEngine() + factory({}) →
 *   inject({snapshot, evaluator}) → init({goal}) →
 *   while(!terminal) {
 *     step()                              // engine 跑 observe→think→act→reflect→decide
 *     consume pendingAction → executor.run() → 回填 lastChecklist + 写 PROGRESS.md
 *   }
 *
 * 数据流契约（硬约束 #5/#6）：
 *   - snapshot 从 PROGRESS.md 读 completed → driver 消费 pendingAction 后必须同步写
 *     `- [x] WP-NNN` 行（否则 completed 流转不回 engine）
 *   - lastChecklist 回填到 state-store 子 key `loop.{loopId}.lastChecklist`
 *
 * 缓存陷阱（上一会话深审挖出）：
 *   engine 内部持有自己的 StateStore 实例（_store），driver 另起一个 StateStore 读
 *   pendingAction/写 lastChecklist。两者共享同一 .claude-state 文件但各自有内存缓存，
 *   单进程下 driver 的 _cache 会读到 engine 最新写入前的旧值。**必须在每次读前
 *   invalidate()**，否则 pendingAction 永远停在首个 WP，loop 无法收敛。
 *
 * 退出码：achieved → 0；timeout/diverged/circuit_broken/aborted → 1。
 */

var path = require('path');
var fs = require('fs');
var safePath = require('../../plugins/runtime/safe-path');

// engine 与 runtime 依赖（engine 零改动，只调不改）
var LoopEngine = require('../../plugins/core/provider-loop-engine');
var { StateStore } = require('../../plugins/runtime/state-store');
var snapshotMod = require('../../plugins/runtime/loop-snapshot');
var evaluatorMod = require('../../plugins/runtime/reflection-evaluator');
var planReader = require('../../plugins/runtime/plan-reader');
// executor 路由工厂（WP-185 / WP-188 重构）：driver 只认 createExecutor('local'|'default', opts)，
// 新增 executor 只需在 loop-executor 注册一行，driver/engine 零改动。
var loopExecutor = require('../../plugins/runtime/loop-executor');
// 三层配置（env > harness-config.yaml > 默认）：读 loop.providers 段供 resolver 匹配。
var ConfigManager = require('../../plugins/runtime/config-manager');
// provider 解析器（WP-188 重构）：探测生效模型 + 匹配 provider profile，决定 default executor 特性。
var providerResolver = require('../../plugins/runtime/provider-resolver');

// 默认 plan.md 路径（与 plan-reader DEFAULT_PLAN_RELATIVE 一致）
var DEFAULT_PLAN_REL = path.join('.claude', 'plan.md');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/**
 * 从 filteredArgs（已剔除全局 flag）解析 loop 子命令参数。
 * 形如：['docs/plan/x.md', '--executor=local', '--max-iters=10', '--loop-id=loop-xxx']
 * @param {string[]} argv
 * @returns {{planPath:string|null, executor:string, loopId:string|null,
 *           maxIters:number|null, stateDir:string|null, dryRun:boolean, force:boolean,
 *           settingsPath:string|null, error?:string}}
 */
function parseArgs(argv) {
  argv = argv || [];
  var out = {
    planPath: null,
    executor: 'local',
    loopId: null,
    maxIters: null,
    stateDir: null,
    dryRun: false,
    force: false,
    settingsPath: null,
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a.indexOf('--executor=') === 0) {
      out.executor = a.slice('--executor='.length);
    } else if (a.indexOf('--loop-id=') === 0) {
      out.loopId = a.slice('--loop-id='.length);
    } else if (a.indexOf('--max-iters=') === 0) {
      out.maxIters = parseInt(a.slice('--max-iters='.length), 10);
    } else if (a.indexOf('--state-dir=') === 0) {
      out.stateDir = a.slice('--state-dir='.length);
    } else if (a.indexOf('--settings=') === 0) {
      // 指定 claude settings JSON 文件路径（透传 claude CLI 原生 --settings flag）。
      // 用途：动态切换 provider/套餐档位（智谱 glm-5.2-1m-max / mimo / deepseek 等），
      // 把用户已放在 ~/.claude/ 下的多套配置文件喂给 claude，而非仅靠其默认发现机制。
      out.settingsPath = a.slice('--settings='.length);
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--force') {
      out.force = true;
    } else if (a.indexOf('-') !== 0) {
      // 第一个非 flag 参数是 plan 路径
      if (!out.planPath) out.planPath = a;
    }
  }
  // ④a CLI 边界（WP-192-5）：--max-iters 必须 >0。
  //   NaN（非数字串）/ <=0 / 0 均拒绝：0 会让 driver safetyMax=5 + maxIters=0，
  //   engine 第一轮就 timeout，语义混乱；负值更无意义。仅当用户显式传了该 flag
  //   时校验（out.maxIters===null 表示未传，走默认）。
  if (out.maxIters !== null) {
    if (isNaN(out.maxIters) || out.maxIters <= 0) {
      out.error = 'Invalid --max-iters: 必须是 >0 的整数（收到 ' + out.maxIters + '）。';
      out.maxIters = null;
    }
  }
  // S4：校验 loopId 字符集，防止 path.join 拼出逃逸路径
  if (out.loopId) {
    var v = safePath.validateSafeName(out.loopId);
    if (!v.ok) {
      out.error = 'Invalid --loop-id (' + v.reason + '): ' + out.loopId +
        '. 仅允许字母/数字/_/-，1-64 字符。';
      out.loopId = null;
    }
  }
  // --settings 的文件存在性校验留到 execute()：路径可能相对 projectRoot，
  //   此处 projectRoot 未知，无法可靠解析。parseArgs 只负责纯解析。
  // --force：允许恢复已终态的 loop（覆盖终态保护，WP-192-5 ①）
  return out;
}

/**
 * 解析 loop 工作区：当指定 --loop-id 时，建立 per-loop 物理隔离目录并准备 chdir（WP-189）。
 *
 * 为什么用 chdir 而非注入 store（docs/plan/agentic-loop-node-driver-m4m5.md 硬约束 #1：
 * engine 零改动）：
 *   engine 内部 `new StateStore({filePath: path.join(projectRoot, '.claude-state')})`，
 *   projectRoot 由 `_resolveProjectRoot()` 基于 process.cwd() 探测（找 task.md/.claude）。
 *   driver 无法从外部注入 store 给 engine。因此隔离靠"改变 engine 看到的 projectRoot"实现——
 *   在隔离目录放 task.md 占位 + process.chdir 进去，engine/snapshot/driverStore/PROGRESS.md
 *   自然全部落到隔离目录。这彻底规避 state-store 多进程并发写（state-store.js:19-23 明确不支持）。
 *
 * 隔离目录结构：
 *   {stateDir}/{loopId}/
 *     task.md          ← 占位（让 engine _resolveProjectRoot 探测命中）
 *     .claude-state    ← engine + driver 共用的 state 文件（单进程独占，无并发写）
 *     PROGRESS.md      ← 本 loop 的 WP 完成标记（snapshot 从此读 completed）
 *
 * @param {string} projectRoot 真实项目根（chdir 前解析）
 * @param {string|null} stateDir state 目录（默认 .tackle-state/）
 * @param {string|null} loopId loop 标识；指定时启用隔离
 * @returns {{ stateFile:string, workspaceRoot:string, isolated:boolean }}
 *   - stateFile: driver 的 StateStore filePath（始终与 engine _store 同文件）
 *   - workspaceRoot: driver/PROGRESS.md 使用的根（隔离时=隔离目录，否则=projectRoot）
 *   - isolated: 是否启用 per-loop 隔离
 */
function resolveLoopWorkspace(projectRoot, stateDir, loopId) {
  // 无 loop-id：保持 M1~M3 形态（回退安全，硬约束 #5）。state 文件仍在 projectRoot 下。
  if (!loopId) {
    return {
      stateFile: path.join(projectRoot, '.claude-state'),
      workspaceRoot: projectRoot,
      isolated: false,
    };
  }
  // 有 loop-id：per-loop 物理隔离目录
  var baseDir = stateDir
    ? (path.isAbsolute(stateDir) ? stateDir : path.resolve(projectRoot, stateDir))
    : path.join(projectRoot, '.tackle-state');
  var workspaceRoot = path.join(baseDir, loopId);
  if (!fs.existsSync(workspaceRoot)) fs.mkdirSync(workspaceRoot, { recursive: true });
  // task.md 占位：让 engine _resolveProjectRoot() 探测命中隔离目录
  var placeholder = path.join(workspaceRoot, 'task.md');
  if (!fs.existsSync(placeholder)) {
    fs.writeFileSync(placeholder, '# loop workspace: ' + loopId + '\n', 'utf8');
  }
  return {
    stateFile: path.join(workspaceRoot, '.claude-state'),
    workspaceRoot: workspaceRoot,
    isolated: true,
  };
}

// ---------------------------------------------------------------------------
// PROGRESS.md 同步（硬约束 #5：snapshot 从这里读 completed）
// ---------------------------------------------------------------------------

/**
 * 把 `- [x] WP-NNN` 行追加到 PROGRESS.md（幂等：已存在则不重复写）。
 *
 * ②原子写（WP-192-5）：原 read→正则→append 三步非原子，进程在 read 后被中断会读到
 *   旧内容、append 时丢掉并发写入；改为「读+改 → 写 `.tmp.<pid>.<ts>` → rename」，
 *   复用 state-store.js:117-143 的原子写模式。rename 在 POSIX/Windows 上原子
 *   （Windows rename 失败时回退 direct write+unlink，与 StateStore A1 一致）。
 *   保留幂等正则检查（已存在完成行则 no-op）。
 * @param {string} projectRoot
 * @param {string} wpId
 */
function appendProgressLine(projectRoot, wpId) {
  var progressPath = path.join(projectRoot, 'PROGRESS.md');
  var line = '- [x] ' + wpId;
  // 幂等正则：精确匹配完成行（容忍大小写/勾选符号差异）
  var re = new RegExp('^\\s*[-*]\\s*\\[[xX✓✔]\\]\\s*' +
    wpId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'm');

  // 计算目标全文（先做幂等判定）
  var nextContent;
  if (fs.existsSync(progressPath)) {
    var existing = fs.readFileSync(progressPath, 'utf8');
    if (re.test(existing)) return; // 幂等：已存在完成行，no-op
    nextContent = existing + (existing.endsWith('\n') ? '' : '\n') + line + '\n';
  } else {
    nextContent = '# Progress\n\n' + line + '\n';
  }

  // 原子写：写 .tmp.<pid>.<ts> → rename（对齐 StateStore A1）
  var tmpPath = progressPath + '.tmp.' + process.pid + '.' + Date.now();
  try {
    fs.writeFileSync(tmpPath, nextContent, 'utf8');
    try {
      fs.renameSync(tmpPath, progressPath);
    } catch (renameErr) {
      // Windows EPERM/EACCES/EBUSY（AV 扫描/并发读持锁）回退 direct write + unlink temp，
      // 与 state-store.js _isWindowsRenameRetryable 一致（非原子但保数据）。
      if (renameErr && (renameErr.code === 'EPERM' || renameErr.code === 'EACCES' ||
          renameErr.code === 'EBUSY')) {
        fs.writeFileSync(progressPath, nextContent, 'utf8');
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_e) {}
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    // 清理残留 tmp（任何失败路径都不留垃圾）
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_e) {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// WP-190: coordinator 协作（provider sidecar + 熔断指令通道）
//
// 设计（docs/plan/agentic-loop-node-driver-m4m5.md WP-190，已确认事实）：
//   - loop state 不含 executor/provider 字段（engine createLoopState 无此字段，
//     硬约束 #1 禁止改 engine）。coordinator 额度池按 provider 分桶需要 provider 归属 →
//     driver init 后写一个 .executor sidecar，coordinator 扫目录时据此分桶。
//   - 熔断跨进程：coordinator 是独立守护进程，没有各 driver 进程的 engine 实例，
//     不能直接调 applyDirective；直接改写 .claude-state 又有 state-store 多进程并发写
//     丢数据风险（state-store.js:19-23）。→ 用独立 directive.json sidecar（单向：coordinator
//     写、driver 读），driver 命中后调本进程 api.applyDirective，engine 零改动复用其逻辑。
//   - 回退安全（硬约束 #5）：不开 coordinator 时无 directive.json，driver 静默跳过。
// ---------------------------------------------------------------------------

/**
 * 写 provider sidecar（.executor），供 coordinator 额度池按 provider 分桶。
 *
 * 心跳说明（WP-191-1-impl-a 修正）：coordinator 用 `.executor` 的 mtime 判活
 * （loop-server-core.js aggregateGlobalView：now - mtimeMs < staleMs）。
 * 本函数仅在 init 时写一次内容（provider/pid/startedAt）——它本身**不**承担
 * 心跳维护。心跳靠下面的 touchExecutorSidecar 每轮循环刷新 mtime 维护。
 *
 * @param {string} wsRoot loop 工作区根
 * @param {string} executorName executor.name（local/claude/glm）
 * @param {string} [model] 可选模型名（B20：coordinator 据此选准确的额度系数，
 *   如 glm-5.2；未提供时 coordinator 用默认）
 */
function writeExecutorSidecar(wsRoot, executorName, model) {
  try {
    var data = {
      provider: executorName,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };
    if (model) data.model = model;
    fs.writeFileSync(path.join(wsRoot, '.executor'), JSON.stringify(data), 'utf8');
  } catch (e) {
    // WP-191-4-impl 项 7：写失败不阻断 driver（回退安全：coordinator 缺此文件降级为
    //   provider=unknown），但**不再静默吞错**——记录一行 warning 便于诊断 sidecar
    //   缺失导致的 provider=unknown（回退安全 ≠ 静默失败，不变量 #4 核心）。
    //   通过可注入的 warn 函数输出（默认 console.warn），便于测试捕获。
    var warn = (typeof writeExecutorSidecar._warn === 'function')
      ? writeExecutorSidecar._warn
      : function (msg) { try { console.warn(msg); } catch (_ce) {} };
    try {
      warn('⚠ warning: failed to write .executor sidecar (' + wsRoot + '): ' +
        ((e && e.message) ? e.message : String(e)) +
        ' — coordinator will see provider=unknown');
    } catch (_we) {
      // 连 warn 都失败（如注入的 warn 抛错）：彻底静默，绝不阻断 driver
    }
  }
}

/**
 * 刷新 provider sidecar（.executor）的 mtime，作为进程存活心跳（WP-191-1-impl-a）。
 *
 * 为什么需要：claude/glm 单轮 executor.run 可能耗时 >5min（coordinator 默认
 * heartbeatStaleMs=5min）。若整个 loop 生命周期只在 init 写一次 .executor，
 * 长时间单轮期间 mtime 不更新，coordinator 会误判 loop disconnected，导致：
 *   (1) 健康 loop 被误判掉线；
 *   (2) disconnected loop 拿不到全局回退熔断指令。
 * 主循环每轮 step 前后调本函数刷新 mtime，coordinator 据此正确判活。
 *
 * 用 utimesSync 而非重写文件：避免每轮重写 JSON 内容的开销 + 规避与
 * coordinator 并发读的竞态（mtime 更新是原子操作）。
 *
 * 回退安全（硬约束 #5）：文件不存在或刷新失败时静默降级，绝不阻断 driver
 * 主流程——coordinator 缺心跳会降级判 disconnected，但 driver 自身循环不受影响。
 *
 * @param {string} wsRoot loop 工作区根
 */
function touchExecutorSidecar(wsRoot) {
  try {
    var sidecarPath = path.join(wsRoot, '.executor');
    // 文件不存在则不创建（心跳仅在已 init 的 sidecar 上维护；
    // 未 init 意味着 coordinator 也不存在，无需心跳）
    if (!fs.existsSync(sidecarPath)) return;
    var now = new Date();
    fs.utimesSync(sidecarPath, now, now);
  } catch (_e) {
    // 刷新失败不阻断 driver（回退安全）
  }
}

/**
 * 读 coordinator 下发的熔断指令（directive.json）。
 * 不存在 / 解析失败返回 null（回退安全）。
 * @param {string} wsRoot loop 工作区根
 * @returns {object|null} { action, reason, issuedAt } 或 null
 */
function readAbortDirective(wsRoot) {
  var p = path.join(wsRoot, 'directive.json');
  if (!fs.existsSync(p)) return null;
  try {
    var raw = fs.readFileSync(p, 'utf8');
    var d = JSON.parse(raw);
    if (d && typeof d === 'object' && d.action) return d;
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * 清除本 loop 已消费的熔断指令（删 directive.json）— WP-191-1-impl-b。
 *
 * 为什么需要（P0 修复）：driver 命中 abort 指令 → applyDirective → circuit_broken
 * 退出后，若不删除 directive.json，它将残留。当用户用同一 `--loop-id` 恢复该 loop 时
 * （loop.js:379 `--loop-id` 恢复语义），下一轮启动立刻读到残留指令又被熔断，loop 永远
 * 无法恢复。状态机不闭环。本函数在 driver 成功消费指令（applyDirective 成功）后调用，
 * 闭环为「coordinator 写 → driver 读+消费+清理」。
 *
 * 幂等 + 降级安全（不变量 #4）：文件不存在静默（首次清理或已被清理）；删除失败
 * （权限/占用）不抛错、不阻断 driver 主流程——最坏后果是下一轮 step 再次读到同一指令
 * 并再次 applyDirective（已终态则 engine 自然忽略，不会造成二次伤害）。
 *
 * @param {string} wsRoot loop 工作区根
 */
function clearAbortDirective(wsRoot) {
  var p = path.join(wsRoot, 'directive.json');
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_e) {
    // 删除失败不阻断 driver（回退安全/降级）：最坏后果是重复消费，engine 已终态会忽略
  }
}

// ---------------------------------------------------------------------------
// verdict 出口报告（硬约束 + WP-184 verdict 出口）
// ---------------------------------------------------------------------------

/**
 * 打印 loop 结果并返回退出码。
 * @param {object} ctx CLI context（含 colorize）
 * @param {object} log log 函数
 * @param {object} result step() 最后一轮返回（含 verdict/iteration/state/report）
 * @returns {number} exit code
 */
function reportAndExit(ctx, log, result) {
  var verdict = result.verdict;
  var iter = result.iteration;
  var state = result.state || {};
  var prox = state.lastEval && typeof state.lastEval.proximity === 'number'
    ? state.lastEval.proximity : null;

  if (verdict === 'achieved') {
    log(ctx.colorize('✓ Agentic Loop achieved', 'green'));
    log('  loopId:    ' + state.loopId);
    log('  iterations: ' + iter);
    if (prox !== null) log('  proximity: ' + prox.toFixed(3));
    var wp = state.lastSnapshot && state.lastSnapshot.workPackages;
    if (wp) log('  completed: ' + (wp.completed || []).length + '/' + wp.total + ' WP');
    return 0;
  }

  // 三类终态：timeout / diverged / circuit_broken（含 aborted）
  log(ctx.colorize('✗ Agentic Loop terminated: ' + verdict, 'red'));
  log('  loopId:    ' + state.loopId);
  log('  iterations: ' + iter);
  if (prox !== null) log('  proximity: ' + prox.toFixed(3));
  if (state.lastVerdict && state.lastVerdict.reason) {
    log('  reason:    ' + state.lastVerdict.reason);
  }
  // terminalReport（engine 三类终态自主生成，WP-177-2-impl-c）
  var report = result.report || state.terminalReport;
  if (report && report.markdown) {
    log('');
    log(report.markdown);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// ①终态保护 / ③并发写警告（WP-192-5）
// ---------------------------------------------------------------------------

/**
 * engine state.status 的终态集合（createLoopState index.js:138 注释枚举的终态子集）。
 * running/pause/init 等非终态不在此列。driver init 前据此判断 --loop-id 恢复是否安全。
 */
var TERMINAL_STATUSES = {
  achieved: true,
  timeout: true,
  diverged: true,
  circuit_broken: true,
  aborted: true,
};

/**
 * ③并发写警告（WP-192-5）：driverStore 与 engine._store 共享同一 .claude-state 文件，
 * StateStore 不支持多进程并发写（state-store.js:19-23）。单 driver 进程内串行安全，
 * 但**同一 --loop-id 被两个 driver 进程并行启动**会撞同一文件 → last-write-wins 丢数据。
 * 本函数运行时打一行 warn（可注入 _warn 便于测试捕获），不阻断（回退安全）。
 *
 * 仅在隔离模式（指定 --loop-id）下提示——无 --loop-id 时 state 在 projectRoot 共享，
 * 并发风险已由 WP-189 per-loop 隔离规避，此 warn 不适用。
 *
 * @param {{isolated:boolean, stateFile:string}} workspace resolveLoopWorkspace 产出
 * @param {string|null} loopId
 */
function emitConcurrencyWarn(workspace, loopId) {
  if (!workspace || !workspace.isolated || !loopId) return;
  var warn = (typeof emitConcurrencyWarn._warn === 'function')
    ? emitConcurrencyWarn._warn
    : function (msg) { try { console.warn(msg); } catch (_ce) {} };
  try {
    warn('⚠ warning: loop ' + loopId + ' 使用 state 文件 ' + workspace.stateFile +
      '。StateStore 不支持多进程并发写（last-write-wins 丢数据）。' +
      '请勿用同一 --loop-id 并行启动多个 driver。');
  } catch (_e) {
    // warn 失败不阻断 driver（回退安全）
  }
}

// ---------------------------------------------------------------------------
// 命令主体
// ---------------------------------------------------------------------------

module.exports = {
  name: 'loop',
  description: 'Run Agentic Loop as a Node process driver (decoupled from Claude session)',
  aliases: ['agentic-loop'],

  /**
   * Execute the loop command.
   * @public
   * @param {object} ctx CLI context（bin/context.js createContext 产出）
   */
  execute: async function (ctx) {
    // log 可注入（测试用）；默认 console.log。
    var log = (ctx && typeof ctx.log === 'function') ? ctx.log : function (msg) { console.log(msg); };
    var argv = (ctx.argv || []).slice();
    var args = parseArgs(argv);

    // S4：loopId 非法（含路径穿越尝试）→ 直接拒绝，不进入工作区解析
    if (args.error) {
      log(ctx.colorize('Error: ' + args.error, 'red'));
      ctx.exit(2);
      return;
    }

    var projectRoot = ctx.targetRoot || process.cwd();

    // 1) 解析 plan → goal
    //    plan 路径在 chdir（隔离）前解析为绝对路径，避免隔离后相对路径失效。
    var planPath = args.planPath
      ? (path.isAbsolute(args.planPath) ? args.planPath : path.resolve(projectRoot, args.planPath))
      : path.join(projectRoot, DEFAULT_PLAN_REL);

    if (!fs.existsSync(planPath)) {
      log(ctx.colorize('Error: plan file not found: ' + planPath, 'red'));
      log('Usage: tackle loop <plan.md> [--executor=local|default] [--max-iters=N] [--loop-id=X] [--settings=<path>]');
      ctx.exit(2);
      return;
    }

    var parsed = planReader.parsePlanToGoal(planPath, { projectRoot: projectRoot });
    if (parsed.error || !parsed.goal || !parsed.goal.wpIds || parsed.goal.wpIds.length === 0) {
      log(ctx.colorize('Error: plan parse failed: ' + (parsed.error || 'no executable WPs'), 'red'));
      ctx.exit(2);
      return;
    }

    // 1.25) --settings 解析与存在性校验（透传 claude CLI 原生 --settings flag）。
    //   在 chdir（隔离）前解析为绝对路径，与 planPath 处理一致——避免隔离后相对路径失效。
    //   支持绝对/相对路径、含方括号/点等真实文件名（如 settings-glm-5.2[1m]max.json）；
    //   不用 safePath.validateSafeName（它禁止方括号/点，会误拒真实文件名）。
    //   回退安全：不指定 --settings 时 settingsResolved=null，executor 走原默认行为。
    var settingsResolved = null;
    if (args.settingsPath) {
      settingsResolved = path.isAbsolute(args.settingsPath)
        ? args.settingsPath
        : path.resolve(projectRoot, args.settingsPath);
      // P6（WP-188 评审）：路径逃逸检查——--settings 须在 projectRoot 内。
      //   深度防御：claude --settings 本只读文件、且下方 existsSync 已能挡多数情况，
      //   此处显式拦截是为给用户清晰错误信息，并拦掉 --settings=../../etc/x 这类明显异常路径。
      var _settingsRel = path.relative(projectRoot, settingsResolved);
      if (_settingsRel.startsWith('..') || path.isAbsolute(_settingsRel)) {
        log(ctx.colorize('Error: --settings path must be within project root: ' +
          args.settingsPath + ' (resolved: ' + settingsResolved + ')', 'red'));
        log('Usage: tackle loop <plan.md> [--executor=local|default] [--settings=<path>]');
        ctx.exit(2);
        return;
      }
      if (!fs.existsSync(settingsResolved)) {
        log(ctx.colorize('Error: settings file not found: ' + settingsResolved, 'red'));
        log('Usage: tackle loop <plan.md> [--executor=local|default] [--settings=<path>]');
        ctx.exit(2);
        return;
      }
    }

    // 1.5) per-loop 工作区隔离（WP-189）：
    //   指定 --loop-id 时建立隔离目录 + chdir 进去，使 engine（基于 cwd 探测 projectRoot）
    //   与 driver 的 state/PROGRESS.md 全部落到隔离目录，规避多进程并发写丢数据。
    //   engine 零改动（硬约束 #1）；不指定 --loop-id 时保持 M1~M3 形态（回退安全，硬约束 #5）。
    var workspace = resolveLoopWorkspace(projectRoot, args.stateDir, args.loopId);
    var wsRoot = workspace.workspaceRoot;
    // WP-191-4-impl 项 5（回退安全）：chdir 前保存原始 cwd，确保 execute 结束（含早返回/异常）
    // 后还原。防御 driver 在同进程被复用（嵌入式调用 execute 两次）时 cwd 污染——此前
    // 隔离 loop 退出后 cwd 停留在隔离目录，后续同进程逻辑读相对路径会错乱（t3 观察到的
    // 跨文件测试间歇失败根因之一）。
    var origCwd = process.cwd();
    if (workspace.isolated) {
      try {
        process.chdir(wsRoot);
      } catch (e) {
        log(ctx.colorize('Error: cannot chdir to loop workspace ' + wsRoot + ': ' + e.message, 'red'));
        ctx.exit(2);
        return;
      }
    }

    // 主体包裹在 try/finally：无论正常结束、早返回还是异常，finally 都还原 cwd。
    try {
    log(ctx.colorize('=== Agentic Loop Node Driver ===', 'cyan'));
    log('plan:      ' + planPath);
    log('executor:  ' + args.executor);
    if (settingsResolved) {
      log('settings:  ' + settingsResolved);
    }
    log('goal WPs:  ' + parsed.goal.wpIds.join(', '));
    if (workspace.isolated) {
      log('loop-id:   ' + args.loopId + ' (isolated workspace: ' + wsRoot + ')');
    }
    log('');

    // 2) 构造 executor（executor 路由层 loop-executor.createExecutor）
    //    WP-188 重构：default executor 按探测到的模型自动门控额度。local 是 mock 不需要解析。
    //    对 default/claude：读 harness-config.yaml 的 loop.providers 段 → provider-resolver
    //    探测生效模型 + 匹配 profile → 透传 {model, provider, quotaConfig} 给 executor。
    //    回退安全：ConfigManager/resolver 任何环节失败 → providers 传 null，resolver 用内置
    //    DEFAULT_PROVIDERS（开箱即用），不阻断 driver 启动。
    var resolvedProvider = null;
    if (args.executor !== 'local') {
      // P7（WP-188 评审）：ConfigManager 读取与 resolveProvider 拆两个 try-catch，
      //   各自记录来源（config 读失败 vs resolver 失败），便于诊断。降级行为不变。
      var providersFromConfig = null;
      try {
        var cm = new ConfigManager();
        var cfgAll = cm.getAll();
        providersFromConfig = cfgAll && cfgAll.loop ? cfgAll.loop.providers : null;
      } catch (_cfgErr) {
        log(ctx.colorize('⚠ harness-config 读取失败（loop.providers 不可得，' +
          'resolver 将用内置 DEFAULT_PROVIDERS）: ' +
          ((_cfgErr && _cfgErr.message) ? _cfgErr.message : String(_cfgErr)), 'yellow'));
        providersFromConfig = null;
      }
      try {
        resolvedProvider = providerResolver.resolveProvider({
          settingsPath: settingsResolved,
          env: process.env,
          providers: providersFromConfig || undefined,
        });
        log('provider:  ' + resolvedProvider.provider +
          (resolvedProvider.model ? ' (model=' + resolvedProvider.model + ')' : '') +
          (resolvedProvider.features.quotaAware ? ' [quota-aware]' : ''));
      } catch (_resErr) {
        // resolver 失败：降级纯透传（provider=unknown），不阻断 driver 启动
        log(ctx.colorize('⚠ provider-resolver 失败，降级纯透传（provider=unknown）: ' +
          ((_resErr && _resErr.message) ? _resErr.message : String(_resErr)) +
          ((_resErr && _resErr.stack) ? '\n' + _resErr.stack : ''), 'yellow'));
        resolvedProvider = null;
      }
    }

    var executor;
    try {
      // local executor 只需 projectRoot（mock）；default 额外接收 resolver 产物
      if (args.executor === 'local') {
        executor = loopExecutor.createExecutor('local', { projectRoot: projectRoot });
      } else {
        executor = loopExecutor.createExecutor(args.executor, {
          projectRoot: projectRoot,
          settingsPath: settingsResolved,
          model: resolvedProvider ? resolvedProvider.model : null,
          provider: resolvedProvider ? resolvedProvider.provider : 'unknown',
          quotaConfig: resolvedProvider ? resolvedProvider.quotaConfig : null,
        });
      }
    } catch (e) {
      log(ctx.colorize('Error: ' + (e && e.message ? e.message : String(e)), 'red'));
      if (e && e.available) {
        log('Available executors: ' + e.available.join(', '));
      } else {
        log('Available executors: ' + loopExecutor.listProviders().join(', '));
      }
      ctx.exit(2);
      return;
    }

    // 3) engine 激活 + delegate 注入（硬约束 #1：engine 零改动，直接调）
    //    stateFile 始终与 engine _store 同文件：隔离时在 wsRoot 下，否则在 projectRoot 下。
    //    （engine 通过 cwd 探测的 projectRoot == wsRoot，二者自然指向同一文件）
    //
    // ③并发写警告（WP-192-5）：driverStore 与 engine._store 共享同一 .claude-state 文件。
    //   StateStore 明确不支持多进程并发写（state-store.js:19-23，last-write-wins 丢数据）。
    //   本 driver 与 engine 同进程、串行读写（driver 每次 get 前 invalidate()），单进程安全；
    //   但**同一 --loop-id 被两个 driver 进程并行启动**会撞同一文件 → 丢数据。per-loop 物理隔离
    //   （WP-189）已让不同 loop-id 落不同目录，但仍有人误用同 loop-id 并发。此处运行时 warn
    //   提示该风险（不阻断，回退安全：last-write-wins 仍能跑，只是可能丢进度）。
    var engine = new LoopEngine();
    var driverStore = new StateStore({ filePath: workspace.stateFile });
    if (typeof emitConcurrencyWarn === 'function') emitConcurrencyWarn(workspace, args.loopId);
    var api = await engine.factory({});
    // 缺口 1 修复（WP-186 注解）：snapshot/evaluator 默认不注入，engine 会走不读
    //   lastChecklist 完成态的降级实现。必须显式注入。
    api.inject({ snapshot: snapshotMod, evaluator: evaluatorMod });

    // ①终态保护（WP-192-5）：--loop-id 恢复前读 loop 状态，已终态则拒绝（除非 --force）。
    //   engine init（provider-loop-engine index.js:437）仅在 status==='running' 时恢复，
    //   否则 createLoopState 覆盖现有 state —— 包括终态 loop。即用 --loop-id 恢复一个已
    //   achieved/timeout/diverged/circuit_broken/aborted 的 loop 会**重置其全部历史进度**，
    //   误操作不可逆。此处提前拦截：读 driverStore 的 loop.{loopId}.status，若为终态且未带
    //   --force，提示并 exit 2（不调 init，不动 state）。
    if (args.loopId) {
      driverStore.invalidate();
      var existingStatus = await driverStore.get('loop.' + args.loopId + '.status');
      if (existingStatus && TERMINAL_STATUSES[existingStatus] && !args.force) {
        log(ctx.colorize(
          'Error: loop ' + args.loopId + ' 已终态 (status=' + existingStatus + ')，' +
          '恢复将重置其历史进度。如确认要重跑，请加 --force。',
          'red'));
        log('已终态 verdict: achieved / timeout / diverged / circuit_broken / aborted');
        ctx.exit(2);
        return;
      }
    }

    // 4) init（支持 --loop-id 恢复）
    var initOpts = { goal: parsed.goal };
    if (args.loopId) initOpts.loopId = args.loopId;
    if (args.maxIters) initOpts.maxIterations = args.maxIters;
    var initResult = await api.init(initOpts);
    var loopId = initResult.loopId;
    log('loopId:    ' + loopId + (initResult.restored ? ' (restored)' : ''));
    log('');

    // 4.5) WP-190：写 provider sidecar（供 coordinator 额度池按 provider 分桶）。
    //   loop state 不含 provider 字段（engine 零改动），coordinator 唯一能拿到 provider
    //   归属的来源就是这个 sidecar。仅在隔离模式下写（单 driver 无 --loop-id 时
    //   coordinator 也不存在，无需写）。
    //
    //   model 传递（WP-191-1-impl-d，不变量 #3 provider 零分支）：
    //   coordinator applyQuotaPool 按 per-loop model 选额度系数（glm-5.x 2x/3x，其它 1x）。
    //   model 必须由 driver 从 executor 实例自描述取得（统一通道 executor.config.model），
    //   绝不在此处出现 `if (executor==='glm')` 之类的 provider 分支——那是 M4 解耦锚点的破坏。
    //   所有 executor（local/claude/glm）都暴露 config.model（local/claude 为占位默认值，
    //   coordinator 仅对 glm 走高峰系数换算，其它 provider 的 model 值不参与计量）。
    if (workspace.isolated) {
      var sidecarModel = (executor && executor.config && executor.config.model)
        ? executor.config.model : null;
      writeExecutorSidecar(wsRoot, args.executor, sidecarModel);
    }

    // 5) 稳态循环：while(!terminal) step() + 消费 pendingAction
    var result = null;
    var safetyMax = (args.maxIters || 50) + 5; // driver 级安全阀，防 engine 阈值失灵死循环
    var driven = 0;
    var loopError = null;

    try {
      while (driven < safetyMax) {
        driven++;
        // WP-191-1-impl-a：每轮 step 前刷新 .executor mtime（心跳）。
        //   step() 内 observe→think→act→reflect→decide 较快，但紧随其后的
        //   executor.run() 是单轮最长耗时点（claude/glm 单轮可 >5min）。step 前
        //   刷新确保 executor.run 期间 coordinator 看到的 mtime 是"刚刚活动"。
        if (workspace.isolated) touchExecutorSidecar(wsRoot);
        result = await api.step(loopId);

        // WP-190：检查 coordinator 下发的熔断指令（仅隔离模式）。
        //   coordinator 是独立守护进程，无本进程 engine 实例；它写 directive.json sidecar
        //   （单向通道，不碰 .claude-state 规避多进程并发写）。driver 命中后调本进程
        //   api.applyDirective（engine 零改动，复用其 status→lastVerdict→saveState 逻辑）。
        //   applyDirective 改 status=aborted + lastVerdict=circuit_broken；调用后立即重 step
        //   取回终态 verdict，下面 reportAndExit 走正规熔断出口。
        if (workspace.isolated) {
          var directive = readAbortDirective(wsRoot);
          if (directive && directive.action === 'abort_all') {
            try {
              await api.applyDirective(loopId, {
                action: 'abort_all',
                reason: directive.reason || 'coordinator 全局熔断下发',
              });
              log(ctx.colorize('⚠ coordinator 熔断指令已接收：' +
                (directive.reason || 'abort_all'), 'yellow'));
              // WP-191-1-impl-b：applyDirective 成功即视为指令已被本 loop 消费 → 立即
              //   删除 directive.json 闭环状态机。否则指令残留会导致 `--loop-id` 恢复
              //   时被二次熔断（loop 永远无法恢复）。清理在重 step 之前进行，确保终态
              //   出口前已清理。幂等 + 降级（见 clearAbortDirective）。
              clearAbortDirective(wsRoot);
              // 立即重 step 取回 engine 翻译后的 circuit_broken verdict，走终态出口
              result = await api.step(loopId);
            } catch (_e) {
              // applyDirective 失败不阻断（回退安全）：继续让 engine 正常跑或自熔断。
              //   失败时不清理 directive.json —— 保留供诊断，且 loop 若未终态下一轮可重试。
            }
          }
        }

        // 终态出口：engine verdict 非 continue 即停
        if (result.verdict !== 'continue') break;

        // 消费 pendingAction（actuator 在 act 阶段写入）
        //   关键：driverStore 缓存必须刷新，否则读到 engine 最新写入前的旧 pendingAction
        driverStore.invalidate();
        var pending = await driverStore.get('loop.' + loopId + '.pendingAction');

        if (pending && pending.wpId) {
          if (!args.dryRun) {
            log(ctx.colorize('▶ dispatch ' + pending.wpId, 'cyan') +
              ' (mode=' + pending.mode + ', iter=' + result.iteration + ')');
            // WP-191-1-impl-a：dispatch 前刷新心跳。executor.run 是单轮最长耗时点
            //   （claude/glm 单轮可超 staleMs），刷新确保 coordinator 在此期间不误判 disconnected。
            if (workspace.isolated) touchExecutorSidecar(wsRoot);
            var checkResult = await executor.run(pending);

            // 回填 lastChecklist（供 reflection-evaluator 评分 proximity）
            driverStore.invalidate();
            await driverStore.set('loop.' + loopId + '.lastChecklist', checkResult);

            // 同步写 PROGRESS.md（硬约束 #5：snapshot 从这里读 completed）
            //   隔离时 PROGRESS.md 落在 wsRoot（隔离目录），snapshot 的
            //   parseProgressMarkdown 也基于 cwd 探测到同一目录，自然一致。
            if (checkResult.passed) {
              appendProgressLine(wsRoot, pending.wpId);
              log('  ' + ctx.colorize('✓ ' + pending.wpId + ' passed', 'green'));
            } else {
              log('  ' + ctx.colorize('✗ ' + pending.wpId + ' failed', 'yellow') +
                ' (' + (checkResult.failedItems || []).length + ' items)');
            }
          }
        } else {
          // noop decision（无可执行项）：继续下一轮，由 engine decide 判 achieved/发散
        }
      }
    } catch (e) {
      // B9：主循环单次失败不应丢失进度。记录错误 + 用最后的 result 走 reportAndExit，
      //   顶层入口（#11）也会兜底；这里捕获确保 PROGRESS.md 已写的进度仍能被汇报。
      loopError = e;
      log(ctx.colorize('⚠ loop step error: ' + (e && e.message ? e.message : String(e)), 'red'));
      if (!result) {
        // 极端：第一轮 step() 即抛错，result 仍为 null —— 构造一个发散占位以便汇报
        result = { verdict: 'diverged', iteration: 0, reason: 'loop step error' };
      }
    }

    if (driven >= safetyMax && result.verdict === 'continue') {
      log(ctx.colorize('⚠ Driver safety limit reached (' + safetyMax + ')', 'yellow'));
    }

    log('');
    var code = reportAndExit(ctx, log, result);
    ctx.exit(code);
    } finally {
      // WP-191-4-impl 项 5：还原工作目录（回退安全）。隔离模式下 chdir 进了 wsRoot，
      // 必须还原回 origCwd，避免 cwd 污染同进程后续逻辑。
      try {
        if (process.cwd() !== origCwd) process.chdir(origCwd);
      } catch (_e) {
        // 还原失败不阻断（极端：origCwd 已被删除）；记录但不抛
        log(ctx.colorize('⚠ warning: failed to restore cwd to ' + origCwd, 'yellow'));
      }
    }
  },

  // 暴露内部工具便于单元测试
  _parseArgs: parseArgs,
  _resolveLoopWorkspace: resolveLoopWorkspace,
  _appendProgressLine: appendProgressLine,
  _writeExecutorSidecar: writeExecutorSidecar,
  _touchExecutorSidecar: touchExecutorSidecar,
  _readAbortDirective: readAbortDirective,
  _clearAbortDirective: clearAbortDirective,
  _emitConcurrencyWarn: emitConcurrencyWarn,
  _TERMINAL_STATUSES: TERMINAL_STATUSES,
  _loopExecutor: loopExecutor,
};
