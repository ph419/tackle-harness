# Agent Dispatcher — 团队清理参考

> 本文档由 `skill-agent-dispatcher` 在 Step 7 阶段按需读取，不作为独立 skill 触发。

---

## ⚠️ 权限要求

本 skill 的 Step 7 清理流程需要 Bash 工具权限来：
- 验证目录是否存在 (`test -d`)
- 在 TeamDelete 失败时执行文件系统级删除 (`rm -rf`)

**建议权限配置**（添加到 settings.json 的 `permissions.allow` 中）：
```json
{
  "allow": [
    "Bash(test -d $HOME/.claude/teams/*)",
    "Bash(test -d $HOME/.claude/tasks/*)",
    "Bash(rm -rf $HOME/.claude/teams/*)",
    "Bash(rm -rf $HOME/.claude/tasks/*)"
  ]
}
```

如果权限被拒绝，清理流程会提示用户手动执行 `清理团队`。

---

## Step 7: 清理团队 (🔴 强制执行 + 验证)

<HARD-GATE>
TeamDelete 必须执行，且必须验证结果！
注意：大部分 Teamee 已在 Step 6.5 监控循环中即时销毁。
此步骤负责最终的 TeamDelete 调用和验证。
不信任 TeamDelete 返回值，必须检查目录是否真的被删除！
以下步骤必须按顺序逐一执行，不可跳过！
</HARD-GATE>

> **设计说明**: 以下使用显式步骤而非循环，确保 AI agent 能忠实执行每一步。
> 路径使用 `$HOME` 变量（Git Bash 兼容 Windows）。

---

### Step 7a: 安全检查（3 个前置条件）

**条件 1** — `team_name` 非空且仅含合法字符 `[a-zA-Z0-9_-]`
- 失败 → 打印 `❌ 错误：team_name 无效` → 提示手动执行 `清理团队` → **停止**

**条件 2** — 团队目录存在
- 用 Bash 检查: `test -d "$HOME/.claude/teams/$team_name" && echo "EXISTS" || echo "NOT_FOUND"`
- 返回 `NOT_FOUND` → 打印 `ℹ️ 团队目录不存在，可能已被清理，跳过` → **停止**

**条件 3** — 路径安全验证
- 用 Bash 检查: `basename "$HOME/.claude/teams/$team_name"` 应返回 `$team_name`
- 不匹配 → 打印 `❌ 安全检查失败：路径异常` → 提示手动执行 `清理团队` → **停止**

全部通过 → 继续 Step 7b

---

### Step 7b: 发送 shutdown_request (清理残留 Teamee)

检查 `teamee_map` 中是否还有未销毁的 Teamee:
```
# 检查映射表中是否还有残留 Teamee
if teamee_map is not empty:
    # ── 状态输出（直接文本输出，禁止使用 SendMessage）──
    # 输出: "⚠️ 发现 {len(teamee_map)} 个未销毁的 Teamee，发送 shutdown_request"
    for task_id, teamee_name in teamee_map.items():
        SendMessage(to=teamee_name, message={
            "type": "shutdown_request",
            "reason": "最终清理阶段，准备 TeamDelete",
            "request_id": f"final-shutdown-{task_id}-{timestamp()}"
        })
else:
    # ── 状态输出（直接文本输出，禁止使用 SendMessage）──
    # 输出: "所有 Teamee 已在监控循环中即时销毁，无需额外 shutdown"

# 额外安全网: 读取团队配置检查是否有遗漏的成员
# (防止映射表不一致的情况)
config = Read("~/.claude/teams/$team_name/config.json")
for member in config.members:
    if member.name != "team-lead" and member.name not in teamee_map.values():
        SendMessage(to=member.name, message={
            "type": "shutdown_request",
            "reason": "最终清理阶段，发现未在映射表中的成员",
            "request_id": f"orphan-shutdown-{member.name}-{timestamp()}"
        })
```

---

### Step 7c: 等待 shutdown 响应（最多 15 秒）

等待所有 Teamee 的 `shutdown_response`。
如果 15 秒内未全部响应，不再等待，继续执行清理。

---

### Step 7d: 执行 TeamDelete（第 1 次）

调用 `TeamDelete()` 工具。

**验证** — 用 Bash 检查目录是否真的被删除:
```bash
test -d "$HOME/.claude/teams/$team_name" && echo "EXISTS" || echo "GONE"
test -d "$HOME/.claude/tasks/$team_name" && echo "EXISTS" || echo "GONE"
```

- 两个都返回 `GONE` → 打印 `✅ 清理成功（验证通过）` → **跳到 Step 7g**
- 任一返回 `EXISTS` → 继续 Step 7e

---

### Step 7e: 执行 TeamDelete（第 2 次，等待 2 秒后重试）

调用 `TeamDelete()` 工具。

**验证** — 同 Step 7d 的 Bash 检查。

- 两个都返回 `GONE` → 打印 `✅ 清理成功（第 2 次尝试）` → **跳到 Step 7g**
- 任一返回 `EXISTS` → 继续 Step 7f

---

### Step 7f: 文件系统级强制清理（TeamDelete 回退方案）

打印 `🔥 TeamDelete 两次失败，执行文件系统级清理...`

**安全确认** — 再次验证路径:
```bash
basename "$HOME/.claude/teams/$team_name"
```
- 返回值不等于 `$team_name` → 打印 `❌ 安全检查失败` → 提示手动执行 `清理团队` → **停止**

**执行删除**（逐个目录，检查存在后再删）:
```bash
# 删除团队目录（仅当存在时）
test -d "$HOME/.claude/teams/$team_name" && rm -rf "$HOME/.claude/teams/$team_name" && echo "DELETED" || echo "SKIP_OR_FAIL"

# 删除任务目录（仅当存在时）
test -d "$HOME/.claude/tasks/$team_name" && rm -rf "$HOME/.claude/tasks/$team_name" && echo "DELETED" || echo "SKIP_OR_FAIL"
```

如果 Bash `rm -rf` 权限被拒绝:
- 打印 `⚠️ 权限不足，无法执行文件系统删除`
- 提示用户手动执行 `清理团队` 或 `rm -rf "$HOME/.claude/teams/$team_name" "$HOME/.claude/tasks/$team_name"`

---

### Step 7g: 最终验证

用 Bash 确认两个目录都已清除:
```bash
test -d "$HOME/.claude/teams/$team_name" && echo "STILL_EXISTS" || echo "CLEAN"
test -d "$HOME/.claude/tasks/$team_name" && echo "STILL_EXISTS" || echo "CLEAN"
```

- 两个都返回 `CLEAN` → 打印 `✅ 清理流程完成`
- 任一返回 `STILL_EXISTS` → 打印 `❌ 清理失败！请手动执行: 清理团队`

---

### Step 7h: 记录清理日志

记录清理结果到执行报告（成功/失败、尝试次数、使用的方法）。

---

## Error Handling

### 循环依赖
```
❌ 检测到循环依赖: WP-037 → WP-038 → WP-039 → WP-037
请手动解除依赖关系后重试。
```

### Teamee 执行失败
```
⚠️ Task #2 执行失败
Owner: godot-script-expert-t2
状态: in_progress (卡住)
处理: Lead 发送 shutdown_request 即时销毁该 Teamee
      从 teamee_map 移除映射
      创建新 Teamee 重试 或 人工介入
```

### 部分任务超时
```
⚠️ Task #3 等待依赖超时
依赖: Task #2 (状态: in_progress, 超过 30 分钟)
处理: 检查 Task #2 的 Teamee 状态
      必要时发送消息确认进度
```

### 清理超时
```
⚠️ 清理等待超时（30秒）
可能原因：
- Teamee 没有响应 shutdown_request
- Teamee 使用了 Explore 等只读 agent（没有 SendMessage 工具）
- Teamee 进程卡死

处理：
- 强制执行 TeamDelete（不是 rm -rf！）
- 建议用户检查是否有残留进程
- 检查 Step 5 是否使用了正确的 subagent_type
```

---

## Cleanup Guarantee (清理保障)

```
┌─────────────────────────────────────────────────────────────┐
│                    强制清理检查点                             │
│                                                             │
│  ✅ 正常完成 → Step 6.5 即时销毁 → Step 7 最终清理 → TeamDelete │
│  ✅ 部分失败 → Step 6.5 即时销毁 → Step 7 最终清理 → TeamDelete │
│  ✅ 超时     → Step 6.5 超时销毁 → Step 7 强制清理 → TeamDelete │
│  ✅ 异常中断 → 捕获中断 → Step 7 强制销毁残留 → TeamDelete     │
│                                                             │
│  ❌ 无任何情况可以跳过 TeamDelete！                          │
└─────────────────────────────────────────────────────────────┘
```
