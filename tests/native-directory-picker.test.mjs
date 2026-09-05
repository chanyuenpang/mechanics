import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeDirectoryPicker } from '../src/server/native-directory-picker.mjs';
import { startServer } from '../src/server/http.mjs';

test('Windows 实际编译现代选择器，COM 路径错误直接暴露且不弹窗', { skip: process.platform !== 'win32' }, async () => {
  const picker = createNativeDirectoryPicker();
  await assert.rejects(picker.pick({ initialPath: join(tmpdir(), 'game-graph-absent-' + crypto.randomUUID()) }),
    error => error.code === 'DIRECTORY_PICKER_FAILED' && !error.message.includes('error CS'));
});

test('原生选择器使用固定脚本、STA 和独立路径变量，保留中文空格与特殊字符', async () => {
  const path = join(tmpdir(), "中文 项目 ' $() &");
  const picker = createNativeDirectoryPicker({ platform: 'win32', run: async (executable, args, options) => {
    assert.equal(executable, 'powershell.exe');
    assert.ok(args.includes('-STA'));
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.GAME_GRAPH_PICKER_INITIAL_PATH, path);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /GameGraphDirectoryDialog/);
    assert.match(options.env.GAME_GRAPH_PICKER_HELPER, /windows-directory-dialog\.cs$/);
    assert.equal(script.includes(path), false);
    return { stdout: JSON.stringify({ cancelled: false, path }) };
  } });
  assert.deepEqual(await picker.pick({ initialPath: path }), { cancelled: false, path });
});

test('取消不返回路径；不支持的平台、无效参数、坏输出与进程失败均明确拒绝', async () => {
  const cancelled = createNativeDirectoryPicker({ platform: 'win32', run: async () => ({ stdout: '{"cancelled":true}' }) });
  assert.deepEqual(await cancelled.pick({}), { cancelled: true });
  await assert.rejects(cancelled.pick({ initialPath: '../relative' }), { code: 'DIRECTORY_PICKER_INVALID' });
  await assert.rejects(cancelled.pick({ command: '不要执行' }), { code: 'DIRECTORY_PICKER_INVALID' });
  await assert.rejects(createNativeDirectoryPicker({ platform: 'linux' }).pick({}), { code: 'DIRECTORY_PICKER_UNSUPPORTED' });
  for (const stdout of ['garbage', '{}', '{"cancelled":false,"path":"relative"}', '{"cancelled":true,"path":"unexpected"}']) {
    const invalid = createNativeDirectoryPicker({ platform: 'win32', run: async () => ({ stdout }) });
    await assert.rejects(invalid.pick({}), { code: 'DIRECTORY_PICKER_FAILED' });
  }
  const failed = createNativeDirectoryPicker({ platform: 'win32', run: async () => { throw new Error('模拟启动失败'); } });
  await assert.rejects(failed.pick({}), error => error.code === 'DIRECTORY_PICKER_FAILED' && /模拟启动失败/.test(error.message));
});

test('重复请求不再启动弹窗，关闭服务中止选择，失败后可重新选择', async () => {
  let runs = 0;
  const picker = createNativeDirectoryPicker({ platform: 'win32', run: async (_executable, _args, options) => {
    runs++;
    if (runs > 1) return { stdout: '{"cancelled":true}' };
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('已中止')), { once: true }));
  } });
  const pending = picker.pick({});
  await assert.rejects(picker.pick({}), { code: 'DIRECTORY_PICKER_BUSY' });
  assert.equal(runs, 1);
  picker.close();
  await assert.rejects(pending, { code: 'DIRECTORY_PICKER_FAILED' });
  assert.deepEqual(await picker.pick({}), { cancelled: true });
});

test('原生选择 HTTP 接口只允许同源 JSON 请求，选择或取消都不打开项目', async t => {
  const root = await mkdtemp(join(tmpdir(), 'game-graph-native-picker-'));
  let calls = 0, closed = false, fail = false;
  const directoryPicker = {
    async pick() {
      calls++;
      if (fail) throw Object.assign(new Error('模拟选择器失败'), { code: 'DIRECTORY_PICKER_FAILED' });
      return calls === 1 ? { cancelled: false, path: root } : { cancelled: true };
    },
    close() { closed = true; },
  };
  const server = await startServer({ port: 0, projectHistoryPath: join(root, 'history.json'), directoryPicker });
  t.after(async () => { await server.close(); assert.equal(closed, true); await rm(root, { recursive: true, force: true }); });
  const pick = headers => fetch(server.origin + '/api/directories/pick', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await pick({ Origin: 'https://other.example' })).status, 403);
  assert.equal((await pick({})).status, 403);
  assert.equal((await pick({ Origin: server.origin, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(calls, 0);
  assert.deepEqual(await (await pick({ Origin: server.origin })).json(), { cancelled: false, path: root });
  assert.deepEqual(await (await pick({ Origin: server.origin })).json(), { cancelled: true });
  assert.deepEqual(await (await fetch(server.origin + '/api/project')).json(), { status: 'empty', projectGeneration: 0 });
  fail = true;
  const failure = await pick({ Origin: server.origin });
  assert.equal(failure.status, 422);
  assert.equal((await failure.json()).error, 'DIRECTORY_PICKER_FAILED');
});
