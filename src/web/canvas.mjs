const svg = (tag, attributes = {}) => {
  const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value);
  return item;
};
const WIDTH = 166, HEIGHT = 62;

export function nodesInBox(nodes, positions, start, end) {
  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
  return nodes.filter(node => {
    const p = positions[node.id];
    return p.x <= right && p.x + WIDTH >= left && p.y <= bottom && p.y + HEIGHT >= top;
  }).map(node => node.id);
}
export function movePositions(positions, dx, dy) {
  const points = Object.values(positions);
  if (!points.length) return {};
  const clamp = (delta, key) => Math.max(-100000 - Math.min(...points.map(p => p[key])),
    Math.min(100000 - Math.max(...points.map(p => p[key])), Math.round(delta)));
  dx = clamp(dx, 'x'); dy = clamp(dy, 'y');
  return Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
}

export class GraphCanvas {
  constructor(root, callbacks) {
    this.root = root; this.callbacks = callbacks; this.camera = { x: 50, y: 80, scale: 1 };
    this.graph = { nodes: [], edges: [] }; this.positions = {}; this.mode = 'select'; this.space = false;
    root.addEventListener('wheel', event => {
      event.preventDefault(); const rect = root.getBoundingClientRect();
      this.zoom(Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    root.addEventListener('pointerdown', event => this.down(event));
    root.addEventListener('pointermove', event => this.move(event));
    root.addEventListener('pointerup', event => this.up(event));
    root.addEventListener('pointercancel', () => this.cancel());
    root.addEventListener('lostpointercapture', () => this.cancel());
    root.addEventListener('contextmenu', event => event.preventDefault());
    root.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      const node = event.target.closest('[data-node]');
      if (node) { event.preventDefault(); this.pick(node.dataset.node); }
      const edge = event.target.closest('[data-edge]');
      if (edge) { event.preventDefault(); this.callbacks.select({ type: 'edge', id: edge.dataset.edge }); }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.cancel();
      if (event.code === 'Space' && !event.target.closest('input,textarea,select,dialog,button')) { event.preventDefault(); this.space = true; }
    });
    document.addEventListener('keyup', event => { if (event.code === 'Space') this.space = false; });
    window.addEventListener('blur', () => { this.space = false; this.cancel(); });
  }
  update(graph, positions, activeId, selection, definitionMode) {
    this.graph = graph; this.positions = positions; this.activeId = activeId; this.selection = selection; this.definitionMode = definitionMode; this.draw();
  }
  setMode(mode) { this.cancel(); this.mode = mode; this.linkSource = null; this.root.classList.toggle('linking', mode !== 'select'); this.draw(); }
  selectedIds() { return this.selection?.type === 'nodes' ? this.selection.ids : this.selection?.type === 'node' ? [this.selection.id] : []; }
  selectNodes(ids) { this.callbacks.select(ids.length === 1 ? { type: 'node', id: ids[0] } : ids.length ? { type: 'nodes', ids } : null); }
  cancel() {
    const gesture = this.gesture; if (!gesture) return;
    this.gesture = null;
    if (gesture.type === 'pan') this.camera = gesture.original;
    if (this.root.hasPointerCapture(gesture.pointerId)) this.root.releasePointerCapture(gesture.pointerId);
    this.root.classList.remove('panning'); this.draw();
  }
  point(event) {
    const rect = this.root.getBoundingClientRect(), { x, y, scale } = this.camera;
    return { x: (event.clientX - rect.left - x) / scale, y: (event.clientY - rect.top - y) / scale };
  }
  down(event) {
    if (this.gesture || ![0, 1, 2].includes(event.button)) return;
    const node = event.target.closest('[data-node]'), edge = event.target.closest('[data-edge]');
    if (event.button === 2 || event.button === 1 || this.space) {
      event.preventDefault(); this.gesture = { type: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, original: { ...this.camera }, moved: false };
      this.root.setPointerCapture(event.pointerId); this.root.classList.add('panning'); return;
    }
    if (!node && !edge) {
      if (this.mode !== 'select') return;
      event.preventDefault();
      this.gesture = { type: 'box', point: this.point(event), end: this.point(event), x: event.clientX, y: event.clientY,
        pointerId: event.pointerId, original: event.shiftKey ? [...this.selectedIds()] : [], additive: event.shiftKey, moved: false };
      this.root.setPointerCapture(event.pointerId); return;
    }
    if (node) {
      const id = node.dataset.node;
      if (this.mode !== 'select') { event.preventDefault(); this.pick(id); return; }
      const selected = this.selectedIds();
      if (event.shiftKey) { this.selectNodes(selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]); return; }
      const ids = selected.includes(id) ? selected : [id];
      this.selectNodes(ids);
      if (ids.every(item => this.callbacks.canMove(item))) {
        event.preventDefault(); this.gesture = { type: 'nodes', ids, pointerId: event.pointerId, point: this.point(event),
          x: event.clientX, y: event.clientY, original: Object.fromEntries(ids.map(item => [item, { ...this.positions[item] }])), moved: false };
        this.root.setPointerCapture(event.pointerId);
      }
    } else if (edge) this.callbacks.select({ type: 'edge', id: edge.dataset.edge });
  }
  move(event) {
    const gesture = this.gesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.moved ||= Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 3;
    if (gesture.type === 'pan') {
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      this.camera.x = gesture.original.x + dx; this.camera.y = gesture.original.y + dy; this.transform();
    } else if (gesture.type === 'box') {
      gesture.end = this.point(event); this.draw();
    } else {
      const point = this.point(event), dx = point.x - gesture.point.x, dy = point.y - gesture.point.y;
      gesture.next = movePositions(gesture.original, dx, dy);
      this.draw();
    }
  }
  up(event) {
    const gesture = this.gesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.move(event);
    this.gesture = null; this.root.classList.remove('panning');
    if (this.root.hasPointerCapture(event.pointerId)) this.root.releasePointerCapture(event.pointerId);
    if (gesture.type === 'nodes' && gesture.moved && gesture.ids.every(id => this.graph.nodes.some(node => node.id === id) && this.callbacks.canMove(id))) this.callbacks.move(gesture.next);
    else if (gesture.type === 'box' && gesture.moved) this.selectNodes([...new Set([...gesture.original, ...nodesInBox(this.graph.nodes, this.positions, gesture.point, gesture.end)])]);
    else if (gesture.type === 'box' && !gesture.additive && !gesture.moved) this.callbacks.select(null);
    this.draw();
  }
  pick(id) {
    if (this.mode === 'select') { this.callbacks.select({ type: 'node', id }); return; }
    if (!this.linkSource) { this.linkSource = id; this.callbacks.hint('现在点击目标节点 · Esc 取消连线'); this.draw(); }
    else { const source = this.linkSource; this.linkSource = null; this.callbacks.link(source, id, this.mode === 'contains' ? 'contains' : this.mode === 'positive' ? 1 : -1); this.draw(); }
  }
  zoom(factor, x = this.root.clientWidth / 2, y = this.root.clientHeight / 2) {
    if (this.gesture) return;
    const old = this.camera.scale, next = Math.max(.15, Math.min(2.5, old * factor));
    this.camera.x = x - (x - this.camera.x) * next / old;
    this.camera.y = y - (y - this.camera.y) * next / old;
    this.camera.scale = next; this.transform();
  }
  fit() {
    if (this.gesture) return;
    const points = this.graph.nodes.map(node => this.positions[node.id]);
    if (!points.length) return;
    const minX = Math.min(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y));
    const width = Math.max(...points.map(p => p.x)) + WIDTH - minX, height = Math.max(...points.map(p => p.y)) + HEIGHT - minY;
    const availableWidth = Math.max(200, this.root.clientWidth - 100), availableHeight = Math.max(200, this.root.clientHeight - 210);
    const scale = Math.max(.15, Math.min(1.2, availableWidth / width, availableHeight / height));
    this.camera = { scale, x: (this.root.clientWidth - width * scale) / 2 - minX * scale, y: 75 + (availableHeight - height * scale) / 2 - minY * scale };
    this.transform();
  }
  center() { return this.point({ clientX: this.root.getBoundingClientRect().left + this.root.clientWidth * .45, clientY: this.root.getBoundingClientRect().top + this.root.clientHeight * .4 }); }
  transform() {
    this.world?.setAttribute('transform', `translate(${this.camera.x} ${this.camera.y}) scale(${this.camera.scale})`);
    this.callbacks.zoom(Math.round(this.camera.scale * 100));
  }
  draw() {
    this.root.replaceChildren();
    const defs = svg('defs');
    for (const [id, fill] of [['positive', '#328577'], ['negative', '#bd7064'], ['contains', '#c49a26']]) {
      const marker = svg('marker', { id, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto', markerUnits: 'strokeWidth' });
      marker.append(svg('path', { d: 'M0,0 L7,3.5 L0,7 Z', fill })); defs.append(marker);
    }
    this.world = svg('g'); this.root.append(defs, this.world);
    const positions = { ...this.positions };
    if (this.gesture?.type === 'nodes' && this.gesture.next) Object.assign(positions, this.gesture.next);
    const parallel = new Map();
    for (const edge of this.graph.edges) {
      const key = [edge.source, edge.target].sort().join('/');
      if (!parallel.has(key)) parallel.set(key, []); parallel.get(key).push(edge.id);
    }
    for (const edge of this.graph.edges) {
      const a = positions[edge.source], b = positions[edge.target]; if (!a || !b) continue;
      const siblings = parallel.get([edge.source, edge.target].sort().join('/'));
      const offset = (siblings.indexOf(edge.id) - (siblings.length - 1) / 2) * 34;
      const right = a.x <= b.x;
      const x1 = a.x + (right ? WIDTH : 0), y1 = a.y + HEIGHT / 2;
      const x2 = b.x + (right ? 0 : WIDTH), y2 = b.y + HEIGHT / 2;
      const control = Math.max(60, Math.abs(x2 - x1) * .5);
      let path, labelX = (x1 + x2) / 2, labelY = (y1 + y2) / 2 + offset * .75 - 7;
      if (edge.source === edge.target) {
        path = `M${a.x + WIDTH - 25},${a.y} C${a.x + WIDTH + 50},${a.y - 75 - offset} ${a.x - 50},${a.y - 75 - offset} ${a.x + 25},${a.y}`;
        labelX = a.x + WIDTH / 2; labelY = a.y - 55 - offset;
      } else path = `M${x1},${y1} C${x1 + (right ? control : -control)},${y1 + offset} ${x2 + (right ? -control : control)},${y2 + offset} ${x2},${y2}`;
      const sign = edge.relation === 'contains' ? 'contains' : edge.sign === 1 ? 'positive' : 'negative';
      const own = this.activeId === null || (edge.steps.length === 1 && edge.steps[0].graphId === this.activeId);
      const selected = this.selection?.type === 'edge' && this.selection.id === edge.id;
      const group = svg('g', { 'data-edge': edge.id, tabindex: 0, role: 'button', 'aria-label': `${this.callbacks.name(edge.source)} ${sign === 'contains' ? '包含' : edge.sign === 1 ? '促进' : '抑制'} ${this.callbacks.name(edge.target)}` });
      group.append(svg('path', { d: path, class: 'edge-hit' }), svg('path', { d: path, class: `edge-line edge-${sign} ${own ? '' : 'reference'} ${selected ? 'selected' : ''}`, 'marker-end': `url(#${sign})`, 'pointer-events': 'none' }));
      const label = svg('text', { x: labelX, y: labelY, class: `edge-label ${sign}`, opacity: own || selected ? 1 : .4 });
      label.textContent = sign === 'contains' ? '=' : edge.sign === 1 ? '+' : '−'; group.append(label); this.world.append(group);
    }
    for (const node of this.graph.nodes) {
      const point = positions[node.id];
      const own = this.activeId === null || this.definitionMode || node.sourceGraphIds?.includes(this.activeId);
      const selected = this.selectedIds().includes(node.id);
      const group = svg('g', { 'data-node': node.id, transform: `translate(${point.x} ${point.y})`, class: `node ${own ? '' : 'reference'} ${selected ? 'selected' : ''} ${this.linkSource === node.id ? 'link-source' : ''}`, tabindex: 0, role: 'button', 'aria-label': node.label });
      const title = svg('title'); title.textContent = `${node.label}\n${node.description}`;
      const label = svg('text', { x: 16, y: 27 }); label.textContent = node.label.length > 10 ? `${node.label.slice(0, 10)}…` : node.label;
      const meta = svg('text', { x: 16, y: 45, class: 'node-meta' });
      meta.textContent = this.definitionMode ? node.id.slice(0, 23) : (node.sourceGraphIds ?? []).map(this.callbacks.graphName).join(' · ').slice(0, 23);
      group.append(title, svg('rect', { width: WIDTH, height: HEIGHT, rx: 7 }), label, meta, svg('circle', { cx: 0, cy: HEIGHT / 2, r: 3.5 }), svg('circle', { cx: WIDTH, cy: HEIGHT / 2, r: 3.5 }));
      this.world.append(group);
    }
    if (this.gesture?.type === 'box' && this.gesture.moved) {
      const { point, end } = this.gesture;
      this.world.append(svg('rect', { x: Math.min(point.x, end.x), y: Math.min(point.y, end.y),
        width: Math.abs(end.x - point.x), height: Math.abs(end.y - point.y), class: 'selection-box', 'pointer-events': 'none' }));
    }
    this.transform();
  }
}
