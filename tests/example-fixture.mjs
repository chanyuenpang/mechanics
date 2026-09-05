import { cp } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cardGameExampleRoot = fileURLToPath(new URL('../examples/card-game/', import.meta.url));

export async function copyExampleFixture(destination, source = cardGameExampleRoot) {
  await cp(source, destination, { recursive: true, filter: path => basename(path) !== '.game-graph.lock' });
}
