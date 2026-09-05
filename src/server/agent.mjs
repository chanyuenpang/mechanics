import { acquireWorkspaceLock } from './files.mjs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readQuerySnapshot } from './query-snapshot.mjs';
import { findProject } from './workspace-commands.mjs';
import { projectContext } from './project-context.mjs';
import { queryWorkspace, validateQuery, formatQueryText } from '../domain/query.mjs';
import { QUERY_API_VERSION, READING_CONTRACT_VERSION, SEMANTICS_VERSION, queryGuide } from '../domain/query-contract.mjs';
import { createWorkspaceStore, recoverRecipeMigration } from './store.mjs';

export function assertQueryCompatibility(result) {
  if (result?.queryApiVersion !== QUERY_API_VERSION || result.semanticsVersion !== SEMANTICS_VERSION || result.readingContract?.version !== READING_CONTRACT_VERSION) {
    throw Object.assign(new Error('服务端查询协议或语义版本不匹配，请更新并重启服务；未采用旧版结果'), { code: 'QUERY_VERSION_MISMATCH' });
  }
}

export async function runAgent(command, values) {
  const { project, connect, format = 'json', ...options } = values;
  if (!['json', 'text'].includes(format)) throw new Error('--format 必须为 json 或 text');
  const request = { command };
  const numbers = { limit: 'limit', hops: 'hops', 'max-paths': 'maxPaths', 'max-depth': 'maxDepth', 'max-expansions': 'maxExpansions', 'max-nodes': 'maxNodes', 'max-edges': 'maxEdges', 'evidence-limit': 'evidenceLimit' };
  for (const [key, value] of Object.entries(options)) request[key === 'include-inherited' ? 'includeInherited' : numbers[key] ?? key] = numbers[key] ? (/^\d+$/.test(value) ? Number(value) : NaN) : key === 'include-inherited' ? value === 'true' : value;
  validateQuery(request);
  if (command === 'guide' && connect === undefined) {
    if (project !== undefined) throw new Error('agent guide 不读取项目，请省略 --project');
    const guide = queryGuide();
    return format === 'text' ? formatQueryText(guide) : JSON.stringify(guide, null, 2);
  }
  let result;
  if (connect !== undefined) {
    const url = new URL(connect);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || !['', '/'].includes(url.pathname) || url.hash) throw new Error('--connect 只接受本地服务 origin');
    const endpoint = new URL('/api/agent', url);
    for (const [key, value] of Object.entries(request)) endpoint.searchParams.set(key, String(value));
    if (command !== 'guide') {
      if (typeof project !== 'string' || !project) mutationFail('AGENT_PROJECT_REQUIRED', '在线 Agent 查询必须提供 --project；它不会切换网页当前项目');
      endpoint.searchParams.set('projectRoot', project);
    }
    const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), { code: result.error });
    assertQueryCompatibility(result);
  } else {
    if (project === '') throw new Error('--project 不能为空');
    const context = await projectContext(project !== undefined ? project : await findProject());
    const release = await acquireWorkspaceLock(context.workspaceRoot);
    try { result = queryWorkspace(await readQuerySnapshot(context.workspaceRoot), request); }
    finally { await release(); }
  }
  return format === 'text' ? formatQueryText(result) : JSON.stringify(result, null, 2);
}

const assertLocalOrigin = connect => {
  const url = new URL(connect);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || !['', '/'].includes(url.pathname) || url.hash) {
    mutationFail('AGENT_MUTATION_INVALID', '--connect 只接受本地服务 origin');
  }
  return url;
};

export async function runAgentEditSession(action, values) {
  const fields = action === 'open' ? ['mechanic'] : action === 'close' ? ['mechanic', 'session'] : action === 'status' ? ['session'] : null;
  if (!fields) mutationFail('AGENT_EDIT_SESSION_INVALID', 'Agent 编辑会话只支持 open、close 或 status');
  const common = new Set(['project', 'connect', 'format', 'project-generation', 'previous-session', ...fields]);
  for (const key of Object.keys(values)) if (!common.has(key)) mutationFail('AGENT_EDIT_SESSION_INVALID', `session ${action} 不支持 --${key}`);
  if (values.format !== undefined && values.format !== 'json') mutationFail('AGENT_EDIT_SESSION_INVALID', 'Agent 编辑会话只支持 --format json');
  if (values.connect === undefined) mutationFail('AGENT_EDIT_SESSION_REQUIRED', '编辑会话只能连接已运行的本地服务，请提供 --connect');
  if (typeof values.project !== 'string' || !values.project) mutationFail('AGENT_PROJECT_REQUIRED', '编辑会话必须提供 --project；它不会切换网页当前项目');
  if (!fields.every(key => typeof values[key] === 'string' && values[key])) mutationFail('AGENT_EDIT_SESSION_INVALID', `session ${action} 缺少必要参数`);
  const projectGeneration = parseGeneration(values['project-generation']);
  const url = assertLocalOrigin(values.connect);
  if (action === 'status') {
    const endpoint = new URL('/api/agent/session', url);
    endpoint.searchParams.set('projectRoot', values.project); endpoint.searchParams.set('projectGeneration', String(projectGeneration)); endpoint.searchParams.set('session', values.session);
    const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), result, { code: result.error });
    return JSON.stringify(result, null, 2);
  }
  const response = await fetch(new URL('/api/agent/session', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ action, projectRoot: values.project, mechanic: values.mechanic, editSessionId: values.session,
      previousEditSessionId: values['previous-session'], projectGeneration }) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message), result, { code: result.error });
  return JSON.stringify(result, null, 2);
}

export async function runAgentMechanicTarget(action, values) {
  if (action !== 'open') mutationFail('AGENT_MECHANIC_TARGET_INVALID', '机制目标只支持 open');
  const common = new Set(['project', 'connect', 'format', 'project-generation', 'mechanic']);
  for (const key of Object.keys(values)) if (!common.has(key)) mutationFail('AGENT_MECHANIC_TARGET_INVALID', `mechanic ${action} 不支持 --${key}`);
  if (values.format !== undefined && values.format !== 'json') mutationFail('AGENT_MECHANIC_TARGET_INVALID', '机制目标只支持 --format json');
  if (values.connect === undefined) mutationFail('AGENT_EDIT_SESSION_REQUIRED', '机制目标只能连接已运行的本地服务，请提供 --connect');
  if (typeof values.project !== 'string' || !values.project) mutationFail('AGENT_PROJECT_REQUIRED', '机制目标必须提供 --project；它不会切换网页当前项目');
  if (typeof values.mechanic !== 'string' || !values.mechanic) mutationFail('AGENT_MECHANIC_TARGET_INVALID', 'mechanic open 缺少 --mechanic');
  const url = assertLocalOrigin(values.connect), endpoint = new URL('/api/agent/mechanic', url);
  endpoint.searchParams.set('projectRoot', values.project); endpoint.searchParams.set('projectGeneration', String(parseGeneration(values['project-generation'])));
  endpoint.searchParams.set('mechanic', values.mechanic);
  const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message), result, { code: result.error });
  return JSON.stringify(result, null, 2);
}

const mutationFields = {
  'mechanic-folder': {
    create: ['name', 'parent'],
    delete: ['folder'],
  },
  mechanic: {
    create: ['id', 'name', 'scope', 'folder'],
    update: ['mechanic', 'name', 'scope', 'remove-isolated-concepts'],
    arrange: ['mechanic'],
    delete: ['mechanic'],
  },
  'recipe-migration': {
    preview: ['manifest'],
    execute: ['manifest'],
  },
  view: {
    delete: ['view'],
  },
  concept: {
    create: ['id', 'label', 'description', 'aliases', 'tags'],
    update: ['concept', 'label', 'description', 'aliases', 'tags'],
    delete: ['concept'],
  },
  rule: {
    add: ['mechanic', 'source', 'target', 'source-qualifiers', 'target-qualifiers', 'relation', 'sign', 'text', 'inheritance'],
    update: ['mechanic', 'source', 'target', 'source-qualifiers', 'target-qualifiers', 'relation', 'sign', 'text', 'inheritance'],
    delete: ['mechanic', 'source', 'target', 'source-qualifiers', 'target-qualifiers'],
  },
};

const mutationFail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const parseStringArray = (value, option) => {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error();
    return parsed;
  } catch { mutationFail('AGENT_MUTATION_INVALID', `--${option} 必须是 JSON 字符串数组`); }
};
const parseGeneration = value => {
  if (!/^\d+$/u.test(value ?? '')) mutationFail('AGENT_MUTATION_INVALID', '--project-generation 必须是非负整数');
  return Number(value);
};

export async function runRecipeMigration(action, values) {
  const fields = mutationFields['recipe-migration']?.[action];
  if (action === 'recover') {
    if (Object.keys(values).some(key => !['project', 'format', 'manifest'].includes(key))) mutationFail('AGENT_MUTATION_INVALID', 'recipe-migration recover 不支持额外参数');
    if (values.format !== undefined && values.format !== 'json') mutationFail('AGENT_MUTATION_INVALID', 'Agent 写入只支持 --format json');
    if (typeof values.manifest !== 'string' || !values.manifest || values.project === '') mutationFail('AGENT_MUTATION_INVALID', 'recipe-migration recover 必须提供项目与 --manifest');
    const root = await realpath(resolve(values.project !== undefined ? values.project : await findProject()));
    return JSON.stringify(await recoverRecipeMigration(root, values.manifest), null, 2);
  }
  if (!fields) mutationFail('AGENT_MUTATION_INVALID', 'recipe-migration 只支持 preview、execute 或 recover');
  const common = new Set(['project', 'format', 'manifest', 'revision']);
  for (const key of Object.keys(values)) if (!common.has(key)) mutationFail('AGENT_MUTATION_INVALID', `recipe-migration ${action} 不支持 --${key}`);
  if (values.format !== undefined && values.format !== 'json') mutationFail('AGENT_MUTATION_INVALID', 'Agent 写入只支持 --format json');
  if (typeof values.manifest !== 'string' || !values.manifest) mutationFail('AGENT_MUTATION_INVALID', 'recipe-migration 必须提供 --manifest');
  if (action === 'execute' && (typeof values.revision !== 'string' || !values.revision)) mutationFail('AGENT_MUTATION_INVALID', 'recipe-migration execute 必须提供 preview 返回的 --revision');
  if (action === 'preview' && values.revision !== undefined) mutationFail('AGENT_MUTATION_INVALID', 'recipe-migration preview 不接受 --revision');
  if (values.project === '') mutationFail('AGENT_MUTATION_INVALID', '--project 不能为空');
  const context = await projectContext(values.project !== undefined ? values.project : await findProject());
  const store = await createWorkspaceStore(context.workspaceRoot);
  try { return JSON.stringify(await store.recipeMigration({ action, manifest: values.manifest, revision: values.revision }), null, 2); }
  finally { await store.close(); }
}

export async function runAgentMutation(resource, action, values) {
  const fields = mutationFields[resource]?.[action];
  if (!fields) mutationFail('AGENT_MUTATION_INVALID', 'Agent 写入只支持 mechanic-folder create、mechanic create|update|arrange|delete、view delete、concept create|update|delete 或 rule add|update|delete');
  const container = resource === 'mechanic-folder' || (resource === 'mechanic' && action === 'create') || resource === 'view';
  const revisionOption = container ? 'workspace-revision' : 'revision';
  const common = new Set(['project', 'connect', 'format', revisionOption, 'project-generation', 'session', ...fields]);
  for (const key of Object.keys(values)) if (!common.has(key)) mutationFail('AGENT_MUTATION_INVALID', `${resource} ${action} 不支持 --${key}`);
  if (values.format !== undefined && values.format !== 'json') mutationFail('AGENT_MUTATION_INVALID', 'Agent 写入只支持 --format json');
  if (values[revisionOption] === undefined) mutationFail('AGENT_MUTATION_INVALID', `Agent 写入必须提供 --${revisionOption}`);
  const body = { revision: values[revisionOption], resource, action };
  if (resource === 'mechanic-folder') {
    if (action === 'create') {
      body.name = values.name;
      if (values.parent !== undefined) body.parent = values.parent;
    } else body.folder = values.folder;
  } else if (resource === 'mechanic') {
    if (action === 'create') {
      for (const key of ['id', 'name', 'scope', 'folder']) if (values[key] !== undefined) body[key] = values[key];
    } else {
      for (const key of ['mechanic', 'name', 'scope']) if (values[key] !== undefined) body[key] = values[key];
      if (values['remove-isolated-concepts'] !== undefined) body.removeIsolatedConceptIds = parseStringArray(values['remove-isolated-concepts'], 'remove-isolated-concepts');
    }
  } else if (resource === 'view') {
    body.view = values.view;
  } else if (resource === 'concept') {
    body.id = action === 'create' ? values.id : values.concept;
    for (const key of ['label', 'description']) if (values[key] !== undefined) body[key] = values[key];
    for (const key of ['aliases', 'tags']) if (values[key] !== undefined) body[key] = parseStringArray(values[key], key);
  } else {
    for (const key of ['mechanic', 'source', 'target', 'relation']) if (values[key] !== undefined) body[key] = values[key];
    if (values.text !== undefined) body.ruleText = values.text;
    for (const [option, field] of [['source-qualifiers', 'sourceQualifiers'], ['target-qualifiers', 'targetQualifiers']]) if (values[option] !== undefined) {
      try { body[field] = JSON.parse(values[option]); } catch { mutationFail('AGENT_MUTATION_INVALID', `--${option} 必须是 JSON 数组`); }
    }
    if (values.inheritance !== undefined) { try { body.inheritance = JSON.parse(values.inheritance); } catch { mutationFail('AGENT_MUTATION_INVALID', '--inheritance 必须是 JSON 对象'); } }
    if (values.sign !== undefined) {
      const signs = { positive: 1, negative: -1, '1': 1, '-1': -1, random: 'random' };
      if (!Object.hasOwn(signs, values.sign)) mutationFail('AGENT_MUTATION_INVALID', '--sign 必须是 positive、negative、1、-1 或 random');
      body.sign = signs[values.sign];
    }
  }
  if (values.connect !== undefined) {
    if (values['project-generation'] === undefined) mutationFail('PROJECT_CHANGED', '在线 Agent 写入必须提供 --project-generation');
    if (typeof values.project !== 'string' || !values.project) mutationFail('AGENT_PROJECT_REQUIRED', '在线 Agent 写入必须提供 --project；它不会切换网页当前项目');
    const requiresEditSession = !['mechanic-folder', 'mechanic'].includes(resource) || (resource === 'mechanic' && action !== 'create');
    if (requiresEditSession && (typeof values.session !== 'string' || !values.session)) mutationFail('AGENT_EDIT_SESSION_REQUIRED', '编辑既有机制前必须提供 mechanic open 返回的 --session');
    body.projectGeneration = parseGeneration(values['project-generation']);
    if (values.session !== undefined) body.editSessionId = values.session;
    body.projectRoot = values.project;
    const url = assertLocalOrigin(values.connect);
    const response = await fetch(new URL('/api/agent/mutation', url), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), result, { code: result.error });
    return JSON.stringify(result, null, 2);
  }
  if (values['project-generation'] !== undefined || values.session !== undefined) mutationFail('AGENT_MUTATION_INVALID', '离线 Agent 写入不接受 --project-generation 或 --session');
  if (values.project === '') mutationFail('AGENT_MUTATION_INVALID', '--project 不能为空');
  const context = await projectContext(values.project !== undefined ? values.project : await findProject());
  const store = await createWorkspaceStore(context.workspaceRoot);
  try { return JSON.stringify(await store.mutateAgent(body), null, 2); }
  finally { await store.close(); }
}

export function queryFromSearch(search) {
  const request = {};
  const numeric = new Set(['limit', 'hops', 'maxPaths', 'maxDepth', 'maxExpansions', 'maxNodes', 'maxEdges', 'evidenceLimit']);
  for (const [key, value] of search) {
    if (Object.hasOwn(request, key)) throw new Error('查询参数重复：' + key);
    Object.defineProperty(request, key, { value: numeric.has(key) ? (/^\d+$/.test(value) ? Number(value) : NaN) : key === 'includeInherited' ? value === 'true' : value, enumerable: true });
  }
  return validateQuery(request);
}
