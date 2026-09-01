import test from 'node:test';
import assert from 'node:assert/strict';
import cola from 'webcola';
import { GraphCanvas, assignEdgePorts, distributedOffsets, nodesInBox, movePositions, edgeGeometry, incrementalEdgeGeometry, normalizeRouteLanes, rerouteMovedNodes, routeGraphEdges, routeGraphScore, routeGraphScoreAfterChanges, routeGraphSpacingCuts, snapPositions } from '../src/web/canvas.mjs';

function sharedOrthogonalLength(a, b) {
  const segments = points => points.slice(1).map((point, index) => ({ a: points[index], b: point,
    vertical: points[index].x === point.x }));
  let total = 0;
  for (const first of segments(a)) for (const second of segments(b)) {
    if (first.vertical !== second.vertical) continue;
    const sameAxis = first.vertical ? first.a.x === second.a.x : first.a.y === second.a.y;
    if (!sameAxis) continue;
    const f1 = first.vertical ? first.a.y : first.a.x, f2 = first.vertical ? first.b.y : first.b.x;
    const s1 = second.vertical ? second.a.y : second.a.x, s2 = second.vertical ? second.b.y : second.b.x;
    total += Math.max(0, Math.min(Math.max(f1, f2), Math.max(s1, s2)) - Math.max(Math.min(f1, f2), Math.min(s1, s2)));
  }
  return total;
}

test('空白双击只打开一次，节点点击不串联；框选和取消不触发', () => {
  const { canvas, event } = harness(); let opened = 0;
  canvas.callbacks.blankDoubleClick = () => opened++;
  const click = node => { canvas.down(event(500, 100, { node })); canvas.up(event(500, 100, { node })); };
  click(); assert.equal(opened, 0); click(); assert.equal(opened, 1);
  click('a'); click(); assert.equal(opened, 1);
  canvas.cancel(); click(); assert.equal(opened, 1);
  canvas.down(event(500, 100)); canvas.up(event(600, 100)); click(); assert.equal(opened, 1);
});

test('10px吸附作用于松手后的每个节点坐标，缩放不改单位，取消不提交', () => {
  assert.deepEqual(snapPositions({ a: { x: 15, y: -15 }, b: { x: 100003, y: -100003 } }), { a: { x: 20, y: -10 }, b: { x: 100000, y: -100000 } });
  const { canvas, event, writes } = harness();
  canvas.positions.a = { x: 2, y: 3 }; canvas.callbacks.snapEnabled = () => true;
  canvas.down(event(20, 20, { node: 'a' })); canvas.up(event(27, 29));
  assert.deepEqual(writes, [{ a: { x: 10, y: 10 } }]);
  canvas.down(event(20, 20, { node: 'a' })); canvas.move(event(39, 39)); canvas.cancel();
  assert.equal(writes.length, 1);
});

test('适应画布将可见节点包围框中心对齐画框中心', () => {
  const canvas = Object.create(GraphCanvas.prototype), zoom = [];
  Object.assign(canvas, {
    root: { clientWidth: 1000, clientHeight: 800 },
    graph: { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] },
    positions: { a: { x: 100, y: 200 }, b: { x: 500, y: 400 } },
    callbacks: { zoom: value => zoom.push(value) },
  });
  canvas.fit();
  const center = { x: (100 + 500 + 166) / 2, y: (200 + 400 + 62) / 2 };
  assert.equal(center.x * canvas.camera.scale + canvas.camera.x, 500);
  assert.equal(center.y * canvas.camera.scale + canvas.camera.y, 400);
  assert.deepEqual(zoom, [120]);
});

test('四边自动端点保持影响方向；反向平行边错开，重合与自环有有限坐标', () => {
  const a = { x: 0, y: 0 };
  for (const [b, start, end] of [
    [{ x: 300, y: 0 }, 'M166,31 ', ' 300,31'], [{ x: -300, y: 0 }, 'M0,31 ', ' -134,31'],
    [{ x: 0, y: 200 }, 'M83,62 ', ' 83,200'], [{ x: 0, y: -200 }, 'M83,0 ', ' 83,-138'],
  ]) {
    const geometry = edgeGeometry(a, b, 'a', 'b');
    assert.ok(geometry.path.startsWith(start)); assert.ok(geometry.path.endsWith(end));
    const forward = edgeGeometry(a, b, 'a', 'b', -17), reverse = edgeGeometry(b, a, 'b', 'a', 17);
    assert.notDeepEqual([forward.labelX, forward.labelY], [reverse.labelX, reverse.labelY]);
  }
  for (const target of ['a', 'b']) assert.doesNotMatch(edgeGeometry(a, a, 'a', target).path, /NaN|Infinity/);
});

test('WebCola 正交路由绕开矩形障碍，共线节点也只返回有限坐标', () => {
  const graph = {
    nodes: ['source', 'obstacle', 'target'].map(id => ({ id })),
    edges: [{ id: 'long', source: 'source', target: 'target', sign: 1 }],
  };
  const positions = { source: { x: 0, y: 0 }, obstacle: { x: 250, y: 0 }, target: { x: 500, y: 0 } };
  const first = routeGraphEdges(graph, positions, cola).get('long');
  const second = routeGraphEdges(graph, positions, cola).get('long');
  assert.deepEqual(second, first);
  assert.doesNotMatch(first.path, /NaN|Infinity/);
  const sourcePort = first.points[0], targetPort = first.points.at(-1);
  assert.ok(sourcePort.x === 0 || sourcePort.x === 166 || sourcePort.y === 0 || sourcePort.y === 62);
  assert.ok(targetPort.x === 500 || targetPort.x === 666 || targetPort.y === 0 || targetPort.y === 62);
  assert.ok(first.points.some(point => point.y >= 86 || point.y <= -24), '长边应离开膨胀后的障碍矩形');
  for (let index = 1; index < first.points.length; index++) {
    const a = first.points[index - 1], b = first.points[index];
    assert.ok(a.x === b.x || a.y === b.y, '路由必须保持水平或竖直');
  }
});

test('WebCola 批量路由分离平行边并保留四向端点', () => {
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { id: 'one', source: 'a', target: 'c', sign: 1 },
      { id: 'two', source: 'a', target: 'c', sign: -1 },
      { id: 'reverse', source: 'c', target: 'a', sign: 1 },
    ],
  };
  const positions = { a: { x: 0, y: 0 }, b: { x: 260, y: 0 }, c: { x: 520, y: 0 } };
  const routes = routeGraphEdges(graph, positions, cola);
  assert.equal(routes.size, 3);
  assert.equal(new Set([...routes.values()].map(route => route.path)).size, 3);
  for (const route of routes.values()) assert.doesNotMatch(route.path, /NaN|Infinity/);
  const values = [...routes.values()];
  for (let first = 0; first < values.length; first++) for (let second = first + 1; second < values.length; second++)
    assert.equal(sharedOrthogonalLength(values[first].points, values[second].points), 0, '正反批次的路径不能共线重叠');
});

test('拥挤端口通过正交引线连接节点，不生成斜线', () => {
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: Array.from({ length: 11 }, (_, index) => ({ id: 'edge-' + index, source: 'a', target: 'b', sign: 1 })),
  };
  const routes = routeGraphEdges(graph, { a: { x: 0, y: 0 }, b: { x: 500, y: 0 } }, cola);
  assert.equal(routes.size, 11);
  assert.equal(new Set([...routes.values()].map(route => route.path)).size, 11);
  for (const route of routes.values()) {
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1], b = route.points[index];
      assert.ok(a.x === b.x || a.y === b.y, '端点收口也必须保持水平或竖直');
    }
  }
});

test('节点位置改变后重新计算路线，障碍移开时恢复直接连线', () => {
  const graph = {
    nodes: [{ id: 'source' }, { id: 'obstacle' }, { id: 'target' }],
    edges: [{ id: 'edge', source: 'source', target: 'target', sign: 1 }],
  };
  const blocked = routeGraphEdges(graph, {
    source: { x: 0, y: 0 }, obstacle: { x: 250, y: 0 }, target: { x: 500, y: 0 },
  }, cola).get('edge');
  const clear = routeGraphEdges(graph, {
    source: { x: 0, y: 0 }, obstacle: { x: 250, y: 300 }, target: { x: 500, y: 0 },
  }, cola).get('edge');
  assert.notEqual(clear.path, blocked.path);
  assert.deepEqual(clear.points, [{ x: 166, y: 31 }, { x: 500, y: 31 }]);
});

test('单节点落地只重算关联端口影响域，远端路线保持原缓存', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const graph = {
    nodes: ids.map(id => ({ id })),
    edges: ids.slice(0, -1).map((id, index) => ({ id: id + ids[index + 1], source: id, target: ids[index + 1], sign: 1 })),
  };
  const previous = Object.fromEntries(ids.map((id, index) => [id, { x: index * 300, y: 0 }]));
  const cached = routeGraphEdges(graph, previous, cola), positions = { ...previous, a: { x: 0, y: 160 } };
  const result = rerouteMovedNodes(graph, positions, cached, ['a'], cola);
  assert.equal(result.full, false);
  assert.deepEqual(result.edgeIds, ['ab', 'bc']);
  assert.equal(result.routes.get('cd'), cached.get('cd'));
  assert.deepEqual(routeGraphScore(graph, positions, result.routes).slice(0, 3), [0, 0, 0]);
});

test('移动节点挡住固定路线时，影响域纳入被挡边并保持零穿越', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'blocker'];
  const graph = {
    nodes: ids.map(id => ({ id })),
    edges: ['a', 'b', 'c', 'd'].map((id, index) => ({ id: id + ids[index + 1], source: id, target: ids[index + 1], sign: 1 })),
  };
  const previous = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 600, y: 0 },
    d: { x: 1100, y: 0 }, e: { x: 1400, y: 0 }, blocker: { x: 850, y: 300 } };
  const cached = routeGraphEdges(graph, previous, cola), positions = { ...previous, blocker: { x: 850, y: 0 } };
  const result = rerouteMovedNodes(graph, positions, cached, ['blocker'], cola);
  assert.equal(result.full, false);
  assert.ok(result.edgeIds.includes('cd'));
  assert.equal(routeGraphScore(graph, positions, result.routes)[0], 0);
});

test('高连接度节点按相对面负载分流到合理侧，每侧不超过七级端口', () => {
  const graph = {
    nodes: [{ id: 'hub' }, ...Array.from({ length: 12 }, (_, index) => ({ id: 'target-' + index }))],
    edges: Array.from({ length: 12 }, (_, index) => ({ id: 'edge-' + index, source: 'hub', target: 'target-' + index, sign: 1 })),
  };
  const positions = { hub: { x: 0, y: 0 }, ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => ['target-' + index, { x: 1000, y: index - 6 }])) };
  const first = assignEdgePorts(graph, positions), second = assignEdgePorts(graph, positions);
  assert.deepEqual(second, first);
  const ports = [...first.values()].map(value => value.source);
  const counts = Object.fromEntries(['right', 'bottom', 'left', 'top'].map(side => [side, ports.filter(port => port.side === side).length]));
  assert.equal(counts.left, 0);
  assert.ok(counts.right > 0); assert.ok(counts.top > 0); assert.ok(counts.bottom > 0);
  assert.ok(Math.max(counts.right, counts.top, counts.bottom) <= 7);
  assert.ok(counts.top > 0); assert.ok(counts.bottom > 0);
  assert.equal(new Set(ports.map(port => `${port.side}:${port.port.x}:${port.port.y}`)).size, ports.length);
  for (const side of ['right', 'bottom', 'top']) {
    const sameSide = ports.filter(port => port.side === side);
    const lanes = sameSide.map(port => side === 'right' ? port.anchor.x : port.anchor.y);
    assert.equal(new Set(lanes).size, lanes.length, '同侧端口必须使用独立的节点外逃逸通道');
  }
});

test('同面第二个端口保留中点并启用右四分位', () => {
  const positions = { hub: { x: 0, y: 0 }, a: { x: 300, y: 0 }, b: { x: 300, y: 20 } };
  const members = ['a', 'b'].map((otherId, index) => ({
    role: 'source', otherId, edge: { id: 'edge-' + index, source: 'hub', target: otherId },
  }));
  assert.deepEqual(distributedOffsets(members, 'top', positions).sort((a, b) => a - b), [83, 124.5]);
});
test('同面第四个端口先填中央间隔，最终遵循七端口网格', () => {
  const positions = {
    hub: { x: 0, y: 0 },
    a: { x: 300, y: 0 }, b: { x: 300, y: 20 }, c: { x: 300, y: 40 }, d: { x: 300, y: 60 },
  };
  const members = ['a', 'b', 'c', 'd'].map((otherId, index) => ({
    role: 'source', otherId, edge: { id: 'edge-' + index, source: 'hub', target: otherId },
  }));
  assert.deepEqual(distributedOffsets(members, 'top', positions).sort((a, b) => a - b), [41.5, 83, 103.75, 124.5]);
});
test('资源式五关系在零冲突路由前将可行面的相对负载差限制为二', () => {
  const graph = {
    nodes: ['resource', 'play', 'stamina', 'spirit', 'turn'].map(id => ({ id })),
    edges: [
      { id: 'resource-play', source: 'resource', target: 'play', sign: 1 },
      { id: 'play-resource', source: 'play', target: 'resource', sign: -1 },
      { id: 'stamina-resource', source: 'stamina', target: 'resource', relation: 'contains' },
      { id: 'spirit-resource', source: 'spirit', target: 'resource', relation: 'contains' },
      { id: 'turn-resource', source: 'turn', target: 'resource', sign: 1 },
    ],
  };
  const positions = {
    resource: { x: -50, y: 950 }, play: { x: -380, y: 440 }, stamina: { x: -380, y: 800 },
    spirit: { x: -380, y: 950 }, turn: { x: -680, y: 50 },
  };
  const routes = routeGraphEdges(graph, positions, cola);
  const sides = graph.edges.map(edge => edge.source === 'resource'
    ? routes.get(edge.id).sourcePort.side : routes.get(edge.id).targetPort.side);
  const counts = ['top', 'right', 'bottom', 'left'].map(side => sides.filter(value => value === side).length).sort((a, b) => a - b);
  assert.equal(counts.reduce((total, count) => total + count, 0), graph.edges.length);
  assert.ok(counts.at(-1) - counts.at(-2) <= 2);
  assert.deepEqual(routeGraphScore(graph, positions, routes).slice(0, 3), [0, 0, 0]);
});

test('车道等距后处理不会覆盖端口交换阶段的零交叉结果', () => {
  const graph = {
    nodes: [],
    edges: ['upper', 'lower', 'vertical'].map(id => ({ id, source: id + '-source', target: id + '-target' })),
  };
  const routes = new Map([
    ['upper', [{ x: 0, y: -10 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: -10 }]],
    ['lower', [{ x: 0, y: 10 }, { x: 0, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 10 }]],
    ['vertical', [{ x: 50, y: 25 }, { x: 50, y: 40 }]],
  ]);
  assert.equal(routeGraphScore(graph, {}, routes)[2], 0);
  const normalized = normalizeRouteLanes(graph, {}, routes);
  assert.deepEqual(normalized, routes);
  assert.equal(routeGraphScore(graph, {}, normalized)[2], 0);
});

test('无冲突时单拐点严格优先于更靠近中心的双拐点', () => {
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'edge', source: 'a', target: 'b', sign: 1 }] };
  const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 200 } };
  const route = routeGraphEdges(graph, positions, cola).get('edge');
  assert.equal(route.points.length, 3);
  assert.equal(route.sourcePort.side, 'right'); assert.equal(route.targetPort.side, 'top');
  assert.deepEqual(routeGraphScore(graph, positions, new Map([['edge', route]])).slice(0, 7), [0, 0, 0, 1, 1, 0, 0]);
});

test('端点包围是低于交叉的强观感惩罚，不会把必要绕行判成无解', () => {
  const graph = { nodes: [{ id: 'turn' }, { id: 'resource' }],
    edges: [{ id: 'turn-resource', source: 'turn', target: 'resource', sign: 1 }] };
  const positions = { turn: { x: 0, y: 0 }, resource: { x: 500, y: 500 } };
  const wrapped = new Map([['turn-resource', [
    { x: 83, y: 0 }, { x: 83, y: -24 }, { x: -24, y: -24 }, { x: -24, y: 531 }, { x: 500, y: 531 },
  ]] ]);
  const clean = new Map([['turn-resource', [
    { x: 0, y: 31 }, { x: -24, y: 31 }, { x: -24, y: 531 }, { x: 500, y: 531 },
  ]] ]);
  assert.equal(routeGraphScore(graph, positions, wrapped)[0], 0);
  assert.equal(routeGraphScore(graph, positions, clean)[0], 0);
  assert.ok(routeGraphScore(graph, positions, wrapped)[3] > routeGraphScore(graph, positions, clean)[3]);
});

test('错位长边在中间节点不占通道时不增加多余拐点', () => {
  const graph = {
    nodes: [{ id: 'enemy' }, { id: 'middle-a' }, { id: 'middle-b' }, { id: 'victory' }],
    edges: [{ id: 'enemy-victory', source: 'enemy', target: 'victory', sign: -1 }],
  };
  const positions = { enemy: { x: 0, y: 0 }, 'middle-a': { x: 300, y: -120 },
    'middle-b': { x: 600, y: -120 }, victory: { x: 1000, y: 150 } };
  const route = routeGraphEdges(graph, positions, cola).get('enemy-victory');
  assert.ok(route.points.length <= 3, `不应保留 ${route.points.length - 2} 个拐点`);
});

test('减少拐点严格优先于消除次要的拐点邻近', () => {
  const graph = {
    nodes: [],
    edges: [
      { id: 'main', source: 'a', target: 'b', sign: 1 },
      { id: 'guide', source: 'c', target: 'd', sign: 1 },
    ],
  };
  const guide = [{ x: 52, y: -20 }, { x: 52, y: 0 }, { x: 100, y: 0 }];
  const single = routeGraphScore(graph, {}, new Map([
    ['main', [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]], ['guide', guide],
  ]));
  const detour = routeGraphScore(graph, {}, new Map([
    ['main', [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 50 }, { x: 50, y: 50 }]], ['guide', guide],
  ]));
  assert.deepEqual(single.slice(0, 3), detour.slice(0, 3));
  assert.ok(single[3] < detour[3], '单拐点主线应减少全图总拐点');
  assert.ok(single[5] > detour[5], '用例必须覆盖旧评分会偏好的较低拐点拥挤');
});

test('相距 8px 的长平行通道仍属于可读性拥挤', () => {
  const graph = {
    nodes: [],
    edges: [
      { id: 'upper', source: 'a', target: 'b' },
      { id: 'lower', source: 'c', target: 'd' },
    ],
  };
  const routes = new Map([
    ['upper', [{ x: 0, y: -50 }, { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 50 }]],
    ['lower', [{ x: 0, y: -42 }, { x: 0, y: 8 }, { x: 200, y: 8 }, { x: 200, y: 58 }]],
  ]);
  assert.ok(routeGraphScore(graph, {}, routes)[6] > 0, '8px 平行通道不能与宽松通道获得相同评分');
  assert.deepEqual(routeGraphSpacingCuts(routes), [{ axis: 'y', coordinate: 4, deficit: 40, overlap: 200 }]);
});

test('直接连接端口的首末段允许按端口宽度保持低间距', () => {
  const routes = new Map([
    ['upper', { points: [{ x: 0, y: -100 }, { x: 0, y: 0 }, { x: 300, y: 0 }],
      targetPort: { nodeId: 'hand', side: 'left' } }],
    ['lower', { points: [{ x: 0, y: -90 }, { x: 0, y: 10 }, { x: 300, y: 10 }],
      targetPort: { nodeId: 'hand', side: 'left' } }],
  ]);
  assert.deepEqual(routeGraphSpacingCuts(routes), []);
});

test('同一端口面的紧邻折返段属于端口汇入区', () => {
  const routes = new Map([
    ['upper', { points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 300, y: 100 }],
      targetPort: { nodeId: 'discard', side: 'left' } }],
    ['lower', { points: [{ x: 400, y: 10 }, { x: 208, y: 10 }, { x: 208, y: 110 }, { x: 300, y: 110 }],
      targetPort: { nodeId: 'discard', side: 'left' } }],
  ]);
  assert.deepEqual(routeGraphSpacingCuts(routes), []);
});

test('不同节点的长端点段在水平与竖直方向都执行48px间距切分', () => {
  const horizontal = new Map([
    ['upper', { points: [{ x: 0, y: 0 }, { x: 240, y: 0 }], targetPort: { nodeId: 'a', side: 'left' } }],
    ['lower', { points: [{ x: 0, y: 12 }, { x: 240, y: 12 }], targetPort: { nodeId: 'b', side: 'left' } }],
  ]);
  const vertical = new Map([
    ['left', { points: [{ x: 0, y: 0 }, { x: 0, y: 240 }], targetPort: { nodeId: 'c', side: 'top' } }],
    ['right', { points: [{ x: 12, y: 0 }, { x: 12, y: 240 }], targetPort: { nodeId: 'd', side: 'top' } }],
  ]);
  assert.deepEqual(routeGraphSpacingCuts(horizontal), [{ axis: 'y', coordinate: 6, deficit: 36, overlap: 240 }]);
  assert.deepEqual(routeGraphSpacingCuts(vertical), [{ axis: 'x', coordinate: 6, deficit: 36, overlap: 240 }]);
});

test('单边与双边增量评分和完整审计严格一致', () => {
  const graph = {
    nodes: [],
    edges: [
      { id: 'a', source: 'a1', target: 'a2' },
      { id: 'b', source: 'b1', target: 'b2' },
      { id: 'c', source: 'c1', target: 'c2' },
    ],
  };
  const routes = new Map([
    ['a', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]],
    ['b', [{ x: 40, y: -50 }, { x: 40, y: 70 }, { x: 160, y: 70 }]],
    ['c', [{ x: 0, y: 140 }, { x: 180, y: 140 }]],
  ]);
  for (const replacements of [
    new Map([['a', [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }]]]),
    new Map([
      ['a', [{ x: 0, y: 0 }, { x: 0, y: 110 }, { x: 100, y: 110 }]],
      ['b', [{ x: 40, y: -50 }, { x: 160, y: -50 }, { x: 160, y: 70 }]],
    ]),
  ]) {
    const expectedRoutes = new Map(routes);
    for (const [id, points] of replacements) expectedRoutes.set(id, points);
    assert.deepEqual(routeGraphScoreAfterChanges(graph, {}, routes, replacements),
      routeGraphScore(graph, {}, expectedRoutes));
  }
});

test('后撤步式三分支通过端口与路径联合选择消除可避免交叉', () => {
  const graph = {
    nodes: ['evade', 'stamina', 'play', 'repel'].map(id => ({ id })),
    edges: [
      { id: 'a-stamina', source: 'evade', target: 'stamina', sign: -1 },
      { id: 'b-play', source: 'evade', target: 'play', relation: 'contains' },
      { id: 'c-repel', source: 'evade', target: 'repel', sign: 1 },
    ],
  };
  const positions = { evade: { x: -70, y: 420 }, stamina: { x: 230, y: 780 },
    play: { x: 230, y: 420 }, repel: { x: 230, y: 200 } };
  const routes = routeGraphEdges(graph, positions, cola);
  const score = routeGraphScore(graph, positions, routes);
  assert.deepEqual(score.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(score.slice(5, 7), [0, 0]);
});

test('抽牌手牌密集小图优先无交叉路径，单个 WebCola 候选失败不拖垮整图', () => {
  const graph = {
    nodes: ['draw', 'discard', 'hand', 'play'].map(id => ({ id })),
    edges: [
      { id: 'draw-discard', source: 'draw', target: 'discard', sign: 1 },
      { id: 'draw-hand', source: 'draw', target: 'hand', sign: 1 },
      { id: 'play-hand', source: 'play', target: 'hand', sign: -1 },
      { id: 'play-discard', source: 'play', target: 'discard', sign: 1 },
    ],
  };
  const positions = { draw: { x: 230, y: 30 }, discard: { x: 520, y: 30 },
    hand: { x: 520, y: 240 }, play: { x: 230, y: 420 } };
  const brokenCola = { Rectangle: class {}, GridRouter: class { constructor() { throw new Error('undefined id'); } } };
  const routes = routeGraphEdges(graph, positions, brokenCola);
  const score = routeGraphScore(graph, positions, routes);
  assert.deepEqual(score.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(score.slice(5, 7), [0, 0]);
  assert.ok(routes.get('draw-hand').points.length <= 5);
});

test('同排节点的投影端口直接对齐，不产生几像素短台阶', () => {
  const graph = {
    nodes: [{ id: 'upper' }, { id: 'source' }, { id: 'target' }],
    edges: [
      { id: 'upper-target', source: 'upper', target: 'target', sign: 1 },
      { id: 'source-target', source: 'source', target: 'target', sign: 1 },
    ],
  };
  const route = routeGraphEdges(graph, {
    upper: { x: 0, y: -200 }, source: { x: 0, y: 0 }, target: { x: 500, y: 0 },
  }, cola).get('source-target');
  assert.deepEqual(route.points, [{ x: 166, y: 31 }, { x: 500, y: 31 }]);
});

test('同排影响链全部使用单段直线，普通密集边仍保留独立路线', () => {
  const graph = {
    nodes: ['action', 'damage', 'health', 'failure'].map(id => ({ id })),
    edges: [
      { id: 'action-damage', source: 'action', target: 'damage', sign: 1 },
      { id: 'damage-health', source: 'damage', target: 'health', sign: -1 },
      { id: 'health-failure', source: 'health', target: 'failure', sign: -1 },
    ],
  };
  const positions = Object.fromEntries(graph.nodes.map((node, index) => [node.id, { x: index * 300, y: 100 }]));
  const routes = routeGraphEdges(graph, positions, cola);
  for (const route of routes.values()) {
    assert.equal(route.points.length, 2);
    assert.equal(route.points[0].y, 131); assert.equal(route.points[1].y, 131);
  }
});

test('对角扇出关系在两个同向侧之间分流，不再被主轴强制到单侧', () => {
  const graph = {
    nodes: [{ id: 'hub' }, ...Array.from({ length: 6 }, (_, index) => ({ id: 'target-' + index }))],
    edges: Array.from({ length: 6 }, (_, index) => ({ id: 'edge-' + index, source: 'hub', target: 'target-' + index, sign: 1 })),
  };
  const positions = { hub: { x: 0, y: 0 }, ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    'target-' + index, { x: 600 + index * 10, y: 600 + index * 10 },
  ])) };
  const sides = [...assignEdgePorts(graph, positions).values()].map(value => value.source.side);
  assert.deepEqual(new Set(sides), new Set(['right', 'bottom']));
  assert.deepEqual(Object.fromEntries(['right', 'bottom'].map(side => [side, sides.filter(value => value === side).length])), { right: 3, bottom: 3 });
});

test('跨越多个中间节点的长边使用图外通道', () => {
  const graph = {
    nodes: [{ id: 'source' }, { id: 'middle-a' }, { id: 'middle-b' }, { id: 'target' }],
    edges: [{ id: 'long', source: 'source', target: 'target', sign: 1 }],
  };
  const positions = {
    source: { x: 0, y: 0 }, 'middle-a': { x: 300, y: 200 },
    'middle-b': { x: 600, y: 200 }, target: { x: 1000, y: 400 },
  };
  const route = routeGraphEdges(graph, positions, cola).get('long');
  assert.equal(route.sourcePort.side, 'top'); assert.equal(route.targetPort.side, 'top');
  assert.ok(route.points.some(point => point.y < 0));
});

test('端口不会因拥塞分配到目标反方向，最后一段垂直进入节点', () => {
  const graph = { nodes: [{ id: 'source' }, { id: 'target' }], edges: [{ id: 'edge', source: 'source', target: 'target', sign: 1 }] };
  const positions = { source: { x: 500, y: 0 }, target: { x: 0, y: 300 } };
  const route = routeGraphEdges(graph, positions, cola).get('edge');
  assert.ok(['left', 'bottom'].includes(route.sourcePort.side));
  assert.ok(['right', 'top'].includes(route.targetPort.side));
  const before = route.points.at(-2), end = route.points.at(-1);
  if (route.targetPort.side === 'left' || route.targetPort.side === 'right') assert.equal(before.y, end.y);
  else assert.equal(before.x, end.x);
});

test('节点拖动沿用已稳定端口，只平移关联端并生成有限正交路径', () => {
  const edge = { id: 'a-b', source: 'a', target: 'b', sign: 1 };
  const previous = { a: { x: 0, y: 0 }, b: { x: 500, y: 0 } };
  const cached = routeGraphEdges({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [edge] }, previous, cola).get(edge.id);
  const positions = { a: { x: 40, y: 70 }, b: { x: 500, y: 0 } };
  const geometry = incrementalEdgeGeometry(edge, positions, previous, cached);
  assert.deepEqual(geometry.sourcePort.port, {
    x: cached.sourcePort.port.x + 40, y: cached.sourcePort.port.y + 70,
  });
  assert.deepEqual(geometry.targetPort.port, cached.targetPort.port);
  assert.doesNotMatch(geometry.path, /NaN|Infinity/);
  for (let index = 1; index < geometry.points.length; index++) {
    const a = geometry.points[index - 1], b = geometry.points[index];
    assert.ok(a.x === b.x || a.y === b.y, '拖动预览仍须保持正交');
  }
});

test('增量绘制只更新移动节点及其关联边，其他节点和边保持原路径', () => {
  const canvas = Object.create(GraphCanvas.prototype), writes = new Map();
  const element = id => ({ setAttribute: (key, value) => {
    if (!writes.has(id)) writes.set(id, []); writes.get(id).push([key, value]);
  } });
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { id: 'a-b', source: 'a', target: 'b', sign: 1 },
      { id: 'b-c', source: 'b', target: 'c', sign: 1 },
    ],
  };
  const previous = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 600, y: 0 } };
  const edgeElements = id => ({ hit: element(id + ':hit'), line: element(id + ':line'), label: element(id + ':label') });
  Object.assign(canvas, {
    graph, positions: previous, routed: routeGraphEdges(graph, previous, cola),
    nodeElements: new Map(graph.nodes.map(node => [node.id, element(node.id)])),
    edgeElements: new Map(graph.edges.map(edge => [edge.id, edgeElements(edge.id)])),
  });
  canvas.renderIncremental(['a'], { ...previous, a: { x: 40, y: 70 } }, previous);
  assert.ok(writes.has('a'));
  assert.ok(writes.has('a-b:line'));
  assert.equal(writes.has('b'), false);
  assert.equal(writes.has('c'), false);
  assert.equal(writes.has('b-c:hit'), false);
  assert.equal(writes.has('b-c:line'), false);
  assert.equal(writes.has('b-c:label'), false);
});

test('同节点双击只启动一次连接；拖动和取消清理候选，失败保留连接源', () => {
  const { canvas, event } = harness(), started = [];
  canvas.callbacks.quickLink = id => { started.push(id); canvas.mode = 'negative'; canvas.linkSource = id; };
  const click = () => { canvas.down(event(20, 20, { node: 'a' })); canvas.up(event(20, 20, { node: 'a' })); };
  click(); assert.deepEqual(started, []); click(); assert.deepEqual(started, ['a']);
  const links = []; canvas.callbacks.link = (...args) => { links.push(args); return false; };
  canvas.pick('b'); assert.deepEqual(links, [['a', 'b', -1]]); assert.equal(canvas.linkSource, 'a');
  canvas.callbacks.link = () => true; canvas.pick('b'); assert.equal(canvas.linkSource, null);
  canvas.mode = 'select'; click(); canvas.cancel(); click(); assert.deepEqual(started, ['a']);
  canvas.down(event(20, 20, { node: 'a' })); canvas.up(event(40, 20, { node: 'a' }));
  assert.equal(canvas.lastClick, null); canvas.cancel(); assert.equal(canvas.linkSource, null);
});

function harness() {
  // 直接驱动真实手势方法；DOM 绘制由浏览器验收覆盖。
  const canvas = Object.create(GraphCanvas.prototype), writes = [];
  Object.assign(canvas, { camera: { x: 70, y: 90, scale: .5 }, positions: { a: { x: 0, y: 0 }, b: { x: 220, y: 0 } },
    graph: { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] }, mode: 'select', draw() {}, transform() {},
    root: { getBoundingClientRect: () => ({ left: 10, top: 20 }), setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {}, classList: { add() {}, remove() {} } },
    callbacks: { select: value => { canvas.selection = value; }, canMove: () => true, move: value => writes.push(value) },
  });
  const event = (x, y, { button = 0, node, shiftKey = false } = {}) => ({ clientX: 80 + x * .5, clientY: 110 + y * .5,
    button, pointerId: 1, shiftKey, preventDefault() {}, target: { closest: selector => node && selector === '[data-node]' ? { dataset: { node } } : null } });
  return { canvas, writes, event };
}
test('左键反向框选使用世界坐标；空白轻点清除，Shift 轻点保留选择', () => {
  const { canvas, event, writes } = harness();
  canvas.down(event(400, 100)); canvas.move(event(-10, -10)); canvas.up(event(-10, -10));
  assert.deepEqual(canvas.selectedIds(), ['a', 'b']); assert.deepEqual(writes, []);
  canvas.down(event(500, 100, { shiftKey: true })); canvas.up(event(501, 100));
  assert.deepEqual(canvas.selectedIds(), ['a', 'b']);
  canvas.down(event(500, 100)); canvas.up(event(501, 100));
  assert.deepEqual(canvas.selectedIds(), []);
  assert.deepEqual(canvas.camera, { x: 70, y: 90, scale: .5 });
  assert.deepEqual(nodesInBox(canvas.graph.nodes, canvas.positions, { x: 165, y: 20 }, { x: 170, y: 25 }), ['a']);
});
test('右键、中键与空格只平移相机，不移动节点或清除选择；取消恢复相机', () => {
  for (const options of [{ button: 2 }, { button: 2, node: 'a' }, { button: 1 }, { button: 0, space: true }]) {
    const { canvas, event, writes } = harness();
    canvas.selection = { type: 'nodes', ids: ['a', 'b'] }; canvas.space = !!options.space;
    canvas.down(event(500, 100, options)); canvas.up(event(580, 160, options));
    assert.deepEqual(canvas.camera, { x: 110, y: 120, scale: .5 });
    assert.deepEqual(canvas.selectedIds(), ['a', 'b']); assert.deepEqual(writes, []);
    canvas.down(event(500, 100, options)); canvas.up(event(500, 100, options));
    assert.deepEqual(canvas.selectedIds(), ['a', 'b']);
    canvas.down(event(500, 100, options)); canvas.move(event(700, 200, options)); canvas.cancel();
    assert.deepEqual(canvas.camera, { x: 110, y: 120, scale: .5 });
  }
  const { canvas, event } = harness(); canvas.mode = 'positive';
  canvas.down(event(500, 100)); assert.equal(canvas.gesture, undefined);
  canvas.down(event(500, 100, { button: 2 })); canvas.up(event(540, 120, { button: 2 }));
  assert.deepEqual(canvas.camera, { x: 90, y: 100, scale: .5 });
});
test('多选整组拖动只提交一次；Shift 单击增减，取消预览不保存', () => {
  const { canvas, event, writes } = harness();
  canvas.down(event(30, 30, { button: 0, node: 'a', shiftKey: true }));
  canvas.down(event(240, 30, { button: 0, node: 'b', shiftKey: true }));
  canvas.down(event(30, 30, { button: 0, node: 'a' }));
  canvas.move(event(70, 90, { button: 0 })); canvas.up(event(70, 90, { button: 0 }));
  assert.deepEqual(writes, [{ a: { x: 40, y: 60 }, b: { x: 260, y: 60 } }]);
  canvas.down(event(30, 30, { button: 0, node: 'a' })); canvas.move(event(130, 130)); canvas.cancel(); canvas.up(event(130, 130));
  assert.equal(writes.length, 1);
  canvas.down(event(30, 30, { button: 0, node: 'a', shiftKey: true }));
  assert.deepEqual(canvas.selectedIds(), ['b']);
});
test('节点拖动期间只做增量预览，松手后异步请求关联边正式路由', async () => {
  const { canvas, event } = harness(); const fullDraws = [], requests = []; let incrementalDraws = 0;
  canvas.graph.edges = [{ id: 'a-b', source: 'a', target: 'b', sign: 1 }];
  canvas.draw = options => fullDraws.push(options);
  canvas.renderIncremental = () => incrementalDraws++;
  canvas.callbacks.computeGraph = request => { requests.push(request); return Promise.resolve({ routes: [], edgeIds: ['a-b'], full: false }); };
  canvas.callbacks.move = value => canvas.update(canvas.graph, { ...canvas.positions, ...value }, null, canvas.selection, false);
  canvas.down(event(30, 30, { node: 'a' }));
  canvas.move(event(50, 40)); canvas.move(event(70, 60)); canvas.up(event(70, 60));
  await canvas.routingPromise;
  assert.ok(incrementalDraws >= 2);
  assert.deepEqual(requests[0].payload.movedIds, ['a']);
  assert.ok(fullDraws.every(item => item.reroute === false));
});
test('自动排版预置的同步平移路线直接用于下一次绘制', () => {
  const { canvas } = harness(), draws = [];
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'a-b', source: 'a', target: 'b', sign: 1 }] };
  const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
  const routes = new Map([['a-b', { points: [{ x: 166, y: 31 }, { x: 300, y: 31 }] }]]);
  canvas.draw = options => draws.push(options);
  canvas.primeRoutes(graph, positions, routes);
  canvas.update(graph, positions, null, null, false);
  assert.equal(canvas.routed, routes);
  assert.deepEqual(draws, [{ reroute: false }]);
});
test('终态坐标与连线原子提交后只消费预置帧，不递归请求 Worker', async () => {
  const { canvas } = harness(); let requests = 0, commits = 0;
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'a-b', source: 'a', target: 'b', sign: 1 }] };
  const initial = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
  const settled = { a: { x: 0, y: 0 }, b: { x: 360, y: 0 } };
  const routes = [['a-b', { points: [{ x: 166, y: 31 }, { x: 360, y: 31 }] }]];
  canvas.draw = () => {};
  canvas.callbacks.computeGraph = () => { requests++; return Promise.resolve({ positions: settled, routes }); };
  canvas.callbacks.commitGeometry = result => {
    commits++;
    canvas.primeRoutes(graph, result.positions, new Map(result.routes));
    return canvas.update(graph, result.positions, null, null, false, { preserveRoutes: true });
  };
  await canvas.update(graph, initial, null, null, false);
  assert.equal(requests, 1);
  assert.equal(commits, 1);
  assert.deepEqual(canvas.positions, settled);
  assert.deepEqual(canvas.routed, new Map(routes));
});
test('视图显隐切换恢复既有路径，不重新生成连线或改变节点坐标', async () => {
  const { canvas } = harness(), draws = []; let requests = 0;
  const full = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [{ id: 'a-b', source: 'a', target: 'b', sign: 1 }, { id: 'b-c', source: 'b', target: 'c', sign: 1 }],
  };
  const partial = { nodes: full.nodes.slice(0, 2), edges: full.edges.slice(0, 1) };
  const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 600, y: 0 } };
  const original = routeGraphEdges(full, positions, cola);
  canvas.routed = original; canvas.draw = options => draws.push(options);
  canvas.callbacks.computeGraph = () => { requests++; return Promise.reject(new Error('显隐不应计算')); };
  for (let round = 0; round < 4; round++) {
    await canvas.update(partial, { a: positions.a, b: positions.b }, null, null, false, { preserveRoutes: true });
    assert.equal(canvas.routed.get('a-b'), original.get('a-b'));
    await canvas.update(full, positions, null, null, false, { preserveRoutes: true });
    assert.equal(canvas.routed.get('a-b'), original.get('a-b'));
    assert.equal(canvas.routed.get('b-c'), original.get('b-c'));
    assert.deepEqual(canvas.positions, positions);
  }
  assert.equal(requests, 0);
  assert.equal(draws.length, 8);
  assert.ok(draws.every(item => item.reroute === false));
});
test('节点松手后 Worker 结果会绕开新位置上的中间节点', async () => {
  const { canvas, event } = harness();
  canvas.graph = {
    nodes: [{ id: 'a' }, { id: 'blocker' }, { id: 'b' }],
    edges: [{ id: 'a-b', source: 'a', target: 'b', sign: 1 }],
  };
  canvas.positions = { a: { x: 0, y: 200 }, blocker: { x: 250, y: 0 }, b: { x: 500, y: 0 } };
  canvas.routed = routeGraphEdges(canvas.graph, canvas.positions, cola);
  canvas.renderIncremental = () => {};
  canvas.draw = () => {};
  canvas.callbacks.computeGraph = request => Promise.resolve({ routes: [...routeGraphEdges(request.payload.graph, request.payload.positions, cola)], edgeIds: ['a-b'], full: false });
  canvas.callbacks.canMove = id => id === 'a';
  canvas.callbacks.move = value => canvas.update(canvas.graph, { ...canvas.positions, ...value }, null, canvas.selection, false);
  canvas.down(event(30, 230, { node: 'a' }));
  canvas.move(event(30, 30)); canvas.up(event(30, 30));
  await canvas.routingPromise;
  assert.deepEqual(canvas.positions.a, { x: 0, y: 0 });
  assert.equal(routeGraphScore(canvas.graph, canvas.positions, canvas.routed)[0], 0);
  assert.ok(canvas.routed.get('a-b').points.some(point => point.y >= 86 || point.y <= -24));
});
test('Shift 框选并集，拖动中权限失效整组不提交，越界限制共同位移', () => {
  const { canvas, event, writes } = harness();
  canvas.selection = { type: 'node', id: 'a' };
  canvas.down(event(210, -10, { shiftKey: true })); canvas.up(event(400, 80));
  assert.deepEqual(canvas.selectedIds(), ['a', 'b']);
  canvas.down(event(30, 30, { button: 0, node: 'a' })); canvas.move(event(100, 100));
  canvas.callbacks.canMove = id => id !== 'b'; canvas.up(event(100, 100)); assert.deepEqual(writes, []);
  const points = { a: { x: 99990, y: -99990 }, b: { x: 99900, y: -99900 } };
  assert.deepEqual(movePositions(points, 300, -300), { a: { x: 100000, y: -100000 }, b: { x: 99910, y: -99910 } });
});
