import test from 'node:test';
import assert from 'node:assert/strict';
import { copiedExampleProject, runWorkspaceTool, runWorkspaceToolFailure } from './workspace-tool-harness.mjs';

test('graph 只投影请求集合内部已声明的规则', async t => {
  const projectRoot = await copiedExampleProject(t);
  const result = await runWorkspaceTool(projectRoot, ['graph', '--ids', 'melee,damage']);
  assert.deepEqual(result.conceptIds, ['melee', 'damage']);
  assert.deepEqual(result.nodes.map(node => node.id), ['melee', 'damage']);
  assert.equal(result.nodes[0].label, '近战');
  // enemy-2-melee 与 damage-2-health 的集合外端点不得被补进来。
  assert.deepEqual(result.edges.map(edge => edge.id), ['melee-2-damage']);
  for (const edge of result.edges) {
    assert.ok(result.conceptIds.includes(edge.source));
    assert.ok(result.conceptIds.includes(edge.target));
  }
});

test('graph 按稳定 ID 排序返回集合内部的全部规则', async t => {
  const result = await runWorkspaceTool(await copiedExampleProject(t), ['graph', '--ids', 'evade,repel,melee,stamina']);
  assert.deepEqual(result.edges.map(edge => edge.id), ['evade-2-repel', 'evade-2-stamina', 'repel-2-melee']);
  assert.equal(result.edges[2].sign, -1);
  assert.equal(result.edges[2].ruleText, '该次近战受到该状态影响');
});

test('graph 对空、重复与未知 ID 明确失败', async t => {
  const projectRoot = await copiedExampleProject(t);
  const empty = await runWorkspaceToolFailure(projectRoot, ['graph', '--ids', ' ']);
  assert.equal(empty.error, 'TOOL_INVALID');
  const duplicates = await runWorkspaceToolFailure(projectRoot, ['graph', '--ids', 'melee,melee']);
  assert.equal(duplicates.error, 'TOOL_INVALID');
  assert.deepEqual(duplicates.duplicates, ['melee']);
  const unknown = await runWorkspaceToolFailure(projectRoot, ['graph', '--ids', 'melee,not-a-concept']);
  assert.equal(unknown.error, 'NODE_NOT_FOUND');
  assert.deepEqual(unknown.unknownIds, ['not-a-concept']);
  const missing = await runWorkspaceToolFailure(projectRoot, ['graph']);
  assert.equal(missing.error, 'TOOL_INVALID');
});
