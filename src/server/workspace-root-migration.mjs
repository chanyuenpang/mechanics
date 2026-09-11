import { lstat, realpath, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ContractError } from '../domain/validate.mjs';
import { canonicalProjectRoot, projectContext, WORKSPACE_DIRECTORY } from './project-context.mjs';
import { readWorkspace } from './workspace.mjs';

export const LEGACY_WORKSPACE_DIRECTORY = '.game-graph';

const fail = (code, message, details = {}) => { throw Object.assign(new ContractError(code, message), details); };

async function plainDirectory(path, label) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('WORKSPACE_ROOT_MIGRATION_UNSAFE', `${label}必须是普通目录：${path}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function inspect(projectRoot) {
  const root = await canonicalProjectRoot(projectRoot);
  const legacyRoot = resolve(root, LEGACY_WORKSPACE_DIRECTORY);
  const workspaceRoot = resolve(root, WORKSPACE_DIRECTORY);
  const [legacyExists, workspaceExists] = await Promise.all([
    plainDirectory(legacyRoot, '旧工作区'), plainDirectory(workspaceRoot, '新工作区'),
  ]);
  if (legacyExists && workspaceExists) fail('WORKSPACE_ROOT_MIGRATION_CONFLICT', `同时存在 ${LEGACY_WORKSPACE_DIRECTORY} 与 ${WORKSPACE_DIRECTORY}，拒绝猜测或合并两个 canonical 工作区。`, { legacyRoot, workspaceRoot });
  if (!legacyExists) fail('WORKSPACE_ROOT_MIGRATION_SOURCE_MISSING', `未找到待迁移的 ${LEGACY_WORKSPACE_DIRECTORY}：${root}`, { legacyRoot, workspaceRoot });
  if (workspaceExists) fail('WORKSPACE_ROOT_MIGRATION_TARGET_EXISTS', `${WORKSPACE_DIRECTORY} 已存在，未修改：${root}`, { legacyRoot, workspaceRoot });
  const workspace = await readWorkspace(legacyRoot, { context: {
    projectRoot: root, workspaceRoot: legacyRoot, exportRoot: null, agentExportPath: null, exportStatus: 'unconfigured',
  } });
  return { projectRoot: root, legacyRoot, workspaceRoot, workspaceId: workspace.manifest.id, revision: workspace.revision };
}

export async function migrateWorkspaceRoot(projectRoot, { revision = null, execute = false } = {}) {
  const preview = await inspect(projectRoot);
  if (!execute) return { ok: true, execute: false, status: 'preview', ...preview };
  if (typeof revision !== 'string' || revision !== preview.revision) {
    fail('MIGRATION_PREVIEW_REQUIRED', '执行工作区根迁移必须提供当前预览返回的 revision；未修改任何文件。', { expectedRevision: preview.revision });
  }
  try {
    await rename(preview.legacyRoot, preview.workspaceRoot);
  } catch (error) {
    fail('WORKSPACE_ROOT_MIGRATION_RENAME_FAILED', `无法将 ${LEGACY_WORKSPACE_DIRECTORY} 原子切换为 ${WORKSPACE_DIRECTORY}：${error.message}`, preview);
  }
  try {
    const context = await projectContext(preview.projectRoot, { allowMissingExport: true, allowUnavailableExport: true });
    const workspace = await readWorkspace(preview.workspaceRoot, { context });
    if (workspace.revision !== preview.revision || workspace.manifest.id !== preview.workspaceId) {
      fail('WORKSPACE_ROOT_MIGRATION_VERIFY_FAILED', '新工作区回读结果与预览不一致。');
    }
    return { ok: true, execute: true, status: 'migrated', ...preview };
  } catch (error) {
    try {
      await rename(preview.workspaceRoot, preview.legacyRoot);
    } catch (rollback) {
      fail('WORKSPACE_ROOT_MIGRATION_UNCERTAIN', `新根回读失败且回滚未完成：${error.message}；${rollback.message}`, preview);
    }
    fail('WORKSPACE_ROOT_MIGRATION_VERIFY_FAILED', `新根回读失败，已回滚为 ${LEGACY_WORKSPACE_DIRECTORY}：${error.message}`, preview);
  }
}
