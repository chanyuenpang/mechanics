import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteCache, graphGeometryKey, restoreRouteCache } from '../src/web/route-cache.mjs';

const graph = {
  nodes: [{ id: 'a' }, { id: 'b' }],
  edges: [{ id: 'rules/a-2-b', source: 'a', target: 'b' }],
};
const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
const routes = new Map([['rules/a-2-b', { points: [{ x: 166, y: 31 }, { x: 300, y: 31 }] }]]);

test('完整几何快照可恢复已保存的正交拐点', () => {
  const cache = createRouteCache(graph, positions, routes);
  assert.equal(cache.geometryKey, graphGeometryKey(graph, positions));
  assert.deepEqual(restoreRouteCache(graph, positions, cache), routes);
});

test('坐标或拓扑变化时拒绝复用旧路线', () => {
  const cache = createRouteCache(graph, positions, routes);
  assert.equal(restoreRouteCache(graph, { ...positions, b: { x: 320, y: 0 } }, cache), null);
  assert.equal(restoreRouteCache({ ...graph, edges: [] }, positions, cache), null);
});

test('算法升级后拒绝同坐标同拓扑的旧缓存，新结果仍可复用', () => {
  const legacy = { geometryKey: 'a:0,0|b:300,0//rules/a-2-b:a>b',
    paths: { 'rules/a-2-b': [{ x: 166, y: 31 }, { x: 300, y: 31 }] } };
  const before = structuredClone({ legacy, positions });
  assert.equal(restoreRouteCache(graph, positions, legacy), null);
  const current = createRouteCache(graph, positions, routes);
  assert.deepEqual(restoreRouteCache(graph, positions, current), routes);
  assert.equal(restoreRouteCache(graph, positions, { ...current, geometryKey: 'v1//' + legacy.geometryKey }), null);
  assert.equal(restoreRouteCache(graph, positions, { ...current, geometryKey: 'v2//' + legacy.geometryKey }), null);
  assert.deepEqual({ legacy, positions }, before);
});
