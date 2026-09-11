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

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-v7-'));
  await copyExampleFixture(root);
  const workspace = join(root, '.mechanics');
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ['workspace.json', 'definitions.graph.json', 'mechanics/basic-rules.mechanic.json', 'mechanics/encounter.mechanic.json', 'mechanics/hand.mechanic.json'];
  for (const file of files) {
    const path = join(workspace, file), document = JSON.parse(await readFile(path, 'utf8'));
    if (document.kind === 'workspace') document.schemaVersion = 7;
    if (document.kind === 'definitions') document.schemaVersion = 3;
    if (document.kind === 'mechanic') { document.schemaVersion = 3; for (const edge of document.edges) delete edge.inheritance; }
    await writeFile(path, JSON.stringify(document, null, 2) + '\n');
  }
  const viewFile = 'migration.view.json';
  await writeFile(join(workspace, viewFile), JSON.stringify({
    schemaVersion: 2, kind: 'view', workspaceId: 'sample-card-game', id: 'migration-view', name: '迁移视图',
    mechanicRegistrations: [{ mechanicId: 'basic-rules', visible: true }], collapsedNodeIds: [], positions: {},
  }, null, 2) + '\n');
  files.push(viewFile);
  return { root, workspace, files };
}
async function snapshot(root, files) { return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(root, file), 'utf8')]))); }

test('逐版本迁移必须显式提交：关系改名、限定词收回端点且不生成派生', async t => {
  const { workspace, files } = await fixture(t);
  const legacyPath = join(workspace, 'mechanics', 'hand.mechanic.json');
  const legacy = JSON.parse(await readFile(legacyPath, 'utf8')); legacy.edges[0].relation = 'belongsTo'; delete legacy.edges[0].sign; await writeFile(legacyPath, JSON.stringify(legacy));
  await assert.rejects(readWorkspace(workspace), { code: 'WORKSPACE_VERSION_UNSUPPORTED' });
  const plan = await planV7ToV8Migration(workspace);
  assert.equal(plan.from, 7); assert.equal(plan.to, 8); assert.equal(plan.summary.derivedRulesCreated, 0);
  const migratedViewPlan = plan.documents.find(item => item.document.kind === 'view').document;
  assert.equal(migratedViewPlan.schemaVersion, 3);
  assert.equal(migratedViewPlan.structuralPresentation, 'line');
  const outcome = await migrateWorkspace(workspace, { revision: plan.revision, execute: true });
  assert.equal(outcome.migrated, true); assert.equal(outcome.derivedRulesCreated, 0); assert.equal(outcome.renamedRelations, 1);
  await assert.rejects(readWorkspace(workspace), { code: 'WORKSPACE_VERSION_UNSUPPORTED' });
  const v8ToV9 = await migrateWorkspace(workspace, { from: 8, to: 9 });
  assert.equal(v8ToV9.preview, true);
  await migrateWorkspace(workspace, { from: 8, to: 9, revision: v8ToV9.revision, execute: true });
  const v9ToV10 = await migrateWorkspace(workspace, { from: 9, to: 10 });
  assert.equal(v9ToV10.preview, true);
  await migrateWorkspace(workspace, { from: 9, to: 10, revision: v9ToV10.revision, execute: true });
  const migrated = await readWorkspace(workspace);
  assert.equal(migrated.manifest.schemaVersion, 10);
  assert.equal(migrated.definitions.schemaVersion, 5);
  assert.ok(migrated.mechanics.every(item => item.schemaVersion === 6));
  assert.ok(migrated.views.every(item => item.schemaVersion === 3 && item.structuralPresentation === 'line'));
  assert.ok(migrated.mechanics.flatMap(item => item.edges).filter(item => item.relation === 'influence').every(item => item.inheritance.mode === 'none'));
  assert.equal(migrated.mechanics.find(item => item.id === 'hand').edges[0].relation, 'specializes');
  assert.equal(files.length, 6);
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
  assert.equal(migratedManifest.schemaVersion, 10);
  assert.equal(migratedManifest.agentExportPath, 'mechanics');
  await assert.rejects(lstat(join(root, '.game-graph')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(root, '.agents', 'skills', 'game-mechanic-search')), { code: 'ENOENT' });
  await assert.rejects(lstat(exportRoot), { code: 'ENOENT' });
  const guide = await readFile(join(root, 'mechanics', 'AGENTS.md'), 'utf8');
  assert.match(guide, /<!-- mechanics-agent-docs:v8 workspace-id:sample-card-game -->/);
});
