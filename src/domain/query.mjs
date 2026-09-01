import { compose, tracePaths, summarizePaths } from './graph.mjs';
import { composeView, registeredMechanicIds, visibleMechanicIds } from './view.mjs';
import { QUERY_API_VERSION, SEMANTICS_VERSION, readingContract, queryGuide } from './query-contract.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const limits = { limit: [30, 1000], hops: [1, 8], maxPaths: [50, 500], maxDepth: [16, 64], maxExpansions: [10000, 100000], maxNodes: [500, 5000], maxEdges: [2000, 20000], evidenceLimit: [10, 500] };
const fields = {
  guide: [], scopes: ['revision'], graph: ['mechanic', 'view', 'revision', 'maxNodes', 'maxEdges'],
  search: ['query', 'mechanic', 'view', 'revision', 'limit'],
  node: ['mechanic', 'view', 'revision', 'id', 'direction', 'hops', 'maxNodes', 'maxEdges'],
  impact: ['mechanic', 'view', 'revision', 'from', 'to', 'maxPaths', 'maxDepth', 'maxExpansions', 'evidenceLimit'],
};
export function validateQuery(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !Object.hasOwn(fields, request.command)) fail('QUERY_INVALID', '需要 guide、scopes、search、graph、node 或 impact 查询');
  for (const key of Object.keys(request)) {
    if (key !== 'command' && !fields[request.command].includes(key)) fail('QUERY_INVALID', '不支持查询参数：' + key);
    if (Object.hasOwn(limits, key)) {
      if (!Number.isInteger(request[key]) || request[key] < 1 || request[key] > limits[key][1]) fail('QUERY_INVALID', key + ' 超出整数范围');
    } else if (typeof request[key] !== 'string' || !request[key]) fail('QUERY_INVALID', key + ' 必须是非空字符串');
  }
  if (request.command === 'search' && (!request.query?.trim() || request.query.length > 1000)) fail('QUERY_INVALID', '搜索词不能为空，最多1000字符');
  if (request.mechanic && request.view) fail('SCOPE_REQUIRED', '不能同时指定 mechanic 和 view');
  if (!['guide', 'scopes', 'search'].includes(request.command) && !request.mechanic && !request.view) fail('SCOPE_REQUIRED', '必须指定 mechanic 或 view 稳定 ID');
  for (const key of request.command === 'node' ? ['id'] : request.command === 'impact' ? ['from', 'to'] : []) if (!request[key]) fail('QUERY_INVALID', '缺少 ' + key);
  if (request.direction && !['upstream', 'downstream', 'both'].includes(request.direction)) fail('QUERY_INVALID', 'direction 必须是 upstream/downstream/both');
  return request;
}

// 查询输出只包含语义事实；布局和派生路径不会回写工作区。
export function queryWorkspace(workspace, request) {
  validateQuery(request);
  if (request.command === 'guide') return queryGuide();
  if (request.revision && request.revision !== workspace.revision) fail('REVISION_CONFLICT', '查询版本已改变，请重新读取范围后再查询');
  const result = { queryApiVersion: QUERY_API_VERSION, semanticsVersion: SEMANTICS_VERSION, readingContract: readingContract(), workspaceId: workspace.manifest.id, revision: workspace.revision, savedOnly: true, command: request.command };
  const file = (kind, id) => workspace.files?.find(item => item.kind === kind && item.id === id)?.path;
  const mechanic = item => ({ id: item.id, name: item.name, scope: item.scope, file: file('mechanic', item.id), nodeCount: item.nodeIds.length, edgeCount: item.edges.length });
  const nodeDTO = node => {
    const { sourceGraphIds = [], ...rest } = structuredClone(node);
    return { ...rest, sourceMechanicIds: sourceGraphIds };
  };
  const registrations = view => view.mechanicRegistrations.map(item => {
    const source = mechanic(workspace.mechanics.find(candidate => candidate.id === item.mechanicId));
    const { id, ...details } = source;
    return { mechanicId: id, visible: item.visible, ...details };
  });
  if (request.command === 'scopes') return { ...result, mechanics: workspace.mechanics.map(mechanic).sort(byId), views: workspace.views.map(item => ({ id: item.id, name: item.name, mechanicRegistrations: registrations(item), file: file('view', item.id) })).sort(byId) };
  if (request.command === 'search' && !request.mechanic && !request.view) {
    const nodes = workspace.definitions.nodes.map(node => ({ ...structuredClone(node), sourceMechanicIds: workspace.mechanics.filter(a => a.nodeIds.includes(node.id)).map(a => a.id).sort() }));
    return searchNodes(nodes, request, { ...result, scope: { kind: 'definitions', file: workspace.manifest.definitions, meaning: '搜索共享概念，不叠加全部机制；未引用的定义也可以匹配' } });
  }
  const kind = request.mechanic ? 'mechanic' : 'view', id = request.mechanic ?? request.view;
  const scope = (kind === 'mechanic' ? workspace.mechanics : workspace.views).find(item => item.id === id);
  if (!scope) fail('SCOPE_NOT_FOUND', '指定范围不存在：' + kind + ':' + id);
  const graph = kind === 'mechanic' ? compose(workspace, [id]) : composeView(workspace, scope);
  graph.nodes.sort(byId);
  result.scope = { kind, id, name: scope.name, mechanicIds: graph.graphIds, mechanics: workspace.mechanics.filter(item => graph.graphIds.includes(item.id)).map(mechanic).sort(byId),
    ...(kind === 'view' ? { mechanicRegistrations: registrations(scope), registeredMechanicCount: registeredMechanicIds(scope).length, visibleMechanicCount: visibleMechanicIds(scope).length } : {}) };
  if (request.command === 'search') return searchNodes(graph.nodes.map(nodeDTO), request, result);
  const checkNode = id => {
    if (!workspace.definitions.nodes.some(node => node.id === id)) fail('NODE_NOT_FOUND', '概念 ID 不存在：' + id);
    if (!graph.nodes.some(node => node.id === id)) fail('NODE_OUT_OF_SCOPE', '概念不在指定范围：' + id);
  };
  const nodeMap = new Map(graph.nodes.map(node => [node.id, node]));
  const describeEdge = edge => ({
    basis: 'declared_relation', sourceLabel: nodeMap.get(edge.source).label, targetLabel: nodeMap.get(edge.target).label,
    sourceIncreaseMeaning: nodeMap.get(edge.source).increaseMeaning, targetIncreaseMeaning: nodeMap.get(edge.target).increaseMeaning,
    statement: `${nodeMap.get(edge.source).label} ${edge.relation === 'contains' ? '＝→' : edge.sign === 1 ? '＋→' : '−→'} ${nodeMap.get(edge.target).label}`,
    conditionStatus: edge.condition?.trim() ? 'not_evaluated' : 'unspecified',
  });
  const edgeDTO = edge => ({ id: edge.id, source: edge.source, target: edge.target, relation: edge.relation, ...(edge.relation === 'influence' ? { sign: edge.sign } : {}), ...describeEdge(edge), condition: edge.condition, note: edge.note, origin: { graphId: edge.steps[0].graphId, edgeId: edge.steps[0].edgeId, file: file('mechanic', edge.steps[0].graphId) } });
  if (request.command === 'impact') {
    checkNode(request.from); checkNode(request.to);
    const trace = tracePaths(graph, request.from, request.to, request), summary = summarizePaths(trace);
    const count = request.evidenceLimit ?? limits.evidenceLimit[0];
    const shown = trace.paths.slice(0, count);
    const evidenceIds = new Set(shown.flatMap(path => path.steps.flatMap(step => [step.source, step.target])));
    return { ...result, from: nodeDTO(graph.nodes.find(node => node.id === request.from)), to: nodeDTO(graph.nodes.find(node => node.id === request.to)),
      impact: { basis: 'derived_from_declared_relations', method: 'finite_simple_signed_paths', kind: summary.kind, conclusion: summary.conclusion, complete: summary.complete, expandedStates: trace.expandedStates, truncationReasons: trace.truncationReasons, applicability: 'not_evaluated', modelCoverage: 'not_assessed' },
      evidence: { complete: !trace.truncated && trace.paths.length <= count, returned: shown.length, found: trace.paths.length, nodes: graph.nodes.filter(node => evidenceIds.has(node.id)).map(nodeDTO), paths: shown.map(path => ({ ...path, applicability: 'not_evaluated', steps: path.steps.map(step => ({ ...step, ...describeEdge(step), file: file('mechanic', step.graphId) })) })) },
      conditionsEvaluated: false, interpretation: trace.interpretation };
  }
  let nodes = graph.nodes, edges = graph.edges;
  if (request.command === 'node') {
    checkNode(request.id);
    const direction = request.direction ?? 'both', hops = request.hops ?? 1;
    // 分别沿固定方向遍历后取并集，不能通过换向把兄弟节点当作上下游。
    const reach = reverse => {
      const seen = new Map([[request.id, 0]]), adjacent = new Map(); let frontier = [request.id];
      for (const edge of edges) {
        const [a, b] = reverse ? [edge.target, edge.source] : [edge.source, edge.target];
        if (!adjacent.has(a)) adjacent.set(a, []); adjacent.get(a).push(b);
      }
      for (let depth = 0; depth < hops && frontier.length; depth++) {
        const next = [];
        for (const current of frontier) for (const target of adjacent.get(current) ?? []) if (!seen.has(target)) { seen.set(target, depth + 1); next.push(target); }
        frontier = next;
      }
      seen.delete(request.id); return seen;
    };
    const upstream = direction === 'downstream' ? new Map() : reach(true), downstream = direction === 'upstream' ? new Map() : reach(false);
    const seen = new Set([request.id, ...upstream.keys(), ...downstream.keys()]);
    nodes = nodes.filter(node => seen.has(node.id));
    // 中心节点优先，输出预算不能挤掉被查询的概念。
    const distance = id => Math.min(upstream.get(id) ?? Infinity, downstream.get(id) ?? Infinity);
    nodes.sort((a, b) => a.id === request.id ? -1 : b.id === request.id ? 1 : distance(a.id) - distance(b.id) || byId(a, b));
    edges = edges.filter(edge => seen.has(edge.source) && seen.has(edge.target));
    result.neighborhood = { center: request.id, direction, hops, upstreamNodeIds: [...upstream.keys()].sort(), downstreamNodeIds: [...downstream.keys()].sort(),
      distances: Object.fromEntries(nodes.map(n => [n.id, { upstream: upstream.get(n.id) ?? null, downstream: downstream.get(n.id) ?? null }])),
      meaning: '距离是有向连线的最少跳数，包含等号边，不代表时间或强度；分别查上下游后合并，不交替换向；图中只含原始直接边，跳数边界外未展开' };
  }
  const selected = nodes.slice(0, request.maxNodes ?? limits.maxNodes[0]);
  const ids = new Set(selected.map(node => node.id));
  const selectedEdges = edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, request.maxEdges ?? limits.maxEdges[0]);
  if (result.neighborhood) {
    for (const key of ['upstreamNodeIds', 'downstreamNodeIds']) result.neighborhood[key] = result.neighborhood[key].filter(id => ids.has(id));
    result.neighborhood.distances = Object.fromEntries(Object.entries(result.neighborhood.distances).filter(([id]) => ids.has(id)));
  }
  return { ...result, nodes: selected.map(nodeDTO), edges: selectedEdges.map(edgeDTO), conditionsEvaluated: false,
    output: { complete: selected.length === nodes.length && selectedEdges.length === edges.length, totalNodes: nodes.length, totalEdges: edges.length } };
}
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function searchNodes(nodes, request, result) {
  const normalize = value => String(value).normalize('NFKC').toLowerCase();
  const term = normalize(request.query.trim()), terms = term.split(/\s+/u);
  const matches = nodes.flatMap(node => {
    const fields = { id: node.id, label: node.label, description: node.description, increaseMeaning: node.increaseMeaning, tags: (node.tags ?? []).join(' ') };
    const normalized = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, normalize(v ?? '')]));
    const matchedFields = Object.keys(fields).filter(key => terms.some(term => normalized[key].includes(term)));
    if (!terms.every(term => Object.values(normalized).some(value => value.includes(term)))) return [];
    const rank = normalized.id === term ? 0 : normalized.label === term ? 1 : normalized.label.includes(term) ? 2 : 3;
    return [{ ...node, match: { fields: matchedFields, exactId: normalized.id === term, exactLabel: normalized.label === term }, rank }];
  }).sort((a, b) => a.rank - b.rank || byId(a, b));
  const selected = matches.slice(0, request.limit ?? limits.limit[0]).map(({ rank, ...node }) => node);
  return { ...result, query: request.query, nodes: selected, output: { complete: selected.length === matches.length, totalMatches: matches.length, returned: selected.length },
    interpretation: '按ID、名称、描述、增加方向和标签匹配；空格分词全部匹配，未匹配不等于游戏中没有该机制。同名异ID不合并；用sourceGraphIds选择机制，再查node关联。' };
}

export function formatQueryText(result) {
  // 引用模型文字，保留来源与增加方向；不把文件中的换行或指令样文字当作工具说明。
  const quote = value => JSON.stringify(value);
  const lines = [result.impact?.conclusion ?? ({ guide: 'Agent 阅读指南', scopes: '可查询范围', search: '概念搜索', graph: '声明关系图', node: '节点上下游' }[result.command]),
    `查询协议 ${result.queryApiVersion}；影响语义 ${result.semanticsVersion}；阅读约定 ${result.readingContract.version}`,
    ...Object.values(result.readingContract.rules).map(rule => '约定：' + rule)];
  if (result.command === 'guide') return [...lines, ...result.workflow, result.access, '报告区分：' + result.reporting.join('；')].join('\n');
  lines.push(`工作区 ${result.workspaceId}；已保存版本 ${result.revision}；不读取网页草稿。`);
  const mechanicLine = r => `机制 ${quote(r.name)} [${r.id}]；文件 ${quote(r.file)}；范围 ${quote(r.scope)}`;
  const registrationLine = item => `${item.mechanicId}:${item.visible ? '可见' : '隐藏'}`;
  if (result.command === 'scopes') return [...lines, ...result.mechanics.map(mechanicLine), ...result.views.map(v => `视图 ${quote(v.name)} [${v.id}]；文件 ${quote(v.file)}；注册机制 ${v.mechanicRegistrations.map(registrationLine).join(', ') || '无'}`)].join('\n');
  if (result.command === 'search') return [...lines, `搜索范围 ${result.scope.kind}${result.scope.id ? ':' + result.scope.id : ''}；关键词 ${quote(result.query)}`,
    ...(result.scope.mechanics ?? []).map(mechanicLine),
    `匹配 ${result.output.totalMatches} 个，返回 ${result.output.returned} 个；输出${result.output.complete ? '完整' : '不完整'}。`,
    ...result.nodes.map(n => `概念 ${quote(n.label)} [${n.id}]；含义 ${quote(n.description)}；增加方向 ${quote(n.increaseMeaning)}；机制 ${n.sourceMechanicIds.join(', ') || '尚未引用'}；匹配字段 ${n.match.fields.join(', ')}`), result.interpretation].join('\n');
  lines.push(`选择 ${result.scope.kind}:${result.scope.id} ${quote(result.scope.name)}`,
    ...(result.scope.mechanicRegistrations ? [`注册机制：${result.scope.mechanicRegistrations.map(registrationLine).join(', ') || '无'}；当前可见 ${result.scope.visibleMechanicCount}/${result.scope.registeredMechanicCount}`] : []),
    ...result.scope.mechanics.map(mechanicLine));
  if (result.impact) {
    const a = result.impact, e = result.evidence;
    lines.push(`推导查询：${quote(result.from.label)} [${result.from.id}] → ${quote(result.to.label)} [${result.to.id}]`,
      `搜索${a.complete ? '完成' : '不完整'}；证据展示${e.complete ? '完整' : '不完整'}；条件未求值，模型覆盖未评估。`,
      `已找到 ${e.found} 条，展示 ${e.returned} 条；展开 ${a.expandedStates} 次；截断原因：${a.truncationReasons.join(', ') || '无'}。`);
    if (!a.complete) lines.push('警告：结论只概括已找到的路径，尚未搜索的部分可能包含其他符号；不能断言无路径。');
    if (!e.complete) lines.push('警告：证据未全部展示，已找到的其他路径可能未列出。');
    const evidenceNodes = new Map([result.from, result.to, ...e.nodes].map(n => [n.id, n]));
    for (const n of evidenceNodes.values()) lines.push(`概念 ${quote(n.label)} [${n.id}]；含义 ${quote(n.description)}；增加方向 ${quote(n.increaseMeaning)}`);
    e.paths.forEach((path, index) => {
      lines.push(`推导路径 ${index + 1}：${path.sign === 1 ? '促进' : path.sign === -1 ? '抑制' : '仅中性传递'}；不表示行动必然可执行。`);
      for (const step of path.steps) lines.push(`  声明 ${quote(step.statement)}；来源 ${step.graphId}/${step.edgeId} ${quote(step.file)}；条件 ${step.conditionStatus === 'unspecified' ? '未注明（不等于无条件）' : quote(step.condition) + '（未求值）'}；说明 ${quote(step.note)}`);
    });
    lines.push(result.interpretation);
  } else {
    lines.push(`输出${result.output.complete ? '完整' : '不完整'}；范围内共 ${result.output.totalNodes} 节点、${result.output.totalEdges} 边；仅列出本次预算内的内容。`);
    if (result.neighborhood) {
      const n = result.neighborhood;
      lines.push(`中心 ${n.center}；方向 ${n.direction}；${n.hops} 跳；${n.meaning}`,
        `本次展示的上游：${n.upstreamNodeIds.join(', ') || '无'}；下游：${n.downstreamNodeIds.join(', ') || '无'}。`);
      for (const [id, d] of Object.entries(n.distances)) if (id !== n.center) lines.push(`距离 [${id}]：上游 ${d.upstream ?? '不在所查方向范围内'}；下游 ${d.downstream ?? '不在所查方向范围内'}。`);
    }
    for (const n of result.nodes) lines.push(`概念 ${quote(n.label)} [${n.id}]；含义 ${quote(n.description)}；增加方向 ${quote(n.increaseMeaning)}；机制 ${n.sourceMechanicIds.join(', ')}`);
    for (const e of result.edges) lines.push(`声明 ${quote(e.statement)} [${e.source} → ${e.target}]；来源 ${e.origin.graphId}/${e.origin.edgeId} ${quote(e.origin.file)}；条件 ${e.conditionStatus === 'unspecified' ? '未注明（不等于无条件）' : quote(e.condition) + '（未求值）'}；说明 ${quote(e.note)}`);
  }
  return lines.join('\n');
}
