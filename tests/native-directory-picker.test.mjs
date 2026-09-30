import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('macOS 使用包内固定脚本，中文和特殊字符路径仅由环境变量传入', async t => {
  const path = await mkdtemp(join(tmpdir(), "中文 项目 ' $() &-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const picker = createNativeDirectoryPicker({ platform: 'darwin', run: async (executable, args, options) => {
    assert.equal(executable, '/usr/bin/osascript');
    assert.deepEqual(args.slice(0, 2), ['-l', 'JavaScript']);
    assert.match(args[2], /macos-directory-dialog\.js$/);
    assert.equal(args.some(value => value.includes(path)), false);
    assert.equal(options.env.GAME_GRAPH_PICKER_INITIAL_PATH, path);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.timeout, 600000);
    return { stdout: JSON.stringify({ cancelled: false, path }) };
  } });
  assert.deepEqual(await picker.pick({ initialPath: path }), { cancelled: false, path });
});

test('macOS 无初始路径可选择；无效初始目录在启动前失败', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-mac-initial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'file'); await writeFile(file, '不是目录');
  let calls = 0;
  const picker = createNativeDirectoryPicker({ platform: 'darwin', run: async (_executable, _args, options) => {
    calls++;
    assert.equal(options.env.GAME_GRAPH_PICKER_INITIAL_PATH, '');
    return { stdout: '{"cancelled":true}' };
  } });
  assert.deepEqual(await picker.pick({}), { cancelled: true });
  assert.deepEqual(await picker.pick({ initialPath: '' }), { cancelled: true });
  for (const initialPath of [file, join(root, 'absent')]) {
    await assert.rejects(picker.pick({ initialPath }), error => error.code === 'DIRECTORY_PICKER_FAILED' && /macOS/.test(error.message));
  }
  assert.equal(calls, 2);
});

for (const platform of ['win32', 'darwin']) test(`${platform} 取消不返回路径；无效参数、坏输出与进程失败均明确拒绝`, async () => {
  const cancelled = createNativeDirectoryPicker({ platform, run: async () => ({ stdout: '{"cancelled":true}' }) });
  assert.deepEqual(await cancelled.pick({}), { cancelled: true });
  await assert.rejects(cancelled.pick({ initialPath: '../relative' }), { code: 'DIRECTORY_PICKER_INVALID' });
  await assert.rejects(cancelled.pick({ command: '不要执行' }), { code: 'DIRECTORY_PICKER_INVALID' });
  await assert.rejects(cancelled.pick({ initialPath: '/invalid\0path' }), { code: 'DIRECTORY_PICKER_INVALID' });
  await assert.rejects(createNativeDirectoryPicker({ platform: 'linux' }).pick({}), { code: 'DIRECTORY_PICKER_UNSUPPORTED' });
  for (const stdout of ['garbage', '{}', '{"cancelled":false,"path":"relative"}', '{"cancelled":true,"path":"unexpected"}', JSON.stringify({ cancelled: false, path: '/invalid\0path' })]) {
    const invalid = createNativeDirectoryPicker({ platform, run: async () => ({ stdout }) });
    await assert.rejects(invalid.pick({}), { code: 'DIRECTORY_PICKER_FAILED' });
  }
  const failed = createNativeDirectoryPicker({ platform, run: async () => { throw new Error('模拟启动失败'); } });
  await assert.rejects(failed.pick({}), error => error.code === 'DIRECTORY_PICKER_FAILED' && /模拟启动失败/.test(error.message)
    && error.message.includes(platform === 'darwin' ? 'macOS' : 'Windows'));
});

for (const platform of ['win32', 'darwin']) test(`${platform} 重复请求不再启动弹窗，关闭服务中止选择，失败后可重新选择`, async () => {
  let runs = 0;
  const picker = createNativeDirectoryPicker({ platform, run: async (_executable, _args, options) => {
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

test('请求中止仅终止自己的选择；已中止请求不启动进程', async () => {
  let runs = 0;
  const picker = createNativeDirectoryPicker({ platform: 'darwin', run: async (_executable, _args, options) => {
    runs++;
    if (runs > 1) return { stdout: '{"cancelled":true}' };
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('请求中止')), { once: true }));
  } });
  const first = new AbortController(), second = new AbortController();
  const pending = picker.pick({}, { signal: first.signal });
  second.abort();
  await assert.rejects(picker.pick({}, { signal: second.signal }), { code: 'DIRECTORY_PICKER_BUSY' });
  assert.equal(first.signal.aborted, false);
  first.abort();
  await assert.rejects(pending, { code: 'DIRECTORY_PICKER_FAILED' });
  await assert.rejects(picker.pick({}, { signal: second.signal }), { code: 'DIRECTORY_PICKER_FAILED' });
  assert.equal(runs, 1);
  assert.deepEqual(await picker.pick({}), { cancelled: true });
});

test('HTTP 页面断开会中止该选择请求，随后可重试', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-picker-disconnect-'));
  let started, stopped, calls = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const aborted = new Promise(resolve => { stopped = resolve; });
  const directoryPicker = {
    async pick(_body, { signal }) {
      if (++calls > 1) return { cancelled: true };
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        stopped(); reject(Object.assign(new Error('已断开'), { code: 'DIRECTORY_PICKER_FAILED' }));
      }, { once: true }));
    },
    close() {},
  };
  const server = await startServer({ port: 0, projectHistoryPath: join(root, 'history.json'), directoryPicker });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const request = fetch(server.origin + '/api/directories/pick', { method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Origin: server.origin }, body: '{}' });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await ready; controller.abort(); await rejected; await aborted;
  const retry = await fetch(server.origin + '/api/directories/pick', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: server.origin }, body: '{}' });
  assert.deepEqual(await retry.json(), { cancelled: true });
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
