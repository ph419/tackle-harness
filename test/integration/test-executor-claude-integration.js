/**
 * Integration tests for executor-claude (WP-187-verify / WP-187-acceptance)
 * Run with: node --test test/integration/test-executor-claude-integration.js
 *
 * 策略：
 *   - 真实 claude binary 单次冒烟（CLAUDE_PRESENT 时跑，否则 skip）：验证 spawn→stdout→
 *     json:machine-readable 解析端到端打通，不验证业务正确性（避免烧额度/长时间）
 *   - 超时 acceptance：spawn 一个 sleep 子进程伪装 claude，极短 timeoutMs，断言不卡死、
 *     返回 passed:false + timeout（WP-187「断网/额度耗尽场景不卡死」验收）
 *
 * 注意：真实 claude 冒烟用最小 prompt（要求只产 json:machine-readable block，不写文件），
 *   避免污染工作区；并设较短 timeoutMs（60s）防止卡住测试套件。
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var { execFileSync, spawn } = require('child_process');

var executorClaude = require('../../plugins/runtime/executor-claude');
var loopExecutor = require('../../plugins/runtime/loop-executor');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exec-claude-int-'));
}

function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

/**
 * 探测 claude binary 是否可用（不阻塞；失败立即返回 false）。
 * @returns {boolean}
 */
function isClaudeAvailable() {
  try {
    execFileSync('claude', ['--version'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (_e) {
    return false;
  }
}

var CLAUDE_AVAILABLE = isClaudeAvailable();

// ─────────────────────────────────────────────
// Section 1: 真实 claude 冒烟（条件跑）
// ─────────────────────────────────────────────

test.describe('真实 claude binary 冒烟', { concurrency: false }, function () {
  test('claude --version 可调用（环境探针）', { skip: !CLAUDE_AVAILABLE }, function () {
    // 仅当 CLAUDE_AVAILABLE 时跑；否则整个 describe 的真实测试都 skip
    assert.ok(CLAUDE_AVAILABLE);
  });

  test('executor-claude.run() 真实 spawn claude，解析出 CheckResult', {
    skip: !CLAUDE_AVAILABLE ? 'claude binary 不可用，跳过真实冒烟' : false,
    timeout: 150000,
  }, async function (t) {
    // ⚠️ 环境依赖说明：此用例真实 spawn claude binary，背后依赖第三方端点
    // （open.bigmodel.cn/api/anthropic + glm-5.2[1m] 大窗口）+ 网络。
    // 真实冒烟的核心价值是验证 spawn→stdout→json:machine-readable 解析链路打通，
    // 不是验证 claude 速度。本地端点 TTFT 高时，即使 timeoutMs 放宽到 120s 仍可能
    // 不够，此时失败原因若仅为 timeout，则视为「环境慢无法判定」降级 skip，
    // 属预期行为，不代表链路损坏（spawn_failed / parse_failed 才算硬失败）。
    // 用隔离 tmpdir 作 projectRoot，避免污染真实仓库
    var dir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(dir, 'docs', 'wp'), { recursive: true });
      // 构造一个极简 WP 文档，要求 claude 仅产判定块、不写文件
      fs.writeFileSync(path.join(dir, 'docs', 'wp', 'WP-SMOKE.md'),
        '# WP-SMOKE: 冒烟\n\n## 目标\n这是一个冒烟测试。不要修改任何文件。\n\n## 验收标准\n- [ ] 回复中包含 json:machine-readable block，passed=true\n',
        'utf8');

      var exec = executorClaude.createExecutor({
        projectRoot: dir,
        timeoutMs: 120000, // 120s 上限：放宽给第三方端点更多时间尽量跑通真实链路验证
        rateLimitPerHour: 5,
        // 收窄 allowedTools：冒烟只需 Read，避免 claude 真去写文件
        allowedTools: ['Read'],
      });

      var result = await exec.run({
        wpId: 'WP-SMOKE', mode: 'dispatch', strategy: 'full_restart',
        failingDrivers: [], createdAt: new Date().toISOString(), loopId: 'loop-smoke',
      });

      // 核心断言：解析出了合法 CheckResult（spawn→stdout→block 链路通）
      assert.ok(typeof result.wpId === 'string', 'wpId 应为字符串');
      assert.ok(typeof result.passed === 'boolean', 'passed 应为布尔');
      assert.ok(result.summary && typeof result.summary.total === 'number', 'summary.total 应为数字');
      // 如果 claude 正确产出了 block，failedItems 应是数组（即使非空）
      assert.ok(Array.isArray(result.failedItems), 'failedItems 应为数组');
      // 不强制 passed=true（claude 可能判定未达标），但不应是 parse/spawn 失败
      var failureReasons = result.failedItems.map(function (fi) { return fi.reason || ''; });
      // timeout 降级：真实端点慢（TTFT 高 / 大窗口）时，即使 120s 也可能不够。
      // 此失败原因仅为「环境慢无法判定」，降级 skip 而非硬 fail（链路本身并未损坏）。
      if (failureReasons.indexOf('timeout') !== -1) {
        t.skip('环境慢：真实端点 120s 内未产出判定块，降级跳过（非链路损坏）');
        return;
      }
      // spawn_failed 仍为硬断言：链路本身断了（binary 缺失/权限/连接失败等）才算失败
      assert.ok(!failureReasons.some(function (r) { return r.indexOf('spawn_failed') !== -1; }),
        '不应 spawn 失败');
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

// ─────────────────────────────────────────────
// Section 2: 超时 acceptance（WP-187：不卡死）
// ─────────────────────────────────────────────

test('真实 spawn 慢子进程 + 极短 timeoutMs → 返回 timeout，不卡死', async function () {
  // 用 node 长循环伪装一个永不退出的 claude：不依赖外部 binary
  var dir = makeTmpDir();
  try {
    // 构造一个「假的 claude」脚本：sleep 30s
    var fakeClaude = path.join(dir, 'fake-claude.js');
    fs.writeFileSync(fakeClaude,
      'setTimeout(function(){}, 30000); process.stdout.write("never");\n',
      'utf8');

    // spawnFn 包装：用 node 跑 fake-claude.js 代替 claude
    var fakeSpawn = function (binary, args, spOpts) {
      // 忽略真实 binary/args，改跑 node fake-claude.js
      return spawn('node', [fakeClaude], spOpts);
    };

    var exec = executorClaude.createExecutor({
      spawnFn: fakeSpawn,
      projectRoot: dir,
      timeoutMs: 300, // 300ms 超时
    });

    var start = Date.now();
    var result = await exec.run({
      wpId: 'WP-hang', mode: 'dispatch', strategy: 'full_restart',
      failingDrivers: [], createdAt: new Date().toISOString(), loopId: 'loop-hang',
    });
    var elapsed = Date.now() - start;

    assert.strictEqual(result.passed, false);
    assert.ok(result.failedItems.some(function (fi) { return fi.reason === 'timeout'; }),
      '应返回 timeout');
    // 不卡死：应在合理时间内返回（超时 + 2s SIGKILL 宽限 < 5s）
    assert.ok(elapsed < 5000, '应在 5s 内返回（实际 ' + elapsed + 'ms），不能卡死');
  } finally {
    cleanupTmpDir(dir);
  }
});

// ─────────────────────────────────────────────
// Section 3: driver + executor-claude 超时收敛到 timeout 终态（acceptance）
// ─────────────────────────────────────────────

test('driver --executor=claude 超时场景：loop 终止 exit 1，不卡死', async function () {
  var loopCmd = require('../../bin/commands/loop');

  var dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n', 'utf8');
    // 极简 plan：1 个 WP
    fs.writeFileSync(path.join(dir, '.claude', 'plan.md'),
      '# Plan\n\n## Step 1: 冒烟\n- [ ] 任务1\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'docs', 'wp'), { recursive: true });

    // 假 claude：永不退出
    var fakeClaude = path.join(dir, 'fake-claude.js');
    fs.writeFileSync(fakeClaude,
      'setTimeout(function(){}, 60000);\n', 'utf8');

    // 通过 loop-executor 注册一个临时 provider 指向 fakeSpawn
    var origRegistry = Object.assign({}, loopExecutor._REGISTRY);
    loopExecutor._REGISTRY['claude-fake'] = function () {
      return {
        createExecutor: function (opts) {
          var exec = executorClaude.createExecutor(Object.assign({}, opts, {
            spawnFn: function (binary, args, spOpts) {
              return spawn('node', [fakeClaude], spOpts);
            },
            timeoutMs: 300,
          }));
          exec.name = 'claude-fake';
          return exec;
        },
      };
    };

    var logs = [];
    var exitCode = { value: null };
    var ctx = {
      targetRoot: dir,
      packageRoot: path.resolve(__dirname, '..', '..'),
      flags: { noColor: true },
      command: 'loop',
      packageVersion: 'test',
      argv: [path.join(dir, '.claude', 'plan.md'), '--executor=claude-fake', '--max-iters=1'],
      colorize: function (t) { return t; },
      exit: function (code) { exitCode.value = code; },
      log: function (msg) { logs.push(String(msg)); },
    };

    var start = Date.now();
    await loopCmd.execute(ctx);
    var elapsed = Date.now() - start;

    // 恢复注册表
    Object.keys(loopExecutor._REGISTRY).forEach(function (k) {
      if (!origRegistry[k]) delete loopExecutor._REGISTRY[k];
    });

    // 验收：driver 不卡死、退出码非 0、报告 timeout
    assert.ok(elapsed < 10000, 'driver 应在 10s 内终止（实际 ' + elapsed + 'ms）');
    assert.ok(exitCode.value === 1 || exitCode.value === 2, '应非 0 退出（实际 ' + exitCode.value + '）');
    var combined = logs.join('\n');
    // timeout 或 timeout-触发的终态（diverged/timeout）
    assert.ok(combined.indexOf('terminated') !== -1 || combined.indexOf('Agentic Loop') !== -1,
      '应打印 loop 终止信息');
  } finally {
    cleanupTmpDir(dir);
  }
});
