import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { prepareOpening } from '../src/web/view-files.mjs';

const source = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const apply = source.slice(source.indexOf('async function applyBrowsingWorkspace('), source.indexOf('async function activateSourceProject('));
const assign = source.slice(source.indexOf('function assignSnapshot('), source.indexOf('function editView('));
const fixture = () => ({ manifest: {}, definitions: { nodes: [{ id: 'a' }, { id: 'b' }], positions: {} }, rules: { rules: [] },
  mechanics: [{ id: 'first', focusNodeIds: ['a'], pinnedRuleIds: [], positions: {} }, { id: 'second', focusNodeIds: ['b'], pinnedRuleIds: [], positions: {} }],
  views: [{ id: 'combined', mechanicRegistrations: [{ mechanicId: 'first', visible: true }, { mechanicId: 'second', visible: true }], focusNodeIds: [], pinnedRuleIds: [], collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' }] });

function harness(opened, recent) {
  const remembered = [], controls = new Map();
  const context = vm.createContext({ workspace: null, viewId: null, legacy: false, activeId: null, viewRegistrations: [], viewFocusNodeIds: [], viewPinnedRuleIds: [], visible: [], viewPositions: {}, viewNodeColors: {}, viewNodeStyles: {}, scopedPositions: {}, viewRouteCache: null, graphHistory: null,
    cameras: new Map(), implicitPositions: new Map(), sidebarState: { queries: {}, folders: new Set(), lastOpened: null },
    prepareOpening, clone: structuredClone, console, opened, restore: true,
    $: id => { if (!controls.has(id)) controls.set(id, {}); return controls.get(id); },
    rememberCamera: () => {}, restoreRecentState: async () => { context.sidebarState.lastOpened = recent; },
    assignLayer: id => { context.activeId = id; }, rememberRecent: (kind, id) => remembered.push({ kind, id }),
    autosave: { reset() {} }, render: async () => {}, renderProjectTabs() {}, refreshReferenceProjects: async () => {}, showError(error) { throw error; }, rememberEditorTab() {}, canvas: { fit() {} },
  });
  vm.runInContext(assign + '\n' + apply, context);
  return { context, remembered };
}

test('默认机制恢复最近视图时，模式与注册快照同步后再赋值', async () => {
  const { context, remembered } = harness(fixture(), { kind: 'view', id: 'combined' });
  await vm.runInContext('applyBrowsingWorkspace(opened, { restoreSourceState: true })', context);
  assert.equal(context.viewId, 'combined'); assert.equal(context.activeId, null);
  assert.equal(context.sidebarState.page, 'views');
  assert.deepEqual(JSON.parse(JSON.stringify(context.visible)), ['first', 'second']);
  assert.deepEqual(remembered, [{ kind: 'view', id: 'combined' }]);
});

test('默认视图恢复最近机制时，不将 graphIds 当作视图注册表', async () => {
  const opened = fixture(); opened.manifest.lastView = { viewId: 'combined' };
  const { context, remembered } = harness(opened, { kind: 'mechanic', id: 'second' });
  await vm.runInContext('applyBrowsingWorkspace(opened, { restoreSourceState: true })', context);
  assert.equal(context.viewId, null); assert.equal(context.activeId, 'second');
  assert.equal(context.sidebarState.page, 'mechanics');
  assert.deepEqual(remembered, [{ kind: 'mechanic', id: 'second' }]);
});

test('不恢复最近记录时沿用明确默认候选', async () => {
  const { context, remembered } = harness(fixture(), { kind: 'view', id: 'combined' });
  await vm.runInContext('applyBrowsingWorkspace(opened, { restoreSourceState: false })', context);
  assert.equal(context.viewId, null); assert.equal(context.activeId, 'first');
  assert.deepEqual(remembered, [{ kind: 'mechanic', id: 'first' }]);
});
