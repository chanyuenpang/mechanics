#!/usr/bin/env node
// 重启后的实测验收：只观测，不改状态。
//
//   node scripts/verify-host.mjs [--url http://127.0.0.1:3080] [--token <网页登录令牌>] [--project <项目目录> --ids <ID,ID>]
//
// 从认证首页读取真实组合脚本 URL，验证脚本、插件路由、可选图页面和会话日志。
// 脚本不得输出登录令牌；组合脚本不与独立客户端文件逐字节相等。
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

// ---- 前端组合批次：当前 DSH 只服务启动图声明的精确 URL ----
const token = option('token', undefined);
let served = undefined;
let html = undefined;
try {
  let headers = {};
  if (token !== undefined) {
    const login = await fetch(url + '/?token=' + encodeURIComponent(token), { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (login.status !== 303 || !cookie) throw new Error('登录令牌未获宿主确认：HTTP ' + login.status);
    headers = { cookie };
  }
  const response = await fetch(url + '/', { headers });
  if (!response.ok) throw new Error('HTTP ' + response.status + '（若启用认证，请传 --token）');
  html = await response.text();
  note(true, '认证后首页可读取启动图');
} catch (error) {
  note(false, '首页启动图不可读：' + error.message);
}
if (html !== undefined) {
  const hrefs = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
  const batch = hrefs.find(href => href.startsWith('/plugins/??') && href.includes(packageName + '/client.js'));
  note(batch !== undefined, '启动图的组合脚本包含 ' + packageName);
  if (batch !== undefined) {
    try {
      const response = await fetch(new URL(batch, url));
      if (!response.ok) throw new Error('HTTP ' + response.status);
      served = await response.text();
      note(served.includes('mechanics-widget') && served.includes('mechanics_graph'), '组合脚本返回 200 且包含 Mechanics 图卡模块');
    } catch (error) {
      note(false, '启动图中的组合脚本不可读：' + error.message);
    }
  }
}

// ---- 插件自持的只读路由（图卡取数据的独立入口） ----
if (served !== undefined) {
  try {
    const marker = await fetch(url + '/mechanics');
    const body = await marker.json().catch(() => undefined);
    note(marker.status === 404 && marker.headers.get('content-type')?.startsWith('application/json') && body?.error === 'NOT_FOUND',
      '插件自持路由已注册（/mechanics 返回 JSON NOT_FOUND）');
  } catch (error) {
    note(false, '插件自持路由不可达：' + error.message);
  }
  const project = option('project', undefined), ids = option('ids', undefined);
  if (project !== undefined && ids !== undefined) {
    try {
      const response = await fetch(url + '/mechanics/widget?project=' + encodeURIComponent(project) + '&ids=' + encodeURIComponent(ids));
      const page = await response.text();
      note(response.status === 200 && page.includes('__MECHANICS_CONCEPTS_PAYLOAD__'), '实际图页面返回 200 且包含概念图载荷');
    } catch (error) {
      note(false, '图页面读取失败：' + error.message);
    }
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
        if (!line.includes('tool/')) continue;
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
        if (event.type === 'tool/ptc-dispatch-start' && name.startsWith('mechanics_')) {
          calls.set(String(event.data.subCallId), name);
          modes.add('code');
        }
        if (event.type === 'tool/ptc-dispatch' && name.startsWith('mechanics_')) codeDispatches += 1;
        if (event.type === 'tool/result') {
          const callId = String(event.data?.message?.source?.callId ?? '');
          if (!calls.has(callId)) continue;
          if (event.data?.meta === undefined) nativeWithoutMeta += 1;
          else nativeWithMeta += 1;
        }
      }
    }
    if (calls.size === 0) {
      console.log('SKIP 最近会话日志中没有 mechanics_* 调用；要验收对话内图卡，请在目标会话调用 mechanics_graph 后再检查。');
    } else {
      note(true, '会话日志里有 mechanics_* 工具调用（' + calls.size + ' 次：' + [...new Set(calls.values())].join(', ') + '；承载方式 ' + [...modes].join('+') + '）');
    }
    if (calls.size === 0) {
      // 没有调用记录不能证明或否定客户端对话图卡是否成功。
    } else if (modes.has('native')) {
      note(nativeWithMeta > 0 && nativeWithoutMeta === 0, '原生顶层调用的 tool/result 全部带卡片 meta（带 ' + nativeWithMeta + ' 条 / 缺 ' + nativeWithoutMeta + ' 条）');
    } else {
      // PTC 子派发不带顶层卡片 meta；对话图卡由客户端监听成功结算事件并用 cwd 挂载。
      note(codeDispatches > 0, 'PTC 子派发有完成事件（' + codeDispatches + ' 条 tool/ptc-dispatch）；对话图卡仍须在网页实测');
    }
  }
}

console.log('\n==== ' + (failed.length === 0 ? '验收通过：' + passed.length + ' 条证据' : failed.length + ' 项失败') + ' ====');
for (const item of failed) console.log(' - ' + item);
process.exitCode = failed.length === 0 ? 0 : 1;
