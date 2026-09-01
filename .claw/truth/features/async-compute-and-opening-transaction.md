# 可取消后台计算与打开事务

<!-- state: current -->

## 当前行为

- `GraphComputeCoordinator` 是图计算生命周期的唯一 owner；同一时刻只保留一个 Worker。新的 route 或 layout 请求会先 `terminate` 旧 Worker，并以单调递增的 `requestId` 标识新任务。
- Worker 返回结果只有在 `requestId`、`geometryKey` 与当前几何仍同时匹配时才可提交；失配、Worker 加载/运行错误或响应反序列化失败都会显式失败，不会用旧结果覆盖当前画布。
- 画布正式连线重绘与自动排版都在 Worker 中执行。拖动期间保留轻量关联边预览，松手后提交后台正式重绘；后台计算显示非模态状态，不锁定拖动、缩放和普通编辑。
- 文件打开的 loading overlay 由真实读取事务驱动，并持续到非空图的首帧路线提交；读取或计算失败后停止动画并保留原错误。
- 自动排版完成端点交换后只做节点、端点和拐点的同步坐标变换，水平与竖直通道统一保持 `48px` 最小间距，不重复触发全图布线。

## 已验证与限制

2026-09-01 的实现验收报告确认完整测试 `124/124` 通过，并通过浏览器首帧竞态、安装包静态资源和隔离安装检查。当前行为锚点为 `src/web/graph-compute.mjs`、`src/web/graph-compute-worker.js`、`src/web/app.mjs`、`src/web/canvas.mjs` 与 `src/web/layout.mjs`。该记录不代表对真实网络故障、掉电恢复或大规模图性能作出额外承诺。

