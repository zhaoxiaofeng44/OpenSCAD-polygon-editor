(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const state = {
    gridSize: 8,
    subGridSize: 8,
    zoom: 1,
    snap: true,
    paths: [],
    currentPath: 0,
    drag: -1,
    dragType: 0,
    selectedIdx: -1,
    oldExportStr: '',
    history: [],
    historyIndex: -1,
    historyLimit: 100,
    suppressExport: false,
  };

  let drawWidth, drawHeight, centerX, centerY;
  let drawArea, gridMinor, gridMajor, axes;
  let tools = {};

  const changeListeners = [];
  const pathSelectListeners = [];
  let suppressPathSelectEmit = false;
  function emitPathSelected(idx) {
    if (suppressPathSelectEmit) return;
    for (const fn of pathSelectListeners) {
      try { fn(idx); } catch (e) { console.error(e); }
    }
  }
  window.OspedAPI = {
    getPaths: () =>
      state.paths.map((p) => ({
        points: p.points.map((pt) => ({
          x: pt.x, y: pt.y, type: pt.type,
          prevCP: { ...pt.prevCP }, nextCP: { ...pt.nextCP },
        })),
        prefix: p.prefix,
        postfix: p.postfix,
      })),
    getCode: () => {
      const ta = document.querySelector('#exportArea');
      return ta ? ta.value : '';
    },
    appendCode: (snippet) => {
      const ta = document.querySelector('#exportArea');
      if (!ta) return;
      const sep = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
      ta.value = ta.value + sep + snippet + (snippet.endsWith('\n') ? '' : '\n');
      ta.dispatchEvent(new Event('input'));
    },
    onChange: (fn) => { changeListeners.push(fn); },
    forceRefresh: () => emitPathsChanged(),
    resize2D: () => handleResize(),
    selectPath: (idx, opts = {}) => {
      const lb = document.querySelector('#pathListbox');
      if (!lb) return;
      const maxPolyIdx = lb.options.length - 1; // last entry is [New]
      if (idx < 0 || idx >= maxPolyIdx) return;
      if (opts.silent) suppressPathSelectEmit = true;
      // Always update selectedIndex + dispatch change so the change handler
      // re-creates vertex boxes (needed when the 2D area was previously hidden).
      lb.selectedIndex = idx;
      lb.dispatchEvent(new Event('change'));
      suppressPathSelectEmit = false;
      if (opts.activateEdit !== false) {
        const editBtn = document.querySelector('#editToolSource');
        if (editBtn) editBtn.click();
      }
      updateEditingBadge(idx);
    },
    refresh: () => {
      handleResize();
    },
    onPathSelected: (fn) => { pathSelectListeners.push(fn); },
    getCurrentPathIndex: () => state.currentPath,
  };
  function updateEditingBadge(idx) {
    const badge = document.querySelector('#editingBadge');
    const badgeIdx = document.querySelector('#editingBadgeIdx');
    if (!badge || !badgeIdx) return;
    const lb = document.querySelector('#pathListbox');
    if (!lb) return;
    const maxPolyIdx = lb.options.length - 1;
    if (idx >= 0 && idx < maxPolyIdx) {
      badgeIdx.textContent = String(idx + 1);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }
  function emitPathsChanged() {
    for (const fn of changeListeners) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    setupDrawArea();
    setupTools();
    setupPanelEvents();
    setupKeyboard();
    setupDrawAreaEvents();
    setupTheme();
    setSelectedTool(tools.edit);

    // Fire input event so any pre-filled text is parsed
    $('#exportArea').dispatchEvent(new Event('input'));
    if ($('#traceImageURL').value) $('#traceImageURL').dispatchEvent(new Event('input'));
    updateUndoRedoButtons();
  }

  // ---------- Draw area ----------

  function setupDrawArea() {
    const das = $('#drawAreaSource');
    // Fallback to a sensible default if the area is hidden (display:none).
    // The Raphael paper needs a non-zero canvas — handleResize() resizes it
    // properly once the area becomes visible.
    drawWidth = das.clientWidth || 500;
    drawHeight = das.clientHeight || 500;

    const unit = state.gridSize * state.subGridSize * 2;
    drawWidth -= drawWidth % unit;
    drawHeight -= drawHeight % unit;

    centerX = drawWidth / 2;
    centerY = drawHeight / 2;

    drawArea = Raphael('drawAreaSource', drawWidth + 1, drawHeight + 1);
    drawGrid();

    window.addEventListener('resize', debounce(handleResize, 200));
  }

  function drawGrid() {
    if (gridMinor) gridMinor.remove();
    if (gridMajor) gridMajor.remove();
    if (axes) axes.remove();

    const g = state.gridSize;
    const sub = state.subGridSize;
    let minorStr = '';
    for (let x = 0; x < drawWidth + 1; x += g)
      minorStr += 'M' + (x + 0.5) + ',0L' + (x + 0.5) + ',' + (drawHeight + 1);
    for (let y = 0; y < drawHeight + 1; y += g)
      minorStr += 'M0,' + (y + 0.5) + 'L' + (drawWidth + 1) + ',' + (y + 0.5);
    gridMinor = drawArea.path(minorStr).attr('stroke', getCSSVar('--grid-minor'));

    let majorStr = '';
    for (let x = 0; x < drawWidth + 1; x += g * sub)
      majorStr += 'M' + (x + 0.5) + ',0L' + (x + 0.5) + ',' + (drawHeight + 1);
    for (let y = 0; y < drawHeight + 1; y += g * sub)
      majorStr += 'M0,' + (y + 0.5) + 'L' + (drawWidth + 1) + ',' + (y + 0.5);
    gridMajor = drawArea.path(majorStr).attr('stroke', getCSSVar('--grid-major'));

    axes = drawArea
      .path(
        'M0,' + (centerY + 0.5) + 'L' + (drawWidth + 1) + ',' + (centerY + 0.5) +
        'M' + (centerX + 0.5) + ',0L' + (centerX + 0.5) + ',' + (drawHeight + 1)
      )
      .attr('stroke', getCSSVar('--axis'));

    // Make sure grids stay at the bottom
    gridMinor.toBack();
    gridMajor.toBack();
    axes.toBack();
  }

  function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#cccccc';
  }

  function handleResize() {
    // Recalculate sizing and redraw everything (Raphael needs a fresh canvas)
    const das = $('#drawAreaSource');
    // If the 2D area is hidden the clientWidth will be 0 — skip rather than
    // shrink the canvas to a single pixel.
    if (!das || das.clientWidth === 0 || das.offsetParent === null) return;
    drawWidth = das.clientWidth;
    drawHeight = das.clientHeight;
    const unit = state.gridSize * state.subGridSize * 2;
    drawWidth -= drawWidth % unit;
    drawHeight -= drawHeight % unit;
    centerX = drawWidth / 2;
    centerY = drawHeight / 2;
    drawArea.setSize(drawWidth + 1, drawHeight + 1);
    drawGrid();
    redrawAllPaths();
  }

  function redrawAllPaths() {
    for (const path of state.paths) {
      if (path.path) path.path.remove();
      for (const p of path.points) {
        if (p.box) { p.box.remove(); p.box = null; }
      }
      path.path = drawArea.path('').attr('stroke-width', 2).attr('stroke', getCSSVar('--text'));
      updatePath(path);
    }
    if (state.paths[state.currentPath]) {
      const path = state.paths[state.currentPath];
      path.path.attr('stroke-width', 3);
      for (const p of path.points) {
        p.box = makeBox(p.x, p.y);
      }
      if (state.selectedIdx >= 0 && state.selectedIdx < path.points.length) {
        path.points[state.selectedIdx].box.attr('stroke', getCSSVar('--accent'));
      }
    }
  }

  // ---------- Tools ----------

  function safeMake(id, fn) {
    if (!document.getElementById(id)) return null;
    try { return fn(); } catch (e) { console.warn('[osped] setup', id, e); return null; }
  }

  function setupTools() {
    tools.edit = safeMake('editToolSource', () => makeTool('editToolSource', 'M8,3L8,20L12,17L14,23L18,20L15,15L18,13Z', '#9ca3af'));
    tools.add  = safeMake('addToolSource',  () => makeTool('addToolSource', 'M10,2L14,2L14,10L22,10L22,14L14,14L14,22L10,22L10,14L2,14L2,10L10,10Z', '#22c55e'));
    tools.rem  = safeMake('remToolSource',  () => makeTool('remToolSource', 'M22,10L22,14L2,14L2,10Z', '#ef4444'));
    tools.img  = safeMake('imgToolSource',  () => makeImageTool('imgToolSource'));

    document.getElementById('editToolSource')?.addEventListener('click', () => setSelectedTool(tools.edit));
    document.getElementById('addToolSource')?.addEventListener('click',  () => setSelectedTool(tools.add));
    document.getElementById('remToolSource')?.addEventListener('click',  () => setSelectedTool(tools.rem));
    document.getElementById('imgToolSource')?.addEventListener('click',  () => setSelectedTool(tools.img));

    safeMake('editToolCorner', () => makeIcon('editToolCorner', (p) => {
      p.path('M3,14L18,18L14,3').attr('stroke', getCSSVar('--text'));
      p.rect(15, 15, 6, 6).attr('stroke', getCSSVar('--text'));
    }));
    safeMake('editToolSmooth', () => makeIcon('editToolSmooth', (p) => {
      p.path('M1,12C16,22 22,16 12,1').attr('stroke', getCSSVar('--text'));
      p.rect(13, 13, 6, 6).attr('stroke', getCSSVar('--text'));
      p.path('M21,11L11,21').attr('stroke', getCSSVar('--text'));
      p.rect(8, 18, 6, 6).attr('stroke', getCSSVar('--text'));
      p.rect(18, 8, 6, 6).attr('stroke', getCSSVar('--text'));
    }));

    document.getElementById('editToolCorner')?.addEventListener('click', () => {
      if (state.selectedIdx < 0) return;
      pushHistory();
      const p = state.paths[state.currentPath].points[state.selectedIdx];
      p.type = 0;
      p.prevCP = { x: 0, y: 0 };
      p.nextCP = { x: 0, y: 0 };
      updatePath(state.paths[state.currentPath]);
      showSelectedCP();
      updateExport();
    });

    document.getElementById('editToolSmooth')?.addEventListener('click', () => {
      if (state.selectedIdx < 0) return;
      pushHistory();
      const p = state.paths[state.currentPath].points[state.selectedIdx];
      p.type = 1;
      p.prevCP = { x: -2, y: -2 };
      p.nextCP = { x: 2, y: 2 };
      updatePath(state.paths[state.currentPath]);
      showSelectedCP();
      updateExport();
    });
  }

  function makeTool(id, pathStr, fill) {
    const paper = Raphael(id, 24, 24);
    paper.path(pathStr).attr({ fill, stroke: getCSSVar('--text') });
    return paper;
  }

  function makeImageTool(id) {
    const paper = Raphael(id, 24, 24);
    paper.path('M3,21L21,21L21,4L3,4Z').attr('stroke', getCSSVar('--text'));
    paper.path('M5,6L5,12L11,12L11,6Z').attr({ fill: '#f87171', stroke: 'none' });
    paper.circle(12, 13, 4).attr({ fill: '#4ade80', stroke: 'none' });
    paper.path('M19,19L11,19L15,13Z').attr({ fill: '#60a5fa', stroke: 'none' });
    return paper;
  }

  function makeIcon(id, drawFn) {
    const paper = Raphael(id, 24, 24);
    drawFn(paper);
    return paper;
  }

  function setSelectedTool(tool) {
    for (const t of Object.values(tools)) {
      if (!t || !t.canvas) continue;
      const node = t.canvas.parentNode;
      if (node) node.classList.remove('active');
    }
    const entry = Object.entries(tools).find(([, v]) => v === tool);
    if (entry && entry[1] && entry[1].canvas && entry[1].canvas.parentNode) {
      entry[1].canvas.parentNode.classList.add('active');
    }
    state.currentTool = tool;
    state.selectedIdx = -1;
    showSelectedCP();

    $('#imageToolOptions').hidden = tool !== tools.img;
    $('#editToolOptions').style.display = tool === tools.edit ? '' : 'none';
  }

  // ---------- Panel events ----------

  function setupPanelEvents() {
    // Path listbox
    const listbox = $('#pathListbox');
    listbox.selectedIndex = 0;
    listbox.addEventListener('change', () => {
      const prev = state.paths[state.currentPath];
      if (prev) {
        for (const pt of prev.points) {
          if (pt.box) { pt.box.remove(); pt.box = null; }
        }
        prev.path.attr('stroke-width', 2);
      }
      state.currentPath = listbox.selectedIndex;
      state.selectedIdx = -1;
      showSelectedCP();
      const cur = state.paths[state.currentPath];
      if (cur) {
        for (const pt of cur.points) {
          if (pt.box) pt.box.remove();
          pt.box = makeBox(pt.x, pt.y);
        }
        cur.path.attr('stroke-width', 3);
      }
      updateEditingBadge(state.currentPath);
      emitPathSelected(state.currentPath);
    });

    // Export area — use input event so paste also triggers
    $('#exportArea').addEventListener('input', onExportInput);

    // Trace image
    $('#traceImageURL').addEventListener('input', () => {
      $('#traceImage').src = $('#traceImageURL').value;
    });
    $('#traceImageScale').addEventListener('input', updateTraceImageSize);
    $('#traceImage').addEventListener('load', updateTraceImageSize);

    if (typeof FileReader === 'function') {
      const reader = new FileReader();
      $('#traceImageFile').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          alert('请选择有效的图片文件！');
          return;
        }
        reader.readAsDataURL(file);
      });
      reader.onload = (e) => { $('#traceImage').src = e.target.result; };
    } else {
      $('#traceImageFileSpan').hidden = true;
    }

    // Draggable panel
    setupDraggablePanel();

    // Theme toggle
    $('#themeToggle').addEventListener('click', toggleTheme);

    // Undo / redo
    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);

    // Zoom
    $('#zoomInBtn').addEventListener('click', () => setZoom(state.zoom * 1.25));
    $('#zoomOutBtn').addEventListener('click', () => setZoom(state.zoom / 1.25));
    $('#zoomResetBtn').addEventListener('click', () => setZoom(1));

    // Snap toggle
    $('#snapToggle').addEventListener('change', (e) => {
      state.snap = e.target.checked;
    });

    // Grid size
    $('#gridSizeInput').addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      if (Number.isFinite(v) && v >= 2 && v <= 64) {
        state.gridSize = v;
        handleResize();
      }
    });

    // Copy and clear
    $('#copyBtn').addEventListener('click', async () => {
      const text = $('#exportArea').value;
      try {
        await navigator.clipboard.writeText(text);
        flashButton('#copyBtn', '已复制!');
      } catch {
        $('#exportArea').select();
        document.execCommand('copy');
        flashButton('#copyBtn', '已复制!');
      }
    });
    $('#clearBtn').addEventListener('click', () => {
      if (!confirm('确定清空所有路径吗？')) return;
      pushHistory();
      clearAllPaths();
      $('#exportArea').value = '';
      state.oldExportStr = '';
      $('#exportArea').dispatchEvent(new Event('input'));
    });
  }

  function flashButton(sel, msg) {
    const btn = $(sel);
    const orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }

  function setupDraggablePanel() {
    // Panel is now docked — no dragging.
  }

  function updateTraceImageSize() {
    const img = $('#traceImage');
    const scale = parseInt($('#traceImageScale').value, 10) || 100;
    img.style.width = '';
    img.style.width = (img.naturalWidth * scale / 100) + 'px';
    const wrapperRect = $('#drawAreaSource').getBoundingClientRect();
    img.style.left = (centerX - img.offsetWidth / 2 + wrapperRect.left) + 'px';
    img.style.top = (centerY - img.offsetHeight / 2 + wrapperRect.top) + 'px';
  }

  // ---------- Theme ----------

  function setupTheme() {
    const saved = localStorage.getItem('osped-theme');
    if (saved) document.documentElement.dataset.theme = saved;
    updateThemeIcon();
  }
  function toggleTheme() {
    const current = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = current;
    localStorage.setItem('osped-theme', current);
    updateThemeIcon();
    drawGrid();
    redrawAllPaths();
  }
  function updateThemeIcon() {
    const dark = document.documentElement.dataset.theme === 'dark';
    $('#themeToggle').innerHTML = dark ? '&#9789;' : '&#9788;';
  }

  // ---------- Coordinates ----------

  function toX(x) { return x * state.gridSize + centerX; }
  function toY(y) { return -y * state.gridSize + centerY; }

  function makeBox(x, y) {
    return drawArea
      .rect(toX(x) - state.gridSize / 2, toY(y) - state.gridSize / 2, state.gridSize, state.gridSize)
      .attr('stroke', getCSSVar('--text'));
  }

  // Returns null if event is not on the draw area or is on the toolbox
  function eventToGrid(e) {
    const das = $('#drawAreaSource');
    const toolbox = $('#toolbox');
    const dRect = das.getBoundingClientRect();
    if (e.pageX < dRect.left || e.pageY < dRect.top) return null;
    if (e.pageX > dRect.left + drawWidth || e.pageY > dRect.top + drawHeight) return null;
    const tRect = toolbox.getBoundingClientRect();
    if (
      e.pageX >= tRect.left && e.pageX <= tRect.right &&
      e.pageY >= tRect.top && e.pageY <= tRect.bottom
    ) return null;

    if (e.preventDefault) e.preventDefault();
    e.stopPropagation();
    const rawX = (e.pageX - dRect.left - centerX) / state.gridSize;
    const rawY = -(e.pageY - dRect.top - centerY) / state.gridSize;
    const x = state.snap ? Math.round(rawX) : Math.round(rawX * 100) / 100;
    const y = state.snap ? Math.round(rawY) : Math.round(rawY * 100) / 100;
    return { x, y, rawX, rawY };
  }

  // ---------- Path math ----------

  function updatePath(path) {
    const points = path.points;
    let str = '';
    if (points.length > 1) {
      let p0 = points[points.length - 1];
      str += 'M' + toX(p0.x) + ',' + toY(p0.y);
      for (let i = 0; i < points.length; i++) {
        const p1 = points[i];
        if (p0.type == 1 || p1.type == 1) {
          const x1 = p0.x + p0.nextCP.x;
          const y1 = p0.y + p0.nextCP.y;
          const x2 = p1.x + p1.prevCP.x;
          const y2 = p1.y + p1.prevCP.y;
          str += 'C' + toX(x1) + ',' + toY(y1) + ' ' + toX(x2) + ',' + toY(y2) + ' ' + toX(p1.x) + ',' + toY(p1.y);
        } else {
          str += 'L' + toX(p1.x) + ',' + toY(p1.y);
        }
        p0 = p1;
      }
      str += 'Z';
    }
    path.path.attr('path', str);
  }

  function showSelectedCP() {
    if (state.nextCPbox) { state.nextCPbox.remove(); state.nextCPbox = null; }
    if (state.prevCPbox) { state.prevCPbox.remove(); state.prevCPbox = null; }
    if (state.selectedIdx < 0) return;
    const path = state.paths[state.currentPath];
    if (!path) return;
    const p = path.points[state.selectedIdx];
    if (!p || p.type !== 1) return;
    state.nextCPbox = drawArea
      .rect(toX(p.x + p.nextCP.x) - state.gridSize / 2, toY(p.y + p.nextCP.y) - state.gridSize / 2, state.gridSize, state.gridSize)
      .attr('stroke', '#8080FF');
    state.prevCPbox = drawArea
      .rect(toX(p.x + p.prevCP.x) - state.gridSize / 2, toY(p.y + p.prevCP.y) - state.gridSize / 2, state.gridSize, state.gridSize)
      .attr('stroke', '#8080FF');
  }

  function interpolate(p0, p1, f) {
    return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
  }
  function distance(p0, p1) {
    return Math.sqrt((p0.x - p1.x) ** 2 + (p0.y - p1.y) ** 2);
  }

  function updateExport() {
    if (state.suppressExport) return;
    const maxInterpolateSteps = 100;
    let str = '';
    for (const path of state.paths) {
      str += path.prefix + '[';
      if (path.points.length > 0) {
        for (let j = 0; j < path.points.length; j++) {
          const p0 = path.points[j];
          const p1 = path.points[(j + 1) % path.points.length];
          str += '[' + p0.x + ',' + p0.y;
          if (p0.type == 1 || p1.type == 1) {
            const q0 = { x: p0.x + p0.nextCP.x, y: p0.y + p0.nextCP.y };
            const q1 = { x: p1.x + p1.prevCP.x, y: p1.y + p1.prevCP.y };
            let prevPoint = p0;
            str += '/*1:' + p0.prevCP.x + ',' + p0.prevCP.y + ',' + p0.nextCP.x + ',' + p0.nextCP.y + '*/';
            for (let n = 1; n < maxInterpolateSteps; n++) {
              const k = n / maxInterpolateSteps;
              const r0 = interpolate(p0, q0, k);
              const r1 = interpolate(q0, q1, k);
              const r2 = interpolate(q1, p1, k);
              const b0 = interpolate(r0, r1, k);
              const b1 = interpolate(r1, r2, k);
              const s = interpolate(b0, b1, k);
              if (distance(s, prevPoint) >= 1) {
                prevPoint = s;
                str += '] ,[';
                str += (Math.round(s.x * 100) / 100) + ',' + (Math.round(s.y * 100) / 100);
              }
            }
          }
          str += ']';
          if (j < path.points.length - 1) str += ',';
        }
      } else {
        str += '[]';
      }
      str += ']' + path.postfix;
    }
    $('#exportArea').value = str;
    state.oldExportStr = str;
    emitPathsChanged();
  }

  function onExportInput() {
    const str = $('#exportArea').value;
    if (str === state.oldExportStr) return;
    state.oldExportStr = str;
    parseImportedCode(str);
  }

  function parseImportedCode(str) {
    clearAllPaths();

    const startMarker = '[[';
    let startIdx = str.indexOf(startMarker);
    let prevEnd = 0;
    let p = 0;
    let optionStr = '';
    while (startIdx > -1) {
      const endIdx = str.indexOf(']]', startIdx);
      if (endIdx === -1) break;
      state.paths[p] = { points: [], prefix: str.substring(prevEnd, startIdx), postfix: '' };
      prevEnd = endIdx + 2;
      const polyString = str.substring(startIdx + 2, endIdx).split('],[');
      for (const part of polyString) {
        const nums = part.split(',');
        const x = parseInt(nums[0], 10);
        const y = parseInt(nums[1], 10);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const point = { x, y, type: 0, nextCP: { x: 0, y: 0 }, prevCP: { x: 0, y: 0 } };
        if (part.indexOf('/*') > 0) {
          let extra = part.substring(part.indexOf('/*') + 2);
          extra = extra.substring(0, extra.length - 2);
          const colonSplit = extra.split(':');
          point.type = parseInt(colonSplit[0], 10);
          const cpNums = colonSplit[1].split(',');
          point.prevCP = { x: parseInt(cpNums[0], 10), y: parseInt(cpNums[1], 10) };
          point.nextCP = { x: parseInt(cpNums[2], 10), y: parseInt(cpNums[3], 10) };
        }
        state.paths[p].points.push(point);
      }
      state.paths[p].path = drawArea.path('').attr('stroke-width', 2).attr('stroke', getCSSVar('--text'));
      updatePath(state.paths[p]);
      p++;
      optionStr += '<option>Path:' + p + '</option>';
      startIdx = str.indexOf(startMarker, startIdx + 1);
    }
    if (p > 0) state.paths[p - 1].postfix = str.substring(prevEnd);
    optionStr += '<option>[New]</option>';
    $('#pathListbox').innerHTML = optionStr;
    $('#pathListbox').selectedIndex = 0;
    state.currentPath = 0;
    $('#pathListbox').dispatchEvent(new Event('change'));
    emitPathsChanged();
  }

  function clearAllPaths() {
    for (const path of state.paths) {
      for (const pt of path.points) {
        if (pt.box) pt.box.remove();
      }
      if (path.path) path.path.remove();
    }
    state.paths = [];
    state.selectedIdx = -1;
    state.currentPath = 0;
    showSelectedCP();
    $('#pathListbox').innerHTML = '<option>[New]</option>';
    $('#pathListbox').selectedIndex = 0;
  }

  // ---------- Draw area interaction ----------

  function setupDrawAreaEvents() {
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Zoom with wheel
    $('#wrapper').addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      setZoom(state.zoom * factor);
    }, { passive: false });
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return;
    const g = eventToGrid(e);
    if (!g) return;
    state.drag = -1;

    if (state.currentTool === tools.add) {
      pushHistory();
      if (state.paths.length <= state.currentPath) {
        const opts = $('#pathListbox').options;
        if (opts[state.currentPath]) {
          opts[state.currentPath].textContent = 'Path:' + (state.currentPath + 1);
        }
        const newOpt = document.createElement('option');
        newOpt.textContent = '[New]';
        $('#pathListbox').appendChild(newOpt);
        state.paths[state.currentPath] = { points: [], prefix: 'linear_extrude(height=1) polygon(', postfix: ');\n' };
      }
      const box = makeBox(g.x, g.y);
      state.paths[state.currentPath].points.push({
        x: g.x, y: g.y, type: 0, box,
        prevCP: { x: 0, y: 0 }, nextCP: { x: 0, y: 0 },
      });
      if (!state.paths[state.currentPath].path) {
        state.paths[state.currentPath].path = drawArea.path('').attr('stroke-width', 3).attr('stroke', getCSSVar('--text'));
      }
      updatePath(state.paths[state.currentPath]);
      updateExport();
      return;
    }

    if (state.currentTool === tools.edit) {
      const path = state.paths[state.currentPath];
      if (!path) return;

      // Check for control point drag
      if (state.selectedIdx > -1 && path.points[state.selectedIdx].type === 1) {
        const p = path.points[state.selectedIdx];
        if (Math.abs(p.x + p.nextCP.x - g.x) < 0.5 && Math.abs(p.y + p.nextCP.y - g.y) < 0.5) {
          state.dragType = 1;
          state.drag = state.selectedIdx;
          pushHistory();
          return;
        }
        if (Math.abs(p.x + p.prevCP.x - g.x) < 0.5 && Math.abs(p.y + p.prevCP.y - g.y) < 0.5) {
          state.dragType = 2;
          state.drag = state.selectedIdx;
          pushHistory();
          return;
        }
      }

      // Select a point
      for (let i = 0; i < path.points.length; i++) {
        if (path.points[i].x === g.x && path.points[i].y === g.y) {
          if (state.selectedIdx > -1 && path.points[state.selectedIdx] && path.points[state.selectedIdx].box) {
            path.points[state.selectedIdx].box.attr('stroke', getCSSVar('--text'));
          }
          state.drag = i;
          state.dragType = 0;
          state.selectedIdx = i;
          path.points[i].box.attr('stroke', getCSSVar('--accent'));
          showSelectedCP();
          pushHistory();
          return;
        }
      }
      return;
    }

    if (state.currentTool === tools.rem) {
      const path = state.paths[state.currentPath];
      if (!path) return;
      let removed = false;
      for (let i = 0; i < path.points.length; i++) {
        if (path.points[i].x === g.x && path.points[i].y === g.y) {
          if (!removed) pushHistory();
          path.points[i].box.remove();
          path.points.splice(i, 1);
          removed = true;
          i--;
        }
      }
      if (removed) {
        state.selectedIdx = -1;
        showSelectedCP();
        updatePath(path);
        updateExport();
      }
    }
  }

  function handleMouseMove(e) {
    const g = eventToGrid(e);
    if (!g) return;
    $('#cursorCoordinates').textContent = 'x = ' + g.x + ', y = ' + g.y;

    if (state.currentTool !== tools.edit || state.drag === -1) return;
    const path = state.paths[state.currentPath];
    if (!path) return;
    const p = path.points[state.drag];
    if (!p) return;
    switch (state.dragType) {
      case 0:
        p.x = g.x;
        p.y = g.y;
        p.box.attr({ x: toX(g.x) - state.gridSize / 2, y: toY(g.y) - state.gridSize / 2 });
        break;
      case 1:
        p.nextCP.x = g.x - p.x;
        p.nextCP.y = g.y - p.y;
        break;
      case 2:
        p.prevCP.x = g.x - p.x;
        p.prevCP.y = g.y - p.y;
        break;
    }
    updatePath(path);
    showSelectedCP();
    updateExport();
  }

  function handleMouseUp() {
    state.drag = -1;
  }

  // ---------- Zoom ----------

  function setZoom(z) {
    z = Math.max(0.25, Math.min(z, 8));
    state.zoom = z;
    // Use Raphael's setViewBox to zoom
    const w = (drawWidth + 1) / z;
    const h = (drawHeight + 1) / z;
    const x = centerX - w / 2;
    const y = centerY - h / 2;
    drawArea.setViewBox(x, y, w, h, true);
    $('#zoomIndicator').textContent = Math.round(z * 100) + '%';
  }

  // ---------- Undo / redo ----------

  function snapshotPaths() {
    return JSON.parse(JSON.stringify(state.paths.map((p) => ({
      points: p.points.map((pt) => ({
        x: pt.x, y: pt.y, type: pt.type,
        prevCP: { ...pt.prevCP }, nextCP: { ...pt.nextCP },
      })),
      prefix: p.prefix,
      postfix: p.postfix,
    }))));
  }

  function pushHistory() {
    if (state.historyIndex < state.history.length - 1) {
      state.history = state.history.slice(0, state.historyIndex + 1);
    }
    state.history.push(snapshotPaths());
    if (state.history.length > state.historyLimit) state.history.shift();
    state.historyIndex = state.history.length - 1;
    updateUndoRedoButtons();
  }

  function restoreSnapshot(snap) {
    state.suppressExport = true;
    clearAllPaths();
    for (let i = 0; i < snap.length; i++) {
      state.paths[i] = {
        points: snap[i].points.map((pt) => ({
          x: pt.x, y: pt.y, type: pt.type,
          prevCP: { ...pt.prevCP }, nextCP: { ...pt.nextCP },
          box: null,
        })),
        prefix: snap[i].prefix,
        postfix: snap[i].postfix,
        path: drawArea.path('').attr('stroke-width', 2).attr('stroke', getCSSVar('--text')),
      };
      updatePath(state.paths[i]);
    }
    let optionStr = '';
    for (let i = 0; i < state.paths.length; i++) optionStr += '<option>Path:' + (i + 1) + '</option>';
    optionStr += '<option>[New]</option>';
    $('#pathListbox').innerHTML = optionStr;
    state.currentPath = Math.min(state.currentPath, state.paths.length);
    $('#pathListbox').selectedIndex = state.currentPath;
    $('#pathListbox').dispatchEvent(new Event('change'));
    state.suppressExport = false;
    updateExport();
  }

  function undo() {
    if (state.historyIndex <= 0) return;
    if (state.historyIndex === state.history.length - 1) {
      // capture current state so redo can return to it
      state.history.push(snapshotPaths());
    }
    state.historyIndex--;
    restoreSnapshot(state.history[state.historyIndex]);
    updateUndoRedoButtons();
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    restoreSnapshot(state.history[state.historyIndex]);
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    $('#undoBtn').disabled = state.historyIndex <= 0;
    $('#redoBtn').disabled = state.historyIndex >= state.history.length - 1;
  }

  // ---------- Keyboard ----------

  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      const target = e.target;
      const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key === 'z' && !e.shiftKey) {
        if (document.body.classList.contains('slice-selected')) {
          e.preventDefault();
          undo();
        }
        return;
      }
      if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        if (document.body.classList.contains('slice-selected')) {
          e.preventDefault();
          redo();
        }
        return;
      }

      if (inField) return;

      switch (e.key) {
        case 'e': case 'E': setSelectedTool(tools.edit); break;
        case 'a': case 'A': setSelectedTool(tools.add); break;
        case 'r': case 'R': setSelectedTool(tools.rem); break;
        case 'i': case 'I': setSelectedTool(tools.img); break;
        case '+': case '=': setZoom(state.zoom * 1.25); break;
        case '-': case '_': setZoom(state.zoom / 1.25); break;
        case '0': setZoom(1); break;
        case 'Delete': case 'Backspace':
          if (state.selectedIdx >= 0) {
            pushHistory();
            const path = state.paths[state.currentPath];
            path.points[state.selectedIdx].box.remove();
            path.points.splice(state.selectedIdx, 1);
            state.selectedIdx = -1;
            showSelectedCP();
            updatePath(path);
            updateExport();
          }
          break;
      }
    });
  }

  // ---------- Util ----------

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }
})();
