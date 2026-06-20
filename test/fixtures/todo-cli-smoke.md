# 待办清单 CLI（smoke 验证样本）

把"做一个待办清单命令行工具"分解为符合 plan-reader 契约的计划，供 skill-agentic-loop 读取执行。

## 实现命令行入口与参数解析
- [ ] 初始化 package.json 与 bin 入口
- [ ] 支持 add/list/done 子命令
- [ ] [unit] 参数解析单测

## 实现数据持久化
依赖 先完成 实现命令行入口与参数解析
- [ ] 设计 JSON 存储结构
- [ ] 读写本地 .todo.json
- [ ] [integration] 增删改查联调

## 成功标准
- CLI 能本地 node bin 跑通，add/list/done 命令全部可用
- 数据持久化到文件，重启后仍在
- npm test 全绿
