import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { layoutDirection } from '../src/web/layout-structure.mjs';
import { flowMetrics, improveFlowBySubtrees } from '../src/web/flow-refinement.mjs';
import { solveLayout, measureGeometry, qualityVector, routeMeetsMinimum } from '../src/web/hierarchical-layout.mjs';
import { arrangeGraphWithRoutes } from '../src/web/layout.mjs';
import { routeLocalGraph } from '../src/web/local-routing.mjs';

const graphOf = (ids, edges) => ({ nodes: ids.map(id => ({ id })),
  edges: edges.map(([source, target, sign], i) => ({ id: 'e' + i, source, target, sign })) });
const geometryOf = (graph, result) => ({ positions: result.positions, routes: [...result.routes],
  sizes: Object.fromEntries(graph.nodes.map(node => [node.id, { width: 166, height: 62 }])) });

test('负面影响按目标到源评价左右方向，正面、随机与无符号边保持原方向', () => {
  for (const sign of [-1, 1, 'random', undefined]) {
    const graph = graphOf(['x', 'y'], [['x', 'y', sign]]), snapshot = structuredClone(graph);
    assert.deepEqual(layoutDirection(graph.edges[0]), sign === -1 ? { source: 'y', target: 'x' } : { source: 'x', target: 'y' });
    const metric = flowMetrics(graph, { positions: { x: { x: 0, y: 800 }, y: { x: 196, y: -800 } },
      routes: [['e0', { points: [{ x: 166, y: 31 }, { x: 196, y: 31 }] }]] });
    assert.deepEqual(metric, { backwardEdges: sign === -1 ? 1 : 0, backwardLength: sign === -1 ? 30 : 0 });
    assert.deepEqual(graph, snapshot);
  }
});

test('上下排列的负面影响不产生方向惩罚，不因负号而上下翻转或改变纵坐标', async () => {
  for (const sign of [-1, 1]) for (const down of [true, false]) {
    const graph = graphOf(['x', 'y'], [['x', 'y', sign]]);
    const positions = { x: { x: 0, y: down ? 0 : 92 }, y: { x: 0, y: down ? 92 : 0 } };
    const points = down ? [{ x: 83, y: 62 }, { x: 83, y: 92 }] : [{ x: 83, y: 92 }, { x: 83, y: 62 }];
    const base = geometryOf(graph, { positions, routes: new Map([['e0', { points }]]) });
    const result = await improveFlowBySubtrees(graph, base, { ELK });
    assert.equal(result.geometry, base);
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(flowMetrics(graph, base), { backwardEdges: 0, backwardLength: 0 });
  }
});

test('负面影响不改变初始ELK排版规则，路径始终按真实源连接至真实目标', async () => {
  const graph = graphOf(['x', 'y'], [['x', 'y', -1]]), snapshot = structuredClone(graph);
  const result = await solveLayout(graph, 'flat', { ELK });
  assert.ok(result.geometry.positions.x.x < result.geometry.positions.y.x);
  assert.equal(result.geometry.positions.x.y, result.geometry.positions.y.y);
  const points = new Map(result.geometry.routes).get('e0').points;
  assert.ok(points[0].x < points.at(-1).x);
  assert.equal(qualityVector(result.metrics)[0], 0);
  assert.deepEqual(graph, snapshot);
});

test('正式排版中资源支持行动与行动消耗资源共享左右顺序，红色箭头保留真实方向', async () => {
  const graph = graphOf(['action', 'resource'], [['resource', 'action', 1], ['action', 'resource', -1]]);
  const snapshot = structuredClone(graph);
  const result = await arrangeGraphWithRoutes({ graph, positions: { action: { x: 0, y: 0 }, resource: { x: 400, y: 0 } }, ELK });
  const geometry = geometryOf(graph, result);
  assert.ok(result.positions.resource.x < result.positions.action.x);
  assert.equal(flowMetrics(graph, geometry).backwardEdges, 0);
  assert.equal(flowMetrics(graph, geometry).backwardLength, 0);
  assert.equal(qualityVector(measureGeometry(graph, geometry))[0], 0);
  for (const [id, route] of result.routes) {
    assert.ok(routeMeetsMinimum(route.points));
    assert.equal(route.points.at(-1).x > route.points[0].x, id === 'e0');
  }
  assert.deepEqual(graph, snapshot);
});

test('负边子树按照反向边界移到目标右侧，外围正向链保持位置', async () => {
  const graph = graphOf(['a', 'b', 'c', 'z'], [['a', 'b', 1], ['b', 'c', 1], ['z', 'b', -1]]);
  const positions = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, c: { x: 800, y: 0 }, z: { x: 0, y: 400 } };
  const base = geometryOf(graph, await routeLocalGraph({ graph, positions }));
  const result = await improveFlowBySubtrees(graph, base, { ELK });
  assert.equal(result.metrics.backwardEdges, 0);
  assert.ok(result.geometry.positions.z.x > result.geometry.positions.b.x);
  assert.equal(result.geometry.positions.z.y, positions.z.y);
  for (const id of ['a', 'b', 'c']) assert.deepEqual(result.geometry.positions[id], positions[id]);
  assert.equal(qualityVector(result.metrics)[0], 0);
});
