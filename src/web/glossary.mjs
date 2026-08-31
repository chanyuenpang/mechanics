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
