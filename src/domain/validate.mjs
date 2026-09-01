import Ajv from 'ajv';
import { assertContainment } from './graph.mjs';
import { registeredMechanicIds, visibleMechanicIds } from './view.mjs';
import schema from '../../schemas/protocol.schema.json' with { type: 'json' };

// 文件结构只由 JSON Schema 定义；这里补充跨文件语义，不修正输入。
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(schema);
const kinds = { workspace: 'workspace', definitions: 'definitionGraph', mechanic: 'mechanic', view: 'view' };

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export function assertDocument(document, kind, location = kind) {
  const validator = ajv.getSchema(`${schema.$id}#/definitions/${kinds[kind]}`);
  if (!validator) throw new ContractError('INVALID_KIND', `不支持的文档类型：${kind}`);
  if (!validator(document)) {
    throw new ContractError('INVALID_DOCUMENT', `${location}：${ajv.errorsText(validator.errors, { separator: '；' })}`);
  }
}

function unique(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new ContractError('DUPLICATE_ID', `${label} 中 ID 重复：${item.id}`);
    seen.add(item.id);
  }
  return seen;
}

function requireReference(ids, id, location) {
  if (!ids.has(id)) throw new ContractError('MISSING_REFERENCE', `${location} 引用了不存在的 ID：${id}`);
}

function positionsExist(positions, ids, location) {
  for (const id of Object.keys(positions)) requireReference(ids, id, `${location}.positions`);
}

export function validateWorkspace({ manifest, definitions, mechanics, views = [], files = [] }) {
  assertDocument(manifest, 'workspace', 'workspace.json');
  assertDocument(definitions, 'definitions', manifest.definitions);
  mechanics.forEach(graph => assertDocument(graph, 'mechanic', graph.id));
  views.forEach(view => assertDocument(view, 'view', view.id));
  const documents = [definitions, ...mechanics, ...views];
  for (const document of documents) {
    if (document.workspaceId !== manifest.id) throw new ContractError('WORKSPACE_MISMATCH', '文档所属工作区与清单不一致');
  }
  const nodes = unique(definitions.nodes, '节点定义图');
  positionsExist(definitions.positions, nodes, manifest.definitions);
  const graphIds = unique(mechanics, '机制图清单');
  for (const graph of mechanics) {
    const included = new Set(graph.nodeIds);
    unique(graph.edges, `机制图 ${graph.id} 的连线`);
    graph.nodeIds.forEach(id => requireReference(nodes, id, graph.id));
    for (const edge of graph.edges) {
      requireReference(included, edge.source, `${graph.id}/${edge.id}.source`);
      requireReference(included, edge.target, `${graph.id}/${edge.id}.target`);
    }
    positionsExist(graph.positions, included, graph.id);
    assertContainment(graph.edges.map(edge => ({ ...edge, id: `${graph.id}/${edge.id}` })));
  }
  unique(manifest.compositions, '叠加组合');
  const viewIds = unique(views, '视图文件');
  const last = manifest.lastView;
  if (last?.viewId !== undefined) requireReference(viewIds, last.viewId, '最近打开的视图文件');
  for (const view of [...manifest.compositions, ...(last && !('viewId' in last) ? [{ id: 'lastView', ...last }] : [])]) {
    const location = `组合 ${view.id}`;
    view.graphIds.forEach(id => requireReference(graphIds, id, location));
    if (view.activeLayerId !== null && view.activeLayerId !== undefined) {
      requireReference(graphIds, view.activeLayerId, location + ' 的编辑层');
      if (!view.graphIds.includes(view.activeLayerId)) throw new ContractError('HIDDEN_ACTIVE_LAYER', location + ' 的编辑图层必须可见');
    }
    const included = new Set(mechanics.filter(graph => view.graphIds.includes(graph.id)).flatMap(graph => graph.nodeIds));
    view.collapsedNodeIds.forEach(id => requireReference(included, id, location + ' 的折叠节点'));
    // 视图可记住暂时隐藏的已定义节点坐标；Visible 只控制显示，不销毁布局。
    positionsExist(view.positions, nodes, location);
  }
  for (const view of views) {
    const location = files.find(file => file.kind === 'view' && file.id === view.id)?.path ?? `视图 ${view.id}`;
    const registered = registeredMechanicIds(view);
    if (new Set(registered).size !== registered.length) throw new ContractError('DUPLICATE_ID', `${location} 中机制注册重复`);
    registered.forEach(id => requireReference(graphIds, id, location));
    const included = new Set(mechanics.filter(graph => registered.includes(graph.id)).flatMap(graph => graph.nodeIds));
    view.collapsedNodeIds.forEach(id => requireReference(included, id, location + ' 的折叠节点'));
    positionsExist(view.positions, nodes, location);
  }
  return { manifest, definitions, mechanics, views };
}
