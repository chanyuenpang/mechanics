import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { createWorkspaceStore, migrateWorkspace } from './store.mjs';
import { initProject } from './workspace-commands.mjs';
import { registerProjectSkills } from './project-skills.mjs';
import { projectContext, WORKSPACE_DIRECTORY } from './project-context.mjs';
import { readDocument } from './workspace.mjs';
import { MIGRATABLE_WORKSPACE_VERSIONS, workspaceMigrationPlan } from './migration.mjs';
import { createLocalUiState } from './local-ui-state.mjs';
import { ContractError } from '../domain/validate.mjs';
import { bindProjectReference, declareProjectReference, listProjectReferences, projectReferenceState, removeProjectReference } from './project-references.mjs';
import { openAgentDraft, readAgentDraft, removeAgentDraft } from './agent-draft.mjs';

const fail = (code, message) => { throw new ContractError(code, message); };
const rootKey = value => value.toLowerCase();
// 打开项目时自动升级所有仍有显式迁移路径的旧协议（迁移链定义见 migration.mjs）：
// 逐级预览→执行，任何一跳失败都不留下部分升级；更早或未知的版本仍只按核心拓扑兼容模式只读打开。
async function upgradeWorkspace(workspaceRoot) {
  const version = (await readDocument(workspaceRoot, 'workspace.json')).document?.schemaVersion;
  if (!MIGRATABLE_WORKSPACE_VERSIONS.includes(version)) return { upgraded: false, schemaVersion: version };
  const steps = workspaceMigrationPlan(version);
  for (const step of steps) {
    try {
      const preview = await migrateWorkspace(workspaceRoot, step);
      await migrateWorkspace(workspaceRoot, { ...step, revision: preview.revision, execute: true });
    } catch (error) {
      // 失败的候选不写任何文件；错误里带上具体版本段，界面可直接呈现冲突边与失败原因。
      error.message = `项目打开时的自动升级失败（v${step.from} → v${step.to}）：` + error.message;
      error.upgrade = { from: version, failedStep: step };
      throw error;
    }
  }
  const schemaVersion = (await readDocument(workspaceRoot, 'workspace.json')).document?.schemaVersion;
  return { upgraded: true, from: version, schemaVersion };
}

// activeToken 只兼容旧 API 的“当前项目”；带 token 的读写永远命中自己的会话。
export function createProjectManager({ onActivated = null, syncProjectAssets = registerProjectSkills } = {}) {
  const sessions = new Map(), roots = new Map();
  let activeToken = null, generation = 0, queue = Promise.resolve(), closed = false;
  const enqueue = operation => {
    if (closed) return Promise.reject(new ContractError('PROJECT_MANAGER_CLOSED', '项目管理器已关闭'));
    const result = queue.then(operation); queue = result.catch(() => {}); return result;
  };
  const attach = (workspace, session) => ({ ...workspace, projectGeneration: session.generation, projectSessionToken: session.token,
    projectAssetSync: session.assetSync, projectUpgrade: session.upgrade });
  // 同步独立于项目读写队列；先让打开响应返回，同一会话只允许一个同步任务。
  const scheduleAssetSync = session => {
    if (session.assetSyncTask) return;
    session.assetSync = { state: 'pending', projectRoot: session.context.projectRoot };
    session.assetSyncTask = new Promise(resolve => setImmediate(resolve)).then(async () => {
      try {
        const result = await syncProjectAssets(session.context.projectRoot);
        session.assetSync = { state: 'current', projectRoot: session.context.projectRoot, ...result };
      } catch (error) {
        session.assetSync = { state: 'failed', projectRoot: session.context.projectRoot,
          code: error.code ?? 'PROJECT_ASSET_SYNC_FAILED', message: error.message };
        console.error(`项目技能与脚本后台更新失败：${session.context.projectRoot}`, error);
      }
    }).finally(() => { session.assetSyncTask = null; });
  };
  const current = (token, expectedGeneration) => {
    const session = token === undefined || token === null ? sessions.get(activeToken) : sessions.get(token);
    if (!session) fail(token ? 'PROJECT_SESSION_INVALID' : 'PROJECT_REQUIRED', token ? '项目标签会话已失效，请重新打开该标签' : '尚未打开项目');
    if (expectedGeneration !== undefined && expectedGeneration !== session.generation) fail('PROJECT_CHANGED', '当前页面属于先前打开的项目。草稿未写入；请重新打开目标项目。');
    return session;
  };
  const call = (body, operation) => enqueue(async () => {
    const session = current(body?.projectSessionToken, body?.projectGeneration);
    return attach(await operation(session.store), session);
  });
  const enqueueAgentEdit = (session, operation) => {
    const result = session.agentEdit.queue.then(operation);
    // 关闭任务失败只记录在对应会话上；后续会话仍可继续进入队列，不会被旧图的排版失败永久卡住。
    session.agentEdit.queue = result.catch(() => {});
    return result;
  };
  const agentEditSummary = (session, record, extra = {}) => ({
    projectGeneration: session.generation,
    projectSessionToken: session.token,
    session: record.id,
    mechanic: record.mechanic,
    status: record.status,
    ...(record.jobId ? { jobId: record.jobId } : {}),
    ...(record.result ? { result: record.result } : {}),
    ...(record.failure ? { failure: record.failure } : {}),
    ...extra,
  });
  const queueAgentClose = (session, record, reason) => {
    if (record.status === 'closing' || record.status === 'closed') return record;
    // 关闭 Agent 编辑会话不再隐式重排或写入机制图。重排是明确的用户操作；
    // 不能让关闭后的后台任务占住目标资源，拖慢用户立即打开或操作该图。
    record.status = 'closed'; record.closeReason = reason;
    record.result = { arranged: false };
    return record;
  };
  const assertAgentEditTarget = (record, body) => {
    if (body?.resource === 'rule' && body.mechanic !== record.mechanic) {
      fail('AGENT_EDIT_SCOPE_MISMATCH', `当前编辑会话属于机制 ${record.mechanic}，不能写入规则到 ${body.mechanic}`);
    }
    if (body?.resource === 'mechanic' && body.action !== 'create' && body.mechanic !== record.mechanic) {
      fail('AGENT_EDIT_SCOPE_MISMATCH', `当前编辑会话属于机制 ${record.mechanic}，不能写入机制 ${body.mechanic}`);
    }
  };
  // 打开成功后后台同步受管资产，不能因权限、文件占用或网络盘延迟阻断网页响应。
  const openStore = async (body, { activate = true, recordHistory = activate, syncAssets = true } = {}) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.projectRoot !== 'string' || !isAbsolute(body.projectRoot)) fail('PROJECT_REQUIRED', '打开项目必须提供绝对 projectRoot');
    const requested = resolve(body.projectRoot), known = roots.get(rootKey(requested));
    if (known) {
      if (activate) activeToken = known.token;
      const workspace = await known.store.read();
      if (syncAssets) scheduleAssetSync(known);
      return attach(workspace, known);
    }
    const marker = resolve(requested, WORKSPACE_DIRECTORY);
    try { await lstat(marker); if (body.intent === 'initialize') fail('PROJECT_PREFLIGHT_STALE', '项目工作区在打开前已经出现，请重新预检'); }
    catch (error) {
      if (error.code === 'PROJECT_PREFLIGHT_STALE') throw error;
      if (error.code !== 'ENOENT') throw error;
      if (body.intent === 'existing') fail('PROJECT_PREFLIGHT_STALE', '项目工作区在打开前消失，请重新预检');
      try { await initProject(requested, { name: body.name, id: body.id, createProjectRoot: false, syncAssets: false }); }
      catch (failure) { if (failure.code === 'INVALID_ID') fail('PROJECT_METADATA_REQUIRED', failure.message); throw failure; }
    }
    // 旧协议必须在创建 store 前完成自动升级：升级失败不进入只读兼容模型，也不返回部分工作区。
    const upgrade = await upgradeWorkspace(marker);
    const context = await projectContext(requested, { allowMissingExport: true, allowUnavailableExport: true }),
      store = await createWorkspaceStore(context.workspaceRoot, { isolateResources: true });
    let workspace;
    try { workspace = await store.ensurePublication(); } catch (error) { await store.close(); throw error; }
    const session = { token: randomUUID(), generation: ++generation, context, store, upgrade, workspaceId: workspace.manifest.id,
      localUiState: createLocalUiState(context.workspaceRoot), agentEdit: { records: new Map(), queue: Promise.resolve() }, agentDraft: null };
    sessions.set(session.token, session); roots.set(rootKey(context.projectRoot), session); if (activate) activeToken = session.token;
    if (recordHistory && onActivated) await onActivated({ projectRoot: context.projectRoot, workspaceId: workspace.manifest.id, name: workspace.manifest.name });
    scheduleAssetSync(session);
    return attach(workspace, session);
  };
  const agentProject = async body => {
    if (typeof body?.projectRoot !== 'string' || !isAbsolute(body.projectRoot)) {
      fail('AGENT_PROJECT_REQUIRED', '在线 Agent 操作必须提供绝对 projectRoot；它不会切换网页当前项目');
    }
    const opened = await openStore({ projectRoot: body.projectRoot, intent: 'existing' }, { activate: false, recordHistory: false, syncAssets: false });
    const session = sessions.get(opened.projectSessionToken);
    if (body.projectGeneration !== undefined && body.projectGeneration !== session.generation) {
      fail('PROJECT_CHANGED', 'Agent 所用项目上下文已改变，请重新读取 scopes 后继续');
    }
    return session;
  };

  return {
    state: () => enqueue(async () => {
      const session = activeToken ? current() : null;
      return session ? { status: 'active', projectRoot: session.context.projectRoot, workspaceRoot: session.context.workspaceRoot, agentExportRoot: session.context.exportRoot,
        projectGeneration: session.generation, projectSessionToken: session.token, workspaceId: session.workspaceId,
        openSessions: [...sessions.values()].map(item => ({ projectRoot: item.context.projectRoot, workspaceId: item.workspaceId, projectSessionToken: item.token })) }
        : { status: 'empty', projectGeneration: generation };
    }),
    open: body => enqueue(() => openStore(body)),
    readAssetSync: token => { const session = current(token); return attach({}, session); },
    select: token => enqueue(async () => { const session = current(token); activeToken = session.token; return attach(await session.store.read(), session); }),
    enterReference: body => enqueue(async () => {
      const source = current(body?.projectSessionToken, body?.projectGeneration);
      if (typeof body?.referenceId !== 'string' || !body.referenceId) fail('REFERENCE_ID_REQUIRED', '进入关联项目必须提供关联条目 ID');
      const reference = (await listProjectReferences(source.context.projectRoot)).find(item => item.id === body.referenceId);
      if (!reference) fail('REFERENCE_NOT_DECLARED', `源项目未声明关联项目：${body.referenceId}`);
      if (!['ready', 'migratable'].includes(reference.status)) fail('REFERENCE_UNAVAILABLE', `关联项目“${reference.name}”当前不可进入：${reference.status}`);
      return openStore({ projectRoot: reference.projectRoot, intent: 'existing' }, { activate: false, recordHistory: false });
    }),
    read: token => enqueue(async () => { const session = current(token); return attach(await session.store.read(), session); }),
    readMechanic: body => enqueue(async () => {
      const session = current(body?.projectSessionToken, body?.projectGeneration);
      return { ...await session.store.readMechanic(body), projectGeneration: session.generation, projectSessionToken: session.token };
    }),
    readForQuery: token => enqueue(async () => { const session = current(token); return attach(await session.store.readForQuery(), session); }),
    readForAgent: body => enqueue(async () => { const session = await agentProject(body); return attach(await session.store.readForQuery(), session); }),
    openAgentMechanic: body => enqueue(async () => {
      const session = await agentProject(body);
      if (typeof body?.mechanic !== 'string' || !body.mechanic) fail('AGENT_MECHANIC_TARGET_INVALID', '打开机制目标必须提供机制 ID');
      const workspace = await session.store.readForQuery();
      const mechanic = workspace.mechanics.find(item => item.id === body.mechanic);
      return attach({ mechanic: body.mechanic, exists: Boolean(mechanic), status: mechanic ? 'existing' : 'create-required', workspaceRevision: workspace.revision,
        ...(mechanic ? { resourceRevision: workspace.resourceRevisions.mechanics[body.mechanic], name: mechanic.name, scope: mechanic.scope } : {}) }, session);
    }),
    openAgentDraft: body => enqueue(async () => {
      const session = await agentProject(body);
      if (typeof body?.mechanic !== 'string' || !body.mechanic) fail('AGENT_DRAFT_INVALID', 'draft open 必须提供机制 ID');
      // open 是切换动作：旧草稿先走完全相同的 save，失败则不创建新草稿。
      if (session.agentDraft) {
        const previous = session.agentDraft, { definitions, rules, mechanic: document } = await readAgentDraft(previous);
        await session.store.saveAgentDraft({ mechanic: previous.mechanic, workspaceRevision: previous.workspaceRevision,
          definitionsRevision: previous.definitionsRevision, rulesRevision: previous.rulesRevision, mechanicRevision: previous.mechanicRevision, definitions, rules, document });
        await removeAgentDraft(previous); session.agentDraft = null;
      }
      const record = await openAgentDraft(await session.store.read(), body.mechanic);
      session.agentDraft = record;
      return { ...record, draftId: record.id, draftPath: record.root, projectGeneration: session.generation, projectSessionToken: session.token };
    }),
    saveAgentDraft: body => enqueue(async () => {
      const session = await agentProject(body), record = session.agentDraft;
      if (!record || record.id !== body?.draftId) fail('AGENT_DRAFT_NOT_FOUND', '没有与当前服务会话匹配的草稿；请重新 draft open');
      const { definitions, rules, mechanic: document } = await readAgentDraft(record);
      const result = await session.store.saveAgentDraft({ mechanic: record.mechanic, workspaceRevision: record.workspaceRevision,
        definitionsRevision: record.definitionsRevision, rulesRevision: record.rulesRevision, mechanicRevision: record.mechanicRevision, definitions, rules, document });
      await removeAgentDraft(record); session.agentDraft = null;
      return { ...result, projectGeneration: session.generation, projectSessionToken: session.token };
    }),
    readLocalUiState: token => enqueue(async () => { const session = current(token); return { ...await session.localUiState.read(), projectGeneration: session.generation, projectSessionToken: session.token }; }),
    saveLocalUiState: body => enqueue(async () => { const session = current(body?.projectSessionToken, body?.projectGeneration); return { ...await session.localUiState.save({ version: 1, lastOpened: body?.lastOpened, recentViews: body?.recentViews, recentMechanics: body?.recentMechanics, openTabs: body?.openTabs }), projectGeneration: session.generation, projectSessionToken: session.token }; }),
    listProjectReferences: token => enqueue(async () => { const session = current(token); return { projectRoot: session.context.projectRoot, projectGeneration: session.generation, projectSessionToken: session.token, ...await projectReferenceState(session.context.projectRoot) }; }),
    bindProjectReference: body => enqueue(async () => { const session = current(body?.projectSessionToken, body?.projectGeneration); if (typeof body?.referenceId !== 'string' || typeof body?.projectRoot !== 'string' || !isAbsolute(body.projectRoot)) fail('REFERENCE_BINDING_INVALID', '参考目录绑定必须提供 referenceId 与绝对 projectRoot'); return { projectRoot: session.context.projectRoot, projectGeneration: session.generation, projectSessionToken: session.token, references: await bindProjectReference(session.context.projectRoot, body.referenceId, body.projectRoot) }; }),
    declareProjectReference: body => enqueue(async () => { const session = current(body?.projectSessionToken, body?.projectGeneration); return { projectRoot: session.context.projectRoot, projectGeneration: session.generation, projectSessionToken: session.token, references: await declareProjectReference(session.context.projectRoot, body) }; }),
    removeProjectReference: body => enqueue(async () => {
      const session = current(body?.projectSessionToken, body?.projectGeneration);
      const removed = await removeProjectReference(session.context.projectRoot, body);
      return { projectRoot: session.context.projectRoot, projectGeneration: session.generation, projectSessionToken: session.token, ...removed };
    }),
    // 文档读取只用会话建立的 catalog 快照，不能排进全局项目队列或触发工作区全读。
    readConceptDocs: async (conceptId, token) => { const session = current(token); return attach(await session.store.readCatalogBrowser(session.context, conceptId), session); },
    // 设置读取只消费 store 的会话快照，不应被其他项目操作排队。
    readDocumentExport: token => { const session = current(token); return session.store.documentExportStructure().then(result => attach(result, session)); },
    save: body => call(body, store => store.save(body)), saveRulesAndMechanic: body => call(body, store => store.saveRulesAndMechanic(body)), deleteGlobalRule: body => call(body, store => store.deleteGlobalRule(body)), removeMechanicNodes: body => call(body, store => store.removeMechanicNodes(body)), createMechanic: body => call(body, store => store.createMechanic(body)), createMechanicFolder: body => call(body, store => store.createMechanicFolder(body)), moveMechanic: body => call(body, store => store.moveMechanic(body)), moveMechanicFolder: body => call(body, store => store.moveMechanicFolder(body)), deleteMechanicFolder: body => call(body, store => store.deleteMechanicFolder(body)), deleteMechanic: body => call(body, store => store.deleteMechanic(body)), createView: body => call(body, store => store.createView(body)),
    openAgentEdit: body => enqueue(async () => {
      const session = await agentProject(body);
      if (typeof body?.mechanic !== 'string' || !body.mechanic) fail('AGENT_EDIT_SESSION_INVALID', '打开编辑会话必须提供机制 ID');
      const workspace = await session.store.read();
      const previous = body.previousEditSessionId ? session.agentEdit.records.get(body.previousEditSessionId) : null;
      let autoClosed;
      if (previous?.status === 'open') autoClosed = agentEditSummary(session, queueAgentClose(session, previous, 'superseded'));
      if (!workspace.mechanics.some(item => item.id === body.mechanic)) fail('SCOPE_NOT_FOUND', `机制不存在：${body.mechanic}`);
      const record = { id: randomUUID(), mechanic: body.mechanic, status: 'open', openedAt: Date.now() };
      session.agentEdit.records.set(record.id, record);
      return agentEditSummary(session, record, autoClosed ? { autoClosed } : {});
    }),
    closeAgentEdit: body => enqueue(async () => {
      const session = await agentProject(body);
      const record = session.agentEdit.records.get(body?.editSessionId);
      if (!record) fail('AGENT_EDIT_SESSION_REQUIRED', '关闭编辑会话必须提供当前 open 返回的 --session');
      if (typeof body?.mechanic !== 'string' || body.mechanic !== record.mechanic) fail('AGENT_EDIT_SCOPE_MISMATCH', '关闭目标必须与编辑会话的机制一致');
      if (record.status === 'closed') return agentEditSummary(session, record, { accepted: true, asynchronous: false, reused: true });
      const queued = queueAgentClose(session, record, 'explicit');
      return agentEditSummary(session, queued, { accepted: true, asynchronous: false });
    }),
    agentEditStatus: body => enqueue(async () => {
      const session = await agentProject(body);
      const record = session.agentEdit.records.get(body?.editSessionId);
      if (!record) fail('AGENT_EDIT_SESSION_REQUIRED', '查询编辑会话必须提供 --session');
      return agentEditSummary(session, record);
    }),
    mutateAgent: body => {
      if (!Number.isInteger(body?.projectGeneration)) fail('PROJECT_CHANGED', '在线 Agent 写入必须提供当前整数 projectGeneration');
      return enqueue(async () => {
        const session = await agentProject(body);
        const requiresEditSession = !['mechanic-folder', 'mechanic'].includes(body?.resource)
          || (body?.resource === 'mechanic' && body.action !== 'create');
        if (!requiresEditSession) return attach(await enqueueAgentEdit(session, () => session.store.mutateAgent(body)), session);
        const record = session.agentEdit.records.get(body?.editSessionId);
        if (!record) fail('AGENT_EDIT_SESSION_REQUIRED', 'Agent 写入前必须先执行 mechanic open，并提供返回的 --session');
        if (record.status !== 'open') fail('AGENT_EDIT_SESSION_CLOSED', `编辑会话已${record.status === 'closing' ? '进入关闭整理' : record.status === 'failed' ? '关闭失败' : '关闭'}，请重新 open`);
        assertAgentEditTarget(record, body);
        const result = await enqueueAgentEdit(session, () => session.store.mutateAgent(body));
        // 删除机制后不存在可供 close 排版的图；将本会话自然结束，避免把一次成功删除误报为关闭整理失败。
        if (body.resource === 'mechanic' && body.action === 'delete') {
          record.status = 'closed'; record.result = { revision: result.revision, resourceRevision: result.resourceRevision, deleted: true };
        }
        return attach(result, session);
      });
    },
    setProjectSettings: body => enqueue(async () => { const session = current(body?.projectSessionToken, body?.projectGeneration), workspace = await session.store.setProjectSettings(body); session.context = await projectContext(session.context.projectRoot, { allowMissingExport: true, allowUnavailableExport: true }); if (onActivated) await onActivated({ projectRoot: session.context.projectRoot, workspaceId: workspace.manifest.id, name: workspace.manifest.name }); return attach(workspace, session); }),
    setDocumentExport: body => call(body, store => store.setDocumentExport(body)),
    generateDocumentExport: body => call(body, store => store.generateDocumentExport(body)),
    setAgentExportPath: body => enqueue(async () => { const session = current(body?.projectSessionToken, body?.projectGeneration), workspace = await session.store.setAgentExportPath(body); session.context = await projectContext(session.context.projectRoot, { allowMissingExport: true, allowUnavailableExport: true }); return attach(workspace, session); }),
    close: async () => { if (closed) return; await enqueue(async () => { await Promise.all([...sessions.values()].map(async session => { await session.agentEdit.queue; await session.store.close(); await session.assetSyncTask; })); sessions.clear(); roots.clear(); activeToken = null; }); closed = true; },
  };
}
