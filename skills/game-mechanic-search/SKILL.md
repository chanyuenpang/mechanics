---
name: game-mechanic-search
description: 使用 Game-Graph CLI 只读查询项目已保存的抽象机制、概念、上下游与影响路径；适用于分析机制关系、寻找概念或核对模型覆盖，不用于创建、修改或删除概念与规则。
---

# 游戏机制只读查询

仅通过 `game-graph agent` 的只读子命令读取当前项目：

- 允许：`guide`、`scopes`、`search`、`graph`、`node`、`impact`。
- 禁止：`concept`、`rule`、任何 HTTP 写接口、直接修改 `.game-graph/` 或生成的机制文档，以及 `init`、`catalog`、`serve` 等会改变状态的命令。

## 工作流

1. 先运行 `game-graph agent guide --format text` 理解当前语义合同。
2. 在项目目录运行 `game-graph agent scopes`，或显式传 `--project <项目目录>`；选择稳定的机制或视图 ID，并记录 `revision`。
3. 不知道概念 ID 时先用 `search`；已知范围后用 `graph` 或 `node` 缩小关系；只有明确的起点与终点才用 `impact`。
4. 后续查询携带刚读取的 `--revision`。遇到版本冲突时重新读取，不复用旧结果。
5. 结论严格区分作者声明的规则、工具沿声明关系推导的影响，以及模型没有覆盖的未知项。条件约束包含在规则文字中，规则文字未被自动求值，路径不证明时序、强度、概率、胜率或运行时成立。

需要参数或字段说明时，运行 `game-graph --help` 与 `game-graph agent guide --format text`。CLI 不可用时明确报告，不能改用直接扫描 canonical 文件冒充同等查询。
