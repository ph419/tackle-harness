# Tackle Harness 示例项目

本目录包含 `tackle-harness` 的示例项目，展示如何在不同场景下集成和使用该框架。

## 示例列表

### [minimal/](https://github.com/ph419/tackle-harness/tree/main/examples/minimal/)

最小示例项目，展示：
- 基本项目结构
- 配置文件设置
- 初始化和构建流程
- 常用命令演示

适用场景：初次接触 tackle-harness，快速了解集成方式。

## 快速开始

### 1. 进入示例目录

```bash
cd examples/minimal
```

### 2. 安装依赖

```bash
npm install tackle-harness
```

### 3. 初始化项目

```bash
npx tackle-harness init --root .
```

### 4. 验证安装

```bash
npx tackle-harness status --root .
```

## 目录结构说明

典型的集成项目结构：

```
your-project/
├── .claude/                    # Claude Code 配置目录
│   ├── skills/                 # 技能定义（构建后生成）
│   ├── hooks/                  # Hook 实现（构建后生成）
│   ├── config/
│   │   └── harness-config.yaml # 配置文件
│   └── settings.json           # Claude Code 设置
├── node_modules/
│   └── tackle-harness/         # npm 包
└── package.json
```

## 更多资源

- [主项目 README](https://github.com/ph419/tackle-harness/blob/main/README.md)
- [开发指南](https://github.com/ph419/tackle-harness/blob/main/CLAUDE.md)
- [配置模板](https://github.com/ph419/tackle-harness/blob/main/templates/harness-config.yaml)
- [npm 包](https://www.npmjs.com/package/tackle-harness)
