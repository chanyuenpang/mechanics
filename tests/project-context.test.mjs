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
import { createProjectPreflight } from '../src/server/local-projects.mjs';

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
  assert.equal(await readFile(join(projectRoot, '.game-graph/tools/workspace-tool.mjs'), 'utf8'),
    await readFile(fileURLToPath(new URL('../workspace-tools/workspace-tool.mjs', import.meta.url)), 'utf8'));
  const workspace = await readWorkspace(join(projectRoot, '.game-graph'));
  assert.equal(workspace.projectRoot, projectRoot);
});

test('项目已有不同 Game-Graph skill 时初始化以安装源整体覆盖', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-skill-conflict-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'conflict-project');
  const skillRoot = join(projectRoot, '.agents/skills/game-mechanic-search');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '用户维护的不同 skill');
  await writeFile(join(skillRoot, '不应保留.md'), '过期附加文件');
  await initProject(projectRoot, { name: '覆盖验证' });
  const source = await readFile(fileURLToPath(new URL('../skills/game-mechanic-search/SKILL.md', import.meta.url)), 'utf8');
  assert.equal(await readFile(join(skillRoot, 'SKILL.md'), 'utf8'), source);
  assert.deepEqual(await readdir(skillRoot), ['SKILL.md']);
  await access(join(projectRoot, '.game-graph'));
});

test('网页打开既有项目时，以安装源覆盖内容不一致的建模 skill', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-skill-sync-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'sync-project'); await mkdir(projectRoot);
  await initProject(projectRoot, { name: '同步验证' });
  const target = join(projectRoot, '.agents/skills/game-mechanic-modeling/SKILL.md');
  await writeFile(target, '用户维护但未版本化的不同 skill');
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

test('导出目录缺失或不可用不阻止 canonical 打开、保存，并只能由显式生成恢复', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-export-resilience-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'resilient-project'); await mkdir(projectRoot);
  await initProject(projectRoot, { name: '导出韧性' });
  await rm(join(projectRoot, 'game-mechanics'), { recursive: true });
  const preflight = await createProjectPreflight().inspect({ projectRoot });
  assert.equal(preflight.status, 'existing');
  const manager = createProjectManager(); t.after(() => manager.close());
  const opened = await manager.open({ projectRoot, intent: 'existing' });
  assert.equal(opened.exportPublication.state, 'missing');
  const saved = await manager.save({ projectSessionToken: opened.projectSessionToken, projectGeneration: opened.projectGeneration,
    revision: opened.revision, kind: 'definitions', document: opened.definitions });
  assert.equal(saved.exportPublication.state, 'missing');
  assert.equal((await readWorkspace(join(projectRoot, '.game-graph'))).manifest.name, '导出韧性');
  const generated = await manager.generateDocumentExport({ projectSessionToken: opened.projectSessionToken, projectGeneration: opened.projectGeneration,
    revision: saved.revision });
  assert.equal(generated.exportPublication.state, 'current');
  await access(join(projectRoot, 'game-mechanics', 'README.md'));
  assert.equal((await manager.open({ projectRoot, intent: 'existing' })).exportPublication.state, 'current');

  await rm(join(projectRoot, 'game-mechanics'), { recursive: true });
  await writeFile(join(projectRoot, 'game-mechanics'), '不是导出目录');
  const unavailableRoot = join(parent, 'unavailable-project'); await mkdir(unavailableRoot);
  await initProject(unavailableRoot, { name: '不可用导出' });
  await rm(join(unavailableRoot, 'game-mechanics'), { recursive: true });
  await writeFile(join(unavailableRoot, 'game-mechanics'), '不是目录');
  const unavailable = await manager.open({ projectRoot: unavailableRoot, intent: 'existing' });
  assert.equal(unavailable.exportPublication.state, 'unavailable');
  assert.equal(unavailable.exportPublication.code, 'UNSAFE_PATH');
});

test('未配置导出路径仍可打开 canonical，且不会自动回填默认目录', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-export-unconfigured-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'unconfigured-project'); await mkdir(projectRoot);
  await initProject(projectRoot);
  const manifestPath = join(projectRoot, '.game-graph/workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); delete manifest.agentExportPath;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await rm(join(projectRoot, 'game-mechanics'), { recursive: true });
  const manager = createProjectManager(); t.after(() => manager.close());
  const opened = await manager.open({ projectRoot, intent: 'existing' });
  assert.equal(opened.exportPublication.state, 'unconfigured');
  assert.equal(opened.agentExportRoot, null);
  assert.equal((await readWorkspace(join(projectRoot, '.game-graph'))).manifest.agentExportPath, undefined);
});
