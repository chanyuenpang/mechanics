import test from 'node:test';
import assert from 'node:assert/strict';
import { queryWorkspace, validateQuery } from '../src/domain/query.mjs';

const nodes = [
  { id: 'unit', label: '单位', description: '可行动实体', aliases: ['角色'] },
  { id: 'soldier', label: '士兵', description: '近战单位', aliases: ['战士'] },
  { id: 'attack', label: '攻击', description: '造成伤害' },
  { id: 'health', label: '气血', description: '生命值' },
  { id: 'guard', label: '守卫', description: '重复名称' },
  { id: 'guard-alt', label: '守卫', description: '另一概念' },
];
const workspace = {
  manifest: { id: 'test' }, revision: 'r1', definitions: { nodes }, views: [],
  rules: { rules: [
    { id: 'soldier-is-unit', source: 'soldier', target: 'unit', relation: 'specializes' },
    { id: 'soldier-attack', source: 'soldier', target: 'attack', relation: 'influence', sign: 1, ruleText: '士兵可以攻击' },
    { id: 'attack-health', source: 'attack', target: 'health', relation: 'influence', sign: -1, ruleText: '攻击降低气血' },
  ] },
  mechanics: [
    { id: 'taxonomy', name: '分类', scope: '测试', focusNodeIds: ['soldier', 'unit'], pinnedRuleIds: ['soldier-is-unit'] },
    { id: 'combat', name: '战斗', scope: '测试', focusNodeIds: ['soldier', 'attack', 'health'], pinnedRuleIds: ['soldier-attack', 'attack-health'] },
  ],
};

test('search 精确解析 ID、名称和别名；歧义只返回候选', () => {
  const byAlias = queryWorkspace(workspace, { command: 'search', query: '战士' });
  assert.equal(byAlias.concept.id, 'soldier');
  const ambiguous = queryWorkspace(workspace, { command: 'search', query: '守卫' });
  assert.equal(ambiguous.resolution.status, 'ambiguous');
  assert.deepEqual(ambiguous.resolution.candidates.map(item => item.id), ['guard', 'guard-alt']);
});

test('search 精确未命中返回模糊候选，且绝不自动消歧', () => {
  const prefix = queryWorkspace(workspace, { command: 'search', query: '士' });
  assert.equal(prefix.resolution.status, 'fuzzy');
  assert.equal(prefix.concept, undefined);
  assert.deepEqual(prefix.resolution.candidates.map(item => item.id), ['soldier']);
  assert.deepEqual(prefix.resolution.candidates[0].matchedBy, ['label-prefix', 'alias-contains']);
  assert.equal(prefix.resolution.candidates[0].score, 100);
  assert.equal(prefix.resolution.total, 1);
  assert.equal(prefix.resolution.truncated, false);
  const alias = queryWorkspace(workspace, { command: 'search', query: '战' });
  assert.equal(alias.resolution.status, 'fuzzy');
  assert.equal(alias.resolution.candidates[0].id, 'soldier');
  assert.equal(alias.resolution.candidates[0].matchedBy[0], 'alias-prefix');
  const description = queryWorkspace(workspace, { command: 'search', query: '生命值' });
  assert.deepEqual(description.resolution.candidates.map(item => item.id), ['health']);
  assert.deepEqual(description.resolution.candidates[0].matchedBy, ['description-contains']);
  const missing = queryWorkspace(workspace, { command: 'search', query: '完全不存在的概念' });
  assert.equal(missing.resolution.status, 'not_found');
  assert.equal(missing.resolution.candidates, undefined);
});

test('search 双概念返回双向直接规则，且不要求机制范围', () => {
  const result = queryWorkspace(workspace, { command: 'search', from: '士兵', to: '攻击' });
  assert.equal(result.rules.forward[0].operator, '+>');
  assert.deepEqual(result.rules.reverse, []);
  assert.throws(() => validateQuery({ command: 'search', query: '士兵', mechanic: 'combat' }), { code: 'QUERY_INVALID' });
});

test('impact 短链优先，直接 is-a 是分类而不是影响', () => {
  const taxonomy = queryWorkspace(workspace, { command: 'impact', from: 'soldier', to: 'unit' });
  assert.equal(taxonomy.paths[0].chain, 'soldier is-a> unit');
  assert.equal(taxonomy.paths[0].kind, 'taxonomy');
  assert.equal(taxonomy.paths[0].effect, null);
  const impact = queryWorkspace(workspace, { command: 'impact', from: 'soldier', to: 'health' });
  assert.equal(impact.paths[0].chain, 'soldier +> attack -> health');
  assert.equal(impact.paths[0].effect, 'negative');
});

test('node 按真实边方向返回结构路径，并明确受限状态', () => {
  const result = queryWorkspace(workspace, { command: 'node', id: 'attack', direction: 'both', hops: 1 });
  assert.equal(result.paths.upstream.paths[0].chain, 'soldier +> attack');
  assert.equal(result.paths.downstream.paths[0].chain, 'attack -> health');
  const exact = queryWorkspace(workspace, { command: 'impact', from: 'soldier', to: 'health', maxPaths: 1 });
  assert.equal(exact.counts.totalExact, true);
  assert.deepEqual(exact.truncationReasons, []);
});
