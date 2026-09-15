import { posix } from 'node:path';

/**
 * 「新建机制图默认进入单独导出」的唯一政策定义。
 *
 * - 只在 curated 模式（exportSelections 是数组）下补选择；legacy-all 模式不得新建数组，
 *   否则会把「全导出」悄悄收窄成「导出一个」。
 * - 机制图与其**直接**文件夹互斥（validate 的 DOCUMENT_EXPORT_CONFLICT）：文件夹已选中就不补。
 * - 同一条选择已存在则不重复，避免 canonical 产生无意义字节变动。
 * - 视图永不自动进清单：导出单位只有机制图与文件夹，视图是网页上的阅读入口。
 *
 * 返回 true 表示清单确实发生变化，调用方负责落盘。
 */
export function selectCreatedMechanic(manifest, mechanicId, folder = '') {
  const selections = manifest?.exportSelections;
  if (!Array.isArray(selections)) return false;
  if (selections.some(selection => selection.kind === 'mechanic' && selection.mechanicId === mechanicId)) return false;
  if (folder && selections.some(selection => selection.kind === 'folder' && selection.folder === folder)) return false;
  selections.push({ kind: 'mechanic', mechanicId });
  return true;
}

/** 由 canonical 相对路径推导机制图所在的直接文件夹；与 validate.mjs 与 store 使用同一口径。 */
export function mechanicFolderOf(file) {
  const parent = posix.dirname(file);
  return parent === 'mechanics' ? '' : parent.startsWith('mechanics/') ? parent.slice('mechanics/'.length) : parent;
}

const parentFolder = path => {
  const parent = posix.dirname(path) === '.' ? '' : posix.dirname(path);
  return parent === 'mechanics' ? '' : parent.startsWith('mechanics/') ? parent.slice('mechanics/'.length) : parent;
};

// 设置页只消费这个派生结构；互斥性由 canonical 清单和同一套 folder 归属决定。
export function documentExportStructure(workspace) {
  const mechanismPaths = new Map((workspace.files ?? []).filter(file => file.kind === 'mechanic').map(file => [file.id, file.path]));
  const mechanics = workspace.mechanics.map(mechanic => ({ id: mechanic.id, name: mechanic.name, scope: mechanic.scope,
    folder: parentFolder(mechanismPaths.get(mechanic.id) ?? '') })).sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  const folders = [...new Set(mechanics.map(item => item.folder).filter(Boolean))].sort().map(path => ({ path, label: posix.basename(path),
    mechanicIds: mechanics.filter(item => item.folder === path).map(item => item.id) }));
  const selectionMode = Array.isArray(workspace.manifest.exportSelections) ? 'curated' : 'legacy-all';
  const selections = structuredClone(workspace.manifest.exportSelections ?? []);
  const selectedFolders = new Set(selections.filter(item => item.kind === 'folder').map(item => item.folder));
  const selectedMechanics = new Set(selections.filter(item => item.kind === 'mechanic').map(item => item.mechanicId));
  return {
    selectionMode,
    selections,
    folders: folders.map(folder => ({ ...folder,
      selected: selectedFolders.has(folder.path),
      disabledBy: folder.mechanicIds.filter(id => selectedMechanics.has(id)).map(id => `mechanic:${id}`),
    })),
    mechanics: mechanics.map(mechanic => ({ ...mechanic,
      selected: selectedMechanics.has(mechanic.id),
      disabledBy: selectedFolders.has(mechanic.folder) ? [`folder:${mechanic.folder}`] : [],
    })),
    views: workspace.views.map(view => ({ id: view.id, name: view.name,
      mechanicIds: view.mechanicRegistrations.filter(item => item.visible).map(item => item.mechanicId),
      selected: selections.some(item => item.kind === 'view' && item.viewId === view.id), disabledBy: []
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
