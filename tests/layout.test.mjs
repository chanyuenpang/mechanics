import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import cola from 'webcola';
import { arrangeGraph, arrangeGraphWithRoutes, assignCohesivePorts, deriveCohesiveLayoutPlan, expandLayoutAtSpacingCuts, expandPositionsAtSpacingCuts, validateLayoutPartition } from '../src/web/layout.mjs';
import { auditGraphGeometryStrict, normalizeRouteLanes, routeGraphEdges, routeGraphScore, routeGraphSpacingCuts } from '../src/web/canvas.mjs';
import { settleGraphGeometry } from '../src/web/geometry-settle.mjs';

const graph = {
  nodes: ['turn', 'resource', 'card', 'damage', 'victory'].map(id => ({ id })),
  edges: [
    ['turn', 'resource'], ['resource', 'card'], ['card', 'damage'], ['damage', 'victory'],
  ].map(([source, target], index) => ({ id: 'edge-' + index, source, target })),
};
const positions = {
  turn: { x: 80, y: 100 }, resource: { x: 90, y: 100 }, card: { x: 100, y: 100 },
  damage: { x: 110, y: 100 }, victory: { x: 120, y: 100 },
};

test('无选择时 ELK 重排全部节点，保持原区域并产生确定的从左到右布局', async () => {
  const first = await arrangeGraph({ graph, positions, ELK, cola });
  const second = await arrangeGraph({ graph, positions, ELK, cola });
  assert.deepEqual(first, second);
  assert.deepEqual(await arrangeGraph({ graph, positions, selectedIds: graph.nodes.map(node => node.id), ELK, cola }), first);
  assert.deepEqual(Object.keys(first).sort(), graph.nodes.map(node => node.id).sort());
  assert.equal(Math.min(...Object.values(first).map(item => item.x)), 80);
  for (const edge of graph.edges) assert.ok(first[edge.source].x < first[edge.target].x);
});

test('完整排版将接近同轴的关系对齐，明显分叉保持独立行', async () => {
  const ids = ['near', 'enemy', 'melee', 'action'];
  const fork = {
    nodes: ids.map(id => ({ id })),
    edges: [['near', 'enemy'], ['near', 'melee'], ['melee', 'action']]
      .map(([source, target], index) => ({ id: 'fork-' + index, source, target })),
  };
  const arranged = await arrangeGraph({
    graph: fork,
    positions: Object.fromEntries(ids.map((id, index) => [id, { x: index * 10, y: index * 10 }])),
    ELK, cola,
  });
  assert.equal(arranged.near.y, arranged.enemy.y);
  assert.equal(arranged.melee.y, arranged.action.y);
  assert.notEqual(arranged.near.y, arranged.melee.y);
  for (const point of Object.values(arranged)) { assert.equal(point.x % 10, 0); assert.equal(point.y % 10, 0); }
});

test('自动排版返回的连线可由最终坐标稳定重建', async () => {
  const result = await arrangeGraphWithRoutes({ graph, positions, ELK, cola });
  const reopened = routeGraphEdges(graph, result.positions, cola);
  assert.deepEqual([...result.routes].map(([id, route]) => [id, route.points]), [...reopened].map(([id, route]) => [id, route.points]));
});

test('正交路由对整图坐标平移保持相同的相对几何', () => {
  const routingPositions = Object.fromEntries(graph.nodes.map((node, index) => [node.id, { x: index * 260, y: 0 }]));
  const shifted = Object.fromEntries(Object.entries(routingPositions).map(([id, point]) => [id, { x: point.x + 40, y: point.y + 40 }]));
  const original = routeGraphEdges(graph, routingPositions, cola);
  const moved = routeGraphEdges(graph, shifted, cola);
  assert.equal(routeGraphScore(graph, routingPositions, original)[1], 0);
  assert.equal(routeGraphScore(graph, shifted, moved)[1], 0);
  assert.deepEqual([...moved].map(([id, route]) => [id, route.points.map(point => ({ x: point.x - 40, y: point.y - 40 }))]),
    [...original].map(([id, route]) => [id, route.points]));
});

test('端口首段被相邻节点封住时会换面恢复严格可行的正交路径', () => {
  const blocked = {
    nodes: ['hand', 'play', 'shuffle'].map(id => ({ id })),
    edges: [{ id: 'hand-to-play', source: 'hand', target: 'play' }],
  };
  // hand 的默认向下端口会穿入 shuffle 的 24px 净空；路由器必须换用可行侧，
  // 不能将这类布局误报为“无可行正交路径”。
  const blockedPositions = {
    hand: { x: 900, y: 0 }, play: { x: 0, y: 200 }, shuffle: { x: 900, y: 100 },
  };
  const routes = routeGraphEdges(blocked, blockedPositions, cola);
  assert.equal(routes.size, 1);
  assert.equal(routeGraphScore(blocked, blockedPositions, routes)[0], 0);
  assert.notEqual(routes.get('hand-to-play').sourcePort.side, 'bottom');
});

test('密集通道以坐标切分节点并向两侧增加缺失间隙', () => {
  const nodes = ['upper-left', 'upper-right', 'lower-left', 'lower-right'].map(id => ({ id }));
  const source = {
    'upper-left': { x: 0, y: 0 }, 'upper-right': { x: 300, y: 0 },
    'lower-left': { x: 0, y: 100 }, 'lower-right': { x: 300, y: 100 },
  };
  const expanded = expandPositionsAtSpacingCuts(nodes, source, [{ axis: 'y', coordinate: 81, deficit: 16 }]);
  assert.equal(expanded['upper-left'].y, 0);
  assert.equal(expanded['upper-right'].y, 0);
  assert.equal(expanded['lower-left'].y, 140);
  assert.equal(expanded['lower-right'].y, 140);
  assert.deepEqual(Object.fromEntries(nodes.map(node => [node.id, expanded[node.id].x])),
    Object.fromEntries(nodes.map(node => [node.id, source[node.id].x])));
});

test('切分节点时同步平移端点与拐点，不重新选择路线', () => {
  const graph = { nodes: [{ id: 'top' }, { id: 'bottom' }], edges: [] };
  const positions = { top: { x: 0, y: 0 }, bottom: { x: 0, y: 100 } };
  const routes = new Map([
    ['upper', [{ x: 0, y: 0 }, { x: 0, y: 70 }, { x: 200, y: 70 }, { x: 200, y: 0 }]],
    ['lower', [{ x: 0, y: 150 }, { x: 0, y: 78 }, { x: 200, y: 78 }, { x: 200, y: 150 }]],
  ]);
  const expanded = expandLayoutAtSpacingCuts(graph, positions, routes,
    [{ axis: 'y', coordinate: 74, deficit: 40, overlap: 200 }]);
  assert.deepEqual(expanded.positions, { top: { x: 0, y: 0 }, bottom: { x: 0, y: 140 } });
  assert.equal(expanded.routes.get('upper')[1].y, 70);
  assert.equal(expanded.routes.get('lower')[1].y, 118);
  assert.deepEqual(routeGraphSpacingCuts(expanded.routes), []);
});

test('切分线穿过节点时端口回贴不会把首末段拉成斜线', () => {
  const graph = { nodes: [{ id: 'source' }, { id: 'target' }], edges: [{ id: 'edge', source: 'source', target: 'target' }] };
  const positions = { source: { x: -300, y: 0 }, target: { x: 0, y: 0 } };
  const routes = new Map([['edge', {
    points: [{ x: -134, y: 31 }, { x: -100, y: 31 }, { x: -100, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 62 }],
    sourcePort: { nodeId: 'source', side: 'right', port: { x: -134, y: 31 }, anchor: { x: -100, y: 31 } },
    targetPort: { nodeId: 'target', side: 'bottom', port: { x: 150, y: 62 }, anchor: { x: 150, y: 100 } },
  }]]);
  const expanded = expandLayoutAtSpacingCuts(graph, positions, routes,
    [{ axis: 'x', coordinate: 100, deficit: 40, overlap: 200 }]);
  const points = expanded.routes.get('edge').points;
  for (let index = 1; index < points.length; index++) {
    assert.ok(points[index - 1].x === points[index].x || points[index - 1].y === points[index].y);
  }
  assert.deepEqual(points.at(-1), expanded.routes.get('edge').targetPort.port);
});

test('车道间距已达目标时保留现有位置，不强制压成等距', () => {
  const graph = { nodes: [], edges: ['a', 'b', 'c'].map(id => ({ id, source: id + '-s', target: id + '-t' })) };
  const routes = new Map([
    ['a', [{ x: -30, y: -1 }, { x: -30, y: 0 }, { x: 230, y: 0 }, { x: 230, y: -1 }]],
    ['b', [{ x: -20, y: 63 }, { x: -20, y: 64 }, { x: 220, y: 64 }, { x: 220, y: 63 }]],
    ['c', [{ x: -10, y: 111 }, { x: -10, y: 112 }, { x: 210, y: 112 }, { x: 210, y: 111 }]],
  ]);
  const normalized = normalizeRouteLanes(graph, {}, routes);
  assert.equal(normalized, routes);
  assert.deepEqual(routeGraphSpacingCuts(normalized), []);
});

test('严格几何审计将零间距共线通道作为冲突证据保留', () => {
  const strictGraph = { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })), edges: [
    { id: 'left', source: 'a', target: 'b' }, { id: 'right', source: 'c', target: 'd' },
  ] };
  const strictPositions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 0, y: 200 }, d: { x: 300, y: 200 } };
  const strictRoutes = new Map([
    ['left', [{ x: 0, y: 100 }, { x: 300, y: 100 }]],
    ['right', [{ x: 0, y: 100 }, { x: 300, y: 100 }]],
  ]);
  const audit = auditGraphGeometryStrict(strictGraph, strictPositions, strictRoutes);
  assert.equal(audit.ok, false);
  assert.equal(audit.spacing[0].deficit, 48);
  assert.deepEqual(audit.spacing[0].edges, ['left', 'right']);
});

test('严格几何审计将近距平行通道保留为软告警，不以此推动节点布局', () => {
  const strictGraph = { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })), edges: [
    { id: 'left', source: 'a', target: 'b' }, { id: 'right', source: 'c', target: 'd' },
  ] };
  const strictPositions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 0, y: 200 }, d: { x: 300, y: 200 } };
  const strictRoutes = new Map([
    ['left', [{ x: 0, y: 100 }, { x: 300, y: 100 }]],
    ['right', [{ x: 0, y: 116 }, { x: 300, y: 116 }]],
  ]);
  const audit = auditGraphGeometryStrict(strictGraph, strictPositions, strictRoutes);
  assert.equal(audit.ok, true);
  assert.equal(audit.overlaps.length, 0);
  assert.equal(audit.laneWarnings.length, 1);
});

test('高内聚节点群先形成复合布局区域，并显式列出群际端口边', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
  const graph = { nodes: ids.map(id => ({ id })), edges: [
    { id: 'ab', source: 'a', target: 'b' }, { id: 'ba', source: 'b', target: 'a' },
    { id: 'bc', source: 'b', target: 'c' }, { id: 'cb', source: 'c', target: 'b' },
    { id: 'ca', source: 'c', target: 'a' }, { id: 'ac', source: 'a', target: 'c' },
    { id: 'de', source: 'd', target: 'e' }, { id: 'ed', source: 'e', target: 'd' },
    { id: 'ef', source: 'e', target: 'f' }, { id: 'fe', source: 'f', target: 'e' },
    { id: 'fd', source: 'f', target: 'd' }, { id: 'df', source: 'd', target: 'f' },
    { id: 'bridge', source: 'c', target: 'd' },
  ] };
  const plan = deriveCohesiveLayoutPlan(graph);
  assert.ok(plan);
  const cluster = plan.regions.find(region => region.nodeIds.includes('a'));
  assert.deepEqual(cluster.nodeIds, ['a', 'b', 'c']);
  assert.ok(plan.connections.some(connection => connection.edges.some(edge => edge.edgeId === 'bridge')));
  const ports = assignCohesivePorts(plan, Object.fromEntries(plan.regions.map((region, index) => [region.id, { x: index * 400, y: 0 }])));
  const bridge = ports.find(port => port.edgeId === 'bridge');
  assert.equal(bridge.source.side, 'right');
  assert.equal(bridge.target.side, 'left');
  assert.ok(Number.isInteger(bridge.source.slot));
  assert.deepEqual(plan.diagnostics.boundaryHubIds, []);
});

test('共享高扇出枢纽不会作为共同邻居把节点误聚类', () => {
  const ids = ['hub', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
  const graph = { nodes: ids.map(id => ({ id })), edges: [
    ...ids.filter(id => id !== 'hub').map(id => ({ id: `hub-${id}`, source: 'hub', target: id })),
    { id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' },
    { id: 'cd', source: 'c', target: 'd' }, { id: 'de', source: 'd', target: 'e' },
    { id: 'ef', source: 'e', target: 'f' }, { id: 'fg', source: 'f', target: 'g' },
    { id: 'gh', source: 'g', target: 'h' },
  ] };
  const plan = deriveCohesiveLayoutPlan(graph);
  assert.equal(plan, null, '只有共享枢纽与链式关系时不应生成复合区域');
});

test('分区校验拒绝内部不连通的叶子盒与缺失跨区端点', () => {
  const graph = { nodes: ['hub', 'a', 'b', 'c'].map(id => ({ id })), edges: [
    { id: 'ha', source: 'hub', target: 'a' }, { id: 'hb', source: 'hub', target: 'b' }, { id: 'hc', source: 'hub', target: 'c' },
  ] };
  const invalid = { regions: [
    { id: 'leaves', nodeIds: ['a', 'b', 'c'] }, { id: 'hub', nodeIds: ['hub'] },
  ], connections: [] };
  const audit = validateLayoutPartition(graph, invalid);
  assert.equal(audit.ok, false);
  assert.ok(audit.reasons.some(reason => reason.includes('不连通')));
  assert.ok(audit.reasons.some(reason => reason.includes('缺少端点映射')));
});

test('同一节点群对的跨群端口在两端使用相反槽位顺序', () => {
  const plan = { connections: [{ id: 'left\u0000right', sourceRegionId: 'left', targetRegionId: 'right', edges: [
    { edgeId: 'e-1', sourceNodeId: 'a', targetNodeId: 'x' },
    { edgeId: 'e-2', sourceNodeId: 'b', targetNodeId: 'y' },
  ] }] };
  const ports = assignCohesivePorts(plan, { left: { x: 0, y: 0 }, right: { x: 400, y: 0 } });
  const one = ports.find(port => port.edgeId === 'e-1'), two = ports.find(port => port.edgeId === 'e-2');
  assert.deepEqual([one.source.slot, two.source.slot], [0, 1]);
  assert.deepEqual([one.target.slot, two.target.slot], [1, 0]);
});

test('车道空间不足时通过局部换面保留至少30px接入段，节点不动', () => {
  const graph = {
    nodes: ['a-source', 'a-target', 'b-source', 'b-target'].map(id => ({ id })),
    edges: [
      { id: 'a', source: 'a-source', target: 'a-target' },
      { id: 'b', source: 'b-source', target: 'b-target' },
    ],
  };
  const positions = {
    'a-source': { x: 0, y: -62 }, 'a-target': { x: 300, y: -62 },
    'b-source': { x: 0, y: 80 }, 'b-target': { x: 300, y: 80 },
  };
  const endpoint = (nodeId, otherId, side, port, anchor) => ({ nodeId, otherId, side, port, anchor, slot: 0 });
  const routes = new Map([
    ['a', { points: [{ x: 83, y: 0 }, { x: 83, y: 40 }, { x: 383, y: 40 }, { x: 383, y: 0 }],
      sourcePort: endpoint('a-source', 'a-target', 'bottom', { x: 83, y: 0 }, { x: 83, y: 36 }),
      targetPort: endpoint('a-target', 'a-source', 'bottom', { x: 383, y: 0 }, { x: 383, y: 36 }) }],
    ['b', { points: [{ x: 83, y: 80 }, { x: 83, y: 48 }, { x: 383, y: 48 }, { x: 383, y: 80 }],
      sourcePort: endpoint('b-source', 'b-target', 'top', { x: 83, y: 80 }, { x: 83, y: 44 }),
      targetPort: endpoint('b-target', 'b-source', 'top', { x: 383, y: 80 }, { x: 383, y: 44 }) }],
  ]);
  const settled = settleGraphGeometry({ graph, positions, routes });
  const middle = [...settled.routes.values()].map(route => route.points[1].y).sort((a, b) => a - b);
  assert.ok(middle[1] - middle[0] >= 48);
  for (const route of settled.routes.values()) {
    const length = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    assert.ok(length(route.points[0], route.points[1]) >= 30);
    assert.ok(length(route.points.at(-2), route.points.at(-1)) >= 30);
  }
  assert.deepEqual(settled.positions, positions, '重算局部端口即可满足间距时，不应移动无关节点');
});

test('共同 settle 对同一终态中的水平与竖直拥挤同时切分', () => {
  const graph = {
    nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })),
    edges: ['horizontal-a', 'horizontal-b', 'vertical-a', 'vertical-b']
      .map((id, index) => ({ id, source: index % 2 ? 'c' : 'a', target: index % 2 ? 'd' : 'b' })),
  };
  const positions = { a: { x: 0, y: -100 }, b: { x: 240, y: -100 }, c: { x: 300, y: 100 }, d: { x: 540, y: 100 } };
  const routes = new Map([
    ['horizontal-a', [{ x: 0, y: 0 }, { x: 240, y: 0 }]],
    ['horizontal-b', [{ x: 0, y: 12 }, { x: 240, y: 12 }]],
    ['vertical-a', [{ x: 300, y: 0 }, { x: 300, y: 240 }]],
    ['vertical-b', [{ x: 312, y: 0 }, { x: 312, y: 240 }]],
  ]);
  const settled = settleGraphGeometry({ graph, positions, routes });
  assert.deepEqual(routeGraphSpacingCuts(settled.routes), []);
  assert.ok(graph.nodes.every(node => Number.isFinite(settled.positions[node.id].x)
    && Number.isFinite(settled.positions[node.id].y)));
});

test('无归属连线的展示缓存不会触发节点平移或阻断几何结算', () => {
  const graph = { nodes: ['a', 'b'].map(id => ({ id })), edges: [] };
  const positions = { a: { x: 0, y: 200 }, b: { x: 300, y: 200 } };
  const routes = new Map([
    ['upper', [{ x: 0, y: 0 }, { x: 200, y: 0 }]],
    ['middle', [{ x: 0, y: 42 }, { x: 200, y: 42 }]],
    ['lower', [{ x: 0, y: 58 }, { x: 200, y: 58 }]],
  ]);
  const settled = settleGraphGeometry({ graph, positions, routes });
  assert.deepEqual(settled.positions, positions);
  assert.deepEqual(settled.routes, routes);
  assert.deepEqual(positions, { a: { x: 0, y: 200 }, b: { x: 300, y: 200 } });
});

test('存在选择时 WebCola 只返回选中坐标，未选节点不会进入提交集合', async () => {
  const source = {
    turn: { x: 0, y: 0 }, resource: { x: 260, y: 0 }, card: { x: 520, y: 0 },
    damage: { x: 780, y: 0 }, victory: { x: 1040, y: 0 },
  };
  const arranged = await arrangeGraph({ graph, positions: source, selectedIds: ['resource', 'card'], ELK, cola });
  assert.deepEqual(arranged, await arrangeGraph({ graph, positions: source, selectedIds: ['resource', 'card'], ELK, cola }));
  assert.deepEqual(Object.keys(arranged).sort(), ['card', 'resource']);
  for (const point of Object.values(arranged)) {
    assert.equal(point.x % 10, 0); assert.equal(point.y % 10, 0);
  }
});

test('选择中的未知节点被忽略；引擎缺失和坐标缺失显式失败', async () => {
  const all = await arrangeGraph({ graph, positions, selectedIds: ['missing'], ELK, cola });
  assert.equal(Object.keys(all).length, graph.nodes.length);
  await assert.rejects(arrangeGraph({ graph, positions, ELK: null, cola }), /ELK/);
  await assert.rejects(arrangeGraph({ graph, positions: { ...positions, card: undefined }, ELK, cola }), /card/);
});
