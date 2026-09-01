import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readWorkspace } from '../src/server/workspace.mjs';
import { queryWorkspace, formatQueryText } from '../src/domain/query.mjs';
import { assertQueryCompatibility } from '../src/server/agent.mjs';
import { startServer } from '../src/server/http.mjs';
import { createWorkspaceStore } from '../src/server/store.mjs';
const exec = promisify(execFile);
const example = fileURLToPath(new URL('../examples/card-game/', import.meta.url));
const cli = fileURLToPath(new URL('../src/server/cli.mjs', import.meta.url));
const source = await readWorkspace(example);
const call = (args, env = process.env) => exec(process.execPath, [cli, 'agent', ...args], { env, timeout: 15000 });
async function fixture(t, cleanup = true) {
  const root = await mkdtemp(join(tmpdir(), 'rule-agent-'));
  await cp(example, root, { recursive: true });
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function synthetic() {
  const nodes = ['a', 'b', 'c', 'd'].map(id => ({ id, label: id, description: '概念', increaseMeaning: '增加' }));
  const edges = [
    { id: 'ab', source: 'a', target: 'b', relation: 'contains', condition: '', note: '' },
    { id: 'ac', source: 'a', target: 'c', relation: 'influence', sign: -1, condition: '假设', note: '说明' },
    { id: 'bc', source: 'b', target: 'c', relation: 'influence', sign: 1, condition: '', note: '' },
  ];
  return { manifest: { id: 'test' }, revision: 'one', definitions: { nodes }, mechanics: [{ id: 'base', name: '基础', scope: '抽象', schemaVersion: 1, nodeIds: nodes.map(n => n.id), edges }], views: [{ id: 'base', name: '视图', mechanicRegistrations: [{ mechanicId: 'base', visible: true }] }], files: [{ kind: 'mechanic', id: 'base', path: 'base.mechanic.json' }] };
}

test('guide无需工作区，所有结果附带模型边界；旧双向或缺阅读合同的在线结果拒绝', async () => {
  const guide = JSON.parse((await call(['guide'])).stdout);
  assert.equal(guide.command, 'guide'); assert.equal(guide.readingContract.model, 'abstract_rule_influence');
  assert.equal(guide.readingContract.runtimeVerification, 'not_provided');
  const text = (await call(['guide', '--format', 'text'])).stdout;
  assert.match(text, /increaseMeaning/); assert.match(text, /空条件表示未注明/);
  assert.doesNotThrow(() => assertQueryCompatibility(guide));
  assert.throws(() => assertQueryCompatibility({ ...guide, semanticsVersion: 'bidirectional-neutral-1' }), { code: 'QUERY_VERSION_MISMATCH' });
  assert.throws(() => assertQueryCompatibility({ ...guide, readingContract: undefined }), { code: 'QUERY_VERSION_MISMATCH' });
});

test('搜索覆盖名称、ID、描述、增加方向和标签，范围隔离，同名不合并且截断明确', () => {
  const w = synthetic();
  w.definitions.nodes[0] = { id: 'a', label: '灵力', description: '支付费用', increaseMeaning: '可用存量', tags: ['修仙'] };
  w.definitions.nodes[1].label = '灵力';
  w.definitions.nodes.push({ id: 'outside', label: '灵力', description: '未引用的概念', increaseMeaning: '增加' });
  for (const query of ['修仙', '支付', '可用存量', 'Ａ', '灵力 修仙']) {
    assert.equal(queryWorkspace(w, { command: 'search', query }).nodes[0].id, 'a');
  }
  const all = queryWorkspace(w, { command: 'search', query: '灵力' });
  assert.equal(all.scope.kind, 'definitions'); assert.equal(all.nodes.length, 3);
  assert.deepEqual(all.nodes.find(n => n.id === 'outside').sourceMechanicIds, []);
  const scoped = queryWorkspace(w, { command: 'search', query: '灵力', mechanic: 'base', limit: 1 });
  assert.equal(scoped.output.totalMatches, 2); assert.equal(scoped.output.complete, false);
  assert.equal(queryWorkspace(w, { command: 'search', query: '灵力', view: 'base' }).nodes.length, 2);
  assert.equal(queryWorkspace(w, { command: 'search', query: '没有的概念' }).output.totalMatches, 0);
  assert.throws(() => queryWorkspace(w, { command: 'search', query: '  ' }), { code: 'QUERY_INVALID' });
  assert.match(formatQueryText(all), /尚未引用/);
});

test('按距离查询分别计算上下游最短路，不通过换向收进资源兄弟', () => {
  const w = synthetic();
  w.mechanics[0].edges = [
    { id: 'ac', source: 'a', target: 'c', relation: 'contains', condition: '', note: '' },
    { id: 'bc', source: 'b', target: 'c', relation: 'contains', condition: '', note: '' },
    { id: 'cd', source: 'c', target: 'd', relation: 'influence', sign: 1, condition: '', note: '' },
  ];
  const q = queryWorkspace(w, { command: 'node', mechanic: 'base', id: 'a', direction: 'both', hops: 2 });
  assert.deepEqual(q.nodes.map(n => n.id), ['a', 'c', 'd']);
  assert.deepEqual(q.neighborhood.upstreamNodeIds, []);
  assert.deepEqual(q.neighborhood.downstreamNodeIds, ['c', 'd']);
  assert.deepEqual(q.neighborhood.distances.d, { upstream: null, downstream: 2 });
  assert.deepEqual(queryWorkspace(w, { command: 'node', mechanic: 'base', id: 'a', hops: 1 }).nodes.map(n => n.id), ['a', 'c']);
  const up = queryWorkspace(w, { command: 'node', mechanic: 'base', id: 'd', direction: 'upstream', hops: 2 });
  assert.equal(up.neighborhood.distances.a.upstream, 2);
  const short = queryWorkspace(w, { command: 'node', mechanic: 'base', id: 'a', hops: 2, maxNodes: 1 });
  assert.deepEqual(Object.keys(short.neighborhood.distances), ['a']); assert.equal(short.output.complete, false);
});

test('声明与推导分开，空条件不等于成立，文本保留端点定义、来源与截断', () => {
  const w = synthetic(), graph = queryWorkspace(w, { command: 'graph', mechanic: 'base' });
  assert.equal(graph.edges[0].basis, 'declared_relation');
  assert.equal(graph.edges[0].conditionStatus, 'unspecified');
  assert.equal(graph.edges[1].conditionStatus, 'not_evaluated');
  assert.equal(graph.edges[0].sourceIncreaseMeaning, '增加');
  const q = queryWorkspace(w, { command: 'impact', mechanic: 'base', from: 'a', to: 'c', maxExpansions: 1 });
  assert.equal(q.impact.basis, 'derived_from_declared_relations');
  assert.equal(q.impact.modelCoverage, 'not_assessed');
  const text = formatQueryText(q);
  assert.match(text, /搜索不完整/); assert.match(text, /不能断言无路径/); assert.match(text, /增加方向/);
  const fullText = formatQueryText(queryWorkspace(w, { command: 'impact', mechanic: 'base', from: 'a', to: 'c' }));
  assert.match(fullText, /base\/ac/); assert.match(fullText, /假设.*未求值/);
});
test('范围必须显式，去除布局，视图使用源规则，同名 ID 按文件类型区分', () => {
  const before = JSON.stringify(source);
  assert.throws(() => queryWorkspace(source, { command: 'graph' }), { code: 'SCOPE_REQUIRED' });
  assert.throws(() => queryWorkspace(source, { command: 'graph', mechanic: 'missing' }), { code: 'SCOPE_NOT_FOUND' });
  const result = queryWorkspace(source, { command: 'graph', mechanic: 'basic-rules' });
  assert.equal(JSON.stringify(result).includes('positions'), false);
  assert.ok(result.edges.every(e => e.origin.file));
  assert.equal(result.output.complete, true);
  assert.equal(JSON.stringify(source), before);
  const w = synthetic();
  assert.equal(queryWorkspace(w, { command: 'graph', view: 'base' }).scope.kind, 'view');
  assert.equal(queryWorkspace(w, { command: 'graph', mechanic: 'base' }).scope.kind, 'mechanic');
  assert.throws(() => queryWorkspace(w, { command: 'graph', mechanic: 'base', revision: 'old' }), { code: 'REVISION_CONFLICT' });
});
test('等号单向且不改变符号，混合影响不抵消，证据保留保存方向和条件', () => {
  const w = synthetic();
  const result = queryWorkspace(w, { command: 'impact', mechanic: 'base', from: 'a', to: 'c' });
  assert.equal(result.impact.kind, 'mixed');
  assert.equal(result.impact.complete, true);
  const direct = result.evidence.paths.find(p => p.sign === -1).steps[0];
  assert.equal(direct.source, 'a'); assert.equal(direct.target, 'c');
  assert.equal(direct.file, 'base.mechanic.json');
  assert.equal(direct.condition, '假设');
  assert.equal(queryWorkspace(w, { command: 'impact', mechanic: 'base', from: 'b', to: 'a' }).impact.kind, 'not_found');
  assert.equal(result.semanticsVersion, 'directed-neutral-1');
  assert.equal(result.conditionsEvaluated, false);
  assert.deepEqual(result.evidence.nodes.map(node => node.id), ['a', 'b', 'c']);
  assert.equal(queryWorkspace(w, { command: 'impact', mechanic: 'base', from: 'a', to: 'b' }).impact.kind, 'neutral_only');
  assert.equal(queryWorkspace(w, { command: 'impact', mechanic: 'base', from: 'a', to: 'd' }).impact.kind, 'not_found');
  const clipped = queryWorkspace(w, { command: 'impact', mechanic: 'base', from: 'a', to: 'c', evidenceLimit: 1 });
  assert.equal(clipped.impact.complete, true); assert.equal(clipped.evidence.complete, false);
  const limited = queryWorkspace(w, { command: 'impact', mechanic: 'base', from: 'b', to: 'c', maxExpansions: 1 });
  assert.equal(limited.impact.complete, false);
  assert.deepEqual(limited.impact.truncationReasons, ['maxExpansions']);
});
test('节点网络只返回直接边，方向、预算和未知节点明确', () => {
  const w = synthetic();
  const result = queryWorkspace(w, { command: 'node', mechanic: 'base', id: 'b', direction: 'upstream' });
  assert.deepEqual(result.nodes.map(n => n.id), ['b', 'a']);
  assert.deepEqual(result.edges.map(e => e.id), ['base/ab']);
  const down = queryWorkspace(w, { command: 'node', mechanic: 'base', id: 'b', direction: 'downstream' });
  assert.deepEqual(down.nodes.map(n => n.id), ['b', 'c']);
  const limited = queryWorkspace(w, { command: 'node', mechanic: 'base', id: 'b', maxNodes: 1 });
  assert.equal(limited.nodes[0].id, 'b'); assert.equal(limited.output.complete, false);
  assert.throws(() => queryWorkspace(w, { command: 'node', mechanic: 'base', id: '未知' }), { code: 'NODE_NOT_FOUND' });
  w.definitions.nodes.push({ id: 'outside' });
  assert.throws(() => queryWorkspace(w, { command: 'node', mechanic: 'base', id: 'outside' }), { code: 'NODE_OUT_OF_SCOPE' });
  for (const value of [0, -1, 1.5, 10000000]) assert.throws(() => queryWorkspace(w, { command: 'node', mechanic: 'base', id: 'b', hops: value }));
});
test('无目标的大分支搜索受展开预算限制', () => {
  const w = synthetic();
  w.mechanics[0].edges = [];
  for (let i = 0; i < 20; i++) {
    const id = 'n' + i; w.definitions.nodes.push({ id, label: id }); w.mechanics[0].nodeIds.push(id);
    for (let j = 0; j < i; j++) w.mechanics[0].edges.push({ id: 'e' + i + '-' + j, source: 'n' + j, target: id, relation: 'influence', sign: 1, condition: '', note: '' });
  }
  const result = queryWorkspace(w, { command: 'impact', mechanic: 'base', from: 'n0', to: 'd', maxExpansions: 30 });
  assert.equal(result.impact.expandedStates, 30); assert.equal(result.impact.complete, false);
});
test('真实 CLI 离线四命令、错误退出、只读且释放锁', async t => {
  const root = await fixture(t);
  const before = await readWorkspace(root);
  const common = ['--workspace', root];
  assert.equal(JSON.parse((await call(['scopes', ...common])).stdout).savedOnly, true);
  const search = JSON.parse((await call(['search', '--query', '抽牌', ...common])).stdout);
  assert.ok(search.nodes.some(n => n.id === 'draw'));
  assert.ok(JSON.parse((await call(['graph', '--mechanic', 'basic-rules', ...common])).stdout).nodes.length);
  const id = before.mechanics.find(a => a.id === 'basic-rules').nodeIds[0];
  assert.ok(JSON.parse((await call(['node', '--mechanic', 'basic-rules', '--id', id, ...common])).stdout).neighborhood);
  assert.ok(JSON.parse((await call(['impact', '--mechanic', 'basic-rules', '--from', id, '--to', id, ...common])).stdout).impact);
  await assert.rejects(call(['graph', ...common]), error => error.code === 1 && JSON.parse(error.stderr).error === 'SCOPE_REQUIRED');
  assert.equal((await readWorkspace(root)).revision, before.revision);
  assert.equal((await readdir(root)).includes('.game-graph.lock'), false);
  const store = await createWorkspaceStore(root);
  try { await assert.rejects(call(['scopes', ...common]), error => JSON.parse(error.stderr).error === 'WORKSPACE_LOCKED'); }
  finally { await store.close(); }
});
test('在线 CLI 与队列读取、凭据校验、旧版本明确失败', async t => {
  const root = await fixture(t, false), server = await startServer({ workspaceRoot: root, port: 0 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const env = { ...process.env, GAME_GRAPH_SESSION_TOKEN: server.token };
  const first = JSON.parse((await call(['scopes', '--connect', server.origin], env)).stdout);
  const searched = JSON.parse((await call(['search', '--query', '抽牌', '--mechanic', 'basic-rules', '--connect', server.origin], env)).stdout);
  assert.ok(searched.nodes.some(n => n.id === 'draw'));
  const related = JSON.parse((await call(['node', '--id', 'draw', '--mechanic', 'basic-rules', '--hops', '2', '--direction', 'both', '--connect', server.origin], env)).stdout);
  assert.equal(related.neighborhood.distances.hand.downstream, 1);
  const unauthorized = await fetch(server.origin + '/api/agent?command=scopes');
  assert.equal(unauthorized.status, 401);
  const saved = await fetch(server.origin + '/api/save', { method: 'POST', headers: { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: first.revision, kind: 'workspace', document: { ...(await readWorkspace(root)).manifest, name: '更新名称' } }) });
  assert.equal(saved.status, 200);
  await assert.rejects(call(['scopes', '--connect', server.origin, '--revision', first.revision], env), error => JSON.parse(error.stderr).error === 'REVISION_CONFLICT');
  assert.notEqual(JSON.parse((await call(['scopes', '--connect', server.origin], env)).stdout).revision, first.revision);
  await assert.rejects(call(['scopes', '--connect', server.origin], { ...env, GAME_GRAPH_SESSION_TOKEN: '' }), error => JSON.parse(error.stderr).error === 'SESSION_REQUIRED');
});

test('查询排在同一 store 保存之后，返回确认保存的版本', async t => {
  const root = await fixture(t), store = await createWorkspaceStore(root);
  try {
    const before = await store.read();
    const saving = store.save({ revision: before.revision, kind: 'workspace', document: { ...before.manifest, name: '队列后的名称' } });
    const reading = store.readForQuery();
    const [saved, queried] = await Promise.all([saving, reading]);
    assert.equal(queried.revision, saved.revision);
    assert.equal(queried.manifest.name, '队列后的名称');
  } finally { await store.close(); }
});
