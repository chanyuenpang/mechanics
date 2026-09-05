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
  try { validateWorkspace(candidate); }
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
  try { validateWorkspace(candidate); }
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
  try { validateWorkspace(candidate); } catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v9 → v10 候选未通过全量校验：' + error.message, error); }
  return { root, from: 9, to: 10, revision: revisionOf(snapshots, discovered.directories), documents: [
    { path: 'workspace.json', document: nextManifest },
    ...nextMechanics.map(document => ({ path: files.find(item => item.kind === 'mechanic' && item.id === document.id)?.path, document })),
  ], summary: { workspace: 1, mechanics: nextMechanics.length, rulesRekeyed: nextMechanics.flatMap(item => item.edges).length } };
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
  try { validateWorkspace(candidate); }
  catch (error) { fail('MIGRATION_VALIDATION_FAILED', 'v9 悬空节点修复候选未通过全量校验：' + error.message, error); }
  return { root, from: 9, to: 9, revision: revisionOf(snapshots, discovered.directories), documents: [
    { path: 'workspace.json', document: nextManifest },
    ...nextMechanics.map(document => ({ path: files.find(item => item.kind === 'mechanic' && item.id === document.id)?.path, document })),
    ...nextViews.map(document => ({ path: files.find(item => item.kind === 'view' && item.id === document.id)?.path, document })),
  ], summary: { mechanics: nextMechanics.length, views: nextViews.length, danglingNodesRemoved: missing.size } };
}
