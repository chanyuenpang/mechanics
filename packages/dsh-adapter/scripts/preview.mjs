#!/usr/bin/env node
// 不需要重启宿主就能看卡：把 lib/client.js 装进一个最小页面，用真实的浏览器渲染两张卡。
//
//   node scripts/preview.mjs [--out <目录>] [--screenshot <png>]
//
// 页面里只替身两样东西：`window.__ModuleLoader__`（lazy-CJS 注册面）与一个把元素树直接建成
// DOM 的最小 React（createElement / useState）。卡自身的代码、布局数学、SVG 结构、主题变量
// 都是真的，因此截图里的观感与对话流里的卡一致；差异只在没有宿主外壳（无字体继承、无悬停提示气泡）。
//
// widget 卡是 iframe：本脚本用自己进程起一个 /mechanics/widget 服务提供真 widget。
// 注意 headless 截图里 widget 区可能是空白——替身每次渲染重建整棵树，iframe 会被反复重挂；
// 真 React 会复用同一个 DOM 节点，所以宿主里不会这样。要看 widget 本身，直接截图它的 URL 更准。
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildWidgetPayload, loadWidgetSupport, renderWidgetErrorHtml, renderWidgetHtml } from '../src/widget.mjs';

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf('--' + name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const packageDir = resolve(option('package', join(import.meta.dirname, '..')));
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const bundle = readFileSync(join(packageDir, manifest.exports['./client']), 'utf8');
const previewProject = option('project', 'G:/Projects/tiny-world');
// widget 卡用的是真实项目里的稳定 ID（示例夹具的 id 在这个项目里不存在，那会渲染出错误页）。
const previewIds = option('ids', 'turn,draw,hand,deck,player-health,defeat');
const outDir = resolve(option('out', join(packageDir, 'preview')));

// 预览进程自己提供真 widget：与宿主里同一条路径、同一份模板与布局，卡片照常 iframe 挂它。
// （截图必须异步执行，否则事件循环被 execFileSync 挡住，浏览器取不到这个页面。）
const widgetSupport = await loadWidgetSupport();
const widgetServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/mechanics/widget') {
    res.writeHead(404);
    res.end();
    return;
  }
  const project = url.searchParams.get('project') ?? '';
  const ids = (url.searchParams.get('ids') ?? '').split(',').map(item => item.trim()).filter(Boolean);
  try {
    const payload = await buildWidgetPayload(project, ids);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderWidgetHtml(widgetSupport, payload));
  } catch (error) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderWidgetErrorHtml(typeof error?.code === 'string' ? error.code : 'WIDGET_FAILED', error instanceof Error ? error.message : String(error)));
  }
});
widgetServer.listen(0, '127.0.0.1');
await once(widgetServer, 'listening');
const routeBase = 'http://127.0.0.1:' + widgetServer.address().port;
mkdirSync(outDir, { recursive: true });
const pagePath = join(outDir, 'cards.html');

// 与示例工作区同形的一份载荷：概念、集合内声明关系、以及检索的模糊候选。
const samples = {
  graph: {
    revision: 'a'.repeat(64),
    conceptIds: ['melee', 'damage', 'health', 'failure', 'repel', 'evade'],
    nodes: [
      { id: 'melee', label: '近战', description: '敌人可以产出的共享近战攻击概念。' },
      { id: 'damage', label: '敌人造成伤害', description: '该敌人对我方造成的伤害。' },
      { id: 'health', label: '我方血量', description: '我方当前剩余血量。' },
      { id: 'failure', label: '游戏失败', description: '我方本次战斗失败。' },
      { id: 'repel', label: '攻击受阻', description: '抑制近战攻击的抽象机制。' },
      { id: 'evade', label: '闪避行动', description: '防御牌提供的抽象闪避机制，不表示当前已经执行。' },
    ],
    edges: [
      { id: 'melee-2-damage', source: 'melee', target: 'damage', relation: 'influence', sign: 1, ruleText: '攻击命中' },
      { id: 'damage-2-health', source: 'damage', target: 'health', relation: 'influence', sign: -1, ruleText: '伤害未被其他机制吸收', targetQualifiers: ['控制角色'] },
      { id: 'health-2-failure', source: 'health', target: 'failure', relation: 'influence', sign: -1, ruleText: '只考虑血量归零的失败方式' },
      { id: 'repel-2-melee', source: 'repel', target: 'melee', relation: 'influence', sign: -1, ruleText: '该次近战受到该状态影响' },
      { id: 'evade-2-repel', source: 'evade', target: 'repel', relation: 'influence', sign: 1, ruleText: '防御牌在手中、体力足够且行动窗口开放' },
    ],
  },
  search: {
    revision: 'a'.repeat(64),
    resolution: {
      status: 'fuzzy',
      key: '近战',
      candidates: [
        { id: 'melee', label: '近战', matchedBy: ['label-prefix'], score: 100 },
        { id: 'enemy', label: '近战敌人', matchedBy: ['label-contains'], score: 80 },
        { id: 'repel', label: '攻击受阻', matchedBy: ['description-contains'], score: 40 },
      ],
      total: 3,
      truncated: false,
    },
  },
};

const page = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>Mechanics 卡片预览</title>',
  '<style>',
  ':root { --dsw-alias-bg-base: #ffffff; --dsw-alias-bg-elevated: rgba(15,23,42,.06); --dsw-alias-border-l1: rgba(15,23,42,.16); --dsw-alias-border-l2: rgba(15,23,42,.10);',
  '  --dsw-alias-label-primary: #0f172a; --dsw-alias-label-secondary: #475569; --dsw-alias-label-tertiary: #94a3b8;',
  '  --dsw-alias-markdown-code-block: rgba(15,23,42,.08); --dsw-alias-state-success-primary: #16a34a; --dsw-alias-state-error-primary: #dc2626; }',
  'body { margin: 0; padding: 16px; background: #f8fafc; font: 14px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }',
  'h2 { font-size: 13px; color: #64748b; font-weight: 500; margin: 18px 0 6px; }',
  '#root { max-width: 620px; }',
  '</style></head><body><div id="root"></div>',
  '<script>',
  '// 预览页自己的报错要看得见，否则失败只剩一张白图。',
  'window.addEventListener("error", event => {',
  '  document.title = "ERROR " + event.message + " @" + event.lineno + ":" + event.colno;',
  '  const pre = document.createElement("pre");',
  '  pre.id = "preview-error";',
  '  pre.style.cssText = "color:#b91c1c;white-space:pre-wrap";',
  '  pre.textContent = "ERROR: " + event.message + " @line " + event.lineno + ":" + event.colno;',
  '  document.body.appendChild(pre);',
  '});',
  '// ---- lazy-CJS 注册面替身 ----',
  'let registration;',
  'window.__ModuleLoader__ = { load: value => { registration = value; } };',
  '</script>',
  '<script>' + bundle + '</scr' + 'ipt>',
  '<script>',
  '// ---- 最小 React：把元素树直接建成 DOM（svg 名字段走 SVG 命名空间） ----',
  'const SVG_TAGS = new Set(["svg","g","circle","text","line","polygon","path","defs","marker","title"]);',
  'const kebab = key => key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());',
  'const slots = { values: [], cursor: 0 };',
  'const iframeCache = new Map();',
  'let rerender = () => {};',
  'const React = {',
  '  createElement(type, props, ...children) {',
  '    if (typeof type === "function") return type(Object.assign({}, props, { children }));',
  '    // iframe 按 src 复用：真 React 会保留同一个 DOM 节点，替身重建整棵树会把 widget 反复重载（永远画不出来）。',
  '    if (type === "iframe" && props && typeof props.src === "string") {',
  '      const cached = iframeCache.get(props.src);',
  '      if (cached) { for (const [name, raw] of Object.entries(props.style || {})) cached.style.setProperty(kebab(name), String(raw)); return cached; }',
  '      const created = document.createElement("iframe");',
  '      created.setAttribute("src", props.src);',
  '      created.setAttribute("title", props.title || "");',
  '      for (const [name, raw] of Object.entries(props.style || {})) created.style.setProperty(kebab(name), String(raw));',
  '      iframeCache.set(props.src, created);',
  '      return created;',
  '    }',
  '    const element = SVG_TAGS.has(type) ? document.createElementNS("http://www.w3.org/2000/svg", type) : document.createElement(type);',
  '    for (const [key, value] of Object.entries(props || {})) {',
  '      if (value === null || value === undefined) continue;',
  '      if (key === "style") { for (const [name, raw] of Object.entries(value)) element.style.setProperty(kebab(name), String(raw)); continue; }',
  '      if (key === "onClick") { element.addEventListener("click", value); continue; }',
  '      if (key === "children") continue;',
  '      element.setAttribute(key, String(value));',
  '    }',
  '    for (const child of children.flat(Infinity)) {',
  '      if (child === null || child === undefined || child === false) continue;',
  '      element.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));',
  '    }',
  '    return element;',
  '  },',
  '  useState(initial) {',
  '    const index = slots.cursor++;',
  '    if (!(index in slots.values)) slots.values[index] = initial;',
  '    return [slots.values[index], value => { slots.values[index] = typeof value === "function" ? value(slots.values[index]) : value; rerender(); }];',
  '  },',
  '  // 只实现预览需要的部分：按依赖数组决定是否重跑，跑完即清空，不模拟清理时机。',
  '  useEffect(callback, deps) {',
  '    const index = effects.cursor++;',
  '    const previous = effects.deps[index];',
  '    const changed = previous === undefined || !Array.isArray(deps) || deps.length !== previous.length || deps.some((value, at) => value !== previous[at]);',
  '    effects.deps[index] = deps;',
  '    if (changed) effects.pending.push(callback);',
  '  },',
  '};',
  'const effects = { cursor: 0, deps: [], pending: [] };',
  '// 预览用的只读路由打桩：真实宿主里这就是插件自持的 /mechanics 路由。',
  'window.__MECHANICS_ROUTE_BASE__ = ' + JSON.stringify(routeBase) + ';',
  'window.fetch = url => {',
  '  if (String(url).includes("elsewhere")) {',
  '    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "WORKSPACE_NOT_FOUND", message: "目录 G:/Projects/elsewhere 没有 .mechanics/workspace.json" }) });',
  '  }',
  '  return Promise.resolve({ ok: true, status: 200, json: async () => samples.graph });',
  '};',
  'const api = registration.factory(name => { if (name === "react") return React; throw new Error("未声明的模块 " + name); });',
  'const samples = ' + JSON.stringify(samples) + ';',
  'const blocks = {',
  '  graphReady: { kind: "tool-result", callId: "c1", meta: samples.graph },',
  '  graphRunning: { callId: "c2", name: "mechanics_graph", argsRaw: JSON.stringify({ conceptIds: ["melee"] }) },',
  '  searchReady: { kind: "tool-result", callId: "c3", meta: samples.search },',
  '  settledNoPayload: { kind: "tool-result", callId: "c5" },',
  '  settledWithArgs: { kind: "tool-result", callId: "c6", call: { name: "mechanics_graph", argsRaw: JSON.stringify({ conceptIds: ' + JSON.stringify(previewIds.split(',').map(item => item.trim())) + ' }) } },',
  '};',
  'let clicked = false;',
  'function render() {',
  '  slots.cursor = 0;',
  '  effects.cursor = 0;',
  '  effects.pending = [];',
  '  const root = document.getElementById("root");',
  '  root.replaceChildren();',
  '  const add = (title, node) => { const head = document.createElement("h2"); head.textContent = title; root.append(head, node); };',
  '  add("mechanics_graph（点击节点前）", api.GraphCard({ block: blocks.graphReady }));',
  '  const expanded = api.GraphCard({ block: blocks.graphReady });',
  '  add("mechanics_graph（点击第一个节点后）", expanded);',
  '  add("mechanics_search（模糊候选）", api.SearchCard({ block: blocks.searchReady }));',
  '  add("mechanics_graph（running 态：还没有载荷）", api.GraphCard({ block: blocks.graphRunning }));',
  '  add("mechanics_graph（已结算但没有卡片载荷，也拿不到参数：只能如实说明）", api.GraphCard({ block: blocks.settledNoPayload }));',
  '  add("mechanics_graph（真 widget：滚轮缩放、拖拽平移、悬停看定义与规则）", api.GraphCard({ block: blocks.settledWithArgs, cwd: ' + JSON.stringify(previewProject) + ' }));',
  '  add("mechanics_graph（widget 自己的错误页就地显示：项目没有工作区）", api.GraphCard({ block: blocks.settledWithArgs, cwd: "G:/Projects/elsewhere" }));',
  '  const pendingEffects = effects.pending.splice(0);',
  '  for (const callback of pendingEffects) callback();',
  '  if (!clicked) {',
  '    clicked = true;',
  '    const circle = expanded.querySelector("circle");',
  '    if (circle) setTimeout(() => circle.dispatchEvent(new MouseEvent("click", { bubbles: true })), 0);',
  '  }',
  '}',
  'rerender = render;',
  'try { render(); } catch (error) {',
  '  document.title = "THROWN " + (error && error.message ? error.message : error);',
  '  const pre = document.createElement("pre");',
  '  pre.id = "preview-error";',
  '  pre.style.cssText = "color:#b91c1c;white-space:pre-wrap";',
  '  pre.textContent = "THROWN: " + (error && error.stack ? error.stack : error);',
  '  document.body.appendChild(pre);',
  '}',
  '</script></body></html>',
].join('\n');

writeFileSync(pagePath, page, 'utf8');
console.log('预览页面：' + pagePath);

const screenshot = option('screenshot', undefined);
if (screenshot !== undefined) {
  const browsers = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const browser = browsers.find(candidate => existsSync(candidate));
  if (browser === undefined) {
    console.log('未找到 Edge/Chrome：请手动打开上面的页面（--screenshot 需要浏览器）');
    process.exitCode = 1;
  } else {
    const target = resolve(screenshot);
    await execFileAsync(browser, [
      // 卡片里的 widget 是异步加载的：给虚拟时间预算，等 iframe 画完再截图。
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1.5', '--virtual-time-budget=5000',
      '--window-size=760,1900', '--screenshot=' + target, 'file:///' + pagePath.replace(/\\/g, '/'),
    ], { stdio: 'inherit', timeout: 60_000 });
    console.log('截图：' + target);
  }
}
widgetServer.close();
