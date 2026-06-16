# Checklist

开发完成质量检查技能。

## When to Use
- 用户说 "运行检查" / "执行清单" / "检查清单"
- **每个工作包完成后自动执行**
- 提交代码前的最终检查

- 功能开发后验证质量
- Bug 修复后验证修复效果

## Flow
```dot
digraph checklist {
    rankdir=LR;
    node [shape=box]; label="读取 CHECKLIST.md";

    "读取 CHECKLIST.md" -> "匹配 EXPERIENCE.md";
    "匹配 EXPERIENCE.md" [shape=box];
    "匹配 EXPERIENCE.md" -> "执行检查项";
    "执行检查项" [shape=box];
    "执行检查项" -> "有问题?";
    "有问题?" [shape=diamond];
    "有问题?" -> "查阅经验库" [label="是"];
    "有问题?" -> "生成报告" [label="否"];
    "查阅经验库" [shape=box];
    "查阅经验库" -> "修复问题";
    "修复问题" [shape=box];
    "修复问题" -> "生成报告";
    "生成报告" [shape=box];
}
```

## Checklist Categories

### 1. 代码质量检查
- [ ] 代码符合 GDScript 规范
- [ ] 无编译错误/警告
- [ ] 公共函数有文档注释
- [ ] 无 ERROR 输出

- [ ] 无重复 WARNING

- [ ] 临时调试代码已移除

### 2. 测试检查
- [ ] 测试用例已编写
- [ ] 测试全部通过
- [ ] 边界情况已覆盖
- [ ] 测试文件语法正确

### 3. 文档检查
- [ ] PROGRESS.md 已更新
- [ ] task.md 状态已更新
- [ ] 工作包清单已更新
- [ ] 新增函数有注释
- [ ] 复杂逻辑有说明

### 4. Git 检查
- [ ] git status 确认变更范围
- [ ] 无误提交文件
- [ ] 提交信息格式正确
- [ ] 包含 Co-Authored-By

### 5. 经验记录
- [ ] 遇到的问题已记录到 EXPERIENCE.md
- [ ] 解决方案已记录
- [ ] 可复用的模式已提取
- [ ] 新发现的坑已添加到 CHECKLIST.md

## Experience Matching Rules

根据工作类型自动匹配相关经验：

| 工作类型 | 匹配标签 |
|----------|----------|
| 修复脚本错误 | [脚本调试], [API兼容] |
| 创建/修改场景 | [场景设计], [UI/UX] |
| 系统重构 | [系统架构], [性能优化] |
| 添加美术资源 | [美术资源] |
| 调试运行问题 | [脚本调试], [工具使用] |

## Report Template
```markdown
## 工作包完成检查报告

**工作包**: WP-XXX
**检查时间**: YYYY-MM-DD HH:mm

### 检查结果
| 类别 | 通过/总数 | 状态 |
|------|----------|------|
| 代码质量 | X/X | ✅/❌ |
| 测试检查 | X/X | ✅/❌ |
| 文档检查 | X/X | ✅/❌ |
| Git 检查 | X/X | ✅/❌ |
| 经验记录 | X/X | ✅/❌ |

### 未通过项
- [ ] 检查项 - 原因

### 建议后续操作
1. ...

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

### Machine-Readable Verdict（机器可读判定契约）

Report 末尾的 `json:machine-readable` fenced block 是供 **reflection-evaluator**（Agentic Loop Reflect 层）程序化消费的结构化判定，与上方人类可读 Markdown 表格**并存**（追加式，不破坏表格输出）。

字段规范（详见 `docs/reports/agentic-loop-design.md` §5.4）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `wpId` | string | 受检工作包 ID |
| `checkedAt` | string | ISO 8601 检查时间 |
| `passed` | boolean | 全部通过才 `true`（与表格"状态"一致） |
| `summary` | object | `{ total, passed, failed }` 总数统计 |
| `categories[].name` | string | 与 5 类对齐（代码质量/测试/文档/Git/经验） |
| `categories[].passed` | boolean | 该类全过才 `true` |
| `categories[].items[].id` | string | **稳定 ID**（见下方规则） |
| `categories[].items[].reason` | string? | 失败原因（仅 failed 项必填） |
| `failedItems` | array | 扁平失败项列表，reflection-evaluator 的 `failingDrivers` 直接映射 |

**🔴 `item.id` 跨轮稳定性规则（发散检测前提）**：

- 格式 = 类别前缀 + 序号：`code-N` / `test-N` / `doc-N` / `git-N` / `exp-N`（对应 5 类检查）
- 同一检查项跨多轮 Report **必须用同一个 id**（如"边界情况已覆盖"恒为 `test-3`）
- **禁止**使用行号、时间戳、随机串或每次重新编号——否则 Agentic Loop 的发散检测（"同一失败项反复失败"）无法跨轮比对
- 类别内序号一经分配不再变更；新增检查项追加新序号，不重排已有项
```

## Important
- **每个工作包完成后必须执行此检查清单**
- 检查未通过时，应修复后再提交
- 经验记录有助于避免重复踩坑
