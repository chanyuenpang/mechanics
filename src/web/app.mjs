import { compose, canCollapse, collapse, tracePaths, diagnose, upgradeAnalysis, downstreamNodes } from '/domain/graph.mjs';
import { GraphCanvas } from '/canvas.mjs';
import { GlossaryTable, ConceptPicker, prepareReference, ReferenceCommit, prepareConceptUpdate } from '/glossary.mjs';
import { ViewAutosave, viewSaveRequest, readOpening, createAndRememberView, graphPositions, changeViewMembers, prepareOpening } from '/view-files.mjs';

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const json = value => JSON.stringify(value);
const uid = prefix => prefix + '-' + crypto.randomUUID().slice(0, 8);
const arrow = edge => edge.relation === 'contains' ? ' ←＝→ ' : edge.sign === 1 ? ' ＋→ ' : ' −→ ';
let lastRelation = 1;
let toolPreferences = null, preferencesBusy = false;
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
function toggleWithKeyboard(event) {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); }
}
const token = new URLSearchParams(location.hash.slice(1)).get('session');
let workspace, activeId = null, draft, baseline, visible = [], folded = [], viewPositions = {};
let selection = null, graph, original, history = [], future = [], pending = 0, viewState = 'saved', writeQueue = Promise.resolve();
let screen = 'analysis', viewId = null, opening = false, autosave, legacy = false, returnView = null;
let graphHistory = null;
const cameras = new Map();
const implicitPositions = new Map();
let referenceSession = null;
let conceptEditDirty = false;
// 目录折叠和文本筛选只属于本页，不参与视图快照或文件保存。
const sidebarState = { query: '', collapsed: false, folders: new Set() };
const busy = () => opening || pending > 0;
const dirty = () => draft && json(draft) !== json(baseline);
const definitionMode = () => screen === 'concepts';
const viewMode = () => !definitionMode() && viewId !== null;
const name = id => (definitionMode() ? draft : workspace?.definitions)?.nodes.find(node => node.id === id)?.label ?? id;
const graphName = id => workspace?.analyses.find(item => item.id === id)?.name ?? id;
const filePath = () => definitionMode() ? workspace.manifest.definitions : activeId === null ? '' : workspace.files.find(item => item.kind === 'analysis' && item.id === activeId).path;
const viewSnapshot = () => ({ graphIds: [...visible], activeLayerId: null, collapsedNodeIds: [...folded], positions: clone(viewPositions) });
const contextKey = () => viewId !== null ? 'view/' + viewId : legacy ? 'legacy' : 'analysis/' + activeId;
const rememberCamera = () => { if (!definitionMode()) cameras.set(contextKey(), clone(canvas.camera)); };
const restoreCamera = () => { if (cameras.has(contextKey())) { canvas.camera = clone(cameras.get(contextKey())); canvas.transform(); } };

function showError(error) {
  const conflict = error.code === 'REVISION_CONFLICT';
  $('error-text').textContent = error.message + (conflict ? '\n其他页面保存视图也会改变版本。请重新读取；有草稿时会先提示处理，不能强制覆盖。' : '');
  $('reload-error').hidden = false;
  $('error').hidden = false;
}
async function api(path, body) {
  if (!token) throw new Error('请使用服务启动时打印的完整网址打开，网址须含本机会话片段。');
  let response, data;
  try {
    response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: json(body) } : {}),
    });
    data = await response.json();
  } catch (error) {
    const failure = new Error(body ? '连接中断或响应无法解析，写入结果待确认。草稿已保留，请重新读取磁盘核实后再操作。' : '无法读取本地服务：' + error.message);
    failure.code = body ? 'SAVE_UNCERTAIN' : 'CONNECTION_FAILED'; throw failure;
  }
  if (!response.ok) { const error = new Error(data.error + '：' + data.message); error.code = data.error; throw error; }
  return data;
}
// 所有页面写入串行执行，revision 只随已确认的自身提交更新。
function write(operation) {
  pending++; updateStatus();
  const result = writeQueue.then(async () => {
    const next = await operation(workspace.revision);
    workspace = next;
    return next;
  });
  writeQueue = result.catch(() => {});
  return result.finally(() => { pending--; updateStatus(); });
}
function updateStatus() {
  $('save').disabled = !dirty() || busy();
  $('dirty-dot').hidden = !dirty();
  $('undo').disabled = !history.length || busy() || !!autosave?.blocked;
  $('redo').disabled = !future.length || busy() || !!autosave?.blocked;
  $('positive-tool').disabled = !workspace || definitionMode() || activeId === null || busy();
  $('negative-tool').disabled = $('positive-tool').disabled;
  $('contains-tool').disabled = $('positive-tool').disabled;
  $('upgrade-notice').hidden = definitionMode() || draft?.schemaVersion !== 2 || baseline?.schemaVersion !== 1;
  $('export').disabled = !draft;
  $('save-state').textContent = legacy ? '旧记录已保留' : viewMode() ? '源研究只读' : dirty() ? '规则未保存' : '规则已保存';
  $('save').hidden = viewMode() || legacy;
  $('export').hidden = viewMode() || legacy;
  $('view-state').hidden = viewId === null || definitionMode();
  $('view-state').textContent = opening ? '正在打开…' : ({ saved: '视图已保存', saving: '视图正在保存…', failed: '视图保存失败', uncertain: '视图写入待确认' })[viewState];
  $('view-state').classList.toggle('danger', !!autosave?.blocked);
  $('export-view').hidden = !autosave?.blocked;
  $('save-view').disabled = !workspace || busy() || !!autosave?.blocked;
  $('new-graph').disabled = !workspace || busy() || legacy || !!autosave?.blocked;
  $('new-view').disabled = !workspace || busy() || !!autosave?.blocked || legacy;
  $('save-view').textContent = viewId !== null ? '另存为…' : legacy ? '保存旧叠加为视图…' : '存为视图…';
  $('save-view').title = viewId !== null ? '将当前视图另存为新文件' : '以当前研究或旧叠加新建视图';
  $('save-view').hidden = definitionMode();
  $('save-view').disabled ||= definitionMode() || (!legacy && viewId === null && activeId === null);
  $('return-view').hidden = returnView === null || viewId !== null || definitionMode();
  $('return-view').disabled = busy() || !!autosave?.blocked;
  $('legacy-notice').hidden = !legacy;
  $('add-node').disabled = activeId === null || busy();
  for (const id of ['files', 'main-views']) $(id).inert = opening;
  for (const id of ['stage', 'glossary']) $(id).inert = busy();
  for (const input of $('files').querySelectorAll('input[type=checkbox]')) input.disabled = busy() || !!autosave?.blocked;
}
async function persistView() {
  if (!viewMode() || legacy) return false;
  try {
    return await autosave.save(viewSaveRequest(workspace, viewId, viewSnapshot()));
  } catch (error) { showError(error); return false; }
}
async function saveDraft() {
  if (busy() || autosave.blocked) return false;
  if (!dirty()) return true;
  const saved = clone(draft), isDefinition = definitionMode(), id = isDefinition ? null : activeId;
  try {
    await write(revision => api('/api/save', { revision, kind: id === null ? 'definitions' : 'analysis', id, document: saved }));
    if (definitionMode() === isDefinition && (isDefinition || activeId === id)) baseline = saved;
    if (!autosave.blocked) $('error').hidden = true; render(); return true;
  } catch (error) { showError(error); return false; }
}
function edit(change, { inspect = true, refresh = true, topology = true } = {}) {
  if (!draft || busy() || viewMode() || legacy || autosave.blocked) return;
  const previous = clone(draft), next = definitionMode() ? draft : clone(draft);
  try {
    change(next);
    if (!definitionMode() && topology) compose({ ...workspace, analyses: [next] }, [next.id]);
  } catch (error) { showError(error); return false; }
  if (json(previous) === json(next)) return false;
  draft = next;
  history.push(previous); if (history.length > 80) history.shift(); future = [];
  // 拓扑改变时展开摘要；修改对象仍然是原始文件，不编辑折叠结果。
  if (!definitionMode() && topology) folded = [];
  if (refresh) render(inspect); else updateStatus();
  return true;
}
function assignSnapshot(snapshot) {
  visible = [...snapshot.graphIds]; folded = [...snapshot.collapsedNodeIds]; viewPositions = clone(snapshot.positions);
}
function editView(change, { keepSelection = false } = {}) {
  if (!viewMode() || busy() || autosave.blocked) return;
  const previous = viewSnapshot(), next = clone(previous); change(next);
  if (json(previous) === json(next)) return;
  history.push(previous); if (history.length > 80) history.shift(); future = [];
  assignSnapshot(next); if (!keepSelection) selection = null; render(); void persistView();
}
function undo(redo = false) {
  if (busy() || autosave.blocked || legacy) return;
  const from = redo ? future : history, to = redo ? history : future;
  if (!from.length) return;
  if (viewMode()) { to.push(viewSnapshot()); assignSnapshot(from.pop()); }
  else {
    to.push(clone(draft)); const next = from.pop();
    if (!definitionMode() && (json(draft.edges) !== json(next.edges) || json(draft.nodeIds) !== json(next.nodeIds))) folded = [];
    draft = !definitionMode() && baseline.schemaVersion === 2 && next.schemaVersion === 1 ? upgradeAnalysis(next) : next;
  }
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
  if (referenceSession?.commit) { showError(new Error('概念引用尚未完成。请打开「概念节点」核实写入、导出输入，或明确结束本次引用，再切换文件。')); return false; }
  if (legacy && !reload && !allowLegacy) { showError(new Error('旧叠加记录尚未处理。请先选择「保存旧叠加为视图」或「放弃旧叠加」，原记录不会自动覆盖。')); return false; }
  if (autosave.blocked && !reload) { showError(new Error(autosave.error.message + '\n视图自动保存未完成。请先导出视图草稿，再通过「重新读取」核实磁盘并处理未保存内容。')); return false; }
  if (!dirty() && !autosave.blocked) return true;
  return dialog('当前文件有未保存修改', container => {
    container.append(el('p', '请保存、放弃或取消。放弃只在目标成功打开后生效；取消或打开失败会保留草稿。', 'note'));
    if (autosave.blocked) {
      container.append(el('p', '视图保存失败或结果待确认：请先导出草稿，重新读取会使用磁盘版本。', 'note'));
      $('confirm-dialog').hidden = true;
    }
    container.append(button('放弃修改并继续', () => { $('dialog').close('ok'); }, 'danger'));
  }, saveDraft, '保存并继续');
}
function assignLayer(id) {
  canvas.cancel();
  activeId = id; screen = 'analysis';
  draft = id === null ? undefined : clone(workspace.analyses.find(item => item.id === id));
  baseline = clone(draft); history = []; future = []; selection = null;
  setMode('select');
}
async function openLayer(id) {
  if (opening) return;
  if (id === activeId && !definitionMode() && !viewMode() && !legacy) { if (id !== null) { selection = { type: 'file' }; inspect(); } return; }
  await load({ kind: 'analysis', id });
}
async function openConcepts() {
  if (!workspace || definitionMode() || !await guard()) return;
  // 工作视图切换不改变选中的分析文件，也不为打开概念表写入 lastView。
  canvas.cancel(); rememberCamera(); graphHistory = { history, future };
  screen = 'concepts'; draft = clone(workspace.definitions); baseline = clone(draft);
  history = []; future = []; selection = null; render();
}
async function resumeGraph() {
  if (!definitionMode() || !await guard()) return;
  assignLayer(activeId);
  if (viewId !== null && graphHistory) { history = graphHistory.history; future = graphHistory.future; }
  graphHistory = null; render(); restoreCamera();
}
async function toggleLayer(id, checked) {
  if (!viewMode() || busy() || autosave.blocked) { renderSidebar(); return; }
  const ids = checked ? [...new Set([...visible, id])] : visible.filter(item => item !== id);
  const next = changeViewMembers(workspace, viewSnapshot(), ids), expanded = folded.length - next.collapsedNodeIds.length;
  editView(snapshot => Object.assign(snapshot, next));
  $('tool-hint').textContent = expanded ? `已展开 ${expanded} 个失效折叠 · 可撤销本次勾选` : '已更新叠加研究 · 可撤销本次勾选';
}
function renderSidebar() {
  $('workspace-name').textContent = workspace.manifest.name;
  $('workspace-name').title = workspace.manifest.name + '\n固定保存目录：' + workspace.workspaceRoot;
  const views = $('view-files'), analyses = $('analysis-files'); views.replaceChildren(); analyses.replaceChildren();
  const files = [...workspace.files].sort((a, b) => a.path.localeCompare(b.path));
  const researchName = id => id === activeId && !definitionMode() ? draft.name : graphName(id);
  const query = sidebarState.query.trim().toLowerCase();
  const researchFiles = files.filter(file => file.kind === 'analysis');
  const matches = researchFiles.filter(file => [researchName(file.id), file.id, file.path].some(value => value.toLowerCase().includes(query)));
  $('view-file-count').textContent = workspace.views.length;
  $('analysis-file-count').textContent = query ? `${matches.length}/${researchFiles.length}` : researchFiles.length;
  $('analysis-file-count').title = query ? '匹配数量 / 研究总数' : '研究总数';
  $('selected-count').hidden = !viewMode();
  $('selected-count').textContent = `已选 ${visible.length}`;
  $('selected-count').title = '当前视图的全部成员数，不受筛选影响';
  $('analysis-body').hidden = sidebarState.collapsed;
  $('toggle-analyses').setAttribute('aria-expanded', String(!sidebarState.collapsed));
  $('analysis-chevron').textContent = sidebarState.collapsed ? '›' : '⌄';
  $('analysis-empty').hidden = matches.length > 0;
  $('analysis-empty-text').textContent = researchFiles.length ? '无匹配研究' : '暂无研究';
  $('clear-filter').hidden = !query;

  // 视图固定在上方，仍按实际路径稳定排序，不生成第二份文件清单。
  for (const file of files.filter(file => file.kind === 'view')) {
    const view = workspace.views.find(item => item.id === file.id);
    const item = el('div', undefined, 'file-row view-row' + (file.id === viewId ? ' current-view' : ''));
    const open = button('', () => load(view.id), 'file'); open.title = file.path;
    open.setAttribute('aria-label', '打开视图 ' + view.name);
    open.append(el('span', '▦', 'file-icon'), el('span', view.name, 'file-text')); item.append(open); views.append(item);
  }
  if (!workspace.views.length) views.append(el('p', '暂无视图', 'sidebar-empty'));

  // 只呈现有匹配研究的真实目录；搜索时临时展开，不覆盖用户的折叠集合。
  const folders = new Map([['', analyses]]);
  const folder = directory => {
    const parts = directory ? directory.split('/') : [];
    let current = '', parent = analyses;
    for (const part of parts) {
      current += part + '/';
      if (!folders.has(current)) {
        const key = current, children = el('div', undefined, 'tree-children');
        children.hidden = !query && sidebarState.folders.has(key);
        const toggle = button((children.hidden ? '› ' : '⌄ ') + part, () => {
          if (query) return;
          children.hidden = !children.hidden;
          if (children.hidden) sidebarState.folders.add(key); else sidebarState.folders.delete(key);
          toggle.textContent = (children.hidden ? '› ' : '⌄ ') + part;
          toggle.setAttribute('aria-expanded', String(!children.hidden));
        }, 'folder-toggle');
        toggle.title = query ? key + '（筛选时展开）' : key;
        toggle.setAttribute('aria-label', '目录 ' + key);
        toggle.setAttribute('aria-expanded', String(!children.hidden));
        toggle.setAttribute('aria-disabled', String(!!query));
        toggle.onkeydown = toggleWithKeyboard;
        parent.append(toggle, children); folders.set(current, children);
      }
      parent = folders.get(current);
    }
    return parent;
  };
  for (const file of matches) {
    const parts = file.path.split('/'); parts.pop();
    const parent = folder(parts.join('/')), id = file.id, label = researchName(id);
    const item = el('div', undefined, 'file-row' + (id === activeId && !definitionMode() ? ' active' : ''));
    const open = button('', () => openLayer(id), 'file'); open.title = file.path;
    open.setAttribute('aria-label', '打开研究 ' + label);
    open.append(el('span', '▱', 'file-icon'), el('span', label, 'file-text')); item.append(open);
    if (viewMode()) {
      const labelEl = el('label', undefined, 'visibility'), input = el('input'); input.type = 'checkbox'; input.checked = visible.includes(id);
      input.setAttribute('aria-label', '叠加研究 ' + label); input.title = '加入 / 移出当前视图'; input.disabled = busy() || autosave.blocked;
      input.onchange = () => toggleLayer(id, input.checked).catch(error => { renderSidebar(); showError(error); }); labelEl.append(input); item.append(labelEl);
    }
    parent.append(item);
  }
}
function revealNewResearch(id) {
  sidebarState.query = ''; $('analysis-filter').value = ''; sidebarState.collapsed = false;
  const path = workspace.files.find(file => file.kind === 'analysis' && file.id === id).path;
  for (const folder of sidebarState.folders) if (path.startsWith(folder)) sidebarState.folders.delete(folder);
}
function projection() {
  const data = { ...workspace,
    analyses: workspace.analyses.map(item => item.id === activeId && draft ? draft : item) };
  original = compose(data, visible); graph = original;
  for (const id of folded) graph = collapse(graph, id);
  if (!implicitPositions.has(contextKey())) implicitPositions.set(contextKey(), {});
  const fallback = implicitPositions.get(contextKey());
  const positions = graphPositions(data, original, viewPositions, activeId, fallback);
  for (const [id, point] of Object.entries(positions)) if (!fallback[id]) fallback[id] = clone(point);
  return graphPositions(data, graph, viewPositions, activeId, fallback);
}
function render(withInspector = true) {
  if (!workspace) return;
  const table = definitionMode();
  $('view-name').textContent = viewId === null ? legacy ? '旧叠加 · 待保存为视图' : '研究 · 单文件编辑' : workspace.views.find(item => item.id === viewId).name;
  $('view-name').title = viewId === null ? '点击研究只打开该文件；打开视图才可勾选叠加' : workspace.files.find(item => item.kind === 'view' && item.id === viewId).path;
  $('stage').hidden = table; $('glossary').hidden = !table;
  $('table-view').classList.toggle('active', table); $('graph-view').classList.toggle('active', !table);
  $('table-view').setAttribute('aria-pressed', String(table)); $('graph-view').setAttribute('aria-pressed', String(!table));
  if (table) {
    $('file-kind').textContent = '全局'; $('file-name').textContent = '共享概念'; $('file-name').title = filePath();
    glossary.update(draft.nodes, workspace.analyses, pending); renderSidebar(); updateStatus(); $('inspector').hidden = true; return;
  }
  try {
    const positions = projection();
    canvas.update(graph, positions, activeId, selection, definitionMode());
    $('file-kind').textContent = viewMode() ? '视图' : legacy ? '旧记录' : '研究';
    $('file-name').textContent = viewMode() ? workspace.views.find(item => item.id === viewId).name : legacy ? '待保存的叠加' : activeId === null ? '未选择研究' : draft.name;
    $('file-name').title = filePath();
    $('scope-chip').textContent = viewMode() ? '组合与布局可编辑 · 源研究只读' : legacy ? '只读预览' : '当前研究可编辑 · 手动保存';
    $('overlay-count').textContent = viewMode() || legacy ? visible.length + ' 个研究叠加' : '仅显示当前研究';
    $('counts').textContent = graph.nodes.length + ' 个节点 · ' + graph.edges.length + ' 条关系';
    $('empty').hidden = graph.nodes.length > 0;
    $('empty-title').textContent = viewMode() ? '选择要叠加的研究' : activeId === null ? '开始一张研究图' : '为这张图引用概念';
    $('empty-hint').textContent = viewMode() ? '勾选左侧研究文件，组合会自动保存到当前视图。' : activeId === null ? '选择左侧研究文件，或新建一张研究图。' : '从概念表引用节点，再连接规则。';
    $('empty-add').hidden = viewMode() || legacy;
    $('empty-add').textContent = activeId === null ? '新建分析图' : '概念节点';
    $('toolbar').hidden = legacy || (!viewMode() && activeId === null);
    $('toolbar').classList.toggle('view-tools', viewMode());
    $('add-node').hidden = viewMode(); $('positive-tool').hidden = viewMode(); $('negative-tool').hidden = viewMode(); $('contains-tool').hidden = viewMode();
    $('add-node').title = '引用已有概念到当前分析图';
    $('unfold').hidden = folded.length === 0;
    renderSidebar(); updateStatus(); if (withInspector) inspect();
  } catch (error) {
    graph = { nodes: [], edges: [] }; canvas.update(graph, {}, activeId, null, definitionMode()); showError(error);
    $('unfold').hidden = folded.length === 0;
  }
}
function inspect() {
  const panel = $('properties'); panel.replaceChildren(); $('inspector').hidden = !selection;
  if (!selection) return;
  if (selection.type === 'nodes') {
    $('inspector-title').textContent = `已选择 ${selection.ids.length} 个节点`;
    detail(panel, '选中节点', selection.ids.map(name).join('、'));
    panel.append(el('p', '拖动任一选中节点可整体移动；Shift 单击增减成员，Esc 清空选择。一次撤销恢复整组位置。', 'note'));
    return;
  }
  if (selection.type === 'file') {
    if (!draft || definitionMode()) { $('inspector').hidden = true; return; }
    $('inspector-title').textContent = '研究属性';
    detail(panel, '保存文件', filePath());
    field(panel, '研究名称', draft.name, { onChange: value => edit(data => { data.name = value; }, { inspect: false }) });
    field(panel, '分析范围', draft.scope, { multiline: true, onChange: value => edit(data => { data.scope = value; }, { inspect: false }) });
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
    $('inspector-title').textContent = edge.hiddenNodes.length ? '折叠关系 · 只读摘要' : edge.relation === 'contains' ? '包含关系' : '因果关系';
    detail(panel, '影响方向', name(edge.source) + arrow(edge) + name(edge.target));
    if (edge.relation === 'contains') detail(panel, '包含语义', '宏观影响可双向传递，＝不改变路径正负号；不推断具体效果或数值。');
    const owned = edge.steps.length === 1 && edge.steps[0].graphId === activeId;
    if (owned) {
      const id = edge.steps[0].edgeId, originalEdge = draft.edges.find(item => item.id === id);
      field(panel, '关系', originalEdge.relation === 'contains' ? 'contains' : String(originalEdge.sign), {
        options: [['1', '＋ 促进'], ['-1', '− 抑制'], ['contains', '＝ 包含（双向传递）']],
        onChange: value => {
          const changed = edit(data => {
            if (value === 'contains') Object.assign(data, upgradeAnalysis(data));
            const item = data.edges.find(item => item.id === id);
            if (value === 'contains') { item.relation = 'contains'; delete item.sign; }
            else { item.sign = Number(value); if (data.schemaVersion === 2) item.relation = 'influence'; }
          });
          if (changed) lastRelation = value === 'contains' ? value : Number(value);
          else inspect();
        },
      });
      for (const [key, label] of [['condition', '机制条件（可选）'], ['note', '规则说明（可选）']]) field(panel, label, originalEdge[key], { multiline: true, onChange: value => {
        if (edit(data => { data.edges.find(item => item.id === id)[key] = value; }, { inspect: false })) lastRelation = originalEdge.relation === 'contains' ? 'contains' : originalEdge.sign;
      } });
      panel.append(button('删除此连线', () => removeSelection(), 'danger'));
    } else panel.append(el('p', '视图中的源规则与折叠摘要只读。编辑源研究后，可返回当前视图。', 'note'));
    edge.steps.forEach(step => {
      detail(panel, graphName(step.graphId) + ' / ' + step.edgeId, name(step.source) + arrow(step) + name(step.target) + '\n' + (step.condition || '未补充条件') + '\n' + step.note);
      if (step.graphId !== activeId) panel.append(button('编辑源研究：' + graphName(step.graphId), () => openLayer(step.graphId)));
    });
    return;
  }
  const node = workspace.definitions.nodes.find(item => item.id === selection.id);
  if (!node) { $('inspector').hidden = true; return; }
  $('inspector-title').textContent = '节点属性';
  detail(panel, node.label, node.description); detail(panel, '增加方向', node.increaseMeaning);
  if (!legacy) panel.append(button('修改概念', () => editConcept(node.id)));
  if (draft && !draft.nodeIds.includes(node.id)) panel.append(button('引用到当前图层', () => edit(data => { data.nodeIds.push(node.id); })));
  detail(panel, '稳定 ID', node.id);
  const owners = workspace.analyses.filter(item => item.nodeIds.includes(node.id)).map(item => item.name);
  detail(panel, '引用图层', owners.join('、') || '尚未引用');
  if (viewMode()) for (const source of workspace.analyses.filter(item => visible.includes(item.id) && item.nodeIds.includes(node.id))) {
    panel.append(button('编辑源研究：' + source.name, () => openLayer(source.id)));
  }
  const actions = el('div', undefined, 'property-actions');
  if (!legacy && !dirty() && canCollapse(graph, node.id)) actions.append(button('折叠节点', () => {
    if (viewMode()) editView(snapshot => { snapshot.collapsedNodeIds.push(node.id); });
    else { folded.push(node.id); selection = null; render(); }
  }));
  if (draft?.nodeIds.includes(node.id)) actions.append(button('移出当前图层', removeSelection, 'danger'));
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
      const positive = result.paths.filter(path => path.sign === 1).length;
      const negative = result.paths.filter(path => path.sign === -1).length;
      const neutral = result.paths.length - positive - negative;
      const kind = positive && negative ? 'mixed' : positive ? 'positive' : negative ? 'negative' : 'neutral';
      const conclusion = positive && negative ? '促进与抑制路径并存' : positive ? '存在促进影响' : negative ? '存在抑制影响' : neutral ? '仅找到等号关联' : '未找到影响路径';
      const card = el('div', undefined, 'trace-conclusion ' + kind);
      card.append(el('span', result.truncated ? '已找到的路径 · 结果不完整' : '当前模型结论', 'trace-eyebrow'),
        el('strong', conclusion, 'trace-verdict'), el('p', name(node.id) + ' → ' + name(target.value), 'trace-endpoints'));
      if (result.paths.length) card.append(el('p', [positive && `${positive} 条促进`, negative && `${negative} 条抑制`, neutral && `${neutral} 条等号关联`].filter(Boolean).join(' · '), 'trace-count'));
      if (kind === 'mixed') card.append(el('p', '不能合并为单一正负结论，也不相互抵消。', 'trace-caution'));
      if (neutral && !positive && !negative) card.append(el('p', '等号不改变符号，本身不产生促进或抑制。', 'trace-caution'));
      output.replaceChildren(card);
      if (result.truncated) output.append(el('p', '已达到查询上限，尚未列出的路径可能包含其他影响方向。', 'trace-warning'));
      result.paths.forEach((path, index) => {
        const item = el('div', undefined, 'trace-evidence');
        item.append(el('strong', `路径 ${index + 1} · ` + (path.sign === 1 ? '促进' : path.sign === -1 ? '抑制' : '等号关联')));
        item.append(el('p', name(node.id) + path.steps.map(step => arrow(step) + name(step.traversalTarget ?? step.target)).join(''), 'trace-chain'));
        const details = el('details'); details.append(el('summary', '查看来源与规则说明'));
        details.append(el('div', path.steps.map(step => name(step.traversalSource ?? step.source) + arrow(step) + name(step.traversalTarget ?? step.target) + '\n来源：' + graphName(step.graphId) + ' / ' + step.edgeId
          + (step.condition ? '\n条件：' + step.condition : '') + (step.note ? '\n说明：' + step.note : '')).join('\n\n'), 'trace-path'));
        item.append(details); output.append(item);
      });
      output.append(el('p', result.interpretation, 'note trace-limits'));
      card.scrollIntoView({ block: 'nearest' });
    }), output);
  }
}
async function editConcept(id) {
  await writeQueue;
  if (!workspace || busy() || definitionMode() || legacy || autosave.blocked) return;
  if (referenceSession?.commit) throw new Error('请先处理尚未完成的概念引用。');
  const node = workspace.definitions.nodes.find(item => item.id === id);
  if (!node) throw new Error('概念已不存在，请重新读取。');
  let fields, inputs, exportButton, blocked = false;
  const values = () => Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
  try {
    await dialog('修改概念', container => {
      fields = el('fieldset'); fields.className = 'concept-picker-fields'; container.append(fields);
      inputs = Object.fromEntries([['label', '名称'], ['description', '概念含义'], ['increaseMeaning', '增加方向']].map(([key, label]) => {
        const input = field(fields, label, node[key], { required: true, multiline: key !== 'label', onChange: () => { conceptEditDirty = true; } });
        input.maxLength = 8000; return [key, input];
      }));
      container.onkeydown = event => { if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault(); };
      container.append(el('p', '保存到共享概念表，所有引用此概念的研究都会更新；当前研究草稿不受影响。', 'note'));
      exportButton = button('导出概念修改', () => download({ kind: 'concept-edit-draft', id, ...values() }, id + '.concept-edit.draft.json'));
      exportButton.hidden = true; container.append(exportButton);
      queueMicrotask(() => inputs.label.focus());
    }, async () => {
      if (blocked) throw new Error('请先导出修改，关闭窗口并重新读取磁盘核实。');
      const document = prepareConceptUpdate(workspace.definitions, id, values());
      if (json(document) === json(workspace.definitions)) return;
      fields.disabled = true;
      try {
        await write(revision => api('/api/save', { revision, kind: 'definitions', document }));
      } catch (error) {
        blocked = ['REVISION_CONFLICT', 'SAVE_UNCERTAIN'].includes(error.code);
        exportButton.hidden = false;
        if (blocked) error.message += '\n请导出概念修改，关闭窗口后重新读取磁盘核实；不会自动覆盖或重复提交。';
        throw error;
      } finally { fields.disabled = false; }
      conceptEditDirty = false; render();
    }, '保存概念', { settled: () => { $('confirm-dialog').disabled = blocked; } });
  } finally { conceptEditDirty = false; $('dialog-content').onkeydown = null; }
}
async function removeSelection() {
  if (!selection || busy() || viewMode() || legacy || autosave.blocked) return;
  if (selection.type === 'edge') {
    const edge = graph.edges.find(item => item.id === selection.id);
    if (edge?.steps.length !== 1 || edge.steps[0].graphId !== activeId) return;
    const id = edge.steps[0].edgeId; selection = null; edit(data => { data.edges = data.edges.filter(item => item.id !== id); }); return;
  }
  if (selection.type !== 'node') return;
  const id = selection.id;
  if (definitionMode()) {
    const owners = workspace.analyses.filter(item => item.nodeIds.includes(id));
    if (owners.length) throw new Error('节点仍被以下图层引用，不能删除定义：' + owners.map(item => item.name).join('、'));
  } else if (!draft?.nodeIds.includes(id)) return;
  const accepted = await dialog(definitionMode() ? '删除节点定义？' : '移出当前图层？', container => {
    container.append(el('p', definitionMode() ? '删除 ' + name(id) + ' 的共享定义。保存前可以撤销。' : '移除 ' + name(id) + ' 以及当前图层中连接它的关系。其他图层和共享定义不变。', 'note'));
    if (!definitionMode()) {
      const affected = workspace.views.filter(view => view.graphIds.includes(activeId) && (view.positions[id] || view.collapsedNodeIds.includes(id))
        && !workspace.analyses.some(item => item.id !== activeId && view.graphIds.includes(item.id) && item.nodeIds.includes(id)));
      if (affected.length) container.append(el('p', '以下视图仍保存此节点的位置或折叠，必须先在视图中处理引用，否则保存会被拒绝：' + affected.map(item => item.name).join('、'), 'danger'));
    }
  }, () => true, '确认移除');
  if (!accepted) return;
  selection = null;
  edit(data => {
    if (definitionMode()) data.nodes = data.nodes.filter(item => item.id !== id);
    else { data.nodeIds = data.nodeIds.filter(item => item !== id); data.edges = data.edges.filter(item => item.source !== id && item.target !== id); }
    delete data.positions[id];
  });
}
async function addNode() {
  if (!workspace || busy() || $('dialog').open) return;
  if (definitionMode()) { addTerm(); return; }
  if (activeId === null || viewMode() || legacy || autosave.blocked) return;
  setMode('select');
  referenceSession ??= { targetId: activeId, query: '', selected: new Set(), candidates: [], form: null, commit: null };
  const session = referenceSession; let picker;
  $('dialog').classList.add('concept-dialog');
  try {
    await dialog('概念节点', container => {
      picker = new ConceptPicker(container, session, workspace.definitions, draft.nodeIds, {
        status: (text, enabled) => { $('confirm-dialog').textContent = text; $('confirm-dialog').disabled = !enabled; },
        exportInputs: () => download({ kind: 'concept-reference-draft', analysis: clone(draft), selectedIds: [...session.selected], candidates: session.candidates, form: session.form, phase: session.commit?.phase, plannedReference: session.commit?.plan.analysis }, session.targetId + '.concept-reference.draft.json'),
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
        const data = { ...workspace, analyses: [draft] }, source = compose(data, [activeId]);
        session.commit = new ReferenceCommit(prepareReference({ workspace, draft, selected: [...session.selected],
          candidates: session.candidates.filter(node => session.selected.has(node.id)),
          positions: graphPositions(data, source, {}, activeId, implicitPositions.get(contextKey())), center: canvas.center() }));
      }
      const committing = session.commit.run(document => write(revision => api('/api/save', { revision, kind: 'definitions', document })), next => {
        if (activeId !== session.targetId || definitionMode() || viewMode() || json(draft) !== json(session.sourceDraft)) throw new Error('当前研究草稿已改变，请先导出并核实。');
        return edit(data => { Object.assign(data, next); });
      });
      picker.updateStatus(); await committing;
      selection = session.commit.plan.additions.length === 1 ? { type: 'node', id: session.commit.plan.additions[0] } : { type: 'nodes', ids: session.commit.plan.additions };
      referenceSession = null; render();
      $('tool-hint').textContent = `已引用 ${session.commit.plan.additions.length} 个概念${session.commit.plan.candidates.length ? `，其中新建 ${session.commit.plan.candidates.length} 个` : ''}`;
    }, '添加节点', { settled: () => picker.updateStatus() });
  } finally {
    $('dialog').classList.remove('concept-dialog'); $('dialog-content').onkeydown = null;
    if (!session.commit) referenceSession = null;
  }
}
async function newGraph() {
  if (!workspace || !await guard()) return;
  let label, id, scope, directory;
  await dialog('新建研究', container => {
    label = field(container, '研究名称', '', { required: true });
    id = field(container, '文件 ID', uid('graph'), { required: true, pattern: '[a-z][a-z0-9._-]{0,95}' });
    scope = field(container, '分析范围', '', { multiline: true, required: true });
    directory = field(container, '相对目录', 'analyses', { required: true });
    directory.setAttribute('list', 'workspace-directories');
    const choices = el('datalist'); choices.id = 'workspace-directories';
    for (const path of ['.', ...workspace.directories]) { const option = el('option'); option.value = path; choices.append(option); }
    container.append(choices, el('p', '保存为 <相对目录>/<ID>.analysis.json。支持中文和多层目录；填 . 表示工作区根。', 'note'));
  }, async () => {
    const document = { schemaVersion: 2, kind: 'analysis', workspaceId: workspace.manifest.id, id: id.value, name: label.value.trim(), scope: scope.value.trim(), nodeIds: [], edges: [], positions: {} };
    const parent = directory.value.trim(), file = (parent === '.' ? '' : parent + '/') + document.id + '.analysis.json';
    await write(revision => api('/api/analyses', { revision, document, file }));
    // 新文件已存在后，打开失败不能自动重复创建。
    const sourceView = viewId;
    try {
      const candidate = await readOpening(api, { kind: 'analysis', id: document.id });
      rememberCamera(); workspace = candidate.workspace; viewId = null; legacy = false;
      if (sourceView !== null) returnView = sourceView;
      assignLayer(document.id); assignSnapshot(candidate.snapshot); autosave.reset(); revealNewResearch(document.id); render(); restoreCamera();
    } catch (error) {
      $('dialog').close('cancel'); showError(new Error('研究文件已创建：' + file + '，但打开未完成。请重新读取，不要重复创建。\n' + error.message));
    }
  }, '创建文件');
}
function setMode(mode) {
  if ((viewId !== null || legacy) && mode !== 'select') return;
  if (!definitionMode() || mode === 'select') {
    canvas.setMode(mode);
    for (const key of ['select', 'positive', 'negative', 'contains']) $(key + '-tool').classList.toggle('active', key === mode);
    $('tool-hint').textContent = legacy ? '旧叠加只读 · 左键框选 · 右键平移' : mode === 'select' ? '左键框选 · 右键平移 · 双击节点连线 · Shift 增选' : mode === 'contains' ? '依次选择两个节点 · ＝双向传递，不改变正负号' : '先点击影响源，再点击受影响节点 · 写入当前研究';
  }
}
function addTerm() {
  if (!workspace || !definitionMode() || busy()) return;
  const id = uid('node');
  edit(data => { data.nodes.push({ id, label: '', description: '', increaseMeaning: '' }); });
  glossary.focusNode(id);
}
const glossary = new GlossaryTable($('glossary'), {
  change: (id, key, value) => edit(data => { data.nodes.find(node => node.id === id)[key] = value; }, { refresh: false }),
  add: addTerm,
  remove: id => { selection = { type: 'node', id }; void removeSelection().catch(showError); },
  locate: id => {
    const owners = workspace.analyses.filter(item => item.nodeIds.includes(id));
    const target = owners.find(item => item.id === activeId) ?? owners.find(item => visible.includes(item.id)) ?? owners[0];
    if (!target) return;
    void openLayer(target.id).then(() => {
      if (definitionMode() || activeId !== target.id) return;
      if (folded.includes(id)) { folded = []; void persistView(); }
      selection = { type: 'node', id }; render(); canvas.fit();
    }).catch(showError);
  },
});
const canvas = new GraphCanvas($('canvas'), {
  name, graphName,
  snapEnabled: () => toolPreferences?.snapToGrid === true,
  blankDoubleClick: () => {
    if (definitionMode() || viewMode() || legacy || activeId === null) return;
    void addNode().catch(showError);
  },
  select: value => { selection = value; render(); },
  canMove: id => toolPreferences !== null && !preferencesBusy && !busy() && !autosave.blocked && !legacy && !definitionMode() && (viewMode() || !!draft?.nodeIds.includes(id)),
  move: positions => viewMode() ? editView(data => { Object.assign(data.positions, positions); }, { keepSelection: true }) : edit(data => { Object.assign(data.positions, positions); }, { topology: false }),
  zoom: value => { $('zoom').textContent = value + '%'; },
  hint: text => { $('tool-hint').textContent = text; },
  quickLink: id => {
    if (busy() || autosave.blocked || viewMode() || legacy || definitionMode() || !draft?.nodeIds.includes(id)) return;
    setMode(lastRelation === 'contains' ? 'contains' : lastRelation === 1 ? 'positive' : 'negative');
    canvas.pick(id);
  },
  link: (source, target, sign) => {
    if (busy() || definitionMode() || activeId === null) return;
    if (!draft.nodeIds.includes(source) || !draft.nodeIds.includes(target)) { showError(new Error('请先把两个节点引用到当前图层，再建立此图层的关系。')); return; }
    const id = uid('edge');
    const changed = edit(data => {
      if (sign === 'contains') Object.assign(data, upgradeAnalysis(data));
      data.edges.push({ id, source, target, ...(sign === 'contains' ? { relation: 'contains' } : { sign, ...(data.schemaVersion === 2 ? { relation: 'influence' } : {}) }), condition: '', note: '' });
    });
    if (changed) { lastRelation = sign; setMode('select'); selection = { type: 'edge', id: activeId + '/' + id }; render(); }
    return changed;
  },
});
autosave = new ViewAutosave(write, body => api('/api/save', body), state => { viewState = state; updateStatus(); });
async function load(requestedId, { reload = false, allowLegacy = false } = {}) {
  if (opening || (workspace && !await guard({ reload, allowLegacy }))) return false;
  if (opening) return false;
  const first = !workspace, sourceView = viewId, previousReturn = returnView;
  canvas.cancel(); opening = true; updateStatus();
  try {
    // 读取、校验叠加与记录最近打开全部确认后，才替换当前画面和草稿。
    let candidate;
    try { candidate = await readOpening(api, requestedId); }
    catch (error) {
      if (error.code !== 'FOLD_REPAIR_REQUIRED') throw error;
      const accepted = await dialog('源研究改变，折叠需要展开', container => {
        container.append(el('p', error.message, 'note'), el('p', '确认后只展开失效折叠并保存此视图，保留叠加关系和位置；取消则留在当前文件。', 'note'));
      }, () => true, '展开并打开视图');
      if (!accepted) return false;
      candidate = await readOpening(api, error.viewId, { repairFolds: true });
    }
    if (!first) rememberCamera();
    workspace = candidate.workspace; viewId = candidate.viewId; legacy = candidate.legacy;
    returnView = viewId !== null ? null : sourceView ?? previousReturn;
    assignLayer(candidate.activeId); assignSnapshot(candidate.snapshot); graphHistory = null;
    autosave.reset(); $('startup-help').hidden = true; $('error').hidden = true; render();
    if (first) canvas.fit(); else restoreCamera();
    return true;
  } catch (error) {
    if (error.code === 'SAVE_UNCERTAIN') autosave.pause(error);
    if (workspace) error.message = '打开失败；仍保留原画面和草稿，内容未刷新。\n' + error.message;
    showError(error);
    return false;
  } finally { opening = false; updateStatus(); }
}
async function newView({ empty = false } = {}) {
  await writeQueue;
  if (!workspace || busy() || autosave.blocked || !await guard({ allowLegacy: !empty })) return;
  const source = empty ? { graphIds: [], activeLayerId: null, collapsedNodeIds: [], positions: {} }
    : viewId !== null || legacy ? viewSnapshot()
      : { graphIds: activeId === null ? [] : [activeId], activeLayerId: null, collapsedNodeIds: [], positions: graphPositions(workspace, compose(workspace, activeId === null ? [] : [activeId]), {}, activeId) };
  let label, id, directory;
  await dialog(empty ? '新建空白视图' : viewId !== null ? '视图另存为' : '保存为视图文件', container => {
    label = field(container, '视图名称', '', { required: true });
    id = field(container, '文件 ID', uid('view'), { required: true, pattern: '[a-z][a-z0-9._-]{0,95}' });
    const sourcePath = workspace.files.find(item => item.kind === 'view' && item.id === viewId)?.path || filePath();
    directory = field(container, '相对目录', sourcePath.split('/').slice(0, -1).join('/') || '.', { required: true });
    container.append(el('p', empty ? '创建空视图后，勾选研究进行叠加。' : '保存研究选择、布局与折叠为 <目录>/<ID>.view.json。视图自动保存，源研究只读。', 'note'));
  }, async () => {
    const document = { schemaVersion: 1, kind: 'view', workspaceId: workspace.manifest.id, id: id.value, name: label.value.trim(), ...source };
    const parent = directory.value.trim(), file = (parent === '.' ? '' : parent + '/') + document.id + '.view.json';
    opening = true; updateStatus();
    try {
      const next = await createAndRememberView(api, workspace.revision, document, file);
      const candidate = prepareOpening(next, document.id);
      rememberCamera(); workspace = next; viewId = document.id; legacy = false; returnView = null;
      assignLayer(null); assignSnapshot(candidate.snapshot); autosave.reset(); $('error').hidden = true; render();
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
  const accepted = await dialog('放弃旧叠加记录？', container => container.append(el('p', '仅移除旧的组合选择与展示记录，不删除任何研究文件。也可以取消并保存为视图。', 'note')), () => true, '放弃旧叠加');
  if (accepted) await load({ kind: 'analysis', id: visible[0] ?? workspace.analyses[0]?.id ?? null }, { allowLegacy: true });
}
$('new-graph').onclick = () => newGraph().catch(showError);
$('analysis-filter').oninput = event => { sidebarState.query = event.target.value; renderSidebar(); };
$('clear-filter').onclick = () => { sidebarState.query = ''; $('analysis-filter').value = ''; renderSidebar(); $('analysis-filter').focus(); };
$('toggle-analyses').onclick = () => { sidebarState.collapsed = !sidebarState.collapsed; renderSidebar(); };
$('toggle-analyses').onkeydown = toggleWithKeyboard;
$('save-view').onclick = () => newView().catch(showError);
$('new-view').onclick = () => newView({ empty: true }).catch(showError);
$('return-view').onclick = () => load(returnView).catch(showError);
$('discard-legacy').onclick = () => discardLegacy().catch(showError);
$('table-view').onclick = () => openConcepts().catch(showError);
$('graph-view').onclick = () => resumeGraph().catch(showError);
$('save').onclick = saveDraft;
$('add-node').onclick = () => addNode().catch(showError);
$('empty-add').onclick = () => (activeId === null ? newGraph() : addNode()).catch(showError);
$('reload').onclick = () => load(viewId ?? (legacy ? undefined : { kind: 'analysis', id: activeId }), { reload: true }).catch(showError);
$('reload-error').onclick = $('reload').onclick;
$('undo').onclick = () => undo(); $('redo').onclick = () => undo(true);
$('fit').onclick = () => canvas.fit();
$('zoom-in').onclick = () => canvas.zoom(1.2); $('zoom-out').onclick = () => canvas.zoom(1 / 1.2);
$('toggle-sidebar').onclick = () => document.body.classList.toggle('sidebar-hidden');
$('close-inspector').onclick = () => { selection = null; render(); };
$('diagnostics').onclick = () => { selection = { type: 'diagnostics' }; inspect(); };
$('unfold').onclick = () => {
  if (legacy || busy()) return;
  if (viewMode()) editView(snapshot => { snapshot.collapsedNodeIds = []; });
  else { folded = []; render(); }
};
$('dismiss-error').onclick = () => { $('error').hidden = true; };
$('close-dialog').onclick = $('cancel-dialog').onclick = () => $('dialog').close('cancel');
for (const mode of ['select', 'positive', 'negative', 'contains']) $(mode + '-tool').onclick = () => setMode(mode);
function download(document, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2) + '\n'], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').onclick = () => {
  if (draft) download(draft, (definitionMode() ? 'definitions' : activeId) + (dirty() ? '.draft' : '') + '.json');
};
$('export-view').onclick = () => {
  if (workspace) download(viewSaveRequest(workspace, viewId, viewSnapshot()).document, (viewId ?? 'workspace') + (viewId === null ? '.draft.json' : '.view.draft.json'));
};
window.addEventListener('beforeunload', event => {
  if (dirty() || conceptEditDirty || busy() || autosave.blocked || referenceSession?.commit || referenceSession?.form || referenceSession?.selected.size) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('keydown', event => {
  if ($('dialog').open || opening) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); document.activeElement?.blur(); void saveDraft(); return; }
  if (event.target.closest('input,textarea,select')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey); }
  if (event.key === 'Escape') { setMode('select'); selection = null; render(); }
  if (event.key.toLowerCase() === 'f') canvas.fit();
  if (event.key.toLowerCase() === 'v') setMode('select');
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void removeSelection().catch(showError); }
});
function showPreferences() {
  $('snap-grid').disabled = preferencesBusy;
  $('snap-grid').setAttribute('aria-pressed', String(toolPreferences?.snapToGrid === true));
  $('snap-grid').textContent = toolPreferences === null ? '重读吸附设置' : toolPreferences.snapToGrid ? '5px 吸附 · 开' : '5px 吸附 · 关';
}
async function refreshPreferences() {
  if (preferencesBusy) return;
  preferencesBusy = true; showPreferences();
  try { toolPreferences = await api('/api/preferences'); }
  catch (error) { toolPreferences = null; showError(error); }
  finally { preferencesBusy = false; showPreferences(); }
}
$('snap-grid').onclick = async () => {
  if (toolPreferences === null) { await refreshPreferences(); return; }
  canvas.cancel(); preferencesBusy = true; showPreferences();
  try { toolPreferences = await api('/api/preferences', { version: 1, snapToGrid: !toolPreferences.snapToGrid }); }
  catch (error) { toolPreferences = null; showError(error); }
  finally { preferencesBusy = false; showPreferences(); }
};
window.addEventListener('focus', () => { void refreshPreferences(); });
await load();
await refreshPreferences();
