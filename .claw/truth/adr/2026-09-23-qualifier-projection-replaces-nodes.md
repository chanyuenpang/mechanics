# ADR：限定投影替代基础实例，无规则成员不得凭空消失

## 背景

端点限定词（`sourceQualifiers` / `targetQualifiers`）是规则的参与者范围。画布读取时，`src/domain/endpoint-projection.mjs` 会把声明了限定词的端点投影成独立的 `scopeProjection` 节点，替掉原来的基础概念实例，避免同一概念在画布上被画两遍。

限定投影最初用「是否出现在某条边上」作为渲染条件，凡是不在边上的节点一律丢弃。它的本意只是隐藏「基础概念的全部可见端点都已被限定投影接管」后的重复实例，但这个条件同时命中了另一类节点：只在 `focusNodeIds` 里、当前没有任何规则的概念。机制图使用 `ruleSelection: "explicit"` 时，is-a 常常是某个概念在图中唯一的规则；用户在详情栏清除 is-a 之后，该概念既失去规则、也不会出现在任何边上，于是被当作孤点删除——用户看到的是「删掉 is-a，节点从画布消失」。用户要求的语义是「清除父概念」，不是「把这个概念移出这张图」。

## 决策

- 基础实例的隐藏条件由 `projectEndpointQualifiers` 的 `replacedBaseIds` 单点决定：只有确实被限定投影接管的基础概念才不再单独渲染，判定依据是投影集合本身，而不是「节点是否在边上」。
- 没有任何规则、但属于当前机制图或视图焦点集合的概念必须保留渲染。它是该图明确引用的成员，不在任何边上不构成删除理由。
- 端点限定投影与展示投影职责分离：`projectEndpointQualifiers` 只负责参与者范围投影并产出基础图；`projectDisplayGraph`（`taxonomy-presentation.mjs`）负责 is-a 展开与结构徽标。画布显示顺序固定为 `compose` → 限定投影 → 展示投影，三段都不得越权写 canonical。
- 本决策不新增字段：workspace v13 / definitions v7 / rules v1 / mechanic v8 / view v5 不变；清除 is-a 仍然只改 `rules.json` 与当前文件的 `focusNodeIds` / `pinnedRuleIds`。

## 取舍

- **继续用「不在边上即隐藏」判定孤点**：未采用。它无法区分「已被限定投影替代的重复实例」与「没有任何规则的焦点成员」，正是节点凭空消失的根因。
- **在清除 is-a 时特殊加回焦点集合**：未采用。它只覆盖清除路径，其他让概念暂时没有规则的路径仍会丢节点；正确的边界应在投影层。
- **把无规则概念默认隐藏、靠用户重新引用找回**：未采用。机制图/视图的成员身份由焦点集合与固定规则共同决定，投影不应静默删除显式成员。
- **把限定投影合并进 `projectDisplayGraph`**：未采用。限定投影是规则参与者的读取模型，与 is-a 展示状态无关；合并会让展示状态反向影响参与者语义。

## 影响

- 隐藏条件改成基于 `replacedBaseIds` 之后，任何新增渲染条件都必须继续回答「这个节点是重复实例还是显式成员」；不得再用「是否在边上」这类结构性近似。
- 机制图与视图两条打开路径都经过该投影，因此修复同时覆盖显式投影与非显式投影；投影只创建读取模型，不产生概念、不反写关系。
- 回归覆盖 `tests/endpoint-projection.test.mjs` 的四个用例（规范化去重、全部端点被接管时隐藏、无规则概念保留、混合场景只隐藏被接管的基础实例）。

证据锚点：`src/domain/endpoint-projection.mjs`、`src/domain/taxonomy-presentation.mjs`、`src/web/app.mjs`、`src/web/canvas.mjs`、`scripts/routing-quality.mjs`；`tests/endpoint-projection.test.mjs`。
