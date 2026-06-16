# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-06-16

### Added

- **`skill-tackle-plan` 目标驱动计划生成器 v1.0.0**（WP-178）：将自然语言需求分解为符合 plan-reader 契约的结构化计划，输出到 `docs/plan/`，对接 `skill-agentic-loop`，打通「需求 → 计划 → 自闭环」链路
- **`team-cleanup` CLI + `markTeameeDestroyed` 逻辑销毁**（WP-179）：根因消除 agent-dispatcher 批量执行反复弹出 SendMessage 协议帧拦截错误（WP-163/164/166 三次治标未除）——彻底放弃用 SendMessage 发 `shutdown_request`，改为从映射表移除的逻辑销毁 + 批末 `tackle-harness team-cleanup` 确定性清理团队目录；插件总数 25 → 26
- ralph-loop vs Tackle Harness 差异分析报告（WP-181，`docs/reports/`，仅调研文档不写代码）

## [0.3.3] - 2026-06-13

### Changed

- **`skill-agentic-loop` 深度改造**（1.0.0 → 1.1.0，WP-177）：新增读 `.claude/plan.md` 入口拆 WP；删除「单 WP 无失败预期即退化」规则、强制走 Agent Teams 子代理；`loop-actuator` 注入打通 `engine.step()` 端到端（移除占位 placeholder）；三重迭代上限可配置（`max_iterations` 默认 6、`max_round_time_ms`、`max_wall_time_ms`，均可 init override）；触顶/发散/熔断直接由 `loop-report` 出报告、不再回退 P1（保留 `applyDirective` 人介入通道）
- 新增 runtime 模块 `plan-reader`、`loop-actuator`、`loop-report`

### Verified

- npm test 1306/1306 全绿，覆盖率 Line 84.10%，build/validate 25 plugins 0 错误 0 警告

## [0.3.2] - 2026-06-13

### Fixed

- **打通 Agentic Loop retry 反馈链路**（WP-176）：修复 v0.3.0 三处断裂——① `loop-snapshot.buildWorkPackages` 的 `failed:[]` 写死导致 engine retry 分支永不命中，改为从 `checklist.failedItems` 聚合 wpId 填充；② `reflection-evaluator` 已算出 `failingDrivers` 但未回填 state、未进 dispatcher restart 注入重做 Teamee prompt，refine 通道端到端贯通（产出 → 回填 → Think 携带 → Step 4.2 → dispatcher 注入）；③ 发散判定含相等计数 + 阈值 3 致无效 retry 过快发散，新增「部分改进（失败项减少）不计入 divergenceStreak」发散宽容

### Verified

- npm test 1216/1216 全绿，覆盖率 82.96%，build/validate 25 plugins 0 错误 0 警告

## [0.3.1] - 2026-06-12

### Fixed

- 测试输出噪音清理：`loop-snapshot` 捕获 git 子进程 stderr，不再泄露 `fatal: ambiguous argument 'HEAD'`；`init`/`migrate` 预期降级路径由 `console.error` 改为 verbose-only warn，消除 `[tackle-harness] Error:` 误报；e2e plugin count 断言改为动态读 `plugin-registry.json`（不再硬编码 23）

### Added

- Agentic Loop 纯使用指南（`docs/reports/`，自包含深色主题 HTML）

### Verified

- npm test 1163/1163 全绿 0 噪音，覆盖率 82.51%，build/validate 25 plugins 0 错误 0 警告

## [0.3.0] - 2026-06-12

### Added

- **Agentic Loop 自主闭环**（WP-174）：新增决策状态机 `provider-loop-engine`（Observe → Think → Act → Reflect → Decide 五阶段，三类终止判定优先级 熔断 > 发散 > 上限 > 达成 > 继续，state-store 持久化防上下文压缩）、`loop-snapshot`（state-store / progress-tracker / watchdog / git-diff 四源环境感知聚合）、`reflection-evaluator`（proximity 评分 + 发散检测 + refine 建议）、`loop-coordinator`（多 loop 全局状态聚合）
- 新增 `skill-agentic-loop` 入口技能，五层映射现有 skill（P1=human-checkpoint / Observe=snapshot / Think=engine.think / Act=agent-dispatcher+checklist / Reflect=evaluator / Decide=engine._decide+watchdog）
- `skill-checklist` 输出 `json:machine-readable` CheckResult block 供机器消费（向后兼容现有 Markdown 表格，item.id 跨轮稳定）
- 130 个新增单元测试 + 端到端 P2↔P3 自主重试至达成 / 发散终止 / 熔断 / 触顶 / 状态持久化恢复场景验证

### Verified

- npm test 1154/1154 全绿，build/validate 25 plugins 0 错误 0 警告

## [0.2.7] - 2026-06-10

### Added

- **多窗口并行执行监控**（WP-172）：新增 `multi-window-coordinator.js`（556 行），提供多窗口会话状态聚合、数据结构工厂（session/window/heartbeat）、阶段转换协议、全局进度计算和 `current_batch` 修复
- **Watchdog 多会话扩展**（WP-172）：新增 `watchdog-multi-window.js`，实现 L4 跨窗口级检测 + L5 阶段级检测 + 全局熔断逻辑 + 跨窗口指令分发
- **skill-agent-dispatcher 多窗口支持**（WP-172）：skill.md 9 处修改 — 多窗口环境检测、Phase 0 阶段信号检查、6 处状态写入增加 `window_id`/`session_id`、心跳路径可变
- 多窗口监控单元测试（WP-172）：`test-multi-window-coordinator.js`（1230 行，71 个用例）+ `test-watchdog-multi-window.js`（1298 行，66 个用例），总计 137 个新增测试

### Verified

- WP-172 实现终审通过（WP-173）：5 个核心问题全部解决、945 测试 0 失败、build 23 插件通过、validate 0 错误、单窗口向后兼容确认无影响

## [0.2.6] - 2026-06-04

### Changed

- **CLI 命令目录重构**：`commands/` 下 13 个子命令模块移至 `bin/commands/`，与入口文件 `bin/tackle.js` 同级组织，消除 `../plugins/` 相对路径层级混乱
- **Hook 清理逻辑提取为共享模块**：从 `init.js` 和 `migrate.js` 中提取重复的 ~160 行 hook 清理代码到 `plugins/runtime/cleanup-utils.js`（DRY 重构），两个命令各减少约 80 行重复代码

### Added

- `plugins/runtime/cleanup-utils.js`：统一的 settings.json hook 清理工具模块，包含 `isLegacyLocalHook()` 和 `cleanupSettingsHooks()` 接口
- `test/runtime/test-cleanup-utils.js`：cleanup-utils 单元测试
- `test/runtime/test-migrate.js` 扩展 migrate 命令测试覆盖（+167 行）

### Fixed

- `bin/commands/init.js` 和 `bin/commands/migrate.js` require 路径修正（`../plugins/` → `../../plugins/`），适配目录重构后的正确引用
- `plugins/core/skill-task-creator/skill.md` 文档更新

## [0.2.5] - 2026-06-01

### Fixed

- **skill-tackle-sync 无差别删除项目级 Hooks 修复**（WP-165）：`migrate.js` 和 `init.js` 的 hook 清理逻辑添加 `tackleHooks` 白名单过滤 `['hook-skill-gate', 'hook-session-start']`，防止误删非 tackle-harness 的项目级 hooks，新增 8 个测试覆盖 migrate+init 各 4 场景
- **skill-agent-dispatcher SendMessage 所有调用添加 summary**（WP-166）：skill.md SendMessage 规范更新为「所有调用都需要 summary」，5 处 shutdown_request + cleanup-reference.md 2 处 + roles-reference.md 1 处共 8 处 SendMessage 调用补充 summary 参数，监控循环注释同步更新

## [0.2.4] - 2026-06-01

### Fixed

- **skill-agent-dispatcher SendMessage 误用根因消除**（WP-163）：13 处 `print()` 伪代码歧义调用替换为明确注释，"主动共享"表格从误导性 `message` 类型修正为仅 `shutdown_request`/`shutdown_response` 两种 object 类型，监控循环新增 SendMessage 约束规则（仅 shutdown_request、禁止 string message）
- **skill-agent-dispatcher SendMessage 使用规范防御层**（WP-164）：skill.md 新增 SendMessage 3 条使用规范 + 正误示例章节，roles-reference.md Teamee Prompt 模板添加 SendMessage 注意事项（object 优先、string 须带 summary），cleanup-reference.md 伪代码同步消除 print() 歧义

## [0.2.3] - 2026-05-31

### Fixed

- **跨平台绝对路径检查**：`resolve-plugin-path.js` 新增 `isAbsolutePath()` 辅助函数，兼容 POSIX/Windows 双平台路径识别，修复 macOS/Ubuntu CI 上 3 个测试因 `path.isAbsolute()` 平台特定行为导致失败的问题（WP-161）
- **测试平台条件断言**：`test-global-install.js` 添加 `process.platform === 'win32'` 条件保护，消除 POSIX 环境下 Windows 路径断言失败

## [0.2.2] - 2026-05-31

### Fixed

- **CI 跨平台 glob 兼容性修复**：新建 `scripts/test-runner.js` 跨平台测试运行器，使用 Node.js `fs` 模块递归发现测试文件，替代依赖 shell glob 展开的 `test/**/*.js` 模式，修复 Windows（cmd.exe 不展开 `**`）、Ubuntu（sh/dash 无 globstar）等所有 CI 环境下 `npm test` 失败的问题

## [0.2.1] - 2026-05-31

### Fixed

- **文档断链修复**：将 README.md、README.en.md、CONTRIBUTING.md 及 examples 目录下所有相对路径链接改为绝对 GitHub URL，确保在 GitHub、npm 等所有平台均可正常点击跳转
- **CONTRIBUTING.md 路径错误修复**：修正 `docs/xxx.md` → `docs/design/xxx.md` 的错误路径

## [0.2.0] - 2026-05-31

### Added

- **CLI 模块化重构**：`bin/tackle.js`（~1800 行）拆分为 `bin/context.js` + `commands/` 13 个子命令模块（build、validate、init、migrate、interactive、status、config、list、install、setup-global、version、help、validate-config），职责清晰、可独立测试（WP-130~134）
- **沙箱系统**：基于 Worker Threads 的插件沙箱执行环境，包含 `sandbox-manager`（生命周期管理、并发限制）、`sandbox-worker`（隔离执行）、`sandbox-context`（受限 API 暴露），支持超时清理和路径验证（WP-135~138）
- **安全加固**：CI/CD 权限降级为 `contents: read` 最小特权；YAML 解析器增加 100KB 大小限制和 10 层深度限制；`.gitignore` 新增 `*.key`、`*.pem`、`*.secret`、`credentials*` 等安全规则（WP-140~143）
- **SECURITY.md 安全策略文档**：漏洞报告流程、支持版本范围、安全更新策略
- **JSON Schema 契约**：`config-schema.json`（配置校验）和 `plugin-schema.json`（插件清单校验），支持 Ajv 可选校验（WP-115）
- **Capabilities 能力模型**：`plugins/contracts/capabilities.js` 统一插件能力声明和查询接口
- **审计日志**：`audit-logger.js` 结构化事件记录，支持可插拔输出目标
- **CLAUDE.md 注入器**：`claude-md-injector.js` 动态生成和注入 CLAUDE.md 项目指令
- **YAML 解析器**：`yaml-parser.js` 独立 YAML 解析模块，内置安全限制
- **插件校验器**：`plugin-validator.js` 全面的插件格式和契约校验
- **路径解析器**：`resolve-plugin-path.js` 统一插件路径解析，支持全局和本地模式
- **设置合并器**：`settings-merger.js` 多级配置（全局/项目/本地）合并策略
- **构建 CLI 提取**：`build-cli.js` 从 `harness-build.js` 中提取 CLI 相关代码，职责分离
- **E2E 测试套件**：`test/e2e/test-init-build-validate.js` 完整的 init → build → validate 端到端验证
- 14+ 新增测试文件，750+ 测试用例

### Changed

- **统一 Logger**：所有运行时模块统一使用 `logger.js`，移除 `console` 直接调用
- **harness-build.js 大幅精简**：从 ~1200 行重构至 ~250 行，CLI/校验/构建逻辑分离到独立模块
- **config-validator.js 重构**：JSON Schema 驱动校验，代码量从 ~200 行降至 ~50 行
- **manifest-resolver.js 增强**：插件路径解析和清单合并逻辑扩展
- **plugin-loader.js 增强**：能力检查和沙箱集成
- Watchdog 插件版本号升级至 1.0.0
- skill-role-manager 依赖格式统一为 `provider:role-registry`
- Plugin 接口更新，增加能力声明支持
- `.npmignore` 扩展，排除测试和开发文件
- 文档归档：6 个旧版 `docs/` 技术文档移除（内容已合并到 README 和 CLAUDE.md）

### Verified

- 750+ 测试全通过（runtime、integration、e2e），0 失败
- 23 plugins 构建成功，validate 0 errors
- `npm pack` 无敏感文件泄露

## [0.1.2] - 2026-05-25

### Fixed

- README.md 修正本地安装模式技能数量（13 → 15）
- README.md 移除重复的交互式模式描述段落
- installation.md 将过时的 tackle-init 更正为 tackle-sync
- daily-workflow-guide.md Skill 速查表补充 tackle-sync 和 task-archive

### Changed

- 统一 docs/ 目录下所有技术文档的版本号引用至 0.1.2
- best-practices.md、daily-workflow-guide.md、plugin-development.md、ai_workflow.md 版本标识同步更新

## [0.1.1] - 2026-05-22

### Fixed

- 移除 6 个 Skill 文档中的三位数编号硬约束，使 WP 编号支持任意位数（WP-1 ~ WP-9999+）（WP-057 ~ WP-060）
  - `skill-split-work-package`: `WP-XXX (三位数字)` → `WP-NNN (数字编号，无位数限制)`，子任务 ID 同步去除零填充
  - `skill-task-creator`: 添加编号说明注释，明确 `XXX` 为数字占位符而非固定位数
  - `skill-batch-task-creator`: 新增三位/四位混合示例说明，去除连续性三位假设
  - `skill-agent-dispatcher`: 架构图和命名规范中补充四位编号示例
  - `skill-completion-report`: 报告模板和验证命令中添加任意位数说明
  - `skill-progress-tracker`: 示例表和 Format 说明中补充四位编号示例

### Verified

- 164 个测试全通过（两轮独立验证），23 plugins 构建 0 error

## [0.1.0] - 2026-05-17

### Changed

- `skill-tackle-init` 升级为 `skill-tackle-sync`：合并 init/build/migrate 为单一技能，自动检测项目状态（未初始化/已初始化/旧版残留）并执行对应操作，无需用户手动选择命令（WP-053, WP-054）

## [0.0.24] - 2026-05-17

### Added

- `skill-task-archive` 任务归档技能：将 task.md 中已完成的工作包归档到 `docs/archive/`，保持 task.md 精简（WP-052）

### Changed

- 插件总数从 21 更新为 23（Skill 从 13 增至 15），同步更新 README、CLAUDE.md 及全部文档中的引用

## [0.0.23] - 2026-05-09

### Changed

- 全局安装文档全面更新：README、installation.md、best-practices.md、daily-workflow-guide.md、config-reference.md 重写为全局安装优先的架构说明（WP-048~051）

### Fixed

- CLI 全局 skill 目录名去除 `skill-` 前缀，修复 Claude Code 中 slash command 显示为 `/skill-tackle-init` 而非 `/tackle-init` 的问题

## [0.0.21] - 2026-05-09

### Added

- `skill-tackle-init` 全局初始化技能：通过 `tackle-harness setup-global` 或 npm postinstall 安装到 `~/.claude/skills/`，用户可在任意项目目录触发"初始化 tackle"

## [0.0.20] - 2026-05-08

### Added

- **ManifestResolver** (`plugins/runtime/manifest-resolver.js`): 项目级插件选择系统，通过 `.claude/harness-manifest.json` 覆盖全局 `plugin-registry.json` 的启用状态。仅记录差异项，新插件自动生效
- `init` 命令自动创建 `harness-manifest.json`，打印插件启用统计
- Interactive 模式 (`tackle-harness i`) 改为写入项目 manifest 而非全局 registry
- 全局安装单元测试套件 (`test/test-global-install.js`)，覆盖路径解析、manifest 合并/降级、跨平台兼容性等 10 组测试

### Changed

- **全局安装支持**：`harness-build.js` 区分 `packageRoot`（tackle-harness 所在目录）和 `targetRoot`（用户项目目录），全局安装时生成绝对路径的 hook 命令，本地安装时使用相对路径
- `hook-skill-gate` 和 `hook-session-start` 新增 `resolvePackageRoot()` 函数，从 hook 所在位置向上查找 tackle-harness 包根目录，确保全局安装时正确读取 `plugin-registry.json`
- `discoverGatedSkills()` 路径修复：拼接 `plugins/core/{source}/plugin.json`，补回缺失的 `core/` 段
- Hook 命令路径统一使用正斜杠，确保 Windows 跨平台兼容

### Verified

- 188 个测试全部通过（含 10 组新增全局安装测试）
- `validate` 和 `build` 命令在全局链接模式下正常工作

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

## [0.0.17] - 2026-04-27

### Fixed

- `harness-build.js` 构建时自动复制 skill 插件的伴生参考文件（如 `roles-reference.md`、`cleanup-reference.md`）到输出目录，并重写 skill.md 中的路径（`plugins/core/{name}/` → `.claude/skills/{name}/`），修复全局安装后参考文件找不到的问题

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

[0.3.4]: https://github.com/ph419/tackle/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/ph419/tackle/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/ph419/tackle/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ph419/tackle/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ph419/tackle/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/ph419/tackle/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/ph419/tackle/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/ph419/tackle/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/ph419/tackle/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/ph419/tackle/compare/v0.2.2...v0.2.3
[0.2.1]: https://github.com/ph419/tackle/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ph419/tackle/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ph419/tackle/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ph419/tackle/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ph419/tackle/compare/v0.0.24...v0.1.0
[0.0.24]: https://github.com/ph419/tackle/compare/v0.0.23...v0.0.24
[0.0.23]: https://github.com/ph419/tackle/compare/v0.0.21...v0.0.23
[0.0.21]: https://github.com/ph419/tackle/compare/v0.0.20...v0.0.21
[0.0.20]: https://github.com/ph419/tackle/compare/v0.0.19...v0.0.20
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
