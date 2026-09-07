import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readWorkspace } from '../src/server/workspace.mjs';
import { publishCatalog } from '../src/server/catalog.mjs';
import { startServer } from '../src/server/http.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/server/cli.mjs', import.meta.url));
const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'game-graph-agent-mutation-'));
  await copyExampleFixture(projectRoot);
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  return { projectRoot, root: join(projectRoot, '.game-graph') };
}

const call = (args, env = process.env) => exec(process.execPath, [cli, 'agent', ...args], { env, timeout: 15000 });
const offline = (projectRoot, args) => call([...args, '--project', projectRoot]);
const json = result => JSON.parse(result.stdout);
const failure = async operation => {
  try { await operation; }
  catch (error) { return { processError: error, body: JSON.parse(error.stderr) }; }
  assert.fail('预期命令失败');
};
const definitionsRevision = workspace => workspace.resourceRevisions.definitions;
const mechanicRevision = (workspace, id) => workspace.resourceRevisions.mechanics[id];

test('工作区暴露定义与逐机制 resource revision，Agent mutation 不复用全局 revision', async t => {
  const { root } = await fixture(t), workspace = await readWorkspace(root);
  assert.match(definitionsRevision(workspace), /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(workspace.resourceRevisions.mechanics).sort(), workspace.mechanics.map(item => item.id).sort());
  for (const mechanic of workspace.mechanics) assert.match(mechanicRevision(workspace, mechanic.id), /^[a-f0-9]{64}$/u);
  assert.notEqual(definitionsRevision(workspace), workspace.revision);
});

test('draft open 保存旧草稿后才切换，并在 save 时自动排版和导出', async t => {
  const { projectRoot, root } = await fixture(t);
  const server = await startServer({ projectRoot, port: 0 });
  t.after(() => server.close());
  const scopes = await (await fetch(server.origin + '/api/agent?command=scopes&projectRoot=' + encodeURIComponent(projectRoot))).json();
  const first = json(await call(['draft', 'open', '--project', projectRoot, '--mechanic', 'basic-rules', '--project-generation', String(scopes.projectGeneration), '--connect', server.origin]));
  const mechanic = JSON.parse(await readFile(first.mechanicPath, 'utf8'));
  mechanic.name = '草稿修改后的基础规则';
  await writeFile(first.mechanicPath, JSON.stringify(mechanic, null, 2));
  const second = json(await call(['draft', 'open', '--project', projectRoot, '--mechanic', 'hand', '--project-generation', String(scopes.projectGeneration), '--connect', server.origin]));
  assert.notEqual(first.draftId, second.draftId);
  assert.equal((await readWorkspace(root)).mechanics.find(item => item.id === 'basic-rules').name, '草稿修改后的基础规则');
  const saved = json(await call(['draft', 'save', '--project', projectRoot, '--draft', second.draftId, '--project-generation', String(scopes.projectGeneration), '--connect', server.origin]));
  assert.equal(saved.canonicalCommitted, true);
  assert.ok((await readWorkspace(root)).mechanics.find(item => item.id === 'hand').routeCache);
});

test('draft open 在旧草稿无法保存时拒绝切换并保留旧草稿', async t => {
  const { projectRoot } = await fixture(t);
  const server = await startServer({ projectRoot, port: 0 });
  t.after(() => server.close());
  const scopes = await (await fetch(server.origin + '/api/agent?command=scopes&projectRoot=' + encodeURIComponent(projectRoot))).json();
  const first = json(await call(['draft', 'open', '--project', projectRoot, '--mechanic', 'basic-rules', '--project-generation', String(scopes.projectGeneration), '--connect', server.origin]));
  await writeFile(first.mechanicPath, '{ not json');
  const failed = await failure(call(['draft', 'open', '--project', projectRoot, '--mechanic', 'hand', '--project-generation', String(scopes.projectGeneration), '--connect', server.origin]));
  assert.equal(failed.body.error, 'AGENT_DRAFT_INVALID');
  await assert.doesNotReject(readFile(first.mechanicPath, 'utf8'));
});

test('draft open 清理超过 24 小时的遗留临时草稿', async t => {
  const { projectRoot } = await fixture(t);
  const firstServer = await startServer({ projectRoot, port: 0 });
  const scopes = await (await fetch(firstServer.origin + '/api/agent?command=scopes&projectRoot=' + encodeURIComponent(projectRoot))).json();
  const first = json(await call(['draft', 'open', '--project', projectRoot, '--mechanic', 'basic-rules', '--project-generation', String(scopes.projectGeneration), '--connect', firstServer.origin]));
  await firstServer.close();
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(first.draftPath, old, old);
  const secondServer = await startServer({ projectRoot, port: 0 });
  t.after(() => secondServer.close());
  const nextScopes = await (await fetch(secondServer.origin + '/api/agent?command=scopes&projectRoot=' + encodeURIComponent(projectRoot))).json();
  await call(['draft', 'open', '--project', projectRoot, '--mechanic', 'hand', '--project-generation', String(nextScopes.projectGeneration), '--connect', secondServer.origin]);
  await assert.rejects(stat(first.draftPath), { code: 'ENOENT' });
});

test('Agent 只能在既有目录中创建受约束的机制容器，并返回工作区与资源版本', async t => {
  const { projectRoot, root } = await fixture(t), before = await readWorkspace(root);
  const folder = json(await offline(projectRoot, ['mechanic-folder', 'create', '--name', '参考', '--workspace-revision', before.revision]));
  assert.equal(folder.canonicalCommitted, true); assert.equal(folder.folder, '参考');
  let workspace = await readWorkspace(root);
  const mechanic = json(await offline(projectRoot, ['mechanic', 'create', '--id', 'core-loop', '--name', '核心循环', '--scope', '基础玩法', '--folder', '参考',
    '--workspace-revision', workspace.revision]));
  assert.equal(mechanic.canonicalCommitted, true); assert.match(mechanic.resourceRevision, /^[a-f0-9]{64}$/u);
  workspace = await readWorkspace(root);
  assert.deepEqual(workspace.mechanics.find(item => item.id === 'core-loop'), { schemaVersion: 6, kind: 'mechanic', workspaceId: workspace.manifest.id,
    id: 'core-loop', name: '核心循环', scope: '基础玩法', nodeIds: [], edges: [], positions: {} });
  assert.ok(workspace.files.some(item => item.id === 'core-loop' && item.path === 'mechanics/参考/core-loop.mechanic.json'));
  const missing = await failure(offline(projectRoot, ['mechanic', 'create', '--id', 'missing-folder', '--name', '错误', '--scope', '测试', '--folder', '不存在', '--workspace-revision', workspace.revision]));
  assert.equal(missing.body.error, 'FOLDER_NOT_FOUND');
  const unsafe = await failure(offline(projectRoot, ['mechanic-folder', 'create', '--name', '../越界', '--workspace-revision', workspace.revision]));
  assert.equal(unsafe.body.error, 'UNSAFE_PATH');
});

test('Agent 只能以当前版本删除未被视图引用的机制和非当前视图', async t => {
  const { projectRoot, root } = await fixture(t);
  let workspace = await readWorkspace(root);
  const folder = json(await offline(projectRoot, ['mechanic-folder', 'create', '--name', '待删除文件夹', '--workspace-revision', workspace.revision]));
  const deletedFolder = json(await offline(projectRoot, ['mechanic-folder', 'delete', '--folder', '待删除文件夹', '--workspace-revision', folder.revision]));
  assert.equal(deletedFolder.action, 'delete');
  workspace = await readWorkspace(root);
  assert.equal(workspace.directories.includes('mechanics/待删除文件夹'), false);
  const created = json(await offline(projectRoot, ['mechanic', 'create', '--id', 'to-delete', '--name', '待删除机制', '--scope', '迁移清理测试',
    '--workspace-revision', workspace.revision]));
  const deleted = json(await offline(projectRoot, ['mechanic', 'delete', '--mechanic', 'to-delete', '--revision', created.resourceRevision]));
  assert.equal(deleted.action, 'delete');
  workspace = await readWorkspace(root);
  assert.equal(workspace.mechanics.some(item => item.id === 'to-delete'), false);

  const view = { schemaVersion: 3, kind: 'view', workspaceId: workspace.manifest.id, id: 'to-delete-view', name: '待删除视图',
    mechanicRegistrations: [{ mechanicId: 'basic-rules', visible: true }], collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' };
  await writeFile(join(root, 'to-delete-view.view.json'), `${JSON.stringify(view, null, 2)}\n`);
  workspace = await readWorkspace(root);
  const deletedView = json(await offline(projectRoot, ['view', 'delete', '--view', 'to-delete-view', '--workspace-revision', workspace.revision]));
  assert.equal(deletedView.action, 'delete');
  workspace = await readWorkspace(root);
  assert.equal(workspace.views.some(item => item.id === 'to-delete-view'), false);
});

test('Agent 原子更新机制元数据并移除共享的孤立成员，不删除全局概念或其他机制成员', async t => {
  const { projectRoot, root } = await fixture(t);
  let workspace = await readWorkspace(root);
  const created = json(await offline(projectRoot, ['mechanic', 'create', '--id', 'cleanup', '--name', '待整理', '--scope', '临时范围',
    '--workspace-revision', workspace.revision]));
  workspace = await readWorkspace(root);
  const source = json(await offline(projectRoot, ['concept', 'create', '--id', 'cleanup-source', '--label', '清理源', '--description', '测试概念。',
    '--revision', definitionsRevision(workspace)]));
  workspace = await readWorkspace(root);
  const target = json(await offline(projectRoot, ['concept', 'create', '--id', 'cleanup-target', '--label', '清理目标', '--description', '测试概念。',
    '--revision', source.resourceRevision]));
  const added = json(await offline(projectRoot, ['rule', 'add', '--mechanic', 'cleanup', '--source', 'cleanup-source', '--target', 'cleanup-target',
    '--relation', 'influence', '--sign', 'positive', '--revision', created.resourceRevision]));
  const blocked = await failure(offline(projectRoot, ['mechanic', 'update', '--mechanic', 'cleanup', '--remove-isolated-concepts', '["cleanup-source"]',
    '--revision', added.resourceRevision]));
  assert.equal(blocked.body.error, 'MECHANIC_MEMBER_NOT_ISOLATED');
  const removedRule = json(await offline(projectRoot, ['rule', 'delete', '--mechanic', 'cleanup', '--source', 'cleanup-source', '--target', 'cleanup-target',
    '--revision', added.resourceRevision]));
  workspace = await readWorkspace(root);
  const other = json(await offline(projectRoot, ['mechanic', 'create', '--id', 'other', '--name', '其他图', '--scope', '共享成员测试',
    '--workspace-revision', workspace.revision]));
  const shared = json(await offline(projectRoot, ['rule', 'add', '--mechanic', 'other', '--source', 'cleanup-source', '--target', 'cleanup-target',
    '--relation', 'influence', '--sign', 'positive', '--revision', other.resourceRevision]));
  const removed = json(await offline(projectRoot, ['mechanic', 'update', '--mechanic', 'cleanup', '--name', '总览', '--scope', '跨子系统入口',
    '--remove-isolated-concepts', '["cleanup-source","cleanup-target"]', '--revision', removedRule.resourceRevision]));
  workspace = await readWorkspace(root); const mechanic = workspace.mechanics.find(item => item.id === 'cleanup');
  assert.equal(mechanic.name, '总览'); assert.equal(mechanic.scope, '跨子系统入口');
  assert.equal(mechanic.nodeIds.includes('cleanup-source'), false);
  assert.ok(workspace.definitions.nodes.some(node => node.id === 'cleanup-source'));
  assert.ok(workspace.mechanics.find(item => item.id === 'other').nodeIds.includes('cleanup-source'));
  assert.match(shared.resourceRevision, /^[a-f0-9]{64}$/u);
  assert.match(removed.resourceRevision, /^[a-f0-9]{64}$/u);
});

test('Agent 自动排版仅保存网页同算法生成的整图坐标，并受机制资源版本保护', async t => {
  const { projectRoot, root } = await fixture(t);
  let workspace = await readWorkspace(root);
  const source = json(await offline(projectRoot, ['concept', 'create', '--id', 'layout-source', '--label', '布局源', '--description', '测试概念。',
    '--revision', definitionsRevision(workspace)]));
  const target = json(await offline(projectRoot, ['concept', 'create', '--id', 'layout-target', '--label', '布局目标', '--description', '测试概念。',
    '--revision', source.resourceRevision]));
  workspace = await readWorkspace(root);
  const mechanic = json(await offline(projectRoot, ['mechanic', 'create', '--id', 'layout-target-graph', '--name', '布局测试', '--scope', '测试自动排版',
    '--workspace-revision', workspace.revision]));
  const added = json(await offline(projectRoot, ['rule', 'add', '--mechanic', 'layout-target-graph', '--source', 'layout-source', '--target', 'layout-target',
    '--relation', 'influence', '--sign', 'positive', '--revision', mechanic.resourceRevision]));
  const arranged = json(await offline(projectRoot, ['mechanic', 'arrange', '--mechanic', 'layout-target-graph', '--revision', added.resourceRevision]));
  workspace = await readWorkspace(root);
  const saved = workspace.mechanics.find(item => item.id === 'layout-target-graph');
  assert.deepEqual(Object.keys(saved.positions).sort(), ['layout-source', 'layout-target']);
  assert.ok(Object.values(saved.positions).every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.equal((await failure(offline(projectRoot, ['mechanic', 'arrange', '--mechanic', 'layout-target-graph', '--positions', '{}',
    '--revision', arranged.resourceRevision]))).body.error, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
  void target;
});

test('三级 CLI 创建概念；update 是字段 patch，JSON 数组可清空且禁止修改 ID 与锁', async t => {
  const { projectRoot, root } = await fixture(t), before = await readWorkspace(root);
  const created = json(await offline(projectRoot, ['concept', 'create', '--id', 'focus', '--label', '专注', '--description', '可投入行动的专注。',
    '--aliases', '["集中"]', '--tags', '["资源"]', '--custom-data', '来源：设计草案', '--revision', definitionsRevision(before)]));
  assert.equal(created.canonicalCommitted, true);
  assert.equal(created.workspaceId, before.manifest.id);
  assert.match(created.resourceRevision, /^[a-f0-9]{64}$/u);
  assert.notEqual(created.resourceRevision, definitionsRevision(before));
  let workspace = await readWorkspace(root), concept = workspace.definitions.nodes.find(node => node.id === 'focus');
  assert.deepEqual(concept, { id: 'focus', label: '专注', description: '可投入行动的专注。', aliases: ['集中'], tags: ['资源'], customData: '来源：设计草案', agentLocked: false });

  const updated = json(await offline(projectRoot, ['concept', 'update', '--concept', 'focus', '--description', '用于维持复杂行动。',
    '--aliases', '[]', '--tags', '[]', '--revision', created.resourceRevision]));
  workspace = await readWorkspace(root); concept = workspace.definitions.nodes.find(node => node.id === 'focus');
  assert.equal(concept.label, '专注');
  assert.equal(concept.description, '用于维持复杂行动。');
  assert.deepEqual(concept.aliases, []); assert.deepEqual(concept.tags, []);
  assert.equal(concept.customData, '来源：设计草案');
  const clearedCustomData = json(await offline(projectRoot, ['concept', 'update', '--concept', 'focus', '--custom-data', '', '--revision', updated.resourceRevision]));
  workspace = await readWorkspace(root); concept = workspace.definitions.nodes.find(node => node.id === 'focus');
  assert.equal(Object.hasOwn(concept, 'customData'), false);
  assert.notEqual(clearedCustomData.resourceRevision, created.resourceRevision);

  for (const args of [
    ['--id', 'renamed'], ['--agent-locked', 'true'], ['--aliases', '不是 JSON'], ['--tags', '{}'],
  ]) {
    const rejected = await failure(offline(projectRoot, ['concept', 'update', '--concept', 'focus', ...args, '--revision', updated.resourceRevision]));
    assert.ok(['ERR_PARSE_ARGS_UNKNOWN_OPTION', 'AGENT_MUTATION_INVALID'].includes(rejected.body.error), JSON.stringify(rejected.body));
  }
  const stale = await failure(offline(projectRoot, ['concept', 'update', '--concept', 'focus', '--label', '过期修改', '--revision', created.resourceRevision]));
  assert.equal(stale.body.error, 'RESOURCE_REVISION_CONFLICT');
});

test('概念锁只阻止 Agent update/delete，规则仍可连接锁定概念', async t => {
  const { projectRoot, root } = await fixture(t);
  const path = join(root, 'definitions.graph.json'), definitions = JSON.parse(await readFile(path, 'utf8'));
  definitions.nodes.find(node => node.id === 'armor').agentLocked = true;
  await writeFile(path, JSON.stringify(definitions));
  const canonical = await readWorkspace(root, { verifyGeneratedCatalog: false });
  await publishCatalog(canonical.agentExportRoot, canonical);
  const workspace = await readWorkspace(root), revision = definitionsRevision(workspace);
  for (const args of [
    ['concept', 'update', '--concept', 'armor', '--label', '锁定后修改', '--revision', revision],
    ['concept', 'delete', '--concept', 'armor', '--revision', revision],
  ]) assert.equal((await failure(offline(projectRoot, args))).body.error, 'CONCEPT_AGENT_LOCKED');

  const rule = json(await offline(projectRoot, ['rule', 'add', '--mechanic', 'basic-rules', '--source', 'armor', '--target', 'evade',
    '--relation', 'influence', '--sign', 'positive', '--text', '护甲会提高闪避能力。',
    '--revision', mechanicRevision(workspace, 'basic-rules')]));
  assert.equal(rule.canonicalCommitted, true);
  const saved = await readWorkspace(root), mechanic = saved.mechanics.find(item => item.id === 'basic-rules');
  assert.ok(mechanic.edges.some(edge => edge.id === 'armor-2-evade' && !Object.hasOwn(edge, 'condition') && edge.ruleText === '护甲会提高闪避能力。'));
});

test('rule add 必须指定机制、拒绝端点 upsert、自动补节点；update 不改端点，delete 保留节点', async t => {
  const { projectRoot, root } = await fixture(t), before = await readWorkspace(root);
  const missingMechanic = await failure(offline(projectRoot, ['rule', 'add', '--source', 'armor', '--target', 'evade', '--relation', 'influence',
    '--sign', 'positive', '--revision', mechanicRevision(before, 'basic-rules')]));
  assert.equal(missingMechanic.body.error, 'AGENT_MUTATION_INVALID');

  const added = json(await offline(projectRoot, ['rule', 'add', '--mechanic', 'basic-rules', '--source', 'armor', '--target', 'evade',
    '--relation', 'influence', '--sign', 'positive', '--custom-data', '来源：规则设计记录',
    '--revision', mechanicRevision(before, 'basic-rules')]));
  let workspace = await readWorkspace(root), mechanic = workspace.mechanics.find(item => item.id === 'basic-rules');
  assert.ok(mechanic.nodeIds.includes('armor')); assert.ok(mechanic.nodeIds.includes('evade'));
  assert.equal(mechanic.edges.find(edge => edge.id === 'armor-2-evade').customData, '来源：规则设计记录');
  assert.equal(mechanic.positions.armor, undefined); assert.equal(mechanic.positions.evade, undefined);
  const duplicate = await failure(offline(projectRoot, ['rule', 'add', '--mechanic', 'basic-rules', '--source', 'armor', '--target', 'evade',
    '--relation', 'specializes', '--revision', added.resourceRevision]));
  assert.equal(duplicate.body.error, 'DUPLICATE_ENDPOINT_RULE');

  const updated = json(await offline(projectRoot, ['rule', 'update', '--mechanic', 'basic-rules', '--source', 'armor', '--target', 'evade',
    '--text', '装备护甲会影响闪避。', '--revision', added.resourceRevision]));
  workspace = await readWorkspace(root); mechanic = workspace.mechanics.find(item => item.id === 'basic-rules');
  assert.equal(mechanic.edges.find(edge => edge.id === 'armor-2-evade').ruleText, '装备护甲会影响闪避。');
  const endpointChange = await failure(offline(projectRoot, ['rule', 'update', '--mechanic', 'basic-rules', '--source', 'armor', '--target', 'evade',
    '--new-target', 'repel', '--revision', updated.resourceRevision]));
  assert.ok(['ERR_PARSE_ARGS_UNKNOWN_OPTION', 'AGENT_MUTATION_INVALID'].includes(endpointChange.body.error));
  const deleted = json(await offline(projectRoot, ['rule', 'delete', '--mechanic', 'basic-rules', '--source', 'armor', '--target', 'evade',
    '--revision', updated.resourceRevision]));
  workspace = await readWorkspace(root); mechanic = workspace.mechanics.find(item => item.id === 'basic-rules');
  assert.equal(mechanic.edges.some(edge => edge.source === 'armor' && edge.target === 'evade'), false);
  assert.ok(mechanic.nodeIds.includes('armor')); assert.ok(mechanic.nodeIds.includes('evade'));
  assert.notEqual(deleted.resourceRevision, updated.resourceRevision);
  assert.equal((await failure(offline(projectRoot, ['rule', 'delete', '--mechanic', 'basic-rules', '--source', 'armor', '--target', 'evade',
    '--revision', deleted.resourceRevision]))).body.error, 'RULE_NOT_FOUND');
});

test('更新不含 ruleText 的既有规则时可以填写或清空规则', async t => {
  const { projectRoot, root } = await fixture(t), before = await readWorkspace(root);
  const mechanic = before.mechanics[0], edge = mechanic.edges[0];
  delete edge.ruleText;
  const file = before.files.find(item => item.kind === 'mechanic' && item.id === mechanic.id).path;
  await writeFile(join(root, file), JSON.stringify(mechanic));
  const current = await readWorkspace(root);
  await offline(projectRoot, ['rule', 'update', '--mechanic', mechanic.id, '--source', edge.source, '--target', edge.target,
    '--text', '', '--revision', mechanicRevision(current, mechanic.id)]);
  const saved = await readWorkspace(root), updated = saved.mechanics.find(item => item.id === mechanic.id).edges.find(item => item.id === edge.id);
  assert.equal(updated.ruleText, '');
  assert.equal(Object.hasOwn(updated, 'condition'), false);
});

test('concept delete 允许同时删除自身与纯布局坐标，但拒绝机制、规则或 composition 引用', async t => {
  await t.test('零引用概念及自身坐标可删除', async t => {
    const { projectRoot, root } = await fixture(t), before = await readWorkspace(root);
    assert.ok(before.definitions.positions.armor);
    await offline(projectRoot, ['concept', 'delete', '--concept', 'armor', '--revision', definitionsRevision(before)]);
    const saved = await readWorkspace(root);
    assert.equal(saved.definitions.nodes.some(node => node.id === 'armor'), false);
    assert.equal(saved.definitions.positions.armor, undefined);
  });
  await t.test('机制 nodeIds 与规则端点引用拒绝删除', async t => {
    const { projectRoot, root } = await fixture(t), workspace = await readWorkspace(root);
    const rejected = await failure(offline(projectRoot, ['concept', 'delete', '--concept', 'melee', '--revision', definitionsRevision(workspace)]));
    assert.equal(rejected.body.error, 'CONCEPT_REFERENCED');
    assert.match(rejected.body.message, /melee/);
  });
  await t.test('视图位置引用会随概念删除清理', async t => {
    const { projectRoot, root } = await fixture(t), workspace = await readWorkspace(root);
    const view = { schemaVersion: 3, kind: 'view', workspaceId: workspace.manifest.id, id: 'armor-view', name: '护甲视图',
      mechanicRegistrations: [], collapsedNodeIds: [], positions: { armor: { x: 10, y: 20 } }, structuralPresentation: 'line' };
    await writeFile(join(root, 'armor.view.json'), JSON.stringify(view));
    const fresh = await readWorkspace(root);
    const deleted = json(await offline(projectRoot, ['concept', 'delete', '--concept', 'armor', '--revision', definitionsRevision(fresh)]));
    assert.equal(deleted.canonicalCommitted, true);
    const saved = await readWorkspace(root);
    assert.equal(saved.definitions.nodes.some(node => node.id === 'armor'), false);
    assert.equal(saved.views.find(item => item.id === 'armor-view').positions.armor, undefined);
  });
  await t.test('composition 位置引用拒绝删除', async t => {
    const { projectRoot, root } = await fixture(t), path = join(root, 'workspace.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.compositions[0].positions.armor = { x: 10, y: 20 };
    await writeFile(path, JSON.stringify(manifest));
    const fresh = await readWorkspace(root);
    const rejected = await failure(offline(projectRoot, ['concept', 'delete', '--concept', 'armor', '--revision', definitionsRevision(fresh)]));
    assert.equal(rejected.body.error, 'CONCEPT_REFERENCED');
    assert.match(rejected.body.message, /组合/);
  });
});

test('在线 mutation 同时要求 resource revision 与 projectGeneration，并使用同一领域合同', async t => {
  const { projectRoot, root } = await fixture(t);
  const server = await startServer({ projectRoot, port: 0, projectHistoryPath: join(projectRoot, '.test-projects.json') });
  try {
    const current = await (await fetch(server.origin + '/api/workspace')).json();
    const body = { projectRoot, projectGeneration: current.projectGeneration, revision: definitionsRevision(current), resource: 'concept', action: 'create',
      id: 'focus', label: '专注', description: '可投入行动的专注。', aliases: [], tags: [] };
    const post = value => fetch(server.origin + '/api/agent/mutation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const noGeneration = await post({ ...body, projectGeneration: undefined });
    assert.equal(noGeneration.status, 409); assert.equal((await noGeneration.json()).error, 'PROJECT_CHANGED');
    const noSession = await post(body);
    assert.equal(noSession.status, 422); assert.equal((await noSession.json()).error, 'AGENT_EDIT_SESSION_REQUIRED');
    const opened = json(await call(['session', 'open', '--project', projectRoot, '--mechanic', 'basic-rules', '--project-generation', String(current.projectGeneration), '--connect', server.origin]));
    assert.equal(opened.status, 'open'); assert.equal(opened.mechanic, 'basic-rules');
    const noRevision = await post({ ...body, revision: undefined, editSessionId: opened.session });
    assert.equal(noRevision.status, 422); assert.equal((await noRevision.json()).error, 'AGENT_MUTATION_INVALID');
    const response = await post({ ...body, editSessionId: opened.session }); assert.equal(response.status, 200);
    const saved = await response.json(); assert.equal(saved.canonicalCommitted, true); assert.match(saved.resourceRevision, /^[a-f0-9]{64}$/u);
    assert.ok((await readWorkspace(root)).definitions.nodes.some(node => node.id === 'focus'));

    const online = json(await call(['concept', 'update', '--concept', 'focus', '--label', '在线专注', '--revision', saved.resourceRevision,
      '--project', projectRoot, '--project-generation', String(current.projectGeneration), '--session', opened.session, '--connect', server.origin]));
    assert.equal(online.canonicalCommitted, true);
    assert.equal((await readWorkspace(root)).definitions.nodes.find(node => node.id === 'focus').label, '在线专注');

    const afterConcept = await (await fetch(server.origin + '/api/workspace')).json();
    const createdFolder = json(await call(['mechanic-folder', 'create', '--name', '参考', '--workspace-revision', afterConcept.revision,
      '--project', projectRoot, '--project-generation', String(afterConcept.projectGeneration), '--session', opened.session, '--connect', server.origin]));
    assert.equal(createdFolder.folder, '参考');
    const afterFolder = await (await fetch(server.origin + '/api/workspace')).json();
    const createdMechanic = json(await call(['mechanic', 'create', '--id', 'reference-core', '--name', '参考核心', '--scope', '在线契约', '--folder', '参考',
      '--workspace-revision', afterFolder.revision, '--project', projectRoot, '--project-generation', String(afterFolder.projectGeneration), '--session', opened.session, '--connect', server.origin]));
    assert.equal(createdMechanic.canonicalCommitted, true);
    assert.match(createdMechanic.resourceRevision, /^[a-f0-9]{64}$/u);
    assert.ok((await readWorkspace(root)).mechanics.some(item => item.id === 'reference-core'));
    const closing = json(await call(['session', 'close', '--mechanic', 'basic-rules', '--session', opened.session,
      '--project', projectRoot, '--project-generation', String(current.projectGeneration), '--connect', server.origin]));
    assert.equal(closing.asynchronous, true); assert.equal(closing.status, 'closing');
    let status = closing;
    for (let attempt = 0; attempt < 20 && status.status === 'closing'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      status = json(await call(['session', 'status', '--project', projectRoot, '--session', opened.session, '--project-generation', String(current.projectGeneration), '--connect', server.origin]));
    }
    assert.equal(status.status, 'closed'); assert.equal(status.result.arranged, true);
  } finally { await server.close(); }
});

test('机制会话彼此独立；仅 previousSession 会异步关闭指定旧会话', async t => {
  const { projectRoot, root } = await fixture(t);
  const server = await startServer({ projectRoot, port: 0, projectHistoryPath: join(projectRoot, '.test-projects.json') });
  try {
    const current = await (await fetch(server.origin + '/api/workspace')).json();
    const first = json(await call(['session', 'open', '--project', projectRoot, '--mechanic', 'basic-rules', '--project-generation', String(current.projectGeneration), '--connect', server.origin]));
    const second = json(await call(['session', 'open', '--project', projectRoot, '--mechanic', 'encounter', '--previous-session', first.session, '--project-generation', String(current.projectGeneration), '--connect', server.origin]));
    assert.equal(second.status, 'open'); assert.equal(second.autoClosed.session, first.session);
    const rejected = await failure(call(['rule', 'add', '--mechanic', 'basic-rules', '--source', 'armor', '--target', 'evade', '--relation', 'influence', '--sign', 'positive',
      '--revision', mechanicRevision(current, 'basic-rules'), '--project', projectRoot, '--project-generation', String(current.projectGeneration), '--session', second.session, '--connect', server.origin]));
    assert.equal(rejected.body.error, 'AGENT_EDIT_SCOPE_MISMATCH');
    const closeFirst = json(await call(['session', 'status', '--project', projectRoot, '--session', first.session, '--project-generation', String(current.projectGeneration), '--connect', server.origin]));
    assert.ok(['closing', 'closed'].includes(closeFirst.status));
    void root;
  } finally { await server.close(); }
});

test('Agent 以项目目录定位后台上下文，不切换网页当前标签', async t => {
  const first = await fixture(t), second = await fixture(t);
  const server = await startServer({ projectRoot: first.projectRoot, port: 0, projectHistoryPath: join(first.projectRoot, '.test-projects.json') });
  try {
    const post = (path, body) => fetch(server.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const preflight = await post('/api/project/preflight', { projectRoot: second.projectRoot });
    const inspected = await preflight.json(); assert.equal(preflight.status, 200);
    const openedSecond = await post('/api/project/open', { projectRoot: second.projectRoot, intent: inspected.allowedIntent, selectionToken: inspected.selectionToken });
    assert.equal(openedSecond.status, 200);
    const webActive = await (await fetch(server.origin + '/api/workspace')).json();
    assert.equal(webActive.projectRoot, second.projectRoot);
    const firstScopes = json(await call(['scopes', '--project', first.projectRoot, '--connect', server.origin]));
    assert.equal(firstScopes.projectGeneration, 1);
    assert.equal((await (await fetch(server.origin + '/api/workspace')).json()).projectRoot, second.projectRoot);
    const opened = json(await call(['session', 'open', '--project', first.projectRoot, '--mechanic', 'basic-rules',
      '--project-generation', String(firstScopes.projectGeneration), '--connect', server.origin]));
    assert.equal(opened.mechanic, 'basic-rules');
    assert.equal((await (await fetch(server.origin + '/api/workspace')).json()).projectRoot, second.projectRoot);
  } finally { await server.close(); }
});

test('catalog 发布失败仍返回 canonicalCommitted=true 与明确的导出失败状态，CLI 不重试 canonical mutation', async t => {
  const { projectRoot, root } = await fixture(t), before = await readWorkspace(root);
  await writeFile(join(projectRoot, 'game-mechanics', 'user-owned.txt'), '不能由生成器清理');
  const accepted = json(await offline(projectRoot, ['concept', 'create', '--id', 'focus', '--label', '专注', '--description', '可投入行动的专注。',
    '--aliases', '[]', '--tags', '[]', '--revision', definitionsRevision(before)]));
  assert.equal(accepted.canonicalCommitted, true);
  assert.equal(accepted.workspaceId, before.manifest.id);
  assert.match(accepted.resourceRevision, /^[a-f0-9]{64}$/u);
  assert.equal(accepted.exportPublication.state, 'failed');
  assert.equal(accepted.exportPublication.code, 'EXPORT_ROOT_NOT_EMPTY');
  const definitions = JSON.parse(await readFile(join(root, before.manifest.definitions), 'utf8'));
  assert.equal(definitions.nodes.filter(node => node.id === 'focus').length, 1);
  assert.ok((await readdir(join(projectRoot, 'game-mechanics'))).includes('user-owned.txt'));
});
