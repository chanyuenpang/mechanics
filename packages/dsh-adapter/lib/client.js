// @veewo/dsh-mechanics 的浏览器半：手写的 lazy-CJS bundle，不引入构建链。
// 它只注册两张工具卡（keyed slot tool.call.toolview），不订阅会话事件、不重建 transcript、
// 也不读会话服务：卡的一切都来自冻结的 call/result 切片（block.meta 由 host 半写入并随日志持久化）。
window.__ModuleLoader__.load({
  id: "@veewo/dsh-mechanics",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;

    const NODE_RADIUS = 26;
    const VIEW_WIDTH = 520;
    const VIEW_HEIGHT = 300;

    const STYLE = {
      card: { border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", borderRadius: 12, margin: "4px 0 4px 4px", padding: "10px 12px", fontSize: 13, color: "var(--dsw-alias-label-primary, inherit)" },
      header: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, color: "var(--dsw-alias-label-secondary, inherit)" },
      title: { fontWeight: 500, color: "var(--dsw-alias-label-primary, inherit)" },
      muted: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, inherit)" },
      row: { display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0", borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18))" },
      chip: { borderRadius: 6, padding: "1px 6px", fontSize: 11, background: "var(--dsw-alias-markdown-code-block, rgba(128,128,128,.12))", color: "var(--dsw-alias-label-tertiary, inherit)" },
      detail: { marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "var(--dsw-alias-markdown-code-block, rgba(128,128,128,.1))", fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap" },
      svg: { display: "block", width: "100%", height: VIEW_HEIGHT },
      nodeLabel: { fontSize: 11, textAnchor: "middle", dominantBaseline: "middle", fill: "var(--dsw-alias-label-primary, currentColor)", pointerEvents: "none" },
      edgeLabel: { fontSize: 10, textAnchor: "middle", fill: "var(--dsw-alias-label-tertiary, currentColor)", pointerEvents: "none" },
    };

    const EDGE_COLORS = {
      positive: "var(--dsw-alias-state-success-primary, #16a34a)",
      negative: "var(--dsw-alias-state-error-primary, #dc2626)",
      random: "var(--dsw-alias-label-tertiary, #9ca3af)",
      specializes: "var(--dsw-alias-label-secondary, #6b7280)",
    };

    const operatorOf = (edge) => (edge.relation === "specializes" ? "is-a>" : edge.sign === 1 ? "+>" : edge.sign === -1 ? "->" : "?>");
    const colorOf = (edge) => (edge.relation === "specializes" ? EDGE_COLORS.specializes : edge.sign === 1 ? EDGE_COLORS.positive : edge.sign === -1 ? EDGE_COLORS.negative : EDGE_COLORS.random);
    const qualifierText = (edge) => {
      const parts = [];
      if (Array.isArray(edge.sourceQualifiers) && edge.sourceQualifiers.length) parts.push("source 限定：" + edge.sourceQualifiers.join("、"));
      if (Array.isArray(edge.targetQualifiers) && edge.targetQualifiers.length) parts.push("target 限定：" + edge.targetQualifiers.join("、"));
      return parts.join("；");
    };
    const truncate = (value, limit) => (value.length > limit ? value.slice(0, limit) + "…" : value);

    /** 圆形布局：集合通常很小（≤64），不需要引入布局引擎；坐标只服务本卡。 */
    function layoutNodes(nodes) {
      const count = nodes.length;
      const radius = Math.max(40, Math.min(VIEW_WIDTH, VIEW_HEIGHT) / 2 - NODE_RADIUS - 18);
      return nodes.map((node, index) => {
        const angle = (2 * Math.PI * index) / Math.max(1, count) - Math.PI / 2;
        return {
          id: node.id,
          label: node.label ?? node.id,
          description: node.description ?? "",
          x: VIEW_WIDTH / 2 + (count === 1 ? 0 : radius * Math.cos(angle)),
          y: VIEW_HEIGHT / 2 + (count === 1 ? 0 : radius * Math.sin(angle)),
        };
      });
    }

    /** 端点圆环之间的有向线段，箭头作为端点处的多边形画出，避免多张卡共享 marker id。 */
    function edgeGeometry(from, to) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const tipX = to.x - ux * NODE_RADIUS;
      const tipY = to.y - uy * NODE_RADIUS;
      return {
        x1: from.x + ux * NODE_RADIUS,
        y1: from.y + uy * NODE_RADIUS,
        x2: tipX,
        y2: tipY,
        arrow: [tipX, tipY, tipX - ux * 9 - uy * 4.5, tipY - uy * 9 + ux * 4.5, tipX - ux * 9 + uy * 4.5, tipY - uy * 9 - ux * 4.5].join(" "),
      };
    }

    /** 插件自持的只读路由前缀：与 host 半的 ROUTE_PREFIX 是同一个约定。 */
    const ROUTE_PREFIX = "/mechanics";
    /** 预览页可以覆盖基址；正常运行时就是同源宿主。 */
    const routeBase = () => (typeof window !== "undefined" && typeof window.__MECHANICS_ROUTE_BASE__ === "string" ? window.__MECHANICS_ROUTE_BASE__ : typeof location !== "undefined" ? location.origin : "");

    /**
     * 从冻结的调用参数里取 conceptIds。Code Mode 下卡片拿不到 presentationMeta，
     * 只能靠参数与 owner props 里的 cwd 去插件自己的只读路由取同一份投影。
     */
    function conceptIdsFromArgs(argsRaw) {
      if (typeof argsRaw !== "string" || argsRaw.length === 0) return undefined;
      try {
        const ids = JSON.parse(argsRaw)?.conceptIds;
        return Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === "string" && id.length > 0) ? ids : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * 冻结切片 → 卡模型。三种态度分得清：还没结算 = running；结算了但没带载荷 = unavailable
     * （Code Mode 的子调用按契约不带 presentationMeta，卡不能假装"还在读取"）；有载荷 = ready。
     */
    function graphCardModel(block) {
      const settled = block && block.kind === "tool-result";
      const meta = settled && block.meta && typeof block.meta === "object" ? block.meta : null;
      if (meta === null || !Array.isArray(meta.nodes)) {
        return { state: settled ? "unavailable" : "running", nodes: [], edges: [], conceptIds: [] };
      }
      return {
        state: "ready",
        revision: typeof meta.revision === "string" ? meta.revision : "",
        conceptIds: Array.isArray(meta.conceptIds) ? meta.conceptIds : meta.nodes.map((node) => node.id),
        nodes: meta.nodes,
        edges: Array.isArray(meta.edges) ? meta.edges : [],
      };
    }

    /** 检索结果的卡模型：概念详情、候选、双向规则、双概念未解析、未找到，各是一支。 */
    function searchCardModel(block) {
      const settled = block && block.kind === "tool-result";
      const meta = settled && block.meta && typeof block.meta === "object" ? block.meta : null;
      if (meta === null) return { state: settled ? "unavailable" : "running" };
      if (meta.concept) return { state: "ready", kind: "concept", matchedBy: meta.matchedBy ?? "", concept: meta.concept };
      if (meta.rules) return { state: "ready", kind: "rules", from: meta.from, to: meta.to, forward: meta.rules.forward ?? [], reverse: meta.rules.reverse ?? [] };
      if (meta.rules === null) return { state: "ready", kind: "pair-gap", from: meta.from, to: meta.to };
      const resolution = meta.resolution ?? {};
      if (resolution.status === "ambiguous" || resolution.status === "fuzzy") {
        return { state: "ready", kind: "candidates", status: resolution.status, candidates: resolution.candidates ?? [], total: resolution.total ?? (resolution.candidates ?? []).length, truncated: resolution.truncated === true };
      }
      return { state: "ready", kind: "not-found" };
    }

    function GraphCard(props) {
      const model = graphCardModel(props.block);
      const [selectedId, setSelectedId] = React.useState(null);
      // 结算节点的调用头在 call 上（ToolResultNode.call.argsRaw）；running 节点才是顶层的 argsRaw。
      const argsRaw = props.block === undefined || props.block === null
        ? undefined
        : props.block.kind === "tool-result" ? props.block.call && props.block.call.argsRaw : props.block.argsRaw;
      const ids = conceptIdsFromArgs(argsRaw);
      const project = typeof props.cwd === "string" && props.cwd.length > 0 ? props.cwd : undefined;
      // 拿得到 cwd + 稳定 ID 就挂真 widget（网页/MCP 同一份）：样式一致、可缩放平移、hover 出定义与规则。
      const widgetSrc = ids !== undefined && project !== undefined
        ? routeBase() + ROUTE_PREFIX + "/widget?project=" + encodeURIComponent(project) + "&ids=" + encodeURIComponent(ids.join(","))
        : undefined;
      const [widgetHeight, setWidgetHeight] = React.useState(360);
      React.useEffect(() => {
        if (widgetSrc === undefined) return undefined;
        // widget 自报高度：与网页/MCP 里同一条 ui/notifications/size-changed 消息。
        const onMessage = event => {
          const message = event && event.data;
          if (!message || message.jsonrpc !== "2.0" || message.method !== "ui/notifications/size-changed") return;
          const height = message.params && message.params.height;
          if (typeof height === "number" && height > 0) setWidgetHeight(Math.min(720, Math.max(240, Math.round(height))));
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, [widgetSrc]);
      // meta 只在原生顶层调用上存在；卡片主路径是 widget，因此它退到"没有 widget 但有载荷"的 SVG 回退。
      const ready = model.state === "ready" ? { ...model, source: "meta" } : undefined;
      if (widgetSrc !== undefined && model.state !== "running") {
        return h("div", { style: STYLE.card, "data-tool": "mechanics_graph", "data-state": "widget" },
          h("div", { style: STYLE.header },
            h("span", { style: STYLE.title }, "Mechanics 概念图"),
            h("span", { style: STYLE.chip, "data-source": "widget" }, "web widget"),
            h("span", { style: STYLE.muted }, "可滚轮缩放、拖拽平移、悬停看定义与规则")),
          h("iframe", {
            src: widgetSrc,
            title: "Mechanics 概念图",
            style: { width: "100%", height: widgetHeight + "px", border: "0", display: "block", borderRadius: 8 },
          }));
      }
      if (ready === undefined) {
        // 走到这里说明既挂不了 widget（缺 cwd 或调用参数），也没有随结果带来的载荷。
        const line = model.state === "running"
          ? "正在读取工作区…"
          : "本次调用没有可用的图形载荷：既没有随结果带来的数据，也解析不到会话 cwd 与稳定 ID，因此无法挂载 widget。";
        const state = model.state === "running" ? "running" : "unavailable";
        // 说明文字另起一行：横排会让长句在标题旁边挤成两栏。
        return h("div", { style: STYLE.card, "data-tool": "mechanics_graph", "data-state": state },
          h("div", null, h("span", { style: STYLE.title }, "Mechanics 概念图")),
          h("div", { style: { color: STYLE.muted.color, fontSize: STYLE.muted.fontSize, marginTop: 4 } }, line));
      }
      const placed = layoutNodes(ready.nodes);
      const byId = new Map(placed.map((node) => [node.id, node]));
      const selected = selectedId ? placed.find((node) => node.id === selectedId) : null;
      const touching = selected
        ? ready.edges.filter((edge) => edge.source === selected.id || edge.target === selected.id)
        : [];
      return h("div", { style: STYLE.card, "data-tool": "mechanics_graph", "data-state": "ready" },
        h("div", { style: STYLE.header },
          h("span", { style: STYLE.title }, "Mechanics 概念图"),
          h("span", { style: STYLE.muted }, ready.nodes.length + " 个概念 · 集合内 " + ready.edges.length + " 条声明关系"),
          // 来源必须可见：来自调用结果的那份重放一致，实时读取的那份是当下工作区。
          ready.source === "live"
            ? h("span", { style: STYLE.chip, "data-source": "live" }, "实时读取")
            : h("span", { style: STYLE.chip, "data-source": "meta" }, "来自调用结果"),
          ready.revision ? h("span", { style: STYLE.chip }, ready.revision.slice(0, 8)) : null),
        h("svg", { viewBox: "0 0 " + VIEW_WIDTH + " " + VIEW_HEIGHT, style: STYLE.svg, role: "img", "aria-label": "Mechanics 概念局部图" },
          ready.edges.map((edge) => {
            const from = byId.get(edge.source);
            const to = byId.get(edge.target);
            if (!from || !to) return null;
            const geometry = edgeGeometry(from, to);
            const title = [from.label + " " + operatorOf(edge) + " " + to.label, qualifierText(edge), edge.ruleText ?? ""].filter(Boolean).join("\n");
            return h("g", { key: edge.id },
              h("line", { x1: geometry.x1, y1: geometry.y1, x2: geometry.x2, y2: geometry.y2, stroke: colorOf(edge), strokeWidth: 1.5, markerEnd: "none" }),
              h("polygon", { points: geometry.arrow, fill: colorOf(edge) },
                h("title", null, title)));
          }),
          placed.map((node) => h("g", { key: node.id, onClick: () => setSelectedId(selectedId === node.id ? null : node.id), style: { cursor: "pointer" } },
            h("circle", { cx: node.x, cy: node.y, r: NODE_RADIUS, fill: selectedId === node.id ? "var(--dsw-alias-markdown-code-block, rgba(128,128,128,.22))" : "var(--dsw-alias-bg-elevated, rgba(128,128,128,.1))", stroke: selectedId === node.id ? "var(--dsw-alias-label-secondary, #6b7280)" : "var(--dsw-alias-border-l1, rgba(128,128,128,.4))", strokeWidth: 1 },
              h("title", null, node.label + "\n" + truncate(node.description, 160))),
            h("text", { x: node.x, y: node.y, style: STYLE.nodeLabel }, truncate(node.label, 5))))),
        selected
          ? h("div", { style: STYLE.detail },
            h("div", null, h("strong", null, selected.label), " ", h("span", { style: STYLE.chip }, selected.id)),
            h("div", null, selected.description || "（未填写定义）"),
            touching.length
              ? h("div", { style: { marginTop: 6 } }, touching.map((edge) => h("div", { key: edge.id },
                (byId.get(edge.source)?.label ?? edge.source) + " " + operatorOf(edge) + " " + (byId.get(edge.target)?.label ?? edge.target) + (edge.ruleText ? "：" + edge.ruleText : ""))))
              : h("div", { style: STYLE.muted }, "集合内部没有与它相连的声明关系。"))
          : h("div", { style: STYLE.muted }, "点击节点查看定义与集合内关系；关系文字在箭头上悬停可见。"));
    }

    function SearchCard(props) {
      const model = searchCardModel(props.block);
      if (model.state !== "ready") {
        const line = model.state === "running"
          ? "正在读取工作区…"
          : "本次调用没有携带卡片载荷（Code Mode 的子调用不带 presentationMeta）。";
        return h("div", { style: STYLE.card, "data-tool": "mechanics_search", "data-state": model.state },
          h("div", null, h("span", { style: STYLE.title }, "Mechanics 检索")),
          h("div", { style: { color: STYLE.muted.color, fontSize: STYLE.muted.fontSize, marginTop: 4 } }, line));
      }
      const head = (label, extra) => h("div", { style: STYLE.header }, h("span", { style: STYLE.title }, label), extra ? h("span", { style: STYLE.muted }, extra) : null);
      if (model.kind === "concept") {
        return h("div", { style: STYLE.card, "data-tool": "mechanics_search" },
          head("Mechanics 概念", model.matchedBy ? "按 " + model.matchedBy + " 精确命中" : ""),
          h("div", null, h("strong", null, model.concept.label), " ", h("span", { style: STYLE.chip }, model.concept.id)),
          h("div", { style: STYLE.detail }, model.concept.description || "（未填写定义）"));
      }
      if (model.kind === "rules") {
        return h("div", { style: STYLE.card, "data-tool": "mechanics_search" },
          head(model.from.label + " ↔ " + model.to.label, "双向直接声明规则"),
          h("div", { style: STYLE.detail },
            model.forward.length ? model.forward.map((edge) => h("div", { key: "f" + edge.id }, model.from.id + " " + edge.operator + " " + model.to.id + (edge.ruleText ? "：" + edge.ruleText : ""))) : h("div", { style: STYLE.muted }, "正向：无声明规则"),
            model.reverse.length ? model.reverse.map((edge) => h("div", { key: "r" + edge.id }, model.to.id + " " + edge.operator + " " + model.from.id + (edge.ruleText ? "：" + edge.ruleText : ""))) : h("div", { style: STYLE.muted }, "反向：无声明规则")));
      }
      if (model.kind === "pair-gap") {
        const side = (label, result) => h("div", { style: STYLE.row }, h("span", { style: STYLE.chip }, label), h("span", null, result?.status ?? "not_found"));
        return h("div", { style: STYLE.card, "data-tool": "mechanics_search" },
          head("双概念检索未完成", "两端都必须精确解析成稳定 ID"),
          side("from", model.from), side("to", model.to));
      }
      if (model.kind === "candidates") {
        return h("div", { style: STYLE.card, "data-tool": "mechanics_search" },
          head(model.status === "ambiguous" ? "同名或同别名歧义" : "精确未命中的模糊候选",
            model.candidates.length + "/" + model.total + (model.truncated ? "（已截断）" : "")),
          h("div", { style: STYLE.muted }, "候选只是线索：用其中的稳定 ID 调用 mechanics_graph 才能成图。"),
          model.candidates.map((item) => h("div", { key: item.id, style: STYLE.row },
            h("span", { style: STYLE.chip }, item.id),
            h("span", null, item.label),
            h("span", { style: STYLE.muted }, (item.matchedBy ?? []).join("+") + (item.score === undefined ? "" : " · " + item.score)))));
      }
      return h("div", { style: STYLE.card, "data-tool": "mechanics_search" },
        head("Mechanics 检索"),
        h("div", { style: STYLE.muted }, "没有找到对应概念：JSON 模型没有提供证据，这不证明游戏中不存在该机制。"));
    }


    // ---- 收尾消息上的常驻 widget ----
    // 工具卡属于"工具活动"，完成的轮次折叠后会被收进 "Worked for …" 那一行；
    // 不用收尾席位（那条路要跨过轮次折叠与 seq 边界）：直接产出一个自己的 Chat 节点。
    const WIDGET_NODE_KIND = "mechanics-widget";
    const GRAPH_TOOL_NAME = "mechanics_graph";

    /** 调用参数里的 conceptIds：原生调用是 JSON 字符串，Code Mode 子派发已经是对象。 */
    function idsFromCallArguments(value) {
      let parsed = value;
      if (typeof value === "string") {
        try {
          parsed = JSON.parse(value);
        } catch {
          return undefined;
        }
      }
      const ids = parsed && parsed.conceptIds;
      return Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === "string" && id.length > 0) ? ids : undefined;
    }

    /**
     * 以**一次工具调用**为上下文产出 widget 节点（不再按轮次聚合）。
     *
     * Code Mode 的子派发事件里没有 turn 字段，按 turn 路由会全部落进空 id 的上下文，于是永远产不出节点
     * ——这正是上一版在浏览器里什么都看不到的原因。改为：起点是 run_code（Code Mode）或 mechanics_graph
     * （原生）的 tool/call（它带 turn，因此 location 就落在正确的轮次/步骤里），子派发按 rootCallId 归到同一上下文。
     */
    const RUN_CODE_NAME = "run_code";
    const mechanicsTurnDefinition = {
      kind: WIDGET_NODE_KIND,
      // 与 fold-end 同形：target 决定这些节点发布到哪个视图（chat）。
      target: "chat",
      match: event => {
        if (event.type === "tool/call") {
          const name = String(event.data?.name ?? "");
          if (name === GRAPH_TOOL_NAME || name === RUN_CODE_NAME) return { id: String(event.data.callId), role: "start" };
          return null;
        }
        if (event.type === "tool/code-dispatch") {
          const root = String(event.data?.rootCallId ?? event.data?.parentCallId ?? "");
          return root.length > 0 ? { id: root, role: "update" } : null;
        }
        if (event.type === "tool/result") {
          const callId = String(event.data?.message?.source?.callId ?? "");
          return callId.length > 0 ? { id: callId, role: "update" } : null;
        }
        return null;
      },
      start: (_context, match) => ({
        callId: String(match.event.data.callId),
        // 原生调用：参数就在这次 tool/call 上，结果到达时与它配对。
        ids: idsFromCallArguments(match.event.data.arguments),
        latest: undefined,
      }),
      update: (context, match) => {
        const state = context.state;
        const data = match.event?.data ?? {};
        if (match.event.type === "tool/code-dispatch") {
          if (String(data.name ?? "") !== GRAPH_TOOL_NAME || data.isError === true) return state;
          const ids = idsFromCallArguments(data.arguments);
          return ids === undefined ? state : { ...state, latest: { seq: match.event.seq, ids } };
        }
        // 原生：这次 tool/result 就是本上下文那次调用的结果，失败不产出节点。
        if (data?.message?.content?.[0]?.isError === true) return state;
        return state.ids === undefined ? state : { ...state, latest: { seq: match.event.seq, ids: state.ids } };
      },
      // 自产一个 Chat 节点：这个 kind 不在 dsh-fold-turns 的已知表里，它遇到未知节点会整轮 fail-open，
      // 因此 widget 不会被折进 "Worked for …"，也不必挤在工具卡/代码块的窄宽度里。
      buildViewNode: context => {
        const state = context.state;
        if (state === undefined || state.latest === undefined) return null;
        const location = context.start?.location ?? context.matches?.[0]?.location ?? { kind: "unresolved" };
        return {
          key: context.key,
          kind: WIDGET_NODE_KIND,
          id: context.id,
          target: "chat",
          // 紧跟在结算之后，让图和产生它的那次调用挨着。
          anchorSeq: state.latest.seq + 0.001,
          location,
          visibility: "visible",
          data: { seq: state.latest.seq, ids: state.latest.ids },
        };
      },
    };

    /**
     * 流里的 Mechanics widget 节点：项目根由会话所属 workspace 解析（节点数据里只有稳定 ID）。
     * 每一环断裂都在节点里写清楚，不让"没解析出工作区""参数里没有成图"长得一样。
     */
    function MechanicsWidgetNode(props) {
      const node = props.node;
      const matched = node === undefined || node === null ? null : node.data;
      const useWorkspaces = props.useWorkspaces;
      const sessionId = props.sessionId;
      const project = typeof useWorkspaces === "function" && sessionId !== undefined
        ? useWorkspaces(state => {
          const items = (state && state.items) || [];
          const owner = items.find(item => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId));
          return owner === undefined ? undefined : owner.path;
        })
        : undefined;
      const [height, setHeight] = React.useState(360);
      React.useEffect(() => {
        const onMessage = event => {
          const message = event && event.data;
          if (!message || message.jsonrpc !== "2.0" || message.method !== "ui/notifications/size-changed") return;
          const reported = message.params && message.params.height;
          if (typeof reported === "number" && reported > 0) setHeight(Math.min(720, Math.max(240, Math.round(reported))));
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, []);
      // 没有成图的轮次不会产生这个节点；这里是防御性分支，不再当作正常路径。
      if (matched === null || matched === undefined) return null;
      const note = line => h("div", { style: STYLE.card, "data-tool": "mechanics_graph", "data-state": "turn-widget-unavailable" },
        h("div", null, h("span", { style: STYLE.title }, "Mechanics 概念图")),
        h("div", { style: { color: STYLE.muted.color, fontSize: STYLE.muted.fontSize, marginTop: 4 } }, line));
      // 每一环断裂都在收尾处写清楚，不让"没折叠到""没解析出工作区""没有成图"长得一样。
      if (!Array.isArray(matched.ids) || matched.ids.length === 0) {
        return note("这个节点没有拿到可渲染的稳定概念 ID，因此没有 widget。");
      }
      if (typeof project !== "string" || project.length === 0) {
        return note("解析不到该会话所属的工作区目录（session " + String(sessionId) + "），因此无法挂载 widget。");
      }
      const src = routeBase() + ROUTE_PREFIX + "/widget?project=" + encodeURIComponent(project) + "&ids=" + encodeURIComponent(matched.ids.join(","));
      return h("div", { style: STYLE.card, "data-tool": "mechanics_graph", "data-state": "turn-widget" },
        h("div", { style: STYLE.header },
          h("span", { style: STYLE.title }, "Mechanics 概念图"),
          h("span", { style: STYLE.chip, "data-source": "widget" }, "web widget"),
          h("span", { style: STYLE.muted }, matched.ids.length + " 个概念 · 可缩放平移、悬停看定义与规则")),
        h("iframe", { src, title: "Mechanics 概念图", style: { width: "100%", height: height + "px", border: "0", display: "block", borderRadius: 8 } }));
    }

    // 工具行只保留检索卡：机制图由上面那个独立节点承载，否则同一张图会在工具行和节点里各出现一次。
    // GraphCard 仍然是可用的后备视图（无 widget 环境），只是当前不注册。
    const VIEWS = [
      { key: "mechanics_search", component: SearchCard },
    ];

    /** 只注册工具卡视图；不订阅会话事件、不重建 transcript、不读会话服务。 */
    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      for (const view of VIEWS) {
        slots.inject("tool.call.toolview", () => slots.register({ name: "tool.call.toolview", key: view.key }, view.component));
      }
      // 按轮次折叠图卡数据（服务缺失时自动降级：select 拿不到数据就不占用收尾席位）。
      const conversationEvents = ctx.get("conversationEvents");
      if (conversationEvents !== undefined && typeof conversationEvents.register === "function") {
        conversationEvents.register(mechanicsTurnDefinition);
      }
      // 自己的节点类型：流里独立一格，宽度不受工具卡限制，也不会被折叠插件收走。
      slots.inject("conversation.chat.node", () => slots.register({ name: "conversation.chat.node", key: WIDGET_NODE_KIND }, MechanicsWidgetNode));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.GraphCard = GraphCard;
    exports.SearchCard = SearchCard;
    exports.graphCardModel = graphCardModel;
    exports.searchCardModel = searchCardModel;
    exports.conceptIdsFromArgs = conceptIdsFromArgs;
    exports.idsFromCallArguments = idsFromCallArguments;
    exports.mechanicsTurnDefinition = mechanicsTurnDefinition;
    exports.MechanicsWidgetNode = MechanicsWidgetNode;
    exports.WIDGET_NODE_KIND = WIDGET_NODE_KIND;
    exports.layoutNodes = layoutNodes;
    exports.edgeGeometry = edgeGeometry;
    return module.exports;
  },
});
