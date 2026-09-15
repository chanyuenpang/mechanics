import { ContractError } from './validate.mjs';
import { semanticIdProblem } from './identity.mjs';
import { edgeHoverDetail, nodeHoverDetail } from './hover-details.mjs';

// 对话渲染只接受已经消歧的稳定概念 ID；不承担搜索、路径补全或推导职责。
export function selectConversationConcepts(workspace, conceptIds) {
  if (!Array.isArray(conceptIds) || conceptIds.length === 0) {
    throw new ContractError('CONCEPT_IDS_REQUIRED', 'conceptIds 必须是至少包含一个稳定概念 ID 的数组。');
  }
  const invalidIds = conceptIds.filter(id => typeof id !== 'string' || Boolean(semanticIdProblem(id)));
  const duplicateIds = conceptIds.filter((id, index) => conceptIds.indexOf(id) !== index);
  const knownIds = new Set(workspace.definitions.nodes.map(node => node.id));
  const unknownIds = conceptIds.filter(id => typeof id === 'string' && !semanticIdProblem(id) && !knownIds.has(id));
  if (invalidIds.length || duplicateIds.length || unknownIds.length) {
    const error = new ContractError('CONCEPT_IDS_INVALID', 'conceptIds 包含无效、重复或不存在的稳定概念 ID。');
    error.details = { invalidIds, duplicateIds: [...new Set(duplicateIds)], unknownIds };
    throw error;
  }
  const selectedIds = new Set(conceptIds);
  const mechanicReferences = ruleId => workspace.mechanics
    .filter(mechanic => mechanic.pinnedRuleIds.includes(ruleId))
    .map(mechanic => ({ id: mechanic.id, name: mechanic.name, scope: mechanic.scope }));
  const nodes = workspace.definitions.nodes.filter(node => selectedIds.has(node.id)).map(node => ({ ...structuredClone(node), hoverDetail: nodeHoverDetail(node) }));
  const edges = workspace.rules.rules
    .filter(rule => selectedIds.has(rule.source) && selectedIds.has(rule.target))
    .map(rule => {
      const sourceMechanics = mechanicReferences(rule.id);
      const edge = { ...structuredClone(rule), sourceMechanics };
      return { ...edge, hoverDetail: edgeHoverDetail(edge, id => workspace.definitions.nodes.find(node => node.id === id)?.label ?? id) };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return { conceptIds: [...conceptIds], nodes, edges };
}
