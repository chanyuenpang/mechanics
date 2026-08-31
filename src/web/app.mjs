import { compose, canCollapse, collapse, tracePaths, diagnose } from '/domain/graph.mjs';
import { GraphCanvas } from '/canvas.mjs';
import { GlossaryTable } from '/glossary.mjs';
import { ViewAutosave, viewSaveRequest, readOpening, createAndRememberView } from '/view-files.mjs';

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const json = value => JSON.stringify(value);
const uid = prefix => prefix + '-' + crypto.randomUUID().slice(0, 8);
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
const token = new URLSearchParams(location.hash.slice(1)).get('session');
let workspace, activeId = null, draft, baseline, visible = [], folded = [], viewPositions = {};
let selection = null, graph, original, history = [], future = [], pending = 0, viewState = 'saved', writeQueue = Promise.resolve();
let screen = 'analysis', viewId = null, opening = false, autosave;
const busy = () => opening || pending > 0;
const dirty = () => draft && json(draft) !== json(baseline);
const definitionMode = () => screen === 'concepts';
const name = id => (definitionMode() ? draft : workspace?.definitions)?.nodes.find(node => node.id === id)?.label ?? id;
const graphName = id => workspace?.analyses.find(item => item.id === id)?.name ?? id;
const filePath = () => definitionMode() ? workspace.manifest.definitions : activeId === null ? '' : workspace.files.find(item => item.kind === 'analysis' && item.id === activeId).path;
const viewSnapshot = () => ({ graphIds: [...visible], activeLayerId: activeId, collapsedNodeIds: [...folded], positions: clone(viewPositions) });

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
  $('undo').disabled = !history.length || busy();
  $('redo').disabled = !future.length || busy();
  $('positive-tool').disabled = !workspace || definitionMode() || activeId === null || busy();
  $('negative-tool').disabled = $('positive-tool').disabled;
  $('export').disabled = !draft;
  $('save-state').textContent = dirty() ? '规则未保存' : '规则已保存';
  $('view-state').textContent = opening ? '正在打开…' : ({ saved: '视图已保存', saving: '视图正在保存…', failed: '视图保存失败', uncertain: '视图写入待确认' })[viewState];
  $('view-state').classList.toggle('danger', !!autosave?.blocked);
  $('export-view').hidden = !autosave?.blocked;
  $('save-view').disabled = !workspace || busy() || !!autosave?.blocked;
  $('new-graph').disabled = !workspace || busy();
  $('leave-view').hidden = viewId === null;
  $('leave-view').disabled = busy() || !!autosave?.blocked;
  for (const id of ['files', 'stage', 'glossary', 'main-views']) $(id).inert = opening;
}
async function persistView() {
  try {
    return await autosave.save(viewSaveRequest(workspace, viewId, viewSnapshot()));
  } catch (error) { showError(error); return false; }
}
async function saveDraft() {
  if (opening) return false;
  if (!dirty()) return true;
  const saved = clone(draft), isDefinition = definitionMode(), id = isDefinition ? null : activeId;
  try {
    await write(revision => api('/api/save', { revision, kind: id === null ? 'definitions' : 'analysis', id, document: saved }));
    if (definitionMode() === isDefinition && (isDefinition || activeId === id)) baseline = saved;
    if (!autosave.blocked) $('error').hidden = true; render(); return true;
  } catch (error) { showError(error); return false; }
}
function edit(change, { inspect = true, refresh = true } = {}) {
  if (!draft || opening) return;
  const previous = clone(draft); change(draft);
  if (json(previous) === json(draft)) return;
  history.push(previous); if (history.length > 80) history.shift(); future = [];
  // 拓扑改变时展开摘要；修改对象仍然是原始文件，不编辑折叠结果。
  const hadFold = !definitionMode() && (folded.length > 0 || Object.keys(viewPositions).length > 0);
  if (!definitionMode()) { folded = []; viewPositions = {}; }
  if (refresh) render(inspect); else updateStatus();
  if (hadFold) void persistView();
}
function undo(redo = false) {
  if (busy()) return;
  const from = redo ? future : history, to = redo ? history : future;
  if (!from.length) return;
  to.push(clone(draft)); draft = from.pop(); selection = null;
  if (!definitionMode()) { folded = []; viewPositions = {}; }
  render(); if (!definitionMode()) void persistView();
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
async function dialog(title, build, submit, confirmText = '确定') {
  $('dialog-title').textContent = title; $('dialog-content').replaceChildren(); $('dialog-error').hidden = true;
  $('confirm-dialog').textContent = confirmText; $('confirm-dialog').disabled = false; $('confirm-dialog').hidden = false;
  build($('dialog-content'));
  return new Promise(resolve => {
    const modal = $('dialog'); modal.returnValue = '';
    modal.onclose = () => resolve(modal.returnValue === 'ok');
    $('dialog-form').onsubmit = async event => {
      event.preventDefault(); $('confirm-dialog').disabled = true; $('dialog-error').hidden = true;
      try { if (await submit() !== false) modal.close('ok'); }
      catch (error) { $('dialog-error').textContent = error.message; $('dialog-error').hidden = false; }
      finally { $('confirm-dialog').disabled = false; }
    };
    modal.showModal();
  });
}
async function guard({ reload = false } = {}) {
  await writeQueue;
  if (opening) return false;
  if (autosave.blocked && !reload) { showError(new Error('视图自动保存未完成。请先导出视图草稿，再通过「重新读取」核实磁盘并处理未保存内容。')); return false; }
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
  activeId = id; screen = 'analysis';
  draft = id === null ? undefined : clone(workspace.analyses.find(item => item.id === id));
  baseline = clone(draft); history = []; future = []; selection = null;
  if (id !== null && !visible.includes(id)) visible.push(id);
  setMode('select');
}
async function openLayer(id) {
  if (opening) return;
  if (id === activeId && !definitionMode()) { if (id !== null) { selection = { type: 'file' }; inspect(); } return; }
  if (!await guard()) return;
  const changedLayer = id !== activeId;
  assignLayer(id);
  if (changedLayer) { folded = []; viewPositions = {}; }
  render(); canvas.fit();
  if (changedLayer) await persistView();
}
async function openConcepts() {
  if (!workspace || definitionMode() || !await guard()) return;
  // 工作视图切换不改变选中的分析文件，也不为打开概念表写入 lastView。
  screen = 'concepts'; draft = clone(workspace.definitions); baseline = clone(draft);
  history = []; future = []; selection = null; render();
}
async function toggleLayer(id, checked) {
  if (opening || autosave.blocked) { renderSidebar(); if (autosave.blocked) showError(autosave.error); return; }
  if (!checked && id === activeId) {
    const next = visible.find(item => item !== id) ?? null;
    if (definitionMode()) activeId = next;
    else {
      if (!await guard()) { renderSidebar(); return; }
      assignLayer(next);
    }
  }
  visible = checked ? [...new Set([...visible, id])] : visible.filter(item => item !== id);
  folded = []; viewPositions = {}; selection = null; render(); await persistView();
}
function renderSidebar() {
  $('workspace-name').textContent = workspace.manifest.name;
  $('workspace-root').textContent = workspace.workspaceRoot;
  $('workspace-root').title = '固定保存目录：' + workspace.workspaceRoot;
  const files = $('files'); files.replaceChildren();
  const row = (label, id, path, parent) => {
    const item = el('div', undefined, 'file-row' + (id === activeId && !definitionMode() ? ' active' : ''));
    const open = button('', () => openLayer(id), 'file'); open.title = path;
    open.setAttribute('aria-label', '编辑图层 ' + label);
    open.append(el('span', '▱', 'file-icon'), el('span', label, 'file-text')); item.append(open);
    if (id !== null) {
      const labelEl = el('label', undefined, 'visibility'), input = el('input'); input.type = 'checkbox'; input.checked = visible.includes(id);
      input.setAttribute('aria-label', '显示图层 ' + label); input.title = '显示 / 隐藏此图层';
      input.onchange = () => toggleLayer(id, input.checked).catch(showError); labelEl.append(input); item.append(labelEl);
    }
    parent.append(item);
  };
  // 树结构来自服务读取的磁盘目录，包含空目录；路径映射不落盘。
  const folders = new Map([['', files]]);
  const folder = directory => {
    const parts = directory ? directory.split('/') : [];
    let current = '', parent = files;
    for (const part of parts) {
      current += part + '/';
      if (!folders.has(current)) { parent.append(el('div', '⌄ ' + part, 'folder-label')); const children = el('div', undefined, 'tree-children'); parent.append(children); folders.set(current, children); }
      parent = folders.get(current);
    }
    return parent;
  };
  for (const file of [...workspace.files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!['analysis', 'view'].includes(file.kind)) continue;
    const parts = file.path.split('/'); parts.pop();
    const parent = folder(parts.join('/'));
    if (file.kind === 'view') {
      const view = workspace.views.find(item => item.id === file.id);
      const item = el('div', undefined, 'file-row view-row' + (file.id === viewId ? ' current-view' : ''));
      const open = button('', () => load(view.id), 'file'); open.title = file.path;
      open.setAttribute('aria-label', '打开视图 ' + view.name);
      open.append(el('span', '▦', 'file-icon'), el('span', view.name, 'file-text')); item.append(open); parent.append(item);
    } else row(file.id === activeId && !definitionMode() ? draft.name : graphName(file.id), file.id, file.path, parent);
  }
  for (const directory of workspace.directories) folder(directory);
  if (!workspace.analyses.length) files.append(el('p', '还没有分析图，点击上方新建。', 'note'));
}
function projection() {
  const data = { ...workspace,
    analyses: workspace.analyses.map(item => item.id === activeId ? draft : item) };
  original = compose(data, visible); graph = original;
  for (const id of folded) graph = collapse(graph, id);
  const positions = {};
  graph.nodes.forEach((node, index) => {
    positions[node.id] = draft?.positions[node.id] ?? viewPositions[node.id] ?? data.definitions.positions[node.id]
      ?? { x: (index % 4) * 235 + 40, y: Math.floor(index / 4) * 160 + 40 };
  });
  return positions;
}
function render(withInspector = true) {
  if (!workspace) return;
  const table = definitionMode();
  $('view-name').textContent = viewId === null ? '临时浏览' : workspace.views.find(item => item.id === viewId).name;
  $('view-name').title = viewId === null ? '未保存为独立视图文件' : workspace.files.find(item => item.kind === 'view' && item.id === viewId).path;
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
    $('file-kind').textContent = activeId === null ? '浏览' : '编辑';
    $('file-name').textContent = activeId === null ? '未选择分析图' : draft.name;
    $('file-name').title = filePath();
    $('scope-chip').textContent = activeId === null ? '只读浏览' : '当前层可编辑';
    $('overlay-count').textContent = visible.length ? visible.length + ' 个图层可见 · 视图自动保存' : '未叠加分析图';
    $('counts').textContent = graph.nodes.length + ' 个节点 · ' + graph.edges.length + ' 条关系';
    $('empty').hidden = graph.nodes.length > 0;
    $('empty-title').textContent = activeId === null ? '开始一张分析图' : '为这张图引用概念';
    $('empty-hint').textContent = activeId === null ? '选择左侧分析文件，或新建一张分析图。' : '从概念表引用节点，再连接规则。';
    $('empty-add').textContent = activeId === null ? '新建分析图' : '引用概念';
    $('toolbar').hidden = activeId === null;
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
  if (selection.type === 'file') {
    if (!draft || definitionMode()) { $('inspector').hidden = true; return; }
    $('inspector-title').textContent = '分析图属性';
    detail(panel, '保存文件', filePath());
    field(panel, '分析图名称', draft.name, { onChange: value => edit(data => { data.name = value; }, { inspect: false }) });
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
    $('inspector-title').textContent = edge.hiddenNodes.length ? '折叠关系 · 只读摘要' : '因果关系';
    detail(panel, '方向', name(edge.source) + ' → ' + name(edge.target));
    const owned = edge.steps.length === 1 && edge.steps[0].graphId === activeId;
    if (owned) {
      const id = edge.steps[0].edgeId, originalEdge = draft.edges.find(item => item.id === id);
      field(panel, '作用', String(originalEdge.sign), { options: [['1', '＋ 促进'], ['-1', '− 抑制']], onChange: value => edit(data => { data.edges.find(item => item.id === id).sign = Number(value); }) });
      for (const [key, label] of [['condition', '机制条件（可选）'], ['note', '规则说明（可选）']]) field(panel, label, originalEdge[key], { multiline: true, onChange: value => edit(data => { data.edges.find(item => item.id === id)[key] = value; }, { inspect: false }) });
      panel.append(button('删除此连线', () => removeSelection(), 'danger'));
    } else panel.append(el('p', '这是其他图层的关系或折叠摘要。请切换到来源图层编辑原始连线。', 'note'));
    edge.steps.forEach(step => {
      detail(panel, graphName(step.graphId) + ' / ' + step.edgeId, name(step.source) + (step.sign === 1 ? ' ＋→ ' : ' −→ ') + name(step.target) + '\n' + (step.condition || '未补充条件') + '\n' + step.note);
      if (step.graphId !== activeId) panel.append(button('编辑图层：' + graphName(step.graphId), () => openLayer(step.graphId)));
    });
    return;
  }
  const node = workspace.definitions.nodes.find(item => item.id === selection.id);
  if (!node) { $('inspector').hidden = true; return; }
  $('inspector-title').textContent = '节点属性';
  detail(panel, node.label, node.description); detail(panel, '增加方向', node.increaseMeaning);
  panel.append(button('在概念表中编辑', async () => { await openConcepts(); if (definitionMode()) glossary.focusNode(node.id); }));
  if (draft && !draft.nodeIds.includes(node.id)) panel.append(button('引用到当前图层', () => edit(data => { data.nodeIds.push(node.id); })));
  detail(panel, '稳定 ID', node.id);
  const owners = workspace.analyses.filter(item => item.nodeIds.includes(node.id)).map(item => item.name);
  detail(panel, '引用图层', owners.join('、') || '尚未引用');
  const actions = el('div', undefined, 'property-actions');
  if (!dirty() && canCollapse(graph, node.id)) actions.append(button('折叠节点', () => {
    folded.push(node.id); selection = null; render(); void persistView();
  }));
  if (draft?.nodeIds.includes(node.id)) actions.append(button('移出当前图层', removeSelection, 'danger'));
  panel.append(actions);
  if (graph.nodes.some(item => item.id === node.id) && graph.nodes.length > 1) {
    const target = field(panel, '追踪影响至', graph.nodes.find(item => item.id !== node.id).id, { options: graph.nodes.filter(item => item.id !== node.id).map(item => [item.id, item.label]) });
    const output = el('div', undefined, 'trace-result');
    panel.append(button('解释影响路径', () => {
      const result = tracePaths(graph, node.id, target.value); output.replaceChildren(el('p', result.interpretation, 'note'));
      result.paths.forEach(path => output.append(el('div', (path.sign === 1 ? '促进路径' : '抑制路径') + '\n' + path.steps.map(step => name(step.source) + (step.sign === 1 ? ' ＋→ ' : ' −→ ') + name(step.target) + ' [' + graphName(step.graphId) + ']').join('\n'), 'trace-path')));
      if (!result.paths.length) output.append(el('p', '当前图层范围内未找到路径。'));
      if (result.truncated) output.append(el('p', '已达到查询上限，结果不完整。'));
    }), output);
  }
}
async function removeSelection() {
  if (!selection || busy()) return;
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
  if (!workspace || busy()) return;
  if (definitionMode()) { addTerm(); return; }
  if (activeId === null) return;
  setMode('select');
  const checked = new Set();
  await dialog('引用概念到当前分析图', container => {
    container.append(el('p', '复用概念表中的稳定 ID，让不同图层在同一概念上连接。', 'note'));
    const search = field(container, '搜索概念', '');
    const list = el('div', undefined, 'choice-list'); container.append(list);
    const draw = () => {
      list.replaceChildren();
      for (const node of workspace.definitions.nodes.filter(item => !draft.nodeIds.includes(item.id) && (item.label + item.id).toLowerCase().includes(search.value.toLowerCase()))) {
        const label = el('label', undefined, 'choice'), input = el('input'); input.type = 'checkbox'; input.checked = checked.has(node.id);
        input.onchange = () => input.checked ? checked.add(node.id) : checked.delete(node.id);
        const text = el('span', node.label); text.append(el('small', node.id)); label.append(input, text); list.append(label);
      }
    };
    search.oninput = draw; draw();
    container.append(el('p', '需要新的概念？在顶部「概念表」中新建并保存，然后回来引用。', 'note'));
  }, () => {
    if (!checked.size) throw new Error('请至少选择一个概念');
    edit(data => { data.nodeIds.push(...checked); }); canvas.fit();
  }, '引用概念');
}
async function newGraph() {
  if (!workspace || !await guard()) return;
  let label, id, scope, directory;
  await dialog('新建分析图', container => {
    label = field(container, '分析图名称', '', { required: true });
    id = field(container, '文件 ID', uid('graph'), { required: true, pattern: '[a-z][a-z0-9._-]{0,95}' });
    scope = field(container, '分析范围', '', { multiline: true, required: true });
    directory = field(container, '相对目录', 'analyses', { required: true });
    directory.setAttribute('list', 'workspace-directories');
    const choices = el('datalist'); choices.id = 'workspace-directories';
    for (const path of ['.', ...workspace.directories]) { const option = el('option'); option.value = path; choices.append(option); }
    container.append(choices, el('p', '保存为 <相对目录>/<ID>.analysis.json。支持中文和多层目录；填 . 表示工作区根。', 'note'));
  }, async () => {
    const document = { schemaVersion: 1, kind: 'analysis', workspaceId: workspace.manifest.id, id: id.value, name: label.value.trim(), scope: scope.value.trim(), nodeIds: [], edges: [], positions: {} };
    const parent = directory.value.trim(), file = (parent === '.' ? '' : parent + '/') + document.id + '.analysis.json';
    await write(revision => api('/api/analyses', { revision, document, file }));
    assignLayer(document.id); folded = []; render(); await persistView();
  }, '创建文件');
}
function setMode(mode) {
  if (!definitionMode() || mode === 'select') {
    canvas.setMode(mode);
    for (const key of ['select', 'positive', 'negative']) $(key + '-tool').classList.toggle('active', key === mode);
    $('tool-hint').textContent = mode === 'select' ? '拖拽节点 · 滚轮缩放 · 空格拖拽画布' : '先点击源节点，再点击目标节点 · 写入当前图层';
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
  select: value => { selection = value; render(); },
  canMove: id => !busy() && !definitionMode() && !!draft?.nodeIds.includes(id),
  move: (id, point) => edit(data => { data.positions[id] = point; }),
  zoom: value => { $('zoom').textContent = value + '%'; },
  hint: text => { $('tool-hint').textContent = text; },
  link: (source, target, sign) => {
    if (busy() || definitionMode() || activeId === null) return;
    if (!draft.nodeIds.includes(source) || !draft.nodeIds.includes(target)) { showError(new Error('请先把两个节点引用到当前图层，再建立此图层的关系。')); return; }
    const id = uid('edge');
    edit(data => { data.edges.push({ id, source, target, sign, condition: '', note: '' }); });
    setMode('select'); selection = { type: 'edge', id: activeId + '/' + id }; render();
  },
});
autosave = new ViewAutosave(write, body => api('/api/save', body), state => { viewState = state; updateStatus(); });
async function load(requestedId) {
  if (opening || (workspace && !await guard({ reload: true }))) return;
  opening = true; updateStatus();
  try {
    // 读取、校验叠加与记录最近打开全部确认后，才替换当前画面和草稿。
    const candidate = await readOpening(api, requestedId);
    workspace = candidate.workspace; viewId = candidate.viewId;
    visible = [...candidate.snapshot.graphIds]; assignLayer(candidate.snapshot.activeLayerId);
    folded = [...candidate.snapshot.collapsedNodeIds]; viewPositions = clone(candidate.snapshot.positions);
    autosave.reset(); $('startup-help').hidden = true; $('error').hidden = true; render(); canvas.fit();
  } catch (error) {
    if (error.code === 'SAVE_UNCERTAIN') autosave.pause(error);
    if (workspace) error.message = '打开失败；仍保留原画面和草稿，内容未刷新。\n' + error.message;
    showError(error);
  } finally { opening = false; updateStatus(); }
}
async function newView() {
  await writeQueue;
  if (!workspace || busy() || autosave.blocked) return;
  let label, id, directory;
  await dialog('保存为视图文件', container => {
    label = field(container, '视图名称', '', { required: true });
    id = field(container, '文件 ID', uid('view'), { required: true, pattern: '[a-z][a-z0-9._-]{0,95}' });
    const sourcePath = workspace.files.find(item => item.kind === 'view' && item.id === viewId)?.path || filePath();
    directory = field(container, '相对目录', sourcePath.split('/').slice(0, -1).join('/') || '.', { required: true });
    container.append(el('p', '保存当前勾选、编辑层与折叠状态为 <目录>/<ID>.view.json。此后修改自动写回；不会保存未提交的规则草稿。', 'note'));
  }, async () => {
    const document = { schemaVersion: 1, kind: 'view', workspaceId: workspace.manifest.id, id: id.value, name: label.value.trim(), ...viewSnapshot() };
    const parent = directory.value.trim(), file = (parent === '.' ? '' : parent + '/') + document.id + '.view.json';
    opening = true; updateStatus();
    try {
      const next = await createAndRememberView(api, workspace.revision, document, file);
      workspace = next; viewId = document.id; autosave.reset(); $('error').hidden = true; render();
    } catch (error) {
      if (['VIEW_CREATED_UNBOUND', 'SAVE_UNCERTAIN'].includes(error.code)) {
        autosave.pause(error); $('dialog').close('cancel'); showError(error); return false;
      }
      throw error;
    } finally { opening = false; updateStatus(); }
  }, '创建视图文件');
}
async function leaveView() {
  await writeQueue;
  if (busy() || autosave.blocked || viewId === null) return;
  opening = true; updateStatus();
  try {
    const snapshot = viewSnapshot();
    await write(revision => api('/api/save', { revision, kind: 'workspace', document: { ...workspace.manifest, lastView: snapshot } }));
    viewId = null; autosave.reset(); render();
  } catch (error) { autosave.pause(error); showError(error); }
  finally { opening = false; updateStatus(); }
}
$('new-graph').onclick = () => newGraph().catch(showError);
$('save-view').onclick = () => newView().catch(showError);
$('leave-view').onclick = () => leaveView().catch(showError);
$('table-view').onclick = () => openConcepts().catch(showError);
$('graph-view').onclick = () => openLayer(activeId).catch(showError);
$('save').onclick = saveDraft;
$('add-node').onclick = () => addNode().catch(showError);
$('empty-add').onclick = () => (activeId === null ? newGraph() : addNode()).catch(showError);
$('reload').onclick = () => load().catch(showError);
$('reload-error').onclick = $('reload').onclick;
$('undo').onclick = () => undo(); $('redo').onclick = () => undo(true);
$('fit').onclick = () => canvas.fit();
$('zoom-in').onclick = () => canvas.zoom(1.2); $('zoom-out').onclick = () => canvas.zoom(1 / 1.2);
$('toggle-sidebar').onclick = () => document.body.classList.toggle('sidebar-hidden');
$('close-inspector').onclick = () => { selection = null; render(); };
$('diagnostics').onclick = () => { selection = { type: 'diagnostics' }; inspect(); };
$('unfold').onclick = () => { folded = []; render(); void persistView(); };
$('dismiss-error').onclick = () => { $('error').hidden = true; };
$('close-dialog').onclick = $('cancel-dialog').onclick = () => $('dialog').close('cancel');
for (const mode of ['select', 'positive', 'negative']) $(mode + '-tool').onclick = () => setMode(mode);
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
  if (dirty() || busy() || autosave.blocked) { event.preventDefault(); event.returnValue = ''; }
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
await load();
