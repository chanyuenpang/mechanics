import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptEditPresentation, conceptStructurePresentation, qualifierPresentation } from '../src/web/glossary.mjs';

const nodes = [
  { id: 'damage', label: '伤害' },
  { id: 'enemy', label: '敌人' },
];

test('基础与限定概念列表摘要明确展示结构和引用', () => {
  assert.deepEqual(conceptStructurePresentation(nodes[0], nodes), { shape: '基础概念', summary: '基础概念', base: null, qualifiers: [] });
  const qualified = { id: 'damage-enemy', label: '对敌伤害', baseConceptId: 'damage', qualifiers: [
    { key: 'target', value: { kind: 'concept', conceptId: 'enemy' } },
  ] };
  assert.deepEqual(conceptStructurePresentation(qualified, nodes), {
    shape: '限定概念', summary: '限定概念 · 基础：伤害（damage） · target：概念 敌人（enemy）',
    base: '伤害（damage）', qualifiers: ['target：概念 敌人（enemy）'],
  });
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

test('详情展示缺失引用 ID 而不猜测名称', () => {
  const qualified = { id: 'broken', label: '损坏限定', baseConceptId: 'missing-base', qualifiers: [
    { key: 'target', value: { kind: 'concept', conceptId: 'missing-target' } },
  ] };
  const result = conceptStructurePresentation(qualified, nodes);
  assert.equal(result.base, '缺失概念（ID：missing-base）');
  assert.deepEqual(result.qualifiers, ['target：概念 缺失概念（ID：missing-target）']);
});

test('概念编辑状态提供可见按钮与保存取消文案', () => {
  assert.deepEqual(conceptEditPresentation({ label: '伤害' }), {
    buttonLabel: '编辑概念', title: '编辑概念：伤害', saveLabel: '保存概念结构', cancelLabel: '取消编辑',
  });
});
