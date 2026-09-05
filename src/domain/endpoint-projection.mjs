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
  const canonicalNodes = new Map(graph.nodes.map(node => [node.id, node]));
  const projections = new Map();
  const endpoint = (baseConceptId, qualifiers = []) => {
    if (!qualifiers.length) return baseConceptId;
    const base = canonicalNodes.get(baseConceptId);
    if (!base) return baseConceptId;
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
  // 若基础概念的所有可见端点都已由限定投影承接，则它会成为画布孤点；保留 canonical，隐藏该显示实例。
  const visibleNodeIds = new Set(edges.flatMap(edge => [edge.source, edge.target]));
  return { ...structuredClone(graph), nodes: [
    ...graph.nodes.filter(node => visibleNodeIds.has(node.id)).map(node => structuredClone(node)),
    ...projections.values(),
  ], edges };
}

export const isEndpointProjection = node => node?.scopeProjection === true;
