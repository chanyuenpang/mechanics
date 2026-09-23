import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { setSpecializesParent } from '../src/domain/graph.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'mechanics-taxonomy-'));
  await copyExampleFixture(projectRoot);
  const root = join(projectRoot, '.mechanics');
  const store = await createWorkspaceStore(root);
  t.after(async () => { await store.close(); await rm(projectRoot, { recursive: true, force: true }); });
  return { projectRoot, root, store };
}

const withRule = (rules, rule) => ({ ...structuredClone(rules), rules: [...structuredClone(rules.rules), rule] });

test('setSpecializesParent 是单父写入口：替换、幂等、清除，自连显式失败', () => {
  const base = [
    { id: 'a-2-b', source: 'a', target: 'b', relation: 'specializes' },
    { id: 'x-2-y', source: 'x', target: 'y', relation: 'influence', sign: 1, inheritance: { mode: 'none' } },
  ];
  const moved = setSpecializesParent(base, 'a', 'c');
  assert.deepEqual(moved.map(rule => rule.id), ['x-2-y', 'a-2-c']);
  assert.equal(moved[1].relation, 'specializes');
  assert.equal('sign' in moved[1], false);
  assert.equal(base.length, 2, '纯函数不得修改输入');
  assert.deepEqual(setSpecializesParent(base, 'a', 'b'), base, '指定同一父概念应幂等');
  assert.deepEqual(setSpecializesParent(base, 'a', null).map(rule => rule.id), ['x-2-y'], '清除只删该概念的 is-a 出边');
  assert.throws(() => setSpecializesParent(base, 'a', 'a'), { code: 'SPECIALIZES_SELF_LINK' });
  assert.throws(() => setSpecializesParent([{ id: 'a-2-c', source: 'a', target: 'c', relation: 'influence', sign: 1 }], 'a', 'c'),
    { code: 'DUPLICATE_ENDPOINT_RULE' });
});

test('更换父概念在一次提交里写 rules 并清理 pinnedRuleIds，工作区仍可读', async t => {
  const { root, store } = await fixture(t);
  let workspace = await store.read();
  // 造一条被机制图固定引用的 is-a 规则。
  const rules = withRule(workspace.rules, { id: 'damage-2-failure', source: 'damage', target: 'failure', relation: 'specializes' });
  workspace = await store.save({ revision: workspace.revision, kind: 'rules', document: rules });
  const mechanic = workspace.mechanics.find(item => item.id === 'basic-rules');
  const pinned = { ...mechanic, pinnedRuleIds: [...mechanic.pinnedRuleIds, 'damage-2-failure'] };
  workspace = await store.save({ revision: workspace.revision, kind: 'mechanic', id: mechanic.id, document: pinned });
  assert.ok((await store.read()).mechanics.find(item => item.id === mechanic.id).pinnedRuleIds.includes('damage-2-failure'));

  // 把 damage 的父概念从 failure 换成 repel：一次提交同时更新 rules 与引用它的机制图。
  const nextRules = { ...structuredClone(workspace.rules), rules: setSpecializesParent(workspace.rules.rules, 'damage', 'repel') };
  const saved = await store.saveConceptTaxonomy({ revision: workspace.revision, rules: nextRules });
  assert.ok(saved.rules.rules.some(rule => rule.id === 'damage-2-repel'));
  assert.equal(saved.rules.rules.some(rule => rule.id === 'damage-2-failure'), false);
  const reopened = await store.read();
  const reopenedMechanic = reopened.mechanics.find(item => item.id === mechanic.id);
  assert.equal(reopenedMechanic.pinnedRuleIds.includes('damage-2-failure'), false, '被删除的规则必须同事务从 pinnedRuleIds 清理');
  assert.equal(reopenedMechanic.pinnedRuleIds.length, pinned.pinnedRuleIds.length - 1);
  const onDisk = JSON.parse(await readFile(join(root, 'rules.json'), 'utf8'));
  assert.ok(onDisk.rules.some(rule => rule.id === 'damage-2-repel'));
  const onDiskMechanic = JSON.parse(await readFile(join(root, reopened.files.find(file => file.kind === 'mechanic' && file.id === mechanic.id).path), 'utf8'));
  assert.equal(onDiskMechanic.pinnedRuleIds.includes('damage-2-failure'), false);
  assert.ok(saved.revision !== workspace.revision);
});

test('新建概念与 is-a 规则可以同一次提交，非法分类零写入', async t => {
  const { root, store } = await fixture(t);
  const workspace = await store.read();
  const rulesPath = join(root, 'rules.json'), definitionsPath = join(root, workspace.manifest.definitions);
  const rulesBefore = await readFile(rulesPath, 'utf8'), definitionsBefore = await readFile(definitionsPath, 'utf8');
  const added = { id: 'new-concept', label: '新概念', description: '用于验证原子提交。', agentLocked: false };
  const definitions = { ...structuredClone(workspace.definitions), nodes: [...structuredClone(workspace.definitions.nodes), added] };
  const rules = withRule(workspace.rules, { id: 'new-concept-2-repel', source: 'new-concept', target: 'repel', relation: 'specializes' });
  const saved = await store.saveConceptTaxonomy({ revision: workspace.revision, definitions, rules });
  assert.ok(saved.definitions.nodes.some(node => node.id === 'new-concept'));
  assert.ok(saved.rules.rules.some(rule => rule.id === 'new-concept-2-repel'));
  const reopened = await store.read();
  assert.ok(reopened.definitions.nodes.some(node => node.id === 'new-concept'));

  // 四类非法候选：单父、自连、成环、断引用，都必须零写入。
  const cases = [
    ['SPECIALIZES_MULTIPLE_PARENTS', { rules: { ...reopened.rules, rules: [...reopened.rules.rules, { id: 'new-concept-2-enemy', source: 'new-concept', target: 'enemy', relation: 'specializes' }] } }],
    ['SPECIALIZES_SELF_LINK', { rules: { ...reopened.rules, rules: [...reopened.rules.rules, { id: 'repel-2-repel', source: 'repel', target: 'repel', relation: 'specializes' }] } }],
    ['SPECIALIZES_CYCLE', { rules: { ...reopened.rules, rules: [...reopened.rules.rules, { id: 'repel-2-new-concept', source: 'repel', target: 'new-concept', relation: 'specializes' }] } }],
    ['MISSING_REFERENCE', { rules: { ...reopened.rules, rules: [...reopened.rules.rules, { id: 'absent-2-repel', source: 'absent-concept', target: 'repel', relation: 'specializes' }] } }],
  ];
  const revisionBefore = reopened.revision;
  const snapshotBefore = { rules: await readFile(rulesPath, 'utf8'), definitions: await readFile(definitionsPath, 'utf8') };
  for (const [code, body] of cases) {
    await assert.rejects(store.saveConceptTaxonomy({ revision: reopened.revision, ...body }), { code });
    assert.deepEqual({ rules: await readFile(rulesPath, 'utf8'), definitions: await readFile(definitionsPath, 'utf8') }, snapshotBefore, code + ' 失败不得写入任何文件');
  }
  assert.equal((await store.read()).revision, revisionBefore);
  assert.notEqual(snapshotBefore.rules, rulesBefore);
  assert.notEqual(snapshotBefore.definitions, definitionsBefore);
});
