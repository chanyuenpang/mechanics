import { routeGraphEdges, routeGraphSpacingCuts } from './canvas.mjs';

const WIDTH = 166;
const HEIGHT = 62;
const GRID = 10;

const snap = value => Math.max(-100000, Math.min(100000, Math.round(value / GRID) * GRID));
const cutShift = (value, axis, cuts) => cuts.filter(cut => cut.axis === axis).reduce((total, cut) => {
  const half = Math.ceil(cut.deficit / 2 / GRID) * GRID;
  return total + (value <= cut.coordinate ? -half : half);
}, 0);

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

function assertOrthogonalRoutes(routes) {
  for (const [id, route] of routes) {
    const points = route.points ?? route;
    for (let index = 1; index < points.length; index++) {
      const before = points[index - 1], after = points[index];
      if (before.x !== after.x && before.y !== after.y) {
        throw new Error(`图几何产生了斜向连线：${id} / ${index - 1}。`);
      }
    }
  }
}

export function expandLayoutAtSpacingCuts(graph, positions, routes, cuts) {
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
  assertOrthogonalRoutes(shiftedRoutes);
  return { positions: result, routes: shiftedRoutes };
}

export function expandPositionsAtSpacingCuts(nodes, positions, cuts) {
  return expandLayoutAtSpacingCuts({ nodes, edges: [] }, positions, new Map(), cuts).positions;
}

// route 与 layout 的唯一终态 owner：两轴共用一次审计和单调坐标切分，不重选已经确定的路线。
export function settleGraphGeometry({ graph, positions, routes = null, cola = globalThis.cola,
  allowPositionShift = true }) {
  let settledPositions = structuredClone(positions);
  let settledRoutes = routes ?? routeGraphEdges(graph, settledPositions, cola);
  for (let round = 0; round < Math.max(4, graph.nodes.length * 2); round++) {
    const cuts = routeGraphSpacingCuts(settledRoutes);
    if (!cuts.length) { assertOrthogonalRoutes(settledRoutes); return { positions: settledPositions, routes: settledRoutes }; }
    if (!allowPositionShift) throw new Error('固定节点限制下无法同时满足双轴 48px 通道间距，请扩大选择范围。');
    const expanded = expandLayoutAtSpacingCuts(graph, settledPositions, settledRoutes, cuts);
    if (JSON.stringify(expanded.positions) === JSON.stringify(settledPositions)) {
      throw new Error('图几何无法为密集通道继续增加间距。');
    }
    settledPositions = expanded.positions; settledRoutes = expanded.routes;
  }
  const remaining = routeGraphSpacingCuts(settledRoutes);
  if (remaining.length) throw new Error(`图几何未能消除全部密集通道：仍有 ${remaining.length} 处。`);
  assertOrthogonalRoutes(settledRoutes);
  return { positions: settledPositions, routes: settledRoutes };
}
