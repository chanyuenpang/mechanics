import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTaxonomyPresentation } from '../src/domain/taxonomy-presentation.mjs';

const graph = {
  nodes: [
    { id: 'child', label: '子概念' },
    { id: 'parent', label: '父概念' },
    { id: 'effect', label: '效果' },
  ],
  edges: [
    { id: 'child-is-parent', source: 'child', target: 'parent', relation: 'specializes' },
    { id: 'child-affects-effect', source: 'child', target: 'effect', relation: 'influence', sign: 1 },
  ],
};

test('默认投影用只读标签代替 is-a 边，并隐藏孤立父概念', () => {
  const before = structuredClone(graph);
  const projection = projectTaxonomyPresentation(graph, { retainedNodeIds: ['child'] });
  assert.deepEqual(projection.nodes.map(node => node.id), ['child', 'effect']);
  assert.deepEqual(projection.nodes[0].badges, [{
    kind: 'is-a', text: 'is-a：父概念', sourceId: 'child', targetId: 'parent',
  }]);
  assert.deepEqual(projection.edges.map(edge => edge.id), ['child-affects-effect']);
  assert.deepEqual(graph, before);
});

test('展开当前子概念时恢复其唯一直接父概念和 is-a 边', () => {
  const projection = projectTaxonomyPresentation(graph, { retainedNodeIds: ['child'], expandedNodeIds: ['child'] });
  assert.deepEqual(projection.nodes.map(node => node.id), ['child', 'parent', 'effect']);
  assert.deepEqual(projection.edges.map(edge => edge.id), ['child-is-parent', 'child-affects-effect']);
});

test('父概念有非 is-a 可见关系时默认保留', () => {
  const withParentEffect = structuredClone(graph);
  withParentEffect.edges.push({ id: 'parent-affects-effect', source: 'parent', target: 'effect', relation: 'influence', sign: 1 });
  const projection = projectTaxonomyPresentation(withParentEffect, { retainedNodeIds: ['child'] });
  assert.equal(projection.nodes.some(node => node.id === 'parent'), true);
  assert.equal(projection.edges.some(edge => edge.id === 'child-is-parent'), false);
});
