import { GEO } from './nairobi-geodata.js';
import { MAP_LANDMARKS, getLocationLabel, isTypingInField } from './city-config.js';

// Slop New York's nyc-map.js, ported to Nairobi: the radar (bottom left) and the full-screen street atlas ([M]), drawn
// from the same OpenStreetMap data as the 3D city. New York's harbour, shoreline and Manhattan grid give way to
// Nairobi's roads drawn to their width, its parks and water, and every building footprint; the GPS route follows the
// road graph instead of the grid. World frame: 1 unit = 1 m, x = east, z = south. Both maps face true north.

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MIN_ZOOM = 0.08; // full map, pixels per metre: the whole detailed area and the hills around it
const MAX_ZOOM = 4.0; // single buildings
const RADAR_SCALE = 0.32; // radar pixels per metre on the ground (zooms out with altitude)
const T = GEO.terrain;
const BOUNDS = { minX: T.x0, minZ: T.z0, maxX: T.x0 + (T.nx - 1) * T.cell, maxZ: T.z0 + (T.nz - 1) * T.cell };

// Map palette, shared by the radar & the atlas (in step with css/style.css): graphite ground with the streets lighter
// than the ground they cross, muted parks & water; a PSV-yellow GPS route, white landmarks & player, cyan search hits
// and amber highways
const MAP = {
  outside: '#0f1317', // beyond the detailed area
  land: '#151a20',
  landEdge: '#2a323c',
  park: '#19301f',
  parkEdge: '#24432f',
  wood: '#17291b',
  pitch: '#1d3a24',
  parking: '#1b2027',
  water: '#0f2535',
  waterEdge: '#1d3d54',
  river: '#1d4562',
  rail: '#3a414b',
  path: '#2a313a',
  streets: '#363f4b',
  mainRoads: '#4a5463',
  buildings: ['#242a32', '#2b323c', '#353d49'],
  buildingEdge: '#171b21',
  landmarkFill: 'rgba(255, 255, 255, 0.06)',
  landmarkEdge: 'rgba(255, 255, 255, 0.38)',
  highway: '#b27a35',
  bridge: '#c08a3e',
  route: '#ffc21a',
  search: '#5fd0ff',
  halo: 'rgba(8, 11, 15, 0.9)'
};

const GREEN = { park: 'park', garden: 'park', grass: 'park', grassland: 'park', recreation_ground: 'park', cemetery: 'park', forest: 'wood', wood: 'wood', pitch: 'pitch', stadium: 'pitch', parking: 'parking', water: 'water' };
const MINOR = new Set(['residential', 'unclassified', 'service', 'living_street']);
const MAJOR = new Set(['tertiary', 'secondary', 'primary']);
const HIGHWAY = new Set(['trunk', 'motorway']);
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway']);

// Neighbourhood names at their real places (latitude, longitude)
const ll = (lat, lon) => [(lon - GEO.frame.lon0) * 111320 * Math.cos((GEO.frame.lat0 * Math.PI) / 180), -(lat - GEO.frame.lat0) * 110574];
const AREA_LABELS = [
  ['CENTRAL BUSINESS DISTRICT', -1.2846, 36.8238], ['UPPER HILL', -1.2985, 36.8128], ['NGARA', -1.2738, 36.8262],
  ['MUSEUM HILL', -1.2742, 36.8143], ['KARIOKOR', -1.2772, 36.8338], ['GIKOMBA', -1.2832, 36.8382]
].map(([label, lat, lon]) => [label, ...ll(lat, lon)]);
// Named parks and stadiums, at the middle of their outlines
const PARK_LABELS = GEO.areas.filter((a) => a.name && ['park', 'stadium'].includes(a.kind) && a.ring.length >= 8).map((a) => {
  let x = 0, z = 0;
  const n = a.ring.length / 2;
  for (let i = 0; i < n; i++) [x, z] = [x + a.ring[2 * i] / n, z + a.ring[2 * i + 1] / n];
  return [a.name, x, z];
});

// ---------------------------------------------------------------------------------------------------------------------
// World-space vector layers: built once into Path2D objects (world metres) and drawn through a canvas transform
// ---------------------------------------------------------------------------------------------------------------------

function boundsOf(pts) {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < pts.length; i += 2) {
    b.minX = Math.min(b.minX, pts[i]);
    b.maxX = Math.max(b.maxX, pts[i]);
    b.minZ = Math.min(b.minZ, pts[i + 1]);
    b.maxZ = Math.max(b.maxZ, pts[i + 1]);
  }
  return b;
}

// Appends a closed ring (flat [x0, z0, x1, z1, ...]), always wound the same way as Path2D.rect (so overlapping rings
// of one path union under the nonzero fill rule instead of cancelling out)
function addRing(path, pts) {
  const n = pts.length >> 1;
  if (n < 3) return;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += pts[2 * j] * pts[2 * i + 1] - pts[2 * i] * pts[2 * j + 1];
  if (a >= 0) {
    path.moveTo(pts[0], pts[1]);
    for (let i = 1; i < n; i++) path.lineTo(pts[2 * i], pts[2 * i + 1]);
  } else {
    path.moveTo(pts[2 * n - 2], pts[2 * n - 1]);
    for (let i = n - 2; i >= 0; i--) path.lineTo(pts[2 * i], pts[2 * i + 1]);
  }
  path.closePath();
}

function addLine(path, pts) {
  if (pts.length < 4) return;
  path.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
}

/**
 * A vector layer split into square tiles of Path2D, so a view only rasterizes the tiles it overlaps. Every item goes
 * to the tile holding its centre; a tile's bounds grow to cover its items.
 */
class TiledLayer {
  constructor(size = 500) {
    this.size = size;
    this.tiles = new Map();
  }

  pathFor(b) {
    const ix = Math.floor((b.minX + b.maxX) * 0.5 / this.size);
    const iz = Math.floor((b.minZ + b.maxZ) * 0.5 / this.size);
    const key = `${ix},${iz}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { path: new Path2D(), minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
      this.tiles.set(key, t);
    } else {
      t.minX = Math.min(t.minX, b.minX);
      t.maxX = Math.max(t.maxX, b.maxX);
      t.minZ = Math.min(t.minZ, b.minZ);
      t.maxZ = Math.max(t.maxZ, b.maxZ);
    }
    return t.path;
  }

  ring(pts) {
    if (pts && pts.length > 4) addRing(this.pathFor(boundsOf(pts)), pts);
  }

  line(pts) {
    if (pts && pts.length > 2) addLine(this.pathFor(boundsOf(pts)), pts);
  }

  /** Calls fn(path) for every tile overlapping the view */
  each(v, fn) {
    for (const t of this.tiles.values()) {
      if (t.maxX < v.minX || t.minX > v.maxX || t.maxZ < v.minZ || t.minZ > v.maxZ) continue;
      fn(t.path);
    }
  }
}

// Roads by kind, drawn to their width (rounded to 2 m, one tiled layer per width): { width, layer }
function widthLayers(roads) {
  const byWidth = new Map();
  for (const r of roads) {
    const w = Math.max(2, Math.round((r.w || 6) / 2) * 2);
    if (!byWidth.has(w)) byWidth.set(w, new TiledLayer());
    byWidth.get(w).line(r.pts);
  }
  return [...byWidth].sort((a, b) => a[0] - b[0]).map(([width, layer]) => ({ width, layer }));
}

let LAYERS = null;
function mapLayers() {
  if (LAYERS) return LAYERS;
  const L = {};
  // Parks, woods, pitches, car parks and water
  L.areas = {};
  for (const kind of new Set(Object.values(GREEN))) L.areas[kind] = new TiledLayer();
  for (const a of GEO.areas) if (GREEN[a.kind]) L.areas[GREEN[a.kind]].ring(a.ring);
  // Rivers & streams (culverts run underground), the railway
  L.rivers = new TiledLayer();
  L.streams = new TiledLayer();
  for (const r of GEO.rivers) if (!r.culvert) (r.kind === 'river' ? L.rivers : L.streams).line(r.pts);
  L.rail = new TiledLayer();
  for (const r of GEO.rail) if (r.kind === 'rail') L.rail.line(r.pts);

  // Roads: footpaths, streets, main roads and highways on the ground, the elevated roads (the Expressway, flyovers)
  // over them
  const ground = GEO.roads.filter((r) => !r.bridge && !(r.layer > 0));
  const raised = GEO.roads.filter((r) => (r.bridge || r.layer > 0) && !FOOT.has(r.kind));
  L.paths = new TiledLayer();
  for (const r of ground) if (FOOT.has(r.kind)) L.paths.line(r.pts);
  L.minor = widthLayers(ground.filter((r) => MINOR.has(r.kind)));
  L.major = widthLayers(ground.filter((r) => MAJOR.has(r.kind)));
  L.highways = widthLayers(ground.filter((r) => HIGHWAY.has(r.kind)));
  L.bridges = widthLayers(raised);

  // Landmark buildings (outlined): the map's landmarks and the named towers
  const names = new Set(MAP_LANDMARKS.map((l) => l.name.toLowerCase()));
  L.landmarks = new Path2D();
  for (const b of GEO.buildings) if (b.name && (names.has(b.name.toLowerCase()) || b.h >= 90)) addRing(L.landmarks, b.ring);
  LAYERS = L;
  return L;
}

// Building footprints by height: up to 20 m, 60 m, taller
let FOOTPRINTS = null;
function footprintLayers() {
  if (FOOTPRINTS) return FOOTPRINTS;
  const tones = [new TiledLayer(), new TiledLayer(), new TiledLayer()];
  for (const b of GEO.buildings) tones[b.h > 60 ? 2 : b.h > 20 ? 1 : 0].ring(b.ring);
  FOOTPRINTS = { tones, version: 1 };
  return FOOTPRINTS;
}

// Street name labels: anchors every ~260 m along each straight run of a named road (fixed in the world, so labels
// never slide while the map pans), with the direction of the street there (never upside down: vertical names read
// upwards)
const ROAD_LABELS = [];
for (const r of GEO.roads) {
  if (!r.name || FOOT.has(r.kind) || r.kind === 'service') continue;
  const pts = r.pts;
  const n = pts.length >> 1;
  const anchors = [];
  for (let i = 0; i + 1 < n;) {
    // the straight run from point i: consecutive segments within ~5° of its first one
    const ax = pts[2 * i], az = pts[2 * i + 1];
    const dir = Math.atan2(pts[2 * i + 3] - az, pts[2 * i + 2] - ax);
    let j = i + 1;
    while (j + 1 < n) {
      const d = Math.atan2(pts[2 * j + 3] - pts[2 * j + 1], pts[2 * j + 2] - pts[2 * j]);
      let turn = Math.abs(d - dir);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn > 0.09) break;
      j++;
    }
    const cx = pts[2 * j], cz = pts[2 * j + 1];
    i = j;
    const len = Math.hypot(cx - ax, cz - az);
    if (len < 20) continue;
    let ang = Math.atan2(cz - az, cx - ax);
    if (ang >= Math.PI * 0.5 - 0.01) ang -= Math.PI;
    else if (ang < -Math.PI * 0.5 - 0.01) ang += Math.PI;
    const k = Math.max(1, Math.round(len / 260));
    for (let m = 0; m < k; m++) {
      const t = (m + 0.5) / k;
      anchors.push({ x: ax + (cx - ax) * t, z: az + (cz - az) * t, ang, len: len / k });
    }
  }
  if (!anchors.length) continue;
  ROAD_LABELS.push({
    text: r.name,
    lower: r.name.toLowerCase(),
    road: r,
    major: MAJOR.has(r.kind) || HIGHWAY.has(r.kind),
    highway: HIGHWAY.has(r.kind),
    anchors,
    ...boundsOf(r.pts)
  });
}
const ROAD_NAME_COUNT = new Set(ROAD_LABELS.map((l) => l.text)).size;

// ---------------------------------------------------------------------------------------------------------------------
// GPS: the shortest way along the road graph (one-way streets only one way when driving)
// ---------------------------------------------------------------------------------------------------------------------

let GRAPH = null;
function routeGraph() {
  if (GRAPH) return GRAPH;
  const { nodes, links } = GEO.roadGraph;
  const adj = nodes.map(() => []);
  for (const l of links) {
    let len = 0;
    for (let i = 2; i < l.pts.length; i += 2) len += Math.hypot(l.pts[i] - l.pts[i - 2], l.pts[i + 1] - l.pts[i - 1]);
    adj[l.a].push({ to: l.b, len, link: l, forward: true, against: false });
    adj[l.b].push({ to: l.a, len, link: l, forward: false, against: Boolean(l.oneway) });
  }
  // The main network: the largest connected part of the graph (the rest are short service roads and driveways that
  // OpenStreetMap leaves unconnected, inside compounds and car parks), which routes start and end on
  const part = new Int32Array(nodes.length).fill(-1);
  const sizes = [];
  for (let i = 0; i < nodes.length; i++) {
    if (part[i] >= 0 || !adj[i].length) continue;
    const stack = [i];
    part[i] = sizes.length;
    let size = 0;
    while (stack.length) {
      const n = stack.pop();
      size++;
      for (const e of adj[n]) if (part[e.to] < 0) (part[e.to] = sizes.length), stack.push(e.to);
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  GRAPH = { nodes, adj, onMain: (i) => part[i] === main };
  return GRAPH;
}

function nearestNode(x, z) {
  const { nodes, onMain } = routeGraph();
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    if (!onMain(i)) continue;
    const d = (nodes[i].x - x) ** 2 + (nodes[i].z - z) ** 2;
    if (d < bd) [best, bd] = [i, d];
  }
  return best;
}

// Route from node `from` to node `to` as flat world points, or null when there is none (Dijkstra, binary heap)
function findRoute(from, to, driving) {
  const { nodes, adj } = routeGraph();
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const via = new Array(nodes.length);
  const heap = [[0, from]];
  dist[from] = 0;
  const push = (item) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, n] = pop();
    if (n === to) break;
    if (d > dist[n]) continue;
    for (const e of adj[n]) {
      if (driving && e.against) continue;
      const nd = d + e.len;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        via[e.to] = e;
        push([nd, e.to]);
      }
    }
  }
  if (!Number.isFinite(dist[to])) return null;
  const legs = [];
  for (let n = to; n !== from;) {
    const e = via[n];
    legs.push(e);
    n = e.forward ? e.link.a : e.link.b;
  }
  const pts = [];
  for (let i = legs.length - 1; i >= 0; i--) {
    const { link, forward } = legs[i];
    const p = link.pts;
    if (forward) for (let k = 0; k < p.length; k += 2) pts.push(p[k], p[k + 1]);
    else for (let k = p.length - 2; k >= 0; k -= 2) pts.push(p[k], p[k + 1]);
  }
  return pts;
}

/** A map viewport: centre (cx, cz) in world metres, s pixels per metre, w x h CSS pixels on a canvas of pixel ratio dpr */
class MapView {
  constructor(cx, cz, s, w, h, dpr = 1) {
    this.cx = cx;
    this.cz = cz;
    this.s = s;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.minX = cx - w / (2 * s);
    this.maxX = cx + w / (2 * s);
    this.minZ = cz - h / (2 * s);
    this.maxZ = cz + h / (2 * s);
  }

  /** Canvas transform for world metres */
  world(ctx) {
    const { s, dpr } = this;
    ctx.setTransform(s * dpr, 0, 0, s * dpr, dpr * (this.w * 0.5 - this.cx * s), dpr * (this.h * 0.5 - this.cz * s));
  }

  /** Canvas transform for CSS pixels from the canvas centre (what toX / toY return) */
  screen(ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * this.w * 0.5, this.dpr * this.h * 0.5);
  }

  toX(x) {
    return (x - this.cx) * this.s;
  }

  toY(z) {
    return (z - this.cz) * this.s;
  }
}

// Player heading arrow at the (already rotated) origin: white, on a dark halo
function drawPlayerArrow(ctx, tipY, halfWidth, tailY) {
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(halfWidth, tailY);
  ctx.lineTo(0, tailY * 0.45);
  ctx.lineTo(-halfWidth, tailY);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = MAP.halo;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// GPS route through the screen points [x0, y0, x1, y1, ...]: PSV yellow on a dark casing
function drawRoute(ctx, pts, width) {
  if (pts.length < 4) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.strokeStyle = MAP.halo;
  ctx.lineWidth = width + 3;
  ctx.stroke();
  ctx.strokeStyle = MAP.route;
  ctx.lineWidth = width;
  ctx.stroke();
}

// Waypoint: a PSV-yellow target
function drawWaypoint(ctx, x, y, r) {
  ctx.fillStyle = MAP.halo;
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MAP.route;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MAP.halo;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.38, 0, Math.PI * 2);
  ctx.fill();
}

const overlaps = (boxes, b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

class NairobiMapSystem {
  constructor({ controllerManager, cameraSystem, trafficSystem, onTeleport, onToggle }) {
    this.controllerManager = controllerManager;
    this.cameraSystem = cameraSystem;
    this.trafficSystem = trafficSystem;
    this.onTeleport = onTeleport;
    this.onToggle = onToggle;

    this.miniCanvas = document.getElementById('minimap-canvas');
    this.miniCtx = this.miniCanvas ? this.miniCanvas.getContext('2d') : null;
    this.miniScale = RADAR_SCALE;
    this.miniCache = null; // { canvas, cx, cz, s, version }: the radar's ground layers, twice the radar's size
    const elCounts = document.getElementById('fullmap-counts');
    if (elCounts) elCounts.textContent = `${ROAD_NAME_COUNT} streets · ${GEO.buildings.length.toLocaleString('en-GB')} buildings`;

    this.modal = document.getElementById('fullmap-modal');
    this.fullCanvas = document.getElementById('fullmap-canvas');
    this.fullCanvasWrap = document.getElementById('fullmap-canvas-wrap');
    this.fullCtx = this.fullCanvas ? this.fullCanvas.getContext('2d') : null;
    this.fullDpr = 1;
    this.fullStatic = null; // the full map's ground layers & labels for the current view
    this.fullStaticKey = '';
    this.elHoverInfo = document.getElementById('fullmap-hover-info');
    this.elPlayerInfo = document.getElementById('fullmap-player-info');
    this.elSearchInput = document.getElementById('fullmap-search');
    if (this.elSearchInput) this.elSearchInput.placeholder = `Search ${ROAD_NAME_COUNT} streets & landmarks…`;

    this.isFullMapOpen = false;
    // Full map viewport state (world metres; zoom in CSS pixels per metre)
    this.viewCenterX = 0;
    this.viewCenterZ = 0;
    this.viewZoom = 0.6;
    this.isPanning = false;
    this.panPointerId = null;
    this.panStart = { x: 0, y: 0, cx: 0, cz: 0 };
    this.dragMoved = false;

    this.searchHighlight = '';
    this.searchPath = null;
    this.textWidths = new Map();
    // Start with a waypoint at KICC.
    const kicc = MAP_LANDMARKS.find((l) => l.short === 'KICC') || { x: 0, z: 0 };
    this.waypoint = { x: kicc.x, z: kicc.z, name: 'KICC' };
    this.route = null; // { from, to, driving, pts }: the GPS route, recomputed as the player moves
    this.nextRoute = 0;

    // Street names measured before the web font arrived would be spaced for the fallback font: measure & draw again
    if (document.fonts) {
      document.fonts.ready.then(() => {
        this.textWidths.clear();
        this.miniCache = null;
        this.fullStaticKey = '';
      });
    }

    this.initEvents();
  }

  initEvents() {
    const closeBtn = document.getElementById('close-fullmap-btn');
    const miniCard = document.getElementById('minimap-card');
    const zoomInBtn = document.getElementById('map-zoom-in');
    const zoomOutBtn = document.getElementById('map-zoom-out');
    const centerPlayerBtn = document.getElementById('map-center-player');
    const viewAllBtn = document.getElementById('map-view-all');

    if (miniCard) {
      miniCard.addEventListener('click', () => this.toggleFullMap(true));
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggleFullMap(false));
    }

    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        this.viewZoom = Math.min(MAX_ZOOM, this.viewZoom * 1.45);
        this.renderFullMap();
      });
    }
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        this.viewZoom = Math.max(MIN_ZOOM, this.viewZoom / 1.45);
        this.renderFullMap();
      });
    }
    if (centerPlayerBtn) {
      centerPlayerBtn.addEventListener('click', () => {
        const ent = this.controllerManager.getActiveEntity();
        this.viewCenterX = ent.position.x;
        this.viewCenterZ = ent.position.z;
        this.viewZoom = 1.2; // Street-by-street detail zoom
        this.renderFullMap();
      });
    }
    if (viewAllBtn) {
      viewAllBtn.addEventListener('click', () => {
        // Fits the whole detailed area, Upper Hill to Ngara
        const b = BOUNDS;
        const { w, h } = this.fullSize();
        this.viewCenterX = (b.minX + b.maxX) * 0.5;
        this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
        this.viewZoom = Math.max(MIN_ZOOM, Math.min(w / ((b.maxX - b.minX) * 1.08), h / ((b.maxZ - b.minZ) * 1.08)));
        this.renderFullMap();
      });
    }

    if (this.elSearchInput) {
      this.elSearchInput.addEventListener('input', () => this.search(this.elSearchInput.value));
    }

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.isFullMapOpen) {
        this.toggleFullMap(false);
      } else if (e.code === 'KeyM' && !isTypingInField(e)) {
        this.toggleFullMap(!this.isFullMapOpen);
      }
    });

    if (this.fullCanvas) {
      this.fullCanvas.style.touchAction = 'none';
      this.fullCanvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this.isFullMapOpen || this.panPointerId !== null) return;
        e.preventDefault();
        this.panPointerId = e.pointerId;
        this.fullCanvas.setPointerCapture(e.pointerId);
        this.isPanning = true;
        this.dragMoved = false;
        this.panStart.x = e.clientX;
        this.panStart.y = e.clientY;
        this.panStart.cx = this.viewCenterX;
        this.panStart.cz = this.viewCenterZ;
        if (this.fullCanvasWrap) this.fullCanvasWrap.classList.add('is-panning');
      });

      this.fullCanvas.addEventListener('pointermove', (e) => {
        if (!this.isFullMapOpen || !this.fullCanvas) return;
        if (this.isPanning ? e.pointerId !== this.panPointerId : e.pointerType !== 'mouse') return;
        const rect = this.fullCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (this.isPanning) {
          e.preventDefault();
          const dx = e.clientX - this.panStart.x;
          const dy = e.clientY - this.panStart.y;
          if (Math.hypot(dx, dy) > 5) this.dragMoved = true;
          this.viewCenterX = this.panStart.cx - dx / this.viewZoom;
          this.viewCenterZ = this.panStart.cz - dy / this.viewZoom;
          this.renderFullMap();
          return;
        }

        if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
          const wPos = this.screenToWorld(mx, my, rect.width, rect.height);
          if (this.elHoverInfo) {
            this.elHoverInfo.textContent = `${getLocationLabel(wPos.x, wPos.z)} · Click to teleport here`;
          }
        }
      });

      this.fullCanvas.addEventListener('pointerup', (e) => {
        if (e.pointerId !== this.panPointerId) return;
        const clicked = !this.dragMoved && Math.hypot(e.clientX - this.panStart.x, e.clientY - this.panStart.y) <= 5;
        this.cancelPan();
        if (clicked && this.isFullMapOpen && this.fullCanvas) {
          const rect = this.fullCanvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
            const wPos = this.clampToArea(this.screenToWorld(mx, my, rect.width, rect.height));
            this.waypoint = {
              x: wPos.x,
              z: wPos.z,
              name: getLocationLabel(wPos.x, wPos.z)
            };
            if (this.onTeleport) {
              this.onTeleport(wPos.x, wPos.z);
            }
            this.renderFullMap();
          }
        }
      });
      for (const type of ['pointercancel', 'lostpointercapture']) {
        this.fullCanvas.addEventListener(type, (e) => {
          if (e.pointerId === this.panPointerId) this.cancelPan();
        });
      }
      window.addEventListener('blur', () => this.cancelPan());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.cancelPan();
      });

      // Wheel zoom about the cursor (the place under it stays put)
      this.fullCanvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = this.fullCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const before = this.screenToWorld(mx, my, rect.width, rect.height);
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        this.viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.viewZoom * factor));
        this.viewCenterX = before.x - (mx - rect.width * 0.5) / this.viewZoom;
        this.viewCenterZ = before.z - (my - rect.height * 0.5) / this.viewZoom;
        this.renderFullMap();
      }, { passive: false });
    }
  }

  /**
   * Street / landmark search: highlights every stretch of the matching streets and frames them (or flies to the
   * matching landmark)
   */
  search(text) {
    const q = String(text || '').trim().toLowerCase();
    this.searchHighlight = q;
    this.searchPath = null;
    if (q.length > 0) {
      const lmMatch = MAP_LANDMARKS.find((l) => l.name.toLowerCase().includes(q) || l.short.toLowerCase().includes(q));
      const roads = ROAD_LABELS.filter((l) => l.lower.includes(q));
      if (roads.length) {
        this.searchPath = new Path2D();
        const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        for (const l of roads) {
          addLine(this.searchPath, l.road.pts);
          b.minX = Math.min(b.minX, l.minX);
          b.maxX = Math.max(b.maxX, l.maxX);
          b.minZ = Math.min(b.minZ, l.minZ);
          b.maxZ = Math.max(b.maxZ, l.maxZ);
        }
        this.searchBounds = b;
      }
      if (lmMatch) {
        this.viewCenterX = lmMatch.x;
        this.viewCenterZ = lmMatch.z;
        this.viewZoom = Math.max(this.viewZoom, 1.2);
      } else if (roads.length) {
        const b = this.searchBounds;
        const { w, h } = this.fullSize();
        this.viewCenterX = (b.minX + b.maxX) * 0.5;
        this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
        const fit = Math.min(w / ((b.maxX - b.minX) * 1.3 + 1), h / ((b.maxZ - b.minZ) * 1.3 + 1));
        this.viewZoom = Math.max(0.15, Math.min(1.6, fit));
      }
    }
    this.renderFullMap();
  }

  cancelPan() {
    const id = this.panPointerId;
    this.panPointerId = null;
    this.isPanning = false;
    if (this.fullCanvasWrap) this.fullCanvasWrap.classList.remove('is-panning');
    if (id !== null && this.fullCanvas && this.fullCanvas.hasPointerCapture(id)) this.fullCanvas.releasePointerCapture(id);
  }

  toggleFullMap(open) {
    this.isFullMapOpen = Boolean(open);
    if (!this.isFullMapOpen) this.cancelPan();
    if (this.onToggle) this.onToggle(this.isFullMapOpen);
    if (!this.modal) return;
    this.modal.classList.toggle('hidden', !this.isFullMapOpen);
    if (this.isFullMapOpen) {
      // the HUD's popovers live in the top layer, above the map
      for (const pop of document.querySelectorAll('.popover[popover]')) {
        if (typeof pop.hidePopover === 'function' && pop.matches(':popover-open')) pop.hidePopover();
      }
      const ent = this.controllerManager.getActiveEntity();
      this.viewCenterX = ent.position.x;
      this.viewCenterZ = ent.position.z;
      this.resizeFullCanvas();
      this.renderFullMap();
    }
  }

  resizeFullCanvas() {
    if (!this.fullCanvas) return;
    // Layout size (the opening animation's transforms don't change it), at most ~6 megapixels however large the screen
    const w = this.fullCanvas.clientWidth || window.innerWidth;
    const h = this.fullCanvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(6e6 / Math.max(1, w * h)));
    this.fullDpr = dpr;
    this.fullCanvas.width = Math.max(1, Math.floor(w * dpr));
    this.fullCanvas.height = Math.max(1, Math.floor(h * dpr));
  }

  // Full map size in CSS pixels
  fullSize() {
    const dpr = this.fullDpr || 1;
    if (!this.fullCanvas) return { w: 1200, h: 800 };
    return { w: this.fullCanvas.width / dpr, h: this.fullCanvas.height / dpr };
  }

  screenToWorld(sx, sy, width, height) {
    return {
      x: this.viewCenterX + (sx - width * 0.5) / this.viewZoom,
      z: this.viewCenterZ + (sy - height * 0.5) / this.viewZoom
    };
  }

  // Teleports land inside the detailed area (where the buildings and roads are)
  clampToArea(p) {
    return {
      x: Math.max(BOUNDS.minX + 40, Math.min(BOUNDS.maxX - 40, p.x)),
      z: Math.max(BOUNDS.minZ + 40, Math.min(BOUNDS.maxZ - 40, p.z))
    };
  }

  textWidth(ctx, text) {
    const key = `${ctx.font}|${ctx.letterSpacing || ''}|${text}`;
    let w = this.textWidths.get(key);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      this.textWidths.set(key, w);
    }
    return w;
  }

  // The GPS route from the player to the waypoint, as world points (recomputed at most twice a second, when the
  // nearest junction at either end changes)
  updateRoute() {
    if (!this.waypoint) {
      this.route = null;
      return;
    }
    const now = performance.now();
    if (now < this.nextRoute) return;
    this.nextRoute = now + 500;
    const ent = this.controllerManager.getActiveEntity();
    const from = nearestNode(ent.position.x, ent.position.z);
    const to = nearestNode(this.waypoint.x, this.waypoint.z);
    const driving = this.controllerManager.activeMode === 'car';
    const r = this.route;
    if (r && r.from === from && r.to === to && r.driving === driving && r.waypoint === this.waypoint) return;
    this.route = { from, to, driving, waypoint: this.waypoint, pts: findRoute(from, to, driving) };
  }

  // Screen points of the route in view v: the player, the route's junctions, the waypoint
  routePoints(v) {
    const ent = this.controllerManager.getActiveEntity();
    const out = [v.toX(ent.position.x), v.toY(ent.position.z)];
    const pts = this.route?.pts;
    if (pts) for (let i = 0; i < pts.length; i += 2) out.push(v.toX(pts[i]), v.toY(pts[i + 1]));
    out.push(v.toX(this.waypoint.x), v.toY(this.waypoint.z));
    return out;
  }

  /**
   * The ground: the detailed area, parks & water, rivers, the railway, roads, building footprints, landmark outlines,
   * the elevated roads and the search highlight (world transform of view v)
   */
  drawWorld(ctx, v, isMinimap) {
    const L = mapLayers();
    const s = v.s;
    const px = (n) => n / s; // screen pixels -> metres (line widths)
    v.world(ctx);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 1. The detailed area
    ctx.fillStyle = MAP.land;
    ctx.fillRect(BOUNDS.minX, BOUNDS.minZ, BOUNDS.maxX - BOUNDS.minX, BOUNDS.maxZ - BOUNDS.minZ);
    if (!isMinimap) {
      ctx.strokeStyle = MAP.landEdge;
      ctx.lineWidth = px(1.4);
      ctx.strokeRect(BOUNDS.minX, BOUNDS.minZ, BOUNDS.maxX - BOUNDS.minX, BOUNDS.maxZ - BOUNDS.minZ);
    }

    // 2. Parks, woods, pitches, car parks and water
    for (const kind of ['parking', 'park', 'wood', 'pitch']) {
      ctx.fillStyle = MAP[kind];
      L.areas[kind].each(v, (p) => ctx.fill(p));
    }
    if (s >= 0.1) {
      ctx.strokeStyle = MAP.parkEdge;
      ctx.lineWidth = px(1);
      L.areas.park.each(v, (p) => ctx.stroke(p));
    }
    ctx.fillStyle = MAP.water;
    L.areas.water.each(v, (p) => ctx.fill(p));
    ctx.strokeStyle = MAP.waterEdge;
    ctx.lineWidth = px(1);
    L.areas.water.each(v, (p) => ctx.stroke(p));

    // 3. Rivers & streams, the railway
    ctx.strokeStyle = MAP.river;
    ctx.lineWidth = Math.max(px(1.6), 9);
    L.rivers.each(v, (p) => ctx.stroke(p));
    ctx.lineWidth = Math.max(px(1), 3.5);
    L.streams.each(v, (p) => ctx.stroke(p));
    ctx.strokeStyle = MAP.rail;
    ctx.lineWidth = Math.max(px(1.4), 3.4);
    ctx.setLineDash([px(6), px(4)]);
    L.rail.each(v, (p) => ctx.stroke(p));
    ctx.setLineDash([]);

    // 4. Footpaths (close up), then the streets, main roads and highways to their width
    if (s >= 0.5) {
      ctx.strokeStyle = MAP.path;
      ctx.lineWidth = Math.max(px(1), 2);
      L.paths.each(v, (p) => ctx.stroke(p));
    }
    const roads = (layers, color, minPx) => {
      ctx.strokeStyle = color;
      for (const { width, layer } of layers) {
        ctx.lineWidth = Math.max(px(minPx), width);
        layer.each(v, (p) => ctx.stroke(p));
      }
    };
    if (s >= 0.12) roads(L.minor, MAP.streets, 1);
    roads(L.major, MAP.mainRoads, s < 0.12 ? 1.1 : 1.5);
    roads(L.highways, MAP.highway, isMinimap ? 2.4 : 1.8);

    // 5. Building footprints, lowest first
    if (s >= 0.18) {
      const fp = footprintLayers();
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = MAP.buildings[i];
        fp.tones[i].each(v, (p) => ctx.fill(p));
      }
      if (s >= 0.6) {
        ctx.strokeStyle = MAP.buildingEdge;
        ctx.lineWidth = px(0.8);
        for (let i = 0; i < 3; i++) fp.tones[i].each(v, (p) => ctx.stroke(p));
      }
    }

    // 6. Landmark buildings
    if (s >= 0.12) {
      ctx.fillStyle = MAP.landmarkFill;
      ctx.fill(L.landmarks);
      ctx.strokeStyle = MAP.landmarkEdge;
      ctx.lineWidth = px(Math.max(0.9, Math.min(1.6, 1.4 * s)));
      ctx.stroke(L.landmarks);
    }

    // 7. Elevated roads over everything: the Expressway, the flyovers and footbridges' roads
    ctx.lineCap = 'butt';
    roads(L.bridges, MAP.bridge, isMinimap ? 2.4 : 1.8);
    ctx.lineCap = 'round';

    // 8. Search highlight: every stretch of the matching streets
    if (this.searchPath && !isMinimap) {
      ctx.strokeStyle = MAP.search;
      ctx.lineWidth = Math.max(px(3), 9);
      ctx.stroke(this.searchPath);
    }
  }

  /**
   * Street names along the streets (screen transform of view v): the best anchor of each street that fits its name,
   * one label per street per `sameNameGap` pixels, none overlapping another (or the boxes already in `placed`)
   */
  drawRoadLabels(ctx, v, { fontPx = 10, maxLabels = 400, sameNameGap = 260, placed = [], majorOnly = false } = {}) {
    const s = v.s;
    const q = this.searchHighlight;
    ctx.font = `600 ${fontPx}px ${FONT}`;
    const inset = (fontPx * 2.5) / s;
    const minX = v.minX + inset;
    const maxX = v.maxX - inset;
    const minZ = v.minZ + inset;
    const maxZ = v.maxZ - inset;
    const cands = [];
    for (const l of ROAD_LABELS) {
      if (l.maxX < minX || l.minX > maxX || l.maxZ < minZ || l.minZ > maxZ) continue;
      const hit = q.length > 0 && l.lower.includes(q);
      if (majorOnly && !l.major && !hit) continue;
      const width = this.textWidth(ctx, l.text);
      const need = (width + 14) / s;
      for (const a of l.anchors) {
        if (a.len < need || a.x < minX || a.x > maxX || a.z < minZ || a.z > maxZ) continue;
        const d = Math.hypot(a.x - v.cx, a.z - v.cz) * s;
        cands.push({ l, a, width, hit, score: (hit ? 1e6 : 0) + (l.highway ? 3000 : 0) + (l.major ? 2000 : 0) + Math.min(a.len * s, 400) - d * 0.5 });
      }
    }
    cands.sort((a, b) => b.score - a.score);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    const byName = new Map();
    let n = 0;
    for (const c of cands) {
      if (n >= maxLabels) break;
      const X = v.toX(c.a.x);
      const Y = v.toY(c.a.z);
      const same = byName.get(c.l.text);
      if (same && same.some(([x, y]) => Math.hypot(x - X, y - Y) < sameNameGap)) continue;
      const hw = c.width * 0.5 + 3;
      const hh = fontPx * 0.5 + 2;
      const ca = Math.abs(Math.cos(c.a.ang));
      const sa = Math.abs(Math.sin(c.a.ang));
      const bx = hw * ca + hh * sa;
      const by = hw * sa + hh * ca;
      const box = [X - bx, Y - by, X + bx, Y + by];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      if (same) same.push([X, Y]);
      else byName.set(c.l.text, [[X, Y]]);
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(c.a.ang);
      ctx.fillStyle = c.hit ? MAP.search : c.l.highway ? '#e3a857' : c.l.major ? '#e8ebf0' : '#9ba5b3';
      ctx.strokeText(c.l.text, 0, 0);
      ctx.fillText(c.l.text, 0, 0);
      ctx.restore();
      n++;
    }
    ctx.textBaseline = 'alphabetic';
  }

  update() {
    this.updateRoute();
    // The full map covers the whole screen, radar included
    if (this.isFullMapOpen) {
      this.renderFullMap();
    } else {
      this.renderMinimap();
    }
  }

  // =========================================================================
  // 1. LIVE MINIMAP (BOTTOM-LEFT HUD)
  // =========================================================================
  renderMinimap() {
    if (!this.miniCtx || !this.miniCanvas) return;
    // Nothing to draw while the radar is hidden (narrow screens, clean view)
    if (!this.miniCanvas.offsetParent || document.body.classList.contains('hud-minimized')) return;
    const ctx = this.miniCtx;
    // Radar size in CSS pixels, backed at the device pixel ratio (crisp street names on HiDPI screens)
    const w = this.miniCanvas.clientWidth;
    const h = this.miniCanvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.miniCanvas.width !== bw || this.miniCanvas.height !== bh) {
      this.miniCanvas.width = bw;
      this.miniCanvas.height = bh;
      this.miniCache = null;
    }

    const ent = this.controllerManager.getActiveEntity();
    const px = ent.position.x;
    const pz = ent.position.z;
    // Ground-level radar shows ~800 m of the city; it zooms out as the player climbs (helicopter), from the height
    // over the terrain's lowest point
    const target = Math.max(0.05, RADAR_SCALE / (1 + Math.max(0, ent.position.y - 25) / 180));
    this.miniScale += (target - this.miniScale) * 0.08;
    const scale = this.miniScale;

    // Ground layers & street names come from a cached render twice the radar's size, redrawn when the player nears its
    // edge or the zoom drifts
    let c = this.miniCache;
    if (!c || Math.abs(scale / c.s - 1) > 0.12 ||
      Math.abs(px - c.cx) > w / c.s - w / (2 * scale) - 8 / scale ||
      Math.abs(pz - c.cz) > h / c.s - h / (2 * scale) - 8 / scale) {
      if (!c) {
        c = this.miniCache = { canvas: document.createElement('canvas') };
        c.canvas.width = bw * 2;
        c.canvas.height = bh * 2;
        c.ctx = c.canvas.getContext('2d');
      }
      c.cx = px;
      c.cz = pz;
      c.s = scale;
      c.ctx.setTransform(1, 0, 0, 1, 0, 0);
      c.ctx.fillStyle = MAP.outside;
      c.ctx.fillRect(0, 0, bw * 2, bh * 2);
      const cv = new MapView(px, pz, scale, w * 2, h * 2, dpr);
      this.drawWorld(c.ctx, cv, true);
      cv.screen(c.ctx);
      this.drawRoadLabels(c.ctx, cv, { fontPx: 9.5, maxLabels: 28, sameNameGap: 180 });
    }

    const v = new MapView(px, pz, scale, w, h, dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP.outside;
    ctx.fillRect(0, 0, bw, bh);
    const k = scale / c.s;
    ctx.drawImage(c.canvas, dpr * ((c.cx - w / c.s - px) * scale + w * 0.5), dpr * ((c.cz - h / c.s - pz) * scale + h * 0.5),
      dpr * w * 2 * k, dpr * h * 2 * k);

    v.screen(ctx);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    // Live moving traffic blips on radar: every other car and matatu, the buses
    if (this.trafficSystem) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.34)';
      const blip = (car) => {
        if (!car.edge) return;
        const cx = toX(car.x);
        const cy = toY(car.z);
        if (Math.abs(cx) < w * 0.5 && Math.abs(cy) < h * 0.5) ctx.fillRect(cx - 1, cy - 1, 2, 2);
      };
      for (let i = 0; i < this.trafficSystem.cars.length; i += 2) blip(this.trafficSystem.cars[i]);
      for (const bus of this.trafficSystem.buses) blip(bus);
    }

    // GPS route to the active waypoint
    if (this.waypoint) {
      drawRoute(ctx, this.routePoints(v), 3);
      drawWaypoint(ctx, toX(this.waypoint.x), toY(this.waypoint.z), 4.5);
    }

    // Landmark blips
    for (const lm of MAP_LANDMARKS) {
      const lx = toX(lm.x);
      const ly = toY(lm.z);
      if (Math.abs(lx) < w * 0.48 && Math.abs(ly) < h * 0.48) {
        ctx.fillStyle = MAP.halo;
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(lx, ly, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Camera FOV Cone & Player Arrow at center (0, 0)
    const camDir = this.cameraSystem.currentLookAt.clone().sub(this.cameraSystem.currentPos);
    const camAngle = Math.atan2(camDir.x, camDir.z);

    ctx.save();
    ctx.rotate(-camAngle + Math.PI);
    const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 58);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 58, -Math.PI * 0.72, -Math.PI * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Player heading arrow
    ctx.save();
    ctx.rotate(-ent.heading + Math.PI);
    drawPlayerArrow(ctx, -9, 6.5, 7);
    ctx.restore();

    ctx.restore();
  }

  // =========================================================================
  // 2. FULL-SCREEN NAIROBI STREET ATLAS ([M])
  // =========================================================================
  renderFullMap() {
    if (!this.fullCtx || !this.fullCanvas || !this.isFullMapOpen) return;
    const ctx = this.fullCtx;
    const dpr = this.fullDpr || 1;
    const { w, h } = this.fullSize();
    const v = new MapView(this.viewCenterX, this.viewCenterZ, this.viewZoom, w, h, dpr);

    const ent = this.controllerManager.getActiveEntity();
    if (this.elPlayerInfo) {
      const text = `You are at ${getLocationLabel(ent.position.x, ent.position.z)}`;
      if (text !== this.playerInfoText) {
        this.playerInfoText = text;
        this.elPlayerInfo.textContent = text;
      }
    }

    // Ground layers, names & landmark pins: re-rendered only when the view or the search change
    const key = `${v.cx}|${v.cz}|${v.s}|${this.fullCanvas.width}|${this.fullCanvas.height}|${this.searchHighlight}`;
    if (!this.fullStatic) this.fullStatic = document.createElement('canvas');
    if (key !== this.fullStaticKey) {
      this.fullStaticKey = key;
      const sc = this.fullStatic;
      if (sc.width !== this.fullCanvas.width || sc.height !== this.fullCanvas.height) {
        sc.width = this.fullCanvas.width;
        sc.height = this.fullCanvas.height;
      }
      this.renderFullMapStatic(sc.getContext('2d'), v);
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.fullStatic, 0, 0);
    v.screen(ctx);

    // GPS route on the full map
    if (this.waypoint) {
      drawRoute(ctx, this.routePoints(v), 4);
      drawWaypoint(ctx, v.toX(this.waypoint.x), v.toY(this.waypoint.z), 7);
    }

    // Live Player Blip & Heading Arrow, with a slow pulse to find it at a glance
    const px = v.toX(ent.position.x);
    const py = v.toY(ent.position.z);

    ctx.save();
    ctx.translate(px, py);
    const pulse = (performance.now() % 1800) / 1800;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.24 * (1 - pulse)})`;
    ctx.beginPath();
    ctx.arc(0, 0, 10 + pulse * 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(-ent.heading + Math.PI);
    drawPlayerArrow(ctx, -11, 7.5, 8);
    ctx.restore();

    ctx.restore();
  }

  renderFullMapStatic(ctx, v) {
    const { w, h, s } = v;
    ctx.save();
    // 1. The hills beyond the detailed area
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP.outside;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // 2. The ground: parks & water, rivers, the railway, roads, footprints, the Expressway
    this.drawWorld(ctx, v, false);

    v.screen(ctx);
    const toX = (wx) => v.toX(wx);
    const toY = (wz) => v.toY(wz);

    // 3. Landmark Pins & Collision-Free Labels (placed first: their boxes keep the other names clear)
    ctx.font = `700 11px ${FONT}`;
    const placed = [];
    const pins = [];
    for (const lm of MAP_LANDMARKS) {
      const lx = toX(lm.x);
      const ly = toY(lm.z);
      if (Math.abs(lx) > w * 0.48 || Math.abs(ly) > h * 0.48) continue;
      const labelW = this.textWidth(ctx, lm.short) + 6;
      const box = [lx + 6, ly - 8, lx + 8 + labelW, ly + 7];
      const showLabel = !overlaps(placed, box);
      placed.push([lx - 6, ly - 6, lx + 6, ly + 6]);
      if (showLabel) placed.push(box);
      pins.push({ lm, lx, ly, showLabel });
    }

    // 4. Neighbourhood and park watermark titles (wherever they fit), letter-spaced like a printed atlas
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tracking = 'letterSpacing' in ctx;
    const watermark = (label, x, z, font, color, spacing) => {
      const dx = toX(x);
      const dy = toY(z);
      if (Math.abs(dx) > w * 0.47 || Math.abs(dy) > h * 0.47) return;
      ctx.font = font;
      ctx.fillStyle = color;
      if (tracking) ctx.letterSpacing = spacing;
      const half = this.textWidth(ctx, label) * 0.5 + 4;
      const box = [dx - half, dy - 8, dx + half, dy + 8];
      if (overlaps(placed, box)) return;
      placed.push(box);
      ctx.fillText(label, dx, dy);
    };
    if (s < 1.2) for (const [label, x, z] of AREA_LABELS) watermark(label, x, z, `700 10.5px ${FONT}`, 'rgba(168, 178, 192, 0.46)', '1.8px');
    if (s >= 0.25) for (const [label, x, z] of PARK_LABELS) watermark(label, x, z, `italic 600 11px ${FONT}`, 'rgba(128, 190, 142, 0.6)', '0.5px');
    if (tracking) ctx.letterSpacing = '0px';
    ctx.textBaseline = 'alphabetic';

    // 5. Street names along their real course (collision-free at all zoom levels)
    const fontPx = Math.max(9, Math.min(12, Math.round(9.5 * Math.sqrt(Math.max(s, 0.4)))));
    this.drawRoadLabels(ctx, v, { fontPx, maxLabels: 420, sameNameGap: 300, placed, majorOnly: s < 0.45 });

    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    for (const { lm, lx, ly, showLabel } of pins) {
      ctx.fillStyle = MAP.halo;
      ctx.beginPath();
      ctx.arc(lx, ly, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
      ctx.fill();
      if (showLabel) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = MAP.halo;
        ctx.strokeText(lm.short, lx + 9, ly + 4);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(lm.short, lx + 9, ly + 4);
      }
    }

    // 6. Scale bar (true metres); the compass sits with the map controls (index.html)
    this.drawScaleBar(ctx, v);
    ctx.restore();
  }

  drawScaleBar(ctx, v) {
    const target = 120 / v.s; // metres in ~120 px
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const step = [1, 2, 5, 10].map((m) => m * pow).filter((m) => m <= target).pop() || pow;
    const len = step * v.s;
    const x0 = -v.w * 0.5 + 24;
    const y0 = v.h * 0.5 - 26;
    const label = step >= 1000 ? `${step / 1000} km` : `${step} m`;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 6);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + len, y0);
    ctx.lineTo(x0 + len, y0 - 6);
    ctx.strokeStyle = MAP.halo;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(236, 239, 244, 0.92)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `650 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    ctx.strokeText(label, x0 + len + 8, y0 + 3);
    ctx.fillStyle = 'rgba(236, 239, 244, 0.95)';
    ctx.fillText(label, x0 + len + 8, y0 + 3);
  }
}

export { NairobiMapSystem };
