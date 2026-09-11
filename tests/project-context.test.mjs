import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { initProject } from '../src/server/workspace-commands.mjs';
import { projectContext } from '../src/server/project-context.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { publishCatalog } from '../src/server/catalog.mjs';
import { createProjectManager } from '../src/server/project-manager.mjs';
import { createProjectPreflight } from '../src/server/local-projects.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const exec = promisify(execFile);
const runWorkspaceTool = async (projectRoot, args) => JSON.parse((await exec(process.execPath,
  [join(projectRoot, '.mechanics/tools/workspace-tool.mjs'), ...args], { timeout: 15_000 })).stdout);

test('项目初始化原子创建固定工作区和默认 Agent 机制文档目录', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-project-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'sample-project'); await mkdir(projectRoot);
  const result = await initProject(projectRoot, { name: '示例项目' });
  assert.equal(result.projectRoot, projectRoot);
  const manifest = JSON.parse(await readFile(join(projectRoot, '.mechanics/workspace.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 10);
  assert.equal(manifest.agentExportPath, 'mechanics');
  assert.match(await readFile(join(projectRoot, 'mechanics/AGENTS.md'), 'utf8'), /^# Mechanics Agent 文档使用规则/);
  assert.deepEqual((await readdir(join(projectRoot, 'mechanics'))).sort(), ['AGENTS.md', 'README.md', 'concepts.md']);
  assert.deepEqual(result.projectSkills, ['.agents/skills/mechanics-search/SKILL.md', '.agents/skills/mechanics-modeling/SKILL.md']);
  for (const skill of ['mechanics-search', 'mechanics-modeling']) {
    assert.equal(await readFile(join(projectRoot, '.agents/skills', skill, 'SKILL.md'), 'utf8'),
      await readFile(fileURLToPath(new URL(`../skills/${skill}/SKILL.md`, import.meta.url)), 'utf8'));
  }
  assert.equal(await readFile(join(projectRoot, '.mechanics/tools/workspace-tool.mjs'), 'utf8'),
    await readFile(fileURLToPath(new URL('../workspace-tools/workspace-tool.mjs', import.meta.url)), 'utf8'));
  const workspace = await readWorkspace(join(projectRoot, '.mechanics'));
  assert.equal(workspace.projectRoot, projectRoot);
});

test('项目已有不同 Game-Graph skill 时初始化以安装源整体覆盖', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-skill-conflict-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'conflict-project');
  const skillRoot = join(projectRoot, '.agents/skills/mechanics-search');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '用户维护的不同 skill');
  await writeFile(join(skillRoot, '不应保留.md'), '过期附加文件');
  await initProject(projectRoot, { name: '覆盖验证' });
  const source = await readFile(fileURLToPath(new URL('../skills/mechanics-search/SKILL.md', import.meta.url)), 'utf8');
  assert.equal(await readFile(join(skillRoot, 'SKILL.md'), 'utf8'), source);
  assert.deepEqual(await readdir(skillRoot), ['SKILL.md']);
  await access(join(projectRoot, '.mechanics'));
});

test('网页打开既有项目时，以安装源覆盖内容不一致的建模 skill', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-skill-sync-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'sync-project'); await mkdir(projectRoot);
  await initProject(projectRoot, { name: '同步验证' });
  const target = join(projectRoot, '.agents/skills/mechanics-modeling/SKILL.md');
  const tool = join(projectRoot, '.mechanics/tools/workspace-tool.mjs');
  await writeFile(target, '用户维护但未版本化的不同 skill');
  await rm(tool);
  const manager = createProjectManager();
  t.after(() => manager.close());
  await manager.open({ projectRoot, intent: 'existing' });
  const source = await readFile(fileURLToPath(new URL('../skills/mechanics-modeling/SKILL.md', import.meta.url)), 'utf8');
  assert.equal(await readFile(target, 'utf8'), source);
  assert.equal(await readFile(tool, 'utf8'), await readFile(fileURLToPath(new URL('../workspace-tools/workspace-tool.mjs', import.meta.url)), 'utf8'));
});

test('进入关联项目也会在建立会话前补齐受管 skill 与工具', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-reference-sync-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sourceRoot = join(parent, 'source'), targetRoot = join(parent, 'target'); await mkdir(sourceRoot); await mkdir(targetRoot);
  await initProject(sourceRoot, { id: 'source-project' }); await initProject(targetRoot, { id: 'target-project' });
  const targetTool = join(targetRoot, '.mechanics/tools/workspace-tool.mjs'); await rm(targetTool);
  const manager = createProjectManager(); t.after(() => manager.close());
  const source = await manager.open({ projectRoot: sourceRoot, intent: 'existing' });
  const declared = await manager.declareProjectReference({ projectSessionToken: source.projectSessionToken, projectGeneration: source.projectGeneration, projectRoot: targetRoot });
  await manager.enterReference({ projectSessionToken: source.projectSessionToken, projectGeneration: source.projectGeneration, referenceId: declared.references[0].id });
  assert.equal(await readFile(targetTool, 'utf8'), await readFile(fileURLToPath(new URL('../workspace-tools/workspace-tool.mjs', import.meta.url)), 'utf8'));
});

test('注入的离线工具可在空工作区创建机制并完成草稿保存，不依赖 CLI 或网页', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-offline-tool-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'offline-project'); await mkdir(projectRoot);
  await initProject(projectRoot, { name: '离线建模' });
  const initial = await runWorkspaceTool(projectRoot, ['scopes']);
  assert.deepEqual(initial.mechanics, []);
  const draft = await runWorkspaceTool(projectRoot, ['draft', 'open', '--mechanic', 'core-loop', '--name', '核心循环', '--scope', '最小可玩闭环']);
  assert.equal(draft.target, 'new');
  assert.match(draft.mechanicPath, /mechanic\.json$/u);
  const saved = await runWorkspaceTool(projectRoot, ['draft', 'save', '--draft', draft.draftId]);
  assert.equal(saved.saved, true);
  const final = await runWorkspaceTool(projectRoot, ['scopes']);
  assert.deepEqual(final.mechanics.map(item => item.id), ['core-loop']);
});

test('注入的离线工具将上游查询按规则声明方向序列化', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-offline-query-direction-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'query-project');
  await copyExampleFixture(projectRoot);
  const manager = createProjectManager();
  t.after(() => manager.close());
  await manager.open({ projectRoot, intent: 'existing' });
  const result = await runWorkspaceTool(projectRoot, ['node', '--id', 'health', '--direction', 'upstream', '--hops', '2']);
  const [direct, indirect] = result.paths.upstream;
  assert.equal(direct.chain, 'damage -> health');
  assert.deepEqual(direct.steps.map(step => [step.from, step.to, step.operator]), [['damage', 'health', '->']]);
  assert.equal(indirect.chain, 'melee +> damage -> health');
  assert.deepEqual(indirect.steps.map(step => [step.from, step.to, step.operator]), [['melee', 'damage', '+>'], ['damage', 'health', '->']]);
  assert.equal(indirect.effect, 'negative');
  for (const path of result.paths.upstream) {
    assert.ok(path.steps.every((step, index) => step.from === path.nodes[index].id && step.to === path.nodes[index + 1].id));
  }
});

test('离线草稿先校验语义，失败时 canonical 完整保留', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-offline-validation-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'validation-project'); await mkdir(projectRoot);
  await initProject(projectRoot, { name: '离线校验' });
  const draft = await runWorkspaceTool(projectRoot, ['draft', 'open', '--mechanic', 'core-loop', '--name', '核心循环', '--scope', '最小可玩闭环']);
  const invalid = JSON.parse(await readFile(draft.mechanicPath, 'utf8'));
  invalid.nodeIds = ['missing-concept'];
  await writeFile(draft.mechanicPath, JSON.stringify(invalid, null, 2));
  await assert.rejects(runWorkspaceTool(projectRoot, ['draft', 'validate', '--draft', draft.draftId]), /DRAFT_VALIDATION_FAILED/u);
  await assert.rejects(runWorkspaceTool(projectRoot, ['draft', 'save', '--draft', draft.draftId]), /DRAFT_VALIDATION_FAILED/u);
  await assert.rejects(access(join(projectRoot, '.mechanics/mechanics/core-loop.mechanic.json')), { code: 'ENOENT' });
  await access(draft.mechanicPath);
});

test('项目路径合同拒绝越界、控制目录和已有工作区覆盖', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-boundary-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'boundary-project'); await mkdir(projectRoot);
  await assert.rejects(projectContext(projectRoot, { requireWorkspace: false, allowMissingExport: true,
    manifest: { agentExportPath: '../outside' } }), { code: 'INVALID_EXPORT_PATH' });
  await assert.rejects(projectContext(projectRoot, { requireWorkspace: false, allowMissingExport: true,
    manifest: { agentExportPath: '.mechanics/docs' } }), { code: 'INVALID_EXPORT_PATH' });
  await mkdir(join(projectRoot, '.mechanics'));
  await writeFile(join(projectRoot, '.mechanics/workspace.json'), '{broken');
  const before = await readFile(join(projectRoot, '.mechanics/workspace.json'), 'utf8');
  await assert.rejects(initProject(projectRoot), { code: 'WORKSPACE_EXISTS' });
  assert.equal(await readFile(join(projectRoot, '.mechanics/workspace.json'), 'utf8'), before);
});

test('Agent 导出不会接管已有普通目录', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-export-owner-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'owned-project'); await mkdir(projectRoot);
  await initProject(projectRoot);
  const workspace = await readWorkspace(join(projectRoot, '.mechanics'));
  const occupied = join(projectRoot, 'docs/game-mechanics'); await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, 'notes.md'), '用户文件');
  await assert.rejects(publishCatalog(occupied, workspace), { code: 'EXPORT_ROOT_NOT_OWNED' });
  assert.equal(await readFile(join(occupied, 'notes.md'), 'utf8'), '用户文件');
});

test('导出目录缺失或不可用不阻止 canonical 打开、保存，并在后台自动恢复', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-export-resilience-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'resilient-project'); await mkdir(projectRoot);
  await initProject(projectRoot, { name: '导出韧性' });
  await rm(join(projectRoot, 'mechanics'), { recursive: true });
  const preflight = await createProjectPreflight().inspect({ projectRoot });
  assert.equal(preflight.status, 'existing');
  const manager = createProjectManager(); t.after(() => manager.close());
  const opened = await manager.open({ projectRoot, intent: 'existing' });
  assert.equal(opened.exportPublication.state, 'pending');
  const saved = await manager.save({ projectSessionToken: opened.projectSessionToken, projectGeneration: opened.projectGeneration,
    revision: opened.revision, kind: 'definitions', document: opened.definitions });
  assert.equal(saved.exportPublication.state, 'pending');
  assert.equal((await readWorkspace(join(projectRoot, '.mechanics'))).manifest.name, '导出韧性');
  const generated = await manager.generateDocumentExport({ projectSessionToken: opened.projectSessionToken, projectGeneration: opened.projectGeneration,
    revision: saved.revision });
  assert.ok(['pending', 'current'].includes(generated.exportPublication.state));
  let published;
  for (let index = 0; index < 40; index++) {
    published = await manager.read(opened.projectSessionToken);
    if (published.exportPublication.state !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(published.exportPublication.state, 'current');
  await access(join(projectRoot, 'mechanics', 'README.md'));
  assert.equal((await manager.open({ projectRoot, intent: 'existing' })).exportPublication.state, 'current');

  await rm(join(projectRoot, 'mechanics'), { recursive: true });
  await writeFile(join(projectRoot, 'mechanics'), '不是导出目录');
  const unavailableRoot = join(parent, 'unavailable-project'); await mkdir(unavailableRoot);
  await initProject(unavailableRoot, { name: '不可用导出' });
  await rm(join(unavailableRoot, 'mechanics'), { recursive: true });
  await writeFile(join(unavailableRoot, 'mechanics'), '不是目录');
  const unavailable = await manager.open({ projectRoot: unavailableRoot, intent: 'existing' });
  assert.equal(unavailable.exportPublication.state, 'unavailable');
  assert.equal(unavailable.exportPublication.code, 'UNSAFE_PATH');
});

test('未配置导出路径仍可打开 canonical，且不会自动回填默认目录', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'game-graph-export-unconfigured-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'unconfigured-project'); await mkdir(projectRoot);
  await initProject(projectRoot);
  const manifestPath = join(projectRoot, '.mechanics/workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); delete manifest.agentExportPath;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await rm(join(projectRoot, 'mechanics'), { recursive: true });
  const manager = createProjectManager(); t.after(() => manager.close());
  const opened = await manager.open({ projectRoot, intent: 'existing' });
  assert.equal(opened.exportPublication.state, 'unconfigured');
  assert.equal(opened.agentExportRoot, null);
  assert.equal((await readWorkspace(join(projectRoot, '.mechanics'))).manifest.agentExportPath, undefined);
});
