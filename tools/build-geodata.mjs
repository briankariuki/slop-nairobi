// tools/build-geodata.mjs — writes js/nairobi-geodata.js from the OpenStreetMap extracts in tools/data/
// usage: tools/fetch-geodata.sh && node tools/build-geodata.mjs [out.js]
//
// Inputs (tools/data/, fetched by tools/fetch-geodata.sh from the q_*.overpassql queries):
//   osm_roads.json       every highway=* way in the bbox (carriageways, links, footways, steps)
//   osm_buildings.json   building ways & multipolygon relations
//   osm_building_parts.json  building:part ways (real tower heights) and the type=building relations grouping them
//   osm_areas.json       parks, gardens, pitches, grass, woods, water bodies, parking
//   osm_water_rail.json  rivers & streams, railway lines & platforms, stations, bus stops & matatu termini
//   osm_landmarks.json   named landmarks, monuments, museums and every building with a height or 10+ levels
//   osm_street.json      traffic signals, pedestrian crossings, street lamps, trees and tree rows
//   dem_glo30.json       Copernicus GLO-30 elevation around the bbox (tools/fetch-terrain.mjs)
//
// World frame: 1 unit = 1 m, x = east, z = south (north = -z, same handedness as Slop New York), y = up.
// Origin at the Kenyatta International Convention Centre. Nairobi has no street grid, so the axes are not rotated.
// Kenya drives on the left: GEO.frame.drivesOn = 'left'.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../js/nairobi-geodata.js', import.meta.url));
const BBOX = JSON.parse(fs.readFileSync(fileURLToPath(new URL('bbox.json', import.meta.url)), 'utf8'));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')).elements;
const log = (...a) => console.log('[geodata]', ...a);

// =====================================================================================================================
// 1. FRAME — local tangent plane on the WGS84 ellipsoid around KICC
// =====================================================================================================================
const LAT0 = -1.28866;
const LON0 = 36.82307;
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;
const toWorld = (lon, lat) => [(lon - LON0) * KX, -(lat - LAT0) * KY];
const geomToWorld = (g) => g.map((p) => toWorld(p.lon, p.lat));

// =====================================================================================================================
// 2. GEOMETRY HELPERS
// =====================================================================================================================
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, az] = pts[0];
  const [bx, bz] = pts[pts.length - 1];
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1e-9;
  let best = -1;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len;
    if (d > best) [best, idx] = [d, i];
  }
  if (best <= eps) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}
// Rings are stored open (no repeated closing point), counter-clockwise in (x, z)
function ring(pts, eps) {
  let r = pts.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  if (r.length > 4) {
    // split at the far point so RDP keeps the ring's shape
    const far = r.reduce((bi, p, i) => (Math.hypot(p[0] - r[0][0], p[1] - r[0][1]) > Math.hypot(r[bi][0] - r[0][0], r[bi][1] - r[0][1]) ? i : bi), 0);
    r = [...rdp(r.slice(0, far + 1), eps).slice(0, -1), ...rdp([...r.slice(far), r[0]], eps).slice(0, -1)];
  }
  if (ringArea(r) < 0) r.reverse();
  return r;
}
function ringArea(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return s / 2;
}
function centroid(r) {
  let cx = 0;
  let cz = 0;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    cx += (r[j][0] + r[i][0]) * f;
    cz += (r[j][1] + r[i][1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) return r[0];
  return [cx / (3 * a), cz / (3 * a)];
}
// Stitch multipolygon member ways (possibly split into pieces) into closed rings
function stitch(ways) {
  const open = ways.map((w) => w.slice()).filter((w) => w.length > 1);
  const rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  while (open.length) {
    let cur = open.shift();
    let grew = true;
    while (!same(cur[0], cur[cur.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        const end = cur[cur.length - 1];
        if (same(end, w[0])) cur = cur.concat(w.slice(1));
        else if (same(end, w[w.length - 1])) cur = cur.concat(w.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (cur.length >= 4 && same(cur[0], cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}
// Polygons of an element: [{ outer, holes }] in world metres
function polygons(el) {
  if (el.type === 'way') return el.geometry && el.geometry.length >= 4 ? [{ outer: geomToWorld(el.geometry), holes: [] }] : [];
  if (el.type !== 'relation' || !el.members) return [];
  const part = (role) => stitch(el.members.filter((m) => m.type === 'way' && m.geometry && (m.role || 'outer') === role).map((m) => geomToWorld(m.geometry)));
  const outers = part('outer');
  const inners = part('inner');
  // each hole goes to the outer ring containing its first vertex
  return outers.map((outer) => ({ outer, holes: inners.filter((h) => inside(h[0], outer)) }));
}
function inside([x, z], r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (r[i][1] > z !== r[j][1] > z && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
}
// Deterministic per-element random in [0, 1) so rebuilds don't reshuffle estimated heights
function hash01(id) {
  let h = (id * 2654435761) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
const num = (v) => {
  const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(v || '');
  return m ? +m[1] : null;
};

// =====================================================================================================================
// 3. ROADS
// =====================================================================================================================
// Lanes per carriageway when OSM has no lanes tag, and kinds the sim can treat differently
const DEFAULT_LANES = { motorway: 4, trunk: 4, primary: 4, secondary: 2, tertiary: 2, unclassified: 2, residential: 2, living_street: 1, service: 1 };
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway']);
const LANE_W = 3.3;
function buildRoads(elements) {
  const out = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const t = el.tags;
    if (t.area === 'yes' || t.access === 'private' || t.highway === 'construction' || t.highway === 'proposed') continue;
    const link = t.highway.endsWith('_link');
    const kind = t.highway.replace(/_link$/, '');
    const foot = FOOT.has(kind);
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' || (kind === 'motorway' && t.oneway !== 'no') ? 1 : t.oneway === '-1' ? -1 : 0;
    let lanes = num(t.lanes);
    if (!lanes) lanes = foot ? 0 : link ? 1 : (DEFAULT_LANES[kind] || 2) / (oneway && DEFAULT_LANES[kind] > 1 ? 2 : 1);
    const w = num(t.width) || (foot ? (kind === 'pedestrian' ? 6 : kind === 'steps' ? 2.5 : 2) : Math.max(lanes, 1) * LANE_W + (kind === 'service' ? 0 : 1));
    const pts = rdp(geomToWorld(el.geometry), 0.4);
    const road = { id: el.id, kind, pts: flat(pts), w: q(w) };
    if (t.name) road.name = t.name;
    if (t.ref) road.ref = t.ref;
    if (link) road.link = 1;
    if (!foot) [road.lanes, road.oneway] = [lanes, oneway];
    if (t.bridge && t.bridge !== 'no') road.bridge = 1;
    if (t.tunnel && t.tunnel !== 'no') road.tunnel = 1;
    if (t.layer) road.layer = num(t.layer) || 0;
    if (t.junction === 'roundabout') road.roundabout = 1;
    if (t.maxspeed) road.maxspeed = num(t.maxspeed);
    if (t.service) road.service = t.service;
    out.push(road);
  }
  return out;
}

// =====================================================================================================================
// 4. BUILDINGS — real height where OSM has one, otherwise estimated (est: 1) from levels, use, size and location
// =====================================================================================================================
const STOREY = 3.3;
const CORE_R = 900; // the CBD core around KICC, where unknown buildings are taller
function estimateLevels(el, area, c) {
  const t = el.tags;
  const r = hash01(el.id);
  if (['roof', 'carport', 'shed', 'garage', 'garages', 'kiosk', 'hut', 'toilets'].includes(t.building)) return 1;
  if (area < 40) return 1;
  if (t.building === 'house' || t.building === 'detached' || t.building === 'bungalow') return 1 + (r < 0.3 ? 1 : 0);
  const d = Math.hypot(c[0], c[1]);
  if (d < CORE_R && area > 250) return Math.round(4 + r * r * 10); // 4..14, skewed low
  if (d < CORE_R * 1.6 && area > 150) return Math.round(2 + r * 4); // 2..6
  return Math.round(1 + r * 2.4); // 1..3
}
function buildingOf(el, polys) {
  const t = el.tags;
  const out = [];
  for (const { outer, holes } of polys) {
    // parts keep their fine detail: spires, crowns and facade fins are < 6 m² (Britam's crown, I&M Bank Tower's fins)
    const part = !!t['building:part'];
    const r = ring(outer, part ? 0.05 : 0.25);
    if (r.length < 3) continue;
    const area = ringArea(r);
    if (area < (part ? 0.05 : 6)) continue;
    const c = centroid(r);
    const levels = num(t['building:levels']) || num(t.floors);
    const minLevel = num(t['building:min_level']) || 0;
    let h = num(t.height);
    let est = 0;
    if (!h && levels) h = levels * STOREY + (levels > 1 ? 1 : 0.5);
    if (!h) {
      h = estimateLevels(el, area, c) * STOREY + 0.6;
      est = 1;
    }
    const b = { id: el.id, ring: flat(r), h: q(h) };
    if (est) b.est = 1;
    if (levels) b.levels = levels;
    const minH = num(t.min_height) || minLevel * STOREY;
    if (minH) b.minH = q(minH);
    if ((t.building || t['building:part']) === 'roof') b.minH = b.minH || q(Math.max(h - 1, 2.5));
    if (t.building && t.building !== 'yes') b.use = t.building;
    if (t['building:part']) b.part = 1;
    if (t.name) b.name = t.name;
    if (t['roof:shape']) b.roof = t['roof:shape'];
    if (t['building:colour']) b.colour = t['building:colour'];
    if (t['building:material']) b.material = t['building:material'];
    const hs = holes.map((hr) => ring(hr, 0.25)).filter((hr) => hr.length >= 3 && Math.abs(ringArea(hr)) > 2);
    if (hs.length) b.holes = hs.map((hr) => flat(hr.reverse()));
    out.push(b);
  }
  return out;
}
// Simple 3D Buildings: Nairobi's towers (KICC, Times Tower, UAP Old Mutual, Britam...) are mapped as building:part
// ways carrying the real heights, grouped by a type=building relation whose "outline" member is the footprint. Where a
// building has parts, the parts replace its outline, as in every S3DB renderer.
function buildBuildings() {
  const partsData = load('osm_building_parts.json');
  const parts = [];
  const outlines = new Set();
  const partName = new Map();
  for (const el of partsData) {
    if (el.tags?.type !== 'building' || !el.members) continue;
    for (const m of el.members) {
      if (m.role === 'outline') outlines.add(m.ref);
      else if (m.role === 'part' && el.tags.name) partName.set(m.ref, el.tags.name);
    }
  }
  for (const el of partsData) {
    if (!el.tags?.['building:part']) continue;
    for (const b of buildingOf(el, polygons(el))) {
      if (!b.name && partName.has(el.id)) b.name = partName.get(el.id);
      parts.push(b);
    }
  }
  // part centroids, to catch outlines that aren't tied to their parts by a relation
  const partPts = parts.map((p) => {
    const r = [];
    for (let i = 0; i < p.ring.length; i += 2) r.push([p.ring[i], p.ring[i + 1]]);
    return centroid(r);
  });

  const out = [];
  const seen = new Set();
  // the landmark query also returns building ways the bbox query has, so dedupe by id
  for (const f of ['osm_buildings.json', 'osm_landmarks.json']) {
    for (const el of load(f)) {
      if (!el.tags || !el.tags.building || el.tags['building:part']) continue;
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const { outer, holes } of polygons(el)) {
        const within = parts.filter((p, i) => inside(partPts[i], outer));
        if (!within.length && !outlines.has(el.id)) {
          out.push(...buildingOf(el, [{ outer, holes }]));
          continue;
        }
        outlines.add(el.id);
        if (el.tags.name) for (const p of within) p.name = p.name || el.tags.name;
        // parts that all start above the ground (Nation Centre's twin towers sit on a 10-storey podium mapped only as
        // the outline): keep the outline as the podium, up to where the parts begin
        if (within.length && within.every((p) => p.minH > 0)) {
          for (const b of buildingOf(el, [{ outer, holes }])) {
            b.h = Math.min(...within.map((p) => p.minH));
            delete b.est;
            delete b.levels;
            b.podium = 1;
            out.push(b);
          }
        }
      }
    }
  }
  // Drop plain building ways that are the outer ring of a building multipolygon (same outline modelled twice)
  const relOuter = new Set();
  for (const el of load('osm_buildings.json')) if (el.type === 'relation' && el.members) for (const m of el.members) if (m.role === 'outer') relOuter.add(m.ref);
  log(`building parts ${parts.length} replace ${outlines.size} outlines`);
  return [...out.filter((b) => !(relOuter.has(b.id) && !b.name && b.est)), ...parts];
}

// =====================================================================================================================
// 5. AREAS, WATER, RAIL, TRANSIT, LANDMARKS
// =====================================================================================================================
function buildAreas() {
  const out = [];
  for (const el of load('osm_areas.json')) {
    const t = el.tags || {};
    const kind = t.leisure || t.landuse || t.natural || t.amenity;
    for (const { outer, holes } of polygons(el)) {
      const r = ring(outer, 0.8);
      if (r.length < 3 || ringArea(r) < 20) continue;
      const a = { id: el.id, kind, ring: flat(r) };
      if (t.name) a.name = t.name;
      if (t.sport) a.sport = t.sport;
      const hs = holes.map((hr) => ring(hr, 0.8)).filter((hr) => hr.length >= 3);
      if (hs.length) a.holes = hs.map((hr) => flat(hr.reverse()));
      out.push(a);
    }
  }
  return out;
}
function buildWaterRail() {
  const rivers = [];
  const rail = [];
  const stations = [];
  const busStops = [];
  const termini = [];
  for (const el of load('osm_water_rail.json')) {
    const t = el.tags || {};
    if (el.type === 'node') {
      const [x, z] = toWorld(el.lon, el.lat);
      const p = { x: q(x), z: q(z) };
      if (t.name) p.name = t.name;
      if (t.railway) stations.push(p);
      else if (t.amenity === 'bus_station') termini.push(p);
      else busStops.push(p);
      continue;
    }
    if (t.railway === 'station' || t.railway === 'halt' || t.public_transport === 'station') {
      const polys = polygons(el);
      if (!polys.length) continue;
      const c = centroid(polys[0].outer);
      const p = { x: q(c[0]), z: q(c[1]) };
      if (t.name) p.name = t.name;
      (t.amenity === 'bus_station' ? termini : stations).push(p);
      continue;
    }
    if (el.type !== 'way' || !el.geometry) continue;
    const pts = geomToWorld(el.geometry);
    if (t.waterway) {
      const w = { kind: t.waterway, pts: flat(rdp(pts, 0.8)) };
      if (t.name) w.name = t.name;
      if (t.tunnel || t.culvert) w.culvert = 1;
      rivers.push(w);
    } else if (t.railway === 'platform') {
      rail.push({ kind: 'platform', pts: flat(rdp(pts, 0.3)) });
    } else if (t.railway) {
      const r = { kind: t.railway, pts: flat(rdp(pts, 0.4)) };
      if (t.usage) r.usage = t.usage;
      if (t.service) r.service = t.service;
      if (t.bridge && t.bridge !== 'no') r.bridge = 1;
      rail.push(r);
    } else if (t.amenity === 'bus_station') {
      const c = centroid(pts);
      const p = { x: q(c[0]), z: q(c[1]) };
      if (t.name) p.name = t.name;
      termini.push(p);
    }
  }
  return { rivers, rail, stations, busStops, termini };
}
function buildLandmarks(buildings) {
  const out = [];
  const seen = new Set();
  for (const el of load('osm_landmarks.json')) {
    const t = el.tags || {};
    const key = t.name?.toLowerCase();
    if (!key || seen.has(key)) continue;
    // landmarks are named sights, and tall buildings (> 40 m) with a name
    const isBuilding = t.building || t.type === 'building';
    const sight = t.tourism || t.historic || !isBuilding;
    let x;
    let z;
    if (el.type === 'node') [x, z] = toWorld(el.lon, el.lat);
    else {
      const polys = polygons(el);
      if (polys.length) [x, z] = centroid(polys[0].outer);
      // a type=building relation has parts and an outline but no outer ring: use the middle of its bounds
      else if (el.bounds) [x, z] = toWorld((el.bounds.minlon + el.bounds.maxlon) / 2, (el.bounds.minlat + el.bounds.maxlat) / 2);
      else continue;
    }
    // a building replaced by its parts (or kept only as their podium) is found by name; its height is the tallest part's
    const b = buildings.filter((bb) => bb.id === el.id || bb.name?.toLowerCase() === key).sort((p, r) => r.h - p.h)[0];
    if (!sight && !(b && b.h > 40)) continue;
    seen.add(key);
    const lm = { name: t.name, x: q(x), z: q(z) };
    if (b) lm.h = b.h;
    const kind = t.tourism || (t.historic && `historic:${t.historic}`) || t.leisure || (isBuilding && 'building');
    if (kind) lm.kind = kind;
    out.push(lm);
  }
  return out.sort((a, b) => (b.h || 0) - (a.h || 0));
}

// =====================================================================================================================
// 6. STREET FURNITURE — only what OSM maps (sparse in the CBD), so the sim can add its own where these run out
// =====================================================================================================================
function buildStreet() {
  const signals = [];
  const crossings = [];
  const lamps = [];
  const trees = [];
  const treeRows = [];
  const pt = (el) => {
    const [x, z] = toWorld(el.lon, el.lat);
    return { x: q(x), z: q(z) };
  };
  for (const el of load('osm_street.json')) {
    const t = el.tags || {};
    if (el.type === 'way') {
      const pts = flat(rdp(geomToWorld(el.geometry), 0.3));
      if (t.natural === 'tree_row') treeRows.push({ pts });
      // a crossing drawn as a footway across the carriageway
      else crossings.push({ pts, kind: t.crossing || 'marked' });
      continue;
    }
    const p = pt(el);
    if (t.highway === 'traffic_signals') {
      if (t['traffic_signals:direction'] || t.direction) p.dir = t['traffic_signals:direction'] || t.direction;
      signals.push(p);
    } else if (t.highway === 'crossing' || t.crossing === 'traffic_signals') {
      p.kind = t.crossing || 'marked';
      crossings.push(p);
    } else if (t.highway === 'street_lamp') lamps.push(p);
    else if (t.natural === 'tree') {
      if (t.height) p.h = num(t.height);
      if (t.leaf_type) p.leaf = t.leaf_type;
      if (t.species || t.genus) p.species = t.species || t.genus;
      trees.push(p);
    }
  }
  return { signals, crossings, lamps, trees, treeRows };
}

// =====================================================================================================================
// 7. TERRAIN — Copernicus GLO-30 (tools/fetch-terrain.mjs) filtered to bare ground, on a square world grid
// =====================================================================================================================
const TERRAIN_CELL = 25; // m
const OPEN_R = 2; // cells (~60 m): the opening removes raised features narrower than ~120 m (blocks, towers, tree clumps)
function buildTerrain() {
  const D = JSON.parse(fs.readFileSync(path.join(DATA, 'dem_glo30.json'), 'utf8'));
  const { nx, ny } = D;
  const pass = (src, r, pick) => {
    // separable square min/max filter, clamped at the edges
    const tmp = new Float64Array(src.length);
    const out = new Float64Array(src.length);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let v = src[j * nx + i];
      for (let k = Math.max(0, i - r); k <= Math.min(nx - 1, i + r); k++) v = pick(v, src[j * nx + k]);
      tmp[j * nx + i] = v;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let v = tmp[j * nx + i];
      for (let k = Math.max(0, j - r); k <= Math.min(ny - 1, j + r); k++) v = pick(v, tmp[k * nx + i]);
      out[j * nx + i] = v;
    }
    return out;
  };
  const opened = pass(pass(Float64Array.from(D.values), OPEN_R, Math.min), OPEN_R, Math.max);
  // light smoothing so the stepped plateaus of the opening become slopes
  const ground = new Float64Array(opened.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0;
    let wsum = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const ii = Math.min(nx - 1, Math.max(0, i + a));
      const jj = Math.min(ny - 1, Math.max(0, j + b));
      const w = (a ? 1 : 2) * (b ? 1 : 2);
      s += opened[jj * nx + ii] * w;
      wsum += w;
    }
    ground[j * nx + i] = s / wsum;
  }
  // bilinear sample at a lon/lat, sample centres at half a cell in
  const sample = (lon, lat) => {
    const fx = Math.min(nx - 1, Math.max(0, (lon - D.west) / D.dx - 0.5));
    const fy = Math.min(ny - 1, Math.max(0, (lat - D.north) / D.dy - 0.5));
    const i = Math.min(nx - 2, Math.floor(fx));
    const j = Math.min(ny - 2, Math.floor(fy));
    const u = fx - i;
    const v = fy - j;
    const g = (a, b) => ground[(j + b) * nx + i + a];
    return (g(0, 0) * (1 - u) + g(1, 0) * u) * (1 - v) + (g(0, 1) * (1 - u) + g(1, 1) * u) * v;
  };
  const base = Math.round(sample(LON0, LAT0) * 10) / 10;
  const [wx0, wz1] = toWorld(BBOX.west, BBOX.south);
  const [wx1, wz0] = toWorld(BBOX.east, BBOX.north);
  const x0 = Math.floor(wx0 / TERRAIN_CELL) * TERRAIN_CELL;
  const z0 = Math.floor(wz0 / TERRAIN_CELL) * TERRAIN_CELL;
  const gx = Math.ceil((wx1 - x0) / TERRAIN_CELL) + 1;
  const gz = Math.ceil((wz1 - z0) / TERRAIN_CELL) + 1;
  const heights = new Array(gx * gz);
  for (let j = 0; j < gz; j++) for (let i = 0; i < gx; i++) {
    const x = x0 + i * TERRAIN_CELL;
    const z = z0 + j * TERRAIN_CELL;
    heights[j * gx + i] = q(sample(LON0 + x / KX, LAT0 - z / KY) - base);
  }
  return { source: 'Copernicus GLO-30, filtered to bare ground', base, x0, z0, cell: TERRAIN_CELL, nx: gx, nz: gz, heights };
}

// =====================================================================================================================
// 8. ROAD GRAPH — drivable ways split at the OSM nodes they share, for the traffic network (js/road-network.js)
// =====================================================================================================================
// GEO.roadGraph.nodes: junctions and dead ends { x, z, signal?, roundabout?, deg }. GEO.roadGraph.links: the road between
// two nodes { a, b, way, pts, kind, lanes, oneway (+1 a→b, -1 b→a, 0 both), w, name?, layer?, bridge?, tunnel?, link?,
// roundabout?, maxspeed? }: way is the OSM way id (GEO.roads[].id) it is part of, pts its flat [x, z, ...] centreline from
// node a to node b inclusive, lanes per carriageway as in GEO.roads.
const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service']);
function buildRoadGraph() {
  const ways = load('osm_roads.json').filter((el) => {
    const t = el.tags;
    if (el.type !== 'way' || !el.nodes || t.area === 'yes' || t.access === 'private' || t.access === 'no') return false;
    if (!DRIVABLE.has(t.highway.replace(/_link$/, ''))) return false;
    // parking aisles and driveways aren't part of the through network
    return !(t.highway === 'service' && /^(parking_aisle|driveway|drive-through)$/.test(t.service || ''));
  });
  const signals = new Set(load('osm_street.json').filter((el) => el.tags?.highway === 'traffic_signals' || el.tags?.crossing === 'traffic_signals').map((el) => el.id));
  const uses = new Map();
  for (const w of ways) for (const id of new Set(w.nodes)) uses.set(id, (uses.get(id) || 0) + 1);

  const roads = new Map(buildRoads(ways).map((r) => [r.id, r])); // per-way attributes, as in GEO.roads
  const nodeIndex = new Map();
  const nodes = [];
  const nodeOf = (id, g) => {
    if (!nodeIndex.has(id)) {
      const [x, z] = toWorld(g.lon, g.lat);
      const n = { x: q(x), z: q(z), deg: 0 };
      if (signals.has(id)) n.signal = 1;
      nodeIndex.set(id, nodes.length);
      nodes.push(n);
    }
    return nodeIndex.get(id);
  };
  const links = [];
  for (const w of ways) {
    const r = roads.get(w.id);
    if (!r) continue;
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      // split at junctions (nodes shared with another way, or met twice by this one) and at signals
      const id = w.nodes[i];
      if (i < w.nodes.length - 1 && uses.get(id) < 2 && !signals.has(id) && w.nodes.indexOf(id) === i) continue;
      const a = nodeOf(w.nodes[start], w.geometry[start]);
      const b = nodeOf(id, w.geometry[i]);
      const pts = flat(rdp(geomToWorld(w.geometry.slice(start, i + 1)), 0.4));
      const link = { a, b, way: w.id, pts, kind: r.kind, lanes: r.lanes, oneway: r.oneway, w: r.w };
      for (const k of ['name', 'layer', 'bridge', 'tunnel', 'link', 'roundabout', 'maxspeed']) if (r[k] !== undefined) link[k] = r[k];
      nodes[a].deg++;
      nodes[b].deg++;
      if (r.roundabout) nodes[a].roundabout = nodes[b].roundabout = 1;
      links.push(link);
      start = i;
    }
  }
  return { nodes, links };
}

// =====================================================================================================================
// 9. WRITE
// =====================================================================================================================
const roads = buildRoads(load('osm_roads.json'));
const buildings = buildBuildings();
const areas = buildAreas();
const { rivers, rail, stations, busStops, termini } = buildWaterRail();
const landmarks = buildLandmarks(buildings);
const street = buildStreet();
const terrain = buildTerrain();
const roadGraph = buildRoadGraph();
const [x0, z1] = toWorld(BBOX.west, BBOX.south);
const [x1, z0] = toWorld(BBOX.east, BBOX.north);

const GEO = {
  frame: {
    origin: 'Kenyatta International Convention Centre',
    lat0: LAT0,
    lon0: LON0,
    units: 'm',
    axes: 'x = east, z = south, y = up',
    drivesOn: 'left',
    bbox: BBOX,
    extent: { x0: q(x0), x1: q(x1), z0: q(z0), z1: q(z1) }
  },
  roads,
  buildings,
  areas,
  rivers,
  rail,
  stations,
  busStops,
  termini,
  landmarks,
  ...street,
  terrain,
  roadGraph
};

const est = buildings.filter((b) => b.est).length;
log(`roads ${roads.length} (${roads.filter((r) => r.name).length} named), buildings ${buildings.length} (${buildings.length - est} real heights, ${est} estimated)`);
log(`areas ${areas.length}, rivers ${rivers.length}, rail ${rail.length}, stations ${stations.length}, bus stops ${busStops.length}, termini ${termini.length}, landmarks ${landmarks.length}`);
log(`signals ${street.signals.length}, crossings ${street.crossings.length}, lamps ${street.lamps.length}, trees ${street.trees.length}, tree rows ${street.treeRows.length}`);
log(`terrain ${terrain.nx}×${terrain.nz} at ${terrain.cell} m, ${Math.min(...terrain.heights)}..${Math.max(...terrain.heights)} m around ${terrain.base} m at KICC`);
log(`road graph: ${roadGraph.nodes.length} nodes (${roadGraph.nodes.filter((n) => n.deg > 2).length} junctions, ${roadGraph.nodes.filter((n) => n.signal).length} signals, ${roadGraph.nodes.filter((n) => n.roundabout).length} on roundabouts), ${roadGraph.links.length} links`);
log(`extent x ${GEO.frame.extent.x0}..${GEO.frame.extent.x1}, z ${GEO.frame.extent.z0}..${GEO.frame.extent.z1}`);

const header = `// Generated by tools/build-geodata.mjs — do not edit by hand.
// Nairobi CBD at 1:1 scale. Geographic data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
// Frame: 1 unit = 1 m, x = east, z = south (north = -z), origin at KICC. Point lists are flat [x0, z0, x1, z1, ...].
// Buildings with est: 1 have an estimated height (OSM has neither height nor building:levels for them).
// Terrain: GEO.terrain.heights are ground heights in m relative to KICC (GEO.terrain.base m above sea level), row-major
// from (x0, z0) every cell m; sample them with js/terrain.js. Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014
// and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${JSON.stringify(GEO)};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
