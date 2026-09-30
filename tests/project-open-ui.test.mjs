import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
const icons = await readFile(new URL('../src/web/icons.mjs', import.meta.url), 'utf8');
const style = await readFile(new URL('../src/web/style.css', import.meta.url), 'utf8');
const canvasSource = await readFile(new URL('../src/web/canvas.mjs', import.meta.url), 'utf8');
const openProject = app.slice(app.indexOf('async function openProject()'), app.indexOf('async function configureProject()'));
const manageReferences = app.slice(app.indexOf('async function manageReferences()'), app.indexOf("$('new-graph').onclick"));

test('打开项目默认先展示最近项目，不隐式唤起原生目录选择器', () => {
  const initial = openProject.slice(0, openProject.indexOf('const draw = async () =>'));
  assert.match(initial, /let preflight = null/);
  assert.doesNotMatch(initial, /\/api\/directories\/pick/);
  assert.match(openProject, /mode = 'recent'/);
  assert.match(openProject, /if \(mode === 'recent'\)[\s\S]*?const history = await api\('\/api\/projects'\)/);
  assert.match(openProject, /else root\.append\(folderPicker\(\{ initialPath: workspace\?\.projectRoot \?\? ''/);
});


test('概念详情的 is-a 开关是复选框，与颜色分区分离且只改各自文件的展开集合', () => {
  assert.match(app, /if \(isARule && \(draft \|\| viewMode\(\)\)\) \{/);
  // 复选框而不是按钮，并带上位概念提示。
  assert.match(app, /input\.type = 'checkbox'; input\.checked = expanded\.includes\(node\.id\);/);
  // 面板提供可搜索的 is-a 父概念选择器；清除不再有独立按钮，改由清空输入后就地确认。
  assert.match(app, /section\.append\(el\('strong', 'is-a 父概念'\)\)/);
  assert.match(app, /nodes: \(\) => isaParentCandidates\(workspace\.definitions\.nodes, workspace\.rules\.rules, node\.id\)/);
  assert.match(app, /kind: 'isa', value: isARule\?\.target \?\? ''/);
  assert.match(app, /onSelect: id => \{ void setConceptParent\(node\.id, id \?\? null\)/);
  // 清除是候选列表第一项，不是独立按钮，也没有二次确认。
  assert.match(app, /clearOption: '清除 is-a 父概念'/);
  assert.doesNotMatch(app, /button\('清除/);
  assert.doesNotMatch(app, /requestClear|concept-reference-confirm/);
  // 更多具体的后代沿 specializes 入边算；曾顺出边遍历，把当前父概念当成后代过滤掉才会显示为空。
  assert.doesNotMatch(app, /descendantConceptIds/);
  // 选择器已经显示父概念，开关下方不再重复「当前 is-a 父概念」文字。
  assert.doesNotMatch(app, /当前 is-a 父概念：/);
  assert.match(app, /choice\.append\(input, el\('span', '显示连线'\)\)/);
  assert.match(app, /viewMode\(\) \? editView\(toggle, \{ keepSelection: true \}\) : edit\(toggle, \{ topology: false \}\)/);
  assert.doesNotMatch(app, /panel\.append\(button\(expanded\.includes\(node\.id\)/);
  // 与「节点风格／节点颜色」一样是 detail 分区：块间自带分隔线，不贴着颜色网格。
  assert.match(app, /el\('div', undefined, 'detail node-taxonomy'\)/);
  // 概念编辑对话框按内容加宽：身份与 is-a 整行、名称/ID 并排、含义整行，权限不再和别的分组挤。
  assert.match(style, /\.concept-dialog\{width:min\(1040px,calc\(100vw - 64px\)\);max-height:92dvh\}/);
  assert.match(style, /\.concept-editor>\.concept-editor-taxonomy,\.concept-editor>\.concept-editor-permission\{grid-column:1\/-1\}/);
  assert.match(style, /\.concept-editor-identity>legend,\.concept-editor-identity>\.concept-editor-duplicates,\.concept-editor-identity>\.field:has\(\[data-editor-field="description"\]\)\{grid-column:1\/-1\}/);
  // 选择器列表在侧栏里改为文档流内展开，避免被 #inspector 的滚动容器裁掉。
  assert.match(style, /\.detail\.node-taxonomy \.concept-reference-list\{position:static;max-height:190px;margin-top:4px\}/);
  // 列表项按名称 + 稳定 ID 两行排版，而不是把描述当预览混进结果。
  assert.match(style, /\.concept-reference-option small\{color:#9aa895;font-size:10px/);
  assert.match(style, /\.detail\.node-taxonomy \.choice\{margin-top:9px;padding:0;border-bottom:0;align-items:flex-start\}/);
  assert.match(style, /\.detail\.node-taxonomy \.choice>span\{flex:1;min-width:0;line-height:1\.65;color:#526051\}/);
  // 忙碌或自动保存暂停时，面板内的复选框与侧栏保持一致地禁用。
  assert.match(app, /\[\$\('resource-panel'\), \$\('inspector'\)\]\.flatMap\(root => \[\.\.\.root\.querySelectorAll\('input\[type=checkbox\]'\)\]\)/);
  assert.match(app, /const currentTaxonomyPresentation = \(\) => \(viewMode\(\) \? viewTaxonomyPresentation : draft\?\.taxonomyPresentation\)/);
  assert.match(app, /taxonomyPresentation: clone\(viewTaxonomyPresentation\)/);
  assert.match(app, /if \(!selectionInDisplay\(displayGraph, selection\)\) selection = null;/);
  // 展开后画布画的是同一条 is-a 边的虚线，而不是另画一遍分类线。
  assert.match(canvasSource, /edge\.relation === 'specializes' \? \{ 'stroke-dasharray': '6 4' \} : \{\}/);
  assert.match(canvasSource, /const projection = this\.graph;/);
  // 新建/修改概念对话框都注入父概念候选，并通过同一条原子提交路径写入。
  assert.match(app, /const parentCandidates = conceptId => isaParentCandidates\(workspace\.definitions\.nodes, workspace\.rules\.rules, conceptId\)/);
  assert.match(app, /parentOptions: parentCandidates\(id\), parentId: workspace\.rules\.rules\.find/);
  assert.match(app, /parentOptions: parentCandidates\(null\),/);
  // 写入后必须重画：write() 只刷新侧栏，is-a 改动不重画就要用户自己刷新页面。
  const setParent = app.slice(app.indexOf('async function setConceptParent'), app.indexOf('async function setEdgeQualifiers'));
  assert.match(setParent, /await write\(revision => api\('\/api\/concept-taxonomy'/);
  assert.match(setParent, /if \(!syncLocalPinsAfterTaxonomy\(classifyTaxonomyChange\(beforeRules\), \[\[conceptId, parentId\]\]\)\) render\(\);/);
  assert.match(app, /api\('\/api\/concept-taxonomy', \{ revision, definitions, rules \}\)/);
  assert.match(app, /api\('\/api\/concept-taxonomy', \{ revision, \.\.\.\(definitionsChanged/);
  // 三个 is-a 写入口（详情栏、修改概念、引用窗口新建）都必须同步当前文件的固定引用：
  // 服务端删掉的要清理，显式投影还要把新规则固定进去，否则画布上没有分类边与节点标签。
  assert.equal([...app.matchAll(/syncLocalPinsAfterTaxonomy\(classifyTaxonomyChange\(beforeRules\)/g)].length, 3);
  assert.match(app, /nextPinnedRuleIds\(draft\.pinnedRuleIds, \{ removed, added: wanted, pinAdded: draft\.ruleSelection === 'explicit' \}\)/);
});
test('项目打开请求有超时，空项目错误可重新打开选择器', () => {
  const api = app.slice(app.indexOf('const API_REQUEST_TIMEOUT_MS'), app.indexOf('// 所有页面写入串行执行'));
  assert.ok(api.includes('const API_REQUEST_TIMEOUT_MS = 15_000;'));
  assert.ok(api.includes('const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), requestTimeout);'));
  assert.ok(api.includes('signal: controller.signal,'));
  assert.ok(api.includes('finally { clearTimeout(timeout); }'));
  assert.ok(api.includes('CONNECTION_TIMEOUT'));
  assert.ok(app.includes("recovery.textContent = workspace ? '重新读取' : '重新打开项目';"));
  assert.ok(app.includes("$('reload-error').onclick = () => (workspace ? refreshProjectFromDisk() : openProject()).catch(showError);"));
});

test('原生窗口等待超过 15 秒仍能交付结果，普通读取仍会超时且失败后可重试', async () => {
  const source = app.slice(app.indexOf('async function api('), app.indexOf('// 所有页面写入串行执行'));
  const constants = app.match(/^const (?:API_REQUEST_TIMEOUT_MS|DIRECTORY_PICKER_REQUEST_TIMEOUT_MS) = [\d_]+;$/gm).join('\n');
  let elapsed = 16000;
  const timers = new Map();
  const api = runInNewContext(constants + '\n' + source + '\napi', {
    AbortController, workspace: null, json: JSON.stringify, observeAssetSync() {},
    setTimeout: (callback, delay) => { const id = Symbol(); timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (_path, { signal }) => {
      for (const { callback, delay } of timers.values()) if (delay <= elapsed) callback();
      signal.throwIfAborted();
      return { ok: true, json: async () => ({ cancelled: false, path: '/中文 项目' }) };
    },
  });
  assert.equal((await api('/api/directories/pick', {})).path, '/中文 项目');
  await assert.rejects(api('/api/project'), { code: 'CONNECTION_TIMEOUT' });
  elapsed = 611000;
  await assert.rejects(api('/api/directories/pick', {}), /项目未切换，请重新选择/);
  elapsed = 16000;
  assert.equal((await api('/api/directories/pick', {})).path, '/中文 项目');
  assert.equal(timers.size, 0);
});

test('无参数启动无论项目状态或首个读取失败均会退出打开遮罩', () => {
  const startup = app.slice(app.indexOf('// 首次加载也属于打开文件'), app.length);
  assert.match(startup, /if \(project\.status === 'active'\)[\s\S]*?else \{ opening = false; updateStatus\(\); await openProject\(\); \}/);
  assert.match(startup, /catch \(error\) \{ showError\(error\); \}\s*finally \{ opening = false; updateStatus\(\); \}/);
  assert.match(app, /\$\('opening-overlay'\)\.hidden = !opening/);
});

test('重新读取按左侧浏览项目的会话强制刷新磁盘目录，关联项目不替换当前画布', () => {
  assert.match(app, /async function refreshProjectFromDisk\(\)[\s\S]*?const browsing = browserWorkspace \?\? workspace/);
  assert.match(app, /const sameProject = browsing\.projectSessionToken === workspace\?\.projectSessionToken/);
  assert.match(app, /const latest = await apiForProject\(browsing, '\/api\/workspace'\);[\s\S]*?renderSidebar\(\); renderProjectTabs\(\)/);
  assert.match(app, /\$\('reload'\)\.onclick = \(\) => refreshProjectFromDisk\(\)/);
});

test('关联项目可从最近打开项目中选择，且排除当前与已关联项目', () => {
  assert.match(manageReferences, /project-references\?projectSessionToken=\$\{encodeURIComponent\(source\.projectSessionToken\)\}/);
  assert.match(manageReferences, /最近打开项目/);
  assert.match(manageReferences, /item\.projectRoot\.toLowerCase\(\) !== source\.projectRoot\.toLowerCase\(\)/);
  assert.match(manageReferences, /!linkedRoots\.has\(item\.projectRoot\.toLowerCase\(\)\)/);
  assert.match(manageReferences, /selectedPath = item\.projectRoot; path\.value = item\.projectRoot/);
  assert.doesNotMatch(manageReferences, /稳定 ID|显示名称/);
  assert.match(manageReferences, /apiAsSource\('\/api\/project-references\/declare', \{ projectRoot: selectedPath \}\)/);
});

test('侧栏关联项目区直接列出项目，并提供折叠和添加操作', () => {
  assert.match(html, /<section class="reference-projects" aria-label="关联项目">/);
  assert.match(html, /id="toggle-references"/);
  assert.match(html, /id="references"/);
  assert.match(html, /id="project-tabs" class="project-tabs" aria-label="关联项目列表"/);
  assert.doesNotMatch(html, /id="current-context"/);
  assert.match(app, /const entries = \[sourceProject && \{ projectRoot: sourceProject\.projectRoot/);
  assert.match(app, /await enterReference\(reference\.id\)/);
  assert.match(app, /let sourceProject = null/);
  assert.match(app, /function apiAsSource\(path, body = \{\}\)/);
  assert.match(app, /referencesCollapsed = !referencesCollapsed/);
});

test('关联项目悬浮后显示删除图标，并经二次确认只从源项目移除', () => {
  const renderReferences = app.slice(app.indexOf('function renderProjectTabs()'), app.indexOf('function apiForProject'));
  const removeReference = app.slice(app.indexOf('async function removeProjectReference'), app.indexOf("$('new-graph').onclick"));
  assert.match(renderReferences, /iconAction\('trash', \(\) => removeProjectReference\(reference\), 'reference-remove'\)/);
  assert.match(renderReferences, /if \(entry\.primary\) \{ root\.append\(item\); continue; \}/);
  assert.match(removeReference, /这只会移除当前项目的关联入口，不会删除对方项目/);
  assert.match(removeReference, /apiAsSource\('\/api\/project-references\/remove', \{ referenceId: reference\.id, referencesRevision: referenceProjectsRevision \}\)/);
  assert.match(removeReference, /await returnToSourceProject\(\)/);
  assert.match(style, /\.project-tab-row:hover \.reference-remove,\.project-tab-row:focus-within \.reference-remove\{opacity:1;pointer-events:auto\}/);
});

test('项目浏览与文件标签导航解耦', () => {
  assert.match(app, /let browserWorkspace = null/);
  assert.match(app, /async function activateReferenceProject\(opened\)[\s\S]*?browserWorkspace = opened[\s\S]*?renderSidebar\(\); renderProjectTabs\(\);/);
  assert.doesNotMatch(app.slice(app.indexOf('async function enterReference'), app.indexOf('async function openProjectRoot')), /await load\(/);
  const editorTabs = app.slice(app.indexOf('async function openEditorTab'), app.indexOf('async function closeEditorTab'));
  assert.doesNotMatch(editorTabs, /await enterReference\(/);
  assert.match(editorTabs, /referenceId: reference\.id, projectSessionToken: sourceProject\.projectSessionToken/);
});

test('操作控件使用统一 SVG 图标，关系记号仍作为领域信息保留', () => {
  assert.match(icons, /export function icon\(name/);
  assert.match(html, /id="reload"[\s\S]*?<svg class="ui-icon"/);
  assert.match(html, /id="toggle-sidebar"[\s\S]*?<svg class="ui-icon"/);
  assert.match(html, /id="zoom-in"[\s\S]*?<svg class="ui-icon"/);
  assert.match(html, /id="dismiss-error"[\s\S]*?<svg class="ui-icon"/);
  assert.match(app, /resourceIcon\.append\(icon\(kind === 'view' \? 'view' : 'mechanic'\)\)/);
  assert.match(app, /projectIcon\.append\(icon\(item\.pinned \? 'pin' : 'project'\)\)/);
  assert.match(html, /id="positive-tool"[^>]*>＋→<\/button>/);
  // is-a 不再有连线工具：工具条只保留三种影响连线，页面里不再有任何 specializes 工具引用。
  assert.match(html, /id="random-tool"[^>]*>？→<\/button><\/div>/);
  assert.doesNotMatch(html, /specializes-tool/);
  assert.doesNotMatch(app, /specializes-tool/);
  assert.match(app, /const relationMode = relation => relation === 'specializes' \? 'select' :/);
});

test('资源标签双击关闭，当前草稿仍通过既有确认流程处理', () => {
  assert.match(app, /if \(clickTimer\) \{ clearTimeout\(clickTimer\); clickTimer = null; closeEditorTab\(tab\)\.catch\(showError\); return; \}/);
  assert.match(app, /async function closeEditorTab\(tab\)/);
  assert.match(app, /if \(active && !await guard\(\)\) return/);
  assert.match(app, /editorTabs\.splice\(index, 1\)/);
  assert.match(app, /if \(next\) await openEditorTab\(next\)/);
});
