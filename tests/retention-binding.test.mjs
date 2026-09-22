import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkspace } from '../src/domain/validate.mjs';
import { queryWorkspace } from '../src/domain/query.mjs';

const node = id => ({ id, label: id, description: '测试概念', agentLocked: false });
const influence = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'influence', sign: 1, inheritance: { mode: 'none' } });
const specializes = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'specializes' });
const retentionBinding = (id, resourceConceptId, capConceptId) => ({ id, mechanismConceptId: 'retention-mechanism', resourceConceptId, capConceptId });

const NODES = ['retention-mechanism', 'retained-resource', 'cap-concept', 'shield', 'stamina', 'defense-stance', 'attack-stance', 'bystander',
  'leaf', 'left', 'right', 'top'];
const BASE_EDGES = [
  specializes('shield', 'retained-resource'), specializes('stamina', 'retained-resource'),
  specializes('defense-stance', 'cap-concept'), specializes('attack-stance', 'cap-concept'),
  influence('cap-concept', 'bystander'),
];
const BINDING = retentionBinding('defense-retention', 'shield', 'defense-stance');

function workspace(edges = BASE_EDGES, bindings = [BINDING]) {
  return {
    manifest: { schemaVersion: 13, kind: 'workspace', id: 'sample', name: '测试', definitions: 'definitions.json', rules: 'rules.json', agentExportPath: 'mechanics', compositions: [] },
    definitions: { schemaVersion: 7, kind: 'definitions', workspaceId: 'sample', nodes: NODES.map(node), tagDefinitions: [], positions: {} },
    rules: { schemaVersion: 1, kind: 'rules', workspaceId: 'sample', rules: edges, ...(bindings ? { retentionBindings: bindings } : {}) },
    mechanics: [{ schemaVersion: 8, kind: 'mechanic', workspaceId: 'sample', id: 'rules', name: '规则', scope: '测试', focusNodeIds: [...NODES], pinnedRuleIds: edges.map(edge => edge.id), positions: {}, taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } }],
    views: [], revision: 'r1',
  };
}

test('配对绑定通过草稿校验，且资源/上限角色在全工作区唯一', () => {
  validateWorkspace(workspace());
  const missing = workspace(BASE_EDGES, [retentionBinding('bad', 'absent', 'defense-stance')]);
  assert.throws(() => validateWorkspace(missing), { code: 'MISSING_REFERENCE' });
  const duplicated = workspace(BASE_EDGES, [BINDING, retentionBinding('other', 'shield', 'attack-stance')]);
  assert.throws(() => validateWorkspace(duplicated), { code: 'RETENTION_BINDING_DUPLICATE_ROLE' });
  const selfPair = workspace(BASE_EDGES, [retentionBinding('self', 'shield', 'shield')]);
  assert.throws(() => validateWorkspace(selfPair), { code: 'RETENTION_BINDING_INVALID' });
});

test('分类透传：子概念能看到上位概念的声明与 is-a 路径，但不因此取得影响', () => {
  const result = queryWorkspace(workspace(), { command: 'node', id: 'defense-stance', direction: 'downstream', hops: 2 });
  assert.deepEqual(result.taxonomy.ancestors.map(item => [item.id, item.hops]), [['cap-concept', 1]]);
  const declared = result.taxonomy.declarations.filter(item => item.edgeId === 'cap-concept-2-bystander');
  assert.equal(declared.length, 1);
  assert.deepEqual(declared[0].isaPath, ['defense-stance', 'cap-concept']);
  assert.equal(result.taxonomy.interpretation, 'classificationContextOnly');
  // is-a 一直是可遍历的一步，但含分类步骤的路径不带正负号：分类不被折算成影响。
  const mixed = queryWorkspace(workspace(), { command: 'impact', from: 'defense-stance', to: 'bystander', maxDepth: 6 });
  assert.equal(mixed.paths.length, 1);
  assert.equal(mixed.paths[0].kind, 'mixed');
  assert.equal(mixed.paths[0].effect, null, '含 is-a 步骤的路径不得给出正负影响结论');
  assert.equal(mixed.paths[0].steps[0].operator, 'is-a>');
});

test('影响派生只在显式请求时出现，并带配对来源', () => {
  const request = { command: 'impact', from: 'defense-stance', to: 'shield', maxDepth: 4 };
  assert.equal(queryWorkspace(workspace(), request).paths.length, 0);
  const derived = queryWorkspace(workspace(), { ...request, includeInherited: true });
  assert.equal(derived.paths.length, 1);
  assert.equal(derived.paths[0].steps[0].operator, '+>');
  assert.deepEqual(derived.includedDerivedEdges.map(item => [item.id, item.source, item.target, item.origin.bindingId]),
    [['binding:defense-retention', 'defense-stance', 'shield', 'defense-retention']]);
});

test('两端各自 is-a 特化绝不产生交叉配对', () => {
  const derived = queryWorkspace(workspace(), { command: 'impact', from: 'attack-stance', to: 'stamina', maxDepth: 4, includeInherited: true });
  const cross = queryWorkspace(workspace(), { command: 'impact', from: 'attack-stance', to: 'shield', maxDepth: 4, includeInherited: true });
  assert.equal(derived.paths.length, 0, '未绑定的上限/资源不得派生');
  assert.equal(cross.paths.length, 0, '未绑定的交叉组合不得派生');
  const bound = queryWorkspace(workspace(), { command: 'impact', from: 'defense-stance', to: 'shield', maxDepth: 4, includeInherited: true });
  assert.equal(bound.includedDerivedEdges.length, 1);
});

test('作者已声明的同端点规则优先，派生边不与声明边并存', () => {
  const edges = [...BASE_EDGES, influence('defense-stance', 'shield')];
  const derived = queryWorkspace(workspace(edges), { command: 'impact', from: 'defense-stance', to: 'shield', maxDepth: 4, includeInherited: true });
  assert.equal(derived.includedDerivedEdges.length, 0);
  assert.equal(derived.paths.length, 1);
  assert.equal(derived.paths[0].steps[0].origin.ruleId, 'defense-stance-2-shield');
});

test('显式 inheritance:specializeEndpoint 只替换声明的端点，并带特化路径', () => {
  const policy = { mode: 'specializeEndpoint', endpoints: ['source'], maxSpecializationHops: 1 };
  const edges = [specializes('shield', 'retained-resource'), specializes('stamina', 'retained-resource'),
    { ...influence('retained-resource', 'bystander'), inheritance: policy }];
  const fixture = workspace(edges, null);
  const withoutFlag = queryWorkspace(fixture, { command: 'impact', from: 'shield', to: 'bystander', maxDepth: 4 });
  assert.equal(withoutFlag.includedDerivedEdges.length, 0, 'inheritance 只在显式请求时生效');
  assert.equal(withoutFlag.paths.every(path => path.steps.some(step => step.operator === 'is-a>')), true, '未请求继承时只能走分类步骤');
  const derived = queryWorkspace(fixture, { command: 'impact', from: 'shield', to: 'bystander', maxDepth: 4, includeInherited: true });
  assert.deepEqual(derived.includedDerivedEdges.map(item => [item.source, item.target, item.origin.ruleId]).sort(),
    [['shield', 'bystander', 'retained-resource-2-bystander'], ['stamina', 'bystander', 'retained-resource-2-bystander']]);
  assert.equal(derived.paths.some(path => path.length === 1 && path.steps[0].operator === '+>'), true, '派生边给出一条直接影响路径');
  const stamina = queryWorkspace(fixture, { command: 'impact', from: 'stamina', to: 'bystander', maxDepth: 4, includeInherited: true });
  assert.equal(stamina.includedDerivedEdges.some(item => item.source === 'stamina' && item.origin.ruleId === 'retained-resource-2-bystander'), true,
    '同一上位概念的所有特化都获得该规则');
  const unrelated = queryWorkspace(fixture, { command: 'impact', from: 'defense-stance', to: 'bystander', maxDepth: 4, includeInherited: true });
  assert.equal(unrelated.includedDerivedEdges.every(item => item.source !== 'defense-stance' && item.target !== 'defense-stance'), true,
    '未声明的端点不参与替换');
});

test('特化路径歧义直接失败，不静默选一条', () => {
  const edges = [specializes('leaf', 'left'), specializes('leaf', 'right'), specializes('left', 'top'), specializes('right', 'top'),
    { ...influence('top', 'bystander'), inheritance: { mode: 'specializeEndpoint', endpoints: ['source'], maxSpecializationHops: 2 } }];
  assert.throws(() => queryWorkspace(workspace(edges, null), { command: 'impact', from: 'leaf', to: 'bystander', maxDepth: 4, includeInherited: true }),
    { code: 'SPECIALIZATION_AMBIGUOUS' });
});

test('includeInherited 只接受 impact 与 node，并且必须是显式取值', () => {
  assert.throws(() => queryWorkspace(workspace(), { command: 'search', query: 'shield', includeInherited: true }), { code: 'QUERY_INVALID' });
  assert.equal(queryWorkspace(workspace(), { command: 'impact', from: 'defense-stance', to: 'shield', maxDepth: 4, includeInherited: false }).paths.length, 0);
});
