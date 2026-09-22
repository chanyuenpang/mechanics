import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/http.mjs';
import { readWorkspace } from '../src/server/workspace.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

async function waitForPublication(origin, token, attempts = 40) {
  for (let index = 0; index < attempts; index++) {
    const workspace = await (await fetch(origin + '/api/workspace?projectSessionToken=' + encodeURIComponent(token))).json();
    if (workspace.exportPublication?.state === 'current' || workspace.exportPublication?.state === 'failed') return workspace;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('后台文档发布未在预期时间内结束');
}

test('文档与导出设置 GET 只消费项目打开快照，不重读 canonical', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'mechanics-session-snapshot-'));
  const projectRoot = join(temp, 'project'); await copyExampleFixture(projectRoot);
  const server = await startServer({ projectRoot, port: 0, projectHistoryPath: join(temp, 'user', 'projects.json') });
  t.after(async () => { await server.close(); await rm(temp, { recursive: true, force: true }); });

  const workspace = await (await fetch(server.origin + '/api/workspace')).json();
  await waitForPublication(server.origin, workspace.projectSessionToken);
  const canonical = await readWorkspace(join(projectRoot, '.mechanics'));
  const removed = canonical.files.find(file => file.kind === 'mechanic');
  await rm(join(projectRoot, '.mechanics', removed.path));

  const settings = await fetch(server.origin + '/api/document-export/settings?projectSessionToken=' + encodeURIComponent(workspace.projectSessionToken));
  assert.equal(settings.status, 200);
  assert.ok((await settings.json()).mechanics.some(mechanic => mechanic.id === removed.id));
  const docs = await fetch(server.origin + '/api/concept-docs?projectSessionToken=' + encodeURIComponent(workspace.projectSessionToken));
  assert.equal(docs.status, 200);
  const index = await docs.json();
  assert.equal(index.document.kind, 'index');
  const selected = await fetch(server.origin + '/api/concept-docs?projectSessionToken=' + encodeURIComponent(workspace.projectSessionToken)
    + '&file=' + encodeURIComponent(index.documents[0].file));
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).document.file, index.documents[0].file);
});
