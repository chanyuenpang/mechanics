import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, tracePaths, canCollapse, diagnose, upgradeAnalysis } from '../src/domain/graph.mjs';
import { assertDocument, validateWorkspace } from '../src/domain/validate.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { changeViewMembers, prepareOpening } from '../src/web/view-files.mjs';

const edge = (source, target, relation = 'contains', sign = -1) => ({ id: source + '-' + target, source, target, relation,
  ...(relation === 'influence' ? { sign } : {}), condition: '测试前提', note: '人工构造' });
function model(edges) {
  const ids = ['p', 'c', 's', 'x', 'y', 'g'];
  return {
    manifest: { schemaVersion: 3, kind: 'workspace', id: 'sample', name: '测试', definitions: 'definitions.graph.json', compositions: [] },
    definitions: { schemaVersion: 1, kind: 'definitions', workspaceId: 'sample', nodes: ids.map(id => ({ id, label: id, description: '测试', increaseMeaning: '作用增加' })), positions: {} },
    analyses: [{ schemaVersion: 2, kind: 'analysis', workspaceId: 'sample', id: 'rule', name: '研究', scope: '人工构造', nodeIds: ids, edges, positions: {} }], views: [],
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
test('不反向、跨兄弟或从包含起步继承输出，纯包含链没有正负号', () => {
  const graph = compose(model([edge('p', 'c'), edge('p', 's'), edge('x', 'c', 'influence'), edge('p', 'y', 'influence'), edge('c', 'g', 'influence')]), ['rule']);
  for (const [a, b] of [['x', 'p'], ['x', 's'], ['c', 'y'], ['p', 'g']]) assert.deepEqual(tracePaths(graph, a, b).paths, []);
  const path = tracePaths(graph, 'p', 'c').paths[0];
  assert.equal(path.kind, 'containment'); assert.equal('sign' in path, false);
  assert.equal(canCollapse(graph, 'c'), false);
  const only = compose(model([edge('p', 'c')]), ['rule']);
  assert.ok(!diagnose(only).findings.some(f => f.kind === 'sink' && f.nodeIds.includes('c')));
});
test('多父类和相反作用分别保留，选图范围决定继承，不生成持久化派生边', () => {
  const data = model([edge('x', 'p', 'influence', 1), edge('x', 's', 'influence', -1)]);
  data.analyses.push({ ...structuredClone(data.analyses[0]), id: 'types', edges: [edge('p', 'c'), edge('s', 'c')] });
  const before = JSON.stringify(data);
  assert.deepEqual(tracePaths(compose(data, ['rule']), 'x', 'c').paths, []);
  assert.deepEqual(tracePaths(compose(data, ['types', 'rule']), 'x', 'c').paths.map(p => p.sign).sort(), [-1, 1]);
  assert.equal(JSON.stringify(data), before);
});
test('已知 v1 只在显式草稿升级时转 v2，结构分支严格互斥', () => {
  const data = model([edge('x', 'p', 'influence')]), old = data.analyses[0];
  old.schemaVersion = 1; delete old.edges[0].relation;
  const before = JSON.stringify(old);
  assertDocument(old, 'analysis'); compose(data, ['rule']);
  assert.equal(JSON.stringify(old), before);
  const upgraded = upgradeAnalysis(old); assertDocument(upgraded, 'analysis');
  assert.equal(upgraded.schemaVersion, 2); assert.equal(upgraded.edges[0].relation, 'influence');
  assert.equal(JSON.stringify(old), before);
  for (const mutate of [
    d => { d.edges[0].relation = 'unknown'; }, d => { d.edges[0].sign = 0; },
    d => { delete d.edges[0].sign; }, d => { d.edges[0].relation = 'contains'; },
    d => { d.schemaVersion = 7; }, d => { d.schemaVersion = 1; },
  ]) { const invalid = structuredClone(upgraded); mutate(invalid); assert.throws(() => assertDocument(invalid, 'analysis')); }
});
test('包含自环和跨图环明确拒绝，无效组合不妨碍单独打开研究', () => {
  assert.throws(() => validateWorkspace(model([edge('p', 'p')])), { code: 'CONTAINMENT_CYCLE' });
  const data = model([edge('p', 'c')]);
  data.analyses.push({ ...structuredClone(data.analyses[0]), id: 'reverse', edges: [edge('c', 'p')] });
  data.views.push({ schemaVersion: 1, kind: 'view', workspaceId: 'sample', id: 'view', name: '视图', graphIds: ['rule', 'reverse'], activeLayerId: null, positions: {}, collapsedNodeIds: [] });
  validateWorkspace(data);
  const before = JSON.stringify(data);
  assert.throws(() => compose(data, ['rule', 'reverse']), error => error.code === 'CONTAINMENT_CYCLE' && error.message.includes('reverse/c-p') && error.message.includes('rule/p-c'));
  assert.throws(() => prepareOpening(data, 'view'), { code: 'CONTAINMENT_CYCLE' });
  assert.equal(prepareOpening(data, { kind: 'analysis', id: 'rule' }).activeId, 'rule');
  assert.throws(() => changeViewMembers(data, data.views[0], ['rule', 'reverse']), { code: 'CONTAINMENT_CYCLE' });
  assert.equal(JSON.stringify(data), before);
});
test('实际保存只升级指定研究；视图成环保存拒绝且源研究仍可修复', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rule-contains-'));
  await cp(new URL('../examples/card-game/', import.meta.url), root, { recursive: true });
  const store = await createWorkspaceStore(root);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  let workspace = await store.read();
  const before = await readFile(join(root, 'analyses/basic-rules.analysis.json'));
  const old = structuredClone(workspace.analyses.find(g => g.id === 'hand'));
  old.positions.evade = { x: 20, y: 30 };
  workspace = await store.save({ revision: workspace.revision, kind: 'analysis', id: old.id, document: old });
  assert.equal(workspace.analyses.find(g => g.id === 'hand').schemaVersion, 1);
  const upgraded = upgradeAnalysis(old); upgraded.edges.push({ ...edge('evade', 'repel'), id: 'contains-repel' });
  workspace = await store.save({ revision: workspace.revision, kind: 'analysis', id: old.id, document: upgraded });
  assert.equal(workspace.analyses.find(g => g.id === 'hand').schemaVersion, 2);
  assert.deepEqual(await readFile(join(root, 'analyses/basic-rules.analysis.json')), before);
  const reverse = { ...structuredClone(upgraded), id: 'reverse', edges: [edge('repel', 'evade')] };
  workspace = await store.createAnalysis({ revision: workspace.revision, document: reverse });
  const view = { schemaVersion: 1, kind: 'view', workspaceId: workspace.manifest.id, id: 'invalid', name: '无效组合', graphIds: ['hand', 'reverse'], activeLayerId: null, positions: {}, collapsedNodeIds: [] };
  await assert.rejects(store.createView({ revision: workspace.revision, document: view, file: 'invalid.view.json' }), { code: 'CONTAINMENT_CYCLE' });
  assert.equal((await store.read()).revision, workspace.revision);
  reverse.edges = [];
  await store.save({ revision: workspace.revision, kind: 'analysis', id: 'reverse', document: reverse });
});
