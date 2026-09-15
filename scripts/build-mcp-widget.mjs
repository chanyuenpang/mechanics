import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('../src/mcp/concepts-widget-source.mjs', import.meta.url))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  external: ['/vendor/libavoid/index.js'],
  outfile: fileURLToPath(new URL('../src/mcp/concepts-widget.bundle.js', import.meta.url)),
});
