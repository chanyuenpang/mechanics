import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphComputeCoordinator, computeCancelled } from '../src/web/graph-compute.mjs';
import { computeGraphTask } from '../src/web/graph-compute-kernel.mjs';
import cola from 'webcola';
import ELK from 'elkjs/lib/elk.bundled.js';
import { refineHierarchy, AUTO_LAYOUT_OPTIONS, measureGeometry, qualityVector } from '../src/web/hierarchical-layout.mjs';
import { improveFlowBySubtrees, compactHorizontalRoutes, snapLayoutToGrid } from '../src/web/flow-refinement.mjs';
import { createRouteCache, restoreRouteCache } from '../src/web/route-cache.mjs';

test('正式整理返回共享算法与方向迭代的完整几何，复用并释放每阶段引擎', async () => {
  const graph = { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })),
    edges: [['a', 'b'], ['c', 'b'], ['b', 'd'], ['d', 'c']].map(([source, target], i) => ({ id: 'edge-' + i, source, target })) };
  const base = await refineHierarchy(graph, { ...AUTO_LAYOUT_OPTIONS, ELK });
  const directed = await improveFlowBySubtrees(graph, base.geometry, { ELK });
  const expected = snapLayoutToGrid(graph, compactHorizontalRoutes(graph, directed.geometry).geometry);
  // 独立区域会整体移回原位置；消去这次网格平移后逐点比较完整输出。
  const positions = directed.geometry.positions;
  let created = 0, disposed = 0;
  class OwnedELK extends ELK { constructor() { super(); created++; } dispose() { disposed++; } }
  const result = await computeGraphTask({ kind: 'layout', payload: { graph, positions } }, { ELK: OwnedELK });
  const dx = result.positions.a.x - expected.positions.a.x, dy = result.positions.a.y - expected.positions.a.y;
  assert.ok(dx % 20 === 0 && dy % 20 === 0);
  const shift = p => ({ x: p.x + dx, y: p.y + dy });
  assert.deepEqual(result.positions, Object.fromEntries(Object.entries(expected.positions).map(([id, p]) => [id, shift(p)])));
  assert.deepEqual(result.routes, expected.routes.map(([id, route]) => [id, { points: route.points.map(shift) }]));
  assert.ok(created >= 1 && created <= 2); assert.equal(disposed, created);
  assert.deepEqual(restoreRouteCache(graph, result.positions, createRouteCache(graph, result.positions, result.routes)), new Map(result.routes));
});

test('联合排版引擎失败仍释放资源，并把原始错误传出', async () => {
  let disposed = 0;
  class BrokenELK { async layout() { throw Error('模拟联合求解失败'); } dispose() { disposed++; } }
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'a-b', source: 'a', target: 'b' }] },
    positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
  await assert.rejects(computeGraphTask({ kind: 'layout', payload: { graph, positions } }, { ELK: BrokenELK }), /模拟联合求解失败/);
  assert.equal(disposed, 1);
  assert.deepEqual(positions, { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } });
});

test('空图与带自环的独立节点保留画布专用自环合同', async () => {
  const empty = await computeGraphTask({ kind: 'layout', payload: { graph: { nodes: [], edges: [] }, positions: {} } }, { ELK });
  assert.deepEqual(empty, { positions: {}, routes: [] });
  const graph = { nodes: [{ id: 'a' }], edges: [{ id: 'loop', source: 'a', target: 'a' }] };
  const result = await computeGraphTask({ kind: 'layout', payload: { graph, positions: { a: { x: 20, y: 40 } } } }, { ELK });
  assert.deepEqual(result.positions, { a: { x: 20, y: 40 } });
  assert.ok(createRouteCache(graph, result.positions, result.routes));
});

class FakeWorker {
  constructor() { this.messages = []; this.terminated = false; }
  postMessage(value) { this.messages.push(value); }
  terminate() { this.terminated = true; }
  succeed(result = {}) {
    const request = this.messages[0];
    this.onmessage?.({ data: { requestId: request.requestId, geometryKey: request.geometryKey, ok: true, result } });
  }
  fail(message = '路由失败') {
    const request = this.messages[0];
    this.onmessage?.({ data: { requestId: request.requestId, geometryKey: request.geometryKey, ok: false,
      error: { name: 'Error', code: 'ROUTE_FAILED', message } } });
  }
}

test('新计算硬取消旧 Worker，旧结果不能提交', async () => {
  const workers = [], states = [];
  const coordinator = new GraphComputeCoordinator({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    onState: state => states.push(state) });
  const first = coordinator.run({ kind: 'route', geometryKey: 'a', payload: {}, isCurrent: () => true });
  const second = coordinator.run({ kind: 'route', geometryKey: 'b', payload: {}, isCurrent: () => true });
  await assert.rejects(first, error => computeCancelled(error));
  assert.equal(workers[0].terminated, true); workers[0].succeed({ stale: true });
  workers[1].succeed({ latest: true }); assert.deepEqual(await second, { latest: true });
  assert.equal(workers[1].terminated, true);
  assert.equal(states.filter(state => state.active).length, 2);
});

test('几何签名过期、Worker 失败和非法响应都显式失败', async () => {
  const workers = [], coordinator = new GraphComputeCoordinator({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  const stale = coordinator.run({ kind: 'route', geometryKey: 'a', payload: {}, isCurrent: () => false });
  workers.at(-1).succeed(); await assert.rejects(stale, error => computeCancelled(error));
  const failed = coordinator.run({ kind: 'route', geometryKey: 'b', payload: {}, isCurrent: () => true });
  workers.at(-1).fail('没有可行路线'); await assert.rejects(failed, error => error.code === 'ROUTE_FAILED' && /没有可行路线/.test(error.message));
  const invalid = coordinator.run({ kind: 'route', geometryKey: 'c', payload: {}, isCurrent: () => true });
  workers.at(-1).onmessage({ data: { requestId: -1, geometryKey: 'c', ok: true, result: {} } });
  await assert.rejects(invalid, /不匹配/);
});

test('Worker kernel 路由边界使用可克隆 entries 且保留确定结果', async () => {
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'a-b', source: 'a', target: 'b', sign: 1 }] };
  const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
  const result = await computeGraphTask({ kind: 'route', payload: { graph, positions } }, { cola });
  assert.ok(Array.isArray(result.routes)); assert.equal(result.routes[0][0], 'a-b');
  assert.deepEqual(result.positions, positions);
  assert.deepEqual(result.routes, (await computeGraphTask({ kind: 'route', payload: { graph, positions } }, { cola })).routes);
});

const geometryMetrics = (graph, result) => measureGeometry(graph, { ...result,
  sizes: Object.fromEntries(graph.nodes.map(node => [node.id, { width: 166, height: 62 }])) });

test('Worker 局部落地保留拖动落点，实际出线方向不背离目标', async () => {
  const graph = {
    nodes: ['play', 'a', 'b', 'c', 'd'].map(id => ({ id })),
    edges: ['a', 'b', 'c', 'd'].map(id => ({ id: 'play-' + id, source: 'play', target: id, sign: 1 })),
  };
  const previous = {
    play: { x: 300, y: 300 }, a: { x: 500, y: 0 }, b: { x: 700, y: 80 },
    c: { x: 650, y: 180 }, d: { x: 950, y: 240 },
  };
  const cached = await computeGraphTask({ kind: 'route', payload: { graph, positions: previous } }, { cola });
  const positions = { ...cached.positions, play: { x: cached.positions.play.x + 20, y: cached.positions.play.y + 20 } };
  const result = await computeGraphTask({ kind: 'route', payload: {
    graph, positions, previousPositions: cached.positions, cachedRoutes: cached.routes, movedIds: ['play'],
  } }, { cola });
  const routes = new Map(result.routes);
  assert.deepEqual(result.positions, positions);
  for (const edge of graph.edges) {
    const [start, next] = routes.get(edge.id).points, target = result.positions[edge.target], source = result.positions.play;
    assert.ok((target.x - source.x) * (next.x - start.x) + (target.y - source.y) * (next.y - start.y) >= 0,
      `${edge.id} 不得被冲突优化迁到目标反方向`);
  }
  const metrics = geometryMetrics(graph, result);
  assert.equal(metrics.invalid + metrics.missing + metrics.nodeHits + metrics.selfCrossings, 0);
  assert.equal(metrics.nodeOverlaps, geometryMetrics(graph, cached).nodeOverlaps, '原有外围重叠不触发全局处理');
});

test('手牌移入抽牌近邻后优先松弛近共线端口形成直线', async () => {
  const graph = {
    nodes: ['draw', 'discard', 'hand', 'play'].map(id => ({ id })),
    edges: [
      { id: 'draw-discard', source: 'draw', target: 'discard', sign: 1 },
      { id: 'draw-hand', source: 'draw', target: 'hand', sign: 1 },
      { id: 'play-hand', source: 'play', target: 'hand', sign: -1 },
      { id: 'play-discard', source: 'play', target: 'discard', sign: 1 },
    ],
  };
  const previous = { draw: { x: 230, y: 30 }, discard: { x: 520, y: 30 },
    hand: { x: 520, y: 240 }, play: { x: 230, y: 420 } };
  const cached = await computeGraphTask({ kind: 'route', payload: { graph, positions: previous } }, { cola });
  const positions = { ...cached.positions, hand: { x: 250, y: 130 } };
  const result = await computeGraphTask({ kind: 'route', payload: {
    graph, positions, previousPositions: cached.positions, cachedRoutes: cached.routes, movedIds: ['hand'],
  } }, { cola });
  const routes = new Map(result.routes);
  const route = routes.get('draw-hand');
  assert.equal(route.points[0].y, result.positions.draw.y + 62);
  assert.equal(route.points.at(-1).y, result.positions.hand.y);
  assert.equal(route.points[0].x, route.points.at(-1).x);
  assert.equal(route.points.length, 2, '小于30px的近共线偏差应通过端口松弛消除，不应保留微小拐点');
  assert.equal(qualityVector(geometryMetrics(graph, result))[0], 0);
  assert.ok(!result.edgeIds.includes('draw-discard'));
  for (const [id, route] of cached.routes) if (!result.edgeIds.includes(id)) assert.deepEqual(routes.get(id), route);
});
