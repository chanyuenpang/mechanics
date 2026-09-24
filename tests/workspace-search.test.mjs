import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copiedExampleProject, runWorkspaceTool, runWorkspaceToolFailure } from './workspace-tool-harness.mjs';

for (const variant of ['bad-json', 'bad-schema', 'missing-rule', 'view-only-change']) {
  test(`只读查询不读取视图，保存仍执行完整门禁：${variant}`, async t => {
    const project = await copiedExampleProject(t), workspace = join(project, '.mechanics');
    const manifestPath = join(workspace, 'workspace.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const view = { schemaVersion: 5, kind: 'view', workspaceId: manifest.id, id: 'query-view', name: '查询隔离视图',
      mechanicRegistrations: [{ mechanicId: 'basic-rules', visible: true }], focusNodeIds: [], pinnedRuleIds: [],
      collapsedNodeIds: [], positions: {}, structuralPresentation: 'line', taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } };
    const viewPath = join(workspace, 'views/query-view.view.json');
    await mkdir(join(workspace, 'views'), { recursive: true });
    await writeFile(viewPath, JSON.stringify(view));
    manifest.lastView = { viewId: view.id };
    manifest.exportSelections = [{ kind: 'view', viewId: view.id }];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const draft = await runWorkspaceTool(project, ['draft', 'open', '--mechanic', 'basic-rules']);
    const before = await runWorkspaceTool(project, ['search', '--query', 'damage']);
    if (variant === 'bad-schema') view.unexpected = true;
    if (variant === 'missing-rule') view.pinnedRuleIds = ['damage-2-ghost'];
    if (variant === 'view-only-change') view.name = '仅修改视图名称';
    await writeFile(viewPath, variant === 'bad-json' ? '{' : JSON.stringify(view));
    const paths = [manifestPath, join(workspace, manifest.definitions), join(workspace, manifest.rules),
      ...['basic-rules', 'encounter', 'hand'].map(id => join(workspace, `mechanics/${id}.mechanic.json`)), viewPath];
    const canonical = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    for (const args of [['scopes'], ['search', '--query', 'damage'], ['graph', '--ids', 'damage,health'],
      ['node', '--id', 'damage'], ['impact', '--from', 'damage', '--to', 'health']]) {
      assert.equal((await runWorkspaceTool(project, args)).revision, before.revision);
    }
    if (variant === 'view-only-change') {
      assert.equal((await runWorkspaceTool(project, ['draft', 'save', '--draft', draft.draftId])).saved, true);
      assert.equal(await readFile(viewPath, 'utf8'), canonical.at(-1));
    } else {
      for (const action of ['validate', 'save']) {
        const error = await runWorkspaceToolFailure(project, ['draft', action, '--draft', draft.draftId]);
        assert.ok(['INVALID_JSON', 'INVALID_DOCUMENT', 'MISSING_REFERENCE'].includes(error.error), JSON.stringify(error));
        assert.match(error.message, /query-view/);
      }
      assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), canonical);
      assert.ok(await readFile(draft.rulesPath, 'utf8'));
    }
  });
}

test('只读查询仍拒绝核心规则的无效端点', async t => {
  const project = await copiedExampleProject(t), path = join(project, '.mechanics/rules.json');
  const rules = JSON.parse(await readFile(path, 'utf8'));
  rules.rules[0].source = 'missing-source';
  await writeFile(path, JSON.stringify(rules));
  const error = await runWorkspaceToolFailure(project, ['search', '--query', 'damage']);
  assert.equal(error.error, 'MISSING_REFERENCE');
});

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
  assert.equal(guide.contractVersion, 7);
  assert.ok(guide.commands.includes('graph'));
  assert.ok(guide.constraints.some(item => item.includes('fuzzy')));
});
