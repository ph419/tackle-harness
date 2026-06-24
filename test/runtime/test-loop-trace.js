/**
 * loop-trace 单元测试（WP-196-2-test）
 *
 * 覆盖 WP-196-1-impl 的可观测性改动（诚实原则：不写假测试）：
 *   1. 五段式阶段耗时观测：构造一轮 step()，断言返回 phaseTimings 含 5 段
 *      （observe/think/act/reflect/decide）、各 elapsedMs≥0、phase 名正确、summary 非空
 *   2. executor.run 打点：fakeSpawn（非真实端点）断言 run() 结果 _executorTrace 含
 *      {spawnMs, exitCode, timedOut, rateLimited}
 *   3. `.tackle/` 落盘格式：真实 tmp 目录实跑落盘，读回 trace.jsonl 断言每行合法 JSON、
 *      含契约字段、多轮追加不覆盖（JSON Lines 逐行）
 *   4. 观测失败降级（关键不变量）：注入写入失败，断言 appendTrace 返回 false 不抛、
 *      loop 主流程正常推进
 *   5. engine 决策逻辑回归：见 test-loop-engine.js（计时采集零副作用）
 *
 * 不写假测试先例（承袭 WP-193-4-test / WP-195-2-test）：
 *   - 落盘测试用真实 tmp 目录真实写读，不做 DI-over-mocking 伪造 fs
 *   - executor 打点用 fakeSpawn，不依赖真实 claude binary / 第三方端点
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var EventEmitter = require('events');

var loopTrace = require('../../plugins/runtime/loop-trace');
var executorDefault = require('../../plugins/runtime/executor-default');
var LoopEngineProvider = require('../../plugins/core/provider-loop-engine');

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loop-trace-test-'));
}

function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }
}

/**
 * 构造一个指向临时目录的 engine 实例 + API（复用 test-loop-engine.js 夹具形态）。
 * 临时目录含 .claude 标记，使 _resolveProjectRoot 命中。
 */
async function makeEngine(opts) {
  opts = opts || {};
  var dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

  var provider = new LoopEngineProvider();

  var origCwd = process.cwd();
  process.chdir(dir);

  var context = {
    config: opts.contextConfig || null,
    getProvider: opts.getProvider || function () { return null; },
  };
  await provider.onActivate(context);
  var api = await provider.factory(context);

  return {
    dir: dir,
    provider: provider,
    api: api,
    origCwd: origCwd,
    restore: function () { process.chdir(origCwd); cleanupTmpDir(dir); },
  };
}

// ---------------------------------------------------------------------------
// fakeSpawn（复用 test-executor-claude.js 同款夹具形态，非真实端点）
// ---------------------------------------------------------------------------

/**
 * 构造 fake spawn：记录调用参数，返回模拟子进程（EventEmitter）。
 * @param {object} opts
 * @param {string} [opts.stdout] 子进程 stdout 内容
 * @param {number} [opts.exitCode] 退出码（默认 0）
 * @param {Error} [opts.spawnError] spawn 立即抛错
 * @param {boolean} [opts.emitError] 发 'error' 事件而非 close
 */
function makeFakeSpawn(opts) {
  opts = opts || {};
  var calls = [];
  var fakeSpawn = function (binary, args, spOpts) {
    calls.push({ binary: binary, args: args, opts: spOpts });
    if (opts.spawnError) throw opts.spawnError;
    var child = new EventEmitter();
    fakeSpawn.lastChild = child;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child._stdinBuf = '';
    child.stdin = {
      write: function (data) { child._stdinBuf += String(data); return true; },
      end: function () { child._stdinEnded = true; },
      on: function () { return this; },
      once: function () { return this; },
    };
    child.killed = false;
    child.kill = function (sig) { child.killed = true; child._killedWith = sig; };
    child._calls = calls;

    var emitClose = function () {
      if (opts.emitError) {
        child.emit('error', new Error('simulated spawn error'));
      } else {
        child.emit('close', opts.exitCode === undefined ? 0 : opts.exitCode);
      }
    };

    process.nextTick(function () {
      if (opts.stdout) child.stdout.emit('data', opts.stdout);
      if (opts.stderr) child.stderr.emit('data', opts.stderr);
      emitClose();
    });
    return child;
  };
  fakeSpawn.calls = calls;
  fakeSpawn.lastChild = null;
  return fakeSpawn;
}

/** 构造含 json:machine-readable block 的 claude stdout（--output-format json）。 */
function makeClaudeStdout(checkResult) {
  var text = '执行完成。\n```json:machine-readable\n' +
    JSON.stringify(checkResult, null, 2) + '\n```\n';
  return JSON.stringify({ type: 'result', result: text });
}

function makePending(wpId, mode) {
  return {
    wpId: wpId || 'WP-1',
    mode: mode || 'dispatch',
    strategy: 'full_restart',
    failingDrivers: [],
    createdAt: new Date().toISOString(),
    loopId: 'loop-test',
  };
}

// ===========================================================================
// 维度 1：五段式阶段耗时观测（engine step() phaseTimings）
// ===========================================================================

test.describe('WP-196-2-test 维度1: 五段式阶段耗时观测', function () {
  test('正常流转一轮：phaseTimings 含 5 段，各 elapsedMs≥0，phase 名正确，summary 非空', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      // 注入 snapshot/actuator/evaluator 让流转可控且完整跑完五段
      env.api.inject({
        snapshot: {
          aggregate: async function () {
            return {
              workPackages: { total: 1, pending: ['WP-1'], completed: [], failed: [], blocked: [] },
              lastChecklist: null,
              watchdog: { health: 'healthy', running: true, deployed: true },
            };
          },
        },
        actuator: {
          execute: async function () {
            return { dispatched: true, roundElapsedMs: 5 };
          },
        },
        evaluator: {
          score: async function () {
            return {
              proximity: 0.5, converged: false, diverged: false,
              divergenceStreak: 0, allPassed: false,
              categoryScores: [], failingDrivers: [],
            };
          },
        },
      });
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] } });
      var out = await env.api.step(res.loopId);

      // phaseTimings 是 WP-196-1-impl 新增的纯观测字段
      assert.ok(Array.isArray(out.phaseTimings), 'step 返回 phaseTimings 数组');
      assert.equal(out.phaseTimings.length, 5, '五段式全部采集（observe/think/act/reflect/decide）');

      var names = out.phaseTimings.map(function (p) { return p.phase; });
      assert.deepStrictEqual(names, ['observe', 'think', 'act', 'reflect', 'decide'],
        'phase 名与顺序符合五段式');

      // 各段 elapsedMs≥0 且为数字
      out.phaseTimings.forEach(function (p) {
        assert.equal(typeof p.elapsedMs, 'number', p.phase + ' elapsedMs 是数字');
        assert.ok(p.elapsedMs >= 0, p.phase + ' elapsedMs ≥ 0');
        assert.equal(typeof p.startMs, 'number', p.phase + ' startMs 是数字');
        assert.equal(typeof p.endMs, 'number', p.phase + ' endMs 是数字');
        assert.ok(p.endMs >= p.startMs, p.phase + ' endMs ≥ startMs');
      });

      // summary 由 _buildPhaseSummaries 填充（observe/think/act/reflect/decide 各自产出摘要）
      out.phaseTimings.forEach(function (p) {
        assert.ok(p.summary !== undefined && p.summary !== null,
          p.phase + ' summary 非空（_buildPhaseSummaries 已填充）');
        assert.equal(typeof p.summary, 'object', p.phase + ' summary 是对象');
      });

      // 关键不变量：计时采集零副作用——verdict/iteration 仍由决策逻辑产出
      assert.equal(out.iteration, 1, 'iteration 单调递增（不受计时影响）');
      assert.ok(out.verdict, 'verdict 仍由 _decide 产出');
    } finally {
      env.restore();
    }
  });

  test('单轮超时出口：phaseTimings 含 observe/think/act（reflect/decide 未执行故缺）', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      await env.api.init({ goal: { wpIds: ['WP-1'] }, maxRoundTimeMs: 1 });
      env.api.inject({
        actuator: {
          execute: async function () {
            await new Promise(function (r) { setTimeout(r, 5); }); // > 1ms 阈值
            return { dispatched: true, roundElapsedMs: 9999 };
          },
        },
        snapshot: {
          aggregate: async function () {
            return {
              workPackages: { total: 1, pending: ['WP-1'], completed: [], failed: [], blocked: [] },
              lastChecklist: null,
              watchdog: { health: 'healthy', running: true, deployed: true },
            };
          },
        },
      });
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] }, maxRoundTimeMs: 1 });
      var out = await env.api.step(res.loopId);

      assert.equal(out.verdict, 'timeout', '单轮超 max_round_time_ms 判 timeout');
      // 超时出口提前 return，reflect/decide 未执行——按实际产物契约测（仅 observe/think/act）
      assert.ok(Array.isArray(out.phaseTimings), '超时出口仍附已采集的 phaseTimings');
      assert.ok(out.phaseTimings.length >= 3, '至少跑完 observe/think/act 三段');
      var names = out.phaseTimings.map(function (p) { return p.phase; });
      assert.deepEqual(names.slice(0, 3), ['observe', 'think', 'act'],
        '超时出口已采集段为 observe/think/act（reflect/decide 缺，符合提前 return 契约）');
    } finally {
      env.restore();
    }
  });

  // WP-197-3-test 锁现状：_buildPhaseSummaries 各段 summary 字段裁剪契约（承 1-clarify O2）
  //   现有维度1用例只断言 summary 非空对象，未锁定各段具体字段。本用例锁定：
  //     - observe summary 仅含 {pendingWps, failedChecks}，裁剪掉 _summarizeSnapshot 的 watchdogHealthy
  //     - think/act/reflect/decide 各段字段齐全（防未来误改导致 trace 一行式摘要语义漂移）
  //   真实 step() 产物断言，非 DI-over-mocking、非桩。
  test('锁现状：各段 summary 字段裁剪契约（observe 不含 watchdogHealthy，think/act/reflect/decide 字段齐全）', async function () {
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      env.api.inject({
        snapshot: {
          aggregate: async function () {
            return {
              workPackages: { total: 2, pending: ['WP-1', 'WP-2'], completed: [], failed: [], blocked: [] },
              lastChecklist: null,
              watchdog: { health: 'healthy', running: true, deployed: true },
            };
          },
        },
        actuator: {
          execute: async function () {
            return { dispatched: true, roundElapsedMs: 7, wpId: 'WP-1' };
          },
        },
        evaluator: {
          score: async function () {
            return {
              proximity: 0.5, converged: false, diverged: false,
              divergenceStreak: 0, allPassed: false,
              categoryScores: [], failingDrivers: [], failedCount: 3,
            };
          },
        },
      });
      var res = await env.api.init({ goal: { wpIds: ['WP-1', 'WP-2'] } });
      var out = await env.api.step(res.loopId);

      var byPhase = {};
      out.phaseTimings.forEach(function (p) { byPhase[p.phase] = p.summary; });

      // observe：仅 {pendingWps, failedChecks}，裁剪 watchdogHealthy（O2 字段裁剪契约）
      assert.deepEqual(Object.keys(byPhase.observe).sort(), ['failedChecks', 'pendingWps'],
        'observe summary 字段裁剪：仅 pendingWps + failedChecks');
      assert.equal(byPhase.observe.pendingWps, 2, 'observe pendingWps 计数正确');
      assert.equal(byPhase.observe.failedChecks, 0, 'observe failedChecks 缺省为 0');
      assert.equal(byPhase.observe.watchdogHealthy, undefined,
        'observe summary 不含 watchdogHealthy（裁剪契约，防字段泄漏）');

      // think：{action, targetWp}（pending WP 在 goal 内 → action=dispatch）
      assert.deepEqual(Object.keys(byPhase.think).sort(), ['action', 'targetWp'],
        'think summary 字段：action + targetWp');
      assert.equal(byPhase.think.action, 'dispatch', 'think action 由 _think 决策产出');
      assert.ok(byPhase.think.targetWp, 'think targetWp 非空');

      // act：{roundElapsedMs, dispatchedWp}
      //   roundElapsedMs 由 act() 内部用真实 wall-clock 覆盖（index.js:544-545，
      //   Date.now()-actStartedAt），不透传 actuator 注入值——故只断言非负数字（真实计时），
      //   不断言特定值，避免「假设注入值会透传」的假断言。
      assert.deepEqual(Object.keys(byPhase.act).sort(), ['dispatchedWp', 'roundElapsedMs'],
        'act summary 字段：roundElapsedMs + dispatchedWp');
      assert.equal(typeof byPhase.act.roundElapsedMs, 'number',
        'act roundElapsedMs 是数字（act() 内部真实计时覆盖）');
      assert.ok(byPhase.act.roundElapsedMs >= 0, 'act roundElapsedMs ≥ 0');
      assert.equal(byPhase.act.dispatchedWp, 'WP-1', 'act dispatchedWp 复用 actResult.wpId');

      // reflect：{proximity, diverged, converged, failedCount}
      assert.deepEqual(Object.keys(byPhase.reflect).sort(),
        ['converged', 'diverged', 'failedCount', 'proximity'],
        'reflect summary 字段：proximity + diverged + converged + failedCount');
      assert.equal(byPhase.reflect.proximity, 0.5);
      assert.equal(byPhase.reflect.failedCount, 3);

      // decide：{verdict}
      assert.deepEqual(Object.keys(byPhase.decide), ['verdict'], 'decide summary 字段：verdict');
      assert.equal(byPhase.decide.verdict, 'continue');
    } finally {
      env.restore();
    }
  });
});

// ===========================================================================
// 维度 2：executor.run 打点（fakeSpawn，非真实端点）
// ===========================================================================

test.describe('WP-196-2-test 维度2: executor.run 打点', function () {
  test('正常退出：_executorTrace 含 spawnMs/exitCode/timedOut/rateLimited', async function () {
    var fakeSpawn = makeFakeSpawn({
      stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
      exitCode: 0,
    });
    var exec = executorDefault.createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
    var result = await exec.run(makePending('WP-1'));

    assert.ok(result._executorTrace, 'run() 结果附 _executorTrace');
    var t = result._executorTrace;
    assert.equal(typeof t.spawnMs, 'number', 'spawnMs 是数字');
    assert.ok(t.spawnMs >= 0, 'spawnMs ≥ 0');
    assert.equal(t.exitCode, 0, 'exitCode=0（正常退出）');
    assert.equal(t.timedOut, false, 'timedOut=false');
    assert.equal(t.rateLimited, false, 'rateLimited=false');
    // tokenUsage 字段存在（当前不可获取，留 null——诚实：字段在契约内）
    assert.ok('tokenUsage' in t, 'tokenUsage 字段在契约内');
  });

  test('非零退出码：exitCode 透传', async function () {
    var fakeSpawn = makeFakeSpawn({
      stdout: makeClaudeStdout({ wpId: 'WP-1', passed: false, summary: { total: 1, passed: 0, failed: 1 } }),
      exitCode: 1,
    });
    var exec = executorDefault.createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
    var result = await exec.run(makePending('WP-1'));
    assert.equal(result._executorTrace.exitCode, 1, 'exitCode=1 透传到 trace');
    assert.equal(result._executorTrace.timedOut, false);
  });

  test('spawn 立即失败（ENOENT）：trace 降级 exitCode=null，不抛', async function () {
    var fakeSpawn = makeFakeSpawn({ spawnError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
    var exec = executorDefault.createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
    var result = await exec.run(makePending('WP-1'));
    // spawn_failed 路径仍附 trace（spawnMs 已记，exitCode 缺故 null）
    assert.ok(result._executorTrace, 'spawn 失败路径仍附 trace（观测不阻断）');
    assert.equal(result._executorTrace.exitCode, null, 'spawn 立即失败 exitCode=null');
    assert.equal(typeof result._executorTrace.spawnMs, 'number', 'spawnMs 已记');
  });

  test('子进程 error 事件：trace exitCode=null，不抛', async function () {
    var fakeSpawn = makeFakeSpawn({ emitError: true });
    var exec = executorDefault.createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
    var result = await exec.run(makePending('WP-1'));
    assert.ok(result._executorTrace, 'error 路径仍附 trace');
    assert.equal(result._executorTrace.exitCode, null, 'error 事件 exitCode=null');
  });

  test('限流命中：trace rateLimited=true，不 spawn', async function () {
    // rateLimitPerHour=1，第二次调用命中限流
    var fakeSpawn = makeFakeSpawn({
      stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
    });
    var exec = executorDefault.createExecutor({
      spawnFn: fakeSpawn, projectRoot: process.cwd(), rateLimitPerHour: 1,
    });
    await exec.run(makePending('WP-1')); // 第一次消耗配额
    var result = await exec.run(makePending('WP-2')); // 第二次命中限流
    assert.equal(result._executorTrace.rateLimited, true, 'rateLimited=true');
    // 限流路径不应 spawn（calls 仍为 1）
    assert.equal(fakeSpawn.calls.length, 1, '限流时不 spawn');
  });
});

// ===========================================================================
// 维度 3：`.tackle/` 落盘格式（真实 tmp 目录实跑写读）
// ===========================================================================

test.describe('WP-196-2-test 维度3: .tackle/ 落盘格式', function () {
  test('resolveTracePath：在 projectRoot 下产出 .tackle/loop-{loopId}/trace.jsonl', function () {
    var dir = makeTmpDir();
    try {
      var p = loopTrace.resolveTracePath('loop-xyz', dir);
      assert.ok(p.indexOf(path.join(dir, '.tackle', 'loop-loop-xyz', 'trace.jsonl')) !== -1,
        '路径含 .tackle/loop-{loopId}/trace.jsonl');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('appendTrace：真实写盘，readTrace 读回，每行合法 JSON', function () {
    var dir = makeTmpDir();
    try {
      var tracePath = loopTrace.resolveTracePath('loop-a', dir);
      var rec = loopTrace.buildRoundRecord({
        loopId: 'loop-a',
        iteration: 1,
        phaseTimings: [{ phase: 'act', elapsedMs: 42 }],
        executorTrace: { spawnMs: 10, exitCode: 0, timedOut: false, rateLimited: false },
        verdict: 'continue',
        dispatchedWp: 'WP-1',
      });
      var ok = loopTrace.appendTrace(tracePath, rec);
      assert.equal(ok, true, '写入成功');

      // 真实读回（非 mock fs）
      var records = loopTrace.readTrace(tracePath);
      assert.equal(records.length, 1, '读回 1 行');
      assert.equal(records[0].loopId, 'loop-a');
      assert.equal(records[0].iteration, 1);
      assert.equal(records[0].dispatchedWp, 'WP-1');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('落盘契约字段：含 {loopId, iteration, phases, executor, verdict, timestamp}', function () {
    var dir = makeTmpDir();
    try {
      var tracePath = loopTrace.resolveTracePath('loop-contract', dir);
      var rec = loopTrace.buildRoundRecord({
        loopId: 'loop-contract',
        iteration: 3,
        phaseTimings: [{ phase: 'observe', elapsedMs: 1, summary: { pendingWps: 2 } }],
        executorTrace: { spawnMs: 5, exitCode: 0, timedOut: false, rateLimited: false, tokenUsage: null },
        verdict: 'timeout',
      });
      loopTrace.appendTrace(tracePath, rec);
      var raw = fs.readFileSync(tracePath, 'utf8').trim();
      var parsed = JSON.parse(raw); // 每行合法 JSON

      // 契约字段齐全
      assert.equal(parsed.loopId, 'loop-contract');
      assert.equal(parsed.iteration, 3);
      assert.ok(Array.isArray(parsed.phases), 'phases 是数组');
      assert.ok(parsed.executor && typeof parsed.executor === 'object', 'executor 是对象');
      assert.equal(parsed.verdict, 'timeout');
      assert.ok(typeof parsed.timestamp === 'string' && parsed.timestamp.length > 0, 'timestamp 非空字符串');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('多轮追加不覆盖：JSON Lines 逐行追加', function () {
    var dir = makeTmpDir();
    try {
      var tracePath = loopTrace.resolveTracePath('loop-multi', dir);
      // 追加 3 轮
      for (var i = 1; i <= 3; i++) {
        loopTrace.appendTrace(tracePath, loopTrace.buildRoundRecord({
          loopId: 'loop-multi',
          iteration: i,
          phaseTimings: [{ phase: 'act', elapsedMs: i * 10 }],
          verdict: 'continue',
        }));
      }
      var records = loopTrace.readTrace(tracePath);
      assert.equal(records.length, 3, '多轮追加不覆盖，读回 3 行');
      // 逐轮 iteration 递增（追加顺序保留）
      assert.equal(records[0].iteration, 1);
      assert.equal(records[1].iteration, 2);
      assert.equal(records[2].iteration, 3);

      // 原始文件是 JSON Lines（每行一个独立 JSON）
      var lines = fs.readFileSync(tracePath, 'utf8').split('\n').filter(function (l) { return l.trim(); });
      assert.equal(lines.length, 3, '文件含 3 行 JSON Lines');
      lines.forEach(function (line) {
        assert.doesNotThrow(function () { JSON.parse(line); }, '每行合法 JSON');
      });
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('目录不存在时 appendTrace 递归创建', function () {
    var dir = makeTmpDir();
    try {
      // 嵌套不存在的目录路径
      var tracePath = path.join(dir, '.tackle', 'loop-nested', 'trace.jsonl');
      var ok = loopTrace.appendTrace(tracePath, loopTrace.buildRoundRecord({ loopId: 'l', iteration: 1 }));
      assert.equal(ok, true, '递归创建目录后写入成功');
      var records = loopTrace.readTrace(tracePath);
      assert.equal(records.length, 1, '读回 1 行');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('round record 经 JSON.stringify 落盘后可完整回环（phases 含 summary 嵌套对象）', function () {
    var dir = makeTmpDir();
    try {
      var tracePath = loopTrace.resolveTracePath('loop-roundtrip', dir);
      var rec = loopTrace.buildRoundRecord({
        loopId: 'loop-roundtrip',
        iteration: 2,
        phaseTimings: [
          { phase: 'observe', startMs: 1, endMs: 5, elapsedMs: 4, summary: { pendingWps: 3, failedChecks: 0 } },
          { phase: 'think', startMs: 5, endMs: 6, elapsedMs: 1, summary: { action: 'dispatch', targetWp: 'WP-1' } },
          { phase: 'act', startMs: 6, endMs: 5000, elapsedMs: 4994, summary: { roundElapsedMs: 4994, dispatchedWp: 'WP-1' } },
          { phase: 'reflect', startMs: 5000, endMs: 5003, elapsedMs: 3, summary: { proximity: 0.6, diverged: false } },
          { phase: 'decide', startMs: 5003, endMs: 5004, elapsedMs: 1, summary: { verdict: 'continue' } },
        ],
        executorTrace: { spawnMs: 4994, exitCode: 0, timedOut: false, rateLimited: false, tokenUsage: null },
        verdict: 'continue',
        dispatchedWp: 'WP-1',
      });
      loopTrace.appendTrace(tracePath, rec);
      var back = loopTrace.readTrace(tracePath)[0];
      assert.equal(back.phases.length, 5, '五段 phases 完整回环');
      assert.equal(back.phases[2].summary.roundElapsedMs, 4994, '嵌套 summary 字段无损');
      assert.equal(back.executor.spawnMs, 4994, 'executor 字段无损');
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

// ===========================================================================
// 维度 4：观测失败降级不阻断主流程（关键不变量）
// ===========================================================================

test.describe('WP-196-2-test 维度4: 观测失败降级', function () {
  test('appendTrace 写入失败（路径不可写）→ 返回 false，不抛异常', function () {
    // 构造一个不可写的目标：把一个已存在的【文件】当作目录的父级，mkdir/append 都会失败。
    // 真实文件系统行为，非 mock。
    var dir = makeTmpDir();
    try {
      var blocker = path.join(dir, 'blocker-file');
      fs.writeFileSync(blocker, 'x'); // blocker 是文件，无法作为目录
      // tracePath 的父目录含 blocker-file → mkdirSync 失败 → appendFileSync 失败
      var tracePath = path.join(blocker, 'sub', 'trace.jsonl');
      var threw = false;
      var ok;
      try {
        ok = loopTrace.appendTrace(tracePath, loopTrace.buildRoundRecord({ loopId: 'l', iteration: 1 }));
      } catch (e) {
        threw = true;
      }
      assert.equal(threw, false, '观测失败绝不抛异常（降级）');
      assert.equal(ok, false, '降级返回 false');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('readTrace 文件不存在 → 返回空数组，不抛', function () {
    var dir = makeTmpDir();
    try {
      var records = loopTrace.readTrace(path.join(dir, 'nonexistent', 'trace.jsonl'));
      assert.deepStrictEqual(records, [], '文件不存在降级为空数组');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('readTrace 损坏行跳过，不抛', function () {
    var dir = makeTmpDir();
    try {
      var tracePath = path.join(dir, 'trace.jsonl');
      // 手写混合：1 行合法 + 1 行损坏 + 1 行合法
      fs.writeFileSync(tracePath,
        JSON.stringify({ loopId: 'a', iteration: 1 }) + '\n' +
        'this is not json\n' +
        JSON.stringify({ loopId: 'b', iteration: 2 }) + '\n', 'utf8');
      var records = loopTrace.readTrace(tracePath);
      assert.equal(records.length, 2, '损坏行跳过，读回 2 行');
      assert.equal(records[0].loopId, 'a');
      assert.equal(records[1].loopId, 'b');
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('关键不变量：观测落盘失败不阻断 loop 主流程', async function () {
    // 模拟 driver 场景：step() 正常推进产出 phaseTimings，driver 聚合后 appendTrace 失败，
    // 但 step()/决策主流程已不受影响（appendTrace 是 driver 侧 IO，与 engine 决策解耦）。
    var env = await makeEngine({ getProvider: function () { return null; } });
    try {
      env.api.inject({
        snapshot: {
          aggregate: async function () {
            return {
              workPackages: { total: 1, pending: ['WP-1'], completed: [], failed: [], blocked: [] },
              lastChecklist: null,
              watchdog: { health: 'healthy', running: true, deployed: true },
            };
          },
        },
        actuator: { execute: async function () { return { dispatched: true }; } },
        evaluator: {
          score: async function () {
            return { proximity: 0.5, converged: false, diverged: false, divergenceStreak: 0, allPassed: false };
          },
        },
      });
      var res = await env.api.init({ goal: { wpIds: ['WP-1'] } });
      var out = await env.api.step(res.loopId);

      // engine 主流程已正常推进
      assert.equal(out.iteration, 1, 'engine 主流程推进不受观测影响');

      // driver 侧：聚合 round record 后 appendTrace 到一个不可写路径
      var blocker = path.join(env.dir, 'blocker-file');
      fs.writeFileSync(blocker, 'x');
      var badPath = path.join(blocker, 'trace.jsonl');
      var rec = loopTrace.buildRoundRecord({
        loopId: res.loopId,
        iteration: out.iteration,
        phaseTimings: out.phaseTimings,
        verdict: out.verdict,
      });
      var ok = loopTrace.appendTrace(badPath, rec);
      assert.equal(ok, false, '落盘失败降级返回 false');

      // 不变量：落盘失败不影响 engine 已推进的状态（iteration/verdict 已固化）
      var st = await env.api.getState(res.loopId);
      assert.equal(st.iteration, 1, 'loop 状态正常固化（观测失败不阻断）');
    } finally {
      env.restore();
    }
  });
});

// ===========================================================================
// 维度 5：renderOneLine 一行式阶段摘要（driver 可见性输出，回应「感觉不是五段式」）
// ===========================================================================

test.describe('WP-196-2-test 维度5: 一行式阶段摘要', function () {
  test('五段式固定顺序占位（缺失阶段显示 -）', function () {
    var line = loopTrace.renderOneLine({
      iteration: 3,
      phases: [
        { phase: 'observe', elapsedMs: 12 },
        { phase: 'think', elapsedMs: 1 },
        { phase: 'act', elapsedMs: 48023 },
        { phase: 'reflect', elapsedMs: 3 },
        { phase: 'decide', elapsedMs: 1 },
      ],
      dispatchedWp: 'WP-196',
    });
    // 固定顺序 + 各段耗时可见
    assert.match(line, /\[iter 3\]/);
    assert.match(line, /Observe 12ms/);
    assert.match(line, /Think 1ms/);
    assert.match(line, /Act 48023ms/);
    assert.match(line, /Reflect 3ms/);
    assert.match(line, /Decide 1ms/);
    assert.match(line, /→ dispatch WP-196/);
  });

  test('缺失阶段显示 -（让用户看见五段式骨架）', function () {
    var line = loopTrace.renderOneLine({
      iteration: 1,
      phases: [{ phase: 'observe', elapsedMs: 5 }, { phase: 'act', elapsedMs: 100 }],
    });
    // think/reflect/decide 缺失但仍占位显示 -
    assert.match(line, /Think -/);
    assert.match(line, /Reflect -/);
    assert.match(line, /Decide -/);
  });

  test('round record 经 build→render 全链路：从真实 phaseTimings 到一行摘要', function () {
    var phaseTimings = [
      { phase: 'observe', elapsedMs: 8 },
      { phase: 'think', elapsedMs: 2 },
      { phase: 'act', elapsedMs: 3000 },
      { phase: 'reflect', elapsedMs: 4 },
      { phase: 'decide', elapsedMs: 1 },
    ];
    var rec = loopTrace.buildRoundRecord({
      loopId: 'loop-e2e',
      iteration: 5,
      phaseTimings: phaseTimings,
      verdict: 'continue',
      dispatchedWp: 'WP-77',
    });
    var line = loopTrace.renderOneLine(rec);
    assert.match(line, /\[iter 5\].*Act 3000ms.*→ dispatch WP-77/);
  });
});

// ===========================================================================
// buildRoundRecord 容错降级（纯函数，缺失输入字段降级不抛）
// ===========================================================================

test.describe('buildRoundRecord 容错', function () {
  test('缺失 executorTrace → executor=null', function () {
    var rec = loopTrace.buildRoundRecord({ loopId: 'l', iteration: 1 });
    assert.equal(rec.executor, null, '缺失 executorTrace 降级为 null');
    assert.deepEqual(rec.phases, [], '缺失 phaseTimings 降级为空数组');
  });

  test('iteration 非数字 → 降级为 0', function () {
    var rec = loopTrace.buildRoundRecord({ loopId: 'l' });
    assert.equal(rec.iteration, 0);
  });

  test('null/undefined opts → 不抛，产出最小 record', function () {
    assert.doesNotThrow(function () {
      var rec = loopTrace.buildRoundRecord(null);
      assert.equal(rec.loopId, '');
    });
    assert.doesNotThrow(function () {
      loopTrace.buildRoundRecord(undefined);
    });
  });
});
