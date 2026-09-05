import { leafHierarchy, modularHierarchy, explicitHierarchy, groupBoundary } from './layout-structure.mjs';

// 以画布坐标计量；首尾接入段必须足够容纳箭头，直线只需满足一次下限。
export const MIN_ROUTE_SEGMENT = 30;
export function routeEndpointLengths(points) {
  if (!Array.isArray(points) || points.length < 2) return { first: 0, last: 0 };
  const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  return { first: distance(points[0], points[1]), last: distance(points.at(-2), points.at(-1)) };
}
export function routeMeetsMinimum(points) {
  const { first, last } = routeEndpointLengths(points);
  return Number.isFinite(first) && Number.isFinite(last)
    && first >= MIN_ROUTE_SEGMENT - 1e-6 && last >= MIN_ROUTE_SEGMENT - 1e-6;
}

// 节点、端口、组尺寸与连线共同求解；浏览器 Worker 与离线验证共享同一实现。
const W = 166, H = 62, EPS = 1e-6;
const equal = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const inOpen = (n, a, b) => n > Math.min(a, b) + EPS && n < Math.max(a, b) - EPS;
const overlap = (a, b, c, d) => Math.max(0, Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d)));
export const clean = points => {
  const result = [];
  for (const point of points) {
    if (result.length && equal(result.at(-1), point)) continue;
    while (result.length > 1) {
      const a = result.at(-2), b = result.at(-1);
      if (!((Math.abs(a.x - b.x) < EPS && Math.abs(b.x - point.x) < EPS)
        || (Math.abs(a.y - b.y) < EPS && Math.abs(b.y - point.y) < EPS))
        || b.x < Math.min(a.x, point.x) - EPS || b.x > Math.max(a.x, point.x) + EPS
        || b.y < Math.min(a.y, point.y) - EPS || b.y > Math.max(a.y, point.y) + EPS) break;
      result.pop();
    }
    result.push(point);
  }
  return result;
};
const pairs = graph => {
  const weights = new Map();
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    const key = JSON.stringify([edge.source, edge.target].sort());
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  return [...weights].map(([key, weight]) => ({ ids: JSON.parse(key), weight }));
};

// 可解释的原型：每步合并连接强、边界相对小的两组。每次都重算关联度，
// 用于验证分组假设，尚未针对大型图实现优先队列或增量更新。
export function affinityHierarchy(graph, target = 3) {
  const links = pairs(graph), degree = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const { ids: [a, b], weight } of links) { degree.set(a, degree.get(a) + weight); degree.set(b, degree.get(b) + weight); }
  let serial = 0;
  const groups = new Map(graph.nodes.map(node => [node.id, { id: node.id, members: [node.id], volume: degree.get(node.id), children: null }]));
  const snapshots = [{ count: groups.size, groups: [...groups.values()] }], merges = [];
  while (groups.size > target) {
    const owner = new Map([...groups.values()].flatMap(group => group.members.map(id => [id, group.id])));
    const adjacency = new Map();
    for (const { ids: [a, b], weight } of links) {
      const first = owner.get(a), second = owner.get(b); if (first === second) continue;
      const key = JSON.stringify([first, second].sort()); adjacency.set(key, (adjacency.get(key) ?? 0) + weight);
    }
    let best = null;
    for (const [key, weight] of adjacency) {
      const [a, b] = JSON.parse(key), left = groups.get(a), right = groups.get(b);
      const score = weight / Math.sqrt(left.volume * right.volume);
      const size = left.members.length + right.members.length;
      if (!best || score > best.score + EPS || Math.abs(score - best.score) < EPS && (size < best.size || size === best.size && key < best.key))
        best = { a, b, score, weight, size, key };
    }
    if (!best) break; // 不连通分量不伪造关联，只在根层独立摆放。
    const left = groups.get(best.a), right = groups.get(best.b);
    const next = { id: `__group_${serial++}`, members: [...left.members, ...right.members], volume: left.volume + right.volume, children: [left, right] };
    groups.delete(left.id); groups.delete(right.id); groups.set(next.id, next);
    merges.push({ ...best, id: next.id, members: next.members, remaining: groups.size });
    snapshots.push({ count: groups.size, groups: [...groups.values()] });
  }
  return { roots: [...groups.values()], snapshots, merges };
}

export function treeFor(graph, mode, options = {}) {
  if (!['flat', 'leaf', 'affinity-flat', 'affinity-recursive', 'modular', 'modular-recursive', 'explicit', 'explicit-recursive', 'adaptive'].includes(mode)) throw Error(`未知布局候选：${mode}`);
  const hierarchy = options.hierarchy ?? (mode === 'leaf' ? leafHierarchy(graph) : mode.startsWith('modular') ? modularHierarchy(graph)
    : mode.startsWith('explicit') ? explicitHierarchy(graph, options.clusters) : affinityHierarchy(graph));
  const shallow = hierarchy.snapshots?.reduce((best, value) => Math.abs(value.count - Math.ceil(Math.sqrt(graph.nodes.length))) < Math.abs(best.count - Math.ceil(Math.sqrt(graph.nodes.length))) ? value : best);
  const nodes = new Map(graph.nodes.map(node => [node.id, { id: node.id, width: W, height: H,
    layoutOptions: { 'elk.portConstraints': 'FREE' }, ports: [] }]));
  const ranks = new Map(), reversedEdges = [];
  if (options.orientation === 'breadth-first') {
    const adjacency = new Map(graph.nodes.map(node => [node.id, new Set()]));
    for (const edge of graph.edges) if (edge.source !== edge.target) {
      adjacency.get(edge.source).add(edge.target); adjacency.get(edge.target).add(edge.source);
    }
    const order = [...adjacency.keys()].sort((a, b) => adjacency.get(b).size - adjacency.get(a).size || a.localeCompare(b));
    for (const root of order) {
      if (ranks.has(root)) continue;
      const queue = [root]; ranks.set(root, ranks.size);
      for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i])) {
        if (!ranks.has(next)) { ranks.set(next, ranks.size); queue.push(next); }
      }
    }
  }
  const edgeInputs = graph.edges.map(edge => {
    const source = `${edge.id}::source`, target = `${edge.id}::target`;
    nodes.get(edge.source).ports.push({ id: source, width: 0, height: 0 });
    nodes.get(edge.target).ports.push({ id: target, width: 0, height: 0 });
    // 求解器的临时朝向与规则方向分离，输出时恢复实际 source → target。
    const reverse = ranks.size && ranks.get(edge.source) > ranks.get(edge.target);
    if (reverse) reversedEdges.push(edge.id);
    return { id: edge.id, sources: [reverse ? target : source], targets: [reverse ? source : target] };
  });
  const layoutOptions = {
    'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.randomSeed': '42',
    'elk.layered.mergeEdges': 'false', 'elk.layered.mergeHierarchyEdges': 'false',
    'elk.spacing.nodeNode': '48', 'elk.spacing.edgeNode': String(MIN_ROUTE_SEGMENT), 'elk.spacing.edgeEdge': '14',
    'elk.spacing.portPort': '12', 'elk.layered.spacing.nodeNodeBetweenLayers': '80',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '14', 'elk.layered.spacing.edgeNodeBetweenLayers': String(MIN_ROUTE_SEGMENT),
    'elk.layered.thoroughness': '12', ...options.layoutOptions,
  };
  const groupNode = (group, recursive) => {
    if (!group.children) return nodes.get(group.id);
    // ELK 的这些间距选项不会自动继承到子组；每层必须显式应用同一合同。
    return { id: group.id, layoutOptions: {
      'elk.spacing.nodeNode': String(MIN_ROUTE_SEGMENT),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(MIN_ROUTE_SEGMENT),
      'elk.spacing.edgeNode': String(MIN_ROUTE_SEGMENT),
      'elk.layered.spacing.edgeNodeBetweenLayers': String(MIN_ROUTE_SEGMENT),
      'elk.padding': '[top=30,left=30,bottom=30,right=30]',
    },
      children: recursive ? group.children.map(item => groupNode(item, true)) : group.members.map(id => nodes.get(id)) };
  };
  const children = mode === 'flat' ? [...nodes.values()] : mode === 'affinity-flat'
    ? shallow.groups.map(group => groupNode(group, false)) : hierarchy.roots.map(group => groupNode(group, mode.endsWith('recursive')));
  return { hierarchy, reversedEdges, input: { id: '__root', children, edges: edgeInputs, layoutOptions } };
}

export function extractGeometry(result, graph) {
  const positions = {}, offsets = new Map(), groups = [], edges = [], sizes = {};
  const leafIds = new Set(graph.nodes.map(node => node.id));
  function visit(node, x = 0, y = 0, depth = 0) {
    x += node.x ?? 0; y += node.y ?? 0; offsets.set(node.id, { x, y });
    if (leafIds.has(node.id)) { positions[node.id] = { x, y }; sizes[node.id] = { width: node.width, height: node.height }; }
    else if (node.id !== '__root') groups.push({ id: node.id, x, y, width: node.width, height: node.height, depth });
    for (const edge of node.edges ?? []) edges.push({ ...edge, defaultContainer: node.id });
    for (const child of node.children ?? []) visit(child, x, y, depth + 1);
  }
  visit(result);
  const routes = [];
  for (const edge of edges) {
    const offset = offsets.get(edge.container ?? edge.defaultContainer);
    if (!offset) throw Error(`未知路径容器：${edge.id}`);
    if (edge.sections?.length !== 1) throw Error(`候选包含尚未支持的分段路径：${edge.id}，段数 ${edge.sections?.length}`);
    const section = edge.sections[0];
    routes.push([edge.id, { points: clean([section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(point => ({ x: point.x + offset.x, y: point.y + offset.y }))) }]);
  }
  return { positions, sizes, groups, routes };
}

// 独立计数，不继承旧求解器评分。交叉按不同边的几何交点去重；
// 非共线接触也单列，不能把十字改成贴住的两个转弯便宣称消除冲突。
export function measureGeometry(graph, geometry) {
  const routes = new Map(geometry.routes), { positions, sizes } = geometry;
  const metrics = { missing: 0, invalid: 0, nodeOverlaps: 0, nodeHits: 0, selfCrossings: 0, crossings: 0, contacts: 0,
    sharedEndpointCrossings: 0, overlaps: 0, nearParallel: 0, bends: 0, length: 0, area: 0, width: 0, height: 0 };
  const lines = [];
  const boxes = graph.nodes.map(node => ({ id: node.id, ...positions[node.id], width: sizes[node.id]?.width, height: sizes[node.id]?.height }));
  for (const box of boxes) if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) metrics.invalid++;
  if (routes.size !== geometry.routes.length || [...routes.keys()].some(id => !graph.edges.some(edge => edge.id === id))) metrics.invalid++;
  const onBoundary = (point, box) => point && box && (Math.abs(point.x - box.x) < EPS || Math.abs(point.x - box.x - box.width) < EPS)
    && point.y >= box.y - EPS && point.y <= box.y + box.height + EPS || point && box && (Math.abs(point.y - box.y) < EPS || Math.abs(point.y - box.y - box.height) < EPS)
    && point.x >= box.x - EPS && point.x <= box.x + box.width + EPS;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (overlap(a.x, a.x + a.width, b.x, b.x + b.width) > EPS && overlap(a.y, a.y + a.height, b.y, b.y + b.height) > EPS) metrics.nodeOverlaps++;
  }
  for (const edge of graph.edges) {
    const points = routes.get(edge.id)?.points;
    if (!points || points.length < 2) { metrics.missing++; continue; }
    if (!onBoundary(points[0], boxes.find(box => box.id === edge.source)) || !onBoundary(points.at(-1), boxes.find(box => box.id === edge.target))) metrics.invalid++;
    metrics.bends += Math.max(0, points.length - 2);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], vertical = Math.abs(a.x - b.x) < EPS;
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite) || !vertical && Math.abs(a.y - b.y) > EPS) { metrics.invalid++; continue; }
      if (equal(a, b)) { metrics.invalid++; continue; }
      metrics.length += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      const line = { edge, a, b, vertical, index: i }; lines.push(line);
      for (const box of boxes) {
        const hit = vertical ? inOpen(a.x, box.x, box.x + box.width) && overlap(a.y, b.y, box.y, box.y + box.height) > EPS
          : inOpen(a.y, box.y, box.y + box.height) && overlap(a.x, b.x, box.x, box.x + box.width) > EPS;
        if (hit) metrics.nodeHits++;
      }
    }
  }
  const crossings = new Set(), contacts = new Set(), incidentCrossings = new Set();
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i], b = lines[j];
    const same = a.edge.id === b.edge.id;
    if (same && Math.abs(a.index - b.index) <= 1) {
      if (a.vertical === b.vertical) {
        const shared = a.vertical ? overlap(a.a.y, a.b.y, b.a.y, b.b.y) : overlap(a.a.x, a.b.x, b.a.x, b.b.x);
        if (shared > EPS) { metrics.selfCrossings++; metrics.overlaps += shared; }
      }
      continue;
    }
    if (a.vertical === b.vertical) {
      const distance = Math.abs(a.vertical ? a.a.x - b.a.x : a.a.y - b.a.y);
      const shared = a.vertical ? overlap(a.a.y, a.b.y, b.a.y, b.b.y) : overlap(a.a.x, a.b.x, b.a.x, b.b.x);
      if (distance < EPS) { metrics.overlaps += shared; if (same && shared > EPS) metrics.selfCrossings++; }
      else if (distance < 12 && shared > EPS) metrics.nearParallel += shared * (12 - distance);
      continue;
    }
    const v = a.vertical ? a : b, h = a.vertical ? b : a, p = { x: v.a.x, y: h.a.y };
    if (p.x < Math.min(h.a.x, h.b.x) - EPS || p.x > Math.max(h.a.x, h.b.x) + EPS || p.y < Math.min(v.a.y, v.b.y) - EPS || p.y > Math.max(v.a.y, v.b.y) + EPS) continue;
    if (same) { metrics.selfCrossings++; continue; }
    const key = JSON.stringify([[a.edge.id, b.edge.id].sort(), Number(p.x.toFixed(4)), Number(p.y.toFixed(4))]);
    if (inOpen(p.x, h.a.x, h.b.x) && inOpen(p.y, v.a.y, v.b.y)) {
      crossings.add(key);
      if ([a.edge.source, a.edge.target].some(id => id === b.edge.source || id === b.edge.target)) incidentCrossings.add(key);
    } else contacts.add(key);
  }
  metrics.crossings = crossings.size; metrics.contacts = [...contacts].filter(key => !crossings.has(key)).length;
  metrics.sharedEndpointCrossings = incidentCrossings.size;
  const all = boxes.flatMap(box => [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }]).concat([...routes.values()].flatMap(route => route.points));
  if (all.length) {
    metrics.width = Math.max(...all.map(p => p.x)) - Math.min(...all.map(p => p.x));
    metrics.height = Math.max(...all.map(p => p.y)) - Math.min(...all.map(p => p.y));
    metrics.area = metrics.width * metrics.height;
  }
  for (const key of ['overlaps', 'nearParallel', 'length', 'area', 'width', 'height']) metrics[key] = Number(metrics[key].toFixed(2));
  return metrics;
}

export function qualityVector(metrics) {
  return [metrics.missing + metrics.invalid + metrics.nodeOverlaps + metrics.nodeHits + metrics.selfCrossings,
    metrics.crossings + metrics.contacts, metrics.overlaps, metrics.nearParallel, metrics.bends, metrics.length];
}

export const improves = (next, previous) => {
  const a = qualityVector(next), b = qualityVector(previous);
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > EPS) return a[i] < b[i];
  return false;
};

export async function solveLayout(graph, mode, options = {}) {
  const started = performance.now();
  const { hierarchy, input, reversedEdges } = treeFor(graph, mode, options);
  const prepared = performance.now();
  const engine = options.engine ?? new options.ELK();
  let result;
  try { result = await engine.layout(input); }
  finally { if (!options.engine) engine.dispose?.(); }
  const laidOut = performance.now();
  const geometry = extractGeometry(result, graph), reverse = new Set(reversedEdges);
  for (const [id, route] of geometry.routes) if (reverse.has(id)) route.points.reverse();
  const extracted = performance.now(), metrics = measureGeometry(graph, geometry), audited = performance.now();
  const interfaces = hierarchy.roots.map(group => ({ id: group.id, ...groupBoundary(graph, group.members) }));
  return { metrics, geometry, hierarchy: { ...hierarchy, interfaces }, timings: {
    prepareMs: prepared - started, layoutMs: laidOut - prepared, extractMs: extracted - laidOut,
    auditMs: audited - extracted, boundaryMs: performance.now() - audited,
  } };
}

// 用同一份分组树逐层解除约束，每轮只接受完整几何评价严格改善的候选。
// 候选只改变分组边界；每次求解都允许节点、端口、组尺寸和所有连线一起改变。
export async function refineHierarchy(graph, options = {}) {
  if (typeof options.ELK !== 'function') throw new Error('ELK 排版引擎未加载，请刷新页面后重试。');
  const engine = new options.ELK();
  try { return await refineWithEngine(graph, { ...options, engine }); }
  finally { engine.dispose?.(); }
}

async function refineWithEngine(graph, options) {
  const started = performance.now(), solves = [], rounds = [];
  const flat = await solveLayout(graph, 'flat', options);
  solves.push(flat.timings);
  const flatReady = performance.now();
  let frontier = modularHierarchy(graph).roots;
  const grouped = performance.now();
  let best = await solveLayout(graph, 'adaptive', { ...options, hierarchy: { roots: frontier } });
  solves.push(best.timings);
  const initialReady = performance.now();
  const attempts = [], accepted = [{ round: 0, metrics: best.metrics, groups: frontier.map(group => group.members) }];
  for (let round = 1; round <= (options.rounds ?? 3); round++) {
    const roundStarted = performance.now(), previousAttempts = attempts.length;
    let winner;
    for (let index = 0; index < frontier.length; index++) {
      const group = frontier[index]; if (!group.children) continue;
      const choices = [{ kind: 'children', replacement: group.children }];
      if (group.children.some(child => child.children)) choices.push({ kind: 'leaves', replacement: group.members.map(id => ({ id, members: [id], children: null })) });
      for (const { kind, replacement } of choices) {
        const roots = [...frontier.slice(0, index), ...replacement, ...frontier.slice(index + 1)];
        const candidate = await solveLayout(graph, 'adaptive', { ...options, hierarchy: { roots } });
        solves.push(candidate.timings);
        attempts.push({ round, group: group.id, kind, metrics: candidate.metrics });
        if (qualityVector(candidate.metrics)[0] !== 0) continue;
        if (improves(candidate.metrics, winner?.candidate.metrics ?? best.metrics)) winner = { candidate, roots, group: group.id, kind };
      }
    }
    rounds.push({ round, elapsedMs: performance.now() - roundStarted, candidates: attempts.length - previousAttempts, improved: Boolean(winner) });
    if (!winner) break;
    best = winner.candidate; frontier = winner.roots;
    accepted.push({ round, group: winner.group, kind: winner.kind, metrics: best.metrics, groups: frontier.map(group => group.members) });
  }
  const selected = improves(flat.metrics, best.metrics) ? 'flat' : 'refined';
  return { ...(selected === 'flat' ? flat : best), refinement: { attempts, accepted,
    comparison: { flat: flat.metrics, refined: best.metrics, selected }, timing: {
      flatReadyMs: flatReady - started, groupingMs: grouped - flatReady, initialReadyMs: initialReady - started,
      rounds, solveCount: solves.length,
      aggregate: Object.fromEntries(Object.keys(flat.timings).map(key => [key, solves.reduce((sum, timing) => sum + timing[key], 0)])),
      totalMs: performance.now() - started,
    } } };
}

export const AUTO_LAYOUT_OPTIONS = Object.freeze({
  rounds: 3,
  orientation: 'breadth-first',
  layoutOptions: Object.freeze({
    'elk.layered.crossingMinimization.hierarchicalSweepiness': '1',
    'elk.layered.crossingMinimization.greedySwitchHierarchical.type': 'TWO_SIDED',
  }),
});
