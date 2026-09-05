import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GraphCanvas, hasRuleText } from '../src/web/canvas.mjs';
import { compose, tracePaths, collapse } from '../src/domain/graph.mjs';
import { endpointProjectionId } from '../src/domain/endpoint-projection.mjs';
import { validateWorkspace } from '../src/domain/validate.mjs';
import { queryWorkspace, formatQueryText } from '../src/domain/query.mjs';
import { applyAgentMutation } from '../src/server/agent-mutation.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { planV7ToV8Migration } from '../src/server/migration.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-rule-text-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const project = join(temp, 'project');
  await copyExampleFixture(project);
  return { project, root: join(project, '.game-graph') };
}

test('空规则判定覆盖影响关系的缺省、空串、空白与摘要缺项；is-a 自带结构语义', () => {
  for (const relation of ['influence']) for (const sign of [1, -1, 'random']) {
    for (const ruleText of [undefined, '', ' \t\n　', '条件成立时提高目标']) {
      const edge = { relation, sign, ruleText }, before = structuredClone(edge);
      assert.equal(hasRuleText(edge), Boolean(ruleText?.trim()));
      assert.deepEqual(edge, before);
    }
  }
  for (const ruleText of [undefined, '', ' \t\n　', '结构备注']) assert.equal(hasRuleText({ relation: 'specializes', ruleText }), true);
  assert.equal(hasRuleText({ ruleText: '摘要', steps: [{ ruleText: '第一步' }, {}] }), false);
  assert.equal(hasRuleText({ steps: [{ ruleText: '第一步' }, { ruleText: '第二步' }] }), true);
});

test('实际 SVG 绘制让空规则线条、箭头、符号灰显，选中与重绘不恢复关系色', t => {
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.document = originalDocument; });
  const element = tag => ({ tag, attrs: {}, children: [], setAttribute(key, value) { this.attrs[key] = value; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } });
  globalThis.document = { createElementNS: (_, tag) => element(tag) };
  const canvas = Object.create(GraphCanvas.prototype);
  Object.assign(canvas, { root: element('svg'), activeId: 'test', positions: { a: { x: 0, y: 0 } },
    camera: { x: 0, y: 0, scale: 1 }, routed: new Map(), callbacks: { name: id => id, zoom() {} },
    graph: { nodes: [], edges: [{ id: 'edge', source: 'a', target: 'a', relation: 'influence', sign: -1,
      steps: [{ graphId: 'test', ruleText: '' }] }] } });
  for (const selected of [null, { type: 'edge', id: 'edge' }]) {
    canvas.selection = selected;
    for (const [text, expected] of [[undefined, 'empty-rule'], ['', 'empty-rule'], ['填写规则', 'negative'], ['命中时：\n降低血量 <规则> & 约束', 'negative'], [' \n', 'empty-rule']]) {
      canvas.graph.edges[0].steps[0].ruleText = text;
      canvas.draw();
      const { group, line, label } = canvas.edgeElements.get('edge');
      assert.equal(group.children.find(item => item.tag === 'title'), undefined);
      if (text?.trim()) assert.equal(group.attrs['data-tooltip'], text);
      else assert.equal(group.attrs['data-tooltip'], undefined);
      assert.match(line.attrs.class, new RegExp('edge-' + expected));
      assert.equal(line.attrs['marker-end'], 'url(#' + expected + ')');
      assert.equal(label.attrs.class, 'edge-label ' + expected);
      assert.equal(label.textContent, '−');
      const marker = canvas.root.children[0].children.find(item => item.attrs.id === 'empty-rule');
      assert.equal(marker.children[0].attrs.fill, '#9a9fa6');
    }
  }
  canvas.graph.edges[0].steps = [{ graphId: 'test', ruleText: '第一条规则' }, { graphId: 'test' }];
  canvas.draw();
  assert.equal(canvas.edgeElements.get('edge').group.attrs['data-tooltip'], '第一条规则');
});

test('画布 hover 提示在右下边缘会向内夹紧，保持可阅读范围', () => {
  const canvas = Object.create(GraphCanvas.prototype);
  canvas.root = { clientWidth: 300, clientHeight: 180, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  canvas.tooltip = { hidden: false, offsetWidth: 160, offsetHeight: 72, style: {} };
  canvas.moveTooltip({ clientX: 296, clientY: 176 });
  assert.equal(canvas.tooltip.style.left, '126px');
  assert.equal(canvas.tooltip.style.top, '94px');
});

test('Schema 与 Agent mutation 拒绝旧字段，规则空白不改变路径推理', async () => {
  const workspace = await readWorkspace(join(example, '.game-graph'));
  const graph = compose(workspace, ['basic-rules', 'hand']);
  const before = tracePaths(graph, 'evade', 'failure');
  const empty = structuredClone(workspace);
  for (const mechanic of empty.mechanics) for (const edge of mechanic.edges) delete edge.ruleText;
  validateWorkspace(empty);
  assert.deepEqual(tracePaths(compose(empty, ['basic-rules', 'hand']), 'evade', 'failure').paths.map(path => path.sign), before.paths.map(path => path.sign));
  empty.mechanics[0].edges[0].condition = '';
  assert.throws(() => validateWorkspace(empty), { code: 'INVALID_DOCUMENT' });
  const mechanic = workspace.mechanics[0], edge = mechanic.edges[0];
  assert.throws(() => applyAgentMutation(workspace, { resource: 'rule', action: 'update', mechanic: mechanic.id,
    source: edge.source, target: edge.target, condition: '', revision: workspace.resourceRevisions.mechanics[mechanic.id] }), /condition/);
  const folded = collapse(graph, 'repel').edges.find(edge => edge.derived);
  assert.ok(folded.ruleText.includes('体力'));
  assert.equal(Object.hasOwn(folded, 'condition'), false);
  for (const command of ['graph', 'node', 'impact']) {
    const request = { command, mechanic: 'basic-rules', ...(command === 'node' ? { id: 'melee' } : command === 'impact' ? { from: 'melee', to: 'health' } : {}) };
    const result = queryWorkspace(workspace, request);
    assert.doesNotMatch(JSON.stringify(result), /"condition(?:Status|sEvaluated)?":/);
    assert.doesNotMatch(formatQueryText(result), /；条件 |条件：未注明/);
    assert.equal(result.ruleTextEvaluated, false);
  }
});

test('Agent 清空或删除限定边时，同时移除失效的投影坐标', async () => {
  const workspace = await readWorkspace(join(example, '.game-graph'));
  const mechanic = workspace.mechanics[0], edge = mechanic.edges[0];
  const qualifiers = [{ key: 'faction', value: { kind: 'literal', value: 'friendly' } }];
  applyAgentMutation(workspace, { resource: 'rule', action: 'update', mechanic: mechanic.id,
    source: edge.source, target: edge.target, sourceQualifiers: qualifiers,
    revision: workspace.resourceRevisions.mechanics[mechanic.id] });
  const projectionId = endpointProjectionId(edge.source, qualifiers);
  mechanic.projectionPositions = { [projectionId]: { x: 120, y: 80 } };
  applyAgentMutation(workspace, { resource: 'rule', action: 'update', mechanic: mechanic.id,
    source: edge.source, target: edge.target, sourceQualifiers: [],
    revision: workspace.resourceRevisions.mechanics[mechanic.id] });
  assert.equal(mechanic.edges[0].sourceQualifiers, undefined);
  assert.equal(mechanic.projectionPositions[projectionId], undefined);

  applyAgentMutation(workspace, { resource: 'rule', action: 'update', mechanic: mechanic.id,
    source: edge.source, target: edge.target, sourceQualifiers: qualifiers,
    revision: workspace.resourceRevisions.mechanics[mechanic.id] });
  mechanic.projectionPositions = { [projectionId]: { x: 120, y: 80 } };
  applyAgentMutation(workspace, { resource: 'rule', action: 'delete', mechanic: mechanic.id,
    source: edge.source, target: edge.target, revision: workspace.resourceRevisions.mechanics[mechanic.id] });
  assert.equal(mechanic.projectionPositions[projectionId], undefined);
});

test('Agent 删除限定边时，同时移除组合视图中已失效的投影坐标', async () => {
  const workspace = await readWorkspace(join(example, '.game-graph'));
  const mechanic = workspace.mechanics[0], edge = mechanic.edges[0];
  const qualifiers = [{ key: 'faction', value: { kind: 'literal', value: 'friendly' } }];
  applyAgentMutation(workspace, { resource: 'rule', action: 'update', mechanic: mechanic.id,
    source: edge.source, target: edge.target, sourceQualifiers: qualifiers,
    revision: workspace.resourceRevisions.mechanics[mechanic.id] });
  const projectionId = endpointProjectionId(edge.source, qualifiers);
  workspace.views = [{ schemaVersion: 3, kind: 'view', workspaceId: workspace.manifest.id, id: 'combined', name: '组合视图',
    mechanicRegistrations: [{ mechanicId: mechanic.id, visible: true }], projectionPositions: { [projectionId]: { x: 120, y: 80 } }, positions: {}, collapsedNodeIds: [], structuralPresentation: 'line' }];
  applyAgentMutation(workspace, { resource: 'rule', action: 'delete', mechanic: mechanic.id,
    source: edge.source, target: edge.target, revision: workspace.resourceRevisions.mechanics[mechanic.id] });
  assert.equal(workspace.views[0].projectionPositions[projectionId], undefined);
});

test('Agent 新增未限定的影响规则时，不把缺省限定词当作数组读取', async () => {
  const workspace = await readWorkspace(join(example, '.game-graph'));
  const mechanic = workspace.mechanics[0];
  const existing = new Set(workspace.mechanics.flatMap(item => item.edges.map(edge => `${edge.source}->${edge.target}`)));
  const conceptIds = workspace.definitions.nodes.map(concept => concept.id);
  const candidate = conceptIds.flatMap(source => conceptIds.map(target => ({ source, target })))
    .find(({ source, target }) => source !== target && !existing.has(`${source}->${target}`));
  assert.ok(candidate);
  applyAgentMutation(workspace, {
    resource: 'rule', action: 'add', mechanic: mechanic.id,
    source: candidate.source, target: candidate.target, relation: 'influence', sign: 1,
    ruleText: '轮到参与者回合时，可在满足条件下执行卡牌。',
    revision: workspace.resourceRevisions.mechanics[mechanic.id],
  });
  const added = mechanic.edges.find(edge => edge.source === candidate.source && edge.target === candidate.target);
  assert.equal(added?.sign, 1);
  assert.equal(added?.sourceQualifiers, undefined);
  assert.equal(added?.targetQualifiers, undefined);
});

test('旧 CLI 参数和已删除命令明确拒绝', async () => {
  const cli = fileURLToPath(new URL('../src/server/cli.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'agent', 'rule', 'update', '--condition', '']),
    error => /ERR_PARSE_ARGS_UNKNOWN_OPTION/.test(error.stderr));
  const help = await promisify(execFile)(process.execPath, [cli, '--help']);
  const removedCommand = ['migrate', 'rule', 'text'].join('-');
  assert.doesNotMatch(help.stdout, new RegExp(removedCommand));
  await assert.rejects(promisify(execFile)(process.execPath, [cli, removedCommand]),
    error => /命令或参数数量无效/.test(error.stderr));
});

test('v7 到 v8 的已有迁移候选同时移除条件字段并保留规则文字', async t => {
  const { root } = await fixture(t), workspace = await readWorkspace(root);
  for (const file of workspace.files) {
    const path = join(root, file.path), document = JSON.parse(await readFile(path, 'utf8'));
    document.schemaVersion = file.kind === 'workspace' ? 7 : file.kind === 'view' ? 2 : 3;
    if (file.kind === 'mechanic') for (const edge of document.edges) {
      delete edge.inheritance;
      edge.condition = '迁移测试约束';
    }
    await writeFile(path, JSON.stringify(document));
  }
  const plan = await planV7ToV8Migration(root);
  const rules = plan.documents.filter(item => item.document.kind === 'mechanic').flatMap(item => item.document.edges);
  assert.ok(rules.length > 0);
  assert.ok(rules.every(edge => edge.ruleText.endsWith('\n条件约束：迁移测试约束') && !Object.hasOwn(edge, 'condition')));
  assert.equal(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).schemaVersion, 7);
});
