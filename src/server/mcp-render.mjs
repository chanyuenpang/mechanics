import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import ELK from 'elkjs/lib/elk.bundled.js';
import { z } from 'zod';
import metadata from '../../package.json' with { type: 'json' };
import { selectConversationConcepts } from '../domain/conversation-projection.mjs';
import { ContractError } from '../domain/validate.mjs';
import { arrangeGraph } from '../web/layout.mjs';
import { findProject } from './workspace-commands.mjs';
import { projectContext } from './project-context.mjs';
import { readWorkspace } from './workspace.mjs';

export const CONVERSATION_WIDGET_URI = 'ui://mechanics/concepts-graph.html';
const widgetPath = fileURLToPath(new URL('../mcp/concepts-widget.html', import.meta.url));
const widgetBundlePath = fileURLToPath(new URL('../mcp/concepts-widget.bundle.js', import.meta.url));

async function widgetHtml() {
  const [html, bundle] = await Promise.all([readFile(widgetPath, 'utf8'), readFile(widgetBundlePath, 'utf8')]);
  return html.replace('/* MCP_WIDGET_BUNDLE */', bundle);
}

function textResult(value, text = JSON.stringify(value, null, 2)) {
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function structuredFailure(error) {
  const value = { ok: false, error: { code: error.code ?? 'RENDER_FAILED', message: error.message,
    ...(error.details ? { details: error.details } : {}) } };
  return { ...textResult(value), isError: true };
}

export async function renderConcepts(workspaceRoot, conceptIds) {
  const workspace = await readWorkspace(workspaceRoot);
  const projection = selectConversationConcepts(workspace, conceptIds);
  const seedPositions = Object.fromEntries(projection.nodes.map((node, index) => [node.id, { x: index * 260, y: 0 }]));
  const positions = await arrangeGraph({ graph: projection, positions: seedPositions, ELK });
  return { ok: true, workspace: { id: workspace.manifest.id, name: workspace.manifest.name, revision: workspace.revision },
    graph: { ...projection, positions }, semantics: {
      includesAllRequestedConcepts: true,
      relationFilter: 'only endpoints both belong to conceptIds',
      expandsNeighbors: false,
      completesPaths: false,
    } };
}

// 工作区仅在服务启动时定位一次。工具调用不接受路径，防止模型把 MCP 变成任意目录读取器。
export async function createRenderServer({ start = process.cwd() } = {}) {
  const projectRoot = await findProject(start);
  const context = await projectContext(projectRoot, { allowMissingExport: true, allowUnavailableExport: true });
  const server = new McpServer({ name: 'mechanics-conversation-render', version: metadata.version });
  server.registerResource('mechanics-concepts-widget', CONVERSATION_WIDGET_URI, {
    title: 'Mechanics 局部机制图', mimeType: 'text/html;profile=mcp-app',
    description: '只读的概念局部图；不包含编辑、搜索或路径输入。',
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
  }, async () => ({ contents: [{ uri: CONVERSATION_WIDGET_URI, mimeType: 'text/html;profile=mcp-app', text: await widgetHtml(),
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] }));
  server.registerTool('mechanics_render_concepts', {
    title: '渲染 Mechanics 概念局部图',
    description: '仅渲染已消歧的稳定概念 ID 及集合内部的声明关系；不搜索、不扩展邻居、不补路径，也不写入工作区。',
    inputSchema: z.object({ conceptIds: z.array(z.string()).min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: CONVERSATION_WIDGET_URI } },
  }, async ({ conceptIds }) => {
    try { return textResult(await renderConcepts(context.workspaceRoot, conceptIds), '渲染成功。'); }
    catch (error) { return structuredFailure(error instanceof Error ? error : new ContractError('RENDER_FAILED', String(error))); }
  });
  return { server, projectRoot, workspaceRoot: context.workspaceRoot };
}

export async function startRenderServer(options = {}) {
  const { server } = await createRenderServer(options);
  await server.connect(new StdioServerTransport());
}
