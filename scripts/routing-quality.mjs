import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { readWorkspace } from '../src/server/workspace.mjs';
import { prepareOpening, graphPositions } from '../src/web/view-files.mjs';
import { projectEndpointQualifiers } from '../src/domain/endpoint-projection.mjs';
import { restoreRouteCache } from '../src/web/route-cache.mjs';
import { auditGraphGeometryStrict, ROUTING_QUALITY, routeGraphScore } from '../src/web/canvas.mjs';

// 只读验证任意项目的真实投影；报告输出目录独立于 canonical 工作区。
export async function readRoutingSample(project, kind, id) {
  const workspace = await readWorkspace(join(resolve(project), '.game-graph'));
  const opening = prepareOpening(workspace, { kind, id });
  const graph = projectEndpointQualifiers(opening.original);
  const positions = graphPositions(workspace, opening.original, opening.snapshot.positions, opening.activeId);
  const document = kind === 'view' ? workspace.views.find(item => item.id === id)
    : workspace.mechanics.find(item => item.id === id);
  for (const node of graph.nodes.filter(node => node.scopeProjection)) {
    if (!document.projectionPositions?.[node.id]) throw new Error(`样本缺少限定投影位置：${node.id}`);
    positions[node.id] = structuredClone(document.projectionPositions[node.id]);
  }
  const cached = restoreRouteCache(graph, positions, document.routeCache);
  return { id, name: document.name ?? id, graph, positions, cached: cached ? [...cached] : null };
}

// 108 个节点、248 条边：网格、跨层斜接、反馈环和局部枢纽同时竞争通道。
export function createRoutingStressSample() {
  const nodes = [], edges = [], positions = {}, columns = 10, rows = 10;
  const addEdge = (source, target, suffix = '') => edges.push({ id: `${source}>${target}${suffix}`, source, target, sign: 1 });
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const id = `n${row}-${column}`;
    nodes.push({ id }); positions[id] = { x: column * 300, y: row * 200 };
    if (column) addEdge(`n${row}-${column - 1}`, id);
    if (row) addEdge(`n${row - 1}-${column}`, id);
  }
  for (let index = 0; index < 20; index++) {
    const row = Math.floor(index / 5) * 2, column = index % 5 * 2;
    addEdge(`n${row}-${column}`, `n${row + 1}-${column + 1}`);
  }
  for (let index = 0; index < 8; index++) {
    const row = index + 1, id = `hub-${index}`;
    nodes.push({ id }); positions[id] = { x: index % 2 ? 3100 : -400, y: row * 200 };
    const column = index % 2 ? 9 : 0;
    for (const adjacent of [row - 1, row, row + 1]) {
      addEdge(id, `n${adjacent}-${column}`); addEdge(`n${adjacent}-${column}`, id);
    }
  }
  return { id: 'routing-stress', name: '复杂路由压力图', graph: { nodes, edges }, positions, cached: null };
}

export function computeRoutingSample(sample, kind, timeout = 60_000) {
  return new Promise((resolveResult, reject) => {
    let completed = false;
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const [{computeGraphTask}, {default:ELK}, {default:cola}] = await Promise.all([
          import(workerData.kernel), import('elkjs/lib/elk.bundled.js'), import('webcola')]);
        const started = performance.now();
        try {
          const result = await computeGraphTask({kind:workerData.kind,
            payload:{graph:workerData.sample.graph,positions:workerData.sample.positions,selectedIds:[],fixedPositions:true}}, {ELK,cola});
          parentPort.postMessage({ok:true,elapsed:performance.now()-started,...result});
        } catch(error) {parentPort.postMessage({ok:false,elapsed:performance.now()-started,error:error.stack});}
      })().catch(error=>parentPort.postMessage({ok:false,error:error.stack}));
    `, { eval: true, execArgv: [], workerData: { sample, kind, kernel: new URL('../src/web/graph-compute-kernel.mjs', import.meta.url).href } });
    const timer = setTimeout(() => {
      completed = true;
      worker.terminate(); resolveResult({ ok: false, error: `计算超过 ${timeout}ms 上限。`, elapsed: timeout });
    }, timeout);
    worker.once('message', value => { completed = true; clearTimeout(timer); worker.terminate(); resolveResult(value); });
    worker.once('error', error => { completed = true; clearTimeout(timer); worker.terminate(); reject(error); });
    worker.once('exit', code => {
      if (completed) return;
      clearTimeout(timer);
      reject(new Error(`计算 Worker 未返回结果便退出，退出码 ${code}。`));
    });
  });
}

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function graphSvg(graph, positions, entries) {
  const routes = new Map(entries), all = [...Object.values(positions).flatMap(p => [p, { x: p.x + 166, y: p.y + 62 }]),
    ...[...routes.values()].flatMap(route => route.points)];
  const left = Math.min(...all.map(p => p.x)) - 40, top = Math.min(...all.map(p => p.y)) - 40;
  const width = Math.max(...all.map(p => p.x)) - left + 40, height = Math.max(...all.map(p => p.y)) - top + 40;
  const lines = graph.edges.filter(edge => routes.has(edge.id)).map(edge => {
    const points = routes.get(edge.id).points;
    const color = edge.sign === -1 ? '#c75d58' : '#477b9e';
    return `<polyline points="${points.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"><title>${escape(edge.id)}</title></polyline>`;
  }).join('');
  const boxes = graph.nodes.map(node => {
    const p = positions[node.id];
    return `<g><rect x="${p.x}" y="${p.y}" width="166" height="62" rx="7" fill="#fff" stroke="#9baabd"/><text x="${p.x + 83}" y="${p.y + 35}" text-anchor="middle" font-size="12">${escape((node.label ?? node.name ?? node.id).slice(0, 20))}</text><title>${escape(node.id)}</title></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}" style="width:100%;min-width:900px">${lines}${boxes}</svg>`;
}

export async function inspectRoutingSample(sample, mode, output) {
  const result = await computeRoutingSample(sample, mode);
  const score = result.ok ? routeGraphScore(sample.graph, result.positions, new Map(result.routes)) : null;
  const audit = result.ok ? auditGraphGeometryStrict(sample.graph, result.positions, new Map(result.routes)) : null;
  const metrics = values => values && Object.fromEntries(Object.entries(ROUTING_QUALITY).map(([key, index]) => [key, values[index]]));
  const report = { id: sample.id, mode, nodes: sample.graph.nodes.length, edges: sample.graph.edges.length,
    ok: result.ok && audit.ok, elapsed: result.elapsed, quality: metrics(score), reasons: audit?.reasons, error: result.error,
    savedQuality: sample.cached && metrics(routeGraphScore(sample.graph, sample.positions, new Map(sample.cached))) };
  if (output) {
    await mkdir(output, { recursive: true });
    const stem = `${sample.id}-${mode}`;
    await writeFile(join(output, `${stem}.json`), JSON.stringify({ report, sample, result }, null, 2));
    const panel = (title, content) => `<section><h2>${escape(title)}</h2><div class="graph">${content}</div></section>`;
    const html = `<!doctype html><meta charset="utf-8"><title>${escape(sample.name)}路由对照</title>
      <style>body{margin:24px;font-family:system-ui;background:#f4f6f9;color:#203040}section{background:white;margin:20px 0;padding:20px;border-radius:12px}.graph{overflow:auto}pre{white-space:pre-wrap;font-size:13px}h1{font-size:24px}h2{font-size:18px}</style>
      <h1>${escape(sample.name)} · ${mode === 'layout' ? '完整自动排版' : '固定节点路由'}</h1>
      <p>正式资料只读。上图为文件内保存的路线；下图为当前算法计算结果。</p><pre>${escape(JSON.stringify(report, null, 2))}</pre>
      ${sample.cached ? panel('已保存布局', graphSvg(sample.graph, sample.positions, sample.cached)) : ''}
      ${panel('本次计算', result.ok ? graphSvg(sample.graph, result.positions, result.routes) : `<pre>${escape(result.error)}</pre>`)}`;
    await writeFile(join(output, `${stem}.html`), html);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const sample = value('--snapshot') ? JSON.parse(await readFile(value('--snapshot'), 'utf8')).sample
    : args.includes('--synthetic') ? createRoutingStressSample()
      : await readRoutingSample(value('--project'), value('--view') ? 'view' : 'mechanic', value('--view') ?? value('--mechanic'));
  if (!sample?.graph || !sample?.positions || !sample?.id) throw new Error('验证快照必须包含完整的 sample 图、坐标和 ID。');
  const modes = value('--mode') ? [value('--mode')] : ['route', 'layout'];
  for (const mode of modes) {
    if (!['route', 'layout'].includes(mode)) throw new Error('mode 只能为 route 或 layout。');
    const report = await inspectRoutingSample(sample, mode, value('--output'));
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  }
}
