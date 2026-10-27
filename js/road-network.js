import { GEO } from './nairobi-geodata.js';
import { SIGNAL_TIMING } from './city-config.js';
import { nodeLift, liftAlong, liftBreaks } from './elevation.js';

// Drivable road graph for the traffic, built from OpenStreetMap's street centrelines (GEO.roadGraph,
// tools/build-geodata.mjs section 8): junctions (signalised where city-config.js puts signals), the lanes of every road
// between them, roundabouts, and the lane-to-lane curves used to drive straight through a junction or turn. Adapted from
// Slop New York's road-network.js (MIT, © 2026 Mr.doob), keeping its centreline pipeline and dropping Manhattan's grid.
//
// Conventions: north = -z, east = +x. Every directed edge has a unit direction (dx, dz) and a right normal
// (rx, rz) = (-dz, dx). Lanes are lateral offsets to the right of the centreline, sorted left to right. Kenya drives
// on the left, so a two-way road's lanes each way lie left of its centreline (negative offsets) and a one-way road's
// are centred on it. Nodes and edges are flat in (x, z); every node carries its `lift` (m over the ground,
// elevation.js) so the traffic can follow the Expressway's decks and ramps.

const CELL = 32;
const LANE_CLEAR = 1.2; // half width each lane keeps free of obstacles
const CROSSWALK = 2.5; // depth between a junction and its stop lines
// Road kinds the traffic drives on, by importance (service roads, mostly alleys and yards, and tunnels are left out)
const RANK = { motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, living_street: 1 };
const MAJOR = 4; // secondary and up: main roads (axis 'ave'), the only ones buses take
const MAX_LANES = 6; // per direction (the connector cache key assumes fewer than 16)
// Speed limits (km/h) where OSM has no maxspeed
const KIND_SPEED = { motorway: 80, trunk: 60, primary: 50, secondary: 50, tertiary: 50, unclassified: 40, residential: 40, living_street: 20 };

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function buildRoadNetwork(sidewalks = [], obstacles = [], signalIntersections = []) {
  // 1. Spatial hash of ground footprints: curbs bound the roads, everything else also blocks pedestrians
  const hash = new Map();
  const cellKey = (ix, iz) => (ix + 512) * 1024 + iz + 512;

  function insert(r) {
    for (let ix = Math.floor(r.minX / CELL); ix <= Math.floor(r.maxX / CELL); ix++) {
      for (let iz = Math.floor(r.minZ / CELL); iz <= Math.floor(r.maxZ / CELL); iz++) {
        const k = cellKey(ix, iz);
        if (!hash.has(k)) hash.set(k, []);
        hash.get(k).push(r);
      }
    }
  }
  for (const r of sidewalks) insert({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ, curb: true });
  for (const r of obstacles) insert(r);

  // Calls fn(rect) for every footprint overlapping the box until fn returns true
  function query(minX, maxX, minZ, maxZ, fn) {
    for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
      for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
        const list = hash.get(cellKey(ix, iz));
        if (!list) continue;
        for (const r of list) {
          if (r.minX < maxX && r.maxX > minX && r.minZ < maxZ && r.maxZ > minZ && fn(r)) return true;
        }
      }
    }
    return false;
  }

  const walkable = (minX, maxX, minZ, maxZ) => !query(minX, maxX, minZ, maxZ, (r) => !r.curb);
  const onSidewalk = (x, z) => query(x, x, z, z, (r) => r.curb);
  // Is (x, z) off the road? The rectangles standing in for irregular sidewalks may reach a little past their curbs, so
  // only a curb right at (x, z) and other obstacles under 50 m across count
  const blockedOnStreet = (x, z, clear) => query(x - 0.3, x + 0.3, z - 0.3, z + 0.3, (r) => r.curb) ||
    query(x - clear, x + clear, z - clear, z + clear, (r) => !r.curb && !r.pedestrianOnly && (r.maxX - r.minX < 50 || r.maxZ - r.minZ < 50));

  // 2. Streets from the centreline graph (GEO.roadGraph). Junctions a few metres apart are one; a street's bends get
  //    shape nodes, so every edge stays straight.
  let nodes = [];
  const genRuns = centrelineStreets();
  function centrelineStreets() {
    const RG = GEO.roadGraph;
    const runs = [];
    const pos = RG.nodes;
    const links = [];
    for (const l of RG.links) {
      const rank = RANK[l.kind];
      if (!rank || l.tunnel) continue;
      const pts = [];
      for (let k = 0; k < l.pts.length; k += 2) pts.push({ x: l.pts[k], z: l.pts[k + 1] });
      let len = 0;
      for (let k = 0; k + 1 < pts.length; k++) len += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
      const kph = l.maxspeed >= 20 ? Math.min(l.maxspeed, l.kind === 'motorway' ? 100 : 60) : KIND_SPEED[l.kind];
      links.push({ a: l.a, b: l.b, raw: l, name: l.name || '', kind: l.kind, rank, w: l.w, lanes: l.lanes, dir: l.oneway, ring: !!l.roundabout, vmax: kph / 3.6, pts, len });
    }
    // Junctions a few metres apart (divided roads, offset corners) are one: collapse links under 14 m, though never a
    // deck onto the street under it
    const parent = pos.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const l of links) if (l.len < 14 && Math.abs(nodeLift[l.a] - nodeLift[l.b]) < 2) parent[find(l.a)] = find(l.b);
    // ...and so are the corners of a closed loop of three or four links under 30 m off any roundabout: where two divided
    // roads cross (Haile Selassie Avenue and Upper Hill Road), the box between their carriageways. Left as four
    // junctions, the links inside are a car or two long each and traffic going round fills them until nobody can leave.
    {
      const BOX = 30;
      const near = new Map(); // junction -> junctions a short link away
      for (const l of links) {
        if (l.ring || l.len >= BOX || Math.abs(nodeLift[l.a] - nodeLift[l.b]) >= 2) continue;
        const [a, b] = [find(l.a), find(l.b)];
        if (a === b) continue;
        for (const [p, q] of [[a, b], [b, a]]) {
          if (!near.has(p)) near.set(p, new Set());
          near.get(p).add(q);
        }
      }
      const loops = [];
      for (const [a, next] of near) {
        for (const b of next) {
          for (const c of near.get(b)) {
            if (c === a) continue;
            if (near.get(c).has(a)) loops.push([a, b, c]);
            for (const d of near.get(c)) if (d !== a && d !== b && near.get(d).has(a)) loops.push([a, b, c, d]);
          }
        }
      }
      for (const loop of loops) for (const i of loop) parent[find(i)] = find(loop[0]);    }
    // ...and a roundabout left with fewer than three junctions on its ring (or under 60 m round), whose ring would be a
    // couple of stubs too short to queue on, is one junction: traffic crosses it as it would a plain junction
    {
      const ringOf = new Map(); // node -> a node of its roundabout
      const rfind = (i) => (ringOf.get(i) === i ? i : rfind(ringOf.get(i)));
      for (const l of links) {
        if (!l.ring) continue;
        for (const i of [l.a, l.b]) if (!ringOf.has(i)) ringOf.set(i, i);
        ringOf.set(rfind(l.a), rfind(l.b));
      }
      const rings = new Map(); // roundabout -> { nodes, round }
      for (const l of links) {
        if (!l.ring) continue;
        const r = rfind(l.a);
        if (!rings.has(r)) rings.set(r, { nodes: new Set(), round: 0 });
        const g = rings.get(r);
        g.nodes.add(l.a).add(l.b);
        g.round += l.len;
      }
      for (const g of rings.values()) {
        const nodesOf = [...g.nodes];
        if (new Set(nodesOf.map(find)).size >= 3 && g.round >= 60) continue;
        for (const i of nodesOf) parent[find(i)] = find(nodesOf[0]);
      }
    }
    const sum = new Map();
    const counted = new Set();
    for (const l of links) {
      for (const i of [l.a, l.b]) {
        if (counted.has(i)) continue;
        counted.add(i);
        const r = find(i);
        const s = sum.get(r) || { x: 0, z: 0, lift: 0, n: 0, roundabout: false };
        s.x += pos[i].x;
        s.z += pos[i].z;
        s.lift += nodeLift[i];
        s.n++;
        s.roundabout = s.roundabout || !!pos[i].roundabout;
        sum.set(r, s);
      }
    }
    const junctions = new Map();
    function junction(r) {
      if (junctions.has(r)) return junctions.get(r);
      const s = sum.get(r);
      const node = { x: s.x / s.n, z: s.z / s.n, lift: s.lift / s.n, hx: 0, hz: 0, signal: false, in: [], out: [], general: true, roundabout: s.roundabout };
      nodes.push(node);
      junctions.set(r, node);
      return node;
    }
    // Lanes by the road's lane count and width: a one-way road's centred on it, a two-way road's half each way, on the
    // left of its centreline
    function lanesOf(l) {
      const half = Math.max(l.w, 3) / 2;
      const axis = l.rank >= MAJOR ? 'ave' : 'st';
      const total = Math.max(1, l.lanes || 1);
      if (l.dir !== 0) {
        const n = Math.min(MAX_LANES, total);
        const step = clamp(l.w / n, 2.8, 3.6);
        const lanes = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * step);
        return { half, axis, fwd: l.dir > 0 ? lanes : [], back: l.dir < 0 ? lanes : [], centred: true };
      }
      const n = Math.min(MAX_LANES, Math.max(1, Math.floor(total / 2)));
      const step = clamp(l.w / (2 * n), 2.8, 3.6);
      const each = Array.from({ length: n }, (_, i) => -(step / 2 + (n - 1 - i) * step)); // kerb lane first
      return { half, axis, fwd: each, back: each, centred: false };
    }
    const DEG = Math.PI / 180;
    for (const l of links) {
      const A = junction(find(l.a));
      const B = junction(find(l.b));
      if (A === B) continue;
      const pts = [{ x: A.x, z: A.z }, ...l.pts.slice(1, -1), { x: B.x, z: B.z }];
      // stations along it: the ends, every bend at least 15 m from the last station and from the far end (over 12°, or
      // where going straight on to the next vertex would cut more than 1.5 m off the road, as on the Expressway's long
      // sweeping curves), and where its lift profile bends (elevation.js), each lifted as far along the link as it is
      const bends = [];
      let last = pts[0];
      let since = 1; // index of the first vertex after the last station
      let rest = l.len;
      const offChord = (a, b, k0, k1) => { // furthest vertex k0..k1 from the chord a-b
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const L = Math.hypot(ex, ez) || 1;
        let worst = 0;
        for (let k = k0; k <= k1; k++) worst = Math.max(worst, Math.abs((pts[k].x - a.x) * ez - (pts[k].z - a.z) * ex) / L);
        return worst;
      };
      for (let k = 1; k < pts.length - 1; k++) {
        const p1 = pts[k];
        const p2 = pts[k + 1];
        const d0 = Math.hypot(p1.x - last.x, p1.z - last.z);
        rest -= Math.hypot(p1.x - pts[k - 1].x, p1.z - pts[k - 1].z);
        let turn = Math.abs(Math.atan2(p2.z - p1.z, p2.x - p1.x) - Math.atan2(p1.z - last.z, p1.x - last.x));
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if ((turn < 12 * DEG && offChord(last, p2, since, k) < 1.5) || d0 < 15 || rest < 15) continue;
        bends.push({ d: l.len - rest, x: p1.x, z: p1.z });
        last = p1;
        since = k + 1;
      }
      for (const d of liftBreaks(l.raw, l.len)) {
        if (d < 8 || d > l.len - 8 || bends.some((b) => Math.abs(b.d - d) < 8)) continue;
        // the point d m along pts
        let s0 = 0;
        for (let k = 0; k + 1 < pts.length; k++) {
          const L = Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
          if (s0 + L >= d) {
            const t = (d - s0) / (L || 1);
            bends.push({ d, x: pts[k].x + (pts[k + 1].x - pts[k].x) * t, z: pts[k].z + (pts[k + 1].z - pts[k].z) * t });
            break;
          }
          s0 += L;
        }
      }
      bends.sort((p, q) => p.d - q.d);
      const stations = [A];
      for (const b of bends) {
        const s = { x: b.x, z: b.z, lift: liftAlong(l.raw, b.d, l.len), hx: 0, hz: 0, signal: false, in: [], out: [], general: true, shape: true };
        nodes.push(s);
        stations.push(s);
      }
      stations.push(B);
      const lanes = lanesOf(l);
      for (let k = 0; k + 1 < stations.length; k++) {
        runs.push({ from: stations[k], to: stations[k + 1], ...lanes, rank: l.rank, ring: l.ring, vmax: l.vmax });
      }
    }
    console.info(`[roads] centreline streets: ${links.length} links, ${junctions.size} junctions, ${runs.length} straight runs`);
    return runs;
  }

  // 3. Directed edges between nodes, keeping only the lanes clear of obstacles. Lanes are checked every 2.5 m (clear of
  //    the junctions, where neighbouring corners would get in the way of the test).
  let edges = [];
  const laneOpen = (x0, z0, dx, dz, span, o) => {
    const clear = Math.min(12, span / 2);
    for (let t = clear; t <= span - clear + 1e-6; t += 2.5) {
      if (blockedOnStreet(x0 + dx * t - dz * o, z0 + dz * t + dx * o, LANE_CLEAR)) return false;
    }
    return true;
  };
  function addEdgeGeneral(r, from, to, lanes) {
    const x0 = from.x;
    const z0 = from.z;
    const span = Math.hypot(to.x - x0, to.z - z0);
    if (span < 8) return;
    const dx = (to.x - x0) / span;
    const dz = (to.z - z0) / span;
    const open = lanes.filter((o) => laneOpen(x0, z0, dx, dz, span, o));
    if (!open.length) return;
    edges.push({
      from, to, axis: r.axis, x0, z0, dx, dz, rx: -dz, rz: dx, span, half: r.half, lanes: open.sort((p, q) => p - q), moves: [],
      general: true, cand: lanes, divided: !!r.divided, centred: r.centred, rank: r.rank, ring: r.ring, vmax: r.vmax
    });
  }
  // Lanes of a one-way roadway moved left of a centreline, as on a two-way road: the inner lane half a lane out
  const leftOf = (lanes) => {
    const keep = lanes.length > 1 ? (lanes[1] - lanes[0]) / 2 : 1.65;
    return lanes.map((x) => x - lanes[lanes.length - 1] - keep);
  };
  // A divided road drawn as two one-way roadways between the same two junctions runs both ways along one centreline
  // here: each way keeps to the left of it, as on a two-way road, and the road is as wide as both roadways
  const travel = (r) => (r.fwd.length ? [r.from, r.to] : [r.to, r.from]);
  const oneWays = new Map(); // node -> next node -> the one-way run from one to the other
  for (const r of genRuns) {
    if (!r.fwd.length === !r.back.length) continue;
    const [a, b] = travel(r);
    if (!oneWays.has(a)) oneWays.set(a, new Map());
    oneWays.get(a).set(b, r);
  }
  for (const r of genRuns) {
    if (!r.fwd.length === !r.back.length || r.divided || r.ring) continue;
    const [a, b] = travel(r);
    const o = oneWays.has(b) && oneWays.get(b).get(a);
    if (!o || o.divided || o.ring) continue;
    for (const q of [r, o]) {
      if (q.fwd.length) q.fwd = leftOf(q.fwd);
      else q.back = leftOf(q.back);
      q.divided = true;
      q.centred = false;
    }
    r.half = o.half = r.half + o.half;
    if (r.half >= 7.25) r.axis = o.axis = 'ave'; // as wide as a main road
  }
  for (const r of genRuns) {
    if (r.fwd.length) addEdgeGeneral(r, r.from, r.to, r.fwd);
    if (r.back.length) addEdgeGeneral(r, r.to, r.from, r.back);
  }
  // Two edges from one node to the same next one (a service road whose ends were drawn onto its main road's junctions)
  // would drive through each other: keep the one with the most lanes
  const keptEdge = new Map();
  const edgeRank = (e) => e.lanes.length * 10 + e.half / 100;
  for (const e of edges) {
    let to = keptEdge.get(e.from);
    if (!to) keptEdge.set(e.from, (to = new Map()));
    const o = to.get(e.to);
    if (!o || edgeRank(e) > edgeRank(o)) to.set(e.to, e);
  }
  edges = edges.filter((e) => keptEdge.get(e.from).get(e.to) === e);
  // ...and where only some of the junctions on both sides of its median became one, the stretches of its two roadways
  // that run on top of each other the other way (at the same level: not a deck over the street under it)
  {
    const oneWay = edges.filter((e) => !e.divided && e.centred && !e.ring); // lanes about its centreline
    const lift = (e) => (e.from.lift + e.to.lift) / 2;
    const cells = new Map(); // 16 m cells -> the one-way edges passing within 4 m
    oneWay.forEach((e, i) => {
      e.oneWay = i;
      for (let t = 0; t <= e.span; t += 8) {
        const x = e.x0 + e.dx * t;
        const z = e.z0 + e.dz * t;
        for (let ix = Math.floor((x - 4) / 16); ix <= Math.floor((x + 4) / 16); ix++) {
          for (let iz = Math.floor((z - 4) / 16); iz <= Math.floor((z + 4) / 16); iz++) {
            const k = (ix + 4096) * 8192 + (iz + 4096);
            const list = cells.get(k);
            if (!list) cells.set(k, [e]);
            else if (list[list.length - 1] !== e) list.push(e);
          }
        }
      }
    });
    // metres of e along f whose lanes come within 3 m of f's (going the other way, a lane a to e's right is -a to f's)
    const onTop = (e, f) => {
      let hits = 0;
      for (let t = 0; t <= e.span; t += 2) {
        const px = e.x0 + e.dx * t - f.x0;
        const pz = e.z0 + e.dz * t - f.z0;
        const u = px * f.dx + pz * f.dz;
        if (u < 0 || u > f.span) continue;
        const side = px * f.rx + pz * f.rz;
        if (e.lanes.some((a) => f.lanes.some((b) => Math.abs(side - a - b) < 3))) hits += 2;
      }
      return hits;
    };
    const partner = new Map(); // edge -> half width of the widest roadway running the other way on top of it
    const tested = new Set();
    for (const list of cells.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const e = list[i];
          const f = list[j];
          if (e.dx * f.dx + e.dz * f.dz > -0.94 || Math.abs(lift(e) - lift(f)) > 2) continue; // the other way, within 20°
          const key = Math.min(e.oneWay, f.oneWay) * 65536 + Math.max(e.oneWay, f.oneWay);
          if (tested.has(key)) continue;
          tested.add(key);
          if (Math.max(onTop(e, f), onTop(f, e)) < 6) continue;
          partner.set(e, Math.max(partner.get(e) || 0, f.half));
          partner.set(f, Math.max(partner.get(f) || 0, e.half));
        }
      }
    }
    for (const [e, other] of partner) {
      e.lanes = leftOf(e.cand).filter((o) => laneOpen(e.x0, e.z0, e.dx, e.dz, e.span, o));
      e.half += other;
      if (e.half >= 7.25) e.axis = 'ave'; // as wide as a main road
      e.divided = true;
    }
    edges = edges.filter((e) => e.lanes.length);
  }
  // moves are known (5.); know them already, so that no road keeps clear of a dead one merging with it or forking off it
  {
    const outsOf = new Map();
    for (const e of edges) {
      if (!outsOf.has(e.from)) outsOf.set(e.from, []);
      outsOf.get(e.from).push(e);
    }
    const live = largestComponent(edges, (e) => (outsOf.get(e.to) || []).filter((f) => f.to !== e.from && e.dx * f.dx + e.dz * f.dz >= -0.5));
    for (const e of edges) e.live = live.has(e);
  }
  const liveArm = (a) => !!((a.in && a.in.live) || (a.out && a.out.live));

  // The roads meeting at each node ("arms": one per direction a road leaves it in), from the edges into and out of it:
  // { ux, uz } (unit, away from the node), half (the widest roadway's half width), ave (a major road's), and its edge
  // `in` and edge `out`, if any, its road's rank and whether it is a roundabout's ring. The two ways of a two-way street share an arm, and so do the two one-way roadways of a
  // divided road (within 20° of each other); a second road arriving or leaving within 20° of another (where streets
  // merge or fork) gets an arm of its own. With `only`, for just the nodes in that set.
  function computeArms(list, only = null) {
    for (const n of only || nodes) n.arms = [];
    const ends = new Map(); // node -> the edge ends there, in the order the edges come
    list.forEach((e, i) => {
      for (const [n, role, ux, uz] of [[e.from, 'out', e.dx, e.dz], [e.to, 'in', -e.dx, -e.dz]]) {
        if (only && !only.has(n)) continue;
        if (role === 'out') e.outArm = null;
        else e.inArm = null;
        if (!ends.has(n)) ends.set(n, []);
        ends.get(n).push({ e, role, ux, uz, order: 2 * i + (role === 'in' ? 1 : 0) });
      }
    });
    const armed = (q) => (q.role === 'out' ? q.e.outArm : q.e.inArm);
    for (const [n, at] of ends) {
      // arms in the order of their first edge end, each pointing along it
      const newArm = (q) => {
        const a = { ux: q.ux, uz: q.uz, half: 0, ave: false, rank: 0, ring: false, in: null, out: null, order: q.order };
        n.arms.push(a);
        return a;
      };
      const join = (a, q) => {
        a[q.role] = q.e;
        if (q.role === 'out') q.e.outArm = a;
        else q.e.inArm = a;
        a.half = Math.max(a.half, q.e.half);
        a.ave = a.ave || q.e.axis === 'ave';
        a.rank = Math.max(a.rank, q.e.rank);
        a.ring = a.ring || q.e.ring;
        a.order = Math.min(a.order, q.order);
      };
      // both ways of a two-way street
      for (const q of at) {
        if (q.role !== 'out') continue;
        const r = at.find((p) => p.role === 'in' && p.e.from === q.e.to);
        if (!r) continue;
        const a = newArm(q.order < r.order ? q : r);
        join(a, q);
        join(a, r);
      }
      // one-way roadways within 20°, one each way: a divided road's, the best aligned first
      const pairs = [];
      for (const q of at) {
        if (q.role !== 'out' || armed(q)) continue;
        for (const r of at) {
          const d = q.ux * r.ux + q.uz * r.uz;
          if (r.role === 'in' && !armed(r) && d > 0.94) pairs.push([d, q, r]);
        }
      }
      pairs.sort((p, q) => q[0] - p[0]);
      for (const [, q, r] of pairs) {
        if (armed(q) || armed(r)) continue;
        const a = newArm(q.order < r.order ? q : r);
        join(a, q);
        join(a, r);
      }
      // and every other road alone
      for (const q of at) if (!armed(q)) join(newArm(q), q);
      n.arms.sort((a, b) => a.order - b.order);
      // an arm within 20° of an earlier one (where roads merge or fork) crosses the other roads as one with it (its
      // lead), as wide as the widest of them
      for (const a of n.arms) {
        a.lead = n.arms.find((b) => b.lead === b && b.ux * a.ux + b.uz * a.uz > 0.94) || a;
        a.lead.wide = Math.max(a.lead === a ? 0 : a.lead.wide, a.half);
      }
    }
  }
  computeArms(edges);
  // A node where just one road goes on, bending less than 35°, is a shape node: no corner to stop at (nor a
  // fork: a road splitting in two live ones within 20°)
  const bends = (n) => {
    const leads = n.arms.filter((a) => a.lead === a);
    const forks = leads.some((l) => n.arms.filter((a) => a.lead === l && liveArm(a)).length > 1);
    return leads.length === 2 && leads[0].ux * leads[1].ux + leads[0].uz * leads[1].uz < -0.82 && !forks;
  };
  for (const n of nodes) if (!n.shape && bends(n)) n.shape = true;
  // Where two roads leave a node within 20° of each other (they merge or fork there), how far out every lane of one
  // first keeps 3 m (a car's width and some) from every lane of the other
  const lanesOut = (a, r, out) => {
    out.length = 0;
    for (const e of [a.in, a.out]) {
      if (!e || !e.live) continue;
      const t = e === a.out ? r : e.span - r; // r from its start leaving, r before its end arriving
      for (const o of e.lanes) out.push(e.x0 + e.dx * t + e.rx * o, e.z0 + e.dz * t + e.rz * o);
    }
    return out;
  };
  const lanesA = [];
  const lanesB = [];
  function apart(a, b) {
    for (let r = 2; r < 45; r++) {
      lanesOut(a, r, lanesA);
      lanesOut(b, r, lanesB);
      let near = Infinity;
      for (let i = 0; i < lanesA.length; i += 2) {
        for (let j = 0; j < lanesB.length; j += 2) near = Math.min(near, Math.hypot(lanesA[i] - lanesB[j], lanesA[i + 1] - lanesB[j + 1]));
      }
      if (near >= 3) return r;
    }
    return 45;
  }
  // How far before node n an edge arriving along `arm` stops: clear of every road crossing it (at whatever angle: its
  // curb corner reaches past the crossing road's far side by half its own width over the tangent) plus the crosswalk,
  // and clear of the lanes of a road merging with it or forking off it
  const goesOn = (p, q) => p.ux * q.ux + p.uz * q.uz < 0 && Math.abs(p.ux * q.uz - p.uz * q.ux) < 0.26; // q within 15° of straight on from p
  function stopBack(n, arm) {
    if (n.shape) return 1;
    const a = arm.lead;
    let ext = 0;
    let fork = 0;
    for (const b of n.arms) {
      if (b === arm) continue;
      if (b.lead === a) {
        if (liveArm(arm) && liveArm(b)) fork = Math.max(fork, apart(arm, b) + 1); // side by side rather than across
        continue;
      }
      if (b.lead !== b) continue; // crossing as one with its lead
      if (arm.ring && b.ring) continue; // the roundabout's ring going on round
      // the same road going on (into either of two roads forking there, or out of either of two merging)
      if (n.arms.some((p) => p.lead === a && n.arms.some((q) => q.lead === b && goesOn(p, q)))) continue;
      const cos = a.ux * b.ux + a.uz * b.uz;
      const sin = Math.abs(a.ux * b.uz - a.uz * b.ux);
      ext = Math.max(ext, (b.wide + a.wide * Math.abs(cos)) / sin);
    }
    return Math.max(ext > 0 ? Math.min(ext, 20) + CROSSWALK : 2, fork);
  }
  // Edges run between stop lines: clear of the roads crossing them and the crosswalk at both ends. On a short link
  // between acute corners the two pull in together, keeping at least 10 m (or half the link) to queue on.
  function place(e) {
    let b0 = stopBack(e.from, e.outArm);
    let b1 = stopBack(e.to, e.inArm);
    const keep = Math.min(10, e.span * 0.5);
    e.squeezed = false;
    if (e.span - b0 - b1 < keep) {
      const k = (e.span - keep) / (b0 + b1);
      b0 *= k;
      b1 *= k;
      e.squeezed = !e.to.shape; // its stop line closer to the roads crossing ahead than they need (see the end of 4.)
    }
    e.sx = e.x0 + e.dx * b0;
    e.sz = e.z0 + e.dz * b0;
    e.len = e.span - b0 - b1;
  }
  for (const e of edges) place(e);
  const placed = edges; // (see 5.)
  const genCreated = edges.length;
  edges = edges.filter((e) => e.len > 4);

  // Paint describes the physical streets, including dead ends and roads AI traffic cannot circulate through.
  // Snapshot their geometry before routing moves stop lines, drops edges and renumbers the surviving junctions.
  const paintNodes = new Map(nodes.map((n, id) => [n, { id, x: n.x, z: n.z, lift: n.lift, shape: n.shape }]));
  const paintEdges = edges.map(({ from, to, axis, x0, z0, sx, sz, dx, dz, rx, rz, span, len, half, lanes }) => ({
    from: paintNodes.get(from), to: paintNodes.get(to), axis, x0, z0, sx, sz, dx, dz, rx, rz, span, len, half, lanes
  }));
  // ...and the streets as built (streets.js lays their asphalt, junctions and sidewalks): every edge, short ones too,
  // centre to centre, with each node's lift and the roads meeting it
  const streetNodes = new Map(nodes.map((n) => [n, {
    x: n.x, z: n.z, lift: n.lift, shape: !!n.shape, arms: (n.arms || []).map(({ ux, uz, half }) => ({ ux, uz, half }))
  }]));
  const streets = {
    nodes: [...streetNodes.values()],
    edges: placed.map(({ from, to, x0, z0, dx, dz, rx, rz, span, half, rank, ring }) => ({
      from: streetNodes.get(from), to: streetNodes.get(to), x0, z0, dx, dz, rx, rz, span, half, rank, ring
    }))
  };

  // 4. Movements at each intersection (no U-turns) and the lane each lane leads to, along obstacle-free curves:
  //    straight on, lane i keeps to lane i + k ahead, k chosen to use as many lanes there as possible with the least
  //    sideways shift; turns go from the lane nearest the turn into the lane nearest it (on the left, kerb-side turns
  //    are lefts and turns across oncoming traffic rights: the classification is purely geometric). Lanes left with no way on
  //    (where the road ends or narrows) turn alongside the turn lane, or merge. Across the road, lanes always run
  //    left turns, straight on, right turns, into lanes in the same order, so no two paths from one approach cross.
  const lateral = (e, i) => e.x0 * e.rx + e.z0 * e.rz + e.lanes[i];
  const ORDER = { L: 0, S: 1, R: 2 };
  function pathClear(e, i, f, j) {
    const c = makeCurve(e, i, f, j);
    const p = { x: 0, z: 0, dx: 0, dz: 0 };
    for (let k = 1; k < 10; k++) {
      curvePoint(c, c.len * k / 10, p);
      if (blockedOnStreet(p.x, p.z, 0.8)) return false;
    }
    return true;
  }
  function inOrder(e, m, i, j) {
    for (const o of e.moves) {
      for (let k = 0; k < e.lanes.length; k++) {
        if (k === i || o.out[k] < 0) continue;
        // o from k is right of m from i: by its kind of turn, then (two of a kind, where a road forks) by how far right
        // it bends
        const right = ORDER[o.turn] - ORDER[m.turn] || (o === m ? o.out[k] - j : Math.sign(o.cross - m.cross));
        if (k < i ? right > 0 : right < 0) return false;
      }
    }
    return true;
  }
  function nearestLane(e, i, f) {
    let j = 0;
    for (let k = 1; k < f.lanes.length; k++) {
      if (Math.abs(lateral(f, k) - lateral(e, i)) < Math.abs(lateral(f, j) - lateral(e, i))) j = k;
    }
    return j;
  }
  // Let lane i of e make move m into lane j of its edge (clamped to the lanes there), if the way is clear
  function link(e, m, i, j) {
    j = Math.max(0, Math.min(m.to.lanes.length - 1, j));
    if (m.out[i] < 0 && inOrder(e, m, i, j) && pathClear(e, i, m.to, j)) m.out[i] = j;
    return m.out[i] >= 0;
  }
  function serveEveryLane(e) {
    const n = e.lanes.length;
    for (let i = 0; i < n; i++) {
      if (e.moves.some((m) => m.out[i] >= 0)) continue;
      const turnLane = (m, k) => link(e, m, i, m.turn === 'L' ? k : m.to.lanes.length - 1 - k);
      const side = (m) => (m.turn === 'L' ? i : n - 1 - i); // lanes between i and the turn's side of the road
      e.moves.some((m) => m.turn !== 'S' && side(m) <= (n - 1) / 2 && turnLane(m, side(m))) ||
        e.moves.some((m) => m.turn === 'S' && link(e, m, i, nearestLane(e, i, m.to))) ||
        e.moves.some((m) => m.turn !== 'S' && turnLane(m, side(m))) ||
        e.moves.some((m) => m.to.lanes.some((_, j) => link(e, m, i, j)));
    }
    e.moves = e.moves.filter((m) => m.out.some((j) => j >= 0));
  }
  for (const e of edges) e.from.out.push(e);
  for (const e of edges) {
    const n = e.lanes.length;
    for (const f of e.to.out) {
      if (f.to === e.from || e.dx * f.dx + e.dz * f.dz < -0.5) continue;
      const cross = e.dx * f.dz - e.dz * f.dx;
      e.moves.push({ to: f, turn: cross > 0.5 ? 'R' : cross < -0.5 ? 'L' : 'S', cross, out: new Array(n).fill(-1) });
    }
    // the straightest first: where a road forks, the branch going most nearly straight on keeps most of its lanes
    const ahead = (m) => e.dx * m.to.dx + e.dz * m.to.dz;
    for (const m of e.moves.slice().sort((p, q) => ahead(q) - ahead(p))) {
      const f = m.to;
      if (m.turn === 'L') link(e, m, 0, 0);
      else if (m.turn === 'R') link(e, m, n - 1, f.lanes.length - 1);
      else {
        let best = 0;
        let bestScore = -Infinity;
        for (let k = 1 - n; k < f.lanes.length; k++) {
          const used = new Set();
          let score = 0;
          for (let i = 0; i < n; i++) {
            const j = Math.max(0, Math.min(f.lanes.length - 1, i + k));
            used.add(j);
            score -= Math.abs(lateral(f, j) - lateral(e, i));
          }
          score += 100 * used.size;
          if (score > bestScore) {
            bestScore = score;
            best = k;
          }
        }
        for (let i = 0; i < n; i++) link(e, m, i, i + best);
      }
    }
    // On a roundabout's ring the links between arms are too short to change lanes on, so every lane may go on round or
    // leave by any exit, into its nearest lane there (else the inner lane can't get out, fills up and locks the ring)
    if (e.ring) {
      for (const m of e.moves) {
        for (let i = 0; i < n; i++) {
          const j = nearestLane(e, i, m.to);
          if (m.out[i] < 0 && pathClear(e, i, m.to, j)) m.out[i] = j;
        }
      }
    }
    serveEveryLane(e);
  }

  // Sides & right-of-way groups of node n's arms (see 7.)
  function sidesAndGroups(n) {
    const arms = n.arms;
    let next = 4;
    for (const a of arms) a.side = next++;
    n.sideCount = Math.max(4, next);
    // roads: arms paired with the one most nearly opposite (beyond 145°), the likeliest pairs first: the straightest,
    // and of two about as straight, the one about as wide (a side street merging into a road nearly head on doesn't
    // take over the road's other side)
    const pairs = [];
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const d = arms[i].ux * arms[j].ux + arms[i].uz * arms[j].uz;
        if (d < -0.82) pairs.push([d + 0.02 * Math.abs(arms[i].half - arms[j].half), arms[i], arms[j]]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0]);
    const mates = new Map();
    for (const [, a, b] of pairs) {
      if (mates.has(a) || mates.has(b) || a.ring || b.ring) continue;
      mates.set(a, b);
      mates.set(b, a);
    }
    const roads = [];
    const done = new Set();
    let groups = 0;
    // on a roundabout the ring is one road, and the main one: traffic on it has the right of way over traffic entering
    const ring = arms.filter((a) => a.ring);
    if (ring.length) {
      for (const a of ring) done.add(a);
      roads.push({ members: ring, group: groups++, rank: Infinity });
    }
    for (const a of arms) {
      if (done.has(a)) continue;
      done.add(a);
      const mate = mates.get(a);
      const members = mate && !done.has(mate) ? [a, mate] : [a];
      if (mate) done.add(mate);
      roads.push({ members, group: -1, rank: Math.max(...members.map((m) => m.rank * 100 + m.half)) });
    }
    roads.sort((p, q) => q.rank - p.rank);
    for (const r of roads) if (r.group < 0) r.group = groups++;
    for (const r of roads) for (const m of r.members) m.group = r.group;
    n.groupCount = Math.max(2, groups);
  }

  // A short link squeezed between two corners may leave its stop line inside the road crossing ahead, where whoever
  // waits on it stands in the way of the traffic crossing there (of other roads, which share the junction with it).
  // Where the link comes off a bend (a shape node: nothing crosses there), its stop line goes back as far as that
  // takes, as long as a car waiting there still stands on the link (not around the bend, in the way of the next);
  // a link that can't keep clear even so is dropped.
  const inOf = new Map();
  for (const e of edges) {
    if (!inOf.has(e.to)) inOf.set(e.to, []);
    inOf.get(e.to).push(e);
  }
  const HALF_CAR = 2.3;
  const HALF_WIDE = 0.95;
  const pathPt = { x: 0, z: 0, dx: 0, dz: 1 };
  function inTheWay(e) {
    const n = e.to;
    sidesAndGroups(n);
    // a car standing at each of its lanes' stop line
    const cars = e.lanes.map((o) => [e.sx + e.dx * (e.len - HALF_CAR) + e.rx * o, e.sz + e.dz * (e.len - HALF_CAR) + e.rz * o]);
    for (const o of inOf.get(n)) {
      if (o === e || o.inArm.group === e.inArm.group) continue;
      for (const m of o.moves) {
        for (let i = 0; i < o.lanes.length; i++) {
          if (m.out[i] < 0) continue;
          const c = makeCurve(o, i, m.to, m.out[i]);
          for (let s = 0; s <= c.len; s += 1) {
            curvePoint(c, s, pathPt);
            for (const [cx, cz] of cars) {
              const dx = pathPt.x - cx;
              const dz = pathPt.z - cz;
              if (dx * dx + dz * dz > 36) continue;
              // how deep a car on the path overlaps it (separating axes)
              let depth = Infinity;
              for (const [ax, az] of [[e.dx, e.dz], [e.rx, e.rz], [pathPt.dx, pathPt.dz], [-pathPt.dz, pathPt.dx]]) {
                const ra = HALF_CAR * Math.abs(e.dx * ax + e.dz * az) + HALF_WIDE * Math.abs(e.rx * ax + e.rz * az);
                const rb = HALF_CAR * Math.abs(pathPt.dx * ax + pathPt.dz * az) + HALF_WIDE * Math.abs(pathPt.dz * ax - pathPt.dx * az);
                depth = Math.min(depth, ra + rb - Math.abs(dx * ax + dz * az));
              }
              if (depth > 0.25) return true;
            }
          }
        }
      }
    }
    return false;
  }
  const inTheWayOut = new Set();
  for (const e of edges) {
    if (!e.squeezed || !e.from.shape || !inTheWay(e)) continue;
    while (e.len > 6 && inTheWay(e)) e.len = Math.max(5.5, e.len - 1);
    if (inTheWay(e)) inTheWayOut.add(e); // even so
  }
  if (inTheWayOut.size) {
    edges = edges.filter((e) => !inTheWayOut.has(e));
    for (const e of edges) e.moves = e.moves.filter((m) => !inTheWayOut.has(m.to));
  }

  // 5. Keep the largest strongly connected set of edges so no vehicle can ever reach a dead end
  const kept = largestComponent(edges, (e) => e.moves.map((m) => m.to));
  const genShortKept = edges.length;
  const genLost = edges.filter((e) => !kept.has(e));
  edges = edges.filter((e) => kept.has(e));
  // Roads kept clear of a road merging with them or forking off them that is gone now (too short, or no way on from it
  // after all) get their stop lines placed again without it
  const dropped = placed.filter((e) => e.live && !kept.has(e));
  if (dropped.length) {
    const redo = new Set();
    for (const e of dropped) {
      e.live = false;
      redo.add(e.from).add(e.to);
    }
    computeArms(placed, redo);
    for (const n of redo) if (!n.shape && bends(n)) n.shape = true;
    for (const e of edges) if (redo.has(e.from) || redo.has(e.to)) place(e);
  }
  console.info(`[roads] edges: ${genCreated} with clear lanes, ${genShortKept} long enough, ${genShortKept - genLost.length} connected`);
  for (const e of edges) {
    e.moves = e.moves.filter((m) => kept.has(m.to));
    serveEveryLane(e);
    // Lanes still leading nowhere (every curve out of them grazes a curb or obstacle): send them on to the nearest lane
    // of the straightest move anyway, so every lane always has a way on
    for (let i = 0; i < e.lanes.length; i++) {
      if (!e.moves.length || e.moves.some((m) => m.out[i] >= 0)) continue;
      const m = e.moves.find((q) => q.turn === 'S') || e.moves[0];
      m.out[i] = nearestLane(e, i, m.to);
    }
  }
  edges.forEach((e, i) => (e.id = i));

  for (const n of nodes) n.in = n.out = null;
  for (const e of edges) {
    (e.from.out || (e.from.out = [])).push(e);
    (e.to.in || (e.to.in = [])).push(e);
  }
  nodes = nodes.filter((n) => n.in && n.out);
  nodes.forEach((n, i) => (n.id = i));

  // 6. Signalised junctions (city-config.js SIGNALS: OSM's and generated ones): the node nearest each, within 20 m (OSM
  //    sometimes maps the signal on an approach, a few metres before the junction proper, and nearby junctions merge).
  //    Each runs the signal cycle from the offset (s) it comes with. Not on a roundabout's ring: the ring stopping at a
  //    red queues back over its short links into the junctions before it, where the entries wait for the ring, and
  //    the whole roundabout locks up; there the ring keeps the right of way instead (step 7).
  for (const s of signalIntersections) {
    let best = null;
    let bd = Infinity;
    for (const m of nodes) {
      if (m.roundabout) continue;
      const d = Math.hypot(m.x - s.x, m.z - s.z);
      if (d < bd) [best, bd] = [m, d];
    }
    if (best && bd < 20) {
      best.signal = true;
      best.signalOffset = s.offset || 0;
    }
  }

  // 7. Sides & right of way at each node, for traffic.js. Its arms are its sides (one crosswalk and approach each): a
  //    junction's arms count from 4 (Slop New York's grid kept 0-3 for its compass sides). The arms of one road (on
  //    opposite sides) form a group: vehicles of different groups never share the junction, and group 0 has the right
  //    of way at unsignalised junctions (and the main phase at signals): a roundabout's ring where there is one, else
  //    the most important road (by class, then width).
  computeArms(edges);
  for (const n of nodes) {
    sidesAndGroups(n);
    n.sideGroups = new Array(n.sideCount).fill(-1); // the group of the road crossing each side, for walk signals
    for (const a of n.arms) n.sideGroups[a.side] = a.group;
  }
  for (const e of edges) {
    e.inSide = e.inArm.side; // the side of e.to it arrives over
    e.outSide = e.outArm.side; // the side of e.from it leaves over
    e.axisIndex = e.inArm.group; // its right-of-way group at e.to
    // lateral axis of its road, the same both ways (+x across north-south roads, +z across east-west ones)
    const flip = e.rx < -1e-6 || (Math.abs(e.rx) <= 1e-6 && e.rz < 0);
    e.clx = flip ? -e.rx : e.rx;
    e.clz = flip ? -e.rz : e.rz;
  }
  for (const e of edges) {
    e.opposite = e.to.in.find((o) => o !== e && o.axisIndex === e.axisIndex && o.dx * e.dx + o.dz * e.dz < -0.7) || null;
  }
  greenWave(nodes);

  // Lane-to-lane curves are built on first use and cached (key: under 16 lanes, any number of edges)
  const curves = new Map();
  const ids = edges.length;
  function connector(e, i, f, j) {
    const k = ((e.id * 16 + i) * ids + f.id) * 16 + j;
    let c = curves.get(k);
    if (!c) curves.set(k, (c = makeCurve(e, i, f, j)));
    return c;
  }

  const isRoadClear = (x, z, clear = 0.15) => !blockedOnStreet(x, z, clear);
  return { nodes, edges, paintEdges, streets, connector, curvePoint, walkable, onSidewalk, isRoadClear };
}

// The largest strongly connected set of `list` (a Set), going on from item e to the items next(e)
function largestComponent(list, next) {
  const index = new Map(list.map((e, i) => [e, i]));
  const succ = list.map((e) => next(e).map((f) => index.get(f)).filter((j) => j !== undefined));
  const pred = list.map(() => []);
  succ.forEach((s, i) => {
    for (const j of s) pred[j].push(i);
  });
  // Kosaraju: finishing order going forwards, then components going backwards from the last finished
  const visited = new Uint8Array(list.length);
  const order = [];
  for (let root = 0; root < list.length; root++) {
    if (visited[root]) continue;
    visited[root] = 1;
    const stack = [[root, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[1] < succ[top[0]].length) {
        const j = succ[top[0]][top[1]++];
        if (!visited[j]) {
          visited[j] = 1;
          stack.push([j, 0]);
        }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  const comp = new Int32Array(list.length).fill(-1);
  let best = -1;
  let bestSize = 0;
  for (let k = order.length - 1, c = 0; k >= 0; k--) {
    if (comp[order[k]] >= 0) continue;
    const stack = [order[k]];
    comp[order[k]] = c;
    let size = 0;
    while (stack.length) {
      const i = stack.pop();
      size++;
      for (const p of pred[i]) {
        if (comp[p] < 0) {
          comp[p] = c;
          stack.push(p);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c;
    }
    c++;
  }
  return new Set(list.filter((_, i) => comp[i] === best));
}

// Cubic Bézier from the end of lane i on edge e to the start of lane j on edge f: a quarter-circle-like
// arc around the corner for turns, an S-bend for straight lane shifts. Includes an arc-length table and
// the sharpest curvature along it (1 / tightest radius).
function makeCurve(e, i, f, j) {
  const x0 = e.sx + e.dx * e.len + e.rx * e.lanes[i];
  const z0 = e.sz + e.dz * e.len + e.rz * e.lanes[i];
  const x3 = f.sx + f.rx * f.lanes[j];
  const z3 = f.sz + f.rz * f.lanes[j];
  const cross = e.dx * f.dz - e.dz * f.dx;
  let k0;
  let k3;
  if (Math.abs(cross) < 0.5) {
    k0 = k3 = Math.hypot(x3 - x0, z3 - z0) / 3;
  } else {
    const t = ((x3 - x0) * f.dz - (z3 - z0) * f.dx) / cross;
    k0 = 0.552 * Math.abs(t);
    k3 = 0.552 * Math.hypot(x3 - (x0 + e.dx * t), z3 - (z0 + e.dz * t));
  }
  const c = {
    x0, z0, x3, z3,
    x1: x0 + e.dx * k0, z1: z0 + e.dz * k0,
    x2: x3 - f.dx * k3, z2: z3 - f.dz * k3,
    lut: new Float32Array(17),
    len: 0,
    curv: 0
  };
  let px = x0;
  let pz = z0;
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * x3;
    const z = u * u * u * z0 + 3 * u * u * t * c.z1 + 3 * u * t * t * c.z2 + t * t * t * z3;
    c.len += Math.hypot(x - px, z - pz);
    c.lut[k] = c.len;
    px = x;
    pz = z;
    const dx = 3 * u * u * (c.x1 - x0) + 6 * u * t * (c.x2 - c.x1) + 3 * t * t * (x3 - c.x2);
    const dz = 3 * u * u * (c.z1 - z0) + 6 * u * t * (c.z2 - c.z1) + 3 * t * t * (z3 - c.z2);
    const ddx = 6 * u * (c.x2 - 2 * c.x1 + x0) + 6 * t * (x3 - 2 * c.x2 + c.x1);
    const ddz = 6 * u * (c.z2 - 2 * c.z1 + z0) + 6 * t * (z3 - 2 * c.z2 + c.z1);
    c.curv = Math.max(c.curv, Math.abs(dx * ddz - dz * ddx) / Math.max(1e-6, Math.hypot(dx, dz) ** 3));
  }
  return c;
}

// Position and unit tangent at arc length s along a curve
function curvePoint(c, s, out) {
  let k = 1;
  while (k < 16 && c.lut[k] < s) k++;
  const s0 = c.lut[k - 1];
  const s1 = c.lut[k];
  const t = (k - 1 + Math.min(1, Math.max(0, (s - s0) / (s1 - s0 || 1)))) / 16;
  const u = 1 - t;
  out.x = u * u * u * c.x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x3;
  out.z = u * u * u * c.z0 + 3 * u * u * t * c.z1 + 3 * u * t * t * c.z2 + t * t * t * c.z3;
  const dx = 3 * u * u * (c.x1 - c.x0) + 6 * u * t * (c.x2 - c.x1) + 3 * t * t * (c.x3 - c.x2);
  const dz = 3 * u * u * (c.z1 - c.z0) + 6 * u * t * (c.z2 - c.z1) + 3 * t * t * (c.z3 - c.z2);
  const l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l;
  out.dz = dz / l;
  return out;
}

// Green waves. Signals on random offsets a block apart waste each other's greens: the short link between them fills on
// the far one's red and the near one's green has nowhere to send anyone. So each signal is linked to the next one
// straight on down each road out of it (within WAVE_REACH m), and offsets are set over a spanning tree of those links,
// the most important roads first: along each tree link the far signal turns green for the road arriving there one
// travel time (at WAVE_SPEED of the limit) after the near one turns green for traffic leaving onto it. Signals that
// city-config.js groups (within its SIGNAL_CLEAR m, sharing an offset) stay together.
const WAVE_REACH = 400;
const WAVE_SPEED = 0.7;
function greenWave(nodes) {
  const { cycle, mainRed } = SIGNAL_TIMING;
  const signals = nodes.filter((n) => n.signal);
  const start = (g) => (g === 0 ? 0 : mainRed); // when group g's green starts in the cycle
  // union-find with each node's offset relative to its root
  const parent = new Map(signals.map((n) => [n, n]));
  const rel = new Map(signals.map((n) => [n, 0]));
  const find = (n) => {
    const p = parent.get(n);
    if (p === n) return n;
    const r = find(p);
    rel.set(n, rel.get(n) + rel.get(p));
    parent.set(n, r);
    return r;
  };
  // join b to a so that offset(b) = offset(a) + shift
  const join = (a, b, shift) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent.set(rb, ra);
    rel.set(rb, rel.get(a) + shift - rel.get(b));
  };
  for (const a of signals) {
    for (const b of signals) if (a !== b && a.signalOffset === b.signalOffset && Math.hypot(a.x - b.x, a.z - b.z) < 60) join(a, b, 0);
  }
  const links = [];
  for (const a of signals) {
    for (const first of a.out) {
      let e = first;
      let t = 0;
      let dist = 0;
      const seen = new Set();
      while (e && !seen.has(e) && dist < WAVE_REACH) {
        seen.add(e);
        t += e.len / (WAVE_SPEED * e.vmax);
        dist += e.len;
        if (e.to.signal) {
          if (e.to !== a) links.push({ a, b: e.to, shift: start(first.outArm.group) + t - start(e.axisIndex), rank: first.rank, dist });
          break;
        }
        let next = null;
        for (const f of e.to.out) if (f.dx * e.dx + f.dz * e.dz > 0.85 && (!next || f.rank > next.rank)) next = f;
        e = next;
      }
    }
  }
  links.sort((p, q) => q.rank - p.rank || p.dist - q.dist);
  for (const l of links) join(l.a, l.b, l.shift);
  for (const n of signals) {
    const r = find(n);
    n.signalOffset = (((r.signalOffset + rel.get(n)) % cycle) + cycle) % cycle;
  }
}

export { buildRoadNetwork, CROSSWALK };
