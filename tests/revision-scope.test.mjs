import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { startServer } from '../src/server/http.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rule-revision-scope-'));
  await copyExampleFixture(projectRoot);
  const directory = join(projectRoot, '.mechanics');
  const store = await createWorkspaceStore(directory);
  t.after(async () => { await store.close(); await rm(projectRoot, { recursive: true, force: true }); });
  return { directory, store, workspace: await store.read() };
}
const mechanicAt = (workspace, index = 0) => workspace.mechanics[index];
const pathOf = (workspace, kind, id) => workspace.files.find(file => file.kind === kind && file.id === id).path;

test('冲突判定只看本次写入的资源：别的页面写别的文件不再拒绝本次保存', async t => {
  const { store, workspace } = await fixture(t);
  const target = mechanicAt(workspace, 1), other = workspace.definitions;
  // 页面 B 读到的整体版本与每资源版本。
  const baseline = workspace.resourceRevisions;
  const document = structuredClone(target);
  // 页面 A 语义修改概念定义（不是本页面要写的文件）。
  const editedDefinitions = structuredClone(other);
  editedDefinitions.nodes[0].label = '页面 A 改过的显示名称';
  const moved = await store.save({ revision: workspace.revision, resourceRevisions: baseline, kind: 'definitions', document: editedDefinitions });
  assert.notEqual(moved.revision, workspace.revision);
  // 页面 B 仍拿着旧整体版本，但它要写的机制图没有变：保存必须成功。
  const saved = await store.save({ revision: workspace.revision, resourceRevisions: baseline, kind: 'mechanic', id: document.id, document });
  assert.equal(saved.resourceRevisions.mechanics[document.id], moved.resourceRevisions.mechanics[document.id]);
  assert.deepEqual(JSON.parse(await readFile(join((await store.read()).workspaceRoot, pathOf(workspace, 'mechanic', document.id)), 'utf8')), document);
});

test('缺少每资源基线时退回整体比较，不放宽为无条件写入', async t => {
  const { store, workspace } = await fixture(t);
  const document = structuredClone(workspace.definitions);
  document.nodes[0].label = '外部修改';
  await store.save({ revision: workspace.revision, kind: 'definitions', document });
  // 没有每资源基线就无法证明目标资源未变：整体比较必须照旧拒绝，并且不谎报具体文件。
  await assert.rejects(store.save({ revision: workspace.revision, kind: 'mechanic', id: mechanicAt(workspace).id, document: mechanicAt(workspace) }),
    error => error.code === 'REVISION_CONFLICT' && !error.message.includes('本次写入涉及的文件'));
});

test('布局与连线路径不移动语义版本，打开图补算不会作废其他页面与草稿', async t => {
  const { store, workspace } = await fixture(t);
  const document = structuredClone(mechanicAt(workspace));
  const baseline = workspace.resourceRevisions;
  document.positions.draw = { x: 4096, y: 4096 };
  delete document.routeCache;
  const saved = await store.save({ revision: workspace.revision, resourceRevisions: baseline, kind: 'mechanic', id: document.id, document });
  assert.equal(saved.revision, workspace.revision);
  assert.deepEqual(saved.resourceRevisions, baseline);
  // 补算后的文件仍然真实落盘。
  assert.deepEqual(JSON.parse(await readFile(join(saved.workspaceRoot, pathOf(workspace, 'mechanic', document.id)), 'utf8')).positions.draw, { x: 4096, y: 4096 });
});

test('同一资源的语义变化仍然拒绝，并指出具体文件', async t => {
  const { store, workspace } = await fixture(t);
  const target = mechanicAt(workspace, 0), baseline = workspace.resourceRevisions;
  const renamed = structuredClone(target); renamed.name = '其他页面改过的名字';
  await store.save({ revision: workspace.revision, resourceRevisions: baseline, kind: 'mechanic', id: renamed.id, document: renamed });
  const stale = structuredClone(target); stale.scope = '过期草稿的范围';
  await assert.rejects(store.save({ revision: workspace.revision, resourceRevisions: baseline, kind: 'mechanic', id: stale.id, document: stale }),
    error => error.code === 'REVISION_CONFLICT'
      && error.message.includes(pathOf(workspace, 'mechanic', target.id)));
  assert.equal(JSON.parse(await readFile(join((await store.read()).workspaceRoot, pathOf(workspace, 'mechanic', target.id)), 'utf8')).name, '其他页面改过的名字');
});

test('视图写入同样按自身资源判定，其他资源变化不再阻塞', async t => {
  const { store, workspace } = await fixture(t);
  const view = { schemaVersion: 4, kind: 'view', workspaceId: workspace.manifest.id, id: 'scope-view', name: '范围视图',
    mechanicRegistrations: [{ mechanicId: mechanicAt(workspace).id, visible: true }], focusNodeIds: [], pinnedRuleIds: [],
    collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' };
  const created = await store.createView({ revision: workspace.revision, document: view, file: 'scope-view.view.json' });
  const baseline = created.resourceRevisions, document = structuredClone(view);
  // 别的页面改写规则库。
  const rules = structuredClone(created.rules); rules.rules[0].ruleText = '其他页面改写的规则文字';
  await store.save({ revision: created.revision, resourceRevisions: baseline, kind: 'rules', document: rules });
  // 视图自身没变：旧整体版本仍然可以保存这份视图。
  const saved = await store.save({ revision: created.revision, resourceRevisions: baseline, kind: 'view', id: document.id, document });
  assert.equal(saved.resourceRevisions.views[document.id], baseline.views[document.id]);
  // 同一视图被改名后，旧视图草稿必须拒绝。
  const renamed = structuredClone(document); renamed.name = '其他页面改过的视图名';
  await store.save({ revision: saved.revision, resourceRevisions: saved.resourceRevisions, kind: 'view', id: renamed.id, document: renamed });
  await assert.rejects(store.save({ revision: saved.revision, resourceRevisions: saved.resourceRevisions, kind: 'view', id: document.id, document }),
    { code: 'REVISION_CONFLICT' });
});

test('Agent 草稿只按自己写的三份文件判定：无关资源变化不作废草稿', async t => {
  const { store, workspace } = await fixture(t);
  const record = { mechanic: mechanicAt(workspace, 0).id, workspaceRevision: workspace.revision,
    definitionsRevision: workspace.resourceRevisions.definitions, rulesRevision: workspace.resourceRevisions.rules,
    mechanicRevision: workspace.resourceRevisions.mechanics[mechanicAt(workspace, 0).id],
    definitions: structuredClone(workspace.definitions), rules: structuredClone(workspace.rules),
    document: structuredClone(mechanicAt(workspace, 0)) };
  // 打开草稿之后，另外一张机制图被其他写入者语义修改。
  const other = structuredClone(mechanicAt(workspace, 1)); other.name = '其他页面改过的机制名';
  await store.save({ revision: workspace.revision, resourceRevisions: workspace.resourceRevisions, kind: 'mechanic', id: other.id, document: other });
  const saved = await store.saveAgentDraft(record);
  assert.equal(saved.canonicalCommitted, true);
  assert.equal(saved.mechanic, record.mechanic);
  // 目标机制自身被语义修改后，旧草稿必须拒绝。
  const current = await store.read();
  const stale = { ...record, workspaceRevision: current.revision,
    definitionsRevision: current.resourceRevisions.definitions, rulesRevision: current.resourceRevisions.rules,
    mechanicRevision: current.resourceRevisions.mechanics[record.mechanic],
    definitions: structuredClone(current.definitions), rules: structuredClone(current.rules), document: structuredClone(current.mechanics.find(item => item.id === record.mechanic)) };
  const movedTarget = structuredClone(current.mechanics.find(item => item.id === record.mechanic)); movedTarget.scope = '其他页面改过的范围';
  await store.save({ revision: current.revision, resourceRevisions: current.resourceRevisions, kind: 'mechanic', id: movedTarget.id, document: movedTarget });
  await assert.rejects(store.saveAgentDraft(stale), { code: 'REVISION_CONFLICT' });
});

test('结构写入仍然要求整体版本：新建、移动与删除不做按资源放宽', async t => {
  const { store, workspace } = await fixture(t);
  const baseline = workspace.resourceRevisions;
  const other = structuredClone(workspace.definitions); other.nodes[0].label = '别的页面改过';
  await store.save({ revision: workspace.revision, resourceRevisions: baseline, kind: 'definitions', document: other });
  const document = { schemaVersion: 7, kind: 'mechanic', workspaceId: workspace.manifest.id, id: 'scope-structure', name: '结构写入', scope: '抽象规则', focusNodeIds: [], pinnedRuleIds: [], positions: {} };
  await assert.rejects(store.createMechanic({ revision: workspace.revision, resourceRevisions: baseline, document, file: 'mechanics/scope-structure.mechanic.json' }),
    { code: 'REVISION_CONFLICT' });
});
test('HTTP 写入带每资源基线时不再因其他文件变化被拒绝，缺少基线仍然拒绝', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rule-revision-http-'));
  await copyExampleFixture(projectRoot);
  const directory = join(projectRoot, '.mechanics');
  const { close, origin } = await startServer({ projectRoot, port: 0, projectHistoryPath: join(projectRoot, '.test-projects.json') });
  t.after(async () => { await close(); await rm(projectRoot, { recursive: true, force: true }); });
  const headers = { Origin: 'https://other.example', 'Content-Type': 'application/json' };
  const post = body => fetch(origin + '/api/save', { method: 'POST', headers, body: JSON.stringify({ projectGeneration: 1, ...body }) });
  const workspace = await readWorkspace(directory), baseline = workspace.resourceRevisions;
  // 页面 A 改概念定义。
  const definitions = structuredClone(workspace.definitions); definitions.nodes[0].label = '页面 A 修改';
  const first = await post({ revision: workspace.revision, resourceRevisions: baseline, kind: 'definitions', document: definitions });
  assert.equal(first.status, 200);
  // 页面 B 拿着旧整体版本保存自己的机制图：目标资源未变，必须成功。
  const mechanic = structuredClone(mechanicAt(workspace)); mechanic.name = '页面 B 重命名';
  const accepted = await post({ revision: workspace.revision, resourceRevisions: baseline, kind: 'mechanic', id: mechanic.id, document: mechanic });
  assert.equal(accepted.status, 200);
  // 同一份过期版本但不带基线：退回整体比较，必须 409 且不覆盖磁盘。
  const rejected = await post({ revision: workspace.revision, kind: 'mechanic', id: mechanic.id, document: mechanic });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error, 'REVISION_CONFLICT');
  assert.equal((await readWorkspace(directory)).mechanics.find(item => item.id === mechanic.id).name, '页面 B 重命名');
});
