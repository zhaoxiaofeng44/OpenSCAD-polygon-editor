// Minimal OpenSCAD parser + Three.js evaluator.
// Supports a useful subset for visual editing:
//   primitives   : cube, sphere, cylinder, polygon, square, circle
//   transforms   : translate, rotate, scale, mirror
//   extrusions   : linear_extrude, rotate_extrude
//   modifiers    : color
//   CSG groups   : union, difference, intersection, hull, minkowski
//                  (rendered as union — true boolean ops are TODO)
//   comments     : // and /* */
//   special vars : $fn (per-call named arg)
//
// Not supported: arithmetic in expressions, modules / functions, includes.

import * as THREE from 'three';

const TWO_D_PRIMS = new Set(['polygon', 'square', 'circle']);

// ---------- Tokenizer ----------

function tokenize(src) {
  const tokens = [];
  let pos = 0;
  const len = src.length;

  function lastTokenIsValue() {
    if (!tokens.length) return false;
    const t = tokens[tokens.length - 1].type;
    return t === 'number' || t === 'ident' || t === 'rparen' || t === 'rbracket';
  }

  while (pos < len) {
    // whitespace
    while (pos < len && /\s/.test(src[pos])) pos++;
    if (pos >= len) break;

    // line comment
    if (src[pos] === '/' && src[pos + 1] === '/') {
      while (pos < len && src[pos] !== '\n') pos++;
      continue;
    }
    // block comment
    if (src[pos] === '/' && src[pos + 1] === '*') {
      pos += 2;
      while (pos < len - 1 && !(src[pos] === '*' && src[pos + 1] === '/')) pos++;
      pos = Math.min(pos + 2, len);
      continue;
    }

    const c = src[pos];

    // number (with optional unary minus when not after a value)
    const isUnaryMinus = c === '-' && !lastTokenIsValue() && /[\d.]/.test(src[pos + 1] || '');
    if (/[\d.]/.test(c) || isUnaryMinus) {
      let s = '';
      if (c === '-') { s = '-'; pos++; }
      while (pos < len && /[\d.]/.test(src[pos])) s += src[pos++];
      if (pos < len && /[eE]/.test(src[pos])) {
        s += src[pos++];
        if (pos < len && (src[pos] === '+' || src[pos] === '-')) s += src[pos++];
        while (pos < len && /\d/.test(src[pos])) s += src[pos++];
      }
      const n = parseFloat(s);
      if (Number.isFinite(n)) tokens.push({ type: 'number', value: n });
      continue;
    }

    // identifier
    if (/[a-zA-Z_$]/.test(c)) {
      let s = '';
      while (pos < len && /[a-zA-Z0-9_$]/.test(src[pos])) s += src[pos++];
      if (s === 'true' || s === 'false') tokens.push({ type: 'bool', value: s === 'true' });
      else if (s === 'undef') tokens.push({ type: 'undef' });
      else tokens.push({ type: 'ident', value: s });
      continue;
    }

    // string
    if (c === '"' || c === "'") {
      const q = c; pos++;
      let s = '';
      while (pos < len && src[pos] !== q) {
        if (src[pos] === '\\' && pos + 1 < len) { s += src[pos + 1]; pos += 2; continue; }
        s += src[pos++];
      }
      pos++;
      tokens.push({ type: 'string', value: s });
      continue;
    }

    // punctuation
    const punct = { '(': 'lparen', ')': 'rparen', '[': 'lbracket', ']': 'rbracket',
                    '{': 'lbrace', '}': 'rbrace', ',': 'comma', ';': 'semicolon', '=': 'equals' };
    if (punct[c]) { tokens.push({ type: punct[c] }); pos++; continue; }

    // unknown char — skip
    pos++;
  }

  return tokens;
}

// ---------- Parser ----------

export function parse(src) {
  const tokens = tokenize(src);
  const state = { tokens, pos: 0 };
  const out = [];
  while (state.pos < tokens.length) {
    const before = state.pos;
    try {
      const stmt = parseStatement(state);
      if (stmt) out.push(stmt);
    } catch (err) {
      console.warn('[openscad] parse error:', err.message);
      // recover by skipping the next token
      state.pos = Math.max(before + 1, state.pos);
    }
    if (state.pos === before) state.pos++;
  }
  return out;
}

function parseStatement(state) {
  const t = state.tokens[state.pos];
  if (!t) return null;

  // standalone ;
  if (t.type === 'semicolon') { state.pos++; return null; }

  if (t.type === 'ident') {
    const next = state.tokens[state.pos + 1];
    // assignment "name = value;" — skip
    if (next && next.type === 'equals') {
      state.pos += 2;
      // skip value
      try { parseValue(state); } catch { /* ignore */ }
      if (state.tokens[state.pos] && state.tokens[state.pos].type === 'semicolon') state.pos++;
      return null;
    }
    if (next && next.type === 'lparen') {
      return parseCall(state);
    }
  }

  // unknown — caller will advance
  return null;
}

function parseCall(state) {
  const name = state.tokens[state.pos++].value;
  expect(state, 'lparen');
  const args = { positional: [], named: {} };
  while (state.tokens[state.pos] && state.tokens[state.pos].type !== 'rparen') {
    const t = state.tokens[state.pos];
    const tn = state.tokens[state.pos + 1];
    if (t.type === 'ident' && tn && tn.type === 'equals') {
      const argName = t.value;
      state.pos += 2;
      args.named[argName] = parseValue(state);
    } else {
      args.positional.push(parseValue(state));
    }
    if (state.tokens[state.pos] && state.tokens[state.pos].type === 'comma') state.pos++;
  }
  expect(state, 'rparen');

  const node = { type: 'call', name, args, children: [] };

  // block { ... } OR semicolon OR chained call
  const after = state.tokens[state.pos];
  if (after && after.type === 'lbrace') {
    state.pos++;
    while (state.tokens[state.pos] && state.tokens[state.pos].type !== 'rbrace') {
      const before = state.pos;
      const c = parseStatement(state);
      if (c) node.children.push(c);
      if (state.pos === before) state.pos++;
    }
    if (state.tokens[state.pos]) state.pos++; // consume rbrace
  } else if (after && after.type === 'semicolon') {
    state.pos++;
  } else if (after && after.type === 'ident') {
    const c = parseStatement(state);
    if (c) node.children.push(c);
  }

  return node;
}

function parseValue(state) {
  const t = state.tokens[state.pos];
  if (!t) throw new Error('Unexpected end');
  switch (t.type) {
    case 'number': state.pos++; return { type: 'number', value: t.value };
    case 'string': state.pos++; return { type: 'string', value: t.value };
    case 'bool':   state.pos++; return { type: 'bool', value: t.value };
    case 'undef':  state.pos++; return { type: 'undef' };
    case 'ident':  state.pos++; return { type: 'ident', value: t.value };
    case 'lbracket': return parseArray(state);
  }
  throw new Error('Unexpected token: ' + t.type);
}

function parseArray(state) {
  state.pos++; // [
  const items = [];
  while (state.tokens[state.pos] && state.tokens[state.pos].type !== 'rbracket') {
    items.push(parseValue(state));
    if (state.tokens[state.pos] && state.tokens[state.pos].type === 'comma') state.pos++;
  }
  if (state.tokens[state.pos]) state.pos++; // ]
  return { type: 'array', items };
}

function expect(state, type) {
  const t = state.tokens[state.pos];
  if (!t || t.type !== type) throw new Error('Expected ' + type + ' got ' + (t && t.type));
  state.pos++;
  return t;
}

// ---------- Evaluator ----------

export function evaluate(ast, options = {}) {
  const ctx = {
    $fn: options.$fn || 32,
    color: null,
    defaultMaterial: options.defaultMaterial || makeDefaultMaterial(),
    autoExtrude: !!options.autoExtrude,
    autoExtrudeSettings: options.autoExtrudeSettings || null,
  };
  const root = new THREE.Group();
  for (const node of ast) {
    let obj;
    if (
      ctx.autoExtrude &&
      ctx.autoExtrudeSettings &&
      node.type === 'call' &&
      TWO_D_PRIMS.has(node.name)
    ) {
      obj = evaluateAutoExtrude(node, ctx);
    } else {
      obj = evaluateNode(node, ctx);
    }
    if (obj) root.add(obj);
  }
  return root;
}

function evaluateAutoExtrude(node, ctx) {
  const s = ctx.autoExtrudeSettings;
  const wrapperName = s.mode === 'rotate' ? 'rotate_extrude' : 'linear_extrude';
  const named = {};
  if (s.mode === 'rotate') {
    if (s.angle !== undefined) named.angle = { type: 'number', value: s.angle };
    if (s.segments !== undefined) named.$fn = { type: 'number', value: s.segments };
  } else {
    if (s.height !== undefined) named.height = { type: 'number', value: s.height };
    if (s.twist) named.twist = { type: 'number', value: s.twist };
    if (s.scale !== undefined && s.scale !== 1) named.scale = { type: 'number', value: s.scale };
  }
  const wrapper = {
    type: 'call', name: wrapperName,
    args: { positional: [], named },
    children: [node],
  };
  return evaluateNode(wrapper, ctx);
}

function evaluateNode(node, ctx) {
  if (!node || node.type !== 'call') return null;
  switch (node.name) {
    case 'cube':           return makeCube(node.args, ctx);
    case 'sphere':         return makeSphere(node.args, ctx);
    case 'cylinder':       return makeCylinder(node.args, ctx);
    case 'polygon':        return makePolygonFlat(node.args, ctx);
    case 'square':         return makeSquareFlat(node.args, ctx);
    case 'circle':         return makeCircleFlat(node.args, ctx);
    case 'translate':      return wrapTransform(node, ctx, 'translate');
    case 'rotate':         return wrapTransform(node, ctx, 'rotate');
    case 'scale':          return wrapTransform(node, ctx, 'scale');
    case 'mirror':         return wrapTransform(node, ctx, 'mirror');
    case 'color':          return wrapColor(node, ctx);
    case 'linear_extrude': return makeLinearExtrude(node.args, node.children, ctx);
    case 'rotate_extrude': return makeRotateExtrude(node.args, node.children, ctx);
    case 'union':
    case 'difference':
    case 'intersection':
    case 'hull':
    case 'minkowski':
    case 'group':          return evaluateGroup(node.children, ctx);
    default:
      console.warn('[openscad] unsupported:', node.name);
      return null;
  }
}

function evaluateGroup(children, ctx) {
  const g = new THREE.Group();
  for (const c of children) {
    const o = evaluateNode(c, ctx);
    if (o) g.add(o);
  }
  return g;
}

// ---------- Value helpers ----------

function num(v, def) {
  if (v && v.type === 'number') return v.value;
  return def;
}
function bool(v, def) {
  if (v && v.type === 'bool') return v.value;
  return def;
}
function vec3(v, def) {
  if (v && v.type === 'array' && v.items.length >= 2) {
    return [
      num(v.items[0], def[0]),
      num(v.items[1], def[1]),
      v.items.length >= 3 ? num(v.items[2], def[2]) : def[2],
    ];
  }
  return def;
}
function points2D(v) {
  if (!v || v.type !== 'array') return [];
  const out = [];
  for (const item of v.items) {
    if (item.type === 'array' && item.items.length >= 2) {
      const x = num(item.items[0], NaN), y = num(item.items[1], NaN);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
    }
  }
  return out;
}

// ---------- Material ----------

function makeDefaultMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xf2b154, metalness: 0.15, roughness: 0.55,
    side: THREE.DoubleSide, flatShading: false,
  });
}
function materialFor(ctx) {
  if (!ctx.color) return ctx.defaultMaterial;
  return new THREE.MeshStandardMaterial({
    color: ctx.color, metalness: 0.15, roughness: 0.55,
    side: THREE.DoubleSide, flatShading: false,
  });
}

// ---------- Primitives ----------

function makeCube(args, ctx) {
  const sizeArg = args.named.size || args.positional[0];
  let sx = 1, sy = 1, sz = 1;
  if (sizeArg && sizeArg.type === 'array') {
    [sx, sy, sz] = vec3(sizeArg, [1, 1, 1]);
  } else if (sizeArg && sizeArg.type === 'number') {
    sx = sy = sz = sizeArg.value;
  }
  const center = bool(args.named.center, false) || bool(args.positional[1], false);
  const geom = new THREE.BoxGeometry(sx, sy, sz);
  const mesh = new THREE.Mesh(geom, materialFor(ctx));
  if (!center) mesh.position.set(sx / 2, sy / 2, sz / 2);
  return mesh;
}

function makeSphere(args, ctx) {
  let r = num(args.named.r, num(args.positional[0], null));
  if (r === null) {
    const d = num(args.named.d, null);
    r = d !== null ? d / 2 : 1;
  }
  const fn = num(args.named.$fn, ctx.$fn);
  const seg = Math.max(8, Math.round(fn));
  const geom = new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg / 2)));
  return new THREE.Mesh(geom, materialFor(ctx));
}

function makeCylinder(args, ctx) {
  const h = num(args.named.h, num(args.positional[0], 1));
  let r1 = num(args.named.r1, null);
  let r2 = num(args.named.r2, null);
  if (r1 === null && r2 === null) {
    let r = num(args.named.r, num(args.positional[1], null));
    if (r === null) {
      const d = num(args.named.d, null);
      r = d !== null ? d / 2 : 1;
    }
    r1 = r2 = r;
  }
  if (r1 === null) r1 = 1;
  if (r2 === null) r2 = 1;
  const fn = num(args.named.$fn, ctx.$fn);
  const center = bool(args.named.center, false);
  const seg = Math.max(8, Math.round(fn));
  // OpenSCAD cylinder is along +Z; CylinderGeometry is along +Y
  const geom = new THREE.CylinderGeometry(r2, r1, h, seg);
  geom.rotateX(Math.PI / 2);
  geom.translate(0, 0, h / 2);
  if (center) geom.translate(0, 0, -h / 2);
  return new THREE.Mesh(geom, materialFor(ctx));
}

// ---------- 2D primitives (rendered as flat meshes at z=0) ----------

function polygonShape(args) {
  const pts = points2D(args.named.points || args.positional[0]);
  if (pts.length < 3) return null;
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  return shape;
}

function squareShape(args) {
  const sizeArg = args.named.size || args.positional[0];
  let sx = 1, sy = 1;
  if (sizeArg && sizeArg.type === 'array') {
    [sx, sy] = vec3(sizeArg, [1, 1, 0]);
  } else if (sizeArg && sizeArg.type === 'number') {
    sx = sy = sizeArg.value;
  }
  const center = bool(args.named.center, false);
  const shape = new THREE.Shape();
  const x0 = center ? -sx / 2 : 0;
  const y0 = center ? -sy / 2 : 0;
  shape.moveTo(x0, y0);
  shape.lineTo(x0 + sx, y0);
  shape.lineTo(x0 + sx, y0 + sy);
  shape.lineTo(x0, y0 + sy);
  shape.closePath();
  return shape;
}

function circleShape(args, ctx) {
  let r = num(args.named.r, num(args.positional[0], null));
  if (r === null) {
    const d = num(args.named.d, null);
    r = d !== null ? d / 2 : 1;
  }
  const fn = num(args.named.$fn, ctx.$fn);
  const seg = Math.max(8, Math.round(fn));
  const shape = new THREE.Shape();
  shape.moveTo(r, 0);
  for (let i = 1; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return shape;
}

function flatMeshFromShape(shape, ctx) {
  if (!shape) return null;
  const geom = new THREE.ShapeGeometry(shape);
  return new THREE.Mesh(geom, materialFor(ctx));
}

function makePolygonFlat(args, ctx) { return flatMeshFromShape(polygonShape(args), ctx); }
function makeSquareFlat(args, ctx)  { return flatMeshFromShape(squareShape(args),  ctx); }
function makeCircleFlat(args, ctx)  { return flatMeshFromShape(circleShape(args, ctx), ctx); }

// ---------- Transforms ----------

function wrapTransform(node, ctx, kind) {
  const group = new THREE.Group();

  if (kind === 'translate') {
    const v = vec3(node.args.named.v || node.args.positional[0], [0, 0, 0]);
    group.position.set(v[0], v[1], v[2]);
  } else if (kind === 'rotate') {
    const a = node.args.positional[0] || node.args.named.a;
    if (a && a.type === 'array') {
      const [rx, ry, rz] = vec3(a, [0, 0, 0]).map((d) => (d * Math.PI) / 180);
      group.rotation.set(rx, ry, rz);
    } else if (a && a.type === 'number') {
      const angle = (a.value * Math.PI) / 180;
      const axis = node.args.positional[1] || node.args.named.v;
      if (axis && axis.type === 'array') {
        const [ax, ay, az] = vec3(axis, [0, 0, 1]);
        group.setRotationFromAxisAngle(new THREE.Vector3(ax, ay, az).normalize(), angle);
      } else {
        group.rotation.z = angle;
      }
    }
  } else if (kind === 'scale') {
    const v = node.args.positional[0] || node.args.named.v;
    if (v && v.type === 'array') {
      const [x, y, z] = vec3(v, [1, 1, 1]);
      group.scale.set(x || 1, y || 1, z || 1);
    } else if (v && v.type === 'number') {
      group.scale.setScalar(v.value);
    }
  } else if (kind === 'mirror') {
    const v = vec3(node.args.named.v || node.args.positional[0], [0, 0, 0]);
    group.scale.set(v[0] ? -1 : 1, v[1] ? -1 : 1, v[2] ? -1 : 1);
  }

  for (const c of node.children) {
    const o = evaluateNode(c, ctx);
    if (o) group.add(o);
  }
  return group;
}

function wrapColor(node, ctx) {
  const arg = node.args.positional[0] || node.args.named.c;
  let color = null;
  if (arg) {
    if (arg.type === 'string') {
      try { color = new THREE.Color(arg.value); } catch { color = null; }
    } else if (arg.type === 'array' && arg.items.length >= 3) {
      const [r, g, b] = vec3(arg, [1, 1, 1]);
      color = new THREE.Color(r, g, b);
    }
  }
  const newCtx = { ...ctx, color };
  const group = new THREE.Group();
  for (const c of node.children) {
    const o = evaluateNode(c, newCtx);
    if (o) group.add(o);
  }
  return group;
}

// ---------- Extrusions ----------

function getShapeForExtrude(child, ctx) {
  if (!child || child.type !== 'call') return null;
  if (child.name === 'polygon') return polygonShape(child.args);
  if (child.name === 'square')  return squareShape(child.args);
  if (child.name === 'circle')  return circleShape(child.args, ctx);
  return null;
}

function makeLinearExtrude(args, children, ctx) {
  const height = num(args.named.height, num(args.positional[0], 1));
  const twist = num(args.named.twist, 0);
  const scale = num(args.named.scale, 1);
  const center = bool(args.named.center, false);
  const group = new THREE.Group();
  for (const child of children) {
    const shape = getShapeForExtrude(child, ctx);
    if (!shape) continue;
    const steps = twist ? Math.max(8, Math.min(200, Math.ceil(Math.abs(twist) / 5) + 4)) : 1;
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: height, bevelEnabled: false, steps, curveSegments: 24,
    });
    if (twist !== 0 || scale !== 1) applyTwistScale(geom, height, twist, scale);
    if (center) geom.translate(0, 0, -height / 2);
    geom.computeVertexNormals();
    group.add(new THREE.Mesh(geom, materialFor(ctx)));
  }
  return group;
}

function makeRotateExtrude(args, children, ctx) {
  const angle = num(args.named.angle, 360);
  const fn = num(args.named.$fn, ctx.$fn);
  const seg = Math.max(8, Math.round(fn));
  const group = new THREE.Group();
  for (const child of children) {
    const shape = getShapeForExtrude(child, ctx);
    if (!shape) continue;
    const pts = shape.getPoints();
    if (pts.length < 2) continue;
    const v2 = pts.map((p) => new THREE.Vector2(Math.max(0.001, p.x), p.y));
    if (angle >= 360) v2.push(v2[0].clone());
    const phi = (Math.min(360, Math.max(1, angle)) / 360) * Math.PI * 2;
    const geom = new THREE.LatheGeometry(v2, seg, 0, phi);
    geom.rotateX(-Math.PI / 2);
    geom.computeVertexNormals();
    group.add(new THREE.Mesh(geom, materialFor(ctx)));
  }
  return group;
}

function applyTwistScale(geometry, height, twistDeg, scale) {
  const pos = geometry.attributes.position;
  const twistRad = (twistDeg * Math.PI) / 180;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = height === 0 ? 0 : z / height;
    const a = t * twistRad;
    const s = 1 + (scale - 1) * t;
    pos.setXYZ(i, (x * Math.cos(a) - y * Math.sin(a)) * s, (x * Math.sin(a) + y * Math.cos(a)) * s, z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}
