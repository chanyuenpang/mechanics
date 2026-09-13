import { normalizeSearchTerm } from '../domain/identity.mjs';

const text = value => String(value ?? '');
// 侧栏是面向人阅读的文件列表：中文按本地化顺序，嵌入的编号按自然数排序。
const textCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
const compareText = (left, right) => textCollator.compare(left, right);
const normalized = value => normalizeSearchTerm(text(value));
const normalizedPath = value => text(value).replaceAll('\\', '/').replace(/^\.\//u, '');
const filename = path => normalizedPath(path).split('/').at(-1) ?? '';

function uniqueIds(ids = []) {
  const result = [], seen = new Set();
  for (const id of ids) if (!seen.has(id)) { seen.add(id); result.push(id); }
  return result;
}

function resourceFiles(workspace, kind) {
  const files = new Map();
  for (const file of workspace.files ?? []) {
    if (file.kind !== kind) continue;
    if (files.has(file.id)) throw new Error(`${kind} 文件 ID 重复：${file.id}`);
    files.set(file.id, normalizedPath(file.path));
  }
  return files;
}

function baseRows(resources, files, kind, currentId, recentIds) {
  const recents = new Map(uniqueIds(recentIds).map((id, index) => [id, index]));
  const names = new Map();
  for (const resource of resources) {
    const key = normalized(resource.name);
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  return resources.map(resource => {
    const fullPath = files.get(resource.id);
    if (!fullPath) throw new Error(`${kind} 缺少文件路径：${resource.id}`);
    const duplicateName = names.get(normalized(resource.name)) > 1;
    return {
      kind,
      id: resource.id,
      name: resource.name,
      fullPath,
      duplicateName,
      disambiguationPath: duplicateName ? fullPath : null,
      current: resource.id === currentId,
      recent: recents.has(resource.id),
      recentRank: recents.get(resource.id) ?? null,
      searchText: [resource.name, resource.id, fullPath].map(normalized),
      resource,
    };
  });
}

function compareRows(left, right) {
  // 侧栏以用户实际看见的文件名称排序；磁盘路径仅用于同名时稳定消歧。
  // 不能用技术文件名（例如 return-surge-...）作为首键，否则带编号的显示名称会显得乱序。
  return compareText(normalized(left.name), normalized(right.name))
    || compareText(normalized(filename(left.fullPath)), normalized(filename(right.fullPath)))
    || compareText(normalized(left.id), normalized(right.id))
    || compareText(normalized(left.fullPath), normalized(right.fullPath));
}

function matches(row, query) {
  const words = normalized(query).split(/\s+/u).filter(Boolean);
  return words.every(word => row.searchText.some(value => value.includes(word)));
}

function publicRow(row) {
  const { searchText, resource, ...result } = row;
  return result;
}

function viewRow(row) {
  const registrations = row.resource.mechanicRegistrations ?? [];
  return publicRow({
    ...row,
    registeredCount: registrations.length,
    visibleCount: registrations.filter(item => item.visible).length,
  });
}

function mechanicRow(row, commonRoot = '') {
  return publicRow({
    ...row,
    scope: row.resource.scope,
    displayPath: commonRoot && row.fullPath.startsWith(commonRoot) ? row.fullPath.slice(commonRoot.length) : row.fullPath,
  });
}

function mechanicCommonRoot(rows, directories) {
  return (rows.length > 0 || directories.includes('mechanics')) && rows.every(row => row.fullPath.startsWith('mechanics/')) ? 'mechanics/' : '';
}

function directoryTree(rows, commonRoot, directories) {
  const root = { directories: new Map(), mechanics: [] };
  const directoryNode = parts => {
    let node = root, display = '', full = commonRoot;
    for (const part of parts) {
      display += part + '/'; full += part + '/';
      if (!node.directories.has(part)) node.directories.set(part, { name: part, path: display, fullPath: full, directories: new Map(), mechanics: [] });
      node = node.directories.get(part);
    }
    return node;
  };
  for (const directory of directories) {
    if (directory !== 'mechanics' && !directory.startsWith('mechanics/')) continue;
    const display = commonRoot ? directory.slice('mechanics'.length).replace(/^\//, '') : directory;
    directoryNode(display ? display.split('/') : []);
  }
  for (const row of rows) {
    const item = mechanicRow(row, commonRoot), parts = item.displayPath.split('/'); parts.pop();
    directoryNode(parts).mechanics.push(item);
  }
  const materialize = node => [
    ...[...node.directories.values()]
      .sort((left, right) => compareText(normalized(left.name), normalized(right.name)) || compareText(left.fullPath, right.fullPath))
      .map(directory => ({
        kind: 'directory', name: directory.name, path: directory.path, fullPath: directory.fullPath,
        children: materialize(directory),
      })),
    ...node.mechanics.sort(compareRows),
  ];
  return materialize(root);
}

export function buildViewNavigation(workspace, { query = '', currentId = null, recentIds = [] } = {}) {
  const rows = baseRows(workspace.views ?? [], resourceFiles(workspace, 'view'), 'view', currentId, recentIds).sort(compareRows);
  return {
    query: text(query),
    totalCount: rows.length,
    matchCount: rows.filter(row => matches(row, query)).length,
    items: rows.filter(row => matches(row, query)).map(viewRow),
  };
}

export function buildMechanicNavigation(workspace, { query = '', currentId = null, recentIds = [] } = {}) {
  const rows = baseRows(workspace.mechanics ?? [], resourceFiles(workspace, 'mechanic'), 'mechanic', currentId, recentIds).sort(compareRows);
  const directories = (workspace.directories ?? []).map(normalizedPath);
  const commonRoot = mechanicCommonRoot(rows, directories), searching = normalized(query).length > 0;
  return {
    query: text(query),
    mode: searching ? 'search' : 'browse',
    totalCount: rows.length,
    matchCount: searching ? rows.filter(row => matches(row, query)).length : rows.length,
    commonRoot,
    featured: searching ? [] : rows.filter(row => row.current || row.recent).map(row => mechanicRow(row, commonRoot)),
    items: searching ? rows.filter(row => matches(row, query)).map(row => mechanicRow(row, commonRoot)) : [],
    tree: searching ? [] : directoryTree(rows, commonRoot, directories),
  };
}

export function buildResourceNavigation(workspace, {
  viewQuery = '', mechanicQuery = '', currentViewId = null, currentMechanicId = null,
  recentViewIds = [], recentMechanicIds = [],
} = {}) {
  return {
    views: buildViewNavigation(workspace, { query: viewQuery, currentId: currentViewId, recentIds: recentViewIds }),
    mechanics: buildMechanicNavigation(workspace, { query: mechanicQuery, currentId: currentMechanicId, recentIds: recentMechanicIds }),
  };
}
