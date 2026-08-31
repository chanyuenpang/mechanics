#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import metadata from '../../package.json' with { type: 'json' };
import { readWorkspace } from './workspace.mjs';
import { findWorkspace, initWorkspace, migrateWorkspace } from './workspace-commands.mjs';
import { startServer } from './http.mjs';

const usage = `游戏规则分析工具 ${metadata.version} · 本地 JSON 工作区

game-rule-analyzer init <新目录> [--name <名称>] [--id <稳定ID>]
game-rule-analyzer serve [--workspace <目录>] [--port 4319]
game-rule-analyzer validate [--workspace <目录>]
game-rule-analyzer root [--workspace <目录>]
game-rule-analyzer migrate --workspace <目录> [--dry-run]
game-rule-analyzer --help | --version

serve / validate / root 省略 --workspace 时，从当前目录向上寻找最近的 workspace.json。
显式目录优先；一次服务固定一个根，文件始终保存到该根内。
init 不覆盖已有目录；migrate 须关闭旧服务，预检不写文件。
需要 Node.js 24+。不上传分析资料，也不自动公开发布。`;

try {
  const { positionals, values } = parseArgs({ options: {
    workspace: { type: 'string' }, port: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' },
    'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  }, allowPositionals: true });
  const [command, target] = positionals;
  if (values.help || (!command && !Object.keys(values).length)) console.log(usage);
  else if (values.version && !command && Object.keys(values).length === 1) console.log(metadata.version);
  else {
    const allowed = { init: ['name', 'id'], serve: ['workspace', 'port'], validate: ['workspace'], root: ['workspace'], migrate: ['workspace', 'dry-run'] };
    if (!allowed[command] || positionals.length !== (command === 'init' ? 2 : 1)) throw new Error('命令或参数数量无效，请运行 --help。');
    for (const option of Object.keys(values)) if (!allowed[command].includes(option)) throw new Error(command + ' 不支持 --' + option);
    if (command === 'init') console.log(JSON.stringify(await initWorkspace(target, { name: values.name, id: values.id }), null, 2));
    else {
      if (command === 'migrate' && !values.workspace) throw new Error('migrate 必须显式指定 --workspace，不能推断迁移目标。');
      if (values.workspace === '') throw new Error('--workspace 不能为空');
      const root = values.workspace !== undefined ? await realpath(resolve(values.workspace)) : await findWorkspace();
      if (command === 'migrate') {
        const result = await migrateWorkspace(root, { dryRun: values['dry-run'] });
        console.log(JSON.stringify(result, null, 2));
        if (result.status === 'blocked') process.exitCode = 1;
      } else {
        const data = await readWorkspace(root);
        if (command === 'root') console.log(root);
        else if (command === 'validate') console.log(JSON.stringify({ ok: true, root, workspaceId: data.manifest.id, nodes: data.definitions.nodes.length, analyses: data.analyses.length, views: data.views.length, revision: data.revision }, null, 2));
        else {
          const rawPort = values.port ?? '4319', port = Number(rawPort);
          if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port > 65535) throw new Error('端口必须是 0–65535 的整数');
          const { close, url } = await startServer({ workspaceRoot: root, port });
          console.log(`游戏规则分析工具 · ${data.manifest.name}\n${url}\n保存目标：${root}\n关闭服务后释放工作区写入锁。`);
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
  }
} catch (error) {
  console.error(`${error.code ?? 'COMMAND_FAILED'}：${error.message}`);
  process.exitCode = 1;
}
