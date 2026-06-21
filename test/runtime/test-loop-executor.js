/**
 * Unit tests for loop-executor factory (WP-185-impl / WP-188 重构)
 * Run with: node --test test/runtime/test-loop-executor.js
 *
 * 覆盖：
 *   - createExecutor('local') / ('default') 路由到正确实现
 *   - 别名：'claude' → 'default'（向后兼容 v0.3.4~0.3.8）
 *   - BREAKING：'glm' 已删除 → 抛 UNKNOWN_EXECUTOR
 *   - 默认 provider='local'
 *   - createExecutor(opts) 单参调用（opts.provider）
 *   - 未知 provider 抛 UNKNOWN_EXECUTOR（含 available 列表）
 *   - listProviders 返回注册名（不含别名）
 *   - opts 透传（rateLimitPerHour 等到达具体 executor）
 *   - 所有 executor 返回同一接口契约 { name, run, config }
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');

var loopExecutor = require('../../plugins/runtime/loop-executor');

// ─────────────────────────────────────────────
// Section 1: executor 路由
// ─────────────────────────────────────────────

test('createExecutor("local") 路由到 executor-local', function () {
  var exec = loopExecutor.createExecutor('local');
  assert.strictEqual(exec.name, 'local');
  assert.strictEqual(typeof exec.run, 'function');
  assert.ok(exec.config && typeof exec.config === 'object');
});

test('createExecutor("default") 路由到 executor-default', function () {
  var exec = loopExecutor.createExecutor('default', { projectRoot: process.cwd() });
  assert.strictEqual(exec.name, 'default');
  assert.strictEqual(typeof exec.run, 'function');
});

test('别名：createExecutor("claude") → default（向后兼容 v0.3.4~0.3.8）', function () {
  var exec = loopExecutor.createExecutor('claude', { projectRoot: process.cwd() });
  assert.strictEqual(exec.name, 'default', 'claude 别名应路由到 default executor');
  assert.strictEqual(typeof exec.run, 'function');
});

test('默认 provider=local', function () {
  var exec = loopExecutor.createExecutor();
  assert.strictEqual(exec.name, 'local');
});

test('createExecutor(opts) 单参调用：opts.provider 指定 executor', function () {
  var exec = loopExecutor.createExecutor({ provider: 'default', projectRoot: process.cwd() });
  assert.strictEqual(exec.name, 'default');
});

test('createExecutor(null) 降级为 local', function () {
  var exec = loopExecutor.createExecutor(null);
  assert.strictEqual(exec.name, 'local');
});

// ─────────────────────────────────────────────
// Section 2: 错误处理（含 BREAKING：glm 删除）
// ─────────────────────────────────────────────

test('BREAKING：createExecutor("glm") 抛 UNKNOWN_EXECUTOR（glm executor 已删除）', function () {
  assert.throws(function () {
    loopExecutor.createExecutor('glm', {});
  }, function (err) {
    return err.code === 'UNKNOWN_EXECUTOR' && err.provider === 'glm';
  });
});

test('未知 executor 抛 UNKNOWN_EXECUTOR 含 available 列表', function () {
  assert.throws(function () {
    loopExecutor.createExecutor('nonexistent');
  }, function (err) {
    return err.code === 'UNKNOWN_EXECUTOR' &&
      err.provider === 'nonexistent' &&
      Array.isArray(err.available) &&
      err.available.indexOf('local') !== -1 &&
      err.available.indexOf('default') !== -1;
  });
});

// ─────────────────────────────────────────────
// Section 3: listProviders（不含别名）
// ─────────────────────────────────────────────

test('listProviders 返回 local 与 default（不含别名 claude）', function () {
  var names = loopExecutor.listProviders();
  assert.ok(Array.isArray(names));
  assert.ok(names.indexOf('local') !== -1);
  assert.ok(names.indexOf('default') !== -1);
  assert.strictEqual(names.indexOf('claude'), -1, '别名不应出现在 listProviders');
  assert.strictEqual(names.indexOf('glm'), -1, 'glm 已删除不应出现');
});

test('_ALIASES 含 claude→default', function () {
  assert.strictEqual(loopExecutor._ALIASES.claude, 'default');
});

// ─────────────────────────────────────────────
// Section 4: opts 透传
// ─────────────────────────────────────────────

test('opts 透传到具体 executor（local rateLimitPerHour 生效）', async function () {
  var exec = loopExecutor.createExecutor('local', { rateLimitPerHour: 1 });
  assert.strictEqual(exec.config.rateLimitPerHour, 1);
  var r1 = await exec.run({ wpId: 'WP-1', mode: 'dispatch' });
  var r2 = await exec.run({ wpId: 'WP-2', mode: 'dispatch' });
  assert.strictEqual(r1.passed, true);
  assert.strictEqual(r2.passed, false);
  assert.ok(r2.failedItems.some(function (fi) { return fi.reason === 'rate_limited'; }));
});

test('opts 透传到 default executor（timeoutMs / model / provider）', function () {
  var exec = loopExecutor.createExecutor('default', {
    timeoutMs: 5000, projectRoot: process.cwd(),
    model: 'glm-5.2', provider: 'glm',
  });
  assert.strictEqual(exec.config.timeoutMs, 5000);
  assert.strictEqual(exec.config.binary, 'claude');
  assert.strictEqual(exec.config.model, 'glm-5.2');
  assert.strictEqual(exec.config.provider, 'glm');
});

// ─────────────────────────────────────────────
// Section 5: 接口契约一致性（local / default 同构）
// ─────────────────────────────────────────────

test('local 与 default 实现同一份接口契约 { name, run, config, quota }', function () {
  var local = loopExecutor.createExecutor('local');
  var def = loopExecutor.createExecutor('default', { projectRoot: process.cwd() });
  [local, def].forEach(function (exec) {
    assert.ok(typeof exec.name === 'string' && exec.name, 'name 非空字符串');
    assert.strictEqual(typeof exec.run, 'function', 'run 是函数');
    assert.ok(exec.config && typeof exec.config === 'object', 'config 是对象');
    assert.ok(exec.quota && typeof exec.quota.windowUsed === 'function' &&
      typeof exec.quota.weekUsed === 'function' &&
      typeof exec.quota.windowRatio === 'function',
      '应暴露 quota 视图（windowUsed/weekUsed/windowRatio）');
  });
});
