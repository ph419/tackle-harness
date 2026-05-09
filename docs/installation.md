# 安装与快速入门指南

本指南将帮助你在 5 分钟内完成 Tackle Harness 的安装、配置和首次运行。

## 目录

- [系统要求](#系统要求)
- [安装步骤](#安装步骤)
- [首次配置](#首次配置)
- [运行第一个工作流](#运行第一个工作流)
- [验证安装](#验证安装)
- [常用命令](#常用命令)
- [配置文件说明](#配置文件说明)
- [可用技能列表](#可用技能列表)
- [故障排除](#故障排除)
- [下一步](#下一步)

## 系统要求

- **Node.js**: >= 18.0.0
- **操作系统**: Windows、macOS 或 Linux
- **Claude Code**: 已安装并配置
- **npm**: >= 8.0.0（随 Node.js 安装）

## 安装步骤

### 推荐方式：全局安装

全局安装后，所有项目都可以直接使用 Tackle Harness，无需每个项目单独配置技能和钩子。

```bash
npm install -g tackle-harness
```

安装后，`tackle-harness` 命令将在系统任何位置可用。

### 验证安装

```bash
tackle-harness --help
```

如果显示帮助信息，说明安装成功。

### 备选方式：本地安装

如果你只想在单个项目中使用 Tackle Harness，可以在项目目录中本地安装：

```bash
npm install tackle-harness
```

本地安装后，需要使用 `npx` 运行命令：

```bash
npx tackle-harness --help
```

> **注意**：本地安装模式已过时，推荐使用全局安装以获得更好的体验。

### 权限问题（macOS/Linux）

如果在全局安装时遇到权限问题（`EACCES`），请参考以下解决方案：

**方案 1：使用权限修复脚本**

```bash
# 修复 npm 全局目录权限
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH

# 重新安装
npm install -g tackle-harness
```

将 `export` 行添加到 `~/.bashrc` 或 `~/.zshrc` 使其永久生效。

**方案 2：使用 sudo（不推荐）**

```bash
sudo npm install -g tackle-harness
```

### Windows 安装注意事项

Windows 系统上安装时请注意：

1. 以管理员身份运行终端（PowerShell 或 CMD）
2. 确保 npm 全局目录可写：
   ```powershell
   # 检查全局安装路径
   npm config get prefix
   ```
3. 如果路径包含空格或特殊字符，可能需要用引号包裹路径

## 首次配置

### 新项目：使用 init 命令

对于新项目，运行 `init` 命令自动创建配置文件：

```bash
# 全局安装模式
tackle-harness init

# 本地安装模式
npx tackle-harness init
```

此命令会：
- 创建 `.claude/` 目录
- 创建 `.claude/config/` 目录
- 生成默认的 `harness-config.yaml` 配置文件
- 更新 `.claude/settings.json` 以启用全局技能和钩子

### 旧项目：使用 migrate 命令迁移

如果你之前使用本地安装模式的项目，使用 `migrate` 命令迁移到全局安装：

```bash
# 全局安装模式
tackle-harness migrate

# 本地安装模式
npx tackle-harness migrate
```

此命令会：
- 清理项目级别的 `.claude/skills/` 目录（技能现在来自全局安装）
- 清理项目级别的 `.claude/hooks/` 目录（钩子现在来自全局安装）
- 移除 `settings.json` 中的本地钩子注册
- 注入 CLAUDE.md 中的 Plan 模式规则

> **重要**：迁移后，项目只需要保留配置文件（`harness-config.yaml`），技能和钩子由全局安装提供。

### 配置文件位置

全局安装后，配置文件结构如下：

```
your-project/
├── .claude/
│   ├── config/
│   │   └── harness-config.yaml    # 主配置文件（由 init 生成）
│   ├── settings.json               # Claude Code 设置（自动更新）
│   └── CLAUDE.md                   # 项目说明（可选）
```

**不需要**以下目录（全局安装模式下已废弃）：
- ~~`.claude/skills/`~~（技能来自全局安装）
- ~~`.claude/hooks/`~~（钩子来自全局安装）

### 自定义配置

编辑 `.claude/config/harness-config.yaml` 自定义配置：

```yaml
# 上下文窗口管理
context_window:
  max_size: 50000
  warning_threshold: 40000

# 工作流配置
workflow:
  default_branch: main

# 角色系统
roles:
  enabled: true

# 记忆系统
memory:
  enabled: true
  retention_days: 30
```

## 运行第一个工作流

### 1. 启动 Claude Code

在项目目录中启动 Claude Code：

```bash
claude
```

### 2. 触发技能

在 Claude Code 中输入：

```
创建任务：实现一个简单的登录功能
```

或者使用技能名称：

```
/skill-task-creator
```

### 3. 观察 AI 响应

Claude Code 将：
1. 进入 Plan 模式分析任务
2. 创建工作包文档
3. 等待你的确认

### 4. 确认执行

输入 "确认创建" 或选择相应的确认选项。

### 5. 继续工作流

任务创建后，可以继续执行：

```
执行任务 WP-XXX
```

或使用完整的技能：

```
/skill-agent-dispatcher
```

## 验证安装

### 检查插件

```bash
# 全局安装模式
tackle-harness validate

# 本地安装模式
npx tackle-harness validate
```

应该看到类似输出：

```
=== Validation Report ===
Plugins checked: 21
Errors: 0
Warnings: 0

Validation PASSED
```

### 检查配置

```bash
# 全局安装模式
tackle-harness config

# 本地安装模式
npx tackle-harness config
```

应该显示当前配置路径和有效性。

### 检查构建状态

```bash
# 全局安装模式
tackle-harness status

# 本地安装模式
npx tackle-harness status
```

输出包含：
- 安装模式（全局/本地）
- 已注册插件数量
- 已启用插件数量

### 检查 Claude Code 设置

```bash
cat .claude/settings.json
```

应该包含：
- `hooks`: 生命周期钩子配置（指向全局安装）
- `skills`: 技能路径映射（指向全局安装）

## 常用命令

| 命令 | 说明 |
|------|------|
| `tackle-harness` | 构建所有插件（默认命令，仅本地模式需要） |
| `tackle-harness build` | 同上，构建所有插件（仅本地模式需要） |
| `tackle-harness validate` | 验证插件格式 |
| `tackle-harness validate-config` | 验证 harness-config.yaml |
| `tackle-harness init` | 首次配置：生成配置文件 + 更新 settings.json |
| `tackle-harness migrate` | 迁移旧项目到全局安装模式 |
| `tackle-harness status` | 显示构建状态和插件统计 |
| `tackle-harness config` | 显示/验证当前配置 |
| `tackle-harness list` | 列出所有已注册插件 |
| `tackle-harness interactive` | 交互式插件管理（别名：`i`） |
| `tackle-harness version` | 显示版本信息 |
| `tackle-harness help` | 显示帮助信息 |

### 选项

| 选项 | 说明 |
|------|------|
| `--root <path>` | 指定目标项目路径（默认：当前目录） |
| `--verbose` | 显示详细构建输出 |
| `--no-color` | 禁用彩色输出 |
| `--help, -h` | 显示帮助信息 |
| `--version, -v` | 显示版本信息 |

### 示例

```bash
# 初始化新项目
tackle-harness init

# 迁移旧项目
tackle-harness migrate

# 验证插件
tackle-harness validate

# 查看构建状态
tackle-harness status

# 指定目标项目路径
tackle-harness init --root /path/to/project

# 显示详细输出
tackle-harness --verbose validate
```

### 全局模式 vs 本地模式

全局安装后，命令行为有以下差异：

| 命令 | 全局模式 | 本地模式 |
|------|----------|----------|
| `build` | 跳过构建（使用全局技能） | 构建插件到项目 |
| `init` | 仅生成配置文件 | 构建插件 + 生成配置 |
| `migrate` | 清理项目级别文件 | 清理项目级别文件 |
| `validate` | 验证全局插件 | 验证本地插件 |

## 配置文件说明

### harness-config.yaml

主配置文件位于 `.claude/config/harness-config.yaml`，包含以下配置：

```yaml
# 上下文窗口管理
context_window:
  max_size: 50000              # 最大上下文大小
  warning_threshold: 40000     # 警告阈值

# 工作流配置
workflow:
  default_branch: main         # 默认分支
  wp_prefix: WP-               # 工作包前缀

# 角色系统
roles:
  enabled: true                # 启用角色管理
  config_file: roles.yaml      # 角色配置文件

# 记忆系统
memory:
  enabled: true                # 启用记忆系统
  retention_days: 30           # 保留天数

# MCP 服务器配置
mcp:
  servers: []                  # MCP 服务器列表
```

### settings.json

Claude Code 设置文件，由 `tackle-harness init` 自动更新，包含：

```json
{
  "hooks": {
    "PreToolUse": [...],
    "PostToolUse": [...],
    "SessionStart": [...]
  },
  "skills": {
    "task-creator": "/path/to/global/skills/task-creator/skill.md",
    ...
  }
}
```

**注意**：全局安装模式下，路径指向全局安装位置（如 `C:\Users\<user>\AppData\Roaming\npm\node_modules\tackle-harness`）。

### plugin-registry.json

插件注册表，定义所有可用插件及其状态。此文件位于全局安装目录，由 npm 包管理。

## 可用技能列表

安装完成后，以下技能立即可用：

| 技能 | 触发词 | 说明 |
|------|--------|------|
| task-creator | 创建任务、新建任务 | 创建工作包定义 |
| batch-task-creator | 批量创建任务 | 批量创建工作包 |
| split-work-package | 拆分工作包 | 拆分现有工作包 |
| progress-tracker | 记录进度、保存进度 | 管理项目进度 |
| team-cleanup | 清理团队 | 清理孤立 agent 团队 |
| watchdog-manager | 启动守护进程、watchdog | 管理守护进程 |
| human-checkpoint | 人工检查、检查点 | 人工审核节点 |
| agent-dispatcher | 批量执行、并行执行 | 调度子代理执行 |
| workflow-orchestrator | 开始工作流、执行流程 | 运行完整工作流 |
| role-manager | 查看角色、匹配角色 | 角色管理 |
| checklist | 运行检查、执行清单 | 质量检查清单 |
| completion-report | 汇报结果、完成报告 | 生成完成报告 |
| experience-logger | 总结经验、记录经验 | 记录经验教训 |
| tackle-init | 初始化 tackle、setup tackle | 项目初始化 |

## 故障排除

### 全局安装问题

#### 问题：权限被拒绝（EACCES）

**症状**：运行 `npm install -g tackle-harness` 时报错 `EACCES`。

**解决方案**：

1. **修复 npm 全局目录权限**（推荐）：
   ```bash
   mkdir -p ~/.npm-global
   npm config set prefix '~/.npm-global'
   echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc  # 或 ~/.zshrc
   source ~/.bashrc  # 或 source ~/.zshrc
   npm install -g tackle-harness
   ```

2. **使用 Node 版本管理器**（最佳实践）：
   ```bash
   # 使用 nvm（Node Version Manager）
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash
   nvm install --lts
   npm install -g tackle-harness
   ```

3. **使用 sudo**（不推荐，仅作为临时方案）：
   ```bash
   sudo npm install -g tackle-harness
   ```

#### 问题：命令未找到（command not found）

**症状**：运行 `tackle-harness` 时显示 "command not found"。

**解决方案**：

1. **确认全局安装成功**：
   ```bash
   npm list -g tackle-harness
   ```

2. **检查 npm 全局 bin 路径**：
   ```bash
   npm config get prefix
   ```

3. **将 npm bin 路径添加到 PATH**：
   ```bash
   # macOS/Linux
   export PATH=$(npm config get prefix)/bin:$PATH

   # Windows PowerShell
   $globalNpmPath = npm config get prefix
   $env:Path += ";$globalNpmPath"

   # 或永久添加（将以下行添加到 ~/.bashrc 或 ~/.zshrc）：
   echo 'export PATH=$(npm config get prefix)/bin:$PATH' >> ~/.bashrc
   source ~/.bashrc
   ```

4. **重新打开终端**，使 PATH 更改生效。

#### 问题：多版本冲突

**症状**：安装了多个版本的 tackle-harness，命令行为不一致。

**解决方案**：

1. **查看当前全局版本**：
   ```bash
   npm list -g tackle-harness
   ```

2. **卸载所有版本**：
   ```bash
   npm uninstall -g tackle-harness
   ```

3. **清理缓存**（可选）：
   ```bash
   npm cache clean --force
   ```

4. **重新安装最新版本**：
   ```bash
   npm install -g tackle-harness
   ```

### Windows 路径问题

#### 问题：路径解析错误

**症状**：在 Windows 上使用 `D:\path` 等路径时报错。

**原因**：旧版本代码未正确处理 Windows 驱动器路径。

**解决方案**：

1. **确保使用最新版本**：
   ```bash
   npm update -g tackle-harness
   ```

2. **检查版本**：
   ```bash
   tackle-harness version
   ```
   应该显示 >= 0.0.20

3. **如果问题仍然存在**：
   - 使用正斜杠：`D:/path/to/project`
   - 或使用双反斜杠：`D:\\path\\to\\project`

### 迁移问题

#### 问题：migrate 命令失败

**症状**：运行 `tackle-harness migrate` 时报错。

**解决方案**：

1. **检查文件权限**：
   ```bash
   # 确保对 .claude/ 目录有写权限
   ls -la .claude/
   ```

2. **手动清理**（如果自动迁移失败）：
   ```bash
   # 备份当前配置
   cp -r .claude .claude.backup

   # 删除项目级别的 skills 和 hooks
   rm -rf .claude/skills
   rm -rf .claude/hooks

   # 重新初始化
   tackle-harness init
   ```

3. **检查 settings.json**：
   ```bash
   # 确认没有本地钩子注册
   cat .claude/settings.json | grep "node_modules"
   ```
   如果看到 `"command": "../plugins/..."`，手动删除这些条目。

### 技能没有生效

#### 问题：技能不在 Claude Code 技能列表中

**症状**：在 Claude Code 中输入 `/skill-xxx` 时提示技能不存在。

**排查步骤**：

1. **确认全局安装**：
   ```bash
   npm list -g tackle-harness
   ```

2. **检查 settings.json**：
   ```bash
   cat .claude/settings.json
   ```
   确认 `skills` 字段包含技能路径。

3. **重新初始化**：
   ```bash
   tackle-harness init
   ```

4. **重启 Claude Code**：
   - 按 `Ctrl+C` 退出 Claude Code
   - 重新运行 `claude`

5. **检查技能路径**：
   ```bash
   # 确认全局技能文件存在
   ls $(npm root -g)/tackle-harness/.claude/skills/
   ```

6. **清除 Claude Code 缓存**（最后手段）：
   ```bash
   # 删除 Claude Code 会话缓存
   rm -rf ~/.claude/cache
   ```

### 配置文件问题

#### 问题：配置文件未生成

**症状**：运行 `init` 后 `.claude/config/harness-config.yaml` 不存在。

**解决方案**：

1. **检查目录权限**：
   ```bash
   # 确保对 .claude/ 目录有写权限
   ls -la .claude/
   ```

2. **手动创建目录**：
   ```bash
   mkdir -p .claude/config
   ```

3. **手动创建配置文件**：
   从模板复制：
   ```bash
   cp $(npm root -g)/tackle-harness/templates/harness-config.yaml .claude/config/
   ```

4. **重新运行 init**：
   ```bash
   tackle-harness init --verbose
   ```

#### 问题：配置验证失败

**症状**：运行 `validate-config` 时报错。

**解决方案**：

1. **查看详细错误**：
   ```bash
   tackle-harness validate-config --verbose
   ```

2. **检查 YAML 语法**：
   ```bash
   # 使用在线工具验证 YAML 语法
   # 或使用 Python:
   python -c "import yaml; yaml.safe_load(open('.claude/config/harness-config.yaml'))"
   ```

3. **恢复默认配置**：
   ```bash
   cp $(npm root -g)/tackle-harness/templates/harness-config.yaml .claude/config/
   ```

### 其他问题

#### 问题：验证失败

**症状**：运行 `validate` 时显示错误。

**解决方案**：

1. **查看详细输出**：
   ```bash
   tackle-harness validate --verbose
   ```

2. **检查特定插件**：
   ```bash
   tackle-harness list
   ```

3. **重新安装**：
   ```bash
   npm uninstall -g tackle-harness
   npm install -g tackle-harness
   ```

#### 问题：无法连接到 npm

**症状**：安装时提示网络错误。

**解决方案**：

1. **检查网络连接**：
   ```bash
   ping registry.npmjs.org
   ```

2. **使用镜像源**（中国大陆）：
   ```bash
   npm config set registry https://registry.npmmirror.com
   npm install -g tackle-harness
   ```

3. **恢复官方源**（安装后）：
   ```bash
   npm config set registry https://registry.npmjs.org
   ```

## 下一步

- 阅读插件开发指南了解如何开发自定义插件
- 查看 CLAUDE.md 了解项目架构
- 查看 docs/best-practices.md 了解最佳实践
- 尝试不同的技能和配置选项

## 获取帮助

- 在 Claude Code 中输入 `/help` 获取使用帮助
- 运行 `tackle-harness help` 查看 CLI 命令列表
- 查看项目 GitHub Issues 报告问题
