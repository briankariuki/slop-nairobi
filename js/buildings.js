import * as THREE from 'three/webgpu';
import { GEO } from './nairobi-geodata.js';
import { baseOf } from './terrain.js';

// Every building as one merged mesh: walls extruded from the footprint ring (and courtyard holes), a flat roof, vertex
// colours. A building stands on the lowest point of its footprint, so on a slope its uphill side sinks into the ground
// instead of the downhill side floating. The pieces of one tower (its building:parts and podium) share one footing.

const SKY = new THREE.Color('#9fc4e4');

// Facade colours: Nairobi's CBD is mostly cream, sand and grey concrete; towers lean to glass
const FACADES = ['#e7dcc4', '#d9cdb2', '#cfc6b8', '#e9e4da', '#c8b99c', '#b9b3aa', '#d8c3a0', '#c9a98a', '#a9a59e'];
const GLASS = ['#6f8ea3', '#5d7c8f', '#7d97a6', '#8aa1ad', '#4f6b7d'];

function hash01(id) {
  let h = (id * 2654435761) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
const tmp = new THREE.Color();
function facadeColour(b) {
  if (b.colour) {
    try {
      // OSM colours are CSS names or hex (anything else falls through to the palette); named ones like "blue" are pure
      // primaries, so saturation is capped and lightness kept off the extremes
      if (/^(#[0-9a-f]{3,6}|[a-z]+)$/i.test(b.colour)) {
        const hsl = tmp.setStyle(b.colour, THREE.SRGBColorSpace).getHSL({}, THREE.SRGBColorSpace);
        return new THREE.Color().setHSL(hsl.h, Math.min(hsl.s, 0.3), THREE.MathUtils.clamp(hsl.l, 0.3, 0.85), THREE.SRGBColorSpace);
      }
    } catch {}
  }
  const r = hash01(b.id);
  const tall = b.h > 45 && !b.est;
  const list = tall && r < 0.55 ? GLASS : FACADES;
  return new THREE.Color().setStyle(list[Math.floor(hash01(b.id + 7) * list.length)], THREE.SRGBColorSpace);
}

// One footing per tower: parts and podiums with the same name share the lowest base among them
function footings() {
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

export function buildBuildings() {
  const base = footings();
  const pos = [];
  const nrm = [];
  const col = [];
  const push = (p, n, c) => {
    pos.push(p[0], p[1], p[2]);
    nrm.push(n[0], n[1], n[2]);
    col.push(c.r, c.g, c.b);
  };

  const wallC = new THREE.Color();
  const roofC = new THREE.Color();
  for (const b of GEO.buildings) {
    const y0 = base.get(b) + (b.minH || 0);
    const y1 = base.get(b) + b.h;
    if (y1 - y0 < 0.5) continue;
    const facade = facadeColour(b);
    roofC.copy(facade).multiplyScalar(0.72).lerp(tmp.set('#8a8780'), 0.5);

    // walls: each ring edge a quad, outward-facing (outer rings are CCW in x/z, holes CW)
    for (const ring of [b.ring, ...(b.holes || [])]) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[2 * i];
        const az = ring[2 * i + 1];
        const bx = ring[2 * j];
        const bz = ring[2 * j + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-3) continue;
        const nx = (bz - az) / len;
        const nz = -(bx - ax) / len;
        // a touch of sky in walls facing north-east, where the sun of the equator spends the morning
        wallC.copy(facade).lerp(SKY, 0.04 * Math.max(0, nx - nz));
        const a0 = [ax, y0, az];
        const a1 = [ax, y1, az];
        const b0 = [bx, y0, bz];
        const b1 = [bx, y1, bz];
        const N = [nx, 0, nz];
        push(a0, N, wallC);
        push(b1, N, wallC);
        push(b0, N, wallC);
        push(a0, N, wallC);
        push(a1, N, wallC);
        push(b1, N, wallC);
      }
    }

    // roof: the footprint (with its holes) triangulated, facing up
    const toV2 = (f) => {
      const out = [];
      for (let i = 0; i < f.length; i += 2) out.push(new THREE.Vector2(f[i], f[i + 1]));
      return out;
    };
    const contour = toV2(b.ring);
    const holes = (b.holes || []).map(toV2);
    const all = contour.concat(...holes);
    const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    for (const [i, j, k] of tris) {
      const p = all[i];
      const q = all[j];
      const r = all[k];
      // keep the winding that faces +y
      const up = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) < 0;
      const [s, t] = up ? [q, r] : [r, q];
      push([p.x, y1, p.y], [0, 1, 0], roofC);
      push([s.x, y1, s.y], [0, 1, 0], roofC);
      push([t.x, y1, t.y], [0, 1, 0], roofC);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 }));
  mesh.name = 'buildings';
  return mesh;
}
