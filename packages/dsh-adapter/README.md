# @veewo/dsh-mechanics

DSH（DeepSeek Harness）的 Mechanics 适配插件。它把**项目内受管工具** `.mechanics/tools/workspace-tool.mjs` 的检索与图投影注册成 DSH 的 typed 工具，并让结果在对话流里带上一张只读概念图卡。

## 它解决什么

- **检索更省**：`mechanics_search` 先精确解析稳定 ID、完整名称与完整别名，精确未命中才返回模糊候选（部分名称、别名、ID、描述），候选带 `matchedBy` 与 `score`。候选只是线索，工具不会替你消歧。
- **结构不用灌进上下文**：`mechanics_graph` 把概念与集合内部规则投影成图卡数据，经 `output.presentationMeta` 随结果落进会话日志；模型只读到清单文本，图形细节留在卡上。
- **不引入第二套协议**：host 半只按 argv 直跑项目内受管工具（不经 shell，因此没有引用与转义问题），投影形状由 `workspace-tool.mjs` 独有；插件不读 canonical、不写文件。

## 安装

```sh
dsh plugin --profile <profile> add <本目录路径 或 @veewo/dsh-mechanics>
```

`dsh plugin` 会在安装后自动把声明了 `dsh.bundle` 的依赖并入 `dsh.profile.bundles`，因此不需要手工改 profile；重启 Host 后生效。卸载 = `dsh plugin --profile <profile> remove @veewo/dsh-mechanics` + 重启。

逐条可复制的前置检查、安装、验证与回滚步骤见 [安装与回滚](docs/安装与回滚.md)。

## 工具契约

| 工具 | 参数 | 结果 |
|---|---|---|
| `mechanics_search` | `query`（概念键）或 `from`+`to`（双概念） | 概念详情 / 歧义或模糊候选 / 双向直接规则 |
| `mechanics_graph` | `conceptIds`（非空、无重复、≤64 的稳定 ID 数组） | `{ revision, conceptIds, nodes, edges }` 图投影 |

失败一律显式：概念不存在是 `NODE_NOT_FOUND`、参数不合法是 `TOOL_INVALID`、项目缺少受管工具是 `WORKSPACE_TOOL_MISSING`、没有工作区是 `WORKSPACE_NOT_FOUND`；没有任何兜底或降级路径。

## 依赖的项目侧版本

插件假定项目内工具支持 `search --query` 的模糊回退与 `graph --ids`（`guide` 的 `contractVersion >= 5`）。较旧的项目副本会让工具调用显式失败——这是刻意的：不静默退化，请先 `mech sync`。

## 客户端半

`lib/client.js` 是手写的 lazy-CJS 模块，交给当前 DSH 的组合客户端脚本加载；不能用旧的 `/plugins/<id>/client.js` 单文件 URL（返回 404）判断它未加载。

它注册检索工具卡，并监听 `tool/ptc-dispatch` 成功结算事件，在聊天流插入独立的可交互 `mechanics-widget` 节点；节点使用宿主传入的 `cwd` 请求插件图页面。同一 `run_code` 内多个成功图调用各保留一个 widget；当前 DSH 原生折叠 Code Mode/工具过程时，节点通过公开的 `turnProcess.setOpen(true)` 保持所属轮次展开，不需要旧版 `dsh-fold-turns`，也不将 widget 移进模型 final 正文。

- `mechanics_graph` → 只读 SVG 概念图卡：圆形布局、按影响符号着色的箭头、hover 看定义与规则文字、点击节点展开定义与集合内关系。
- `mechanics_search` → 检索卡：概念详情、歧义/模糊候选（含 `matchedBy` 与分数）、双向直接规则、双概念未解析、未找到，各一支。

检索卡读取冻结的调用与结果；图卡不依赖 PTC 子调用的 `presentationMeta`，而由完成事件的稳定 ID 与会话 `cwd` 构造只读图页面。工具执行、图页面 200、对话流节点可见须分别验收。

## 本地预览：不用重启宿主也能看卡

```sh
node scripts/preview.mjs --out <目录> [--screenshot <png>]
```

它把 `lib/client.js` 装进一个最小页面——只替身 `window.__ModuleLoader__`（lazy-CJS 注册面）与一个把元素树直接建成 DOM 的最小 React——然后用真实浏览器渲染四张状态：图卡未选节点、图卡选中节点（展开定义与集合内关系）、检索的模糊候选、以及 running 态（还没有载荷）。卡的代码、布局数学、SVG 结构与主题变量都是真的，差别只在没有宿主外壳（无字体继承、无悬停气泡）。改卡视觉时先看这里，比重启宿主快得多。

## 尚未包含

草稿编辑通道（`mechanics_draft` 的 open/patch/validate/save 与卡内保存按钮）见后续任务；本轮只读。
