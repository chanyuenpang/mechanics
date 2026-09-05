import test from 'node:test';
import assert from 'node:assert/strict';
import { auditGraphGeometryStrict, improveRouteGeometry, normalizeRouteLanes, routeGraphScore } from '../src/web/canvas.mjs';
import { settleGraphGeometry } from '../src/web/geometry-settle.mjs';

const syntheticGraph = ids => ({ nodes: [], edges: ids.map(id => ({ id, source: `${id}-s`, target: `${id}-t` })) });

test('车道一侧受阻时，只移动有空闲空间的中段', () => {
  const graph = syntheticGraph(['a', 'b', 'guard']);
  const routes = new Map([
    ['a', [{ x: 0, y: -80 }, { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: -80 }]],
    ['b', [{ x: 10, y: 100 }, { x: 10, y: 8 }, { x: 210, y: 8 }, { x: 210, y: 100 }]],
    ['guard', [{ x: 100, y: 25 }, { x: 100, y: 65 }]],
  ]);
  const before = structuredClone(routes), result = normalizeRouteLanes(graph, {}, routes);
  assert.equal(result.get('a')[1].y, -40);
  assert.equal(result.get('b')[1].y, 8);
  assert.deepEqual(result.get('guard'), before.get('guard'));
  assert.deepEqual(routes, before);
  const score = routeGraphScore(graph, {}, result);
  assert.deepEqual(score.slice(0, 4), [0, 0, 0, 0]);
  assert.equal(score[8], 0);
  assert.equal(normalizeRouteLanes(graph, {}, result), result);
});

test('减少共线重叠不能抵消分轨新增的交叉', () => {
  const graph = syntheticGraph(['a', 'b', 'g1', 'g2', 'g3']);
  const routes = new Map([
    ['a', [{ x: 0, y: -80 }, { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: -80 }]],
    ['b', [{ x: -10, y: 80 }, { x: -10, y: 0 }, { x: 210, y: 0 }, { x: 210, y: 80 }]],
    ...[30, 80, 130].map((x, index) => [`g${index + 1}`, [{ x, y: 10 }, { x, y: 40 }]]),
  ]);
  const before = routeGraphScore(graph, {}, routes), result = normalizeRouteLanes(graph, {}, routes);
  const after = routeGraphScore(graph, {}, result);
  assert.equal(after[1], 0);
  for (const index of [0, 1, 2, 3]) assert.ok(after[index] <= before[index]);
});

function detourCase(blocked = false) {
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }, ...(blocked ? [{ id: 'obstacle' }] : [])],
    edges: [{ id: 'ab', source: 'a', target: 'b' }] };
  const positions = { a: { x: 0, y: 0 }, b: { x: 500, y: 300 }, ...(blocked ? { obstacle: { x: 300, y: 0 } } : {}) };
  const sourcePort = { nodeId: 'a', otherId: 'b', side: 'right', slot: 0, port: { x: 166, y: 31 }, anchor: { x: 202, y: 31 } };
  const targetPort = { nodeId: 'b', otherId: 'a', side: 'top', slot: 0, port: { x: 583, y: 300 }, anchor: { x: 583, y: 264 } };
  const routes = new Map([['ab', { sourcePort, targetPort, points: [
    { x: 166, y: 31 }, { x: 230, y: 31 }, { x: 230, y: -120 }, { x: 700, y: -120 },
    { x: 700, y: 230 }, { x: 583, y: 230 }, { x: 583, y: 300 },
  ] }]]);
  return { graph, positions, routes };
}

test('合法但绕行的缓存路线会缩为固定端口的一拐路径', () => {
  const sample = detourCase(), before = structuredClone(sample);
  const result = settleGraphGeometry(sample);
  assert.deepEqual(routeGraphScore(sample.graph, result.positions, result.routes), [0, 0, 0, 0, 0, 1, 1, 0, 0, 686]);
  assert.deepEqual(result.positions, sample.positions);
  assert.deepEqual(result.routes.get('ab').sourcePort, sample.routes.get('ab').sourcePort);
  assert.deepEqual(result.routes.get('ab').targetPort, sample.routes.get('ab').targetPort);
  assert.deepEqual(sample, before);
  assert.equal(improveRouteGeometry(sample.graph, result.positions, result.routes), result.routes);
});

test('捷径被节点阻挡时保留必要绕障，不穿过节点换取短线', () => {
  const sample = detourCase(true), result = settleGraphGeometry(sample);
  const audit = auditGraphGeometryStrict(sample.graph, result.positions, result.routes);
  assert.equal(audit.ok, true);
  assert.ok(result.routes.get('ab').points.length > 3);
  assert.deepEqual(result.positions, sample.positions);
});

test('端口由局部计算预留时，几何后处理只简化路径而不换面', () => {
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'ab', source: 'a', target: 'b' }] };
  const positions = { a: { x: 0, y: 0 }, b: { x: 500, y: 0 } };
  const endpoint = (nodeId, otherId, x) => ({ nodeId, otherId, side: 'bottom', slot: 0,
    port: { x, y: 62 }, anchor: { x, y: 98 } });
  const routes = new Map([['ab', { sourcePort: endpoint('a', 'b', 83), targetPort: endpoint('b', 'a', 583),
    points: [{ x: 83, y: 62 }, { x: 83, y: 120 }, { x: 583, y: 120 }, { x: 583, y: 62 }] }]]);
  const fixed = improveRouteGeometry(graph, positions, routes, { allowPortChanges: false });
  assert.equal(fixed, routes);
  const free = improveRouteGeometry(graph, positions, routes);
  assert.equal(free.get('ab').points.length, 2);
  assert.equal(free.get('ab').sourcePort.side, 'right');
  assert.equal(routes.get('ab').sourcePort.side, 'bottom');
  assert.equal(auditGraphGeometryStrict(graph, positions, fixed).ok, true);
  assert.equal(auditGraphGeometryStrict(graph, positions, free).ok, true);
});
