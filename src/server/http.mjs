import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createProjectManager } from './project-manager.mjs';
import { createPreferences } from './preferences.mjs';
import { browseDirectories, createProjectHistory } from './local-projects.mjs';
import { queryFromSearch } from './agent.mjs';
import { queryWorkspace } from '../domain/query.mjs';
import { createNativeDirectoryPicker } from './native-directory-picker.mjs';

const dependency = createRequire(import.meta.url);

const assets = new Map([
  ['/', [new URL('../web/index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/app.mjs', [new URL('../web/app.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/icons.mjs', [new URL('../web/icons.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/canvas.mjs', [new URL('../web/canvas.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/route-cache.mjs', [new URL('../web/route-cache.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/layout.mjs', [new URL('../web/layout.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/hierarchical-layout.mjs', [new URL('../web/hierarchical-layout.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/layout-structure.mjs', [new URL('../web/layout-structure.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/local-routing.mjs', [new URL('../web/local-routing.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/flow-refinement.mjs', [new URL('../web/flow-refinement.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/graph-compute.mjs', [new URL('../web/graph-compute.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/graph-compute-kernel.mjs', [new URL('../web/graph-compute-kernel.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/auto-layout.mjs', [new URL('../web/auto-layout.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/geometry-settle.mjs', [new URL('../web/geometry-settle.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/graph-compute-worker.js', [new URL('../web/graph-compute-worker.js', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/glossary.mjs', [new URL('../web/glossary.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/concept-docs.mjs', [new URL('../web/concept-docs.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/resource-navigation.mjs', [new URL('../web/resource-navigation.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/view-files.mjs', [new URL('../web/view-files.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/style.css', [new URL('../web/style.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/icons/eye.svg', [new URL('../web/icons/eye.svg', import.meta.url), 'image/svg+xml']],
  ['/icons/eye-off.svg', [new URL('../web/icons/eye-off.svg', import.meta.url), 'image/svg+xml']],
  ['/domain/graph.mjs', [new URL('../domain/graph.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/domain/view.mjs', [new URL('../domain/view.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/domain/endpoint-projection.mjs', [new URL('../domain/endpoint-projection.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/domain/read-graph-integrity.mjs', [new URL('../domain/read-graph-integrity.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/domain/hover-details.mjs', [new URL('../domain/hover-details.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/domain/identity.mjs', [new URL('../domain/identity.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/domain/taxonomy-presentation.mjs', [new URL('../domain/taxonomy-presentation.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/vendor/elk.js', [dependency.resolve('elkjs/lib/elk.bundled.js'), 'text/javascript; charset=utf-8']],
  ['/vendor/elk-worker.js', [dependency.resolve('elkjs/lib/elk-worker.min.js'), 'text/javascript; charset=utf-8']],
  ['/vendor/libavoid/index.js', [new URL('index.js', pathToFileURL(dependency.resolve('libavoid-js'))), 'text/javascript; charset=utf-8']],
  ['/vendor/libavoid/libavoid.wasm', [new URL('libavoid.wasm', pathToFileURL(dependency.resolve('libavoid-js'))), 'application/wasm']],
  ['/vendor/webcola.js', [dependency.resolve('webcola/WebCola/cola.min.js'), 'text/javascript; charset=utf-8']],
]);

export async function startServer({ projectRoot = null, workspaceRoot = null, port = 4319, preferencesPath, projectHistoryPath, syncProjectAssets, directoryPicker = createNativeDirectoryPicker() }) {
  if (workspaceRoot) throw new Error('startServer 只接受 projectRoot；工作区固定为项目内 .mechanics');
  // Schema 在进程启动时由 AJV 固定。网页资源也必须在同一时刻固定，避免包文件被更新后，
  // 旧校验器向浏览器发送新版页面，从而出现“可编辑但不能保存”的协议撕裂。
  const servedAssets = new Map(await Promise.all([...assets].map(async ([path, [source, type]]) =>
    [path, { content: await readFile(source), type }])));
  const projectHistory = createProjectHistory(projectHistoryPath);
  const projects = createProjectManager({ onActivated: project => projectHistory.record(project), syncProjectAssets });
  if (projectRoot) await projects.open({ projectRoot });
  const preferences = createPreferences(preferencesPath);
  let origin;
  const server = createServer(async (request, response) => {
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      // libavoid 的 Emscripten 绑定还会动态生成函数包装；只在计算 Worker 中开放。
      // 页面继续禁止动态脚本求值，Worker 的脚本来源仍限定本机自身。
      const scriptPolicy = request.url.split('?')[0] === '/graph-compute-worker.js' ? "'self' 'unsafe-eval'" : "'self'";
      response.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true',
        'Content-Security-Policy': `default-src 'self'; script-src ${scriptPolicy}; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
      });
      response.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    };
    try {
      if (request.headers.host !== new URL(origin).host) {
        send(403, { error: 'HOST_REJECTED', message: '请求 Host 不是当前本机服务' }); return;
      }
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (request.method === 'OPTIONS') { send(204, ''); return; }
        if (request.method === 'GET' && url.pathname === '/api/project') { send(200, await projects.state()); return; }
        if (request.method === 'GET' && url.pathname === '/api/project/assets') {
          send(200, projects.readAssetSync(url.searchParams.get('projectSessionToken') ?? undefined)); return;
        }
        // 仅 CLI 在确认端口已被本服务占用时调用：先完成响应，再关闭旧进程，
        // 使新版 mech web 能接管同端口而不会误杀其他本机服务。
        if (request.method === 'POST' && url.pathname === '/api/server/handoff') {
          send(202, { service: 'mechanics', handoff: 'accepted' });
          queueMicrotask(() => { void close(); });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/projects') { send(200, await projectHistory.read()); return; }
        if (request.method === 'GET' && url.pathname === '/api/directories') {
          send(200, await browseDirectories(url.searchParams.get('path'))); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/workspace') {
          send(200, await projects.read(url.searchParams.get('projectSessionToken') ?? undefined)); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/local-ui-state') {
          send(200, await projects.readLocalUiState(url.searchParams.get('projectSessionToken') ?? undefined)); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/project-references') {
          send(200, await projects.listProjectReferences(url.searchParams.get('projectSessionToken') ?? undefined)); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent') {
          const agentSearch = new URLSearchParams(url.searchParams); agentSearch.delete('projectRoot'); agentSearch.delete('projectSessionToken');
          const query = queryFromSearch(agentSearch);
          const workspace = query.command === 'guide' ? null : await projects.readForAgent({ projectRoot: url.searchParams.get('projectRoot') });
          const result = queryWorkspace(workspace, query);
          send(200, workspace ? { ...result, projectGeneration: workspace.projectGeneration } : result); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent/session') {
          send(200, await projects.agentEditStatus({ projectSessionToken: url.searchParams.get('projectSessionToken') ?? undefined,
            projectRoot: url.searchParams.get('projectRoot'), projectGeneration: Number(url.searchParams.get('projectGeneration')), editSessionId: url.searchParams.get('session') })); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/agent/mechanic') {
          send(200, await projects.openAgentMechanic({ projectRoot: url.searchParams.get('projectRoot'),
            projectGeneration: Number(url.searchParams.get('projectGeneration')), mechanic: url.searchParams.get('mechanic') })); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/mechanic') {
          send(200, await projects.readMechanic({ projectSessionToken: url.searchParams.get('projectSessionToken'),
            projectGeneration: Number(url.searchParams.get('projectGeneration')), id: url.searchParams.get('id'), file: url.searchParams.get('file') })); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/concept-docs') {
          const conceptId = url.searchParams.get('conceptId');
          const file = url.searchParams.get('file');
          if (conceptId !== null && file !== null) throw new Error('概念与文件夹文档不能同时选择');
          send(200, await projects.readConceptDocs(file === null ? conceptId : { file }, url.searchParams.get('projectSessionToken') ?? undefined)); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/document-export/settings') {
          send(200, await projects.readDocumentExport(url.searchParams.get('projectSessionToken') ?? undefined)); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/preferences') { send(200, await preferences.read()); return; }
        if (request.method === 'POST' && ['/api/directories/pick', '/api/project/open', '/api/project/select', '/api/project/reference-enter', '/api/project/settings', '/api/project/export-path', '/api/document-export/settings', '/api/document-export/generate', '/api/projects/pin',
          '/api/projects/remove', '/api/save', '/api/rules-and-mechanic', '/api/concept-taxonomy', '/api/rules/delete', '/api/mechanic-nodes/remove', '/api/local-ui-state', '/api/project-references/bind', '/api/project-references/declare', '/api/project-references/remove', '/api/mechanics', '/api/mechanic-folders', '/api/mechanic-folder-move', '/api/mechanic-folder-delete', '/api/mechanic-move', '/api/mechanic-delete', '/api/views', '/api/preferences', '/api/agent/session', '/api/agent/mutation', '/api/agent/draft'].includes(url.pathname)) {
          if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            send(415, { error: 'JSON_REQUIRED', message: '写入必须使用 application/json' }); return;
          }
          const chunks = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 3 * 1024 * 1024) { send(413, { error: 'BODY_LIMIT', message: '请求超过 3 MiB' }); return; }
            chunks.push(chunk);
          }
          const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求必须是 JSON 对象');
          if (url.pathname === '/api/directories/pick') {
            if (request.headers.origin !== origin) { send(403, { error: 'ORIGIN_REJECTED', message: '原生文件夹选择器只能由本工具页面打开' }); return; }
            // 页面关闭或请求中止只取消该请求拥有的选择器，不能中止另一个正在选择的请求。
            const controller = new AbortController();
            const abort = () => controller.abort();
            response.once('close', abort);
            try { send(200, await directoryPicker.pick(body, { signal: controller.signal })); }
            finally { response.removeListener('close', abort); }
            return;
          }
          if (url.pathname === '/api/preferences') { send(200, await preferences.save(body)); return; }
          if (url.pathname === '/api/local-ui-state') { send(200, await projects.saveLocalUiState(body)); return; }
          if (url.pathname === '/api/project-references/bind') { send(200, await projects.bindProjectReference(body)); return; }
          if (url.pathname === '/api/project-references/declare') { send(200, await projects.declareProjectReference(body)); return; }
          if (url.pathname === '/api/project-references/remove') { send(200, await projects.removeProjectReference(body)); return; }
          if (url.pathname === '/api/project/select') { send(200, await projects.select(body.projectSessionToken)); return; }
          if (url.pathname === '/api/project/reference-enter') { send(200, await projects.enterReference(body)); return; }
          if (url.pathname === '/api/projects/pin') { send(200, await projectHistory.pin(body)); return; }
          if (url.pathname === '/api/projects/remove') { send(200, await projectHistory.remove(body)); return; }
          if (url.pathname === '/api/project/open') { send(200, await projects.open(body)); return; }
          if (url.pathname === '/api/project/settings') { send(200, await projects.setProjectSettings(body)); return; }
          if (url.pathname === '/api/project/export-path') { send(200, await projects.setAgentExportPath(body)); return; }
          if (url.pathname === '/api/document-export/settings') { send(200, await projects.setDocumentExport(body)); return; }
          if (url.pathname === '/api/document-export/generate') { send(200, await projects.generateDocumentExport(body)); return; }
          if (url.pathname === '/api/agent/session') {
            if (body.action === 'open') { send(200, await projects.openAgentEdit(body)); return; }
            if (body.action === 'close') { send(202, await projects.closeAgentEdit(body)); return; }
            throw Object.assign(new Error('Agent 编辑会话只支持 open 或 close'), { code: 'AGENT_EDIT_SESSION_INVALID' });
          }
          if (url.pathname === '/api/agent/draft') {
            if (body.action === 'open') { send(200, await projects.openAgentDraft(body)); return; }
            if (body.action === 'save') { send(200, await projects.saveAgentDraft(body)); return; }
            throw Object.assign(new Error('Agent 草稿只支持 open 或 save'), { code: 'AGENT_DRAFT_INVALID' });
          }
          if (url.pathname === '/api/agent/mutation') { send(200, await projects.mutateAgent(body)); return; }
          if (url.pathname === '/api/rules-and-mechanic') { send(200, await projects.saveRulesAndMechanic(body)); return; }
          if (url.pathname === '/api/concept-taxonomy') { send(200, await projects.saveConceptTaxonomy(body)); return; }
          if (url.pathname === '/api/rules/delete') { send(200, await projects.deleteGlobalRule(body)); return; }
          if (url.pathname === '/api/mechanic-nodes/remove') { send(200, await projects.removeMechanicNodes(body)); return; }
          if (url.pathname === '/api/mechanic-folders') { send(200, await projects.createMechanicFolder(body)); return; }
          if (url.pathname === '/api/mechanic-move') { send(200, await projects.moveMechanic(body)); return; }
          if (url.pathname === '/api/mechanic-folder-move') { send(200, await projects.moveMechanicFolder(body)); return; }
          if (url.pathname === '/api/mechanic-folder-delete') { send(200, await projects.deleteMechanicFolder(body)); return; }
          if (url.pathname === '/api/mechanic-delete') { send(200, await projects.deleteMechanic(body)); return; }
          send(200, await (url.pathname === '/api/save' ? projects.save(body) : url.pathname === '/api/views' ? projects.createView(body) : projects.createMechanic(body))); return;
        }
        send(405, { error: 'METHOD_NOT_ALLOWED', message: '此接口不支持该操作' }); return;
      }
      if (request.method !== 'GET') { send(405, { error: 'METHOD_NOT_ALLOWED', message: '静态资源只支持读取' }); return; }
      const asset = servedAssets.get(url.pathname);
      if (!asset) { send(404, { error: 'NOT_FOUND', message: '没有此资源' }); return; }
      send(200, asset.content, asset.type);
    } catch (error) {
      // 不返回部分工作区，不把失败替换为空数据或内置示例。
      const status = ['REVISION_CONFLICT', 'REFERENCE_REVISION_CONFLICT', 'FILE_EXISTS', 'DUPLICATE_ID', 'WORKSPACE_LOCKED', 'PROJECT_REQUIRED', 'PROJECT_CHANGED',
        'PROJECT_PREFLIGHT_STALE', 'PROJECT_INTENT_MISMATCH', 'DIRECTORY_PICKER_BUSY'].includes(error.code) ? 409
        : ['SAVE_UNCERTAIN', 'CREATE_PARTIAL', 'PROJECT_SWITCH_PARTIAL', 'AGENT_EXPORT_FAILED', 'REFERENCE_DECLARATION_PARTIAL', 'REFERENCE_REMOVAL_PARTIAL', 'REFERENCE_REMOVAL_UNCERTAIN'].includes(error.code) ? 500 : 422;
      const detailKeys = ['canonicalCommitted', 'workspaceId', 'revision', 'resourceRevision', 'resource', 'action', 'id', 'references', 'referenceDeclared', 'reference', 'referenceRemoved', 'referenceId', 'referencesRevision', 'referencesPath', 'layoutTimings', 'layoutPhases'];
      const details = Object.fromEntries(detailKeys.filter(key => Object.hasOwn(error, key)).map(key => [key, error[key]]));
      send(status, { error: error.code ?? 'REQUEST_FAILED', message: error.message, ...details });
    }
  });
  try { await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }); } catch (error) { await projects.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    directoryPicker.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await projects.close();
  };
  return { server, close, origin, url: `${origin}/` };
}
