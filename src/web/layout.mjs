import { settleGraphGeometry } from './geometry-settle.mjs';
export { expandLayoutAtSpacingCuts, expandPositionsAtSpacingCuts } from './geometry-settle.mjs';

const WIDTH = 166;
const HEIGHT = 62;
const GRID = 20;
const ALIGN_TOLERANCE = 30;

const snap = value => Math.max(-100000, Math.min(100000, Math.round(value / GRID) * GRID));
const point = node => ({ x: snap(node.x - WIDTH / 2), y: snap(node.y - HEIGHT / 2) });
const canonicalGraph = graph => ({ ...graph,
  nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
  edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
});
const overlaps = (a, b, clearanceA = 0, clearanceB = 0) => a.x - clearanceA < b.x + WIDTH + clearanceB
  && a.x + WIDTH + clearanceA > b.x - clearanceB
  && a.y - clearanceA < b.y + HEIGHT + clearanceB
  && a.y + HEIGHT + clearanceA > b.y - clearanceB;

function nodeClearances(graph) {
  return new Map(graph.nodes.map(node => [node.id, 0]));
}

function hasOverlap(positions, clearances = new Map()) {
  const entries = Object.entries(positions);
  return entries.some(([id, value], index) => entries.slice(index + 1).some(([otherId, other]) => id !== otherId
    && overlaps(value, other, clearances.get(id) ?? 0, clearances.get(otherId) ?? 0)));
}

// 只把本来已接近同一轴线的相连节点归并到一条线；明显分叉仍服从 ELK，发生碰撞时放弃该组对齐。
function alignConnectedAxis(graph, positions, axis, clearances) {
  const parent = new Map(graph.nodes.map(node => [node.id, node.id]));
  const find = id => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; }
    return root;
  };
  const unite = (a, b) => {
    const left = find(a), right = find(b);
    if (left !== right) parent.set(left < right ? right : left, left < right ? left : right);
  };
  for (const edge of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (positions[edge.source] && positions[edge.target]
      && Math.abs(positions[edge.source][axis] - positions[edge.target][axis]) <= ALIGN_TOLERANCE) unite(edge.source, edge.target);
  }
  const groups = new Map();
  for (const node of graph.nodes) {
    const root = find(node.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(node.id);
  }
  let result = structuredClone(positions);
  for (const ids of [...groups.values()].filter(ids => ids.length > 1).sort((a, b) => a[0].localeCompare(b[0]))) {
    const values = ids.map(id => result[id][axis]).sort((a, b) => a - b);
    const aligned = values[Math.floor((values.length - 1) / 2)];
    const candidate = structuredClone(result);
    for (const id of ids) candidate[id][axis] = aligned;
    if (!hasOverlap(candidate, clearances)) result = candidate;
  }
  return result;
}

function visibleSelection(graph, selectedIds) {
  const visible = new Set(graph.nodes.map(node => node.id));
  return [...new Set(selectedIds)].filter(id => visible.has(id));
}

function assertPositions(graph, positions) {
  for (const node of graph.nodes) {
    const value = positions[node.id];
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error('节点缺少有效坐标：' + node.id);
  }
}

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

async function layoutFlat(graph, positions, ELK, cola, densityScale = 1) {
  // 机制文件中的节点顺序是稳定的人工/agent 语义顺序；排版保留它作为节点
  // 偏好，而不在这里按 ID 重排。路由求解本身仍会在 routeGraphEdges 中按 ID 排序。
  graph = { ...graph, nodes: [...graph.nodes], edges: [...graph.edges] };
  if (typeof ELK !== 'function') throw new Error('ELK 排版引擎未加载，请刷新页面后重试。');
  const dense = graph.edges.length > graph.nodes.length * 1.5;
  const minX = Math.min(...graph.nodes.map(node => positions[node.id].x));
  const minY = Math.min(...graph.nodes.map(node => positions[node.id].y));
  const clearances = nodeClearances(graph);
  const elk = new ELK();
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      // 高连接密度图必须在 ELK 层级阶段预留额外通道；否则后续严格正交
      // 路由只能把多条回绕线挤入同一走廊，最终形成不可接受的共线重叠。
      'elk.spacing.nodeNode': String((dense ? 180 : 110) * densityScale),
      'elk.layered.spacing.nodeNodeBetweenLayers': String((dense ? 210 : 130) * densityScale),
      // 机制文件的节点顺序表达资料组织，不应与原始边顺序共同主导 ELK 的
      // 层内初始排列；多源多汇、高扇入/扇出的层间连接中两者会互相牵制，
      // 形成长走廊并迫使严格路由做无效局部修补。只偏好节点顺序可保留稳定性并减少该干扰。
      'elk.layered.considerModelOrder.strategy': 'PREFER_NODES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
    },
    children: graph.nodes.map(node => {
      const clearance = clearances.get(node.id);
      return { id: node.id, width: WIDTH + clearance * 2, height: HEIGHT + clearance * 2 };
    }),
    edges: graph.edges.filter(edge => edge.source !== edge.target).map(edge => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
      layoutOptions: { 'elk.layered.priority.straightness': '10' },
    })),
  });
  const children = result.children ?? [];
  if (children.length !== graph.nodes.length) throw new Error('ELK 没有返回完整节点布局。');
  const resultMinX = Math.min(...children.map(node => node.x + clearances.get(node.id)));
  const resultMinY = Math.min(...children.map(node => node.y + clearances.get(node.id)));
  const arranged = Object.fromEntries(children.map(node => [node.id, {
    x: snap(minX + node.x + clearances.get(node.id) - resultMinX),
    y: snap(minY + node.y + clearances.get(node.id) - resultMinY),
  }]));
  // 同轴对齐是低密度图的可读性微调；高密度图中 ELK 已为层间与并行通道
  // 预留空间，再把相连节点压回同一轴会重新制造走廊重叠，导致后续局部
  // 结算在并非必要的冲突上长时间搜索。
  const aligned = dense ? arranged : alignConnectedAxis(graph, alignConnectedAxis(graph, arranged, 'y', clearances), 'x', clearances);
  return settleGraphGeometry({ graph, positions: aligned, cola });
}

const regionMeasure = (region, endpointCount) => {
  if (region.nodeIds.length === 1) return { width: WIDTH, height: HEIGHT, columns: 1, rows: 1 };
  const columns = Math.ceil(Math.sqrt(region.nodeIds.length));
  const rows = Math.ceil(region.nodeIds.length / columns);
  // 48px 是外部端口的最小槽距；群外框为端口预留容量，绝不把多条边挤到
  // 同一个几何出口。内部节点的网格留白使跨群线可以沿边界进入对应节点。
  const portSpan = Math.max(0, endpointCount - 1) * 48;
  return {
    width: Math.max(columns * (WIDTH + 120) + 120, WIDTH + portSpan + 160),
    height: Math.max(rows * (HEIGHT + 120) + 120, HEIGHT + Math.min(portSpan, 240) + 160),
    columns,
    rows,
  };
};

async function layoutCohesive(graph, positions, plan, ELK, cola) {
  const minX = Math.min(...graph.nodes.map(node => positions[node.id].x));
  const minY = Math.min(...graph.nodes.map(node => positions[node.id].y));
  const endpointCount = new Map(plan.regions.map(region => [region.id, 0]));
  for (const connection of plan.connections) {
    endpointCount.set(connection.sourceRegionId, endpointCount.get(connection.sourceRegionId) + connection.edges.length);
    endpointCount.set(connection.targetRegionId, endpointCount.get(connection.targetRegionId) + connection.edges.length);
  }
  const metrics = new Map(plan.regions.map(region => [region.id, regionMeasure(region, endpointCount.get(region.id) ?? 0)]));
  const elk = new ELK();
  const skeleton = await elk.layout({
    id: 'cohesive-skeleton',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '180',
      'elk.layered.spacing.nodeNodeBetweenLayers': '260',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: plan.regions.map(region => ({ id: region.id, ...metrics.get(region.id) })),
    // 同群之间的多条实际规则在外层只占一条骨架边；实际边仍在随后统一路由，
    // 这样 ELK 负责区域关系，不再替代我们的真实节点端口合同。
    edges: plan.connections.map(connection => ({ id: connection.id,
      sources: [connection.sourceRegionId], targets: [connection.targetRegionId] })),
  });
  const children = skeleton.children ?? [];
  if (children.length !== plan.regions.length) throw new Error('ELK 没有返回完整节点群骨架。');
  const childById = new Map(children.map(child => [child.id, child]));
  const resultMinX = Math.min(...children.map(child => child.x));
  const resultMinY = Math.min(...children.map(child => child.y));
  const regionPositions = Object.fromEntries(plan.regions.map(region => {
    const child = childById.get(region.id), measure = metrics.get(region.id);
    return [region.id, { x: minX + child.x - resultMinX + measure.width / 2, y: minY + child.y - resultMinY + measure.height / 2 }];
  }));
  const ports = assignCohesivePorts(plan, regionPositions);
  const endpointSides = new Map();
  for (const record of ports) for (const endpoint of [record.source, record.target]) {
    const key = `${endpoint.regionId}\u0000${endpoint.nodeId}`;
    if (!endpointSides.has(key)) endpointSides.set(key, []);
    endpointSides.get(key).push(endpoint);
  }
  const arranged = {};
  for (const region of plan.regions) {
    const child = childById.get(region.id), measure = metrics.get(region.id);
    const left = minX + child.x - resultMinX, top = minY + child.y - resultMinY;
    if (region.nodeIds.length === 1) {
      arranged[region.nodeIds[0]] = { x: snap(left), y: snap(top) };
      continue;
    }
    const sideRank = id => {
      const endpoints = endpointSides.get(`${region.id}\u0000${id}`) ?? [];
      const counts = new Map(['left', 'right', 'top', 'bottom'].map(side => [side, 0]));
      for (const endpoint of endpoints) counts.set(endpoint.side, counts.get(endpoint.side) + 1);
      const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { side: ordered[0][1] ? ordered[0][0] : 'middle', count: ordered[0][1] };
    };
    const ids = [...region.nodeIds].sort((leftId, rightId) => sideRank(leftId).side.localeCompare(sideRank(rightId).side)
      || sideRank(rightId).count - sideRank(leftId).count || leftId.localeCompare(rightId));
    ids.forEach((id, index) => {
      const row = Math.floor(index / measure.columns), column = index % measure.columns;
      arranged[id] = {
        x: snap(left + 60 + column * (WIDTH + 120)),
        y: snap(top + 80 + row * (HEIGHT + 120)),
      };
    });
  }
  // 端口决定节点在区域内的排序；最终严格几何结算仍以真实节点和真实规则
  // 为唯一事实来源，因此不会把复合节点变成第二份可持久化图数据。
  return settleGraphGeometry({ graph, positions: arranged, cola });
}

async function layoutAll(graph, positions, ELK, cola, densityScale = 1) {
  graph = { ...graph, nodes: [...graph.nodes], edges: [...graph.edges] };
  if (typeof ELK !== 'function') throw new Error('ELK 排版引擎未加载，请刷新页面后重试。');
  // 复合区域尚未把虚拟边界端口约束真正交给内层布局；在该合同实现并验证前，
  // 必须走已验证的扁平布局，不能让不完整的中间表示改变真实节点坐标。
  return layoutFlat(graph, positions, ELK, cola, densityScale);
}

function layoutSelection(graph, positions, movableIds, cola) {
  graph = canonicalGraph(graph);
  if (typeof cola?.Layout !== 'function') throw new Error('WebCola 排版引擎未加载，请刷新页面后重试。');
  const movable = new Set(movableIds);
  const clearances = nodeClearances(graph);
  const index = new Map(graph.nodes.map((node, order) => [node.id, order]));
  const nodes = graph.nodes.map(node => ({
    id: node.id,
    x: positions[node.id].x + WIDTH / 2,
    y: positions[node.id].y + HEIGHT / 2,
    width: WIDTH + clearances.get(node.id) * 2,
    height: HEIGHT + clearances.get(node.id) * 2,
    fixed: movable.has(node.id) ? 0 : 1,
  }));
  const links = graph.edges.filter(edge => edge.source !== edge.target && index.has(edge.source) && index.has(edge.target))
    .map(edge => ({ source: index.get(edge.source), target: index.get(edge.target) }));
  new cola.Layout()
    .nodes(nodes)
    .links(links)
    .linkDistance(260)
    .avoidOverlaps(true)
    .flowLayout('x', 130)
    .handleDisconnected(false)
    .start(30, 30, 50, 0, false, false);
  for (const node of nodes.filter(node => movable.has(node.id))) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) throw new Error('WebCola 没有返回有效节点坐标：' + node.id);
  }
  const arranged = Object.fromEntries(nodes.filter(node => movable.has(node.id)).map(node => [node.id, point(node)]));
  const all = { ...positions, ...arranged };
  for (const id of movable) {
    for (const other of graph.nodes) {
      if (other.id !== id && overlaps(all[id], all[other.id], clearances.get(id), clearances.get(other.id))) {
        throw new Error('固定节点限制下无法生成满足端口净空的布局，请扩大可用空间或调整选择。');
      }
    }
  }
  return arranged;
}

export async function arrangeGraph({ graph, positions, selectedIds = [], ELK = globalThis.ELK, cola = globalThis.cola }) {
  if (!graph.nodes.length) return {};
  assertPositions(graph, positions);
  const selected = visibleSelection(graph, selectedIds);
  if (selected.length > 0 && selected.length < graph.nodes.length) return layoutSelection(graph, positions, selected, cola);
  return (await layoutAll(graph, positions, ELK, cola)).positions;
}

export async function arrangeGraphWithRoutes(options) {
  const selected = visibleSelection(options.graph, options.selectedIds ?? []);
  if (selected.length > 0 && selected.length < options.graph.nodes.length) {
    const arranged = await arrangeGraph(options);
    return settleGraphGeometry({ graph: options.graph, positions: { ...options.positions, ...arranged },
      cola: options.cola ?? globalThis.cola, allowPositionShift: false });
  }
  assertPositions(options.graph, options.positions);
  return layoutAll(options.graph, options.positions, options.ELK ?? globalThis.ELK, options.cola ?? globalThis.cola);
}
