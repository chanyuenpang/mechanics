import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { selectConversationConcepts } from '../src/domain/conversation-projection.mjs';
import { createRenderServer, CONVERSATION_WIDGET_URI } from '../src/server/mcp-render.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'mechanics-mcp-render-'));
  await copyExampleFixture(projectRoot);
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  return { projectRoot, workspace: await readWorkspace(join(projectRoot, '.mechanics')) };
}

test('对话局部投影保留全部请求节点，仅保留集合内部关系及来源机制', async t => {
  const { workspace } = await fixture(t);
  const graph = selectConversationConcepts(workspace, ['damage', 'health', 'stamina']);
  assert.deepEqual(graph.nodes.map(node => node.id), ['damage', 'health', 'stamina']);
  assert.deepEqual(graph.edges.map(edge => edge.id), ['damage-2-health']);
  assert.equal(graph.edges[0].ruleText, '伤害未被其他机制吸收');
  assert.deepEqual(graph.edges[0].sourceMechanics.map(item => item.id), ['basic-rules']);
});

test('对话局部投影拒绝重复、空白和不存在的 ID，不猜测或忽略', async t => {
  const { workspace } = await fixture(t);
  for (const ids of [['damage', 'damage'], ['damage', ''], ['damage', 'Bad ID'], ['damage', 'not-found']]) {
    assert.throws(() => selectConversationConcepts(workspace, ids), error => error.code === 'CONCEPT_IDS_INVALID');
  }
});

test('MCP 工具绑定 Apps resource，返回结构化图结果与结构化错误', async t => {
  const { projectRoot } = await fixture(t);
  const { server } = await createRenderServer({ start: projectRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mechanics-render-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools();
  const tool = tools.tools.find(item => item.name === 'mechanics_render_concepts');
  assert.equal(tool._meta.ui.resourceUri, CONVERSATION_WIDGET_URI);
  assert.equal(tool.annotations.readOnlyHint, true);
  const resource = await client.readResource({ uri: CONVERSATION_WIDGET_URI });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.contents[0].text, /ui\/initialize/);
  assert.match(resource.contents[0].text, /ui\/notifications\/tool-result/);
  assert.match(resource.contents[0].text, /canvas\.addEventListener\("wheel"/);
  assert.match(resource.contents[0].text, /ui\/notifications\/initialized/);
  assert.match(resource.contents[0].text, /ui\/notifications\/size-changed/);
  assert.match(resource.contents[0].text, /Math\.min\(720, Math\.max\(320, 272 \+ nodeCount \* 48\)\)/);
  assert.match(resource.contents[0].text, /#canvas-tooltip\{position:fixed/);
  assert.match(resource.contents[0].text, /#canvas\{[^}]*user-select:none/);
  assert.match(resource.contents[0].text, /tipBounds\.height > bounds\.bottom/);
  assert.doesNotMatch(resource.contents[0].text, /src="ui:\/\//);
  assert.doesNotMatch(resource.contents[0].text, /window\.openai/);
  const result = await client.callTool({ name: 'mechanics_render_concepts', arguments: { conceptIds: ['damage', 'health', 'stamina'] } });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, '渲染成功。');
  assert.deepEqual(result.structuredContent.graph.nodes.map(node => node.id), ['damage', 'health', 'stamina']);
  assert.deepEqual(result.structuredContent.graph.edges.map(edge => edge.id), ['damage-2-health']);
  const failed = await client.callTool({ name: 'mechanics_render_concepts', arguments: { conceptIds: ['damage', 'missing'] } });
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.structuredContent.error.details.unknownIds, ['missing']);
});
