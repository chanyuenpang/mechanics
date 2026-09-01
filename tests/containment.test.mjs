import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, tracePaths, canCollapse, diagnose, downstreamNodes } from '../src/domain/graph.mjs';
import { assertDocument, validateWorkspace } from '../src/domain/validate.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { changeViewVisibility, prepareOpening } from '../src/web/view-files.mjs';

const edge = (source, target, relation = 'contains', sign = -1) => ({ id: source + '-' + target, source, target, relation,
  ...(relation === 'influence' ? { sign } : {}), condition: '测试前提', note: '人工构造' });
function model(edges) {
  const ids = ['p', 'c', 's', 'x', 'y', 'g'];
  return {
    manifest: { schemaVersion: 4, kind: 'workspace', id: 'sample', name: '测试', definitions: 'definitions.graph.json', compositions: [] },
    definitions: { schemaVersion: 1, kind: 'definitions', workspaceId: 'sample', nodes: ids.map(id => ({ id, label: id, description: '测试', increaseMeaning: '作用增加' })), positions: {} },
    mechanics: [{ schemaVersion: 1, kind: 'mechanic', workspaceId: 'sample', id: 'rule', name: '机制', scope: '人工构造', nodeIds: ids, edges, positions: {} }], views: [],
  };
}
test('正负作用沿目标端包含链传递，包含步骤保留证据但不改变符号', () => {
  for (const sign of [1, -1]) {
    const data = model([edge('x', 'p', 'influence', sign), edge('p', 'c'), edge('c', 'g'), edge('g', 'y', 'influence', -1)]);
    validateWorkspace(data);
    const graph = compose(data, ['rule']);
    assert.equal(tracePaths(graph, 'x', 'g').paths[0].sign, sign);
    const path = tracePaths(graph, 'x', 'y').paths[0];
    assert.equal(path.sign, -sign); assert.equal(path.kind, 'influence');
    assert.deepEqual(path.steps.map(s => s.edgeId), ['x-p', 'p-c', 'c-g', 'g-y']);
    assert.ok(path.steps.every(s => s.graphId === 'rule' && s.condition === '测试前提' && s.note === '人工构造'));
    assert.equal(tracePaths(graph, 'x', 'y', { maxDepth: 3 }).truncated, true);
  }
});
test('等号前后均可接影响，但不能反向或跨共同来源扩散；纯等号没有正负号', () => {
  const graph = compose(model([edge('p', 'c'), edge('p', 's'), edge('x', 'c', 'influence'), edge('p', 'y', 'influence'), edge('c', 'g', 'influence')]), ['rule']);
  for (const [a, b] of [['x', 'p'], ['x', 's'], ['c', 'y'], ['c', 'p']]) assert.deepEqual(tracePaths(graph, a, b).paths, []);
  assert.equal(tracePaths(graph, 'p', 'g').paths[0].sign, -1);
  assert.deepEqual(downstreamNodes(graph, 'c').map(node => node.id).sort(), ['g']);
  assert.deepEqual(tracePaths(graph, 'y', 'c').paths, []);
  const path = tracePaths(graph, 'p', 'c').paths[0];
  assert.equal(path.kind, 'containment'); assert.equal('sign' in path, false);
  assert.equal(canCollapse(graph, 'c'), false);
  const only = compose(model([edge('p', 'c')]), ['rule']);
  assert.ok(!diagnose(only).findings.some(f => f.kind === 'sink' && f.nodeIds.includes('c')));
});
test('多父类和相反作用分别保留，选图范围决定继承，不生成持久化派生边', () => {
  const data = model([edge('x', 'p', 'influence', 1), edge('x', 's', 'influence', -1)]);
  data.mechanics.push({ ...structuredClone(data.mechanics[0]), id: 'types', edges: [edge('p', 'c'), edge('s', 'c')] });
  const before = JSON.stringify(data);
  assert.deepEqual(tracePaths(compose(data, ['rule']), 'x', 'c').paths, []);
  assert.deepEqual(tracePaths(compose(data, ['types', 'rule']), 'x', 'c').paths.map(p => p.sign).sort(), [-1, 1]);
  assert.equal(JSON.stringify(data), before);
});

test('具体资源汇入通用资源，不反向影响另一类；具体行为消耗保留负号', () => {
  // c/s 是两类资源，p 是通用资源，x 是具体行动，y 是通用出牌。
  const graph = compose(model([edge('c', 'p'), edge('s', 'p'), edge('x', 'c', 'influence', -1), edge('p', 'y', 'influence', 1)]), ['rule']);
  assert.equal(tracePaths(graph, 'x', 'p').paths[0].sign, -1);
  assert.equal(tracePaths(graph, 'x', 'y').paths[0].sign, -1);
  for (const [from, to] of [['c', 's'], ['s', 'c'], ['p', 'c'], ['x', 's']]) assert.deepEqual(tracePaths(graph, from, to).paths, []);
  assert.deepEqual(downstreamNodes(graph, 'c').map(n => n.id).sort(), ['p', 'y']);
});
test('正式机制协议只有 v1，关系结构严格互斥', () => {
  const current = model([edge('x', 'p', 'influence')]).mechanics[0];
  assertDocument(current, 'mechanic');
  for (const mutate of [
    d => { d.edges[0].relation = 'unknown'; }, d => { d.edges[0].sign = 0; },
    d => { delete d.edges[0].sign; }, d => { d.edges[0].relation = 'contains'; },
    d => { d.schemaVersion = 2; },
  ]) { const invalid = structuredClone(current); mutate(invalid); assert.throws(() => assertDocument(invalid, 'mechanic')); }
});
test('包含自连接拒绝；跨图闭环允许且简单路径查询不会无限循环', () => {
  assert.throws(() => validateWorkspace(model([edge('p', 'p')])), { code: 'CONTAINMENT_SELF_LINK' });
  const data = model([edge('p', 'c')]);
  data.mechanics.push({ ...structuredClone(data.mechanics[0]), id: 'reverse', edges: [edge('c', 'p')] });
  data.views.push({ schemaVersion: 2, kind: 'view', workspaceId: 'sample', id: 'view', name: '视图', mechanicRegistrations: [{ mechanicId: 'rule', visible: true }, { mechanicId: 'reverse', visible: true }], positions: {}, collapsedNodeIds: [] });
  validateWorkspace(data);
  const before = JSON.stringify(data);
  const graph = compose(data, ['rule', 'reverse']);
  assert.equal(tracePaths(graph, 'c', 'p').paths.length, 1);
  assert.equal(tracePaths(graph, 'c', 'x').paths.length, 0);
  assert.equal(tracePaths(graph, 'c', 'p', { maxPaths: 1 }).truncated, false);
  assert.equal(prepareOpening(data, 'view').viewId, 'view');
  assert.equal(prepareOpening(data, { kind: 'mechanic', id: 'rule' }).activeId, 'rule');
  assert.doesNotThrow(() => changeViewVisibility(data, data.views[0], 'reverse', true));
  assert.equal(JSON.stringify(data), before);
});
test('实际保存只修改指定机制；显式两条单向等号形成的闭环视图可以保存并回读', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rule-contains-'));
  await cp(new URL('../examples/card-game/', import.meta.url), root, { recursive: true });
  const store = await createWorkspaceStore(root);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  let workspace = await store.read();
  const before = await readFile(join(root, 'mechanics/basic-rules.mechanic.json'));
  const old = structuredClone(workspace.mechanics.find(g => g.id === 'hand'));
  old.positions.evade = { x: 20, y: 30 };
  workspace = await store.save({ revision: workspace.revision, kind: 'mechanic', id: old.id, document: old });
  assert.equal(workspace.mechanics.find(g => g.id === 'hand').schemaVersion, 1);
  const updated = structuredClone(old); updated.edges.push({ ...edge('evade', 'repel'), id: 'contains-repel' });
  workspace = await store.save({ revision: workspace.revision, kind: 'mechanic', id: old.id, document: updated });
  assert.equal(workspace.mechanics.find(g => g.id === 'hand').schemaVersion, 1);
  assert.deepEqual(await readFile(join(root, 'mechanics/basic-rules.mechanic.json')), before);
  const reverse = { ...structuredClone(updated), id: 'reverse', edges: [edge('repel', 'evade')] };
  workspace = await store.createMechanic({ revision: workspace.revision, document: reverse });
  const view = { schemaVersion: 2, kind: 'view', workspaceId: workspace.manifest.id, id: 'cycle', name: '等号组合', mechanicRegistrations: [{ mechanicId: 'hand', visible: true }, { mechanicId: 'reverse', visible: true }], positions: {}, collapsedNodeIds: [] };
  workspace = await store.createView({ revision: workspace.revision, document: view, file: 'cycle.view.json' });
  assert.equal((await store.read()).views[0].id, 'cycle');
  reverse.edges = [];
  await store.save({ revision: workspace.revision, kind: 'mechanic', id: 'reverse', document: reverse });
});
