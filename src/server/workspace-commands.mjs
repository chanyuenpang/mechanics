import { lstat, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDocument, readWorkspace } from './workspace.mjs';
import { encode, writeExclusive } from './files.mjs';
import { validateWorkspace, ContractError } from '../domain/validate.mjs';

export async function findWorkspace(start = process.cwd()) {
  let directory = await realpath(resolve(start));
  if (!(await lstat(directory)).isDirectory()) throw new ContractError('WORKSPACE_REQUIRED', '工作区位置必须是目录');
  for (;;) {
    try {
      await lstat(resolve(directory, 'workspace.json'));
      // 最近的标记是边界；坏标记报错，不能越过它写到父工作区。
      const { document } = await readDocument(directory, 'workspace.json');
      if (document.kind !== 'workspace') throw new ContractError('INVALID_WORKSPACE_MARKER', '最近的 workspace.json 不是规则工作区：' + directory);
      return directory;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) throw new ContractError('WORKSPACE_NOT_FOUND', '未找到工作区。请先 init <新目录>，或用 --workspace 指定已有目录。');
    directory = parent;
  }
}

export async function initWorkspace(target, { name = '游戏规则工作区', id = 'workspace-' + randomUUID().slice(0, 8) } = {}) {
  if (!target) throw new ContractError('WORKSPACE_REQUIRED', 'init 必须指定一个新的资料目录');
  const root = resolve(target);
  try {
    const parentRoot = await findWorkspace(dirname(root));
    throw new ContractError('NESTED_WORKSPACE', '不能在已有工作区内初始化另一个工作区：' + parentRoot);
  } catch (error) { if (error.code !== 'WORKSPACE_NOT_FOUND') throw error; }
  const manifest = { schemaVersion: 4, kind: 'workspace', id, name, definitions: 'definitions.graph.json', compositions: [], lastView: { graphIds: [], activeLayerId: null, collapsedNodeIds: [], positions: {} } };
  const definitions = { schemaVersion: 1, kind: 'definitions', workspaceId: id, nodes: [], positions: {} };
  validateWorkspace({ manifest, definitions, mechanics: [] });
  try { await mkdir(root); }
  catch (error) {
    if (error.code === 'EEXIST') throw new ContractError('WORKSPACE_EXISTS', '初始化目标已存在，未修改：' + root);
    throw error;
  }
  try {
    await writeExclusive(resolve(root, 'definitions.graph.json'), encode(definitions));
    await mkdir(resolve(root, 'mechanics'));
    await writeExclusive(resolve(root, '.gitignore'), '.game-graph.lock\n*.game-graph.tmp\n');
    // 最后创建标记，失败不冒充一个可用工作区。
    await writeExclusive(resolve(root, 'workspace.json'), encode(manifest));
    await readWorkspace(root);
    return { root, workspaceId: id };
  } catch (error) { throw new ContractError('INIT_PARTIAL', '初始化未完成，目录已保留供检查：' + root + '；' + error.message); }
}
