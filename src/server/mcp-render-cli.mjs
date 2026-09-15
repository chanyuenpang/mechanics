#!/usr/bin/env node
import { startRenderServer } from './mcp-render.mjs';

startRenderServer().catch(error => {
  console.error(JSON.stringify({ error: error.code ?? 'MCP_START_FAILED', message: error.message }));
  process.exitCode = 1;
});
