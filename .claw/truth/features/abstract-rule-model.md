# 抽象游戏规则模型

<!-- state: current -->
## 当前行为

- 工具分析抽象规则，不模拟实时战局。敌人促进近战、后撤步抑制近战，即可通过共享概念识别机制反制；不以前置实例绑定、某局体力或行动可用性判断作为查询条件。
- 一个工作区只有一份 canonical 概念定义图。持久化概念、机制、视图和规则使用英文语义 ID，拒绝 UUID 与随机十六进制片段。概念可保存自然语言 aliases；别名不遮蔽 canonical ID，歧义别名返回全部候选。同名不同 ID 不合并，改名不改引用。
- `sign: 1` 表示源增加时目标增加，`sign: -1` 表示源增加时目标减少；正负不表示对玩家有利与否。消耗是行动对资源的负向作用，资源支持行动是另一条关系。
- `specializes` 没有 sign，只沿 source → target 单向表达具体概念指向上位概念的分类声明；不反向、不跨兄弟、不建模禁止、数值或具体效果；方向决定集合算法——某概念的**后代**（更具体的概念）只能沿 specializes 的**入边**收集（`src/domain/graph.mjs` 的 `specializesDescendants`），**祖先**才沿出边上溯（`src/domain/query-paths.mjs` 的分类透传），按出边求「后代」得到的正好是祖先集合。每个概念至多一个父概念：同一 source 的第二条出边以 `SPECIALIZES_MULTIPLE_PARENTS` 显式失败，自连与成环仍分别以 `SPECIALIZES_SELF_LINK`、`SPECIALIZES_CYCLE` 失败（`src/domain/graph.mjs` 的 `assertSpecializes`）。is-a 的节点标签、虚线与展开集合都只从已保存关系派生，不能创建、替代或反推关系。分类路径不输出正负号，不落盘派生规则。is-a 只有一个写入口：概念的 is-a 父概念字段（网页的节点属性面板与概念对话框、`mech agent rule set-parent` 与项目内 `workspace-tool isa set` 都是它的实现面），画布连线不创建 is-a。父概念候选由 `src/web/glossary.mjs` 的 `isaParentCandidates` 给出：全部概念减去自身与 `specializesDescendants` 返回的真正后代，**绝不排除祖先**——当前父概念必须留在候选里才能显示为已选中的值；候选方向取反会同时造成「已有 is-a 父概念却显示为空」与「可选出必然成环的父概念」。界面与文档统一使用仓库既有的 is-a（父概念）表述，不另造字段名。更换与清除是「整体替换该概念唯一的 `specializes` 出边」的一次操作：`src/domain/graph.mjs` 的 `setSpecializesParent` 先删该概念全部 is-a 出边再按需写入新边，幂等，自连抛 `SPECIALIZES_SELF_LINK`、已存在端点对抛 `DUPLICATE_ENDPOINT_RULE`。
- is-a 的更换与清除必须与受影响文件在同一次提交内落盘：`src/server/store.mjs` 的 `saveConceptTaxonomy`（`POST /api/concept-taxonomy`）在一次 `commitFiles` 中写 `rules`、受影响的 mechanics/views（清理被删规则的 `pinnedRuleIds`）与可选 `definitions`，失败整体回滚。分成两次提交会让被 `pinnedRuleIds` 固定的旧规则残留引用，工作区下次读取以 `MISSING_REFERENCE` 变成不可读。
- 每条 `influence` 规则保存关系、符号、继承策略及可选 `ruleText`；适用条件直接写入规则文字，不设独立 condition 字段，也不自动求值。整个工作区同一有向端点对只允许一条规则。规则 ID 固定为 `<source>-2-<target>`；关系类型、正负、规则文字或继承策略变化均编辑该规则，不以新 ID 建第二条边。
- `node` 查询给出**分类透传上下文**（结果字段 `taxonomy`，`interpretation` 为 `classificationContextOnly`）：从子概念沿 `specializes` 上溯，列出每个上位概念及其自身的声明边与 is-a 路径。它是发现与阅读线索，不使子概念取得这些影响，也不参与正负号结论；含 is-a 步骤的路径本身仍不带符号。
- 规则库可选 `retentionBindings`（`mechanismConceptId`／`resourceConceptId`／`capConceptId`）把配对升级为一等事实：同一资源或同一上限在全工作区只能绑定一次，资源与上限不能相同。**配对不能靠两端各自的 is-a 特化派生**——独立展开会得到交叉配对；只有显式 `--include-inherited` 的 `impact`／`node` 查询才由绑定生成带 `derived` 与 `origin` 的派生边，不落盘、不级联，并与作者声明的同端点规则不并存。分类透传与派生都由 `src/domain/query-paths.mjs` 计算，`src/domain/graph.mjs` 只处理作者声明的边。
- `src/domain/graph.mjs` 拥有纯图函数。组合保留来源、同向并行边和异向边，没有覆盖优先级，不把正负作用直接抵消。当前可见机制图集合限定查询范围，不等于当前回合激活集合。
- 机制 v7 可选 `ruleSelection: "explicit"` 控制规则投影：省略时，焦点概念仍展开其一跳邻接规则，并与 `pinnedRuleIds` 合并；设为 `explicit` 时，`focusNodeIds` 只保留焦点概念，规则仅来自 `pinnedRuleIds`，所选规则的另一端概念随之显示但不会继续展开邻接。叠加其他机制时，显式机制的焦点也不会扩大其邻接规则范围。模式只接受 `explicit`；无效值由 schema、机制校验或图组合明确拒绝（图组合错误码 `RULE_SELECTION_INVALID`）。合同由 `schemas/protocol.schema.json`、`workspace-tools/workspace-tool.mjs` 与 `src/domain/graph.mjs` 承载。
- 有限简单路径保留方向、符号、条件与来源，并报告截断。符号相乘仅解释单路径变化方向，不推断影响强度、净收益、胜率或动态闭环结果。
- 不接触从属关系的纯影响单入单出且不在可遍历环中的节点可以折叠；摘要保留全部原始路径，展开可恢复。路径查询和下游筛选使用未折叠原图，所有关系只按保存方向经过。从属自连接与全工作区从属闭环均拒绝；简单路径去重和数量、深度上限防止无限查询。
- 孤立、只有输入、相似结构都是设计疑点，不自动判坏、合并或删除；终点、消耗出口、未覆盖范围可能合理。未被选图引用的全局定义不属于当前图的孤立节点。
- Schema 的唯一来源是 `schemas/protocol.schema.json`；跨文件校验归 `src/domain/validate.mjs`。当前正式协议版本为 workspace v13、definitions v7、rules v1、mechanic v8、view v5；mechanism 与 view 必填 `taxonomyPresentation`（`{ mode: "label", expandedNodeIds }`），缺失字段不以运行时默认值修复。单父不变量与 is-a 出边替换由 `src/domain/graph.mjs` 承载，is-a 展示投影由 `src/domain/taxonomy-presentation.mjs` 承载，is-a 写入的原子提交由 `src/server/store.mjs` 的 `saveConceptTaxonomy` 承载。

## 验证边界

工具变更按受影响域运行针对性检查；浏览器交互仍需在对应版本服务上实际验收。未实现实时条件求值、AND/阈值/概率求解、自动规则提取或 Agent 专用查询接口。`inheritance.mode: specializeEndpoint` 只替换规则被声明的端点，且仅在显式 `--include-inherited` 时生效——它**不**用于承担配对语义（那是 `retentionBindings` 的职责）；同一后代存在多条等长特化路径时以 `SPECIALIZATION_AMBIGUOUS` 显式失败。

详细合同见 `docs/文件协议.md`、`docs/架构设计.md` 与 `docs/模型对agent的价值与优化讨论.md`。讨论中的优化不是已实现能力。

<!-- state: history -->
## 演进历史

<!-- dated: 2026-09-23 -->
### is-a 后代方向与父概念候选修正

`specializes` 的方向一直是「具体概念 → 父概念」，但网页曾沿出边遍历计算「后代」，得到的其实是祖先集合：节点详情栏把当前父概念当成后代排除，`select.value` 匹配不到任何选项而显示为空，同时真正的后代仍能被选成父概念。修复把后代计算改为沿入边（`specializesDescendants`），并让父概念候选只排除自身与真正的后代。此后 is-a 的选择不再用长下拉框，改为可检索的组合框。

<!-- dated: 2026-09-22 -->
### is-a 收紧为单父并显式保存展示状态

`specializes` 从“多父分类 DAG”收紧为每个概念至多一个父概念：同一 source 的第二条出边显式失败，自连与成环继续拒绝。机制图与视图新增必填 `taxonomyPresentation`（`label` + 展开集合），标签只投影已保存关系。协议随之升级为 workspace v13、mechanic v8、view v5（definitions v7、rules v1 不变），旧资料必须迁移后才能完整编辑。**未采用**保留多父、仅做展示兼容并让缺少字段等效打开的初版方案：它拒绝不了歧义数据，也让 label 事实上承担关系事实。

<!-- dated: 2026-09-14 -->
### 分类透传上下文与配对绑定派生

新增两条查询能力，用来回答“子概念能否看到上位概念的规则、共性机制能否只声明一次”。`node` 输出 `taxonomy` 分类透传上下文（上位概念及其声明边与 is-a 路径，`classificationContextOnly`）；规则库可选 `retentionBindings` 声明配对，并在显式 `--include-inherited` 时生成带 `origin` 的派生边；同一开关同时消费规则自身的 `inheritance.mode: specializeEndpoint`（只替换被声明的端点，歧义显式失败）。**未采用**让两端各自的 `specializeEndpoint` 特化承担配对：独立展开会产生交叉配对，且 domain 从未消费该策略。协议版本不因这两项可选能力递增；`workspace-tools/workspace-tool.mjs` 的草稿白名单已同步支持绑定。

<!-- dated: 2026-09-13 -->
### 机制图增加显式规则选择

新增可选 `ruleSelection: "explicit"`，让机制图能固定选择规则并单独保留焦点概念，避免图节点自动带入未选择的邻接关系；省略字段继续使用一跳邻接规则，以保持既有机制图语义。无效模式必须显式失败。
