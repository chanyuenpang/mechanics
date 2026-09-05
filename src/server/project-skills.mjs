import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeExclusive } from './files.mjs';
import { ContractError } from '../domain/validate.mjs';

export const PROJECT_SKILL_DIRECTORY = '.agents/skills';
export const PROJECT_SKILLS = ['game-mechanic-search', 'game-mechanic-modeling'];
const sourceRoot = fileURLToPath(new URL('../../skills/', import.meta.url));

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
  const version = content.match(/^game-graph-skill-version:\s*["']?([^\r\n"']+)["']?\s*$/mu)?.[1]?.trim();
  return { name, content, version };
}

async function targetState(skillsRoot, skill) {
  const root = resolve(skillsRoot, skill.name), info = await statOrNull(root);
  if (!info) return { ...skill, root, state: 'missing' };
  if (info.isSymbolicLink() || !info.isDirectory()) fail('PROJECT_SKILL_CONFLICT', `项目 skill 路径已被占用：${root}`);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== 'SKILL.md' || !entries[0].isFile() || entries[0].isSymbolicLink?.()) {
    fail('PROJECT_SKILL_CONFLICT', `项目 skill 目录包含不同内容，拒绝覆盖：${root}`);
  }
  const current = await readFile(resolve(root, 'SKILL.md'), 'utf8');
  if (sameSkillContent(current, skill.content)) return { ...skill, root, state: 'current' };
  if (!skill.version) fail('PROJECT_SKILL_CONFLICT', `项目 skill 与未版本化的 Game-Graph skill 内容不同，拒绝覆盖：${root}`);
  const version = current.match(/^game-graph-skill-version:\s*["']?([^\r\n"']+)["']?\s*$/mu)?.[1]?.trim();
  if (version === skill.version) fail('PROJECT_SKILL_CONFLICT', `项目 skill 声称与 Game-Graph 相同版本但内容不同，拒绝覆盖：${root}`);
  return { ...skill, root, state: 'outdated', installedVersion: version ?? null };
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
        await rename(resolve(stagingRoot, 'SKILL.md'), resolve(skill.root, 'SKILL.md'));
        await rm(stagingRoot, { recursive: true, force: true });
      }
      installed.push(`${PROJECT_SKILL_DIRECTORY}/${skill.name}/SKILL.md`);
    } catch (error) {
      fail('PROJECT_SKILL_REGISTRATION_PARTIAL', `项目 skill 注册未完成；已安装：${installed.join('、') || '无'}；暂存目录：${stagingRoot}；${error.message}`,
        { installedSkills: installed, stagingRoot });
    }
  }
  return { projectSkills: PROJECT_SKILLS.map(name => `${PROJECT_SKILL_DIRECTORY}/${name}/SKILL.md`), installedSkills: installed };
}
