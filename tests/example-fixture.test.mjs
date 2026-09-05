import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyExampleFixture } from './example-fixture.mjs';

test('复制示例夹具仅排除运行态锁，并保留其他文件', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'game-graph-example-fixture-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'), destination = join(temp, 'destination');
  await mkdir(join(source, '.game-graph', 'mechanics'), { recursive: true });
  await writeFile(join(source, '.game-graph', '.game-graph.lock'), '{"pid":123}');
  await writeFile(join(source, '.game-graph', 'workspace.json'), '{"kind":"workspace"}');
  await writeFile(join(source, '.game-graph', 'mechanics', 'rule.mechanic.json'), '{"id":"rule"}');

  await copyExampleFixture(destination, source);

  await assert.rejects(access(join(destination, '.game-graph', '.game-graph.lock')), { code: 'ENOENT' });
  assert.equal(await readFile(join(destination, '.game-graph', 'workspace.json'), 'utf8'), '{"kind":"workspace"}');
  assert.equal(await readFile(join(destination, '.game-graph', 'mechanics', 'rule.mechanic.json'), 'utf8'), '{"id":"rule"}');
});
