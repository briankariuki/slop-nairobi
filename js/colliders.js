import { GEO } from './nairobi-geodata.js';
import { heightAt } from './terrain.js';
import { pavementLift } from './street-geometry.js';
import { footings } from './buildings.js';
import { deckPieces, deckTop, DECK, PARAPET } from './bridges.js';

// What the player stands on and runs into. New York's colliders are boxes; Nairobi's buildings are OSM footprints of any
// shape, so every wall is a segment collider instead (two-sided, so a courtyard or a hole in a ring works too), and a body
// that ends up inside a footprint all the same is pushed back out through its nearest wall. The Expressway's parapets
// (where the deck is high enough to fall off) and its piers are segment colliders as well.
//
// Surfaces: the terrain with the streets on it (sidewalks a kerb's height over the asphalt, streets.js), the decks (so
// the player can drive up the slip roads, along the Expressway and under it) and, for the helicopter, the roofs. surfaceAt(x, z, y) is the highest one at (x, z) that a body at height y can step onto.

const CELL = 24;
const STEP_UP = 0.7; // highest step onto a surface (m)
const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);

function grid() {
  const cells = new Map();
  return {
    add(item, minX, minZ, maxX, maxZ) {
      for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
        for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
          const k = key(ix, iz);
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(item);
        }
      }
    },
    // items whose cells meet the square of half size r around (x, z), each once, into `out`
    near(x, z, r, out, stamp) {
      out.length = 0;
      for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
        for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
          const list = cells.get(key(ix, iz));
          if (!list) continue;
          for (const c of list) {
            if (c._seen === stamp) continue;
            c._seen = stamp;
            out.push(c);
          }
        }
      }
      return out;
    }
  };
}

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

export function buildColliders(pierBoxes = []) {
  const walls = grid(); // wall segments: { ax, az, bx, bz, minY, maxY }
  const solids = grid(); // building footprints: { ring, holes, minY, maxY, minX, minZ, maxX, maxZ }
  const decks = grid(); // deck pieces (bridges.js)
  let wallCount = 0;
  const addWall = (ax, az, bx, bz, minY, maxY) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) return;
    walls.add({ ax, az, bx, bz, len, ux: (bx - ax) / len, uz: (bz - az) / len, minY, maxY },
      Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz));
    wallCount++;
  };

  const base = footings();
  for (const b of GEO.buildings) {
    const minY = base.get(b) + (b.minH || 0);
    const maxY = base.get(b) + b.h;
    if (maxY - minY < 0.5) continue;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const ring of [b.ring, ...(b.holes || [])]) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        addWall(ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1], minY, maxY);
        minX = Math.min(minX, ring[2 * i]); maxX = Math.max(maxX, ring[2 * i]);
        minZ = Math.min(minZ, ring[2 * i + 1]); maxZ = Math.max(maxZ, ring[2 * i + 1]);
      }
    }
    solids.add({ ring: b.ring, holes: b.holes || [], minY, maxY, minX, minZ, maxX, maxZ }, minX, minZ, maxX, maxZ);
  }

  for (const [x, z, y0, y1, h] of pierBoxes) {
    const c = [x - h, z - h, x + h, z - h, x + h, z + h, x - h, z + h];
    for (let i = 0; i < 4; i++) addWall(c[2 * i], c[2 * i + 1], c[(2 * i + 2) % 8], c[(2 * i + 3) % 8], y0, y1);
  }

  for (const p of deckPieces()) {
    const len = Math.hypot(p.bx - p.ax, p.bz - p.az);
    p.ux = (p.bx - p.ax) / len;
    p.uz = (p.bz - p.az) / len;
    p.len = len;
    decks.add(p, Math.min(p.ax, p.bx) - p.half, Math.min(p.az, p.bz) - p.half, Math.max(p.ax, p.bx) + p.half, Math.max(p.az, p.bz) + p.half);
    // parapets wherever falling off would hurt (the foot of a ramp stays open)
    if (Math.min(p.la, p.lb) < 1.5) continue;
    for (const side of [1, -1]) {
      const ox = -p.uz * p.half * side, oz = p.ux * p.half * side;
      const top = Math.min(deckTop(p.ax + ox, p.az + oz, p.la), deckTop(p.bx + ox, p.bz + oz, p.lb));
      addWall(p.ax + ox, p.az + oz, p.bx + ox, p.bz + oz, top - DECK, top + PARAPET);
    }
  }

  let stamp = 0;
  const nearWalls = [];
  const nearSolids = [];
  const nearDecks = [];

  // Height of the deck at (x, z), or -Infinity off every deck
  function deckAt(x, z, y) {
    let best = -Infinity;
    for (const p of decks.near(x, z, 0, nearDecks, ++stamp)) {
      const dx = x - p.ax, dz = z - p.az;
      const t = dx * p.ux + dz * p.uz;
      if (t < -0.5 || t > p.len + 0.5 || Math.abs(dx * p.uz - dz * p.ux) > p.half) continue;
      const l = p.la + (p.lb - p.la) * Math.max(0, Math.min(1, t / p.len));
      const h = deckTop(x, z, l);
      if (h <= y + STEP_UP && h > best) best = h;
    }
    return best;
  }

  // The footprint (x, z) is inside whose walls meet the heights from y0 to y1 (a body's feet to its head), if any
  function solidAt(x, z, y0, y1 = y0) {
    for (const s of solids.near(x, z, 0, nearSolids, ++stamp)) {
      if (y0 >= s.maxY || y1 < s.minY) continue;
      if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      if (inRing(s.ring, x, z) && !s.holes.some((h) => inRing(h, x, z))) return s;
    }
    return null;
  }

  // Highest roof at (x, z) a body at height y can come down onto
  function roofAt(x, z, y) {
    let best = -Infinity;
    for (const s of solids.near(x, z, 0, nearSolids, ++stamp)) {
      if (s.maxY > y + STEP_UP || s.maxY <= best) continue;
      if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      if (inRing(s.ring, x, z) && !s.holes.some((h) => inRing(h, x, z))) best = s.maxY;
    }
    return best;
  }

  return {
    walls: wallCount,
    // Surface under a body at (x, z, y): the terrain, a deck it can step onto, or (roofs = true) a roof
    surfaceAt(x, z, y = Infinity, roofs = false) {
      let h = heightAt(x, z) + pavementLift(x, z); // the terrain, or the streets on it
      h = Math.max(h, deckAt(x, z, y));
      if (roofs) h = Math.max(h, roofAt(x, z, y));
      return h;
    },
    nearWalls(x, z, r) {
      return walls.near(x, z, r, nearWalls, ++stamp);
    },
    solidAt
  };
}

// Contact between a body at (x, y, z) and wall w, into `contact` ({ nx, nz, depth }: the push that separates them).
// body: { car, sin, cos, hx, hz, radius, bottom, top } as built by controllers.js: a circle of `radius`, or for the car
// a rectangle hx wide and hz long either side of its centre, turned to its heading.
export function wallContact(w, x, y, z, body, contact) {
  if (y + body.bottom >= w.maxY || y + body.top <= w.minY) return false;
  const dx = x - w.ax, dz = z - w.az;
  if (!body.car) {
    const t = Math.max(0, Math.min(w.len, dx * w.ux + dz * w.uz));
    const qx = dx - w.ux * t, qz = dz - w.uz * t;
    const d = Math.hypot(qx, qz);
    if (d >= body.radius) return false;
    if (d > 1e-6) {
      contact.nx = qx / d; contact.nz = qz / d;
    } else {
      contact.nx = -w.uz; contact.nz = w.ux;
    }
    contact.depth = body.radius - d;
    return true;
  }
  // Separating axes of a rectangle and a segment: the rectangle's two axes and the segment's normal
  let depth = Infinity, nx = 0, nz = 0;
  const bx = w.bx - x, bz = w.bz - z;
  for (let axis = 0; axis < 3; axis++) {
    const ax = axis === 0 ? body.cos : axis === 1 ? body.sin : -w.uz;
    const az = axis === 0 ? -body.sin : axis === 1 ? body.cos : w.ux;
    // segment ends relative to the body centre, projected
    const p0 = -dx * ax - dz * az, p1 = bx * ax + bz * az;
    const extent = body.hx * Math.abs(ax * body.cos - az * body.sin) + body.hz * Math.abs(ax * body.sin + az * body.cos);
    const lo = Math.min(p0, p1), hi = Math.max(p0, p1);
    // push the body to whichever side of the segment needs less travel
    const push = Math.min(hi + extent, extent - lo);
    if (push <= 0) return false;
    if (push < depth) {
      depth = push;
      const sign = hi + extent < extent - lo ? 1 : -1;
      nx = ax * sign; nz = az * sign;
    }
  }
  contact.nx = nx; contact.nz = nz; contact.depth = depth;
  return true;
}
