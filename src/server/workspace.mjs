import { lstat, realpath, open, readdir, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { assertDocument, validateWorkspace, ContractError } from '../domain/validate.mjs';
import { resolvePresentationReferences } from '../domain/presentation.mjs';
import { compatibilityWorkspace } from './compatibility.mjs';
import { projectContext, projectRootFromWorkspace } from './project-context.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const semanticHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// 展示字段只描述当前画布呈现：坐标、配色与连线路径都是可随时重算的派生物。
// 布局变化不得移动语义版本，否则“打开一张图自动补算路径”就会作废其他页面与 Agent 草稿。
// 依据：docs/文件协议.md「布局不改变语义 revision」。
const presentationFields = new Set(['positions', 'projectionPositions', 'routeCache', 'nodeColors', 'nodeStyles']);
export function withoutPresentation(value) {
  if (Array.isArray(value)) return value.map(withoutPresentation);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !presentationFields.has(key))
    .map(([key, item]) => [key, withoutPresentation(item)]));
}
// 最近打开快照属于界面状态，不是工作区语义。
function semanticWorkspaceDocument(document) {
  if (document?.kind !== 'workspace') return withoutPresentation(document);
  const { lastView, ...rest } = document;
  return withoutPresentation(rest);
}
// 每资源语义版本：写入服务用它做按资源的冲突判定，Agent 工具用它做 compare-and-swap 句柄。
export function workspaceResourceRevisions(workspace) {
  const byId = documents => Object.fromEntries([...documents]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(document => [document.id, semanticHash(withoutPresentation(document))]));
  return { workspace: semanticHash(semanticWorkspaceDocument(workspace.manifest)),
    definitions: semanticHash(withoutPresentation(workspace.definitions)),
    rules: semanticHash(withoutPresentation(workspace.rules)),
    mechanics: byId(workspace.mechanics), views: byId(workspace.views) };
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
export async function readWorkspace(workspaceRoot, { context = null, isolateResources = false } = {}) {
  if (!workspaceRoot) throw new ContractError('WORKSPACE_REQUIRED', '必须指定或定位工作区目录');
  const root = await realpath(resolve(workspaceRoot));
  // 快照保留语义形态而非原始字节：只有语义变化才算磁盘变化。
  const snapshots = new Map(), physicalFiles = new Set();
  async function read(file) {
    const { document, actual } = await readDocument(root, file);
    const identity = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (physicalFiles.has(identity)) throw new ContractError('DUPLICATE_FILE', '同一文件被重复引用：' + file);
    physicalFiles.add(identity); snapshots.set(file, JSON.stringify(semanticWorkspaceDocument(document))); return document;
  }
  const rawManifest = await read('workspace.json');
  const rawDefinitions = await read(rawManifest.definitions);
  let rawRules = null;
  if (typeof rawManifest.rules === 'string') {
    try { rawRules = await read(rawManifest.rules); }
    catch (error) {
      // v10 及更早版本没有独立规则库；其他版本缺少声明的核心文件仍应显式失败。
      if (!(rawManifest.schemaVersion < 11 && error.code === 'ENOENT')) throw error;
    }
  }
  const { mechanicPaths, viewPaths, directories } = await discover(root);
  const rawMechanics = [], rawViews = [];
  for (const file of mechanicPaths) rawMechanics.push({ document: await read(file), path: file });
  for (const file of viewPaths) rawViews.push({ document: await read(file), path: file });
  const compatible = compatibilityWorkspace({ manifest: rawManifest, definitions: rawDefinitions, rawRules, rawMechanics, rawViews });
  const { manifest, definitions, rules } = compatible;
  context ??= await projectContext(await projectRootFromWorkspace(root), { manifest, createExportRoot: false,
    allowMissingExport: true, allowUnavailableExport: true });
  if (context.workspaceRoot !== root && (process.platform !== 'win32' || context.workspaceRoot.toLowerCase() !== root.toLowerCase())) {
    throw new ContractError('PROJECT_CONTEXT_MISMATCH', '工作区不属于当前项目上下文：' + root);
  }
  // 基础资料是项目的唯一核心合同；机制图和视图只是引用这些事实的阅读、编辑资源。
  // 兼容解码完成后仍以当前跨文件规则验证核心拓扑。
  validateWorkspace({ manifest, definitions, rules, mechanics: [], views: [], files: [] }, { validateResourceReferences: false });
  const mechanics = [], views = [], mechanicFiles = [], viewFiles = [];
  const resourceDiagnostics = [];
  const resourceManifest = { ...manifest, compositions: [] };
  delete resourceManifest.exportSelections;
  delete resourceManifest.lastView;
  const validateMechanic = (document, file) => validateWorkspace({ manifest: resourceManifest, definitions, rules,
    mechanics: [document], views: [], files: [{ kind: 'mechanic', id: document.id, path: file }] });
  for (const item of compatible.mechanics) {
    const { document, path: file } = item;
    try { assertDocument(document, 'mechanic', file); validateMechanic(document, file); mechanics.push(document); mechanicFiles.push(file); }
    catch (error) {
      if (!isolateResources) throw error;
      resourceDiagnostics.push({ kind: 'mechanic', path: file, code: error.code ?? 'RESOURCE_INVALID', message: error.message });
    }
  }
  for (const item of compatible.views) {
    const { document, path: file } = item;
    try {
      assertDocument(document, 'view', file);
      validateWorkspace({ manifest: resourceManifest, definitions, rules, mechanics, views: [...views, document], files: [
        ...mechanics.map((item, index) => ({ kind: 'mechanic', id: item.id, path: mechanicFiles[index] })),
        ...views.map((item, index) => ({ kind: 'view', id: item.id, path: viewFiles[index] })),
        { kind: 'view', id: document.id, path: file }
      ] });
      views.push(document); viewFiles.push(file);
    } catch (error) {
      if (!isolateResources) throw error;
      resourceDiagnostics.push({ kind: 'view', path: file, code: error.code ?? 'RESOURCE_INVALID', message: error.message });
    }
  }
  const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' },
    { kind: 'definitions', path: manifest.definitions },
    { kind: 'rules', path: manifest.rules },
    ...mechanics.map((graph, index) => ({ kind: 'mechanic', id: graph.id, path: mechanicFiles[index] })),
    ...views.map((view, index) => ({ kind: 'view', id: view.id, path: viewFiles[index] }))];
  // 先严格验证所有会改变领域模型的事实，再解析不拥有存在性事实的展示状态。
  // 解析只产生内存快照，项目打开不会因此悄悄改写用户文件。
  const healthyMechanicIds = new Set(mechanics.map(item => item.id));
  const healthyViewIds = new Set(views.map(item => item.id));
  const presentationManifest = structuredClone(manifest);
  if (isolateResources) {
    presentationManifest.compositions = manifest.compositions.filter(view => view.graphIds.every(id => healthyMechanicIds.has(id)));
    if (manifest.exportSelections !== undefined) presentationManifest.exportSelections = manifest.exportSelections.filter(selection => selection.kind === 'folder'
      || (selection.kind === 'mechanic' ? healthyMechanicIds.has(selection.mechanicId) : healthyViewIds.has(selection.viewId)));
    if (manifest.lastView?.viewId && !healthyViewIds.has(manifest.lastView.viewId)) delete presentationManifest.lastView;
  }
  const validated = validateWorkspace({ manifest: presentationManifest, definitions, rules, mechanics, views, files });
  const { workspace, diagnostics: presentationDiagnostics } = resolvePresentationReferences({ ...validated, files });
  const hash = createHash('sha256');
  for (const [file, snapshot] of [...snapshots].sort(([a], [b]) => a.localeCompare(b))) hash.update(JSON.stringify([file, snapshot]));
  // 空目录变化也会改变文件树版本，避免目录操作基于旧树执行。
  hash.update(JSON.stringify(directories));
  return { ...workspace, projectRoot: context.projectRoot, workspaceRoot: root, agentExportRoot: context.exportRoot,
    agentExportPath: context.agentExportPath, agentExportStatus: context.exportStatus, agentExportError: context.exportError,
    files, directories, presentationDiagnostics: [...compatible.compatibilityDiagnostics, ...presentationDiagnostics], resourceDiagnostics, compatibilityMode: compatible.compatibilityMode,
    workspaceState: resourceDiagnostics.length ? 'degraded' : 'ready',
    revision: hash.digest('hex'), resourceRevisions: workspaceResourceRevisions(workspace) };
}
