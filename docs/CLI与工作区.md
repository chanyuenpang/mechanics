# CLI 与项目工作区

Game-Graph 是本地开发工具。程序安装目录只拥有 CLI、网页、Schema、文档和通用示例；每个游戏项目固定使用 `<project>/.game-graph` 保存 canonical 概念、机制与视图。

## 命令

```sh
game-graph --help
game-graph --version
game-graph init ./my-game --name "我的游戏" --id my-game
game-graph web
game-graph validate --project ./my-game
game-graph catalog --project ./my-game
game-graph root --project ./my-game
game-graph agent guide --format text
game-graph agent scopes --project ./my-game
game-graph agent concept create --project ./my-game ... --revision <definitions资源版本>
game-graph agent rule add --project ./my-game ... --revision <机制资源版本>
```

Agent 查询与 mutation 的完整参数见 [Agent 查询与受约束写入](Agent查询接口.md)。

`init` 可以在已有普通项目目录内创建 `.game-graph`，也可以创建尚不存在的项目目录；同时把安装包内的 `game-mechanic-search` 与 `game-mechanic-modeling` 注册到项目 `.agents/skills/`。已有 `.game-graph` 时明确拒绝，不覆盖。目标 skill 不存在时安装；内容与包内版本完全相同时视为已注册；路径被占用或内容不同时在创建工作区前返回 `PROJECT_SKILL_CONFLICT`，绝不覆盖。工作区 ID 默认取项目目录名，目录名不符合英文语义 kebab-case 时必须显式传 `--id`。

`web` 省略 `--project` 时以空项目状态启动，网页可以打开项目；项目缺少 `.game-graph` 时按用户提供的名称和稳定 ID 初始化。`validate/catalog/root` 省略 `--project` 时从 cwd 向上寻找最近的 `.game-graph/workspace.json`。项目切换先完整打开候选并取得锁，成功后才替换当前项目；每次切换递增 `projectGeneration`，旧页面或旧在线 mutation 写入明确返回 `PROJECT_CHANGED`。

`catalog` 从 canonical definitions/mechanics 重建 catalog v5 的 Markdown-only Agent 读模型并回读验真。输出目录由 workspace v10 的 `agentExportPath` 指定，默认 `game-mechanics`；只包含生成的 `AGENTS.md`、`README.md`、唯一 `concepts.md` 与按实际机制目录生成的 `folders/<目录>/index.md`。文件夹只做机制图分类，不改变概念、规则或视图成员；目录通过生成指南确认归属，不接管或删除未知内容；旧 manifest/index/JSON 与逐概念读模型只在受控升级时清理。

服务只绑定 `127.0.0.1`，端口 0 可让系统选择空闲端口。没有 session、Bearer 或 Origin 授权，并允许普通网页跨源调用 JSON API；任何能访问本机端口并知道项目绝对路径的网页或进程都可能读写资料，因此只应在可信本机开发环境运行。Host、JSON、路径、整体 revision、资源 revision、projectGeneration 和工作区锁仍严格校验。

不要双击 `src/web/index.html`：`file://` 没有本地文件 API。应使用 CLI 打印的 HTTP 网址。服务重启不需要凭据；旧页面仍可能持有旧 generation 或 revision，写入会被拒绝，须重新打开项目并合并草稿。

## 目录合同

Windows 网页的「打开项目」直接调用现代系统文件夹选择器（FileOpenDialog 文件夹模式，逐显示器 DPI V2），保留系统地址栏、侧边导航和搜索，不使用旧 WinForms 目录树。选择后继续项目预检与确认；取消不会切换或初始化项目。项目设置里的导出目录选择也使用同一原生入口，并继续限制在当前项目内。原生入口仅允许本服务页面同源调用，一次只打开一个选择器；调用失败或非 Windows 平台明确报错，不自动改用网页目录树。

```text
my-game/
├── .game-graph/
│   ├── workspace.json
│   ├── definitions.graph.json
│   ├── mechanics/
│   │   └── basic.mechanic.json
│   └── 关卡/首领.view.json
└── game-mechanics/             默认，可配置为 docs/game-mechanics 等项目内目录
    ├── AGENTS.md
    ├── README.md
    ├── concepts.md
    └── folders/<mechanic-folder>/index.md
```

canonical 目录递归发现普通 `*.mechanic.json` 和 `*.view.json`。隐藏条目与 `node_modules` 排除；其他后缀不作为规则或视图。文件名和目录不是图 ID。外部移动文件后按稳定 ID 恢复引用；缺失来源、坏 JSON、重复 ID、越界路径、junction/符号链接或嵌套工作区都整体失败，不返回部分成功。

正式协议固定为 workspace v8、definitions/mechanic v4、view v3；查询协议与阅读合同为 v7。CLI 对旧版本严格失败，不兼容读取；只能用 `game-graph migrate --from 7 --to 8 --project <项目目录>` 预览并显式执行受控升级。

## 制作可安装包

```sh
npm ci
npm run check
npm run check:package
```

包验收会审查 dry-run 清单，创建 `dist/game-graph-0.7.0.tgz`，在隔离目录安装并验证 CLI、两个 canonical skill、项目初始化时的 skill 注册、只读查询、受约束 mutation、在线服务、静态资源和工作区读取。skill 的维护源固定在 Game-Graph 包 `skills/`；项目 `.agents/skills/` 是初始化产生的注册副本，不反向成为工具真相。`private:true` 表示 npm 拒绝公开发布；本地 tarball 不代表公开发布。
