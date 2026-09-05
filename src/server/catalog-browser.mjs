import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import { buildCatalog } from './catalog.mjs';
import { ContractError } from '../domain/validate.mjs';
import { workspacePath } from './workspace.mjs';

const stale = message => { throw new ContractError('CATALOG_STALE', '导出的机制文档不可用：' + message); };

// 此读取器只接受本次 canonical 快照应当生成的精确文件集合，绝不把 canonical 文本当成导出结果返回。
export async function readCatalogBrowser(context, workspace, selection = null) {
  const conceptId = typeof selection === 'string' ? selection : null;
  if (conceptId !== null && (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(conceptId))) {
    throw new ContractError('INVALID_CONCEPT_ID', '概念文档必须使用稳定英文 conceptId');
  }
  const catalog = buildCatalog(workspace);
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
  if (!expected.has(documentFile) || documentFile === 'AGENTS.md') throw new ContractError('DOCUMENT_NOT_FOUND', '导出目录中没有该机制文档：' + documentFile);
  const expectedDirectories = new Set();
  for (const file of expected.keys()) {
    let directory = posix.dirname(file);
    while (directory !== '.') { expectedDirectories.add(directory); directory = posix.dirname(directory); }
  }
  const actualFiles = new Set(), actualDirectories = new Set();
  const visit = async directory => {
    for (const entry of await readdir(resolve(context.exportRoot, directory), { withFileTypes: true })) {
      const file = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) stale('包含链接：' + file);
      if (entry.isDirectory()) { if (!expectedDirectories.has(file)) stale('包含未知目录：' + file); actualDirectories.add(file); await visit(file); }
      else if (entry.isFile() && expected.has(file)) actualFiles.add(file);
      else stale('包含未知或非普通生成文件：' + file);
    }
  };
  try {
    const info = await lstat(context.exportRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) stale('导出根不是普通目录');
    await visit('');
  } catch (error) { stale('无法读取导出目录：' + error.message); }
  if (actualFiles.size !== expected.size || actualDirectories.size !== expectedDirectories.size) stale('目录包含缺失的生成文件');
  let markdown;
  for (const [file, text] of expected) {
    let actual;
    try { actual = await readFile(await workspacePath(context.exportRoot, file, { extensions: ['.md'] }), 'utf8'); }
    catch (error) { stale(`无法读取 ${file}：${error.message}`); }
    if (actual !== text) stale(`${file} 与当前导出内容不一致`);
    if (file === documentFile) markdown = actual;
  }
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
