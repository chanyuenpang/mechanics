import test from 'node:test';
import assert from 'node:assert/strict';
import { endpointProjectionId, normalizedQualifierKey, projectEndpointQualifiers } from '../src/domain/endpoint-projection.mjs';

const qualifier = (key, value) => ({ key, value: { kind: 'literal', value } });
const graph = {
  nodes: [
    { id: 'health', label: '气血', description: '参与者的气血', sourceGraphIds: ['combat'] },
    { id: 'defeat', label: '失败', description: '战斗失败', sourceGraphIds: ['combat'] },
  ],
  edges: [
    { id: 'enemy-defeat', source: 'health', target: 'defeat', sourceQualifiers: [qualifier('阵营', '敌方')], targetQualifiers: [qualifier('阵营', '敌方')] },
    { id: 'controlled-defeat', source: 'health', target: 'defeat', sourceQualifiers: [qualifier('角色', '当前控制')], targetQualifiers: [qualifier('角色', '当前控制')] },
  ],
};

test('端点限定词投影按基础概念与规范化限定集合去重', () => {
  assert.equal(normalizedQualifierKey([qualifier('b', 2), qualifier('a', true)]), normalizedQualifierKey([qualifier('a', true), qualifier('b', 2)]));
  const projection = projectEndpointQualifiers(graph);
  assert.equal(projection.nodes.filter(node => node.id === 'health').length, 0);
  assert.equal(projection.nodes.filter(node => node.scopeProjection && node.canonicalNodeId === 'health').length, 2);
  assert.equal(projection.edges[0].source, endpointProjectionId('health', [qualifier('阵营', '敌方')]));
  assert.equal(projection.edges[0].canonicalSource, 'health');
  assert.equal(projection.edges[0].target, endpointProjectionId('defeat', [qualifier('阵营', '敌方')]));
});

test('基础概念的全部可见端点已被限定投影承接时，不渲染孤立的基础实例', () => {
  const scopedOnly = projectEndpointQualifiers({ nodes: [{ id: 'actor', label: '参与者', description: '' }, { id: 'action', label: '行动', description: '' }],
    edges: [{ id: 'rule', source: 'actor', target: 'action', sourceQualifiers: [qualifier('阵营', '敌方')], targetQualifiers: [qualifier('阵营', '敌方')] }] });
  assert.equal(scopedOnly.nodes.some(node => node.id === 'actor'), false);
  assert.equal(scopedOnly.nodes.some(node => node.id === 'action'), false);
  assert.equal(scopedOnly.nodes.filter(node => node.scopeProjection).length, 2);
});

test('不同限定集合不合并，且不创建概念或 is-a 关系', () => {
  const projection = projectEndpointQualifiers(graph);
  assert.equal(new Set(projection.edges.map(edge => edge.source)).size, 2);
  assert.equal(projection.nodes.some(node => node.relation === 'specializes'), false);
  assert.equal(projection.nodes.every(node => node.scopeProjection ? node.baseConceptId === node.canonicalNodeId : true), true);
});
