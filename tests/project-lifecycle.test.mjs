import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/http.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { copyExampleFixture } from './example-fixture.mjs';
import { publishCatalog } from '../src/server/catalog.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { acquireWorkspaceLock } from '../src/server/files.mjs';

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));

async function post(origin, path, body, headers = {}) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { response, data: await response.json() };
}

async function waitForPublication(origin, token, attempts = 40) {
  for (let index = 0; index < attempts; index++) {
    const workspace = await (await fetch(origin + '/api/workspace?projectSessionToken=' + encodeURIComponent(token))).json();
    if (workspace.exportPublication?.state === 'current' || workspace.exportPublication?.state === 'failed') return workspace;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('后台文档发布未在预期时间内结束');
}


// v12 是自动升级链的入口：rules.json 已存在，但 mechanism/view 还缺少显式展示状态。
async function downgradeFixtureToV12(projectRoot) {
  const workspaceRoot = join(projectRoot, '.mechanics');
  const workspace = await readWorkspace(workspaceRoot);
  const manifestPath = join(workspaceRoot, 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 12 }, null, 2) + '\n');
  for (const mechanic of workspace.mechanics) {
    const path = join(workspaceRoot, workspace.files.find(file => file.kind === 'mechanic' && file.id === mechanic.id).path);
    const { taxonomyPresentation, implementationStatus, ...rest } = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...rest, schemaVersion: 7 }, null, 2) + '\n');
  }
  for (const view of workspace.views) {
    const path = join(workspaceRoot, workspace.files.find(file => file.kind === 'view' && file.id === view.id).path);
    const { taxonomyPresentation, ...rest } = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...rest, schemaVersion: 4 }, null, 2) + '\n');
  }
  return { workspaceRoot, manifest };
}

async function workspaceBytes(workspaceRoot) {
  const entries = await readdir(workspaceRoot, { recursive: true, withFileTypes: true });
  const paths = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(path, 'utf8')])));
}
async function openProject(origin, projectRoot, metadata = {}, headers = {}) {
  return post(origin, '/api/project/open', { projectRoot, ...metadata }, headers);
}


test('v12 项目在打开时自动原子升级到 v14，直接严格读取则明确拒绝', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-v12-upgrade-'));
  const projectRoot = join(temp, 'v12-project');
  await copyExampleFixture(projectRoot);
  const { workspaceRoot } = await downgradeFixtureToV12(projectRoot);
  // 未迁移的 v12 不能落进只读兼容模型：它缺少必填的展示状态。
  await assert.rejects(readWorkspace(workspaceRoot), { code: 'WORKSPACE_VERSION_UNSUPPORTED' });
  const server = await startServer({ port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const opened = await openProject(server.origin, projectRoot);
  assert.equal(opened.response.status, 200, JSON.stringify(opened.data));
  assert.deepEqual(opened.data.projectUpgrade, { upgraded: true, from: 12, schemaVersion: 14 });
  assert.equal(opened.data.manifest.schemaVersion, 14);
  assert.equal(opened.data.compatibilityMode, false);
  const explicit = JSON.stringify({ mode: 'label', expandedNodeIds: [] });
  assert.ok(opened.data.mechanics.every(item => item.schemaVersion === 9 && item.implementationStatus === 'design' && JSON.stringify(item.taxonomyPresentation) === explicit));
  // 升级真实落盘，重开不再需要第二次升级。
  const onDisk = JSON.parse(await readFile(join(workspaceRoot, 'workspace.json'), 'utf8'));
  assert.equal(onDisk.schemaVersion, 14);
  for (const name of (await readdir(join(workspaceRoot, 'mechanics'))).filter(name => name.endsWith('.mechanic.json'))) {
    assert.equal(JSON.parse(await readFile(join(workspaceRoot, 'mechanics', name), 'utf8')).schemaVersion, 9);
  }
  // 同一会话再次打开命中已升级的工作区，不再有第二次写入。
  const reopened = await openProject(server.origin, projectRoot);
  assert.equal(reopened.response.status, 200);
  assert.equal(reopened.data.manifest.schemaVersion, 14);
  await waitForPublication(server.origin, opened.data.projectSessionToken);
});

test('v12 自动升级失败时报明确错误且不写入任何文件', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-v12-failed-'));
  const projectRoot = join(temp, 'broken-v12');
  await copyExampleFixture(projectRoot);
  const { workspaceRoot } = await downgradeFixtureToV12(projectRoot);
  const rulesPath = join(workspaceRoot, 'rules.json');
  const rules = JSON.parse(await readFile(rulesPath, 'utf8'));
  // 同一概念出现两条 is-a 出边：候选校验必须整体拒绝。
  rules.rules.push({ id: 'evade-2-melee', source: 'evade', target: 'melee', relation: 'specializes' });
  rules.rules.push({ id: 'evade-2-failure', source: 'evade', target: 'failure', relation: 'specializes' });
  await writeFile(rulesPath, JSON.stringify(rules, null, 2) + '\n');
  const before = await workspaceBytes(workspaceRoot);
  const server = await startServer({ port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const opened = await openProject(server.origin, projectRoot);
  assert.equal(opened.response.status, 422, JSON.stringify(opened.data));
  assert.equal(opened.data.error, 'MIGRATION_VALIDATION_FAILED');
  assert.match(opened.data.message, /自动升级失败（v12 → v13）/);
  assert.match(opened.data.message, /is-a 父概念必须唯一/);
  assert.deepEqual(await workspaceBytes(workspaceRoot), before);
  assert.equal((await fetch(server.origin + '/api/workspace')).status, 409);
});
test('无 session 服务支持跨源打开项目，并用 generation 阻止旧页面误写', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-project-switch-'));
  const first = join(temp, 'first-project'), second = join(temp, 'second-project');
  await copyExampleFixture(first); await copyExampleFixture(second);
  const historyPath = join(temp, 'user', 'projects.json');
  const server = await startServer({ port: 0, projectHistoryPath: historyPath });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });

  const empty = await fetch(server.origin + '/api/project');
  assert.deepEqual(await empty.json(), { status: 'empty', projectGeneration: 0 });
  assert.equal((await fetch(server.origin + '/api/workspace')).status, 409);
  const preflight = await fetch(server.origin + '/api/project/open', { method: 'OPTIONS',
    headers: { Origin: 'https://tool.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

  const openedFirst = await openProject(server.origin, first, {}, { Origin: 'https://tool.example' });
  assert.equal(openedFirst.response.status, 200);
  assert.equal(openedFirst.data.projectGeneration, 1);
  assert.equal(openedFirst.data.projectRoot, first);

  const openedSecond = await openProject(server.origin, second, {}, { Origin: 'https://tool.example' });
  assert.equal(openedSecond.response.status, 200);
  assert.equal(openedSecond.data.projectGeneration, 2);
  const stale = await post(server.origin, '/api/save', {
    projectGeneration: 1, revision: openedFirst.data.revision, kind: 'workspace',
    document: { ...openedFirst.data.manifest, name: '不应写入第二项目' },
  }, { Origin: 'https://tool.example' });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.data.error, 'PROJECT_CHANGED');
  assert.notEqual((await (await fetch(server.origin + '/api/workspace')).json()).manifest.name, '不应写入第二项目');
});

test('受管 assets 路径冲突不会阻断项目会话，后台失败可查询且可重开恢复', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-open-readonly-')), project = join(temp, 'project');
  await copyExampleFixture(project);
  await writeFile(join(project, '.agents'), '路径被文件占用');
  const server = await startServer({ port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });

  const opened = await openProject(server.origin, project);
  assert.equal(opened.response.status, 200);
  const statusUrl = server.origin + '/api/project/assets?projectSessionToken=' + encodeURIComponent(opened.data.projectSessionToken);
  let status;
  for (let index = 0; index < 200; index++) {
    status = (await (await fetch(statusUrl)).json()).projectAssetSync;
    if (status.state !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(status.state, 'failed');
  assert.equal(status.code, 'PROJECT_SKILL_CONFLICT');
  assert.equal((await fetch(server.origin + '/api/workspace')).status, 200);
  assert.equal(await readFile(join(project, '.agents'), 'utf8'), '路径被文件占用');
  await rm(join(project, '.agents'));
  const reopened = await openProject(server.origin, project);
  assert.equal(reopened.response.status, 200);
  for (let index = 0; index < 200; index++) {
    status = (await (await fetch(statusUrl)).json()).projectAssetSync;
    if (status.state !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(status.state, 'current', status.message);
  await access(join(project, '.mechanics/tools/workspace-tool.mjs'));
});

test('带项目会话令牌的写入始终命中其所属项目，不受当前项目切换影响', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-project-sessions-'));
  const first = join(temp, 'first-project'), second = join(temp, 'second-project');
  await copyExampleFixture(first); await copyExampleFixture(second);
  const server = await startServer({ port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const openedFirst = await openProject(server.origin, first);
  const openedSecond = await openProject(server.origin, second);
  const saved = await post(server.origin, '/api/save', {
    projectSessionToken: openedFirst.data.projectSessionToken, projectGeneration: openedFirst.data.projectGeneration,
    revision: openedFirst.data.revision, kind: 'workspace', document: { ...openedFirst.data.manifest, name: '第一项目已写入' },
  });
  assert.equal(saved.response.status, 200);
  assert.equal((await readWorkspace(join(first, '.mechanics'))).manifest.name, '第一项目已写入');
  assert.notEqual((await readWorkspace(join(second, '.mechanics'))).manifest.name, '第一项目已写入');
  const active = await (await fetch(server.origin + '/api/workspace')).json();
  assert.equal(active.projectSessionToken, openedSecond.data.projectSessionToken);
  const selected = await post(server.origin, '/api/project/select', {
    projectSessionToken: openedFirst.data.projectSessionToken,
  });
  assert.equal(selected.response.status, 200);
  assert.equal(selected.data.projectSessionToken, openedFirst.data.projectSessionToken);
  const restoredActive = await (await fetch(server.origin + '/api/workspace')).json();
  assert.equal(restoredActive.projectSessionToken, openedFirst.data.projectSessionToken);
});

test('进入关联项目保留源项目 active 会话，并返回可写的目标会话', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-enter-reference-'));
  const source = join(temp, 'source-project'), reference = join(temp, 'reference-project');
  await copyExampleFixture(source); await copyExampleFixture(reference);
  const server = await startServer({ projectRoot: source, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const sourceWorkspace = await (await fetch(server.origin + '/api/workspace')).json();
  const declared = await post(server.origin, '/api/project-references/declare', {
    projectSessionToken: sourceWorkspace.projectSessionToken, projectGeneration: sourceWorkspace.projectGeneration, projectRoot: reference,
  });
  assert.equal(declared.response.status, 200, JSON.stringify(declared.data));
  const entered = await post(server.origin, '/api/project/reference-enter', {
    projectSessionToken: sourceWorkspace.projectSessionToken, projectGeneration: sourceWorkspace.projectGeneration, referenceId: declared.data.references[0].id,
  });
  assert.equal(entered.response.status, 200, JSON.stringify(entered.data));
  assert.equal(entered.data.projectRoot, reference);
  const active = await (await fetch(server.origin + '/api/project')).json();
  assert.equal(active.projectSessionToken, sourceWorkspace.projectSessionToken);
  const saved = await post(server.origin, '/api/save', {
    projectSessionToken: entered.data.projectSessionToken, projectGeneration: entered.data.projectGeneration,
    revision: entered.data.revision, kind: 'workspace', document: { ...entered.data.manifest, name: '关联项目已写入' },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
  assert.equal((await readWorkspace(join(reference, '.mechanics'))).manifest.name, '关联项目已写入');
  assert.notEqual((await readWorkspace(join(source, '.mechanics'))).manifest.name, '关联项目已写入');
});

test('关联删除接口只以源项目会话移除声明，并拒绝旧关联版本', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'mechanics-remove-reference-http-'));
  const source = join(temp, 'source-project'), reference = join(temp, 'reference-project');
  await copyExampleFixture(source); await copyExampleFixture(reference);
  const server = await startServer({ projectRoot: source, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const sourceWorkspace = await (await fetch(server.origin + '/api/workspace')).json();
  const declared = await post(server.origin, '/api/project-references/declare', {
    projectSessionToken: sourceWorkspace.projectSessionToken, projectGeneration: sourceWorkspace.projectGeneration, projectRoot: reference,
  });
  assert.equal(declared.response.status, 200, JSON.stringify(declared.data));
  const state = await (await fetch(server.origin + '/api/project-references?projectSessionToken=' + encodeURIComponent(sourceWorkspace.projectSessionToken))).json();
  const targetBefore = await readFile(join(reference, '.mechanics', 'definitions.json'), 'utf8');
  const stale = await post(server.origin, '/api/project-references/remove', {
    projectSessionToken: sourceWorkspace.projectSessionToken, projectGeneration: sourceWorkspace.projectGeneration,
    referenceId: state.references[0].id, referencesRevision: 'outdated',
  });
  assert.equal(stale.response.status, 409);
  const removed = await post(server.origin, '/api/project-references/remove', {
    projectSessionToken: sourceWorkspace.projectSessionToken, projectGeneration: sourceWorkspace.projectGeneration,
    referenceId: state.references[0].id, referencesRevision: state.referencesRevision,
  });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.removedReferenceId, state.references[0].id);
  assert.deepEqual(removed.data.references, []);
  assert.equal(await readFile(join(reference, '.mechanics', 'definitions.json'), 'utf8'), targetBefore);
});

test('概念文档接口只读取完整导出，拒绝篡改与任意路径', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-concept-docs-'));
  const projectRoot = join(temp, 'project'); await copyExampleFixture(projectRoot);
  const canonical = await readWorkspace(join(projectRoot, '.mechanics'));
  await mkdir(canonical.agentExportRoot, { recursive: true });
  await publishCatalog(canonical.agentExportRoot, canonical);
  const server = await startServer({ projectRoot, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const index = await fetch(server.origin + '/api/concept-docs');
  assert.equal(index.status, 200);
  const body = await index.json();
  assert.equal(body.document.kind, 'index'); assert.match(body.document.markdown, /游戏机制文档索引/);
  const concept = await fetch(server.origin + '/api/concept-docs?conceptId=health');
  assert.equal(concept.status, 200); assert.equal((await concept.json()).document.conceptId, 'health');
  const mechanicDocument = body.documents.find(item => item.kind === 'mechanic');
  const mechanic = await fetch(server.origin + '/api/concept-docs?file=' + encodeURIComponent(mechanicDocument.file));
  assert.equal(mechanic.status, 200); assert.equal((await mechanic.json()).document.kind, 'mechanic');
  assert.equal((await fetch(server.origin + '/api/concept-docs?conceptId=health&file=concepts.md')).status, 422);
  assert.equal((await fetch(server.origin + '/api/concept-docs?conceptId=../workspace')).status, 422);
  await writeFile(join(projectRoot, 'mechanics', 'README.md'), '手工篡改');
  const stale = await fetch(server.origin + '/api/concept-docs');
  assert.equal(stale.status, 422); assert.equal((await stale.json()).error, 'CATALOG_STALE');
});

test('文档导出设置与生成文档分别提交，并允许用未改动的设置重新生成', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-document-export-'));
  const projectRoot = join(temp, 'project'); await copyExampleFixture(projectRoot);
  const server = await startServer({ projectRoot, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const workspace = await (await fetch(server.origin + '/api/workspace')).json();
  const settings = await (await fetch(server.origin + '/api/document-export/settings?projectSessionToken=' + encodeURIComponent(workspace.projectSessionToken))).json();
  assert.ok(settings.mechanics.length);
  const mechanicId = settings.mechanics[0].id;
  const saved = await post(server.origin, '/api/document-export/settings', {
    projectSessionToken: workspace.projectSessionToken, projectGeneration: workspace.projectGeneration, revision: settings.revision,
    selections: [{ kind: 'mechanic', mechanicId }],
  });
  assert.equal(saved.response.status, 200);
  assert.notEqual(saved.data.revision, settings.revision);
  assert.deepEqual(saved.data.manifest.exportSelections, [{ kind: 'mechanic', mechanicId }]);
  assert.equal(saved.data.exportPublication.state, 'pending');
  const generated = await post(server.origin, '/api/document-export/generate', {
    projectSessionToken: saved.data.projectSessionToken, projectGeneration: saved.data.projectGeneration, revision: saved.data.revision,
  });
  assert.equal(generated.response.status, 200, JSON.stringify(generated.data));
  assert.equal(generated.data.revision, saved.data.revision);
  assert.equal(generated.data.exportPublication.state, 'pending');
  const published = await waitForPublication(server.origin, generated.data.projectSessionToken);
  assert.equal(published.exportPublication.state, 'current');
  const docs = await (await fetch(server.origin + '/api/concept-docs?projectSessionToken=' + encodeURIComponent(generated.data.projectSessionToken))).json();
  assert.deepEqual(docs.documents.map(item => item.id), [mechanicId]);
  const refreshed = await (await fetch(server.origin + '/api/document-export/settings?projectSessionToken=' + encodeURIComponent(saved.data.projectSessionToken))).json();
  assert.equal(refreshed.mechanics.find(item => item.id === mechanicId).selected, true);
});

test('导出设置被外部修改后，旧 revision 生成文档仍显式失败', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-document-export-conflict-'));
  const projectRoot = join(temp, 'project'); await copyExampleFixture(projectRoot);
  const server = await startServer({ projectRoot, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });

  const workspace = await (await fetch(server.origin + '/api/workspace')).json();
  const settings = await (await fetch(server.origin + '/api/document-export/settings?projectSessionToken=' + encodeURIComponent(workspace.projectSessionToken))).json();
  const first = await post(server.origin, '/api/document-export/settings', {
    projectSessionToken: workspace.projectSessionToken, projectGeneration: workspace.projectGeneration, revision: settings.revision,
    selections: [{ kind: 'mechanic', mechanicId: settings.mechanics[0].id }],
  });
  assert.equal(first.response.status, 200);
  const external = await post(server.origin, '/api/document-export/settings', {
    projectSessionToken: first.data.projectSessionToken, projectGeneration: first.data.projectGeneration, revision: first.data.revision,
    selections: [],
  });
  assert.equal(external.response.status, 200);

  const conflict = await post(server.origin, '/api/document-export/generate', {
    projectSessionToken: first.data.projectSessionToken, projectGeneration: first.data.projectGeneration, revision: first.data.revision,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.error, 'REVISION_CONFLICT');
});
test('机制文件夹只重分类 canonical 文件，不改变机制 ID 或视图成员，且只能删除空目录', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-mechanic-folders-'));
  const projectRoot = join(temp, 'project'); await copyExampleFixture(projectRoot);
  const server = await startServer({ projectRoot, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const before = await (await fetch(server.origin + '/api/workspace')).json();
  const mechanicId = before.mechanics[0].id, views = structuredClone(before.views);
  const create = await post(server.origin, '/api/mechanic-folders', { projectGeneration: before.projectGeneration, revision: before.revision, folder: '战斗' });
  assert.equal(create.response.status, 200);
  const moved = await post(server.origin, '/api/mechanic-move', { projectGeneration: create.data.projectGeneration, revision: create.data.revision, mechanicId, folder: '战斗' });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.data.files.find(file => file.id === mechanicId).path.startsWith('mechanics/战斗/'), true);
  assert.deepEqual(moved.data.views, views);
  const blocked = await post(server.origin, '/api/mechanic-folder-delete', { projectGeneration: moved.data.projectGeneration, revision: moved.data.revision, folder: '战斗' });
  assert.equal(blocked.response.status, 422); assert.equal(blocked.data.error, 'FOLDER_NOT_EMPTY');
  const renamed = await post(server.origin, '/api/mechanic-folder-move', { projectGeneration: moved.data.projectGeneration, revision: moved.data.revision, sourceFolder: '战斗', targetFolder: '规则/战斗' });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.data.files.find(file => file.id === mechanicId).path.startsWith('mechanics/规则/战斗/'), true);
  const restored = await post(server.origin, '/api/mechanic-move', { projectGeneration: renamed.data.projectGeneration, revision: renamed.data.revision, mechanicId, folder: '' });
  assert.equal(restored.response.status, 200);
  const deleted = await post(server.origin, '/api/mechanic-folder-delete', { projectGeneration: restored.data.projectGeneration, revision: restored.data.revision, folder: '规则/战斗' });
  assert.equal(deleted.response.status, 200);
  const deletedParent = await post(server.origin, '/api/mechanic-folder-delete', { projectGeneration: deleted.data.projectGeneration, revision: deleted.data.revision, folder: '规则' });
  assert.equal(deletedParent.response.status, 200);
  assert.deepEqual(deletedParent.data.views, views);
});

test('删除未被视图引用的机制会移除 canonical 文件；被引用时拒绝且不写入', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-mechanic-delete-'));
  const projectRoot = join(temp, 'project'); await copyExampleFixture(projectRoot);
  const server = await startServer({ projectRoot, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const initial = await (await fetch(server.origin + '/api/workspace')).json();
  const target = initial.mechanics[0];
  const path = initial.files.find(item => item.kind === 'mechanic' && item.id === target.id).path;
  const deleted = await post(server.origin, '/api/mechanic-delete', { projectGeneration: initial.projectGeneration, revision: initial.revision, mechanicId: target.id });
  assert.equal(deleted.response.status, 422, JSON.stringify(deleted.data)); assert.equal(deleted.data.error, 'MECHANIC_REFERENCED');
  await access(join(projectRoot, '.mechanics', path));
});

test('候选项目存在短事务写入锁时仍可打开并只读浏览', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-project-lock-'));
  const active = join(temp, 'active-project'), locked = join(temp, 'locked-project');
  await copyExampleFixture(active); await copyExampleFixture(locked);
  const release = await acquireWorkspaceLock(join(locked, '.mechanics'));
  const server = await startServer({ projectRoot: active, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await release(); await rm(temp, { recursive: true, force: true }); });
  const attempt = await openProject(server.origin, locked);
  assert.equal(attempt.response.status, 200);
  assert.equal(attempt.data.projectRoot, locked);
  const workspace = await (await fetch(server.origin + '/api/workspace')).json();
  const document = structuredClone(workspace.definitions);
  const blocked = await post(server.origin, '/api/save', {
    projectGeneration: workspace.projectGeneration, revision: workspace.revision, kind: 'definitions', document,
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.data.error, 'WORKSPACE_LOCKED');
});

test('切换项目不再尝试释放服务生命周期锁', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-project-release-'));
  const first = join(temp, 'first-project'), second = join(temp, 'second-project');
  await copyExampleFixture(first); await copyExampleFixture(second);
  const historyPath = join(temp, 'user', 'projects.json');
  const server = await startServer({ projectRoot: first, port: 0, projectHistoryPath: historyPath });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  await writeFile(join(first, '.mechanics/.mechanics.lock'), '{"owner":"tampered"}');
  const attempt = await openProject(server.origin, second);
  assert.equal(attempt.response.status, 200);
  const state = await (await fetch(server.origin + '/api/project')).json();
  assert.equal(state.projectRoot, second);
  assert.equal(state.projectGeneration, 2);
  assert.equal((await (await fetch(server.origin + '/api/workspace')).json()).projectRoot, second);
  const history = await (await fetch(server.origin + '/api/projects')).json();
  assert.equal(history.items[0].projectRoot, second);
});

test('项目设置同时更新显示名与导出路径，并在发布后同步最近项目', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-export-move-'));
  const projectRoot = join(temp, 'export-project'); await copyExampleFixture(projectRoot);
  const server = await startServer({ projectRoot, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });
  const workspace = await (await fetch(server.origin + '/api/workspace')).json();
  const moved = await post(server.origin, '/api/project/settings', {
    projectGeneration: workspace.projectGeneration, revision: workspace.revision, name: 'Tiny World', agentExportPath: 'docs/game-mechanics',
  });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.data.manifest.name, 'Tiny World');
  assert.equal(moved.data.manifest.agentExportPath, 'docs/game-mechanics');
  assert.match(await readFile(join(projectRoot, 'docs/game-mechanics/AGENTS.md'), 'utf8'), /禁止修改本目录/);
  assert.deepEqual((await readdir(join(projectRoot, 'docs/game-mechanics'))).sort(), ['AGENTS.md', 'README.md', 'concepts.md', 'mechanics']);
  await assert.rejects(access(join(projectRoot, 'game-mechanics')), { code: 'ENOENT' });
  const state = await (await fetch(server.origin + '/api/project')).json();
  assert.equal(state.agentExportRoot, join(projectRoot, 'docs/game-mechanics'));
  assert.equal((await (await fetch(server.origin + '/api/projects')).json()).items[0].name, 'Tiny World');

  await writeFile(join(projectRoot, 'docs/game-mechanics/user-notes.md'), '用户文件');
  const rejected = await post(server.origin, '/api/project/settings', {
    projectGeneration: moved.data.projectGeneration, revision: moved.data.revision, name: '不应生效', agentExportPath: 'next-game-mechanics',
  });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.data.error, 'EXPORT_ROOT_NOT_EMPTY');
  const retained = (await (await fetch(server.origin + '/api/workspace')).json()).manifest;
  assert.equal(retained.agentExportPath, 'docs/game-mechanics');
  assert.equal(retained.name, 'Tiny World');
});
