import { lstat, realpath, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { assertDocument, validateWorkspace, ContractError } from '../domain/validate.mjs';

const MAX_BYTES = 2 * 1024 * 1024;

export async function workspacePath(root, file, { allowMissing = false } = {}) {
  if (typeof file !== 'string' || !/^[a-zA-Z0-9_-]+(?:[./][a-zA-Z0-9_-]+)*\.json$/.test(file)) {
    throw new ContractError('UNSAFE_PATH', `工作区文件路径不安全：${file}`);
  }
  let path = root;
  const parts = file.split('/');
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new ContractError('UNSAFE_PATH', `禁止工作区内的符号链接或 junction：${file}`);
    } catch (error) {
      if (!(allowMissing && index === parts.length - 1 && error.code === 'ENOENT')) throw error;
    }
  }
  const inside = relative(root, path);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new ContractError('UNSAFE_PATH', `文件超出授权根目录：${file}`);
  }
  return path;
}

export async function readWorkspace(workspaceRoot) {
  if (!workspaceRoot) throw new ContractError('WORKSPACE_REQUIRED', '必须显式指定工作区目录');
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map();
  const physicalFiles = new Set();
  async function readDocument(file) {
    const path = await workspacePath(root, file);
    const actual = await realpath(path);
    const inside = relative(root, actual);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new ContractError('UNSAFE_PATH', `文件超出授权根目录：${file}`);
    }
    const identity = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (physicalFiles.has(identity)) throw new ContractError('DUPLICATE_FILE', `同一文件被重复登记：${file}`);
    physicalFiles.add(identity);
    const handle = await open(actual, 'r');
    let raw;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new ContractError('FILE_LIMIT', `文件不是普通文件或超过 2 MiB：${file}`);
      const bytes = await handle.readFile();
      if (bytes.length > MAX_BYTES) throw new ContractError('FILE_LIMIT', `文件超过 2 MiB：${file}`);
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      await handle.close();
    }
    snapshots.set(file, raw);
    try { return JSON.parse(raw); }
    catch (error) { throw new ContractError('INVALID_JSON', `${file} 不是有效的 UTF-8 JSON：${error.message}`); }
  }
  const manifest = await readDocument('workspace.json');
  assertDocument(manifest, 'workspace', 'workspace.json');
  if (manifest.analyses.length > 300) throw new ContractError('FILE_LIMIT', '工作区最多登记 300 张分析图');
  const definitions = await readDocument(manifest.definitions);
  const analyses = [];
  for (const file of manifest.analyses) analyses.push(await readDocument(file));
  const workspace = validateWorkspace({ manifest, definitions, analyses });
  const hash = createHash('sha256');
  for (const [file, raw] of [...snapshots].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([file, raw]));
  }
  return { ...workspace, revision: hash.digest('hex') };
}
