---
name: game-mechanic-modeling
description: 使用项目内 JSON 草稿工具修改 Game-Graph 概念与规则；仅在用户明确要求写入或建模时使用，不用于网页布局、视图或文档发布。
metadata:
  game_graph_skill_version: "2026.09.07.3"
---

# 游戏机制建模

只运行 `node <项目>/.game-graph/tools/workspace-tool.mjs`。工具直接读写 canonical JSON，不依赖或调用 CLI、网页、HTTP 服务、自动排版或文档导出。

## JSON 草稿流程

1. 用 `scopes` 读取现有机制与 revision；用 `search/node/impact` 查稳定 ID 和已有关系。
2. `draft open --mechanic <机制ID>` 返回 definitions 与 mechanic 草稿路径。只编辑返回的 JSON 草稿，绝不直接编辑 canonical。
3. `draft save --draft <draftId>` 会检查草稿身份和 definitions/mechanic 的 base revision，获取短锁并原子提交两份 JSON。冲突、非法 JSON 或身份不一致时保留草稿且零写入。
4. 保存成功只表示 JSON 已提交；网页校验、排版、连线路由、视图更新和文档导出均未执行，不能声称已完成这些派生操作。

## 建模准则

- 规则优先：先写出触发、参与者、状态变化、条件/例外和证据，再决定概念与连线。
- 概念只在承担独立输入、输出、状态、事件或判定职责时保留；单链中间量若没有其他规则职责，应把细节压回规则文字。
- 限定词只缩小单条规则端点的真实适用子集，不改变概念身份；规则适用于完整概念时不得使用限定词。
- `is-a` 只表示真实子类到上位概念；只有分类边且不参与玩法规则的父概念是冗余候选。
- 同一有向基础端点对只保留一条规则；将多个条件、例外和结算细节合并在该规则文字中。
- 缺边或未找到路径只表示模型证据不足，不得据此虚构、删除或宣称运行时事实。

脚本不提供容器创建、迁移、修复、网页视图或文档发布；这些属于网页/工具维护职责，不能通过本 skill 绕过。
