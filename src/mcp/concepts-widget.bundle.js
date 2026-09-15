(() => {
  // src/mcp/concepts-widget-source.mjs
  var canvas = document.getElementById("canvas");
  var tooltip = document.getElementById("canvas-tooltip");
  var errorBox = document.getElementById("error");
  var svg = (tag, attributes = {}) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  };
  var NODE_WIDTH = 166;
  var NODE_HEIGHT = 62;
  var camera = { x: 0, y: 0, scale: 1 };
  var graph;
  var positions;
  var gesture;
  function requestHeight(nodeCount) {
    const height = Math.min(720, Math.max(320, 272 + nodeCount * 48));
    window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } }, "*");
  }
  function edgeStyle(edge) {
    if (edge.relation === "specializes") return { marker: "specializes", label: "is-a" };
    if (edge.sign === 1) return { marker: "positive", label: "\uFF0B" };
    if (edge.sign === -1) return { marker: "negative", label: "\u2212" };
    return { marker: "random", label: "\uFF1F" };
  }
  var CURVE_MIN = 44;
  var LANE_SPACING = 18;
  var round = (value) => Math.round(value * 100) / 100;
  var PORT_SPACING = 16;
  var PORT_PADDING = 14;
  function portSidesFor(source, target) {
    const horizontal = Math.abs(target.x - source.x) >= Math.abs(target.y - source.y);
    const forward = horizontal ? target.x >= source.x : target.y >= source.y;
    return {
      sourceSide: horizontal ? forward ? "right" : "left" : forward ? "bottom" : "top",
      targetSide: horizontal ? forward ? "left" : "right" : forward ? "top" : "bottom"
    };
  }
  function assignPorts(edges) {
    const sides = /* @__PURE__ */ new Map();
    const groups = /* @__PURE__ */ new Map();
    const push = (key, entry) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    };
    for (const edge of edges) {
      const source = positions[edge.source];
      const target = positions[edge.target];
      const pair = edge.source === edge.target ? { sourceSide: "right", targetSide: "top" } : portSidesFor(source, target);
      sides.set(edge.id, pair);
      push(edge.source + "/" + pair.sourceSide, { edgeId: edge.id, role: "source" });
      push(edge.target + "/" + pair.targetSide, { edgeId: edge.id, role: "target" });
    }
    const offsets = /* @__PURE__ */ new Map();
    for (const [key, entries] of groups) {
      entries.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
      const side = key.slice(key.lastIndexOf("/") + 1);
      const extent = side === "left" || side === "right" ? NODE_HEIGHT : NODE_WIDTH;
      const usable = Math.max(0, extent - 2 * PORT_PADDING);
      const step = entries.length > 1 ? Math.min(PORT_SPACING, usable / (entries.length - 1)) : 0;
      entries.forEach((entry, index) => {
        offsets.set(entry.edgeId + ":" + entry.role, (index - (entries.length - 1) / 2) * step);
      });
    }
    return { sides, offsets };
  }
  function portPoint(position, side, offset) {
    if (side === "left") return { x: position.x, y: position.y + NODE_HEIGHT / 2 + offset, dx: -1, dy: 0 };
    if (side === "right") return { x: position.x + NODE_WIDTH, y: position.y + NODE_HEIGHT / 2 + offset, dx: 1, dy: 0 };
    if (side === "top") return { x: position.x + NODE_WIDTH / 2 + offset, y: position.y, dx: 0, dy: -1 };
    return { x: position.x + NODE_WIDTH / 2 + offset, y: position.y + NODE_HEIGHT, dx: 0, dy: 1 };
  }
  function route(edge, ports, siblingOffset) {
    const source = positions[edge.source];
    const target = positions[edge.target];
    const pair = ports.sides.get(edge.id) ?? portSidesFor(source, target);
    if (edge.source === edge.target) {
      const lift = 86 + siblingOffset * LANE_SPACING;
      const exit = { x: source.x + NODE_WIDTH, y: source.y + 31 };
      const enter = { x: source.x, y: source.y + 31 };
      return {
        path: `M${round(exit.x)},${round(exit.y)} C${round(source.x + 270)},${round(source.y - lift)} ${round(source.x - 48)},${round(source.y - lift)} ${round(enter.x)},${round(enter.y)}`,
        label: { x: source.x + NODE_WIDTH / 2, y: source.y - lift + 22 }
      };
    }
    const start = portPoint(source, pair.sourceSide, ports.offsets.get(edge.id + ":source") ?? 0);
    const end = portPoint(target, pair.targetSide, ports.offsets.get(edge.id + ":target") ?? 0);
    const distance = Math.max(CURVE_MIN, Math.hypot(end.x - start.x, end.y - start.y) * 0.45);
    const lane = siblingOffset * LANE_SPACING;
    const controlA = { x: start.x + start.dx * distance, y: start.y + start.dy * distance + lane };
    const controlB = { x: end.x + end.dx * distance, y: end.y + end.dy * distance + lane };
    const mid = { x: (start.x + 3 * controlA.x + 3 * controlB.x + end.x) / 8, y: (start.y + 3 * controlA.y + 3 * controlB.y + end.y) / 8 };
    const verticalish = Math.abs(end.y - start.y) > Math.abs(end.x - start.x);
    return {
      path: `M${round(start.x)},${round(start.y)} C${round(controlA.x)},${round(controlA.y)} ${round(controlB.x)},${round(controlB.y)} ${round(end.x)},${round(end.y)}`,
      label: verticalish ? { x: mid.x + 7, y: mid.y } : { x: mid.x, y: mid.y - 6 }
    };
  }
  function hover(element, text) {
    if (!text) return;
    element.addEventListener("pointerenter", (event) => {
      tooltip.textContent = text;
      tooltip.style.left = "0px";
      tooltip.style.top = "0px";
      tooltip.hidden = false;
      const bounds = canvas.getBoundingClientRect();
      const tipBounds = tooltip.getBoundingClientRect();
      const inset = 10;
      const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
      const left = event.clientX + 14 + tipBounds.width > bounds.right - inset ? event.clientX - tipBounds.width - 14 : event.clientX + 14;
      const top = event.clientY + 14 + tipBounds.height > bounds.bottom - inset ? event.clientY - tipBounds.height - 14 : event.clientY + 14;
      tooltip.style.left = `${clamp(left, bounds.left + inset, bounds.right - tipBounds.width - inset)}px`;
      tooltip.style.top = `${clamp(top, bounds.top + inset, bounds.bottom - tipBounds.height - inset)}px`;
    });
    element.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
    });
  }
  function transform(world) {
    world.setAttribute("transform", `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
  }
  function draw() {
    canvas.replaceChildren();
    const defs = svg("defs");
    for (const [id, fill] of [["positive", "#328577"], ["negative", "#bd7064"], ["random", "#8b6fb3"], ["specializes", "#c49a26"]]) {
      const marker = svg("marker", { id, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: "auto", markerUnits: "strokeWidth" });
      marker.append(svg("path", { d: "M0,0 L7,3.5 L0,7 Z", fill }));
      defs.append(marker);
    }
    const world = svg("g");
    canvas.append(defs, world);
    const pairs = /* @__PURE__ */ new Map();
    for (const edge of graph.edges) {
      const key = [edge.source, edge.target].sort().join("/");
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(edge);
    }
    for (const edges of pairs.values()) edges.sort((a, b) => a.id.localeCompare(b.id));
    const ports = assignPorts(graph.edges);
    for (const edge of graph.edges) {
      const siblings = pairs.get([edge.source, edge.target].sort().join("/"));
      const siblingOffset = siblings.indexOf(edge) - (siblings.length - 1) / 2;
      const geometry = route(edge, ports, siblingOffset);
      const style = edgeStyle(edge);
      const group = svg("g", { class: "edge", tabindex: 0, role: "img", "aria-label": edge.hoverDetail ?? `${edge.source} ${style.label} ${edge.target}` });
      group.append(svg("path", { d: geometry.path, class: "edge-hit" }), svg("path", { d: geometry.path, class: `edge-line edge-${style.marker}`, "marker-end": `url(#${style.marker})` }));
      const label = svg("text", { x: geometry.label.x, y: geometry.label.y, class: `edge-label ${style.marker}` });
      label.textContent = style.label;
      group.append(label);
      hover(group, edge.hoverDetail);
      world.append(group);
    }
    for (const node of graph.nodes) {
      const point = positions[node.id];
      const group = svg("g", { class: "node", transform: `translate(${point.x} ${point.y})`, tabindex: 0, role: "img", "aria-label": node.hoverDetail ?? node.label });
      group.append(svg("rect", { width: NODE_WIDTH, height: NODE_HEIGHT, rx: 7 }));
      const label = svg("text", { x: 16, y: 27 });
      label.textContent = node.label.length > 10 ? `${node.label.slice(0, 10)}\u2026` : node.label;
      group.append(label);
      hover(group, node.hoverDetail);
      world.append(group);
    }
    transform(world);
  }
  function fit() {
    const points = graph.nodes.map((node) => positions[node.id]);
    const left = Math.min(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const width = Math.max(...points.map((point) => point.x)) + NODE_WIDTH - left;
    const height = Math.max(...points.map((point) => point.y)) + NODE_HEIGHT - top;
    const scale = Math.max(0.2, Math.min(1.2, (canvas.clientWidth - 96) / width, (canvas.clientHeight - 96) / height));
    camera = { scale, x: (canvas.clientWidth - width * scale) / 2 - left * scale, y: (canvas.clientHeight - height * scale) / 2 - top * scale };
    draw();
  }
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.88 : 1.14;
    const next = Math.max(0.15, Math.min(2.5, camera.scale * factor));
    const rect = canvas.getBoundingClientRect();
    camera.x = event.clientX - rect.left - (event.clientX - rect.left - camera.x) * next / camera.scale;
    camera.y = event.clientY - rect.top - (event.clientY - rect.top - camera.y) * next / camera.scale;
    camera.scale = next;
    draw();
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault();
    gesture = { x: event.clientX, y: event.clientY, camera: { ...camera } };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!gesture) return;
    camera.x = gesture.camera.x + event.clientX - gesture.x;
    camera.y = gesture.camera.y + event.clientY - gesture.y;
    draw();
  });
  canvas.addEventListener("pointerup", (event) => {
    gesture = null;
    canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  var initialized = false;
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id === 1 && message.result && !initialized) {
      initialized = true;
      window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
      return;
    }
    if (message.method !== "ui/notifications/tool-result") return;
    const result = message.params?.structuredContent;
    if (message.params?.isError || !result?.ok) {
      errorBox.hidden = false;
      errorBox.textContent = result?.error?.message ?? "\u6E32\u67D3\u5931\u8D25\u3002";
      return;
    }
    errorBox.hidden = true;
    graph = result.graph;
    positions = result.graph.positions;
    fit();
    requestHeight(graph.nodes.length);
  });
  var injected = globalThis.__MECHANICS_CONCEPTS_PAYLOAD__;
  if (injected !== void 0) {
    if (injected.ok === false || !injected.graph) {
      errorBox.hidden = false;
      errorBox.textContent = injected.error?.message ?? "\u6E32\u67D3\u5931\u8D25\u3002";
    } else {
      errorBox.hidden = true;
      graph = injected.graph;
      positions = injected.graph.positions;
      fit();
      requestHeight(graph.nodes.length);
    }
  } else {
    window.parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {
      appInfo: { name: "mechanics-concepts-widget", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26"
    } }, "*");
  }
})();
