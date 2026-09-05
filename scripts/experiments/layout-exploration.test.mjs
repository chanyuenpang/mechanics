import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { leafHierarchy, groupBoundary } from './layout-structure.mjs';
import { clean, extractGeometry, measureGeometry, solveLayout, refineHierarchy, improves } from './layout-exploration.mjs';

const graphOf = (ids, pairs) => ({ nodes: ids.map(id => ({ id })), edges: pairs.map(([source, target], index) => ({ id: `e${index}`, source, target })) });

test('递归收缩叶子和独立树，保留环核心与每个原始节点', () => {
  const graph = graphOf(['a', 'b', 'c', 'x', 'y', 'm', 'n'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['x', 'a'], ['y', 'x'], ['m', 'n']]);
  const before = structuredClone(graph), result = leafHierarchy(graph);
  assert.equal(result.roots.length, 4);
  assert.deepEqual(new Set(result.roots.flatMap(root => root.members)), new Set(graph.nodes.map(node => node.id)));
  assert.equal(result.roots.flatMap(root => root.members).length, graph.nodes.length);
  assert.deepEqual(new Set(result.roots.find(root => root.members.includes('a')).members), new Set(['a', 'x', 'y']));
  assert.deepEqual(graph, before);
});

test('双向边按一个邻居收缩，但边界仍保存两条独立边和真实方向', () => {
  const graph = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['b', 'c']]);
  assert.equal(leafHierarchy(graph).roots.length, 1);
  const result = groupBoundary(graph, ['b', 'c']);
  assert.equal(result.boundary.length, 2);
  assert.deepEqual(result.interfaces, ['b']);
  assert.deepEqual(new Set(result.boundary.map(edge => edge.direction)), new Set(['in', 'out']));
});

test('几何规范化只去掉同向共线点，不吞掉回折', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }];
  assert.deepEqual(clean(points), points);
  assert.equal(clean([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]).length, 2);
});

test('跨层路径坐标使用真实 container 的偏移', () => {
  const graph = graphOf(['a', 'b'], [['a', 'b']]);
  const result = extractGeometry({ id: '__root', children: [{ id: 'g', x: 100, y: 200, children: [
    { id: 'a', x: 0, y: 0, width: 20, height: 20 }, { id: 'b', x: 50, y: 0, width: 20, height: 20 },
  ] }], edges: [{ id: 'e0', container: 'g', sections: [{ startPoint: { x: 20, y: 10 }, endPoint: { x: 50, y: 10 } }] }] }, graph);
  assert.deepEqual(result.routes[0][1].points, [{ x: 120, y: 210 }, { x: 150, y: 210 }]);
  assert.equal(measureGeometry(graph, result).invalid, 0);
});

const crossingFixture = () => ({
  graph: graphOf(['left', 'right', 'top', 'bottom'], [['left', 'right'], ['top', 'bottom']]),
  geometry: {
    positions: { left: { x: 0, y: 90 }, right: { x: 200, y: 90 }, top: { x: 100, y: 0 }, bottom: { x: 100, y: 200 } },
    sizes: Object.fromEntries(['left', 'right', 'top', 'bottom'].map(id => [id, { width: 20, height: 20 }])), groups: [],
    routes: [['e0', { points: [{ x: 20, y: 100 }, { x: 200, y: 100 }] }], ['e1', { points: [{ x: 110, y: 20 }, { x: 110, y: 200 }] }]],
  },
});

test('交叉、接触和共线路段重叠分别暴露，不能用接触冒充解交叉', () => {
  const { graph, geometry } = crossingFixture();
  const first = measureGeometry(graph, geometry);
  assert.equal(first.crossings, 1); assert.equal(first.invalid, 0); assert.equal(first.nodeHits, 0);
  geometry.routes[1][1].points = [{ x: 110, y: 20 }, { x: 110, y: 100 }, { x: 190, y: 100 }, { x: 190, y: 200 }, { x: 110, y: 200 }];
  const touching = measureGeometry(graph, geometry);
  assert.equal(touching.crossings, 0); assert.ok(touching.contacts > 0); assert.ok(touching.overlaps > 0);
  assert.equal(improves(touching, first), false);
});

test('缺失节点、断边、对角线与穿节点不能获得有效几何评价', () => {
  const { graph, geometry } = crossingFixture();
  delete geometry.positions.top;
  geometry.routes[0][1].points[1].y += 10;
  geometry.routes.pop();
  const metrics = measureGeometry(graph, geometry);
  assert.ok(metrics.invalid > 0); assert.equal(metrics.missing, 1);
});

test('相邻线段原路回折也计为自身重叠', () => {
  const { graph, geometry } = crossingFixture();
  geometry.routes[0][1].points = [{ x: 20, y: 100 }, { x: 80, y: 100 }, { x: 40, y: 100 }, { x: 200, y: 100 }];
  const metrics = measureGeometry(graph, geometry);
  assert.ok(metrics.selfCrossings > 0); assert.ok(metrics.overlaps > 0);
});

test('临时统一求解朝向后，全部路径仍按原始规则的 source → target 返回', async () => {
  const graph = graphOf(['hub', 'a', 'b'], [['hub', 'a'], ['a', 'hub'], ['hub', 'b']]);
  const before = structuredClone(graph), result = await solveLayout(graph, 'flat', { orientation: 'breadth-first' });
  assert.equal(result.metrics.invalid, 0); assert.equal(result.metrics.missing, 0);
  assert.equal(result.geometry.routes.length, graph.edges.length); assert.deepEqual(graph, before);
});

const interfaceFixture = (order, wide = false) => ({
  id: '__root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.crossingMinimization.hierarchicalSweepiness': '1' },
  children: [
    { id: 'source', width: 166, height: 100, layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' }, ports: order.map((id, index) => ({
      id: `p${id}`, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST', 'elk.port.index': String(index) },
    })) },
    { id: 'group', children: ['a', 'b'].map(id => ({ id, width: wide && id === 'b' ? 500 : 166, height: 62 })) },
    { id: 'target', width: 166, height: 100, ports: ['a', 'b'].map(id => ({ id: `q${id}`, width: 0, height: 0 })) },
  ],
  edges: ['a', 'b'].flatMap(id => [{ id: `in-${id}`, sources: [`p${id}`], targets: [id] }, { id: `out-${id}`, sources: [id], targets: [`q${id}`] }]),
});

test('实际 ELK：外部入口顺序改变组内顺序，组内出口顺序继续影响外部目标端口', async () => {
  const first = await new ELK().layout(interfaceFixture(['a', 'b']));
  const second = await new ELK().layout(interfaceFixture(['b', 'a']));
  const innerOrder = result => result.children[1].children.find(node => node.id === 'a').y < result.children[1].children.find(node => node.id === 'b').y;
  const outerOrder = result => result.children[2].ports.find(port => port.id === 'qa').y < result.children[2].ports.find(port => port.id === 'qb').y;
  assert.notEqual(innerOrder(first), innerOrder(second));
  assert.equal(innerOrder(first), outerOrder(first)); assert.equal(innerOrder(second), outerOrder(second));
});

test('实际 ELK：子组内部变宽会增大父组，并移动下游节点', async () => {
  const first = await new ELK().layout(interfaceFixture(['a', 'b']));
  const second = await new ELK().layout(interfaceFixture(['a', 'b'], true));
  assert.ok(second.children[1].width > first.children[1].width + 300);
  assert.ok(second.children[2].x > first.children[2].x + 300);
});

test('迭代保留改善记录，并与不分组候选比较，展开不丢失边', async () => {
  const graph = graphOf(['a', 'b', 'c', 'd', 'e', 'f'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'd']]);
  const result = await refineHierarchy(graph, { orientation: 'breadth-first', rounds: 2 });
  assert.equal(result.geometry.routes.length, graph.edges.length);
  assert.equal(result.metrics.invalid, 0);
  assert.equal(improves(result.refinement.comparison.flat, result.metrics), false);
  const history = result.refinement.accepted;
  for (let i = 1; i < history.length; i++) assert.equal(improves(history[i].metrics, history[i - 1].metrics), true);
});
