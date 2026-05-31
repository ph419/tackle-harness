#!/usr/bin/env node
/**
 * Cross-platform test runner for Tackle Harness.
 *
 * Discovers test files using Node.js fs module instead of relying on shell
 * glob expansion, which behaves differently across platforms (bash, cmd.exe,
 * PowerShell, sh/dash).
 *
 * Usage:
 *   node scripts/test-runner.js                # run all tests under test/
 *   node scripts/test-runner.js test/runtime   # run only runtime tests
 *   node scripts/test-runner.js test/e2e       # run only e2e tests
 *
 * Coverage:
 *   node --experimental-test-coverage scripts/test-runner.js
 *
 * The runner forwards --experimental-* flags from process.execArgv to the
 * child process so coverage instrumentation works correctly.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively find all .js files under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function findTestFiles(dir) {
  var results = [];
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

var testDir = process.argv[2]
  ? path.resolve(__dirname, '..', process.argv[2])
  : path.resolve(__dirname, '..', 'test');

if (!fs.existsSync(testDir)) {
  console.error('Test directory not found: ' + testDir);
  process.exit(1);
}

var files = findTestFiles(testDir);

if (files.length === 0) {
  console.error('No test files found in ' + testDir);
  process.exit(1);
}

// Forward --experimental-* flags (e.g. --experimental-test-coverage)
// from the parent process to the child process.
var nodeFlags = process.execArgv.filter(function (f) {
  return f.startsWith('--experimental-');
});

try {
  cp.execFileSync(
    process.execPath,
    nodeFlags.concat(['--test']).concat(files),
    {
      stdio: 'inherit',
      env: process.env,
    }
  );
} catch (e) {
  process.exitCode = e.status || 1;
}
