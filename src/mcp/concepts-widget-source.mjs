const canvas = document.getElementById('canvas');
const tooltip = document.getElementById('canvas-tooltip');
const errorBox = document.getElementById('error');
const svg = (tag, attributes = {}) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};

const NODE_WIDTH = 166;
const NODE_HEIGHT = 62;
let camera = { x: 0, y: 0, scale: 1 };
let graph;
let positions;
let gesture;

function requestHeight(nodeCount) {
  const height = Math.min(720, Math.max(320, 272 + nodeCount * 48));
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height } }, '*');
}

function edgeStyle(edge) {
  if (edge.relation === 'specializes') return { marker: 'specializes', label: 'is-a' };
  if (edge.sign === 1) return { marker: 'positive', label: '＋' };
  if (edge.sign === -1) return { marker: 'negative', label: '−' };
  return { marker: 'random', label: '？' };
}

// 与网页编辑器同一套视觉语言：直角折线（拐角圆角），不再是贝塞尔。
// 网页那边的路径来自真路由（端口分布 + 轨道 + 避让）后由 roundedPath 拼出；这里没有那套引擎。
// 走线用曲线：端口分配保证同侧多条边各有进出口，曲线在算法不完善时比折线耐读。
const CURVE_MIN = 44;
const LANE_SPACING = 18;
const round = value => Math.round(value * 100) / 100;


// 端口分配：同一个面（左/右/上/下）上的多条边沿线错开，这是上一版最大的缺陷——
// 一个面只用一个中点，导致同侧的多条关系从同一点出发并完全重叠。
const PORT_SPACING = 16;
const PORT_PADDING = 14;

function portSidesFor(source, target) {
  const horizontal = Math.abs(target.x - source.x) >= Math.abs(target.y - source.y);
  const forward = horizontal ? target.x >= source.x : target.y >= source.y;
  return {
    sourceSide: horizontal ? (forward ? 'right' : 'left') : (forward ? 'bottom' : 'top'),
    targetSide: horizontal ? (forward ? 'left' : 'right') : (forward ? 'top' : 'bottom'),
  };
}

function assignPorts(edges) {
  const sides = new Map();
  const groups = new Map();
  const push = (key, entry) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry); };
  for (const edge of edges) {
    const source = positions[edge.source];
    const target = positions[edge.target];
    const pair = edge.source === edge.target ? { sourceSide: 'right', targetSide: 'top' } : portSidesFor(source, target);
    sides.set(edge.id, pair);
    push(edge.source + '/' + pair.sourceSide, { edgeId: edge.id, role: 'source' });
    push(edge.target + '/' + pair.targetSide, { edgeId: edge.id, role: 'target' });
  }
  const offsets = new Map();
  for (const [key, entries] of groups) {
    entries.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
    const side = key.slice(key.lastIndexOf('/') + 1);
    const extent = side === 'left' || side === 'right' ? NODE_HEIGHT : NODE_WIDTH;
    const usable = Math.max(0, extent - 2 * PORT_PADDING);
    const step = entries.length > 1 ? Math.min(PORT_SPACING, usable / (entries.length - 1)) : 0;
    entries.forEach((entry, index) => {
      offsets.set(entry.edgeId + ':' + entry.role, (index - (entries.length - 1) / 2) * step);
    });
  }
  return { sides, offsets };
}

function portPoint(position, side, offset) {
  if (side === 'left') return { x: position.x, y: position.y + NODE_HEIGHT / 2 + offset, dx: -1, dy: 0 };
  if (side === 'right') return { x: position.x + NODE_WIDTH, y: position.y + NODE_HEIGHT / 2 + offset, dx: 1, dy: 0 };
  if (side === 'top') return { x: position.x + NODE_WIDTH / 2 + offset, y: position.y, dx: 0, dy: -1 };
  return { x: position.x + NODE_WIDTH / 2 + offset, y: position.y + NODE_HEIGHT, dx: 0, dy: 1 };
}

// 曲线的标注位置由 route() 自己算（三次贝塞尔 t=0.5 的中点），这里不再需要折线的取段逻辑。

function route(edge, ports, siblingOffset) {
  const source = positions[edge.source];
  const target = positions[edge.target];
  const pair = ports.sides.get(edge.id) ?? portSidesFor(source, target);
  if (edge.source === edge.target) {
    // 自环：右侧出、上方绕回左侧。
    const lift = 86 + siblingOffset * LANE_SPACING;
    const exit = { x: source.x + NODE_WIDTH, y: source.y + 31 };
    const enter = { x: source.x, y: source.y + 31 };
    return {
      path: `M${round(exit.x)},${round(exit.y)} C${round(source.x + 270)},${round(source.y - lift)} ${round(source.x - 48)},${round(source.y - lift)} ${round(enter.x)},${round(enter.y)}`,
      label: { x: source.x + NODE_WIDTH / 2, y: source.y - lift + 22 },
    };
  }
  const start = portPoint(source, pair.sourceSide, ports.offsets.get(edge.id + ':source') ?? 0);
  const end = portPoint(target, pair.targetSide, ports.offsets.get(edge.id + ':target') ?? 0);
  // 控制点沿端口法线拉出，所以「从哪个面出、从哪个面进」仍然读得出来；
  // 端口分配照旧（同侧多条边各有自己的进出口），只是把走线换回曲线。
  const distance = Math.max(CURVE_MIN, Math.hypot(end.x - start.x, end.y - start.y) * 0.45);
  const lane = siblingOffset * LANE_SPACING;
  const controlA = { x: start.x + start.dx * distance, y: start.y + start.dy * distance + lane };
  const controlB = { x: end.x + end.dx * distance, y: end.y + end.dy * distance + lane };
  const mid = { x: (start.x + 3 * controlA.x + 3 * controlB.x + end.x) / 8, y: (start.y + 3 * controlA.y + 3 * controlB.y + end.y) / 8 };
  const verticalish = Math.abs(end.y - start.y) > Math.abs(end.x - start.x);
  return {
    path: `M${round(start.x)},${round(start.y)} C${round(controlA.x)},${round(controlA.y)} ${round(controlB.x)},${round(controlB.y)} ${round(end.x)},${round(end.y)}`,
    label: verticalish ? { x: mid.x + 7, y: mid.y } : { x: mid.x, y: mid.y - 6 },
  };
}

function hover(element, text) {
  if (!text) return;
  element.addEventListener('pointerenter', event => {
    tooltip.textContent = text;
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    tooltip.hidden = false;
    const bounds = canvas.getBoundingClientRect();
    const tipBounds = tooltip.getBoundingClientRect();
    const inset = 10;
    const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
    const left = event.clientX + 14 + tipBounds.width > bounds.right - inset
      ? event.clientX - tipBounds.width - 14 : event.clientX + 14;
    const top = event.clientY + 14 + tipBounds.height > bounds.bottom - inset
      ? event.clientY - tipBounds.height - 14 : event.clientY + 14;
    tooltip.style.left = `${clamp(left, bounds.left + inset, bounds.right - tipBounds.width - inset)}px`;
    tooltip.style.top = `${clamp(top, bounds.top + inset, bounds.bottom - tipBounds.height - inset)}px`;
  });
  element.addEventListener('pointerleave', () => { tooltip.hidden = true; });
}

function transform(world) {
  world.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
}

function draw() {
  canvas.replaceChildren();
  const defs = svg('defs');
  for (const [id, fill] of [['positive', '#328577'], ['negative', '#bd7064'], ['random', '#8b6fb3'], ['specializes', '#c49a26']]) {
    const marker = svg('marker', { id, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto', markerUnits: 'strokeWidth' });
    marker.append(svg('path', { d: 'M0,0 L7,3.5 L0,7 Z', fill })); defs.append(marker);
  }
  const world = svg('g'); canvas.append(defs, world);
  const pairs = new Map();
  for (const edge of graph.edges) {
    const key = [edge.source, edge.target].sort().join('/');
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(edge);
  }
  for (const edges of pairs.values()) edges.sort((a, b) => a.id.localeCompare(b.id));
  // 端口分配必须先算：它决定同侧多条边各自从哪里出发。
  const ports = assignPorts(graph.edges);
  for (const edge of graph.edges) {
    const siblings = pairs.get([edge.source, edge.target].sort().join('/'));
    const siblingOffset = siblings.indexOf(edge) - (siblings.length - 1) / 2;
    const geometry = route(edge, ports, siblingOffset);
    const style = edgeStyle(edge);
    const group = svg('g', { class: 'edge', tabindex: 0, role: 'img', 'aria-label': edge.hoverDetail ?? `${edge.source} ${style.label} ${edge.target}` });
    group.append(svg('path', { d: geometry.path, class: 'edge-hit' }), svg('path', { d: geometry.path, class: `edge-line edge-${style.marker}`, 'marker-end': `url(#${style.marker})` }));
    const label = svg('text', { x: geometry.label.x, y: geometry.label.y, class: `edge-label ${style.marker}` });
    label.textContent = style.label; group.append(label); hover(group, edge.hoverDetail); world.append(group);
  }
  for (const node of graph.nodes) {
    const point = positions[node.id];
    const group = svg('g', { class: 'node', transform: `translate(${point.x} ${point.y})`, tabindex: 0, role: 'img', 'aria-label': node.hoverDetail ?? node.label });
    group.append(svg('rect', { width: NODE_WIDTH, height: NODE_HEIGHT, rx: 7 }));
    const label = svg('text', { x: 16, y: 27 });
    label.textContent = node.label.length > 10 ? `${node.label.slice(0, 10)}…` : node.label;
    group.append(label); hover(group, node.hoverDetail); world.append(group);
  }
  transform(world);
}

function fit() {
  const points = graph.nodes.map(node => positions[node.id]);
  const left = Math.min(...points.map(point => point.x));
  const top = Math.min(...points.map(point => point.y));
  const width = Math.max(...points.map(point => point.x)) + NODE_WIDTH - left;
  const height = Math.max(...points.map(point => point.y)) + NODE_HEIGHT - top;
  const scale = Math.max(.2, Math.min(1.2, (canvas.clientWidth - 96) / width, (canvas.clientHeight - 96) / height));
  camera = { scale, x: (canvas.clientWidth - width * scale) / 2 - left * scale, y: (canvas.clientHeight - height * scale) / 2 - top * scale };
  draw();
}

canvas.addEventListener('wheel', event => {
  event.preventDefault(); const factor = event.deltaY > 0 ? .88 : 1.14;
  const next = Math.max(.15, Math.min(2.5, camera.scale * factor)); const rect = canvas.getBoundingClientRect();
  camera.x = event.clientX - rect.left - (event.clientX - rect.left - camera.x) * next / camera.scale;
  camera.y = event.clientY - rect.top - (event.clientY - rect.top - camera.y) * next / camera.scale;
  camera.scale = next; draw();
}, { passive: false });
canvas.addEventListener('pointerdown', event => {
  // 只认左键与中键：其余键交给浏览器，避免与系统手势打架。
  if (event.button !== 0 && event.button !== 1) return;
  // 中键：必须阻止默认行为，否则浏览器会开启自动滚动，页面跟着一起漂（双层漂移）。
  if (event.button === 1) event.preventDefault();
  gesture = { x: event.clientX, y: event.clientY, camera: { ...camera } };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => { if (!gesture) return; camera.x = gesture.camera.x + event.clientX - gesture.x; camera.y = gesture.camera.y + event.clientY - gesture.y; draw(); });
canvas.addEventListener('pointerup', event => { gesture = null; canvas.releasePointerCapture(event.pointerId); });
// 中键抬起在部分浏览器里还会触发 auxclick 的默认动作（粘贴/自动滚动），一并挡掉。
canvas.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });

let initialized = false;
window.addEventListener('message', event => {
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.id === 1 && message.result && !initialized) {
    initialized = true;
    window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*'); return;
  }
  if (message.method !== 'ui/notifications/tool-result') return;
  const result = message.params?.structuredContent;
  if (message.params?.isError || !result?.ok) { errorBox.hidden = false; errorBox.textContent = result?.error?.message ?? '渲染失败。'; return; }
  errorBox.hidden = true; graph = result.graph; positions = result.graph.positions; fit(); requestHeight(graph.nodes.length);
});
// DSH（DeepSeek Harness）里没有 MCP Apps 宿主：插件自持的路由把同一份载荷直接注进页面，
// 于是这份 widget 不需要握手就渲染——缩放、平移、hover 与配色与网页、Codex 侧完全一致。
const injected = globalThis.__MECHANICS_CONCEPTS_PAYLOAD__;
if (injected !== undefined) {
  if (injected.ok === false || !injected.graph) {
    errorBox.hidden = false;
    errorBox.textContent = injected.error?.message ?? '渲染失败。';
  } else {
    errorBox.hidden = true;
    graph = injected.graph;
    positions = injected.graph.positions;
    fit();
    requestHeight(graph.nodes.length);
  }
} else {
  window.parent.postMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {
    appInfo: { name: 'mechanics-concepts-widget', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26',
  } }, '*');
}
