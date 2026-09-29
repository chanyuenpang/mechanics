import { assertReadGraphIntegrity } from './read-graph-integrity.mjs';

// 端点限定词是规则的参与者范围，不是新的共享概念。此模块只创建画布读取模型。
const valueKey = value => value.kind === 'concept'
  ? `concept:${value.conceptId}`
  : `literal:${typeof value.value}:${JSON.stringify(value.value)}`;

export function normalizedQualifierKey(qualifiers = []) {
  return qualifiers
    .map(item => `${item.key}=${valueKey(item.value)}`)
    .sort((left, right) => left.localeCompare(right))
    .join('|');
}

export function endpointProjectionId(baseConceptId, qualifiers) {
  return `scope:${baseConceptId}:${encodeURIComponent(normalizedQualifierKey(qualifiers))}`;
}

// 不推断跨端点绑定：每个投影只替换自己声明了限定词的那个端点。
export function projectEndpointQualifiers(graph) {
  assertReadGraphIntegrity(graph, '端点限定投影输入');
  const canonicalNodes = new Map(graph.nodes.map(node => [node.id, node]));
  const projections = new Map();
  const endpoint = (baseConceptId, qualifiers = []) => {
    if (!qualifiers.length) return baseConceptId;
    const base = canonicalNodes.get(baseConceptId);
    const id = endpointProjectionId(baseConceptId, qualifiers);
    if (!projections.has(id)) projections.set(id, {
      id,
      label: base.label,
      description: base.description,
      qualifiers: structuredClone(qualifiers),
      baseConceptId,
      canonicalNodeId: baseConceptId,
      scopeProjection: true,
      sourceGraphIds: structuredClone(base.sourceGraphIds ?? []),
    });
    return id;
  };
  const edges = graph.edges.map(edge => ({
    ...structuredClone(edge),
    source: endpoint(edge.source, edge.sourceQualifiers),
    target: endpoint(edge.target, edge.targetQualifiers),
    canonicalSource: edge.source,
    canonicalTarget: edge.target,
  }));
  // 仅当基础概念的全部可见端点都已被限定投影承接，才隐藏重复的基础实例。
  // 混用未限定端点时，基础节点仍是这些边的端点，不能随限定实例一起移除。
  // 没有规则的焦点节点也没有被替代，必须继续保留。
  const replacedBaseIds = new Set([...projections.values()].map(projection => projection.baseConceptId));
  const plainEndpointIds = new Set(edges.flatMap(edge => [edge.source, edge.target]));
  return assertReadGraphIntegrity({ ...structuredClone(graph), nodes: [
    ...graph.nodes.filter(node => !replacedBaseIds.has(node.id) || plainEndpointIds.has(node.id)).map(node => structuredClone(node)),
    ...projections.values(),
  ], edges }, '端点限定投影输出');
}

export const isEndpointProjection = node => node?.scopeProjection === true;
