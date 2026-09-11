import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../domain/validate.mjs';

const DRAFT_ROOT = join(tmpdir(), 'mechanics-agent-drafts');
const EXPIRES_AFTER_MS = 24 * 60 * 60 * 1000;
const fail = (code, message) => { throw new ContractError(code, message); };
const clone = value => structuredClone(value);

const structureOnly = document => {
  const draft = clone(document);
  delete draft.positions; delete draft.projectionPositions; delete draft.routeCache;
  return draft;
};

export async function cleanupExpiredAgentDrafts(now = Date.now()) {
  await mkdir(DRAFT_ROOT, { recursive: true });
  const entries = await readdir(DRAFT_ROOT, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(DRAFT_ROOT, entry.name);
    const info = await stat(path);
    if (now - info.mtimeMs <= EXPIRES_AFTER_MS) continue;
    await rm(path, { recursive: true, force: true }); removed.push(entry.name);
  }
  return removed;
}

export async function openAgentDraft(workspace, mechanicId) {
  const mechanic = workspace.mechanics.find(item => item.id === mechanicId);
  if (!mechanic) fail('SCOPE_NOT_FOUND', `机制不存在：${mechanicId}`);
  await cleanupExpiredAgentDrafts();
  const id = randomUUID(), root = join(DRAFT_ROOT, id);
  await mkdir(root);
  const definitionsPath = join(root, 'definitions.json');
  const rulesPath = join(root, 'rules.json');
  const mechanicPath = join(root, 'mechanic.json');
  await Promise.all([
    writeFile(definitionsPath, JSON.stringify(structureOnly(workspace.definitions), null, 2) + '\n', 'utf8'),
    writeFile(rulesPath, JSON.stringify(structureOnly(workspace.rules), null, 2) + '\n', 'utf8'),
    writeFile(mechanicPath, JSON.stringify(structureOnly(mechanic), null, 2) + '\n', 'utf8'),
  ]);
  return { id, root, definitionsPath, rulesPath, mechanicPath, mechanic: mechanicId, workspaceRevision: workspace.revision,
    definitionsRevision: workspace.resourceRevisions.definitions, rulesRevision: workspace.resourceRevisions.rules, mechanicRevision: workspace.resourceRevisions.mechanics[mechanicId] };
}

export async function readAgentDraft(record) {
  try {
    const [definitions, rules, mechanic] = await Promise.all([
      readFile(record.definitionsPath, 'utf8').then(JSON.parse), readFile(record.rulesPath, 'utf8').then(JSON.parse), readFile(record.mechanicPath, 'utf8').then(JSON.parse),
    ]);
    return { definitions, rules, mechanic };
  } catch (error) { fail('AGENT_DRAFT_INVALID', `草稿无法读取或不是有效 JSON：${error.message}`); }
}

export async function removeAgentDraft(record) {
  await rm(record.root, { recursive: true, force: true });
}
