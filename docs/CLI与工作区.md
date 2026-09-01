# CLI 与稳定工作区

程序安装目录只拥有 CLI、网页、Schema 和通用示例。每个游戏独立拥有一个专用资料目录，目录可保存在该游戏的 Git 项目内；无需 claw-kit 或游戏运行时。

## 命令

```sh
game-graph --help
game-graph --version
game-graph init ./game-mechanic --name "我的游戏" --id my-game
game-graph serve --workspace ./game-mechanic --port 4319
game-graph validate --workspace ./game-mechanic
game-graph root --workspace ./game-mechanic
```

`init` 要求目标不存在、父目录已存在；不会覆盖空目录或在已有工作区中嵌套初始化。它生成 Game-Graph workspace v4、空定义图、`mechanics/` 与运行态忽略规则。初始化途中失败报告已留下的目录，不自动删除用户可检查的文件。

`serve/validate/root` 可省略 `--workspace`，从 cwd 寻找最近父级标记。遇到坏标记立即报错，不越过它换用其他工作区。显式参数要求目标本身是工作区根，不再向上猜测。根通过 realpath 固定，打印在终端，也可悬停侧栏工作区名称查看；网页不能切换保存根。`root` 同时验证该工作区，错误资料不会伪装为可用。

`serve` 仅绑定 `127.0.0.1`，打印含随机会话片段的完整地址。浏览器用于编辑，CLI 用于启动、定位、初始化和校验；当前不是自动规则决策接口。端口 0 可让系统选择空闲端口。关闭终端服务会停止网页连接，正常 Ctrl+C 释放工作区锁。

不要双击 `src/web/index.html`：`file://` 没有本地文件 API 服务，绝对资源路径会解析到磁盘根，浏览器也会阻止模块跨来源加载。出现 `ERR_FILE_NOT_FOUND` 或 origin `null` 的 CORS 错误时，应改用 CLI 打印的完整 HTTP 网址，不关闭浏览器安全检查。服务重启生成新会话；旧页面须关闭后从新网址进入，不能只改网址片段而继续使用旧页面内存。

## 目录合同

```text
game-mechanic/
├── workspace.json              身份、统一定义入口、组合及最近视图
├── definitions.graph.json      唯一概念定义，文件名由配置指定
├── mechanics/                   新机制图的默认目录
│   └── basic.mechanic.json
└── 关卡/
    ├── 首领.mechanic.json
    └── 首领叠加.view.json
```

递归发现普通 `*.mechanic.json` 和 `*.view.json`。侧栏按文件种类分区，视图置顶且没有勾选框，机制保留真实目录并支持折叠和筛选；分区不移动文件或建立第二份清单。隐藏条目与 `node_modules` 排除；其他后缀不作为规则或视图。服务发现普通目录包括空目录，侧栏不呈现空目录占位；共享定义从顶部概念表进入，配置不是导航项。读取或保存前扫描完整资料；任一坏图、坏视图、同类型重复 ID、跨工作区引用、失效引用、junction/符号链接或嵌套工作区都会阻止操作，不返回部分成功。文件 2 MiB、机制图与视图各 300 张、目录深度 24、可见目录项 10000 是当前限制。

文件名和目录不是图 ID。外部移动机制文件后点击「重新读取」，服务重建 `files: [{kind,id?,path}]`，稳定 ID 让既有叠加视图仍可定位该图。缺失来源则报错，不自动隐藏该层。没有文件监听或拖拽移动文件功能；不要在保存期间由其他程序并发改写。

## 正式协议边界

工作区固定为 v4，定义和机制固定为 v1，视图固定为 v2。机制边必须显式声明 `relation`；影响边另有 `sign`，包含边禁止 `sign`。CLI 不提供 view v1 或其他旧格式迁移与兼容读取，发现旧工作区、旧后缀或旧字段时明确失败。需要转换历史资料时，应由拥有该资料的项目在一次受控改动中直接重写并校验，不能让运行服务猜测旧语义。

## 制作可安装包

在工具源码仓库运行：

```sh
npm ci
npm run check
npm run check:package
```

包验收先审查 dry-run 清单，再创建 `dist/game-graph-0.6.0.tgz`，安装到临时前缀，运行命令 shim、帮助、版本、初始化、从资料子目录校验/启动及 HTTP 静态资源（包含视图模块）。隔离目录在服务退出后清理；不会全局安装到用户环境，不会执行 `npm publish`。依赖安装仍需要可用的 npm 缓存或依赖下载网络。

`private: true` 表示 npm 拒绝发布，不表示注册表中的私有访问设置。[npm private](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#private)。对外发布前还须明确可见性、使用授权、注册表和发布账号/scope；本地 tarball 准备不代表公开发布。包只含通用程序、Schema、文档和人工示例，不包含实际游戏的资料目录。
