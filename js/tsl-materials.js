import * as THREE from 'three/webgpu';
import { Fn, vec2, color, uniform, uv, abs, min, max, clamp, smoothstep, length } from 'three/tsl';

// The two pieces of Slop New York's tsl-materials.js (MIT, © 2026 Mr.doob) the traffic needs so far: the shared
// time-of-day uniforms its vehicle materials read, and the soft contact shadow under each vehicle. The rest of that
// file (facades, roads, water, the wet-road reflections the shadow also masked) is New York's own.

// Shared live uniforms controlled by lighting / time-of-day presets. Nairobi has no time of day yet: a bright midday
// (uInteriorGlow 0.24 keeps headlamps off).
const cityUniforms = {
  uSunColor: uniform(new THREE.Color(0xfff4e0)),
  uInteriorGlow: uniform(0.24)
};

function createContactShadowMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false
  });

  const shadowOpacity = Fn(() => {
    const uvCentered = uv().sub(vec2(0.5, 0.5)).mul(2.0);
    const p = abs(uvCentered);
    // Rounded-box SDF in normalized [-1, 1]^2 quad coords with smooth falloff to 0 before quad edges
    const q = p.sub(vec2(0.64, 0.7));
    const d = length(max(q, vec2(0.0, 0.0))).add(min(max(q.x, q.y), 0.0));
    const chassisAO = smoothstep(0.3, -0.14, d);
    const coreAO = smoothstep(0.76, 0.12, p.x).mul(smoothstep(0.82, 0.16, p.y));
    // Extra contact darkening directly under the 4 tires
    const wheelPatch = smoothstep(0.22, 0.0, length(p.sub(vec2(0.68, 0.56)).mul(vec2(1.4, 1.0))));
    return clamp(chassisAO.mul(0.72).add(coreAO.mul(0.18)).add(wheelPatch.mul(0.18)), 0.0, 0.88);
  })();

  mat.colorNode = Fn(() => color(0x020305))();
  mat.opacityNode = shadowOpacity;
  return mat;
}

export { cityUniforms, createContactShadowMaterial };
