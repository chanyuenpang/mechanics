import { compose, collapse } from '../domain/graph.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(message); };

// 先在候选数据上完成投影，调用方仅在整个打开过程成功后替换页面状态。
export function prepareOpening(workspace, requestedId) {
  const remembered = workspace.manifest.lastView;
  const viewId = requestedId ?? remembered?.viewId ?? null;
  const snapshot = viewId !== null ? workspace.views.find(view => view.id === viewId)
    : remembered ?? { graphIds: workspace.analyses.map(item => item.id), activeLayerId: workspace.analyses[0]?.id ?? null, collapsedNodeIds: [], positions: {} };
  if (!snapshot) fail('视图文件不存在：' + viewId);
  if (snapshot.activeLayerId !== null && !snapshot.graphIds.includes(snapshot.activeLayerId)) fail('视图的编辑层必须可见');
  const original = compose(workspace, snapshot.graphIds);
  let graph = original;
  for (const id of snapshot.collapsedNodeIds) graph = collapse(graph, id);
  return { workspace, viewId, snapshot: structuredClone(snapshot), original, graph };
}

export async function readOpening(api, requestedId) {
  let workspace = await api('/api/workspace');
  let candidate = prepareOpening(workspace, requestedId);
  const lastView = candidate.viewId === null ? candidate.snapshot : { viewId: candidate.viewId };
  if (!equal(workspace.manifest.lastView, lastView)) {
    workspace = await api('/api/save', { revision: workspace.revision, kind: 'workspace', document: { ...workspace.manifest, lastView } });
    candidate = prepareOpening(workspace, candidate.viewId ?? undefined);
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
