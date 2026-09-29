# 读取图端点完整性

<!-- state: current -->
## 当前合同

- `src/domain/read-graph-integrity.mjs` 的 `assertReadGraphIntegrity(graph, stage)` 是读取图唯一的完整性断言：节点 ID 必须是非空字符串且唯一；每条保留边的 `source`、`target` 都必须出现在同一张图的节点集合中。它校验运行时读取投影，不取代 `src/domain/validate.mjs` 对 canonical 文件引用的校验。
- 失败立即抛出带阶段的错误：无效 ID 为 `READ_GRAPH_INVALID_NODE`，重复节点为 `READ_GRAPH_DUPLICATE_NODE`，缺端点为 `READ_GRAPH_MISSING_ENDPOINT`；缺端点错误带 `edgeId`、`endpoint`、`nodeId`，不凭空补节点或静默删除边。
- `composeProjection` 合成结果、端点限定投影和结构/分类/最终显示投影的输入与输出在各自领域边界接受检查；正常的 is-a 隐藏和无规则焦点保留不应因校验改变。限定/未限定混用时基础节点的保留条件由[端点限定词投影](endpoint-qualifier-projection.md)拥有。
- `src/web/layout-structure.mjs` 的连通分量、模块分组以及 `src/web/layout.mjs` 的自动布局入口、`src/web/graph-compute-kernel.mjs` 的 Worker 输入在计算前复核；坏端点不能走到模块体积等几何访问。`src/web/app.mjs` 仅在布局几何成功提交后安排自动保存，失败不写入部分几何或触发该次保存。

## 验证边界

- `tests/read-graph-integrity.test.mjs` 覆盖无效/重复节点、缺失来源或目标、投影与布局/Worker 入口；`tests/endpoint-projection.test.mjs` 覆盖正常隐藏、无边焦点与混用限定端点；`tests/auto-layout-contract.test.mjs` 检查失败事务。完成记录中 `npm ci`、`npm run check`（595 通过、2 跳过）和 `npm run check:package` 均通过；这是当次测试结果，不等于已发布版本在目标游戏图中的真实打开验收。
