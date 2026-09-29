import { autoLayoutGraph } from './auto-layout.mjs';
import { routeLocalGraph } from './local-routing.mjs';
import { assertReadGraphIntegrity } from '../domain/read-graph-integrity.mjs';

const mapEntries = value => value instanceof Map ? [...value] : Array.isArray(value) ? value : [];

export async function computeGraphTask(request, { ELK = globalThis.ELK } = {}) {
  if (!request || !['route', 'layout'].includes(request.kind) || !request.payload?.graph || !request.payload?.positions) {
    throw new Error('图计算 Worker 收到了无效请求。');
  }
  const { graph, positions } = request.payload;
  assertReadGraphIntegrity(graph, '图计算输入');
  if (request.kind === 'layout') {
    const result = await autoLayoutGraph({ graph, positions,
      selectedIds: request.payload.selectedIds ?? [], cachedRoutes: mapEntries(request.payload.cachedRoutes), ELK });
    return { positions: result.positions, routes: [...result.routes], routeCache: result.routeCache, warnings: result.warnings ?? [] };
  }
  const movedIds = request.payload.movedIds ?? [];
  const result = await routeLocalGraph({ ...request.payload, cachedRoutes: mapEntries(request.payload.cachedRoutes) });
  return { positions: result.positions, routes: [...result.routes], edgeIds: result.edgeIds,
    shiftedIds: result.shiftedIds, full: result.full, commitPositions: movedIds.length > 0 };
}
