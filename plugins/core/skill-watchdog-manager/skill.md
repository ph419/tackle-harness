# Watchdog Manager

Watchdog 守护进程管理技能，用于启动/停止/查看守护进程状态，与 agent-dispatcher 配合使用。

## When to Use

**触发词**:
- "启动守护进程" / "开启 watchdog"
- "停止守护进程" / "关闭 watchdog"
- "守护进程状态" / "watchdog 状态"
- "watchdog" / "watchdog start" / "watchdog stop"

## Prerequisites

Watchdog 必须已部署到项目中。检查条件：

```
# 检查 watchdog 是否已部署
file_exists = Bash(command="test -f .claude/watchdog/watchdog.js && echo 'exists' || echo 'not_found'")
```

**如果文件不存在**：说明 watchdog provider 未启用。告知用户需要在 `plugins/plugin-registry.json` 中启用 `provider-watchdog` 后重新执行 `node bin/tackle.js build`。

## Commands

### 初始化（首次使用）

```bash
node .claude/watchdog/watchdog.js init
```

创建 `.claude-daemon/` 目录和默认配置文件。

### 启动守护进程

```bash
# 前台模式（调试用）
node .claude/watchdog/watchdog.js start --foreground

# 后台模式（生产用，默认）
node .claude/watchdog/watchdog.js start
```

### 查看状态

```bash
node .claude/watchdog/watchdog.js status
```

输出包括：PID、运行模式、健康状态、会话信息、任务列表、重启历史、熔断状态。

### 手动重启任务

```bash
node .claude/watchdog/watchdog.js restart --task <task_id>
```

### 暂停/恢复检测

```bash
# 暂停
node .claude/watchdog/watchdog.js pause

# 恢复
node .claude/watchdog/watchdog.js pause --resume
```

### 停止守护进程

```bash
node .claude/watchdog/watchdog.js stop
```

## Workflow Integration

### 与 agent-dispatcher 配合

Watchdog 通过文件系统与 agent-dispatcher 通信：

```
agent-dispatcher 写入 → .claude-daemon/heartbeat.json    ← watchdog 读取
agent-dispatcher 写入 → .claude-daemon/tasks/task-{id}.json ← watchdog 读取
watchdog 写入 → .claude-daemon/daemon-actions.json       ← agent-dispatcher 读取
```

**推荐工作流**：

1. 用户发出"批量执行"请求 → agent-dispatcher skill 被触发
2. agent-dispatcher 开始监控循环，自动写入心跳和任务文件（DISP-001/002）
3. watchdog 独立运行，检测卡死任务并下发 restart/abort 指令（DISP-003）
4. 任务完成后 watchdog 自动检测并退出

**启动时序**：

```
# 终端 1：先启动 watchdog
node .claude/watchdog/watchdog.js start

# 终端 2：再启动 agent-dispatcher 批量任务
# (agent-dispatcher 会自动写入心跳和任务文件)
```

## Architecture Reference

### 三级检测

| 等级 | 检测目标 | 判定条件 | 动作 |
|------|----------|----------|------|
| L1 任务级 | 单个 Teamee | task-{id}.json 无更新且无新 progress_markers | restart 指令 |
| L2 会话级 | Team Lead | heartbeat.json 无更新 | 检查 OS 进程 |
| L3 进程级 | Claude Code CLI | OS 进程 PID 不存在 | abort_all 指令 |

### 四层防御

1. retry_count 计数器（max_retries: 3）
2. 动作消费确认（防止重复下发）
3. 指数退避（冷却: 0/2/5 分钟）
4. 全局熔断（连续 3 次失败触发）

### 重启策略

- `full_restart`：complexity_score <= 6 的简单任务
- `checkpoint_resume`：complexity_score > 6 的复杂任务，注入已完成文件上下文

## Configuration

配置文件：`.claude-daemon/daemon-config.json`

关键配置项：
- `check_interval_sec`: 守护进程轮询间隔（默认 30 秒）
- `timeouts.task_stalled_min`: 单任务无进展超时（默认 15 分钟）
- `retry.max_retries`: 单任务最大重试次数（默认 3）

## Error Handling

- **守护进程启动失败**：检查 `.claude-daemon/daemon-stdout.log` 和 `daemon-stderr.log`
- **任务反复重启**：查看熔断状态，可能需要调整 `timeouts.task_stalled_min` 或 `retry.max_retries`
- **进程检测不准**：Windows 上使用 `tasklist`，Unix 上使用 `kill -0`
