import { compose, tracePaths, summarizePaths, diagnose, downstreamNodes, setSpecializesParent, specializesDescendants } from '/domain/graph.mjs';
import { GraphCanvas, graphGeometryKey } from '/canvas.mjs';
import { createRouteCache, restoreRouteCache } from '/route-cache.mjs';
import { GraphComputeCoordinator, computeCancelled } from '/graph-compute.mjs';
import { GlossaryTable, ConceptEditor, ConceptPicker, ConceptReferencePicker, conceptPayloadFromForm, prepareReference, ReferenceCommit, prepareConceptUpdate, conceptStructurePresentation, isaParentCandidates, nextPinnedRuleIds, qualifierFormRowFromCanonical, qualifierRowForKind, qualifierValueControlModel, qualifierValueFromForm } from '/glossary.mjs';
import { ViewAutosave, viewSaveRequest, readOpening, createAndRememberView, graphPositions, changeViewVisibility, moveViewMechanic, registerViewMechanic, removeViewMechanic, prepareOpening } from '/view-files.mjs';
import { assertSemanticId, semanticRuleId } from '/domain/identity.mjs';
import { isEndpointProjection, projectEndpointQualifiers } from '/domain/endpoint-projection.mjs';
import { projectDisplayGraph } from '/domain/taxonomy-presentation.mjs';
import { buildMechanicNavigation, buildViewNavigation } from '/resource-navigation.mjs';
import { ConceptDocsPage } from '/concept-docs.mjs';
import { icon } from '/icons.mjs';

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const json = value => JSON.stringify(value);
const arrow = edge => edge.relation === 'specializes' ? ' is-a→ ' : edge.sign === 1 ? ' ＋→ ' : edge.sign === -1 ? ' −→ ' : ' ？→ ';
const NODE_COLOR_OPTIONS = [
  { color: null, label: '默认' },
  { color: '#D5E8F7', label: '浅蓝' }, { color: '#E5DCF4', label: '浅紫' }, { color: '#F5DDE7', label: '玫瑰' },
  { color: '#D2EDE2', label: '薄荷' }, { color: '#F4E2BC', label: '沙金' }, { color: '#D2EAEE', label: '浅青' }, { color: '#F5DCD2', label: '陶粉' },
];
const NODE_STYLE_OPTIONS = [
  { value: 'solid', label: '白色实线' },
  { value: 'transparent-dashed', label: '透明虚线' },
];
let lastRelation = 1;
const el = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
};
const button = (text, run, className) => {
  const item = el('button', text, className); item.type = 'button';
  item.onclick = () => Promise.resolve().then(run).catch(showError); return item;
};
const iconAction = (name, run, className = 'icon-button') => {
  const item = button('', run, className); item.append(icon(name)); return item;
};
function toggleWithKeyboard(event) {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); }
}
let workspace, activeId = null, draft, baseline, visible = [], viewRegistrations = [], viewFocusNodeIds = [], viewPinnedRuleIds = [], viewPositions = {}, viewNodeColors = {}, viewNodeStyles = {}, scopedPositions = {}, viewRouteCache = null, viewTaxonomyPresentation = { mode: 'label', expandedNodeIds: [] };
let selection = null, graph, original, history = [], future = [], pending = 0, viewState = 'saved', writeQueue = Promise.resolve();
let screen = 'mechanic', viewId = null, opening = false, arranging = false, autosave, legacy = false;
let computeState = null, arrangeSequence = 0, geometryEpoch = 0;
let settledRuntime = null;
let graphHistory = null;
const cameras = new Map();
const implicitPositions = new Map();
let referenceSession = null;
// workspace 是当前正在编辑的文件所属项目；sourceProject 是从左侧入口打开的源项目。
let sourceProject = null;
// 左侧项目树的唯一状态。它与正在编辑的文件 workspace 完全独立。
let browserWorkspace = null;
const EDITOR_TAB_LIMIT = 10;
let referenceProjects = [];
let referenceProjectsRevision = null;
const editorTabs = [];
let autoCloseEditorTabs = false;
let draggingMechanicId = null, dropPreview = null;
const mergeDocumentExportWorkspace = next => {
  // 导出设置和生成都可能推进 workspace revision；只接受当前项目会话的完整成功快照。
  if (next?.manifest && next.projectSessionToken === workspace?.projectSessionToken) workspace = next;
};
const docsPage = new ConceptDocsPage($('concept-docs'), api, showError, mergeDocumentExportWorkspace);
let conceptEditDirty = false;
const uiPreference = (key, fallback) => {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value === 'true'; } catch { return fallback; }
};
const saveUiPreference = (key, value) => { try { localStorage.setItem(key, String(value)); } catch {} };
autoCloseEditorTabs = uiPreference('mechanics:auto-close-editor-tabs', false);
const persistTabState = () => persistRecentState();
let inspectorCollapsed = uiPreference('mechanics:inspector-collapsed', false);
let hoverTooltipsEnabled = uiPreference('mechanics:hover-tooltips-enabled', true);
let hoverTooltipsTemporarilyEnabled = false;
let referencesCollapsed = uiPreference('mechanics:references-collapsed', false);
// 导航页、筛选、目录展开和最近资源只属于本次浏览会话，不写入图文件。
const sidebarState = {
  page: 'views', detailViewId: null, memberQuery: '',
  queries: { views: '', mechanics: '', recent: '' },
  folders: new Set(), recentViews: [], recentMechanics: [], lastOpened: null,
};
let recentStateWrite = Promise.resolve();
const busy = () => opening || pending > 0;
const dirty = () => draft && json(draft) !== json(baseline);
const definitionMode = () => screen === 'concepts';
const docsMode = () => screen === 'docs';
const viewMode = () => !definitionMode() && viewId !== null;
// 画布、布局与路由的唯一显示投影：隐藏的 is-a 父概念既不渲染，也不参与排版或路线。
// 任何绕过它的调用都会让画布与几何各自引用不同的图。
// 视图的展开状态以当前画布的会话状态为准：勾选后立即重算投影，保存失败也保留草稿。
const currentTaxonomyPresentation = () => (viewMode() ? viewTaxonomyPresentation : draft?.taxonomyPresentation);
const displayOptions = () => ({
  taxonomyPresentation: currentTaxonomyPresentation(),
  structuralPresentation: viewMode() ? workspace?.views.find(item => item.id === viewId)?.structuralPresentation : 'line',
  retainedNodeIds: viewMode() ? viewFocusNodeIds : draft?.focusNodeIds ?? [],
});
const displayGraphOf = (source = graph) => projectDisplayGraph(source, displayOptions());
// 隐藏的节点或连线不能继续被选中：选择只对当前显示投影里的元素有意义。
const selectionInDisplay = (display, value) => {
  if (!value) return true;
  if (value.type === 'node') return display.nodes.some(node => node.id === value.id);
  if (value.type === 'nodes') return value.ids.every(id => display.nodes.some(node => node.id === id));
  if (value.type === 'edge') return display.edges.some(edge => edge.id === value.id);
  return true;
};
const name = id => graph?.nodes?.find(node => node.id === id)?.label
  ?? (definitionMode() ? draft : workspace?.definitions)?.nodes.find(node => node.id === id)?.label ?? id;
const graphName = id => workspace?.mechanics.find(item => item.id === id)?.name ?? id;
const filePath = () => {
  if (!workspace) return '';
  if (definitionMode()) return workspace.manifest.definitions;
  if (viewId !== null) return workspace.files.find(item => item.kind === 'view' && item.id === viewId)?.path ?? '';
  return activeId === null ? '' : workspace.files.find(item => item.kind === 'mechanic' && item.id === activeId)?.path ?? '';
};
let copyFilePathTimer = null;
async function copyFilePath() {
  const path = filePath();
  if (!path) return;
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(path);
  else {
    const input = document.createElement('textarea'); input.value = path; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.append(input); input.select();
    const copied = document.execCommand('copy'); input.remove();
    if (!copied) throw new Error('浏览器未授权复制文件路径');
  }
  const feedback = $('copy-file-path-feedback');
  clearTimeout(copyFilePathTimer); feedback.hidden = false;
  copyFilePathTimer = setTimeout(() => { feedback.hidden = true; }, 1400);
}
function renderCanvasFilePath() {
  const path = filePath(), context = $('canvas-context'), control = $('copy-file-path');
  context.hidden = !path;
  if (!path) return;
  const filename = path.split('/').at(-1);
  $('canvas-file-name').textContent = filename;
  control.title = `点击复制路径：${path}`;
  control.setAttribute('aria-label', `复制文件路径：${path}`);
}
const viewSnapshot = () => ({ mechanicRegistrations: viewRegistrations.map(item => clone(item)), focusNodeIds: clone(viewFocusNodeIds), pinnedRuleIds: clone(viewPinnedRuleIds), collapsedNodeIds: [], positions: clone(viewPositions), nodeColors: clone(viewNodeColors), nodeStyles: clone(viewNodeStyles), projectionPositions: clone(scopedPositions), ...(viewRouteCache ? { routeCache: clone(viewRouteCache) } : {}), structuralPresentation: workspace.views.find(item => item.id === viewId)?.structuralPresentation, taxonomyPresentation: clone(viewTaxonomyPresentation) });
const contextKey = () => viewId !== null ? 'view/' + viewId : legacy ? 'legacy' : 'mechanic/' + activeId;
const rememberCamera = () => { if (!definitionMode()) cameras.set(contextKey(), clone(canvas.camera)); };
const restoreCamera = () => { if (cameras.has(contextKey())) { canvas.camera = clone(cameras.get(contextKey())); canvas.transform(); } };

function showError(error) {
  const conflict = error.code === 'REVISION_CONFLICT';
  $('error-text').textContent = error.message + (conflict ? '\n冲突只针对本次写入涉及的文件（见上文）。请先重新读取磁盘状态再保存；草稿会保留，不会被覆盖。' : '');
  const recovery = $('reload-error');
  recovery.textContent = workspace ? '重新读取' : '重新打开项目';
  recovery.hidden = false;
  $('error').hidden = false;
}
function renderProjectTabs() {
  const root = $('project-tabs'); if (!root) return;
  root.replaceChildren();
  root.hidden = referencesCollapsed;
  // 此区域只表达“主项目 + 主项目声明的关联入口”。最近打开项目属于“打开项目”对话框，
  // 不能混入这里，否则普通项目会伪装成关联项目并错误切换主项目。
  const entries = [sourceProject && { projectRoot: sourceProject.projectRoot, name: sourceProject.manifest.name, primary: true },
    ...referenceProjects.filter(reference => reference.status === 'ready')].filter(Boolean);
  const seenRoots = new Set();
  for (const entry of entries) {
    const rootKey = entry.projectRoot?.toLowerCase();
    if (!rootKey || seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);
    const active = rootKey === browserWorkspace?.projectRoot?.toLowerCase();
    const item = button(entry.name, async () => {
      if (entry.primary) {
        await returnToSourceProject();
        return;
      }
      const reference = referenceProjects.find(item => item.status === 'ready' && item.projectRoot?.toLowerCase() === rootKey);
      if (reference) { await enterReference(reference.id); return; }
      throw new Error('关联项目入口已失效，请重新读取主项目的关联项目设置');
    }, 'project-tab' + (active ? ' is-active' : ''));
    item.title = entry.projectRoot; item.setAttribute('aria-pressed', String(active));
    if (entry.primary) { root.append(item); continue; }
    const reference = referenceProjects.find(candidate => candidate.status === 'ready' && candidate.projectRoot?.toLowerCase() === rootKey);
    if (!reference) { root.append(item); continue; }
    const row = el('div', undefined, 'project-tab-row');
    const remove = iconAction('trash', () => removeProjectReference(reference), 'reference-remove');
    remove.title = `移除关联项目：${reference.name}`;
    remove.setAttribute('aria-label', remove.title);
    row.append(item, remove); root.append(row);
  }
}
function apiForProject(project, path, body = undefined) {
  if (!project?.projectSessionToken) throw new Error('项目会话不可用，请重新打开该文件');
  if (body === undefined) return api(`${path}${path.includes('?') ? '&' : '?'}projectSessionToken=${encodeURIComponent(project.projectSessionToken)}`);
  return api(path, { ...body, projectSessionToken: project.projectSessionToken, projectGeneration: project.projectGeneration });
}
async function refreshReferenceProjects() {
  const source = sourceProject ?? workspace;
  if (!source?.projectSessionToken) return;
  const state = await api(`/api/project-references?projectSessionToken=${encodeURIComponent(source.projectSessionToken)}`);
  referenceProjects = state.references;
  referenceProjectsRevision = state.referencesRevision;
  renderProjectTabs();
}
function apiAsSource(path, body = {}) {
  if (!sourceProject?.projectSessionToken) throw new Error('当前没有可用的源项目会话');
  return api(path, { ...body, projectSessionToken: sourceProject.projectSessionToken, projectGeneration: sourceProject.projectGeneration });
}
function renderReferenceSection() {
  const list = $('project-tabs'); if (!list) return;
  list.hidden = referencesCollapsed;
  const toggle = $('toggle-references');
  toggle.replaceChildren(icon(referencesCollapsed ? 'chevron-down' : 'chevron-up'));
  toggle.title = referencesCollapsed ? '展开关联项目' : '折叠关联项目';
  toggle.setAttribute('aria-label', toggle.title);
}
function currentResourceDescriptor(candidate = null) {
  const targetView = candidate?.viewId ?? viewId;
  const targetId = targetView ?? candidate?.activeId ?? activeId;
  if (targetId === null || targetId === undefined) return null;
  return { projectSessionToken: workspace.projectSessionToken, kind: targetView !== null ? 'view' : 'mechanic', id: targetId,
    name: targetView !== null ? workspace.views.find(item => item.id === targetView)?.name ?? targetView : workspace.mechanics.find(item => item.id === targetId)?.name ?? targetId };
}
function renderEditorTabs() {
  const root = $('editor-tabs'); if (!root) return;
  root.replaceChildren();
  for (const tab of editorTabs) {
    const active = tab.projectSessionToken === workspace?.projectSessionToken && tab.kind === (viewId !== null ? 'view' : 'mechanic') && tab.id === (viewId ?? activeId);
    const item = button(tab.name, () => openEditorTab(tab).catch(showError), 'editor-tab' + (active ? ' is-active' : ''));
    item.title = `${tab.projectName} · ${tab.kind === 'view' ? '视图' : '机制'} · ${tab.id}`; item.setAttribute('aria-pressed', String(active)); root.append(item);
    let clickTimer = null;
    item.onclick = () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; closeEditorTab(tab).catch(showError); return; }
      clickTimer = setTimeout(() => { clickTimer = null; openEditorTab(tab).catch(showError); }, 220);
    };
  }
}
function rememberEditorTab(candidate = null) {
  const descriptor = currentResourceDescriptor(candidate); if (!descriptor) return;
  const found = editorTabs.find(tab => tab.projectRoot?.toLowerCase() === workspace.projectRoot.toLowerCase() && tab.kind === descriptor.kind && tab.id === descriptor.id);
  if (!found && editorTabs.length >= EDITOR_TAB_LIMIT) {
    if (autoCloseEditorTabs) editorTabs.shift();
    else { void promptEditorTabLimit(); return; }
  }
  if (!found) editorTabs.push({ ...descriptor, projectRoot: workspace.projectRoot, projectName: workspace.manifest.name });
  else Object.assign(found, descriptor, { projectRoot: workspace.projectRoot, projectName: workspace.manifest.name });
  persistTabState();
  renderEditorTabs();
}
async function promptEditorTabLimit() {
  let enabled = autoCloseEditorTabs;
  await dialog(`已打开 ${EDITOR_TAB_LIMIT} 个文件标签`, container => {
    container.append(el('p', `标签页最多保留 ${EDITOR_TAB_LIMIT} 个。请双击标签标题关闭不再需要的文件后再打开新文件。`, 'note'));
    const label = el('label', undefined, 'choice'), input = el('input'); input.type = 'checkbox'; input.checked = enabled;
    input.onchange = () => { enabled = input.checked; }; label.append(input, el('span', '以后自动关闭最早打开的文件')); container.append(label);
  }, () => { if (!enabled) return false; autoCloseEditorTabs = true; saveUiPreference('mechanics:auto-close-editor-tabs', true); persistTabState(); return true; }, '启用自动关闭');
}
async function openEditorTab(tab) {
  if (!workspace || !await guard()) return;
  try {
    let tabProject = workspace;
    if (workspace.projectRoot.toLowerCase() !== tab.projectRoot?.toLowerCase()) {
      if (sourceProject?.projectRoot?.toLowerCase() === tab.projectRoot?.toLowerCase()) {
        // 打开主项目文件标签只改变编辑目标，不能偷用“返回主项目”而改动左侧浏览目录。
        tabProject = await api('/api/project/select', { projectSessionToken: sourceProject.projectSessionToken, projectGeneration: sourceProject.projectGeneration });
      } else {
        const reference = referenceProjects.find(item => item.status === 'ready' && item.projectRoot?.toLowerCase() === tab.projectRoot?.toLowerCase());
        if (reference) tabProject = await api('/api/project/reference-enter', { referenceId: reference.id, projectSessionToken: sourceProject.projectSessionToken, projectGeneration: sourceProject.projectGeneration });
        else throw new Error('此标签所属项目不再是当前项目或关联项目，无法打开');
      }
    }
    const opened = await load({ kind: tab.kind, id: tab.id }, { project: tabProject });
    if (!opened) throw new Error('资源已不存在或无法打开');
  } catch (error) {
    const index = editorTabs.indexOf(tab); if (index >= 0) { editorTabs.splice(index, 1); persistTabState(); renderEditorTabs(); }
    throw error;
  }
}
async function closeEditorTab(tab) {
  const index = editorTabs.indexOf(tab);
  if (index < 0) return;
  const active = tab.projectSessionToken === workspace?.projectSessionToken && tab.kind === (viewId !== null ? 'view' : 'mechanic') && tab.id === (viewId ?? activeId);
  if (active && !await guard()) return;
  editorTabs.splice(index, 1); persistTabState(); renderEditorTabs();
  if (!active) return;
  const next = editorTabs[index] ?? editorTabs[index - 1];
  if (next) await openEditorTab(next);
  else await load({ kind: 'mechanic', id: null });
}
async function returnToSourceProject() {
  if (!workspace || !sourceProject || !await guard()) return;
  // 关联入口只改变 browserWorkspace。编辑器仍打开主项目文件时，回源也必须复位左侧目录。
  if (workspace.projectRoot.toLowerCase() === sourceProject.projectRoot.toLowerCase()) {
    browserWorkspace = sourceProject;
    sidebarState.detailViewId = null;
    sidebarState.queries.views = ''; sidebarState.queries.mechanics = ''; sidebarState.folders.clear();
    renderSidebar(); renderProjectTabs();
    return;
  }
  try {
    const opened = await api('/api/project/select', { projectSessionToken: sourceProject.projectSessionToken, projectGeneration: sourceProject.projectGeneration });
    await activateSourceNavigation(opened);
  } catch (error) {
    // 会话令牌是服务内存态。服务重启后，以已保存的源项目目录重建会话即可继续工作。
    if (error.code !== 'PROJECT_SESSION_INVALID') throw error;
    await openProjectRoot(sourceProject.projectRoot);
  }
}
const API_REQUEST_TIMEOUT_MS = 15_000;
// 原生窗口等待用户操作；比服务端 10 分钟进程超时多留 10 秒以接收明确的失败结果。
const DIRECTORY_PICKER_REQUEST_TIMEOUT_MS = 610_000;
const assetSyncFailures = new Map(), assetSyncWatchers = new Set();
function observeAssetSync(data) {
  const token = data?.projectSessionToken, status = data?.projectAssetSync;
  if (!token || !status) return;
  if (status.state === 'failed') assetSyncFailures.set(token, `${status.projectRoot}：技能与脚本更新失败（${status.code}）。${status.message}。修复后重新打开项目可重试；网页仍可继续使用。`);
  else if (status.state === 'current') assetSyncFailures.delete(token);
  const banner = $('project-assets-status');
  banner.textContent = [...assetSyncFailures.values()].join('\n'); banner.hidden = assetSyncFailures.size === 0;
  if (status.state !== 'pending' || assetSyncWatchers.has(token)) return;
  assetSyncWatchers.add(token);
  // 只读同步状态，不重读工作区、不替换草稿，也不进入页面写入队列。
  const poll = async () => {
    try {
      const next = await api('/api/project/assets?projectSessionToken=' + encodeURIComponent(token));
      if (next.projectAssetSync.state === 'pending') { setTimeout(poll, 1000); return; }
    } catch (error) {
      assetSyncFailures.set(token, `无法确认技能与脚本更新结果：${status.projectRoot}。${error.message}`);
      banner.textContent = [...assetSyncFailures.values()].join('\n'); banner.hidden = false;
    }
    assetSyncWatchers.delete(token);
  };
  setTimeout(poll, 1000);
}
async function api(path, body) {
  let response, data;
  const requestTimeout = path === '/api/directories/pick' ? DIRECTORY_PICKER_REQUEST_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), requestTimeout);
  try {
    // 写入体携带读取时的每资源版本：服务端据此只对本操作真正会写的资源判定冲突，
    // 不再因为别的页面写了别的文件（或补算了布局）而拒绝一次安全的保存。
    // 关联项目的写入不属于当前会话，不带本项目基线，服务端退回整体比较。
    const baseline = typeof body?.revision === 'string'
      && (body.projectSessionToken ?? workspace?.projectSessionToken) === workspace?.projectSessionToken
        ? { resourceRevisions: body.resourceRevisions ?? workspace?.resourceRevisions } : {};
    const payload = body && workspace?.projectGeneration !== undefined
      && !['/api/directories/pick', '/api/project/open', '/api/projects/pin', '/api/projects/remove', '/api/preferences'].includes(path)
        ? { ...body, ...baseline, projectGeneration: body.projectGeneration ?? workspace.projectGeneration, projectSessionToken: body.projectSessionToken ?? workspace.projectSessionToken } : body;
    const requestPath = !payload && workspace?.projectSessionToken && ['/api/workspace', '/api/local-ui-state', '/api/project-references', '/api/agent', '/api/concept-docs'].includes(path)
      ? `${path}?projectSessionToken=${encodeURIComponent(workspace.projectSessionToken)}` : path;
    response = await fetch(requestPath, {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json' } : {},
      signal: controller.signal,
      ...(payload ? { body: json(payload) } : {}),
    });
    data = await response.json();
    if (path === '/api/project/open') sessionStorage.removeItem('mechanics-open-reload');
  } catch (error) {
    const timedOut = controller.signal.aborted;
    if (path === '/api/directories/pick') throw new Error('无法获取文件夹选择结果：' + error.message + '。项目未切换，请重新选择。');
    if (path === '/api/project/open' && !sessionStorage.getItem('mechanics-open-reload')) {
      sessionStorage.setItem('mechanics-open-reload', '1');
      location.reload();
      throw Object.assign(new Error('服务已重启，正在重新加载网页。'), { code: 'PROJECT_OPEN_RELOAD' });
    }
    const openingProject = path === '/api/project/open';
    const failure = new Error(openingProject ? '打开项目时连接中断或响应无法解析。刷新后仍未完成，请重新选择项目。'
      : body ? '连接中断或响应无法解析，写入结果待确认。草稿已保留，请重新读取磁盘核实后再操作。'
        : timedOut ? `本地服务在 ${API_REQUEST_TIMEOUT_MS / 1000} 秒内没有响应。请检查服务后重新打开项目。` : '无法读取本地服务：' + error.message);
    failure.code = openingProject ? 'PROJECT_OPEN_RESPONSE_LOST' : body ? 'SAVE_UNCERTAIN' : timedOut ? 'CONNECTION_TIMEOUT' : 'CONNECTION_FAILED'; throw failure;
  } finally { clearTimeout(timeout); }
  if (!response.ok) { const error = Object.assign(new Error(data.error + '：' + data.message), data); error.code = data.error; throw error; }
  observeAssetSync(data);
  return data;
}
// 所有页面写入串行执行，revision 只随已确认的自身提交更新。
function mergeSingleMechanicSave(next) {
  if (!next?.singleMechanicSave) return next;
  const mechanic = next.mechanics[0];
  return { ...workspace, manifest: next.manifest, definitions: next.definitions, rules: next.rules,
    mechanics: workspace.mechanics.map(item => item.id === mechanic.id ? mechanic : item),
    resourceRevisions: { ...workspace.resourceRevisions, definitions: next.resourceRevisions.definitions, rules: next.resourceRevisions.rules,
      mechanics: { ...workspace.resourceRevisions.mechanics, [mechanic.id]: next.resourceRevisions.mechanics[mechanic.id] } } };
}
function write(operation, { blocking = true } = {}) {
  if (blocking) { pending++; updateStatus(); }
  const result = writeQueue.then(async () => {
    const next = await operation(workspace.revision);
    workspace = mergeSingleMechanicSave(next); renderSidebar();
    return workspace;
  });
  writeQueue = result.catch(() => {});
  return result.finally(() => { if (blocking) { pending--; updateStatus(); } });
}
function updateStatus() {
  document.querySelector('.viewbar').hidden = definitionMode() || docsMode();
  $('breadcrumb').hidden = definitionMode() || docsMode();
  const table = definitionMode(), docs = docsMode();
  $('table-view').classList.toggle('active', table); $('graph-view').classList.toggle('active', !table && !docs); $('docs-view').classList.toggle('active', docs);
  $('table-view').setAttribute('aria-pressed', String(table)); $('graph-view').setAttribute('aria-pressed', String(!table && !docs)); $('docs-view').setAttribute('aria-pressed', String(docs));
  $('save').disabled = !dirty() || busy();
  $('dirty-dot').hidden = !dirty();
  $('undo').disabled = !history.length || busy() || !!autosave?.blocked;
  $('redo').disabled = !future.length || busy() || !!autosave?.blocked;
  $('positive-tool').disabled = !workspace || definitionMode() || activeId === null || busy();
  $('negative-tool').disabled = $('positive-tool').disabled;
  $('random-tool').disabled = $('positive-tool').disabled;
  updateRelationTools();
  $('save-state').textContent = legacy ? '旧记录已保留' : viewMode() ? '视图自动保存' : dirty() ? '机制未保存' : '机制已保存';
  $('save').hidden = viewMode() || legacy;
  $('delete-mechanic').hidden = definitionMode() || viewMode() || legacy || activeId === null;
  $('delete-mechanic').disabled = !workspace || busy() || !!autosave?.blocked;
  $('new-graph').disabled = !workspace || busy() || legacy || !!autosave?.blocked;
  $('new-view').disabled = !workspace || busy() || !!autosave?.blocked;
  $('resource-create').disabled = $('new-graph').disabled;
  $('resource-create-folder').disabled = $('new-graph').disabled;
  for (const control of $('resource-content').querySelectorAll('[data-folder-action]')) control.disabled = $('new-graph').disabled;
  $('resource-search').disabled = !workspace || opening;
  $('open-project').disabled = busy();
  $('reload').disabled = !workspace || busy();
  $('agent-export-settings').disabled = !workspace || busy();
  $('legacy-notice').hidden = !legacy;
  $('add-node').disabled = activeId === null || busy();
  const selectedNodes = canvas?.selectedIds?.() ?? [];
  const allSelected = graph?.nodes?.length > 0 && selectedNodes.length === graph.nodes.length;
  $('auto-layout').disabled = !workspace || !graph?.nodes?.length || busy() || arranging || legacy || definitionMode() || !!autosave?.blocked;
  const layoutLabel = allSelected ? '自动排版全部节点' : selectedNodes.length ? `重排选中节点（${selectedNodes.length}）` : '自动排版全部节点';
  const layoutHint = allSelected ? '已选中全部节点，使用完整排版' : selectedNodes.length ? '只移动选中节点，其他节点保持原位' : '重排当前可见的全部节点';
  $('auto-layout').querySelector('.visually-hidden').textContent = layoutLabel;
  $('auto-layout').setAttribute('aria-label', layoutLabel);
  $('auto-layout').title = layoutHint;
  const tooltipToggle = $('toggle-information-bar');
  const tooltipLabel = hoverTooltipsEnabled ? '关闭悬浮说明' : '开启悬浮说明（按住 Shift 可临时查看）';
  tooltipToggle.setAttribute('aria-pressed', String(hoverTooltipsEnabled));
  tooltipToggle.setAttribute('aria-label', tooltipLabel);
  tooltipToggle.title = tooltipLabel;
  tooltipToggle.querySelector('.visually-hidden').textContent = tooltipLabel;
  tooltipToggle.classList.toggle('active', hoverTooltipsEnabled);
  for (const id of ['resource-panel', 'resource-tabs', 'main-views']) $(id).inert = opening;
  for (const id of ['stage', 'glossary']) $(id).inert = busy();
  for (const input of [$('resource-panel'), $('inspector')].flatMap(root => [...root.querySelectorAll('input[type=checkbox]')])) input.disabled = busy() || !!autosave?.blocked;
  $('opening-overlay').hidden = !opening;
  $('opening-message').textContent = workspace ? '正在打开图文件…' : '正在打开项目…';
  $('compute-status').hidden = opening || !computeState;
  $('compute-message').textContent = computeState?.kind === 'layout' ? '正在后台排版…' : '正在后台重绘连线…';
}
// is-a 不再有连线模式：父概念在概念面板与对话框中指定，relationMode 只服务影响连线。
const relationMode = relation => relation === 'specializes' ? 'select' : relation === 'random' ? 'random' : relation === 1 ? 'positive' : 'negative';
function updateRelationTools() {
  for (const [mode, relation] of [['positive', 1], ['negative', -1], ['random', 'random']]) {
    const selected = lastRelation === relation;
    const control = $(mode + '-tool'); control.setAttribute('aria-checked', String(selected)); control.classList.toggle('is-selected', selected); control.tabIndex = selected ? 0 : -1;
  }
}
// 工具条只选择下次双击使用的默认关系；只有既有双击入口才会切换 Canvas 连线手势。
function selectRelation(relation, { beginLink = false } = {}) {
  lastRelation = relation; updateRelationTools();
  if (beginLink) setMode(relationMode(relation));
}
async function persistView() {
  if (!viewMode() || legacy) return false;
  try {
    return await autosave.save(viewSaveRequest(workspace, viewId, viewSnapshot()));
  } catch (error) { showError(error); return false; }
}
async function saveDraft({ blocking = true } = {}) {
  if (busy() || autosave.blocked) return false;
  if (!dirty()) return true;
  const saved = clone(draft), isDefinition = definitionMode(), id = isDefinition ? null : activeId;
  try {
    const file = id === null ? undefined : workspace.files.find(item => item.kind === 'mechanic' && item.id === id)?.path;
    await write(revision => api('/api/save', { revision, kind: id === null ? 'definitions' : 'mechanic', id, file, document: saved }), { blocking });
    if (definitionMode() === isDefinition && (isDefinition || activeId === id)) baseline = saved;
    if (!autosave.blocked) $('error').hidden = true; render(); return true;
  } catch (error) { showError(error); return false; }
}
function edit(change, { inspect = true, refresh = true, topology = true } = {}) {
  if (!draft || busy() || viewMode() || legacy || autosave.blocked) return;
  const previous = clone(draft), next = definitionMode() ? draft : clone(draft);
  try {
    change(next);
    if (!definitionMode() && topology) compose({ ...workspace, mechanics: [next] }, [next.id]);
  } catch (error) { showError(error); return false; }
  if (json(previous) === json(next)) return false;
  draft = next;
  geometryEpoch++;
  history.push(previous); if (history.length > 80) history.shift(); future = [];
  if (refresh) render(inspect); else updateStatus();
  return true;
}
function assignSnapshot(snapshot) {
  viewRegistrations = viewId === null ? snapshot.graphIds.map(mechanicId => ({ mechanicId, visible: true })) : snapshot.mechanicRegistrations.map(item => clone(item));
  viewFocusNodeIds = clone(snapshot.focusNodeIds ?? []);
  viewPinnedRuleIds = clone(snapshot.pinnedRuleIds ?? []);
  visible = viewRegistrations.filter(item => item.visible).map(item => item.mechanicId);
  viewPositions = clone(snapshot.positions);
  viewNodeColors = clone(snapshot.nodeColors ?? {});
  viewNodeStyles = clone(snapshot.nodeStyles ?? {});
  scopedPositions = clone(snapshot.projectionPositions ?? {});
  viewRouteCache = clone(snapshot.routeCache ?? null);
  viewTaxonomyPresentation = clone(snapshot.taxonomyPresentation ?? { mode: 'label', expandedNodeIds: [] });
}
function editView(change, { keepSelection = false, preserveRoutes = false } = {}) {
  if (!viewMode() || busy() || autosave.blocked) return;
  const previous = viewSnapshot(), next = clone(previous); change(next);
  if (json(previous) === json(next)) return;
  // 显隐不会提交新几何；同时终止可能仍在处理旧可见集合的 Worker，
  // 避免它稍后把部分图的切分结果带回当前视图。
  if (preserveRoutes) compute.cancel();
  history.push(previous); if (history.length > 80) history.shift(); future = [];
  assignSnapshot(next); geometryEpoch++;
  if (preserveRoutes && settledRuntime?.contextId === contextKey() + '/' + screen) settledRuntime.epoch = geometryEpoch;
  if (!keepSelection) selection = null; render(true, { preserveRoutes }); void persistView();
}
function undo(redo = false) {
  if (busy() || autosave.blocked || legacy) return;
  const from = redo ? future : history, to = redo ? history : future;
  if (!from.length) return;
  if (viewMode()) { to.push(viewSnapshot()); assignSnapshot(from.pop()); }
  else {
    to.push(clone(draft)); const next = from.pop();
    draft = next;
  }
  geometryEpoch++;
  selection = null; render(); if (viewMode()) void persistView();
}
function field(container, label, value, { multiline = false, readonly = false, required = false, options, onChange, pattern } = {}) {
  const wrap = el('label', label, 'field');
  const input = el(options ? 'select' : multiline ? 'textarea' : 'input');
  if (options) for (const [key, text] of options) { const option = el('option', text); option.value = key; input.append(option); }
  input.value = value ?? ''; input.readOnly = readonly; input.required = required;
  if (pattern) input.pattern = pattern;
  if (onChange) input[options ? 'onchange' : 'oninput'] = () => onChange(input.value);
  wrap.append(input); container.append(wrap); return input;
}
function detail(container, label, text) {
  const item = el('div', undefined, 'detail'); item.append(el('strong', label), el('p', text)); container.append(item);
}
function nodeStylePicker(container, current, onChange) {
  const item = el('div', undefined, 'detail node-style-picker'); item.append(el('strong', '节点风格'));
  const choices = el('div', undefined, 'node-style-choices');
  for (const option of NODE_STYLE_OPTIONS) {
    const choice = button(option.label, () => onChange(option.value), `node-style-choice node-style-${option.value}`);
    choice.setAttribute('aria-pressed', String(current === option.value));
    choices.append(choice);
  }
  item.append(choices); container.append(item);
}
function nodeColorPicker(container, current, onChange) {
  const item = el('div', undefined, 'detail node-color-picker'); item.append(el('strong', '节点颜色'));
  const choices = el('div', undefined, 'node-color-choices');
  for (const option of NODE_COLOR_OPTIONS) {
    const choice = button('', () => onChange(option.color), 'node-color-choice');
    choice.setAttribute('aria-label', option.label); choice.title = option.label; choice.setAttribute('aria-pressed', String(current === option.color));
    if (option.color) choice.style.setProperty('--node-color', option.color); else choice.classList.add('is-default');
    choices.append(choice);
  }
  item.append(choices); container.append(item);
}
function qualifierRowsFromCanonical(qualifiers = []) {
  return qualifiers.map(qualifier => qualifierFormRowFromCanonical(qualifier));
}
function qualifiersFromRows(rows) {
  const keys = new Set();
  return rows.map(row => {
    const key = row.key.trim();
    assertSemanticId(key, '限定键 ');
    if (keys.has(key)) throw new Error(`限定键不能重复：${key}`);
    keys.add(key);
    return { key, value: qualifierValueFromForm(row) };
  });
}
async function updateGlobalRule(id, change) {
  const rules = clone(workspace.rules), rule = rules.rules.find(item => item.id === id);
  if (!rule) throw new Error('规则已不存在，请重新读取。');
  change(rule);
  await write(revision => api('/api/save', { revision, kind: 'rules', document: rules }));
  selection = { type: 'edge', id }; render();
}
// is-a 父概念候选：排除自身与更具体的后代（沿 specializes 入边），
// 否则既会把当前父概念（祖先）误当后代过滤掉，又会让用户选出必被 domain 拒绝的分类环。
const parentCandidates = conceptId => isaParentCandidates(workspace.definitions.nodes, workspace.rules.rules, conceptId);
// is-a 的唯一写入口：更换或清除某概念的父概念。rules 与受影响的 pinnedRuleIds 由服务端在一次
// 提交里一起落盘——删掉一条被固定的 is-a 规则而不同步清理，会让工作区在下次读取时不可读。
// 显式投影（ruleSelection: "explicit"）只投影 pinnedRuleIds：新写入的 is-a 规则必须同时
// 固定到当前文件，否则画布上既没有分类边、也没有节点内的 is-a 标签——刷新页面也不会出现。
// agent rule set-parent 与项目内 isa set 都按同一口径固定，网页这条路径此前漏了这一步。
// 固定走当前文件的编辑通道：机制图进入草稿（随草稿保存），视图立即持久化。
function syncLocalPinsAfterTaxonomy(removed, addedPairs) {
  const wanted = [...addedPairs].filter(([, parentId]) => parentId).map(([childId, parentId]) => workspace.rules.rules
    .find(rule => rule.relation === 'specializes' && rule.source === childId && rule.target === parentId)?.id).filter(Boolean);
  if (viewMode()) {
    const next = nextPinnedRuleIds(viewPinnedRuleIds, { removed, added: wanted, pinAdded: true });
    if (!next.changed) return false;
    editView(data => { data.pinnedRuleIds = next.pinned; }, { keepSelection: true });
    return true;
  }
  // 定义模式下 draft 是概念定义草稿，没有机制投影可言；固定引用只属于机制图/视图。
  if (!draft || definitionMode()) return false;
  const next = nextPinnedRuleIds(draft.pinnedRuleIds, { removed, added: wanted, pinAdded: draft.ruleSelection === 'explicit' });
  if (!next.changed) return false;
  return edit(data => { data.pinnedRuleIds = next.pinned; }) === true;
}
// 服务端在 is-a 提交里同步清理了被删规则的固定引用；客户端草稿/视图必须做同样的清理，
// 否则下一次保存会因为引用已删除的规则而报 MISSING_REFERENCE（本机实测）。
function classifyTaxonomyChange(beforeRules) {
  const nextIds = new Set(workspace.rules.rules.map(rule => rule.id));
  return new Set(beforeRules.map(rule => rule.id).filter(id => !nextIds.has(id)));
}
async function setConceptParent(conceptId, parentId) {
  const beforeRules = workspace.rules.rules;
  const nextRules = setSpecializesParent(beforeRules, conceptId, parentId);
  if (nextRules === beforeRules) return false;
  await write(revision => api('/api/concept-taxonomy', { revision, rules: { ...clone(workspace.rules), rules: nextRules } }));
  // write() 只刷新侧栏；is-a 会改变画布投影、节点标签与详情栏，必须重画才能立即看到结果，
  // 不能等用户刷新页面。本地固定/清理成功时 edit() 自己会重画。
  if (!syncLocalPinsAfterTaxonomy(classifyTaxonomyChange(beforeRules), [[conceptId, parentId]])) render();
  return true;
}
async function setEdgeQualifiers(id, side, qualifiers) {
  await updateGlobalRule(id, edge => {
    if (qualifiers.length) edge[side] = qualifiers;
    else delete edge[side];
  });
  return true;
}
async function editEdgeQualifiers(id, side) {
  const edge = workspace.rules.rules.find(item => item.id === id);
  if (!edge || edge.relation === 'specializes') return;
  const sideLabel = side === 'sourceQualifiers' ? '源参与者' : '目标参与者';
  const form = { rows: qualifierRowsFromCanonical(edge[side]) };
  $('dialog').classList.add('concept-dialog');
  try {
    await dialog(`编辑${sideLabel}限定`, container => {
      const rows = el('div', undefined, 'qualifier-rows');
      const draw = () => {
        rows.replaceChildren();
        if (!form.rows.length) rows.append(el('p', '未设置限定；该端点默认适用于这个概念的全部参与者。', 'note'));
        for (const row of form.rows) {
          const wrap = el('div', undefined, 'qualifier-row');
          const key = el('input'); key.value = row.key ?? ''; key.placeholder = '限定键，例如 faction'; key.setAttribute('aria-label', '限定键语义 ID'); key.oninput = () => { row.key = key.value; };
          const kind = el('select');
          for (const [value, text] of [['concept', '概念引用'], ['literal', '固定值']]) { const option = el('option', text); option.value = value; kind.append(option); }
          kind.value = row.kind;
          kind.onchange = () => { Object.assign(row, qualifierRowForKind(row, kind.value)); draw(); };
          wrap.append(key, kind);
          if (row.kind === 'concept') {
            wrap.append(new ConceptReferencePicker({ nodes: () => workspace.definitions.nodes, kind: 'qualifier', value: row.conceptId,
              ariaLabel: '限定概念引用', onSelect: conceptId => { row.conceptId = conceptId; } }).root);
          } else {
            const type = el('select');
            for (const [value, text] of [['string', '文本'], ['number', '数字'], ['boolean', '布尔'], ['null', 'null']]) { const option = el('option', text); option.value = value; type.append(option); }
            type.value = row.literalType;
            type.onchange = () => { Object.assign(row, qualifierRowForKind(row, 'literal'), { literalType: type.value }); draw(); };
            wrap.append(type);
            const model = qualifierValueControlModel(row);
            if (model.tag !== 'none') {
              const value = el(model.tag); value.value = row.literalValue ?? '';
              if (model.tag === 'select') for (const [valueId, label] of model.options) { const option = el('option', label); option.value = valueId; value.append(option); }
              else value.type = model.type;
              value.oninput = value.onchange = () => { row.literalValue = value.value; };
              wrap.append(value);
            }
          }
          wrap.append(button('移除', () => { form.rows.splice(form.rows.indexOf(row), 1); draw(); }, 'quiet danger'));
          rows.append(wrap);
        }
      };
      const actions = el('div', undefined, 'property-actions');
      actions.append(button('添加限定', () => { form.rows.push(qualifierRowForKind({}, 'literal')); draw(); }));
      if (form.rows.length) actions.append(button('清空本端限定', () => { form.rows = []; draw(); }, 'quiet danger'));
      container.append(el('p', '限定词只收窄这条规则的参与者，不会创建概念或 is-a 分类。清空后，该端点回到基础概念的完整适用范围。', 'note'), rows, actions);
      draw();
    }, () => setEdgeQualifiers(id, side, qualifiersFromRows(form.rows)), '保存限定');
  } finally { $('dialog').classList.remove('concept-dialog'); }
}
async function dialog(title, build, submit, confirmText = '确定', { settled } = {}) {
  $('dialog-title').textContent = title; $('dialog-content').replaceChildren(); $('dialog-error').hidden = true;
  $('confirm-dialog').textContent = confirmText; $('confirm-dialog').disabled = false; $('confirm-dialog').hidden = false;
  build($('dialog-content'));
  return new Promise(resolve => {
    const modal = $('dialog'); modal.returnValue = ''; let submitting = false;
    modal.onclose = () => resolve(modal.returnValue === 'ok');
    modal.oncancel = event => { if (submitting || busy()) event.preventDefault(); };
    $('dialog-form').onsubmit = async event => {
      event.preventDefault(); submitting = true; $('confirm-dialog').disabled = true; $('dialog-error').hidden = true;
      $('close-dialog').disabled = true; $('cancel-dialog').disabled = true;
      try { if (await submit() !== false) modal.close('ok'); }
      catch (error) { $('dialog-error').textContent = error.message; $('dialog-error').hidden = false; }
      finally { submitting = false; $('confirm-dialog').disabled = false; $('close-dialog').disabled = false; $('cancel-dialog').disabled = false; settled?.(); }
    };
    modal.showModal();
  });
}
async function guard({ reload = false, allowLegacy = false } = {}) {
  await writeQueue;
  if (opening) return false;
  if (referenceSession?.commit) { showError(new Error('概念引用尚未完成。请打开「概念节点」核实写入，或明确结束本次引用，再切换文件。')); return false; }
  if (legacy && !reload && !allowLegacy) { showError(new Error('旧叠加记录尚未处理。请先选择「保存旧叠加为视图」或「放弃旧叠加」，原记录不会自动覆盖。')); return false; }
  if (autosave.blocked && !reload) { showError(new Error(autosave.error.message + '\n视图自动保存未完成。请通过「重新读取」核实磁盘状态。')); return false; }
  if (!dirty() && !autosave.blocked) return true;
  return dialog('当前文件有未保存修改', container => {
    container.append(el('p', '请保存、放弃或取消。放弃只在目标成功打开后生效；取消或打开失败会保留草稿。', 'note'));
    if (autosave.blocked) {
      container.append(el('p', '视图保存失败或结果待确认：请重新读取并核实磁盘版本。', 'note'));
      $('confirm-dialog').hidden = true;
    }
    container.append(button('放弃修改并继续', () => { $('dialog').close('ok'); }, 'danger'));
  }, saveDraft, '保存并继续');
}
function assignLayer(id) {
  canvas.cancel();
  geometryEpoch++;
  activeId = id; screen = 'mechanic';
  draft = id === null ? undefined : clone(workspace.mechanics.find(item => item.id === id));
  baseline = clone(draft); history = []; future = []; selection = null;
  setMode('select');
}
async function openLayer(id) {
  if (opening) return;
  if (id === activeId && !definitionMode() && !viewMode() && !legacy) {
    if (id !== null) { selection = { type: 'file' }; inspect(); canvas.fit(); }
    return;
  }
  await load({ kind: 'mechanic', id });
}
async function openConcepts() {
  if (!workspace || definitionMode() || !await guard()) return;
  // 工作视图切换不改变选中的分析文件，也不为打开概念表写入 lastView。
  canvas.cancel(); rememberCamera(); graphHistory = { history, future };
  geometryEpoch++;
  $('concept-docs').hidden = true; $('stage').hidden = false;
  screen = 'concepts'; draft = clone(workspace.definitions); baseline = clone(draft);
  history = []; future = []; selection = null; render();
}
async function resumeGraph() {
  if ((!definitionMode() && !docsMode()) || !await guard()) return;
  $('concept-docs').hidden = true; $('stage').hidden = false;
  assignLayer(activeId);
  if (viewId !== null && graphHistory) { history = graphHistory.history; future = graphHistory.future; }
  graphHistory = null; render(); restoreCamera();
}
async function openDocs() {
  if (!workspace || docsMode() || !await guard()) return;
  canvas.cancel(); screen = 'docs'; $('glossary').hidden = true; $('stage').hidden = true; $('concept-docs').hidden = false;
  updateStatus();
  try { await docsPage.open(); }
  catch (error) {
    // 后台发布期间保留文档页，并允许用户主动刷新；真正失效才进入设置入口。
    if (error.code === 'CATALOG_STALE') {
      if (workspace.exportPublication?.state === 'pending') {
        const retryDocumentOpen = async () => {
          workspace = await api('/api/workspace');
          if (workspace.exportPublication?.state === 'pending') return docsPage.renderPublishing(retryDocumentOpen);
          return docsPage.open();
        };
        docsPage.renderPublishing(retryDocumentOpen);
      } else docsPage.renderStale(workspace.projectSessionToken);
      return;
    }
    // 文档服务失败与编辑画布隔离：保留明确错误页，不能用旧文档或 canonical 伪装成功。
    docsPage.renderFailure('文档读取失败', error.message); updateStatus(); return;
  }
}
async function toggleLayer(id, checked) {
  if (!viewMode() || busy() || autosave.blocked) { renderSidebar(); return; }
  const next = changeViewVisibility(workspace, viewSnapshot(), id, checked);
  editView(snapshot => Object.assign(snapshot, next), { keepSelection: true, preserveRoutes: true });
  $('tool-hint').textContent = checked ? '已显示子机制 · 可撤销' : '已隐藏子机制 · 可撤销';
}
function moveLayer(id, targetIndex) {
  if (!viewMode() || busy() || autosave.blocked) return;
  const next = moveViewMechanic(workspace, viewSnapshot(), id, targetIndex);
  editView(snapshot => Object.assign(snapshot, next), { keepSelection: true, preserveRoutes: true });
}
async function removeLayer(id) {
  if (!viewMode() || busy() || autosave.blocked) return;
  const label = graphName(id);
  const accepted = await dialog('从视图移除机制？', container => {
    container.append(el('p', `将“${label}”从当前视图的注册清单移除。机制文件本身不会被删除，节点位置记忆也会保留，之后重新添加可继续使用。`, 'note'));
  }, () => true, '从视图移除');
  if (!accepted) return;
  const next = removeViewMechanic(workspace, viewSnapshot(), id);
  editView(snapshot => Object.assign(snapshot, next), { keepSelection: true });
}

async function addViewMechanics() {
  if (!viewMode() || busy() || autosave.blocked) return;
  const registered = new Set(viewRegistrations.map(item => item.mechanicId));
  const candidates = workspace.mechanics.filter(item => !registered.has(item.id));
  if (!candidates.length) { showError(new Error('工作区中的机制都已注册到当前视图。')); return; }
  const selected = new Set();
  await dialog('添加子机制', container => {
    const search = field(container, '搜索机制', '', { onChange: draw });
    search.placeholder = '名称、ID 或路径'; search.autocomplete = 'off';
    const list = el('div', undefined, 'choice-list'); container.append(list);
    function draw(value = search.value) {
      const query = value.trim().toLowerCase(); list.replaceChildren();
      const matches = candidates.filter(item => {
        const path = workspace.files.find(file => file.kind === 'mechanic' && file.id === item.id)?.path ?? '';
        return [item.name, item.id, path].some(text => text.toLowerCase().includes(query));
      });
      for (const item of matches) {
        const row = el('label', undefined, 'choice'), input = el('input'); input.type = 'checkbox'; input.checked = selected.has(item.id);
        input.onchange = () => input.checked ? selected.add(item.id) : selected.delete(item.id);
        const path = resourcePath('mechanic', item.id);
        const text = el('span'); text.append(el('span', item.name), el('small', path)); row.append(input, text); list.append(row);
      }
      if (!matches.length) list.append(el('p', '没有可注册的匹配机制', 'sidebar-empty'));
    }
    draw();
  }, () => {
    if (!selected.size) throw new Error('请至少选择一个机制。');
    let next = viewSnapshot();
    for (const id of selected) next = registerViewMechanic(workspace, next, id);
    editView(snapshot => Object.assign(snapshot, next));
  }, '添加到视图');
}
async function addViewConcepts() {
  if (!viewMode() || busy() || autosave.blocked) return;
  const session = { query: '', selected: new Set(viewFocusNodeIds), candidates: [], form: null, commit: null };
  let picker;
  await dialog('添加已有概念', container => {
    picker = new ConceptPicker(container, session, workspace.definitions, [], {
      allowCreate: false,
      status: (text, enabled) => { $('confirm-dialog').textContent = text; $('confirm-dialog').disabled = !enabled; },
    });
  }, () => editView(snapshot => { snapshot.focusNodeIds = [...session.selected].sort(); }), '更新视图概念', { settled: () => picker.updateStatus() });
}
function rememberRecent(kind, id) {
  if (!id) return;
  const key = kind === 'view' ? 'recentViews' : 'recentMechanics';
  sidebarState[key] = [id, ...sidebarState[key].filter(item => item !== id)].slice(0, 8);
  persistRecentState();
}
function persistRecentState() {
  // 关联项目只是在源项目会话中浏览；不允许它覆盖关联项目自己的本地状态。
  if (!workspace?.projectSessionToken || sourceProject?.projectRoot?.toLowerCase() !== workspace.projectRoot?.toLowerCase()) return;
  const projectSessionToken = workspace.projectSessionToken, projectGeneration = workspace.projectGeneration;
  const payload = { lastOpened: sidebarState.lastOpened, recentViews: [...sidebarState.recentViews], recentMechanics: [...sidebarState.recentMechanics], openTabs: editorTabs
    .filter(tab => tab.projectRoot?.toLowerCase() === workspace.projectRoot.toLowerCase())
    .map(tab => ({ kind: tab.kind, id: tab.id })) };
  recentStateWrite = recentStateWrite.catch(() => {}).then(async () => {
    if (!workspace || workspace.projectSessionToken !== projectSessionToken || workspace.projectGeneration !== projectGeneration) return;
    await api('/api/local-ui-state', payload);
  });
  recentStateWrite.catch(error => console.warn('最近打开记录未保存：', error));
}
async function restoreRecentState() {
  const state = await api('/api/local-ui-state');
  const viewIds = new Set(workspace.views.map(item => item.id)), mechanicIds = new Set(workspace.mechanics.map(item => item.id));
  sidebarState.recentViews = state.recentViews.filter(id => viewIds.has(id));
  sidebarState.recentMechanics = state.recentMechanics.filter(id => mechanicIds.has(id));
  sidebarState.lastOpened = state.lastOpened && (state.lastOpened.kind === 'view' ? viewIds : mechanicIds).has(state.lastOpened.id)
    ? state.lastOpened : null;
  editorTabs.splice(0, editorTabs.length, ...state.openTabs.filter(tab => (tab.kind === 'view' ? viewIds : mechanicIds).has(tab.id)).map(tab => ({ ...tab, projectSessionToken: workspace.projectSessionToken, projectRoot: workspace.projectRoot,
    name: (tab.kind === 'view' ? workspace.views : workspace.mechanics).find(item => item.id === tab.id)?.name ?? tab.id, projectName: workspace.manifest.name })));
}
function resourcePath(kind, id) {
  return workspace.files.find(file => file.kind === kind && file.id === id)?.path ?? id ?? '';
}
function clearDropPreview() {
  if (!dropPreview) return;
  dropPreview.classList.remove('drop-target'); delete dropPreview.dataset.dropPreview;
  dropPreview = null;
}
function canPreviewMechanicMove(mechanicId, targetFolder) {
  if (!mechanicId || !workspace || busy() || legacy || autosave?.blocked || referenceSession?.commit || $('dialog').open) return false;
  const sourcePath = resourcePath('mechanic', mechanicId);
  if (!sourcePath || !workspace.mechanics.some(item => item.id === mechanicId)) return false;
  const sourceFolder = mechanismFolderPath(sourcePath.slice(0, sourcePath.lastIndexOf('/')));
  return sourceFolder !== targetFolder;
}
function showDropPreview(heading) {
  if (dropPreview === heading) return;
  clearDropPreview(); dropPreview = heading;
  heading.classList.add('drop-target'); heading.dataset.dropPreview = '放开以移入';
}
function attachMechanicDropTarget(target, targetFolder) {
  const dragId = event => draggingMechanicId || event.dataTransfer.getData('application/x-mechanics-mechanic');
  const accepts = event => canPreviewMechanicMove(dragId(event), targetFolder);
  target.ondragenter = event => { if (!accepts(event)) { event.dataTransfer.dropEffect = 'none'; return; } event.preventDefault(); showDropPreview(target); };
  target.ondragover = event => { if (!accepts(event)) { event.dataTransfer.dropEffect = 'none'; return; } event.preventDefault(); event.dataTransfer.dropEffect = 'move'; showDropPreview(target); };
  target.ondragleave = event => { if (!target.contains(event.relatedTarget) && dropPreview === target) clearDropPreview(); };
  target.ondrop = event => {
    const id = dragId(event); if (!canPreviewMechanicMove(id, targetFolder)) { clearDropPreview(); return; }
    event.preventDefault(); clearDropPreview(); draggingMechanicId = null;
    void moveMechanicToFolder(id, targetFolder).catch(showError);
  };
}
function renderResourceRow(item, kind) {
  const browsing = browserWorkspace ?? workspace;
  const sameProject = browsing?.projectRoot?.toLowerCase() === workspace?.projectRoot?.toLowerCase();
  const current = sameProject && (kind === 'view' ? item.id === viewId : item.id === activeId && !definitionMode());
  const row = el('div', undefined, 'resource-row' + (current ? ' current' : ''));
  if (kind === 'mechanic') {
    row.draggable = true;
    row.ondragstart = event => {
      if (!canPreviewMechanicMove(item.id, '__any_target__')) { event.preventDefault(); return; }
      draggingMechanicId = item.id; row.classList.add('is-dragging'); clearDropPreview();
      event.dataTransfer.setData('application/x-mechanics-mechanic', item.id); event.dataTransfer.effectAllowed = 'move';
    };
    row.ondragend = () => { draggingMechanicId = null; row.classList.remove('is-dragging'); clearDropPreview(); };
    attachMechanicDropTarget(row, mechanismFolderPath(item.fullPath.slice(0, item.fullPath.lastIndexOf('/'))));
  }
  const open = button('', async () => {
    await load(kind === 'view' ? item.id : { kind: 'mechanic', id: item.id }, { project: browsing });
    if (matchMedia('(max-width: 700px)').matches) closeSidebar();
  }, 'resource-open');
  open.title = item.fullPath;
  open.setAttribute('aria-label', `打开${kind === 'view' ? '视图' : '机制'} ${item.name}`);
  if (current) open.setAttribute('aria-current', 'page');
  const copy = el('span', undefined, 'resource-copy');
  copy.append(el('strong', item.name));
  const meta = item.duplicateName ? item.fullPath : kind === 'view' ? `${item.visibleCount} 可见 · ${item.registeredCount} 已注册` : '';
  if (meta) copy.append(el('small', meta));
  const resourceIcon = el('span', undefined, 'resource-icon'); resourceIcon.append(icon(kind === 'view' ? 'view' : 'mechanic')); open.append(resourceIcon, copy);
  row.append(open);
  if (kind === 'view') {
    const manage = iconAction('chevron-right', () => { sidebarState.detailViewId = item.id; sidebarState.memberQuery = ''; sidebarState.page = 'views'; renderSidebar(); }, 'icon-button resource-more');
    manage.title = `管理视图“${item.name}”包含的机制`; manage.setAttribute('aria-label', manage.title); row.append(manage);
  }
  return row;
}
function renderViewDetail(container, view) {
  const source = workspace.views.find(item => item.id === view.id), registrations = source.id === viewId ? viewRegistrations : source.mechanicRegistrations ?? [];
  const heading = el('div', undefined, 'view-detail-heading');
  heading.append(button('‹ 全部视图', () => { sidebarState.detailViewId = null; sidebarState.memberQuery = ''; renderSidebar(); }, 'quiet detail-back'));
  const title = el('div'); title.append(el('strong', source.name)); heading.append(title);
  container.append(heading);
  const summary = el('div', undefined, 'view-detail-summary');
  summary.append(el('span', `${registrations.filter(item => item.visible).length} 个可见`), el('span', `${registrations.length} 个已注册`));
  const add = button('添加机制', addViewMechanics, 'view-detail-add'); add.prepend(icon('plus')); add.disabled = source.id !== viewId;
  const addConcept = button('添加概念', addViewConcepts, 'view-detail-add'); addConcept.prepend(icon('plus')); addConcept.disabled = source.id !== viewId;
  summary.append(add, addConcept); container.append(summary);
  if (source.id !== viewId) container.append(el('p', '先打开此视图，才能修改 Visible、顺序和注册内容。', 'sidebar-note'));
  const list = el('div', undefined, 'view-detail-members'); container.append(list);
  if (registrations.length > 8) {
    const search = el('input'); search.type = 'search'; search.value = sidebarState.memberQuery; search.placeholder = '筛选已注册机制'; search.className = 'member-search';
    search.oninput = () => { sidebarState.memberQuery = search.value; renderSidebar(); queueMicrotask(() => { $('resource-content').querySelector('.member-search')?.focus(); }); };
    container.insertBefore(search, list);
  }
  const memberQuery = sidebarState.memberQuery.trim().toLowerCase();
  const indexed = registrations.map((registration, index) => ({ registration, index })).filter(({ registration }) => {
    const id = registration.mechanicId;
    return !memberQuery || [graphName(id), id, resourcePath('mechanic', id)].some(value => value.toLowerCase().includes(memberQuery));
  });
  for (const { index, registration } of indexed) {
    const id = registration.mechanicId, label = graphName(id), row = el('div', undefined, 'view-detail-member');
    const visibleButton = button('', () => toggleLayer(id, !registration.visible), 'icon-button visible-button');
    visibleButton.disabled = source.id !== viewId;
    visibleButton.setAttribute('aria-pressed', String(registration.visible));
    visibleButton.setAttribute('aria-label', `${registration.visible ? '隐藏' : '显示'}机制 ${label}`);
    const visibilityIcon = el('img'); visibilityIcon.src = registration.visible ? './icons/eye.svg' : './icons/eye-off.svg'; visibilityIcon.alt = ''; visibilityIcon.setAttribute('aria-hidden', 'true'); visibleButton.append(visibilityIcon);
    const member = el('div', undefined, 'member-label'); member.title = resourcePath('mechanic', id);
    const copy = el('span'); copy.append(el('strong', label)); member.append(copy);
    const actions = el('details', undefined, 'member-actions'), summary = el('summary'); summary.append(icon('settings'));
    summary.title = `管理机制 ${label}`; summary.setAttribute('aria-label', summary.title);
    const menu = el('span', undefined, 'member-action-menu');
    const up = iconAction('arrow-up', () => moveLayer(id, index - 1)); up.title = `向上移动机制 ${label}`; up.setAttribute('aria-label', up.title); up.disabled = source.id !== viewId || index === 0;
    const down = iconAction('arrow-down', () => moveLayer(id, index + 1)); down.title = `向下移动机制 ${label}`; down.setAttribute('aria-label', down.title); down.disabled = source.id !== viewId || index === registrations.length - 1;
    const remove = iconAction('close', () => removeLayer(id), 'icon-button member-remove'); remove.title = `从视图移除机制 ${label}`; remove.setAttribute('aria-label', remove.title); remove.disabled = source.id !== viewId;
    menu.append(up, down, remove); actions.append(summary, menu); row.append(visibleButton, member, actions); list.append(row);
  }
  if (!indexed.length) list.append(el('p', registrations.length ? '没有匹配的已注册机制。' : '这个视图还没有注册机制。', 'sidebar-empty'));
}
function renderMechanicTree(container, entries) {
  for (const entry of entries) {
    if (entry.kind === 'mechanic') { container.append(renderResourceRow(entry, 'mechanic')); continue; }
    const collapsed = sidebarState.folders.has(entry.fullPath), group = el('div', undefined, 'resource-folder');
    const toggle = button(entry.name, () => {
      if (sidebarState.folders.has(entry.fullPath)) sidebarState.folders.delete(entry.fullPath); else sidebarState.folders.add(entry.fullPath);
      renderSidebar();
    }, 'folder-toggle');
    toggle.prepend(icon(collapsed ? 'chevron-right' : 'chevron-down'));
    toggle.setAttribute('aria-expanded', String(!collapsed)); toggle.title = entry.fullPath;
    const heading = el('div', undefined, 'resource-folder-heading'); heading.append(toggle);
    attachMechanicDropTarget(heading, mechanismFolderPath(entry.fullPath.slice(0, -1)));
    if (entry.fullPath.startsWith('mechanics/')) {
      const manage = iconAction('settings', () => manageMechanicFolder(entry.fullPath), 'icon-button resource-more');
      manage.dataset.folderAction = 'manage-folder'; manage.title = `管理文件夹“${entry.name}”`; manage.setAttribute('aria-label', manage.title);
      manage.disabled = busy() || !!autosave?.blocked; heading.append(manage);
    }
    const children = el('div', undefined, 'tree-children'); children.hidden = collapsed; renderMechanicTree(children, entry.children);
    if (!entry.children.length) children.append(el('p', '空文件夹', 'sidebar-empty'));
    group.append(heading, children); container.append(group);
  }
}
function renderSidebar() {
  const browsing = browserWorkspace ?? workspace;
  if (!browsing) return;
  // 顶栏声明的是主项目，绝不能复用左侧当前浏览目录。
  const primary = sourceProject ?? workspace;
  $('workspace-name').textContent = primary.manifest.name;
  $('workspace-path').textContent = primary.projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '本地项目';
  $('workspace-name').title = primary.manifest.name + '\n项目：' + primary.projectRoot
    + '\n工作区：' + primary.workspaceRoot + '\nAgent 机制文档：' + primary.agentExportRoot;
  // 导出是后台派生物；项目侧栏不以它的短暂状态打断浏览。
  const exportStatus = $('export-publication-status');
  exportStatus.replaceChildren(); exportStatus.hidden = true;
  const sameProject = browsing.projectRoot.toLowerCase() === workspace?.projectRoot?.toLowerCase();
  const draftWorkspace = { ...browsing, mechanics: browsing.mechanics.map(item => sameProject && item.id === activeId && draft && !definitionMode() ? draft : item) };
  const currentViewId = sameProject ? viewId : null, currentMechanicId = sameProject && !definitionMode() ? activeId : null;
  const views = buildViewNavigation(draftWorkspace, { query: sidebarState.queries.views, currentId: currentViewId, recentIds: sidebarState.recentViews });
  const mechanics = buildMechanicNavigation(draftWorkspace, { query: sidebarState.queries.mechanics, currentId: currentMechanicId, recentIds: sidebarState.recentMechanics });
  $('view-file-count').textContent = views.totalCount; $('mechanic-file-count').textContent = mechanics.totalCount;

  const detail = sidebarState.detailViewId && browsing.views.some(item => item.id === sidebarState.detailViewId);
  if (!detail) sidebarState.detailViewId = null;
  const page = sidebarState.page;
  for (const [id, selected] of [['views-tab', page === 'views'], ['mechanics-tab', page === 'mechanics'], ['recent-tab', page === 'recent']]) {
    $(id).setAttribute('aria-selected', String(selected)); $(id).tabIndex = selected ? 0 : -1;
  }
  const recentViews = buildViewNavigation(draftWorkspace, { currentId: currentViewId, recentIds: sidebarState.recentViews }).items.filter(item => item.current || item.recent);
  const recentMechanics = buildMechanicNavigation(draftWorkspace, { currentId: currentMechanicId, recentIds: sidebarState.recentMechanics }).featured;
  $('recent-file-count').textContent = recentViews.length + recentMechanics.length;
  $('resource-title').textContent = sidebarState.detailViewId ? '视图内容' : page === 'views' ? '全部视图' : page === 'mechanics' ? '机制库' : '当前与最近';
  $('resource-create').title = '新建机制';
  $('resource-create').setAttribute('aria-label', $('resource-create').title);
  $('resource-create').hidden = page !== 'mechanics' || !!sidebarState.detailViewId;
  $('resource-create-folder').hidden = $('resource-create').hidden;
  $('resource-search').value = sidebarState.queries[page] ?? ''; $('resource-search').placeholder = `搜索${page === 'views' ? '视图' : '机制'}`;
  $('resource-search').setAttribute('aria-label', $('resource-search').placeholder);
  $('resource-search').closest('label').hidden = !!sidebarState.detailViewId || page === 'recent';
  const content = $('resource-content'); content.replaceChildren();
  if (sidebarState.detailViewId) {
    renderViewDetail(content, { id: sidebarState.detailViewId });
  } else if (page === 'views') {
    for (const item of views.items) content.append(renderResourceRow(item, 'view'));
    if (!views.items.length) content.append(el('p', views.totalCount ? '没有匹配的视图。' : '还没有视图。', 'sidebar-empty'));
  } else if (page === 'mechanics') {
    if (mechanics.mode === 'search') for (const item of mechanics.items) content.append(renderResourceRow(item, 'mechanic'));
    else renderMechanicTree(content, mechanics.tree);
    if (!mechanics.matchCount) content.append(el('p', mechanics.totalCount ? '没有匹配的机制。' : '还没有机制。', 'sidebar-empty'));
  } else {
    if (recentViews.length) {
      content.append(el('div', '视图', 'resource-group-label'));
      for (const item of recentViews) content.append(renderResourceRow(item, 'view'));
    }
    if (recentMechanics.length) {
      content.append(el('div', '机制', 'resource-group-label'));
      for (const item of recentMechanics) content.append(renderResourceRow(item, 'mechanic'));
    }
    if (!recentViews.length && !recentMechanics.length) content.append(el('p', '还没有最近打开的视图或机制。', 'sidebar-empty'));
  }
}
function revealNewMechanic(id) {
  sidebarState.page = 'mechanics'; sidebarState.queries.mechanics = '';
  const path = workspace.files.find(file => file.kind === 'mechanic' && file.id === id).path;
  for (const folder of sidebarState.folders) if (path.startsWith(folder)) sidebarState.folders.delete(folder);
  rememberRecent('mechanic', id);
}
function projection() {
  const data = { ...workspace,
    mechanics: workspace.mechanics.map(item => item.id === activeId && draft ? draft : item) };
  original = compose(data, visible); graph = projectEndpointQualifiers(original);
  if (!implicitPositions.has(contextKey())) implicitPositions.set(contextKey(), {});
  const fallback = implicitPositions.get(contextKey());
  const positions = graphPositions(data, original, viewPositions, activeId, fallback);
  for (const [id, point] of Object.entries(positions)) if (!fallback[id]) fallback[id] = clone(point);
  const projected = clone(positions);
  const scopedCounts = new Map();
  const savedScopedPositions = viewMode() ? scopedPositions : draft?.projectionPositions ?? {};
  const overlaps = (left, right) => left.x < right.x + 186 && left.x + 186 > right.x && left.y < right.y + 82 && left.y + 82 > right.y;
  const freeScopedPosition = preferred => {
    for (let ring = 0; ring < 200; ring++) for (let y = -ring; y <= ring; y++) for (let x = -ring; x <= ring; x++) {
      if (ring && Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
      const candidate = { x: preferred.x + x * 235, y: preferred.y + y * 160 };
      if (Object.values(projected).every(point => !overlaps(candidate, point))) return candidate;
    }
    throw new Error('限定概念投影没有可用的初始布局位置。');
  };
  for (const node of graph.nodes.filter(isEndpointProjection)) {
    const index = scopedCounts.get(node.canonicalNodeId) ?? 0;
    scopedCounts.set(node.canonicalNodeId, index + 1);
    const base = positions[node.canonicalNodeId];
    projected[node.id] = clone(savedScopedPositions[node.id] ?? fallback[node.id] ?? freeScopedPosition({ x: base.x + 230, y: base.y + index * 92 }));
    fallback[node.id] ??= clone(projected[node.id]);
  }
  if (settledRuntime?.contextId === contextKey() + '/' + screen && settledRuntime.epoch === geometryEpoch) {
    for (const node of graph.nodes) if (settledRuntime.positions[node.id]) projected[node.id] = clone(settledRuntime.positions[node.id]);
  }
  return projected;
}
function render(withInspector = true, { preserveRoutes = false } = {}) {
  if (!workspace) return Promise.resolve(false);
  canvas.setTooltipsEnabled(hoverTooltipsEnabled || hoverTooltipsTemporarilyEnabled);
  const table = definitionMode();
  $('stage').hidden = table; $('glossary').hidden = !table;
  if (table) {
    $('file-kind').textContent = '全局'; $('file-name').textContent = '共享概念'; $('file-name').title = filePath(); $('implementation-badge').hidden = true;
    renderCanvasFilePath();
    glossary.update(draft.nodes, workspace.mechanics, pending, workspace.definitions.tagDefinitions ?? []); renderSidebar(); updateStatus(); $('inspector').hidden = true; return Promise.resolve(true);
  }
  try {
    const positions = projection();
    const routeCache = viewMode() ? viewRouteCache : draft?.routeCache;
    // 路线缓存必须与画布消费同一份显示投影，否则隐藏的父概念会带着自己的路线复活。
    const displayGraph = displayGraphOf(graph);
    // 收起 is-a 后，只在旧投影里存在的父概念或分类边必须同时失去选中状态。
    if (!selectionInDisplay(displayGraph, selection)) selection = null;
    const restoredRoutes = restoreRouteCache(displayGraph, positions, routeCache);
    if (restoredRoutes) canvas.primeRoutes(displayGraph, positions, restoredRoutes);
    const routing = canvas.update(graph, positions, activeId, selection, definitionMode(), { preserveRoutes,
      deferRouting: opening && !restoredRoutes, ...displayOptions(),
      tagDefinitions: workspace.definitions.tagDefinitions ?? [], nodeColors: viewMode() ? viewNodeColors : draft?.nodeColors ?? {}, nodeStyles: viewMode() ? viewNodeStyles : draft?.nodeStyles ?? {} });
    $('file-kind').textContent = viewMode() ? '视图' : legacy ? '旧记录' : '机制';
    $('file-name').textContent = viewMode() ? workspace.views.find(item => item.id === viewId).name : legacy ? '待保存的叠加' : activeId === null ? '未选择机制' : draft.name;
    $('file-name').title = filePath();
    const badge = $('implementation-badge');
    badge.hidden = viewMode() || legacy || activeId === null;
    if (!badge.hidden) {
      if (!['design', 'implemented'].includes(draft.implementationStatus)) throw new Error('机制图落地状态非法：' + String(draft.implementationStatus));
      const implemented = draft.implementationStatus === 'implemented';
      badge.textContent = implemented ? '✓ 已落地' : '设计稿';
      badge.classList.toggle('implemented', implemented);
      badge.title = (implemented ? '作者确认本图已落地' : '尚未声明本图已落地') + (dirty() ? '（未保存草稿）' : '');
      badge.setAttribute('aria-label', badge.textContent + (dirty() ? '，未保存草稿' : ''));
    }
    renderCanvasFilePath();
    $('counts').textContent = graph.nodes.length + ' 个节点 · ' + graph.edges.length + ' 条关系';
    $('empty').hidden = graph.nodes.length > 0;
    $('empty-title').textContent = viewMode() ? '选择要叠加的机制' : activeId === null ? '开始一张机制图' : '为这张图引用概念';
    $('empty-hint').textContent = viewMode() ? '点击当前视图旁的＋，注册要展示的子机制。' : activeId === null ? '选择左侧机制文件，或新建一张机制图。' : '从概念表引用节点，再连接规则。';
    $('empty-add').hidden = viewMode() || legacy;
    $('empty-add').textContent = activeId === null ? '新建机制图' : '概念节点';
    $('toolbar').hidden = legacy || (!viewMode() && activeId === null);
    $('toolbar').classList.toggle('view-tools', viewMode());
    $('add-node').hidden = viewMode(); $('relation-tools').hidden = viewMode();
    $('add-node').title = '引用已有概念到当前机制图';
    renderSidebar(); updateStatus(); if (withInspector) inspect(); return routing;
  } catch (error) {
    graph = { nodes: [], edges: [] }; canvas.update(graph, {}, activeId, null, definitionMode()); showError(error);
    return Promise.resolve(false);
  }
}
function inspect() {
  const inspector = $('inspector'), panel = $('properties'); panel.replaceChildren(); inspector.hidden = !selection;
  inspector.classList.toggle('is-collapsed', inspectorCollapsed);
  const toggle = $('toggle-inspector');
  toggle.setAttribute('aria-pressed', String(inspectorCollapsed));
  toggle.setAttribute('aria-label', inspectorCollapsed ? '展开详情' : '最小化详情');
  toggle.title = inspectorCollapsed ? '展开详情' : '最小化详情';
  $('inspector-toggle-path').setAttribute('d', inspectorCollapsed ? 'M15.5 5.5 9 12l6.5 6.5' : 'M9 5.5 15.5 12 9 18.5');
  if (!selection) return;
  if (selection.type === 'linking') {
    $('inspector-title').textContent = '新建连线';
    panel.append(el('strong', '点击节点新建连线', 'linking-heading'),
      el('p', `已选择起点：${name(selection.id)}。点击目标节点后会立即创建当前默认类型的连线。`, 'note'),
      button('取消连线', cancelLinking, 'quiet'));
    return;
  }
  if (selection.type === 'nodes') {
    const ids = selection.ids.filter(id => graph.nodes.some(node => node.id === id));
    $('inspector-title').textContent = `已选择 ${ids.length} 个节点`;
    detail(panel, '选中节点', ids.map(name).join('、'));
    const nodeColors = viewMode() ? viewNodeColors : draft?.nodeColors ?? {};
    const nodeStyles = viewMode() ? viewNodeStyles : draft?.nodeStyles ?? {};
    const common = values => values.every(value => value === values[0]) ? values[0] : undefined;
    const applyStyles = style => {
      const change = data => {
        data.nodeStyles ??= {};
        for (const id of ids) if (style === 'solid') delete data.nodeStyles[id]; else data.nodeStyles[id] = style;
        if (!Object.keys(data.nodeStyles).length) delete data.nodeStyles;
      };
      if (viewMode()) editView(change, { keepSelection: true, preserveRoutes: true });
      else edit(change, { topology: false });
    };
    const applyColors = color => {
      const change = data => {
        data.nodeColors ??= {};
        for (const id of ids) if (color) data.nodeColors[id] = color; else delete data.nodeColors[id];
        if (!Object.keys(data.nodeColors).length) delete data.nodeColors;
      };
      if (viewMode()) editView(change, { keepSelection: true, preserveRoutes: true });
      else edit(change, { topology: false });
    };
    nodeStylePicker(panel, common(ids.map(id => nodeStyles[id] ?? 'solid')), applyStyles);
    nodeColorPicker(panel, common(ids.map(id => nodeColors[id] ?? null)), applyColors);
    panel.append(el('p', '拖动任一选中节点可整体移动；Shift 单击增减成员，Esc 清空选择。一次撤销恢复整组位置。', 'note'));
    return;
  }
  if (selection.type === 'file') {
    if (!draft || definitionMode()) { $('inspector').hidden = true; return; }
    $('inspector-title').textContent = '机制属性';
    detail(panel, '保存文件', filePath());
    field(panel, '机制名称', draft.name, { onChange: value => edit(data => { data.name = value; }, { inspect: false }) });
    field(panel, '分析范围', draft.scope, { multiline: true, onChange: value => edit(data => { data.scope = value; }, { inspect: false }) });
    field(panel, '落地状态', draft.implementationStatus, { options: [['design', '设计稿'], ['implemented', '已落地（作者确认）']], onChange: value => edit(data => { data.implementationStatus = value; }, { topology: false }) });
    panel.append(el('p', '状态是对整张机制图的人工声明，不代表逐条规则已通过运行时验证。', 'note'));
    detail(panel, '稳定 ID', draft.id);
    return;
  }
  if (selection.type === 'diagnostics') {
    $('inspector-title').textContent = '结构提示';
    panel.append(el('p', '只分析当前可见图层。这些是设计疑点，不代表规则错误或实际战局结论。', 'note'));
    for (const finding of diagnose(original).findings) {
      const item = el('div', undefined, 'finding'); item.append(el('strong', finding.nodeIds.map(name).join('、')), el('span', finding.message)); panel.append(item);
    }
    return;
  }
  if (selection.type === 'edge') {
    const edge = graph.edges.find(item => item.id === selection.id); if (!edge) { $('inspector').hidden = true; return; }
    $('inspector-title').textContent = edge.relation === 'specializes' ? '特化 / 是某种关系' : '影响关系';
    detail(panel, '影响方向', name(edge.source) + arrow(edge) + name(edge.target));
    const qualifierText = qualifiers => (qualifiers ?? []).map(item => `${item.key}：${item.value.kind === 'concept' ? name(item.value.conceptId) : String(item.value.value)}`).join('；');
    if (edge.sourceQualifiers?.length) detail(panel, '源参与者限定', qualifierText(edge.sourceQualifiers));
    if (edge.targetQualifiers?.length) detail(panel, '目标参与者限定', qualifierText(edge.targetQualifiers));
    if (edge.relation === 'specializes') detail(panel, '特化 / 是某种语义', '具体概念沿箭头指向上位概念，表示“是某种”；不写入影响符号或继承设置。');
    const direct = edge.steps.length === 1;
    if (direct) {
      const id = edge.steps[0].ruleId ?? edge.id, originalEdge = workspace.rules.rules.find(item => item.id === id);
      if (originalEdge.relation === 'specializes') {
        // is-a 只有一个写入口：概念的 is-a 父概念字段；连线面板只做只读呈现。
        detail(panel, 'is-a 父概念', name(originalEdge.target));
        panel.append(el('p', 'is-a 由子概念的父概念字段维护；请在节点属性面板中更换或清除。', 'note'));
      } else {
        field(panel, '关系', String(originalEdge.sign), {
          options: [['1', '＋ 正向影响'], ['-1', '− 负向影响'], ['random', '？ 随机影响']],
          onChange: value => {
            void updateGlobalRule(id, item => {
              item.sign = value === 'random' ? 'random' : Number(value); item.relation = 'influence'; item.inheritance ??= { mode: 'none' };
            }).then(() => selectRelation(value === 'random' ? 'random' : Number(value), { beginLink: false })).catch(showError);
          },
        });
      }
      if (originalEdge.relation !== 'specializes') {
        const ruleText = field(panel, '规则（可选）', originalEdge.ruleText ?? '', { multiline: true, onChange: value => { void updateGlobalRule(id, item => { item.ruleText = value; }).catch(showError); } });
        ruleText.maxLength = 8000;
        ruleText.placeholder = '填写规则；如有条件约束，请一并写入。';
        const qualifierActions = el('div', undefined, 'property-actions');
        const endpointActions = [
          ['sourceQualifiers', '源参与者'],
          ['targetQualifiers', '目标参与者'],
        ];
        for (const [side, label] of endpointActions) {
          const count = originalEdge[side]?.length ?? 0;
          qualifierActions.append(button(`${count ? '编辑' : '添加'}${label}限定${count ? `（${count}）` : ''}`, () => editEdgeQualifiers(id, side)));
          if (count) qualifierActions.append(button(`清除${label}限定`, () => setEdgeQualifiers(id, side, []), 'quiet danger'));
        }
        panel.append(qualifierActions);
      }
      const customData = field(panel, '自定义文本（不参与建模）', originalEdge.customData ?? '', { multiline: true, onChange: value => { void updateGlobalRule(id, item => {
        if (value) item.customData = value; else delete item.customData;
      }).catch(showError); } });
      customData.maxLength = 16000;
      panel.append(button('删除此连线', () => removeSelection(), 'danger'));
    } else panel.append(el('p', '这是由多条直接规则聚合出的关系；请打开其中一条直接规则编辑。', 'note'));
    edge.steps.forEach(step => {
      detail(panel, '全局规则 / ' + (step.ruleId ?? step.id), name(step.source) + arrow(step) + name(step.target)
        + (step.relation === 'specializes' ? '\n特化 / 是某种关系' : step.ruleText?.trim() ? '\n规则：' + step.ruleText : '\n规则：未填写'));
    });
    return;
  }
  const node = workspace.definitions.nodes.find(item => item.id === selection.id);
  const projectedNode = graph.nodes.find(item => item.id === selection.id);
  if (isEndpointProjection(projectedNode)) {
    $('inspector-title').textContent = '限定概念投影';
    detail(panel, projectedNode.label, projectedNode.description);
    detail(panel, '基础概念', name(projectedNode.canonicalNodeId));
    detail(panel, '限定词', projectedNode.qualifiers.map(item => `${item.key}：${item.value.kind === 'concept' ? name(item.value.conceptId) : String(item.value.value)}`).join('；'));
    panel.append(el('p', '这是规则端点的只读显示投影，不是新概念，也不产生 is-a。请在对应连线中添加、清除或调整端点限定词。', 'note'));
    return;
  }
  if (!node) { $('inspector').hidden = true; return; }
  $('inspector-title').textContent = '节点属性';
  detail(panel, node.label, node.description);
  detail(panel, '稳定 ID', node.id);
  const structure = conceptStructurePresentation(node, workspace.definitions.nodes);
  detail(panel, '概念形态', structure.shape);
  if (node.aliases?.length) detail(panel, '别名', node.aliases.join('、'));
  const tagNames = (node.tagIds ?? []).map(id => workspace.definitions.tagDefinitions?.find(tag => tag.id === id)?.displayName ?? id);
  if (tagNames.length) detail(panel, '标签', tagNames.join('、'));
  const nodeColors = viewMode() ? viewNodeColors : draft?.nodeColors ?? {};
  const nodeStyles = viewMode() ? viewNodeStyles : draft?.nodeStyles ?? {};
  nodeStylePicker(panel, nodeStyles[node.id] ?? 'solid', style => {
    const change = data => {
      data.nodeStyles ??= {};
      if (style === 'solid') delete data.nodeStyles[node.id]; else data.nodeStyles[node.id] = style;
      if (!Object.keys(data.nodeStyles).length) delete data.nodeStyles;
    };
    if (viewMode()) editView(change, { keepSelection: true, preserveRoutes: true });
    else edit(change, { topology: false });
  });
  nodeColorPicker(panel, nodeColors[node.id] ?? null, color => {
    const change = data => {
      data.nodeColors ??= {};
      if (color) data.nodeColors[node.id] = color; else delete data.nodeColors[node.id];
      if (!Object.keys(data.nodeColors).length) delete data.nodeColors;
    };
    if (viewMode()) editView(change, { keepSelection: true, preserveRoutes: true });
    else edit(change, { topology: false });
  });
  const isARule = workspace.rules.rules.find(item => item.relation === 'specializes' && item.source === node.id);
  // is-a 只有一个写入口：这里的父概念选择器（可检索组合框）。
  // 候选排除自身与更具体的后代；当前父概念留在候选里并显示为已选中，有当前值时列表首项即「清除 is-a 父概念」。
  if (!legacy) {
    const section = el('div', undefined, 'detail node-taxonomy');
    section.append(el('strong', 'is-a 父概念'));
    const failParent = error => { showError(error); render(); };
    const picker = new ConceptReferencePicker({
      nodes: () => isaParentCandidates(workspace.definitions.nodes, workspace.rules.rules, node.id),
      currentId: node.id, kind: 'isa', value: isARule?.target ?? '',
      placeholder: '输入名称、ID、别名或含义搜索父概念', ariaLabel: 'is-a 父概念：' + node.label,
      onSelect: id => { void setConceptParent(node.id, id ?? null).catch(failParent); },
      clearOption: '清除 is-a 父概念',
    });
    section.append(picker.root);
    // 展开开关只写当前文件的 taxonomyPresentation：单图写 mechanism 草稿，叠加写 view。
    if (isARule && (draft || viewMode())) {
      const expanded = currentTaxonomyPresentation()?.expandedNodeIds ?? [];
      const toggle = data => {
        const current = data.taxonomyPresentation?.expandedNodeIds ?? [];
        data.taxonomyPresentation = { mode: 'label', expandedNodeIds: current.includes(node.id)
          ? current.filter(id => id !== node.id) : [...current, node.id] };
      };
      const choice = el('label', undefined, 'choice node-taxonomy-choice');
      const input = el('input'); input.type = 'checkbox'; input.checked = expanded.includes(node.id);
      input.onchange = () => (viewMode() ? editView(toggle, { keepSelection: true }) : edit(toggle, { topology: false }));
      // 父概念已经显示在选择器里，这里不再重复文字，只保留开关本身。
      choice.append(input, el('span', '显示连线')); section.append(choice);
    }
    panel.append(section);
  }
  if (node.customData) detail(panel, '自定义文本', node.customData);
  detail(panel, 'Agent 锁', node.agentLocked ? '已锁定；Agent 不能修改或删除此概念' : '未锁定');
  if (!legacy) panel.append(button('修改概念', () => editConcept(node.id)));
  if (draft && !draft.focusNodeIds.includes(node.id)) panel.append(button('引用到当前图层', () => edit(data => { data.focusNodeIds.push(node.id); })));
  const actions = el('div', undefined, 'property-actions');
  if (draft?.focusNodeIds.includes(node.id)) actions.append(button('移出当前图层', removeSelection, 'danger'));
  panel.append(actions);
  const downstream = downstreamNodes(original, node.id);
  if (!downstream.length) panel.append(el('p', '当前范围内没有下游节点', 'note'));
  if (downstream.length) {
    const target = field(panel, '追踪影响至', downstream[0].id, { options: downstream.map(item => [item.id, item.label]) });
    const output = el('div', undefined, 'trace-result');
    output.setAttribute('aria-live', 'polite');
    target.onchange = () => output.replaceChildren();
    panel.append(button('解释影响路径', () => {
      const result = tracePaths(original, node.id, target.value);
      const summary = summarizePaths(result);
      const { positive, negative, random, conclusion } = summary;
      const kind = ['belonging_only', 'not_found'].includes(summary.kind) ? 'neutral'
        : summary.kind === 'positive_only' ? 'positive' : summary.kind === 'negative_only' ? 'negative'
          : summary.kind === 'random_only' ? 'random' : summary.kind;
      const card = el('div', undefined, 'trace-conclusion ' + kind);
      card.append(el('span', result.truncated ? '已找到的路径 · 结果不完整' : '当前模型结论', 'trace-eyebrow'),
        el('strong', conclusion, 'trace-verdict'), el('p', name(node.id) + ' → ' + name(target.value), 'trace-endpoints'));
      if (result.paths.length) card.append(el('p', [positive && `${positive} 条正向影响`, negative && `${negative} 条负向影响`, random && `${random} 条随机影响`].filter(Boolean).join(' · '), 'trace-count'));
      if (kind === 'mixed') card.append(el('p', '不能合并为单一正负结论，也不相互抵消。', 'trace-caution'));
      output.replaceChildren(card);
      if (result.truncated) output.append(el('p', '已达到查询上限，尚未列出的路径可能包含其他影响方向。', 'trace-warning'));
      result.paths.forEach((path, index) => {
        const item = el('div', undefined, 'trace-evidence');
        item.append(el('strong', `路径 ${index + 1} · ` + (path.sign === 1 ? '正向影响' : path.sign === -1 ? '负向影响' : path.sign === 'random' ? '随机影响' : '无影响路径')));
        item.append(el('p', name(node.id) + path.steps.map(step => arrow(step) + name(step.traversalTarget ?? step.target)).join(''), 'trace-chain'));
        const details = el('details'); details.append(el('summary', '查看来源与规则'));
        details.append(el('div', path.steps.map(step => name(step.traversalSource ?? step.source) + arrow(step) + name(step.traversalTarget ?? step.target) + '\n来源：' + graphName(step.graphId) + ' / ' + step.edgeId
          + (step.ruleText?.trim() ? '\n规则：' + step.ruleText : '\n规则：未填写')).join('\n\n'), 'trace-path'));
        item.append(details); output.append(item);
      });
      output.append(el('p', result.interpretation, 'note trace-limits'));
      card.scrollIntoView({ block: 'nearest' });
    }), output);
  }
}
// 概念只有一个编辑界面：这个共享对话框同时服务机制图节点属性面板与概念表，
// 因此不再拒绝 definitionMode（概念表就是定义模式）。
async function editConcept(id) {
  await writeQueue;
  if (!workspace || busy() || legacy || autosave.blocked) return;
  if (referenceSession?.commit) throw new Error('请先处理尚未完成的概念引用。');
  const node = workspace.definitions.nodes.find(item => item.id === id);
  if (!node) throw new Error('概念已不存在，请重新读取。');
  let fields, editor, blocked = false;
  try {
    // 与「新建概念」同一宽度：不加这个类会回落到默认的窄对话框，把两列编辑器挤在一起。
    $('dialog').classList.add('concept-dialog');
    await dialog('修改概念', container => {
      fields = el('div'); container.append(fields);
      // 对话框自己有底部「取消 / 保存概念」，编辑器不再渲染第二排按钮；
      // 用户一改动就标记未保存，保证切换文件/关闭前的确认提示仍然有效。
      editor = new ConceptEditor(fields, { mode: 'edit', node, nodes: () => workspace.definitions.nodes, tagDefinitions: workspace.definitions.tagDefinitions ?? [],
        parentOptions: parentCandidates(id), parentId: workspace.rules.rules.find(rule => rule.relation === 'specializes' && rule.source === id)?.target ?? null,
        showActions: false,
        onCancel: () => $('dialog').close('cancel') });
      fields.addEventListener('input', () => { conceptEditDirty = true; }, { once: true });
      container.append(el('p', '保存到共享概念表，所有引用此概念的机制都会更新；当前机制草稿不受影响。', 'note'));
    }, async () => {
      if (blocked) throw new Error('请关闭窗口并重新读取磁盘核实。');
      const document = prepareConceptUpdate(workspace.definitions, id, editor.form);
      const definitionsChanged = json(document) !== json(workspace.definitions);
      const currentParent = workspace.rules.rules.find(rule => rule.relation === 'specializes' && rule.source === id)?.target ?? null;
      const parentId = editor.form.parentId || null;
      const rules = parentId === currentParent ? null : { ...clone(workspace.rules), rules: setSpecializesParent(workspace.rules.rules, id, parentId) };
      if (!definitionsChanged && !rules) return;
      const beforeRules = workspace.rules.rules;
      fields.disabled = true;
      try {
        // 概念定义与 is-a 规则一起提交：删除被固定的 is-a 规则时，pinnedRuleIds 必须在同一事务里清理。
        await write(revision => api('/api/concept-taxonomy', { revision, ...(definitionsChanged ? { definitions: document } : {}), ...(rules ? { rules } : {}) }));
      } catch (error) {
        blocked = ['REVISION_CONFLICT', 'SAVE_UNCERTAIN'].includes(error.code);
        if (blocked) error.message += '\n请关闭窗口后重新读取磁盘核实；不会自动覆盖或重复提交。';
        throw error;
      } finally { fields.disabled = false; }
      conceptEditDirty = false;
      if (!syncLocalPinsAfterTaxonomy(classifyTaxonomyChange(beforeRules), [[id, parentId]])) render();
    }, '保存概念', { settled: () => { $('confirm-dialog').disabled = blocked; } });
  } finally { conceptEditDirty = false; $('dialog-content').onkeydown = null; $('dialog').classList.remove('concept-dialog'); }
}
async function removeSelection() {
  if (!selection || busy() || legacy || autosave.blocked) return;
  if (selection.type === 'edge') {
    const edge = graph.edges.find(item => item.id === selection.id);
    if (edge?.steps.length !== 1) return;
    const id = edge.steps[0].ruleId ?? edge.id;
    const accepted = await dialog('删除全局规则？', container => {
      container.append(el('p', '规则会从 rules.json 删除，并同步移除所有机制图和视图中的固定引用；概念本身不会删除。', 'note'));
    }, () => true, '删除规则');
    if (!accepted) return;
    selection = null;
    await write(revision => api('/api/rules/delete', { revision, ruleId: id }));
    render();
    return;
  }
  if (selection.type !== 'node' && selection.type !== 'nodes') return;
  const ids = selection.type === 'nodes' ? canvas.selectedIds() : [selection.id];
  const id = ids[0];
  if (definitionMode()) {
    const owners = workspace.mechanics.filter(item => item.focusNodeIds.includes(id));
    if (owners.length) throw new Error('节点仍被以下图层引用，不能删除定义：' + owners.map(item => item.name).join('、'));
  } else if (ids.some(item => !draft?.focusNodeIds.includes(item))) return;
  const accepted = await dialog(definitionMode() ? '确认删除概念？' : '移出当前图层？', container => {
    container.append(el('p', definitionMode() ? '将删除“' + name(id) + '”的共享定义。此操作会在保存后生效；删除前仍会检查机制和视图引用。' : `从当前图层移除 ${ids.length} 个节点；只会清理已无任何引用的概念。`, 'note'));
  }, () => true, definitionMode() ? '删除概念' : '确认移除');
  if (!accepted) return;
  if (!definitionMode()) {
    const result = await write(revision => api('/api/mechanic-nodes/remove', { revision, mechanicId: activeId, nodeIds: ids }));
    selection = null; draft = clone(workspace.mechanics.find(item => item.id === activeId)); baseline = clone(draft);
    $('tool-hint').textContent = `已移出 ${result.removedFromGraphIds.length} 个节点；清理 ${result.prunedConceptIds.length} 个孤立概念。`;
    render(); return;
  }
  selection = null;
  edit(data => {
    if (definitionMode()) data.nodes = data.nodes.filter(item => item.id !== id);
    else data.focusNodeIds = data.focusNodeIds.filter(item => item !== id);
    delete data.positions[id];
    delete data.nodeColors?.[id];
    delete data.nodeStyles?.[id];
  });
}
async function addNode() {
  if (!workspace || busy() || $('dialog').open) return;
  if (definitionMode()) { addTerm(); return; }
  if (activeId === null || viewMode() || legacy || autosave.blocked) return;
  setMode('select');
  referenceSession ??= { targetId: activeId, query: '', selected: new Set(), candidates: [], candidateParents: new Map(), form: null, commit: null };
  const session = referenceSession; let picker;
  $('dialog').classList.add('concept-dialog');
  try {
    await dialog('概念节点', container => {
      picker = new ConceptPicker(container, session, workspace.definitions, draft.focusNodeIds, {
        // 新建候选的 is-a 父概念可以来自整个工作区，也可以是本批待新建的概念。
        parentOptions: () => [...parentCandidates(null), ...session.candidates],
        status: (text, enabled) => { $('confirm-dialog').textContent = text; $('confirm-dialog').disabled = !enabled; },
        abandon: () => { referenceSession = null; $('dialog').close('cancel'); },
        recover: async () => {
          const recovery = container.querySelector('.concept-recovery'); recovery.inert = true;
          $('confirm-dialog').disabled = $('close-dialog').disabled = $('cancel-dialog').disabled = true;
          opening = true; updateStatus();
          try {
            const latest = await api('/api/workspace');
            const saved = session.commit.reconcile(latest);
            workspace = latest; $('dialog-error').hidden = true;
            container.querySelector('.concept-recovery-note').textContent = saved ? '已核实概念已保存。点击继续引用，不会重复创建。' : '已核实这些概念尚未写入。可以再次明确创建并引用。';
          } catch (error) { $('dialog-error').textContent = error.message; $('dialog-error').hidden = false; }
          finally { opening = false; updateStatus(); recovery.inert = false; $('close-dialog').disabled = $('cancel-dialog').disabled = false; picker.updateStatus(); }
        },
      });
    }, async () => {
      if (!session.commit) {
        picker.stage();
        session.sourceDraft = clone(draft);
        const data = { ...workspace, mechanics: [draft] }, source = compose(data, [activeId]);
        const candidates = session.candidates.filter(node => session.selected.has(node.id));
        // 新概念的 is-a 与定义必须一次提交；父概念可以是已有概念，也可以是本批同样新建的概念。
        const parents = session.candidateParents instanceof Map ? session.candidateParents : new Map();
        const known = new Set([...workspace.definitions.nodes.map(node => node.id), ...candidates.map(node => node.id)]);
        let nextRules = null;
        for (const [childId, parentId] of parents) {
          if (!session.selected.has(childId)) continue;
          if (!known.has(parentId)) throw new Error('is-a 父概念不存在或未被本次引用：' + parentId);
          nextRules = setSpecializesParent(nextRules ?? workspace.rules.rules, childId, parentId);
        }
        session.commit = new ReferenceCommit(prepareReference({ workspace, draft, selected: [...session.selected], candidates,
          rules: nextRules ? { ...clone(workspace.rules), rules: nextRules } : null,
          positions: graphPositions(data, source, {}, activeId, implicitPositions.get(contextKey())), center: canvas.center() }));
      }
      const committing = session.commit.run(document => write(revision => session.commit.plan.rules
        ? api('/api/concept-taxonomy', { revision, definitions: document, rules: session.commit.plan.rules })
        : api('/api/save', { revision, kind: 'definitions', document })), next => {
        if (activeId !== session.targetId || definitionMode() || viewMode() || json(draft) !== json(session.sourceDraft)) throw new Error('当前机制草稿已改变，请重新读取并核实。');
        return edit(data => { Object.assign(data, next); });
      });
      const beforeRules = workspace.rules.rules;
      picker.updateStatus(); await committing;
      // 新建概念带来的 is-a 规则同样要固定进当前文件，否则显式投影里看不到节点标签。
      syncLocalPinsAfterTaxonomy(classifyTaxonomyChange(beforeRules),
        [...session.candidateParents].filter(([childId]) => session.selected.has(childId)));
      selection = session.commit.plan.additions.length === 1 ? { type: 'node', id: session.commit.plan.additions[0] } : { type: 'nodes', ids: session.commit.plan.additions };
      referenceSession = null; render();
      $('tool-hint').textContent = `已引用 ${session.commit.plan.additions.length} 个概念${session.commit.plan.candidates.length ? `，其中新建 ${session.commit.plan.candidates.length} 个` : ''}`;
    }, '添加节点', { settled: () => picker.updateStatus() });
  } finally {
    $('dialog').classList.remove('concept-dialog'); $('dialog-content').onkeydown = null;
    if (!session.commit) referenceSession = null;
  }
}
function mechanismFolderPath(path) {
  const value = path.replace(/\/+$/, '');
  if (value === 'mechanics') return '';
  if (!value.startsWith('mechanics/')) throw new Error('请选择机制库内的文件夹。');
  return value.slice('mechanics/'.length);
}
function mechanismFolderChoices(excluding = null) {
  return [['', '机制库根目录'], ...workspace.directories.filter(path => path.startsWith('mechanics/'))
    .map(path => path.slice('mechanics/'.length))
    .filter(path => excluding === null || (path !== excluding && !path.startsWith(excluding + '/')))
    .sort((a, b) => a.localeCompare(b)).map(path => [path, path])];
}
function joinedMechanismFolder(parent, name) {
  const value = name.trim();
  if (!value || value === '.' || value === '..' || /[\\/]/.test(value)) throw new Error('文件夹名称不能为空，也不能包含路径分隔符。');
  return parent ? parent + '/' + value : value;
}
async function prepareFolderOperation() {
  await writeQueue;
  if (!workspace || busy() || $('dialog').open) return false;
  if (legacy || autosave?.blocked || referenceSession?.commit) {
    showError(new Error('请先处理当前未完成的保存、概念引用或旧视图记录，再整理文件夹。')); return false;
  }
  // 目录操作不打开另一张图，也不修改 JSON；当前草稿及其撤销记录保留。
  return true;
}
async function writeFolderOperation(path, body, message) {
  try {
    await write(revision => api(path, { ...body, revision }));
  } catch (error) {
    if (['SAVE_UNCERTAIN', 'AGENT_EXPORT_FAILED', 'REVISION_CONFLICT'].includes(error.code)) {
      autosave.pause(error); $('dialog').close('cancel'); showError(error); return false;
    }
    throw error;
  }
  sidebarState.page = 'mechanics'; sidebarState.detailViewId = null; sidebarState.queries.mechanics = '';
  renderSidebar(); updateStatus();
  if (!definitionMode() && activeId !== null) $('file-name').title = resourcePath('mechanic', activeId);
  $('tool-hint').textContent = message;
  return true;
}
async function createMechanicFolderDialog(parent = '') {
  if (!await prepareFolderOperation()) return;
  let nameInput, parentInput;
  await dialog('新建机制文件夹', container => {
    parentInput = field(container, '所在文件夹', parent, { options: mechanismFolderChoices() });
    nameInput = field(container, '文件夹名称', '', { required: true });
  }, async () => {
    const folder = joinedMechanismFolder(parentInput.value, nameInput.value);
    const saved = await writeFolderOperation('/api/mechanic-folders', { folder }, '已创建文件夹：' + folder);
    if (saved) { for (const path of sidebarState.folders) if (('mechanics/' + folder + '/').startsWith(path)) sidebarState.folders.delete(path); renderSidebar(); }
    return saved;
  }, '创建文件夹');
}
async function deleteMechanicDialog() {
  if (activeId === null || definitionMode() || viewMode() || legacy || !await guard()) return;
  const id = activeId, label = graphName(id);
  const confirmed = await dialog('删除机制图', container => {
    container.append(el('p', `确定删除“${label}”吗？此操作会删除机制图文件与导出文档，且无法撤销。`, 'note'));
  }, () => true, '确认删除');
  if (!confirmed) return;
  try {
    const next = await write(revision => api('/api/mechanic-delete', { revision, mechanicId: id }));
    if (!next.mechanics.length) { activeId = null; draft = baseline = null; graph = { nodes: [], edges: [] }; renderSidebar(); render(); return; }
    await openLayer(next.mechanics[0].id);
  } catch (error) { showError(error); }
}

async function moveMechanicToFolder(mechanicId, folder) {
  if (!await prepareFolderOperation()) return;
  const source = resourcePath('mechanic', mechanicId), currentFolder = mechanismFolderPath(source.slice(0, source.lastIndexOf('/')));
  if (folder === currentFolder) return;
  const saved = await writeFolderOperation('/api/mechanic-move', { mechanicId, folder }, '已移动机制图：' + graphName(mechanicId));
  if (saved) revealNewMechanic(mechanicId);
}
async function moveMechanicFolderDialog(sourceFolder) {
  if (!await prepareFolderOperation()) return;
  const parts = sourceFolder.split('/'), originalName = parts.pop(), parent = parts.join('/');
  let nameInput, parentInput;
  await dialog('移动或重命名文件夹', container => {
    parentInput = field(container, '目标父文件夹', parent, { options: mechanismFolderChoices(sourceFolder) });
    nameInput = field(container, '文件夹名称', originalName, { required: true });
    container.append(el('p', '文件夹中的机制图保持各自独立，视图中的已选机制保持原样。', 'note'));
  }, async () => {
    const targetFolder = joinedMechanismFolder(parentInput.value, nameInput.value);
    if (sourceFolder === targetFolder) throw new Error('请修改名称或目标父文件夹。');
    const saved = await writeFolderOperation('/api/mechanic-folder-move', { sourceFolder, targetFolder }, '已移动文件夹：' + targetFolder);
    if (saved) {
      const sourcePath = 'mechanics/' + sourceFolder + '/', targetPath = 'mechanics/' + targetFolder + '/';
      sidebarState.folders = new Set([...sidebarState.folders].map(path => path.startsWith(sourcePath) ? targetPath + path.slice(sourcePath.length) : path));
      for (const path of sidebarState.folders) if (targetPath.startsWith(path) && path !== targetPath) sidebarState.folders.delete(path);
      renderSidebar();
    }
    return saved;
  }, '保存文件夹位置');
}
async function deleteMechanicFolderDialog(folder) {
  if (!await prepareFolderOperation()) return;
  await dialog('删除空文件夹', container => {
    container.append(el('p', `删除文件夹“${folder}”？仅空文件夹可以删除。`, 'note'));
  }, async () => {
    const saved = await writeFolderOperation('/api/mechanic-folder-delete', { folder }, '已删除空文件夹：' + folder);
    if (saved) sidebarState.folders.delete('mechanics/' + folder + '/');
    return saved;
  }, '删除空文件夹');
}
async function manageMechanicFolder(fullPath) {
  if (!await prepareFolderOperation()) return;
  const folder = mechanismFolderPath(fullPath); let action;
  await dialog('管理文件夹：' + (folder || '机制库根目录'), container => {
    $('confirm-dialog').hidden = true;
    const actions = el('div', undefined, 'folder-dialog-actions');
    const choose = (label, run) => actions.append(button(label, () => { action = run; $('dialog').close('cancel'); }));
    choose('新建机制图', () => newGraph(folder ? 'mechanics/' + folder : 'mechanics'));
    choose('新建子文件夹', () => createMechanicFolderDialog(folder));
    if (folder) {
      choose('移动或重命名', () => moveMechanicFolderDialog(folder));
      choose('删除空文件夹', () => deleteMechanicFolderDialog(folder));
    }
    container.append(actions);
  }, () => false);
  if (action) await action();
}
async function newGraph(defaultDirectory = 'mechanics') {
  if (!workspace || !await guard()) return;
  let label, id, scope, directory;
  await dialog('新建机制', container => {
    label = field(container, '机制名称', '', { required: true });
    id = field(container, '稳定英文 ID', '', { required: true, pattern: '[a-z][a-z0-9]*(?:-[a-z0-9]+)*' });
    id.placeholder = 'basic-combat-rules';
    scope = field(container, '分析范围', '', { multiline: true, required: true });
    directory = field(container, '相对目录', defaultDirectory, { required: true });
    directory.setAttribute('list', 'workspace-directories');
    const choices = el('datalist'); choices.id = 'workspace-directories';
    for (const path of ['.', ...workspace.directories]) { const option = el('option'); option.value = path; choices.append(option); }
    container.append(choices, el('p', '保存为 <相对目录>/<ID>.mechanic.json。支持中文和多层目录；填 . 表示工作区根。', 'note'));
  }, async () => {
    const document = { schemaVersion: 9, kind: 'mechanic', workspaceId: workspace.manifest.id, id: id.value, name: label.value.trim(), scope: scope.value.trim(), implementationStatus: 'design', focusNodeIds: [], pinnedRuleIds: [], positions: {}, taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } };
    const parent = directory.value.trim(), file = (parent === '.' ? '' : parent + '/') + document.id + '.mechanic.json';
    await write(revision => api('/api/mechanics', { revision, document, file }));
    // 新文件已存在后，打开失败不能自动重复创建。
    try {
      const candidate = await readOpening(api, { kind: 'mechanic', id: document.id }, workspace);
      rememberCamera(); workspace = candidate.workspace; viewId = null; legacy = false;
      assignLayer(document.id); assignSnapshot(candidate.snapshot); sidebarState.lastOpened = { kind: 'mechanic', id: document.id }; persistRecentState(); autosave.reset(); revealNewMechanic(document.id); render(); restoreCamera();
    } catch (error) {
      $('dialog').close('cancel'); showError(new Error('机制文件已创建：' + file + '，但打开未完成。请重新读取，不要重复创建。\n' + error.message));
    }
  }, '创建文件');
}
function setMode(mode) {
  if ((viewId !== null || legacy) && mode !== 'select') return;
  if (!definitionMode() || mode === 'select') {
    canvas.setMode(mode);
    $('tool-hint').textContent = legacy ? '旧叠加只读 · 左键平移 · Shift+左键框选' : mode === 'select' ? '左键平移 · Shift+左键框选 · 双击节点连线 · Shift 增选'
        : mode === 'random' ? '先点影响源，再点目标 · 目标可能增加或减少，不表示概率'
          : '先点击影响源，再点击受影响节点 · 写入当前机制';
  }
}
function cancelLinking() {
  setMode('select'); selection = null; render();
}
async function addTerm() {
  if (!workspace || !definitionMode() || busy()) return;
  let editor;
  await dialog('新增概念', container => {
    const host = el('div'); container.append(host);
    editor = new ConceptEditor(host, { mode: 'create', node: {}, nodes: () => workspace.definitions.nodes, tagDefinitions: workspace.definitions.tagDefinitions ?? [], parentOptions: parentCandidates(null),
      showActions: false, onCancel: () => $('dialog').close('cancel') });
    host.addEventListener('input', () => { conceptEditDirty = true; }, { once: true });
  }, async () => {
    const node = conceptPayloadFromForm(editor.form);
    if (workspace.definitions.nodes.some(item => item.id === node.id)) throw new Error('概念 ID 已存在：' + node.id);
    const parentId = editor.form.parentId || null;
    if (!parentId) {
      edit(data => { data.nodes.push(node); });
      glossary.focusNode(node.id); return true;
    }
    // 指定 is-a 时概念必须与规则一起提交；候选基于当前定义草稿，未保存的概念编辑一并落盘。
    const definitions = { ...clone(draft), nodes: [...clone(draft.nodes), node] };
    const rules = { ...clone(workspace.rules), rules: setSpecializesParent(workspace.rules.rules, node.id, parentId) };
    await write(revision => api('/api/concept-taxonomy', { revision, definitions, rules }));
    draft = clone(workspace.definitions); baseline = clone(draft); conceptEditDirty = false;
    glossary.focusNode(node.id); return true;
  }, '新增概念');
}
async function createRule(source, target, relation) {
  if (busy() || definitionMode() || viewMode() || activeId === null) return false;
  if (!draft.focusNodeIds.includes(source) || !draft.focusNodeIds.includes(target)) throw new Error('请先把两个节点引用到当前机制图，再建立关系。');
  if (workspace.rules.rules.some(edge => edge.source === source && edge.target === target)) {
    showError('这两个概念之间已有同向规则；请编辑现有规则。');
    return false;
  }
  const id = semanticRuleId(source, target, new Set(workspace.rules.rules.map(edge => edge.id)));
  const rules = clone(workspace.rules);
  // 连线手势只创建影响规则；is-a 由概念的父概念字段写入，不再有连线入口。
  rules.rules.push({ id, source, target, relation: 'influence', sign: relation, inheritance: { mode: 'none' }, ruleText: '' });
  const mechanic = clone(draft);
  for (const nodeId of [source, target]) if (!mechanic.focusNodeIds.includes(nodeId)) mechanic.focusNodeIds.push(nodeId);
  if (!mechanic.pinnedRuleIds.includes(id)) mechanic.pinnedRuleIds.push(id);
  await write(async revision => {
    return api('/api/rules-and-mechanic', { revision, rules, mechanicId: activeId, mechanic });
  });
  draft = mechanic; baseline = clone(mechanic);
  selectRelation(relation, { beginLink: false }); setMode('select'); selection = { type: 'edge', id }; render();
  return true;
}
const glossary = new GlossaryTable($('glossary'), {
  // 概念表不再自带内联编辑器：编辑概念统一走共享对话框（含 is-a 选择、definitions+rules
  // 一次提交与固定引用同步），概念一多也不会往这张大表里插入表单。
  edit: id => { void editConcept(id).catch(showError); },
  setLocks: (ids, agentLocked) => edit(data => { const selected = new Set(ids); for (const node of data.nodes) if (selected.has(node.id)) node.agentLocked = agentLocked; }),
  updateTags: tagDefinitions => edit(data => { data.tagDefinitions = structuredClone(tagDefinitions); }),
  add: () => { void addTerm().catch(showError); },
  remove: id => { selection = { type: 'node', id }; void removeSelection().catch(showError); },
  locate: id => {
    const owners = workspace.mechanics.filter(item => item.focusNodeIds.includes(id));
    const target = owners.find(item => item.id === activeId) ?? owners.find(item => visible.includes(item.id)) ?? owners[0];
    if (!target) return;
    void openLayer(target.id).then(() => {
      if (definitionMode() || activeId !== target.id) return;
      selection = { type: 'node', id }; render(); canvas.fit();
    }).catch(showError);
  },
});
const compute = new GraphComputeCoordinator({
  onState: state => { computeState = state.active ? state : null; updateStatus(); },
});
function runGraphCompute(request) {
  const intent = { contextId: contextKey() + '/' + screen, epoch: geometryEpoch };
  const requestCurrent = request.isCurrent ?? (() => true);
  return compute.run({ ...request, isCurrent: () => requestCurrent()
    && intent.contextId === contextKey() + '/' + screen && intent.epoch === geometryEpoch });
}
async function commitSettledGeometry(result, { recordHistory = false } = {}) {
  if (!result?.positions || !Array.isArray(result.routes)) throw new Error('图计算没有返回完整的终态位置与连线。');
  const current = projection();
  // 几何提交只认显示投影：隐藏节点不写入坐标，也不要求有路线。
  const displayGraph = displayGraphOf(graph);
  const regularNodes = displayGraph.nodes.filter(node => !isEndpointProjection(node));
  const projectionNodes = displayGraph.nodes.filter(isEndpointProjection);
  const changed = displayGraph.nodes.some(node => current[node.id]?.x !== result.positions[node.id]?.x
    || current[node.id]?.y !== result.positions[node.id]?.y);
  const routes = new Map(result.routes);
  const routeCache = result.routeCache ?? createRouteCache(displayGraph, result.positions, routes);
  if (!routeCache || !restoreRouteCache(displayGraph, result.positions, routeCache)) throw new Error('图计算返回的连线不完整，未提交整理结果。');
  const previousCache = viewMode() ? viewRouteCache : draft?.routeCache;
  const edited = changed || json(previousCache) !== json(routeCache);
  if (recordHistory && edited) {
    // 先捕获完整旧几何，再同时替换节点和路径；仅路径改善也属于一次编辑。
    history.push(viewMode() ? viewSnapshot() : clone(draft)); if (history.length > 80) history.shift(); future = [];
  }
  canvas.primeRoutes(displayGraph, result.positions, routes);
  // 首次打开的后台路线只是运行时投影，不能改写规则草稿、触发保存或令切换守卫误判为用户修改。
  // 明确的重排/编辑才把路线快照与用户操作一并写入草稿。
  if (routeCache && (recordHistory || result.persistRouteCache !== 'background' && result.persistRouteCache)) {
    if (viewMode()) viewRouteCache = routeCache;
    else if (draft) draft.routeCache = routeCache;
  }
  if (changed || recordHistory && edited) {
    if (recordHistory || result.commitPositions) {
      const regularPositions = Object.fromEntries(regularNodes.map(node => [node.id, clone(result.positions[node.id])]));
      const nextScopedPositions = Object.fromEntries(projectionNodes.map(node => [node.id, clone(result.positions[node.id])]));
      if (viewMode()) { Object.assign(viewPositions, regularPositions); Object.assign(scopedPositions, nextScopedPositions); }
      else if (draft?.positions) { Object.assign(draft.positions, regularPositions); Object.assign(draft.projectionPositions ??= {}, nextScopedPositions); }
      geometryEpoch++; settledRuntime = null;
    } else {
      // 没有提交位置意图的后台计算只更新运行时几何。
      // 拖动近邻微调通过 commitPositions 合并到已有拖动编辑。
      settledRuntime = { contextId: contextKey() + '/' + screen, epoch: geometryEpoch, positions: clone(result.positions) };
    }
  }
  $('error').hidden = true;
  render(true, { preserveRoutes: true });
  if (result.warnings?.length) $('tool-hint').textContent = result.warnings.join(' ');
  if ((edited && recordHistory || result.persistRouteCache !== 'background' && result.persistRouteCache) && viewMode()) await persistView();
  // 首次打开缺路线快照时，仅保留运行时结果；不隐式写盘，也不让一个文件的派生缓存阻塞导航。
  return true;
}
const canvas = new GraphCanvas($('canvas'), {
  name, graphName,
  computeGraph: request => runGraphCompute(request),
  commitGeometry: result => commitSettledGeometry(result),
  routeError: error => showError(error),
  snapEnabled: () => true,
  blankDoubleClick: () => {
    if (definitionMode() || viewMode() || legacy || activeId === null) return;
    void addNode().catch(showError);
  },
  select: value => { selection = value; render(); },
  // 画布节点的位置只写入当前机制图或视图，绝不回写共享概念定义。
  canMove: id => !busy() && !autosave.blocked && !legacy && !definitionMode() && !!graph?.nodes.some(node => node.id === id),
  move: positions => {
    const regular = {}, scoped = {};
    for (const [id, point] of Object.entries(positions)) (isEndpointProjection(graph?.nodes.find(node => node.id === id)) ? scoped : regular)[id] = point;
    if (viewMode()) editView(data => { Object.assign(data.positions, regular); Object.assign(data.projectionPositions ??= {}, scoped); }, { keepSelection: true });
    else edit(data => { Object.assign(data.positions, regular); Object.assign(data.projectionPositions ??= {}, scoped); }, { topology: false });
  },
  zoom: value => { $('zoom').textContent = value + '%'; },
  hint: text => { $('tool-hint').textContent = text; },
  cancelLink: () => cancelLinking(),
  quickLink: id => {
    if (busy() || autosave.blocked || viewMode() || legacy || definitionMode() || isEndpointProjection(graph?.nodes.find(node => node.id === id)) || !draft?.focusNodeIds.includes(id)) return;
    setMode(relationMode(lastRelation));
    canvas.pick(id);
    selection = { type: 'linking', id }; render();
  },
  link: (source, target, relation) => {
    if (busy() || definitionMode() || viewMode() || activeId === null) return false;
    if (isEndpointProjection(graph?.nodes.find(node => node.id === source)) || isEndpointProjection(graph?.nodes.find(node => node.id === target))) {
      showError(new Error('限定概念投影只用于阅读；请从基础概念创建连线，再在连线属性中添加端点限定词。'));
      return false;
    }
    selection = null; inspect();
    void createRule(source, target, relation).catch(showError);
    return true;
  },
});
async function autoLayout({ fitView = false } = {}) {
  if (busy() || arranging || legacy || definitionMode() || !graph?.nodes?.length || autosave.blocked) return;
  const selectedIds = canvas.selectedIds();
  const positions = projection();
  // 自动排版只排显示投影：隐藏的 is-a 父概念不占位置，也不产生它的路线。
  const displayGraph = displayGraphOf(graph);
  const geometryKey = graphGeometryKey(displayGraph, positions), request = ++arrangeSequence;
  arranging = true; updateStatus();
  let committed = false;
  try {
    const result = await runGraphCompute({ kind: 'layout', geometryKey, payload: { graph: displayGraph, positions, selectedIds, cachedRoutes: [...canvas.routed] },
      isCurrent: () => graphGeometryKey(displayGraphOf(graph), projection()) === geometryKey });
    if (request !== arrangeSequence) return;
    await commitSettledGeometry(result, { recordHistory: true });
    committed = true;
    if (fitView && request === arrangeSequence) canvas.fit();
  } catch (error) {
    if (!computeCancelled(error)) throw error;
  }
  finally {
    if (request === arrangeSequence) {
      // 先结束整理状态再排入非阻塞保存：视觉提交后画布立即可继续交互。
      arranging = false; updateStatus();
      if (committed && !viewMode() && dirty()) void saveDraft({ blocking: false });
    }
  }
}
autosave = new ViewAutosave(write, body => api('/api/save', body), state => { viewState = state; updateStatus(); });

async function applyBrowsingWorkspace(opened, { restoreSourceState }) {
  let candidate = prepareOpening(opened);
  if (workspace) rememberCamera();
  workspace = opened;
  $('concept-docs').hidden = true; $('stage').hidden = false;
  cameras.clear(); implicitPositions.clear();
  sidebarState.detailViewId = null;
  sidebarState.queries.views = ''; sidebarState.queries.mechanics = ''; sidebarState.folders.clear();
  if (restoreSourceState) {
    try {
      await restoreRecentState();
      if (sidebarState.lastOpened) candidate = prepareOpening(opened, sidebarState.lastOpened);
    } catch (error) { console.warn('最近打开记录未恢复：', error); sidebarState.recentViews = []; sidebarState.recentMechanics = []; sidebarState.lastOpened = null; }
  }
  // 最近记录可能把默认机制换成视图（或反向）；模式必须与最终候选快照一起切换。
  viewId = candidate.viewId; legacy = candidate.legacy;
  sidebarState.page = viewId !== null ? 'views' : 'mechanics';
  assignLayer(candidate.activeId); assignSnapshot(candidate.snapshot); graphHistory = null;
  rememberRecent(viewId !== null ? 'view' : 'mechanic', viewId ?? candidate.activeId);
  autosave.reset(); $('startup-help').hidden = true; $('error').hidden = true;
  await render(); renderProjectTabs(); refreshReferenceProjects().catch(showError); rememberEditorTab(candidate); canvas.fit();
}

async function activateSourceProject(opened) {
  sourceProject = opened;
  browserWorkspace = opened;
  await applyBrowsingWorkspace(opened, { restoreSourceState: true });
  if (opened.workspaceState === 'degraded') {
    const files = opened.resourceDiagnostics?.map(item => `${item.path}：${item.message}`).join('\n') ?? '存在无法读取的机制资源。';
    showError(new Error(`项目已打开；以下资源被隔离，未参与编辑、查询或文档发布：\n${files}`));
  }
}

async function activateSourceNavigation(opened) {
  if (!sourceProject || opened.projectRoot.toLowerCase() !== sourceProject.projectRoot.toLowerCase()) throw new Error('不能把非源项目作为源项目会话返回');
  browserWorkspace = opened;
  await applyBrowsingWorkspace(opened, { restoreSourceState: false });
}

async function activateReferenceProject(opened) {
  if (!sourceProject) throw new Error('请先打开源项目，再进入关联项目');
  browserWorkspace = opened;
  sidebarState.detailViewId = null;
  sidebarState.queries.views = ''; sidebarState.queries.mechanics = ''; sidebarState.folders.clear();
  renderSidebar(); renderProjectTabs();
}

function pathInside(rootPath, candidatePath) {
  const clean = value => value.replace(/[\\/]+$/u, '').toLowerCase();
  const root = clean(rootPath), candidate = clean(candidatePath);
  return candidate === root || candidate.startsWith(root + (root.includes('\\') ? '\\' : '/'));
}

function relativeProjectPath(projectRoot, absolutePath) {
  if (!pathInside(projectRoot, absolutePath)) throw new Error('导出目录必须位于当前项目内');
  const root = projectRoot.replace(/[\\/]+$/u, '');
  const relative = absolutePath.slice(root.length).replace(/^[\\/]+/u, '').replace(/\\/gu, '/');
  if (!relative) throw new Error('请选择项目内的子文件夹，不能使用项目根目录');
  return relative;
}

function folderPicker({ initialPath = '', rootPath = null, selectLabel = '选择文件夹…', onSelect, onError }) {
  const root = el('div', undefined, 'folder-picker');
  const choose = button(selectLabel, async () => {
    choose.disabled = true;
    try {
      const result = await api('/api/directories/pick', { initialPath });
      if (result.cancelled || !root.isConnected) return;
      if (rootPath && !pathInside(rootPath, result.path)) throw new Error('只能选择当前项目内的文件夹');
      await onSelect(result.path);
    } catch (error) { onError?.(error); }
    finally { choose.disabled = false; }
  }, 'primary directory-select');
  root.append(choose);
  return root;
}

async function openProject() {
  if (opening || (workspace && !await guard())) return false;
  // 先呈现最近项目；原生目录选择只由“浏览文件夹”页显式触发。
  let preflight = null;
  let projectId, projectName, mode = 'recent', listRevision = 0;
  const root = el('div', undefined, 'project-dialog');
  const reportProjectError = error => { $('dialog-error').textContent = error.message; $('dialog-error').hidden = false; };
  const selectProjectPath = async projectRoot => {
    projectId = projectName = null; preflight = { projectRoot }; await draw();
  };
  const draw = async () => {
    const revision = ++listRevision; root.replaceChildren(); $('confirm-dialog').hidden = !preflight;
    if (preflight) {
      const back = button('‹ 重新选择', () => { preflight = null; mode = 'recent'; return draw().catch(reportProjectError); }, 'quiet project-back'); root.append(back);
      const card = el('div', undefined, 'project-preflight');
      card.append(el('span', '已选择项目', 'project-status'), el('strong', preflight.projectRoot), el('small', '确认后直接尝试打开；服务端会返回实际读取错误。')); root.append(card);
      $('confirm-dialog').textContent = '打开项目'; return;
    }
    const tabs = el('div', undefined, 'project-dialog-tabs');
    for (const [key, label] of [['recent', '最近项目'], ['browse', '浏览文件夹']]) {
      const tab = button(label, () => { mode = key; return draw().catch(reportProjectError); }, key === mode ? 'active' : ''); tab.setAttribute('aria-pressed', String(key === mode)); tabs.append(tab);
    }
    root.append(tabs);
    if (mode === 'recent') {
      const search = el('input'); search.type = 'search'; search.placeholder = '筛选项目名称或路径'; search.className = 'project-search'; root.append(search);
      const list = el('div', undefined, 'project-list'); root.append(list);
      const history = await api('/api/projects'); if (revision !== listRevision) return;
      const renderList = () => {
        const query = search.value.trim().toLowerCase(); list.replaceChildren();
        const items = history.items.filter(item => [item.name, item.projectRoot, item.workspaceId].some(value => String(value).toLowerCase().includes(query)));
        for (const item of items) {
          const row = el('div', undefined, 'project-history-row');
          const choose = button('', () => selectProjectPath(item.projectRoot), 'project-history-open');
          const copy = el('span'); copy.append(el('strong', item.name), el('small', item.projectRoot)); const projectIcon = el('span', undefined, 'project-history-icon'); projectIcon.append(icon(item.pinned ? 'pin' : 'project')); choose.append(projectIcon, copy);
          const pin = button(item.pinned ? '取消置顶' : '置顶', async () => { try { await api('/api/projects/pin', { projectRoot: item.projectRoot, pinned: !item.pinned }); await draw(); } catch (error) { reportProjectError(error); } }, 'quiet project-inline');
          const remove = button('移除', async () => { try { await api('/api/projects/remove', { projectRoot: item.projectRoot }); await draw(); } catch (error) { reportProjectError(error); } }, 'quiet project-inline');
          remove.title = '仅移除快捷记录，不删除项目文件'; row.append(choose, pin, remove); list.append(row);
        }
        if (!items.length) list.append(el('p', history.items.length ? '没有匹配的项目。' : '还没有最近项目，请浏览项目文件夹。', 'sidebar-empty'));
      };
      search.oninput = renderList; renderList();
      const browse = button('浏览项目文件夹…', () => { mode = 'browse'; return draw().catch(reportProjectError); }, 'project-browse-link'); root.append(browse);
    } else root.append(folderPicker({ initialPath: workspace?.projectRoot ?? '', onSelect: selectProjectPath, onError: reportProjectError }));
  };
  return dialog(workspace ? '切换项目' : '打开项目', container => { container.append(root); void draw().catch(error => { $('dialog-error').textContent = error.message; $('dialog-error').hidden = false; }); }, async () => {
    if (!preflight) return false;
    canvas.cancel(); opening = true; updateStatus();
    try {
      const opened = await api('/api/project/open', { projectRoot: preflight.projectRoot });
      await activateSourceProject(opened); return true;
    } catch (error) {
      if (error.code === 'PROJECT_SWITCH_PARTIAL') {
        const project = await api('/api/project');
        if (project.status === 'active') await activateSourceProject(await api('/api/workspace'));
      }
      throw error;
    } finally { opening = false; updateStatus(); }
  }, '打开项目');
}

async function configureProject() {
  if (!workspace || busy() || !await guard()) return false;
  let displayName, selectedPath = workspace.agentExportStatus === 'available' ? workspace.agentExportRoot : workspace.projectRoot, selectionLabel;
  const report = error => { $('dialog-error').textContent = error.message; $('dialog-error').hidden = false; };
  return dialog('项目设置', container => {
    displayName = field(container, '显示名称', workspace.manifest.name, { required: true });
    const section = el('section', undefined, 'project-folder-setting');
    section.append(el('strong', '机制文档导出目录'));
    section.append(el('p', '供 Agent 阅读的生成文档目录。请选择项目内子文件夹。', 'note'));
    selectionLabel = el('span', workspace.manifest.agentExportPath ? '当前选择：' + workspace.manifest.agentExportPath : '尚未配置导出目录', 'selected-folder'); section.append(selectionLabel);
    const publication = workspace.exportPublication;
    if (publication && publication.state !== 'current') section.append(el('p', publication.message ?? '机制文档尚未发布。请修复目录后显式生成。', 'note'));
    section.append(folderPicker({ initialPath: selectedPath, rootPath: workspace.projectRoot, selectLabel: '从项目目录选择…', onSelect: absolutePath => {
      selectedPath = absolutePath; selectionLabel.textContent = '当前选择：' + relativeProjectPath(workspace.projectRoot, absolutePath);
    }, onError: report }));
    container.append(section);
  }, async () => {
    const name = displayName.value.trim();
    if (!name) return false;
    const agentExportPath = relativeProjectPath(workspace.projectRoot, selectedPath);
    if (name === workspace.manifest.name && agentExportPath === workspace.manifest.agentExportPath) return true;
    opening = true; updateStatus();
    try {
      workspace = await api('/api/project/settings', { revision: workspace.revision, name, agentExportPath });
      renderSidebar(); $('error').hidden = true; return true;
    } finally { opening = false; updateStatus(); }
  }, '保存项目设置');
}

async function quickOpen() {
  if (!workspace || opening) return false;
  return dialog('快速打开', container => {
    $('confirm-dialog').hidden = true;
    const search = el('input'); search.type = 'search'; search.placeholder = '输入视图、机制名称、ID 或路径'; search.className = 'quick-open-search';
    const results = el('div', undefined, 'quick-open-results'); container.append(search, results);
    const draw = () => {
      const query = search.value, navigationWorkspace = { ...workspace, mechanics: workspace.mechanics.map(item => item.id === activeId && draft && !definitionMode() ? draft : item) };
      const views = buildViewNavigation(navigationWorkspace, { query, currentId: viewId, recentIds: sidebarState.recentViews });
      const mechanics = buildMechanicNavigation(navigationWorkspace, { query: query || '/', currentId: definitionMode() ? null : activeId, recentIds: sidebarState.recentMechanics });
      results.replaceChildren();
      const appendGroup = (label, items, kind) => {
        if (!items.length) return;
        results.append(el('div', label, 'quick-open-group'));
        for (const item of items.slice(0, query ? 80 : 8)) {
          const row = button('', async () => {
            $('dialog').close('ok'); rememberRecent(kind, item.id);
            if (kind === 'view') await load(item.id); else await openLayer(item.id);
          }, 'quick-open-row');
          const copy = el('span'); copy.append(el('strong', item.name), el('small', item.fullPath));
          const resultIcon = el('span', undefined, 'search-result-icon'); resultIcon.append(icon(kind === 'view' ? 'view' : 'mechanic')); row.append(resultIcon, copy); results.append(row);
        }
      };
      appendGroup('视图', views.items, 'view'); appendGroup('机制', mechanics.items, 'mechanic');
      if (!views.items.length && !mechanics.items.length) results.append(el('p', '没有匹配的视图或机制。', 'sidebar-empty'));
    };
    search.oninput = draw; draw(); queueMicrotask(() => search.focus());
  }, () => false);
}

async function load(requestedId, { reload = false, allowLegacy = false, project = workspace } = {}) {
  if (opening || (workspace && !await guard({ reload, allowLegacy }))) return false;
  if (opening) return false;
  const first = !workspace;
  canvas.cancel(); opening = true; updateStatus();
  try {
    // 读取、校验叠加与记录最近打开全部确认后，才替换当前画面和草稿。
    const sameProject = !reload && workspace?.projectSessionToken === project?.projectSessionToken;
    const candidate = await readOpening((path, body) => apiForProject(project, path, body), requestedId, sameProject ? workspace : null,
      ({ id, file }) => apiForProject(project, '/api/mechanic?projectGeneration=' + encodeURIComponent(project.projectGeneration)
        + '&id=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(file)));
    if (!first) rememberCamera();
    workspace = candidate.workspace; viewId = candidate.viewId; legacy = candidate.legacy;
    // 当前编辑项目也是左侧浏览项目时，重新读取必须同步替换目录快照。
    // 否则 Agent 新建的文件虽然已在磁盘上，却仍被旧 browserWorkspace 隐藏。
    if (browserWorkspace?.projectSessionToken === project?.projectSessionToken) browserWorkspace = candidate.workspace;
    $('concept-docs').hidden = true; $('stage').hidden = false;
    assignLayer(candidate.activeId); assignSnapshot(candidate.snapshot); graphHistory = null;
    sidebarState.lastOpened = viewId !== null ? { kind: 'view', id: viewId }
      : candidate.activeId ? { kind: 'mechanic', id: candidate.activeId } : null;
    persistRecentState();
    autosave.reset(); $('startup-help').hidden = true; $('error').hidden = true; await render(); renderProjectTabs(); refreshReferenceProjects().catch(showError); rememberEditorTab(candidate);
    // 文件打开是明确的视口定位操作：始终以当前可见节点为准，不恢复可能停在空白区域的旧相机。
    canvas.fit();
    return true;
  } catch (error) {
    if (error.code === 'SAVE_UNCERTAIN') autosave.pause(error);
    if (workspace) error.message = '打开失败；仍保留原画面和草稿，内容未刷新。\n' + error.message;
    showError(error);
    return false;
  } finally { opening = false; updateStatus(); }
}

async function refreshProjectFromDisk() {
  const browsing = browserWorkspace ?? workspace;
  if (!browsing || opening) return false;
  const sameProject = browsing.projectSessionToken === workspace?.projectSessionToken;
  // 刷新当前画布前仍沿用草稿守卫；只刷新关联项目目录时不触碰画布草稿。
  if (sameProject && !await guard({ reload: true })) return false;
  if (sameProject) {
    const requestedId = viewId ?? (legacy ? undefined : { kind: 'mechanic', id: activeId });
    return load(requestedId, { reload: true, project: browsing });
  }
  opening = true; updateStatus();
  try {
    const latest = await apiForProject(browsing, '/api/workspace');
    browserWorkspace = latest;
    renderSidebar(); renderProjectTabs(); $('error').hidden = true;
    return true;
  } finally { opening = false; updateStatus(); }
}
async function newView({ fromLegacy = false } = {}) {
  await writeQueue;
  if (!workspace || busy() || autosave.blocked || !await guard({ allowLegacy: fromLegacy })) return;
  const source = fromLegacy ? viewSnapshot() : { mechanicRegistrations: [], focusNodeIds: [], pinnedRuleIds: [], collapsedNodeIds: [], positions: {}, structuralPresentation: 'line', taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } };
  let label, id, directory;
  await dialog(fromLegacy ? '将旧叠加迁移为视图' : '新建空白视图', container => {
    label = field(container, '视图名称', '', { required: true });
    id = field(container, '稳定英文 ID', '', { required: true, pattern: '[a-z][a-z0-9]*(?:-[a-z0-9]+)*' });
    id.placeholder = 'battle-core-overview';
    const sourcePath = workspace.files.find(item => item.kind === 'view' && item.id === viewId)?.path || filePath();
    directory = field(container, '相对目录', sourcePath.split('/').slice(0, -1).join('/') || '.', { required: true });
    container.append(el('p', fromLegacy ? '旧叠加中的机制注册、可见状态与布局会写入新的视图文件。' : '创建空视图后，在视图详情中添加机制。', 'note'));
  }, async () => {
    const document = { schemaVersion: 5, kind: 'view', workspaceId: workspace.manifest.id, id: id.value, name: label.value.trim(), ...source, structuralPresentation: source.structuralPresentation ?? 'line', taxonomyPresentation: source.taxonomyPresentation ?? { mode: 'label', expandedNodeIds: [] } };
    const parent = directory.value.trim(), file = (parent === '.' ? '' : parent + '/') + document.id + '.view.json';
    opening = true; updateStatus();
    try {
      const next = await createAndRememberView(api, workspace.revision, document, file);
      const candidate = prepareOpening(next, document.id);
      rememberCamera(); workspace = next; viewId = document.id; legacy = false;
      assignLayer(null); assignSnapshot(candidate.snapshot); sidebarState.lastOpened = { kind: 'view', id: document.id }; persistRecentState(); autosave.reset(); $('error').hidden = true; await render(); canvas.fit();
    } catch (error) {
      if (['VIEW_CREATED_UNBOUND', 'SAVE_UNCERTAIN'].includes(error.code)) {
        autosave.pause(error); $('dialog').close('cancel'); showError(error); return false;
      }
      throw error;
    } finally { opening = false; updateStatus(); }
  }, '创建视图文件');
}
async function discardLegacy() {
  if (!legacy || busy()) return;
  const accepted = await dialog('放弃旧叠加记录？', container => container.append(el('p', '仅移除旧的组合选择与展示记录，不删除任何机制文件。也可以取消并点击顶部“新建视图”完成迁移。', 'note')), () => true, '放弃旧叠加');
  if (accepted) await load({ kind: 'mechanic', id: visible[0] ?? workspace.mechanics[0]?.id ?? null }, { allowLegacy: true });
}
async function enterReference(referenceId) {
  if (opening) return false;
  if (!sourceProject) throw new Error('请先打开源项目，再进入关联项目');
  // 关联入口不能改变主项目身份；保留调用前的唯一主项目上下文。
  const primary = sourceProject;
  opening = true; updateStatus();
  try {
    const opened = await api('/api/project/reference-enter', { referenceId, projectSessionToken: primary.projectSessionToken, projectGeneration: primary.projectGeneration });
    sourceProject = primary;
    await activateReferenceProject(opened); return true;
  } finally { opening = false; updateStatus(); }
}

async function openProjectRoot(projectRoot) {
  if (opening || !await guard()) return false;
  canvas.cancel(); opening = true; updateStatus();
  try {
    const opened = await api('/api/project/open', { projectRoot });
    await activateSourceProject(opened); return true;
  } finally { opening = false; updateStatus(); }
}

async function manageReferences() {
  if (!workspace || !await guard()) return;
  const source = sourceProject ?? workspace;
  const [state, history] = await Promise.all([api(`/api/project-references?projectSessionToken=${encodeURIComponent(source.projectSessionToken)}`), api('/api/projects')]);
  let selectedPath = '', path;
  await dialog('关联项目', container => {
    container.append(el('p', '这里声明当前项目可快速打开的其他 Mechanics 项目。关联不合并概念、机制或规则，也不改变任何项目的编辑权限。', 'note'));
    const list = el('div', undefined, 'detail-list');
    for (const reference of state.references) {
      const row = el('div', undefined, 'detail'); row.append(el('strong', reference.name), el('p', `${reference.id} · ${reference.workspaceId} · ${reference.status === 'ready' ? reference.projectRoot : reference.status}`));
      if (reference.status === 'ready') row.append(button('进入关联项目', async () => { await enterReference(reference.id); $('dialog').close('ok'); }, 'quiet'));
      else row.append(folderPicker({ initialPath: source.projectRoot, selectLabel: '定位目录…', onSelect: async projectRoot => { await apiAsSource('/api/project-references/bind', { referenceId: reference.id, projectRoot }); $('dialog').close('ok'); await manageReferences(); }, onError: showError }));
      list.append(row);
    }
    container.append(list);
    container.append(el('h3', '添加关联项目'));
    path = field(container, '项目目录', '', { readonly: true });
    const linkedRoots = new Set(state.references.filter(reference => reference.status === 'ready').map(reference => reference.projectRoot.toLowerCase()));
    const recent = history.items.filter(item => item.projectRoot.toLowerCase() !== source.projectRoot.toLowerCase()
      && !linkedRoots.has(item.projectRoot.toLowerCase()));
    container.append(el('h4', '最近打开项目'));
    if (recent.length) {
      const recentList = el('div', undefined, 'project-list');
      for (const item of recent) {
        const choose = button('', () => { selectedPath = item.projectRoot; path.value = item.projectRoot; }, 'project-history-open');
        const copy = el('span'); copy.append(el('strong', item.name), el('small', item.projectRoot));
        const projectIcon = el('span', undefined, 'project-history-icon'); projectIcon.append(icon(item.pinned ? 'pin' : 'project')); choose.append(projectIcon, copy);
        recentList.append(choose);
      }
      container.append(recentList);
    } else container.append(el('p', '没有可关联的最近项目。', 'sidebar-empty'));
    container.append(el('p', '也可以选择不在最近列表中的项目目录。', 'note'));
    container.append(folderPicker({ initialPath: source.projectRoot, selectLabel: '选择已有项目目录…', onSelect: projectRoot => { selectedPath = projectRoot; path.value = projectRoot; }, onError: showError }));
  }, async () => {
    if (!selectedPath) throw new Error('请选择要关联的既有项目目录');
    await apiAsSource('/api/project-references/declare', { projectRoot: selectedPath }); return true;
  }, '添加关联');
  await refreshReferenceProjects();
}

async function removeProjectReference(reference) {
  const source = sourceProject ?? workspace;
  if (!source?.projectSessionToken) throw new Error('当前没有可用的源项目会话');
  if (!referenceProjectsRevision) throw new Error('关联项目列表尚未读取完成，请稍后重试');
  if (!await guard()) return false;
  const confirmed = await dialog('移除关联项目', container => {
    container.append(el('p', `确定从当前项目移除“${reference.name}”吗？`, 'note'));
    container.append(el('p', '这只会移除当前项目的关联入口，不会删除对方项目、其中的机制、概念、规则、视图或历史记录。', 'note'));
  }, () => true, '确认移除');
  if (!confirmed) return false;

  const targetRoot = reference.projectRoot?.toLowerCase();
  const removeTabs = () => {
    if (!targetRoot) return;
    for (let index = editorTabs.length - 1; index >= 0; index--) {
      if (editorTabs[index].projectRoot?.toLowerCase() === targetRoot) editorTabs.splice(index, 1);
    }
    persistTabState(); renderEditorTabs();
  };
  const reflectRemoval = async revision => {
    referenceProjects = referenceProjects.filter(item => item.id !== reference.id);
    referenceProjectsRevision = revision ?? referenceProjectsRevision;
    removeTabs(); renderProjectTabs();
    if (targetRoot && workspace?.projectRoot?.toLowerCase() === targetRoot) await returnToSourceProject();
  };
  try {
    const result = await apiAsSource('/api/project-references/remove', { referenceId: reference.id, referencesRevision: referenceProjectsRevision });
    referenceProjects = result.references;
    referenceProjectsRevision = result.referencesRevision;
    removeTabs(); renderProjectTabs();
    if (targetRoot && workspace?.projectRoot?.toLowerCase() === targetRoot) await returnToSourceProject();
    return true;
  } catch (error) {
    if (!error.referenceRemoved) throw error;
    await reflectRemoval(error.referencesRevision);
    showError(error);
    return false;
  }
}
$('new-graph').onclick = () => newGraph().catch(showError);
$('open-project').onclick = () => openProject().catch(showError);
$('agent-export-settings').onclick = () => configureProject().catch(showError);
$('references').onclick = () => manageReferences().catch(showError);
$('toggle-references').onclick = () => { referencesCollapsed = !referencesCollapsed; saveUiPreference('mechanics:references-collapsed', referencesCollapsed); renderReferenceSection(); };
renderReferenceSection();
$('views-tab').onclick = () => { sidebarState.page = 'views'; sidebarState.detailViewId = null; renderSidebar(); };
$('mechanics-tab').onclick = () => { sidebarState.page = 'mechanics'; sidebarState.detailViewId = null; renderSidebar(); };
$('recent-tab').onclick = () => { sidebarState.page = 'recent'; sidebarState.detailViewId = null; renderSidebar(); };
const resourceTabs = ['views-tab', 'mechanics-tab', 'recent-tab'];
for (const id of resourceTabs) $(id).onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); const index = resourceTabs.indexOf(id), direction = event.key === 'ArrowRight' ? 1 : -1;
  const next = resourceTabs[(index + direction + resourceTabs.length) % resourceTabs.length]; $(next).click(); $(next).focus();
};
$('resource-search').oninput = event => { sidebarState.queries[sidebarState.page] = event.target.value; renderSidebar(); $('resource-search').focus(); };
$('resource-create').onclick = () => newGraph().catch(showError);
$('resource-create-folder').onclick = () => createMechanicFolderDialog().catch(showError);
$('new-view').onclick = () => newView({ fromLegacy: legacy }).catch(showError);
$('discard-legacy').onclick = () => discardLegacy().catch(showError);
$('table-view').onclick = () => openConcepts().catch(showError);
$('graph-view').onclick = () => resumeGraph().catch(showError);
$('docs-view').onclick = () => openDocs().catch(showError);
$('save').onclick = saveDraft;
$('copy-file-path').onclick = () => copyFilePath().catch(showError);
$('delete-mechanic').onclick = () => deleteMechanicDialog().catch(showError);
$('add-node').onclick = () => addNode().catch(showError);
$('empty-add').onclick = () => (activeId === null ? newGraph() : addNode()).catch(showError);
$('reload').onclick = () => refreshProjectFromDisk().catch(showError);
$('reload-error').onclick = () => (workspace ? refreshProjectFromDisk() : openProject()).catch(showError);
$('undo').onclick = () => undo(); $('redo').onclick = () => undo(true);
$('fit').onclick = () => canvas.fit();
$('auto-layout').onclick = () => autoLayout({ fitView: true }).catch(showError);
$('toggle-information-bar').onclick = () => {
  hoverTooltipsEnabled = !hoverTooltipsEnabled;
  saveUiPreference('mechanics:hover-tooltips-enabled', hoverTooltipsEnabled);
  canvas.setTooltipsEnabled(hoverTooltipsEnabled || hoverTooltipsTemporarilyEnabled); updateStatus();
};
$('zoom-in').onclick = () => canvas.zoom(1.2); $('zoom-out').onclick = () => canvas.zoom(1 / 1.2);
const closeSidebar = () => document.body.classList.add('sidebar-hidden');
$('toggle-sidebar').onclick = () => document.body.classList.toggle('sidebar-hidden');
$('sidebar-scrim').onclick = closeSidebar;
$('toggle-inspector').onclick = () => {
  inspectorCollapsed = !inspectorCollapsed;
  saveUiPreference('mechanics:inspector-collapsed', inspectorCollapsed); inspect();
};
$('diagnostics').onclick = () => { selection = { type: 'diagnostics' }; inspect(); };
$('dismiss-error').onclick = () => { $('error').hidden = true; };
$('close-dialog').onclick = $('cancel-dialog').onclick = () => $('dialog').close('cancel');
for (const [mode, relation] of [['positive', 1], ['negative', -1], ['random', 'random']]) {
  const control = $(mode + '-tool');
  control.onclick = () => selectRelation(relation);
  control.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    const choices = [['positive', 1], ['negative', -1], ['random', 'random']];
    const index = choices.findIndex(([key]) => key === mode);
    const target = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? choices[(index + choices.length - 1) % choices.length] : ['ArrowRight', 'ArrowDown'].includes(event.key) ? choices[(index + 1) % choices.length] : [mode, relation];
    selectRelation(target[1]); $(target[0] + '-tool').focus();
  };
}
window.addEventListener('beforeunload', event => {
  if (dirty() || conceptEditDirty || busy() || autosave.blocked || referenceSession?.commit || referenceSession?.form || referenceSession?.selected.size) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Shift' && !hoverTooltipsEnabled) {
    hoverTooltipsTemporarilyEnabled = true;
    canvas.setTooltipsEnabled(true);
  }
  if (event.key === 'Escape' && matchMedia('(max-width: 700px)').matches && !document.body.classList.contains('sidebar-hidden')) {
    closeSidebar(); $('toggle-sidebar').focus(); return;
  }
  if ($('dialog').open || opening) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); void quickOpen().catch(showError); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); document.activeElement?.blur(); void saveDraft(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && event.target.matches('input[type=checkbox][aria-label^="Agent 锁："]')) {
    event.preventDefault(); undo(event.shiftKey); return;
  }
  if (event.target.closest('input,textarea,select')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey); }
  if (event.key === 'Escape') { setMode('select'); selection = null; render(); }
  if (event.key.toLowerCase() === 'f') canvas.fit();
  if (event.key.toLowerCase() === 'v') setMode('select');
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void removeSelection().catch(showError); }
});
const restorePersistentTooltipPreference = () => {
  if (!hoverTooltipsTemporarilyEnabled) return;
  hoverTooltipsTemporarilyEnabled = false;
  canvas.setTooltipsEnabled(hoverTooltipsEnabled);
};
document.addEventListener('keyup', event => {
  if (event.key === 'Shift') restorePersistentTooltipPreference();
});
window.addEventListener('blur', restorePersistentTooltipPreference);
// 首次加载也属于打开文件：旧缓存失效后固定节点补算，并保存新版路线快照。
opening = true; updateStatus();
try {
  const project = await api('/api/project');
  if (project.status === 'active') {
    await activateSourceProject(await api('/api/workspace'));
  }
  else { opening = false; updateStatus(); await openProject(); }
} catch (error) { showError(error); }
finally { opening = false; updateStatus(); }
