import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { renderSvg, measureGeometry } from './layout-exploration.mjs';

// 报告仅消费已经冻结的实验结果，拒绝混合不同输入后比较。
const root = resolve(process.argv[2]), output = join(root, 'report');
await mkdir(output, { recursive: true });
const rows = [];
for (const filename of (await readdir(join(root, 'final'))).filter(name => name.endsWith('-comparison.json')).sort()) {
  const report = JSON.parse(await readFile(join(root, 'final', filename), 'utf8')), id = report.sample;
  const sample = JSON.parse(await readFile(join(root, 'final', `${id}-input.json`), 'utf8'));
  const hash = createHash('sha256').update(JSON.stringify(sample)).digest('hex');
  if (hash !== report.inputHash) throw Error(`输入指纹不匹配：${id}`);
  for (const candidate of report.candidates) {
    if (candidate.error) throw Error(`候选计算失败：${id}/${candidate.mode}\n${candidate.error}`);
    const metrics = measureGeometry(sample.graph, candidate.geometry);
    if (JSON.stringify(metrics) !== JSON.stringify(candidate.metrics)) throw Error(`几何复核与记录指标不同：${id}/${candidate.mode}`);
    const filename = `${id}-${candidate.mode}.svg`;
    await writeFile(join(output, filename), renderSvg(sample, candidate.geometry));
    rows.push({ id, mode: candidate.mode, file: filename, nodes: report.nodes, edges: report.edges,
      inputHash: hash, metrics: candidate.metrics, elapsed: candidate.elapsed ?? null,
      selection: candidate.refinement?.comparison.selected ?? null });
  }
}
await writeFile(join(output, 'summary.json'), JSON.stringify(rows, null, 2));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
await writeFile(join(output, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>递归布局实验</title><style>
body{font:15px system-ui;margin:30px;background:#f8faf7;color:#263b32}h1{font-size:24px}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;border:1px solid #d5dfd8;text-align:left}a{color:#167766}small{color:#526a5c}figure{margin:28px 0;background:white;padding:16px;border:1px solid #d5dfd8}img{width:100%;height:auto}figcaption{margin-bottom:14px}</style>
<h1>递归布局实验 · 冻结样本对照</h1><p>原始节点、边和箭头方向全部保留。saved 是冻结时保存的布局，adaptive 是独立原型。按链接打开完整 SVG 可放大检查。</p>
<p>交叉减少不代表全部可读性问题已解决：当前原型仍有线间距不足，部分图转弯增加；未接入正式自动整理。</p>
<table><thead><tr><th>样本</th><th>节点 / 边</th><th>候选</th><th>交叉</th><th>转弯</th><th>总线长</th><th>近距离平行线惩罚</th><th>查看</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.id)}</td><td>${row.nodes} / ${row.edges}</td><td>${row.mode}</td><td>${row.metrics.crossings}</td><td>${row.metrics.bends}</td><td>${row.metrics.length}</td><td>${row.metrics.nearParallel}</td><td><a href="${row.file}">完整 SVG</a></td></tr>`).join('')}</tbody></table>
${rows.map(row => `<figure><figcaption>${escape(row.id)} · ${row.mode} · ${row.metrics.crossings} 个交叉</figcaption><a href="${row.file}"><img src="${row.file}" alt="${escape(row.id)} ${row.mode}" loading="lazy"></a></figure>`).join('')}
<small>输入 SHA-256、全部指标与候选选择见 summary.json；详细候选及迭代日志见上级 final 目录。</small></html>`);
console.log(JSON.stringify({ output, rows: rows.length }));
