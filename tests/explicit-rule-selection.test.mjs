import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { composeProjection } from '../src/domain/graph.mjs';
import { assertDocument } from '../src/domain/validate.mjs';
import { readWorkspace, workspaceResourceRevisions } from '../src/server/workspace.mjs';
import { catalogSemanticRevision } from '../src/server/catalog.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const sampleRoot = fileURLToPath(new URL('../examples/card-game/.mechanics/', import.meta.url));
const rule = (source, target) => ({ id: `${source}-2-${target}`, source, target, relation: 'influence', sign: 1, inheritance: { mode: 'none' }, ruleText: '测试规则。' });
const mechanism = (id, focusNodeIds, pinnedRuleIds, explicit = false) => ({ schemaVersion: 8, kind: 'mechanic', workspaceId: 'sample-card-game',
  id, name: '隔离测试', scope: '测试', focusNodeIds, pinnedRuleIds, positions: {}, taxonomyPresentation: { mode: 'label', expandedNodeIds: [] }, ...(explicit ? { ruleSelection: 'explicit' } : {}) });
const fixture = () => ({ definitions: { nodes: ['shared', 'benefit', 'private-card', 'other', 'outcome', 'isolated'].map(id => ({ id, label: id, description: '测试概念。', agentLocked: false })) },
  rules: { rules: [rule('shared', 'benefit'), rule('private-card', 'shared'), rule('other', 'outcome')] },
  mechanics: [mechanism('explicit-map', ['shared', 'isolated'], ['shared-2-benefit'], true), mechanism('default-map', ['other'], [])] });

test('显式图显示焦点及固定规则端点，不带入共享节点的私有邻边', () => {
  const workspace = fixture(), before = structuredClone(workspace);
  const graph = composeProjection(workspace, { graphIds: ['explicit-map'] });
  assert.deepEqual(graph.nodes.map(node => node.id).sort(), ['benefit', 'isolated', 'shared']);
  assert.deepEqual(graph.edges.map(edge => edge.id), ['shared-2-benefit']);
  assert.deepEqual(workspace, before, '投影不改写工作区');
  workspace.rules.rules[0].ruleText = '共享规则已更新。';
  assert.equal(composeProjection(workspace, { graphIds: ['explicit-map'] }).edges[0].ruleText, '共享规则已更新。');
});

test('显式图与默认图叠加只合并各自选中的规则，图顺序不扩展显式范围', () => {
  const workspace = fixture();
  for (const graphIds of [['explicit-map', 'default-map'], ['default-map', 'explicit-map']]) {
    const graph = composeProjection(workspace, { graphIds });
    assert.deepEqual(graph.edges.map(edge => edge.id), ['other-2-outcome', 'shared-2-benefit']);
    assert.equal(graph.nodes.some(node => node.id === 'private-card'), false);
  }
  delete workspace.mechanics[0].ruleSelection;
  assert.equal(composeProjection(workspace, { graphIds: ['explicit-map'] }).edges.some(edge => edge.id === 'private-card-2-shared'), true, '旧图继续邻接展开');
});

test('视图直接引用仍可明确扩展共享节点，不改变机制单图', () => {
  const workspace = fixture();
  assert.equal(composeProjection(workspace, { graphIds: ['explicit-map'], focusNodeIds: ['shared'] }).edges.length, 2);
  assert.equal(composeProjection(workspace, { graphIds: ['explicit-map'] }).edges.length, 1);
});

test('规则选择模式进入机制与文档语义版本，布局不改变版本', async () => {
  const workspace = await readWorkspace(sampleRoot), target = workspace.mechanics[0];
  const before = workspaceResourceRevisions(workspace), catalogBefore = catalogSemanticRevision(workspace);
  target.ruleSelection = 'explicit';
  const after = workspaceResourceRevisions(workspace), catalogAfter = catalogSemanticRevision(workspace);
  assert.notEqual(after.mechanics[target.id], before.mechanics[target.id]);
  assert.notEqual(catalogAfter, catalogBefore);
  assert.equal(after.rules, before.rules);
  target.positions[target.focusNodeIds[0]] = { x: 333, y: 222 };
  assert.deepEqual(workspaceResourceRevisions(workspace), after);
  assert.equal(catalogSemanticRevision(workspace), catalogAfter);
});

test('非法模式在 Schema 和领域入口显式失败', () => {
  const workspace = fixture();
  assert.doesNotThrow(() => assertDocument(workspace.mechanics[0], 'mechanic'));
  for (const value of ['all', '', null, false]) {
    workspace.mechanics[0].ruleSelection = value;
    assert.throws(() => assertDocument(workspace.mechanics[0], 'mechanic'), { code: 'INVALID_DOCUMENT' });
    assert.throws(() => composeProjection(workspace, { graphIds: ['explicit-map'] }), { code: 'RULE_SELECTION_INVALID' });
  }
});

async function temporaryWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-explicit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyExampleFixture(root);
  return root;
}

test('真实工作区读取保留显式模式，非法值不会被兼容读取抹去', async t => {
  const root = await temporaryWorkspace(t), workspaceRoot = join(root, '.mechanics');
  const path = join(workspaceRoot, 'mechanics/basic-rules.mechanic.json');
  const document = JSON.parse(await readFile(path, 'utf8'));
  document.ruleSelection = 'explicit';
  await writeFile(path, JSON.stringify(document));
  assert.equal((await readWorkspace(workspaceRoot)).mechanics.find(item => item.id === document.id).ruleSelection, 'explicit');
  document.ruleSelection = 'invalid';
  await writeFile(path, JSON.stringify(document));
  await assert.rejects(readWorkspace(workspaceRoot), /ruleSelection/);
});

test('JSON 草稿校验、保存、回读显式模式，仅保留有效节点位置，失败不写 canonical', async t => {
  const root = await temporaryWorkspace(t), workspaceRoot = join(root, '.mechanics');
  const tool = join(workspaceRoot, 'tools/workspace-tool.mjs');
  await mkdir(join(workspaceRoot, 'tools'), { recursive: true });
  await copyFile(new URL('../workspace-tools/workspace-tool.mjs', import.meta.url), tool);
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const path = join(workspaceRoot, 'mechanics/basic-rules.mechanic.json');
  const document = JSON.parse(await readFile(path, 'utf8'));
  document.positions = { damage: { x: 0, y: 0 }, health: { x: 240, y: 0 }, melee: { x: -240, y: 0 } };
  await writeFile(path, JSON.stringify(document));
  const draft = run('draft', 'open', '--mechanic', 'basic-rules');
  const edited = JSON.parse(await readFile(draft.mechanicPath, 'utf8'));
  edited.focusNodeIds = ['damage']; edited.pinnedRuleIds = ['damage-2-health']; edited.ruleSelection = 'invalid';
  await writeFile(draft.mechanicPath, JSON.stringify(edited));
  const original = await readFile(path, 'utf8');
  assert.throws(() => run('draft', 'validate', '--draft', draft.draftId), error => /DRAFT_VALIDATION_FAILED/.test(error.stderr));
  assert.throws(() => run('draft', 'save', '--draft', draft.draftId), error => /DRAFT_VALIDATION_FAILED/.test(error.stderr));
  assert.equal(await readFile(path, 'utf8'), original);
  edited.ruleSelection = 'explicit';
  await writeFile(draft.mechanicPath, JSON.stringify(edited));
  assert.equal(run('draft', 'validate', '--draft', draft.draftId).valid, true);
  assert.equal(run('draft', 'save', '--draft', draft.draftId).saved, true);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.ruleSelection, 'explicit');
  assert.deepEqual(Object.keys(saved.positions).sort(), ['damage', 'health']);
  const projected = composeProjection(await readWorkspace(workspaceRoot), { graphIds: ['basic-rules'] });
  assert.deepEqual(projected.edges.map(edge => edge.id), ['damage-2-health']);
});
