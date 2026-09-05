import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMechanicNavigation, buildResourceNavigation, buildViewNavigation } from '../src/web/resource-navigation.mjs';

const view = (id, name, registrations = []) => ({ id, name, mechanicRegistrations: registrations });
const mechanic = (id, name, scope = '测试范围') => ({ id, name, scope });
const file = (kind, id, path) => ({ kind, id, path });

function treeMechanics(entries) {
  return entries.flatMap(entry => entry.kind === 'directory' ? treeMechanics(entry.children) : [entry]);
}

test('机制目录包含真实空目录，空工作区也能浏览文件夹，不混入仅视图目录', () => {
  const workspace = { mechanics: [], views: [view('empty-view', '空视图')],
    files: [file('view', 'empty-view', 'views/empty.view.json')],
    directories: ['mechanics', 'mechanics/战斗', 'mechanics/战斗/子目录', 'mechanics/未使用', 'views'] };
  const before = structuredClone(workspace), result = buildMechanicNavigation(workspace);
  assert.equal(result.commonRoot, 'mechanics/');
  assert.deepEqual(result.tree.map(item => item.name).sort(), ['战斗', '未使用']);
  const combat = result.tree.find(item => item.name === '战斗');
  assert.equal(combat.fullPath, 'mechanics/战斗/');
  assert.equal(combat.children[0].fullPath, 'mechanics/战斗/子目录/');
  assert.deepEqual(combat.children[0].children, []);
  assert.deepEqual(treeMechanics(result.tree), []);
  assert.deepEqual(workspace, before);
});

test('机制移动后目录依据新路径投影，保留旧空目录且视图成员不变', () => {
  const registrations = [{ mechanicId: 'one', visible: false }];
  const workspace = { mechanics: [mechanic('one', '机制一')], views: [view('view-one', '观察', registrations)],
    files: [file('mechanic', 'one', 'mechanics/新目录/one.mechanic.json'), file('view', 'view-one', 'views/one.view.json')],
    directories: ['mechanics', 'mechanics/旧目录', 'mechanics/新目录', 'views'] };
  const result = buildMechanicNavigation(workspace, { currentId: 'one' });
  assert.equal(result.tree.find(item => item.name === '旧目录').children.length, 0);
  assert.equal(result.tree.find(item => item.name === '新目录').children[0].id, 'one');
  assert.deepEqual(workspace.views[0].mechanicRegistrations, registrations);
});

test('视图查询独立匹配名称、ID、完整路径，当前与最近顺序稳定并提供计数和同名消歧', () => {
  const workspace = {
    views: [
      view('battle-a', '战斗', [{ mechanicId: 'one', visible: true }, { mechanicId: 'two', visible: false }]),
      view('battle-b', '战斗', [{ mechanicId: 'two', visible: true }]),
      view('world', '世界'),
    ],
    files: [
      file('view', 'battle-a', 'views/章节一/战斗.view.json'),
      file('view', 'battle-b', 'views/章节二/战斗.view.json'),
      file('view', 'world', 'views/world.view.json'),
    ],
  };
  const all = buildViewNavigation(workspace, { currentId: 'battle-b', recentIds: ['world', 'battle-a'] });
  assert.deepEqual(all.items.map(item => item.id), ['world', 'battle-a', 'battle-b']);
  assert.deepEqual(all.items.find(item => item.id === 'battle-b'), {
    kind: 'view', id: 'battle-b', name: '战斗', fullPath: 'views/章节二/战斗.view.json', duplicateName: true,
    disambiguationPath: 'views/章节二/战斗.view.json', current: true, recent: false, recentRank: null,
    registeredCount: 1, visibleCount: 1,
  });
  assert.deepEqual(buildViewNavigation(workspace, { query: 'battle-a' }).items.map(item => item.id), ['battle-a']);
  assert.deepEqual(buildViewNavigation(workspace, { query: '章节二' }).items.map(item => item.id), ['battle-b']);
  assert.deepEqual(buildViewNavigation(workspace, { query: '世界' }).items.map(item => item.id), ['world']);
});

test('机制空查询提供 current/recent 快捷项和压缩 mechanics 根的目录树，保留完整路径与 scope', () => {
  const workspace = {
    mechanics: [mechanic('root', '根机制', '全局'), mechanic('hand', '手牌', '战斗'), mechanic('enemy', '敌人', '关卡')],
    files: [
      file('mechanic', 'root', 'mechanics/root.mechanic.json'),
      file('mechanic', 'hand', 'mechanics/combat/hand.mechanic.json'),
      file('mechanic', 'enemy', 'mechanics/combat/enemies/enemy.mechanic.json'),
    ],
  };
  const result = buildMechanicNavigation(workspace, { currentId: 'hand', recentIds: ['enemy', 'root'] });
  assert.equal(result.mode, 'browse'); assert.equal(result.commonRoot, 'mechanics/');
  assert.deepEqual(result.featured.map(item => item.id), ['enemy', 'hand', 'root']);
  assert.equal(result.items.length, 0); assert.equal(result.tree[0].kind, 'directory');
  assert.equal(result.tree[0].name, 'combat'); assert.equal(result.tree[0].fullPath, 'mechanics/combat/');
  const rows = treeMechanics(result.tree);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(item => item.id === 'hand'), {
    kind: 'mechanic', id: 'hand', name: '手牌', fullPath: 'mechanics/combat/hand.mechanic.json',
    duplicateName: false, disambiguationPath: null, current: true, recent: false, recentRank: null,
    scope: '战斗', displayPath: 'combat/hand.mechanic.json',
  });
});

test('机制查询返回不分页的扁平结果并始终用完整路径搜索；非共同根不压缩', () => {
  const workspace = {
    mechanics: [mechanic('hand', '同名', '手牌范围'), mechanic('enemy', '同名', '敌人范围'), mechanic('world', '世界', '世界范围')],
    files: [
      file('mechanic', 'hand', 'mechanics/combat/hand.mechanic.json'),
      file('mechanic', 'enemy', 'chapters/enemy.mechanic.json'),
      file('mechanic', 'world', 'mechanics/world.mechanic.json'),
    ],
  };
  const byPath = buildMechanicNavigation(workspace, { query: 'chapters enemy', currentId: 'hand' });
  assert.equal(byPath.mode, 'search'); assert.equal(byPath.commonRoot, '');
  assert.deepEqual(byPath.items.map(item => item.id), ['enemy']);
  assert.equal(byPath.items[0].scope, '敌人范围'); assert.equal(byPath.items[0].duplicateName, true);
  assert.equal(byPath.items[0].disambiguationPath, 'chapters/enemy.mechanic.json');
  assert.deepEqual(buildMechanicNavigation(workspace, { query: 'hand' }).items.map(item => item.id), ['hand']);
  assert.deepEqual(buildMechanicNavigation(workspace, { query: '世界' }).items.map(item => item.id), ['world']);
});

test('100 视图和 200 机制投影完整、确定且视图与机制 query 互不串扰', () => {
  const views = Array.from({ length: 100 }, (_, index) => view(`view-${String(index).padStart(3, '0')}`, `视图 ${index}`,
    Array.from({ length: index % 5 }, (__, item) => ({ mechanicId: `mechanic-${item}`, visible: item % 2 === 0 }))));
  const mechanics = Array.from({ length: 200 }, (_, index) => mechanic(`mechanic-${String(index).padStart(3, '0')}`, `机制 ${index}`, `范围 ${index}`));
  const workspace = {
    views, mechanics,
    files: [
      ...views.map(item => file('view', item.id, `views/${item.id}.view.json`)),
      ...mechanics.map(item => file('mechanic', item.id, `mechanics/group-${Number(item.id.slice(-3)) % 10}/${item.id}.mechanic.json`)),
    ],
  };
  const options = {
    viewQuery: 'view-', mechanicQuery: 'mechanic-', currentViewId: 'view-099', currentMechanicId: 'mechanic-199',
    recentViewIds: ['view-050', 'view-000'], recentMechanicIds: ['mechanic-150', 'mechanic-000'],
  };
  const first = buildResourceNavigation(workspace, options), second = buildResourceNavigation(workspace, options);
  assert.deepEqual(first, second);
  assert.equal(first.views.items.length, 100); assert.equal(first.mechanics.items.length, 200);
  assert.deepEqual(first.views.items.slice(0, 3).map(item => item.id), ['view-000', 'view-001', 'view-002']);
  assert.deepEqual(first.mechanics.items.slice(0, 3).map(item => item.id), ['mechanic-000', 'mechanic-010', 'mechanic-020']);
  const separated = buildResourceNavigation(workspace, { viewQuery: 'view-099', mechanicQuery: 'mechanic-001' });
  assert.deepEqual(separated.views.items.map(item => item.id), ['view-099']);
  assert.deepEqual(separated.mechanics.items.map(item => item.id), ['mechanic-001']);
});
