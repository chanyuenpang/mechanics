# ADR：语义 ID、别名与逐概念 Agent 读模型

<!-- state: accepted -->
## 决策

- canonical 概念、机制、视图和规则使用稳定的英文语义 kebab-case ID；运行时 session、锁 owner 和临时文件仍可使用随机身份。
- 概念 `aliases` 保存自然语言同义词、旧语义名和跨语言叫法。别名不遮蔽任何 canonical 概念 ID；一个别名可命中多个概念，搜索返回全部候选。
- 整个工作区同一有向端点对只允许一条规则，规则 ID 为 `<source>-2-<target>`。关系类型和正负号不进入身份，以便规则属性变化时保持引用稳定。
- 不双写第二份可编辑规则。工具从 canonical definitions/mechanics 生成并提交 workspace v7 `agentExportPath` 指定的 catalog v4 Markdown-only 目录，供没有 CLI 的 Agent 按概念阅读；读模型排除所有几何、Agent 锁与视图状态。
- 读模型用固定生成指南识别归属，并通过 canonical semanticRevision 判断是否需要重建；不再发布 manifest/index/JSON。生成失败必须显式暴露；Agent mutation 若已提交 canonical，明确返回该事实和新资源版本。

## 理由

随机长 ID 阻碍人和 Agent 理解、搜索与引用；把关系类型写入规则 ID 会让普通属性修改变成身份迁移。逐概念文档减少一次读取中的无关噪音，同时保留原始文件阅读能力，不把 CLI 变成唯一入口。生成投影避免 canonical 双写分叉，哈希门禁阻止旧文档被误当当前事实。

## 后果

现有正式资料必须一次性迁移全部概念、机制、视图、规则和引用，并重建 `agentExportPath`。UUID 不保留为 aliases；只有仍有检索意义的自然语言或旧语义名进入 aliases。人类通过网页编辑，Agent 通过受约束 CLI mutation；不得直接编辑 canonical 或生成目录。
