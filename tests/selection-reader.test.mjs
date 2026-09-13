import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
const canvas = await readFile(new URL('../src/web/canvas.mjs', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/web/style.css', import.meta.url), 'utf8');

test('工具栏文档按钮改为悬浮说明开关，页面不再渲染选中信息栏', () => {
  assert.match(page, /id="toggle-information-bar"/);
  assert.match(app, /hoverTooltipsEnabled = !hoverTooltipsEnabled/);
  assert.match(app, /canvas\.setTooltipsEnabled\(hoverTooltipsEnabled\)/);
  assert.doesNotMatch(page, /id="selection-reader"/);
  assert.doesNotMatch(app, /renderSelectionReader|informationDock|informationBarVisible/);
});

test('详情栏折叠状态与 hover 开关均通过浏览器偏好保留', () => {
  assert.match(app, /mechanics:inspector-collapsed/);
  assert.match(app, /mechanics:hover-tooltips-enabled/);
  assert.match(app, /inspector-toggle-path/);
  assert.match(page, /class="panel-toggle-icon"/);
  assert.doesNotMatch(page, /close-inspector|panel-close-icon/);
  assert.doesNotMatch(css, /close-inspector|panel-close-icon/);
  assert.match(css, /#inspector\.is-collapsed\{display:grid;width:38px;height:38px/);
});

test('节点颜色与风格只读取当前机制图或视图的呈现记录，并提供八格低饱和色板', () => {
  assert.match(app, /viewMode\(\) \? viewNodeColors : draft\?\.nodeColors \?\? \{\}/);
  assert.match(app, /viewMode\(\) \? viewNodeStyles : draft\?\.nodeStyles \?\? \{\}/);
  assert.match(app, /const NODE_COLOR_OPTIONS = \[/);
  assert.match(app, /const NODE_STYLE_OPTIONS = \[/);
  assert.equal([...app.matchAll(/\{ color: /g)].length >= 8, true);
  assert.match(app, /nodeStylePicker\(panel/);
  assert.match(app, /nodeColorPicker\(panel/);
  assert.match(css, /\.node-color-choices\{display:grid;grid-template-columns:repeat\(4,26px\)/);
  assert.match(css, /\.node\.node-color-d5e8f7 rect\{fill:#d5e8f7\}/);
  assert.match(css, /\.node\.node-style-transparent-dashed rect\{fill:transparent;stroke-dasharray:5 4/);
});

test('节点不再由来源机制推导引用样式或编辑权限，位置只写入当前画布', () => {
  assert.match(app, /画布节点的位置只写入当前机制图或视图/);
  assert.match(app, /canMove: id => !busy\(\) && !autosave\.blocked && !legacy && !definitionMode\(\) && !!graph\?\.nodes\.some/);
  assert.doesNotMatch(canvas, /own = this\.activeId|edge-line[^`]*reference|node \$\{own/);
  assert.match(app, /const direct = edge\.steps\.length === 1/);
  assert.doesNotMatch(app, /视图中的源规则只读/);
});

test('多选节点可批量保存当前机制图或视图的颜色与风格', () => {
  const section = app.slice(app.indexOf("if (selection.type === 'nodes')"), app.indexOf("if (selection.type === 'edge')"));
  assert.match(section, /const ids = selection\.ids\.filter/);
  assert.match(section, /for \(const id of ids\) if \(style === 'solid'\) delete data\.nodeStyles\[id\]/);
  assert.match(section, /for \(const id of ids\) if \(color\) data\.nodeColors\[id\] = color/);
  assert.match(section, /nodeStylePicker\(panel/);
  assert.match(section, /nodeColorPicker\(panel/);
});

test('悬浮提示宽度增加到 660px，采用半透明黑底，关系图例仍固定在底部', () => {
  assert.match(css, /#canvas-tooltip\{[^}]*max-width:min\(660px/);
  assert.match(css, /#canvas-tooltip\{[^}]*background:#000c/);
  assert.match(css, /#legend\{top:auto;right:190px;bottom:25px;left:150px/);
});
