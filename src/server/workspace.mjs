import { lstat, realpath, open, readdir, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { assertDocument, validateWorkspace, ContractError } from '../domain/validate.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
export function assertRelativeFile(file) {
  if (typeof file !== 'string' || file.length > 512 || !file.endsWith('.json') || isAbsolute(file)
    || /[\\:\u0000-\u001f<>"|?*]/.test(file)
    || file.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new ContractError('UNSAFE_PATH', '工作区相对文件路径不安全：' + file);
  }
}
function assertInside(root, path) {
  const inside = relative(root, path);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
    throw new ContractError('UNSAFE_PATH', '文件超出授权工作区：' + path);
  }
}
export async function workspacePath(root, file, { allowMissing = false } = {}) {
  assertRelativeFile(file);
  let path = root;
  const parts = file.split('/');
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part); assertInside(root, path);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new ContractError('UNSAFE_PATH', '禁止工作区内的符号链接或 junction：' + file);
    } catch (error) {
      if (!(allowMissing && index === parts.length - 1 && error.code === 'ENOENT')) throw error;
    }
  }
  return path;
}
export async function ensureWorkspaceDirectory(root, directory) {
  if (!directory) return;
  assertRelativeFile(directory + '/check.json');
  let path = root;
  for (const part of directory.split('/')) {
    path = resolve(path, part); assertInside(root, path);
    try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ContractError('UNSAFE_PATH', '必须是工作区内的普通目录：' + directory);
    assertInside(root, await realpath(path));
  }
}
export async function readDocument(root, file) {
  const path = await workspacePath(root, file), actual = await realpath(path); assertInside(root, actual);
  const handle = await open(actual, 'r');
  let raw;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new ContractError('FILE_LIMIT', '文件不是普通文件或超过 2 MiB：' + file);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) throw new ContractError('FILE_LIMIT', '文件超过 2 MiB：' + file);
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw new ContractError('INVALID_JSON', file + ' 不是有效 UTF-8：' + error.message); }
  } finally { await handle.close(); }
  try { return { document: JSON.parse(raw), raw, actual }; }
  catch (error) { throw new ContractError('INVALID_JSON', file + ' 不是有效的 UTF-8 JSON：' + error.message); }
}
export async function discover(root) {
  const analysisPaths = [], directories = []; let count = 0;
  async function visit(directory, depth) {
    if (depth > 24) throw new ContractError('FILE_LIMIT', '工作区目录深度超过 24 层');
    const path = directory ? resolve(root, directory) : root;
    const entries = await readdir(path, { withFileTypes: true });
    if (directory && entries.some(entry => entry.name === 'workspace.json')) {
      throw new ContractError('NESTED_WORKSPACE', '工作区内包含另一个工作区：' + directory + '。请将两个工作区分开放置。');
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (++count > 10000) throw new ContractError('FILE_LIMIT', '工作区可见目录项超过 10000，请使用专用分析目录');
      const file = directory ? directory + '/' + entry.name : entry.name;
      const info = await lstat(resolve(root, file));
      if (info.isSymbolicLink()) throw new ContractError('UNSAFE_PATH', '拒绝目录中的符号链接或 junction：' + file);
      if (info.isDirectory()) { assertRelativeFile(file + '/check.json'); directories.push(file); await visit(file, depth + 1); }
      else if (entry.name.endsWith('.analysis.json')) {
        if (!info.isFile()) throw new ContractError('UNSAFE_PATH', '分析图必须是普通文件：' + file);
        analysisPaths.push(file);
        if (analysisPaths.length > 300) throw new ContractError('FILE_LIMIT', '工作区最多 300 张分析图');
      }
    }
  }
  await visit('', 0);
  return { analysisPaths: analysisPaths.sort(), directories: directories.sort() };
}
// override 只供显式 v1 迁移验证候选配置使用，HTTP 不开放此参数。
export async function readWorkspace(workspaceRoot, { manifestOverride } = {}) {
  if (!workspaceRoot) throw new ContractError('WORKSPACE_REQUIRED', '必须指定或定位工作区目录');
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map(), physicalFiles = new Set();
  async function read(file) {
    const { document, raw, actual } = await readDocument(root, file);
    const identity = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (physicalFiles.has(identity)) throw new ContractError('DUPLICATE_FILE', '同一文件被重复引用：' + file);
    physicalFiles.add(identity); snapshots.set(file, raw); return document;
  }
  const diskManifest = await read('workspace.json'), manifest = manifestOverride ?? diskManifest;
  if (manifest.schemaVersion === 1 && manifest.kind === 'workspace') {
    throw new ContractError('WORKSPACE_UPGRADE_REQUIRED', '此工作区仍使用 v1 文件清单。请关闭旧服务后执行 game-rule-analyzer migrate --workspace <目录>。');
  }
  assertDocument(manifest, 'workspace', 'workspace.json');
  const definitions = await read(manifest.definitions);
  const { analysisPaths, directories } = await discover(root);
  const analyses = [];
  for (const file of analysisPaths) analyses.push(await read(file));
  const workspace = validateWorkspace({ manifest, definitions, analyses });
  const hash = createHash('sha256');
  for (const [file, raw] of [...snapshots].sort(([a], [b]) => a.localeCompare(b))) hash.update(JSON.stringify([file, raw]));
  // 空目录变化也会改变文件树版本，避免目录操作基于旧树执行。
  hash.update(JSON.stringify(directories));
  const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' },
    { kind: 'definitions', path: manifest.definitions },
    ...analyses.map((graph, index) => ({ kind: 'analysis', id: graph.id, path: analysisPaths[index] }))];
  return { ...workspace, workspaceRoot: root, files, directories, revision: hash.digest('hex') };
}
