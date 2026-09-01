const svg = (tag, attributes = {}) => {
  const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value);
  return item;
};
const WIDTH = 166, HEIGHT = 62;
const ROUTE_PADDING = 24;
const ROUTE_NUDGE = 8;
const ROUTE_READABLE_GAP = 48;
const ROUTE_CORNER = 12;
const PORT_MARGIN = 12;
const PORT_GAP = 12;
const PORT_ANCHOR_DISTANCE = ROUTE_PADDING + 12;
const PORT_ESCAPE_GAP = ROUTE_NUDGE;
const EXTERIOR_SPAN = WIDTH * 5;
const EXTERIOR_LANE_GAP = 18;
const SIDES = ['right', 'bottom', 'left', 'top'];
const SIDE_VECTOR = {
  right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, top: { x: 0, y: -1 },
};

const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rounded = value => Math.round(value * 100) / 100;

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

function exteriorEdges(graph, positions) {
  const points = graph.nodes.map(node => positions[node.id]).filter(finitePoint);
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y + HEIGHT));
  const corridorClear = (nodeId, otherId, side) => {
    const own = positions[nodeId], other = positions[otherId];
    const offset = clamp(other.x + WIDTH / 2 - own.x, PORT_MARGIN, WIDTH - PORT_MARGIN);
    const x = own.x + offset;
    const start = side === 'top' ? minY - ROUTE_PADDING - EXTERIOR_LANE_GAP : own.y + HEIGHT;
    const end = side === 'top' ? own.y : maxY + ROUTE_PADDING + EXTERIOR_LANE_GAP;
    const low = Math.min(start, end), high = Math.max(start, end);
    return !graph.nodes.some(node => {
      if (node.id === nodeId) return false;
      const point = positions[node.id];
      return x > point.x - ROUTE_PADDING && x < point.x + WIDTH + ROUTE_PADDING
        && low < point.y + HEIGHT + ROUTE_PADDING && high > point.y - ROUTE_PADDING;
    });
  };
  const result = new Map();
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    const source = positions[edge.source], target = positions[edge.target];
    if (Math.abs(target.x - source.x) < EXTERIOR_SPAN) continue;
    const left = Math.min(source.x, target.x), right = Math.max(source.x, target.x);
    const corridorTop = Math.min(source.y + HEIGHT / 2, target.y + HEIGHT / 2);
    const corridorBottom = Math.max(source.y + HEIGHT / 2, target.y + HEIGHT / 2);
    const intervening = graph.nodes.filter(node => node.id !== edge.source && node.id !== edge.target)
      .filter(node => {
        const point = positions[node.id], center = point.x + WIDTH / 2;
        return center > left + WIDTH && center < right
          && point.y + HEIGHT + ROUTE_PADDING > corridorTop && point.y - ROUTE_PADDING < corridorBottom;
      }).length;
    if (intervening < 2) continue;
    const topCost = source.y - minY + target.y - minY;
    const bottomCost = maxY - source.y - HEIGHT + maxY - target.y - HEIGHT;
    const candidates = topCost <= bottomCost ? ['top', 'bottom'] : ['bottom', 'top'];
    const side = candidates.find(candidate => corridorClear(edge.source, edge.target, candidate)
      && corridorClear(edge.target, edge.source, candidate));
    if (side) result.set(edge.id, side);
  }
  return { sides: result, minY, maxY };
}

function compareTuple(a, b) {
  for (let index = 0; index < a.length; index++) if (Math.abs(a[index] - b[index]) > .0001) return a[index] - b[index];
  return 0;
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

// 一个节点的全部入边和出边共同竞争四侧端口；先使用负载更低的可行侧，再比较拐点和方向。
export function assignEdgePorts(graph, positions) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target);
  const exterior = exteriorEdges(graph, positions).sides;
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
  const assignments = new Map(edges.map(edge => [edge.id, {}]));
  const loads = new Map(graph.nodes.map(node => [node.id, Object.fromEntries(SIDES.map(side => [side, 0]))]));
  const alignment = (incident, side) => incident.dx * SIDE_VECTOR[side].x + incident.dy * SIDE_VECTOR[side].y;
  const expectedBends = (edge, sourceSide, targetSide) => {
    const source = positions[edge.source], target = positions[edge.target];
    const horizontal = Math.abs(source.y - target.y) < .01
      && ((sourceSide === 'right' && targetSide === 'left' && source.x < target.x)
        || (sourceSide === 'left' && targetSide === 'right' && source.x > target.x));
    const vertical = Math.abs(source.x - target.x) < .01
      && ((sourceSide === 'bottom' && targetSide === 'top' && source.y < target.y)
        || (sourceSide === 'top' && targetSide === 'bottom' && source.y > target.y));
    if (horizontal || vertical) return 0;
    const sourceVector = SIDE_VECTOR[sourceSide], targetVector = SIDE_VECTOR[targetSide];
    return sourceVector.x * targetVector.x + sourceVector.y * targetVector.y === 0 ? 1 : 2;
  };
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const sourceIncident = incidentByEdge.get(edge.id).source, targetIncident = incidentByEdge.get(edge.id).target;
    const forced = exterior.get(edge.id);
    const sourceSides = forced ? [forced] : SIDES.filter(side => alignment(sourceIncident, side) >= -.0001);
    const targetSides = forced ? [forced] : SIDES.filter(side => alignment(targetIncident, side) >= -.0001);
    const candidates = [];
    for (const sourceSide of sourceSides) for (const targetSide of targetSides) {
      const sourceLoad = loads.get(edge.source)[sourceSide], targetLoad = loads.get(edge.target)[targetSide];
      const preferred = Number(!sourceIncident.preferredSides.includes(sourceSide)) + Number(!targetIncident.preferredSides.includes(targetSide));
      const directionLoss = 2 - alignment(sourceIncident, sourceSide) - alignment(targetIncident, targetSide);
      candidates.push({ sourceSide, targetSide, score: [
        expectedBends(edge, sourceSide, targetSide), sourceLoad + targetLoad, preferred, directionLoss,
        SIDES.indexOf(sourceSide), SIDES.indexOf(targetSide),
      ] });
    }
    candidates.sort((a, b) => compareTuple(a.score, b.score));
    const choice = candidates[0];
    assignments.get(edge.id).source = { side: choice.sourceSide, nodeId: edge.source, otherId: edge.target, exterior: Boolean(forced) };
    assignments.get(edge.id).target = { side: choice.targetSide, nodeId: edge.target, otherId: edge.source, exterior: Boolean(forced) };
    loads.get(edge.source)[choice.sourceSide]++; loads.get(edge.target)[choice.targetSide]++;
  }
  // 面确定后、端口坐标生成前做局部均衡；端口一旦进入正式布线阶段便不再换面。
  for (const node of graph.nodes) {
    const nodeLoads = loads.get(node.id), list = incidents.get(node.id);
    for (let step = 0; step < list.length * SIDES.length; step++) {
      const moves = list.flatMap(incident => {
        const endpoint = assignments.get(incident.edge.id)[incident.role];
        if (endpoint.exterior) return [];
        const sideIndex = SIDES.indexOf(endpoint.side);
        const adjacent = [SIDES[(sideIndex + 1) % SIDES.length], SIDES[(sideIndex + SIDES.length - 1) % SIDES.length]];
        const current = assignments.get(incident.edge.id);
        const currentBends = expectedBends(incident.edge, current.source.side, current.target.side);
        return adjacent.filter(side => alignment(incident, side) >= -.0001
          && nodeLoads[endpoint.side] - nodeLoads[side] > 2)
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
      const offsets = distributedOffsets(members, side, positions);
      members.forEach((incident, index) => {
        const assignment = assignments.get(incident.edge.id)[incident.role];
        assignment.port = endpointPoint(positions[node.id], side, offsets[index]);
        assignment.anchor = anchorPoint(assignment.port, side, index);
        assignment.slot = index;
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
  return { x: [...x].sort((a, b) => a - b), y: [...y].sort((a, b) => a - b) };
}

function validRouteCandidate(graph, positions, edge, assignment, points) {
  if (!points?.length || !samePoint(points[0], assignment.source.port) || !samePoint(points.at(-1), assignment.target.port)) return false;
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

function candidateRoutes(graph, positions, edge, assignment, axes, extra = []) {
  const source = assignment.source, target = assignment.target, start = source.anchor, end = target.anchor;
  const candidates = [], seen = new Set();
  const add = raw => {
    let points;
    try { points = normalizeRoute(raw); } catch { return; }
    if (!validRouteCandidate(graph, positions, edge, assignment, points)) return;
    const key = points.map(point => `${point.x},${point.y}`).join(';');
    if (seen.has(key)) return; seen.add(key); candidates.push(points);
  };
  const wrap = internal => add([source.port, ...internal, target.port]);
  if (start.x === end.x || start.y === end.y) wrap([start, end]);
  wrap([start, { x: end.x, y: start.y }, end]);
  wrap([start, { x: start.x, y: end.y }, end]);
  for (const x of axes.x) wrap([start, { x, y: start.y }, { x, y: end.y }, end]);
  for (const y of axes.y) wrap([start, { x: start.x, y }, { x: end.x, y }, end]);
  const direct = directPortRoute(graph, positions, edge, assignment); if (direct) add(direct);
  for (const points of extra) add(points);
  const sorted = candidates.sort((a, b) => compareTuple([routeBends(a), routeLength(a)], [routeBends(b), routeLength(b)])
    || a.map(point => `${point.x},${point.y}`).join(';').localeCompare(b.map(point => `${point.x},${point.y}`).join(';')));
  const extremes = new Set([axes.x[0], axes.x.at(-1), axes.y[0], axes.y.at(-1)]);
  return sorted.filter((points, index) => index < 48 || points.some(point => extremes.has(point.x) || extremes.has(point.y))).slice(0, 80);
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
  let hard = 0, shared = 0, crossings = 0, near = 0, bends = 0, maxBends = 0, length = 0, bendCrowding = 0;
  const bendPoints = [];
  for (const edge of edges) {
    const points = routes.get(edge.id); if (!points) { hard++; continue; }
    // 端点包围按两个额外拐点计入观感成本，但不视为无解。
    // 因此它不会凌驾于节点穿越、重叠或交叉之上，也不会让必要绕行直接失败。
    const edgeBends = routeBends(points) + endpointWrapCount(edge, positions, points) * 2;
    bends += edgeBends; maxBends = Math.max(maxBends, edgeBends);
    length += routeLength(points); bendPoints.push(...points.slice(1, -1));
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
  // 正交图的稳定优先级：真实冲突优先；无冲突时先减少总拐点，再避免把拐点集中到单条边。
  // 拐点拥挤、近距离并行和长度只用于同等拐点复杂度下的观感裁决，不能把 L 形路线挤成 Z/U 形。
  return [hard, rounded(shared), crossings, bends, maxBends, bendCrowding, rounded(near), rounded(length)];
}

function routeIntrinsic(graph, positions, edge, points) {
  if (!points) return { hard: 1, bends: 0, length: 0 };
  return {
    hard: graph.nodes.filter(node => node.id !== edge.source && node.id !== edge.target
      && routeCrossesNode(points, positions[node.id], ROUTE_PADDING)).length,
    bends: routeBends(points) + endpointWrapCount(edge, positions, points) * 2,
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
  let [hard, shared, crossings, bends, , bendCrowding, near, length] = score;
  for (const id of changed) {
    const edge = byId.get(id), before = routes.get(id), after = replacements.get(id);
    const oldIntrinsic = routeIntrinsic(graph, positions, edge, before);
    const newIntrinsic = routeIntrinsic(graph, positions, edge, after);
    hard += newIntrinsic.hard - oldIntrinsic.hard;
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
  return [hard, rounded(shared), crossings, bends, maxBends, bendCrowding, rounded(near), rounded(length)];
}

function routePairContribution(edgeA, pointsA, edgeB, pointsB) {
  if (!pointsA || !pointsB) return [0, 0, 0, 0];
  const conflict = pairConflict(edgeA, pointsA, edgeB, pointsB);
  return [conflict[1], conflict[0], bendCrowdingBetween(pointsA, pointsB), conflict[2]];
}

// 两条边的候选笛卡尔积共享各自相对固定全图的一次增量评分；
// 每个组合只补算两条候选之间的关系，避免 36×36 次重复扫描其余边。
function scoreTwoRouteChanges(graph, positions, edges, state, left, right, leftRoute, rightRoute,
  leftScore, rightScore) {
  const score = state.score.map((value, index) => index === 4 ? 0 : leftScore[index] + rightScore[index] - value);
  const oldPair = routePairContribution(left, state.routes.get(left.id), right, state.routes.get(right.id));
  const leftPair = routePairContribution(left, leftRoute, right, state.routes.get(right.id));
  const rightPair = routePairContribution(left, state.routes.get(left.id), right, rightRoute);
  const nextPair = routePairContribution(left, leftRoute, right, rightRoute);
  for (const [scoreIndex, pairIndex] of [[1, 0], [2, 1], [5, 2], [6, 3]])
    score[scoreIndex] += oldPair[pairIndex] + nextPair[pairIndex] - leftPair[pairIndex] - rightPair[pairIndex];
  score[4] = edges.reduce((maximum, edge) => Math.max(maximum, routeBends(
    edge.id === left.id ? leftRoute : edge.id === right.id ? rightRoute : state.routes.get(edge.id) ?? [])), 0);
  score[1] = rounded(score[1]); score[6] = rounded(score[6]); score[7] = rounded(score[7]);
  return score;
}

export function routeGraphScore(graph, positions, routes) {
  const points = new Map([...routes].map(([id, route]) => [id, route.points ?? route]));
  return routeScore(graph, positions, graph.edges.filter(edge => edge.source !== edge.target), points);
}

export function routeGraphScoreAfterChanges(graph, positions, routes, replacements) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target);
  const points = new Map([...routes].map(([id, route]) => [id, route.points ?? route]));
  const changed = new Map([...replacements].map(([id, route]) => [id, route.points ?? route]));
  return routeScoreAfterChanges(graph, positions, edges, points,
    routeScore(graph, positions, edges, points), changed);
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
export function routeGraphSpacingCuts(routes, minGap = ROUTE_READABLE_GAP) {
  const entries = [...routes].map(([id, route]) => {
    const points = route.points ?? route, segments = routeSegments(points);
    return [id, segments.map((segment, index) => ({ ...segment,
      endpoints: route.points ? [
        ...(index <= 1 ? [route.sourcePort] : []),
        ...(index >= segments.length - 2 ? [route.targetPort] : []),
      ].filter(Boolean) : [] }))];
  }), cuts = [];
  for (let first = 0; first < entries.length; first++) for (let second = first + 1; second < entries.length; second++) {
    const leftSegments = entries[first][1], rightSegments = entries[second][1];
    for (const a of leftSegments) for (const b of rightSegments) {
      if (a.vertical !== b.vertical) continue;
      const axisA = a.vertical ? a.a.x : a.a.y, axisB = b.vertical ? b.a.x : b.a.y;
      const gap = Math.abs(axisA - axisB); if (gap < .01 || gap >= minGap) continue;
      const a1 = a.vertical ? a.a.y : a.a.x, a2 = a.vertical ? a.b.y : a.b.x;
      const b1 = b.vertical ? b.a.y : b.a.x, b2 = b.vertical ? b.b.y : b.b.x;
      const overlap = Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
      if (overlap < 60) continue;
      // 同一节点同一面的端口与紧邻折返段属于端口汇入区，天然按端口宽度排列。
      // 只豁免双方共享真实端口的情况；不同节点之间的长端点段仍执行 48px 检查。
      const sharedEndpoint = a.endpoints.some(endpoint => b.endpoints.some(other => endpoint.nodeId
        && endpoint.nodeId === other.nodeId && endpoint.side === other.side));
      if (sharedEndpoint) continue;
      cuts.push({ axis: a.vertical ? 'x' : 'y', coordinate: (axisA + axisB) / 2,
        deficit: minGap - gap, overlap });
    }
  }
  const merged = new Map();
  for (const cut of cuts) {
    const key = `${cut.axis}/${Math.round(cut.coordinate / minGap)}`;
    const current = merged.get(key);
    if (!current) merged.set(key, cut);
    else {
      const weight = current.overlap + cut.overlap;
      current.coordinate = (current.coordinate * current.overlap + cut.coordinate * cut.overlap) / weight;
      current.deficit = Math.max(current.deficit, cut.deficit); current.overlap = weight;
    }
  }
  return [...merged.values()].sort((a, b) => b.deficit - a.deficit || b.overlap - a.overlap
    || a.axis.localeCompare(b.axis) || a.coordinate - b.coordinate);
}

// 同一走廊中的内部平行段固定使用 48px 车道。奇数条保留中间车道，偶数条保留原中心；端口首末段不参与。
export function normalizeRouteLanes(graph, positions, routes, gap = ROUTE_READABLE_GAP) {
  const baselineScore = routeGraphScore(graph, positions, routes);
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
  const result = new Map([...routes].map(([id, route]) => [id, route.points
    ? { ...route, points: route.points.map(point => ({ ...point })) }
    : route.map(point => ({ ...point }))]));
  let changed = false;
  for (const group of groups.values()) {
    if (group.length < 2 || new Set(group.map(record => record.edgeId)).size !== group.length) continue;
    const sorted = [...group].sort((a, b) => a.axis - b.axis || a.edgeId.localeCompare(b.edgeId));
    const center = sorted.length % 2 ? sorted[(sorted.length - 1) / 2].axis
      : (sorted[sorted.length / 2 - 1].axis + sorted[sorted.length / 2].axis) / 2;
    sorted.forEach((record, index) => {
      const target = rounded(center + (index - (sorted.length - 1) / 2) * gap);
      if (Math.abs(target - record.axis) < .01) return;
      const route = result.get(record.edgeId), points = route.points ?? route;
      if (record.vertical) { points[record.index].x = target; points[record.index + 1].x = target; }
      else { points[record.index].y = target; points[record.index + 1].y = target; }
      changed = true;
    });
  }
  if (!changed) return routes;
  for (const route of result.values()) if (route.points) {
    route.path = roundedPath(route.points); Object.assign(route, routeLabel(route.points));
  }
  const score = routeGraphScore(graph, positions, result);
  // 车道等距化只能改善观感，不能把端口交换阶段已消除的交叉重新带回来。
  // 硬穿越、共线重叠、交叉按全图路由的同一词典序审查。
  return compareTuple(score.slice(0, 3), baselineScore.slice(0, 3)) > 0 ? routes : result;
}

function conflictSeverityMap(graph, routes) {
  return new Map(routeGraphConflicts(graph, routes)
    .filter(conflict => conflict.crossings > 0 || conflict.shared > 0)
    .map(conflict => [[conflict.left, conflict.right].sort().join('\u0000'), [conflict.crossings, conflict.shared]]));
}

// 节点落地后的正式布线仍使用 routeGraphEdges，只把候选协商限制在真实影响域内。
// 新冲突会把另一侧边纳入下一轮；无法保持质量时才退回全图计算。
export function rerouteMovedNodes(graph, positions, cached, movedIds, cola = globalThis.cola) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target).sort((a, b) => a.id.localeCompare(b.id));
  const moved = new Set(movedIds.filter(id => graph.nodes.some(node => node.id === id)));
  if (!edges.length) return { routes: new Map(), edgeIds: [], full: false };
  if (!moved.size || edges.some(edge => !cached?.get(edge.id)?.points)) {
    return { routes: routeGraphEdges(graph, positions, cola), edgeIds: edges.map(edge => edge.id), full: true };
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
      return { routes: routeGraphEdges(graph, positions, cola), edgeIds: edges.map(edge => edge.id), full: true };
    }
    const localEdges = edges.filter(edge => affected.has(edge.id));
    const local = routeGraphEdges({ ...graph, edges: localEdges }, positions, cola);
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
    if (!additions.size) return { routes: merged, edgeIds: [...affected].sort(), full: false };
    for (const id of additions) affected.add(id);
    expandPortPeers();
  }
  return { routes: routeGraphEdges(graph, positions, cola), edgeIds: edges.map(edge => edge.id), full: true };
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
  const front = Math.min(20, Math.max(6, Math.ceil(limit * .75)));
  return [...new Set([...list.slice(0, front), ...list.slice(48)])].slice(0, limit);
}

function optimizeConflictPairs(graph, positions, edges, candidates, state) {
  const searchLimit = edges.length > 80 ? 8 : 36;
  for (let round = 0; round < (edges.length > 80 ? 1 : 2); round++) {
    let changed = false;
    for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
      const left = edges[first], right = edges[second];
      const currentConflict = pairConflict(left, state.routes.get(left.id), right, state.routes.get(right.id));
      if (compareConflict(currentConflict, [0, 0, 0]) <= 0) continue;
      const localLimit = currentConflict[1] > 0 ? 36 : searchLimit;
      const leftRoutes = searchCandidates(candidates.get(left.id), localLimit);
      const rightRoutes = searchCandidates(candidates.get(right.id), localLimit);
      const leftScores = new Map(leftRoutes.map(route => [route, routeScoreAfterChanges(graph, positions, edges,
        state.routes, state.score, new Map([[left.id, route]]))]));
      const rightScores = new Map(rightRoutes.map(route => [route, routeScoreAfterChanges(graph, positions, edges,
        state.routes, state.score, new Map([[right.id, route]]))]));
      let best = null;
      for (const leftRoute of leftRoutes) for (const rightRoute of rightRoutes) {
        const score = scoreTwoRouteChanges(graph, positions, edges, state, left, right, leftRoute, rightRoute,
          leftScores.get(leftRoute), rightScores.get(rightRoute));
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

function optimizeConflictComponents(graph, positions, edges, candidates, state) {
  const searchLimit = edges.length > 80 ? 8 : 36, beamWidth = edges.length > 80 ? 8 : 24;
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

function alternativeEndpoint(edge, role, side, assignments, positions) {
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
  const offset = offsets.find(value => !used.has(rounded(value))); if (offset === undefined) return null;
  const port = endpointPoint(point, side, offset);
  return { side, nodeId, otherId, exterior: false, port, anchor: anchorPoint(port, side, sameSide.length), slot: sameSide.length };
}

function bestEndpointProposal(graph, positions, edges, assignments, axes, state, edge, allowBackward = false,
  routeCache = null, candidateLimit = 36) {
  const current = assignments.get(edge.id); if (current.source.exterior || current.target.exterior) return null;
  const acceptableSides = (nodeId, otherId) => {
    const point = positions[nodeId], other = positions[otherId];
    const dx = other.x - point.x, dy = other.y - point.y, distance = Math.hypot(dx, dy) || 1;
    return SIDES.filter(side => dx / distance * SIDE_VECTOR[side].x + dy / distance * SIDE_VECTOR[side].y >= -.0001);
  };
  const sourceSides = allowBackward ? SIDES : acceptableSides(edge.source, edge.target);
  const targetSides = allowBackward ? SIDES : acceptableSides(edge.target, edge.source);
  let best = null;
  for (const sourceSide of sourceSides) for (const targetSide of targetSides) {
    const source = sourceSide === current.source.side ? current.source : alternativeEndpoint(edge, 'source', sourceSide, assignments, positions);
    const target = targetSide === current.target.side ? current.target : alternativeEndpoint(edge, 'target', targetSide, assignments, positions);
    if (!source || !target || (source === current.source && target === current.target)) continue;
    const assignment = { source: { ...source, port: { ...source.port }, anchor: { ...source.anchor } },
      target: { ...target, port: { ...target.port }, anchor: { ...target.anchor } } };
    const endpointKey = endpoint => `${endpoint.side}:${endpoint.port.x},${endpoint.port.y}:${endpoint.anchor.x},${endpoint.anchor.y}`;
    const cacheKey = `${edge.id}/${endpointKey(assignment.source)}/${endpointKey(assignment.target)}`;
    let routes = routeCache?.get(cacheKey);
    if (!routes) {
      routes = candidateRoutes(graph, positions, edge, assignment, axes);
      routeCache?.set(cacheKey, routes);
    }
    for (const points of searchCandidates(routes, candidateLimit)) {
      const score = routeScoreAfterChanges(graph, positions, edges, state.routes, state.score,
        new Map([[edge.id, points]]));
      if (!best || compareTuple(score, best.score) < 0) best = { edge, assignment, routes, points, score };
    }
  }
  return best && compareTuple(best.score, state.score) < 0 ? best : null;
}

function optimizeEndpointSides(graph, positions, edges, assignments, axes, candidates, state) {
  const routeCache = new Map(), large = edges.length > 80, candidateLimit = large ? 8 : 36;
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
  // 每轮为每条可改进边生成一个最佳提案，再依次按最新状态复核并提交。
  // 这保留精确词典序接受条件，同时避免“每接受一条边就重算全图全部换面组合”。
  for (let round = 0; round < (large ? 1 : 6); round++) {
    const improvableIds = new Set();
    for (let first = 0; first < edges.length; first++) for (let second = first + 1; second < edges.length; second++) {
      if (compareConflict(pairConflict(edges[first], state.routes.get(edges[first].id), edges[second], state.routes.get(edges[second].id)), [0, 0, 0]) > 0) {
        improvableIds.add(edges[first].id); improvableIds.add(edges[second].id);
      }
    }
    const proposals = [];
    for (const edge of edges.filter(item => improvableIds.has(item.id))) {
      const best = bestEndpointProposal(graph, positions, edges, assignments, axes, state, edge, true, routeCache, candidateLimit);
      if (best) proposals.push(best);
    }
    proposals.sort((left, right) => compareTuple(left.score, right.score) || left.edge.id.localeCompare(right.edge.id));
    let changed = false;
    for (const proposal of proposals) {
      if (!endpointAvailable(proposal)) continue;
      const score = routeScoreAfterChanges(graph, positions, edges, state.routes, state.score,
        new Map([[proposal.edge.id, proposal.points]]));
      if (compareTuple(score, state.score) >= 0) continue;
      assignments.set(proposal.edge.id, proposal.assignment); candidates.set(proposal.edge.id, proposal.routes);
      state.routes.set(proposal.edge.id, proposal.points); state.score = score; changed = true;
      break;
    }
    if (!changed) break;
  }
  // 硬冲突清零后，在不恶化四面相对负载的前提下精简拐点；这仍属于端口面确定阶段。
  for (let round = 0; round < (large ? 0 : 2); round++) {
    const currentBalance = endpointBalance(endpointLoads(assignments));
    const proposals = edges.filter(edge => routeBends(state.routes.get(edge.id)) > 1)
      .map(edge => bestEndpointProposal(graph, positions, edges, assignments, axes, state, edge, false, routeCache, candidateLimit))
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
      candidates.set(proposal.edge.id, proposal.routes);
      state.routes.set(proposal.edge.id, proposal.points); state.score = score; changed = true;
    }
    if (!changed) break;
  }
  return state;
}

function endpointLoads(assignments) {
  const loads = new Map();
  for (const assignment of assignments.values()) for (const endpoint of [assignment.source, assignment.target]) {
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

function swapAssignmentPorts(left, right) {
  for (const key of ['port', 'anchor', 'slot']) [left[key], right[key]] = [right[key], left[key]];
}

function optimizePortSwaps(graph, positions, edges, assignments, axes, candidates, state) {
  const searchLimit = edges.length > 80 ? 8 : 36;
  const groups = new Map();
  for (const edge of edges) for (const role of ['source', 'target']) {
    const endpoint = assignments.get(edge.id)[role], key = `${endpoint.nodeId}/${endpoint.side}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ edge, role });
  }
  for (let round = 0; round < 2; round++) {
    let changed = false;
    for (const members of groups.values()) for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
      const left = members[a], right = members[b], leftAssignment = assignments.get(left.edge.id)[left.role], rightAssignment = assignments.get(right.edge.id)[right.role];
      swapAssignmentPorts(leftAssignment, rightAssignment);
      const leftCandidates = candidateRoutes(graph, positions, left.edge, assignments.get(left.edge.id), axes);
      const rightCandidates = candidateRoutes(graph, positions, right.edge, assignments.get(right.edge.id), axes);
      const leftRoutes = searchCandidates(leftCandidates, searchLimit), rightRoutes = searchCandidates(rightCandidates, searchLimit);
      const leftScores = new Map(leftRoutes.map(route => [route, routeScoreAfterChanges(graph, positions, edges,
        state.routes, state.score, new Map([[left.edge.id, route]]))]));
      const rightScores = new Map(rightRoutes.map(route => [route, routeScoreAfterChanges(graph, positions, edges,
        state.routes, state.score, new Map([[right.edge.id, route]]))]));
      let best = null;
      for (const leftRoute of leftRoutes) for (const rightRoute of rightRoutes) {
        const score = scoreTwoRouteChanges(graph, positions, edges, state, left.edge, right.edge, leftRoute, rightRoute,
          leftScores.get(leftRoute), rightScores.get(rightRoute));
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

// 固定节点的正交布线：WebCola 仅贡献单边候选；端口排列、L/Z/U 路径和通道冲突由全图优化器共同裁决。
export function routeGraphEdges(graph, positions, cola = globalThis.cola) {
  const edges = graph.edges.filter(edge => edge.source !== edge.target).sort((a, b) => a.id.localeCompare(b.id));
  if (!edges.length) return new Map();
  for (const node of graph.nodes) if (!finitePoint(positions[node.id])) throw new Error('节点缺少有效坐标：' + node.id);
  const assignments = assignEdgePorts(graph, positions), axes = routeAxes(graph, positions, assignments), candidates = new Map();
  for (const edge of edges) {
    const assignment = assignments.get(edge.id);
    // 当前 WebCola 适配器会为每条边重复构建 GridRouter；大图使用第一方候选，避免可选 provider 主导总耗时。
    const webCola = edges.length <= 80 ? webColaCandidate(graph, positions, edge, assignment, cola) : null;
    const routes = candidateRoutes(graph, positions, edge, assignment, axes, webCola ? [webCola] : []);
    if (!routes.length) throw new Error(`无法为连线生成可行的正交路径：${edge.id}`);
    candidates.set(edge.id, routes);
  }
  let state = optimizeRouteCandidates(graph, positions, edges, assignments, candidates);
  state = optimizeConflictPairs(graph, positions, edges, candidates, state);
  // 端口面试算只为消除固定端口无法解决的硬冲突；不再以拐点或长度为理由换面。
  state = optimizeEndpointSides(graph, positions, edges, assignments, axes, candidates, state);
  state = optimizePortSwaps(graph, positions, edges, assignments, axes, candidates, state);
  state = optimizeConflictPairs(graph, positions, edges, candidates, state);
  state = optimizeConflictComponents(graph, positions, edges, candidates, state);
  state = refineRouteCandidates(graph, positions, edges, candidates, state, 2);
  let result = new Map(edges.map(edge => {
    const points = state.routes.get(edge.id), assignment = assignments.get(edge.id);
    return [edge.id, { path: roundedPath(points), points, sourcePort: assignment.source,
      targetPort: assignment.target, ...routeLabel(points) }];
  }));
  result = normalizeRouteLanes(graph, positions, result);
  const finalScore = routeGraphScore(graph, positions, result);
  if (finalScore[0] > 0) throw new Error('正交路由仍存在节点穿越或缺失路径。');
  if (finalScore[1] > .01) throw new Error('正交路由仍存在共线重叠。');
  return result;
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
  const snap = value => Math.max(-100000, Math.min(100000, Math.round(value / 10) * 10));
  return Object.fromEntries(Object.entries(positions).map(([id, point]) => [id, { x: snap(point.x), y: snap(point.y) }]));
}

export function graphGeometryKey(graph, positions) {
  const nodes = graph.nodes.map(node => `${node.id}:${positions[node.id]?.x},${positions[node.id]?.y}`).join('|');
  const edges = graph.edges.map(edge => `${edge.id}:${edge.source}>${edge.target}`).join('|');
  return nodes + '//' + edges;
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
  const sourceHorizontal = source.side === 'left' || source.side === 'right';
  const middle = sourceHorizontal
    ? { x: target.anchor.x, y: source.anchor.y }
    : { x: source.anchor.x, y: target.anchor.y };
  const points = normalizeRoute([source.port, source.anchor, middle, target.anchor, target.port]);
  return { path: roundedPath(points), points, sourcePort: source, targetPort: target, ...routeLabel(points) };
}

export class GraphCanvas {
  constructor(root, callbacks) {
    this.root = root; this.callbacks = callbacks; this.camera = { x: 50, y: 80, scale: 1 };
    this.graph = { nodes: [], edges: [] }; this.positions = {}; this.mode = 'select'; this.space = false;
    this.routed = new Map(); this.routeArchive = new Map(); this.nodeElements = new Map(); this.edgeElements = new Map(); this.geometryKey = null;
    root.addEventListener('wheel', event => {
      event.preventDefault(); const rect = root.getBoundingClientRect();
      this.zoom(Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    root.addEventListener('pointerdown', event => this.down(event));
    root.addEventListener('pointermove', event => this.move(event));
    root.addEventListener('pointerup', event => this.up(event));
    root.addEventListener('pointercancel', () => this.cancel());
    root.addEventListener('lostpointercapture', () => { if (this.gesture) this.cancel(); });
    root.addEventListener('contextmenu', event => event.preventDefault());
    root.addEventListener('keydown', event => {
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
  update(graph, positions, activeId, selection, definitionMode, { preserveRoutes = false } = {}) {
    const pendingMove = this.pendingMove, previousGraph = this.graph, previousPositions = this.positions;
    const nextKey = graphGeometryKey(graph, positions), geometryChanged = nextKey !== this.geometryKey;
    this.pendingMove = null;
    this.routed ??= new Map();
    this.routeArchive ??= new Map();
    if (preserveRoutes) for (const [id, route] of this.routed) this.routeArchive.set(id, route);
    else this.routeArchive.clear();
    this.graph = graph; this.positions = positions; this.activeId = activeId; this.selection = selection; this.definitionMode = definitionMode;
    const primed = this.primedRoutes?.key === nextKey ? this.primedRoutes.routes : null;
    if (primed) this.routed = primed;
    this.primedRoutes = null;
    if (preserveRoutes && !primed) {
      const preserved = new Map(graph.edges.flatMap(edge => {
        const route = this.routeArchive.get(edge.id);
        return route ? [[edge.id, route]] : [];
      }));
      this.routed = preserved;
    } else if (!primed && pendingMove?.ids?.length && previousGraph && previousPositions) {
      const moved = new Set(pendingMove.ids), preview = new Map(this.routed);
      for (const edge of graph.edges) {
        if (!moved.has(edge.source) && !moved.has(edge.target)) continue;
        const cached = this.routed.get(edge.id);
        if (cached) preview.set(edge.id, incrementalEdgeGeometry(edge, positions, previousPositions, cached));
      }
      this.routed = preview;
    }
    this.geometryKey = nextKey; this.draw({ reroute: false });
    if (!graph.edges.length) { this.routed = new Map(); return Promise.resolve(true); }
    // settled commit 正在旧 routingPromise 的 then 中消费预置帧；这里必须立即结束，
    // 不能把旧 Promise 返回给它自身，否则会形成等待环并让页面永久处于计算中。
    if (primed) return Promise.resolve(true);
    // 视图显隐只投影已经生成的节点与连线。几何签名必然会随可见集合改变，
    // 但这不代表布局或端口发生了编辑；禁止因此启动 Worker 和再次执行间距切分。
    if (preserveRoutes) return Promise.resolve(true);
    if (!primed && geometryChanged) return this.requestRouting(nextKey, pendingMove?.ids);
    return this.routingPromise ?? Promise.resolve(true);
  }
  primeRoutes(graph, positions, routes) {
    this.primedRoutes = routes ? { key: graphGeometryKey(graph, positions), routes } : null;
  }
  requestRouting(geometryKey, movedIds = []) {
    if (typeof this.callbacks.computeGraph !== 'function') return Promise.resolve(false);
    const payload = { graph: this.graph, positions: this.positions, cachedRoutes: [...this.routed], movedIds };
    const promise = this.callbacks.computeGraph({ kind: 'route', geometryKey, payload,
      isCurrent: () => this.geometryKey === geometryKey })
      .then(result => {
        if (this.geometryKey !== geometryKey) return false;
        if (typeof this.callbacks.commitGeometry === 'function') {
          return this.callbacks.commitGeometry({ baseGeometryKey: geometryKey, ...result });
        }
        this.routed = new Map(result.routes); this.lastRouting = { edgeIds: result.edgeIds, full: result.full };
        for (const [id, route] of this.routed) this.routeArchive.set(id, route);
        this.routingErrorMessage = null; this.draw({ reroute: false }); return true;
      })
      .catch(error => {
        if (error?.name === 'AbortError' || error?.code === 'COMPUTE_CANCELLED') return false;
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
      this.gesture = { type: 'box', point: this.point(event), end: this.point(event), x: event.clientX, y: event.clientY,
        pointerId: event.pointerId, original: event.shiftKey ? [...this.selectedIds()] : [], additive: event.shiftKey, moved: false };
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
    else if (gesture.type === 'box' && !gesture.additive && !gesture.moved) this.callbacks.select(null);
    if (!gesture.moved && ((gesture.type === 'nodes' && gesture.ids.length === 1) || (gesture.type === 'box' && !gesture.additive))) {
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
    else { const source = this.linkSource; if (this.callbacks.link(source, id, this.mode === 'contains' ? 'contains' : this.mode === 'positive' ? 1 : -1)) this.linkSource = null; this.draw({ reroute: false }); }
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
    for (const [id, fill] of [['positive', '#328577'], ['negative', '#bd7064'], ['contains', '#c49a26']]) {
      const marker = svg('marker', { id, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
      marker.append(svg('path', { d: 'M0,0 L7,3.5 L0,7 Z', fill })); defs.append(marker);
    }
    this.world = svg('g'); this.root.append(defs, this.world);
    const positions = { ...this.positions };
    if (this.gesture?.type === 'nodes' && this.gesture.next) Object.assign(positions, this.gesture.next);
    const routed = this.routed;
    this.nodeElements = new Map(); this.edgeElements = new Map();
    const parallel = new Map();
    for (const edge of this.graph.edges) {
      const key = [edge.source, edge.target].sort().join('/');
      if (!parallel.has(key)) parallel.set(key, []); parallel.get(key).push(edge.id);
    }
    for (const ids of parallel.values()) ids.sort();
    for (const edge of this.graph.edges) {
      const a = positions[edge.source], b = positions[edge.target]; if (!a || !b) continue;
      const siblings = parallel.get([edge.source, edge.target].sort().join('/'));
      const offset = (siblings.indexOf(edge.id) - (siblings.length - 1) / 2) * 34;
      let geometry = edge.source === edge.target ? edgeGeometry(a, b, edge.source, edge.target, offset) : routed.get(edge.id);
      if (!geometry) continue;
      if (geometry.points) geometry = { ...geometry, path: roundedPath(geometry.points), ...routeLabel(geometry.points) };
      const { path, labelX, labelY } = geometry;
      const sign = edge.relation === 'contains' ? 'contains' : edge.sign === 1 ? 'positive' : 'negative';
      const own = this.activeId === null || (edge.steps.length === 1 && edge.steps[0].graphId === this.activeId);
      const selected = this.selection?.type === 'edge' && this.selection.id === edge.id;
      const group = svg('g', { 'data-edge': edge.id, tabindex: 0, role: 'button', 'aria-label': `${this.callbacks.name(edge.source)} ${sign === 'contains' ? '包含' : edge.sign === 1 ? '促进' : '抑制'} ${this.callbacks.name(edge.target)}` });
      const hit = svg('path', { d: path, class: 'edge-hit' });
      const line = svg('path', { d: path, class: `edge-line edge-${sign} ${own ? '' : 'reference'} ${selected ? 'selected' : ''}`, 'marker-end': `url(#${sign})`, 'pointer-events': 'none' });
      group.append(hit, line);
      const label = svg('text', { x: labelX, y: labelY, class: `edge-label ${sign}`, opacity: own || selected ? 1 : .4 });
      label.textContent = sign === 'contains' ? '=' : edge.sign === 1 ? '+' : '−'; group.append(label); this.world.append(group);
      this.edgeElements.set(edge.id, { group, hit, line, label });
    }
    for (const node of this.graph.nodes) {
      const point = positions[node.id];
      const own = this.activeId === null || this.definitionMode || node.sourceGraphIds?.includes(this.activeId);
      const selected = this.selectedIds().includes(node.id);
      const group = svg('g', { 'data-node': node.id, transform: `translate(${point.x} ${point.y})`, class: `node ${own ? '' : 'reference'} ${selected ? 'selected' : ''} ${this.linkSource === node.id ? 'link-source' : ''}`, tabindex: 0, role: 'button', 'aria-label': node.label });
      const title = svg('title'); title.textContent = `${node.label}\n${node.description}`;
      const label = svg('text', { x: 16, y: 27 }); label.textContent = node.label.length > 10 ? `${node.label.slice(0, 10)}…` : node.label;
      const meta = svg('text', { x: 16, y: 45, class: 'node-meta' });
      meta.textContent = this.definitionMode ? node.id.slice(0, 23) : (node.sourceGraphIds ?? []).map(this.callbacks.graphName).join(' · ').slice(0, 23);
      group.append(title, svg('rect', { width: WIDTH, height: HEIGHT, rx: 7 }), label, meta);
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
