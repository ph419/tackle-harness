/**
 * Unit tests for provider-watchdog getHealth / isRunning (WP-174-5 / WP-174-6)
 * Run with: node --test test/runtime/test-watchdog-health.js
 *
 * 覆盖（design.md §6.3.2）：
 *   - getHealth 三态：healthy / degraded / terminated
 *     - terminated：health==='terminated' 或状态文件缺失/损坏
 *     - degraded：非终止但心跳过期（> STALE_THRESHOLD_MS）
 *     - healthy：非终止且心跳新鲜
 *   - isRunning 向后兼容不变量：degraded 时 isRunning 仍 true（仅 terminated 返回 false）
 *   - _readStatus 降级（文件缺失/损坏 JSON）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var WatchdogProvider = require('../../plugins/core/provider-watchdog');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wd-health-test-'));
}

function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

/**
 * 激活 provider 并返回 factory API。
 * 把 .claude-daemon 状态文件写到 cwd 下的临时目录。
 */
async function makeWatchdog(statusWriter) {
  var dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.claude-daemon'), { recursive: true });
  if (statusWriter) {
    statusWriter(path.join(dir, '.claude-daemon', 'daemon-status.json'));
  }
  var origCwd = process.cwd();
  process.chdir(dir);

  var provider = new WatchdogProvider();
  await provider.onActivate({ logger: { info: function () {} } });
  var api = await provider.factory({});

  return {
    dir: dir,
    api: api,
    origCwd: origCwd,
    restore: function () { process.chdir(origCwd); cleanupTmpDir(dir); },
  };
}

function writeStatus(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
}

// ─────────────────────────────────────────────
// Section 1: getHealth 三态
// ─────────────────────────────────────────────

test.describe('getHealth 三态', function () {
  test('healthy：非终止 + 心跳新鲜', async function () {
    var env = await makeWatchdog(function (p) {
      writeStatus(p, { health: 'healthy', last_update: new Date().toISOString() });
    });
    try {
      var h = env.api.getHealth();
      assert.strictEqual(h.state, 'healthy');
      assert.strictEqual(h.running, true);
      assert.strictEqual(h.stale, false);
    } finally {
      env.restore();
    }
  });

  test('terminated：health === terminated', async function () {
    var env = await makeWatchdog(function (p) {
      writeStatus(p, { health: 'terminated', last_update: new Date().toISOString() });
    });
    try {
      var h = env.api.getHealth();
      assert.strictEqual(h.state, 'terminated');
      assert.strictEqual(h.running, false);
    } finally {
      env.restore();
    }
  });

  test('terminated：状态文件缺失', async function () {
    var env = await makeWatchdog(null);
    try {
      var h = env.api.getHealth();
      assert.strictEqual(h.state, 'terminated');
      assert.strictEqual(h.running, false);
    } finally {
      env.restore();
    }
  });

  test('terminated：状态文件损坏（非法 JSON）', async function () {
    var env = await makeWatchdog(function (p) {
      fs.writeFileSync(p, '{ not valid json }}}', 'utf8');
    });
    try {
      var h = env.api.getHealth();
      assert.strictEqual(h.state, 'terminated');
      assert.strictEqual(h.running, false);
    } finally {
      env.restore();
    }
  });

  test('degraded：非终止但心跳过期（> 120s）', async function () {
    var env = await makeWatchdog(function (p) {
      // 5 分钟前的心跳 → 过期
      var stale = Date.now() - 5 * 60 * 1000;
      writeStatus(p, { health: 'healthy', last_update: new Date(stale).toISOString() });
    });
    try {
      var h = env.api.getHealth();
      assert.strictEqual(h.state, 'degraded');
      assert.strictEqual(h.stale, true);
      assert.strictEqual(h.running, true, 'degraded 时 running 仍 true');
    } finally {
      env.restore();
    }
  });

  test('degradable 字段兼容：last_heartbeat / updated_at 也能触发 stale', async function () {
    var env = await makeWatchdog(function (p) {
      var stale = Date.now() - 3 * 60 * 1000;
      writeStatus(p, { health: 'running', last_heartbeat: new Date(stale).toISOString() });
    });
    try {
      var h = env.api.getHealth();
      assert.strictEqual(h.state, 'degraded');
      assert.strictEqual(h.stale, true);
    } finally {
      env.restore();
    }
  });

  test('非终止且无心跳字段 → healthy（无法判定 stale）', async function () {
    var env = await makeWatchdog(function (p) {
      writeStatus(p, { health: 'healthy' });
    });
    try {
      var h = env.api.getHealth();
      assert.strictEqual(h.state, 'healthy');
      assert.strictEqual(h.stale, false);
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 2: isRunning 向后兼容不变量
//   关键：degraded 时 isRunning 仍 true —— 不破坏只关心"完全挂掉"的旧调用方。
// ─────────────────────────────────────────────

test.describe('isRunning 向后兼容不变量', function () {
  test('healthy → isRunning=true', async function () {
    var env = await makeWatchdog(function (p) {
      writeStatus(p, { health: 'healthy', last_update: new Date().toISOString() });
    });
    try {
      assert.strictEqual(env.api.isRunning(), true);
    } finally {
      env.restore();
    }
  });

  test('degraded → isRunning 仍 true（不因心跳过期返回 false）', async function () {
    var env = await makeWatchdog(function (p) {
      var stale = Date.now() - 5 * 60 * 1000;
      writeStatus(p, { health: 'healthy', last_update: new Date(stale).toISOString() });
    });
    try {
      var h = env.api.getHealth();
      assert.strictEqual(h.state, 'degraded');
      assert.strictEqual(env.api.isRunning(), true, 'degraded 时 isRunning 不变 false');
    } finally {
      env.restore();
    }
  });

  test('terminated → isRunning=false', async function () {
    var env = await makeWatchdog(function (p) {
      writeStatus(p, { health: 'terminated' });
    });
    try {
      assert.strictEqual(env.api.isRunning(), false);
    } finally {
      env.restore();
    }
  });

  test('状态文件缺失 → isRunning=false', async function () {
    var env = await makeWatchdog(null);
    try {
      assert.strictEqual(env.api.isRunning(), false);
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 3: 其他 factory 方法
// ─────────────────────────────────────────────

test.describe('其他方法', function () {
  test('isDeployed：无 .claude/watchdog → false', async function () {
    var env = await makeWatchdog(null);
    try {
      assert.strictEqual(env.api.isDeployed(), false);
    } finally {
      env.restore();
    }
  });

  test('isDeployed：有 watchdog.js → true', async function () {
    var env = await makeWatchdog(null);
    try {
      fs.mkdirSync(path.join(env.dir, '.claude', 'watchdog'), { recursive: true });
      fs.writeFileSync(path.join(env.dir, '.claude', 'watchdog', 'watchdog.js'), '// stub', 'utf8');
      assert.strictEqual(env.api.isDeployed(), true);
    } finally {
      env.restore();
    }
  });

  test('getStatusFilePath 默认指向 .claude-daemon', async function () {
    var env = await makeWatchdog(null);
    try {
      var p = env.api.getStatusFilePath();
      assert.ok(p.indexOf('.claude-daemon') !== -1);
    } finally {
      env.restore();
    }
  });

  test('_readStatus：返回原始对象', async function () {
    var env = await makeWatchdog(function (p) {
      writeStatus(p, { health: 'healthy', custom: 42 });
    });
    try {
      var st = env.api._readStatus();
      assert.strictEqual(st.custom, 42);
    } finally {
      env.restore();
    }
  });

  test('_getHeartbeatDir：daemon-config.json 覆盖默认', async function () {
    var env = await makeWatchdog(null);
    try {
      fs.writeFileSync(
        path.join(env.dir, '.claude-daemon', 'daemon-config.json'),
        JSON.stringify({ heartbeat_dir: '.custom-daemon' }),
        'utf8'
      );
      assert.strictEqual(env.api._getHeartbeatDir(), '.custom-daemon');
    } finally {
      env.restore();
    }
  });
});
