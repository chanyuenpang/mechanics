import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/server/workspace-commands.mjs';
import { projectContext } from '../src/server/project-context.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { publishCatalog } from '../src/server/catalog.mjs';
import { createProjectManager } from '../src/server/project-manager.mjs';

test('项目初始化原子创建固定工作区和默认 Agent 机制文档目录', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-project-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'sample-project'); await mkdir(projectRoot);
  const result = await initProject(projectRoot, { name: '示例项目' });
  assert.equal(result.projectRoot, projectRoot);
  const manifest = JSON.parse(await readFile(join(projectRoot, '.game-graph/workspace.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 10);
  assert.equal(manifest.agentExportPath, 'game-mechanics');
  assert.match(await readFile(join(projectRoot, 'game-mechanics/AGENTS.md'), 'utf8'), /^# Game-Graph Agent 文档使用规则/);
  assert.deepEqual((await readdir(join(projectRoot, 'game-mechanics'))).sort(), ['AGENTS.md', 'README.md', 'concepts.md']);
  assert.deepEqual(result.projectSkills, ['.agents/skills/game-mechanic-search/SKILL.md', '.agents/skills/game-mechanic-modeling/SKILL.md']);
  for (const skill of ['game-mechanic-search', 'game-mechanic-modeling']) {
    assert.equal(await readFile(join(projectRoot, '.agents/skills', skill, 'SKILL.md'), 'utf8'),
      await readFile(fileURLToPath(new URL(`../skills/${skill}/SKILL.md`, import.meta.url)), 'utf8'));
  }
  const workspace = await readWorkspace(join(projectRoot, '.game-graph'));
  assert.equal(workspace.projectRoot, projectRoot);
});

test('项目已有不同 Game-Graph skill 时初始化在创建工作区前拒绝覆盖', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-skill-conflict-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'conflict-project');
  const skillRoot = join(projectRoot, '.agents/skills/game-mechanic-search');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '用户维护的不同 skill');
  await assert.rejects(initProject(projectRoot), { code: 'PROJECT_SKILL_CONFLICT' });
  assert.equal(await readFile(join(skillRoot, 'SKILL.md'), 'utf8'), '用户维护的不同 skill');
  await assert.rejects(access(join(projectRoot, '.game-graph')), { code: 'ENOENT' });
});

test('网页打开既有项目时，仅在建模 skill 版本不一致时更新为安装包版本', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-skill-sync-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'sync-project'); await mkdir(projectRoot);
  await initProject(projectRoot, { name: '同步验证' });
  const target = join(projectRoot, '.agents/skills/game-mechanic-modeling/SKILL.md');
  await writeFile(target, '---\nname: game-mechanic-modeling\ngame-graph-skill-version: "legacy"\n---\n旧版本\n');
  const manager = createProjectManager();
  t.after(() => manager.close());
  await manager.open({ projectRoot, intent: 'existing' });
  const source = await readFile(fileURLToPath(new URL('../skills/game-mechanic-modeling/SKILL.md', import.meta.url)), 'utf8');
  assert.equal(await readFile(target, 'utf8'), source);
});

test('项目路径合同拒绝越界、控制目录和已有工作区覆盖', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-boundary-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'boundary-project'); await mkdir(projectRoot);
  await assert.rejects(projectContext(projectRoot, { requireWorkspace: false, allowMissingExport: true,
    manifest: { agentExportPath: '../outside' } }), { code: 'INVALID_EXPORT_PATH' });
  await assert.rejects(projectContext(projectRoot, { requireWorkspace: false, allowMissingExport: true,
    manifest: { agentExportPath: '.game-graph/docs' } }), { code: 'INVALID_EXPORT_PATH' });
  await mkdir(join(projectRoot, '.game-graph'));
  await writeFile(join(projectRoot, '.game-graph/workspace.json'), '{broken');
  const before = await readFile(join(projectRoot, '.game-graph/workspace.json'), 'utf8');
  await assert.rejects(initProject(projectRoot), { code: 'WORKSPACE_EXISTS' });
  assert.equal(await readFile(join(projectRoot, '.game-graph/workspace.json'), 'utf8'), before);
});

test('Agent 导出不会接管已有普通目录', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-export-owner-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'owned-project'); await mkdir(projectRoot);
  await initProject(projectRoot);
  const workspace = await readWorkspace(join(projectRoot, '.game-graph'));
  const occupied = join(projectRoot, 'docs/game-mechanics'); await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, 'notes.md'), '用户文件');
  await assert.rejects(publishCatalog(occupied, workspace), { code: 'EXPORT_ROOT_NOT_OWNED' });
  assert.equal(await readFile(join(occupied, 'notes.md'), 'utf8'), '用户文件');
});
