# ADR：概念编辑对话框按内容定宽，动作行只由对话框持有

## 背景

「修改概念」「新建概念」「概念表编辑」共用同一个对话框与共享的 `ConceptEditor`（`src/web/glossary.mjs`），它内部是两列网格（`.concept-editor{grid-template-columns:repeat(2,minmax(0,1fr))}`）。对话框此前宽 `min(620px, calc(100vw - 32px))`，每个半栏字段实际只剩约 225px，名称、稳定 ID、概念含义与 is-a 选择器都被压在半栏里；对话框底部有自己的动作行，编辑器被嵌进去时又渲染一排自己的动作行，同一屏出现两排「保存/取消」。用户反馈编辑框太窄，需要既加宽又重排，同时窄窗口下不能横向溢出。

## 决策

- 对话框宽度由内容需求定界：`min(1040px, calc(100vw - 64px))`，高度上限 `92dvh`；owner 是 `src/web/style.css` 的 `.concept-dialog`。1040px 匹配两列编辑器加内边距的宽度需求，`calc(100vw - 64px)` 是窄视口的兜底，不设固定像素宽度。
- 字段按内容分组整行：身份分组整行（名称与稳定 ID 并排、概念含义整行）、is-a 分组整行、修改权限整行，检索信息与自定义文本并排。owner 是 `.concept-editor`、`.concept-editor-identity`、`.concept-editor-taxonomy` 与 `.concept-editor-permission` 的 `grid-column` 规则。
- 嵌在对话框里的共享 `ConceptEditor` 以 `showActions: false` 构造，编辑器不再渲染自带动作行；保存/取消只由对话框底部持有，`onCancel` 只负责关闭对话框。owner 是 `src/web/glossary.mjs` 的构造参数与 `...(this.showActions ? [actions] : [])`，两处调用点在 `src/web/app.mjs`。
- 对话框内容上的首次 `input` 事件即把编辑标记为未保存（`conceptEditDirty`），使关闭或切换文件前的确认不依赖编辑器自带按钮。

## 取舍

- **保留 620px 小对话框、只调整字段排布**：未采用。两列网格挤在半栏里正是用户反馈的「太窄」，不改宽度无法让含义与 is-a 选择器获得整行空间。
- **固定 1040px 像素宽度**：未采用。窄视口会横向溢出，违反既有「不出现水平滚动」约束。
- **按视口百分比定宽（如 `90vw`）**：未采用。超宽屏会把对话框拉到不必要的大，超过内容需要。
- **共享编辑器保留自带动作行、对话框隐藏自己的动作行**：未采用。会同时反向影响编辑器在概念表内联时的用法，且对话框仍需要一个稳定的提交入口。
- **让编辑器自带动作行成为唯一入口、去掉对话框动作行**：未采用。对话框头部、错误区与底部动作是既有 `dialog()` 外壳约定，其它对话框都遵循它。

## 影响

对话框宽度与动作行归属是机器固定的合同：`tests/project-open-ui.test.mjs` 断言 `.concept-dialog{width:min(1040px,calc(100vw - 64px));max-height:92dvh}`，`tests/concept-editor-entry.test.mjs` 断言 `showActions` 默认值为 `true` 且 `app.mjs` 中恰好出现两处 `showActions: false`。后续新增对话框内编辑器用法时必须显式决定动作行归属，改动宽度必须同步更新测试，否则会在窄视口或双动作行上回归；本决策不新增配置、不落盘任何派生数据，文件协议不变。

证据锚点：`src/web/style.css`、`src/web/glossary.mjs`、`src/web/app.mjs`；`tests/project-open-ui.test.mjs`、`tests/concept-editor-entry.test.mjs`。
