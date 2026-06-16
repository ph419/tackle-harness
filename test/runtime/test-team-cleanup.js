/**
 * WP-179-2-test: Unit tests for team-cleanup runtime module
 *
 * Tests cover all 7 exports:
 * - validateTeamName      (pure name validation)
 * - resolveTeamPaths      (pure path resolution + baseOk)
 * - isPathSafe            (path traversal defense)
 * - markTeameeDestroyed   (pure in-memory teamee removal — WP-179 方案 A core)
 * - listTeamArtifacts     (read-only artifact inspection — exercised indirectly)
 * - cleanupTeam           (file-system writes + safety guards)
 * - TeamCleanupError      (programmer-error type)
 *
 * File-system tests inject a fresh mkdtempSync HOME via opts.homeDir so the
 * real ~/.claude is never touched. See test-cleanup-utils.js for conventions.
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var os = require('os');

var teamCleanup = require('../../plugins/runtime/team-cleanup');
var validateTeamName = teamCleanup.validateTeamName;
var resolveTeamPaths = teamCleanup.resolveTeamPaths;
var isPathSafe = teamCleanup.isPathSafe;
var markTeameeDestroyed = teamCleanup.markTeameeDestroyed;
var cleanupTeam = teamCleanup.cleanupTeam;
var TeamCleanupError = teamCleanup.TeamCleanupError;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh fake HOME tree containing the requested team directories.
 * Returns paths + cleanup function. Never touches the real ~/.claude.
 *
 * @param {object} spec
 *        - teams {string[]}       team dirs to create under .claude/teams/
 *        - tasks {string[]}       team dirs to create under .claude/tasks/
 *        - configs {Object}       map teamName -> config.json contents (teams side)
 */
function createFakeHome(spec) {
  spec = spec || {};
  var home = fs.mkdtempSync(path.join(os.tmpdir(), 'tackle-team-cleanup-'));
  var claudeDir = path.join(home, '.claude');
  var teamsDir = path.join(claudeDir, 'teams');
  var tasksDir = path.join(claudeDir, 'tasks');

  var teams = spec.teams || [];
  for (var i = 0; i < teams.length; i++) {
    fs.mkdirSync(path.join(teamsDir, teams[i]), { recursive: true });
  }
  var tasks = spec.tasks || [];
  for (var j = 0; j < tasks.length; j++) {
    fs.mkdirSync(path.join(tasksDir, tasks[j]), { recursive: true });
  }
  if (spec.configs) {
    Object.keys(spec.configs).forEach(function (name) {
      var dir = path.join(teamsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify(spec.configs[name]),
        'utf-8'
      );
    });
  }

  return {
    home: home,
    claudeDir: claudeDir,
    teamsDir: teamsDir,
    tasksDir: tasksDir,
    cleanup: function () {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// validateTeamName — pure validation
// ---------------------------------------------------------------------------

test.describe('validateTeamName', function () {

  test('accepts legal team names', function () {
    assert.deepStrictEqual(validateTeamName('batch-20260314-WP073'), { ok: true });
    assert.deepStrictEqual(validateTeamName('a'), { ok: true });
    assert.deepStrictEqual(validateTeamName('x_y-z'), { ok: true });
    assert.deepStrictEqual(validateTeamName('Team1'), { ok: true });
  });

  test('rejects illegal team names with correct reason', function () {
    assert.deepStrictEqual(validateTeamName(''), { ok: false, reason: 'empty' });
    assert.deepStrictEqual(validateTeamName('foo/bar'), { ok: false, reason: 'invalid_chars' });
    assert.deepStrictEqual(validateTeamName('..'), { ok: false, reason: 'invalid_chars' });
    assert.deepStrictEqual(validateTeamName('a b'), { ok: false, reason: 'invalid_chars' });
    // 65 chars (overrun of the 64-char cap).
    var tooLong = new Array(66).join('a');
    assert.deepStrictEqual(validateTeamName(tooLong), { ok: false, reason: 'too_long' });
    // Leading separator is its own actionable mistake.
    assert.deepStrictEqual(validateTeamName('-lead'), { ok: false, reason: 'invalid_chars' });
    assert.deepStrictEqual(validateTeamName('/lead'), { ok: false, reason: 'leading_separator' });
  });

});

// ---------------------------------------------------------------------------
// resolveTeamPaths — pure path resolution
// ---------------------------------------------------------------------------

test.describe('resolveTeamPaths', function () {

  test('returns correct paths and baseOk=true for a legal name', function () {
    var home = '/fake/home';
    var resolved = resolveTeamPaths('batch-20260314-WP073', { homeDir: home });

    assert.strictEqual(resolved.teamsDir, path.join(home, '.claude', 'teams'));
    assert.strictEqual(resolved.tasksDir, path.join(home, '.claude', 'tasks'));
    assert.strictEqual(resolved.teamPath, path.join(home, '.claude', 'teams', 'batch-20260314-WP073'));
    assert.strictEqual(resolved.tasksPath, path.join(home, '.claude', 'tasks', 'batch-20260314-WP073'));
    assert.strictEqual(resolved.baseOk, true);
  });

});

// ---------------------------------------------------------------------------
// isPathSafe — path traversal defense
// ---------------------------------------------------------------------------

test.describe('isPathSafe', function () {

  test('rejects path traversal and basename mismatches', function () {
    var teamsDir = path.join('/fake', 'home', '.claude', 'teams');

    // Legal resolved path is accepted.
    assert.strictEqual(
      isPathSafe(path.join(teamsDir, 'foo'), teamsDir, 'foo'),
      true
    );

    // Traversal attempt: basename escapes parent.
    assert.strictEqual(
      isPathSafe(path.join(teamsDir, '..', 'evil'), teamsDir, 'evil'),
      false
    );

    // Absolute-path drift: candidate lives outside the parent prefix.
    assert.strictEqual(
      isPathSafe(path.join('/other', 'place', 'foo'), teamsDir, 'foo'),
      false
    );

    // Prefix collision without separator: '/teams/fooX' must NOT be safe for 'foo'.
    assert.strictEqual(
      isPathSafe(teamsDir + 'X' + path.sep + 'foo', teamsDir, 'foo'),
      false
    );
  });

});

// ---------------------------------------------------------------------------
// markTeameeDestroyed — pure in-memory primitive (WP-179 方案 A core)
// ---------------------------------------------------------------------------

test.describe('markTeameeDestroyed', function () {

  test('removes an existing task and returns its teameeName', function () {
    var teameeMap = { '#1': 'impl-t1' };
    var result = markTeameeDestroyed(teameeMap, '#1');

    assert.deepStrictEqual(result, { removed: true, teameeName: 'impl-t1' });
    assert.deepStrictEqual(teameeMap, {});
  });

  test('returns removed:false for a missing task without throwing', function () {
    var teameeMap = {};
    var result = markTeameeDestroyed(teameeMap, '#99');

    assert.deepStrictEqual(result, { removed: false });
    // Map is untouched.
    assert.deepStrictEqual(teameeMap, {});
  });

});

// ---------------------------------------------------------------------------
// cleanupTeam — file-system behaviour (injected temporary HOME)
// ---------------------------------------------------------------------------

test.describe('cleanupTeam', function () {

  test('returns skipped for a team that does not exist', function () {
    var home = createFakeHome({});
    try {
      var result = cleanupTeam('nope', { homeDir: home.home });
      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.teamsDeleted, 0);
      assert.strictEqual(result.tasksDeleted, 0);
      assert.deepStrictEqual(result.errors, []);
      // HOME tree must be untouched (no stray dirs created).
      assert.strictEqual(fs.existsSync(path.join(home.teamsDir, 'nope')), false);
      assert.strictEqual(fs.existsSync(path.join(home.tasksDir, 'nope')), false);
    } finally {
      home.cleanup();
    }
  });

  test('deletes both teams/ and tasks/ directories for a team', function () {
    var home = createFakeHome({ teams: ['foo'], tasks: ['foo'] });
    try {
      var result = cleanupTeam('foo', { homeDir: home.home });
      assert.strictEqual(result.teamsDeleted, 1);
      assert.strictEqual(result.tasksDeleted, 1);
      assert.strictEqual(result.skipped, false);
      assert.deepStrictEqual(result.errors, []);
      assert.strictEqual(fs.existsSync(path.join(home.teamsDir, 'foo')), false);
      assert.strictEqual(fs.existsSync(path.join(home.tasksDir, 'foo')), false);
    } finally {
      home.cleanup();
    }
  });

  test('deletes only teams/ when tasks/ is absent', function () {
    var home = createFakeHome({ teams: ['foo'] });
    try {
      var result = cleanupTeam('foo', { homeDir: home.home });
      assert.strictEqual(result.teamsDeleted, 1);
      assert.strictEqual(result.tasksDeleted, 0);
      assert.strictEqual(result.skipped, false);
      assert.deepStrictEqual(result.errors, []);
      assert.strictEqual(fs.existsSync(path.join(home.teamsDir, 'foo')), false);
    } finally {
      home.cleanup();
    }
  });

  test('dryRun reports wouldDelete without touching the filesystem', function () {
    var home = createFakeHome({ teams: ['foo'] });
    try {
      var result = cleanupTeam('foo', { homeDir: home.home, dryRun: true });
      assert.strictEqual(result.teamsDeleted, 0);
      assert.strictEqual(result.tasksDeleted, 0);
      assert.ok(Array.isArray(result.wouldDelete));
      assert.strictEqual(result.wouldDelete.length, 1);
      assert.strictEqual(result.wouldDelete[0], path.join(home.teamsDir, 'foo'));
      // Team dir must still be present.
      assert.strictEqual(fs.existsSync(path.join(home.teamsDir, 'foo')), true);
    } finally {
      home.cleanup();
    }
  });

  test('throws TeamCleanupError(code=invalid_name) for an illegal team name', function () {
    assert.throws(
      function () { cleanupTeam('../evil', { homeDir: '/tmp' }); },
      function (err) {
        return err instanceof TeamCleanupError &&
               err.name === 'TeamCleanupError' &&
               err.code === 'invalid_name';
      }
    );
  });

  test('throws TeamCleanupError(code=unsafe_path) when the resolved path is unsafe', function () {
    // The implementation guards both invalid_name (charset) and unsafe_path
    // (baseOk). A charset-legal name always yields basename === teamName under
    // path.join, so baseOk is true for any normal homeDir. The unsafe_path
    // branch is therefore only reachable via injection: we temporarily monkey-
    // patch path.basename so the guard's basename equality check fails, which
    // is exactly the "basename not matching" scenario the doc names. The
    // module captured `path` at require time and calls path.basename live, so
    // patching the shared module object reaches the guard deterministically.
    var origBasename = path.basename;
    path.basename = function () { return 'tampered'; };
    try {
      assert.throws(
        function () { cleanupTeam('legit-team', { homeDir: '/fake/home' }); },
        function (err) {
          return err instanceof TeamCleanupError &&
                 err.name === 'TeamCleanupError' &&
                 err.code === 'unsafe_path';
        }
      );
    } finally {
      path.basename = origBasename;
    }

    // Contract: the error type itself carries the documented code/name.
    var typed = new TeamCleanupError(' Unsafe ', 'unsafe_path');
    assert.ok(typed instanceof Error);
    assert.strictEqual(typed.code, 'unsafe_path');
    assert.strictEqual(typed.name, 'TeamCleanupError');
  });

  test('force=false refuses a fresh (<5min) active team; force=true deletes it', function () {
    var freshConfig = { createdAt: new Date().toISOString(), status: 'active' };

    // Refused branch.
    var home1 = createFakeHome({ configs: { foo: freshConfig }, tasks: ['foo'] });
    try {
      var refused = cleanupTeam('foo', { homeDir: home1.home });
      assert.strictEqual(refused.skipped, false);
      assert.strictEqual(refused.teamsDeleted, 0);
      assert.strictEqual(refused.tasksDeleted, 0);
      assert.ok(Array.isArray(refused.errors));
      assert.strictEqual(refused.errors.length, 1);
      assert.strictEqual(refused.errors[0].kind, 'fresh_active_team');
      // Both dirs must survive the refusal.
      assert.strictEqual(fs.existsSync(path.join(home1.teamsDir, 'foo')), true);
      assert.strictEqual(fs.existsSync(path.join(home1.tasksDir, 'foo')), true);
    } finally {
      home1.cleanup();
    }

    // Forced branch: same fresh config, force bypasses the guard.
    var home2 = createFakeHome({ configs: { foo: freshConfig }, tasks: ['foo'] });
    try {
      var forced = cleanupTeam('foo', { homeDir: home2.home, force: true });
      assert.strictEqual(forced.teamsDeleted, 1);
      assert.strictEqual(forced.tasksDeleted, 1);
      assert.deepStrictEqual(forced.errors, []);
      assert.strictEqual(fs.existsSync(path.join(home2.teamsDir, 'foo')), false);
      assert.strictEqual(fs.existsSync(path.join(home2.tasksDir, 'foo')), false);
    } finally {
      home2.cleanup();
    }
  });

  test('collects fs.rmSync failures into errors[] instead of throwing', function () {
    var home = createFakeHome({ teams: ['foo'] });
    try {
      // Monkey-patch fs.rmSync to simulate a transient failure. The module
      // captures fs at require time, so we patch the same fs object.
      var origRmSync = fs.rmSync;
      var calls = 0;
      fs.rmSync = function (target, opts) {
        calls++;
        var err = new Error('simulated rm failure: permission denied');
        err.code = 'EACCES';
        throw err;
      };
      try {
        var result = cleanupTeam('foo', { homeDir: home.home });
        assert.ok(Array.isArray(result.errors));
        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual(result.errors[0].kind, 'rm_failed');
        assert.strictEqual(result.errors[0].path, path.join(home.teamsDir, 'foo'));
        assert.ok(result.errors[0].message.indexOf('simulated rm failure') !== -1);
        // Did not throw; attempted the removal.
        assert.strictEqual(calls, 1);
      } finally {
        fs.rmSync = origRmSync;
      }
    } finally {
      home.cleanup();
    }
  });

});
