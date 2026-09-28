import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { discover, readDocument } from './workspace.mjs';
import { validateWorkspace, ContractError } from '../domain/validate.mjs';
import { semanticRuleId } from '../domain/identity.mjs';
export function mergeRuleCondition(edge) {
  const result = structuredClone(edge);
  if (!Object.hasOwn(result, 'condition')) return result;
  if (typeof result.condition !== 'string' || (result.ruleText !== undefined && typeof result.ruleText !== 'string')) {
    throw new ContractError('INVALID_DOCUMENT', '规则文字和旧条件必须是字符串：' + result.id);
  }
  if (result.condition.trim()) {
    result.ruleText = result.ruleText?.trim()
      ? result.ruleText + '\n条件约束：' + result.condition
      : result.condition;
  }
  delete result.condition;
  return result;
}

const fail = (code, message, cause) => { throw Object.assign(new ContractError(code, message), cause ? { cause } : {}); };

// 唯一的迁移链定义：显式 migrate、migrate-project 与打开项目时的自动升级都消费这张表，
// 避免多处各写一份而漂移。只有存在一跳的版本才可以被自动升级改写。
export const WORKSPACE_MIGRATION_STEPS = Object.freeze({ 7: 8, 8: 9, 9: 10, 10: 12, 11: 12, 12: 13, 13: 14 });
export const MIGRATABLE_WORKSPACE_VERSIONS = Object.freeze(Object.keys(WORKSPACE_MIGRATION_STEPS).map(Number));
export const CURRENT_WORKSPACE_VERSION = 14;
export function workspaceMigrationPlan(from) {
  const steps = [];
  for (let version = from; WORKSPACE_MIGRATION_STEPS[version] !== undefined; version = WORKSPACE_MIGRATION_STEPS[version]) {
    steps.push({ from: version, to: WORKSPACE_MIGRATION_STEPS[version] });
  }
  return steps;
}
// 历史协议的迁移候选不能交给 v11 schema 校验；它们尚未拥有 rules.json。
// 这里仅验证跨文件不变量，最终 v10 → v11 仍必须通过完整当前合同回读。
function validateLegacyCandidate({ manifest, definitions, mechanics, views = [] }) {
  if (!manifest?.id || !Array.isArray(definitions?.nodes)) fail('MIGRATION_VALIDATION_FAILED', '历史候选缺少工作区或概念定义。');
  const ids = new Set(definitions.nodes.map(node => node.id));
  if (ids.size !== definitions.nodes.length) fail('MIGRATION_VALIDATION_FAILED', '历史候选的概念 ID 重复。');
  for (const document of [definitions, ...mechanics, ...views]) if (document.workspaceId !== manifest.id) {
    fail('MIGRATION_VALIDATION_FAILED', '历史候选存在工作区归属不一致。');
  }
  for (const mechanic of mechanics) {
    for (const id of mechanic.nodeIds ?? []) if (!ids.has(id)) fail('MIGRATION_VALIDATION_FAILED', `机制 ${mechanic.id} 引用了不存在的概念：${id}`);
    for (const edge of mechanic.edges ?? []) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) fail('MIGRATION_VALIDATION_FAILED', `机制 ${mechanic.id} 的规则端点引用不存在的概念：${edge.id}`);
    }
  }
}
const revisionOf = (snapshots, directories) => {
  const hash = createHash('sha256');
  for (const [file, raw] of [...snapshots].sort(([a], [b]) => a.localeCompare(b))) hash.update(JSON.stringify([file, raw]));
  hash.update(JSON.stringify(directories));
  return hash.digest('hex');
};

// 迁移读取故意不进入常规 readWorkspace；常规入口始终严格拒绝 v7。
export async function planV7ToV8Migration(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map();
  const read = async file => {
    const result = await readDocument(root, file);
    snapshots.set(file, result.raw);
    return result.document;
  };
  const manifest = await read('workspace.json');
  if (manifest?.kind !== 'workspace' || manifest.schemaVersion !== 7) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只支持 workspace v7 → v8；当前工作区版本为 v' + String(manifest?.schemaVersion));
  }
  let definitions, mechanics, views, files, directories;
  try {
    definitions = await read(manifest.definitions);
    const discovered = await discover(root); directories = discovered.directories;
    mechanics = [];
    for (const path of discovered.mechanicPaths) mechanics.push(await read(path));
    views = [];
    for (const path of discovered.viewPaths) views.push(await read(path));
    files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' }, { kind: 'definitions', path: manifest.definitions },
      ...mechanics.map((item, index) => ({ kind: 'mechanic', id: item.id, path: discovered.mechanicPaths[index] })),
      ...views.map((item, index) => ({ kind: 'view', id: item.id, path: discovered.viewPaths[index] }))];
  } catch (error) {
    fail('MIGRATION_VALIDATION_FAILED', '读取 v7 工作区失败：' + error.message, error);
  }
  if (definitions?.kind !== 'definitions' || definitions.schemaVersion !== 3
    || mechanics.some(item => item?.kind !== 'mechanic' || item.schemaVersion !== 3)
    || views.some(item => item?.kind !== 'view' || item.schemaVersion !== 2)) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只接受 definitions/mechanic v3 与 view v2 的完整 v7 工作区');
  }
  const nextManifest = { ...structuredClone(manifest), schemaVersion: 8 };
  const nextDefinitions = { ...structuredClone(definitions), schemaVersion: 4 };
  const nextMechanics = mechanics.map(mechanic => ({ ...structuredClone(mechanic), schemaVersion: 4,
    edges: mechanic.edges.map(mergeRuleCondition).map(edge => edge.relation === 'belongsTo'
      ? (() => { const { sign, inheritance, ...rest } = edge; return { ...rest, relation: 'specializes' }; })()
      : { ...edge, inheritance: { mode: 'none' } }) }));
  const nextViews = views.map(view => ({
    ...structuredClone(view),
    schemaVersion: 3,
    structuralPresentation: 'line',
  }));
  const candidate = { manifest: nextManifest, definitions: nextDefinitions, mechanics: nextMechanics, views: nextViews, files };
  try { validateLegacyCandidate(candidate); }
  catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v7 → v8 候选未通过全量校验：' + error.message, error); }
  const documents = [
    { path: 'workspace.json', document: nextManifest }, { path: manifest.definitions, document: nextDefinitions },
    ...nextMechanics.map((document, index) => ({ path: files.find(item => item.kind === 'mechanic' && item.id === document.id)?.path, document })),
    ...nextViews.map((document, index) => ({ path: files.find(item => item.kind === 'view' && item.id === document.id)?.path, document })),
  ];
  return { root, from: 7, to: 8, revision: revisionOf(snapshots, directories), documents,
    summary: { workspace: 1, definitions: 1, mechanics: nextMechanics.length, views: nextViews.length,
      renamedRelations: mechanics.flatMap(item => item.edges).filter(edge => edge.relation === 'belongsTo').length,
      influenceInheritanceAdded: mechanics.flatMap(item => item.edges).filter(edge => edge.relation === 'influence').length,
      derivedRulesCreated: 0 } };
}

// v8 把限定误存为 definitions 节点；v9 将其收回到单条规则的端点限定词。
export async function planV8ToV9Migration(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map();
  const read = async file => {
    const result = await readDocument(root, file);
    snapshots.set(file, result.raw);
    return result.document;
  };
  const manifest = await read('workspace.json');
  if (manifest?.kind !== 'workspace' || manifest.schemaVersion !== 8) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只支持 workspace v8 → v9；当前工作区版本为 v' + String(manifest?.schemaVersion));
  }
  let definitions, mechanics, views, files, directories;
  try {
    definitions = await read(manifest.definitions);
    const discovered = await discover(root); directories = discovered.directories;
    mechanics = [];
    for (const path of discovered.mechanicPaths) mechanics.push(await read(path));
    views = [];
    for (const path of discovered.viewPaths) views.push(await read(path));
    files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' }, { kind: 'definitions', path: manifest.definitions },
      ...mechanics.map((item, index) => ({ kind: 'mechanic', id: item.id, path: discovered.mechanicPaths[index] })),
      ...views.map((item, index) => ({ kind: 'view', id: item.id, path: discovered.viewPaths[index] }))];
  } catch (error) {
    fail('MIGRATION_VALIDATION_FAILED', '读取 v8 工作区失败：' + error.message, error);
  }
  if (definitions?.kind !== 'definitions' || definitions.schemaVersion !== 4
    || mechanics.some(item => item?.kind !== 'mechanic' || item.schemaVersion !== 4)
    || views.some(item => item?.kind !== 'view' || item.schemaVersion !== 3)) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只接受 definitions/mechanic v4 与 view v3 的完整 v8 工作区');
  }
  const qualified = new Map(definitions.nodes.filter(node => node.baseConceptId).map(node => [node.id, {
    conceptId: node.baseConceptId, qualifiers: structuredClone(node.qualifiers),
  }]));
  const endpoint = id => qualified.get(id) ?? { conceptId: id, qualifiers: undefined };
  const migrateEdge = edge => {
    // 旧的“限定节点 → 基础概念”只是错误的限定表达，不能迁为 taxonomy。
    if (edge.relation === 'specializes' && (qualified.has(edge.source) || qualified.has(edge.target))) return null;
    const source = endpoint(edge.source), target = endpoint(edge.target);
    const migrated = { ...structuredClone(edge), source: source.conceptId, target: target.conceptId };
    if (source.qualifiers) migrated.sourceQualifiers = source.qualifiers;
    if (target.qualifiers) migrated.targetQualifiers = target.qualifiers;
    migrated.id = semanticRuleId(migrated.source, migrated.target, new Set(), migrated.sourceQualifiers, migrated.targetQualifiers);
    return migrated;
  };
  const migratePositions = positions => Object.fromEntries(Object.entries(positions).filter(([id]) => !qualified.has(id)));
  const nextManifest = { ...structuredClone(manifest), schemaVersion: 9,
    compositions: manifest.compositions.map(composition => ({ ...composition,
      collapsedNodeIds: composition.collapsedNodeIds.filter(id => !qualified.has(id)), positions: migratePositions(composition.positions) })),
    ...(manifest.lastView?.graphIds ? { lastView: { ...manifest.lastView,
      collapsedNodeIds: manifest.lastView.collapsedNodeIds.filter(id => !qualified.has(id)), positions: migratePositions(manifest.lastView.positions) } } : {}) };
  const nextDefinitions = { ...structuredClone(definitions), schemaVersion: 5,
    nodes: definitions.nodes.filter(node => !qualified.has(node.id)).map(node => {
      const { baseConceptId, qualifiers, ...base } = node; return base;
    }), positions: migratePositions(definitions.positions) };
  const nextMechanics = mechanics.map(mechanic => ({ ...structuredClone(mechanic), schemaVersion: 5,
    nodeIds: [...new Set(mechanic.nodeIds.map(id => endpoint(id).conceptId))],
    edges: mechanic.edges.map(migrateEdge).filter(Boolean), positions: migratePositions(mechanic.positions) }));
  const nextViews = views.map(view => ({ ...structuredClone(view),
    collapsedNodeIds: view.collapsedNodeIds.filter(id => !qualified.has(id)), positions: migratePositions(view.positions) }));
  const candidate = { manifest: nextManifest, definitions: nextDefinitions, mechanics: nextMechanics, views: nextViews, files };
  try { validateLegacyCandidate(candidate); }
  catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v8 → v9 候选未通过全量校验：' + error.message, error); }
  const documents = [
    { path: 'workspace.json', document: nextManifest }, { path: manifest.definitions, document: nextDefinitions },
    ...nextMechanics.map(document => ({ path: files.find(item => item.kind === 'mechanic' && item.id === document.id)?.path, document })),
    ...nextViews.map(document => ({ path: files.find(item => item.kind === 'view' && item.id === document.id)?.path, document })),
  ];
  return { root, from: 8, to: 9, revision: revisionOf(snapshots, directories), documents,
    summary: { workspace: 1, definitions: 1, mechanics: nextMechanics.length, views: nextViews.length,
      qualifiedNodesRemoved: qualified.size,
      specializesRemoved: mechanics.flatMap(item => item.edges).filter(edge => edge.relation === 'specializes' && (qualified.has(edge.source) || qualified.has(edge.target))).length } };
}

// v10 将规则身份收紧为有序概念对，限定词不再允许制造并行规则。
export async function planV9ToV10Migration(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map();
  const read = async file => { const result = await readDocument(root, file); snapshots.set(file, result.raw); return result.document; };
  const manifest = await read('workspace.json');
  if (manifest?.kind !== 'workspace' || manifest.schemaVersion !== 9) fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只支持 workspace v9 → v10；当前工作区版本为 v' + String(manifest?.schemaVersion));
  const definitions = await read(manifest.definitions), discovered = await discover(root), mechanics = [], views = [];
  for (const path of discovered.mechanicPaths) mechanics.push(await read(path));
  for (const path of discovered.viewPaths) views.push(await read(path));
  if (definitions?.schemaVersion !== 5 || mechanics.some(item => item?.schemaVersion !== 5) || views.some(item => item?.schemaVersion !== 3)) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只接受 definitions v5、mechanic v5 与 view v3 的完整 v9 工作区');
  }
  const seen = new Map();
  for (const mechanic of mechanics) for (const edge of mechanic.edges) {
    const key = `${edge.source}\u0000${edge.target}`, existing = seen.get(key) ?? [];
    existing.push({ mechanicId: mechanic.id, edgeId: edge.id }); seen.set(key, existing);
  }
  const conflicts = [...seen.entries()].filter(([, edges]) => edges.length > 1);
  if (conflicts.length) fail('DUPLICATE_ENDPOINT_RULE', 'v9 → v10 发现同一有向概念对的多条规则；请先显式处理冲突。', { conflicts: conflicts.map(([pair, edges]) => ({ pair: pair.split('\u0000'), edges })) });
  const nextManifest = { ...structuredClone(manifest), schemaVersion: 10 };
  const nextMechanics = mechanics.map(mechanic => ({ ...structuredClone(mechanic), schemaVersion: 6,
    edges: mechanic.edges.map(edge => ({ ...edge, id: semanticRuleId(edge.source, edge.target, new Set()) })) }));
  const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' }, { kind: 'definitions', path: manifest.definitions },
    ...mechanics.map((item, index) => ({ kind: 'mechanic', id: item.id, path: discovered.mechanicPaths[index] })),
    ...views.map((item, index) => ({ kind: 'view', id: item.id, path: discovered.viewPaths[index] }))];
  const candidate = { manifest: nextManifest, definitions, mechanics: nextMechanics, views, files };
  try { validateLegacyCandidate(candidate); } catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v9 → v10 候选未通过跨文件校验：' + error.message, error); }
  return { root, from: 9, to: 10, revision: revisionOf(snapshots, discovered.directories), documents: [
    { path: 'workspace.json', document: nextManifest },
    ...nextMechanics.map(document => ({ path: files.find(item => item.kind === 'mechanic' && item.id === document.id)?.path, document })),
  ], summary: { workspace: 1, mechanics: nextMechanics.length, rulesRekeyed: nextMechanics.flatMap(item => item.edges).length } };
}

// v11 将规则从机制图的编辑投影中移出，改由 workspace 唯一 rules.json 持有。
export async function planV10ToV11Migration(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map();
  const read = async file => { const result = await readDocument(root, file); snapshots.set(file, result.raw); return result.document; };
  const manifest = await read('workspace.json');
  if (manifest?.kind !== 'workspace' || manifest.schemaVersion !== 10) fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只支持 workspace v10 → v11；当前工作区版本为 v' + String(manifest?.schemaVersion));
  const definitions = await read(manifest.definitions), discovered = await discover(root), mechanics = [], views = [];
  for (const path of discovered.mechanicPaths) mechanics.push(await read(path));
  for (const path of discovered.viewPaths) views.push(await read(path));
  if (definitions?.schemaVersion !== 5 || mechanics.some(item => item?.schemaVersion !== 6) || views.some(item => item?.schemaVersion !== 3)) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只接受 definitions v5、mechanic v6 与 view v3 的完整 v10 工作区');
  }
  const rules = mechanics.flatMap(mechanic => mechanic.edges.map(edge => structuredClone(edge)));
  const seen = new Map();
  for (const rule of rules) {
    const pair = `${rule.source}\u0000${rule.target}`;
    if (seen.has(pair)) fail('DUPLICATE_ENDPOINT_RULE', 'v10 → v11 发现同一有向概念对的多条规则，拒绝猜测归并。', {
      conflicts: [{ pair: pair.split('\u0000'), ruleIds: [seen.get(pair), rule.id] }],
    });
    seen.set(pair, rule.id);
  }
  const normalizeTag = value => String(value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  const tags = new Map();
  for (const node of definitions.nodes) for (const raw of node.tags ?? []) {
    const id = String(raw).normalize('NFKC').trim().replace(/\s+/gu, ' '), key = normalizeTag(raw);
    if (key && !tags.has(key)) tags.set(key, { id, displayName: id, color: '#6B7280' });
  }
  const nextManifest = { ...structuredClone(manifest), schemaVersion: 12, definitions: 'definitions.json', rules: 'rules.json' };
  const nextDefinitions = { ...structuredClone(definitions), schemaVersion: 7, tagDefinitions: [...tags.values()], nodes: definitions.nodes.map(node => {
    const { tags: rawTags, ...next } = node;
    const tagIds = [...new Map((rawTags ?? []).map(raw => [normalizeTag(raw), tags.get(normalizeTag(raw))?.id]).filter(([, id]) => id)).values()];
    return tagIds.length ? { ...next, tagIds } : next;
  }) };
  const nextRules = { schemaVersion: 1, kind: 'rules', workspaceId: manifest.id, rules };
  const nextMechanics = mechanics.map(mechanic => ({ schemaVersion: 7, kind: 'mechanic', workspaceId: mechanic.workspaceId,
    id: mechanic.id, name: mechanic.name, scope: mechanic.scope, focusNodeIds: [...mechanic.nodeIds],
    pinnedRuleIds: mechanic.edges.map(edge => edge.id), positions: structuredClone(mechanic.positions),
    ...(mechanic.projectionPositions ? { projectionPositions: structuredClone(mechanic.projectionPositions) } : {}),
    ...(mechanic.routeCache ? { routeCache: structuredClone(mechanic.routeCache) } : {}) }));
  const nextViews = views.map(view => ({ ...structuredClone(view), schemaVersion: 4, focusNodeIds: [], pinnedRuleIds: [] }));
  const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' }, { kind: 'definitions', path: 'definitions.json' }, { kind: 'rules', path: 'rules.json' },
    ...mechanics.map((item, index) => ({ kind: 'mechanic', id: item.id, path: discovered.mechanicPaths[index] })),
    ...views.map((item, index) => ({ kind: 'view', id: item.id, path: discovered.viewPaths[index] }))];
  const candidate = { manifest: nextManifest, definitions: nextDefinitions, rules: nextRules, mechanics: nextMechanics, views: nextViews, files };
  try { validateLegacyCandidate(candidate); } catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v10 → v11 候选未通过跨文件校验：' + error.message, error); }
  return { root, from: 10, to: 12, revision: revisionOf(snapshots, discovered.directories), documents: [
    { path: 'workspace.json', document: nextManifest }, { path: 'definitions.json', document: nextDefinitions, create: true },
    { path: 'rules.json', document: nextRules, create: true }, { path: manifest.definitions, delete: true },
    ...nextMechanics.map(document => ({ path: files.find(item => item.kind === 'mechanic' && item.id === document.id)?.path, document })),
    ...nextViews.map(document => ({ path: files.find(item => item.kind === 'view' && item.id === document.id)?.path, document })),
  ], summary: { workspace: 1, definitions: 1, rules: rules.length, mechanics: nextMechanics.length, views: nextViews.length, tags: tags.size } };
}

// v12 将自由文本标签收束为 definitions 内由稳定 ID 引用的工作区资产。
export async function planV11ToV12Migration(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map();
  const read = async file => { const result = await readDocument(root, file); snapshots.set(file, result.raw); return result.document; };
  const manifest = await read('workspace.json');
  if (manifest?.kind !== 'workspace' || manifest.schemaVersion !== 11) fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只支持 workspace v11 → v12；当前工作区版本为 v' + String(manifest?.schemaVersion));
  const definitions = await read(manifest.definitions), rules = await read(manifest.rules), discovered = await discover(root), mechanics = [], views = [];
  for (const path of discovered.mechanicPaths) mechanics.push(await read(path));
  for (const path of discovered.viewPaths) views.push(await read(path));
  if (definitions?.schemaVersion !== 6 || rules?.schemaVersion !== 1 || mechanics.some(item => item?.schemaVersion !== 7) || views.some(item => item?.schemaVersion !== 4)) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只接受 definitions v6、rules v1、mechanic v7 与 view v4 的完整 v11 工作区');
  }
  const tags = new Map();
  const normalizeTag = value => String(value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  for (const node of definitions.nodes) for (const raw of node.tags ?? []) {
    const id = String(raw).normalize('NFKC').trim().replace(/\s+/gu, ' '), key = normalizeTag(raw);
    if (!key) continue;
    if (!tags.has(key)) tags.set(key, { id, displayName: id, color: '#6B7280' });
  }
  const nextManifest = { ...structuredClone(manifest), schemaVersion: 12 };
  const nextDefinitions = { ...structuredClone(definitions), schemaVersion: 7,
    tagDefinitions: [...tags.values()], nodes: definitions.nodes.map(node => {
      const { tags: rawTags, ...next } = node;
      const tagIds = [...new Map((rawTags ?? []).map(raw => [normalizeTag(raw), tags.get(normalizeTag(raw))?.id]).filter(([, id]) => id)).values()];
      return tagIds.length ? { ...next, tagIds } : next;
    }) };
  const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' }, { kind: 'definitions', path: manifest.definitions }, { kind: 'rules', path: manifest.rules },
    ...mechanics.map((item, index) => ({ kind: 'mechanic', id: item.id, path: discovered.mechanicPaths[index] })), ...views.map((item, index) => ({ kind: 'view', id: item.id, path: discovered.viewPaths[index] }))];
  const candidate = { manifest: nextManifest, definitions: nextDefinitions, rules, mechanics, views, files };
  try { validateLegacyCandidate(candidate); } catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v11 → v12 候选未通过跨文件校验：' + error.message, error); }
  return { root, from: 11, to: 12, revision: revisionOf(snapshots, discovered.directories), documents: [
    { path: 'workspace.json', document: nextManifest }, { path: manifest.definitions, document: nextDefinitions }
  ], summary: { workspace: 1, definitions: 1, tags: tags.size } };
}

export async function planV12ToV13Migration(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map();
  const read = async file => { const result = await readDocument(root, file); snapshots.set(file, result.raw); return result.document; };
  const manifest = await read('workspace.json');
  if (manifest?.kind !== 'workspace' || manifest.schemaVersion !== 12) fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只支持 workspace v12 → v13；当前工作区版本为 v' + String(manifest?.schemaVersion));
  const definitions = await read(manifest.definitions), rules = await read(manifest.rules), discovered = await discover(root), mechanics = [], views = [];
  for (const path of discovered.mechanicPaths) mechanics.push(await read(path));
  for (const path of discovered.viewPaths) views.push(await read(path));
  if (definitions?.schemaVersion !== 7 || rules?.schemaVersion !== 1 || mechanics.some(item => item?.schemaVersion !== 7) || views.some(item => item?.schemaVersion !== 4)) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只接受 definitions v7、rules v1、mechanic v7 与 view v4 的完整 v12 工作区');
  }
  const taxonomyPresentation = { mode: 'label', expandedNodeIds: [] };
  const nextManifest = { ...structuredClone(manifest), schemaVersion: 13 };
  const nextMechanics = mechanics.map(item => ({ ...structuredClone(item), schemaVersion: 8, taxonomyPresentation: structuredClone(taxonomyPresentation) }));
  const nextViews = views.map(item => ({ ...structuredClone(item), schemaVersion: 5, taxonomyPresentation: structuredClone(taxonomyPresentation) }));
  const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' }, { kind: 'definitions', path: manifest.definitions }, { kind: 'rules', path: manifest.rules },
    ...mechanics.map((item, index) => ({ kind: 'mechanic', id: item.id, path: discovered.mechanicPaths[index] })), ...views.map((item, index) => ({ kind: 'view', id: item.id, path: discovered.viewPaths[index] }))];
  const candidate = { manifest: nextManifest, definitions, rules, mechanics: nextMechanics, views: nextViews, files };
  try { validateWorkspace({ ...candidate, manifest: { ...nextManifest, schemaVersion: 14 }, mechanics: nextMechanics.map(item => ({ ...item, schemaVersion: 9, implementationStatus: 'design' })) }); }
  catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v12 → v13 候选未通过全量校验：' + error.message, error); }
  return { root, from: 12, to: 13, revision: revisionOf(snapshots, discovered.directories), documents: [
    { path: 'workspace.json', document: nextManifest },
    ...nextMechanics.map(document => ({ path: files.find(item => item.kind === 'mechanic' && item.id === document.id)?.path, document })),
    ...nextViews.map(document => ({ path: files.find(item => item.kind === 'view' && item.id === document.id)?.path, document })),
  ], summary: { workspace: 1, mechanics: nextMechanics.length, views: nextViews.length } };
}

// v14 将实现状态变为显式作者声明：所有旧图只能迁为 design，绝不推定已实现。
export async function planV13ToV14Migration(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map();
  const read = async file => { const result = await readDocument(root, file); snapshots.set(file, result.raw); return result.document; };
  const manifest = await read('workspace.json');
  if (manifest?.kind !== 'workspace' || manifest.schemaVersion !== 13) fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只支持 workspace v13 → v14；当前工作区版本为 v' + String(manifest?.schemaVersion));
  const definitions = await read(manifest.definitions), rules = await read(manifest.rules), discovered = await discover(root), mechanics = [], views = [];
  for (const path of discovered.mechanicPaths) mechanics.push(await read(path));
  for (const path of discovered.viewPaths) views.push(await read(path));
  if (definitions?.schemaVersion !== 7 || rules?.schemaVersion !== 1 || mechanics.some(item => item?.kind !== 'mechanic' || item.schemaVersion !== 8 || Object.hasOwn(item, 'implementationStatus'))
    || views.some(item => item?.kind !== 'view' || item.schemaVersion !== 5)) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '迁移只接受 definitions v7、rules v1、无实现状态的 mechanic v8 与 view v5 的完整 v13 工作区');
  }
  const nextManifest = { ...structuredClone(manifest), schemaVersion: 14 };
  const nextMechanics = mechanics.map(item => ({ ...structuredClone(item), schemaVersion: 9, implementationStatus: 'design' }));
  const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' }, { kind: 'definitions', path: manifest.definitions }, { kind: 'rules', path: manifest.rules },
    ...mechanics.map((item, index) => ({ kind: 'mechanic', id: item.id, path: discovered.mechanicPaths[index] })),
    ...views.map((item, index) => ({ kind: 'view', id: item.id, path: discovered.viewPaths[index] }))];
  try { validateWorkspace({ manifest: nextManifest, definitions, rules, mechanics: nextMechanics, views, files }); }
  catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v13 → v14 候选未通过全量校验：' + error.message, error); }
  return { root, from: 13, to: 14, revision: revisionOf(snapshots, discovered.directories), documents: [
    { path: 'workspace.json', document: nextManifest },
    ...nextMechanics.map((document, index) => ({ path: discovered.mechanicPaths[index], document })),
  ], summary: { workspace: 1, mechanics: nextMechanics.length, views: views.length, designatedAsDesign: nextMechanics.length } };
}

// 只修复一次已确认的跨文件半提交：definitions 已删除、机制仍保留无规则节点引用。
export async function planV9DanglingNodeRepair(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const snapshots = new Map();
  const read = async file => { const result = await readDocument(root, file); snapshots.set(file, result.raw); return result.document; };
  const manifest = await read('workspace.json');
  if (manifest?.kind !== 'workspace' || manifest.schemaVersion !== 9) {
    fail('MIGRATION_VERSION_UNSUPPORTED', '修复只接受 workspace v9；当前工作区版本为 v' + String(manifest?.schemaVersion));
  }
  const definitions = await read(manifest.definitions), discovered = await discover(root), mechanics = [], views = [];
  for (const path of discovered.mechanicPaths) mechanics.push(await read(path));
  for (const path of discovered.viewPaths) views.push(await read(path));
  const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' }, { kind: 'definitions', path: manifest.definitions },
    ...mechanics.map((item, index) => ({ kind: 'mechanic', id: item.id, path: discovered.mechanicPaths[index] })),
    ...views.map((item, index) => ({ kind: 'view', id: item.id, path: discovered.viewPaths[index] }))];
  const defined = new Set(definitions.nodes.map(node => node.id));
  const missing = new Set(mechanics.flatMap(mechanic => mechanic.nodeIds.filter(id => !defined.has(id))));
  if (!missing.size) fail('MIGRATION_NOT_NEEDED', '未发现缺失概念的机制节点引用。');
  for (const mechanic of mechanics) for (const edge of mechanic.edges) if (!defined.has(edge.source) || !defined.has(edge.target)) {
    fail('MIGRATION_VALIDATION_FAILED', `缺失概念仍被规则端点引用，拒绝猜测修复：${mechanic.id}/${edge.id}`);
  }
  const removeLayout = positions => Object.fromEntries(Object.entries(positions).filter(([id]) => !missing.has(id)));
  const nextMechanics = mechanics.map(mechanic => ({ ...structuredClone(mechanic),
    nodeIds: mechanic.nodeIds.filter(id => defined.has(id)), positions: removeLayout(mechanic.positions) }));
  const nextViews = views.map(view => ({ ...structuredClone(view),
    collapsedNodeIds: view.collapsedNodeIds.filter(id => defined.has(id)), positions: removeLayout(view.positions) }));
  const nextManifest = { ...structuredClone(manifest),
    compositions: manifest.compositions.map(composition => ({ ...composition,
      collapsedNodeIds: composition.collapsedNodeIds.filter(id => defined.has(id)), positions: removeLayout(composition.positions) })),
    ...(manifest.lastView?.graphIds ? { lastView: { ...manifest.lastView,
      collapsedNodeIds: manifest.lastView.collapsedNodeIds.filter(id => defined.has(id)), positions: removeLayout(manifest.lastView.positions) } } : {}) };
  const candidate = { manifest: nextManifest, definitions, mechanics: nextMechanics, views: nextViews, files };
  try { validateLegacyCandidate(candidate); }
  catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v9 悬空节点修复候选未通过全量校验：' + error.message, error); }
  return { root, from: 9, to: 9, revision: revisionOf(snapshots, discovered.directories), documents: [
    { path: 'workspace.json', document: nextManifest },
    ...nextMechanics.map(document => ({ path: files.find(item => item.kind === 'mechanic' && item.id === document.id)?.path, document })),
    ...nextViews.map(document => ({ path: files.find(item => item.kind === 'view' && item.id === document.id)?.path, document })),
  ], summary: { mechanics: nextMechanics.length, views: nextViews.length, danglingNodesRemoved: missing.size } };
}
