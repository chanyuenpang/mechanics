import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptPayloadFromForm, prepareConceptUpdate } from '../src/web/glossary.mjs';

const base = { id: 'damage', label: '伤害', description: '测试', agentLocked: false };

test('概念表单默认不写空自定义文本，非空文本完整保留', () => {
  assert.deepEqual(conceptPayloadFromForm(base), base);
  assert.deepEqual(conceptPayloadFromForm({ ...base, customData: 'refs: combat/card' }), { ...base, customData: 'refs: combat/card' });
});

test('概念表单要求明确 Agent 锁，并拒绝非文本自定义数据', () => {
  assert.throws(() => conceptPayloadFromForm({ ...base, agentLocked: undefined }), /明确 agentLocked/);
  assert.throws(() => conceptPayloadFromForm({ ...base, agentLocked: 'false' }), /明确 agentLocked/);
  assert.throws(() => conceptPayloadFromForm({ ...base, customData: { refs: [] } }), /自定义文本/);
});

test('概念更新仅更新可编辑字段，空自定义文本会删除既有值', () => {
  const definitions = { nodes: [{ ...base, customData: '旧数据' }] };
  const next = prepareConceptUpdate(definitions, 'damage', { ...base, label: '新伤害', customData: '' });
  assert.deepEqual(next.nodes[0], { ...base, label: '新伤害' });
});
