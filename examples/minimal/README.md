# Tackle Harness 最小示例项目

这是一个展示如何集成和使用 `tackle-harness` 的最小示例项目。

## 前置条件

- Node.js >= 18.0.0
- npm 或 yarn
- Claude Code（claude.ai/code 或 CLI）

## 安装步骤

### 1. 安装 tackle-harness

```bash
npm install tackle-harness
```

或使用全局安装：

```bash
npm install -g tackle-harness
```

### 2. 初始化项目

在项目根目录运行：

```bash
npx tackle-harness init --root .
```

或如果全局安装：

```bash
tackle-harness init --root .
```

此命令会：
- 创建 `.claude/` 目录
- 创建 `.claude/config/` 目录
- 生成 `harness-config.yaml` 配置文件
- 构建所有技能到 `.claude/skills/`
- 更新 `.claude/settings.json`

### 3. 验证安装

```bash
npx tackle-harness status --root .
```

你应该看到：
- `.claude/skills/` 目录已创建
- `.claude/hooks/` 目录已创建
- `settings.json` 已生成
- `harness-config.yaml` 配置有效

### 4. 验证插件

```bash
npx tackle-harness validate --root .
```

## 目录结构

初始化和构建后的项目结构：

```
minimal/
├── .claude/
│   ├── skills/           # 技能定义（构建后生成）
│   │   ├── task-creator/
│   │   ├── agent-dispatcher/
│   │   └── ...
│   ├── hooks/            # Hook 实现（构建后生成）
│   ├── config/
│   │   └── harness-config.yaml  # 配置文件
│   └── settings.json     # Claude Code 设置（自动生成）
└── README.md             # 本文档
```

## 常用命令

### 构建技能

```bash
npx tackle-harness build --root .
```

### 查看状态

```bash
npx tackle-harness status --root .
```

### 列出所有插件

```bash
npx tackle-harness list --root .
```

### 查看配置

```bash
npx tackle-harness config --root .
```

### 获取帮助

```bash
npx tackle-harness --help
```

## 工作包示例

项目包含一个示例工作包文件，展示工作包文档格式：

- [`docs/wp/WP-SAMPLE-001.md`](https://github.com/ph419/tackle-harness/blob/main/examples/minimal/docs/wp/WP-SAMPLE-001.md) — 包含任务列表、验收标准、测试用例的完整示例

常用工作流演示见 [`docs/workflow-guide.md`](https://github.com/ph419/tackle-harness/blob/main/examples/minimal/docs/workflow-guide.md)。

## 配置说明

配置文件位于 `.claude/config/harness-config.yaml`，包含以下主要部分：

- **context_window**: 控制文件读取策略和分块行为
- **workflow**: 定义开发工作流阶段和转换规则
- **roles**: AI Agent 角色系统配置
- **memory**: 知识存储和检索配置
- **agent_dispatcher**: 子代理并发调度配置

详见配置文件中的注释说明。

## 使用工作流

在 Claude Code 中，你可以使用以下技能：

1. **task-creator**: 创建工作包定义
2. **split-work-package**: 拆分大型任务
3. **human-checkpoint**: 人工审核检查点
4. **agent-dispatcher**: 批量调度子代理执行
5. **checklist**: 质量检查清单
6. **completion-report**: 生成完成报告

## 更多资源

- [主项目 README](https://github.com/ph419/tackle-harness/blob/main/README.md)
- [开发指南](https://github.com/ph419/tackle-harness/blob/main/CLAUDE.md)
- [配置模板](https://github.com/ph419/tackle-harness/blob/main/templates/harness-config.yaml)
