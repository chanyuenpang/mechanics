import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const style = await readFile(new URL('../src/web/style.css', import.meta.url), 'utf8');
const queueCode = app.slice(app.indexOf('function mergeSingleMechanicSave('), app.indexOf('function updateStatus()'));
const folderCode = app.slice(app.indexOf('function mechanismFolderPath('), app.indexOf('async function newGraph('));

function harness({ fail = null, values = {} } = {}) {
  const workspace = { revision: 'before', directories: ['mechanics', 'mechanics/旧目录', 'mechanics/旧目录/子目录', 'mechanics/目标', 'views'],
    files: [{ kind: 'mechanic', id: 'one', path: 'mechanics/旧目录/one.mechanic.json' }],
    mechanics: [{ id: 'one', name: '机制一', nodeIds: ['health'], edges: [], positions: { health: { x: 1, y: 2 } } }],
    views: [{ id: 'view-one', mechanicRegistrations: [{ mechanicId: 'one', visible: false }], positions: { health: { x: 40, y: 80 } } }] };
  const calls = [], elements = new Map(), pauses = [], errors = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { open: false, close(value) { this.closed = value; }, append() {} });
    return elements.get(id);
  };
  const context = vm.createContext({ workspace, writeQueue: Promise.resolve(), pending: 0,
    draft: structuredClone(workspace.mechanics[0]), history: [{ preserved: true }],
    viewRegistrations: structuredClone(workspace.views[0].mechanicRegistrations), viewPositions: structuredClone(workspace.views[0].positions),
    sidebarState: { page: 'views', detailViewId: 'view-one', queries: { mechanics: '旧' }, folders: new Set(['mechanics/旧目录/子目录/']) },
    activeId: 'one', legacy: false, referenceSession: null,
    autosave: { blocked: false, pause(error) { this.blocked = true; pauses.push(error.code); } },
    $: element, updateStatus() {}, renderSidebar() {}, definitionMode: () => false, dirty: () => true,
    busy: () => false, showError: error => errors.push(error),
    field: (container, label, initial) => ({ value: values[label] ?? initial }), el: () => ({ append() {} }),
    dialog: async (_title, build, submit) => { build(element('container')); return submit(); },
    api: async (path, body) => { calls.push({ path, ...body }); if (fail) throw Object.assign(new Error('模拟失败'), { code: fail });
      const next = structuredClone(workspace); next.revision = 'after';
      if (path === '/api/mechanic-move') next.files[0].path = `mechanics/${body.folder}/one.mechanic.json`;
      return next; },
    resourcePath: () => workspace.files[0].path, graphName: () => '机制一', revealNewMechanic() {},
  });
  vm.runInContext(queueCode + '\n' + folderCode, context);
  return { context, calls, pauses, errors, elements, before: JSON.stringify({ draft: context.draft, history: context.history,
    registrations: context.viewRegistrations, positions: context.viewPositions }) };
}

test('文件夹移动对话框把新父目录与名称合为目标，并更新仅会话折叠路径', async () => {
  const { context, calls } = harness({ values: { 目标父文件夹: '目标', 文件夹名称: '改名' } });
  await vm.runInContext("moveMechanicFolderDialog('旧目录')", context);
  assert.equal(calls[0].sourceFolder, '旧目录'); assert.equal(calls[0].targetFolder, '目标/改名');
  assert.deepEqual([...context.sidebarState.folders], ['mechanics/目标/改名/子目录/']);
  assert.equal(vm.runInContext("mechanismFolderChoices('旧目录').some(([path]) => path.startsWith('旧目录'))", context), false);
});

test('新建和空目录删除使用明确接口，不操作视图注册', async () => {
  const created = harness({ values: { 所在文件夹: '目标', 文件夹名称: '新建' } });
  await vm.runInContext("createMechanicFolderDialog('')", created.context);
  assert.equal(created.calls[0].path, '/api/mechanic-folders'); assert.equal(created.calls[0].folder, '目标/新建');
  const deleted = harness(); await vm.runInContext("deleteMechanicFolderDialog('旧目录/子目录')", deleted.context);
  assert.equal(deleted.calls[0].path, '/api/mechanic-folder-delete'); assert.equal(deleted.calls[0].folder, '旧目录/子目录');
  assert.equal(deleted.context.viewRegistrations.length, 1);
});

test('无效名称在调用 API 前拒绝', async () => {
  const invalid = harness({ values: { 文件夹名称: '../escape' } });
  await assert.rejects(vm.runInContext("createMechanicFolderDialog('')", invalid.context), /路径分隔符/);
  assert.equal(invalid.calls.length, 0);
});

test('文件夹拖放只为有效跨目录机制显示预览，并在离开或结束时清理', () => {
  assert.match(app, /function canPreviewMechanicMove\(mechanicId, targetFolder\)/);
  assert.match(app, /return sourceFolder !== targetFolder/);
  assert.match(app, /function attachMechanicDropTarget\(target, targetFolder\)/);
  assert.match(app, /attachMechanicDropTarget\(heading, mechanismFolderPath\(entry\.fullPath\.slice\(0, -1\)\)\)/);
  assert.match(app, /attachMechanicDropTarget\(row, mechanismFolderPath\(item\.fullPath\.slice\(0, item\.fullPath\.lastIndexOf\('\/'\)\)\)\)/);
  assert.match(app, /event\.dataTransfer\.dropEffect = 'none'/);
  assert.match(app, /target\.ondragleave = event =>/);
  assert.match(app, /row\.ondragend = \(\) => \{ draggingMechanicId = null; row\.classList\.remove\('is-dragging'\); clearDropPreview\(\); \}/);
  assert.match(style, /\.resource-folder-heading\.drop-target,\.resource-row\.drop-target/);
  assert.match(app, /heading\.dataset\.dropPreview = '放开以移入'/);
});
