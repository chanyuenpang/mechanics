import { clean, measureGeometry, MIN_ROUTE_SEGMENT, routeEndpointLengths, routeMeetsMinimum } from './hierarchical-layout.mjs';

const W = 166, H = 62, GAP = 12, EPS = 1e-6;
const directions = { top: 1, bottom: 2, left: 4, right: 8 };
const vector = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
const finite = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const same = (a, b) => finite(a) && finite(b) && Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const box = (p, gap = 0) => ({ left: p.x - gap, right: p.x + W + gap, top: p.y - gap, bottom: p.y + H + gap });
const intersects = (a, b) => a.left < b.right - EPS && a.right > b.left + EPS && a.top < b.bottom - EPS && a.bottom > b.top + EPS;
const pointOn = (p, side, offset) => side === 'left' || side === 'right'
  ? { x: p.x + (side === 'right' ? W : 0), y: p.y + offset }
  : { x: p.x + offset, y: p.y + (side === 'bottom' ? H : 0) };
function sideOf(point, position) {
  if (!finite(point) || !finite(position)) return null;
  if (Math.abs(point.x - position.x) < EPS && point.y >= position.y - EPS && point.y <= position.y + H + EPS) return 'left';
  if (Math.abs(point.x - position.x - W) < EPS && point.y >= position.y - EPS && point.y <= position.y + H + EPS) return 'right';
  if (Math.abs(point.y - position.y) < EPS && point.x >= position.x - EPS && point.x <= position.x + W + EPS) return 'top';
  if (Math.abs(point.y - position.y - H) < EPS && point.x >= position.x - EPS && point.x <= position.x + W + EPS) return 'bottom';
  return null;
}
export function routeIntersectsBox(points, bounds) {
  return points?.slice(1).some((b, i) => {
    const a = points[i];
    return Math.abs(a.x - b.x) < EPS
      ? a.x > bounds.left + EPS && a.x < bounds.right - EPS && Math.min(a.y, b.y) < bounds.bottom - EPS && Math.max(a.y, b.y) > bounds.top + EPS
      : a.y > bounds.top + EPS && a.y < bounds.bottom - EPS && Math.min(a.x, b.x) < bounds.right - EPS && Math.max(a.x, b.x) > bounds.left + EPS;
  }) ?? false;
}

let avoidPromise;
async function loadAvoid() {
  if (!avoidPromise) avoidPromise = (async () => {
    const node = typeof process !== 'undefined' && Boolean(process.versions?.node);
    const { AvoidLib } = await import(node ? 'libavoid-js' : '/vendor/libavoid/index.js');
    if (node) await AvoidLib.load();
    else await AvoidLib.load('/vendor/libavoid/libavoid.wasm');
    return AvoidLib.getInstance();
  })();
  return avoidPromise;
}

// 只移动与落点实际碰撞的近邻。固定落点与其它节点均不参加全局松弛。
export function separateLocalCollisions(graph, positions, pinnedIds) {
  const result = { ...positions }, pinned = new Set(pinnedIds), shifted = [];
  const collisions = graph.nodes.filter(node => !pinned.has(node.id)
    && pinnedIds.some(id => intersects(box(result[id], MIN_ROUTE_SEGMENT), box(result[node.id]))));
  for (const node of collisions) {
    const before = result[node.id], candidates = [];
    for (const id of pinnedIds) {
      const p = result[id];
      candidates.push({ x: p.x - W - MIN_ROUTE_SEGMENT, y: before.y }, { x: p.x + W + MIN_ROUTE_SEGMENT, y: before.y },
        { x: before.x, y: p.y - H - MIN_ROUTE_SEGMENT }, { x: before.x, y: p.y + H + MIN_ROUTE_SEGMENT });
    }
    candidates.sort((a, b) => Math.abs(a.x - before.x) + Math.abs(a.y - before.y) - Math.abs(b.x - before.x) - Math.abs(b.y - before.y));
    const next = candidates.find(candidate => graph.nodes.every(other => other.id === node.id
      || !intersects(box(candidate, MIN_ROUTE_SEGMENT / 2), box(result[other.id], MIN_ROUTE_SEGMENT / 2))));
    if (!next) throw new Error('拖动落点附近没有可用空间；未移动外围节点，请调整落点。');
    result[node.id] = next; shifted.push(node.id);
  }
  return { positions: result, shifted };
}

export function affectedRouteIds(graph, positions, cached, movedIds) {
  const moved = new Set(movedIds);
  return graph.edges.filter(edge => edge.source !== edge.target && (
    moved.has(edge.source) || moved.has(edge.target) || !cached.get(edge.id)?.points
    || !sideOf(cached.get(edge.id).points[0], positions[edge.source])
    || !sideOf(cached.get(edge.id).points.at(-1), positions[edge.target])
    || movedIds.some(id => id !== edge.source && id !== edge.target && routeIntersectsBox(cached.get(edge.id).points, box(positions[id], GAP)))
  )).map(edge => edge.id);
}

function assignLocalPorts(graph, positions, previous, routes, affected, flexible, facing) {
  const records = [], reserved = new Map();
  const clearExit = (id, peer, side, offset) => {
    const p = positions[id], target = positions[peer], port = pointOn(p, side, offset), [vx, vy] = vector[side];
    const direct = side === 'right' ? target.x - p.x - W >= MIN_ROUTE_SEGMENT - EPS && port.y >= target.y + 8 && port.y <= target.y + H - 8
      : side === 'left' ? p.x - target.x - W >= MIN_ROUTE_SEGMENT - EPS && port.y >= target.y + 8 && port.y <= target.y + H - 8
        : side === 'bottom' ? target.y - p.y - H >= MIN_ROUTE_SEGMENT - EPS && port.x >= target.x + 8 && port.x <= target.x + W - 8
          : p.y - target.y - H >= MIN_ROUTE_SEGMENT - EPS && port.x >= target.x + 8 && port.x <= target.x + W - 8;
    const anchor = { x: port.x + vx * (MIN_ROUTE_SEGMENT + 4), y: port.y + vy * (MIN_ROUTE_SEGMENT + 4) };
    return !graph.nodes.some(node => node.id !== id && !(direct && node.id === peer)
      && routeIntersectsBox([port, anchor], box(positions[node.id], 4)));
  };
  const reserve = (id, side, offset) => {
    const key = id + '/' + side;
    if (!reserved.has(key)) reserved.set(key, []);
    reserved.get(key).push(offset);
  };
  for (const edge of graph.edges) if (edge.source !== edge.target) for (const role of ['source', 'target']) {
    const id = edge[role], other = edge[role === 'source' ? 'target' : 'source'];
    const oldPoint = role === 'source' ? routes.get(edge.id)?.points?.[0] : routes.get(edge.id)?.points?.at(-1);
    const oldPosition = affected.has(edge.id) ? previous[id] ?? positions[id] : positions[id];
    const oldSide = sideOf(oldPoint, oldPosition);
    const offset = oldSide && (oldSide === 'left' || oldSide === 'right' ? oldPoint.y - oldPosition.y : oldPoint.x - oldPosition.x);
    if (!affected.has(edge.id)) { if (oldSide) reserve(id, oldSide, offset); continue; }
    const p = positions[id], target = positions[other], dx = target.x - p.x, dy = target.y - p.y;
    let side = oldSide && !(facing && flexible.has(id)) ? oldSide
      : Math.abs(dx) / W >= Math.abs(dy) / H ? dx >= 0 ? 'right' : 'left' : dy >= 0 ? 'bottom' : 'top';
    if (!oldSide || facing && flexible.has(id)) {
      const choices = [side, ...Object.keys(vector).filter(value => value !== side)
        .sort((a, b) => (vector[b][0] - vector[a][0]) * dx / W + (vector[b][1] - vector[a][1]) * dy / H)];
      side = choices.find(candidate => clearExit(id, other, candidate, (candidate === 'left' || candidate === 'right' ? H : W) / 2)) ?? side;
    }
    const horizontal = side === 'left' || side === 'right', axis = horizontal ? 'y' : 'x', span = horizontal ? H : W;
    const low = Math.max(p[axis], target[axis]) + 8, high = Math.min(p[axis], target[axis]) + span - 8;
    // 相对两面有共同可用区间时，直接对齐端口，避免近共线连接凭空多两个拐点。
    const aligned = low <= high ? (low + high) / 2 - p[axis] : span / 2;
    records.push({ edgeId: edge.id, role, nodeId: id, peerId: other, side,
      fixed: Boolean(oldSide && !(facing && flexible.has(id))),
      desired: facing || !oldSide ? aligned : oldSide === side ? offset : span / 2,
      order: side === 'left' || side === 'right' ? target.y : target.x });
  }
  records.sort((a, b) => Number(b.fixed) - Number(a.fixed) || a.nodeId.localeCompare(b.nodeId) || a.side.localeCompare(b.side) || a.order - b.order || a.edgeId.localeCompare(b.edgeId));
  const assignments = new Map();
  for (const record of records) {
    const { nodeId, side } = record, length = side === 'left' || side === 'right' ? H : W;
    const used = reserved.get(nodeId + '/' + side) ?? [];
    const count = records.filter(item => item.nodeId === nodeId && item.side === side).length + used.length;
    const clearance = Math.min(6, (length - 16) / Math.max(1, count));
    const slots = [Math.max(8, Math.min(length - 8, record.desired))];
    for (let offset = 8; offset <= length - 8; offset += Math.min(2, clearance / 2)) slots.push(offset);
    slots.sort((a, b) => Math.abs(a - record.desired) - Math.abs(b - record.desired) || a - b);
    const offset = record.fixed ? record.desired : slots.find(value => used.every(other => Math.abs(value - other) >= clearance - EPS)
      && clearExit(nodeId, record.peerId, side, value));
    if (offset === undefined) throw Object.assign(new Error('局部端口空间不足：' + nodeId), { code: 'LOCAL_ROUTE_CANDIDATE_INVALID' });
    reserve(nodeId, side, offset);
    const port = pointOn(positions[nodeId], side, offset);
    if (!assignments.has(record.edgeId)) assignments.set(record.edgeId, {});
    assignments.get(record.edgeId)[record.role] = { nodeId, side, port };
  }
  return assignments;
}

async function routeCandidate(graph, positions, assignments, edges, A) {
  const router = new A.Router(A.RouterFlag.OrthogonalRouting.value), temporaries = [], shapes = new Map();
  const keep = value => (temporaries.push(value), value);
  try {
    router.setRoutingParameter(A.RoutingParameter.segmentPenalty, 40);
    router.setRoutingParameter(A.RoutingParameter.crossingPenalty, 1000);
    router.setRoutingParameter(A.RoutingParameter.fixedSharedPathPenalty, 1000);
    router.setRoutingParameter(A.RoutingParameter.shapeBufferDistance, 4);
    router.setRoutingParameter(A.RoutingParameter.idealNudgingDistance, GAP);
    for (const node of graph.nodes) {
      const p = positions[node.id];
      const rectangle = keep(new A.Rectangle(keep(new A.Point(p.x, p.y)), keep(new A.Point(p.x + W, p.y + H))));
      shapes.set(node.id, new A.ShapeRef(router, rectangle));
    }
    const connectors = new Map(), direct = new Map(); let serial = 1;
    for (const edge of edges) {
      const assignment = assignments.get(edge.id), source = assignment.source.port, target = assignment.target.port;
      const directPoints = [source, target], dx = target.x - source.x, dy = target.y - source.y;
      const [sx, sy] = vector[assignment.source.side], [tx, ty] = vector[assignment.target.side];
      if ((Math.abs(dx) < EPS || Math.abs(dy) < EPS) && routeMeetsMinimum(directPoints)
        && dx * sx + dy * sy > 0 && dx * tx + dy * ty < 0
        && !graph.nodes.some(node => routeIntersectsBox(directPoints, box(positions[node.id])))) {
        direct.set(edge.id, directPoints); continue;
      }
      const ends = [], checkpoints = keep(new A.CheckpointVector());
      for (const endpoint of [assignment.source, assignment.target]) {
        const shape = shapes.get(endpoint.nodeId), p = positions[endpoint.nodeId], pin = serial++;
        new A.ShapeConnectionPin(shape, pin, endpoint.port.x - p.x, endpoint.port.y - p.y, false, 0, directions[endpoint.side]);
        ends.push(keep(new A.ConnEnd(shape, pin)));
        const [vx, vy] = vector[endpoint.side];
        const anchor = keep(new A.Point(endpoint.port.x + vx * MIN_ROUTE_SEGMENT, endpoint.port.y + vy * MIN_ROUTE_SEGMENT));
        // 法线外的必经点为接入段保留 30px，最终仍独立审计实际首尾线段。
        checkpoints.push_back(keep(new A.Checkpoint(anchor)));
      }
      const connector = new A.ConnRef(router, ...ends);
      connector.setRoutingCheckpoints(checkpoints);
      connectors.set(edge.id, connector);
    }
    router.processTransaction();
    return new Map(edges.map(edge => {
      if (direct.has(edge.id)) return [edge.id, { points: direct.get(edge.id) }];
      const polyline = connectors.get(edge.id).displayRoute(), assignment = assignments.get(edge.id);
      const points = clean(Array.from({ length: polyline.size() }, (_, index) => {
        const point = polyline.at(index); return { x: point.x, y: point.y };
      }));
      if (!same(points[0], assignment.source.port) || !same(points.at(-1), assignment.target.port)) {
        throw Object.assign(new Error('局部路由未遵守固定端口：' + edge.id), { code: 'LOCAL_ROUTE_CANDIDATE_INVALID' });
      }
      return [edge.id, { points }];
    }));
  } finally {
    router.delete();
    for (const value of temporaries.reverse()) value.delete();
  }
}

function geometry(graph, positions, routes) {
  return { positions, routes: [...routes], sizes: Object.fromEntries(graph.nodes.map(node => [node.id, { width: W, height: H }])) };
}
function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > EPS) return a[i] - b[i];
  return 0;
}
const routeScore = metrics => [metrics.crossings + metrics.contacts, metrics.overlaps, metrics.nearParallel, metrics.bends, metrics.length];

// 两个矩形的相对面存在共同投影时，可直接构造直线，不必搜索复杂路径。
// 每次仅替换一条受影响边，避免其它边换端口的代价阻止这个简单改进。
function straightenLocalRoutes(graph, positions, routes, edges) {
  let current = routes, score = routeScore(measureGeometry(graph, geometry(graph, positions, current)));
  const occupiedPort = (edge, points) => graph.edges.some(other => other.id !== edge.id && other.source !== other.target
    && ['source', 'target'].some((role, index) => ['source', 'target'].some(otherRole =>
      edge[role] === other[otherRole] && (() => {
        const port = otherRole === 'source' ? current.get(other.id)?.points[0] : current.get(other.id)?.points.at(-1);
        const point = index === 0 ? points[0] : points.at(-1);
        return port && Math.hypot(point.x - port.x, point.y - port.y) < 6 - EPS;
      })())));
  const consider = (edge, points) => {
    if (!routeMeetsMinimum(points) || occupiedPort(edge, points)) return;
    const candidate = new Map(current); candidate.set(edge.id, { points });
    const metrics = measureGeometry(graph, geometry(graph, positions, candidate));
    if (metrics.invalid || metrics.missing || metrics.nodeHits || metrics.selfCrossings) return;
    const nextScore = routeScore(metrics);
    // 先满足接入段的硬约束，再比较交叉、拐点和长度。
    if (!routeMeetsMinimum(current.get(edge.id).points) || compare(nextScore, score) < 0) { current = candidate; score = nextScore; }
  };
  for (const edge of edges) {
    const source = positions[edge.source], target = positions[edge.target], original = current.get(edge.id).points;
    if (original.length === 2 && routeMeetsMinimum(original)) continue;
    // 两个相对端口挤在不足 60px 的通道时，尝试相邻侧的一次转弯。
    // 只改当前受影响边的端口，不移动节点，也不改其它边。
    if (!routeMeetsMinimum(original)) {
      for (const sourceSide of Object.keys(vector)) for (const targetSide of Object.keys(vector)) {
        const [sx, sy] = vector[sourceSide], [tx, ty] = vector[targetSide];
        if (sx * tx + sy * ty !== 0) continue;
        const a = pointOn(source, sourceSide, (sx ? H : W) / 2), b = pointOn(target, targetSide, (tx ? H : W) / 2);
        const elbow = sx ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
        if ((elbow.x - a.x) * sx + (elbow.y - a.y) * sy <= 0
          || (elbow.x - b.x) * tx + (elbow.y - b.y) * ty <= 0) continue;
        consider(edge, [a, elbow, b]);
      }
    }
    for (const axis of ['x', 'y']) {
      const across = axis === 'x' ? 'y' : 'x', span = axis === 'x' ? W : H, depth = axis === 'x' ? H : W;
      const low = Math.max(source[axis], target[axis]) + 8, high = Math.min(source[axis], target[axis]) + span - 8;
      if (low > high || Math.abs(source[across] - target[across]) <= depth) continue;
      const forward = target[across] > source[across];
      for (const slot of [...new Set([original[0][axis], original.at(-1)[axis], (low + high) / 2])]) {
        if (slot < low || slot > high) continue;
        const points = [{ [axis]: slot, [across]: source[across] + (forward ? depth : 0) },
          { [axis]: slot, [across]: target[across] + (forward ? 0 : depth) }];
        consider(edge, points);
      }
    }
  }
  return current;
}

// 用新端口接回原路线的中段；每次只改变首尾，保留已有通道作为局部候选。
function spliceCachedRoutes(edges, assignments, cached, positions, graph) {
  const result = new Map();
  const connect = (port, middle, side, backwards = false) => {
    const [vx, vy] = vector[side], anchor = { x: port.x + vx * MIN_ROUTE_SEGMENT, y: port.y + vy * MIN_ROUTE_SEGMENT };
    const elbow = vx ? { x: anchor.x, y: middle.y } : { x: middle.x, y: anchor.y };
    const points = clean([port, anchor, elbow, middle]);
    return backwards ? points.reverse() : points;
  };
  for (const edge of edges) {
    const original = cached.get(edge.id)?.points;
    if (!original?.length) return null;
    const endpoints = assignments.get(edge.id), variants = [];
    for (const first of [0, 1, 2]) for (const tail of [0, 1, 2]) {
      const last = original.length - 1 - tail;
      if (first > last || !original[first] || !original[last]) continue;
      const points = clean([
        ...connect(endpoints.source.port, original[first], endpoints.source.side),
        ...original.slice(first + 1, last),
        ...connect(endpoints.target.port, original[last], endpoints.target.side, true),
      ]);
      const metric = measureGeometry({ ...graph, edges: [edge] }, geometry(graph, positions, new Map([[edge.id, { points }]])));
      if (metric.invalid || metric.missing || metric.nodeHits || metric.selfCrossings || !routeMeetsMinimum(points)) continue;
      variants.push({ points, score: [metric.bends, metric.length] });
    }
    if (!variants.length) return null;
    variants.sort((a, b) => compare(a.score, b.score));
    result.set(edge.id, { points: variants[0].points });
  }
  return result;
}

// 影响域在计算前固定；不会因为邻接、交叉数量或迭代次数扩成全图重排。
export async function routeLocalGraph({ graph, positions, cachedRoutes = [], movedIds = [], previousPositions = positions,
  fixedPositions = false, edgeIds = null, flexibleIds = movedIds }) {
  for (const node of graph.nodes) if (!finite(positions[node.id])) throw new Error('节点缺少有效坐标：' + node.id);
  const cached = new Map(cachedRoutes), actualEdges = graph.edges.filter(edge => edge.source !== edge.target);
  const visible = new Set(graph.nodes.map(node => node.id)), moved = [...new Set(movedIds)].filter(id => visible.has(id));
  const separation = fixedPositions || !moved.length ? { positions: { ...positions }, shifted: [] }
    : separateLocalCollisions(graph, positions, moved);
  const resultPositions = separation.positions, changedNodes = [...moved, ...separation.shifted];
  const affected = new Set(edgeIds ?? affectedRouteIds(graph, resultPositions, cached, changedNodes));
  const localEdges = actualEdges.filter(edge => affected.has(edge.id));
  const routes = new Map(actualEdges.filter(edge => cached.has(edge.id)).map(edge => [edge.id, cached.get(edge.id)]));
  if (!localEdges.length) return { positions: resultPositions, routes, edgeIds: [], shiftedIds: separation.shifted, full: false };
  const A = await loadAvoid(), flexible = new Set([...flexibleIds, ...separation.shifted, ...localEdges.flatMap(edge => [edge.source, edge.target])]);
  let best, bestScore;
  const rejectedCandidates = [];
  for (const facing of [false, true]) {
    if (facing && !flexible.size) break;
    let local, assignments;
    try {
      assignments = assignLocalPorts(graph, resultPositions, previousPositions, cached, affected, flexible, facing);
      local = await routeCandidate(graph, resultPositions, assignments, localEdges, A);
    }
    catch (error) {
      if (error?.code !== 'LOCAL_ROUTE_CANDIDATE_INVALID') throw error;
      rejectedCandidates.push({ facing, reason: error.message }); continue;
    }
    const spliced = spliceCachedRoutes(localEdges, assignments, cached, resultPositions, graph);
    for (const raw of spliced ? [local, spliced] : [local]) {
      const staged = new Map(routes); for (const [id, route] of raw) staged.set(id, route);
      const normalized = straightenLocalRoutes(graph, resultPositions, staged, localEdges);
      const candidate = new Map(localEdges.map(edge => [edge.id, normalized.get(edge.id)]));
      const localMetrics = measureGeometry({ ...graph, edges: localEdges }, geometry(graph, resultPositions, candidate));
      if ([...candidate.values()].some(route => !routeMeetsMinimum(route.points))) {
        rejectedCandidates.push({ facing, reason: `连线首尾接入段不足 ${MIN_ROUTE_SEGMENT}px`,
          edges: [...candidate].filter(([, route]) => !routeMeetsMinimum(route.points))
            .map(([id, route]) => ({ id, ...routeEndpointLengths(route.points) })) }); continue;
      }
      if (localMetrics.missing || localMetrics.invalid || localMetrics.nodeHits || localMetrics.selfCrossings) {
        rejectedCandidates.push({ facing, reason: '局部路由返回无效几何', metrics: localMetrics }); continue;
      }
      const merged = new Map(routes); for (const [id, route] of candidate) merged.set(id, route);
      // 审计可读取外围路线，但只有局部 connector 能成为候选或被替换。
      const metrics = measureGeometry(graph, geometry(graph, resultPositions, merged));
      const score = [metrics.crossings + metrics.contacts, metrics.overlaps, metrics.nearParallel, localMetrics.bends, localMetrics.length];
      if (!best || compare(score, bestScore) < 0) { best = candidate; bestScore = score; }
    }
  }
  if (!best) throw Object.assign(new Error('局部路由候选均不可行，外围保持原样：' + rejectedCandidates.map(item => item.reason).join('；')),
    { code: 'LOCAL_ROUTING_INFEASIBLE', candidates: rejectedCandidates });
  for (const [id, route] of best) routes.set(id, route);
  return { positions: resultPositions, routes, edgeIds: [...affected], shiftedIds: separation.shifted,
    rejectedCandidates, full: affected.size === actualEdges.length };
}
