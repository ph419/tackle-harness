'use strict';

const ProviderPlugin = require('../../contracts/plugin-interface').ProviderPlugin;

/**
 * Watchdog Provider Plugin
 *
 * Provides watchdog daemon status query API.
 * When enabled and built, deploys watchdog assets to .claude/watchdog/.
 */
class WatchdogProvider extends ProviderPlugin {
  constructor() {
    super();
    this.name = 'provider-watchdog';
    this.version = '0.1.0';
    this.description = 'Watchdog Daemon Provider';
    this.provides = 'provider:watchdog';
  }

  async onActivate(context) {
    this._context = context;
    context.logger.info('WatchdogProvider activated');
  }

  async factory(context) {
    const fs = require('fs');
    const path = require('path');

    return {
      /**
       * 读取配置中的 heartbeat_dir，回退到默认值
       * @private
       * @returns {string}
       */
      _getHeartbeatDir: function () {
        const configPath = path.join('.claude-daemon', 'daemon-config.json');
        if (fs.existsSync(configPath)) {
          try {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return cfg.heartbeat_dir || '.claude-daemon';
          } catch (e) {
            // 解析失败，使用默认值
          }
        }
        return '.claude-daemon';
      },

      /**
       * 检查 watchdog 是否已部署到目标项目
       * @returns {boolean}
       */
      isDeployed: function () {
        const watchdogPath = path.join('.claude', 'watchdog', 'watchdog.js');
        return fs.existsSync(watchdogPath);
      },

      /**
       * 获取 watchdog 部署路径
       * @returns {string}
       */
      getDeployPath: function () {
        return path.join('.claude', 'watchdog');
      },

      /**
       * 获取守护进程状态文件路径
       * @returns {string}
       */
      getStatusFilePath: function () {
        return path.join(this._getHeartbeatDir(), 'daemon-status.json');
      },

      /**
       * 读取守护进程状态对象（原始 status.json），失败降级为 null。
       * 供 getHealth / isRunning 共用，避免重复解析。
       * @private
       * @returns {object|null}
       */
      _readStatus: function () {
        const statusFile = this.getStatusFilePath();
        if (!fs.existsSync(statusFile)) {
          return null;
        }
        try {
          return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        } catch (e) {
          return null;
        }
      },

      /**
       * 查询守护进程健康（design.md §6.3.2，WP-174-5）。
       *
       * 返回三态健康模型，供 loop-engine 熔断判定区分 degraded：
       *   - 'healthy'    : health 未终止，且心跳不过期
       *   - 'degraded'   : health 非终止但心跳过期（持续 degraded 触发熔断）
       *   - 'terminated' : health === 'terminated'，或状态文件缺失/损坏
       *
       * 同时保留 `running` 布尔（等价于旧的 isRunning 语义：health !== 'terminated'），
       * 便于只关心"是否完全挂掉"的调用方平滑迁移。
       *
       * @returns {{ state: 'healthy'|'degraded'|'terminated', running: boolean, health?: string, stale?: boolean, raw?: object }}
       */
      getHealth: function () {
        const STALE_THRESHOLD_MS = 120000; // 与 multi-window-coordinator 心跳过期阈值一致
        const status = this._readStatus();
        if (!status) {
          return { state: 'terminated', running: false };
        }
        const health = status.health || 'unknown';
        if (health === 'terminated') {
          return { state: 'terminated', running: false, health: health, raw: status };
        }
        // 非终止：检查心跳新鲜度以区分 healthy / degraded
        var stale = false;
        if (status.last_update || status.last_heartbeat || status.updated_at) {
          var ts = status.last_update || status.last_heartbeat || status.updated_at;
          var age = Date.now() - new Date(ts).getTime();
          if (!isNaN(age) && age > STALE_THRESHOLD_MS) {
            stale = true;
          }
        }
        return {
          state: stale ? 'degraded' : 'healthy',
          running: true,
          health: health,
          stale: stale,
          raw: status,
        };
      },

      /**
       * 检查守护进程是否正在运行（向后兼容）。
       *
       * 语义保持不变：health !== 'terminated'（即未完全挂掉即视为 running，
       * 不因心跳过期返回 false —— 否则会破坏现有只关心"完全终止"的调用方）。
       * 需要区分 healthy/degraded 的调用方应改用 getHealth()。
       * @returns {boolean}
       */
      isRunning: function () {
        const status = this._readStatus();
        if (!status) {
          return false;
        }
        return status.health !== 'terminated';
      }
    };
  }
}

module.exports = WatchdogProvider;
