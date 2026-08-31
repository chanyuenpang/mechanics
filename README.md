# 游戏规则分析工具

用概念节点和正负因果连线，分析规则之间的影响。统一节点定义图提供共享概念；独立分析图描述基础规则、关卡、敌人或手牌；多张分析图可以组合浏览。

**当前版本 0.3.0 可通过本地安装包作为 CLI 使用，启动网页编辑器。** 顶部切换「概念表｜分析图」；侧栏按真实目录混排分析图和视图文件，提供「新建分析图」与「保存为视图」。概念表维护共享定义，分析图引用概念并编辑关系。

每张分析图对应一个 Layer。勾选决定是否显示，点击决定编辑哪个文件；浅色关系来自其他图层。点击「保存为视图」创建 `.view.json`，此后的勾选、编辑层与折叠变化自动写回该文件。打开任一视图都会读取最新源图重新组合；未命名浏览仍自动记忆到工作区。规则编辑需点击「保存」或按 Ctrl+S，界面分别显示规则与视图保存状态。

## 安装包与工作区

需要 Node.js 24+。拿到受控分发的本地安装包后：

```sh
npm install -g ./game-rule-analyzer-0.3.0.tgz
game-rule-analyzer init ./game-analysis --name "游戏规则"
cd game-analysis/analyses
game-rule-analyzer serve
```

`init` 只创建明确指定的新目录，不覆盖已有目录。`serve`、`validate`、`root` 省略 `--workspace` 时向上寻找最近的 `workspace.json`；显式路径优先且必须是根目录。服务启动后固定保存根，不随终端 cwd 改变。不把工具的安装位置当作资料位置，也不依赖 claw-kit 或游戏引擎。

侧栏递归发现 `*.analysis.json` 和 `*.view.json`，支持中文目录和空目录。新文件可指定相对目录；外部新增/移动后点击重新读取。统一定义只读取配置指定的唯一文件，图层按稳定 ID 接合。工作区已升级为 v3；旧 v1/v2 资料须先保存网页草稿、关闭旧服务，再显式执行 `migrate`，不会启动时自动升级。详见 [CLI 与工作区](docs/CLI与工作区.md)。

## 从源码启动

需要 Node.js 24 或更高版本。工具没有宿主游戏依赖。

```sh
npm ci
npm run check
npm run dev -- --workspace ./examples/card-game
```

打开终端打印的完整本地网址。分析其他游戏时，把 `--workspace` 改为该游戏的分析目录。工具不向下搜索或猜测宿主路径，不使用浏览器缓存充当文件保存。

```sh
npm run validate -- --workspace /path/to/game-analysis
npm run dev -- --workspace /path/to/game-analysis --port 4319
```

## 文件与模块

```text
src/domain/          通用图算法与工作区校验
src/server/          本地文件读写、版本冲突与 HTTP 服务
src/web/             文件目录、图层和 SVG 节点编辑器
schemas/             JSON 文件结构的唯一合同
examples/card-game/  通用演示，不含宿主项目数据
tests/               协议、图语义、文件边界与 HTTP 验证
docs/                产品、架构、协议和后续实施切片
```

实际工作区位于工具仓库之外：

```text
某个游戏的分析目录/
├── workspace.json
├── definitions.graph.json
└── analyses/
    ├── basic-rules.analysis.json
    ├── encounter.analysis.json
    ├── hand.analysis.json
    └── encounter-with-hand.view.json
```

节点定义图拥有节点 ID、名称、含义、变化方向与默认布局。概念表提供唯一的定义编辑入口；因果边由各分析图拥有。视图文件只引用分析图 ID，不复制基础规则或合并结果。工作区配置和定义文件不作为侧栏导航项；历史命名组合保留校验，不自动转为视图文件。

## 设计入口

- [需求与范围](docs/需求与范围.md)：方法论、用户流程与非目标。
- [架构设计](docs/架构设计.md)：模块、唯一事实来源、失败边界与实施切片。
- [文件协议](docs/文件协议.md)：字段、引用、版本、叠加与保存合同。
- [开发路线](docs/开发路线.md)：已落地能力和后续验收。
- [编辑器使用说明](docs/编辑器使用说明.md)：操作方式、保存归属和错误处理。
- [CLI 与工作区](docs/CLI与工作区.md)：安装、新建、根定位、目录发现和显式迁移。

正负表示促进或抑制，不表示对玩家有利或不利。路径符号不能代替数值模拟；结构疑点不能自动判定游戏不好玩。

## 仓库接入

工具可以独立克隆，也可以作为任意游戏项目的 Git 子模块。子模块只携带通用源码与协议；分析数据归宿主项目。更新时先提交并推送工具仓库，再由宿主更新子模块指针。当前保留 `private: true`，未向 npm 注册表发布，也未授予开源许可证。`npm run check:package` 在 `dist/` 制作本地 tarball，并在隔离目录验证安装与启动；不会上传源码或分析资料。
