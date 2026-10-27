import * as THREE from 'three/webgpu';
import { GEO } from './nairobi-geodata.js';
import { heightAt } from './terrain.js';
import { isElevated } from './ground.js';

// Elevated roads — the Nairobi Expressway and the CBD flyovers — as 3D decks on pillars. OSM says only that they are
// raised (layer), not by how much, so each layer lifts the deck LAYER_LIFT m over the ground under it. A slip road
// climbs from the street to the deck: its end that meets an elevated mainline is at full height, the other at ground.

const LAYER_LIFT = 8;
const STEP = 8; // m between deck samples, so decks follow the terrain
const DECK = 1.4; // deck thickness
const PIER_EVERY = 32;
const PIER = 1.8;

const key = (x, z) => `${Math.round(x)},${Math.round(z)}`;

function resample(f) {
  const out = [];
  for (let i = 0; i < f.length - 2; i += 2) {
    const [ax, az, bx, bz] = [f[i], f[i + 1], f[i + 2], f[i + 3]];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  out.push([f[f.length - 2], f[f.length - 1]]);
  return out;
}

export function buildBridges() {
  const elevated = GEO.roads.filter(isElevated);
  // vertices of elevated mainlines, to tell which end of a slip road joins the deck
  const onDeck = new Set();
  for (const r of elevated) if (!r.link) for (let i = 0; i < r.pts.length; i += 2) onDeck.add(key(r.pts[i], r.pts[i + 1]));

  const pos = [];
  const nrm = [];
  const col = [];
  const asphalt = new THREE.Color('#3b3a38');
  const concrete = new THREE.Color('#bdb7aa');
  const tri = (a, b, c, color) => {
    const n = new THREE.Vector3().subVectors(new THREE.Vector3(...b), new THREE.Vector3(...a)).cross(new THREE.Vector3().subVectors(new THREE.Vector3(...c), new THREE.Vector3(...a))).normalize();
    for (const p of [a, b, c]) {
      pos.push(...p);
      nrm.push(n.x, n.y, n.z);
      col.push(color.r, color.g, color.b);
    }
  };
  const quad = (a, b, c, d, color) => {
    tri(a, b, c, color);
    tri(a, c, d, color);
  };
  const box = (x, z, y0, y1, half, color) => {
    const c = [
      [x - half, z - half],
      [x + half, z - half],
      [x + half, z + half],
      [x - half, z + half]
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = c[i];
      const [bx, bz] = c[(i + 1) % 4];
      quad([ax, y0, az], [ax, y1, az], [bx, y1, bz], [bx, y0, bz], color);
    }
  };

  let piers = 0;
  for (const r of elevated) {
    const pts = resample(r.pts);
    const full = r.layer * LAYER_LIFT;
    let lift0 = full;
    let lift1 = full;
    if (r.link) {
      const n = r.pts.length;
      lift0 = onDeck.has(key(r.pts[0], r.pts[1])) ? full : 0;
      lift1 = onDeck.has(key(r.pts[n - 2], r.pts[n - 1])) ? full : 0;
      if (!lift0 && !lift1) lift0 = lift1 = full; // a raised slip road between two other ramps
    }
    // cumulative distance, for the ramp profile
    const dist = [0];
    for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = dist[dist.length - 1] || 1;
    const top = pts.map(([x, z], i) => heightAt(x, z) + lift0 + (lift1 - lift0) * (dist[i] / total) + 0.2);
    const half = r.w / 2 + 0.6; // carriageway plus a parapet

    let sincePier = PIER_EVERY / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      // left/right offsets of the deck edges
      const ox = (-(bz - az) / len) * half;
      const oz = ((bx - ax) / len) * half;
      const ya = top[i];
      const yb = top[i + 1];
      const L = [ax + ox, az + oz, bx + ox, bz + oz];
      const R = [ax - ox, az - oz, bx - ox, bz - oz];
      // road surface, both deck sides, underside
      quad([L[0], ya, L[1]], [L[2], yb, L[3]], [R[2], yb, R[3]], [R[0], ya, R[1]], asphalt);
      quad([L[0], ya - DECK, L[1]], [L[2], yb - DECK, L[3]], [L[2], yb, L[3]], [L[0], ya, L[1]], concrete);
      quad([R[0], ya, R[1]], [R[2], yb, R[3]], [R[2], yb - DECK, R[3]], [R[0], ya - DECK, R[1]], concrete);
      quad([R[0], ya - DECK, R[1]], [R[2], yb - DECK, R[3]], [L[2], yb - DECK, L[3]], [L[0], ya - DECK, L[1]], concrete);
      // parapets
      for (const [E, s] of [[L, 1], [R, -1]]) {
        const lip = 0.9;
        if (s > 0) quad([E[0], ya, E[1]], [E[2], yb, E[3]], [E[2], yb + lip, E[3]], [E[0], ya + lip, E[1]], concrete);
        else quad([E[0], ya + lip, E[1]], [E[2], yb + lip, E[3]], [E[2], yb, E[3]], [E[0], ya, E[1]], concrete);
      }
      // piers wherever the deck is high enough to stand on one
      sincePier += len;
      const g = heightAt(ax, az);
      if (sincePier >= PIER_EVERY && ya - DECK - g > 2.5) {
        box(ax, az, g - 1, ya - DECK, PIER / 2, concrete);
        sincePier = 0;
        piers++;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
  mesh.name = 'bridges';
  mesh.userData = { roads: elevated.length, piers };
  return mesh;
}
