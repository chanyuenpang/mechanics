import { link, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readDocument, workspacePath } from './workspace.mjs';
import { writeExclusive } from './files.mjs';
import { ContractError } from '../domain/validate.mjs';

const STATE_FILE = '.ui-state.json';
const IGNORE_FILE = '.gitignore';
const VERSION = 1;
const RECENT_LIMIT = 8;
const MAX_IGNORE_BYTES = 256 * 1024;

const fail = (code, message) => { throw new ContractError(code, message); };
const emptyState = () => ({ version: VERSION, lastOpened: null, recentViews: [], recentMechanics: [], openTabs: [] });

function recentIds(value, field) {
  if (!Array.isArray(value) || value.length > RECENT_LIMIT || value.some(id => typeof id !== 'string' || !id)) {
    fail('LOCAL_UI_STATE_INVALID', `${field} 必须是不超过 ${RECENT_LIMIT} 个有效资源 ID 的数组`);
  }
  if (new Set(value).size !== value.length) fail('LOCAL_UI_STATE_INVALID', `${field} 不能包含重复资源 ID`);
  return value;
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION
    || Object.keys(value).some(key => !['version', 'lastOpened', 'recentViews', 'recentMechanics', 'openTabs'].includes(key))) {
    fail('LOCAL_UI_STATE_INVALID', '本地界面状态文件格式无效，请修复或删除 .game-graph/.ui-state.json');
  }
  const rawOpenTabs = Array.isArray(value.openTabs) ? value.openTabs : [];
  if (rawOpenTabs.some(tab => !tab || !['view', 'mechanic'].includes(tab.kind) || typeof tab.id !== 'string' || !tab.id)) fail('LOCAL_UI_STATE_INVALID', 'openTabs 必须是有效资源标签数组');
  const lastOpened = value.lastOpened ?? null;
  if (lastOpened !== null && (!lastOpened || !['view', 'mechanic'].includes(lastOpened.kind) || typeof lastOpened.id !== 'string' || !lastOpened.id)) fail('LOCAL_UI_STATE_INVALID', 'lastOpened 必须是有效资源标识或 null');
  // 旧版本允许保留更多标签；收敛为最新的 10 个，避免升级后把本地状态误判为损坏。
  const openTabs = rawOpenTabs.slice(-10);
  return { version: VERSION, lastOpened, recentViews: recentIds(value.recentViews, 'recentViews'), recentMechanics: recentIds(value.recentMechanics, 'recentMechanics'), openTabs };
}

async function replaceText(root, file, text, { create = false } = {}) {
  const path = await workspacePath(root, file, { allowMissing: create, extensions: ['.json', '.gitignore'] });
  const temp = `${path}.${randomUUID()}.game-graph.tmp`;
  let committed = false;
  try {
    await writeExclusive(temp, text);
    await workspacePath(root, file, { allowMissing: create, extensions: ['.json', '.gitignore'] });
    if (create) await link(temp, path); else await rename(temp, path);
    committed = true;
    if (create) await unlink(temp);
    if (await readFile(path, 'utf8') !== text) throw new Error('回读内容不一致');
  } catch (error) {
    if (committed) throw new ContractError('LOCAL_UI_STATE_UNCERTAIN', `本地界面状态已写入但确认失败：${error.message}`);
    try { await unlink(temp); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.message += `；清理失败：${cleanup.message}`; }
    if (create && error.code === 'EEXIST') throw new ContractError('LOCAL_UI_STATE_CONFLICT', '本地界面状态文件已由其他写入者创建，请重新读取。');
    throw error;
  }
}

async function ensureIgnored(root) {
  const path = await workspacePath(root, IGNORE_FILE, { allowMissing: true, extensions: ['.gitignore'] });
  let source = '', create = false;
  try { source = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; create = true; }
  if (Buffer.byteLength(source) > MAX_IGNORE_BYTES) fail('LOCAL_UI_STATE_INVALID', '.game-graph/.gitignore 超过 256 KiB，未修改。');
  if (source.split(/\r?\n/u).some(line => line.trim() === STATE_FILE)) return;
  const next = `${source}${source && !source.endsWith('\n') ? '\n' : ''}${STATE_FILE}\n`;
  await replaceText(root, IGNORE_FILE, next, { create });
}

export function createLocalUiState(workspaceRoot) {
  return {
    async read() {
      try { return validateState((await readDocument(workspaceRoot, STATE_FILE)).document); }
      catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
    },
    async save(value) {
      const state = validateState(value);
      await ensureIgnored(workspaceRoot);
      const path = await workspacePath(workspaceRoot, STATE_FILE, { allowMissing: true });
      let exists = true;
      try { await readFile(path); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
      await replaceText(workspaceRoot, STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { create: !exists });
      return state;
    },
  };
}
