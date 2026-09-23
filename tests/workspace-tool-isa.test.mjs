import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copiedExampleProject, runWorkspaceTool, runWorkspaceToolFailure } from './workspace-tool-harness.mjs';

test('isa set 在草稿里替换 is-a 出边并同步固定引用，validate/save 一致', async t => {
  const projectRoot = await copiedExampleProject(t);
  const guide = await runWorkspaceTool(projectRoot, ['guide']);
  assert.ok(guide.commands.includes('isa set'));
  assert.ok(guide.constraints.some(line => line.includes('至多一个父概念')));

  const draft = await runWorkspaceTool(projectRoot, ['draft', 'open', '--mechanic', 'basic-rules']);
  const rulesBefore = JSON.parse(await readFile(draft.rulesPath, 'utf8'));
  const mechanicBefore = JSON.parse(await readFile(draft.mechanicPath, 'utf8'));
  assert.equal(rulesBefore.rules.some(rule => rule.relation === 'specializes'), false);

  // 指定父概念：新增出边并固定到当前机制草稿。
  const added = await runWorkspaceTool(projectRoot, ['isa', 'set', '--draft', draft.draftId, '--concept', 'damage', '--parent', 'failure']);
  assert.equal(added.changed, true);
  assert.equal(added.addedRuleId, 'damage-2-failure');
  const rulesAfterAdd = JSON.parse(await readFile(added.rulesPath, 'utf8'));
  assert.deepEqual(rulesAfterAdd.rules.find(rule => rule.id === 'damage-2-failure'),
    { id: 'damage-2-failure', source: 'damage', target: 'failure', relation: 'specializes' });
  const mechanicAfterAdd = JSON.parse(await readFile(added.mechanicPath, 'utf8'));
  assert.ok(mechanicAfterAdd.pinnedRuleIds.includes('damage-2-failure'));
  assert.ok(mechanicAfterAdd.focusNodeIds.includes('damage') && mechanicAfterAdd.focusNodeIds.includes('failure'));
  assert.deepEqual((await runWorkspaceTool(projectRoot, ['draft', 'validate', '--draft', draft.draftId])).valid, true);

  // 更换父概念：旧出边消失、旧固定引用同步移除。
  const moved = await runWorkspaceTool(projectRoot, ['isa', 'set', '--draft', draft.draftId, '--concept', 'damage', '--parent', 'repel']);
  assert.equal(moved.removedRuleId, 'damage-2-failure');
  const rulesAfterMove = JSON.parse(await readFile(moved.rulesPath, 'utf8'));
  assert.equal(rulesAfterMove.rules.some(rule => rule.id === 'damage-2-failure'), false);
  assert.ok(rulesAfterMove.rules.some(rule => rule.id === 'damage-2-repel'));
  const mechanicAfterMove = JSON.parse(await readFile(moved.mechanicPath, 'utf8'));
  assert.equal(mechanicAfterMove.pinnedRuleIds.includes('damage-2-failure'), false);
  assert.ok(mechanicAfterMove.pinnedRuleIds.includes('damage-2-repel'));
  assert.ok(mechanicAfterMove.pinnedRuleIds.every(id => rulesAfterMove.rules.some(rule => rule.id === id)));
  assert.deepEqual((await runWorkspaceTool(projectRoot, ['draft', 'validate', '--draft', draft.draftId])).valid, true);

  // 幂等与清除。
  assert.equal((await runWorkspaceTool(projectRoot, ['isa', 'set', '--draft', draft.draftId, '--concept', 'damage', '--parent', 'repel'])).changed, false);
  await runWorkspaceTool(projectRoot, ['isa', 'set', '--draft', draft.draftId, '--concept', 'damage', '--parent', 'none']);
  const rulesAfterClear = JSON.parse(await readFile(draft.rulesPath, 'utf8'));
  assert.equal(rulesAfterClear.rules.some(rule => rule.relation === 'specializes' && rule.source === 'damage'), false);
  assert.deepEqual((await runWorkspaceTool(projectRoot, ['draft', 'validate', '--draft', draft.draftId])).valid, true);
  const mechanicAfterClear = JSON.parse(await readFile(draft.mechanicPath, 'utf8'));
  assert.deepEqual(rulesAfterClear, rulesBefore);
  assert.equal(mechanicAfterClear.pinnedRuleIds.includes('damage-2-repel'), false);
  assert.ok(mechanicAfterClear.pinnedRuleIds.every(id => rulesAfterClear.rules.some(rule => rule.id === id)));
  assert.notEqual(JSON.stringify(mechanicBefore), JSON.stringify(mechanicAfterAdd));

  // 自连与不存在的端点在写回前显式失败。
  const before = await readFile(draft.rulesPath, 'utf8');
  const selfLink = await runWorkspaceToolFailure(projectRoot, ['isa', 'set', '--draft', draft.draftId, '--concept', 'damage', '--parent', 'damage']);
  assert.equal(selfLink.error, 'DRAFT_VALIDATION_FAILED');
  assert.match(selfLink.message, /SPECIALIZES_SELF_LINK/);
  const missing = await runWorkspaceToolFailure(projectRoot, ['isa', 'set', '--draft', draft.draftId, '--concept', 'damage', '--parent', 'absent-concept']);
  assert.equal(missing.error, 'NODE_NOT_FOUND');
  assert.equal(await readFile(draft.rulesPath, 'utf8'), before);
});
