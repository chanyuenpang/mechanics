import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
const icons = await readFile(new URL('../src/web/icons.mjs', import.meta.url), 'utf8');
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
});

test('资源标签双击关闭，当前草稿仍通过既有确认流程处理', () => {
  assert.match(app, /if \(clickTimer\) \{ clearTimeout\(clickTimer\); clickTimer = null; closeEditorTab\(tab\)\.catch\(showError\); return; \}/);
  assert.match(app, /async function closeEditorTab\(tab\)/);
  assert.match(app, /if \(active && !await guard\(\)\) return/);
  assert.match(app, /editorTabs\.splice\(index, 1\)/);
  assert.match(app, /if \(next\) await openEditorTab\(next\)/);
});
