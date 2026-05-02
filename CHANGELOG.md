# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.19] - 2026-05-02

### Changed

- 统一 skill.md 元数据源：移除 10 个源 skill.md 的 front-matter 块，`plugin.json` 成为 `name`/`description`/`triggers` 的唯一真相源
- 更新 10 个 plugin.json 的 `description` 字段为英文 "Use when..." 触发格式，确保 Claude Code skill 匹配能力不降级
- `_generateSkillFrontMatter()` 现在为所有 13 个技能生成完整 front-matter（含 triggers）

### Verified

- 13/13 built skill.md front-matter 完整性验证通过（name + description + triggers）
- triggers 与 plugin.json 一致性验证通过
- 全项目综合验证通过（validate 0 errors、build 21 plugins、registry 一致、npm pack 无敏感文件）

## [0.0.18] - 2026-05-02

### Fixed

- `harness-build.js` 构建时自动复制 skill 插件的伴生参考文件（`*-reference.md`）到输出目录，并替换 skill.md 中的源码相对路径为输出路径。修复在其他项目目录使用 `skill-agent-dispatcher` 时 `roles-reference.md` 和 `cleanup-reference.md` 找不到的问题

## [0.0.16] - 2026-04-27

### Fixed

- CI Pipeline `Build plugins` 步骤改为 `npm run init`，解决 CI 环境配置文件缺失导致构建失败
- `config-validator.js` 配置文件缺失时降级为 warning，不再阻断构建
- `harness-build.js` 配置验证失败时继续使用默认值构建，而非硬错误中断

## [0.0.15] - 2026-04-27

### Added

- Interactive CLI 模式 (`tackle-harness interactive` / `tackle-harness i`)，支持交互式插件管理
- GitHub Actions CI/CD 工作流（ci.yml: Node 18/20 矩阵测试 + publish.yml: tag 触发 npm 发布）
- 示例项目目录 (`examples/minimal`)
- State Store 原子写入（write-to-temp + rename）和损坏自动恢复

### Changed

- harness-build hook 注册改为幂等 upsert 模式 (`_upsertHookEntry`)

### Fixed

- hook-skill-gate stdin 安全加固：1MB 大小限制 + prototype pollution 防护 + 错误信息脱敏
- `--root` 路径穿越安全检查
- 仓库 URL 从 `anthropics/tackle-harness` 修正为 `ph419/tackle`

## [0.0.14] - 2026-04-24

### Fixed

- Watchdog 守护进程启动改为 fd 直接重定向输出，避免 pipe + WriteStream 导致的资源泄漏
- 守护进程启动确认改为轮询状态文件（3 秒超时），取代硬编码 500ms 延时 + PID 存活检查
- `status` 命令输出重构：状态/健康/任务状态格式化抽取为独立函数，修复 ANSI 转义码导致列对齐错乱
- `_clearDaemonStatus` 改用 `stateManager.readDaemonStatus()` / `writeDaemonStatus()` 统一读写，并写入 `state: stopped`
- WatchdogProvider 的 `getStatusFilePath()` / `isRunning()` 改为从配置读取 `heartbeat_dir`，不再硬编码 `.claude-daemon`
- 后台子进程通过 `WATCHDOG_MODE` 环境变量传递运行模式

## [0.0.13] - 2026-04-24

### Fixed

- `package.json` 的 `files` 字段缺少 `templates/`，导致 npm 安装后 `init` 命令找不到 `harness-config.yaml` 模板文件

## [0.0.12] - 2026-04-22

### Added

- Progress Tracker 记录进度时同步更新 `docs/wp/WP-XXX.md` 状态字段和子任务状态
- Format A（基本信息表 + 子工作包列表表，WP-029~035）和 Format B（`### 状态` 独立节 + 任务列表表，WP-001~028）全覆盖
- 验收标准 checkbox 自动勾选（`- [ ]` → `- [x]`）

### Fixed

- Watchdog Provider 代码规范化（`var` → `const`）
- Watchdog 前台模式阻塞修复（`return new Promise(() => {})`）
- `daemon-status.json` 新增 `state` 字段，支持 paused 状态显示
- Watchdog `pause` 命令异步化
- Watchdog 与 Watchdog Manager 插件启用

## [0.0.11] - 2026-04-20

### Added

- Agent Dispatcher 并发控制：支持按时段调度子代理并发上限（WP-035）
- `agent_dispatcher.concurrency` 配置节（`harness-config.yaml` + `plugin-registry.json`）
- `get_max_concurrent()` / `is_time_in_range()` 辅助函数，支持跨午夜时段
- `harness-build.js` 多节 YAML 解析重构，支持 `context_window` 和 `agent_dispatcher` 两个独立配置节
- `_injectContextConfig` 按插件名分发 `CONTEXT-CONFIG` / `AGENT-DISPATCHER-CONFIG` 注入
- 并发控制测试套件 (`tests/wp-035-concurrency-test.js`，8 组测试)
- `CHANGELOG.md` 项目更新日志

## [0.0.10] - 2026-04-20

### Added

- Agent Dispatcher 1:1 工作包-Subagent 映射校验，防止重复创建和重复销毁

## [0.0.9] - 2026-04-18

### Changed

- CLI 输出优化，更新测试用例

## [0.0.8] - 2026-04-16

### Fixed

- CLI `--help` 标志、status 统计、config 解析等问题（WP-020/WP-021）
- CLI stale output 清理和 status 时间戳修复（WP-020/WP-021）
- Validator phase targeting 配置（WP-029）

### Added

- 配置校验器和测试套件
- npm 打包支持

## [0.0.7] - 2026-04-12

### Added

- PluginLoader 真实模块加载和 PluginContext 依赖注入（WP-013）
- Provider DI、HookDispatcher、ValidatorPipeline（WP-014 ~ WP-016）

## [0.0.6] - 2026-04-08

### Fixed

- Skill 文件中已删除文件的过期引用
- Quick-mode 触发词补充"不要直接执行"关键词

### Added

- Watchdog daemon 集成为可选 Provider 插件

## [0.0.5] - 2026-04-05

### Added

- SessionStart Hook：通过 system-reminder 注入 plan-mode 规则到 CLAUDE.md

## [0.0.4] - 2026-04-02

### Changed

- 拆分 skill-agent-dispatcher 参考文档

## [0.0.3] - 2026-03-30

### Changed

- 批量执行技能改为 1:1 工作包-Subagent 绑定模式
- 包名从 `tackle` 重命名为 `tackle-harness`

## [0.0.2] - 2026-03-28

### Added

- 上下文窗口管理：防止任务创建技能处理大文档时上下文溢出
- 英文触发词支持

## [0.0.1] - 2026-03-27

### Added

- 初始发布：AI Agent Harness v3.0 插件框架
- 12 个 Skill 插件、1 个 Hook 插件、2 个 Validator、3 个 Provider
- CLI 工具：`build`、`validate`、`init`
- 插件注册表 (`plugin-registry.json`)
- 运行时层：harness-build、plugin-loader、event-bus、state-store、config-manager、logger

[0.0.19]: https://github.com/ph419/tackle/compare/v0.0.18...v0.0.19
[0.0.18]: https://github.com/ph419/tackle/compare/v0.0.17...v0.0.18
[0.0.17]: https://github.com/ph419/tackle/compare/v0.0.16...v0.0.17
[0.0.16]: https://github.com/ph419/tackle/compare/v0.0.15...v0.0.16
[0.0.15]: https://github.com/ph419/tackle/compare/v0.0.14...v0.0.15
[0.0.14]: https://github.com/ph419/tackle/compare/v0.0.13...v0.0.14
[0.0.13]: https://github.com/ph419/tackle/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/ph419/tackle/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/ph419/tackle/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/ph419/tackle/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/ph419/tackle/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/ph419/tackle/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/ph419/tackle/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/ph419/tackle/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/ph419/tackle/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/ph419/tackle/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/ph419/tackle/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/ph419/tackle/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/ph419/tackle/releases/tag/v0.0.1
