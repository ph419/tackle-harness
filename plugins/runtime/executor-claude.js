/**
 * Executor (claude) — Agentic Loop Act 层 provider 执行单元的 Claude Code 实现（WP-185 / WP-187）
 *
 * @module executor-claude
 *
 * 职责：实现 driver 期望的 `run(pendingAction) -> CheckResult` 契约的真实实现——
 *   spawn Claude Code CLI（`claude -p --output-format json --allowedTools ...`）逐轮写代码，
 *   从其 stdout JSON 提取 text，再从 text 里的 `json:machine-readable` fenced block
 *   解析出 CheckResult（skill-checklist 机器可读契约，design.md §5.4.2）。
 *
 * 设计约束（docs/plan/agentic-loop-node-driver.md 硬约束 #3）：
 *   - provider 解耦点是 `executor.run()`：driver 不直接 spawn claude，
 *     本模块与 executor-local.js 实现同一份接口契约，可互换（--executor=local|claude）。
 *   - 新增 executor-glm.js 接智谱 Coding Plan 时，driver 与 engine 零改动。
 *
 * 接口契约（与 executor-local.js 一致，createExecutor 返回 { name, run, config }）：
 *   run(pendingAction: {wpId, mode, strategy, failingDrivers?, ...}) -> Promise<CheckResult>
 *
 * CheckResult 契约（reflection-evaluator.proximityFromChecklist /
 *   failingDriversFromChecklist 消费，见 test-checklist-json-contract.js）：
 *   {
 *     wpId: string,
 *     passed: boolean,
 *     summary: { total:number, passed:number, failed:number },
 *     categories: [{ name, passed, items:[{id,text,passed,reason?}] }],
 *     failedItems: [{ category, id, reason }]
 *   }
 *
 * 限流与超时（WP-185-impl，对齐 Ralph 模式）：
 *   - 单实例默认 100/h，超限返回 passed:false + failedItems:[{reason:'rate_limited'}]
 *   - 单次默认 15min 超时（spawn timeout 选项 + 手动 kill），超时返回 passed:false
 *
 * 进展检测（WP-187 / WP-191-2-impl，对齐 Ralph 熔断判据）：
 *   - 判据改为**工作树脏度**（git status --porcelain）：driver 不 git commit，claude
 *     子进程只改工作树，故 HEAD 恒不变——原 `git rev-parse HEAD` 检测恒判无进展（缺陷）。
 *   - 执行前后读工作树脏度（porcelain 输出非空=有改动）；passed=false 且工作树干净 →
 *     noProgress=true（无进展）。该信号经 reflection-evaluator 累计 noProgressStreak，
 *     接入 engine _decide 发散判定（连续 N 轮无代码进展 → diverged）。
 *   - git 不可用（非 git 仓库 / 无 git）→ 降级 noProgress=false（不阻断，不误判）。
 *
 * 可测性（遵循 codebase DI-over-mocking 哲学，见 executor-local / loop-actuator）：
 *   - createExecutor({ spawnFn }) 注入 spawn 实现，测试传 fake spawn，不真调 claude。
 */

'use strict';

var fs = require('fs');
var path = require('path');
var { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

var DEFAULTS = {
  binary: 'claude', // Claude Code CLI 可执行名
  timeoutMs: 15 * 60 * 1000, // 单次执行超时 15min（对齐 executor-local）
  rateLimitPerHour: 100, // 单实例每小时调用上限
  wpDocsDir: 'docs/wp', // WP 文档目录（相对项目根；prompt 注入用）
  // model 占位（WP-191-1-impl-d，provider 零分支统一通道）：
  //   claude CLI 不显式 --model（走账号默认模型），这里仅暴露 config.model 字段供
  //   driver 写 sidecar 时统一取值（executor.config.model），不引入 provider 分支。
  //   coordinator 额度池仅对 glm 走高峰系数换算，claude 的 model 值不参与计量。
  model: 'claude-default',
  allowedTools: [
    // 白名单：允许 Claude 读写代码与跑测试，禁止改动 .claude/ 内部状态（防自篡改）
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
  ],
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
 * 解析项目根目录（仿 loop-snapshot / loop-actuator：向上找 task.md / .claude）。
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
 * 同步读 git HEAD（child_process.execFileSync）。失败返回空串。
 * 保留以兼容可能的外部引用与旧测试；进展检测已改用 readWorktreeDirty（见下）。
 * @param {string} projectRoot
 * @returns {string}
 */
function readGitHead(projectRoot) {
  try {
    var { execFileSync } = require('child_process');
    var out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(out).trim();
  } catch (_e) {
    return '';
  }
}

/**
 * 同步读工作树脏度（git status --porcelain）。
 * WP-191-2-impl 进展检测核心：driver 不 git commit，claude 子进程只改工作树，
 * 故以"工作树是否有改动"作为"本轮是否产生代码进展"的判据（替代恒判无进展的 HEAD 比对）。
 *
 * @param {string} projectRoot
 * @param {Function} [statusFn] 注入 git status 执行函数（测试用）；默认 execFileSync。
 *   签名 (args, opts) => string；返回 porcelain 输出。
 * @returns {boolean|null} true=工作树脏（有进展） / false=干净（无进展） / null=无法判定（非 git 仓库降级）
 */
function readWorktreeDirty(projectRoot, statusFn) {
  try {
    var out;
    if (typeof statusFn === 'function') {
      out = statusFn(['status', '--porcelain'], { cwd: projectRoot });
    } else {
      var { execFileSync } = require('child_process');
      out = execFileSync('git', ['status', '--porcelain'], {
        cwd: projectRoot, encoding: 'utf8', timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    // porcelain 输出非空（含空白行外的内容）= 工作树有改动
    return String(out).trim().length > 0;
  } catch (_e) {
    // 非 git 仓库 / 无 git / 超时 → 无法判定（降级，不误判无进展）
    return null;
  }
}

/**
 * 从 Claude stdout（--output-format json）提取 text 字段。
 * claude -p --output-format json 输出形如 { "type":"result", "result":"...", ... } 或
 * { "text":"..." }。兼容多种字段名：result / text / content。
 * @param {string} stdout
 * @returns {string} text 内容；无法解析时原样返回 stdout（降级）
 */
function extractTextFromClaudeStdout(stdout) {
  if (!stdout) return '';
  var trimmed = stdout.trim();
  // 尝试整体 JSON 解析
  try {
    var parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      // 优先 result（claude -p 的标准字段），回退 text / content
      if (typeof parsed.result === 'string') return parsed.result;
      if (typeof parsed.text === 'string') return parsed.text;
      if (typeof parsed.content === 'string') return parsed.content;
      // result 有时是对象（含 text）
      if (parsed.result && typeof parsed.result === 'object') {
        if (typeof parsed.result.text === 'string') return parsed.result.text;
      }
    }
  } catch (_e) {
    // 非 JSON：可能是纯文本输出（claude 未加 --output-format 时）
  }
  return trimmed;
}

/**
 * 从 Report 文本提取 json:machine-readable fenced block 并 JSON.parse（skill-checklist 契约）。
 * 标记是 `json:machine-readable`（冒号，非连字符）—— 见 test-checklist-json-contract.js:68。
 * 解析失败返回 null（调用方降级为「无法解析」CheckResult）。
 * @param {string} text claude 输出文本
 * @returns {object|null} CheckResult
 */
function parseCheckResult(text) {
  if (!text) return null;
  // 宽松：允许 ```json:machine-readable 与 ``` 之间任意内容（含换行）
  var m = text.match(/```json:machine-readable\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    var obj = JSON.parse(m[1]);
    if (obj && typeof obj === 'object') return obj;
  } catch (_e) {
    return null;
  }
  return null;
}

/**
 * 归一化为合法 CheckResult（补齐缺失字段，确保 reflection-evaluator 能消费）。
 * @param {object|null} chk 解析出的原始对象
 * @param {string} fallbackWpId 解析失败时的兜底 wpId
 * @returns {object} CheckResult（结构保证完整）
 */
function normalizeCheckResult(chk, fallbackWpId) {
  if (!chk || typeof chk !== 'object') {
    return {
      wpId: fallbackWpId || 'unknown',
      passed: false,
      summary: { total: 0, passed: 0, failed: 0 },
      categories: [],
      failedItems: [{ id: 'parse-1', category: 'parse', text: 'checklist output', reason: 'no json:machine-readable block' }],
    };
  }
  var summary = chk.summary || {};
  var total = typeof summary.total === 'number' ? summary.total : 0;
  var passed = typeof summary.passed === 'number' ? summary.passed : 0;
  var failed = typeof summary.failed === 'number' ? summary.failed : (total - passed);
  return {
    wpId: chk.wpId || fallbackWpId || 'unknown',
    passed: chk.passed === true,
    summary: { total: total, passed: passed, failed: failed },
    categories: Array.isArray(chk.categories) ? chk.categories : [],
    failedItems: Array.isArray(chk.failedItems) ? chk.failedItems : [],
  };
}

/**
 * 生成「无法解析 / 超时 / 限流」的失败 CheckResult。
 * @param {string} wpId
 * @param {string} reason
 * @returns {object}
 */
function buildFailedChecklist(wpId, reason) {
  return {
    wpId: wpId || 'unknown',
    passed: false,
    summary: { total: 1, passed: 0, failed: 1 },
    categories: [],
    failedItems: [{ id: 'exec-1', category: 'exec', text: 'executor failure', reason: reason }],
  };
}

/**
 * 进展检测：基于执行前后工作树脏度，标注 CheckResult 的 noProgress 信号（WP-191-2-impl）。
 *
 * 语义（对齐 Ralph 熔断判据，修复"恒判无进展"缺陷）：
 *   - passed=true → noProgress=false（达成即有进展，不进入发散累计）
 *   - passed=false + 工作树脏（执行后有改动） → noProgress=false（本轮产出了代码，可能只是测试还没过）
 *   - passed=false + 工作树干净 → noProgress=true（无代码进展，累计入发散）
 *   - 工作树无法判定（非 git 仓库降级） → noProgress=false（不误判、不阻断）
 *
 * 公开字段：chk.noProgress（boolean，供 reflection-evaluator 累计 streak）。
 * 兼容：保留 chk._noProgress（旧字段，仅 true 时写入），向后兼容旧消费者/测试。
 *
 * 本函数提取自原 run() 内联逻辑，供 executor-glm 复用（消除两份重复代码，零漂移）。
 *
 * @param {object} chk CheckResult（会被原地补充 noProgress / _noProgress / 可能追加 progress failedItem）
 * @param {boolean|null} dirtyBefore 执行前工作树脏度（readWorktreeDirty 返回值）
 * @param {boolean|null} dirtyAfter  执行后工作树脏度
 * @returns {object} 同 chk（链式）
 */
function applyProgressDetection(chk, dirtyBefore, dirtyAfter) {
  if (!chk) return chk;
  // passed=true：达成即有进展
  if (chk.passed === true) {
    chk.noProgress = false;
    return chk;
  }
  // 工作树脏度任一无法判定（非 git 仓库降级）→ 不误判无进展
  if (dirtyBefore === null || dirtyAfter === null) {
    chk.noProgress = false;
    return chk;
  }
  // 工作树由干净变脏，或保持脏 → 本轮产出了代码改动 → 有进展
  var producedChange = dirtyAfter || (!dirtyBefore && dirtyAfter);
  // 等价简化：dirtyAfter 为 true 即视为有进展（无论 before）
  if (dirtyAfter) {
    chk.noProgress = false;
    return chk;
  }
  // passed=false 且工作树干净（before/after 均不脏）→ 无代码进展
  chk.noProgress = true;
  chk._noProgress = true; // 向后兼容旧字段
  if (chk.failedItems && chk.failedItems.length) {
    chk.failedItems.push({
      id: 'progress-1', category: 'progress', text: 'no worktree change',
      reason: '工作树无改动且 passed=false（无代码进展，对齐 Ralph 熔断判据）',
    });
  }
  // 保留 producedChange 变量语义可读性（lint 友好）：未直接使用仅作判定文档化
  void producedChange;
  return chk;
}

/**
 * 读取 WP 文档（docs/wp/{wpId}.md），注入 prompt。
 * 不存在时返回提示文本（不阻断；调用方决定是否提示用户先 task-creator）。
 * @param {string} wpId
 * @param {string} projectRoot
 * @returns {{ content:string|null, path:string }}
 */
function readWpDoc(wpId, projectRoot) {
  // S4：校验 wpId 字符集，防止 path.join 拼出 docs/wp/ 之外的路径
  // （wpId 来自 plan.md 解析，做防御性消毒；非法时当作无文档处理）
  if (!wpId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(wpId)) {
    return { content: null, path: path.join(projectRoot, 'docs', 'wp', '<invalid-id>.md') };
  }
  var docPath = path.join(projectRoot, 'docs', 'wp', wpId + '.md');
  if (!fs.existsSync(docPath)) {
    return { content: null, path: docPath };
  }
  try {
    return { content: fs.readFileSync(docPath, 'utf8'), path: docPath };
  } catch (_e) {
    return { content: null, path: docPath };
  }
}

/**
 * 构造 claude prompt（WP-187-impl）。
 * 含：WP 文档内容（或缺失提示）、mode/strategy、failingDrivers（仅 retry）、
 * 明确要求产出 json:machine-readable block。
 * @param {object} pendingAction { wpId, mode, strategy, failingDrivers }
 * @param {string} projectRoot
 * @returns {string}
 */
function buildPrompt(pendingAction, projectRoot) {
  pendingAction = pendingAction || {};
  var wpId = pendingAction.wpId || 'unknown';
  var mode = pendingAction.mode || 'dispatch';
  var strategy = pendingAction.strategy || 'full_restart';

  var lines = [];
  lines.push('你是 tackle agentic loop 的执行单元（executor）。当前 loop 通过 Node driver 调度你完成一个工作包。');
  lines.push('');
  lines.push('## 当前任务');
  lines.push('- WP ID: ' + wpId);
  lines.push('- 模式: ' + mode + '（dispatch=新执行 / retry=针对失败项重做 / resplit=拆分后执行）');
  lines.push('- 策略: ' + strategy);
  lines.push('');

  // 注入 WP 文档
  var doc = readWpDoc(wpId, projectRoot);
  if (doc.content) {
    lines.push('## WP 文档（' + doc.path + '）');
    lines.push('请严格依据下方文档的目标、关键文件、验收标准执行：');
    lines.push('');
    lines.push('---');
    lines.push(doc.content);
    lines.push('---');
    lines.push('');
  } else {
    lines.push('## WP 文档');
    lines.push('⚠️ 未找到 ' + doc.path + '。请先用 task-creator 创建 WP 文档，或依据 loop 目标自行完成。');
    lines.push('');
  }

  // retry 模式注入失败项反馈
  if (mode === 'retry' && pendingAction.failingDrivers && pendingAction.failingDrivers.length) {
    lines.push('## 上轮失败项（refine 反馈，请针对性修复）');
    for (var i = 0; i < pendingAction.failingDrivers.length; i++) {
      var fd = pendingAction.failingDrivers[i];
      lines.push('- [' + (fd.category || '?') + '] ' + (fd.item || '') + '：' + (fd.reason || ''));
    }
    lines.push('');
  }

  lines.push('## 完成要求');
  lines.push('1. 按上述 WP 文档实现/修改代码');
  lines.push('2. 跑相关单测验证（npm test 或针对性测试）');
  lines.push('3. 完成后**必须**在最终回复中产出 skill-checklist 的机器可读判定块，');
  lines.push('   格式为 ```json:machine-readable 后跟 JSON，字段：');
  lines.push('   wpId / passed / summary{total,passed,failed} / categories[] / failedItems[]');
  lines.push('   （详见 skill-checklist skill）。未产出该块将被判定为执行失败。');
  return lines.join('\n');
}

/**
 * 构造 claude CLI 参数（WP-185-impl）。
 *
 * SECURITY (S1)：prompt **不**经 argv 传入——大 prompt 会触发
 * Windows 命令行 ARG_MAX（≈32767）截断 / spawn ENAMETOOLONG，
 * 且在 POSIX 上经 /proc/<pid>/cmdline 泄漏给同机其他用户。
 * prompt 改由 run() 写入子进程 stdin（claude -p 的标准 stdin 模式）。
 *
 * settingsPath（可选）：透传 claude CLI 原生 `--settings <file-or-json>` flag，
 * 加载额外的 settings JSON（与 claude 默认发现机制叠加）。用途：动态切换
 * provider/套餐档位（如指定 ~/.claude/settings-glm-5.2[1m]max.json）。
 * SECURITY：settingsPath 是文件**路径**，非 prompt/密钥本身——密钥在文件内由
 * claude 自行读取，路径进 argv 安全（与 --allowedTools 等路径性质一致）。
 *
 * @param {string[]} allowedTools
 * @param {string} [settingsPath] 可选 claude settings 文件路径；非空时追加 --settings
 * @returns {string[]}
 */
function buildClaudeArgs(allowedTools, settingsPath) {
  var args = [
    '-p', // --print：非交互，单次执行后退出
    '--output-format', 'json',
    '--allowedTools', allowedTools.join(','),
  ];
  if (settingsPath) {
    args.push('--settings', settingsPath);
  }
  return args;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 创建一个 claude executor 实例。
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn] 注入 spawn（测试用）；默认 child_process.spawn
 * @param {string} [opts.binary] claude 可执行名
 * @param {number} [opts.timeoutMs] 单次超时（ms）
 * @param {number} [opts.rateLimitPerHour] 调用上限/h
 * @param {string} [opts.model] 模型名占位（provider 零分支统一通道；claude 不显式 --model）
 * @param {string[]} [opts.allowedTools] 工具白名单
 * @param {string} [opts.projectRoot] 项目根覆盖（默认自动探测）
 * @param {string} [opts.settingsPath] claude settings 文件路径（透传 --settings；切换 provider/套餐）
 * @returns {{ name:string, run:Function, config:object }}
 */
function createExecutor(opts) {
  opts = opts || {};
  var config = {
    binary: opts.binary || DEFAULTS.binary,
    timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULTS.timeoutMs,
    rateLimitPerHour: typeof opts.rateLimitPerHour === 'number'
      ? opts.rateLimitPerHour : DEFAULTS.rateLimitPerHour,
    model: opts.model || DEFAULTS.model,
    allowedTools: (opts.allowedTools && opts.allowedTools.length)
      ? opts.allowedTools.slice() : DEFAULTS.allowedTools.slice(),
    projectRoot: opts.projectRoot || resolveProjectRoot(),
    settingsPath: opts.settingsPath || null,
  };
  var spawnFn = opts.spawnFn || spawn;
  // 进展检测 git status 执行函数（DI 注入，测试用；默认走 readWorktreeDirty 内 execFileSync）
  var gitStatusFn = typeof opts.gitStatusFn === 'function' ? opts.gitStatusFn : null;

  // 限流状态
  var callTimestamps = [];
  var HOUR_MS = 60 * 60 * 1000;

  /**
   * 执行 pendingAction：spawn claude → 收集 stdout → 解析 json:machine-readable block。
   * @param {object} pendingAction
   * @returns {Promise<object>} CheckResult
   */
  async function run(pendingAction) {
    pendingAction = pendingAction || {};
    var wpId = pendingAction.wpId || 'unknown';

    // 限流
    var now = Date.now();
    callTimestamps = callTimestamps.filter(function (ts) { return now - ts < HOUR_MS; });
    if (callTimestamps.length >= config.rateLimitPerHour) {
      return buildFailedChecklist(wpId, 'rate_limited');
    }
    callTimestamps.push(now);

    // 进展检测基线（WP-191-2-impl）：执行前工作树脏度（porcelain）
    var dirtyBefore = readWorktreeDirty(config.projectRoot, gitStatusFn);

    // 构造 prompt + args
    var prompt = buildPrompt(pendingAction, config.projectRoot);
    var args = buildClaudeArgs(config.allowedTools, config.settingsPath);

    // spawn + 超时控制
    var stdoutBuf = '';
    var stderrBuf = '';
    var timedOut = false;
    var child;
    try {
      child = spawnFn(config.binary, args, {
        cwd: config.projectRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // spawn 立即失败（如 binary 不存在，ENOENT）
      return buildFailedChecklist(wpId, 'spawn_failed: ' + ((e && e.code) || (e && e.message) || String(e)));
    }

    // prompt 走 stdin（S1）：claude -p 从 stdin 读取，规避 argv 长度/泄漏问题。
    // 子进程若早退或拒读 stdin，write 会触发 EPIPE——挂 error handler 吞掉，
    // 由 child 'close'/'error' 统一收尾，避免 unhandled 异常。
    if (child.stdin) {
      child.stdin.on('error', function (_e) {});
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (_writeErr) {
        // 同步写失败（如 stdin 已关闭）：忽略，等 close 事件裁决
      }
    }

    return new Promise(function (resolve) {
      // 超时计时器：到点 kill 子进程
      var timer = setTimeout(function () {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch (_e) {}
        // 宽限 2s 后 SIGKILL
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
        resolve(buildFailedChecklist(wpId, 'spawn_error: ' + (err && err.message ? err.message : String(err))));
      });

      child.on('close', function (code) {
        clearTimeout(timer);
        if (timedOut) {
          resolve(buildFailedChecklist(wpId, 'timeout'));
          return;
        }
        // 提取 text → 解析 checklist block
        var text = extractTextFromClaudeStdout(stdoutBuf);
        var raw = parseCheckResult(text);
        var chk = normalizeCheckResult(raw, wpId);

        // 进展检测（WP-191-2-impl）：执行后工作树脏度 → 标注 noProgress
        // 语义见 applyProgressDetection：工作树有改动=有进展；干净+passed=false=无进展
        var dirtyAfter = readWorktreeDirty(config.projectRoot, gitStatusFn);
        applyProgressDetection(chk, dirtyBefore, dirtyAfter);
        // 非 0 退出码但解析出结果：仍用解析结果（claude 可能正常输出后非 0 退出）
        // 非 0 退出码且无解析结果：视为失败
        if (code !== 0 && !raw) {
          resolve(buildFailedChecklist(wpId, 'claude_exit_' + code + ': ' + stderrBuf.slice(0, 200)));
          return;
        }
        resolve(chk);
      });
    });
  }

  return {
    name: 'claude',
    run: run,
    config: config,
  };
}

module.exports = {
  createExecutor: createExecutor,
  // 暴露内部工具便于单元测试
  _buildPrompt: buildPrompt,
  _buildClaudeArgs: buildClaudeArgs,
  _extractTextFromClaudeStdout: extractTextFromClaudeStdout,
  _parseCheckResult: parseCheckResult,
  _normalizeCheckResult: normalizeCheckResult,
  _buildFailedChecklist: buildFailedChecklist,
  _readGitHead: readGitHead,
  _readWorktreeDirty: readWorktreeDirty,
  _applyProgressDetection: applyProgressDetection,
  _readWpDoc: readWpDoc,
  _resolveProjectRoot: resolveProjectRoot,
  _DEFAULTS: DEFAULTS,
};
