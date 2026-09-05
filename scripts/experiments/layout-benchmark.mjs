import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import assert from 'node:assert/strict';
import { refineHierarchy } from './layout-exploration.mjs';

// 每次使用全新 Node 进程，样本串行运行；计时不包含文件读取和结果渲染。
// 几何必须与已验证的参考结果完全一致，禁止以减少计算质量换取更好耗时。
const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
if (args.includes('--worker')) {
  const sample = JSON.parse(await readFile(get('--input'), 'utf8'));
  const reference = JSON.parse(await readFile(get('--reference'), 'utf8'));
  const hash = createHash('sha256').update(JSON.stringify(sample)).digest('hex');
  assert.equal(hash, reference.inputHash);
  const result = await refineHierarchy(sample.graph, reference.options);
  const expected = reference.candidates.find(candidate => candidate.mode === 'adaptive');
  assert.deepEqual(result.metrics, expected.metrics);
  assert.deepEqual(result.geometry, expected.geometry);
  console.log(JSON.stringify({ id: sample.id, nodes: sample.graph.nodes.length, edges: sample.graph.edges.length,
    inputHash: hash, timing: result.refinement.timing, crossings: result.metrics.crossings,
    selection: result.refinement.comparison.selected, geometryMatches: true }));
} else {
  const directory = resolve(get('--directory')), repeats = Number(get('--repeats'));
  const inputs = args.slice(args.indexOf('--inputs') + 1);
  if (!Number.isInteger(repeats) || repeats < 1 || !inputs.length) throw Error('需要有效的重复次数与样本 ID 列表');
  const rows = [], started = new Date().toISOString();
  for (const id of inputs) for (let repeat = 1; repeat <= repeats; repeat++) {
    const wallStart = performance.now();
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker',
      '--input', join(directory, `${id}-input.json`), '--reference', join(directory, `${id}-comparison.json`)],
    { encoding: 'utf8', timeout: 600_000, windowsHide: true });
    if (child.error) throw child.error;
    if (child.status !== 0) throw Error(`样本 ${id} 第 ${repeat} 次计算失败：\n${child.stdout}\n${child.stderr}`);
    const row = { ...JSON.parse(child.stdout), repeat, processMs: performance.now() - wallStart };
    rows.push(row);
    console.log(JSON.stringify({ id, repeat, initialMs: Math.round(row.timing.initialReadyMs), totalMs: Math.round(row.timing.totalMs), geometryMatches: row.geometryMatches }));
  }
  await writeFile(resolve(get('--output')), JSON.stringify({ started, finished: new Date().toISOString(),
    environment: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, node: process.version, platform: platform(), arch: arch() },
    repeats, rows }, null, 2));
}
