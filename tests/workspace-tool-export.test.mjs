import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectCreatedMechanic as domainPolicy } from '../src/domain/document-export.mjs';
import { copiedExampleProject, runWorkspaceTool, runWorkspaceToolFailure } from './workspace-tool-harness.mjs';

const manifestPath = projectRoot => join(projectRoot, '.mechanics', 'workspace.json');
const readManifest = async projectRoot => JSON.parse(await readFile(manifestPath(projectRoot), 'utf8'));
const writeManifest = (projectRoot, value) => writeFile(manifestPath(projectRoot), JSON.stringify(value, null, 2) + '\n');
const selectionsOf = manifest => manifest.exportSelections ?? null;
// 已有机制图 ID 从工具的 scopes 命令取：canonical workspace.json 不存文件清单，它是读取时派生的。
const existingMechanic = async projectRoot => (await runWorkspaceTool(projectRoot, ['scopes'])).mechanics[0].id;

// 新建一张机制图并保存：走完整的 draft open → draft save 契约。
async function createMechanic(projectRoot, id, folder) {
  const opened = await runWorkspaceTool(projectRoot, folder === undefined
    ? ['draft', 'open', '--mechanic', id, '--name', '新建机制', '--scope', '验收新建默认导出。']
    : ['draft', 'open', '--mechanic', id, '--name', '新建机制', '--scope', '验收新建默认导出。', '--folder', folder]);
  return runWorkspaceTool(projectRoot, ['draft', 'save', '--draft', opened.draftId]);
}

test('新建机制图默认进入单独导出，视图不进清单', async t => {
  const projectRoot = await copiedExampleProject(t);
  const existing = await existingMechanic(projectRoot);
  const manifest = await readManifest(projectRoot);
  await writeManifest(projectRoot, { ...manifest, exportSelections: [{ kind: 'mechanic', mechanicId: existing }] });
  const saved = await createMechanic(projectRoot, 'fresh-graph');
  assert.equal(saved.exportSelection, 'added');
  assert.deepEqual(selectionsOf(await readManifest(projectRoot)),
    [{ kind: 'mechanic', mechanicId: existing }, { kind: 'mechanic', mechanicId: 'fresh-graph' }]);
});

test('机制图所在直接文件夹已选中时不补单独选择，清单零字节变动', async t => {
  const projectRoot = await copiedExampleProject(t);
  const directory = join(projectRoot, '.mechanics', 'mechanics', 'cards');
  await mkdir(directory, { recursive: true });
  // 先建一张落在 cards 里的机制图，再把导出范围收敛为该文件夹，最后新建第二张。
  await createMechanic(projectRoot, 'cards-first', 'cards');
  const curated = await readManifest(projectRoot);
  await writeManifest(projectRoot, { ...curated, exportSelections: [{ kind: 'folder', folder: 'cards' }] });
  const before = await readFile(manifestPath(projectRoot), 'utf8');
  const saved = await createMechanic(projectRoot, 'cards-second', 'cards');
  assert.equal(saved.exportSelection, 'covered-by-folder');
  assert.equal(await readFile(manifestPath(projectRoot), 'utf8'), before);
});

test('legacy-all 模式不新建导出清单', async t => {
  const projectRoot = await copiedExampleProject(t);
  const manifest = await readManifest(projectRoot);
  assert.equal(manifest.exportSelections, undefined);
  const saved = await createMechanic(projectRoot, 'legacy-graph');
  assert.equal(saved.exportSelection, 'legacy-all');
  assert.equal(JSON.parse(await readFile(manifestPath(projectRoot), 'utf8')).exportSelections, undefined);
  assert.ok((await runWorkspaceTool(projectRoot, ['scopes'])).mechanics.some(item => item.id === 'legacy-graph'));
});

test('草稿打开后 workspace.json 变化时显式冲突，草稿保留且清单不动', async t => {
  const projectRoot = await copiedExampleProject(t);
  const existing = await existingMechanic(projectRoot);
  const manifest = await readManifest(projectRoot);
  await writeManifest(projectRoot, { ...manifest, exportSelections: [{ kind: 'mechanic', mechanicId: existing }] });
  const opened = await runWorkspaceTool(projectRoot, ['draft', 'open', '--mechanic', 'conflicted-graph', '--name', '冲突机制', '--scope', '验收基线冲突。']);
  // 打开草稿之后改动 workspace.json（例如网页改了导出范围）。
  const later = await readManifest(projectRoot);
  await writeManifest(projectRoot, { ...later, exportSelections: [...later.exportSelections, { kind: 'mechanic', mechanicId: existing }] });
  const failure = await runWorkspaceToolFailure(projectRoot, ['draft', 'save', '--draft', opened.draftId]);
  // 工具的失败一律是 stderr 上的 JSON 事实：{ error: <code>, message }。
  assert.equal(failure.error, 'RESOURCE_REVISION_CONFLICT');
  const after = await readManifest(projectRoot);
  assert.equal(after.exportSelections.some(item => item.mechanicId === 'conflicted-graph'), false);
});

test('离线生成源直接复用共享导出政策 owner', async () => {
  const cases = [
    { selections: [{ kind: 'mechanic', mechanicId: 'other' }], mechanicId: 'fresh', folder: '', expected: true },
    { selections: [{ kind: 'mechanic', mechanicId: 'fresh' }], mechanicId: 'fresh', folder: '', expected: false },
    { selections: [{ kind: 'folder', folder: 'cards' }], mechanicId: 'fresh', folder: 'cards', expected: false },
    { selections: [{ kind: 'folder', folder: 'cards' }], mechanicId: 'fresh', folder: '', expected: true },
    { selections: undefined, mechanicId: 'fresh', folder: '', expected: false },
  ];
  for (const item of cases) {
    const manifest = item.selections === undefined ? {} : { exportSelections: structuredClone(item.selections) };
    assert.equal(domainPolicy(manifest, item.mechanicId, item.folder), item.expected, JSON.stringify(item));
  }
  // 分发通过构建内嵌唯一 owner；上方隔离安装用例验证实际行为，而不是复制第二份政策。
  const source = await readFile(new URL('../src/tools/workspace-tool-source.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ selectCreatedMechanic, mechanicFolderOf \} from '\.\.\/domain\/document-export\.mjs'/u);
  assert.doesNotMatch(source, /function selectCreatedMechanic/u);
});
