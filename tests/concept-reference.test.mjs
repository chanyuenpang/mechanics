import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { matchingConcepts, sameNamedConcepts, prepareReference, ReferenceCommit, prepareConceptUpdate } from '../src/web/glossary.mjs';
import { graphPositions } from '../src/web/view-files.mjs';
import { copyExampleFixture } from './example-fixture.mjs';
import { compose, downstreamNodes } from '../src/domain/graph.mjs';

const node = (id = 'aaa-new', label = '新概念') => ({
  id, label, description: '新概念的定义', agentLocked: false,
});

test('追踪候选仅包含当前图的直接与间接下游；环、自身、上游和无关联节点不会混入', () => {
  const graph = { nodes: ['up', 'a', 'b', 'c', 'other'].map(id => ({ id })), edges: [
    { source: 'up', target: 'a' }, { source: 'a', target: 'b', relation: 'influence', sign: 1, inheritance: { mode: 'none' } },
    { source: 'b', target: 'c', relation: 'influence', sign: 1, inheritance: { mode: 'none' } }, { source: 'c', target: 'a', relation: 'influence', sign: 1, inheritance: { mode: 'none' } },
  ] };
  assert.deepEqual(downstreamNodes(graph, 'a').map(item => item.id), ['b', 'c']);
  assert.deepEqual(downstreamNodes(graph, 'other'), []);
});

test('修改概念只保存指定定义文案，稳定ID、布局、其余定义和机制文件不变', async t => {
  const { root, workspace, store } = await fixture(t), original = structuredClone(workspace.definitions);
  original.tagDefinitions = [
    { id: '战斗', displayName: '战斗', color: '#6B7280' },
    { id: '核心', displayName: '核心', color: '#6B7280' },
  ];
  workspace.definitions.tagDefinitions = structuredClone(original.tagDefinitions);
  const target = original.nodes[0], files = ['workspace.json', ...workspace.files.filter(item => item.kind === 'mechanic').map(item => item.path)];
  const before = await Promise.all(files.map(file => readFile(join(root, file), 'utf8')));
  const next = prepareConceptUpdate(original, target.id, {
    id: 'cannot-change', label: '修改后名称', description: '修改后含义',
    aliases: '修改别名', tagIds: '战斗, 核心', agentLocked: true,
  });
  assert.deepEqual(workspace.definitions, original);
  assert.equal(next.nodes[0].id, target.id); assert.deepEqual(next.positions, original.positions);
  assert.equal(next.nodes[0].agentLocked, true);
  assert.deepEqual(next.nodes[0].tagIds, ['战斗', '核心']);
  assert.deepEqual(next.nodes.slice(1), original.nodes.slice(1));
  await store.save({ revision: workspace.revision, kind: 'definitions', document: next });
  assert.equal((await store.read()).definitions.nodes[0].label, '修改后名称');
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(root, file), 'utf8'))), before);
  assert.throws(() => prepareConceptUpdate(original, target.id, { ...target, label: ' ' }), /名称必填/);
});
async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rule-reference-'));
  await copyExampleFixture(projectRoot);
  const root = join(projectRoot, '.mechanics');
  const store = await createWorkspaceStore(root);
  t.after(async () => { await store.close(); await rm(projectRoot, { recursive: true, force: true }); });
  const workspace = await store.read(), draft = structuredClone(workspace.mechanics[0]); draft.scope = '已有未保存机制草稿';
  const positions = graphPositions(workspace, compose(workspace, [draft.id]), {}, draft.id);
  const prepare = (candidates = [node()]) => prepareReference({ workspace, draft, selected: candidates.map(item => item.id), candidates, positions, center: { x: 400, y: 300 } });
  return { root, store, workspace, draft, positions, prepare };
}
test('创建并引用只保存共享定义；机制草稿保留，所有候选一次引用且不写机制或配置', async t => {
  const { root, store, workspace, draft, prepare } = await fixture(t);
  const paths = ['workspace.json', ...workspace.files.filter(file => file.kind === 'mechanic').map(file => file.path)];
  const before = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')));
  const original = structuredClone(draft), plan = prepare([node(), node('bbb-new', '第二概念')]);
  let saves = 0, edits = 0, applied;
  const commit = new ReferenceCommit(plan);
  await commit.run(async document => { saves++; await store.save({ revision: workspace.revision, kind: 'definitions', document }); }, next => { edits++; applied = next; return true; });
  assert.equal(saves, 1); assert.equal(edits, 1); assert.deepEqual(draft, original);
  assert.equal(applied.scope, draft.scope); assert.deepEqual(applied.focusNodeIds.slice(-2), ['aaa-new', 'bbb-new']);
  const latest = await store.read(); assert.ok(latest.definitions.nodes.some(item => item.id === 'aaa-new'));
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(root, path), 'utf8'))), before);
  await assert.rejects(commit.run(() => { saves++; }, () => true)); assert.equal(saves, 1);
});
test('仅引用已有概念不写定义；同名不同 ID 可并存，名称/含义/标签/ID 检索不过滤已引用项', async t => {
  const { workspace, draft, positions } = await fixture(t);
  const existing = workspace.definitions.nodes.find(item => !draft.focusNodeIds.includes(item.id));
  const plan = prepareReference({ workspace, draft, selected: [existing.id, existing.id], candidates: [], positions, center: { x: 0, y: 0 } });
  await new ReferenceCommit(plan).run(() => assert.fail('不应写定义'), next => { assert.equal(next.focusNodeIds.filter(id => id === existing.id).length, 1); return true; });
  const a = { ...node('name-a', '概念'), tagIds: ['资源'] }, b = node('name-b', ' 概念 ');
  assert.equal(sameNamedConcepts([a, b], '概念').length, 2);
  assert.deepEqual(matchingConcepts([a, b], 'name-a 定义'), [a]);
  assert.deepEqual(matchingConcepts([a, b], '资源'), [a]);
  assert.ok(matchingConcepts(workspace.definitions.nodes, draft.focusNodeIds[0]).some(item => item.id === draft.focusNodeIds[0]));
});

test('网页概念搜索与编辑保留自然语言别名', async t => {
  const { workspace } = await fixture(t), id = workspace.definitions.nodes[0].id;
  workspace.definitions.tagDefinitions = [
    { id: '战斗', displayName: '战斗', color: '#6B7280' },
    { id: '资源', displayName: '资源', color: '#6B7280' },
  ];
  const original = workspace.definitions.nodes.find(node => node.id === id);
  const next = prepareConceptUpdate(workspace.definitions, id, {
    label: original.label, description: original.description, agentLocked: original.agentLocked,
    aliases: '抽卡, draw card\n摸牌',
    tagIds: '战斗, 资源',
  });
  assert.deepEqual(next.nodes.find(node => node.id === id).aliases, ['抽卡', 'draw card', '摸牌']);
  assert.deepEqual(next.nodes.find(node => node.id === id).tagIds, ['战斗', '资源']);
  assert.ok(matchingConcepts(next.nodes, 'DRAW CARD').some(node => node.id === id));
});
test('缺必填项、重复 ID、未知引用在保存前拒绝', async t => {
  const { workspace, draft, positions, prepare } = await fixture(t);
  assert.throws(() => prepare([{ ...node(), description: ' ' }]), /概念含义必填/);
  assert.throws(() => prepare([{ ...node(), agentLocked: undefined }]), /必须明确 agentLocked/);
  assert.throws(() => prepare([node(workspace.definitions.nodes[0].id)]), /ID 已存在/);
  assert.throws(() => prepareReference({ workspace, draft, selected: ['missing'], candidates: [], positions, center: { x: 0, y: 0 } }));
});
test('已保存未引用可继续引用，不重复保存或重新生成概念', async t => {
  const { store, workspace, prepare } = await fixture(t); const commit = new ReferenceCommit(prepare()); let saves = 0;
  const save = async document => { saves++; await store.save({ revision: workspace.revision, kind: 'definitions', document }); };
  await assert.rejects(commit.run(save, () => false), /概念已保存，但尚未加入/);
  assert.equal(commit.phase, 'apply-failed');
  await commit.run(save, () => true); assert.equal(saves, 1); assert.equal(commit.phase, 'done');
});
test('写入响应丢失时暂停；显式核实已经保存后只继续引用', async t => {
  const { store, workspace, prepare } = await fixture(t); const commit = new ReferenceCommit(prepare()); let saves = 0;
  await assert.rejects(commit.run(async document => {
    saves++; await store.save({ revision: workspace.revision, kind: 'definitions', document });
    throw Object.assign(new Error('响应丢失'), { code: 'SAVE_UNCERTAIN' });
  }, () => assert.fail('尚未确认不能应用')));
  assert.equal(commit.phase, 'uncertain'); await assert.rejects(commit.run(() => saves++, () => true), /先重新读取/);
  assert.equal(commit.reconcile(await store.read()), true);
  await commit.run(() => saves++, () => true); assert.equal(saves, 1);
});
test('revision 冲突保留原草稿；明确核实后合并最新定义，不覆盖外部新增', async t => {
  const { store, workspace, prepare, draft } = await fixture(t); const commit = new ReferenceCommit(prepare());
  const definitions = structuredClone(workspace.definitions); definitions.nodes.push(node('external', '外部概念'));
  const latest = await store.save({ revision: workspace.revision, kind: 'definitions', document: definitions });
  await assert.rejects(commit.run(document => store.save({ revision: workspace.revision, kind: 'definitions', document }), () => true), { code: 'REVISION_CONFLICT' });
  assert.equal(commit.reconcile(latest), false);
  await commit.run(document => store.save({ revision: latest.revision, kind: 'definitions', document }), next => { assert.equal(next.scope, draft.scope); return true; });
  assert.ok((await store.read()).definitions.nodes.some(item => item.id === 'external'));
});
test('核实时发现源机制变动或候选 ID 被改写会明确拒绝，不把新版本当成合并', async t => {
  const { root, store, prepare, workspace } = await fixture(t); const commit = new ReferenceCommit(prepare());
  await assert.rejects(commit.run(() => Promise.reject(new Error('保存失败')), () => true));
  const changed = structuredClone(workspace); changed.mechanics[0].scope = '外部修改';
  assert.throws(() => commit.reconcile(changed), /当前机制已改变/);
  const definitions = structuredClone(workspace.definitions); definitions.nodes.push(node('aaa-new', '不同内容'));
  await writeFile(join(root, workspace.manifest.definitions), JSON.stringify(definitions));
  const latest = await readWorkspace(root, { verifyGeneratedCatalog: false });
  assert.throws(() => commit.reconcile(latest), /不完整或不一致/);
  assert.equal(commit.blocked, true);
});
test('新节点不重叠；定义排序变化与撤销引用不移动已显示的隐式位置', async t => {
  const { workspace, draft, positions, prepare } = await fixture(t); const plan = prepare([node(), node('aaa-another')]);
  const placed = plan.additions.map(id => plan.mechanic.positions[id]); assert.notDeepEqual(placed[0], placed[1]);
  for (const p of placed) for (const q of Object.values(positions)) assert.ok(p.x >= q.x + 166 || p.x + 166 <= q.x || p.y >= q.y + 62 || p.y + 62 <= q.y);
  const next = { ...workspace, definitions: plan.definitions };
  assert.deepEqual(graphPositions(next, compose(next, [draft.id]), {}, draft.id, positions), positions);
});
