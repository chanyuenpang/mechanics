import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphCanvas, nodesInBox, movePositions } from '../src/web/canvas.mjs';

function harness() {
  // 直接驱动真实手势方法；DOM 绘制由浏览器验收覆盖。
  const canvas = Object.create(GraphCanvas.prototype), writes = [];
  Object.assign(canvas, { camera: { x: 70, y: 90, scale: .5 }, positions: { a: { x: 0, y: 0 }, b: { x: 220, y: 0 } },
    graph: { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] }, mode: 'select', draw() {}, transform() {},
    root: { getBoundingClientRect: () => ({ left: 10, top: 20 }), setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {}, classList: { add() {}, remove() {} } },
    callbacks: { select: value => { canvas.selection = value; }, canMove: () => true, move: value => writes.push(value) },
  });
  const event = (x, y, { button = 2, node, shiftKey = false } = {}) => ({ clientX: 80 + x * .5, clientY: 110 + y * .5,
    button, pointerId: 1, shiftKey, preventDefault() {}, target: { closest: selector => node && selector === '[data-node]' ? { dataset: { node } } : null } });
  return { canvas, writes, event };
}
test('反向框选使用世界坐标、矩形相交与可见节点，轻点右键不改选择', () => {
  const { canvas, event, writes } = harness();
  canvas.down(event(400, 100)); canvas.move(event(-10, -10)); canvas.up(event(-10, -10));
  assert.deepEqual(canvas.selectedIds(), ['a', 'b']); assert.deepEqual(writes, []);
  canvas.down(event(500, 100)); canvas.up(event(501, 100));
  assert.deepEqual(canvas.selectedIds(), ['a', 'b']);
  assert.deepEqual(nodesInBox(canvas.graph.nodes, canvas.positions, { x: 165, y: 20 }, { x: 170, y: 25 }), ['a']);
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
