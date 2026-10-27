import * as THREE from 'three/webgpu';
import { GEO } from './nairobi-geodata.js';
import { heightAt } from './terrain.js';
import { isElevated, liftAlong, liftBreaks, linkLength, roadHeight, LAYER_LIFT } from './elevation.js';

// Elevated roads — the Nairobi Expressway and the CBD flyovers — as 3D decks on pillars, as high as elevation.js says:
// the same rule the traffic drives by, so cars run on the decks. Drivable ones are built from the road graph's links
// (slip roads ramping from the street up to the deck, decks ramping down where they meet the street); footbridges and
// other raised ways the graph doesn't carry stand level at LAYER_LIFT m per layer. The deck surface follows the
// ground's cross slope (each edge at roadHeight() over its own point), like the traffic's wheels.

const STEP = 8; // m between deck samples, so decks follow the terrain
const PIER_EVERY = 32;
const PIER = 1.8;

// Points along a flat [x, z, ...] polyline every STEP m or less, at its vertices and at the distances in `extra`, each
// as [x, z, distance along it]
function resample(f, extra = []) {
  const out = [];
  let d0 = 0;
  for (let i = 0; i < f.length - 2; i += 2) {
    const [ax, az, bx, bz] = [f[i], f[i + 1], f[i + 2], f[i + 3]];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / STEP));
    const at = [];
    for (let k = 0; k < n; k++) at.push(k / n);
    for (const d of extra) if (d > d0 && d < d0 + len) at.push((d - d0) / len);
    at.sort((p, q) => p - q);
    for (const t of at) out.push([ax + (bx - ax) * t, az + (bz - az) * t, d0 + len * t]);
    d0 += len;
  }
  out.push([f[f.length - 2], f[f.length - 1], d0]);
  return out;
}

// Every elevated deck as straight pieces between resampled points: { ax, az, la, bx, bz, lb, half } with the lift at each
// end and the half width to the parapets. Shared by the deck mesh and the player's colliders and surfaces (colliders.js).
let _pieces;
export function deckPieces() {
  if (_pieces) return _pieces;
  // { pts, w, lift(d), breaks } for every elevated link of the road graph, and every elevated way it doesn't carry
  const links = GEO.roadGraph.links.filter(isElevated);
  const inGraph = new Set(links.map((l) => l.way));
  const others = GEO.roads.filter((r) => isElevated(r) && !inGraph.has(r.id));
  const decks = [
    ...links.map((l) => {
      const total = linkLength(l);
      return { pts: l.pts, w: l.w, lift: (d) => liftAlong(l, d, total), breaks: liftBreaks(l, total) };
    }),
    ...others.map((r) => ({ pts: r.pts, w: r.w, lift: () => r.layer * LAYER_LIFT, breaks: [] }))
  ];
  _pieces = [];
  for (const [deck, r] of decks.entries()) {
    const pts = resample(r.pts, r.breaks).map(([x, z, d]) => [x, z, r.lift(d)]);
    const half = r.w / 2 + 0.6; // carriageway plus a parapet
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az, la] = pts[i];
      const [bx, bz, lb] = pts[i + 1];
      if (Math.hypot(bx - ax, bz - az) >= 1e-3) _pieces.push({ deck, ax, az, la, bx, bz, lb, half });
    }
  }
  _pieces.decks = decks.length;
  return _pieces;
}

// Deck surface height at (x, z) where the lift is l: a few cm proud of the ground at the foot of a ramp, so it doesn't
// flicker through the terrain there
export const deckTop = (x, z, l) => roadHeight(x, z, l) + 0.12 * Math.max(0, 1 - l);
export const DECK = 1.4; // deck thickness
export const PARAPET = 0.9;

export function buildBridges() {
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

  // pier boxes as [x, z, bottom, top, half], for colliders.js
  const piers = [];
  let deck = -1;
  let sincePier = 0;
  for (const { deck: k, ax, az, la, bx, bz, lb, half } of deckPieces()) {
    if (k !== deck) [deck, sincePier] = [k, PIER_EVERY / 2];
    const len = Math.hypot(bx - ax, bz - az);
    // left/right offsets of the deck edges
    const ox = (-(bz - az) / len) * half;
    const oz = ((bx - ax) / len) * half;
    const L = [ax + ox, az + oz, bx + ox, bz + oz];
    const R = [ax - ox, az - oz, bx - ox, bz - oz];
    // deck surface heights at the four corners
    const yL = [deckTop(L[0], L[1], la), deckTop(L[2], L[3], lb)];
    const yR = [deckTop(R[0], R[1], la), deckTop(R[2], R[3], lb)];
    // road surface, both deck sides, underside
    quad([L[0], yL[0], L[1]], [L[2], yL[1], L[3]], [R[2], yR[1], R[3]], [R[0], yR[0], R[1]], asphalt);
    quad([L[0], yL[0] - DECK, L[1]], [L[2], yL[1] - DECK, L[3]], [L[2], yL[1], L[3]], [L[0], yL[0], L[1]], concrete);
    quad([R[0], yR[0], R[1]], [R[2], yR[1], R[3]], [R[2], yR[1] - DECK, R[3]], [R[0], yR[0] - DECK, R[1]], concrete);
    quad([R[0], yR[0] - DECK, R[1]], [R[2], yR[1] - DECK, R[3]], [L[2], yL[1] - DECK, L[3]], [L[0], yL[0] - DECK, L[1]], concrete);
    // parapets
    quad([L[0], yL[0], L[1]], [L[2], yL[1], L[3]], [L[2], yL[1] + PARAPET, L[3]], [L[0], yL[0] + PARAPET, L[1]], concrete);
    quad([R[0], yR[0] + PARAPET, R[1]], [R[2], yR[1] + PARAPET, R[3]], [R[2], yR[1], R[3]], [R[0], yR[0], R[1]], concrete);
    // piers wherever the deck is high enough to stand on one
    sincePier += len;
    const g = heightAt(ax, az);
    const ya = Math.min(yL[0], yR[0]);
    if (sincePier >= PIER_EVERY && ya - DECK - g > 2.5) {
      box(ax, az, g - 1, ya - DECK, PIER / 2, concrete);
      piers.push([ax, az, g - 1, ya - DECK, PIER / 2]);
      sincePier = 0;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
  mesh.name = 'bridges';
  mesh.userData = { roads: deckPieces().decks, piers };
  return mesh;
}
