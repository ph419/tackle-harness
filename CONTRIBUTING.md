# 贡献指南

感谢你对 Tackle Harness 的关注！我们欢迎所有形式的贡献——无论是修复 Bug、新增功能、改进文档，还是提出建议。

## 目录

- [行为准则](#行为准则)
- [环境准备](#环境准备)
- [开发工作流](#开发工作流)
- [代码规范](#代码规范)
- [Commit Message 规范](#commit-message-规范)
- [分支管理](#分支管理)
- [测试要求](#测试要求)
- [报告 Bug 与功能建议](#报告-bug-与功能建议)
- [插件开发](#插件开发)

---

## 行为准则

本项目遵循 [Contributor Covenant](https://www.contributor-covenant.org/) 行为准则。参与本项目的所有贡献者应秉持尊重、包容的态度进行交流。不当行为将不被容忍。

简而言之：善待他人，就事论事，尊重不同的观点和经验。

---

## 环境准备

### 前置要求

- **Node.js** >= 18.0.0（推荐使用 LTS 版本）
- **Git** >= 2.0
- 一个代码编辑器（推荐 VS Code）

### 本地搭建

1. **Fork 本仓库**

   点击 GitHub 页面右上角的 **Fork** 按钮，将仓库复制到你的 GitHub 账户下。

2. **Clone 到本地**

   ```bash
   git clone https://github.com/<your-username>/tackle.git
   cd tackle
   ```

3. **添加上游仓库**

   ```bash
   git remote add upstream https://github.com/ph419/tackle.git
   ```

4. **验证构建**

   ```bash
   # 构建所有技能并验证插件完整性
   node bin/tackle.js build
   node bin/tackle.js validate
   ```

   如果构建和验证均无报错，说明环境准备就绪。

---

## 开发工作流

### 1. 创建分支

从最新的 `main` 分支创建你的工作分支：

```bash
git checkout main
git pull upstream main
git checkout -b <branch-name>   # 分支命名见下方规范
```

### 2. 开发与测试

进行代码修改后，确保通过以下检查：

```bash
# 构建验证
node bin/tackle.js build

# 插件完整性验证
node bin/tackle.js validate

# 运行全部测试
npm test

# 仅运行 runtime 单元测试
npm run test:runtime

# 仅运行集成测试
npm run test:integration

# 运行单个测试文件
node --test test/runtime/test-harness-build.js
```

项目使用 Node.js 内置的 `node:test` 测试框架，无需安装额外依赖。

### 3. 提交修改

遵循 [Conventional Commits](#commit-message-规范) 格式编写提交信息：

```bash
git add <changed-files>
git commit -m "feat(skill): add new checklist validation rule"
```

### 4. 推送并创建 Pull Request

```bash
git push origin <branch-name>
```

然后在 GitHub 上发起 Pull Request（PR），填写以下信息：

- **标题**：简洁描述变更内容，遵循 Conventional Commits 格式
- **描述**：
  - 变更的动机和背景
  - 涉及的文件和模块
  - 如何验证变更（测试步骤）
  - 关联的 Issue（如有）：`Fixes #123` 或 `Relates to #456`

### 5. 代码审查

项目维护者会审查你的 PR。审查过程中可能提出修改建议：

1. 根据反馈在本地修改代码
2. 提交并推送到同一分支（PR 会自动更新）
3. 等待再次审查

### 6. 合并

审查通过后，维护者会合并你的 PR。感谢你的贡献！

---

## 代码规范

### 通用原则

- **简洁优先**：不做多余的抽象，不过度设计
- **一致性**：遵循项目中已有的代码风格和命名约定
- **最小变更**：只做必要的修改，不夹带无关的重构

### JavaScript 规范

- 使用 **2 空格缩进**
- 使用单引号 `'` 包裹字符串
- 语句末尾加分号 `;`
- 使用 `const` / `let`，不使用 `var`
- 使用模板字符串拼接多行文本

> **Lint 配置：** 项目暂未配置 ESLint，请参照现有代码风格保持一致。如需引入 ESLint，欢迎提交 Proposal。

### Markdown 规范

- 使用 ATX 风格标题（`#` 前缀）
- 代码块标注语言类型：` ```bash `、` ```json `、` ```yaml `
- 表格使用对齐的管道符
- 中英文之间加空格（如 "使用 Node.js 构建"）

### 插件规范

开发新插件时，请确保：

1. 每个插件目录包含 `plugin.json` 元数据文件
2. Skill 插件包含 `skill.md` 指令文件
3. Hook / Validator / Provider 插件包含 `index.js` 实现文件
4. 在 `plugins/plugin-registry.json` 中注册新插件
5. 如有外部依赖，在 `plugin.json` 的 `dependencies` 字段中声明

详细的插件开发指南请参阅 [docs/plugin-development.md](https://github.com/ph419/tackle/blob/main/docs/design/plugin-development.md)。

---

## Commit Message 规范

本项目遵循 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type（必填）

| Type | 说明 |
|------|------|
| `feat` | 新增功能 |
| `fix` | 修复 Bug |
| `docs` | 文档变更 |
| `style` | 代码格式调整（不影响功能） |
| `refactor` | 代码重构（不新增功能、不修复 Bug） |
| `test` | 添加或修改测试 |
| `chore` | 构建、工具、依赖等变更 |
| `ci` | CI/CD 配置变更 |

### Scope（可选）

| Scope | 说明 |
|-------|------|
| `skill` | Skill 插件相关 |
| `provider` | Provider 插件相关 |
| `hook` | Hook 插件相关 |
| `validator` | Validator 插件相关 |
| `runtime` | 运行时模块（构建工具、加载器等） |
| `cli` | CLI 命令相关 |
| `docs` | 文档相关 |

### 示例

```
feat(skill): add export functionality to completion-report

Add ability to export completion reports in Markdown and JSON formats.

Relates to #42
```

```
fix(hook): resolve skill-gate blocking legitimate edits

The state check was incorrectly comparing string types.
```

```
docs: update plugin development guide with hook examples
```

---

## 分支管理

### 分支命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 新功能 | `feat/<short-description>` | `feat/export-completion-report` |
| Bug 修复 | `fix/<short-description>` | `fix/skill-gate-state-check` |
| 文档 | `docs/<short-description>` | `docs/plugin-dev-guide` |
| 重构 | `refactor/<short-description>` | `refactor/simplify-build-process` |
| 其他 | `chore/<short-description>` | `chore/update-dependencies` |

### 命名要求

- 使用小写英文
- 单词间用 `-` 连接
- 名称简洁且能描述变更内容
- 避免使用 issue 编号作为分支名

### 分支策略

- `main` — 稳定分支，所有 PR 合并到此
- `feat/*`、`fix/*` 等 — 功能分支，从 `main` 创建，完成后通过 PR 合并回 `main`

保持你的功能分支与 `main` 同步：

```bash
git fetch upstream
git rebase upstream/main
```

---

## 测试要求

### 测试框架

项目使用 Node.js 内置的 `node:test`，无需安装外部依赖。

### 测试命令

```bash
# 运行全部测试
npm test

# 仅运行 runtime 单元测试
npm run test:runtime

# 仅运行集成测试
npm run test:integration

# 运行单个测试文件
node --test test/runtime/test-harness-build.js

# 端到端冒烟测试
npm run test:smoke
```

### 测试文件组织

| 目录 | 说明 |
|------|------|
| `test/runtime/` | Runtime 模块单元测试 |
| `test/integration/` | 集成测试 |
| `test/smoke-test.js` | 端到端冒烟测试 |

测试文件命名格式：`test-{module}.js`

### 新增代码的测试要求

- 新功能必须包含对应测试
- Bug 修复应包含回归测试
- PR 提交前确保所有测试通过：`npm test`

---

## 报告 Bug 与功能建议

### Bug 报告

在 [GitHub Issues](https://github.com/ph419/tackle/issues) 中创建新 Issue，使用 **Bug Report** 标签，并包含以下信息：

1. **Bug 描述**：清晰描述遇到的问题
2. **复现步骤**：
   1. 执行 `npx tackle-harness build`
   2. 进入项目目录 `...`
   3. 执行 `...`
   4. 观察到错误 `...`
3. **期望行为**：你期望发生什么
4. **实际行为**：实际发生了什么
5. **环境信息**：
   - 操作系统（如 Windows 11、macOS 15）
   - Node.js 版本（`node -v` 输出）
   - Tackle Harness 版本
6. **附加信息**：错误日志、截图等

### 功能建议

创建新 Issue 时使用 **Feature Request** 标签，包含：

1. **需求背景**：你希望解决什么问题
2. **建议方案**：你期望的实现方式
3. **替代方案**：你考虑过的其他方案
4. **附加上下文**：任何有助于理解需求的信息

---

## 插件开发

如果你想为 Tackle Harness 开发新插件，请先阅读以下文档：

- [插件开发指南](https://github.com/ph419/tackle/blob/main/docs/design/plugin-development.md) — 完整的插件创建流程
- [配置参考](https://github.com/ph419/tackle/blob/main/docs/design/config-reference.md) — 配置文件格式说明
- [日常工作流指南](https://github.com/ph419/tackle/blob/main/docs/design/daily-workflow-guide.md) — 使用场景与 Skill 速查

### 快速开始：创建一个新 Skill 插件

1. 在 `plugins/core/` 下创建插件目录：

   ```bash
   mkdir -p plugins/core/skill-my-feature
   ```

2. 创建 `plugin.json`：

   ```json
   {
     "name": "skill-my-feature",
     "version": "1.0.0",
     "type": "skill",
     "description": "我的新技能",
     "triggers": ["触发词1", "触发词2"],
     "dependencies": [],
     "provides": ["skill:my-feature"],
     "metadata": {
       "gatedByCode": true
     },
     "config": {}
   }
   ```

3. 创建 `skill.md`，编写技能指令

4. 在 `plugins/plugin-registry.json` 中注册插件

5. 构建并验证：

   ```bash
   node bin/tackle.js build
   node bin/tackle.js validate
   ```

---

## 问题与帮助

如果你有任何问题，可以通过以下方式获取帮助：

- 在 [GitHub Issues](https://github.com/ph419/tackle/issues) 中提问
- 查阅 [文档目录](https://github.com/ph419/tackle/tree/main/docs/design/) 中的相关文档

再次感谢你的贡献！每一个 PR、每一个 Issue、每一行代码都让 Tackle Harness 变得更好。
