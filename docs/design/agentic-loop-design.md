# Agentic Loop 设计文档（WP-174-1-research）

> **工作包**: WP-174 — Tackle Harness Agentic Loop 设计与实现
> **阶段**: Step 1 现状深度调研 + 方案正式化
> **作者**: architect-t1
> **日期**: 2026-06-12（M1~M3 于 v0.3.4，M4/M5 于 v0.3.6 追加 §11）
> **目标版本**: v0.3.0（核心）→ v0.3.6（Node Driver + provider 解耦）
> **父文档**: `docs/wp/WP-174.md`

本文档把 WP-174 的 Agentic Loop 方案（循环体、复用边界、接口契约意图、终止条件）正式化为**可指导后续 7 个实现子工作包（WP-174-2~8）**的设计蓝图。所有现状结论均带 `file:line` 证据；所有接口契约均具体到方法签名与数据结构。

> §1~§10 对应 v0.3.0~v0.3.4 的 skill 内伪代码循环（M1 之前形态）。§11 记录 v0.3.4~v0.3.6 的演进：把循环载体从「Claude 会话内伪代码」升级为「Node 进程级 driver」（WP-184~187），并补齐 provider 真换（WP-188 GLM）与多 loop 真并行（WP-189/190）——这是解除与 Claude Code 深度耦合的最终形态。

---

## 目录

1. [设计目标与作用域](#1-设计目标与作用域)
2. [现状深度调研（差距分析）](#2-现状深度调研差距分析)
3. [主流模式调研](#3-主流模式调研react--reflection--evaluator-refine)
4. [循环体定义（Observe→Think→Act→Reflect→Decide）](#4-循环体定义observethinkactreflectdecide)
5. [接口契约定义（WP-174-2~5 实现蓝图）](#5-接口契约定义wp-174-25-实现蓝图)
6. [三类终止条件精确判定逻辑](#6-三类终止条件精确判定逻辑)
7. [半自主安全边界与回退路径](#7-半自主安全边界与回退路径)
8. [状态持久化与上下文压缩防护](#8-状态持久化与上下文压缩防护)
9. [风险与迁移路径](#9-风险与迁移路径)
10. [后续 WP 实现指引](#10-后续-wp-实现指引)
11. [Node 进程级 Driver 与 provider 解耦（M1~M5，WP-184~190）](#11-node-进程级-driver-与-provider-解耦m1m5wp-184190)

---

## 1. 设计目标与作用域

### 1.1 目标

把现有"线性 + 人驱动"的 P2→P3 升级为"目标驱动 + 自主闭环 + 人监督"的 agentic loop：

- 一个含 checklist 失败项的任务能**自主 P2→P3→P2 重试**至达成；
- 触顶/发散/熔断时**自主输出总结报告**（WP-177 后不再强制回 P1；人仍可经 applyDirective 主动介入）；
- 状态持久化防上下文压缩丢失。

### 1.2 作用域边界（半自主）

| 阶段 | 由谁驱动 | 是否纳入 loop |
|------|---------|--------------|
| P0 规划 | 现有 skill（task-creator / split-work-package） | ❌ 不纳入（除非发散回 P1 由人决定） |
| P1 审核 | human-checkpoint（保留人介入点） | ❌ 不纳入（loop 的入口与回退点） |
| **P2 执行** | **agent-dispatcher（Act）** | ✅ 纳入 loop |
| **P3 检查** | **checklist + reflection-evaluator（Reflect）** | ✅ 纳入 loop |
| P4 汇报 | completion-report | ❌ 不纳入（loop 达成后触发） |

**核心作用域**：loop 仅在 **P2↔P3** 间自主循环，不越界到 P0 重新规划。

---

## 2. 现状深度调研（差距分析）

### 2.1 现有模块可复用边界（带 file:line 证据）

#### 2.1.1 state-store.js（Observe 层状态持久化）

**位置**: `plugins/runtime/state-store.js`

| 能力 | 证据 | loop 用途 |
|------|------|----------|
| KV 读写 + dot-notation 嵌套 | `get(key)` `:197` / `set(key,value)` `:209` / `_getNested` `:308` | loop 状态持久化（迭代计数、历史判定） |
| subscribe 订阅通知 | `subscribe(key,cb)` `:250`，set 时回调 `(key,oldValue,newValue)` `:222` | 监听 checklist 结果变化触发 Reflect |
| 原子写（temp+rename） | `write()` `:106-139` | 防 loop 状态写坏 |
| 损坏恢复（备份空状态） | `read()` `:81-93` | loop 状态文件损坏时降级 |
| keys / invalidate | `:274` / `:283` | 调试与强制重载 |

**关键限制（必须遵守）**: `:19-23` 明确写"This implementation is NOT safe for concurrent writes from multiple processes... Concurrent writes may result in last-write-wins data loss." → **多 loop 实例并发写同一 state key 会丢数据**。WP-174-5 的多 loop 协调必须为每个 loop 实例分配独立 state namespace（如 `loop.{loopId}.iteration`），或加文件锁。

#### 2.1.2 event-bus.js（Observe/Reflect 事件通信）

**位置**: `plugins/runtime/event-bus.js`

| 能力 | 证据 | loop 用途 |
|------|------|----------|
| on/once/off/emit | `on` `:45` / `once` `:73` / `emit` `:108` | loop 阶段事件广播（`loop.iteration.start`、`loop.reflect.done`） |
| 同步分发 + 错误隔离 | `:121-129`（handler 异常被 catch 不传播） | 单个 Reflect handler 出错不阻断 loop |
| 历史记录 + 查询 | `getHistory(filter)` `:142`，maxHistory 默认 100 `:33` | loop 调试追溯历史判定 |

**注意**: emit 是同步的（`:119` handlers.forEach 同步调用），适合 loop 内单轮同步事件；跨 loop 实例异步通信应走 state-store 文件信号（参考 agent-dispatcher daemon-actions）。

#### 2.1.3 agent-dispatcher 监控循环（Act 层骨架）

**位置**: `.claude/skills/skill-agent-dispatcher/skill.md:336-856`

这是 loop **Act 层最完整的参考实现**，已有 30s 轮询循环 + 状态持久化 + 外部指令通道：

| 已有能力 | 证据 | 在 loop 中的复用 |
|---------|------|----------------|
| 监控循环（while + sleep 30s） | `loop_interval=30` `:344`，`while (now()-start_time)<max_wait_time` `:418` | Act 层执行节奏（loop 可复用或缩短） |
| **状态持久化防上下文压缩** | `state_file=dispatcher-state.json` `:349`，每 Phase 写回 `:415/:543/:637/:782`，Phase 0 从文件恢复 `:421-438` | loop-engine 状态持久化的**直接模板** |
| 心跳写入（外部可观测） | heartbeat_data `:481-496`，DISP-001 | loop 心跳，供 watchdog 监控 |
| **外部指令通道（daemon-actions）** | `:639-762`：restart / abort / pause / abort_all 四类指令 | **回 P1 人介入的实现路径**（loop 可被外部 pause/abort） |
| 批次控制（max_batch_size） | `:551-562`、`:824-854` | Act 层并发与批量节流 |
| 多窗口阶段信号 | `:440-475` | 多 loop 实例协调参考 |
| 即时销毁已完成 Teamee | `:498-523` | Act 层资源释放 |
| 重启策略（full_restart / checkpoint_resume） | `:682-700` | Reflect 判定重试时的策略选择 |

**关键差距**: dispatcher 的退出条件是"所有任务 completed"（`:788` `completed==total`），**没有 checklist 失败→重试的闭环**——这正是 loop 要补的 P2→P3→P2 回环。dispatcher 是"任务调度循环"，loop 是"目标驱动循环"，前者是后者 Act 层的一个执行单元。

#### 2.1.4 checklist skill（Reflect 评判，机器可读缺口）

**位置**: `.claude/skills/skill-checklist/skill.md`

| 现状 | 证据 | 缺口 |
|------|------|------|
| 5 类检查（代码质量/测试/文档/Git/经验） | `:54-89` | — |
| 输出格式：**Markdown 表格报告** | Report Template `:103-124`：`类别 / 通过/总数 / 状态` 表 + `未通过项` 列表 | **无机器可读结构化输出**（reflection-evaluator 无法消费） |
| 检查未通过→修复（由人） | `:128` "检查未通过时，应修复后再提交" | **无人介入回退路径** |

**核心缺口确认**: checklist 当前只产出人类可读 Markdown（`:111-118` 表格 + `:120` 未通过项），reflection-evaluator 需要的是可程序解析的判定结构（JSON：每项 pass/fail + category + reason）。WP-174-3 必须增强 checklist 输出**机器可读判定契约**（详见 5.4），且**向后兼容**现有人类可读 Markdown（在 Markdown 末尾追加 fenced JSON block）。

#### 2.1.5 multi-window-coordinator.js（多 loop 协调参考）

**位置**: `plugins/runtime/multi-window-coordinator.js`

| 能力 | 证据 | loop 用途 |
|------|------|----------|
| 聚合多实例状态 | `aggregateWindowStates(windowsDir)` `:157` | 多 loop 实例聚合（loop-engine 复用此模式） |
| 单实例状态判定（active/idle/disconnected/completed） | `aggregateSingleWindow` `:220`，stale 阈值 120s `:226` | 单 loop 实例健康判定 |
| 全局状态计算（allCompleted/anyFailed/anyActive） | `computeSessionStatus` `:265-292` | 多 loop 全局收敛判定 |
| 阶段推进协议 | `advanceStage` `:372`、`writeStageSignal` `:440` | 多 loop 阶段协调信号 |
| current_batch 持久化修复 | `resolveCurrentBatch` `:473`、`buildStatePayload` `:505` | loop 状态写回防丢失的参考 |

**复用结论**: WP-174-5 多 loop 协调**不要重写**，应直接复用 `aggregateWindowStates` 模式，把 loop 实例当作"逻辑窗口"。

#### 2.1.6 provider-watchdog（熔断兜底）

**位置**: `plugins/core/provider-watchdog/`

| 能力 | 证据 | loop 用途 |
|------|------|----------|
| 状态查询 API | `index.js`：`isRunning()` `:77`、`isDeployed()` `:52`、`getStatusFilePath()` `:69` | loop-engine 查 watchdog 健康决定是否熔断 |
| 守护进程健康判定 | `health !== 'terminated'` `:84` | 熔断触发条件之一 |
| 部署资产（watchdog.js + multi-window） | `assets/watchdog.js`、`assets/lib/watchdog-multi-window.js`、`metadata.deploy_assets` `plugin.json:9` | loop 熔断的底层守护 |

**集成方式**: loop-engine 通过 `context.getProvider('provider:watchdog')` 查询 `isRunning()`，watchdog daemon 检测到 loop 卡死时通过 daemon-actions（restart/abort）干预。

### 2.2 差距表：现有模块 vs loop 必须补的能力

| loop 能力层 | 现有模块 | 差距（必须新增） |
|------------|---------|----------------|
| **决策状态机**（目标判定 + 下一步 + 是否重试） | ❌ 无中心决策器 | **`provider-loop-engine`**（WP-174-2，核心） |
| **环境快照聚合** | state-store（仅 KV）/ progress-tracker（部分） | **`loop-snapshot`** 聚合器（WP-174-3）：统一聚合未完成 WP / 上轮 checklist 结果 / watchdog 健康 / git diff |
| **P2→P3→P2 回环通道** | dispatcher 只有 P2 调度，无 P3 回环 | loop-engine 驱动 dispatcher→checklist→决策重试（WP-174-4 集成） |
| **收敛/发散判定** | ❌ 无接近度评分、无发散检测 | **`reflection-evaluator`**（WP-174-3） |
| **checklist 机器可读输出** | 仅 Markdown（`:103-124`） | **增强 checklist 输出 JSON 判定契约**（WP-174-3） |
| **三类终止判定** | dispatcher 仅"completed==total" | **终止判定器**（WP-174-5） |
| **用户入口** | ❌ 无 `/skill-agentic-loop` | **`skill-agentic-loop`**（WP-174-4） |
| **多 loop 协调** | multi-window-coordinator（窗口维度） | 复用，按 loop 实例适配（WP-174-5） |
| **熔断兜底** | provider-watchdog | 复用，loop-engine 查询（WP-174-5） |

---

## 3. 主流模式调研（ReAct / Reflection / Evaluator-Refine）

### 3.1 通用模型

HuggingFace Agents Course（Unit 1）将 agent 工作定义为一个连续循环：**Thought（思考）→ Act（行动）→ Observe（观察）**，其中 Thought 是 LLM 的内部推理。这是本方案的通用理论基础。

来源：[HuggingFace Agents Course — Agent Steps and Structure](https://huggingface.co/learn/agents-course/en/unit1/agent-steps-and-structure)

### 3.2 三大主流模式 → loop 层映射

| 模式 | 核心思想 | 权威来源 | 映射到本 loop |
|------|---------|---------|--------------|
| **ReAct**（Reason + Act） | 推理与行动交错：先思考再调用工具，观察结果后再思考。结构化 Thought→Action→Observation | [HF Agents Course](https://huggingface.co/learn/agents-course/en/unit1/agent-steps-and-structure)、[IBM ReAct](https://www.ibm.com/think/topics/react-agent) | **Act 层**：loop 的 Think→Act 子循环，think 决定调度哪个 WP，act 由 dispatcher 执行，observe 看执行结果 |
| **Reflection**（自我评估精炼） | LLM 评估自身输出，识别不足并改进，迭代提升质量。Strands Agents 的 reflection pattern 含 HITL 反馈环 | [AWS Builder — Reflection Pattern](https://builder.aws.com/content/2zo16pNcEvQHtHpwSaxfFr8nf37/ai-agents-design-patterns-reflection-pattern-using-strands-agents) | **Reflect 层**：reflection-evaluator 对 checklist 结果评分，experience-logger 提炼经验 |
| **Evaluator-Refine**（evaluator-optimizer / review loop） | 用一个 LLM（evaluator）批判另一个（generator）的输出，反馈驱动 refine，直到达标。Generator ↔ Evaluator 反馈环 | [AWS Prescriptive Guidance — Evaluator reflect-refine loop](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html)、[Workflow for evaluators and reflect-refine loops](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/workflow-for-evaluators-and-reflect-refine-loops.html) | **P2↔P3 闭环的核心理论**（见 3.3） |

### 3.3 重点论证：Evaluator-Refine 作为 P2↔P3 闭环理论基础

AWS Prescriptive Guidance 的 **Evaluator reflect-refine loop pattern** 定义：用一个 evaluator 评估 generator 输出，反馈驱动 refine 迭代，直到满足质量标准。这正是本方案 P2↔P3 闭环的形式化：

```
Generator (P2 执行, agent-dispatcher)  →  Evaluator (P3 checklist + reflection-evaluator)
        ↑                                              │
        └────────── feedback (失败项 → refine) ────────┘
```

**精确映射**：

| Evaluator-Refine 概念 | 本 loop 对应 |
|----------------------|-------------|
| Generator | Act 层：agent-dispatcher 执行 WP（产出代码/文档） |
| Evaluator | Reflect 层：checklist（机器可读判定）+ reflection-evaluator（收敛/发散/接近度评分） |
| Refine 反馈 | Think 层：失败项 → 决定重试哪个 WP / 是否需新拆分 / 用什么策略（full_restart / checkpoint_resume） |
| 终止条件 | Decide 层：达标跳出进 P4 / 触顶·发散·熔断自主出报告（WP-177） |
| HITL（Human-in-the-loop） | P1 human-checkpoint（AWS reflection pattern 也含 HITL 反馈环） |

**理论支撑的结论**：

1. P3 checklist 失败不应"等人修复"（现状 `skill-workflow-orchestrator/skill.md:208`），而应作为 evaluator 反馈**自动驱动 P2 refine**——这正是 evaluator-refine pattern 的核心价值。
2. 反馈必须**结构化**（每项 pass/fail + reason），所以 checklist 机器可读输出是 evaluator-refine 落地的**前提**（缺它则 evaluator 无法程序化消费反馈）。
3. Evaluator-Refine 天然有"迭代上限"防无限循环——对应本 loop 的三类终止条件（达成/上限/发散）。

---

## 4. 循环体定义（Observe→Think→Act→Reflect→Decide）

### 4.1 循环伪代码

```
P1 human-checkpoint 确认（不变，loop 入口）
   ↓
┌─────── Agentic Loop（P2↔P3 自主闭环）────────────────────┐
│ 初始化: 从 state-store 恢复 loop 上下文（防上下文压缩）       │
│ while (目标未达成 ∧ 迭代 < 上限 ∧ 未熔断 ∧ 未发散):          │
│   iteration += 1                                            │
│   Observe  : snapshot = loop-snapshot.aggregate()           │
│              （未完成 WP / 上轮 checklist 结果 / watchdog / git diff）│
│   Think    : decision = loop-engine.think(snapshot)         │
│              （选下个 WP？checklist 失败重试哪个？需新拆分？接近度？）│
│   Act      : loop-engine.act(decision)                      │
│              （agent-dispatcher 执行 WP → checklist 重验）    │
│   Reflect  : eval = reflection-evaluator.score(snapshot, checklist)│
│              + experience-logger 提炼经验                    │
│   Decide   : verdict = loop-engine.decide(eval, iteration)  │
│              达成→跳出进 P4 | 发散/触顶→自主出报告(WP-177) | 否则下一轮│
│   persist  : state-store.set('loop.{id}.iteration', ...)    │
└────────────────────────────────────────────────────────────┘
   ↓
P4 completion-report（不变）
```

### 4.2 五层职责

| 层 | 职责 | 实现模块 | 复用/新增 |
|----|------|---------|----------|
| **Observe** | 聚合环境快照（统一感知层） | `loop-snapshot` | 新增（聚合 state-store/progress-tracker/watchdog/git diff） |
| **Think** | 目标接近度判定 + 下一步决策 | `provider-loop-engine.think()` | 新增（核心状态机） |
| **Act** | 执行 WP + 重验 checklist | agent-dispatcher + checklist | 复用（loop-engine 驱动） |
| **Reflect** | 收敛/发散/接近度评分 + 经验提炼 | `reflection-evaluator` + experience-logger | 新增 evaluator / 复用 logger |
| **Decide** | 三类终止判定 | `provider-loop-engine.decide()` | 新增（含熔断查询 watchdog） |

---

## 5. 接口契约定义（WP-174-2~5 实现蓝图）

> 所有 provider 遵循 `Plugin` 基类（`plugins/contracts/plugin-interface.js:55-87`），实现 `ProviderPlugin`（`:189-206`），通过 `factory(context)` 返回 API 对象（参考 `provider-state-store/index.js:144-210`）。runtime 模块用 `var` 风格（项目约定）。

### 5.1 provider-loop-engine（WP-174-2 核心，决策状态机）

**位置**: `plugins/core/provider-loop-engine/`（provider，`provides: "provider:loop-engine"`）

**plugin.json**（WP-177 后阈值更新，三处 config 一致：plugin.json / `DEFAULT_CONFIG` / `plugin-registry.json`）:
```json
{
  "name": "provider-loop-engine",
  "version": "1.0.0",
  "type": "provider",
  "description": "Agentic Loop 决策状态机 Provider - Observe/Think/Act/Reflect/Decide 循环核心",
  "dependencies": ["provider:state-store", "provider:watchdog"],
  "provides": ["provider:loop-engine"],
  "config": {
    "max_iterations": 6,
    "max_round_time_ms": 600000,
    "max_wall_time_ms": 3600000,
    "divergence_threshold": 3,
    "proximity_goal": 0.9
  }
}
```

> **阈值变更（WP-177-2-impl-a）**：`max_iterations` 默认 `10 → 6`（用户指定）；新增 `max_round_time_ms=600000`（单轮最长时间 10min）。五个阈值**全部可在运行时 override**：`init({maxIterations, maxRoundTimeMs, maxWallTimeMs, divergenceThreshold, proximityGoal})` 传入的合法数值优先级最高（默认 ← plugin.json config ← init override，经 `mergeConfig` 合并到 `self._config`）。语义区分：`max_round_time_ms`（单轮）/ `max_wall_time_ms`（总墙钟）不可混用——单轮超限在 `step()` 内 act 完成后即时判 timeout，墙钟超限在 `step()` 开头与 `_decide` 中判定。

#### 5.1.0 Actuator 注入架构（WP-177-2-impl-b，act 端到端打通）

engine 的 `act()` 委托注入的 actuator（默认 `loop-actuator`），把 `decision`（dispatch/retry/resplit）序列化为「dispatcher 待执行指令」写入 state-store 子 key，使 `engine.step()` **不再返回 `placeholder:true`** 占位、端到端可跑（含代码驱动 runner 与单测）。

```
engine.act(loopId, decision)
  → actuator.execute(actuatorContext, loopId, decision, state)   [plugins/runtime/loop-actuator.js]
      → 把 decision + failingDrivers 序列化为 pendingAction，写入
        state-store 子 key loop.{loopId}.pendingAction（按 mode+wpId 幂等覆盖）
      → 返回 { dispatched:true, checklistResult: 回填值或undefined }
  → engine.act 把 result.checklistResult 写入 loop.{loopId}.lastChecklist
  → （运行时复现）Claude 读 loop.{loopId}.pendingAction → 调 skill-agent-dispatcher
    （Agent Teams + 1:1 Teamee）→ 回填 CheckResult 到 loop.{loopId}.lastChecklist
  → 下一轮 engine.observe/reflect 消费 lastChecklist，状态机继续流转
```

**注入机制**：`onActivate` / `_ensureStore` 调 `_autoInjectLoopActuator()`——幂等（已注入含外部 mock 则不覆盖），`require('../../runtime/loop-actuator')` 失败降级（`console.warn` + `act()` 走 `{dispatched:false, degraded:true}` 兜底，**不抛**）。`_buildActuatorContext()` 在原 context 上叠加 `getStateStore()` 返回 engine 的 `_store`，使 actuator 复用同一 StateStore 实例（避免两实例缓存不共享导致 pendingAction/lastChecklist 读写丢失）。

**关键边界**：actuator 只产出「指令 + 标记已派发」，**不 spawn Teamee、不调 Claude**；`pendingAction` 是「待 Claude 消费的指令」而非「已执行结果」。详见 `plugins/runtime/loop-actuator.js` 与 `skill-agentic-loop/skill.md` Step 4.0。

#### 5.1.1 状态对象结构（LoopState，持久化到 state-store）

```js
// state-store key: "loop.{loopId}" （loopId 唯一标识一次 loop 运行）
{
  loopId: "loop-20260612-143000",       // 唯一 ID
  teamName: "batch-20260612-WP174",     // 关联 team
  goal: {                                // 目标定义（来自 P1）
    wpIds: ["WP-175", "WP-176"],        // 目标工作包集
    checklistSpec: "default",           // checklist 规范
    successCriteria: "all_pass_and_proximity>=0.9"
  },
  iteration: 3,                          // 当前迭代计数（防压缩关键）
  phase: "reflect",                      // observe|think|act|reflect|decide
  startedAt: "2026-06-12T14:30:00Z",
  lastUpdatedAt: "2026-06-12T14:42:00Z",
  status: "running",                     // running|achieved|timeout|diverged|circuit_broken|aborted
  history: [                             // 每轮判定历史（供 Reflect 评分与发散检测）
    {
      iteration: 1,
      snapshotSummary: { pendingWps: 5, failedChecks: 2, watchdogHealthy: true },
      decision: { action: "dispatch", targetWp: "WP-175", strategy: "full_restart" },
      eval: { proximity: 0.4, converged: false, diverged: false },
      verdict: "continue",
      timestamp: "..."
    }
    // ... iteration 2, 3
  ],
  divergenceStreak: 0,                   // 连续无进展轮数（发散检测）
  checkpoints: {                         // checkpoint_resume 策略用
    "WP-175": { completedFiles: [...], remaining: [...] }
  }
}
```

> **WP-177 新增/补充字段**：
> - `state.terminalReport`：三类终态（timeout/diverged/circuit_broken）出口报告（§6.6），由 engine `_generateTerminalReport` 写入（调 `loop-report.generateTerminalReport`）；含 `{verdict, iteration, proximityTrend, failedItems, summary, markdown, degraded?}`。achieved 不写（走 completion）。
> - `state.lastActResult`：act 阶段结果（含 `roundElapsedMs` 单轮耗时，供 `step()` 校验 `max_round_time_ms`）。
> - `state.failingDrivers` / `state.lastEval.failingDrivers`：失败项明细（§5.3.5 refine 通道第 2 环，WP-176 已回填）。
> - **state-store 子 key**：`loop.{loopId}.lastChecklist`（Act 写入、Reflect 消费的 CheckResult）、`loop.{loopId}.pendingAction`（actuator 产出的 dispatcher 待执行指令，运行时 Claude 读取）。

#### 5.1.2 factory 返回的 API（方法签名）

```js
factory(context) 返回:
{
  /**
   * 初始化/恢复一次 loop 运行。
   * - 若 state-store 已有 loopId 状态且 status=running，从断点恢复（防上下文压缩）。
   * - 否则创建新 LoopState。
   * @param {object} opts - { loopId?, teamName, goal }
   * @returns {Promise<{loopId: string, restored: boolean, state: LoopState}>}
   */
  init: async function (opts) {},

  /**
   * Observe 阶段：聚合环境快照（委托 loop-snapshot，见 5.2）。
   * @param {string} loopId
   * @returns {Promise<LoopSnapshot>} 见 5.2.2
   */
  observe: async function (loopId) {},

  /**
   * Think 阶段：基于快照决策下一步。
   * 决策类型：
   *   - dispatch: 调度下个未完成 WP
   *   - retry: 重试某 WP（含 strategy: full_restart | checkpoint_resume）
   *   - resplit: 需新拆分（委托 task-creator/split-work-package）
   *   - noop: 无可执行项（等依赖）
   * @param {string} loopId
   * @param {LoopSnapshot} snapshot
   * @returns {Promise<LoopDecision>} { action, targetWp?, strategy?, reason }
   */
  think: async function (loopId, snapshot) {},

  /**
   * Act 阶段：执行决策（驱动 agent-dispatcher + checklist）。
   * 注意：实际 dispatcher 调度是异步长任务，act 返回执行句柄，结果在下一轮 observe 读取。
   * @param {string} loopId
   * @param {LoopDecision} decision
   * @returns {Promise<{dispatched: boolean, checklistResult?: CheckResult}>}
   */
  act: async function (loopId, decision) {},

  /**
   * Reflect 阶段：评分（委托 reflection-evaluator，见 5.3）。
   * @param {string} loopId
   * @param {LoopSnapshot} snapshot
   * @returns {Promise<EvalResult>} 见 5.3.2
   */
  reflect: async function (loopId, snapshot) {},

  /**
   * Decide 阶段：三类终止判定（见 §6）。
   * @param {string} loopId
   * @param {EvalResult} evalResult
   * @returns {Promise<{verdict: "continue"|"achieved"|"timeout"|"diverged"|"circuit_broken", reason: string}>}
   */
  decide: async function (loopId, evalResult) {},

  /**
   * 单步推进（observe→think→act→reflect→decide 一轮）。
   * skill-agentic-loop 在 while 循环中调用此方法。
   * @param {string} loopId
   * @returns {Promise<{verdict, iteration, state: LoopState}>}
   */
  step: async function (loopId) {},

  /**
   * 持久化当前 loop 状态（每个 phase 后调用，防压缩）。
   * 委托 state-store.set("loop.{loopId}", state)。
   * @param {string} loopId
   * @returns {Promise<void>}
   */
  persist: async function (loopId) {},

  /**
   * 查询 loop 状态（调试/恢复用）。
   * @param {string} loopId
   * @returns {Promise<LoopState>}
   */
  getState: async function (loopId) {},

  /**
   * 外部指令（回 P1 人介入的触发路径，参考 dispatcher daemon-actions）。
   * action: "pause" | "abort" | "abort_all"
   * @param {string} loopId
   * @param {object} directive - { action, reason }
   * @returns {Promise<boolean>}
   */
  applyDirective: async function (loopId, directive) {}
}
```

#### 5.1.3 状态持久化契约（复用 state-store）

- **key 规范**: `loop.{loopId}` 存完整 LoopState；`loop.{loopId}.iteration` 单独存迭代计数（高频读写优化，dot-notation 自动嵌套 `:328`）。
- **写入时机**: 每个 phase 完成后调 `persist(loopId)`（observe/think/act/reflect/decide 各一次，参考 dispatcher Phase B.5/C.5/D.5 `:525/:619/:764` 的密集写回）。
- **恢复**: `init(loopId)` 先 `state-store.get("loop.{loopId}")`，若 `status==="running"` 则从 `history` 末尾恢复（参考 dispatcher `:374-389`）。
- **防丢**: 每次写回用 `buildStatePayload` 模式（参考 multi-window-coordinator `:505-522`），保证 iteration/history/checkpoints 不丢。

---

### 5.2 loop-snapshot（WP-174-3，环境感知聚合器）

**位置**: `plugins/runtime/loop-snapshot.js`（runtime 模块，`var` 风格）

#### 5.2.1 输入源

| 输入源 | 获取方式 | 提供字段 |
|--------|---------|---------|
| state-store | `context.getProvider('provider:state-store').getTasks()` + `get("loop.{loopId}")` | 未完成 WP 列表、loop 历史 |
| progress-tracker | 读 progress 文件（skill-progress-tracker 产出） | 已完成 WP、进度百分比 |
| watchdog | `context.getProvider('provider:watchdog').isRunning()` | watchdog 健康 |
| git diff | child_process `git diff --stat`（WP 维度） | 本轮变更范围 |
| checklist 结果 | state-store `get("loop.{loopId}.lastChecklist")`（Act 阶段写入） | 上轮检查通过/失败项 |

#### 5.2.2 输出快照对象结构（LoopSnapshot）

```js
{
  loopId: "loop-20260612-143000",
  iteration: 3,
  capturedAt: "2026-06-12T14:42:00Z",
  workPackages: {
    total: 5,
    pending: ["WP-178"],                 // 未完成
    completed: ["WP-175", "WP-176"],     // 已完成
    failed: [],                          // 失败待重试
    blocked: ["WP-179"]                  // 被依赖阻塞
  },
  lastChecklist: {                        // 上轮 checklist 机器可读结果（见 5.4）
    wpId: "WP-176",
    passed: true,
    categories: [...],
    failedItems: []
  } | null,
  watchdog: {
    deployed: true,
    running: true,
    health: "healthy"                    // healthy | degraded | terminated
  },
  gitDiff: {
    changedFiles: 3,
    insertions: 120,
    deletions: 8,
    filesByWp: { "WP-176": ["src/a.js"] }
  },
  signals: {                              // 外部指令（来自 daemon-actions 通道）
    pendingDirectives: ["pause"]          // 待处理的人介入指令
  }
}
```

#### 5.2.3 聚合器 API

```js
module.exports = {
  /**
   * 聚合所有输入源为 LoopSnapshot。
   * 任一源失败降级（不影响整体），记录 warning。
   * @param {PluginContext} context
   * @param {string} loopId
   * @returns {Promise<LoopSnapshot>}
   */
  aggregate: async function (context, loopId) {}
};
```

---

### 5.3 reflection-evaluator（WP-174-3，反思评分）

**位置**: `plugins/runtime/reflection-evaluator.js`（runtime 模块，`var` 风格）

#### 5.3.1 评分维度

| 维度 | 计算方式 | 用途 |
|------|---------|------|
| **接近度（proximity）** | `1 - (未通过项数 / 总检查项数)`，区间 [0,1] | 目标达成判定（≥ proximity_goal 算接近） |
| **收敛（converged）** | 本轮 proximity > 上一轮 proximity | 单调改进检测 |
| **发散（diverged）** | 连续 `divergence_threshold` 轮 proximity 不增（含回退） | 触发散散终止 |
| **趋势（trend）** | 最近 N 轮 proximity 斜率 | 辅助决策 |

> **发散宽容（WP-176-5，修复偏差3）**：上述"proximity 不增即累计发散"的基础规则在 retry 场景下过紧——一轮针对性 refine 若只修掉部分失败项，failed/total 减少但未归零，proximity 可能持平或微升，会被误判为无进展。因此 evaluator 在 streak 累计前增加一道 refine 进展判定：**本轮失败项数严格少于上轮（部分改进）→ streak 归零**，仅"失败项不变/增多（无效重做）"才累计发散。判定依赖两路信号：本轮 `failedCount`（`failedCountFromChecklist`，来自 `lastChecklist.summary.failed` 或 `failedItems.length`）与上轮 `failedCount`（`prevFailedCountFromHistory`，读 `state.history` 末轮 `eval.failedCount`）。任一缺失（首轮 / 无 checklist）→ 降级为 proximity-based 累计，行为不变（向后兼容）。`eval.failedCount` 由 engine `step()` 在每轮写回 `history.eval.failedCount`。

#### 5.3.2 输出结构（EvalResult）

```js
{
  loopId: "...",
  iteration: 3,
  proximity: 0.8,                        // [0,1]
  converged: true,                       // 本轮比上轮进步
  diverged: false,                       // 是否触发发散
  divergenceStreak: 0,                   // 连续无进展轮数
  trend: "improving",                    // improving | flat | regressing
  categoryScores: [                      // 按 checklist 类别细分
    { category: "测试检查", passed: 3, total: 4, ratio: 0.75 },
    { category: "代码质量", passed: 4, total: 4, ratio: 1.0 }
  ],
  failingDrivers: [                      // 失败项 → refine 驱动（evaluator-refine 反馈）
    { wpId: "WP-176", category: "测试检查", item: "边界情况已覆盖", reason: "missing edge case X" }
  ],
  failedCount: 2,                         // 本轮失败项数（WP-176-5）：写回 history.eval.failedCount，
                                          // 下轮经 prevFailedCountFromHistory 读取，驱动发散宽容
  recommendation: "retry_WP-176_with_resplit",  // 给 Think 的建议
  scoredAt: "..."
}
```

#### 5.3.3 判定阈值（来自 loop-engine config）

| 阈值 | 默认值 | 含义 |
|------|-------|------|
| `proximity_goal` | 0.9 | proximity ≥ 此值且 checklist 全过 → 达成 |
| `divergence_threshold` | 3 | 连续 N 轮无进展 → 发散终止 |
| `max_iterations` | **6**（WP-177 由 10 改为 6） | 迭代硬上限 → 超时终止 |
| `max_round_time_ms` | **600000（10min，WP-177 新增）** | 单轮最长时间 → act 完成后超此判 timeout |
| `max_wall_time_ms` | 3600000 (1h) | 总墙钟上限 → 超时终止 |

> **阈值全部可配置（WP-177-2-impl-a）**：上述五个阈值经 `init()` 的 `maxIterations/maxRoundTimeMs/maxWallTimeMs/divergenceThreshold/proximityGoal` 参数 override（合法数值才覆盖，否则沿用默认），合并到 `self._config`。`max_round_time_ms`（单轮）与 `max_wall_time_ms`（总）语义独立——单轮校验在 `step()` 内 act 完成后即时触发，墙钟校验在 `step()` 开头与 `_decide` 触发。

#### 5.3.4 评分 API

```js
module.exports = {
  /**
   * 对当前快照评分。
   * @param {PluginContext} context
   * @param {string} loopId
   * @param {LoopSnapshot} snapshot
   * @param {LoopState} state  - 取 history 算趋势/发散
   * @returns {Promise<EvalResult>}
   */
  score: async function (context, loopId, snapshot, state) {}
};
```

#### 5.3.5 retry 反馈链路（WP-176，修复偏差1/2/3）

v0.3.0 落地的 evaluator-refine 理论上能从 checklist 失败项驱动 P2 refine，但实现里 retry 反馈链路存在三处断裂（见 `docs/wp/WP-176.md`）。WP-176 打通这条链路，本节定义其完整数据流。**engine 路径与运行时 Claude 复现必须打通同一条链路**（这是对齐的核心验收点）。

```
CheckResult.failedItems
  │
  ▼ (1) 产出
EvalResult.failingDrivers  ←── reflection-evaluator.failingDriversFromChecklist
  │                              （每项 {wpId, category, item, reason}）
  ▼ (2) 回填 state（engine reflect 阶段，provider-loop-engine/index.js:413-414）
state.failingDrivers / state.divergenceStreak / state.lastEval
  │                              （运行时 Claude 等效记到 PROGRESS.md / state 记录）
  ▼ (3) 下轮 Think 消费（engine _think retry 分支，:639-655）
decision.failingDrivers      ←── 优先 state.failingDrivers，回退 state.lastEval.failingDrivers
  │                              （retry decision 字段：action/targetWp/strategy/failingDrivers）
  ▼ (4) 进入 Step 4.2（skill-agentic-loop）
dispatchTarget.failingDrivers = decision.failingDrivers
  │                              （dispatcher 参数新字段，仅 retry/resplit 有值）
  ▼ (5) dispatcher restart → 重做 Teamee prompt（WP-176-6）
build_resume_prompt / build_refine_prompt(failing_drivers=...)
                                 （注入"重点修复的失败项"段，Teamee 据此针对性修复）
```

**五个环节缺一即断链**——这正是偏差1/2 的根因（数据算出但没流到重做者手里）。每环锚点：

| 环节 | 产出方 | 消费方 | 关键代码 |
|------|--------|--------|---------|
| (1) 产出 | `reflection-evaluator` | engine `reflect` | `reflection-evaluator.js:247-262`（`failingDriversFromChecklist`） |
| (2) 回填 | engine `reflect` | 下轮 Think / Decide | `provider-loop-engine/index.js:413-414`（`state.failingDrivers = evalResult.failingDrivers`） |
| (3) 消费 | engine `_think` retry 分支 | Step 4.2 | `provider-loop-engine/index.js:639-655`（`wp.failed.length>0` 命中 + 携带 `failingDrivers`） |
| (4) dispatcher 参数 | skill-agentic-loop Step 4.2 | dispatcher | `skill-agentic-loop/skill.md:266-274`（`dispatchTarget.failingDrivers`） |
| (5) prompt 注入 | dispatcher restart | 重做 Teamee | `skill-agent-dispatcher/skill.md:667-692,1044-1125`（`build_resume_prompt`/`build_refine_prompt`） |

**failed WP 填充（修复偏差1）**：环节 (3) 的 `wp.failed` 不再写死空数组。`loop-snapshot.buildWorkPackages`（`loop-snapshot.js:276-324`）从 `lastChecklist.failedItems` 经 `_failingWpsFromChecklist`（`reflection-evaluator.js:284-300`）聚合 wpId 候选集，再排除已 completed、限定 `goal.wpIds` 范围。这让 `_think` 的 `wp.failed.length > 0` 有真实数据支撑，retry 分支真实命中（而非退化成 resplit）。

**Decide 的 noFailed 现真实生效（修复落差）**：`_decide` 达成判定中 `noFailed = (!wp.failed || wp.failed.length===0) && (!evalResult.failingDrivers || evalResult.failingDrivers.length===0)`（`provider-loop-engine/index.js:746-747`）—— WP 级 failed 列表与 CheckResult 级 failingDrivers 明细**任一非空**都判"仍有失败项"，不能进 `achieved`。

**发散宽容（修复偏差3）**：见 §5.3.1 末段发散宽容说明——部分改进（失败项减少）的 retry 轮不计入 `divergenceStreak`，避免偏差1/2 打通后的有效 refine 被误判发散回退 P1。

**对齐验证**：`test/integration/test-agentic-loop-e2e.js` 用真实数据流（mock actuator 写入真实 failedItems，非单测直构 `failed:['WP-5']`）锚定以上链路——retry 真实命中而非 resplit、failingDrivers 经 reflect 回填后被下轮 think 携带、部分改进不计入 divergenceStreak。

---

### 5.4 skill-checklist 机器可读判定契约（WP-174-3，向后兼容）

**位置**: 修改 `.claude/skills/skill-checklist/skill.md`

#### 5.4.1 契约目标

reflection-evaluator 需程序化消费 checklist 结果；现有输出是人类可读 Markdown（`skill.md:103-124`）。**契约要求**：在现有 Markdown 报告**末尾追加**一个 fenced JSON block，**不破坏**现有人类可读输出（向后兼容）。

#### 5.4.2 机器可读输出格式（CheckResult）

在 Report Template（`skill-checklist/skill.md:103-124`）末尾追加：

```markdown
<!-- 以下为机器可读判定，供 reflection-evaluator 消费，请勿手改 -->
```json:machine-readable
{
  "wpId": "WP-XXX",
  "checkedAt": "2026-06-12T14:40:00Z",
  "passed": false,
  "summary": { "total": 20, "passed": 18, "failed": 2 },
  "categories": [
    {
      "name": "代码质量",
      "passed": true,
      "items": [
        { "id": "code-1", "text": "代码符合规范", "passed": true },
        { "id": "code-2", "text": "无编译错误", "passed": true }
      ]
    },
    {
      "name": "测试检查",
      "passed": false,
      "items": [
        { "id": "test-3", "text": "边界情况已覆盖", "passed": false, "reason": "缺少边界 X" }
      ]
    }
  ],
  "failedItems": [
    { "category": "测试检查", "id": "test-3", "reason": "缺少边界 X" }
  ]
}
```
```

#### 5.4.3 字段规范

| 字段 | 类型 | 说明 |
|------|------|------|
| `wpId` | string | 受检工作包 ID |
| `passed` | boolean | 全部通过才 true（与现 Markdown 表"状态"一致） |
| `summary.total/passed/failed` | number | 总数统计 |
| `categories[].name` | string | 与现有 5 类对齐（代码质量/测试/文档/Git/经验）`skill.md:54-89` |
| `categories[].passed` | boolean | 该类全过才 true |
| `items[].id` | string | 稳定 ID（类别前缀+序号，如 `test-3`），供跨轮比对 |
| `items[].reason` | string? | 失败原因（仅 failed 项必填） |
| `failedItems` | array | 扁平失败项列表，reflection-evaluator 的 `failingDrivers` 直接映射 |

#### 5.4.4 消费方契约

- reflection-evaluator 从 state-store `get("loop.{loopId}.lastChecklist")` 读取（Act 阶段写入），解析上述 JSON。
- `item.id` 必须跨轮稳定，否则发散检测（"同一失败项反复失败"）无法判断。
- **向后兼容**：现有 human 消费路径只读 Markdown 表格，JSON block 是追加的，互不干扰。
- **retry refine 通道（WP-176，见 §5.3.5）**：`failedItems` 是整条反馈链路的源头——经 evaluator 归一化为 `failingDrivers` 后，最终经 engine Think/Decide → skill-agentic-loop Step 4.2 → dispatcher restart 注入重做 Teamee 的 prompt。`failedItems` 的 `wpId`/`category`/`reason` 字段质量直接决定 refine 是否"针对性"（Teamee 能否知道重点修哪些项）。`failedItems[].wpId` 缺失（无来源）的项会被 `_failingWpsFromChecklist` 丢弃，无法定位到具体 WP。

---

## 6. 三类终止条件精确判定逻辑

`loop-engine.decide(loopId, evalResult)` 的判定优先级（从高到低）：

### 6.1 终止条件 ①：目标达成（→ 进 P4）

```
判定: passed == true（checklist 全过）
  AND evalResult.proximity >= config.proximity_goal（默认 0.9）
  AND workPackages.pending.isEmpty AND workPackages.failed.isEmpty
verdict: "achieved"
后续: 写 loop.status = "achieved"，触发 P4 completion-report
```

### 6.2 终止条件 ②：迭代上限 / 超时（→ 自主出报告）

```
判定: state.iteration >= config.max_iterations（默认 6）
  OR (now() - state.startedAt) >= config.max_wall_time_ms（默认 1h）
  OR act 单轮耗时 >= config.max_round_time_ms（默认 600000，WP-177 新增）
verdict: "timeout"
后续: 写 loop.status = "timeout"，engine 自主生成总结报告写 state.terminalReport
      （§6.6），不再强制回 P1；人可经 applyDirective 主动 pause/abort 介入
```

### 6.3 终止条件 ③：发散 + 熔断（→ 自主出报告）

#### 6.3.1 发散检测
```
判定: evalResult.divergenceStreak >= config.divergence_threshold（默认 3）
  即连续 3 轮 proximity 无改进（含回退）
verdict: "diverged"
后续: 写 loop.status = "diverged"，自主生成报告写 state.terminalReport（§6.6），
      报告含最近 N 轮 proximity 趋势，不再强制回 P1
```

#### 6.3.2 watchdog 熔断
```
判定: snapshot.watchdog.health == "terminated"
  OR snapshot.watchdog.running == false（watchdog daemon 已终止）
  OR snapshot.watchdog.health == "degraded"（持续）
verdict: "circuit_broken"
后续: 写 loop.status = "circuit_broken"，自主生成报告写 state.terminalReport（§6.6），
      提示 watchdog 守护异常，不再强制回 P1
查询: context.getProvider('provider:watchdog').isRunning()（index.js:77）
```

### 6.4 否则继续

```
verdict: "continue"
后续: persist(loopId)，进入下一轮 observe
```

### 6.5 判定优先级与短路

熔断 > 发散 > 上限 > 达成 > 继续。任一终止条件触发立即跳出 while，**不**继续执行剩余 phase。

### 6.6 出口报告行为（WP-177-2-impl-c，行为变更）

> 🔴 **本节是对原设计（§6.2/6.3 旧版"回 P1"）的行为变更**：触顶/发散/熔断**不再强制回 P1 human-checkpoint**，engine 自主调 `loop-report.generateTerminalReport(state, {loopId, verdict})` 生成总结报告写 `state.terminalReport`，skill.md Step 5（`outputTerminalReport`）直接读取并呈现给用户。人仍可经 `applyDirective`（§7.1，Step 6）主动 pause/abort 介入——这是保留的安全通道，**不是默认回 P1 流程**。

**报告契约**（`plugins/runtime/loop-report.js`，纯函数无副作用）：
```
report = {
  loopId, verdict, iteration,
  proximityTrend: [{iter, proximity, verdict, failedCount}, ...],  // 来自 state.history
  failedItems: [{wpId, category, item, reason}, ...],              // 来自 state.failingDrivers / lastEval
  lastProximity, failedCount, summary,
  markdown,          // 含结论 + 趋势表（最近 N 轮）+ 失败项明细表 + 建议下一步
  generatedAt
}
```

**生成时机（engine 内聚，所有终态出口统一经 `_generateTerminalReport`）**：
- `decide()` 判出 timeout/diverged/circuit_broken → 即时生成（但此时 history 缺本轮，`step()` 在写完本轮 history 后对三类终态**重新生成覆盖**，使 `proximityTrend` 含末轮）；
- `step()` 提前硬上限出口（iteration/wall/单轮超时）→ 生成；
- `achieved` 不生成（走 completion）。

**降级语义**：`loop-report` require 失败 → `terminalReport = {degraded:true, verdict, markdown:null}` 并 `console.warn`，不抛、不阻断终态流转，state 仍标记终态 status。

**plan-reader 入口（WP-177-3-impl-a）**：skill Step 0 优先读 `.claude/plan.md`（`plugins/runtime/plan-reader.js` 的 `parsePlanToGoal()`）拆为 `{goal.wpIds, workPackages[].checklist, dependencyGraph}`，替代"从用户原始需求 P0 重拆"。解析不出 WP / 循环依赖 → 提示用户提供/修正计划，**不退化**（"单 WP 即退化"路径已删除，强制 dispatcher Agent Teams）。

---

## 7. 半自主安全边界与回退路径

### 7.1 安全边界（不可越界）

| 边界 | 规则 |
|------|------|
| **入口必先规划** | 触发即进 Plan 模式，Step 0 拆 WP 不可跳过（优先读 `.claude/plan.md` 经 plan-reader，回退 task-creator/split-work-package） |
| **不越界 P0** | loop 仅 P2↔P3 自主。即使 Think 判定"需新拆分"，也仅在现有 goal 范围内（委托 split-work-package 拆当前失败 WP），**不重新触发 P0 全局规划** |
| **P1 保留点** | loop 入口必须是 P1 human-checkpoint 确认后；**触顶/发散/熔断时自主出报告（§6.6，不再强制回 P1 全流程）**，人经 applyDirective（§7.2 第 4 条）主动 pause/abort 介入 |
| **Act 必须多 agent** | loop 永不自己写代码，Act 一律委托 skill-agent-dispatcher 用 Agent Teams + subagent（"单 WP 即退化"路径已删除，WP-177-3-impl-a） |
| **不做破坏性操作** | loop 的 Act 仅 dispatch/retry/resplit，不直接删除产物、不 force push、不改 git history（遵循全局安全约束） |
| **人可随时介入** | 通过 daemon-actions 通道（参考 dispatcher `:639-762`）下发 pause/abort/abort_all，loop-engine.applyDirective 响应 |

### 7.2 终态出口与人介入通道（WP-177 行为变更）

> 原设计（"loop 终止一律回 P1"）已变更：三类终态自主出报告。下列为人**可主动介入**的通道，非默认流程。

1. **触顶/发散/熔断**：终止条件 ②/③ → engine 自主生成 `state.terminalReport`（§6.6），skill 直接呈现，**不强制回 P1**
2. **外部 pause 指令**：人主动通过 daemon-actions 下发 pause → `applyDirective` 置 status=paused
3. **外部 abort/abort_all 指令**：人主动下发 → status=aborted，verdict=aborted/circuit_broken
4. **goal 不可达检测**（可选增强）：Think 发现所有 WP 都 blocked 且无解（依赖死锁）

### 7.3 出口动作

```
触顶/发散/熔断（不再强制回 P1，WP-177）:
  1. loop-engine 写最终 status（timeout/diverged/circuit_broken）
  2. engine._generateTerminalReport 生成报告写 state.terminalReport
     （含 proximity 趋势 / 失败项明细 / 结论 / 建议下一步）
  3. skill Step 5 outputTerminalReport 直接呈现报告给用户（不触发 human-checkpoint 全流程）
  4. 报告末尾附「可选后续」（非强制）：继续等待 / 调整 goal/阈值（回 Step 0/1）/
     手动修复失败项（人接管）/ 终止。人若要介入，经 applyDirective 下发 pause/abort。

achieved:
  触发 skill-completion-report → P4（不变）
```

---

## 8. 状态持久化与上下文压缩防护

### 8.1 威胁模型

Claude Code 上下文压缩会丢失 loop 的内存状态（iteration/phase/history）。agent-dispatcher 已验证"每 Phase 写回 state 文件 + Phase 0 恢复"的模式可防此问题（`skill-agent-dispatcher/skill.md:421-438`）。

### 8.2 loop 的持久化策略（复用 state-store，对照 dispatcher-state.json 思路）

| 机制 | 实现 | 对照 dispatcher |
|------|------|----------------|
| 每 phase 写回 | loop-engine 在 observe/think/act/reflect/decide 各调一次 `persist(loopId)` | dispatcher Phase B.5/C.5/D.5（`:525/:619/:764`） |
| 压缩后恢复 | `init(loopId)` 读 `loop.{loopId}`，若 status=running 从 history 末尾 + iteration 恢复 | dispatcher Phase 0（`:421-438`） |
| 防丢失写回 | 用 buildStatePayload 模式，iteration/history/checkpoints 显式包含 | multi-window-coordinator.buildStatePayload（`:505`） |
| 心跳可观测 | loop 每轮写 `loop.{loopId}.heartbeat`（iteration + lastUpdatedAt），供 watchdog 检测卡死 | dispatcher heartbeat（`:481-496`） |
| 原子写 | state-store.write 用 temp+rename（`:106-139`） | dispatcher Write 直接覆盖（loop 更安全） |

### 8.3 关键不变量（测试必须覆盖）

- 任意 phase 中断后 `init(loopId)` 必须能恢复到该 phase 起点重做（幂等）。
- iteration 单调递增，压缩后不回退。
- history 完整保留所有轮判定（发散检测依赖完整历史）。

### 8.4 单步时序特性（step 内 observe/act/reflect 的一致性，非 bug）

`step(loopId)` 内五阶段顺序执行，状态在各阶段间通过 state-store 流转，存在一个**固有（且合理）的单轮时序**：

- **Reflect 消费的是 observe 时刻的 snapshot**：`step()` 在 observe 聚合 snapshot 后，依次 think→act→reflect；reflect 阶段传入的 snapshot 仍是本轮 observe 捕获的那份（act 的副作用尚未反映到该 snapshot）。
- **act 写入的 lastChecklist 下一轮才被 evaluator 消费**：act 阶段把 checklistResult 写入 `loop.{loopId}.lastChecklist`，但本轮 reflect 用的是本轮 observe 已读入的 `snapshot.lastChecklist`（旧值）；下一轮 observe 会重新 `loadLastChecklist`，届时才读到 act 新写入的值。

这是 evaluator-refine loop 的正常一拍延迟（act → 下一轮 observe → reflect），**不构成 bug**：每轮的 refine 反馈天然滞后一轮，发散/收敛检测基于完整 history 序列仍正确。若未来需要"同轮 act 后立即重验"，应由调用方在 act 后显式触发一次额外的 observe+reflect，而非改动 step 的固有时序。

---

---

## 9. 风险与迁移路径

### 9.1 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| **state-store 多进程并发写丢数据**（`state-store.js:19-23`） | 多 loop 实例同 key 写入 last-write-wins | WP-174-5：每 loop 独立 namespace（`loop.{loopId}`），聚合读用 multi-window-coordinator 模式 |
| **checklist 机器可读输出破坏现有 human 流程** | 现有 checklist 报告被污染 | JSON block 追加在 Markdown 末尾（5.4.2），不改动表格部分；加测试验证兼容 |
| **loop 无限循环** | 资源耗尽 | 三类终止（§6）+ max_iterations/max_wall_time 双重硬上限 + watchdog 熔断 |
| **loop 越界 P0** | 破坏规划稳定性 | 7.1 明确 Think 的 resplit 仅限当前 goal 范围；测试覆盖越界拒绝 |
| **dispatcher 与 loop 职责重叠** | 双重调度冲突 | loop 是决策层，dispatcher 是 loop Act 层的执行单元（4.2 已划界）；loop 不绕过 dispatcher 直接 spawn Teamee |
| **evaluator-refine 收敛慢** | 多轮重试成本高 | proximity 单调改进检测（5.3.1 converged），非收敛提前回 P1 |
| **item.id 跨轮不稳定** | 发散检测误判 | 5.4.3 强制 id 稳定（类别前缀+序号），测试覆盖 |

### 9.2 向后兼容（不影响现有 5 阶段流水线）

- loop 是**新增可选路径**（`/skill-agentic-loop`），不替换现有 `skill-workflow-orchestrator` 的线性流水线。
- P0/P1/P4 完全不变（loop 仅插在 P1 确认后、P4 触发前）。
- checklist 增强是追加式（JSON block），现有 Markdown 输出不变。
- dispatcher/checklist/experience-logger/watchdog 现有 API 不变，loop 通过 context.getProvider 消费。
- 现有 `skill-workflow-orchestrator/skill.md:208` 的"Checklist 不通过 → 修复后重新检查"**保留**（人驱动路径不删），loop 提供自主路径作为增强。

### 9.3 v0.3.0 落地步骤（WP-174-2~8 顺序）

```
WP-174-2 (engine)  → provider-loop-engine 决策状态机（含 state-store 持久化）
   ↓
WP-174-3 (observe) → loop-snapshot + reflection-evaluator + checklist 机器可读
   ↓ （可与 5 并行）
WP-174-5 (converge)→ 三类终止判定 + 多 loop 协调 + watchdog 熔断集成
   ↓
WP-174-4 (skill)   → skill-agentic-loop 入口 + dispatcher/checklist/workflow 集成
   ↓
WP-174-6 (test)    → 各模块单元测试（engine 状态机 / snapshot 聚合 / evaluator 评分 / 终止判定 / 持久化恢复）
   ↓
WP-174-7 (verify)  → 端到端：含故意失败项 WP 自主 P2→P3→P2 重试验证 + 熔断路径
   ↓
WP-174-8 (review)  → 代码审查 + plugin-registry 注册 + build/validate + 文档同步 + 升 v0.3.0
```

### 9.4 plugin-registry 注册（WP-174-8）

新增 provider-loop-engine 到 `plugins/plugin-registry.json`（格式参考 `:4-9`）：
```json
{
  "name": "provider-loop-engine",
  "source": "provider-loop-engine",
  "enabled": true,
  "config": {
    "max_iterations": 6,
    "max_round_time_ms": 600000,
    "max_wall_time_ms": 3600000,
    "divergence_threshold": 3,
    "proximity_goal": 0.9
  }
}
```
skill-agentic-loop 注册为 skill（version 1.1.0，config 含 plan_mode_required + 五阈值，WP-177-4-impl）。三处 config（DEFAULT_CONFIG / provider-loop-engine plugin.json / plugin-registry.json）须保持一致。

---

## 10. 后续 WP 实现指引

### WP-174-2（impl-engine）实现提示
- 仿照 `provider-state-store/index.js` 结构：`extends ProviderPlugin`，`onActivate` 初始化 state-store 句柄，`factory` 返回 API。
- 状态机五方法（observe/think/act/reflect/decide）+ step 编排 + persist + getState + applyDirective。
- **必须**复用 state-store 持久化（不要自己写文件 IO），key 规范 `loop.{loopId}`。
- dependencies 声明 `["provider:state-store", "provider:watchdog"]`，通过 `context.getProvider` 获取。

### WP-174-3（impl-observe）实现提示
- loop-snapshot.js 是 runtime 模块（`var` 风格），导出 `aggregate(context, loopId)`。
- 任一输入源失败降级（try/catch + warning），不阻断聚合。
- reflection-evaluator.js 导出 `score(context, loopId, snapshot, state)`，发散检测依赖 state.history 完整性。
- checklist 修改：在 `skill-checklist/skill.md` Report Template（`:103-124`）末尾加 JSON block（5.4.2），**不动现有表格**。Act 阶段（loop-engine.act）把 checklist 输出解析后写 `loop.{loopId}.lastChecklist`。

### WP-174-5（impl-converge）实现提示
- 终止判定严格按 §6 优先级（熔断 > 发散 > 上限 > 达成 > 继续）。
- 多 loop 协调**复用** `multi-window-coordinator.aggregateWindowStates`（`:157`），把 loop 当逻辑窗口。
- watchdog 熔断查 `context.getProvider('provider:watchdog').isRunning()`（`provider-watchdog/index.js:77`）。

### WP-174-4（impl-skill）实现提示
- skill-agentic-loop 入口，半自主默认（P1 确认后启动）。
- while 循环调 `loop-engine.step(loopId)`，按 verdict 决定 continue / 跳出进 P4（achieved）/ 自主出报告（timeout·diverged·circuit_broken，WP-177）。
- 集成 workflow-orchestrator 处理 P1/P4 边界（loop 不直接管 P1/P4）。
- 参考 agent-dispatcher 的监控循环结构（`:418-856`），但目标驱动而非任务驱动。

### WP-174-6（test）必须覆盖
- engine 状态机五方法 + step 编排。
- snapshot 聚合（含单源失败的降级）。
- evaluator 评分（proximity/converged/diverged/trend）+ 三类阈值边界。
- 终止判定优先级（熔断 > 发散 > 上限 > 达成）。
- **持久化恢复**：模拟上下文压缩（清内存），init 必须恢复 iteration/history/phase。
- checklist 机器可读输出解析 + 向后兼容（Markdown 不被破坏）。
- item.id 跨轮稳定性。

### WP-174-7（verify）端到端场景
- 含故意失败项的 WP → loop 自主 P2→P3→P2 重试至达成。
- 发散场景：人为制造连续无进展 → 验证回 P1。
- 熔断场景：模拟 watchdog terminated → 验证回 P1。
- 上下文压缩：运行中重启 → 验证从 state 恢复继续。

---

## 11. Node 进程级 Driver 与 provider 解耦（M1~M5，WP-184~190）

> §1~§10 描述的循环载体是「Claude 会话内的伪代码 while 循环」——`skill-agentic-loop` 在 Claude Code 会话里逐轮调 `engine.step()`。§11 记录 v0.3.4 起的形态升级：**循环载体改为 Node 进程**，Claude/任意 provider 退化为可替换的**无状态 executor**。施工蓝图见 `docs/plan/agentic-loop-node-driver.md`（M1~M3）与 `docs/plan/agentic-loop-node-driver-m4m5.md`（M4/M5）。

### 11.1 演进动机：为什么要离开「会话内循环」

| 问题 | 会话内伪代码循环（§4）的根因 |
|------|----------------------------|
| 循环命脉绑死 Claude 会话 | 会话压缩/中断即丢循环上下文；engine state 虽持久化，但 `while` 控制流在 Claude 侧，恢复需人手重入 |
| provider 不可替换 | Act 层硬编码「调 skill-agent-dispatcher → Claude」，换 GLM/其它模型要改 skill |
| 多 loop 并行无隔离 | 单 `.claude-state` 文件多进程并发写丢数据（`state-store.js:19-23` 明确不支持） |

解法：把 `while(!done) step()` 搬到 Node 进程，provider 退化为 `executor.run()` 的不同实现，多 loop 靠 per-loop 目录物理隔离。

### 11.2 架构分层（M1~M5）

```
            ┌─────────────────────────────────────────────────────────┐
            │  tackle loop <plan> --executor=local|default             │  CLI 入口
            │    [--settings=<profile.json>]  ← provider/套餐档位切换  │
            │  tackle loop-server start|status|abort                   │
            └───────────────┬─────────────────────────┬───────────────┘
                            │                         │
              ┌─────────────▼──────────┐   ┌──────────▼──────────────┐
              │ bin/commands/loop.js   │   │ bin/commands/loop-      │
              │  (Node driver 外层循环) │   │   server.js (CLI 薄壳)  │
              │  while(!terminal):     │   └──────────┬──────────────┘
              │    api.step(loopId)    │              │
              │    executor.run(...)   │   ┌──────────▼──────────────┐
              │    appendProgressLine  │   │ loop-server-core.js     │
              │    readAbortDirective  │   │  (纯逻辑+文件 IO 核心)  │
              └─────┬────────┬─────────┘   │  aggregateGlobalView    │
       provider     │        │             │  applyQuotaPool         │
       路由         │        │ 熔断指令     │  writeAbortDirective    │
            ┌───────▼──┐  ┌──▼──────────┐ └──────────┬──────────────┘
            │ loop-    │  │ directive.  │            │ 只读聚合
            │ executor │  │ json sidecar│◀───────────┘ (不写各 loop state)
            │ (factory)│  └─────────────┘
            └──┬─────┬─┘
               │     │   两实现同一契约 { name, run(pendingAction), config, quota }
        ┌──────┘     └──────┐
   ┌────▼───┐        ┌──────▼─────────────────────────────┐
   │local   │        │default                              │  executor-local(mock)
   │(mock)  │        │ (spawn claude CLI)                  │  executor-default（单一真实 executor）
   └────────┘        │  ↑ provider-resolver 探测 model →   │
                     │    匹配 glm/mimo/deepseek profile → │
                     │    按 features.quotaAware 门控额度  │
                     └─────────────────────────────────────┘
                            │
                            │  engine 全程零改动（硬约束 #1）
                            ▼
              plugins/core/provider-loop-engine（observe→think→act→reflect→decide）
```

> **provider 解耦的演进（v0.3.10，WP-188 重构）**：早期版本把"真实 Anthropic / 智谱 GLM"做成两个独立 executor（`executor-claude.js` + `executor-glm.js`），provider 名直接焊死成 executor 名。重构后合并为**单一 `default` executor**——provider 不再是 executor 名，而是由 `provider-resolver`（`plugins/runtime/provider-resolver.js`）探测 `--settings` 文件或环境变量里的模型名，按 `harness-config.yaml` 的 `loop.providers` 规则匹配 profile，自动门控对应特性（目前仅智谱 GLM 的 5h 额度感知 + 高峰系数）。`executor-claude.js` 降级为 `executor-default` 复用的内部辅助库（prompt 模板 / checklist 解析 / 进展检测的源头），不再是注册的 executor。`--executor=claude` 保留为 `default` 的别名（向后兼容），`--executor=glm` 已删除（抛 `UNKNOWN_EXECUTOR`）。

### 11.3 硬约束（贯穿 M1~M5）

1. **engine 零改动**：`provider-loop-engine` 是稳定资产，driver/coordinator/executor 只调不改。provider 隔离靠「改变 engine 看到的 projectRoot」（chdir）而非注入 store。
2. **executor 保持无状态**：额度感知走「降速返回」（接近上限返回 `passed:false + quota_exhausted`，让 driver 的发散检测兜底），不在 executor 里 sleep 或维护全局额度状态机。
3. **provider 解耦点是 `executor.run()`**：driver 只认 `createExecutor(provider, opts)`，新增 executor 只在 `loop-executor.js` REGISTRY 注册一行 + 新建模块，driver/engine 零改动。
4. **CheckResult 契约统一**：`{ wpId, passed, summary:{total,passed,failed}, categories[], failedItems[] }`，由 `reflection-evaluator` / `loop-snapshot` 消费。
5. **回退安全**：不开 coordinator、不传 `--loop-id` 时，单 driver 仍能独立跑（保持 M1~M3 形态不破坏）。
6. **PROGRESS.md 同步**：driver 消费 `pendingAction` 后必须写 `- [x] WP-NNN` 行（snapshot 从此读 completed，否则 completed 流转不回 engine）。
7. **coordinator 只读各 loop state**：熔断只写独立 `directive.json` sidecar（单向通道），绝不写各 loop 的 `.claude-state`（规避 `state-store.js:19-23` 的多进程并发写）。

### 11.4 各组件职责（WP-184~190 落地）

| 组件 | 文件 | WP | 职责 |
|------|------|----|------|
| Node driver | `bin/commands/loop.js` | 184 | 解析 plan → engine init → `while(!terminal) step()` + 消费 pendingAction → executor.run → 回填 lastChecklist + 写 PROGRESS.md；exit code：achieved→0 / 其它→1 |
| Executor 工厂 | `plugins/runtime/loop-executor.js` | 185 | provider 路由层，惰性 require 具体 executor，统一 `createExecutor(provider, opts)`；REGISTRY = `{ local, default }`，`claude`→`default` 别名 |
| local executor | `plugins/runtime/executor-local.js` | 185 | mock 固定回 passed，供单测与冒烟（100/h 限流） |
| provider 解析器 | `plugins/runtime/provider-resolver.js` | 188 | 探测生效模型（settings 文件 model → env.ANTHROPIC_DEFAULT_*_MODEL → 环境变量）→ 匹配 `loop.providers` profile（modelRegex + 可选 baseUrlRegex）→ 产出 `{model, provider, quotaConfig, features.quotaAware}`，决定 default executor 启用哪些特性 |
| default executor | `plugins/runtime/executor-default.js` | 188 | 单一真实 executor：spawn `claude -p --output-format json`，prompt/checklist 解析/进展检测复用 `executor-claude.js` 内部库；按 `features.quotaAware` 门控智谱式 5h 滚动窗口 + 高峰系数（仅探测到 glm 模型时启用，mimo/deepseek/unknown 纯透传） |
| claude 内部辅助库 | `plugins/runtime/executor-claude.js` | 185/187 | prompt 模板 / `json:machine-readable` 解析 / `git status --porcelain` 工作树脏度进展检测的源头；由 executor-default require 复用，**不再**是注册的 executor（`--executor=claude` 是 `default` 别名） |
| snapshot 口径修复 | `plugins/runtime/loop-snapshot.js` | 186 | `parseProgressMarkdown` 正则放宽到 `WP-?[\w-]+`（支持字母/混合编号）；`buildWorkPackages` checklist 完成态兜底（`lastChecklist.passed===true` 且 wpId 在 goal 内 → completed） |
| per-loop 隔离 | `bin/commands/loop.js: resolveLoopWorkspace` | 189 | `--loop-id` 时建 `{stateDir}/{loopId}/` 隔离目录 + task.md 占位 + `process.chdir`，engine/snapshot/driverStore/PROGRESS.md 全部落隔离目录 |
| coordinator 核心 | `plugins/runtime/loop-server-core.js` | 190 | 扫 per-loop 目录只读聚合（复用 `loop-coordinator.aggregateLoopStates`）、按 provider 分桶额度池、全局/额度熔断下发 `directive.json` |
| coordinator CLI | `bin/commands/loop-server.js` | 190 | `start`（轮询守护+自动熔断）/`status`/`list`/`abort <loop-id>`；Ctrl+C 优雅退出 |

### 11.5 provider 解耦验收锚点（M4，WP-188 重构后）

provider 不再焊死成 executor 名，而是由 `provider-resolver` 在运行时探测。无论切到哪个 provider，driver/engine **零改动**，差异仅在 `--settings` 指向的配置文件 + resolver 匹配到的 profile：

- **单一 `default` executor**：spawn 同一 claude binary，端点 + 认证 + 模型全部由 `--settings` 文件携带（透传 claude CLI 原生 `--settings` flag），executor **不再注入** `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 等环境变量（避免与 settings 冲突 + 泄漏风险）。
- **模型探测顺序**（`provider-resolver.resolveEffectiveModel`，用户要求"配置文件优先于环境变量"）：`--settings` 文件的 `model` 字段 → 文件 `env.ANTHROPIC_DEFAULT_SONNET_MODEL`（fallback OPUS/HAIKU）→ 进程环境变量 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL`。三者都无 → provider=unknown（纯透传，不启用任何特性）。
- **特性门控**：按 `harness-config.yaml` 的 `loop.providers` 规则（modelRegex + 可选 baseUrlRegex 二次确认防撞名）匹配 profile；有 quota 段（如智谱 GLM）→ `features.quotaAware=true`，default executor 自动启用 5h 额度感知 + 高峰系数；无 quota 段（mimo/deepseek/unknown）→ 纯透传。

合规要点（`docs/wp/WP-188-research.md` §2.2）：智谱 Coding Plan 额度**仅限官方编码工具**（Claude Code / Cline / OpenCode / Cherry Studio）内使用。裸调智谱 API/SDK 不享套餐额度且有「非编程工具滥用」封号风险——所以 GLM 仍走 claude CLI 中转（= 官方客户端 + 订阅人本人使用 = 合规 + 享额度），只是改由 `--settings` 文件携带端点/认证，而非 executor 注入环境变量。禁止跨机共享 API Key。

### 11.6 多 loop 并行与额度统筹（M5）

**隔离**：每个 `--loop-id=X` 的 loop 落在 `{stateDir}/X/` 独立目录（`.claude-state` / `PROGRESS.md` / `.executor` sidecar / `directive.json` 全隔离），物理规避单文件多进程并发写。

**额度池**（`loop-server-core.applyQuotaPool`）：coordinator 按 provider 累加各 loop 的 iteration 消耗；glm 额外按高峰系数（高峰 3x / 非高峰 2x，仅 GLM-5.x；其它 glm 模型 1x）加权——高峰系数换算复用 `executor-default._quotaCostFactor` + `provider-resolver` 的 GLM quotaConfig（同源无重复）。默认软上限：claude 500/5h、glm 400/5h、local ∞；超 `quotaCircuitThreshold=0.95` 触发熔断。

**熔断**（两类策略，守护进程 `start` 时执行）：
- **全局回退**：任一 loop `circuit_broken`/`aborted` → 对其它仍活跃 loop 下发 abort
- **额度兜底**：某 provider 额度 ratio 超阈值 → 对该 provider 的活跃 loop 下发 abort

driver 每轮 step 后读 `directive.json`，命中 `action:'abort_all'` 则调本进程 `api.applyDirective`（engine 零改动复用其 status→lastVerdict→saveState 逻辑），随后重 step 取回 `circuit_broken` verdict 走正规终态出口。

### 11.7 缓存陷阱（深审挖出）

engine 内部持有自己的 StateStore 实例（`_store`），driver 另起一个 StateStore 读 `pendingAction` / 写 `lastChecklist`。两者共享同一 `.claude-state` 文件但**各自有内存缓存**——单进程下 driver 的 `_cache` 会读到 engine 最新写入前的旧值。**必须在每次读前 `driverStore.invalidate()`**，否则 `pendingAction` 永远停在首个 WP，loop 无法收敛（详见 `docs/wp/WP-184-finding-cache-stale.md`）。

---

## 附录：关键证据索引

| 结论 | 证据位置 |
|------|---------|
| state-store KV+dot+subscribe | `plugins/runtime/state-store.js:197-267` |
| state-store 不支持多进程并发写 | `plugins/runtime/state-store.js:19-23` |
| state-store 原子写+损坏恢复 | `plugins/runtime/state-store.js:64-139` |
| event-bus 发布订阅+错误隔离 | `plugins/runtime/event-bus.js:45-130` |
| dispatcher 监控循环骨架 | `.claude/skills/skill-agent-dispatcher/skill.md:418-856` |
| dispatcher 状态持久化防压缩 | `.claude/skills/skill-agent-dispatcher/skill.md:348-438` |
| dispatcher 外部指令通道 | `.claude/skills/skill-agent-dispatcher/skill.md:639-762` |
| checklist 仅 Markdown 输出（缺口） | `.claude/skills/skill-checklist/skill.md:103-124` |
| checklist 5 类检查 | `.claude/skills/skill-checklist/skill.md:54-89` |
| workflow "Checklist 不通过→人修复"（现状） | `.claude/skills/skill-workflow-orchestrator/skill.md:208` |
| multi-window 聚合模式 | `plugins/runtime/multi-window-coordinator.js:157-292` |
| multi-window 状态写回防丢失 | `plugins/runtime/multi-window-coordinator.js:505-522` |
| watchdog 状态查询 API | `plugins/core/provider-watchdog/index.js:52-88` |
| Provider 基类与 factory 模式 | `plugins/contracts/plugin-interface.js:189-206`、`plugins/core/provider-state-store/index.js:144-210` |
| plugin-registry 注册格式 | `plugins/plugin-registry.json:4-9` |

## 参考来源

- [HuggingFace Agents Course — Agent Steps and Structure](https://huggingface.co/learn/agents-course/en/unit1/agent-steps-and-structure)（ReAct / Observe-Think-Act）
- [AWS Prescriptive Guidance — Evaluator reflect-refine loop patterns](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html)（Evaluator-Refine 理论基础）
- [AWS Prescriptive Guidance — Workflow for evaluators and reflect-refine loops](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/workflow-for-evaluators-and-reflect-refine-loops.html)
- [AWS Builder — Reflection Pattern Using Strands Agents](https://builder.aws.com/content/2zo16pNcEvQHtHpwSaxfFr8nf37/ai-agents-design-patterns-reflection-pattern-using-strands-agents)（Reflection + HITL）
- [IBM — What is a ReAct Agent](https://www.ibm.com/think/topics/react-agent)（ReAct 定义）
