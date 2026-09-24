import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { acquireWorkspaceLock } from '../src/server/files.mjs';
import { copiedExampleProject, installWorkspaceTool, runWorkspaceTool as run, runWorkspaceToolFailure as reject } from './workspace-tool-harness.mjs';

const exec = promisify(execFile);
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const write = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const canonical = (root, path) => join(root, '.mechanics', path);
const open = root => run(root, ['draft', 'open', '--mechanic', 'basic-rules']);
const command = (action, draft) => ['draft', action, '--draft', draft.draftId];
async function edit(path, change) { const value = await read(path); change(value); await write(path, value); }
async function bytes(root) {
  const files = {};
  async function visit(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'tools') continue;
      const file = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(path, entry.name), file + '/');
      else if (entry.name.endsWith('.json')) files[file] = await readFile(join(path, entry.name), 'utf8');
    }
  }
  await visit(canonical(root, ''));
  return files;
}
async function assertBothReject(root, draft, code) {
  const before = await bytes(root);
  const drafts = await Promise.all([draft.definitionsPath, draft.rulesPath, draft.mechanicPath].map(path => readFile(path, 'utf8')));
  let failure;
  for (const action of ['validate', 'save']) {
    failure = await reject(root, command(action, draft));
    assert.equal(failure.error, code, JSON.stringify(failure));
    assert.deepEqual(await bytes(root), before);
    assert.deepEqual(await Promise.all([draft.definitionsPath, draft.rulesPath, draft.mechanicPath].map(path => readFile(path, 'utf8'))), drafts);
  }
  return failure;
}
const isa = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'specializes' });

test('已知 ID 直接 open 编辑 save，隔离单文件完成回读与 explicit 统计，歧义别名合法', async t => {
  const root = await copiedExampleProject(t), draft = await open(root);
  assert.equal(draft.contractVersion, 7);
  assert.match(draft.next, /draft save/);
  await edit(draft.definitionsPath, doc => { doc.nodes[0].aliases = ['共享别名']; doc.nodes[1].aliases = ['共享别名']; });
  await edit(draft.mechanicPath, doc => { doc.ruleSelection = 'explicit'; doc.focusNodeIds = ['armor']; doc.pinnedRuleIds = ['melee-2-damage']; });
  const result = await run(root, command('save', draft));
  assert.equal(result.saved, true); assert.equal(result.verified, true);
  assert.deepEqual(result.target, { mechanicId: 'basic-rules', file: 'mechanics/basic-rules.mechanic.json', created: false });
  assert.deepEqual(result.counts, { focusNodes: 1, rules: 1, projectedNodes: 3 });
  assert.equal(Object.hasOwn(result.counts, 'concreteObjects'), false);
  assert.equal((await read(canonical(root, 'mechanics/basic-rules.mechanic.json'))).ruleSelection, 'explicit');
  assert.equal((await run(root, ['search', '--query', '共享别名'])).resolution.status, 'ambiguous');
});

test('open 在任何草稿写入前拒绝 .agent-drafts junction/symlink', async t => {
  const root = await copiedExampleProject(t), external = join(root, 'external-drafts'), before = await bytes(root);
  await mkdir(external);
  await symlink(external, canonical(root, '.agent-drafts'), process.platform === 'win32' ? 'junction' : 'dir');
  const failure = await reject(root, ['draft', 'open', '--mechanic', 'basic-rules']);
  assert.equal(failure.error, 'UNSAFE_PATH');
  assert.deepEqual(await readdir(external), []);
  assert.deepEqual(await bytes(root), before);
});

test('旧草稿缺少入口基线时明确要求重新 open 而非手填', async t => {
  const root = await copiedExampleProject(t), draft = await open(root);
  await edit(join(draft.draftPath, 'draft.json'), doc => { delete doc.definitionsFile; delete doc.rulesFile; });
  const failure = await assertBothReject(root, draft, 'DRAFT_BASELINE_MISSING');
  assert.match(failure.message, /重新 draft open/);
});

test('默认邻接统计按一跳规则并集计算，不漏孤立焦点', async t => {
  const root = await copiedExampleProject(t), draft = await open(root);
  await edit(draft.mechanicPath, doc => { doc.focusNodeIds = ['armor', 'turn-start']; doc.pinnedRuleIds = ['melee-2-damage']; });
  const result = await run(root, command('save', draft));
  assert.deepEqual(result.counts, { focusNodes: 2, rules: 2, projectedNodes: 5 });
});

const invalidCases = [
  ['未知字段', 'DRAFT_VALIDATION_FAILED', draft => edit(draft.definitionsPath, doc => { doc.nodes[0].unknownField = true; })],
  ['缺字段', 'DRAFT_VALIDATION_FAILED', draft => edit(draft.definitionsPath, doc => { delete doc.nodes[0].agentLocked; })],
  ['非法 ID', 'DRAFT_VALIDATION_FAILED', draft => edit(draft.definitionsPath, doc => { doc.nodes[0].id = 'Bad_ID'; })],
  ['断端点', 'MISSING_REFERENCE', draft => edit(draft.rulesPath, doc => { doc.rules[0].source = 'absent-concept'; })],
  ['重复端点', 'DUPLICATE_ENDPOINT_RULE', draft => edit(draft.rulesPath, doc => { doc.rules.push({ ...doc.rules[0] }); })],
  ['is-a 多父', 'SPECIALIZES_MULTIPLE_PARENTS', draft => edit(draft.rulesPath, doc => { doc.rules.push(isa('damage', 'failure'), isa('damage', 'repel')); })],
  ['is-a 环', 'SPECIALIZES_CYCLE', draft => edit(draft.rulesPath, doc => { doc.rules.push(isa('damage', 'repel'), isa('repel', 'damage')); })],
  ['草稿几何', 'DRAFT_GEOMETRY_FORBIDDEN', draft => edit(draft.mechanicPath, doc => { doc.positions.damage = { x: 1, y: 1 }; })],
];
for (const [name, code, mutate] of invalidCases) test(name + ' 在 dry-run/save 同门禁拒绝，canonical 原字节与草稿保留', async t => {
  const root = await copiedExampleProject(t), draft = await open(root);
  await mutate(draft);
  const failure = await assertBothReject(root, draft, code);
  if (name === '未知字段') {
    assert.equal(failure.causeCode, 'INVALID_DOCUMENT');
    assert.ok(failure.details.issues.some(issue => issue.field === '/nodes/0/unknownField'));
  }
  if (name === '断端点') {
    assert.equal(failure.details.resource, 'rules.json');
    assert.equal(failure.details.id, 'absent-concept');
    assert.match(failure.details.field, /source/);
  }
});

for (const consumer of ['mechanic', 'view']) test('is-a 改父不自动清理其他 ' + consumer + ' 的固定引用，错误含路径字段和 ID', async t => {
  const root = await copiedExampleProject(t), old = isa('damage', 'failure');
  await edit(canonical(root, 'rules.json'), doc => { doc.rules.push(old); });
  const path = consumer === 'mechanic' ? 'outside/consumer.mechanic.json' : 'outside/hidden.view.json';
  await mkdir(canonical(root, 'outside'));
  const source = await read(canonical(root, 'mechanics/basic-rules.mechanic.json'));
  const document = consumer === 'mechanic'
    ? { ...source, id: 'consumer', ruleSelection: 'explicit', focusNodeIds: [], pinnedRuleIds: [old.id] }
    : { schemaVersion: 5, kind: 'view', workspaceId: source.workspaceId, id: 'hidden', name: '隐藏组合', mechanicRegistrations: [{ mechanicId: 'basic-rules', visible: false }], focusNodeIds: [], pinnedRuleIds: [old.id], positions: {}, collapsedNodeIds: [], structuralPresentation: 'line', taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } };
  await write(canonical(root, path), document);
  const draft = await open(root);
  const moved = await run(root, ['isa', 'set', '--draft', draft.draftId, '--concept', 'damage', '--parent', 'repel']);
  assert.match(moved.next, /draft save/);
  const failure = await assertBothReject(root, draft, 'MISSING_REFERENCE');
  assert.equal(failure.details.resource, path);
  assert.equal(failure.details.id, old.id);
  assert.match(failure.details.field, /pinnedRuleIds/);
});

test('manifest 自定义定义规则入口与 mechanics 外图可直接打开保存，点目录不在合法发现范围', async t => {
  const root = await copiedExampleProject(t);
  await mkdir(canonical(root, 'core')); await mkdir(canonical(root, 'outside')); await mkdir(canonical(root, '.ignored'));
  await rename(canonical(root, 'definitions.json'), canonical(root, 'core/concepts.json'));
  await rename(canonical(root, 'rules.json'), canonical(root, 'core/relations.json'));
  await rename(canonical(root, 'mechanics/basic-rules.mechanic.json'), canonical(root, 'outside/basic.mechanic.json'));
  await edit(canonical(root, 'workspace.json'), doc => { doc.definitions = 'core/concepts.json'; doc.rules = 'core/relations.json'; });
  await writeFile(canonical(root, '.ignored/broken.mechanic.json'), '不在发现范围');
  const draft = await open(root);
  await edit(draft.mechanicPath, doc => { doc.scope = '编辑外部合法目录的机制'; });
  const result = await run(root, command('save', draft));
  assert.equal(result.target.file, 'outside/basic.mechanic.json');
  assert.deepEqual(result.changedFiles, ['core/concepts.json', 'core/relations.json', 'outside/basic.mechanic.json']);
});

test('未编辑的发现资源格式损坏仍阻断候选，不能保存健康子集', async t => {
  const root = await copiedExampleProject(t), draft = await open(root);
  await mkdir(canonical(root, 'outside'));
  await write(canonical(root, 'outside/bad.mechanic.json'), { id: 'bad', kind: 'mechanic' });
  await assertBothReject(root, draft, 'INVALID_DOCUMENT');
});

test('展示 revision 变化不冲突并保留最新坐标，真实语义变化冲突', async t => {
  const root = await copiedExampleProject(t), draft = await open(root);
  await edit(canonical(root, 'definitions.json'), doc => { doc.positions.damage = { x: 99, y: 101 }; });
  await edit(canonical(root, 'mechanics/basic-rules.mechanic.json'), doc => { doc.positions.damage = { x: 222, y: 333 }; });
  await edit(canonical(root, 'workspace.json'), doc => { doc.lastView = { viewId: 'absent-view' }; });
  // 最近打开不参与基线，但其坏引用仍必须由完整候选拒绝。
  await assertBothReject(root, draft, 'MISSING_REFERENCE');
  await edit(canonical(root, 'workspace.json'), doc => { delete doc.lastView; });
  assert.equal((await run(root, command('save', draft))).saved, true);
  assert.deepEqual((await read(canonical(root, 'mechanics/basic-rules.mechanic.json'))).positions.damage, { x: 222, y: 333 });
  assert.deepEqual((await read(canonical(root, 'definitions.json'))).positions.damage, { x: 99, y: 101 });
  const stale = await open(root);
  await edit(canonical(root, 'rules.json'), doc => { doc.rules[0].ruleText = '外部规则修改'; });
  const failure = await assertBothReject(root, stale, 'RESOURCE_REVISION_CONFLICT');
  assert.equal(failure.resource, 'rules.json');
});

for (const operation of ['修改', '删除', '解锁', '新建上锁', '锁定未锁节点']) test('Agent 锁禁止' + operation, async t => {
  const root = await copiedExampleProject(t);
  await edit(canonical(root, 'definitions.json'), doc => { doc.nodes.find(node => node.id === 'armor').agentLocked = true; });
  const draft = await open(root);
  await edit(draft.definitionsPath, doc => {
    const locked = doc.nodes.find(node => node.id === 'armor');
    if (operation === '修改') locked.description += '改';
    if (operation === '删除') doc.nodes = doc.nodes.filter(node => node !== locked);
    if (operation === '解锁') locked.agentLocked = false;
    if (operation === '新建上锁') doc.nodes.push({ ...locked, id: 'fresh-locked' });
    if (operation === '锁定未锁节点') doc.nodes[0].agentLocked = true;
  });
  await assertBothReject(root, draft, ['新建上锁', '锁定未锁节点'].includes(operation) ? 'AGENT_LOCK_FORBIDDEN' : 'AGENT_CONCEPT_LOCKED');
});

for (const kind of ['identity', 'path']) test('草稿 ' + kind + ' 篡改不能改变保存目标', async t => {
  const root = await copiedExampleProject(t), draft = await open(root);
  if (kind === 'identity') await edit(draft.mechanicPath, doc => { doc.id = 'different-graph'; });
  else await edit(join(draft.draftPath, 'draft.json'), doc => { doc.targetFile = canonical(root, 'mechanics/hand.mechanic.json'); });
  await assertBothReject(root, draft, 'DRAFT_IDENTITY_MISMATCH');
});

test('编码后的大小限制属于 dry-run 而非提交时才发现', async t => {
  const root = await copiedExampleProject(t), draft = await open(root), definitions = await read(draft.definitionsPath);
  for (let index = 0; index < 1800; index++) definitions.nodes.push({ id: 'extra-' + index, label: 'x', description: 'x'.repeat(1060), agentLocked: false });
  const compact = JSON.stringify(definitions), pretty = JSON.stringify(definitions, null, 2);
  assert.ok(Buffer.byteLength(compact) < 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(pretty) > 2 * 1024 * 1024);
  await writeFile(draft.definitionsPath, compact);
  await assertBothReject(root, draft, 'FILE_LIMIT');
});

test('外部服务短事务锁阻止工具 validate/save，释放后直接保存', async t => {
  const root = await copiedExampleProject(t), draft = await open(root);
  const release = await acquireWorkspaceLock(canonical(root, ''));
  try { await assertBothReject(root, draft, 'WORKSPACE_LOCKED'); } finally { await release(); }
  assert.equal((await run(root, command('save', draft))).saved, true);
});

test('新图 export 清单基线属于 dry-run：curated 改 legacy 也拒绝', async t => {
  const root = await copiedExampleProject(t);
  await edit(canonical(root, 'workspace.json'), doc => { doc.exportSelections = [{ kind: 'mechanic', mechanicId: 'basic-rules' }]; });
  const draft = await run(root, ['draft', 'open', '--mechanic', 'new-graph', '--name', '新图', '--scope', '测试']);
  await edit(canonical(root, 'workspace.json'), doc => { delete doc.exportSelections; });
  await assertBothReject(root, draft, 'RESOURCE_REVISION_CONFLICT');
});

test('validate 零写入且不成为许可，后续保存仍重检草稿', async t => {
  const root = await copiedExampleProject(t), draft = await open(root), before = await bytes(root);
  const validated = await run(root, command('validate', draft));
  assert.equal(validated.dryRun, true); assert.equal(validated.valid, true);
  assert.deepEqual(await bytes(root), before);
  await edit(draft.mechanicPath, doc => { doc.pinnedRuleIds.push('absent-2-rule'); });
  await assertBothReject(root, draft, 'MISSING_REFERENCE');
});

for (const stage of ['backup', 'draft', 'lock']) test('已提交后的 ' + stage + ' 清理失败返回 saved 与定向 warning', async t => {
  const root = await copiedExampleProject(t), draft = await open(root);
  await edit(draft.mechanicPath, doc => { doc.scope = '事务已经确认'; });
  const preload = join(root, 'fault.mjs');
  await writeFile(preload, [
    "import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';",
    "const unlink = fs.unlink, rm = fs.rm; const fail = () => { throw Object.assign(new Error('注入收尾失败'), { code: 'EIO' }); };",
    stage === 'draft' ? "fs.rm = async (path, ...args) => String(path).includes('.agent-drafts') ? fail() : rm(path, ...args);"
      : "fs.unlink = async (path, ...args) => String(path).endsWith(" + JSON.stringify(stage === 'lock' ? '.mechanics.lock' : '.mechanics.bak') + ") ? fail() : unlink(path, ...args);",
    'syncBuiltinESMExports();',
  ].join('\n'));
  const tool = await installWorkspaceTool(root);
  const { stdout } = await exec(process.execPath, ['--import', pathToFileURL(preload).href, tool, ...command('save', draft)], { timeout: 15000 });
  const result = JSON.parse(stdout);
  assert.equal(result.saved, true); assert.equal(result.verified, true);
  assert.ok(result.warnings.length);
  assert.equal((await read(canonical(root, 'mechanics/basic-rules.mechanic.json'))).scope, '事务已经确认');
});
