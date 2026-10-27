import * as THREE from 'three/webgpu';
import { GEO } from './nairobi-geodata.js';
import { baseOf } from './terrain.js';
import { createFacadeMaterial } from './tsl-materials.js';

// Every building as one merged mesh: walls extruded from the footprint ring (and courtyard holes), a parapet round a
// flat roof, and on the bigger roofs a lift motor room. The facade material (tsl-materials.js createFacadeMaterial)
// draws the windows, floors, shopfronts and glazing from per-vertex attributes: each wall's own frame (metres along it,
// metres up it, its width and height), the building's style and colour, and its floor and bay sizes.
//
// A building stands on the lowest point of its footprint, so on a slope its uphill side sinks into the ground instead
// of the downhill side floating. The pieces of one tower (its building:parts and podium) share one footing.

// Facade styles the material knows (its `wall.z`): painted render with punched windows, concrete offices with piers,
// glass curtain walls, roofs, plain walls, concrete with ribbon windows between continuous bands, and glass between
// vertical concrete fins
export const STYLE = { render: 0, concrete: 1, glass: 2, roof: 3, plain: 4, ribbon: 5, fins: 6 };
const PARAPET = 0.8; // m above the roof
const PARAPET_W = 0.35;

// Nairobi's CBD: painted render in whites, creams and ochres, grey and sand concrete, the odd terracotta or green, and
// glass towers in blue-green, green and bronze
const RENDER = ['#efe9dc', '#e9e1cf', '#f2eee5', '#e2d6bb', '#dccfae', '#e8d9b0', '#cfc5b3', '#d9d2c6', '#c9b08f', '#d4b893', '#b89a7c', '#c8d0c0'];
const CONCRETE = ['#bdb8ae', '#c8c3b8', '#a9a59c', '#d2cdc2', '#b5aea0', '#9e9a92'];
const GLASS = ['#4f7f8c', '#3f6f82', '#5b8a7a', '#6b8fa8', '#55707f', '#7a8f6e', '#8a7c5a'];

// The landmark towers as they are (reference photographs: Wikipedia and Wikimedia Commons, October 2026), by their
// OpenStreetMap names: [style, tint, storey height]. Britam is a pale glass prism, UAP Old Mutual, Prism, Bunge, KCB
// Plaza and the GTC towers are light glass between white fins, Times Tower, I&M and Cooperative Bank House dark glass,
// KICC terracotta concrete ringed by its balconies, Teleposta, NSSF House and the Hilton pale concrete with ribbon
// windows, Nyayo House ochre concrete, Nation Centre white twin towers.
const LANDMARKS = {
  'britam tower': [STYLE.glass, '#c3d3de', 4.0],
  'uap old mutual tower': [STYLE.fins, '#a9c8dc', 4.0],
  'gtc office tower': [STYLE.fins, '#cfd9df', 4.0],
  'gtc hotel tower': [STYLE.fins, '#cfd9df', 3.6],
  'gtc apartments': [STYLE.fins, '#c4ced4', 3.2],
  'gtc residence': [STYLE.fins, '#c4ced4', 3.2],
  'pan pacific serviced suites': [STYLE.fins, '#c4ced4', 3.2],
  'pan pacific suites': [STYLE.fins, '#c4ced4', 3.2],
  'eigthy-eight': [STYLE.fins, '#c0d3e0', 3.1],
  'times tower': [STYLE.glass, '#3b4249', 3.7],
  'prism tower': [STYLE.fins, '#bcd4e4', 3.9],
  'bunge tower': [STYLE.fins, '#c4ccd3', 4.2],
  'teleposta towers': [STYLE.ribbon, '#d6c08f', 3.6],
  'cbk pension towers': [STYLE.glass, '#8fb0c8', 3.9],
  'kenya commercial bank plaza': [STYLE.fins, '#7fb0b0', 4.2],
  'kenyatta international convention centre': [STYLE.ribbon, '#a8714e', 3.2],
  '316 upper hill chamber': [STYLE.glass, '#9cb8c8', 4.0],
  'social security house': [STYLE.concrete, '#d9d6cf', 3.4],
  'i&m bank': [STYLE.glass, '#2f4f7a', 3.9],
  'nyayo house': [STYLE.concrete, '#b0875a', 3.1],
  'cooperative bank house': [STYLE.glass, '#2c3a4a', 3.3],
  'nation media house': [STYLE.concrete, '#dedad2', 3.6],
  'national bank houe': [STYLE.concrete, '#c9bda4', 3.4],
  'rahimtulla tower': [STYLE.concrete, '#d9cdb0', 3.6],
  'hilton hotel nairobi': [STYLE.ribbon, '#e4e0d8', 3.2],
  'anniversary towers': [STYLE.glass, '#4b6a6a', 3.1],
  'lonrho house': [STYLE.glass, '#35507a', 3.4],
  'hazina towers': [STYLE.concrete, '#d8d4cb', 3.3],
  'ecobank towers': [STYLE.concrete, '#cdbf9f', 3.3],
  'university of nairobi tower': [STYLE.concrete, '#b9b4aa', 3.3],
  '4th avenue towers': [STYLE.glass, '#7fa3b8', 3.5],
  'view park towers': [STYLE.ribbon, '#c9bfae', 3.2],
  'reinsurance plaza': [STYLE.concrete, '#c5bba7', 3.3],
  'uchumi house': [STYLE.concrete, '#c9c3b6', 3.3],
  'ambank house': [STYLE.concrete, '#b7ab93', 3.3]
};

function hash01(id) {
  let h = (id * 2654435761) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
const tmp = new THREE.Color();
const pick = (list, r) => new THREE.Color().setStyle(list[Math.floor(r * list.length) % list.length], THREE.SRGBColorSpace);

// A building's look: { style, tint, floorH, bayW, seed }
function appearance(b) {
  const r = hash01(b.id);
  const r2 = hash01(b.id + 7);
  const tall = b.h > 45 && !b.est;
  let style = STYLE.render;
  if (tall) style = r < 0.6 ? STYLE.glass : STYLE.concrete;
  else if (b.h > 18) style = r < 0.35 ? STYLE.concrete : r < 0.5 ? STYLE.glass : STYLE.render;
  else if (r < 0.2) style = STYLE.concrete;
  let tint = pick(style === STYLE.glass ? GLASS : style === STYLE.concrete ? CONCRETE : RENDER, r2);
  if (b.colour && style !== STYLE.glass) {
    try {
      // OSM colours are CSS names or hex (anything else falls through to the palette); named ones like "blue" are pure
      // primaries, so saturation is capped and lightness kept off the extremes
      if (/^(#[0-9a-f]{3,6}|[a-z]+)$/i.test(b.colour)) {
        const hsl = tmp.setStyle(b.colour, THREE.SRGBColorSpace).getHSL({}, THREE.SRGBColorSpace);
        tint = new THREE.Color().setHSL(hsl.h, Math.min(hsl.s, 0.35), THREE.MathUtils.clamp(hsl.l, 0.35, 0.88), THREE.SRGBColorSpace);
      }
    } catch {}
  }
  // storeys: OSM's levels where it has them, else offices at 3.6 m, the rest at 3.1 m
  let floorH = b.levels > 1 && b.h / b.levels > 2.5 && b.h / b.levels < 5 ? b.h / b.levels : style === STYLE.render ? 3.1 : 3.6;
  const known = b.name && LANDMARKS[b.name.toLowerCase()];
  if (known) {
    style = known[0];
    tint = new THREE.Color().setStyle(known[1], THREE.SRGBColorSpace);
    floorH = known[2];
  }
  const bayW = style === STYLE.glass || style === STYLE.fins ? 1.6 + r2 * 0.8 : style === STYLE.concrete ? 2.6 + r2 * 1.2 : 2.2 + r2 * 1.4;
  return { style, tint, floorH, bayW, seed: Math.floor(r * 997) };
}

// One footing per tower: parts and podiums with the same name share the lowest base among them
export function footings() {
  const byName = new Map();
  const base = new Map();
  for (const b of GEO.buildings) {
    const own = baseOf(b.ring);
    base.set(b, own);
    if ((b.part || b.podium) && b.name) byName.set(b.name, Math.min(byName.get(b.name) ?? Infinity, own));
  }
  for (const b of GEO.buildings) if ((b.part || b.podium) && b.name) base.set(b, byName.get(b.name));
  return base;
}

// The ring moved d m inwards (outer rings are counter-clockwise in x/z: inwards is to their left)
function inset(ring, d) {
  const n = ring.length / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    const ax = ring[2 * i] - ring[2 * p], az = ring[2 * i + 1] - ring[2 * p + 1];
    const bx = ring[2 * q] - ring[2 * i], bz = ring[2 * q + 1] - ring[2 * i + 1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    // inward normals of the two edges, averaged, scaled to keep the offset d along both
    const nx = (-az / la - bz / lb) / 2, nz = (ax / la + bx / lb) / 2;
    const l2 = nx * nx + nz * nz || 1;
    out.push(ring[2 * i] + (nx / l2) * d, ring[2 * i + 1] + (nz / l2) * d);
  }
  return out;
}

export function buildBuildings() {
  const base = footings();
  const pos = [];
  const nrm = [];
  const tint = [];
  const wuv = [];
  const wall = [];
  const dims = [];
  let look = null;
  const push = (p, n, uv, w) => {
    pos.push(p[0], p[1], p[2]);
    nrm.push(n[0], n[1], n[2]);
    tint.push(look.tint.r, look.tint.g, look.tint.b);
    wuv.push(uv[0], uv[1]);
    wall.push(w[0], w[1], w[2], look.seed);
    dims.push(look.floorH, look.bayW);
  };
  // A wall from a to b (x, z), from y0 to y1, facing out of a counter-clockwise ring, in the given style
  const quad = (ax, az, bx, bz, y0, y1, style, flip = false) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) return;
    const s = flip ? -1 : 1;
    const N = [((bz - az) / len) * s, 0, (-(bx - ax) / len) * s];
    const H = y1 - y0;
    const W = [len, H, style];
    const a0 = [ax, y0, az], a1 = [ax, y1, az], b0 = [bx, y0, bz], b1 = [bx, y1, bz];
    const order = flip ? [a0, b0, b1, a0, b1, a1] : [a0, b1, b0, a0, a1, b1];
    const uvs = flip ? [[0, 0], [len, 0], [len, H], [0, 0], [len, H], [0, H]] : [[0, 0], [len, H], [len, 0], [0, 0], [0, H], [len, H]];
    for (let i = 0; i < 6; i++) push(order[i], N, uvs[i], W);
  };
  const ring = (f, y0, y1, style, flip = false) => {
    const n = f.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      quad(f[2 * i], f[2 * i + 1], f[2 * j], f[2 * j + 1], y0, y1, style, flip);
    }
  };
  const toV2 = (f) => {
    const out = [];
    for (let i = 0; i < f.length; i += 2) out.push(new THREE.Vector2(f[i], f[i + 1]));
    return out;
  };
  // A flat polygon (contour with holes) at height y, facing up, in the roof style
  const flat = (contour, holes, y) => {
    const all = contour.concat(...holes);
    const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    let big = null, bigArea = 0;
    for (const [i, j, k] of tris) {
      const p = all[i], q = all[j], r = all[k];
      const cross = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      const [s, t] = cross < 0 ? [q, r] : [r, q]; // keep the winding that faces +y
      for (const v of [p, s, t]) push([v.x, y, v.y], [0, 1, 0], [v.x, v.y], [1, 1, STYLE.roof]);
      if (Math.abs(cross) > bigArea) [big, bigArea] = [[p, q, r], Math.abs(cross)];
    }
    return { big, area: bigArea / 2 };
  };
  const box = (cx, cz, hx, hz, y0, y1) => {
    const c = [cx - hx, cz - hz, cx + hx, cz - hz, cx + hx, cz + hz, cx - hx, cz + hz];
    ring(c, y0, y1, STYLE.plain);
    flat(toV2(c), [], y1);
  };

  for (const b of GEO.buildings) {
    const y0 = base.get(b) + (b.minH || 0);
    const y1 = base.get(b) + b.h;
    if (y1 - y0 < 0.5) continue;
    look = appearance(b);
    const parapet = y1 - y0 >= 6 ? PARAPET : 0;
    // walls (outer rings are counter-clockwise in x/z, holes clockwise), up to the top of the parapet
    for (const r of [b.ring, ...(b.holes || [])]) ring(r, y0, y1 + parapet, look.style);
    // the roof, with the parapet's inner face and top round it
    const { big } = flat(toV2(b.ring), (b.holes || []).map(toV2), y1);
    if (parapet) {
      const inner = inset(b.ring, PARAPET_W);
      ring(inner, y1, y1 + parapet, STYLE.roof, true);
      const n = inner.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const o0 = [b.ring[2 * i], b.ring[2 * i + 1]], o1 = [b.ring[2 * j], b.ring[2 * j + 1]];
        const i0 = [inner[2 * i], inner[2 * i + 1]], i1 = [inner[2 * j], inner[2 * j + 1]];
        const top = y1 + parapet;
        for (const v of [o0, i1, o1, o0, i0, i1]) push([v[0], top, v[1]], [0, 1, 0], [v[0], v[1]], [1, 1, STYLE.roof]);
      }
    }
    // a lift motor room on the roofs of the bigger buildings, where there is room for it
    if (big && b.h >= 10 && !b.part) {
      const [p, q, r] = big;
      const cx = (p.x + q.x + r.x) / 3, cz = (p.y + q.y + r.y) / 3;
      const area = Math.abs((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)) / 2;
      if (area > 60 && hash01(b.id + 3) < 0.7) box(cx, cz, 1.8, 1.5, y1, y1 + 2.6);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 3));
  geo.setAttribute('wuv', new THREE.Float32BufferAttribute(wuv, 2));
  geo.setAttribute('wall', new THREE.Float32BufferAttribute(wall, 4));
  geo.setAttribute('dims', new THREE.Float32BufferAttribute(dims, 2));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, createFacadeMaterial());
  mesh.name = 'buildings';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
