import { GEO } from './nairobi-geodata.js';

// Nairobi-specific settings shared by the traffic (and, later, the pedestrians, signal heads and audio): traffic signal
// timing and where the signals are. Slop New York keeps its whole street grid here; Nairobi's streets come from
// GEO.roadGraph instead (road-network.js).

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

export { SIGNAL_TIMING, SIGNALS, signalPhase, walkSignal, signalOffset, blockAt, isTypingInField };
