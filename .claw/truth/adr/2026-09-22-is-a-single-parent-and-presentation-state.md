# ADR：is-a 收紧为单父并显式保存展示状态

## 背景

`specializes` 是规则库中唯一的分类关系，但最初只要求无自连、无环，同一概念可以有多条出边指向不同上位概念；机制图的分类边按普通连线绘制，节点内 is-a 标签只在视图的 `structuralPresentation: "badge"` 下出现，隐藏边后仅由分类引入的父节点仍留在画布、布局与路由里。缺字段的旧资料按运行时缺省等效打开。

这带来两个问题：歧义分类（多父）无法被拒绝，只能靠展示层掩盖；展示偏好没有持久化归属，"隐藏 is-a"只影响绘制，不影响排版与路线，且 label 事实上承担了关系事实。

用户确认的方向是：is-a 是具体概念 → 上位概念的规范单向关系，每概念至多一个父概念；标签只是它的只读展示投影；旧资料必须迁移成显式保存的展示状态，而不是继续依赖缺省。

## 决策

- `specializes` 每概念至多一个父概念：同一 source 的第二条出边以 `SPECIALIZES_MULTIPLE_PARENTS` 失败，自连与成环继续分别以 `SPECIALIZES_SELF_LINK`、`SPECIALIZES_CYCLE` 失败。语义 owner 是 `src/domain/graph.mjs` 的 `assertSpecializes`。
- mechanism 与 view 必填 `taxonomyPresentation: { mode: "label", expandedNodeIds: [] }`。`mode` 目前只接受 `label`；`expandedNodeIds` 是子概念 ID 集合，表示这些子概念已在详情中展开。默认隐藏 is-a 边并给子节点只读 is-a 父标签；展开时恢复直连父概念与一条虚线边；收起后按基础集合重算，仅因 is-a 出现的孤立父概念退出渲染、布局与路由，但 canonical 数据不变。
- 展示投影的 owner 是 `src/domain/taxonomy-presentation.mjs`：`projectTaxonomyPresentation` 与 `projectDisplayGraph` 是画布、自动排版、路由缓存与几何签名的唯一输入（`src/web/canvas.mjs` 只渲染，`src/web/app.mjs` 只把详情开关转成草稿或视图保存），服务端 Agent 排版按同一规则投影；原先位于 web 的 `structuralProjection` 一并下沉到该模块。
- 协议与迁移：workspace v13、definitions v7、rules v1、mechanic v8、view v5；`planV12ToV13Migration` 为每个 mechanism/view 写入显式 `taxonomyPresentation`，候选全量校验通过后才原子提交并回读，失败、revision 冲突或回读失败零部分写入。读取路径不合成默认值；打开项目时所有仍有迁移路径的旧协议（v7–v12）在创建 store 前逐级预览→执行自动升级，更早或未知的核心拓扑仍只读兼容打开，升级继续可用 `mech migrate` 逐级执行。

## 取舍

- **保留多父、只做展示兼容**（初版方案）：未采用。它拒绝不了歧义资料，也会让 label 从投影变成事实来源。
- **只用前端隐藏分类边**：未采用。布局、命中与 Worker 路由仍收到 is-a 边和被隐藏的父节点，"隐藏"不会真正简化排版。
- **把开关写进 `definitions`**：未采用。会强迫所有机制图与视图共享同一展示，违反单图/叠加各自的阅读入口。
- **从 label 反推或先写 label 再补关系**：未采用。label 只能是已保存关系的只读投影。
- **打开时用缺省值兼容旧资料**：未采用。显式事实只能由迁移写入，缺省会让旧资料永远停留在未迁移状态。

## 影响

协议升级到 workspace v13 / mechanic v8 / view v5，旧资料必须迁移；含多父 is-a 的工作区会在迁移候选校验中整体失败，必须先显式处理冲突边。展示状态随文件走，同一机制在不同视图可以有不同展开集合。后续修改 is-a 展示必须继续从关系派生，不能反向写入关系；新增展示字段需要同步 schema、`workspace-tools/workspace-tool.mjs` 草稿校验与迁移候选校验。

证据锚点：`src/domain/graph.mjs`、`src/domain/taxonomy-presentation.mjs`、`src/server/migration.mjs`、`src/server/project-manager.mjs`、`schemas/protocol.schema.json`、`workspace-tools/workspace-tool.mjs`；`tests/containment.test.mjs`、`tests/taxonomy-presentation.test.mjs`、`tests/auto-layout-contract.test.mjs`、`tests/canvas-structural-projection.test.mjs`、`tests/view-opening.test.mjs`、`tests/editor.test.mjs`、`tests/migration.test.mjs`、`tests/project-lifecycle.test.mjs`。
