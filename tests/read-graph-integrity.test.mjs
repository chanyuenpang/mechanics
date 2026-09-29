import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReadGraphIntegrity } from '../src/domain/read-graph-integrity.mjs';
import { composeProjection } from '../src/domain/graph.mjs';
import { projectEndpointQualifiers } from '../src/domain/endpoint-projection.mjs';
import { projectDisplayGraph } from '../src/domain/taxonomy-presentation.mjs';
import { modularHierarchy } from '../src/web/layout-structure.mjs';
import { arrangeGraph, arrangeGraphWithRoutes } from '../src/web/layout.mjs';
import { computeGraphTask } from '../src/web/graph-compute-kernel.mjs';

const nodes = [{ id: 'actor', label: '参与者' }, { id: 'result', label: '结果' }];
const edge = { id: 'actor-2-result', source: 'actor', target: 'result', relation: 'influence' };

test('读取图拒绝任意方向的缺失端点并报告阶段、规则与缺失节点', () => {
  for (const endpoint of ['source', 'target']) {
    const bad = { nodes, edges: [{ ...edge, [endpoint]: 'absent' }] };
    assert.throws(() => assertReadGraphIntegrity(bad, '人工阶段'), error =>
      error.code === 'READ_GRAPH_MISSING_ENDPOINT' && error.stage === '人工阶段'
      && error.edgeId === edge.id && error.endpoint === endpoint && error.nodeId === 'absent'
      && error.message.includes('absent'));
    for (const [name, project] of [
      ['端点限定投影输入', projectEndpointQualifiers],
      ['显示投影输入', graph => projectDisplayGraph(graph, { taxonomyPresentation: { expandedNodeIds: [] } })],
    ]) assert.throws(() => project(bad), error => error.code === 'READ_GRAPH_MISSING_ENDPOINT' && error.stage === name);
  }
});

test('无效节点 ID 不能伪装成存在的边端点', () => {
  assert.throws(() => assertReadGraphIntegrity({ nodes: [{ id: undefined }], edges: [{ ...edge, source: undefined }] }, '人工阶段'),
    { code: 'READ_GRAPH_INVALID_NODE', stage: '人工阶段' });
});

test('重复节点 ID 不能被映射覆盖，包括没有边的图', () => {
  const bad = { nodes: [nodes[0], { ...nodes[0] }], edges: [] };
  assert.throws(() => assertReadGraphIntegrity(bad, '人工阶段'), error =>
    error.code === 'READ_GRAPH_DUPLICATE_NODE' && error.nodeId === 'actor' && error.stage === '人工阶段');
  assert.throws(() => projectEndpointQualifiers(bad), { code: 'READ_GRAPH_DUPLICATE_NODE' });
  assert.throws(() => projectDisplayGraph(bad), { code: 'READ_GRAPH_DUPLICATE_NODE' });
});

test('合成投影拒绝未定义的规则端点，而非把断边交给布局', () => {
  const workspace = { definitions: { nodes }, rules: { rules: [{ ...edge, target: 'absent' }] }, mechanics: [{ id: 'demo', focusNodeIds: ['actor'], pinnedRuleIds: [edge.id] }] };
  assert.throws(() => composeProjection(workspace, { graphIds: ['demo'] }), error =>
    error.code === 'READ_GRAPH_MISSING_ENDPOINT' && error.stage === '合成投影' && error.nodeId === 'absent');
});

test('坏图在布局及 Worker 路由入口明确失败，不启动求解也不改传入位置', async () => {
  const bad = { nodes, edges: [{ ...edge, target: 'absent' }] };
  const positions = { actor: { x: 0, y: 0 }, result: { x: 200, y: 0 } };
  const original = structuredClone(positions);
  let called = false;
  const ELK = () => { called = true; throw new Error('不应进入求解器'); };
  assert.throws(() => modularHierarchy(bad), error => error.code === 'READ_GRAPH_MISSING_ENDPOINT' && error.stage === '模块分组输入');
  for (const compute of [
    () => arrangeGraph({ graph: bad, positions, ELK }),
    () => arrangeGraphWithRoutes({ graph: bad, positions, ELK }),
    () => computeGraphTask({ kind: 'layout', payload: { graph: bad, positions } }, { ELK }),
    () => computeGraphTask({ kind: 'route', payload: { graph: bad, positions } }, { ELK }),
  ]) await assert.rejects(compute(), { code: 'READ_GRAPH_MISSING_ENDPOINT' });
  assert.equal(called, false);
  assert.deepEqual(positions, original);
});

test('分类隐藏边仍合法，孤立焦点节点不会被完整性检查删除', () => {
  const input = { nodes, edges: [{ ...edge, relation: 'specializes' }] };
  const projected = projectDisplayGraph(input, { taxonomyPresentation: { expandedNodeIds: [] }, retainedNodeIds: ['actor'] });
  assert.deepEqual(projected.nodes.map(node => node.id), ['actor']);
  assert.deepEqual(projected.edges, []);
  assert.equal(assertReadGraphIntegrity({ nodes: [nodes[0]], edges: [] }, '孤立焦点').nodes.length, 1);
});
