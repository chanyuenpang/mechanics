importScripts('/vendor/elk.js');

// elk.bundled.js 在 Dedicated Worker 中会误判 Browserify 的 web-worker 模块，
// 继而构造不存在的内嵌 _Worker。显式注入原生嵌套 Worker，绕过该自动探测。
function BrowserELK() {
  const engine = new self.ELK({
    workerUrl: '/vendor/elk-worker.js',
    workerFactory: url => new self.Worker(url),
  });
  // 一次整理复用同一个子 Worker，由计算任务统一释放；Node 的同步引擎无需释放线程。
  return { layout: input => engine.layout(input), dispose: () => engine.terminateWorker() };
}

const kernel = import('/graph-compute-kernel.mjs');
self.onmessage = async event => {
  const request = event.data;
  try {
    const { computeGraphTask } = await kernel;
    const result = await computeGraphTask(request, { ELK: BrowserELK });
    self.postMessage({ requestId: request.requestId, geometryKey: request.geometryKey, ok: true, result });
  } catch (error) {
    console.error('图计算失败', error);
    self.postMessage({ requestId: request?.requestId, geometryKey: request?.geometryKey, ok: false,
      error: { name: error?.name, code: error?.code, message: error?.message ?? String(error) } });
  }
};
