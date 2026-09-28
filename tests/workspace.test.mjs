import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir, rename, readdir, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspace } from '../src/server/workspace.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { initWorkspace, findProject, findWorkspace } from '../src/server/workspace-commands.mjs';
import { publishCatalog } from '../src/server/catalog.mjs';
import packageInfo from '../package.json' with { type: 'json' };
import { copyExampleFixture } from './example-fixture.mjs';
import { CURRENT_WORKSPACE_VERSION, WORKSPACE_MIGRATION_STEPS } from '../src/server/migration.mjs';

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
const cli = fileURLToPath(new URL('../src/server/cli.mjs', import.meta.url));
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'rule-workspace-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const projectRoot = join(temp, '资料 目录'); await copyExampleFixture(projectRoot);
  const root = join(projectRoot, '.mechanics');
  const workspace = await readWorkspace(root);
  return { temp, projectRoot, root, workspace };
}
async function downgradeFixtureToV10(projectRoot) {
  const root = join(projectRoot, '.mechanics'), workspace = await readWorkspace(root);
  const manifestPath = join(root, 'workspace.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const rules = JSON.parse(await readFile(join(root, 'rules.json'), 'utf8'));
  await rename(join(root, 'definitions.json'), join(root, 'definitions.graph.json'));
  const definitionsPath = join(root, 'definitions.graph.json'), definitions = JSON.parse(await readFile(definitionsPath, 'utf8'));
  definitions.schemaVersion = 5; delete definitions.tagDefinitions;
  for (const node of definitions.nodes) delete node.tagIds;
  await writeFile(definitionsPath, JSON.stringify(definitions, null, 2) + '\n');
  for (const mechanic of workspace.mechanics) {
    const path = join(root, workspace.files.find(file => file.kind === 'mechanic' && file.id === mechanic.id).path);
    const legacy = { ...mechanic, schemaVersion: 6, nodeIds: mechanic.focusNodeIds, edges: rules.rules.filter(rule => mechanic.pinnedRuleIds.includes(rule.id)) };
    delete legacy.focusNodeIds; delete legacy.pinnedRuleIds; delete legacy.nodeColors; delete legacy.nodeStyles;
    await writeFile(path, JSON.stringify(legacy, null, 2) + '\n');
  }
  for (const view of workspace.views) {
    const path = join(root, workspace.files.find(file => file.kind === 'view' && file.id === view.id).path);
    await writeFile(path, JSON.stringify({ ...view, schemaVersion: 3 }, null, 2) + '\n');
  }
  const v10 = { ...manifest, schemaVersion: 10, definitions: 'definitions.graph.json' };
  delete v10.rules; await writeFile(manifestPath, JSON.stringify(v10, null, 2) + '\n');
  await unlink(join(root, 'rules.json'));
}
function call(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 15000 });
  if (result.error) throw result.error;
  return result;
}
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject); request.end();
  });
}
async function snapshot(root) {
  const result = {};
  for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (file.isFile()) { const path = join(file.parentPath, file.name); result[path] = await readFile(path, 'utf8'); }
  }
  return result;
}

test('顶层和常用子命令帮助与包版本及当前迁移链一致', () => {
  for (const args of [['--help'], ['migrate', '--help'], ['agent', 'guide', '--help'], ['references', 'list', '--help'], ['repair', 'projection-positions', '--help']]) {
    const result = call(args, example);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(result.stdout.startsWith(`Mechanics ${packageInfo.version} ·`));
    assert.match(result.stdout, new RegExp(`当前工作区协议为 v${CURRENT_WORKSPACE_VERSION}`));
    assert.doesNotMatch(result.stdout, /固定 v11 工作区|旧版本只能通过显式 migrate/);
    for (const [from, to] of Object.entries(WORKSPACE_MIGRATION_STEPS)) {
      assert.ok(result.stdout.includes(`--from ${from} --to ${to}`), `缺少 v${from} → v${to}`);
    }
  }
});

test('CLI 在仓库外初始化项目，子目录定位同一项目，显式目标优先且不覆盖已有工作区', async t => {
  const { temp, projectRoot } = await fixture(t);
  const target = join(temp, '另一个 工作区');
  assert.equal(call(['--help'], temp).status, 0);
  assert.equal(call(['--version'], temp).stdout.trim(), packageInfo.version);
  const init = call(['init', target, '--name', '规则资料', '--id', 'another-game'], temp);
  assert.equal(init.status, 0, init.stderr);
  const filesBefore = await snapshot(target);
  assert.equal(call(['init', target], temp).status, 1);
  assert.deepEqual(await snapshot(target), filesBefore);
  const child = join(target, '.mechanics', 'mechanics');
  assert.equal(call(['root'], child).stdout.trim(), await realpath(target));
  assert.equal(call(['root', '--project', projectRoot], child).stdout.trim(), await realpath(projectRoot));
  const validated = call(['validate'], child);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).workspaceId, 'another-game');
  const rebuilt = call(['catalog'], child);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(JSON.parse(rebuilt.stdout).concepts, 0);
  const semanticTarget = join(temp, 'semantic-workspace');
  assert.equal(call(['init', semanticTarget], temp).status, 0);
  assert.equal(JSON.parse(await readFile(join(semanticTarget, '.mechanics', 'workspace.json'), 'utf8')).id, 'semantic-workspace');
  assert.equal(call(['init', join(temp, '中文 工作区')], temp).status, 1);
  assert.equal(call(['validate', '--project', child], temp).status, 1);
  for (const args of [['web', '--port', 'NaN'], ['web', '--port', '65536'], ['validate', '--port', '2'], ['migrate'], ['unknown'], ['web', 'extra'], ['serve']]) {
    assert.equal(call(args, child).status, 1, args.join(' '));
  }
  await assert.rejects(initWorkspace(target, { id: 'another-game' }), { code: 'WORKSPACE_EXISTS' });
});

test('web 无需项目路径，从普通目录或已有项目子目录启动都等待网页选择项目', async t => {
  const { temp, root } = await fixture(t);
  assert.match(call(['--help'], temp).stdout, /mech web/);
  for (const cwd of [temp, join(root, 'mechanics')]) {
    const child = spawn(process.execPath, [cli, 'web', '--port', '0'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise((accept, reject) => {
        let output = '', errors = '';
        const timer = setTimeout(() => reject(new Error('web 启动超时：' + errors)), 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error('web 提前退出：' + code + ' ' + errors)); });
        child.stderr.on('data', chunk => { errors += chunk; });
        child.stdout.on('data', chunk => {
          output += chunk;
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
          if (match) { clearTimeout(timer); accept(match[0]); }
        });
      });
      assert.equal((await httpGet(url)).status, 200);
      assert.deepEqual(JSON.parse((await httpGet(url + 'api/project')).body), { status: 'empty', projectGeneration: 0 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(accept => child.once('exit', accept));
        child.kill('SIGTERM');
        await exited;
      }
    }
  }
});

test('web --project 打开 v10 工作区时按迁移链自动升级到当前协议', async t => {
  const { projectRoot, root } = await fixture(t);
  await downgradeFixtureToV10(projectRoot);
  // 直接读取仍是只读兼容模型，不写文件。
  const compatibility = await readWorkspace(root);
  assert.equal(compatibility.compatibilityMode, true);
  assert.ok(compatibility.rules.rules.length > 0, '旧机制图中的内嵌边必须形成临时规则库');
  assert.equal(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).schemaVersion, 10);
  const child = spawn(process.execPath, [cli, 'web', '--project', projectRoot, '--port', '0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((accept, reject) => {
      let output = '', errors = '';
      const timer = setTimeout(() => reject(new Error('v10 web 启动超时：' + errors)), 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('v10 web 提前退出：' + code + ' ' + errors)); });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) { clearTimeout(timer); accept(match[0]); }
      });
    });
    const project = JSON.parse((await httpGet(url + 'api/project')).body);
    assert.equal(project.status, 'active');
    // 打开项目会把可迁移的旧协议逐级升级并落盘：v10 → v12 → v13 → v14。
    const onDisk = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'));
    assert.equal(onDisk.schemaVersion, 14);
    const served = JSON.parse((await httpGet(url + 'api/workspace')).body);
    assert.equal(served.manifest.schemaVersion, 14);
    assert.equal(served.compatibilityMode, false);
    assert.ok(served.mechanics.every(item => item.schemaVersion === 9 && item.implementationStatus === 'design' && item.taxonomyPresentation.mode === 'label'));
    assert.ok(served.views.every(item => item.schemaVersion === 5));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(accept => child.once('exit', accept)); child.kill('SIGTERM'); await exited;
    }
  }
});

test('兼容模式可原样保存机制图展示数据，但拒绝结构编辑', async t => {
  const { projectRoot, root } = await fixture(t);
  await downgradeFixtureToV10(projectRoot);
  const store = await createWorkspaceStore(root);
  try {
    const opened = await store.read();
    const mechanic = opened.mechanics.find(item => item.id === 'hand');
    const document = { ...mechanic, positions: { ...mechanic.positions, player: { x: 420, y: 260 } }, routeCache: { version: 1, routes: [] } };
    await store.save({ revision: opened.revision, kind: 'mechanic', id: mechanic.id, document });
    const rawPath = join(root, opened.files.find(file => file.kind === 'mechanic' && file.id === mechanic.id).path);
    const raw = JSON.parse(await readFile(rawPath, 'utf8'));
    assert.equal(raw.schemaVersion, 6);
    assert.ok(Array.isArray(raw.nodeIds));
    assert.deepEqual(raw.positions.player, { x: 420, y: 260 });
    await assert.rejects(store.save({ revision: (await store.read()).revision, kind: 'mechanic', id: mechanic.id,
      document: { ...document, name: '不应允许的结构修改' } }), { code: 'COMPATIBILITY_STRUCTURE_READ_ONLY' });
  } finally { await store.close(); }
});

test('固定工作区坏标记和缺少核心资料的未知版本明确失败', async t => {
  const { root } = await fixture(t);
  const child = join(root, 'mechanics');
  await writeFile(join(root, 'workspace.json'), '{bad');
  await assert.rejects(findProject(child), { code: 'INVALID_JSON' });
  assert.match(call(['root'], child).stderr, /INVALID_JSON/);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ kind: 'workspace', schemaVersion: 999 }));
  assert.match(call(['validate'], child).stderr, /INVALID_WORKSPACE_MARKER/);
  await assert.rejects(readWorkspace(root), { code: 'UNSAFE_PATH' });
});

test('目录扫描发现新增、移动和空目录；稳定 ID 恢复视图，旧版本保存拒绝', async t => {
  const { root, workspace } = await fixture(t);
  const store = await createWorkspaceStore(root);
  try {
    const manifest = { ...workspace.manifest, lastView: { graphIds: ['hand'], activeLayerId: 'hand', collapsedNodeIds: [], positions: {} } };
    const selected = await store.save({ revision: workspace.revision, kind: 'workspace', document: manifest });
    await mkdir(join(root, '关卡/空目录'), { recursive: true });
    await rename(join(root, 'mechanics/hand.mechanic.json'), join(root, '关卡/手牌.mechanic.json'));
    await assert.rejects(store.save({ revision: selected.revision, kind: 'workspace', document: manifest }), { code: 'REVISION_CONFLICT' });
    let canonical = await readWorkspace(root, { verifyGeneratedCatalog: false });
    await mkdir(canonical.agentExportRoot, { recursive: true });
    await publishCatalog(canonical.agentExportRoot, canonical);
    const moved = await store.read();
    assert.equal(moved.files.find(file => file.id === 'hand').path, '关卡/手牌.mechanic.json');
    assert.ok(moved.directories.includes('关卡/空目录'));
    assert.deepEqual(moved.manifest.lastView, manifest.lastView);
    const graph = { ...moved.mechanics.find(graph => graph.id === 'hand'), id: 'external', focusNodeIds: [], pinnedRuleIds: [] };
    await writeFile(join(root, '关卡/外部.mechanic.json'), JSON.stringify(graph));
    canonical = await readWorkspace(root, { verifyGeneratedCatalog: false });
    await publishCatalog(canonical.agentExportRoot, canonical);
    const fresh = await store.read(); assert.equal(fresh.mechanics.length, 4);
    const hand = { ...fresh.mechanics.find(graph => graph.id === 'hand'), name: '移动后保存' };
    await store.save({ revision: fresh.revision, kind: 'mechanic', id: hand.id, document: hand });
    assert.equal(JSON.parse(await readFile(join(root, '关卡/手牌.mechanic.json'), 'utf8')).name, hand.name);
    await assert.rejects(readFile(join(root, 'mechanics/hand.mechanic.json')), { code: 'ENOENT' });
    await rm(join(root, '关卡/手牌.mechanic.json'));
    await assert.rejects(store.read(), { code: 'MISSING_REFERENCE' });
  } finally { await store.close(); }
});

test('扫描不吞掉坏文件、重复 ID；隐藏目录明确排除', async t => {
  const { root, workspace } = await fixture(t);
  await mkdir(join(root, '.draft')); await writeFile(join(root, '.draft/bad.mechanic.json'), '{bad');
  assert.equal((await readWorkspace(root)).mechanics.length, 3);
  const extra = join(root, 'bad.mechanic.json'); await writeFile(extra, '{bad');
  await assert.rejects(readWorkspace(root), { code: 'INVALID_JSON' });
  await writeFile(extra, JSON.stringify(workspace.mechanics[0]));
  await assert.rejects(readWorkspace(root), { code: 'DUPLICATE_ID' });
  await rm(extra);
  assert.equal((await readWorkspace(root)).revision, workspace.revision);
});

test('单个机制图的缺失引用不会阻断项目读取、查询或其他机制图', async t => {
  const { root, workspace } = await fixture(t);
  const target = workspace.mechanics.find(item => item.id === 'hand');
  const path = join(root, workspace.files.find(file => file.kind === 'mechanic' && file.id === target.id).path);
  await writeFile(path, JSON.stringify({ ...target, focusNodeIds: [...target.focusNodeIds, 'player-damage'] }, null, 2));
  await assert.rejects(readWorkspace(root), { code: 'MISSING_REFERENCE' });
  const isolated = await readWorkspace(root, { isolateResources: true });
  assert.equal(isolated.workspaceState, 'degraded');
  assert.ok(!isolated.mechanics.some(item => item.id === target.id));
  assert.match(isolated.resourceDiagnostics[0].message, /player-damage/);
  const store = await createWorkspaceStore(root, { isolateResources: true });
  try {
    const available = await store.read();
    assert.equal(available.workspaceState, 'degraded');
    assert.ok(available.mechanics.length === workspace.mechanics.length - 1);
  } finally { await store.close(); }
});

test('批量移出机制节点只清理真正无引用的概念', async t => {
  const { root, workspace } = await fixture(t), store = await createWorkspaceStore(root);
  try {
    const mechanic = workspace.mechanics.find(item => item.focusNodeIds.length >= 2);
    const [first, second] = mechanic.focusNodeIds;
    const result = await store.removeMechanicNodes({ revision: workspace.revision, mechanicId: mechanic.id, nodeIds: [first, second] });
    assert.deepEqual(result.removedFromGraphIds, [first, second]);
    const reopened = await readWorkspace(root);
    assert.ok(!reopened.mechanics.find(item => item.id === mechanic.id).focusNodeIds.includes(first));
    assert.ok(!reopened.mechanics.find(item => item.id === mechanic.id).focusNodeIds.includes(second));
    for (const id of result.prunedConceptIds) assert.ok(!reopened.definitions.nodes.some(node => node.id === id));
    for (const id of result.retainedConceptIds) assert.ok(reopened.definitions.nodes.some(node => node.id === id));
  } finally { await store.close(); }
});

test('只要核心拓扑可读，旧版本工作区可兼容读取且 CLI 不提供隐式迁移入口', async t => {
  const { root } = await fixture(t);
  const path = join(root, 'workspace.json'), current = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...current, schemaVersion: 4 }));
  const compatible = await readWorkspace(root);
  assert.equal(compatible.compatibilityMode, true);
  assert.ok(compatible.rules.rules.length > 0);
  const result = call(['migrate', '--workspace', root], root);
  assert.equal(result.status, 1); assert.match(result.stderr, /未知参数|Unknown option/);
});

test('未来版本的缺失布局与未知展示字段只进入兼容诊断，不阻断核心拓扑', async t => {
  const { root, workspace } = await fixture(t);
  const manifestPath = join(root, 'workspace.json'), definitionsPath = join(root, workspace.manifest.definitions);
  const mechanic = workspace.mechanics.find(item => item.id === 'hand');
  const mechanicPath = join(root, workspace.files.find(file => file.kind === 'mechanic' && file.id === mechanic.id).path);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const definitions = JSON.parse(await readFile(definitionsPath, 'utf8'));
  delete definitions.positions; definitions.visualTheme = { future: true };
  delete mechanic.positions; mechanic.visualTheme = 'future-layout';
  await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 13, visualTheme: { future: true } }));
  await writeFile(definitionsPath, JSON.stringify(definitions));
  await writeFile(mechanicPath, JSON.stringify(mechanic));
  const opened = await readWorkspace(root);
  assert.equal(opened.compatibilityMode, true);
  assert.equal(opened.definitions.nodes.length, workspace.definitions.nodes.length);
  assert.equal(opened.rules.rules.length, workspace.rules.rules.length);
  assert.ok(opened.mechanics.some(item => item.id === mechanic.id));
  assert.ok(opened.presentationDiagnostics.some(item => item.code === 'COMPATIBILITY_READ'));
    const store = await createWorkspaceStore(root);
    try {
      await assert.rejects(store.save({ revision: opened.revision, kind: 'definitions', document: opened.definitions }),
      { code: 'COMPATIBILITY_STRUCTURE_READ_ONLY' });
    } finally { await store.close(); }
});

test('兼容读取仍拒绝规则端点不存在的核心拓扑', async t => {
  const { root, workspace } = await fixture(t);
  const rulesPath = join(root, workspace.manifest.rules);
  const rules = JSON.parse(await readFile(rulesPath, 'utf8'));
  rules.rules[0].target = 'missing-concept';
  await writeFile(rulesPath, JSON.stringify(rules));
  await assert.rejects(readWorkspace(root), { code: 'MISSING_REFERENCE' });
});
