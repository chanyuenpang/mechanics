import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { snapLayoutToGrid } from '../src/web/flow-refinement.mjs';
import { arrangeGraphWithRoutes } from '../src/web/layout.mjs';
import { routeLocalGraph } from '../src/web/local-routing.mjs';
import { measureGeometry, qualityVector, routeMeetsMinimum } from '../src/web/hierarchical-layout.mjs';
import { snapPositions } from '../src/web/canvas.mjs';

const graphOf = (ids, pairs) => ({ nodes: ids.map(id => ({ id })),
  edges: pairs.map(([source, target]) => ({ id: source + '-' + target, source, target })) });
const geometryOf = (graph, positions, routes) => ({ positions, routes: [...routes],
  sizes: Object.fromEntries(graph.nodes.map(n => [n.id, { width: 166, height: 62 }])) });
const validGrid = (graph, geometry) => {
  for (const p of Object.values(geometry.positions)) for (const axis of ['x', 'y']) assert.ok(p[axis] % 20 === 0);
  assert.equal(qualityVector(measureGeometry(graph, geometry))[0], 0);
  for (const [, route] of geometry.routes) assert.ok(routeMeetsMinimum(route.points));
};

test('节点宽166px时吸附仍保留至少30px间隙，路线不增加转弯且重复吸附不变', () => {
  const graph = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
  const positions = { a: { x: 13, y: 13 }, b: { x: 209, y: 13 }, c: { x: 405, y: 13 } };
  const routes = [['a-b', { points: [{ x: 179, y: 44 }, { x: 209, y: 44 }] }],
    ['b-c', { points: [{ x: 375, y: 44 }, { x: 405, y: 44 }] }]];
  const base = geometryOf(graph, positions, routes), snapshot = structuredClone(base);
  const result = snapLayoutToGrid(graph, base);
  validGrid(graph, result);
  assert.deepEqual(result.positions, { a: { x: 20, y: 20 }, b: { x: 220, y: 20 }, c: { x: 420, y: 20 } });
  for (const [, route] of result.routes) assert.equal(route.points.length, 2);
  assert.equal(snapLayoutToGrid(graph, result), result);
  assert.deepEqual(base, snapshot);
});

test('两端纵坐标吸附量不同也保持直线，通过原侧面的端口微调接回节点', () => {
  const graph = graphOf(['a', 'b'], [['a', 'b']]);
  const result = snapLayoutToGrid(graph, geometryOf(graph, { a: { x: 0, y: 0 }, b: { x: 196, y: 10 } },
    [['a-b', { points: [{ x: 166, y: 31 }, { x: 196, y: 31 }] }]]));
  validGrid(graph, result);
  assert.equal(result.routes[0][1].points.length, 2);
  assert.equal(result.routes[0][1].points[0].y, result.routes[0][1].points[1].y);
});

test('端口沿侧面微调保留短中间段的方向，不因两端吸附量相反而翻转折线', () => {
  const graph = graphOf(['a', 'b'], [['a', 'b']]);
  const base = geometryOf(graph, { a: { x: 0, y: 11 }, b: { x: 300, y: 9 } }, [
    ['a-b', { points: [{ x: 166, y: 40 }, { x: 220, y: 40 }, { x: 220, y: 41 }, { x: 300, y: 41 }] }],
  ]);
  const result = snapLayoutToGrid(graph, base);
  validGrid(graph, result);
  assert.deepEqual(result.positions, { a: { x: 0, y: 20 }, b: { x: 300, y: 0 } });
  assert.deepEqual(result.routes, base.routes);
});

test('上下分离的节点边界碰巧共用横坐标时不会被绑定成不可吸附的166px距离', () => {
  const graph = graphOf(['a', 'b', 'z'], [['a', 'b'], ['b', 'z']]);
  const base = geometryOf(graph, { a: { x: 0, y: 0 }, b: { x: 196, y: 0 }, z: { x: 166, y: 300 } }, [
    ['a-b', { points: [{ x: 166, y: 31 }, { x: 196, y: 31 }] }],
    ['b-z', { points: [{ x: 279, y: 62 }, { x: 279, y: 270 }, { x: 249, y: 270 }, { x: 249, y: 300 }] }],
  ]);
  const result = snapLayoutToGrid(graph, base);
  validGrid(graph, result);
  assert.equal(result.routes[1][1].points.length, 4);
});

test('单节点自动排版与手动拖动使用同一20px网格，包括负坐标与自环', async () => {
  const graph = graphOf(['a'], [['a', 'a']]), positions = { a: { x: -13, y: 7 } };
  const result = await arrangeGraphWithRoutes({ graph, positions, ELK });
  assert.deepEqual(result.positions, snapPositions(positions));
  assert.equal(result.routes.size, 0);
});

test('节点已经落格也不能把缺失连线作为吸附成功返回', () => {
  const graph = graphOf(['a', 'b'], [['a', 'b']]);
  const base = geometryOf(graph, { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } }, []);
  assert.throws(() => snapLayoutToGrid(graph, base), /吸附前的几何无效/);
});

test('多个独立区域摆放后仍在全局网格上，带小数的原点不会重新污染坐标', async () => {
  const graph = graphOf(['a', 'b', 'c', 'd', 'z'], [['a', 'b'], ['c', 'd']]);
  const positions = { a: { x: -13.5, y: 7.2 }, b: { x: 290.5, y: 7.2 }, c: { x: 11.3, y: 510.1 },
    d: { x: 298.1, y: 510.1 }, z: { x: 450.4, y: 810.7 } };
  const result = await arrangeGraphWithRoutes({ graph, positions, ELK });
  validGrid(graph, geometryOf(graph, result.positions, result.routes));
});

test('只排选中节点时只吸附选中区域，未选节点的小数位置及独立路线精确保留', async () => {
  const graph = graphOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']]);
  const positions = { a: { x: 13, y: 17 }, b: { x: 413, y: 17 }, c: { x: 23.7, y: 700.1 }, d: { x: 444.4, y: 700.1 } };
  const cached = await routeLocalGraph({ graph, positions });
  const result = await arrangeGraphWithRoutes({ graph, positions, selectedIds: ['a', 'b'], cachedRoutes: cached.routes, ELK });
  for (const id of ['a', 'b']) for (const axis of ['x', 'y']) assert.ok(result.positions[id][axis] % 20 === 0);
  for (const id of ['c', 'd']) assert.deepEqual(result.positions[id], positions[id]);
  assert.equal(result.routes.get('c-d'), cached.routes.get('c-d'));
  assert.equal(qualityVector(measureGeometry(graph, geometryOf(graph, result.positions, result.routes)))[0], 0);
});
