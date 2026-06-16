'use strict';

var cleanup = require('../../plugins/runtime/team-cleanup');
var TeamCleanupError = cleanup.TeamCleanupError;

/**
 * team-cleanup command - Deterministically remove an agent team's
 * teams/ and tasks/ directories (cross-platform + safety-checked).
 *
 * Usage:
 *   node bin/tackle.js team-cleanup <team_name> [--dry-run] [--force]
 *
 * Advantages over the old `rm -rf $HOME/...` pseudo-code:
 *   - Cross-platform fs.rmSync (no shell-quoting hazards, works on Windows)
 *   - Bypasses the harness Bash permission system (no settings.json entry)
 *   - Validates team name charset + path-traversal guards before any write
 *
 * @public
 */
module.exports = {
  name: 'team-cleanup',
  description: '确定性地移除 agent team 的 teams/ 和 tasks/ 目录（跨平台 + 安全校验）',
  aliases: ['team-cleanup'],
  /**
   * Execute the team-cleanup command.
   *
   * Parses process.argv directly (ctx.flags does not expose positional
   * args), separating the first positional team_name from --dry-run / --force.
   *
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    var rawArgs = process.argv.slice(2);
    var teamName = null;
    var dryRun = false;
    var force = false;

    // ctx.command is the command name already resolved by bin/tackle.js
    // (e.g. 'team-cleanup'). Skip the first occurrence of it so the command
    // name itself isn't mistaken for the team_name positional argument.
    var commandName = ctx.command || 'team-cleanup';
    var commandSkipped = false;

    for (var i = 0; i < rawArgs.length; i++) {
      var arg = rawArgs[i];
      if (arg === '--dry-run') {
        dryRun = true;
      } else if (arg === '--force') {
        force = true;
      } else if (arg.indexOf('--') === 0) {
        // Skip other global flags (--root, --no-color, --verbose, ...) already
        // consumed by bin/tackle.js. Their values, when present, also start
        // with non-dash so we'd capture them as teamName below unless skipped.
        // If --root took a value, that value is already removed from argv by
        // tackle.js's index bumping, so no extra handling is needed here.
        continue;
      } else if (!commandSkipped && arg === commandName) {
        // First positional matching the command name is the command itself.
        commandSkipped = true;
      } else if (teamName === null) {
        teamName = arg;
      }
      // Additional positional args beyond the team name are ignored.
    }

    console.log(ctx.colorize('[tackle-harness] team-cleanup', 'cyan'));
    console.log('');

    // 1. Validate input.
    var validation = cleanup.validateTeamName(teamName);
    if (!validation.ok) {
      var reasonText = validation.reason || 'invalid';
      console.error(ctx.colorize('Error: invalid team name "' + (teamName === null ? '' : teamName) + '" (' + reasonText + ')', 'red'));
      console.error('Team names must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/ and must not contain path separators.');
      console.error('');
      console.error('Usage: node bin/tackle.js team-cleanup <team_name> [--dry-run] [--force]');
      ctx.exit(1);
      return;
    }

    console.log('Team:    ' + ctx.colorize(teamName, 'green'));
    if (dryRun) console.log('Mode:    ' + ctx.colorize('dry-run (no changes)', 'yellow'));
    if (force) console.log('Force:   ' + ctx.colorize('yes (fresh-active guard skipped)', 'yellow'));
    console.log('');

    // 2. Run cleanup. Production CLI does not pass teamDeleteFn.
    var result;
    try {
      result = cleanup.cleanupTeam(teamName, {
        dryRun: dryRun,
        force: force,
        log: function (msg) {
          console.log('  ' + ctx.colorize(msg, 'dim'));
        },
      });
    } catch (e) {
      if (e instanceof TeamCleanupError || (e && e.name === 'TeamCleanupError')) {
        console.error(ctx.colorize('Error: ' + e.message + ' [code: ' + e.code + ']', 'red'));
        ctx.exit(1);
        return;
      }
      throw e;
    }

    // 3. Print stylized result.
    if (result.skipped) {
      console.log(ctx.colorize('No team artifacts found — nothing to clean.', 'dim'));
      ctx.exit(0);
      return;
    }

    if (dryRun && result.wouldDelete && result.wouldDelete.length > 0) {
      console.log(ctx.colorize('Dry run — would delete:', 'cyan'));
      for (var w = 0; w < result.wouldDelete.length; w++) {
        console.log('  - ' + result.wouldDelete[w]);
      }
      ctx.exit(0);
      return;
    }

    // Fresh-active-team guard refused (non-force run).
    var guardError = findErrorKind(result.errors, 'fresh_active_team');
    if (guardError) {
      console.warn(ctx.colorize('Refused: ' + guardError.message, 'yellow'));
      console.warn('Pass --force to override.');
      ctx.exit(1);
      return;
    }

    var total = result.teamsDeleted + result.tasksDeleted;
    var attempted = (result.teamsDeleted + result.tasksDeleted + result.errors.length);
    if (attempted > 0 && result.errors.length === 0) {
      // Full success.
      console.log(ctx.colorize('Deleted ' + total + ' path(s) for team "' + teamName + '".', 'green'));
      ctx.exit(0);
      return;
    }

    if (result.errors.length > 0 && total > 0) {
      // Partial success.
      console.warn(ctx.colorize('Partially cleaned: ' + total + ' path(s) deleted, ' + result.errors.length + ' error(s).', 'yellow'));
      printErrors(ctx, result.errors);
      ctx.exit(0);
      return;
    }

    // All attempts failed.
    if (result.errors.length > 0) {
      console.error(ctx.colorize('Failed to clean team "' + teamName + '": ' + result.errors.length + ' error(s).', 'red'));
      printErrors(ctx, result.errors);
      ctx.exit(1);
      return;
    }

    // Defensive: no deletion, no error, not skipped/dry-run (shouldn't happen).
    console.warn(ctx.colorize('Completed with no changes.', 'yellow'));
    ctx.exit(0);
  },
};

/**
 * Find the first error descriptor matching a kind. Internal helper.
 *
 * @private
 * @param {Array} errors - result.errors[]
 * @param {string} kind
 * @returns {object|null}
 */
function findErrorKind(errors, kind) {
  if (!errors) return null;
  for (var i = 0; i < errors.length; i++) {
    if (errors[i] && errors[i].kind === kind) return errors[i];
  }
  return null;
}

/**
 * Print each error descriptor on its own red line. Internal helper.
 *
 * @private
 * @param {object} ctx
 * @param {Array} errors
 */
function printErrors(ctx, errors) {
  for (var i = 0; i < errors.length; i++) {
    var e = errors[i];
    console.error('  ' + ctx.colorize('[' + (e.kind || 'error') + '] ' + e.path + ': ' + e.message, 'red'));
  }
}
