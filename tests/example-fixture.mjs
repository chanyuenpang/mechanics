import { cp, mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const cardGameExampleRoot = fileURLToPath(new URL('../examples/card-game/', import.meta.url));

// 测试服务与 CLI 不得读取或写入真实用户配置，结束后恢复进程环境。
export async function isolateUserConfig() {
  const root = await mkdtemp(join(tmpdir(), 'mechanics-test-config-'));
  const previous = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  return {
    env: { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root },
    async close() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function copyExampleFixture(destination, source = cardGameExampleRoot) {
  await cp(source, destination, { recursive: true, filter: path => basename(path) !== '.mechanics.lock' });
}
