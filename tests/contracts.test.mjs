import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { readWorkspace } from '../src/server/workspace.mjs';
import { startServer } from '../src/server/http.mjs';
import { validateWorkspace } from '../src/domain/validate.mjs';
import { compose, collapse, canCollapse, tracePaths, diagnose } from '../src/domain/graph.mjs';

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
const source = await readWorkspace(example);
const selected = ['basic-rules', 'encounter', 'hand'];

test('叠加按稳定 ID 接合，保留来源且不修改输入', () => {
  const before = JSON.stringify(source);
  const graph = compose(source, selected);
  assert.equal(graph.nodes.filter(node => node.id === 'melee').length, 1);
  assert.equal(graph.edges.length, 9);
  assert.deepEqual(graph.nodes.find(node => node.id === 'melee').sourceGraphIds, ['basic-rules', 'encounter', 'hand']);
  assert.deepEqual(compose(source, [...selected].reverse()), graph);
  assert.deepEqual(compose(source, [...selected, 'hand']), graph);
  assert.equal(JSON.stringify(source), before);
  assert.equal(compose(source, ['basic-rules']).nodes.some(node => node.id === 'evade'), false);
});

test('同名不同 ID 不合并；跨图异号关系不抵消', () => {
  const draft = structuredClone(source);
  draft.definitions.nodes.push({ id: 'enemy-two', label: '近战敌人', description: '第二名敌人', increaseMeaning: '行动增加' });
  const encounter = draft.mechanics.find(graph => graph.id === 'encounter');
  encounter.nodeIds.push('enemy-two');
  encounter.edges.push({ id: 'opposite', source: 'enemy', target: 'melee', relation: 'influence', sign: -1, condition: '另一个假设条件', note: '' });
  validateWorkspace(draft);
  const graph = compose(draft, selected);
  assert.equal(graph.nodes.filter(node => node.label === '近战敌人').length, 2);
  assert.deepEqual(graph.edges.filter(edge => edge.source === 'enemy' && edge.target === 'melee').map(edge => edge.sign).sort(), [-1, 1]);
});

test('单路径符号解释保留条件；折叠只生成摘要且可由源图展开', () => {
  const graph = compose(source, selected);
  const before = JSON.stringify(graph);
  const result = tracePaths(graph, 'evade', 'failure');
  assert.equal(result.paths.length, 1);
  assert.equal(result.paths[0].sign, -1);
  assert.equal(result.paths[0].steps.length, 5);
  assert.match(result.paths[0].steps[0].condition, /体力/);
  assert.equal(canCollapse(graph, 'repel'), true);
  const folded = collapse(graph, 'repel');
  const summary = folded.edges.find(edge => edge.hiddenNodes.includes('repel'));
  assert.equal(summary.sign, -1);
  assert.deepEqual(summary.steps.map(edge => edge.edgeId), ['evade-repel', 'repel-melee']);
  assert.equal(JSON.stringify(graph), before);
  assert.deepEqual(compose(source, selected), graph);
  assert.equal(canCollapse(graph, 'evade'), false);
});

test('环中节点不被折叠，路径查询有明确截断状态', () => {
  const graph = compose(source, selected);
  graph.edges.push({ id: 'cycle', source: 'melee', target: 'evade', relation: 'influence', sign: 1, steps: [], hiddenNodes: [] });
  assert.equal(canCollapse(graph, 'repel'), false);
  assert.throws(() => collapse(graph, 'repel'), /不能折叠/);
  const result = tracePaths(compose(source, selected), 'evade', 'failure', { maxDepth: 2 });
  assert.equal(result.paths.length, 0);
  assert.equal(result.truncated, true);
});

test('终点只有疑点提示，未纳入当前机制的全局定义不被误判', () => {
  const result = diagnose(compose(source, selected));
  assert.ok(result.findings.some(item => item.kind === 'sink' && item.nodeIds.includes('failure')));
  assert.ok(result.findings.every(item => !item.nodeIds.includes('armor')));
  assert.deepEqual(diagnose(compose(source, [])).findings, []);
});

test('结构和引用错误明确拒绝，不修补原始数据', () => {
  for (const change of [
    data => { data.definitions.nodes.push(structuredClone(data.definitions.nodes[0])); },
    data => { data.mechanics[0].edges[0].target = 'missing'; },
    data => { data.mechanics[0].schemaVersion = 2; },
    data => { data.mechanics[0].edges[0].sign = 0; },
    data => { data.mechanics[0].workspaceId = 'other-game'; },
    data => { data.definitions.nodes = data.definitions.nodes.filter(node => node.id !== 'melee'); },
    data => { data.manifest.compositions[0].graphIds.push('unknown'); },
    data => { data.mechanics[0].positions.missing = { x: 0, y: 0 }; },
  ]) {
    const draft = structuredClone(source); change(draft);
    const before = JSON.stringify(draft);
    assert.throws(() => validateWorkspace(draft));
    assert.equal(JSON.stringify(draft), before);
  }
});

test('视图可保存暂时隐藏的定义节点坐标，但仍拒绝未知节点', () => {
  const draft = structuredClone(source);
  draft.views = [{ schemaVersion: 2, kind: 'view', workspaceId: draft.manifest.id, id: 'layout-memory', name: '布局记忆', mechanicRegistrations: [], collapsedNodeIds: [], positions: { melee: { x: 10, y: 20 } } }];
  validateWorkspace(draft);
  draft.views[0].positions.missing = { x: 0, y: 0 };
  assert.throws(() => validateWorkspace(draft), /missing/);
});

test('工具可处理无任何卡牌概念的另一游戏工作区', () => {
  const data = {
    manifest: { schemaVersion: 4, kind: 'workspace', id: 'platform-game', name: '跳跃游戏', definitions: 'definitions.graph.json', compositions: [] },
    definitions: { schemaVersion: 1, kind: 'definitions', workspaceId: 'platform-game', nodes: ['jump', 'fall'].map(id => ({ id, label: id, description: '测试概念', increaseMeaning: '发生增加' })), positions: {} },
    mechanics: [{ schemaVersion: 1, kind: 'mechanic', workspaceId: 'platform-game', id: 'jump-rule', name: '跳跃规则', scope: '假设模型', nodeIds: ['jump', 'fall'], edges: [{ id: 'avoid', source: 'jump', target: 'fall', relation: 'influence', sign: -1, condition: '及时起跳', note: '' }], positions: {} }],
  };
  validateWorkspace(data);
  assert.equal(tracePaths(compose(data, ['jump-rule']), 'jump', 'fall').paths[0].sign, -1);
});

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-test-'));
  let close = async () => {};
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  await cp(example, join(root, 'workspace'), { recursive: true });
  return { root, directory: join(root, 'workspace'), setClose: callback => { close = callback; } };
}

test('读取真实文件且版本戳反映外部修改，其他后缀的 JSON 不当作规则文件', async t => {
  const { directory } = await temporary(t);
  const first = await readWorkspace(directory);
  await writeFile(join(directory, 'unregistered.json'), '{invalid');
  assert.equal((await readWorkspace(directory)).revision, first.revision);
  const file = join(directory, 'definitions.graph.json');
  const definitions = JSON.parse(await readFile(file, 'utf8'));
  definitions.nodes[0].label = '新的显示名称';
  await writeFile(file, JSON.stringify(definitions));
  const second = await readWorkspace(directory);
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.mechanics[0].edges[0].source, 'turn-start');
});

test('坏 JSON、路径穿越及缺失文件失败，不返回部分成功', async t => {
  const { directory } = await temporary(t);
  const manifestPath = join(directory, 'workspace.json');
  const original = await readFile(manifestPath, 'utf8');
  for (const file of ['../outside.json', '/outside.json', 'C:/outside.json', 'mechanics/%2e%2e/outside.json', 'missing.json']) {
    const manifest = JSON.parse(original); manifest.definitions = file;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(readWorkspace(directory));
  }
  await writeFile(manifestPath, '{broken');
  await assert.rejects(readWorkspace(directory), /有效/);
});

test('拒绝工作区内指向其他目录的符号链接或 Windows junction', async t => {
  const { root, directory } = await temporary(t);
  const outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'definitions.graph.json'), JSON.stringify(source.definitions));
  await symlink(outside, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = structuredClone(source.manifest); manifest.definitions = 'linked/definitions.graph.json';
  await writeFile(join(directory, 'workspace.json'), JSON.stringify(manifest));
  await assert.rejects(readWorkspace(directory), /符号链接|junction/);
});

test('HTTP 真实读取、同源与会话门禁，拒绝未支持操作', async t => {
  const { directory, setClose } = await temporary(t);
  const { close, origin, token } = await startServer({ workspaceRoot: directory, port: 0 });
  setClose(close);
  const authorized = { Authorization: `Bearer ${token}` };
  const page = await fetch(origin); assert.equal(page.status, 200); assert.match(await page.text(), /规则节点画布/);
  assert.equal((await fetch(`${origin}/api/workspace`)).status, 401);
  assert.equal((await fetch(`${origin}/api/workspace`, { headers: { ...authorized, Origin: 'https://other.example' } })).status, 403);
  // fetch 会重写 Host；用原生 HTTP 客户端真实发送伪造 Host。
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/workspace`, { headers: { ...authorized, Host: 'other.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${origin}/api/workspace`, { method: 'POST', headers: authorized })).status, 405);
  assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
  const response = await fetch(`${origin}/api/workspace`, { headers: authorized });
  assert.equal(response.status, 200); assert.equal((await response.json()).manifest.id, source.manifest.id);
  await writeFile(join(directory, 'definitions.graph.json'), '{bad');
  const broken = await fetch(`${origin}/api/workspace`, { headers: authorized });
  assert.equal(broken.status, 422); assert.equal((await broken.json()).error, 'INVALID_JSON');
});
