import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptDuplicateModel, conceptEditorModel, conceptEditorOpenState, conceptLockModel, conceptPayloadFromForm, conceptShapeWarning, prepareConceptUpdate } from '../src/web/glossary.mjs';

const base = { id: 'damage', label: '伤害', description: '造成生命损失', aliases: ['扣血'], tags: ['战斗'], agentLocked: false };

test('编辑器模型区分新建和编辑的身份字段与首焦点', () => {
  const create = conceptEditorModel('create');
  const edit = conceptEditorModel('edit', base);
  assert.equal(create.idReadonly, false); assert.equal(create.firstField, 'id'); assert.equal(create.form.agentLocked, false);
  assert.equal(edit.idReadonly, true); assert.equal(edit.firstField, 'label'); assert.deepEqual(edit.form, { ...base, shape: 'base', baseConceptId: '', qualifiers: [] });
});

test('同名治理模型排除当前概念并保留候选展示信息', () => {
  const nodes = [base, { ...base, id: 'damage-copy', description: '另一份伤害定义' }, { ...base, id: 'heal', label: '治疗' }];
  assert.deepEqual(conceptDuplicateModel(nodes, '伤害', 'damage'), [{ id: 'damage-copy', label: '伤害', description: '另一份伤害定义' }]);
  assert.deepEqual(conceptDuplicateModel(nodes, '不存在'), []);
});

test('锁模型显示状态和网页可解锁的影响说明', () => {
  assert.deepEqual(conceptLockModel(true), { state: '已锁定', checked: true, description: 'Agent 不可修改或删除；网页用户可解锁。' });
  assert.deepEqual(conceptLockModel(false), { state: '未锁定', checked: false, description: 'Agent 可以修改或删除；网页用户可随时锁定。' });
});

test('切为基础概念显示限定移除提示，切回限定保留当前表单限定', () => {
  const form = { ...conceptEditorModel('edit', { ...base, baseConceptId: 'resource', qualifiers: [{ key: 'type', value: { kind: 'concept', conceptId: 'fire' } }] }).form, shape: 'base' };
  assert.equal(conceptShapeWarning(form), '保存后将移除 1 项限定。');
  form.shape = 'qualified'; assert.equal(conceptShapeWarning(form), ''); assert.equal(form.qualifiers[0].conceptId, 'fire');
});

test('表单 payload 和编辑更新在一次提交中原子保留全部字段与结构', () => {
  const form = { ...conceptEditorModel('edit', { ...base, baseConceptId: 'resource', qualifiers: [{ key: 'type', value: { kind: 'concept', conceptId: 'fire' } }] }).form, label: '火焰伤害', agentLocked: true };
  const payload = conceptPayloadFromForm(form); assert.equal(payload.agentLocked, true); assert.equal(payload.qualifiers[0].value.conceptId, 'fire');
  const next = prepareConceptUpdate({ nodes: [{ ...base, agentLocked: false }] }, base.id, { ...form, shape: 'base' });
  assert.deepEqual(next.nodes[0], { ...base, label: '火焰伤害', agentLocked: true });
  const unlocked = prepareConceptUpdate({ nodes: [{ ...base, agentLocked: true }] }, base.id, { ...form, agentLocked: false, shape: 'base' });
  assert.equal(unlocked.nodes[0].agentLocked, false);
  assert.throws(() => prepareConceptUpdate({ nodes: [{ ...base }] }, base.id, { ...form, agentLocked: undefined }), /明确 agentLocked/);
});

test('一次只能打开一个概念编辑器状态', () => {
  assert.equal(conceptEditorOpenState(null, 'damage'), 'damage');
  assert.equal(conceptEditorOpenState('damage', 'damage'), null);
  assert.equal(conceptEditorOpenState('damage', 'resource'), 'resource');
});
