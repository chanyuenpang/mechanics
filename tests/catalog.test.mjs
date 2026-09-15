import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, catalogSemanticRevision, publishCatalog, removeCatalog } from '../src/server/catalog.mjs';
import { readCatalogBrowser } from '../src/server/catalog-browser.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { validateWorkspace } from '../src/domain/validate.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
const exampleWorkspace = join(example, '.mechanics');

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-catalog-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const projectRoot = join(temp, 'workspace'); await copyExampleFixture(projectRoot);
  const root = join(projectRoot, '.mechanics'), exportRoot = join(projectRoot, 'mechanics');
  await rm(exportRoot, { recursive: true, force: true }); await mkdir(exportRoot);
  return { temp, projectRoot, root, exportRoot, workspace: await readWorkspace(root) };
}

test('机制文档共享单一词典，且词典只保留已导出规则涉及的概念', async () => {
  const workspace = await readWorkspace(exampleWorkspace);
  workspace.definitions.nodes.find(node => node.id === 'health').aliases = ['生命', 'hit points'];
  workspace.definitions.nodes.push({ id: 'unused', label: '未引用概念', description: '保留全局定义', aliases: [], tagIds: [], agentLocked: false });
  const mechanics = workspace.files.filter(file => file.kind === 'mechanic');
  mechanics[0].path = '机制/基础/first.mechanic.json';
  mechanics[1].path = '机制/基础/second.mechanic.json';
  mechanics[2].path = '机制/基础/子目录/third.mechanic.json';
  const before = structuredClone(workspace), catalog = buildCatalog(workspace);
  assert.deepEqual(workspace, before);
  assert.equal([...catalog.files.keys()].some(file => file.startsWith('concepts/')), false);
  for (const file of mechanics.slice(0, 2)) assert.ok(catalog.files.has(`mechanics/${file.id}.md`));
  assert.ok(catalog.files.has(`mechanics/${mechanics[2].id}.md`));
  assert.doesNotMatch(catalog.files.get('concepts.md'), /未引用概念/);
  assert.match(catalog.files.get('concepts.md'), /hit points/);
  assert.equal([...catalog.files.values()].join('\n').includes('positions'), false);
  assert.equal([...catalog.files.values()].join('\n').includes('agentLocked'), false);
  assert.equal([...catalog.files.keys()].some(file => file.endsWith('.json')), false);
  for (const [file, markdown] of catalog.files) {
    for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      const [urlPath] = match[1].split('#');
      const target = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(urlPath)));
      assert.ok(catalog.files.has(target), `${file} 的链接目标不存在：${target}`);
    }
  }
  assert.doesNotMatch([...catalog.files.values()].join('\n'), /<a id=/);
});

test('规则只在所属机制文档声明一次，并只导出可读的端点、范围与规则文本', async () => {
  const workspace = await readWorkspace(exampleWorkspace);
  const mechanic = workspace.mechanics[0], edge = workspace.rules.rules.find(rule => mechanic.pinnedRuleIds.includes(rule.id));
  edge.sign = 'random'; edge.ruleText = '唯一规则文字 <script>\n下一行';
  workspace.definitions.nodes.find(node => node.id === edge.source).customData = 'refs: https://example.invalid/concept';
  edge.customData = 'refs: https://example.invalid/rule';
  edge.sourceQualifiers = [{ key: '阵营', value: { kind: 'literal', value: '我方' } }];
  edge.targetQualifiers = [{ key: '类别', value: { kind: 'concept', conceptId: 'health' } }];
  edge.inheritance = { mode: 'specializeEndpoint', endpoints: ['source'], maxSpecializationHops: 2 };
  const catalog = buildCatalog(workspace), content = [...catalog.files.values()].join('\n');
  const mechanicFile = [...catalog.files.keys()].find(file => file.endsWith(`${mechanic.id}.md`));
  const mechanicDocument = catalog.files.get(mechanicFile);
  assert.equal(content.match(/唯一规则文字/g).length, 1);
  assert.match(mechanicDocument, /回合开始（阵营="我方"） → 抽牌（类别=health）：唯一规则文字/);
  assert.match(content, /&lt;script/); assert.doesNotMatch(content, /<script>/);
  assert.doesNotMatch(content, new RegExp(`${mechanic.id}/${edge.id}`));
  assert.doesNotMatch(content, /规则 ID|specializeEndpoint|maxSpecializationHops|来源参与者限定/);
  assert.doesNotMatch(content, /example\.invalid/);
  edge.relation = 'specializes'; delete edge.sign; delete edge.inheritance; edge.ruleText = '不应写入分类导出';
  const specialized = buildCatalog(workspace).files.get(mechanicFile);
  const labels = new Map(workspace.definitions.nodes.map(node => [node.id, node.label]));
  assert.match(specialized, new RegExp(`${labels.get(edge.source)} 属于 ${labels.get(edge.target)}`)); assert.doesNotMatch(specialized, /唯一规则文字|不应写入分类导出/);
  assert.doesNotMatch(catalog.files.get('concepts.md'), /唯一规则文字/);
});

test('导出清单将文件夹聚合为一篇，单机制图保持独立且不递归', async () => {
  const workspace = await readWorkspace(exampleWorkspace);
  const [first, second, third] = workspace.files.filter(file => file.kind === 'mechanic');
  first.path = 'mechanics/cards/first.mechanic.json'; second.path = 'mechanics/cards/second.mechanic.json';
  third.path = 'mechanics/cards/sub/third.mechanic.json';
  workspace.manifest.exportSelections = [{ kind: 'folder', folder: 'cards' }, { kind: 'mechanic', mechanicId: third.id }];
  const catalog = buildCatalog(workspace);
  assert.doesNotMatch(catalog.files.get('concepts.md'), /概念定义：/);
  assert.ok(catalog.files.has('folders/cards.md'));
  assert.match(catalog.files.get('folders/cards.md'), /基础规则/);
  assert.match(catalog.files.get('folders/cards.md'), /近战遭遇/);
  assert.doesNotMatch(catalog.files.get('folders/cards.md'), /防御手牌/);
  assert.ok(catalog.files.has(`mechanics/${third.id}.md`));
  assert.equal(catalog.files.has(`mechanics/${first.id}.md`), false);
  assert.equal(catalog.files.has(`mechanics/${second.id}.md`), false);
  workspace.manifest.exportSelections = [{ kind: 'folder', folder: 'cards' }, { kind: 'mechanic', mechanicId: first.id }];
  assert.throws(() => validateWorkspace(workspace), { code: 'DOCUMENT_EXPORT_CONFLICT' });
});

test('新建机制图默认进入单独导出；文件夹已覆盖时不重复，视图不进清单', async t => {
  const { root, workspace } = await fixture(t);
  const store = await createWorkspaceStore(root);
  const document = id => ({ schemaVersion: 7, kind: 'mechanic', workspaceId: workspace.manifest.id, id, name: '新建机制',
    scope: '验收新建默认导出。', focusNodeIds: [], pinnedRuleIds: [], positions: {} });
  try {
    const existing = workspace.mechanics[0];
    const seeded = await store.setDocumentExport({ revision: workspace.revision, selections: [{ kind: 'mechanic', mechanicId: existing.id }] });
    // 新建一张不在已选文件夹里的机制图：默认补一条单独选择，且不引入视图选择。
    const created = await store.createMechanic({ revision: seeded.revision, document: document('fresh-graph'), file: 'mechanics/fresh-graph.mechanic.json' });
    assert.ok(created.manifest.exportSelections.some(item => item.kind === 'mechanic' && item.mechanicId === 'fresh-graph'));
    assert.equal(created.manifest.exportSelections.some(item => item.kind === 'view'), false);
    // 先建一张落在 cards 里的机制图，再把导出范围收敛为文件夹选择。
    const inFolder = await store.createMechanic({ revision: created.revision, document: document('cards-fresh'), file: 'mechanics/cards/cards-fresh.mechanic.json' });
    const folder = await store.setDocumentExport({ revision: inFolder.revision, selections: [{ kind: 'folder', folder: 'cards' }] });
    // 文件夹已覆盖其直接机制图：新建不再补单独选择，否则会触发 DOCUMENT_EXPORT_CONFLICT。
    const nested = await store.createMechanic({ revision: folder.revision, document: document('cards-second'), file: 'mechanics/cards/cards-second.mechanic.json' });
    assert.deepEqual(nested.manifest.exportSelections, [{ kind: 'folder', folder: 'cards' }]);
    // 删除与新建对称：单独选择必须一起移除，否则留下悬空引用让整个工作区校验失败。
    const isolated = await store.createMechanic({ revision: nested.revision, document: document('isolated-graph'), file: 'mechanics/isolated-graph.mechanic.json' });
    assert.ok(isolated.manifest.exportSelections.some(item => item.mechanicId === 'isolated-graph'));
    const removed = await store.deleteMechanic({ revision: isolated.revision, mechanicId: 'isolated-graph' });
    assert.equal(removed.manifest.exportSelections.some(item => item.mechanicId === 'isolated-graph'), false);
    assert.deepEqual(removed.manifest.exportSelections, [{ kind: 'folder', folder: 'cards' }]);
    assert.doesNotThrow(() => validateWorkspace(removed));
  } finally { await store.close(); }
});

test('保存导出清单在后台生成文档，显式生成只复用当前 canonical 范围', async t => {
  const { root, exportRoot, workspace } = await fixture(t);
  const store = await createWorkspaceStore(root);
  try {
    const mechanic = workspace.mechanics[0];
    const saved = await store.setDocumentExport({ revision: workspace.revision, selections: [{ kind: 'mechanic', mechanicId: mechanic.id }] });
    assert.deepEqual(saved.manifest.exportSelections, [{ kind: 'mechanic', mechanicId: mechanic.id }]);
    const generated = await store.generateDocumentExport({ revision: saved.revision });
    assert.equal(generated.revision, saved.revision);
    assert.ok(['pending', 'current'].includes(generated.exportPublication.state));
    const structure = await store.documentExportStructure();
    assert.equal(structure.revision, saved.revision);
    assert.equal(structure.mechanics.find(item => item.id === mechanic.id).selected, true);
    await assert.rejects(store.setDocumentExport({ revision: workspace.revision, selections: [] }), { code: 'REVISION_CONFLICT' });
    await store.close();
    assert.match(await readFile(join(exportRoot, `mechanics/${mechanic.id}.md`), 'utf8'), /→/);
    await assert.rejects(access(join(exportRoot, `mechanics/${workspace.mechanics[1].id}.md`)), { code: 'ENOENT' });
  } finally { await store.close(); }
});

test('文档版本涵盖名称、scope 与路径，语义版本忽略分类，几何和视图不改变文档', async () => {
  const workspace = await readWorkspace(exampleWorkspace), before = buildCatalog(workspace), moved = structuredClone(workspace);
  moved.definitions.positions.health = { x: 999, y: 888 };
  moved.definitions.nodes[0].agentLocked = !moved.definitions.nodes[0].agentLocked;
  moved.mechanics[0].positions.health = { x: -999, y: -888 };
  moved.views = structuredClone(workspace.views);
  assert.equal(catalogSemanticRevision(moved), before.semanticRevision);
  assert.deepEqual(buildCatalog(moved).files, before.files);
  assert.equal(buildCatalog(moved).documentRevision, before.documentRevision);
  moved.mechanics[0].name = '新的机制名称'; moved.mechanics[0].scope = '新的范围';
  moved.files.find(file => file.kind === 'mechanic').path = '新分类/moved.mechanic.json';
  const after = buildCatalog(moved);
  assert.equal(after.semanticRevision, before.semanticRevision);
  assert.notEqual(after.documentRevision, before.documentRevision);
  assert.match(after.files.get(`mechanics/${moved.mechanics[0].id}.md`), /新的机制名称/);
  assert.match(after.files.get(`mechanics/${moved.mechanics[0].id}.md`), /新的范围/);
  moved.rules.rules[0].ruleText += '（已修改）';
  assert.notEqual(buildCatalog(moved).semanticRevision, before.semanticRevision);
});

test('未标记的旧文档拒绝普通发布；当前词典随 canonical 保存刷新', async t => {
  const { root, exportRoot, workspace } = await fixture(t);
  await rm(exportRoot, { recursive: true, force: true }); await mkdir(join(exportRoot, 'concepts'), { recursive: true });
  await writeFile(join(exportRoot, 'AGENTS.md'), '# Mechanics Agent 文档使用规则\n');
  await writeFile(join(exportRoot, 'README.md'), '旧索引'); await writeFile(join(exportRoot, 'concepts/health.md'), '旧概念');
  await assert.rejects(publishCatalog(exportRoot, workspace), { code: 'EXPORT_ROOT_NOT_OWNED' });
  await rm(exportRoot, { recursive: true, force: true }); await mkdir(exportRoot, { recursive: true });
  await publishCatalog(exportRoot, workspace);
  assert.deepEqual((await readdir(exportRoot)).sort(), ['AGENTS.md', 'README.md', 'concepts.md', 'mechanics']);
  await assert.rejects(access(join(exportRoot, 'concepts')), { code: 'ENOENT' });
  const context = { exportRoot };
  const concept = await readCatalogBrowser(context, workspace, 'health');
  assert.equal(concept.document.file, 'concepts.md'); assert.equal(concept.document.anchor, undefined);
  const mechanic = workspace.mechanics[0];
  const folder = await readCatalogBrowser(context, workspace, { file: `mechanics/${mechanic.id}.md` });
  assert.equal(folder.document.kind, 'mechanic'); assert.ok(folder.documents.some(item => item.id === mechanic.id));
  const store = await createWorkspaceStore(root);
  try {
    const definitions = structuredClone(workspace.definitions);
    definitions.nodes.find(node => node.id === 'health').label = '生命值';
    await store.save({ revision: workspace.revision, kind: 'definitions', document: definitions });
    await store.close();
    assert.match(await readFile(join(exportRoot, 'concepts.md'), 'utf8'), /生命值/);
  } finally { await store.close(); }
  const current = await readWorkspace(root);
  await writeFile(join(exportRoot, 'concepts.md'), '手工篡改');
  await assert.rejects(readCatalogBrowser(context, current), { code: 'CATALOG_STALE' });
  await publishCatalog(exportRoot, current);
  await readCatalogBrowser(context, current);
  await assert.rejects(readCatalogBrowser(context, current, { file: '../outside.md' }), { code: 'DOCUMENT_NOT_FOUND' });
  await assert.rejects(readCatalogBrowser(context, current, 'unknown-concept'), { code: 'CONCEPT_NOT_FOUND' });
});

test('重新分类清理旧文件夹页面，导出目录删除只删除受管文件', async t => {
  const { exportRoot, workspace } = await fixture(t);
  await publishCatalog(exportRoot, workspace);
  for (const file of workspace.files.filter(file => file.kind === 'mechanic')) file.path = `新目录/子目录/${file.id}.mechanic.json`;
  workspace.manifest.exportSelections = [{ kind: 'folder', folder: '新目录/子目录' }];
  await publishCatalog(exportRoot, workspace);
  await assert.rejects(access(join(exportRoot, 'mechanics')), { code: 'ENOENT' });
  assert.match(await readFile(join(exportRoot, 'folders/新目录/子目录.md'), 'utf8'), /子目录/);
  await readCatalogBrowser({ exportRoot }, workspace);
  await removeCatalog(exportRoot, workspace.manifest.id);
  await assert.rejects(access(exportRoot), { code: 'ENOENT' });
});

test('未知根文件、文件夹内容或其他工作区所有权在写入清理前拒绝', async t => {
  const { exportRoot, workspace } = await fixture(t);
  await publishCatalog(exportRoot, workspace);
  const original = await readFile(join(exportRoot, 'concepts.md'), 'utf8');
  workspace.definitions.nodes[0].label = '尚未发布';
  await writeFile(join(exportRoot, 'manual.md'), '用户文件');
  await assert.rejects(publishCatalog(exportRoot, workspace), { code: 'EXPORT_ROOT_NOT_EMPTY' });
  await assert.rejects(removeCatalog(exportRoot, workspace.manifest.id), { code: 'EXPORT_ROOT_NOT_EMPTY' });
  assert.equal(await readFile(join(exportRoot, 'concepts.md'), 'utf8'), original);
  await rm(join(exportRoot, 'manual.md'));
  await mkdir(join(exportRoot, 'mechanics/用户资料')); await writeFile(join(exportRoot, 'mechanics/用户资料/index.md'), '用户自己的页面');
  await assert.rejects(publishCatalog(exportRoot, workspace), { code: 'EXPORT_ROOT_NOT_EMPTY' });
  await assert.rejects(readCatalogBrowser({ exportRoot }, workspace), { code: 'CATALOG_STALE' });
  await rm(join(exportRoot, 'mechanics/用户资料'), { recursive: true });
  await assert.rejects(removeCatalog(exportRoot, 'other-workspace'), { code: 'EXPORT_ROOT_NOT_OWNED' });
});

test('生成目录中的链接不能借发布、浏览或删除访问外部文件', async t => {
  const { temp, exportRoot, workspace } = await fixture(t);
  await publishCatalog(exportRoot, workspace);
  const outside = join(temp, 'outside'); await mkdir(outside); await writeFile(join(outside, 'index.md'), '外部资料');
  try { await symlink(outside, join(exportRoot, 'mechanics/linked'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('当前平台不允许创建链接'); return; } throw error; }
  await assert.rejects(publishCatalog(exportRoot, workspace), { code: 'UNSAFE_PATH' });
  await assert.rejects(removeCatalog(exportRoot, workspace.manifest.id), { code: 'UNSAFE_PATH' });
  await assert.rejects(readCatalogBrowser({ exportRoot }, workspace), { code: 'CATALOG_STALE' });
  assert.equal(await readFile(join(outside, 'index.md'), 'utf8'), '外部资料');
});
