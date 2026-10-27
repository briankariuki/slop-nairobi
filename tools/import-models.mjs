#!/usr/bin/env node
// Reads the captured 3D map models of the CBD ("Nairobi CBD Obj": untextured building prisms in 2 km of OBJ draw
// calls, no georeference) and writes js/nairobi-models.js:
// - MODEL_HEIGHTS: a roof height for every OSM building the models cover whose own height is only an estimate
//   (OpenStreetMap measures about 5% of them), the median model roof height over its footprint;
// - MODEL_BUILDINGS: the models' own meshes for the landmark towers whose OSM outlines don't do them justice, in world
//   coordinates, for buildings.js to draw instead of the OSM extrusions.
// The models were georeferenced by matching their roof outlines to the OSM footprints (Times Tower, Teleposta, I&M and
// CBK Pension Towers then land within 10 m of OSM's): world x = model x + DX, world z = -model y + DZ, height = model z.
//
//   node tools/import-models.mjs ["Nairobi CBD Obj"]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import earcut from 'earcut';
const { GEO } = await import('../js/nairobi-geodata.js');

const dir = process.argv[2] || 'Nairobi CBD Obj';
const DX = 96;
const DZ = -240;
const BUILDING_MODELS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16];
const CELL = 2; // m, the roof height raster
// The towers to remesh from the models (OSM names), where the models have them (KICC and CBK Pension Towers are
// RAW_TOWERS below)
const REPLACE = [
  'Times Tower', 'Teleposta Towers', 'I&M Bank',
  'Nyayo house', 'Social Security House', 'Nation Media House', 'Cooperative Bank House', 'Anniversary Towers',
  'Lonrho House', 'National Bank Houe', 'Hazina Towers', 'Rahimtulla Tower', 'Hilton Hotel Nairobi', 'Bunge Tower',
  'Reinsurance plaza', 'Uchumi House', 'Ambank House', 'View Park Towers', 'Ecobank Towers', 'University of Nairobi Tower',
  'ICEA Building', 'International House Ltd', 'Pension Towers', 'afya center', 'Hazina Trade Centre', 'Postbank House',
  'Chester House', 'Jkuat towers', 'HH Towers'
];

// 1. Every non-degenerate face of the building models, in world coordinates, with vertices shared by position so the
//    prisms connect (walls to their roofs; neighbours sharing a wall too)
const verts = []; // [x, y (height), z]
const vertIndex = new Map();
const faces = []; // [a, b, c]
const seen = new Set();
const vertexAt = (x, y, z) => {
  const k = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
  let i = vertIndex.get(k);
  if (i === undefined) {
    i = verts.length;
    verts.push([x, y, z]);
    vertIndex.set(k, i);
  }
  return i;
};
for (const k of BUILDING_MODELS) {
  const local = [];
  for (const line of readFileSync(join(dir, `model_${k}.obj`), 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const [x, y, z] = line.split(' ').slice(1, 4).map(Number);
      local.push(vertexAt(x + DX, z, -y + DZ));
    } else if (line.startsWith('f ')) {
      const f = line.trim().split(' ').slice(1, 4).map((s) => local[+s.split('/')[0] - 1]);
      if (new Set(f).size < 3) continue;
      // the models overlap: every building is in several of them
      const k = [...f].sort((a, b) => a - b).join(',');
      if (!seen.has(k)) {
        seen.add(k);
        faces.push(f);
      }
    }
  }
}
console.log(`${verts.length} vertices, ${faces.length} faces (${seen.size} after dropping duplicates)`);

const normalOf = ([a, b, c]) => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(...n) || 1;
  return n.map((c) => c / l);
};
const normal = (f) => normalOf(f.map((i) => verts[i]));

// 2. Connected pieces (union-find over shared vertices)
const parent = verts.map((_, i) => i);
const find = (i) => {
  while (parent[i] !== i) i = parent[i] = parent[parent[i]];
  return i;
};
for (const [a, b, c] of faces) {
  parent[find(b)] = find(a);
  parent[find(c)] = find(a);
}
const pieces = new Map(); // root -> { faces, minX, maxX, minZ, maxZ, top }
for (const f of faces) {
  const r = find(f[0]);
  let p = pieces.get(r);
  if (!p) pieces.set(r, (p = { faces: [], minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, top: 0 }));
  p.faces.push(f);
  for (const i of f) {
    const v = verts[i];
    p.minX = Math.min(p.minX, v[0]); p.maxX = Math.max(p.maxX, v[0]);
    p.minZ = Math.min(p.minZ, v[2]); p.maxZ = Math.max(p.maxZ, v[2]);
    p.top = Math.max(p.top, v[1]);
  }
}
console.log(`${pieces.size} connected pieces`);

// 3. Roof heights on a CELL m raster: the highest up-facing triangle over each cell
const T = GEO.terrain;
const X0 = T.x0, Z0 = T.z0, NX = Math.ceil(((T.nx - 1) * T.cell) / CELL), NZ = Math.ceil(((T.nz - 1) * T.cell) / CELL);
const roof = new Float32Array(NX * NZ);
const inTri = (px, pz, a, b, c) => {
  const s = (a[0] - c[0]) * (pz - c[2]) - (a[2] - c[2]) * (px - c[0]);
  const t = (b[0] - a[0]) * (pz - a[2]) - (b[2] - a[2]) * (px - a[0]);
  if ((s < 0) !== (t < 0) && s !== 0 && t !== 0) return false;
  const d = (c[0] - b[0]) * (pz - b[2]) - (c[2] - b[2]) * (px - b[0]);
  return d === 0 || (d < 0) === (s + t <= 0);
};
for (const f of faces) {
  if (normal(f)[1] < 0.9) continue;
  const [a, b, c] = f.map((i) => verts[i]);
  if (a[1] < 1.5) continue;
  const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - X0) / CELL)), i1 = Math.min(NX - 1, Math.floor((Math.max(a[0], b[0], c[0]) - X0) / CELL));
  const j0 = Math.max(0, Math.floor((Math.min(a[2], b[2], c[2]) - Z0) / CELL)), j1 = Math.min(NZ - 1, Math.floor((Math.max(a[2], b[2], c[2]) - Z0) / CELL));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (inTri(X0 + (i + 0.5) * CELL, Z0 + (j + 0.5) * CELL, a, b, c)) roof[j * NX + i] = Math.max(roof[j * NX + i], a[1]);
    }
  }
}

const inRing = (ring, x, z) => {
  let inside = false;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
};
const ringBounds = (ring) => {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let k = 0; k < ring.length; k += 2) {
    b.minX = Math.min(b.minX, ring[k]); b.maxX = Math.max(b.maxX, ring[k]);
    b.minZ = Math.min(b.minZ, ring[k + 1]); b.maxZ = Math.max(b.maxZ, ring[k + 1]);
  }
  return b;
};
// The model's roof heights over the cells inside a ring: [covered cells, all cells, median height]
function roofOver(ring) {
  const b = ringBounds(ring);
  const hs = [];
  let all = 0;
  for (let j = Math.max(0, Math.floor((b.minZ - Z0) / CELL)); j <= Math.min(NZ - 1, Math.floor((b.maxZ - Z0) / CELL)); j++) {
    for (let i = Math.max(0, Math.floor((b.minX - X0) / CELL)); i <= Math.min(NX - 1, Math.floor((b.maxX - X0) / CELL)); i++) {
      if (!inRing(ring, X0 + (i + 0.5) * CELL, Z0 + (j + 0.5) * CELL)) continue;
      all++;
      if (roof[j * NX + i] > 0) hs.push(roof[j * NX + i]);
    }
  }
  hs.sort((p, q) => p - q);
  return [hs.length, all, hs.length ? hs[hs.length >> 1] : 0];
}

// 4. Heights for the estimated buildings the models cover (at least 60% of the footprint, 3 cells or more)
const heights = {};
let covered = 0;
for (const b of GEO.buildings) {
  if (!b.est || b.part) continue;
  const [n, all, h] = roofOver(b.ring);
  if (all < 3 || n < 0.6 * all) continue;
  covered++;
  if (Math.abs(h - b.h) >= 1) heights[b.id] = Math.round(h * 2) / 2;
}
console.log(`heights: ${covered} estimated buildings covered, ${Object.keys(heights).length} changed`);

// 5. The landmark towers, remeshed. The capture isn't clean geometry: it has a roof slab for every floor (with ragged
//    edges), walls only on the side it was seen from, half of everything wound inside out, and top roofs sometimes
//    only partly captured. So each tower is rebuilt from where its roofs are, like a voxel remesh:
//    - its roofs (every up- or down-facing triangle 3 m up or more), slid to line up with its OSM footprint, are
//      rasterized onto a REMESH m height map, the highest over each cell, kept to the footprint grown GROW m so its
//      neighbours stay out;
//    - holes enclosed by roof (a roof room only half captured) under FILL m² are filled at the height around them;
//    - heights are merged into levels LEVEL m apart, median-filtered to clean their edges, and levels under MIN_LEVEL m²
//      folded into the one below;
//    - each level's outline is traced (marching squares, simplified to SIMPLIFY m) and becomes a prism: a flat roof
//      at its height and walls down to the ground. Its outlines also become the tower's colliders (buildings.js).
//    A model that has to be slid over MAX_SHIFT m, covers under COVER of the footprint, or is well short of OSM's
//    height (the capture predates the tower) or well over it (a neighbour's roof) is left out: the tower keeps its OSM
//    outline.
const REMESH = 0.5;
const GROW = 4;
const FILL = 400;
const LEVEL = 1.2;
const MIN_LEVEL = 15;
const SIMPLIFY = 0.3;
const COVER = 0.6;
const roofTris = [];
for (const f of faces) {
  const t = f.map((i) => verts[i]);
  if (Math.abs(normalOf(t)[1]) < 0.9 || t[0][1] < 3) continue;
  roofTris.push({ t, minX: Math.min(t[0][0], t[1][0], t[2][0]), maxX: Math.max(t[0][0], t[1][0], t[2][0]), minZ: Math.min(t[0][2], t[1][2], t[2][2]), maxZ: Math.max(t[0][2], t[1][2], t[2][2]) });
}

// Closed outlines of the cells where solid(i, j), as [[x, z], ...] loops (marching squares over the cell centres)
function outlines(nx, nz, solid, x0, z0) {
  const at = (i, j) => (i >= 0 && j >= 0 && i < nx && j < nz && solid(i, j) ? 1 : 0);
  const pos = new Map();
  const ends = new Map(); // point key -> segment ids
  const segs = [];
  const pt = (k, x, z) => (pos.has(k) || pos.set(k, [x, z]), k);
  const h = (i, j) => pt(`h${i},${j}`, x0 + (i + 1) * REMESH, z0 + (j + 0.5) * REMESH); // between (i, j) and (i + 1, j)
  const v = (i, j) => pt(`v${i},${j}`, x0 + (i + 0.5) * REMESH, z0 + (j + 1) * REMESH); // between (i, j) and (i, j + 1)
  const add = (p, q) => {
    const id = segs.push([p, q]) - 1;
    for (const k of [p, q]) (ends.get(k) || ends.set(k, []).get(k)).push(id);
  };
  for (let j = -1; j < nz; j++) {
    for (let i = -1; i < nx; i++) {
      const c = (at(i, j) << 3) | (at(i + 1, j) << 2) | (at(i + 1, j + 1) << 1) | at(i, j + 1);
      if (c === 0 || c === 15) continue;
      const T = () => h(i, j), B = () => h(i, j + 1), L = () => v(i, j), R = () => v(i + 1, j);
      // (diagonal pairs, 5 and 10, stay apart)
      const table = { 1: [[L, B]], 2: [[B, R]], 3: [[L, R]], 4: [[T, R]], 5: [[T, R], [L, B]], 6: [[T, B]], 7: [[T, L]],
        8: [[T, L]], 9: [[T, B]], 10: [[T, L], [B, R]], 11: [[T, R]], 12: [[L, R]], 13: [[R, B]], 14: [[L, B]] };
      for (const [p, q] of table[c]) add(p(), q());
    }
  }
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const loop = [segs[s0][0]];
    let cur = segs[s0][1];
    while (cur !== loop[0]) {
      loop.push(cur);
      const next = ends.get(cur).find((id) => !used[id]);
      if (next === undefined) break;
      used[next] = 1;
      cur = segs[next][0] === cur ? segs[next][1] : segs[next][0];
    }
    if (loop.length >= 3) loops.push(loop.map((k) => pos.get(k)));
  }
  return loops;
}
// A closed loop simplified (Douglas-Peucker) to within tol
function simplify(loop, tol) {
  const n = loop.length;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]);
    if (d > fd) [fd, far] = [d, i];
  }
  const dp = (pts) => {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let worst = 0, wi = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((pts[i][0] - a[0]) * (b[1] - a[1]) - (pts[i][1] - a[1]) * (b[0] - a[0])) / L;
      if (d > worst) [worst, wi] = [d, i];
    }
    if (worst <= tol) return [a, b];
    const left = dp(pts.slice(0, wi + 1));
    return [...left.slice(0, -1), ...dp(pts.slice(wi))];
  };
  const a = dp(loop.slice(0, far + 1));
  const b = dp([...loop.slice(far), loop[0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
const loopArea = (l) => {
  let a = 0;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) a += l[j][0] * l[i][1] - l[i][0] * l[j][1];
  return a / 2;
};
const inLoop = (l, x, z) => {
  let ins = false;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const [ax, az] = l[i], [bx, bz] = l[j];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) ins = !ins;
  }
  return ins;
};

// Line a model up with a tower's footprint: locally it can sit 10 m or more from where OSM has the tower. Its roofs
// over half the tower's height, rasterized at 1 m, are slid up to SHIFT m each way to cover the most of the footprint
// (further than MAX_SHIFT, the best fit is more likely a neighbouring tower). Returns [sx, sz]: the model is at
// world + (sx, sz).
const SHIFT = 14;
const MAX_SHIFT = 13;
function fitShift(over, bb, h) {
  const tall = roofTris.filter((r) => r.t[0][1] >= 0.5 * h && r.maxX > bb.minX - SHIFT - 2 && r.minX < bb.maxX + SHIFT + 2 && r.maxZ > bb.minZ - SHIFT - 2 && r.minZ < bb.maxZ + SHIFT + 2);
  const foot = [];
  for (let z = Math.floor(bb.minZ); z <= bb.maxZ; z++) for (let x = Math.floor(bb.minX); x <= bb.maxX; x++) if (over(x + 0.5, z + 0.5)) foot.push([x + 0.5, z + 0.5]);
  const hitAt = new Map(); // memo: does a tall roof cover the 1 m cell (x, z)?
  const tallAt = (x, z) => {
    const k = `${x},${z}`;
    if (!hitAt.has(k)) hitAt.set(k, tall.some((r) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ && inTri(x, z, r.t[0], r.t[1], r.t[2])));
    return hitAt.get(k);
  };
  let sx = 0, sz = 0, best = -1;
  for (let dz = -SHIFT; dz <= SHIFT; dz += 2) for (let dx = -SHIFT; dx <= SHIFT; dx += 2) {
    let n = 0;
    for (const [x, z] of foot) if (tallAt(x + dx, z + dz)) n++;
    if (n > best + 2 || (n >= best - 2 && Math.hypot(dx, dz) < Math.hypot(sx, sz) && n > best - 1)) [best, sx, sz] = [Math.max(n, best), dx, dz];
  }
  const [cx0, cz0] = [sx, sz];
  for (const [ddx, ddz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
    let n = 0;
    for (const [x, z] of foot) if (tallAt(x + cx0 + ddx, z + cz0 + ddz)) n++;
    if (n > best) [best, sx, sz] = [n, cx0 + ddx, cz0 + ddz];
  }
  return [sx, sz];
}

const byName = new Map();
for (const b of GEO.buildings) if (b.name) (byName.get(b.name) || byName.set(b.name, []).get(b.name)).push(b);
const buildings = [];
for (const name of REPLACE) {
  const parts = byName.get(name);
  if (!parts) {
    console.log(`  ${name}: not in the OSM data`);
    continue;
  }
  const rings = parts.map((b) => b.ring);
  const h = Math.max(...parts.map((b) => b.h));
  const bb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const r of rings) {
    const b = ringBounds(r);
    bb.minX = Math.min(bb.minX, b.minX); bb.maxX = Math.max(bb.maxX, b.maxX);
    bb.minZ = Math.min(bb.minZ, b.minZ); bb.maxZ = Math.max(bb.maxZ, b.maxZ);
  }
  const over = (x, z) => rings.some((r) => inRing(r, x, z));
  const near = (x, z, d) => rings.some((r) => {
    for (let k = 0, n = r.length / 2; k < n; k++) {
      const ax = r[2 * k], az = r[2 * k + 1], bx = r[(2 * k + 2) % r.length], bz = r[(2 * k + 3) % r.length];
      const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < d) return true;
    }
    return false;
  });

  const [sx, sz] = fitShift(over, bb, h);
  if (Math.hypot(sx, sz) > MAX_SHIFT) {
    console.log(`  ${name}: the nearest fit is ${Math.hypot(sx, sz).toFixed(0)} m off: kept OSM's`);
    continue;
  }

  // the height map, over the footprint grown GROW m (and a cell's margin), sampling the model shifted by (sx, sz)
  const x0 = bb.minX - GROW - REMESH, z0 = bb.minZ - GROW - REMESH;
  const nx = Math.ceil((bb.maxX - bb.minX + 2 * GROW + 2 * REMESH) / REMESH), nz = Math.ceil((bb.maxZ - bb.minZ + 2 * GROW + 2 * REMESH) / REMESH);
  const cx = (i) => x0 + (i + 0.5) * REMESH, cz = (j) => z0 + (j + 0.5) * REMESH;
  const region = new Uint8Array(nx * nz); // 2 inside the footprint, 1 within GROW m of it
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) region[j * nx + i] = over(cx(i), cz(j)) ? 2 : near(cx(i), cz(j), GROW) ? 1 : 0;
  let H = new Float32Array(nx * nz);
  for (const { t, minX, maxX, minZ, maxZ } of roofTris) {
    if (maxX - sx < x0 || minX - sx > x0 + nx * REMESH || maxZ - sz < z0 || minZ - sz > z0 + nz * REMESH) continue;
    for (let j = Math.max(0, Math.floor((minZ - sz - z0) / REMESH)); j <= Math.min(nz - 1, Math.floor((maxZ - sz - z0) / REMESH)); j++) {
      for (let i = Math.max(0, Math.floor((minX - sx - x0) / REMESH)); i <= Math.min(nx - 1, Math.floor((maxX - sx - x0) / REMESH)); i++) {
        const k = j * nx + i;
        if (region[k] && t[0][1] > H[k] && inTri(cx(i) + sx, cz(j) + sz, t[0], t[1], t[2])) H[k] = t[0][1];
      }
    }
  }
  let inside = 0, covered = 0;
  for (let k = 0; k < H.length; k++) if (region[k] === 2) (inside++, H[k] > 0 && covered++);
  if (covered < COVER * inside) {
    console.log(`  ${name}: the models cover ${Math.round((covered / inside) * 100)}% of its footprint (shifted ${sx}, ${sz} m): kept OSM's`);
    continue;
  }

  // fill the holes enclosed by roof (flood the empty cells from the map's edge: those not reached are enclosed)
  const reached = new Uint8Array(nx * nz);
  const stack = [];
  for (let i = 0; i < nx; i++) stack.push(i, (nz - 1) * nx + i);
  for (let j = 0; j < nz; j++) stack.push(j * nx, j * nx + nx - 1);
  while (stack.length) {
    const k = stack.pop();
    if (reached[k] || H[k] > 0) continue;
    reached[k] = 1;
    const i = k % nx, j = (k / nx) | 0;
    if (i > 0) stack.push(k - 1);
    if (i < nx - 1) stack.push(k + 1);
    if (j > 0) stack.push(k - nx);
    if (j < nz - 1) stack.push(k + nx);
  }
  const seen2 = new Uint8Array(nx * nz);
  for (let k0 = 0; k0 < H.length; k0++) {
    if (H[k0] > 0 || reached[k0] || seen2[k0]) continue;
    const hole = [];
    let rim = 0;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop();
      if (seen2[k]) continue;
      if (H[k] > 0) {
        rim = Math.max(rim, H[k]);
        continue;
      }
      seen2[k] = 1;
      hole.push(k);
      const i = k % nx, j = (k / nx) | 0;
      if (i > 0) stack.push(k - 1);
      if (i < nx - 1) stack.push(k + 1);
      if (j > 0) stack.push(k - nx);
      if (j < nz - 1) stack.push(k + nx);
    }
    if (hole.length * REMESH * REMESH < FILL) for (const k of hole) H[k] = rim;
  }

  // levels: heights LEVEL m apart, from the top down (each cell rounded up to the level it falls under)
  const values = [...new Set([...H].filter((y) => y > 0).map((y) => Math.round(y * 10) / 10))].sort((p, q) => q - p);
  const levels = [];
  for (const y of values) if (!levels.length || levels[levels.length - 1] - y > LEVEL) levels.push(y);
  // (each cell to the lowest level at or above its height)
  const levelOf = (y) => {
    if (!(y > 0)) return 0;
    y = Math.round(y * 10) / 10;
    let best = levels[0];
    for (const L of levels) if (L >= y && L < best) best = L;
    return best;
  };
  H = H.map(levelOf);
  // median filter twice (3 × 3): clean, straight-ish edges, no single-cell spikes or notches
  for (let pass = 0; pass < 2; pass++) {
    const M = new Float32Array(nx * nz);
    const w = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        w.length = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          w.push(ii >= 0 && jj >= 0 && ii < nx && jj < nz ? H[jj * nx + ii] : 0);
        }
        w.sort((p, q) => p - q);
        M[j * nx + i] = region[j * nx + i] ? w[4] : 0;
      }
    }
    H = M;
  }
  // levels too small to be a roof of their own fold into the one below (or the ground)
  for (let changed = true; changed;) {
    changed = false;
    const area = new Map();
    for (const y of H) if (y > 0) area.set(y, (area.get(y) || 0) + REMESH * REMESH);
    const used = [...area.keys()].sort((p, q) => p - q);
    for (const y of used) {
      if (area.get(y) >= MIN_LEVEL) continue;
      const below = used.filter((u) => u < y && area.get(u) >= MIN_LEVEL).pop() || 0;
      for (let k = 0; k < H.length; k++) if (H[k] === y) H[k] = below;
      changed = true;
      break;
    }
  }
  const finalLevels = [...new Set(H)].filter((y) => y > 0).sort((p, q) => p - q);
  const top = finalLevels[finalLevels.length - 1] || 0;
  // (and one far taller than OSM's is more likely a neighbour's roof)
  if (top < 0.8 * h || top > 1.3 * h) {
    console.log(`  ${name}: the model is ${top.toFixed(0)} m, OSM ${h} m: kept OSM's`);
    continue;
  }

  // each level a prism: outlines (outer rings and their holes), a roof, walls to the ground
  const tris = [];
  const levelRings = [];
  for (const L of finalLevels) {
    const solid = (i, j) => H[j * nx + i] >= L;
    const loops = outlines(nx, nz, solid, x0, z0).map((l) => simplify(l, SIMPLIFY)).filter((l) => l.length >= 3 && Math.abs(loopArea(l)) >= 8);
    // a loop is a hole when an odd number of the others contain it
    const holeOf = loops.map((l, a) => loops.filter((m, b) => b !== a && inLoop(m, l[0][0], l[0][1])).length % 2 === 1);
    const solidAt = (x, z) => {
      const i = Math.floor((x - x0) / REMESH), j = Math.floor((z - z0) / REMESH);
      return i >= 0 && j >= 0 && i < nx && j < nz && solid(i, j);
    };
    loops.forEach((outer, a) => {
      if (holeOf[a]) return;
      const holes = loops.filter((l, b) => holeOf[b] && inLoop(outer, l[0][0], l[0][1]));
      levelRings.push({ y: Math.round(L * 100) / 100, ring: outer.flat().map((v) => Math.round(v * 100) / 100), holes: holes.map((l) => l.flat().map((v) => Math.round(v * 100) / 100)) });
      // the roof, facing up
      const flat = [...outer.flat()];
      const holeIdx = [];
      for (const l of holes) {
        holeIdx.push(flat.length / 2);
        flat.push(...l.flat());
      }
      const idx = earcut(flat, holeIdx);
      for (let k = 0; k < idx.length; k += 3) {
        let t = [0, 1, 2].map((c) => [flat[2 * idx[k + c]], L, flat[2 * idx[k + c] + 1]]);
        if (normalOf(t)[1] < 0) t = [t[0], t[2], t[1]];
        tris.push(t);
      }
    });
    // walls along every loop, facing the empty side, from the ground to the level
    for (const l of loops) {
      for (let k = 0; k < l.length; k++) {
        const [ax, az] = l[k], [bx, bz] = l[(k + 1) % l.length];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) continue;
        let nxw = (bz - az) / len, nzw = -(bx - ax) / len;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (solidAt(mx + nxw * REMESH * 0.6, mz + nzw * REMESH * 0.6) && !solidAt(mx - nxw * REMESH * 0.6, mz - nzw * REMESH * 0.6)) [nxw, nzw] = [-nxw, -nzw];
        const A0 = [ax, 0, az], B0 = [bx, 0, bz], A1 = [ax, L, az], B1 = [bx, L, bz];
        for (let t of [[A0, B0, B1], [A0, B1, A1]]) {
          const n = normalOf(t);
          if (n[0] * nxw + n[2] * nzw < 0) t = [t[0], t[2], t[1]];
          tris.push(t);
        }
      }
    }
  }

  // the mesh's own vertices, indexed, quantized to 16 bits over its bounds
  const usedV = new Map();
  const index = [];
  const vs = [];
  for (const t of tris) for (const v of t) {
    const k = `${v[0].toFixed(2)},${v[1].toFixed(2)},${v[2].toFixed(2)}`;
    if (!usedV.has(k)) {
      usedV.set(k, vs.length);
      vs.push(v);
    }
    index.push(usedV.get(k));
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of vs) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], v[c]); hi[c] = Math.max(hi[c], v[c]); }
  const q = new Uint16Array(vs.length * 3);
  vs.forEach((v, k) => { for (let c = 0; c < 3; c++) q[3 * k + c] = Math.round(((v[c] - lo[c]) / (hi[c] - lo[c] || 1)) * 65535); });
  const idxArr = vs.length <= 65536 ? new Uint16Array(index) : new Uint32Array(index);
  console.log(`  ${name}: shifted ${sx}, ${sz} m, ${Math.round((covered / inside) * 100)}% covered, levels ${finalLevels.map((y) => y.toFixed(0)).join(' ')} m, ${levelRings.length} prisms, ${tris.length} triangles (OSM ${h} m)`);
  buildings.push({ name, top: Math.round(top * 10) / 10, lo: lo.map((v) => +v.toFixed(2)), hi: hi.map((v) => +v.toFixed(2)),
    verts: vs.length, faces: tris.length, wide: idxArr instanceof Uint32Array, offset: 0, levels: levelRings, bytes: [q, idxArr] });
}

// 5b. Towers whose own captured shape the remesh would lose (KICC's flared crown and amphitheatre cone, CBK Pension
//     Towers' twin slabs and crown fins): their raw triangles, as the capture has them. The pieces whose roofs lie
//     over the group's OSM parts (higher than 0.4 of the part) are kept, those reaching far beyond the parts cut to
//     the faces within CUT m of them, and the lot slid by fitShift onto the footprints. Their winding is as captured
//     (either way), so buildings.js draws them two-sided; their colliders stay their OSM parts.
const RAW_TOWERS = {
  'Kenyatta International Convention Centre': ['Kenyatta International Convention Centre', 'KICC Amphitheater'],
  'CBK Pension Towers': ['CBK Pension Towers']
};
const CUT = 6;
for (const [name, names] of Object.entries(RAW_TOWERS)) {
  const parts = names.flatMap((n) => byName.get(n) || []);
  if (!parts.length) {
    console.log(`  ${name}: not in the OSM data`);
    continue;
  }
  const h = Math.max(...parts.map((b) => b.h));
  const bb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const b of parts) {
    const r = ringBounds(b.ring);
    bb.minX = Math.min(bb.minX, r.minX); bb.maxX = Math.max(bb.maxX, r.maxX);
    bb.minZ = Math.min(bb.minZ, r.minZ); bb.maxZ = Math.max(bb.maxZ, r.maxZ);
  }
  const tower = parts.filter((b) => b.h >= 0.5 * h); // the tall parts, to line the model up by
  const [sx, sz] = fitShift((x, z) => tower.some((b) => inRing(b.ring, x, z)), bb, h);
  const partAt = (x, z) => parts.find((b) => inRing(b.ring, x - sx, z - sz));
  const within = (x, z, d) => parts.some((b) => {
    const r = b.ring;
    for (let k = 0, n = r.length / 2; k < n; k++) {
      const ax = r[2 * k] + sx, az = r[2 * k + 1] + sz, bx = r[(2 * k + 2) % r.length] + sx, bz = r[(2 * k + 3) % r.length] + sz;
      const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < d) return true;
    }
    return false;
  });
  const chosen = [];
  for (const p of pieces.values()) {
    if (p.maxX < bb.minX + sx - 10 || p.minX > bb.maxX + sx + 10 || p.maxZ < bb.minZ + sz - 10 || p.minZ > bb.maxZ + sz + 10) continue;
    const roofs = p.faces.some((f) => {
      if (Math.abs(normal(f)[1]) < 0.9) return false;
      const [a, b, c] = f.map((i) => verts[i]);
      const part = partAt((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3);
      return part && a[1] > 0.4 * part.h;
    });
    if (!roofs) continue;
    const sprawl = Math.max(bb.minX + sx - p.minX, p.maxX - bb.maxX - sx, bb.minZ + sz - p.minZ, p.maxZ - bb.maxZ - sz);
    chosen.push(...(sprawl > 12 ? p.faces.filter((f) => {
      const [a, b, c] = f.map((i) => verts[i]);
      const x = (a[0] + b[0] + c[0]) / 3, z = (a[2] + b[2] + c[2]) / 3;
      return partAt(x, z) || within(x, z, CUT);
    }) : p.faces));
  }
  if (!chosen.length) {
    console.log(`  ${name}: nothing in the models over it`);
    continue;
  }
  // its roof: the highest level of up- or down-facing faces over its tall parts with 50 m² or more of them (not a
  // crown's fins or a mast)
  const roofArea = new Map();
  for (const f of chosen) {
    const t = f.map((i) => verts[i]);
    if (Math.abs(normalOf(t)[1]) < 0.9) continue;
    const x = (t[0][0] + t[1][0] + t[2][0]) / 3 - sx, z = (t[0][2] + t[1][2] + t[2][2]) / 3 - sz;
    if (!tower.some((b) => inRing(b.ring, x, z))) continue;
    const ux = t[1][0] - t[0][0], uz = t[1][2] - t[0][2], vx = t[2][0] - t[0][0], vz = t[2][2] - t[0][2];
    const y = Math.round(t[0][1]);
    roofArea.set(y, (roofArea.get(y) || 0) + Math.abs(ux * vz - uz * vx) / 2);
  }
  const roof = Math.max(0, ...[...roofArea].filter(([, a]) => a >= 50).map(([y]) => y));
  const usedV = new Map();
  const index = [];
  const vs = [];
  for (const f of chosen) for (const i of f) {
    if (!usedV.has(i)) {
      usedV.set(i, vs.length);
      vs.push([verts[i][0] - sx, verts[i][1], verts[i][2] - sz]);
    }
    index.push(usedV.get(i));
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of vs) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], v[c]); hi[c] = Math.max(hi[c], v[c]); }
  const q = new Uint16Array(vs.length * 3);
  vs.forEach((v, k) => { for (let c = 0; c < 3; c++) q[3 * k + c] = Math.round(((v[c] - lo[c]) / (hi[c] - lo[c] || 1)) * 65535); });
  const idxArr = vs.length <= 65536 ? new Uint16Array(index) : new Uint32Array(index);
  console.log(`  ${name} (raw): shifted ${sx}, ${sz} m, ${vs.length} vertices, ${chosen.length} faces, roof ${roof} m, top ${hi[1].toFixed(0)} m (OSM ${h} m)`);
  buildings.push({ name, names, raw: true, roof, top: Math.round(hi[1] * 10) / 10, lo: lo.map((v) => +v.toFixed(2)), hi: hi.map((v) => +v.toFixed(2)),
    verts: vs.length, faces: chosen.length, wide: idxArr instanceof Uint32Array, offset: 0, bytes: [q, idxArr] });
}

// 6. js/nairobi-models.js (the heights and the towers' manifest) and js/nairobi-models.bin (their meshes: for each,
//    the quantized vertices then the triangle indices, 4-byte aligned)
const chunks = [];
let offset = 0;
for (const b of buildings) {
  b.offset = offset;
  for (const a of b.bytes) {
    const buf = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    const pad = (4 - (buf.length % 4)) % 4;
    chunks.push(buf, Buffer.alloc(pad));
    offset += buf.length + pad;
  }
  delete b.bytes;
}
writeFileSync(new URL('../js/nairobi-models.bin', import.meta.url), Buffer.concat(chunks));
const out = `// Generated by tools/import-models.mjs from the captured 3D map models of the CBD: roof heights for the OSM
// buildings whose heights were estimates, and the landmark towers drawn from the models' own meshes (buildings.js):
// each a manifest here and its vertices (uint16 x, y, z quantized over lo..hi, in world metres, y over the footing)
// followed by its triangle indices (uint16, or uint32 when \`wide\`) at \`offset\` in nairobi-models.bin, and its
// \`levels\`: the prisms it was rebuilt as ({ y, ring, holes }), which stand in for its OSM outline (colliders, roofs);
// or, \`raw\`, the capture's own triangles, wound either way, drawn in place of the OSM parts called \`names\`.
export const MODEL_HEIGHTS = ${JSON.stringify(heights)};
export const MODEL_BUILDINGS = ${JSON.stringify(buildings, null, 1).replace(/\n\s*(?=[\d\-"\]])/g, ' ').replace(/\n\s*\]/g, ' ]')};
`;
writeFileSync(new URL('../js/nairobi-models.js', import.meta.url), out);
console.log(`wrote js/nairobi-models.js (${Math.round(out.length / 1024)} kB) and js/nairobi-models.bin (${Math.round(offset / 1024)} kB): ${buildings.length} buildings`);
