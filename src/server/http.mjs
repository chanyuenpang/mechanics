import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readWorkspace } from './workspace.mjs';

const assets = new Map([
  ['/', [new URL('../web/index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/app.mjs', [new URL('../web/app.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/style.css', [new URL('../web/style.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/domain/graph.mjs', [new URL('../domain/graph.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
]);

export async function startServer({ workspaceRoot, port = 4319 }) {
  await readWorkspace(workspaceRoot);
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
      if (request.method !== 'GET') {
        send(405, { error: 'READ_ONLY', message: '当前是只读项目骨架，尚未开放新建或保存接口' }); return;
      }
      const url = new URL(request.url, origin);
      if (url.pathname === '/api/workspace') {
        const supplied = Buffer.from(request.headers.authorization ?? '');
        if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) {
          send(401, { error: 'SESSION_REQUIRED', message: '需要启动网址中的本机会话凭据' }); return;
        }
        send(200, await readWorkspace(workspaceRoot)); return;
      }
      const asset = assets.get(url.pathname);
      if (!asset) { send(404, { error: 'NOT_FOUND', message: '没有此资源' }); return; }
      send(200, await readFile(asset[0]), asset[1]);
    } catch (error) {
      // 不返回部分工作区，不把失败替换为空数据或内置示例。
      send(422, { error: error.code ?? 'READ_FAILED', message: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, token, url: `${origin}/#session=${token}` };
}
