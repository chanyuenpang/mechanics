import { open, rename, unlink, readFile, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { workspacePath } from './workspace.mjs';
import { ContractError } from '../domain/validate.mjs';

export function encode(document) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new ContractError('FILE_LIMIT', '保存内容超过 2 MiB');
  return text;
}
export async function writeExclusive(path, text) {
  const handle = await open(path, 'wx');
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}
async function replaceWithRetry(from, to) {
  // Windows 可能在关闭文件句柄后的极短时间内仍拒绝替换；仅重试该类瞬时占用，最终错误仍完整暴露。
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
export async function commitFile(root, file, text, { create = false, extensions = ['.json'] } = {}) {
  const path = await workspacePath(root, file, { allowMissing: create, extensions });
  const temp = `${path}.${randomUUID()}.mechanics.tmp`;
  let committed = false;
  try {
    await writeExclusive(temp, text);
    await workspacePath(root, file, { allowMissing: create, extensions });
    // 新建用硬链接发布完整临时文件，原子拒绝同名目标；不先删除或覆盖。
    if (create) await link(temp, path); else await replaceWithRetry(temp, path);
    committed = true;
    if (create) await unlink(temp);
    if (await readFile(path, 'utf8') !== text) throw new Error('回读内容不一致');
  } catch (error) {
    if (committed) throw new ContractError('SAVE_UNCERTAIN', `写入已提交但确认失败：${error.message}。请读取磁盘核实，勿直接重试。`);
    try { await unlink(temp); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.message += `；清理失败：${cleanup.message}`; }
    if (create && error.code === 'EEXIST') throw new ContractError('FILE_EXISTS', `文件已存在，未覆盖：${file}`);
    throw error;
  }
}
export async function acquireWorkspaceLock(root) {
  const path = resolve(root, '.mechanics.lock');
  const identity = JSON.stringify({ pid: process.pid, owner: randomUUID() });
  const recoverDeadOwner = async () => {
    let existing, owner;
    try { existing = await readFile(path, 'utf8'); owner = JSON.parse(existing); }
    catch { return false; }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.owner !== 'string' || !owner.owner) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { if (error.code !== 'ESRCH') return false; }
    // 当前协议的活动写入者不会替换既有锁；回读一致后才清理已死亡进程留下的锁。
    if (await readFile(path, 'utf8') !== existing) return false;
    try { await unlink(path); return true; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await writeExclusive(path, identity); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt || !await recoverDeadOwner()) {
        if (error.code === 'EEXIST') throw new ContractError('WORKSPACE_LOCKED', '另一个保存操作正在进行，未写入任何文件。请稍后重试。');
        throw error;
      }
    }
  }
  return async () => {
    if (await readFile(path, 'utf8') !== identity) throw new ContractError('LOCK_CHANGED', '工作区锁被外部修改，未删除。');
    await unlink(path);
  };
}

// 迁移先准备全部新字节，再以备份回滚保护完整文件集；任一失败不保留半升级结果。
export async function commitFiles(root, changes, { verify = null } = {}) {
  const prepared = [];
  try {
    for (const change of changes) {
      const path = await workspacePath(root, change.path, { allowMissing: change.create === true });
      if (change.delete === true) {
        prepared.push({ path, temp: null, backup: path + '.' + randomUUID() + '.mechanics.bak', text: null,
          create: false, delete: true, backedUp: false, committed: false });
        continue;
      }
      const text = encode(change.document);
      const temp = path + '.' + randomUUID() + '.mechanics.tmp';
      const backup = path + '.' + randomUUID() + '.mechanics.bak';
      await writeExclusive(temp, text);
      prepared.push({ path, temp, backup, text, create: change.create === true, backedUp: false, committed: false });
    }
    for (const item of prepared) if (!item.create) { await rename(item.path, item.backup); item.backedUp = true; }
    for (const item of prepared) {
      if (item.delete) { item.committed = true; continue; }
      if (item.create) { await link(item.temp, item.path); await unlink(item.temp); }
      else await rename(item.temp, item.path);
      item.committed = true;
    }
    for (const item of prepared) if (!item.delete && await readFile(item.path, 'utf8') !== item.text) throw new Error('回读内容不一致：' + item.path);
    if (verify) await verify();
    // 新建文件没有旧备份；只能清理确实由本事务改名得到的备份。
    // 把不存在的“备份”当作异常会在提交已完成后错误进入回滚路径。
    await Promise.all(prepared.filter(item => item.backedUp).map(item => unlink(item.backup)));
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...prepared].reverse()) {
      try {
        if (item.committed && !item.delete) await unlink(item.path);
        if (item.backedUp) await rename(item.backup, item.path);
      } catch (rollback) { rollbackErrors.push(rollback.message); }
      if (item.temp) try { await unlink(item.temp); } catch (cleanup) { if (cleanup.code !== 'ENOENT') rollbackErrors.push(cleanup.message); }
    }
    if (rollbackErrors.length) throw new ContractError('MIGRATION_WRITE_FAILED', '迁移写入失败且回滚未完整：' + error.message + '；' + rollbackErrors.join('；'));
    throw new ContractError('MIGRATION_WRITE_FAILED', '迁移写入失败，所有文件已回滚：' + error.message);
  }
}
