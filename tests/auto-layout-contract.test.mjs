import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ELK from 'elkjs/lib/elk.bundled.js';
import { autoLayoutGraph } from '../src/web/auto-layout.mjs';
import { computeGraphTask } from '../src/web/graph-compute-kernel.mjs';
import { restoreRouteCache } from '../src/web/route-cache.mjs';
import { projectDisplayGraph } from '../src/domain/taxonomy-presentation.mjs';

const graph = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'a-b', source: 'a', target: 'b' }] };
const positions = { a: { x: 0, y: 0 }, b: { x: 320, y: 0 } };

test('网页 Worker 自动整理复用共享布局并返回可持久化的完整 route cache', async () => {
  const direct = await autoLayoutGraph({ graph, positions, selectedIds: [], cachedRoutes: [], ELK });
  const worker = await computeGraphTask({ kind: 'layout', payload: { graph, positions, selectedIds: [], cachedRoutes: [] } }, { ELK });
  assert.deepEqual(worker.positions, direct.positions);
  assert.deepEqual(worker.routes, [...direct.routes]);
  assert.deepEqual(worker.routeCache, direct.routeCache);
  assert.deepEqual(restoreRouteCache(graph, worker.positions, worker.routeCache), new Map(worker.routes));
});

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const autoLayout = app.slice(app.indexOf('async function autoLayout('), app.indexOf('autosave = new ViewAutosave'));

test('自动排版与路由缓存只消费显示投影：隐藏的 is-a 父概念不参与布局或路线', async () => {
  const taxonomy = {
    nodes: [
      { id: 'child', label: '子概念' },
      { id: 'parent', label: '父概念' },
      { id: 'effect', label: '效果' },
    ],
    edges: [
      { id: 'child-is-parent', source: 'child', target: 'parent', relation: 'specializes' },
      { id: 'child-affects-effect', source: 'child', target: 'effect', relation: 'influence', sign: 1 },
    ],
  };
  const taxonomyPositions = { child: { x: 0, y: 0 }, parent: { x: 320, y: 0 }, effect: { x: 640, y: 0 } };
  const displayed = projectDisplayGraph(taxonomy, { taxonomyPresentation: { mode: 'label', expandedNodeIds: [] }, retainedNodeIds: ['child'] });
  assert.deepEqual(displayed.nodes.map(node => node.id), ['child', 'effect']);
  const layout = await autoLayoutGraph({ graph: displayed, positions: taxonomyPositions, selectedIds: [], cachedRoutes: [], ELK });
  assert.deepEqual(Object.keys(layout.positions).sort(), ['child', 'effect']);
  assert.deepEqual(Object.keys(layout.routeCache.paths).sort(), ['child-affects-effect']);
  // 完整图的缓存带着 is-a 边，显示投影必须拒绝它，不能让隐藏父概念的路线复活。
  const fullCache = await autoLayoutGraph({ graph: taxonomy, positions: taxonomyPositions, selectedIds: [], cachedRoutes: [], ELK });
  assert.equal(restoreRouteCache(displayed, layout.positions, fullCache.routeCache), null);
  assert.deepEqual(restoreRouteCache(displayed, layout.positions, layout.routeCache), new Map(layout.routes));
  // 展开后父概念回到同一投影，布局才重新包含它。
  const expanded = projectDisplayGraph(taxonomy, { taxonomyPresentation: { mode: 'label', expandedNodeIds: ['child'] }, retainedNodeIds: ['child'] });
  assert.deepEqual(expanded.nodes.map(node => node.id), ['child', 'parent', 'effect']);
});

test('机制图自动整理先释放 arranging 再以非阻塞方式自动保存', async () => {
  const calls = [];
  const context = vm.createContext({
    graph, arranging: false, legacy: false, autosave: { blocked: false }, arrangeSequence: 0,
    busy: () => false, definitionMode: () => false, viewMode: () => false, dirty: () => true,
    projection: () => positions, graphGeometryKey: () => 'geometry', displayGraphOf: () => graph,
    runGraphCompute: async request => { calls.push(['compute', request.payload.selectedIds]); return { positions, routes: [] }; },
    commitSettledGeometry: async () => { calls.push(['commit']); },
    canvas: { selectedIds: () => [], routed: new Map(), fit: () => calls.push(['fit']) },
    updateStatus: () => calls.push(['status']), computeCancelled: () => false,
    saveDraft: async options => calls.push(['save', options, context.arranging]),
  });
  vm.runInContext(autoLayout, context);
  await vm.runInContext('autoLayout({ fitView: true })', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(structuredClone(calls), [['status'], ['compute', []], ['commit'], ['fit'], ['status'], ['save', { blocking: false }, false]]);
});
