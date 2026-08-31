import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir, rename, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspace } from '../src/server/workspace.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { initWorkspace, findWorkspace, migrateWorkspace } from '../src/server/workspace-commands.mjs';
import packageInfo from '../package.json' with { type: 'json' };

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
const cli = fileURLToPath(new URL('../src/server/cli.mjs', import.meta.url));
async function fixture(t, legacy = false) {
  const temp = await mkdtemp(join(tmpdir(), 'rule-workspace-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, '资料 目录'); await cp(example, root, { recursive: true });
  const workspace = await readWorkspace(root);
  if (legacy) {
    const manifest = { ...workspace.manifest, schemaVersion: 1, analyses: workspace.files.filter(file => file.kind === 'analysis').map(file => file.path), lastView: { graphIds: ['basic-rules', 'hand'], activeLayerId: 'hand', collapsedNodeIds: ['repel'], positions: {} } };
    await writeFile(join(root, 'workspace.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  return { temp, root, workspace };
}
function call(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 15000 });
  if (result.error) throw result.error;
  return result;
}
async function snapshot(root) {
  const result = {};
  for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (file.isFile()) { const path = join(file.parentPath, file.name); result[path] = await readFile(path, 'utf8'); }
  }
  return result;
}

test('CLI 在仓库外初始化，子目录定位同一根，显式目标优先且不覆盖已有目录', async t => {
  const { temp, root } = await fixture(t);
  const target = join(temp, '另一个 工作区');
  assert.equal(call(['--help'], temp).status, 0);
  assert.equal(call(['--version'], temp).stdout.trim(), packageInfo.version);
  const init = call(['init', target, '--name', '规则资料', '--id', 'another-game'], temp);
  assert.equal(init.status, 0, init.stderr);
  const filesBefore = await snapshot(target);
  assert.equal(call(['init', target], temp).status, 1);
  assert.deepEqual(await snapshot(target), filesBefore);
  const child = join(target, 'analyses');
  assert.equal(call(['root'], child).stdout.trim(), await realpath(target));
  assert.equal(call(['root', '--workspace', root], child).stdout.trim(), await realpath(root));
  const validated = call(['validate'], child);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).workspaceId, 'another-game');
  assert.equal(call(['validate', '--workspace', child], temp).status, 1);
  for (const args of [['serve', '--port', 'NaN'], ['validate', '--port', '2'], ['migrate'], ['unknown'], ['serve', 'extra']]) {
    assert.equal(call(args, child).status, 1, args.join(' '));
  }
  await assert.rejects(initWorkspace(join(target, 'nested')), { code: 'NESTED_WORKSPACE' });
});

test('最近的坏标记和未知版本明确失败，不跳到父根', async t => {
  const { root } = await fixture(t);
  const child = join(root, 'analyses');
  await writeFile(join(child, 'workspace.json'), '{bad');
  await assert.rejects(findWorkspace(child), { code: 'INVALID_JSON' });
  assert.match(call(['root'], child).stderr, /INVALID_JSON/);
  await writeFile(join(child, 'workspace.json'), JSON.stringify({ kind: 'workspace', schemaVersion: 999 }));
  assert.match(call(['validate'], child).stderr, /INVALID_DOCUMENT/);
  await assert.rejects(readWorkspace(root), { code: 'NESTED_WORKSPACE' });
});

test('目录扫描发现新增、移动和空目录；稳定 ID 恢复视图，旧版本保存拒绝', async t => {
  const { root, workspace } = await fixture(t);
  const store = await createWorkspaceStore(root);
  try {
    const manifest = { ...workspace.manifest, lastView: { graphIds: ['hand'], activeLayerId: 'hand', collapsedNodeIds: [], positions: {} } };
    const selected = await store.save({ revision: workspace.revision, kind: 'workspace', document: manifest });
    await mkdir(join(root, '关卡/空目录'), { recursive: true });
    await rename(join(root, 'analyses/hand.analysis.json'), join(root, '关卡/手牌.analysis.json'));
    await assert.rejects(store.save({ revision: selected.revision, kind: 'workspace', document: manifest }), { code: 'REVISION_CONFLICT' });
    const moved = await store.read();
    assert.equal(moved.files.find(file => file.id === 'hand').path, '关卡/手牌.analysis.json');
    assert.ok(moved.directories.includes('关卡/空目录'));
    assert.deepEqual(moved.manifest.lastView, manifest.lastView);
    const graph = { ...moved.analyses.find(graph => graph.id === 'hand'), id: 'external' };
    await writeFile(join(root, '关卡/外部.analysis.json'), JSON.stringify(graph));
    const fresh = await store.read(); assert.equal(fresh.analyses.length, 4);
    const hand = { ...fresh.analyses.find(graph => graph.id === 'hand'), name: '移动后保存' };
    await store.save({ revision: fresh.revision, kind: 'analysis', id: hand.id, document: hand });
    assert.equal(JSON.parse(await readFile(join(root, '关卡/手牌.analysis.json'), 'utf8')).name, hand.name);
    await assert.rejects(readFile(join(root, 'analyses/hand.analysis.json')), { code: 'ENOENT' });
    await rm(join(root, '关卡/手牌.analysis.json'));
    await assert.rejects(store.read(), { code: 'MISSING_REFERENCE' });
  } finally { await store.close(); }
});

test('扫描不吞掉坏文件、重复 ID；隐藏目录明确排除', async t => {
  const { root, workspace } = await fixture(t);
  await mkdir(join(root, '.draft')); await writeFile(join(root, '.draft/bad.analysis.json'), '{bad');
  assert.equal((await readWorkspace(root)).analyses.length, 3);
  const extra = join(root, 'bad.analysis.json'); await writeFile(extra, '{bad');
  await assert.rejects(readWorkspace(root), { code: 'INVALID_JSON' });
  await writeFile(extra, JSON.stringify(workspace.analyses[0]));
  await assert.rejects(readWorkspace(root), { code: 'DUPLICATE_ID' });
  await rm(extra);
  assert.equal((await readWorkspace(root)).revision, workspace.revision);
});

test('旧工作区须显式迁移；预检无写入，迁移仅改配置并保留原字节备份和视图', async t => {
  const { root } = await fixture(t, true);
  const before = await snapshot(root), original = before[join(root, 'workspace.json')];
  await assert.rejects(readWorkspace(root), { code: 'WORKSPACE_UPGRADE_REQUIRED' });
  const preview = await migrateWorkspace(root, { dryRun: true }); assert.equal(preview.status, 'ready');
  assert.deepEqual(await snapshot(root), before);
  const result = await migrateWorkspace(root); assert.equal(result.status, 'migrated');
  assert.equal(await readFile(join(root, result.backup), 'utf8'), original);
  for (const [path, raw] of Object.entries(before)) if (!path.endsWith('workspace.json')) assert.equal(await readFile(path, 'utf8'), raw);
  assert.deepEqual((await readWorkspace(root)).manifest.lastView, JSON.parse(original).lastView);
  const migrated = await snapshot(root);
  assert.equal((await migrateWorkspace(root)).status, 'already-current');
  assert.deepEqual(await snapshot(root), migrated);
});

test('迁移拒绝未登记图，列出差异且不修改任何源文件', async t => {
  const { root, workspace } = await fixture(t, true);
  await writeFile(join(root, 'draft.analysis.json'), JSON.stringify({ ...workspace.analyses[0], id: 'historical-draft' }));
  const before = await snapshot(root), preview = await migrateWorkspace(root, { dryRun: true });
  assert.equal(preview.status, 'blocked'); assert.deepEqual(preview.additional, ['draft.analysis.json']);
  const cliPreview = call(['migrate', '--workspace', root, '--dry-run'], root);
  assert.equal(cliPreview.status, 1); assert.equal(JSON.parse(cliPreview.stdout).status, 'blocked');
  await assert.rejects(migrateWorkspace(root), { code: 'MIGRATION_FILE_SET_CHANGED' });
  assert.deepEqual(await snapshot(root), before);
});

test('迁移拒绝已有锁、备份冲突和旧集合无效引用', async t => {
  const { root } = await fixture(t, true);
  const path = join(root, 'workspace.json'), before = await readFile(path, 'utf8');
  await writeFile(join(root, '.rule-analyzer.lock'), '其他写入者');
  await assert.rejects(migrateWorkspace(root), { code: 'WORKSPACE_LOCKED' });
  await rm(join(root, '.rule-analyzer.lock'));
  await writeFile(join(root, 'workspace.v1.backup.json'), '{}');
  await assert.rejects(migrateWorkspace(root), { code: 'BACKUP_CONFLICT' });
  assert.equal(await readFile(path, 'utf8'), before);
  await rm(join(root, 'workspace.v1.backup.json'));
  const invalid = JSON.parse(before); invalid.lastView.activeLayerId = 'missing';
  await writeFile(path, JSON.stringify(invalid));
  await assert.rejects(migrateWorkspace(root), { code: 'MISSING_REFERENCE' });
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(invalid));
  await assert.rejects(readFile(join(root, 'workspace.v1.backup.json')), { code: 'ENOENT' });
});
