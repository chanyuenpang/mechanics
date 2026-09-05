import { auditGraphGeometryStrict, improveRouteGeometry, rerouteMovedNodes, routeEndpointSegmentsValid,
  routeGraphEdges, routeGraphEndpointExcursions, routeGraphSpacingConflicts } from './canvas.mjs';

const WIDTH = 166;
const HEIGHT = 62;
const GRID = 20;

const snap = value => Math.max(-100000, Math.min(100000, Math.round(value / GRID) * GRID));
const cutShift = (value, axis, cuts) => cuts.filter(cut => cut.axis === axis).reduce((total, cut) => {
  const half = Math.ceil(cut.deficit / 2 / GRID) * GRID;
  return total + (value <= cut.coordinate ? -half : half);
}, 0);
const routeGeometrySnapshot = routes => JSON.stringify([...routes].map(([id, route]) => [id, {
  points: route.points ?? route,
  sourcePort: route.points ? route.sourcePort : null,
  targetPort: route.points ? route.targetPort : null,
}]));

const compareTuple = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (Math.abs(delta) > .001) return delta;
  }
  return 0;
};

const nodeBounds = (position, clearance = 24) => ({
  left: position.x - clearance, right: position.x + WIDTH + clearance,
  top: position.y - clearance, bottom: position.y + HEIGHT + clearance,
});
const unionBounds = (left, right) => ({ left: Math.min(left.left, right.left), right: Math.max(left.right, right.right),
  top: Math.min(left.top, right.top), bottom: Math.max(left.bottom, right.bottom) });
const boundsIntersect = (left, right) => left.left < right.right && left.right > right.left
  && left.top < right.bottom && left.bottom > right.top;

function edgeMap(graph) {
  return new Map(graph.edges.filter(edge => edge.source !== edge.target).map(edge => [edge.id, edge]));
}

function localWitnessEdges(graph, witness) {
  const byId = edgeMap(graph), seeds = new Set(witness.edges.filter(id => byId.has(id)));
  const endpointNodes = new Set([...seeds].flatMap(id => [byId.get(id).source, byId.get(id).target]));
  // 同一端口的边必须一起重新分配槽位，但不把整个图升级为重路由。
  for (const edge of byId.values()) if (endpointNodes.has(edge.source) || endpointNodes.has(edge.target)) seeds.add(edge.id);
  return [...seeds].sort();
}

function rerouteWitnessEdges(graph, positions, routes, witness, cola) {
  const ids = localWitnessEdges(graph, witness), byId = edgeMap(graph);
  if (!ids.length || ids.some(id => !routes.get(id)?.points)) return null;
  const local = routeGraphEdges({ ...graph, edges: ids.map(id => byId.get(id)) }, positions, cola,
    new Map([...routes].filter(([id]) => !ids.includes(id))), { allowProvisional: true });
  return new Map([...routes, ...local]);
}

function matchingInternalSegments(points, segment) {
  const matches = [], coordinate = segment.vertical ? segment.a.x : segment.a.y;
  // 是否属于端点接入段已由 witness.endpoints 判定；不能再假定它在 points
  // 数组中的索引一定避开首末，因为端口引线可被规范化折叠。
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index], b = points[index + 1];
    const vertical = a.x === b.x;
    if (vertical !== segment.vertical) continue;
    const axis = vertical ? a.x : a.y;
    if (Math.abs(axis - coordinate) > .01) continue;
    const sameDirection = a.x === segment.a.x && a.y === segment.a.y && b.x === segment.b.x && b.y === segment.b.y;
    const reverseDirection = a.x === segment.b.x && a.y === segment.b.y && b.x === segment.a.x && b.y === segment.a.y;
    const a1 = vertical ? a.y : a.x, a2 = vertical ? b.y : b.x;
    const b1 = vertical ? segment.a.y : segment.a.x, b2 = vertical ? segment.b.y : segment.b.x;
    if (sameDirection || reverseDirection || Math.min(Math.max(a1, a2), Math.max(b1, b2)) > Math.max(Math.min(a1, a2), Math.min(b1, b2))) {
      matches.push(index);
    }
  }
  return matches;
}

// 共线重叠的第一修复层：只把见证线段及相邻两个拐点让到相邻车道。
// 这不会改变节点坐标，也不会改动其它边；每个候选随后仍由严格审计筛掉
// 节点穿越、斜线或新重叠，因此不是视觉层面的“强行错开”。
function nudgeWitnessSegments(routes, witness, distance = 48) {
  const results = [];
  for (let edgeIndex = 0; edgeIndex < witness.edges.length; edgeIndex++) {
    const edgeId = witness.edges[edgeIndex], segment = witness.segments[edgeIndex], route = routes.get(edgeId);
    const original = route?.points ?? route;
    const indexes = original ? matchingInternalSegments(original, segment) : [];
    if (!indexes.length) continue;
    // 先使用标准车道宽度；若该位置恰好已有另一条长通道，再扩大到两、三倍。
    // 这里只改一小段折线，不会把节点或整条坐标层级一起推开。
    for (const offset of [distance, distance * 2, distance * 3]) for (const direction of [-1, 1]) {
      const candidate = new Map([...routes].map(([id, value]) => [id, value?.points
        ? { ...structuredClone(value), points: value.points.map(point => ({ ...point })) }
        : value.map(point => ({ ...point }))]));
      const target = candidate.get(edgeId), points = target.points ?? target;
      for (const index of indexes) {
        if (segment.vertical) { points[index].x += direction * offset; points[index + 1].x += direction * offset; }
        else { points[index].y += direction * offset; points[index + 1].y += direction * offset; }
      }
      results.push(candidate);
    }
  }
  return results;
}

function sweptClosure(graph, positions, seedIds, axis, direction, distance) {
  const closure = new Set(seedIds), delta = axis === 'x' ? { x: direction * distance, y: 0 }
    : { x: 0, y: direction * distance };
  let changed = true;
  while (changed) {
    changed = false;
    const swept = [...closure].map(id => unionBounds(nodeBounds(positions[id]), nodeBounds({
      x: positions[id].x + delta.x, y: positions[id].y + delta.y,
    })));
    for (const node of graph.nodes) {
      if (closure.has(node.id)) continue;
      if (swept.some(area => boundsIntersect(area, nodeBounds(positions[node.id])))) {
        closure.add(node.id); changed = true;
      }
    }
  }
  return { nodeIds: [...closure].sort(), delta };
}

function moveClosure(positions, nodeIds, delta) {
  const result = structuredClone(positions);
  for (const id of nodeIds) {
    result[id].x = snap(result[id].x + delta.x);
    result[id].y = snap(result[id].y + delta.y);
  }
  return result;
}

function candidatePlans(graph, positions, witness) {
  const byId = edgeMap(graph), distance = Math.max(GRID, Math.ceil(witness.deficit / GRID) * GRID);
  const plans = [], witnessEdges = witness.edges.map(id => byId.get(id)).filter(Boolean);
  // 对两个冲突边交错试探 source / target，保证有限预算不会再次只覆盖字典序
  // 靠前的一条边。
  for (const role of ['source', 'target']) for (const edge of witnessEdges) {
    // 先试单端点：一条走廊冲突通常只需让其中一条边的一个端点退出原车道。
    // 这比同时搬动整条边的两个端点更符合“最小受影响范围”。
    for (const direction of [-1, 1]) {
      const nodeId = edge[role];
      const closure = sweptClosure(graph, positions, [nodeId], witness.axis, direction, distance);
      plans.push({ ...closure, axis: witness.axis, direction, distance, edgeId: edge.id,
        key: `${closure.nodeIds.join(',')}/${witness.axis}/${direction}/${edge.id}/${nodeId}` });
    }
  }
  for (const edge of witnessEdges) {
    // 单端点不可行时才考虑端点对，仍由扫掠闭包扩展到真正会被碰到的节点。
    for (const direction of [-1, 1]) {
      const closure = sweptClosure(graph, positions, [edge.source, edge.target], witness.axis, direction, distance);
      plans.push({ ...closure, axis: witness.axis, direction, distance, edgeId: edge.id,
        key: `${closure.nodeIds.join(',')}/${witness.axis}/${direction}/${edge.id}` });
    }
  }
  return [...new Map(plans.map(plan => [plan.key, plan])).values()];
}

function candidateCost(before, candidate, plan) {
  const bounds = values => Object.values(values).reduce((result, point) => result
    ? unionBounds(result, nodeBounds(point)) : nodeBounds(point), null);
  const oldBounds = bounds(before), nextBounds = bounds(candidate);
  const areaIncrease = (nextBounds.right - nextBounds.left) * (nextBounds.bottom - nextBounds.top)
    - (oldBounds.right - oldBounds.left) * (oldBounds.bottom - oldBounds.top);
  return [plan.nodeIds.length, plan.nodeIds.length * plan.distance, Math.max(0, areaIncrease), plan.key];
}

function endpointSegmentCuts(routes, minimum = 30) {
  const cuts = [];
  for (const route of routes.values()) {
    if (!route.points || route.points.length < 2) continue;
    const pairs = [[route.points[0], route.points[1]], [route.points.at(-1), route.points.at(-2)]];
    for (const [port, inner] of pairs) {
      const length = Math.abs(port.x - inner.x) + Math.abs(port.y - inner.y);
      if (length >= minimum) continue;
      const axis = port.x === inner.x ? 'y' : 'x';
      cuts.push({ axis, coordinate: (port[axis] + inner[axis]) / 2, deficit: minimum - length, overlap: 60 });
    }
  }
  const merged = new Map();
  for (const cut of cuts) {
    const key = `${cut.axis}/${Math.round(cut.coordinate / GRID)}`, current = merged.get(key);
    if (!current || cut.deficit > current.deficit) merged.set(key, cut);
  }
  return [...merged.values()];
}

function endpointExcursionCuts(graph, positions, routes, minimumGap = 48 + 30) {
  const cuts = [];
  for (const excursion of routeGraphEndpointExcursions(graph, positions, routes)) {
    const source = positions[excursion.source], target = positions[excursion.target];
    const dx = target.x + WIDTH / 2 - source.x - WIDTH / 2;
    const dy = target.y + HEIGHT / 2 - source.y - HEIGHT / 2;
    const axis = Math.abs(dx) / WIDTH >= Math.abs(dy) / HEIGHT ? 'x' : 'y';
    const size = axis === 'x' ? WIDTH : HEIGHT, distance = Math.abs(axis === 'x' ? dx : dy);
    const gap = Math.max(0, distance - size), deficit = minimumGap - gap;
    if (deficit <= 0) continue;
    const sourceCenter = source[axis] + size / 2, targetCenter = target[axis] + size / 2;
    cuts.push({ axis, coordinate: (sourceCenter + targetCenter) / 2, deficit, overlap: 60 });
  }
  return cuts;
}

function mergeGeometryCuts(cuts) {
  const merged = new Map();
  for (const cut of cuts) {
    const key = `${cut.axis}/${Math.round(cut.coordinate / GRID)}`, current = merged.get(key);
    if (!current || cut.deficit > current.deficit) merged.set(key, cut);
  }
  return [...merged.values()];
}

function repairEndpointOrthogonality(points, original) {
  if (points.length < 2) return points;
  if (points.length === 2 && points[0].x !== points[1].x && points[0].y !== points[1].y) {
    const horizontal = original[0].y === original[1].y;
    points.splice(1, 0, horizontal
      ? { x: points[1].x, y: points[0].y }
      : { x: points[0].x, y: points[1].y });
    return points;
  }
  const last = points.length - 1, originalLast = original.length - 1;
  if (original[0].x === original[1].x) points[1].x = points[0].x;
  else points[1].y = points[0].y;
  if (original[originalLast - 1].x === original[originalLast].x) points[last - 1].x = points[last].x;
  else points[last - 1].y = points[last].y;
  return points;
}

function assertOrthogonalRoutes(routes, allowShortEndpointSegments = false) {
  for (const [id, route] of routes) {
    const points = route.points ?? route;
    for (let index = 1; index < points.length; index++) {
      const before = points[index - 1], after = points[index];
      if (before.x !== after.x && before.y !== after.y) {
        throw new Error(`图几何产生了斜向连线：${id} / ${index - 1}。`);
      }
    }
    if (!allowShortEndpointSegments && !routeEndpointSegmentsValid(points)) {
      throw new Error(`图几何把连线首末接入段压缩到30px以内：${id}。`);
    }
  }
}

export function expandLayoutAtSpacingCuts(graph, positions, routes, cuts, allowShortEndpointSegments = false) {
  const result = structuredClone(positions);
  const minX = Math.min(...Object.values(result).map(value => value.x));
  const minY = Math.min(...Object.values(result).map(value => value.y));
  for (const node of graph.nodes) for (const axis of ['x', 'y']) {
    const center = positions[node.id][axis] + (axis === 'x' ? WIDTH / 2 : HEIGHT / 2);
    result[node.id][axis] = snap(positions[node.id][axis] + cutShift(center, axis, cuts));
  }
  const nextMinX = Math.min(...Object.values(result).map(value => value.x));
  const nextMinY = Math.min(...Object.values(result).map(value => value.y));
  const recenter = { x: minX - nextMinX, y: minY - nextMinY };
  for (const value of Object.values(result)) {
    value.x = snap(value.x + recenter.x); value.y = snap(value.y + recenter.y);
  }
  const shiftedRoutes = new Map([...routes].map(([id, route]) => {
    const original = route.points ?? route;
    const points = original.map(value => ({
      x: value.x + cutShift(value.x, 'x', cuts) + recenter.x,
      y: value.y + cutShift(value.y, 'y', cuts) + recenter.y,
    }));
    if (!route.points) return [id, points];
    const edge = graph.edges.find(value => value.id === id);
    const shifted = structuredClone(route);
    for (const [role, nodeId, index] of [['sourcePort', edge.source, 0], ['targetPort', edge.target, points.length - 1]]) {
      const delta = { x: result[nodeId].x - positions[nodeId].x, y: result[nodeId].y - positions[nodeId].y };
      shifted[role].port.x += delta.x; shifted[role].port.y += delta.y;
      shifted[role].anchor.x += delta.x; shifted[role].anchor.y += delta.y;
      points[index] = { ...shifted[role].port };
    }
    shifted.points = repairEndpointOrthogonality(points, original);
    return [id, shifted];
  }));
  assertOrthogonalRoutes(shiftedRoutes, allowShortEndpointSegments);
  return { positions: result, routes: shiftedRoutes };
}

export function expandPositionsAtSpacingCuts(nodes, positions, cuts) {
  return expandLayoutAtSpacingCuts({ nodes, edges: [] }, positions, new Map(), cuts).positions;
}

// route 与 layout 的唯一终态 owner。通道修复是局部几何事务：先只重算
// 冲突边，再移动由扫掠碰撞递归确定的最小节点闭包；绝不按切线平移整张图。
export function settleGraphGeometry({ graph, positions, routes = null, cola = globalThis.cola,
  allowPositionShift = true }) {
  let settledPositions = structuredClone(positions);
  let settledRoutes = routes ?? routeGraphEdges(graph, settledPositions, cola, new Map(), { allowProvisional: true });
  // 每轮只处理当前最严重见证的两个对称方向。高密度图若仍不可解，应在
  // 有界时间内返回可读诊断，而不是在工作区锁内穷举全部闭包组合。
  for (let round = 0; round < 4; round++) {
    // 一个走廊组件的分轨会改变另一轴的横向接入段。以固定上限迭代纯路线
    // 重排，使这些相邻组件收敛；整个阶段不触碰 positions。
    let laneRoutes = settledRoutes, laneKey = routeGeometrySnapshot(laneRoutes);
    for (let laneRound = 0; laneRound < 6; laneRound++) {
      const next = improveRouteGeometry(graph, settledPositions, laneRoutes, { rounds: 1, allowShortEndpointSegments: true });
      const nextKey = routeGeometrySnapshot(next);
      laneRoutes = next;
      if (nextKey === laneKey) break;
      laneKey = nextKey;
    }
    const audit = auditGraphGeometryStrict(graph, settledPositions, laneRoutes);
    if (audit.ok) { assertOrthogonalRoutes(laneRoutes); return { positions: settledPositions, routes: laneRoutes }; }
    settledRoutes = laneRoutes;
    // 只有共线重叠才会进入节点闭包修复。近距平行线是路由器应尽量改善的
    // 软可读性指标，不得成为推动布局的理由。
    const witnesses = audit.overlaps;
    // 节点穿越、端点接入问题交给固定坐标全图重新算线；这不改变任何节点坐标，
    // 也避免将非通道问题伪装成“扩大布局”。
    if (!witnesses.length) {
      const rerouted = routeGraphEdges(graph, settledPositions, cola, new Map(), { allowProvisional: true });
      const reroutedAudit = auditGraphGeometryStrict(graph, settledPositions, rerouted);
      if (reroutedAudit.ok) return { positions: settledPositions, routes: rerouted };
      throw new Error(`固定坐标下无法获得严格可行的正交路径：${reroutedAudit.reasons.join('、')}。`);
    }
    const witness = witnesses[0];
    // 第一阶段只重算冲突端口及其同端点边，成功时节点位置完全不动。
    try {
      const locallyRerouted = rerouteWitnessEdges(graph, settledPositions, settledRoutes, witness, cola);
      if (locallyRerouted) {
        const localAudit = auditGraphGeometryStrict(graph, settledPositions, locallyRerouted);
        if (localAudit.ok) return { positions: settledPositions, routes: locallyRerouted };
      }
    } catch {
      // 局部候选不可行时继续评估明确的最小闭包，不把失败变成静默全图移动。
    }
    // 对真正同线的内部段先做本地车道让行。它不移动任何节点，且候选只涉及
    // 见证的两条边；若足以消除硬冲突，就不需要进入节点闭包。
    const baseline = auditGraphGeometryStrict(graph, settledPositions, settledRoutes);
    const routeCandidates = nudgeWitnessSegments(settledRoutes, witness)
      .map(routes => ({ positions: settledPositions, routes,
        audit: auditGraphGeometryStrict(graph, settledPositions, routes), plan: null,
        cost: [0, 0, 0, 'local-lane'] }))
      .filter(candidate => candidate.audit.score[0] === 0 && !candidate.audit.shortEndpoints.length)
      .filter(candidate => compareTuple(
        [candidate.audit.score[0], candidate.audit.score[1], candidate.audit.overlaps.length,
          candidate.audit.overlaps.reduce((sum, item) => sum + item.deficit * item.overlap, 0)],
        [baseline.score[0], baseline.score[1], baseline.overlaps.length,
          baseline.overlaps.reduce((sum, item) => sum + item.deficit * item.overlap, 0)]) < 0);
    const resolvedByLane = routeCandidates.find(candidate => candidate.audit.ok);
    if (resolvedByLane) return { positions: settledPositions, routes: resolvedByLane.routes };
    if (!allowPositionShift) throw new Error('固定节点限制下无法同时满足双轴 48px 通道间距，请扩大选择范围。');
    const candidates = [...routeCandidates];
    // 单端点的四个对称方向已覆盖这对冲突边；只在它们都无法改善时再扩大
    // 闭包，避免高密度图在一次自动整理中反复完整重算。
    for (const plan of candidatePlans(graph, settledPositions, witness).slice(0, 4)) {
      try {
        const candidatePositions = moveClosure(settledPositions, plan.nodeIds, plan.delta);
        const rerouted = rerouteMovedNodes(graph, candidatePositions, settledRoutes, plan.nodeIds, cola, true).routes;
        const candidateAudit = auditGraphGeometryStrict(graph, candidatePositions, rerouted);
        // 每一轮都必须实际降低严格错误，避免在局部最优中来回抖动。
        const beforeSeverity = [baseline.score[0], baseline.score[1], baseline.overlaps.length,
          baseline.overlaps.reduce((sum, item) => sum + item.deficit * item.overlap, 0)];
        const nextSeverity = [candidateAudit.score[0], candidateAudit.score[1], candidateAudit.overlaps.length,
          candidateAudit.overlaps.reduce((sum, item) => sum + item.deficit * item.overlap, 0)];
        if (compareTuple(nextSeverity, beforeSeverity) >= 0) continue;
        candidates.push({ positions: candidatePositions, routes: rerouted, audit: candidateAudit, plan,
          cost: candidateCost(settledPositions, candidatePositions, plan) });
      } catch {
        // 一个方向不可行不影响另一侧候选；所有候选失败才显式报错。
      }
    }
    if (!candidates.length) {
      throw new Error(`图几何无法以最小受影响范围修复密集通道：${JSON.stringify(witness)}；冲突：${JSON.stringify(routeGraphSpacingConflicts(settledRoutes))}。`);
    }
    candidates.sort((left, right) => compareTuple(
      [left.audit.score[0], left.audit.score[1], left.audit.overlaps.length,
        left.audit.overlaps.reduce((sum, item) => sum + item.deficit * item.overlap, 0), ...left.cost],
      [right.audit.score[0], right.audit.score[1], right.audit.overlaps.length,
        right.audit.overlaps.reduce((sum, item) => sum + item.deficit * item.overlap, 0), ...right.cost]));
    settledPositions = candidates[0].positions;
    settledRoutes = candidates[0].routes;
  }
  const audit = auditGraphGeometryStrict(graph, settledPositions, settledRoutes);
  if (!audit.ok) throw new Error(`图几何在局部修复后仍不满足严格审计：${audit.reasons.join('、')}；冲突：${JSON.stringify(audit.spacing)}。`);
  return { positions: settledPositions, routes: settledRoutes };
}
