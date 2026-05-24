import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parse, evaluate } from './openscad.js';

const $ = (s) => document.querySelector(s);

const container = $('#viewport3d');
const hintEl = $('#viewport3dHint');
const debugEl = $('#viewport3dDebug');
let scene, camera, renderer, controls, meshGroup, gridHelper, axesHelper;
let initialized = false;
let needsRebuild = false;
let hasAutoFramed = false;

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
  height: 10,
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
  setDebug('WebGL unavailable', true);
  if (hintEl) {
    hintEl.innerHTML =
      '<div style="text-align:left; max-width:420px;">' +
      '<strong style="color:#fecaca;">3D unavailable — WebGL is disabled in this browser.</strong>' +
      '<div style="margin-top:8px; font-size:12px; color:#cbd5e1;">' +
      'Fix it:' +
      '<ol style="margin:6px 0 0 18px; padding:0; line-height:1.6;">' +
      '<li>Chrome / Edge: <code>chrome://settings/system</code> → enable <em>"Use graphics acceleration when available"</em>, then restart the browser.</li>' +
      '<li>Then visit <code>chrome://gpu</code> — WebGL should say "Hardware accelerated".</li>' +
      '<li>If still disabled: <code>chrome://flags/#ignore-gpu-blocklist</code> → Enabled, restart.</li>' +
      '<li>Or use Firefox / Safari (about:support → WebGL).</li>' +
      '</ol>' +
      (detail ? '<div style="margin-top:8px; color:#94a3b8;">Detail: ' + detail + '</div>' : '') +
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

  const ro = new ResizeObserver(() => resize());
  ro.observe(container);

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
  settings.mode = $('#extrudeMode').value;
  settings.height = parseFloat($('#extrudeHeight').value) || 10;
  settings.twist = parseFloat($('#extrudeTwist').value) || 0;
  settings.scale = parseFloat($('#extrudeScale').value) || 1;
  settings.segments = parseInt($('#extrudeSegments').value, 10) || 64;
  settings.angle = parseFloat($('#extrudeAngle').value) || 360;
}

function doBuildMeshes() {
  if (initialized !== true) return;
  disposeGroup(meshGroup);
  if (!window.OspedAPI) {
    setDebug('OspedAPI missing', true);
    return;
  }

  const code = (window.OspedAPI.getCode && window.OspedAPI.getCode()) || '';
  readSettings();

  let ast = [];
  try {
    ast = parse(code);
  } catch (err) {
    setDebug('parse error: ' + err.message, true);
    console.error('[3D] parse failed', err);
    return;
  }

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

function buildOpenSCAD3DCode() {
  if (!window.OspedAPI) return '';
  const paths = window.OspedAPI.getPaths();
  readSettings();
  let out = '';
  for (const path of paths) {
    if (!path.points || path.points.length < 3) continue;
    const pts = path.points.map((p) => `[${p.x},${p.y}]`).join(',');
    if (settings.mode === 'linear') {
      const opts = [`height=${settings.height}`];
      if (settings.twist) opts.push(`twist=${settings.twist}`);
      if (settings.scale !== 1) opts.push(`scale=${settings.scale}`);
      out += `linear_extrude(${opts.join(', ')}) polygon([${pts}]);\n`;
    } else {
      const opts = [];
      if (settings.angle !== 360) opts.push(`angle=${settings.angle}`);
      opts.push(`$fn=${settings.segments}`);
      out += `rotate_extrude(${opts.join(', ')}) polygon([${pts}]);\n`;
    }
  }
  return out;
}

async function copy3DCode() {
  const code = buildOpenSCAD3DCode();
  if (!code) {
    alert('No paths with at least 3 points to extrude.');
    return;
  }
  try {
    await navigator.clipboard.writeText(code);
    flash($('#copy3DBtn'), 'Copied!');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = code;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    flash($('#copy3DBtn'), 'Copied!');
  }
}

function flash(btn, msg) {
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = orig; }, 1200);
}

function show3D() {
  document.body.classList.add('three-enabled');
  container.hidden = false;
  $('#viewport3dStatus').hidden = false;
  $('#fullscreen3DBtn').disabled = false;
  const btn = $('#enable3DBtn');
  btn.textContent = 'Hide 3D View';
  btn.classList.add('active');
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

function hide3D() {
  document.body.classList.remove('three-enabled');
  document.body.classList.remove('three-fullscreen');
  container.hidden = true;
  $('#viewport3dStatus').hidden = true;
  $('#fullscreen3DBtn').disabled = true;
  $('#fullscreen3DBtn').textContent = 'Fullscreen 3D';
  const btn = $('#enable3DBtn');
  btn.textContent = 'Show 3D View';
  btn.classList.remove('active');
  setTimeout(() => { window.OspedAPI?.resize2D(); }, 50);
}

function wireControls() {
  $('#enable3DBtn').addEventListener('click', () => {
    if (document.body.classList.contains('three-enabled')) hide3D();
    else show3D();
  });

  $('#fullscreen3DBtn').addEventListener('click', () => {
    const on = document.body.classList.toggle('three-fullscreen');
    $('#fullscreen3DBtn').textContent = on ? 'Exit Fullscreen' : 'Fullscreen 3D';
    requestAnimationFrame(() => {
      resize();
      if (on) { hasAutoFramed = false; scheduleBuild(); }
      window.OspedAPI?.resize2D();
    });
  });

  $('#extrudeMode').addEventListener('change', (e) => {
    $('#linearControls').hidden = e.target.value !== 'linear';
    $('#rotateControls').hidden = e.target.value !== 'rotate';
    scheduleBuild();
  });

  ['extrudeHeight', 'extrudeTwist', 'extrudeScale', 'extrudeSegments', 'extrudeAngle']
    .forEach((id) => $('#' + id).addEventListener('input', scheduleBuild));

  $('#resetCameraBtn').addEventListener('click', () => initialized && resetCamera());
  $('#copy3DBtn').addEventListener('click', copy3DCode);

  if (window.OspedAPI) {
    window.OspedAPI.onChange(scheduleBuild);
  }

  const demoBtn = $('#runDemoBtn');
  if (demoBtn) {
    demoBtn.addEventListener('click', () => runDemo());
  }

  // Primitive insert buttons
  document.querySelectorAll('.prim-grid button[data-snippet]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const snippet = btn.dataset.snippet;
      if (window.OspedAPI && window.OspedAPI.appendCode) {
        window.OspedAPI.appendCode(snippet);
      }
      // Make sure 3D is visible after inserting
      if (!document.body.classList.contains('three-enabled')) {
        $('#enable3DBtn').click();
      } else {
        hasAutoFramed = false;
        scheduleBuild();
      }
    });
  });

  const loadBtn = $('#loadExampleBtn');
  if (loadBtn) {
    loadBtn.addEventListener('click', () => {
      const ta = $('#exportArea');
      if (!ta) return;
      ta.value = EXAMPLE_SCENE;
      ta.dispatchEvent(new Event('input'));
      hasAutoFramed = false;
      if (!document.body.classList.contains('three-enabled')) $('#enable3DBtn').click();
      else scheduleBuild();
    });
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
}

function runDemo() {
  // 1. ensure 3D viewport is opened & initialized
  if (!document.body.classList.contains('three-enabled')) {
    show3D();
  }
  // wait until WebGL is up
  const tryRender = (attempt) => {
    if (initialized !== true) {
      if (attempt > 30) { console.error('[3D] demo: init never completed'); return; }
      requestAnimationFrame(() => tryRender(attempt + 1));
      return;
    }
    // 2. wipe scene
    disposeGroup(meshGroup);
    setHintVisible(false);

    // 3. hardcoded scene — no parser, no OspedAPI, no extrudes
    const colors = [0xf2b154, 0xef4444, 0x22c55e, 0x60a5fa, 0xeab308];
    function mat(c) {
      return new THREE.MeshStandardMaterial({
        color: c, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide,
      });
    }

    const plate = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 3), mat(colors[3]));
    plate.position.set(0, 0, 1.5);
    meshGroup.add(plate);

    const cube = new THREE.Mesh(new THREE.BoxGeometry(12, 12, 12), mat(colors[0]));
    cube.position.set(-12, -12, 9);
    meshGroup.add(cube);

    const sphere = new THREE.Mesh(new THREE.SphereGeometry(7, 48, 24), mat(colors[1]));
    sphere.position.set(12, -12, 10);
    meshGroup.add(sphere);

    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 7, 14, 32), mat(colors[2]));
    cone.geometry.rotateX(Math.PI / 2);
    cone.geometry.translate(0, 0, 7);
    cone.position.set(12, 12, 3);
    meshGroup.add(cone);

    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 12, 32), mat(colors[4]));
    cyl.geometry.rotateX(Math.PI / 2);
    cyl.geometry.translate(0, 0, 6);
    cyl.position.set(-12, 12, 3);
    meshGroup.add(cyl);

    // 4. frame
    hasAutoFramed = true;
    meshGroup.updateMatrixWorld(true);
    frameToGeometry();
    // Cancel any pending parser-driven rebuild that show3D scheduled,
    // otherwise the next animate tick will dispose our demo meshes.
    needsRebuild = false;
    setDebug('demo: 5 hardcoded meshes (no parser)');
    console.log('[3D] demo rendered:', meshGroup.children.length, 'meshes');
  };
  requestAnimationFrame(() => tryRender(0));
}

const EXAMPLE_SCENE = [
  '// OpenSCAD example — edit and the 3D view updates live',
  'color("steelblue") cube([30, 30, 4], center=true);',
  'translate([0, 0, 12]) color("tomato") sphere(r=8, $fn=48);',
  'translate([20, 0, 6]) color("seagreen") cylinder(h=12, r1=6, r2=2, $fn=48);',
  'translate([-20, 0, 0]) rotate([0, 0, 45])',
  '  linear_extrude(height=10, twist=60, scale=0.4)',
  '    polygon([[-5,-5],[5,-5],[5,5],[-5,5]]);',
  '',
].join('\n');

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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireControls);
} else {
  wireControls();
}
