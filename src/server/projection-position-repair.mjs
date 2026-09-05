import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commitFiles, acquireWorkspaceLock } from './files.mjs';
import { discover, readDocument, readWorkspace } from './workspace.mjs';
import { endpointProjectionId } from '../domain/endpoint-projection.mjs';
import { ContractError } from '../domain/validate.mjs';

const projectionIds = edge => ['sourceQualifiers', 'targetQualifiers']
  .filter(key => edge[key]?.length)
  .map(key => endpointProjectionId(key === 'sourceQualifiers' ? edge.source : edge.target, edge[key]));

async function plan(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const { mechanicPaths, viewPaths } = await discover(root);
  const mechanics = await Promise.all(mechanicPaths.map(file => readDocument(root, file)));
  const views = await Promise.all(viewPaths.map(file => readDocument(root, file)));
  const valid = new Set(mechanics.flatMap(item => item.document.edges.flatMap(projectionIds)));
  const hash = createHash('sha256');
  for (const item of [...mechanics, ...views].sort((left, right) => left.actual.localeCompare(right.actual))) hash.update(item.raw);
  const changes = [];
  for (const [index, item] of views.entries()) {
    const positions = item.document.projectionPositions;
    if (!positions || typeof positions !== 'object' || Array.isArray(positions)) continue;
    const stale = Object.keys(positions).filter(id => id.startsWith('scope:') && !valid.has(id));
    if (!stale.length) continue;
    const document = structuredClone(item.document);
    for (const id of stale) delete document.projectionPositions[id];
    changes.push({ path: viewPaths[index], document, stale });
  }
  return { root, revision: hash.digest('hex'), changes };
}

export async function repairProjectionPositions(workspaceRoot, { revision, execute = false } = {}) {
  const preview = await plan(workspaceRoot);
  const summary = { repair: 'stale-projection-positions', revision: preview.revision,
    changedViews: preview.changes.map(item => ({ file: item.path, removedProjectionIds: item.stale })) };
  if (!execute) return { ...summary, preview: true };
  if (typeof revision !== 'string' || revision !== preview.revision) throw new ContractError('REVISION_CONFLICT', '修复预览已过期；请重新预览后执行。');
  const release = await acquireWorkspaceLock(preview.root);
  try {
    const current = await plan(preview.root);
    if (current.revision !== revision) throw new ContractError('REVISION_CONFLICT', '修复期间工作区已变化；未写入。');
    if (current.changes.length) await commitFiles(preview.root, current.changes.map(({ path, document }) => ({ path, document })));
    const workspace = await readWorkspace(preview.root);
    return { ...summary, preview: false, canonicalCommitted: true, workspaceId: workspace.manifest.id, resultingRevision: workspace.revision };
  } finally { await release(); }
}
