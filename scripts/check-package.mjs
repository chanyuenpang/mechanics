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
  assert.match(path, /^(src\/|workspace-tools\/|schemas\/|skills\/|docs\/|examples\/|README\.md$|package\.json$)/);
  assert.ok(!/(?:^|\/)(?:node_modules|\.git|\.claw|design|\.agents|game-mechanics|\.rule-text-backup-[^/]+)(?:\/|$)|(?:^|\/)\.ui-state\.json$|\.lock$|\.tmp$|\.log$/.test(path), path);
}
assert.ok(!names.includes('examples/card-game/.mechanics/.mechanics.lock'), '打包清单不得包含运行态工作区锁');
assert.ok(!names.some(path => path.includes('/.rule-text-backup-')), '打包清单不得包含规则文本备份');
assert.ok(!names.some(path => path.includes('/.agents/')), '打包清单不得包含项目注册 skill 副本');
assert.ok(!names.some(path => path.includes('/game-mechanics/')), '打包清单不得包含生成的 Agent 文档');
for (const path of ['src/server/cli.mjs', 'src/server/mcp-render.mjs', 'src/server/mcp-render-cli.mjs', 'src/mcp/concepts-widget.html', 'src/mcp/concepts-widget.bundle.js', 'src/mcp/concepts-widget-source.mjs', 'src/domain/conversation-projection.mjs', 'src/domain/hover-details.mjs', 'src/server/native-directory-picker.mjs', 'src/server/windows-directory-dialog.cs', 'src/web/glossary.mjs', 'src/web/view-files.mjs', 'src/web/graph-compute.mjs',
  'src/server/macos-directory-dialog.js', 'src/web/graph-compute-kernel.mjs', 'src/web/graph-compute-worker.js', 'src/web/geometry-settle.mjs', 'src/web/hierarchical-layout.mjs', 'src/web/layout-structure.mjs', 'src/web/local-routing.mjs', 'src/web/flow-refinement.mjs', 'src/web/index.html', 'schemas/protocol.schema.json']) assert.ok(names.includes(path), path);
for (const path of ['skills/mechanics-search/SKILL.md', 'skills/mechanics-modeling/SKILL.md', 'skills/mechanics-doc/SKILL.md', 'skills/mechanics-doc/agents/openai.yaml', 'docs/安装与Codex接入.md']) assert.ok(names.includes(path), path);
command(process.execPath, ['scripts/build-workspace-tool.mjs', '--check'], root);
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
  const installed = join(install, 'node_modules/@veewo/mechanics');
  const bin = join(install, 'node_modules/.bin/mech' + (process.platform === 'win32' ? '.cmd' : ''));
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
  const initialized = JSON.parse(command(process.execPath, [cli, 'init', workspace, '--id', 'package-check'], temporary));
  assert.deepEqual(initialized.projectSkills, ['.agents/skills/mechanics-search/SKILL.md', '.agents/skills/mechanics-modeling/SKILL.md', '.agents/skills/mechanics-doc/SKILL.md']);
  for (const name of ['mechanics-search', 'mechanics-modeling', 'mechanics-doc']) {
    assert.equal(await readFile(join(workspace, '.agents', 'skills', name, 'SKILL.md'), 'utf8'),
      await readFile(join(installed, 'skills', name, 'SKILL.md'), 'utf8'));
  }
  for (const document of ['安装与Codex接入.md', '安装与DSH接入.md', '更新与升级.md', 'Codex MCP Apps.md', 'Agent查询接口.md', '文件协议.md', '架构设计.md']) {
    assert.equal(await readFile(join(workspace, '.agents/skills/mechanics-doc/references', document), 'utf8'),
      await readFile(join(installed, 'docs', document), 'utf8'));
  }
  const manifestBefore = await readFile(join(workspace, '.mechanics', 'workspace.json'), 'utf8');
  const data = JSON.parse(command(process.execPath, [cli, 'validate'], join(workspace, '.mechanics', 'mechanics')));
  assert.equal(data.workspaceId, 'package-check');
  const scopes = JSON.parse(command(process.execPath, [cli, 'agent', 'scopes'], join(workspace, '.mechanics', 'mechanics')));
  assert.equal(scopes.workspaceId, 'package-check');
  assert.equal(scopes.queryApiVersion, 11);
  assert.match(scopes.resourceRevisions.definitions, /^[a-f0-9]{64}$/u);
  const guide = JSON.parse(command(process.execPath, [cli, 'agent', 'guide'], temporary));
  assert.equal(guide.queryApiVersion, 11);
  assert.equal(guide.readingContract.version, 11);
  const search = JSON.parse(command(process.execPath, [cli, 'agent', 'search', '--query', '未建模概念'], join(workspace, '.mechanics', 'mechanics')));
  assert.equal(search.queryApiVersion, 11);
  assert.equal(search.readingContract.version, 11);
  assert.equal(search.resolution.status, 'not_found');
  const created = JSON.parse(command(process.execPath, [cli, 'agent', 'concept', 'create', '--project', workspace,
    '--id', 'package-focus', '--label', '打包专注', '--description', '隔离安装验收使用的概念。', '--aliases', '[]',
    '--revision', scopes.resourceRevisions.definitions], temporary));
  assert.equal(created.canonicalCommitted, true);
  assert.match(created.resourceRevision, /^[a-f0-9]{64}$/u);
  const updated = JSON.parse(command(process.execPath, [cli, 'agent', 'concept', 'update', '--project', workspace,
    '--concept', 'package-focus', '--description', '已通过资源版本串联修改。', '--revision', created.resourceRevision], temporary));
  assert.notEqual(updated.resourceRevision, created.resourceRevision);
  // 真实运行安装包中的 CLI 和静态页面，启动 cwd 在资料子目录而非源码内。
  child = spawn(process.execPath, [cli, 'web', '--port', '0'], { cwd: join(workspace, '.mechanics', 'mechanics'),
    env: { ...process.env, APPDATA: join(temporary, 'config'), XDG_CONFIG_HOME: join(temporary, 'config') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((accept, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(new Error('安装包 CLI 启动超时：' + errors)), 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('安装包服务提前退出 ' + code + '：' + errors)); });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//); if (match) { clearTimeout(timeout); accept(match[0]); } });
  });
  const origin = new URL(url).origin;
  assert.deepEqual(await (await fetch(origin + '/api/project')).json(), { status: 'empty', projectGeneration: 0 });
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const openResponse = await post('/api/project/open', { projectRoot: workspace });
  assert.equal(openResponse.status, 200, await openResponse.clone().text());
  for (const asset of ['/', '/app.mjs', '/canvas.mjs', '/glossary.mjs', '/view-files.mjs', '/graph-compute.mjs',
    '/graph-compute-kernel.mjs', '/graph-compute-worker.js', '/geometry-settle.mjs', '/hierarchical-layout.mjs', '/layout-structure.mjs', '/local-routing.mjs', '/flow-refinement.mjs', '/style.css',
    '/icons/eye.svg', '/icons/eye-off.svg',
    '/vendor/elk.js', '/vendor/elk-worker.js', '/vendor/webcola.js', '/vendor/libavoid/index.js', '/vendor/libavoid/libavoid.wasm', '/domain/graph.mjs', '/domain/view.mjs', '/domain/read-graph-integrity.mjs']) {
    assert.equal((await fetch(origin + asset)).status, 200, asset);
  }
  const response = await fetch(origin + '/api/workspace');
  assert.equal(response.status, 200);
  const opened = await response.json();
  assert.equal(opened.projectRoot, await realpath(workspace));
  assert.equal(opened.workspaceRoot, await realpath(join(workspace, '.mechanics')));
  assert.equal(await readFile(join(workspace, '.mechanics', 'workspace.json'), 'utf8'), manifestBefore);
  const createdMechanic = JSON.parse(command(process.execPath, [cli, 'agent', 'mechanic', 'create', '--connect', origin,
    '--project', workspace, '--project-generation', String(opened.projectGeneration), '--id', 'package-rules', '--name', '打包规则',
    '--scope', '隔离验收', '--workspace-revision', opened.revision], temporary));
  assert.equal(createdMechanic.canonicalCommitted, true);
  const session = JSON.parse(command(process.execPath, [cli, 'agent', 'session', 'open', '--connect', origin,
    '--project', workspace, '--project-generation', String(opened.projectGeneration), '--mechanic', 'package-rules'], temporary));
  assert.equal(session.status, 'open');
  const online = JSON.parse(command(process.execPath, [cli, 'agent', 'concept', 'update', '--connect', origin,
    '--project', workspace, '--project-generation', String(opened.projectGeneration), '--session', session.session,
    '--concept', 'package-focus', '--label', '在线打包专注',
    '--revision', opened.resourceRevisions.definitions], temporary));
  assert.equal(online.canonicalCommitted, true);
  const afterOnline = await (await fetch(origin + '/api/workspace')).json();
  const lockedDefinitions = structuredClone(afterOnline.definitions);
  lockedDefinitions.nodes.find(node => node.id === 'package-focus').agentLocked = true;
  const lockResponse = await fetch(origin + '/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectGeneration: afterOnline.projectGeneration, revision: afterOnline.revision, kind: 'definitions', document: lockedDefinitions }) });
  assert.equal(lockResponse.status, 200);
  const afterLock = await (await fetch(origin + '/api/workspace')).json();
  const lockedMutation = await fetch(origin + '/api/agent/mutation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoot: workspace, projectGeneration: afterLock.projectGeneration, editSessionId: session.session, revision: afterLock.resourceRevisions.definitions,
      resource: 'concept', action: 'update', id: 'package-focus', label: '不应写入' }) });
  assert.equal(lockedMutation.status, 422);
  assert.equal((await lockedMutation.json()).error, 'CONCEPT_AGENT_LOCKED');
  console.log(JSON.stringify({ ok: true, version: preview.version, tarball, files: names.length, integrity: packed.integrity,
    shim: true, isolatedInstall: true, cliWeb: true, emptyProjectStart: true, webProjectOpen: true, staticAssets: true, cwdIndependent: true,
    queryApiVersion: scopes.queryApiVersion, mutationOffline: true, mutationOnline: true, agentLock: true,
    bundledSkills: true, initSkillRegistration: true }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(accept => child.once('exit', accept)); child.kill('SIGTERM'); await exited;
  }
  // Windows 终止子进程不发送 POSIX 信号；遗留锁仅随这个已退出的隔离夹具一起清理。
  const resolved = await realpath(temporary), inside = relative(await realpath(tmpdir()), resolved);
  assert.equal(resolved, temporaryRoot); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
  await rm(resolved, { recursive: true, force: true });
}
