import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir, rename, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspace } from '../src/server/workspace.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { initWorkspace, findWorkspace } from '../src/server/workspace-commands.mjs';
import packageInfo from '../package.json' with { type: 'json' };

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
const cli = fileURLToPath(new URL('../src/server/cli.mjs', import.meta.url));
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'rule-workspace-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, '资料 目录'); await cp(example, root, { recursive: true });
  const workspace = await readWorkspace(root);
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
  const child = join(target, 'mechanics');
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
  const child = join(root, 'mechanics');
  await writeFile(join(child, 'workspace.json'), '{bad');
  await assert.rejects(findWorkspace(child), { code: 'INVALID_JSON' });
  assert.match(call(['root'], child).stderr, /INVALID_JSON/);
  await writeFile(join(child, 'workspace.json'), JSON.stringify({ kind: 'workspace', schemaVersion: 999 }));
  assert.match(call(['validate'], child).stderr, /WORKSPACE_VERSION_UNSUPPORTED/);
  await assert.rejects(readWorkspace(root), { code: 'NESTED_WORKSPACE' });
});

test('目录扫描发现新增、移动和空目录；稳定 ID 恢复视图，旧版本保存拒绝', async t => {
  const { root, workspace } = await fixture(t);
  const store = await createWorkspaceStore(root);
  try {
    const manifest = { ...workspace.manifest, lastView: { graphIds: ['hand'], activeLayerId: 'hand', collapsedNodeIds: [], positions: {} } };
    const selected = await store.save({ revision: workspace.revision, kind: 'workspace', document: manifest });
    await mkdir(join(root, '关卡/空目录'), { recursive: true });
    await rename(join(root, 'mechanics/hand.mechanic.json'), join(root, '关卡/手牌.mechanic.json'));
    await assert.rejects(store.save({ revision: selected.revision, kind: 'workspace', document: manifest }), { code: 'REVISION_CONFLICT' });
    const moved = await store.read();
    assert.equal(moved.files.find(file => file.id === 'hand').path, '关卡/手牌.mechanic.json');
    assert.ok(moved.directories.includes('关卡/空目录'));
    assert.deepEqual(moved.manifest.lastView, manifest.lastView);
    const graph = { ...moved.mechanics.find(graph => graph.id === 'hand'), id: 'external' };
    await writeFile(join(root, '关卡/外部.mechanic.json'), JSON.stringify(graph));
    const fresh = await store.read(); assert.equal(fresh.mechanics.length, 4);
    const hand = { ...fresh.mechanics.find(graph => graph.id === 'hand'), name: '移动后保存' };
    await store.save({ revision: fresh.revision, kind: 'mechanic', id: hand.id, document: hand });
    assert.equal(JSON.parse(await readFile(join(root, '关卡/手牌.mechanic.json'), 'utf8')).name, hand.name);
    await assert.rejects(readFile(join(root, 'mechanics/hand.mechanic.json')), { code: 'ENOENT' });
    await rm(join(root, '关卡/手牌.mechanic.json'));
    await assert.rejects(store.read(), { code: 'MISSING_REFERENCE' });
  } finally { await store.close(); }
});

test('扫描不吞掉坏文件、重复 ID；隐藏目录明确排除', async t => {
  const { root, workspace } = await fixture(t);
  await mkdir(join(root, '.draft')); await writeFile(join(root, '.draft/bad.mechanic.json'), '{bad');
  assert.equal((await readWorkspace(root)).mechanics.length, 3);
  const extra = join(root, 'bad.mechanic.json'); await writeFile(extra, '{bad');
  await assert.rejects(readWorkspace(root), { code: 'INVALID_JSON' });
  await writeFile(extra, JSON.stringify(workspace.mechanics[0]));
  await assert.rejects(readWorkspace(root), { code: 'DUPLICATE_ID' });
  await rm(extra);
  assert.equal((await readWorkspace(root)).revision, workspace.revision);
});

test('旧版工作区明确拒绝且 CLI 不提供迁移入口', async t => {
  const { root } = await fixture(t);
  const path = join(root, 'workspace.json'), current = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...current, schemaVersion: 3 }));
  await assert.rejects(readWorkspace(root), { code: 'WORKSPACE_VERSION_UNSUPPORTED' });
  const result = call(['migrate', '--workspace', root], root);
  assert.equal(result.status, 1); assert.match(result.stderr, /命令或参数数量无效/);
});
