/**
 * E2E tests for the standard CLI workflow: init -> build -> validate
 *
 * Uses child_process.execSync to invoke bin/tackle.js as a real subprocess,
 * verifying the full CLI pipeline from argument parsing through file output.
 *
 * Key insight: The CLI always reads plugins from its own package root
 * (bin/tackle.js sets packageRoot = path.resolve(__dirname, '..')).
 * The --root flag only changes the target project where output is written.
 * This means all E2E builds use the tackle-harness package's own 23 plugins.
 *
 * Run with: node --test test/e2e/test-init-build-validate.js
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

var CLI_PATH = path.resolve(__dirname, '../../bin/tackle.js');
var PACKAGE_ROOT = path.resolve(__dirname, '../..');

/**
 * Run a tackle CLI command in a given working directory.
 * Returns trimmed stdout. Throws on non-zero exit code unless opts.allowFail.
 */
function tackle(args, cwd, opts) {
  opts = opts || {};
  var cmd = 'node ' + JSON.stringify(CLI_PATH) + ' --no-color ' + args;
  try {
    var result = execSync(cmd, {
      cwd: cwd,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (err) {
    if (opts.allowFail) {
      return (err.stdout || '').trim() + '\n' + (err.stderr || '').trim();
    }
    var detail = (err.stderr && err.stderr.trim()) || err.message;
    throw new Error(
      'tackle ' + args + ' failed in ' + cwd + ':\n' + detail
    );
  }
}

/**
 * Create a temporary directory for an E2E test project.
 */
function createTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'tackle-e2e-'));
}

/**
 * Remove a temporary directory.
 */
function removeTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// WP-118-1: Core E2E workflow tests (global mode with --root)
// ---------------------------------------------------------------------------

describe('E2E: init -> build -> validate standard workflow', () => {
  var tmpDir;

  before(() => {
    tmpDir = createTmpDir('e2e-workflow-');
  });

  after(() => {
    removeTmpDir(tmpDir);
  });

  test('tackle init creates .claude/ directory structure', () => {
    var output = tackle('init --root ' + JSON.stringify(tmpDir), PACKAGE_ROOT);

    // .claude/ directory must exist
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude')),
      '.claude/ directory created'
    );

    // .claude/config/ should exist
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'config')),
      '.claude/config/ directory created'
    );

    // settings.json should be generated
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'settings.json')),
      '.claude/settings.json created'
    );

    // harness-config.yaml should be generated
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'config', 'harness-config.yaml')),
      'harness-config.yaml created'
    );

    // Output should confirm success
    assert.ok(
      output.includes('Done!'),
      'init output confirms success'
    );
  });

  test('tackle build succeeds after init (global mode)', () => {
    var output = tackle(
      'build --root ' + JSON.stringify(tmpDir),
      PACKAGE_ROOT
    );

    assert.ok(
      output.includes('Build SUCCEEDED') || output.includes('SUCCEEDED'),
      'build succeeds'
    );

    // settings.json should be updated in target project
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'settings.json')),
      'settings.json updated after build'
    );
  });

  test('tackle validate passes for package plugins', () => {
    var output = tackle('validate', PACKAGE_ROOT);

    assert.ok(
      output.includes('Validation PASSED'),
      'validate passes'
    );

    // Should report checking all enabled plugins registered in the registry.
    // Dynamic count (not hardcoded) so newly registered plugins don't break it.
    var registry = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'plugins', 'plugin-registry.json'), 'utf8')
    );
    var enabledCount = registry.plugins.filter((p) => p.enabled !== false).length;
    assert.ok(
      output.includes('Plugins checked: ' + enabledCount),
      'validate reports ' + enabledCount + ' plugins checked'
    );
  });
});

// ---------------------------------------------------------------------------
// WP-118-1: Init idempotency
// ---------------------------------------------------------------------------

describe('E2E: init idempotency', () => {
  var tmpDir;

  before(() => {
    tmpDir = createTmpDir('e2e-init-idem-');
  });

  after(() => {
    removeTmpDir(tmpDir);
  });

  test('tackle init is idempotent - second run does not fail', () => {
    // First init
    tackle('init --root ' + JSON.stringify(tmpDir), PACKAGE_ROOT);

    // Second init
    var output = tackle('init --root ' + JSON.stringify(tmpDir), PACKAGE_ROOT);

    assert.ok(
      output.includes('Done!'),
      'second init succeeds'
    );

    assert.ok(
      output.includes('already exists'),
      'second init skips existing files'
    );
  });
});

// ---------------------------------------------------------------------------
// WP-118-1: Build with --verbose flag
// ---------------------------------------------------------------------------

describe('E2E: build --verbose', () => {
  var tmpDir;

  before(() => {
    tmpDir = createTmpDir('e2e-verbose-');
    tackle('init --root ' + JSON.stringify(tmpDir), PACKAGE_ROOT);
  });

  after(() => {
    removeTmpDir(tmpDir);
  });

  test('tackle build --verbose produces detailed output', () => {
    var output = tackle(
      'build --verbose --root ' + JSON.stringify(tmpDir),
      PACKAGE_ROOT
    );

    assert.ok(
      output.includes('Build SUCCEEDED') || output.includes('SUCCEEDED'),
      'verbose build succeeds'
    );

    // Verbose mode should include settings.json update notice
    assert.ok(
      output.includes('settings.json') || output.includes('Settings'),
      'verbose output mentions settings.json'
    );
  });
});

// ---------------------------------------------------------------------------
// WP-118-1: Local mode build (no --root, cwd = target)
// ---------------------------------------------------------------------------

describe('E2E: local mode build (cwd = target)', () => {
  var tmpDir;

  before(() => {
    tmpDir = createTmpDir('e2e-local-');
  });

  after(() => {
    removeTmpDir(tmpDir);
  });

  test('build in local mode creates .claude/skills/ and .claude/hooks/', () => {
    var output = tackle('build', tmpDir);

    assert.ok(
      output.includes('Build SUCCEEDED') || output.includes('SUCCEEDED'),
      'local build succeeds'
    );

    // Skills should be built to .claude/skills/
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'skills')),
      '.claude/skills/ created'
    );

    // Hooks should be built to .claude/hooks/
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'hooks')),
      '.claude/hooks/ created'
    );

    // Verify a known skill exists
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'skill-task-creator', 'skill.md')),
      'skill-task-creator skill.md exists'
    );

    // Verify a known hook exists
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'hooks', 'hook-skill-gate', 'index.js')),
      'hook-skill-gate index.js exists'
    );
  });
});

// ---------------------------------------------------------------------------
// WP-118-2: Error path tests
// ---------------------------------------------------------------------------

describe('E2E: error paths', () => {
  test('tackle validate reports error for invalid plugin', () => {
    var tmpDir = createTmpDir('e2e-validate-err-');
    try {
      // Create a project with its own registry containing an invalid plugin
      var configDir = path.join(tmpDir, '.claude', 'config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'harness-config.yaml'),
        '# test\n',
        'utf-8'
      );

      // We need to test validate with an actual invalid plugin.
      // Since the CLI always reads from packageRoot, we use the programmatic API
      // via a temporary script to test validate against a custom project.
      var testScript = path.join(tmpDir, '_test_validate.js');
      fs.writeFileSync(testScript, [
        "var HB = require(" + JSON.stringify(path.join(PACKAGE_ROOT, 'plugins/runtime/harness-build')) + ");",
        "var b = new HB({",
        "  rootDir: " + JSON.stringify(tmpDir) + ",",
        "  packageRoot: " + JSON.stringify(tmpDir) + ",",
        "});",
        "var result = b.validate();",
        "console.log(JSON.stringify(result));",
      ].join('\n'), 'utf-8');

      // Create a registry with invalid plugin
      var pluginsDir = path.join(tmpDir, 'plugins', 'core');
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'plugins', 'plugin-registry.json'),
        JSON.stringify({
          version: '1.0.0',
          plugins: [{ name: 'bad-skill', source: 'bad-skill-src', enabled: true }],
        }),
        'utf-8'
      );
      fs.mkdirSync(path.join(tmpDir, 'plugins', 'core', 'bad-skill-src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'plugins', 'core', 'bad-skill-src', 'plugin.json'),
        JSON.stringify({ name: 'bad-skill' }),
        'utf-8'
      );

      var result = execSync('node ' + JSON.stringify(testScript), {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      var parsed = JSON.parse(result.trim());
      assert.strictEqual(parsed.valid, false, 'validation fails for incomplete plugin.json');
      assert.ok(parsed.errors.length > 0, 'errors reported');
    } finally {
      removeTmpDir(tmpDir);
    }
  });

  test('tackle build handles missing registry gracefully', () => {
    var tmpDir = createTmpDir('e2e-no-reg-');
    try {
      // ManifestResolver.readGlobalRegistry returns { plugins: [] } when no registry found
      // Build succeeds but produces empty output
      var output = tackle('build', tmpDir, { allowFail: true });

      // Should either succeed with empty output or report an error
      assert.ok(
        output.includes('Build SUCCEEDED') ||
        output.includes('empty') ||
        output.includes('no output') ||
        output.includes('Error') ||
        output.includes('error'),
        'build handles missing registry: ' + output.slice(0, 200)
      );
    } finally {
      removeTmpDir(tmpDir);
    }
  });

  test('tackle build handles invalid registry JSON gracefully', () => {
    var tmpDir = createTmpDir('e2e-bad-reg-');
    try {
      var configDir = path.join(tmpDir, '.claude', 'config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'harness-config.yaml'),
        '# test\n',
        'utf-8'
      );
      var pluginsDir = path.join(tmpDir, 'plugins', 'core');
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'plugins', 'plugin-registry.json'),
        '{ this is not valid json }}}',
        'utf-8'
      );

      // readGlobalRegistry catches parse error -> empty plugins -> Build SUCCEEDED with 0 output
      var output = tackle('build', tmpDir, { allowFail: true });

      assert.ok(
        output.includes('Build SUCCEEDED') ||
        output.includes('empty') ||
        output.includes('no output'),
        'build handles invalid JSON gracefully'
      );
    } finally {
      removeTmpDir(tmpDir);
    }
  });

  test('build reports errors for corrupt plugin.json', () => {
    var tmpDir = createTmpDir('e2e-corrupt-json-');
    try {
      var configDir = path.join(tmpDir, '.claude', 'config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'harness-config.yaml'),
        '# test\n',
        'utf-8'
      );
      var pluginsDir = path.join(tmpDir, 'plugins', 'core');
      fs.mkdirSync(path.join(pluginsDir, 'bad-src'), { recursive: true });
      fs.writeFileSync(
        path.join(pluginsDir, 'bad-src', 'plugin.json'),
        '{ invalid json file',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'plugins', 'plugin-registry.json'),
        JSON.stringify({
          version: '1.0.0',
          plugins: [{ name: 'bad-plugin', source: 'bad-src', enabled: true }],
        }),
        'utf-8'
      );

      // Test via programmatic API since CLI always uses its own packageRoot
      var testScript = path.join(tmpDir, '_test_build.js');
      fs.writeFileSync(testScript, [
        "var HB = require(" + JSON.stringify(path.join(PACKAGE_ROOT, 'plugins/runtime/harness-build')) + ");",
        "var b = new HB({",
        "  rootDir: " + JSON.stringify(tmpDir) + ",",
        "  packageRoot: " + JSON.stringify(tmpDir) + ",",
        "});",
        "var result = b.build();",
        "console.log(JSON.stringify({ success: result.success, errorCount: result.errors.length }));",
      ].join('\n'), 'utf-8');

      var result = execSync('node ' + JSON.stringify(testScript), {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      var parsed = JSON.parse(result.trim());
      assert.strictEqual(parsed.success, false, 'build fails for corrupt plugin.json');
      assert.ok(parsed.errorCount > 0, 'errors reported for corrupt plugin');
    } finally {
      removeTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// WP-118-2: Edge cases
// ---------------------------------------------------------------------------

describe('E2E: edge cases', () => {
  test('tackle build handles empty registry gracefully', () => {
    var tmpDir = createTmpDir('e2e-empty-reg-');
    try {
      // Test via programmatic API with empty registry
      var configDir = path.join(tmpDir, '.claude', 'config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'harness-config.yaml'),
        '# test\n',
        'utf-8'
      );
      var pluginsDir = path.join(tmpDir, 'plugins', 'core');
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'plugins', 'plugin-registry.json'),
        JSON.stringify({ version: '1.0.0', plugins: [] }),
        'utf-8'
      );

      var testScript = path.join(tmpDir, '_test_empty.js');
      fs.writeFileSync(testScript, [
        "var HB = require(" + JSON.stringify(path.join(PACKAGE_ROOT, 'plugins/runtime/harness-build')) + ");",
        "var b = new HB({",
        "  rootDir: " + JSON.stringify(tmpDir) + ",",
        "  packageRoot: " + JSON.stringify(tmpDir) + ",",
        "});",
        "var result = b.build();",
        "console.log(JSON.stringify({ success: result.success, built: result.built.length }));",
      ].join('\n'), 'utf-8');

      var result = execSync('node ' + JSON.stringify(testScript), {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 10000,
      });

      var parsed = JSON.parse(result.trim());
      assert.strictEqual(parsed.success, true, 'build succeeds with empty registry');
      assert.strictEqual(parsed.built, 0, 'no plugins built');
    } finally {
      removeTmpDir(tmpDir);
    }
  });

  test('unknown command shows error', () => {
    var output = tackle('nonexistent-command', PACKAGE_ROOT, { allowFail: true });

    assert.ok(
      output.includes('Unknown command') || output.includes('Error'),
      'unknown command shows error: ' + output.slice(0, 200)
    );
  });

  test('--root with non-existent directory shows error (for non-init)', () => {
    var output = tackle(
      'build --root ' + JSON.stringify(path.join(os.tmpdir(), 'nonexistent-dir-xyz-123')),
      PACKAGE_ROOT,
      { allowFail: true }
    );

    assert.ok(
      output.includes('Error') || output.includes('error') || output.includes('not exist'),
      'build --root with nonexistent path reports error: ' + output.slice(0, 200)
    );
  });
});

// ---------------------------------------------------------------------------
// WP-118-1: Global mode via --root flag
// ---------------------------------------------------------------------------

describe('E2E: global mode via --root', () => {
  var tmpDir;

  before(() => {
    tmpDir = createTmpDir('e2e-global-');
  });

  after(() => {
    removeTmpDir(tmpDir);
  });

  test('init + build with --root creates project config', () => {
    // init the external project from package root
    tackle('init --root ' + JSON.stringify(tmpDir), PACKAGE_ROOT);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude')),
      '.claude/ created in external project'
    );

    // build with --root should detect global mode
    var buildOutput = tackle(
      'build --root ' + JSON.stringify(tmpDir),
      PACKAGE_ROOT
    );

    assert.ok(
      buildOutput.includes('Build SUCCEEDED') || buildOutput.includes('SUCCEEDED'),
      'build succeeds in global mode'
    );

    // settings.json should be updated in the target project
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.claude', 'settings.json')),
      'settings.json created in external project'
    );
  });

  test('build --root outputs global mode notice', () => {
    var output = tackle(
      'build --root ' + JSON.stringify(tmpDir),
      PACKAGE_ROOT
    );

    assert.ok(
      output.includes('Global mode') || output.includes('global'),
      'build --root shows global mode message'
    );
  });
});

// ---------------------------------------------------------------------------
// WP-118-1: CLI basics
// ---------------------------------------------------------------------------

describe('E2E: CLI basics', () => {
  test('--version shows version string', () => {
    var output = tackle('--version', PACKAGE_ROOT);
    assert.ok(
      output.includes('v0.'),
      'version output contains version number'
    );
  });

  test('--help shows usage information', () => {
    var output = tackle('--help', PACKAGE_ROOT);
    assert.ok(
      output.includes('Commands:') || output.includes('Usage:'),
      'help shows usage'
    );
    assert.ok(
      output.includes('build') && output.includes('validate') && output.includes('init'),
      'help lists core commands'
    );
  });

  test('list command shows registered plugins', () => {
    var output = tackle('list', PACKAGE_ROOT);
    // Should list the 23 registered plugins
    assert.ok(
      output.includes('skill-task-creator') || output.includes('Plugins') || output.includes('plugins'),
      'list shows plugins'
    );
  });
});
