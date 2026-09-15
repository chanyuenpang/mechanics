import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeExclusive } from './files.mjs';
import { ContractError } from '../domain/validate.mjs';

export const PROJECT_SKILL_DIRECTORY = '.agents/skills';
export const PROJECT_SKILLS = ['mechanics-search', 'mechanics-modeling', 'mechanics-doc'];
export const PROJECT_TOOL_DIRECTORY = '.mechanics/tools';
export const PROJECT_TOOLS = ['workspace-tool.mjs'];
const sourceRoot = fileURLToPath(new URL('../../skills/', import.meta.url));
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const toolSourceRoot = fileURLToPath(new URL('../../workspace-tools/', import.meta.url));
const docSkillReferences = ['docs/安装与Codex接入.md', 'docs/安装与DSH接入.md', 'docs/Codex MCP Apps.md', 'docs/Agent查询接口.md', 'docs/文件协议.md', 'docs/架构设计.md'];

const fail = (code, message, details = {}) => { throw Object.assign(new ContractError(code, message), details); };
const sameContent = (left, right) => left.replace(/\r\n/g, '\n').trimEnd() === right.replace(/\r\n/g, '\n').trimEnd();

async function statOrNull(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertPlainDirectory(path, label) {
  const info = await statOrNull(path);
  if (info && (info.isSymbolicLink() || !info.isDirectory())) fail('PROJECT_SKILL_CONFLICT', `${label} 必须是普通目录：${path}`);
  return info;
}

async function collectFiles(root, relativePath = '') {
  const entries = await readdir(resolve(root, relativePath), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('PROJECT_SKILL_SOURCE_INVALID', `skill 包含不安全条目：${path}`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, path));
    else files.push(path);
  }
  return files.sort();
}

async function sourceSkill(name) {
  const root = resolve(sourceRoot, name), info = await statOrNull(root);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('PROJECT_SKILL_SOURCE_INVALID', `安装包缺少有效 skill：${name}`);
  const sourceFiles = await collectFiles(root);
  if (!sourceFiles.includes('SKILL.md')) fail('PROJECT_SKILL_SOURCE_INVALID', `安装包缺少 SKILL.md：${name}`);
  const files = await Promise.all(sourceFiles.map(async path => ({ path, content: await readFile(resolve(root, path), 'utf8') })));
  if (name === 'mechanics-doc') for (const document of docSkillReferences) {
    const source = resolve(packageRoot, document), info = await statOrNull(source);
    if (!info?.isFile() || info.isSymbolicLink()) fail('PROJECT_SKILL_SOURCE_INVALID', `安装包缺少文档 skill 引用：${document}`);
    files.push({ path: `references/${document.slice('docs/'.length)}`, content: await readFile(source, 'utf8') });
  }
  return { name, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

async function ensureDirectory(path, label) {
  const info = await assertPlainDirectory(path, label);
  if (!info) { try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; await assertPlainDirectory(path, label); } }
}

async function syncProjectTools(projectRoot) {
  const toolsRoot = resolve(projectRoot, PROJECT_TOOL_DIRECTORY); await ensureDirectory(toolsRoot, '项目 .mechanics/tools'); const installed = [];
  for (const name of PROJECT_TOOLS) {
    const source = resolve(toolSourceRoot, name), target = resolve(toolsRoot, name), info = await statOrNull(source);
    if (!info?.isFile() || info.isSymbolicLink()) fail('PROJECT_TOOL_SOURCE_INVALID', `安装包缺少有效工具：${name}`);
    const content = await readFile(source, 'utf8'), existing = await statOrNull(target);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) fail('PROJECT_TOOL_CONFLICT', `项目工具路径已被占用：${target}`);
    if (existing && sameContent(await readFile(target, 'utf8'), content)) continue;
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
  const targetFiles = await collectFiles(root);
  const current = targetFiles.length === skill.files.length && targetFiles.every((path, index) => path === skill.files[index].path)
    && (await Promise.all(skill.files.map(async file => sameContent(await readFile(resolve(root, file.path), 'utf8'), file.content)))).every(Boolean);
  return { ...skill, root, state: current ? 'current' : 'outdated' };
}

export async function preflightProjectSkills(projectRoot) {
  const agentsRoot = resolve(projectRoot, '.agents'), skillsRoot = resolve(agentsRoot, 'skills');
  await assertPlainDirectory(agentsRoot, '项目 .agents'); await assertPlainDirectory(skillsRoot, '项目 .agents/skills');
  const sources = await Promise.all(PROJECT_SKILLS.map(sourceSkill));
  return { agentsRoot, skillsRoot, targets: await Promise.all(sources.map(skill => targetState(skillsRoot, skill))) };
}

export async function registerProjectSkills(projectRoot) {
  let plan = await preflightProjectSkills(projectRoot);
  await ensureDirectory(plan.agentsRoot, '项目 .agents'); await ensureDirectory(plan.skillsRoot, '项目 .agents/skills'); plan = await preflightProjectSkills(projectRoot);
  const installed = [];
  for (const skill of plan.targets.filter(item => item.state === 'missing' || item.state === 'outdated')) {
    const stagingRoot = resolve(plan.skillsRoot, `.${skill.name}.${randomUUID()}.tmp`);
    try {
      await mkdir(stagingRoot);
      for (const file of skill.files) { await mkdir(dirname(resolve(stagingRoot, file.path)), { recursive: true }); await writeExclusive(resolve(stagingRoot, file.path), file.content); }
      if (skill.state === 'missing') await rename(stagingRoot, skill.root);
      else { const backupRoot = resolve(plan.skillsRoot, `.${skill.name}.${randomUUID()}.backup`); await rename(skill.root, backupRoot); try { await rename(stagingRoot, skill.root); } catch (error) { await rename(backupRoot, skill.root); throw error; } await rm(backupRoot, { recursive: true, force: true }); }
      installed.push(`${PROJECT_SKILL_DIRECTORY}/${skill.name}/SKILL.md`);
    } catch (error) { fail('PROJECT_SKILL_REGISTRATION_PARTIAL', `项目 skill 注册未完成；已安装：${installed.join('、') || '无'}；暂存目录：${stagingRoot}；${error.message}`, { installedSkills: installed, stagingRoot }); }
  }
  const installedTools = await syncProjectTools(projectRoot);
  return { projectSkills: PROJECT_SKILLS.map(name => `${PROJECT_SKILL_DIRECTORY}/${name}/SKILL.md`), installedSkills: installed, projectTools: PROJECT_TOOLS.map(name => `${PROJECT_TOOL_DIRECTORY}/${name}`), installedTools };
}
