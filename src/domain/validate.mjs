import Ajv from 'ajv';
import { assertSpecializes } from './graph.mjs';
import { registeredMechanicIds, visibleMechanicIds } from './view.mjs';
import schema from '../../schemas/protocol.schema.json' with { type: 'json' };
import { normalizeSearchTerm, semanticIdProblem, semanticRuleId } from './identity.mjs';

// 文件结构只由 JSON Schema 定义；这里补充跨文件语义，不修正输入。
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
ajv.addSchema(schema);
const kinds = { workspace: 'workspace', definitions: 'definitionGraph', rules: 'ruleRegistry', mechanic: 'mechanic', view: 'view' };

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

function validateRuleQualifiers(qualifiers, nodes, location) {
  if (qualifiers === undefined) return;
  const keys = new Set();
  for (const qualifier of qualifiers) {
    const keyProblem = semanticIdProblem(qualifier.key);
    if (keyProblem) throw new ContractError('INVALID_SEMANTIC_ID', `${location} 的 qualifier key ${keyProblem}：${qualifier.key}`);
    if (keys.has(qualifier.key)) throw new ContractError('QUALIFIER_KEY_DUPLICATE', `${location} 的 qualifier key 重复：${qualifier.key}`);
    keys.add(qualifier.key);
    if (qualifier.value.kind === 'concept' && !nodes.has(qualifier.value.conceptId)) {
      throw new ContractError('QUALIFIER_CONCEPT_NOT_FOUND', `${location} 的 qualifier 引用了不存在的概念：${qualifier.value.conceptId}`);
    }
  }
}

export function validateWorkspace({ manifest, definitions, rules, mechanics, views = [], files = [] }) {
  assertDocument(manifest, 'workspace', 'workspace.json');
  assertDocument(definitions, 'definitions', manifest.definitions);
  assertDocument(rules, 'rules', manifest.rules);
  mechanics.forEach(graph => assertDocument(graph, 'mechanic', graph.id));
  views.forEach(view => assertDocument(view, 'view', view.id));
  const documents = [definitions, rules, ...mechanics, ...views];
  for (const document of documents) {
    if (document.workspaceId !== manifest.id) throw new ContractError('WORKSPACE_MISMATCH', '文档所属工作区与清单不一致');
  }
  const semanticIds = [manifest.id, ...manifest.compositions.map(item => item.id), ...definitions.nodes.map(item => item.id),
    ...rules.rules.map(rule => rule.id), ...mechanics.map(item => item.id), ...views.map(item => item.id)];
  for (const id of semanticIds) {
    const problem = semanticIdProblem(id);
    if (problem) throw new ContractError('INVALID_SEMANTIC_ID', `持久化领域 ID ${problem}：${id}`);
  }
  const nodes = unique(definitions.nodes, '节点定义图');
  const canonicalIds = new Set(definitions.nodes.map(node => normalizeSearchTerm(node.id)));
  for (const node of definitions.nodes) {
    const aliases = node.aliases ?? [], normalized = aliases.map(normalizeSearchTerm);
    if (new Set(normalized).size !== normalized.length) throw new ContractError('DUPLICATE_ALIAS', `概念 ${node.id} 的 aliases 归一化后重复`);
    for (const alias of normalized) if (canonicalIds.has(alias)) {
      throw new ContractError('ALIAS_SHADOWS_ID', `概念 ${node.id} 的别名遮蔽稳定 ID：${alias}`);
    }
  }
  const graphIds = unique(mechanics, '机制图清单');
  const workspaceEndpointPairs = new Map();
  for (const edge of rules.rules) {
      if (edge.relation === 'specializes' && (edge.sourceQualifiers || edge.targetQualifiers)) {
        throw new ContractError('QUALIFIER_ON_SPECIALIZES', `is-a 只能连接概念分类，不能限定规则参与者：${edge.id}`);
      }
      validateRuleQualifiers(edge.sourceQualifiers, nodes, `${edge.id}.source`);
      validateRuleQualifiers(edge.targetQualifiers, nodes, `${edge.id}.target`);
      const pair = `${edge.source}\u0000${edge.target}`;
      if (workspaceEndpointPairs.has(pair)) throw new ContractError('DUPLICATE_ENDPOINT_RULE',
        `概念 ${edge.source} 到 ${edge.target} 已在规则 ${workspaceEndpointPairs.get(pair)} 中存在；全工作区同一有向端点对只允许一条规则`);
      workspaceEndpointPairs.set(pair, edge.id);
      requireReference(nodes, edge.source, `${edge.id}.source`);
      requireReference(nodes, edge.target, `${edge.id}.target`);
      const expectedId = semanticRuleId(edge.source, edge.target, new Set());
      if (edge.id !== expectedId) throw new ContractError('RULE_ID_MISMATCH',
        `规则 ID 必须由端点确定：${edge.id} 应为 ${expectedId}`);
  }
  unique(rules.rules, '规则库');
  assertSpecializes(rules.rules);
  for (const graph of mechanics) {
    graph.focusNodeIds.forEach(id => requireReference(nodes, id, graph.id));
    graph.pinnedRuleIds.forEach(id => requireReference(new Set(rules.rules.map(rule => rule.id)), id, graph.id));
  }
  unique(manifest.compositions, '叠加组合');
  const viewIds = unique(views, '视图文件');
  const exportSelections = manifest.exportSelections;
  if (exportSelections !== undefined) {
    const mechanismFolders = new Map(mechanics.map(graph => {
      const file = files.find(item => item.kind === 'mechanic' && item.id === graph.id)?.path ?? '';
      const parent = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
      return [graph.id, parent === 'mechanics' ? '' : parent.startsWith('mechanics/') ? parent.slice('mechanics/'.length) : parent];
    }));
    const seenSelections = new Set(), selectedMechanics = new Map();
    for (const selection of exportSelections) {
      const identity = selection.kind === 'folder' ? `folder:${selection.folder}`
        : selection.kind === 'mechanic' ? `mechanic:${selection.mechanicId}` : `view:${selection.viewId}`;
      if (seenSelections.has(identity)) throw new ContractError('DUPLICATE_EXPORT_SELECTION', `导出清单包含重复目标：${identity}`);
      seenSelections.add(identity);
      let members = [];
      if (selection.kind === 'folder') {
        members = mechanics.filter(graph => mechanismFolders.get(graph.id) === selection.folder).map(graph => graph.id);
        if (!members.length) throw new ContractError('EXPORT_FOLDER_EMPTY', `导出文件夹没有直接机制图：${selection.folder}`);
      } else if (selection.kind === 'mechanic') {
        requireReference(graphIds, selection.mechanicId, '导出机制图'); members = [selection.mechanicId];
      } else {
        requireReference(viewIds, selection.viewId, '导出视图'); members = visibleMechanicIds(views.find(view => view.id === selection.viewId));
        if (!members.length) throw new ContractError('EXPORT_VIEW_EMPTY', `导出视图没有可见机制图：${selection.viewId}`);
      }
      // 视图是独立阅读入口，可与机制或文件夹同选；只有文件夹和其直接机制图互斥。
      if (selection.kind !== 'view') for (const id of members) {
        const previous = selectedMechanics.get(id);
        if (previous) throw new ContractError('DOCUMENT_EXPORT_CONFLICT', `机制图 ${id} 同时由 ${previous} 与 ${identity} 选中；文件夹与其直接机制图不能同时导出。`);
        selectedMechanics.set(id, identity);
      }
    }
  }
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
    // 坐标、折叠状态与路由缓存属于展示状态；读取时由 presentation resolver
    // 按当前语义图过滤。它们绝不能升级为领域完整性失败。
  }
  for (const view of views) {
    const location = files.find(file => file.kind === 'view' && file.id === view.id)?.path ?? `视图 ${view.id}`;
    const registered = registeredMechanicIds(view);
    if (new Set(registered).size !== registered.length) throw new ContractError('DUPLICATE_ID', `${location} 中机制注册重复`);
    registered.forEach(id => requireReference(graphIds, id, location));
    view.focusNodeIds.forEach(id => requireReference(nodes, id, location));
    view.pinnedRuleIds.forEach(id => requireReference(new Set(rules.rules.map(rule => rule.id)), id, location));
  }
  return { manifest, definitions, rules, mechanics, views };
}
