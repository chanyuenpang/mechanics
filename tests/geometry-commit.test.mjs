import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRouteCache, restoreRouteCache } from '../src/web/route-cache.mjs';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const commit = app.slice(app.indexOf('async function commitSettledGeometry('), app.indexOf('const canvas = new GraphCanvas'));
const undo = app.slice(app.indexOf('function undo('), app.indexOf('function field('));
const graph = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'a-b', source: 'a', target: 'b' }] };
const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
const initialRoutes = [['a-b', { points: [{ x: 166, y: 31 }, { x: 200, y: 31 }, { x: 200, y: 80 }, { x: 250, y: 80 }, { x: 250, y: 31 }, { x: 300, y: 31 }] }]];

function harness(view = true) {
  const saved = [], frames = [];
  const cache = createRouteCache(graph, positions, initialRoutes);
  const context = vm.createContext({
    graph, draft: { positions: structuredClone(positions), routeCache: structuredClone(cache) },
    viewPositions: structuredClone(positions), scopedPositions: {}, viewRouteCache: structuredClone(cache),
    history: [], future: [], geometryEpoch: 0, settledRuntime: null, screen: 'graph', selection: null,
    legacy: false, autosave: { blocked: false }, busy: () => false,
    clone: structuredClone, json: JSON.stringify, createRouteCache, restoreRouteCache, Map,
    viewMode: () => view, isEndpointProjection: () => false, definitionMode: () => false, displayGraphOf: () => graph,
    contextKey: () => 'view', $: () => ({}),
    canvas: { primeRoutes: (_graph, _positions, routes) => frames.push([...routes]) },
    render: () => {}, persistView: async () => saved.push(JSON.parse(JSON.stringify(snapshot()))),
  });
  const snapshot = () => ({ positions: context.viewPositions, projectionPositions: context.scopedPositions, routeCache: context.viewRouteCache });
  context.viewSnapshot = () => structuredClone(snapshot());
  context.assignSnapshot = value => {
    context.viewPositions = structuredClone(value.positions);
    context.scopedPositions = structuredClone(value.projectionPositions);
    context.viewRouteCache = structuredClone(value.routeCache);
  };
  context.projection = () => view ? context.viewPositions : context.draft.positions;
  vm.runInContext(commit + '\n' + undo, context);
  return { context, cache, saved, frames };
}

for (const view of [true, false]) for (const moveNodes of [true, false]) {
  test(`${view ? '视图' : '机制'}整理${moveNodes ? '节点和路径' : '仅路径'}，撤销重做完整恢复缓存`, async () => {
    const { context, cache, saved } = harness(view);
    const next = structuredClone(positions);
    if (moveNodes) next.b.x = 360;
    context.result = { positions: next, routes: [['a-b', { points: [{ x: 166, y: 31 }, { x: next.b.x, y: 31 }] }]] };
    await vm.runInContext('commitSettledGeometry(result, { recordHistory: true })', context);
    assert.equal(context.history.length, 1);
    assert.deepEqual(context.history[0].routeCache, cache);
    const finalCache = view ? context.viewRouteCache : context.draft.routeCache;
    assert.deepEqual(restoreRouteCache(graph, next, finalCache), new Map(context.result.routes));
    vm.runInContext('undo()', context);
    assert.deepEqual(view ? context.viewPositions : context.draft.positions, positions);
    assert.deepEqual(view ? context.viewRouteCache : context.draft.routeCache, cache);
    vm.runInContext('undo(true)', context);
    assert.deepEqual(view ? context.viewPositions : context.draft.positions, next);
    assert.deepEqual(view ? context.viewRouteCache : context.draft.routeCache, finalCache);
    assert.equal(saved.length, view ? 3 : 0);
  });
}

test('连线不完整时不修改坐标、历史和预置帧', async () => {
  const { context, cache, frames } = harness();
  context.result = { positions, routes: [] };
  await assert.rejects(vm.runInContext('commitSettledGeometry(result, { recordHistory: true })', context), /连线不完整/);
  assert.equal(context.history.length, 0);
  assert.equal(frames.length, 0);
  assert.deepEqual(context.viewRouteCache, cache);
});

for (const view of [true, false]) test(`${view ? '视图' : '机制'}拖动后的近邻微调写回同一次编辑，不新增历史`, async () => {
  const { context, saved } = harness(view);
  const next = structuredClone(positions); next.b.x = 340;
  context.result = { positions: next, commitPositions: true, persistRouteCache: true,
    routes: [['a-b', { points: [{ x: 166, y: 31 }, { x: 340, y: 31 }] }]] };
  await vm.runInContext('commitSettledGeometry(result)', context);
  assert.deepEqual(view ? context.viewPositions : context.draft.positions, next);
  assert.deepEqual(restoreRouteCache(graph, next, view ? context.viewRouteCache : context.draft.routeCache), new Map(context.result.routes));
  assert.equal(context.history.length, 0);
  assert.equal(context.settledRuntime, null);
  assert.equal(saved.length, view ? 1 : 0);
});
