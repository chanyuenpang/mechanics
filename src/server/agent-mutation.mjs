import { assertSemanticId, semanticRuleId } from '../domain/identity.mjs';
import { endpointProjectionId } from '../domain/endpoint-projection.mjs';
import { ContractError, validateWorkspace } from '../domain/validate.mjs';

const fail = (code, message, details = {}) => { throw Object.assign(new ContractError(code, message), details); };
const has = (value, key) => Object.hasOwn(value, key);
const allowed = (body, fields) => {
  // editSessionId 是服务层对 Agent 编辑会话的准入凭据，不属于 canonical mutation 字段。
  const accepted = new Set(['projectRoot', 'projectGeneration', 'editSessionId', 'revision', 'resource', 'action', ...fields]);
  for (const key of Object.keys(body)) if (!accepted.has(key)) fail('AGENT_MUTATION_INVALID', `Agent 写入不支持字段：${key}`);
};
const requiredString = (body, key, { blank = false } = {}) => {
  if (typeof body[key] !== 'string' || (!blank && !body[key].trim())) fail('AGENT_MUTATION_INVALID', `${key} 必须是${blank ? '' : '非空'}字符串`);
  return body[key];
};
const stringArray = (body, key) => {
  if (!Array.isArray(body[key]) || body[key].some(value => typeof value !== 'string')) {
    fail('AGENT_MUTATION_INVALID', `${key} 必须是 JSON 字符串数组`);
  }
  return structuredClone(body[key]);
};
const jsonValue = (body, key) => { if (!Array.isArray(body[key])) fail('AGENT_MUTATION_INVALID', `${key} 必须是 JSON 数组`); return structuredClone(body[key]); };
const conceptById = (workspace, id) => workspace.definitions.nodes.find(node => node.id === id);
const mechanicById = (workspace, id) => workspace.mechanics.find(mechanic => mechanic.id === id);

function assertRevision(workspace, body, kind, id = null) {
  requiredString(body, 'revision');
  const current = kind === 'definitions' ? workspace.resourceRevisions.definitions : workspace.resourceRevisions.mechanics[id];
  if (body.revision !== current) fail('RESOURCE_REVISION_CONFLICT', `${kind === 'definitions' ? '概念定义' : `机制 ${id}`} 已改变，请重新查询后再编辑`);
}

function externalConceptReferences(workspace, id) {
  const references = [];
  for (const mechanic of workspace.mechanics) {
    if (mechanic.nodeIds.includes(id)) references.push({ kind: 'mechanicNode', mechanicId: mechanic.id });
    if (has(mechanic.positions, id)) references.push({ kind: 'mechanicPosition', mechanicId: mechanic.id });
    for (const edge of mechanic.edges) if (edge.source === id || edge.target === id) {
      references.push({ kind: 'ruleEndpoint', mechanicId: mechanic.id, edgeId: edge.id });
    }
  }
  const compositionReferences = [...workspace.manifest.compositions,
    ...(workspace.manifest.lastView && !('viewId' in workspace.manifest.lastView) ? [{ id: 'lastView', ...workspace.manifest.lastView }] : [])];
  for (const view of compositionReferences) {
    if (has(view.positions, id) || view.collapsedNodeIds.includes(id)) references.push({ kind: 'composition', compositionId: view.id });
  }
  for (const view of workspace.views) {
    if (has(view.positions, id) || view.collapsedNodeIds.includes(id)) references.push({ kind: 'view', viewId: view.id });
  }
  return references;
}

function mutateConcept(workspace, body) {
  const actions = new Set(['create', 'update', 'delete']);
  if (!actions.has(body.action)) fail('AGENT_MUTATION_INVALID', 'concept action 必须是 create、update 或 delete');
  const fields = body.action === 'create' ? ['id', 'label', 'description', 'aliases', 'tags']
    : body.action === 'update' ? ['id', 'label', 'description', 'aliases', 'tags'] : ['id'];
  allowed(body, fields); assertRevision(workspace, body, 'definitions');
  const id = requiredString(body, 'id');
  try { assertSemanticId(id, '概念 ID '); } catch (error) { fail('INVALID_SEMANTIC_ID', error.message); }
  const existing = conceptById(workspace, id);
  if (body.action === 'create') {
    if (existing) fail('DUPLICATE_ID', `概念已存在：${id}`);
    const node = { id, label: requiredString(body, 'label'), description: requiredString(body, 'description'), agentLocked: false };
    if (has(body, 'aliases')) node.aliases = stringArray(body, 'aliases');
    if (has(body, 'tags')) node.tags = stringArray(body, 'tags');
    workspace.definitions.nodes.push(node);
  } else {
    if (!existing) fail('NODE_NOT_FOUND', `概念不存在：${id}`);
    if (existing.agentLocked) fail('CONCEPT_AGENT_LOCKED', `概念 ${id} 已被用户冻结，Agent 不能修改或删除`);
    if (body.action === 'update') {
      const changed = ['label', 'description', 'aliases', 'tags'].filter(key => has(body, key));
      if (!changed.length) fail('AGENT_MUTATION_INVALID', 'concept update 至少需要一个可编辑字段');
      for (const key of changed) existing[key] = ['aliases', 'tags'].includes(key) ? stringArray(body, key) : requiredString(body, key);
    } else {
      const references = externalConceptReferences(workspace, id);
      // 机制节点和视图布局都只是对概念的可回收展示引用；删除概念时与定义原子提交，
      // 不能把它们当作语义规则引用而留下孤儿坐标。
      const blockers = references.filter(reference => !['mechanicNode', 'mechanicPosition', 'view'].includes(reference.kind));
      if (blockers.length) fail('CONCEPT_REFERENCED', `概念 ${id} 仍被规则、视图或组合引用；请先清理这些引用`, { references: blockers });
      const companionMechanics = [];
      for (const mechanic of workspace.mechanics) if (mechanic.nodeIds.includes(id) || has(mechanic.positions, id)) {
        mechanic.nodeIds = mechanic.nodeIds.filter(nodeId => nodeId !== id); delete mechanic.positions[id]; companionMechanics.push(mechanic);
      }
      const companionViews = [];
      for (const view of workspace.views) if (has(view.positions, id) || view.collapsedNodeIds.includes(id)) {
        delete view.positions[id]; view.collapsedNodeIds = view.collapsedNodeIds.filter(nodeId => nodeId !== id); companionViews.push(view);
      }
      workspace.definitions.nodes = workspace.definitions.nodes.filter(node => node.id !== id);
      delete workspace.definitions.positions[id];
      return { kind: 'definitions', document: workspace.definitions, id, companionMechanics, companionViews };
    }
  }
  return { kind: 'definitions', document: workspace.definitions, id };
}

function finalEdge(previous, body) {
  const edge = previous ? structuredClone(previous) : {
    id: semanticRuleId(body.source, body.target, new Set()), source: body.source, target: body.target,
    relation: body.relation, ruleText: body.ruleText ?? '',
  };
  for (const key of ['relation', 'sign', 'ruleText', 'inheritance', 'sourceQualifiers', 'targetQualifiers']) if (has(body, key) && body[key] !== undefined) {
    if ((key === 'sourceQualifiers' || key === 'targetQualifiers') && body[key].length === 0) delete edge[key];
    else edge[key] = body[key];
  }
  if (edge.relation === 'specializes' && has(body, 'sign')) fail('AGENT_MUTATION_INVALID', 'specializes 规则不能提供 sign');
  if (edge.relation === 'specializes') {
    if (edge.sourceQualifiers || edge.targetQualifiers) fail('AGENT_MUTATION_INVALID', 'specializes 只能表达概念子类，不能添加限定词');
    delete edge.sign; delete edge.inheritance;
  }
  if (edge.relation === 'influence' && !has(edge, 'inheritance')) edge.inheritance = { mode: 'none' };
  if (has(edge, 'ruleText')) requiredString(edge, 'ruleText', { blank: true });
  if (edge.relation === 'influence' && ![1, -1, 'random'].includes(edge.sign)) fail('AGENT_MUTATION_INVALID', 'influence 规则必须提供 sign：1、-1 或 random');
  if (!['influence', 'specializes'].includes(edge.relation)) fail('AGENT_MUTATION_INVALID', 'relation 必须是 influence 或 specializes');
  return edge;
}

function projectionIds(edge) {
  return ['sourceQualifiers', 'targetQualifiers']
    .filter(key => edge[key]?.length)
    .map(key => endpointProjectionId(key === 'sourceQualifiers' ? edge.source : edge.target, edge[key]));
}

function clearRemovedProjectionPositions(workspace, mechanic, previousEdges) {
  const current = new Set(mechanic.edges.flatMap(projectionIds));
  const removed = new Set(previousEdges.flatMap(projectionIds).filter(id => !current.has(id)));
  if (!removed.size) return;
  if (mechanic.projectionPositions) for (const id of removed) delete mechanic.projectionPositions[id];
  // 组合视图为各机制边的端点投影保存独立坐标；删除或取消限定词时，必须同步清理
  // 不再由该视图任一已注册机制使用的投影，不能让过期坐标阻止 canonical 规则写入。
  for (const view of workspace.views) {
    if (!view.projectionPositions || !view.mechanicRegistrations.some(item => item.mechanicId === mechanic.id)) continue;
    const activeProjectionIds = new Set(view.mechanicRegistrations
      .map(item => workspace.mechanics.find(candidate => candidate.id === item.mechanicId))
      .filter(Boolean).flatMap(candidate => candidate.edges.flatMap(projectionIds)));
    for (const id of removed) if (!activeProjectionIds.has(id)) delete view.projectionPositions[id];
  }
}

function mutateRule(workspace, body) {
  const actions = new Set(['add', 'update', 'delete']);
  if (!actions.has(body.action)) fail('AGENT_MUTATION_INVALID', 'rule action 必须是 add、update 或 delete');
  const writable = body.action === 'delete' ? ['mechanic', 'source', 'target', 'sourceQualifiers', 'targetQualifiers']
    : ['mechanic', 'source', 'target', 'relation', 'sign', 'ruleText', 'inheritance', 'sourceQualifiers', 'targetQualifiers'];
  allowed(body, writable);
  const mechanicId = requiredString(body, 'mechanic');
  const mechanic = mechanicById(workspace, mechanicId);
  if (!mechanic) fail('SCOPE_NOT_FOUND', `机制不存在：${mechanicId}`);
  assertRevision(workspace, body, 'mechanic', mechanicId);
  const source = requiredString(body, 'source'), target = requiredString(body, 'target');
  if (!conceptById(workspace, source) || !conceptById(workspace, target)) fail('NODE_NOT_FOUND', '规则端点必须是已存在的概念');
  const sourceQualifiers = has(body, 'sourceQualifiers') ? jsonValue(body, 'sourceQualifiers') : undefined;
  const targetQualifiers = has(body, 'targetQualifiers') ? jsonValue(body, 'targetQualifiers') : undefined;
  const sameEndpoint = edge => edge.source === source && edge.target === target;
  const current = mechanic.edges.find(sameEndpoint);
  if (body.action === 'add') {
    const duplicate = workspace.mechanics.find(candidate => candidate.edges.some(sameEndpoint));
    if (duplicate) fail('DUPLICATE_ENDPOINT_RULE', `概念 ${source} 到 ${target} 已在机制 ${duplicate.id} 中存在规则`);
    mechanic.edges.push(finalEdge(null, { ...body, source, target, sourceQualifiers, targetQualifiers }));
    if (!mechanic.nodeIds.includes(source)) mechanic.nodeIds.push(source);
    if (!mechanic.nodeIds.includes(target)) mechanic.nodeIds.push(target);
  } else {
    if (!current) fail('RULE_NOT_FOUND', `机制 ${mechanicId} 中不存在 ${source} 到 ${target} 的规则`);
    const previousEdges = [current];
    if (body.action === 'update') {
      const changed = ['relation', 'sign', 'ruleText', 'inheritance', 'sourceQualifiers', 'targetQualifiers'].filter(key => has(body, key));
      if (!changed.length) fail('AGENT_MUTATION_INVALID', 'rule update 至少需要一个可编辑字段');
      mechanic.edges[mechanic.edges.indexOf(current)] = finalEdge(current, body);
    } else mechanic.edges = mechanic.edges.filter(edge => edge !== current);
    clearRemovedProjectionPositions(workspace, mechanic, previousEdges);
  }
  return { kind: 'mechanic', document: mechanic, id: mechanicId };
}

// 机制图只保存全局概念的成员引用；移除成员绝不能触及 definitions、其他机制或视图。
function mutateMechanic(workspace, body) {
  if (body.action !== 'update') fail('AGENT_MUTATION_INVALID', 'mechanic action 必须是 update');
  allowed(body, ['mechanic', 'name', 'scope', 'removeIsolatedConceptIds']);
  const mechanicId = requiredString(body, 'mechanic'), mechanic = mechanicById(workspace, mechanicId);
  if (!mechanic) fail('SCOPE_NOT_FOUND', `机制不存在：${mechanicId}`);
  assertRevision(workspace, body, 'mechanic', mechanicId);
  const removing = has(body, 'removeIsolatedConceptIds') ? stringArray(body, 'removeIsolatedConceptIds') : [];
  const changed = ['name', 'scope'].filter(key => has(body, key));
  if (!changed.length && !removing.length) fail('AGENT_MUTATION_INVALID', 'mechanic update 至少需要 name、scope 或 removeIsolatedConceptIds');
  if (new Set(removing).size !== removing.length) fail('AGENT_MUTATION_INVALID', 'removeIsolatedConceptIds 不能包含重复概念');
  const qualifierReferences = edge => [edge.sourceQualifiers, edge.targetQualifiers].flatMap(value => value ?? [])
    .filter(qualifier => qualifier?.value?.kind === 'concept').map(qualifier => qualifier.value.conceptId);
  const views = [...workspace.views, ...workspace.manifest.compositions,
    ...(workspace.manifest.lastView && !('viewId' in workspace.manifest.lastView) ? [{ id: 'lastView', ...workspace.manifest.lastView }] : [])];
  for (const conceptId of removing) {
    if (!conceptById(workspace, conceptId)) fail('NODE_NOT_FOUND', `概念不存在：${conceptId}`);
    if (!mechanic.nodeIds.includes(conceptId)) fail('MECHANIC_MEMBER_NOT_FOUND', `机制 ${mechanicId} 未引用概念：${conceptId}`);
    const edges = mechanic.edges.filter(edge => edge.source === conceptId || edge.target === conceptId || qualifierReferences(edge).includes(conceptId));
    if (edges.length) fail('MECHANIC_MEMBER_NOT_ISOLATED', `概念 ${conceptId} 仍被机制 ${mechanicId} 的规则或限定词引用`, { edgeIds: edges.map(edge => edge.id) });
    if (!workspace.mechanics.some(candidate => candidate.id !== mechanicId && candidate.nodeIds.includes(conceptId))) {
      fail('MECHANIC_MEMBER_NOT_SHARED', `概念 ${conceptId} 未被其他机制图引用，不能作为迁移残留移除`);
    }
    const blockedViews = views.filter(view => view.collapsedNodeIds?.includes(conceptId));
    if (blockedViews.length) fail('MECHANIC_MEMBER_VIEW_REFERENCED', `概念 ${conceptId} 被折叠视图引用，不能移除成员归属`, { viewIds: blockedViews.map(view => view.id) });
  }
  for (const key of changed) mechanic[key] = requiredString(body, key);
  mechanic.nodeIds = mechanic.nodeIds.filter(id => !removing.includes(id));
  for (const conceptId of removing) delete mechanic.positions[conceptId];
  return { kind: 'mechanic', document: mechanic, id: mechanicId };
}

export function applyAgentMutation(workspace, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('AGENT_MUTATION_INVALID', 'Agent mutation 必须是 JSON 对象');
  if (!['mechanic', 'concept', 'rule'].includes(body.resource)) fail('AGENT_MUTATION_INVALID', 'resource 必须是 mechanic、concept 或 rule');
  const target = body.resource === 'mechanic' ? mutateMechanic(workspace, body)
    : body.resource === 'concept' ? mutateConcept(workspace, body) : mutateRule(workspace, body);
  validateWorkspace(workspace);
  return target;
}
