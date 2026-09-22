# 逐概念 Agent 读模型

<!-- state: current -->
## 当前行为

- canonical `.mechanics/definitions.json`、`rules.json` 与 `.mechanic.json` 是唯一规则真相；workspace v13 的 `agentExportPath` 指向提交到版本库的 Markdown 生成读模型，默认 `mechanics`，不接受手工编辑。Agent 写入也只能走受约束 CLI mutation，不能直接编辑 canonical。
- `agentExportPath/README.md` 是无 CLI Agent 的默认入口；目录只生成 `AGENTS.md`、`README.md` 与 `concepts/<id>.md`，不再生成 manifest、index 或 JSON dossier。生成指南标识归属，不接管或删除未知内容。
- 概念 dossier 包含定义、aliases、tags、直接入边、直接出边、已填写的规则文字和条件；不包含 positions、view、端口、拐点或路线。
- semanticRevision 只由 workspace ID、概念语义和机制语义计算。几何、Agent 锁与视图变化不会改变生成文档内容；规则变化只改变相关概念文档。
- 保存 definitions 或 mechanic 后，store 在同一串行队列中发布读模型。发布失败时 Agent mutation 返回 `AGENT_EXPORT_FAILED` 与 `canonicalCommitted:true`、新资源版本，调用方先重读而不自动重试。
- `mech catalog` 持有工作区锁后完整重建并回读 canonical 验真。生成目录通过固定 AGENTS 指南识别所有权，缺失、过期或手改在下一次发布时恢复；未知文件使发布整体失败。
- CLI 是默认效率入口，不是 Agent 阅读能力的前置条件。只读分析使用 query；CLI 不可用时才读 `agentExportPath`。canonical 只用于精确核实来源，不作为手工编辑入口；view 不作为规则语义来源。

## 验证边界

2026-09-02：专项测试验证逐概念内容、几何不影响语义版本、规则变更的局部 dossier 失效、保存自动刷新、文件篡改失败；Tiny World 正式工作区的 22 个概念全部生成并通过逐文件哈希验证。
