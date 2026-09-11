#!/usr/bin/env node
import { readdir, rmdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const legacyNames = ['game-mechanic-search', 'game-mechanic-modeling'];
const replacementByLegacy = {
  'game-mechanic-search': 'mechanics-search',
  'game-mechanic-modeling': 'mechanics-modeling',
};
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const projectArgs = args.filter(arg => arg !== '--execute');

if (!projectArgs.length) {
  console.error('用法：node scripts/cleanup-legacy-project-skills.mjs [--execute] <项目目录> [...]');
  process.exitCode = 1;
} else {
  const results = [];
  for (const argument of projectArgs) {
    const projectRoot = resolve(argument);
    const skillsRoot = join(projectRoot, '.agents', 'skills');
    const project = { projectRoot, removed: [], skipped: [], blocked: [] };
    for (const legacyName of legacyNames) {
      const legacyPath = join(skillsRoot, legacyName);
      const replacementPath = join(skillsRoot, replacementByLegacy[legacyName], 'SKILL.md');
      try {
        await stat(legacyPath);
      } catch (error) {
        if (error.code === 'ENOENT') { project.skipped.push({ legacyName, reason: 'missing' }); continue; }
        throw error;
      }
      try {
        await stat(replacementPath);
      } catch (error) {
        if (error.code === 'ENOENT') { project.blocked.push({ legacyName, reason: 'replacement_missing' }); continue; }
        throw error;
      }
      const entries = await readdir(legacyPath);
      if (entries.length) { project.blocked.push({ legacyName, reason: 'directory_not_empty', entries }); continue; }
      if (execute) await rmdir(legacyPath);
      project.removed.push({ legacyName, path: legacyPath, executed: execute });
    }
    results.push(project);
  }
  const blocked = results.some(project => project.blocked.length);
  console.log(JSON.stringify({ ok: !blocked, execute, results }, null, 2));
  if (blocked) process.exitCode = 2;
}
