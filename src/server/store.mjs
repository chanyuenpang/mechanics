import { open, realpath, rename, unlink, readFile, mkdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readWorkspace, workspacePath } from './workspace.mjs';
import { assertDocument, validateWorkspace, ContractError } from '../domain/validate.mjs';

const fail = (code, message) => { throw new ContractError(code, message); };
const encode = document => {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) fail('FILE_LIMIT', '保存内容超过 2 MiB');
  return text;
};

async function writeExclusive(path, text) {
  const handle = await open(path, 'wx');
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

// 只有 rename 成功才算提交；提交后的任何回读失败都必须暴露不确定状态。
async function replaceFile(root, file, text) {
  const path = await workspacePath(root, file);
  const temp = `${path}.${randomUUID()}.rule-analyzer.tmp`;
  let committed = false;
  try {
    await writeExclusive(temp, text);
    await workspacePath(root, file);
    await rename(temp, path);
    committed = true;
    if (await readFile(path, 'utf8') !== text) fail('SAVE_UNCERTAIN', '写入已提交，但回读内容不一致；请重新读取核实，勿直接重试。');
  } catch (error) {
    if (committed) fail('SAVE_UNCERTAIN', `写入已提交，回读失败：${error.message}。请重新读取核实。`);
    try { await unlink(temp); } catch (cleanup) {
      if (cleanup.code !== 'ENOENT') error.message += `；临时文件清理失败：${cleanup.message}`;
    }
    throw error;
  }
}

export async function createWorkspaceStore(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const lock = resolve(root, '.rule-analyzer.lock');
  const identity = JSON.stringify({ pid: process.pid, owner: randomUUID() });
  try { await writeExclusive(lock, identity); }
  catch (error) {
    if (error.code === 'EEXIST') fail('WORKSPACE_LOCKED', '工作区已有编辑服务或遗留锁。请关闭已有服务；确认没有写入者后才可手动移除 .rule-analyzer.lock。');
    throw error;
  }
  let queue = Promise.resolve(), closed = false;
  const enqueue = operation => {
    if (closed) return Promise.reject(new ContractError('STORE_CLOSED', '工作区已关闭'));
    const result = queue.then(operation);
    // 失败交给当前请求；队列继续接受后续独立请求，不重试失败操作。
    queue = result.catch(() => {});
    return result;
  };
  const release = async () => {
    if (await readFile(lock, 'utf8') !== identity) fail('LOCK_CHANGED', '工作区锁已被外部修改，未删除。');
    await unlink(lock);
  };
  try { await readWorkspace(root); } catch (error) { await release(); throw error; }
  const current = async revision => {
    const workspace = await readWorkspace(root);
    if (revision !== workspace.revision) fail('REVISION_CONFLICT', '磁盘文件已改变。草稿未覆盖文件；请导出草稿并重新读取后合并。');
    return workspace;
  };
  const verified = async () => {
    try { return await readWorkspace(root); }
    catch (error) { fail('SAVE_UNCERTAIN', `提交后工作区回读失败：${error.message}。请核实磁盘内容。`); }
  };
  return {
    read: () => enqueue(() => readWorkspace(root)),
    save: body => enqueue(async () => {
      const { revision, kind, id, document } = body;
      const workspace = await current(revision);
      assertDocument(document, kind);
      let file;
      if (kind === 'definitions') {
        file = workspace.manifest.definitions;
        workspace.definitions = document;
      } else if (kind === 'analysis') {
        const index = workspace.analyses.findIndex(graph => graph.id === id);
        if (index < 0 || document.id !== id) fail('ID_CHANGED', '分析图 ID 不存在或被更改');
        file = workspace.manifest.analyses[index]; workspace.analyses[index] = document;
      } else if (kind === 'workspace') {
        const { name: oldName, compositions: oldViews, lastView: oldView, ...oldFixed } = workspace.manifest;
        const { name, compositions, lastView, ...fixed } = document;
        if (!isDeepStrictEqual(oldFixed, fixed)) fail('MANIFEST_PROTECTED', '工作区保存仅允许修改名称、叠加组合和最近视图；文件登记由新建接口管理。');
        file = 'workspace.json'; workspace.manifest = document;
      }
      validateWorkspace(workspace);
      await replaceFile(root, file, encode(document));
      return verified();
    }),
    createAnalysis: body => enqueue(async () => {
      const workspace = await current(body.revision);
      const document = body.document;
      assertDocument(document, 'analysis');
      if (workspace.analyses.some(graph => graph.id === document.id)) fail('DUPLICATE_ID', '此分析图 ID 已登记');
      if (workspace.analyses.length >= 300) fail('FILE_LIMIT', '工作区最多登记 300 张分析图');
      const file = `analyses/${document.id}.analysis.json`;
      workspace.manifest.analyses.push(file); workspace.analyses.push(document);
      validateWorkspace(workspace);
      const text = encode(document), manifestText = encode(workspace.manifest);
      const directory = resolve(root, 'analyses');
      try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) fail('UNSAFE_PATH', 'analyses 必须是工作区内的普通目录');
      const path = await workspacePath(root, file, { allowMissing: true });
      try { await writeExclusive(path, text); }
      catch (error) {
        if (error.code !== 'EEXIST') fail('CREATE_PARTIAL', `分析文件创建失败，可能留下未登记文件 ${file}：${error.message}`);
        // 只允许同一请求留下的完整原文重试，不接管其他内容。
        if (await readFile(path, 'utf8') !== text) fail('FILE_EXISTS', `未登记文件 ${file} 已存在且内容不同，未覆盖。`);
      }
      try { await replaceFile(root, 'workspace.json', manifestText); }
      catch (error) {
        if (error.code === 'SAVE_UNCERTAIN') throw error;
        fail('CREATE_PARTIAL', `已创建 ${file}，但清单登记失败：${error.message}。保留原请求可重试，勿自动导入。`);
      }
      return verified();
    }),
    close: async () => { if (closed) return; closed = true; await queue; await release(); },
  };
}
