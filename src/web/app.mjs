import { compose, canCollapse, collapse, tracePaths, diagnose } from '/domain/graph.mjs';

const $ = id => document.getElementById(id);
const svgElement = (tag, attributes = {}) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};
const element = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
let workspace, selectedIds = [], selectedNode = null, folded = [], positions = {};
const token = new URLSearchParams(location.hash.slice(1)).get('session');
const graphName = id => workspace.analyses.find(graph => graph.id === id)?.name ?? id;
const nodeName = id => workspace.definitions.nodes.find(node => node.id === id)?.label ?? id;

function showError(error) {
  $('error').textContent = `${error.message}\n没有替换为示例数据，也没有保存任何文件。`;
  $('error').hidden = false;
}

function detail(label, content) {
  const item = element('div', undefined, 'detail-item');
  item.append(element('strong', label), element('span', content));
  return item;
}

function inspect(graph) {
  const panel = $('details');
  panel.replaceChildren();
  const node = workspace.definitions.nodes.find(item => item.id === selectedNode);
  if (!node) { panel.append(element('h2', '选择一个节点'), element('p', '查看含义、增加方向和来源。', 'muted')); return; }
  panel.append(element('h2', node.label), detail('稳定 ID', node.id), detail('概念含义', node.description), detail('增加方向', node.increaseMeaning));
  panel.append(detail('引用此节点的图', workspace.analyses.filter(item => item.nodeIds.includes(node.id)).map(item => item.name).join('、') || '尚未引用'));
  if (canCollapse(graph, node.id)) {
    const button = element('button', '折叠此中间节点');
    button.onclick = () => { folded.push(node.id); selectedNode = null; render(); };
    panel.append(button);
  }
  for (const edge of graph.edges.filter(item => item.source === node.id || item.target === node.id)) {
    panel.append(detail(`${nodeName(edge.source)} ${edge.sign === 1 ? '＋' : '−'}→ ${nodeName(edge.target)}`,
      edge.steps.map(step => `${graphName(step.graphId)} / ${step.edgeId}；条件：${step.condition || '未补充（不代表无条件）'}；${step.note}`).join('\n')));
  }
  if (!graph.nodes.some(item => item.id === node.id)) return;
  const label = element('label', '从此节点追踪到'); label.htmlFor = 'trace-target';
  const target = element('select'); target.id = 'trace-target';
  graph.nodes.filter(item => item.id !== node.id).forEach(item => { const option = element('option', item.label); option.value = item.id; target.append(option); });
  const run = element('button', '解释影响路径'); const output = element('div');
  run.disabled = target.options.length === 0;
  run.onclick = () => {
    const result = tracePaths(graph, node.id, target.value);
    output.replaceChildren(detail('解释边界', result.interpretation));
    for (const path of result.paths) output.append(detail(`路径方向：${path.sign === 1 ? '促进' : '抑制'}`, path.steps.map(step => `${nodeName(step.source)} ${step.sign === 1 ? '＋' : '−'}→ ${nodeName(step.target)} [${graphName(step.graphId)}]；条件：${step.condition || '未说明'}`).join('\n')));
    if (!result.paths.length) output.append(element('p', '当前选图未找到路径；不能推断现实中不存在影响。'));
    if (result.truncated) output.append(element('p', '已达到查询上限，结果不完整。'));
  };
  panel.append(label, target, run, output);
}

function render() {
  if (!workspace) return;
  const original = compose(workspace, selectedIds);
  let graph = original;
  for (const id of folded) graph = collapse(graph, id);
  const definitionMode = $('definitions-mode').checked;
  const nodes = definitionMode ? workspace.definitions.nodes.filter(node => !folded.includes(node.id)) : graph.nodes;
  $('view-title').textContent = definitionMode ? '统一节点定义图' : '分析图叠加';
  $('counts').textContent = `${nodes.length} 个概念 · ${graph.edges.length} 条关系 · ${selectedIds.length} 张图`;
  const canvas = $('canvas'); canvas.replaceChildren();
  const defs = svgElement('defs');
  for (const [id, color] of [['positive', '#72d2b4'], ['negative', '#efb078']]) {
    const marker = svgElement('marker', { id, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' });
    marker.append(svgElement('path', { d: 'M0,0 L8,4 L0,8 Z', fill: color })); defs.append(marker);
  }
  canvas.append(defs);
  const placement = new Map(nodes.map((node, index) => [node.id, positions[node.id] ?? workspace.definitions.positions[node.id] ?? { x: (index % 4) * 240 + 40, y: Math.floor(index / 4) * 170 + 40 }]));
  const points = [...placement.values()];
  const minX = Math.min(0, ...points.map(point => point.x)) - 35;
  const minY = Math.min(0, ...points.map(point => point.y)) - 35;
  canvas.setAttribute('viewBox', `${minX} ${minY} ${Math.max(900, ...points.map(point => point.x + 220)) - minX} ${Math.max(620, ...points.map(point => point.y + 120)) - minY}`);
  for (const edge of graph.edges) {
    const a = placement.get(edge.source), b = placement.get(edge.target);
    const reversed = a.x > b.x;
    const x1 = a.x + (reversed ? 0 : 170), y1 = a.y + 33, x2 = b.x + (reversed ? 170 : 0), y2 = b.y + 33;
    const midX = (x1 + x2) / 2;
    const polarity = edge.sign === 1 ? 'positive' : 'negative';
    const path = svgElement('path', { d: `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`, class: `edge ${polarity}`, 'marker-end': `url(#${polarity})` });
    const title = svgElement('title'); title.textContent = edge.steps.map(step => `${graphName(step.graphId)}/${step.edgeId}：${step.condition}`).join('\n'); path.append(title); canvas.append(path);
    const sign = svgElement('text', { x: midX + 8, y: (y1 + y2) / 2 - 8, class: `edge-label ${polarity}` }); sign.textContent = edge.sign === 1 ? '＋' : '−'; canvas.append(sign);
  }
  for (const node of nodes) {
    const point = placement.get(node.id), owners = selectedIds.filter(id => workspace.analyses.find(graph => graph.id === id).nodeIds.includes(node.id));
    const group = svgElement('g', { transform: `translate(${point.x},${point.y})`, class: `node ${selectedNode === node.id ? 'selected' : ''} ${owners.length ? '' : 'unused'}`, tabindex: 0, role: 'button', 'aria-label': node.label });
    const text = svgElement('text', { x: 14, y: 27 }); text.textContent = node.label.length > 10 ? `${node.label.slice(0, 10)}…` : node.label;
    const source = svgElement('text', { x: 14, y: 48, class: 'source-label' }); source.textContent = owners.map(graphName).join(' · ').slice(0, 24) || '未被当前选图引用';
    group.append(svgElement('rect', { width: 170, height: 65, rx: 7 }), text, source);
    group.onclick = () => { selectedNode = node.id; render(); };
    group.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectedNode = node.id; render(); } };
    canvas.append(group);
  }
  $('findings').replaceChildren();
  for (const finding of diagnose(original).findings) $('findings').append(element('p', `${finding.nodeIds.map(nodeName).join('、')}：${finding.message}`, 'finding'));
  if (!original.nodes.length) $('findings').append(element('p', '未选择分析图；定义总览不进行孤立性诊断。', 'muted'));
  inspect(graph);
}

function selectComposition(id) {
  const view = workspace.manifest.compositions.find(item => item.id === id);
  selectedIds = view ? [...view.graphIds] : workspace.analyses.map(graph => graph.id);
  folded = view ? [...view.collapsedNodeIds] : []; positions = view ? structuredClone(view.positions) : {}; selectedNode = null;
  for (const input of $('graphs').querySelectorAll('input')) input.checked = selectedIds.includes(input.value);
  render();
}

async function load() {
  try {
    $('error').hidden = true;
    if (!token) throw new Error('请使用服务启动时打印的完整网址打开，包括本机会话片段。');
    const response = await fetch('/api/workspace', { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(`${data.error}：${data.message}`);
    workspace = data; $('workspace-name').textContent = workspace.manifest.name;
    $('graphs').replaceChildren(); $('composition').replaceChildren();
    const all = element('option', '全部分析图'); all.value = ''; $('composition').append(all);
    for (const view of workspace.manifest.compositions) { const option = element('option', view.name); option.value = view.id; $('composition').append(option); }
    for (const graph of workspace.analyses) {
      const label = element('label', undefined, 'graph-option');
      const input = element('input'); input.type = 'checkbox'; input.value = graph.id;
      input.onchange = () => {
        selectedIds = [...$('graphs').querySelectorAll('input:checked')].map(item => item.value);
        folded = []; positions = {}; $('composition').value = ''; render();
      };
      label.append(input, document.createTextNode(` ${graph.name}`), element('small', graph.scope)); $('graphs').append(label);
    }
    $('composition').disabled = false; $('reset').disabled = false;
    selectComposition('');
  } catch (error) {
    workspace = undefined; $('canvas').replaceChildren(); $('graphs').replaceChildren(); $('findings').replaceChildren(); $('details').replaceChildren();
    $('counts').textContent = ''; $('workspace-name').textContent = '工作区读取失败'; $('composition').disabled = true; $('reset').disabled = true;
    showError(error);
  }
}
$('reload').onclick = load;
$('composition').onchange = () => { try { selectComposition($('composition').value); } catch (error) { showError(error); } };
$('definitions-mode').onchange = render;
$('reset').onclick = () => { folded = []; render(); };
await load();
