---
name: mechanics-doc
description: 查阅 Mechanics 产品与接入文档；用于安装或升级 CLI、配置 Codex MCP/widget、工作区接入、命令用法、协议与接入故障排查，不用于查询或修改机制规则。
---

# Mechanics 文档导航

根据用户目标只读相关文档；不要把全部参考资料一次加载。

- 安装、升级、初始化项目、Codex MCP 配置或 widget 验证：阅读 [安装与 Codex 接入](references/安装与Codex接入.md)。
- 在 DeepSeek Harness（DSH）里安装插件、用工具或 widget、排障与卸载：阅读 [安装与 DSH 接入](references/安装与DSH接入.md)。
- 工具输入输出与 Agent 查询合同：阅读 [Agent 查询接口](references/Agent查询接口.md)。
- 文件版本、canonical 资料或迁移边界：阅读 [文件协议](references/文件协议.md)。
- 架构职责、工作区路径和安全边界：阅读 [架构设计](references/架构设计.md)。

项目内的 references 是当前 Mechanics 安装包在项目打开时同步的只读文档快照；“最新”只指该已安装版本，不表示已联网升级。CLI 不存在时仍可阅读这些文档；若 CLI 可用，可以用 `mech --version` 和 `mech --help` 核对本机事实。

需要概念搜索、消歧或关系查询时使用 `mechanics-search`；用户明确要求创建、修改或删除概念/规则时使用 `mechanics-modeling`。本 skill 不执行这些操作。

MCP 配置成功、工具调用成功和宿主实际显示 widget 是三个独立结果；排障时分别核实，不能以前一项代替后一项。

在 DSH 里，插件工具与项目内脚本读同一份 JSON 契约：装了插件优先用 `mechanics_search` / `mechanics_graph`（图只在后者产生），否则用 `node <项目>/.mechanics/tools/workspace-tool.mjs`。
