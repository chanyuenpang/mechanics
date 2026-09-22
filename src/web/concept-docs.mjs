const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };

// 导出接口成功时以服务端回读的 workspace 为准，避免页面其余写入继续使用旧 revision。
export function mergeDocumentExportResult(data, result, onWorkspace) {
  data.revision = result.revision;
  if (Array.isArray(result.manifest?.exportSelections)) data.selections = structuredClone(result.manifest.exportSelections);
  onWorkspace?.(result);
  return result.revision;
}

// 只把受限 Markdown 投影为 DOM；不接受导出文件中的 HTML、图片或任意文件 URL。
export class ConceptDocsPage {
  constructor(root, api, report, onWorkspace = null) { this.root = root; this.api = api; this.report = report; this.onWorkspace = onWorkspace; this.data = null; this.request = 0; }
  renderLoading(title, detail) {
    this.root.replaceChildren(); this.root.setAttribute('aria-busy', 'true');
    const article = document.createElement('article'); article.className = 'concept-doc-article';
    article.append(text('h1', title), text('p', detail, 'note')); this.root.append(article);
  }
  renderFailure(title, detail) {
    this.root.replaceChildren(); this.root.removeAttribute('aria-busy');
    const article = document.createElement('article'); article.className = 'concept-doc-article';
    article.append(text('h1', title), text('p', detail, 'note'));
    if (this.data) { const back = text('button', '返回已读取的文档', 'primary'); back.type = 'button'; back.onclick = () => this.render(); article.append(back); }
    this.root.append(article);
  }
  async open(selection = null) {
    const request = ++this.request;
    const query = typeof selection === 'string' ? '?conceptId=' + encodeURIComponent(selection)
      : selection?.file ? '?file=' + encodeURIComponent(selection.file) : '';
    this.renderLoading('正在读取已导出文档', '仅验证已发布的文档，不会扫描工作区。');
    try {
      const data = await this.api('/api/concept-docs' + query);
      if (request !== this.request) return;
      this.data = data; this.root.removeAttribute('aria-busy'); this.render();
    } catch (error) {
      if (request === this.request) this.renderFailure('文档读取失败', error.message);
      throw error;
    }
  }
  render() {
    const { document: currentDocument, concepts, documents } = this.data; this.root.replaceChildren();
    const tree = document.createElement('aside'); tree.className = 'concept-doc-tree';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索概念、ID 或别名'; tree.append(search);
    const list = document.createElement('div'); tree.append(list);
    const draw = () => { list.replaceChildren(); const query = search.value.trim().toLowerCase();
      const append = (label, selection = null, active = false) => { const item = text('button', label, active ? 'current' : ''); item.type = 'button'; item.onclick = () => this.open(selection).catch(this.report); list.append(item); };
      append('机制文档索引', null, currentDocument.kind === 'index');
      for (const document of documents.filter(item => !query || [item.id, item.label, item.scope].join(' ').toLowerCase().includes(query))) {
        const label = document.kind === 'folder' ? document.id : document.label;
        append(`${document.kind === 'folder' ? '▸ ' : document.kind === 'view' ? '◈ ' : ''}${label}`, { file: document.file }, currentDocument.file === document.file);
      }
      append('概念词典', { file: 'concepts.md' }, currentDocument.kind === 'concepts');
      if (query) for (const concept of concepts.filter(item => [item.id, item.label, ...item.aliases].join(' ').toLowerCase().includes(query))) {
        append('　' + concept.label, concept.id, concept.id === currentDocument.conceptId);
      }
    }; search.oninput = draw; draw();
    const settings = text('button', '导出设置', 'quiet concept-doc-export-settings'); settings.type = 'button';
    settings.onclick = () => this.openSettings().catch(this.report); tree.append(settings);
    const article = document.createElement('article'); article.className = 'concept-doc-article'; const outline = document.createElement('aside'); outline.className = 'concept-doc-outline';
    for (const line of currentDocument.markdown.split(/\r?\n/)) {
      const heading = /^(#{1,3})\s+(.+)$/.exec(line); if (heading) {
        const conceptHeading = /^(.*?) · `([a-z][a-z0-9-]*)`$/.exec(heading[2]);
        const title = conceptHeading?.[1] ?? heading[2];
        const h = text('h' + heading[1].length, title);
        if (conceptHeading) h.id = 'concept-' + conceptHeading[2];
        article.append(h); const link = text('button', title); link.type = 'button'; link.onclick = () => h.scrollIntoView({ block: 'start' }); outline.append(link); continue;
      }
      const item = /^-\s+(.+)$/.exec(line); const node = text(item ? 'li' : 'p', item?.[1] ?? line); if (line) article.append(node);
    }
    article.querySelectorAll('p,li').forEach(node => {
      const source = node.textContent;
      const links = [...source.matchAll(/\[([^\]]+)]\(([^)]+)\)/g)];
      if (!links.length) return;
      const content = []; let cursor = 0;
      for (const link of links) {
        const [raw, label, target] = link; const start = link.index ?? 0;
        if (start > cursor) content.push(document.createTextNode(source.slice(cursor, start)));
        const control = text('button', label, 'concept-doc-link'); control.type = 'button';
        control.onclick = () => {
          const [file, fragment] = target.split('#');
          if (file.endsWith('concepts.md') && /^concept-[a-z][a-z0-9-]*$/.test(fragment ?? '')) return this.open(fragment.slice('concept-'.length)).catch(this.report);
          const resolved = new URL(file || '.', 'https://catalog/' + currentDocument.file).pathname.slice(1);
          return this.open({ file: decodeURIComponent(resolved) }).catch(this.report);
        };
        content.push(control); cursor = start + raw.length;
      }
      if (cursor < source.length) content.push(document.createTextNode(source.slice(cursor)));
      node.replaceChildren(...content);
    });
    this.root.append(tree, article, outline);
    if (currentDocument.conceptId) article.querySelector('#concept-' + currentDocument.conceptId)?.scrollIntoView({ block: 'start' });
  }
  async openSettings(projectSessionToken = null) {
    const token = projectSessionToken ?? this.data?.projectSessionToken;
    if (!token) throw new Error('无法定位当前项目会话，不能读取导出设置。');
    this.renderLoading('正在读取已保存的导出设置', '此页面只使用本会话已读取的快照，不会扫描工作区。');
    try {
      const data = await this.api('/api/document-export/settings?projectSessionToken=' + encodeURIComponent(token));
      this.root.removeAttribute('aria-busy'); this.renderSettings(data, data.selections);
    } catch (error) {
      this.renderFailure('导出设置读取失败', error.message);
      throw error;
    }
  }
  renderStale(projectSessionToken) {
    this.root.replaceChildren();
    const article = document.createElement('article'); article.className = 'concept-doc-article';
    article.append(text('h1', '文档尚未生成'), text('p', '生成目录不存在、已被修改，或与当前机制资料不一致；因此不能读取旧文档。请在导出设置中生成文档。', 'note'));
    const settings = text('button', '打开导出设置', 'primary'); settings.type = 'button'; settings.onclick = () => this.openSettings(projectSessionToken).catch(this.report); article.append(settings);
    this.root.append(article);
  }
  renderPublishing(retry) {
    this.root.replaceChildren();
    const article = document.createElement('article'); article.className = 'concept-doc-article';
    article.append(text('h1', '正在生成文档'), text('p', '规则资料已保存，文档正在后台同步；完成后可直接打开。', 'note'));
    const refresh = text('button', '刷新文档', 'primary'); refresh.type = 'button'; refresh.onclick = () => retry().catch(this.report);
    article.append(refresh); this.root.append(article);
  }
  renderSettings(data, draft) {
    this.root.replaceChildren();
    const aside = document.createElement('aside'); aside.className = 'concept-doc-tree export-source-tree';
    const back = text('button', '返回文档', 'quiet'); back.type = 'button'; aside.append(back);
    const article = document.createElement('article'); article.className = 'concept-doc-article export-settings'; article.append(text('h1', '导出设置'));
    article.append(text('p', '选择文件夹会将其直接机制图合并为一篇文档；子文件夹不会递归包含。视图始终独立导出。', 'note'));
    const preview = document.createElement('section'); preview.className = 'export-preview';
    const summary = document.createElement('aside'); summary.className = 'concept-doc-outline export-summary';
    const selections = () => new Set(draft.map(item => item.kind === 'folder' ? `folder:${item.folder}` : item.kind === 'mechanic' ? `mechanic:${item.mechanicId}` : `view:${item.viewId}`));
    const selected = selections();
    const update = item => {
      const key = item.kind === 'folder' ? `folder:${item.folder}` : item.kind === 'mechanic' ? `mechanic:${item.mechanicId}` : `view:${item.viewId}`;
      draft = selected.has(key) ? draft.filter(candidate => (candidate.kind === 'folder' ? `folder:${candidate.folder}` : candidate.kind === 'mechanic' ? `mechanic:${candidate.mechanicId}` : `view:${candidate.viewId}`) !== key) : [...draft, item];
      this.exportSettingsScrollTop = aside.scrollTop;
      this.renderSettings(data, draft);
    };
    const toggleFolderMechanics = folder => {
      const members = data.mechanics.filter(mechanic => mechanic.folder === folder.path);
      const ids = new Set(members.map(mechanic => mechanic.id));
      const allSelected = members.length > 0 && members.every(mechanic => selected.has(`mechanic:${mechanic.id}`));
      draft = allSelected ? draft.filter(item => item.kind !== 'mechanic' || !ids.has(item.mechanicId))
        : [...draft.filter(item => item.kind !== 'mechanic' || !ids.has(item.mechanicId)), ...members.map(mechanic => ({ kind: 'mechanic', mechanicId: mechanic.id }))];
      this.exportSettingsScrollTop = aside.scrollTop;
      this.renderSettings(data, draft);
    };
    const addCheck = (parent, label, item, checked, disabled, reason = '', detail = '') => {
      const row = document.createElement('div'); row.className = 'document-export-choice';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = disabled; input.onchange = () => update(item);
      const copy = document.createElement('span'); copy.append(text('strong', label)); if (detail || reason) copy.append(text('small', reason || detail)); copy.onclick = () => { if (!input.disabled) input.click(); };
      row.append(input, copy); parent.append(row); return row;
    };
    const filter = document.createElement('input'); filter.type = 'search'; filter.placeholder = '搜索文件夹、机制图或视图'; aside.append(filter);
    const sourceList = document.createElement('div'); aside.append(sourceList);
    const drawSources = () => { sourceList.replaceChildren(); const query = filter.value.trim().toLowerCase();
      const matches = value => !query || value.toLowerCase().includes(query);
      const folders = data.folders.filter(folder => matches(folder.path));
      if (folders.length) sourceList.append(text('p', '机制文件夹', 'export-group-label'));
      for (const folder of folders) {
        const blocked = folder.mechanicIds.filter(id => selected.has(`mechanic:${id}`));
        const row = addCheck(sourceList, folder.path, { kind: 'folder', folder: folder.path }, selected.has(`folder:${folder.path}`), Boolean(blocked.length), blocked.length ? `已选择 ${blocked.length} 个直接机制图，不能聚合` : `聚合 ${folder.mechanicIds.length} 个直接机制图`);
        const members = data.mechanics.filter(mechanic => mechanic.folder === folder.path);
        const individual = document.createElement('input'); individual.type = 'checkbox'; individual.className = 'folder-individual-export'; individual.title = '单独生成此文件夹的直接机制图';
        individual.checked = members.length > 0 && members.every(mechanic => selected.has(`mechanic:${mechanic.id}`)); individual.disabled = selected.has(`folder:${folder.path}`);
        individual.onchange = event => { event.preventDefault(); toggleFolderMechanics(folder); };
        row.append(individual);
        const children = document.createElement('div'); children.className = 'export-tree-children';
        for (const id of folder.mechanicIds) { const mechanic = data.mechanics.find(item => item.id === id); if (mechanic && matches(mechanic.name)) addCheck(children, mechanic.name, { kind: 'mechanic', mechanicId: mechanic.id }, selected.has(`mechanic:${mechanic.id}`), selected.has(`folder:${folder.path}`), selected.has(`folder:${folder.path}`) ? `由文件夹 ${folder.path} 统一导出` : '单独导出为一篇文档'); }
        sourceList.append(children);
      }
      const rootMechanics = data.mechanics.filter(item => !item.folder && matches(item.name)); if (rootMechanics.length) sourceList.append(text('p', '未归类机制图', 'export-group-label'));
      for (const mechanic of rootMechanics) addCheck(sourceList, mechanic.name, { kind: 'mechanic', mechanicId: mechanic.id }, selected.has(`mechanic:${mechanic.id}`), false, '单独导出为一篇文档');
      const views = data.views.filter(item => matches(item.name)); if (views.length) sourceList.append(text('p', '视图（独立导出）', 'export-group-label'));
      for (const view of views) addCheck(sourceList, view.name, { kind: 'view', viewId: view.id }, selected.has(`view:${view.id}`), false, `包含 ${view.mechanicIds.length} 个可见机制图`);
    }; filter.oninput = drawSources; drawSources();
    const selectedItems = draft.map(item => item.kind === 'folder' ? `文件夹：${item.folder}` : item.kind === 'mechanic' ? `机制图：${data.mechanics.find(x => x.id === item.mechanicId)?.name ?? item.mechanicId}` : `视图：${data.views.find(x => x.id === item.viewId)?.name ?? item.viewId}`);
    preview.append(text('h2', '选择影响'));
    preview.append(text('p', selectedItems.length ? `当前范围会生成 ${selectedItems.length} 篇机制文档。` : '尚未选择导出范围；生成后不会包含规则正文。', 'note'));
    for (const item of selectedItems) preview.append(text('p', item, 'export-preview-item'));
    summary.append(text('h3', '当前范围'));
    summary.append(text('p', `${selectedItems.length} 篇文档`, 'export-count'));
    if (data.selectionMode === 'legacy-all') summary.append(text('p', '旧工作区仍沿用全量逐图导出；保存后才切换为当前选择。', 'note'));
    const dirty = JSON.stringify(draft) !== JSON.stringify(data.selections);
    if (dirty) summary.append(text('p', '有未保存的更改', 'export-dirty'));
    back.onclick = () => { if (!dirty || confirm('放弃未保存的导出选择？')) this.render(); };
    const actions = document.createElement('div'); actions.className = 'export-actions'; const cancel = text('button', '恢复已保存设置'); cancel.type = 'button'; cancel.onclick = () => this.renderSettings(data, structuredClone(data.selections));
    const save = text('button', '保存设置'); save.type = 'button'; save.disabled = !dirty; save.onclick = async () => {
      save.disabled = true;
      try {
        const saved = await this.api('/api/document-export/settings', { revision: data.revision, selections: draft, projectSessionToken: data.projectSessionToken, projectGeneration: data.projectGeneration });
        mergeDocumentExportResult(data, saved, this.onWorkspace); this.renderSettings(data, structuredClone(data.selections));
      } catch (error) { save.disabled = false; this.report(error); }
    };
    const generate = text('button', '生成文档', 'primary'); generate.type = 'button'; generate.onclick = async () => {
      generate.disabled = true; save.disabled = true;
      try {
        let revision = data.revision;
        if (dirty) {
          if (!confirm('生成文档前将先保存当前导出设置。是否继续？')) return;
          const saved = await this.api('/api/document-export/settings', { revision: data.revision, selections: draft, projectSessionToken: data.projectSessionToken, projectGeneration: data.projectGeneration });
          revision = mergeDocumentExportResult(data, saved, this.onWorkspace);
        }
        const generated = await this.api('/api/document-export/generate', { revision, projectSessionToken: data.projectSessionToken, projectGeneration: data.projectGeneration });
        mergeDocumentExportResult(data, generated, this.onWorkspace);
        if (generated.exportPublication?.state === 'pending') {
          const retry = async () => {
            const workspace = await this.api('/api/workspace');
            if (workspace.exportPublication?.state === 'pending') return this.renderPublishing(retry);
            return this.open();
          };
          this.renderPublishing(retry);
        }
        else await this.open();
      } catch (error) { this.report(error); }
      finally { generate.disabled = false; save.disabled = !dirty; }
    }; actions.append(cancel, save, generate); summary.append(actions); this.root.append(aside, article, preview, summary);
    if (this.exportSettingsScrollTop) requestAnimationFrame(() => { aside.scrollTop = this.exportSettingsScrollTop; });
  }
}
