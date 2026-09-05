import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ELK from 'elkjs/lib/elk.bundled.js';
import { readRoutingSample, createRoutingStressSample } from '../routing-quality.mjs';
import { clean, affinityHierarchy, treeFor, extractGeometry, measureGeometry, qualityVector, improves,
  solveLayout as solveSharedLayout, refineHierarchy as refineSharedHierarchy } from '../../src/web/hierarchical-layout.mjs';
export { clean, affinityHierarchy, treeFor, extractGeometry, measureGeometry, qualityVector, improves };
export const solveLayout = (graph, mode, options = {}) => solveSharedLayout(graph, mode, { ELK, ...options });
export const refineHierarchy = (graph, options = {}) => refineSharedHierarchy(graph, { ELK, ...options });

const W = 166, H = 62;
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function renderSvg(sample, geometry) {
  const routes = new Map(geometry.routes), { positions, sizes, groups } = geometry;
  const all = [...Object.values(positions), ...Object.entries(positions).map(([id, p]) => ({ x: p.x + sizes[id].width, y: p.y + sizes[id].height })), ...[...routes.values()].flatMap(route => route.points)];
  const x = Math.min(...all.map(p => p.x)) - 28, y = Math.min(...all.map(p => p.y)) - 28;
  const width = Math.max(...all.map(p => p.x)) - x + 28, height = Math.max(...all.map(p => p.y)) - y + 28;
  const paths = sample.graph.edges.map(edge => {
    const route = routes.get(edge.id); if (!route) return '';
    const color = edge.sign === -1 ? '#bc665c' : '#228675';
    return `<polyline points="${route.points.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" marker-end="url(#${edge.sign === -1 ? 'negative' : 'positive'})"><title>${escape(edge.id)}</title></polyline>`;
  }).join('');
  const nodes = sample.graph.nodes.map(node => {
    const p = positions[node.id], size = sizes[node.id];
    return `<g><rect x="${p.x}" y="${p.y}" width="${size.width}" height="${size.height}" rx="6" fill="white" stroke="#acbcb4"/><text x="${p.x + 8}" y="${p.y + 36}" font-size="13">${escape((node.label ?? node.name ?? node.id).slice(0, 20))}</text><title>${escape(node.id)}</title></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${Math.ceil(width)}" height="${Math.ceil(height)}"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#f8faf7"/><defs>${[['positive', '#228675'], ['negative', '#bc665c']].map(([id, color]) => `<marker id="${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${color}"/></marker>`).join('')}</defs>${groups.map(group => `<rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" fill="none" stroke="#99aac0" stroke-dasharray="6 6" opacity=".35"/>`).join('')}${paths}${nodes}</svg>`;
}

export async function exploreSample(sample, output, options = {}) {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, `${sample.id}-input.json`), JSON.stringify(sample, null, 2));
  const candidates = [];
  if (sample.cached) {
    const geometry = { positions: sample.positions, routes: sample.cached, sizes: Object.fromEntries(sample.graph.nodes.map(node => [node.id, { width: W, height: H }])), groups: [] };
    candidates.push({ mode: 'saved', metrics: measureGeometry(sample.graph, geometry), geometry });
    await writeFile(join(output, `${sample.id}-saved.svg`), renderSvg(sample, geometry));
  }
  for (const mode of options.modes ?? ['flat', 'leaf', 'affinity-flat', 'affinity-recursive', 'modular', 'modular-recursive']) {
    const start = performance.now();
    let candidate;
    try {
      const result = mode === 'adaptive' ? await refineHierarchy(sample.graph, options) : await solveLayout(sample.graph, mode, options);
      candidate = { mode, elapsed: Math.round(performance.now() - start), ...result };
      await writeFile(join(output, `${sample.id}-${mode}.svg`), renderSvg(sample, result.geometry));
    } catch (error) { candidate = { mode, elapsed: Math.round(performance.now() - start), error: error.stack }; }
    candidates.push(candidate);
    console.log(JSON.stringify({ sample: sample.id, ...candidate, geometry: undefined, hierarchy: undefined,
      refinement: candidate.refinement ? { accepted: candidate.refinement.accepted.map(item => ({ round: item.round, crossings: item.metrics.crossings })), attempts: candidate.refinement.attempts.length } : undefined }));
  }
  const inputHash = createHash('sha256').update(JSON.stringify(sample)).digest('hex');
  await writeFile(join(output, `${sample.id}-comparison.json`), JSON.stringify({ sample: sample.id, inputHash,
    nodes: sample.graph.nodes.length, edges: sample.graph.edges.length, options, candidates }, null, 2));
  return { id: sample.id, name: sample.name, candidates };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
  const sample = args.includes('--input') ? JSON.parse(await readFile(resolve(get('--input')), 'utf8'))
    : args.includes('--synthetic') ? createRoutingStressSample() : await readRoutingSample(get('--project'), args.includes('--view') ? 'view' : 'mechanic', get(args.includes('--view') ? '--view' : '--mechanic'));
  const options = args.includes('--options') ? JSON.parse(await readFile(resolve(get('--options')), 'utf8')) : {};
  await exploreSample(sample, resolve(get('--output')), options);
}
