import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptReferencePickerCandidates } from '../src/web/glossary.mjs';

const node = (id, extra = {}) => ({ id, label: '概念 ' + id, description: '定义 ' + id, agentLocked: false, ...extra });

test('picker 在 150 项中按 label、ID、别名、描述和标签检索，且每个候选都可被 ID 找到', () => {
  const nodes = Array.from({ length: 150 }, (_, index) => node('concept-' + String(index).padStart(3, '0')));
  nodes[17] = node('concept-017', { label: '火焰伤害', aliases: ['灼烧'], description: '持续生命损失', tags: ['元素'] });
  for (const item of nodes) assert.deepEqual(conceptReferencePickerCandidates(nodes, { query: item.id }).map(candidate => candidate.id), [item.id]);
  assert.deepEqual(conceptReferencePickerCandidates(nodes, { query: '火焰' }).map(candidate => candidate.id), ['concept-017']);
  assert.deepEqual(conceptReferencePickerCandidates(nodes, { query: '灼烧' }).map(candidate => candidate.id), ['concept-017']);
  assert.deepEqual(conceptReferencePickerCandidates(nodes, { query: '持续生命' }).map(candidate => candidate.id), ['concept-017']);
  assert.deepEqual(conceptReferencePickerCandidates(nodes, { query: '元素' }).map(candidate => candidate.id), ['concept-017']);
});

test('base picker 只返回基础概念并排除当前概念，qualifier picker 只排除当前概念', () => {
  const nodes = [node('current'), node('base'), node('qualified', { baseConceptId: 'base' })];
  assert.deepEqual(conceptReferencePickerCandidates(nodes, { kind: 'base', currentId: 'current' }).map(item => item.id), ['base']);
  assert.deepEqual(conceptReferencePickerCandidates(nodes, { kind: 'qualifier', currentId: 'current' }).map(item => item.id), ['base', 'qualified']);
  assert.deepEqual(conceptReferencePickerCandidates(nodes, { kind: 'base', currentId: 'base', query: 'base' }), []);
});

test('picker 对无匹配和无效引用类型给出明确的纯模型结果', () => {
  const nodes = [node('base')];
  assert.deepEqual(conceptReferencePickerCandidates(nodes, { query: '不存在' }), []);
  assert.throws(() => conceptReferencePickerCandidates(nodes, { kind: 'unknown' }), /引用类型/);
});
