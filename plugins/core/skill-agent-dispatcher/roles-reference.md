# Agent Dispatcher — 角色赋能与记忆注入参考

> 本文档由 `skill-agent-dispatcher` 在 Step 4-5 阶段按需读取，不作为独立 skill 触发。

---

## Step 4: 角色匹配算法

```python
def match_role(work_package):
    """匹配最合适的角色"""
    scores = {}

    for role in roles:
        score = 0
        # 关键词匹配 (权重 0.5)
        for keyword in work_package.keywords:
            if keyword in role.keywords:
                score += 0.5

        # 任务类型匹配 (权重 0.3)
        if work_package.type in role.task_types:
            score += 0.3

        # 模块标签匹配 (权重 0.2)
        for tag in work_package.tags:
            if tag in role.module_tags:
                score += 0.2

        scores[role.id] = score

    return max(scores, key=scores.get)
```

### 角色匹配失败回退

```
⚠️ 无法自动匹配角色，使用默认 general-purpose
工作包: WP-XXX
建议手动指定角色
```

---

## Step 5: 预计算角色 + 记忆准备

**⚠️ 重要**: 角色匹配和记忆注入在监控循环之前完成（预计算），为每个工作包准备好角色 Prompt。

```
# 预计算所有工作包的角色匹配结果和记忆

wp_assignments = {}  # {task_id: {role_id, role_prompt, memories, wp_doc_path}}

for task in tasks:
    wp = extract_work_package(task)
    role = match_role(wp)
    memories = load_memories(role.id)
    wp_assignments[task.id] = {
        "role_id": role.id,
        "role_prompt": role.prompt_template,
        "memories": memories,
        "wp_doc_path": wp.doc_path
    }
```

**为什么预计算**:
- 监控循环中按需创建 Teamee 时，直接使用预计算结果构建 Prompt
- 避免在监控循环中重复执行角色匹配逻辑
- 角色匹配算法不变（仍使用 Step 4 中的算法）

---

## 角色赋能系统

### 核心角色（通用框架）

| 角色ID | 名称 | 匹配关键词 |
|--------|------|------------|
| `coordinator` | 协调者 | 调度、协调、监控、分配、统筹 |
| `architect` | 架构师 | 架构、设计、结构、模块、接口 |
| `implementer` | 实现者 | 实现、编码、开发、修复、重构 |
| `tester` | 测试者 | 测试、验证、检查、单元测试 |
| `documenter` | 文档编写者 | 文档、说明、注释、README |

### 领域角色（由项目模板扩展）

| 角色ID | 名称 | 匹配关键词 |
|--------|------|------------|
| `frontend-dev` | 前端开发 | 前端、UI、组件、样式 |
| `backend-dev` | 后端开发 | 后端、API、服务、数据库 |
| `devops` | 运维专家 | 部署、CI/CD、Docker、容器 |
| `godot-scene-expert` | Godot 场景+UI专家 | 场景、节点、tscn、UI（Godot模板）|

### 拆分工作包角色自动匹配

| 子工作包类型 | 自动匹配角色 |
|--------------|--------------|
| `-impl` | 根据关键词匹配领域专家 |
| `-test` | test-reviewer |
| `-verify` | test-reviewer |
| `-review` | code-reviewer |

### 角色文件位置

| 文件类型 | 路径 |
|----------|------|
| 角色注册表 | `.claude/agents/role-registry.yaml` |
| 元角色定义 | `.claude/agents/roles/meta/{role_id}.yaml` |
| 职能角色定义 | `.claude/agents/roles/functional/{role_id}.yaml` |
| 领域角色定义 | `.claude/agents/roles/domain/{role_id}.yaml` |
| 专属经验库 | `.claude/agents/memories/{role_id}.md` |

---

## 记忆注入机制

### 经验提取逻辑

1. **读取角色专属库**：`.claude/agents/memories/{role_id}.md`
2. **回退机制**：如专属库不足，读取 `docs/EXPERIENCE.md`
3. **按标签过滤**：使用角色的 `experience_tags` 过滤
4. **动态数量**：
   - 简单任务（<2h）：1-2 条
   - 中等任务（2-4h）：3 条
   - 复杂任务（>4h）：5 条

---

## 经验沉淀闭环

执行完成后：

1. **分析 Teamee 输出** - 提取新经验
2. **写入角色专属库** - `.claude/agents/memories/{role_id}.md`
3. **同步到 EXPERIENCE.md** - 去重合并
4. **触发 experience-logger** - 记录本次执行的经验

---

## Teamee Prompt 模板

以下模板用于 `build_single_task_prompt()` 函数，在 Step 6 / Step 6.5 创建 Teamee 时使用。

```markdown
# [角色名称] - 单一任务专用执行

## 你的身份
{角色 prompt_template}

## 团队信息
- 团队名称: {team_name}
- 你的角色: {role_id}

## 任务绑定 (1:1 专用)

**⚠️ 重要：你只负责处理一个任务，不可认领其他任务！**

- 分配给你的任务 ID: {task_id}
- 任务主题: {task_subject}
- 完成此任务后，你将被立即销毁释放资源
- **禁止** 认领或执行其他任务
- 可以调用 TaskList 查看全局进度，但仅限查看，不可对其他任务执行 TaskUpdate

## 📖 首要任务：阅读工作包文档

**执行任何任务前，必须先读取工作包文档！**

1. 确认任务后，立即读取任务 description 中指定的工作包文档
2. 工作包文档路径格式: `docs/wp/WP-XXX.md` 或 `docs/wp/WP-XXX-N-type.md`
3. 从文档中获取: 问题分析/上下文、实施计划 Step 1-N、关键文件列表、验收标准

## 工作流程 (必须严格遵守)

### 1. 确认任务分配
TaskGet(taskId="{task_id}") — 验证 owner 是你、status 是 pending 或 in_progress

### 2. 开始执行
- 立即将 status 改为 "in_progress": TaskUpdate(taskId="{task_id}", status="in_progress")
- 读取工作包文档获取完整上下文
- 按任务描述执行
- 完成验收标准

### 3. 完成任务
TaskUpdate(taskId="{task_id}", status="completed")

### 4. 等待关闭 (🔴 必须响应)

**完成任务后，不要查找其他任务！直接等待 Lead 的 shutdown_request。**

当收到 `shutdown_request` 消息时，**必须**发送响应：

```
SendMessage(
    to="team-lead",
    message={
        "type": "shutdown_response",
        "request_id": "{从 shutdown_request 中提取的 request_id}",
        "approve": true
    }
)
```

发送响应后，你的工作结束，可以退出。

**⚠️ SendMessage 使用注意**:
如果需要向 Lead 发送消息（非 shutdown_response），必须遵守：
- 使用 object 类型 message：`message={"type": "status_update", ...}`
- 如果使用 string message：必须提供 `summary` 参数
- 禁止发送 string message 但不提供 summary

**⚠️ 禁止事项**:
- 不要认领或执行其他任务（可以查看 TaskList 了解进度，但不可对其他任务执行 TaskUpdate）
- 不要在完成后继续工作
- 必须等待 Lead 的 shutdown_request，不要主动退出

## 相关经验（从历史中学习）

### 经验 1: {标题}
**问题**: {problem}
**解决方案**: {solution}

## 输出要求
1. 修改/新增的文件清单
2. 验收标准完成情况
3. 遇到的问题和解决方案
4. **如有新经验，请按以下格式总结**：
   ```
   ### [标签] 经验标题
   **问题**: ...
   **解决方案**: ...
   ```

## 任务完成后必须执行 (Critical!)

### 状态同步 (不可跳过)
完成工作包后，你必须更新以下文档：

1. **更新 task.md**: 将工作包状态改为 `✅ 完成`，添加到"最近完成"列表
2. **更新 docs/wp/WP-XXX.md** (如存在): 更新状态为 ✅ 完成，添加完成日期
3. **验证同步**: 重新读取 task.md 确认状态已更新

⚠️ 如果不执行状态同步，工作包将被视为未完成！

## 重要提醒
- **你只处理一个任务** — 完成后等待 shutdown，不要查找其他任务
- 完成后必须执行测试验证
- 如遇阻塞问题，在任务描述中说明阻塞原因
- 不要跳过任何验收标准
- 任务完成后立即更新状态为 completed，方便 Lead 检测并解锁依赖任务
- 收到 shutdown_request 后立即响应，不要延迟
```
