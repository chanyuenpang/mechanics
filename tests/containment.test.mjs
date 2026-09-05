import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSpecializes } from '../src/domain/graph.mjs';
import { assertDocument, validateWorkspace } from '../src/domain/validate.mjs';

const influence = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'influence', sign: 1, inheritance: { mode: 'none' } });
const specializes = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'specializes' });
function workspace(edges) {
  const ids = ['base', 'specific', 'other'];
  return {
    manifest: { schemaVersion: 8, kind: 'workspace', id: 'sample', name: '测试', definitions: 'definitions.graph.json', agentExportPath: 'game-mechanics', compositions: [] },
    definitions: { schemaVersion: 4, kind: 'definitions', workspaceId: 'sample', nodes: ids.map(id => ({ id, label: id, description: '测试', agentLocked: false })), positions: {} },
    mechanics: [{ schemaVersion: 4, kind: 'mechanic', workspaceId: 'sample', id: 'rule', name: '机制', scope: '人工构造', nodeIds: ids, edges, positions: {} }],
    views: [],
  };
}

test('v4 机制只接受带固定 inheritance 的 influence 与无 sign/inheritance 的 specializes', () => {
  const current = workspace([influence('base', 'specific')]).mechanics[0];
  assertDocument(current, 'mechanic');
  const structural = workspace([specializes('specific', 'base')]).mechanics[0];
  assertDocument(structural, 'mechanic');
  for (const mutate of [
    edge => { delete edge.inheritance; },
    edge => { edge.inheritance = { mode: 'other' }; },
    edge => { edge.relation = 'specializes'; },
    edge => { edge.relation = 'specializes'; delete edge.inheritance; edge.sign = 1; },
  ]) {
    const invalid = structuredClone(current); mutate(invalid.edges[0]);
    assert.throws(() => assertDocument(invalid, 'mechanic'));
  }
});

test('specializes 拒绝自连接并在全工作区拒绝 DAG 闭环', () => {
  assert.throws(() => validateWorkspace(workspace([specializes('base', 'base')])), { code: 'SPECIALIZES_SELF_LINK' });
  const data = workspace([specializes('specific', 'base')]);
  data.mechanics.push({ ...structuredClone(data.mechanics[0]), id: 'reverse', edges: [specializes('base', 'specific')] });
  validateWorkspace({ ...data, mechanics: [data.mechanics[0]] });
  assert.throws(() => validateWorkspace(data), { code: 'SPECIALIZES_CYCLE' });
  assert.throws(() => assertSpecializes([specializes('base', 'base')]), { code: 'SPECIALIZES_SELF_LINK' });
});
