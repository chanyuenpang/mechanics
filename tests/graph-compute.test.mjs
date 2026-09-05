import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphComputeCoordinator, computeCancelled } from '../src/web/graph-compute.mjs';
import { computeGraphTask } from '../src/web/graph-compute-kernel.mjs';
import { ROUTING_QUALITY, routeGraphScore } from '../src/web/canvas.mjs';
import cola from 'webcola';

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

test('Worker 局部落地不会让冲突优化把2比2端口迁到目标反方向', async () => {
  const graph = {
    nodes: ['play', 'a', 'b', 'c', 'd'].map(id => ({ id })),
    edges: ['a', 'b', 'c', 'd'].map(id => ({ id: 'play-' + id, source: 'play', target: id, sign: 1 })),
  };
  const previous = {
    play: { x: 300, y: 300 }, a: { x: 500, y: 0 }, b: { x: 700, y: 80 },
    c: { x: 650, y: 180 }, d: { x: 800, y: 240 },
  };
  const cached = await computeGraphTask({ kind: 'route', payload: { graph, positions: previous } }, { cola });
  const before = cached.routes.map(([, route]) => route.sourcePort.side);
  assert.deepEqual(Object.fromEntries(['top', 'right'].map(side => [side, before.filter(value => value === side).length])),
    { top: 2, right: 2 });
  const positions = { ...cached.positions, play: { x: cached.positions.play.x + 20, y: cached.positions.play.y + 20 } };
  const result = await computeGraphTask({ kind: 'route', payload: {
    graph, positions, cachedRoutes: cached.routes, movedIds: ['play'],
  } }, { cola });
  const routes = new Map(result.routes), vectors = {
    top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 },
  };
  for (const edge of graph.edges) {
    const endpoint = routes.get(edge.id).sourcePort, target = result.positions[edge.target], source = result.positions.play;
    const vector = vectors[endpoint.side];
    assert.ok((target.x - source.x) * vector.x + (target.y - source.y) * vector.y >= 0,
      `${edge.id} 不得被冲突优化迁到目标反方向的 ${endpoint.side} 面`);
  }
  assert.equal(routeGraphScore(graph, result.positions, routes)[ROUTING_QUALITY.endpointExcursions], 0);
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
    graph, positions, cachedRoutes: cached.routes, movedIds: ['hand'],
  } }, { cola });
  const routes = new Map(result.routes), score = routeGraphScore(graph, result.positions, routes);
  const route = routes.get('draw-hand');
  assert.equal(route.sourcePort.side, 'bottom');
  assert.equal(route.targetPort.side, 'top');
  assert.equal(route.sourcePort.port.x, route.targetPort.port.x);
  assert.equal(route.points.length, 2, '小于30px的近共线偏差应通过端口松弛消除，不应保留微小拐点');
  assert.equal(score[ROUTING_QUALITY.endpointExcursions], 0);
  assert.equal(score[ROUTING_QUALITY.hardInvalid], 0);
});
