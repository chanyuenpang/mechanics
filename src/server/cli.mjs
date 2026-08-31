import { parseArgs } from 'node:util';
import { readWorkspace } from './workspace.mjs';
import { startServer } from './http.mjs';

try {
  const { positionals, values } = parseArgs({
    options: { workspace: { type: 'string' }, port: { type: 'string' } }, allowPositionals: true,
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !['serve', 'validate'].includes(command)) throw new Error('用法：node src/server/cli.mjs serve|validate --workspace <目录> [--port 4319]');
  if (!values.workspace) throw new Error('必须通过 --workspace 指定分析文件目录');
  if (command === 'validate') {
    const data = await readWorkspace(values.workspace);
    console.log(JSON.stringify({ ok: true, workspaceId: data.manifest.id, nodes: data.definitions.nodes.length, analyses: data.analyses.length, revision: data.revision }, null, 2));
  } else {
    const port = Number(values.port ?? 4319);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0–65535 的整数');
    const { server, url } = await startServer({ workspaceRoot: values.workspace, port });
    console.log(`游戏规则分析工具 · 只读骨架\n${url}\n分析文件仅读取，不会保存或修改。`);
    const close = () => server.close(() => process.exit(0));
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
} catch (error) {
  console.error(`${error.code ?? 'START_FAILED'}：${error.message}`);
  process.exitCode = 1;
}
