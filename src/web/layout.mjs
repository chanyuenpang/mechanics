import { refineHierarchy, measureGeometry, qualityVector, AUTO_LAYOUT_OPTIONS, MIN_ROUTE_SEGMENT, routeMeetsMinimum } from './hierarchical-layout.mjs';
import { routeLocalGraph, routeIntersectsBox, routePairChannels } from './local-routing.mjs';
import { improveFlowBySubtrees, compactHorizontalRoutes, snapLayoutToGrid } from './flow-refinement.mjs';
import { connectedComponents, SNAP_GRID, edgeBundles } from './layout-structure.mjs';

const WIDTH = 166, HEIGHT = 62, MAX_GRID_REROUTE_EDGES = 128;
const snap = value => Math.round(value / SNAP_GRID) * SNAP_GRID;

const layoutCancelled = () => Object.assign(new Error('自动排版已取消，未提交任何坐标或路线。'), { name: 'AbortError', code: 'COMPUTE_CANCELLED' });

function phaseReporter({ timings, onPhase, signal } = {}) {
  const checkCancelled = () => { if (signal?.aborted) throw layoutCancelled(); };
  const run = async (phase, operation) => {
    checkCancelled();
    const started = performance.now();
    onPhase?.({ phase, status: 'started', elapsedMs: 0 });
    try {
      const result = await operation();
      checkCancelled();
      const elapsedMs = performance.now() - started;
      if (timings) timings[phase] = elapsedMs;
      onPhase?.({ phase, status: 'completed', elapsedMs });
      return result;
    } catch (error) {
      onPhase?.({ phase, status: error?.code === 'COMPUTE_CANCELLED' ? 'cancelled' : 'failed', elapsedMs: performance.now() - started, error: error?.message });
      throw error;
    }
  };
  return { checkCancelled, run };
}
const overlaps = (a, b, clearanceA = 0, clearanceB = 0) => a.x - clearanceA < b.x + WIDTH + clearanceB
  && a.x + WIDTH + clearanceA > b.x - clearanceB
  && a.y - clearanceA < b.y + HEIGHT + clearanceB
  && a.y + HEIGHT + clearanceA > b.y - clearanceB;

function visibleSelection(graph, selectedIds) {
  const visible = new Set(graph.nodes.map(node => node.id));
  return [...new Set(selectedIds)].filter(id => visible.has(id));
}

function assertPositions(graph, positions) {
  for (const node of graph.nodes) {
    const value = positions[node.id];
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error('节点缺少有效坐标：' + node.id);
  }
}

async function compactComponents(components, positions, baseline) {
  const anchor = ids => ({ x: Math.min(...ids.map(id => positions[id].x)), y: Math.min(...ids.map(id => positions[id].y)) });
  const ordered = components.map(graph => ({ graph, anchor: anchor(graph.nodes.map(node => node.id)) }))
    .sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x);
  const blocks = [], warnings = [];
  // 后期逐个区域收紧，保留区域内部节点的横向顺序；最后只平移整个外框。
  for (const { graph } of ordered) {
    const ids = new Set(graph.edges.map(edge => edge.id));
    const before = { positions: Object.fromEntries(graph.nodes.map(node => [node.id, baseline.positions[node.id]])),
      routes: new Map([...baseline.routes].filter(([id]) => ids.has(id))) };
    const geometry = { ...before, routes: [...before.routes],
      sizes: Object.fromEntries(graph.nodes.map(node => [node.id, { width: WIDTH, height: HEIGHT }])) };
    const compacted = compactHorizontalRoutes(graph, geometry);
    let snapped;
    try {
      snapped = snapLayoutToGrid(graph, compacted.geometry);
    } catch (error) {
      // 吸附只改变节点位置；旧折线不能变形时，保留同一份网格节点位置并完整重路由。
      // 这是自动整理阶段，允许重算所有本区域路径，但绝不移动已吸附的节点。
      if (!error.rerouteCandidate) throw error;
      // 网格吸附是视觉优化；超过局部路由容量时，不能为此退化成整图重路由。
      // 紧缩前几何已经通过完整审计，保留它比延迟或丢弃一次完整自动排版更安全。
      if (graph.edges.length > MAX_GRID_REROUTE_EDGES) {
        snapped = compacted.geometry;
        warnings.push(`已完成自动整理；${graph.edges.length} 条边的网格吸附需要全量重路由，保留已审计的非网格几何。`);
      } else try {
        const rerouted = await routeLocalGraph({ graph, positions: error.rerouteCandidate, previousPositions: compacted.geometry.positions,
          cachedRoutes: [], edgeIds: graph.edges.map(edge => edge.id), movedIds: graph.nodes.map(node => node.id), fixedPositions: true });
        const geometry = { positions: rerouted.positions, routes: [...rerouted.routes],
          sizes: Object.fromEntries(graph.nodes.map(node => [node.id, { width: WIDTH, height: HEIGHT }])) };
        if (qualityVector(measureGeometry(graph, geometry))[0] !== 0 || geometry.routes.some(([, route]) => !routeMeetsMinimum(route.points))) {
          throw new Error('自动排版吸附后重路由未通过几何检查。');
        }
        snapped = geometry;
      } catch (rerouteError) {
        if (rerouteError?.code !== 'LOCAL_ROUTING_INFEASIBLE') throw rerouteError;
        // 网格是视觉优化；紧缩后的原几何已经通过完整审计时，不能因网格候选的
        // 局部端口不足而丢弃整次自动排版。保留可读的精确布局，并明确告知用户。
        snapped = compacted.geometry;
        warnings.push('已完成自动整理；为保持连线接入段可读性，本区域未吸附到网格。');
      }
    }
    const result = { positions: snapped.positions, routes: new Map(snapped.routes) };
    const points = [...Object.values(result.positions).flatMap(p => [p, { x: p.x + WIDTH, y: p.y + HEIGHT }]),
      ...[...result.routes.values()].flatMap(route => route.points)];
    const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
    blocks.push({ ...result, left, top, width: Math.max(...points.map(p => p.x)) - left,
      height: Math.max(...points.map(p => p.y)) - top });
  }
  const gap = 80, origin = anchor(components.flatMap(graph => graph.nodes.map(node => node.id)));
  const rowWidth = Math.max(...blocks.map(block => block.width),
    Math.sqrt(blocks.reduce((sum, block) => sum + (block.width + gap) * (block.height + gap), 0)));
  const result = { positions: {}, routes: new Map(), warnings }; let x = 0, y = 0, rowHeight = 0;
  for (const block of blocks) {
    if (x && x + block.width > rowWidth) { x = 0; y += rowHeight + gap; rowHeight = 0; }
    const dx = snap(origin.x + x - block.left), dy = snap(origin.y + y - block.top);
    const shift = p => ({ x: p.x + dx, y: p.y + dy });
    for (const [id, p] of Object.entries(block.positions)) result.positions[id] = shift(p);
    for (const [id, route] of block.routes) result.routes.set(id, { points: route.points.map(shift) });
    x += block.width + gap; rowHeight = Math.max(rowHeight, block.height);
  }
  return result;
}

async function layoutAll(graph, positions, ELK, timings, observer = {}) {
  const phases = phaseReporter({ timings, ...observer });
  phases.checkCancelled();
  if (typeof ELK !== 'function') throw new Error('ELK 排版引擎未加载，请刷新页面后重试。');
  if (!graph.nodes.length) return { positions: {}, routes: new Map() };
  // 自环沿用画布的专用环形符号，不进入节点间的正交路径缓存。
  graph = { ...graph, edges: graph.edges.filter(edge => edge.source !== edge.target) };
  if (graph.nodes.length === 1) {
    const id = graph.nodes[0].id;
    return { positions: { [id]: { x: snap(positions[id].x), y: snap(positions[id].y) } }, routes: new Map() };
  }
  const original = graph, bundles = edgeBundles(graph), bundled = bundles.some(edge => edge.bundleMembers.length > 1);
  if (bundled) graph = { ...graph, edges: bundles };
  const initial = await phases.run('hierarchy', () => refineHierarchy(graph, { ...AUTO_LAYOUT_OPTIONS, ELK }));
  if (qualityVector(initial.metrics)[0] !== 0) throw new Error('自动整理未得到完整且无穿节点的布局，请保留当前图并反馈此案例。');
  const result = await phases.run('flow', () => improveFlowBySubtrees(graph, initial.geometry, { ELK }));
  const short = result.geometry.routes.filter(([, route]) => !routeMeetsMinimum(route.points));
  if (short.length) throw new Error(`自动整理仍有连线不足 ${MIN_ROUTE_SEGMENT}px，未提交：` + short.map(([id]) => id).join('、'));
  // 先整体平移保留原区域，随后按连通区域联合吸附节点和路线。
  const dx = Math.min(...graph.nodes.map(node => positions[node.id].x)) - Math.min(...Object.values(result.geometry.positions).map(point => point.x));
  const dy = Math.min(...graph.nodes.map(node => positions[node.id].y)) - Math.min(...Object.values(result.geometry.positions).map(point => point.y));
  const shift = point => ({ x: point.x + dx, y: point.y + dy });
  const arranged = {
    positions: Object.fromEntries(Object.entries(result.geometry.positions).map(([id, point]) => [id, shift(point)])),
    routes: new Map(result.geometry.routes.map(([id, route]) => [id, { points: route.points.map(shift) }])),
  };
  const components = connectedComponents(graph);
  const compacted = await phases.run('compactGrid', () => compactComponents(components, positions, arranged));
  if (!bundled) return compacted;
  const expanded = await phases.run('channels', () => routePairChannels({ graph: original, positions: compacted.positions, cachedRoutes: compacted.routes,
    edgeIds: original.edges.map(edge => edge.id) }));
  return { ...expanded, warnings: compacted.warnings };
}

async function layoutSelection(graph, positions, movableIds, ELK, cachedRoutes = []) {
  const movable = new Set(movableIds), localGraph = { ...graph,
    nodes: graph.nodes.filter(node => movable.has(node.id)),
    edges: graph.edges.filter(edge => movable.has(edge.source) && movable.has(edge.target)) };
  const local = await layoutAll(localGraph, positions, ELK);
  const fixed = graph.nodes.filter(node => !movable.has(node.id));
  const shifts = [{ x: 0, y: 0 }];
  // 把子图作为一个整体放回原区域，只寻找不碰固定外围的位置。
  for (let radius = 1; radius <= 12; radius++) for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    shifts.push({ x: x * radius * 80, y: y * radius * 80 });
  }
  const shift = shifts.find(delta => Object.values(local.positions).every(point =>
    fixed.every(node => !overlaps({ x: point.x + delta.x, y: point.y + delta.y }, positions[node.id], MIN_ROUTE_SEGMENT / 2, MIN_ROUTE_SEGMENT / 2))));
  if (!shift) throw new Error('选中子图在当前局部空间内无法放置，未移动外围节点。');
  const transform = point => ({ x: point.x + shift.x, y: point.y + shift.y });
  const arranged = Object.fromEntries(Object.entries(local.positions).map(([id, point]) => [id, transform(point)]));
  const nextPositions = { ...positions, ...arranged }, cached = new Map(cachedRoutes);
  for (const [id, route] of local.routes) cached.set(id, { points: route.points.map(transform) });
  const changedEdges = graph.edges.filter(edge => edge.source !== edge.target
    && (!cached.has(edge.id) || movable.has(edge.source) !== movable.has(edge.target)
      || graph.nodes.some(node => node.id !== edge.source && node.id !== edge.target
        && (movable.has(node.id) || movable.has(edge.source) && movable.has(edge.target))
        && routeIntersectsBox(cached.get(edge.id).points, { left: nextPositions[node.id].x - 12,
          right: nextPositions[node.id].x + WIDTH + 12, top: nextPositions[node.id].y - 12,
          bottom: nextPositions[node.id].y + HEIGHT + 12 })))).map(edge => edge.id);
  return routeLocalGraph({ graph, positions: nextPositions, previousPositions: positions,
    cachedRoutes: cached, edgeIds: changedEdges, flexibleIds: movableIds, fixedPositions: true });
}
export async function arrangeGraph({ graph, positions, selectedIds = [], ELK = globalThis.ELK }) {
  if (!graph.nodes.length) return {};
  assertPositions(graph, positions);
  const selected = visibleSelection(graph, selectedIds);
  if (selected.length > 0 && selected.length < graph.nodes.length) {
    const result = await layoutSelection(graph, positions, selected, ELK);
    return Object.fromEntries(selected.map(id => [id, result.positions[id]]));
  }
  return (await layoutAll(graph, positions, ELK)).positions;
}

export async function arrangeGraphWithRoutes(options) {
  const selected = visibleSelection(options.graph, options.selectedIds ?? []);
  if (selected.length > 0 && selected.length < options.graph.nodes.length) {
    assertPositions(options.graph, options.positions);
    return layoutSelection(options.graph, options.positions, selected, options.ELK ?? globalThis.ELK, options.cachedRoutes);
  }
  assertPositions(options.graph, options.positions);
  return layoutAll(options.graph, options.positions, options.ELK ?? globalThis.ELK, options.timings, { signal: options.signal, onPhase: options.onPhase });
}
