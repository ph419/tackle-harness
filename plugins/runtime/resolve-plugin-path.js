/**
 * resolve-plugin-path - Shared plugin path resolution
 *
 * Centralizes the path resolution logic used by both harness-build.js
 * and plugin-loader.js. Supports absolute paths, relative paths, and
 * the default core/ subdirectory convention.
 *
 * Supports sourceType field for external plugin sources:
 *   - 'core' (default) — built-in plugins under plugins/core/
 *   - 'npm'            — npm package resolved via require.resolve()
 *   - 'local'          — absolute or relative path outside core/
 *
 * @module resolve-plugin-path
 */

'use strict';

var fs = require('fs');
var path = require('path');
var safePath = require('./safe-path');
var isWithin = safePath.isWithin;

var VALID_SOURCE_TYPES = ['core', 'npm', 'local'];

/**
 * Cross-platform absolute path check.
 *
 * Node's path.isAbsolute() is platform-specific: on POSIX it only
 * recognizes /-prefixed paths; on Windows it only recognizes drive-letter
 * and UNC paths. A plugin registry may contain Windows-style paths on a
 * POSIX host (or vice versa), so we check both conventions.
 *
 * @internal
 * @param {string} p - path to test
 * @returns {boolean} true if p is absolute on either Windows or POSIX
 */
function isAbsolutePath(p) {
  if (path.isAbsolute(p)) return true;
  // Windows drive-letter absolute path: C:\  D:/  etc.
  if (/^[A-Za-z]:[\\\/]/.test(p)) return true;
  return false;
}

/**
 * Resolve the filesystem directory for a plugin entry.
 *
 * Resolution strategy by sourceType:
 *   - 'core' (default):
 *       1. If source is absolute → use directly (must be a real directory)
 *       2. If source has path separators → resolve relative to registryDir
 *          (S3: must remain inside the repo root, i.e. registryDir's parent;
 *          `..` escapes that climb past the repo root are rejected)
 *       3. Otherwise → join defaultPluginsDir with source
 *   - 'npm':
 *       Resolve via require.resolve(packageName) and extract the directory.
 *       The source field is interpreted as an npm package name (with optional
 *       sub-path, e.g. 'tackle-plugin-foo/sub/path').
 *   - 'local':
 *       Absolute or relative path. Relative paths resolve against registryDir
 *       (S3: must remain inside the repo root).
 *
 * S3 SECURITY NOTE (path traversal):
 *   Relative sources may legitimately climb one level to a sibling directory
 *   inside the repository (e.g. '../custom-plugins/my-plugin'), but they may
 *   NOT escape the repository root entirely (e.g. '../../etc/passwd'). The
 *   repo root is taken to be the parent of registryDir. Absolute sources are
 *   allowed for trusted local/third-party installs and are NOT containment-
 *   checked (a user who points at an absolute path is opting into that path).
 *
 * @public
 * @param {object}  entry              - Plugin registry entry
 * @param {string}  entry.name         - Plugin name
 * @param {string} [entry.source]      - Source identifier (defaults to entry.name)
 * @param {string} [entry.sourceType]  - Source type: 'core' (default), 'npm', 'local'
 * @param {string}  defaultPluginsDir  - Base directory for core plugins (e.g. .../plugins/core)
 * @param {string}  registryDir        - Directory containing plugin-registry.json
 * @returns {string} resolved absolute path to the plugin directory
 * @throws {Error} if sourceType is invalid, npm package cannot be resolved,
 *                 or a relative source escapes the repository root (S3)
 */
function resolvePluginPath(entry, defaultPluginsDir, registryDir) {
  var source = entry.source || entry.name;
  if (!source) {
    return path.join(defaultPluginsDir, 'unknown');
  }

  var sourceType = entry.sourceType || 'core';

  // Validate sourceType
  if (VALID_SOURCE_TYPES.indexOf(sourceType) === -1) {
    throw new Error(
      'Invalid sourceType "' + sourceType + '" for plugin "' + (entry.name || 'unknown') +
      '". Valid values: ' + VALID_SOURCE_TYPES.join(', ')
    );
  }

  // npm source: resolve via require.resolve
  if (sourceType === 'npm') {
    return resolveNpmPath(source, entry.name);
  }

  // The repository root is the parent of registryDir (plugins/ → repo root).
  // Relative sources must remain within this root.
  var repoRoot = path.resolve(registryDir, '..');

  // WP-S3-fix：字面层穿越守卫。POSIX 主机上 path.resolve 不识别反斜杠分隔符，
  // Windows 风格 source（如 '..\\..\\Windows\\System32'）会被当成单个字面段，
  // 导致后续 assertWithinRepo 的 path.relative 看不到 '..' 而漏判。这里在 resolve
  // 之前对相对 source 做净深度扫描，相对 registryDir 上爬 > 1 级即逃逸 repoRoot，
  // 直接拒绝。绝对 source 已由 isAbsolutePath 分流为可信 opt-in，不进这里。
  var sourceHasTraversal = !isAbsolutePath(source) && sourceEscapesRepoRoot(source);

  // local source: absolute or relative path
  if (sourceType === 'local') {
    if (isAbsolutePath(source)) {
      return source; // opt-in absolute path, trusted
    }
    if (sourceHasTraversal) {
      throw new Error(
        'Plugin "' + (entry.name || 'unknown') + '" source path escapes the repository root: ' +
        source + ' (root: ' + repoRoot + '). Refusing to resolve path-traversal source.'
      );
    }
    var localResolved = path.resolve(registryDir, source);
    assertWithinRepo(localResolved, repoRoot, entry.name);
    return localResolved;
  }

  // core (default): existing behavior
  // Absolute path → use directly (opt-in absolute path, trusted)
  if (isAbsolutePath(source)) {
    return source;
  }

  // Relative path containing path separators → resolve relative to registry directory
  // (e.g. '../custom-plugins/my-plugin' or './my-plugin')
  if (source.indexOf('/') !== -1 || source.indexOf('\\') !== -1) {
    if (sourceHasTraversal) {
      throw new Error(
        'Plugin "' + (entry.name || 'unknown') + '" source path escapes the repository root: ' +
        source + ' (root: ' + repoRoot + '). Refusing to resolve path-traversal source.'
      );
    }
    var resolved = path.resolve(registryDir, source);
    assertWithinRepo(resolved, repoRoot, entry.name);
    return resolved;
  }

  // Default: core plugin → join with defaultPluginsDir (a bare name, no traversal risk)
  return path.join(defaultPluginsDir, source);
}

/**
 * Reject a resolved path that escapes the repository root.
 * Allows the path to equal the repo root or live anywhere beneath it, but
 * not its ancestors/siblings outside the repo.
 *
 * @internal
 * @param {string} resolved  - absolute resolved plugin path
 * @param {string} repoRoot  - absolute repository root (parent of registryDir)
 * @param {string} [pluginName] - for error messages
 * @throws {Error} if resolved is not within repoRoot
 */
function assertWithinRepo(resolved, repoRoot, pluginName) {
  var rel = path.relative(path.resolve(repoRoot), path.resolve(resolved));
  // rel === '' means the path IS the repo root (allowed).
  // rel starts with '..' means it escaped the repo root (reject).
  if (rel !== '' && (rel === '..' || rel.indexOf('..' + path.sep) === 0 ||
      rel.indexOf('../') === 0 || rel.indexOf('..\\') === 0)) {
    throw new Error(
      'Plugin "' + (pluginName || 'unknown') + '" source path escapes the repository root: ' +
      resolved + ' (root: ' + repoRoot + '). Refusing to resolve path-traversal source.'
    );
  }
}

/**
 * 字面层穿越检测：按两种路径分隔符（/ 与 \）切分 source，统计净目录深度。
 * 用于在 path.resolve（POSIX 主机不识别反斜杠）之前拦截 Windows 风格的逃逸。
 *
 * 仅判定「相对 source 相对 registryDir 的净上爬深度」；绝对路径（含盘符/UNC）由
 * 调用方 isAbsolutePath 提前分流，不经过本函数。
 *
 * 语义与 assertWithinRepo 对齐：repoRoot = registryDir 的父目录，故相对 registryDir
 * 允许上爬至多 1 级（到达 repoRoot 本身或其下的同级目录）。净深度 > 1 即逃逸 repoRoot。
 * 净深度 = '..' 段数 - 非 '.'/'..' 的下钻段数（'.' 段不计）。
 *
 * 例：
 *   '../custom-plugins/my-plugin' → 1 个 '..'，1 个下钻 → 净 0 → 允许（同级目录）
 *   '../../etc/passwd'             → 2 个 '..' → 净 2 → 拒绝
 *   '..\\..\\Windows\\System32'    → 2 个 '..'，1 个下钻 → 净 1 → 拒绝（>1）
 *
 * @internal
 * @param {string} source 待检测的相对 source 串
 * @returns {boolean} true 表示该 source 净上爬深度 > 1，会逃逸 repoRoot
 */
function sourceEscapesRepoRoot(source) {
  if (typeof source !== 'string' || source === '') return false;
  // 同时按两种分隔符切分，兼容跨平台 registry（Windows 风格 source 在 POSIX 主机上）。
  var segs = source.split(/[\\/]/);
  var netUp = 0;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (s === '..') {
      netUp += 1;
    } else if (s !== '' && s !== '.') {
      netUp -= 1;
    }
  }
  // repoRoot 是 registryDir 的父目录；相对 registryDir 上爬 > 1 级即逃出 repoRoot。
  return netUp > 1;
}

/**
 * Resolve an npm package path using require.resolve().
 *
 * For a package like 'tackle-plugin-foo', resolves to the package root.
 * For a scoped or sub-path like '@scope/foo/sub', resolves the sub-path.
 *
 * @internal
 * @param {string} source - npm package name (with optional sub-path)
 * @param {string} [pluginName] - plugin name for error messages
 * @returns {string} resolved absolute path to the package directory
 * @throws {Error} if the package cannot be resolved
 */
function resolveNpmPath(source, pluginName) {
  try {
    // require.resolve with the package name gives us the entry point
    // (package.json "main" or index.js). Extract directory from that.
    var resolved = require.resolve(source);
    // If the resolved path ends with index.js or similar, walk up to the package root.
    // For packages that export a directory, require.resolve may return the directory itself.
    var resolvedDir = resolved;

    // Check if the resolved path is a file (has extension) — get its directory
    var basename = path.basename(resolved);
    if (basename === 'index.js' || basename === 'index.json' || basename.endsWith('.js') || basename.endsWith('.json')) {
      // Walk up to find the package root (directory containing package.json)
      resolvedDir = findPackageRoot(resolved);
    }

    return resolvedDir;
  } catch (err) {
    throw new Error(
      'Failed to resolve npm plugin "' + source + '"' +
      (pluginName ? ' (plugin: ' + pluginName + ')' : '') +
      ': ' + err.message +
      '. Ensure the package is installed (npm install ' + source + ')'
    );
  }
}

/**
 * Walk up from a resolved file path to find the package root directory.
 * The package root is the nearest ancestor directory containing package.json.
 *
 * @internal
 * @param {string} startPath - starting file or directory path
 * @returns {string} package root directory
 */
function findPackageRoot(startPath) {
  var current = path.dirname(startPath);
  var root = path.parse(current).root;

  while (current !== root) {
    var pkgJsonPath = path.join(current, 'package.json');
    try {
      if (fs.existsSync(pkgJsonPath)) {
        return current;
      }
    } catch (e) {
      // ignore
    }
    current = path.dirname(current);
  }

  // Fallback: return the directory of the resolved file
  return path.dirname(startPath);
}

module.exports = {
  resolvePluginPath: resolvePluginPath,
  resolveNpmPath: resolveNpmPath,
  VALID_SOURCE_TYPES: VALID_SOURCE_TYPES
};
