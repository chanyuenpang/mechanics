import test from 'node:test';
import assert from 'node:assert/strict';
import { composeView, registerMechanic, registeredMechanicIds, setMechanicVisibility, visibleMechanicIds } from '../src/domain/view.mjs';
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

test('隐藏只改变可见投影，注册事实和位置保持；Agent 只查询可见机制', () => {
  const view = { schemaVersion: 2, kind: 'view', workspaceId: 'test', id: 'battle', name: '战斗',
    mechanicRegistrations: [{ mechanicId: 'one', visible: true }, { mechanicId: 'two', visible: false }],
    collapsedNodeIds: [], positions: { b: { x: 10, y: 20 } } };
  const data = { ...workspace, views: [view] };
  assert.deepEqual(composeView(data, view).nodes.map(item => item.id), ['a']);
  const scopes = queryWorkspace(data, { command: 'scopes' });
  assert.deepEqual(scopes.views[0].mechanicRegistrations.map(item => [item.mechanicId, item.visible]), [['one', true], ['two', false]]);
  const graph = queryWorkspace(data, { command: 'graph', view: 'battle' });
  assert.deepEqual(graph.scope.mechanicIds, ['one']);
  assert.equal(graph.scope.visibleMechanicCount, 1); assert.equal(graph.scope.registeredMechanicCount, 2);
  assert.deepEqual(graph.nodes.map(item => item.id), ['a']);
  const hidden = setMechanicVisibility(view, 'one', false);
  assert.deepEqual(hidden.positions, view.positions);
  assert.deepEqual(registeredMechanicIds(hidden), ['one', 'two']);
  assert.deepEqual(composeView(data, hidden).nodes, []);
});
