import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitFiles, acquireWorkspaceLock, encode } from '../src/server/files.mjs';

// 仅测试进程替换内置导出；每例使用真实隔离目录，不给生产代码注入故障接口。
const original = { ...fs };
const ioError = label => Object.assign(new Error('注入故障：' + label), { code: 'EIO' });
function patch(t, name, implementation) {
  t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
}
async function fixture(t) {
  const root = await original.mkdtemp(join(tmpdir(), 'mechanics-files-transaction-'));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await original.rm(root, { recursive: true, force: true });
  });
  const before = { 'a.json': encode({ id: 'a', value: '旧甲' }), 'b.json': encode({ id: 'b', value: '旧乙' }), 'deleted.json': encode({ id: 'deleted' }) };
  for (const [path, text] of Object.entries(before)) await original.writeFile(join(root, path), text);
  const changes = [
    { path: 'a.json', document: { id: 'a', value: '新甲' } },
    { path: 'b.json', document: { id: 'b', value: '新乙' } },
    { path: 'deleted.json', delete: true },
    { path: 'created.json', document: { id: 'created', value: '新建' }, create: true },
  ];
  return { root, before, changes };
}
async function assertOriginal({ root, before }) {
  assert.deepEqual((await original.readdir(root)).sort(), Object.keys(before).sort());
  for (const [path, text] of Object.entries(before)) assert.equal(await original.readFile(join(root, path), 'utf8'), text);
}
async function assertCommitted({ root, changes }) {
  for (const change of changes) {
    const path = join(root, change.path);
    if (change.delete) await assert.rejects(original.stat(path), { code: 'ENOENT' });
    else assert.equal(await original.readFile(path, 'utf8'), encode(change.document));
  }
}
async function rejected(promise, code = 'MIGRATION_WRITE_FAILED') {
  let result;
  await assert.rejects(promise, error => {
    assert.equal(error.name, 'ContractError');
    assert.equal(error.code, code);
    if (['MIGRATION_WRITE_FAILED', 'SAVE_CLEANUP_FAILED'].includes(code)) {
      for (const [key, value] of Object.entries(error.details)) assert.deepEqual(error[key], value);
      assert.equal(error.commitState, error.committed ? 'committed' : error.rollbackComplete ? 'rolled-back' : 'uncertain');
    }
    result = error;
    return true;
  });
  return result;
}
function assertRolledBack(error) {
  assert.equal(error.committed, false);
  assert.equal(error.rollbackComplete, true);
  assert.deepEqual(error.recovery, []);
  assert.deepEqual(error.rollbackErrors, []);
}

test('批量新增、修改、删除和异步 verify 保持成功返回合同', async t => {
  const f = await fixture(t);
  let verified = false;
  const result = await commitFiles(f.root, f.changes, { verify: async () => {
    await assertCommitted(f);
    verified = true;
  } });
  assert.equal(result, undefined);
  assert.equal(verified, true);
  assert.deepEqual((await original.readdir(f.root)).sort(), ['a.json', 'b.json', 'created.json']);
  await assertCommitted(f);
});

for (const stage of ['writeFile', 'sync', 'open']) {
  test('准备阶段 ' + stage + ' 失败清理已写及半写临时文件', async t => {
    const f = await fixture(t);
    let count = 0;
    patch(t, 'open', async (...args) => {
      const selected = ++count === 2;
      if (selected && stage === 'open') throw ioError(stage);
      const handle = await original.open(...args);
      if (selected) {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, stage, async () => {
          if (stage === 'writeFile') await write('半写内容');
          throw ioError(stage);
        });
      }
      return handle;
    });
    assertRolledBack(await rejected(commitFiles(f.root, f.changes)));
    await assertOriginal(f);
  });
}

for (let position = 1; position <= 5; position++) {
  test('第 ' + position + ' 次备份或发布 rename 失败，独立恢复全部文件', async t => {
    const f = await fixture(t);
    let count = 0;
    patch(t, 'rename', async (...args) => {
      if (++count === position) throw ioError('rename');
      return original.rename(...args);
    });
    assertRolledBack(await rejected(commitFiles(f.root, f.changes)));
    await assertOriginal(f);
  });
}

test('创建 link 失败回滚之前的替换和删除', async t => {
  const f = await fixture(t);
  patch(t, 'link', async () => { throw ioError('link'); });
  assertRolledBack(await rejected(commitFiles(f.root, f.changes)));
  await assertOriginal(f);
});

test('新建目标在准备之后出现，硬链接原子拒绝覆盖且保留外部文件', async t => {
  const f = await fixture(t);
  const external = '外部文件不能覆盖';
  patch(t, 'link', async (from, to) => {
    await original.writeFile(to, external);
    return original.link(from, to);
  });
  const error = await rejected(commitFiles(f.root, f.changes));
  assertRolledBack(error);
  assert.equal(error.cause.code, 'EEXIST');
  assert.equal(await original.readFile(join(f.root, 'created.json'), 'utf8'), external);
  await original.unlink(join(f.root, 'created.json'));
  await assertOriginal(f);
});

for (const stage of ['readFile', 'mismatch', 'verify']) {
  test(stage + ' 失败完整回滚，回读比较完整内容而不只是 ID', async t => {
    const f = await fixture(t);
    let verifyCalled = false;
    if (stage !== 'verify') patch(t, 'readFile', async (path, ...args) => {
      if (path === join(f.root, 'b.json')) {
        if (stage === 'readFile') throw ioError('readFile');
        return encode({ id: 'b', value: '不是本次提交的内容' });
      }
      return original.readFile(path, ...args);
    });
    const error = await rejected(commitFiles(f.root, f.changes, { verify: async () => {
      verifyCalled = true;
      await assertCommitted(f);
      throw ioError('verify');
    } }));
    assertRolledBack(error);
    assert.equal(verifyCalled, stage === 'verify');
    await assertOriginal(f);
  });
}

for (const target of ['a.json.', 'b.json.', 'created.json.']) {
  test('确认后清理 ' + target + ' 失败明确已提交，继续清理其他项但绝不回滚', async t => {
    const f = await fixture(t);
    let verified = false;
    patch(t, 'unlink', async path => {
      assert.equal(verified, true, '清理必须发生在完整 verify 之后');
      if (path.startsWith(join(f.root, target))) throw ioError('cleanup');
      return original.unlink(path);
    });
    const error = await rejected(commitFiles(f.root, f.changes, { verify: async () => { verified = true; } }), 'SAVE_CLEANUP_FAILED');
    assert.equal(error.committed, true);
    assert.equal(error.remainingPaths.length, 1);
    assert.equal(error.cleanupErrors[0].path, error.remainingPaths[0]);
    assert.equal(error.cleanupErrors[0].code, 'EIO');
    assert.ok(error.message.includes(error.remainingPaths[0]));
    await assertCommitted(f);
    const remnants = (await original.readdir(f.root)).filter(path => /mechanics\.(bak|tmp)$/.test(path));
    assert.equal(remnants.length, 1);
    const remaining = error.remainingPaths[0];
    assert.equal(await original.readFile(remaining, 'utf8'), target === 'created.json.' ? encode(f.changes[3].document) : f.before[target.slice(0, -1)]);
  });
}

test('verify 后回滚 rename 失败保留旧备份和当前新值，其他项仍恢复', async t => {
  const f = await fixture(t);
  patch(t, 'rename', async (from, to) => {
    if (from.endsWith('.mechanics.bak') && to === join(f.root, 'b.json')) throw ioError('rollback');
    return original.rename(from, to);
  });
  const error = await rejected(commitFiles(f.root, f.changes, { verify: async () => { throw ioError('verify'); } }));
  assert.equal(error.committed, false);
  assert.equal(error.rollbackComplete, false);
  assert.equal(error.recovery.length, 1);
  const recovery = error.recovery[0];
  assert.equal(recovery.path, join(f.root, 'b.json'));
  assert.equal(recovery.committed, true);
  assert.equal(await original.readFile(recovery.backup, 'utf8'), f.before['b.json']);
  assert.equal(await original.readFile(recovery.path, 'utf8'), encode(f.changes[1].document));
  assert.ok(error.message.includes(recovery.backup));
  assert.ok(error.message.includes('结果待确认'));
  // 故障解除后仅用报告中的备份即可恢复，不需要隐藏事务状态。
  await original.rename(recovery.backup, recovery.path);
  await assertOriginal(f);
});

test('发布和恢复双重失败时保留备份及尚未发布的新字节', async t => {
  const f = await fixture(t);
  patch(t, 'rename', async (from, to) => {
    if (to === join(f.root, 'b.json')) throw ioError('publish-and-rollback');
    return original.rename(from, to);
  });
  const error = await rejected(commitFiles(f.root, f.changes));
  assert.equal(error.rollbackComplete, false);
  assert.equal(error.recovery.length, 1);
  const recovery = error.recovery[0];
  assert.equal(recovery.committed, false);
  assert.equal(await original.readFile(recovery.backup, 'utf8'), f.before['b.json']);
  assert.equal(await original.readFile(recovery.temp, 'utf8'), encode(f.changes[1].document));
  await original.rename(recovery.backup, recovery.path);
  await original.unlink(recovery.temp);
  await assertOriginal(f);
});

test('新建回滚 unlink 失败仍恢复其余项并保留新建恢复材料', async t => {
  const f = await fixture(t);
  patch(t, 'unlink', async path => {
    if (path === join(f.root, 'created.json')) throw ioError('rollback-unlink');
    return original.unlink(path);
  });
  const error = await rejected(commitFiles(f.root, f.changes, { verify: async () => { throw ioError('verify'); } }));
  assert.equal(error.rollbackComplete, false);
  assert.equal(error.recovery.length, 1);
  const recovery = error.recovery[0];
  assert.equal(recovery.committed, true);
  assert.equal(recovery.backup, null);
  assert.equal(await original.readFile(recovery.temp, 'utf8'), encode(f.changes[3].document));
  await original.unlink(recovery.path);
  await original.unlink(recovery.temp);
  await assertOriginal(f);
});

test('回滚临时文件清理失败显式报告残留，但不影响其他文件恢复', async t => {
  const f = await fixture(t);
  patch(t, 'link', async () => { throw ioError('link'); });
  patch(t, 'unlink', async path => {
    if (path.endsWith('.mechanics.tmp')) throw ioError('rollback-cleanup');
    return original.unlink(path);
  });
  const error = await rejected(commitFiles(f.root, f.changes));
  assert.equal(error.rollbackComplete, false);
  assert.equal(error.rollbackErrors[0].operation, 'cleanup');
  assert.equal(error.recovery.length, 1);
  assert.equal(error.recovery[0].committed, false);
  await original.unlink(error.recovery[0].temp);
  await assertOriginal(f);
});

test('共享短锁互斥并在释放后允许下一次事务', async t => {
  const f = await fixture(t);
  const release = await acquireWorkspaceLock(f.root);
  await rejected(acquireWorkspaceLock(f.root), 'WORKSPACE_LOCKED');
  await release();
  const releaseAgain = await acquireWorkspaceLock(f.root);
  await releaseAgain();
  await assertOriginal(f);
});
