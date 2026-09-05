import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// 工人物语 7「人员培养与军事单位」的拓扑缩影。节点和边的输入顺序故意
// 保留资料顺序：节点顺序可作为稳定偏好，但独立边顺序不应共同干扰层内排列。
const nodeIds = `population-used population-free wood plain fancy coal iron coin weapon wheel horse book garment jewelry beer church export stronghold novice brother father hawker salesman merchant pikeman musketeer cavalier cannon banner recruit-novice recruit-brother recruit-father recruit-hawker recruit-salesman recruit-merchant recruit-pikeman recruit-musketeer recruit-cavalier recruit-cannon recruit-banner`.split(' ').map(id => `s7-${id}`);
const links = [
  'church>recruit-brother', 'church>recruit-father', 'church>recruit-novice',
  'export>recruit-hawker', 'export>recruit-merchant', 'export>recruit-salesman',
  ...'banner brother cannon cavalier father hawker merchant musketeer novice pikeman salesman'.split(' ')
    .map(target => `population-free>recruit-${target}`),
  'recruit-banner>banner', 'recruit-banner>coin', 'recruit-banner>iron', 'recruit-banner>population-used', 'recruit-banner>wood',
  'recruit-brother>beer', 'recruit-brother>book', 'recruit-brother>brother', 'recruit-brother>plain', 'recruit-brother>population-used',
  'recruit-cannon>cannon', 'recruit-cannon>coal', 'recruit-cannon>coin', 'recruit-cannon>fancy', 'recruit-cannon>population-used', 'recruit-cannon>weapon', 'recruit-cannon>wheel',
  'recruit-cavalier>cavalier', 'recruit-cavalier>coin', 'recruit-cavalier>horse', 'recruit-cavalier>population-used', 'recruit-cavalier>weapon',
  'recruit-father>beer', 'recruit-father>book', 'recruit-father>fancy', 'recruit-father>father', 'recruit-father>jewelry', 'recruit-father>population-used',
  'recruit-hawker>garment', 'recruit-hawker>hawker', 'recruit-hawker>population-used',
  'recruit-merchant>garment', 'recruit-merchant>horse', 'recruit-merchant>jewelry', 'recruit-merchant>merchant', 'recruit-merchant>population-used', 'recruit-merchant>wheel',
  'recruit-musketeer>coal', 'recruit-musketeer>coin', 'recruit-musketeer>musketeer', 'recruit-musketeer>population-used', 'recruit-musketeer>weapon',
  'recruit-novice>beer', 'recruit-novice>novice', 'recruit-novice>plain', 'recruit-novice>population-used',
  'recruit-pikeman>coin', 'recruit-pikeman>pikeman', 'recruit-pikeman>population-used', 'recruit-pikeman>weapon',
  'recruit-salesman>garment', 'recruit-salesman>jewelry', 'recruit-salesman>population-used', 'recruit-salesman>salesman',
  'stronghold>recruit-banner', 'stronghold>recruit-cannon', 'stronghold>recruit-cavalier', 'stronghold>recruit-musketeer', 'stronghold>recruit-pikeman',
];
const graph = {
  nodes: nodeIds.map(id => ({ id })),
  edges: links.map(link => {
    const [source, target] = link.split('>');
    return { id: `s7-recruitment/s7-${source}-2-s7-${target}`, source: `s7-${source}`, target: `s7-${target}`, sign: 1 };
  }),
};
const positions = Object.fromEntries(nodeIds.map((id, index) => [id, { x: index * 20, y: 0 }]));

const layoutUrl = new URL('../src/web/layout.mjs', import.meta.url).href;
const qualityUrl = new URL('../src/web/hierarchical-layout.mjs', import.meta.url).href;
const cacheUrl = new URL('../src/web/route-cache.mjs', import.meta.url).href;

function runLayoutInWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const [{ default: ELK }, { default: cola }, { arrangeGraphWithRoutes },
          { measureGeometry }, { createRouteCache, restoreRouteCache }] = await Promise.all([
          import('elkjs/lib/elk.bundled.js'), import('webcola'), import(workerData.layoutUrl), import(workerData.qualityUrl), import(workerData.cacheUrl),
        ]);
        const firstStarted = performance.now();
        const first = await arrangeGraphWithRoutes({ graph: workerData.graph, positions: workerData.positions, ELK, cola });
        const firstElapsed = performance.now() - firstStarted;
        const reopened = restoreRouteCache(workerData.graph, first.positions,
          JSON.parse(JSON.stringify(createRouteCache(workerData.graph, first.positions, first.routes))));
        const audit = measureGeometry(workerData.graph, { positions: first.positions, routes: [...first.routes],
          sizes: Object.fromEntries(workerData.graph.nodes.map(node => [node.id, { width: 166, height: 62 }])) });
        const repeated = await arrangeGraphWithRoutes({ graph: workerData.graph, positions: workerData.positions, ELK, cola });
        parentPort.postMessage({ ok: true, firstElapsed, audit, positions: first.positions,
          routes: [...first.routes].map(([id, route]) => [id, route.points]),
          reopened: [...reopened].map(([id, route]) => [id, route.points]),
          repeatedPositions: repeated.positions,
          repeatedRoutes: [...repeated.routes].map(([id, route]) => [id, route.points]),
        });
      })().catch(error => parentPort.postMessage({ ok: false, error: error.stack || error.message }));
    `, { eval: true, workerData: { graph, positions, layoutUrl, qualityUrl, cacheUrl } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('人员培养图自动排版超过 20 秒硬上限。'));
    }, 20_000);
    worker.once('message', result => {
      clearTimeout(timer);
      worker.terminate();
      result.ok ? resolve(result) : reject(new Error(result.error));
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

test('高扇出人员培养图完成联合排版，几何有效、缓存完整且结果可重复', async () => {
  const result = await runLayoutInWorker();
  assert.equal(result.routes.length, links.length);
  for (const key of ['missing', 'invalid', 'nodeOverlaps', 'nodeHits', 'selfCrossings', 'overlaps']) assert.equal(result.audit[key], 0, key);
  assert.deepEqual(new Map(result.reopened), new Map(result.routes));
  assert.deepEqual(result.repeatedPositions, result.positions);
  assert.deepEqual(result.repeatedRoutes, result.routes);
  assert.ok(result.firstElapsed < 8000,
    `人员培养图自动排版耗时 ${Math.round(result.firstElapsed)}ms，超过 8 秒回归门槛`);
});
