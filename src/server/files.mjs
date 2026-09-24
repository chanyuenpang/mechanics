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

// 先准备全部字节，再提交并回读确认；确认后的清理故障不能触发回滚。
// 成功仍返回 undefined；提交前失败沿用 MIGRATION_WRITE_FAILED，清理失败明确标记 committed。
export async function commitFiles(root, changes, { verify = null } = {}) {
  const prepared = [];
  const remove = async path => {
    try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  const failure = (operation, path, error) => ({ operation, path, code: error.code, message: error.message });
  try {
    for (const change of changes) {
      const path = await workspacePath(root, change.path, { allowMissing: change.create === true });
      const item = { path, temp: null, backup: path + '.' + randomUUID() + '.mechanics.bak',
        text: null, create: change.create === true, delete: change.delete === true, backedUp: false, committed: false };
      prepared.push(item);
      if (item.delete) { item.create = false; continue; }
      item.text = encode(change.document);
      const temp = path + '.' + randomUUID() + '.mechanics.tmp';
      // 独占打开成功即登记所有权，连写入或同步失败留下的临时文件也进入清理。
      const handle = await open(temp, 'wx');
      item.temp = temp;
      try { await handle.writeFile(item.text, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
    }
    for (const item of prepared) if (!item.create) { await rename(item.path, item.backup); item.backedUp = true; }
    for (const item of prepared) {
      if (item.delete) { item.committed = true; continue; }
      // 新建原子拒绝覆盖；硬链接临时文件留到确认后清理，不混入提交阶段。
      if (item.create) await link(item.temp, item.path);
      else { await rename(item.temp, item.path); item.temp = null; }
      item.committed = true;
    }
    for (const item of prepared) if (!item.delete && await readFile(item.path, 'utf8') !== item.text) throw new Error('回读内容不一致：' + item.path);
    if (verify) await verify();
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...prepared].reverse()) {
      try {
        // 直接以备份恢复，避免先删 canonical 后恢复失败；失败时备份必须留存。
        if (item.backedUp) { await rename(item.backup, item.path); item.backedUp = false; item.committed = false; }
        else if (item.create && item.committed) { await remove(item.path); item.committed = false; }
      } catch (rollback) { rollbackErrors.push(failure('restore', item.path, rollback)); }
      // 各项独立恢复；尚未恢复的文件保留全部剩余材料，不能在 finally 中销毁。
      if (item.temp && !item.backedUp && !item.committed) {
        try { await remove(item.temp); item.temp = null; }
        catch (cleanup) { rollbackErrors.push(failure('cleanup', item.temp, cleanup)); }
      }
    }
    const recovery = prepared.filter(item => item.backedUp || item.committed || item.temp).map(item => ({
      path: item.path, backup: item.backedUp ? item.backup : null, temp: item.temp, committed: item.committed,
    }));
    const details = rollbackErrors.map(item => item.operation + ' ' + item.path + '：' + item.message).join('；');
    const recoveryMessage = recovery.map(item => item.path + '（已发布：' + item.committed
      + '；备份：' + item.backup + '；临时文件：' + item.temp + '）').join('；');
    const result = new ContractError('MIGRATION_WRITE_FAILED', rollbackErrors.length
      ? '写入失败且回滚未完整，结果待确认：' + error.message + '；' + details + '；恢复材料：' + recoveryMessage
      : '写入失败，所有文件已回滚：' + error.message);
    // committed 只表示整组已确认；false 不代表零写入，须同时读取回滚状态与恢复清单。
    const state = { committed: false, commitState: rollbackErrors.length ? 'uncertain' : 'rolled-back',
      rollbackComplete: rollbackErrors.length === 0, rollbackErrors, recovery };
    Object.assign(result, state, { details: state, cause: error });
    throw result;
  }
  // 全部字节和调用方校验已通过。从此只清理，不允许回滚已确认的 canonical。
  const cleanupErrors = [];
  for (const item of prepared) {
    for (const path of [item.backedUp ? item.backup : null, item.temp].filter(Boolean)) {
      try { await remove(path); }
      catch (error) { cleanupErrors.push(failure('cleanup', path, error)); }
    }
  }
  if (cleanupErrors.length) {
    const remainingPaths = cleanupErrors.map(item => item.path);
    const result = new ContractError('SAVE_CLEANUP_FAILED', '文件已提交并确认，但清理失败，请勿重新提交：'
      + cleanupErrors.map(item => item.path + '：' + item.message).join('；'));
    const state = { committed: true, commitState: 'committed', remainingPaths, cleanupErrors };
    Object.assign(result, state, { details: state });
    throw result;
  }
}
