export function nodeHoverDetail(node) {
  return [node.label, node.description, node.aliases?.length ? '别名：' + node.aliases.join('、') : ''].filter(Boolean).join('\n');
}

export function edgeHoverDetail(edge, name = id => id, { includeRelation = true } = {}) {
  const qualifierText = (qualifiers, side) => qualifiers?.length
    ? `${side}限定：${qualifiers.map(item => `${item.key}=${item.value.kind === 'concept' ? name(item.value.conceptId) : String(item.value.value)}`).join('，')}` : '';
  const relation = edge.relation === 'specializes' ? '特化 / 是某种' : edge.sign === 1 ? '正向影响' : edge.sign === -1 ? '负向影响' : '随机影响';
  const sources = (edge.sourceMechanics ?? []).map(item => `来源机制：${item.name}（${item.id}）`).join('\n');
  return [includeRelation ? relation : '', edge.ruleText, qualifierText(edge.sourceQualifiers, '源'), qualifierText(edge.targetQualifiers, '目标'), sources]
    .filter(Boolean).join('\n');
}
