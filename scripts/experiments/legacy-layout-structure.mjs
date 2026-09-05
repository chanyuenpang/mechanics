// 历史分组与端口实验，仅用于对照验证；正式编辑器不再调用。
const canonicalGraph = graph => ({ ...graph,
  nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
  edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
});

// 分区只看图结构，不解释节点名称、关系类型、规则文字或任何游戏语义。
// 首个保守候选源是无向投影的双连通块：一个割点不会成为两个区域的“胶水”，
// 桥与树形链条也不会被误装进盒子。之后由收缩收益选择互不重叠的候选。
function cohesiveClusters(graph) {
  if (graph.nodes.length < 3) return null;
  const ids = graph.nodes.map(node => node.id).sort();
  const edges = graph.edges.filter(edge => edge.source !== edge.target && ids.includes(edge.source) && ids.includes(edge.target));
  const adjacency = new Map(ids.map(id => [id, []]));
  for (const edge of edges) { adjacency.get(edge.source).push(edge); adjacency.get(edge.target).push(edge); }
  for (const list of adjacency.values()) list.sort((left, right) => left.id.localeCompare(right.id));
  const discovery = new Map(), low = new Map(), stack = [], blocks = [];
  let time = 0;
  const visit = (nodeId, parentEdgeId = null) => {
    discovery.set(nodeId, ++time); low.set(nodeId, time);
    for (const edge of adjacency.get(nodeId)) {
      const otherId = edge.source === nodeId ? edge.target : edge.source;
      if (edge.id === parentEdgeId) continue;
      if (!discovery.has(otherId)) {
        stack.push(edge);
        visit(otherId, edge.id);
        low.set(nodeId, Math.min(low.get(nodeId), low.get(otherId)));
        if (low.get(otherId) >= discovery.get(nodeId)) {
          const block = [];
          while (stack.length) { const item = stack.pop(); block.push(item); if (item.id === edge.id) break; }
          blocks.push(block);
        }
      } else if (discovery.get(otherId) < discovery.get(nodeId)) {
        stack.push(edge);
        low.set(nodeId, Math.min(low.get(nodeId), discovery.get(otherId)));
      }
    }
  };
  for (const id of ids) if (!discovery.has(id)) visit(id);
  const componentSize = new Map();
  const seen = new Set();
  for (const startId of ids) if (!seen.has(startId)) {
    const reached = new Set([startId]);
    for (const id of reached) for (const edge of adjacency.get(id)) reached.add(edge.source === id ? edge.target : edge.source);
    for (const id of reached) { seen.add(id); componentSize.set(id, reached.size); }
  }
  const candidates = blocks.map(block => {
    const members = [...new Set(block.flatMap(edge => [edge.source, edge.target]))].sort();
    const memberSet = new Set(members);
    const internalEdgeCount = edges.filter(edge => memberSet.has(edge.source) && memberSet.has(edge.target)).length;
    const boundaryEdgeCount = edges.filter(edge => memberSet.has(edge.source) !== memberSet.has(edge.target)).length;
    const internalNeighbors = new Map(members.map(id => [id, new Set()]));
    for (const edge of edges.filter(edge => memberSet.has(edge.source) && memberSet.has(edge.target))) {
      internalNeighbors.get(edge.source).add(edge.target);
      internalNeighbors.get(edge.target).add(edge.source);
    }
    const maxDegree = Math.max(...[...internalNeighbors.values()].map(neighbors => neighbors.size));
    // 度中心化是区域内端口压力的结构代理：若大量内部连接依赖同一个节点，
    // 收缩后并不会简化接口，反而会把通道与端口竞争集中到该节点附近。
    const concentrationPenalty = [...internalNeighbors.values()].reduce((total, neighbors) => total + maxDegree - neighbors.size, 0);
    // 树边块没有冗余连接，缩成盒子只会隐藏单链；覆盖整个弱连通分量也不会
    // 减少外层路由。两类候选都没有正布局收益。
    const gain = internalEdgeCount - (members.length - 1) - boundaryEdgeCount - concentrationPenalty;
    return { members, internalEdgeCount, gain, coversComponent: componentSize.get(members[0]) === members.length };
  }).filter(candidate => candidate.members.length >= 3 && !candidate.coversComponent && candidate.gain > 0);
  const occupied = new Set(), clustered = [];
  for (const candidate of candidates.sort((left, right) => right.gain - left.gain || right.members.length - left.members.length
    || left.members.join('\u0000').localeCompare(right.members.join('\u0000')))) {
    if (candidate.members.some(id => occupied.has(id))) continue;
    candidate.members.forEach(id => occupied.add(id));
    clustered.push(candidate.members);
  }
  if (!clustered.length) return null;
  const membership = new Map(clustered.flatMap(group => {
    const clusterId = `cluster-${[...group].sort().join('-')}`;
    return group.map(id => [id, clusterId]);
  }));
  const clusters = clustered.map(members => ({ id: `cluster-${[...members].sort().join('-')}`, members: members.sort() }));
  for (const id of ids) if (!membership.has(id)) { const clusterId = `node-${id}`; membership.set(id, clusterId); clusters.push({ id: clusterId, members: [id] }); }
  return { clusters, membership, boundaryHubIds: [] };
}

// 分区是临时布局数据，仍须以真实图为准验证。该校验不推断“好不好看”，只
// 阻止不连通盒子、重复节点或丢失真实 edgeId 端点的错误结构进入后续布局。
export function validateLayoutPartition(graph, plan) {
  graph = canonicalGraph(graph);
  if (!plan || !Array.isArray(plan.regions) || !Array.isArray(plan.connections)) return { ok: false, reasons: ['分区缺少区域或群际连线。'] };
  const graphNodeIds = new Set(graph.nodes.map(node => node.id));
  const membership = new Map(), reasons = [];
  for (const region of plan.regions) {
    if (!region?.id || !Array.isArray(region.nodeIds) || region.nodeIds.length === 0) { reasons.push('区域缺少有效标识或节点。'); continue; }
    for (const nodeId of region.nodeIds) {
      if (!graphNodeIds.has(nodeId)) reasons.push(`区域引用了不存在的节点：${nodeId}。`);
      else if (membership.has(nodeId)) reasons.push(`节点被多个区域占用：${nodeId}。`);
      else membership.set(nodeId, region.id);
    }
    if (region.nodeIds.length < 2) continue;
    const members = new Set(region.nodeIds);
    const internalEdges = graph.edges.filter(edge => members.has(edge.source) && members.has(edge.target) && edge.source !== edge.target);
    if (internalEdges.length < members.size - 1) reasons.push(`区域内部边不足以连通：${region.id}。`);
    const reached = new Set([region.nodeIds[0]]), adjacent = new Map(region.nodeIds.map(nodeId => [nodeId, []]));
    for (const edge of internalEdges) { adjacent.get(edge.source).push(edge.target); adjacent.get(edge.target).push(edge.source); }
    for (const nodeId of reached) for (const next of adjacent.get(nodeId)) if (!reached.has(next)) reached.add(next);
    if (reached.size !== members.size) reasons.push(`区域的诱导子图不连通：${region.id}。`);
  }
  for (const nodeId of graphNodeIds) if (!membership.has(nodeId)) reasons.push(`节点未被任何区域覆盖：${nodeId}。`);
  const connectionEdges = new Map();
  for (const connection of plan.connections) for (const edge of connection.edges ?? []) {
    if (connectionEdges.has(edge.edgeId)) reasons.push(`跨区连线重复映射：${edge.edgeId}。`);
    else connectionEdges.set(edge.edgeId, { connection, edge });
  }
  for (const edge of graph.edges.filter(edge => edge.source !== edge.target)) {
    const sourceRegionId = membership.get(edge.source), targetRegionId = membership.get(edge.target);
    const mapped = connectionEdges.get(edge.id);
    if (sourceRegionId === targetRegionId) {
      if (mapped) reasons.push(`内部边不应作为跨区连线：${edge.id}。`);
      continue;
    }
    if (!mapped) { reasons.push(`跨区边缺少端点映射：${edge.id}。`); continue; }
    const { connection, edge: endpoint } = mapped;
    if (connection.sourceRegionId !== sourceRegionId || connection.targetRegionId !== targetRegionId
      || endpoint.sourceNodeId !== edge.source || endpoint.targetNodeId !== edge.target) reasons.push(`跨区边端点映射错误：${edge.id}。`);
  }
  return { ok: reasons.length === 0, reasons };
}

// 两阶段布局的稳定中间表示。它不写入机制文件，也不改变概念/规则；仅描述
// 哪些边需要成为区域边界端口，供外层骨架和内层 ELK 共享同一份事实。
export function deriveCohesiveLayoutPlan(graph) {
  graph = canonicalGraph(graph);
  const decomposition = cohesiveClusters(graph);
  if (!decomposition) return null;
  const regions = decomposition.clusters.map(region => ({ id: region.id, nodeIds: [...region.members] }));
  const connections = new Map();
  for (const edge of graph.edges.filter(edge => edge.source !== edge.target)) {
    const sourceRegionId = decomposition.membership.get(edge.source), targetRegionId = decomposition.membership.get(edge.target);
    if (sourceRegionId === targetRegionId) continue;
    const key = `${sourceRegionId}\u0000${targetRegionId}`;
    if (!connections.has(key)) connections.set(key, { id: key, sourceRegionId, targetRegionId, edges: [] });
    connections.get(key).edges.push({ edgeId: edge.id, sourceNodeId: edge.source, targetNodeId: edge.target });
  }
  const plan = {
    regions: regions.sort((left, right) => left.id.localeCompare(right.id)),
    connections: [...connections.values()].map(connection => ({ ...connection,
      edges: connection.edges.sort((left, right) => left.edgeId.localeCompare(right.edgeId)) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: {
      boundaryHubIds: decomposition.boundaryHubIds,
      clusteredNodeCount: decomposition.clusters.reduce((total, region) => total + (region.members.length > 1 ? region.members.length : 0), 0),
    },
  };
  return validateLayoutPartition(graph, plan).ok ? plan : null;
}

const oppositeSide = side => ({ left: 'right', right: 'left', top: 'bottom', bottom: 'top' })[side];
const sideToward = (from, to) => Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
  ? to.x >= from.x ? 'right' : 'left' : to.y >= from.y ? 'bottom' : 'top';

// 外层骨架坐标确定后，群际边才获得真实的边界方向。槽位排序只依赖目标群、
// 内部节点和 edgeId，避免每次自动整理因输入数组顺序不同而抖动。
export function assignCohesivePorts(plan, regionPositions) {
  if (!plan) return [];
  const ports = [], sideGroups = new Map();
  for (const connection of plan.connections) {
    const sourcePosition = regionPositions[connection.sourceRegionId], targetPosition = regionPositions[connection.targetRegionId];
    if (!sourcePosition || !targetPosition) throw new Error(`缺少节点群骨架坐标：${connection.sourceRegionId} 或 ${connection.targetRegionId}`);
    const sourceSide = sideToward(sourcePosition, targetPosition), targetSide = oppositeSide(sourceSide);
    for (const edge of connection.edges) {
      const record = { edgeId: edge.edgeId,
        source: { edgeId: edge.edgeId, role: 'source', regionId: connection.sourceRegionId, nodeId: edge.sourceNodeId, peerRegionId: connection.targetRegionId, side: sourceSide },
        target: { edgeId: edge.edgeId, role: 'target', regionId: connection.targetRegionId, nodeId: edge.targetNodeId, peerRegionId: connection.sourceRegionId, side: targetSide } };
      ports.push(record);
      for (const endpoint of [record.source, record.target]) {
        const key = `${endpoint.regionId}\u0000${endpoint.side}`;
        if (!sideGroups.has(key)) sideGroups.set(key, []);
        sideGroups.get(key).push(endpoint);
      }
    }
  }
  for (const endpoints of sideGroups.values()) {
    endpoints.sort((left, right) => left.peerRegionId.localeCompare(right.peerRegionId)
      // 同一群对的两端采用相反顺序，使一束平行跨群线不发生交叉。
      || (left.role === 'target' ? right.edgeId.localeCompare(left.edgeId) : left.edgeId.localeCompare(right.edgeId))
      || left.nodeId.localeCompare(right.nodeId));
    endpoints.forEach((endpoint, index) => { endpoint.slot = index; endpoint.slotCount = endpoints.length; });
  }
  return ports.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}
