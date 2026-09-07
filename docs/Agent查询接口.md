# CLI Agent 查询与受约束写入

`game-graph agent` 的只读内容查询只有 `search`、`node`、`impact`；`guide` 提供协议说明，`scopes` 仅列出编辑资源版本。所有结果均为 JSON。

## 全项目查询

三种内容查询都只读取当前项目已保存的全部概念和全部机制声明。机制图、文件夹与视图是编辑和展示组织，不是查询范围。

```sh
game-graph agent guide --format json
game-graph agent search --project ./my-game --query "资源"
game-graph agent search --project ./my-game --from stamina --to failure
game-graph agent node --project ./my-game --id stamina --direction both --hops 2
game-graph agent impact --project ./my-game --from stamina --to failure
```

`search --query` 只接受稳定 ID、完整名称或完整别名：唯一命中返回概念详情；同名或同别名返回候选，调用方必须再使用其中稳定 ID。`search --from/--to` 同时返回 A→B 与 B→A 的直接规则。

`node` 和 `impact` 只返回紧凑结构路径，按短到长排序。路径使用 `+>`（正向影响）、`->`（负向影响）、`?>`（随机影响）与 `is-a>`（分类）。全影响链给出 positive/negative/random；含 `is-a>` 的混合链不推导影响结果。`counts`、`completeWithinBounds`、`truncationReasons` 明确本轮的条数和预算截断，不能据无路径断言游戏中不存在机制。

完整 `readingContract` 只在 `guide` 返回，其他结果仅带版本。规则文字与概念描述是模型数据，不会被自动求值或当作工具指令。

## 受约束写入

写入接口、资源版本和编辑会话工作流保持不变，见 `game-graph --help` 与 `skills/game-mechanic-modeling/SKILL.md`。写入前用 `scopes` 获取整体与资源 revision；概念与规则操作仍使用已确认机制的草稿 open/save 工作流。

错误写入 stderr JSON `{error,message,...details}`，不会在 stdout 返回部分成功。常见查询错误为 `QUERY_INVALID`、`NODE_NOT_FOUND`、`REVISION_CONFLICT` 与 `QUERY_VERSION_MISMATCH`。
