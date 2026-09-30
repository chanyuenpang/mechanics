# CLI 与项目工作区

> 已迁移提示：当前产品为 **Mechanics**，CLI 为 `mech`，唯一 canonical 根目录为 `<project>/.mechanics`。下文尚未逐段迁移的 `game-graph`、`.game-graph` 与旧协议示例仅作历史背景，不能作为操作指令；请以 [README](../README.md) 与 `mech --help` 为准。

Mechanics 是本地开发工具。程序安装目录只拥有 CLI、网页、Schema、文档和通用示例；每个项目固定使用 `<project>/.mechanics` 保存 canonical 概念、机制与视图。`mech --version` 和帮助页首行显示产品包版本，帮助中的工作区 v13 则是独立的文件协议版本，二者不能混用。

## 命令

```sh
game-graph --help
game-graph --version
game-graph init ./my-game --name "我的游戏" --id my-game
game-graph web
game-graph validate --project ./my-game
game-graph catalog --project ./my-game
game-graph root --project ./my-game
game-graph agent guide --format json
game-graph agent scopes --project ./my-game
game-graph agent concept create --project ./my-game ... --revision <definitions资源版本>
game-graph agent rule add --project ./my-game ... --revision <机制资源版本>
game-graph agent rule set-parent --project ./my-game --mechanic <投影机制ID> --concept <子概念> --parent <父概念|none>
```

Agent 查询与 mutation 的完整参数见 [Agent 查询与受约束写入](Agent查询接口.md)。is-a 只由概念的「is-a 父概念」字段承担，网页节点面板与概念对话框、`mech agent rule set-parent`、项目内 `workspace-tool.mjs isa set` 是同一条关系的三个入口；画布连线只创建影响规则。

`init` 可以在已有普通项目目录内创建 `.mechanics`，也可以创建尚不存在的项目目录；同时把安装包内的 `mechanics-search`、`mechanics-modeling`、`mechanics-doc` 三个受管 skill 注册到项目 `.agents/skills/`，把 `workspace-tool.mjs` 同步到 `.mechanics/tools/`。已有 `.mechanics` 时明确拒绝，不覆盖。目标 skill 不存在时安装；文件集合与内容完全相同时视为已注册；内容不同或含过期附件时用当前安装包的完整目录整体替换（暂存目录 → 备份 → 原子改名），中断报 `PROJECT_SKILL_REGISTRATION_PARTIAL`。只有路径被普通文件或符号链接占用时才在创建工作区前返回 `PROJECT_SKILL_CONFLICT`，绝不覆盖非受管路径。工作区 ID 默认取项目目录名，目录名不符合英文语义 kebab-case 时必须显式传 `--id`。

`web` 省略 `--project` 时以空项目状态启动，网页可以打开项目；项目缺少 `.mechanics` 时按用户提供的名称和稳定 ID 初始化。`validate/catalog/root` 省略 `--project` 时从 cwd 向上寻找最近的 `.mechanics/workspace.json`。项目切换先完整打开候选并取得锁，成功后才替换当前项目；每次切换递增 `projectGeneration`，旧页面或旧在线 mutation 写入明确返回 `PROJECT_CHANGED`。

`catalog` 从 canonical definitions/rules/mechanics 重建 Markdown-only Agent 读模型并回读验真。输出目录由 workspace v13 的 `agentExportPath` 指定，默认 `mechanics`；只包含生成的 `AGENTS.md`、`README.md`、唯一 `concepts.md` 与按实际机制目录生成的 `folders/<目录>/index.md`。文件夹只做机制图分类，不改变概念、规则或视图成员；目录通过生成指南确认归属，不接管或删除未知内容；旧 manifest/index/JSON 与逐概念读模型只在受控升级时清理。

服务只绑定 `127.0.0.1`，端口 0 可让系统选择空闲端口。没有 session、Bearer 或 Origin 授权，并允许普通网页跨源调用 JSON API；任何能访问本机端口并知道项目绝对路径的网页或进程都可能读写资料，因此只应在可信本机开发环境运行。Host、JSON、路径、整体 revision、资源 revision、projectGeneration 和工作区锁仍严格校验。

不要双击 `src/web/index.html`：`file://` 没有本地文件 API。应使用 CLI 打印的 HTTP 网址。服务重启不需要凭据；旧页面仍可能持有旧 generation 或 revision，写入会被拒绝，须重新打开项目并合并草稿。

## 目录合同

网页的「打开项目」支持 Windows 和 macOS 系统文件夹选择器。Windows 使用 FileOpenDialog 文件夹模式（逐显示器 DPI V2）；macOS 通过系统自带的 `osascript` 调用 AppKit NSOpenPanel，无需额外安装桌面运行时。选择器保留系统侧边导航、地址定位和搜索；macOS 只允许选择一个目录，指定的初始路径不存在或不是目录时明确报错。

选择后继续项目预检与确认；取消或 Esc 不会切换或初始化项目。项目设置里的导出目录选择及关联项目使用同一原生入口，导出目录仍限制在当前项目内。原生入口仅允许本服务页面同源调用，一次只打开一个选择器；可等待用户选择最多 10 分钟，不受普通 API 的 15 秒超时限制。页面断开或服务关闭时中止选择，取消或失败后可重试。调用失败或未支持的平台明确报错，不自动改用网页目录树。

```text
my-game/
├── .mechanics/
│   ├── workspace.json
│   ├── definitions.json
│   ├── rules.json
│   ├── mechanics/
│   │   └── basic.mechanic.json
│   ├── tools/                 受管工具，不计入文件树版本
│   └── 关卡/首领.view.json
└── mechanics/                  默认，可配置为 docs/mechanics 等项目内目录
    ├── AGENTS.md
    ├── README.md
    ├── concepts.md
    └── folders/<mechanic-folder>/index.md
```

canonical 目录递归发现普通 `*.mechanic.json` 和 `*.view.json`。隐藏条目与 `node_modules` 排除；其他后缀不作为规则或视图。文件名和目录不是图 ID。外部移动文件后按稳定 ID 恢复引用；缺失来源、坏 JSON、重复 ID、越界路径、junction/符号链接或嵌套工作区都整体失败，不返回部分成功。

正式协议固定为 workspace v13、definitions v7、rules v1、mechanic v8、view v5。CLI 与网页只把当前版本当作可写合同：打开项目时所有仍有迁移路径的旧协议（v7–v12）自动逐级预览→执行迁移（任何一跳失败都不写入文件），更早或未知版本仅按核心拓扑兼容模式只读打开，结构编辑以 `COMPATIBILITY_READ_ONLY` 拒绝。也可用 `mech migrate --from <旧版本> --to <新版本> --project <项目目录>` 逐级预览并显式执行，或用 `mech migrate-project --project <项目目录> --execute` 一次完成旧根、旧 skill 与协议的链式升级。

## 制作可安装包

```sh
npm ci
npm run check
npm run check:package
```

包验收会审查 dry-run 清单，创建 `dist/game-graph-<version>.tgz`，在隔离目录安装并验证 CLI、三个受管 skill、项目初始化时的 skill 注册、只读查询、受约束 mutation、在线服务、静态资源和工作区读取。skill 的维护源固定在 Game-Graph 包 `skills/`；项目 `.agents/skills/` 是初始化产生的注册副本，不反向成为工具真相。公开发布的完整步骤见仓库根目录 [`DISTRIBUTION.md`](../DISTRIBUTION.md)；本地 tarball 仅是发布前验收，不能代替 registry 回读验证。
