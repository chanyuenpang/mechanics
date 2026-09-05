import { posix } from 'node:path';

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
