---
name: mechanics-modeling
description: 使用项目内 JSON 草稿工具修改规则、概念与关系；仅在用户明确要求写入或建模时使用，不用于网页布局、视图或文档发布。
metadata:
  mechanics_skill_version: "2026.09.15.1"
---

# Mechanics 建模

只运行 `node <项目>/.mechanics/tools/workspace-tool.mjs`。工具直接读写 canonical JSON，不依赖或调用 CLI、网页、HTTP 服务、自动排版或文档导出。

DSH 插件当前只提供只读能力（检索与图 widget），**没有**写入工具；在装了插件的宿主里建模写入仍然走下面的 JSON 草稿流程，不要以为插件可以代劳。

`draft save` 在**新建**机制图时会顺带维护导出清单（`workspace.json` 的 `manifest.exportSelections`），结果里回报 `exportSelection`：`added`（补了一条单独选择）、`already-selected`、`covered-by-folder`（所在直接文件夹已选中，按互斥规则不补）、`legacy-all`（工作区未启用显式清单）。视图永不自动导出。文档本身仍需显式生成——工具只维护清单。若打开草稿后 `workspace.json` 变化，保存以 `RESOURCE_REVISION_CONFLICT` 失败并保留草稿。

## JSON 草稿流程

1. 先运行 `guide`，以脚本返回的概念、影响规则与 is-a 规则模板为唯一草稿字段合同；不要凭记忆编造 JSON 字段。
2. 用 `scopes` 读取现有机制、文件夹与 revision；用 `search/node/impact` 查稳定 ID 和已有关系。
3. `draft open --mechanic <机制ID>` 是唯一编辑入口。目标已存在时，它返回 `definitions.json`、`rules.json` 与 `mechanic.json` 三个草稿路径；目标不存在时，必须额外提供 `--name <名称> --scope <范围>`，它只在草稿中准备空机制，绝不提前写入 canonical。若需要放入已有文件夹，可追加 `--folder <scopes.folders 中的已有目录>`。
4. 草稿会移除坐标与路径缓存；只编辑返回的结构 JSON，绝不直接编辑 canonical，也不要自行写回几何字段。
5. 编辑后先运行 `draft validate --draft <draftId>`。它校验三份草稿的结构、概念/规则 ID、端点引用、限定词、全工作区重复有向端点和 is-a 环；失败时草稿保留、canonical 零写入。通过后才继续。
6. `draft save --draft <draftId>` 会再次校验草稿身份和 definitions/rules/mechanic 的 base revision，并以可回滚的三文件事务提交；对于新机制，只有此步骤成功后才会创建正式文件。冲突、非法 JSON、语义校验或回读失败都会保留草稿且不会保留部分写入。保存时保留仍有效的既有节点位置、清除过期路径缓存。
7. 保存成功只表示 JSON 已提交；网页校验、自动排版、视图更新和文档导出均未执行，不能声称已完成这些派生操作。


## is-a

- is-a 就是 `rules.json` 里的一条 `specializes` 规则：`source` 是子概念，`target` 是它唯一的父概念（方向是「具体概念 → 父概念」）。**每个概念至多一个 is-a 父概念**；节点标签、`is-a` 徽标与展开虚线都只是这条关系的只读投影，不能创建、替代或反推关系。
- 指定、更换、清除用 `isa set --draft <draftId> --concept <子概念> --parent <父概念|none>`：它替换该子概念唯一的 `specializes` 出边（`none` 表示清除），把旧规则从该草稿机制的 `pinnedRuleIds` 移除、把新规则固定进去，返回 `changed`、`removedRuleId`、`addedRuleId`、`rulesPath`、`mechanicPath`；相同父子关系重复调用返回 `changed: false`。概念定义本身不变，之后仍要 `draft validate` 再 `draft save`。
- 需要手写 `rules.json` 时（例如一次调整多条 is-a），字段模板见 `guide` 的 `specializesRuleTemplate`，形如 `{ "id": "<子概念>-2-<父概念>", "source": "<子概念>", "target": "<父概念>", "relation": "specializes" }`；同一份 `pinnedRuleIds` 里的旧规则引用必须一并处理，工具不会替你猜。
- 拒绝码：`draft validate` 与 canonical 读取都会拒绝同一子概念的第二条出边 `SPECIALIZES_MULTIPLE_PARENTS`、自连 `SPECIALIZES_SELF_LINK`、成环 `SPECIALIZES_CYCLE`；失败时草稿保留、canonical 零写入。被当前机制 `pinnedRuleIds` 固定的旧 is-a 规则，必须在同一份草稿里一并移除该引用——`draft save` 的三文件事务只提交你写下的内容，不会替你猜。
- 新建概念时若同时指定 is-a 父概念，两份草稿要一次提交：在同一 draft 里同时改 `definitions.json` 与 `rules.json`，再执行一次 `draft save`。只改其中一份会留下「概念已建、is-a 丢失」或端点不存在的候选，validate 会直接拒绝。
- 已知限制：`draft open` 必须提供已存在的 `--mechanic`，因此**空机制工作区无法用本工具修改 is-a**；请先在网页里创建一张机制图，或让用户用网页的概念面板设置。

## 建模准则

- 规则优先：先写出触发、参与者、状态变化、条件/例外和证据，再决定概念与连线。
- 概念只在承担独立输入、输出、状态、事件或判定职责时保留；单链中间量若没有其他规则职责，应把细节压回规则文字。
- 限定词只缩小单条规则端点的真实适用子集，不改变概念身份；规则适用于完整概念时不得使用限定词。
- `is-a` 只表示真实子类到上位概念；只有分类边且不参与玩法规则的父概念是冗余候选。
- 同一有向基础端点对只保留一条规则；将多个条件、例外和结算细节合并在该规则文字中。
- 规则只存于 `rules.json`；机制图只保存 `focusNodeIds` 和 `pinnedRuleIds`。机制引用规则任一端点时会投影该规则及另一端概念，不复制规则。
- 缺边或未找到路径只表示模型证据不足，不得据此虚构、删除或宣称运行时事实。

脚本只提供受限的空机制容器创建、查询、草稿校验和 JSON 草稿编辑；不提供迁移、修复、网页视图或文档发布，不能通过本 skill 绕过这些边界。
