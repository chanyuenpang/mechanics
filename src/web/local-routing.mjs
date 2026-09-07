import { clean, measureGeometry, MIN_ROUTE_SEGMENT, routeEndpointLengths, routeMeetsMinimum } from './hierarchical-layout.mjs';
import { edgeBundles } from './layout-structure.mjs';

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
      // 两个轴的单独平移都被近邻挡住时，也检查落点四角；影响域仍只有直接碰撞的节点。
      for (const x of [p.x - W - MIN_ROUTE_SEGMENT, p.x + W + MIN_ROUTE_SEGMENT]) {
        for (const y of [p.y - H - MIN_ROUTE_SEGMENT, p.y + H + MIN_ROUTE_SEGMENT]) candidates.push({ x, y });
      }
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
  // 影响范围以当前几何为准；新增节点、撤销或连续拖动不一定携带完整 movedIds。
  const obstacles = graph.nodes.map(node => ({ id: node.id, bounds: box(positions[node.id], moved.has(node.id) ? GAP : 0) }));
  const affected = new Set(graph.edges.filter(edge => edge.source !== edge.target && (
    moved.has(edge.source) || moved.has(edge.target) || !cached.get(edge.id)?.points
    || !sideOf(cached.get(edge.id).points[0], positions[edge.source])
    || !sideOf(cached.get(edge.id).points.at(-1), positions[edge.target])
    || obstacles.some(({ id, bounds }) => id !== edge.source && id !== edge.target
      && routeIntersectsBox(cached.get(edge.id).points, bounds))
  )).map(edge => edge.id));
  // 任意一条成员失效，整个节点对必须一起重算，不能把旧通道拆成两条路径。
  return edgeBundles(graph).flatMap(group => group.bundleMembers.some(edge => affected.has(edge.id)) || !channelMatches(group, cached)
    ? group.bundleMembers.map(edge => edge.id) : []);
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

async function routeCandidate(graph, positions, assignments, edges, A, margin = 0) {
  const router = new A.Router(A.RouterFlag.OrthogonalRouting.value), temporaries = [], shapes = new Map();
  const keep = value => (temporaries.push(value), value);
  try {
    router.setRoutingParameter(A.RoutingParameter.segmentPenalty, 40);
    router.setRoutingParameter(A.RoutingParameter.crossingPenalty, 1000);
    router.setRoutingParameter(A.RoutingParameter.fixedSharedPathPenalty, 1000);
    router.setRoutingParameter(A.RoutingParameter.shapeBufferDistance, 4 + margin);
    router.setRoutingParameter(A.RoutingParameter.idealNudgingDistance, GAP);
    router.setRoutingOption(A.RoutingOption.penaliseOrthogonalSharedPathsAtConnEnds, true);
    for (const node of graph.nodes) {
      const p = positions[node.id];
      const rectangle = keep(new A.Rectangle(keep(new A.Point(p.x, p.y)), keep(new A.Point(p.x + W, p.y + H))));
      shapes.set(node.id, new A.ShapeRef(router, rectangle));
    }
    // 直线也登记到求解器，否则其它局部连线看不到它的占用。
    const referenceRoute = points => {
      const ends = [points[0], points.at(-1)].map(p => keep(new A.ConnEnd(keep(new A.Point(p.x, p.y)))));
      const connector = new A.ConnRef(router, ...ends), checkpoints = keep(new A.CheckpointVector());
      for (const p of points.slice(1, -1)) checkpoints.push_back(keep(new A.Checkpoint(keep(new A.Point(p.x, p.y)))));
      connector.setRoutingCheckpoints(checkpoints);
    };
    const connectors = new Map(), direct = new Map(); let serial = 1;
    for (const edge of edges) {
      const assignment = assignments.get(edge.id), source = assignment.source.port, target = assignment.target.port;
      const directPoints = [source, target], dx = target.x - source.x, dy = target.y - source.y;
      const [sx, sy] = vector[assignment.source.side], [tx, ty] = vector[assignment.target.side];
      if ((Math.abs(dx) < EPS || Math.abs(dy) < EPS) && routeMeetsMinimum(directPoints)
        && dx * sx + dy * sy > 0 && dx * tx + dy * ty < 0
        && !graph.nodes.some(node => routeIntersectsBox(directPoints, box(positions[node.id])))) {
        direct.set(edge.id, directPoints); referenceRoute(directPoints); continue;
      }
      const ends = [], checkpoints = keep(new A.CheckpointVector());
      for (const endpoint of [assignment.source, assignment.target]) {
        const shape = shapes.get(endpoint.nodeId), p = positions[endpoint.nodeId], pin = serial++;
        new A.ShapeConnectionPin(shape, pin, endpoint.port.x - p.x, endpoint.port.y - p.y, false, 0, directions[endpoint.side]);
        ends.push(keep(new A.ConnEnd(shape, pin)));
        const [vx, vy] = vector[endpoint.side];
        const anchor = keep(new A.Point(endpoint.port.x + vx * (MIN_ROUTE_SEGMENT + margin), endpoint.port.y + vy * (MIN_ROUTE_SEGMENT + margin)));
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
const invalidGeometry = metrics => metrics.invalid || metrics.missing || metrics.nodeHits || metrics.nodeOverlaps || metrics.selfCrossings;
const routeLength = points => points.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y), 0);
const detourLength = points => routeLength(points) - Math.abs(points[0].x - points.at(-1).x) - Math.abs(points[0].y - points.at(-1).y);
const routeScore = (metrics, routes) => [metrics.overlaps, metrics.crossings + metrics.contacts,
  [...routes.values()].reduce((sum, route) => sum + detourLength(route.points), 0), metrics.bends, metrics.length, metrics.nearParallel];
// 端口必须沿节点外法线出入；沿着节点边框走不能冒充一次转弯。
const exitsNode = (port, next, p) => Math.abs(port.x - p.x) < EPS && next.x < port.x - EPS
  || Math.abs(port.x - p.x - W) < EPS && next.x > port.x + EPS
  || Math.abs(port.y - p.y) < EPS && next.y < port.y - EPS
  || Math.abs(port.y - p.y - H) < EPS && next.y > port.y + EPS;

// 单边候选只比较它与当前其它路线的贡献，避免反复计算所有固定边之间的关系。
function interactionScore(points, otherRoutes, { maxCrossings = Infinity, stopOnOverlap = false } = {}) {
  let overlaps = 0, near = 0, crossingCount = 0, contactCount = 0, length = 0;
  const span = (a, b, c, d) => Math.max(0, Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d)));
  const bounds = { left: Math.min(...points.map(p => p.x)) - GAP, right: Math.max(...points.map(p => p.x)) + GAP,
    top: Math.min(...points.map(p => p.y)) - GAP, bottom: Math.max(...points.map(p => p.y)) + GAP };
  for (let i = 1; i < points.length; i++) length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  for (const route of otherRoutes) {
    if (route.envelope && !intersects(bounds, route.envelope)) continue;
    const crossings = new Set(), contacts = new Set();
    for (let i = 1; i < points.length; i++) for (let j = 1; j < route.points.length; j++) {
      const a = points[i - 1], b = points[i], c = route.points[j - 1], d = route.points[j];
      const vertical = Math.abs(a.x - b.x) < EPS, otherVertical = Math.abs(c.x - d.x) < EPS;
      if (vertical === otherVertical) {
        const distance = Math.abs(vertical ? a.x - c.x : a.y - c.y);
        const shared = vertical ? span(a.y, b.y, c.y, d.y) : span(a.x, b.x, c.x, d.x);
        if (distance < EPS) overlaps += shared;
        else if (distance < GAP) near += shared * (GAP - distance);
      } else {
        const [v, w, h, k] = vertical ? [a, b, c, d] : [c, d, a, b], x = v.x, y = h.y;
        if (x < Math.min(h.x, k.x) - EPS || x > Math.max(h.x, k.x) + EPS
          || y < Math.min(v.y, w.y) - EPS || y > Math.max(v.y, w.y) + EPS) continue;
        const key = x.toFixed(4) + '/' + y.toFixed(4);
        if (x > Math.min(h.x, k.x) + EPS && x < Math.max(h.x, k.x) - EPS
          && y > Math.min(v.y, w.y) + EPS && y < Math.max(v.y, w.y) - EPS) crossings.add(key);
        else contacts.add(key);
      }
    }
    const weight = route.crossingWeight ?? 1;
    crossingCount += crossings.size * weight; contactCount += [...contacts].filter(key => !crossings.has(key)).length * weight;
    if (stopOnOverlap && overlaps > EPS || crossingCount + contactCount > maxCrossings) break;
  }
  return [overlaps, crossingCount + contactCount, detourLength(points), Math.max(0, points.length - 2), length, near];
}

// 两个矩形的相对面存在共同投影时，可直接构造直线，不必搜索复杂路径。
// 每次仅替换一条受影响边，避免其它边换端口的代价阻止这个简单改进。
function straightenLocalRoutes(graph, positions, routes, edges, { simplify = true } = {}) {
  let current = routes, metrics = measureGeometry(graph, geometry(graph, positions, current)), score = routeScore(metrics, current);
  const byId = new Map(graph.edges.map(edge => [edge.id, edge]));
  let assessment;
  // 替换一条边时，外围之间的冲突完全不变。先比较当前边的贡献，
  // 明显更差的候选无需重新审计整图；可能改善或处于舍入边界时仍走原来的完整检查。
  const mightImprove = (edge, points) => {
    const original = current.get(edge.id);
    if (assessment?.edge !== edge || assessment.routes !== current) {
      const single = { ...graph, edges: [edge] };
      const own = measureGeometry(single, geometry(single, positions, new Map([[edge.id, original]])));
      const fixedInvalid = metrics.nodeOverlaps || ['invalid', 'missing', 'nodeHits', 'selfCrossings'].some(key => metrics[key] > own[key]);
      assessment = { edge, routes: current, fixedInvalid };
    }
    // 当前边无法修复外围的硬错误；原完整审计同样会拒绝这些候选。
    if (assessment.fixedInvalid) return false;
    if (!routeMeetsMinimum(original.points) || metrics.overlaps > 0) return true;
    if (!assessment.others) {
      assessment.others = [...current].filter(([id]) => id !== edge.id).map(([id, route]) => ({ ...route,
        crossingWeight: (edge.bundleMembers?.length ?? 1) * (byId.get(id)?.bundleMembers?.length ?? 1) }));
      assessment.crossings = interactionScore(original.points, assessment.others)[1];
    }
    const next = interactionScore(points, assessment.others);
    // 当前重叠代价已经为零，只筛掉明确新增的重叠或更多交叉；舍入边界仍交给完整审计。
    return next[0] < 0.01 && next[1] <= assessment.crossings;
  };
  const occupiedPort = (edge, points) => graph.edges.some(other => other.id !== edge.id && other.source !== other.target
    && ['source', 'target'].some((role, index) => ['source', 'target'].some(otherRole =>
      edge[role] === other[otherRole] && (() => {
        const port = otherRole === 'source' ? current.get(other.id)?.points[0] : current.get(other.id)?.points.at(-1);
        const point = index === 0 ? points[0] : points.at(-1);
        const original = index === 0 ? current.get(edge.id).points[0] : current.get(edge.id).points.at(-1);
        return !same(original, point) && port && Math.hypot(point.x - port.x, point.y - port.y) < 6 - EPS;
      })())));
  const consider = (edge, points) => {
    if (!routeMeetsMinimum(points) || occupiedPort(edge, points)) return;
    if (!mightImprove(edge, points)) return;
    const candidate = new Map(current); candidate.set(edge.id, { points });
    const candidateMetrics = measureGeometry(graph, geometry(graph, positions, candidate));
    if (invalidGeometry(candidateMetrics)) return;
    const nextScore = routeScore(candidateMetrics, candidate);
    // 先满足接入段的硬约束，再比较交叉、拐点和长度。
    if ((!routeMeetsMinimum(current.get(edge.id).points) && nextScore[0] <= score[0])
      || compare(nextScore, score) < 0) { current = candidate; metrics = candidateMetrics; score = nextScore; }
  };
  for (const edge of edges) {
    const source = positions[edge.source], target = positions[edge.target], original = current.get(edge.id).points;
    // 逐边尝试相邻侧的一次转弯，不能因为首尾已有 30px 就保留整条绕圈。
    // 只改当前受影响边的端口，不要求其它局部连线同时换侧。
    if (simplify && original.length > 3 || !routeMeetsMinimum(original)) {
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
      for (const slot of [...new Set([original[0][axis], original.at(-1)[axis], (low + high) / 2, low, high])]) {
        if (slot < low || slot > high) continue;
        const points = [{ [axis]: slot, [across]: source[across] + (forward ? depth : 0) },
          { [axis]: slot, [across]: target[across] + (forward ? 0 : depth) }];
        consider(edge, points);
      }
    }
  }
  return current;
}

// 逐段检查原折线中的捷径。保留端口和外围路线，用直线或一次转弯替换连续子路径。
// 每次必须减少折点、不增加线长和冲突；折点总数严格下降，所以迭代必然终止。
export function shortcutLocalRoutes(graph, positions, routes, edges) {
  let current = routes, changed;
  do {
    changed = false;
    for (const edge of edges) {
      const points = current.get(edge.id).points;
      if (points.length <= 3) continue;
      const others = [...current].filter(([id]) => id !== edge.id).map(([, route]) => route);
      const originalScore = interactionScore(points, others);
      let best, bestScore = originalScore;
      for (let first = 0; first < points.length - 3; first++) for (let last = points.length - 1; last >= first + 3; last--) {
        const a = points[first], b = points[last];
        for (const elbow of [{ x: a.x, y: b.y }, { x: b.x, y: a.y }]) {
          const candidate = clean([...points.slice(0, first + 1), elbow, ...points.slice(last)]);
          if (candidate.length >= points.length || !routeMeetsMinimum(candidate)
            || !exitsNode(candidate[0], candidate[1], positions[edge.source])
            || !exitsNode(candidate.at(-1), candidate.at(-2), positions[edge.target])) continue;
          const score = interactionScore(candidate, others);
          if (score[0] > originalScore[0] + EPS || score[1] > originalScore[1] || score[4] > originalScore[4] + EPS
            || compare(score, bestScore) >= 0) continue;
          const metrics = measureGeometry({ ...graph, edges: [edge] }, geometry(graph, positions, new Map([[edge.id, { points: candidate }]])));
          if (invalidGeometry(metrics)) continue;
          best = { points: candidate }; bestScore = score;
        }
      }
      if (best) { current = new Map(current); current.set(edge.id, best); changed = true; }
    }
  } while (changed);
  return current;
}

const sharedLength = (a, b, c, d) => {
  const axis = Math.abs(a.x - b.x) < EPS ? 'y' : 'x', across = axis === 'x' ? 'y' : 'x';
  if (Math.abs(c[across] - d[across]) > EPS || Math.abs(a[across] - c[across]) > EPS) return 0;
  return Math.max(0, Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))
    - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])));
};

// 固定折线保持只读。只平移局部路线中冲突的线段，首尾端口只能沿原节点边界滑动。
// 每次接受严格改善，再重新检查；其它连线不会为当前路线腾位。
function separateLocalChannels(graph, positions, routes, edges) {
  let current = routes;
  const shortfall = route => Object.values(routeEndpointLengths(route.points)).reduce((sum, value) => sum + Math.max(0, MIN_ROUTE_SEGMENT - value), 0);
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const edge of edges) {
      const points = current.get(edge.id).points, indices = new Set();
      const others = [...current].filter(([id]) => id !== edge.id).map(([, route]) => route);
      for (let i = 1; i < points.length; i++) {
        if (others.some(other => other.points.slice(1)
          .some((b, j) => sharedLength(points[i - 1], points[i], other.points[j], b) > EPS))) indices.add(i);
      }
      if (!routeMeetsMinimum(points)) { if (points.length > 2) { indices.add(2); indices.add(points.length - 2); } }
      let next, nextScore = [shortfall(current.get(edge.id)), ...interactionScore(points, others)];
      for (const index of indices) {
        const a = points[index - 1], b = points[index], across = Math.abs(a.x - b.x) < EPS ? 'x' : 'y';
        for (const delta of [-GAP, GAP, -2 * GAP, 2 * GAP, -3 * GAP, 3 * GAP, -6, 6, -2, 2, -1, 1]) {
          const shifted = points.map((p, i) => i === index - 1 || i === index ? { ...p, [across]: p[across] + delta } : p);
          if (sideOf(shifted[0], positions[edge.source]) !== sideOf(points[0], positions[edge.source])
            || sideOf(shifted.at(-1), positions[edge.target]) !== sideOf(points.at(-1), positions[edge.target])) continue;
          const route = { points: clean(shifted) }, score = [shortfall(route), ...interactionScore(route.points, others)];
          if (compare(score, nextScore) >= 0) continue;
          const metrics = measureGeometry({ ...graph, edges: [edge] }, geometry(graph, positions, new Map([[edge.id, route]])));
          if (invalidGeometry(metrics)) continue;
          next = route; nextScore = score;
        }
      }
      if (next) { current = new Map(current); current.set(edge.id, next); changed = true; }
    }
    if (!changed) break;
  }
  return current;
}

// 用新端口接回原路线的中段；每次只改变首尾，保留已有通道作为局部候选。
function spliceCachedRoutes(edges, assignments, cached, positions, graph, local) {
  const result = new Map(local), context = new Map(cached);
  for (const [id, route] of local) context.set(id, route);
  let spliced = false;
  const connect = (port, middle, side, backwards = false) => {
    const [vx, vy] = vector[side], anchor = { x: port.x + vx * MIN_ROUTE_SEGMENT, y: port.y + vy * MIN_ROUTE_SEGMENT };
    const elbow = vx ? { x: anchor.x, y: middle.y } : { x: middle.x, y: anchor.y };
    const points = clean([port, anchor, elbow, middle]);
    return backwards ? points.reverse() : points;
  };
  for (const edge of edges) {
    const original = cached.get(edge.id)?.points;
    if (!original?.length) continue;
    const endpoints = assignments.get(edge.id), variants = [];
    const others = [...context].filter(([id]) => id !== edge.id).map(([, route]) => route);
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
      variants.push({ points, score: interactionScore(points, others) });
    }
    if (!variants.length) continue;
    variants.sort((a, b) => compare(a.score, b.score));
    result.set(edge.id, { points: variants[0].points });
    context.set(edge.id, result.get(edge.id)); spliced = true;
  }
  return spliced ? result : null;
}

export const BUNDLE_GAP = 12;

// 对中心折线做正交等距偏移。拐点取相邻两条偏移直线的交点，不能逐点平移。
export function offsetChannel(points, offset) {
  const normals = points.slice(1).map((b, i) => {
    const a = points[i], dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    return { x: -dy, y: dx };
  });
  return points.map((p, i) => {
    const before = normals[Math.max(0, i - 1)], after = normals[Math.min(i, normals.length - 1)];
    return { x: p.x + offset * (before.x || after.x), y: p.y + offset * (before.y || after.y) };
  });
}

export function expandChannel(group, points) {
  return new Map(group.bundleMembers.map((edge, index) => {
    const lane = offsetChannel(points, (index - (group.bundleMembers.length - 1) / 2) * BUNDLE_GAP);
    return [edge.id, { points: edge.source === group.source ? lane : lane.reverse() }];
  }));
}

function channelMatches(group, routes) {
  if (group.bundleMembers.length < 2) return true;
  const first = routes.get(group.id)?.points;
  if (!first || first.length < 2) return false;
  return group.bundleMembers.every((edge, index) => {
    const lane = routes.get(edge.id)?.points, expected = offsetChannel(first, index * BUNDLE_GAP);
    if (!lane || lane.length !== expected.length) return false;
    return expected.every((p, i) => same(p, lane[edge.source === group.source ? i : lane.length - 1 - i]));
  });
}

function cachedChannel(group, routes) {
  const candidates = [];
  for (const [index, edge] of group.bundleMembers.entries()) {
    const old = routes.get(edge.id)?.points;
    if (!old?.length) continue;
    const points = edge.source === group.source ? old : [...old].reverse();
    candidates.push(offsetChannel(points, -(index - (group.bundleMembers.length - 1) / 2) * BUNDLE_GAP), points);
  }
  return candidates;
}

// 整组只选择一个中心路径。所有候选均在展开后审计，外围路线始终只读。
async function planChannel(graph, positions, group, cached, context, A, nativeCache) {
  const radius = (group.bundleMembers.length - 1) * BUNDLE_GAP / 2;
  const others = [...context.values()].map(route => ({ ...route, envelope: {
    left: Math.min(...route.points.map(p => p.x)), right: Math.max(...route.points.map(p => p.x)),
    top: Math.min(...route.points.map(p => p.y)), bottom: Math.max(...route.points.map(p => p.y)),
  } })), obstacles = graph.nodes.map(node => ({ id: node.id, bounds: box(positions[node.id]) }));
  const source = positions[group.source], target = positions[group.target];
  let best, bestScore, bestSpine;
  const seenCandidates = new Set();
  const consider = raw => {
    const points = clean(raw);
    if (points.slice(1).some((p, i) => Math.abs(p.x - points[i].x) > EPS && Math.abs(p.y - points[i].y) > EPS)) return;
    if (points.length < 2) return;
    // 交叉和拥挤代价的下界为零。连这个乐观下界都不优于已有路线，就无需展开和逐障碍审计。
    if (best && compare([0, detourLength(points), points.length - 2, routeLength(points), 0], bestScore) >= 0) return;
    const key = JSON.stringify(points);
    if (seenCandidates.has(key)) return;
    seenCandidates.add(key);
    if (points.length < 2 || !exitsNode(points[0], points[1], source)
      || !exitsNode(points.at(-1), points.at(-2), target)) return;
    const lanes = expandChannel(group, points);
    for (const edge of group.bundleMembers) {
      const lane = lanes.get(edge.id).points;
      if (!routeMeetsMinimum(lane) || !sideOf(lane[0], positions[edge.source]) || !sideOf(lane.at(-1), positions[edge.target])) return;
      // 内侧短段不得被偏移翻转，否则两条平行线会在拐角处打结。
      const oriented = edge.source === group.source ? lane : [...lane].reverse();
      for (let i = 1; i < points.length; i++) {
        if ((oriented[i].x - oriented[i - 1].x) * (points[i].x - points[i - 1].x)
          + (oriented[i].y - oriented[i - 1].y) * (points[i].y - points[i - 1].y) <= EPS) return;
      }
      if (obstacles.some(({ bounds }) => routeIntersectsBox(lane, bounds))) return;
    }
    let crossing = 0, near = 0;
    for (const lane of lanes.values()) {
      const score = interactionScore(lane.points, others, { maxCrossings: (bestScore?.[0] ?? Infinity) - crossing, stopOnOverlap: true });
      if (score[0] > EPS) return;
      crossing += score[1]; near += score[5];
      if (best && crossing > bestScore[0]) return;
    }
    const score = [crossing, detourLength(points), points.length - 2, routeLength(points), near];
    if (best && compare(score, bestScore) >= 0) return;
    const endpoints = { ...graph, nodes: graph.nodes.filter(node => node.id === group.source || node.id === group.target), edges: group.bundleMembers };
    const metric = measureGeometry(endpoints, geometry(endpoints, positions, lanes));
    if (invalidGeometry(metric) || metric.overlaps || metric.crossings || metric.contacts) return;
    best = lanes; bestScore = score; bestSpine = points;
  };
  for (const points of cachedChannel(group, cached)) consider(points);

  const ports = (id, peer, role) => {
    const p = positions[id], other = positions[peer], result = [];
    for (const side of Object.keys(vector)) {
      const horizontal = side === 'left' || side === 'right', span = horizontal ? H : W, axis = horizontal ? 'y' : 'x';
      const low = radius + 8, high = span - radius - 8;
      if (low > high) continue;
      const old = role === 'source' ? bestSpine?.[0] : bestSpine?.at(-1);
      const aligned = (Math.max(p[axis], other[axis]) + Math.min(p[axis] + span, other[axis] + span)) / 2 - p[axis];
      const desired = Math.max(low, Math.min(high, aligned));
      const occupied = others.flatMap(route => [route.points[0], route.points.at(-1)])
        .filter(point => sideOf(point, p) === side).map(point => point[axis] - p[axis]);
      const slots = [desired, span / 2, ...(sideOf(old, p) === side ? [old[axis] - p[axis]] : []),
        ...occupied.flatMap(offset => [offset - radius - 6, offset + radius + 6]), low, high];
      const available = [...new Set(slots.map(value => Math.max(low, Math.min(high, value))))]
        .filter(value => occupied.every(offset => Math.abs(value - offset) >= radius + 2 - EPS))
        .sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired));
      for (const offset of available.slice(0, 3)) {
        const port = pointOn(p, side, offset), [vx, vy] = vector[side];
        const anchor = { x: port.x + vx * (MIN_ROUTE_SEGMENT + radius), y: port.y + vy * (MIN_ROUTE_SEGMENT + radius) };
        if (obstacles.some(obstacle => obstacle.id !== id && obstacle.id !== peer && routeIntersectsBox([port, anchor], box(positions[obstacle.id], radius)))) continue;
        result.push({ nodeId: id, side, port, anchor });
      }
    }
    return result;
  };
  const starts = ports(group.source, group.target, 'source'), ends = ports(group.target, group.source, 'target'), pairs = [];
  for (const a of starts) for (const b of ends) {
    pairs.push({ source: a, target: b });
    const p = a.port, q = b.port, s = a.anchor, t = b.anchor;
    consider([p, q]);
    consider([p, { x: q.x, y: p.y }, q]); consider([p, { x: p.x, y: q.y }, q]);
    consider([p, s, { x: t.x, y: s.y }, t, q]); consider([p, s, { x: s.x, y: t.y }, t, q]);
    for (const x of [(s.x + t.x) / 2, Math.min(source.x, target.x) - MIN_ROUTE_SEGMENT - radius,
      Math.max(source.x, target.x) + W + MIN_ROUTE_SEGMENT + radius]) {
      consider([p, s, { x, y: s.y }, { x, y: t.y }, t, q]);
    }
    for (const y of [(s.y + t.y) / 2, Math.min(source.y, target.y) - MIN_ROUTE_SEGMENT - radius,
      Math.max(source.y, target.y) + H + MIN_ROUTE_SEGMENT + radius]) {
      consider([p, s, { x: s.x, y }, { x: t.x, y }, t, q]);
    }
  }
  // 简单候选被障碍挡住时，用同一个带宽度的 connector 搜索绕障路径。
  // 按端口的直接距离顺序检验，每个侧面组合只求解一次。
  if (!best || bestScore[0] || bestScore[1]) {
    pairs.sort((a, b) => Math.abs(a.source.port.x - a.target.port.x) + Math.abs(a.source.port.y - a.target.port.y)
      - Math.abs(b.source.port.x - b.target.port.x) - Math.abs(b.source.port.y - b.target.port.y));
    const seen = new Set();
    for (const assignment of pairs) {
      const key = assignment.source.side + '/' + assignment.target.side;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        // 同一次规划的节点障碍和通道宽度固定；外围路线仅参与评分，不参与这个原生单通道路由。
        // 两轮搜索遇到相同端口组合时复用结果，避免重复创建障碍图和 connector。
        const cacheKey = JSON.stringify([radius, ...[assignment.source, assignment.target]
          .flatMap(endpoint => [endpoint.nodeId, endpoint.side, endpoint.port.x, endpoint.port.y])]);
        let points = nativeCache.get(cacheKey);
        if (!points) {
          const routes = await routeCandidate(graph, positions, new Map([[group.id, assignment]]), [group], A, radius);
          points = routes.get(group.id).points; nativeCache.set(cacheKey, points);
        }
        consider(points);
      } catch (error) { if (error.code !== 'LOCAL_ROUTE_CANDIDATE_INVALID') throw error; }
      if (best && !bestScore[0] && !bestScore[1]) break;
    }
  }
  // 简化也以中心路径为单位；整组展开通过后才接受，不能只剪短其中一条线。
  let shortened = true;
  while (best && shortened) {
    const before = bestSpine, score = bestScore;
    for (let i = 0; i < before.length - 3; i++) for (let j = before.length - 1; j >= i + 3; j--) {
      const a = before[i], b = before[j];
      for (const elbow of [{ x: a.x, y: b.y }, { x: b.x, y: a.y }]) consider([...before.slice(0, i + 1), elbow, ...before.slice(j)]);
    }
    shortened = compare(bestScore, score) < 0;
  }
  if (!best) throw Object.assign(new Error('节点对没有可用的平行通道：' + group.source + ' / ' + group.target),
    { code: 'LOCAL_ROUTING_INFEASIBLE', edges: group.bundleMembers.map(edge => edge.id) });
  return best;
}

export async function routePairChannels({ graph, positions, cachedRoutes = [], edgeIds }) {
  graph = { ...graph, edges: graph.edges.filter(edge => edge.source !== edge.target) };
  const cached = new Map(cachedRoutes), requested = new Set(edgeIds ?? graph.edges.map(edge => edge.id));
  const groups = edgeBundles(graph), affected = groups.filter(group => group.bundleMembers.some(edge => requested.has(edge.id)));
  const ids = new Set(affected.flatMap(group => group.bundleMembers.map(edge => edge.id)));
  const routes = new Map(graph.edges.filter(edge => cached.has(edge.id)).map(edge => [edge.id, cached.get(edge.id)]));
  const fixed = graph.edges.filter(edge => !ids.has(edge.id)), fixedRoutes = new Map(fixed.map(edge => [edge.id, routes.get(edge.id)]));
  const baseline = measureGeometry({ ...graph, edges: fixed }, geometry(graph, positions, fixedRoutes));
  const A = await loadAvoid(), nativeCache = new Map();
  // 宽通道优先占位；后续通道读取已展开的每条线，不把它们误认为零宽中心线。
  affected.sort((a, b) => b.bundleMembers.length - a.bundleMembers.length || a.id.localeCompare(b.id));
  for (let round = 0; round < 2; round++) {
    let changed = false;
    for (const group of affected) {
      const own = new Set(group.bundleMembers.map(edge => edge.id)), context = new Map([...routes].filter(([id]) => !own.has(id)));
      const lanes = await planChannel(graph, positions, group, round ? routes : cached, context, A, nativeCache);
      for (const [id, route] of lanes) {
        if (JSON.stringify(route.points) !== JSON.stringify(routes.get(id)?.points)) changed = true;
        routes.set(id, route);
      }
    }
    if (!changed) break;
  }
  const metric = measureGeometry(graph, geometry(graph, positions, routes));
  if (invalidGeometry(metric) || metric.overlaps > baseline.overlaps + EPS) {
    throw Object.assign(new Error('平行通道展开后未通过完整几何审计，未提交。'), { code: 'LOCAL_ROUTING_INFEASIBLE', metrics: metric });
  }
  return { positions, routes, edgeIds: [...ids], shiftedIds: [], full: ids.size === graph.edges.length };
}

// 影响域在计算前固定；不会因为邻接、交叉数量或迭代次数扩成全图重排。
export async function routeLocalGraph({ graph, positions, cachedRoutes = [], movedIds = [], previousPositions = positions,
  fixedPositions = false, edgeIds = null, flexibleIds = movedIds }) {
  // 自环由画布单独绘制，不进入普通连接的缺失路线审计。
  graph = { ...graph, edges: graph.edges.filter(edge => edge.source !== edge.target) };
  for (const node of graph.nodes) if (!finite(positions[node.id])) throw new Error('节点缺少有效坐标：' + node.id);
  const cached = new Map(cachedRoutes), actualEdges = graph.edges.filter(edge => edge.source !== edge.target);
  const visible = new Set(graph.nodes.map(node => node.id)), moved = [...new Set(movedIds)].filter(id => visible.has(id));
  const separation = fixedPositions || !moved.length ? { positions: { ...positions }, shifted: [] }
    : separateLocalCollisions(graph, positions, moved);
  const resultPositions = separation.positions, changedNodes = [...moved, ...separation.shifted];
  const affected = new Set([...(edgeIds ?? []), ...affectedRouteIds(graph, resultPositions, cached, changedNodes)]);
  const bundles = edgeBundles(graph);
  for (const group of bundles) if (group.bundleMembers.some(edge => affected.has(edge.id))) {
    for (const member of group.bundleMembers) affected.add(member.id);
  }
  if (bundles.some(group => group.bundleMembers.length > 1) && affected.size) {
    const result = await routePairChannels({ graph, positions: resultPositions, cachedRoutes: cached, edgeIds: [...affected] });
    return { ...result, shiftedIds: separation.shifted };
  }
  const localEdges = actualEdges.filter(edge => affected.has(edge.id));
  const routes = new Map(actualEdges.filter(edge => cached.has(edge.id)).map(edge => [edge.id, cached.get(edge.id)]));
  if (!localEdges.length) {
    if (invalidGeometry(measureGeometry(graph, geometry(graph, resultPositions, routes)))) {
      throw Object.assign(new Error('缓存几何不合法，未提交局部改动。'), { code: 'LOCAL_ROUTING_INFEASIBLE' });
    }
    return { positions: resultPositions, routes, edgeIds: [], shiftedIds: separation.shifted, full: false };
  }
  const fixedEdges = actualEdges.filter(edge => !affected.has(edge.id));
  const fixedRoutes = new Map(fixedEdges.map(edge => [edge.id, routes.get(edge.id)]));
  const fixedMetrics = measureGeometry({ ...graph, edges: fixedEdges }, geometry(graph, resultPositions, fixedRoutes));
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
    const spliced = spliceCachedRoutes(localEdges, assignments, cached, resultPositions, graph, local);
    for (const raw of spliced ? [local, spliced] : [local]) {
      const staged = new Map(routes); for (const [id, route] of raw) staged.set(id, route);
      const straight = straightenLocalRoutes(graph, resultPositions, staged, localEdges, { simplify: false });
      const separated = separateLocalChannels(graph, resultPositions, straight, localEdges);
      // 先得到满足硬约束的整帧，再逐边简化，避免单边抢占端口后让下一条边增加交叉。
      const simplified = straightenLocalRoutes(graph, resultPositions, separated, localEdges);
      const normalized = shortcutLocalRoutes(graph, resultPositions, simplified, localEdges);
      const candidate = new Map(localEdges.map(edge => [edge.id, normalized.get(edge.id)]));
      const localMetrics = measureGeometry({ ...graph, edges: localEdges }, geometry(graph, resultPositions, candidate));
      if ([...candidate.values()].some(route => !routeMeetsMinimum(route.points))) {
        rejectedCandidates.push({ facing, reason: `连线首尾接入段不足 ${MIN_ROUTE_SEGMENT}px`,
          edges: [...candidate].filter(([, route]) => !routeMeetsMinimum(route.points))
            .map(([id, route]) => ({ id, ...routeEndpointLengths(route.points), points: route.points })) }); continue;
      }
      if (invalidGeometry(localMetrics)) {
        rejectedCandidates.push({ facing, reason: '局部路由返回无效几何', metrics: localMetrics }); continue;
      }
      const merged = new Map(routes); for (const [id, route] of candidate) merged.set(id, route);
      // 审计可读取外围路线，但只有局部 connector 能成为候选或被替换。
      const metrics = measureGeometry(graph, geometry(graph, resultPositions, merged));
      if (invalidGeometry(metrics) || metrics.overlaps > fixedMetrics.overlaps + EPS) {
        rejectedCandidates.push({ facing, reason: '合并后穿过节点或与其它线段重叠', metrics }); continue;
      }
      const score = [metrics.crossings + metrics.contacts, [...candidate.values()].reduce((sum, route) => sum + detourLength(route.points), 0),
        localMetrics.bends, localMetrics.length, metrics.nearParallel];
      if (!best || compare(score, bestScore) < 0) { best = candidate; bestScore = score; }
    }
  }
  if (!best) throw Object.assign(new Error('局部路由候选均不可行，外围保持原样：' + rejectedCandidates.map(item => item.reason).join('；')),
    { code: 'LOCAL_ROUTING_INFEASIBLE', candidates: rejectedCandidates });
  for (const [id, route] of best) routes.set(id, route);
  return { positions: resultPositions, routes, edgeIds: [...affected], shiftedIds: separation.shifted,
    rejectedCandidates, full: affected.size === actualEdges.length };
}
