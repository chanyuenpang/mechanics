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
  // 只有「全部可见端点都被限定投影承接」的基础概念才是应当隐藏的画布孤点——它已经被
  // 上面的限定投影替代，再画一遍会是同一个概念的第二个实例。
  // 没有任何规则的概念（例如刚引用进机制图、或刚清除了 is-a 的焦点节点）必须保留：
  // 它不在任何边上，但它是这张图明确引用的成员，丢掉它会让节点从画布上凭空消失。
  const replacedBaseIds = new Set([...projections.values()].map(projection => projection.baseConceptId));
  return { ...structuredClone(graph), nodes: [
    ...graph.nodes.filter(node => !replacedBaseIds.has(node.id)).map(node => structuredClone(node)),
    ...projections.values(),
  ], edges };
}

export const isEndpointProjection = node => node?.scopeProjection === true;
