import { lstat, mkdir, realpath, rename } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDocument, readWorkspace } from './workspace.mjs';
import { encode, writeExclusive } from './files.mjs';
import { validateWorkspace, ContractError } from '../domain/validate.mjs';
import { semanticIdProblem } from '../domain/identity.mjs';
import { publishCatalog } from './catalog.mjs';
import { DEFAULT_AGENT_EXPORT_PATH, WORKSPACE_DIRECTORY, projectContext } from './project-context.mjs';
import { preflightProjectSkills, registerProjectSkills } from './project-skills.mjs';

export async function findProject(start = process.cwd()) {
  let directory = await realpath(resolve(start));
  if (!(await lstat(directory)).isDirectory()) throw new ContractError('PROJECT_REQUIRED', '项目位置必须是目录');
  for (;;) {
    const marker = resolve(directory, WORKSPACE_DIRECTORY, 'workspace.json');
    try {
      await lstat(marker);
      const { document } = await readDocument(resolve(directory, WORKSPACE_DIRECTORY), 'workspace.json');
      if (document.kind !== 'workspace') throw new ContractError('INVALID_WORKSPACE_MARKER', `最近的 ${WORKSPACE_DIRECTORY}/workspace.json 不是规则工作区：${directory}`);
      return directory;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) throw new ContractError('PROJECT_NOT_FOUND', `未找到 ${WORKSPACE_DIRECTORY}。请打开项目或运行 init <项目目录>。`);
    directory = parent;
  }
}

export async function findWorkspace(start = process.cwd()) {
  const projectRoot = await findProject(start);
  return resolve(projectRoot, WORKSPACE_DIRECTORY);
}

export async function initProject(target, { name = '规则模型工作区', id = null, createProjectRoot = true } = {}) {
  if (!target) throw new ContractError('PROJECT_REQUIRED', 'init 必须指定项目目录');
  const requestedRoot = resolve(target);
  id ??= basename(requestedRoot);
  const idProblem = semanticIdProblem(id);
  if (idProblem) throw new ContractError('INVALID_ID', `工作区 ID ${idProblem}：${id}。请用 --id 指定稳定的英文语义 ID。`);
  try {
    const info = await lstat(requestedRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ContractError('PROJECT_REQUIRED', '项目位置必须是普通目录：' + requestedRoot);
  } catch (error) {
    if (!createProjectRoot || error.code !== 'ENOENT') throw error;
    await mkdir(requestedRoot);
  }
  const projectRoot = await realpath(requestedRoot);
  const workspaceRoot = resolve(projectRoot, WORKSPACE_DIRECTORY);
  try {
    await lstat(workspaceRoot);
    throw new ContractError('WORKSPACE_EXISTS', `项目已经包含 ${WORKSPACE_DIRECTORY}，未修改：${projectRoot}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await preflightProjectSkills(projectRoot);

  const manifest = { schemaVersion: 11, kind: 'workspace', id, name, definitions: 'definitions.json', rules: 'rules.json',
    agentExportPath: DEFAULT_AGENT_EXPORT_PATH, compositions: [],
    lastView: { graphIds: [], activeLayerId: null, collapsedNodeIds: [], positions: {} } };
  const definitions = { schemaVersion: 6, kind: 'definitions', workspaceId: id, nodes: [], positions: {} };
  const rules = { schemaVersion: 1, kind: 'rules', workspaceId: id, rules: [] };
  validateWorkspace({ manifest, definitions, rules, mechanics: [] });

  const stagingRoot = resolve(projectRoot, `${WORKSPACE_DIRECTORY}.${randomUUID()}.tmp`);
  await mkdir(stagingRoot);
  try {
    await writeExclusive(resolve(stagingRoot, 'definitions.json'), encode(definitions));
    await writeExclusive(resolve(stagingRoot, 'rules.json'), encode(rules));
    await mkdir(resolve(stagingRoot, 'mechanics'));
    await writeExclusive(resolve(stagingRoot, '.gitignore'), '.mechanics.lock\n*.mechanics.tmp\n');
    await writeExclusive(resolve(stagingRoot, 'workspace.json'), encode(manifest));
    await readWorkspace(stagingRoot, {
      context: { projectRoot, workspaceRoot: stagingRoot, exportRoot: resolve(projectRoot, DEFAULT_AGENT_EXPORT_PATH), agentExportPath: DEFAULT_AGENT_EXPORT_PATH } });
    await rename(stagingRoot, workspaceRoot);
  } catch (error) {
    throw new ContractError('INIT_PARTIAL', `项目工作区初始化未完成，正式 ${WORKSPACE_DIRECTORY} 未被覆盖；暂存目录：${stagingRoot}；${error.message}`);
  }

  try {
    const skills = await registerProjectSkills(projectRoot);
    const context = await projectContext(projectRoot, { manifest, createExportRoot: true });
    const canonical = await readWorkspace(context.workspaceRoot, { context });
    await publishCatalog(context.exportRoot, canonical);
    return { projectRoot, workspaceRoot: context.workspaceRoot, agentExportRoot: context.exportRoot, workspaceId: id, ...skills };
  } catch (error) {
    throw new ContractError('INIT_PARTIAL', `${WORKSPACE_DIRECTORY} 已创建，但项目 skill 注册或 Agent 机制文档发布未完整完成：${error.message}`);
  }
}

export const initWorkspace = initProject;
