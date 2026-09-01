#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import metadata from '../../package.json' with { type: 'json' };
import { readWorkspace } from './workspace.mjs';
import { findWorkspace, initWorkspace } from './workspace-commands.mjs';
import { startServer } from './http.mjs';
import { runAgent } from './agent.mjs';

const usage = `Game-Graph ${metadata.version} · 本地 JSON 工作区

game-graph init <新目录> [--name <名称>] [--id <稳定ID>]
game-graph serve [--workspace <目录>] [--port 4319]
game-graph validate [--workspace <目录>]
game-graph root [--workspace <目录>]
game-graph agent guide [--format text]（无需工作区，先读语义约定）
game-graph agent scopes [--workspace <目录>]
game-graph agent search --query <关键词> [--mechanic <ID> | --view <ID>] [--limit 30]
game-graph agent graph --mechanic <ID> | --view <ID>
game-graph agent node --mechanic <ID> --id <概念ID> [--direction both] [--hops 1]
game-graph agent impact --mechanic <ID> --from <ID> --to <ID>
  agent 通用：--workspace <目录> 或 --connect http://127.0.0.1:<端口>
  在线凭据：GAME_GRAPH_SESSION_TOKEN 环境变量；不会自动连接或回退到磁盘。
  --format json|text --revision <版本>；图：--max-nodes 500 --max-edges 2000
  影响：--max-paths 50 --max-depth 16 --max-expansions 10000 --evidence-limit 10
game-graph --help | --version

serve / validate / root 省略 --workspace 时，从当前目录向上寻找最近的 workspace.json。
显式目录优先；一次服务固定一个根，文件始终保存到该根内。
init 不覆盖已有目录；不读取旧版工作区或旧文件类型。
需要 Node.js 24+。不上传分析资料，也不自动公开发布。`;

try {
  const { positionals, values } = parseArgs({ options: {
    workspace: { type: 'string' }, port: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    ...Object.fromEntries(['connect', 'format', 'mechanic', 'view', 'revision', 'direction', 'hops', 'query', 'limit', 'from', 'to', 'max-paths', 'max-depth', 'max-expansions', 'max-nodes', 'max-edges', 'evidence-limit'].map(key => [key, { type: 'string' }])),
  }, allowPositionals: true });
  const [command, target] = positionals;
  if (values.help || (!command && !Object.keys(values).length)) console.log(usage);
  else if (values.version && !command && Object.keys(values).length === 1) console.log(metadata.version);
  else if (command === 'agent') {
    if (positionals.length !== 2) throw new Error('agent 需要且只接受一个子命令');
    console.log(await runAgent(target, values));
  }
  else {
    const allowed = { init: ['name', 'id'], serve: ['workspace', 'port'], validate: ['workspace'], root: ['workspace'] };
    if (!allowed[command] || positionals.length !== (command === 'init' ? 2 : 1)) throw new Error('命令或参数数量无效，请运行 --help。');
    for (const option of Object.keys(values)) if (!allowed[command].includes(option)) throw new Error(command + ' 不支持 --' + option);
    if (command === 'init') console.log(JSON.stringify(await initWorkspace(target, { name: values.name, id: values.id }), null, 2));
    else {
      if (values.workspace === '') throw new Error('--workspace 不能为空');
      const root = values.workspace !== undefined ? await realpath(resolve(values.workspace)) : await findWorkspace();
      const data = await readWorkspace(root);
      if (command === 'root') console.log(root);
      else if (command === 'validate') console.log(JSON.stringify({ ok: true, root, workspaceId: data.manifest.id, nodes: data.definitions.nodes.length, mechanics: data.mechanics.length, views: data.views.length, revision: data.revision }, null, 2));
      else {
          const rawPort = values.port ?? '4319', port = Number(rawPort);
          if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port > 65535) throw new Error('端口必须是 0–65535 的整数');
          const { close, url } = await startServer({ workspaceRoot: root, port });
          console.log(`Game-Graph · ${data.manifest.name}\n${url}\n保存目标：${root}\n关闭服务后释放工作区写入锁。`);
          let stopping = false;
          const shutdown = () => {
            if (stopping) return;
            stopping = true;
            close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
          };
          process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
      }
    }
  }
} catch (error) {
  if (process.argv[2] === 'agent') console.error(JSON.stringify({ error: error.code ?? 'COMMAND_FAILED', message: error.message }));
  else console.error(`${error.code ?? 'COMMAND_FAILED'}：${error.message}`);
  process.exitCode = 1;
}
