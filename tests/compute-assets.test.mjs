import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/http.mjs';

test('计算 Worker 可以加载 WASM，普通页面保持禁止动态脚本求值', async () => {
  const server = await startServer({ port: 0 });
  try {
    for (const path of ['', 'hierarchical-layout.mjs', 'graph-compute-worker.js', 'domain/hover-details.mjs', 'vendor/libavoid/index.js', 'vendor/libavoid/libavoid.wasm']) {
      const response = await fetch(new URL(path, server.url));
      assert.equal(response.status, 200, path);
      const policy = response.headers.get('content-security-policy');
      assert.equal(policy.includes("'unsafe-eval'"), path === 'graph-compute-worker.js');
      assert.match(policy, /default-src 'self'; script-src 'self'/);
      if (path.endsWith('.wasm')) {
        assert.equal(response.headers.get('content-type'), 'application/wasm');
        assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 4)], [0, 97, 115, 109]);
      }
    }
  } finally { await server.close(); }
});
