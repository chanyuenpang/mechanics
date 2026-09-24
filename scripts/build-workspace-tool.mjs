import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 生成单文件离线工具；共享 Schema/domain/server 是唯一实现来源，项目运行时只需要 Node。
const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../workspace-tools/workspace-tool.mjs', import.meta.url);
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw new Error('仅支持 --check');
const result = await build({
  absWorkingDir: root, entryPoints: ['src/tools/workspace-tool-source.mjs'],
  bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false,
  charset: 'utf8', legalComments: 'eof', treeShaking: true,
  banner: { js: '// 此文件由 scripts/build-workspace-tool.mjs 生成；请编辑 src/tools/workspace-tool-source.mjs，勿直接修改产物。' },
});
const generated = result.outputFiles[0].text;
if (args.includes('--check')) {
  let current;
  try { current = await readFile(output, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== generated) throw new Error('离线工具产物已过期，请运行 node scripts/build-workspace-tool.mjs');
  console.log('离线工具产物与源一致');
} else {
  await writeFile(output, generated);
  console.log('已生成 workspace-tools/workspace-tool.mjs');
}
