/**
 * Hook: Session Start
 *
 * SessionStart hook that injects tackle-harness rules into Claude Code's
 * system-reminder context via hookSpecificOutput.additionalContext.
 *
 * This ensures plan-mode rules appear at the same priority level as
 * superpowers skills, rather than relying on CLAUDE.md static files.
 *
 * Usage (CLI):
 *   node plugins/core/hook-session-start/index.js
 *
 * Output: JSON with hookSpecificOutput.additionalContext containing
 * plan-mode priority rules for task-creation skills.
 */

'use strict';

var fs = require('fs');
var path = require('path');

/**
 * Resolve the package root directory from __dirname.
 * Walks up from the hook's location to find the tackle-harness package root.
 * Used to locate plugin-registry.json regardless of installation mode.
 *
 * For global installs, resolves to the global npm package directory.
 * For local installs, resolves to the project's node_modules/tackle-harness.
 *
 * @returns {string}
 */
function resolvePackageRoot() {
  // This hook is at: plugins/core/hook-session-start/index.js
  // Package root is three levels up from __dirname
  var dir = path.resolve(__dirname, '../../..');

  // Verify we're at the right location (should contain plugins/ directory)
  for (var i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'plugins'))) return dir;
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: try to find global tackle-harness in node_modules
  // Check common global npm directories
  var globalPaths = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'tackle-harness'),
    path.join(process.env.npm_config_prefix || '/usr/local', 'lib', 'node_modules', 'tackle-harness'),
  ];

  for (var j = 0; j < globalPaths.length; j++) {
    if (fs.existsSync(path.join(globalPaths[j], 'plugins'))) {
      return globalPaths[j];
    }
  }

  // Fallback to computed path
  return path.resolve(__dirname, '../../..');
}

/**
 * Walk up from a directory to find the project root (contains .claude/ or plugins/).
 * Always uses process.cwd() for CWD-based project resolution.
 * @param {string} [startDir]
 * @returns {string}
 */
function resolveProjectRoot(startDir) {
  // Always use process.cwd() to find the actual project root
  // This allows hooks to work correctly regardless of installation mode
  var dir = startDir || process.cwd();
  for (var i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.claude'))) return dir;
    if (fs.existsSync(path.join(dir, 'task.md'))) return dir;
    if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) return dir;
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Read plugin-registry.json and find skills with plan_mode_required.
 * @param {string} packageRoot - the tackle-harness package root directory
 * @returns {string[]} skill names
 */
function findPlanModeSkills(packageRoot) {
  var registryPath = path.join(packageRoot, 'plugins', 'plugin-registry.json');
  var planModeSkills = [];

  try {
    var content = fs.readFileSync(registryPath, 'utf-8');
    var registry = JSON.parse(content);
    var plugins = registry.plugins || [];

    for (var i = 0; i < plugins.length; i++) {
      var entry = plugins[i];
      if (!entry.source) continue;

      var pluginDir = path.join(packageRoot, 'plugins', 'core', entry.source);
      var pluginJsonPath = path.join(pluginDir, 'plugin.json');

      try {
        var meta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
        if (meta.type !== 'skill') continue;

        var hasPlanMode = false;

        // Check plugin.json config
        if (meta.config && meta.config.plan_mode_required) {
          hasPlanMode = true;
        }

        // Fallback: check skill.md front-matter
        if (!hasPlanMode) {
          var skillMdPath = path.join(pluginDir, 'skill.md');
          if (fs.existsSync(skillMdPath)) {
            var skillContent = fs.readFileSync(skillMdPath, 'utf-8');
            if (/^---[\s\S]*?plan_mode_required:\s*true[\s\S]*?---/.test(skillContent)) {
              hasPlanMode = true;
            }
          }
        }

        if (hasPlanMode) {
          planModeSkills.push(meta.name || entry.name);
        }
      } catch (e) {
        // skip unparseable
      }
    }
  } catch (e) {
    // registry may not exist
  }

  return planModeSkills;
}

/**
 * Build the additionalContext string for SessionStart hook output.
 * @param {string} packageRoot - the tackle-harness package root directory
 * @returns {string}
 */
function buildContext(packageRoot) {
  var planModeSkills = findPlanModeSkills(packageRoot);

  if (planModeSkills.length === 0) return '';

  var lines = [];
  lines.push('Tackle Harness Plan Mode 规则已激活。');
  lines.push('');
  lines.push('当以下 skill 被触发时，必须直接调用 EnterPlanMode 进入 Plan 模式，不得先执行 brainstorming 或其他分析工作：');

  for (var i = 0; i < planModeSkills.length; i++) {
    lines.push('- ' + planModeSkills[i]);
  }

  lines.push('');
  lines.push('这些 skill 已标注 plan_mode_required: true，优先级高于 superpowers:brainstorming。收到匹配请求时，跳过 brainstorming 检查，立即进入 Plan 模式。');

  return lines.join('\n');
}

/**
 * Escape a string for safe embedding in a JSON string value.
 * @param {string} s
 * @returns {string}
 */
function escapeForJson(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Check if this hook execution should be skipped to prevent double-triggering.
 *
 * Double-triggering can occur when:
 * 1. A hook is registered globally (via global npm install)
 * 2. The same hook is also registered at project level (via local build)
 *
 * We detect this by checking whether a marker file exists with a recent timestamp.
 *
 * @param {string} projectRoot - the project root directory
 * @returns {boolean} true if this execution should be skipped
 */
function shouldSkipForDoubleTrigger(projectRoot) {
  var markerPath = path.join(projectRoot, '.claude', '.hook-session-start-marker');

  // If another hook process is marked as active, skip
  if (fs.existsSync(markerPath)) {
    try {
      var marker = fs.readFileSync(markerPath, 'utf-8');
      var markerData = JSON.parse(marker);

      // If marker is recent (< 5 seconds), skip to prevent double execution
      var now = Date.now();
      if (markerData.timestamp && (now - markerData.timestamp) < 5000) {
        return true;
      }
      // Stale marker — clean it up
      try { fs.unlinkSync(markerPath); } catch (e) { /* ignore */ }
    } catch (e) {
      // Invalid marker, clean up
      try { fs.unlinkSync(markerPath); } catch (e2) { /* ignore */ }
    }
  }

  // Mark this hook as active
  try {
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ timestamp: Date.now(), pid: process.pid }),
      'utf-8'
    );
  } catch (e) {
    // Failed to write marker, continue anyway
  }

  return false;
}

// --- Main ---
(function main() {
  // Only run main if executed directly (not required as a module)
  if (require.main === module) {
    var packageRoot = resolvePackageRoot();
    var projectRoot = resolveProjectRoot();

    // Check for double-triggering prevention
    if (shouldSkipForDoubleTrigger(projectRoot)) {
      // Skip execution to prevent double-triggering, output empty result
      process.stdout.write('{}\n');
      process.exit(0);
    }

    var context = buildContext(packageRoot);

    if (!context) {
      // No plan-mode skills found, output empty context
      process.stdout.write('{}\n');
      process.exit(0);
    }

    var escaped = escapeForJson(context);

    // Claude Code SessionStart hook output format
    var output = '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "' + escaped + '"\n  }\n}\n';

    process.stdout.write(output);
    process.exit(0);
  }
})();

// Export a no-op class for PluginLoader compatibility
class SessionStartHook {
  constructor() {
    this.name = 'hook-session-start';
    this.version = '1.0.0';
    this.description = 'SessionStart hook for plan-mode rules';
    this.type = 'hook';
  }

  async onActivate(context) {
    // No-op - this hook is CLI-only
  }

  async handle(context) {
    return { allowed: true };
  }
}

module.exports = SessionStartHook;

// Exposed for unit testing (plan_mode_required detection contract, WP-176).
module.exports.findPlanModeSkills = findPlanModeSkills;
