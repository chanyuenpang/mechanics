import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createWorkspaceStore } from './store.mjs';

const assets = new Map([
  ['/', [new URL('../web/index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/app.mjs', [new URL('../web/app.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/canvas.mjs', [new URL('../web/canvas.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/glossary.mjs', [new URL('../web/glossary.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/style.css', [new URL('../web/style.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/domain/graph.mjs', [new URL('../domain/graph.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
]);

export async function startServer({ workspaceRoot, port = 4319 }) {
  const store = await createWorkspaceStore(workspaceRoot);
  const token = randomBytes(24).toString('base64url');
  const expectedToken = Buffer.from(`Bearer ${token}`);
  let origin;
  const server = createServer(async (request, response) => {
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    };
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)
        || request.headers['sec-fetch-site'] === 'cross-site') {
        send(403, { error: 'ORIGIN_REJECTED', message: '拒绝非本地同源访问' }); return;
      }
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const supplied = Buffer.from(request.headers.authorization ?? '');
        if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) {
          send(401, { error: 'SESSION_REQUIRED', message: '需要启动网址中的本机会话凭据' }); return;
        }
        if (request.method === 'GET' && url.pathname === '/api/workspace') {
          send(200, await store.read()); return;
        }
        if (request.method === 'POST' && ['/api/save', '/api/analyses'].includes(url.pathname)) {
          if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
            send(403, { error: 'WRITE_ORIGIN_REQUIRED', message: '写入必须来自同源页面并使用 JSON' }); return;
          }
          const chunks = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 3 * 1024 * 1024) { send(413, { error: 'BODY_LIMIT', message: '请求超过 3 MiB' }); return; }
            chunks.push(chunk);
          }
          const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求必须是 JSON 对象');
          send(200, await (url.pathname === '/api/save' ? store.save(body) : store.createAnalysis(body))); return;
        }
        send(405, { error: 'METHOD_NOT_ALLOWED', message: '此接口不支持该操作' }); return;
      }
      if (request.method !== 'GET') { send(405, { error: 'METHOD_NOT_ALLOWED', message: '静态资源只支持读取' }); return; }
      const asset = assets.get(url.pathname);
      if (!asset) { send(404, { error: 'NOT_FOUND', message: '没有此资源' }); return; }
      send(200, await readFile(asset[0]), asset[1]);
    } catch (error) {
      // 不返回部分工作区，不把失败替换为空数据或内置示例。
      const status = ['REVISION_CONFLICT', 'FILE_EXISTS', 'DUPLICATE_ID'].includes(error.code) ? 409
        : ['SAVE_UNCERTAIN', 'CREATE_PARTIAL'].includes(error.code) ? 500 : 422;
      send(status, { error: error.code ?? 'REQUEST_FAILED', message: error.message });
    }
  });
  try { await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }); } catch (error) { await store.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await store.close();
  };
  return { server, close, origin, token, url: `${origin}/#session=${token}` };
}
