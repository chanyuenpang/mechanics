import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, cp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { acquireWorkspaceLock } from '../src/server/files.mjs';
import { startServer } from '../src/server/http.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { publishCatalog } from '../src/server/catalog.mjs';
import { compose } from '../src/domain/graph.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rule-editor-test-'));
  await copyExampleFixture(projectRoot);
  const directory = join(projectRoot, '.mechanics');
  const store = await createWorkspaceStore(directory);
  t.after(async () => { await store.close(); await rm(projectRoot, { recursive: true, force: true }); });
  return { directory, store, workspace: await store.read() };
}

test('单文件保存真实落盘，读服务不持锁，写入冲突不覆盖', async t => {
  const { directory, store, workspace } = await fixture(t);
  const pathOf = id => workspace.files.find(file => file.kind === 'mechanic' && file.id === id).path;
  const before = await readFile(join(directory, pathOf(workspace.mechanics[1].id)), 'utf8');
  const document = structuredClone(workspace.mechanics[0]);
  document.positions.draw = { x: 123, y: 456 };
  const saved = await store.save({ revision: workspace.revision, kind: 'mechanic', id: document.id, document });
  // 坐标属于展示数据：真实落盘，但不移动语义版本（docs/文件协议.md「布局不改变语义 revision」）。
  assert.equal(saved.revision, workspace.revision);
  assert.deepEqual(JSON.parse(await readFile(join(directory, pathOf(document.id)), 'utf8')), document);
  assert.equal(await readFile(join(directory, pathOf(workspace.mechanics[1].id)), 'utf8'), before);
  await assert.rejects(access(join(directory, '.mechanics.lock')), { code: 'ENOENT' });
  const reader = await createWorkspaceStore(directory); await reader.close();
  await writeFile(join(directory, '.mechanics.lock'), '{"pid":999999999,"owner":"stopped-writer"}');
  await store.save({ revision: saved.revision, kind: 'mechanic', id: document.id, document });
  await assert.rejects(access(join(directory, '.mechanics.lock')), { code: 'ENOENT' });
  const release = await acquireWorkspaceLock(directory);
  try {
    await assert.rejects(store.save({ revision: saved.revision, kind: 'mechanic', id: document.id, document }), { code: 'WORKSPACE_LOCKED' });
  } finally { await release(); }
  await assert.rejects(access(join(directory, '.mechanics.lock')), { code: 'ENOENT' });
});


test('机制图的 is-a 展开状态随草稿落盘并在重开后一致', async t => {
  const { directory, store, workspace } = await fixture(t);
  const pathOf = id => workspace.files.find(file => file.kind === 'mechanic' && file.id === id).path;
  const mechanic = workspace.mechanics[0], childId = mechanic.focusNodeIds[0];
  const document = { ...structuredClone(mechanic), taxonomyPresentation: { mode: 'label', expandedNodeIds: [childId] } };
  const saved = await store.save({ revision: workspace.revision, kind: 'mechanic', id: mechanic.id, document });
  const expected = { mode: 'label', expandedNodeIds: [childId] };
  assert.deepEqual(JSON.parse(await readFile(join(directory, pathOf(mechanic.id)), 'utf8')).taxonomyPresentation, expected);
  assert.deepEqual(saved.mechanics.find(item => item.id === mechanic.id).taxonomyPresentation, expected);
  // 重开项目只从文件恢复，不靠运行时合成默认值。
  const reopened = await createWorkspaceStore(directory);
  try { assert.deepEqual((await reopened.read()).mechanics.find(item => item.id === mechanic.id).taxonomyPresentation, expected); }
  finally { await reopened.close(); }
  // 收起后回到显式空集合，文件与回读一致。
  await store.save({ revision: saved.revision, kind: 'mechanic', id: mechanic.id,
    document: { ...document, taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } } });
  assert.deepEqual(JSON.parse(await readFile(join(directory, pathOf(mechanic.id)), 'utf8')).taxonomyPresentation, { mode: 'label', expandedNodeIds: [] });
});
test('外部修改与同时旧版本写入不会被覆盖；失败后草稿可修正再提交', async t => {
  const { directory, store, workspace } = await fixture(t);
  const file = join(directory, workspace.manifest.definitions);
  const external = structuredClone(workspace.definitions); external.nodes[0].label = '外部修改';
  await writeFile(file, JSON.stringify(external));
  await assert.rejects(store.save({ revision: workspace.revision, kind: 'definitions', document: workspace.definitions }), { code: 'REVISION_CONFLICT' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).nodes[0].label, '外部修改');
  const canonical = await readWorkspace(directory, { verifyGeneratedCatalog: false });
  await mkdir(canonical.agentExportRoot, { recursive: true });
  await publishCatalog(canonical.agentExportRoot, canonical);
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
  const rules = structuredClone(workspace.rules); rules.rules[0].sign = 0;
  await assert.rejects(store.save({ revision: workspace.revision, kind: 'rules', document: rules }), { code: 'INVALID_DOCUMENT' });
  assert.equal((await store.read()).revision, workspace.revision);
});

test('新建嵌套机制文件自然发现，不改配置；同名文件绝不覆盖', async t => {
  const { directory, store, workspace } = await fixture(t);
  const document = { schemaVersion: 8, kind: 'mechanic', workspaceId: workspace.manifest.id, id: 'new-layer', name: '新图层', scope: '抽象规则', focusNodeIds: ['enemy', 'damage'], pinnedRuleIds: [], positions: {}, taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } };
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
  const hand = workspace.mechanics.find(graph => graph.id === 'hand');
  const ruleId = hand.pinnedRuleIds[0], rules = structuredClone(workspace.rules);
  rules.rules.find(rule => rule.id === ruleId).sign = -1;
  await writeFile(join(directory, workspace.manifest.rules), JSON.stringify(rules));
  const canonical = await readWorkspace(directory, { verifyGeneratedCatalog: false });
  await mkdir(canonical.agentExportRoot, { recursive: true });
  await publishCatalog(canonical.agentExportRoot, canonical);
  const reopened = await readWorkspace(directory);
  assert.deepEqual(reopened.manifest.lastView, document.lastView);
  const projection = compose(reopened, reopened.manifest.lastView.graphIds);
  assert.equal(projection.edges.find(edge => edge.id === ruleId).sign, -1);
  const invalid = structuredClone(document); invalid.lastView.activeLayerId = 'encounter';
  await assert.rejects(store.save({ revision: reopened.revision, kind: 'workspace', document: invalid }), { code: 'HIDDEN_ACTIVE_LAYER' });
});

test('创建图层逐级拒绝指向外部目录的 junction，未写外部文件', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rule-editor-link-'));
  let store;
  t.after(async () => { if (store) await store.close(); await rm(directory, { recursive: true, force: true }); });
  const projectRoot = join(directory, 'workspace'); await mkdir(projectRoot);
  await copyExampleFixture(projectRoot);
  const root = join(projectRoot, '.mechanics');
  const original = await readWorkspace(root);
  const manifest = structuredClone(original.manifest); manifest.compositions = [];
  await writeFile(join(root, 'workspace.json'), JSON.stringify(manifest));
  await rm(join(root, 'mechanics'), { recursive: true });
  const outside = join(directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(root, 'mechanics'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createWorkspaceStore(root), { code: 'UNSAFE_PATH' });
  await assert.rejects(readFile(join(outside, 'escape.mechanic.json')), { code: 'ENOENT' });
});

test('HTTP 写入无需 session 且允许跨源，仍要求 JSON 并拒绝过期版本', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rule-editor-http-'));
  await copyExampleFixture(projectRoot);
  const directory = join(projectRoot, '.mechanics');
  const { close, origin } = await startServer({ projectRoot, port: 0, projectHistoryPath: join(projectRoot, '.test-projects.json') });
  t.after(async () => { await close(); await rm(projectRoot, { recursive: true, force: true }); });
  const headers = { Origin: 'https://other.example', 'Content-Type': 'application/json' };
  const workspace = await readWorkspace(directory), document = structuredClone(workspace.definitions); document.nodes[0].label = 'HTTP 修改';
  const body = JSON.stringify({ projectGeneration: 1, revision: workspace.revision, kind: 'definitions', document });
  const call = supplied => fetch(origin + '/api/save', { method: 'POST', headers: supplied, body });
  assert.equal((await call({ Origin: 'https://other.example' })).status, 415);
  const response = await call(headers); assert.equal(response.status, 200);
  assert.equal((await response.json()).definitions.nodes[0].label, 'HTTP 修改');
  const conflict = await call(headers); assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'REVISION_CONFLICT');
  const module = await fetch(origin + '/canvas.mjs'); assert.equal(module.status, 200);
});
