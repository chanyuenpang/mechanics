import { compose, specializesDescendants } from '../domain/graph.mjs';
import { assertSemanticId, normalizeAliases, normalizeSearchTerm } from '../domain/identity.mjs';
import { icon } from './icons.mjs';

const copy = value => structuredClone(value);
// is-a 父概念候选：排除自身与更具体的后代（沿 specializes 入边，成环会被 domain 拒绝），
// 但绝不排除祖先——当前父概念必须留在候选里，才能显示为已选中。
export function isaParentCandidates(nodes, rules, conceptId) {
  const excluded = conceptId ? specializesDescendants(rules, conceptId) : new Set();
  if (conceptId) excluded.add(conceptId);
  return nodes.filter(node => !excluded.has(node.id));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normalized = text => normalizeSearchTerm(text);
export const parseAliases = value => normalizeAliases(Array.isArray(value) ? value : String(value ?? '').split(/[\n,，]/u));
export const parseTags = value => normalizeAliases(Array.isArray(value) ? value : String(value ?? '').split(/[\n,，]/u));
// 检索分两级：名称、稳定 ID、别名是概念的身份字段，描述与标签是长文本。
// 单字查询（中文一个字最典型）只搜身份字段——否则「伤」会因为描述里出现过一次而
// 把一大串无关概念刷进列表。结果按相关度排序：完全相同 > 前缀命中 > 其它命中，
// 身份命中始终排在只命中描述/标签的概念之前。
export function matchingConcepts(nodes, query) {
  const text = normalized(query);
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return nodes;
  const values = (node, keys) => keys.flatMap(key => (Array.isArray(node[key]) ? node[key] : [node[key]]));
  const contains = (list, word) => list.some(value => value !== undefined && value !== null && normalized(value).includes(word));
  const identity = node => values(node, ['label', 'id', 'aliases']);
  const secondary = node => values(node, ['description', 'tagIds']);
  const rank = node => {
    const label = normalized(node.label ?? ''), id = normalized(node.id ?? '');
    if (label === text || id === text) return 0;
    if (label.startsWith(text) || id.startsWith(text)) return 1;
    if (identity(node).some(value => value !== undefined && normalized(value) === text)) return 1;
    return 2;
  };
  // 单字查询只搜身份字段：长度 1 的包含关系在长描述里几乎不构成匹配。
  // 多字查询仍覆盖描述与标签（词可以分别落在不同字段上），但身份命中排在只命中描述的概念之前。
  const wide = text.length > 1;
  const matched = nodes.filter(node => words.every(word => contains(wide ? [...identity(node), ...secondary(node)] : identity(node), word)));
  return matched.map((node, index) => ({ node, index }))
    .sort((a, b) => rank(a.node) - rank(b.node) || a.index - b.index).map(item => item.node);
}
export function sameNamedConcepts(nodes, label) { return nodes.filter(node => normalized(node.label) === normalized(label)); }

export function conceptDuplicateModel(nodes, label, currentId) {
  const query = normalized(label);
  return query ? nodes.filter(node => node.id !== currentId && normalized(node.label) === query).map(node => ({ id: node.id, label: node.label, description: node.description })) : [];
}

// is-a 提交后当前文件（机制图草稿或视图）应当持有的固定引用：
// 1) 服务端在同一次提交里删掉的规则必须同步移除，否则下一次保存会因为引用已删除的规则
//    报 MISSING_REFERENCE（本机实测）；
// 2) 显式投影（ruleSelection: "explicit"）只投影 pinnedRuleIds，新写入的 is-a 规则必须补上，
//    否则画布上既没有分类边、也没有节点内的 is-a 标签；非显式投影按焦点投影，不需要补。
export function nextPinnedRuleIds(pinned, { removed = new Set(), added = [], pinAdded = false } = {}) {
  const kept = (pinned ?? []).filter(id => !removed.has(id));
  const next = pinAdded ? [...kept, ...added.filter(id => id && !kept.includes(id))] : kept;
  return { pinned: next, changed: next.length !== (pinned ?? []).length || next.some((id, index) => id !== (pinned ?? [])[index]) };
}

export function conceptReferencePickerCandidates(nodes, { query = '', kind = 'qualifier', currentId, excluded = null } = {}) {
  if (!['base', 'qualifier', 'isa'].includes(kind)) throw new Error('概念引用类型必须是基础概念、限定概念或 is-a 父概念。');
  const blocked = excluded instanceof Set ? excluded : new Set();
  const eligible = nodes.filter(node => node.id !== currentId && !blocked.has(node.id) && (kind !== 'base' || !node.baseConceptId));
  return matchingConcepts(eligible, query);
}

// 候选一次最多渲染这么多行：概念上千时，把全部匹配塞进 DOM 既慢又没法看，
// 剩下的用一行提示引导继续输入缩小范围。
export const CONCEPT_REFERENCE_LIMIT = 40;
let conceptReferencePickerIndex = 0;
export class ConceptReferencePicker {
  constructor({ nodes, currentId, kind, value = '', excluded = null, placeholder = '', ariaLabel, onSelect, clearOption = null }) {
    Object.assign(this, { nodes, currentId, kind, value, excluded, onSelect, clearOption, activeIndex: -1, query: '' });
    this.id = 'concept-reference-options-' + ++conceptReferencePickerIndex;
    this.root = element('div', undefined, 'concept-reference-picker');
    this.input = element('input'); this.input.type = 'text'; this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-label', ariaLabel); this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-controls', this.id); this.input.setAttribute('aria-expanded', 'false');
    if (placeholder) this.input.placeholder = placeholder;
    this.list = element('div', undefined, 'concept-reference-list'); this.list.id = this.id; this.list.setAttribute('role', 'listbox'); this.list.hidden = true;
    this.root.append(this.input, this.list); this.syncValue();
    this.input.onfocus = () => this.open();
    // 过滤词与输入框文字分开：打开时输入框保留当前选中概念的展示文字（它唯一标识当前值），
    // 列表仍展示全部候选，用户一打字就换成新的过滤词。
    this.input.oninput = () => { this.query = this.input.value; this.activeIndex = -1; this.draw(); };
    this.input.onkeydown = event => this.keydown(event);
  }
  candidates() { return conceptReferencePickerCandidates(this.nodes(), { query: this.query, kind: this.kind, currentId: this.currentId, excluded: this.excluded }); }
  // 有当前值时，候选列表的第一项就是清除：点它即清除，不需要二次确认。
  entries() {
    const clear = this.clearOption && this.value ? [{ clear: true, label: this.clearOption }] : [];
    return [...clear, ...this.candidates().map(node => ({ node }))];
  }
  visibleEntries() {
    const entries = this.entries();
    return { entries: entries.slice(0, CONCEPT_REFERENCE_LIMIT), total: entries.length };
  }
  syncValue() { this.input.value = this.value ? conceptReferencePresentation(this.value, this.nodes()) : ''; }
  open() {
    if (this.list.hidden) {
      this.query = ''; this.input.select?.();
    }
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true'); this.draw();
  }
  close() {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false'); this.input.removeAttribute('aria-activedescendant');
    this.query = ''; this.syncValue();
  }
  clear() { this.value = ''; this.query = ''; this.close(); this.onSelect(null); }
  draw() {
    const { entries, total } = this.visibleEntries(); this.list.replaceChildren();
    if (!entries.length) { this.activeIndex = -1; this.input.removeAttribute('aria-activedescendant'); this.list.append(element('div', '无匹配概念', 'concept-reference-empty')); return; }
    if (this.activeIndex >= entries.length) this.activeIndex = entries.length - 1;
    for (const [index, entry] of entries.entries()) {
      const option = element('div', undefined, 'concept-reference-option' + (entry.clear ? ' is-clear' : '')); option.id = this.id + '-' + index;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === this.activeIndex));
      // 列表只显示名称与稳定 ID：描述是长文本，作为预览出现时看起来不像匹配结果。
      if (entry.clear) option.append(element('strong', entry.label));
      else { option.title = entry.node.description; option.append(element('strong', entry.node.label), element('small', entry.node.id)); }
      option.onmousedown = event => { event.preventDefault(); entry.clear ? this.clear() : this.select(entry.node); };
      this.list.append(option);
    }
    if (total > entries.length) this.list.append(element('div', `还有 ${total - entries.length} 个候选，继续输入以缩小范围`, 'concept-reference-more'));
    if (this.activeIndex >= 0) this.input.setAttribute('aria-activedescendant', this.id + '-' + this.activeIndex);
    else this.input.removeAttribute('aria-activedescendant');
  }
  select(node) { this.value = node.id; this.query = ''; this.onSelect(node.id); this.close(); }
  keydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); this.open(); const last = this.visibleEntries().entries.length - 1;
      if (event.key === 'ArrowDown') this.activeIndex = Math.min(last, this.activeIndex + 1);
      else if (event.key === 'ArrowUp') this.activeIndex = Math.max(0, this.activeIndex - 1);
      else this.activeIndex = event.key === 'Home' ? 0 : last;
      this.draw(); return;
    }
    if (event.key !== 'Enter' || this.activeIndex < 0) return;
    const entry = this.visibleEntries().entries[this.activeIndex];
    if (!entry) return;
    event.preventDefault();
    if (entry.clear) this.clear(); else this.select(entry.node);
  }
}
export function validateConcept(node) {
  assertSemanticId(node.id, '概念 ID ');
  for (const [key, label] of [['label', '名称'], ['description', '概念含义']]) {
    if (typeof node[key] !== 'string' || !node[key].trim() || node[key].length > 8000) throw new Error(label + '必填，且不能超过 8000 字。');
  }
  if (typeof node.agentLocked !== 'boolean') throw new Error('概念必须明确 agentLocked。');
  if (node.customData !== undefined && (typeof node.customData !== 'string' || node.customData.length > 16000)) throw new Error('自定义文本必须是字符串，且不能超过 16000 字。');
  for (const [label, values] of [['别名', parseAliases(node.aliases)], ['标签', parseTags(node.tagIds)]]) {
    const normalizedValues = values.map(normalized);
    if (new Set(normalizedValues).size !== normalizedValues.length) throw new Error(label + '归一化后不能重复。');
  }
}

// 表单只转换用户明确选择的结构；引用有效性和跨文件语义仍由领域/服务端校验。
export function qualifierValueFromForm(row) {
  if (row.kind === 'concept') return { kind: 'concept', conceptId: row.conceptId };
  if (row.kind !== 'literal') throw new Error('限定值类型必须为概念引用或 literal。');
  if (row.literalType === 'null') return { kind: 'literal', value: null };
  if (row.literalType === 'boolean') {
    if (row.literalValue !== 'true' && row.literalValue !== 'false') throw new Error('布尔限定值必须明确选择 true 或 false。');
    return { kind: 'literal', value: row.literalValue === 'true' };
  }
  if (row.literalType === 'number') {
    if (typeof row.literalValue === 'string' && !row.literalValue.trim()) throw new Error('数字限定值不能为空。');
    const value = Number(row.literalValue);
    if (!Number.isFinite(value)) throw new Error('数字限定值必须是有限数字。');
    return { kind: 'literal', value };
  }
  if (row.literalType === 'string') return { kind: 'literal', value: String(row.literalValue ?? '') };
  throw new Error('literal 标量类型无效。');
}
export function qualifierFormRowFromCanonical(qualifier) {
  const { key, value } = qualifier;
  if (value.kind === 'concept') return { key, kind: 'concept', conceptId: value.conceptId };
  const literalType = value.value === null ? 'null' : typeof value.value;
  return { key, kind: 'literal', literalType, literalValue: literalType === 'null' ? '' : String(value.value) };
}
export function qualifierRowForKind(row, kind) {
  const key = row.key ?? '';
  if (kind === 'concept') return { key, kind: 'concept', conceptId: '' };
  if (kind === 'literal') return { key, kind: 'literal', literalType: 'string', literalValue: '' };
  throw new Error('限定值类型必须为概念引用或 literal。');
}
export function qualifierValueControlModel(row) {
  if (row.kind !== 'literal') return null;
  if (row.literalType === 'boolean') return { tag: 'select', options: [['true', 'true'], ['false', 'false']] };
  if (row.literalType === 'number') return { tag: 'input', type: 'number' };
  if (row.literalType === 'string') return { tag: 'input', type: 'text' };
  if (row.literalType === 'null') return { tag: 'none' };
  throw new Error('literal 标量类型无效。');
}

// 展示层不补写或猜测悬空引用；调用方可直接渲染这个纯模型。
export function conceptReferencePresentation(id, nodes) {
  const node = nodes.find(item => item.id === id);
  return node ? `${node.label}（${node.id}）` : `缺失概念（ID：${id}）`;
}
export function qualifierPresentation(qualifier, nodes) {
  const { key, value } = qualifier;
  if (value.kind === 'concept') return `${key}：概念 ${conceptReferencePresentation(value.conceptId, nodes)}`;
  const type = value.value === null ? 'null' : typeof value.value;
  const shown = type === 'string' ? `“${value.value}”` : String(value.value);
  return `${key}：literal ${type} ${shown}`;
}
export function conceptStructurePresentation(node, nodes) {
  return { shape: '概念', summary: '概念', base: null, qualifiers: [] };
}
export function conceptEditPresentation(node) {
  return { buttonLabel: '编辑概念', title: '编辑概念：' + node.label, saveLabel: '保存概念结构', cancelLabel: '取消编辑' };
}

export function conceptEditorModel(mode, node = {}) {
  if (!['create', 'edit'].includes(mode)) throw new Error('概念编辑模式必须是新建或编辑。');
  return { mode, title: mode === 'create' ? '新建概念' : '编辑概念：' + node.label, idReadonly: mode === 'edit', firstField: mode === 'create' ? 'id' : 'label',
    form: { id: node.id ?? '', label: node.label ?? '', description: node.description ?? '', aliases: node.aliases ?? [], tagIds: node.tagIds ?? [], customData: node.customData ?? '', agentLocked: node.agentLocked ?? false } };
}

export function conceptLockModel(agentLocked) {
  if (typeof agentLocked !== 'boolean') throw new Error('概念必须明确 agentLocked。');
  return { state: agentLocked ? '已锁定' : '未锁定', checked: agentLocked, description: agentLocked ? 'Agent 不可修改或删除；网页用户可解锁。' : 'Agent 可以修改或删除；网页用户可随时锁定。' };
}

export function conceptShapeWarning() { return ''; }

export function conceptEditorOpenState(openId, nextId) { return openId === nextId ? null : nextId; }
export function conceptPayloadFromForm(values) {
  const node = { id: values.id?.trim(), label: values.label?.trim(), description: values.description?.trim(), agentLocked: values.agentLocked,
    aliases: parseAliases(values.aliases), tagIds: parseTags(values.tagIds), customData: values.customData ?? '' };
  if (!node.aliases.length) delete node.aliases;
  if (!node.tagIds.length) delete node.tagIds;
  if (!node.customData) delete node.customData;
  validateConcept(node); return node;
}

export function prepareConceptUpdate(definitions, id, values) {
  const next = copy(definitions), node = next.nodes.find(item => item.id === id);
  if (!node) throw new Error('概念已不存在，请重新读取。');
  if (typeof values.agentLocked !== 'boolean') throw new Error('概念必须明确 agentLocked。');
  node.agentLocked = values.agentLocked;
  for (const key of ['label', 'description']) node[key] = values[key]?.trim();
  for (const [key, parse] of [['aliases', parseAliases], ['tagIds', parseTags]]) {
    node[key] = parse(values[key]);
    if (!node[key].length) delete node[key];
  }
  const customData = String(values.customData ?? '');
  if (customData) node.customData = customData;
  else delete node.customData;
  validateConcept(node);
  return next;
}

// 新引用的位置只写当前机制草稿；现有节点保持原位，不以全局定义排序重新排布。
export function referencePositions(existing, ids, center) {
  const positions = copy(existing);
  for (const id of ids) {
    let placed = false;
    for (let ring = 0; ring < 40 && !placed; ring++) {
      for (let y = -ring; y <= ring && !placed; y++) for (let x = -ring; x <= ring && !placed; x++) {
        if (ring && Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
        const p = { x: Math.round(center.x - 83 + x * 196), y: Math.round(center.y - 31 + y * 92) };
        if (Math.abs(p.x) > 100000 || Math.abs(p.y) > 100000) continue;
        if (Object.values(positions).some(q => p.x < q.x + 186 && p.x + 186 > q.x && p.y < q.y + 82 && p.y + 82 > q.y)) continue;
        positions[id] = p; placed = true;
      }
    }
    if (!placed) throw new Error('当前视野附近没有可放置节点的位置，请平移画布后重试。');
  }
  return Object.fromEntries(ids.map(id => [id, positions[id]]));
}

// rules 只承载本次新概念的 is-a；它与 definitions 必须由调用方在同一次提交里落盘。
export function prepareReference({ workspace, draft, selected, candidates, rules = null, positions, center }) {
  const definitions = copy(workspace.definitions), ids = new Set(definitions.nodes.map(node => node.id));
  const base = workspace.mechanics.find(item => item.id === draft.id);
  if (!base) throw new Error('当前机制不存在。');
  for (const node of candidates) {
    validateConcept(node);
    if (ids.has(node.id)) throw new Error('概念 ID 已存在，请重新核实，不能覆盖定义。');
    ids.add(node.id); definitions.nodes.push(copy(node));
  }
  const additions = [...new Set(selected)].filter(id => !draft.focusNodeIds.includes(id));
  if (!additions.length) throw new Error('请至少选择一个尚未引用的概念。');
  if (candidates.some(node => !additions.includes(node.id))) throw new Error('新概念必须同时被本次机制引用。');
  const mechanic = copy(draft);
  mechanic.focusNodeIds.push(...additions);
  if (mechanic.focusNodeIds.some(id => !ids.has(id))) throw new Error('待引用概念不存在，请重新核实定义。');
  Object.assign(mechanic.positions, referencePositions(positions, additions, center));
  compose({ ...workspace, definitions, mechanics: [mechanic] }, [mechanic.id]);
  // 新概念的 is-a 父概念必须存在于本次提交的定义里；否则服务端会整体拒绝，不如在这里先给出中文原因。
  if (rules) for (const rule of rules.rules.filter(item => item.relation === 'specializes' && candidates.some(node => node.id === item.source))) {
    if (!ids.has(rule.target)) throw new Error('is-a 父概念不存在，请重新核实定义：' + rule.target);
  }
  return { definitions, mechanic, base: copy(base), candidates: copy(candidates), rules: rules ? copy(rules) : null, additions };
}

// 两阶段明确提交：只有定义文件写盘，引用仍是机制草稿；失败后禁止盲目重放创建。
export class ReferenceCommit {
  constructor(plan) { this.plan = plan; this.phase = 'pending'; this.definitionsSaved = false; }
  get blocked() { return ['failed', 'uncertain'].includes(this.phase); }
  async run(saveDefinitions, applyReference) {
    if (this.blocked) throw new Error('请先重新读取并核实本次定义写入，不能重复创建。');
    if (['saving', 'applying', 'done'].includes(this.phase)) throw new Error('本次引用正在提交或已经完成。');
    if (this.plan.candidates.length && !this.definitionsSaved) {
      this.phase = 'saving';
      try { await saveDefinitions(copy(this.plan.definitions)); this.definitionsSaved = true; }
      catch (error) { this.phase = error.code === 'SAVE_UNCERTAIN' ? 'uncertain' : 'failed'; throw error; }
    }
    this.phase = 'applying';
    try {
      if (applyReference(copy(this.plan.mechanic)) !== true) throw new Error('无法应用到当前机制草稿。');
      this.phase = 'done';
    } catch (error) {
      this.phase = 'apply-failed';
      throw new Error((this.definitionsSaved ? '概念已保存，但尚未加入当前机制。' : '尚未加入当前机制。') + error.message + ' 可以继续引用，不会重复创建。');
    }
  }
  reconcile(workspace) {
    if (!this.blocked) throw new Error('当前引用无需核实写入。');
    if (!same(workspace.mechanics.find(item => item.id === this.plan.base.id), this.plan.base)) {
      throw new Error('磁盘上的当前机制已改变。请结束本次引用，重新读取后再合并。');
    }
    const found = this.plan.candidates.map(node => workspace.definitions.nodes.find(item => item.id === node.id));
    if (found.some(Boolean) && !found.every((node, index) => node && same(node, this.plan.candidates[index]))) {
      throw new Error('本次概念 ID 的磁盘内容不完整或不一致，请结束引用并核实，不能重复创建或覆盖。');
    }
    const saved = found.length > 0 && found.every(Boolean);
    const definitions = copy(workspace.definitions);
    if (!saved) definitions.nodes.push(...copy(this.plan.candidates));
    if (this.plan.mechanic.focusNodeIds.some(id => !definitions.nodes.some(node => node.id === id))) throw new Error('当前草稿引用的概念已不存在，请重新读取后合并定义。');
    compose({ ...workspace, definitions, mechanics: [this.plan.mechanic] }, [this.plan.mechanic.id]);
    this.plan.definitions = definitions; this.definitionsSaved = saved; this.phase = 'pending';
    return saved;
  }
}

const element = (tag, text, className) => {
  const item = document.createElement(tag); if (text !== undefined) item.textContent = text;
  if (className) item.className = className; return item;
};
const action = (text, run, className = 'quiet') => {
  const item = element('button', text, className); item.type = 'button'; item.onclick = run; return item;
};


export class ConceptEditor {
  constructor(host, { mode, node, nodes, tagDefinitions = [], parentOptions = null, parentId = null, onSave, onCancel, onReuse }) {
    const model = conceptEditorModel(mode, node); Object.assign(this, { host, mode, nodes, tagDefinitions, parentOptions, onSave, onCancel, onReuse, allowDuplicate: false, form: model.form });
    // parentId 是 is-a 候选，不进入概念文档本身；只在调用方提供了可选父概念时才渲染控件。
    this.form.parentId = parentId ?? '';
    this.root = element('section', undefined, 'concept-editor'); this.root.setAttribute('aria-label', model.title); host.replaceChildren(this.root); this.render();
    queueMicrotask(() => this.root.querySelector('[data-editor-field="' + model.firstField + '"]')?.focus());
  }
  field(label, key, type = 'input') {
    const wrap = element('label', undefined, 'field'), input = element(type); input.dataset.editorField = key; input.setAttribute('aria-label', label);
    input.value = Array.isArray(this.form[key]) ? this.form[key].join(', ') : this.form[key] ?? ''; input.required = ['id', 'label', 'description'].includes(key);
    if (key === 'id') { input.maxLength = 96; input.readOnly = this.mode === 'edit'; } else input.maxLength = key === 'customData' ? 16000 : 8000;
    if (type === 'textarea') input.rows = key === 'customData' ? 4 : 2;
    input.oninput = () => { this.form[key] = key === 'aliases' ? parseAliases(input.value) : input.value; if (key === 'label') { this.allowDuplicate = false; this.drawDuplicates(); } };
    wrap.append(element('span', label), input); return wrap;
  }
  render() {
    const title = element('h2', this.mode === 'create' ? '新建概念' : '编辑概念：' + this.form.label);
    const identity = element('fieldset', undefined, 'concept-editor-identity'); identity.append(element('legend', '身份'), this.field('名称', 'label'), this.field('稳定英文 ID', 'id'), this.field('概念含义', 'description', 'textarea'));
    const duplicateHost = element('div', undefined, 'concept-editor-duplicates'); identity.append(duplicateHost);
    const discovery = element('fieldset', undefined, 'concept-editor-discovery'); discovery.append(element('legend', '检索信息'), this.field('别名', 'aliases'), this.tagPicker());
    const customData = element('fieldset', undefined, 'concept-editor-custom-data'); customData.append(element('legend', '自定义文本'), this.field('自定义文本', 'customData', 'textarea'));
    const permission = element('fieldset', undefined, 'concept-editor-permission'), lock = conceptLockModel(this.form.agentLocked), descriptionId = 'concept-lock-description'; permission.append(element('legend', '修改权限'));
    const card = element('label', undefined, 'concept-lock-card'), toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = lock.checked; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-describedby', descriptionId); toggle.setAttribute('aria-label', 'Agent 修改锁');
    const state = element('strong', lock.state), description = element('p', lock.description); description.id = descriptionId; toggle.onchange = () => { this.form.agentLocked = toggle.checked; this.render(); }; card.append(toggle, state, description); permission.append(card);
    const error = element('p', undefined, 'concept-editor-error danger'); error.setAttribute('role', 'alert'); error.hidden = true;
    const actions = element('div', undefined, 'concept-editor-actions'); const save = action(this.mode === 'create' ? '创建并引用' : '保存概念', () => { try { if (this.mode === 'create' && conceptDuplicateModel(this.nodes(), this.form.label, this.form.id).length && !this.allowDuplicate) throw new Error('请确认仍创建同名概念，或复用已有概念。'); this.onSave(this.form, { allowDuplicate: this.allowDuplicate }); } catch (cause) { error.textContent = cause.message; error.hidden = false; } }, 'primary'); actions.append(save, action('取消', () => this.onCancel()));
    this.root.replaceChildren(title, identity, discovery, ...(this.parentOptions ? [this.parentField()] : []), customData, permission, error, actions); this.drawDuplicates();
  }
  // is-a 父概念是可检索的组合框：候选由调用方排除自身与更具体的后代后传入，
  // 当前父概念留在候选里并显示为已选中；有当前值时列表首项就是清除，点它即清除，不做二次确认。
  parentField() {
    const wrap = element('fieldset', undefined, 'concept-editor-taxonomy'); wrap.append(element('legend', 'is-a 父概念'));
    const field = element('label', undefined, 'field');
    const picker = new ConceptReferencePicker({
      nodes: () => this.parentOptions, currentId: this.form.id, kind: 'isa', value: this.form.parentId ?? '',
      placeholder: '输入名称、ID、别名或含义搜索父概念', ariaLabel: 'is-a 父概念',
      onSelect: id => { this.form.parentId = id ?? ''; },
      clearOption: '清除 is-a 父概念',
    });
    picker.input.dataset.editorField = 'parentId';
    field.append(element('span', 'is-a 父概念'), picker.root);
    wrap.append(field, element('p', '每个概念至多一个 is-a 父概念；方向是「具体概念 → 父概念」，更换时旧分类边被替换，自连与成环会被拒绝。', 'note'));
    return wrap;
  }
  tagPicker() {
    const wrap = element('fieldset', undefined, 'concept-tag-picker'); wrap.append(element('legend', '标签'));
    if (!this.tagDefinitions.length) { wrap.append(element('p', '暂无标签，请在概念表的标签页创建。', 'note')); return wrap; }
    for (const tag of this.tagDefinitions) {
      const button = action(tag.displayName, () => { const ids = new Set(this.form.tagIds ?? []); ids.has(tag.id) ? ids.delete(tag.id) : ids.add(tag.id); this.form.tagIds = [...ids]; this.render(); }, 'tag-choice');
      button.style.setProperty('--tag-color', tag.color); button.classList.toggle('selected', (this.form.tagIds ?? []).includes(tag.id)); button.setAttribute('aria-pressed', String((this.form.tagIds ?? []).includes(tag.id))); wrap.append(button);
    }
    return wrap;
  }
  drawDuplicates() {
    const host = this.root.querySelector('.concept-editor-duplicates'); if (!host || this.mode !== 'create') return; host.replaceChildren();
    const duplicates = conceptDuplicateModel(this.nodes(), this.form.label, this.form.id); if (!duplicates.length) return;
    host.append(element('p', '发现同名概念：', 'note'));
    for (const item of duplicates) {
      const row = element('div', item.label + ' · ' + item.id + '：' + item.description, 'concept-duplicate-row');
      if (this.onReuse) row.append(action('复用已有概念', () => this.onReuse(item.id))); host.append(row);
    }
    const confirm = element('label', undefined, 'concept-duplicate-confirm'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = this.allowDuplicate; checkbox.onchange = () => { this.allowDuplicate = checkbox.checked; }; confirm.append(checkbox, document.createTextNode('确认仍创建同名概念')); host.append(confirm);
  }
  qualifierRow(rows, row) {
    const wrap = element('div', undefined, 'qualifier-row'), key = element('input'); key.value = row.key ?? ''; key.placeholder = '限定键'; key.setAttribute('aria-label', '限定键语义 ID'); key.oninput = () => { row.key = key.value; };
    const kind = element('select'); for (const [value, text] of [['concept', '概念引用'], ['literal', '标量 literal']]) { const option = element('option', text); option.value = value; kind.append(option); } kind.value = row.kind; kind.onchange = () => { Object.assign(row, qualifierRowForKind(row, kind.value)); this.render(); }; wrap.append(key, kind);
    if (row.kind === 'concept') wrap.append(new ConceptReferencePicker({ nodes: this.nodes, currentId: this.form.id || undefined, kind: 'qualifier', value: row.conceptId, ariaLabel: '限定概念引用', onSelect: id => { row.conceptId = id; } }).root);
    else { const type = element('select'); for (const [value, text] of [['string', '文本'], ['number', '数字'], ['boolean', '布尔'], ['null', 'null']]) { const option = element('option', text); option.value = value; type.append(option); } type.value = row.literalType; type.onchange = () => { Object.assign(row, qualifierRowForKind(row, 'literal'), { literalType: type.value }); this.render(); }; wrap.append(type); const model = qualifierValueControlModel(row); if (model.tag !== 'none') { const value = element(model.tag); value.value = row.literalValue ?? ''; if (model.tag === 'select') for (const [id, label] of model.options) { const option = element('option', label); option.value = id; value.append(option); } else value.type = model.type; value.oninput = value.onchange = () => { row.literalValue = value.value; }; wrap.append(value); } }
    wrap.append(action('删除', () => { this.form.qualifiers.splice(this.form.qualifiers.indexOf(row), 1); this.render(); })); rows.append(wrap);
  }
}

// 窗口候选只存在于本次引用会话；不直接改共享定义或机制文件。
export class ConceptPicker {
  constructor(container, session, definitions, referenced, { status, recover = () => {}, abandon = () => {}, allowCreate = true, parentOptions = null }) {
    Object.assign(this, { container, session, definitions, referenced, status, allowCreate, parentOptions });
    container.innerHTML = `<fieldset class="concept-picker-fields"><label class="field">搜索概念<input class="concept-search" type="search" aria-label="搜索概念" placeholder="名称、含义或 ID" autocomplete="off"></label>
      <div class="concept-picked" aria-label="待引用概念"></div><div class="choice-list concept-results" aria-label="搜索结果"></div><button class="concept-new quiet" type="button"></button>
      <section class="concept-form" aria-label="新概念定义" hidden></section></fieldset>
      <p class="note concept-save-note">新概念将保存到概念表，引用加入当前机制草稿。</p>
      <div class="concept-recovery" hidden><button type="button" class="concept-recover">重新读取并核实</button><button type="button" class="concept-abandon quiet danger">结束本次引用（保留已写入概念）</button><p class="concept-recovery-note note" role="status"></p></div>`;
    this.get = selector => container.querySelector(selector);
    this.search = this.get('.concept-search'); this.search.value = session.query;
    this.search.oninput = () => { session.query = this.search.value; this.drawResults(); };
    this.search.onkeydown = event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      this.get('.concept-results input:not(:disabled)')?.click();
    };
    container.onkeydown = event => { if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault(); };
    this.get('.concept-new').onclick = () => this.begin();
    this.get('.concept-recover').onclick = recover;
    this.get('.concept-abandon').onclick = abandon;
    this.get('.concept-form').hidden = true;
    if (!this.allowCreate) { this.get('.concept-new').hidden = true; this.get('.concept-save-note').textContent = '仅可引用已有概念；此处不能新建或修改概念定义。'; }
    this.drawResults(); queueMicrotask(() => this.search.focus());
  }
  allNodes() { return [...this.definitions.nodes, ...this.session.candidates]; }
  // 新建候选同样可以指定 is-a 父概念：候选每次打开表单时现取，已暂存的概念也能当父概念。
  begin() {
    const node = { id: '', label: this.session.query.trim(), aliases: '', description: '', tagIds: [], agentLocked: false };
    this.session.allowDuplicate = false;
    this.get('.concept-form').hidden = false;
    for (const selector of ['.concept-search', '.concept-picked', '.concept-results', '.concept-new']) { const discovery = this.get(selector); discovery.hidden = true; discovery.inert = true; }
    this.editor = new ConceptEditor(this.get('.concept-form'), { mode: 'create', node, nodes: () => this.allNodes(), tagDefinitions: this.definitions.tagDefinitions ?? [], parentOptions: this.parentOptions ? this.parentOptions() : null, onSave: (form, { allowDuplicate }) => { this.session.form = form; this.session.allowDuplicate = allowDuplicate; this.stage(); }, onCancel: () => this.cancelForm(), onReuse: id => { this.session.selected.add(id); this.cancelForm(); } });
    this.session.form = this.editor.form;
  }
  cancelForm() { this.session.form = null; this.get('.concept-form').hidden = true; for (const selector of ['.concept-search', '.concept-picked', '.concept-results', '.concept-new']) { const discovery = this.get(selector); discovery.hidden = false; discovery.inert = false; } this.drawResults(); this.search.focus(); }
  stage() {
    const form = this.session.form; if (!form) return;
    const candidate = conceptPayloadFromForm(form);
    if (this.allNodes().some(node => node.id === candidate.id)) throw new Error('概念 ID 已存在，请使用另一个稳定英文 ID。');
    if (sameNamedConcepts(this.allNodes(), form.label).length && !this.session.allowDuplicate) throw new Error('请复用已有概念，或明确勾选同名新建。');
    this.session.candidates.push(candidate); this.session.selected.add(candidate.id);
    if (!(this.session.candidateParents instanceof Map)) this.session.candidateParents = new Map();
    if (form.parentId) this.session.candidateParents.set(candidate.id, form.parentId);
    else this.session.candidateParents.delete(candidate.id);
    this.cancelForm();
  }
  drawResults() {
    const list = this.get('.concept-results'); list.replaceChildren();
    const matches = matchingConcepts(this.allNodes(), this.session.query), shown = matches.slice(0, CONCEPT_REFERENCE_LIMIT);
    for (const node of shown) {
      const label = element('label', undefined, 'choice'), input = element('input'); input.type = 'checkbox';
      const used = this.referenced.includes(node.id), fresh = this.session.candidates.some(item => item.id === node.id);
      input.disabled = used; input.checked = used || this.session.selected.has(node.id); input.setAttribute('aria-label', '引用 ' + node.label);
      input.onchange = () => { if (input.checked) this.session.selected.add(node.id); else this.session.selected.delete(node.id); this.drawPicked(); this.updateStatus(); };
      const text = element('span', node.label); text.append(element('small', node.description), element('small', node.id, 'concept-id'));
      label.append(input, text); if (used || fresh) label.append(element('span', used ? '已在当前图中' : '待新建', 'concept-badge'));
      list.append(label);
    }
    if (!list.childElementCount) list.append(element('p', '没有匹配概念', 'note'));
    // 概念上千时不能把全部匹配塞进列表：先给最相关的一屏，再提示继续输入。
    if (matches.length > shown.length) list.append(element('p', `还有 ${matches.length - shown.length} 个匹配概念，继续输入以缩小范围`, 'note concept-results-more'));
    if (this.allowCreate) this.get('.concept-new').replaceChildren(icon('plus'), document.createTextNode(this.session.query.trim() ? '新建「' + this.session.query.trim() + '」' : '新建概念'));
    this.drawPicked(); this.updateStatus();
  }
  drawPicked() {
    const box = this.get('.concept-picked'); box.replaceChildren();
    for (const id of this.session.selected) {
      const node = this.allNodes().find(item => item.id === id);
      const parentId = this.session.candidateParents instanceof Map ? this.session.candidateParents.get(id) : null;
      const chip = element('span', undefined, 'concept-chip'); chip.append(element('span', node.label));
      if (parentId) chip.append(element('small', 'is-a ' + (this.allNodes().find(item => item.id === parentId)?.label ?? parentId), 'concept-parent'));
      const remove = action('', () => {
        this.session.selected.delete(id); this.session.candidates = this.session.candidates.filter(item => item.id !== id);
        if (this.session.candidateParents instanceof Map) this.session.candidateParents.delete(id);
        this.drawResults();
      });
      remove.append(icon('close'));
      remove.setAttribute('aria-label', '取消待引用 ' + node.label); chip.append(remove); box.append(chip);
    }
    box.hidden = !box.childElementCount;
  }
  updateStatus() {
    const { commit, selected, form, candidates } = this.session;
    this.get('.concept-picker-fields').disabled = !!commit;
    this.get('.concept-recovery').hidden = !commit || ['saving', 'applying', 'done'].includes(commit.phase);
    this.get('.concept-recover').hidden = !commit?.blocked;
    const count = selected.size + (form ? 1 : 0);
    const creating = this.allowCreate && !commit?.definitionsSaved && (form || candidates.some(node => selected.has(node.id)));
    this.status((commit?.definitionsSaved || commit?.phase === 'apply-failed' ? '继续引用' : creating ? '创建并引用' : '添加节点') + (count ? `（${count}）` : ''), !!count && !commit?.blocked && !['saving', 'applying', 'done'].includes(commit?.phase));
  }
}

// 名词表只是统一定义草稿的编辑视图，不持有另一份节点数据。
export class GlossaryTable {
  constructor(container, { change, replace, add, remove, setLocks, updateTags }) {
    this.container = container; this.change = change; this.replace = replace; this.add = add; this.remove = remove; this.setLocks = setLocks; this.updateTags = updateTags; this.mode = 'concepts';
    container.innerHTML = `<div class="glossary-heading"><div><h1>概念表 <span id="glossary-count"></span></h1><p>直接编辑单元格 · 所有机制图共用这些概念</p></div><div><button id="glossary-concepts">概念</button><button id="glossary-tags" class="quiet">标签</button><button id="glossary-add">新增概念</button></div></div>
      <div class="glossary-tools"><input id="glossary-search" type="search" aria-label="搜索节点名词表" placeholder="搜索名称、ID 或定义…"><span>修改后 Ctrl S 保存</span></div>
      <div class="glossary-scroll"><table aria-label="统一节点名词表"><colgroup><col class="term-name"><col class="term-description"><col class="term-id"><col class="term-lock"><col class="term-actions"></colgroup><thead><tr><th scope="col">概念</th><th scope="col">概念含义</th><th scope="col">稳定 ID</th><th scope="col" class="term-lock-heading"><label><input id="glossary-lock-all" type="checkbox" aria-label="批量切换当前概念的 Agent 锁">Agent 锁</label></th><th scope="col">操作</th></tr></thead><tbody></tbody></table><div id="glossary-empty" hidden>没有匹配的概念</div><button id="glossary-add-row">新增一行</button></div>
      <div class="glossary-footer">名称与含义必填；别名和标签可用逗号或换行分隔。锁定后 Agent 不能修改或删除概念，网页仍可解锁。</div>`;
    this.search = container.querySelector('#glossary-search');
    container.querySelector('#glossary-concepts').onclick = () => { this.mode = 'concepts'; this.draw(); };
    container.querySelector('#glossary-tags').onclick = () => { this.mode = 'tags'; this.draw(); };
    this.lockAll = container.querySelector('#glossary-lock-all');
    this.lockAll.onchange = () => this.setLocks(this.matches.map(node => node.id), this.lockAll.checked);
    for (const id of ['glossary-add', 'glossary-add-row']) {
      const addButton = container.querySelector('#' + id); addButton.textContent = id === 'glossary-add' ? '新增概念' : '新增一行'; addButton.prepend(icon('plus'));
    }
    this.search.oninput = () => this.draw();
    this.fitTextareas = () => container.querySelectorAll('tbody textarea').forEach(input => {
      input.style.height = '0px'; input.style.height = input.scrollHeight + 'px';
    });
    window.addEventListener('resize', this.fitTextareas);
    for (const id of ['glossary-add', 'glossary-add-row']) container.querySelector('#' + id).onclick = add;
  }
  update(nodes, mechanics, pending, tagDefinitions = []) {
    this.nodes = nodes; this.mechanics = mechanics; this.pending = pending; this.tagDefinitions = tagDefinitions;
    for (const id of ['glossary-add', 'glossary-add-row']) this.container.querySelector('#' + id).disabled = !!pending;
    this.draw();
  }
  draw() {
    if (this.mode === 'tags') return this.drawTags();
    this.container.querySelector('#glossary-tag-add')?.remove();
    this.container.querySelector('colgroup').innerHTML = '<col class="term-name"><col class="term-description"><col class="term-id"><col class="term-lock"><col class="term-actions">';
    this.container.querySelector('thead tr').innerHTML = '<th scope="col">概念</th><th scope="col">概念含义</th><th scope="col">稳定 ID</th><th scope="col" class="term-lock-heading"><label><input id="glossary-lock-all" type="checkbox" aria-label="批量切换当前概念的 Agent 锁">Agent 锁</label></th><th scope="col">操作</th>';
    this.lockAll = this.container.querySelector('#glossary-lock-all');
    this.lockAll.onchange = () => this.setLocks(this.matches.map(node => node.id), this.lockAll.checked);
    this.container.querySelector('#glossary-concepts').classList.add('primary'); this.container.querySelector('#glossary-tags').classList.remove('primary');
    this.container.querySelector('#glossary-add').hidden = false; this.container.querySelector('#glossary-add-row').hidden = false;
    const body = this.container.querySelector('tbody'); body.replaceChildren();
    const query = this.search.value.trim().toLowerCase();
    const matches = this.nodes.filter(node => [node.label, node.id, ...(node.aliases ?? []), node.description, ...(node.tagIds ?? [])]
      .some(value => value.toLowerCase().includes(query)));
    this.matches = matches;
    const lockedCount = matches.filter(node => node.agentLocked).length;
    this.lockAll.checked = matches.length > 0 && lockedCount === matches.length;
    this.lockAll.indeterminate = lockedCount > 0 && lockedCount < matches.length;
    this.lockAll.disabled = !!this.pending || matches.length === 0;
    this.container.querySelector('#glossary-count').textContent = `${matches.length} / ${this.nodes.length}`;
    this.container.querySelector('#glossary-empty').hidden = matches.length > 0;
    for (const node of matches) {
      const row = document.createElement('tr'); row.dataset.nodeId = node.id;
      const label = document.createElement('td'); label.className = 'term-name-cell'; label.append(element('strong', node.label));
      const description = document.createElement('td'); description.className = 'term-description-cell'; description.textContent = node.description;
      const id = document.createElement('td'); id.className = 'term-id-cell'; id.append(element('code', node.id));
      const lock = document.createElement('td'); lock.className = 'term-lock-cell'; const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = node.agentLocked; toggle.disabled = !!this.pending; toggle.title = node.agentLocked ? '解除 Agent 锁' : '锁定 Agent 修改'; toggle.setAttribute('aria-label', `${toggle.title}：${node.label}`); toggle.onchange = () => this.setLocks([node.id], toggle.checked); lock.append(toggle);
      const actions = document.createElement('td'); actions.className = 'term-action-cell';
      const remove = document.createElement('button'); remove.className = 'term-delete'; remove.append(icon('trash')); remove.setAttribute('aria-label', '删除概念 ' + node.id); remove.disabled = !!this.pending;
      remove.title = '删除概念；将要求再次确认，并检查规则和视图引用。';
      remove.onclick = () => this.remove(node.id);
      const editState = conceptEditPresentation(node);
      const configure = document.createElement('button'); configure.textContent = editState.buttonLabel; configure.disabled = !!this.pending;
      configure.onclick = () => this.openQualifierSettings(row, node);
      actions.append(configure, remove); row.append(label, description, id, lock, actions); body.append(row);
    }
    this.fitTextareas();
  }
  drawTags() {
    const body = this.container.querySelector('tbody'); body.replaceChildren();
    this.container.querySelector('#glossary-concepts').classList.remove('primary'); this.container.querySelector('#glossary-tags').classList.add('primary');
    this.container.querySelector('#glossary-add').hidden = true; this.container.querySelector('#glossary-add-row').hidden = true;
    this.container.querySelector('#glossary-count').textContent = `${this.tagDefinitions.length} 个标签`;
    this.container.querySelector('#glossary-empty').hidden = true;
    this.container.querySelector('colgroup').innerHTML = '<col class="term-id"><col class="term-name"><col class="term-actions">';
    this.container.querySelector('thead tr').innerHTML = '<th scope="col">稳定 ID</th><th scope="col">显示名</th><th scope="col">颜色</th>';
    for (const tag of this.tagDefinitions) {
      const row = document.createElement('tr');
      const id = document.createElement('td'); id.append(element('code', tag.id));
      const label = document.createElement('td'), input = document.createElement('input'); input.value = tag.displayName; input.disabled = !!this.pending; input.onchange = () => this.updateTags(this.tagDefinitions.map(item => item.id === tag.id ? { ...item, displayName: input.value.trim() } : item)); label.append(input);
      const color = document.createElement('td'), picker = document.createElement('input'); picker.type = 'color'; picker.value = tag.color; picker.disabled = !!this.pending; picker.oninput = () => this.updateTags(this.tagDefinitions.map(item => item.id === tag.id ? { ...item, color: picker.value } : item)); color.append(picker);
      row.append(id, label, color); body.append(row);
    }
    this.container.querySelector('#glossary-tag-add')?.remove();
    const add = document.createElement('button'); add.id = 'glossary-tag-add'; add.textContent = '新增标签'; add.disabled = !!this.pending;
    add.onclick = () => {
      const row = document.createElement('tr'), idCell = document.createElement('td'), nameCell = document.createElement('td'), colorCell = document.createElement('td');
      const id = document.createElement('input'), displayName = document.createElement('input'), color = document.createElement('input'), confirm = document.createElement('button');
      id.placeholder = '标签 ID'; displayName.placeholder = '显示名'; color.type = 'color'; color.value = '#6b7280'; confirm.textContent = '添加';
      confirm.onclick = () => { const nextId = id.value.trim(), nextName = displayName.value.trim(); if (!nextId || !nextName) return; this.updateTags([...this.tagDefinitions, { id: nextId, displayName: nextName, color: color.value }]); };
      idCell.append(id); nameCell.append(displayName); colorCell.append(color, confirm); row.append(idCell, nameCell, colorCell); body.append(row); id.focus();
    };
    this.container.querySelector('.glossary-scroll').append(add);
  }
  openQualifierSettings(row, node) {
    if (this.pending) return;
    if (this.editorRow) this.editorRow.remove();
    this.editingId = conceptEditorOpenState(this.editingId, node.id);
    if (!this.editingId) return;
    const editor = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.className = 'concept-editor-row'; editor.append(cell); row.after(editor); this.editorRow = editor;
    new ConceptEditor(cell, { mode: 'edit', node, nodes: () => this.nodes, tagDefinitions: this.tagDefinitions, onSave: form => { const nextNode = prepareConceptUpdate({ nodes: [node] }, node.id, form).nodes[0]; this.replace(node.id, nextNode); this.editingId = null; this.editorRow = null; editor.remove(); this.draw(); }, onCancel: () => { this.editingId = null; this.editorRow = null; editor.remove(); this.draw(); } });
    return;
  }
  focusNode(id) {
    this.search.value = ''; this.draw();
    const row = [...this.container.querySelectorAll('tbody tr')].find(item => item.dataset.nodeId === id);
    row?.querySelector('input')?.focus(); row?.scrollIntoView({ block: 'nearest' });
  }
}
