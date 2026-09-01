function cancellation(message = '计算任务已被更新的图状态取消。') {
  const error = new Error(message); error.name = 'AbortError'; error.code = 'COMPUTE_CANCELLED'; return error;
}

function workerFailure(value, fallback) {
  const error = new Error(value?.message || fallback);
  error.name = value?.name || 'Error'; if (value?.code) error.code = value.code;
  return error;
}

export const computeCancelled = error => error?.name === 'AbortError' || error?.code === 'COMPUTE_CANCELLED';

// 主线程唯一计算 owner：任何时刻只有一个 Worker，新任务直接终止旧任务。
export class GraphComputeCoordinator {
  constructor({ workerFactory = () => new Worker('/graph-compute-worker.js'), onState = () => {} } = {}) {
    this.workerFactory = workerFactory; this.onState = onState; this.sequence = 0; this.current = null;
  }
  run({ kind, geometryKey, payload, isCurrent = () => true }) {
    if (!['route', 'layout'].includes(kind) || typeof geometryKey !== 'string') {
      return Promise.reject(new Error('图计算请求缺少有效类型或几何签名。'));
    }
    this.cancel();
    let worker;
    try { worker = this.workerFactory(); }
    catch (error) { return Promise.reject(error); }
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const task = { requestId, kind, geometryKey, worker, reject, settled: false };
      this.current = task; this.onState({ active: true, kind, requestId });
      const finish = (callback, value) => {
        if (task.settled) return; task.settled = true;
        if (this.current === task) this.current = null;
        worker.terminate(); this.onState({ active: false, kind, requestId }); callback(value);
      };
      worker.onmessage = event => {
        if (this.current !== task || task.settled) return;
        const data = event.data;
        if (!data || data.requestId !== requestId || data.geometryKey !== geometryKey || typeof data.ok !== 'boolean') {
          finish(reject, new Error('图计算 Worker 返回了不匹配的响应。')); return;
        }
        if (!isCurrent()) { finish(reject, cancellation()); return; }
        if (!data.ok) { finish(reject, workerFailure(data.error, '图计算失败。')); return; }
        finish(resolve, data.result);
      };
      worker.onerror = event => finish(reject, new Error(event.message || '图计算 Worker 加载或运行失败。'));
      worker.onmessageerror = () => finish(reject, new Error('图计算 Worker 响应无法反序列化。'));
      try { worker.postMessage({ requestId, kind, geometryKey, payload }); }
      catch (error) { finish(reject, error); }
    });
  }
  cancel() {
    const task = this.current; if (!task || task.settled) return false;
    task.settled = true; this.current = null; task.worker.terminate();
    this.onState({ active: false, kind: task.kind, requestId: task.requestId, cancelled: true });
    task.reject(cancellation()); return true;
  }
  dispose() { this.cancel(); }
}
