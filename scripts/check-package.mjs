import { spawnSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请通过 npm run check:package 运行，以使用当前 npm CLI。');
function command(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 600000, windowsHide: true,
    windowsVerbatimArguments: process.platform === 'win32' && executable === process.env.ComSpec });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(JSON.stringify(args) + '\n' + result.stdout + '\n' + result.stderr);
  return result.stdout.trim();
}
const packArgs = ['pack', '--json', '--ignore-scripts'];
const [preview] = JSON.parse(command(process.execPath, [npm, ...packArgs, '--dry-run']));
const names = preview.files.map(file => file.path);
for (const path of names) {
  assert.match(path, /^(src\/|schemas\/|docs\/|examples\/|README\.md$|package\.json$)/);
  assert.ok(!/(?:^|\/)(?:node_modules|\.git|\.claw|design)(?:\/|$)|\.lock$|\.tmp$|\.log$/.test(path), path);
}
for (const path of ['src/server/cli.mjs', 'src/web/glossary.mjs', 'src/web/view-files.mjs', 'src/web/index.html', 'schemas/protocol.schema.json', 'schemas/legacy-workspace-v2.schema.json']) assert.ok(names.includes(path), path);
await mkdir(join(root, 'dist'), { recursive: true });
const [packed] = JSON.parse(command(process.execPath, [npm, ...packArgs, '--pack-destination', join(root, 'dist')]));
assert.deepEqual(packed.files.map(file => file.path), names);
const tarball = join(root, 'dist', packed.filename);
const temporary = await mkdtemp(join(tmpdir(), 'rule-package-'));
const temporaryRoot = await realpath(temporary);
let child;
try {
  const install = join(temporary, 'install');
  command(process.execPath, [npm, 'install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', tarball], temporary);
  const installed = join(install, 'node_modules/game-rule-analyzer');
  const bin = join(install, 'node_modules/.bin/game-rule-analyzer' + (process.platform === 'win32' ? '.cmd' : ''));
  let binVersion;
  if (process.platform === 'win32') {
    // 只运行安装生成的命令 shim；不把此 shell 用于文件操作。
    assert.ok(!/["%\r\n]/.test(bin));
    binVersion = command(process.env.ComSpec, ['/d', '/s', '/c', '""' + bin + '" --version"'], temporary);
  } else binVersion = command(bin, ['--version'], temporary);
  assert.equal(binVersion, preview.version);
  const cli = join(installed, 'src/server/cli.mjs');
  assert.match(await readFile(cli, 'utf8'), /^#!\/usr\/bin\/env node/);
  assert.match(command(process.execPath, [cli, '--help'], temporary), /init/);
  const workspace = join(temporary, '规则资料');
  command(process.execPath, [cli, 'init', workspace, '--id', 'package-check'], temporary);
  const manifestBefore = await readFile(join(workspace, 'workspace.json'), 'utf8');
  const data = JSON.parse(command(process.execPath, [cli, 'validate'], join(workspace, 'analyses')));
  assert.equal(data.workspaceId, 'package-check');
  // 真实运行安装包中的 CLI 和静态页面，启动 cwd 在资料子目录而非源码内。
  child = spawn(process.execPath, [cli, 'serve', '--port', '0'], { cwd: join(workspace, 'analyses'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((accept, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(new Error('安装包 CLI 启动超时：' + errors)), 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('安装包服务提前退出 ' + code + '：' + errors)); });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#session=[\w-]+/); if (match) { clearTimeout(timeout); accept(match[0]); } });
  });
  const origin = new URL(url).origin, token = new URL(url).hash.slice('#session='.length);
  for (const asset of ['/', '/app.mjs', '/canvas.mjs', '/glossary.mjs', '/view-files.mjs', '/style.css', '/domain/graph.mjs']) assert.equal((await fetch(origin + asset)).status, 200, asset);
  const response = await fetch(origin + '/api/workspace', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).workspaceRoot, await realpath(workspace));
  assert.equal(await readFile(join(workspace, 'workspace.json'), 'utf8'), manifestBefore);
  console.log(JSON.stringify({ ok: true, version: preview.version, tarball, files: names.length, integrity: packed.integrity, shim: true, isolatedInstall: true, cliServe: true, staticAssets: true, cwdIndependent: true }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(accept => child.once('exit', accept)); child.kill('SIGTERM'); await exited;
  }
  // Windows 终止子进程不发送 POSIX 信号；遗留锁仅随这个已退出的隔离夹具一起清理。
  const resolved = await realpath(temporary), inside = relative(await realpath(tmpdir()), resolved);
  assert.equal(resolved, temporaryRoot); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
  await rm(resolved, { recursive: true, force: true });
}
