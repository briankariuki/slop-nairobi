import { GEO } from './nairobi-geodata.js';
import { heightAt, terrainNormal } from './terrain.js';
import { isElevated, ROAD_Y } from './elevation.js';

// The streets as geometry on the terrain (streets.js makes them meshes): carriageways, junctions, raised sidewalks with
// their kerbs, and footpaths. Slop New York's streets are the asphalt left between Manhattan's surveyed curb islands;
// Nairobi has no mapped kerbs, so the carriageways are the traffic's own roads (road-network.js `streets`: where the
// cars drive, as wide as the network makes them) plus OSM's service roads, and every road gets a sidewalk along both
// sides (where pedestrian-routes.js walks people), cut back wherever another carriageway crosses it, with a kerb wherever
// it meets the asphalt.
//
// Everything is convex polygons in (x, z) (flat [x0, z0, x1, z1, ...], counter-clockwise: positive shoelace area), laid
// on the ground by cutting them along the terrain mesh's grid lines and cell diagonals (drape): each piece then lies
// inside one terrain triangle, so with heightAt (which follows those triangles) it sits exactly on the ground.

export { ROAD_Y };
export const KERB = 0.15; // kerb height over the asphalt
export const WALK_Y = ROAD_Y + KERB; // sidewalk tops
export const PATH_Y = 0.05; // footpaths (at grade)
const SIDEWALK = 4.2; // width: pedestrian-routes.js walks people 1.7 and 2.8 m beyond the carriageway
const CORNER = 2.5; // how far each corner of a junction is cut back (a chamfer for the kerb's radius)
const NO_SIDEWALK_RANK = 7; // motorways
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway']);
const T = GEO.terrain;
const EPS = 1e-9;

// ---------------------------------------------------------------------------------------------------------------------
// Convex polygons
// ---------------------------------------------------------------------------------------------------------------------

export function area(p) {
  let a = 0;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
  return a / 2;
}

const ccw = (p) => {
  if (area(p) >= 0) return p;
  const q = [];
  for (let i = p.length - 2; i >= 0; i -= 2) q.push(p[i], p[i + 1]);
  return q;
};

// The part of p where nx·x + nz·z <= c, or null
export function clip(p, nx, nz, c) {
  const out = [];
  const n = p.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const ax = p[i], az = p[i + 1], bx = p[j], bz = p[j + 1];
    const da = nx * ax + nz * az - c;
    const db = nx * bx + nz * bz - c;
    if (da <= 0) out.push(ax, az);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, az + (bz - az) * t);
    }
  }
  return out.length >= 6 && Math.abs(area(out)) > 1e-6 ? out : null;
}

// Bounds of a polygon: { minX, maxX, minZ, maxZ }
export function bounds(p) {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < b.minX) b.minX = p[i];
    if (p[i] > b.maxX) b.maxX = p[i];
    if (p[i + 1] < b.minZ) b.minZ = p[i + 1];
    if (p[i + 1] > b.maxZ) b.maxZ = p[i + 1];
  }
  return b;
}
const overlap = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

// Do the convex polygons p and q overlap (separating axes)?
export function intersects(p, q) {
  for (const [a, b] of [[p, q], [q, p]]) {
    for (let i = 0, n = a.length; i < n; i += 2) {
      const j = (i + 2) % n;
      const nx = a[j + 1] - a[i + 1], nz = a[i] - a[j]; // outward
      const c = nx * a[i] + nz * a[i + 1];
      let all = true;
      for (let k = 0; k < b.length && all; k += 2) if (nx * b[k] + nz * b[k + 1] < c + 1e-9) all = false;
      if (all) return false;
    }
  }
  return true;
}

// p minus the convex polygon q: the convex pieces of p outside q
export function subtract(p, q) {
  if (!intersects(p, q)) return [p];
  const pieces = [];
  let rest = p;
  for (let i = 0, n = q.length; i < n && rest; i += 2) {
    const j = (i + 2) % n;
    const dx = q[j] - q[i], dz = q[j + 1] - q[i + 1];
    const l = Math.hypot(dx, dz);
    if (l < EPS) continue;
    const nx = dz / l, nz = -dx / l; // outward (q is counter-clockwise)
    const c = nx * q[i] + nz * q[i + 1];
    const outside = clip(rest, -nx, -nz, -c);
    if (outside) pieces.push(outside);
    rest = clip(rest, nx, nz, c);
  }
  return pieces;
}

export function inside(p, x, z) {
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    if ((p[j] - p[i]) * (z - p[i + 1]) - (p[j + 1] - p[i + 1]) * (x - p[i]) < -1e-9) return false;
  }
  return true;
}

// A rectangle h either side of the segment a-b, reaching e past both ends
export function band(ax, az, bx, bz, h0, h1, e = 0) {
  const l = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / l, uz = (bz - az) / l;
  const rx = -uz, rz = ux; // to the left of a→b in the (x, z) plane
  const sx = ax - ux * e, sz = az - uz * e, tx = bx + ux * e, tz = bz + uz * e;
  return ccw([sx + rx * h0, sz + rz * h0, tx + rx * h0, tz + rz * h0, tx + rx * h1, tz + rz * h1, sx + rx * h1, sz + rz * h1]);
}

export function disc(x, z, r, n = 12) {
  const p = [];
  for (let k = 0; k < n; k++) p.push(x + r * Math.cos((2 * Math.PI * k) / n), z + r * Math.sin((2 * Math.PI * k) / n));
  return p;
}

// Convex hull (monotone chain) of flat points
export function hull(points) {
  const pts = [];
  for (let i = 0; i < points.length; i += 2) pts.push([points[i], points[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const h = [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
  return h.length >= 6 ? ccw(h) : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Laying it on the ground
// ---------------------------------------------------------------------------------------------------------------------

// p cut along the lines a·x + b·z = c0 + k·T.cell into pieces between them
function splitBy(p, a, b, c0, out) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const f = a * p[i] + b * p[i + 1];
    if (f < lo) lo = f;
    if (f > hi) hi = f;
  }
  let rest = p;
  for (let k = Math.floor((lo - c0) / T.cell) + 1; rest && c0 + k * T.cell < hi; k++) {
    const L = c0 + k * T.cell;
    const below = clip(rest, a, b, L);
    if (below) out.push(below);
    rest = clip(rest, -a, -b, -L);
  }
  if (rest) out.push(rest);
  return out;
}

// Calls fn(piece) for every piece of p lying inside a single terrain triangle
export function drape(p, fn) {
  for (const a of splitBy(p, 1, 0, T.x0, [])) {
    for (const b of splitBy(a, 0, 1, T.z0, [])) {
      for (const c of splitBy(b, 1, 1, T.x0 + T.z0, [])) fn(c);
    }
  }
}

// Distances (0..1) along the segment a-b where it crosses the terrain's grid lines and cell diagonals, ends included
function segmentBreaks(ax, az, bx, bz) {
  const ts = [0, 1];
  for (const [a, b, c0] of [[1, 0, T.x0], [0, 1, T.z0], [1, 1, T.x0 + T.z0]]) {
    const fa = a * ax + b * az;
    const fb = a * bx + b * bz;
    if (Math.abs(fb - fa) < EPS) continue;
    const [lo, hi] = fa < fb ? [fa, fb] : [fb, fa];
    for (let k = Math.ceil((lo - c0) / T.cell); c0 + k * T.cell < hi; k++) {
      const t = (c0 + k * T.cell - fa) / (fb - fa);
      if (t > EPS && t < 1 - EPS) ts.push(t);
    }
  }
  return ts.sort((p, q) => p - q);
}

// Indexed triangles with normals: { pos, nrm, index } (plain arrays) and helpers to add draped surfaces and kerb faces
export function soup() {
  const pos = [];
  const nrm = [];
  const index = [];
  const n = [0, 1, 0];
  const vertex = (x, y, z, nx, ny, nz) => {
    pos.push(x, y, z);
    nrm.push(nx, ny, nz);
    return pos.length / 3 - 1;
  };
  return {
    pos,
    nrm,
    index,
    // p draped on the ground, y over it, facing up
    surface(p, y) {
      drape(p, (q) => {
        const first = pos.length / 3;
        for (let v = 0; v < q.length; v += 2) {
          const x = q[v], z = q[v + 1];
          terrainNormal(x, z, n);
          vertex(x, heightAt(x, z) + y, z, n[0], n[1], n[2]);
        }
        // a fan; (x, z) counter-clockwise faces down, so each triangle reversed
        for (let i = 1; i + 1 < q.length / 2; i++) index.push(first, first + i + 1, first + i);
      });
    },
    // A vertical face along a-b from y0 to y1 over the ground, facing (nx, nz)
    wall(ax, az, bx, bz, y0, y1, nx, nz) {
      const ts = segmentBreaks(ax, az, bx, bz);
      for (let i = 0; i + 1 < ts.length; i++) {
        const px = ax + (bx - ax) * ts[i], pz = az + (bz - az) * ts[i];
        const qx = ax + (bx - ax) * ts[i + 1], qz = az + (bz - az) * ts[i + 1];
        const gp = heightAt(px, pz), gq = heightAt(qx, qz);
        const P0 = vertex(px, gp + y0, pz, nx, 0, nz), P1 = vertex(px, gp + y1, pz, nx, 0, nz);
        const Q0 = vertex(qx, gq + y0, qz, nx, 0, nz), Q1 = vertex(qx, gq + y1, qz, nx, 0, nz);
        // wound to face (nx, nz)
        if ((qx - px) * nz - (qz - pz) * nx > 0) index.push(P0, Q0, Q1, P0, Q1, P1);
        else index.push(P0, Q1, Q0, P0, P1, Q1);
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// A spatial index of polygons
// ---------------------------------------------------------------------------------------------------------------------

const CELL = 16;
export function polygonIndex() {
  const cells = new Map();
  const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
  let stamp = 0;
  const list = [];
  return {
    list,
    add(p, data = null) {
      const item = { p, b: bounds(p), data, seen: 0 };
      list.push(item);
      for (let ix = Math.floor(item.b.minX / CELL); ix <= Math.floor(item.b.maxX / CELL); ix++) {
        for (let iz = Math.floor(item.b.minZ / CELL); iz <= Math.floor(item.b.maxZ / CELL); iz++) {
          const k = key(ix, iz);
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(item);
        }
      }
      return item;
    },
    // every item whose bounds meet b, once
    near(b, fn) {
      stamp++;
      for (let ix = Math.floor(b.minX / CELL); ix <= Math.floor(b.maxX / CELL); ix++) {
        for (let iz = Math.floor(b.minZ / CELL); iz <= Math.floor(b.maxZ / CELL); iz++) {
          for (const item of cells.get(key(ix, iz)) || []) {
            if (item.seen === stamp || !overlap(item.b, b)) continue;
            item.seen = stamp;
            if (fn(item) === true) return true;
          }
        }
      }
      return false;
    },
    // the first item whose polygon holds (x, z)
    at(x, z) {
      const list = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (list) {
        for (const item of list) {
          const b = item.b;
          if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && inside(item.p, x, z)) return item;
        }
      }
      return null;
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The streets
// ---------------------------------------------------------------------------------------------------------------------

// Polygons of the streets from the road network's `streets`: { carriageways, sidewalks, paths } (polygon indexes; a
// sidewalk's data is its road's edge)
export function layoutStreets(streets) {
  const carriageways = polygonIndex();
  const sidewalks = polygonIndex();
  const paths = polygonIndex();
  const ground = (n) => n.lift < 0.05;

  // 1. The roads between their nodes, one per pair of nodes (the widest, where both ways are separate edges)
  const roads = new Map();
  const id = new Map(streets.nodes.map((n, i) => [n, i]));
  for (const e of streets.edges) {
    if (!ground(e.from) || !ground(e.to)) continue; // the decks and the ramps up to them are bridges.js's
    const a = id.get(e.from), b = id.get(e.to);
    const k = Math.min(a, b) * 65536 + Math.max(a, b);
    const r = roads.get(k);
    if (!r || e.half > r.half) roads.set(k, e);
  }
  const own = new Map(); // road -> its carriageway
  for (const e of roads.values()) own.set(e, carriageways.add(band(e.x0, e.z0, e.x0 + e.dx * e.span, e.z0 + e.dz * e.span, -e.half, e.half), e));

  // 2. Junctions: the corners where the roads meet cut back (a chamfer each), bends and dead ends rounded
  const widest = new Map();
  for (const e of roads.values()) for (const n of [e.from, e.to]) widest.set(n, Math.max(widest.get(n) || 0, e.half));
  for (const [n, half] of widest) {
    const arms = n.arms;
    if (n.shape || arms.length < 2) {
      carriageways.add(disc(n.x, n.z, half, 16));
      continue;
    }
    const pts = [];
    for (const a of arms) {
      // how far along it the roads crossing it reach (as road-network.js's stop lines, without the crosswalk)
      let d = 0;
      for (const b of arms) {
        if (b === a) continue;
        const cos = a.ux * b.ux + a.uz * b.uz;
        const sin = Math.abs(a.ux * b.uz - a.uz * b.ux);
        if (sin < 0.26) continue; // straight on, or merging alongside
        d = Math.max(d, (b.half + a.half * Math.abs(cos)) / sin);
      }
      const L = Math.min(20, d) + CORNER;
      pts.push(n.x + a.ux * L - a.uz * a.half, n.z + a.uz * L + a.ux * a.half, n.x + a.ux * L + a.uz * a.half, n.z + a.uz * L - a.ux * a.half);
    }
    const h = hull(pts);
    carriageways.add(h || disc(n.x, n.z, half, 16));
  }

  // 3. Service roads (alleys, yards, car park aisles: not the traffic's) from OpenStreetMap, under the sidewalks they
  //    cross (dropped kerbs)
  const service = polygonIndex();
  for (const r of GEO.roads) {
    if (r.kind !== 'service' || r.tunnel || isElevated(r)) continue;
    const w = Math.max(3, r.w || 4) / 2;
    const f = r.pts;
    for (let i = 0; i + 3 < f.length; i += 2) {
      if (Math.hypot(f[i + 2] - f[i], f[i + 3] - f[i + 1]) > 0.05) service.add(band(f[i], f[i + 1], f[i + 2], f[i + 3], -w, w));
    }
    for (let i = 0; i < f.length; i += 2) service.add(disc(f[i], f[i + 1], w, 10));
  }

  // Pieces of p outside every carriageway (but `skip`)
  const offRoad = (p, skip = null) => {
    let pieces = [p];
    carriageways.near(bounds(p), (item) => {
      if (item === skip) return;
      const next = [];
      for (const q of pieces) {
        if (overlap(bounds(q), item.b)) next.push(...subtract(q, item.p));
        else next.push(q);
      }
      pieces = next;
      if (!pieces.length) return true;
    });
    return pieces;
  };

  // A scrap of sidewalk left between carriageways meeting at a sharp angle: under 2 m², or thinner than about a metre
  // (twice its area over its perimeter: its inscribed circle's diameter, for the triangles these mostly are)
  const sliver = (q) => {
    let perimeter = 0;
    for (let i = 0, n = q.length; i < n; i += 2) perimeter += Math.hypot(q[(i + 2) % n] - q[i], q[(i + 3) % n] - q[i + 1]);
    const a = area(q);
    return a < 2 || (4 * a) / perimeter < 1;
  };

  // 4. Sidewalks along both sides of every road but the motorways
  for (const e of roads.values()) {
    if (e.rank >= NO_SIDEWALK_RANK) continue;
    const bx = e.x0 + e.dx * e.span, bz = e.z0 + e.dz * e.span;
    for (const side of [-1, 1]) {
      // (a metre past both ends, so the sidewalks of a road's straight runs overlap where it bends)
      const strip = band(e.x0, e.z0, bx, bz, side * e.half, side * (e.half + SIDEWALK), 1);
      for (const q of offRoad(strip, own.get(e))) if (!sliver(q)) sidewalks.add(q, e);
    }
  }

  // 5. Footpaths at grade, wherever they don't cross a carriageway
  for (const r of GEO.roads) {
    if (!FOOT.has(r.kind) || r.tunnel || isElevated(r)) continue;
    const w = Math.max(1.6, r.w || 2) / 2;
    const f = r.pts;
    for (let i = 0; i + 3 < f.length; i += 2) {
      if (Math.hypot(f[i + 2] - f[i], f[i + 3] - f[i + 1]) < 0.05) continue;
      for (const q of offRoad(band(f[i], f[i + 1], f[i + 2], f[i + 3], -w, w, w * 0.5))) paths.add(q);
    }
  }

  return { carriageways, service, sidewalks, paths };
}

// What the ground at (x, z) is raised to by the streets, over the terrain: a sidewalk's top, the asphalt, a footpath, or 0
let layout = null;
export function setStreetLayout(l) {
  layout = l;
}
export function pavementLift(x, z) {
  if (!layout) return 0;
  if (layout.sidewalks.at(x, z)) return WALK_Y;
  if (layout.carriageways.at(x, z) || layout.service.at(x, z)) return ROAD_Y;
  if (layout.paths.at(x, z)) return PATH_Y;
  return 0;
}

// The meshes' triangles: { asphalt, sidewalk, kerb, path } soups
export function streetSoups(layout) {
  const asphalt = soup();
  const sidewalk = soup();
  const kerb = soup();
  const path = soup();
  for (const { p } of layout.carriageways.list) asphalt.surface(p, ROAD_Y);
  for (const { p } of layout.service.list) asphalt.surface(p, ROAD_Y);
  for (const { p } of layout.paths.list) path.surface(p, PATH_Y);
  for (const { p } of layout.sidewalks.list) {
    sidewalk.surface(p, WALK_Y);
    // Kerbs: each edge facing the asphalt, or open ground (down to just under it); none between two sidewalk pieces
    for (let i = 0, n = p.length; i < n; i += 2) {
      const j = (i + 2) % n;
      const ax = p[i], az = p[i + 1], bx = p[j], bz = p[j + 1];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 0.02) continue;
      const nx = (bz - az) / l, nz = -(bx - ax) / l; // outward
      const mx = (ax + bx) / 2 + nx * 0.05, mz = (az + bz) / 2 + nz * 0.05;
      if (layout.sidewalks.at(mx, mz)) continue;
      const road = layout.carriageways.at(mx, mz) || layout.service.at(mx, mz);
      kerb.wall(ax, az, bx, bz, road ? ROAD_Y : -0.1, WALK_Y, nx, nz);
    }
  }
  return { asphalt, sidewalk, kerb, path };
}
