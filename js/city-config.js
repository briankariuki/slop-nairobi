import { GEO } from './nairobi-geodata.js';

// Nairobi-specific settings shared by the traffic, pedestrians, player and HUD: traffic signal timing and where the
// signals are, where a place is (street names and landmarks), the teleport destinations and the map's landmarks. Slop
// New York keeps its whole street grid here; Nairobi's streets come from GEO.roadGraph instead (road-network.js).

// Keyboard shortcuts are ignored while typing into a form field
function isTypingInField(e) {
  return e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
}

// The pavement block at (x, z), for pedestrian routing. Nairobi has no blocks yet (pedestrians are a later phase).
function blockAt() {
  return null;
}

// Traffic signal cycle, in seconds: the main road (right-of-way group 0 at the junction, road-network.js) green until
// mainAmber, amber until mainRed; the other roads green from mainRed until sideAmber, amber until the end of the cycle.
// Pedestrians cross with the traffic that runs parallel to them, stepping off only on the WALK, the first `walk`
// seconds of its green. Every signalised junction runs the cycle from its own offset (signalOffset), so the city's
// lights don't all change at once.
const SIGNAL_TIMING = { cycle: 60, mainAmber: 26, mainRed: 30, sideAmber: 56, walk: 12 };

// 'green', 'amber' or 'red' for the main road's (or the other roads') traffic at a given time
function signalPhase(time, isMain, offset = 0) {
  const { cycle, mainAmber, mainRed, sideAmber } = SIGNAL_TIMING;
  const t = (((time - offset) % cycle) + cycle) % cycle;
  if (isMain) return t < mainAmber ? 'green' : t < mainRed ? 'amber' : 'red';
  return t < mainRed ? 'red' : t < sideAmber ? 'green' : 'amber';
}

// Do pedestrians walking alongside the main road's (or the other roads') traffic have the WALK at a given time?
function walkSignal(time, isMain, offset = 0) {
  const { cycle, mainRed, walk } = SIGNAL_TIMING;
  const t = (((time - offset - (isMain ? 0 : mainRed)) % cycle) + cycle) % cycle;
  return t < walk;
}

// A junction's cycle offset (s), from where it is: deterministic, so it is the same every visit
function signalOffset(x, z) {
  const h = Math.sin(Math.round(x) * 12.9898 + Math.round(z) * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * SIGNAL_TIMING.cycle;
}

// Signalised junctions [{ x, z, offset, osm }]: the road graph's OSM traffic signals, plus generated ones where two
// roads of tertiary class or above cross at a junction of degree 4 or more (not on a roundabout, and not within
// SIGNAL_CLEAR m of an OSM signal), the most important crossings first, at most MAX_GENERATED. Signals within
// SIGNAL_CLEAR m of one another (both carriageways of a divided road, a crossing of two divided roads) share an offset,
// so they change together.
const MAX_GENERATED = 60;
const SIGNAL_CLEAR = 40;
const SIGNAL_RANK = { tertiary: 1, secondary: 2, primary: 3, trunk: 4 };

const SIGNALS = (() => {
  const RG = GEO.roadGraph;
  const out = RG.nodes.filter((n) => n.signal).map((n) => ({ x: n.x, z: n.z, osm: true }));
  const near = (x, z, list) => list.some((s) => Math.hypot(s.x - x, s.z - z) < SIGNAL_CLEAR);
  // unit direction each major link leaves each node in, with its class
  const arms = RG.nodes.map(() => []);
  for (const l of RG.links) {
    const rank = !l.link && SIGNAL_RANK[l.kind];
    if (!rank) continue;
    const p = l.pts;
    const n = p.length;
    for (const [i, dx, dz] of [[l.a, p[2] - p[0], p[3] - p[1]], [l.b, p[n - 4] - p[n - 2], p[n - 3] - p[n - 1]]]) {
      const d = Math.hypot(dx, dz) || 1;
      arms[i].push({ ux: dx / d, uz: dz / d, rank });
    }
  }
  const candidates = [];
  RG.nodes.forEach((n, i) => {
    if (n.deg < 4 || n.roundabout || n.signal) return;
    // two major roads crossing: two of its major arms between 40° and 140° apart
    let best = 0;
    for (const a of arms[i]) {
      for (const b of arms[i]) if (Math.abs(a.ux * b.uz - a.uz * b.ux) > 0.64) best = Math.max(best, a.rank + b.rank);
    }
    if (best) candidates.push({ x: n.x, z: n.z, rank: best });
  });
  candidates.sort((a, b) => b.rank - a.rank);
  const osm = out.slice();
  let generated = 0;
  for (const c of candidates) {
    if (generated >= MAX_GENERATED) break;
    if (near(c.x, c.z, osm)) continue;
    out.push({ x: c.x, z: c.z, osm: false });
    generated++;
  }
  // shared offsets within SIGNAL_CLEAR m
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    const lead = out.slice(0, i).find((o) => Math.hypot(o.x - s.x, o.z - s.z) < SIGNAL_CLEAR);
    s.offset = lead ? lead.offset : signalOffset(s.x, s.z);
  }
  return out;
})();

// Landmarks on the map and the radar (and the place names of the location label), with the short names they go by
const MAP_LANDMARKS = (() => {
  const SHORT = {
    'Kenyatta International Convention Centre': 'KICC', 'Times Tower': 'Times Tower', 'Britam Tower': 'Britam Tower',
    'UAP Old Mutual Tower': 'UAP Old Mutual', 'GTC office Tower': 'GTC', 'Teleposta Towers': 'Teleposta',
    'Nairobi City Hall': 'City Hall', 'Kenya National Archives': 'National Archives',
    'Nairobi National Museum': 'National Museum', 'Nairobi Railway Museum': 'Railway Museum',
    'Jeevanjee Gardens': 'Jeevanjee Gardens', 'Uhuru park': 'Uhuru Park', 'Central Park': 'Central Park',
    'Freedom Corner': 'Freedom Corner', 'August 7th Memorial Park': 'August 7th Memorial',
    'Dedan Kimathi Statue': 'Kimathi Statue', 'Tom Mboya Statue': 'Tom Mboya Statue', 'Askari Monument': 'Askari Monument',
    'Lionel Galton Fenzi Momument (Point Zero)': 'Point Zero', 'Kariokor Market': 'Kariokor Market',
    'Fairmont The Norfolk': 'The Norfolk', 'Hilton Hotel Nairobi': 'Hilton', 'InterContinental Hotel': 'InterContinental',
    'Villa Rosa Kempinski': 'Kempinski', 'Nyayo house': 'Nyayo House', 'Kenyatta Statue': 'Kenyatta Statue',
    'Mzee Jomo Kenyatta Memorial': 'Kenyatta Mausoleum', 'Nairobi Serena Hotel': 'Serena'
  };
  const out = [];
  for (const l of GEO.landmarks) if (SHORT[l.name]) out.push({ name: l.name === 'Uhuru park' ? 'Uhuru Park' : l.name, short: SHORT[l.name], x: l.x, z: l.z });
  for (const st of GEO.stations) out.push({ name: st.name, short: 'Railway Station', x: st.x, z: st.z });
  return out;
})();

// Named surface roads in 50 m cells: { ax, az, bx, bz, name }
const CAR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']);
const STREET_CELL = 50;
const STREETS = (() => {
  const cells = new Map();
  for (const l of GEO.roadGraph.links) {
    if (!l.name || !CAR_ROADS.has(l.kind)) continue;
    const p = l.pts;
    for (let i = 0; i < p.length - 2; i += 2) {
      const seg = { ax: p[i], az: p[i + 1], bx: p[i + 2], bz: p[i + 3], name: l.name };
      for (let ix = Math.floor(Math.min(seg.ax, seg.bx) / STREET_CELL); ix <= Math.floor(Math.max(seg.ax, seg.bx) / STREET_CELL); ix++) {
        for (let iz = Math.floor(Math.min(seg.az, seg.bz) / STREET_CELL); iz <= Math.floor(Math.max(seg.az, seg.bz) / STREET_CELL); iz++) {
          const k = `${ix},${iz}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(seg);
        }
      }
    }
  }
  return cells;
})();

// Named areas a place can be inside (parks, gardens, stadiums)
const PLACE_AREAS = GEO.areas.filter((a) => a.name && ['park', 'garden', 'stadium', 'cemetery'].includes(a.kind));
function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

// Where (x, z) is: { place, streets, near }. The place is a landmark within 90 m or a named park or stadium it is in;
// the streets are the one or two named roads within 28 m (a junction), or else (near = true) the nearest within 160 m.
function getLocation(x, z) {
  const dist = new Map();
  const r = 160;
  for (let ix = Math.floor((x - r) / STREET_CELL); ix <= Math.floor((x + r) / STREET_CELL); ix++) {
    for (let iz = Math.floor((z - r) / STREET_CELL); iz <= Math.floor((z + r) / STREET_CELL); iz++) {
      for (const s of STREETS.get(`${ix},${iz}`) || []) {
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1)));
        const d = Math.hypot(s.ax + dx * t - x, s.az + dz * t - z);
        if (d < r && !(dist.get(s.name) <= d)) dist.set(s.name, d);
      }
    }
  }
  const named = [...dist].sort((a, b) => a[1] - b[1]);
  const close = named.filter(([, d]) => d < 28).slice(0, 2).map(([n]) => n);
  let place = '';
  let bd = 90;
  for (const l of MAP_LANDMARKS) {
    const d = Math.hypot(l.x - x, l.z - z);
    if (d < bd) [place, bd] = [l.name, d];
  }
  if (!place) place = PLACE_AREAS.find((a) => inRing(a.ring, x, z))?.name || '';
  return { place, streets: close.length ? close : named.length ? [named[0][0]] : [], near: !close.length && named.length > 0 };
}

// The same as one line: "Place · Street & Street", "Place · near Street", "Street" or "Nairobi"
function getLocationLabel(x, z) {
  const { place, streets, near } = getLocation(x, z);
  const roads = streets.length ? `${near ? 'near ' : ''}${streets.join(' & ')}` : '';
  return place && roads ? `${place} · ${roads}` : place || roads || 'Nairobi';
}

// Teleport destinations: a landmark, and the road the player arrives on (in its left-hand lane, facing along it: see
// roadSpawn in controllers.js) nearest (x, z)
const TELEPORT_LOCATIONS = Object.fromEntries([
  ['kicc', 'Kenyatta International Convention Centre', 'Harambee Avenue · City Square', 'Harambee Avenue', 2, -15],
  ['askari', 'Askari Monument', 'Kenyatta Avenue · CBD', 'Kenyatta Avenue', -130, -476],
  ['kimathi', 'Dedan Kimathi Statue', 'Kimathi Street · CBD', 'Kimathi Street', 125, -404],
  ['times', 'Times Tower', 'Haile Selassie Avenue', 'Haile Selassie Avenue', 95, 205],
  ['station', 'Nairobi Railway Station', 'Station Road', 'Station Road', 611, 331],
  ['uhuru', 'Uhuru Park', 'Processional Way', 'Processional Way', -789, -6],
  ['museum', 'Nairobi National Museum', 'Kipande Road · Museum Hill', 'Kipande Road', -899, -1621],
  ['upperhill', 'Britam Tower', 'Hospital Road · Upper Hill', 'Hospital Road', -1097, 1256],
  ['kariokor', 'Kariokor Market', 'Racecourse Road', 'Racecourse Road', 1246, -1193]
].map(([id, name, sub, road, x, z]) => [id, { name, sub, road, x, z }]));

export {
  SIGNAL_TIMING, SIGNALS, signalPhase, walkSignal, signalOffset, blockAt, isTypingInField,
  getLocation, getLocationLabel, MAP_LANDMARKS, TELEPORT_LOCATIONS
};
