import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { publishCatalog } from '../src/server/catalog.mjs';
import { ViewAutosave, readOpening, prepareOpening, createAndRememberView, viewSaveRequest, graphPositions, changeViewVisibility, moveViewMechanic, registerViewMechanic, removeViewMechanic } from '../src/web/view-files.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const view = { schemaVersion: 3, kind: 'view', workspaceId: 'sample-card-game', id: 'test-view', name: '测试视图', mechanicRegistrations: [{ mechanicId: 'hand', visible: true }], collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' };
async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rule-view-opening-'));
  const root = join(projectRoot, '.game-graph');
  let store;
  t.after(async () => { if (store) await store.close(); await rm(projectRoot, { recursive: true, force: true }); });
  await copyExampleFixture(projectRoot);
  store = await createWorkspaceStore(root);
  const api = (path, body) => path === '/api/workspace' ? store.read() : path === '/api/views' ? store.createView(body) : store.save(body);
  return { root, store, api };
}

test('重新打开同一个视图也读取最新规则；失败不会返回部分候选或修改原对象', async t => {
  const { root, api } = await fixture(t);
  const initial = await api('/api/workspace');
  await createAndRememberView(api, initial.revision, view, 'test.view.json');
  const first = await readOpening(api, view.id);
  assert.equal(first.snapshot.structuralPresentation, 'line');
  assert.equal(first.graph.structuralPresentation, 'line');
  const hand = first.workspace.mechanics.find(g => g.id === 'hand');
  await writeFile(join(root, 'mechanics/hand.mechanic.json'), JSON.stringify({ ...hand, name: '外部最新规则' }));
  const canonical = await readWorkspace(root, { verifyGeneratedCatalog: false });
  await publishCatalog(canonical.agentExportRoot, canonical);
  const second = await readOpening(api, view.id);
  assert.equal(second.workspace.mechanics.find(g => g.id === 'hand').name, '外部最新规则');
  assert.notEqual(second.workspace.revision, first.workspace.revision);
  const before = structuredClone(second);
  await rm(join(root, 'mechanics/hand.mechanic.json'));
  await assert.rejects(readOpening(api, view.id), { code: 'MISSING_REFERENCE' });
  assert.deepEqual(second, before);
  assert.throws(() => prepareOpening(first.workspace, 'absent'), /视图文件不存在/);
});

test('对象形式的视图打开请求使用其 ID，而不是把对象转为文件名', async t => {
  const { api } = await fixture(t);
  const initial = await api('/api/workspace');
  await createAndRememberView(api, initial.revision, view, 'test.view.json');
  const opened = await readOpening(api, { kind: 'view', id: view.id });
  assert.equal(opened.viewId, view.id);
});

test('打开 badge 视图携带结构展示设置，保存后重新打开仍保持且源文件字节不变', async t => {
  const { root, api } = await fixture(t);
  const initial = await api('/api/workspace');
  const definitionsBefore = await readFile(join(root, 'definitions.graph.json'), 'utf8');
  const mechanicBefore = await readFile(join(root, 'mechanics/hand.mechanic.json'), 'utf8');
  await createAndRememberView(api, initial.revision, { ...view, id: 'badge-view', structuralPresentation: 'badge' }, 'badge.view.json');
  let opened = await readOpening(api, 'badge-view');
  assert.equal(opened.snapshot.structuralPresentation, 'badge');
  assert.equal(opened.graph.structuralPresentation, 'badge');
  const saved = await api('/api/save', { revision: opened.workspace.revision, ...viewSaveRequest(opened.workspace, 'badge-view', opened.snapshot) });
  opened = await readOpening(async path => path === '/api/workspace' ? saved : api(path), 'badge-view');
  assert.equal(opened.snapshot.structuralPresentation, 'badge');
  assert.equal(await readFile(join(root, 'definitions.graph.json'), 'utf8'), definitionsBefore);
  assert.equal(await readFile(join(root, 'mechanics/hand.mechanic.json'), 'utf8'), mechanicBefore);
});

test('旧视图中的折叠记录仅兼容读取，不再影响图投影', async t => {
  const { api, root } = await fixture(t);
  const data = await api('/api/workspace');
  await api('/api/views', { revision: data.revision, document: { ...view, collapsedNodeIds: ['repel'] }, file: 'legacy-fold.view.json' });
  const opened = await readOpening(api, view.id);
  assert.deepEqual(opened.snapshot.collapsedNodeIds, []);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'legacy-fold.view.json'), 'utf8')).collapsedNodeIds, ['repel']);
});

test('创建成功但最近打开记录失败：明确报告文件已存在、不重复创建、不删除', async t => {
  const { root, api } = await fixture(t);
  const initial = await api('/api/workspace'); let creates = 0;
  await assert.rejects(createAndRememberView(async (path, body) => {
    if (path === '/api/views') creates++;
    if (path === '/api/save') throw Object.assign(new Error('响应丢失'), { code: 'SAVE_UNCERTAIN' });
    return api(path, body);
  }, initial.revision, view, 'kept.view.json'), error => error.code === 'VIEW_CREATED_UNBOUND' && /kept.view.json/.test(error.message));
  assert.equal(creates, 1);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'kept.view.json'), 'utf8')), view);
  assert.deepEqual((await api('/api/workspace')).manifest.lastView, initial.manifest.lastView);
});

test('最近打开写入响应丢失时拒绝候选，即使服务端已提交', async t => {
  const { api } = await fixture(t);
  const data = await api('/api/workspace');
  await api('/api/views', { revision: data.revision, document: view, file: 'test.view.json' });
  await assert.rejects(readOpening(async (path, body) => {
    const result = await api(path, body);
    if (body) throw Object.assign(new Error('写入结果待确认'), { code: 'SAVE_UNCERTAIN' });
    return result;
  }, view.id), { code: 'SAVE_UNCERTAIN' });
  assert.deepEqual((await api('/api/workspace')).manifest.lastView, { viewId: view.id });
  assert.equal((await readOpening(api)).viewId, view.id);
});

function queue() {
  let tail = Promise.resolve(), revision = 0;
  return operation => {
    const result = tail.then(async () => { const next = await operation(revision); revision = next.revision; });
    tail = result.catch(() => {}); return result;
  };
}

test('打开机制只显示自身，记录单文件最近打开，不改原视图文件', async t => {
  const { api, root } = await fixture(t);
  const initial = await api('/api/workspace');
  await createAndRememberView(api, initial.revision, { ...view, mechanicRegistrations: ['basic-rules', 'encounter', 'hand'].map(mechanicId => ({ mechanicId, visible: true })) }, 'saved.view.json');
  const bytes = await readFile(join(root, 'saved.view.json'), 'utf8');
  for (const id of ['basic-rules', 'encounter', 'hand']) {
    const opened = await readOpening(api, { kind: 'mechanic', id });
    assert.equal(opened.viewId, null); assert.equal(opened.activeId, id); assert.equal(opened.legacy, false);
    assert.deepEqual(opened.original.graphIds, [id]);
    assert.ok(opened.original.edges.every(edge => edge.steps.every(step => step.graphId === id)));
    assert.deepEqual((await readOpening(api)).snapshot.graphIds, [id]);
    assert.equal(await readFile(join(root, 'saved.view.json'), 'utf8'), bytes);
  }
  const returned = await readOpening(api, view.id);
  assert.deepEqual(returned.snapshot.mechanicRegistrations.map(item => item.mechanicId), ['basic-rules', 'encounter', 'hand']);
  assert.equal(returned.activeId, null);
});

test('旧内联叠加只预览，不在启动时改写；首次无记录仅打开一张机制', async t => {
  const { api, root } = await fixture(t);
  let workspace = await api('/api/workspace');
  assert.equal(prepareOpening(workspace).snapshot.graphIds.length, 1);
  const snapshot = { graphIds: ['hand', 'encounter'], activeLayerId: 'hand', collapsedNodeIds: [], positions: {} };
  workspace = await api('/api/save', { revision: workspace.revision, kind: 'workspace', document: { ...workspace.manifest, lastView: snapshot } });
  const bytes = await readFile(join(root, 'workspace.json'), 'utf8');
  const opened = await readOpening(api);
  assert.equal(opened.legacy, true); assert.equal(opened.activeId, null);
  assert.deepEqual(opened.snapshot.graphIds, snapshot.graphIds);
  assert.equal(await readFile(join(root, 'workspace.json'), 'utf8'), bytes);
});

test('view v3 始终优先使用自身位置；最新源规则不抢占视图布局', async t => {
  const { api, root } = await fixture(t);
  let workspace = await api('/api/workspace');
  const hand = workspace.mechanics.find(item => item.id === 'hand');
  workspace = await api('/api/save', { revision: workspace.revision, kind: 'mechanic', id: hand.id, document: { ...hand, positions: { evade: { x: 123, y: 456 } } } });
  await createAndRememberView(api, workspace.revision, { ...view, positions: { evade: { x: 1, y: 2 } } }, 'layout.view.json');
  const before = await readFile(join(root, 'layout.view.json'), 'utf8');
  let opened = await readOpening(api, view.id);
  assert.deepEqual(opened.snapshot.positions.evade, { x: 1, y: 2 });
  assert.equal('activeLayerId' in opened.snapshot, false);
  assert.equal(await readFile(join(root, 'layout.view.json'), 'utf8'), before);
  const ruleBytes = await readFile(join(root, 'mechanics/hand.mechanic.json'), 'utf8');
  opened.snapshot.positions.evade = { x: 333, y: 444 };
  workspace = await api('/api/save', { revision: opened.workspace.revision, ...viewSaveRequest(opened.workspace, view.id, opened.snapshot) });
  assert.equal(await readFile(join(root, 'mechanics/hand.mechanic.json'), 'utf8'), ruleBytes);
  await api('/api/save', { revision: workspace.revision, kind: 'mechanic', id: hand.id, document: { ...hand, name: '最新源机制', positions: { evade: { x: 900, y: 900 } } } });
  opened = await readOpening(api, view.id);
  assert.equal(opened.workspace.mechanics.find(item => item.id === hand.id).name, '最新源机制');
  assert.deepEqual(graphPositions(opened.workspace, opened.graph, opened.snapshot.positions).evade, { x: 333, y: 444 });
});

test('视图隐藏子机制保留位置；旧折叠记录不进入新快照', async t => {
  const { api, root } = await fixture(t);
  const initial = await api('/api/workspace');
  await createAndRememberView(api, initial.revision, { ...view, mechanicRegistrations: [{ mechanicId: 'hand', visible: true }, { mechanicId: 'encounter', visible: true }], collapsedNodeIds: ['repel'], positions: { melee: { x: 345, y: 678 } } }, 'members.view.json');
  const opened = await readOpening(api, view.id), previous = structuredClone(opened.snapshot);
  const before = await readFile(join(root, 'mechanics/hand.mechanic.json'), 'utf8');
  const next = changeViewVisibility(opened.workspace, previous, 'hand', false);
  assert.deepEqual(next.positions.melee, { x: 345, y: 678 });
  assert.deepEqual(next.positions.evade, previous.positions.evade); assert.deepEqual(next.collapsedNodeIds, []);
  let workspace = await api('/api/save', { revision: opened.workspace.revision, ...viewSaveRequest(opened.workspace, view.id, next) });
  workspace = await api('/api/save', { revision: workspace.revision, ...viewSaveRequest(workspace, view.id, previous) });
  assert.deepEqual(prepareOpening(workspace, view.id).snapshot, previous);
  assert.equal(await readFile(join(root, 'mechanics/hand.mechanic.json'), 'utf8'), before);
});

test('新出现节点位置与机制勾选顺序无关，已有视图位置保持不动', async t => {
  const { api } = await fixture(t);
  const workspace = await api('/api/workspace');
  const snapshot = { mechanicRegistrations: [], collapsedNodeIds: [], positions: {} };
  const a = registerViewMechanic(workspace, registerViewMechanic(workspace, snapshot, 'hand'), 'encounter');
  const b = registerViewMechanic(workspace, registerViewMechanic(workspace, snapshot, 'encounter'), 'hand');
  assert.deepEqual(a.positions, b.positions);
  a.positions.melee = { x: 765, y: 432 };
  assert.deepEqual(registerViewMechanic(workspace, a, 'basic-rules').positions.melee, a.positions.melee);
});

test('共用节点在子图切换中始终复用视图坐标，全部隐藏后再次显示也恢复原位', async t => {
  const { api } = await fixture(t);
  const workspace = await api('/api/workspace');
  const arranged = registerViewMechanic(workspace, registerViewMechanic(workspace, { mechanicRegistrations: [], collapsedNodeIds: [], positions: {} }, 'hand'), 'encounter');
  arranged.positions.melee = { x: 777, y: 333 };
  const handOnly = changeViewVisibility(workspace, arranged, 'encounter', false);
  assert.deepEqual(handOnly.positions.melee, { x: 777, y: 333 });
  const empty = changeViewVisibility(workspace, handOnly, 'hand', false);
  assert.deepEqual(empty.positions.melee, { x: 777, y: 333 });
  const encounterAgain = changeViewVisibility(workspace, empty, 'encounter', true);
  assert.deepEqual(encounterAgain.positions.melee, { x: 777, y: 333 });
});

test('视图成员排序不重排节点，移除成员仍保留其位置记忆', async t => {
  const { api } = await fixture(t), workspace = await api('/api/workspace');
  const snapshot = registerViewMechanic(workspace, registerViewMechanic(workspace,
    { mechanicRegistrations: [], collapsedNodeIds: [], positions: {} }, 'hand'), 'encounter');
  snapshot.positions.melee = { x: 901, y: 902 };
  const moved = moveViewMechanic(workspace, snapshot, 'encounter', 0);
  assert.deepEqual(moved.mechanicRegistrations.map(item => item.mechanicId), ['encounter', 'hand']);
  assert.deepEqual(moved.positions.melee, { x: 901, y: 902 });
  const removed = removeViewMechanic(workspace, moved, 'encounter');
  assert.deepEqual(removed.mechanicRegistrations.map(item => item.mechanicId), ['hand']);
  assert.deepEqual(removed.positions.melee, { x: 901, y: 902 });
});

test('旧折叠记录不再触发修复流程或改写视图文件', async t => {
  const { api, root } = await fixture(t);
  let workspace = await api('/api/workspace');
  workspace = await createAndRememberView(api, workspace.revision, { ...view, collapsedNodeIds: ['repel'] }, 'fold.view.json');
  const hand = workspace.mechanics.find(item => item.id === 'hand');
  await api('/api/save', { revision: workspace.revision, kind: 'mechanic', id: hand.id, document: { ...hand, edges: [...hand.edges, { id: 'repel-2-stamina', source: 'repel', target: 'stamina', relation: 'influence', sign: -1, inheritance: { mode: 'none' } }] } });
  const before = await readFile(join(root, 'fold.view.json'), 'utf8');
  const opened = await readOpening(api, view.id);
  assert.deepEqual(opened.snapshot.collapsedNodeIds, []);
  assert.equal(await readFile(join(root, 'fold.view.json'), 'utf8'), before);
  assert.deepEqual(JSON.parse(before).collapsedNodeIds, ['repel']);
});
test('连续自动保存捕获各自目标与快照，串行采用自身已确认版本', async () => {
  const sent = [], states = [];
  const autosave = new ViewAutosave(queue(), async body => { sent.push(body); return { revision: body.revision + 1 }; }, state => states.push(state));
  const snapshot = { mechanicRegistrations: [{ mechanicId: 'hand', visible: true }], collapsedNodeIds: [], positions: {} };
  const workspace = { views: [view, { ...view, id: 'other' }] };
  const a = autosave.save(viewSaveRequest(workspace, view.id, snapshot));
  snapshot.mechanicRegistrations.push({ mechanicId: 'basic-rules', visible: true });
  const b = autosave.save(viewSaveRequest(workspace, 'other', snapshot));
  snapshot.mechanicRegistrations.length = 0;
  await Promise.all([a, b]);
  assert.deepEqual(sent.map(body => [body.id, body.revision, body.document.mechanicRegistrations.map(item => item.mechanicId)]), [['test-view', 0, ['hand']], ['other', 1, ['hand', 'basic-rules']]]);
  assert.equal(states.at(-1), 'saved');
  assert.equal(states.filter(state => state === 'saved').length, 1);
});

test('首个自动保存失败后，已排队快照也停止；仅显式重读复位可继续', async () => {
  let calls = 0; const states = [];
  const failure = Object.assign(new Error('磁盘版本已改变'), { code: 'REVISION_CONFLICT' });
  const autosave = new ViewAutosave(queue(), async body => {
    calls++; if (calls === 1) throw failure; return { revision: body.revision + 1 };
  }, state => states.push(state));
  const request = { kind: 'view', id: view.id, document: view };
  const result = await Promise.allSettled([autosave.save(request), autosave.save(request)]);
  assert.ok(result.every(item => item.status === 'rejected' && item.reason === failure));
  assert.equal(calls, 1); assert.equal(autosave.blocked, true); assert.equal(states.at(-1), 'failed');
  await assert.rejects(autosave.save(request), failure); assert.equal(calls, 1);
  autosave.reset(); await autosave.save(request); assert.equal(calls, 2);
  autosave.pause(Object.assign(new Error('网络中断'), { code: 'SAVE_UNCERTAIN' }));
  assert.equal(states.at(-1), 'uncertain');
});
