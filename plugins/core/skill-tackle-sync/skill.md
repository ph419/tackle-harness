---
name: tackle-sync
description: Setup or migrate tackle-harness in the current project
---

# Tackle Harness 项目配置管理

根据当前项目目录的状态，自动判断需要执行初始化、构建还是迁移。

## 状态检测与自动决策

执行任何操作前，先检测以下状态：

```bash
# 1. 确认全局安装
npm list -g tackle-harness
```

然后检查当前项目目录（或 `--root` 指定目录）：

| 检查项 | 路径 | 含义 |
|--------|------|------|
| 配置文件 | `.claude/config/harness-config.yaml` | 项目是否已初始化 |
| 清单文件 | `.claude/harness-manifest.json` | 插件注册状态 |
| 设置文件 | `.claude/settings.json` | hooks 是否注册 |
| 项目级 skills | `.claude/skills/` | 旧版残留（需迁移） |
| 项目级 hooks | `.claude/hooks/` | 旧版残留（需迁移） |

### 决策逻辑

```
项目级 skills/hooks 目录存在？
  ├─ 是 → 旧版项目，运行 migrate + build
  └─ 否
      └─ harness-config.yaml 存在？
          ├─ 是 → 已初始化，运行 build（更新到最新）
          └─ 否 → 新项目，运行 init + build
```

## 操作说明

### 初始化（新项目）

当项目目录中不存在 `.claude/config/harness-config.yaml` 时自动执行。

```bash
tackle-harness init
tackle-harness build
```

### 更新（已初始化项目）

当项目已有配置但需要同步最新插件时自动执行。

```bash
tackle-harness build
```

### 迁移（旧版项目）

当项目存在 `.claude/skills/` 或 `.claude/hooks/` 目录时自动执行。

```bash
tackle-harness migrate
tackle-harness build
```

## 错误处理

| 场景 | 处理 |
|------|------|
| 全局未安装 | 提示 `npm install -g tackle-harness` |
| 构建失败 | 运行 `tackle-harness validate` 定位问题 |
| 权限不足 | 提示检查文件系统权限 |

所有命令支持 `--root /path/to/project` 指定目标项目。build 支持 `--verbose` 查看详细输出。
