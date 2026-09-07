import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeExclusive } from './files.mjs';
import { projectContext, WORKSPACE_DIRECTORY } from './project-context.mjs';
import { readWorkspace } from './workspace.mjs';
import { ContractError } from '../domain/validate.mjs';
import { semanticIdProblem } from '../domain/identity.mjs';

const HISTORY_VERSION = 1;
const RECENT_LIMIT = 12;
const historyQueues = new Map();

const fail = (code, message) => { throw new ContractError(code, message); };
const platformRoot = () => process.platform === 'win32'
  ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');

export function projectHistoryPath() {
  return join(platformRoot(), 'game-graph', 'projects.json');
}

function validateHistory(value) {
  if (!value || value.version !== HISTORY_VERSION || !Array.isArray(value.items)
    || Object.keys(value).some(key => !['version', 'items'].includes(key))) {
    throw new Error('项目历史文件格式无效，请检查 projects.json');
  }
  const roots = new Set();
  for (const item of value.items) {
    if (!item || typeof item.projectRoot !== 'string' || !isAbsolute(item.projectRoot)
      || typeof item.workspaceId !== 'string' || typeof item.name !== 'string'
      || typeof item.lastOpenedAt !== 'string' || Number.isNaN(Date.parse(item.lastOpenedAt))
      || typeof item.pinned !== 'boolean'
      || Object.keys(item).some(key => !['projectRoot', 'workspaceId', 'name', 'lastOpenedAt', 'pinned'].includes(key))) {
      throw new Error('项目历史文件格式无效，请检查 projects.json');
    }
    const key = process.platform === 'win32' ? item.projectRoot.toLowerCase() : item.projectRoot;
    if (roots.has(key)) throw new Error('项目历史文件包含重复项目，请检查 projects.json');
    roots.add(key);
  }
  return value;
}

const sameRoot = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;

export function createProjectHistory(path = projectHistoryPath(), { now = () => new Date() } = {}) {
  const checkPath = async () => {
    for (const item of [dirname(path), path]) {
      try {
        const info = await lstat(item);
        if (info.isSymbolicLink()) throw new Error('项目历史不允许符号链接或目录重定向');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const read = async () => {
    await checkPath();
    try { return validateHistory(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { version: HISTORY_VERSION, items: [] }; throw error; }
  };
  const save = async value => {
    validateHistory(value);
    await mkdir(dirname(path), { recursive: true });
    const temporary = path + '.' + randomUUID() + '.tmp';
    let committed = false;
    try {
      await writeExclusive(temporary, JSON.stringify(value) + '\n');
      await checkPath();
      await rename(temporary, path); committed = true;
      return await read();
    } catch (error) {
      if (committed) { error.code = 'SAVE_UNCERTAIN'; throw error; }
      try { await unlink(temporary); } catch (cleanup) {
        if (cleanup.code !== 'ENOENT') error.message += '；清理失败：' + cleanup.message;
      }
      throw error;
    }
  };
  const mutate = operation => {
    const queue = historyQueues.get(path) ?? Promise.resolve();
    const result = queue.then(async () => save(await operation(await read())));
    historyQueues.set(path, result.catch(() => {}));
    return result;
  };
  const requireRoot = value => {
    if (typeof value !== 'string' || !isAbsolute(value)) fail('ABSOLUTE_PATH_REQUIRED', '项目路径必须是绝对路径');
    return resolve(value);
  };
  return {
    read,
    record({ projectRoot, workspaceId, name }) {
      const root = requireRoot(projectRoot);
      return mutate(history => {
        const previous = history.items.find(item => sameRoot(item.projectRoot, root));
        const current = { projectRoot: root, workspaceId, name, lastOpenedAt: now().toISOString(), pinned: previous?.pinned ?? false };
        const others = history.items.filter(item => !sameRoot(item.projectRoot, root));
        const pinned = others.filter(item => item.pinned);
        const recent = [current, ...others.filter(item => !item.pinned)]
          .filter(item => !item.pinned).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)).slice(0, RECENT_LIMIT);
        return { version: HISTORY_VERSION, items: current.pinned ? [current, ...pinned, ...recent] : [...pinned, ...recent] };
      });
    },
    pin(body) {
      const root = requireRoot(body?.projectRoot);
      if (typeof body?.pinned !== 'boolean') fail('INVALID_PROJECT_HISTORY', '置顶操作必须提供 pinned 布尔值');
      return mutate(history => {
        const item = history.items.find(entry => sameRoot(entry.projectRoot, root));
        if (!item) fail('PROJECT_HISTORY_NOT_FOUND', '项目不在快捷记录中：' + root);
        item.pinned = body.pinned;
        history.items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpenedAt.localeCompare(a.lastOpenedAt));
        return history;
      });
    },
    remove(body) {
      const root = requireRoot(body?.projectRoot);
      return mutate(history => ({ version: HISTORY_VERSION,
        items: history.items.filter(item => !sameRoot(item.projectRoot, root)) }));
    },
  };
}

async function ordinaryAbsoluteDirectory(requested) {
  if (typeof requested !== 'string' || !isAbsolute(requested)) fail('ABSOLUTE_PATH_REQUIRED', '目录浏览必须提供绝对路径');
  const absolute = resolve(requested), root = parse(absolute).root;
  let cursor = root;
  const remainder = relative(root, absolute).split(sep).filter(Boolean);
  for (const part of remainder) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail('SYMLINK_REJECTED', '不能进入符号链接或目录重定向：' + cursor);
  }
  const info = await lstat(absolute);
  if (!info.isDirectory()) fail('DIRECTORY_REQUIRED', '路径不是目录：' + absolute);
  return realpath(absolute);
}

export async function directoryRoots() {
  if (process.platform !== 'win32') return [{ name: '/', path: '/', accessible: true, symlink: false }];
  const candidates = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  const inspected = await Promise.all(candidates.map(async path => {
    try {
      const info = await lstat(path);
      return info.isDirectory() && !info.isSymbolicLink() ? { name: path, path, accessible: true, symlink: false } : null;
    } catch { return null; }
  }));
  return inspected.filter(Boolean);
}

export async function browseDirectories(requested) {
  if (requested === null || requested === undefined || requested === '') return { roots: await directoryRoots() };
  const absolutePath = await ordinaryAbsoluteDirectory(requested);
  const root = parse(absolutePath).root;
  const entries = [];
  for (const entry of (await readdir(absolutePath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = resolve(absolutePath, entry.name);
    let symlink = entry.isSymbolicLink(), accessible = entry.isDirectory() && !symlink;
    try {
      const info = await lstat(path);
      symlink = info.isSymbolicLink();
      accessible = info.isDirectory() && !symlink;
    } catch { accessible = false; }
    entries.push({ name: entry.name, path, accessible, symlink });
  }
  return { absolutePath, parentPath: absolutePath === root ? null : dirname(absolutePath), entries };
}

async function inspectProject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.projectRoot !== 'string'
    || !isAbsolute(body.projectRoot)) fail('ABSOLUTE_PATH_REQUIRED', '项目预检必须提供绝对 projectRoot');
  let projectRoot;
  try { projectRoot = await ordinaryAbsoluteDirectory(body.projectRoot); }
  catch (error) {
    return { result: { projectRoot: resolve(body.projectRoot), status: 'invalid', error: error.code ?? 'PROJECT_INVALID', message: error.message } };
  }
  const workspaceRoot = resolve(projectRoot, WORKSPACE_DIRECTORY);
  try {
    const marker = await lstat(workspaceRoot);
    if (marker.isSymbolicLink() || !marker.isDirectory()) {
      return { result: { projectRoot, status: 'invalid', error: marker.isSymbolicLink() ? 'SYMLINK_REJECTED' : 'DIRECTORY_REQUIRED',
        message: `${WORKSPACE_DIRECTORY} 必须是普通目录` } };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') return { result: { projectRoot, status: 'invalid', error: error.code ?? 'PROJECT_INVALID', message: error.message } };
    const basename = parse(projectRoot).name;
    const idProblem = semanticIdProblem(basename);
    const rootInfo = await lstat(projectRoot);
    return { result: { projectRoot, status: 'missing', workspaceRoot, workspaceName: basename,
      workspaceId: idProblem ? null : basename, requiredMetadata: idProblem ? ['id'] : [], willInitialize: true },
      fingerprint: `missing:${rootInfo.dev}:${rootInfo.ino}:${rootInfo.mtimeMs}` };
  }
  try {
    // 预检只判断 canonical 是否可打开；生成文档目录的问题由打开后的导出状态处理。
    const context = await projectContext(projectRoot, { allowMissingExport: true, allowUnavailableExport: true });
    const workspace = await readWorkspace(context.workspaceRoot, { context });
    return { result: { projectRoot: context.projectRoot, status: 'existing', workspaceRoot: context.workspaceRoot,
      workspaceName: workspace.manifest.name, workspaceId: workspace.manifest.id, requiredMetadata: [], willInitialize: false },
      // 既有工作区的内容可由另一个合法写入者持续变化。预检只确认“仍是同一个可打开的工作区”，
      // 不把规则 revision 当作打开凭据；真正读取由 open/store 在切换时完成。
      fingerprint: `existing:${workspace.manifest.id}` };
  } catch (error) {
    return { result: { projectRoot, status: 'invalid', workspaceRoot, error: error.code ?? 'PROJECT_INVALID', message: error.message } };
  }
}

export function createProjectPreflight({ lifetimeMs = 2 * 60 * 1000, now = () => Date.now() } = {}) {
  const selections = new Map();
  const clean = () => {
    const current = now();
    for (const [token, selection] of selections) if (selection.expiresAt <= current) selections.delete(token);
  };
  return {
    async inspect(body) {
      clean();
      const inspected = await inspectProject(body);
      if (inspected.result.status === 'invalid') return inspected.result;
      const selectionToken = randomUUID(), expiresAt = now() + lifetimeMs;
      selections.set(selectionToken, { projectRoot: inspected.result.projectRoot, status: inspected.result.status,
        fingerprint: inspected.fingerprint, expiresAt });
      return { ...inspected.result, selectionToken, selectionExpiresAt: new Date(expiresAt).toISOString(),
        allowedIntent: inspected.result.status === 'existing' ? 'existing' : 'initialize' };
    },
    async verify(body) {
      clean();
      if (!body || typeof body.selectionToken !== 'string') fail('PROJECT_PREFLIGHT_REQUIRED', '打开项目必须先完成项目预检');
      if (!['existing', 'initialize'].includes(body.intent)) fail('PROJECT_INTENT_REQUIRED', '打开项目必须明确 existing 或 initialize 意图');
      const selection = selections.get(body.selectionToken);
      selections.delete(body.selectionToken);
      if (!selection) fail('PROJECT_PREFLIGHT_STALE', '项目预检已过期，请重新检查目录');
      if (typeof body.projectRoot !== 'string' || !isAbsolute(body.projectRoot)) fail('ABSOLUTE_PATH_REQUIRED', '打开项目必须提供绝对 projectRoot');
      const requested = resolve(body.projectRoot);
      if (!sameRoot(requested, selection.projectRoot)) fail('PROJECT_PREFLIGHT_STALE', '打开路径与预检路径不一致，请重新检查目录');
      const expectedIntent = selection.status === 'existing' ? 'existing' : 'initialize';
      if (body.intent !== expectedIntent) fail('PROJECT_INTENT_MISMATCH', `该目录预检结果要求 ${expectedIntent} 意图`);
      const inspected = await inspectProject({ projectRoot: requested });
      if (inspected.result.status !== selection.status || inspected.fingerprint !== selection.fingerprint
        || !sameRoot(inspected.result.projectRoot, selection.projectRoot)) {
        fail('PROJECT_PREFLIGHT_STALE', '项目目录在预检后发生变化，请重新检查目录');
      }
      return inspected.result;
    },
  };
}
