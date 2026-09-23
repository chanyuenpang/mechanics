# 版本说明

本仓库的发布记录。npm 包为 `@veewo/mechanics`（命令 `mech`），每个版本对应一个 Git tag；协议升级步骤与回滚方式见 [docs/更新与升级.md](docs/更新与升级.md)。

## 0.8.1 / dsh-mechanics 0.1.2 — 2026-09-23

- CLI 帮助中的工作区版本与迁移列表从当前协议和唯一迁移链生成，修正遗留 v11 文案与缺少的 v12→v13。
- DSH 图卡通过 `uiConversation.events` 注册聊天节点，监听当前 `tool/ptc-dispatch` 事件，并使用聊天节点的 `cwd` 请求图页面；独立插件依赖 Mechanics 0.8.1。
- 宿主验证改用认证首页声明的组合客户端脚本，分别检查插件路由和图页面，避免把旧单文件 URL 的 404 误认为未加载。
- 对话流图卡的实际页面呈现须在新版客户端加载后另行验收；工具执行与图页面成功不等于此项通过。

## 0.8.0 — 2026-09-23

> 对应提交 `a92524a`（tag `v0.8.0`），上一版为 0.7.11（`60f7388`）。
> 发布产物：91 个文件，`shasum 41a8407aa1112df0309f7a37b78042a59b6bccc4`，`integrity sha512-sDAlgnSqpdqStxdA6xnqU1idEYgjViy37VeG5FwH+wbWoRkjLnq+4NbNfLMj7E2JdjF+TCge2VTmag0RQc+Xjw==`。

### 不兼容变更

- 文件协议升级为**工作区 v13 / definitions v7 / rules v1 / 机制 v8 / 视图 v5**（原 v12 / v7 / v4）。
- 机制图与视图新增**必填**展示状态 `taxonomyPresentation: { "mode": "label", "expandedNodeIds": [] }`；读取路径不再为缺失字段补运行时默认值。
- `specializes`（is-a）收紧为**每个概念至多一个父概念**：同一 source 的第二条出边以 `SPECIALIZES_MULTIPLE_PARENTS` 失败，自连与成环继续以 `SPECIALIZES_SELF_LINK`、`SPECIALIZES_CYCLE` 失败。

### 旧版本自动升级

- **打开项目时，所有仍有迁移路径的旧工作区（v7–v12）会在创建 store 之前逐级「预览 → 执行」升级到 v13**：每一跳先全量读取与校验候选，再原子提交并回读；任何一跳失败都不写入文件，错误标明失败版本段（例如 `项目打开时的自动升级失败（v12 → v13）：…`）。
- 更早或未知版本仍按核心拓扑兼容模式**只读**打开，结构编辑返回 `COMPATIBILITY_READ_ONLY`；打开不会改写它们。
- 显式迁移继续可用：`mech migrate --from <旧版本> --to <新版本> --project <项目目录>`（默认只预览，执行需带预览返回的 `--revision --execute`）、`mech migrate-project --project <项目目录> --execute`（旧 `.game-graph` 根、旧 skill 与协议一次链式升级）。

### is-a 展示

- 默认隐藏 is-a 边，改为子节点内的只读 `is-a：父概念` 标签；概念详情新增「显示／隐藏 is-a 关系」。
- 展开时恢复该概念的直连父概念与一条虚线边（`stroke-dasharray: 6 4`）；收起后，仅由 is-a 引入且没有焦点或影响边理由的父概念退出渲染、布局与路由，canonical 数据不变。
- 展开状态按文件保存：单图归机制图、叠加归视图，切换后立即重算，撤销／重做与重开一致；落在投影之外的选择同时被清理。

### 架构与性能

- 新增 `src/domain/taxonomy-presentation.mjs`：`projectDisplayGraph` 成为画布、自动排版、路由缓存与几何签名的**唯一显示投影**；原先在 web 的 `structuralProjection` 下沉到 domain，服务端 Agent `mechanic arrange` 按同一规则投影后再排版。
- 打开或初始化项目后**后台同步**受管 skill 与 `.mechanics/tools/workspace-tool.mjs`，不阻塞网页；同步失败不阻断会话，可查询状态并重开重试。
- 受管工具目录 `.mechanics/tools` 不计入工作区文件树版本，避免一次后台同步把正在编辑的草稿变成 revision 冲突。
- 单机制打开与保存只读取目标文件；文档与导出设置读取复用打开快照，不再为一次导航重读整个工作区。

### 修复

- 补齐浏览器资源 `/domain/taxonomy-presentation.mjs`（缺失会让画布模块加载失败）。
- 修复降级工作区生成文档时对空 catalog 取字段导致的崩溃。
- 读取入口重新回读 canonical：外部修改与坏文件显式报错，不再返回旧快照。
- 项目内工作区工具（`workspace-tools/workspace-tool.mjs`）草稿校验同步到 v8 与单父协议。

### 验证

- `npm run check`：496 用例，494 通过、0 失败、2 个既有跳过。
- `npm run check:package`：91 个发行文件；隔离安装、CLI 启动、网页打开、只读查询/受约束写入、受管 skill 注册全部通过。
- 另以该 tarball 实测：把示例工作区降级为 v12 后打开，落盘升级为 v13、三份机制图全部为 v8、`compatibilityMode: false`。

## 历史版本

0.7.6 – 0.7.11 的发布提交（未逐版整理发布说明，需要时按提交查阅）：

| 版本 | 提交 | 主题 |
| --- | --- | --- |
| 0.7.6 | `85dfea6` | release: mechanics v0.7.6 |
| 0.7.7 | `673f103` | release: mechanics v0.7.7（并入《更新与升级》） |
| 0.7.8 | `ae631c1` | release: mechanics v0.7.8 |
| 0.7.9 | `42a5845` | release: mechanics v0.7.9 |
| 0.7.10 | `5c7cff5` | release: mechanics v0.7.10 |
| 0.7.11 | `60f7388` | fix: direct web project open |
| dsh-mechanics 0.1.1 | `0d56fd4` | release: dsh-mechanics v0.1.1（public 首次可见，独立于本包的 dsh-adapter） |

更早的 0.7.3 – 0.7.5 见 tag `v0.7.3`/`v0.7.4`/`v0.7.5`。
