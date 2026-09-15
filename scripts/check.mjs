import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readWorkspace } from '../src/server/workspace.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// packages/ 下的独立发布包同样进入语法检查：它们不在任何 bundle 里，语法错误只能靠这里拦住。
for (const directory of ['src', 'scripts', 'tests', 'packages']) {
  for (const file of await readdir(new URL(`../${directory}/`, import.meta.url), { recursive: true })) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
await readWorkspace(fileURLToPath(new URL('../examples/card-game/.mechanics/', import.meta.url)));
// 路由性能用例有真实耗时门槛，串行执行以免其他测试进程争用 CPU 导致误报。
const tests = spawnSync(process.execPath, ['--test', '--test-concurrency=1'], { cwd: root, stdio: 'inherit' });
if (tests.error) throw tests.error;
process.exit(tests.status ?? 1);
