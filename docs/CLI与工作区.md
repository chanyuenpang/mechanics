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

`init` 要求目标不存在、父目录已存在；不会覆盖空目录或在已有工作区中嵌套初始化。它生成 workspace v2、空定义图、`analyses/` 与运行态忽略规则。初始化途中失败报告已留下的目录，不自动删除用户可检查的文件。

`serve/validate/root` 可省略 `--workspace`，从 cwd 寻找最近父级标记。遇到坏标记立即报错，不越过它换用其他工作区。显式参数要求目标本身是工作区根，不再向上猜测。根通过 realpath 固定，打印在终端与侧栏；网页不能切换保存根。`root` 同时验证该工作区，错误资料不会伪装为可用。

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
    └── 首领.analysis.json
```

递归发现全部普通 `*.analysis.json`。隐藏目录/文件与 `node_modules` 排除；其他扩展名文件不作为规则编辑。侧栏显示配置、统一定义、分析图及普通目录，包括空目录。读取或保存前扫描完整资料；任一坏图、重复 ID、跨工作区引用、失效视图、junction/符号链接或嵌套工作区都会阻止操作，不返回部分成功。文件 2 MiB、图 300 张、目录深度 24、可见目录项 10000 是当前限制。

文件名和目录不是图 ID。外部移动分析文件后点击「重新读取」，服务重建 `files: [{kind,id?,path}]`，稳定 ID 让既有叠加视图仍可定位该图。缺失来源则报错，不自动隐藏该层。没有文件监听或拖拽移动文件功能；不要在保存期间由其他程序并发改写。

## v1 显式迁移

工作区配置升级为 v2，定义与分析文档仍是 v1。不能直接以 v2 服务打开旧工作区，也不会启动时偷偷升级。

```sh
game-rule-analyzer migrate --workspace ./game-analysis --dry-run
# 保存网页草稿并正常关闭旧服务后：
game-rule-analyzer migrate --workspace ./game-analysis
game-rule-analyzer validate --workspace ./game-analysis
```

预检不写锁或备份，报告原登记集合、扫描集合与差异；集合不同返回 blocked/退出码 1。未登记草稿、旧图不符合 `.analysis.json` 命名或旧图位于排除目录，都需要人工整理后再次预检。初版不自动纳入、移动或重命名旧图。

正式迁移取得与旧服务相同的写入锁，验证原资料及候选 v2，再复核全部字节、路径和目录 revision。独占创建 `workspace.v1.backup.json` 保存原配置字节；已有同名备份必须完全相同。仅更新 `workspace.json` 的版本并移除 `analyses` 登记字段，图与定义字节、组合与 lastView 保留。回读完整工作区后才返回 migrated；再次执行有效 v2 返回 already-current，未写入。提交后确认失败返回 SAVE_UNCERTAIN，不自动重放或回退。

异常退出后遗留锁不会自动抢占，必须先确认无写入服务。离线恢复旧备份只适用于 v2 尚未发生后续编辑的情况，否则旧清单可能丢失新文件成员，不能直接覆盖回滚。

## 制作可安装包

在工具源码仓库运行：

```sh
npm ci
npm run check
npm run check:package
```

包验收先审查 dry-run 清单，再创建 `dist/game-rule-analyzer-0.2.0.tgz`，安装到临时前缀，运行命令 shim、帮助、版本、初始化、从资料子目录校验/启动及 HTTP 静态资源。隔离目录在服务退出后清理；不会全局安装到用户环境，不会执行 `npm publish`。依赖安装仍需要可用的 npm 缓存或依赖下载网络。

`private: true` 表示 npm 拒绝发布，不表示注册表中的私有访问设置。[npm private](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#private)。对外发布前还须明确可见性、使用授权、注册表和发布账号/scope；本地 tarball 准备不代表公开发布。包只含通用程序、Schema、文档和人工示例，不包含实际游戏的资料目录。
