/**
 * WP-175-5-test: init/migrate 降级降噪不变量回归测试
 * Run with: node --test test/runtime/test-init-migrate-noise.js
 *
 * 覆盖 WP-175-3 修复：
 *   init.js / migrate.js 中的"预期降级 catch"改为 verbose-only 的 console.warn，
 *   默认（非 verbose）静默；不再打印 `[tackle-harness] Error:` 级别噪音。
 *   真 catch（init.js 模板拷贝 / manifest 创建失败）保留 console.error。
 *
 * 不变量锚定（实际断言）：
 *   1) 非 verbose 时，触发预期降级路径（malformed JSON）→ console.error 不被调用、
 *      合并日志不含 `[tackle-harness] Error:`（含 `(degraded)` warn 也不出现）
 *   2) verbose 时，同一降级路径 → 输出含 `(degraded)` warn，且仍不含 `Error:`
 *   3) 真 catch（init 模板缺失导致 manifest/config 创建失败）→ 仍走 console.error，
 *      证明降噪只针对"预期降级"而非掩盖真错误（防止降噪过度）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var os = require('os');

var migrate = require('../../bin/commands/migrate');
var init = require('../../bin/commands/init');

// ─────────────────────────────────────────────
// Helpers — 自包含脚手架（不依赖真实仓库结构）
// ─────────────────────────────────────────────

function createTestProject(options) {
  options = options || {};
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-noise-test-'));
  var packageRoot = path.join(tmpDir, 'package');
  var targetRoot = path.join(tmpDir, 'project');

  // package 结构（init/migrate 通过 ctx.packageRoot 找模板 / registry）
  fs.mkdirSync(path.join(packageRoot, 'plugins', 'core'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'plugins', 'plugin-registry.json'),
    JSON.stringify({ version: '1.0.0', plugins: [] }, null, 2),
    'utf-8'
  );
  var templatesDir = path.join(packageRoot, 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(
    path.join(templatesDir, 'harness-config.yaml'),
    '# template\ncontext_window:\n  enabled: true\n',
    'utf-8'
  );

  // target 项目结构
  fs.mkdirSync(path.join(targetRoot, '.claude', 'config'), { recursive: true });

  // settings.json（可被 options.settings 覆盖为 malformed）
  var settingsPath = path.join(targetRoot, '.claude', 'settings.json');
  if (options.settingsContent !== undefined) {
    fs.writeFileSync(settingsPath, options.settingsContent, 'utf-8');
  } else if (options.settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(options.settings, null, 2), 'utf-8');
  }

  // harness-config.yaml 占位（init 跳过已存在的拷贝，避免依赖模板）
  fs.writeFileSync(
    path.join(targetRoot, '.claude', 'config', 'harness-config.yaml'),
    '# test config\ncontext_window:\n  enabled: true\n',
    'utf-8'
  );
  // harness-manifest.json 占位（init 跳过已存在的创建）
  fs.writeFileSync(
    path.join(targetRoot, '.claude', 'harness-manifest.json'),
    '{"plugins":{}}\n',
    'utf-8'
  );

  return {
    tmpDir: tmpDir,
    packageRoot: packageRoot,
    targetRoot: targetRoot,
    registryPath: path.join(packageRoot, 'plugins', 'plugin-registry.json'),
    settingsPath: settingsPath,
    configDir: path.join(targetRoot, '.claude', 'config'),
    cleanup: function () { fs.rmSync(tmpDir, { recursive: true, force: true }); },
  };
}

/**
 * 构造 mock ctx，并把 console.error / console.warn / console.log 接管到 logs 池。
 * @param {object} project
 * @param {boolean} verbose
 */
function createCapturingContext(project, verbose) {
  var errorCalls = [];
  var warnCalls = [];
  var logCalls = [];

  var origError = console.error;
  var origWarn = console.warn;
  var origLog = console.log;
  console.error = function () { errorCalls.push(Array.prototype.join.call(arguments, ' ')); };
  console.warn = function () { warnCalls.push(Array.prototype.join.call(arguments, ' ')); };
  console.log = function () { logCalls.push(Array.prototype.join.call(arguments, ' ')); };

  var ctx = {
    packageRoot: project.packageRoot,
    targetRoot: project.targetRoot,
    settingsPath: project.settingsPath,
    registryPath: project.registryPath,
    configDir: project.configDir,
    flags: { noColor: true, verbose: !!verbose },
    command: 'noise-test',
    packageVersion: '0.2.7',
    colorize: function (text) { return text; },
    exit: function () {},
    createBuilder: function () {
      return {
        updateSettings: function () {},
        injectClaudeMdRules: function () {},
      };
    },
  };

  return {
    ctx: ctx,
    restore: function () {
      console.error = origError;
      console.warn = origWarn;
      console.log = origLog;
    },
    errorCalls: errorCalls,
    warnCalls: warnCalls,
    logCalls: logCalls,
    allText: function () {
      return errorCalls.concat(warnCalls).concat(logCalls).join('\n');
    },
  };
}

// 合并文本里是否含 [tackle-harness] Error: 级别噪音
function hasErrorLevelNoise(text) {
  return /\[tackle-harness\]\s*Error:/.test(text);
}

// ─────────────────────────────────────────────
// Section 1: migrate 预期降级不打印 Error
// ─────────────────────────────────────────────

test.describe('migrate 预期降级降噪 (WP-175-5)', function () {

  test('malformed settings.json + 非 verbose → 无 Error 级别输出，无 degraded warn', function () {
    var project = createTestProject({
      settingsContent: '{invalid json!!!',
    });
    var cap = createCapturingContext(project, false);
    try {
      migrate.execute(cap.ctx);
    } finally {
      cap.restore();
      project.cleanup();
    }
    var text = cap.allText();
    assert.strictEqual(
      hasErrorLevelNoise(text),
      false,
      '非 verbose 预期降级不应打印 [tackle-harness] Error:；实际: ' + JSON.stringify(text)
    );
    assert.strictEqual(
      cap.warnCalls.length,
      0,
      '非 verbose 不应有 degraded warn；实际: ' + JSON.stringify(cap.warnCalls)
    );
    assert.strictEqual(
      cap.errorCalls.length,
      0,
      '非 verbose 不应调用 console.error；实际: ' + JSON.stringify(cap.errorCalls)
    );
  });

  test('malformed settings.json + verbose → 有 degraded warn，但无 Error', function () {
    var project = createTestProject({
      settingsContent: '{invalid json!!!',
    });
    var cap = createCapturingContext(project, true);
    try {
      migrate.execute(cap.ctx);
    } finally {
      cap.restore();
      project.cleanup();
    }
    var text = cap.allText();
    assert.strictEqual(
      hasErrorLevelNoise(text),
      false,
      'verbose 预期降级也不应打印 Error；实际: ' + JSON.stringify(text)
    );
    // verbose 时应至少有一条 (degraded) warn（hooks 清理降级）
    var degradedWarns = cap.warnCalls.filter(function (l) {
      return l.indexOf('(degraded)') !== -1;
    });
    assert.ok(
      degradedWarns.length > 0,
      'verbose 时应有 (degraded) warn；实际 warnCalls: ' + JSON.stringify(cap.warnCalls)
    );
  });

  test('缺 settings.json → migrate 不抛错、无 Error 噪音', function () {
    var project = createTestProject();
    if (fs.existsSync(project.settingsPath)) {
      fs.unlinkSync(project.settingsPath);
    }
    var cap = createCapturingContext(project, false);
    try {
      migrate.execute(cap.ctx);
    } finally {
      cap.restore();
      project.cleanup();
    }
    assert.strictEqual(hasErrorLevelNoise(cap.allText()), false);
  });
});

// ─────────────────────────────────────────────
// Section 2: init 预期降级不打印 Error
// ─────────────────────────────────────────────

test.describe('init 预期降级降噪 (WP-175-5)', function () {

  test('malformed settings.json + 非 verbose → 无 Error 级别输出', function () {
    var project = createTestProject({
      settingsContent: '{invalid json!!!',
    });
    var cap = createCapturingContext(project, false);
    try {
      init.execute(cap.ctx);
    } finally {
      cap.restore();
      project.cleanup();
    }
    var text = cap.allText();
    assert.strictEqual(
      hasErrorLevelNoise(text),
      false,
      '非 verbose 预期降级不应打印 Error；实际: ' + JSON.stringify(text)
    );
    assert.strictEqual(cap.warnCalls.length, 0, '非 verbose 无 warn');
  });

  test('malformed settings.json + verbose → 有 degraded warn，无 Error', function () {
    var project = createTestProject({
      settingsContent: '{invalid json!!!',
    });
    var cap = createCapturingContext(project, true);
    try {
      init.execute(cap.ctx);
    } finally {
      cap.restore();
      project.cleanup();
    }
    var text = cap.allText();
    assert.strictEqual(hasErrorLevelNoise(text), false, 'verbose 也不应有 Error');
    var degradedWarns = cap.warnCalls.filter(function (l) {
      return l.indexOf('(degraded)') !== -1;
    });
    assert.ok(degradedWarns.length > 0, 'verbose 应有 degraded warn');
  });
});

// ─────────────────────────────────────────────
// Section 3: 降噪不过度——真 catch 仍走 console.error
//   防止未来把"预期降级降噪"误改成吞掉所有错误。
// ─────────────────────────────────────────────

test.describe('真错误降噪不过度 (WP-175-5)', function () {

  test('init 模板缺失导致 config 创建失败 → 仍打印 Error（降噪未掩盖真错误）', function () {
    // 删除既有 harness-config.yaml，强制 init 走模板拷贝路径；
    // 同时让模板路径指向不存在的文件，触发真 catch（init.js L51-54）。
    var project = createTestProject();
    fs.unlinkSync(path.join(project.configDir, 'harness-config.yaml'));

    var cap = createCapturingContext(project, false);
    // 用 Proxy 包裹 fs.readFileSync 模拟模板读取失败过于侵入；
    // 改为：让模板文件不存在（删除 package 模板），readFileSync 抛 ENOENT → 真 catch。
    fs.unlinkSync(path.join(project.packageRoot, 'templates', 'harness-config.yaml'));

    try {
      init.execute(cap.ctx);
    } finally {
      cap.restore();
      project.cleanup();
    }
    // 真 catch 走 console.error，应含 [tackle-harness] Error:
    assert.ok(
      hasErrorLevelNoise(cap.allText()),
      '真错误（模板拷贝失败）应保留 Error 输出，降噪未掩盖；实际 errorCalls: ' +
        JSON.stringify(cap.errorCalls)
    );
  });
});
