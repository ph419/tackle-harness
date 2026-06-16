'use strict';

var path = require('path');
var fs = require('fs');
var cleanupUtils = require('../../plugins/runtime/cleanup-utils');

/**
 * Init command - First-time setup: build + generate default config
 * @public
 */
module.exports = {
  name: 'init',
  description: 'First-time setup (build + config)',
  /**
   * Execute the init command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log('[tackle-harness] Initializing...');
    console.log('[tackle-harness] Target project: ' + ctx.targetRoot);
    console.log('[tackle-harness] Package root:   ' + ctx.packageRoot);
    console.log('');

    var hasLegacyStructure = false;
    var cleanupActions = [];

    // 1. Ensure .claude/ directory exists
    var claudeDir = path.join(ctx.targetRoot, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      console.log('[tackle-harness] Created .claude/ directory');
    }

    // 2. Ensure .claude/config/ directory exists
    var configDir = ctx.configDir;
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
      console.log('[tackle-harness] Created .claude/config/ directory');
    }

    // 3. Copy harness-config.yaml template if not exists
    var targetConfigPath = path.join(configDir, 'harness-config.yaml');
    var templatePath = path.join(ctx.packageRoot, 'templates', 'harness-config.yaml');

    if (!fs.existsSync(targetConfigPath)) {
      try {
        var content = fs.readFileSync(templatePath, 'utf-8');
        fs.writeFileSync(targetConfigPath, content, 'utf-8');
        console.log('[tackle-harness] Created harness-config.yaml');
      } catch (err) {
        console.error('[tackle-harness] Warning: Failed to copy harness-config.yaml template');
        console.error('[tackle-harness] Error: ' + err.message);
      }
    } else {
      console.log('[tackle-harness] harness-config.yaml already exists, skipping');
    }

    // 4. Create harness-manifest.json if not exists
    var manifestPath = path.join(claudeDir, 'harness-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      try {
        var ManifestResolver = require('../../plugins/runtime/manifest-resolver');
        var defaultManifest = ManifestResolver.createDefaultManifest(ctx.packageRoot);
        var manifestContent = JSON.stringify(defaultManifest, null, 2);
        fs.writeFileSync(manifestPath, manifestContent + '\n', 'utf-8');
        console.log('[tackle-harness] Created harness-manifest.json');

        // Print plugin activation summary
        var plugins = defaultManifest.plugins || {};
        var pluginNames = Object.keys(plugins);
        var enabledCount = 0;
        for (var i = 0; i < pluginNames.length; i++) {
          if (plugins[pluginNames[i]].enabled !== false) {
            enabledCount++;
          }
        }
        console.log('[tackle-harness] Plugin activation: ' + enabledCount + ' enabled, ' + (pluginNames.length - enabledCount) + ' disabled');
      } catch (err) {
        console.error('[tackle-harness] Warning: Failed to create harness-manifest.json');
        console.error('[tackle-harness] Error: ' + err.message);
      }
    } else {
      console.log('[tackle-harness] harness-manifest.json already exists, skipping');
    }

    // 4.5. Create settings.json with hook registration (global mode)
    var builder = ctx.createBuilder();
    builder.updateSettings(ctx.targetRoot, ctx.packageRoot);
    console.log('[tackle-harness] Created .claude/settings.json with global hook registration');

    // 5. Detect and clean up legacy project-level hooks registration
    var settingsPath = ctx.settingsPath;
    if (fs.existsSync(settingsPath)) {
      try {
        var settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        var result = cleanupUtils.cleanupSettingsHooks(settings);

        if (result.hadProjectHooks) {
          fs.writeFileSync(settingsPath, JSON.stringify(result.settings, null, 2) + '\n', 'utf-8');
          console.log(ctx.colorize('[tackle-harness] Cleaned up legacy project-level hooks registration', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed project-level hooks from .claude/settings.json');
        }
      } catch (err) {
        // Expected degradation: user's settings.json may be malformed/unreadable.
        // Cleanup is optional (best-effort); do not surface as Error-level noise.
        if (ctx.flags.verbose) {
          console.warn('[tackle-harness] (degraded) Skipped project-level hooks cleanup: ' + err.message);
        }
      }
    }

    // 6. Detect and clean up legacy project-level skills
    var projectSkillsDir = path.join(claudeDir, 'skills');
    if (fs.existsSync(projectSkillsDir)) {
      try {
        var removedSkills = cleanupUtils.cleanupProjectSkills(projectSkillsDir, ctx.registryPath, ctx.packageRoot);

        if (removedSkills.length > 0) {
          console.log(ctx.colorize('[tackle-harness] Cleaned up ' + removedSkills.length + ' project-level skills (now available globally)', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed ' + removedSkills.length + ' project-level skills (now available globally)');

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

    // 7. Detect and clean up legacy project-level hooks
    var projectHooksDir = path.join(claudeDir, 'hooks');
    if (fs.existsSync(projectHooksDir)) {
      try {
        var removedHooks = cleanupUtils.cleanupProjectHooks(projectHooksDir, ctx.registryPath, ctx.packageRoot);

        if (removedHooks.length > 0) {
          console.log(ctx.colorize('[tackle-harness] Cleaned up ' + removedHooks.length + ' project-level hooks (now available globally)', 'yellow'));
          hasLegacyStructure = true;
          cleanupActions.push('Removed ' + removedHooks.length + ' project-level hooks (now available globally)');
        }

        cleanupUtils.removeEmptyDir(projectHooksDir);
        if (!fs.existsSync(projectHooksDir)) {
          console.log('[tackle-harness] Removed empty .claude/hooks/ directory');
        }
      } catch (err) {
        // Expected degradation: legacy hooks dir cleanup is best-effort and optional.
        if (ctx.flags.verbose) {
          console.warn('[tackle-harness] (degraded) Skipped project-level hooks dir cleanup: ' + err.message);
        }
      }
    }

    // 8. Inject CLAUDE.md plan-mode rules (independent of build)
    builder.injectClaudeMdRules(ctx.targetRoot);

    // 9. Print migration summary if legacy structure was detected
    if (hasLegacyStructure) {
      console.log('');
      console.log(ctx.colorize('[tackle-harness] === Migration Summary ===', 'cyan'));
      console.log(ctx.colorize('[tackle-harness] Your project has been updated to use global skills/hooks.', 'cyan'));
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
  },
};
