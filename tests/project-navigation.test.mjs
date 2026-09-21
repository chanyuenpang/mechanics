import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { startServer } from '../src/server/http.mjs';
import { copyExampleFixture } from './example-fixture.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';

const example = new URL('../examples/card-game/', import.meta.url);

async function post(origin, path, body, contentType = 'application/json') {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': contentType },
    body: contentType === 'application/json' ? JSON.stringify(body) : String(body) });
  return { response, data: await response.json() };
}

async function downgradeFixtureToV10(projectRoot) {
  const workspaceRoot = join(projectRoot, '.mechanics'), workspace = await readWorkspace(workspaceRoot);
  const manifestPath = join(workspaceRoot, 'workspace.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const rules = JSON.parse(await readFile(join(workspaceRoot, 'rules.json'), 'utf8'));
  await rename(join(workspaceRoot, 'definitions.json'), join(workspaceRoot, 'definitions.graph.json'));
  const definitionsPath = join(workspaceRoot, 'definitions.graph.json'), definitions = JSON.parse(await readFile(definitionsPath, 'utf8'));
  definitions.schemaVersion = 5; delete definitions.tagDefinitions;
  for (const node of definitions.nodes) delete node.tagIds;
  await writeFile(definitionsPath, JSON.stringify(definitions, null, 2) + '\n');
  for (const mechanic of workspace.mechanics) {
    const path = join(workspaceRoot, workspace.files.find(file => file.kind === 'mechanic' && file.id === mechanic.id).path);
    const legacy = { ...mechanic, schemaVersion: 6, nodeIds: mechanic.focusNodeIds, edges: rules.rules.filter(rule => mechanic.pinnedRuleIds.includes(rule.id)) };
    delete legacy.focusNodeIds; delete legacy.pinnedRuleIds; delete legacy.nodeColors; delete legacy.nodeStyles;
    await writeFile(path, JSON.stringify(legacy, null, 2) + '\n');
  }
  for (const view of workspace.views) {
    const path = join(workspaceRoot, workspace.files.find(file => file.kind === 'view' && file.id === view.id).path);
    await writeFile(path, JSON.stringify({ ...view, schemaVersion: 3 }, null, 2) + '\n');
  }
  const v10 = { ...manifest, schemaVersion: 10, definitions: 'definitions.graph.json' };
  delete v10.rules; await writeFile(manifestPath, JSON.stringify(v10, null, 2) + '\n');
  await unlink(join(workspaceRoot, 'rules.json'));
}

test('目录浏览只返回目录，回显规范路径并明确标记不可进入的符号链接', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-directory-browser-'));
  await mkdir(join(root, 'ordinary')); await writeFile(join(root, 'file.txt'), 'x');
  let symlinkSupported = true;
  try { await symlink(join(root, 'ordinary'), join(root, 'linked'), 'junction'); }
  catch { symlinkSupported = false; }
  const server = await startServer({ port: 0, projectHistoryPath: join(root, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });

  const roots = await (await fetch(server.origin + '/api/directories')).json();
  assert.ok(roots.roots.length >= 1);
  assert.ok(roots.roots.every(item => isAbsolute(item.path) && item.accessible && !item.symlink));
  const listing = await (await fetch(server.origin + '/api/directories?path=' + encodeURIComponent(root))).json();
  assert.equal(listing.absolutePath, resolve(root));
  assert.ok(isAbsolute(listing.parentPath));
  assert.deepEqual(listing.entries.find(item => item.name === 'ordinary'),
    { name: 'ordinary', path: join(root, 'ordinary'), accessible: true, symlink: false });
  assert.equal(listing.entries.some(item => item.name === 'file.txt'), false);
  if (symlinkSupported) {
    assert.deepEqual(listing.entries.find(item => item.name === 'linked'),
      { name: 'linked', path: join(root, 'linked'), accessible: false, symlink: true });
    const rejected = await fetch(server.origin + '/api/directories?path=' + encodeURIComponent(join(root, 'linked')));
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error, 'SYMLINK_REJECTED');
  }
});

test.skip('已删除：项目预检区分 existing、missing、invalid，并要求匹配意图和未过期指纹', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-preflight-'));
  const existing = join(root, 'existing'), missing = join(root, 'missing'), initializing = join(root, 'new-project'),
    damaged = join(root, 'damaged');
  await copyExampleFixture(existing); await mkdir(missing); await mkdir(initializing);
  await mkdir(join(damaged, '.mechanics'), { recursive: true });
  await writeFile(join(damaged, '.mechanics', 'workspace.json'), '{bad');
  const server = await startServer({ port: 0, projectHistoryPath: join(root, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });

  const ready = await post(server.origin, '/api/project/preflight', { projectRoot: existing });
  assert.equal(ready.data.status, 'existing'); assert.equal(ready.data.allowedIntent, 'existing');
  assert.equal(typeof ready.data.selectionToken, 'string'); assert.equal(ready.data.workspaceId, 'sample-card-game');
  const mismatch = await post(server.origin, '/api/project/open', { projectRoot: existing,
    selectionToken: ready.data.selectionToken, intent: 'initialize' });
  assert.equal(mismatch.response.status, 409); assert.equal(mismatch.data.error, 'PROJECT_INTENT_MISMATCH');

  const changing = await post(server.origin, '/api/project/preflight', { projectRoot: existing });
  const mechanismPath = join(existing, '.mechanics', 'mechanics', 'basic-rules.mechanic.json');
  const mechanism = JSON.parse(await readFile(mechanismPath, 'utf8'));
  mechanism.name = '预检期间已更新';
  await writeFile(mechanismPath, JSON.stringify(mechanism));
  const openedWhileWriting = await post(server.origin, '/api/project/open', { projectRoot: existing,
    selectionToken: changing.data.selectionToken, intent: 'existing' });
  assert.equal(openedWhileWriting.response.status, 200);
  assert.equal(openedWhileWriting.data.mechanics.find(item => item.id === 'basic-rules').name, '预检期间已更新');

  const absent = await post(server.origin, '/api/project/preflight', { projectRoot: missing });
  assert.equal(absent.data.status, 'missing'); assert.equal(absent.data.allowedIntent, 'initialize');
  assert.equal(absent.data.willInitialize, true);
  await assert.rejects(access(join(missing, '.mechanics')), { code: 'ENOENT' });
  await mkdir(join(missing, '.mechanics'));
  const stale = await post(server.origin, '/api/project/open', { projectRoot: missing,
    selectionToken: absent.data.selectionToken, intent: 'initialize' });
  assert.equal(stale.response.status, 409); assert.equal(stale.data.error, 'PROJECT_PREFLIGHT_STALE');
  assert.equal(await readFile(join(damaged, '.mechanics', 'workspace.json'), 'utf8'), '{bad');

  const newProject = await post(server.origin, '/api/project/preflight', { projectRoot: initializing });
  assert.equal(newProject.data.status, 'missing'); assert.deepEqual(newProject.data.requiredMetadata, []);
  const initialized = await post(server.origin, '/api/project/open', { projectRoot: initializing,
    selectionToken: newProject.data.selectionToken, intent: 'initialize', name: '新项目' });
  assert.equal(initialized.response.status, 200);
  assert.equal(JSON.parse(await readFile(join(initializing, '.mechanics', 'workspace.json'), 'utf8')).name, '新项目');

  const invalid = await post(server.origin, '/api/project/preflight', { projectRoot: damaged });
  assert.equal(invalid.data.status, 'invalid'); assert.equal(invalid.data.error, 'INVALID_JSON');
  assert.equal(invalid.data.selectionToken, undefined);
  const noToken = await post(server.origin, '/api/project/open', { projectRoot: existing, intent: 'existing' });
  assert.equal(noToken.response.status, 422); assert.equal(noToken.data.error, 'PROJECT_PREFLIGHT_REQUIRED');
});

test.skip('已删除：预检允许 v10 工作区，并以兼容读模型打开而不自动迁移', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-v10-preflight-'));
  await copyExampleFixture(root); await downgradeFixtureToV10(root);
  const server = await startServer({ port: 0, projectHistoryPath: join(root, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const preflight = await post(server.origin, '/api/project/preflight', { projectRoot: root });
  assert.equal(preflight.response.status, 200); assert.equal(preflight.data.status, 'existing'); assert.equal(preflight.data.willUpgrade, undefined);
  const opened = await post(server.origin, '/api/project/open', { projectRoot: root, selectionToken: preflight.data.selectionToken, intent: preflight.data.allowedIntent });
  assert.equal(opened.response.status, 200, JSON.stringify(opened.data)); assert.equal(opened.data.manifest.schemaVersion, 12);
  assert.equal(opened.data.compatibilityMode, true);
  assert.equal(JSON.parse(await readFile(join(root, '.mechanics', 'workspace.json'), 'utf8')).schemaVersion, 10);
});

test('坏机制图不会阻断网页预检和项目打开', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-degraded-project-'));
  await copyExampleFixture(root);
  const workspaceRoot = join(root, '.mechanics'), workspace = await readWorkspace(workspaceRoot);
  const target = workspace.mechanics.find(item => item.id === 'hand');
  const path = join(workspaceRoot, workspace.files.find(file => file.kind === 'mechanic' && file.id === target.id).path);
  await writeFile(path, JSON.stringify({ ...target, focusNodeIds: [...target.focusNodeIds, 'player-damage'] }, null, 2));
  const server = await startServer({ port: 0, projectHistoryPath: join(root, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const opened = await post(server.origin, '/api/project/open', { projectRoot: root });
  assert.equal(opened.response.status, 200, JSON.stringify(opened.data));
  assert.equal(opened.data.workspaceState, 'degraded');
  assert.ok(opened.data.resourceDiagnostics.some(item => item.path.endsWith('hand.mechanic.json') && /player-damage/.test(item.message)));
});

test('项目仅在成功激活后进入最近记录，并支持置顶、取消置顶和移除', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-history-'));
  const first = join(root, 'first'), second = join(root, 'second'), historyPath = join(root, 'user', 'projects.json');
  await copyExampleFixture(first); await copyExampleFixture(second);
  const server = await startServer({ port: 0, projectHistoryPath: historyPath });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const open = projectRoot => post(server.origin, '/api/project/open', { projectRoot });

  assert.equal((await (await fetch(server.origin + '/api/projects')).json()).items.length, 0);
  assert.equal((await open(first)).response.status, 200); assert.equal((await open(second)).response.status, 200);
  let history = await (await fetch(server.origin + '/api/projects')).json();
  assert.deepEqual(history.items.map(item => item.projectRoot), [second, first]);
  assert.ok(history.items.every(item => item.workspaceId === 'sample-card-game' && item.name === '卡牌规则示例 · 假设模型'));

  assert.equal((await post(server.origin, '/api/projects/pin', { projectRoot: first, pinned: true })).response.status, 200);
  history = await (await fetch(server.origin + '/api/projects')).json();
  assert.equal(history.items[0].projectRoot, first); assert.equal(history.items[0].pinned, true);
  assert.equal((await post(server.origin, '/api/projects/pin', { projectRoot: first, pinned: false })).response.status, 200);
  assert.equal((await post(server.origin, '/api/projects/remove', { projectRoot: first })).response.status, 200);
  history = await (await fetch(server.origin + '/api/projects')).json();
  assert.deepEqual(history.items.map(item => item.projectRoot), [second]);
});
