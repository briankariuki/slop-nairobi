import { GEO } from './nairobi-geodata.js';
import { isElevated } from './elevation.js';

// Where people can walk. Manhattan's curbs and blocks are surveyed polygons; Nairobi's aren't mapped, so they are
// worked out here on a CELL m grid over the terrain's extent:
// - streets at ground level (each as wide as its carriageway plus the kerb), rail and water are barriers; buildings
//   (those standing on the ground) are obstacles;
// - a block (curb island) is a connected stretch of ground between barriers, buildings included: walking between two
//   points of the same block never crosses a road;
// - the sidewalk is the walkable ground within SIDEWALK m of a road: where the footpaths are, built or trodden.
// blockAt, walkable and onSidewalk are the queries pedestrian-routes.js asks of Slop New York's surveyed city.

const CELL = 2;
const SIDEWALK = 7;
const ROAD = 1;
const BARRIER = 2; // rail, water
const BUILDING = 4;
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'bridleway', 'corridor']);

const T = GEO.terrain;
const X0 = T.x0;
const Z0 = T.z0;
const NX = Math.ceil(((T.nx - 1) * T.cell) / CELL);
const NZ = Math.ceil(((T.nz - 1) * T.cell) / CELL);
const mask = new Uint8Array(NX * NZ);

// Every cell within r m of the segment (ax, az)-(bx, bz)
function stamp(ax, az, bx, bz, r, bit) {
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - X0) / CELL));
  const i1 = Math.min(NX - 1, Math.floor((Math.max(ax, bx) + r - X0) / CELL));
  const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r - Z0) / CELL));
  const j1 = Math.min(NZ - 1, Math.floor((Math.max(az, bz) + r - Z0) / CELL));
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  for (let j = j0; j <= j1; j++) {
    const z = Z0 + (j + 0.5) * CELL;
    for (let i = i0; i <= i1; i++) {
      const x = X0 + (i + 0.5) * CELL;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const ex = ax + dx * t - x;
      const ez = az + dz * t - z;
      if (ex * ex + ez * ez <= r * r) mask[j * NX + i] |= bit;
    }
  }
}
function stampLine(f, r, bit) {
  for (let k = 0; k + 3 < f.length; k += 2) stamp(f[k], f[k + 1], f[k + 2], f[k + 3], r, bit);
}
// Every cell whose centre is inside the flat [x, z, ...] ring (scanlines, even-odd)
function fill(ring, bit) {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let k = 1; k < ring.length; k += 2) [zMin, zMax] = [Math.min(zMin, ring[k]), Math.max(zMax, ring[k])];
  const j0 = Math.max(0, Math.ceil((zMin - Z0) / CELL - 0.5));
  const j1 = Math.min(NZ - 1, Math.floor((zMax - Z0) / CELL - 0.5));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = Z0 + (j + 0.5) * CELL;
    xs.length = 0;
    for (let k = 0, m = ring.length - 2; k < ring.length; m = k, k += 2) {
      const [ax, az, bx, bz] = [ring[m], ring[m + 1], ring[k], ring[k + 1]];
      if (az <= z !== bz <= z) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - X0) / CELL - 0.5));
      const i1 = Math.min(NX - 1, Math.floor((xs[k + 1] - X0) / CELL - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * NX + i] |= bit;
    }
  }
}

for (const r of GEO.roads) {
  if (FOOT.has(r.kind) || r.kind === 'service' || r.tunnel || isElevated(r)) continue; // people walk over driveways
  stampLine(r.pts, r.w / 2 + 0.6, ROAD);
}
for (const r of GEO.rail) if (r.kind !== 'platform') stampLine(r.pts, 2, BARRIER);
for (const r of GEO.rivers) if (!r.culvert) stampLine(r.pts, r.kind === 'river' ? 4.5 : 1.75, BARRIER);
for (const a of GEO.areas) if (a.kind === 'water') fill(a.ring, BARRIER);
for (const b of GEO.buildings) if (!b.minH) fill(b.ring, BUILDING);

// Blocks: 4-connected components of the cells that are neither road nor barrier
const label = new Int32Array(NX * NZ);
const blocks = [null];
{
  const stack = new Int32Array(NX * NZ);
  for (let c = 0; c < label.length; c++) {
    if (label[c] || mask[c] & (ROAD | BARRIER)) continue;
    const id = blocks.length;
    blocks.push({ id, cells: 0 });
    let top = 0;
    stack[top++] = c;
    label[c] = id;
    while (top) {
      const k = stack[--top];
      blocks[id].cells++;
      const i = k % NX;
      for (const n of [i > 0 ? k - 1 : -1, i < NX - 1 ? k + 1 : -1, k - NX, k + NX]) {
        if (n < 0 || n >= label.length || label[n] || mask[n] & (ROAD | BARRIER)) continue;
        label[n] = id;
        stack[top++] = n;
      }
    }
  }
}

// Cells to the nearest road cell (8-connected steps, so up to √2 × too far on the diagonal), capped at 255
const roadSteps = new Uint8Array(NX * NZ).fill(255);
{
  let front = [];
  for (let c = 0; c < mask.length; c++) if (mask[c] & ROAD) { roadSteps[c] = 0; front.push(c); }
  const limit = Math.ceil(SIDEWALK / CELL) + 3;
  for (let d = 1; d <= limit && front.length; d++) {
    const next = [];
    for (const k of front) {
      const i = k % NX;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if ((i === 0 && di < 0) || (i === NX - 1 && di > 0)) continue;
          const n = k + dj * NX + di;
          if (n < 0 || n >= roadSteps.length || roadSteps[n] <= d) continue;
          roadSteps[n] = d;
          next.push(n);
        }
      }
    }
    front = next;
  }
}

const cellAt = (x, z) => {
  const i = Math.floor((x - X0) / CELL);
  const j = Math.floor((z - Z0) / CELL);
  return i < 0 || j < 0 || i >= NX || j >= NZ ? -1 : j * NX + i;
};

/** The block (curb island) under (x, z), or null on a road, in water or off the map */
function blockAt(x, z) {
  const c = cellAt(x, z);
  return c < 0 ? null : blocks[label[c]];
}

/** Is the box free of buildings and barriers (roads are fine: crosswalks span them)? */
function walkable(minX, maxX, minZ, maxZ) {
  const i0 = Math.max(0, Math.floor((minX - X0) / CELL));
  const i1 = Math.min(NX - 1, Math.floor((maxX - X0) / CELL));
  const j0 = Math.max(0, Math.floor((minZ - Z0) / CELL));
  const j1 = Math.min(NZ - 1, Math.floor((maxZ - Z0) / CELL));
  if (i0 > i1 || j0 > j1) return false;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (mask[j * NX + i] & (BUILDING | BARRIER)) return false;
  return true;
}

/** Is (x, z) on the sidewalk: open ground (no road, barrier or building) within SIDEWALK m of a road? */
function onSidewalk(x, z) {
  const c = cellAt(x, z);
  return c >= 0 && !mask[c] && roadSteps[c] * CELL <= SIDEWALK;
}

/** Roughly how far (x, z) is from the nearest road, in m (Infinity beyond a dozen) */
function roadDistance(x, z) {
  const c = cellAt(x, z);
  return c < 0 || roadSteps[c] === 255 ? Infinity : roadSteps[c] * CELL;
}

export { blockAt, walkable, onSidewalk, roadDistance };
