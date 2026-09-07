const byId = (a, b) => String(a.id).localeCompare(String(b.id));

export const operatorFor = edge => edge.relation === 'specializes' ? 'is-a>' : edge.sign === 1 ? '+>' : edge.sign === -1 ? '->' : '?>';

const effectFor = steps => {
  if (steps.some(step => step.relation === 'specializes')) return null;
  return steps.reduce((effect, step) => effect === 'random' || step.sign === 'random' ? 'random' : effect * step.sign, 1) === 1 ? 'positive'
    : steps.reduce((effect, step) => effect === 'random' || step.sign === 'random' ? 'random' : effect * step.sign, 1) === -1 ? 'negative' : 'random';
};

export function compactPath(path, nodeMap) {
  const steps = path.edges.map(edge => ({
    from: edge.source, to: edge.target, operator: operatorFor(edge), origin: edge.origin,
    ...(edge.sourceQualifiers?.length ? { sourceQualifiers: structuredClone(edge.sourceQualifiers) } : {}),
    ...(edge.targetQualifiers?.length ? { targetQualifiers: structuredClone(edge.targetQualifiers) } : {}),
  }));
  const hasTaxonomy = path.edges.some(edge => edge.relation === 'specializes');
  return {
    length: path.edges.length,
    nodes: path.nodes.map(id => ({ id, label: nodeMap.get(id)?.label ?? id })),
    steps,
    chain: path.nodes.map((id, index) => index === 0 ? id : `${steps[index - 1].operator} ${id}`).join(' '),
    kind: hasTaxonomy ? (path.edges.every(edge => edge.relation === 'specializes') ? 'taxonomy' : 'mixed') : 'influence',
    effect: effectFor(path.edges),
  };
}

const sorted = edges => [...edges].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id));
const comparePath = (a, b) => a.edges.length - b.edges.length || a.nodes.join('\u0000').localeCompare(b.nodes.join('\u0000')) || a.edges.map(edge => edge.id).join('\u0000').localeCompare(b.edges.map(edge => edge.id).join('\u0000'));

// 有界简单路径。maxPaths + 1 用于区分“刚好 N 条”与“被 N 截断”。
export function enumerateImpactPaths({ edges, from, to, maxDepth = 16, maxPaths = 50, maxExpansions = 10000 }) {
  const outgoing = new Map();
  for (const edge of sorted(edges)) (outgoing.get(edge.source) ?? outgoing.set(edge.source, []).get(edge.source)).push(edge);
  const queue = [{ nodes: [from], edges: [] }], found = [];
  let expandedStates = 0, depthLimited = false, expansionLimited = false;
  for (let index = 0; index < queue.length; index++) {
    if (expandedStates >= maxExpansions) { expansionLimited = true; break; }
    const current = queue[index]; expandedStates++;
    if (current.nodes.at(-1) === to && current.edges.length) { found.push(current); if (found.length > maxPaths) break; continue; }
    if (current.edges.length >= maxDepth) { if ((outgoing.get(current.nodes.at(-1)) ?? []).length) depthLimited = true; continue; }
    for (const edge of outgoing.get(current.nodes.at(-1)) ?? []) if (!current.nodes.includes(edge.target)) queue.push({ nodes: [...current.nodes, edge.target], edges: [...current.edges, edge] });
  }
  found.sort(comparePath);
  const truncatedByPaths = found.length > maxPaths;
  return { paths: found.slice(0, maxPaths), found: truncatedByPaths ? null : found.length, totalExact: !truncatedByPaths && !expansionLimited && !depthLimited,
    expandedStates, truncationReasons: [truncatedByPaths ? 'maxPaths' : null, depthLimited ? 'maxDepth' : null, expansionLimited ? 'maxExpansions' : null].filter(Boolean) };
}

export function enumerateNodePaths({ edges, center, direction, hops = 1, maxPaths = 50, maxExpansions = 10000 }) {
  const reverse = direction === 'upstream', adjacent = new Map();
  for (const edge of sorted(edges)) {
    const key = reverse ? edge.target : edge.source;
    (adjacent.get(key) ?? adjacent.set(key, []).get(key)).push(edge);
  }
  const queue = [{ nodes: [center], edges: [] }], found = [];
  let expandedStates = 0, expansionLimited = false;
  for (let index = 0; index < queue.length; index++) {
    if (expandedStates >= maxExpansions) { expansionLimited = true; break; }
    const current = queue[index]; expandedStates++;
    if (current.edges.length) found.push(current);
    if (current.edges.length >= hops || found.length > maxPaths) continue;
    for (const edge of adjacent.get(reverse ? current.nodes[0] : current.nodes.at(-1)) ?? []) {
      const next = reverse ? edge.source : edge.target;
      if (current.nodes.includes(next)) continue;
      queue.push(reverse ? { nodes: [next, ...current.nodes], edges: [edge, ...current.edges] } : { nodes: [...current.nodes, next], edges: [...current.edges, edge] });
    }
  }
  found.sort(comparePath);
  const truncatedByPaths = found.length > maxPaths;
  return { paths: found.slice(0, maxPaths), found: truncatedByPaths ? null : found.length, totalExact: !truncatedByPaths && !expansionLimited,
    expandedStates, truncationReasons: [truncatedByPaths ? 'maxPaths' : null, expansionLimited ? 'maxExpansions' : null].filter(Boolean) };
}
