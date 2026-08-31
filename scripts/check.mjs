import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readWorkspace } from '../src/server/workspace.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const directory of ['src', 'scripts', 'tests']) {
  for (const file of await readdir(new URL(`../${directory}/`, import.meta.url), { recursive: true })) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
await readWorkspace(fileURLToPath(new URL('../examples/card-game/', import.meta.url)));
const tests = spawnSync(process.execPath, ['--test'], { cwd: root, stdio: 'inherit' });
if (tests.error) throw tests.error;
process.exit(tests.status ?? 1);
