# 正交路由质量硬合同

<!-- state: current -->
## 当前行为

- 质量向量由 `src/web/canvas.mjs` 的 `ROUTING_QUALITY`（`Object.freeze`）独占定义，索引顺序即裁决优先级：`hardInvalid` 0、`collinearOverlap` 1、`endpointExcursions` 2、`crossings` 3、`detour` 4、`totalBends` 5、`maxBends` 6、`bendCrowding` 7、`nearParallel` 8、`length` 9。前五项是几何后处理的保护集，任何改进都不得使它们变差；其中只有第 0 项与第 1 项同时是提交门禁，`endpointExcursions`、`crossings` 与 `detour` 只受回归保护，非零本身不拒绝路线。
- `routeGraphEdges(graph, positions, cola, fixedRoutes, { allowProvisional })` 是固定节点正交布线的入口，`routeGraphScore(graph, positions, routes)` 返回同一定义的完整质量向量（内部由 `routeScore` 统计节点穿越、端点包围、交叉、绕行、拐点与近距平行）。两个函数与 `ROUTING_QUALITY` 共同构成对外合同，验证与后处理都以它们的索引取值。
- 硬违规按构造拒绝而不是事后告警：返回前若质量向量第 0 项大于 0（存在节点穿越或缺失路径），或第 1 项大于 0.01（存在共线重叠，且 `allowProvisional` 为 false），直接抛出明确错误，不交付坏几何。端口分配违反容量、槽位或相邻面负载合同时抛错；首末接入段短于 `ENDPOINT_SEGMENT_MIN`（30px）的连线同样抛错。
- 几何后处理逐项保护既有硬结果：`routeQualityPreserved(before, after)` 只接受 `hardInvalid`、`collinearOverlap`、`endpointExcursions`、`crossings`、`detour` 五项都不劣化（容差 0.0001）的候选；减少重叠不能抵消新增交叉，消除交叉也不能制造折返绕路。
- 搜索范围与轮数由 `ROUTING_SEARCH` 的 `normal`、`large`、`highDegree` 预算显式封顶（候选上限、冲突对/端点/交换预算与束宽各有上界），因此路由结果不承诺全局最优。
- 指标的精确语义（例如 `crossings` 统计包含拐点接触的交叉事件数，不等于有交叉的边对数量）、只读验证工具用法与回归入口由 `docs/路由质量验证.md` 持有。画布、自动排版与路由缓存共享显示投影这一事实，其输入链路归属[可取消后台计算与打开事务](async-compute-and-opening-transaction.md)与[端点限定词投影](endpoint-qualifier-projection.md)；本文件不重复这两处内容。

## 验证边界

- `tests/routing-performance.test.mjs` 用两个 100 节点 200 边用例守住硬合同。稀疏网格图断言 `routeGraphEdges` 返回 200 条路线，且 `[score[hardInvalid], score[collinearOverlap], score[crossings]]` 严格等于 `[0, 0, 0]`。
- 高连接度图只断言路线数为 200 且质量向量前两项为 `[0, 0]`；`crossings` 为 0 不是该用例的承诺，不能把两个用例的断言范围混为一谈。
- 两个用例都要求耗时低于 `ROUTING_BUDGET_MS`（15000ms）。该门槛是数量级回归护栏而非微基准：它对机器负载留出约 1.4 倍余量，用来拦截真实算法退化。
- 候选接受规则由 `tests/routing-postprocess.test.mjs` 与 `tests/layout.test.mjs` 覆盖；严格审计通过不等于没有交叉或近距，残余质量指标必须保留。
