# Mechanics 安装与 Codex 接入

本页是当前 `@veewo/mechanics` 的安装、项目初始化与 Codex MCP 配置入口。历史 `game-graph` 命令和 `.game-graph` 路径不适用于此页。

## 安装与初始化

需要 Node.js 24 或更高版本。

```powershell
npm install -g @veewo/mechanics
mech init <项目目录> --name <项目名称> --id <稳定项目ID>
```

`init` 创建项目内 `.mechanics` 工作区，并安装受管的 `mechanics-search`、`mechanics-modeling` 与 `mechanics-doc` skills。之后在目标项目目录运行 `mech sync`，或通过 Mechanics 网页打开该项目，都会将这些受管 skill 更新为当前已安装包的版本。

## 启动网页编辑器

在项目目录中启动，并让 CLI 自动向上定位该项目的 `.mechanics`：

```powershell
mech web
```

也可以从任意目录明确指定项目与端口：

```powershell
mech web --project <项目目录> --port 4319
```

浏览器打开 CLI 输出的本地地址。省略 `--project` 时，网页以空项目状态启动；可在网页中打开或初始化项目。网页只允许打开已通过工作区校验的项目。

## 配置 Codex MCP Apps

在目标项目的 `.codex/config.toml` 中加入：

```toml
[mcp_servers.mechanics-render]
command = "mech"
args = ["mcp", "render"]
cwd = "<包含 .mechanics 的项目绝对路径>"
startup_timeout_sec = 20
tool_timeout_sec = 60
```

重启 Codex 后，工具名为 `mechanics_render_concepts`。它只接收已经消歧的稳定概念 ID，不接收项目路径：

```ts
mechanics_render_concepts({ conceptIds: ["stamina", "dodge", "damage"] })
```

服务在启动时按 `cwd` 向上定位并固定 `.mechanics` 工作区；修改配置中的 `cwd` 后必须重启 Codex。工具调用成功、收到结构化结果、以及宿主实际显示 widget 分别验证。

## 继续阅读

- MCP widget 合同与兼容性：`Codex MCP Apps.md`
- 查询与受约束写入：`Agent查询接口.md`
- 文件格式与版本：`文件协议.md`
- 架构、路径与安全边界：`架构设计.md`
