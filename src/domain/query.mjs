import { QUERY_API_VERSION, SEMANTICS_VERSION, readingContract, queryGuide } from './query-contract.mjs';
import { normalizeSearchTerm } from './identity.mjs';
import { compactPath, enumerateImpactPaths, enumerateNodePaths, taxonomyContext } from './query-paths.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const limits = { hops: [1, 64], maxPaths: [50, 500], maxDepth: [16, 64], maxExpansions: [10000, 100000] };
const fields = { guide: [], scopes: ['revision'], search: ['revision', 'query', 'from', 'to'], node: ['revision', 'id', 'direction', 'hops', 'maxPaths', 'maxExpansions', 'includeInherited'], impact: ['revision', 'from', 'to', 'maxPaths', 'maxDepth', 'maxExpansions', 'includeInherited'] };

// 配对绑定模板由工具拥有，不是可执行的战斗规则；它只说明"上限概念裁剪资源概念的留存值"。
// 具体数值、来源与例外仍由作者写在规则文字或内容配置里。
const RETENTION_TEMPLATE = {
  id: 'retention-pair',
  ruleText: '上限概念的持有者在自身回合开始时，按上限概念当前层数裁剪资源概念的留存值，随后上限概念减少 1 层；上限为零时资源完整清零。',
};
const byId = (a, b) => String(a.id).localeCompare(String(b.id));

export function validateQuery(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !Object.hasOwn(fields, request.command)) fail('QUERY_INVALID', '需要 guide、scopes、search、node 或 impact 查询');
  for (const key of Object.keys(request)) {
    if (key !== 'command' && !fields[request.command].includes(key)) fail('QUERY_INVALID', '不支持查询参数：' + key);
    if (key === 'includeInherited') {
      if (typeof request[key] !== 'boolean' && request[key] !== 'true' && request[key] !== 'false') fail('QUERY_INVALID', 'includeInherited 必须是布尔值');
      continue;
    }
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
const nodeDTO = node => ({ id: node.id, label: node.label, description: node.description, aliases: structuredClone(node.aliases ?? []), tagIds: structuredClone(node.tagIds ?? []), ...(node.customData ? { customData: node.customData } : {}) });
const refDTO = node => ({ id: node.id, label: node.label });

// 精确解析失败后的模糊候选：只提供线索，绝不自动消歧——调用方必须用候选里的稳定 ID 再查一次。
// 同一字段同时命中前缀与包含时只记最强那一档，matchedBy 因此不重复描述同一次命中。
const FUZZY_FIELDS = [
  { field: 'label', mode: 'prefix', matchedBy: 'label-prefix', score: 100, texts: node => [node.label] },
  { field: 'alias', mode: 'prefix', matchedBy: 'alias-prefix', score: 90, texts: node => node.aliases ?? [] },
  { field: 'label', mode: 'contains', matchedBy: 'label-contains', score: 80, texts: node => [node.label] },
  { field: 'alias', mode: 'contains', matchedBy: 'alias-contains', score: 70, texts: node => node.aliases ?? [] },
  { field: 'id', mode: 'contains', matchedBy: 'id-contains', score: 60, texts: node => [node.id] },
  { field: 'description', mode: 'contains', matchedBy: 'description-contains', score: 40, texts: node => [node.description] },
];
const FUZZY_CANDIDATE_LIMIT = 20;
const fuzzyFieldHit = (field, needle, node) => field.texts(node).some(value => {
  const text = value === undefined || value === null ? '' : normalizeSearchTerm(value);
  return text ? (field.mode === 'prefix' ? text.startsWith(needle) : text.includes(needle)) : false;
});

export function fuzzyCandidates(nodes, key) {
  const needle = normalizeSearchTerm(key);
  if (!needle) return undefined;
  const matches = [];
  for (const node of nodes) {
    const matchedBy = [], scores = [], prefixed = new Set();
    for (const field of FUZZY_FIELDS) {
      if (field.mode === 'contains' && prefixed.has(field.field)) continue;
      if (!fuzzyFieldHit(field, needle, node)) continue;
      if (field.mode === 'prefix') prefixed.add(field.field);
      matchedBy.push(field.matchedBy); scores.push(field.score);
    }
    if (matchedBy.length) matches.push({ id: node.id, label: node.label, matchedBy, score: Math.max(...scores) });
  }
  if (!matches.length) return undefined;
  matches.sort((left, right) => right.score - left.score || byId(left, right));
  return { status: 'fuzzy', key, candidates: matches.slice(0, FUZZY_CANDIDATE_LIMIT), total: matches.length, truncated: matches.length > FUZZY_CANDIDATE_LIMIT };
}

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
// 显式请求继承时才计算派生边：它只由一等配对绑定生成，因此两端各自的 is-a 特化
// 永远不会产生交叉配对。派生边不落盘、不级联，且与作者声明的同端点规则不并存。
function derivedRetentionEdges(workspace, nodeMap) {
  const saved = new Set(workspace.rules.rules.map(rule => `${rule.source}\u0000${rule.target}`));
  const edges = [...retentionBindingEdges(workspace, nodeMap, saved), ...specializeEndpointEdges(workspace, saved)];
  return edges.sort((a, b) => a.id.localeCompare(b.id));
}

// inheritance.mode === 'specializeEndpoint' 的显式继承：只对声明的端点沿 is-a 向下替换，
// 未声明的端点保持原样。同一后代若存在多条特化路径则判为歧义并显式失败。
function specializeEndpointEdges(workspace, saved) {
  const children = new Map();
  for (const rule of workspace.rules.rules) if (rule.relation === 'specializes') {
    if (!children.has(rule.target)) children.set(rule.target, new Set());
    children.get(rule.target).add(rule.source);
  }
  const expand = (id, hops, ruleId) => {
    const reached = new Map([[id, [id]]]);
    let frontier = [id];
    for (let hop = 0; hop < hops && frontier.length; hop++) {
      const next = [];
      for (const current of [...frontier].sort()) for (const child of [...(children.get(current) ?? [])].sort()) {
        if (reached.has(child)) {
          const existing = reached.get(child);
          if (existing.length !== reached.get(current).length + 1) continue;
          throw Object.assign(new Error(`规则 ${ruleId} 的特化路径存在歧义：${child} 可由多条等长路径到达`), { code: 'SPECIALIZATION_AMBIGUOUS' });
        }
        reached.set(child, [...reached.get(current), child]);
        next.push(child);
      }
      frontier = next;
    }
    return reached;
  };
  const edges = [];
  for (const rule of workspace.rules.rules) {
    const policy = rule.inheritance;
    if (rule.relation !== 'influence' || !policy || policy.mode !== 'specializeEndpoint') continue;
    const sources = policy.endpoints.includes('source') ? expand(rule.source, policy.maxSpecializationHops, rule.id) : new Map([[rule.source, [rule.source]]]);
    const targets = policy.endpoints.includes('target') ? expand(rule.target, policy.maxSpecializationHops, rule.id) : new Map([[rule.target, [rule.target]]]);
    for (const [source, sourcePath] of sources) for (const [target, targetPath] of targets) {
      if (source === rule.source && target === rule.target) continue;
      if (saved.has(`${source}\u0000${target}`)) continue;
      edges.push({ id: `inherit:${rule.id}:${source}:${target}`, source, target, relation: 'influence', sign: rule.sign,
        ruleText: rule.ruleText ?? '', derived: true,
        origin: { ruleId: rule.id, mode: policy.mode, maxSpecializationHops: policy.maxSpecializationHops },
        specializationPath: { source: sourcePath, target: targetPath },
        substitutedEndpoint: [...(source === rule.source ? [] : ['source']), ...(target === rule.target ? [] : ['target'])] });
    }
  }
  return edges;
}

function retentionBindingEdges(workspace, nodeMap, saved) {
  const edges = [];
  for (const binding of workspace.rules.retentionBindings ?? []) {
    if (!nodeMap.has(binding.capConceptId) || !nodeMap.has(binding.resourceConceptId)) continue;
    if (saved.has(`${binding.capConceptId}\u0000${binding.resourceConceptId}`)) continue;
    edges.push({ id: `binding:${binding.id}`, source: binding.capConceptId, target: binding.resourceConceptId,
      relation: 'influence', sign: 1, ruleText: RETENTION_TEMPLATE.ruleText, derived: true,
      origin: { bindingId: binding.id, mechanismConceptId: binding.mechanismConceptId, templateId: RETENTION_TEMPLATE.id } });
  }
  return edges;
}

function meta(workspace, command) { return { queryApiVersion: QUERY_API_VERSION, semanticsVersion: SEMANTICS_VERSION, readingContract: { version: readingContract().version }, workspaceId: workspace.manifest.id, revision: workspace.revision, ...(Number.isInteger(workspace.projectGeneration) ? { projectGeneration: workspace.projectGeneration } : {}), savedOnly: true, command, mechanicStatuses: Object.fromEntries(workspace.mechanics.map(item => [item.id, item.implementationStatus])) }; }
function compactResult(result, trace, nodeMap) { return { ...result, counts: { returned: trace.paths.length, found: trace.found, total: trace.totalExact ? trace.found : null, totalExact: trace.totalExact }, expandedStates: trace.expandedStates, completeWithinBounds: !trace.truncationReasons.length, truncationReasons: trace.truncationReasons, paths: trace.paths.map(path => compactPath(path, nodeMap)) }; }

export function queryWorkspace(workspace, request) {
  validateQuery(request);
  if (request.command === 'guide') return queryGuide();
  if (request.revision && request.revision !== workspace.revision) fail('REVISION_CONFLICT', '查询版本已改变，请重新读取项目状态');
  const result = meta(workspace, request.command);
  if (request.command === 'scopes') return { ...result, resourceRevisions: structuredClone(workspace.resourceRevisions), mechanics: workspace.mechanics.map(item => ({ id: item.id, name: item.name, scope: item.scope, implementationStatus: item.implementationStatus, nodeCount: item.focusNodeIds.length, edgeCount: workspace.rules.rules.filter(rule => item.pinnedRuleIds.includes(rule.id)).length })).sort(byId), views: workspace.views.map(item => ({ id: item.id, name: item.name })).sort(byId) };
  const graph = projectGraph(workspace), nodeMap = new Map(graph.nodes.map(node => [node.id, node]));
  if (request.command === 'search') {
    if (request.query) { const resolution = resolveConcept(graph.nodes, request.query); if (resolution.status === 'resolved') return { ...result, query: request.query, resolution: { status: 'resolved', matchedBy: resolution.matchedBy }, concept: nodeDTO(resolution.concept) }; if (resolution.status === 'ambiguous') return { ...result, query: request.query, resolution }; return { ...result, query: request.query, resolution: fuzzyCandidates(graph.nodes, request.query) ?? resolution }; }
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
    return { ...result, center: refDTO(center), direction, hops, paths: Object.fromEntries(Object.entries(traces).map(([key, trace]) => [key, compactResult({}, trace, nodeMap)])),
      taxonomy: taxonomyContext({ edges: graph.edges, from: center.id, hops }) };
  }
  const from = nodeMap.get(request.from), to = nodeMap.get(request.to);
  if (!from || !to) fail('NODE_NOT_FOUND', 'impact 的 from 或 to 概念 ID 不存在');
  const inherited = request.includeInherited === true || request.includeInherited === 'true' ? derivedRetentionEdges(workspace, nodeMap) : [];
  const trace = enumerateImpactPaths({ edges: [...graph.edges, ...inherited], from: from.id, to: to.id, maxPaths: request.maxPaths ?? limits.maxPaths[0], maxDepth: request.maxDepth ?? limits.maxDepth[0], maxExpansions: request.maxExpansions ?? limits.maxExpansions[0] });
  return { ...compactResult(result, trace, nodeMap), from: refDTO(from), to: refDTO(to),
    includedDerivedEdges: inherited.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, origin: edge.origin })) };
}
export const formatQueryText = result => JSON.stringify(result, null, 2);
