import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { solveLayout, measureGeometry, MIN_ROUTE_SEGMENT, routeEndpointLengths, routeMeetsMinimum } from '../src/web/hierarchical-layout.mjs';
import { routeLocalGraph } from '../src/web/local-routing.mjs';

test('短线、零长度与长路线的过短尾段都不满足30px合同', () => {
  assert.equal(MIN_ROUTE_SEGMENT, 30);
  for (const length of [0, 12, 28, 29.9]) assert.equal(routeMeetsMinimum([{ x: 0, y: 0 }, { x: length, y: 0 }]), false);
  assert.equal(routeMeetsMinimum([{ x: 0, y: 0 }, { x: 30, y: 0 }]), true);
  assert.equal(routeMeetsMinimum([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 2 }]), false);
});

test('拖动挤窄折线通道后，通过相邻侧端口的一次转弯保留30px接入段', async () => {
  const graph = { nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({ id })),
    edges: [['a', 'b'], ['b', 'c'], ['b', 'd'], ['b', 'e'], ['f', 'g']]
      .map(([source, target], i) => ({ id: 'e' + i, source, target })) };
  const previous = { a: { x: 160, y: 240 }, b: { x: 406, y: 240 }, c: { x: 660, y: 130 },
    d: { x: 660, y: 526 }, e: { x: 652, y: 240 }, f: { x: 2000, y: 240 }, g: { x: 2300, y: 240 } };
  const cached = new Map([
    ['e0', [[326, 271], [406, 271]]],
    ['e1', [[572, 252.4], [630, 252.4], [630, 161], [660, 161]]],
    ['e2', [[572, 289.6], [630, 289.6], [630, 557], [660, 557]]],
    ['e3', [[572, 271], [652, 271]]],
    ['e4', [[2166, 271], [2300, 271]]],
  ].map(([id, coordinates]) => [id, { points: coordinates.map(([x, y]) => ({ x, y })) }]));
  const positions = { ...previous, a: { x: 240, y: 260 } };
  const result = await routeLocalGraph({ graph, positions, previousPositions: previous, movedIds: ['a'], cachedRoutes: cached });
  assert.deepEqual(result.positions.a, positions.a);
  assert.deepEqual(result.shiftedIds, ['b']);
  for (const id of ['c', 'd', 'e', 'f', 'g']) assert.equal(result.positions[id], previous[id]);
  assert.equal(result.routes.get('e4'), cached.get('e4'));
  for (const [id, route] of result.routes) assert.ok(routeMeetsMinimum(route.points), id);
  assert.ok(['e1', 'e2'].some(id => result.routes.get(id).points.length === 3), '空间不足的折线可以改为一次转弯');
  const metrics = measureGeometry(graph, { positions: result.positions, routes: [...result.routes],
    sizes: Object.fromEntries(graph.nodes.map(node => [node.id, { width: 166, height: 62 }])) });
  assert.equal(metrics.nodeHits + metrics.invalid + metrics.missing + metrics.selfCrossings, 0);
});

test('实际ELK复合节点的内部连线和跨组连线均保留30px首尾段', async () => {
  const graph = { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })),
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'c']].map(([source, target], i) => ({ id: 'e' + i, source, target })) };
  const result = await solveLayout(graph, 'explicit', { ELK, clusters: [['a', 'b'], ['c', 'd']] });
  assert.ok(result.geometry.groups.length > 0);
  for (const [id, route] of result.geometry.routes) assert.ok(routeMeetsMinimum(route.points), id + JSON.stringify(routeEndpointLengths(route.points)));
});

for (const gap of [0, 12, 28]) test(`拖动使节点间只剩${gap}px时，固定落点并把直接近邻推到30px`, async () => {
  const graph = { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })),
    edges: [['a', 'b'], ['b', 'a'], ['c', 'd']].map(([source, target], i) => ({ id: 'e' + i, source, target })) };
  const previous = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, c: { x: 0, y: 600 }, d: { x: 400, y: 600 } };
  const cached = await routeLocalGraph({ graph, positions: previous });
  const positions = { ...previous, b: { x: 166 + gap, y: 0 } };
  const result = await routeLocalGraph({ graph, positions, previousPositions: previous, movedIds: ['b'], cachedRoutes: cached.routes });
  assert.deepEqual(result.positions.b, positions.b);
  assert.deepEqual(result.shiftedIds, ['a']);
  assert.equal(result.positions.b.x - result.positions.a.x - 166, 30);
  for (const id of ['e0', 'e1']) {
    assert.equal(result.routes.get(id).points.length, 2, '直接增加节点间距，不用绕路凑长度');
    assert.deepEqual(routeEndpointLengths(result.routes.get(id).points), { first: 30, last: 30 });
  }
  assert.equal(result.routes.get('e2'), cached.routes.get('e2'));
  assert.equal(result.positions.c, previous.c); assert.equal(result.positions.d, previous.d);
});
