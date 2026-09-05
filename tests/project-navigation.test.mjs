import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { startServer } from '../src/server/http.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const example = new URL('../examples/card-game/', import.meta.url);

async function post(origin, path, body, contentType = 'application/json') {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': contentType },
    body: contentType === 'application/json' ? JSON.stringify(body) : String(body) });
  return { response, data: await response.json() };
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

test('项目预检区分 existing、missing、invalid，并要求匹配意图和未过期指纹', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-preflight-'));
  const existing = join(root, 'existing'), missing = join(root, 'missing'), initializing = join(root, 'new-project'),
    damaged = join(root, 'damaged');
  await copyExampleFixture(existing); await mkdir(missing); await mkdir(initializing);
  await mkdir(join(damaged, '.game-graph'), { recursive: true });
  await writeFile(join(damaged, '.game-graph', 'workspace.json'), '{bad');
  const server = await startServer({ port: 0, projectHistoryPath: join(root, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });

  const ready = await post(server.origin, '/api/project/preflight', { projectRoot: existing });
  assert.equal(ready.data.status, 'existing'); assert.equal(ready.data.allowedIntent, 'existing');
  assert.equal(typeof ready.data.selectionToken, 'string'); assert.equal(ready.data.workspaceId, 'sample-card-game');
  const mismatch = await post(server.origin, '/api/project/open', { projectRoot: existing,
    selectionToken: ready.data.selectionToken, intent: 'initialize' });
  assert.equal(mismatch.response.status, 409); assert.equal(mismatch.data.error, 'PROJECT_INTENT_MISMATCH');

  const changing = await post(server.origin, '/api/project/preflight', { projectRoot: existing });
  const mechanismPath = join(existing, '.game-graph', 'mechanics', 'basic-rules.mechanic.json');
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
  await assert.rejects(access(join(missing, '.game-graph')), { code: 'ENOENT' });
  await mkdir(join(missing, '.game-graph'));
  const stale = await post(server.origin, '/api/project/open', { projectRoot: missing,
    selectionToken: absent.data.selectionToken, intent: 'initialize' });
  assert.equal(stale.response.status, 409); assert.equal(stale.data.error, 'PROJECT_PREFLIGHT_STALE');
  assert.equal(await readFile(join(damaged, '.game-graph', 'workspace.json'), 'utf8'), '{bad');

  const newProject = await post(server.origin, '/api/project/preflight', { projectRoot: initializing });
  assert.equal(newProject.data.status, 'missing'); assert.deepEqual(newProject.data.requiredMetadata, []);
  const initialized = await post(server.origin, '/api/project/open', { projectRoot: initializing,
    selectionToken: newProject.data.selectionToken, intent: 'initialize', name: '新项目' });
  assert.equal(initialized.response.status, 200);
  assert.equal(JSON.parse(await readFile(join(initializing, '.game-graph', 'workspace.json'), 'utf8')).name, '新项目');

  const invalid = await post(server.origin, '/api/project/preflight', { projectRoot: damaged });
  assert.equal(invalid.data.status, 'invalid'); assert.equal(invalid.data.error, 'INVALID_JSON');
  assert.equal(invalid.data.selectionToken, undefined);
  const noToken = await post(server.origin, '/api/project/open', { projectRoot: existing, intent: 'existing' });
  assert.equal(noToken.response.status, 422); assert.equal(noToken.data.error, 'PROJECT_PREFLIGHT_REQUIRED');
});

test('项目仅在成功激活后进入最近记录，并支持置顶、取消置顶和移除', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-history-'));
  const first = join(root, 'first'), second = join(root, 'second'), historyPath = join(root, 'user', 'projects.json');
  await copyExampleFixture(first); await copyExampleFixture(second);
  const server = await startServer({ port: 0, projectHistoryPath: historyPath });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const open = async projectRoot => {
    const selected = await post(server.origin, '/api/project/preflight', { projectRoot });
    return post(server.origin, '/api/project/open', { projectRoot, selectionToken: selected.data.selectionToken, intent: selected.data.allowedIntent });
  };

  const invalid = await post(server.origin, '/api/project/open', { projectRoot: first, selectionToken: 'unknown', intent: 'existing' });
  assert.equal(invalid.response.status, 409);
  assert.deepEqual((await (await fetch(server.origin + '/api/projects')).json()).items, []);
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
