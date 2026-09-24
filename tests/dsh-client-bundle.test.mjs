import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const bundlePath = fileURLToPath(new URL('../packages/dsh-adapter/lib/client.js', import.meta.url));

// 最小 React 替身：够调用组件本身（createElement 产出可遍历的元素树，useState 有真实可写的槽）。
function createReact() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      const set = value => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      };
      return [slots[index], set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    // 只实现测试需要的部分：记录副作用，由测试显式触发，并等一轮微任务让 fetch 结算。
    useEffect(callback) {
      effects.push(callback);
    },
    beginRender() {
      cursor = 0;
      effects.length = 0;
    },
    async runEffects() {
      const pending = effects.splice(0);
      for (const callback of pending) callback();
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  };
}

/** 按 lazy-CJS 契约装载 bundle：只执行注册，再物化 factory。 */
// 最小 window：注册面 + 消息事件（widget 高度就靠 postMessage 回来）。
function createWindow() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    },
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

async function loadBundle(options = {}) {
  const registrations = [];
  const windowShim = createWindow();
  windowShim.__ModuleLoader__ = { load: registration => registrations.push(registration) };
  if (options.routeBase !== undefined) windowShim.__MECHANICS_ROUTE_BASE__ = options.routeBase;
  const context = vm.createContext({
    window: windowShim,
    location: { origin: options.origin ?? 'http://127.0.0.1:3080' },
    fetch: options.fetch ?? (() => Promise.reject(new Error('测试未提供 fetch'))),
  });
  new vm.Script(await readFile(bundlePath, 'utf8'), { filename: bundlePath }).runInContext(context);
  assert.equal(registrations.length, 1, 'bundle 必须只注册一次');
  const registration = registrations[0];
  const react = createReact();
  const moduleExports = registration.factory(name => {
    if (name === 'react') return react;
    throw new Error('bundle 请求了未声明的模块：' + name);
  });
  return { registration, react, moduleExports, window: windowShim };
}

const settled = meta => ({ kind: 'tool-result', callId: 'c1', meta });
const running = () => ({ callId: 'c1', name: 'mechanics_graph', argsRaw: '{"conceptIds":["a"]}' });

/** 深度遍历元素树，收集满足断言的节点。 */
function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found);
    return found;
  }
  if (predicate(node)) found.push(node);
  collect(node.children, predicate, found);
  return found;
}

const graphMeta = {
  revision: 'r'.repeat(40),
  conceptIds: ['turn', 'draw'],
  nodes: [
    { id: 'turn', label: '回合', description: '按行动顺序轮到尚未倒下的战斗参与者。' },
    { id: 'draw', label: '抽牌行动', description: '从牌库抽取卡牌并放入手牌的动作。' },
  ],
  edges: [{ id: 'turn-2-draw', source: 'turn', target: 'draw', relation: 'influence', sign: 1, ruleText: '回合开始时启动抽牌', targetQualifiers: ['控制角色'] }],
};

test('bundle 以 lazy-CJS 契约注册，导出面齐备', async () => {
  const { registration, moduleExports } = await loadBundle();
  assert.equal(registration.id, '@veewo/dsh-mechanics');
  assert.equal(typeof registration.factory, 'function');
  // vm 里的数组来自另一个 realm，断言前摊回宿主 realm。
  assert.deepEqual([...moduleExports.inject], ['slots', 'uiConversation']);
  for (const key of ['apply', 'GraphCard', 'SearchCard', 'graphCardModel', 'searchCardModel', 'layoutNodes', 'edgeGeometry']) {
    assert.equal(typeof moduleExports[key], 'function', key + ' 必须是函数');
  }
});

test('apply 注册两张 keyed 工具卡与 widget 节点，不触及其他 slot', async () => {
  const { moduleExports } = await loadBundle();
  const registered = [];
  const injections = [];
  const definitions = [];
  const ctx = {
    get: name => name === 'slots' ? {
      inject: (slot, callback) => injections.push(slot) && callback(),
      register: (options, component) => registered.push({ options, component }),
    } : undefined,
    uiConversation: { events: { register: definition => {
      if ((definition.target === undefined) !== (definition.buildViewNode === undefined)) {
        throw new Error('conversation Definition "' + definition.kind + '" must declare target and buildViewNode together');
      }
      definitions.push(definition);
    } } },
  };
  moduleExports.apply(ctx);
  // 工具行只留检索卡；机制图走独立节点（两份会重复显示同一张图）。
  assert.deepEqual(registered.map(item => item.options.key ?? item.options.name), ['mechanics_search', 'mechanics-widget']);
  assert.deepEqual([...new Set(registered.map(item => item.options.name))], ['tool.call.toolview', 'conversation.chat.node']);
  assert.deepEqual([...injections], ['tool.call.toolview', 'conversation.chat.node']);
  for (const item of registered) assert.equal(typeof item.component, 'function');
  // 产出节点的定义必须一起注册，否则这个节点永远不会出现在流里。
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].kind, 'mechanics-widget');
  assert.equal(definitions[0].target, 'chat');
  assert.equal(typeof definitions[0].buildViewNode, 'function');
});

test('卡模型区分 running 与 settled，并覆盖检索的五支', async () => {
  const { moduleExports } = await loadBundle();
  const idle = moduleExports.graphCardModel(running());
  assert.equal(idle.state, 'running');
  assert.deepEqual([...idle.nodes], []);
  assert.deepEqual([...idle.conceptIds], []);
  const ready = moduleExports.graphCardModel(settled(graphMeta));
  assert.equal(ready.state, 'ready');
  assert.deepEqual([...ready.conceptIds], ['turn', 'draw']);
  assert.equal(ready.edges.length, 1);

  // 已结算但没有载荷 ≠ 仍在读取：Code Mode 的子调用不带 presentationMeta，卡必须如实说。
  assert.equal(moduleExports.graphCardModel(settled(undefined)).state, 'unavailable');
  assert.equal(moduleExports.graphCardModel(settled(null)).state, 'unavailable');
  assert.equal(moduleExports.graphCardModel(settled({ revision: 'r' })).state, 'unavailable');
  assert.equal(moduleExports.searchCardModel(settled(undefined)).state, 'unavailable');

  assert.equal(moduleExports.searchCardModel(running()).state, 'running');
  assert.equal(moduleExports.searchCardModel(settled({ concept: { id: 'turn' }, matchedBy: 'label' })).kind, 'concept');
  assert.equal(moduleExports.searchCardModel(settled({ rules: { forward: [], reverse: [] }, from: { id: 'a' }, to: { id: 'b' } })).kind, 'rules');
  assert.equal(moduleExports.searchCardModel(settled({ rules: null, from: { status: 'not_found' }, to: { status: 'not_found' } })).kind, 'pair-gap');
  const candidates = moduleExports.searchCardModel(settled({ resolution: { status: 'fuzzy', candidates: [{ id: 'turn' }], total: 3, truncated: true } }));
  assert.equal(candidates.kind, 'candidates');
  assert.equal(candidates.status, 'fuzzy');
  assert.equal(candidates.truncated, true);
  assert.equal(moduleExports.searchCardModel(settled({ resolution: { status: 'not_found' } })).kind, 'not-found');
});


test('拿得到会话 cwd 与稳定 ID 时，卡片挂的是网页/MCP 那份真 widget', async () => {
  const { react, moduleExports } = await loadBundle();
  const block = { kind: 'tool-result', callId: 'c9', call: { name: 'mechanics_graph', argsRaw: JSON.stringify({ conceptIds: ['turn', 'draw'] }) } };
  const props = { block, cwd: 'G:/Projects/tiny-world' };
  react.beginRender();
  const card = moduleExports.GraphCard(props);
  // 不再是自绘 SVG：整张卡交给 widget，缩放/平移/hover 都由它提供。
  assert.equal(card.props['data-state'], 'widget');
  const frames = collect(card, node => node.type === 'iframe');
  assert.equal(frames.length, 1);
  assert.match(frames[0].props.src, /\/mechanics\/widget\?project=G%3A%2FProjects%2Ftiny-world&ids=turn%2Cdraw/);
  assert.equal(typeof frames[0].props.style.height, 'string');
  assert.equal(collect(card, node => node.props?.['data-source'] === 'widget').length, 1);
});

test('widget 自报高度会调整 iframe，且解绑监听', async () => {
  const { react, moduleExports, window } = await loadBundle();
  const block = { kind: 'tool-result', callId: 'c12', call: { name: 'mechanics_graph', argsRaw: JSON.stringify({ conceptIds: ['turn'] }) } };
  const props = { block, cwd: 'G:/Projects/tiny-world' };
  react.beginRender();
  moduleExports.GraphCard(props);
  await react.runEffects();
  assert.equal(window.listenerCount('message'), 1);
  // 与网页/MCP 里同一条消息：widget 报高度，卡片据此撑开。
  window.dispatch('message', { data: { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 640 } } });
  react.beginRender();
  const resized = moduleExports.GraphCard(props);
  const frame = collect(resized, node => node.type === 'iframe')[0];
  assert.equal(frame.props.style.height, '640px');
  // 无关消息不得改高度。
  window.dispatch('message', { data: { jsonrpc: '2.0', method: 'ui/notifications/other', params: { height: 120 } } });
  react.beginRender();
  assert.equal(collect(moduleExports.GraphCard(props), node => node.type === 'iframe')[0].props.style.height, '640px');
});

test('既没有 widget 参数也没有载荷时如实说明，不画空图', async () => {
  const { react, moduleExports } = await loadBundle();
  react.beginRender();
  const noArgs = moduleExports.GraphCard({ block: settled(undefined), cwd: 'G:/Projects/tiny-world' });
  assert.equal(noArgs.props['data-state'], 'unavailable');
  assert.equal(collect(noArgs, node => node.type === 'iframe').length, 0);
  assert.equal(collect(noArgs, node => Array.isArray(node.children) && node.children.some(child => typeof child === 'string' && child.includes('无法挂载 widget'))).length, 1);
  // 有载荷但没有 cwd：退到自绘 SVG，并标注来自调用结果。
  const metaOnly = moduleExports.GraphCard({ block: settled(graphMeta) });
  assert.equal(metaOnly.props['data-state'], 'ready');
  assert.equal(collect(metaOnly, node => node.props?.['data-source'] === 'meta').length, 1);
});


test('按调用折叠图卡数据：只有成功的成图才产出节点', async () => {
  const { moduleExports } = await loadBundle();
  const definition = moduleExports.mechanicsTurnDefinition;
  // Code Mode：起点是 run_code 的 tool/call（它带 turn，location 才落得进正确的轮次），子派发按 rootCallId 归位。
  const started = definition.start({}, { event: { type: 'tool/call', seq: 40, data: { turn: 7, callId: 'run1', name: 'run_code', arguments: '{}' } } });
  assert.equal(started.callId, 'run1');
  const dispatch = event => definition.update({ state: started }, { event });
  const pending = { type: 'tool/ptc-dispatch-start', seq: 41, data: { rootCallId: 'run1', subCallId: 'sub1', name: 'mechanics_graph', arguments: { conceptIds: ['turn', 'draw'] } } };
  assert.equal(definition.match(pending), null, '未完成的子调用不应提前展示图卡');
  const completed = { type: 'tool/ptc-dispatch', seq: 42, data: { rootCallId: 'run1', parentCallId: 'run1', subCallId: 'sub1', name: 'mechanics_graph', arguments: { conceptIds: ['turn', 'draw'] }, isError: false, content: [] } };
  const ok = dispatch(completed);
  assert.deepEqual([...ok.latest.ids], ['turn', 'draw']);
  // 失败的成图、别的工具都不产出引用。
  assert.equal(dispatch({ type: 'tool/ptc-dispatch', seq: 43, data: { rootCallId: 'run1', name: 'mechanics_graph', arguments: { conceptIds: ['turn'] }, isError: true } }).latest, undefined);
  assert.equal(dispatch({ type: 'tool/ptc-dispatch', seq: 44, data: { rootCallId: 'run1', name: 'mechanics_search', arguments: { query: 'x' }, isError: false } }).latest, undefined);
  // 路由：子派发没有 turn 字段，必须按 rootCallId 归到发起它的那次调用上（上一版按 turn 路由，永远落进空 id）。
  const routed = definition.match({ type: 'tool/ptc-dispatch', data: { rootCallId: 'run1', name: 'mechanics_graph' } });
  assert.equal(routed.id, 'run1');
  assert.equal(routed.role, 'update');
  assert.equal(definition.match({ type: 'tool/ptc-dispatch', data: { name: 'mechanics_graph' } }), null);
  const startedMatch = definition.match({ type: 'tool/call', data: { callId: 'c9', name: 'run_code', arguments: '{}' } });
  assert.equal(startedMatch.id, 'c9');
  assert.equal(startedMatch.role, 'start');
  assert.equal(definition.match({ type: 'tool/call', data: { callId: 'c9', name: 'some_other_tool', arguments: '{}' } }), null);
  // 产出的是自己的 Chat 节点：独立一格、紧跟在结算之后。
  const context = state => ({ state, key: 'k7', id: '7', start: { location: { kind: 'turn', turn: { turn: 7 } } }, matches: [] });
  const view = definition.buildViewNode(context(ok));
  assert.equal(view.kind, 'mechanics-widget');
  assert.equal(view.target, 'chat');
  assert.equal(view.visibility, 'visible');
  assert.equal(view.anchorSeq, 42.001);
  assert.equal(view.location.turn.turn, 7);
  assert.deepEqual([...view.data.ids], ['turn', 'draw']);
  const next = definition.update({ state: ok }, { event: { type: 'tool/ptc-dispatch', seq: 45, data: { rootCallId: 'run1', subCallId: 'sub2', name: 'mechanics_graph', arguments: { conceptIds: ['pet'] }, isError: false } } });
  const multi = definition.buildViewNode(context(next));
  assert.equal(multi.data.graphs.length, 2, '同一 run_code 的多次成功成图须保留全部交互 widget');
  assert.deepEqual(Array.from(multi.data.graphs, graph => [...graph.ids]), [['turn', 'draw'], ['pet']]);
  assert.equal(multi.anchorSeq, 45.001);
  const rejected = definition.update({ state: next }, { event: { type: 'tool/ptc-dispatch', seq: 46, data: { rootCallId: 'run1', subCallId: 'sub3', name: 'mechanics_graph', arguments: { conceptIds: ['bad'] }, isError: true } } });
  assert.equal(rejected.graphs.length, 2, '失败调用不得清除此前成功的 widget');
  // 没有成图的调用不产生节点：不占流里的位置，也不留噪声。
  assert.equal(definition.buildViewNode(context(started)), null);
});

test('原生调用按 tool/result 配对，失败不产出节点', async () => {
  const { moduleExports } = await loadBundle();
  const definition = moduleExports.mechanicsTurnDefinition;
  let state = definition.start({}, { event: { type: 'tool/call', data: { turn: 3, callId: 'c1', name: 'mechanics_graph', arguments: JSON.stringify({ conceptIds: ['turn'] }) } } });
  const context = state => ({ state, key: 'k3', id: 'c1', start: { location: { kind: 'turn', turn: { turn: 3 } } }, matches: [] });
  // 结果未到：还没有可渲染的成图 → 不产生节点。
  assert.equal(definition.buildViewNode(context(state)), null);
  state = definition.update({ state }, { event: { type: 'tool/result', seq: 90, data: { turn: 3, message: { source: { callId: 'c1' }, content: [{ isError: false }] } } } });
  const view = definition.buildViewNode(context(state));
  assert.equal(view.anchorSeq, 90.001);
  assert.deepEqual([...view.data.ids], ['turn']);
  // 失败的成图不产生节点。
  let failed = definition.start({}, { event: { type: 'tool/call', data: { turn: 4, callId: 'c2', name: 'mechanics_graph', arguments: JSON.stringify({ conceptIds: ['turn'] }) } } });
  failed = definition.update({ state: failed }, { event: { type: 'tool/result', seq: 92, data: { turn: 4, message: { source: { callId: 'c2' }, content: [{ isError: true }] } } } });
  assert.equal(definition.buildViewNode({ state: failed, key: 'k4', id: 'c2', matches: [] }), null);
});

test('widget 节点使用聊天槽位提供的 cwd 构造图页面', async () => {
  const { react, moduleExports } = await loadBundle();
  const cwd = 'G:/Projects/tiny-world/mechanics';
  react.beginRender();
  const rendered = moduleExports.MechanicsWidgetNode({ node: { kind: 'mechanics-widget', data: { ids: ['turn', 'draw'] } }, cwd });
  assert.equal(rendered.props['data-state'], 'turn-widget');
  const frame = collect(rendered, node => node.type === 'iframe')[0];
  assert.match(frame.props.src, /\/mechanics\/widget\?project=G%3A%2FProjects%2Ftiny-world%2Fmechanics&ids=turn%2Cdraw/);
  const hasText = text => node => Array.isArray(node.children) && node.children.some(child => typeof child === 'string' && child.includes(text));
  react.beginRender();
  const noIds = moduleExports.MechanicsWidgetNode({ node: { kind: 'mechanics-widget', data: {} }, cwd });
  assert.equal(noIds.props['data-state'], 'turn-widget-unavailable');
  assert.ok(collect(noIds, hasText('没有拿到可渲染的稳定概念 ID')).length > 0);
  react.beginRender();
  const noProject = moduleExports.MechanicsWidgetNode({ node: { kind: 'mechanics-widget', data: { ids: ['turn'] } } });
  assert.equal(noProject.props['data-state'], 'turn-widget-unavailable');
  assert.ok(collect(noProject, hasText('没有收到会话工作目录 cwd')).length > 0);
});

test('仅有成功 widget 的折叠轮次会通过公开 turnProcess 保持展开', async () => {
  const { react, moduleExports } = await loadBundle();
  const calls = [];
  const turnProcess = { foldable: true, open: false, setOpen: open => calls.push(open) };
  const node = { kind: 'mechanics-widget', data: { ids: ['turn'] } };
  react.beginRender();
  moduleExports.MechanicsWidgetNode({ node, cwd: 'G:/Projects/tiny-world', turnProcess });
  assert.equal(calls.length, 0, '组件 effect 前不应在渲染期间更新宿主状态');
  await react.runEffects();
  assert.deepEqual(calls, [true]);
  react.beginRender();
  moduleExports.MechanicsWidgetNode({ node, cwd: 'G:/Projects/tiny-world', turnProcess: { ...turnProcess, open: true } });
  await react.runEffects();
  assert.deepEqual(calls, [true], '已展开轮次不得反复触发更新');
  react.beginRender();
  moduleExports.MechanicsWidgetNode({ node, turnProcess });
  await react.runEffects();
  assert.deepEqual(calls, [true], '没有 cwd 的 widget 不得强制展开');
  react.beginRender();
  moduleExports.MechanicsWidgetNode({ node: { kind: 'mechanics-widget', data: {} }, cwd: 'G:/Projects/tiny-world', turnProcess });
  await react.runEffects();
  assert.deepEqual(calls, [true], '无成功成图不得强制展开');
  react.beginRender();
  moduleExports.MechanicsWidgetNode({ node, cwd: 'G:/Projects/tiny-world', turnProcess: { ...turnProcess, foldable: false } });
  await react.runEffects();
  assert.deepEqual(calls, [true], '未折叠轮次不需要写入展开状态');
  // 历史回放或手动重新折叠后，成功 widget 仍能恢复可见。
  react.beginRender();
  moduleExports.MechanicsWidgetNode({ node, cwd: 'G:/Projects/tiny-world', turnProcess });
  await react.runEffects();
  assert.deepEqual(calls, [true, true]);
});

test('同一次 run_code 的多个 widget 独立调整各自 iframe 高度', async () => {
  const { react, moduleExports, window } = await loadBundle();
  const node = { kind: 'mechanics-widget', data: { ids: ['pet'], graphs: [
    { key: 'sub1', ids: ['turn', 'draw'] },
    { key: 'sub2', ids: ['pet'] },
  ] } };
  const props = { node, cwd: 'G:/Projects/tiny-world' };
  react.beginRender();
  const rendered = moduleExports.MechanicsWidgetNode(props);
  const frames = collect(rendered, element => element.type === 'iframe');
  assert.equal(frames.length, 2);
  assert.match(frames[0].props.src, /ids=turn%2Cdraw/);
  assert.match(frames[1].props.src, /ids=pet/);
  const sources = [{}, {}];
  frames.forEach((frame, index) => frame.props.ref({ contentWindow: sources[index] }));
  await react.runEffects();
  window.dispatch('message', { source: sources[1], data: { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 620 } } });
  react.beginRender();
  const resized = collect(moduleExports.MechanicsWidgetNode(props), element => element.type === 'iframe');
  assert.equal(resized[0].props.style.height, '360px');
  assert.equal(resized[1].props.style.height, '620px');
  window.dispatch('message', { source: {}, data: { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 700 } } });
  react.beginRender();
  const ignored = collect(moduleExports.MechanicsWidgetNode(props), element => element.type === 'iframe');
  assert.equal(ignored[0].props.style.height, '360px');
  assert.equal(ignored[1].props.style.height, '620px');
});

test('conceptIdsFromArgs 只接受形状正确的调用参数', async () => {
  const { moduleExports } = await loadBundle();
  const parse = moduleExports.conceptIdsFromArgs;
  assert.deepEqual([...parse('{"conceptIds":["turn","draw"]}')], ['turn', 'draw']);
  for (const bad of [undefined, '', 'not json', '{}', '{"conceptIds":[]}', '{"conceptIds":[1]}', '{"conceptIds":[""]}']) {
    assert.equal(parse(bad), undefined, String(bad) + ' 必须被拒');
  }
});

test('布局与箭头几何只依赖节点集合本身', async () => {
  const { moduleExports } = await loadBundle();
  const single = moduleExports.layoutNodes([{ id: 'a', label: 'A' }]);
  assert.equal(single.length, 1);
  const placed = moduleExports.layoutNodes(graphMeta.nodes);
  assert.equal(placed.length, 2);
  for (const node of placed) {
    assert.ok(node.x > 0 && node.x < 520 && node.y > 0 && node.y < 300, '节点必须落在视图内');
  }
  const geometry = moduleExports.edgeGeometry(placed[0], placed[1]);
  const length = Math.hypot(geometry.x2 - geometry.x1, geometry.y2 - geometry.y1);
  assert.ok(length > 0);
  assert.ok(geometry.arrow.split(' ').length === 6, '箭头是三个点的多边形');
});

test('两张卡在真实载荷下渲染且点击节点可展开', async () => {
  const { react, moduleExports } = await loadBundle();
  react.beginRender();
  const graphTree = moduleExports.GraphCard({ block: settled(graphMeta) });
  assert.equal(graphTree.props['data-tool'], 'mechanics_graph');
  const texts = collect(graphTree, node => node.type === 'text').map(node => node.children.join(''));
  assert.deepEqual(texts.sort(), ['回合', '抽牌行动']);
  const clickable = collect(graphTree, node => typeof node.props.onClick === 'function');
  assert.equal(clickable.length, 2);

  clickable[0].props.onClick();
  react.beginRender();
  const expanded = moduleExports.GraphCard({ block: settled(graphMeta) });
  const hasText = text => node => Array.isArray(node.children) && node.children.some(child => typeof child === 'string' && child.includes(text));
  assert.ok(collect(expanded, hasText('按行动顺序轮到尚未倒下的战斗参与者')).length > 0, '点击后必须显示该概念的定义');
  // 关系用概念名而不是稳定 ID：面板不该在悬停已给名字之后再退回 ID。
  assert.ok(collect(expanded, hasText('回合 +> 抽牌行动')).length > 0, '点击后必须列出集合内相关声明关系（概念名）');
  assert.equal(collect(expanded, hasText('turn +> draw')).length, 0, '详情面板不再出现裸 ID 关系');

  react.beginRender();
  const searchTree = moduleExports.SearchCard({ block: settled({ resolution: { status: 'fuzzy', candidates: [{ id: 'turn', label: '回合', matchedBy: ['label-prefix'], score: 100 }], total: 1, truncated: false } }) });
  assert.equal(searchTree.props['data-tool'], 'mechanics_search');
  const chip = collect(searchTree, node => node.type === 'span' && node.children.join('') === 'turn');
  assert.equal(chip.length, 1);
  const notice = collect(searchTree, node => Array.isArray(node.children) && node.children.some(child => typeof child === 'string' && child.includes('候选只是线索')));
  assert.equal(notice.length, 1);
});
