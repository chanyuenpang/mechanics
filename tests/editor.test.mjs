import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { startServer } from '../src/server/http.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { compose } from '../src/domain/graph.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rule-editor-test-'));
  await cp(fileURLToPath(new URL('../examples/card-game', import.meta.url)), directory, { recursive: true });
  const store = await createWorkspaceStore(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, workspace: await store.read() };
}

test('单文件保存真实落盘，其他图层字节保持不变，释放锁后可以重新打开', async t => {
  const { directory, store, workspace } = await fixture(t);
  const pathOf = id => workspace.files.find(file => file.kind === 'mechanic' && file.id === id).path;
  const before = await readFile(join(directory, pathOf(workspace.mechanics[1].id)), 'utf8');
  const document = structuredClone(workspace.mechanics[0]);
  document.positions.draw = { x: 123, y: 456 }; document.edges[0].sign = -1;
  const saved = await store.save({ revision: workspace.revision, kind: 'mechanic', id: document.id, document });
  assert.notEqual(saved.revision, workspace.revision);
  assert.deepEqual(JSON.parse(await readFile(join(directory, pathOf(document.id)), 'utf8')), document);
  assert.equal(await readFile(join(directory, pathOf(workspace.mechanics[1].id)), 'utf8'), before);
  await assert.rejects(createWorkspaceStore(directory), { code: 'WORKSPACE_LOCKED' });
  await store.close();
  const reopened = await createWorkspaceStore(directory); await reopened.close();
});

test('外部修改与同时旧版本写入不会被覆盖；失败后草稿可修正再提交', async t => {
  const { directory, store, workspace } = await fixture(t);
  const file = join(directory, workspace.manifest.definitions);
  const external = structuredClone(workspace.definitions); external.nodes[0].label = '外部修改';
  await writeFile(file, JSON.stringify(external));
  await assert.rejects(store.save({ revision: workspace.revision, kind: 'definitions', document: workspace.definitions }), { code: 'REVISION_CONFLICT' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).nodes[0].label, '外部修改');
  const fresh = await store.read();
  const one = structuredClone(external), two = structuredClone(external); one.nodes[0].label = '页面一'; two.nodes[0].label = '页面二';
  const results = await Promise.allSettled([one, two].map(document => store.save({ revision: fresh.revision, kind: 'definitions', document })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
});

test('删除被其他图层引用的定义、非法文件登记和非法边失败，旧目标完整', async t => {
  const { directory, store, workspace } = await fixture(t);
  const before = await readFile(join(directory, workspace.manifest.definitions), 'utf8');
  const document = structuredClone(workspace.definitions);
  document.nodes = document.nodes.filter(node => node.id !== 'melee'); delete document.positions.melee;
  await assert.rejects(store.save({ revision: workspace.revision, kind: 'definitions', document }), { code: 'MISSING_REFERENCE' });
  assert.equal(await readFile(join(directory, workspace.manifest.definitions), 'utf8'), before);
  const manifest = structuredClone(workspace.manifest); manifest.definitions = 'different.json';
  await assert.rejects(store.save({ revision: workspace.revision, kind: 'workspace', document: manifest }), { code: 'MANIFEST_PROTECTED' });
  const graph = structuredClone(workspace.mechanics[0]); graph.edges[0].sign = 0;
  await assert.rejects(store.save({ revision: workspace.revision, kind: 'mechanic', id: graph.id, document: graph }), { code: 'INVALID_DOCUMENT' });
  assert.equal((await store.read()).revision, workspace.revision);
});

test('新建嵌套机制文件自然发现，不改配置；同名文件绝不覆盖', async t => {
  const { directory, store, workspace } = await fixture(t);
  const document = { schemaVersion: 1, kind: 'mechanic', workspaceId: workspace.manifest.id, id: 'new-layer', name: '新图层', scope: '抽象规则', nodeIds: ['enemy', 'melee'], edges: [{ id: 'counter', source: 'enemy', target: 'melee', relation: 'influence', sign: -1, condition: '', note: '' }], positions: {} };
  const before = await readFile(join(directory, 'workspace.json'), 'utf8');
  const occupied = workspace.files.find(item => item.kind === 'mechanic').path;
  const occupiedBefore = await readFile(join(directory, occupied), 'utf8');
  await assert.rejects(store.createMechanic({ revision: workspace.revision, document, file: occupied }), { code: 'FILE_EXISTS' });
  assert.equal(await readFile(join(directory, occupied), 'utf8'), occupiedBefore);
  const path = '关卡/第一 层/new-layer.mechanic.json', file = join(directory, path);
  const created = await store.createMechanic({ revision: workspace.revision, document, file: path });
  assert.equal(created.mechanics.length, workspace.mechanics.length + 1);
  assert.ok(created.files.some(file => file.path === path && file.id === document.id));
  assert.equal(await readFile(join(directory, 'workspace.json'), 'utf8'), before);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), document);
  await assert.rejects(store.createMechanic({ revision: created.revision, document }), { code: 'DUPLICATE_ID' });
});

test('最近叠加视图保存图层引用，重开时基于源文件最新内容组合', async t => {
  const { directory, store, workspace } = await fixture(t);
  const document = structuredClone(workspace.manifest);
  document.lastView = { graphIds: ['basic-rules', 'hand'], activeLayerId: 'hand', collapsedNodeIds: ['repel'], positions: {} };
  await store.save({ revision: workspace.revision, kind: 'workspace', document });
  const hand = structuredClone(workspace.mechanics.find(graph => graph.id === 'hand')); hand.edges[0].sign = -1;
  const path = workspace.files.find(file => file.kind === 'mechanic' && file.id === 'hand').path;
  await writeFile(join(directory, path), JSON.stringify(hand));
  const reopened = await readWorkspace(directory);
  assert.deepEqual(reopened.manifest.lastView, document.lastView);
  const projection = compose(reopened, reopened.manifest.lastView.graphIds);
  assert.equal(projection.edges.find(edge => edge.steps[0].graphId === 'hand' && edge.steps[0].edgeId === hand.edges[0].id).sign, -1);
  const invalid = structuredClone(document); invalid.lastView.activeLayerId = 'encounter';
  await assert.rejects(store.save({ revision: reopened.revision, kind: 'workspace', document: invalid }), { code: 'HIDDEN_ACTIVE_LAYER' });
});

test('创建图层逐级拒绝指向外部目录的 junction，未写外部文件', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-editor-link-'));
  let store;
  t.after(async () => { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); });
  const root = join(directory, 'workspace'); await mkdir(root);
  await cp(fileURLToPath(new URL('../examples/card-game', import.meta.url)), root, { recursive: true });
  const original = await readWorkspace(root);
  const manifest = structuredClone(original.manifest); manifest.compositions = [];
  await writeFile(join(root, 'workspace.json'), JSON.stringify(manifest));
  await rm(join(root, 'mechanics'), { recursive: true });
  const outside = join(directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(root, 'mechanics'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createWorkspaceStore(root), { code: 'UNSAFE_PATH' });
  await assert.rejects(readFile(join(outside, 'escape.mechanic.json')), { code: 'ENOENT' });
});

test('HTTP 写入须携带同源 JSON 与会话，返回实际保存和过期冲突状态', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-editor-http-'));
  await cp(fileURLToPath(new URL('../examples/card-game', import.meta.url)), directory, { recursive: true });
  const { close, origin, token } = await startServer({ workspaceRoot: directory, port: 0 });
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { Authorization: 'Bearer ' + token, Origin: origin, 'Content-Type': 'application/json' };
  const workspace = await readWorkspace(directory), document = structuredClone(workspace.definitions); document.nodes[0].label = 'HTTP 修改';
  const body = JSON.stringify({ revision: workspace.revision, kind: 'definitions', document });
  const call = supplied => fetch(origin + '/api/save', { method: 'POST', headers: supplied, body });
  assert.equal((await call({ 'Content-Type': 'application/json', Origin: origin })).status, 401);
  assert.equal((await call({ ...headers, Origin: 'https://other.example' })).status, 403);
  assert.equal((await call({ Authorization: headers.Authorization, 'Content-Type': 'application/json' })).status, 403);
  const response = await call(headers); assert.equal(response.status, 200);
  assert.equal((await response.json()).definitions.nodes[0].label, 'HTTP 修改');
  const conflict = await call(headers); assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'REVISION_CONFLICT');
  const module = await fetch(origin + '/canvas.mjs'); assert.equal(module.status, 200);
});
