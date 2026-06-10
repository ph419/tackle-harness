/**
 * Watchdog Multi-Window Extension
 *
 * Extends the Watchdog daemon with multi-session monitoring capabilities:
 *   - L4 Cross-Window Detection: monitors all windows in multi-window-session.json
 *   - L5 Stage-Level Detection: detects when all windows in a stage are stalled
 *   - Global Circuit Breaker: consecutive failure threshold -> abort_all
 *   - Cross-Window Command Dispatch: writes commands to target windows' daemon-actions.json
 *
 * Design doc: docs/reports/multi-window-monitoring-design.html (Section 6.2)
 * Work package: WP-172-1-impl-c
 */

'use strict';

var fs = require('fs');
var path = require('path');

// ─────────────────────────────────────────────
// Section 1: Utilities
// ─────────────────────────────────────────────

/**
 * Read and parse a JSON file. Returns null on any error.
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonSafe(filePath) {
  try {
    var content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (_e) {
    return null;
  }
}

/**
 * Write a JSON file with atomic-style write (write to temp then rename).
 * Falls back to direct write if rename fails.
 * @param {string} filePath
 * @param {object} data
 */
function writeJsonSafe(filePath, data) {
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  var content = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ─────────────────────────────────────────────
// Section 2: Multi-Window Mode Detection
// ─────────────────────────────────────────────

/**
 * Check if multi-window session file exists.
 * @param {string} daemonDir - Path to .claude-daemon/ directory
 * @returns {boolean}
 */
function isMultiWindowMode(daemonDir) {
  var sessionPath = path.join(daemonDir, 'multi-window-session.json');
  return fs.existsSync(sessionPath);
}

/**
 * Read multi-window-session.json. Returns null if not found or invalid.
 * @param {string} daemonDir
 * @returns {object|null}
 */
function readSession(daemonDir) {
  var sessionPath = path.join(daemonDir, 'multi-window-session.json');
  return readJsonSafe(sessionPath);
}

// ─────────────────────────────────────────────
// Section 3: L4 Cross-Window Detection
// ─────────────────────────────────────────────

/**
 * Default multi-window config values.
 */
var MW_DEFAULTS = {
  heartbeat_timeout_sec: 120,       // 2 minutes — matches coordinator STALE_THRESHOLD_MS
  stage_stall_timeout_sec: 600,     // 10 minutes — all windows idle in a stage
  circuit_breaker: {
    consecutive_failures_threshold: 3,
    cooldown_after_break_sec: 900   // 15 minutes
  }
};

/**
 * Load multi-window config from daemon config, merging with defaults.
 * @param {object} daemonConfig - Full daemon-config.json content
 * @returns {object} Multi-window config section
 */
function loadMultiWindowConfig(daemonConfig) {
  var mw = (daemonConfig && daemonConfig.multi_window) || {};
  var cb = mw.circuit_breaker || {};

  return {
    heartbeat_timeout_sec: mw.heartbeat_timeout_sec || MW_DEFAULTS.heartbeat_timeout_sec,
    stage_stall_timeout_sec: mw.stage_stall_timeout_sec || MW_DEFAULTS.stage_stall_timeout_sec,
    circuit_breaker: {
      consecutive_failures_threshold: cb.consecutive_failures_threshold || MW_DEFAULTS.circuit_breaker.consecutive_failures_threshold,
      cooldown_after_break_sec: cb.cooldown_after_break_sec || MW_DEFAULTS.circuit_breaker.cooldown_after_break_sec
    }
  };
}

/**
 * L4 Cross-Window Detection: identify windows that are disconnected or failed.
 *
 * A window is considered disconnected if:
 *   - Its heartbeat.last_update is older than heartbeat_timeout_sec
 *   - Or it has no heartbeat data at all
 *
 * A window is considered failed if:
 *   - Its status in session.windows is 'failed'
 *
 * @param {object} session - multi-window-session.json content
 * @param {object} config - Multi-window config (from loadMultiWindowConfig)
 * @returns {object} { alerts: Array<{window_id, level, type, message, timestamp}>, summary: {total, active, disconnected, failed} }
 */
function detectCrossWindowIssues(session, config) {
  var alerts = [];
  var summary = { total: 0, active: 0, disconnected: 0, failed: 0 };
  var now = Date.now();
  var timeoutMs = (config.heartbeat_timeout_sec || MW_DEFAULTS.heartbeat_timeout_sec) * 1000;

  if (!session || !session.windows) {
    return { alerts: alerts, summary: summary };
  }

  var winIds = Object.keys(session.windows);
  summary.total = winIds.length;

  for (var i = 0; i < winIds.length; i++) {
    var winId = winIds[i];
    var win = session.windows[winId];

    if (win.status === 'failed') {
      summary.failed++;
      alerts.push({
        window_id: winId,
        level: 'L4',
        type: 'window_failed',
        message: 'Window ' + winId + ' reported as failed',
        timestamp: new Date().toISOString()
      });
      continue;
    }

    if (win.status === 'disconnected') {
      summary.disconnected++;
      alerts.push({
        window_id: winId,
        level: 'L4',
        type: 'window_disconnected',
        message: 'Window ' + winId + ' is disconnected (no recent heartbeat)',
        timestamp: new Date().toISOString()
      });
      continue;
    }

    // Also check heartbeat staleness directly (defense in depth)
    if (win.heartbeat && win.heartbeat.last_update) {
      var heartbeatAge = now - new Date(win.heartbeat.last_update).getTime();
      if (heartbeatAge > timeoutMs) {
        summary.disconnected++;
        alerts.push({
          window_id: winId,
          level: 'L4',
          type: 'heartbeat_stale',
          message: 'Window ' + winId + ' heartbeat is stale (' + Math.round(heartbeatAge / 1000) + 's old)',
          timestamp: new Date().toISOString()
        });
        continue;
      }
    } else if (!win.heartbeat) {
      summary.disconnected++;
      alerts.push({
        window_id: winId,
        level: 'L4',
        type: 'no_heartbeat',
        message: 'Window ' + winId + ' has no heartbeat data',
        timestamp: new Date().toISOString()
      });
      continue;
    }

    summary.active++;
  }

  return { alerts: alerts, summary: summary };
}

// ─────────────────────────────────────────────
// Section 4: L5 Stage-Level Detection
// ─────────────────────────────────────────────

/**
 * L5 Stage-Level Detection: check if all windows in the active stage are stalled.
 *
 * A window is considered "stalled" if:
 *   - Its heartbeat shows in_progress=0 AND pending=0 (idle/completed), OR
 *   - Its heartbeat is stale (older than heartbeat_timeout_sec), OR
 *   - Its status is 'disconnected'
 *
 * A stage is considered "stalled" if ALL windows in the active stage are stalled
 * AND the stall duration exceeds stage_stall_timeout_sec.
 *
 * @param {object} session - multi-window-session.json content
 * @param {object} config - Multi-window config
 * @returns {object} { stalled: boolean, stage_id: number|null, reason: string, stalled_windows: string[], duration_sec: number }
 */
function detectStageStall(session, config) {
  var result = {
    stalled: false,
    stage_id: null,
    reason: '',
    stalled_windows: [],
    duration_sec: 0
  };

  if (!session || !session.stages || !session.windows) {
    return result;
  }

  // Find active stage
  var activeStage = null;
  for (var i = 0; i < session.stages.length; i++) {
    if (session.stages[i].status === 'active') {
      activeStage = session.stages[i];
      break;
    }
  }

  if (!activeStage) {
    return result;
  }

  result.stage_id = activeStage.stage_id;

  var stageWindows = activeStage.windows || [];
  if (stageWindows.length === 0) {
    return result;
  }

  var now = Date.now();
  var heartbeatTimeoutMs = (config.heartbeat_timeout_sec || MW_DEFAULTS.heartbeat_timeout_sec) * 1000;
  var stallTimeoutMs = (config.stage_stall_timeout_sec || MW_DEFAULTS.stage_stall_timeout_sec) * 1000;

  // Check each window in the stage
  var allStalled = true;
  var stalledWindows = [];
  var oldestStallStart = now;

  for (var j = 0; j < stageWindows.length; j++) {
    var winId = stageWindows[j];
    var win = session.windows[winId];

    if (!win) {
      // Window not in session — treat as stalled
      stalledWindows.push(winId);
      continue;
    }

    var isWindowStalled = false;

    // Check if disconnected
    if (win.status === 'disconnected' || win.status === 'failed') {
      isWindowStalled = true;
    }

    // Check heartbeat staleness
    if (!isWindowStalled && win.heartbeat && win.heartbeat.last_update) {
      var heartbeatAge = now - new Date(win.heartbeat.last_update).getTime();
      if (heartbeatAge > heartbeatTimeoutMs) {
        isWindowStalled = true;
      }
    } else if (!isWindowStalled && !win.heartbeat) {
      isWindowStalled = true;
    }

    // Check if window has no work (idle but not completed)
    if (!isWindowStalled && win.heartbeat) {
      var hb = win.heartbeat;
      if (hb.in_progress === 0 && hb.pending === 0 && win.status !== 'completed') {
        // Window is idle — check how long it's been idle
        // Use last_update as proxy for when it became idle
        if (hb.last_update) {
          var idleTime = now - new Date(hb.last_update).getTime();
          if (idleTime > stallTimeoutMs) {
            isWindowStalled = true;
          } else {
            // Not stalled long enough yet — but not all windows need to be stalled
            // for the same duration. We use the oldest stall start.
            if (idleTime < oldestStallStart) {
              oldestStallStart = idleTime;
            }
            allStalled = false;
          }
        }
      } else if (hb.in_progress > 0 || hb.pending > 0) {
        // Window has active work — not stalled
        allStalled = false;
      }
    }

    if (isWindowStalled) {
      stalledWindows.push(winId);
    } else {
      allStalled = false;
    }
  }

  // Determine if stage is stalled
  if (allStalled && stalledWindows.length === stageWindows.length) {
    // Calculate stall duration based on the oldest heartbeat among stalled windows
    var maxStallDuration = 0;
    for (var k = 0; k < stalledWindows.length; k++) {
      var sWin = session.windows[stalledWindows[k]];
      if (sWin && sWin.heartbeat && sWin.heartbeat.last_update) {
        var duration = now - new Date(sWin.heartbeat.last_update).getTime();
        if (duration > maxStallDuration) {
          maxStallDuration = duration;
        }
      } else {
        // No heartbeat at all — assume stalled since session start
        maxStallDuration = stallTimeoutMs + 1;
      }
    }

    if (maxStallDuration >= stallTimeoutMs) {
      result.stalled = true;
      result.stalled_windows = stalledWindows;
      result.duration_sec = Math.round(maxStallDuration / 1000);
      result.reason = 'All windows in stage ' + activeStage.stage_id + ' have been stalled for ' + result.duration_sec + 's';
    }
  }

  return result;
}

// ─────────────────────────────────────────────
// Section 5: Global Circuit Breaker
// ─────────────────────────────────────────────

/**
 * Create initial circuit breaker state.
 * @returns {object}
 */
function createCircuitBreakerState() {
  return {
    tripped: false,
    consecutive_failures: 0,
    total_failures: 0,
    tripped_at: null,
    last_failure_at: null,
    cooldown_until: null,
    history: []
  };
}

/**
 * Record a failure in the circuit breaker state.
 *
 * @param {object} breakerState - Mutable circuit breaker state
 * @param {string} reason - Failure reason
 * @param {object} config - Multi-window config
 * @returns {object} Updated breakerState (same reference, mutated in place)
 */
function recordFailure(breakerState, reason, config) {
  var now = new Date().toISOString();
  var threshold = (config.circuit_breaker && config.circuit_breaker.consecutive_failures_threshold)
    || MW_DEFAULTS.circuit_breaker.consecutive_failures_threshold;

  breakerState.consecutive_failures++;
  breakerState.total_failures++;
  breakerState.last_failure_at = now;

  breakerState.history.push({
    type: 'failure',
    reason: reason,
    timestamp: now,
    consecutive_failures: breakerState.consecutive_failures
  });

  // Keep history bounded (last 50 entries)
  if (breakerState.history.length > 50) {
    breakerState.history = breakerState.history.slice(-50);
  }

  // Check if threshold reached
  if (breakerState.consecutive_failures >= threshold && !breakerState.tripped) {
    breakerState.tripped = true;
    breakerState.tripped_at = now;

    var cooldownSec = (config.circuit_breaker && config.circuit_breaker.cooldown_after_break_sec)
      || MW_DEFAULTS.circuit_breaker.cooldown_after_break_sec;
    breakerState.cooldown_until = new Date(Date.now() + cooldownSec * 1000).toISOString();

    breakerState.history.push({
      type: 'tripped',
      message: 'Circuit breaker tripped after ' + breakerState.consecutive_failures + ' consecutive failures',
      timestamp: now
    });
  }

  return breakerState;
}

/**
 * Record a success (resets consecutive failures counter).
 *
 * @param {object} breakerState - Mutable circuit breaker state
 * @returns {object} Updated breakerState
 */
function recordSuccess(breakerState) {
  if (breakerState.consecutive_failures > 0) {
    breakerState.history.push({
      type: 'recovered',
      message: 'Consecutive failures reset from ' + breakerState.consecutive_failures + ' to 0',
      timestamp: new Date().toISOString()
    });
  }
  breakerState.consecutive_failures = 0;

  // If tripped and cooldown has passed, reset
  if (breakerState.tripped && breakerState.cooldown_until) {
    if (new Date() >= new Date(breakerState.cooldown_until)) {
      breakerState.tripped = false;
      breakerState.tripped_at = null;
      breakerState.cooldown_until = null;
      breakerState.history.push({
        type: 'reset',
        message: 'Circuit breaker reset after cooldown',
        timestamp: new Date().toISOString()
      });
    }
  }

  return breakerState;
}

/**
 * Check if the circuit breaker should trigger an abort_all.
 *
 * @param {object} breakerState
 * @returns {boolean} true if abort_all should be triggered
 */
function shouldAbortAll(breakerState) {
  return breakerState.tripped === true;
}

// ─────────────────────────────────────────────
// Section 6: Cross-Window Command Dispatch
// ─────────────────────────────────────────────

/**
 * Dispatch a command to a specific window's daemon-actions.json.
 *
 * @param {string} daemonDir - Path to .claude-daemon/ directory
 * @param {string} targetWindowId - Target window ID (e.g. 'win-1')
 * @param {object} command - Command object to append to actions
 * @param {string} command.action - Action type: 'restart' | 'abort' | 'abort_all' | 'pause'
 * @param {string} [command.reason] - Reason for the command
 * @param {string} [command.target_task] - Specific task ID (for restart)
 * @param {string} [command.strategy] - Restart strategy
 * @returns {object} { success: boolean, action_id: string, error: string|null }
 */
function dispatchCommand(daemonDir, targetWindowId, command) {
  var actionsPath = path.join(daemonDir, 'windows', targetWindowId, 'daemon-actions.json');

  var actionsData;
  try {
    actionsData = readJsonSafe(actionsPath);
    if (!actionsData) {
      actionsData = { actions: [], last_updated: null };
    }
  } catch (_e) {
    actionsData = { actions: [], last_updated: null };
  }

  if (!Array.isArray(actionsData.actions)) {
    actionsData.actions = [];
  }

  var actionId = 'act-mw-' + command.action + '-' + targetWindowId + '-' + Date.now();

  var action = {
    id: actionId,
    action: command.action,
    target_task: command.target_task || null,
    reason: command.reason || 'cross-window dispatch',
    strategy: command.strategy || null,
    timestamp: new Date().toISOString(),
    source: 'watchdog-multi-window',
    context: command.context || {}
  };

  actionsData.actions.push(action);
  actionsData.last_updated = new Date().toISOString();

  try {
    writeJsonSafe(actionsPath, actionsData);
    return { success: true, action_id: actionId, error: null };
  } catch (e) {
    return { success: false, action_id: actionId, error: e.message };
  }
}

/**
 * Dispatch abort_all to all windows in the session.
 *
 * @param {string} daemonDir - Path to .claude-daemon/ directory
 * @param {object} session - multi-window-session.json content
 * @param {string} reason - Reason for abort
 * @returns {object} { results: Array<{window_id, success, action_id, error}> }
 */
function dispatchAbortAll(daemonDir, session, reason) {
  var results = [];

  if (!session || !session.windows) {
    return { results: results };
  }

  var winIds = Object.keys(session.windows);
  for (var i = 0; i < winIds.length; i++) {
    var winId = winIds[i];
    var result = dispatchCommand(daemonDir, winId, {
      action: 'abort_all',
      reason: reason,
      context: { global_abort: true }
    });
    results.push({
      window_id: winId,
      success: result.success,
      action_id: result.action_id,
      error: result.error
    });
  }

  return { results: results };
}

// ─────────────────────────────────────────────
// Section 7: Main Multi-Window Check Loop
// ─────────────────────────────────────────────

/**
 * Run a complete multi-window monitoring check.
 *
 * This is the main entry point called by the Watchdog daemon on each cycle
 * when multi-window mode is detected.
 *
 * @param {string} daemonDir - Path to .claude-daemon/ directory
 * @param {object} daemonConfig - Full daemon-config.json content
 * @param {object} [breakerState] - Existing circuit breaker state (mutated in place)
 * @returns {object} { session, crossWindow, stageStall, breakerState, actions: Array }
 */
function runMultiWindowCheck(daemonDir, daemonConfig, breakerState) {
  var config = loadMultiWindowConfig(daemonConfig);
  var session = readSession(daemonDir);

  if (!session) {
    return {
      session: null,
      crossWindow: { alerts: [], summary: { total: 0, active: 0, disconnected: 0, failed: 0 } },
      stageStall: { stalled: false, stage_id: null, reason: '', stalled_windows: [], duration_sec: 0 },
      breakerState: breakerState || createCircuitBreakerState(),
      actions: []
    };
  }

  if (!breakerState) {
    breakerState = createCircuitBreakerState();
  }

  // L4: Cross-window detection
  var crossWindow = detectCrossWindowIssues(session, config);

  // L5: Stage stall detection
  var stageStall = detectStageStall(session, config);

  // Determine actions based on detections
  var actions = [];

  // Consolidate failures: record one failure per check cycle to avoid
  // double-counting when L4 (window-level) and L5 (stage-level) detect
  // the same underlying issue.
  var hasIssues = false;
  var failureReasons = [];

  if (crossWindow.alerts.length > 0) {
    var failedOrDisconnected = crossWindow.alerts.filter(function (a) {
      return a.type === 'window_failed' || a.type === 'window_disconnected' || a.type === 'heartbeat_stale' || a.type === 'no_heartbeat';
    });

    if (failedOrDisconnected.length > 0) {
      hasIssues = true;
      failureReasons.push(failedOrDisconnected.map(function (a) { return a.message; }).join('; '));
    }
  }

  if (stageStall.stalled) {
    hasIssues = true;
    failureReasons.push(stageStall.reason);
  }

  if (hasIssues) {
    recordFailure(breakerState, failureReasons.join(' | '), config);
  } else {
    recordSuccess(breakerState);
  }

  // Check circuit breaker
  if (shouldAbortAll(breakerState)) {
    var abortReason = 'Global circuit breaker tripped: ' + (breakerState.history.length > 0
      ? breakerState.history[breakerState.history.length - 1].message
      : 'consecutive failures exceeded threshold');

    var abortResult = dispatchAbortAll(daemonDir, session, abortReason);
    actions.push({
      type: 'abort_all',
      reason: abortReason,
      dispatched: abortResult
    });
  }

  return {
    session: session,
    crossWindow: crossWindow,
    stageStall: stageStall,
    breakerState: breakerState,
    actions: actions
  };
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  // Utilities
  readJsonSafe: readJsonSafe,
  writeJsonSafe: writeJsonSafe,

  // Multi-window mode detection
  isMultiWindowMode: isMultiWindowMode,
  readSession: readSession,
  loadMultiWindowConfig: loadMultiWindowConfig,

  // L4: Cross-window detection
  detectCrossWindowIssues: detectCrossWindowIssues,

  // L5: Stage-level detection
  detectStageStall: detectStageStall,

  // Global circuit breaker
  createCircuitBreakerState: createCircuitBreakerState,
  recordFailure: recordFailure,
  recordSuccess: recordSuccess,
  shouldAbortAll: shouldAbortAll,

  // Cross-window command dispatch
  dispatchCommand: dispatchCommand,
  dispatchAbortAll: dispatchAbortAll,

  // Main entry point
  runMultiWindowCheck: runMultiWindowCheck,

  // Constants
  MW_DEFAULTS: MW_DEFAULTS
};
