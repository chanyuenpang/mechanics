import { compose, collapse, canCollapse } from '../domain/graph.mjs';
import { composeView, registerMechanic, registeredMechanicIds, setMechanicVisibility, visibleMechanicIds } from '../domain/view.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(message); };
const NODE_WIDTH = 166, NODE_HEIGHT = 62, GRID_X = 235, GRID_Y = 160;

function overlaps(a, b) {
  return a.x < b.x + NODE_WIDTH + 20 && a.x + NODE_WIDTH + 20 > b.x
    && a.y < b.y + NODE_HEIGHT + 20 && a.y + NODE_HEIGHT + 20 > b.y;
}

// 视图 positions 是独立布局记忆，不随 Visible 集合裁剪。只有从未出现过的可见节点才寻找新位置。
export function completeViewPositions(workspace, graph, remembered = {}) {
  const positions = structuredClone(remembered);
  const definitions = workspace.definitions.nodes.map(node => node.id).sort();
  const missing = graph.nodes.map(node => node.id).filter(id => positions[id] === undefined)
    .sort((a, b) => definitions.indexOf(a) - definitions.indexOf(b));
  for (const id of missing) {
    const index = definitions.indexOf(id);
    const preferred = workspace.definitions.positions[id]
      ?? { x: (index % 4) * GRID_X + 40, y: Math.floor(index / 4) * GRID_Y + 40 };
    let placed = false;
    for (let ring = 0; ring < 200 && !placed; ring++) {
      for (let y = -ring; y <= ring && !placed; y++) for (let x = -ring; x <= ring && !placed; x++) {
        if (ring && Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
        const point = { x: preferred.x + x * GRID_X, y: preferred.y + y * GRID_Y };
        if (Math.abs(point.x) > 100000 || Math.abs(point.y) > 100000) continue;
        if (Object.values(positions).some(other => overlaps(point, other))) continue;
        positions[id] = point; placed = true;
      }
    }
    if (!placed) fail('视图中没有可用于新节点的非重叠位置：' + id);
  }
  return positions;
}

// 先在候选数据上完成投影，调用方仅在整个打开过程成功后替换页面状态。
export function graphPositions(workspace, graph, positions = {}, mechanicId = null, implicitPositions = {}) {
  const local = workspace.mechanics.find(item => item.id === mechanicId)?.positions ?? {};
  const ids = workspace.definitions.nodes.map(node => node.id).sort();
  return Object.fromEntries(graph.nodes.map(node => {
    const index = ids.indexOf(node.id);
    return [node.id, structuredClone(local[node.id] ?? positions[node.id] ?? workspace.definitions.positions[node.id] ?? implicitPositions[node.id]
      ?? { x: (index % 4) * 235 + 40, y: Math.floor(index / 4) * 160 + 40 })];
  }));
}

function materializeView(workspace, snapshot, original, graph) {
  const positions = completeViewPositions(workspace, original, snapshot.positions);
  return { mechanicRegistrations: snapshot.mechanicRegistrations.map(item => structuredClone(item)), collapsedNodeIds: [...snapshot.collapsedNodeIds], positions };
}

function updateViewProjection(workspace, snapshot) {
  const original = composeView(workspace, snapshot);
  return {
    mechanicRegistrations: snapshot.mechanicRegistrations.map(item => structuredClone(item)),
    collapsedNodeIds: [...snapshot.collapsedNodeIds],
    positions: completeViewPositions(workspace, original, snapshot.positions),
  };
}

export const registerViewMechanic = (workspace, snapshot, mechanicId) => updateViewProjection(workspace, registerMechanic(snapshot, mechanicId));

export const changeViewVisibility = (workspace, snapshot, mechanicId, visible) => updateViewProjection(workspace, setMechanicVisibility(snapshot, mechanicId, visible));

export function prepareOpening(workspace, requestedId, { repairFolds = false } = {}) {
  const remembered = workspace.manifest.lastView;
  const mechanic = typeof requestedId === 'object' && requestedId?.kind === 'mechanic';
  const viewId = mechanic ? null : requestedId ?? remembered?.viewId ?? null;
  let snapshot = viewId !== null ? workspace.views.find(view => view.id === viewId)
    : mechanic ? { graphIds: requestedId.id === null ? [] : [requestedId.id], activeLayerId: requestedId.id, collapsedNodeIds: [], positions: {} }
      : remembered ?? { graphIds: workspace.mechanics.slice(0, 1).map(item => item.id), activeLayerId: workspace.mechanics[0]?.id ?? null, collapsedNodeIds: [], positions: {} };
  if (!snapshot) fail('视图文件不存在：' + viewId);
  const graphIds = viewId !== null ? visibleMechanicIds(snapshot) : snapshot.graphIds;
  if (viewId === null && snapshot.activeLayerId !== null && !snapshot.graphIds.includes(snapshot.activeLayerId)) fail('视图的编辑层必须可见');
  const original = viewId !== null ? composeView(workspace, snapshot) : compose(workspace, graphIds);
  let graph = original;
  const invalidFolds = [], folded = [];
  const registeredNodes = new Set(viewId === null ? original.nodes.map(node => node.id)
    : workspace.mechanics.filter(item => registeredMechanicIds(snapshot).includes(item.id)).flatMap(item => item.nodeIds));
  const visibleNodes = new Set(original.nodes.map(node => node.id));
  for (const id of snapshot.collapsedNodeIds) {
    if (canCollapse(graph, id)) { graph = collapse(graph, id); folded.push(id); }
    else if (viewId !== null && registeredNodes.has(id) && !visibleNodes.has(id)) folded.push(id);
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
    snapshot: viewId !== null ? materializeView(workspace, snapshot, original, graph)
      : legacy ? { ...structuredClone(snapshot), positions: graphPositions(workspace, original, snapshot.positions, snapshot.activeLayerId) }
        : structuredClone(snapshot), original, graph };
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
