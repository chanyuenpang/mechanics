---
name: mechanics-search
description: 查询已保存的规则、概念与关系；不用于创建、修改或删除概念与规则。
metadata:
  mechanics_skill_version: "2026.09.11.1"
---

# Mechanics 只读查询

只运行 `node <项目>/.mechanics/tools/workspace-tool.mjs`。它直接读取项目 JSON，不依赖或调用 CLI、网页、HTTP 服务或文档导出。

- `scopes`：列出机制和工作区 revision。
- `search --query <ID|完整名称|完整别名>`：返回概念或歧义候选。
- `search --from <概念键> --to <概念键>`：返回双向直接规则。
- `node --id <概念ID> --direction upstream|downstream|both --hops <整数>`：返回上下游结构路径。`upstream` 只表示寻找入边时的遍历方向；每条路径的 `nodes`、`steps`、`chain` 与 `effect` 始终按已声明规则的 `source → target` 方向返回，`chain` 可独立阅读，不得把它当成反向关系。
- `impact --from <概念ID> --to <概念ID> [--max-depth <整数>]`：返回短链优先的有向路径。

所有输出均为 JSON。未找到概念或路径只表示 JSON 模型未提供证据。查询不会读取草稿、网页布局、视图状态或文档。
