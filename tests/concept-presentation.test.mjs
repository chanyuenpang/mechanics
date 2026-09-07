import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptEditPresentation, conceptStructurePresentation, qualifierPresentation } from '../src/web/glossary.mjs';

const nodes = [
  { id: 'damage', label: '伤害' },
  { id: 'enemy', label: '敌人' },
];

test('概念列表摘要不把规则端点限定误写成概念分类', () => {
  assert.deepEqual(conceptStructurePresentation(nodes[0], nodes), { shape: '概念', summary: '概念', base: null, qualifiers: [] });
  assert.deepEqual(conceptStructurePresentation({ ...nodes[0], baseConceptId: 'damage', qualifiers: [{ key: 'target', value: { kind: 'concept', conceptId: 'enemy' } }] }, nodes),
    { shape: '概念', summary: '概念', base: null, qualifiers: [] });
});

test('限定 literal 展示四类明确类型和值', () => {
  const cases = [
    [{ key: 'text', value: { kind: 'literal', value: '火焰' } }, 'text：literal string “火焰”'],
    [{ key: 'count', value: { kind: 'literal', value: 2 } }, 'count：literal number 2'],
    [{ key: 'critical', value: { kind: 'literal', value: true } }, 'critical：literal boolean true'],
    [{ key: 'none', value: { kind: 'literal', value: null } }, 'none：literal null null'],
  ];
  for (const [qualifier, expected] of cases) assert.equal(qualifierPresentation(qualifier, nodes), expected);
});

test('规则端点限定的缺失引用仍显式展示 ID', () => {
  assert.equal(qualifierPresentation({ key: 'target', value: { kind: 'concept', conceptId: 'missing-target' } }, nodes),
    'target：概念 缺失概念（ID：missing-target）');
});

test('概念编辑状态提供可见按钮与保存取消文案', () => {
  assert.deepEqual(conceptEditPresentation({ label: '伤害' }), {
    buttonLabel: '编辑概念', title: '编辑概念：伤害', saveLabel: '保存概念结构', cancelLabel: '取消编辑',
  });
});
