import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromPlugin = createRequire(import.meta.url);

const failure = (code, message) => Object.assign(new Error(message), { code });

/**
 * 定位 mechanics 包根：同仓开发时插件与包在同一仓库（packages/dsh-adapter 的 ../..），
 * 发布安装时用 @veewo/mechanics。两处都不在就显式失败，不退化成自绘占位。
 */
export function mechanicsRoot() {
  const sibling = join(packageDir, '..', '..');
  if (existsSync(join(sibling, 'src', 'mcp', 'concepts-widget.html'))) return sibling;
  try {
    return dirname(requireFromPlugin.resolve('@veewo/mechanics/package.json'));
  } catch {
    return undefined;
  }
}

/**
 * 每次请求现读这两份资产。
 * 之前把它们和模块一起缓存，导致 mechanics 侧改好 widget（例如拖动时的文本选中）之后，
 * DSH 这边还在发旧副本、必须重启宿主才同步——"没有同步优化"就是这个缓存造成的。
 */
export async function readWidgetAssets(root) {
  const [html, bundle] = await Promise.all([
    readFile(join(root, 'src', 'mcp', 'concepts-widget.html'), 'utf8'),
    readFile(join(root, 'src', 'mcp', 'concepts-widget.bundle.js'), 'utf8'),
  ]);
  return { html, bundle };
}

let cached;
/** 载入布局与投影模块（包内代码，随包版本变化，缓存一次即可）。 */
export async function loadWidgetSupport() {
  if (cached !== undefined) return cached;
  const root = mechanicsRoot();
  if (root === undefined) {
    throw failure('WIDGET_ASSETS_MISSING', '找不到 mechanics 包（既不在同仓相对位置，也没有安装 @veewo/mechanics）：无法提供对话流 widget。');
  }
  const asset = name => pathToFileURL(join(root, 'src', 'mcp', name)).href;
  const source = name => pathToFileURL(join(root, 'src', ...name.split('/'))).href;
  let elk;
  try {
    elk = await import(pathToFileURL(requireFromPlugin.resolve('elkjs/lib/elk.bundled.js')).href);
  } catch {
    // 同仓时 elkjs 由 mechanics 自己的依赖提供。
    elk = await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('elkjs/lib/elk.bundled.js')).href);
  }
  const [workspace, projection, layout] = await Promise.all([
    import(source('server/workspace.mjs')),
    import(source('domain/conversation-projection.mjs')),
    import(source('web/layout.mjs')),
  ]);
  cached = { root, readWorkspace: workspace.readWorkspace, selectConversationConcepts: projection.selectConversationConcepts, arrangeGraph: layout.arrangeGraph, ELK: elk.default };
  return cached;
}

/** 与 MCP widget 同一份载荷形状：{ ok, workspace, graph: { nodes, edges, positions } }。 */
export async function buildWidgetPayload(projectRoot, conceptIds) {
  const support = await loadWidgetSupport();
  const workspace = await support.readWorkspace(join(projectRoot, '.mechanics'));
  const projection = support.selectConversationConcepts(workspace, conceptIds);
  const seed = Object.fromEntries(projection.nodes.map((node, index) => [node.id, { x: index * 260, y: 0 }]));
  const positions = await support.arrangeGraph({ graph: projection, positions: seed, ELK: support.ELK });
  return {
    ok: true,
    workspace: { id: workspace.manifest.id, name: workspace.manifest.name, revision: workspace.revision },
    graph: { ...projection, positions },
  };
}

/** 把载荷注进同一份 widget HTML：DSH 里没有 MCP Apps 宿主，握手换成一个全局变量。 */
export function renderWidgetHtml(support, payload) {
  if (!support.html.includes('/* MCP_WIDGET_BUNDLE */')) {
    throw failure('WIDGET_TEMPLATE_INVALID', 'concepts-widget.html 里找不到 /* MCP_WIDGET_BUNDLE */ 占位。');
  }
  // '<' 必须转义，否则载荷里的尖括号会提前结束脚本标签。
  const injected = 'globalThis.__MECHANICS_CONCEPTS_PAYLOAD__ = ' + JSON.stringify(payload).replaceAll('<', '\\u003c') + ';\n' + support.bundle;
  return support.html.replace('/* MCP_WIDGET_BUNDLE */', () => injected);
}

/** 路由失败时给 iframe 一页可读的说明，而不是空白或裸 JSON。 */
export function renderWidgetErrorHtml(code, message) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Mechanics widget 错误</title>'
    + '<style>body{margin:0;padding:16px;font:13px/1.7 system-ui,sans-serif;background:#fff0ef;color:#9b2d25}code{font-weight:600}</style></head>'
    + '<body><div><code>' + escape(code) + '</code></div><div>' + escape(message) + '</div></body></html>';
}
