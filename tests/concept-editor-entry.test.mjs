import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const glossary = await readFile(new URL('../src/web/glossary.mjs', import.meta.url), 'utf8');

test('Inspector 修改概念入口实例化共享 ConceptEditor 并以完整表单更新', () => {
  const section = app.slice(app.indexOf('async function editConcept'), app.indexOf('async function removeSelection'));
  assert.match(section, /new ConceptEditor\(fields, \{ mode: 'edit'/);
  assert.match(section, /prepareConceptUpdate\(workspace\.definitions, id, editor\.form\)/);
});

test('definitionMode 新增概念入口实例化共享 ConceptEditor 并提交完整 payload', () => {
  const section = app.slice(app.indexOf('async function addTerm'), app.indexOf('async function createRule'));
  assert.match(section, /new ConceptEditor\(host, \{ mode: 'create'/);
  assert.match(section, /conceptPayloadFromForm\(editor\.form\)/);
  assert.match(section, /data\.nodes\.push\(node\)/);
  assert.doesNotMatch(section, /onReuse/);
});

test('标签修改实时刷新同名提示并重置确认', () => {
  const field = glossary.slice(glossary.indexOf('  field('), glossary.indexOf('  render() {', glossary.indexOf('export class ConceptEditor')));
  assert.match(field, /if \(key === 'label'\) \{ this\.allowDuplicate = false; this\.drawDuplicates\(\); \}/);
  assert.equal([...field.matchAll(/this\.drawDuplicates\(\)/g)].length, 1);
});


test('共享编辑器用可搜索选择器指定 is-a 父概念，候选由调用方注入且含清除动作', () => {
  const field = glossary.slice(glossary.indexOf('  parentField() {'), glossary.indexOf('  tagPicker() {'));
  assert.match(glossary, /element\('fieldset', undefined, 'concept-editor-taxonomy'\)/);
  // 概念多时下拉框找不到目标，改成带搜索的组合框；当前父概念显示为已选中，清除是独立按钮。
  assert.match(field, /new ConceptReferencePicker\(\{/);
  assert.match(field, /nodes: \(\) => this\.parentOptions, currentId: this\.form\.id, kind: 'isa', value: this\.form\.parentId \?\? ''/);
  assert.match(field, /placeholder: '输入名称、ID、别名或含义搜索父概念'/);
  assert.match(field, /picker\.input\.dataset\.editorField = 'parentId'/);
  assert.match(field, /onSelect: id => \{ this\.form\.parentId = id \?\? ''; \}/);
  assert.match(field, /clearOption: '清除 is-a 父概念'/);
  assert.doesNotMatch(field, /action\('清除'/);
  assert.doesNotMatch(field, /el\(|element\('select'\)/);
  // 没有候选来源时不渲染该字段，避免出现无法落盘的死控件。
  assert.match(glossary, /\.\.\.\(this\.parentOptions \? \[this\.parentField\(\)\] : \[\]\)/);
  assert.match(glossary, /this\.form\.parentId = parentId \?\? '';/);
});
test('固定引用计算是纯函数：清理被删规则，显式投影补上新 is-a', () => {
  const helper = glossary.slice(glossary.indexOf('export function nextPinnedRuleIds'), glossary.indexOf('export function conceptReferencePickerCandidates'));
  assert.match(helper, /const kept = \(pinned \?\? \[\]\)\.filter\(id => !removed\.has\(id\)\);/);
  assert.match(helper, /const next = pinAdded \? \[\.\.\.kept, \.\.\.added\.filter\(id => id && !kept\.includes\(id\)\)\] : kept;/);
  assert.match(helper, /changed: next\.length !== \(pinned \?\? \[\]\)\.length/);
});
test('is-a 选择器打开时保留当前值的文字，清除是候选列表的第一项且不需要二次确认', () => {
  const picker = glossary.slice(glossary.indexOf('export class ConceptReferencePicker'), glossary.indexOf('export function validateConcept'));
  // 打开时不再清空输入框：展示文字（名称（ID））就是当前值的唯一确认，列表另用空过滤词展开。
  assert.match(picker, /this\.query = ''; this\.input\.select\?\.\(\);/);
  assert.match(picker, /this\.input\.oninput = \(\) => \{ this\.query = this\.input\.value;/);
  assert.match(picker, /candidates\(\) \{ return conceptReferencePickerCandidates\(this\.nodes\(\), \{ query: this\.query,/);
  // 有当前值时第一项就是清除；点它即清除，没有确认条，也没有失焦/回车触发。
  assert.match(picker, /const clear = this\.clearOption && this\.value \? \[\{ clear: true, label: this\.clearOption \}\] : \[\];/);
  assert.match(picker, /return \[\.\.\.clear, \.\.\.this\.candidates\(\)\.map\(node => \(\{ node \}\)\)\];/);
  assert.match(picker, /clear\(\) \{ this\.value = ''; this\.query = ''; this\.close\(\); this\.onSelect\(null\); \}/);
  assert.match(picker, /option\.onmousedown = event => \{ event\.preventDefault\(\); entry\.clear \? this\.clear\(\) : this\.select\(entry\.node\); \};/);
  assert.match(picker, /if \(entry\.clear\) this\.clear\(\); else this\.select\(entry\.node\);/);
  assert.doesNotMatch(picker, /requestClear|concept-reference-confirm|this\.input\.onblur/);
  // 概念上千时不能把全部匹配塞进 DOM：只渲染前 CONCEPT_REFERENCE_LIMIT 项并提示继续输入。
  assert.match(glossary, /export const CONCEPT_REFERENCE_LIMIT = 40;/);
  assert.match(picker, /visibleEntries\(\) \{\n    const entries = this\.entries\(\);\n    return \{ entries: entries\.slice\(0, CONCEPT_REFERENCE_LIMIT\), total: entries\.length \};/);
  assert.match(picker, /还有 \$\{total - entries\.length\} 个候选，继续输入以缩小范围/);
  assert.match(glossary, /const matches = matchingConcepts\(this\.allNodes\(\), this\.session\.query\), shown = matches\.slice\(0, CONCEPT_REFERENCE_LIMIT\)/);
  assert.match(glossary, /还有 \$\{matches\.length - shown\.length\} 个匹配概念，继续输入以缩小范围/);
  // 列表项只显示名称与稳定 ID，不把描述当预览混进结果。
  assert.match(picker, /option\.append\(element\('strong', entry\.node\.label\), element\('small', entry\.node\.id\)\)/);
});
test('引用窗口把同名复用回调交给共享编辑器，且不创建候选', () => {
  const constructor = glossary.slice(glossary.indexOf('export class ConceptEditor'), glossary.indexOf('  field(', glossary.indexOf('export class ConceptEditor')));
  const picker = glossary.indexOf('export class ConceptPicker');
  const begin = glossary.slice(glossary.indexOf('  begin() {', picker), glossary.indexOf('  cancelForm() {', picker));
  assert.match(constructor, /\{ mode, node, nodes, tagDefinitions = \[\], parentOptions = null, parentId = null, onSave, onCancel, onReuse \}/);
  assert.match(constructor, /Object\.assign\(this, \{ host, mode, nodes, tagDefinitions, parentOptions, onSave, onCancel, onReuse,/);
  assert.match(begin, /onReuse: id => \{ this\.session\.selected\.add\(id\); this\.cancelForm\(\); \}/);
  assert.doesNotMatch(begin, /session\.candidates\.push/);
});

test('概念表复用共享编辑对话框，并限制一次性渲染的行数', () => {
  const table = glossary.slice(glossary.indexOf('export class GlossaryTable'));
  assert.match(glossary, /export const CONCEPT_TABLE_LIMIT = 200;/);
  // 编辑入口只触发 app 层的共享对话框，不再把表单内联插进大表。
  assert.match(table, /configure\.onclick = \(\) => this\.edit\(node\.id\);/);
  assert.doesNotMatch(glossary, /new ConceptEditor\(cell/);
  assert.doesNotMatch(table, /openQualifierSettings|editorRow|editingId/);
  assert.match(app, /edit: id => \{ void editConcept\(id\)\.catch\(showError\); \},/);
  assert.doesNotMatch(app, /replace: \(id, nextNode\) => edit\(/);
  // 一千多个概念不能一次性铺满表格：超出的用提示引导继续输入，被定位的概念始终渲染。
  assert.match(table, /const shown = matches\.slice\(0, CONCEPT_TABLE_LIMIT\);/);
  assert.match(table, /if \(this\.focusId\) \{/);
  assert.match(table, /还有 \$\{matches\.length - shown\.length\} 个匹配概念，继续输入以缩小范围/);
  assert.match(table, /this\.search\.value = ''; this\.focusId = id; this\.draw\(\); this\.focusId = null;/);
});
test('概念表以概念内容为主，并支持单行和表头批量 Agent 锁', () => {
  assert.match(glossary, /<col class="term-name"><col class="term-description"><col class="term-id"><col class="term-lock"><col class="term-actions">/);
  assert.doesNotMatch(glossary, /<col class="term-structure">/);
  assert.match(glossary, /id="glossary-lock-all" type="checkbox"/);
  assert.match(glossary, /this\.lockAll\.onchange = \(\) => this\.setLocks\(this\.matches\.map\(node => node\.id\), this\.lockAll\.checked\)/);
  assert.match(glossary, /toggle\.onchange = \(\) => this\.setLocks\(\[node\.id\], toggle\.checked\)/);
  assert.match(glossary, /remove\.className = 'term-delete'/);
  assert.match(glossary, /remove\.append\(icon\('trash'\)\)/);
  assert.match(app, /setLocks: \(ids, agentLocked\) => edit\(data => \{ const selected = new Set\(ids\);/);
});

test('标签页集中维护显示名与颜色，概念编辑器以彩色多选关联既有标签', () => {
  assert.match(glossary, /id="glossary-tags"/);
  assert.match(glossary, /picker\.type = 'color'/);
  // 概念编辑器由调用方注入标签定义（引用窗口），标签页本身维护显示名与颜色。
  assert.match(glossary, /tagDefinitions: this\.definitions\.tagDefinitions \?\? \[\]/);
  assert.match(glossary, /button\.style\.setProperty\('--tag-color', tag\.color\)/);
  assert.match(glossary, /ids\.has\(tag\.id\) \? ids\.delete\(tag\.id\) : ids\.add\(tag\.id\)/);
});

test('引用窗口的新建候选同样可以指定 is-a，父概念随定义一次提交', () => {
  const picker = glossary.slice(glossary.indexOf('export class ConceptPicker'), glossary.indexOf('// 名词表只是统一定义草稿的编辑视图'));
  assert.match(picker, /\{ status, recover = \(\) => \{\}, abandon = \(\) => \{\}, allowCreate = true, parentOptions = null \}/);
  assert.match(picker, /parentOptions: this\.parentOptions \? this\.parentOptions\(\) : null/);
  assert.match(picker, /this\.session\.candidateParents\.set\(candidate\.id, form\.parentId\)/);
  assert.match(picker, /this\.session\.candidateParents instanceof Map\) this\.session\.candidateParents\.delete\(id\)/);
  const reference = app.slice(app.indexOf('async function addNode'), app.indexOf('function mechanismFolderPath'));
  assert.match(reference, /parentOptions: \(\) => \[\.\.\.parentCandidates\(null\), \.\.\.session\.candidates\]/);
  assert.match(reference, /nextRules = setSpecializesParent\(nextRules \?\? workspace\.rules\.rules, childId, parentId\)/);
  assert.match(reference, /is-a 父概念不存在或未被本次引用/);
  assert.match(reference, /api\('\/api\/concept-taxonomy', \{ revision, definitions: document, rules: session\.commit\.plan\.rules \}\)/);
});
