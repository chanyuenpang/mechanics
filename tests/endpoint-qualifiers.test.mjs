import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkspace } from '../src/domain/validate.mjs';
import { queryWorkspace } from '../src/domain/query.mjs';
import { semanticRuleId } from '../src/domain/identity.mjs';

const node = (id, label = id) => ({ id, label, description: '测试概念', agentLocked: false });
const qualifier = (key, value) => ({ key, value: { kind: 'literal', value } });
function workspace(edges, nodes = [node('health', '气血'), node('loss', '气血受损'), node('resource', '资源'), node('stamina', '体力')]) {
  return {
    manifest: { schemaVersion: 10, kind: 'workspace', id: 'sample', name: '测试', definitions: 'definitions.graph.json', agentExportPath: 'game-mechanics', compositions: [] },
    definitions: { schemaVersion: 5, kind: 'definitions', workspaceId: 'sample', nodes, positions: {} },
    mechanics: [{ schemaVersion: 6, kind: 'mechanic', workspaceId: 'sample', id: 'rules', name: '规则', scope: '测试', nodeIds: nodes.map(item => item.id), edges, positions: {} }],
    views: [], files: [{ kind: 'mechanic', id: 'rules', path: 'rules.mechanic.json' }], revision: 'test', resourceRevisions: { definitions: 'definitions', mechanics: { rules: 'rules' } },
  };
}
const influence = (source, target, sourceQualifiers, targetQualifiers) => ({
  id: semanticRuleId(source, target, new Set(), sourceQualifiers, targetQualifiers), source, target, relation: 'influence', sign: -1,
  inheritance: { mode: 'none' }, ...(sourceQualifiers?.length ? { sourceQualifiers } : {}), ...(targetQualifiers?.length ? { targetQualifiers } : {}),
});

test('限定词只属于影响规则端点，不制造概念身份', () => {
  const friendly = [qualifier('faction', 'friendly')];
  const data = workspace([influence('loss', 'health', friendly, friendly)]);
  assert.doesNotThrow(() => validateWorkspace(data));
  assert.equal(data.definitions.nodes.some(item => item.id === 'friendly-health'), false);
  const result = queryWorkspace(data, { command: 'graph', mechanic: 'rules' });
  assert.deepEqual(result.declarations[0].targetQualifiers, friendly);
  assert.equal(result.nodes.find(item => item.id === 'health').sourceMechanicIds, undefined);
});

test('同一有向概念对不能借限定词重复，反向关系允许', () => {
  const friendly = [qualifier('faction', 'friendly')], enemy = [qualifier('faction', 'enemy')];
  assert.throws(() => validateWorkspace(workspace([
    influence('loss', 'health', friendly, friendly), influence('loss', 'health', enemy, enemy),
  ])), { code: 'DUPLICATE_ENDPOINT_RULE' });
  assert.doesNotThrow(() => validateWorkspace(workspace([
    influence('loss', 'health', friendly, friendly), influence('health', 'loss', enemy, enemy),
  ])));
});

test('限定词不能伪装为概念或 is-a', () => {
  const legacy = node('friendly-health', '友方气血'); legacy.baseConceptId = 'health'; legacy.qualifiers = [qualifier('faction', 'friendly')];
  assert.throws(() => validateWorkspace(workspace([], [node('health'), legacy])), { code: 'INVALID_DOCUMENT' });
  const qualifiers = [qualifier('faction', 'friendly')];
  const edge = { id: 'stamina-2-resource', source: 'stamina', target: 'resource', relation: 'specializes', sourceQualifiers: qualifiers };
  assert.throws(() => validateWorkspace(workspace([edge])), { code: 'INVALID_DOCUMENT' });
});

test('is-a 子类在展开查询时继承母类规则', () => {
  const edges = [
    { id: 'stamina-2-resource', source: 'stamina', target: 'resource', relation: 'specializes' },
    { id: 'resource-2-health', source: 'resource', target: 'health', relation: 'influence', sign: 1, inheritance: { mode: 'none' } },
  ];
  const result = queryWorkspace(workspace(edges), { command: 'graph', mechanic: 'rules', includeInherited: true });
  assert.ok(result.derived.some(edge => edge.source === 'stamina' && edge.target === 'health'));
});
