import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { startServer } from '../src/server/http.mjs';
import { copyExampleFixture } from './example-fixture.mjs';

const post = async (origin, path, body) => {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
};

for (const initialize of [false, true]) test(`${initialize ? '新建' : '既有'}项目的慢同步不阻断打开、静态页面、读取与保存，重复打开合并同步`, { timeout: 20000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'mechanics-background-assets-')), projectRoot = join(temp, 'project');
  if (initialize) {
    await mkdir(projectRoot);
    // 网页初始化的受管资产预检也必须延后；CLI init 仍保留原有显式门禁。
    await writeFile(join(projectRoot, '.agents'), '模拟受管资产路径冲突');
  } else await copyExampleFixture(projectRoot);
  let release, calls = 0, finished = false;
  const gate = new Promise(resolve => { release = resolve; });
  const server = await startServer({ port: 0, projectHistoryPath: join(temp, 'user/projects.json'),
    syncProjectAssets: async root => { calls++; assert.equal(root, projectRoot); await gate; finished = true; return {}; } });
  t.after(async () => { release(); await server.close(); await rm(temp, { recursive: true, force: true }); });
  const opened = await post(server.origin, '/api/project/open', { projectRoot });
  assert.equal(opened.projectAssetSync.state, 'pending');
  const token = opened.projectSessionToken;
  assert.equal((await fetch(server.url, { signal: AbortSignal.timeout(5000) })).status, 200);
  const reread = await (await fetch(server.origin + '/api/workspace', { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(reread.projectSessionToken, token);
  const saved = await post(server.origin, '/api/save', { projectSessionToken: token, projectGeneration: opened.projectGeneration,
    revision: opened.revision, kind: 'workspace', document: { ...opened.manifest, name: '同步未完成时仍可保存' } });
  assert.equal(saved.manifest.name, '同步未完成时仍可保存');
  assert.equal(JSON.parse(await readFile(join(projectRoot, '.mechanics/workspace.json'), 'utf8')).name, saved.manifest.name);
  const repeated = await Promise.all([post(server.origin, '/api/project/open', { projectRoot }), post(server.origin, '/api/project/open', { projectRoot })]);
  assert.ok(repeated.every(item => item.projectSessionToken === token && item.projectAssetSync.state === 'pending'));
  assert.equal(calls, 1);
  assert.equal(finished, false);
  release();
  let status;
  for (let index = 0; index < 100; index++) {
    status = await (await fetch(server.origin + '/api/project/assets?projectSessionToken=' + encodeURIComponent(token))).json();
    if (status.projectAssetSync.state !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status.projectAssetSync.state, 'current');
});

test('页面后台状态轮询按项目合并，失败显示非弹窗提示，恢复后清除提示', async () => {
  const source = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const assetSyncFailures ='), end = source.indexOf('async function api(', start);
  assert.ok(start >= 0 && end > start);
  const timers = [], banner = { hidden: true, textContent: '' }, responses = new Map();
  let observe;
  const calls = [];
  observe = runInNewContext(source.slice(start, end) + '\nobserveAssetSync;', {
    $: id => { assert.equal(id, 'project-assets-status'); return banner; },
    setTimeout: callback => timers.push(callback),
    api: async path => {
      calls.push(path);
      const token = new URL('http://localhost' + path).searchParams.get('projectSessionToken');
      const result = responses.get(token);
      if (result instanceof Error) throw result;
      observe(result); return result;
    },
  });
  const snapshot = (token, state, extra = {}) => ({ projectSessionToken: token,
    projectAssetSync: { state, projectRoot: token + '-project', ...extra } });
  observe(snapshot('first', 'pending')); observe(snapshot('first', 'pending'));
  observe(snapshot('second', 'pending'));
  assert.equal(timers.length, 2);
  assert.equal(banner.hidden, true);
  responses.set('first', snapshot('first', 'failed', { code: 'EACCES', message: '没有写入权限' }));
  responses.set('second', snapshot('second', 'current'));
  await timers.shift()(); await timers.shift()();
  assert.equal(timers.length, 0);
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /first-project.*EACCES.*没有写入权限/);
  assert.ok(calls.every(path => path.startsWith('/api/project/assets?')));
  observe(snapshot('first', 'pending'));
  responses.set('first', snapshot('first', 'current'));
  await timers.shift()();
  assert.equal(banner.hidden, true);
  observe(snapshot('second', 'pending'));
  responses.set('second', new Error('连接中断'));
  await timers.shift()();
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /无法确认.*second-project.*连接中断/);
});
