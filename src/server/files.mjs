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
export async function commitFile(root, file, text, { create = false } = {}) {
  const path = await workspacePath(root, file, { allowMissing: create });
  const temp = `${path}.${randomUUID()}.game-graph.tmp`;
  let committed = false;
  try {
    await writeExclusive(temp, text);
    await workspacePath(root, file, { allowMissing: create });
    // 新建用硬链接发布完整临时文件，原子拒绝同名目标；不先删除或覆盖。
    if (create) await link(temp, path); else await rename(temp, path);
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
  const path = resolve(root, '.game-graph.lock');
  const identity = JSON.stringify({ pid: process.pid, owner: randomUUID() });
  try { await writeExclusive(path, identity); }
  catch (error) {
    if (error.code === 'EEXIST') throw new ContractError('WORKSPACE_LOCKED', '工作区已有服务或遗留锁。请关闭服务；确认无写入者后才可手动移除 .game-graph.lock。');
    throw error;
  }
  return async () => {
    if (await readFile(path, 'utf8') !== identity) throw new ContractError('LOCK_CHANGED', '工作区锁被外部修改，未删除。');
    await unlink(path);
  };
}
