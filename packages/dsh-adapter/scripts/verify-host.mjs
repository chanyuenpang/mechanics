#!/usr/bin/env node
// 重启后的实测验收：只观测，不改状态。
//
//   node scripts/verify-host.mjs [--url http://127.0.0.1:3080] [--home <DSH_HOME>] [--package <包目录>]
//
// 三条 HTTP/组装事实 + 一条会话日志事实：
//   1. /plugins/<包名>/client.js 返回 200，且字节与本地 lib/client.js 完全一致（服务的是我们写的那份）；
//   2. 首页启动清单里出现该 bundle 的 script 地址（客户端半真的进了页面）；
//   3. bundle 路由 404 时明确报告「宿主尚未重启」，而不是含糊地失败；
//   4. 会话日志里能找到工具调用，且对应的 tool/result 事件带 meta（图卡载荷进了持久日志）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf('--' + name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const url = option('url', 'http://127.0.0.1:3080').replace(/\/+$/, '');
const home = resolve(option('home', join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')));
const packageDir = resolve(option('package', join(import.meta.dirname, '..')));
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const packageName = manifest.name;

const passed = [];
const failed = [];
const note = (ok, label) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  (ok ? passed : failed).push(label);
};

const sha256 = value => createHash('sha256').update(value).digest('hex');

// ---- 1 + 3：bundle 路由 ----
const bundlePath = join(packageDir, manifest.exports['./client']);
const route = url + '/plugins/' + packageName + '/client.js';
let served = undefined;
try {
  const response = await fetch(route);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  served = Buffer.from(await response.arrayBuffer());
} catch (error) {
  console.log('FAIL ' + route + ' → ' + error.message);
  failed.push('bundle 路由');
  console.log('\n结论：宿主尚未重启或该包未进入本次组装——插件在启动时组装，重启 dsh web 后再跑本脚本。');
  process.exitCode = 1;
}
if (served !== undefined) {
  note(true, 'bundle 路由返回 200：' + route);
  const local = readFileSync(bundlePath);
  note(sha256(served) === sha256(local), '服务端 bundle 与本地 lib/client.js 字节一致（' + served.length + ' 字节）');
}

// ---- 1b：插件自持的只读路由（Code Mode 下卡片就是靠它取数据的） ----
if (served !== undefined) {
  try {
    // 未知子路径必须回我的 JSON 404；fallback handler 的 404 没有 content-type，据此区分"路由没注册"。
    const marker = await fetch(url + '/mechanics');
    const contentType = marker.headers.get('content-type') ?? '';
    const body = await marker.json().catch(() => undefined);
    note(marker.status === 404 && contentType.startsWith('application/json') && body?.error === 'NOT_FOUND',
      '插件自持路由已注册（/mechanics 回 JSON 404：' + marker.status + ' ' + (body?.error ?? '无 JSON') + '）');
  } catch (error) {
    note(false, '插件自持路由不可达：' + error.message);
  }
  const project = option('project', undefined);
  if (project !== undefined) {
    try {
      const ids = option('ids', undefined);
      const query = '/mechanics/graph?project=' + encodeURIComponent(project) + (ids === undefined ? '' : '&ids=' + encodeURIComponent(ids));
      const projection = await fetch(url + query);
      const value = await projection.json().catch(() => undefined);
      note(projection.status === 200 && Array.isArray(value?.nodes) && value.nodes.length > 0,
        '路由返回投影：' + projection.status + ' ' + (value?.conceptIds ?? []).length + ' 个概念 / ' + (value?.edges ?? []).length + ' 条集合内关系');
    } catch (error) {
      note(false, '路由投影读取失败：' + error.message);
    }
  }
}

// ---- 2：首页启动清单 ----
if (served !== undefined) {
  try {
    const html = await (await fetch(url + '/')).text();
    note(html.includes('/plugins/' + packageName + '/client.js'), '首页启动清单包含该 bundle 的地址');
  } catch (error) {
    note(false, '首页读取失败：' + error.message);
  }
}

// ---- 4：会话日志里的工具调用与卡片载荷 ----
// 会话日志是多帧 zstd（首帧 header + 追加帧），而 Node 公开的 zstdDecompressSync 只解码首帧；
// 因此按标准帧魔数切帧后逐帧解码——只用公开 API，不碰私有 stream handle。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decodeSessionLog(buffer, zstd) {
  const offsets = [];
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, index, index + 4) === 0) offsets.push(index);
  }
  if (offsets.length === 0) return zstd(buffer).toString('utf8');
  let text = '';
  for (let index = 0; index < offsets.length; index++) {
    const frame = buffer.subarray(offsets[index], offsets[index + 1] ?? buffer.length);
    try {
      text += zstd(frame).toString('utf8');
    } catch {
      // 单帧损坏不影响其余帧：逐帧解码的意义就在这里。
    }
  }
  return text;
}

if (served !== undefined) {
  const zstd = await import('node:zlib').then(module => module.zstdDecompressSync).catch(() => undefined);
  if (typeof zstd !== 'function') {
    console.log('SKIP 会话日志检查：当前 Node 没有 zstd 解压（需要 Node 24+）');
  } else {
    const sessionsRoot = join(home, 'sessions');
    const candidates = [];
    if (existsSync(sessionsRoot)) {
      for (const workspace of readdirSync(sessionsRoot)) {
        const workspaceDir = join(sessionsRoot, workspace);
        if (!statSync(workspaceDir).isDirectory()) continue;
        for (const session of readdirSync(workspaceDir)) {
          const file = join(workspaceDir, session, 'session.jsonl.zstd');
          if (existsSync(file)) candidates.push({ file, mtime: statSync(file).mtimeMs });
        }
      }
    }
    candidates.sort((left, right) => right.mtime - left.mtime);
    const calls = new Map();          // callId/subCallId → 工具名（原生与 Code Mode 两种承载）
    const modes = new Set();
    let nativeWithMeta = 0;
    let nativeWithoutMeta = 0;
    let codeDispatches = 0;
    for (const candidate of candidates.slice(0, 6)) {
      let text;
      try {
        text = decodeSessionLog(readFileSync(candidate.file), zstd);
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('mechanics_')) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const name = String(event.data?.name ?? '');
        if (event.type === 'tool/call' && name.startsWith('mechanics_')) {
          calls.set(String(event.data.callId), name);
          modes.add('native');
        }
        if (event.type === 'tool/code-dispatch-start' && name.startsWith('mechanics_')) {
          calls.set(String(event.data.subCallId), name);
          modes.add('code');
        }
        if (event.type === 'tool/code-dispatch' && name.startsWith('mechanics_')) codeDispatches += 1;
        if (event.type === 'tool/result') {
          const callId = String(event.data?.message?.source?.callId ?? '');
          if (!calls.has(callId)) continue;
          if (event.data?.meta === undefined) nativeWithoutMeta += 1;
          else nativeWithMeta += 1;
        }
      }
    }
    note(calls.size > 0, '会话日志里有 mechanics_* 工具调用（' + calls.size + ' 次：' + [...new Set(calls.values())].join(', ') + '；承载方式 ' + ([...modes].join('+') || '未知') + '）');
    if (calls.size === 0) {
      console.log('提示：先在会话里调用一次 mechanics_graph，再看这里。');
    } else if (modes.has('native')) {
      note(nativeWithMeta > 0 && nativeWithoutMeta === 0, '原生顶层调用的 tool/result 全部带卡片 meta（带 ' + nativeWithMeta + ' 条 / 缺 ' + nativeWithoutMeta + ' 条）');
    } else {
      // Code Mode 是契约内的差异，不是安装失败：子调用按定义不产出 presentationMeta。
      console.log('NOTE 本次调用全部来自 Code Mode 子调用（' + codeDispatches + ' 条 tool/code-dispatch）：按契约 presentationMeta 只对顶层调用计算，'
        + '因此这些事件本身不带 meta。卡片不依赖它：拿得到会话 cwd 与稳定 ID 时直接挂插件自持路由上的真 widget'
        + '（/mechanics/widget，与网页、Codex MCP 同一份页面），只有拿不到 cwd 或调用参数时才退回自绘 SVG 或如实说明。');
    }
  }
}

console.log('\n==== ' + (failed.length === 0 ? '验收通过：' + passed.length + ' 条证据' : failed.length + ' 项失败') + ' ====');
for (const item of failed) console.log(' - ' + item);
process.exitCode = failed.length === 0 ? 0 : 1;
