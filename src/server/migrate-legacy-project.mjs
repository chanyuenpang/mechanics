import { readDocument, readWorkspace } from './workspace.mjs';
import { migrateWorkspace } from './store.mjs';
import { migrateWorkspaceRoot, LEGACY_WORKSPACE_DIRECTORY } from './workspace-root-migration.mjs';
import { canonicalProjectRoot, projectContext, resolveAgentExportRoot } from './project-context.mjs';
import { registerProjectSkills } from './project-skills.mjs';
import { publishCatalog } from './catalog.mjs';
import { commitFile } from './files.mjs';
import { resolve } from 'node:path';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { ContractError } from '../domain/validate.mjs';

const fail = (code, message, details = {}) => { throw Object.assign(new ContractError(code, message), details); };

async function legacyVersion(projectRoot) {
  const legacyRoot = resolve(projectRoot, LEGACY_WORKSPACE_DIRECTORY);
  const { document } = await readDocument(legacyRoot, 'workspace.json');
  const version = document?.schemaVersion;
  if (![7, 8, 9, 10, 11].includes(version)) fail('MIGRATION_VERSION_UNSUPPORTED', `旧工作区版本不受支持：v${String(version)}`);
  return { legacyRoot, version };
}

const legacySkills = ['game-mechanic-search', 'game-mechanic-modeling'];
const LEGACY_GUIDE_HEADING = '# Game-Graph Agent 文档使用规则';

async function legacySkillCleanupPlan(projectRoot) {
  const root = resolve(projectRoot, '.agents', 'skills');
  const removable = [];
  for (const name of legacySkills) {
    const path = resolve(root, name);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('LEGACY_SKILL_CLEANUP_BLOCKED', `旧 skill 必须是普通目录：${path}`);
      const entries = await readdir(path);
      if (entries.some(entry => entry !== 'SKILL.md')) fail('LEGACY_SKILL_CLEANUP_BLOCKED', `旧 skill 含有未识别文件，拒绝删除：${path}`, { entries });
      removable.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return removable;
}

async function legacyCatalogCleanupPlan(projectRoot, manifest) {
  if (!manifest?.agentExportPath) return null;
  const exportRoot = await resolveAgentExportRoot(projectRoot, manifest.agentExportPath, { allowMissing: true });
  try {
    const info = await lstat(exportRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH', `旧 Agent 文档目录必须是普通目录：${exportRoot}`);
    const guide = await readFile(resolve(exportRoot, 'AGENTS.md'), 'utf8');
    const firstLine = guide.split(/\r?\n/, 1)[0];
    const marker = /<!-- game-graph-agent-docs:v\d+ workspace-id:([^\r\n]+) -->/.exec(guide);
    if (firstLine !== LEGACY_GUIDE_HEADING || marker?.[1] !== manifest.id) {
      fail('LEGACY_CATALOG_CLEANUP_BLOCKED', `旧 Agent 文档目录并非可识别的 Game-Graph 导出，拒绝删除：${exportRoot}`);
    }
    return exportRoot;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function migrateLegacyProject(project, { execute = false } = {}) {
  const projectRoot = await canonicalProjectRoot(project);
  const { legacyRoot, version } = await legacyVersion(projectRoot);
  const legacyWorkspace = await readWorkspace(legacyRoot, { context: {
    projectRoot, workspaceRoot: legacyRoot, exportRoot: null, agentExportPath: null, exportStatus: 'unconfigured',
  } });
  const removableLegacySkills = await legacySkillCleanupPlan(projectRoot);
  const removableLegacyCatalog = await legacyCatalogCleanupPlan(projectRoot, legacyWorkspace.manifest);
  const steps = [];
  for (let from = version; from < 11; from++) steps.push({ from, to: from + 1 });
  if (!execute) return { ok: true, execute: false, projectRoot, legacyRoot, version, steps, removableLegacySkills, removableLegacyCatalog,
    next: '使用 --execute 执行协议升级、根目录切换、skill/tool 注入与文档重建。' };

  for (const step of steps) {
    const preview = await migrateWorkspace(legacyRoot, step);
    await migrateWorkspace(legacyRoot, { ...step, revision: preview.revision, execute: true });
  }
  const upgraded = await readWorkspace(legacyRoot, { context: {
    projectRoot, workspaceRoot: legacyRoot, exportRoot: null, agentExportPath: null, exportStatus: 'unconfigured',
  } });
  const migratedAgentExportPath = upgraded.manifest.agentExportPath === 'game-mechanics' ? 'mechanics' : null;
  if (migratedAgentExportPath) {
    await commitFile(legacyRoot, 'workspace.json', JSON.stringify({ ...upgraded.manifest, agentExportPath: migratedAgentExportPath }, null, 2) + '\n');
  }
  const rootPreview = await migrateWorkspaceRoot(projectRoot);
  const rootResult = await migrateWorkspaceRoot(projectRoot, { revision: rootPreview.revision, execute: true });
  const skills = await registerProjectSkills(projectRoot);
  await Promise.all(removableLegacySkills.map(path => rm(path, { recursive: true, force: false })));
  if (removableLegacyCatalog) await rm(removableLegacyCatalog, { recursive: true, force: false });
  const context = await projectContext(projectRoot, { createExportRoot: true });
  const workspace = await readWorkspace(context.workspaceRoot, { context });
  await publishCatalog(context.exportRoot, workspace);
  return { ok: true, execute: true, projectRoot, workspaceRoot: context.workspaceRoot, workspaceId: workspace.manifest.id,
    revision: workspace.revision, rootResult, removedLegacySkills: removableLegacySkills,
    removedLegacyCatalog: removableLegacyCatalog, migratedAgentExportPath, ...skills };
}
