# Codex MCP Apps 局部机制图

`mech mcp render` 启动一个 stdio MCP server。它在**启动时**从当前目录向上定位最近的 `.mechanics/workspace.json`，并固定该工作区；工具调用只有 `conceptIds`，没有 `projectRoot`、文件路径或其他读取参数。

将以下服务配置到 Codex，并把工作目录设为目标游戏项目或其 `.mechanics` 子目录。Codex 项目配置使用 `.codex/config.toml`：

```toml
[mcp_servers.mechanics-render]
command = "mech"
args = ["mcp", "render"]
cwd = "<包含 .mechanics 的项目绝对路径>"
startup_timeout_sec = 20
tool_timeout_sec = 60
```

通用 MCP 客户端可使用等价 JSON：

```json
{
  "mcpServers": {
    "mechanics-render": {
      "command": "mech",
      "args": ["mcp", "render"],
      "cwd": "<包含 .mechanics 的游戏项目目录>"
    }
  }
}
```

调用合同：

```ts
mechanics_render_concepts({ conceptIds: ["stamina", "dodge", "damage"] })
```

输入必须是非空且无重复的稳定概念 ID 数组。不存在、重复或空白 ID 返回 `isError: true` 以及 `{ error: { code, message, details } }`；不会搜索、纠错、补节点或忽略输入。

成功时面向对话的文本仅为“渲染成功。”；完整图数据仍保留在 `structuredContent`，包括所有请求节点、仅端点都在请求集合中的声明关系、自动排版坐标，以及关系的影响类型、方向、限定词、规则文字和来源机制。支持 MCP Apps 的宿主会加载单一 `ui://mechanics/concepts-graph.html`。它复用网页端的节点、关系投影、自动布局和 hover 详情领域模型，并以隔离的只读画布呈现同一视觉语义：节点、箭头、缩放/平移和 hover 详情；页面没有标题栏、图例、编辑、搜索、路径推理或网络访问。单资源形式避免宿主未加载额外 `ui://` 脚本或样式资源时留下空白 widget。

不支持 MCP Apps 的宿主仍可直接使用完整 `structuredContent`。不同宿主对 MCP Apps 的协商、iframe 与 widget 展示支持仍需在实际 Codex 版本中连通验证。
