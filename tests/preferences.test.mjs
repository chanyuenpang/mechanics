import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server/http.mjs';

test('工具偏好跨工作区和服务共享，鉴权受限，坏文件不被覆盖，工作区字节不变', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rule-preferences-')), path = join(root, 'user', 'preferences.json');
  const servers = [];
  t.after(async () => { for (const server of servers) await server.close(); await rm(root, { recursive: true, force: true }); });
  for (const name of ['a', 'b']) {
    const workspaceRoot = join(root, name); await cp(new URL('../examples/card-game/', import.meta.url), workspaceRoot, { recursive: true });
    servers.push(await startServer({ workspaceRoot, port: 0, preferencesPath: path }));
  }
  const [a, b] = servers;
  const headers = server => ({ Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' });
  const get = server => fetch(server.origin + '/api/preferences', { headers: headers(server) });
  const put = (server, body) => fetch(server.origin + '/api/preferences', { method: 'POST', headers: headers(server), body: JSON.stringify(body) });
  const before = await readFile(join(root, 'a', 'workspace.json'), 'utf8');
  assert.equal((await fetch(a.origin + '/api/preferences')).status, 401);
  assert.equal((await (await get(a)).json()).snapToGrid, false);
  assert.equal((await put(a, { version: 1, snapToGrid: true, path: '/bad' })).status, 422);
  assert.equal((await put(a, { version: 1, snapToGrid: true })).status, 200);
  assert.equal((await (await get(b)).json()).snapToGrid, true);
  assert.equal(await readFile(join(root, 'a', 'workspace.json'), 'utf8'), before);
  await writeFile(path, '{bad');
  assert.equal((await get(b)).status, 422);
  assert.equal((await put(b, { version: 1, snapToGrid: false })).status, 422);
  assert.equal(await readFile(path, 'utf8'), '{bad');
});
