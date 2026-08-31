# CLI、工作区与文件保存

<!-- state: current -->
## 当前行为

- Node.js 24+ 本地 CLI 提供 `init/serve/validate/root/migrate`。源码和本地 tarball 独立于游戏引擎、宿主资产和 claw-kit；`private: true`，没有公开 npm 发布或开源授权。
- 工具安装目录拥有程序、Schema、文档与人工示例；每个游戏单独拥有分析资料。`init` 只创建明确指定、尚不存在的目录，不覆盖已有目录。
- 显式 `--workspace` 必须指向根，优先于向上查找；省略时寻找最近 `workspace.json`。遇到坏标记明确失败，不越过它使用父工作区。启动后固定 realpath，网页不能换根。
- 工作区配置为 v3，定义、分析和视图文档为 v1。目录递归发现普通 `*.analysis.json`、`*.view.json`；不保存第二份清单。隐藏条目与 node_modules 排除，普通目录包括空目录参与发现。服务内存 `files` 按 `(kind,id)` 对应当前路径；两种文件可同 ID，移动后重读可定位。
- 唯一定义入口由 `workspace.json.definitions` 指定。拒绝路径穿越、内部符号链接/junction、嵌套工作区、坏 JSON、重复 ID、未知版本与断引用，不能返回部分成功。
- 命名视图 `.view.json` 保存可见图 ID、编辑层、折叠与组合位置；`lastView` 只存 `{viewId}`。未命名浏览的 lastView 才使用内联选择，两种形式互斥。重开按最新源文件组成，不保存合并副本。历史 compositions 仍校验、不删除、不自动转成视图文件。
- 服务仅绑定回环地址；静态资源精确白名单，API 需会话 token，写入需同源 Origin 和 JSON。不能通过直接打开 file:// 页面运行编辑器，不关闭浏览器安全检查。
- `src/server/store.mjs` 负责单工作区进程锁、写入队列、整体 revision、候选引用校验和回读。revision 包含文件路径、原字节及目录集合，其他页自动保存视图也会使旧 revision 失效。冲突保留草稿，不自动重试或强制覆盖。
- 已有文件通过同目录临时文件替换；新建以硬链接原子发布完整文件且拒绝同名覆盖。不支持该操作的文件系统明确失败；失败可能留下空目录，提交后回读失败报告结果待确认。
- v1/v2 到 v3 迁移必须显式执行。v1 对比旧清单与扫描集合，集合不等拒绝；v2 保持目录发现。两者预检包含潜在视图文件。正式迁移持锁并按原版本备份 manifest，只更新版本（v1 另移除登记清单），不改图或定义字节。有效 v3 再次迁移不写入。

## 验证边界

2026-08-31 的 `npm run check` 通过 38 项测试，新增视图文件/HTTP 边界、独立 ID、移动与 revision、缺失引用、v2 备份迁移、最新候选打开、创建部分完成、写入响应丢失和队列暂停。0.3.0 已通过 `npm run check:package`：31 个分发文件，Windows 隔离安装、命令 shim、资料子目录启动与全部静态模块成功；包不含 `.claw` 和游戏私有资料。后续版本仍须重新验收。

不承诺任意外部编辑器的原子 CAS、多文件事务、掉电恢复、网络共享盘或多人协作。未实现文件监听、跨文件撤销和相机持久化。测试只使用临时工作区，不写用户正式资料、不调用宿主游戏运行时。

实现入口：`src/server/workspace-commands.mjs`、`workspace.mjs`、`files.mjs`、`store.mjs` 和 `http.mjs`；操作见 `docs/CLI与工作区.md` 和 `docs/编辑器使用说明.md`。
