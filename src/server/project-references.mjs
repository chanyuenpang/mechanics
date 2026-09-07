import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { ContractError } from '../domain/validate.mjs';
import { projectContext } from './project-context.mjs';
import { readQuerySnapshot } from './query-snapshot.mjs';

const CONFIG_FILE = 'game-graph.references.json';
const fail = (code, message) => { throw new ContractError(code, message); };
const appData = () => process.env.APPDATA || resolve(homedir(), 'AppData', 'Roaming');
const bindingsPath = () => resolve(appData(), 'game-graph', 'project-reference-bindings.json');
const safeId = value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);

function validateReferences(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.references) || Object.keys(value).some(key => !['version', 'references'].includes(key))) fail('REFERENCE_CONFIG_INVALID', `${CONFIG_FILE} 格式无效`);
  const ids = new Set();
  for (const item of value.references) {
    if (!item || !safeId(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || !safeId(item.workspaceId)
      || Object.keys(item).some(key => !['id', 'name', 'workspaceId', 'relativePath'].includes(key))
      || (item.relativePath !== undefined && (typeof item.relativePath !== 'string' || !item.relativePath || isAbsolute(item.relativePath)))) fail('REFERENCE_CONFIG_INVALID', `${CONFIG_FILE} 包含无效参考声明`);
    ids.add(item.id);
  }
  return value;
}

function validateBindings(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.bindings)) fail('REFERENCE_BINDINGS_INVALID', '本机参考目录绑定格式无效');
  for (const item of value.bindings) if (!item || typeof item.sourceRoot !== 'string' || !isAbsolute(item.sourceRoot) || !safeId(item.referenceId) || typeof item.projectRoot !== 'string' || !isAbsolute(item.projectRoot)) fail('REFERENCE_BINDINGS_INVALID', '本机参考目录绑定包含无效项');
  return value;
}

export async function readProjectReferences(sourceRoot) {
  try { return validateReferences(JSON.parse(await readFile(resolve(sourceRoot, CONFIG_FILE), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, references: [] }; throw error; }
}

async function saveProjectReferences(sourceRoot, value) {
  validateReferences(value);
  const path = resolve(sourceRoot, CONFIG_FILE), temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, path); }
  catch (error) { try { await unlink(temporary); } catch {} throw error; }
}

async function readBindings(path = bindingsPath()) {
  try { return validateBindings(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, bindings: [] }; throw error; }
}

async function saveBindings(value, path = bindingsPath()) {
  validateBindings(value); await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, path); }
  catch (error) { try { await unlink(temporary); } catch {} throw error; }
}

export async function listProjectReferences(sourceRoot, { bindingsFile } = {}) {
  const declaration = await readProjectReferences(sourceRoot), bindings = await readBindings(bindingsFile);
  return Promise.all(declaration.references.map(async item => {
    const bound = bindings.bindings.find(candidate => candidate.sourceRoot.toLowerCase() === sourceRoot.toLowerCase() && candidate.referenceId === item.id);
    const projectRoot = bound?.projectRoot ?? (item.relativePath ? resolve(sourceRoot, item.relativePath) : null);
    if (!projectRoot) return { ...item, status: 'unlocated' };
    try {
      const context = await projectContext(projectRoot, { createExportRoot: false, allowMissingExport: true, allowUnavailableExport: true });
      const workspace = await readQuerySnapshot(context.workspaceRoot);
      if (workspace.manifest.id !== item.workspaceId) return { ...item, projectRoot: context.projectRoot, status: 'workspace-mismatch', actualWorkspaceId: workspace.manifest.id };
      return { ...item, projectRoot: context.projectRoot, status: 'ready', actualName: workspace.manifest.name };
    } catch (error) { return { ...item, projectRoot, status: 'unavailable', message: error.message }; }
  }));
}

export async function bindProjectReference(sourceRoot, referenceId, projectRoot, { bindingsFile } = {}) {
  const declaration = await readProjectReferences(sourceRoot);
  const reference = declaration.references.find(item => item.id === referenceId);
  if (!reference) fail('REFERENCE_NOT_DECLARED', `当前项目未声明参考：${referenceId}`);
  const bindings = await readBindings(bindingsFile), context = await projectContext(projectRoot, { createExportRoot: false, allowMissingExport: true, allowUnavailableExport: true });
  const workspace = await readQuerySnapshot(context.workspaceRoot);
  if (workspace.manifest.id !== reference.workspaceId) fail('REFERENCE_WORKSPACE_MISMATCH', `所选目录属于 ${workspace.manifest.id}，但“${reference.name}”要求 ${reference.workspaceId}`);
  bindings.bindings = bindings.bindings.filter(item => !(item.sourceRoot.toLowerCase() === sourceRoot.toLowerCase() && item.referenceId === referenceId));
  bindings.bindings.push({ sourceRoot, referenceId, projectRoot: context.projectRoot }); await saveBindings(bindings, bindingsFile);
  return listProjectReferences(sourceRoot, { bindingsFile });
}

export async function declareProjectReference(sourceRoot, { projectRoot }, { bindingsFile } = {}) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) fail('REFERENCE_DECLARATION_INVALID', '关联项目必须提供绝对项目目录');
  const target = await projectContext(projectRoot, { createExportRoot: false, allowMissingExport: true, allowUnavailableExport: true });
  const workspace = await readQuerySnapshot(target.workspaceRoot), declaration = await readProjectReferences(sourceRoot);
  const id = workspace.manifest.id, name = workspace.manifest.name;
  if (declaration.references.some(item => item.workspaceId === id)) fail('REFERENCE_DECLARATION_EXISTS', `当前项目已关联：${name}`);
  const candidate = relative(sourceRoot, target.projectRoot).replace(/\\/g, '/');
  const reference = { id, name: name.trim(), workspaceId: workspace.manifest.id, ...(candidate && !isAbsolute(candidate) ? { relativePath: candidate } : {}) };
  declaration.references.push(reference); await saveProjectReferences(sourceRoot, declaration);
  try {
    await bindProjectReference(sourceRoot, id, target.projectRoot, { bindingsFile });
  } catch (error) {
    const partial = new ContractError('REFERENCE_DECLARATION_PARTIAL', `关联声明已保存，但本机目录绑定失败：${error.message}`);
    Object.assign(partial, { referenceDeclared: true, reference });
    throw partial;
  }
  return listProjectReferences(sourceRoot, { bindingsFile });
}
