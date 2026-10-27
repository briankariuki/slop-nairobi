import { GEO } from './nairobi-geodata.js';
import { heightAt } from './terrain.js';

// How high roads run: the one rule shared by the Expressway decks (bridges.js) and the traffic driving on them
// (road-network.js, traffic.js). OSM says only that a road is raised (bridge + layer), not by how much, so each layer
// lifts it LAYER_LIFT m over the ground under it.
//
// A road graph node is raised when every link meeting it is: by LAYER_LIFT × the lowest layer among them (where a
// layer-2 deck merges into a layer-1 one, the layer-2 deck comes down to it); a node where a raised road meets one on
// the ground is at lift 0. Along a link the lift goes from one end node's to the other's (liftAlong):
// - a slip road (OSM *_link) climbs linearly over its whole length, from the street to the deck;
// - a raised mainline keeps its full height (its layer's) except where it comes down to an end node on the ground,
//   which it does on a RAMP_GRADE slope: a flyover mapped as one bridge link between two streets rises from both, and
//   a short one doesn't reach full height;
// - any other link stays on the ground.
//
// Road surface height at (x, z) with lift l: roadHeight(x, z, l) = ground + the asphalt + l, plus the deck's DECK_TOP
// over its structure once it is raised a metre or more (easing in from the street end of a ramp).

export const LAYER_LIFT = 8;
export const ROAD_Y = 0.03; // the asphalt's thickness over the terrain (streets.js lays it there)
const RAMP_GRADE = 0.08;
const DECK_TOP = 0.2;

export const isElevated = (r) => !!r.bridge && (r.layer || 0) >= 1;

const RG = GEO.roadGraph;

// GEO.roadGraph.nodes[i] → lift (m)
export const nodeLift = (() => {
  const layer = new Float32Array(RG.nodes.length).fill(Infinity);
  for (const l of RG.links) {
    const k = isElevated(l) ? l.layer : 0;
    for (const i of [l.a, l.b]) layer[i] = Math.min(layer[i], k);
  }
  return layer.map((k) => (Number.isFinite(k) ? k * LAYER_LIFT : 0));
})();

export function roadHeight(x, z, lift) {
  return heightAt(x, z) + ROAD_Y + lift + DECK_TOP * Math.min(1, lift);
}

// Lift d m along road graph link `link` (total m long) from node a
export function liftAlong(link, d, total) {
  const l0 = nodeLift[link.a];
  const l1 = nodeLift[link.b];
  if (!isElevated(link)) return l0 + ((l1 - l0) * d) / (total || 1);
  if (link.link) return l0 + ((l1 - l0) * d) / (total || 1);
  return Math.min(link.layer * LAYER_LIFT, l0 + RAMP_GRADE * d, l1 + RAMP_GRADE * (total - d));
}

// Distances along an elevated mainline link where its profile bends (where the ramps meet the full-height deck, or
// their peak), so straight pieces between them and the link's vertices follow it exactly
export function liftBreaks(link, total) {
  if (!isElevated(link) || link.link) return [];
  const full = link.layer * LAYER_LIFT;
  const l0 = nodeLift[link.a];
  const l1 = nodeLift[link.b];
  const d0 = (full - l0) / RAMP_GRADE; // where the ramp up from a reaches full height
  const d1 = total - (full - l1) / RAMP_GRADE; // where the one down to b leaves it
  if (d0 < d1) return [d0, d1].filter((d) => d > 0 && d < total);
  const peak = (l1 - l0 + RAMP_GRADE * total) / (2 * RAMP_GRADE);
  return peak > 0 && peak < total ? [peak] : [];
}

// Total length of a road graph link
export function linkLength(link) {
  const p = link.pts;
  let total = 0;
  for (let i = 2; i < p.length; i += 2) total += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return total;
}
