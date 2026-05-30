// Project management for OpenSCAD Polygon Editor.
// Single-file script (no module) — exposes window.ProjectAPI.
//
// Storage model (v4 — single-file .oscad):
//   - localStorage (key osped-projects-v1) is the synchronous index AND the
//     source of truth for UI reads. Survives any browser / mode.
//   - File System Access API (Chrome / Edge) optionally writes each project as
//     a *single* `.oscad` file (one FileSystemFileHandle per project).
//     Handles persisted in IndexedDB under db osped-fs / store handles, keyed
//     by project id. Each .oscad file holds the ENTIRE project as JSON:
//       { schema: 'oscad-v1', name, code, components, createdAt, updatedAt }
//   - Old multi-file directory mode (v3) is gone. Any old root-handle in IDB
//     is cleared on startup so the UI doesn't reference it.
//   - Session components live in memory only.

(function () {
  'use strict';

  console.log('[project] LOADED v4-single-file-oscad');

  const STORE_KEY = 'osped-projects-v1';
  const SAVE_DEBOUNCE_MS = 500;
  const FS_DB_NAME = 'osped-fs';
  const FS_DB_STORE = 'handles';
  const FS_LEGACY_ROOT_KEY = 'root-handle';   // v3 cleanup
  const OSCAD_SCHEMA = 'oscad-v1';

  const state = {
    projects: {},
    activeId: null,
    sessionComponents: [],
    currentScope: 'project',
  };

  // ---------- Utilities ----------
  function uuid() {
    return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function now() { return Date.now(); }
  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }
  function $(s) { return document.querySelector(s); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sanitizeName(name) {
    let s = String(name || '').trim();
    s = s.replace(/[\/\\:*?"<>|]/g, '_');
    s = s.replace(/\.+$/g, '_');
    s = s.replace(/^\.+/g, '_');
    return s || 'untitled';
  }
  function describeErr(err) {
    if (!err) return '未知错误';
    if (err.name === 'AbortError') return '用户取消';
    return err.message || String(err);
  }

  // ---------- IndexedDB micro-helper (for FileSystemFileHandle persistence) ----------
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(FS_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(FS_DB_STORE);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FS_DB_STORE, 'readonly');
      const g = tx.objectStore(FS_DB_STORE).get(key);
      g.onsuccess = () => resolve(g.result);
      g.onerror = () => reject(g.error);
    });
  }
  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FS_DB_STORE, 'readwrite');
      tx.objectStore(FS_DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDelete(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FS_DB_STORE, 'readwrite');
      tx.objectStore(FS_DB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbKeys() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FS_DB_STORE, 'readonly');
      const req = tx.objectStore(FS_DB_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------- File-handle backend ----------
  // Each project may have at most one FileSystemFileHandle (its .oscad file).
  // Handles live only in memory + IndexedDB (cannot serialize to localStorage).
  //
  // `available` only tells us whether we can pick a write-through file handle.
  // Browsers without the FSA API (Safari / Firefox) still get a working
  // Save/Open via download + file-input fallback handled in the UI layer.
  const backend = {
    available: typeof window !== 'undefined' &&
               typeof window.showSaveFilePicker === 'function' &&
               typeof window.showOpenFilePicker === 'function' &&
               typeof indexedDB !== 'undefined',
    handles: Object.create(null), // projectId -> FileSystemFileHandle

    async init() {
      // v3 cleanup: drop the old root-directory handle from IDB so nothing
      // tries to use it.
      try { await idbDelete(FS_LEGACY_ROOT_KEY); } catch { /* ignore */ }
      if (!this.available) return;
      try {
        const keys = await idbKeys();
        for (const k of keys) {
          if (k === FS_LEGACY_ROOT_KEY) continue;
          const h = await idbGet(k);
          if (h && typeof h.getFile === 'function') this.handles[k] = h;
        }
      } catch (err) {
        console.warn('[fs] handle restore failed', err);
      }
    },

    hasHandle(projectId) { return !!this.handles[projectId]; },

    fileNameFor(projectId) {
      const h = this.handles[projectId];
      return h ? h.name : null;
    },

    async ensurePermission(handle, mode = 'readwrite') {
      if (!handle || typeof handle.queryPermission !== 'function') return true;
      const cur = await handle.queryPermission({ mode });
      if (cur === 'granted') return true;
      const next = await handle.requestPermission({ mode });
      return next === 'granted';
    },

    async writeJson(handle, payload) {
      if (!(await this.ensurePermission(handle, 'readwrite'))) {
        throw new Error('文件系统权限被拒绝');
      }
      const w = await handle.createWritable();
      await w.write(JSON.stringify(payload, null, 2));
      await w.close();
    },

    async readJson(handle) {
      if (!(await this.ensurePermission(handle, 'read'))) {
        throw new Error('文件系统权限被拒绝');
      }
      const file = await handle.getFile();
      const text = await file.text();
      let data;
      try { data = JSON.parse(text); }
      catch (err) { throw new Error('文件不是合法 JSON：' + describeErr(err)); }
      if (!data || data.schema !== OSCAD_SCHEMA) {
        // Be lenient: accept files that look like an exported project even
        // without the schema tag (matches v3 export format).
        if (!data || typeof data.name !== 'string') {
          throw new Error('不是有效的 .oscad 文件（缺少 schema/name 字段）');
        }
      }
      return data;
    },

    async saveActive(projectId, p) {
      const h = this.handles[projectId];
      if (!h) throw new Error('未绑定文件，请先「另存为…」');
      await this.writeJson(h, buildOscadPayload(p));
    },

    async saveAsActive(p) {
      if (!this.available) throw new Error('当前浏览器不支持文件系统访问 API');
      const suggested = (p.fileName) || (sanitizeName(p.name) + '.oscad');
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'OpenSCAD 项目 (.oscad)', accept: { 'application/json': ['.oscad'] } }],
      });
      // Assign handle BEFORE writing so a second click during the in-flight
      // write sees it already bound.
      this.handles[p.id] = handle;
      try { await idbSet(p.id, handle); }
      catch (err) { console.warn('[fs] persist handle failed', err); }
      await this.writeJson(handle, buildOscadPayload(p));
      return handle.name;
    },

    async openOscad() {
      if (!this.available) throw new Error('当前浏览器不支持文件系统访问 API');
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'OpenSCAD 项目 (.oscad)', accept: { 'application/json': ['.oscad', '.json'] } }],
      });
      if (!handle) return null;
      const data = await this.readJson(handle);
      return { handle, data };
    },

    async forgetHandle(projectId) {
      delete this.handles[projectId];
      try { await idbDelete(projectId); } catch { /* ignore */ }
    },
  };

  function buildOscadPayload(p) {
    return {
      schema: OSCAD_SCHEMA,
      name: p.name,
      code: p.code || '',
      components: Array.isArray(p.components) ? p.components : [],
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  // Fire-and-forget wrapper.
  function fsRun(label, fn) {
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        console.error('[fs]', label, err);
        if (err && err.name !== 'AbortError') {
          alert(`磁盘写入失败 (${label}): ${describeErr(err)}\n数据仍保留在浏览器存储中。`);
        }
      });
  }

  // ---------- localStorage index ----------
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        state.projects = (data.projects && typeof data.projects === 'object') ? data.projects : {};
        state.activeId = data.activeId || null;
        if (state.activeId && !state.projects[state.activeId]) state.activeId = null;
        for (const id of Object.keys(state.projects)) {
          const p = state.projects[id];
          if (!p || typeof p !== 'object') { delete state.projects[id]; continue; }
          p.id = id;
          p.name = p.name || '未命名项目';
          p.code = typeof p.code === 'string' ? p.code : '';
          p.components = Array.isArray(p.components) ? p.components : [];
          p.createdAt = p.createdAt || now();
          p.updatedAt = p.updatedAt || p.createdAt;
          // fileName remembers the last .oscad filename used for Save/SaveAs.
          // In FSA mode this stays in sync with the bound handle; in fallback
          // (download) mode it's the only source of truth for the next Save.
          p.fileName = typeof p.fileName === 'string' && p.fileName ? p.fileName : null;
          p.dirty = false; // we'll flip true when user edits
        }
      }
    } catch (err) {
      console.error('[project] load failed', err);
      alert('读取项目存储失败：' + describeErr(err) + '\n将以空状态启动。');
      state.projects = {};
      state.activeId = null;
    }
  }
  function persist() {
    try {
      // Strip non-persistable fields (dirty is in-memory).
      const projs = {};
      for (const [id, p] of Object.entries(state.projects)) {
        projs[id] = {
          id: p.id, name: p.name, code: p.code, components: p.components,
          createdAt: p.createdAt, updatedAt: p.updatedAt,
          fileName: p.fileName || null,
        };
      }
      const json = JSON.stringify({ projects: projs, activeId: state.activeId });
      localStorage.setItem(STORE_KEY, json);
      const kb = Math.round(json.length / 1024);
      if (kb > 4000) {
        console.warn('[project] storage size approaching localStorage limit:', kb + 'KB');
      }
    } catch (err) {
      console.error('[project] persist failed', err);
      alert('保存到浏览器存储失败：' + describeErr(err));
    }
  }

  function markDirty(p) {
    if (!p) return;
    p.dirty = true;
    renderStorageLabel();
  }
  function markClean(p) {
    if (!p) return;
    p.dirty = false;
    renderStorageLabel();
  }

  // ---------- Project CRUD (sync — operates on in-memory + localStorage) ----------
  function listProjects() {
    return Object.values(state.projects).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  function getActive() {
    return state.activeId ? state.projects[state.activeId] : null;
  }

  function _createProjectSync(name) {
    const id = uuid();
    state.projects[id] = {
      id,
      name: (name || '').trim() || '未命名项目',
      code: '',
      components: [],
      createdAt: now(),
      updatedAt: now(),
      fileName: null,
      dirty: true, // brand-new project has no on-disk file yet
    };
    state.activeId = id;
    persist();
    return state.projects[id];
  }

  function createProject(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('项目名称不能为空');
    return _createProjectSync(trimmed);
  }

  function renameProject(id, name) {
    const p = state.projects[id];
    if (!p) return;
    const t = (name || '').trim();
    if (!t || t === p.name) return;
    p.name = t;
    p.updatedAt = now();
    markDirty(p); // disk file's `name` field is now stale until saved
    persist();
  }

  // "Close" = drop the project from the in-memory list (and forget its file
  // handle), but DO NOT delete the .oscad file on disk. Mirrors an IDE's
  // "close file" semantics: the user's data stays safe.
  function closeProject(id) {
    const p = state.projects[id];
    if (!p) return;
    delete state.projects[id];
    if (state.activeId === id) {
      const remaining = Object.keys(state.projects);
      state.activeId = remaining.length ? remaining[0] : null;
    }
    persist();
    if (backend.hasHandle(id)) fsRun('forgetHandle', () => backend.forgetHandle(id));
  }

  function setActive(id) {
    if (id == null || id === '') { state.activeId = null; persist(); return; }
    if (!state.projects[id]) return;
    state.activeId = id;
    persist();
  }

  // Download-as-blob fallback (works in Firefox / Safari too).
  function exportProject(id) {
    const p = state.projects[id];
    if (!p) return null;
    return new Blob([JSON.stringify(buildOscadPayload(p), null, 2)], { type: 'application/json' });
  }

  // Programmatic download of a .oscad blob with a chosen filename. Used as
  // the Save/SaveAs fallback for browsers without the File System Access API.
  function triggerOscadDownload(blob, fileName) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  // Ensure the user-typed name has a single .oscad extension.
  function ensureOscadExt(name) {
    let s = sanitizeName(name);
    if (!/\.oscad$/i.test(s)) s += '.oscad';
    return s;
  }

  function importProjectFromObject(data, opts = {}) {
    if (!data || typeof data !== 'object' || !data.name) {
      throw new Error('项目文件格式错误（缺少 name 字段）');
    }
    const existingNames = new Set(Object.values(state.projects).map((p) => p.name));
    let candidate = String(data.name);
    let n = 1;
    while (existingNames.has(candidate)) { candidate = `${data.name} (${++n})`; }
    const id = uuid();
    const p = {
      id,
      name: candidate,
      code: typeof data.code === 'string' ? data.code : '',
      components: Array.isArray(data.components) ? data.components : [],
      createdAt: data.createdAt || now(),
      updatedAt: data.updatedAt || now(),
      fileName: opts.fileName || (sanitizeName(candidate) + '.oscad'),
      dirty: !!opts.dirty, // false when bound via FSA, true for download import
    };
    state.projects[id] = p;
    state.activeId = id;
    persist();
    return p;
  }

  function importProject(text, opts = {}) {
    let data;
    try { data = JSON.parse(text); }
    catch (err) { throw new Error('无效的 JSON 文件'); }
    return importProjectFromObject(data, { ...opts, dirty: opts.dirty ?? true });
  }

  // ---------- Components ----------
  function listComponents(scope) {
    if (scope === 'session') return state.sessionComponents.slice();
    const p = getActive();
    return p ? p.components.slice() : [];
  }
  function saveComponent({ name, scope, code }) {
    const c = {
      id: uuid(),
      name: (name || '').trim() || '未命名组件',
      code: code || '',
      createdAt: now(),
    };
    if (scope === 'session') {
      state.sessionComponents.push(c);
      return c;
    }
    const p = getActive();
    if (!p) return null;
    p.components.push(c);
    p.updatedAt = now();
    markDirty(p);
    persist();
    saveSnapshotImmediate();
    return c;
  }
  function deleteComponent(scope, id) {
    if (scope === 'session') {
      state.sessionComponents = state.sessionComponents.filter((c) => c.id !== id);
      return;
    }
    const p = getActive();
    if (!p) return;
    p.components = p.components.filter((c) => c.id !== id);
    p.updatedAt = now();
    markDirty(p);
    persist();
    saveSnapshotImmediate();
  }
  function getComponent(scope, id) {
    return listComponents(scope).find((c) => c.id === id) || null;
  }

  // ---------- Auto-save snapshot ----------
  // On every edit: update in-memory + localStorage immediately, then (if a
  // file handle is bound) flush to the .oscad file in the background.
  function saveSnapshotCore() {
    try {
      const p = getActive(); if (!p) return;
      const ta = $('#exportArea'); if (!ta) return;
      const code = ta.value;
      if (p.code === code) return;
      p.code = code;
      p.updatedAt = now();
      markDirty(p);
      persist();
      if (backend.hasHandle(p.id)) {
        fsRun('saveActive', async () => {
          await backend.saveActive(p.id, p);
          markClean(p);
        });
      }
    } catch (err) {
      console.error('[project] saveSnapshot failed', err);
      alert('自动保存失败：' + describeErr(err));
    }
  }
  const saveSnapshot = debounce(saveSnapshotCore, SAVE_DEBOUNCE_MS);
  // Used by component add/remove paths that want to flush without waiting
  // for the debounce window.
  function saveSnapshotImmediate() {
    const p = getActive(); if (!p) return;
    persist();
    if (backend.hasHandle(p.id)) {
      fsRun('saveActive', async () => {
        await backend.saveActive(p.id, p);
        markClean(p);
      });
    }
  }

  // Synchronously copy whatever's in the textarea right now into p.code +
  // localStorage, bypassing the 500ms debounce. Manual Save / SaveAs /
  // Export OBJ paths call this FIRST so a click made within the debounce
  // window of the user's last keystroke still writes the latest content
  // (instead of the stale snapshot that saveSnapshot hadn't flushed yet).
  function flushPendingEdits() {
    const p = getActive(); if (!p) return;
    const ta = $('#exportArea'); if (!ta) return;
    const code = ta.value;
    if (p.code === code) return;
    p.code = code;
    p.updatedAt = now();
    markDirty(p);
    persist();
    console.log('[project] flushPendingEdits: synced textarea to p.code', code.length, 'chars');
  }

  // ---------- UI rendering ----------
  // True when the page is served from a non-secure context that the FSA spec
  // refuses to expose its picker functions on — typically file://. http://localhost
  // and https are both fine. We only set the warning when this is the *reason*
  // FSA is unavailable; on Safari/Firefox served via http we just show the
  // regular fallback label (no scary "环境错误" text).
  function isFileProtocol() {
    try { return typeof window !== 'undefined' && window.location && window.location.protocol === 'file:'; }
    catch { return false; }
  }

  function renderStorageLabel() {
    const el = $('#projectStorageLabel');
    const saveBtn = $('#projectSaveBtn');
    const p = getActive();
    if (!el) return;
    // Reset any prior warning styling each render so the class doesn't stick
    // when the user later switches to a project that doesn't need it.
    el.classList.remove('storage-warning');
    if (!p) {
      el.textContent = '📁 未选定项目';
      if (saveBtn) saveBtn.classList.remove('save-dirty');
      return;
    }
    const fileName = backend.fileNameFor(p.id) || p.fileName;
    if (backend.hasHandle(p.id)) {
      // FSA mode: writes go through the handle, so "保存" overwrites the file.
      el.textContent = `📄 ${fileName || (sanitizeName(p.name) + '.oscad')}${p.dirty ? ' ✱' : ''}`;
    } else if (fileName) {
      // Fallback (download) mode: filename is remembered, but each Save
      // re-downloads (browser API can't write back to an arbitrary path).
      el.textContent = `💾 ${fileName}${p.dirty ? ' ✱' : ''}${backend.available ? '' : '（下载模式）'}`;
    } else {
      el.textContent = backend.available
        ? '📝 未保存（点击「保存」或「另存为…」落盘）'
        : '📝 未保存（点击「保存」会下载 .oscad；当前浏览器不支持磁盘直接覆盖）';
    }

    // Loud warning when running from file:// — that's the #1 reason a Chrome
    // user sees Save fall back to download instead of overwrite. localStorage
    // also bites here (different "origin" per file URL on some browsers).
    if (!backend.available && isFileProtocol()) {
      el.classList.add('storage-warning');
      el.textContent =
        '⚠ 通过 file:// 打开 —— File System Access API 被禁用，「保存」会下载新副本而不是覆盖原文件。'
        + '\n请在项目目录下执行 `python3 -m http.server` 后访问 http://localhost:8000/index.html 获得完整保存功能。';
    }

    // Mirror the dirty state onto the Save button itself so the user sees a
    // clear "click me" highlight, not just the small ✱ in the label.
    if (saveBtn) saveBtn.classList.toggle('save-dirty', !!p.dirty && !saveBtn.disabled);
  }

  function renderProjectSwitcher() {
    const sel = $('#projectSelect');
    const nameEl = $('#projectActiveName');
    const projects = listProjects();
    const active = getActive();
    if (sel) {
      sel.innerHTML = '';
      if (!projects.length) {
        const opt = document.createElement('option');
        opt.value = ''; opt.textContent = '— 尚无项目 —';
        sel.appendChild(opt);
      }
      for (const p of projects) {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.name;
        sel.appendChild(opt);
      }
      sel.value = active ? active.id : '';
    }
    if (nameEl) nameEl.textContent = active ? active.name : '—';
    const hasActive = !!active;
    for (const id of ['projectRenameBtn', 'projectCloseBtn', 'projectExportBtn',
                      'projectSaveBtn', 'projectSaveAsBtn']) {
      const b = $('#' + id);
      if (b) b.disabled = !hasActive;
    }
    // Open button: always available — FSA mode picks a file, fallback mode
    // routes to the existing hidden <input type="file"> import flow.
    const openBtn = $('#projectOpenBtn');
    if (openBtn) openBtn.disabled = false;
    // Fallback browsers (Safari / Firefox): append a one-line note to each
    // FSA-affected title so users see why the behavior differs. We append
    // instead of replacing so the precise HTML-authored description stays.
    if (!backend.available) {
      const NOTE = '\n（当前浏览器不支持文件系统访问 API，会回退为下载/文件选择器）';
      for (const id of ['projectOpenBtn', 'projectSaveBtn', 'projectSaveAsBtn']) {
        const b = $('#' + id);
        if (b && !b.title.endsWith(NOTE)) b.title += NOTE;
      }
    }
    updateEmptyOverlay();
    renderStorageLabel();
  }

  function updateEmptyOverlay() {
    const overlay = $('#projectEmptyOverlay');
    if (overlay) overlay.hidden = true;
    const toolbox = $('#toolbox');
    if (toolbox) toolbox.removeAttribute('data-no-project');
    const cs = $('#componentSection');
    if (cs) cs.hidden = false;
  }

  function renderComponentList() {
    const ul = $('#componentList'); if (!ul) return;
    ul.innerHTML = '';
    const items = listComponents(state.currentScope);
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'component-empty';
      li.textContent = state.currentScope === 'session'
        ? '暂无临时组件 — 选中物体后点击「保存为组件」'
        : '暂无项目组件 — 选中物体后点击「保存为组件」';
      ul.appendChild(li);
      return;
    }
    for (const c of items) {
      const li = document.createElement('li');
      li.className = 'component-row';
      li.dataset.id = c.id;
      const safeName = escapeHtml(c.name);
      li.innerHTML = `
        <span class="component-name" title="${safeName}">${safeName}</span>
        <button type="button" class="insert-btn" data-id="${c.id}" title="插入到场景">插入</button>
        <button type="button" class="component-delete-btn" data-id="${c.id}" title="删除组件">×</button>
      `;
      ul.appendChild(li);
    }
  }

  function setActiveTab(scope) {
    state.currentScope = scope;
    document.querySelectorAll('.component-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.scope === scope);
    });
    renderComponentList();
  }

  function loadActiveIntoEditor() {
    try {
      const p = getActive();
      const ta = $('#exportArea'); if (!ta) return;
      try { window.AstAPI?.clearSelection?.(); } catch { /* ignore */ }
      ta.value = p ? (p.code || '') : '';
      ta.dispatchEvent(new Event('input'));
    } catch (err) {
      console.error('[project] loadActiveIntoEditor failed', err);
      alert('加载项目内容失败：' + describeErr(err));
    }
  }

  // ---------- UI events ----------
  function promptName(message, def) {
    const v = window.prompt(message, def || '');
    if (v == null) return null;
    const t = v.trim();
    return t || null;
  }
  function pickScope() {
    const yes = window.confirm('保存到「项目组件」吗？\n确定 = 项目组件（随项目持久化）\n取消 = 临时组件（刷新即丢）');
    return yes ? 'project' : 'session';
  }

  function refreshAllUI() {
    try { loadActiveIntoEditor(); } catch (e) { console.error('[project] refresh: load', e); }
    try { renderProjectSwitcher(); } catch (e) { console.error('[project] refresh: switcher', e); }
    try { renderComponentList(); } catch (e) { console.error('[project] refresh: components', e); }
  }

  function bindUI() {
    $('#projectSelect')?.addEventListener('change', (e) => {
      const id = e.target.value;
      if (!id) return;
      setActive(id);
      loadActiveIntoEditor();
      renderProjectSwitcher();
      renderComponentList();
    });

    $('#projectNewBtn')?.addEventListener('click', () => {
      try {
        const name = promptName('请输入项目名称', '我的项目');
        if (!name) return;
        createProject(name);
        refreshAllUI();
      } catch (err) {
        console.error('[project] createProject failed', err);
        alert('创建项目失败：' + describeErr(err));
      }
    });

    let openInFlight = false;
    $('#projectOpenBtn')?.addEventListener('click', async () => {
      if (openInFlight) return;
      openInFlight = true;
      try {
        if (backend.available) {
          const result = await backend.openOscad();
          if (!result) return;
          const { handle, data } = result;
          // If a project with the same name already exists, dedupe — but for
          // open-file we treat it as "always create a fresh entry", because the
          // user might want to compare two saved copies.
          const p = importProjectFromObject(data, { fileName: handle.name, dirty: false });
          backend.handles[p.id] = handle;
          try { await idbSet(p.id, handle); }
          catch (err) { console.warn('[fs] persist handle', err); }
          persist();
          refreshAllUI();
        } else {
          // Fallback: route through the hidden <input type="file"> import flow.
          // The change handler (#projectImportFile) will read the file and
          // populate p.fileName from the file's real name.
          $('#projectImportFile')?.click();
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error('[project] open failed', err);
          alert('打开 .oscad 失败：' + describeErr(err));
        }
      } finally {
        openInFlight = false;
      }
    });

    $('#projectSaveBtn')?.addEventListener('click', async () => {
      const p = getActive();
      if (!p) return;
      // Click-within-debounce-window → make sure we save the *latest* text.
      flushPendingEdits();
      try {
        if (backend.hasHandle(p.id)) {
          // FSA: write straight through the bound handle (true overwrite).
          await backend.saveActive(p.id, p);
          p.fileName = backend.fileNameFor(p.id) || p.fileName;
          markClean(p);
          persist();
        } else if (backend.available) {
          // FSA available but no bound handle yet → behave like Save As.
          await doSaveAs(p);
        } else if (p.fileName) {
          // Fallback (Safari / Firefox): re-download under the remembered name.
          doSaveDownload(p, p.fileName);
        } else {
          // First save in fallback mode: prompt for filename.
          await doSaveAs(p);
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error('[project] save failed', err);
          alert('保存失败：' + describeErr(err));
        }
      }
    });

    $('#projectSaveAsBtn')?.addEventListener('click', async () => {
      const p = getActive(); if (!p) return;
      flushPendingEdits();
      try { await doSaveAs(p); }
      catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error('[project] saveAs failed', err);
          alert('另存为失败：' + describeErr(err));
        }
      }
    });

    async function doSaveAs(p) {
      if (backend.available) {
        const writtenName = await backend.saveAsActive(p);
        p.fileName = writtenName;
        markClean(p);
        persist();
        renderProjectSwitcher();
        console.log('[project] saved as', writtenName);
        return;
      }
      // Fallback: prompt for a filename, then trigger a download.
      const def = p.fileName || (sanitizeName(p.name) + '.oscad');
      const raw = window.prompt('另存为 .oscad —— 请输入文件名：', def);
      if (raw == null) throw Object.assign(new Error('用户取消'), { name: 'AbortError' });
      const fname = ensureOscadExt(raw);
      doSaveDownload(p, fname);
    }

    function doSaveDownload(p, fileName) {
      const blob = exportProject(p.id);
      if (!blob) return;
      triggerOscadDownload(blob, fileName);
      p.fileName = fileName;
      markClean(p);
      persist();
      renderProjectSwitcher();
      console.log('[project] downloaded as', fileName);
    }

    $('#projectRenameBtn')?.addEventListener('click', () => {
      try {
        const p = getActive(); if (!p) return;
        const name = promptName('重命名项目', p.name);
        if (!name) return;
        renameProject(p.id, name);
        renderProjectSwitcher();
      } catch (err) {
        alert('重命名失败：' + describeErr(err));
      }
    });

    $('#projectCloseBtn')?.addEventListener('click', () => {
      try {
        const p = getActive(); if (!p) return;
        const hasFile = backend.hasHandle(p.id);
        const fname = backend.fileNameFor(p.id) || p.fileName;
        let warn;
        if (hasFile) {
          warn = `关闭项目「${p.name}」？\n磁盘上的 ${fname} 不会被删除，下次可以从「打开…」重新载入。`;
        } else if (fname) {
          warn = `关闭项目「${p.name}」？\n之前下载的 ${fname} 不会被删除，下次可以从「打开…」重新载入；浏览器内的临时副本会被清除。`;
        } else {
          warn = `关闭项目「${p.name}」？\n该项目尚未保存到 .oscad 文件，关闭后浏览器内的副本也会被清除。`;
        }
        if (!window.confirm(warn)) return;
        closeProject(p.id);
        loadActiveIntoEditor();
        renderProjectSwitcher();
        renderComponentList();
      } catch (err) {
        alert('关闭失败：' + describeErr(err));
      }
    });

    $('#projectExportBtn')?.addEventListener('click', () => {
      try {
        const p = getActive(); if (!p) return;
        flushPendingEdits();
        const blob = exportProject(p.id);
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${sanitizeName(p.name)}.oscad`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
      } catch (err) {
        alert('导出失败：' + describeErr(err));
      }
    });

    // The "Load copy" dedicated button was dropped in favor of 打开… (which
    // covers the same intent in fallback mode and is the conventional name
    // FSA-mode users expect). The hidden file input is still here because
    // 打开 in fallback mode triggers its click().
    $('#projectImportFile')?.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        // Remember the picked filename so the next Save (download fallback)
        // writes back under the same name.
        const fname = f.name || null;
        importProject(text, { fileName: fname, dirty: false });
        refreshAllUI();
      } catch (err) {
        alert('导入失败：' + describeErr(err));
      }
      e.target.value = '';
    });

    document.querySelectorAll('.component-tab').forEach((btn) => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.scope));
    });

    $('#componentList')?.addEventListener('click', (e) => {
      const insertBtn = e.target.closest('.insert-btn');
      const deleteBtn = e.target.closest('.component-delete-btn');
      if (insertBtn) {
        const c = getComponent(state.currentScope, insertBtn.dataset.id);
        if (c && window.OspedAPI?.appendCode) {
          window.OspedAPI.appendCode(c.code);
        }
      } else if (deleteBtn) {
        if (!window.confirm('删除该组件？')) return;
        deleteComponent(state.currentScope, deleteBtn.dataset.id);
        renderComponentList();
      }
    });

    $('#saveAsComponentBtn')?.addEventListener('click', () => {
      try {
        if (!getActive()) { alert('请先创建或选择一个项目。'); return; }
        const code = window.AstAPI?.getSelectionCode?.();
        if (!code) {
          alert('请先在 3D 视图或场景树中选中至少一个物体。');
          return;
        }
        const defName = window.AstAPI?.getSelectionLabel?.() || '我的组件';
        const name = promptName('为组件命名', defName);
        if (!name) return;
        const scope = pickScope();
        const c = saveComponent({ name, scope, code });
        if (c) setActiveTab(scope);
      } catch (err) {
        alert('保存组件失败：' + describeErr(err));
      }
    });

    const ta = $('#exportArea');
    if (ta) ta.addEventListener('input', saveSnapshot);

    // Ctrl/Cmd+S → save
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        const tag = (e.target && e.target.tagName) || '';
        // Allow even when focus is in a textarea — that's the common save case.
        e.preventDefault();
        $('#projectSaveBtn')?.click();
      }
    });
  }

  async function init() {
    console.log('[project] init: start');
    const overlay = $('#projectEmptyOverlay');
    if (overlay) {
      overlay.hidden = true;
      overlay.style.display = 'none';
    }
    loadStore();
    console.log('[project] init: loadStore done, projects=' + Object.keys(state.projects).length + ', activeId=' + state.activeId);
    await backend.init();
    console.log('[project] init: backend ready, available=' + backend.available + ', handles=' + Object.keys(backend.handles).length);
    // Any handle in IDB whose project no longer exists in localStorage:
    // forget it so we don't leak.
    for (const id of Object.keys(backend.handles)) {
      if (!state.projects[id]) fsRun('forgetStaleHandle', () => backend.forgetHandle(id));
    }
    // Projects with a bound file start clean; unbound ones start dirty.
    for (const p of Object.values(state.projects)) {
      p.dirty = !backend.hasHandle(p.id);
    }
    bindUI();
    if (!Object.keys(state.projects).length) {
      _createProjectSync('我的项目');
      console.log('[project] init: auto-created default project');
    }
    if (!state.activeId && Object.keys(state.projects).length) {
      state.activeId = listProjects()[0].id;
      persist();
    }
    renderProjectSwitcher();
    renderComponentList();
    if (getActive()) {
      setTimeout(loadActiveIntoEditor, 0);
    }
    console.log('[project] init: done, active=' + getActive()?.name);
  }

  window.ProjectAPI = {
    listProjects, getActive, createProject, renameProject,
    closeProject, // replaces deleteProject (kept name change to clarify semantics)
    deleteProject: closeProject, // back-compat shim for any external code
    setActive,
    exportProject, importProject,
    listComponents, saveComponent, deleteComponent, getComponent,
    saveSnapshot,
    // Synchronously flush pending textarea edits into p.code + localStorage.
    // External callers (OBJ exporter etc.) call this before reading/serializing
    // so they always see the latest content rather than the pre-debounce snapshot.
    flushPendingEdits,
    // v4 introspection
    getStorageMode: () => backend.available ? 'fs-file' : 'localstorage',
    hasFileHandle: (id) => backend.hasHandle(id || state.activeId),
    getFileName:   (id) => backend.fileNameFor(id || state.activeId),
    _diagnose: () => {
      const info = {
        userAgent: navigator.userAgent,
        storageMode: backend.available ? 'fs-file' : 'localstorage',
        state: {
          projectCount: Object.keys(state.projects).length,
          projectNames: Object.values(state.projects).map((p) => p.name),
          activeId: state.activeId,
          activeName: getActive()?.name || null,
          activeDirty: getActive()?.dirty,
        },
        backend: {
          available: backend.available,
          handleIds: Object.keys(backend.handles),
        },
        localStorageRaw: (localStorage.getItem(STORE_KEY) || '').slice(0, 200) + '...',
      };
      console.log('[project] _diagnose:', info);
      return info;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init().catch((err) => console.error('[project] init', err)); });
  } else {
    init().catch((err) => console.error('[project] init', err));
  }
})();
