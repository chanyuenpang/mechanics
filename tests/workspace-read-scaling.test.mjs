import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspace } from '../src/server/workspace.mjs';
import { validateWorkspace, validateMechanicResource, validateViewResource, workspaceValidationCore } from '../src/domain/validate.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'mechanics-read-scaling-'));
  await copyExampleFixture(projectRoot);
  t.after(async () => { await rm(projectRoot, { recursive: true, force: true }); });
  return { projectRoot, root: join(projectRoot, '.mechanics') };
}

const viewDocument = (overrides = {}) => ({
  schemaVersion: 5, kind: 'view', workspaceId: 'sample-card-game', id: 'battle', name: '战斗视图',
  mechanicRegistrations: [{ mechanicId: 'basic-rules', visible: true }], focusNodeIds: [], pinnedRuleIds: [],
  collapsedNodeIds: [], positions: {}, structuralPresentation: 'line', taxonomyPresentation: { mode: 'label', expandedNodeIds: [] },
  ...overrides,
});

// 读取路径曾经对每张机制图都重跑一次完整 validateWorkspace：在 1144 概念 / 3047 规则 /
// 199 机制图的项目上，这让一次读取多花约 2.7 秒。核心只校验一次、逐资源只校验自身，
// 是这条路径的性能合同，因此用源码断言把它锁住。
test('读取工作区时核心只校验一次，逐资源只做自身结构与引用校验', async () => {
  const source = await readFile(new URL('../src/server/workspace.mjs', import.meta.url), 'utf8');
  assert.match(source, /const core = workspaceValidationCore\(\{ manifest, definitions, rules \}\)/);
  const loop = source.slice(source.indexOf('for (const item of compatible.mechanics)'), source.indexOf('const files = ['));
  assert.match(loop, /validateMechanicResource\(core, document, file\)/);
  assert.match(loop, /validateViewResource\(core, document, file\)/);
  assert.doesNotMatch(loop, /validateWorkspace\(/);
});

test('逐资源校验与完整校验对同一份坏机制图给出相同错误码', async t => {
  const { root } = await fixture(t);
  const workspace = await readWorkspace(root);
  const core = workspaceValidationCore({ manifest: workspace.manifest, definitions: workspace.definitions, rules: workspace.rules });
  const mechanic = structuredClone(workspace.mechanics[0]);
  const fullCode = document => {
    try { validateWorkspace({ manifest: workspace.manifest, definitions: workspace.definitions, rules: workspace.rules, mechanics: [document], views: [], files: [] }); return null; }
    catch (error) { return error.code; }
  };
  const cases = [
    ['focusNodeIds 引用不存在的概念', { ...mechanic, focusNodeIds: [...mechanic.focusNodeIds, 'absent-concept'] }],
    ['pinnedRuleIds 引用不存在的规则', { ...mechanic, pinnedRuleIds: [...mechanic.pinnedRuleIds, 'absent-rule'] }],
    ['工作区 ID 不一致', { ...mechanic, workspaceId: 'other-workspace' }],
    ['文档结构错误', { ...mechanic, focusNodeIds: 'not-an-array' }],
  ];
  for (const [label, document] of cases) {
    const expected = fullCode(document);
    assert.ok(expected, label + ' 应当被完整校验拒绝');
    assert.throws(() => validateMechanicResource(core, document, 'mechanics/x.mechanic.json'), { code: expected }, label);
  }
});

test('视图资源仍然校验注册机制、自身引用与重复注册', async t => {
  const { root } = await fixture(t);
  const workspace = await readWorkspace(root);
  const core = workspaceValidationCore({ manifest: workspace.manifest, definitions: workspace.definitions, rules: workspace.rules });
  validateMechanicResource(core, structuredClone(workspace.mechanics[0]), workspace.files.find(file => file.kind === 'mechanic').path);
  assert.throws(() => validateViewResource(core, viewDocument({ mechanicRegistrations: [{ mechanicId: 'absent-graph', visible: true }] }), 'views/battle.view.json'),
    { code: 'MISSING_REFERENCE' });
  assert.throws(() => validateViewResource(core, viewDocument({ mechanicRegistrations: [{ mechanicId: 'basic-rules', visible: true }, { mechanicId: 'basic-rules', visible: false }] }), 'views/battle.view.json'),
    { code: 'DUPLICATE_ID' });
  assert.throws(() => validateViewResource(core, viewDocument({ focusNodeIds: ['absent-concept'] }), 'views/battle.view.json'),
    { code: 'MISSING_REFERENCE' });
  validateViewResource(core, viewDocument(), 'views/battle.view.json');
  assert.throws(() => validateViewResource(core, viewDocument(), 'views/battle.view.json'), { code: 'DUPLICATE_ID' }, '同一视图 ID 只允许出现一次');
});

test('磁盘上的视图参与读取校验：坏注册机制仍然拒绝整个工作区', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'views'), { recursive: true });
  await writeFile(join(root, 'views', 'battle.view.json'), JSON.stringify(viewDocument()));
  const workspace = await readWorkspace(root);
  assert.deepEqual(workspace.views.map(view => view.id), ['battle']);
  await writeFile(join(root, 'views', 'battle.view.json'), JSON.stringify(viewDocument({ mechanicRegistrations: [{ mechanicId: 'absent-graph', visible: true }] })));
  await assert.rejects(() => readWorkspace(root), { code: 'MISSING_REFERENCE' });
});
