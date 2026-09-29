# 端点限定词投影

<!-- state: current -->
## 当前行为

- 端点限定词是单条规则的参与者范围（`sourceQualifiers` / `targetQualifiers`），不是新的共享概念，也不产生子类或 is-a 关系。限定投影只创建画布读取模型，不写入 `definitions.json` 或 `rules.json`。
- 投影 ID 为 `scope:<baseConceptId>:<encodeURIComponent(规范化限定集合)>`；规范化按 `key=值` 排序拼接（概念值是 `concept:<id>`，标量是 `literal:<类型>:<JSON>`），因此键序不同、内容相同的限定集合命中同一个投影。
- 同一基础概念与不同限定集合生成不同投影节点；同一集合在整张图内只有一个投影节点。投影节点必带 `baseConceptId`、`canonicalNodeId`、`qualifiers`、`sourceGraphIds` 与 `scopeProjection: true`。
- 只有声明了限定词的端点被替换为该端点的投影，用户只在一个端点上声明限定词时另一端保持基础概念；不推断跨端点绑定。边保留 `canonicalSource` / `canonicalTarget` 指向基础概念。
- 基础概念的可见节点只在「存在限定投影且没有任何未限定可见端点」时才从画布隐藏；混用限定与未限定端点时，基础实例必须保留以承载未限定规则，否则边会指向不存在的节点。没有任何规则、但在当前机制图或视图焦点集合里的成员也必须保留：这类节点不在任何边上，却是该图明确引用的内容。
- 机制图的显示顺序是：`compose` 合成机制与 Visible 层 → `projectEndpointQualifiers` 生成端点限定投影 → `projectDisplayGraph` 叠加 is-a 展开与结构徽标。限定投影是显示投影的输入，不是它的替代；画布、自动排版与路由缓存消费的仍是同一份 displayGraph。读取图跨阶段完整性与失败布局事务的合同由[读取图端点完整性](read-graph-integrity.md)统一维护。

<!-- state: current -->
## 验证边界

- 单测 `tests/endpoint-projection.test.mjs` 覆盖限定集合规范化、全部接管隐藏基础实例、孤立焦点保留、限定/未限定两侧混用时两级投影均无悬空边。跨阶段完整性与失败布局事务的覆盖见[读取图端点完整性](read-graph-integrity.md)。
- 2026-09-23 的回归（无头 Edge + CDP）证据：清除 is-a 后 `draftFocus`/retained 仍有该概念，`graphNodes`/`displayNodes` 已无；修复后同一路径确认节点仍在画布。`npm run check` 516 用例 / 514 通过 / 0 失败 / 2 个既有跳过。
- 只读工具 `scripts/routing-quality.mjs` 使用同一投影入口；它不启动服务器、不保存机制或视图、不写 canonical 文件。
- 投影节点在 `positions` 中的坐标属于展示层记忆（草稿 `projectionPositions` / 视图 `scopedPositions`），本投影不持久化任何布局。
