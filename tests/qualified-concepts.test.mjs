import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDocument, validateWorkspace } from '../src/domain/validate.mjs';

const node = id => ({ id, label: id, description: '测试概念', agentLocked: false });
const influence = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'influence', sign: 1, inheritance: { mode: 'none' } });
const specializes = (source, target) => ({ id: source + '-2-' + target, source, target, relation: 'specializes' });
function workspace(nodes, edges = [], mechanics = null) {
  const graphs = mechanics ?? [{ schemaVersion: 4, kind: 'mechanic', workspaceId: 'sample', id: 'rules', name: '规则', scope: '测试', nodeIds: nodes.map(item => item.id), edges, positions: {} }];
  return { manifest: { schemaVersion: 8, kind: 'workspace', id: 'sample', name: '测试', definitions: 'definitions.graph.json', agentExportPath: 'game-mechanics', compositions: [] },
    definitions: { schemaVersion: 4, kind: 'definitions', workspaceId: 'sample', nodes, positions: {} }, mechanics: graphs, views: [] };
}

const qualified = (id, baseConceptId, qualifiers) => ({ ...node(id), baseConceptId, qualifiers });

test('基础与限定概念是互斥形态，且限定值只允许 concept 或 JSON 标量 literal', () => {
  const base = node('damage');
  const specialized = qualified('damage-to-target', 'damage', [{ key: 'target', value: { kind: 'concept', conceptId: 'target' } }, { key: 'critical', value: { kind: 'literal', value: true } }]);
  validateWorkspace(workspace([base, node('target'), specialized]));
  for (const mutate of [
    value => { value.baseConceptId = 'damage'; },
    value => { value.qualifiers = []; },
    value => { value.qualifiers = [{ key: 'target', value: { kind: 'runtimeInstance', instanceId: 'x' } }]; },
    value => { value.qualifiers = [{ key: 'target', value: { kind: 'literal', value: { unsupported: true } } }]; },
  ]) {
    const candidate = node('candidate'); mutate(candidate);
    assert.throws(() => assertDocument({ schemaVersion: 4, kind: 'definitions', workspaceId: 'sample', nodes: [candidate], positions: {} }, 'definitions'), { code: 'INVALID_DOCUMENT' });
  }
});

test('限定概念拒绝非法基础、悬空引用、重复 key 与规范化重复', () => {
  const base = node('damage'), target = node('target');
  const self = workspace([base, qualified('damage-self', 'damage-self', [{ key: 'target', value: { kind: 'concept', conceptId: 'target' } }]), target]);
  assert.throws(() => validateWorkspace(self), { code: 'QUALIFIED_BASE_INVALID' });
  const nested = qualified('damage-nested', 'damage', [{ key: 'target', value: { kind: 'concept', conceptId: 'target' } }]);
  const wrongBase = workspace([base, target, nested, qualified('damage-illegal', 'damage-nested', [{ key: 'source', value: { kind: 'literal', value: 'x' } }])]);
  assert.throws(() => validateWorkspace(wrongBase), { code: 'QUALIFIED_BASE_INVALID' });
  const dangling = workspace([base, qualified('damage-dangling', 'damage', [{ key: 'target', value: { kind: 'concept', conceptId: 'missing' } }])]);
  assert.throws(() => validateWorkspace(dangling), { code: 'QUALIFIER_CONCEPT_NOT_FOUND' });
  const repeatedKey = workspace([base, target, qualified('damage-repeated-key', 'damage', [{ key: 'target', value: { kind: 'concept', conceptId: 'target' } }, { key: 'target', value: { kind: 'literal', value: 'target' } }])]);
  assert.throws(() => validateWorkspace(repeatedKey), { code: 'QUALIFIER_KEY_DUPLICATE' });
  const first = qualified('damage-first', 'damage', [{ key: 'target', value: { kind: 'concept', conceptId: 'target' } }, { key: 'critical', value: { kind: 'literal', value: true } }]);
  const second = qualified('damage-second', 'damage', [{ key: 'critical', value: { kind: 'literal', value: true } }, { key: 'target', value: { kind: 'concept', conceptId: 'target' } }]);
  assert.throws(() => validateWorkspace(workspace([base, target, first, second])), { code: 'QUALIFIED_CONCEPT_DUPLICATE' });
});

test('specializes 仅允许无 sign 的有向 DAG，influence 必须显式 inheritance:none', () => {
  const nodes = ['damage', 'target', 'damage-to-target', 'damage-to-target-critical'].map(node);
  const valid = workspace(nodes, [influence('damage', 'target'), specializes('damage-to-target', 'damage'), specializes('damage-to-target-critical', 'damage-to-target')]);
  validateWorkspace(valid);
  const missingInheritance = structuredClone(valid); delete missingInheritance.mechanics[0].edges[0].inheritance;
  assert.throws(() => validateWorkspace(missingInheritance), { code: 'INVALID_DOCUMENT' });
  const self = workspace(nodes, [specializes('damage', 'damage')]);
  assert.throws(() => validateWorkspace(self), { code: 'SPECIALIZES_SELF_LINK' });
  const cross = workspace(nodes, [], [
    { schemaVersion: 4, kind: 'mechanic', workspaceId: 'sample', id: 'one', name: '一', scope: '测试', nodeIds: nodes.map(item => item.id), edges: [specializes('damage', 'target')], positions: {} },
    { schemaVersion: 4, kind: 'mechanic', workspaceId: 'sample', id: 'two', name: '二', scope: '测试', nodeIds: nodes.map(item => item.id), edges: [specializes('target', 'damage')], positions: {} },
  ]);
  assert.throws(() => validateWorkspace(cross), { code: 'SPECIALIZES_CYCLE' });
  const signedSpecializes = workspace(nodes, [{ ...specializes('damage', 'target'), sign: 1 }]);
  assert.throws(() => validateWorkspace(signedSpecializes), { code: 'INVALID_DOCUMENT' });
});
