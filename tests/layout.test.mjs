import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import cola from 'webcola';
import { arrangeGraph, arrangeGraphWithRoutes, expandLayoutAtSpacingCuts, expandPositionsAtSpacingCuts } from '../src/web/layout.mjs';
import { normalizeRouteLanes, routeGraphEdges, routeGraphSpacingCuts } from '../src/web/canvas.mjs';
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

test('密集通道以坐标切分节点并向两侧增加缺失间隙', () => {
  const nodes = ['upper-left', 'upper-right', 'lower-left', 'lower-right'].map(id => ({ id }));
  const source = {
    'upper-left': { x: 0, y: 0 }, 'upper-right': { x: 300, y: 0 },
    'lower-left': { x: 0, y: 100 }, 'lower-right': { x: 300, y: 100 },
  };
  const expanded = expandPositionsAtSpacingCuts(nodes, source, [{ axis: 'y', coordinate: 81, deficit: 16 }]);
  assert.equal(expanded['upper-left'].y, 0);
  assert.equal(expanded['upper-right'].y, 0);
  assert.equal(expanded['lower-left'].y, 120);
  assert.equal(expanded['lower-right'].y, 120);
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

test('同一走廊的三条内部中段固定为 48px 等距车道', () => {
  const graph = { nodes: [], edges: ['a', 'b', 'c'].map(id => ({ id, source: id + '-s', target: id + '-t' })) };
  const routes = new Map([
    ['a', [{ x: -30, y: -1 }, { x: -30, y: 0 }, { x: 230, y: 0 }, { x: 230, y: -1 }]],
    ['b', [{ x: -20, y: 63 }, { x: -20, y: 64 }, { x: 220, y: 64 }, { x: 220, y: 63 }]],
    ['c', [{ x: -10, y: 111 }, { x: -10, y: 112 }, { x: 210, y: 112 }, { x: 210, y: 111 }]],
  ]);
  const normalized = normalizeRouteLanes(graph, {}, routes);
  assert.deepEqual([...normalized.values()].map(points => points[1].y), [16, 64, 112]);
  assert.deepEqual(routeGraphSpacingCuts(normalized), []);
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
  assert.ok(graph.nodes.some(node => settled.positions[node.id].x !== positions[node.id].x));
  assert.ok(graph.nodes.some(node => settled.positions[node.id].y !== positions[node.id].y));
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
