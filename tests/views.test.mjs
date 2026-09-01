import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readWorkspace } from '../src/server/workspace.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { startServer } from '../src/server/http.mjs';
import { validateWorkspace } from '../src/domain/validate.mjs';

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rule-views-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(example, root, { recursive: true });
  return root;
}
const view = (id = 'hand') => ({ schemaVersion: 2, kind: 'view', workspaceId: 'sample-card-game', id, name: '规则叠加', mechanicRegistrations: [{ mechanicId: 'basic-rules', visible: true }, { mechanicId: 'hand', visible: true }], collapsedNodeIds: [], positions: {} });
const json = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'));

test('真实视图混排发现、按类型区分同 ID，保存只改视图且最近记录仅存引用', async t => {
  const root = await fixture(t), store = await createWorkspaceStore(root);
  try {
    let data = await store.read();
    const manifestBefore = await readFile(join(root, 'workspace.json'), 'utf8');
    const rulesBefore = await readFile(join(root, 'mechanics/hand.mechanic.json'), 'utf8');
    data = await store.createView({ revision: data.revision, document: view(), file: '关卡/首领.view.json' });
    assert.equal(await readFile(join(root, 'workspace.json'), 'utf8'), manifestBefore);
    assert.equal(data.files.find(f => f.kind === 'view' && f.id === 'hand').path, '关卡/首领.view.json');
    assert.equal(data.files.find(f => f.kind === 'mechanic' && f.id === 'hand').path, 'mechanics/hand.mechanic.json');
    data = await store.save({ revision: data.revision, kind: 'workspace', document: { ...data.manifest, lastView: { viewId: 'hand' } } });
    const selected = await readFile(join(root, 'workspace.json'), 'utf8');
    data = await store.save({ revision: data.revision, kind: 'view', id: 'hand', document: { ...view(), mechanicRegistrations: [{ mechanicId: 'hand', visible: true }] } });
    assert.deepEqual((await json(root, '关卡/首领.view.json')).mechanicRegistrations, [{ mechanicId: 'hand', visible: true }]);
    assert.equal(await readFile(join(root, 'workspace.json'), 'utf8'), selected);
    assert.equal(await readFile(join(root, 'mechanics/hand.mechanic.json'), 'utf8'), rulesBefore);
    const viewBefore = await readFile(join(root, '关卡/首领.view.json'), 'utf8');
    data = await store.save({ revision: data.revision, kind: 'mechanic', id: 'hand', document: { ...data.mechanics.find(g => g.id === 'hand'), name: '新规则名称' } });
    assert.equal(await readFile(join(root, '关卡/首领.view.json'), 'utf8'), viewBefore);
    assert.equal(data.mechanics.find(g => g.id === 'hand').name, '新规则名称');
  } finally { await store.close(); }
});

test('视图和机制移动仍按 ID 恢复，外部视图字节修改触发整体版本冲突', async t => {
  const root = await fixture(t), store = await createWorkspaceStore(root);
  try {
    let data = await store.read();
    data = await store.createView({ revision: data.revision, document: view(), file: 'main.view.json' });
    data = await store.save({ revision: data.revision, kind: 'workspace', document: { ...data.manifest, lastView: { viewId: 'hand' } } });
    await mkdir(join(root, '移动'));
    await rename(join(root, 'main.view.json'), join(root, '移动/视图.view.json'));
    await rename(join(root, 'mechanics/hand.mechanic.json'), join(root, '移动/手牌.mechanic.json'));
    const moved = await store.read(); assert.deepEqual(moved.manifest.lastView, { viewId: 'hand' });
    assert.notEqual(moved.revision, data.revision);
    await writeFile(join(root, '移动/视图.view.json'), JSON.stringify({ ...view(), name: '外部更名' }));
    await assert.rejects(store.save({ revision: moved.revision, kind: 'view', id: 'hand', document: view() }), { code: 'REVISION_CONFLICT' });
    assert.equal((await json(root, '移动/视图.view.json')).name, '外部更名');
    await rm(join(root, '移动/手牌.mechanic.json'));
    await assert.rejects(store.read(), error => error.code === 'MISSING_REFERENCE');
  } finally { await store.close(); }
});

test('未打开的坏视图、跨区、重复引用、隐藏编辑层和双 lastView 事实均拒绝', async t => {
  const root = await fixture(t), initial = await readWorkspace(root);
  for (const changed of [{ workspaceId: 'another' }, { mechanicRegistrations: [{ mechanicId: 'hand', visible: true }, { mechanicId: 'hand', visible: false }] }, { schemaVersion: 1 }, { activeLayerId: 'missing' }, { mechanicRegistrations: [{ mechanicId: 'absent', visible: true }] }, { collapsedNodeIds: ['absent'] }]) {
    assert.throws(() => validateWorkspace({ ...initial, views: [{ ...view(), ...changed }] }));
  }
  assert.throws(() => validateWorkspace({ ...initial, views: [view(), view()] }), { code: 'DUPLICATE_ID' });
  assert.throws(() => validateWorkspace({ ...initial, manifest: { ...initial.manifest, lastView: { viewId: 'missing' } } }), { code: 'MISSING_REFERENCE' });
  assert.throws(() => validateWorkspace({ ...initial, views: [view()], manifest: { ...initial.manifest, lastView: { viewId: 'hand', graphIds: ['hand'] } } }), { code: 'INVALID_DOCUMENT' });
  validateWorkspace({ ...initial, views: [{ ...view(), mechanicRegistrations: [] }] });
  await writeFile(join(root, '未打开.view.json'), '{bad');
  await assert.rejects(readWorkspace(root), { code: 'INVALID_JSON' });
});

test('视图创建拒绝同名覆盖、越界、隐藏目录及 junction', async t => {
  const root = await fixture(t), store = await createWorkspaceStore(root);
  try {
    let data = await store.read();
    for (const file of [undefined, '../outside.view.json', '.cache/x.view.json', 'node_modules/x.view.json', 'x.mechanic.json']) {
      await assert.rejects(store.createView({ revision: data.revision, document: view(), file }), { code: 'UNSAFE_PATH' });
    }
    data = await store.createView({ revision: data.revision, document: view(), file: 'x.view.json' });
    await assert.rejects(store.createView({ revision: data.revision, document: view('another'), file: 'x.view.json' }), { code: 'FILE_EXISTS' });
    assert.equal((await json(root, 'x.view.json')).id, 'hand');
    const outside = await mkdtemp(join(tmpdir(), 'rule-views-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.createView({ revision: data.revision, document: view('another'), file: 'linked/x.view.json' }), { code: 'UNSAFE_PATH' });
    await assert.rejects(readFile(join(outside, 'x.view.json')), { code: 'ENOENT' });
  } finally { await store.close(); }
});

test('视图 HTTP 路由使用同源会话门禁，创建及保存真实回读并拒绝旧 revision', async t => {
  const root = await fixture(t), server = await startServer({ workspaceRoot: root, port: 0 });
  try {
    const initial = await readWorkspace(root);
    const post = (path, body, headers = {}) => fetch(server.origin + path, { method: 'POST', headers: { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/views', {}, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post('/api/views', {}, { Origin: 'http://other.invalid' })).status, 403);
    const created = await post('/api/views', { revision: initial.revision, document: view(), file: 'http.view.json' });
    assert.equal(created.status, 200);
    const data = await created.json(); assert.equal(data.views.length, 1);
    const saved = await post('/api/save', { revision: data.revision, kind: 'view', id: 'hand', document: { ...view(), mechanicRegistrations: [{ mechanicId: 'hand', visible: true }] } });
    assert.equal(saved.status, 200);
    assert.deepEqual((await json(root, 'http.view.json')).mechanicRegistrations, [{ mechanicId: 'hand', visible: true }]);
    assert.equal((await post('/api/save', { revision: data.revision, kind: 'view', id: 'hand', document: view() })).status, 409);
  } finally { await server.close(); }
});
