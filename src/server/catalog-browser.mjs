import { readFile, lstat } from 'node:fs/promises';
import { buildCatalog } from './catalog.mjs';
import { ContractError } from '../domain/validate.mjs';
import { workspacePath } from './workspace.mjs';

const stale = message => { throw new ContractError('CATALOG_STALE', '导出的机制文档不可用：' + message); };

// 此读取器只接受本次 canonical 快照应当生成的精确文件集合，绝不把 canonical 文本当成导出结果返回。
export async function readCatalogBrowser(context, catalog, selection = null) {
  // 直接调用仅供已有单元测试；服务层始终传入已建立的 catalog 快照。
  catalog = catalog.files instanceof Map ? catalog : buildCatalog(catalog);
  const conceptId = typeof selection === 'string' ? selection : null;
  if (conceptId !== null && (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(conceptId))) {
    throw new ContractError('INVALID_CONCEPT_ID', '概念文档必须使用稳定英文 conceptId');
  }
  const expected = catalog.files;
  let documentFile = conceptId === null ? 'README.md' : 'concepts.md';
  if (selection !== null && typeof selection !== 'string') {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).length !== 1 || typeof selection.file !== 'string') {
      throw new ContractError('INVALID_DOCUMENT_SELECTION', '文档选择必须是概念 ID 或唯一 file 字段');
    }
    documentFile = selection.file;
  }
  if (conceptId !== null && !catalog.dossiers.has(conceptId)) throw new ContractError('CONCEPT_NOT_FOUND', '导出目录中没有该概念：' + conceptId);
  if (documentFile === 'AGENTS.md') throw new ContractError('DOCUMENT_NOT_FOUND', '导出目录中没有该机制文档：' + documentFile);
  if (!expected.has(documentFile)) {
    // 仅探测当前请求的安全路径：遗留或手工加入的文档说明导出集合已失真，
    // 但不存在或越界的请求仍不是目录状态问题。
    try { await readFile(await workspacePath(context.exportRoot, documentFile, { extensions: ['.md'] }), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'UNSAFE_PATH') throw new ContractError('DOCUMENT_NOT_FOUND', '导出目录中没有该机制文档：' + documentFile);
      stale(`无法读取 ${documentFile}：${error.message}`);
    }
    stale(`${documentFile} 不受当前导出清单管理`);
  }
  // 文档页只能使用打开项目或发布时建立的快照。读取时校验受管指南和当前目标，
  // 不扫描目录、更不读取无关 Markdown；无关目录故障不能占住交互队列。
  try {
    const info = await lstat(context.exportRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) stale('导出根不是普通目录');
    const guide = await readFile(await workspacePath(context.exportRoot, 'AGENTS.md', { extensions: ['.md'] }), 'utf8');
    // 指南仅证明根目录归属。它携带的版本戳会因未请求文档的 canonical 变化而改变，
    // 不能让单篇读取退化成对整个导出目录的过期检查。
    const ownership = expected.get('AGENTS.md').match(/<!-- mechanics-agent-docs:v8 workspace-id:[^\r\n]+ -->/)?.[0];
    if (!ownership || !guide.includes(ownership)) stale('受管指南不属于当前工作区');
  } catch (error) {
    if (error.code === 'CATALOG_STALE') throw error;
    stale('无法读取导出目录：' + error.message);
  }
  let markdown;
  try { markdown = await readFile(await workspacePath(context.exportRoot, documentFile, { extensions: ['.md'] }), 'utf8'); }
  catch (error) { stale(`无法读取 ${documentFile}：${error.message}`); }
  if (markdown !== expected.get(documentFile)) stale(`${documentFile} 与当前导出内容不一致`);
  return {
    semanticRevision: catalog.semanticRevision, documentRevision: catalog.documentRevision,
    document: { kind: documentFile === 'README.md' ? 'index' : documentFile === 'concepts.md' ? 'concepts' : documentFile.startsWith('folders/') ? 'folder' : documentFile.startsWith('views/') ? 'view' : 'mechanic', file: documentFile,
      ...(conceptId === null ? {} : { conceptId }), markdown },
    documents: [
      ...catalog.folders.map(({ path, label, file, mechanics }) => ({ kind: 'folder', id: path, label, file, mechanicCount: mechanics.length })),
      ...catalog.mechanics.map(({ id, name, scope, file }) => ({ kind: 'mechanic', id, label: name, scope, file })),
      ...catalog.views.map(({ id, name, file, mechanics }) => ({ kind: 'view', id, label: name, file, mechanicCount: mechanics.length })),
    ],
    concepts: [...catalog.dossiers.values()].map(({ concept }) => ({ id: concept.id, label: concept.label, aliases: concept.aliases })),
  };
}
