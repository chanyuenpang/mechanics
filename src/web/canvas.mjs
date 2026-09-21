import { graphGeometryKey } from './route-cache.mjs';
import { SNAP_GRID } from './layout-structure.mjs';
import { affectedRouteIds } from './local-routing.mjs';
import { edgeHoverDetail, nodeHoverDetail } from '../domain/hover-details.mjs';

export { graphGeometryKey } from './route-cache.mjs';

const svg = (tag, attributes = {}) => {
  const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value);
  return item;
};
// 摘要只有在全部来源规则均已填写时才显示关系色；不改变关系或极性。
export function hasRuleText(edge) {
  if (edge.relation === 'specializes') return true;
  const rules = edge.steps?.length ? edge.steps : [edge];
  return rules.every(rule => rule.relation === 'specializes' || Boolean(rule.ruleText?.trim()));
}

export function badgeInteractionTargetId(badge, visibleNodeIds) {
  return badge.targetId && visibleNodeIds.has(badge.targetId) ? badge.targetId : null;
}

const badgeAccessibilityText = badge => badge.targetId ? `${badge.text}（概念 ID：${badge.targetId}）` : badge.text;

export function badgeDisplayModel(badges, mode = 'line') {
  const withAccessibility = badge => ({ ...badge, accessibleText: badgeAccessibilityText(badge), displayText: badge.text });
  const fullText = badges.map(badgeAccessibilityText).join('；');
  if (mode !== 'badge') return { badges: badges.slice(0, 2).map(withAccessibility), fullText };
  const isA = badges.find(badge => badge.kind === 'is-a');
  if (!isA) return { badges: badges.slice(0, 2).map(withAccessibility), fullText };
  const remaining = badges.filter(badge => badge !== isA);
  const isABadge = { ...isA, accessibleText: badgeAccessibilityText(isA), displayText: 'is-a' };
  const summary = remaining.length ? { text: '其余：' + remaining.map(badge => badge.text).join('；'), kind: 'summary', sourceId: isA.sourceId } : null;
  return { badges: [isABadge, ...(summary ? [withAccessibility(summary)] : [])], fullText };
}

export function structuralProjection(graph, mode = 'line') {
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const name = id => nodesById.get(id)?.label ?? id;
  const badgesFor = node => {
    const badges = [];
    // 端点限定投影不是限定概念；它只在节点内展示规则声明的参与者范围。
    if (node.baseConceptId && !node.scopeProjection) badges.push({ text: '基础：' + name(node.baseConceptId), kind: 'base', sourceId: node.id, targetId: node.baseConceptId });
    for (const qualifier of node.qualifiers ?? []) {
      const concept = qualifier.value.kind === 'concept';
      const targetId = concept ? qualifier.value.conceptId : undefined;
      const value = concept ? name(targetId) : String(qualifier.value.value);
      badges.push({ text: qualifier.key + '：' + value, kind: 'qualifier', sourceId: node.id, ...(targetId ? { targetId } : {}) });
    }
    if (mode === 'badge') for (const edge of graph.edges) {
      if (edge.relation === 'specializes' && edge.source === node.id) {
        badges.push({ text: 'is-a：' + name(edge.target), kind: 'is-a', sourceId: edge.source, targetId: edge.target });
      }
    }
    return badges;
  };
  return {
    nodes: graph.nodes.map(node => ({ ...node, badges: badgesFor(node) })),
    edges: mode === 'badge' ? graph.edges.filter(edge => edge.relation !== 'specializes') : [...graph.edges],
  };
}
const WIDTH = 166, HEIGHT = 62;
const ROUTE_PADDING = 24;
const ROUTE_NUDGE = 8;
const ROUTE_READABLE_GAP = 48;
const ROUTE_DETOUR_BAND = ROUTE_READABLE_GAP * 4;
const ROUTE_CORNER = 12;
const ENDPOINT_SEGMENT_MIN = 30;
const PORT_MARGIN = 12;
const PORT_GAP = 12;
const PORT_ANCHOR_DISTANCE = ROUTE_PADDING + 12;
const PORT_ESCAPE_GAP = ROUTE_NUDGE;
const PORTS_PER_SIDE = 7;
const PORTS_PER_NODE = PORTS_PER_SIDE * 4;
const SIDES = ['right', 'bottom', 'left', 'top'];
const SIDE_VECTOR = {
  right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, top: { x: 0, y: -1 },
};
export const ROUTING_QUALITY = Object.freeze({
  hardInvalid: 0,
  collinearOverlap: 1,
  endpointExcursions: 2,
  crossings: 3,
  detour: 4,
  totalBends: 5,
  maxBends: 6,
  bendCrowding: 7,
  nearParallel: 8,
  length: 9,
});
const ROUTING_SEARCH = Object.freeze({
  normal: Object.freeze({ candidateLimit: 36, rounds: 3, pairRounds: 1, endpointRounds: 1,
    simplicityRounds: 3, swapRounds: 1, beamWidth: 24, conflictPairBudget: Infinity,
    endpointEdgeBudget: Infinity, swapPairBudget: Infinity }),
  // 百边以上的高密度图先产出一条可审计候选，不在一次事务里进行无界组合
  // 搜索；剩余硬冲突再由局部闭包修复。预算以实际边数上限而非“尽量多”为准。
  large: Object.freeze({ candidateLimit: 12, rounds: 3, pairRounds: 1, endpointRounds: 1,
    simplicityRounds: 1, swapRounds: 1, beamWidth: 8, conflictPairBudget: 80,
    endpointEdgeBudget: 40, swapPairBudget: 40 }),
  // 高扇出中心会把每轮端口、冲突分量搜索放大为近似全局组合；首轮已经产生
  // 完整可审计路线，后续只由固定的局部收尾算子处理。
  highDegree: Object.freeze({ candidateLimit: 12, rounds: 1, pairRounds: 1, endpointRounds: 1,
    simplicityRounds: 1, swapRounds: 1, beamWidth: 8, conflictPairBudget: 80,
    endpointEdgeBudget: 40, swapPairBudget: 40 }),
});

const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rounded = value => Math.round(value * 100) / 100;

// 路由选择只应由相对几何决定。将求解坐标移到局部原点，避免网格取整与
// 候选通道在整张画布的绝对偏移下得到不同结果；输出仍完整还原到原坐标系。
function normalizedRoutingPositions(graph, positions) {
  const minX = Math.min(...graph.nodes.map(node => positions[node.id].x));
  const minY = Math.min(...graph.nodes.map(node => positions[node.id].y));
  const offset = { x: minX, y: minY };
  if (!offset.x && !offset.y) return { positions, offset };
  return {
    positions: Object.fromEntries(graph.nodes.map(node => [node.id, {
      x: positions[node.id].x - offset.x, y: positions[node.id].y - offset.y,
    }])),
    offset,
  };
}

function restoreRoutingOffset(routes, offset) {
  if (!offset.x && !offset.y) return routes;
  const shiftPoint = point => ({ x: point.x + offset.x, y: point.y + offset.y });
  const shiftEndpoint = endpoint => ({ ...endpoint, port: shiftPoint(endpoint.port), anchor: shiftPoint(endpoint.anchor) });
  return new Map([...routes].map(([id, route]) => {
    const points = route.points.map(shiftPoint);
    return [id, { ...route, points, path: roundedPath(points), sourcePort: shiftEndpoint(route.sourcePort),
      targetPort: shiftEndpoint(route.targetPort), ...routeLabel(points) }];
  }));
}

function normalizeRoute(points) {
  const result = [];
  for (const point of points) {
    if (!finitePoint(point)) throw new Error('WebCola 返回了无效的连线路径坐标。');
    const next = { x: rounded(point.x), y: rounded(point.y) };
    const previous = result.at(-1);
    if (previous && previous.x === next.x && previous.y === next.y) continue;
    result.push(next);
    while (result.length >= 3) {
      const [a, b, c] = result.slice(-3);
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) result.splice(-2, 1);
      else break;
    }
  }
  if (result.length < 2) throw new Error('WebCola 没有返回完整的连线路径。');
  return result;
}

function endpointPoint(position, side, offset) {
  if (side === 'right') return { x: position.x + WIDTH, y: position.y + offset };
  if (side === 'left') return { x: position.x, y: position.y + offset };
  if (side === 'bottom') return { x: position.x + offset, y: position.y + HEIGHT };
  return { x: position.x + offset, y: position.y };
}

export function distributedOffsets(members, side, positions) {
  const length = side === 'top' || side === 'bottom' ? WIDTH : HEIGHT;
  const min = PORT_MARGIN, max = length - PORT_MARGIN;
  if (!members.length) return [];
  if (members.length > 7) return members.map((_, index) => min + (max - min) * index / (members.length - 1));
  const at = ratio => clamp(length * ratio, min, max);
  // 固定启用顺序让既有端口保持稳定：先中点与四分位，再填中央间隔，最后填两侧间隔。
  const slots = [.5, .75, .25, .625, .375, .875, .125].slice(0, members.length).map(at);
  const desired = members.map(member => {
    const own = positions[member.role === 'source' ? member.edge.source : member.edge.target];
    const other = positions[member.otherId];
    return clamp(side === 'left' || side === 'right'
      ? other.y + HEIGHT / 2 - own.y
      : other.x + WIDTH / 2 - own.x, min, max);
  });
  const result = Array(members.length), available = new Set(members.map((_, index) => index));
  for (const slot of slots) {
    const index = [...available].sort((a, b) => Math.abs(desired[a] - slot) - Math.abs(desired[b] - slot) || a - b)[0];
    result[index] = slot; available.delete(index);
  }
  return result;
}

function compareTuple(a, b) {
  for (let index = 0; index < a.length; index++) if (Math.abs(a[index] - b[index]) > .0001) return a[index] - b[index];
  return 0;
}

// 后处理逐项保护既有几何结果：减少重叠不能抵消新增交叉，也不能为消交叉制造折返绕路。
// 其余改善仍复用完整质量向量，避免各算子形成互相矛盾的偏好。
function routeQualityPreserved(before, after) {
  return [ROUTING_QUALITY.hardInvalid, ROUTING_QUALITY.collinearOverlap,
    ROUTING_QUALITY.endpointExcursions, ROUTING_QUALITY.crossings, ROUTING_QUALITY.detour]
    .every(index => after[index] <= before[index] + .0001);
}

function replaceRoutePoints(route, points) {
  return route.points ? { ...route, points, path: roundedPath(points), ...routeLabel(points) } : points;
}

function anchorPoint(port, side, lane = 0) {
  const vector = SIDE_VECTOR[side];
  const distance = PORT_ANCHOR_DISTANCE + lane * PORT_ESCAPE_GAP;
  return { x: port.x + vector.x * distance, y: port.y + vector.y * distance };
}

function endpointConnector(assignment, routedPort, source) {
  const { port, anchor, side } = assignment;
  const elbow = side === 'left' || side === 'right'
    ? { x: routedPort.x, y: anchor.y }
    : { x: anchor.x, y: routedPort.y };
  return source ? [port, anchor, elbow, routedPort] : [routedPort, elbow, anchor, port];
}

// 端口面和槽位完成全局优化后，再把不足以呈现30px可读拐点的正对端口视为松弛候选。
// 候选仍由完整质量向量裁决；负载只用于同质量候选的最小扰动排序。
function optimizeNearFacingPorts(graph, positions, edges, assignments, axes, state, candidates) {
  const loads = endpointLoads(assignments);
  const endpoints = [...assignments.values()].flatMap(assignment => assignmentEndpoints(assignment));
  const coordinate = (endpoint, axis) => endpoint.port[axis];
  const canMove = (endpoint, axis, value) => {
    const point = positions[endpoint.nodeId], length = axis === 'x' ? WIDTH : HEIGHT;
    const offset = value - point[axis];
    if (offset < PORT_MARGIN - .01 || offset > length - PORT_MARGIN + .01) return false;
    return endpoints.every(item => item === endpoint || item.nodeId !== endpoint.nodeId
      || item.side !== endpoint.side || Math.abs(coordinate(item, axis) - value) >= PORT_GAP - .01);
  };
  const move = (endpoint, axis, value) => { endpoint.port[axis] = value; endpoint.anchor[axis] = value; };
  for (const edge of edges) {
    const assignment = assignments.get(edge.id); if (!assignment?.source || !assignment?.target) continue;
    const source = assignment.source, target = assignment.target;
    const vertical = (source.side === 'bottom' && target.side === 'top')
      || (source.side === 'top' && target.side === 'bottom');
    const horizontal = (source.side === 'right' && target.side === 'left')
      || (source.side === 'left' && target.side === 'right');
    if (!vertical && !horizontal) continue;
    const axis = vertical ? 'x' : 'y', sourceValue = coordinate(source, axis), targetValue = coordinate(target, axis);
    const delta = Math.abs(sourceValue - targetValue);
    if (delta < .01 || delta >= ENDPOINT_SEGMENT_MIN) continue;
    const sourceLoad = loads.get(source.nodeId)?.[source.side] ?? 1;
    const targetLoad = loads.get(target.nodeId)?.[target.side] ?? 1;
    const middle = (sourceValue + targetValue) / 2;
    const alignmentCandidates = [
      { source: targetValue, target: targetValue, moves: 1, cost: delta * sourceLoad },
      { source: sourceValue, target: sourceValue, moves: 1, cost: delta * targetLoad },
      { source: middle, target: middle, moves: 2, cost: delta / 2 * (sourceLoad + targetLoad) },
    ].filter(candidate => canMove(source, axis, candidate.source) && canMove(target, axis, candidate.target));
    let best = null;
    for (const candidate of alignmentCandidates) {
      move(source, axis, candidate.source); move(target, axis, candidate.target);
      const routes = candidateRoutes(graph, positions, edge, assignment, axes);
      for (const route of routes) {
        const score = routeScoreAfterChanges(graph, positions, edges, state.routes, state.score,
          new Map([[edge.id, route]]));
        const rank = [...score, candidate.cost, candidate.moves, candidate.source];
        if (!best || compareTuple(rank, best.rank) < 0) best = { candidate, route, routes, score, rank };
      }
      move(source, axis, sourceValue); move(target, axis, targetValue);
    }
    const hardMetrics = [ROUTING_QUALITY.hardInvalid, ROUTING_QUALITY.collinearOverlap,
      ROUTING_QUALITY.endpointExcursions, ROUTING_QUALITY.crossings];
    if (!best || hardMetrics.some(index => best.score[index] > state.score[index] + .0001)
      || compareTuple(best.score, state.score) >= 0) continue;
    move(source, axis, best.candidate.source); move(target, axis, best.candidate.target);
    state.routes.set(edge.id, best.route); state.score = best.score;
    candidates.set(edge.id, best.routes);
  }
  return state;
}

// 一个节点的全部入边和出边共同竞争四侧端口；先使用负载更低的可行侧，再比较拐点和方向。
export function assignEdgePorts(graph, positions, fixedRoutes = new Map()) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target);
  const fixedAssignments = new Map([...fixedRoutes].map(([edgeId, route]) => [`\u0000fixed:${edgeId}`, {
    source: route.sourcePort && { ...route.sourcePort, port: { ...route.sourcePort.port }, anchor: { ...route.sourcePort.anchor } },
    target: route.targetPort && { ...route.targetPort, port: { ...route.targetPort.port }, anchor: { ...route.targetPort.anchor } },
  }]));
  const incidents = new Map(graph.nodes.map(node => [node.id, []]));
  const incidentByEdge = new Map(edges.map(edge => [edge.id, {}]));
  for (const edge of edges) {
    for (const [role, nodeId, otherId] of [['source', edge.source, edge.target], ['target', edge.target, edge.source]]) {
      const position = positions[nodeId], other = positions[otherId];
      if (!finitePoint(position) || !finitePoint(other)) throw new Error('节点缺少有效坐标：' + (!finitePoint(position) ? nodeId : otherId));
      const dx = other.x - position.x, dy = other.y - position.y, distance = Math.hypot(dx, dy) || 1;
      const unitX = dx / distance, unitY = dy / distance;
      const preferredSides = [];
      if (unitX > .2) preferredSides.push('right'); else if (unitX < -.2) preferredSides.push('left');
      if (unitY > .2) preferredSides.push('bottom'); else if (unitY < -.2) preferredSides.push('top');
      const incident = { edge, role, otherId, dx: unitX, dy: unitY, preferredSides,
        confidence: Math.abs(Math.abs(dx) - Math.abs(dy)) / distance };
      incidents.get(nodeId).push(incident); incidentByEdge.get(edge.id)[role] = incident;
    }
  }
  const fixedEndpoints = [...fixedAssignments.values()].flatMap(assignment => [assignment.source, assignment.target]).filter(Boolean);
  for (const [nodeId, list] of incidents) {
    const required = list.length + fixedEndpoints.filter(endpoint => endpoint.nodeId === nodeId).length;
    if (required > PORTS_PER_NODE) throw new Error(`节点端口容量不足：${nodeId} 需要 ${required} 个端口，四面最多 ${PORTS_PER_NODE} 个。`);
  }
  const assignments = new Map([...fixedAssignments, ...edges.map(edge => [edge.id, {}])]);
  const loads = new Map(graph.nodes.map(node => [node.id, Object.fromEntries(SIDES.map(side => [side, 0]))]));
  for (const endpoint of fixedEndpoints) loads.get(endpoint.nodeId)[endpoint.side]++;
  const alignment = (incident, side) => incident.dx * SIDE_VECTOR[side].x + incident.dy * SIDE_VECTOR[side].y;
  const expectedBends = (edge, sourceSide, targetSide) => {
    const source = positions[edge.source], target = positions[edge.target];
    const horizontal = Math.abs(source.y - target.y) < ENDPOINT_SEGMENT_MIN
      && ((sourceSide === 'right' && targetSide === 'left' && source.x < target.x)
        || (sourceSide === 'left' && targetSide === 'right' && source.x > target.x));
    const vertical = Math.abs(source.x - target.x) < ENDPOINT_SEGMENT_MIN
      && ((sourceSide === 'bottom' && targetSide === 'top' && source.y < target.y)
        || (sourceSide === 'top' && targetSide === 'bottom' && source.y > target.y));
    if (horizontal || vertical) return 0;
    const sourceVector = SIDE_VECTOR[sourceSide], targetVector = SIDE_VECTOR[targetSide];
    return sourceVector.x * targetVector.x + sourceVector.y * targetVector.y === 0 ? 1 : 2;
  };
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const sourceIncident = incidentByEdge.get(edge.id).source, targetIncident = incidentByEdge.get(edge.id).target;
    const sourceSides = SIDES.filter(side => alignment(sourceIncident, side) >= -.0001
      && loads.get(edge.source)[side] < PORTS_PER_SIDE);
    const targetSides = SIDES.filter(side => alignment(targetIncident, side) >= -.0001
      && loads.get(edge.target)[side] < PORTS_PER_SIDE);
    const candidates = [];
    for (const sourceSide of sourceSides) for (const targetSide of targetSides) {
      const sourceLoad = loads.get(edge.source)[sourceSide], targetLoad = loads.get(edge.target)[targetSide];
      const preferred = Number(!sourceIncident.preferredSides.includes(sourceSide)) + Number(!targetIncident.preferredSides.includes(targetSide));
      const directionLoss = 2 - alignment(sourceIncident, sourceSide) - alignment(targetIncident, targetSide);
      candidates.push({ sourceSide, targetSide, score: [
        expectedBends(edge, sourceSide, targetSide), preferred, sourceLoad + targetLoad, directionLoss,
        SIDES.indexOf(sourceSide), SIDES.indexOf(targetSide),
      ] });
    }
    candidates.sort((a, b) => compareTuple(a.score, b.score));
    const choice = candidates[0];
    if (!choice) throw new Error(`节点端口容量不足：无法为连线 ${edge.id} 分配端口。`);
    assignments.get(edge.id).source = { side: choice.sourceSide, nodeId: edge.source, otherId: edge.target };
    assignments.get(edge.id).target = { side: choice.targetSide, nodeId: edge.target, otherId: edge.source };
    loads.get(edge.source)[choice.sourceSide]++; loads.get(edge.target)[choice.targetSide]++;
  }
  // 面确定后、端口坐标生成前先做局部均衡；后续换面也必须保持同一相对拥挤合同。
  for (const node of graph.nodes) {
    const nodeLoads = loads.get(node.id), list = incidents.get(node.id);
    for (let step = 0; step < list.length * SIDES.length; step++) {
      const moves = list.flatMap(incident => {
        const endpoint = assignments.get(incident.edge.id)[incident.role];
        const sideIndex = SIDES.indexOf(endpoint.side);
        const adjacent = [SIDES[(sideIndex + 1) % SIDES.length], SIDES[(sideIndex + SIDES.length - 1) % SIDES.length]];
        const current = assignments.get(incident.edge.id);
        const currentBends = expectedBends(incident.edge, current.source.side, current.target.side);
        const viable = adjacent.filter(side => alignment(incident, side) >= -.0001 && nodeLoads[side] < PORTS_PER_SIDE
          && nodeLoads[endpoint.side] - nodeLoads[side] > 2);
        return viable
          .map(side => {
            const sourceSide = incident.role === 'source' ? side : current.source.side;
            const targetSide = incident.role === 'target' ? side : current.target.side;
            return { incident, endpoint, side,
            gain: nodeLoads[endpoint.side] - nodeLoads[side],
            bendDelta: expectedBends(incident.edge, sourceSide, targetSide) - currentBends,
            directionLoss: alignment(incident, endpoint.side) - alignment(incident, side) };
          });
      }).sort((a, b) => b.gain - a.gain || a.bendDelta - b.bendDelta || a.directionLoss - b.directionLoss
        || a.incident.edge.id.localeCompare(b.incident.edge.id) || a.incident.role.localeCompare(b.incident.role)
        || SIDES.indexOf(a.side) - SIDES.indexOf(b.side));
      if (!moves.length) break;
      const move = moves[0];
      nodeLoads[move.endpoint.side]--; nodeLoads[move.side]++;
      move.endpoint.side = move.side;
    }
  }
  for (const node of graph.nodes) {
    const list = incidents.get(node.id).sort((a, b) => b.confidence - a.confidence
      || a.edge.id.localeCompare(b.edge.id) || a.role.localeCompare(b.role));
    for (const side of SIDES) {
      const members = list.filter(incident => assignments.get(incident.edge.id)[incident.role].side === side)
        .sort((a, b) => {
          const aPoint = positions[a.otherId], bPoint = positions[b.otherId];
          const projection = side === 'left' || side === 'right' ? aPoint.y - bPoint.y : aPoint.x - bPoint.x;
          return projection || a.edge.id.localeCompare(b.edge.id) || a.role.localeCompare(b.role);
        });
      const fixed = fixedEndpoints.filter(endpoint => endpoint.nodeId === node.id && endpoint.side === side);
      const length = side === 'left' || side === 'right' ? HEIGHT : WIDTH;
      const enabledOffsets = [.5, .75, .25, .625, .375, .875, .125].slice(0, fixed.length + members.length)
        .map(ratio => clamp(length * ratio, PORT_MARGIN, length - PORT_MARGIN));
      const usedOffsets = new Set(fixed.map(endpoint => rounded(side === 'left' || side === 'right'
        ? endpoint.port.y - positions[node.id].y : endpoint.port.x - positions[node.id].x)));
      const availableOffsets = enabledOffsets.filter(offset => !usedOffsets.has(rounded(offset)));
      const desired = members.map(member => {
        const other = positions[member.otherId];
        return clamp(side === 'left' || side === 'right' ? other.y + HEIGHT / 2 - positions[node.id].y
          : other.x + WIDTH / 2 - positions[node.id].x, PORT_MARGIN, length - PORT_MARGIN);
      });
      const offsets = Array(members.length), availableMembers = new Set(members.map((_, index) => index));
      for (const offset of availableOffsets) {
        const index = [...availableMembers].sort((a, b) => Math.abs(desired[a] - offset) - Math.abs(desired[b] - offset) || a - b)[0];
        if (index === undefined) break;
        offsets[index] = offset; availableMembers.delete(index);
      }
      const usedLanes = new Set(fixed.map(endpoint => endpoint.slot));
      const lanes = Array.from({ length: fixed.length + members.length }, (_, index) => index).filter(index => !usedLanes.has(index));
      members.forEach((incident, index) => {
        const assignment = assignments.get(incident.edge.id)[incident.role];
        assignment.port = endpointPoint(positions[node.id], side, offsets[index]);
        assignment.anchor = anchorPoint(assignment.port, side, lanes[index]);
        assignment.slot = lanes[index];
      });
    }
  }
  return assignments;
}

function roundedPath(points) {
  const number = value => String(rounded(value));
  let path = `M${number(points[0].x)},${number(points[0].y)}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1], corner = points[index], next = points[index + 1];
    const incoming = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(ROUTE_CORNER, incoming / 2, outgoing / 2);
    const before = { x: corner.x - (corner.x - previous.x) / incoming * radius, y: corner.y - (corner.y - previous.y) / incoming * radius };
    const after = { x: corner.x + (next.x - corner.x) / outgoing * radius, y: corner.y + (next.y - corner.y) / outgoing * radius };
    path += ` L${number(before.x)},${number(before.y)} Q${number(corner.x)},${number(corner.y)} ${number(after.x)},${number(after.y)}`;
  }
  const end = points.at(-1);
  return path + ` L${number(end.x)},${number(end.y)}`;
}

function routeLabel(points) {
  let best = null;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || length > best.length) best = { a, b, length };
  }
  const vertical = best.a.x === best.b.x;
  return { labelX: (best.a.x + best.b.x) / 2 + (vertical ? 10 : 0), labelY: (best.a.y + best.b.y) / 2 - (vertical ? 0 : 7) };
}

function routeCrossesNode(points, position, padding = 0) {
  const left = position.x - padding, right = position.x + WIDTH + padding;
  const top = position.y - padding, bottom = position.y + HEIGHT + padding;
  return points.slice(1).some((point, index) => {
    const previous = points[index];
    if (previous.x === point.x) return point.x > left && point.x < right
      && Math.max(Math.min(previous.y, point.y), top) < Math.min(Math.max(previous.y, point.y), bottom);
    return previous.y === point.y && point.y > top && point.y < bottom
      && Math.max(Math.min(previous.x, point.x), left) < Math.min(Math.max(previous.x, point.x), right);
  });
}

function directPortRoute(graph, positions, edge, assignment) {
  const source = assignment.source, target = assignment.target;
  const horizontal = Math.abs(source.port.y - target.port.y) < .01
    && ((source.side === 'right' && target.side === 'left' && source.port.x < target.port.x)
      || (source.side === 'left' && target.side === 'right' && source.port.x > target.port.x));
  const vertical = Math.abs(source.port.x - target.port.x) < .01
    && ((source.side === 'bottom' && target.side === 'top' && source.port.y < target.port.y)
      || (source.side === 'top' && target.side === 'bottom' && source.port.y > target.port.y));
  if (!horizontal && !vertical) return null;
  const a = source.port, b = target.port;
  const blocked = graph.nodes.some(node => {
    if (node.id === edge.source || node.id === edge.target) return false;
    const point = positions[node.id];
    const left = point.x - ROUTE_PADDING, right = point.x + WIDTH + ROUTE_PADDING;
    const top = point.y - ROUTE_PADDING, bottom = point.y + HEIGHT + ROUTE_PADDING;
    if (horizontal) return a.y > top && a.y < bottom
      && Math.max(Math.min(a.x, b.x), left) < Math.min(Math.max(a.x, b.x), right);
    return a.x > left && a.x < right
      && Math.max(Math.min(a.y, b.y), top) < Math.min(Math.max(a.y, b.y), bottom);
  });
  return blocked ? null : normalizeRoute([a, b]);
}

const samePoint = (a, b) => Math.abs(a.x - b.x) < .01 && Math.abs(a.y - b.y) < .01;

const routeGeometryCache = new WeakMap();

function cachedRouteGeometry(points) {
  let value = routeGeometryCache.get(points);
  if (value) return value;
  const segments = points.slice(1).map((point, index) => ({ a: points[index], b: point,
    vertical: Math.abs(points[index].x - point.x) < .01 }));
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  value = { segments, bends: points.slice(1, -1), bounds: { left: Math.min(...xs), right: Math.max(...xs),
    top: Math.min(...ys), bottom: Math.max(...ys) } };
  routeGeometryCache.set(points, value);
  return value;
}

function routeSegments(points) {
  return cachedRouteGeometry(points).segments;
}

function endpointSide(position, point) {
  const distances = [
    ['left', Math.abs(point.x - position.x)],
    ['right', Math.abs(point.x - position.x - WIDTH)],
    ['top', Math.abs(point.y - position.y)],
    ['bottom', Math.abs(point.y - position.y - HEIGHT)],
  ];
  return distances.sort((a, b) => a[1] - b[1] || SIDES.indexOf(a[0]) - SIDES.indexOf(b[0]))[0][0];
}

// 端口离开一面后又沿相邻面越过端点节点，会形成“回”字形包围。
// 这不是普通绕障：正确做法是改用那一侧端口，而不是保留错误端口再绕过节点拐角。
function routeWrapsEndpoint(points, position, source) {
  const port = source ? points[0] : points.at(-1), side = endpointSide(position, port);
  const left = position.x - ROUTE_PADDING, right = position.x + WIDTH + ROUTE_PADDING;
  const top = position.y - ROUTE_PADDING, bottom = position.y + HEIGHT + ROUTE_PADDING;
  return routeSegments(points).some(segment => {
    const minX = Math.min(segment.a.x, segment.b.x), maxX = Math.max(segment.a.x, segment.b.x);
    const minY = Math.min(segment.a.y, segment.b.y), maxY = Math.max(segment.a.y, segment.b.y);
    if (side === 'top' || side === 'bottom') {
      return segment.vertical && (segment.a.x <= left + .01 || segment.a.x >= right - .01)
        && minY < position.y + HEIGHT && maxY > position.y;
    }
    return !segment.vertical && (segment.a.y <= top + .01 || segment.a.y >= bottom - .01)
      && minX < position.x + WIDTH && maxX > position.x;
  });
}

function endpointWrapCount(edge, positions, points) {
  if (!points?.length || !finitePoint(positions[edge.source]) || !finitePoint(positions[edge.target])) return 0;
  return Number(routeWrapsEndpoint(points, positions[edge.source], true))
    + Number(routeWrapsEndpoint(points, positions[edge.target], false));
}

function endpointNodeAt(edge, points, point) {
  if (samePoint(points[0], point)) return edge.source;
  if (samePoint(points.at(-1), point)) return edge.target;
  return null;
}

function pairConflict(edgeA, pointsA, edgeB, pointsB) {
  const boundsA = cachedRouteGeometry(pointsA).bounds, boundsB = cachedRouteGeometry(pointsB).bounds;
  if (boundsA.right < boundsB.left - ROUTE_READABLE_GAP || boundsB.right < boundsA.left - ROUTE_READABLE_GAP
    || boundsA.bottom < boundsB.top - ROUTE_READABLE_GAP || boundsB.bottom < boundsA.top - ROUTE_READABLE_GAP) return [0, 0, 0];
  let crossings = 0, shared = 0, near = 0;
  for (const a of routeSegments(pointsA)) for (const b of routeSegments(pointsB)) {
    if (a.vertical === b.vertical) {
      const axisGap = a.vertical ? Math.abs(a.a.x - b.a.x) : Math.abs(a.a.y - b.a.y);
      const a1 = a.vertical ? a.a.y : a.a.x, a2 = a.vertical ? a.b.y : a.b.x;
      const b1 = b.vertical ? b.a.y : b.a.x, b2 = b.vertical ? b.b.y : b.b.x;
      const overlap = Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
      if (overlap > .01) {
        if (axisGap < .01) shared += overlap;
        else if (axisGap < ROUTE_READABLE_GAP) near += overlap * (ROUTE_READABLE_GAP - axisGap) / ROUTE_READABLE_GAP;
      } else if (Math.abs(overlap) < .01 && axisGap < .01) {
        const coordinate = Math.max(Math.min(a1, a2), Math.min(b1, b2));
        const point = a.vertical ? { x: a.a.x, y: coordinate } : { x: coordinate, y: a.a.y };
        const nodeA = endpointNodeAt(edgeA, pointsA, point), nodeB = endpointNodeAt(edgeB, pointsB, point);
        if (!nodeA || nodeA !== nodeB) crossings++;
      }
      continue;
    }
    const vertical = a.vertical ? a : b, horizontal = a.vertical ? b : a;
    const point = { x: vertical.a.x, y: horizontal.a.y };
    const onVertical = point.y >= Math.min(vertical.a.y, vertical.b.y) - .01
      && point.y <= Math.max(vertical.a.y, vertical.b.y) + .01;
    const onHorizontal = point.x >= Math.min(horizontal.a.x, horizontal.b.x) - .01
      && point.x <= Math.max(horizontal.a.x, horizontal.b.x) + .01;
    if (!onVertical || !onHorizontal) continue;
    const nodeA = endpointNodeAt(edgeA, pointsA, point), nodeB = endpointNodeAt(edgeB, pointsB, point);
    if (!nodeA || nodeA !== nodeB) crossings++;
  }
  return [crossings, rounded(shared), rounded(near)];
}

function compareConflict(a, b) {
  for (let index = 0; index < a.length; index++) if (Math.abs(a[index] - b[index]) > .01) return a[index] - b[index];
  return 0;
}

function routeLength(points) {
  return rounded(points.slice(1).reduce((total, point, index) => total
    + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y), 0));
}

export function routeEndpointSegmentsValid(points, minimum = ENDPOINT_SEGMENT_MIN) {
  if (!points?.length || points.length < 2) return false;
  const length = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  return length(points[0], points[1]) >= minimum && length(points.at(-2), points.at(-1)) >= minimum;
}

function routeDetour(points) {
  if (!points?.length) return 0;
  const direct = Math.abs(points[0].x - points.at(-1).x) + Math.abs(points[0].y - points.at(-1).y);
  return Math.floor(Math.max(0, routeLength(points) - direct) / ROUTE_DETOUR_BAND);
}

function routeBends(points) { return Math.max(0, points.length - 2); }

function routeAxes(graph, positions, assignments) {
  const x = new Set(), y = new Set();
  const add = (set, value, readable = false) => {
    set.add(rounded(value));
    set.add(rounded(value - ROUTE_NUDGE)); set.add(rounded(value + ROUTE_NUDGE));
    if (readable) { set.add(rounded(value - ROUTE_READABLE_GAP)); set.add(rounded(value + ROUTE_READABLE_GAP)); }
  };
  for (const node of graph.nodes) {
    const point = positions[node.id];
    add(x, point.x - ROUTE_PADDING, true); add(x, point.x + WIDTH + ROUTE_PADDING, true);
    add(y, point.y - ROUTE_PADDING, true); add(y, point.y + HEIGHT + ROUTE_PADDING, true);
  }
  for (const assignment of assignments.values()) for (const role of ['source', 'target']) {
    add(x, assignment[role].anchor.x); add(y, assignment[role].anchor.y);
  }
  // 局部包络无法绕过“首段即被封住”的布局。保留图外的一圈可见走廊，
  // 供严格避障的网格搜索使用；它不会成为普通候选的优先路径。
  const points = graph.nodes.map(node => positions[node.id]);
  add(x, Math.min(...points.map(point => point.x)) - ROUTE_PADDING - ROUTE_READABLE_GAP, true);
  add(x, Math.max(...points.map(point => point.x + WIDTH)) + ROUTE_PADDING + ROUTE_READABLE_GAP, true);
  add(y, Math.min(...points.map(point => point.y)) - ROUTE_PADDING - ROUTE_READABLE_GAP, true);
  add(y, Math.max(...points.map(point => point.y + HEIGHT)) + ROUTE_PADDING + ROUTE_READABLE_GAP, true);
  return { x: [...x].sort((a, b) => a - b), y: [...y].sort((a, b) => a - b) };
}

function validRouteCandidate(graph, positions, edge, assignment, points, minimumEndpoint = ENDPOINT_SEGMENT_MIN) {
  if (!points?.length || !samePoint(points[0], assignment.source.port) || !samePoint(points.at(-1), assignment.target.port)) return false;
  if (!routeEndpointSegmentsValid(points, minimumEndpoint)) return false;
  for (const segment of routeSegments(points)) {
    if (samePoint(segment.a, segment.b) || (Math.abs(segment.a.x - segment.b.x) > .01 && Math.abs(segment.a.y - segment.b.y) > .01)) return false;
  }
  const sourceVector = SIDE_VECTOR[assignment.source.side], targetVector = SIDE_VECTOR[assignment.target.side];
  const first = points[1], beforeLast = points.at(-2);
  if ((first.x - points[0].x) * sourceVector.x + (first.y - points[0].y) * sourceVector.y <= 0) return false;
  if ((beforeLast.x - points.at(-1).x) * targetVector.x + (beforeLast.y - points.at(-1).y) * targetVector.y <= 0) return false;
  const internal = points.slice(1, -1);
  return !graph.nodes.some(node => routeCrossesNode(
    node.id === edge.source || node.id === edge.target ? internal : points,
    positions[node.id], ROUTE_PADDING));
}

function candidateDirectionValid(assignment, points) {
  if (points.length < 2) return false;
  const sourceVector = SIDE_VECTOR[assignment.source.side], targetVector = SIDE_VECTOR[assignment.target.side];
  const first = points[1], beforeLast = points.at(-2);
  return (first.x - points[0].x) * sourceVector.x + (first.y - points[0].y) * sourceVector.y > 0
    && (beforeLast.x - points.at(-1).x) * targetVector.x + (beforeLast.y - points.at(-1).y) * targetVector.y > 0;
}

function routeBlockingContacts(graph, positions, edge, points) {
  return graph.nodes.flatMap(node => {
    const route = node.id === edge.source || node.id === edge.target ? points.slice(1, -1) : points;
    const position = positions[node.id];
    const segments = routeSegments(route).filter(segment => routeCrossesNode([segment.a, segment.b], position, ROUTE_PADDING));
    return segments.length ? [{ nodeId: node.id, segments }] : [];
  });
}

// 外围候选只从实际碰到的障碍扩张包络。每个分支拥有自己的障碍集合，
// 因此另一条方向上的无关节点不会污染本路线的 width / height。
function obstacleEnvelopeCandidates(graph, positions, edge, assignment) {
  const source = assignment.source, target = assignment.target, start = source.anchor, end = target.anchor;
  // 初始包络只由真实接入锚点决定；节点在无关轴上的完整宽高不应把外围通道推远。
  const localBounds = { left: Math.min(start.x, end.x), right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y), bottom: Math.max(start.y, end.y) };
  const routeFor = (branch, envelope) => {
    const bounds = envelope ?? localBounds;
    const axisX = branch.x === 'left' ? bounds.left - branch.clearX : bounds.right + branch.clearX;
    const axisY = branch.y === 'top' ? bounds.top - branch.clearY : bounds.bottom + branch.clearY;
    if (branch.kind === 'direct') return { points: [start, end] };
    if (branch.kind === 'hv') return { points: [start, { x: end.x, y: start.y }, end] };
    if (branch.kind === 'vh') return { points: [start, { x: start.x, y: end.y }, end] };
    if (branch.kind === 'x') return { points: [start, { x: axisX, y: start.y }, { x: axisX, y: end.y }, end], axisX };
    if (branch.kind === 'y') return { points: [start, { x: start.x, y: axisY }, { x: end.x, y: axisY }, end], axisY };
    if (branch.kind === 'xy') return { points: [start, { x: axisX, y: start.y }, { x: axisX, y: axisY },
      { x: end.x, y: axisY }, end], axisX, axisY };
    return { points: [start, { x: start.x, y: axisY }, { x: axisX, y: axisY }, { x: axisX, y: end.y }, end],
      axisX, axisY };
  };
  const branches = [{ id: 'direct', kind: 'direct' }, { id: 'hv', kind: 'hv' }, { id: 'vh', kind: 'vh' }];
  const clearances = [ROUTE_NUDGE, ROUTE_READABLE_GAP];
  for (const x of ['left', 'right']) for (const clearX of clearances) {
    branches.push({ id: `x-${x}-${clearX}`, kind: 'x', x, clearX });
  }
  for (const y of ['top', 'bottom']) for (const clearY of clearances) {
    branches.push({ id: `y-${y}-${clearY}`, kind: 'y', y, clearY });
  }
  for (const x of ['left', 'right']) for (const y of ['top', 'bottom']) {
    for (const clearX of clearances) for (const clearY of clearances) {
      branches.push({ id: `xy-${x}-${clearX}-${y}-${clearY}`, kind: 'xy', x, y, clearX, clearY });
      branches.push({ id: `yx-${y}-${clearY}-${x}-${clearX}`, kind: 'yx', x, y, clearX, clearY });
    }
  }
  const result = [];
  for (const branch of branches) {
    let envelope = null;
    const xBlockers = new Set(), yBlockers = new Set();
    for (let iteration = 0; iteration <= graph.nodes.length; iteration++) {
      let points, route;
      try {
        route = routeFor(branch, envelope);
        points = normalizeRoute([source.port, ...route.points, target.port]);
      } catch { break; }
      if (!candidateDirectionValid(assignment, points)) break;
      const contacts = routeBlockingContacts(graph, positions, edge, points);
      if (!contacts.length) { result.push(points); break; }
      let grew = false, resolvable = true;
      for (const contact of contacts) {
        const expandX = route.axisX !== undefined && contact.segments.some(segment => segment.vertical
          && Math.abs(segment.a.x - route.axisX) < .01);
        const expandY = route.axisY !== undefined && contact.segments.some(segment => !segment.vertical
          && Math.abs(segment.a.y - route.axisY) < .01);
        if (!expandX && !expandY) { resolvable = false; break; }
        if (expandX && !xBlockers.has(contact.nodeId)) { xBlockers.add(contact.nodeId); grew = true; }
        if (expandY && !yBlockers.has(contact.nodeId)) { yBlockers.add(contact.nodeId); grew = true; }
      }
      if (!resolvable || !grew) break;
      const xPoints = [...xBlockers].map(id => positions[id]);
      const yPoints = [...yBlockers].map(id => positions[id]);
      envelope = {
        left: xPoints.length ? Math.min(localBounds.left, ...xPoints.map(point => point.x - ROUTE_PADDING)) : localBounds.left,
        right: xPoints.length ? Math.max(localBounds.right, ...xPoints.map(point => point.x + WIDTH + ROUTE_PADDING)) : localBounds.right,
        top: yPoints.length ? Math.min(localBounds.top, ...yPoints.map(point => point.y - ROUTE_PADDING)) : localBounds.top,
        bottom: yPoints.length ? Math.max(localBounds.bottom, ...yPoints.map(point => point.y + HEIGHT + ROUTE_PADDING)) : localBounds.bottom,
      };
    }
  }
  return result;
}

function candidateRoutes(graph, positions, edge, assignment, _axes, extra = []) {
  const candidates = [], seen = new Set();
  const add = raw => {
    let points;
    try { points = normalizeRoute(raw); } catch { return; }
    if (!validRouteCandidate(graph, positions, edge, assignment, points)) return;
    const key = points.map(point => `${point.x},${point.y}`).join(';');
    if (seen.has(key)) return; seen.add(key); candidates.push(points);
  };
  for (const points of obstacleEnvelopeCandidates(graph, positions, edge, assignment)) add(points);
  const direct = directPortRoute(graph, positions, edge, assignment); if (direct) add(direct);
  for (const points of extra) add(points);
  const sorted = candidates.sort((a, b) => compareTuple(
    [endpointWrapCount(edge, positions, a), routeDetour(a), routeBends(a), routeLength(a)],
    [endpointWrapCount(edge, positions, b), routeDetour(b), routeBends(b), routeLength(b)])
    || a.map(point => `${point.x},${point.y}`).join(';').localeCompare(b.map(point => `${point.x},${point.y}`).join(';')));
  return sorted.slice(0, 80);
}

// 只在局部包络没有任何可行路径时启用。网格顶点来自节点外缘、端口锚点与图外走廊；
// 每一段均先通过同一套节点穿越判定，因此它是完整的正交避障求解，而不是视觉降级。
function visibilityGridRoute(graph, positions, edge, assignment, axes) {
  const x = [...new Set([...axes.x, assignment.source.anchor.x, assignment.target.anchor.x])].sort((a, b) => a - b);
  const y = [...new Set([...axes.y, assignment.source.anchor.y, assignment.target.anchor.y])].sort((a, b) => a - b);
  const start = { x: x.indexOf(assignment.source.anchor.x), y: y.indexOf(assignment.source.anchor.y) };
  const end = { x: x.indexOf(assignment.target.anchor.x), y: y.indexOf(assignment.target.anchor.y) };
  if (start.x < 0 || start.y < 0 || end.x < 0 || end.y < 0) return null;
  const key = point => `${point.x}/${point.y}`;
  const pointAt = point => ({ x: x[point.x], y: y[point.y] });
  const clear = (from, to) => !graph.nodes.some(node => routeCrossesNode([pointAt(from), pointAt(to)], positions[node.id], ROUTE_PADDING));
  const targetVector = SIDE_VECTOR[assignment.target.side];
  const entersTargetFromOutside = point => {
    const value = pointAt(point), anchor = assignment.target.anchor;
    return (value.x - anchor.x) * targetVector.x + (value.y - anchor.y) * targetVector.y > 0;
  };
  const queue = [start], previous = new Map([[key(start), null]]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (current.x === end.x && current.y === end.y) break;
    const neighbors = [
      { x: current.x - 1, y: current.y }, { x: current.x + 1, y: current.y },
      { x: current.x, y: current.y - 1 }, { x: current.x, y: current.y + 1 },
    ].filter(point => point.x >= 0 && point.x < x.length && point.y >= 0 && point.y < y.length);
    for (const next of neighbors) {
      const nextKey = key(next);
      if (previous.has(nextKey) || !clear(current, next)
        || (next.x === end.x && next.y === end.y && !entersTargetFromOutside(current))) continue;
      previous.set(nextKey, current); queue.push(next);
    }
  }
  if (!previous.has(key(end))) return null;
  const path = [];
  for (let current = end; current; current = previous.get(key(current))) path.push(pointAt(current));
  path.reverse();
  try { return normalizeRoute([assignment.source.port, ...path, assignment.target.port]); } catch { return null; }
}

function webColaCandidate(graph, positions, edge, assignment, cola) {
  if (typeof cola?.GridRouter !== 'function' || typeof cola?.Rectangle !== 'function') return null;
  const records = graph.nodes.map(node => {
    const point = positions[node.id];
    return { id: node.id, bounds: new cola.Rectangle(point.x - ROUTE_PADDING, point.x + WIDTH + ROUTE_PADDING,
      point.y - ROUTE_PADDING, point.y + HEIGHT + ROUTE_PADDING) };
  });
  for (const role of ['source', 'target']) {
    const { x, y } = assignment[role].anchor;
    records.push({ id: `__route-${role}`, bounds: new cola.Rectangle(x - 1, x + 1, y - 1, y + 1) });
  }
  const accessor = { getChildren: () => [], getBounds: item => item.bounds };
  try {
    let router = new cola.GridRouter(records, accessor, ROUTE_CORNER);
    if (router.rows.length < 2 || router.cols.length < 2) {
      const xs = records.flatMap(item => [item.bounds.x, item.bounds.X]), ys = records.flatMap(item => [item.bounds.y, item.bounds.Y]);
      records.push(
        { id: 'sentinel-start', bounds: new cola.Rectangle(Math.min(...xs) - 111, Math.min(...xs) - 109, Math.min(...ys) - 111, Math.min(...ys) - 109) },
        { id: 'sentinel-end', bounds: new cola.Rectangle(Math.max(...xs) + 109, Math.max(...xs) + 111, Math.max(...ys) + 109, Math.max(...ys) + 111) },
      );
      router = new cola.GridRouter(records, accessor, ROUTE_CORNER);
    }
    const sourceIndex = records.findIndex(item => item.id === '__route-source'), targetIndex = records.findIndex(item => item.id === '__route-target');
    const route = router.routeEdges([edge], 0, () => sourceIndex, () => targetIndex)?.[0];
    if (!route?.length) return null;
    const routed = normalizeRoute([route[0][0], ...route.map(segment => segment[1])]);
    return normalizeRoute([...endpointConnector(assignment.source, routed[0], true),
      ...routed.slice(1, -1), ...endpointConnector(assignment.target, routed.at(-1), false)]);
  } catch { return null; }
}

function routeScore(graph, positions, edges, routes) {
  let hard = 0, shared = 0, crossings = 0, endpointExcursions = 0;
  let near = 0, detour = 0, bends = 0, maxBends = 0, length = 0, bendCrowding = 0;
  const bendPoints = [];
  for (const edge of edges) {
    const points = routes.get(edge.id); if (!points) { hard++; continue; }
    const edgeBends = routeBends(points);
    bends += edgeBends; maxBends = Math.max(maxBends, edgeBends);
    endpointExcursions += endpointWrapCount(edge, positions, points);
    detour += routeDetour(points); length += routeLength(points); bendPoints.push(...points.slice(1, -1));
    hard += graph.nodes.filter(node => node.id !== edge.source && node.id !== edge.target
      && routeCrossesNode(points, positions[node.id], ROUTE_PADDING)).length;
  }
  for (let first = 0; first < bendPoints.length; first++) for (let second = first + 1; second < bendPoints.length; second++) {
    const dx = Math.abs(bendPoints[first].x - bendPoints[second].x), dy = Math.abs(bendPoints[first].y - bendPoints[second].y);
    if (dx < ROUTE_NUDGE * 2 && dy < ROUTE_NUDGE * 2) bendCrowding++;
  }
  for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
    const a = routes.get(edges[first].id), b = routes.get(edges[second].id); if (!a || !b) continue;
    const conflict = pairConflict(edges[first], a, edges[second], b);
    crossings += conflict[0]; shared += conflict[1]; near += conflict[2];
  }
  // 节点穿越和共线重叠之后先淘汰端点 U 型，再比较普通交叉；
  // 每 192px 为一级的显著绕行在拐点数之前裁决，避免少一个拐点却绕完整张图。
  // 同一绕行级别仍先减少拐点，细小距离差不会把清晰的 L 形路线挤成 Z/U 形。
  return [hard, rounded(shared), endpointExcursions, crossings, detour, bends, maxBends,
    bendCrowding, rounded(near), rounded(length)];
}

function routeIntrinsic(graph, positions, edge, points) {
  if (!points) return { hard: 1, endpointExcursions: 0, detour: 0, bends: 0, length: 0 };
  return {
    hard: graph.nodes.filter(node => node.id !== edge.source && node.id !== edge.target
      && routeCrossesNode(points, positions[node.id], ROUTE_PADDING)).length,
    endpointExcursions: endpointWrapCount(edge, positions, points),
    detour: routeDetour(points), bends: routeBends(points),
    length: routeLength(points),
  };
}

function bendCrowdingBetween(left, right, sameRoute = false) {
  if (!left || !right) return 0;
  const a = cachedRouteGeometry(left).bends, b = cachedRouteGeometry(right).bends; let total = 0;
  for (let first = 0; first < a.length; first++) {
    const start = sameRoute ? first + 1 : 0;
    for (let second = start; second < b.length; second++) {
      const dx = Math.abs(a[first].x - b[second].x), dy = Math.abs(a[first].y - b[second].y);
      if (dx < ROUTE_NUDGE * 2 && dy < ROUTE_NUDGE * 2) total++;
    }
  }
  return total;
}

// 候选试探只重算被替换路线的内在贡献，以及它们与其他路线的成对贡献。
// 返回值与 routeScore 完全同构；完整 routeScore 只保留给初始状态和最终独立审计。
function routeScoreAfterChanges(graph, positions, edges, routes, score, replacements) {
  const byId = new Map(edges.map(edge => [edge.id, edge]));
  const changed = [...replacements.keys()].filter(id => byId.has(id));
  if (!changed.length) return score;
  let [hard, shared, endpointExcursions, crossings, detour, bends, , bendCrowding, near, length] = score;
  for (const id of changed) {
    const edge = byId.get(id), before = routes.get(id), after = replacements.get(id);
    const oldIntrinsic = routeIntrinsic(graph, positions, edge, before);
    const newIntrinsic = routeIntrinsic(graph, positions, edge, after);
    hard += newIntrinsic.hard - oldIntrinsic.hard;
    endpointExcursions += newIntrinsic.endpointExcursions - oldIntrinsic.endpointExcursions;
    detour += newIntrinsic.detour - oldIntrinsic.detour;
    bends += newIntrinsic.bends - oldIntrinsic.bends;
    length += newIntrinsic.length - oldIntrinsic.length;
    bendCrowding += bendCrowdingBetween(after, after, true) - bendCrowdingBetween(before, before, true);
  }
  const visitedPairs = new Set();
  for (const id of changed) for (const other of edges) {
    if (other.id === id) continue;
    const key = id < other.id ? `${id}\u0000${other.id}` : `${other.id}\u0000${id}`;
    if (visitedPairs.has(key)) continue;
    visitedPairs.add(key);
    const edge = byId.get(id), beforeLeft = routes.get(id), beforeRight = routes.get(other.id);
    const afterLeft = replacements.get(id) ?? beforeLeft;
    const afterRight = replacements.get(other.id) ?? beforeRight;
    bendCrowding += bendCrowdingBetween(afterLeft, afterRight) - bendCrowdingBetween(beforeLeft, beforeRight);
    if (beforeLeft && beforeRight) {
      const conflict = pairConflict(edge, beforeLeft, other, beforeRight);
      crossings -= conflict[0]; shared -= conflict[1]; near -= conflict[2];
    }
    if (afterLeft && afterRight) {
      const conflict = pairConflict(edge, afterLeft, other, afterRight);
      crossings += conflict[0]; shared += conflict[1]; near += conflict[2];
    }
  }
  const maxBends = edges.reduce((maximum, edge) => Math.max(maximum,
    routeBends(replacements.get(edge.id) ?? routes.get(edge.id) ?? [])), 0);
  return [hard, rounded(shared), endpointExcursions, crossings, detour, bends, maxBends,
    bendCrowding, rounded(near), rounded(length)];
}

function routePairContribution(edgeA, pointsA, edgeB, pointsB) {
  if (!pointsA || !pointsB) return [0, 0, 0, 0];
  const conflict = pairConflict(edgeA, pointsA, edgeB, pointsB);
  return [conflict[1], conflict[0], bendCrowdingBetween(pointsA, pointsB), conflict[2]];
}

// 同一条边对的候选组合共享“其余边”的最大拐点，以及当前路线对的贡献。
// 这些量不随候选变化，不能在每个笛卡尔积组合里重复扫描整图。
function pairScoreContext(edges, state, left, right) {
  return {
    untouchedMaxBends: edges.reduce((maximum, edge) => edge === left || edge === right ? maximum
      : Math.max(maximum, routeBends(state.routes.get(edge.id) ?? [])), 0),
    oldPair: routePairContribution(left, state.routes.get(left.id), right, state.routes.get(right.id)),
  };
}

// 两条边的候选笛卡尔积共享各自相对固定全图的一次增量评分；
// 每个组合只补算两条候选之间的关系，避免 36×36 次重复扫描其余边。
function scoreTwoRouteChanges(graph, positions, edges, state, left, right, leftRoute, rightRoute,
  leftScore, rightScore, context = pairScoreContext(edges, state, left, right), leftPair = null, rightPair = null) {
  const score = state.score.map((value, index) => index === ROUTING_QUALITY.maxBends
    ? 0 : leftScore[index] + rightScore[index] - value);
  const oldPair = context.oldPair;
  leftPair ??= routePairContribution(left, leftRoute, right, state.routes.get(right.id));
  rightPair ??= routePairContribution(left, state.routes.get(left.id), right, rightRoute);
  const nextPair = routePairContribution(left, leftRoute, right, rightRoute);
  for (const [scoreIndex, pairIndex] of [[ROUTING_QUALITY.collinearOverlap, 0], [ROUTING_QUALITY.crossings, 1],
    [ROUTING_QUALITY.bendCrowding, 2], [ROUTING_QUALITY.nearParallel, 3]])
    score[scoreIndex] += oldPair[pairIndex] + nextPair[pairIndex] - leftPair[pairIndex] - rightPair[pairIndex];
  score[ROUTING_QUALITY.maxBends] = Math.max(context.untouchedMaxBends, routeBends(leftRoute), routeBends(rightRoute));
  for (const index of [ROUTING_QUALITY.collinearOverlap, ROUTING_QUALITY.nearParallel, ROUTING_QUALITY.length])
    score[index] = rounded(score[index]);
  return score;
}

export function routeGraphScore(graph, positions, routes) {
  const points = new Map([...routes].map(([id, route]) => [id, route.points ?? route]));
  return routeScore(graph, positions, graph.edges.filter(edge => edge.source !== edge.target), points);
}

export function routeGraphEndpointExcursions(graph, positions, routes) {
  return graph.edges.filter(edge => edge.source !== edge.target).flatMap(edge => {
    const route = routes.get(edge.id);
    if (!route?.points || !route.sourcePort || !route.targetPort) return [];
    const points = route.points;
    const count = endpointWrapCount(edge, positions, points);
    return count ? [{ edgeId: edge.id, source: edge.source, target: edge.target, count }] : [];
  });
}

export function routeGraphScoreAfterChanges(graph, positions, routes, replacements) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target);
  const points = new Map([...routes].map(([id, route]) => [id, route.points ?? route]));
  const changed = new Map([...replacements].map(([id, route]) => [id, route.points ?? route]));
  return routeScoreAfterChanges(graph, positions, edges, points,
    routeScore(graph, positions, edges, points), changed);
}

export function routeGraphScoreAfterPairChanges(graph, positions, routes, replacements) {
  if (replacements.size !== 2) throw new Error('双边增量评分必须且只能提供两条替换路径。');
  const edges = graph.edges.filter(edge => edge.source !== edge.target).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(edges.map(edge => [edge.id, edge]));
  const points = new Map([...routes].map(([id, route]) => [id, route.points ?? route]));
  const changed = [...replacements].map(([id, route]) => [id, route.points ?? route]);
  const [[leftId, leftRoute], [rightId, rightRoute]] = changed;
  const left = byId.get(leftId), right = byId.get(rightId);
  if (!left || !right) throw new Error('双边增量评分包含未知连线。');
  const state = { routes: points, score: routeScore(graph, positions, edges, points) };
  const leftScore = routeScoreAfterChanges(graph, positions, edges, points, state.score, new Map([[leftId, leftRoute]]));
  const rightScore = routeScoreAfterChanges(graph, positions, edges, points, state.score, new Map([[rightId, rightRoute]]));
  return scoreTwoRouteChanges(graph, positions, edges, state, left, right, leftRoute, rightRoute, leftScore, rightScore);
}

export function routeGraphConflicts(graph, routes) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target).sort((a, b) => a.id.localeCompare(b.id));
  const points = new Map([...routes].map(([id, route]) => [id, route.points ?? route])), result = [];
  for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
    const conflict = pairConflict(edges[first], points.get(edges[first].id), edges[second], points.get(edges[second].id));
    if (compareConflict(conflict, [0, 0, 0]) > 0) result.push({ left: edges[first].id, right: edges[second].id,
      crossings: conflict[0], shared: conflict[1], near: conflict[2] });
  }
  return result;
}

// 自动排版使用的可读性反馈：长平行通道低于目标间距时，返回应扩展的坐标切分线。
// 节点外的短端口逃逸段不参与切分，避免为了端点扇出而无界放大整张图。
export function routeGraphSpacingConflicts(routes, minGap = ROUTE_READABLE_GAP, { includeCoincident = false } = {}) {
  const entries = [...routes].map(([id, route]) => {
    const points = route.points ?? route, segments = routeSegments(points);
    return [id, segments.map(segment => ({ ...segment,
      endpoints: route.points ? [route.sourcePort, route.targetPort].filter(endpoint => endpoint
        && (samePoint(endpoint.port, segment.a) || samePoint(endpoint.port, segment.b))) : [] }))];
  }), cuts = [];
  for (let first = 0; first < entries.length; first++) for (let second = first + 1; second < entries.length; second++) {
    const leftSegments = entries[first][1], rightSegments = entries[second][1];
    for (const a of leftSegments) for (const b of rightSegments) {
      if (a.vertical !== b.vertical) continue;
      const axisA = a.vertical ? a.a.x : a.a.y, axisB = b.vertical ? b.a.x : b.a.y;
      // 常规车道切分不重复处理共线重叠（由路由评分负责）；严格审计显式
      // 要求保留该证据时才纳入，避免改变既有端口通道的展示语义。
      const gap = Math.abs(axisA - axisB); if ((!includeCoincident && gap < .01) || gap >= minGap) continue;
      const a1 = a.vertical ? a.a.y : a.a.x, a2 = a.vertical ? a.b.y : a.b.x;
      const b1 = b.vertical ? b.a.y : b.a.x, b2 = b.vertical ? b.b.y : b.b.x;
      const overlapStart = Math.max(Math.min(a1, a2), Math.min(b1, b2));
      const overlapEnd = Math.min(Math.max(a1, a2), Math.max(b1, b2));
      const overlap = overlapEnd - overlapStart;
      if (overlap < 60) continue;
      // 只要线段一端是真实节点端口，就属于端点接入段并服从端口槽位间距；
      // 只有两端均为拐点的中段通道才参与 48px 切分。
      if (a.endpoints.length || b.endpoints.length) continue;
      cuts.push({ axis: a.vertical ? 'x' : 'y', coordinate: (axisA + axisB) / 2,
        deficit: minGap - gap, overlap, edges: [entries[first][0], entries[second][0]],
        segments: [a, b] });
    }
  }
  return cuts;
}

function mergeSpacingCuts(cuts, minGap) {
  const merged = new Map();
  for (const cut of cuts) {
    const key = `${cut.axis}/${Math.round(cut.coordinate / minGap)}`;
    const current = merged.get(key);
    if (!current) merged.set(key, { ...cut });
    else {
      const weight = current.overlap + cut.overlap;
      current.coordinate = (current.coordinate * current.overlap + cut.coordinate * cut.overlap) / weight;
      current.deficit = Math.max(current.deficit, cut.deficit); current.overlap = weight;
    }
  }
  return [...merged.values()].sort((a, b) => b.deficit - a.deficit || b.overlap - a.overlap
    || a.axis.localeCompare(b.axis) || a.coordinate - b.coordinate);
}

export function routeGraphSpacingCuts(routes, minGap = ROUTE_READABLE_GAP) {
  const cuts = routeGraphSpacingConflicts(routes, minGap).map(({ axis, coordinate, deficit, overlap }) =>
    ({ axis, coordinate, deficit, overlap }));
  return mergeSpacingCuts(cuts, minGap);
}

// 自动整理提交前的单一严格审计口径。它只报告事实，不尝试兜底修复，
// 以便局部几何事务可以在失败时保持原图完全不变。
export function auditGraphGeometryStrict(graph, positions, routes, minGap = ROUTE_READABLE_GAP) {
  const score = routeGraphScore(graph, positions, routes);
  const missing = graph.edges.filter(edge => edge.source !== edge.target && !routes.has(edge.id)).map(edge => edge.id);
  const shortEndpoints = [...routes].filter(([, route]) => route?.points
    && !routeEndpointSegmentsValid(route.points)).map(([id]) => id);
  const spacing = routeGraphSpacingConflicts(routes, minGap, { includeCoincident: true });
  // 48px 是阅读上的目标车道宽度，而不是图几何的可行性前提。高扇出图中，
  // 强迫所有长平行段都达到该宽度会把“美化”误判为“必须移动节点”，最终触发
  // 不必要的大范围布局变动。只有零间距的共线段属于不可提交的硬冲突；其余
  // spacing 保留给路由评分与车道优化作为软告警。
  const overlaps = spacing.filter(item => item.deficit >= minGap - .01);
  const laneWarnings = spacing.filter(item => item.deficit < minGap - .01);
  const reasons = [];
  if (missing.length || score[ROUTING_QUALITY.hardInvalid] > 0) reasons.push('节点穿越或缺失路径');
  if (score[ROUTING_QUALITY.collinearOverlap] > .01) reasons.push('共线重叠');
  if (shortEndpoints.length) reasons.push('端口接入段过短');
  return { ok: !reasons.length, score, missing, shortEndpoints, spacing, overlaps, laneWarnings, reasons };
}

// 只调整拥挤走廊。除居中分轨外，同时尝试保持一侧、移动单段；
// 一个走廊受阻不会撤销其他走廊的改善，节点与端口始终固定。
export function normalizeRouteLanes(graph, positions, routes, gap = ROUTE_READABLE_GAP, allowShortEndpointSegments = false) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target);
  const byId = new Map(edges.map(edge => [edge.id, edge]));
  const pointRoutes = new Map([...routes].map(([id, route]) => [id, route.points ?? route]));
  let score = routeScore(graph, positions, edges, pointRoutes), result = routes;
  const records = [];
  for (const [edgeId, route] of routes) {
    const points = route.points ?? route, segments = routeSegments(points);
    for (let index = 1; index < segments.length - 1; index++) {
      const segment = segments[index], vertical = segment.vertical;
      records.push({ edgeId, index, vertical, axis: vertical ? segment.a.x : segment.a.y,
        from: Math.min(vertical ? segment.a.y : segment.a.x, vertical ? segment.b.y : segment.b.x),
        to: Math.max(vertical ? segment.a.y : segment.a.x, vertical ? segment.b.y : segment.b.x) });
    }
  }
  const parent = records.map((_, index) => index);
  const root = index => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
  const join = (left, right) => { left = root(left); right = root(right); if (left !== right) parent[right] = left; };
  for (let left = 0; left < records.length; left++) for (let right = left + 1; right < records.length; right++) {
    const a = records[left], b = records[right];
    if (a.edgeId === b.edgeId || a.vertical !== b.vertical || Math.abs(a.axis - b.axis) >= gap * 2) continue;
    if (Math.min(a.to, b.to) - Math.max(a.from, b.from) >= 60) join(left, right);
  }
  const groups = new Map();
  records.forEach((record, index) => { const id = root(index); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(record); });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.axis - b.axis || a.edgeId.localeCompare(b.edgeId) || a.index - b.index);
    if (sorted.every((record, index) => !index || record.axis - sorted[index - 1].axis >= gap - .01)) continue;
    const center = sorted.length % 2 ? sorted[(sorted.length - 1) / 2].axis
      : (sorted[sorted.length / 2 - 1].axis + sorted[sorted.length / 2].axis) / 2;
    const halfSpan = (sorted.length - 1) * gap / 2;
    const proposals = [center, sorted[0].axis + halfSpan, sorted.at(-1).axis - halfSpan]
      .map(value => sorted.map((record, index) => ({ record, target: rounded(value + index * gap - halfSpan) })));
    // 空间只在一侧、或只有组件的一部分拥挤时，允许让行一段而保留其余路线。
    for (let index = 1; index < sorted.length; index++) {
      const left = sorted[index - 1], right = sorted[index];
      if (right.axis - left.axis >= gap - .01) continue;
      proposals.push([{ record: left, target: rounded(right.axis - gap) }],
        [{ record: right, target: rounded(left.axis + gap) }]);
    }
    let best = null;
    for (const proposal of proposals) {
      const changes = new Map();
      for (const { record, target } of proposal) {
        if (!byId.has(record.edgeId) || Math.abs(target - record.axis) < .01) continue;
        if (!changes.has(record.edgeId)) changes.set(record.edgeId, pointRoutes.get(record.edgeId).map(point => ({ ...point })));
        const points = changes.get(record.edgeId), axis = record.vertical ? 'x' : 'y';
        points[record.index][axis] = target; points[record.index + 1][axis] = target;
      }
      if (!changes.size) continue;
      const valid = [...changes].every(([id, points]) => {
        const route = result.get(id);
        if (route.sourcePort && route.targetPort) return validRouteCandidate(graph, positions, byId.get(id),
          { source: route.sourcePort, target: route.targetPort }, points, allowShortEndpointSegments ? 0 : ENDPOINT_SEGMENT_MIN);
        return (!route.points || allowShortEndpointSegments || routeEndpointSegmentsValid(points))
          && routeSegments(points).every(segment => !samePoint(segment.a, segment.b)
            && (segment.a.x === segment.b.x || segment.a.y === segment.b.y));
      });
      if (!valid) continue;
      const nextScore = routeScoreAfterChanges(graph, positions, edges, pointRoutes, score, changes);
      if (!routeQualityPreserved(score, nextScore) || compareTuple(nextScore, score) >= 0) continue;
      if (!best || compareTuple(nextScore, best.score) < 0) best = { changes, score: nextScore };
    }
    if (!best) continue;
    if (result === routes) result = new Map(routes);
    for (const [id, points] of best.changes) {
      pointRoutes.set(id, points); result.set(id, replaceRoutePoints(result.get(id), points));
    }
    score = best.score;
  }
  return result;
}

// 为已有路线补充局部捷径。只有找到可验证的替代路径才认为绕行多余；
// 不禁止必要的 U 形，也不改变端口面、端口槽或节点位置。
export function simplifyRouteDetours(graph, positions, routes) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target);
  const pointRoutes = new Map([...routes].map(([id, route]) => [id, route.points ?? route]));
  let score = routeScore(graph, positions, edges, pointRoutes), result = routes;
  for (const edge of edges) {
    const route = result.get(edge.id), points = pointRoutes.get(edge.id);
    if (!route?.sourcePort || !route?.targetPort || points.length < 4) continue;
    const assignment = { source: route.sourcePort, target: route.targetPort };
    let best = null;
    const seen = new Set();
    // 从最长子路径开始，优先找到大段绕行的直接替代；每条边有独立候选上限。
    let attempts = 0;
    for (let span = points.length - 1; span >= 2 && attempts < 96; span--) {
      for (let start = 0; start + span < points.length && attempts < 96; start++) {
        const end = start + span, a = points[start], b = points[end];
        for (const corner of [{ x: a.x, y: b.y }, { x: b.x, y: a.y }]) {
          attempts++;
          const candidate = normalizeRoute([...points.slice(0, start + 1), corner, ...points.slice(end)]);
          if (routeBends(candidate) > routeBends(points) || routeLength(candidate) > routeLength(points) + .01) continue;
          const key = candidate.map(point => `${point.x},${point.y}`).join(';');
          if (seen.has(key)) continue; seen.add(key);
          if (!validRouteCandidate(graph, positions, edge, assignment, candidate)) continue;
          const nextScore = routeScoreAfterChanges(graph, positions, edges, pointRoutes, score,
            new Map([[edge.id, candidate]]));
          if (!routeQualityPreserved(score, nextScore) || compareTuple(nextScore, score) >= 0) continue;
          if (!best || compareTuple(nextScore, best.score) < 0) best = { points: candidate, score: nextScore };
        }
      }
    }
    if (!best) continue;
    if (result === routes) result = new Map(routes);
    pointRoutes.set(edge.id, best.points); result.set(edge.id, replaceRoutePoints(route, best.points)); score = best.score;
  }
  return result;
}

// 同轴节点却从同一侧绕出的路线，单纯移动中段可能没有足够净空。
// 将换面和整条路线作为一个候选验证，避免先制造过短接入段再靠重算修补。
function simplifySameSidePorts(graph, positions, routes) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target);
  const eligible = edges.filter(edge => {
    const route = routes.get(edge.id);
    if (!route?.sourcePort || !route?.targetPort || route.sourcePort.side !== route.targetPort.side) return false;
    const source = positions[edge.source], target = positions[edge.target];
    return source && target && (Math.abs(source.x - target.x) < .01 || Math.abs(source.y - target.y) < .01);
  });
  if (!eligible.length || edges.some(edge => !routes.get(edge.id)?.sourcePort || !routes.get(edge.id)?.targetPort)) return routes;
  const assignments = new Map([...routes].filter(([, route]) => route.sourcePort && route.targetPort)
    .map(([id, route]) => [id, structuredClone({ source: route.sourcePort, target: route.targetPort })]));
  const axes = routeAxes(graph, positions, assignments);
  const state = { routes: new Map([...routes].map(([id, route]) => [id, route.points ?? route])),
    score: routeGraphScore(graph, positions, routes) };
  let result = routes;
  for (const edge of eligible) {
    const proposal = bestEndpointProposal(graph, positions, edges, assignments, axes, state, edge,
      null, 12, false, null, false, { preserveQuality: true });
    if (!proposal || !routeQualityPreserved(state.score, proposal.score) || compareTuple(proposal.score, state.score) >= 0) continue;
    assignments.set(edge.id, proposal.assignment);
    state.routes.set(edge.id, proposal.points); state.score = proposal.score;
    if (result === routes) result = new Map(routes);
    result.set(edge.id, replaceRoutePoints({ ...routes.get(edge.id), sourcePort: proposal.assignment.source,
      targetPort: proposal.assignment.target }, proposal.points));
  }
  return result;
}

// 有界地交替处理绕行与车道；每次接受都严格改善同一质量向量。
// 完整图评分保留在入口与最终审计，候选试算使用增量评分。
export function improveRouteGeometry(graph, positions, routes,
  { rounds = 16, allowShortEndpointSegments = false, allowPortChanges = true } = {}) {
  let result = routes;
  for (let round = 0; round < rounds; round++) {
    const adjusted = allowPortChanges ? simplifySameSidePorts(graph, positions, result) : result;
    const simplified = simplifyRouteDetours(graph, positions, adjusted);
    const next = normalizeRouteLanes(graph, positions, simplified, ROUTE_READABLE_GAP, allowShortEndpointSegments);
    if (next === result) break;
    result = next;
  }
  return result;
}

function conflictSeverityMap(graph, routes) {
  return new Map(routeGraphConflicts(graph, routes)
    .filter(conflict => conflict.crossings > 0 || conflict.shared > 0)
    .map(conflict => [[conflict.left, conflict.right].sort().join('\u0000'), [conflict.crossings, conflict.shared]]));
}

// 节点落地后的正式布线仍使用 routeGraphEdges，只把候选协商限制在真实影响域内。
// 新冲突会把另一侧边纳入下一轮；无法保持质量时才退回全图计算。
export function rerouteMovedNodes(graph, positions, cached, movedIds, cola = globalThis.cola, allowProvisional = false) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target).sort((a, b) => a.id.localeCompare(b.id));
  const moved = new Set(movedIds.filter(id => graph.nodes.some(node => node.id === id)));
  if (!edges.length) return { routes: new Map(), edgeIds: [], full: false };
  if (!moved.size || edges.some(edge => !cached?.get(edge.id)?.points)) {
    return { routes: routeGraphEdges(graph, positions, cola, new Map(), { allowProvisional }), edgeIds: edges.map(edge => edge.id), full: true };
  }
  const byId = new Map(edges.map(edge => [edge.id, edge])), affected = new Set();
  for (const edge of edges) {
    const points = cached.get(edge.id).points;
    if (moved.has(edge.source) || moved.has(edge.target)
      || [...moved].some(id => id !== edge.source && id !== edge.target
        && routeCrossesNode(points, positions[id], ROUTE_PADDING))) affected.add(edge.id);
  }
  const expandPortPeers = () => {
    const endpointNodes = new Set([...affected].flatMap(id => {
      const edge = byId.get(id); return [edge.source, edge.target];
    }));
    for (const edge of edges) if (endpointNodes.has(edge.source) || endpointNodes.has(edge.target)) affected.add(edge.id);
  };
  expandPortPeers();
  const baseline = conflictSeverityMap(graph, cached);
  for (let round = 0; round < 4; round++) {
    if (affected.size >= Math.max(12, Math.ceil(edges.length * .7))) {
      return { routes: routeGraphEdges(graph, positions, cola, new Map(), { allowProvisional }), edgeIds: edges.map(edge => edge.id), full: true };
    }
    const localEdges = edges.filter(edge => affected.has(edge.id));
    const fixedRoutes = new Map([...cached].filter(([edgeId]) => !affected.has(edgeId)));
    const local = routeGraphEdges({ ...graph, edges: localEdges }, positions, cola, fixedRoutes, { allowProvisional });
    const merged = new Map(cached);
    for (const [id, route] of local) merged.set(id, route);
    const additions = new Set();
    for (const edge of edges) {
      if (affected.has(edge.id)) continue;
      const points = merged.get(edge.id).points;
      if (graph.nodes.some(node => node.id !== edge.source && node.id !== edge.target
        && routeCrossesNode(points, positions[node.id], ROUTE_PADDING))) additions.add(edge.id);
    }
    for (const conflict of routeGraphConflicts(graph, merged)) {
      if (!conflict.crossings && !conflict.shared) continue;
      const key = [conflict.left, conflict.right].sort().join('\u0000'), previous = baseline.get(key) ?? [0, 0];
      if (compareConflict([conflict.crossings, conflict.shared], previous) <= 0) continue;
      if (affected.has(conflict.left) && !affected.has(conflict.right)) additions.add(conflict.right);
      if (affected.has(conflict.right) && !affected.has(conflict.left)) additions.add(conflict.left);
    }
    // 局部结果合并缓存后按完整视图审计端口负载。若边界节点形成 4:1，
    // 只把该节点的其余关联边纳入下一轮，不把无关连线升级为全图重算。
    for (const nodeId of endpointContractViolationNodeIds(merged, positions)) {
      for (const edge of edges) if (edge.source === nodeId || edge.target === nodeId) additions.add(edge.id);
    }
    if (!additions.size) return { routes: merged, edgeIds: [...affected].sort(), full: false };
    for (const id of additions) affected.add(id);
    expandPortPeers();
  }
  return { routes: routeGraphEdges(graph, positions, cola, new Map(), { allowProvisional }), edgeIds: edges.map(edge => edge.id), full: true };
}

function refineRouteCandidates(graph, positions, edges, candidates, state, rounds = 1) {
  const routes = state.routes; let score = state.score;
  for (let round = 0; round < rounds; round++) {
    let changed = false;
    for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
      let best = routes.get(edge.id), bestScore = score;
      const options = edges.length > 80 ? searchCandidates(candidates.get(edge.id), 8) : candidates.get(edge.id);
      for (const points of options) {
        if (points === best) continue;
        const candidateScore = routeScoreAfterChanges(graph, positions, edges, routes, score,
          new Map([[edge.id, points]]));
        if (compareTuple(candidateScore, bestScore) < 0) { best = points; bestScore = candidateScore; }
      }
      routes.set(edge.id, best);
      if (compareTuple(bestScore, score) < 0) { score = bestScore; changed = true; }
    }
    if (!changed) break;
  }
  return { routes, score };
}

function optimizeRouteCandidates(graph, positions, edges, assignments, candidates) {
  const routes = new Map(edges.map(edge => [edge.id, candidates.get(edge.id)[0]]));
  return refineRouteCandidates(graph, positions, edges, candidates,
    { routes, score: routeScore(graph, positions, edges, routes) }, 3);
}

function searchCandidates(list, limit = 36) {
  return list.slice(0, limit);
}

// 从当前冲突线段生成新车道，而不是反复排列同一批节点包络候选。
// 坐标来自实际邻线；这里只改变候选集合，提交仍由完整/增量质量评分裁决。
function conflictRouteCandidates(graph, positions, edge, assignment, points, neighbors) {
  const x = new Set(), y = new Set(), extras = [], seen = new Set();
  const add = raw => {
    const candidate = normalizeRoute(raw);
    if (!validRouteCandidate(graph, positions, edge, assignment, candidate)) return;
    const key = candidate.map(point => `${point.x},${point.y}`).join(';');
    if (!seen.has(key)) { seen.add(key); extras.push(candidate); }
  };
  for (const neighbor of neighbors) for (const segment of routeSegments(neighbor)) {
    const values = segment.vertical ? x : y, coordinate = segment.vertical ? segment.a.x : segment.a.y;
    for (const distance of [ROUTE_NUDGE, ROUTE_READABLE_GAP]) {
      values.add(rounded(coordinate - distance)); values.add(rounded(coordinate + distance));
    }
  }
  const source = assignment.source, target = assignment.target, start = source.anchor, end = target.anchor;
  // 端口槽的 escape anchor 是初始候选的偏好，不是最小接入长度。
  // 相邻边换槽后，最短合法接入处可能恰好留有窄通道，必须将它纳入搜索。
  for (const endpoint of [source, target]) {
    const vector = SIDE_VECTOR[endpoint.side];
    if (vector.x) x.add(rounded(endpoint.port.x + vector.x * ENDPOINT_SEGMENT_MIN));
    if (vector.y) y.add(rounded(endpoint.port.y + vector.y * ENDPOINT_SEGMENT_MIN));
  }
  const nearest = (values, a, b) => [...values].sort((left, right) =>
    Math.abs(left - a) + Math.abs(left - b) - Math.abs(right - a) - Math.abs(right - b) || left - right).slice(0, 12);
  for (const lane of nearest(x, start.x, end.x)) add([source.port, start,
    { x: lane, y: start.y }, { x: lane, y: end.y }, end, target.port]);
  for (const lane of nearest(y, start.y, end.y)) add([source.port, start,
    { x: start.x, y: lane }, { x: end.x, y: lane }, end, target.port]);
  for (let index = 1; index < points.length - 2; index++) {
    const a = points[index], b = points[index + 1], vertical = a.x === b.x, axis = vertical ? 'x' : 'y';
    for (const lane of nearest(vertical ? x : y, a[axis], b[axis]).slice(0, 6)) {
      const shifted = points.map(point => ({ ...point }));
      shifted[index][axis] = lane; shifted[index + 1][axis] = lane; add(shifted);
    }
  }
  return extras;
}

function expandConflictCandidates(graph, positions, edges, assignments, candidates, state, policy) {
  const records = new Map(edges.map(edge => [edge.id, { edge, shared: 0, crossings: 0, near: 0, neighbors: [] }]));
  for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
    const left = edges[first], right = edges[second];
    const [crossings, shared, near] = pairConflict(left, state.routes.get(left.id), right, state.routes.get(right.id));
    if (!crossings && !shared && !near) continue;
    for (const [edge, other] of [[left, right], [right, left]]) {
      const record = records.get(edge.id);
      record.crossings += crossings; record.shared += shared; record.near += near;
      record.neighbors.push({ id: other.id, shared, crossings, near });
    }
  }
  const ranked = [...records.values()].filter(record => record.neighbors.length)
    .sort((a, b) => b.shared - a.shared || b.crossings - a.crossings || b.near - a.near || a.edge.id.localeCompare(b.edge.id));
  const selected = [...ranked.filter(record => record.shared > 0),
    ...ranked.filter(record => record.shared === 0).slice(0, policy === ROUTING_SEARCH.large ? 16 : 32)];
  for (const record of selected) {
    const { edge } = record;
    const neighbors = record.neighbors.sort((a, b) => b.shared - a.shared || b.crossings - a.crossings || b.near - a.near)
      .slice(0, 6).map(item => state.routes.get(item.id));
    const extras = conflictRouteCandidates(graph, positions, edge, assignments.get(edge.id), state.routes.get(edge.id), neighbors);
    if (!extras.length) continue;
    const rankedRoutes = [...new Set([state.routes.get(edge.id), ...candidates.get(edge.id), ...extras])]
      .map(points => ({ points, score: routeScoreAfterChanges(graph, positions, edges, state.routes, state.score,
        new Map([[edge.id, points]])) })).filter(item => routeQualityPreserved(state.score, item.score))
      .sort((a, b) => compareTuple(a.score, b.score));
    if (rankedRoutes.length && compareTuple(rankedRoutes[0].score, state.score) < 0) {
      state.routes.set(edge.id, rankedRoutes[0].points); state.score = rankedRoutes[0].score;
    }
  }
  return state;
}

function optimizeConflictPairs(graph, positions, edges, candidates, state, policy) {
  const searchLimit = policy.candidateLimit;
  for (let round = 0; round < policy.pairRounds; round++) {
    let changed = false;
    const conflicts = [];
    for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
      const left = edges[first], right = edges[second];
      const currentConflict = pairConflict(left, state.routes.get(left.id), right, state.routes.get(right.id));
      if (compareConflict(currentConflict, [0, 0, 0]) <= 0) continue;
      conflicts.push({ left, right, currentConflict });
    }
    conflicts.sort((a, b) => b.currentConflict[1] - a.currentConflict[1]
      || b.currentConflict[0] - a.currentConflict[0] || b.currentConflict[2] - a.currentConflict[2]
      || a.left.id.localeCompare(b.left.id) || a.right.id.localeCompare(b.right.id));
    // 硬冲突属于提交合同，不能为了搜索预算留下可避免的交叉或共线；预算只
    // 限制软可读性冲突。错误的 ELK 层内顺序才是此前复杂图耗时的根因。
    const overlapConflicts = conflicts.filter(item => item.currentConflict[1] > 0);
    const softConflicts = conflicts.filter(item => item.currentConflict[1] <= 0).slice(0, policy.conflictPairBudget);
    for (const { left, right, currentConflict } of [...overlapConflicts, ...softConflicts]) {
      const localLimit = currentConflict[1] > 0 ? ROUTING_SEARCH.normal.candidateLimit : searchLimit;
      const leftRoutes = searchCandidates(candidates.get(left.id), localLimit);
      const rightRoutes = searchCandidates(candidates.get(right.id), localLimit);
      const leftScores = new Map(leftRoutes.map(route => [route, routeScoreAfterChanges(graph, positions, edges,
        state.routes, state.score, new Map([[left.id, route]]))]));
      const rightScores = new Map(rightRoutes.map(route => [route, routeScoreAfterChanges(graph, positions, edges,
        state.routes, state.score, new Map([[right.id, route]]))]));
      const pairContext = pairScoreContext(edges, state, left, right);
      const leftPairs = new Map(leftRoutes.map(route => [route,
        routePairContribution(left, route, right, state.routes.get(right.id))]));
      const rightPairs = new Map(rightRoutes.map(route => [route,
        routePairContribution(left, state.routes.get(left.id), right, route)]));
      let best = null;
      for (const leftRoute of leftRoutes) for (const rightRoute of rightRoutes) {
        const score = scoreTwoRouteChanges(graph, positions, edges, state, left, right, leftRoute, rightRoute,
          leftScores.get(leftRoute), rightScores.get(rightRoute), pairContext,
          leftPairs.get(leftRoute), rightPairs.get(rightRoute));
        if (!best || compareTuple(score, best.score) < 0) best = { leftRoute, rightRoute, score };
      }
      if (best && compareTuple(best.score, state.score) < 0) {
        state.routes.set(left.id, best.leftRoute); state.routes.set(right.id, best.rightRoute);
        state.score = best.score; changed = true;
      }
    }
    if (!changed) break;
  }
  return state;
}

function optimizeConflictComponents(graph, positions, edges, candidates, state, policy) {
  const searchLimit = policy.candidateLimit, beamWidth = policy.beamWidth;
  const adjacency = new Map(edges.map(edge => [edge.id, new Set()]));
  for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
    if (compareConflict(pairConflict(edges[first], state.routes.get(edges[first].id), edges[second], state.routes.get(edges[second].id)), [0, 0, 0]) <= 0) continue;
    adjacency.get(edges[first].id).add(edges[second].id); adjacency.get(edges[second].id).add(edges[first].id);
  }
  const seen = new Set();
  for (const edge of edges) {
    if (seen.has(edge.id) || !adjacency.get(edge.id).size) continue;
    const component = [], queue = [edge.id]; seen.add(edge.id);
    while (queue.length) {
      const id = queue.shift(); component.push(id);
      for (const next of adjacency.get(id)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    if (component.length > 4) continue;
    let beam = [{ routes: new Map(state.routes), score: state.score }];
    for (const id of component.sort()) {
      const expanded = [];
      for (const item of beam) for (const points of searchCandidates(candidates.get(id), searchLimit)) {
        const routes = new Map(item.routes); routes.set(id, points);
        expanded.push({ routes, score: routeScoreAfterChanges(graph, positions, edges, item.routes, item.score,
          new Map([[id, points]])) });
      }
      expanded.sort((a, b) => compareTuple(a.score, b.score)); beam = expanded.slice(0, beamWidth);
    }
    if (beam[0] && compareTuple(beam[0].score, state.score) < 0) state = beam[0];
  }
  return state;
}

function alternativeEndpoint(edge, role, side, assignments, positions, variant = 0) {
  const nodeId = role === 'source' ? edge.source : edge.target, otherId = role === 'source' ? edge.target : edge.source;
  const point = positions[nodeId];
  const sameSide = [];
  for (const [edgeId, assignment] of assignments) {
    if (edgeId === edge.id) continue;
    for (const endpoint of [assignment.source, assignment.target]) if (endpoint.nodeId === nodeId && endpoint.side === side) sameSide.push(endpoint);
  }
  if (sameSide.length >= 7) return null;
  const length = side === 'top' || side === 'bottom' ? WIDTH : HEIGHT;
  const offsets = [.5, .75, .25, .625, .375, .875, .125].map(ratio => clamp(length * ratio, PORT_MARGIN, length - PORT_MARGIN));
  const used = new Set(sameSide.map(endpoint => rounded(side === 'left' || side === 'right'
    ? endpoint.port.y - point.y : endpoint.port.x - point.x)));
  const offset = offsets.filter(value => !used.has(rounded(value)))[variant]; if (offset === undefined) return null;
  const usedSlots = new Set(sameSide.map(endpoint => endpoint.slot));
  const slot = Array.from({ length: PORTS_PER_SIDE }, (_, index) => index).find(index => !usedSlots.has(index));
  if (slot === undefined) return null;
  const port = endpointPoint(point, side, offset);
  return { side, nodeId, otherId, port, anchor: anchorPoint(port, side, slot), slot };
}

function bestEndpointProposal(graph, positions, edges, assignments, axes, state, edge,
  routeCache = null, candidateLimit = 36, requireNoWrap = false, crowdingBefore = null, adjacentOnly = false,
  { slotVariants = 1, preserveQuality = false } = {}) {
  const current = assignments.get(edge.id);
  const existingDetour = preserveQuality ? routeDetour(state.routes.get(edge.id)) : 0;
  const existingCrowding = slotVariants > 1 ? endpointRelativeCrowding(assignments, positions) : 0;
  const acceptableSides = (nodeId, otherId) => SIDES.filter(side => endpointSideAllowed({ nodeId, otherId }, side, positions));
  const neighboringSides = side => {
    const index = SIDES.indexOf(side);
    return [side, SIDES[(index + 1) % SIDES.length], SIDES[(index + SIDES.length - 1) % SIDES.length]];
  };
  const sourceSides = adjacentOnly ? neighboringSides(current.source.side).filter(side => acceptableSides(edge.source, edge.target).includes(side))
    : acceptableSides(edge.source, edge.target);
  const targetSides = adjacentOnly ? neighboringSides(current.target.side).filter(side => acceptableSides(edge.target, edge.source).includes(side))
    : acceptableSides(edge.target, edge.source);
  let best = null;
  const options = (role, side) => {
    if (slotVariants === 1) return [side === current[role].side ? current[role]
      : alternativeEndpoint(edge, role, side, assignments, positions)];
    const alternatives = Array.from({ length: slotVariants }, (_, index) => alternativeEndpoint(edge, role, side, assignments, positions, index));
    const unique = new Map();
    for (const endpoint of [...(side === current[role].side ? [current[role]] : []), ...alternatives].filter(Boolean)) {
      const key = `${endpoint.port.x},${endpoint.port.y}/${endpoint.anchor.x},${endpoint.anchor.y}`;
      if (!unique.has(key)) unique.set(key, endpoint);
    }
    return [...unique.values()];
  };
  for (const sourceSide of sourceSides) for (const targetSide of targetSides) {
    for (const source of options('source', sourceSide)) for (const target of options('target', targetSide)) {
      if (!source || !target || (!requireNoWrap && source === current.source && target === current.target)) continue;
      const assignment = { source: { ...source, port: { ...source.port }, anchor: { ...source.anchor } },
        target: { ...target, port: { ...target.port }, anchor: { ...target.anchor } } };
      assignments.set(edge.id, assignment);
      const relativeCrowding = endpointRelativeCrowding(assignments, positions);
      assignments.set(edge.id, current);
      if (crowdingBefore === null ? relativeCrowding > existingCrowding : relativeCrowding >= crowdingBefore) continue;
      const endpointKey = endpoint => `${endpoint.side}:${endpoint.port.x},${endpoint.port.y}:${endpoint.anchor.x},${endpoint.anchor.y}`;
      const cacheKey = `${edge.id}/${endpointKey(assignment.source)}/${endpointKey(assignment.target)}`;
      let routes = routeCache?.get(cacheKey);
      if (!routes) {
        routes = candidateRoutes(graph, positions, edge, assignment, axes);
        routeCache?.set(cacheKey, routes);
      }
      for (const points of searchCandidates(routes, candidateLimit)) {
        if (requireNoWrap && endpointWrapCount(edge, positions, points) > 0) continue;
        if (preserveQuality && routeDetour(points) > existingDetour + .0001) continue;
        const score = routeScoreAfterChanges(graph, positions, edges, state.routes, state.score,
          new Map([[edge.id, points]]));
        if (preserveQuality && !routeQualityPreserved(state.score, score)) continue;
        if (!best || compareTuple(score, best.score) < 0) best = { ...routeOption(edge, assignment, routes, points, score),
          relativeCrowding };
      }
    }
  }
  return best && (crowdingBefore !== null || compareTuple(best.score, state.score) < 0) ? best : null;
}

function routeOption(edge, assignment, candidates, points, score) {
  return { edge, assignment, candidates, points, score };
}

function applyRouteOption(option, assignments, candidates, state) {
  assignments.set(option.edge.id, option.assignment);
  candidates.set(option.edge.id, option.candidates);
  state.routes.set(option.edge.id, option.points);
  state.score = option.score;
}

function optimizeEndpointSides(graph, positions, edges, assignments, axes, candidates, state, policy) {
  const routeCache = new Map(), candidateLimit = policy.candidateLimit;
  const endpointAvailable = proposal => ['source', 'target'].every(role => {
    const endpoint = proposal.assignment[role];
    for (const [edgeId, assignment] of assignments) {
      if (edgeId === proposal.edge.id) continue;
      for (const other of [assignment.source, assignment.target]) {
        if (endpoint.nodeId === other.nodeId && endpoint.side === other.side && samePoint(endpoint.port, other.port)) return false;
      }
    }
    return true;
  });
  // 相对拥挤是端口合同，不依赖路线冲突是否恰好触发。只在合同已违反时搜索相邻面，
  // 每次必须降低全图违反量；路线评分负责在这些必要分流中选择冲突和折返最少者。
  for (let round = 0; round < SIDES.length && endpointRelativeCrowding(assignments, positions) > 0; round++) {
    const crowdingBefore = endpointRelativeCrowding(assignments, positions);
    const proposals = edges.map(edge => bestEndpointProposal(graph, positions, edges, assignments, axes, state, edge,
      routeCache, candidateLimit, false, crowdingBefore, true)).filter(Boolean)
      .sort((left, right) => left.relativeCrowding - right.relativeCrowding
        || compareTuple(left.score, right.score) || left.edge.id.localeCompare(right.edge.id));
    const proposal = proposals.find(endpointAvailable);
    if (!proposal) break;
    applyRouteOption(proposal, assignments, candidates, state);
  }
  // 每轮为每条可改进边生成一个最佳提案，再依次按最新状态复核并提交。
  // 这保留精确词典序接受条件，同时避免“每接受一条边就重算全图全部换面组合”。
  for (let round = 0; round < policy.endpointRounds; round++) {
    const severity = new Map();
    for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
      const conflict = pairConflict(edges[first], state.routes.get(edges[first].id), edges[second], state.routes.get(edges[second].id));
      if (conflict[0] <= 0 && conflict[1] <= 0) continue;
      for (const edge of [edges[first], edges[second]]) {
        const current = severity.get(edge.id) ?? [0, 0];
        severity.set(edge.id, [current[0] + conflict[1], current[1] + conflict[0]]);
      }
    }
    const proposals = [];
    const ranked = edges.filter(edge => severity.has(edge.id)).sort((a, b) => {
      const left = severity.get(a.id), right = severity.get(b.id);
      return right[0] - left[0] || right[1] - left[1] || a.id.localeCompare(b.id);
    });
    const overlapEdges = ranked.filter(edge => severity.get(edge.id)[0] > 0);
    const softEdges = ranked.filter(edge => severity.get(edge.id)[0] <= 0).slice(0, policy.endpointEdgeBudget);
    const improvable = [...overlapEdges, ...softEdges];
    for (const edge of improvable) {
      const limit = severity.get(edge.id)[0] > 0 ? ROUTING_SEARCH.normal.candidateLimit : candidateLimit;
      const best = bestEndpointProposal(graph, positions, edges, assignments, axes, state, edge, routeCache, limit);
      if (best) proposals.push(best);
    }
    proposals.sort((left, right) => compareTuple(left.score, right.score) || left.edge.id.localeCompare(right.edge.id));
    let changed = false;
    for (const proposal of proposals) {
      if (!endpointAvailable(proposal)) continue;
      const score = routeScoreAfterChanges(graph, positions, edges, state.routes, state.score,
        new Map([[proposal.edge.id, proposal.points]]));
      if (compareTuple(score, state.score) >= 0) continue;
      applyRouteOption({ ...proposal, score }, assignments, candidates, state); changed = true;
      break;
    }
    if (!changed) break;
  }
  // 硬冲突清零后，在不恶化四面相对负载的前提下精简拐点；这仍属于端口面确定阶段。
  for (let round = 0; round < policy.simplicityRounds; round++) {
    const currentBalance = endpointBalance(endpointLoads(assignments));
    const proposals = edges.filter(edge => routeBends(state.routes.get(edge.id)) > 1)
      .map(edge => {
        const wrapped = endpointWrapCount(edge, positions, state.routes.get(edge.id)) > 0;
        return bestEndpointProposal(graph, positions, edges, assignments, axes, state, edge,
          routeCache, candidateLimit, wrapped);
      })
      .filter(Boolean).filter(proposal => {
        const wrapped = endpointWrapCount(proposal.edge, positions, state.routes.get(proposal.edge.id)) > 0;
        const previous = assignments.get(proposal.edge.id);
        assignments.set(proposal.edge.id, proposal.assignment);
        const balance = endpointBalance(endpointLoads(assignments));
        assignments.set(proposal.edge.id, previous);
        return wrapped || balance <= currentBalance;
      }).sort((left, right) => compareTuple(left.score, right.score) || left.edge.id.localeCompare(right.edge.id));
    let changed = false;
    for (const proposal of proposals) {
      if (!endpointAvailable(proposal)) continue;
      const previous = assignments.get(proposal.edge.id);
      const wrapped = endpointWrapCount(proposal.edge, positions, state.routes.get(proposal.edge.id)) > 0;
      assignments.set(proposal.edge.id, proposal.assignment);
      const balance = endpointBalance(endpointLoads(assignments));
      if (!wrapped && balance > currentBalance) { assignments.set(proposal.edge.id, previous); continue; }
      const score = routeScoreAfterChanges(graph, positions, edges, state.routes, state.score,
        new Map([[proposal.edge.id, proposal.points]]));
      if (compareTuple(score, state.score) >= 0) { assignments.set(proposal.edge.id, previous); continue; }
      applyRouteOption({ ...proposal, score }, assignments, candidates, state); changed = true;
    }
    if (!changed) break;
  }
  return state;
}

function assignmentEndpoints(assignment) {
  return [assignment.source ?? assignment.sourcePort, assignment.target ?? assignment.targetPort].filter(Boolean);
}

function endpointLoads(assignments) {
  const loads = new Map();
  for (const assignment of assignments.values()) for (const endpoint of assignmentEndpoints(assignment)) {
    if (!loads.has(endpoint.nodeId)) loads.set(endpoint.nodeId, Object.fromEntries(SIDES.map(side => [side, 0])));
    loads.get(endpoint.nodeId)[endpoint.side]++;
  }
  return loads;
}

function endpointBalance(loads) {
  let total = 0;
  for (const sides of loads.values()) for (const side of SIDES) total += sides[side] * sides[side];
  return total;
}

function endpointSideAllowed(endpoint, side, positions) {
  const point = positions?.[endpoint.nodeId], other = positions?.[endpoint.otherId];
  if (!point || !other) return true;
  const dx = other.x - point.x, dy = other.y - point.y, distance = Math.hypot(dx, dy) || 1;
  return dx / distance * SIDE_VECTOR[side].x + dy / distance * SIDE_VECTOR[side].y >= -.0001;
}

function endpointRelativeCrowdingByNode(assignments, positions = null) {
  const result = new Map(), loads = endpointLoads(assignments), endpoints = new Map();
  for (const assignment of assignments.values()) for (const endpoint of assignmentEndpoints(assignment)) {
    if (!endpoints.has(endpoint.nodeId)) endpoints.set(endpoint.nodeId, []);
    endpoints.get(endpoint.nodeId).push(endpoint);
  }
  for (const [nodeId, sides] of loads) for (let index = 0; index < SIDES.length; index++) {
    const side = SIDES[index], next = SIDES[(index + 1) % SIDES.length];
    const [crowded, sparse] = sides[side] >= sides[next] ? [side, next] : [next, side];
    const excess = sides[crowded] - sides[sparse] - 2;
    if (excess <= 0) continue;
    const movable = (endpoints.get(nodeId) ?? []).some(endpoint => endpoint.side === crowded
      && endpointSideAllowed(endpoint, sparse, positions));
    if (movable) result.set(nodeId, (result.get(nodeId) ?? 0) + excess);
  }
  return result;
}

function endpointRelativeCrowding(assignments, positions = null) {
  return [...endpointRelativeCrowdingByNode(assignments, positions).values()].reduce((total, value) => total + value, 0);
}

function endpointContractViolationNodeIds(assignments, positions = null) {
  const result = new Set(), loads = endpointLoads(assignments), occupied = new Map();
  for (const [nodeId, sides] of loads) if (SIDES.some(side => sides[side] > PORTS_PER_SIDE)) result.add(nodeId);
  // 相邻面的相对拥挤度用于优化端口分布，但不等同于端口容量、槽位或
  // 几何冲突。高密度图在所有严格路径均有效时允许保留该软性不均衡。
  for (const assignment of assignments.values()) for (const endpoint of assignmentEndpoints(assignment)) {
    const key = `${endpoint.nodeId}\u0000${endpoint.side}`;
    if (!occupied.has(key)) occupied.set(key, { slots: new Set(), ports: new Set() });
    const portKey = `${endpoint.port.x},${endpoint.port.y}`, record = occupied.get(key);
    if (record.slots.has(endpoint.slot) || record.ports.has(portKey)) result.add(endpoint.nodeId);
    record.slots.add(endpoint.slot); record.ports.add(portKey);
    if (!positions?.[endpoint.nodeId]) continue;
    const point = positions[endpoint.nodeId], offset = endpoint.side === 'left' || endpoint.side === 'right'
      ? endpoint.port.y - point.y : endpoint.port.x - point.x;
    if (!samePoint(endpoint.port, endpointPoint(point, endpoint.side, offset))
      || offset < PORT_MARGIN - .01 || offset > (endpoint.side === 'left' || endpoint.side === 'right' ? HEIGHT : WIDTH) - PORT_MARGIN + .01) {
      result.add(endpoint.nodeId);
    }
  }
  return [...result];
}

function swapAssignmentPorts(left, right) {
  for (const key of ['port', 'anchor', 'slot']) [left[key], right[key]] = [right[key], left[key]];
}

function optimizePortSwaps(graph, positions, edges, assignments, axes, candidates, state, policy) {
  const searchLimit = policy.candidateLimit;
  const groups = new Map();
  for (const edge of edges) for (const role of ['source', 'target']) {
    const endpoint = assignments.get(edge.id)[role], key = `${endpoint.nodeId}/${endpoint.side}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ edge, role });
  }
  for (let round = 0; round < policy.swapRounds; round++) {
    const overlapEdges = new Set();
    for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
      if (pairConflict(edges[first], state.routes.get(edges[first].id), edges[second], state.routes.get(edges[second].id))[1] <= 0) continue;
      overlapEdges.add(edges[first].id); overlapEdges.add(edges[second].id);
    }
    const swapPairs = [];
    for (const members of groups.values()) for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
      const left = members[a], right = members[b];
      swapPairs.push({ left, right, hard: overlapEdges.has(left.edge.id) || overlapEdges.has(right.edge.id) });
    }
    swapPairs.sort((a, b) => Number(b.hard) - Number(a.hard)
      || a.left.edge.id.localeCompare(b.left.edge.id) || a.right.edge.id.localeCompare(b.right.edge.id));
    const hardPairs = swapPairs.filter(pair => pair.hard);
    const softPairs = swapPairs.filter(pair => !pair.hard).slice(0, policy.swapPairBudget);
    let changed = false;
    for (const { left, right, hard } of [...hardPairs, ...softPairs]) {
      const leftAssignment = assignments.get(left.edge.id)[left.role];
      const rightAssignment = assignments.get(right.edge.id)[right.role];
      swapAssignmentPorts(leftAssignment, rightAssignment);
      const leftCandidates = candidateRoutes(graph, positions, left.edge, assignments.get(left.edge.id), axes);
      const rightCandidates = candidateRoutes(graph, positions, right.edge, assignments.get(right.edge.id), axes);
      const limit = hard ? ROUTING_SEARCH.normal.candidateLimit : searchLimit;
      const leftRoutes = searchCandidates(leftCandidates, limit), rightRoutes = searchCandidates(rightCandidates, limit);
      const leftScores = new Map(leftRoutes.map(route => [route, routeScoreAfterChanges(graph, positions, edges,
        state.routes, state.score, new Map([[left.edge.id, route]]))]));
      const rightScores = new Map(rightRoutes.map(route => [route, routeScoreAfterChanges(graph, positions, edges,
        state.routes, state.score, new Map([[right.edge.id, route]]))]));
      const pairContext = pairScoreContext(edges, state, left.edge, right.edge);
      const leftPairs = new Map(leftRoutes.map(route => [route,
        routePairContribution(left.edge, route, right.edge, state.routes.get(right.edge.id))]));
      const rightPairs = new Map(rightRoutes.map(route => [route,
        routePairContribution(left.edge, state.routes.get(left.edge.id), right.edge, route)]));
      let best = null;
      for (const leftRoute of leftRoutes) for (const rightRoute of rightRoutes) {
        const score = scoreTwoRouteChanges(graph, positions, edges, state, left.edge, right.edge, leftRoute, rightRoute,
          leftScores.get(leftRoute), rightScores.get(rightRoute), pairContext,
          leftPairs.get(leftRoute), rightPairs.get(rightRoute));
        if (!best || compareTuple(score, best.score) < 0) best = { leftRoute, rightRoute, score };
      }
      if (best && compareTuple(best.score, state.score) < 0) {
        state.routes.set(left.edge.id, best.leftRoute); state.routes.set(right.edge.id, best.rightRoute);
        candidates.set(left.edge.id, leftCandidates); candidates.set(right.edge.id, rightCandidates);
        state.score = best.score; changed = true;
      } else {
        swapAssignmentPorts(leftAssignment, rightAssignment);
      }
    }
    if (!changed) break;
  }
  return state;
}

// 一次换槽可能把交叉转移到第三条邻线。先在隔离候选中完成换槽与邻线重算，
// 最后整体裁决；不要求每个中间状态都比原图好，也不把中间冲突提交给画布。
function optimizeCrossingNeighborhoods(graph, positions, edges, assignments, axes, candidates, state) {
  const pairs = [];
  for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
    const left = edges[first], right = edges[second];
    const crossings = pairConflict(left, state.routes.get(left.id), right, state.routes.get(right.id))[0];
    if (!crossings) continue;
    for (const leftRole of ['source', 'target']) for (const rightRole of ['source', 'target']) {
      const a = assignments.get(left.id)[leftRole], b = assignments.get(right.id)[rightRole];
      if (a.nodeId === b.nodeId && a.side === b.side) pairs.push({ left, right, leftRole, rightRole, crossings });
    }
  }
  pairs.sort((a, b) => b.crossings - a.crossings || a.left.id.localeCompare(b.left.id) || a.right.id.localeCompare(b.right.id));
  for (const { left, right, leftRole, rightRole } of pairs.slice(0, edges.length >= 60 ? 4 : 12)) {
    if (!pairConflict(left, state.routes.get(left.id), right, state.routes.get(right.id))[0]) continue;
    const a = assignments.get(left.id)[leftRole], b = assignments.get(right.id)[rightRole];
    swapAssignmentPorts(a, b);
    const leftCandidates = candidateRoutes(graph, positions, left, assignments.get(left.id), axes);
    const rightCandidates = candidateRoutes(graph, positions, right, assignments.get(right.id), axes);
    const leftRoutes = searchCandidates(leftCandidates, 8), rightRoutes = searchCandidates(rightCandidates, 8);
    const leftScores = new Map(leftRoutes.map(points => [points, routeScoreAfterChanges(graph, positions, edges,
      state.routes, state.score, new Map([[left.id, points]]))]));
    const rightScores = new Map(rightRoutes.map(points => [points, routeScoreAfterChanges(graph, positions, edges,
      state.routes, state.score, new Map([[right.id, points]]))]));
    const pairContext = pairScoreContext(edges, state, left, right);
    const leftPairs = new Map(leftRoutes.map(route => [route,
      routePairContribution(left, route, right, state.routes.get(right.id))]));
    const rightPairs = new Map(rightRoutes.map(route => [route,
      routePairContribution(left, state.routes.get(left.id), right, route)]));
    const proposals = [];
    for (const leftRoute of leftRoutes) for (const rightRoute of rightRoutes) proposals.push({ leftRoute, rightRoute,
      local: [...pairConflict(left, leftRoute, right, rightRoute).slice(0, 2),
        routeBends(leftRoute) + routeBends(rightRoute), routeLength(leftRoute) + routeLength(rightRoute)],
      score: scoreTwoRouteChanges(graph, positions, edges, state, left, right, leftRoute, rightRoute,
        leftScores.get(leftRoute), rightScores.get(rightRoute), pairContext,
        leftPairs.get(leftRoute), rightPairs.get(rightRoute)) });
    proposals.sort((a, b) => compareTuple(a.score, b.score));
    // 同时保留局部最简单的提案，不能在修复邻线前就因临时重叠将它剪掉。
    const selectedProposals = [...new Set([...proposals.slice(0, 2),
      ...[...proposals].sort((a, b) => compareTuple(a.local, b.local)).slice(0, 2)])];
    let best = null;
    for (const proposal of selectedProposals) {
      const trial = { routes: new Map(state.routes), score: proposal.score };
      trial.routes.set(left.id, proposal.leftRoute); trial.routes.set(right.id, proposal.rightRoute);
      const neighbors = edges.filter(edge => edge !== left && edge !== right).map(edge => {
        let shared = 0, crossings = 0;
        for (const changed of [left, right]) {
          const before = pairConflict(edge, state.routes.get(edge.id), changed, state.routes.get(changed.id));
          const after = pairConflict(edge, trial.routes.get(edge.id), changed, trial.routes.get(changed.id));
          shared += Math.max(0, after[1] - before[1]); crossings += Math.max(0, after[0] - before[0]);
        }
        return { edge, shared, crossings };
      }).filter(item => item.shared || item.crossings)
        .sort((a, b) => b.shared - a.shared || b.crossings - a.crossings || a.edge.id.localeCompare(b.edge.id));
      for (const { edge } of neighbors.slice(0, 2)) {
        const extras = conflictRouteCandidates(graph, positions, edge, assignments.get(edge.id), trial.routes.get(edge.id),
          [trial.routes.get(left.id), trial.routes.get(right.id)]);
        let selected = null;
        for (const points of [...candidates.get(edge.id), ...extras]) {
          const score = routeScoreAfterChanges(graph, positions, edges, trial.routes, trial.score, new Map([[edge.id, points]]));
          if (compareTuple(score, trial.score) < 0 && (!selected || compareTuple(score, selected.score) < 0)) selected = { points, score };
        }
        if (selected) { trial.routes.set(edge.id, selected.points); trial.score = selected.score; }
      }
      if (routeQualityPreserved(state.score, trial.score) && compareTuple(trial.score, state.score) < 0
        && (!best || compareTuple(trial.score, best.score) < 0)) best = trial;
    }
    if (best) {
      state = best; candidates.set(left.id, leftCandidates); candidates.set(right.id, rightCandidates);
    } else swapAssignmentPorts(a, b);
  }
  return state;
}

// 有交叉的端点不能只试某个面的第一个空槽。保留原有初解后，再对最严重的
// 少量边比较同面/换面的多个空槽，避免无关端口组合消耗大图预算。
function optimizeCrossingPortSlots(graph, positions, edges, assignments, axes, candidates, state) {
  const severity = new Map();
  for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
    const left = edges[first], right = edges[second];
    const crossings = pairConflict(left, state.routes.get(left.id), right, state.routes.get(right.id))[0];
    if (crossings) for (const edge of [left, right]) severity.set(edge.id, (severity.get(edge.id) ?? 0) + crossings);
  }
  const ranked = edges.filter(edge => severity.has(edge.id)).sort((a, b) => severity.get(b.id) - severity.get(a.id) || a.id.localeCompare(b.id));
  const cache = new Map();
  for (const edge of ranked.slice(0, edges.length >= 60 ? 3 : 12)) {
    const proposal = bestEndpointProposal(graph, positions, edges, assignments, axes, state, edge,
      cache, 8, false, null, false, { slotVariants: 3, preserveQuality: true });
    if (proposal && routeQualityPreserved(state.score, proposal.score) && compareTuple(proposal.score, state.score) < 0)
      applyRouteOption(proposal, assignments, candidates, state);
  }
  return state;
}

function viableSeedRouteOption(graph, positions, edge, assignments, axes) {
  const current = assignments.get(edge.id), options = [];
  // 此阶段的职责是恢复“至少一条严格可行路径”。当前端口的首段已经穿入
  // 其他节点时，端口侧替换必须优先于相对拥挤的软评分；最终仍由端口合同审计。
  for (const sourceSide of SIDES) for (const targetSide of SIDES) {
    // 常规端口分配维持“朝向对端或垂直”的短路径偏好。仅在已经没有任何
    // 严格候选时，恢复阶段允许反向端口：高密度图中相邻走廊可能封死唯一的
    // 朝向端口，而绕出节点外侧的 U 形路径仍完全满足穿越与端口合同。
    const source = sourceSide === current.source.side ? current.source
      : alternativeEndpoint(edge, 'source', sourceSide, assignments, positions);
    const target = targetSide === current.target.side ? current.target
      : alternativeEndpoint(edge, 'target', targetSide, assignments, positions);
    if (!source || !target) continue;
    const assignment = { source: { ...source, port: { ...source.port }, anchor: { ...source.anchor } },
      target: { ...target, port: { ...target.port }, anchor: { ...target.anchor } } };
    const routes = candidateRoutes(graph, positions, edge, assignment, axes);
    if (!routes.length) continue;
    const points = routes[0];
    const rank = [endpointWrapCount(edge, positions, points), routeBends(points), routeLength(points),
      SIDES.indexOf(sourceSide), SIDES.indexOf(targetSide)];
    options.push({ ...routeOption(edge, assignment, routes, points, null), rank });
  }
  options.sort((left, right) => compareTuple(left.rank, right.rank));
  return options[0] ?? null;
}

// 所有路径、端口面和端口槽调整只由这个有界求解器提交。
// 各搜索算子只生成候选，统一质量向量负责接受或拒绝，避免阶段各自拥有一套隐含优先级。
function solveRouteOptions(graph, positions, edges, assignments, axes, cola) {
  // 边数达到阈值后先用有界的大图策略产出全图可行解；硬冲突仍完整处理，
  // 只有软可读性优化受预算限制。这样规则网格不会因多轮全量精修而超时。
  const incidentCounts = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of edges) { incidentCounts.set(edge.source, incidentCounts.get(edge.source) + 1); incidentCounts.set(edge.target, incidentCounts.get(edge.target) + 1); }
  const highDegree = Math.max(...incidentCounts.values()) >= 12;
  const policy = edges.length < 60 ? ROUTING_SEARCH.normal : highDegree ? ROUTING_SEARCH.highDegree : ROUTING_SEARCH.large;
  const candidates = new Map();
  for (const edge of edges) {
    const assignment = assignments.get(edge.id);
    // 当前 WebCola 适配器会为每条边重复构建 GridRouter。超过 40 条边时，
    // 这项可选候选会主导全部时间并长期占住工作区锁，改用第一方有界候选。
    const webCola = edges.length <= 40 ? webColaCandidate(graph, positions, edge, assignment, cola) : null;
    let routes = candidateRoutes(graph, positions, edge, assignment, axes, webCola ? [webCola] : []);
    if (!routes.length) {
      const recovery = visibilityGridRoute(graph, positions, edge, assignment, axes);
      if (recovery) routes = candidateRoutes(graph, positions, edge, assignment, axes, [recovery]);
    }
    if (!routes.length) {
      const seed = viableSeedRouteOption(graph, positions, edge, assignments, axes);
      if (!seed) throw new Error(`无法为连线生成可行的正交路径：${edge.id}`);
      assignments.set(edge.id, seed.assignment); routes = seed.candidates;
    }
    candidates.set(edge.id, routes);
  }
  const refreshedAxes = routeAxes(graph, positions, assignments);
  axes.x = refreshedAxes.x; axes.y = refreshedAxes.y;
  let state = optimizeRouteCandidates(graph, positions, edges, assignments, candidates);
  for (let round = 0; round < policy.rounds; round++) {
    const before = state.score;
    state = optimizeConflictPairs(graph, positions, edges, candidates, state, policy);
    state = optimizeEndpointSides(graph, positions, edges, assignments, axes, candidates, state, policy);
    state = optimizePortSwaps(graph, positions, edges, assignments, axes, candidates, state, policy);
    state = optimizeConflictComponents(graph, positions, edges, candidates, state, policy);
    state = refineRouteCandidates(graph, positions, edges, candidates, state, 1);
    if (compareTuple(state.score, before) >= 0) break;
  }
  state = optimizeNearFacingPorts(graph, positions, edges, assignments, axes, state, candidates);
  state = optimizeCrossingPortSlots(graph, positions, edges, assignments, axes, candidates, state);
  state = optimizeCrossingNeighborhoods(graph, positions, edges, assignments, axes, candidates, state);
  state = expandConflictCandidates(graph, positions, edges, assignments, candidates, state, policy);
  return state;
}

// 固定节点的正交布线：WebCola 仅贡献单边候选；端口排列、L/Z/U 路径和通道冲突由全图优化器共同裁决。
export function routeGraphEdges(graph, positions, cola = globalThis.cola, fixedRoutes = new Map(), { allowProvisional = false } = {}) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target).sort((a, b) => a.id.localeCompare(b.id));
  if (!edges.length) return new Map();
  for (const node of graph.nodes) if (!finitePoint(positions[node.id])) throw new Error('节点缺少有效坐标：' + node.id);
  const normalized = normalizedRoutingPositions(graph, positions), routingPositions = normalized.positions;
  const routingFixedRoutes = restoreRoutingOffset(fixedRoutes, { x: -normalized.offset.x, y: -normalized.offset.y });
  const assignments = assignEdgePorts(graph, routingPositions, routingFixedRoutes), axes = routeAxes(graph, routingPositions, assignments);
  const state = solveRouteOptions(graph, routingPositions, edges, assignments, axes, cola);
  const invalidPortNodes = endpointContractViolationNodeIds(assignments, routingPositions);
  if (invalidPortNodes.length) throw new Error(`端口分配违反容量、槽位或相邻面负载合同：${invalidPortNodes.join('、')}`);
  let result = new Map(edges.map(edge => {
    const points = state.routes.get(edge.id), assignment = assignments.get(edge.id);
    return [edge.id, { path: roundedPath(points), points, sourcePort: assignment.source,
      targetPort: assignment.target, ...routeLabel(points) }];
  }));
  // 局部计算还预留了 fixedRoutes 的端口；纯几何后处理不再重新选择端口，
  // 所有换槽仍由持有完整预留信息的 solveRouteOptions 完成。
  result = improveRouteGeometry(graph, routingPositions, result, { allowPortChanges: !routingFixedRoutes.size });
  const shortEndpointEdges = [...result].filter(([, route]) => !routeEndpointSegmentsValid(route.points)).map(([id]) => id);
  if (shortEndpointEdges.length) throw new Error(`连线首末接入段短于 ${ENDPOINT_SEGMENT_MIN}px：${shortEndpointEdges.join('、')}`);
  const finalScore = routeGraphScore(graph, routingPositions, result);
  if (finalScore[0] > 0) throw new Error('正交路由仍存在节点穿越或缺失路径。');
  if (!allowProvisional && finalScore[1] > .01) throw new Error('正交路由仍存在共线重叠。');
  return restoreRoutingOffset(result, normalized.offset);
}

// 四边端点只属于展示。平行边沿同一节点对的固定法线错开，反向不翻转偏移。
export function edgeGeometry(a, b, source, target, offset = 0) {
  if (source === target) return { path: `M${a.x + WIDTH},${a.y + HEIGHT / 2} C${a.x + WIDTH + 100},${a.y - 90 - offset} ${a.x + WIDTH / 2},${a.y - 90 - offset} ${a.x + WIDTH / 2},${a.y}`, labelX: a.x + WIDTH, labelY: a.y - 65 - offset };
  const dx = b.x - a.x, dy = b.y - a.y;
  const horizontal = Math.abs(dx) / WIDTH >= Math.abs(dy) / HEIGHT;
  const direction = (horizontal ? dx : dy) >= 0 ? 1 : -1;
  const nx = horizontal ? direction : 0, ny = horizontal ? 0 : direction;
  const x1 = a.x + WIDTH / 2 + nx * WIDTH / 2, y1 = a.y + HEIGHT / 2 + ny * HEIGHT / 2;
  const x2 = b.x + WIDTH / 2 - nx * WIDTH / 2, y2 = b.y + HEIGHT / 2 - ny * HEIGHT / 2;
  const length = Math.hypot(dx, dy) || 1, order = source < target ? 1 : -1;
  const ox = -dy / length * order * offset, oy = dx / length * order * offset;
  const control = Math.max(60, Math.hypot(x2 - x1, y2 - y1) * .5);
  const c1 = { x: x1 + nx * control + ox, y: y1 + ny * control + oy };
  const c2 = { x: x2 - nx * control + ox, y: y2 - ny * control + oy };
  return { path: `M${x1},${y1} C${c1.x},${c1.y} ${c2.x},${c2.y} ${x2},${y2}`,
    labelX: (x1 + 3 * c1.x + 3 * c2.x + x2) / 8, labelY: (y1 + 3 * c1.y + 3 * c2.y + y2) / 8 - 7 };
}

export function nodesInBox(nodes, positions, start, end) {
  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
  return nodes.filter(node => {
    const p = positions[node.id];
    return p.x <= right && p.x + WIDTH >= left && p.y <= bottom && p.y + HEIGHT >= top;
  }).map(node => node.id);
}
export function movePositions(positions, dx, dy) {
  const points = Object.values(positions);
  if (!points.length) return {};
  const clamp = (delta, key) => Math.max(-100000 - Math.min(...points.map(p => p[key])),
    Math.min(100000 - Math.max(...points.map(p => p[key])), Math.round(delta)));
  dx = clamp(dx, 'x'); dy = clamp(dy, 'y');
  return Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
}

export function snapPositions(positions) {
  const snap = value => Math.max(-100000, Math.min(100000, Math.round(value / SNAP_GRID) * SNAP_GRID));
  return Object.fromEntries(Object.entries(positions).map(([id, point]) => [id, { x: snap(point.x), y: snap(point.y) }]));
}

function translatedPort(port, positions, previousPositions) {
  const current = positions[port.nodeId], previous = previousPositions[port.nodeId];
  if (!current || !previous) return port;
  const dx = current.x - previous.x, dy = current.y - previous.y;
  return { ...port, port: { x: port.port.x + dx, y: port.port.y + dy },
    anchor: { x: port.anchor.x + dx, y: port.anchor.y + dy } };
}

export function incrementalEdgeGeometry(edge, positions, previousPositions, cached, offset = 0) {
  const sourcePosition = positions[edge.source], targetPosition = positions[edge.target];
  if (edge.source === edge.target) return edgeGeometry(sourcePosition, targetPosition, edge.source, edge.target, offset);
  if (!cached?.sourcePort || !cached?.targetPort) return edgeGeometry(sourcePosition, targetPosition, edge.source, edge.target, offset);
  const source = translatedPort(cached.sourcePort, positions, previousPositions);
  const target = translatedPort(cached.targetPort, positions, previousPositions);
  const unchanged = samePoint(source.port, cached.sourcePort.port) && samePoint(target.port, cached.targetPort.port);
  if (unchanged) return cached;
  const rawCandidates = [
    [source.port, source.anchor, { x: target.anchor.x, y: source.anchor.y }, target.anchor, target.port],
    [source.port, source.anchor, { x: source.anchor.x, y: target.anchor.y }, target.anchor, target.port],
    [source.port, source.anchor, { x: source.anchor.x + ENDPOINT_SEGMENT_MIN, y: source.anchor.y },
      { x: source.anchor.x + ENDPOINT_SEGMENT_MIN, y: target.anchor.y }, target.anchor, target.port],
    [source.port, source.anchor, { x: source.anchor.x - ENDPOINT_SEGMENT_MIN, y: source.anchor.y },
      { x: source.anchor.x - ENDPOINT_SEGMENT_MIN, y: target.anchor.y }, target.anchor, target.port],
  ];
  const candidates = rawCandidates.map(points => normalizeRoute(points)).filter(points => routeEndpointSegmentsValid(points))
    .sort((a, b) => routeBends(a) - routeBends(b) || routeLength(a) - routeLength(b));
  const points = candidates[0];
  if (!points) throw new Error(`拖动预览无法保留 ${ENDPOINT_SEGMENT_MIN}px 的首末接入段：${edge.id}`);
  return { path: roundedPath(points), points, sourcePort: source, targetPort: target, ...routeLabel(points) };
}

export class GraphCanvas {
  constructor(root, callbacks, { readOnly = false, includeRelationInHover = false } = {}) {
    this.root = root; this.callbacks = callbacks; this.camera = { x: 50, y: 80, scale: 1 };
    this.readOnly = readOnly;
    this.includeRelationInHover = includeRelationInHover;
    this.graph = { nodes: [], edges: [] }; this.positions = {}; this.mode = 'select'; this.space = false;
    this.routed = new Map(); this.routeArchive = new Map(); this.nodeElements = new Map(); this.edgeElements = new Map(); this.geometryKey = null;
    this.tooltip = root.parentElement?.querySelector('#canvas-tooltip') ?? null;
    this.tooltipsEnabled = true;
    this.tooltipPointer = null;
    root.addEventListener('wheel', event => {
      event.preventDefault(); const rect = root.getBoundingClientRect();
      this.zoom(Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    root.addEventListener('pointerdown', event => this.down(event));
    root.addEventListener('pointermove', event => { this.move(event); this.moveTooltip(event); });
    root.addEventListener('pointerover', event => this.showTooltip(event));
    root.addEventListener('pointerout', event => this.hideTooltip(event));
    root.addEventListener('pointerup', event => this.up(event));
    root.addEventListener('pointercancel', () => this.cancel());
    root.addEventListener('lostpointercapture', () => { if (this.gesture) this.cancel(); });
    root.addEventListener('contextmenu', event => event.preventDefault());
    root.addEventListener('keydown', event => {
      if (this.readOnly) return;
      if (event.key !== 'Enter') return;
      const node = event.target.closest('[data-node]');
      if (node) { event.preventDefault(); this.pick(node.dataset.node); }
      const edge = event.target.closest('[data-edge]');
      if (edge) { event.preventDefault(); this.callbacks.select({ type: 'edge', id: edge.dataset.edge }); }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.cancel();
      if (event.code === 'Space' && !event.target.closest('input,textarea,select,dialog,button')) { event.preventDefault(); this.space = true; }
    });
    document.addEventListener('keyup', event => { if (event.code === 'Space') this.space = false; });
    window.addEventListener('blur', () => { this.space = false; this.cancel(); });
  }
  tooltipTarget(event) { return event.target?.closest?.('[data-node],[data-edge]') ?? null; }
  setTooltipsEnabled(enabled) {
    this.tooltipsEnabled = Boolean(enabled);
    if (!this.tooltipsEnabled) {
      if (this.tooltip) this.tooltip.hidden = true;
      return;
    }
    if (this.tooltipPointer) this.showTooltip(this.tooltipPointer);
  }
  showTooltip(event) {
    this.tooltipPointer = {
      target: event.target,
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (!this.tooltipsEnabled || event.pointerType && event.pointerType !== 'mouse') return;
    const target = this.tooltipTarget(event), text = target?.dataset.tooltip?.trim();
    if (!this.tooltip || !text) return;
    this.tooltip.textContent = text; this.tooltip.hidden = false; this.moveTooltip(event);
  }
  hideTooltip(event) {
    if (!this.tooltip || event.pointerType && event.pointerType !== 'mouse') return;
    if (this.tooltipTarget(event) === this.tooltipTarget({ target: event.relatedTarget })) return;
    this.tooltipPointer = null;
    this.tooltip.hidden = true;
  }
  moveTooltip(event) {
    if (!this.tooltip || this.tooltip.hidden) return;
    const rect = this.root.getBoundingClientRect(), margin = 14;
    const left = Math.min(Math.max(margin, event.clientX - rect.left + margin), Math.max(margin, this.root.clientWidth - this.tooltip.offsetWidth - margin));
    const top = Math.min(Math.max(margin, event.clientY - rect.top + margin), Math.max(margin, this.root.clientHeight - this.tooltip.offsetHeight - margin));
    this.tooltip.style.left = `${left}px`; this.tooltip.style.top = `${top}px`;
  }
  update(graph, positions, activeId, selection, definitionMode, { preserveRoutes = false, deferRouting = false, structuralPresentation = 'line', tagDefinitions = [], nodeColors = {}, nodeStyles = {} } = {}) {
    this.tagDefinitions = tagDefinitions;
    this.nodeColors = nodeColors;
    this.nodeStyles = nodeStyles;
    const pendingMove = this.pendingMove, previousGraph = this.graph, previousPositions = this.positions;
    const nextKey = graphGeometryKey(graph, positions), geometryChanged = nextKey !== this.geometryKey;
    this.pendingMove = null;
    this.routed ??= new Map();
    this.routeArchive ??= new Map();
    if (preserveRoutes) for (const [id, route] of this.routed) this.routeArchive.set(id, route);
    else this.routeArchive.clear();
    this.graph = graph; this.positions = positions; this.activeId = activeId; this.selection = selection; this.definitionMode = definitionMode; this.structuralPresentation = structuralPresentation;
    const primed = this.primedRoutes?.key === nextKey ? this.primedRoutes.routes : null;
    if (primed) this.routed = primed;
    this.primedRoutes = null;
    if (deferRouting && !primed) this.hideUnroutedEdges = true;
    else if (primed || !deferRouting) this.hideUnroutedEdges = false;
    if (preserveRoutes && !primed) {
      const preserved = new Map(graph.edges.flatMap(edge => {
        const route = this.routeArchive.get(edge.id);
        return route ? [[edge.id, route]] : [];
      }));
      this.routed = preserved;
    }
    if (primed) { this.unsettledRouteIds = new Set(); this.routingErrorMessage = null; }
    else if (geometryChanged && !preserveRoutes) {
      this.unsettledRouteIds = new Set(affectedRouteIds(graph, positions, this.routed, pendingMove?.ids ?? []));
    }
    this.geometryKey = nextKey; this.draw({ reroute: false });
    if (!graph.edges.length) { this.routed = new Map(); return Promise.resolve(true); }
    // settled commit 正在旧 routingPromise 的 then 中消费预置帧；这里必须立即结束，
    // 不能把旧 Promise 返回给它自身，否则会形成等待环并让页面永久处于计算中。
    if (primed) return Promise.resolve(true);
    // 视图显隐只投影已经生成的节点与连线。几何签名必然会随可见集合改变，
    // 但这不代表布局或端口发生了编辑；禁止因此启动 Worker 和再次执行间距切分。
    if (preserveRoutes) return Promise.resolve(true);
    // 打开文件先显示稳定的节点；缺失的路线只在后台补齐，且固定节点坐标，
    // 绝不能让“打开”成为一次隐式整理或以临时连线制造画面跳动。
    if (deferRouting) {
      queueMicrotask(() => {
        if (this.geometryKey === nextKey) void this.requestRouting(nextKey, pendingMove?.ids, { fixedPositions: true, persistRouteCache: 'background' });
      });
      return Promise.resolve(true);
    }
    if (!primed && geometryChanged) return this.requestRouting(nextKey, pendingMove?.ids, { previousPositions });
    return this.routingPromise ?? Promise.resolve(true);
  }
  primeRoutes(graph, positions, routes) {
    this.primedRoutes = routes ? { key: graphGeometryKey(graph, positions), routes } : null;
  }
  requestRouting(geometryKey, movedIds = [], { fixedPositions = false, persistRouteCache = movedIds.length > 0, previousPositions = this.positions } = {}) {
    if (typeof this.callbacks.computeGraph !== 'function') return Promise.resolve(false);
    const payload = { graph: this.graph, positions: this.positions, previousPositions, cachedRoutes: [...this.routed], movedIds, fixedPositions };
    const promise = this.callbacks.computeGraph({ kind: 'route', geometryKey, payload,
      isCurrent: () => this.geometryKey === geometryKey })
      .then(result => {
        if (this.geometryKey !== geometryKey) return false;
        if (typeof this.callbacks.commitGeometry === 'function') {
          return this.callbacks.commitGeometry({ baseGeometryKey: geometryKey, persistRouteCache, ...result });
        }
        this.routed = new Map(result.routes); this.lastRouting = { edgeIds: result.edgeIds, full: result.full };
        this.unsettledRouteIds = new Set();
        for (const [id, route] of this.routed) this.routeArchive.set(id, route);
        this.routingErrorMessage = null; this.draw({ reroute: false }); return true;
      })
      .catch(error => {
        if (error?.name === 'AbortError' || error?.code === 'COMPUTE_CANCELLED') return false;
        if (this.geometryKey !== geometryKey) return false;
        if (this.routingErrorMessage !== error.message) {
          this.routingErrorMessage = error.message; this.callbacks.routeError?.(error);
        }
        return false;
      });
    this.routingPromise = promise; return promise;
  }
  setMode(mode) { this.cancel(); this.mode = mode; this.linkSource = null; this.root.classList.toggle('linking', mode !== 'select'); this.draw({ reroute: false }); }
  selectedIds() { return this.selection?.type === 'nodes' ? this.selection.ids : this.selection?.type === 'node' ? [this.selection.id] : []; }
  selectNodes(ids) { this.callbacks.select(ids.length === 1 ? { type: 'node', id: ids[0] } : ids.length ? { type: 'nodes', ids } : null); }
  cancel() {
    this.linkSource = null; this.lastClick = null;
    const gesture = this.gesture; if (!gesture) return;
    this.gesture = null;
    if (gesture.type === 'pan') this.camera = gesture.original;
    if (this.root.hasPointerCapture(gesture.pointerId)) this.root.releasePointerCapture(gesture.pointerId);
    this.root.classList.remove('panning');
    if (gesture.type === 'nodes') { this.renderIncremental(gesture.ids, this.positions, this.positions); this.transform(); }
    else this.draw({ reroute: false });
  }
  point(event) {
    const rect = this.root.getBoundingClientRect(), { x, y, scale } = this.camera;
    return { x: (event.clientX - rect.left - x) / scale, y: (event.clientY - rect.top - y) / scale };
  }
  down(event) {
    if (this.gesture || ![0, 1, 2].includes(event.button)) return;
    // 对话 widget 复用同一画布投影，但只允许平移与缩放，绝不进入选中、连线或位置写入路径。
    if (this.readOnly) {
      event.preventDefault();
      this.gesture = { type: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, original: { ...this.camera }, moved: false };
      this.root.setPointerCapture(event.pointerId); this.root.classList.add('panning'); return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) { this.lastClick = null; return; }
    const node = event.target.closest('[data-node]'), edge = event.target.closest('[data-edge]');
    if (event.button === 2 || event.button === 1 || this.space) {
      this.lastClick = null;
      event.preventDefault(); this.gesture = { type: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, original: { ...this.camera }, moved: false };
      this.root.setPointerCapture(event.pointerId); this.root.classList.add('panning'); return;
    }
    if (!node && !edge) {
      if (this.mode !== 'select') return;
      event.preventDefault();
      // 普通空白拖动是最直接的画布平移；按住 Shift 才进入框选，避免图已显示却看似“不能拖动”。
      if (!event.shiftKey) {
        this.gesture = { type: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, original: { ...this.camera },
          clearSelectionOnClick: true, moved: false };
        this.root.setPointerCapture(event.pointerId); this.root.classList.add('panning'); return;
      }
      this.gesture = { type: 'box', point: this.point(event), end: this.point(event), x: event.clientX, y: event.clientY,
        pointerId: event.pointerId, original: [...this.selectedIds()], additive: true, moved: false };
      this.root.setPointerCapture(event.pointerId); return;
    }
    if (node) {
      const id = node.dataset.node;
      if (this.mode !== 'select') { event.preventDefault(); this.pick(id); return; }
      const selected = this.selectedIds();
      if (event.shiftKey) { this.lastClick = null; this.selectNodes(selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]); return; }
      const ids = selected.includes(id) ? selected : [id];
      this.selectNodes(ids);
      if (ids.every(item => this.callbacks.canMove(item))) {
        event.preventDefault(); this.gesture = { type: 'nodes', ids, pointerId: event.pointerId, point: this.point(event),
          x: event.clientX, y: event.clientY, original: Object.fromEntries(ids.map(item => [item, { ...this.positions[item] }])), moved: false };
        this.root.setPointerCapture(event.pointerId);
      }
    } else if (edge) { this.lastClick = null; this.callbacks.select({ type: 'edge', id: edge.dataset.edge }); }
  }
  move(event) {
    const gesture = this.gesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.moved ||= Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 3;
    if (gesture.type === 'pan') {
      if (!gesture.moved) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      this.camera.x = gesture.original.x + dx; this.camera.y = gesture.original.y + dy; this.transform();
    } else if (gesture.type === 'box') {
      gesture.end = this.point(event); this.draw({ reroute: false });
    } else {
      const point = this.point(event), dx = point.x - gesture.point.x, dy = point.y - gesture.point.y;
      gesture.next = movePositions(gesture.original, dx, dy);
      this.renderIncremental(gesture.ids, { ...this.positions, ...gesture.next }, this.positions);
    }
  }
  up(event) {
    const gesture = this.gesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.move(event);
    this.gesture = null; this.root.classList.remove('panning');
    if (this.root.hasPointerCapture(event.pointerId)) this.root.releasePointerCapture(event.pointerId);
    let positionCommitted = false;
    if (gesture.type === 'nodes' && gesture.moved && gesture.ids.every(id => this.graph.nodes.some(node => node.id === id) && this.callbacks.canMove(id))) {
      const committed = this.callbacks.snapEnabled?.() ? snapPositions(gesture.next) : gesture.next;
      this.pendingMove = { ids: [...gesture.ids] };
      this.callbacks.move(committed); positionCommitted = true;
    }
    else if (gesture.type === 'box' && gesture.moved) this.selectNodes([...new Set([...gesture.original, ...nodesInBox(this.graph.nodes, this.positions, gesture.point, gesture.end)])]);
    else if (gesture.type === 'pan' && gesture.clearSelectionOnClick && !gesture.moved) this.selectNodes([]);
    const blankPrimaryClick = gesture.type === 'pan' && gesture.clearSelectionOnClick && !gesture.moved;
    if (!gesture.moved && ((gesture.type === 'nodes' && gesture.ids.length === 1) || (gesture.type === 'box' && !gesture.additive) || blankPrimaryClick)) {
      const id = gesture.type === 'nodes' ? gesture.ids[0] : null, now = performance.now(), previous = this.lastClick;
      this.lastClick = { id, time: now, x: event.clientX, y: event.clientY };
      if (previous && previous.id === id && now - previous.time <= 400 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 5) {
        this.lastClick = null;
        if (id === null) this.callbacks.blankDoubleClick?.(); else this.callbacks.quickLink?.(id);
      }
    } else this.lastClick = null;
    if (!positionCommitted) this.draw({ reroute: false });
  }
  pick(id) {
    if (this.mode === 'select') { this.callbacks.select({ type: 'node', id }); return; }
    if (!this.linkSource) { this.linkSource = id; this.callbacks.hint('现在点击目标节点 · Esc 取消连线'); this.draw({ reroute: false }); }
    else if (this.linkSource === id) {
      this.linkSource = null; this.callbacks.cancelLink?.(); this.draw({ reroute: false });
    }
    else {
      const source = this.linkSource;
      const relation = this.mode === 'specializes' ? 'specializes' : this.mode === 'positive' ? 1 : this.mode === 'negative' ? -1 : 'random';
      if (this.callbacks.link(source, id, relation)) this.linkSource = null;
      this.draw({ reroute: false });
    }
  }
  zoom(factor, x = this.root.clientWidth / 2, y = this.root.clientHeight / 2) {
    if (this.gesture) return;
    const old = this.camera.scale, next = Math.max(.15, Math.min(2.5, old * factor));
    this.camera.x = x - (x - this.camera.x) * next / old;
    this.camera.y = y - (y - this.camera.y) * next / old;
    this.camera.scale = next; this.transform();
  }
  fit() {
    if (this.gesture) return;
    const points = this.graph.nodes.map(node => this.positions[node.id]);
    if (!points.length) return;
    const minX = Math.min(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y));
    const width = Math.max(...points.map(p => p.x)) + WIDTH - minX, height = Math.max(...points.map(p => p.y)) + HEIGHT - minY;
    const availableWidth = Math.max(200, this.root.clientWidth - 100), availableHeight = Math.max(200, this.root.clientHeight - 100);
    const scale = Math.max(.15, Math.min(1.2, availableWidth / width, availableHeight / height));
    this.camera = { scale, x: (this.root.clientWidth - width * scale) / 2 - minX * scale,
      y: (this.root.clientHeight - height * scale) / 2 - minY * scale };
    this.transform();
  }
  center() { return this.point({ clientX: this.root.getBoundingClientRect().left + this.root.clientWidth * .45, clientY: this.root.getBoundingClientRect().top + this.root.clientHeight * .4 }); }
  transform() {
    this.world?.setAttribute('transform', `translate(${this.camera.x} ${this.camera.y}) scale(${this.camera.scale})`);
    this.callbacks.zoom(Math.round(this.camera.scale * 100));
  }
  renderIncremental(ids, positions, previousPositions = this.positions) {
    if (!this.nodeElements || !this.edgeElements) return;
    const affected = new Set(ids);
    for (const id of ids) {
      const element = this.nodeElements.get(id), point = positions[id];
      if (element && point) element.setAttribute('transform', `translate(${point.x} ${point.y})`);
    }
    const parallel = new Map();
    for (const edge of this.graph.edges) {
      const key = [edge.source, edge.target].sort().join('/');
      if (!parallel.has(key)) parallel.set(key, []); parallel.get(key).push(edge.id);
    }
    for (const members of parallel.values()) members.sort();
    for (const edge of this.graph.edges) {
      if (!affected.has(edge.source) && !affected.has(edge.target)) continue;
      const elements = this.edgeElements.get(edge.id); if (!elements) continue;
      const siblings = parallel.get([edge.source, edge.target].sort().join('/'));
      const offset = (siblings.indexOf(edge.id) - (siblings.length - 1) / 2) * 34;
      const geometry = incrementalEdgeGeometry(edge, positions, previousPositions, this.routed.get(edge.id), offset);
      elements.hit.setAttribute('d', geometry.path); elements.line.setAttribute('d', geometry.path);
      elements.label.setAttribute('x', geometry.labelX); elements.label.setAttribute('y', geometry.labelY);
    }
  }
  draw({ reroute = false } = {}) {
    this.root.replaceChildren();
    const defs = svg('defs');
    for (const [id, fill] of [['positive', '#328577'], ['negative', '#bd7064'], ['random', '#8b6fb3'], ['specializes', '#c49a26'], ['empty-rule', '#9a9fa6']]) {
      const marker = svg('marker', { id, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
      marker.append(svg('path', { d: 'M0,0 L7,3.5 L0,7 Z', fill })); defs.append(marker);
    }
    this.world = svg('g'); this.root.append(defs, this.world);
    const positions = { ...this.positions };
    if (this.gesture?.type === 'nodes' && this.gesture.next) Object.assign(positions, this.gesture.next);
    const routed = this.routed;
    this.nodeElements = new Map(); this.edgeElements = new Map();
    const projection = structuralProjection(this.graph, this.structuralPresentation);
    const parallel = new Map();
    for (const edge of projection.edges) {
      const key = [edge.source, edge.target].sort().join('/');
      if (!parallel.has(key)) parallel.set(key, []); parallel.get(key).push(edge.id);
    }
    for (const ids of parallel.values()) ids.sort();
    for (const edge of projection.edges) {
      // 松手后的旧线不能充当新坐标下的正式路线；失败时继续隐藏并显示错误。
      if (this.unsettledRouteIds?.has(edge.id)) continue;
      const a = positions[edge.source], b = positions[edge.target]; if (!a || !b) continue;
      const siblings = parallel.get([edge.source, edge.target].sort().join('/'));
      const offset = (siblings.indexOf(edge.id) - (siblings.length - 1) / 2) * 34;
      let geometry = edge.source === edge.target ? edgeGeometry(a, b, edge.source, edge.target, offset) : routed.get(edge.id);
      if (!geometry) {
        // 初次打开没有缓存时，宁可暂不显示边，也不能先画一套临时折线再跳成
        // 严格路线。其它编辑态仍保留即时折线反馈。
        if (this.hideUnroutedEdges) continue;
        geometry = edgeGeometry(a, b, edge.source, edge.target, offset);
      }
      if (geometry.points) geometry = { ...geometry, path: roundedPath(geometry.points), ...routeLabel(geometry.points) };
      const { path, labelX, labelY } = geometry;
      const sign = edge.relation === 'specializes' ? 'specializes' : edge.sign === 1 ? 'positive' : edge.sign === -1 ? 'negative' : 'random';
      const appearance = hasRuleText(edge) ? sign : 'empty-rule';
      const selected = this.selection?.type === 'edge' && this.selection.id === edge.id;
      const relationName = sign === 'specializes' ? '特化 / 是某种' : sign === 'positive' ? '正向影响' : sign === 'negative' ? '负向影响' : '随机影响';
      const qualifierText = (qualifiers, side) => (qualifiers?.length ? `；${side}限定：${qualifiers.map(item => `${item.key}=${item.value.kind === 'concept' ? this.callbacks.name(item.value.conceptId) : String(item.value.value)}`).join('，')}` : '');
      const group = svg('g', { 'data-edge': edge.id, tabindex: 0, role: 'button', 'aria-label': `${this.callbacks.name(edge.source)}${qualifierText(edge.sourceQualifiers, '源')} ${relationName} ${this.callbacks.name(edge.target)}${qualifierText(edge.targetQualifiers, '目标')}` });
      const rules = edge.steps?.length ? edge.steps : [edge];
      const tooltipText = edgeHoverDetail({ ...edge, ruleText: rules.map(rule => rule.ruleText).filter(text => text?.trim()).join('\n\n') }, this.callbacks.name, { includeRelation: Boolean(this.includeRelationInHover) });
      if (tooltipText) group.setAttribute('data-tooltip', tooltipText);
      const hit = svg('path', { d: path, class: 'edge-hit' });
      const line = svg('path', { d: path, class: `edge-line edge-${appearance} ${selected ? 'selected' : ''}`, 'marker-end': `url(#${appearance})`, 'pointer-events': 'none' });
      group.append(hit, line);
      const label = svg('text', { x: labelX, y: labelY, class: `edge-label ${appearance}` });
      // 连线类型符号统一为字符体系（与工具栏、图例、检查器一致）：＋ 正向、− 负向、？ 随机、is-a 特化 / 是某种
      label.textContent = sign === 'specializes' ? 'is-a' : edge.sign === 1 ? '＋' : edge.sign === -1 ? '−' : '？'; group.append(label); this.world.append(group);
      this.edgeElements.set(edge.id, { group, hit, line, label });
    }
    // 节点角色只从当前文件的本地连线派生，不写入 canonical，也不让引用连线改变角色。
    const directions = new Map(projection.nodes.map(node => [node.id, { incoming: false, outgoing: false }]));
    const isLocalEdge = edge => this.activeId === null || (edge.steps.length === 1 && edge.steps[0].graphId === this.activeId);
    for (const edge of projection.edges) {
      if (!isLocalEdge(edge) || edge.source === edge.target) continue;
      const sourceDirection = directions.get(edge.source), targetDirection = directions.get(edge.target);
      if (sourceDirection) sourceDirection.outgoing = true;
      if (targetDirection) targetDirection.incoming = true;
    }
    const tagLookup = new Map((this.tagDefinitions ?? []).map(tag => [tag.id.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase(), tag]));
    for (const node of projection.nodes) {
      const point = positions[node.id];
      const selected = this.selectedIds().includes(node.id);
      const direction = directions.get(node.id);
      const role = direction?.outgoing && !direction.incoming ? 'node-start' : direction?.incoming && !direction.outgoing ? 'node-end' : '';
      const roleLabel = role === 'node-start' ? '，起点' : role === 'node-end' ? '，终点' : '';
      const nodeColor = this.nodeColors?.[node.id];
      const colorClass = nodeColor ? `node-color-${nodeColor.slice(1).toLowerCase()}` : '';
      const styleClass = this.nodeStyles?.[node.id] === 'transparent-dashed' ? 'node-style-transparent-dashed' : '';
      const group = svg('g', { 'data-node': node.id, transform: `translate(${point.x} ${point.y})`, class: `node ${selected ? 'selected' : ''} ${this.linkSource === node.id ? 'link-source' : ''} ${role} ${colorClass} ${styleClass}`, tabindex: 0, role: 'button', 'aria-label': node.label + roleLabel });
      const tooltipText = nodeHoverDetail(node);
      if (tooltipText) group.setAttribute('data-tooltip', tooltipText);
      const label = svg('text', { x: 16, y: 27 }); label.textContent = node.label.length > 10 ? `${node.label.slice(0, 10)}…` : node.label;
      const meta = svg('text', { x: 16, y: 45, class: 'node-meta' });
      meta.textContent = this.definitionMode ? node.id.slice(0, 23) : '';
      group.append(svg('rect', { width: WIDTH, height: HEIGHT, rx: 7 }), label, meta);
      const nodeTags = (node.tagIds ?? []).map(id => tagLookup.get(id.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase())).filter(Boolean);
      for (const [index, tag] of nodeTags.slice(0, 6).entries()) {
        const dot = svg('circle', { cx: 20 + index * 10, cy: 43, r: 3.2, style: `fill:${tag.color};stroke:none`, 'pointer-events': 'none' });
        const title = svg('title'); title.textContent = tag.displayName; dot.append(title); group.append(dot);
      }
      const badgeModel = badgeDisplayModel(node.badges, this.structuralPresentation);
      const visibleNodeIds = new Set(projection.nodes.map(item => item.id));
      for (const [index, badge] of badgeModel.badges.entries()) {
        const targetId = badgeInteractionTargetId(badge, visibleNodeIds);
        const badgeElement = svg('text', { x: 16, y: 58 + index * 12, class: 'node-badge', 'aria-label': badge.accessibleText });
        if (targetId) {
          badgeElement.setAttribute('tabindex', '0'); badgeElement.setAttribute('role', 'button');
          badgeElement.addEventListener('click', event => { event.stopPropagation(); this.callbacks.select({ type: 'node', id: targetId }); });
        }
        badgeElement.textContent = badge.kind === 'is-a' ? badge.displayText : (badge.displayText.length > 22 ? badge.displayText.slice(0, 21) + '…' : badge.displayText);
        const badgeTitle = svg('title'); badgeTitle.textContent = badge.accessibleText; badgeElement.append(badgeTitle);
        group.append(badgeElement);
      }
      this.world.append(group); this.nodeElements.set(node.id, group);
    }
    if (this.gesture?.type === 'box' && this.gesture.moved) {
      const { point, end } = this.gesture;
      this.world.append(svg('rect', { x: Math.min(point.x, end.x), y: Math.min(point.y, end.y),
        width: Math.abs(end.x - point.x), height: Math.abs(end.y - point.y), class: 'selection-box', 'pointer-events': 'none' }));
    }
    this.transform();
  }
}
