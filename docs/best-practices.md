# 最佳实践

> 面向实际使用场景的 Tackle Harness 实践指南
> 版本: 0.0.21 | 更新: 2026-05-09

本文档提供了使用 Tackle Harness 的最佳实践建议，涵盖项目初始化、配置优化、多项目管理等核心场景。

## 目录

- [项目初始化](#项目初始化)
- [配置优化](#配置优化)
- [多项目管理](#多项目管理)
- [工作流使用](#工作流使用)
- [性能调优](#性能调优)
- [安全最佳实践](#安全最佳实践)
- [团队协作](#团队协作)
- [常见陷阱](#常见陷阱)

---

## 项目初始化

### 推荐方式：全局安装

**全局安装**是推荐的方式，一次安装，所有项目共用。

```bash
# 1. 全局安装 Tackle Harness
npm install -g tackle-harness

# 2. 进入项目目录
cd your-project

# 3. 一键初始化（创建配置目录 + 注册钩子）
tackle-harness init
```

全局安装后，你的项目结构非常简洁：

```
your-project/
  .claude/
    config/
      harness-config.yaml            # 可选的配置文件
    settings.json                    # 自动注册的 hooks
```

技能和钩子由全局安装管理，不再需要本地的 `skills/` 和 `hooks/` 目录。

### 旧项目迁移

如果你之前使用的是本地安装模式（项目中有 `.claude/skills/` 和 `.claude/hooks/` 目录），迁移很简单：

```bash
# 1. 全局安装
npm install -g tackle-harness

# 2. 进入项目目录
cd your-project

# 3. 执行迁移命令
tackle-harness migrate
```

迁移命令会自动：
- 删除本地的 `.claude/skills/` 和 `.claude/hooks/` 目录
- 更新 `.claude/settings.json` 指向全局路径
- 保留你的配置文件（`harness-config.yaml`）

### 验证安装

```bash
# 查看全局安装是否成功
npm list -g tackle-harness

# 检查项目配置是否正确
tackle-harness status

# 验证插件格式
tackle-harness validate
```

### 备选方式：本地安装

如果无法使用全局安装，可以使用 `npx` 方式：

```bash
# 本地安装（不推荐，需要在每个项目中重复安装）
npm install tackle-harness

# 使用时需要加 npx 前缀
npx tackle-harness init
npx tackle-harness build
```

---

## 配置优化

### 环境变量使用

敏感信息应该使用环境变量：

```yaml
# harness-config.yaml

# 不好的做法
mcp:
  servers:
    - name: "github"
      token: "ghp_xxxxxxxxx"  # 硬编码的敏感信息

# 好的做法
mcp:
  servers:
    - name: "github"
      env:
        GITHUB_TOKEN: "${GITHUB_TOKEN}"  # 环境变量
```

### 配置分离

将通用配置和项目特定配置分离：

```yaml
# base-config.yaml (通用配置，可复用)
project:
  version: "1.0.0"

# harness-config.yaml (项目特定配置)
extends: "base-config"
project:
  name: "my-project"
```

### 条件配置

根据环境使用不同配置：

```yaml
development:
  debug: true
  log_level: "debug"

production:
  debug: false
  log_level: "warn"
```

---

## 多项目管理

### 一个全局安装，多个项目

全局安装后，所有项目共用同一套技能和钩子。每个项目只需要自己的配置文件：

```
~/
  .npm/
    global/
      node_modules/
        tackle-harness/           # 全局安装位置
          plugins/
            core/                  # 21 个插件
          ...

project-a/
  .claude/
    config/
      harness-config.yaml          # 项目 A 的配置
    settings.json

project-b/
  .claude/
    config/
      harness-config.yaml          # 项目 B 的配置
    settings.json
```

### 配置差异管理

不同项目间的配置差异通过 `harness-config.yaml` 管理：

```yaml
# project-a/.claude/config/harness-config.yaml
project:
  name: "Project A"
  context_window:
    enabled: true
    chunk_size: 50

# project-b/.claude/config/harness-config.yaml
project:
  name: "Project B"
  context_window:
    enabled: false
```

### 版本升级和兼容性

```bash
# 升级全局安装
npm update -g tackle-harness

# 检查版本
tackle-harness version

# 验证插件兼容性
tackle-harness validate
```

升级后，所有使用全局安装的项目自动获得新版本，无需逐个更新。

### 跨项目路径支持

全局安装支持 Windows 和 Unix 路径：

```bash
# Windows
tackle-harness build --root D:/path/to/project
tackle-harness build --root D:\path\to\project

# Unix/Mac
tackle-harness build --root /path/to/project
```

---

## 工作流使用

### 选择合适的技能

| 场景 | 推荐技能 | 阶段 |
|------|----------|------|
| 单个任务 | task-creator | P0 |
| 批量任务 | batch-task-creator | P0 |
| 大型需求 | split-work-package | P0 |
| 并行执行 | agent-dispatcher | P2 |
| 质量检查 | checklist | P3 |
| 经验记录 | experience-logger | P3 |
| 完成报告 | completion-report | P4 |

> 完整的场景流程图请参阅 [日常工作流指南](daily-workflow-guide.md)

### 检查点使用

在工作流关键阶段，系统会自动暂停等待你确认：

```
P0 规划 → 🔴 P1 人工审核（强制） → P2 执行
```

通过 `human-checkpoint` 技能，AI 会展示方案，等你确认后才继续。

### 自定义配置

根据项目需求自定义 `harness-config.yaml`：

```yaml
context_window:
  enabled: true
  chunk_size: 50
  overlap: 5

workflow:
  stages:
    - id: "custom-stage"
      name: "自定义阶段"
      skills: ["custom-skill"]
```

---

## 性能调优

### 记忆提取优化

```yaml
memory:
  auto_extraction:
    enabled: true
    min_confidence: 0.8  # 提高阈值减少低质量记忆
    batch_size: 10       # 批处理提高效率
```

### 并行执行优化

```yaml
agent_dispatcher:
  max_concurrent: 4      # 限制并发数（建议 ≤ 4）
  timeout: 300           # 设置超时（秒）
```

### MCP 连接池

```yaml
mcp:
  defaults:
    process_pool_size: 5  # 限制进程数量
    timeout: 30           # 设置超时
```

---

## 安全最佳实践

### 最小权限原则

```yaml
mcp:
  security:
    allowed_commands:
      - "npx"           # 只允许必要的命令
    forbidden_args:
      - "--insecure"    # 禁止不安全参数
```

### 敏感信息保护

- 使用环境变量存储敏感信息
- 不要在配置文件中硬编码密码
- 使用 `.gitignore` 排除敏感配置

```
# .gitignore 示例
.claude/config/secrets.yaml
.env.local
```

---

## 团队协作

### 配置版本控制

- 所有配置文件应该纳入 Git
- 使用 `.gitignore` 排除敏感信息
- 记录配置变更原因

```bash
# 追踪配置变更
git add .claude/config/harness-config.yaml
git commit -m "docs: 更新项目配置以支持新功能"
```

### 文档同步

- 配置变更时更新文档
- 使用 CHANGELOG.md 记录重要变更
- 保持 README.md 的时效性

### 团队配置统一

使用全局安装确保团队使用同一版本：

```bash
# 团队成员统一执行
npm install -g tackle-harness@0.0.21
```

在项目的 README.md 或 CONTRIBUTING.md 中说明推荐的版本。

---

## 常见陷阱

### 避免的配置错误

1. **循环依赖**: 角色或工作包不应该相互依赖
2. **过度配置**: 不必要的配置会增加复杂性
3. **硬编码路径**: 使用相对路径或环境变量

### 示例

```yaml
# 不好的配置
roles:
  - id: "role-a"
    inherits: "role-b"
  - id: "role-b"
    inherits: "role-a"  # 循环依赖

# 好的配置
roles:
  - id: "role-a"
    inherits: "base"
  - id: "role-b"
    inherits: "base"
```

### 调试技巧

启用调试模式：

```yaml
development:
  debug: true
  verbose: true
  log_level: "debug"
```

查看构建状态：

```bash
tackle-harness status
```

验证配置：

```bash
tackle-harness validate
tackle-harness validate-config
```

### CI/CD 集成

在 CI 环境中使用 Tackle Harness：

```yaml
# GitHub Actions 示例
- name: Setup Tackle Harness
  run: |
    npm install -g tackle-harness
    tackle-harness init --root $GITHUB_WORKSPACE
```

---

## 相关文档

- [日常工作流指南](daily-workflow-guide.md) - 按场景的使用手册
- [配置参考](config-reference.md) - 完整的配置文件说明
- [插件开发](plugin-development.md) - 插件架构和开发指南
