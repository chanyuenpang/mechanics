import { resolveProjectRoot, resolveSessionDirectory, runWorkspaceTool } from './workspace-tool.mjs';
import { buildWidgetPayload, loadWidgetSupport, readWidgetAssets, renderWidgetErrorHtml, renderWidgetHtml } from './widget.mjs';

/** Cordis 插件名。 */
export const name = 'mechanics';
/**
 * 硬依赖：tools 用于注册工具，subprocess 用于按 argv 直跑项目内受管工具
 * （不经过 shell，因此没有引用与转义问题）。
 */
export const inject = ['tools', 'subprocess'];
/** 一次工具调用的协作式预算：实现把 exec.signal 一路传给 spawn。 */
const TOOL_TIMEOUT_MS = 20_000;
/** 单张图卡的概念上限：超限显式失败，绝不悄悄截断投影。 */
export const MAX_GRAPH_CONCEPTS = 64;

const text = value => [{ type: 'text', text: value }];
const operator = edge => (edge.relation === 'specializes' ? 'is-a>' : edge.sign === 1 ? '+>' : edge.sign === -1 ? '->' : '?>');
const qualifiers = edge => {
  const parts = [];
  if (Array.isArray(edge.sourceQualifiers) && edge.sourceQualifiers.length) parts.push('source 限定：' + edge.sourceQualifiers.join('、'));
  if (Array.isArray(edge.targetQualifiers) && edge.targetQualifiers.length) parts.push('target 限定：' + edge.targetQualifiers.join('、'));
  return parts.length ? '（' + parts.join('；') + '）' : '';
};
const renderRule = edge => {
  const head = `- ${edge.source} ${operator(edge)} ${edge.target}${qualifiers(edge)}`;
  return edge.ruleText ? `${head}：${edge.ruleText}` : head;
};

/** search 结果的模型可见文本：只给结论与候选，不倾倒原始 JSON。 */
export function renderSearchResult(args, value) {
  // 项目内工具不回显 query，调用参数是权威来源（重放时同样来自冻结的调用参数）。
  const query = typeof value.query === 'string' ? value.query : typeof args?.query === 'string' ? args.query : '';
  if (value.concept) {
    return text(`概念 ${value.concept.id}（${value.concept.label}），按 ${value.matchedBy} 精确命中：\n${value.concept.description}`);
  }
  if (value.rules) {
    // 成对规则的端点来自结果的 from/to：工具返回的规则 DTO 只有 { id, operator, ruleText, origin }。
    const pairRule = (source, target) => edge => `- ${source.id} ${edge.operator} ${target.id}${edge.ruleText ? `：${edge.ruleText}` : ''}`;
    const forward = value.rules.forward.map(pairRule(value.from, value.to));
    const reverse = value.rules.reverse.map(pairRule(value.to, value.from));
    return text([
      `${value.from.id}（${value.from.label}）↔ ${value.to.id}（${value.to.label}）的直接声明规则：`,
      forward.length ? '正向：\n' + forward.join('\n') : '正向：无声明规则',
      reverse.length ? '反向：\n' + reverse.join('\n') : '反向：无声明规则',
    ].join('\n'));
  }
  if (value.rules === null) {
    const side = (label, key, result) => {
      const status = result?.status ?? 'not_found';
      const candidates = status === 'ambiguous' && Array.isArray(result.candidates)
        ? `（候选：${result.candidates.map(item => item.id).join('、')}）`
        : '';
      return `- ${label} “${key}”：${status}${candidates}`;
    };
    return text([
      '双概念检索未完成：两端都必须精确解析成稳定 ID，任何一端未解析都不会给出规则。',
      side('from', args?.from ?? '', value.from),
      side('to', args?.to ?? '', value.to),
      '先用 query 形式分别消歧，再用稳定 ID 重试。',
    ].join('\n'));
  }
  const resolution = value.resolution ?? {};
  if (resolution.status === 'ambiguous' || resolution.status === 'fuzzy') {
    const header = resolution.status === 'ambiguous'
      ? `“${query}”是同名或同别名歧义，候选如下；必须选用其中一个稳定 ID 再查一次：`
      : `“${query}”没有精确命中，以下为模糊候选（${resolution.candidates.length}/${resolution.total}${resolution.truncated ? '，已截断' : ''}）；候选只是线索，必须用其中的稳定 ID 再查一次，工具不会替你消歧：`;
    return text([header, ...resolution.candidates.map(item => `- ${item.id}（${item.label}） ${item.matchedBy.join('+')} score=${item.score}`)].join('\n'));
  }
  return text(`没有找到概念“${query}”：JSON 模型没有提供对应证据，这不证明游戏中不存在该机制。`);
}

/** graph 结果的模型可见文本：概念与集合内关系清单，图形细节留在卡上。 */
export function renderGraphResult(_args, value) {
  const nodes = value.nodes.map(node => `- ${node.id}（${node.label}）`);
  const edges = value.edges.map(renderRule);
  return text([
    `${value.nodes.length} 个概念、集合内部 ${value.edges.length} 条声明关系（rev ${String(value.revision).slice(0, 12)}）：`,
    nodes.join('\n'),
    value.edges.length ? '集合内声明关系：\n' + edges.join('\n') : '集合内部没有声明关系。',
  ].join('\n'));
}

// 根必须是 type: "object"：模型提供方按 OpenAI 风格的 function schema 校验，
// 根级 oneOf（DSH 自己的校验器接受）会被它拒成 'type: null'。两种调用形式的互斥
// 因此由 execute 校验——失败是显式的 TOOL_INVALID，不静默放行。
const searchParameters = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '概念键：稳定 ID、完整名称或完整别名；精确未命中时返回模糊候选。与 from+to 二选一' },
    from: { type: 'string', description: '起点概念键；必须与 to 同时给出，此时不要传 query' },
    to: { type: 'string', description: '终点概念键；必须与 from 同时给出，此时不要传 query' },
  },
  additionalProperties: false,
};

const graphParameters = {
  type: 'object',
  properties: {
    conceptIds: {
      type: 'array',
      items: { type: 'string' },
      description: '已经消歧的稳定概念 ID 数组（非空、无重复）；不接受名称、别名或搜索词',
    },
  },
  required: ['conceptIds'],
  additionalProperties: false,
};

const output = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  render,
  // 卡片数据就是工具的 JSON 结果本身：投影形状由 workspace-tool.mjs 拥有，插件不复制一份。
  presentationMeta: (_args, value) => value,
});

/** 解析一次调用要用的项目根；解析不到就显式失败。 */
async function projectRootFor(exec) {
  const directory = resolveSessionDirectory(exec?.agent);
  if (directory === undefined) {
    throw Object.assign(new Error('无法从调用会话解析工作目录，mechanics 工具需要一个已绑定工作区的会话。'), { code: 'SESSION_CWD_UNAVAILABLE' });
  }
  const projectRoot = await resolveProjectRoot(directory);
  if (projectRoot === undefined) {
    throw Object.assign(new Error(`会话目录 ${directory} 及其父目录中没有 .mechanics/workspace.json：该项目尚未初始化 Mechanics 工作区。`), { code: 'WORKSPACE_NOT_FOUND' });
  }
  return projectRoot;
}

function searchArguments(args) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  const from = typeof args?.from === 'string' ? args.from.trim() : '';
  const to = typeof args?.to === 'string' ? args.to.trim() : '';
  if (query) {
    if (from || to) throw Object.assign(new Error('mechanics_search 只能使用 query 或 from+to 之一。'), { code: 'TOOL_INVALID' });
    return ['search', '--query', query];
  }
  if (from && to) return ['search', '--from', from, '--to', to];
  throw Object.assign(new Error('mechanics_search 需要 query，或同时提供 from 与 to。'), { code: 'TOOL_INVALID' });
}

function graphArguments(args) {
  const conceptIds = args?.conceptIds;
  if (!Array.isArray(conceptIds) || conceptIds.length === 0) {
    throw Object.assign(new Error('mechanics_graph 需要非空的 conceptIds 数组。'), { code: 'TOOL_INVALID' });
  }
  const cleaned = conceptIds.map(item => (typeof item === 'string' ? item.trim() : ''));
  if (cleaned.some(item => !item)) throw Object.assign(new Error('conceptIds 每一项都必须是非空字符串。'), { code: 'TOOL_INVALID' });
  const duplicate = cleaned.filter((item, position) => cleaned.indexOf(item) !== position);
  if (duplicate.length) throw Object.assign(new Error('conceptIds 不能重复：' + [...new Set(duplicate)].join('、')), { code: 'TOOL_INVALID' });
  if (cleaned.length > MAX_GRAPH_CONCEPTS) {
    throw Object.assign(new Error(`一次最多渲染 ${MAX_GRAPH_CONCEPTS} 个概念，收到 ${cleaned.length} 个；请缩小集合。`), { code: 'TOOL_INVALID' });
  }
  return ['graph', '--ids', cleaned.join(',')];
}

/** 插件自持的只读路由前缀：卡片用它补上 presentationMeta 覆盖不到的场景（Code Mode 子派发）。 */
export const ROUTE_PREFIX = '/mechanics';

const respond = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
};

const respondHtml = (res, status, html) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
};

/**
 * 只读路由：`GET /mechanics/graph?project=<项目目录>&ids=<conceptIds>`。
 * 它只服务含 `.mechanics/workspace.json` 的项目、只返回与 mechanics_graph 相同的投影，
 * 不提供任意文件读取；它没有调用者身份，因此只适用于绑回环地址的部署。
 * @param runtime - 子进程 seam；路由按 argv 直跑项目内受管工具。
 * @returns node:http 兼容的请求处理器。
 */
export function createRouteHandler(runtime) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      respond(res, 400, { error: 'BAD_REQUEST', message: '请求 URL 无法解析' });
      return;
    }
    if (req.method !== 'GET') {
      respond(res, 405, { error: 'METHOD_NOT_ALLOWED', message: ROUTE_PREFIX + ' 只支持 GET' });
      return;
    }
    const isGraph = url.pathname === ROUTE_PREFIX + '/graph';
    const isWidget = url.pathname === ROUTE_PREFIX + '/widget';
    if (!isGraph && !isWidget) {
      respond(res, 404, { error: 'NOT_FOUND', message: '未知路由：' + url.pathname });
      return;
    }
    const project = (url.searchParams.get('project') ?? '').trim();
    const rawIds = (url.searchParams.get('ids') ?? '').trim();
    if (!project || !rawIds) {
      respond(res, 400, { error: 'BAD_REQUEST', message: '需要 project 与 ids 两个查询参数' });
      return;
    }
    const conceptIds = rawIds.split(',').map(item => item.trim()).filter(Boolean);
    try {
      const projectRoot = await resolveProjectRoot(project);
      if (projectRoot === undefined) {
        const message = `目录 ${project} 及其父目录中没有 .mechanics/workspace.json`;
        if (isWidget) respondHtml(res, 404, renderWidgetErrorHtml('WORKSPACE_NOT_FOUND', message));
        else respond(res, 404, { error: 'WORKSPACE_NOT_FOUND', message });
        return;
      }
      if (isWidget) {
        // 网页/MCP 用的同一份 widget：由插件把载荷注进页面，缩放、平移与 hover 都是它自带的。
        // 资产每次现读：mechanics 侧改了 widget，这里下一次请求就同步，不需要重启宿主。
        const root = (await loadWidgetSupport()).root;
        respondHtml(res, 200, renderWidgetHtml(await readWidgetAssets(root), await buildWidgetPayload(projectRoot, conceptIds)));
        return;
      }
      // 与工具同一条路径、同一份形状：投影仍由 workspace-tool.mjs 独有。
      respond(res, 200, await runWorkspaceTool(runtime, projectRoot, graphArguments({ conceptIds }), undefined));
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'ROUTE_FAILED';
      const status = code === 'NODE_NOT_FOUND' || code === 'TOOL_INVALID' ? 400 : code === 'WORKSPACE_NOT_FOUND' ? 404 : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (isWidget) respondHtml(res, status, renderWidgetErrorHtml(code, message));
      else respond(res, status, { error: code, message, ...(error?.details === undefined ? {} : { details: error.details }) });
    }
  };
}

/**
 * 注册 mechanics 的只读工具。
 * @param ctx - 挂载作用域的 Cordis 上下文。
 */
export function apply(ctx) {
  const tools = ctx.get('tools');
  const runtime = ctx.get('subprocess');
  if (tools === undefined || runtime === undefined) return;
  const run = (exec, argv) => projectRootFor(exec).then(projectRoot => runWorkspaceTool(runtime, projectRoot, argv, exec?.signal));
  tools.register({
    name: 'mechanics_search',
    description: [
      '在项目 .mechanics 工作区检索概念与声明规则，直接读取已保存的 JSON，不依赖 CLI、网页或 HTTP 服务。',
      'query 先精确解析稳定 ID、完整名称与完整别名；精确未命中时才返回模糊候选（部分名称、别名、ID、描述），候选只是线索，必须用其中的稳定 ID 再查一次，工具不会自动消歧。',
      'from+to 走精确双概念解析，返回 A→B 与 B→A 的直接声明规则。',
      '需要看结构时用 mechanics_graph：它会把概念与集合内关系渲染成对话流里的图卡。',
    ].join(' '),
    parameters: searchParameters,
    output: output(renderSearchResult),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return run(exec, searchArguments(args));
    },
  });
  tools.register({
    name: 'mechanics_graph',
    description: [
      '渲染一组已经消歧的稳定概念 ID 及其集合内部的声明关系，并在对话流里生成一张只读概念图卡。',
      '只接受 conceptIds（稳定 ID 数组，非空、无重复、最多 ' + MAX_GRAPH_CONCEPTS + ' 个）；不接受名称、别名或搜索词，不做搜索、路径补全或推导。',
      '结果同时包含概念详情与集合内规则；卡上可查看 hover 详情，模型只读到清单文本。',
    ].join(' '),
    parameters: graphParameters,
    output: output(renderGraphResult),
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return run(exec, graphArguments(args));
    },
  });
  // 只读路由依赖 webServer，但它是可选能力：headless / TUI 组合没有这个服务。
  // 因此用 ctx.inject 等它挂载：硬 inject 会让没有 web 的组合永远挂起，而在 apply 里
  // 一次性 ctx.get 又会在服务尚未挂载时注册不上——那正是上一版路由 404 的原因。
  let routeDisposer;
  const registerRoute = scope => {
    const webServer = scope.get('webServer');
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    // 服务被替换时 inject 会重跑：先撤掉上一次注册，避免重复路径冲突。
    if (typeof routeDisposer === 'function') routeDisposer();
    routeDisposer = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createRouteHandler(runtime) });
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerRoute);
  else registerRoute(ctx);
}
