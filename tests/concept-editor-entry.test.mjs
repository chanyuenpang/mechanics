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

test('引用窗口把同名复用回调交给共享编辑器，且不创建候选', () => {
  const constructor = glossary.slice(glossary.indexOf('export class ConceptEditor'), glossary.indexOf('  field(', glossary.indexOf('export class ConceptEditor')));
  const picker = glossary.indexOf('export class ConceptPicker');
  const begin = glossary.slice(glossary.indexOf('  begin() {', picker), glossary.indexOf('  cancelForm() {', picker));
  assert.match(constructor, /\{ mode, node, nodes, tagDefinitions = \[\], onSave, onCancel, onReuse \}/);
  assert.match(constructor, /Object\.assign\(this, \{ host, mode, nodes, tagDefinitions, onSave, onCancel, onReuse,/);
  assert.match(begin, /onReuse: id => \{ this\.session\.selected\.add\(id\); this\.cancelForm\(\); \}/);
  assert.doesNotMatch(begin, /session\.candidates\.push/);
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
  assert.match(glossary, /tagDefinitions: this\.tagDefinitions/);
  assert.match(glossary, /button\.style\.setProperty\('--tag-color', tag\.color\)/);
  assert.match(glossary, /ids\.has\(tag\.id\) \? ids\.delete\(tag\.id\) : ids\.add\(tag\.id\)/);
});
