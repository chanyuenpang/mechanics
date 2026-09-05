# CLI Agent 查询与受约束写入

`game-graph agent` 提供两条严格分离的能力：`guide/scopes/search/graph/node/impact` 只读已保存资料；`concept create|update|delete` 与 `rule add|update|delete` 在明确写意图下修改 canonical。两者都不依赖 Claw、MCP 或游戏引擎。

## 只读查询

推荐顺序为 `guide → scopes/search → graph/node → impact`：

```sh
game-graph agent guide --format text
game-graph agent scopes --project ./my-game
game-graph agent search --project ./my-game --query "资源"
game-graph agent graph --project ./my-game --mechanic basic-rules
game-graph agent graph --project ./my-game --view battle
game-graph agent node --project ./my-game --mechanic basic-rules --id stamina --direction both --hops 2
game-graph agent impact --project ./my-game --mechanic basic-rules --from stamina --to failure
```

`guide` 无需项目。其他命令可以在项目或 `.game-graph` 子目录运行，也可显式传 `--project`。服务已运行时可改用 `--connect http://127.0.0.1:<端口>`；客户端不跟随重定向，30 秒超时，协议不匹配会明确失败，不静默退回磁盘模式。

`graph/node/impact` 必须且只能指定 `--mechanic <ID>` 或 `--view <ID>`。稳定 ID 先由 scopes/search 查得；不按显示名称猜测。视图只查询 `visible:true` 的注册机制，同时返回完整注册表。search 匹配 ID、名称、aliases、描述和标签；同一别名可命中多个概念，结果不会自动合并。

查询结果携带 `queryApiVersion:7`、`semanticsVersion:rule-text-only-polarity-4`、`readingContract.version:7`、workspaceId、整体 `revision`、逐资源 `resourceRevisions`、savedOnly；在线查询还携带 `projectGeneration`。后续只读查询可用 `--revision` 约束整体版本，变化时返回 `REVISION_CONFLICT`。

每条边以 `source/target/relation/sign/inheritance` 直接声明关系结构，并可保存用户填写的 `ruleText`；工具不会自行补写规则文字。条件约束写入规则文字，不设独立字段；规则文字不求值；多入边不编码 AND/OR；路径不表示时序、强度、概率、胜率或运行时成立。impact 会区分声明关系、推导结果、搜索/证据完整性与模型未知项。

| 参数 | 默认 | 最大 |
| --- | --- | --- |
| `--hops` | 1 | 8 |
| `--max-nodes` | 500 | 5000 |
| `--max-edges` | 2000 | 20000 |
| `--max-paths` | 50 | 500 |
| `--max-depth` | 16 | 64 |
| `--max-expansions` | 10000 | 100000 |
| `--evidence-limit` | 10 | 500 |

## 受约束写入

Agent 写入只支持以下命令，不支持直接写 JSON、修改 `agentLocked`、视图、布局、机制元数据或工作区设置：

```sh
game-graph agent concept create --project ./my-game --id focus --label "专注" --description "可投入行动的专注。" --aliases '["集中"]' --tags '["资源"]' --revision <definitions资源版本>
game-graph agent concept update --project ./my-game --concept focus --description "用于维持复杂行动。" --revision <definitions资源版本>
game-graph agent concept delete --project ./my-game --concept focus --revision <definitions资源版本>

game-graph agent rule add --project ./my-game --mechanic basic-rules --source focus --target action --relation influence --sign positive --text "" --revision <机制资源版本>
game-graph agent rule update --project ./my-game --mechanic basic-rules --source focus --target action --text "行动窗口开放时，专注提高行动效果。" --revision <机制资源版本>
game-graph agent rule delete --project ./my-game --mechanic basic-rules --source focus --target action --revision <机制资源版本>
# influence 默认保存 inheritance:none；只有明确需要时才设置受限继承
game-graph agent rule add --project ./my-game --mechanic basic-rules --source focus-on-boss --target focus --relation specializes --revision <机制资源版本>
game-graph agent rule update --project ./my-game --mechanic basic-rules --source focus --target action --inheritance '{"mode":"specializeEndpoint","endpoints":["source"],"maxSpecializationHops":1}' --revision <机制资源版本>
```

概念 ID 与规则端点不可通过 update 改名。`aliases/tags` 必须是 JSON 字符串数组；空数组表示清空。规则 ID 固定由 `<source>-2-<target>` 生成；同一有向端点对在整个工作区只能存在一条规则。`influence` 使用 `positive/negative/random`（也接受 `1/-1`）且必须有 `inheritance`；`specializes` 不得提供 sign 或 inheritance。新增规则会把已存在的端点概念补入目标机制的 `nodeIds`，但不会生成坐标；删除规则不删除节点引用。

写入前先运行 scopes，概念操作使用 `resourceRevisions.definitions`，规则操作使用 `resourceRevisions.mechanics[mechanicId]`。每次成功返回新的 `resourceRevision`；继续修改同一资源必须使用新值。在线写入还必须传当前 `--project-generation`：

```sh
game-graph agent concept update --connect http://127.0.0.1:4319 --project-generation 3 --concept focus --label "专注值" --revision <definitions资源版本>
```

用户可在网页概念表设置 Agent 锁。锁定概念禁止 Agent update/delete，但仍可作为规则端点。概念仍有机制、规则、视图或历史组合引用时不能删除；应由用户在网页清理引用。写入与网页保存共用串行队列和完整工作区校验。

canonical 提交后会立即重建 Agent 文档。若返回 `AGENT_EXPORT_FAILED` 且 `canonicalCommitted:true`，表示 canonical 已提交但文档发布失败；先重新查询真实状态，禁止自动重试原 mutation。

## 错误与只读后备

错误写入 stderr JSON `{error,message,...details}`，退出码非零，stdout 不返回部分成功。常见错误包括 `SCOPE_REQUIRED`、`SCOPE_NOT_FOUND`、`NODE_NOT_FOUND`、`REVISION_CONFLICT`、`RESOURCE_REVISION_CONFLICT`、`PROJECT_CHANGED`、`CONCEPT_AGENT_LOCKED`、`CONCEPT_REFERENCED`、`DUPLICATE_ENDPOINT_RULE`、`WORKSPACE_LOCKED`、`CATALOG_STALE`、`AGENT_EXPORT_FAILED` 和 `QUERY_VERSION_MISMATCH`。

没有 CLI 时从项目 `agentExportPath/README.md` 进入，按机制文件夹读取 `folders/<文件夹>/index.md`，再按需在唯一的 `concepts.md` 中查概念锚点。该 Markdown-only 目录由 catalog v5 生成，只读且不含布局或视图状态；canonical definitions/mechanics 始终是唯一可编辑真相。
