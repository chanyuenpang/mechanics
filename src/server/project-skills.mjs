import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeExclusive } from './files.mjs';
import { ContractError } from '../domain/validate.mjs';

export const PROJECT_SKILL_DIRECTORY = '.agents/skills';
export const PROJECT_SKILLS = ['game-mechanic-search', 'game-mechanic-modeling'];
export const PROJECT_TOOL_DIRECTORY = '.game-graph/tools';
export const PROJECT_TOOLS = ['workspace-tool.mjs'];
const sourceRoot = fileURLToPath(new URL('../../skills/', import.meta.url));
const toolSourceRoot = fileURLToPath(new URL('../../workspace-tools/', import.meta.url));

const fail = (code, message, details = {}) => { throw Object.assign(new ContractError(code, message), details); };
const sameSkillContent = (left, right) => left.replace(/\r\n/g, '\n').trimEnd() === right.replace(/\r\n/g, '\n').trimEnd();

async function statOrNull(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertPlainDirectory(path, label) {
  const info = await statOrNull(path);
  if (info && (info.isSymbolicLink() || !info.isDirectory())) fail('PROJECT_SKILL_CONFLICT', `${label} 必须是普通目录：${path}`);
  return info;
}

async function sourceSkill(name) {
  const path = resolve(sourceRoot, name, 'SKILL.md'), info = await statOrNull(path);
  if (!info || info.isSymbolicLink() || !info.isFile()) fail('PROJECT_SKILL_SOURCE_INVALID', `安装包缺少有效 skill：${name}`);
  const content = await readFile(path, 'utf8');
  return { name, content };
}
async function syncProjectTools(projectRoot) {
  const toolsRoot = resolve(projectRoot, PROJECT_TOOL_DIRECTORY); await ensureDirectory(toolsRoot, '项目 .game-graph/tools'); const installed = [];
  for (const name of PROJECT_TOOLS) {
    const source = resolve(toolSourceRoot, name), target = resolve(toolsRoot, name), info = await statOrNull(source);
    if (!info?.isFile() || info.isSymbolicLink()) fail('PROJECT_TOOL_SOURCE_INVALID', `安装包缺少有效工具：${name}`);
    const content = await readFile(source, 'utf8'), existing = await statOrNull(target);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) fail('PROJECT_TOOL_CONFLICT', `项目工具路径已被占用：${target}`);
    if (existing && sameSkillContent(await readFile(target, 'utf8'), content)) continue;
    const staging = resolve(toolsRoot, `.${name}.${randomUUID()}.tmp`); await writeExclusive(staging, content);
    if (!existing) await rename(staging, target);
    else { const backup = resolve(toolsRoot, `.${name}.${randomUUID()}.backup`); await rename(target, backup); try { await rename(staging, target); } catch (error) { await rename(backup, target); throw error; } await rm(backup, { force: true }); }
    installed.push(`${PROJECT_TOOL_DIRECTORY}/${name}`);
  }
  return installed;
}


async function targetState(skillsRoot, skill) {
  const root = resolve(skillsRoot, skill.name), info = await statOrNull(root);
  if (!info) return { ...skill, root, state: 'missing' };
  if (info.isSymbolicLink() || !info.isDirectory()) fail('PROJECT_SKILL_CONFLICT', `项目 skill 路径已被占用：${root}`);
  const entries = await readdir(root, { withFileTypes: true });
  const skillFile = entries.length === 1 && entries[0].name === 'SKILL.md' && entries[0].isFile() && !entries[0].isSymbolicLink?.();
  if (skillFile && sameSkillContent(await readFile(resolve(root, 'SKILL.md'), 'utf8'), skill.content)) return { ...skill, root, state: 'current' };
  // 项目内 skill 是安装源的部署副本，而不是可分叉资产；存在差异时始终以源目录整体替换。
  return { ...skill, root, state: 'outdated' };
}

export async function preflightProjectSkills(projectRoot) {
  const agentsRoot = resolve(projectRoot, '.agents'), skillsRoot = resolve(agentsRoot, 'skills');
  await assertPlainDirectory(agentsRoot, '项目 .agents');
  await assertPlainDirectory(skillsRoot, '项目 .agents/skills');
  const sources = await Promise.all(PROJECT_SKILLS.map(sourceSkill));
  const targets = [];
  for (const skill of sources) targets.push(await targetState(skillsRoot, skill));
  return { agentsRoot, skillsRoot, targets };
}

async function ensureDirectory(path, label) {
  const info = await assertPlainDirectory(path, label);
  if (!info) {
    try { await mkdir(path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await assertPlainDirectory(path, label);
    }
  }
}

export async function registerProjectSkills(projectRoot) {
  let plan = await preflightProjectSkills(projectRoot);
  await ensureDirectory(plan.agentsRoot, '项目 .agents');
  await ensureDirectory(plan.skillsRoot, '项目 .agents/skills');
  plan = await preflightProjectSkills(projectRoot);
  const installed = [];
  for (const skill of plan.targets.filter(item => item.state === 'missing' || item.state === 'outdated')) {
    const stagingRoot = resolve(plan.skillsRoot, `.${skill.name}.${randomUUID()}.tmp`);
    try {
      await mkdir(stagingRoot);
      await writeExclusive(resolve(stagingRoot, 'SKILL.md'), skill.content);
      if (skill.state === 'missing') await rename(stagingRoot, skill.root);
      else {
        const backupRoot = resolve(plan.skillsRoot, `.${skill.name}.${randomUUID()}.backup`);
        await rename(skill.root, backupRoot);
        try { await rename(stagingRoot, skill.root); }
        catch (error) { await rename(backupRoot, skill.root); throw error; }
        await rm(backupRoot, { recursive: true, force: true });
      }
      installed.push(`${PROJECT_SKILL_DIRECTORY}/${skill.name}/SKILL.md`);
    } catch (error) {
      fail('PROJECT_SKILL_REGISTRATION_PARTIAL', `项目 skill 注册未完成；已安装：${installed.join('、') || '无'}；暂存目录：${stagingRoot}；${error.message}`,
        { installedSkills: installed, stagingRoot });
    }
  }
  const installedTools = await syncProjectTools(projectRoot);
  return { projectSkills: PROJECT_SKILLS.map(name => `${PROJECT_SKILL_DIRECTORY}/${name}/SKILL.md`), installedSkills: installed, projectTools: PROJECT_TOOLS.map(name => `${PROJECT_TOOL_DIRECTORY}/${name}`), installedTools };
}
