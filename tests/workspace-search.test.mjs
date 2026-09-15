import test from 'node:test';
import assert from 'node:assert/strict';
import { copiedExampleProject, runWorkspaceTool } from './workspace-tool-harness.mjs';

test('search --query 精确命中的返回形状保持不变', async t => {
  const result = await runWorkspaceTool(await copiedExampleProject(t), ['search', '--query', '闪避行动']);
  assert.equal(result.concept.id, 'evade');
  assert.equal(result.matchedBy, 'label');
  assert.equal(result.resolution, undefined);
});

test('search --query 部分词返回模糊候选，且不自动消歧', async t => {
  const projectRoot = await copiedExampleProject(t);
  const prefix = await runWorkspaceTool(projectRoot, ['search', '--query', '闪避']);
  assert.equal(prefix.resolution.status, 'fuzzy');
  assert.equal(prefix.concept, undefined);
  assert.deepEqual(prefix.resolution.candidates.map(item => item.id), ['evade']);
  assert.deepEqual(prefix.resolution.candidates[0].matchedBy, ['label-prefix', 'description-contains']);
  assert.equal(prefix.resolution.candidates[0].score, 100);
  assert.equal(prefix.resolution.total, 1);
  assert.equal(prefix.resolution.truncated, false);
  const description = await runWorkspaceTool(projectRoot, ['search', '--query', '抽象']);
  assert.equal(description.resolution.status, 'fuzzy');
  assert.deepEqual(description.resolution.candidates.map(item => item.id), ['evade', 'repel']);
  assert.deepEqual(description.resolution.candidates[0].matchedBy, ['description-contains']);
});

test('search --query 完全无命中时仍是 not_found', async t => {
  const result = await runWorkspaceTool(await copiedExampleProject(t), ['search', '--query', '完全不存在的概念']);
  assert.equal(result.resolution.status, 'not_found');
  assert.equal(result.resolution.candidates, undefined);
});

test('search --from/--to 仍只做精确解析，guide 已声明模糊语义', async t => {
  const projectRoot = await copiedExampleProject(t);
  const pair = await runWorkspaceTool(projectRoot, ['search', '--from', '闪避', '--to', '近战']);
  assert.equal(pair.rules, null);
  assert.equal(pair.from.status, 'not_found');
  const guide = await runWorkspaceTool(projectRoot, ['guide']);
  assert.equal(guide.contractVersion, 6);
  assert.ok(guide.commands.includes('graph'));
  assert.ok(guide.constraints.some(item => item.includes('fuzzy')));
});
