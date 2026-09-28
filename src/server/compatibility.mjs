import { assertDocument, ContractError } from '../domain/validate.mjs';
import { semanticRuleId } from '../domain/identity.mjs';

const fail = (message, details = {}) => { throw Object.assign(new ContractError('CORE_TOPOLOGY_INVALID', message), details); };
const asArray = value => Array.isArray(value) ? value : [];
const stableIds = (value, location) => {
  const ids = asArray(value);
  if (ids.some(id => typeof id !== 'string' || !id)) fail(`${location} 必须是非空 ID 数组`);
  return [...new Set(ids)];
};
// 兼容读取只在内存里重建核心拓扑：早于 v11 的旧文件没有展示状态字段，投影模型必须显式补出
// 当前协议的默认值才能通过同一领域校验。这只是只读投影，绝不写回文件；
// 真正升级仍然只走 migrateWorkspace 的全量原子迁移（打开项目时会自动逐级执行）。
const defaultTaxonomyPresentation = () => ({ mode: 'label', expandedNodeIds: [] });
const taxonomyPresentationOf = (document, { requireExplicit = false } = {}) => {
  const value = document?.taxonomyPresentation;
  if (value && typeof value === 'object' && !Array.isArray(value)) return structuredClone(value);
  // 只有早于当前协议的旧资料才允许在内存投影里补默认值；当前版本缺必填字段是坏文件，
  // 必须显式失败，绝不能用运行时缺省掩盖。
  if (requireExplicit) fail('当前协议的机制图与视图必须显式保存 taxonomyPresentation；请先完成迁移。');
  return defaultTaxonomyPresentation();
};

const stableTagIds = (value, location) => {
  const ids = asArray(value);
  if (ids.some(id => typeof id !== 'string' || !id.trim())) fail(`${location} 必须是非空标签 ID 数组`);
  return [...new Set(ids.map(id => id.trim()))];
};

function node(node, workspaceId, location) {
  if (!node || typeof node !== 'object' || Array.isArray(node)
    || typeof node.id !== 'string' || !node.id
    || typeof node.label !== 'string' || !node.label
    || typeof node.description !== 'string' || !node.description) {
    fail(`${location} 缺少可读取的概念 ID、名称或定义`);
  }
  return {
    id: node.id, label: node.label, description: node.description,
    ...(typeof node.customData === 'string' ? { customData: node.customData } : {}),
    agentLocked: Boolean(node.agentLocked),
    ...(asArray(node.aliases).length ? { aliases: asArray(node.aliases) } : {}),
    tagIds: stableTagIds(node.tagIds, `${location}.tagIds`),
  };
}

function normalizeDefinitions(document, manifest) {
  if (document?.kind !== 'definitions' || document.workspaceId !== manifest.id || !Array.isArray(document.nodes)) {
    fail('definitions.json 缺少可读取的概念集合。');
  }
  const tags = new Map();
  for (const tag of asArray(document.tagDefinitions)) if (tag && typeof tag.id === 'string' && typeof tag.displayName === 'string' && typeof tag.color === 'string') {
    tags.set(tag.id, { id: tag.id, displayName: tag.displayName, color: tag.color });
  }
  const nodes = document.nodes.map((item, index) => {
    const result = node(item, manifest.id, `definitions.nodes[${index}]`);
    if (!result.tagIds.length && Array.isArray(item.tags)) result.tagIds = stableTagIds(item.tags.filter(tag => typeof tag === 'string' && tag.trim()), `definitions.nodes[${index}].tags`);
    for (const id of result.tagIds) if (!tags.has(id)) tags.set(id, { id, displayName: id, color: '#6B7280' });
    if (!result.tagIds.length) delete result.tagIds;
    return result;
  });
  return { schemaVersion: 7, kind: 'definitions', workspaceId: manifest.id, tagDefinitions: [...tags.values()], nodes, positions: {} };
}

function normalizeRule(edge, location) {
  if (!edge || typeof edge !== 'object' || Array.isArray(edge) || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
    fail(`${location} 缺少规则端点`);
  }
  const relation = edge.relation === 'belongsTo' ? 'specializes' : edge.relation;
  if (!['influence', 'specializes'].includes(relation)) fail(`${location} 使用无法解释的关系类型：${String(edge.relation)}`);
  const result = { id: semanticRuleId(edge.source, edge.target, new Set()), source: edge.source, target: edge.target, relation };
  if (relation === 'influence') {
    if (![1, -1, 'random'].includes(edge.sign)) fail(`${location} 的影响规则缺少正面、负面或随机符号`);
    result.sign = edge.sign;
    result.inheritance = edge.inheritance ?? { mode: 'none' };
    if (typeof edge.ruleText === 'string') result.ruleText = edge.ruleText;
    if (Array.isArray(edge.sourceQualifiers)) result.sourceQualifiers = edge.sourceQualifiers;
    if (Array.isArray(edge.targetQualifiers)) result.targetQualifiers = edge.targetQualifiers;
  }
  if (typeof edge.customData === 'string') result.customData = edge.customData;
  return result;
}

function normalizeMechanic(document, manifest, location, taxonomyOptions = {}) {
  if (document?.kind !== 'mechanic' || document.workspaceId !== manifest.id || typeof document.id !== 'string' || !document.id) {
    fail(`${location} 缺少可读取的机制图身份`);
  }
  const edges = asArray(document.edges).map((edge, index) => normalizeRule(edge, `${location}.edges[${index}]`));
  const focusNodeIds = stableIds(document.focusNodeIds ?? document.nodeIds, `${location}.nodeIds`);
  const pinnedRuleIds = stableIds(document.pinnedRuleIds ?? edges.map(edge => edge.id), `${location}.pinnedRuleIds`);
  if (document.ruleSelection !== undefined && document.ruleSelection !== 'explicit') fail(`${location}.ruleSelection 无效`);
  return { schemaVersion: 9, kind: 'mechanic', workspaceId: manifest.id, id: document.id,
    name: typeof document.name === 'string' && document.name ? document.name : document.id,
    scope: typeof document.scope === 'string' && document.scope ? document.scope : '未指定范围',
    focusNodeIds, pinnedRuleIds, ...(document.ruleSelection !== undefined ? { ruleSelection: document.ruleSelection } : {}), positions: {},
    implementationStatus: 'design', taxonomyPresentation: taxonomyPresentationOf(document, taxonomyOptions), __legacyEdges: edges };
}

function normalizeView(document, manifest, location, taxonomyOptions = {}) {
  if (document?.kind !== 'view' || document.workspaceId !== manifest.id || typeof document.id !== 'string' || !document.id) {
    fail(`${location} 缺少可读取的视图身份`);
  }
  const registrations = Array.isArray(document.mechanicRegistrations) ? document.mechanicRegistrations
    : stableIds(document.graphIds, `${location}.graphIds`).map(mechanicId => ({ mechanicId, visible: true }));
  if (registrations.some(item => !item || typeof item.mechanicId !== 'string' || typeof item.visible !== 'boolean')) fail(`${location} 的机制引用不可读取`);
  return { schemaVersion: 5, kind: 'view', workspaceId: manifest.id, id: document.id,
    name: typeof document.name === 'string' && document.name ? document.name : document.id,
    mechanicRegistrations: registrations, focusNodeIds: stableIds(document.focusNodeIds, `${location}.focusNodeIds`),
    pinnedRuleIds: stableIds(document.pinnedRuleIds, `${location}.pinnedRuleIds`), collapsedNodeIds: [], positions: {},
    structuralPresentation: 'line', taxonomyPresentation: taxonomyPresentationOf(document, taxonomyOptions) };
}

export function compatibilityWorkspace({ manifest: rawManifest, definitions: rawDefinitions, rawRules, rawMechanics, rawViews }) {
  if (rawManifest?.kind !== 'workspace' || typeof rawManifest.id !== 'string' || !rawManifest.id
    || typeof rawManifest.name !== 'string' || !rawManifest.name || typeof rawManifest.definitions !== 'string') {
    fail('workspace.json 缺少可读取的工作区身份或概念文件。');
  }
  // v11/v12 已经有 rules.json，却还没有必填的展示状态：它们的候选必须由迁移器显式写入，
  // 不能被只读兼容模型吞掉而以运行时缺省出现。打开项目由 project-manager 逐级自动升级；
  // v7–v10 仍保留只读兼容模型，供 validate/查询这类纯读取使用。
  if (rawManifest.schemaVersion === 11 || rawManifest.schemaVersion === 12) {
    const version = rawManifest.schemaVersion;
    const error = new ContractError('WORKSPACE_VERSION_UNSUPPORTED',
      `工作区仍是 v${version}，缺少显式展示状态；请先完成迁移（--from ${version} --to ${version === 11 ? 12 : 13}）再打开。`);
    error.schemaVersion = version; error.workspaceId = rawManifest.id;
    throw error;
  }
  if (rawManifest.schemaVersion === 14) {
    assertDocument(rawManifest, 'workspace'); assertDocument(rawDefinitions, 'definitions'); assertDocument(rawRules, 'rules');
    rawMechanics.forEach(item => assertDocument(item.document, 'mechanic', item.path));
    rawViews.forEach(item => assertDocument(item.document, 'view', item.path));
    return { manifest: rawManifest, definitions: rawDefinitions, rules: rawRules, mechanics: rawMechanics, views: rawViews,
      compatibilityMode: false, compatibilityDiagnostics: [] };
  }
  const manifest = { schemaVersion: 14, kind: 'workspace', id: rawManifest.id, name: rawManifest.name,
    definitions: rawManifest.definitions, rules: typeof rawManifest.rules === 'string' ? rawManifest.rules : 'rules.json',
    ...(typeof rawManifest.agentExportPath === 'string' ? { agentExportPath: rawManifest.agentExportPath } : {}), compositions: [] };
  if (rawManifest.lastView?.viewId && typeof rawManifest.lastView.viewId === 'string') manifest.lastView = { viewId: rawManifest.lastView.viewId };
  else if (Array.isArray(rawManifest.lastView?.graphIds)) manifest.lastView = {
    graphIds: stableIds(rawManifest.lastView.graphIds, 'workspace.lastView.graphIds'),
    activeLayerId: typeof rawManifest.lastView.activeLayerId === 'string' ? rawManifest.lastView.activeLayerId : null,
    collapsedNodeIds: [], positions: {},
  };
  // 只有当前版本的资料才要求显式展示状态；更早的旧资料在内存投影里补默认值并可只读打开。
  const taxonomyOptions = { requireExplicit: rawManifest.schemaVersion === 13 };
  const definitions = normalizeDefinitions(rawDefinitions, manifest);
  const mechanics = rawMechanics.map(({ document, path }) => ({ document: normalizeMechanic(document, manifest, path, taxonomyOptions), path }));
  const sourceRules = rawRules?.kind === 'rules' && Array.isArray(rawRules.rules)
    ? rawRules.rules.map((edge, index) => normalizeRule(edge, `rules.json.rules[${index}]`))
    : mechanics.flatMap(item => item.document.__legacyEdges);
  const pairs = new Set();
  for (const rule of sourceRules) {
    const key = `${rule.source}\u0000${rule.target}`;
    if (pairs.has(key)) fail(`规则库存在重复的有向端点：${rule.source} → ${rule.target}`);
    pairs.add(key);
  }
  const rules = { schemaVersion: 1, kind: 'rules', workspaceId: manifest.id, rules: sourceRules };
  for (const item of mechanics) delete item.document.__legacyEdges;
  const views = rawViews.map(({ document, path }) => ({ document: normalizeView(document, manifest, path, taxonomyOptions), path }));
  return { manifest, definitions, rules, mechanics, views, compatibilityMode: true,
    compatibilityDiagnostics: [{ code: 'COMPATIBILITY_READ', file: 'workspace.json', message: '以核心拓扑兼容模式读取；原始文件未被修改。' }] };
}
