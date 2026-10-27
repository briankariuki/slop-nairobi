import * as THREE from 'three/webgpu';
import { GEO } from './nairobi-geodata.js';
import { terrainGridNormals } from './terrain.js';

// The ground: GEO.terrain's 25 m height grid as one mesh, with what lies flat on it (parks, water, rivers, rail and
// the footprints of buildings) painted onto a map texture draped over it, so they follow the slopes exactly. The
// streets are geometry of their own on top (streets.js), and bridges.js builds the decks in 3D.

const T = GEO.terrain;
const W = (T.nx - 1) * T.cell; // terrain extent, m
const H = (T.nz - 1) * T.cell;
const TEX_W = 4096;
const TEX_H = Math.round((TEX_W * H) / W);


const AREA_FILL = {
  parking: '#8d8a84',
  grass: '#86a95f',
  recreation_ground: '#86a95f',
  park: '#7aa257',
  garden: '#7aa257',
  cemetery: '#7f9768',
  pitch: '#6c9e4b',
  stadium: '#8f9483',
  wood: '#5a7d40',
  forest: '#5a7d40',
  scrub: '#6e8a4a',
  grassland: '#8eab62',
  water: '#4b7fa6'
};
// drawn in this order, so small detailed areas end up on top of the big ones they sit in
const AREA_ORDER = ['parking', 'cemetery', 'grassland', 'grass', 'recreation_ground', 'park', 'scrub', 'wood', 'forest', 'garden', 'stadium', 'pitch', 'water'];

function paintMap() {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const g = canvas.getContext('2d');
  const s = TEX_W / W;
  // world (x, z) → canvas px; canvas row 0 is the terrain's north edge (z0)
  g.setTransform(s, 0, 0, s, -T.x0 * s, -T.z0 * s);
  const trace = (path, f, close) => {
    path.moveTo(f[0], f[1]);
    for (let i = 2; i < f.length; i += 2) path.lineTo(f[i], f[i + 1]);
    if (close) path.closePath();
  };
  const line = (f, width, color, dash) => {
    g.beginPath();
    trace(g, f, false);
    g.lineWidth = width;
    g.strokeStyle = color;
    g.setLineDash(dash || []);
    g.stroke();
  };

  g.fillStyle = '#b7ab92'; // dusty urban ground
  g.fillRect(T.x0, T.z0, W, H);
  g.lineCap = 'round';
  g.lineJoin = 'round';

  const areas = GEO.areas.filter((a) => AREA_FILL[a.kind]).sort((a, b) => AREA_ORDER.indexOf(a.kind) - AREA_ORDER.indexOf(b.kind));
  for (const a of areas) {
    const p = new Path2D();
    trace(p, a.ring, true);
    for (const hole of a.holes || []) trace(p, hole, true);
    g.fillStyle = AREA_FILL[a.kind];
    g.fill(p, 'evenodd');
  }
  // building footprints: slightly darker ground where a wall meets it
  g.fillStyle = '#9c917c';
  for (const b of GEO.buildings) {
    if (b.part || b.minH) continue;
    g.beginPath();
    trace(g, b.ring, true);
    g.fill();
  }
  for (const r of GEO.rivers) if (!r.culvert) line(r.pts, r.kind === 'river' ? 9 : 3.5, '#4b7fa6');
  for (const r of GEO.rail) {
    if (r.kind === 'platform') line(r.pts, 4, '#a39d92');
    else {
      line(r.pts, 3.4, '#6f665c');
      line(r.pts, 1.6, '#3d3934', [0.6, 0.9]);
    }
  }

  return canvas;
}

export function buildGround(renderer) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(T.nx * T.nz * 3);
  const uv = new Float32Array(T.nx * T.nz * 2);
  for (let j = 0; j < T.nz; j++) {
    for (let i = 0; i < T.nx; i++) {
      const k = j * T.nx + i;
      pos.set([T.x0 + i * T.cell, T.heights[k], T.z0 + j * T.cell], k * 3);
      uv.set([i / (T.nx - 1), 1 - j / (T.nz - 1)], k * 2);
    }
  }
  const index = [];
  for (let j = 0; j < T.nz - 1; j++) {
    for (let i = 0; i < T.nx - 1; i++) {
      const a = j * T.nx + i;
      const b = a + 1;
      const c = a + T.nx;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  // the same normals the streets lying on it shade with (terrain.js)
  geo.setAttribute('normal', new THREE.BufferAttribute(terrainGridNormals(), 3));

  const map = new THREE.CanvasTexture(paintMap());
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = renderer.getMaxAnisotropy ? renderer.getMaxAnisotropy() : 8;
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, roughness: 0.95 }));
  mesh.name = 'ground';
  return mesh;
}
