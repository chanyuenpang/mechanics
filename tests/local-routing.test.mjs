import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { routeLocalGraph } from '../src/web/local-routing.mjs';
import { arrangeGraphWithRoutes } from '../src/web/layout.mjs';
import { improveFlowBySubtrees, flowMetrics, compactHorizontalRoutes } from '../src/web/flow-refinement.mjs';
import { measureGeometry, qualityVector, routeMeetsMinimum } from '../src/web/hierarchical-layout.mjs';

const graphOf = (ids, edges) => ({ nodes: ids.map(id => ({ id })),
  edges: edges.map(([source, target]) => ({ id: source + '-' + target, source, target })) });
const geometry = (graph, result) => ({ positions: result.positions, routes: [...result.routes],
  sizes: Object.fromEntries(graph.nodes.map(node => [node.id, { width: 166, height: 62 }])) });
const valid = (graph, result) => assert.equal(qualityVector(measureGeometry(graph, geometry(graph, result)))[0], 0);

test('拖动孤立节点挡住已有路线，只处理被挡的边，外围对象保持原样', async () => {
  const graph = graphOf(['a', 'b', 'c', 'd', 'z'], [['a', 'b'], ['c', 'd']]);
  const before = { a: { x: 0, y: 0 }, b: { x: 600, y: 0 }, c: { x: 0, y: 500 },
    d: { x: 600, y: 500 }, z: { x: -400, y: 250 } };
  const cached = await routeLocalGraph({ graph, positions: before });
  const positions = { ...before, z: { x: 300, y: 0 } };
  const result = await routeLocalGraph({ graph, positions, previousPositions: before, cachedRoutes: cached.routes, movedIds: ['z'] });
  assert.deepEqual(result.positions, positions);
  assert.deepEqual(result.edgeIds, ['a-b']);
  assert.equal(result.full, false);
  assert.equal(result.routes.get('c-d'), cached.routes.get('c-d'));
  assert.notDeepEqual(result.routes.get('a-b'), cached.routes.get('a-b'));
  valid(graph, result);
});

test('落点发生碰撞时只让直接近邻挪位，拖动节点与远处节点固定', async () => {
  const graph = graphOf(['a', 'b', 'c', 'd', 'z'], [['a', 'b'], ['c', 'd']]);
  const before = { a: { x: 0, y: 0 }, b: { x: 600, y: 0 }, c: { x: 0, y: 500 },
    d: { x: 600, y: 500 }, z: { x: -400, y: 250 } };
  const cached = await routeLocalGraph({ graph, positions: before });
  const positions = { ...before, z: { x: 10, y: 10 } };
  const result = await routeLocalGraph({ graph, positions, previousPositions: before, cachedRoutes: cached.routes, movedIds: ['z'] });
  assert.deepEqual(result.shiftedIds, ['a']);
  assert.deepEqual(result.positions.z, positions.z);
  for (const id of ['b', 'c', 'd']) assert.equal(result.positions[id], positions[id]);
  assert.equal(result.routes.get('c-d'), cached.routes.get('c-d'));
  assert.deepEqual(before.a, { x: 0, y: 0 });
  valid(graph, result);
});

test('几何没有变化时不重新生成任何缓存路线', async () => {
  const graph = graphOf(['a', 'b'], [['a', 'b']]), positions = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } };
  const cached = await routeLocalGraph({ graph, positions });
  const result = await routeLocalGraph({ graph, positions, cachedRoutes: cached.routes });
  assert.deepEqual(result.edgeIds, []);
  assert.equal(result.routes.get('a-b'), cached.routes.get('a-b'));
});

test('选中子图重新整理，外围节点和独立边均保持精确几何', async () => {
  const graph = graphOf(['a', 'b', 'c', 'd', 'e'], [['a', 'b'], ['b', 'c'], ['d', 'e']]);
  const positions = { a: { x: 500, y: 0 }, b: { x: 250, y: 0 }, c: { x: 900, y: 0 },
    d: { x: 0, y: 800 }, e: { x: 400, y: 800 } };
  const cached = await routeLocalGraph({ graph, positions });
  const result = await arrangeGraphWithRoutes({ graph, positions, selectedIds: ['a', 'b'], cachedRoutes: cached.routes, ELK });
  for (const id of ['c', 'd', 'e']) assert.deepEqual(result.positions[id], positions[id]);
  assert.equal(result.routes.get('d-e'), cached.routes.get('d-e'));
  valid(graph, result);
});

test('子树方向迭代减少回流且不增加交叉，独立的正向分量原样保留', async () => {
  const graph = graphOf(['a', 'b', 'c', 'x', 'y'], [['b', 'a'], ['a', 'c'], ['x', 'y']]);
  const positions = { a: { x: 250, y: 0 }, b: { x: 500, y: 0 }, c: { x: 800, y: 0 },
    x: { x: 0, y: 700 }, y: { x: 400, y: 700 } };
  const base = geometry(graph, await routeLocalGraph({ graph, positions }));
  const result = await improveFlowBySubtrees(graph, base, { ELK });
  assert.ok(result.accepted.length > 0);
  assert.ok(result.metrics.backwardEdges < flowMetrics(graph, base).backwardEdges);
  assert.ok(result.metrics.crossings <= measureGeometry(graph, base).crossings);
  assert.ok(result.metrics.length <= measureGeometry(graph, base).length * 1.15);
  assert.equal(qualityVector(result.metrics)[0], 0);
  for (const id of ['x', 'y']) assert.deepEqual(result.geometry.positions[id], positions[id]);
  assert.deepEqual(new Map(result.geometry.routes).get('x-y'), new Map(base.routes).get('x-y'));
});

test('两个节点的单向关系整体翻转，30px短直线不会阻止方向修正', async () => {
  const graph = graphOf(['attack', 'participant'], [['participant', 'attack']]);
  const positions = { attack: { x: 0, y: 0 }, participant: { x: 196, y: 0 } };
  const base = geometry(graph, await routeLocalGraph({ graph, positions }));
  const result = await improveFlowBySubtrees(graph, base, { ELK });
  assert.equal(result.metrics.backwardEdges, 0);
  assert.equal(result.metrics.backwardLength, 0);
  assert.equal(result.metrics.length, 30, '整块翻转不应增加线长');
  assert.deepEqual(result.geometry.positions.participant, { x: 0, y: 0 });
  assert.deepEqual(result.geometry.positions.attack, { x: 196, y: 0 });
});

test('正式自动排版将双节点单向关系排成从左到右，独立于节点输入顺序', async () => {
  for (const ids of [['attack', 'participant'], ['participant', 'attack']]) {
    const graph = graphOf(ids, [['participant', 'attack']]);
    const result = await arrangeGraphWithRoutes({ graph, positions: { attack: { x: 0, y: 0 }, participant: { x: 196, y: 0 } }, ELK });
    assert.ok(result.positions.participant.x < result.positions.attack.x);
    assert.equal(result.positions.participant.y, result.positions.attack.y);
    const points = result.routes.get('participant-attack').points;
    assert.equal(points.length, 2);
    assert.ok(points[0].x < points[1].x);
    assert.ok(routeMeetsMinimum(points));
  }
});

test('超过16节点的反向区域无需求解器即可整体纠正，独立正向区域精确保持', async () => {
  const ids = Array.from({ length: 21 }, (_, i) => 'n' + i);
  const graph = graphOf([...ids, 'x', 'y'], [...ids.slice(1).map((id, i) => [ids[i], id]), ['x', 'y']]);
  const positions = Object.fromEntries(ids.map((id, i) => [id, { x: (20 - i) * 196, y: 0 }]));
  Object.assign(positions, { x: { x: 0, y: 700 }, y: { x: 196, y: 700 } });
  const routes = new Map(graph.edges.map(edge => [edge.id, { points: edge.source === 'x'
    ? [{ x: 166, y: 731 }, { x: 196, y: 731 }]
    : [{ x: positions[edge.source].x, y: 31 }, { x: positions[edge.target].x + 166, y: 31 }] }]));
  const base = geometry(graph, { positions, routes }), snapshot = structuredClone(base);
  const result = await improveFlowBySubtrees(graph, base, { rounds: 0,
    ELK: class { constructor() { throw new Error('整体镜像不应启动求解器'); } } });
  assert.equal(result.metrics.backwardEdges, 0);
  assert.equal(result.metrics.backwardLength, 0);
  assert.equal(result.metrics.length, 21 * 30);
  assert.equal(qualityVector(result.metrics)[0], 0);
  assert.equal(result.accepted[0].operation, 'mirror-component');
  for (const [i, id] of ids.entries()) assert.deepEqual(result.geometry.positions[id], { x: i * 196, y: 0 });
  for (const id of ['x', 'y']) assert.equal(result.geometry.positions[id], positions[id]);
  assert.equal(new Map(result.geometry.routes).get('x-y'), routes.get('x-y'));
  assert.deepEqual(base, snapshot, '不得修改输入几何');
});

test('区域镜像会碰到另一独立节点时拒绝候选，不能只审计区域内部', async () => {
  const graph = graphOf(['a', 'b', 'c', 'z'], [['a', 'b'], ['b', 'c']]);
  const positions = { a: { x: 400, y: 0 }, b: { x: 200, y: 0 }, c: { x: 0, y: 200 }, z: { x: 0, y: 0 } };
  const routes = new Map([
    ['a-b', { points: [{ x: 400, y: 31 }, { x: 366, y: 31 }] }],
    ['b-c', { points: [{ x: 283, y: 62 }, { x: 283, y: 231 }, { x: 166, y: 231 }] }],
  ]);
  const base = geometry(graph, { positions, routes });
  assert.equal(qualityVector(measureGeometry(graph, base))[0], 0);
  const result = await improveFlowBySubtrees(graph, base, { rounds: 0 });
  assert.equal(result.geometry, base);
  assert.deepEqual(result.accepted, []);
});

test('21节点的两级汇入图正式排版全部朝右，不把高连接度终点排在最左侧', async () => {
  const branches = Array.from({ length: 10 }, (_, i) => ['input' + i, 'award' + i]);
  const graph = graphOf(['total', ...branches.flat()], branches.flatMap(([input, award]) => [[input, award], [award, 'total']]));
  const positions = Object.fromEntries(graph.nodes.map(node => [node.id, { x: 0, y: 0 }]));
  const result = await arrangeGraphWithRoutes({ graph, positions, ELK });
  const resultGeometry = geometry(graph, result), metrics = measureGeometry(graph, resultGeometry);
  assert.equal(flowMetrics(graph, resultGeometry).backwardEdges, 0);
  assert.equal(metrics.crossings, 0);
  assert.equal(qualityVector(metrics)[0], 0);
  for (const edge of graph.edges) {
    assert.ok(result.positions[edge.source].x < result.positions[edge.target].x);
    const points = result.routes.get(edge.id).points;
    assert.ok(points.at(-1).x > points.at(-2).x, '箭头最终接入段也应朝右');
    assert.ok(routeMeetsMinimum(points));
  }
});

test('所有端口类型按水平坐标顺序收紧，保留节点顺序、纵坐标与端口偏移', () => {
  const graph = graphOf(['c', 'b', 'a'], [['a', 'b'], ['b', 'c']]);
  const positions = { a: { x: 0, y: 0 }, b: { x: 400, y: 200 }, c: { x: 1000, y: 200 } };
  const routes = new Map([
    ['a-b', { points: [{ x: 83, y: 62 }, { x: 83, y: 100 }, { x: 483, y: 100 }, { x: 483, y: 200 }] }],
    ['b-c', { points: [{ x: 566, y: 231 }, { x: 1000, y: 231 }] }],
  ]);
  const base = geometry(graph, { positions, routes }), result = compactHorizontalRoutes(graph, base);
  assert.deepEqual(result.reviewOrder, ['a', 'b', 'c'], '不能使用输入数组顺序');
  assert.deepEqual(result.geometry.positions, { a: { x: 0, y: 0 }, b: { x: 196, y: 200 }, c: { x: 392, y: 200 } });
  const after = new Map(result.geometry.routes);
  assert.equal(after.get('a-b').points.at(-1).x - result.geometry.positions.b.x, 83, '顶部端口随节点一起平移');
  for (const [id, route] of after) {
    assert.ok(routeMeetsMinimum(route.points));
    assert.deepEqual(route.points.map(p => p.y), routes.get(id).points.map(p => p.y));
  }
  assert.equal(result.metrics.crossings, 0);
  assert.equal(qualityVector(result.metrics)[0], 0);
  assert.ok(result.metrics.length < measureGeometry(graph, base).length);
  const again = compactHorizontalRoutes(graph, result.geometry);
  assert.equal(again.geometry, result.geometry, '已紧凑的结果不做无收益移动');
  assert.deepEqual(again.moves, []);
});
