# CLI 与稳定工作区

程序安装目录只拥有 CLI、网页、Schema 和通用示例。每个游戏独立拥有一个专用资料目录，目录可保存在该游戏的 Git 项目内；无需 claw-kit 或游戏运行时。

## 命令

```sh
game-rule-analyzer --help
game-rule-analyzer --version
game-rule-analyzer init ./game-analysis --name "我的游戏" --id my-game
game-rule-analyzer serve --workspace ./game-analysis --port 4319
game-rule-analyzer validate --workspace ./game-analysis
game-rule-analyzer root --workspace ./game-analysis
```

`init` 要求目标不存在、父目录已存在；不会覆盖空目录或在已有工作区中嵌套初始化。它生成 workspace v3、空定义图、`analyses/` 与运行态忽略规则。初始化途中失败报告已留下的目录，不自动删除用户可检查的文件。

`serve/validate/root` 可省略 `--workspace`，从 cwd 寻找最近父级标记。遇到坏标记立即报错，不越过它换用其他工作区。显式参数要求目标本身是工作区根，不再向上猜测。根通过 realpath 固定，打印在终端，也可悬停侧栏工作区名称查看；网页不能切换保存根。`root` 同时验证该工作区，错误资料不会伪装为可用。

`serve` 仅绑定 `127.0.0.1`，打印含随机会话片段的完整地址。浏览器用于编辑，CLI 用于启动、定位、初始化和校验；当前不是自动规则决策接口。端口 0 可让系统选择空闲端口。关闭终端服务会停止网页连接，正常 Ctrl+C 释放工作区锁。

不要双击 `src/web/index.html`：`file://` 没有本地文件 API 服务，绝对资源路径会解析到磁盘根，浏览器也会阻止模块跨来源加载。出现 `ERR_FILE_NOT_FOUND` 或 origin `null` 的 CORS 错误时，应改用 CLI 打印的完整 HTTP 网址，不关闭浏览器安全检查。服务重启生成新会话；旧页面须关闭后从新网址进入，不能只改网址片段而继续使用旧页面内存。

## 目录合同

```text
game-analysis/
├── workspace.json              身份、统一定义入口、组合及最近视图
├── definitions.graph.json      唯一概念定义，文件名由配置指定
├── analyses/                   新分析图的默认目录
│   └── basic.analysis.json
└── 关卡/
    ├── 首领.analysis.json
    └── 首领叠加.view.json
```

递归发现普通 `*.analysis.json` 和 `*.view.json`。侧栏按文件种类分区，视图置顶且没有勾选框，研究保留真实目录并支持折叠和筛选；分区不移动文件或建立第二份清单。隐藏条目与 `node_modules` 排除；其他后缀不作为规则或视图。服务发现普通目录包括空目录，侧栏不呈现空目录占位；共享定义从顶部概念表进入，配置不是导航项。读取或保存前扫描完整资料；任一坏图、坏视图、同类型重复 ID、跨工作区引用、失效引用、junction/符号链接或嵌套工作区都会阻止操作，不返回部分成功。文件 2 MiB、分析图与视图各 300 张、目录深度 24、可见目录项 10000 是当前限制。

文件名和目录不是图 ID。外部移动分析文件后点击「重新读取」，服务重建 `files: [{kind,id?,path}]`，稳定 ID 让既有叠加视图仍可定位该图。缺失来源则报错，不自动隐藏该层。没有文件监听或拖拽移动文件功能；不要在保存期间由其他程序并发改写。

## v1/v2 显式迁移到 v3

工作区配置为 v3，定义与视图为 v1，研究支持 v1/v2。旧 v1/v2 工作区配置必须显式迁移，不在启动时自动升级。研究文档 v2 是独立版本：已有 v1 研究首次增加包含才升级当前草稿，手动保存生效，不批量迁移。工作区迁移先用新 CLI 预检，再保存网页草稿、关闭旧服务执行。

```sh
game-rule-analyzer migrate --workspace ./game-analysis --dry-run
# 保存网页草稿并正常关闭旧服务后：
game-rule-analyzer migrate --workspace ./game-analysis
game-rule-analyzer validate --workspace ./game-analysis
```

预检不写锁或备份。v1 对比原登记集合与扫描集合；不同返回 blocked/退出码 1，须人工整理未登记图、旧后缀或排除目录。v2 已采用目录发现，无需伪造清单比较。两种版本都检查升级后会发现的视图文件，坏视图不能被忽略。

正式迁移取得工作区写入锁，验证旧资料和候选 v3，再复核字节、路径和目录 revision。独占创建 `workspace.v1.backup.json` 或 `workspace.v2.backup.json` 保存原配置字节；已有同名备份必须完全相同。v1 更新版本并移除 `analyses` 登记，v2 只更新版本。图与定义字节、历史 compositions 和内联 lastView 保留；不生成视图文件，不转换旧组合。回读后返回 migrated；有效 v3 重复执行返回 already-current 且不写入。提交后确认失败返回 SAVE_UNCERTAIN，不重放或回退。

异常退出后遗留锁不会自动抢占，必须先确认无写入服务。旧程序不理解视图文件和引用式 lastView；升级后已有新编辑时，不可直接覆盖配置回滚。备份用于人工核对和恢复，不能当作全工作区事务快照。

## 制作可安装包

在工具源码仓库运行：

```sh
npm ci
npm run check
npm run check:package
```

包验收先审查 dry-run 清单，再创建 `dist/game-rule-analyzer-0.5.2.tgz`，安装到临时前缀，运行命令 shim、帮助、版本、初始化、从资料子目录校验/启动及 HTTP 静态资源（包含视图模块）。隔离目录在服务退出后清理；不会全局安装到用户环境，不会执行 `npm publish`。依赖安装仍需要可用的 npm 缓存或依赖下载网络。

`private: true` 表示 npm 拒绝发布，不表示注册表中的私有访问设置。[npm private](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#private)。对外发布前还须明确可见性、使用授权、注册表和发布账号/scope；本地 tarball 准备不代表公开发布。包只含通用程序、Schema、文档和人工示例，不包含实际游戏的资料目录。
