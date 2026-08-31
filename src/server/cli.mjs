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
    const { close, url } = await startServer({ workspaceRoot: values.workspace, port });
    console.log(`游戏规则分析工具 · 节点编辑器\n${url}\n保存目标：${values.workspace}\n关闭服务后释放工作区写入锁。`);
    const shutdown = () => close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
} catch (error) {
  console.error(`${error.code ?? 'START_FAILED'}：${error.message}`);
  process.exitCode = 1;
}
