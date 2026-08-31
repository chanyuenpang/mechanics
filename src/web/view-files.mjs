import { compose, collapse, canCollapse } from '../domain/graph.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(message); };

// 先在候选数据上完成投影，调用方仅在整个打开过程成功后替换页面状态。
export function graphPositions(workspace, graph, positions = {}, analysisId = null, implicitPositions = {}) {
  const local = workspace.analyses.find(item => item.id === analysisId)?.positions ?? {};
  const ids = workspace.definitions.nodes.map(node => node.id).sort();
  return Object.fromEntries(graph.nodes.map(node => {
    const index = ids.indexOf(node.id);
    return [node.id, structuredClone(local[node.id] ?? positions[node.id] ?? workspace.definitions.positions[node.id] ?? implicitPositions[node.id]
      ?? { x: (index % 4) * 235 + 40, y: Math.floor(index / 4) * 160 + 40 })];
  }));
}

// 旧文件只在内存中物化原画面；打开本身不改视图文件，第一次展示编辑才接管坐标。
function materializeView(workspace, snapshot, original, graph) {
  const positions = graphPositions(workspace, original, snapshot.positions);
  if (snapshot.activeLayerId !== null) {
    const local = workspace.analyses.find(item => item.id === snapshot.activeLayerId).positions;
    graph.nodes.forEach((node, index) => {
      positions[node.id] = structuredClone(local[node.id] ?? snapshot.positions[node.id] ?? workspace.definitions.positions[node.id]
        ?? { x: (index % 4) * 235 + 40, y: Math.floor(index / 4) * 160 + 40 });
    });
  }
  return { graphIds: [...snapshot.graphIds], activeLayerId: null, collapsedNodeIds: [...snapshot.collapsedNodeIds], positions };
}

export function changeViewMembers(workspace, snapshot, graphIds) {
  const original = compose(workspace, graphIds), ids = new Set(original.nodes.map(node => node.id));
  let graph = original;
  const folded = [];
  for (const id of snapshot.collapsedNodeIds) {
    if (canCollapse(graph, id)) { graph = collapse(graph, id); folded.push(id); }
  }
  const positions = Object.fromEntries(Object.entries(snapshot.positions).filter(([id]) => ids.has(id)));
  return {
    graphIds: [...graphIds], activeLayerId: null, collapsedNodeIds: folded,
    positions: graphPositions(workspace, original, positions),
  };
}

export function prepareOpening(workspace, requestedId, { repairFolds = false } = {}) {
  const remembered = workspace.manifest.lastView;
  const research = typeof requestedId === 'object' && requestedId?.kind === 'analysis';
  const viewId = research ? null : requestedId ?? remembered?.viewId ?? null;
  let snapshot = viewId !== null ? workspace.views.find(view => view.id === viewId)
    : research ? { graphIds: requestedId.id === null ? [] : [requestedId.id], activeLayerId: requestedId.id, collapsedNodeIds: [], positions: {} }
      : remembered ?? { graphIds: workspace.analyses.slice(0, 1).map(item => item.id), activeLayerId: workspace.analyses[0]?.id ?? null, collapsedNodeIds: [], positions: {} };
  if (!snapshot) fail('视图文件不存在：' + viewId);
  if (snapshot.activeLayerId !== null && !snapshot.graphIds.includes(snapshot.activeLayerId)) fail('视图的编辑层必须可见');
  const original = compose(workspace, snapshot.graphIds);
  let graph = original;
  const invalidFolds = [], folded = [];
  for (const id of snapshot.collapsedNodeIds) {
    if (canCollapse(graph, id)) { graph = collapse(graph, id); folded.push(id); }
    else invalidFolds.push(id);
  }
  if (invalidFolds.length && (!repairFolds || viewId === null)) {
    const error = new Error('来源规则已改变，以下折叠不再成立：' + invalidFolds.join('、'));
    error.code = viewId === null ? 'INVALID_FOLD' : 'FOLD_REPAIR_REQUIRED'; error.viewId = viewId; throw error;
  }
  if (invalidFolds.length) snapshot = { ...snapshot, collapsedNodeIds: folded };
  const legacy = viewId === null && (snapshot.graphIds.length > 1 || snapshot.collapsedNodeIds.length > 0 || Object.keys(snapshot.positions).length > 0);
  const activeId = viewId !== null || legacy ? null : snapshot.graphIds[0] ?? null;
  return { workspace, viewId, legacy, activeId, invalidFolds,
    snapshot: viewId !== null || legacy ? materializeView(workspace, snapshot, original, graph) : structuredClone(snapshot), original, graph };
}

export async function readOpening(api, requestedId, { repairFolds = false } = {}) {
  let workspace = await api('/api/workspace');
  let candidate = prepareOpening(workspace, requestedId, { repairFolds });
  if (candidate.invalidFolds.length) {
    workspace = await api('/api/save', { revision: workspace.revision, ...viewSaveRequest(workspace, candidate.viewId, candidate.snapshot) });
    candidate = prepareOpening(workspace, requestedId);
  }
  const lastView = candidate.viewId === null ? candidate.snapshot : { viewId: candidate.viewId };
  if (!candidate.legacy && !equal(workspace.manifest.lastView, lastView)) {
    workspace = await api('/api/save', { revision: workspace.revision, kind: 'workspace', document: { ...workspace.manifest, lastView } });
    candidate = prepareOpening(workspace, requestedId);
  }
  return candidate;
}

export async function createAndRememberView(api, revision, document, file) {
  const created = await api('/api/views', { revision, document, file });
  try {
    prepareOpening(created, document.id);
    const next = await api('/api/save', { revision: created.revision, kind: 'workspace', document: { ...created.manifest, lastView: { viewId: document.id } } });
    prepareOpening(next, document.id);
    return next;
  } catch (cause) {
    const error = new Error('视图文件已创建：' + file + '；最近打开记录未完成确认。不要重复创建，请重新读取后打开该文件。\n' + cause.message, { cause });
    error.code = 'VIEW_CREATED_UNBOUND';
    throw error;
  }
}

export function viewSaveRequest(workspace, viewId, snapshot) {
  if (viewId === null) return { kind: 'workspace', document: { ...structuredClone(workspace.manifest), lastView: structuredClone(snapshot) } };
  const source = workspace.views.find(item => item.id === viewId);
  if (!source) fail('当前视图文件不存在：' + viewId);
  return { kind: 'view', id: viewId, document: { ...structuredClone(source), ...structuredClone(snapshot) } };
}

// 与规则保存共享调用方的写入队列；失败后禁止已排队的旧视图继续写入。
export class ViewAutosave {
  constructor(write, send, stateChanged) {
    this.write = write; this.send = send; this.stateChanged = stateChanged;
    this.sequence = 0; this.blocked = false;
  }
  reset() { this.blocked = false; this.error = null; this.stateChanged('saved'); }
  pause(error) {
    this.blocked = true; this.error = error;
    this.stateChanged(error.code === 'SAVE_UNCERTAIN' ? 'uncertain' : 'failed');
  }
  async save(request) {
    if (this.blocked) throw this.error;
    const captured = structuredClone(request), sequence = ++this.sequence;
    this.stateChanged('saving');
    try {
      await this.write(async revision => {
        if (this.blocked) throw this.error;
        try { return await this.send({ ...captured, revision }); }
        catch (error) { this.pause(error); throw error; }
      });
      if (sequence === this.sequence) this.stateChanged('saved');
      return true;
    } catch (error) { this.pause(error); throw error; }
  }
}
