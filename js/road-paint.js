import * as THREE from 'three/webgpu';
import { heightAt, terrainNormal } from './terrain.js';
import { deckTop } from './bridges.js';
import { band, drape, ROAD_Y } from './street-geometry.js';
import { createRoadPaintMaterial } from './tsl-materials.js';

// Road markings generated from the drivable road network (js/road-network.js), so the paint matches where traffic
// actually drives and stops. Slop New York's road-paint.js (MIT, © 2026 Mr.doob), with Kenya's markings: broken white
// centre lines (solid where there are two lanes or more each way) and lane lines, yellow edge lines along the main
// roads, stop bars at the signals, broken give-way lines where a minor road or a roundabout's entry meets traffic with
// priority, and zebra stripes at the crossings: OSM's (traffic.js `zebras`) and each signalised junction's crosswalks
// (where pedestrian-routes.js walks people over). Laid on the ground like the streets (street-geometry.js drape), or on
// the Expressway's decks.

const WHITE = new THREE.Color(0xe6e2d6);
const YELLOW = new THREE.Color(0xe0b12a);
const PAINT_Y = ROAD_Y + 0.008; // over the asphalt
const DECK_Y = 0.012; // over a deck's surface
const CROSS_AT = 1.5; // a signalised junction's crosswalks: m past each stop line towards it (pedestrian-routes.js)
const DASH = [9, 1 / 3]; // centre and lane lines: 3 m dashes, 6 m gaps
const DECK_STEP = 4; // m between deck samples

function buildRoadPaint(scene, network, zebras = []) {
  const position = [];
  const normal = [];
  const side = [];
  const paint = [];
  const colors = [];
  const index = [];
  const lines = [];
  const bends = new Map();
  const n = [0, 1, 0];

  // One vertex of a strip running from (ax, az) along (ux, uz) (left normal (rx, rz)), at (x, y, z)
  function vertex(x, y, z, ax, az, ux, uz, rx, rz, col, period, duty, phase, flow, up) {
    const t = (x - ax) * ux + (z - az) * uz;
    const s = (x - ax) * rx + (z - az) * rz;
    position.push(x, y, z);
    if (up) normal.push(0, 1, 0);
    else {
      terrainNormal(x, z, n);
      normal.push(n[0], n[1], n[2]);
    }
    side.push(rx * s, rz * s);
    paint.push(phase + t * flow, period, duty);
    colors.push(col.r, col.g, col.b);
  }

  // Flat strip w wide from a to b, with a dash pattern (period, duty cycle) running along it, on the ground or, where
  // `lift` gives the deck's lift at a point (0..1 from a to b), on a deck
  function strip(ax, az, bx, bz, w, col, period = 1, duty = 1, phase = 0, flow = 1, lift = null) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) return;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const rx = -uz, rz = ux; // band()'s left
    const p = band(ax, az, bx, bz, -w / 2, w / 2);
    if (!lift) {
      drape(p, (q) => {
        const first = position.length / 3;
        for (let v = 0; v < q.length; v += 2) {
          const x = q[v], z = q[v + 1];
          vertex(x, heightAt(x, z) + PAINT_Y, z, ax, az, ux, uz, rx, rz, col, period, duty, phase, flow, false);
        }
        for (let i = 1; i + 1 < q.length / 2; i++) index.push(first, first + i + 1, first + i);
      });
      return;
    }
    // on a deck: straight pieces DECK_STEP m long at the deck's surface
    const k = Math.max(1, Math.ceil(len / DECK_STEP));
    const first = position.length / 3;
    for (let i = 0; i <= k; i++) {
      const f = i / k;
      const l = lift(f);
      for (const o of [-w / 2, w / 2]) {
        const x = ax + (bx - ax) * f + rx * o, z = az + (bz - az) * f + rz * o;
        vertex(x, deckTop(x, z, l) + DECK_Y, z, ax, az, ux, uz, rx, rz, col, period, duty, phase, flow, true);
      }
    }
    for (let i = 0; i < k; i++) {
      const a = first + 2 * i;
      index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  // The deck lift along edge e from a to b (fractions of its span), or null on the ground
  const liftOf = (e, fa, fb) => {
    const l0 = e.from.lift || 0, l1 = e.to.lift || 0;
    if (Math.max(l0, l1) < 0.05) return null;
    return (f) => l0 + (l1 - l0) * (fa + (fb - fa) * f);
  };
  const fraction = (e, x, z) => ((x - e.x0) * e.dx + (z - e.z0) * e.dz) / e.span;

  // Edges run between stop lines; s is measured from the start one and o to the right of the centre line
  const at = (e, s, o) => [e.sx + e.dx * s + e.rx * o, e.sz + e.dz * s + e.rz * o];
  const along = (e, o, w, col, period = 1, duty = 1) => {
    const start = (e.sx - e.x0) * e.dx + (e.sz - e.z0) * e.dz;
    const ends = [at(e, e.from.shape ? -start : 0.9, o), at(e, e.to.shape ? e.span - start : e.len - 0.9, o)];
    lines.push({ e, o, w, col, period, duty, ends, joins: [] });
  };
  const across = (e, s, o0, o1, w, col, period, duty) => {
    const [ax, az] = at(e, s, o0), [bx, bz] = at(e, s, o1);
    const fa = fraction(e, ax, az);
    strip(ax, az, bx, bz, w, col, period, duty, 0, 1, liftOf(e, fa, fa));
  };

  // The one or two directed edges of each road between a pair of intersections
  const roads = new Map();
  for (const e of network.paintEdges || network.edges) {
    const key = Math.min(e.from.id, e.to.id) * 65536 + Math.max(e.from.id, e.to.id);
    if (roads.has(key)) roads.get(key).push(e);
    else roads.set(key, [e]);
  }

  for (const [e, back] of roads.values()) {
    const firstLine = lines.length;
    // Lanes of both directions, measured to the right of e, left to right
    const lanes = e.lanes.map((o) => ({ o, dir: 1 }));
    if (back) for (const o of back.lanes) lanes.push({ o: -o, dir: -1 });
    lanes.sort((p, q) => p.o - q.o);
    const each = Math.max(e.lanes.length, back ? back.lanes.length : 0);

    // Broken white between lanes going the same way and between opposing ones (solid there on roads with two lanes or
    // more each way); nothing across a median
    for (let k = 0; k + 1 < lanes.length; k++) {
      const p = lanes[k];
      const q = lanes[k + 1];
      if (q.o - p.o > 4.5) continue;
      const mid = (p.o + q.o) / 2;
      if (p.dir !== q.dir && each >= 2) along(e, mid, 0.12, WHITE);
      else along(e, mid, 0.12, WHITE, ...DASH);
    }

    // Yellow edge lines 0.4 m in from the kerbs of the main roads
    if (e.axis === 'ave') for (const o of [-e.half + 0.4, e.half - 0.4]) along(e, o, 0.1, YELLOW);

    for (const [end, node] of [[0, e.from], [1, e.to]]) {
      if (!node.shape) continue;
      if (!bends.has(node.id)) bends.set(node.id, []);
      bends.get(node.id).push({ e, end, lines: lines.slice(firstLine) });
    }
  }

  // At a simple bend, corresponding offset lines meet at a bounded miter, without an intersection-sized gap.
  for (const roadsAtBend of bends.values()) {
    if (roadsAtBend.length !== 2) continue;
    const [a, b] = roadsAtBend;
    const sign = a.end === b.end ? -1 : 1;
    if ((a.e.dx * b.e.dx + a.e.dz * b.e.dz) * sign < 0.5) continue;
    for (const p of a.lines) {
      let q = null;
      let distance = 0.5;
      for (const line of b.lines) {
        const d = Math.abs(p.o - line.o * sign);
        if (!line.joins[b.end] && line.col === p.col && line.w === p.w && line.period === p.period &&
          line.duty === p.duty && d < distance) {
          q = line;
          distance = d;
        }
      }
      if (!q) continue;
      const A = p.ends[a.end];
      const B = q.ends[b.end];
      const dx = B[0] - A[0];
      const dz = B[1] - A[1];
      const cross = a.e.dx * b.e.dz - a.e.dz * b.e.dx;
      let join;
      if (Math.abs(cross) < 0.001) {
        if (Math.hypot(dx, dz) > 0.5) continue;
        join = [(A[0] + B[0]) * 0.5, (A[1] + B[1]) * 0.5];
      } else {
        const t = (dx * b.e.dz - dz * b.e.dx) / cross;
        const u = (dx * a.e.dz - dz * a.e.dx) / cross;
        const limit = Math.min(6, a.e.span * 0.25, b.e.span * 0.25);
        if (Math.abs(t) > limit || Math.abs(u) > limit) continue;
        join = [A[0] + a.e.dx * t, A[1] + a.e.dz * t];
      }
      p.ends[a.end] = q.ends[b.end] = join;
      p.joins[a.end] = [q, b.end];
      q.joins[b.end] = [p, a.end];
    }
  }

  // Continue the same dash phase around bends, even when adjacent road edges point in opposite directions.
  for (const line of lines) {
    // An unmatched marking keeps its original gap instead of extending towards a curb at a sharp bend.
    for (const end of [0, 1]) {
      if (!line.joins[end]) line.ends[end] = at(line.e, end ? line.e.len - 0.9 : 0.9, line.o);
    }
    line.len = Math.hypot(line.ends[1][0] - line.ends[0][0], line.ends[1][1] - line.ends[0][1]);
  }
  for (const root of lines) {
    if (root.phase !== undefined) continue;
    root.phase = 0;
    root.flow = 1;
    const stack = [root];
    while (stack.length) {
      const line = stack.pop();
      for (let end = 0; end < 2; end++) {
        if (!line.joins[end]) continue;
        const [next, nextEnd] = line.joins[end];
        if (next.phase !== undefined) continue;
        next.flow = line.flow * (end === nextEnd ? -1 : 1);
        next.phase = line.phase + end * line.len * line.flow - nextEnd * next.len * next.flow;
        next.phase = ((next.phase % next.period) + next.period) % next.period;
        stack.push(next);
      }
      const [[ax, az], [bx, bz]] = line.ends;
      strip(ax, az, bx, bz, line.w, line.col, line.period, line.duty, line.phase, line.flow,
        liftOf(line.e, fraction(line.e, ax, az), fraction(line.e, bx, bz)));
    }
  }

  // Stop bars at the signals and give-way lines where a road meets traffic with priority, across the lanes arriving
  // (Kenya drives on the left: from the kerb on the left to the centre line), at the stop lines traffic.js uses
  const rankAt = (n) => Math.max(0, ...n.arms.map((a) => a.rank));
  for (const f of network.edges) {
    const node = f.to;
    if (node.shape || node.lift > 0.5 || f.ring) continue;
    const back = node.out.find((g) => g.to === f.from && g.dx * f.dx + g.dz * f.dz < -0.9);
    const right = back ? Math.min(f.half - 0.1, f.lanes[f.lanes.length - 1] + 1.8) : f.half - 0.1;
    if (node.signal) across(f, f.len - 0.35, -f.half + 0.1, right, 0.45, WHITE);
    else if (node.arms.some((a) => a.ring) || rankAt(node) > f.rank) {
      for (const s of [f.len - 0.3, f.len - 0.75]) across(f, s, -f.half + 0.1, right, 0.2, WHITE, 0.6, 0.5);
    }
  }

  // Zebra stripes: 0.5 m bars along the road, 3 m long, kerb to kerb
  const zebra = (e, cx, cz) => {
    const s = (cx - e.sx) * e.dx + (cz - e.sz) * e.dz;
    across(e, s, -e.half, e.half, 3, WHITE, 1, 0.5);
  };
  for (const n of network.nodes) {
    if (!n.signal || n.lift > 0.5 || !n.road) continue;
    for (const road of n.road) {
      if (!road) continue;
      const s = road.to === n ? road.len + CROSS_AT : -CROSS_AT;
      zebra(road, road.sx + road.dx * s, road.sz + road.dz * s);
    }
  }
  for (const c of zebras) zebra(c.road, c.x, c.z);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('side', new THREE.Float32BufferAttribute(side, 2));
  geometry.setAttribute('paint', new THREE.Float32BufferAttribute(paint, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, createRoadPaintMaterial());
  mesh.name = 'RoadMarkings';
  mesh.renderOrder = 1; // over the asphalt
  scene.add(mesh);
  return mesh;
}

export { buildRoadPaint };
