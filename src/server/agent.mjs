import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { acquireWorkspaceLock } from './files.mjs';
import { readQuerySnapshot } from './query-snapshot.mjs';
import { findWorkspace } from './workspace-commands.mjs';
import { queryWorkspace, validateQuery, formatQueryText } from '../domain/query.mjs';
import { QUERY_API_VERSION, READING_CONTRACT_VERSION, SEMANTICS_VERSION, queryGuide } from '../domain/query-contract.mjs';

export function assertQueryCompatibility(result) {
  if (result?.queryApiVersion !== QUERY_API_VERSION || result.semanticsVersion !== SEMANTICS_VERSION || result.readingContract?.version !== READING_CONTRACT_VERSION) {
    throw Object.assign(new Error('服务端查询协议或语义版本不匹配，请更新并重启服务；未采用旧版结果'), { code: 'QUERY_VERSION_MISMATCH' });
  }
}

export async function runAgent(command, values) {
  const { workspace, connect, format = 'json', ...options } = values;
  if (!['json', 'text'].includes(format)) throw new Error('--format 必须为 json 或 text');
  const request = { command };
  const numbers = { limit: 'limit', hops: 'hops', 'max-paths': 'maxPaths', 'max-depth': 'maxDepth', 'max-expansions': 'maxExpansions', 'max-nodes': 'maxNodes', 'max-edges': 'maxEdges', 'evidence-limit': 'evidenceLimit' };
  for (const [key, value] of Object.entries(options)) request[numbers[key] ?? key] = numbers[key] ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  validateQuery(request);
  if (command === 'guide' && connect === undefined) {
    if (workspace !== undefined) throw new Error('agent guide 不读取工作区，请省略 --workspace');
    const guide = queryGuide();
    return format === 'text' ? formatQueryText(guide) : JSON.stringify(guide, null, 2);
  }
  let result;
  if (connect !== undefined) {
    if (workspace !== undefined) throw new Error('--connect 与 --workspace 不能同时使用');
    const url = new URL(connect);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || !['', '/'].includes(url.pathname) || url.hash) throw new Error('--connect 只接受本地服务 origin，凭据通过 GAME_GRAPH_SESSION_TOKEN 环境变量提供');
    const token = process.env.GAME_GRAPH_SESSION_TOKEN;
    if (!token) throw Object.assign(new Error('需要 GAME_GRAPH_SESSION_TOKEN 环境变量中的本机会话凭据'), { code: 'SESSION_REQUIRED' });
    const endpoint = new URL('/api/agent', url);
    for (const [key, value] of Object.entries(request)) endpoint.searchParams.set(key, String(value));
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), { code: result.error });
    assertQueryCompatibility(result);
  } else {
    if (workspace === '') throw new Error('--workspace 不能为空');
    const root = workspace !== undefined ? await realpath(resolve(workspace)) : await findWorkspace();
    const release = await acquireWorkspaceLock(root);
    try { result = queryWorkspace(await readQuerySnapshot(root), request); }
    finally { await release(); }
  }
  return format === 'text' ? formatQueryText(result) : JSON.stringify(result, null, 2);
}

export function queryFromSearch(search) {
  const request = {};
  const numeric = new Set(['limit', 'hops', 'maxPaths', 'maxDepth', 'maxExpansions', 'maxNodes', 'maxEdges', 'evidenceLimit']);
  for (const [key, value] of search) {
    if (Object.hasOwn(request, key)) throw new Error('查询参数重复：' + key);
    Object.defineProperty(request, key, { value: numeric.has(key) ? (/^\d+$/.test(value) ? Number(value) : NaN) : value, enumerable: true });
  }
  return validateQuery(request);
}
