import test from 'node:test';
import assert from 'node:assert/strict';
import { composeView, moveMechanic, registerMechanic, registeredMechanicIds, removeMechanic, setMechanicVisibility, visibleMechanicIds } from '../src/domain/view.mjs';
import { queryWorkspace } from '../src/domain/query.mjs';

const node = id => ({ id, label: id, description: id, increaseMeaning: id });
const mechanic = (id, nodeId) => ({ id, name: id, scope: '测试', nodeIds: [nodeId], edges: [], positions: {} });
const workspace = {
  manifest: { id: 'test' }, revision: 'one',
  definitions: { nodes: [node('a'), node('b')] },
  mechanics: [mechanic('one', 'a'), mechanic('two', 'b')],
  files: [{ kind: 'mechanic', id: 'one', path: 'one.mechanic.json' }, { kind: 'mechanic', id: 'two', path: 'two.mechanic.json' }, { kind: 'view', id: 'battle', path: 'battle.view.json' }],
  views: [],
};

test('注册顺序稳定，新增默认可见，重复注册与修改未注册项明确失败', () => {
  const empty = { mechanicRegistrations: [], collapsedNodeIds: [], positions: {} };
  const one = registerMechanic(empty, 'two'), two = registerMechanic(one, 'one');
  assert.deepEqual(registeredMechanicIds(two), ['two', 'one']);
  assert.deepEqual(visibleMechanicIds(two), ['two', 'one']);
  assert.throws(() => registerMechanic(two, 'one'), { code: 'VIEW_MECHANIC_ALREADY_REGISTERED' });
  assert.throws(() => setMechanicVisibility(two, 'missing', false), { code: 'VIEW_MECHANIC_NOT_REGISTERED' });
});

test('隐藏只改变可见投影，注册事实和位置保持；Agent 查询不把视图当作语义范围', () => {
  const view = { schemaVersion: 3, kind: 'view', workspaceId: 'test', id: 'battle', name: '战斗',
    mechanicRegistrations: [{ mechanicId: 'one', visible: true }, { mechanicId: 'two', visible: false }],
    collapsedNodeIds: [], positions: { b: { x: 10, y: 20 } }, structuralPresentation: 'line' };
  const data = { ...workspace, views: [view] };
  assert.deepEqual(composeView(data, view).nodes.map(item => item.id), ['a']);
  const scopes = queryWorkspace(data, { command: 'scopes' });
  assert.deepEqual(scopes.views.map(item => item.id), ['battle']);
  const concept = queryWorkspace(data, { command: 'search', query: 'b' });
  assert.equal(concept.concept.id, 'b');
  const hidden = setMechanicVisibility(view, 'one', false);
  assert.deepEqual(hidden.positions, view.positions);
  assert.deepEqual(registeredMechanicIds(hidden), ['one', 'two']);
  assert.deepEqual(composeView(data, hidden).nodes, []);
});

test('排序和移除只改变注册清单，并保留视图位置与折叠记忆', () => {
  const view = { mechanicRegistrations: [{ mechanicId: 'one', visible: true }, { mechanicId: 'two', visible: false }],
    collapsedNodeIds: ['a'], positions: { a: { x: 12, y: 34 }, b: { x: 56, y: 78 } } };
  const moved = moveMechanic(view, 'two', 0);
  assert.deepEqual(registeredMechanicIds(moved), ['two', 'one']);
  assert.deepEqual(moved.positions, view.positions); assert.deepEqual(moved.collapsedNodeIds, view.collapsedNodeIds);
  const removed = removeMechanic(moved, 'two');
  assert.deepEqual(registeredMechanicIds(removed), ['one']);
  assert.deepEqual(removed.positions, view.positions); assert.deepEqual(removed.collapsedNodeIds, view.collapsedNodeIds);
  assert.throws(() => moveMechanic(view, 'missing', 0), { code: 'VIEW_MECHANIC_NOT_REGISTERED' });
  assert.throws(() => moveMechanic(view, 'one', 2), { code: 'VIEW_MECHANIC_ORDER_INVALID' });
  assert.throws(() => removeMechanic(view, 'missing'), { code: 'VIEW_MECHANIC_NOT_REGISTERED' });
});
