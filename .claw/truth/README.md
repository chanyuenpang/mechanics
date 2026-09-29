# 规则分析工具知识入口

<!-- state: current -->
## 当前知识归属

本仓库独立维护跨游戏工具的事实与决策；游戏规则资料和宿主接入记录由相应游戏项目持有。

- [抽象规则模型](features/abstract-rule-model.md)：概念身份、正负边、叠加、折叠和解释边界。
- [逐概念 Agent 读模型](features/agent-concept-catalog.md)：无 CLI 阅读入口、生成投影、语义版本与过期门禁。
- [CLI 与文件保存](features/cli-workspace-storage.md)：安装与资料分离、目录发现、产品/协议版本、保存门禁及验证范围。
- [DSH 适配器与对话图卡](features/dsh-adapter-and-chat-widget.md)：项目工具版本、会话工作区定位、图卡挂载与分层验收。
- [编辑器与图层](features/editor-navigation-and-layers.md)：概念表、机制图、草稿保存归属与最近视图。
- [可取消后台计算与打开事务](features/async-compute-and-opening-transaction.md)：Worker 路由/排版、结果门禁与真实打开进度。
- [端点限定词投影](features/endpoint-qualifier-projection.md)：规则的参与者范围、限定投影身份与「基础实例何时隐藏」。
- [读取图端点完整性](features/read-graph-integrity.md)：投影边界、节点与端点不变量，以及失败布局事务。
- [正交路由质量硬合同](features/routing-quality-hard-contract.md)：质量向量与裁决顺序、按构造拒绝硬违规、规模回归断言。
- [独立工作流决策](adr/2026-08-31-independent-project-ownership.md)：源码、游戏资料与开发知识的归属。
- [独立视图文件决策](adr/2026-08-31-view-file-autosave.md)：自动写回、最近引用、失败草稿保护与显式 v3 迁移。
- [可取消 Worker 计算决策](adr/2026-09-01-cancellable-worker-compute.md)：计算生命周期、竞态门禁与打开事务。
- [语义 ID 与 Agent catalog 决策](adr/2026-09-02-semantic-ids-and-agent-catalog.md)：稳定身份、aliases、端点规则唯一与生成读模型。
- [is-a 单父与展示状态决策](adr/2026-09-22-is-a-single-parent-and-presentation-state.md)：单父分类不变量、显式展开状态与唯一的显示投影。
- [is-a 父概念选择决策](adr/2026-09-23-is-a-parent-picker-and-search.md)：可检索选择器、后代方向与清除语义。
- [概念编辑对话框定宽与动作行决策](adr/2026-09-23-concept-dialog-width-and-action-ownership.md)：宽度上下界的依据与动作行归属。
- [限定投影与画布孤点决策](adr/2026-09-23-qualifier-projection-replaces-nodes.md)：基础实例的隐藏条件与「无规则成员不得凭空消失」。
- [读取图完整性归属决策](adr/2026-09-29-domain-read-graph-integrity-boundary.md)：领域统一断言与布局边界复核。
- [受管 skill 维护源与注册副本决策](adr/2026-09-23-managed-skills-single-source-and-registration.md)：包内唯一维护源、整目录替换与冲突边界。
- [原子影响建模边界决策](adr/2026-09-28-atomic-influence-modeling-boundary.md)：先识别影响，条件留在规则文字，保留独立机制职责。
- [DSH 图卡工具结算锚点决策](adr/2026-09-23-dsh-widget-tool-settlement-anchor.md)：根调用关联、独立节点与 final 位置的未解决边界。
- [发布后本机正式包决策](adr/2026-09-28-release-local-registry-package-boundary.md)：registry 版本、源码 link 禁止、重启授权与分层验收。

操作说明和完整字段说明位于 `docs/`；Truth 记录当前事实，ADR 记录重要取舍。任务报告与成功提示本身不证明知识文档已经更新。
