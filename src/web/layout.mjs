import { settleGraphGeometry } from './geometry-settle.mjs';
export { expandLayoutAtSpacingCuts, expandPositionsAtSpacingCuts } from './geometry-settle.mjs';

const WIDTH = 166;
const HEIGHT = 62;
const GRID = 10;
const ALIGN_TOLERANCE = 30;

const snap = value => Math.max(-100000, Math.min(100000, Math.round(value / GRID) * GRID));
const point = node => ({ x: snap(node.x - WIDTH / 2), y: snap(node.y - HEIGHT / 2) });
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

async function layoutAll(graph, positions, ELK, cola) {
  if (typeof ELK !== 'function') throw new Error('ELK 排版引擎未加载，请刷新页面后重试。');
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
      'elk.spacing.nodeNode': '110',
      'elk.layered.spacing.nodeNodeBetweenLayers': '130',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
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
  const aligned = alignConnectedAxis(graph, alignConnectedAxis(graph, arranged, 'y', clearances), 'x', clearances);
  return settleGraphGeometry({ graph, positions: aligned, cola });
}

function layoutSelection(graph, positions, movableIds, cola) {
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
