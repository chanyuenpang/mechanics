import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeExclusive } from './files.mjs';

// 本机工具偏好独立于游戏工作区；只允许一个固定的布尔选项。
export function preferencePath() {
  return join(process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'game-graph', 'preferences.json');
}
function validate(value) {
  if (!value || value.version !== 1 || typeof value.snapToGrid !== 'boolean' || Object.keys(value).some(key => !['version', 'snapToGrid'].includes(key))) throw new Error('工具偏好文件格式无效，请检查 preferences.json');
  return value;
}
export function createPreferences(path = preferencePath()) {
  let queue = Promise.resolve();
  const checkPath = async () => {
    for (const item of [dirname(path), path]) {
      try { if ((await lstat(item)).isSymbolicLink()) throw new Error('工具偏好不允许符号链接或目录重定向'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const read = async () => {
    await checkPath();
    try { return validate(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, snapToGrid: false }; throw error; }
  };
  return { read, save(value) {
    const operation = queue.then(async () => {
      validate(value); await read();
      await mkdir(dirname(path), { recursive: true });
      const temporary = path + '.' + randomUUID() + '.tmp';
      let committed = false;
      try {
        await writeExclusive(temporary, JSON.stringify(value) + '\n');
        await checkPath();
        await rename(temporary, path); committed = true;
        const saved = await read();
        if (saved.snapToGrid !== value.snapToGrid) throw new Error('偏好已被其他窗口修改，请重新读取');
        return saved;
      } catch (error) {
        if (committed) { error.code = 'SAVE_UNCERTAIN'; throw error; }
        try { await unlink(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.message += '；清理失败：' + cleanup.message; }
        throw error;
      }
    });
    queue = operation.catch(() => {});
    return operation;
  } };
}
