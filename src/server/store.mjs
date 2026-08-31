import { realpath } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readWorkspace, assertRelativeFile, ensureWorkspaceDirectory } from './workspace.mjs';
import { encode, commitFile, acquireWorkspaceLock } from './files.mjs';
import { assertDocument, validateWorkspace, ContractError } from '../domain/validate.mjs';

const fail = (code, message) => { throw new ContractError(code, message); };
export async function createWorkspaceStore(workspaceRoot) {
  const root = await realpath(resolve(workspaceRoot));
  const release = await acquireWorkspaceLock(root);
  let queue = Promise.resolve(), closed = false;
  const enqueue = operation => {
    if (closed) return Promise.reject(new ContractError('STORE_CLOSED', '工作区已关闭'));
    const result = queue.then(operation);
    // 失败交给请求调用者，不自动重试；后续独立操作仍可进入队列。
    queue = result.catch(() => {});
    return result;
  };
  try { await readWorkspace(root); } catch (error) { await release(); throw error; }
  const current = async revision => {
    const workspace = await readWorkspace(root);
    if (revision !== workspace.revision) fail('REVISION_CONFLICT', '磁盘文件或目录已改变。草稿未覆盖文件；请导出草稿并重新读取后合并。');
    return workspace;
  };
  const verified = async () => {
    try { return await readWorkspace(root); }
    catch (error) { fail('SAVE_UNCERTAIN', '提交后工作区回读失败：' + error.message + '。请核实磁盘内容。'); }
  };
  return {
    read: () => enqueue(() => readWorkspace(root)),
    save: body => enqueue(async () => {
      const { revision, kind, id, document } = body;
      const workspace = await current(revision);
      assertDocument(document, kind);
      let file;
      if (kind === 'definitions') {
        file = workspace.manifest.definitions; workspace.definitions = document;
      } else if (kind === 'analysis') {
        const index = workspace.analyses.findIndex(graph => graph.id === id);
        if (index < 0 || document.id !== id) fail('ID_CHANGED', '分析图 ID 不存在或被更改');
        file = workspace.files.find(item => item.kind === 'analysis' && item.id === id).path;
        workspace.analyses[index] = document;
      } else if (kind === 'workspace') {
        const { name: oldName, compositions: oldViews, lastView: oldView, ...oldFixed } = workspace.manifest;
        const { name, compositions, lastView, ...fixed } = document;
        if (!isDeepStrictEqual(oldFixed, fixed)) fail('MANIFEST_PROTECTED', '页面仅允许修改工作区名称与视图，不改变根目录、身份或统一定义入口。');
        file = 'workspace.json'; workspace.manifest = document;
      }
      validateWorkspace(workspace);
      await commitFile(root, file, encode(document));
      return verified();
    }),
    createAnalysis: body => enqueue(async () => {
      const workspace = await current(body.revision), document = body.document;
      assertDocument(document, 'analysis');
      if (workspace.analyses.some(graph => graph.id === document.id)) fail('DUPLICATE_ID', '此分析图 ID 已存在');
      if (workspace.analyses.length >= 300) fail('FILE_LIMIT', '工作区最多 300 张分析图');
      const file = body.file ?? ('analyses/' + document.id + '.analysis.json');
      assertRelativeFile(file);
      if (!file.endsWith('.analysis.json') || file.split('/').some(part => part.startsWith('.') || part === 'node_modules')) {
        fail('UNSAFE_PATH', '分析图须使用 .analysis.json 后缀，不能存入隐藏或依赖目录');
      }
      workspace.analyses.push(document); validateWorkspace(workspace);
      const text = encode(document), parent = posix.dirname(file);
      await ensureWorkspaceDirectory(root, parent === '.' ? '' : parent);
      try { await commitFile(root, file, text, { create: true }); }
      catch (error) { error.message += '；目标：' + file + '。父目录可能已创建，请重新读取目录。'; throw error; }
      // 文件一旦完整创建，就由目录扫描发现，无第二份登记清单。
      return verified();
    }),
    close: async () => { if (closed) return; closed = true; await queue; await release(); },
  };
}
