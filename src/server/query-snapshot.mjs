import { readWorkspace } from './workspace.mjs';

// 两次读取用于发现外部变化，不宣称跨文件原子快照；协作写入者由锁或队列隔离。
export async function readQuerySnapshot(root) {
  const first = await readWorkspace(root), second = await readWorkspace(root);
  if (first.revision !== second.revision) throw Object.assign(new Error('读取期间工作区发生变化，请重新查询'), { code: 'REVISION_CONFLICT' });
  return second;
}
