import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ContractError } from '../domain/validate.mjs';

export const WORKSPACE_DIRECTORY = '.mechanics';
export const DEFAULT_AGENT_EXPORT_PATH = 'mechanics';

function fail(code, message) { throw new ContractError(code, message); }

function inside(root, candidate, { strict = true } = {}) {
  const path = relative(root, candidate);
  const valid = !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep) && (!strict || !!path);
  if (!valid) fail('UNSAFE_PATH', '路径超出项目目录：' + candidate);
}

function directoryParts(value) {
  if (typeof value !== 'string' || value.length > 512 || !value || value === '.' || isAbsolute(value)
    || /[\\:\u0000-\u001f<>"|?*]/.test(value)) {
    fail('INVALID_EXPORT_PATH', 'Agent 机制文档路径必须是项目内相对目录：' + String(value));
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('INVALID_EXPORT_PATH', 'Agent 机制文档路径包含不安全目录：' + value);
  }
  if (parts.some(part => ['.mechanics', '.git', 'node_modules'].includes(part.toLowerCase()))) {
    fail('INVALID_EXPORT_PATH', 'Agent 机制文档不能写入控制目录或依赖目录：' + value);
  }
  return parts;
}

async function ordinaryDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('UNSAFE_PATH', label + '必须是普通目录：' + path);
  return await realpath(path);
}

export async function canonicalProjectRoot(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') fail('PROJECT_REQUIRED', '必须指定项目目录');
  return ordinaryDirectory(resolve(projectRoot), '项目目录');
}

export async function resolveAgentExportRoot(projectRoot, agentExportPath, { create = false, allowMissing = false } = {}) {
  const parts = directoryParts(agentExportPath);
  let path = projectRoot;
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part); inside(projectRoot, path);
    try {
      const actual = await ordinaryDirectory(path, 'Agent 机制文档目录');
      inside(projectRoot, actual);
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing && !create) {
        for (const remaining of parts.slice(index + 1)) { path = resolve(path, remaining); inside(projectRoot, path); }
        return path;
      }
      if (!create || error.code !== 'ENOENT') throw error;
      await mkdir(path);
      const actual = await ordinaryDirectory(path, 'Agent 机制文档目录');
      inside(projectRoot, actual);
    }
  }
  return path;
}

export async function projectContext(projectRoot, { requireWorkspace = true, createExportRoot = false, allowMissingExport = false,
  allowUnavailableExport = false, manifest = null } = {}) {
  const root = await canonicalProjectRoot(projectRoot);
  const workspaceRoot = resolve(root, WORKSPACE_DIRECTORY);
  inside(root, workspaceRoot);
  try {
    const actual = await ordinaryDirectory(workspaceRoot, 'Mechanics 工作区');
    if (actual !== workspaceRoot && process.platform !== 'win32') fail('UNSAFE_PATH', '.mechanics 不得通过链接指向其他目录');
    inside(root, actual);
  } catch (error) {
    if (requireWorkspace || error.code !== 'ENOENT') throw error;
  }
  if (!manifest && requireWorkspace) {
    let raw;
    try { raw = await readFile(resolve(workspaceRoot, 'workspace.json'), 'utf8'); }
    catch (error) { fail(error.code === 'ENOENT' ? 'PROJECT_NOT_FOUND' : 'INVALID_JSON', `无法读取 ${WORKSPACE_DIRECTORY}/workspace.json：${error.message}`); }
    try { manifest = JSON.parse(raw); }
    catch (error) { fail('INVALID_JSON', `${WORKSPACE_DIRECTORY}/workspace.json 不是有效 JSON：${error.message}`); }
    // 项目上下文只负责定位工作区与导出目录，不拥有协议版本门禁。
    // 兼容读取器随后决定概念、规则和拓扑是否可用；不能让展示协议版本阻断项目打开。
    if (manifest?.kind !== 'workspace' || typeof manifest.id !== 'string' || typeof manifest.name !== 'string') {
      fail('INVALID_WORKSPACE_MARKER', `${WORKSPACE_DIRECTORY}/workspace.json 缺少工作区身份。`);
    }
  }
  // 导出目录是 canonical 的派生投影目标；缺失配置不再悄悄回填默认目录。
  // 新建工作区仍由 init 显式写入 DEFAULT_AGENT_EXPORT_PATH。
  const agentExportPath = manifest?.agentExportPath;
  if (agentExportPath === undefined) return { projectRoot: root, workspaceRoot, exportRoot: null, agentExportPath: null,
    exportStatus: 'unconfigured' };
  try {
    const exportRoot = await resolveAgentExportRoot(root, agentExportPath, { create: createExportRoot, allowMissing: allowMissingExport });
    if (workspaceRoot === exportRoot || workspaceRoot.startsWith(exportRoot + sep) || exportRoot.startsWith(workspaceRoot + sep)) {
      fail('INVALID_EXPORT_PATH', 'Agent 机制文档目录不能与 .mechanics 重叠');
    }
    // allowMissingExport 只允许 canonical 读取继续；不把路径存在误报为已发布。
    let exportStatus = 'available';
    try { await ordinaryDirectory(exportRoot, 'Agent 机制文档目录'); }
    catch (error) { if (error.code === 'ENOENT') exportStatus = 'missing'; else throw error; }
    return { projectRoot: root, workspaceRoot, exportRoot, agentExportPath, exportStatus };
  } catch (error) {
    if (!allowUnavailableExport) throw error;
    return { projectRoot: root, workspaceRoot, exportRoot: null, agentExportPath, exportStatus: 'unavailable',
      exportError: { code: error.code ?? 'EXPORT_TARGET_UNAVAILABLE', message: error.message } };
  }
}

export async function projectRootFromWorkspace(workspaceRoot) {
  const root = await ordinaryDirectory(resolve(workspaceRoot), 'Mechanics 工作区');
  if (basename(root) !== WORKSPACE_DIRECTORY) {
    fail('PROJECT_LAYOUT_REQUIRED', `工作区必须位于项目固定目录 ${WORKSPACE_DIRECTORY}：${root}`);
  }
  return canonicalProjectRoot(dirname(root));
}
