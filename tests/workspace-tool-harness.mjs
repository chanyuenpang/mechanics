import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { copyExampleFixture } from './example-fixture.mjs';

const exec = promisify(execFile);
export const workspaceToolSource = fileURLToPath(new URL('../workspace-tools/workspace-tool.mjs', import.meta.url));

// 项目内工具是单文件分发形态，示例夹具本身不含 .mechanics/tools：按安装路径放进去再运行。
export async function installWorkspaceTool(projectRoot) {
  const tool = join(projectRoot, '.mechanics/tools/workspace-tool.mjs');
  await mkdir(dirname(tool), { recursive: true });
  await cp(workspaceToolSource, tool);
  return tool;
}

export async function runWorkspaceTool(projectRoot, args) {
  const tool = await installWorkspaceTool(projectRoot);
  const { stdout } = await exec(process.execPath, [tool, ...args], { timeout: 15_000 });
  return JSON.parse(stdout);
}

// 工具的失败一律是 stderr 上的 JSON 事实；测试读取它而不是把失败当成退出码噪声。
export async function runWorkspaceToolFailure(projectRoot, args) {
  try {
    await runWorkspaceTool(projectRoot, args);
  } catch (error) {
    return JSON.parse(String(error.stderr));
  }
  throw new Error('期望工具失败，但它成功了：' + args.join(' '));
}

export async function copiedExampleProject(t) {
  const parent = await mkdtemp(join(tmpdir(), 'mechanics-tool-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const projectRoot = join(parent, 'card-game');
  await copyExampleFixture(projectRoot);
  return projectRoot;
}
