import { GEO } from './nairobi-geodata.js';

// Ground height (m, relative to KICC's ground) anywhere in the world frame, bilinear over GEO.terrain's grid and clamped
// at its edges. Buildings stand on their footprint's lowest point: baseOf(ring) gives it for a flat [x0, z0, ...] ring.
const T = GEO.terrain;

export function heightAt(x, z) {
  const fx = Math.min(T.nx - 1, Math.max(0, (x - T.x0) / T.cell));
  const fz = Math.min(T.nz - 1, Math.max(0, (z - T.z0) / T.cell));
  const i = Math.min(T.nx - 2, Math.floor(fx));
  const j = Math.min(T.nz - 2, Math.floor(fz));
  const u = fx - i;
  const v = fz - j;
  const h = (a, b) => T.heights[(j + b) * T.nx + i + a];
  return (h(0, 0) * (1 - u) + h(1, 0) * u) * (1 - v) + (h(0, 1) * (1 - u) + h(1, 1) * u) * v;
}

export function baseOf(ring) {
  let lo = Infinity;
  for (let k = 0; k < ring.length; k += 2) lo = Math.min(lo, heightAt(ring[k], ring[k + 1]));
  return lo;
}
