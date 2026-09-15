import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 项目内受管工具的相对位置：由 mech init/sync 从 workspace-tools/ 同步进项目。 */
export const WORKSPACE_TOOL_RELATIVE_PATH = join('.mechanics', 'tools', 'workspace-tool.mjs');
/** 工作区标记文件：向上定位项目根的唯一依据。 */
const WORKSPACE_MARKER = join('.mechanics', 'workspace.json');
/** 一次调用的输出预算；超出即显式失败，绝不返回被截断的 JSON 当作结果。 */
const STDOUT_MAX_BYTES = 4 * 1024 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;
const GRACE_MS = 2000;

const isFile = async path => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** 从会话 cwd 向上定位最近的 .mechanics 工作区，返回项目根。 */
export async function resolveProjectRoot(startDirectory, { isFileProbe = isFile } = {}) {
  if (typeof startDirectory !== 'string' || !startDirectory.trim()) return undefined;
  let current = startDirectory;
  for (;;) {
    if (await isFileProbe(join(current, WORKSPACE_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 解析调用会话的工作目录；解析不到就显式失败，不退化成进程 cwd。 */
export function resolveSessionDirectory(agent) {
  for (const candidate of [agent?.session?.header?.cwd, agent?.session?.cwd, agent?.session?.meta?.cwd]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, details });

/** 读取收集模式下的一个流；缺失与截断都是显式事实，不做静默兜底。 */
function readStream(handle, stream) {
  const reader = handle.collected?.[stream];
  if (reader === undefined) return { text: '', truncated: false };
  const read = reader.readFrom(0);
  return { text: read.text, truncated: read.lossy === true, spillPath: read.spillPath };
}

/**
 * 运行项目内受管工具一次，返回它输出的 JSON。
 * argv 绝不经过 shell 解释；非零退出按工具的 stderr JSON 事实抛出。
 */
export async function runWorkspaceTool(runtime, projectRoot, argv, signal) {
  const tool = join(projectRoot, WORKSPACE_TOOL_RELATIVE_PATH);
  if (!(await isFile(tool))) {
    throw failure('WORKSPACE_TOOL_MISSING', `项目内受管工具不存在：${tool}。请先在 ${projectRoot} 运行 mech init 或 mech sync，把 workspace-tool.mjs 同步到 .mechanics/tools/。`);
  }
  const handle = runtime.spawn({
    argv: [process.execPath, tool, ...argv],
    cwd: projectRoot,
    stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
    graceMs: GRACE_MS,
    signal,
  });
  const outcome = await handle.done;
  const stdout = readStream(handle, 'stdout');
  const stderr = readStream(handle, 'stderr');
  if (outcome.exitCode !== 0) {
    let parsed;
    try {
      parsed = JSON.parse(stderr.text);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed.error === 'string') {
      const { error, message, ...details } = parsed;
      throw failure(error, message ?? '工作区工具失败', details);
    }
    throw failure('WORKSPACE_TOOL_FAILED', `工作区工具退出码 ${String(outcome.exitCode)}：${stderr.text.trim() || '无 stderr 输出'}`);
  }
  if (stdout.truncated) {
    throw failure('WORKSPACE_TOOL_OUTPUT_TRUNCATED', `工作区工具输出超过 ${STDOUT_MAX_BYTES} 字节被截断，拒绝把不完整 JSON 当作结果。${stdout.spillPath ? ` 完整输出见 ${stdout.spillPath}` : ''}`);
  }
  try {
    return JSON.parse(stdout.text);
  } catch {
    throw failure('WORKSPACE_TOOL_OUTPUT_INVALID', '工作区工具未输出可解析的 JSON。');
  }
}
