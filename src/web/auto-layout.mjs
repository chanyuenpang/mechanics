import { arrangeGraphWithRoutes } from './layout.mjs';
import { createRouteCache } from './route-cache.mjs';

// 网页 Worker 与服务端草稿保存必须通过同一入口整理并验证完整路由快照。
export async function autoLayoutGraph({ graph, positions, selectedIds = [], cachedRoutes = [], ELK, timings, onPhase, signal } = {}) {
  const result = await arrangeGraphWithRoutes({ graph, positions, selectedIds, cachedRoutes, ELK, timings, onPhase, signal });
  const routeCache = createRouteCache(graph, result.positions, result.routes);
  if (!routeCache) throw new Error('自动排版没有生成完整的连线路由缓存。');
  return { ...result, routeCache };
}
