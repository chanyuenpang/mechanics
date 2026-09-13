import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptDuplicateModel, conceptEditorModel, conceptEditorOpenState, conceptLockModel, conceptPayloadFromForm, prepareConceptUpdate } from '../src/web/glossary.mjs';

const base = { id: 'damage', label: '伤害', description: '造成生命损失', aliases: ['扣血'], tagIds: ['战斗'], agentLocked: false };

test('编辑器模型区分新建和编辑的身份字段与首焦点', () => {
  const create = conceptEditorModel('create');
  const edit = conceptEditorModel('edit', base);
  assert.equal(create.idReadonly, false); assert.equal(create.firstField, 'id'); assert.equal(create.form.agentLocked, false);
  assert.equal(edit.idReadonly, true); assert.equal(edit.firstField, 'label'); assert.deepEqual(edit.form, { ...base, customData: '' });
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

test('表单 payload 和编辑更新原子保留自定义文本与权限', () => {
  const form = { ...conceptEditorModel('edit', base).form, label: '火焰伤害', customData: 'refs: combat/card', agentLocked: true };
  const payload = conceptPayloadFromForm(form); assert.equal(payload.agentLocked, true); assert.equal(payload.customData, 'refs: combat/card');
  const next = prepareConceptUpdate({ nodes: [{ ...base, agentLocked: false }] }, base.id, form);
  assert.deepEqual(next.nodes[0], { ...base, label: '火焰伤害', customData: 'refs: combat/card', agentLocked: true });
  const unlocked = prepareConceptUpdate({ nodes: [{ ...base, agentLocked: true, customData: '保留' }] }, base.id, { ...form, agentLocked: false, customData: '' });
  assert.equal(unlocked.nodes[0].agentLocked, false);
  assert.equal('customData' in unlocked.nodes[0], false);
  assert.throws(() => prepareConceptUpdate({ nodes: [{ ...base }] }, base.id, { ...form, agentLocked: undefined }), /明确 agentLocked/);
});

test('一次只能打开一个概念编辑器状态', () => {
  assert.equal(conceptEditorOpenState(null, 'damage'), 'damage');
  assert.equal(conceptEditorOpenState('damage', 'damage'), null);
  assert.equal(conceptEditorOpenState('damage', 'resource'), 'resource');
});
