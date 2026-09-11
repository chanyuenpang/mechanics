import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSpecializes } from '../src/domain/graph.mjs';
import { assertDocument, validateWorkspace } from '../src/domain/validate.mjs';

const influence = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'influence', sign: 1, inheritance: { mode: 'none' } });
const specializes = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'specializes' });
function workspace(edges) {
  const ids = ['base', 'specific', 'other'];
  return {
    manifest: { schemaVersion: 11, kind: 'workspace', id: 'sample', name: '测试', definitions: 'definitions.json', rules: 'rules.json', agentExportPath: 'mechanics', compositions: [] },
    definitions: { schemaVersion: 6, kind: 'definitions', workspaceId: 'sample', nodes: ids.map(id => ({ id, label: id, description: '测试', agentLocked: false })), positions: {} },
    rules: { schemaVersion: 1, kind: 'rules', workspaceId: 'sample', rules: edges },
    mechanics: [{ schemaVersion: 7, kind: 'mechanic', workspaceId: 'sample', id: 'rule', name: '机制', scope: '人工构造', focusNodeIds: ids, pinnedRuleIds: edges.map(edge => edge.id), positions: {} }],
    views: [],
  };
}

test('全局规则库只接受带固定 inheritance 的 influence 与无 sign/inheritance 的 specializes', () => {
  const current = workspace([influence('base', 'specific')]).rules;
  assertDocument(current, 'rules');
  const structural = workspace([specializes('specific', 'base')]).rules;
  assertDocument(structural, 'rules');
  for (const mutate of [
    edge => { delete edge.inheritance; },
    edge => { edge.inheritance = { mode: 'other' }; },
    edge => { edge.relation = 'specializes'; },
    edge => { edge.relation = 'specializes'; delete edge.inheritance; edge.sign = 1; },
  ]) {
    const invalid = structuredClone(current); mutate(invalid.rules[0]);
    assert.throws(() => assertDocument(invalid, 'rules'));
  }
});

test('specializes 拒绝自连接并在全工作区拒绝 DAG 闭环', () => {
  assert.throws(() => validateWorkspace(workspace([specializes('base', 'base')])), { code: 'SPECIALIZES_SELF_LINK' });
  const data = workspace([specializes('specific', 'base')]);
  validateWorkspace(data);
  data.rules.rules.push(specializes('base', 'specific'));
  assert.throws(() => validateWorkspace(data), { code: 'SPECIALIZES_CYCLE' });
  assert.throws(() => assertSpecializes([specializes('base', 'base')]), { code: 'SPECIALIZES_SELF_LINK' });
});
