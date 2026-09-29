// 读取图在每个投影边界都必须自洽；canonical 文件引用仍由 validate.mjs 校验。
export function assertReadGraphIntegrity(graph, stage) {
  const ids = new Set();
  for (const node of graph.nodes) {
    if (typeof node?.id !== 'string' || !node.id) {
      const error = new Error(`读取图 ${stage} 存在无效节点 ID：${String(node?.id)}`);
      error.code = 'READ_GRAPH_INVALID_NODE'; error.stage = stage; error.nodeId = node?.id;
      throw error;
    }
    if (ids.has(node.id)) {
      const error = new Error(`读取图 ${stage} 存在重复节点：${node.id}`);
      error.code = 'READ_GRAPH_DUPLICATE_NODE';
      error.stage = stage; error.nodeId = node.id;
      throw error;
    }
    ids.add(node.id);
  }
  for (const edge of graph.edges) for (const endpoint of ['source', 'target']) {
    if (ids.has(edge[endpoint])) continue;
    const error = new Error(`读取图 ${stage} 的边 ${edge.id} 缺少${endpoint === 'source' ? '来源' : '目标'}节点：${String(edge[endpoint])}`);
    error.code = 'READ_GRAPH_MISSING_ENDPOINT';
    error.stage = stage; error.edgeId = edge.id; error.endpoint = endpoint; error.nodeId = edge[endpoint];
    throw error;
  }
  return graph;
}
