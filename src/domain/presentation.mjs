import { endpointProjectionId } from './endpoint-projection.mjs';
import { registeredMechanicIds } from './view.mjs';
import { composeProjection } from './graph.mjs';

const projectionIdsFor = graphs => new Set(graphs.flatMap(graph => graph.edges.flatMap(edge => [
  ...(edge.sourceQualifiers?.length ? [endpointProjectionId(edge.source, edge.sourceQualifiers)] : []),
  ...(edge.targetQualifiers?.length ? [endpointProjectionId(edge.target, edge.targetQualifiers)] : []),
])));

function record(diagnostics, file, field, missingIds) {
  if (missingIds.length) diagnostics.push({ code: 'PRESENTATION_REFERENCE_MISSING', file, field, missingIds });
}

function filterPositions(document, field, validIds, file, diagnostics) {
  const source = document[field];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const missingIds = Object.keys(source).filter(id => !validIds.has(id));
  record(diagnostics, file, field, missingIds);
  for (const id of missingIds) delete source[id];
  return missingIds.length > 0;
}

function filterIds(document, field, validIds, file, diagnostics) {
  const source = document[field];
  if (!Array.isArray(source)) return false;
  const missingIds = source.filter(id => !validIds.has(id));
  record(diagnostics, file, field, missingIds);
  if (missingIds.length) document[field] = source.filter(id => validIds.has(id));
  return missingIds.length > 0;
}

function dropRouteCache(document, file, diagnostics) {
  if (document.routeCache === undefined) return;
  delete document.routeCache;
  diagnostics.push({ code: 'PRESENTATION_ROUTE_CACHE_DROPPED', file, field: 'routeCache', missingIds: [] });
}

// presentation 字段永远不拥有概念、规则或机制的存在性事实。
// 此函数只生成供读取使用的内存快照，调用者不得把它当作隐式持久化写入。
export function resolvePresentationReferences({ manifest, definitions, rules, mechanics, views, files }) {
  const next = structuredClone({ manifest, definitions, rules, mechanics, views });
  const diagnostics = [], conceptIds = new Set(next.definitions.nodes.map(node => node.id));
  const mechanicById = new Map(next.mechanics.map(mechanic => [mechanic.id, mechanic]));
  const fileFor = (kind, id) => files.find(file => file.kind === kind && (id === undefined || file.id === id))?.path ?? kind;

  filterPositions(next.definitions, 'positions', conceptIds, fileFor('definitions'), diagnostics);
  for (const mechanic of next.mechanics) {
    const changed = [
      filterPositions(mechanic, 'positions', new Set(composeProjection(next, { graphIds: [mechanic.id] }).nodes.map(node => node.id)), fileFor('mechanic', mechanic.id), diagnostics),
      filterPositions(mechanic, 'projectionPositions', projectionIdsFor([{ edges: composeProjection(next, { graphIds: [mechanic.id] }).edges }]), fileFor('mechanic', mechanic.id), diagnostics),
    ].some(Boolean);
    if (changed) dropRouteCache(mechanic, fileFor('mechanic', mechanic.id), diagnostics);
  }

  const sanitizeInlineView = (view, file) => {
    const graphs = view.graphIds.map(id => mechanicById.get(id)).filter(Boolean);
    const included = new Set(composeProjection(next, { graphIds: view.graphIds }).nodes.map(node => node.id));
    const changed = [
      filterPositions(view, 'positions', conceptIds, file, diagnostics),
      filterIds(view, 'collapsedNodeIds', included, file, diagnostics),
      filterPositions(view, 'projectionPositions', projectionIdsFor([{ edges: composeProjection(next, { graphIds: view.graphIds }).edges }]), file, diagnostics),
    ].some(Boolean);
    if (changed) dropRouteCache(view, file, diagnostics);
  };
  for (const composition of next.manifest.compositions) sanitizeInlineView(composition, 'workspace.json');
  if (next.manifest.lastView && !Object.hasOwn(next.manifest.lastView, 'viewId')) sanitizeInlineView(next.manifest.lastView, 'workspace.json');

  for (const view of next.views) {
    const graphs = registeredMechanicIds(view).map(id => mechanicById.get(id)).filter(Boolean);
    const projection = composeProjection(next, { graphIds: registeredMechanicIds(view), focusNodeIds: view.focusNodeIds, pinnedRuleIds: view.pinnedRuleIds });
    const included = new Set(projection.nodes.map(node => node.id));
    const file = fileFor('view', view.id);
    const changed = [
      filterPositions(view, 'positions', conceptIds, file, diagnostics),
      filterIds(view, 'collapsedNodeIds', included, file, diagnostics),
      filterPositions(view, 'projectionPositions', projectionIdsFor([{ edges: projection.edges }]), file, diagnostics),
    ].some(Boolean);
    if (changed) dropRouteCache(view, file, diagnostics);
  }
  return { workspace: next, diagnostics };
}
