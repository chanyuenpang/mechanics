import { rerouteMovedNodes, routeGraphEdges } from './canvas.mjs';
import { arrangeGraphWithRoutes } from './layout.mjs';
import { settleGraphGeometry } from './geometry-settle.mjs';

const mapEntries = value => value instanceof Map ? [...value] : Array.isArray(value) ? value : [];

export async function computeGraphTask(request, { ELK = globalThis.ELK, cola = globalThis.cola } = {}) {
  if (!request || !['route', 'layout'].includes(request.kind) || !request.payload?.graph || !request.payload?.positions) {
    throw new Error('图计算 Worker 收到了无效请求。');
  }
  const { graph, positions } = request.payload;
  if (request.kind === 'layout') {
    const result = await arrangeGraphWithRoutes({ graph, positions,
      selectedIds: request.payload.selectedIds ?? [], ELK, cola });
    return { positions: result.positions, routes: [...result.routes] };
  }
  const cached = new Map(mapEntries(request.payload.cachedRoutes));
  const movedIds = request.payload.movedIds ?? [];
  const routed = movedIds.length && cached.size
    ? rerouteMovedNodes(graph, positions, cached, movedIds, cola)
    : { routes: routeGraphEdges(graph, positions, cola), edgeIds: graph.edges.map(edge => edge.id), full: true };
  const result = settleGraphGeometry({ graph, positions, routes: routed.routes, cola });
  return { positions: result.positions, routes: [...result.routes], edgeIds: routed.edgeIds, full: routed.full };
}
