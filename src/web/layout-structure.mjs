// 布局结构完全独立于机制文件归属，不改变原图节点和边的身份。
export function connectedComponents(graph) {
  const adjacent = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    adjacent.get(edge.source).push(edge.target); adjacent.get(edge.target).push(edge.source);
  }
  const owner = new Map(), components = [];
  for (const node of graph.nodes) {
    if (owner.has(node.id)) continue;
    const component = { nodes: [], edges: [] }, queue = [node.id];
    components.push(component); owner.set(node.id, component);
    for (let i = 0; i < queue.length; i++) for (const id of adjacent.get(queue[i])) {
      if (!owner.has(id)) { owner.set(id, component); queue.push(id); }
    }
  }
  for (const node of graph.nodes) owner.get(node.id).nodes.push(node);
  for (const edge of graph.edges) owner.get(edge.source).edges.push(edge);
  return components;
}

export function leafHierarchy(graph) {
  const adjacency = new Map(graph.nodes.map(node => [node.id, new Set()]));
  const trees = new Map(graph.nodes.map(node => [node.id, { id: node.id, attached: [] }]));
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) throw Error(`无效边端点：${edge.id}`);
    if (edge.source !== edge.target) {
      adjacency.get(edge.source).add(edge.target); adjacency.get(edge.target).add(edge.source);
    }
  }
  const queue = [...adjacency.keys()].filter(id => adjacency.get(id).size === 1), merges = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor], neighbors = adjacency.get(id);
    if (!neighbors || neighbors.size !== 1) continue;
    const parent = [...neighbors][0];
    trees.get(parent).attached.push(trees.get(id)); trees.delete(id);
    adjacency.get(parent).delete(id); adjacency.delete(id);
    merges.push({ node: id, parent });
    if (adjacency.get(parent).size === 1) queue.push(parent);
  }
  // 合并时只保存树链接，完成后各原始节点只遍历一次生成成员列表。
  const members = tree => {
    const result = [], stack = [tree];
    while (stack.length) { const current = stack.pop(); result.push(current.id); stack.push(...current.attached); }
    return result;
  };
  const roots = [...trees.values()].map((tree, index) => {
    const ids = members(tree);
    return ids.length === 1 ? { id: tree.id, members: ids, children: null }
      : { id: `__leaf_${index}`, members: ids, children: ids.map(id => ({ id, members: [id], children: null })), attachmentTree: tree };
  });
  return { roots, merges };
}

export function groupBoundary(graph, members) {
  const ids = new Set(members), internal = [], boundary = [];
  for (const edge of graph.edges) {
    const sourceInside = ids.has(edge.source), targetInside = ids.has(edge.target);
    if (sourceInside && targetInside) internal.push(edge.id);
    else if (sourceInside !== targetInside) boundary.push({ edgeId: edge.id,
      inside: sourceInside ? edge.source : edge.target,
      outside: sourceInside ? edge.target : edge.source,
      direction: sourceInside ? 'out' : 'in' });
  }
  return { members: [...ids], internal, boundary, interfaces: [...new Set(boundary.map(edge => edge.inside))] };
}

// 只在当前相邻组之间尝试正模块度增益的合并。它是实验用贪心分组，
// 不承诺找到最佳社区，也不把固定数量的大组作为正确性的条件。
export function modularHierarchy(graph) {
  const leaves = leafHierarchy(graph), count = graph.edges.filter(edge => edge.source !== edge.target).length;
  const degree = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) if (edge.source !== edge.target) {
    degree.set(edge.source, degree.get(edge.source) + 1); degree.set(edge.target, degree.get(edge.target) + 1);
  }
  const groups = new Map(leaves.roots.map(group => [group.id, { ...group, volume: group.members.reduce((sum, id) => sum + degree.get(id), 0) }]));
  const merges = []; let serial = 0;
  while (groups.size > 1 && count) {
    const owner = new Map([...groups.values()].flatMap(group => group.members.map(id => [id, group.id]))), links = new Map();
    for (const edge of graph.edges) {
      const a = owner.get(edge.source), b = owner.get(edge.target); if (a === b) continue;
      const key = JSON.stringify([a, b].sort()); links.set(key, (links.get(key) ?? 0) + 1);
    }
    let best;
    for (const [key, weight] of links) {
      const [a, b] = JSON.parse(key), left = groups.get(a), right = groups.get(b);
      const gain = weight / count - left.volume * right.volume / (2 * count * count);
      if (gain > 1e-9 && (!best || gain > best.gain + 1e-9 || Math.abs(gain - best.gain) < 1e-9 && key < best.key)) best = { key, a, b, gain };
    }
    if (!best) break;
    const left = groups.get(best.a), right = groups.get(best.b);
    const next = { id: `__module_${serial++}`, members: [...left.members, ...right.members], volume: left.volume + right.volume, children: [left, right] };
    groups.delete(left.id); groups.delete(right.id); groups.set(next.id, next); merges.push({ ...best, members: next.members });
  }
  return { roots: [...groups.values()], merges, leafMerges: leaves.merges };
}

export function explicitHierarchy(graph, clusters) {
  const available = new Set(graph.nodes.map(node => node.id)), seen = new Set();
  const roots = clusters.map((members, index) => {
    if (members.length < 2) throw Error('指定分组至少需要两个节点');
    for (const id of members) {
      if (!available.has(id) || seen.has(id)) throw Error(`指定分组包含缺失或重复节点：${id}`);
      seen.add(id);
    }
    return { id: `__explicit_${index}`, members, children: members.map(id => ({ id, members: [id], children: null })) };
  });
  roots.push(...graph.nodes.filter(node => !seen.has(node.id)).map(node => ({ id: node.id, members: [node.id], children: null })));
  return { roots, merges: [] };
}
