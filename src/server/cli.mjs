#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import metadata from '../../package.json' with { type: 'json' };
import { readWorkspace } from './workspace.mjs';
import { migrateWorkspace } from './store.mjs';
import { findProject, initProject } from './workspace-commands.mjs';
import { startServer } from './http.mjs';
import { runAgent, runAgentDraft, runAgentEditSession, runAgentMechanicTarget, runAgentMutation, runRecipeMigration } from './agent.mjs';
import { publishCatalog } from './catalog.mjs';
import { acquireWorkspaceLock } from './files.mjs';
import { repairProjectionPositions } from './projection-position-repair.mjs';
import { projectContext, WORKSPACE_DIRECTORY } from './project-context.mjs';
import { listProjectReferences } from './project-references.mjs';
import { registerProjectSkills } from './project-skills.mjs';
import { migrateLegacyProject } from './migrate-legacy-project.mjs';

const usage = `Mechanics ${metadata.version} · 规则、概念与关系解释工具

mech init <项目目录> [--name <名称>] [--id <稳定ID>]
mech sync [--project <项目目录>]（同步项目内受管 skill 与 JSON 工具）
mech web [--project <项目目录>] [--port 4319]
mech validate [--project <项目目录>]
mech migrate --from 7 --to 8 | --from 8 --to 9 | --from 9 --to 10 | --from 10 --to 12 | --from 11 --to 12 | --from 9 --to 9（悬空节点修复） --project <项目目录> [--revision <预览版本>] [--execute]（默认仅预览）
mech migrate-project --project <旧项目目录> [--execute]（旧 .game-graph 的一键显式迁移）
mech repair projection-positions --project <项目目录> [--revision <预览版本>] [--execute]（只删除已无规则引用的限定投影坐标）
mech catalog [--project <项目目录>]（重建 mechanics Agent 文档）
mech root [--project <项目目录>]
mech references list --project <源项目目录>（列出源项目声明的参考项目及本机定位状态）
mech agent guide [--format json]（无需工作区，先读语义约定）
mech agent scopes [--project <项目目录>] [--connect http://127.0.0.1:<端口>]
mech agent search --query <概念ID|完整名称|完整别名>
mech agent search --from <概念键> --to <概念键>（双向直接规则）
mech agent node --id <概念ID> [--direction both] [--hops 1]
mech agent impact --from <概念ID> --to <概念ID>
mech agent session open --project <项目目录> --mechanic <ID> [--previous-session <自己的旧会话ID>] --project-generation <当前代次> --connect http://127.0.0.1:<端口>
mech agent session close --project <项目目录> --mechanic <ID> --session <open返回的会话ID> --project-generation <当前代次> --connect http://127.0.0.1:<端口>
mech agent session status --project <项目目录> --session <会话ID> --project-generation <当前代次> --connect http://127.0.0.1:<端口>
mech agent mechanic open --project <项目目录> --mechanic <ID> --project-generation <当前代次> --connect http://127.0.0.1:<端口>
mech agent draft open --project <项目目录> --mechanic <ID> --project-generation <当前代次> --connect http://127.0.0.1:<端口>
mech agent draft save --project <项目目录> --draft <open返回的草稿ID> --project-generation <当前代次> --connect http://127.0.0.1:<端口>
mech agent mechanic-folder create --name <单段目录名> [--parent <已有相对目录>] --workspace-revision <工作区版本>
mech agent mechanic-folder delete --folder <相对目录> --workspace-revision <工作区版本>
mech agent mechanic create --id <稳定ID> --name <名称> --scope <范围> [--folder <已有相对目录>] --workspace-revision <工作区版本>
mech agent mechanic update|delete --mechanic <ID> [--name <名称>] [--scope <范围>] [--remove-isolated-concepts <JSON字符串数组>] --revision <机制资源版本>
mech agent mechanic arrange --mechanic <ID> --revision <机制资源版本>
mech agent recipe-migration preview --project <项目目录> --manifest <项目内 docs/ 相对路径>
mech agent recipe-migration execute --project <项目目录> --manifest <项目内 docs/ 相对路径> --revision <preview返回的工作区版本>
mech agent recipe-migration recover --project <项目目录> --manifest <项目内 docs/ 相对路径>（仅 workspace.json 丢失后的受限恢复）
mech agent view delete --view <ID> --workspace-revision <工作区版本>
mech agent concept create --id <概念ID> --label <名称> --description <定义> [--custom-data <文本>] --revision <资源版本>
mech agent concept update|delete --concept <概念ID> --revision <资源版本>
mech agent rule add|update|delete --mechanic <投影机制ID> --source <概念ID> --target <概念ID> [--source-qualifiers <JSON数组>] [--target-qualifiers <JSON数组>] [--text <规则>] [--custom-data <文本>] --revision <全局规则资源版本>
  agent 通用：--project <项目目录> 或 --connect http://127.0.0.1:<端口>
    查询只输出 JSON；路径：--max-paths 50 --max-depth 16 --max-expansions 10000
  Agent 的 --project 只定位后台项目上下文，不切换网页当前标签。mechanic open 只解析目标：缺失时返回 create-required，不产生编辑会话；session open 仅会在提供 --previous-session 时异步关闭该旧会话；session close 会异步自动整理并回读，返回 jobId 后无需等待。新建机制文件夹和空机制图是容器准备操作，不需要 session；其余在线写入必须提供 session open 返回的 --session
  mechanic update/arrange 取 resourceRevisions.mechanics[机制ID]；concept mutation 取 resourceRevisions.definitions；rule mutation 取 resourceRevisions.rules；容器创建取 --workspace-revision= scopes.revision；在线写入还须 --project-generation
  当前关系：influence 需 sign 与 inheritance；端点限定词只属于 influence 规则；specializes 为无 sign/inheritance/限定词的具体概念 → 上位概念 DAG
  Agent 只能创建受约束的机制文件夹/空白机制图，原子更新或安全删除机制、删除非当前视图，或调用与网页同算法的整图自动排版，或写概念与规则白名单字段；不能写入任意坐标、Agent 锁、视图结构、文件路径或原始机制元数据
mech --help | --version

web 省略 --project 时以空项目状态启动，由网页打开项目。
validate / catalog / root 省略 --project 时，从当前目录向上寻找最近的 .mechanics。
init 不覆盖已有 .mechanics 或不同内容的同名 skill，并注册包内 Mechanics skills 到项目 .agents/skills。
运行时只读取项目内固定 v11 工作区；旧版本只能通过显式 migrate 迁移。
需要 Node.js 24+。不上传分析资料，也不自动公开发布。`;

try {
  const { positionals, values } = parseArgs({ options: {
    project: { type: 'string' }, port: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, execute: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      ...Object.fromEntries(['connect', 'format', 'mechanic', 'view', 'revision', 'direction', 'hops', 'query', 'from', 'to', 'max-paths', 'max-depth', 'max-expansions',
      'label', 'description', 'aliases', 'tag-ids', 'custom-data', 'concept', 'source', 'target', 'source-qualifiers', 'target-qualifiers', 'relation', 'sign', 'text', 'inheritance', 'project-generation', 'session', 'previous-session', 'workspace-revision', 'parent', 'scope', 'folder', 'remove-isolated-concepts', 'manifest', 'library', 'entry', 'workspace-id', 'draft'].map(key => [key, { type: 'string' }])),
    'include-inherited': { type: 'boolean' },
  }, allowPositionals: true });
  const [command, target] = positionals;
  if (values.help || (!command && !Object.keys(values).length)) console.log(usage);
  else if (values.version && !command && Object.keys(values).length === 1) console.log(metadata.version);
  else if (command === 'agent') {
    if (target === 'draft') {
      if (positionals.length !== 3) throw Object.assign(new Error('draft 需要动作子命令'), { code: 'AGENT_DRAFT_INVALID' });
      console.log(await runAgentDraft(positionals[2], values));
    } else if (target === 'session') {
      if (positionals.length !== 3) throw Object.assign(new Error('session 需要动作子命令'), { code: 'AGENT_EDIT_SESSION_INVALID' });
      console.log(await runAgentEditSession(positionals[2], values));
    } else if (target === 'recipe-migration') {
      if (positionals.length !== 3) throw Object.assign(new Error('recipe-migration 需要动作子命令'), { code: 'AGENT_MUTATION_INVALID' });
      console.log(await runRecipeMigration(positionals[2], values));
    } else if (target === 'mechanic' && positionals[2] === 'open') {
      if (positionals.length !== 3) throw Object.assign(new Error('mechanic open 只接受一个动作子命令'), { code: 'AGENT_MECHANIC_TARGET_INVALID' });
      console.log(await runAgentMechanicTarget(positionals[2], values));
    } else if (['mechanic-folder', 'mechanic', 'view', 'concept', 'rule'].includes(target)) {
      if (positionals.length !== 3) throw Object.assign(new Error('Agent 写入需要资源与动作两级子命令'), { code: 'AGENT_MUTATION_INVALID' });
      console.log(await runAgentMutation(target, positionals[2], values));
    } else {
      if (positionals.length !== 2) throw new Error('agent 查询需要且只接受一个子命令');
      console.log(await runAgent(target, values));
    }
  }
  else if (command === 'references') {
    if (target !== 'list' || positionals.length !== 2 || !values.project) throw new Error('references 仅支持 list --project <源项目目录>');
    console.log(JSON.stringify(await listProjectReferences(await realpath(resolve(values.project))), null, 2));
  }
  else {
    const allowed = { init: ['name', 'id'], sync: ['project'], web: ['project', 'port'], validate: ['project'], migrate: ['project', 'from', 'to', 'revision', 'execute'], 'migrate-project': ['project', 'execute'], repair: ['project', 'revision', 'execute'], catalog: ['project'], root: ['project'] };
    if (!allowed[command] || positionals.length !== (command === 'init' || command === 'repair' ? 2 : 1)) throw new Error('命令或参数数量无效，请运行 --help。');
    for (const option of Object.keys(values)) if (!allowed[command].includes(option)) throw new Error(command + ' 不支持 --' + option);
    if (command === 'init') console.log(JSON.stringify(await initProject(target, { name: values.name, id: values.id }), null, 2));
    else {
      if (values.project === '') throw new Error('--project 不能为空');
      const projectRoot = values.project !== undefined ? await realpath(resolve(values.project))
        : command === 'web' ? null : await findProject();
      const context = projectRoot && !['sync', 'migrate-project', 'web'].includes(command) ? ['migrate', 'repair'].includes(command) ? { projectRoot, workspaceRoot: resolve(projectRoot, WORKSPACE_DIRECTORY) }
        : await projectContext(projectRoot, command === 'catalog' ? { createExportRoot: true }
          : { allowMissingExport: true, allowUnavailableExport: true }) : null;
      if (command === 'migrate-project') {
        if (!values.project) throw Object.assign(new Error('migrate-project 必须显式指定 --project。'), { code: 'PROJECT_REQUIRED' });
        console.log(JSON.stringify(await migrateLegacyProject(projectRoot, { execute: values.execute === true }), null, 2));
      } else if (command === 'sync') {
        const verifiedProjectRoot = await findProject(projectRoot);
        console.log(JSON.stringify({ ok: true, projectRoot: verifiedProjectRoot, ...await registerProjectSkills(verifiedProjectRoot) }, null, 2));
      } else if (command === 'repair') {
        if (target !== 'projection-positions') throw Object.assign(new Error('repair 仅支持 projection-positions'), { code: 'REPAIR_UNSUPPORTED' });
        console.log(JSON.stringify(await repairProjectionPositions(context.workspaceRoot, { revision: values.revision, execute: values.execute === true }), null, 2));
      } else if (command === 'migrate') {
        const from = Number(values.from), to = Number(values.to);
        if (!((from === 7 && to === 8) || (from === 8 && to ===9) || (from === 9 && to === 10) || (from === 10 && to === 12) || (from === 11 && to === 12) || (from === 9 && to === 9))) throw Object.assign(new Error('migrate 仅支持 --from 7 --to 8、--from 8 --to 9、--from 9 --to 10、--from 10 --to 12、--from 11 --to 12 或 --from 9 --to 9'), { code: 'MIGRATION_VERSION_UNSUPPORTED' });
        console.log(JSON.stringify(await migrateWorkspace(context.workspaceRoot, { from, to, revision: values.revision, execute: values.execute === true }), null, 2));
      } else if (command === 'catalog') {
        const release = await acquireWorkspaceLock(context.workspaceRoot);
        try {
          const data = await readWorkspace(context.workspaceRoot, { context });
          const catalog = await publishCatalog(context.exportRoot, data);
          await readWorkspace(context.workspaceRoot, { context });
          console.log(JSON.stringify({ ok: true, projectRoot, workspaceRoot: context.workspaceRoot,
            agentExportRoot: context.exportRoot, workspaceId: data.manifest.id, concepts: catalog.dossiers.size,
            semanticRevision: catalog.semanticRevision }, null, 2));
        } finally { await release(); }
      } else {
        const data = context ? await readWorkspace(context.workspaceRoot, { context }) : null;
        if (command === 'root') console.log(projectRoot);
        else if (command === 'validate') console.log(JSON.stringify({ ok: true, projectRoot, workspaceRoot: context.workspaceRoot,
          agentExportRoot: context.exportRoot, workspaceId: data.manifest.id, nodes: data.definitions.nodes.length,
          mechanics: data.mechanics.length, views: data.views.length, revision: data.revision }, null, 2));
        else {
          const rawPort = values.port ?? '4319', port = Number(rawPort);
          if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port > 65535) throw new Error('端口必须是 0–65535 的整数');
          const { close, url } = await startServer({ projectRoot, port });
          console.log(`Mechanics · 规则、概念与关系解释工具\n${url}\n${projectRoot ? `已打开项目：${projectRoot}` : '尚未打开项目，请在网页中选择项目。'}`);
          let stopping = false;
          const shutdown = () => {
            if (stopping) return;
            stopping = true;
            close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
          };
          process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
        }
      }
    }
  }
} catch (error) {
  if (process.argv[2] === 'agent') {
    const code = error.code ?? 'COMMAND_FAILED';
    const details = Object.fromEntries(Object.entries(error).filter(([key]) => !['code', 'error'].includes(key)));
    console.error(JSON.stringify({ error: code, message: error.message, ...details }));
  }
  else console.error(`${error.code ?? 'COMMAND_FAILED'}：${error.message}`);
  process.exitCode = 1;
}
