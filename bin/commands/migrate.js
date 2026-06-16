'use strict';

var path = require('path');
var fs = require('fs');
var cleanupUtils = require('../../plugins/runtime/cleanup-utils');

/**
 * Migrate command - Migrate legacy project structure to global setup
 * @public
 */
module.exports = {
  name: 'migrate',
  description: 'Migrate legacy project structure to global setup',
  /**
   * Execute the migrate command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log(ctx.colorize('[tackle-harness] Migrating legacy project structure...', 'cyan'));
    console.log('[tackle-harness] Target project: ' + ctx.targetRoot);
    console.log('');

    var hasLegacyStructure = false;
    var cleanupActions = [];

    // 1. Detect and clean up legacy project-level hooks registration
    var settingsPath = ctx.settingsPath;
    if (fs.existsSync(settingsPath)) {
      try {
        var settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        var result = cleanupUtils.cleanupSettingsHooks(settings);

        if (result.hadProjectHooks) {
          fs.writeFileSync(settingsPath, JSON.stringify(result.settings, null, 2) + '\n', 'utf-8');
          console.log(ctx.colorize('[tackle-harness] Removed project-level hooks from settings.json', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed project-level hooks');
        }
      } catch (err) {
        // Expected degradation: user's settings.json may be malformed/unreadable.
        // Hook cleanup is optional (best-effort); do not surface as Error-level noise.
        if (ctx.flags.verbose) {
          console.warn('[tackle-harness] (degraded) Skipped project-level hooks cleanup: ' + err.message);
        }
      }
    }

    // 2. Detect and clean up legacy project-level skills
    var projectSkillsDir = path.join(ctx.targetRoot, '.claude', 'skills');
    if (fs.existsSync(projectSkillsDir)) {
      try {
        var removedSkills = cleanupUtils.cleanupProjectSkills(projectSkillsDir, ctx.registryPath, ctx.packageRoot);

        if (removedSkills.length > 0) {
          console.log(ctx.colorize('[tackle-harness] Removed ' + removedSkills.length + ' project-level skills (now available globally)', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed ' + removedSkills.length + ' project-level skills');

          cleanupUtils.removeEmptyDir(projectSkillsDir);
          if (!fs.existsSync(projectSkillsDir)) {
            console.log('[tackle-harness] Removed empty .claude/skills/ directory');
          }
        }
      } catch (err) {
        // Expected degradation: legacy skills cleanup is best-effort and optional.
        if (ctx.flags.verbose) {
          console.warn('[tackle-harness] (degraded) Skipped project-level skills cleanup: ' + err.message);
        }
      }
    }

    // 3. Detect and clean up legacy project-level hooks
    var projectHooksDir = path.join(ctx.targetRoot, '.claude', 'hooks');
    if (fs.existsSync(projectHooksDir)) {
      try {
        var removedHooks = cleanupUtils.cleanupProjectHooks(projectHooksDir, ctx.registryPath, ctx.packageRoot);

        if (removedHooks.length > 0) {
          console.log(ctx.colorize('[tackle-harness] Removed ' + removedHooks.length + ' project-level hooks (now available globally)', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed ' + removedHooks.length + ' project-level hooks');

          cleanupUtils.removeEmptyDir(projectHooksDir);
          if (!fs.existsSync(projectHooksDir)) {
            console.log('[tackle-harness] Removed empty .claude/hooks/ directory');
          }
        }
      } catch (err) {
        // Expected degradation: legacy hooks dir cleanup is best-effort and optional.
        if (ctx.flags.verbose) {
          console.warn('[tackle-harness] (degraded) Skipped project-level hooks dir cleanup: ' + err.message);
        }
      }
    }

    // 4. Inject CLAUDE.md plan-mode rules
    var builder = ctx.createBuilder();
    builder.injectClaudeMdRules(ctx.targetRoot);

    // 5. Print migration summary
    if (!hasLegacyStructure) {
      console.log(ctx.colorize('[tackle-harness] No legacy structure found. Project is already using global setup.', 'green'));
    } else {
      console.log('');
      console.log(ctx.colorize('[tackle-harness] === Migration Complete ===', 'cyan'));
      console.log('');
      for (var q = 0; q < cleanupActions.length; q++) {
        console.log('  - ' + cleanupActions[q]);
      }
      console.log('');
      console.log(ctx.colorize('[tackle-harness] All tackle-harness skills and hooks are now available globally.', 'green'));
      console.log(ctx.colorize('[tackle-harness] Your project only needs configuration files to use them.', 'green'));
      console.log('');
    }

    console.log(ctx.colorize('[tackle-harness] Done! Your project is ready to use tackle-harness.', 'green'));
    ctx.exit(0);
  },
};
