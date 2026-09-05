import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptPayloadFromForm, qualifierRowForKind, qualifierValueControlModel, qualifierValueFromForm, qualifierFormRowFromCanonical, prepareConceptUpdate } from '../src/web/glossary.mjs';

const base = { id: 'damage', label: '伤害', description: '测试', agentLocked: false, shape: 'base' };

test('基础概念 payload 不写限定字段且保留明确的 Agent 锁状态', () => {
  assert.deepEqual(conceptPayloadFromForm(base), { id: 'damage', label: '伤害', description: '测试', agentLocked: false });
  assert.equal(conceptPayloadFromForm({ ...base, agentLocked: true }).agentLocked, true);
  assert.equal(conceptPayloadFromForm({ ...base, agentLocked: false }).agentLocked, false);
});

test('概念表单缺少或给出非布尔 Agent 锁明确失败', () => {
  assert.throws(() => conceptPayloadFromForm({ ...base, agentLocked: undefined }), /明确 agentLocked/);
  assert.throws(() => conceptPayloadFromForm({ ...base, agentLocked: 'false' }), /明确 agentLocked/);
});
test('限定概念 payload 保留多项 concept 与四类 literal', () => {
  const node = conceptPayloadFromForm({ ...base, id: 'damage-target', shape: 'qualified', baseConceptId: 'damage', qualifiers: [
    { key: 'target', kind: 'concept', conceptId: 'enemy' },
    { key: 'text', kind: 'literal', literalType: 'string', literalValue: '火焰' },
    { key: 'count', kind: 'literal', literalType: 'number', literalValue: '2' },
    { key: 'critical', kind: 'literal', literalType: 'boolean', literalValue: 'true' },
    { key: 'none', kind: 'literal', literalType: 'null' },
  ] });
  assert.deepEqual(node.qualifiers, [{ key: 'target', value: { kind: 'concept', conceptId: 'enemy' } }, { key: 'text', value: { kind: 'literal', value: '火焰' } }, { key: 'count', value: { kind: 'literal', value: 2 } }, { key: 'critical', value: { kind: 'literal', value: true } }, { key: 'none', value: { kind: 'literal', value: null } }]);
});
test('删除后的空限定不由 Web 修补，保留给合同拒绝', () => {
  const node = conceptPayloadFromForm({ ...base, shape: 'qualified', baseConceptId: 'damage', qualifiers: [] });
  assert.deepEqual(node.qualifiers, []);
});
test('canonical 限定项经表单往返保持语义', () => {
  const qualifiers = [{ key: 'target', value: { kind: 'concept', conceptId: 'enemy' } }, { key: 'text', value: { kind: 'literal', value: '火焰' } }, { key: 'number', value: { kind: 'literal', value: 2 } }, { key: 'boolean', value: { kind: 'literal', value: true } }, { key: 'none', value: { kind: 'literal', value: null } }];
  const node = conceptPayloadFromForm({ ...base, shape: 'qualified', baseConceptId: 'damage', qualifiers: qualifiers.map(qualifierFormRowFromCanonical) });
  assert.deepEqual(node.qualifiers, qualifiers);
});
test('原子更新同时切换基础与限定字段', () => {
  const definitions = { nodes: [{ ...base, agentLocked: false }] };
  const qualified = prepareConceptUpdate(definitions, 'damage', { ...definitions.nodes[0], shape: 'qualified', baseConceptId: 'damage-base', qualifiers: [{ key: 'target', kind: 'concept', conceptId: 'enemy' }] });
  assert.deepEqual(qualified.nodes[0].baseConceptId, 'damage-base'); assert.deepEqual(qualified.nodes[0].qualifiers, [{ key: 'target', value: { kind: 'concept', conceptId: 'enemy' } }]);
  const plain = prepareConceptUpdate(qualified, 'damage', { ...qualified.nodes[0], shape: 'base' });
  assert.equal('baseConceptId' in plain.nodes[0], false); assert.equal('qualifiers' in plain.nodes[0], false);
});
test('已有限定概念无修改保存保持语义', () => {
  const node = { ...base, agentLocked: false, baseConceptId: 'damage-base', qualifiers: [{ key: 'target', value: { kind: 'concept', conceptId: 'enemy' } }] };
  const next = prepareConceptUpdate({ nodes: [node] }, 'damage', { ...node, shape: 'qualified', qualifiers: node.qualifiers.map(qualifierFormRowFromCanonical) });
  assert.deepEqual(next.nodes[0], node);
});
test('限定 literal 值控件模型区分四种标量类型', () => {
  assert.deepEqual(qualifierValueControlModel({ kind: 'literal', literalType: 'boolean' }), { tag: 'select', options: [['true', 'true'], ['false', 'false']] });
  assert.deepEqual(qualifierValueControlModel({ kind: 'literal', literalType: 'number' }), { tag: 'input', type: 'number' });
  assert.deepEqual(qualifierValueControlModel({ kind: 'literal', literalType: 'string' }), { tag: 'input', type: 'text' });
  assert.deepEqual(qualifierValueControlModel({ kind: 'literal', literalType: 'null' }), { tag: 'none' });
});
test('限定项 kind 切换重置字段且不保留旧字段', () => {
  const old = { key: 'target', kind: 'literal', conceptId: 'enemy', literalType: 'number', literalValue: '2' };
  assert.deepEqual(qualifierRowForKind(old, 'concept'), { key: 'target', kind: 'concept', conceptId: '' });
  assert.deepEqual(qualifierRowForKind(old, 'literal'), { key: 'target', kind: 'literal', literalType: 'string', literalValue: '' });
});
test('非法 literal 控件值明确失败', () => {
  assert.throws(() => qualifierValueFromForm({ kind: 'literal', literalType: 'boolean', literalValue: 'yes' }));
  assert.throws(() => qualifierValueFromForm({ kind: 'literal', literalType: 'number', literalValue: 'NaN' }));
  assert.throws(() => qualifierValueFromForm({ kind: 'literal', literalType: 'number', literalValue: '' }), /不能为空/);
  assert.throws(() => qualifierValueFromForm({ kind: 'literal', literalType: 'number', literalValue: '  \t ' }), /不能为空/);
});
