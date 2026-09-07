import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { edgeBundles, modularHierarchy } from '../src/web/layout-structure.mjs';
import { arrangeGraphWithRoutes } from '../src/web/layout.mjs';
import { routeLocalGraph, offsetChannel, expandChannel, affectedRouteIds } from '../src/web/local-routing.mjs';
import { measureGeometry, qualityVector, routeMeetsMinimum } from '../src/web/hierarchical-layout.mjs';
import { flowMetrics } from '../src/web/flow-refinement.mjs';

const graphOf = (ids, edges) => ({ nodes: ids.map(id => ({ id })), edges: edges.map(([id, source, target, sign = 1]) => ({ id, source, target, sign })) });
const valid = (graph, result) => {
  const metric = measureGeometry(graph, { positions: result.positions, routes: [...result.routes],
    sizes: Object.fromEntries(graph.nodes.map(n => [n.id, { width: 166, height: 62 }])) });
  assert.equal(qualityVector(metric)[0], 0); assert.equal(metric.overlaps, 0);
  for (const route of result.routes.values()) assert.ok(routeMeetsMinimum(route.points));
};
const paired = (graph, result) => {
  for (const group of edgeBundles(graph)) {
    const paths = group.bundleMembers.map(edge => {
      const points = result.routes.get(edge.id).points;
      return edge.source === group.source ? points : [...points].reverse();
    });
    for (let i = 1; i < paths.length; i++) {
      assert.equal(paths[i].length, paths[0].length, '整组拐点数量必须一致');
      for (let j = 1; j < paths[0].length; j++) {
        const a = paths[0][j - 1], b = paths[0][j], c = paths[i][j - 1], d = paths[i][j];
        const vertical = a.x === b.x;
        assert.equal(vertical ? c.x : c.y, vertical ? d.x : d.y);
        assert.equal(Math.abs(vertical ? c.x - a.x : c.y - a.y), 12 * i, '每一段保持 12px 通道间隙');
        assert.ok((b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y) > 0);
      }
    }
  }
};

test('节点对合并与输入次序、关系符号和方向无关，自环独立', () => {
  const graph = graphOf(['a', 'b', 'c'], [['2', 'b', 'a', -1], ['3', 'a', 'b'], ['1', 'a', 'b'], ['4', 'a', 'c'], ['loop', 'a', 'a']]);
  const groups = edgeBundles(graph);
  assert.equal(groups.length, 2); assert.deepEqual(groups[0].bundleMembers.map(e => e.id), ['1', '2', '3']);
  assert.deepEqual(edgeBundles({ ...graph, edges: [...graph.edges].reverse() }).find(e => e.id === '1'), groups[0]);
  assert.equal(graph.edges[0].source, 'b'); assert.equal(graph.edges[0].sign, -1);
});

test('直角通道按相邻偏移直线求交，反向关系只反转自己的箭头', () => {
  const graph = graphOf(['a', 'b'], [['1', 'a', 'b'], ['2', 'b', 'a', -1], ['3', 'a', 'b']]);
  const points = [{ x: 166, y: 31 }, { x: 350, y: 31 }, { x: 350, y: 200 }];
  assert.deepEqual(offsetChannel(points, 12), [{ x: 166, y: 43 }, { x: 338, y: 43 }, { x: 338, y: 200 }]);
  const routes = expandChannel(edgeBundles(graph)[0], points);
  assert.deepEqual(routes.get('2').points, [...points].reverse());
  assert.equal(routes.get('1').points[1].x, 362); assert.equal(routes.get('3').points[1].x, 338);
});

test('三条正反向关系共享绕障通道，局部刷新保持外围节点和路线对象', async () => {
  const graph = graphOf(['a', 'b', 'obstacle', 'c', 'd'], [['1', 'a', 'b'], ['2', 'b', 'a', -1], ['3', 'a', 'b'], ['fixed', 'c', 'd']]);
  const before = { a: { x: 0, y: 0 }, b: { x: 600, y: 0 }, obstacle: { x: 300, y: -10 }, c: { x: 0, y: 500 }, d: { x: 600, y: 500 } };
  const first = await routeLocalGraph({ graph, positions: before });
  valid(graph, first); paired(graph, first);
  assert.ok(first.routes.get('1').points.length > 2);
  const positions = { ...before, b: { x: 620, y: 20 } };
  const next = await routeLocalGraph({ graph, positions, previousPositions: before, cachedRoutes: first.routes, movedIds: ['b'] });
  valid(graph, next); paired(graph, next);
  assert.deepEqual(next.positions, positions); assert.equal(next.routes.get('fixed'), first.routes.get('fixed'));
  assert.deepEqual(new Set(next.edgeIds), new Set(['1', '2', '3']));
});

test('只新增一条关系也使整个节点对失效，连续刷新不拆散通道', async () => {
  const graph = graphOf(['a', 'b', 'c'], [['1', 'a', 'b'], ['2', 'b', 'a']]);
  const positions = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, c: { x: 600, y: 500 } };
  const cached = new Map([['1', { points: [{ x: 166, y: 31 }, { x: 200, y: 31 }] }]]);
  assert.deepEqual(new Set(affectedRouteIds(graph, positions, cached, [])), new Set(['1', '2']));
  const result = await routeLocalGraph({ graph, positions, cachedRoutes: cached, edgeIds: ['2'] });
  valid(graph, result); paired(graph, result);
  assert.equal(result.routes.get('1').points.length, 2, '34px 空间内两条直线不应绕行');
  const same = await routeLocalGraph({ graph, positions, cachedRoutes: result.routes });
  for (const [id, route] of result.routes) assert.equal(same.routes.get(id), route);
});

test('删除中间成员后重收通道间隙，不能把24px旧空槽永久当成有效缓存', async () => {
  const graph = graphOf(['a', 'b', 'c', 'd'], [['1', 'a', 'b'], ['2', 'b', 'a'], ['3', 'a', 'b'], ['fixed', 'c', 'd']]);
  const positions = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, c: { x: 0, y: 500 }, d: { x: 400, y: 500 } };
  const before = await routeLocalGraph({ graph, positions });
  const nextGraph = { ...graph, edges: graph.edges.filter(edge => edge.id !== '2') };
  const after = await routeLocalGraph({ graph: nextGraph, positions, cachedRoutes: before.routes });
  valid(nextGraph, after); paired(nextGraph, after);
  assert.deepEqual(new Set(after.edgeIds), new Set(['1', '3']));
  assert.equal(after.routes.get('fixed'), before.routes.get('fixed')); assert.equal(after.routes.has('2'), false);
});

test('正式自动整理只向 ELK 提交一个节点对通道，并保留全部箭头与20px节点网格', async () => {
  const graph = graphOf(['a', 'b'], [['1', 'a', 'b', 1], ['2', 'b', 'a', -1], ['3', 'a', 'b', 1]]);
  let calls = 0;
  class CheckedELK extends ELK {
    async layout(input, options) {
      calls++; assert.equal(input.edges.length, 1);
      return super.layout(input, options);
    }
  }
  const result = await arrangeGraphWithRoutes({ graph, positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 200 } }, ELK: CheckedELK });
  assert.ok(calls); valid(graph, result); paired(graph, result);
  assert.equal(result.routes.size, 3); assert.ok(result.positions.b.x > result.positions.a.x);
  assert.ok(Object.values(result.positions).every(p => p.x % 20 === 0 && p.y % 20 === 0));
});

test('合并通道的水平评价逐条计算正负关系，不能让代表边覆盖其他箭头', () => {
  const graph = graphOf(['a', 'b'], [['1', 'a', 'b'], ['2', 'b', 'a', -1], ['3', 'b', 'a']]);
  const positions = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }, points = [{ x: 166, y: 31 }, { x: 400, y: 31 }];
  const bundled = { ...graph, edges: edgeBundles(graph) };
  const whole = flowMetrics(graph, { positions, routes: [...expandChannel(bundled.edges[0], points)] });
  const single = flowMetrics(bundled, { positions, routes: [['1', { points }]] });
  assert.deepEqual(single, whole); assert.equal(single.backwardEdges, 1);
});

test('合并不能削弱社区关联度，也不能低估宽通道展开后的交叉代价', () => {
  const graph = graphOf(['a', 'b', 'c', 'd'], [['1', 'a', 'b'], ['2', 'b', 'a'], ['3', 'c', 'd']]);
  const bundled = { ...graph, edges: edgeBundles(graph) };
  assert.deepEqual(modularHierarchy(bundled), modularHierarchy(graph));
  const positions = { a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, c: { x: 200, y: -200 }, d: { x: 200, y: 200 } };
  const routes = new Map([['1', { points: [{ x: 166, y: 31 }, { x: 400, y: 31 }] }], ['3', { points: [{ x: 283, y: -138 }, { x: 283, y: 200 }] }]]);
  const sizes = Object.fromEntries(graph.nodes.map(n => [n.id, { width: 166, height: 62 }]));
  const planned = measureGeometry(bundled, { positions, sizes, routes: [...routes] });
  const expanded = new Map([...expandChannel(bundled.edges[0], routes.get('1').points), ['3', routes.get('3')]]);
  const actual = measureGeometry(graph, { positions, sizes, routes: [...expanded] });
  assert.equal(planned.crossings, 2); assert.equal(planned.crossings, actual.crossings);
});
