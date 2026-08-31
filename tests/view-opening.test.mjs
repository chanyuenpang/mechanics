import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceStore } from '../src/server/store.mjs';
import { ViewAutosave, readOpening, prepareOpening, createAndRememberView, viewSaveRequest } from '../src/web/view-files.mjs';

const view = { schemaVersion: 1, kind: 'view', workspaceId: 'sample-card-game', id: 'test-view', name: '测试视图', graphIds: ['hand'], activeLayerId: 'hand', collapsedNodeIds: [], positions: {} };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rule-view-opening-'));
  let store;
  t.after(async () => { if (store) await store.close(); await rm(root, { recursive: true, force: true }); });
  await cp(fileURLToPath(new URL('../examples/card-game/', import.meta.url)), root, { recursive: true });
  store = await createWorkspaceStore(root);
  const api = (path, body) => path === '/api/workspace' ? store.read() : path === '/api/views' ? store.createView(body) : store.save(body);
  return { root, store, api };
}

test('重新打开同一个视图也读取最新规则；失败不会返回部分候选或修改原对象', async t => {
  const { root, api } = await fixture(t);
  const initial = await api('/api/workspace');
  await createAndRememberView(api, initial.revision, view, 'test.view.json');
  const first = await readOpening(api, view.id);
  const hand = first.workspace.analyses.find(g => g.id === 'hand');
  await writeFile(join(root, 'analyses/hand.analysis.json'), JSON.stringify({ ...hand, name: '外部最新规则' }));
  const second = await readOpening(api, view.id);
  assert.equal(second.workspace.analyses.find(g => g.id === 'hand').name, '外部最新规则');
  assert.notEqual(second.workspace.revision, first.workspace.revision);
  const before = structuredClone(second);
  await rm(join(root, 'analyses/hand.analysis.json'));
  await assert.rejects(readOpening(api, view.id), { code: 'MISSING_REFERENCE' });
  assert.deepEqual(second, before);
  assert.throws(() => prepareOpening(first.workspace, 'absent'), /视图文件不存在/);
});

test('不可折叠的候选先失败，不写最近打开记录', async t => {
  const { api } = await fixture(t);
  const data = await api('/api/workspace');
  const bad = { ...data, views: [{ ...view, collapsedNodeIds: ['absent'] }] };
  const before = structuredClone(bad); let writes = 0;
  await assert.rejects(readOpening(async (path) => { if (path === '/api/workspace') return bad; writes++; }, view.id));
  assert.equal(writes, 0); assert.deepEqual(bad, before);
});

test('创建成功但最近打开记录失败：明确报告文件已存在、不重复创建、不删除', async t => {
  const { root, api } = await fixture(t);
  const initial = await api('/api/workspace'); let creates = 0;
  await assert.rejects(createAndRememberView(async (path, body) => {
    if (path === '/api/views') creates++;
    if (path === '/api/save') throw Object.assign(new Error('响应丢失'), { code: 'SAVE_UNCERTAIN' });
    return api(path, body);
  }, initial.revision, view, 'kept.view.json'), error => error.code === 'VIEW_CREATED_UNBOUND' && /kept.view.json/.test(error.message));
  assert.equal(creates, 1);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'kept.view.json'), 'utf8')), view);
  assert.deepEqual((await api('/api/workspace')).manifest.lastView, initial.manifest.lastView);
});

test('最近打开写入响应丢失时拒绝候选，即使服务端已提交', async t => {
  const { api } = await fixture(t);
  const data = await api('/api/workspace');
  await api('/api/views', { revision: data.revision, document: view, file: 'test.view.json' });
  await assert.rejects(readOpening(async (path, body) => {
    const result = await api(path, body);
    if (body) throw Object.assign(new Error('写入结果待确认'), { code: 'SAVE_UNCERTAIN' });
    return result;
  }, view.id), { code: 'SAVE_UNCERTAIN' });
  assert.deepEqual((await api('/api/workspace')).manifest.lastView, { viewId: view.id });
  assert.equal((await readOpening(api)).viewId, view.id);
});

function queue() {
  let tail = Promise.resolve(), revision = 0;
  return operation => {
    const result = tail.then(async () => { const next = await operation(revision); revision = next.revision; });
    tail = result.catch(() => {}); return result;
  };
}
test('连续自动保存捕获各自目标与快照，串行采用自身已确认版本', async () => {
  const sent = [], states = [];
  const autosave = new ViewAutosave(queue(), async body => { sent.push(body); return { revision: body.revision + 1 }; }, state => states.push(state));
  const snapshot = { graphIds: ['hand'], activeLayerId: 'hand', collapsedNodeIds: [], positions: {} };
  const workspace = { views: [view, { ...view, id: 'other' }] };
  const a = autosave.save(viewSaveRequest(workspace, view.id, snapshot));
  snapshot.graphIds.push('basic-rules');
  const b = autosave.save(viewSaveRequest(workspace, 'other', snapshot));
  snapshot.graphIds.length = 0;
  await Promise.all([a, b]);
  assert.deepEqual(sent.map(body => [body.id, body.revision, body.document.graphIds]), [['test-view', 0, ['hand']], ['other', 1, ['hand', 'basic-rules']]]);
  assert.equal(states.at(-1), 'saved');
  assert.equal(states.filter(state => state === 'saved').length, 1);
});

test('首个自动保存失败后，已排队快照也停止；仅显式重读复位可继续', async () => {
  let calls = 0; const states = [];
  const failure = Object.assign(new Error('磁盘版本已改变'), { code: 'REVISION_CONFLICT' });
  const autosave = new ViewAutosave(queue(), async body => {
    calls++; if (calls === 1) throw failure; return { revision: body.revision + 1 };
  }, state => states.push(state));
  const request = { kind: 'view', id: view.id, document: view };
  const result = await Promise.allSettled([autosave.save(request), autosave.save(request)]);
  assert.ok(result.every(item => item.status === 'rejected' && item.reason === failure));
  assert.equal(calls, 1); assert.equal(autosave.blocked, true); assert.equal(states.at(-1), 'failed');
  await assert.rejects(autosave.save(request), failure); assert.equal(calls, 1);
  autosave.reset(); await autosave.save(request); assert.equal(calls, 2);
  autosave.pause(Object.assign(new Error('网络中断'), { code: 'SAVE_UNCERTAIN' }));
  assert.equal(states.at(-1), 'uncertain');
});
