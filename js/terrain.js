import { GEO } from './nairobi-geodata.js';

// Ground height (m, relative to KICC's ground) anywhere in the world frame, clamped at GEO.terrain's edges. It follows
// the terrain mesh's own triangles (ground.js): each 25 m cell is split along its diagonal from (i + 1, j) to (i, j + 1),
// so anything laid on the ground (the streets, streets.js) sits exactly on what is drawn, and so do the wheels and feet
// that sample it. Buildings stand on their footprint's lowest point: baseOf(ring) gives it for a flat [x0, z0, ...] ring.
const T = GEO.terrain;

export function heightAt(x, z) {
  const fx = Math.min(T.nx - 1, Math.max(0, (x - T.x0) / T.cell));
  const fz = Math.min(T.nz - 1, Math.max(0, (z - T.z0) / T.cell));
  const i = Math.min(T.nx - 2, Math.floor(fx));
  const j = Math.min(T.nz - 2, Math.floor(fz));
  const u = fx - i;
  const v = fz - j;
  const h = (a, b) => T.heights[(j + b) * T.nx + i + a];
  if (u + v <= 1) return h(0, 0) + (h(1, 0) - h(0, 0)) * u + (h(0, 1) - h(0, 0)) * v;
  return h(1, 1) + (h(0, 1) - h(1, 1)) * (1 - u) + (h(1, 0) - h(1, 1)) * (1 - v);
}

// The terrain's smooth normal at (x, z) into `out` ([x, y, z]): the grid's central-difference normals (the terrain mesh's
// vertex normals, ground.js), blended bilinearly, so what lies on the ground shades just like it
let gridNormals = null;
function normals() {
  if (gridNormals) return gridNormals;
  gridNormals = new Float32Array(T.nx * T.nz * 3);
  const h = (i, j) => T.heights[Math.min(T.nz - 1, Math.max(0, j)) * T.nx + Math.min(T.nx - 1, Math.max(0, i))];
  for (let j = 0; j < T.nz; j++) {
    for (let i = 0; i < T.nx; i++) {
      const gx = (h(i + 1, j) - h(i - 1, j)) / ((Math.min(T.nx - 1, i + 1) - Math.max(0, i - 1)) * T.cell);
      const gz = (h(i, j + 1) - h(i, j - 1)) / ((Math.min(T.nz - 1, j + 1) - Math.max(0, j - 1)) * T.cell);
      const l = Math.hypot(gx, 1, gz);
      gridNormals.set([-gx / l, 1 / l, -gz / l], (j * T.nx + i) * 3);
    }
  }
  return gridNormals;
}
export function terrainNormal(x, z, out = [0, 1, 0]) {
  const N = normals();
  const fx = Math.min(T.nx - 1, Math.max(0, (x - T.x0) / T.cell));
  const fz = Math.min(T.nz - 1, Math.max(0, (z - T.z0) / T.cell));
  const i = Math.min(T.nx - 2, Math.floor(fx));
  const j = Math.min(T.nz - 2, Math.floor(fz));
  const u = fx - i;
  const v = fz - j;
  const k = (a, b) => ((j + b) * T.nx + i + a) * 3;
  let l = 0;
  for (let c = 0; c < 3; c++) {
    out[c] = (N[k(0, 0) + c] * (1 - u) + N[k(1, 0) + c] * u) * (1 - v) + (N[k(0, 1) + c] * (1 - u) + N[k(1, 1) + c] * u) * v;
    l += out[c] * out[c];
  }
  l = Math.sqrt(l);
  for (let c = 0; c < 3; c++) out[c] /= l;
  return out;
}
export { normals as terrainGridNormals };

export function baseOf(ring) {
  let lo = Infinity;
  for (let k = 0; k < ring.length; k += 2) lo = Math.min(lo, heightAt(ring[k], ring[k + 1]));
  return lo;
}
