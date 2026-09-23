import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import cola from 'webcola';
import { ROUTING_QUALITY, routeGraphEdges, routeGraphScore } from '../src/web/canvas.mjs';

// 这条门槛是数量级回归护栏，不是微基准：本机（i7-12700）多次实测稀疏图 7.3–10.7 秒
// （单独运行 8.1 秒，串行全量回归里 8.0–10.0 秒），高连接度图 6.4–9.0 秒。
// 原 8 秒门槛正落在这条噪声带里，会随机器负载随机变红；15 秒留出约 1.4 倍余量，
// 仍能拦住真实的算法退化——那种回归是数量级变化，不会只慢一成。
const ROUTING_BUDGET_MS = 15000;

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
  const score = routeGraphScore(graph, positions, routes);
  assert.deepEqual([score[ROUTING_QUALITY.hardInvalid], score[ROUTING_QUALITY.collinearOverlap],
    score[ROUTING_QUALITY.crossings]], [0, 0, 0]);
  assert.ok(elapsed < ROUTING_BUDGET_MS, `规模路由耗时 ${Math.round(elapsed)}ms，超过 ${ROUTING_BUDGET_MS / 1000} 秒回归门槛`);
});

test('100 节点 200 边高连接度图在有界时间内完成硬合同路由', () => {
  const nodes = [], edges = [], positions = {};
  for (let cluster = 0; cluster < 4; cluster++) {
    const originX = cluster % 2 * 3200, originY = Math.floor(cluster / 2) * 3200;
    const hub = `c${cluster}-hub`;
    nodes.push({ id: hub }); positions[hub] = { x: originX, y: originY };
    const leaves = [];
    for (let index = 0; index < 24; index++) {
      const id = `c${cluster}-n${index}`, angle = Math.PI * 2 * index / 24;
      leaves.push(id); nodes.push({ id });
      positions[id] = { x: Math.round(originX + Math.cos(angle) * 1050),
        y: Math.round(originY + Math.sin(angle) * 1050) };
      edges.push({ id: `hub-${cluster}-${index}`, source: hub, target: id, sign: 1 });
    }
    for (let index = 0; index < 24; index++) edges.push({ id: `ring-${cluster}-${index}`,
      source: leaves[index], target: leaves[(index + 1) % 24], sign: -1 });
    edges.push({ id: `chord-${cluster}-0`, source: leaves[1], target: leaves[7], sign: 1 });
    edges.push({ id: `chord-${cluster}-1`, source: leaves[13], target: leaves[19], sign: 1 });
  }
  const graph = { nodes, edges }, started = performance.now();
  const routes = routeGraphEdges(graph, positions, cola), elapsed = performance.now() - started;
  assert.equal(routes.size, 200);
  assert.deepEqual(routeGraphScore(graph, positions, routes).slice(0, 2), [0, 0]);
  assert.ok(elapsed < ROUTING_BUDGET_MS, `高连接度规模路由耗时 ${Math.round(elapsed)}ms，超过 ${ROUTING_BUDGET_MS / 1000} 秒回归门槛`);
});
