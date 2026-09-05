# 规则分析工具知识入口

<!-- state: current -->
## 当前知识归属

本仓库独立维护跨游戏工具的事实与决策；游戏规则资料和宿主接入记录由相应游戏项目持有。

- [抽象规则模型](features/abstract-rule-model.md)：概念身份、正负边、叠加、折叠和解释边界。
- [逐概念 Agent 读模型](features/agent-concept-catalog.md)：无 CLI 阅读入口、生成投影、语义版本与过期门禁。
- [CLI 与文件保存](features/cli-workspace-storage.md)：安装与资料分离、目录发现、版本、保存门禁及验证范围。
- [编辑器与图层](features/editor-navigation-and-layers.md)：概念表、机制图、草稿保存归属与最近视图。
- [可取消后台计算与打开事务](features/async-compute-and-opening-transaction.md)：Worker 路由/排版、结果门禁与真实打开进度。
- [独立工作流决策](adr/2026-08-31-independent-project-ownership.md)：源码、游戏资料与开发知识的归属。
- [独立视图文件决策](adr/2026-08-31-view-file-autosave.md)：自动写回、最近引用、失败草稿保护与显式 v3 迁移。
- [可取消 Worker 计算决策](adr/2026-09-01-cancellable-worker-compute.md)：计算生命周期、竞态门禁与打开事务。
- [语义 ID 与 Agent catalog 决策](adr/2026-09-02-semantic-ids-and-agent-catalog.md)：稳定身份、aliases、端点规则唯一与生成读模型。

操作说明和完整字段说明位于 `docs/`；Truth 记录当前事实，ADR 记录重要取舍。任务报告与成功提示本身不证明知识文档已经更新。
