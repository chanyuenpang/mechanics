import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/web/app.mjs', import.meta.url), 'utf8');
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
  assert.match(app, /game-graph:inspector-collapsed/);
  assert.match(app, /game-graph:hover-tooltips-enabled/);
  assert.match(app, /inspector-toggle-path/);
  assert.match(page, /class="panel-toggle-icon"/);
  assert.match(page, /class="panel-close-icon"/);
  assert.match(css, /#close-inspector:hover\{background:#fff1ee/);
  assert.match(css, /#inspector\.is-collapsed\{display:grid;width:38px;height:38px/);
});

test('悬浮提示宽度增加到 660px，采用半透明黑底，关系图例仍固定在底部', () => {
  assert.match(css, /#canvas-tooltip\{[^}]*max-width:min\(660px/);
  assert.match(css, /#canvas-tooltip\{[^}]*background:#000c/);
  assert.match(css, /#legend\{top:auto;right:190px;bottom:25px;left:150px/);
});
