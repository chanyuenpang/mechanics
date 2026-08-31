// 纯领域计算：不访问文件、浏览器、游戏引擎，不修改传入的工作区。
export function compose(workspace, selectedIds) {
  const graphIds = [...new Set(selectedIds)].sort();
  const graphs = graphIds.map(id => {
    const graph = workspace.analyses.find(item => item.id === id);
    if (!graph) throw new Error(`选中的分析图不存在：${id}`);
    return graph;
  });
  const referenced = new Set(graphs.flatMap(graph => graph.nodeIds));
  return {
    graphIds,
    nodes: workspace.definitions.nodes.filter(node => referenced.has(node.id)).map(node => ({
      ...structuredClone(node), sourceGraphIds: graphs.filter(graph => graph.nodeIds.includes(node.id)).map(graph => graph.id),
    })),
    edges: graphs.flatMap(graph => graph.edges.map(edge => ({
      ...structuredClone(edge), id: `${graph.id}/${edge.id}`,
      steps: [{ graphId: graph.id, edgeId: edge.id, ...structuredClone(edge) }], hiddenNodes: [],
    }))).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function multiplySigns(signs) {
  if (signs.length === 0 || signs.some(sign => sign !== 1 && sign !== -1)) throw new Error('路径必须包含有效的正负关系');
  return signs.reduce((sign, next) => sign * next, 1);
}

function hasPath(graph, from, to) {
  const pending = [from];
  const visited = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (node === to) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const edge of graph.edges) if (edge.source === node) pending.push(edge.target);
  }
  return false;
}

export function canCollapse(graph, nodeId) {
  const incoming = graph.edges.filter(edge => edge.target === nodeId);
  const outgoing = graph.edges.filter(edge => edge.source === nodeId);
  if (incoming.length !== 1 || outgoing.length !== 1) return false;
  // 不能把环中的节点缩成一条似乎独立成立的影响路径。
  return !hasPath(graph, outgoing[0].target, incoming[0].source);
}

export function collapse(graph, nodeId) {
  if (!canCollapse(graph, nodeId)) throw new Error(`节点 ${nodeId} 有分支、并行关系、环或不是单入单出，不能折叠`);
  const first = graph.edges.find(edge => edge.target === nodeId);
  const last = graph.edges.find(edge => edge.source === nodeId);
  const steps = [...first.steps, ...last.steps];
  return {
    graphIds: [...graph.graphIds],
    nodes: graph.nodes.filter(node => node.id !== nodeId).map(node => structuredClone(node)),
    edges: [
      ...graph.edges.filter(edge => edge !== first && edge !== last).map(edge => structuredClone(edge)),
      {
        id: `fold:${steps.map(step => `${step.graphId}/${step.edgeId}`).join('|')}`,
        source: first.source, target: last.target, sign: first.sign * last.sign,
        condition: steps.map(step => step.condition).filter(Boolean).join('；'),
        note: '折叠路径摘要，不是新增的原始规则',
        steps: structuredClone(steps), hiddenNodes: [...first.hiddenNodes, nodeId, ...last.hiddenNodes],
      },
    ],
  };
}

export function tracePaths(graph, source, target, { maxPaths = 50, maxDepth = 16 } = {}) {
  if (!Number.isInteger(maxPaths) || maxPaths < 1 || !Number.isInteger(maxDepth) || maxDepth < 1) throw new Error('路径数量和深度上限必须是正整数');
  const ids = new Set(graph.nodes.map(node => node.id));
  if (!ids.has(source) || !ids.has(target)) throw new Error('查询端点不在当前组合中');
  const paths = [];
  let truncated = false;
  function visit(node, edges, seen) {
    if (node === target && edges.length) {
      if (paths.length >= maxPaths) { truncated = true; return; }
      paths.push({ sign: multiplySigns(edges.map(edge => edge.sign)), steps: edges.flatMap(edge => structuredClone(edge.steps)) });
      return;
    }
    const nextEdges = graph.edges.filter(edge => edge.source === node && !seen.has(edge.target));
    if (edges.length >= maxDepth) { if (nextEdges.length) truncated = true; return; }
    for (const edge of nextEdges) {
      if (paths.length >= maxPaths) { truncated = true; return; }
      visit(edge.target, [...edges, edge], new Set([...seen, edge.target]));
    }
  }
  visit(source, [], new Set([source]));
  return { graphIds: [...graph.graphIds], paths, truncated, interpretation: '仅解释当前模型中的有限简单路径；未找到不等于现实中无作用，不推断净收益或胜率。' };
}

export function diagnose(graph) {
  const findings = [];
  const patterns = new Map();
  for (const node of graph.nodes) {
    const incoming = graph.edges.filter(edge => edge.target === node.id);
    const outgoing = graph.edges.filter(edge => edge.source === node.id);
    if (!incoming.length && !outgoing.length) findings.push({ kind: 'isolated', nodeIds: [node.id], message: '当前选图中未连接；可能尚未建模，不等于无价值。' });
    else if (!outgoing.length) findings.push({ kind: 'sink', nodeIds: [node.id], message: '当前模型中的作用终点；可能是合理终局或消耗出口。' });
    const signature = [...incoming.map(edge => `in:${edge.source}:${edge.sign}`), ...outgoing.map(edge => `out:${edge.target}:${edge.sign}`)].sort().join('|');
    if (signature) patterns.set(signature, [...(patterns.get(signature) ?? []), node.id]);
  }
  for (const nodeIds of patterns.values()) if (nodeIds.length > 1) findings.push({ kind: 'similar', nodeIds, message: '连接结构相似；仍需比较条件、时机、成本和获得频率，不自动合并。' });
  return { graphIds: [...graph.graphIds], findings };
}
