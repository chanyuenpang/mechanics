import { compose } from '../domain/graph.mjs';

const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normalized = text => text.trim().toLocaleLowerCase();
export function matchingConcepts(nodes, query) {
  const words = normalized(query).split(/\s+/);
  return nodes.filter(node => words.every(word => [node.label, node.id, node.description, node.increaseMeaning].some(text => normalized(text).includes(word))));
}
export function sameNamedConcepts(nodes, label) { return nodes.filter(node => normalized(node.label) === normalized(label)); }
export function validateConcept(node) {
  for (const [key, label] of [['label', '名称'], ['description', '概念含义'], ['increaseMeaning', '增加方向']]) {
    if (typeof node[key] !== 'string' || !node[key].trim() || node[key].length > 8000) throw new Error(label + '必填，且不能超过 8000 字。');
  }
}

export function prepareConceptUpdate(definitions, id, values) {
  const next = copy(definitions), node = next.nodes.find(item => item.id === id);
  if (!node) throw new Error('概念已不存在，请重新读取。');
  for (const key of ['label', 'description', 'increaseMeaning']) node[key] = values[key]?.trim();
  validateConcept(node);
  return next;
}

// 新引用的位置只写当前研究草稿；现有节点保持原位，不以全局定义排序重新排布。
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

export function prepareReference({ workspace, draft, selected, candidates, positions, center }) {
  const definitions = copy(workspace.definitions), ids = new Set(definitions.nodes.map(node => node.id));
  const base = workspace.analyses.find(item => item.id === draft.id);
  if (!base) throw new Error('当前研究不存在。');
  for (const node of candidates) {
    validateConcept(node);
    if (ids.has(node.id)) throw new Error('概念 ID 已存在，请重新核实，不能覆盖定义。');
    ids.add(node.id); definitions.nodes.push(copy(node));
  }
  const additions = [...new Set(selected)].filter(id => !draft.nodeIds.includes(id));
  if (!additions.length) throw new Error('请至少选择一个尚未引用的概念。');
  if (candidates.some(node => !additions.includes(node.id))) throw new Error('新概念必须同时被本次研究引用。');
  const analysis = copy(draft);
  analysis.nodeIds.push(...additions);
  if (analysis.nodeIds.some(id => !ids.has(id))) throw new Error('待引用概念不存在，请重新核实定义。');
  Object.assign(analysis.positions, referencePositions(positions, additions, center));
  compose({ ...workspace, definitions, analyses: [analysis] }, [analysis.id]);
  return { definitions, analysis, base: copy(base), candidates: copy(candidates), additions };
}

// 两阶段明确提交：只有定义文件写盘，引用仍是研究草稿；失败后禁止盲目重放创建。
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
      if (applyReference(copy(this.plan.analysis)) !== true) throw new Error('无法应用到当前研究草稿。');
      this.phase = 'done';
    } catch (error) {
      this.phase = 'apply-failed';
      throw new Error((this.definitionsSaved ? '概念已保存，但尚未加入当前研究。' : '尚未加入当前研究。') + error.message + ' 可以继续引用，不会重复创建。');
    }
  }
  reconcile(workspace) {
    if (!this.blocked) throw new Error('当前引用无需核实写入。');
    if (!same(workspace.analyses.find(item => item.id === this.plan.base.id), this.plan.base)) {
      throw new Error('磁盘上的当前研究已改变。请导出本次输入和研究草稿，结束本次引用后重新读取并合并。');
    }
    const found = this.plan.candidates.map(node => workspace.definitions.nodes.find(item => item.id === node.id));
    if (found.some(Boolean) && !found.every((node, index) => node && same(node, this.plan.candidates[index]))) {
      throw new Error('本次概念 ID 的磁盘内容不完整或不一致，请导出输入后人工核实，不能重复创建或覆盖。');
    }
    const saved = found.length > 0 && found.every(Boolean);
    const definitions = copy(workspace.definitions);
    if (!saved) definitions.nodes.push(...copy(this.plan.candidates));
    if (this.plan.analysis.nodeIds.some(id => !definitions.nodes.some(node => node.id === id))) throw new Error('当前草稿引用的概念已不存在，请导出并合并定义。');
    compose({ ...workspace, definitions, analyses: [this.plan.analysis] }, [this.plan.analysis.id]);
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

// 窗口候选只存在于本次引用会话；不直接改共享定义或研究文件。
export class ConceptPicker {
  constructor(container, session, definitions, referenced, { status, recover, exportInputs, abandon }) {
    Object.assign(this, { container, session, definitions, referenced, status });
    container.innerHTML = `<fieldset class="concept-picker-fields"><label class="field">搜索概念<input class="concept-search" type="search" aria-label="搜索概念" placeholder="名称、含义或 ID" autocomplete="off"></label>
      <div class="concept-picked" aria-label="待引用概念"></div><div class="choice-list concept-results" aria-label="搜索结果"></div><button class="concept-new quiet" type="button"></button>
      <section class="concept-form" aria-label="新概念定义" hidden><div class="concept-form-heading"><strong>新建概念</strong><button class="concept-back quiet" type="button">取消新建</button></div>
      <label class="field">名称<input data-field="label" aria-label="新概念名称" maxlength="8000" required></label>
      <label class="field">概念含义<textarea data-field="description" aria-label="新概念含义" rows="2" maxlength="8000" required></textarea></label>
      <label class="field">增加方向<textarea data-field="increaseMeaning" aria-label="新概念增加方向" placeholder="这个概念增强或更容易发生时，意味着什么？" rows="2" maxlength="8000" required></textarea></label>
      <div class="concept-duplicates"></div><label class="concept-duplicate-confirm" hidden><input type="checkbox">确认新建另一个同名概念</label>
      <button class="concept-stage quiet" type="button">加入待选并继续</button><p class="concept-form-error danger" role="alert" hidden></p></section></fieldset>
      <p class="note concept-save-note">新概念将保存到概念表，引用加入当前研究草稿。</p>
      <div class="concept-recovery" hidden><button type="button" class="concept-recover">重新读取并核实</button><button type="button" class="concept-export quiet">导出本次输入与研究草稿</button><button type="button" class="concept-abandon quiet danger">结束本次引用（保留已写入概念）</button><p class="concept-recovery-note note" role="status"></p></div>`;
    this.get = selector => container.querySelector(selector);
    this.inputs = Object.fromEntries([...container.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input]));
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
    this.get('.concept-back').onclick = () => this.cancelForm();
    for (const [key, input] of Object.entries(this.inputs)) input.oninput = () => {
      session.form[key] = input.value;
      if (key === 'label') { this.get('.concept-duplicate-confirm input').checked = false; session.allowDuplicate = false; this.drawDuplicates(); }
      this.get('.concept-form-error').hidden = true; this.updateStatus();
    };
    this.get('.concept-duplicate-confirm input').onchange = event => { session.allowDuplicate = event.target.checked; };
    this.get('.concept-stage').onclick = () => {
      try { this.stage(); this.search.value = session.query = ''; this.drawResults(); this.search.focus(); }
      catch (error) { this.get('.concept-form-error').textContent = error.message; this.get('.concept-form-error').hidden = false; }
    };
    this.get('.concept-recover').onclick = recover;
    this.get('.concept-export').onclick = exportInputs;
    this.get('.concept-abandon').onclick = abandon;
    this.showForm(); this.drawResults(); queueMicrotask(() => this.search.focus());
  }
  allNodes() { return [...this.definitions.nodes, ...this.session.candidates]; }
  begin() {
    this.session.form = { id: 'node-' + crypto.randomUUID(), label: this.session.query.trim(), description: '', increaseMeaning: '' };
    this.session.allowDuplicate = false; this.showForm();
    (this.session.form.label ? this.inputs.description : this.inputs.label).focus();
  }
  cancelForm() { this.session.form = null; this.showForm(); this.search.focus(); }
  showForm() {
    const form = this.session.form;
    this.get('.concept-form').hidden = !form;
    for (const [key, input] of Object.entries(this.inputs)) { input.disabled = !form; input.value = form?.[key] ?? ''; }
    this.get('.concept-new').hidden = !!form; this.get('.concept-form-error').hidden = true;
    this.get('.concept-duplicate-confirm input').checked = !!this.session.allowDuplicate;
    this.drawDuplicates(); this.updateStatus();
  }
  drawDuplicates() {
    const form = this.session.form, box = this.get('.concept-duplicates'); box.replaceChildren();
    const duplicates = form ? sameNamedConcepts(this.allNodes(), form.label) : [];
    this.get('.concept-duplicate-confirm').hidden = !duplicates.length;
    if (!duplicates.length) return;
    box.append(element('p', '已有同名概念，可以直接复用：', 'note'));
    for (const node of duplicates) {
      const existing = this.referenced.includes(node.id);
      const reuse = action(existing ? '已在当前图中' : '复用「' + node.label + '」', () => {
        this.session.selected.add(node.id); this.session.form = null; this.showForm(); this.drawResults(); this.search.focus();
      });
      reuse.disabled = existing; reuse.title = node.description + '\n' + node.id;
      const row = element('div', undefined, 'concept-duplicate-row'); row.append(element('span', node.description), reuse); box.append(row);
    }
  }
  stage() {
    const form = this.session.form; if (!form) return;
    validateConcept(form);
    if (sameNamedConcepts(this.allNodes(), form.label).length && !this.session.allowDuplicate) throw new Error('请复用已有概念，或明确勾选同名新建。');
    this.session.candidates.push({ ...copy(form), label: form.label.trim() }); this.session.selected.add(form.id);
    this.session.form = null; this.showForm(); this.drawResults();
  }
  drawResults() {
    const list = this.get('.concept-results'); list.replaceChildren();
    for (const node of matchingConcepts(this.allNodes(), this.session.query)) {
      const label = element('label', undefined, 'choice'), input = element('input'); input.type = 'checkbox';
      const used = this.referenced.includes(node.id), fresh = this.session.candidates.some(item => item.id === node.id);
      input.disabled = used; input.checked = used || this.session.selected.has(node.id); input.setAttribute('aria-label', '引用 ' + node.label);
      input.onchange = () => { if (input.checked) this.session.selected.add(node.id); else this.session.selected.delete(node.id); this.drawPicked(); this.updateStatus(); };
      const text = element('span', node.label); text.append(element('small', node.description), element('small', node.id, 'concept-id'));
      label.append(input, text); if (used || fresh) label.append(element('span', used ? '已在当前图中' : '待新建', 'concept-badge'));
      list.append(label);
    }
    if (!list.childElementCount) list.append(element('p', '没有匹配概念', 'note'));
    this.get('.concept-new').textContent = this.session.query.trim() ? '＋ 新建「' + this.session.query.trim() + '」' : '＋ 新建概念';
    this.drawPicked(); this.updateStatus();
  }
  drawPicked() {
    const box = this.get('.concept-picked'); box.replaceChildren();
    for (const id of this.session.selected) {
      const node = this.allNodes().find(item => item.id === id);
      const chip = element('span', undefined, 'concept-chip'); chip.append(element('span', node.label));
      const remove = action('×', () => {
        this.session.selected.delete(id); this.session.candidates = this.session.candidates.filter(item => item.id !== id);
        this.drawResults(); this.drawDuplicates();
      });
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
    const creating = !commit?.definitionsSaved && (form || candidates.some(node => selected.has(node.id)));
    this.status((commit?.definitionsSaved || commit?.phase === 'apply-failed' ? '继续引用' : creating ? '创建并引用' : '添加节点') + (count ? `（${count}）` : ''), !!count && !commit?.blocked && !['saving', 'applying', 'done'].includes(commit?.phase));
  }
}

// 名词表只是统一定义草稿的编辑视图，不持有另一份节点数据。
export class GlossaryTable {
  constructor(container, { change, add, remove, locate }) {
    this.container = container; this.change = change; this.add = add; this.remove = remove; this.locate = locate;
    container.innerHTML = `<div class="glossary-heading"><div><h1>概念表 <span id="glossary-count"></span></h1><p>直接编辑单元格 · 所有分析图共用这些概念</p></div><button id="glossary-add">＋ 新增概念</button></div>
      <div class="glossary-tools"><input id="glossary-search" type="search" aria-label="搜索节点名词表" placeholder="搜索名称、ID 或定义…"><span>修改后 Ctrl S 保存</span></div>
      <div class="glossary-scroll"><table aria-label="统一节点名词表"><colgroup><col class="term-index"><col class="term-name"><col class="term-id"><col class="term-description"><col class="term-increase"><col class="term-actions"></colgroup><thead><tr><th scope="col">#</th><th scope="col">名称</th><th scope="col">稳定 ID</th><th scope="col">概念含义</th><th scope="col">增加方向</th><th scope="col">操作</th></tr></thead><tbody></tbody></table><div id="glossary-empty" hidden>没有匹配的概念</div><button id="glossary-add-row">＋ 新增一行</button></div>
      <div class="glossary-footer">名称、含义和增加方向必填。稳定 ID 不随改名变化；定义修改会被所有引用图层使用。</div>`;
    this.search = container.querySelector('#glossary-search');
    this.search.oninput = () => this.draw();
    for (const id of ['glossary-add', 'glossary-add-row']) container.querySelector('#' + id).onclick = add;
  }
  update(nodes, analyses, pending) {
    this.nodes = nodes; this.analyses = analyses; this.pending = pending;
    for (const id of ['glossary-add', 'glossary-add-row']) this.container.querySelector('#' + id).disabled = !!pending;
    this.draw();
  }
  draw() {
    const body = this.container.querySelector('tbody'); body.replaceChildren();
    const query = this.search.value.trim().toLowerCase();
    const matches = this.nodes.filter(node => [node.label, node.id, node.description, node.increaseMeaning].some(value => value.toLowerCase().includes(query)));
    this.container.querySelector('#glossary-count').textContent = `${matches.length} / ${this.nodes.length}`;
    this.container.querySelector('#glossary-empty').hidden = matches.length > 0;
    for (const node of matches) {
      const row = document.createElement('tr'); row.dataset.nodeId = node.id;
      const index = document.createElement('td'); index.className = 'row-index'; index.textContent = this.nodes.indexOf(node) + 1; row.append(index);
      for (const [key, label] of [['label', '名称'], ['id', '稳定 ID'], ['description', '概念含义'], ['increaseMeaning', '增加方向']]) {
        const cell = document.createElement('td');
        if (key === 'id') { const code = document.createElement('code'); code.textContent = node.id; code.title = '稳定 ID 只读'; cell.append(code); }
        else {
          const input = document.createElement(key === 'label' ? 'input' : 'textarea');
          input.value = node[key]; input.required = true; input.disabled = !!this.pending;
          input.setAttribute('aria-label', label + '：' + node.id); input.placeholder = label + '（必填）';
          if (key !== 'label') input.rows = 2;
          input.oninput = () => { input.setAttribute('aria-invalid', String(!input.value.trim())); this.change(node.id, key, input.value); };
          input.setAttribute('aria-invalid', String(!input.value.trim())); cell.append(input);
        }
        row.append(cell);
      }
      const actions = document.createElement('td'); actions.className = 'term-action-cell';
      const owners = this.analyses.filter(graph => graph.nodeIds.includes(node.id));
      const locate = document.createElement('button'); locate.textContent = '↗'; locate.title = owners.length ? '查看引用此概念的分析图' : '尚未被分析图引用'; locate.disabled = !owners.length || !!this.pending; locate.setAttribute('aria-label', '查看引用 ' + node.id); locate.onclick = () => this.locate(node.id);
      const remove = document.createElement('button'); remove.textContent = '−'; remove.setAttribute('aria-label', '删除概念 ' + node.id); remove.disabled = !!this.pending;
      remove.title = owners.length ? '已被 ' + owners.map(graph => graph.name).join('、') + ' 引用，删除时会检查引用' : '删除未引用概念';
      remove.onclick = () => this.remove(node.id);
      actions.append(locate, remove); row.append(actions); body.append(row);
    }
  }
  focusNode(id) {
    this.search.value = ''; this.draw();
    const row = [...this.container.querySelectorAll('tbody tr')].find(item => item.dataset.nodeId === id);
    row?.querySelector('input')?.focus(); row?.scrollIntoView({ block: 'nearest' });
  }
}
