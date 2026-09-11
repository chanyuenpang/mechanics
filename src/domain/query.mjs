import { QUERY_API_VERSION, SEMANTICS_VERSION, readingContract, queryGuide } from './query-contract.mjs';
import { normalizeSearchTerm } from './identity.mjs';
import { compactPath, enumerateImpactPaths, enumerateNodePaths } from './query-paths.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const limits = { hops: [1, 64], maxPaths: [50, 500], maxDepth: [16, 64], maxExpansions: [10000, 100000] };
const fields = { guide: [], scopes: ['revision'], search: ['revision', 'query', 'from', 'to'], node: ['revision', 'id', 'direction', 'hops', 'maxPaths', 'maxExpansions'], impact: ['revision', 'from', 'to', 'maxPaths', 'maxDepth', 'maxExpansions'] };
const byId = (a, b) => String(a.id).localeCompare(String(b.id));

export function validateQuery(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !Object.hasOwn(fields, request.command)) fail('QUERY_INVALID', '需要 guide、scopes、search、node 或 impact 查询');
  for (const key of Object.keys(request)) {
    if (key !== 'command' && !fields[request.command].includes(key)) fail('QUERY_INVALID', '不支持查询参数：' + key);
    if (Object.hasOwn(limits, key)) { if (!Number.isInteger(request[key]) || request[key] < 1 || request[key] > limits[key][1]) fail('QUERY_INVALID', `${key} 超出整数范围`); }
    else if (key !== 'command' && (typeof request[key] !== 'string' || !request[key].trim())) fail('QUERY_INVALID', `${key} 必须是非空字符串`);
  }
  if (request.command === 'search') {
    const single = Boolean(request.query), pair = Boolean(request.from || request.to);
    if (single === pair || (pair && (!request.from || !request.to))) fail('QUERY_INVALID', 'search 需要且只能使用 --query，或同时使用 --from 与 --to');
  }
  if (request.command === 'node' && !request.id) fail('QUERY_INVALID', '缺少 id');
  if (request.command === 'impact' && (!request.from || !request.to)) fail('QUERY_INVALID', 'impact 缺少 from 或 to');
  if (request.direction && !['upstream', 'downstream', 'both'].includes(request.direction)) fail('QUERY_INVALID', 'direction 必须是 upstream/downstream/both');
  return request;
}

function projectGraph(workspace) {
  const nodes = workspace.definitions.nodes.map(node => structuredClone(node)).sort(byId);
  const edges = workspace.rules.rules.map(rule => ({ ...structuredClone(rule), origin: { ruleId: rule.id } })).sort(byId);
  return { nodes, edges };
}
const nodeDTO = node => ({ id: node.id, label: node.label, description: node.description, aliases: structuredClone(node.aliases ?? []), tags: structuredClone(node.tags ?? []), ...(node.customData ? { customData: node.customData } : {}) });
const refDTO = node => ({ id: node.id, label: node.label });

function resolveConcept(nodes, key) {
  const normalized = normalizeSearchTerm(key);
  const idMatch = nodes.find(node => normalizeSearchTerm(node.id) === normalized);
  if (idMatch) return { status: 'resolved', key, matchedBy: 'id', concept: idMatch };
  const candidates = nodes.flatMap(node => {
    const matchedBy = [];
    if (normalizeSearchTerm(node.label) === normalized) matchedBy.push('label');
    if ((node.aliases ?? []).some(alias => normalizeSearchTerm(alias) === normalized)) matchedBy.push('alias');
    return matchedBy.length ? [{ id: node.id, label: node.label, matchedBy }] : [];
  }).sort(byId);
  return candidates.length === 1 ? { status: 'resolved', key, matchedBy: candidates[0].matchedBy[0], concept: nodes.find(node => node.id === candidates[0].id) }
    : candidates.length ? { status: 'ambiguous', key, candidates } : { status: 'not_found', key };
}

const directRuleDTO = (edge, nodeMap) => ({ id: edge.id, source: refDTO(nodeMap.get(edge.source)), target: refDTO(nodeMap.get(edge.target)), operator: edge.relation === 'specializes' ? 'is-a>' : edge.sign === 1 ? '+>' : edge.sign === -1 ? '->' : '?>', ...(edge.relation === 'influence' ? { ruleText: edge.ruleText ?? '' } : {}), ...(edge.sourceQualifiers?.length ? { sourceQualifiers: structuredClone(edge.sourceQualifiers) } : {}), ...(edge.targetQualifiers?.length ? { targetQualifiers: structuredClone(edge.targetQualifiers) } : {}), origin: edge.origin });
function meta(workspace, command) { return { queryApiVersion: QUERY_API_VERSION, semanticsVersion: SEMANTICS_VERSION, readingContract: { version: readingContract().version }, workspaceId: workspace.manifest.id, revision: workspace.revision, ...(Number.isInteger(workspace.projectGeneration) ? { projectGeneration: workspace.projectGeneration } : {}), savedOnly: true, command }; }
function compactResult(result, trace, nodeMap) { return { ...result, counts: { returned: trace.paths.length, found: trace.found, total: trace.totalExact ? trace.found : null, totalExact: trace.totalExact }, expandedStates: trace.expandedStates, completeWithinBounds: !trace.truncationReasons.length, truncationReasons: trace.truncationReasons, paths: trace.paths.map(path => compactPath(path, nodeMap)) }; }

export function queryWorkspace(workspace, request) {
  validateQuery(request);
  if (request.command === 'guide') return queryGuide();
  if (request.revision && request.revision !== workspace.revision) fail('REVISION_CONFLICT', '查询版本已改变，请重新读取项目状态');
  const result = meta(workspace, request.command);
  if (request.command === 'scopes') return { ...result, resourceRevisions: structuredClone(workspace.resourceRevisions), mechanics: workspace.mechanics.map(item => ({ id: item.id, name: item.name, scope: item.scope, nodeCount: item.focusNodeIds.length, edgeCount: workspace.rules.rules.filter(rule => item.pinnedRuleIds.includes(rule.id)).length })).sort(byId), views: workspace.views.map(item => ({ id: item.id, name: item.name })).sort(byId) };
  const graph = projectGraph(workspace), nodeMap = new Map(graph.nodes.map(node => [node.id, node]));
  if (request.command === 'search') {
    if (request.query) { const resolution = resolveConcept(graph.nodes, request.query); return resolution.status === 'resolved' ? { ...result, query: request.query, resolution: { status: 'resolved', matchedBy: resolution.matchedBy }, concept: nodeDTO(resolution.concept) } : { ...result, query: request.query, resolution }; }
    const from = resolveConcept(graph.nodes, request.from), to = resolveConcept(graph.nodes, request.to);
    if (from.status !== 'resolved' || to.status !== 'resolved') return { ...result, from: { key: request.from, ...from }, to: { key: request.to, ...to }, rules: null };
    const direct = (source, target) => graph.edges.filter(edge => edge.source === source.id && edge.target === target.id).map(edge => directRuleDTO(edge, nodeMap));
    return { ...result, from: { id: from.concept.id, label: from.concept.label, matchedBy: from.matchedBy }, to: { id: to.concept.id, label: to.concept.label, matchedBy: to.matchedBy }, rules: { forward: direct(from.concept, to.concept), reverse: direct(to.concept, from.concept) } };
  }
  if (request.command === 'node') {
    const center = nodeMap.get(request.id); if (!center) fail('NODE_NOT_FOUND', '概念 ID 不存在：' + request.id);
    const direction = request.direction ?? 'both', hops = request.hops ?? 1, maxPaths = request.maxPaths ?? limits.maxPaths[0], maxExpansions = request.maxExpansions ?? limits.maxExpansions[0], traces = {};
    if (direction !== 'downstream') traces.upstream = enumerateNodePaths({ edges: graph.edges, center: center.id, direction: 'upstream', hops, maxPaths, maxExpansions });
    if (direction !== 'upstream') traces.downstream = enumerateNodePaths({ edges: graph.edges, center: center.id, direction: 'downstream', hops, maxPaths, maxExpansions });
    return { ...result, center: refDTO(center), direction, hops, paths: Object.fromEntries(Object.entries(traces).map(([key, trace]) => [key, compactResult({}, trace, nodeMap)])) };
  }
  const from = nodeMap.get(request.from), to = nodeMap.get(request.to);
  if (!from || !to) fail('NODE_NOT_FOUND', 'impact 的 from 或 to 概念 ID 不存在');
  const trace = enumerateImpactPaths({ edges: graph.edges, from: from.id, to: to.id, maxPaths: request.maxPaths ?? limits.maxPaths[0], maxDepth: request.maxDepth ?? limits.maxDepth[0], maxExpansions: request.maxExpansions ?? limits.maxExpansions[0] });
  return { ...compactResult(result, trace, nodeMap), from: refDTO(from), to: refDTO(to) };
}
export const formatQueryText = result => JSON.stringify(result, null, 2);
