import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { assertDocument, validateWorkspace } from '../src/domain/validate.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';

const source = await readWorkspace(fileURLToPath(new URL('../examples/card-game/.mechanics/', import.meta.url)));

test('Schema 诊断给出额外字段与缺失字段的准确 JSON 路径', () => {
  const definitions = structuredClone(source.definitions);
  definitions.nodes[0].unexpected = true;
  delete definitions.nodes[0].description;
  assert.throws(() => assertDocument(definitions, 'definitions', 'definitions.json'), error => {
    assert.equal(error.code, 'INVALID_DOCUMENT');
    assert.equal(error.details.resource, 'definitions.json');
    assert.ok(error.details.issues.some(issue => issue.field === '/nodes/0/unexpected' && issue.keyword === 'additionalProperties'));
    assert.ok(error.details.issues.some(issue => issue.field === '/nodes/0/description' && issue.keyword === 'required'));
    return true;
  });
});

test('完整候选校验直接定位另一机制的固定规则引用', () => {
  const candidate = structuredClone(source);
  const graph = candidate.mechanics.find(item => item.id === 'encounter');
  const index = graph.pinnedRuleIds.length;
  graph.pinnedRuleIds.push('missing-rule');
  const path = candidate.files.find(file => file.kind === 'mechanic' && file.id === graph.id).path;
  assert.throws(() => validateWorkspace(candidate), error => {
    assert.equal(error.code, 'MISSING_REFERENCE');
    assert.deepEqual(error.details, { resource: path, field: `pinnedRuleIds[${index}]`, id: 'missing-rule' });
    return true;
  });
});

test('隐藏视图引用也报告路径、字段与缺失 ID', () => {
  const candidate = structuredClone(source);
  candidate.views.push({ schemaVersion: 5, kind: 'view', workspaceId: candidate.manifest.id, id: 'inspection', name: '检查视图',
    mechanicRegistrations: [{ mechanicId: 'basic-rules', visible: false }], focusNodeIds: ['missing-node'], pinnedRuleIds: [],
    collapsedNodeIds: [], positions: {}, structuralPresentation: 'line', taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } });
  candidate.files.push({ kind: 'view', id: 'inspection', path: 'views/inspection.view.json' });
  assert.throws(() => validateWorkspace(candidate), error => {
    assert.equal(error.code, 'MISSING_REFERENCE');
    assert.deepEqual(error.details, { resource: 'views/inspection.view.json', field: 'focusNodeIds[0]', id: 'missing-node' });
    return true;
  });
});

test('分类自连诊断保留领域错误并指出规则文件', () => {
  const candidate = structuredClone(source);
  candidate.rules.rules.push({ id: 'damage-2-damage', source: 'damage', target: 'damage', relation: 'specializes' });
  assert.throws(() => validateWorkspace(candidate), error => {
    assert.equal(error.code, 'SPECIALIZES_SELF_LINK');
    assert.deepEqual(error.details, { resource: candidate.manifest.rules, field: 'rules' });
    return true;
  });
});

test('规则端点诊断使用清单入口与规则数组字段而非要求人工定位', () => {
  const candidate = structuredClone(source);
  candidate.rules.rules[0].source = 'missing-source';
  assert.throws(() => validateWorkspace(candidate), error => {
    assert.equal(error.code, 'MISSING_REFERENCE');
    assert.deepEqual(error.details, { resource: candidate.manifest.rules, field: 'rules[0].source', id: 'missing-source' });
    return true;
  });
});
