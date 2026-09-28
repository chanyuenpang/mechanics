# DSH 适配器与对话图卡

<!-- state: current -->
## 当前行为

- `@veewo/dsh-mechanics` 将项目内 `.mechanics/tools/workspace-tool.mjs` 的只读检索与图投影注册为 `mechanics_search`、`mechanics_graph`；插件不复制 canonical 协议，host 工具路径委托项目工具，图页面只读项目数据，不写 canonical。项目侧工具须支持 `search --query` 模糊回退与 `graph --ids`（guide `contractVersion >= 5`）；旧副本须 `mech sync`，不静默降级。实现入口：`packages/dsh-adapter/src/index.mjs`、`src/workspace-tool.mjs`。
- 每次调用从宿主会话工作目录向上解析项目根；缺少目录或 `.mechanics/workspace.json` 明确失败（`SESSION_CWD_UNAVAILABLE`、`WORKSPACE_NOT_FOUND`）。不能把 Mechanics 工具仓库会话当作已初始化的游戏项目，也不能用图页面返回 200 代替聊天节点可见。
- 客户端 `packages/dsh-adapter/lib/client.js` 对原生 `mechanics_graph` 的 `tool/call` / `tool/result`，以及 Code Mode 根调用关联的成功 `tool/ptc-dispatch`（兼容 `tool/code-dispatch`）建立调用上下文。子派发没有 turn，须按 `rootCallId` 归到带轮次位置的根调用；失败或参数无效不产图卡。同一根调用的多个成功成图保留为独立 widget；每个 iframe 只接受与自身 `contentWindow` 匹配的高度通知，不串改其他图。独立 `mechanics-widget` 聊天节点锚定在工具结算序列之后，按会话 `cwd` 加载图页面；当前未插在 final 回复后，也没有使用 `conversation.chat.turnTail`。
- DSH 折叠过程区会隐藏其中的 widget，即使节点自身声明可见也不足以保证显示。可挂载的成功图卡通过聊天节点公开的 `turnProcess` 控制器，在 effect 中只对 `foldable === true` 且 `open === false` 的轮次调用 `setOpen(true)`；无有效图、无 `cwd` 或本就展开的轮次不触发。历史回放或手动重折叠后可再次展开，不依赖外部折叠插件。
- 验收须分别核实项目工具成功、PTC 完成事件、图页面可用、对话节点实际可见、折叠轮次展开，以及相对 final 回复的位置。2026-09-23 在两个已初始化项目验证真实图调用、完成事件和图页面，用户确认对话图卡可见；0.1.3 补丁版的折叠修复已通过真实 DSH 页面验收，相关回归覆盖折叠条件与同根多 widget。它不改变图卡不在 final 回复位置这一独立待解决问题；安装重启与项目初始化仍是不同前置条件。

实现与安装见 `packages/dsh-adapter/README.md`、`docs/安装与DSH接入.md`；图卡锚点取舍见 ADR「DSH 图卡按工具结算独立挂载」。
