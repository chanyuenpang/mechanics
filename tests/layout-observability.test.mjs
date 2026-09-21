import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { arrangeGraphWithRoutes } from '../src/web/layout.mjs';
import { flowSubtrees } from '../src/web/flow-refinement.mjs';

const graph = {
  nodes: ['root', 'left', 'right', 'leaf'].map(id => ({ id })),
  edges: [['left', 'root'], ['right', 'root'], ['leaf', 'left']]
    .map(([source, target], index) => ({ id: `edge-${index}`, source, target, relation: 'specializes' })),
};
const positions = Object.fromEntries(graph.nodes.map((node, index) => [node.id, { x: index * 200, y: 0 }]));

test('完整布局按阶段报告耗时，并保留既有 timings 输出', async () => {
  const events = [], timings = {};
  const result = await arrangeGraphWithRoutes({ graph, positions, ELK, timings, onPhase: event => events.push(event) });
  assert.equal(Object.keys(result.positions).length, graph.nodes.length);
  assert.deepEqual(events.map(event => `${event.phase}:${event.status}`), [
    'hierarchy:started', 'hierarchy:completed', 'flow:started', 'flow:completed', 'compactGrid:started', 'compactGrid:completed',
  ]);
  for (const phase of ['hierarchy', 'flow', 'compactGrid']) assert.ok(timings[phase] >= 0, phase);
});

test('布局在开始计算前确认取消，且不会产生阶段完成事件', async () => {
  const controller = new AbortController(), events = [];
  controller.abort();
  await assert.rejects(arrangeGraphWithRoutes({ graph, positions, ELK, signal: controller.signal, onPhase: event => events.push(event) }),
    error => error?.name === 'AbortError' && error?.code === 'COMPUTE_CANCELLED');
  assert.deepEqual(events, []);
});

test('布局在阶段边界取消，后续阶段不会开始', async () => {
  const controller = new AbortController(), events = [];
  await assert.rejects(arrangeGraphWithRoutes({ graph, positions, ELK, signal: controller.signal, onPhase: event => {
    events.push(event);
    if (event.phase === 'hierarchy' && event.status === 'completed') controller.abort();
  } }), error => error?.code === 'COMPUTE_CANCELLED');
  assert.deepEqual(events.map(event => `${event.phase}:${event.status}`), ['hierarchy:started', 'hierarchy:completed']);
});

test('高扇出分类分支不作为局部流向候选重新求解', () => {
  const leaves = Array.from({ length: 17 }, (_, index) => `leaf-${index}`);
  const highFanout = { nodes: ['root', 'category', ...leaves].map(id => ({ id })), edges: [
    { id: 'category-root', source: 'category', target: 'root' },
    ...leaves.map(id => ({ id: `${id}-category`, source: id, target: 'category' })),
  ] };
  const candidates = flowSubtrees(highFanout);
  assert.ok(candidates.every(candidate => candidate.members.length <= 16));
  assert.equal(candidates.some(candidate => candidate.members.includes('category') && candidate.members.length > 1), false);
});

test('超过局部路由容量时保留已审计几何，不触发全量网格重路由', async () => {
  const leaves = Array.from({ length: 129 }, (_, index) => `item-${index}`);
  const highFanout = { nodes: ['root', ...leaves].map(id => ({ id })),
    edges: leaves.map(id => ({ id: `${id}-root`, source: id, target: 'root', relation: 'specializes' })) };
  const start = Object.fromEntries(highFanout.nodes.map((node, index) => [node.id, { x: (index % 16) * 220, y: Math.floor(index / 16) * 100 }]));
  const result = await arrangeGraphWithRoutes({ graph: highFanout, positions: start, ELK });
  assert.equal(Object.keys(result.positions).length, highFanout.nodes.length);
  assert.equal(result.routes.size, highFanout.edges.length);
  assert.ok(result.warnings?.some(message => message.includes('保留已审计的非网格几何')));
});
