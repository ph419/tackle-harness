/**
 * team-cleanup - Deterministic agent-team directory removal
 *
 * WP-179 方案 A 的基石：用确定性的「逻辑销毁 + 批末目录清理」替代被 harness
 * 拦截的 shutdown 协议帧通道。本模块提供跨平台、带安全校验、可单元测试的
 * team 目录清理能力，让 skill.md 的「批末清理」只需调一行 CLI。
 *
 * 设计约束：
 * - markTeameeDestroyed 是纯内存原语（无 SendMessage、无文件系统），由调用者
 *   持有的 teameeMap 注入，避免任何 harness 工具协议帧拦截。
 * - cleanupTeam 的删除逻辑全部经 opts.homeDir 注入，绝不硬编码 os.homedir()
 *   写入，保证测试与生产隔离（生产 CLI 才默认 os.homedir()）。
 * - 不重用 cleanup-utils.removeEmptyDir：team 目录非空（含 config.json/members）。
 *
 * @module team-cleanup
 */

'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * TeamCleanupError - raised for programmer errors (invalid input / unsafe path).
 *
 * Runtime file-system failures are collected into result.errors[] instead,
 * so a single unreadable config.json or locked file never aborts a whole
 * team cleanup.
 *
 * @public
 * @param {string} message - Human-readable error detail
 * @param {string} code    - 'invalid_name' | 'unsafe_path' | 'config_read_failed'
 */
function TeamCleanupError(message, code) {
  Error.call(this, message);
  this.name = 'TeamCleanupError';
  this.message = message;
  this.code = code;
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, TeamCleanupError);
  }
}

// Node-compatible Error inheritance (works on older + modern engines).
TeamCleanupError.prototype = Object.create(Error.prototype);
TeamCleanupError.prototype.constructor = TeamCleanupError;

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/**
 * Validate a team name against a safe charset + length policy.
 *
 * Accepts: leading alnum then alnum/underscore/dash, 1-64 chars total.
 * Explicitly rejects '.', '..', '', and any path separator (/ \ :).
 *
 * @public
 * @param {string} name - Candidate team name
 * @returns {{ok:true} | {ok:false, reason:'empty'|'invalid_chars'|'too_long'|'leading_separator'}}
 */
function validateTeamName(name) {
  if (name === undefined || name === null || name === '') {
    return { ok: false, reason: 'empty' };
  }
  if (typeof name !== 'string') {
    return { ok: false, reason: 'invalid_chars' };
  }
  if (name === '.' || name === '..') {
    return { ok: false, reason: 'invalid_chars' };
  }
  if (name.length > 64) {
    return { ok: false, reason: 'too_long' };
  }
  // Reject anything containing a path separator or drive colon.
  if (/[\/\\:]/.test(name)) {
    // A leading separator on its own is a distinct, actionable user mistake.
    if (/^[\/\\]/.test(name)) {
      return { ok: false, reason: 'leading_separator' };
    }
    return { ok: false, reason: 'invalid_chars' };
  }
  // Anchored charset check: leading alnum, body alnum/_/-.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return { ok: false, reason: 'invalid_chars' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Check that a resolved path is safely contained under a parent directory
 * and that its basename matches the expected team name.
 *
 * Defends against path traversal ('..') and absolute-path drift by requiring
 * the parent prefix match (including a trailing separator, so '/foo' does not
 * count as safe under '/foobar') AND a basename equality.
 *
 * @public
 * @param {string} resolvedPath - Fully resolved candidate path
 * @param {string} parentDir    - Required parent directory (no trailing sep)
 * @param {string} teamName     - Required basename
 * @returns {boolean}
 */
function isPathSafe(resolvedPath, parentDir, teamName) {
  if (typeof resolvedPath !== 'string' || typeof parentDir !== 'string' || typeof teamName !== 'string') {
    return false;
  }
  var prefix = parentDir + path.sep;
  return resolvedPath.indexOf(prefix) === 0 && path.basename(resolvedPath) === teamName;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk locations of a team's teams/ and tasks/ directories.
 *
 * Pure function: performs no file-system access. homeDir/claudeDir default
 * to os.homedir() / '.claude' but callers (tests, CLI with --root) inject
 * explicit values to avoid touching the real ~/.claude.
 *
 * @public
 * @param {string} teamName            - Already-validated team name
 * @param {object} [opts]
 * @param {string} [opts.homeDir]      - Defaults to os.homedir()
 * @param {string} [opts.claudeDir]    - Defaults to '.claude'
 * @returns {{teamsDir,tasksDir,teamPath,tasksPath,baseOk}}
 */
function resolveTeamPaths(teamName, opts) {
  opts = opts || {};
  var homeDir = opts.homeDir || os.homedir();
  var claudeDir = opts.claudeDir || '.claude';

  var teamsDir = path.join(homeDir, claudeDir, 'teams');
  var tasksDir = path.join(homeDir, claudeDir, 'tasks');
  var teamPath = path.join(teamsDir, teamName);
  var tasksPath = path.join(tasksDir, teamName);

  var baseOk = isPathSafe(teamPath, teamsDir, teamName) &&
               isPathSafe(tasksPath, tasksDir, teamName) &&
               path.basename(teamPath) === teamName &&
               path.basename(tasksPath) === teamName;

  return {
    teamsDir: teamsDir,
    tasksDir: tasksDir,
    teamPath: teamPath,
    tasksPath: tasksPath,
    baseOk: baseOk,
  };
}

// ---------------------------------------------------------------------------
// Logical destruction (core primitive)
// ---------------------------------------------------------------------------

/**
 * Mark a teamee as destroyed by removing its taskId from the caller's map.
 *
 * This is the WP-179 方案 A core primitive: a pure in-memory operation that
 * replaces the harness-blocked shutdown_request protocol frame. No SendMessage,
 * no Agent call, no file-system access. The in-process member process ends
 * naturally with the session; the caller's map is the only source of truth.
 *
 * Mutates teameeMap in place (delete is the whole operation).
 *
 * @public
 * @param {object} teameeMap - Caller-owned { taskId: teameeName } map
 * @param {string} taskId    - Task id whose mapping should be dropped
 * @returns {{removed:true, teameeName:string} | {removed:false}}
 */
function markTeameeDestroyed(teameeMap, taskId) {
  if (!teameeMap || !Object.prototype.hasOwnProperty.call(teameeMap, taskId)) {
    return { removed: false };
  }
  var teameeName = teameeMap[taskId];
  delete teameeMap[taskId];
  return { removed: true, teameeName: teameeName };
}

// ---------------------------------------------------------------------------
// Read-only artifact inspection
// ---------------------------------------------------------------------------

/**
 * List the artifacts (directories + members) that exist for a team.
 *
 * Read-only: never deletes anything. Tries to read config.json for member
 * names; a missing/unreadable config is recorded in errors[] but does not
 * throw (the team dir may exist with no config, or config may be locked).
 *
 * @public
 * @param {string} teamName - Team name (validated here)
 * @param {object} [opts]   - Forwarded to resolveTeamPaths ({homeDir,claudeDir})
 * @returns {{teamsExists,tasksExists,members,errors:[]}}
 * @throws {TeamCleanupError} when teamName is invalid or path is unsafe
 */
function listTeamArtifacts(teamName, opts) {
  var validation = validateTeamName(teamName);
  if (!validation.ok) {
    throw new TeamCleanupError('Invalid team name: ' + teamName, 'invalid_name');
  }
  var paths = resolveTeamPaths(teamName, opts);
  if (!paths.baseOk) {
    throw new TeamCleanupError('Unsafe resolved path for team: ' + teamName, 'unsafe_path');
  }

  var members = null;
  var errors = [];

  var teamsExists = fs.existsSync(paths.teamPath);
  var tasksExists = fs.existsSync(paths.tasksPath);

  if (teamsExists) {
    var configPath = path.join(paths.teamPath, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        var raw = fs.readFileSync(configPath, 'utf-8');
        var config = JSON.parse(raw);
        if (config && Array.isArray(config.members)) {
          members = config.members;
        } else {
          members = [];
        }
      } catch (e) {
        // Unreadable/invalid config is non-fatal: still report existence.
        members = null;
        errors.push({ kind: 'config_read_failed', path: configPath, message: e.message });
      }
    }
  }

  return {
    teamsExists: teamsExists,
    tasksExists: tasksExists,
    members: members,
    errors: errors,
  };
}

// ---------------------------------------------------------------------------
// Cleanup (file-system writes)
// ---------------------------------------------------------------------------

/**
 * Remove a team's teams/ and tasks/ directories with safety checks.
 *
 * Algorithm (see WP-179-1-impl-a.md):
 *   1. validateTeamName -> TeamCleanupError('invalid_name')
 *   2. resolveTeamPaths + baseOk -> TeamCleanupError('unsafe_path')
 *   3. Neither dir exists -> { skipped: true }
 *   4. dryRun -> { wouldDelete: [existing paths] } (no fs writes)
 *   5. force:false + config shows active team created <5min ago -> refuse
 *   6. Optional teamDeleteFn (test injection; CLI omits)
 *   7. fs.rmSync(target, {recursive,force,maxRetries:3,retryDelay:100})
 *      per directory; single-dir failures go to errors[]
 *   8. Verify each path no longer exists
 *
 * @public
 * @param {string} teamName
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]          - Report only, delete nothing
 * @param {boolean} [opts.force=false]           - Skip the fresh-team guard
 * @param {string}  [opts.homeDir]               - Override ~/.claude root
 * @param {function} [opts.log]                  - Progress logger (no-op default)
 * @param {function} [opts.teamDeleteFn]         - Test injection hook
 * @returns {{teamsDeleted,tasksDeleted,skipped,wouldDelete,errors,teamDeleteAttempted,teamDeleteSucceeded}}
 * @throws {TeamCleanupError} for invalid name / unsafe path only
 */
function cleanupTeam(teamName, opts) {
  opts = opts || {};
  var dryRun = opts.dryRun === true;
  var force = opts.force === true;
  var log = typeof opts.log === 'function' ? opts.log : function () {};

  var validation = validateTeamName(teamName);
  if (!validation.ok) {
    throw new TeamCleanupError('Invalid team name: ' + teamName + ' (' + validation.reason + ')', 'invalid_name');
  }
  var paths = resolveTeamPaths(teamName, opts);
  if (!paths.baseOk) {
    throw new TeamCleanupError('Unsafe resolved path for team: ' + teamName, 'unsafe_path');
  }

  var teamsExists = fs.existsSync(paths.teamPath);
  var tasksExists = fs.existsSync(paths.tasksPath);

  // 3. Nothing to clean.
  if (!teamsExists && !tasksExists) {
    log('No team artifacts found for "' + teamName + '"');
    return {
      teamsDeleted: 0,
      tasksDeleted: 0,
      skipped: true,
      wouldDelete: [],
      errors: [],
      teamDeleteAttempted: false,
      teamDeleteSucceeded: false,
    };
  }

  // 4. Dry run reports candidates only.
  if (dryRun) {
    var wouldDelete = [];
    if (teamsExists) wouldDelete.push(paths.teamPath);
    if (tasksExists) wouldDelete.push(paths.tasksPath);
    log('Dry run: would delete ' + wouldDelete.length + ' path(s)');
    return {
      teamsDeleted: 0,
      tasksDeleted: 0,
      skipped: false,
      wouldDelete: wouldDelete,
      errors: [],
      teamDeleteAttempted: false,
      teamDeleteSucceeded: false,
    };
  }

  // 5. Fresh-team guard: refuse to nuke a team whose config.json reports an
  //    active status and was created within the last 5 minutes unless --force.
  //    Prevents a stale-dispatch race from wiping a freshly-booted team.
  if (!force) {
    var guard = checkFreshActiveTeam(paths.teamPath);
    if (guard.blocked) {
      return {
        teamsDeleted: 0,
        tasksDeleted: 0,
        skipped: false,
        wouldDelete: [],
        errors: [{
          kind: 'fresh_active_team',
          path: paths.teamPath,
          message: guard.reason,
        }],
        teamDeleteAttempted: false,
        teamDeleteSucceeded: false,
      };
    }
  }

  // 6. Optional injected team-delete hook (tests only; CLI never passes it).
  var teamDeleteAttempted = false;
  var teamDeleteSucceeded = false;
  if (typeof opts.teamDeleteFn === 'function') {
    teamDeleteAttempted = true;
    try {
      var fnResult = opts.teamDeleteFn(teamName, paths);
      teamDeleteSucceeded = fnResult !== false;
    } catch (e) {
      // Hook failure is non-fatal; fall through to file-system deletion.
      log('teamDeleteFn threw: ' + e.message);
    }
  }

  // 7. File-system removal, per target, collecting failures into errors[].
  var errors = [];
  var teamsDeleted = 0;
  var tasksDeleted = 0;

  if (teamsExists) {
    var tErr = removeOne(paths.teamPath, log);
    if (tErr) {
      errors.push(tErr);
    } else if (!fs.existsSync(paths.teamPath)) {
      teamsDeleted = 1;
    } else {
      errors.push({
        kind: 'still_exists',
        path: paths.teamPath,
        message: 'rmSync completed but path still exists',
      });
    }
  }

  if (tasksExists) {
    var sErr = removeOne(paths.tasksPath, log);
    if (sErr) {
      errors.push(sErr);
    } else if (!fs.existsSync(paths.tasksPath)) {
      tasksDeleted = 1;
    } else {
      errors.push({
        kind: 'still_exists',
        path: paths.tasksPath,
        message: 'rmSync completed but path still exists',
      });
    }
  }

  return {
    teamsDeleted: teamsDeleted,
    tasksDeleted: tasksDeleted,
    skipped: false,
    wouldDelete: [],
    errors: errors,
    teamDeleteAttempted: teamDeleteAttempted,
    teamDeleteSucceeded: teamDeleteSucceeded,
  };
}

/**
 * Remove a single target directory, returning null on success or an error
 * descriptor on failure. Internal helper, not exported.
 *
 * @private
 * @param {string} target - Directory path to remove
 * @param {function} log  - Progress logger
 * @returns {null | {kind,path,message}}
 */
function removeOne(target, log) {
  try {
    log('Removing ' + target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return null;
  } catch (e) {
    return { kind: 'rm_failed', path: target, message: e.message };
  }
}

/**
 * Fresh-active-team guard. Internal helper.
 *
 * Blocks deletion when config.json is readable, reports status 'active'
 * (or omits status), and the team directory's ctime is within 5 minutes.
 * Unreadable/missing config or older teams never block.
 *
 * @private
 * @param {string} teamPath
 * @returns {{blocked:boolean, reason?:string}}
 */
function checkFreshActiveTeam(teamPath) {
  var configPath = path.join(teamPath, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { blocked: false };
  }
  var config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    return { blocked: false };
  }
  if (!config) {
    return { blocked: false };
  }
  // Only guard teams that look active. status absent is treated conservatively
  // as active (we can't prove it's done).
  var status = config.status;
  if (status && status !== 'active') {
    return { blocked: false };
  }
  var dirStat;
  try {
    dirStat = fs.statSync(teamPath);
  } catch (e) {
    return { blocked: false };
  }
  // Prefer config.createdAt if present; fall back to directory ctime.
  var createdMs = dirStat.ctimeMs;
  if (config.createdAt && typeof config.createdAt === 'string') {
    var parsed = Date.parse(config.createdAt);
    if (!isNaN(parsed)) {
      createdMs = parsed;
    }
  }
  var ageMs = Date.now() - createdMs;
  if (ageMs < 5 * 60 * 1000) {
    return {
      blocked: true,
      reason: 'Team "' + path.basename(teamPath) + '" appears active and was created less than 5 minutes ago; pass --force to override.',
    };
  }
  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  TeamCleanupError: TeamCleanupError,
  validateTeamName: validateTeamName,
  resolveTeamPaths: resolveTeamPaths,
  isPathSafe: isPathSafe,
  markTeameeDestroyed: markTeameeDestroyed,
  listTeamArtifacts: listTeamArtifacts,
  cleanupTeam: cleanupTeam,
};
