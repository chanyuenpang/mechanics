# CLI、工作区与文件保存

<!-- state: current -->
## 当前行为

- Node.js 24+ 本地 CLI（bin `mech`，包名 `@veewo/mechanics`）提供 `init/web/validate/catalog/root`、只读 `agent guide/scopes/search/graph/node/impact` 与受约束 `agent concept/rule` mutation。`src/server/cli.mjs` 的顶层帮助从包元数据读取产品版本，工作区协议版本单独取 `CURRENT_WORKSPACE_VERSION`（当前 v13）；`mech --version` 返回包版本，不把协议 v13 当产品版本。子命令帮助与迁移说明应随协议更新，避免旧版本示例被误作当前命令。源码和 npm 包独立于游戏引擎、宿主资产和 claw-kit；npm 分发不代表仓库授权条款变更。
- 每个游戏项目固定使用 `<project>/.mechanics` 保存 canonical。`init` 可在现有普通项目内创建该目录，也可创建项目根，并把包内 `mechanics-search`、`mechanics-modeling`、`mechanics-doc` 注册到项目 `.agents/skills/`，把 `workspace-tool.mjs` 同步到 `.mechanics/tools/`；已有 `.mechanics` 时拒绝覆盖。打开或初始化项目后在后台更新这些受管资产，不等待同步完成即可使用页面。
- 三个受管 skill（`mechanics-search`、`mechanics-modeling`、`mechanics-doc`）的唯一维护源在工具包 `skills/`，项目 `.agents/skills/` 只是注册副本，不反向成为工具真相。目标不存在时安装；文件集合与内容完全相同时视为已注册；目录内容不同或含过期附件时，用当前安装包的完整目录整体替换（暂存目录 → 备份 → 原子改名），不逐文件合并，也不是联网升级。只有路径被普通文件或符号链接占用才在创建工作区前返回 `PROJECT_SKILL_CONFLICT`，不覆盖用户文件；替换中途失败返回 `PROJECT_SKILL_REGISTRATION_PARTIAL`，报告已安装项与暂存目录。`init` 在创建工作区之后注册，该阶段失败以 `INIT_PARTIAL` 显式报告已创建工作区或已安装 skill；网页打开触发的后台同步失败只记在该会话的 `projectAssetSync`（`state: failed` 与错误码）并写服务日志，不阻断会话，修复后重开可重试。
- 显式 `--project` 优先；`validate/catalog/root` 省略时向上寻找最近 `.mechanics/workspace.json`。`web` 可空项目启动并从网页打开或初始化项目。候选完整打开并取得锁后才切换，`projectGeneration` 阻止旧页面写入新项目。
- 正式协议只接受工作区 v13、definitions v7、rules v1、mechanic v8、view v5；mechanism 与 view 必填 `taxonomyPresentation`。`readWorkspace` 只把当前版本当作可写合同，读取路径不为缺失字段补默认值。打开项目时，所有仍有迁移路径的旧协议（v7–v12）在创建 store 前按预览→执行自动逐级升级（每一跳原子提交并回读，任何一跳失败零部分写入），失败返回迁移错误且不返回部分工作区；v11/v12 因缺少必填展示状态没有只读兼容模型，v7–v10 的直接读取仍按核心拓扑兼容模式呈现（结构编辑以 `COMPATIBILITY_READ_ONLY` 拒绝）。目录递归发现普通 `*.mechanic.json`、`*.view.json`；不保存第二份清单。隐藏条目与 node_modules 排除，普通目录包括空目录参与发现。服务内存 `files` 按 `(kind,id)` 对应当前路径；两种文件可同 ID，移动后重读可定位。
- 唯一定义入口由 `workspace.json.definitions` 指定。拒绝路径穿越、内部符号链接/junction、嵌套工作区、坏 JSON、重复 ID、未知版本与断引用，不能返回部分成功。
- 命名视图 `.view.json` 保存机制 ID、折叠与组合位置，源规则只读；新建和展示编辑写 activeLayerId:null，非空旧值只用于还原历史位置。`lastView` 只存 `{viewId}`；单机制最近打开使用单成员内联形式，旧多图内联状态只读保留直到明确保存或放弃。重开读最新来源，不保存合并副本；历史 compositions 仍校验，不删除或自动转换。
- 服务仅绑定回环地址；静态资源精确白名单。API 没有 session、Bearer 或 Origin 授权并支持跨源 JSON，仍校验 Host、JSON、路径、projectGeneration、整体/资源 revision 和锁。任何知道项目绝对路径且能访问本机端口的网页或进程都可能写入，只用于可信本机开发环境。不能通过直接打开 file:// 页面运行编辑器。
- 网页资源与 Schema 一样在 `startServer` 时一次性读入并固定（`src/server/http.mjs` 的 `servedAssets`）：进程启动后更新源码不会改变已经提供的内容，前端改动必须重启服务才能生效。`mech web` 遇到端口被占用时先请求 `POST /api/server/handoff`，让旧的 Mechanics 进程完成响应后自行关闭再重试绑定，旧版 Windows 进程由 `src/server/cli.mjs` 的 `terminateLegacyWindowsMechanics` 显式终止；1 秒内未释放端口以 `MECHANICS_HANDOFF_TIMEOUT` 失败，被非 Mechanics 进程占用的端口仍原样报 `EADDRINUSE`。因此新起的同端口实例会停掉先前的 Mechanics 服务，这是设计行为而非崩溃。
- Agent mutation 只允许概念 create/update/delete 与规则 add/update/delete，使用 definitions 或目标 mechanic 的资源 revision；在线模式还要求当前 projectGeneration。Agent 不能修改 `agentLocked`、视图、布局、机制元数据或工作区设置。锁定概念拒绝 Agent 修改/删除，写入后同队列发布 catalog；发布失败明确返回 canonical 是否已提交，调用方不得自动重试。
- `src/server/store.mjs` 负责单工作区进程锁、写入队列、整体 revision、候选引用校验和回读。revision 包含文件路径、原字节及目录集合，其他页自动保存视图也会使旧 revision 失效；受管工具目录 `.mechanics/tools` 是基础设施而非工作区语义，不计入文件树版本，否则一次后台资产同步会让正在编辑的草稿变成冲突。冲突保留草稿，不自动重试或强制覆盖。
- 已有文件通过同目录临时文件替换；新建以硬链接原子发布完整文件且拒绝同名覆盖。不支持该操作的文件系统明确失败；失败可能留下空目录，提交后回读失败报告结果待确认。
- 迁移是唯一的正文升级路径：`mech migrate --from <旧版本> --to <新版本>` 逐级预览后显式执行，`mech migrate-project --execute` 一次完成旧根、旧 skill 与协议的链式升级；不保留旧产品名、旧文件类型、旧后缀或旧 Schema。可自动升级的版本（v7–v12）只在打开项目时迁移；没有迁移路径的版本不会被当前协议改写文件。

## 验证边界

2026-08-31 的 `npm run check` 通过 44 项测试，包含视图文件/HTTP、ID、移动/revision、断引用、迁移、候选打开与失败队列，以及 0.4.0 单机制导航、旧记录和坐标接管、成员反向保存和显式折叠修复。0.4.0 通过 `npm run check:package`：31 个分发文件，Windows 隔离安装、命令 shim、资料子目录启动和静态模块成功；包不含 `.claw` 与游戏私有资料。后续版本须重新验收。

2026-09-07：`npm run check` 通过 360 项测试；`npm run check:package` 验证 74 个发行文件的隔离安装、CLI、内置 skill 注册、查询、离线/在线写入与网页服务。`game-graph@0.7.0` 已由 npm registry 回读，并以 `npx -y game-graph@0.7.0 --version` 独立验证为 `0.7.0`。发行流程见仓库根目录 `DISTRIBUTION.md`。

不承诺任意外部编辑器的原子 CAS、多文件事务、掉电恢复、网络共享盘或多人协作。未实现文件监听、跨文件撤销和相机持久化。测试只使用临时工作区，不写用户正式资料、不调用宿主游戏运行时。

实现入口：`src/server/workspace-commands.mjs`、`workspace.mjs`、`files.mjs`、`store.mjs` 和 `http.mjs`；操作见 `docs/CLI与工作区.md` 和 `docs/编辑器使用说明.md`。

<!-- state: history -->
## 演进历史

<!-- dated: 2026-09-23 -->
### 受管 skill 的冲突语义更正为整目录替换

2026-09-05 起，本文与 `docs/CLI与工作区.md` 把「同名 skill 内容不同」记成返回 `PROJECT_SKILL_CONFLICT` 且「绝不覆盖」，但同日落地的 `src/server/project-skills.mjs` 一直把内容不同或含过期附件的受管目录判为 `outdated` 并用安装包完整目录替换，`PROJECT_SKILL_CONFLICT` 只用于普通文件或符号链接占用路径。本次知识收尾按实现更正：`preflightProjectSkills` 在创建工作区前只做占用检查（`init` 经 `src/server/workspace-commands.mjs` 调用），`registerProjectSkills` 对 `missing` 与 `outdated` 目标用暂存目录 + 备份 + 原子改名替换，中途失败报 `PROJECT_SKILL_REGISTRATION_PARTIAL`。注册副本的维护归属与「整目录替换而非逐文件合并」的取舍见 ADR「受管 skill 的唯一维护源与注册副本」；项目内 `.agents/skills/` 不接受自定义修改。
