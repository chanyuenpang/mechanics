import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { MAX_GRAPH_CONCEPTS, apply, createRouteHandler, renderGraphResult, renderSearchResult } from '../packages/dsh-adapter/src/index.mjs';
import { resolveProjectRoot, resolveSessionDirectory } from '../packages/dsh-adapter/src/workspace-tool.mjs';
import { copiedExampleProject, installWorkspaceTool } from './workspace-tool-harness.mjs';

// 子进程 seam 的测试替身：只实现插件用到的那部分契约（argv 直跑、收集式输出、退出事实、终止）。
function createRuntime() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const buckets = { stdout: { text: '', dropped: false }, stderr: { text: '', dropped: false } };
      for (const stream of ['stdout', 'stderr']) {
        const mode = spec.stdio[stream];
        const maxBytes = typeof mode === 'object' && mode !== null ? mode.maxBytes : Infinity;
        child[stream].on('data', chunk => {
          const bucket = buckets[stream];
          bucket.text += String(chunk);
          if (Buffer.byteLength(bucket.text) > maxBytes) {
            bucket.text = bucket.text.slice(-maxBytes);
            bucket.dropped = true;
          }
        });
      }
      if (spec.signal) spec.signal.addEventListener('abort', () => child.kill(), { once: true });
      const reader = stream => ({ readFrom: () => ({ text: buckets[stream].text, nextOffset: buckets[stream].text.length, lossy: buckets[stream].dropped }) });
      return {
        done: new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
        }),
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        terminate: () => child.kill(),
      };
    },
  };
}

function mount(runtime) {
  const registered = [];
  const services = {
    tools: { register: definition => registered.push(definition) },
    subprocess: runtime,
  };
  apply({ get: name => services[name] });
  return registered;
}

const session = cwd => ({ agent: { session: { header: { cwd } } } });
const toolNamed = (definitions, toolName) => definitions.find(definition => definition.name === toolName);

test('apply 注册两个只读工具，schema 与输出面齐备', async () => {
  const definitions = mount(createRuntime());
  assert.deepEqual(definitions.map(definition => definition.name), ['mechanics_search', 'mechanics_graph']);
  const search = toolNamed(definitions, 'mechanics_search');
  // 提供方契约：根必须是 type: "object"（根级 oneOf 会被模型 API 拒成 'type: null'）。
  for (const definition of definitions) {
    assert.equal(definition.parameters.type, 'object', definition.name + ' 的 parameters 根必须是 object');
    assert.equal(definition.parameters.oneOf, undefined);
  }
  assert.deepEqual(Object.keys(search.parameters.properties), ['query', 'from', 'to']);
  // 两种调用形式的互斥因此落在 execute：{} 与「只给一端」都是显式 TOOL_INVALID。
  for (const bad of [{}, { from: 'turn' }, { query: 'a', from: 'b', to: 'c' }]) {
    await assert.rejects(search.execute(bad, session(process.cwd())), error => error.code === 'TOOL_INVALID', JSON.stringify(bad) + ' 必须被拒绝');
  }
  const graph = toolNamed(definitions, 'mechanics_graph');
  assert.deepEqual(graph.parameters.required, ['conceptIds']);
  assert.equal(graph.parameters.properties.conceptIds.type, 'array');
  for (const definition of definitions) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.output.presentationMeta, 'function');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(definition.timeoutMs, 20_000);
    assert.equal(definition.isConcurrencySafe(), true);
  }
});

test('mechanics_search 真实调用项目内工具，候选与渲染一致', async t => {
  const projectRoot = await copiedExampleProject(t);
  await installWorkspaceTool(projectRoot);
  const search = toolNamed(mount(createRuntime()), 'mechanics_search');
  const value = await search.execute({ query: '闪避' }, session(projectRoot));
  assert.equal(value.resolution.status, 'fuzzy');
  assert.deepEqual(value.resolution.candidates.map(item => item.id), ['evade']);
  const rendered = search.output.render({ query: '闪避' }, value);
  assert.match(rendered[0].text, /“闪避”没有精确命中/);
  assert.match(rendered[0].text, /evade/);
  assert.match(rendered[0].text, /不会替你消歧/);
  // 卡片数据就是工具结果本身：投影形状由 workspace-tool.mjs 独有。
  assert.equal(search.output.presentationMeta({ query: '闪避' }, value), value);
});

test('mechanics_graph 返回集合内部投影，模型只读清单', async t => {
  const projectRoot = await copiedExampleProject(t);
  await installWorkspaceTool(projectRoot);
  const graph = toolNamed(mount(createRuntime()), 'mechanics_graph');
  const value = await graph.execute({ conceptIds: ['melee', 'damage'] }, session(projectRoot));
  assert.deepEqual(value.edges.map(edge => edge.id), ['melee-2-damage']);
  const rendered = graph.output.render({}, value).map(block => block.text).join('\n');
  assert.match(rendered, /2 个概念、集合内部 1 条声明关系/);
  assert.match(rendered, /melee \+> damage/);
  assert.doesNotMatch(rendered, /"nodes"/);
});

test('参数、工作区与工具缺失都走显式失败', async t => {
  const runtime = createRuntime();
  const graph = toolNamed(mount(runtime), 'mechanics_graph');
  const search = toolNamed(mount(runtime), 'mechanics_search');
  const projectRoot = await copiedExampleProject(t);

  await assert.rejects(search.execute({}, session(projectRoot)), error => error.code === 'TOOL_INVALID');
  await assert.rejects(search.execute({ query: 'a', from: 'b' }, session(projectRoot)), error => error.code === 'TOOL_INVALID');
  await assert.rejects(graph.execute({ conceptIds: [] }, session(projectRoot)), error => error.code === 'TOOL_INVALID');
  await assert.rejects(graph.execute({ conceptIds: ['melee', 'melee'] }, session(projectRoot)), error => error.code === 'TOOL_INVALID');
  await assert.rejects(graph.execute({ conceptIds: Array.from({ length: MAX_GRAPH_CONCEPTS + 1 }, (_, index) => 'c' + index) }, session(projectRoot)), error => error.code === 'TOOL_INVALID');

  // 项目缺少受管工具：不降级、不自带副本，直接点名安装动作。
  await assert.rejects(graph.execute({ conceptIds: ['melee'] }, session(projectRoot)), error => error.code === 'WORKSPACE_TOOL_MISSING');

  await installWorkspaceTool(projectRoot);
  await assert.rejects(graph.execute({ conceptIds: ['melee', 'not-a-concept'] }, session(projectRoot)), error => error.code === 'NODE_NOT_FOUND');
  await assert.rejects(graph.execute({ conceptIds: ['not-a-concept'] }, session(projectRoot)), error => /NODE_NOT_FOUND/.test(error.code));

  const empty = await mkdtemp(join(tmpdir(), 'mechanics-no-workspace-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await assert.rejects(graph.execute({ conceptIds: ['melee'] }, session(empty)), error => error.code === 'WORKSPACE_NOT_FOUND');
  await assert.rejects(graph.execute({ conceptIds: ['melee'] }, { agent: { session: {} } }), error => error.code === 'SESSION_CWD_UNAVAILABLE');
});

test('工作区定位与会话目录解析', async t => {
  const projectRoot = await copiedExampleProject(t);
  assert.equal(await resolveProjectRoot(projectRoot), projectRoot);
  assert.equal(await resolveProjectRoot(join(projectRoot, '.mechanics', 'mechanics')), projectRoot);
  const empty = await mkdtemp(join(tmpdir(), 'mechanics-no-workspace-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal(await resolveProjectRoot(empty), undefined);
  assert.equal(resolveSessionDirectory({ session: { header: { cwd: 'C:/tmp/x' } } }), 'C:/tmp/x');
  assert.equal(resolveSessionDirectory({ session: {} }), undefined);
});

test('渲染函数在空关系集合上仍然可读', () => {
  const rendered = renderGraphResult({}, { revision: 'r'.repeat(40), nodes: [{ id: 'a', label: 'A' }], edges: [] });
  assert.match(rendered[0].text, /集合内部没有声明关系/);
  const missing = renderSearchResult({ query: '不存在' }, { resolution: { status: 'not_found' } });
  assert.match(missing[0].text, /没有找到概念“不存在”/);
  assert.match(missing[0].text, /不证明游戏中不存在/);
  // 成对规则：端点在结果的 from/to 上，规则 DTO 只有 operator；渲染不得出现 undefined。
  const pair = renderSearchResult({ from: 'turn', to: 'draw' }, {
    from: { id: 'turn', label: '回合' },
    to: { id: 'draw', label: '抽牌行动' },
    rules: { forward: [{ id: 'turn-2-draw', operator: '+>', ruleText: '回合开始后抽牌' }], reverse: [] },
  }).map(block => block.text).join('\n');
  assert.match(pair, /turn \+> draw：回合开始后抽牌/);
  assert.doesNotMatch(pair, /undefined/);
  const pairGap = renderSearchResult({ from: '闪避', to: '近战' }, { from: { status: 'not_found' }, to: { status: 'ambiguous', candidates: [{ id: 'melee' }] }, rules: null });
  assert.match(pairGap[0].text, /两端都必须精确解析成稳定 ID/);
  assert.match(pairGap[0].text, /from “闪避”：not_found/);
  assert.match(pairGap[0].text, /to “近战”：ambiguous（候选：melee）/);
});

// 只读路由：卡片在 presentationMeta 覆盖不到的场景（Code Mode 子派发）用它取同一份投影。
async function routeBase(t, runtime) {
  const server = createServer(createRouteHandler(runtime));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return 'http://127.0.0.1:' + server.address().port;
}

const graphUrl = (base, project, ids) => base + '/mechanics/graph?project=' + encodeURIComponent(project) + '&ids=' + encodeURIComponent(ids);

test('只读路由返回与工具一致的投影', async t => {
  const projectRoot = await copiedExampleProject(t);
  await installWorkspaceTool(projectRoot);
  const base = await routeBase(t, createRuntime());
  const response = await fetch(graphUrl(base, projectRoot, 'melee,damage'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const value = await response.json();
  assert.deepEqual(value.conceptIds, ['melee', 'damage']);
  assert.deepEqual(value.edges.map(edge => edge.id), ['melee-2-damage']);
  // 与工具结果同形：节点带定义、边带规则文字。
  assert.equal(value.nodes[0].label, '近战');
  assert.equal(value.edges[0].ruleText, '攻击命中');
});

test('只读路由的错误路径都是显式状态码', async t => {
  const projectRoot = await copiedExampleProject(t);
  await installWorkspaceTool(projectRoot);
  const base = await routeBase(t, createRuntime());
  const empty = await mkdtemp(join(tmpdir(), 'mechanics-route-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));

  const missing = await fetch(base + '/mechanics/graph');
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'BAD_REQUEST');

  const unknownPath = await fetch(base + '/mechanics/other');
  assert.equal(unknownPath.status, 404);

  const noWorkspace = await fetch(graphUrl(base, empty, 'melee'));
  assert.equal(noWorkspace.status, 404);
  assert.equal((await noWorkspace.json()).error, 'WORKSPACE_NOT_FOUND');

  const unknownConcept = await fetch(graphUrl(base, projectRoot, 'melee,not-a-concept'));
  assert.equal(unknownConcept.status, 400);
  const unknownBody = await unknownConcept.json();
  assert.equal(unknownBody.error, 'NODE_NOT_FOUND');
  assert.deepEqual(unknownBody.details.unknownIds, ['not-a-concept']);

  const illegal = await fetch(graphUrl(base, projectRoot, 'melee,melee'));
  assert.equal(illegal.status, 400);
  assert.equal((await illegal.json()).error, 'TOOL_INVALID');

  const method = await fetch(base + '/mechanics/graph?project=' + encodeURIComponent(projectRoot) + '&ids=melee', { method: 'POST' });
  assert.equal(method.status, 405);
});


test('widget 路由返回同一份网页 widget，并注入带坐标的载荷', async t => {
  const projectRoot = await copiedExampleProject(t);
  await installWorkspaceTool(projectRoot);
  const base = await routeBase(t, createRuntime());
  const response = await fetch(base + '/mechanics/widget?project=' + encodeURIComponent(projectRoot) + '&ids=melee,damage');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  // 同一份 widget：网页/MCP 的模板与 bundle 原样提供，载荷用全局变量注入（DSH 没有 MCP Apps 宿主）。
  assert.match(html, /id="canvas"/);
  assert.match(html, /globalThis\.__MECHANICS_CONCEPTS_PAYLOAD__/);
  const payload = JSON.parse(html.match(/__MECHANICS_CONCEPTS_PAYLOAD__ = (\{[\s\S]*?\});\n/)[1]);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.graph.conceptIds, ['melee', 'damage']);
  assert.deepEqual(payload.graph.edges.map(edge => edge.id), ['melee-2-damage']);
  // 自动排版坐标必须齐全，否则 widget 画不出节点。
  for (const id of payload.graph.conceptIds) {
    assert.equal(typeof payload.graph.positions[id]?.x, 'number', id + ' 缺少坐标');
  }
});

test('widget 路由的失败在 iframe 里可读', async t => {
  const base = await routeBase(t, createRuntime());
  const empty = await mkdtemp(join(tmpdir(), 'mechanics-widget-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const noWorkspace = await fetch(base + '/mechanics/widget?project=' + encodeURIComponent(empty) + '&ids=melee');
  assert.equal(noWorkspace.status, 404);
  assert.match(noWorkspace.headers.get('content-type'), /^text\/html/);
  const html = await noWorkspace.text();
  assert.match(html, /WORKSPACE_NOT_FOUND/);
  assert.match(html, /workspace\.json/);
});

test('headless 组合没有 webServer 时插件照常注册工具', () => {
  const registered = [];
  const services = { tools: { register: definition => registered.push(definition) }, subprocess: createRuntime() };
  apply({ get: name => services[name] });
  assert.deepEqual(registered.map(definition => definition.name), ['mechanics_search', 'mechanics_graph']);
});

