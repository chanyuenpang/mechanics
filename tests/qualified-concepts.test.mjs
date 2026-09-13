import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDocument, validateWorkspace } from '../src/domain/validate.mjs';

const node = id => ({ id, label: id, description: '测试概念', agentLocked: false });
const influence = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'influence', sign: 1, inheritance: { mode: 'none' } });
const specializes = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'specializes' });
function workspace(nodes, edges = [], mechanics = null) {
  const graphs = mechanics ?? [{ schemaVersion: 7, kind: 'mechanic', workspaceId: 'sample', id: 'rules', name: '规则', scope: '测试', focusNodeIds: nodes.map(item => item.id), pinnedRuleIds: edges.map(edge => edge.id), positions: {} }];
  return { manifest: { schemaVersion: 12, kind: 'workspace', id: 'sample', name: '测试', definitions: 'definitions.json', rules: 'rules.json', agentExportPath: 'mechanics', compositions: [] },
    definitions: { schemaVersion: 7, kind: 'definitions', workspaceId: 'sample', nodes, tagDefinitions: [], positions: {} }, rules: { schemaVersion: 1, kind: 'rules', workspaceId: 'sample', rules: edges }, mechanics: graphs, views: [] };
}

test('概念不以限定词派生为新类型；限定词只属于规则端点', () => {
  const definitions = { schemaVersion: 7, kind: 'definitions', workspaceId: 'sample', nodes: [node('damage'), node('target')], tagDefinitions: [], positions: {} };
  assertDocument(definitions, 'definitions');
  const graph = workspace(definitions.nodes, [{ ...influence('damage', 'target'), sourceQualifiers: [{ key: 'target-faction', value: { kind: 'literal', value: 'enemy' } }] }]);
  validateWorkspace(graph);
});

test('specializes 仅允许无 sign 的有向 DAG，influence 必须显式 inheritance:none', () => {
  const nodes = ['damage', 'target', 'damage-to-target', 'damage-to-target-critical'].map(node);
  const valid = workspace(nodes, [influence('damage', 'target'), specializes('damage-to-target', 'damage'), specializes('damage-to-target-critical', 'damage-to-target')]);
  validateWorkspace(valid);
  const missingInheritance = structuredClone(valid); delete missingInheritance.rules.rules[0].inheritance;
  assert.throws(() => validateWorkspace(missingInheritance), { code: 'INVALID_DOCUMENT' });
  const self = workspace(nodes, [specializes('damage', 'damage')]);
  assert.throws(() => validateWorkspace(self), { code: 'SPECIALIZES_SELF_LINK' });
  const cross = workspace(nodes, [specializes('damage', 'target'), specializes('target', 'damage')]);
  assert.throws(() => validateWorkspace(cross), { code: 'SPECIALIZES_CYCLE' });
  const signedSpecializes = workspace(nodes, [{ ...specializes('damage', 'target'), sign: 1 }]);
  assert.throws(() => validateWorkspace(signedSpecializes), { code: 'INVALID_DOCUMENT' });
});
