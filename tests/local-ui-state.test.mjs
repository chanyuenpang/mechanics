import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/http.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

async function post(origin, path, body) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { response, data: await response.json() };
}

test('最近打开资源在项目工作区内持久化，并由嵌套 gitignore 忽略', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-local-ui-state-'));
  const projectRoot = join(temp, 'project'); await copyExampleFixture(projectRoot);
  const historyPath = join(temp, 'user', 'projects.json');
  const first = await startServer({ projectRoot, port: 0, projectHistoryPath: historyPath });
  t.after(async () => { await first.close().catch(() => {}); await rm(temp, { recursive: true, force: true }); });

  const workspace = await (await fetch(first.origin + '/api/workspace')).json();
  const originalRevision = workspace.revision;
  const saved = await post(first.origin, '/api/local-ui-state', {
    projectSessionToken: workspace.projectSessionToken, projectGeneration: workspace.projectGeneration,
    recentViews: ['view-recent'], recentMechanics: [workspace.mechanics[0].id],
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.recentViews, ['view-recent']);
  assert.deepEqual(saved.data.recentMechanics, [workspace.mechanics[0].id]);
  assert.equal((await (await fetch(first.origin + '/api/workspace')).json()).revision, originalRevision);
  assert.match(await readFile(join(projectRoot, '.game-graph/.gitignore'), 'utf8'), /^\.ui-state\.json$/m);
  await first.close();

  const second = await startServer({ projectRoot, port: 0, projectHistoryPath: historyPath });
  t.after(async () => { await second.close().catch(() => {}); });
  const restored = await (await fetch(second.origin + '/api/local-ui-state')).json();
  assert.deepEqual(restored.recentViews, ['view-recent']);
  assert.deepEqual(restored.recentMechanics, [workspace.mechanics[0].id]);
});
