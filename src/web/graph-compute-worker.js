importScripts('/vendor/elk.js', '/vendor/webcola.js');

// elk.bundled.js 在 Dedicated Worker 中会误判 Browserify 的 web-worker 模块，
// 继而构造不存在的内嵌 _Worker。显式注入原生嵌套 Worker，绕过该自动探测。
function BrowserELK() {
  return new self.ELK({
    workerUrl: '/vendor/elk-worker.js',
    workerFactory: url => new self.Worker(url),
  });
}

const kernel = import('/graph-compute-kernel.mjs');
self.onmessage = async event => {
  const request = event.data;
  try {
    const { computeGraphTask } = await kernel;
    const result = await computeGraphTask(request, { ELK: BrowserELK, cola: self.cola });
    self.postMessage({ requestId: request.requestId, geometryKey: request.geometryKey, ok: true, result });
  } catch (error) {
    self.postMessage({ requestId: request?.requestId, geometryKey: request?.geometryKey, ok: false,
      error: { name: error.name, code: error.code, message: error.message } });
  }
};
