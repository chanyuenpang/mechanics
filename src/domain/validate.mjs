import Ajv from 'ajv';
import schema from '../../schemas/protocol.schema.json' with { type: 'json' };
import legacy from '../../schemas/legacy-workspace-v1.schema.json' with { type: 'json' };

// 文件结构只由 JSON Schema 定义；这里补充跨文件语义，不修正输入。
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(schema);
ajv.addSchema(legacy);
const kinds = { workspace: 'workspace', definitions: 'definitionGraph', analysis: 'analysis' };

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

export function assertLegacyManifest(document) {
  const validator = ajv.getSchema(legacy.$id);
  if (!validator(document)) throw new ContractError('INVALID_LEGACY_WORKSPACE', ajv.errorsText(validator.errors));
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

export function validateWorkspace({ manifest, definitions, analyses }) {
  assertDocument(manifest, 'workspace', 'workspace.json');
  assertDocument(definitions, 'definitions', manifest.definitions);
  analyses.forEach(graph => assertDocument(graph, 'analysis', graph.id));
  const documents = [definitions, ...analyses];
  for (const document of documents) {
    if (document.workspaceId !== manifest.id) throw new ContractError('WORKSPACE_MISMATCH', '文档所属工作区与清单不一致');
  }
  const nodes = unique(definitions.nodes, '节点定义图');
  positionsExist(definitions.positions, nodes, manifest.definitions);
  const graphIds = unique(analyses, '分析图清单');
  for (const graph of analyses) {
    const included = new Set(graph.nodeIds);
    unique(graph.edges, `分析图 ${graph.id} 的连线`);
    graph.nodeIds.forEach(id => requireReference(nodes, id, graph.id));
    for (const edge of graph.edges) {
      requireReference(included, edge.source, `${graph.id}/${edge.id}.source`);
      requireReference(included, edge.target, `${graph.id}/${edge.id}.target`);
    }
    positionsExist(graph.positions, included, graph.id);
  }
  unique(manifest.compositions, '叠加组合');
  if (manifest.lastView?.activeLayerId !== null && manifest.lastView?.activeLayerId !== undefined) {
    requireReference(graphIds, manifest.lastView.activeLayerId, '最近视图的编辑图层');
    if (!manifest.lastView.graphIds.includes(manifest.lastView.activeLayerId)) throw new ContractError('HIDDEN_ACTIVE_LAYER', '当前编辑图层必须可见');
  }
  for (const view of [...manifest.compositions, ...(manifest.lastView ? [{ id: 'lastView', ...manifest.lastView }] : [])]) {
    view.graphIds.forEach(id => requireReference(graphIds, id, `组合 ${view.id}`));
    const included = new Set(analyses.filter(graph => view.graphIds.includes(graph.id)).flatMap(graph => graph.nodeIds));
    view.collapsedNodeIds.forEach(id => requireReference(included, id, `组合 ${view.id} 的折叠节点`));
    positionsExist(view.positions, included, `组合 ${view.id}`);
  }
  return { manifest, definitions, analyses };
}
