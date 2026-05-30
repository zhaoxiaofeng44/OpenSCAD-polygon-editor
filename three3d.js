import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import {
  parse, evaluate, assignIds, serializeAst,
  findById, findByPath, applyTransformsToNode,
  deleteById, combineByIds,
  mirrorNodeById, addOuterTranslateById,
} from './openscad.js';

const $ = (s) => document.querySelector(s);

const container = $('#viewport3d');
const hintEl = $('#viewport3dHint');
const debugEl = $('#viewport3dDebug');
let scene, camera, renderer, controls, meshGroup, gridHelper, axesHelper;
let initialized = false;
let needsRebuild = false;
let hasAutoFramed = false;

// selection state
let selectedObject = null;
let selectionBox = null;
let transformControls = null;
let gizmoMode = 'translate';
let justFinishedGizmoDrag = false;
let pendingReselectAstPath = null; // array of indices into the eval tree
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let selectionPanelWiredUp = false;
// True for one onPathSelected cycle when a primitive/shape was inserted from
// the left panel — keeps the selection panel closed so it only opens via
// scene-tree click or 3D viewport click.
let suppressAutoSelectOnce = false;

// multi-selection state (top-level astIndices)
const multiSelected = new Set();
const multiBoxes = []; // BoxHelpers for each multi-selected mesh

// quick-align panel state
const quickAlignState = { face: '+z', mode: 'center', expanded: false };

// ---------- VDOM state ----------
// currentAst is the in-memory source of truth. User edits modify it directly;
// the textarea is regenerated from it. When the user types in the textarea, we
// re-parse and rebuild currentAst (assigning new ids).
let currentAst = [];
let suppressVdomRebuild = false;

// ---------- AST History (Undo/Redo for 3D operations) ----------
const AST_HISTORY_LIMIT = 50;
let astHistory = [];
let astHistoryIndex = -1;
let astHistorySeeded = false;

function pushAstHistory() {
  if (astHistoryIndex < astHistory.length - 1) {
    astHistory = astHistory.slice(0, astHistoryIndex + 1);
  }
  astHistory.push(JSON.parse(JSON.stringify(currentAst)));
  if (astHistory.length > AST_HISTORY_LIMIT) {
    astHistory.shift();
  }
  astHistoryIndex = astHistory.length - 1;
  updateAstUndoRedoButtons();
}

function undoAst() {
  if (astHistoryIndex < 0) return;
  if (astHistoryIndex === astHistory.length - 1) {
    astHistory.push(JSON.parse(JSON.stringify(currentAst)));
  }
  const snapshot = astHistory[astHistoryIndex];
  astHistoryIndex--;
  currentAst = assignIds(JSON.parse(JSON.stringify(snapshot)));
  selectMesh(null);
  commitVdomToTextarea(null, null);
  updateAstUndoRedoButtons();
}

function redoAst() {
  if (astHistoryIndex >= astHistory.length - 2) return;
  astHistoryIndex += 2;
  const snapshot = astHistory[astHistoryIndex];
  currentAst = assignIds(JSON.parse(JSON.stringify(snapshot)));
  selectMesh(null);
  commitVdomToTextarea(null, null);
  updateAstUndoRedoButtons();
}

function updateAstUndoRedoButtons() {
  const undoBtn = document.getElementById('ast3dUndoBtn');
  const redoBtn = document.getElementById('ast3dRedoBtn');
  if (undoBtn) undoBtn.disabled = astHistoryIndex < 0;
  if (redoBtn) redoBtn.disabled = astHistoryIndex >= astHistory.length - 2;
}

function ensureCurrentAst() {
  if (currentAst.length === 0 && window.OspedAPI?.getCode) {
    try {
      currentAst = assignIds(parse(window.OspedAPI.getCode()));
    } catch (err) { console.warn('[vdom] initial parse', err); currentAst = []; }
  }
  return currentAst;
}

function commitVdomToTextarea(reselectId, reselectPath) {
  const code = serializeAst(currentAst);
  const ta = document.querySelector('#exportArea');
  if (!ta) return;
  suppressVdomRebuild = true;
  ta.value = code;
  ta.dispatchEvent(new Event('input'));
  suppressVdomRebuild = false;
  // After re-render, restore selection by id (if provided) or path
  if (reselectId !== undefined && reselectId !== null) {
    pendingReselectVNodeId = reselectId;
  } else if (reselectPath) {
    pendingReselectAstPath = reselectPath.slice();
  }
}

let pendingReselectVNodeId = null;

function setDebug(msg, isError = false) {
  if (!debugEl) return;
  debugEl.textContent = msg;
  debugEl.classList.toggle('error', !!isError);
}
function setHintVisible(visible) {
  if (!hintEl) return;
  hintEl.hidden = !visible;
  hintEl.style.display = visible ? '' : 'none';
}

window.addEventListener('error', (e) => {
  if (debugEl && container && !container.hidden) {
    setDebug('Error: ' + (e.message || 'unknown'), true);
  }
  console.error('[3D]', e.message, e.error);
});

const settings = {
  mode: 'linear',
  height: 1,
  twist: 0,
  scale: 1,
  segments: 64,
  angle: 360,
};

const material = new THREE.MeshStandardMaterial({
  color: 0xf2b154,
  metalness: 0.15,
  roughness: 0.55,
  side: THREE.DoubleSide,
  flatShading: false,
});
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.35 });

function detectWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

function showWebGLError(detail) {
  initialized = 'failed';
  setDebug('WebGL 不可用', true);
  if (hintEl) {
    hintEl.innerHTML =
      '<div style="text-align:left; max-width:420px;">' +
      '<strong style="color:#fecaca;">3D 不可用 — 浏览器未启用 WebGL。</strong>' +
      '<div style="margin-top:8px; font-size:12px; color:#cbd5e1;">' +
      '修复方法：' +
      '<ol style="margin:6px 0 0 18px; padding:0; line-height:1.6;">' +
      '<li>Chrome / Edge：<code>chrome://settings/system</code> → 开启<em>「使用硬件加速模式」</em>，然后重启浏览器。</li>' +
      '<li>访问 <code>chrome://gpu</code> — WebGL 状态应为 "Hardware accelerated"。</li>' +
      '<li>若仍无效：<code>chrome://flags/#ignore-gpu-blocklist</code> → 启用，重启。</li>' +
      '<li>或使用 Firefox / Safari（about:support → WebGL）。</li>' +
      '</ol>' +
      (detail ? '<div style="margin-top:8px; color:#94a3b8;">详情：' + detail + '</div>' : '') +
      '</div></div>';
    hintEl.style.maxWidth = 'min(480px, 90%)';
    hintEl.style.background = 'rgba(127, 29, 29, 0.92)';
    hintEl.style.display = 'block';
    hintEl.hidden = false;
  }
}

function init() {
  if (!detectWebGL()) {
    showWebGLError('Canvas getContext("webgl") returned null.');
    return;
  }

  // OpenSCAD convention: Z is up (set before creating camera)
  THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x131c2e);

  const w = Math.max(container.clientWidth, 1);
  const h = Math.max(container.clientHeight, 1);
  camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 5000);
  camera.up.set(0, 0, 1);
  camera.position.set(60, -90, 60);

  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
    });
  } catch (err) {
    console.error('[3D] WebGLRenderer failed', err);
    showWebGLError(err && err.message ? err.message : String(err));
    return;
  }
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h, false);
  container.appendChild(renderer.domElement);

  // Bright ambient + hemi keeps everything visible from any angle
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  scene.add(new THREE.HemisphereLight(0xb6d0ff, 0x404a60, 1.0));

  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(60, -60, 100);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0xfff5d6, 0.6);
  fill.position.set(-50, 80, 40);
  scene.add(fill);

  // Grid on XY plane (default GridHelper is XZ) — brighter so it's visible
  gridHelper = new THREE.GridHelper(200, 20, 0x96afd6, 0x4a6088);
  gridHelper.rotation.x = Math.PI / 2;
  scene.add(gridHelper);

  axesHelper = new THREE.AxesHelper(40);
  scene.add(axesHelper);

  meshGroup = new THREE.Group();
  scene.add(meshGroup);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 5);
  controls.update();

  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.size = 0.85;
  transformControls.setMode(gizmoMode);
  transformControls.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value;
    if (!e.value) {
      justFinishedGizmoDrag = true;
      setTimeout(() => { justFinishedGizmoDrag = false; }, 120);
    }
  });
  transformControls.addEventListener('objectChange', () => {
    if (selectedObject) showEditPanel(selectedObject);
    if (selectionBox) selectionBox.update();
  });
  transformControls.addEventListener('mouseUp', () => {
    if (selectedObject) applyTransformToCode();
  });
  // In newer Three.js versions TransformControls exposes a helper Object3D
  const gizmoHelper = transformControls.getHelper ? transformControls.getHelper() : transformControls;
  scene.add(gizmoHelper);

  const ro = new ResizeObserver(() => resize());
  ro.observe(container);

  setupSelection(renderer.domElement);

  initialized = true;  // must be set BEFORE animate so the loop schedules itself
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  if (initialized !== true) return;
  if (needsRebuild) {
    needsRebuild = false;
    doBuildMeshes();
  }
  if (selectionBox && selectedObject) selectionBox.update();
  for (const b of multiBoxes) if (b && b.update) b.update();
  controls.update();
  renderer.render(scene, camera);
}

function resize() {
  if (initialized !== true) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

function disposeGroup(group) {
  while (group.children.length) {
    const m = group.children[0];
    group.remove(m);
    m.traverse?.((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material && child.material !== material && child.material !== edgeMaterial) {
        child.material.dispose();
      }
    });
  }
}

function scheduleBuild() {
  needsRebuild = true;
}

function readSettings() {
  // The per-polygon extrude controls were removed from the panel — polygons
  // now ship pre-extruded via linear_extrude in the inserted snippet, so
  // these defaults are only kept for debug/status text.
  settings.mode = 'linear';
  settings.height = 1;
  settings.twist = 0;
  settings.scale = 1;
  settings.segments = 64;
  settings.angle = 360;
}

function doBuildMeshes() {
  if (initialized !== true) return;
  // Remember any multi-selection to restore after rebuild
  const preserveMulti = [...multiSelected];
  selectMesh(null);  // clear single selection before disposing
  clearMultiBoxes();
  disposeGroup(meshGroup);
  if (!window.OspedAPI) {
    setDebug('OspedAPI missing', true);
    return;
  }

  readSettings();
  const ast = ensureCurrentAst();
  const code = serializeAst(ast); // for debug stats only

  let evaluated;
  try {
    evaluated = evaluate(ast, {
      defaultMaterial: material,
      autoExtrude: true,
      autoExtrudeSettings: { ...settings },
    });
  } catch (err) {
    setDebug('eval error: ' + err.message, true);
    console.error('[3D] eval failed', err);
    return;
  }

  // Collect meshes BEFORE adding edges (don't mutate during traverse)
  const meshes = [];
  evaluated.traverse((o) => { if (o.isMesh) meshes.push(o); });

  console.log('[3D] ast: %d top-level nodes · meshes: %d', ast.length, meshes.length);

  if (meshes.length === 0) {
    setHintVisible(true);
    setDebug(`code chars: ${code.length} · ast: ${ast.length} nodes · 0 meshes`);
    return;
  }
  setHintVisible(false);
  meshGroup.add(evaluated);

  // Add wireframe edges
  for (const m of meshes) {
    if (!m.geometry) continue;
    try {
      const edges = new THREE.EdgesGeometry(m.geometry, 30);
      m.add(new THREE.LineSegments(edges, edgeMaterial));
    } catch { /* ignore */ }
  }

  setDebug(`code: ${code.length} · ast: ${ast.length} · meshes: ${meshes.length} · auto=${settings.mode}`);

  if (!hasAutoFramed) {
    meshGroup.updateMatrixWorld(true);
    frameToGeometry();
    hasAutoFramed = true;
  }

  // Re-attach selection — prefer VNode id (stable across in-memory edits),
  // fall back to AST path (for text-edit rebuilds where ids are regenerated)
  if (pendingReselectVNodeId !== null && pendingReselectVNodeId !== undefined) {
    const target = findMeshByVNodeId(pendingReselectVNodeId);
    pendingReselectVNodeId = null;
    if (target) selectMesh(target, { suppressPathSync: true });
  } else if (pendingReselectAstPath) {
    const target = findMeshByAstPath(pendingReselectAstPath);
    pendingReselectAstPath = null;
    if (target) selectMesh(target, { suppressPathSync: true });
  }
  // Restore multi-selection that was active before the rebuild (if still in range)
  if (preserveMulti.length > 1) {
    const evaluatedRoot = meshGroup.children[0];
    const max = evaluatedRoot ? evaluatedRoot.children.length : 0;
    for (const i of preserveMulti) if (i >= 0 && i < max) multiSelected.add(i);
    if (multiSelected.size > 1) applyMultiSelectionVisuals();
  }
}

function frameToGeometry() {
  const box = new THREE.Box3().setFromObject(meshGroup);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const fovRad = (camera.fov * Math.PI) / 180;
  const dist = (maxDim / (2 * Math.tan(fovRad / 2))) * 2.4;
  // Angled view: roughly OpenSCAD's default isometric-ish angle
  const offset = new THREE.Vector3(dist * 0.55, -dist * 0.85, dist * 0.55);
  camera.position.copy(center).add(offset);
  controls.target.copy(center);
  controls.update();
}

function exportObj() {
  console.log('[3D] exportObj clicked. initialized=', initialized, 'meshGroup?', !!meshGroup);
  if (initialized === 'failed') {
    alert('导出 OBJ 失败：WebGL 初始化失败，3D 视口不可用。请到 chrome://gpu 检查硬件加速是否打开，或换用支持 WebGL 的浏览器。');
    return;
  }
  if (initialized !== true || !meshGroup) {
    alert('3D 视口尚未就绪，请等待加载完成后重试（左下角调试状态会显示"3D 就绪"或"meshes: N"）。');
    return;
  }
  // Flush any pending textarea edits and force a synchronous mesh rebuild so
  // the OBJ reflects the latest code (not the pre-debounce snapshot).
  try { window.ProjectAPI?.flushPendingEdits?.(); } catch (err) { console.warn('[3D] flush before export', err); }
  // If the AST changed but the rebuild was only scheduled (animation frame
  // pending), run it now so meshGroup is up to date.
  if (needsRebuild) {
    needsRebuild = false;
    try { doBuildMeshes(); } catch (err) { console.warn('[3D] forced rebuild before export', err); }
  }

  // Hide non-geometry helpers (edges/box/grid/axes/gizmo) so the OBJ contains
  // only real model geometry. Restore visibility after export.
  const hidden = [];
  meshGroup.traverse((o) => {
    if (o.isLineSegments || o.isLine || o.type === 'LineSegments' || o.type === 'Line') {
      hidden.push(o); o.visible = false;
    }
  });
  const helpers = [gridHelper, axesHelper, selectionBox, ...multiBoxes];
  for (const h of helpers) if (h && h.visible) { hidden.push(h); h.visible = false; }
  let gizmoHelper = null;
  if (transformControls) {
    gizmoHelper = transformControls.getHelper ? transformControls.getHelper() : transformControls;
    if (gizmoHelper && gizmoHelper.visible) { hidden.push(gizmoHelper); gizmoHelper.visible = false; }
  }

  // Count meshes-with-real-geometry so an empty scene gives a clear error
  // instead of a silent zero-byte download.
  let realMeshCount = 0;
  meshGroup.traverse((o) => { if (o.isMesh && o.geometry) realMeshCount++; });
  console.log('[3D] exportObj: real mesh count =', realMeshCount);

  let data;
  try {
    data = new OBJExporter().parse(meshGroup);
  } catch (err) {
    console.error('[3D] OBJExporter failed', err);
    alert('导出 OBJ 失败：' + (err && err.message || err));
    for (const h of hidden) h.visible = true;
    return;
  }
  for (const h of hidden) h.visible = true;

  if (!data || !data.length || realMeshCount === 0) {
    alert('当前场景没有可导出的几何体。请从左侧「形状库」添加至少一个 3D 物体后再点「导出 OBJ」。');
    return;
  }
  const projectName = (window.ProjectAPI?.getActive?.()?.name) || 'model';
  const safeName = String(projectName).replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80) || 'model';
  const blob = new Blob([data], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName}.obj`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  console.log('[3D] exportObj: downloaded', a.download, '(' + data.length + ' chars)');
}

function resetCamera() {
  const box = new THREE.Box3().setFromObject(meshGroup);
  if (!box.isEmpty()) {
    frameToGeometry();
  } else {
    camera.position.set(60, -90, 60);
    controls.target.set(0, 0, 5);
    controls.update();
  }
}

function show3D() {
  document.body.classList.add('three-enabled');
  container.hidden = false;
  const statusEl = $('#viewport3dStatus');
  if (statusEl) statusEl.hidden = false;
  hasAutoFramed = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (initialized === false) init();
    if (initialized !== true) {
      window.OspedAPI?.resize2D();
      return;
    }
    resize();
    try { doBuildMeshes(); } catch (err) { console.error('[3D] initial build', err); }
    scheduleBuild();
    window.OspedAPI?.resize2D();
  }));
}

function wireControls() {
  $('#resetCameraBtn')?.addEventListener('click', () => initialized && resetCamera());
  $('#ast3dUndoBtn')?.addEventListener('click', undoAst);
  $('#ast3dRedoBtn')?.addEventListener('click', redoAst);
  $('#exportObjBtn')?.addEventListener('click', exportObj);

  if (window.OspedAPI) {
    // VDOM-aware change handler:
    //   * If we just wrote text from VDOM (suppressVdomRebuild=true), keep the
    //     current AST as-is (ids stable) and just re-render Three.js + tree.
    //   * Otherwise the user typed into the textarea (or 2D edit produced new
    //     code): re-parse and rebuild the AST with fresh ids. Preserve current
    //     3D selection by astPath since ids will be regenerated.
    window.OspedAPI.onChange(() => {
      if (!suppressVdomRebuild) {
        try {
          const code = window.OspedAPI.getCode();
          currentAst = assignIds(parse(code));
          console.log('[vdom] re-parsed, currentAst.length =', currentAst.length, 'first node:', currentAst[0]?.name);
          if (!astHistorySeeded && currentAst.length > 0) {
            astHistorySeeded = true;
            pushAstHistory();
          }
        } catch (err) {
          console.error('[vdom] parse on change FAILED', err);
        }
        if (
          selectedObject &&
          selectedObject.userData &&
          Array.isArray(selectedObject.userData.astPath) &&
          !pendingReselectAstPath &&
          !pendingReselectVNodeId
        ) {
          pendingReselectAstPath = selectedObject.userData.astPath.slice();
        }
      } else {
        console.log('[vdom] onChange suppressed, using current in-memory tree');
      }
      scheduleBuild();
    });
  }

  // Library tiles — single button per primitive. Inserts with defaults,
  // never opens the selection panel. Properties are edited via the panel
  // after selecting in the Scene Tree or the 3D viewport.
  //
  // The Polygon tile is a group entry: it expands a sub-tile panel listing
  // the actual 2D shapes (Rect/Disk/Tri/Poly) rather than inserting anything
  // by itself.
  const polygonSub = $('#polygonSubtiles');
  const polygonBtn = $('#polygonGroupBtn');
  const setPolygonGroupOpen = (open) => {
    if (!polygonSub || !polygonBtn) return;
    polygonSub.hidden = !open;
    polygonBtn.classList.toggle('active', open);
    polygonBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  document.querySelectorAll('.prim-tile').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.group === 'polygon') {
        setPolygonGroupOpen(polygonSub?.hidden !== false);
        return;
      }
      const kind = btn.dataset.prim;
      const shape = btn.dataset.shape;
      const snippet = kind ? makePrimSnippet(kind) : (shape ? makeShapeSnippet(shape) : null);
      if (!snippet || !window.OspedAPI || !window.OspedAPI.appendCode) return;
      suppressAutoSelectOnce = true;
      window.OspedAPI.appendCode(snippet);
      hasAutoFramed = false;
      scheduleBuild();
      // Collapse the polygon sub-panel after picking a shape from it.
      if (shape) setPolygonGroupOpen(false);
    });
  });

  // 2D path-selected → highlight corresponding 3D mesh
  if (window.OspedAPI && window.OspedAPI.onPathSelected) {
    window.OspedAPI.onPathSelected((idx) => {
      if (suppressAutoSelectOnce) { suppressAutoSelectOnce = false; return; }
      if (initialized !== true || idx < 0) { selectMesh(null); return; }
      const mesh = findTopLevelByPolygonIndex(idx);
      if (mesh) selectMesh(mesh, { suppressPathSync: true });
      else selectMesh(null);
    });
  }

  // Rebuild Scene Tree on every code change (uses currentAst when available so
  // we don't double-parse and ids stay consistent with the evaluator)
  if (window.OspedAPI && window.OspedAPI.onChange) {
    window.OspedAPI.onChange(() => {
      try { buildSceneTree(ensureCurrentAst()); }
      catch (err) { console.warn('[tree]', err); }
    });
    try { buildSceneTree(ensureCurrentAst()); } catch { /* ignore */ }
  }

  const clearCodeBtn = $('#clearCodeBtn');
  if (clearCodeBtn) {
    clearCodeBtn.addEventListener('click', () => {
      const ta = $('#exportArea');
      if (!ta) return;
      ta.value = '';
      ta.dispatchEvent(new Event('input'));
      hasAutoFramed = false;
      scheduleBuild();
    });
  }

  // Auto-open the 3D viewport so it's visible from page load — the 2D
  // canvas stays hidden unless a polygon slice is being edited.
  show3D();
}

// ---------- Selection ----------

function setupSelection(canvas) {
  let downX = 0, downY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    downX = e.clientX; downY = e.clientY;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    if (justFinishedGizmoDrag) return; // ignore: just released the gizmo
    if (transformControls && transformControls.dragging) return; // currently grabbing gizmo
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (dx * dx + dy * dy > 16) return; // dragged (OrbitControls) — not a click
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshGroup.children, true);
    if (!hits.length) {
      if (!(e.metaKey || e.ctrlKey || e.shiftKey)) {
        clearMultiSelection();
        selectMesh(null);
      }
      return;
    }
    let obj = hits[0].object;
    while (obj && !(obj.userData && obj.userData.astNode)) obj = obj.parent;
    if (!obj) return;
    const idx = obj.userData.astIndex;
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && typeof idx === 'number') {
      if (multiSelected.has(idx)) multiSelected.delete(idx);
      else multiSelected.add(idx);
      if (selectedObject && typeof selectedObject.userData?.astIndex === 'number') {
        multiSelected.add(selectedObject.userData.astIndex);
      }
      applyMultiSelectionVisuals();
      return;
    }
    clearMultiSelection();
    selectMesh(obj);
  });

  if (!selectionPanelWiredUp) {
    selectionPanelWiredUp = true;
    ['selPosX', 'selPosY', 'selPosZ', 'selRotX', 'selRotY', 'selRotZ',
     'selSclX', 'selSclY', 'selSclZ'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', applyEditPanelToObject);
    });
    document.getElementById('selDeselectBtn')?.addEventListener('click', () => selectMesh(null));
    document.getElementById('selUniformScaleBtn')?.addEventListener('click', () => {
      const s = parseFloat(document.getElementById('selSclX').value) || 1;
      document.getElementById('selSclY').value = s;
      document.getElementById('selSclZ').value = s;
      applyEditPanelToObject();
    });
    document.getElementById('selResetBtn')?.addEventListener('click', () => {
      if (!selectedObject) return;
      selectedObject.position.set(0, 0, 0);
      selectedObject.rotation.set(0, 0, 0);
      selectedObject.scale.set(1, 1, 1);
      showEditPanel(selectedObject);
    });
    document.getElementById('selApplyBtn')?.addEventListener('click', applyAllToCode);
    document.getElementById('selDeleteBtn')?.addEventListener('click', deleteSelectedFromCode);
    document.getElementById('selColor')?.addEventListener('change', applyAllToCode);
    document.getElementById('selColorReset')?.addEventListener('click', () => {
      const el = document.getElementById('selColor');
      if (el) { el.value = DEFAULT_OBJECT_COLOR; applyAllToCode(); }
    });

    // Gizmo mode buttons
    document.querySelectorAll('.gizmo-mode-btn').forEach((b) => {
      b.addEventListener('click', () => setGizmoMode(b.dataset.gizmoMode));
    });

    // Flip / mirror buttons
    document.querySelectorAll('.flip-btn').forEach((b) => {
      b.addEventListener('click', () => flipSelected(b.dataset.flipAxis));
    });

    // Combine panel buttons
    document.querySelectorAll('#combinePanel .combine-grid button[data-op]').forEach((b) => {
      b.addEventListener('click', () => combineSelected(b.dataset.op));
    });
    document.getElementById('multiDeselectBtn')?.addEventListener('click', () => {
      clearMultiSelection();
      selectMesh(null);
    });

    // Quick-align panel
    document.getElementById('quickAlignToggleBtn')?.addEventListener('click', () => {
      quickAlignState.expanded = !quickAlignState.expanded;
      const panel = document.getElementById('quickAlignPanel');
      if (panel) panel.hidden = !quickAlignState.expanded;
      const btn = document.getElementById('quickAlignToggleBtn');
      if (btn) btn.textContent = quickAlignState.expanded ? '快速对齐 ▴' : '快速对齐 ▾';
    });
    document.querySelectorAll('.qa-face-btn').forEach((b) => {
      b.addEventListener('click', () => {
        quickAlignState.face = b.dataset.face;
        document.querySelectorAll('.qa-face-btn').forEach((x) => {
          x.classList.toggle('active', x.dataset.face === quickAlignState.face);
        });
      });
    });
    document.querySelectorAll('.qa-mode-btn').forEach((b) => {
      b.addEventListener('click', () => {
        quickAlignState.mode = b.dataset.mode;
        document.querySelectorAll('.qa-mode-btn').forEach((x) => {
          x.classList.toggle('active', x.dataset.mode === quickAlignState.mode);
        });
      });
    });
    document.getElementById('quickAlignApplyBtn')?.addEventListener('click', () => {
      applyQuickAlign(quickAlignState.face, quickAlignState.mode);
    });

    // Keyboard shortcuts inside 3D viewport (skip when typing in inputs)
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !document.body.classList.contains('slice-selected')) {
        // e.key is uppercase when Shift is held, so normalize.
        const k = (e.key || '').toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoAst(); return; }
        if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redoAst(); return; }
      }
      if (mod || e.altKey) return;
      switch (e.key) {
        case 'g': case 'G': if (selectedObject) setGizmoMode('translate'); break;
        case 'b': case 'B': if (selectedObject) setGizmoMode('rotate'); break;
        case 'n': case 'N': if (selectedObject) setGizmoMode('scale'); break;
        case 'Escape': if (selectedObject) selectMesh(null); break;
        case 'Delete': case 'Backspace':
          if (selectedObject && document.body.classList.contains('three-enabled')) {
            e.preventDefault();
            deleteSelectedFromCode();
          }
          break;
      }
    });
  }
}

function selectMesh(obj, opts = {}) {
  if (selectionBox) {
    scene && scene.remove(selectionBox);
    selectionBox.geometry?.dispose();
    selectionBox = null;
  }
  // Detach gizmo from any previous object
  if (transformControls) {
    try { transformControls.detach(); } catch { /* ignore */ }
  }
  selectedObject = obj;
  const panel = document.getElementById('selectionPanel');
  if (!obj) {
    if (panel) panel.hidden = true;
    highlightTreeNode(null);
    toggleSliceSelected(false);
    return;
  }
  highlightTreeNode(obj.userData?.astPath || obj.userData?.astIndex);
  toggleSliceSelected(!!(obj.userData?.astNode && findFirstPolygonCall(obj.userData.astNode)));
  selectionBox = new THREE.BoxHelper(obj, 0xffd54f);
  selectionBox.material.depthTest = false;
  selectionBox.material.transparent = true;
  selectionBox.renderOrder = 999;
  scene.add(selectionBox);
  showEditPanel(obj);

  // Attach the drag-gizmo to the newly selected object
  if (transformControls) {
    try { transformControls.attach(obj); } catch (err) { console.warn('[3D] gizmo attach', err); }
  }

  // Sync to 2D editor if this mesh is polygon-based
  if (!opts.suppressPathSync && obj.userData?.astNode && window.OspedAPI?.selectPath) {
    const code = window.OspedAPI.getCode();
    const idx = findPolygonIndexInNode(obj.userData.astNode, code);
    if (idx >= 0) window.OspedAPI.selectPath(idx, { silent: true });
  }
}

function setGizmoMode(mode) {
  gizmoMode = mode;
  if (transformControls) transformControls.setMode(mode);
  document.querySelectorAll('.gizmo-mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.gizmoMode === mode);
  });
}

// Walk an AST subtree and return the source position of the first polygon() call,
// then count [[ occurrences in code before that position to get the 2D path index.
function findPolygonIndexInNode(node, code) {
  const polyNode = findFirstPolygonCall(node);
  if (!polyNode) return -1;
  // The 2D editor finds polygons by indexOf('[[') in source order.
  // Count [[ occurrences strictly before this polygon's sourceStart.
  const before = code.slice(0, polyNode.sourceStart || 0);
  let count = 0, idx = before.indexOf('[[');
  while (idx > -1) { count++; idx = before.indexOf('[[', idx + 1); }
  return count;
}

function findFirstPolygonCall(node) {
  if (!node || node.type !== 'call') return null;
  if (node.name === 'polygon') return node;
  for (const c of node.children || []) {
    const found = findFirstPolygonCall(c);
    if (found) return found;
  }
  return null;
}

function findMeshByVNodeId(id) {
  if (!meshGroup || id == null) return null;
  let found = null;
  meshGroup.traverse((o) => {
    if (found) return;
    if (o.userData && o.userData.vNodeId === id) found = o;
  });
  return found;
}

function findMeshByAstPath(path) {
  if (!meshGroup || !path || !path.length) return null;
  const evalRoot = meshGroup.children[0];
  if (!evalRoot) return null;
  let cur = evalRoot.children[path[0]];
  for (let i = 1; i < path.length && cur; i++) {
    cur = cur.children?.[path[i]];
  }
  return cur || null;
}

function findTopLevelByPolygonIndex(polyIdx) {
  if (!meshGroup) return null;
  const code = window.OspedAPI ? window.OspedAPI.getCode() : '';
  const evalRoot = meshGroup.children[0];
  if (!evalRoot) return null;
  // Walk the entire tagged tree; pick the DEEPEST tagged object whose AST
  // subtree contains the requested polygon (so children of CSG groups win
  // over their container).
  let best = null, bestDepth = -1;
  evalRoot.traverse((obj) => {
    if (!obj.userData || !obj.userData.astNode) return;
    const idx = findPolygonIndexInNode(obj.userData.astNode, code);
    if (idx !== polyIdx) return;
    const depth = (obj.userData.astPath && obj.userData.astPath.length) || 0;
    if (depth > bestDepth) { best = obj; bestDepth = depth; }
  });
  return best;
}

// ---------- Scene Tree ----------

const TREE_ICONS = {
  cube: '▣', sphere: '⬤', cylinder: '⬡', polyhedron: '⬢',
  polygon: '⬠', square: '▢', circle: '◯',
  translate: '↔', rotate: '↺', scale: '⇕', mirror: '⇆',
  color: '◈',
  linear_extrude: '⇧', rotate_extrude: '↻',
  union: '∪', difference: '∖', intersection: '∩',
  hull: '⌒', minkowski: '⊕',
};
function iconFor(name) { return TREE_ICONS[name] || '◆'; }

function formatValue(v, depth = 0) {
  if (!v || depth > 2) return '…';
  switch (v.type) {
    case 'number': {
      const n = v.value;
      return Number.isInteger(n) ? String(n) : (Math.round(n * 100) / 100).toString();
    }
    case 'string': return `"${v.value}"`;
    case 'bool': return String(v.value);
    case 'ident': return v.value;
    case 'array': {
      const items = v.items.slice(0, 4).map((i) => formatValue(i, depth + 1));
      if (v.items.length > 4) items.push('…');
      return `[${items.join(',')}]`;
    }
    default: return '?';
  }
}
function summarizeArgs(node) {
  if (!node.args) return '';
  const parts = [];
  for (const v of node.args.positional || []) parts.push(formatValue(v));
  for (const [k, v] of Object.entries(node.args.named || {})) parts.push(`${k}=${formatValue(v)}`);
  if (!parts.length) return '';
  const joined = parts.slice(0, 3).join(', ') + (parts.length > 3 ? ', …' : '');
  return `(${joined})`;
}

function buildSceneTree(ast) {
  const root = document.getElementById('sceneTree');
  if (!root) return;
  root.innerHTML = '';
  if (!ast || ast.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-hint';
    empty.textContent = '暂无物体 — 请从形状库添加';
    root.appendChild(empty);
    return;
  }
  ast.forEach((node, topLevelIdx) => {
    const li = renderTreeNode(node, [topLevelIdx]);
    if (li) root.appendChild(li);
  });
}

const MODIFIER_NAMES = new Set(['translate', 'rotate', 'scale', 'mirror', 'color']);

// Walk down a chain of single-child modifiers; collect them as badges and
// return the inner-most "real" node + the modifier list.
function flattenChain(node) {
  const modifiers = [];
  let cur = node;
  while (
    cur && cur.type === 'call' &&
    MODIFIER_NAMES.has(cur.name) &&
    cur.children && cur.children.length === 1
  ) {
    modifiers.push(cur);
    cur = cur.children[0];
  }
  return { mainNode: cur || node, modifiers };
}

function makeModifierBadge(modNode) {
  const span = document.createElement('span');
  span.className = `tree-badge tree-badge-${modNode.name}`;

  if (modNode.name === 'color') {
    const v = (modNode.args.named && modNode.args.named.c) || modNode.args.positional[0];
    let cssColor = '';
    let displayText = '';
    if (v) {
      if (v.type === 'string') { cssColor = v.value; displayText = v.value; }
      else if (v.type === 'array' && v.items.length >= 3) {
        const r = Math.round((v.items[0].value || 0) * 255);
        const g = Math.round((v.items[1].value || 0) * 255);
        const b = Math.round((v.items[2].value || 0) * 255);
        cssColor = `rgb(${r},${g},${b})`;
        displayText = cssColor;
      }
    }
    const swatch = document.createElement('span');
    swatch.className = 'tree-swatch';
    if (cssColor) swatch.style.background = cssColor;
    span.appendChild(swatch);
    if (displayText) {
      const txt = document.createElement('span');
      txt.textContent = displayText;
      span.appendChild(txt);
    }
    span.title = `color ${displayText}`;
    return span;
  }

  const icon = document.createElement('span');
  icon.className = 'tree-badge-icon';
  icon.textContent = iconFor(modNode.name);
  span.appendChild(icon);

  const v = (modNode.args.named && modNode.args.named.v) || modNode.args.positional[0];
  if (v) {
    const txt = document.createElement('span');
    txt.textContent = formatValue(v);
    span.appendChild(txt);
  }
  span.title = `${modNode.name} ${v ? formatValue(v) : ''}`;
  return span;
}

function renderTreeNode(node, astPath) {
  if (!node || node.type !== 'call') return null;
  const { mainNode, modifiers } = flattenChain(node);
  if (!mainNode || mainNode.type !== 'call') return null;

  const li = document.createElement('li');
  li.className = 'tree-node';
  li.dataset.astPath = astPath.join('.');
  // For backward compat with single-select highlight code
  if (astPath.length === 1) li.dataset.topLevelIdx = String(astPath[0]);

  const row = document.createElement('div');
  row.className = 'tree-row';

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = iconFor(mainNode.name);
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'tree-label';
  const name = document.createElement('b');
  name.textContent = mainNode.name;
  label.appendChild(name);
  const summary = summarizeArgs(mainNode);
  if (summary) {
    const argSpan = document.createElement('span');
    argSpan.className = 'tree-args';
    argSpan.textContent = ' ' + summary;
    label.appendChild(argSpan);
  }
  row.appendChild(label);

  for (const m of modifiers) {
    row.appendChild(makeModifierBadge(m));
  }

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    onTreeRowClick(astPath, e);
  });
  li.appendChild(row);

  if (mainNode.children && mainNode.children.length) {
    const ul = document.createElement('ul');
    // Children path extends mainNode's path. Walk the chain: each modifier
    // collapses with the child, so the child's path is `astPath` + collapsed depth.
    const childPathBase = [...astPath];
    for (let depth = 0; depth < modifiers.length; depth++) childPathBase.push(0);
    for (let i = 0; i < mainNode.children.length; i++) {
      const childLi = renderTreeNode(mainNode.children[i], [...childPathBase, i]);
      if (childLi) ul.appendChild(childLi);
    }
    li.appendChild(ul);
  }
  return li;
}

function onTreeRowClick(astPath, ev) {
  if (!meshGroup) return;
  if (!document.body.classList.contains('three-enabled')) {
    show3D();
    setTimeout(() => onTreeRowClick(astPath, ev), 200);
    return;
  }
  const additive = ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey);
  // Multi-select is supported only for top-level siblings for now
  if (additive && astPath.length === 1) {
    const topLevelIdx = astPath[0];
    if (multiSelected.has(topLevelIdx)) multiSelected.delete(topLevelIdx);
    else multiSelected.add(topLevelIdx);
    if (selectedObject && typeof selectedObject.userData?.astIndex === 'number') {
      multiSelected.add(selectedObject.userData.astIndex);
    }
    applyMultiSelectionVisuals();
    return;
  }
  multiSelected.clear();
  const target = findMeshByAstPath(astPath);
  if (target) selectMesh(target);
}

function clearMultiBoxes() {
  for (const b of multiBoxes) {
    if (b && scene) scene.remove(b);
    if (b && b.geometry) b.geometry.dispose();
  }
  multiBoxes.length = 0;
}

function applyMultiSelectionVisuals() {
  clearMultiBoxes();
  // Highlight tree rows
  const root = document.getElementById('sceneTree');
  if (root) {
    root.querySelectorAll('.tree-row.multi-selected').forEach((r) => r.classList.remove('multi-selected'));
    for (const idx of multiSelected) {
      const li = root.querySelector(`li.tree-node[data-top-level-idx="${idx}"]`);
      const r = li?.querySelector(':scope > .tree-row');
      if (r) r.classList.add('multi-selected');
    }
  }

  if (multiSelected.size < 2) {
    // No real multi-selection — close combine panel
    const panel = document.getElementById('combinePanel');
    if (panel) panel.hidden = true;
    return;
  }

  // 2+ selected: hide single-select gizmo + edit panel, hide selection box,
  // draw blue boxes around each multi-selected mesh, show combine panel.
  if (transformControls) try { transformControls.detach(); } catch {}
  if (selectionBox) {
    scene && scene.remove(selectionBox);
    selectionBox.geometry?.dispose();
    selectionBox = null;
  }
  selectedObject = null;
  document.getElementById('selectionPanel').hidden = true;

  const evalRoot = meshGroup && meshGroup.children[0];
  if (evalRoot) {
    for (const idx of multiSelected) {
      const target = evalRoot.children[idx];
      if (!target) continue;
      const box = new THREE.BoxHelper(target, 0x60a5fa);
      box.material.depthTest = false;
      box.material.transparent = true;
      box.renderOrder = 998;
      scene.add(box);
      multiBoxes.push(box);
    }
  }

  const panel = document.getElementById('combinePanel');
  if (panel) {
    panel.hidden = false;
    const countEl = document.getElementById('combineCount');
    if (countEl) countEl.textContent = String(multiSelected.size);
  }
}

function clearMultiSelection() {
  multiSelected.clear();
  clearMultiBoxes();
  document.querySelectorAll('#sceneTree .tree-row.multi-selected').forEach((r) => r.classList.remove('multi-selected'));
  const panel = document.getElementById('combinePanel');
  if (panel) panel.hidden = true;
}

function combineSelected(operation) {
  if (multiSelected.size < 2) return;
  const ast = ensureCurrentAst();
  const indices = [...multiSelected].sort((a, b) => a - b);
  const ids = indices.map((i) => ast[i] && ast[i].id).filter(Boolean);
  if (ids.length !== indices.length) {
    alert('无法定位所有选中的节点，请重新选择后再试。');
    return;
  }
  pushAstHistory();
  const wrapped = combineByIds(ast, ids, operation);
  if (!wrapped) {
    alert('选中的物体必须是相邻的同级节点才能组合。');
    return;
  }
  clearMultiSelection();
  commitVdomToTextarea(wrapped.id, null);
}

function toggleSliceSelected(on) {
  const was = document.body.classList.contains('slice-selected');
  if (was === on) return;
  document.body.classList.toggle('slice-selected', on);
  const refresh2D = () => {
    if (window.OspedAPI?.refresh) window.OspedAPI.refresh();
    else if (window.OspedAPI?.resize2D) window.OspedAPI.resize2D();
  };
  // Multiple staggered refresh attempts handle CSS reflow timing variability
  requestAnimationFrame(() => requestAnimationFrame(() => {
    refresh2D();
    resize();
  }));
  setTimeout(() => { refresh2D(); resize(); }, 80);
}

function highlightTreeNode(astPathOrIndex) {
  const root = document.getElementById('sceneTree');
  if (!root) return;
  root.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
  if (astPathOrIndex == null || astPathOrIndex === -1) return;
  const key = Array.isArray(astPathOrIndex) ? astPathOrIndex.join('.') : String(astPathOrIndex);
  const li = root.querySelector(`li.tree-node[data-ast-path="${key}"]`);
  if (!li) return;
  const row = li.querySelector(':scope > .tree-row');
  if (row) {
    row.classList.add('selected');
    row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

// Default parameters used when a primitive is inserted from the library.
// These also drive the inputs shown in the selection panel until the user
// edits them.
const PRIM_DEFAULTS = {
  cube:        { x: 20, y: 20, z: 20, center: true },
  sphere:      { r: 10, fn: 48 },
  cylinder:    { h: 20, r1: 8, r2: 8, fn: 48, center: false },
  cone:        { h: 20, r: 10, fn: 48 },
  prism:       { sides: 6, r: 8, h: 12 },
  torus:       { ringR: 12, tubeR: 3, fn: 48 },
  ellipsoid:   { rx: 14, ry: 10, rz: 8, fn: 48 },
  tetrahedron: { r: 12, h: 16 },
  octahedron:  { w: 16, h: 12 },
  frustum:     { h: 18, r1: 12, r2: 6, fn: 48 },
  pyramid:     { w: 20, h: 20 },
  hemisphere:  { r: 10, fn: 48 },
  tube:        { h: 20, outR: 10, inR: 7, fn: 48 },
  capsule:     { h: 16, r: 6, fn: 48 },
  wedge:       { w: 20, d: 14, h: 10 },
  star:        { points: 5, outR: 12, inR: 5, h: 4 },
  bowl:        { r: 12, thickness: 2, fn: 48 },
  disc:        { r: 14, h: 1.5, fn: 48 },
  spring:      { h: 30, r: 8, tubeR: 1.2, turns: 5, fn: 24 },
  lshape:      { w: 22, d: 22, h: 8, cw: 6, cd: 6 },
  tshape:      { w: 24, d: 20, t: 6, h: 8 },
  cross:       { w: 24, t: 6, h: 8 },
  stairs:      { steps: 4, w: 8, d: 14, h: 4 },
  nut:         { h: 6, outR: 8, holeR: 3 },
  arrow:       { w: 28, h: 16, t: 4 },
  heart:       { size: 14, h: 4 },
  crescent:    { r: 12, offset: 5, h: 3, fn: 48 },
};
const SHAPE_DEFAULTS = {
  rectangle: { w: 20, h: 20, h3: 1 },
  circle:    { r: 10, n: 32, h3: 1 },
  triangle:  { h3: 1 },
  polygon:   { h3: 1 },
};

function starPolygonPoints(n, outR, inR) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? outR : inR;
    pts.push(`[${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}]`);
  }
  return pts.join(',');
}

function makePrimSnippet(kind, params) {
  const p = { ...(PRIM_DEFAULTS[kind] || {}), ...(params || {}) };
  if (kind === 'cube') {
    return `cube([${p.x}, ${p.y}, ${p.z}], center=${p.center ? 'true' : 'false'});`;
  }
  if (kind === 'sphere') {
    return `sphere(r=${p.r}, $fn=${p.fn});`;
  }
  if (kind === 'cylinder') {
    return `cylinder(h=${p.h}, r1=${p.r1}, r2=${p.r2}, $fn=${p.fn}, center=${p.center ? 'true' : 'false'});`;
  }
  if (kind === 'cone') {
    return `cylinder(h=${p.h}, r1=${p.r}, r2=0, $fn=${p.fn});`;
  }
  if (kind === 'prism') {
    const sides = Math.max(3, p.sides | 0 || 6);
    return `cylinder(h=${p.h}, r=${p.r}, $fn=${sides});`;
  }
  if (kind === 'torus') {
    return `rotate_extrude($fn=${p.fn}) translate([${p.ringR}, 0]) circle(r=${p.tubeR}, $fn=${p.fn});`;
  }
  if (kind === 'pyramid') {
    return `linear_extrude(height=${p.h}, scale=0) square([${p.w}, ${p.w}], center=true);`;
  }
  if (kind === 'hemisphere') {
    const r = p.r;
    const n = Math.max(16, Math.round(p.fn / 2));
    const pts = ['[0,0]', `[${r},0]`];
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * (Math.PI / 2);
      pts.push(`[${(r * Math.cos(a)).toFixed(3)},${(r * Math.sin(a)).toFixed(3)}]`);
    }
    return `rotate_extrude($fn=${p.fn}) polygon([${pts.join(',')}]);`;
  }
  if (kind === 'tube') {
    const wall = Math.max(0.1, p.outR - p.inR);
    return `rotate_extrude($fn=${p.fn}) translate([${p.inR}, 0]) square([${wall}, ${p.h}]);`;
  }
  if (kind === 'capsule') {
    return `union() { cylinder(h=${p.h}, r=${p.r}, $fn=${p.fn}); sphere(r=${p.r}, $fn=${p.fn}); translate([0, 0, ${p.h}]) sphere(r=${p.r}, $fn=${p.fn}); }`;
  }
  if (kind === 'wedge') {
    return `linear_extrude(height=${p.h}) polygon([[0, 0], [${p.w}, 0], [0, ${p.d}]]);`;
  }
  if (kind === 'star') {
    const pts = starPolygonPoints(p.points, p.outR, p.inR);
    return `linear_extrude(height=${p.h}) polygon([${pts}]);`;
  }
  if (kind === 'bowl') {
    const R = p.r;
    const t = Math.max(0.1, p.thickness);
    const rIn = Math.max(0.1, R - t);
    const n = Math.max(16, Math.round(p.fn / 2));
    const pts = [];
    // Cross-section (revolved around Z): traces bowl wall in XY plane
    // Start at outer rim, go down outer arc, across bottom, up inner arc, across rim.
    pts.push(`[${R},0]`);
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * (Math.PI / 2);
      pts.push(`[${(R * Math.cos(a)).toFixed(3)},${(-R * Math.sin(a)).toFixed(3)}]`);
    }
    for (let i = n; i >= 0; i--) {
      const a = (i / n) * (Math.PI / 2);
      pts.push(`[${(rIn * Math.cos(a)).toFixed(3)},${(-rIn * Math.sin(a)).toFixed(3)}]`);
    }
    return `rotate_extrude($fn=${p.fn}) polygon([${pts.join(',')}]);`;
  }
  if (kind === 'disc') {
    return `cylinder(h=${p.h}, r=${p.r}, $fn=${p.fn});`;
  }
  if (kind === 'ellipsoid') {
    return `scale([${p.rx}, ${p.ry}, ${p.rz}]) sphere(r=1, $fn=${p.fn});`;
  }
  if (kind === 'tetrahedron') {
    const a = p.r;
    const x = (a * 0.866).toFixed(2);
    const yLow = (-a * 0.5).toFixed(2);
    return `linear_extrude(height=${p.h}, scale=0) polygon([[${-x}, ${yLow}], [${x}, ${yLow}], [0, ${a}]]);`;
  }
  if (kind === 'octahedron') {
    return `union() { linear_extrude(height=${p.h}, scale=0) square([${p.w}, ${p.w}], center=true); mirror([0, 0, 1]) linear_extrude(height=${p.h}, scale=0) square([${p.w}, ${p.w}], center=true); }`;
  }
  if (kind === 'frustum') {
    return `cylinder(h=${p.h}, r1=${p.r1}, r2=${p.r2}, $fn=${p.fn});`;
  }
  if (kind === 'spring') {
    return `linear_extrude(height=${p.h}, twist=${p.turns * 360}, $fn=${p.fn}) translate([${p.r}, 0]) circle(r=${p.tubeR}, $fn=16);`;
  }
  if (kind === 'lshape') {
    const armX = Math.max(1, p.cw);
    const armY = Math.max(1, p.cd);
    return `union() { cube([${p.w}, ${armY}, ${p.h}]); cube([${armX}, ${p.d}, ${p.h}]); }`;
  }
  if (kind === 'tshape') {
    const offY = (p.d / 2 - p.t / 2).toFixed(2);
    return `union() { cube([${p.w}, ${p.t}, ${p.h}], center=true); translate([0, ${offY}, 0]) cube([${p.t}, ${p.d}, ${p.h}], center=true); }`;
  }
  if (kind === 'cross') {
    return `union() { cube([${p.w}, ${p.t}, ${p.h}], center=true); cube([${p.t}, ${p.w}, ${p.h}], center=true); }`;
  }
  if (kind === 'stairs') {
    const steps = Math.max(2, p.steps | 0 || 4);
    const parts = [];
    for (let i = 0; i < steps; i++) {
      parts.push(`translate([${(i * p.w).toFixed(2)}, 0, ${(i * p.h).toFixed(2)}]) cube([${p.w}, ${p.d}, ${p.h}])`);
    }
    return `union() { ${parts.join('; ')}; }`;
  }
  if (kind === 'nut') {
    return `difference() { cylinder(h=${p.h}, r=${p.outR}, $fn=6); translate([0, 0, -0.5]) cylinder(h=${p.h + 1}, r=${p.holeR}, $fn=32); }`;
  }
  if (kind === 'arrow') {
    const w = p.w, h = p.h;
    const shaftW = (w * 0.6).toFixed(2);
    const yA = (h * 0.3).toFixed(2);
    const yB = (h * 0.7).toFixed(2);
    const yMid = (h * 0.5).toFixed(2);
    return `linear_extrude(height=${p.t}) polygon([[0, ${yA}], [${shaftW}, ${yA}], [${shaftW}, 0], [${w}, ${yMid}], [${shaftW}, ${h}], [${shaftW}, ${yB}], [0, ${yB}]]);`;
  }
  if (kind === 'heart') {
    const pts = [];
    const n = 40;
    const s = p.size / 17;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const x = 16 * Math.pow(Math.sin(t), 3) * s;
      const y = (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * s;
      pts.push(`[${x.toFixed(2)},${y.toFixed(2)}]`);
    }
    return `linear_extrude(height=${p.h}) polygon([${pts.join(',')}]);`;
  }
  if (kind === 'crescent') {
    const innerR = (p.r * 0.95).toFixed(2);
    return `difference() { linear_extrude(height=${p.h}) circle(r=${p.r}, $fn=${p.fn}); translate([${p.offset}, 0, -0.5]) linear_extrude(height=${p.h + 1}) circle(r=${innerR}, $fn=${p.fn}); }`;
  }
  return null;
}

function makeShapeSnippet(shape, params) {
  const p = { ...(SHAPE_DEFAULTS[shape] || {}), ...(params || {}) };
  const h3 = p.h3 || 1;
  const wrap = (inner) => `linear_extrude(height=${h3}) ${inner};`;
  if (shape === 'rectangle') {
    const w = p.w || 20, h = p.h || 20;
    const hw = w / 2, hh = h / 2;
    return wrap(`polygon([[${-hw},${-hh}],[${hw},${-hh}],[${hw},${hh}],[${-hw},${hh}]])`);
  }
  if (shape === 'circle') {
    const r = p.r || 10;
    const n = Math.max(3, p.n | 0 || 32);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push(`[${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}]`);
    }
    return wrap(`polygon([${pts.join(',')}])`);
  }
  if (shape === 'triangle') {
    return wrap('polygon([[-10,-6],[10,-6],[0,11]])');
  }
  if (shape === 'polygon') {
    return wrap('polygon([[-10,-10],[10,-10],[10,10],[-10,10]])');
  }
  return null;
}

const LABEL_ZH = {
  cube: '立方体', sphere: '球体', cylinder: '圆柱', polygon: '多边形',
  square: '正方形', circle: '圆形', translate: '平移', rotate: '旋转',
  scale: '缩放', mirror: '镜像', color: '颜色', linear_extrude: '线性拉伸',
  rotate_extrude: '旋转拉伸', union: '并集', difference: '差集',
  intersection: '交集', hull: '凸包', minkowski: '闵和', group: '组',
};

function showEditPanel(obj) {
  const panel = document.getElementById('selectionPanel');
  if (!panel) return;
  panel.hidden = false;
  const rawLabel = obj.userData?.label || 'object';
  document.getElementById('selName').textContent = LABEL_ZH[rawLabel] || rawLabel;
  const d = (n) => +Number(n).toFixed(2);
  document.getElementById('selPosX').value = d(obj.position.x);
  document.getElementById('selPosY').value = d(obj.position.y);
  document.getElementById('selPosZ').value = d(obj.position.z);
  const D = 180 / Math.PI;
  document.getElementById('selRotX').value = d(obj.rotation.x * D);
  document.getElementById('selRotY').value = d(obj.rotation.y * D);
  document.getElementById('selRotZ').value = d(obj.rotation.z * D);
  document.getElementById('selSclX').value = d(obj.scale.x);
  document.getElementById('selSclY').value = d(obj.scale.y);
  document.getElementById('selSclZ').value = d(obj.scale.z);
  const colorEl = document.getElementById('selColor');
  if (colorEl) colorEl.value = getObjectColor(obj);
  renderPrimParams(obj);
}

// ---------- Primitive parameter editor (inside selection panel) ----------

const PRIM_MODIFIER_NAMES = new Set(['translate', 'rotate', 'scale', 'mirror', 'color']);

function findInnerPrimNode(node) {
  let cur = node;
  while (cur && PRIM_MODIFIER_NAMES.has(cur.name) && cur.children?.length === 1) {
    cur = cur.children[0];
  }
  return cur;
}

function detectPrimKind(inner) {
  if (!inner) return null;
  if (inner.name === 'cube') return 'cube';
  if (inner.name === 'sphere') return 'sphere';
  if (inner.name === 'cylinder') return 'cylinder';
  if (inner.name === 'linear_extrude') return 'extrude';
  if (inner.name === 'rotate_extrude') return 'torus';
  return null;
}

const PRIM_PARAM_DEFS = {
  cube:     [['x','宽X','num'],['y','深Y','num'],['z','高Z','num'],['center','居中','bool']],
  sphere:   [['r','半径','num'],['fn','精度','int']],
  cylinder: [['h','高度','num'],['r1','底部R','num'],['r2','顶部R','num'],['fn','精度','int'],['center','居中','bool']],
  extrude:  [['h','高度','num'],['twist','扭转°','num'],['scale','缩放','num']],
  torus:    [['ringR','环半径','num'],['tubeR','管半径','num'],['fn','精度','int']],
};

function readPrimArgs(inner, kind) {
  const a = inner.args || { positional: [], named: {} };
  const num = (v, def) => (v && v.type === 'number' ? v.value : def);
  const bool = (v, def) => (v && v.type === 'bool' ? v.value : def);
  if (kind === 'cube') {
    const p0 = a.positional[0];
    let x = 20, y = 20, z = 20;
    if (p0 && p0.type === 'array' && p0.items?.length >= 3) {
      x = num(p0.items[0], 20); y = num(p0.items[1], 20); z = num(p0.items[2], 20);
    } else if (p0 && p0.type === 'number') {
      x = y = z = p0.value;
    }
    return { x, y, z, center: bool(a.named.center, false) };
  }
  if (kind === 'sphere') {
    return { r: num(a.named.r, num(a.positional[0], 10)), fn: num(a.named['$fn'], 32) };
  }
  if (kind === 'cylinder') {
    const h = num(a.named.h, num(a.positional[0], 10));
    const r = num(a.named.r, NaN);
    let r1 = num(a.named.r1, NaN);
    let r2 = num(a.named.r2, NaN);
    if (Number.isNaN(r1)) r1 = Number.isNaN(r) ? 8 : r;
    if (Number.isNaN(r2)) r2 = Number.isNaN(r) ? 8 : r;
    return { h, r1, r2, fn: num(a.named['$fn'], 32), center: bool(a.named.center, false) };
  }
  if (kind === 'extrude') {
    return {
      h: num(a.named.height, 10),
      twist: num(a.named.twist, 0),
      scale: num(a.named.scale, 1),
    };
  }
  if (kind === 'torus') {
    let ringR = 12, tubeR = 3;
    const fn = num(a.named['$fn'], 48);
    const tr = inner.children?.[0];
    if (tr && tr.name === 'translate' && tr.args?.positional[0]?.type === 'array') {
      ringR = num(tr.args.positional[0].items[0], 12);
      const c = tr.children?.[0];
      if (c && c.name === 'circle') {
        tubeR = num(c.args.named?.r, num(c.args.positional?.[0], 3));
      }
    }
    return { ringR, tubeR, fn };
  }
  return null;
}

function writePrimArg(inner, kind, key, value) {
  const a = inner.args || (inner.args = { positional: [], named: {} });
  const setNum = (v) => ({ type: 'number', value: Number(v) });
  const setBool = (v) => ({ type: 'bool', value: !!v });
  if (kind === 'cube') {
    if (!a.positional[0] || a.positional[0].type !== 'array') {
      a.positional[0] = { type: 'array', items: [setNum(20), setNum(20), setNum(20)] };
    }
    while (a.positional[0].items.length < 3) a.positional[0].items.push(setNum(20));
    if (key === 'x') a.positional[0].items[0] = setNum(value);
    if (key === 'y') a.positional[0].items[1] = setNum(value);
    if (key === 'z') a.positional[0].items[2] = setNum(value);
    if (key === 'center') a.named.center = setBool(value);
    return true;
  }
  if (kind === 'sphere') {
    if (key === 'r') { a.named.r = setNum(value); a.positional = []; }
    if (key === 'fn') a.named['$fn'] = setNum(value);
    return true;
  }
  if (kind === 'cylinder') {
    if (key === 'h') { a.named.h = setNum(value); a.positional = []; }
    if (key === 'r1') { a.named.r1 = setNum(value); delete a.named.r; }
    if (key === 'r2') { a.named.r2 = setNum(value); delete a.named.r; }
    if (key === 'fn') a.named['$fn'] = setNum(value);
    if (key === 'center') a.named.center = setBool(value);
    return true;
  }
  if (kind === 'extrude') {
    if (key === 'h') a.named.height = setNum(value);
    if (key === 'twist') a.named.twist = setNum(value);
    if (key === 'scale') a.named.scale = setNum(value);
    return true;
  }
  if (kind === 'torus') {
    if (key === 'fn') a.named['$fn'] = setNum(value);
    const tr = inner.children?.[0];
    if (!tr || tr.name !== 'translate' || tr.args?.positional[0]?.type !== 'array') return true;
    if (key === 'ringR') tr.args.positional[0].items[0] = setNum(value);
    const c = tr.children?.[0];
    if (c && c.name === 'circle' && key === 'tubeR') {
      c.args.named.r = setNum(value);
      c.args.positional = [];
    }
    return true;
  }
  return false;
}

function renderPrimParams(obj) {
  const block = document.getElementById('primParams');
  const grid = document.getElementById('primParamsGrid');
  if (!block || !grid) return;
  grid.innerHTML = '';
  const ast = ensureCurrentAst();
  // Re-resolve the node from the live AST via vNodeId so we mutate the right
  // tree (obj.userData.astNode may be a stale reference after re-parsing).
  const outerId = obj.userData?.vNodeId;
  const f = outerId ? findById(ast, outerId) : null;
  const outerNode = f ? f.node : obj.userData?.astNode;
  if (!outerNode) { block.hidden = true; return; }
  const inner = findInnerPrimNode(outerNode);
  const kind = detectPrimKind(inner);
  const defs = PRIM_PARAM_DEFS[kind];
  if (!defs) { block.hidden = true; return; }
  const values = readPrimArgs(inner, kind);
  if (!values) { block.hidden = true; return; }
  block.hidden = false;

  for (const [key, label, type] of defs) {
    const wrap = document.createElement('label');
    if (type === 'bool') {
      wrap.classList.add('checkbox-inline');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!values[key];
      cb.addEventListener('change', () => commitPrimParam(obj, key, cb.checked));
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode(label));
    } else {
      wrap.appendChild(document.createTextNode(label));
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = type === 'int' ? '1' : '0.1';
      if (type === 'int') inp.min = '3';
      inp.value = values[key];
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        commitPrimParam(obj, key, v);
      });
      wrap.appendChild(inp);
    }
    grid.appendChild(wrap);
  }
}

function commitPrimParam(obj, key, value) {
  const ast = ensureCurrentAst();
  const outerId = obj.userData?.vNodeId;
  if (!outerId) return;
  const f = findById(ast, outerId);
  if (!f) return;
  const inner = findInnerPrimNode(f.node);
  const kind = detectPrimKind(inner);
  if (!kind) return;
  pushAstHistory();
  writePrimArg(inner, kind, key, value);
  commitVdomToTextarea(outerId, null);
}

function applyEditPanelToObject() {
  if (!selectedObject) return;
  const get = (id) => parseFloat(document.getElementById(id).value) || 0;
  selectedObject.position.set(get('selPosX'), get('selPosY'), get('selPosZ'));
  const D = Math.PI / 180;
  selectedObject.rotation.set(get('selRotX') * D, get('selRotY') * D, get('selRotZ') * D);
  const sx = parseFloat(document.getElementById('selSclX').value);
  const sy = parseFloat(document.getElementById('selSclY').value);
  const sz = parseFloat(document.getElementById('selSclZ').value);
  selectedObject.scale.set(
    Number.isFinite(sx) && sx > 0 ? sx : 1,
    Number.isFinite(sy) && sy > 0 ? sy : 1,
    Number.isFinite(sz) && sz > 0 ? sz : 1,
  );
  if (selectionBox) selectionBox.update();
}

function fmtNum(n) {
  if (!Number.isFinite(n) || Math.abs(n) < 0.001) return '0';
  return (Math.round(n * 100) / 100).toString();
}

// Strip leading calls whose names are in `names` so successive applies don't stack.
function stripLeadingCalls(src, names) {
  let pos = 0;
  while (pos < src.length && /\s/.test(src[pos])) pos++;
  while (true) {
    const m = src.slice(pos).match(/^([a-zA-Z_]\w*)\s*\(/);
    if (!m || !names.has(m[1])) break;
    let i = pos + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    if (depth !== 0) break;
    pos = i;
    while (pos < src.length && /\s/.test(src[pos])) pos++;
  }
  return src.slice(pos);
}

const DEFAULT_OBJECT_COLOR = '#f2b154';

function getObjectColor(obj) {
  let found = null;
  obj.traverse((o) => {
    if (found) return;
    if (o.isMesh && o.material && o.material.color) {
      found = '#' + o.material.color.getHexString();
    }
  });
  return found || DEFAULT_OBJECT_COLOR;
}

function applyTransformToCode() {
  applyAllToCode();
}

// Unified apply: strip leading transforms + color, then re-wrap with the
// selection's current transform + the picker's current color.
function applyAllToCode() {
  if (!selectedObject || !window.OspedAPI) return;
  const ud = selectedObject.userData;
  const targetId = ud && ud.vNodeId;
  if (!targetId) return;

  pushAstHistory();
  const ast = ensureCurrentAst();
  const pos = { x: selectedObject.position.x, y: selectedObject.position.y, z: selectedObject.position.z };
  const rot = { x: selectedObject.rotation.x, y: selectedObject.rotation.y, z: selectedObject.rotation.z };
  const scl = { x: selectedObject.scale.x, y: selectedObject.scale.y, z: selectedObject.scale.z };
  const colorPicker = document.getElementById('selColor');
  const color = colorPicker ? colorPicker.value : DEFAULT_OBJECT_COLOR;

  const newOuter = applyTransformsToNode(ast, targetId, {
    pos, rot, scale: scl, color, defaultColor: DEFAULT_OBJECT_COLOR,
  });
  if (!newOuter) return;

  // After rebuild, re-select by the new outer's id (stable; we just minted it)
  commitVdomToTextarea(newOuter.id, null);
}

function deleteSelectedFromCode() {
  if (!selectedObject || !window.OspedAPI) return;
  const ud = selectedObject.userData;
  if (!ud || !ud.vNodeId) return;
  pushAstHistory();
  const ast = ensureCurrentAst();
  if (!deleteById(ast, ud.vNodeId)) return;
  commitVdomToTextarea(null, null);
}

function flipSelected(axis) {
  if (!selectedObject) return;
  const ud = selectedObject.userData;
  if (!ud || !ud.vNodeId) return;
  pushAstHistory();
  const ast = ensureCurrentAst();
  const newOuter = mirrorNodeById(ast, ud.vNodeId, axis);
  if (!newOuter) return;
  commitVdomToTextarea(newOuter.id, null);
}

// ---------- Quick Align ----------
// face: '+x'|'-x'|'+y'|'-y'|'+z'|'-z'  — which face of A to dock B onto
// mode: 'center' | 'min' | 'max'        — how to align in the plane orthogonal to that face
function applyQuickAlign(face, mode) {
  if (multiSelected.size !== 2) {
    alert('请先在场景树或视口里多选 2 个物体（按住 ⌘/Ctrl 加选）。');
    return;
  }
  const m = /^([+-])([xyz])$/i.exec(face || '');
  if (!m) { alert('无效的参考面：' + face); return; }
  const sign = m[1] === '-' ? -1 : 1;
  const axis = m[2].toLowerCase();
  const evalRoot = meshGroup && meshGroup.children[0];
  if (!evalRoot) return;
  const indices = Array.from(multiSelected).sort((a, b) => a - b);
  const idxA = indices[0];
  const idxB = indices[1];
  const meshA = evalRoot.children[idxA];
  const meshB = evalRoot.children[idxB];
  if (!meshA || !meshB) { alert('无法定位选中的物体（场景已变化），请重新选择。'); return; }
  const bId = meshB.userData?.vNodeId;
  if (!bId) { alert('B 物体缺少 vNodeId，请重新选择。'); return; }

  // Use axis-aligned world bounding boxes (limitation: if B is rotated, AABB
  // may be larger than the visual hull — face contact will be approximate).
  meshGroup.updateMatrixWorld(true);
  const boxA = new THREE.Box3().setFromObject(meshA);
  const boxB = new THREE.Box3().setFromObject(meshB);
  if (boxA.isEmpty() || boxB.isEmpty()) {
    alert('选中物体的包围盒为空，无法对齐。');
    return;
  }

  const axes = ['x', 'y', 'z'];
  const others = axes.filter((a) => a !== axis);

  const planeA = sign > 0 ? boxA.max[axis] : boxA.min[axis];
  const planeB = sign > 0 ? boxB.min[axis] : boxB.max[axis];
  const delta = { x: 0, y: 0, z: 0 };
  delta[axis] = planeA - planeB;

  for (const a of others) {
    if (mode === 'min') {
      delta[a] = boxA.min[a] - boxB.min[a];
    } else if (mode === 'max') {
      delta[a] = boxA.max[a] - boxB.max[a];
    } else {
      // center
      const cA = (boxA.min[a] + boxA.max[a]) / 2;
      const cB = (boxB.min[a] + boxB.max[a]) / 2;
      delta[a] = cA - cB;
    }
  }

  pushAstHistory();
  const ast = ensureCurrentAst();
  const newOuter = addOuterTranslateById(ast, bId, delta);
  if (!newOuter) {
    alert('快速对齐失败：未找到目标节点。');
    return;
  }
  // Preserve multi-selection after rebuild so the user can keep iterating.
  // multiSelected indices are stable as long as we didn't reorder top-level
  // nodes — which addOuterTranslateById doesn't. existing rebuild logic
  // restores multiSelected when its size > 1, so just commit and let it run.
  commitVdomToTextarea(null, null);
}

function applyTwistScale(geometry, height, twistDeg, scale) {
  const pos = geometry.attributes.position;
  const twistRad = (twistDeg * Math.PI) / 180;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = height === 0 ? 0 : z / height;
    const a = t * twistRad;
    const s = 1 + (scale - 1) * t;
    const rx = (x * Math.cos(a) - y * Math.sin(a)) * s;
    const ry = (x * Math.sin(a) + y * Math.cos(a)) * s;
    pos.setXYZ(i, rx, ry, z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

// ---------- AstAPI: expose current selection as OpenSCAD code ----------
// Consumed by project.js (component library). Single selection serializes the
// selected object's AST subtree; multi-selection serializes each top-level
// selected node in document order.
window.AstAPI = {
  // Test-only: snapshot the visibility of viewport helpers. Tests assert
  // these are all true AFTER exportObj() has finished restoring them.
  _helpersVisible() {
    return {
      grid: !!(gridHelper && gridHelper.visible),
      axes: !!(axesHelper && axesHelper.visible),
      lines: (() => {
        if (!meshGroup) return null;
        let any = false, hidden = 0, total = 0;
        meshGroup.traverse((o) => {
          if (o.isLineSegments) { total++; if (!o.visible) hidden++; else any = true; }
        });
        return { total, hidden, anyVisible: any };
      })(),
    };
  },
  hasSelection() {
    return multiSelected.size > 0 || !!selectedObject;
  },
  getSelectionLabel() {
    if (multiSelected.size > 1) return `${multiSelected.size} 个对象`;
    if (selectedObject?.userData?.label) return selectedObject.userData.label;
    return '对象';
  },
  getSelectionCode() {
    const nodes = [];
    if (multiSelected.size > 0) {
      const indices = Array.from(multiSelected).sort((a, b) => a - b);
      for (const idx of indices) {
        const n = currentAst[idx];
        if (n) nodes.push(n);
      }
    } else if (selectedObject && selectedObject.userData?.astNode) {
      nodes.push(selectedObject.userData.astNode);
    }
    if (!nodes.length) return null;
    try {
      return serializeAst(nodes);
    } catch (err) {
      console.error('[AstAPI] serialize failed', err);
      return null;
    }
  },
  clearSelection() {
    if (typeof clearMultiSelection === 'function') clearMultiSelection();
    selectMesh(null);
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireControls);
} else {
  wireControls();
}
