import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphComputeCoordinator, computeCancelled } from '../src/web/graph-compute.mjs';
import { computeGraphTask } from '../src/web/graph-compute-kernel.mjs';
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
