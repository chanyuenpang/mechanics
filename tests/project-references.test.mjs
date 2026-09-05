import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyExampleFixture } from './example-fixture.mjs';
import { bindProjectReference, declareProjectReference } from '../src/server/project-references.mjs';
import { initProject } from '../src/server/workspace-commands.mjs';

test('源项目声明参考项目，目录绑定只存本机并可供定位', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-project-references-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), target = join(root, 'target'), bindingsFile = join(root, 'project-reference-bindings.json');
  await copyExampleFixture(source); await copyExampleFixture(target);
  const declared = await declareProjectReference(source, { projectRoot: target }, { bindingsFile });
  assert.equal(declared[0].status, 'ready');
  assert.equal(declared[0].workspaceId, 'sample-card-game');
  const shared = JSON.parse(await readFile(join(source, 'game-graph.references.json'), 'utf8'));
  assert.equal(shared.references[0].id, 'sample-card-game');
  assert.equal(shared.references[0].relativePath, '../target');
  assert.equal(JSON.parse(await readFile(bindingsFile, 'utf8')).bindings[0].projectRoot, target);
});

test('绑定错误项目时不覆盖既有本机定位', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-project-references-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), target = join(root, 'target'), wrong = join(root, 'wrong'), bindingsFile = join(root, 'project-reference-bindings.json');
  await copyExampleFixture(source); await copyExampleFixture(target);
  await initProject(wrong, { id: 'wrong-project', name: '错误项目', createProjectRoot: true });
  await declareProjectReference(source, { projectRoot: target }, { bindingsFile });
  await assert.rejects(() => bindProjectReference(source, 'sample-card-game', wrong, { bindingsFile }), { code: 'REFERENCE_WORKSPACE_MISMATCH' });
  assert.equal(JSON.parse(await readFile(bindingsFile, 'utf8')).bindings[0].projectRoot, target);
});

test('本机绑定写入失败时保留已保存的共享声明并显式报告部分完成', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-project-references-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), target = join(root, 'target'), bindingsFile = join(root, 'bindings-directory');
  await copyExampleFixture(source); await copyExampleFixture(target); await mkdir(bindingsFile);
  await assert.rejects(
    () => declareProjectReference(source, { projectRoot: target }, { bindingsFile }),
    error => error.code === 'REFERENCE_DECLARATION_PARTIAL' && error.referenceDeclared === true && error.reference.id === 'sample-card-game',
  );
  const shared = JSON.parse(await readFile(join(source, 'game-graph.references.json'), 'utf8'));
  assert.equal(shared.references[0].id, 'sample-card-game');
});
