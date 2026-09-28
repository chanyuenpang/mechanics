import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planV7ToV8Migration } from '../src/server/migration.mjs';
import { migrateWorkspace } from '../src/server/store.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { commitFiles } from '../src/server/files.mjs';
import { copyExampleFixture } from './example-fixture.mjs';
import { migrateLegacyProject } from '../src/server/migrate-legacy-project.mjs';
import { createProjectManager } from '../src/server/project-manager.mjs';

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-v7-'));
  await copyExampleFixture(root);
  const workspace = join(root, '.mechanics');
  t.after(() => rm(root, { recursive: true, force: true }));
  // 构造真实的 v7 文件布局：当时规则仍内联在每张机制图中，definitions 文件名也尚未收敛。
  const manifestPath = join(workspace, 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const definitions = JSON.parse(await readFile(join(workspace, manifest.definitions), 'utf8'));
  const registry = JSON.parse(await readFile(join(workspace, manifest.rules), 'utf8'));
  await rename(join(workspace, manifest.definitions), join(workspace, 'definitions.graph.json'));
  await rm(join(workspace, manifest.rules));
  const files = ['workspace.json', 'definitions.graph.json', 'mechanics/basic-rules.mechanic.json', 'mechanics/encounter.mechanic.json', 'mechanics/hand.mechanic.json'];
  await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 7, definitions: 'definitions.graph.json', rules: undefined }, null, 2) + '\n');
  await writeFile(join(workspace, 'definitions.graph.json'), JSON.stringify({ ...definitions, schemaVersion: 3 }, null, 2) + '\n');
  for (const file of files.filter(path => path.endsWith('.mechanic.json'))) {
    const path = join(workspace, file), current = JSON.parse(await readFile(path, 'utf8'));
    const edges = registry.rules.filter(rule => current.pinnedRuleIds.includes(rule.id)).map(rule => {
      const edge = structuredClone(rule); delete edge.inheritance; return edge;
    });
    const { focusNodeIds, pinnedRuleIds, implementationStatus, ...rest } = current;
    await writeFile(path, JSON.stringify({ ...rest, schemaVersion: 3, nodeIds: focusNodeIds, edges }, null, 2) + '\n');
  }
  const viewFile = 'migration.view.json';
  await writeFile(join(workspace, viewFile), JSON.stringify({
    schemaVersion: 2, kind: 'view', workspaceId: 'sample-card-game', id: 'migration-view', name: '迁移视图',
    mechanicRegistrations: [{ mechanicId: 'basic-rules', visible: true }], collapsedNodeIds: [], positions: {},
  }, null, 2) + '\n');
  files.push(viewFile);
  return { root, workspace, files };
}
// v12 是当前迁移链的最后一跳：夹具回到 rules.json 已存在、但 mechanism/view 还没有显式展示状态的版本。
async function v12Fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-v12-'));
  await copyExampleFixture(root);
  const workspace = join(root, '.mechanics');
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ['workspace.json', 'definitions.json', 'rules.json'];
  const manifestPath = join(workspace, 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 12 }, null, 2) + '\n');
  for (const name of await readdir(join(workspace, 'mechanics'))) {
    const path = join(workspace, 'mechanics', name);
    const document = JSON.parse(await readFile(path, 'utf8'));
    const { taxonomyPresentation, implementationStatus, ...rest } = document;
    await writeFile(path, JSON.stringify({ ...rest, schemaVersion: 7 }, null, 2) + '\n');
    files.push('mechanics/' + name);
  }
  return { root, workspace, files };
}
async function v13Fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-v13-'));
  await copyExampleFixture(root);
  const workspace = join(root, '.mechanics');
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ['workspace.json', 'definitions.json', 'rules.json'];
  const manifestPath = join(workspace, 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 13 }, null, 2) + '\n');
  for (const name of await readdir(join(workspace, 'mechanics'))) {
    const path = join(workspace, 'mechanics', name);
    const { implementationStatus, ...document } = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...document, schemaVersion: 8 }, null, 2) + '\n');
    files.push('mechanics/' + name);
  }
  return { root, workspace, files };
}
async function snapshot(root, files) { return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(root, file), 'utf8')]))); }

test('逐版本迁移必须显式提交：兼容读取关系改名、限定词收回端点且不生成派生', async t => {
  const { workspace, files } = await fixture(t);
  const legacyPath = join(workspace, 'mechanics', 'hand.mechanic.json');
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8')); legacy.edges[0].relation = 'belongsTo'; delete legacy.edges[0].sign; await writeFile(legacyPath, JSON.stringify(legacy));
  const plan = await planV7ToV8Migration(workspace);
  assert.equal(plan.from, 7); assert.equal(plan.to, 8); assert.equal(plan.summary.derivedRulesCreated, 0);
  const migratedViewPlan = plan.documents.find(item => item.document.kind === 'view').document;
  assert.equal(migratedViewPlan.schemaVersion, 3);
  assert.equal(migratedViewPlan.structuralPresentation, 'line');
  const outcome = await migrateWorkspace(workspace, { revision: plan.revision, execute: true });
  assert.equal(outcome.migrated, true); assert.equal(outcome.derivedRulesCreated, 0); assert.equal(outcome.renamedRelations, 1);
  const v8ToV9 = await migrateWorkspace(workspace, { from: 8, to: 9 });
  assert.equal(v8ToV9.preview, true);
  await migrateWorkspace(workspace, { from: 8, to: 9, revision: v8ToV9.revision, execute: true });
  const v9ToV10 = await migrateWorkspace(workspace, { from: 9, to: 10 });
  assert.equal(v9ToV10.preview, true);
  await migrateWorkspace(workspace, { from: 9, to: 10, revision: v9ToV10.revision, execute: true });
  const v10ToV12 = await migrateWorkspace(workspace, { from: 10, to: 12 });
  await migrateWorkspace(workspace, { from: 10, to: 12, revision: v10ToV12.revision, execute: true });
  const v12ToV13 = await migrateWorkspace(workspace, { from: 12, to: 13 });
  await migrateWorkspace(workspace, { from: 12, to: 13, revision: v12ToV13.revision, execute: true });
  const v13ToV14 = await migrateWorkspace(workspace, { from: 13, to: 14 });
  await migrateWorkspace(workspace, { from: 13, to: 14, revision: v13ToV14.revision, execute: true });
  const migrated = await readWorkspace(workspace);
  assert.equal(migrated.manifest.schemaVersion, 14);
  assert.equal(migrated.definitions.schemaVersion, 7);
  assert.ok(migrated.mechanics.every(item => item.schemaVersion === 9 && item.implementationStatus === 'design' && JSON.stringify(item.taxonomyPresentation) === JSON.stringify({ mode: 'label', expandedNodeIds: [] })));
  assert.ok(migrated.views.every(item => item.schemaVersion === 5 && item.structuralPresentation === 'line' && JSON.stringify(item.taxonomyPresentation) === JSON.stringify({ mode: 'label', expandedNodeIds: [] })));
  assert.ok(migrated.rules.rules.filter(item => item.relation === 'influence').every(item => item.inheritance.mode === 'none'));
  assert.equal(migrated.rules.rules.find(item => item.source === 'hand' || item.id === 'evade-2-repel')?.relation, 'specializes');
  assert.equal(files.length, 6);
});


test('v12 → v13 预览与执行把全部机制图与视图升级为显式展示状态', async t => {
  const { workspace, files } = await v12Fixture(t);
  const preview = await migrateWorkspace(workspace, { from: 12, to: 13 });
  assert.equal(preview.preview, true);
  assert.equal(preview.mechanics, 3);
  assert.equal(preview.views, 0);
  const before = await snapshot(workspace, files);
  // 预览后任何文件变化都必须阻止执行，且不留下部分升级。
  await writeFile(join(workspace, 'workspace.json'), (await readFile(join(workspace, 'workspace.json'), 'utf8')) + ' ');
  const contaminated = await snapshot(workspace, files);
  await assert.rejects(migrateWorkspace(workspace, { from: 12, to: 13, revision: preview.revision, execute: true }),
    { code: 'MIGRATION_REVISION_CONFLICT' });
  assert.deepEqual(await snapshot(workspace, files), contaminated);
  await writeFile(join(workspace, 'workspace.json'), before['workspace.json']);
  assert.deepEqual(await snapshot(workspace, files), before);
  const fresh = await migrateWorkspace(workspace, { from: 12, to: 13 });
  const migrated = await migrateWorkspace(workspace, { from: 12, to: 13, revision: fresh.revision, execute: true });
  assert.equal(migrated.migrated, true);
  const next = await migrateWorkspace(workspace, { from: 13, to: 14 });
  await migrateWorkspace(workspace, { from: 13, to: 14, revision: next.revision, execute: true });
  const reopened = await readWorkspace(workspace);
  assert.equal(reopened.manifest.schemaVersion, 14);
  assert.equal(reopened.compatibilityMode, false);
  const explicit = JSON.stringify({ mode: 'label', expandedNodeIds: [] });
  assert.ok(reopened.mechanics.every(item => item.schemaVersion === 9 && item.implementationStatus === 'design' && JSON.stringify(item.taxonomyPresentation) === explicit));
  const onDisk = Object.fromEntries(await Promise.all(files.map(async file => [file, JSON.parse(await readFile(join(workspace, file), 'utf8'))])));
  assert.equal(onDisk['workspace.json'].schemaVersion, 14);
  for (const [file, document] of Object.entries(onDisk)) if (document.kind === 'mechanic') {
    assert.equal(document.schemaVersion, 9);
    assert.equal(document.implementationStatus, 'design');
    assert.deepEqual(document.taxonomyPresentation, { mode: 'label', expandedNodeIds: [] });
  }
});

test('v13 → v14 全图显式 design，预览冲突与候选失败均零写入', async t => {
  const { workspace, files } = await v13Fixture(t);
  const before = await snapshot(workspace, files);
  const preview = await migrateWorkspace(workspace, { from: 13, to: 14 });
  assert.equal(preview.preview, true);
  assert.equal(preview.designatedAsDesign, 3);
  assert.deepEqual(await snapshot(workspace, files), before);
  const changed = join(workspace, 'mechanics/hand.mechanic.json');
  await writeFile(changed, before['mechanics/hand.mechanic.json'] + ' ');
  const conflicting = await snapshot(workspace, files);
  await assert.rejects(migrateWorkspace(workspace, { from: 13, to: 14, revision: preview.revision, execute: true }), { code: 'MIGRATION_REVISION_CONFLICT' });
  assert.deepEqual(await snapshot(workspace, files), conflicting);
  await writeFile(changed, before['mechanics/hand.mechanic.json']);
  const invalid = JSON.parse(before['mechanics/hand.mechanic.json']);
  invalid.focusNodeIds.push('missing-concept');
  await writeFile(changed, JSON.stringify(invalid));
  const damaged = await snapshot(workspace, files);
  await assert.rejects(migrateWorkspace(workspace, { from: 13, to: 14 }), { code: 'MIGRATION_VALIDATION_FAILED' });
  assert.deepEqual(await snapshot(workspace, files), damaged);
  await writeFile(changed, before['mechanics/hand.mechanic.json']);
  const plan = await migrateWorkspace(workspace, { from: 13, to: 14 });
  await migrateWorkspace(workspace, { from: 13, to: 14, revision: plan.revision, execute: true });
  const opened = await readWorkspace(workspace);
  assert.equal(opened.manifest.schemaVersion, 14);
  assert.equal(opened.compatibilityMode, false);
  assert.ok(opened.mechanics.every(item => item.schemaVersion === 9 && item.implementationStatus === 'design'));
  assert.equal(opened.views.every(item => item.schemaVersion === 5), true);
});

test('正式 v14 缺失或非法实现状态报错，不合成默认；旧 v13 兼容只读不误标 implemented', async t => {
  const { workspace } = await v13Fixture(t);
  const compatible = await readWorkspace(workspace);
  assert.equal(compatible.compatibilityMode, true);
  assert.ok(compatible.mechanics.every(item => item.implementationStatus === 'design'));
  const preview = await migrateWorkspace(workspace, { from: 13, to: 14 });
  await migrateWorkspace(workspace, { from: 13, to: 14, revision: preview.revision, execute: true });
  const file = join(workspace, 'mechanics/hand.mechanic.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  for (const value of [undefined, 'unknown', null]) {
    await writeFile(file, JSON.stringify({ ...original, implementationStatus: value }) + '\n');
    await assert.rejects(readWorkspace(workspace), { code: 'INVALID_DOCUMENT' });
  }
  await writeFile(file, JSON.stringify({ ...original, implementationStatus: 'implemented' }) + '\n');
  assert.equal((await readWorkspace(workspace)).mechanics.find(item => item.id === 'hand').implementationStatus, 'implemented');
});

test('v12 → v13 在多父 is-a 候选上失败且零部分写入', async t => {
  const { workspace, files } = await v12Fixture(t);
  const rulesPath = join(workspace, 'rules.json');
  const rules = JSON.parse(await readFile(rulesPath, 'utf8'));
  // 同一概念出现两条 is-a 出边就是多父：迁移必须整体拒绝。
  rules.rules.push({ id: 'evade-2-melee', source: 'evade', target: 'melee', relation: 'specializes' });
  rules.rules.push({ id: 'evade-2-failure', source: 'evade', target: 'failure', relation: 'specializes' });
  await writeFile(rulesPath, JSON.stringify(rules, null, 2) + '\n');
  const before = await snapshot(workspace, files);
  await assert.rejects(migrateWorkspace(workspace, { from: 12, to: 13 }), { code: 'MIGRATION_VALIDATION_FAILED' });
  assert.deepEqual(await snapshot(workspace, files), before);
});

test('打开 v7 项目时按同一迁移链自动升级到当前协议', async t => {
  const { root } = await fixture(t);
  const manager = createProjectManager({ syncProjectAssets: async () => ({}) });
  try {
    const opened = await manager.open({ projectRoot: root });
    assert.deepEqual(opened.projectUpgrade, { upgraded: true, from: 7, schemaVersion: 14 });
    assert.equal(opened.manifest.schemaVersion, 14);
    const onDisk = JSON.parse(await readFile(join(root, '.mechanics', 'workspace.json'), 'utf8'));
    assert.equal(onDisk.schemaVersion, 14);
    assert.deepEqual(onDisk.rules, 'rules.json');
    const explicit = JSON.stringify({ mode: 'label', expandedNodeIds: [] });
    assert.ok(opened.mechanics.every(item => item.schemaVersion === 9 && item.implementationStatus === 'design' && JSON.stringify(item.taxonomyPresentation) === explicit));
    assert.ok(opened.views.every(item => item.schemaVersion === 5 && JSON.stringify(item.taxonomyPresentation) === explicit));
  } finally {
    // 必须在 fixture 清理前关闭：关闭会等待后台文档发布结束。
    await manager.close();
  }
});
test('候选无效、版本未知和 revision 冲突均不写入部分升级', async t => {
  const { workspace, files } = await fixture(t);
  const before = await snapshot(workspace, files);
  const broken = join(workspace, 'mechanics', 'hand.mechanic.json');
  const document = JSON.parse(await readFile(broken, 'utf8')); document.edges[0].target = 'missing'; await writeFile(broken, JSON.stringify(document));
  const badBefore = await snapshot(workspace, files);
  await assert.rejects(planV7ToV8Migration(workspace), { code: 'MIGRATION_VALIDATION_FAILED' });
  assert.deepEqual(await snapshot(workspace, files), badBefore);
  await writeFile(broken, before['mechanics/hand.mechanic.json']);
  const plan = await planV7ToV8Migration(workspace);
  await writeFile(join(workspace, 'workspace.json'), (await readFile(join(workspace, 'workspace.json'), 'utf8')) + ' ');
  const conflictBefore = await snapshot(workspace, files);
  await assert.rejects(migrateWorkspace(workspace, { revision: plan.revision, execute: true }), { code: 'MIGRATION_REVISION_CONFLICT' });
  assert.deepEqual(await snapshot(workspace, files), conflictBefore);
  const manifest = JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8')); manifest.schemaVersion = 6; await writeFile(join(workspace, 'workspace.json'), JSON.stringify(manifest));
  await assert.rejects(planV7ToV8Migration(workspace), { code: 'MIGRATION_VERSION_UNSUPPORTED' });
});

test('实际迁移必须显式 execute 与预览 revision', async t => {
  const { workspace } = await fixture(t);
  const preview = await migrateWorkspace(workspace);
  assert.equal(preview.preview, true);
  await assert.rejects(migrateWorkspace(workspace, { execute: true }), { code: 'MIGRATION_REVISION_CONFLICT' });
});

test('批量提交在迁移回读失败时回滚全部候选文件', async t => {
  const { workspace, files } = await fixture(t);
  const before = await snapshot(workspace, files);
  const plan = await planV7ToV8Migration(workspace);
  await assert.rejects(commitFiles(workspace, plan.documents, { verify: async () => { throw new Error('模拟回读失败'); } }), { code: 'MIGRATION_WRITE_FAILED' });
  assert.deepEqual(await snapshot(workspace, files), before);
});

test('批量提交混合替换与新建时不把不存在的备份当作失败', async t => {
  const { workspace } = await fixture(t);
  const original = JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8'));
  const replacement = { ...original, name: '提交器混合提交回归' };
  const created = { schemaVersion: 3, kind: 'view', workspaceId: original.id, id: 'created-view', name: '新建视图',
    mechanicRegistrations: [], collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' };
  await commitFiles(workspace, [{ path: 'workspace.json', document: replacement }, { path: 'created.view.json', document: created, create: true }]);
  assert.equal(JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8')).name, replacement.name);
  assert.equal(JSON.parse(await readFile(join(workspace, 'created.view.json'), 'utf8')).id, created.id);
});

test('旧项目迁移只在显式命令中识别旧根、旧技能和旧导出', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-legacy-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyExampleFixture(root);
  const manifestPath = join(root, '.mechanics', 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, agentExportPath: 'game-mechanics' }, null, 2) + '\n');
  await rename(join(root, '.mechanics'), join(root, '.game-graph'));
  for (const name of ['game-mechanic-search', 'game-mechanic-modeling']) {
    const skill = join(root, '.agents', 'skills', name);
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), `# ${name}\n`);
  }
  const exportRoot = join(root, 'game-mechanics');
  await mkdir(exportRoot, { recursive: true });
  await writeFile(join(exportRoot, 'AGENTS.md'), '# Game-Graph Agent 文档使用规则\n<!-- game-graph-agent-docs:v7 workspace-id:sample-card-game -->\n');

  const preview = await migrateLegacyProject(root);
  assert.equal(preview.execute, false);
  assert.equal(preview.removableLegacyCatalog, exportRoot);
  assert.equal(preview.removableLegacySkills.length, 2);

  const result = await migrateLegacyProject(root, { execute: true });
  assert.equal(result.execute, true);
  assert.equal(result.removedLegacyCatalog, exportRoot);
  const migratedManifest = JSON.parse(await readFile(join(root, '.mechanics', 'workspace.json'), 'utf8'));
  assert.equal(migratedManifest.schemaVersion, 14);
  assert.equal(migratedManifest.agentExportPath, 'mechanics');
  await assert.rejects(lstat(join(root, '.game-graph')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(root, '.agents', 'skills', 'game-mechanic-search')), { code: 'ENOENT' });
  await assert.rejects(lstat(exportRoot), { code: 'ENOENT' });
  const guide = await readFile(join(root, 'mechanics', 'AGENTS.md'), 'utf8');
  assert.match(guide, /<!-- mechanics-agent-docs:v8 workspace-id:sample-card-game -->/);
});
