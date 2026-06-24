# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.13] - 2026-06-24

### Added

- **Agentic Loop per-round 阶段级可观测性（WP-196-1-impl）**：新增五段式（Observe/Think/Act/Reflect/Decide）阶段级耗时打点 + 逐轮 trace 落盘，回应「感觉不是五段式」的运行时不可见反馈。三层联动，全部纯观测、决策逻辑零改动：
  - 新增 `plugins/runtime/loop-trace.js`（+ `test/runtime/test-loop-trace.js`）：把 engine `step()` 的 `phaseTimings` + executor `_executorTrace` + 本轮 `verdict` 聚合成 round record，以 JSON Lines 追加到 `.tackle/loop-{loopId}/trace.jsonl`（崩溃可逐行回放，顺带修复 WP-194 根因⑥「运行时数据目录不存在」），并渲染一行式阶段摘要到 driver stdout。与 `loop-report.js` 解耦：后者是纯函数终态报告（无 IO），本模块负责增量落盘（有 IO 副作用）
  - `provider-loop-engine/index.js`：`step()` 内用 `timePhase()` 包裹五段式采集 `{phase, startMs, endMs, elapsedMs, summary}`，附到返回值 `phaseTimings`；新增 `_buildPhaseSummaries` 补各阶段产出摘要（observe 的 pendingWps、think 的 action/targetWp、reflect 的 proximity/diverged、decide 的 verdict）
  - `executor-default.js`（+ `executor-claude.js` 同步）：`run()` 采集 `{spawnMs, exitCode, timedOut, rateLimited}` 附到 `CheckResult._executorTrace`（下划线前缀表内部观测，reflection-evaluator 不消费），供 driver 聚合
  - `bin/commands/loop.js`：driver 新增 `emitRoundTrace`，在 dispatch 轮 / noop 轮 / 终态轮三处入口聚合落盘 + 一行摘要
- **观测降级纪律（承袭 WP-191）**：上述全部 IO/聚合路径均 try/catch 降级，`appendTrace` 写入失败只返回 `false` + warning，观测异常绝不阻断 loop 主流程

## [0.3.12] - 2026-06-23

### Changed

- **skill-agent-dispatcher v1.2.0 → v1.3.0**：对齐 Claude Code harness 升级后的 implicit single-team 模式。移除已失效的 `TeamCreate`/`TeamDelete` 显式编排步骤与 `Agent(team_name=...)` 参数；`team_name` 重定义为批次逻辑标签；`cleanup-reference` 的 `Step 7d/7e` 改用 `team-cleanup` CLI 并纠正旧描述。协作能力（并行 spawn + SendMessage + 共享 Task List）未丢失，仍由 implicit session team 提供
- 同步更新 `skill-agentic-loop`、`skill-workflow-orchestrator`、`skill-completion-report`、`skill-team-cleanup`、`roles-reference` 文档措辞，统一为 implicit session team 现状
- README（中/英）版本徽章同步至当前发布版本（修正 0.3.11 发布时遗漏的徽章更新）

### Fixed

- `test/integration/test-executor-claude-integration.js`：真实 claude binary 冒烟用例在第三方端点 TTFT 偏高时，将 `timeout` 从硬失败降级为 `t.skip()`（链路本身未损坏，仅环境慢无法判定）；`timeoutMs` 60s → 120s、node `timeout` 90s → 150s

## [0.3.11] - 2026-06-21

### Fixed

- **`--settings` 绝对路径逃逸检查误杀（WP-188 P6 回归）**：`bin/commands/loop.js` 原 P6 路径逃逸守卫对**绝对路径**也生效，导致用户指向 projectRoot 之外的全局 settings（如 `C:/Users/<user>/.claude/settings-glm-5.2[1m]max.json`，即 Claude Code 全局 settings 标准位置）被错误拦截并 `exit 2`。现按 P6 原意收窄：逃逸检查**仅对相对路径**生效（拦 `--settings=../../etc/x` 这类笔误/意外的 `..` 逃逸），绝对路径视为用户明确意图直接放行——`claude --settings` 本只读文件、下方 `existsSync` 已兜底存在性，对绝对路径做 projectRoot 囚禁无安全价值，反而拦掉最常见用法（全局 settings profile 切换）。错误信息同步从 `must be within project root` 改为 `relative path must be within project root`，避免误导

### Added

- `test/runtime/test-loop-driver.js`：新增 `execute：--settings 绝对路径（projectRoot 之外）→ 放行并透传` 回归（settings 文件放独立 tmpdir 模拟用户全局 `.claude` 目录，断言不触发 `exit 2`、不出现逃逸检查提示、`createExecutor` 仍被调用且 `opts.settingsPath` 原样透传）

### Verified

- `node --test test/runtime/test-loop-driver.js` 全量通过（59/0），含新增绝对路径放行回归

## [0.3.10] - 2026-06-21

### ⚠ BREAKING

- **删除 `--executor=glm`**：智谱 GLM 不再是独立 executor。改用 `--executor=default --settings=<glm-profile.json>`，由 `provider-resolver` 探测到 glm 模型后自动启用 5h 额度感知。`--executor=glm` 现抛 `UNKNOWN_EXECUTOR`（错误信息会列出可用 executor）。`--executor=claude` 保留为 `default` 的别名（向后兼容 v0.3.4~0.3.8），但 listProviders 不列别名，推荐显式用 `default`

### 🚚 从 0.3.8 迁移到 0.3.10（GLM 用户必读）

智谱 GLM 从「独立 executor」改为「单一 default executor + 自动探测」，迁移分 4 步：

1. **改 executor 名**：`--executor=glm` → `--executor=default --settings=<glm-profile.json>`。`--executor=glm` 现抛 `UNKNOWN_EXECUTOR`
2. **端点+认证改由 settings 文件携带**：原 glm executor 依赖 `ZHIPU_API_KEY` 环境变量注入（由 executor 在 spawn 前硬编码补 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`）。0.3.10 起 executor **不再注入任何环境变量**，端点（`ANTHROPIC_BASE_URL`）与认证（`ANTHROPIC_AUTH_TOKEN`/`apiKey`）全权交给 settings 文件
3. **生成/放置 settings 文件**：在 `~/.claude/` 下放一份指向智谱 anthropic 兼容端点的 settings JSON（如 `settings-glm-5.2[1m]max.json`），内含 `model`（如 `glm-5.2[1m]`，provider-resolver 据此匹配 glm 规则）+ `env` 段携带端点与认证。一份文件即一套套餐档位，多档位放多份，用 `--settings=` 按需切换（也可并存 mimo/deepseek 等其它 provider 的 settings 文件）
4. **`--executor=claude` 仍可用**：保留为 `default` 的别名（向后兼容 v0.3.4~0.3.8 的脚本），但推荐显式写 `--executor=default`，便于阅读与 listProviders 输出一致（别名不列出）

### Added

- **单一 `default` executor + 自动模型探测（WP-188 重构）**：把"真实 Anthropic / 智谱 GLM"两类 executor 合并为 `plugins/runtime/executor-default.js`。provider 不再焊死成 executor 名，而是由新增的 `plugins/runtime/provider-resolver.js`（"匹配程序"）探测生效模型并按规则匹配 provider profile，决定 default executor 启用哪些特性：
  - **模型探测顺序**（用户要求"配置文件优先于环境变量"）：`--settings` 文件的 `model` 字段 → 文件 `env.ANTHROPIC_DEFAULT_SONNET_MODEL`（fallback OPUS/HAIKU）→ 环境变量 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL`。三者都无 → provider=unknown（纯透传，不启用任何特性）
  - **匹配规则外置**到 `harness-config.yaml` 新增的 `loop.providers` 段（modelRegex / 可选 baseUrlRegex 二次确认 / 可选 quota 段）；loop.js 引入 `ConfigManager` 读取。无配置时用 resolver 内置 DEFAULT_PROVIDERS（glm/mimo/deepseek，开箱即用），可用 `HARNESS_LOOP__*` 环境变量覆盖
  - **智谱额度逻辑搬迁**：executor-glm 的 `isPeakHour`/`quotaCostFactor`/`createQuotaTracker` + 5h 窗口守卫搬到 executor-default，仅在探测到 glm 模型（`features.quotaAware=true`）时启用；mimo/deepseek/unknown 纯透传，不计额度。原 executor-glm 的端点 env 注入（`buildAnthropicEnv`/`resolveApiKey`）**删除**——端点+认证现全由 settings 文件携带，executor 不再注入环境变量
  - **`templates/harness-config.yaml`** 新增 `loop.providers` 段（glm 带完整 quota 配置，mimo/deepseek 纯透传），作为开箱默认
- **启动日志补 provider 探测结果**：`execute` 打印 `provider: glm (model=glm-5.2[1m]) [quota-aware]`，让用户直观看到探测命中

### Changed

- **`loop-executor.js`**：REGISTRY 删 `glm`、加 `default`；新增 `claude`→`default` 别名（`_ALIASES`，listProviders 不列别名避免歧义）；`createExecutor` 内做别名解析
- **`bin/commands/loop.js`**：引入 `ConfigManager` + `provider-resolver`；execute 对非 local executor 调 `resolveProvider` 拿 `{model, provider, quotaConfig}` 透传给 default executor；解析失败降级纯透传（回退安全，不阻断）
- **`loop-server-core.js`**：coordinator 原复用 `executor-glm._quotaCostFactor` 的高峰系数换算，改为复用 `executor-default._quotaCostFactor` + `provider-resolver` 的 GLM quotaConfig（同源无重复）
- `bin/commands/help.js` / `README.md` / `README.en.md`：loop 用法改为 `--executor=local|default`，示例改写为单一 default + 自动探测模型的新模型

### Removed

- `plugins/runtime/executor-glm.js`（整文件删除，逻辑迁至 executor-default + provider-resolver）
- `test/runtime/test-executor-glm.js`（逻辑迁至 test-provider-resolver.js + test-executor-default.js）

### Verified

- `npm test` 全量通过（1673/0；其中 `node --test` 的 test/runtime + test/integration 子集 1557/0），新增覆盖：`test-provider-resolver.js`（30 测：探测顺序/BOM strip/坏 JSON 容错/正则匹配/baseUrlRegex 确认/quota 提取/自定义 providers/正则编译容错/内部工具）、`test-executor-default.js`（23 测：args 构造/quotaAware 门控/高峰 3x-非高峰 2x/spawn 失败不计额度/限流超时/额度逻辑零漂移搬迁回归/接口契约）、`test-loop-executor.js`（13 测：default 路由/claude 别名/glm 抛错/listProviders 不含别名/opts 透传/接口契约同构）、`test-loop-driver.js`（execute 透传 model/provider/quotaConfig + 日志含探测结果 + --settings 逃逸拦截）、`test-loop-server.js`（43 测：含 coordinator 高峰系数读用户 config 的 resolveGlmQuotaConfig 回归）

## [0.3.9] - 2026-06-21

### Added

- **`tackle loop --settings=<path>` 动态切换 claude 配置**：loop 子命令新增 `--settings` flag，透传 claude CLI 原生 `--settings <file-or-json>`，把用户预先放好的多套 settings JSON（不同 provider 如 mimo/deepseek，或同一 provider 的不同套餐档位如智谱 `settings-glm-5.2[1m]max.json`）喂给 claude，而非仅靠其默认发现机制加载单一 `~/.claude/settings.json`。`bin/commands/loop.js` 的 `parseArgs` 解析该 flag（支持绝对/相对路径、含方括号/点等真实文件名），`execute` 在 chdir 前解析为绝对路径并做 `fs.existsSync` 校验（不存在则 exit 2），透传到 `createExecutor(opts.settingsPath)`；启动日志补 `settings:` 行
- **executor-claude / executor-glm 双双 settings-aware**：`buildClaudeArgs(allowedTools, settingsPath?)` 与 `buildGlmArgs(allowedTools, model, settingsPath?)` 在 settingsPath 非空时追加 `--settings`。glm executor 检测到 settings 接管时（`settingsManaged`），用 4 处守卫实现"settings 全权、跳过硬编码智谱专属逻辑"：① 跳过智谱 env 注入（`buildAnthropicEnv`），改用父进程 env 原样透传；② 跳过 `--model` 追加（model 由 settings 文件决定）；③ 跳过 apiKey 缺失前置拦截与额度前置检查（否则切 mimo 时会因没设 `ZHIPU_API_KEY` 直接 spawn 不出去）；④ close 后不 `quota.record()`（智谱额度模型对非智谱 provider 计量不准）
- **help / README 文档**：`bin/commands/help.js` 的 loop 用法块补 `--settings` 行；README.md / README.en.md 的 loop 代码块补 mimo / 智谱套餐档位 / 真实 Claude 三类切换示例，特性列表新增"配置可切换"条目，命令表行补 `--settings`

### Changed

- `buildClaudeArgs` / `buildGlmArgs` 签名向后兼容：新增参数均为可选，未传时输出与改造前逐字节一致（回归保护硬约束）

### Verified

- `node --test`（test/runtime + test/integration）全量通过（1582/0），其中 settings-aware 新增覆盖：`test-executor-claude.js`（--settings 透传 args / run spawn 断言）、`test-executor-glm.js`（settings 接管跳过 env 注入 / 跳过 apiKey 拦截 / 不计智谱额度 / 接近上限不降速）、`test-loop-driver.js`（parseArgs 解析 --settings / execute 透传 opts.settingsPath / 不存在文件 exit 2）

## [0.3.8] - 2026-06-21

### Changed

- **游离测试文件迁移纳入 CI**：将两份从未被 `scripts/test-runner.js` 扫描（该 runner 仅递归扫 `test/`，根目录与 `tests/` 均被忽略）的测试归位至 `test/runtime/`，使其自动纳入 `npm test`：
  - `test-validator-pipeline.js`（根目录）→ 已由 `test/runtime/test-validator-pipeline.js` 覆盖（40 测，commit `6feceaa` 引入），删除根目录死代码副本
  - `tests/wp-035-concurrency-test.js`（`tests/` 目录，注意有 s）→ `test/runtime/test-wp035-concurrency.js`，逻辑函数（`is_time_in_range` / `get_max_concurrent`）与断言语义完全保留，仅把 ES2015+（`const`/`for...of`/箭头函数）改写为 ES5（`var`/`for`/普通函数）与项目其他测试风格统一、Win/cmd 兼容性更好；8 测全通过
- **SECURITY.md 修正**：安全公告 URL 占位符 `github.com/user/tackle` → 实际仓库 `github.com/ph419/tackle-harness`（与 `package.json` 的 `repository.url` 一致）；支持版本矩阵 `0.2.x` / `< 0.2` → `0.3.x` / `< 0.3`（当前版本 `0.3.8`）

### Verified

- npm test 全量通过（1639/0），其中 `test/runtime/test-wp035-concurrency.js` 8 测、`test/runtime/test-validator-pipeline.js` 40 测均零回归

## [0.3.7] - 2026-06-21

### Fixed

- **README loop 示例路径修正**：`tackle loop` 冒烟示例原先指向从未被 git 跟踪的 `docs/plan/todo-cli-smoke.md`，现改为仓库内真实可跑的 `test/fixtures/todo-cli-smoke.md`——该文件符合 plan-reader 契约（`##` section + `- [ ]` checklist + 依赖声明 + 成功标准，首行即标注"供 skill-agentic-loop 读取执行"），用 `--executor=local` 可直接冒烟验证收敛。中英文 README（README.md / README.en.md）同步修正

## [0.3.6] - 2026-06-20

### Added

- **Agentic Loop Node 进程级 Driver（M1~M3，WP-184~187）**：把循环载体从「Claude 会话内伪代码 while 循环」升级为 **Node 进程级稳态循环**，解除与 Claude Code 的深度耦合。新增 `tackle loop <plan> [--executor=...] [--loop-id=X] [--max-iters=N]` 子命令（`bin/commands/loop.js`）：解析 plan → `new LoopEngine()` → `while(!terminal) step()` + 消费 `pendingAction` → executor.run → 回填 `lastChecklist` + 写 PROGRESS.md；退出码 achieved→0 / timeout·diverged·circuit_broken·aborted→1。engine 仅 `_decide` 增 noProgress 协同判据（+16/-2，向后兼容，详见下方 WP-191 Fixed），其余零改动（硬约束 #1：不触碰 `_think/_act/_reflect/_observe`）
- **provider 路由层与三 executor 实现（WP-185）**：新增 `plugins/runtime/loop-executor.js` 工厂（惰性 require + REGISTRY 注册），driver 只认 `createExecutor(provider, opts)`。三个 executor 实现同一份 `{ name, run(pendingAction)->Promise<CheckResult>, config }` 契约：
  - `executor-local.js`：mock 固定回 passed，供单测与冒烟（100/h 限流，不调真模型）
  - `executor-claude.js`（WP-187）：spawn `claude -p --output-format json`，注入 WP 文档/mode/strategy/failingDrivers 构造 prompt，解析 `json:machine-readable` block 为 CheckResult，git HEAD 前后对比做进展检测；`createExecutor({ spawnFn })` 注入 spawn 实现可测
  - `executor-glm.js`（WP-188）：复用 claude prompt+解析，spawn claude CLI 指向智谱 anthropic 兼容端点（`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`）+ `--model`；内置 5h 滚动窗口额度计数 + 高峰系数（高峰 3x / 非高峰 2x，仅 GLM-5.x），接近软阈值「降速返回」交由 driver 发散检测兜底（硬约束 #2）。**合规**：智谱套餐额度仅限官方编码工具内使用，走 claude CLI 中转享额度且合规，禁跨机共享 API Key
- **全局 loop coordinator 守护进程（M5，WP-189~190）**：新增 `tackle loop-server <start|status|list|abort>` CLI（`bin/commands/loop-server.js`）+ 纯逻辑核心 `plugins/runtime/loop-server-core.js`。扫 per-loop 隔离目录只读聚合全局视图（复用 `loop-coordinator.aggregateLoopStates`）、按 provider 分桶额度池（claude 500/5h、glm 400/5h、local ∞，超 0.95 阈值熔断）、两类熔断策略（任一 circuit_broken 触发全局回退 / provider 额度触顶兜底）。熔断只写独立 `directive.json` sidecar（单向通道，绝不写各 loop 的 `.claude-state`，规避多进程并发写），driver 每轮读命中后调本进程 `api.applyDirective`
- **per-loop state 目录物理隔离（WP-189）**：`--loop-id=X` 时建立 `{stateDir}/{loopId}/` 隔离目录（`.claude-state` / `PROGRESS.md` / `.executor` sidecar 全隔离）+ task.md 占位 + `process.chdir`，engine 基于 cwd 探测 projectRoot 自然指向隔离目录，物理规避 `.claude-state` 单文件多进程并发写丢数据（`state-store.js:19-23`）。不传 `--loop-id` 时回退 M1~M3 形态（回退安全）
- **provider 存活信号 sidecar**：driver init 后写 `.executor`（provider/startedAt/pid），coordinator 据此按 provider 分桶 + 以 mtime 作进程心跳（超 5min 标 stale/disconnected）

### Changed

- **CLI argv 透传**（`bin/tackle.js` / `bin/context.js`）：context 新增 `argv` 字段（命令名后的参数数组），`loop`/`loop-server` 等子命令据此解析自身参数；旧调用方默认 `[]` 不破坏
- **`loop-snapshot.js` WP 编号口径放宽 + 完成态兜底（WP-186）**：`parseProgressMarkdown` 与 `queryGitDiff` 的 WP 正则从 `WP-?\d+` 放宽到 `WP-?[\w-]+`（支持字母/混合编号如 WP-A / WP-175，与 engine `_think` 的 `goal.wpIds` 口径一致）；`buildWorkPackages` 新增 checklist 完成态兜底——`lastChecklist.passed===true` 且 wpId 在 goal 内时即使 PROGRESS.md 未写也视为 completed（防写入与 checklist 回填时序竞态）。抽取 `inGoalStatic` 供完成态兜底与 failed 越界保护共用

### Fixed

- **WP-191 Agentic Loop Node Driver 审查问题修复**（对 WP-184~190 未提交代码的独立深度审查，fine-grained 10 子包，2 P0 + 4 P1 + 7 项 P2/P3，新增 ~50 测试）：
  - **WP-190 守护进程心跳失效（P0）**：`.executor` sidecar 主循环刷新 mtime（`touchExecutorSidecar` 用 `fs.utimesSync`），每轮 step 前 + executor.run 前各 touch 一次，防单轮 executor.run >5min 致 coordinator 误判 disconnected
  - **WP-190 熔断指令无消费确认（P0）**：driver `applyDirective` 成功后清理 directive.json（`clearAbortDirective`）+ coordinator 兜底清理终态 loop 残留（`cleanupConsumedDirectives`），防 `--loop-id` 恢复时二次熔断 + 防 driver crash 残留
  - **WP-187 进展检测恒判无进展 + 接入发散熔断（P1，唯一改 engine）**：进展检测改用 `git status --porcelain` 工作树脏度（`readWorktreeDirty`/`applyProgressDetection`，glm 零漂移复用 claude），engine `_decide` 并列消费 `noProgressStreak`（与现有 proximity diverged 协同：任一连续 N 轮 → diverged），engine 用自身 `_config.divergence_threshold` 判 streak 防 evaluator.diverged 短路回归
  - **WP-190 loop-server stop 子命令（P1）**：PID 文件 + 跨平台 kill（Win `taskkill /F /T` / Unix `process.kill SIGTERM`），3 级降级（PID 缺失/进程已死/kill 异常均 exit 0 不阻断）
  - **WP-190 额度池口径 + model 传递（P1）**：model 统一通道 `executor.config.model`（driver 一行取值无 provider 分支，glm 真实/claude/local 占位），coordinator 硬阈值 0.95 > executor 软阈值 0.9 单测锁定避免双重触发
  - **WP-186 字母编号 plan-reader 放宽（P1）**：`extractExplicitWpId`/`extractDependencyRefs` 正则放宽为 `WP-?([A-Za-z0-9][\w-]*)`（与 loop-snapshot 口径对齐），依赖图字母编号不断裂
  - **P2/P3 批量 7 项**：glm 正则收紧 `^glm[-_]?5(?!\d)`、删死配置 wpDocsDir、spawn_error 不计额度（quotaRecorded 闸门）、限流文档对齐、**chdir finally 还原 cwd**（消除跨文件测试间歇失败根因）、listLoopIds 过滤 symlink（safePath.isSymlink）、sidecar 写失败 log warning（不再静默吞错）
  - **测试补齐**：todo-cli-smoke 真实 e2e、proximity 数值单调断言、staleMs 边界（Windows stop/noProgress 协同已由 impl 覆盖）
  - **文档对齐**：修正 WP-184~190 失实 checklist（WP-187 进展检测方法 `git rev-parse HEAD`→`git status --porcelain`、WP-190 stop CLI 描述）+ 移除误导注释（loop.js:194、executor-claude.js:438）
- **跨平台 CI 测试稳定性（`ed895b6` + `b52074a`）**：
  - **fixture ENOENT（全平台）**：`.gitignore` 的 `docs/*` 误伤 `test-wp191-test-gaps.js` 依赖的 plan fixture，CI checkout 后丢失；将 `todo-cli-smoke.md` 迁入 `test/fixtures/` 并跟踪
  - **S3 路径穿越守卫 `sourceEscapesRepoRoot()`（`resolve-plugin-path.js`，安全相关）**：在 `path.resolve` 之前新增字面层守卫，拦截 Windows 风格反斜杠 source——POSIX 主机 `path.resolve` 不识别反斜杠致 `assertWithinRepo` 失效。采用**扫描过程最小瞬时深度**（`minDepth < -1`）而非最终净深度：后者会被 `..\..\Windows\System32` 这类「先上爬再下钻」构造中和为 0 而漏判（Windows 靠 `assertWithinRepo` 兜底掩盖了本地回归）
  - **macOS `/var` ↔ `/private/var` 符号链接**：cwd 还原断言改用 `fs.realpathSync()` 双端规约后比较，消除 macOS-only 失败

### Verified

- npm test 全量测试通过（含新增 `test-loop-driver` / `test-loop-executor` / `test-executor-{local,claude,glm}` / `test-loop-server` / `test-loop-snapshot` WP-186 回归）
- **WP-191 验证**：npm test 1591 测零回归，coverage 88.58%（≥70% CI 阈值），真实 `tackle loop docs/plan/todo-cli-smoke.md --executor=local` 收敛 achieved（3/3 WP，proximity 1.000，4 轮），3 不变量核查通过（engine 改动范围受控仅 _decide +16/-2 / proximity 语义并列保留 / provider 零分支），chdir 跨文件测试间歇失败根因消除

## [0.3.5] - 2026-06-18

### Fixed

- **agent-dispatcher idle 自愈死亡螺旋修复**（WP-183，skill-agent-dispatcher 1.1.0 → 1.2.0）：修复 WP-182 引入的 idle 不执行检测 4 个逻辑缺口（F1-F4），其中 F3+F4 叠加形成「spawn 即判定 idle → 每轮自愈重 spawn → 瞬间熔断」死亡螺旋：
  - **F1**：idle 产物判定降级为弱信号——新增 `expected_product_path()` 伪函数，WP 文档体系暂无产物路径声明字段（assignment 亦无），返回 None 触发弱信号并标注 TODO（后续 WP 引入产物声明后升级为强信号）
  - **F2**：idle 计时起点改为从任务状态文件读取 `started_at`——新增 `read_task_file()`，原 fallback 链 `task.assigned_at` 因 TaskList task 对象无此字段恒为 None
  - **F3**：新增催促去重位 `idle_nudge_sent`（任务状态文件），首轮只 SendMessage 催促并给一个 `idle_threshold` 响应窗口、不立即重 spawn；下一轮仍 idle 且已催促才进重 spawn，阻断每轮重复催促 + 立即重 spawn 耗尽 `max_retries`
  - **F4**：重 spawn 时 `update_task_file(reset_started_at=True)` 一次调用同时刷新 `started_at` + 重置 `idle_nudge_sent=False` + 递增 `retry_count`，使新 Teamee 获得完整 idle_threshold 窗口；F3+F4 联动阻断死亡螺旋，`retry_count` 仅真正重 spawn 递增、`max_retries=3` 对应最多 3 次重 spawn

### Verified

- npm test 1349/0 零回归，build/validate 26 plugins 0 错误 0 警告，review 6 维度全 PASS

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
- 仓库 URL 从 `anthropics/tackle-harness` 修正为 `ph419/tackle-harness`

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

[0.3.13]: https://github.com/ph419/tackle-harness/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/ph419/tackle-harness/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/ph419/tackle-harness/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/ph419/tackle-harness/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/ph419/tackle-harness/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/ph419/tackle-harness/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/ph419/tackle-harness/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/ph419/tackle-harness/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/ph419/tackle-harness/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/ph419/tackle-harness/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/ph419/tackle-harness/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/ph419/tackle-harness/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ph419/tackle-harness/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ph419/tackle-harness/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/ph419/tackle-harness/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/ph419/tackle-harness/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/ph419/tackle-harness/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/ph419/tackle-harness/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/ph419/tackle-harness/compare/v0.2.2...v0.2.3
[0.2.1]: https://github.com/ph419/tackle-harness/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ph419/tackle-harness/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/ph419/tackle-harness/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ph419/tackle-harness/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ph419/tackle-harness/compare/v0.0.24...v0.1.0
[0.0.24]: https://github.com/ph419/tackle-harness/compare/v0.0.23...v0.0.24
[0.0.23]: https://github.com/ph419/tackle-harness/compare/v0.0.21...v0.0.23
[0.0.21]: https://github.com/ph419/tackle-harness/compare/v0.0.20...v0.0.21
[0.0.20]: https://github.com/ph419/tackle-harness/compare/v0.0.19...v0.0.20
[0.0.19]: https://github.com/ph419/tackle-harness/compare/v0.0.18...v0.0.19
[0.0.18]: https://github.com/ph419/tackle-harness/compare/v0.0.17...v0.0.18
[0.0.17]: https://github.com/ph419/tackle-harness/compare/v0.0.16...v0.0.17
[0.0.16]: https://github.com/ph419/tackle-harness/compare/v0.0.15...v0.0.16
[0.0.15]: https://github.com/ph419/tackle-harness/compare/v0.0.14...v0.0.15
[0.0.14]: https://github.com/ph419/tackle-harness/compare/v0.0.13...v0.0.14
[0.0.13]: https://github.com/ph419/tackle-harness/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/ph419/tackle-harness/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/ph419/tackle-harness/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/ph419/tackle-harness/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/ph419/tackle-harness/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/ph419/tackle-harness/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/ph419/tackle-harness/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/ph419/tackle-harness/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/ph419/tackle-harness/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/ph419/tackle-harness/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/ph419/tackle-harness/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/ph419/tackle-harness/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/ph419/tackle-harness/releases/tag/v0.0.1
