/**
 * Loop Trace — Agentic Loop per-round 阶段级可观测性聚合落盘（WP-196-1-impl）
 *
 * @module loop-trace
 *
 * 职责（单一职责：per-round trace 聚合 + JSONL 落盘）：
 *   - 把 engine step() 返回的 phaseTimings + executor.run() 的 _executorTrace + 本轮 verdict
 *     聚合成一个 round record。
 *   - 以 JSON Lines（每行一个 JSON 对象）追加到 `.tackle/loop-{loopId}/trace.jsonl`，
 *     崩溃后可逐行回放（修复 WP-194 根因⑥：运行时数据目录不存在）。
 *   - 渲染一行式阶段摘要供 driver stdout 输出（回应「感觉不是五段式」）。
 *
 * 与 loop-report.js 的边界（落点选择 = 方式 A，单一职责）：
 *   loop-report.js 是纯函数式终态报告（无 IO、无副作用，注释明示），负责 loop 触顶时的
 *   「总结报告内容」。本模块负责「每轮增量 trace 落盘 + 一行摘要」，有 IO 副作用，二者解耦。
 *
 * 回退安全（承袭 WP-191 心跳 fs.utimesSync 失败降级纪律）：
 *   所有落盘/渲染均 try/catch 降级。appendTrace 写入失败只返回 false + 不抛，
 *   调用方（driver）据此决定是否记 warning，loop 主流程照常推进。
 *
 * 数据来源：
 *   - engine step() 返回值 .phaseTimings（observe/think/act/reflect/decide 各 {phase, startMs, endMs, elapsedMs, summary}）
 *   - executor.run() 返回的 CheckResult._executorTrace（{spawnMs, exitCode, timedOut, rateLimited, tokenUsage}）
 *   - step() 返回值 .verdict / .iteration
 *
 * 设计依据：docs/wp/WP-196.md、docs/wp/WP-196-1-impl.md
 */

'use strict';

var fs = require('fs');
var path = require('path');

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/**
 * 解析 trace.jsonl 落盘路径。
 * 根目录探测：优先 projectRoot（driver 传入），回退从 cwd 向上找 .tackle / package.json / task.md，
 * 最终兜底 cwd。
 * @param {string} loopId
 * @param {string} [projectRoot] 项目根覆盖
 * @returns {string} 绝对路径 .tackle/loop-{loopId}/trace.jsonl
 */
function resolveTracePath(loopId, projectRoot) {
  var root = projectRoot || _detectProjectRoot();
  return path.join(root, '.tackle', 'loop-' + loopId, 'trace.jsonl');
}

function _detectProjectRoot() {
  var dir = process.cwd();
  for (var i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.tackle'))) return dir;
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (fs.existsSync(path.join(dir, 'task.md'))) return dir;
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// round record 聚合
// ---------------------------------------------------------------------------

/**
 * 聚合一个 round record（纯函数，无 IO）。
 * 容错：任一输入缺失时对应字段降级（executor 缺失→null，phaseTimings 缺失→[]），不抛。
 *
 * @param {object} opts
 * @param {string} opts.loopId
 * @param {number} opts.iteration
 * @param {Array<{phase:string, startMs?:number, endMs?:number, elapsedMs?:number, summary?:object}>} [opts.phaseTimings]
 * @param {object} [opts.executorTrace] { spawnMs, exitCode, timedOut, rateLimited, tokenUsage }
 * @param {string} [opts.verdict]
 * @param {string} [opts.dispatchedWp] 本轮 dispatch 的 WP（driver 从 pendingAction 取）
 * @returns {object} round record
 */
function buildRoundRecord(opts) {
  opts = opts || {};
  return {
    loopId: opts.loopId || '',
    iteration: (typeof opts.iteration === 'number') ? opts.iteration : 0,
    phases: Array.isArray(opts.phaseTimings) ? opts.phaseTimings.slice() : [],
    executor: opts.executorTrace || null,
    dispatchedWp: opts.dispatchedWp || null,
    verdict: opts.verdict || null,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 一行式阶段摘要（driver stdout 用）
// ---------------------------------------------------------------------------

var PHASE_LABEL = {
  observe: 'Observe',
  think: 'Think',
  act: 'Act',
  reflect: 'Reflect',
  decide: 'Decide',
};

// 五段式固定顺序（即便 phaseTimings 缺某段也按序占位，让用户「看见五段式在跑」）
var PHASE_ORDER = ['observe', 'think', 'act', 'reflect', 'decide'];

/**
 * 渲染一行式阶段摘要：`[iter 3] Observe 12ms · Think 1ms · Act 48023ms · Reflect 3ms · Decide 1ms → dispatch WP-XXX`
 * 缺失阶段显示 `-`；verdict/dispatchedWp 缺失时省略后缀。
 * @param {object} roundRecord（buildRoundRecord 产出）
 * @returns {string}
 */
function renderOneLine(roundRecord) {
  roundRecord = roundRecord || {};
  var iter = (typeof roundRecord.iteration === 'number') ? roundRecord.iteration : '?';
  // 按 phase 名建索引取 elapsedMs
  var byName = {};
  var phases = Array.isArray(roundRecord.phases) ? roundRecord.phases : [];
  for (var i = 0; i < phases.length; i++) {
    var p = phases[i];
    if (p && p.phase) byName[p.phase] = p;
  }
  var parts = [];
  for (var j = 0; j < PHASE_ORDER.length; j++) {
    var name = PHASE_ORDER[j];
    var label = PHASE_LABEL[name] || name;
    var entry = byName[name];
    var ms = (entry && typeof entry.elapsedMs === 'number') ? entry.elapsedMs : null;
    parts.push(label + ' ' + (ms !== null ? ms + 'ms' : '-'));
  }
  var line = '[iter ' + iter + '] ' + parts.join(' · ');
  if (roundRecord.dispatchedWp) {
    line += ' → dispatch ' + roundRecord.dispatchedWp;
  } else if (roundRecord.verdict && roundRecord.verdict !== 'continue') {
    line += ' → ' + roundRecord.verdict;
  }
  return line;
}

// ---------------------------------------------------------------------------
// JSONL 落盘（IO，全 try/catch 降级）
// ---------------------------------------------------------------------------

/**
 * 追加一个 round record 到 trace.jsonl（JSON Lines，每行一个 JSON）。
 * 目录不存在则递归创建；写入失败 try/catch 降级返回 false，不抛异常。
 *
 * @param {string} tracePath trace.jsonl 绝对路径（resolveTracePath 产出）
 * @param {object} roundRecord buildRoundRecord 产出
 * @returns {boolean} true=写入成功，false=降级（写入失败）
 */
function appendTrace(tracePath, roundRecord) {
  try {
    var dir = path.dirname(tracePath);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (_me) { /* 目录创建失败降级 */ }
    var line = JSON.stringify(roundRecord) + '\n';
    fs.appendFileSync(tracePath, line, { encoding: 'utf8' });
    return true;
  } catch (e) {
    // 降级：观测落盘失败绝不阻断 loop 主流程（承袭 WP-191 心跳降级纪律）
    return false;
  }
}

/**
 * 读取并解析 trace.jsonl（供 verify/回放测试用）。
 * 损坏行跳过（不抛），返回有效 record 数组。
 * @param {string} tracePath
 * @returns {Array<object>}
 */
function readTrace(tracePath) {
  try {
    if (!fs.existsSync(tracePath)) return [];
    var content = fs.readFileSync(tracePath, { encoding: 'utf8' });
    var lines = content.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (_pe) { /* 跳过损坏行 */ }
    }
    return out;
  } catch (_e) {
    return [];
  }
}

module.exports = {
  resolveTracePath: resolveTracePath,
  buildRoundRecord: buildRoundRecord,
  renderOneLine: renderOneLine,
  appendTrace: appendTrace,
  readTrace: readTrace,
  // 暴露内部工具便于单元测试
  _detectProjectRoot: _detectProjectRoot,
  _PHASE_ORDER: PHASE_ORDER,
  _PHASE_LABEL: PHASE_LABEL,
};
