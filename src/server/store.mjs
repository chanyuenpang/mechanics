import { realpath, rename, readdir, rmdir, lstat, unlink, readFile } from 'node:fs/promises';
import { resolve, relative, posix, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readWorkspace, readDocument, discover, assertRelativeFile, ensureWorkspaceDirectory, workspacePath, workspaceResourceRevisions, workspaceRevision, semanticWorkspaceDocument } from './workspace.mjs';
import { encode, commitFile, commitFiles, acquireWorkspaceLock } from './files.mjs';
import { planV7ToV8Migration, planV8ToV9Migration, planV9ToV10Migration, planV10ToV11Migration, planV11ToV12Migration, planV12ToV13Migration, planV13ToV14Migration, WORKSPACE_MIGRATION_STEPS, planV9DanglingNodeRepair } from './migration.mjs';
import { assertDocument, validateWorkspace, ContractError } from '../domain/validate.mjs';
import { composeView } from '../domain/view.mjs';
import { repairPresentationMemberReferences } from '../domain/presentation.mjs';
import { projectDisplayGraph } from '../domain/taxonomy-presentation.mjs';
import { documentExportStructure, mechanicFolderOf, selectCreatedMechanic } from '../domain/document-export.mjs';
import { readQuerySnapshot } from './query-snapshot.mjs';
import { readCatalogBrowser } from './catalog-browser.mjs';
import { assertCatalogRemovable, buildCatalog, inspectCatalogPublication, publishCatalog, removeCatalog } from './catalog.mjs';
import { projectContext, WORKSPACE_DIRECTORY } from './project-context.mjs';
import { applyAgentMutation } from './agent-mutation.mjs';
import { semanticRuleId } from '../domain/identity.mjs';
import { compose } from '../domain/graph.mjs';
import { graphPositions } from '../web/view-files.mjs';
import { arrangeGraphWithRoutes } from '../web/layout.mjs';
import { autoLayoutGraph } from '../web/auto-layout.mjs';
import { createRouteCache } from '../web/route-cache.mjs';
import ELK from 'elkjs/lib/elk.bundled.js';
import cola from 'webcola';

const fail = (code, message, details = {}) => { throw Object.assign(new ContractError(code, message), details); };
export async function createWorkspaceStore(workspaceRoot, { isolateResources = false } = {}) {
  const root = await realpath(resolve(workspaceRoot));
  let queue = Promise.resolve(), closed = false;
  // 浏览与修复只读取可用资源；严格全量校验仍由发布、迁移与显式 validate 使用。
  const readAvailable = () => readWorkspace(root, { isolateResources });
  // 文档是 canonical 的派生物：最多只保留一份正在发布的工作和最新一份待发布快照。
  // 它不进入写入队列，绝不能让磁盘导出拖慢图编辑、项目打开或 Agent mutation。
  let publicationWorker = null, pendingPublication = null, publication = null, workspaceSnapshot = null, exportSettingsSnapshot = null, catalogSnapshot = null;
  // 会话快照是打开后唯一的完整读取结果；只读页面不得为自身重新扫描 canonical。
  const refreshSnapshot = async () => {
    const workspace = await readAvailable();
    workspaceSnapshot = workspace;
    exportSettingsSnapshot = { ...documentExportStructure(workspace), revision: workspace.revision };
    catalogSnapshot = workspace.workspaceState === 'degraded' ? null : buildCatalog(workspace);
    return workspace;
  };
  const rememberCatalog = workspace => {
    workspaceSnapshot = workspace;
    exportSettingsSnapshot = { ...documentExportStructure(workspace), revision: workspace.revision };
    catalogSnapshot = workspace.workspaceState === 'degraded' ? null : buildCatalog(workspace);
    return catalogSnapshot;
  };
  const enqueue = operation => {
    if (closed) return Promise.reject(new ContractError('STORE_CLOSED', '工作区已关闭'));
    const result = queue.then(operation);
    // 失败交给请求调用者，不自动重试；后续独立操作仍可进入队列。
    queue = result.catch(() => {});
    return result;
  };
  // 打开和只读浏览不占用工作区。锁只覆盖一次完整写入事务，避免服务异常退出留下生命周期锁。
  await refreshSnapshot();
  const write = operation => enqueue(async () => {
    const release = await acquireWorkspaceLock(root);
    try { return await operation(); }
    finally { await release(); }
  });
  // 冲突判定的粒度必须与提交粒度一致：一次写入只落一个（或几个）资源，
  // 因此只有这些资源的语义版本变化才构成冲突。其他页面写别的文件、以及打开图时
  // 补算的坐标与连线路径，都不再拒绝一次本身安全的写入。
  // 客户端提交读取时的每资源版本（resourceRevisions）；缺少基线时退回整体比较，
  // 绝不放宽为无条件写入。
  const resourceRevision = (revisions, key) => {
    const [kind, id] = key.split(':');
    return kind === 'mechanic' ? revisions?.mechanics?.[id] : kind === 'view' ? revisions?.views?.[id] : revisions?.[kind];
  };
  const scopeOf = (...keys) => keys.filter(key => key !== null && key !== undefined);
  const resourcePath = (workspace, key) => {
    const [kind, id] = key.split(':');
    if (kind === 'mechanic' || kind === 'view') return workspace.files.find(file => file.kind === kind && file.id === id)?.path ?? key;
    if (kind === 'definitions') return workspace.manifest.definitions;
    if (kind === 'rules') return workspace.manifest.rules;
    return 'workspace.json';
  };
  const resourceKey = (kind, id) => kind === 'mechanic' || kind === 'view' ? kind + ':' + id : kind === 'workspace' ? 'workspace' : kind;
  const assertRevision = (body, workspace, keys = null, message = null) => {
    if (body?.revision === workspace.revision) return;
    const baseline = body?.resourceRevisions;
    const scope = Array.isArray(keys) && baseline && typeof baseline === 'object' && !Array.isArray(baseline) ? keys : null;
    const moved = scope ? scope.filter(key => resourceRevision(baseline, key) !== resourceRevision(workspace.resourceRevisions, key)) : null;
    if (moved && !moved.length) return;
    const changed = (moved ?? []).map(key => resourcePath(workspace, key));
    fail('REVISION_CONFLICT', (message ?? '磁盘文件或目录已改变。草稿未覆盖文件；请导出草稿并重新读取后合并。')
      + (changed.length ? '；本次写入涉及的文件已被其他写入者改变：' + changed.join('、') : ''));
  };
  const current = async (body, keys = null, message = null) => {
    // 写入和显式生成前仍完整读取，不能把会话快照伪称为磁盘最新状态。
    const workspace = await refreshSnapshot();
    assertRevision(body, workspace, keys, message);
    // 兼容读模型可能含旧协议或未解释扩展；在尚未显式迁移前禁止全量序列化覆盖原文件。
    if (workspace.compatibilityMode) fail('COMPATIBILITY_READ_ONLY', '当前工作区以兼容模式打开。请先显式迁移后再保存；原始文件未被修改。');
    return workspace;
  };
  // 普通单机制保存只依赖核心合同与目标文件。文件路径来自此前完整读取的前端快照，
  // 仍由 readDocument 逐段限制在工作区内；不读取或校验无关机制，避免其损坏阻塞目标保存。
  const readSingleMechanicSaveWorkspace = async ({ id, file }) => {
    if (typeof id !== 'string' || !id || typeof file !== 'string' || !file.endsWith('.mechanic.json')) {
      fail('MECHANIC_SAVE_INVALID', '保存机制必须提供有效 ID 与机制文件路径');
    }
    const { document: manifest } = await readDocument(root, 'workspace.json');
    assertDocument(manifest, 'workspace', 'workspace.json');
    const [{ document: definitions }, { document: rules }, { document: mechanic }] = await Promise.all([
      readDocument(root, manifest.definitions), readDocument(root, manifest.rules), readDocument(root, file),
    ]);
    assertDocument(definitions, 'definitions', manifest.definitions);
    assertDocument(rules, 'rules', manifest.rules);
    assertDocument(mechanic, 'mechanic', file);
    if (mechanic.id !== id) fail('MECHANIC_SAVE_MISMATCH', '机制文件与请求 ID 不一致：' + file);
    // 当前机制的引用只需与 definitions/rules 合同共同验证；其他机制是独立故障域。
    const resourceManifest = { ...manifest, compositions: [] };
    delete resourceManifest.exportSelections;
    delete resourceManifest.lastView;
    const files = [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' },
      { kind: 'definitions', path: manifest.definitions }, { kind: 'rules', path: manifest.rules },
      { kind: 'mechanic', id, path: file }];
    validateWorkspace({ manifest: resourceManifest, definitions, rules, mechanics: [mechanic], views: [], files });
    // 只将可独立解析并通过 shape 合同的机制视为已确认成员；坏文件保持未知，不能被当作不存在而删除引用。
    const { mechanicPaths } = await discover(root);
    const presentationMechanicIds = new Set([id]);
    await Promise.all(mechanicPaths.map(async path => {
      try { const candidate = (await readDocument(root, path)).document; assertDocument(candidate, 'mechanic', path); presentationMechanicIds.add(candidate.id); }
      catch { /* 局部坏机制属于独立故障域，不能阻断或触发删除。 */ }
    }));
    return { manifest, definitions, rules, mechanics: [mechanic], views: [], files, presentationMechanicIds,
      resourceRevisions: workspaceResourceRevisions({ manifest, definitions, rules, mechanics: [mechanic], views: [] }) };
  };
  // 兼容模式只允许按字段补丁写回展示数据，因此这里只比较顶层展示字段；
  // 语义版本另有 workspace.mjs 的深层形态（含嵌套 positions 与 lastView）。
  const compatiblePresentationFields = new Set(['positions', 'projectionPositions', 'routeCache', 'nodeColors', 'nodeStyles']);
  const withoutCompatiblePresentation = document => Object.fromEntries(Object.entries(document)
    .filter(([key]) => !compatiblePresentationFields.has(key)));
  // 兼容读取的规范化对象不能整体回写旧文件；但布局属于非语义展示数据，
  // 可以在保留原始协议及未知字段的前提下，按字段补丁写回同一资源。
  const saveCompatiblePresentation = async (workspace, { kind, id, document }) => {
    if (!['mechanic', 'view'].includes(kind)) {
      fail('COMPATIBILITY_STRUCTURE_READ_ONLY', '兼容模式只能保存机制图或视图的展示数据；概念和规则结构请先显式迁移。');
    }
    const documents = kind === 'mechanic' ? workspace.mechanics : workspace.views;
    const canonical = documents.find(item => item.id === id);
    const file = workspace.files.find(item => item.kind === kind && item.id === id);
    if (!canonical || !file || document?.id !== id) fail('ID_CHANGED', '此类型的文件 ID 不存在或被更改');
    if (!isDeepStrictEqual(withoutCompatiblePresentation(document), withoutCompatiblePresentation(canonical))) {
      fail('COMPATIBILITY_STRUCTURE_READ_ONLY', '兼容模式不允许修改概念、规则或引用结构；请先显式迁移后再编辑这些内容。');
    }
    const raw = (await readDocument(root, file.path)).document;
    if (!raw || raw.id !== id) fail('RESOURCE_CHANGED', '磁盘中的资源已改变，请重新读取后再保存。');
    const patched = { ...raw };
    for (const field of compatiblePresentationFields) if (document[field] !== undefined) patched[field] = structuredClone(document[field]);
    await commitFile(root, file.path, encode(patched));
    return verified();
  };
  const verified = async () => {
    try { return await refreshSnapshot(); }
    catch (error) { fail('SAVE_UNCERTAIN', '提交后工作区回读失败：' + error.message + '。请核实磁盘内容。'); }
  };
  // catalog 是 canonical 的派生读模型。保存后无论发布是否可用，都要把两项事实并列返回；
  // 不能让一个可重建目录的 I/O 失败阻断已经成功提交的规则资料。
  const exportPublication = (workspace, error = null) => {
    if (workspace.agentExportStatus === 'unconfigured') return { state: 'unconfigured', code: 'EXPORT_ROOT_UNCONFIGURED',
      message: '尚未配置 Agent 机制文档导出目录。', actions: ['choose-path'] };
    if (workspace.agentExportStatus === 'missing') return { state: 'missing', code: 'EXPORT_ROOT_MISSING',
      message: 'Agent 机制文档导出目录不存在；规则已保存，但文档尚未生成。', path: workspace.agentExportRoot,
      actions: ['create-and-publish', 'choose-path'] };
    if (workspace.agentExportStatus === 'unavailable') return { state: 'unavailable',
      code: workspace.agentExportError?.code ?? 'EXPORT_TARGET_UNAVAILABLE',
      message: workspace.agentExportError?.message ?? 'Agent 机制文档导出目录不可用。', actions: ['choose-path'] };
    if (error) return { state: 'failed', code: error.code ?? 'AGENT_EXPORT_FAILED',
      message: '规则已保存，但 Agent 机制文档发布失败：' + error.message, path: workspace.agentExportRoot,
      actions: ['republish', 'choose-path'] };
    return { state: 'current', path: workspace.agentExportRoot };
  };
  const withExportPublication = (workspace, publication) => ({ ...workspace, exportPublication: publication });
  const inspectExportPublication = async workspace => {
    const declared = exportPublication(workspace);
    if (declared.state !== 'current') return declared;
    const inspected = await inspectCatalogPublication(workspace.agentExportRoot, workspace);
    return inspected.state === 'current' ? declared : { ...declared, ...inspected, path: workspace.agentExportRoot,
      actions: ['republish', 'choose-path'] };
  };
  // 路由快照、坐标等不进入导出语义；它们保存后不能触发无意义的文档重写。
  const publicationKey = workspace => {
    const catalog = catalogSnapshot ?? rememberCatalog(workspace);
    // 降级工作区不构建 catalog；它不参与文档发布，键里用显式标记代替文档版本。
    return `${workspace.manifest.id}\u0000${workspace.manifest.agentExportPath ?? ''}\u0000${catalog?.documentRevision ?? 'degraded'}`;
  };
  const publicationPending = workspace => ({ state: 'pending', code: 'CATALOG_PENDING', path: workspace.agentExportRoot,
    message: '正在后台生成 Agent 机制文档。', actions: ['republish', 'choose-path'] });
  const schedulePublication = workspace => {
    const declared = exportPublication(workspace);
    if (declared.state === 'unconfigured' || declared.state === 'unavailable') return declared;
    const key = publicationKey(workspace);
    if (publication?.key === key && publication.state === 'current') return declared;
    if (publication?.key === key && ['pending', 'running'].includes(publication.state)) return publicationPending(workspace);
    pendingPublication = { key, workspace };
    publication = { key, state: 'pending' };
    if (!publicationWorker) {
      publicationWorker = Promise.resolve().then(async () => {
        while (pendingPublication && !closed) {
          const target = pendingPublication; pendingPublication = null;
          publication = { key: target.key, state: 'running' };
          try {
            // 缺失的已配置目录可安全创建；非受管目录仍由 publishCatalog 拒绝覆盖。
            const context = await projectContext(target.workspace.projectRoot, { manifest: target.workspace.manifest, createExportRoot: true });
            const candidate = { ...target.workspace, agentExportRoot: context.exportRoot, agentExportStatus: 'available' };
            await publishCatalog(context.exportRoot, candidate);
            // 发布后的确认属于后台检查：会话快照已经由每次写入刷新，键一致就直接确认。
            // 旧实现在这里无条件重读整个工作区，于是每次保存后都有一段后台全量读取，
            // 在 199 张机制图的项目上会让紧接着的交互明显变卡。
            if (workspaceSnapshot && publicationKey(workspaceSnapshot) === target.key) publication = { key: target.key, state: 'current' };
            else {
              const latest = await refreshSnapshot();
              if (publicationKey(latest) === target.key) publication = { key: target.key, state: 'current' };
              else pendingPublication ??= { key: publicationKey(latest), workspace: latest };
            }
          } catch (error) {
            publication = { key: target.key, state: 'failed', error };
          }
        }
      }).finally(() => {
        publicationWorker = null;
        // worker 退出边界与新的保存可能交错；重新调度，不能遗失最新快照。
        if (pendingPublication && !closed) schedulePublication(pendingPublication.workspace);
      });
    }
    return publicationPending(workspace);
  };
  const publicationForRead = async workspace => {
    const declared = exportPublication(workspace);
    if (declared.state === 'unconfigured' || declared.state === 'unavailable') return declared;
    const key = publicationKey(workspace);
    if (publication?.key === key) {
      if (publication.state === 'failed') return exportPublication(workspace, publication.error);
      if (publication.state === 'pending' || publication.state === 'running') return publicationPending(workspace);
      if (publication.state === 'current') return declared;
    }
    return inspectExportPublication(workspace);
  };
  const refreshCatalog = async () => {
    const canonical = await verified();
    // verified 已原子替换 workspace/catalog/settings 三份会话投影。
    return withExportPublication(canonical, schedulePublication(canonical));
  };
  const mechanicFolder = value => {
    if (typeof value !== 'string') fail('UNSAFE_PATH', '机制文件夹必须是字符串');
    const folder = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    if (folder) assertRelativeFile(`${folder}/folder.json`);
    return folder;
  };
  const mechanicDirectory = folder => folder ? `mechanics/${folder}` : 'mechanics';
  const assertMechanicTree = async directory => {
    const path = await workspacePath(root, `${directory}/check.json`, { allowMissing: true });
    const entries = await readdir(dirname(path), { withFileTypes: true });
    for (const entry of entries) {
      const child = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) fail('UNSAFE_PATH', '机制文件夹不能包含链接：' + child);
      if (entry.isDirectory()) await assertMechanicTree(child);
      else if (!entry.isFile() || !entry.name.endsWith('.mechanic.json')) fail('FOLDER_MIXED_CONTENT', '机制文件夹只能包含机制图或子文件夹：' + child);
    }
  };
  const createMechanicFolder = body => write(async () => {
    const workspace = await current(body);
    const folder = mechanicFolder(body.folder);
    if (!folder) fail('UNSAFE_PATH', '不能创建机制根目录');
    const directory = mechanicDirectory(folder);
    if (workspace.directories.includes(directory)) fail('FILE_EXISTS', '机制文件夹已存在：' + folder);
    await ensureWorkspaceDirectory(root, directory);
    return refreshCatalog();
  });
  const agentMechanicFolder = async body => {
    if (body.action !== 'create' || typeof body.name !== 'string') fail('AGENT_MUTATION_INVALID', 'Agent 只能创建机制文件夹，且必须提供 --name');
    const name = body.name.trim();
    if (!name || name !== body.name || name === '.' || name === '..' || /[\\/]/u.test(name)) {
      fail('UNSAFE_PATH', '机制文件夹名称必须是非空单段名称');
    }
    const parent = body.parent === undefined ? '' : mechanicFolder(body.parent);
    const before = await readWorkspace(root);
    if (parent && !before.directories.includes(mechanicDirectory(parent))) fail('FOLDER_NOT_FOUND', '父机制文件夹不存在：' + parent);
    const committed = await createMechanicFolder({ revision: body.revision, folder: parent ? `${parent}/${name}` : name });
    return { canonicalCommitted: true, workspaceId: committed.manifest.id, revision: committed.revision,
      resource: 'mechanic-folder', action: 'create', folder: parent ? `${parent}/${name}` : name };
  };
  const agentMechanicFolderDelete = async body => {
    if (body?.action !== 'delete' || typeof body.folder !== 'string') fail('AGENT_MUTATION_INVALID', 'Agent 删除机制文件夹必须提供 mechanic-folder delete 和 --folder');
    const committed = await deleteMechanicFolder({ revision: body.revision, folder: body.folder });
    return { canonicalCommitted: true, workspaceId: committed.manifest.id, revision: committed.revision,
      resource: 'mechanic-folder', action: 'delete', folder: body.folder };
  };
  const moveMechanic = body => write(async () => {
    const workspace = await current(body);
    if (typeof body.mechanicId !== 'string') fail('MECHANIC_NOT_FOUND', '必须提供机制图 ID');
    const source = workspace.files.find(file => file.kind === 'mechanic' && file.id === body.mechanicId);
    if (!source || !source.path.startsWith('mechanics/')) fail('MECHANIC_NOT_FOUND', '机制图不存在或不在 mechanisms 目录：' + body.mechanicId);
    const folder = mechanicFolder(body.folder), target = `${mechanicDirectory(folder)}/${posix.basename(source.path)}`;
    if (target === source.path) return workspace;
    await ensureWorkspaceDirectory(root, mechanicDirectory(folder));
    const sourcePath = await workspacePath(root, source.path);
    const targetPath = await workspacePath(root, target, { allowMissing: true });
    try { await lstat(targetPath); fail('FILE_EXISTS', '目标目录已有同名机制图：' + target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(sourcePath, targetPath); }
    catch (error) {
      if (error.code === 'EEXIST') fail('FILE_EXISTS', '目标目录已有同名机制图：' + target);
      throw error;
    }
    try { return await refreshCatalog(); }
    catch (error) {
      fail('AGENT_EXPORT_FAILED', '机制图路径已移动，但 Agent 机制文档发布失败：' + error.message,
        { canonicalCommitted: true, workspaceId: workspace.manifest.id, id: body.mechanicId, source: source.path, target });
    }
  });
  const moveMechanicFolder = body => write(async () => {
    const workspace = await current(body);
    const sourceFolder = mechanicFolder(body.sourceFolder), targetFolder = mechanicFolder(body.targetFolder);
    if (!sourceFolder || !targetFolder) fail('UNSAFE_PATH', '不能移动 mechanisms 根目录');
    const source = mechanicDirectory(sourceFolder), target = mechanicDirectory(targetFolder);
    if (!workspace.directories.includes(source)) fail('FOLDER_NOT_FOUND', '机制文件夹不存在：' + sourceFolder);
    if (target === source || target.startsWith(source + '/')) fail('UNSAFE_PATH', '机制文件夹不能移动到自身或其子目录');
    if (workspace.directories.includes(target)) fail('FILE_EXISTS', '目标机制文件夹已存在：' + targetFolder);
    await assertMechanicTree(source);
    await ensureWorkspaceDirectory(root, posix.dirname(target));
    const sourcePath = await workspacePath(root, `${source}/check.json`, { allowMissing: true });
    // target 已由 mechanicFolder 校验，父目录已通过 ensureWorkspaceDirectory；目标本身必须不存在，
    // 因而不能交给 workspacePath（它只允许最后一段缺失的文件，而非缺失目录）。
    await rename(dirname(sourcePath), resolve(root, target));
    try { return await refreshCatalog(); }
    catch (error) { fail('AGENT_EXPORT_FAILED', '机制文件夹路径已移动，但 Agent 机制文档发布失败：' + error.message,
      { canonicalCommitted: true, workspaceId: workspace.manifest.id, source, target }); }
  });
  const deleteMechanicFolder = body => write(async () => {
    const workspace = await current(body);
    const folder = mechanicFolder(body.folder);
    if (!folder) fail('UNSAFE_PATH', '不能删除 mechanisms 根目录');
    const directory = mechanicDirectory(folder);
    if (!workspace.directories.includes(directory)) fail('FOLDER_NOT_FOUND', '机制文件夹不存在：' + folder);
    const path = await workspacePath(root, `${directory}/check.json`, { allowMissing: true });
    const actual = dirname(path), entries = await readdir(actual);
    if (entries.length) fail('FOLDER_NOT_EMPTY', '机制文件夹非空；请先移出机制图或子文件夹：' + folder);
    await rmdir(actual);
    return refreshCatalog();
  });
  const deleteMechanic = body => write(async () => {
    const workspace = await current(body);
    if (typeof body.mechanicId !== 'string') fail('MECHANIC_NOT_FOUND', '必须提供机制图 ID');
    const file = workspace.files.find(item => item.kind === 'mechanic' && item.id === body.mechanicId);
    if (!file) fail('MECHANIC_NOT_FOUND', '机制图不存在：' + body.mechanicId);
    const references = workspace.views.filter(view => (view.mechanicRegistrations ?? []).some(item => item.mechanicId === body.mechanicId)).map(view => ({ id: view.id, name: view.name }));
    for (const composition of workspace.manifest.compositions ?? []) if ((composition.graphIds ?? []).includes(body.mechanicId)) references.push({ id: composition.id, name: composition.name ?? '工作区组合视图' });
    if (references.length) fail('MECHANIC_REFERENCED', '机制图仍被视图引用，不能删除。请先从这些视图移除：' + references.map(item => item.name).join('、'), { references });
    const lastView = workspace.manifest.lastView;
    const nextManifest = Array.isArray(lastView?.graphIds) && lastView.graphIds.includes(body.mechanicId)
      ? { ...workspace.manifest, lastView: { ...lastView, graphIds: lastView.graphIds.filter(id => id !== body.mechanicId) } }
      : workspace.manifest;
    // 删除必须与新建对称：导出清单里指向该机制图的单独选择要一起移除，
    // 否则会留下悬空引用，让整个工作区在下次校验时失败（validate 的 requireReference）。
    const selections = Array.isArray(workspace.manifest.exportSelections) ? workspace.manifest.exportSelections : null;
    const remaining = selections?.filter(item => !(item.kind === 'mechanic' && item.mechanicId === body.mechanicId));
    const manifestAfterDelete = selections !== null && remaining.length !== selections.length
      ? { ...(nextManifest ?? workspace.manifest), exportSelections: remaining } : nextManifest;
    const changes = [{ path: file.path, delete: true }];
    if (manifestAfterDelete !== workspace.manifest) changes.push({ path: 'workspace.json', document: manifestAfterDelete });
    await commitFiles(root, changes, { verify: () => readWorkspace(root) });
    try { return await refreshCatalog(); }
    catch (error) { fail('AGENT_EXPORT_FAILED', '机制图已删除，但 Agent 机制文档发布失败：' + error.message,
      { canonicalCommitted: true, workspaceId: workspace.manifest.id, id: body.mechanicId }); }
  });
  const create = (kind, body) => write(async () => {
    const workspace = await current(body), document = body.document;
    assertDocument(document, kind);
    const documents = kind === 'mechanic' ? workspace.mechanics : workspace.views;
    if (documents.some(item => item.id === document.id)) fail('DUPLICATE_ID', '此文件类型中的 ID 已存在');
    if (documents.length >= 300) fail('FILE_LIMIT', '工作区每种类型最多 300 个文件');
    const file = kind === 'mechanic' ? body.file ?? ('mechanics/' + document.id + '.mechanic.json') : body.file;
    assertRelativeFile(file);
    if (!file.endsWith('.' + kind + '.json') || file.split('/').some(part => part.startsWith('.') || part === 'node_modules')) {
      fail('UNSAFE_PATH', '文件须使用 .' + kind + '.json 后缀，不能存入隐藏或依赖目录');
    }
    if (kind === 'mechanic' && body.requireExistingFolder) {
      const folder = posix.dirname(file);
      if (!workspace.directories.includes(folder)) fail('FOLDER_NOT_FOUND', '目标机制文件夹不存在：' + folder.replace(/^mechanics\/?/, ''));
    }
    documents.push(document); workspace.files.push({ kind, id: document.id, path: file });
    const selectionAdded = kind === 'mechanic'
      ? selectCreatedMechanic(workspace.manifest, document.id, mechanicFolderOf(file)) : false;
    validateWorkspace(workspace);
    if (kind === 'view') composeView(workspace, document);
    const text = encode(document), parent = posix.dirname(file);
    await ensureWorkspaceDirectory(root, parent === '.' ? '' : parent);
    try { await commitFile(root, file, text, { create: true }); }
    catch (error) { error.message += '；目标：' + file + '。父目录可能已创建，请重新读取目录。'; throw error; }
    // 机制图文件先落盘、导出清单后落盘：清单写失败会显式抛出，不会留下"文件在、清单没更新"的静默状态；
    // 反过来则会留下指向不存在机制图的选择，下一次读取直接校验失败。
    if (selectionAdded) await commitFile(root, 'workspace.json', encode(workspace.manifest));
    return kind === 'mechanic' || kind === 'view' ? refreshCatalog() : verified();
  });
  const agentMechanic = async body => {
    if (body.action !== 'create') fail('AGENT_MUTATION_INVALID', 'Agent 只能创建空白机制图');
    for (const field of ['id', 'name', 'scope']) if (typeof body[field] !== 'string' || !body[field].trim()) {
      fail('AGENT_MUTATION_INVALID', `创建机制图必须提供非空 --${field}`);
    }
    const folder = body.folder === undefined ? '' : mechanicFolder(body.folder);
    const before = await readWorkspace(root);
    const document = { schemaVersion: 9, kind: 'mechanic', workspaceId: before.manifest.id, id: body.id,
      name: body.name.trim(), scope: body.scope.trim(), implementationStatus: 'design', focusNodeIds: [], pinnedRuleIds: [], positions: {},
      taxonomyPresentation: { mode: 'label', expandedNodeIds: [] } };
    const file = `${mechanicDirectory(folder)}/${body.id}.mechanic.json`;
    const committed = await create('mechanic', { revision: body.revision, document, file, requireExistingFolder: true });
    return { canonicalCommitted: true, workspaceId: committed.manifest.id, revision: committed.revision,
      resourceRevision: committed.resourceRevisions.mechanics[body.id], resource: 'mechanic', action: 'create', id: body.id, folder,
      exportPublication: committed.exportPublication };
  };
  const agentMechanicDelete = async body => {
    if (body?.action !== 'delete' || typeof body.mechanic !== 'string') fail('AGENT_MUTATION_INVALID', 'Agent 删除机制必须提供 mechanic delete 和 --mechanic');
    const before = await readWorkspace(root);
    if (body.revision !== before.resourceRevisions.mechanics[body.mechanic]) {
      fail('RESOURCE_REVISION_CONFLICT', `机制 ${body.mechanic} 已改变，请重新查询后再删除`);
    }
    const committed = await deleteMechanic({ revision: before.revision, mechanicId: body.mechanic });
    return { canonicalCommitted: true, workspaceId: committed.manifest.id, revision: committed.revision,
      resource: 'mechanic', action: 'delete', id: body.mechanic, exportPublication: committed.exportPublication };
  };
  const agentViewDelete = body => write(async () => {
    if (body?.action !== 'delete' || typeof body.view !== 'string') fail('AGENT_MUTATION_INVALID', 'Agent 删除视图必须提供 view delete 和 --view');
    const workspace = await current(body);
    const file = workspace.files.find(item => item.kind === 'view' && item.id === body.view);
    if (!file) fail('VIEW_NOT_FOUND', `视图不存在：${body.view}`);
    if (workspace.manifest.lastView?.viewId === body.view) fail('VIEW_REFERENCED', '工作区最近视图仍引用该视图；请先切换到其他文件');
    await unlink(await workspacePath(root, file.path));
    const committed = await verified();
    return { canonicalCommitted: true, workspaceId: committed.manifest.id, revision: committed.revision,
      resource: 'view', action: 'delete', id: body.view };
  });
  // Agent 只能请求与网页“自动排版全部节点”同一套确定性布局；坐标本身不接受外部输入。
  const agentMechanicArrange = body => write(async () => {
    if (body?.action !== 'arrange' || typeof body.mechanic !== 'string') {
      fail('AGENT_MUTATION_INVALID', 'Agent 自动排版必须提供 mechanic arrange 和 --mechanic');
    }
    const workspace = await readWorkspace(root);
    const mechanic = workspace.mechanics.find(item => item.id === body.mechanic);
    if (!mechanic) fail('SCOPE_NOT_FOUND', `机制不存在：${body.mechanic}`);
    if (body.revision !== workspace.resourceRevisions.mechanics[mechanic.id]) {
      fail('RESOURCE_REVISION_CONFLICT', `机制 ${mechanic.id} 已改变，请重新查询后再自动排版`);
    }
    const graph = compose(workspace, [mechanic.id]);
    // 与网页“自动排版全部节点”消费同一显示投影：默认隐藏的 is-a 父概念不占坐标、不生成路线。
    const displayGraph = projectDisplayGraph(graph, { taxonomyPresentation: mechanic.taxonomyPresentation, retainedNodeIds: mechanic.focusNodeIds });
    if (!displayGraph.nodes.length) fail('MECHANIC_EMPTY', `机制 ${body.mechanic} 没有投影节点，不能自动排版`);
    const positions = graphPositions(workspace, displayGraph, {}, mechanic.id), layoutTimings = {}, layoutPhases = [];
    let layout;
    try { layout = await arrangeGraphWithRoutes({ graph: displayGraph, positions, ELK, cola, timings: layoutTimings, onPhase: event => layoutPhases.push(event) }); }
    catch (error) { fail('MECHANIC_LAYOUT_FAILED', `机制 ${mechanic.id} 自动排版失败：${error.message}`, { layoutTimings, layoutPhases }); }
    mechanic.positions = layout.positions; mechanic.routeCache = createRouteCache(displayGraph, layout.positions, layout.routes);
    validateWorkspace(workspace);
    const file = workspace.files.find(item => item.kind === 'mechanic' && item.id === mechanic.id)?.path;
    if (!file) fail('AGENT_MUTATION_INVALID', 'Agent 自动排版的机制文件不存在');
    await commitFile(root, file, encode(mechanic));
    const committed = await refreshCatalog();
    return { canonicalCommitted: true, workspaceId: committed.manifest.id, revision: committed.revision,
      resourceRevision: committed.resourceRevisions.mechanics[mechanic.id], resource: 'mechanic', action: 'arrange', id: mechanic.id,
      layoutTimings, layoutPhases, layoutWarnings: layout.warnings ?? [], exportPublication: committed.exportPublication };
  });
  // 规则归属迁移是唯一允许同时改动多个机制、删除旧机制并建立总览视图的 Agent 写入。
  // 输入仅声明“哪条既有规则归属哪个机制”；规则语义始终从来源机制的 canonical 边复制，
  // 从而杜绝 Agent 在迁移时重写规则文字、限定词或继承语义。
  const agentMechanicTransfer = body => write(async () => {
    fail('RULE_OWNERSHIP_TRANSFER_REMOVED', '规则已全局存于 rules.json；机制图不再拥有或迁移规则。请直接创建机制图/视图投影并引用已有概念。');
    if (body?.action !== 'transfer' || typeof body.mechanic !== 'string' || !Array.isArray(body.transfers)
      || typeof body.viewId !== 'string' || !body.viewId.trim() || typeof body.viewName !== 'string' || !body.viewName.trim()) {
      fail('AGENT_MUTATION_INVALID', 'mechanic transfer 必须提供来源机制、规则归属清单及非空总览视图 ID/名称');
    }
    const workspace = await readWorkspace(root), source = workspace.mechanics.find(item => item.id === body.mechanic);
    if (!source) fail('SCOPE_NOT_FOUND', `来源机制不存在：${body.mechanic}`);
    if (body.revision !== workspace.resourceRevisions.mechanics[source.id]) {
      fail('RESOURCE_REVISION_CONFLICT', `机制 ${source.id} 已改变，请重新查询后再迁移`);
    }
    if (body.workspaceRevision !== undefined && body.workspaceRevision !== workspace.revision) {
      fail('REVISION_CONFLICT', '工作区自 preview 后已改变，未写入任何文件');
    }
    const sourceFile = workspace.files.find(file => file.kind === 'mechanic' && file.id === source.id)?.path;
    if (!sourceFile) fail('AGENT_MUTATION_INVALID', `来源机制文件不存在：${source.id}`);
    if (workspace.views.some(view => view.id === body.viewId) || (body.viewId !== source.id && workspace.mechanics.some(mechanic => mechanic.id === body.viewId))) {
      fail('DUPLICATE_ID', `总览视图 ID 已存在：${body.viewId}`);
    }
    const references = workspace.views.filter(view => view.mechanicRegistrations.some(item => item.mechanicId === source.id)).map(view => view.id);
    const compositionReferences = workspace.manifest.compositions.filter(view => view.graphIds.includes(source.id)).map(view => view.id);
    if (references.length || compositionReferences.length) {
      fail('MECHANIC_REFERENCED', `来源机制 ${source.id} 仍被已保存视图或组合引用；请先显式重构这些视图`, { views: references, compositions: compositionReferences });
    }
    const createMechanics = body.createMechanics ?? [];
    if (!Array.isArray(createMechanics)) fail('AGENT_MUTATION_INVALID', 'createMechanics 必须是 JSON 数组');
    const createdIds = new Set();
    for (const item of createMechanics) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'name', 'scope', 'folder'].includes(key))
        || ['id', 'name', 'scope', 'folder'].some(key => typeof item[key] !== 'string' || !item[key].trim())) {
        fail('AGENT_MUTATION_INVALID', 'createMechanics 的每项只能包含非空 id、name、scope、folder');
      }
      if (createdIds.has(item.id) || workspace.mechanics.some(mechanic => mechanic.id === item.id)) fail('DUPLICATE_ID', `新机制 ID 重复：${item.id}`);
      const folder = mechanicFolder(item.folder);
      if (!workspace.directories.includes(mechanicDirectory(folder))) fail('FOLDER_NOT_FOUND', `新机制目录不存在：${folder}`);
      createdIds.add(item.id);
    }
    const targets = new Map(workspace.mechanics.filter(mechanic => mechanic.id !== source.id).map(mechanic => [mechanic.id, mechanic]));
    for (const item of createMechanics) {
      const document = { schemaVersion: 6, kind: 'mechanic', workspaceId: workspace.manifest.id, id: item.id,
        name: item.name.trim(), scope: item.scope.trim(), nodeIds: [], edges: [], positions: {} };
      targets.set(document.id, document); workspace.mechanics.push(document);
      workspace.files.push({ kind: 'mechanic', id: document.id, path: `${mechanicDirectory(mechanicFolder(item.folder))}/${document.id}.mechanic.json` });
    }
    const sourceEdges = new Map(source.edges.map(edge => [`${edge.source}\u0000${edge.target}`, edge]));
    const assigned = new Set();
    for (const item of body.transfers) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['source', 'target', 'targetMechanic'].includes(key))
        || ['source', 'target', 'targetMechanic'].some(key => typeof item[key] !== 'string' || !item[key])) {
        fail('AGENT_MUTATION_INVALID', 'transfers 的每项只能包含 source、target、targetMechanic');
      }
      const key = `${item.source}\u0000${item.target}`, edge = sourceEdges.get(key), target = targets.get(item.targetMechanic);
      if (!edge) fail('RULE_NOT_FOUND', `来源机制没有规则：${item.source} → ${item.target}`);
      if (!target || target.id === source.id) fail('SCOPE_NOT_FOUND', `迁移目标机制不存在：${item.targetMechanic}`);
      if (assigned.has(key)) fail('AGENT_MUTATION_INVALID', `规则在迁移清单中重复：${item.source} → ${item.target}`);
      if (target.edges.some(candidate => candidate.source === edge.source && candidate.target === edge.target)) {
        fail('DUPLICATE_ENDPOINT_RULE', `目标机制已有同向规则：${edge.source} → ${edge.target}`);
      }
      assigned.add(key); target.edges.push(structuredClone(edge));
      for (const nodeId of [edge.source, edge.target]) if (!target.nodeIds.includes(nodeId)) target.nodeIds.push(nodeId);
    }
    if (assigned.size !== source.edges.length) {
      fail('TRANSFER_INCOMPLETE', `迁移清单必须恰好覆盖来源机制全部 ${source.edges.length} 条规则；当前覆盖 ${assigned.size} 条`);
    }
    // 拒绝把已有非空机制混入，避免总览规则集在没有明示的情况下悄然扩张。
    const targetIds = [...new Set(body.transfers.map(item => item.targetMechanic))];
    const targetSet = new Set(targetIds);
    for (const mechanic of workspace.mechanics) {
      if (mechanic.id !== source.id && targetSet.has(mechanic.id) && mechanic.edges.length !== source.edges.filter(edge => body.transfers.some(item => item.targetMechanic === mechanic.id && item.source === edge.source && item.target === edge.target)).length) {
        fail('TRANSFER_TARGET_NOT_EMPTY', `目标机制 ${mechanic.id} 迁移前必须为空`);
      }
    }
    workspace.mechanics = workspace.mechanics.filter(mechanic => mechanic.id !== source.id);
    workspace.files = workspace.files.filter(file => !(file.kind === 'mechanic' && file.id === source.id));
    const view = { schemaVersion: 3, kind: 'view', workspaceId: workspace.manifest.id, id: body.viewId.trim(), name: body.viewName.trim(),
      mechanicRegistrations: targetIds.map(mechanicId => ({ mechanicId, visible: true })), collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' };
    workspace.views.push(view); workspace.files.push({ kind: 'view', id: view.id, path: `${view.id}.view.json` });
    workspace.manifest.lastView = { viewId: view.id };
    try {
      for (const mechanicId of targetIds) {
        const mechanic = workspace.mechanics.find(item => item.id === mechanicId), graph = compose(workspace, [mechanicId]);
        const layout = await arrangeGraphWithRoutes({ graph, positions: graphPositions(workspace, graph, {}, mechanicId), ELK, cola });
        mechanic.positions = layout.positions; mechanic.routeCache = createRouteCache(graph, layout.positions, layout.routes);
      }
      const overview = composeView(workspace, view);
      const layout = await arrangeGraphWithRoutes({ graph: overview, positions: graphPositions(workspace, overview, {}), ELK, cola });
      view.positions = layout.positions; view.routeCache = createRouteCache(overview, layout.positions, layout.routes);
    } catch (error) { fail('MECHANIC_LAYOUT_FAILED', `迁移草稿自动排版失败，未写入任何文件：${error.message}`); }
    validateWorkspace(workspace);
    const changes = [
      { path: sourceFile, delete: true },
      ...targetIds.filter(id => !createdIds.has(id)).map(id => ({ path: workspace.files.find(file => file.kind === 'mechanic' && file.id === id)?.path, document: workspace.mechanics.find(item => item.id === id) })),
      ...createMechanics.map(item => ({ path: workspace.files.find(file => file.kind === 'mechanic' && file.id === item.id)?.path, document: workspace.mechanics.find(mechanic => mechanic.id === item.id), create: true })),
      { path: `${view.id}.view.json`, document: view, create: true },
      { path: 'workspace.json', document: workspace.manifest },
    ];
    if (changes.some(change => !change.path || (!change.delete && !change.document))) fail('AGENT_MUTATION_INVALID', '迁移事务无法定位全部目标文件');
    await commitFiles(root, changes, { verify: () => readWorkspace(root) });
    let committed;
    try { committed = await refreshCatalog(); }
    catch (error) {
      fail('AGENT_EXPORT_FAILED', '迁移 canonical 已提交，但 Agent 机制文档发布失败：' + error.message,
        { canonicalCommitted: true, sourceMechanic: source.id, viewId: view.id });
    }
    return { canonicalCommitted: true, workspaceId: committed.manifest.id, revision: committed.revision, resource: 'mechanic', action: 'transfer',
      sourceMechanic: source.id, targetMechanicIds: targetIds, viewId: view.id, ruleCount: source.edges.length,
      exportPublication: committed.exportPublication };
  });
  const recipeMigrationPlan = async manifestPath => {
    const workspace = await readWorkspace(root);
    if (typeof manifestPath !== 'string' || !manifestPath.startsWith('docs/') || !manifestPath.endsWith('.json') || manifestPath.includes('\\')
      || manifestPath.split('/').some(part => !part || part === '.' || part === '..')) {
      fail('UNSAFE_PATH', 'recipe-migration 的 --manifest 只能是项目内 docs/ 下的 JSON 相对路径');
    }
    const file = resolve(workspace.projectRoot, manifestPath);
    if (relative(workspace.projectRoot, file).startsWith('..')) fail('UNSAFE_PATH', '迁移清单超出项目目录');
    let manifest;
    try { manifest = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { fail('INVALID_JSON', `迁移清单不可读取：${error.message}`); }
    if (manifest?.status !== 'proposal_only_not_executed' || typeof manifest.sourceMechanic !== 'string' || !Array.isArray(manifest.rules)
      || !manifest.proposedNonemptyContext || typeof manifest.proposedNonemptyContext.id !== 'string') {
      fail('RECIPE_MIGRATION_INVALID', '迁移清单不符合受约束 recipe-migration schema');
    }
    const source = workspace.mechanics.find(mechanic => mechanic.id === manifest.sourceMechanic);
    if (!source) fail('SCOPE_NOT_FOUND', `迁移来源机制不存在：${manifest.sourceMechanic}`);
    const transfers = manifest.rules.map(rule => ({ source: rule?.source, target: rule?.target, targetMechanic: rule?.targetMechanic }));
    const targetIds = [...new Set(transfers.map(item => item.targetMechanic))];
    if (!transfers.length || targetIds.includes(undefined) || !targetIds.includes(manifest.proposedNonemptyContext.id)) {
      fail('RECIPE_MIGRATION_INVALID', '迁移清单缺少完整规则映射或共享上下文归属');
    }
    const existingTargets = targetIds.filter(id => id !== manifest.proposedNonemptyContext.id);
    for (const id of existingTargets) {
      const target = workspace.mechanics.find(mechanic => mechanic.id === id);
      if (!target) fail('SCOPE_NOT_FOUND', `清单目标机制不存在：${id}`);
      if (target.edges.length || target.nodeIds.length) fail('TRANSFER_TARGET_NOT_EMPTY', `目标机制必须为空：${id}`);
    }
    if (workspace.mechanics.some(mechanic => mechanic.id === manifest.proposedNonemptyContext.id)) {
      fail('DUPLICATE_ID', `共享上下文机制已经存在：${manifest.proposedNonemptyContext.id}`);
    }
    const targetFiles = workspace.files.filter(file => file.kind === 'mechanic' && existingTargets.includes(file.id));
    const folders = [...new Set(targetFiles.map(file => posix.dirname(file.path)))];
    if (folders.length !== 1) fail('RECIPE_MIGRATION_INVALID', '现有配方目标不在同一机制文件夹，不能安全推导共享上下文位置');
    const sourcePairs = new Set(source.edges.map(edge => `${edge.source}\u0000${edge.target}`));
    const transferPairs = new Set(transfers.map(item => `${item.source}\u0000${item.target}`));
    if (transferPairs.size !== transfers.length || transferPairs.size !== sourcePairs.size || [...transferPairs].some(pair => !sourcePairs.has(pair))) {
      fail('TRANSFER_INCOMPLETE', '迁移清单必须与来源机制规则端点集合精确一致，且不得重复');
    }
    const folder = folders[0].replace(/^mechanics\/?/, '');
    return { workspace, source, transfers, targetIds, createMechanics: [{ id: manifest.proposedNonemptyContext.id,
      name: manifest.proposedNonemptyContext.name, scope: '生产设施与生态前提', folder }], manifestPath };
  };
  const recipeMigration = async body => {
    fail('RULE_OWNERSHIP_TRANSFER_REMOVED', '配方规则归属迁移已移除：规则不再属于机制图。请通过机制图的 focusNodeIds 和视图投影组织规则。');
    const plan = await recipeMigrationPlan(body.manifest);
    if (body.action === 'preview') return { preview: true, migration: 'recipe-migration', revision: plan.workspace.revision,
      sourceMechanic: plan.source.id, sourceResourceRevision: plan.workspace.resourceRevisions.mechanics[plan.source.id],
      ruleCount: plan.source.edges.length, nodeCount: plan.source.nodeIds.length, targetMechanicIds: plan.targetIds,
      targetCounts: Object.fromEntries(plan.targetIds.map(id => [id, plan.transfers.filter(item => item.targetMechanic === id).length])) };
    if (body.action !== 'execute') fail('AGENT_MUTATION_INVALID', 'recipe-migration action 必须是 preview 或 execute');
    if (body.revision !== plan.workspace.revision) fail('REVISION_CONFLICT', '工作区自 preview 后已改变，未写入任何文件');
    return agentMechanicTransfer({ resource: 'mechanic', action: 'transfer', mechanic: plan.source.id,
      transfers: plan.transfers, createMechanics: plan.createMechanics, viewId: plan.source.id, viewName: plan.source.name,
      revision: plan.workspace.resourceRevisions.mechanics[plan.source.id], workspaceRevision: plan.workspace.revision });
  };
  const applyProjectSettings = async body => {
    const workspace = await current(body, scopeOf('workspace'));
    const manifest = { ...workspace.manifest, name: body.name, agentExportPath: body.agentExportPath };
    assertDocument(manifest, 'workspace', 'workspace.json');
    let context = await projectContext(workspace.projectRoot, { manifest, allowMissingExport: true });
    const pathChanged = context.exportRoot !== workspace.agentExportRoot;
    const manifestChanged = !isDeepStrictEqual(manifest, workspace.manifest);
    if (!manifestChanged) return workspace;
    if (!pathChanged) {
      await commitFile(root, 'workspace.json', encode(manifest));
      return refreshCatalog();
    }
    // 不能在后台发布正在写旧目录时迁移导出根；先让该派生任务完整结束，
    // 再按既有 ownership 规则验证和清理，避免把半成品误判为用户文件。
    await publicationWorker;
    await assertCatalogRemovable(workspace.agentExportRoot, workspace.manifest.id);
    context = await projectContext(workspace.projectRoot, { manifest, createExportRoot: true });
    const candidate = { ...workspace, manifest, agentExportRoot: context.exportRoot };
    await publishCatalog(context.exportRoot, candidate);
    try { await commitFile(root, 'workspace.json', encode(manifest)); }
    catch (error) {
      try { await removeCatalog(context.exportRoot, manifest.id); }
      catch (cleanup) { error.message += '；新导出目录清理失败：' + cleanup.message; }
      throw error;
    }
    const saved = await verified();
    try { await removeCatalog(workspace.agentExportRoot, manifest.id); }
    catch (error) {
      fail('EXPORT_MOVE_PARTIAL', '新 Agent 机制文档路径已生效，但旧生成目录未能安全清理：' + error.message);
    }
    return saved;
  };
  const setProjectSettings = body => write(() => applyProjectSettings(body));
  const setDocumentExport = body => write(async () => {
    const workspace = await current(body, scopeOf('workspace'));
    if (!Array.isArray(body?.selections)) fail('DOCUMENT_EXPORT_INVALID', '导出设置必须提交完整 selections 数组。');
    const manifest = { ...workspace.manifest, exportSelections: structuredClone(body.selections) };
    assertDocument(manifest, 'workspace', 'workspace.json');
    workspace.manifest = manifest; validateWorkspace(workspace);
    await commitFile(root, 'workspace.json', encode(manifest));
    const committed = await verified();
    return withExportPublication(committed, schedulePublication(committed));
  });
  // 显式生成只是把最新 canonical 快照排入后台；它不借机改写 manifest，也不阻塞界面。
  const generateDocumentExport = body => write(async () => {
    const workspace = await current(body, scopeOf('workspace'));
    if (!workspace.manifest.agentExportPath) fail('EXPORT_ROOT_UNCONFIGURED', '尚未配置 Agent 机制文档导出目录；请先在项目设置中选择目录。');
    return withExportPublication(workspace, schedulePublication(workspace));
  });
  const mutateAgent = body => {
    if (body?.resource === 'mechanic-folder' && body.action === 'delete') return agentMechanicFolderDelete(body);
    if (body?.resource === 'mechanic-folder') return agentMechanicFolder(body);
    if (body?.resource === 'mechanic' && body.action === 'create') return agentMechanic(body);
    if (body?.resource === 'mechanic' && body.action === 'arrange') return agentMechanicArrange(body);
    if (body?.resource === 'mechanic' && body.action === 'transfer') return agentMechanicTransfer(body);
    if (body?.resource === 'mechanic' && body.action === 'delete') return agentMechanicDelete(body);
    if (body?.resource === 'view' && body.action === 'delete') return agentViewDelete(body);
    return write(async () => {
    const workspace = await readWorkspace(root);
    const target = applyAgentMutation(workspace, body);
    const file = target.kind === 'definitions' ? workspace.manifest.definitions
      : target.kind === 'rules' ? workspace.manifest.rules
      : workspace.files.find(item => item.kind === 'mechanic' && item.id === target.id)?.path;
    if (!file) fail('AGENT_MUTATION_INVALID', 'Agent mutation 的目标文件不存在');
    const changes = [{ path: file, document: target.document }, ...(target.companionMechanics ?? []).map(mechanic => ({
      path: workspace.files.find(item => item.kind === 'mechanic' && item.id === mechanic.id)?.path, document: mechanic,
    })), ...(target.companionViews ?? []).map(view => ({
      path: workspace.files.find(item => item.kind === 'view' && item.id === view.id)?.path, document: view,
    }))];
    if (changes.some(change => !change.path)) fail('AGENT_MUTATION_INVALID', 'Agent mutation 的关联机制或视图文件不存在');
    if (changes.length === 1) await commitFile(root, file, encode(target.document));
    else await commitFiles(root, changes, { verify: () => readWorkspace(root) });
    const committed = await verified();
    const resourceRevision = target.kind === 'definitions' ? committed.resourceRevisions.definitions
      : target.kind === 'rules' ? committed.resourceRevisions.rules
      : committed.resourceRevisions.mechanics[target.id];
    const envelope = { canonicalCommitted: true, workspaceId: committed.manifest.id, revision: committed.revision,
      resourceRevision, resource: body.resource, action: body.action, ...(target.id ? { id: target.id } : {}) };
    return { ...envelope, exportPublication: schedulePublication(committed) };
    });
  };
  // Agent 草稿只能在此处进入 canonical：它没有坐标，保存时必须重新校验、排版并一次提交定义与机制。
  const saveAgentDraft = body => write(async () => {
    if (!body || typeof body !== 'object' || typeof body.mechanic !== 'string' || !body.mechanic
      || !body.definitions || !body.rules || !body.document) fail('AGENT_DRAFT_INVALID', '草稿保存必须提供概念、规则、机制和目标机制 ID');
    // 草稿只写这三份文件，因此只有它们的语义版本变化才构成冲突：
    // 其他资源的变化（含浏览器打开图时补算的坐标与连线路径）不再作废一份仍然有效的草稿。
    const workspace = await current({ revision: body.workspaceRevision, resourceRevisions: {
      definitions: body.definitionsRevision, rules: body.rulesRevision, mechanics: { [body.mechanic]: body.mechanicRevision } } },
      scopeOf('definitions', 'rules', 'mechanic:' + body.mechanic), '工作区已改变；草稿未覆盖正式文件，请重新 open 后合并。');
    const index = workspace.mechanics.findIndex(item => item.id === body.mechanic);
    if (index < 0 || body.document.id !== body.mechanic || body.document.kind !== 'mechanic') fail('AGENT_DRAFT_SCOPE_MISMATCH', '草稿机制与 open 的目标不一致');
    if (body.definitions.kind !== 'definitions' || body.rules.kind !== 'rules' || body.definitions.workspaceId !== workspace.manifest.id || body.rules.workspaceId !== workspace.manifest.id || body.document.workspaceId !== workspace.manifest.id) {
      fail('AGENT_DRAFT_SCOPE_MISMATCH', '草稿不属于当前工作区');
    }
    const definitionIds = new Set((body.definitions.nodes ?? []).map(node => node.id));
    workspace.definitions = { ...body.definitions, positions: Object.fromEntries(Object.entries(workspace.definitions.positions ?? {})
      .filter(([id]) => definitionIds.has(id))) };
    workspace.rules = body.rules;
    workspace.mechanics[index] = { ...body.document, positions: {}, routeCache: undefined };
    validateWorkspace(workspace);
    const mechanic = workspace.mechanics[index], graph = compose(workspace, [mechanic.id]);
    // 与网页同一显示投影：默认隐藏只由 is-a 引入的父概念，它不参与排版也不产生路线。
    const displayGraph = projectDisplayGraph(graph, { taxonomyPresentation: mechanic.taxonomyPresentation, retainedNodeIds: mechanic.focusNodeIds });
    if (displayGraph.nodes.length) {
      let layout;
      try { layout = await autoLayoutGraph({ graph: displayGraph, positions: graphPositions(workspace, displayGraph, {}, mechanic.id),
        selectedIds: [], cachedRoutes: [], ELK }); }
      catch (error) { fail('MECHANIC_LAYOUT_FAILED', `机制 ${mechanic.id} 自动排版失败：${error.message}`); }
      mechanic.positions = layout.positions;
      mechanic.routeCache = layout.routeCache;
    }
    validateWorkspace(workspace);
    const mechanicPath = workspace.files.find(file => file.kind === 'mechanic' && file.id === mechanic.id)?.path;
    if (!mechanicPath) fail('AGENT_DRAFT_INVALID', '草稿目标机制文件不存在');
    await commitFiles(root, [{ path: workspace.manifest.definitions, document: workspace.definitions },
      { path: workspace.manifest.rules, document: workspace.rules }, { path: mechanicPath, document: mechanic }], { verify: () => readWorkspace(root) });
    const committed = await verified();
    const envelope = { canonicalCommitted: true, workspaceId: committed.manifest.id, revision: committed.revision,
      definitionsRevision: committed.resourceRevisions.definitions, rulesRevision: committed.resourceRevisions.rules,
      mechanicRevision: committed.resourceRevisions.mechanics[mechanic.id], mechanic: mechanic.id };
    return { ...envelope, exportPublication: schedulePublication(committed) };
  });
  // 规则是全局事实，而“在当前机制图中可见”是该机制的投影选择；用户从画布新建规则时，
  // 两份文件必须作为一个 canonical 提交一起校验和回读，不能留下只写入其一的中间状态。
  const saveRulesAndMechanic = body => write(async () => {
    const workspace = await current(body, scopeOf('rules', 'mechanic:' + body?.mechanicId));
    if (!body?.rules || !body?.mechanic || typeof body.mechanicId !== 'string') fail('RULE_PROJECTION_INVALID', '规则提交必须提供 rules、mechanic 和 mechanicId');
    assertDocument(body.rules, 'rules'); assertDocument(body.mechanic, 'mechanic');
    const index = workspace.mechanics.findIndex(item => item.id === body.mechanicId);
    if (index < 0 || body.mechanic.id !== body.mechanicId) fail('RULE_PROJECTION_INVALID', '规则提交目标机制不存在或 ID 不一致');
    workspace.rules = body.rules; workspace.mechanics[index] = body.mechanic;
    validateWorkspace(workspace);
    const mechanicPath = workspace.files.find(item => item.kind === 'mechanic' && item.id === body.mechanicId)?.path;
    if (!mechanicPath) fail('RULE_PROJECTION_INVALID', '规则提交目标机制缺少文件路径');
    await commitFiles(root, [{ path: workspace.manifest.rules, document: workspace.rules }, { path: mechanicPath, document: workspace.mechanics[index] }],
      { verify: () => readWorkspace(root) });
    return refreshCatalog();
  });
  const deleteGlobalRule = body => write(async () => {
    const workspace = await current(body, scopeOf('rules'));
    if (typeof body?.ruleId !== 'string' || !body.ruleId) fail('RULE_DELETE_INVALID', '删除规则必须提供 ruleId');
    if (!workspace.rules.rules.some(rule => rule.id === body.ruleId)) fail('RULE_NOT_FOUND', '规则不存在：' + body.ruleId);
    workspace.rules.rules = workspace.rules.rules.filter(rule => rule.id !== body.ruleId);
    const mechanics = workspace.mechanics.filter(mechanic => mechanic.pinnedRuleIds.includes(body.ruleId));
    const views = workspace.views.filter(view => view.pinnedRuleIds.includes(body.ruleId));
    for (const mechanic of mechanics) mechanic.pinnedRuleIds = mechanic.pinnedRuleIds.filter(id => id !== body.ruleId);
    for (const view of views) view.pinnedRuleIds = view.pinnedRuleIds.filter(id => id !== body.ruleId);
    validateWorkspace(workspace);
    const changes = [{ path: workspace.manifest.rules, document: workspace.rules },
      ...mechanics.map(mechanic => ({ path: workspace.files.find(file => file.kind === 'mechanic' && file.id === mechanic.id)?.path, document: mechanic })),
      ...views.map(view => ({ path: workspace.files.find(file => file.kind === 'view' && file.id === view.id)?.path, document: view }))];
    if (changes.some(change => !change.path)) fail('RULE_DELETE_INVALID', '规则关联投影缺少文件路径');
    await commitFiles(root, changes, { verify: () => readWorkspace(root) });
    return refreshCatalog();
  });
  // is-a 的写入口：概念面板与新建/修改概念对话框都走这里。rules 与受影响的 mechanics/views
  // 必须在同一次提交里落盘——删掉一条被 pinnedRuleIds 固定的 is-a 规则而不同步清理，会让工作区
  // 在下次读取时以 MISSING_REFERENCE 失败。definitions 只在新建/改名时参与同一次提交。
  const saveConceptTaxonomy = body => write(async () => {
    const workspace = await current(body, scopeOf('definitions', 'rules'));
    if (!body?.rules || typeof body.rules !== 'object') fail('CONCEPT_TAXONOMY_INVALID', 'is-a 提交必须提供完整的 rules 文档');
    assertDocument(body.rules, 'rules');
    const definitionsChanged = body.definitions !== undefined;
    if (definitionsChanged) { assertDocument(body.definitions, 'definitions'); workspace.definitions = body.definitions; }
    const nextRuleIds = new Set(body.rules.rules.map(rule => rule.id));
    const removed = new Set(workspace.rules.rules.map(rule => rule.id).filter(id => !nextRuleIds.has(id)));
    workspace.rules = body.rules;
    const mechanics = workspace.mechanics.filter(mechanic => mechanic.pinnedRuleIds.some(id => removed.has(id)));
    const views = workspace.views.filter(view => view.pinnedRuleIds.some(id => removed.has(id)));
    for (const mechanic of mechanics) mechanic.pinnedRuleIds = mechanic.pinnedRuleIds.filter(id => !removed.has(id));
    for (const view of views) view.pinnedRuleIds = view.pinnedRuleIds.filter(id => !removed.has(id));
    validateWorkspace(workspace);
    const changes = [
      ...(definitionsChanged ? [{ path: workspace.manifest.definitions, document: workspace.definitions }] : []),
      { path: workspace.manifest.rules, document: workspace.rules },
      ...mechanics.map(mechanic => ({ path: workspace.files.find(file => file.kind === 'mechanic' && file.id === mechanic.id)?.path, document: mechanic })),
      ...views.map(view => ({ path: workspace.files.find(file => file.kind === 'view' && file.id === view.id)?.path, document: view })),
    ];
    if (changes.some(change => !change.path)) fail('CONCEPT_TAXONOMY_INVALID', 'is-a 提交无法定位全部目标文件');
    // commitFiles 已经逐文件回读并逐字节比对；这里只把候选整体再校验一次。
    // 旧实现用 verify: () => readWorkspace(root) 重读整个工作区——is-a 只改 rules 与少数
    // 固定引用它的机制图，在 199 张机制图的项目上这一次重读要多花约 0.5 秒。
    // 事务全程持有工作区锁，其他写入者无法在提交窗口内改动未涉及的文件。
    await commitFiles(root, changes, { verify: async () => {
      for (const change of changes) {
        const { document } = await readDocument(root, change.path);
        if (JSON.stringify(document) !== JSON.stringify(change.document)) throw new Error('回读内容与提交不一致：' + change.path);
      }
      validateWorkspace(workspace);
    } });
    // 提交后不再重读整个工作区：用提交前的文件快照 + 本次改动的文件重算工作区版本，
    // 再用已校验的内存候选重建会话投影与 Agent 文档快照。
    // 已用测试锁定「这里算出的 revision 与下一次真实读取一致」。
    const snapshots = new Map(workspace.fileSnapshots ?? []);
    for (const change of changes) snapshots.set(change.path, JSON.stringify(semanticWorkspaceDocument(change.document)));
    workspace.revision = workspaceRevision({ snapshots, directories: workspace.directories });
    workspace.resourceRevisions = workspaceResourceRevisions(workspace);
    rememberCatalog(workspace);
    return withExportPublication(workspace, schedulePublication(workspace));
  });
  const removeMechanicNodes = body => write(async () => {
    const { mechanicId, nodeIds } = body ?? {};
    if (!Array.isArray(nodeIds) || !nodeIds.length || new Set(nodeIds).size !== nodeIds.length || nodeIds.some(id => typeof id !== 'string')) fail('MECHANIC_NODE_REMOVE_INVALID', '必须提供不重复的概念 ID');
    const workspace = await current(body, scopeOf('definitions', 'mechanic:' + mechanicId)), index = workspace.mechanics.findIndex(item => item.id === mechanicId);
    if (index < 0) fail('MECHANIC_NODE_REMOVE_INVALID', '目标机制图不存在');
    const mechanic = workspace.mechanics[index], removing = new Set(nodeIds);
    if (nodeIds.some(id => !mechanic.focusNodeIds.includes(id))) fail('MECHANIC_NODE_REMOVE_INVALID', '选中项不是当前机制图的基础概念节点');
    mechanic.focusNodeIds = mechanic.focusNodeIds.filter(id => !removing.has(id));
    for (const field of ['positions', 'nodeColors', 'nodeStyles', 'projectionPositions']) for (const id of nodeIds) delete mechanic[field]?.[id];
    const retainedConceptIds = [], prunedConceptIds = [];
    const referenced = id => workspace.rules.rules.some(rule => rule.source === id || rule.target === id || [...(rule.sourceQualifiers ?? []), ...(rule.targetQualifiers ?? [])].some(item => item.value?.kind === 'concept' && item.value.conceptId === id)) || workspace.mechanics.some(graph => graph.focusNodeIds.includes(id) || [graph.positions, graph.nodeColors, graph.nodeStyles, graph.projectionPositions].some(map => Object.hasOwn(map ?? {}, id))) || workspace.views.some(view => view.focusNodeIds.includes(id) || view.collapsedNodeIds?.includes(id) || [view.positions, view.nodeColors, view.nodeStyles, view.projectionPositions].some(map => Object.hasOwn(map ?? {}, id))) || workspace.manifest.compositions.some(view => view.focusNodeIds.includes(id) || view.collapsedNodeIds?.includes(id) || [view.positions, view.nodeColors, view.nodeStyles, view.projectionPositions].some(map => Object.hasOwn(map ?? {}, id)));
    for (const id of nodeIds) if (referenced(id)) retainedConceptIds.push(id); else { workspace.definitions.nodes = workspace.definitions.nodes.filter(node => node.id !== id); delete workspace.definitions.positions?.[id]; prunedConceptIds.push(id); }
    validateWorkspace(workspace);
    const mechanicPath = workspace.files.find(file => file.kind === 'mechanic' && file.id === mechanicId)?.path;
    if (!mechanicPath) fail('MECHANIC_NODE_REMOVE_INVALID', '目标机制图缺少文件路径');
    await commitFiles(root, [{ path: mechanicPath, document: mechanic }, { path: workspace.manifest.definitions, document: workspace.definitions }], { verify: () => readAvailable() });
    return { ...(await refreshCatalog()), removedFromGraphIds: nodeIds, retainedConceptIds, prunedConceptIds };
  });
  return {
    // 已打开项目内的单机制切换只读取目标文件。文件路径来自已验证的前端快照，
    // 仍逐项执行安全路径、文档形状和稳定 ID 检查；坏目标只让本次打开失败。
    readMechanic: ({ id, file }) => enqueue(async () => {
      if (typeof id !== 'string' || !id || typeof file !== 'string' || !file.endsWith('.mechanic.json')) fail('MECHANIC_READ_INVALID', '读取机制必须提供有效 ID 与机制文件路径');
      const { document } = await readDocument(root, file);
      assertDocument(document, 'mechanic', file);
      if (document.id !== id) fail('MECHANIC_READ_MISMATCH', '机制文件与请求 ID 不一致：' + file);
      const resourceRevision = workspaceResourceRevisions({ manifest: {}, definitions: {}, rules: {}, mechanics: [document], views: [] }).mechanics[id];
      return { mechanic: document, resourceRevision };
    }),
    // 读取入口必须回读 canonical：外部编辑、损坏文件与并发写入都要在这里显式暴露。
    // 会话快照只服务不需要重读的投影（导出设置、文档目录与后台发布）。
    read: () => enqueue(async () => {
      const workspace = await refreshSnapshot();
      return withExportPublication(workspace, await publicationForRead(workspace));
    }),
    // 只有真实项目会话在打开时才调度派生文档；底层 store 的纯读取必须无副作用，
    // 以便查询、校验和临时测试目录不会意外启动后台写入。
    ensurePublication: () => enqueue(async () => {
      // createWorkspaceStore 已建立快照；打开项目不能再次读取或重复构建 catalog。
      const workspace = workspaceSnapshot ?? await refreshSnapshot();
      if (workspace.workspaceState === 'degraded') return withExportPublication(workspace, {
        state: 'blocked', code: 'WORKSPACE_DEGRADED',
        message: '部分机制文件无效，未生成可能不完整的 Agent 文档。请先修复诊断中的文件。'
      });
      return withExportPublication(workspace, schedulePublication(workspace));
    }),
    // 文档读取只消费最近的完整快照并验证指南和目标文件；不得进入工作区队列或触发 canonical 重读。
    readCatalogBrowser: (context, selection) => {
      if (closed) return Promise.reject(new ContractError('STORE_CLOSED', '工作区已关闭'));
      if (!catalogSnapshot) return Promise.reject(new ContractError('CATALOG_SNAPSHOT_UNAVAILABLE', '文档目录快照尚未建立，请重新打开项目。'));
      return readCatalogBrowser(context, catalogSnapshot, selection);
    },
    readForQuery: () => enqueue(() => readQuerySnapshot(root, { isolateResources: true })),
    // 单文件保存只判定这份文件自己的语义版本：其他资源的写入不再阻塞它。
    save: body => write(async () => {
      const { kind, id, document } = body;
      // 网页保存携带资源基线和打开时的目标路径时，不能让无关机制的读取、校验或回读进入事务。
      // 旧调用仍走完整路径，保留其整体 revision 兼容合同。
      const singleMechanic = kind === 'mechanic' && typeof body?.file === 'string'
        && body.resourceRevisions && typeof body.resourceRevisions === 'object' && !Array.isArray(body.resourceRevisions);
      const readable = singleMechanic ? await readSingleMechanicSaveWorkspace({ id, file: body.file }) : await readAvailable();
      assertRevision(body, readable, scopeOf(resourceKey(kind, id)));
      if (readable.compatibilityMode) return saveCompatiblePresentation(readable, { kind, id, document });
      let workspace = readable;
      assertDocument(document, kind);
      let file;
      if (kind === 'definitions') {
        file = workspace.manifest.definitions; workspace.definitions = document;
      } else if (kind === 'rules') {
        file = workspace.manifest.rules; workspace.rules = document;
      } else if (kind === 'mechanic' || kind === 'view') {
        const documents = kind === 'mechanic' ? workspace.mechanics : workspace.views;
        const index = documents.findIndex(item => item.id === id);
        if (index < 0 || document.id !== id) fail('ID_CHANGED', '此类型的文件 ID 不存在或被更改');
        file = workspace.files.find(item => item.kind === kind && item.id === id).path;
        documents[index] = document;
      } else if (kind === 'workspace') {
        const { name: oldName, compositions: oldViews, lastView: oldView, ...oldFixed } = workspace.manifest;
        const { name, compositions, lastView, ...fixed } = document;
        if (!isDeepStrictEqual(oldFixed, fixed)) fail('MANIFEST_PROTECTED', '页面仅允许修改工作区名称与视图，不改变根目录、身份或统一定义入口。');
        file = 'workspace.json'; workspace.manifest = document;
      }
      // 自动修复只触及展示/导出成员；不会添加概念、规则或核心引用。
      const repaired = repairPresentationMemberReferences(workspace);
      workspace = repaired.workspace;
      const validationWorkspace = singleMechanic ? { ...workspace, manifest: { ...workspace.manifest, compositions: [] } } : workspace;
      if (singleMechanic) {
        delete validationWorkspace.manifest.exportSelections;
        delete validationWorkspace.manifest.lastView;
      }
      validateWorkspace(validationWorkspace);
      if (kind === 'view') composeView(workspace, workspace.views.find(view => view.id === id));
      const documentsByPath = new Map([
        ['workspace.json', workspace.manifest], [workspace.manifest.definitions, workspace.definitions], [workspace.manifest.rules, workspace.rules],
        ...workspace.mechanics.map(mechanic => [workspace.files.find(item => item.kind === 'mechanic' && item.id === mechanic.id)?.path, mechanic]),
        ...workspace.views.map(view => [workspace.files.find(item => item.kind === 'view' && item.id === view.id)?.path, view]),
      ]);
      const changedPaths = new Set([file, ...repaired.diagnostics.map(diagnostic => diagnostic.file)]);
      const changes = [...changedPaths].map(path => ({ path, document: documentsByPath.get(path) }));
      if (changes.some(change => !change.path || !change.document)) fail('PRESENTATION_REPAIR_INVALID', '展示成员修复无法定位持久化文件');
      if (changes.length === 1) await commitFile(root, file, encode(changes[0].document));
      else await commitFiles(root, changes, { verify: () => singleMechanic
        ? readSingleMechanicSaveWorkspace({ id, file: body.file }) : readWorkspace(root) });
      // 提交成功后按同一故障域回读目标机制与核心合同；提交失败仍由 commitFile 显式抛出。
      if (singleMechanic) return { ...await readSingleMechanicSaveWorkspace({ id, file: body.file }), singleMechanicSave: true,
        presentationDiagnostics: repaired.diagnostics };
      const committed = kind === 'definitions' || kind === 'rules' || kind === 'mechanic' || kind === 'view' ? await refreshCatalog() : await verified();
      return { ...committed, presentationDiagnostics: repaired.diagnostics };
    }),
    saveRulesAndMechanic,
    saveConceptTaxonomy,
    deleteGlobalRule,
    removeMechanicNodes,
    createMechanic: body => create('mechanic', body),
    createMechanicFolder,
    moveMechanic,
    moveMechanicFolder,
    deleteMechanicFolder,
    deleteMechanic,
    createView: body => create('view', body),
    mutateAgent,
    saveAgentDraft,
    recipeMigration,
    setProjectSettings,
    // 设置页只展示会话已读取快照，不进项目队列也不重新扫描工作区。
    documentExportStructure: () => {
      if (closed) return Promise.reject(new ContractError('STORE_CLOSED', '工作区已关闭'));
      if (!exportSettingsSnapshot) return Promise.reject(new ContractError('EXPORT_SETTINGS_SNAPSHOT_UNAVAILABLE', '导出设置快照尚未建立，请重新打开项目。'));
      if (workspaceSnapshot?.workspaceState === 'degraded') return Promise.reject(new ContractError('WORKSPACE_DEGRADED', '部分机制文件无效，导出设置已阻止；请先修复诊断中的文件。'));
      return Promise.resolve(structuredClone(exportSettingsSnapshot));
    },
    setDocumentExport,
    generateDocumentExport,
    setAgentExportPath: body => write(async () => {
      const workspace = await current(body, scopeOf('workspace'));
      return applyProjectSettings({ ...body, name: workspace.manifest.name });
    }),
    // 仅供服务关停与集成测试在直接读取或处理导出目录前等待派生发布完成。
    flushPublication: async () => { await publicationWorker; },
    close: async () => {
      if (closed) return;
      closed = true;
      await queue;
      // 服务关闭后测试或用户可立即处理项目目录，不能留下仍在写入的派生文档任务。
      await publicationWorker;
    },
  };
}

// 仅用于本次已确认的“提交器在备份清理阶段破坏了 workspace.json”的灾难恢复。
// 它不接受任意图数据：只能从项目内迁移清单重建丢失的配方 owner 和同 ID 总览视图。
export async function recoverRecipeMigration(projectRoot, manifestPath) {
  const root = await realpath(resolve(projectRoot, WORKSPACE_DIRECTORY));
  if (typeof manifestPath !== 'string' || !manifestPath.startsWith('docs/') || !manifestPath.endsWith('.json') || manifestPath.includes('\\')
    || manifestPath.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH', '恢复清单只能是项目内 docs/ 下的 JSON 相对路径');
  const manifestFile = resolve(projectRoot, manifestPath);
  if (relative(projectRoot, manifestFile).startsWith('..')) fail('UNSAFE_PATH', '恢复清单超出项目目录');
  let recipeManifest;
  try { recipeManifest = JSON.parse(await readFile(manifestFile, 'utf8')); }
  catch (error) { fail('INVALID_JSON', `恢复清单不可读取：${error.message}`); }
  const { document: definitions } = await readDocument(root, 'definitions.graph.json');
  const { mechanicPaths, directories } = await discover(root);
  if (await (async () => { try { await readDocument(root, 'workspace.json'); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } })()) {
    fail('RECOVERY_NOT_NEEDED', 'workspace.json 存在，拒绝用灾难恢复覆盖正常工作区');
  }
  if (!recipeManifest?.sourceMechanic || !Array.isArray(recipeManifest.rules) || !recipeManifest.proposedNonemptyContext?.id) {
    fail('RECIPE_MIGRATION_INVALID', '恢复清单不符合 recipe-migration schema');
  }
  const mechanics = [];
  for (const path of mechanicPaths) { const { document } = await readDocument(root, path); assertDocument(document, 'mechanic', path); mechanics.push(document); }
  const missingIds = new Set([recipeManifest.sourceMechanic, ...recipeManifest.rules.map(rule => rule.targetMechanic)]);
  if (mechanics.some(mechanic => missingIds.has(mechanic.id))) fail('RECOVERY_STATE_CONFLICT', '待恢复的来源或目标机制已有文件，拒绝混合恢复');
  const viewId = recipeManifest.sourceMechanic, contextId = recipeManifest.proposedNonemptyContext.id;
  const targetIds = [...new Set(recipeManifest.rules.map(rule => rule.targetMechanic))];
  const folder = 'mechanics/工人物语7/L3-原子规则/配方';
  if (!directories.includes(folder)) fail('FOLDER_NOT_FOUND', '配方机制目录不存在，拒绝创建恢复文件');
  const labels = {
    's7-recipe-analysis-meat': '肉类与食品配方', 's7-recipe-analysis-bread': '面包与谷物配方', 's7-recipe-analysis-books': '书籍与纸张配方',
    's7-recipe-analysis-grain-competition': '谷物竞争配方', 's7-recipe-analysis-textiles': '纺织品配方', 's7-recipe-analysis-gold-processing': '金币加工配方',
    's7-recipe-analysis-mining': '矿业与冶炼配方', 's7-recipe-analysis-water': '供水配方', 's7-recipe-analysis-forest': '林业配方',
    's7-recipe-analysis-fishing': '渔业配方', 's7-recipe-analysis-industry-competition': '工业竞争配方',
    [contextId]: recipeManifest.proposedNonemptyContext.name,
  };
  const targets = new Map(targetIds.map(id => [id, { schemaVersion: 6, kind: 'mechanic', workspaceId: definitions.workspaceId, id,
    name: labels[id] ?? id, scope: id === contextId ? '生产设施与生态前提' : '工人物语7生产配方', nodeIds: [], edges: [], positions: {} }]));
  const pairs = new Set();
  for (const rule of recipeManifest.rules) {
    if (!rule || typeof rule.source !== 'string' || typeof rule.target !== 'string' || !targets.has(rule.targetMechanic)
      || !['influence', 'specializes'].includes(rule.relation)) fail('RECIPE_MIGRATION_INVALID', '恢复清单包含无效规则');
    const pair = `${rule.source}\u0000${rule.target}`;
    if (pairs.has(pair)) fail('RECIPE_MIGRATION_INVALID', `恢复清单规则重复：${rule.source} → ${rule.target}`);
    pairs.add(pair);
    const target = targets.get(rule.targetMechanic);
    const edge = { id: semanticRuleId(rule.source, rule.target, new Set()), source: rule.source, target: rule.target,
      relation: rule.relation, sign: rule.sign, ruleText: rule.ruleText, inheritance: { mode: 'none' } };
    target.edges.push(edge);
    for (const nodeId of [rule.source, rule.target]) if (!target.nodeIds.includes(nodeId)) target.nodeIds.push(nodeId);
  }
  const manifest = { schemaVersion: 10, kind: 'workspace', id: definitions.workspaceId, name: '工人物语7机制图', definitions: 'definitions.graph.json',
    agentExportPath: 'game-mechanics', compositions: [], lastView: { viewId } };
  const view = { schemaVersion: 3, kind: 'view', workspaceId: definitions.workspaceId, id: viewId, name: '采集加工与生产配方',
    mechanicRegistrations: targetIds.map(mechanicId => ({ mechanicId, visible: true })), collapsedNodeIds: [], positions: {}, structuralPresentation: 'line' };
  const candidate = { manifest, definitions, mechanics: [...mechanics, ...targets.values()], views: [view], directories,
    files: [{ kind: 'workspace', id: manifest.id, path: 'workspace.json' }, { kind: 'definitions', path: 'definitions.graph.json' },
      ...mechanics.map((mechanic, index) => ({ kind: 'mechanic', id: mechanic.id, path: mechanicPaths[index] })),
      ...[...targets.keys()].map(id => ({ kind: 'mechanic', id, path: `${folder}/${id}.mechanic.json` })), { kind: 'view', id: view.id, path: `${view.id}.view.json` }] };
  try {
    for (const mechanic of targets.values()) {
      const graph = compose(candidate, [mechanic.id]);
      const layout = await arrangeGraphWithRoutes({ graph, positions: graphPositions(candidate, graph, {}, mechanic.id), ELK, cola });
      mechanic.positions = layout.positions; mechanic.routeCache = createRouteCache(graph, layout.positions, layout.routes);
    }
    const overview = composeView(candidate, view);
    const layout = await arrangeGraphWithRoutes({ graph: overview, positions: graphPositions(candidate, overview, {}), ELK, cola });
    view.positions = layout.positions; view.routeCache = createRouteCache(overview, layout.positions, layout.routes);
    validateWorkspace(candidate);
  } catch (error) { fail('RECOVERY_LAYOUT_FAILED', `恢复草稿排版或校验失败，未写入任何文件：${error.message}`); }
  const release = await acquireWorkspaceLock(root);
  try {
    await commitFiles(root, [{ path: 'workspace.json', document: manifest, create: true },
      ...[...targets.values()].map(document => ({ path: `${folder}/${document.id}.mechanic.json`, document, create: true })),
      { path: `${view.id}.view.json`, document: view, create: true }], { verify: () => readWorkspace(root) });
    const recovered = await readWorkspace(root);
    await publishCatalog(recovered.agentExportRoot, recovered);
    return { canonicalCommitted: true, recovered: true, workspaceId: recovered.manifest.id, revision: recovered.revision,
      viewId, targetMechanicIds: targetIds, ruleCount: recipeManifest.rules.length };
  } finally { await release(); }
}

// 迁移不调用常规 store 构造：后者刻意拒绝旧版工作区。
export async function migrateWorkspace(workspaceRoot, options = {}) {
  const root = await realpath(resolve(workspaceRoot));
  let { from, to, revision, execute = false } = options;
  if (from === undefined) {
    const { document } = await readDocument(root, 'workspace.json');
    from = document?.schemaVersion;
    if (to === undefined) to = WORKSPACE_MIGRATION_STEPS[from];
  }
  const planMigration = () => from === 7 && to === 8 ? planV7ToV8Migration(root)
    : from === 8 && to === 9 ? planV8ToV9Migration(root)
    : from === 9 && to === 10 ? planV9ToV10Migration(root)
    : from === 10 && to === 12 ? planV10ToV11Migration(root)
    : from === 11 && to === 12 ? planV11ToV12Migration(root)
    : from === 12 && to === 13 ? planV12ToV13Migration(root)
    : from === 13 && to === 14 ? planV13ToV14Migration(root)
    : from === 9 && to === 9 ? planV9DanglingNodeRepair(root)
      : Promise.reject(new ContractError('MIGRATION_VERSION_UNSUPPORTED', `不支持 v${from} → v${to} 迁移`));
  if (!execute) {
    const plan = await planMigration();
    return { ...plan.summary, from: plan.from, to: plan.to, revision: plan.revision, preview: true };
  }
  const release = await acquireWorkspaceLock(root);
  try {
    const plan = await planMigration();
    if (typeof revision !== 'string' || !revision) fail('MIGRATION_REVISION_CONFLICT', '实际迁移必须提供 dry-run 返回的 revision');
    if (revision !== plan.revision) fail('MIGRATION_REVISION_CONFLICT', '工作区自预览后已改变；未写入任何文件。');
    // 只有迁移到完整、可由当前读取器理解的协议后才做 canonical 回读。
    await commitFiles(root, plan.documents, { verify: to === 14 ? () => readWorkspace(root) : null });
    let migrated;
    try { migrated = to === 14 ? await readWorkspace(root) : { revision: plan.revision }; }
    catch (error) { fail('MIGRATION_READBACK_FAILED', `迁移提交后 v${to} 工作区回读失败：` + error.message); }
    return { ...plan.summary, from: plan.from, to: plan.to, revision: migrated.revision, preview: false, migrated: true };
  } finally { await release(); }
}
