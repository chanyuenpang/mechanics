import { lstat, realpath, open, readdir, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { assertDocument, validateWorkspace, ContractError } from '../domain/validate.mjs';
import { resolvePresentationReferences } from '../domain/presentation.mjs';
import { projectContext, projectRootFromWorkspace } from './project-context.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const semanticHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function workspaceResourceRevisions(workspace) {
  const nodes = [...workspace.definitions.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const mechanics = Object.fromEntries([...workspace.mechanics]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(mechanic => [mechanic.id, semanticHash({
      focusNodeIds: [...mechanic.focusNodeIds].sort(),
      pinnedRuleIds: [...mechanic.pinnedRuleIds].sort(),
    })]));
  return { definitions: semanticHash({ nodes }), rules: semanticHash({ rules: workspace.rules.rules }), mechanics };
}
export function assertRelativeFile(file, extensions = ['.json']) {
  if (typeof file !== 'string' || file.length > 512 || !extensions.some(extension => file.endsWith(extension)) || isAbsolute(file)
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
export async function workspacePath(root, file, { allowMissing = false, extensions = ['.json'] } = {}) {
  assertRelativeFile(file, extensions);
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
  const mechanicPaths = [], viewPaths = [], directories = []; let count = 0;
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
      else if (entry.name.endsWith('.mechanic.json') || entry.name.endsWith('.view.json')) {
        if (!info.isFile()) throw new ContractError('UNSAFE_PATH', '规则与视图必须是普通文件：' + file);
        const paths = entry.name.endsWith('.view.json') ? viewPaths : mechanicPaths;
        paths.push(file);
        if (paths.length > 300) throw new ContractError('FILE_LIMIT', '工作区每种类型最多 300 个文件');
      }
    }
  }
  await visit('', 0);
  return { mechanicPaths: mechanicPaths.sort(), viewPaths: viewPaths.sort(), directories: directories.sort() };
}
// override 只供显式迁移验证候选配置使用，HTTP 不开放此参数。
export async function readWorkspace(workspaceRoot, { context = null } = {}) {
  if (!workspaceRoot) throw new ContractError('WORKSPACE_REQUIRED', '必须指定或定位工作区目录');
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map(), physicalFiles = new Set();
  async function read(file) {
    const { document, raw, actual } = await readDocument(root, file);
    const identity = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (physicalFiles.has(identity)) throw new ContractError('DUPLICATE_FILE', '同一文件被重复引用：' + file);
    physicalFiles.add(identity); snapshots.set(file, raw); return document;
  }
  const manifest = await read('workspace.json');
  if (manifest.kind === 'workspace' && manifest.schemaVersion !== 11) {
    throw new ContractError('WORKSPACE_VERSION_UNSUPPORTED', '只支持 Mechanics 工作区 v11；当前文件为 v' + String(manifest.schemaVersion) + '。');
  }
  assertDocument(manifest, 'workspace', 'workspace.json');
  context ??= await projectContext(await projectRootFromWorkspace(root), { manifest, createExportRoot: false,
    allowMissingExport: true, allowUnavailableExport: true });
  if (context.workspaceRoot !== root && (process.platform !== 'win32' || context.workspaceRoot.toLowerCase() !== root.toLowerCase())) {
    throw new ContractError('PROJECT_CONTEXT_MISMATCH', '工作区不属于当前项目上下文：' + root);
  }
  const definitions = await read(manifest.definitions);
  const rules = await read(manifest.rules);
  const { mechanicPaths, viewPaths, directories } = await discover(root);
  const mechanics = [], views = [];
  for (const [paths, documents, kind] of [[mechanicPaths, mechanics, 'mechanic'], [viewPaths, views, 'view']]) {
    for (const file of paths) { const document = await read(file); assertDocument(document, kind, file); documents.push(document); }
  }
  const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' },
    { kind: 'definitions', path: manifest.definitions },
    { kind: 'rules', path: manifest.rules },
    ...mechanics.map((graph, index) => ({ kind: 'mechanic', id: graph.id, path: mechanicPaths[index] })),
    ...views.map((view, index) => ({ kind: 'view', id: view.id, path: viewPaths[index] }))];
  // 先严格验证所有会改变领域模型的事实，再解析不拥有存在性事实的展示状态。
  // 解析只产生内存快照，项目打开不会因此悄悄改写用户文件。
  const validated = validateWorkspace({ manifest, definitions, rules, mechanics, views, files });
  const { workspace, diagnostics: presentationDiagnostics } = resolvePresentationReferences({ ...validated, files });
  const hash = createHash('sha256');
  for (const [file, raw] of [...snapshots].sort(([a], [b]) => a.localeCompare(b))) hash.update(JSON.stringify([file, raw]));
  // 空目录变化也会改变文件树版本，避免目录操作基于旧树执行。
  hash.update(JSON.stringify(directories));
  return { ...workspace, projectRoot: context.projectRoot, workspaceRoot: root, agentExportRoot: context.exportRoot,
    agentExportPath: context.agentExportPath, agentExportStatus: context.exportStatus, agentExportError: context.exportError,
    files, directories, presentationDiagnostics, revision: hash.digest('hex'), resourceRevisions: workspaceResourceRevisions(workspace) };
}
