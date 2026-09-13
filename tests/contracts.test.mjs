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
import { copyExampleFixture } from './example-fixture.mjs';

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
const source = await readWorkspace(join(example, '.mechanics'));
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

test('同名不同 ID 不合并；不同来源规则各自保留', () => {
  const draft = structuredClone(source);
  draft.definitions.nodes.push({ id: 'enemy-two', label: '近战敌人', description: '第二名敌人', agentLocked: false });
  const encounter = draft.mechanics.find(graph => graph.id === 'encounter');
  encounter.focusNodeIds.push('enemy-two');
  draft.rules.rules.push({ id: 'enemy-two-2-melee', source: 'enemy-two', target: 'melee', relation: 'influence', sign: -1, inheritance: { mode: 'none' }, ruleText: '另一个假设条件' });
  draft.mechanics.push({ ...structuredClone(encounter), id: 'opposite-rule', pinnedRuleIds: ['enemy-two-2-melee'] });
  validateWorkspace(draft);
  const graph = compose(draft, [...selected, 'opposite-rule']);
  assert.equal(graph.nodes.filter(node => node.label === '近战敌人').length, 2);
  assert.deepEqual(graph.edges.filter(edge => edge.target === 'melee' && ['enemy', 'enemy-two'].includes(edge.source)).map(edge => edge.sign).sort(), [-1, 1]);
});

test('单路径符号解释保留规则文字；折叠只生成摘要且可由源图展开', () => {
  const graph = compose(source, selected);
  const before = JSON.stringify(graph);
  const result = tracePaths(graph, 'evade', 'failure');
  assert.equal(result.paths.length, 1);
  assert.equal(result.paths[0].sign, -1);
  assert.equal(result.paths[0].steps.length, 5);
  assert.match(result.paths[0].steps[0].ruleText, /体力/);
  assert.equal(canCollapse(graph, 'repel'), true);
  const folded = collapse(graph, 'repel');
  const summary = folded.edges.find(edge => edge.hiddenNodes.includes('repel'));
  assert.equal(summary.sign, -1);
  assert.deepEqual(summary.steps.map(edge => edge.id), ['evade-2-repel', 'repel-2-melee']);
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
  const withRuleText = structuredClone(source);
  withRuleText.rules.rules[0].ruleText = '回合开始时获得一张牌。';
  validateWorkspace(withRuleText);
  for (const change of [
    data => { data.definitions.nodes.push(structuredClone(data.definitions.nodes[0])); },
    data => { data.rules.rules[0].target = 'missing'; },
    data => { data.mechanics[0].schemaVersion = 1; },
    data => { data.rules.rules[0].sign = 0; },
    data => { data.mechanics[0].workspaceId = 'other-game'; },
    data => { data.definitions.nodes = data.definitions.nodes.filter(node => node.id !== 'melee'); },
    data => { data.manifest.compositions[0].graphIds.push('unknown'); },
    data => { delete data.definitions.nodes[0].agentLocked; },
    data => { data.definitions.nodes[0].agentLocked = 'false'; },
    data => { data.rules.rules[0].note = '旧字段'; },
    data => { data.definitions.nodes[0].increaseMeaning = '旧字段'; },
  ]) {
    const draft = structuredClone(source); change(draft);
    const before = JSON.stringify(draft);
    assert.throws(() => validateWorkspace(draft));
    assert.equal(JSON.stringify(draft), before);
  }
});

test('节点颜色与风格只属于机制图或视图的呈现数据，不可写入概念', () => {
  const colored = structuredClone(source);
  colored.mechanics[0].nodeColors = { melee: '#D5E8F7' };
  colored.mechanics[0].nodeStyles = { melee: 'transparent-dashed' };
  if (colored.views[0]) colored.views[0].nodeColors = { melee: '#E5DCF4' };
  if (colored.views[0]) colored.views[0].nodeStyles = { melee: 'solid' };
  validateWorkspace(colored);
  const legacyColor = structuredClone(colored);
  legacyColor.mechanics[0].nodeColors.melee = '#E4EDF5';
  validateWorkspace(legacyColor);
  const invalidColor = structuredClone(colored);
  invalidColor.mechanics[0].nodeColors.melee = '#FFFFFF';
  assert.throws(() => validateWorkspace(invalidColor), { code: 'INVALID_DOCUMENT' });
  const invalidStyle = structuredClone(colored);
  invalidStyle.mechanics[0].nodeStyles.melee = 'outline';
  assert.throws(() => validateWorkspace(invalidStyle), { code: 'INVALID_DOCUMENT' });
  const invalidConcept = structuredClone(colored);
  invalidConcept.definitions.nodes[0].nodeColors = { melee: '#E4EDF5' };
  assert.throws(() => validateWorkspace(invalidConcept), { code: 'INVALID_DOCUMENT' });
  const invalidConceptStyle = structuredClone(colored);
  invalidConceptStyle.definitions.nodes[0].nodeStyles = { melee: 'transparent-dashed' };
  assert.throws(() => validateWorkspace(invalidConceptStyle), { code: 'INVALID_DOCUMENT' });
});


test('概念与规则都只能保存受限长度的自定义文本', () => {
  const valid = structuredClone(source);
  valid.definitions.nodes[0].customData = 'refs: combat/melee';
  valid.rules.rules[0].customData = 'refs: combat/rules';
  validateWorkspace(valid);
  for (const change of [
    data => { data.definitions.nodes[0].customData = { refs: [] }; },
    data => { data.rules.rules[0].customData = 1; },
    data => { data.definitions.nodes[0].customData = 'x'.repeat(16001); },
    data => { data.rules.rules[0].customData = 'x'.repeat(16001); },
  ]) {
    const invalid = structuredClone(valid); change(invalid);
    assert.throws(() => validateWorkspace(invalid));
  }
});

test('持久化领域 ID 拒绝随机片段，别名不遮蔽稳定 ID且歧义别名允许一对多', () => {
  const random = structuredClone(source);
  random.definitions.nodes[0].id = 'node-deadbeef';
  assert.throws(() => validateWorkspace(random), { code: 'INVALID_SEMANTIC_ID' });

  const shadow = structuredClone(source);
  shadow.definitions.nodes[0].aliases = [shadow.definitions.nodes[1].id];
  assert.throws(() => validateWorkspace(shadow), { code: 'ALIAS_SHADOWS_ID' });

  const ambiguous = structuredClone(source);
  ambiguous.definitions.nodes[0].aliases = ['共同叫法'];
  ambiguous.definitions.nodes[1].aliases = ['共同叫法'];
  validateWorkspace(ambiguous);

  const duplicate = structuredClone(source);
  duplicate.definitions.nodes[0].aliases = ['Health', ' health '];
  assert.throws(() => validateWorkspace(duplicate), { code: 'DUPLICATE_ALIAS' });
});

test('全工作区的同一有向端点对只允许一条规则', () => {
  const duplicate = structuredClone(source);
  const edge = duplicate.rules.rules[0];
  duplicate.rules.rules.push({ ...edge, id: edge.id + '-duplicate', relation: 'influence', sign: -1 });
  assert.throws(() => validateWorkspace(duplicate), { code: 'DUPLICATE_ENDPOINT_RULE' });
  const crossMechanic = structuredClone(source);
  crossMechanic.mechanics[1].focusNodeIds.push(...[edge.source, edge.target].filter(id => !crossMechanic.mechanics[1].focusNodeIds.includes(id)));
  crossMechanic.mechanics[1].pinnedRuleIds.push(edge.id);
  validateWorkspace(crossMechanic);
});

test('规则 ID 必须由 source 与 target 稳定确定', () => {
  const invalid = structuredClone(source);
  invalid.rules.rules[0].id = 'unrelated-rule-name';
  assert.throws(() => validateWorkspace(invalid), { code: 'RULE_ID_MISMATCH' });
});

test('视图可保存暂时隐藏或后续出现的定义节点坐标', () => {
  const draft = structuredClone(source);
  draft.views = [{ schemaVersion: 4, kind: 'view', workspaceId: draft.manifest.id, id: 'layout-memory', name: '布局记忆', mechanicRegistrations: [], focusNodeIds: [], pinnedRuleIds: [], collapsedNodeIds: [], positions: { melee: { x: 10, y: 20 } }, structuralPresentation: 'line' }];
  validateWorkspace(draft);
  draft.views[0].positions.missing = { x: 0, y: 0 };
  validateWorkspace(draft);
});

test('工具可处理无任何卡牌概念的另一游戏工作区', () => {
  const data = {
    manifest: { schemaVersion: 12, kind: 'workspace', id: 'platform-game', name: '跳跃游戏', definitions: 'definitions.json', rules: 'rules.json', agentExportPath: 'mechanics', compositions: [] },
    definitions: { schemaVersion: 7, kind: 'definitions', workspaceId: 'platform-game', tagDefinitions: [], nodes: ['jump', 'fall'].map(id => ({ id, label: id, description: '测试概念', agentLocked: false })), positions: {} },
    rules: { schemaVersion: 1, kind: 'rules', workspaceId: 'platform-game', rules: [{ id: 'jump-2-fall', source: 'jump', target: 'fall', relation: 'influence', sign: -1, inheritance: { mode: 'none' }, ruleText: '及时起跳' }] },
    mechanics: [{ schemaVersion: 7, kind: 'mechanic', workspaceId: 'platform-game', id: 'jump-rule', name: '跳跃规则', scope: '假设模型', focusNodeIds: ['jump', 'fall'], pinnedRuleIds: ['jump-2-fall'], positions: {} }],
  };
  validateWorkspace(data);
  assert.equal(tracePaths(compose(data, ['jump-rule']), 'jump', 'fall').paths[0].sign, -1);
});

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-test-'));
  let close = async () => {};
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  await copyExampleFixture(join(root, 'workspace'));
  return { root, projectRoot: join(root, 'workspace'), directory: join(root, 'workspace', '.mechanics'), setClose: callback => { close = callback; } };
}

test('读取真实文件且版本戳反映外部修改，其他后缀的 JSON 不当作规则文件', async t => {
  const { directory } = await temporary(t);
  const first = await readWorkspace(directory);
  await writeFile(join(directory, 'unregistered.json'), '{invalid');
  assert.equal((await readWorkspace(directory)).revision, first.revision);
  const file = join(directory, 'definitions.json');
  const definitions = JSON.parse(await readFile(file, 'utf8'));
  definitions.nodes[0].label = '新的显示名称';
  await writeFile(file, JSON.stringify(definitions));
  const second = await readWorkspace(directory, { verifyGeneratedCatalog: false });
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.rules.rules[0].source, 'turn-start');
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
  await writeFile(join(outside, 'definitions.json'), JSON.stringify(source.definitions));
  await symlink(outside, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = structuredClone(source.manifest); manifest.definitions = 'linked/definitions.json';
  await writeFile(join(directory, 'workspace.json'), JSON.stringify(manifest));
  await assert.rejects(readWorkspace(directory), /符号链接|junction/);
});

test('HTTP 真实读取无需 session、允许跨源并拒绝未支持操作', async t => {
  const { projectRoot, directory, setClose } = await temporary(t);
  const { close, origin } = await startServer({ projectRoot, port: 0, projectHistoryPath: join(projectRoot, '.test-projects.json') });
  setClose(close);
  const page = await fetch(origin); assert.equal(page.status, 200); assert.match(await page.text(), /规则节点画布/);
  assert.equal((await fetch(`${origin}/api/workspace`)).status, 200);
  assert.equal((await fetch(`${origin}/api/workspace`, { headers: { Origin: 'https://other.example' } })).status, 200);
  // fetch 会重写 Host；用原生 HTTP 客户端真实发送伪造 Host。
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/workspace`, { headers: { Host: 'other.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${origin}/api/workspace`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
  const response = await fetch(`${origin}/api/workspace`);
  assert.equal(response.status, 200); assert.equal((await response.json()).manifest.id, source.manifest.id);
  await writeFile(join(directory, 'definitions.json'), '{bad');
  const broken = await fetch(`${origin}/api/workspace`);
  assert.equal(broken.status, 422); assert.equal((await broken.json()).error, 'INVALID_JSON');
});
