import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyExampleFixture } from './example-fixture.mjs';

test('复制示例夹具仅排除运行态锁，并保留其他文件', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'mechanics-example-fixture-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'), destination = join(temp, 'destination');
  await mkdir(join(source, '.mechanics', 'mechanics'), { recursive: true });
  await writeFile(join(source, '.mechanics', '.mechanics.lock'), '{"pid":123}');
  await writeFile(join(source, '.mechanics', 'workspace.json'), '{"kind":"workspace"}');
  await writeFile(join(source, '.mechanics', 'mechanics', 'rule.mechanic.json'), '{"id":"rule"}');

  await copyExampleFixture(destination, source);

  await assert.rejects(access(join(destination, '.mechanics', '.mechanics.lock')), { code: 'ENOENT' });
  assert.equal(await readFile(join(destination, '.mechanics', 'workspace.json'), 'utf8'), '{"kind":"workspace"}');
  assert.equal(await readFile(join(destination, '.mechanics', 'mechanics', 'rule.mechanic.json'), 'utf8'), '{"id":"rule"}');
});
