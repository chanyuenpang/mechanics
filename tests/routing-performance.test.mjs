import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import cola from 'webcola';
import { routeGraphEdges, routeGraphScore } from '../src/web/canvas.mjs';

test('100 节点 200 边稀疏图在有界时间内完成硬合同路由', () => {
  const nodes = [], edges = [], positions = {}, size = 10;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const id = `n${y}-${x}`;
    nodes.push({ id }); positions[id] = { x: x * 260, y: y * 150 };
    if (x) edges.push({ id: `h${y}-${x}`, source: `n${y}-${x - 1}`, target: id, sign: 1 });
    if (y) edges.push({ id: `v${y}-${x}`, source: `n${y - 1}-${x}`, target: id, sign: 1 });
  }
  for (let index = 0; index < 20; index++) {
    const y = Math.floor(index / 9), x = index % 9;
    edges.push({ id: `d${index}`, source: `n${y}-${x}`, target: `n${y + 1}-${x + 1}`, sign: 1 });
  }
  const graph = { nodes, edges }, started = performance.now();
  const routes = routeGraphEdges(graph, positions, cola), elapsed = performance.now() - started;
  assert.equal(routes.size, 200);
  assert.deepEqual(routeGraphScore(graph, positions, routes).slice(0, 3), [0, 0, 0]);
  assert.ok(elapsed < 8000, `规模路由耗时 ${Math.round(elapsed)}ms，超过 8 秒回归门槛`);
});
