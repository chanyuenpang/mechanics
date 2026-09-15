# Mechanics 安装与 DSH 接入

本页是当前 `@veewo/mechanics` 在 DeepSeek Harness（DSH）里的插件接入入口。MCP/widget 的 Codex 侧配置见 `安装与Codex接入.md` 与 `Codex MCP Apps.md`。

## 安装与初始化

需要 Node.js 24 或更高版本。

```powershell
npm install -g @veewo/mechanics
mech init <项目目录> --name <项目名称> --id <稳定项目ID>
```

`init`/`sync` 会把受管 skill 与**项目内工具** `.mechanics/tools/workspace-tool.mjs` 同步进项目。**DSH 插件不自带这套工具**，它调用的是项目里那一份；因此项目必须同步到支持 `search --query` 模糊回退与 `graph --ids` 的版本（`mech agent guide` 的 `contractVersion` ≥ 5）。版本不符时插件不会静默降级，工具调用会带着项目工具自己的错误码失败。

## 安装 DSH 插件

```powershell
dsh plugin --profile web add @veewo/dsh-mechanics
```

然后重启 `dsh web`。`dsh plugin` 会把声明了 `dsh.bundle` 的依赖自动并入 profile 的 `dsh.profile.bundles`，不需要手工改 profile。

## 它给 agent 什么

| 工具 | 作用 |
|---|---|
| `mechanics_search` | 精确解析稳定 ID/完整名称/完整别名；精确未命中时返回模糊候选（含 `matchedBy` 与分数），工具不会替你消歧 |
| `mechanics_graph` | 只接受已消歧的稳定概念 ID 数组，返回概念与其集合内部的声明关系，**并在对话流里生成一张 widget** |

widget 是 **agent 给用户看的展示面**：可滚轮缩放、拖拽平移、悬停出概念定义与规则文字；它不承担操作，也不需要用户在卡上点任何东西。

插件同时自持两条只读路由（都不需要额外配置）：

- `GET /mechanics/widget?project=<项目目录>&ids=<稳定ID,逗号分隔>`：widget 页面本身；
- `GET /mechanics/graph?project=<项目目录>&ids=…`：与工具同一份投影 JSON。

两条都只读、只服务含 `.mechanics/workspace.json` 的项目、不做任意文件读取；它们**没有调用者身份**，因此只适用于绑回环地址的部署。

## 何时使用：双入口

- **DSH 且已安装本插件**：优先用 `mechanics_search` / `mechanics_graph`。图只在 `mechanics_graph` 上产生，且只在拿到会话工作区目录与稳定 ID 时挂载。
- **其他宿主或未装插件**：用项目内工具 `node <项目>/.mechanics/tools/workspace-tool.mjs`（见 `mechanics-search`、`mechanics-modeling` skill）。

两条路径读的是同一份 JSON 契约，插件只是把同一份契约包成了 typed 工具并补上可视化，不存在第二套协议。

## 排障

| 现象 | 先查 |
|---|---|
| 会话里没有这两个工具 | profile 是否安装并**重启**；`dsh plugin --profile web add` 是否成功 |
| 工具报 `WORKSPACE_TOOL_MISSING` | 项目缺 `.mechanics/tools/workspace-tool.mjs`，运行 `mech sync` |
| 工具报项目工具自己的 `TOOL_INVALID` | 项目内工具版本过旧（`guide` 的 `contractVersion` < 5），`mech sync` |
| 卡里显示红色错误页 | widget 页面自己的错误说明，逐字读：项目没有工作区、ID 不存在或含重复 |
| 节点位置或层次不理想 | 自动排版由 `arrangeGraph`（ELK）给出；这是与网页/MCP 同一份布局代码 |

工具调用成功、宿主显示 widget、以及 widget 里画对内容，是三个独立结果；排障时分别核实，不能以前一项代替后一项。

## 卸载

```powershell
dsh plugin --profile web remove @veewo/dsh-mechanics
```

再重启 `dsh web`。插件不写 canonical、不新建文件，项目侧零残留。

## 继续阅读

- Codex 侧安装与 MCP 配置：`安装与Codex接入.md`
- MCP widget 合同与兼容性：`Codex MCP Apps.md`
- 查询与受约束写入：`Agent查询接口.md`
- 文件格式与版本：`文件协议.md`
- 架构、路径与安全边界：`架构设计.md`
