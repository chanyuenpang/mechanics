import { leafHierarchy, modularHierarchy, groupBoundary, connectedComponents, layoutDirection, SNAP_GRID } from './layout-structure.mjs';
import { solveLayout, measureGeometry, qualityVector, MIN_ROUTE_SEGMENT, routeMeetsMinimum } from './hierarchical-layout.mjs';
import { routeLocalGraph } from './local-routing.mjs';

const W = 166, H = 62, EPS = 1e-6, MAX_FLOW_SUBTREE_MEMBERS = 16;
const bounds = (ids, positions) => ({
  left: Math.min(...ids.map(id => positions[id].x)), top: Math.min(...ids.map(id => positions[id].y)),
  right: Math.max(...ids.map(id => positions[id].x + W)), bottom: Math.max(...ids.map(id => positions[id].y + H)),
});
const isBackward = (edge, positions) => {
  const { source, target } = layoutDirection(edge);
  return positions[target].x < positions[source].x - EPS;
};
export function flowMetrics(graph, geometry) {
  let backwardEdges = 0, backwardLength = 0;
  const routes = new Map(geometry.routes);
  for (const edge of graph.edges) {
    for (const member of edge.bundleMembers ?? [edge]) {
      if (isBackward(member, geometry.positions)) backwardEdges++;
      const points = routes.get(edge.id)?.points ?? [], sign = (member.sign === -1 ? -1 : 1) * (member.source === edge.source ? 1 : -1);
      // 合并通道只减少求解数量，水平朝向仍逐条评价真实关系，竖直段不计入逆向长度。
      for (let i = 1; i < points.length; i++) backwardLength += Math.max(0, sign * (points[i - 1].x - points[i].x));
    }
  }
  return { backwardEdges, backwardLength: Math.round(backwardLength * 100) / 100 };
}

export function flowSubtrees(graph) {
  const records = new Map();
  const add = members => {
    // 方向优化会为候选子树重新求解并把它放回全图；大分支会退化成
    // 高扇出全图求解，既不再是局部优化，也会阻塞实际的分类树排版。
    if (!members.length || members.length > MAX_FLOW_SUBTREE_MEMBERS) return;
    const key = [...members].sort().join('\u0000');
    if (!records.has(key)) records.set(key, groupBoundary(graph, members));
  };
  for (const root of leafHierarchy(graph).roots) {
    add(root.members);
    const stack = root.attachmentTree ? [root.attachmentTree] : [];
    while (stack.length) {
      const tree = stack.pop(); stack.push(...tree.attached);
      for (const branch of tree.attached) {
        const members = [], visit = [branch];
        while (visit.length) { const item = visit.pop(); members.push(item.id); visit.push(...item.attached); }
        add(members);
      }
    }
  }
  const queue = [...modularHierarchy(graph).roots];
  while (queue.length) {
    const group = queue.pop();
    if (group.children) queue.push(...group.children);
    if (group.members.length <= MAX_FLOW_SUBTREE_MEMBERS) add(group.members);
  }
  return [...records.values()].filter(group => group.boundary.length <= 6);
}

function quality(graph, geometry) {
  return { ...measureGeometry(graph, geometry), ...flowMetrics(graph, geometry) };
}

// 每个独立区域先尝试就近吸附，再逐步放大间距；卡片尺寸不变，沿原侧面接回端口。
// 每次都从原几何生成候选，避免累积吸附误差；只提交通过审计的最小放大比例。
export function snapLayoutToGrid(graph, geometry) {
  const before = measureGeometry(graph, geometry);
  if (qualityVector(before)[0]) throw new Error('自动排版吸附前的几何无效，未提交。');
  if (Object.values(geometry.positions).every(p => p.x % SNAP_GRID === 0 && p.y % SNAP_GRID === 0)
    && geometry.routes.every(([, route]) => routeMeetsMinimum(route.points))) return geometry;
  const snap = value => Math.round(value / SNAP_GRID) * SNAP_GRID, routes = new Map(geometry.routes);
  const origin = { x: Math.min(...Object.values(geometry.positions).map(p => p.x)),
    y: Math.min(...Object.values(geometry.positions).map(p => p.y)) };
  const attempts = [];
  let rerouteCandidate = null;
  for (let step = 0; step <= 10; step++) {
    const factor = 1 + step * 0.05;
    const scale = p => ({ x: origin.x + (p.x - origin.x) * factor, y: origin.y + (p.y - origin.y) * factor });
    const positions = Object.fromEntries(graph.nodes.map(node => {
      const p = geometry.positions[node.id], center = scale({ x: p.x + W / 2, y: p.y + H / 2 });
      return [node.id, { x: snap(center.x - W / 2), y: snap(center.y - H / 2) }];
    }));
    const candidate = { ...geometry, positions, routes: [] }; let blockedEdge = null;
    // 即使旧折线路径在吸附后不再可用，也保留不重叠的节点候选，交给调用方完整重算路径。
    // 节点网格与路径是两项独立约束；不能因为旧路径无法仿射变形就拒绝整个自动排版。
    if (measureGeometry({ ...graph, edges: [] }, { positions, routes: [], sizes: geometry.sizes }).nodeOverlaps === 0) rerouteCandidate = positions;
    for (const edge of graph.edges) {
      const old = routes.get(edge.id).points, points = old.map(scale), ports = [];
      for (const [role, i, adjacent] of [['source', 0, 1], ['target', old.length - 1, old.length - 2]]) {
        const p = positions[edge[role]], original = geometry.positions[edge[role]];
        const horizontal = Math.abs(old[i].y - old[adjacent].y) < EPS;
        const port = { x: p.x + old[i].x - original.x, y: p.y + old[i].y - original.y };
        const axis = horizontal ? 'y' : 'x', size = horizontal ? H : W;
        port[axis] = Math.max(p[axis], Math.min(p[axis] + size, scale(old[i])[axis]));
        ports.push({ port, p, horizontal }); points[i] = port;
        if (old.length > 2) points[adjacent][horizontal ? 'y' : 'x'] = port[horizontal ? 'y' : 'x'];
      }
      // 原直线继续使用同一条直线，端口只在两端侧面的共同区间内移动。
      if (old.length === 2) {
        const axis = ports[0].horizontal ? 'y' : 'x', size = ports[0].horizontal ? H : W;
        const lo = Math.max(...ports.map(p => p.p[axis])), hi = Math.min(...ports.map(p => p.p[axis] + size));
        if (lo > hi) { blockedEdge = edge.id; break; }
        points[0][axis] = points[1][axis] = Math.max(lo, Math.min(hi, (ports[0].port[axis] + ports[1].port[axis]) / 2));
      }
      // 端口接回不能把短中间段翻到另一边，否则可能改变原折线的转弯形状。
      if (points.some((p, i) => i > 0 && ['x', 'y'].some(axis => {
        const delta = old[i][axis] - old[i - 1][axis];
        return Math.abs(delta) > EPS && delta * (p[axis] - points[i - 1][axis]) <= 0;
      }))) { blockedEdge = edge.id; break; }
      candidate.routes.push([edge.id, { points }]);
    }
    if (blockedEdge) { attempts.push({ factor, blockedEdge }); continue; }
    const after = measureGeometry(graph, candidate);
    const shortEdges = candidate.routes.filter(([, route]) => !routeMeetsMinimum(route.points)).map(([id]) => id);
    if (!qualityVector(after)[0] && !shortEdges.length && after.crossings <= before.crossings
      && after.contacts <= before.contacts && after.overlaps <= before.overlaps + EPS) return candidate;
    attempts.push({ factor, metrics: after, shortEdges });
  }
  throw Object.assign(new Error('自动排版放大并吸附后未通过几何检查，未提交。'), { attempts, rerouteCandidate });
}

// 对一个独立区域按 x 从左往右反复收紧；节点、端口与拐点共用坐标约束。
// 固定节点宽度和端口偏移，保持全部横向次序，因此不限制端口位于哪一面。
export function compactHorizontalRoutes(graph, geometry) {
  const reviewOrder = [...graph.nodes].sort((a, b) => geometry.positions[a.id].x - geometry.positions[b.id].x
    || geometry.positions[a.id].y - geometry.positions[b.id].y || a.id.localeCompare(b.id));
  const columns = [...new Set([...Object.values(geometry.positions).flatMap(p => [p.x, p.x + W]),
    ...geometry.routes.flatMap(([, route]) => route.points.map(p => p.x))])].sort((a, b) => a - b);
  if (!columns.length) return { geometry, metrics: quality(graph, geometry), moves: [], iterations: 0, reviewOrder: [] };
  const indexes = new Map(columns.map((x, i) => [x, i])), constraints = columns.map(() => []);
  const minimum = (a, b, distance) => constraints[indexes.get(a)].push({ to: indexes.get(b), distance });
  const fixed = (a, b, distance) => { minimum(a, b, distance); minimum(b, a, -distance); };
  // 相邻坐标最多收紧到 30px；原来更小的车道间距不再缩小。
  for (let i = 1; i < columns.length; i++) minimum(columns[i - 1], columns[i], Math.min(MIN_ROUTE_SEGMENT, columns[i] - columns[i - 1]));
  for (const node of reviewOrder) {
    const x = geometry.positions[node.id].x;
    fixed(x, x + W, W);
  }
  const routes = new Map(geometry.routes);
  for (const edge of graph.edges) {
    const points = routes.get(edge.id)?.points;
    if (!points?.length) throw new Error('水平紧缩缺少连线：' + edge.id);
    for (const role of ['source', 'target']) {
      const port = role === 'source' ? points[0] : points.at(-1), x = geometry.positions[edge[role]].x;
      fixed(x, port.x, port.x - x);
    }
    for (const [a, b] of [[points[0], points[1]], [points.at(-2), points.at(-1)]]) {
      if (Math.abs(a.x - b.x) > EPS) minimum(Math.min(a.x, b.x), Math.max(a.x, b.x), MIN_ROUTE_SEGMENT);
    }
  }
  const values = columns.map(() => 0); let iterations = 0;
  // 每轮始终按水平坐标顺序扫描。等宽约束向前传回变化时，下一轮继续传播。
  for (; iterations < columns.length; iterations++) {
    let changed = false;
    for (let i = 0; i < columns.length; i++) for (const { to, distance } of constraints[i]) {
      const next = values[i] + distance;
      if (next > values[to] + EPS) { values[to] = next; changed = true; }
    }
    if (!changed) break;
  }
  if (iterations === columns.length) throw new Error('水平紧缩约束无法收敛，未提交。');
  const shift = p => ({ x: columns[0] + values[indexes.get(p.x)], y: p.y });
  const candidate = { ...geometry, positions: Object.fromEntries(Object.entries(geometry.positions).map(([id, p]) => [id, shift(p)])),
    routes: geometry.routes.map(([id, route]) => [id, { points: route.points.map(shift) }]) };
  const before = quality(graph, geometry), after = quality(graph, candidate);
  if (qualityVector(after)[0] || candidate.routes.some(([, route]) => !routeMeetsMinimum(route.points))) {
    throw new Error('水平紧缩未通过几何检查，未提交。');
  }
  const accepted = after.length <= before.length + EPS && (after.length < before.length - EPS || after.width < before.width - EPS)
    && after.crossings + after.contacts <= before.crossings + before.contacts && after.overlaps <= before.overlaps + EPS
    && after.nearParallel <= before.nearParallel + EPS && after.backwardEdges <= before.backwardEdges;
  const moves = accepted ? reviewOrder.filter(node => Math.abs(candidate.positions[node.id].x - geometry.positions[node.id].x) > EPS)
    .map(node => ({ nodeId: node.id, axis: 'x', delta: candidate.positions[node.id].x - geometry.positions[node.id].x })) : [];
  return { geometry: accepted ? candidate : geometry, metrics: accepted ? after : before,
    moves, iterations: iterations + 1, reviewOrder: reviewOrder.map(node => node.id) };
}
function preferred(before, after, directionTradeoff, original) {
  if (qualityVector(after)[0] || after.overlaps > before.overlaps + EPS || after.nearParallel > before.nearParallel + EPS) return false;
  if (after.backwardLength > before.backwardLength + EPS || after.length > original.length * 1.15) return false;
  const beforeCross = before.crossings + before.contacts, afterCross = after.crossings + after.contacts;
  if (after.backwardEdges >= before.backwardEdges) return false;
  if (directionTradeoff === 'crossings-first') return afterCross <= beforeCross;
  // 一次额外交叉至少换取四条回流边的消除，同时限制单次交叉增量。
  return afterCross <= beforeCross + 1 && afterCross * 4 + after.backwardEdges < beforeCross * 4 + before.backwardEdges;
}
const collides = (a, b) => a.x < b.x + W + 12 - EPS && a.x + W + 12 > b.x + EPS
  && a.y < b.y + H + 12 - EPS && a.y + H + 12 > b.y + EPS;

function shapeGeometry(graph, current, members, mirror) {
  const ids = new Set(members), region = bounds(members, current.positions);
  const positions = Object.fromEntries(members.map(id => [id, { x: mirror ? region.right - current.positions[id].x - W
    : current.positions[id].x - region.left, y: current.positions[id].y - region.top }]));
  const internal = new Set(graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => edge.id));
  const routes = current.routes.filter(([id]) => internal.has(id)).map(([id, route]) => [id, {
    points: route.points.map(point => ({ x: mirror ? region.right - point.x : point.x - region.left, y: point.y - region.top })),
  }]);
  return { positions, routes };
}

// 基础布局之后的局部迭代：拆开一个子树整理内部，再把整块放回父层。
// 每个候选仅改变组内节点和边界边，外部几何作为不可变边界条件。
export async function improveFlowBySubtrees(graph, geometry, options = {}) {
  let instance;
  const engine = { layout(input) { instance ??= new options.ELK(); return instance.layout(input); } };
  try { return await iterateFlow(graph, geometry, { ...options, engine }); }
  finally { instance?.dispose?.(); }
}

async function iterateFlow(graph, geometry, { ELK, engine, rounds = 2, candidateLimit = 16,
  directionTradeoff = 'crossings-first' } = {}) {
  let current = geometry, currentQuality = quality(graph, current);
  const originalQuality = currentQuality;
  const accepted = [], rejected = [];
  // 无向分组可能从汇入中心向外排。整个独立区域先比较镜像，不受子树大小或轮数限制，
  // 不调用求解器；节点和完整路线一起翻转，实际 source → target 不变。
  for (const component of connectedComponents(graph)) {
    const members = component.nodes.map(node => node.id), ids = new Set(members);
    const edgeIds = new Set(component.edges.map(edge => edge.id)), region = bounds(members, current.positions);
    const flip = point => ({ x: region.left + region.right - point.x, y: point.y });
    const positions = Object.fromEntries(Object.entries(current.positions).map(([id, point]) => [id,
      ids.has(id) ? { x: region.left + region.right - point.x - W, y: point.y } : point]));
    if (flowMetrics(component, { positions, routes: [] }).backwardEdges >= flowMetrics(component, { positions: current.positions, routes: [] }).backwardEdges) continue;
    const candidate = { ...current, positions, routes: current.routes.map(([id, route]) => [id,
      edgeIds.has(id) ? { points: route.points.map(flip) } : route]) };
    const nextQuality = quality(graph, candidate);
    // 全图审计仍保护可能位于该区域外框内的其他独立节点和路线。
    if (nextQuality.length > currentQuality.length + EPS || candidate.routes.some(([, route]) => !routeMeetsMinimum(route.points))
      || !preferred(currentQuality, nextQuality, 'crossings-first', originalQuality)) continue;
    current = candidate; currentQuality = nextQuality;
    accepted.push({ round: 0, operation: 'mirror-component', members, boundary: [],
      crossings: currentQuality.crossings, backwardEdges: currentQuality.backwardEdges });
  }
  const groups = flowSubtrees(graph), edges = new Map(graph.edges.map(edge => [edge.id, edge]));
  for (let round = 0; round < rounds; round++) {
    let winner;
    const ranked = groups.map(group => {
      const related = graph.edges.filter(edge => group.internal.includes(edge.id) || group.boundary.some(item => item.edgeId === edge.id));
      const backward = related.flatMap(edge => edge.bundleMembers ?? [edge]).filter(edge => isBackward(edge, current.positions)).length;
      return { ...group, backward };
    }).filter(group => group.backward > 0).sort((a, b) => a.members.length - b.members.length
      || a.boundary.length - b.boundary.length || b.backward - a.backward).slice(0, candidateLimit);
    for (const group of ranked) {
      const ids = new Set(group.members), oldBounds = bounds(group.members, current.positions);
      const outside = graph.nodes.filter(node => !ids.has(node.id));
      const boundary = group.boundary.flatMap(edge => edges.get(edge.edgeId).bundleMembers ?? [edges.get(edge.edgeId)]);
      const outputs = boundary.filter(edge => ids.has(layoutDirection(edge).source)).length;
      const left = outputs >= boundary.length - outputs;
      const neighborIds = [...new Set(group.boundary.map(edge => edge.outside))];
      const neighborBounds = neighborIds.length ? bounds(neighborIds, current.positions) : oldBounds;
      const shapes = [shapeGeometry(graph, current, group.members, false), shapeGeometry(graph, current, group.members, true)];
      if (group.members.length > 1) {
        const localGraph = { nodes: graph.nodes.filter(node => ids.has(node.id)), edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
        const arranged = await solveLayout(localGraph, 'flat', { ELK, engine });
        const localBounds = bounds(group.members, arranged.geometry.positions);
        shapes.push({ positions: Object.fromEntries(Object.entries(arranged.geometry.positions).map(([id, point]) => [id,
          { x: point.x - localBounds.left, y: point.y - localBounds.top }])),
          routes: arranged.geometry.routes.map(([id, route]) => [id, { points: route.points.map(point => ({ x: point.x - localBounds.left, y: point.y - localBounds.top })) }]) });
      }
      // 单节点镜像与原形完全相同；相同子图形状只搜索一次，保留首次候选和原有择优规则。
      const seenShapes = new Set();
      for (const shape of shapes) {
        const shapeKey = JSON.stringify(shape);
        if (seenShapes.has(shapeKey)) continue;
        seenShapes.add(shapeKey);
        const size = bounds(group.members, shape.positions);
        const x = left ? neighborBounds.left - size.right - 80 : neighborBounds.right + 80;
        // 小图本身也可作为一块翻转或重排；没有外部连接时留在原区域。
        const targets = [{ x: oldBounds.left, y: oldBounds.top }];
        if (neighborIds.length) {
          const outer = bounds(outside.map(node => node.id), current.positions);
          targets.push({ x, y: oldBounds.top },
            { x: left ? outer.left - size.right - 80 : outer.right + 80, y: oldBounds.top });
        }
        const seenTargets = [];
        for (const target of targets) {
          if (seenTargets.some(previous => Object.is(previous.x, target.x) && Object.is(previous.y, target.y))) continue;
          seenTargets.push(target);
          const shift = point => ({ x: point.x + target.x, y: point.y + target.y });
          const localPositions = Object.fromEntries(Object.entries(shape.positions).map(([id, point]) => [id, shift(point)]));
          // 方向纠正只调整横坐标；初始联合排版拥有纵向安排，不用上下挪位换取方向收益。
          if (group.members.some(id => Math.abs(localPositions[id].y - current.positions[id].y) > EPS)) continue;
          for (const id of group.members) localPositions[id].y = current.positions[id].y;
          if (Object.values(localPositions).some(point => outside.some(node => collides(point, current.positions[node.id])))) continue;
          const positions = { ...current.positions, ...localPositions };
          if (flowMetrics(graph, { positions, routes: [] }).backwardEdges >= currentQuality.backwardEdges) continue;
          const routes = new Map(current.routes);
          for (const [id, route] of shape.routes) routes.set(id, { points: route.points.map(shift) });
          let result;
          try {
            result = await routeLocalGraph({ graph, positions, previousPositions: current.positions,
              cachedRoutes: routes, edgeIds: group.boundary.map(edge => edge.edgeId), flexibleIds: group.members, fixedPositions: true });
          } catch (error) {
            if (error?.code !== 'LOCAL_ROUTING_INFEASIBLE') throw error;
            rejected.push({ round, members: group.members, reason: error.message }); continue;
          }
          const candidate = { ...current, positions: result.positions, routes: [...result.routes] };
          const nextQuality = quality(graph, candidate);
          if (preferred(currentQuality, nextQuality, directionTradeoff, originalQuality)
            && (!winner || nextQuality.backwardEdges < winner.quality.backwardEdges
              || nextQuality.backwardEdges === winner.quality.backwardEdges && (nextQuality.crossings < winner.quality.crossings
                || nextQuality.crossings === winner.quality.crossings && nextQuality.length < winner.quality.length))) {
            winner = { geometry: candidate, quality: nextQuality, members: group.members, boundary: group.boundary.map(edge => edge.edgeId) };
          }
        }
      }
    }
    if (!winner) break;
    current = winner.geometry; currentQuality = winner.quality;
    accepted.push({ round: round + 1, members: winner.members, boundary: winner.boundary,
      crossings: currentQuality.crossings, backwardEdges: currentQuality.backwardEdges });
  }
  return { geometry: current, metrics: currentQuality, accepted, rejected };
}
