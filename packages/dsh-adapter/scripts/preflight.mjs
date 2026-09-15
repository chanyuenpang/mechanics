#!/usr/bin/env node
// 重启前的离线预检：用 DSH 自己的校验函数检查本插件的宿主半与客户端半是否满足契约。
// 与 @veewo/dsh-claw-kit 同路径——tools.register(原始 JSON Schema 定义)，
// 所以这里校验的就是 register() 真正会校验的东西，加上派发期会做的参数/输出校验。
//
// 用法：
//   node scripts/preflight.mjs [--profile web] [--home <DSH_HOME>] [--tarball <包目录>]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf('--' + name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const home = resolve(option('home', join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')));
const profile = option('profile', 'web');
const profileDir = join(home, 'profiles', profile);
const packageDir = resolve(option('package', join(import.meta.dirname, '..')));
const packageName = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name;

const failures = [];
const note = (ok, label) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) failures.push(label);
};

// DSH CLI 是全局安装的，它的 node_modules 里才有 dsh-tools 与 cordis（profile 的 pnpm 布局解析不到）。
// 依次尝试：显式 --dsh、各 PATH 目录、npm 全局前缀下的 @deepseek-ai/dsh。
function resolveDshCli() {
  const explicit = option('dsh', undefined);
  const candidates = [];
  if (explicit !== undefined) candidates.push(explicit);
  const npmPrefix = process.env.APPDATA !== undefined
    ? join(process.env.APPDATA, 'npm')
    : join(process.env.HOME ?? '', '.npm-global', 'lib');
  candidates.push(join(npmPrefix, 'node_modules', '@deepseek-ai', 'dsh'));
  for (const entry of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (dir) candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh'));
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

const dshCliDir = resolveDshCli();
const explicitTools = option('dsh-tools', undefined);
const cliRequire = dshCliDir === undefined ? undefined : createRequire(join(dshCliDir, 'package.json'));
const resolveModule = (specifier, explicit) => {
  if (explicit !== undefined) return pathToFileURL(explicit).href;
  if (cliRequire !== undefined) {
    try {
      return pathToFileURL(cliRequire.resolve(specifier)).href;
    } catch {
      // 落到 profile/cwd 锚点
    }
  }
  for (const anchor of [join(profileDir, 'package.json'), join(process.cwd(), 'package.json')]) {
    try {
      return pathToFileURL(createRequire(anchor).resolve(specifier)).href;
    } catch {
      // 继续尝试下一个锚点
    }
  }
  return undefined;
};

const toolsUrl = resolveModule('@deepseek-ai/dsh-tools', explicitTools);
if (toolsUrl === undefined) throw new Error('无法定位 @deepseek-ai/dsh-tools：请用 --dsh-tools <绝对路径> 指定');
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(toolsUrl);
const { apply } = await import(pathToFileURL(join(packageDir, 'src/index.mjs')).href);

// ---- 客户端半：宿主如何解析到这个包、它的 bundle 与 profile 层 ----
if (!existsSync(join(profileDir, 'package.json'))) {
  note(false, 'profile 目录存在：' + profileDir);
} else {
  const profileRequire = createRequire(join(profileDir, 'package.json'));
  let manifestPath;
  try {
    manifestPath = profileRequire.resolve(packageName + '/package.json');
    note(true, 'profile 能解析到包：' + manifestPath);
  } catch (error) {
    note(false, 'profile 无法解析 ' + packageName + '：' + error.message + '（先执行 dsh plugin --profile ' + profile + ' add ' + packageDir + '）');
  }
  if (manifestPath !== undefined) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    note(typeof manifest.dsh?.client?.platform === 'string', 'dsh.client.platform 是字符串：' + manifest.dsh?.client?.platform);
    const clientExport = manifest.exports?.['./client'];
    note(typeof clientExport === 'string', 'exports["./client"] 是字符串：' + clientExport);
    const bundlePath = join(dirname(manifestPath), typeof clientExport === 'string' ? clientExport : '');
    note(existsSync(bundlePath), '客户端 bundle 文件存在：' + bundlePath);
    note(Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.every(item => typeof item === 'string'), 'dsh.client.inject 是字符串数组：' + JSON.stringify(manifest.dsh?.client?.inject));
    const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    note((profileManifest.dsh?.profile?.bundles ?? []).includes(packageName), 'profile 的 dsh.profile.bundles 已包含本包');
  }
}

// ---- host 半：注册契约、参数/输出校验、渲染面 ----
const registered = [];
const routes = [];
const services = {
  tools: { register: definition => { registered.push(definition); return () => {}; } },
  subprocess: { spawn() { throw new Error('预检不执行子进程'); } },
  webServer: { register: route => { routes.push(route); return () => {}; } },
};
const ctx = {
  get: name => services[name],
  // cordis 的可选依赖入口：服务已挂载时立即回调，与真实运行时一致。
  inject: (deps, callback) => { if (deps.every(name => services[name] !== undefined)) callback(ctx); },
};
apply(ctx);
note(registered.length === 2, 'apply 注册了两个工具：' + registered.map(item => item.name).join(', '));
// 这一条正是上一版漏掉的：路由必须在 webServer 已挂载时真的注册上。
note(routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/mechanics', 'apply 挂上了只读路由：' + routes.map(route => route.kind + ' ' + route.path).join(', '));
note(routes.length === 1 && typeof routes[0].handler === 'function', '只读路由带请求处理器');

const samples = {
  mechanics_search: { query: '闪避' },
  mechanics_graph: { conceptIds: ['turn', 'draw'] },
};
const badSamples = {
  // search 的互斥（query 或 from+to）由 execute 把关：根级 oneOf 不被模型 API 接受。
  mechanics_search: { from: 'turn' },
  mechanics_graph: { conceptIds: 'turn' },
};
for (const definition of registered) {
  const name = definition.name;
  note(name !== 'run_code', name + '：不是保留名 run_code');
  note(definition.output !== undefined && typeof definition.output.render === 'function', name + '：声明了 output.render');
  note(typeof definition.output.presentationMeta === 'function', name + '：声明了 output.presentationMeta（图卡载荷）');
  // 模型提供方按 OpenAI 风格校验 function schema：根必须是 object，根级 oneOf 会被拒成 type:null。
  // DSH 自己的校验器接受更宽的形态，所以这一条只能在这里把关。
  note(definition.parameters.type === 'object', name + '：parameters 根是 type: "object"（模型 API 契约）');
  note(definition.parameters.oneOf === undefined && definition.parameters.anyOf === undefined, name + '：parameters 根不使用 oneOf/anyOf');
  for (const [label, schema] of [['parameters', definition.parameters], ['output.schema', definition.output.schema]]) {
    try {
      assertSupportedJsonSchema(schema);
      note(true, name + '：' + label + ' 属于 DSH 支持的 JSON Schema 子集');
    } catch (error) {
      note(false, name + '：' + label + ' 不受支持：' + error.message);
    }
  }
  const sample = samples[name];
  const valid = validateJsonSchemaValue(definition.parameters, sample, '').length === 0;
  note(valid, name + '：样例参数通过派发校验 ' + JSON.stringify(sample));
  const schemaRejected = validateJsonSchemaValue(definition.parameters, badSamples[name], '').length > 0;
  let executeRejected = false;
  if (!schemaRejected) {
    try {
      await definition.execute(badSamples[name], { agent: { session: { header: { cwd: process.cwd() } } } });
    } catch (error) {
      executeRejected = typeof error?.code === 'string';
    }
  }
  note(schemaRejected || executeRejected, name + '：非法参数被显式拒绝（' + (schemaRejected ? 'schema' : 'execute→' + 'TOOL_INVALID') + '）' + JSON.stringify(badSamples[name]));
  const value = { revision: 'rev', conceptIds: ['turn'], nodes: [], edges: [], concept: { id: 'evade', label: '闪避' }, matchedBy: 'label' };
  note(validateJsonSchemaValue(definition.output.schema, value, '').length === 0, name + '：结果值通过 output.schema');
  const blocks = definition.output.render(sample, value);
  note(Array.isArray(blocks) && blocks.length > 0 && blocks.every(block => block?.type === 'text' && typeof block.text === 'string'), name + '：render 返回文本内容块');
  const meta = definition.output.presentationMeta(sample, value);
  note(meta === value, name + '：presentationMeta 即工具结果本身（投影形状只有 workspace-tool.mjs 一个所有者）');
  note(definition.timeoutMs === 20000, name + '：声明了协作式超时预算 ' + definition.timeoutMs + 'ms');
  note(typeof definition.isConcurrencySafe === 'function' && definition.isConcurrencySafe(sample) === true, name + '：显式声明可并发');
}

// ---- 可选：在真实 DSH 工具注册表（cordis Context + ToolRuntime）里注册一次 ----
const cordisUrl = resolveModule('@deepseek-ai/cordis', option('cordis', undefined));
if (cordisUrl === undefined) {
  console.log('SKIP 真实注册表冒烟：本机解析不到 @deepseek-ai/cordis（用 --cordis <路径> 指定）');
} else {
  try {
    const { Context } = await import(cordisUrl);
    const { default: ToolRuntime } = await import(toolsUrl);
    const ctx = new Context();
    ctx.provide('systemPrompt', { tools() {}, section() {} });
    // 子进程 seam 的最小实现：冒烟要真的把项目内受管工具跑起来，才叫端到端。
    ctx.provide('subprocess', {
      spawn(spec) {
        const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const buckets = { stdout: { text: '', dropped: false }, stderr: { text: '', dropped: false } };
        for (const stream of ['stdout', 'stderr']) {
          child[stream].on('data', chunk => { buckets[stream].text += String(chunk); });
        }
        const reader = stream => ({ readFrom: () => ({ text: buckets[stream].text, nextOffset: buckets[stream].text.length, lossy: buckets[stream].dropped }) });
        return {
          done: new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (exitCode, signal) => resolve({ exitCode, signal })); }),
          collected: { stdout: reader('stdout'), stderr: reader('stderr') },
          terminate: () => child.kill(),
        };
      },
    });
    new ToolRuntime(ctx, {});
    apply(ctx);
    // 真实项目夹具：示例工作区 + 仓库里的受管工具副本。
    const fixture = await mkdtemp(join(tmpdir(), 'mechanics-preflight-'));
    await cp(new URL('../../../examples/card-game/', import.meta.url), fixture, { recursive: true });
    const toolTarget = join(fixture, '.mechanics', 'tools', 'workspace-tool.mjs');
    await mkdir(dirname(toolTarget), { recursive: true });
    await cp(new URL('../../../workspace-tools/workspace-tool.mjs', import.meta.url), toolTarget);
    const agent = { id: 'preflight', session: { header: { cwd: fixture } } };
    for (const [name, args, expected] of [
      ['mechanics_search', { query: '闪避' }, 'evade'],
      // 模型文本给的是可读关系（melee +> damage），规则 ID 只在卡片 meta 里。
      ['mechanics_graph', { conceptIds: ['melee', 'damage'] }, 'melee +> damage'],
    ]) {
      // signal 是调用方自己拥有的取消事实：注册表会读它，缺了就是调用方契约破损。
      const outcome = await ctx.tools.execute({ callId: 'preflight-' + name, name, arguments: args, agent, signal: new AbortController().signal });
      note(outcome?.isError === false, '真实注册表：' + name + ' 经注册表派发且 isError=false');
      const text = (outcome?.content ?? []).map(block => block?.text ?? '').join('\n');
      note(text.includes(expected), '真实注册表：' + name + ' 的模型可见文本命中预期（' + expected + '）');
      note(!text.includes('"nodes"'), '真实注册表：' + name + ' 的模型可见文本不含原始 JSON');
      // 卡片载荷：客户端半读的就是这份 meta，注册表把它随结果一起物化。
      const meta = outcome?.meta;
      note(meta !== undefined && typeof meta === 'object', '真实注册表：' + name + ' 随结果物化了卡片 meta（' + JSON.stringify(meta ?? {}).length + ' 字节）');
      if (name === 'mechanics_graph') {
        note(Array.isArray(meta?.edges) && meta.edges.some(edge => edge.id === 'melee-2-damage'), '真实注册表：卡片 meta 携带集合内声明关系（图上要画的边）');
      } else {
        note(meta?.resolution?.status === 'fuzzy', '真实注册表：卡片 meta 携带模糊候选 resolution');
      }
      console.log('     ' + name + ' 模型文本：' + text.split('\n')[0].slice(0, 90));
    }
    await rm(fixture, { recursive: true, force: true });
    const schemas = ctx.tools.schemas();
    const names = schemas.map(schema => schema.name).sort();
    note(names.includes('mechanics_graph') && names.includes('mechanics_search'), '真实注册表：两个工具都已注册，注册表可见 ' + names.length + ' 个工具');
    for (const name of ['mechanics_search', 'mechanics_graph']) {
      const schema = schemas.find(item => item.name === name);
      if (schema === undefined) { note(false, '真实注册表：模型可见 schema 缺少 ' + name); continue; }
      const keys = Object.keys(schema).sort();
      note(JSON.stringify(keys) === JSON.stringify(['description', 'name', 'parameters']), '真实注册表：' + name + ' 的模型可见字段只有 name/description/parameters');
      note(typeof schema.description === 'string' && schema.description.length > 40, '真实注册表：' + name + ' 带面向模型的描述（' + schema.description.length + ' 字）');
      console.log('     模型可见参数 schema：' + JSON.stringify(schema.parameters));
    }
  } catch (error) {
    note(false, '真实注册表冒烟抛错：' + error.message);
  }
}

console.log('\n==== ' + (failures.length === 0 ? '预检通过：可以重启宿主' : failures.length + ' 项预检失败') + ' ====');
for (const item of failures) console.log(' - ' + item);
process.exitCode = failures.length === 0 ? 0 : 1;
