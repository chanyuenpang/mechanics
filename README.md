# Mechanics

> 规则、概念与关系解释工具。

用概念节点、正向影响、负向影响、随机影响和 `specializes` 结构关系分析规则。限定词只缩小某条规则端点的适用范围，不产生新的概念或子类；`tags` 仅用于分类和搜索。统一节点定义图提供共享概念；独立机制图描述基础规则、关卡、敌人或手牌；多张机制图可以组合浏览。

**当前版本可从 npm 安装为 CLI，并启动网页编辑器。** 顶部切换「概念表｜机制图」；侧栏上方是视图，下方是可折叠、筛选的机制目录，两区的「＋」分别新建对应文件。概念表维护共享定义，机制文件引用概念并编辑关系，磁盘后缀仍为 `.mechanic.json`。

在机制的「引用概念」窗口可以按名称、英文语义 ID 或自然语言别名搜索已有概念，也可直接新建。持久化概念、机制、视图和规则 ID 使用稳定的小写英文 kebab-case，不再自动生成 UUID 或随机十六进制片段。规则 ID 由有向端点固定为 `<source>-2-<target>`；同一机制内同一有向端点对只允许一条规则，再次连接应编辑原规则。

机制可按名称、ID 或相对路径筛选；目录折叠和筛选仅影响本页列表，不改变画布或视图注册，也不写文件。打开视图后，其下方只列已注册的子机制；Visible 按钮切换显示，视图旁的「＋」从可搜索候选中注册新子机制。全局机制目录仍负责独立打开和新建，不再充当视图成员清单。

选择模式下空白处左键框选，Shift 增选；右键、空格或中键平移。拖动选中节点整体移动，一次撤销恢复全组。双击节点进入连接，再选目标自动建线，沿用本页最后成功创建或修改的关系类型（初始为正向影响），Esc 取消。节点端点自动选择上、下、左、右，反向边错开显示。正向影响和负向影响分别使目标沿增加方向和减少方向变化；随机影响表示方向不确定，不表示概率；`specializes` 表示具体概念指向上位概念并受 DAG 校验，不是影响路径。

工具栏「自动排版」在没有节点选择时重排当前可见的全部节点；选中全部可见节点时显示「自动排版（全部）」并得到与无选择逐值一致的完整布局。部分框选或 Shift 选中节点后变为「重排选中（N）」，只移动选中节点，未选节点坐标严格保持。完整排版优先拉直接近水平或垂直的相连节点，并在对齐会碰撞时保留 ELK 结果。排版不改变相机、不因机制勾选自动触发，并形成一次撤销记录；视图自动保存，机制仍手动保存。折叠摘要须先展开再排版。

点击机制只打开它自身的关系图，规则和单图布局手动保存。打开 `.view.json` 后，可管理已注册子机制的 Visible 状态；注册、显隐、组合布局与折叠自动写回视图，源规则只读。通过「编辑源机制」进入单图，完成后「返回视图」读取最新规则并恢复原组合布局和本页相机。旧内联叠加保留为只读预览，须明确保存为 view v3 或放弃，不会启动即覆盖。

## 安装包与工作区

需要 Node.js 24+。从 npm 安装：

```sh
npm install -g @veewo/mechanics
mech web
```

`init` 在项目内创建固定 `.mechanics`，并把包内 `mechanics-search`、`mechanics-modeling`、`mechanics-doc` 注册到项目 `.agents/skills/`。这些受管 skill 内容不同或包含过期附件时，会在项目打开或 `mech sync` 时以当前已安装包的完整目录替换；这不代表联网升级。工作区 ID 默认取项目目录名；目录名不符合英文语义 ID 时必须显式传 `--id`。安装与 Codex 配置见 [安装与 Codex 接入](docs/安装与Codex接入.md)。

服务只在项目固定 `.mechanics` 中递归发现 `*.mechanic.json` 和 `*.view.json`，支持中文目录和空目录。统一定义只读取配置指定的唯一文件，机制按稳定 ID 接合。正式协议为 workspace v10、mechanic v6、definitions v5、view v3；旧协议、旧文件类型或旧字段严格失败，不提供运行时兼容。旧根目录只能用 `mech migrate-root --project <项目目录>` 预览后显式执行切换。详见 [CLI 与工作区](docs/CLI与工作区.md)。

## 从源码启动

CLI 同时提供只读 `agent guide/scopes/search/graph/node/impact` 与受约束 `agent concept/rule` mutation。Agent 先用 guide 理解符号与模型边界，再搜索概念、按方向与距离查询相关机制；只有用户明确要求建模写入时才使用 mutation。默认语义 JSON，支持易读中文文本、整体/资源版本约束及在线服务。声明、推导与未知项明确分开。用法见 [Agent 查询与受约束写入](docs/Agent查询接口.md)。

`mech mcp render` 提供面向对话的只读 MCP Apps widget：只接收已经消歧的 `conceptIds`，渲染这些概念和它们之间的声明关系，不承担搜索、路径推理或编辑。它把工作区固定在启动时的当前目录上下文，调用中不接受项目路径。详见 [Codex MCP Apps](docs/Codex%20MCP%20Apps.md)。

每个项目还会在 `agentExportPath` 指定的目录（默认 `mechanics`）生成 `AGENTS.md`、`README.md`、唯一的 `concepts.md`，以及 `folders/<机制文件夹>/index.md`。文件夹页只汇总直接所属的机制图，并只链接子文件夹；概念仍是全局共享词典，不会随机制图复制成单独文件。它们是排除坐标、端口、连线路径和视图状态的只读 Agent 文档；canonical definitions/mechanics 仍是唯一可编辑真相。文档只投影概念、声明规则与已填写的规则文字，不由程序合成机制流程说明。

需要 Node.js 24 或更高版本。工具没有宿主游戏依赖。

```sh
npm ci
npm run check
npm run dev -- --project ./examples/card-game
```

打开终端打印的本地网址，或不传 `--project` 后在网页选择项目。服务没有 session 或 Origin 授权；任何能访问本机端口并知道项目绝对路径的网页或进程都可能调用写接口，因此它只应在可信本机开发环境运行。

```sh
npm run validate -- --project /path/to/my-game
npm run dev -- --project /path/to/my-game --port 4319
```

## 文件与模块

```text
src/domain/          通用图算法与工作区校验
src/server/          本地文件读写、版本冲突与 HTTP 服务
src/web/             文件目录、图层和 SVG 节点编辑器
schemas/             JSON 文件结构的唯一合同
skills/              init 注册到项目的 Mechanics Codex skill 唯一维护源
examples/card-game/  通用演示，不含宿主项目数据
tests/               协议、图语义、文件边界与 HTTP 验证
docs/                产品、架构、协议和后续实施切片
```

实际工作区位于工具仓库之外：

```text
某个游戏项目/
├── .mechanics/
│   ├── workspace.json
│   ├── definitions.graph.json
│   └── mechanics/
│       ├── basic-rules.mechanic.json
│       ├── encounter.mechanic.json
│       └── encounter-with-hand.view.json
└── mechanics/                  默认，可由 agentExportPath 改为项目内其他目录
│   ├── README.md
│   ├── AGENTS.md
│   ├── concepts.md
│   └── folders/
│       └── <机制文件夹>/index.md
```

节点定义图拥有节点 ID、名称、含义、变化方向与默认布局。概念表维护已有定义，引用窗口也可新增共享定义；因果边由各机制图拥有。view v3 用有序 `mechanicRegistrations` 保存子机制注册及 Visible 状态，并用 `structuralPresentation: "line"|"badge"` 选择结构呈现；不复制基础规则或合并结果。工作区配置和定义文件不作为侧栏导航项；历史命名组合保留校验，不自动转为视图文件。

## 设计入口

- [需求与范围](docs/需求与范围.md)：方法论、用户流程与非目标。
- [架构设计](docs/架构设计.md)：模块、唯一事实来源、失败边界与实施切片。
- [文件协议](docs/文件协议.md)：字段、引用、版本、叠加与保存合同。
- [开发路线](docs/开发路线.md)：已落地能力和后续验收。
- [编辑器使用说明](docs/编辑器使用说明.md)：操作方式、保存归属和错误处理。
- [CLI 与工作区](docs/CLI与工作区.md)：安装、新建、根定位、目录发现和显式迁移。
- [安装与 DSH 接入](docs/安装与DSH接入.md)：在 DeepSeek Harness 里安装插件、使用 `mechanics_search` / `mechanics_graph` 与 widget、排障与卸载。
- [更新与升级](docs/更新与升级.md)：CLI、项目内受管资产与宿主接入三个层次的更新路径，协议迁移与回滚。

正向与负向描述目标相对自身变化方向，不表示对玩家有利或不利。随机只表示方向不确定，不表示概率。路径方向不能代替数值模拟；结构疑点不能自动判定游戏不好玩。

## 仓库接入

工具可以独立克隆，也可以作为任意游戏项目的 Git 子模块。子模块只携带通用源码与协议；分析数据归宿主项目。更新时先提交并推送工具仓库，再由宿主更新子模块指针。CLI 发布到 npm，但不因 registry 分发改变仓库授权条款。`npm run check:package` 在 `dist/` 制作本地 tarball，并在隔离目录验证安装与启动；不会上传真实项目的分析资料。
