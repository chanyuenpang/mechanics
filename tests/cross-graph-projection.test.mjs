import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkspace } from '../src/server/workspace.mjs';
import { composeProjection } from '../src/domain/graph.mjs';
import { composeView } from '../src/domain/view.mjs';
import { validateWorkspace } from '../src/domain/validate.mjs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyExampleFixture } from './example-fixture.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { migrateWorkspace } from '../src/server/store.mjs';

const sampleRoot = fileURLToPath(new URL('../examples/card-game/.mechanics/', import.meta.url));

test('全局规则按机制或视图显式引用做一跳投影，不复制规则', async () => {
  const workspace = await readWorkspace(sampleRoot);
  const graph = composeProjection(workspace, { graphIds: ['encounter'] });
  assert.equal(graph.edges.length, workspace.rules.rules.filter(rule => workspace.mechanics.find(item => item.id === 'encounter').focusNodeIds.includes(rule.source)
    || workspace.mechanics.find(item => item.id === 'encounter').focusNodeIds.includes(rule.target)).length);
  const view = { schemaVersion: 4, kind: 'view', workspaceId: workspace.manifest.id, id: 'damage-view', name: '伤害视图',
    mechanicRegistrations: [], focusNodeIds: ['damage'], pinnedRuleIds: [], collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' };
  const direct = composeView(workspace, view);
  assert.deepEqual(direct.nodes.map(node => node.id).sort(), ['damage', 'health', 'melee']);
  assert.deepEqual(direct.edges.map(edge => edge.id).sort(), ['damage-2-health', 'melee-2-damage']);
});

test('视图只能引用已有概念和已有规则', async () => {
  const workspace = await readWorkspace(sampleRoot);
  const invalid = structuredClone(workspace);
  invalid.views.push({ schemaVersion: 4, kind: 'view', workspaceId: invalid.manifest.id, id: 'invalid-view', name: '非法',
    mechanicRegistrations: [], focusNodeIds: ['missing-concept'], pinnedRuleIds: [], collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' });
  assert.throws(() => validateWorkspace(invalid), { code: 'MISSING_REFERENCE' });
});

test('删除全局规则会原子清理所有机制图与视图的固定引用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-v11-delete-'));
  await copyExampleFixture(root);
  const store = await createWorkspaceStore(join(root, '.mechanics'));
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const before = await store.read();
  const ruleId = before.rules.rules[0].id;
  const view = { schemaVersion: 4, kind: 'view', workspaceId: before.manifest.id, id: 'pinned-rule-view', name: '固定规则',
    mechanicRegistrations: [], focusNodeIds: [], pinnedRuleIds: [ruleId], collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' };
  const created = await store.createView({ revision: before.revision, document: view, file: 'pinned-rule-view.view.json' });
  const removed = await store.deleteGlobalRule({ revision: created.revision, ruleId });
  assert.equal(removed.rules.rules.some(rule => rule.id === ruleId), false);
  assert.equal(removed.mechanics.some(mechanic => mechanic.pinnedRuleIds.includes(ruleId)), false);
  assert.equal(removed.views.some(item => item.pinnedRuleIds.includes(ruleId)), false);
});

test('v10 只可经显式迁移进入全局 rules.json，失败预览不会写入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-v10-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyExampleFixture(root);
  const workspaceRoot = join(root, '.mechanics');
  const sourceWorkspace = await readWorkspace(workspaceRoot);
  const manifestPath = join(workspaceRoot, 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const rules = JSON.parse(await readFile(join(workspaceRoot, 'rules.json'), 'utf8'));
  await rename(join(workspaceRoot, 'definitions.json'), join(workspaceRoot, 'definitions.graph.json'));
  const definitionsPath = join(workspaceRoot, 'definitions.graph.json');
  const definitions = JSON.parse(await readFile(definitionsPath, 'utf8'));
  definitions.schemaVersion = 5; await writeFile(definitionsPath, JSON.stringify(definitions, null, 2) + '\n');
  for (const mechanic of sourceWorkspace.mechanics) {
    const path = join(workspaceRoot, 'mechanics', mechanic.id + '.mechanic.json');
    const old = { ...mechanic, schemaVersion: 6, nodeIds: mechanic.focusNodeIds, edges: rules.rules.filter(rule => mechanic.pinnedRuleIds.includes(rule.id)) };
    delete old.focusNodeIds; delete old.pinnedRuleIds;
    await writeFile(path, JSON.stringify(old, null, 2) + '\n');
  }
  const v10 = { ...manifest, schemaVersion: 10, definitions: 'definitions.graph.json' };
  delete v10.rules; await writeFile(manifestPath, JSON.stringify(v10, null, 2) + '\n');
  await unlink(join(workspaceRoot, 'rules.json'));
  const preview = await migrateWorkspace(workspaceRoot, { from: 10, to: 11 });
  assert.equal(preview.preview, true);
  assert.equal(preview.rules, rules.rules.length);
  await assert.rejects(readWorkspace(workspaceRoot), { code: 'WORKSPACE_VERSION_UNSUPPORTED' });
  const executed = await migrateWorkspace(workspaceRoot, { from: 10, to: 11, revision: preview.revision, execute: true });
  assert.equal(executed.migrated, true);
  const migrated = await readWorkspace(workspaceRoot);
  assert.equal(migrated.manifest.schemaVersion, 11);
  assert.equal(migrated.rules.rules.length, rules.rules.length);
});
