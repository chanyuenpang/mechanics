import { lstat, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDocument, readWorkspace, discover } from './workspace.mjs';
import { encode, commitFile, writeExclusive, acquireWorkspaceLock } from './files.mjs';
import { assertLegacyManifest, validateWorkspace, ContractError } from '../domain/validate.mjs';

export async function findWorkspace(start = process.cwd()) {
  let directory = await realpath(resolve(start));
  if (!(await lstat(directory)).isDirectory()) throw new ContractError('WORKSPACE_REQUIRED', '工作区位置必须是目录');
  for (;;) {
    try {
      await lstat(resolve(directory, 'workspace.json'));
      // 最近的标记是边界；坏标记报错，不能越过它写到父工作区。
      const { document } = await readDocument(directory, 'workspace.json');
      if (document.kind !== 'workspace') throw new ContractError('INVALID_WORKSPACE_MARKER', '最近的 workspace.json 不是规则工作区：' + directory);
      return directory;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) throw new ContractError('WORKSPACE_NOT_FOUND', '未找到工作区。请先 init <新目录>，或用 --workspace 指定已有目录。');
    directory = parent;
  }
}

export async function initWorkspace(target, { name = '游戏规则工作区', id = 'workspace-' + randomUUID().slice(0, 8) } = {}) {
  if (!target) throw new ContractError('WORKSPACE_REQUIRED', 'init 必须指定一个新的资料目录');
  const root = resolve(target);
  try {
    const parentRoot = await findWorkspace(dirname(root));
    throw new ContractError('NESTED_WORKSPACE', '不能在已有工作区内初始化另一个工作区：' + parentRoot);
  } catch (error) { if (error.code !== 'WORKSPACE_NOT_FOUND') throw error; }
  const manifest = { schemaVersion: 3, kind: 'workspace', id, name, definitions: 'definitions.graph.json', compositions: [], lastView: { graphIds: [], activeLayerId: null, collapsedNodeIds: [], positions: {} } };
  const definitions = { schemaVersion: 1, kind: 'definitions', workspaceId: id, nodes: [], positions: {} };
  validateWorkspace({ manifest, definitions, analyses: [] });
  try { await mkdir(root); }
  catch (error) {
    if (error.code === 'EEXIST') throw new ContractError('WORKSPACE_EXISTS', '初始化目标已存在，未修改：' + root);
    throw error;
  }
  try {
    await writeExclusive(resolve(root, 'definitions.graph.json'), encode(definitions));
    await mkdir(resolve(root, 'analyses'));
    await writeExclusive(resolve(root, '.gitignore'), '.rule-analyzer.lock\n*.rule-analyzer.tmp\n');
    // 最后创建标记，失败不冒充一个可用工作区。
    await writeExclusive(resolve(root, 'workspace.json'), encode(manifest));
    await readWorkspace(root);
    return { root, workspaceId: id };
  } catch (error) { throw new ContractError('INIT_PARTIAL', '初始化未完成，目录已保留供检查：' + root + '；' + error.message); }
}

async function migrationPlan(root) {
  const { document: legacy, raw } = await readDocument(root, 'workspace.json');
  if (legacy.schemaVersion === 3) {
    await readWorkspace(root);
    return { status: 'already-current', root, schemaVersion: 3, message: '已是 v3，未写入。' };
  }
  assertLegacyManifest(legacy);
  const { analyses: registered = [], ...configuration } = legacy;
  const manifest = { ...configuration, schemaVersion: 3 };
  if (legacy.schemaVersion === 1) {
    const definitions = (await readDocument(root, legacy.definitions)).document;
    const analyses = [];
    for (const file of registered) analyses.push((await readDocument(root, file)).document);
    validateWorkspace({ manifest, definitions, analyses });
  }
  const { analysisPaths: discovered } = await discover(root);
  const missing = legacy.schemaVersion === 1 ? registered.filter(file => !discovered.includes(file)) : [];
  const additional = legacy.schemaVersion === 1 ? discovered.filter(file => !registered.includes(file)) : [];
  const report = { root, schemaVersion: legacy.schemaVersion, targetVersion: 3, registered, discovered, missing, additional };
  if (missing.length || additional.length) return { status: 'blocked', ...report };
  const candidate = await readWorkspace(root, { manifestOverride: manifest });
  return { status: 'ready', ...report, manifest, raw, revision: candidate.revision };
}

export async function migrateWorkspace(rootPath, { dryRun = false } = {}) {
  const root = await realpath(resolve(rootPath));
  // 预检没有锁、备份或配置写入；正式迁移必须取得旧服务使用的同一把锁。
  const release = dryRun ? async () => {} : await acquireWorkspaceLock(root);
  try {
    const plan = await migrationPlan(root);
    const { manifest, raw, revision, ...report } = plan;
    if (dryRun || plan.status === 'already-current') return report;
    if (plan.status === 'blocked') {
      throw new ContractError('MIGRATION_FILE_SET_CHANGED', '新旧文件集合不一致，未迁移：' + JSON.stringify(report));
    }
    const backupName = `workspace.v${report.schemaVersion}.backup.json`, backup = resolve(root, backupName);
    try { await writeExclusive(backup, raw); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await readDocument(root, backupName)).raw !== raw) {
        throw new ContractError('BACKUP_CONFLICT', '已有迁移备份内容不同，未修改工作区。');
      }
    }
    const fresh = await migrationPlan(root);
    if (fresh.status !== 'ready' || fresh.revision !== revision || fresh.raw !== raw) {
      throw new ContractError('REVISION_CONFLICT', '迁移期间文件或目录已改变，未修改配置；备份保留供检查。');
    }
    await commitFile(root, 'workspace.json', encode(manifest));
    try { const result = await readWorkspace(root); return { status: 'migrated', root, workspaceId: manifest.id, graphs: result.analyses.length, views: result.views.length, backup: backupName }; }
    catch (error) { throw new ContractError('SAVE_UNCERTAIN', '迁移已提交，回读失败：' + error.message); }
  } finally { await release(); }
}
