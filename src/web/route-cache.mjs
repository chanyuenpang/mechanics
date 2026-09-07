const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
const routeEdgeIds = graph => graph.edges.filter(edge => edge.source !== edge.target).map(edge => edge.id).sort();
const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
// 路由算法改变时递增，避免坐标与拓扑未变的文件永久复用旧算法路线。
const ROUTE_CACHE_VERSION = 3;

// 几何快照的身份同时覆盖算法版本、可见节点位置和连线拓扑。路径只是这份快照的派生物，
// 任一项变化都不能复用旧路径。
export function graphGeometryKey(graph, positions) {
  const nodes = graph.nodes.map(node => `${node.id}:${positions[node.id]?.x},${positions[node.id]?.y}`).join('|');
  const edges = graph.edges.map(edge => `${edge.id}:${edge.source}>${edge.target}`).join('|');
  return `v${ROUTE_CACHE_VERSION}//${nodes}//${edges}`;
}

export function createRouteCache(graph, positions, routes) {
  const expected = routeEdgeIds(graph), byId = routes instanceof Map ? routes : new Map(routes ?? []);
  if (!sameIds([...byId.keys()].sort(), expected)) return null;
  const paths = {};
  for (const id of expected) {
    const points = byId.get(id)?.points ?? byId.get(id);
    if (!Array.isArray(points) || points.length < 2 || points.some(point => !validPoint(point))) return null;
    paths[id] = points.map(point => ({ x: point.x, y: point.y }));
  }
  return { geometryKey: graphGeometryKey(graph, positions), paths };
}

export function restoreRouteCache(graph, positions, cache) {
  if (!cache || cache.geometryKey !== graphGeometryKey(graph, positions) || !cache.paths || typeof cache.paths !== 'object') return null;
  const expected = routeEdgeIds(graph), ids = Object.keys(cache.paths).sort();
  if (!sameIds(ids, expected)) return null;
  const routes = new Map();
  for (const id of expected) {
    const points = cache.paths[id];
    if (!Array.isArray(points) || points.length < 2 || points.some(point => !validPoint(point))) return null;
    routes.set(id, { points: points.map(point => ({ x: point.x, y: point.y })) });
  }
  return routes;
}
