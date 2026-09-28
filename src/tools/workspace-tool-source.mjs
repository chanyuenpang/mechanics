#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertDocument, validateWorkspace } from '../domain/validate.mjs';
import { discover, readDocument, workspacePath, ensureWorkspaceDirectory, semanticWorkspaceDocument } from '../server/workspace.mjs';
import { acquireWorkspaceLock, commitFiles, encode } from '../server/files.mjs';
import { selectCreatedMechanic, mechanicFolderOf } from '../domain/document-export.mjs';

// 本文件是离线工具的生成源；安装后的单文件由 scripts/build-workspace-tool.mjs 构建。

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const workspace = join(root, '.mechanics'), drafts = join(workspace, '.agent-drafts');
const fail = (code, message, details = {}) => { throw Object.assign(new Error(message), { code, details }); };
const hash = value => createHash('sha256').update(value).digest('hex');
// 所有 JSON（含草稿）复用安全读取；相关资源 revision 与服务端使用相同语义归一化。
const relativeFile = path => relative(workspace, path).split(sep).join('/');
const parse = async path => {
  const { document: value, raw, actual } = await readDocument(workspace, relativeFile(path));
  return { path: actual, raw, value, revision: hash(JSON.stringify(semanticWorkspaceDocument(value))) };
};
const args = values => { const positionals = [], options = {}; for (let i = 0; i < values.length; i++) { const item = values[i]; if (!item.startsWith('--')) { positionals.push(item); continue; } const key = item.slice(2), value = values[++i]; if (!key || value === undefined || value.startsWith('--') || Object.hasOwn(options, key)) fail('TOOL_INVALID', `参数无效：${item}`); options[key] = value; } return { positionals, options }; };
const emit = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const folderSegment = (value, location) => { if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\u0000-\u001f<>:"|?*]/u.test(value)) fail('TOOL_INVALID', `${location} 必须是单段安全目录名`); return value; };
const folder = (value, location = 'folder') => { if (value === undefined || value === '') return ''; if (typeof value !== 'string') fail('TOOL_INVALID', `${location} 无效`); return value.split('/').map(segment => folderSegment(segment, location)).join('/'); };
const mechanicDirectory = value => join(workspace, 'mechanics', ...value.split('/').filter(Boolean));
const mechanicFolder = file => mechanicFolderOf(relativeFile(file));
const candidateOf = data => ({ manifest: data.manifest.value, definitions: data.definitions.value, rules: data.rules.value,
  mechanics: data.mechanics.map(item => item.value), views: data.views.map(item => item.value), files: data.files });
async function snapshot({ validate = true, includeViews = true } = {}) {
  const manifest = await parse(join(workspace, 'workspace.json'));
  assertDocument(manifest.value, 'workspace', 'workspace.json');
  const definitions = await parse(await workspacePath(workspace, manifest.value.definitions));
  const rules = await parse(await workspacePath(workspace, manifest.value.rules));
  assertDocument(definitions.value, 'definitions', manifest.value.definitions);
  assertDocument(rules.value, 'rules', manifest.value.rules);
  const discovered = await discover(workspace);
  const mechanics = await Promise.all(discovered.mechanicPaths.map(file => parse(join(workspace, file))));
  // 只读查询不消费视图；保存候选和提交确认仍读取全部消费者。
  const views = includeViews ? await Promise.all(discovered.viewPaths.map(file => parse(join(workspace, file)))) : [];
  const resources = [manifest, definitions, rules, ...mechanics, ...views];
  const identities = resources.map(item => process.platform === 'win32' ? item.path.toLowerCase() : item.path);
  if (new Set(identities).size !== identities.length) fail('DUPLICATE_FILE', 'manifest 入口与发现资源重复引用同一文件');
  const nodes = definitions.value.nodes ?? [], edges = (rules.value.rules ?? []).map(edge => ({ ...edge, origin: { ruleId: edge.id } }));
  const data = { manifest, definitions, rules, mechanics, views,
    files: [...mechanics, ...views].map(item => ({ kind: item.value.kind, id: item.value.id, path: relativeFile(item.path) })),
    folders: discovered.directories.filter(path => path.startsWith('mechanics/')).map(path => path.slice('mechanics/'.length)),
    nodes, edges, revision: hash(resources.map(item => item.revision).join('\n')), nodeMap: new Map(nodes.map(node => [node.id, node])) };
  if (validate) validateWorkspace(candidateOf(data), { validateResourceReferences: includeViews });
  return data;
}
const operator = edge => edge.relation === 'specializes' ? 'is-a>' : edge.sign === 1 ? '+>' : edge.sign === -1 ? '->' : '?>';
const guide = () => ({
  contractVersion: 7,
  commands: ['scopes', 'search', 'graph', 'node', 'impact', 'draft open', 'draft validate', 'draft save', 'isa set'],
  workflow: ['draft open（已知 ID 直接打开；新图携带名称与范围）', '定向编辑三份草稿的相关内容，保留无关事实', 'draft save（自动校验与回读确认）'],
  optional: { guide: '首次需要字段合同时读取', scopes: '仅定位未知目标或目录', validate: '可选不保存 dry-run；不作为 save 前置' },
  conceptTemplate: { id: 'stable-concept-id', label: '概念名称', description: '概念定义。', tagIds: ['existing-tag-id'], agentLocked: false },
  influenceRuleTemplate: { id: 'source-concept-2-target-concept', source: 'source-concept', target: 'target-concept', relation: 'influence', sign: 1, inheritance: { mode: 'none' }, ruleText: '源概念如何影响目标概念。' },
  specializesRuleTemplate: { id: 'subtype-concept-2-supertype-concept', source: 'subtype-concept', target: 'supertype-concept', relation: 'specializes' },
  exportMaintenance: { createdMechanic: '新建机制图默认进入单独导出：curated 模式补一条独立选择，机制图所在的直接文件夹已选中则不补，视图永不自动进入导出清单', documents: '工具只维护导出清单；文档本身仍需显式生成（网页或 CLI）', failure: 'workspace.json 基线不符报 RESOURCE_REVISION_CONFLICT；写入或回读失败报 MIGRATION_WRITE_FAILED，并以 commitState/rollbackComplete/recovery 区分已回滚与结果待确认；已提交后的清理问题返回 saved:true 与 warnings，不能重提' },
  implementationStatus: { field: 'implementationStatus', allowedValues: ['design', 'implemented'], newMechanic: 'design', rule: '只有作者确认已在实际游戏中实现时才手动标 implemented；旧机制迁移一律 design' },
  mechanicSelection: { optionalField: 'ruleSelection', allowedValue: 'explicit', whenOmitted: '按 focusNodeIds 展开一跳规则并合入 pinnedRuleIds', whenExplicit: '节点保留 focusNodeIds 与固定规则端点；只投影 pinnedRuleIds 的规则，不展开相邻规则' },
  constraints: ['is-a 每个概念至多一个父概念，用 isa set 更换或清除；不要手写第二条 specializes 出边', '概念标签只引用 definitions.tagDefinitions 中已存在的 tagIds；显示名和颜色只在标签表维护', '所有持久化 ID 使用英文小写 kebab-case', '规则只存于 rules.json，ID 固定为 source-2-target', '同一有向端点对在全工作区只能有一条规则', 'mechanic 用 focusNodeIds 与 pinnedRuleIds 选择投影；省略 ruleSelection 时展开焦点邻接规则，explicit 时只投影固定规则与焦点节点', '限定词只属于 influence 规则端点', 'node 的 upstream 只表示发现上游的遍历方向；paths 中的 nodes、steps、chain 与 effect 始终按规则声明的 source → target 方向返回', '草稿不允许 positions、projectionPositions 或 routeCache', 'save 自动检查完整候选并回读确认；validate 仅可选 dry-run；不执行自动排版或文档导出', 'search --query 先精确解析，只有精确未命中才返回 resolution.status 为 fuzzy 的模糊候选（label、alias、id、description），候选只是线索，必须用其中的稳定 ID 再查一次，工具不会自动消歧', 'graph --ids 只投影请求集合内部已声明的规则；集合外端点、路径推导、视图、坐标与配色都不进入结果'],
});
const semanticId = value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) fail('TOOL_INVALID', `${field} 必须是非空文本`);
  return value.trim();
};
const object = (value, location) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DRAFT_VALIDATION_FAILED', `${location} 必须是对象`);
  return value;
};
const draftId = (value, location) => {
  if (!semanticId(value)) fail('DRAFT_VALIDATION_FAILED', `${location} 必须是英文小写语义 ID`);
  return value;
};
const noDraftGeometry = (document, location) => {
  object(document.positions, location + '.positions');
  if (Object.keys(document.positions).length || 'projectionPositions' in document || 'routeCache' in document)
    fail('DRAFT_GEOMETRY_FORBIDDEN', location + ' 草稿不允许坐标或路径缓存；布局由网页管理');
};
// 仅旧草稿结构错误保留兼容码；领域错误保留唯一 owner 的具体 code。
function assertDraftDocument(document, kind, location) {
  try { assertDocument(document, kind, location); }
  catch (error) {
    if (error.code !== 'INVALID_DOCUMENT') throw error;
    fail('DRAFT_VALIDATION_FAILED', error.message, { causeCode: error.code, details: error.details ?? { resource: location } });
  }
}
function assertAgentPermissions(previous, candidate, location) {
  const before = new Map(previous.nodes.map(node => [node.id, node]));
  const after = new Map(candidate.nodes.map(node => [node.id, node]));
  for (const node of previous.nodes) {
    const next = after.get(node.id);
    if (node.agentLocked && !isDeepStrictEqual(node, next))
      fail('AGENT_CONCEPT_LOCKED', location + ': 锁定概念不可修改或删除：' + node.id, { resource: location, field: 'nodes', id: node.id });
  }
  for (const node of candidate.nodes) if (node.agentLocked !== (before.get(node.id)?.agentLocked ?? false))
    fail('AGENT_LOCK_FORBIDDEN', location + ': Agent 不可更改 agentLocked：' + node.id, { resource: location, field: 'agentLocked', id: node.id });
}
function resolveNode(nodes, key) { const norm = key.trim().toLowerCase(); const id = nodes.find(node => node.id.toLowerCase() === norm); if (id) return { status: 'resolved', node: id, matchedBy: 'id' }; const candidates = nodes.filter(node => node.label?.trim().toLowerCase() === norm || (node.aliases ?? []).some(alias => alias.trim().toLowerCase() === norm)); if (candidates.length === 1) return { status: 'resolved', node: candidates[0], matchedBy: candidates[0].label?.trim().toLowerCase() === norm ? 'label' : 'alias' }; return candidates.length ? { status: 'ambiguous', candidates: candidates.map(node => ({ id: node.id, label: node.label })) } : { status: 'not_found' }; }
const FUZZY_FIELDS = [['label', 'prefix', 'label-prefix', 100, node => [node.label]], ['alias', 'prefix', 'alias-prefix', 90, node => node.aliases ?? []], ['label', 'contains', 'label-contains', 80, node => [node.label]], ['alias', 'contains', 'alias-contains', 70, node => node.aliases ?? []], ['id', 'contains', 'id-contains', 60, node => [node.id]], ['description', 'contains', 'description-contains', 40, node => [node.description]]];
const FUZZY_LIMIT = 20;
const fuzzyText = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
const fuzzyFieldHit = (texts, mode, needle, node) => texts(node).some(value => { const text = fuzzyText(value); return text ? (mode === 'prefix' ? text.startsWith(needle) : text.includes(needle)) : false; });
// 精确未命中时使用的模糊候选：只给线索，绝不自动消歧——调用方必须用候选中的稳定 ID 再查一次；同一字段只记最强那一档。
function fuzzyCandidates(nodes, key) {
  const needle = fuzzyText(key); if (!needle) return undefined;
  const matches = [];
  for (const node of nodes) { const matchedBy = [], scores = [], prefixed = new Set();
    for (const [field, mode, tier, score, texts] of FUZZY_FIELDS) { if (mode === 'contains' && prefixed.has(field)) continue; if (!fuzzyFieldHit(texts, mode, needle, node)) continue; if (mode === 'prefix') prefixed.add(field); matchedBy.push(tier); scores.push(score); }
    if (matchedBy.length) matches.push({ id: node.id, label: node.label, matchedBy, score: Math.max(...scores) }); }
  if (!matches.length) return undefined;
  matches.sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)));
  return { status: 'fuzzy', key, candidates: matches.slice(0, FUZZY_LIMIT), total: matches.length, truncated: matches.length > FUZZY_LIMIT };
}
function paths(edges, from, to, maxDepth = 16) { const out = new Map(); for (const edge of edges) (out.get(edge.source) ?? out.set(edge.source, []).get(edge.source)).push(edge); const queue = [{ ids: [from], steps: [] }], result = []; for (let i = 0; i < queue.length; i++) { const current = queue[i]; if (current.ids.at(-1) === to && current.steps.length) { result.push(current); continue; } if (current.steps.length >= maxDepth) continue; for (const edge of out.get(current.ids.at(-1)) ?? []) if (!current.ids.includes(edge.target)) queue.push({ ids: [...current.ids, edge.target], steps: [...current.steps, edge] }); } return result.sort((a,b) => a.steps.length - b.steps.length || a.ids.join('\0').localeCompare(b.ids.join('\0'))); }
function compact(path, map) {
  const steps = path.steps.map(edge => ({ from: edge.source, to: edge.target, operator: operator(edge), origin: edge.origin }));
  if (path.ids.length !== steps.length + 1 || steps.some((step, index) => step.from !== path.ids[index] || step.to !== path.ids[index + 1])) {
    fail('QUERY_PATH_DIRECTION_INVALID', '查询路径的节点顺序必须与规则声明方向一致');
  }
  const taxonomy = path.steps.some(edge => edge.relation === 'specializes');
  let sign = 1;
  for (const edge of path.steps) if (edge.relation === 'influence') sign = sign === 'random' || edge.sign === 'random' ? 'random' : sign * edge.sign;
  return { length: steps.length, nodes: path.ids.map(id => ({ id, label: map.get(id)?.label ?? id })), steps, chain: path.ids.map((id, i) => i ? `${steps[i - 1].operator} ${id}` : id).join(' '), kind: taxonomy ? (path.steps.every(edge => edge.relation === 'specializes') ? 'taxonomy' : 'mixed') : 'influence', effect: taxonomy ? null : sign === 1 ? 'positive' : sign === -1 ? 'negative' : 'random' };
}
async function withLock(fn) {
  const release = await acquireWorkspaceLock(workspace);
  let result, failure;
  try { result = await fn(); } catch (error) { failure = error; }
  try { await release(); } catch (error) {
    const warning = { code: error.code ?? 'LOCK_RELEASE_FAILED', message: error.message, resource: '.mechanics.lock' };
    if (result?.saved) (result.warnings ??= []).push(warning);
    else if (failure) failure.details = { ...failure.details, lockReleaseWarning: warning };
    else failure = error;
  }
  if (failure) throw failure;
  return result;
}
const draftFolderFor = id => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id)) fail('DRAFT_NOT_FOUND', '草稿 ID 无效');
  return join(drafts, id);
};
const structuralCopy = value => {
  const copy = structuredClone(value);
  if ('positions' in copy) copy.positions = {};
  delete copy.projectionPositions;
  delete copy.routeCache;
  return copy;
};
const retainedPositions = (positions, ids) => Object.fromEntries(Object.entries(positions ?? {}).filter(([id]) => ids.has(id)));
async function openDraft(mechanicId, options) {
  const data = await snapshot(), mechanic = data.mechanics.find(item => item.value.id === mechanicId);
  draftId(mechanicId, 'mechanic');
  const targetFolder = folder(options.folder);
  if (mechanic && (options.name !== undefined || options.scope !== undefined || options.folder !== undefined)) fail('DRAFT_TARGET_EXISTS', `机制已存在：${mechanicId}；重新打开时不要提供 --name、--scope 或 --folder`);
  if (!mechanic && (!semanticId(mechanicId) || options.name === undefined || options.scope === undefined)) fail('DRAFT_CREATE_METADATA_REQUIRED', '新机制 draft open 必须同时提供 --mechanic、--name 与 --scope');
  if (!mechanic && targetFolder && !data.folders.includes(targetFolder)) fail('FOLDER_NOT_FOUND', `机制目录不存在：${targetFolder}`);
  const document = mechanic?.value ?? { schemaVersion: 9, kind: 'mechanic', workspaceId: data.manifest.value.id, id: mechanicId,
    name: text(options.name, '机制名称'), scope: text(options.scope, '机制范围'), implementationStatus: 'design', focusNodeIds: [], pinnedRuleIds: [], positions: {},
    taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } };
  await ensureWorkspaceDirectory(workspace, '.agent-drafts'); const id = randomUUID(), draftFolder = join(drafts, id); await mkdir(draftFolder);
  const definitionsPath = join(draftFolder, 'definitions.json'), rulesPath = join(draftFolder, 'rules.json'), mechanicPath = join(draftFolder, 'mechanic.json');
  await writeFile(definitionsPath, JSON.stringify(structuralCopy(data.definitions.value), null, 2) + '\n');
  await writeFile(rulesPath, JSON.stringify(structuralCopy(data.rules.value), null, 2) + '\n');
  await writeFile(mechanicPath, JSON.stringify(structuralCopy(document), null, 2) + '\n');
  const { conceptTemplate, influenceRuleTemplate, specializesRuleTemplate, mechanicSelection } = guide();
  const meta = { id, workspaceId: data.manifest.value.id, mechanicId, definitionsRevision: data.definitions.revision, rulesRevision: data.rules.revision,
    // workspace.json 基线：新建机制图要顺带维护导出清单，缺基线就拒绝保存（不补默认值）。
    manifestRevision: data.manifest.revision, definitionsFile: relativeFile(data.definitions.path), rulesFile: relativeFile(data.rules.path),
    mechanicRevision: mechanic?.revision ?? null, targetFile: mechanic?.path ?? join(mechanicDirectory(targetFolder), `${mechanicId}.mechanic.json`), created: !mechanic };
  await writeFile(join(draftFolder, 'draft.json'), JSON.stringify(meta, null, 2) + '\n');
  return { contractVersion: 7, next: '编辑相关内容后 draft save；validate 仅可选 dry-run', contract: { conceptTemplate, influenceRuleTemplate, specializesRuleTemplate, mechanicSelection, fullLibraryDrafts: true, preserveUnrelatedEntries: true, agentLocks: '不可更改锁标记、修改或删除锁定概念', validation: '脚本校验全部机制与视图引用，无需人工全量通读', sequentialMechanics: true }, targetFile: meta.targetFile, mechanicId, draftId: id, draftPath: draftFolder, definitionsPath, rulesPath, mechanicPath, revision: data.revision, target: mechanic ? 'existing' : 'new',
    geometry: '已从草稿移除；保存时保留既有节点位置并清除过期路径缓存' };
}

// is-a 的可选辅助入口：作用在草稿的 rules.json 上，并同步该机制草稿的 pinnedRuleIds。
// 更换 = 替换该概念唯一的 specializes 出边；--parent none 表示清除。
async function setIsaParent(draftId, conceptId, parentOption) {
  const folder = draftFolderFor(draftId);
  const meta = (await parse(join(folder, 'draft.json'))).value;
  const draftDefinitions = await parse(join(folder, 'definitions.json')), draftRules = await parse(join(folder, 'rules.json')), draftMechanic = await parse(join(folder, 'mechanic.json'));
  const data = await snapshot();
  assertDraftDocument(draftDefinitions.value, 'definitions', 'definitions.json');
  assertDraftDocument(draftRules.value, 'rules', 'rules.json');
  assertDraftDocument(draftMechanic.value, 'mechanic', 'mechanic.json');
  const nodes = new Map(draftDefinitions.value.nodes.map(node => [node.id, node]));
  const validateLocal = (rules, mechanic) => validateWorkspace({ ...candidateOf(data), definitions: draftDefinitions.value, rules, mechanics: [mechanic], views: [] }, { validateResourceReferences: false });
  validateLocal(draftRules.value, draftMechanic.value);
  if (!nodes.has(conceptId)) fail('NODE_NOT_FOUND', `概念不存在：${conceptId}`);
  const parentId = parentOption === undefined || parentOption === null || parentOption === '' || parentOption === 'none' ? null : String(parentOption);
  if (parentId !== null) {
    if (!nodes.has(parentId)) fail('NODE_NOT_FOUND', `is-a 父概念不存在：${parentId}`);
    if (parentId === conceptId) fail('DRAFT_VALIDATION_FAILED', `概念 ${conceptId} 不能成为自己的 is-a 父概念（SPECIALIZES_SELF_LINK）`, { causeCode: 'SPECIALIZES_SELF_LINK', details: { id: conceptId } });
  }
  const rules = structuredClone(draftRules.value), mechanic = structuredClone(draftMechanic.value);
  const previous = rules.rules.find(rule => rule.relation === 'specializes' && rule.source === conceptId) ?? null;
  if ((previous?.target ?? null) === parentId) return { draftId, concept: conceptId, parent: parentId, changed: false, path: join(folder, 'rules.json') };
  const nextId = parentId === null ? null : `${conceptId}-2-${parentId}`;
  if (nextId && rules.rules.some(rule => rule.id === nextId)) fail('DRAFT_VALIDATION_FAILED', `概念 ${conceptId} 到 ${parentId} 已有其它规则，不能同时作为 is-a`);
  rules.rules = rules.rules.filter(rule => !(rule.relation === 'specializes' && rule.source === conceptId));
  if (nextId) rules.rules.push({ id: nextId, source: conceptId, target: parentId, relation: 'specializes' });
  if (previous) mechanic.pinnedRuleIds = mechanic.pinnedRuleIds.filter(id => id !== previous.id);
  if (nextId) {
    if (!mechanic.pinnedRuleIds.includes(nextId)) mechanic.pinnedRuleIds.push(nextId);
    for (const id of [conceptId, parentId]) if (!mechanic.focusNodeIds.includes(id)) mechanic.focusNodeIds.push(id);
  }
  validateLocal(rules, mechanic);
  await writeFile(join(folder, 'rules.json'), JSON.stringify(rules, null, 2) + '\n');
  await writeFile(join(folder, 'mechanic.json'), JSON.stringify(mechanic, null, 2) + '\n');
  return { draftId, concept: conceptId, parent: parentId, changed: true, removedRuleId: previous?.id ?? null, addedRuleId: nextId,
    rulesPath: join(folder, 'rules.json'), mechanicPath: join(folder, 'mechanic.json'), next: 'draft save（自动校验；不自动解除其他机制或视图的引用）' };
}
// validate 和 save 只在候选通过全部提交前门禁之后分叉；不颁发可复用校验票据。
async function prepareCandidate(id) {
  const folder = draftFolderFor(id);
  const meta = (await parse(join(folder, 'draft.json'))).value;
  const draftDefinitions = await parse(join(folder, 'definitions.json'));
  const draftRules = await parse(join(folder, 'rules.json'));
  const draftMechanic = await parse(join(folder, 'mechanic.json'));
  const data = await snapshot({ validate: false });
  const mechanic = data.mechanics.find(item => item.value.id === meta.mechanicId), creating = meta.created === true;
  if (meta.id !== id || data.manifest.value.id !== meta.workspaceId || draftMechanic.value.id !== meta.mechanicId)
    fail('DRAFT_IDENTITY_MISMATCH', '草稿身份、所属工作区或机制 ID 与目标不一致');
  if (typeof meta.created !== 'boolean' || (creating ? Boolean(mechanic) : !mechanic))
    fail('RESOURCE_REVISION_CONFLICT', '目标机制存在状态已变化：' + meta.mechanicId);
  for (const [resource, baseline] of [[data.definitions, meta.definitionsRevision], [data.rules, meta.rulesRevision], ...(!creating ? [[mechanic, meta.mechanicRevision]] : [])]) {
    if (resource.revision !== baseline) fail('RESOURCE_REVISION_CONFLICT', '保存前 canonical 已变化：' + relativeFile(resource.path), { resource: relativeFile(resource.path) });
  }
  if (meta.definitionsFile === undefined || meta.rulesFile === undefined)
    fail('DRAFT_BASELINE_MISSING', '旧草稿缺少入口基线，请重新 draft open 并迁入所需编辑；不要手填或刷新旧基线', { resource: 'draft.json' });
  if (meta.definitionsFile !== relativeFile(data.definitions.path) || meta.rulesFile !== relativeFile(data.rules.path))
    fail('RESOURCE_REVISION_CONFLICT', 'workspace.json 的 definitions/rules 入口已变化；请重新 draft open，不要刷新旧基线', { resource: 'workspace.json' });
  if (typeof meta.targetFile !== 'string') fail('DRAFT_IDENTITY_MISMATCH', '草稿缺少目标路径');
  const targetFile = relativeFile(resolve(meta.targetFile));
  const targetPath = await workspacePath(workspace, targetFile, { allowMissing: creating });
  if (creating) {
    try { await lstat(targetPath); fail('FILE_EXISTS', '新建目标已经存在，未覆盖：' + targetFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!targetFile.endsWith('.mechanic.json') || (!creating && targetPath !== mechanic.path)
      || (creating && targetPath !== join(mechanicDirectory(mechanicFolder(targetPath)), meta.mechanicId + '.mechanic.json')))
    fail('DRAFT_IDENTITY_MISMATCH', '草稿目标路径与机制身份不一致：' + targetFile);
  // 新图清单基线在 dry-run 内同样检查，即使当前从 curated 改成 legacy-all 也不能绕过。
  if (creating && data.manifest.revision !== meta.manifestRevision)
    fail(meta.manifestRevision === undefined ? 'DRAFT_BASELINE_MISSING' : 'RESOURCE_REVISION_CONFLICT', '保存前 workspace.json 已变化或缺少基线；草稿已保留，请重新 draft open，不要手填基线', { resource: 'workspace.json' });
  assertDraftDocument(draftDefinitions.value, 'definitions', relativeFile(draftDefinitions.path));
  assertDraftDocument(draftRules.value, 'rules', relativeFile(draftRules.path));
  assertDraftDocument(draftMechanic.value, 'mechanic', relativeFile(draftMechanic.path));
  noDraftGeometry(draftDefinitions.value, 'definitions');
  noDraftGeometry(draftMechanic.value, 'mechanic');
  assertAgentPermissions(data.definitions.value, draftDefinitions.value, data.manifest.value.definitions);
  const definitions = structuredClone(draftDefinitions.value), rules = structuredClone(draftRules.value), document = structuredClone(draftMechanic.value);
  definitions.positions = retainedPositions(data.definitions.value.positions, new Set(definitions.nodes.map(node => node.id)));
  const selectedRules = rules.rules.filter(rule => document.pinnedRuleIds.includes(rule.id)
    || (document.ruleSelection !== 'explicit' && (document.focusNodeIds.includes(rule.source) || document.focusNodeIds.includes(rule.target))));
  const projectedNodeIds = new Set([...document.focusNodeIds, ...selectedRules.flatMap(rule => [rule.source, rule.target])]);
  document.positions = retainedPositions(mechanic?.value.positions, projectedNodeIds);
  // 配色/样式同属展示 revision，不应以旧草稿覆盖网页的最新呈现。
  for (const [candidate, latest, ids] of [[definitions, data.definitions.value, new Set(definitions.nodes.map(node => node.id))], [document, mechanic?.value, projectedNodeIds]]) {
    for (const field of ['nodeColors', 'nodeStyles']) {
      delete candidate[field];
      if (latest?.[field] !== undefined) candidate[field] = retainedPositions(latest[field], ids);
    }
  }
  const manifest = structuredClone(data.manifest.value);
  let exportSelection = 'existing-mechanic', exportManifest = false;
  if (creating) {
    exportManifest = selectCreatedMechanic(manifest, meta.mechanicId, mechanicFolder(targetPath));
    exportSelection = exportManifest ? 'added' : !Array.isArray(manifest.exportSelections) ? 'legacy-all'
      : manifest.exportSelections.some(item => item.kind === 'mechanic' && item.mechanicId === meta.mechanicId) ? 'already-selected' : 'covered-by-folder';
  }
  const candidate = { ...candidateOf(data), manifest, definitions, rules,
    mechanics: [...data.mechanics.filter(item => item !== mechanic).map(item => item.value), document],
    files: [...data.files.filter(item => item.path !== targetFile), { kind: 'mechanic', id: meta.mechanicId, path: targetFile }] };
  validateWorkspace(candidate);
  const changes = [
    { path: data.manifest.value.definitions, document: definitions },
    { path: data.manifest.value.rules, document: rules },
    { path: targetFile, document, create: creating },
    ...(exportManifest ? [{ path: 'workspace.json', document: manifest }] : []),
  ];
  // 编码后的体积门禁也属于 dry-run，不能等到真正提交才发现超限。
  for (const change of changes) encode(change.document);
  return { folder, changes, data, exportSelection,
    target: { mechanicId: meta.mechanicId, file: targetFile, created: creating },
    counts: { focusNodes: document.focusNodeIds.length, rules: selectedRules.length, projectedNodes: projectedNodeIds.size } };
}
async function saveDraft(id, validateOnly = false) {
  return withLock(async () => {
    const prepared = await prepareCandidate(id);
    const { folder, changes, data, exportSelection, target, counts } = prepared;
    const summary = { contractVersion: 7, draftId: id, target, counts, exportSelection };
    if (validateOnly) return { ...summary, valid: true, dryRun: true, revision: data.revision };
    let verified;
    const warnings = [];
    try {
      await commitFiles(workspace, changes, { verify: async () => { verified = await snapshot(); } });
    } catch (error) {
      // 公共事务已经完成完整字节回读和候选验证；已提交后的清理失败不能伪称没有保存。
      if (error.code !== 'SAVE_CLEANUP_FAILED' || error.committed !== true) throw error;
      warnings.push({ code: error.code, message: error.message, committed: true, remainingPaths: error.remainingPaths, cleanupErrors: error.cleanupErrors });
    }
    try { await rm(folder, { recursive: true, force: true }); }
    catch (error) { warnings.push({ code: 'DRAFT_CLEANUP_FAILED', message: error.message, resource: folder, committed: true }); }
    return { ...summary, saved: true, verified: true, revision: verified.revision, changedFiles: changes.map(change => change.path),
      ...(warnings.length ? { warnings } : {}), note: '脚本已完成完整候选校验与实际回读确认，无需再次查询确认。文档生成与自动排版未执行。' };
  });
}
async function main() { const { positionals, options } = args(process.argv.slice(2)), [command, action] = positionals; if (!command) fail('TOOL_INVALID', '需要命令'); const data = ['scopes','search','graph','node','impact'].includes(command) ? await snapshot({ includeViews: false }) : null;
  if (command === 'guide') return guide();
  if (command === 'scopes') return { workspaceId: data.manifest.value.id, revision: data.revision, definitionsRevision: data.definitions.revision, tags: data.definitions.value.tagDefinitions ?? [], folders: data.folders, mechanics: data.mechanics.map(item => ({ id: item.value.id, name: item.value.name, file: relative(root, item.path) })) };
  if (command === 'search') { if (options.query) { const r = resolveNode(data.nodes, options.query); if (r.status === 'resolved') return { revision: data.revision, concept: r.node, matchedBy: r.matchedBy }; if (r.status === 'ambiguous') return { revision: data.revision, resolution: r }; return { revision: data.revision, resolution: fuzzyCandidates(data.nodes, options.query) ?? r }; } if (!options.from || !options.to) fail('TOOL_INVALID', 'search 需要 --query 或 --from --to'); const a = resolveNode(data.nodes, options.from), b = resolveNode(data.nodes, options.to); if (a.status !== 'resolved' || b.status !== 'resolved') return { revision: data.revision, from: a, to: b, rules: null }; const direct = (x,y) => data.edges.filter(edge => edge.source === x.id && edge.target === y.id).map(edge => ({ id: edge.id, operator: operator(edge), ruleText: edge.ruleText ?? '', origin: edge.origin })); return { revision: data.revision, from: a.node, to: b.node, rules: { forward: direct(a.node,b.node), reverse: direct(b.node,a.node) } }; }
  if (command === 'impact') { if (!options.from || !options.to || !data.nodeMap.has(options.from) || !data.nodeMap.has(options.to)) fail('NODE_NOT_FOUND', 'impact 需要已有 --from 与 --to'); const result = paths(data.edges, options.from, options.to, Number(options['max-depth'] ?? 16)).map(path => compact(path, data.nodeMap)); return { revision: data.revision, counts: { returned: result.length }, paths: result }; }
  if (command === 'node') {
    if (!options.id || !data.nodeMap.has(options.id)) fail('NODE_NOT_FOUND', 'node 需要已有 --id');
    const hops = Number(options.hops ?? 1), direction = options.direction ?? 'both';
    const collect = reverse => {
      const out = [];
      const walk = (id, depth, seen, ids, steps) => {
        if (depth >= hops) return;
        for (const edge of data.edges) {
          if ((reverse ? edge.target : edge.source) !== id) continue;
          const nextId = reverse ? edge.source : edge.target;
          if (seen.has(nextId)) continue;
          const nextIds = reverse ? [nextId, ...ids] : [...ids, nextId];
          const nextSteps = reverse ? [edge, ...steps] : [...steps, edge];
          out.push({ ids: nextIds, steps: nextSteps });
          walk(nextId, depth + 1, new Set([...seen, nextId]), nextIds, nextSteps);
        }
      };
      walk(options.id, 0, new Set([options.id]), [options.id], []);
      return out.map(path => compact(path, data.nodeMap));
    };
    return { revision: data.revision, center: data.nodeMap.get(options.id), direction, paths: { ...(direction !== 'downstream' ? { upstream: collect(true) } : {}), ...(direction !== 'upstream' ? { downstream: collect(false) } : {}) } };
  }
  if (command === 'graph') {
    if (!options.ids) fail('TOOL_INVALID', 'graph 需要 --ids <逗号分隔的稳定概念 ID>');
    const ids = String(options.ids).split(',').map(item => item.trim()).filter(Boolean);
    if (!ids.length) fail('TOOL_INVALID', 'graph 需要至少一个稳定概念 ID');
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length) fail('TOOL_INVALID', 'graph 的 --ids 不能重复', { duplicates });
    const unknownIds = ids.filter(id => !data.nodeMap.has(id));
    if (unknownIds.length) fail('NODE_NOT_FOUND', 'graph 收到不存在的概念 ID', { unknownIds });
    const selected = new Set(ids);
    // 对话渲染投影：只返回请求集合内部已声明的规则，不补端点、不推导路径、不读视图或坐标。
    return { revision: data.revision, conceptIds: ids, nodes: ids.map(id => data.nodeMap.get(id)), edges: data.edges.filter(edge => selected.has(edge.source) && selected.has(edge.target)).sort((a, b) => String(a.id).localeCompare(String(b.id))) };
  }
  if (command === 'draft' && action === 'open') { if (!options.mechanic) fail('TOOL_INVALID', 'draft open 需要 --mechanic'); return openDraft(options.mechanic, options); }
  if (command === 'draft' && action === 'save') { if (!options.draft) fail('TOOL_INVALID', 'draft save 需要 --draft'); return saveDraft(options.draft); }
  if (command === 'draft' && action === 'validate') { if (!options.draft) fail('TOOL_INVALID', 'draft validate 需要 --draft'); return saveDraft(options.draft, true); }
  if (command === 'isa' && action === 'set') {
    if (!options.draft) fail('TOOL_INVALID', 'isa set 需要 --draft');
    if (!options.concept) fail('TOOL_INVALID', 'isa set 需要 --concept');
    return setIsaParent(options.draft, options.concept, options.parent);
  }
  fail('TOOL_INVALID', '仅支持 guide、scopes/search/graph/node/impact、draft open|validate|save、isa set'); }
main().then(emit).catch(error => { process.stderr.write(JSON.stringify({ error: error.code ?? 'TOOL_FAILED', message: error.message, ...(error.details ? { details: error.details, ...error.details } : {}), ...Object.fromEntries(['committed', 'commitState', 'rollbackComplete', 'rollbackErrors', 'recovery', 'remainingPaths', 'cleanupErrors'].filter(key => error[key] !== undefined).map(key => [key, error[key]])), ...(error.cause ? { causeCode: error.cause.code, cause: error.cause.message } : {}) }) + '\n'); process.exitCode = 1; });
