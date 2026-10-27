import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, color, uniform, uv, attribute, varying, abs, floor, fract, sin, dot, min, max, clamp, mix,
  step, smoothstep, length, fwidth, positionGeometry, positionWorld, positionView, normalView, cameraPosition,
  cameraProjectionMatrix, cameraViewMatrix, screenSize
} from 'three/tsl';

// Pieces of Slop New York's tsl-materials.js (MIT, © 2026 Mr.doob): the shared time-of-day uniforms its vehicle
// materials read, the soft contact shadow under each vehicle, and the street surfaces (asphalt, road paint, sidewalk
// paving, kerbs) with the noise, bump and anti-aliased line helpers they use. New York's wet roads (puddles, the rain
// film, screen-space reflections) and its street-canyon sky occlusion are left out: Nairobi's streets are dry.

// Shared live uniforms controlled by lighting / time-of-day presets. Nairobi has no time of day yet: a bright midday
// (uInteriorGlow 0.24 keeps headlamps off).
const cityUniforms = {
  uSunColor: uniform(new THREE.Color(0xfff4e0)),
  uInteriorGlow: uniform(0.24)
};

// Fast deterministic 2D -> 1D hash in TSL
const hash2D = Fn(([p]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
});

// Smooth 2D value noise in TSL
const noise2D = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash2D(i);
  const b = hash2D(i.add(vec2(1.0, 0.0)));
  const c = hash2D(i.add(vec2(0.0, 1.0)));
  const d = hash2D(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// Surface-gradient bump mapping from a height (Mikkelsen), wrapped in Fn() so `height` is evaluated once before dFdx/dFdy
const bumpNormal = Fn(([height]) => {
  const h = float(height).toVar();
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(h.dFdx().mul(r1).add(h.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
});

// Filter-width anti-aliased repeating grid line
const gridLine = Fn(([coord, period, halfWidth]) => {
  const p = float(period).toVar();
  const g = float(coord).div(p).toVar();
  const d = float(0.5).sub(abs(fract(g).sub(0.5))).toVar();
  const aa = fwidth(g).max(0.0001).toVar();
  const hw = float(halfWidth).div(p).toVar();
  const effHw = max(hw, aa.mul(0.5)).toVar();
  const cov = smoothstep(effHw.add(aa), effHw.sub(aa), d);
  return cov.mul(min(float(1.0), hw.div(effHw)));
});

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

// The streets sit a few centimetres over the terrain: pull them forward in depth too, so they never flicker through it
function lift(mat, units = -4) {
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = units;
  return mat;
}

/**
 * Roadway asphalt: two-scale aggregate grit, patchwork pours, oily wear and tar seams, and manhole covers, with
 * footprint-filtered aggregate relief (New York's createRoadSurfaceMaterial, dry, a little paler and dustier)
 */
function createRoadSurfaceMaterial() {
  const mat = lift(new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.9 }));
  const cAsphaltDark = color(0x34332f);
  const cAsphaltLight = color(0x53514b);
  const cManhole = color(0x4a433c);
  // World size of a pixel: fine texture settles to its mean before it can alias at grazing angles or from the air
  const pixelSize = length(fwidth(positionWorld.xz));

  mat.colorNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const camDist = length(positionWorld.sub(cameraPosition));
    const detail = smoothstep(240.0, 22.0, camDist);

    const microAggregate = mix(float(0.5), noise2D(vec2(wx.mul(16.0), wz.mul(16.0))), smoothstep(0.06, 0.02, pixelSize));
    const fineGrain = mix(float(0.5), noise2D(vec2(wx.mul(3.2), wz.mul(3.2))), smoothstep(0.4, 0.12, pixelSize));
    const patchNoise = noise2D(vec2(wx.mul(0.18), wz.mul(0.18)));
    const oilyStain = smoothstep(0.52, 0.84, noise2D(vec2(wx.mul(0.42), wz.mul(0.42)))).mul(detail);
    const tarSeam = float(1.0).sub(smoothstep(0.0, 0.04, abs(patchNoise.sub(0.52)))).mul(0.42).mul(detail);
    // dust settling towards the kerbs and in the quiet corners: a pale wash in broad patches
    const dust = smoothstep(0.45, 0.85, noise2D(vec2(wx.mul(0.06), wz.mul(0.06)))).mul(0.12);

    const baseAsphalt = mix(cAsphaltDark, cAsphaltLight, fineGrain.mul(0.36).add(microAggregate.mul(0.22)).add(patchNoise.mul(0.26)))
      .mul(float(1.0).sub(oilyStain.mul(0.28)))
      .mul(float(1.0).sub(tarSeam))
      .add(dust.mul(vec3(0.62, 0.56, 0.46)));

    // Manhole covers, one 14 m cell in three
    const mhCell = floor(vec2(wx, wz).div(14.0));
    const mhCentre = mhCell.add(vec2(hash2D(mhCell.add(13.7)), hash2D(mhCell.add(29.1))).mul(0.6).add(0.2)).mul(14.0);
    const mhDist = length(vec2(wx, wz).sub(mhCentre));
    const isManhole = float(1.0).sub(smoothstep(0.52, 0.6, mhDist)).mul(step(0.66, hash2D(mhCell))).mul(detail);
    const mhRings = sin(mhDist.mul(36.0)).mul(0.15).add(0.85);
    return mix(baseAsphalt, cManhole.mul(mhRings), isManhole);
  })();

  mat.roughnessNode = mix(float(0.86), noise2D(positionWorld.xz.mul(12.0)).mul(0.08).add(0.86), smoothstep(0.08, 0.03, pixelSize));

  mat.normalNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const coarseFade = smoothstep(0.08, 0.025, pixelSize);
    const fineFade = smoothstep(0.02, 0.006, pixelSize);
    const coarseGrit = noise2D(vec2(wx.mul(8.5), wz.mul(8.5))).sub(0.5).mul(0.0032).mul(coarseFade);
    const fineGrit = noise2D(vec2(wx.mul(36.0), wz.mul(36.0))).sub(0.5).mul(0.0016).mul(fineFade);
    return bumpNormal(coarseGrit.add(fineGrit));
  })();
  return mat;
}

/**
 * Road markings (road-paint.js): vertex-coloured strips whose `paint` attribute holds (metres along the strip, pattern
 * period, duty cycle) and `side` the offset from the strip's centre line. Strips thinner than ~1.5 px are widened on
 * screen and faded to match, and dashes are box-filtered, so distant markings fade out smoothly instead of breaking up
 * and flickering. Worn. (New York's createRoadPaintMaterial, dry.)
 */
function createRoadPaintMaterial() {
  const mat = lift(new THREE.MeshStandardNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, metalness: 0.0 }), -8);

  const paint = attribute('paint', 'vec3');
  const side = attribute('side', 'vec2');
  const sideOffset = vec3(side.x, 0.0, side.y);

  // How much to widen the strip so it is at least 1.5 px wide on screen (1 when it already is)
  const widen = Fn(() => {
    const viewProjection = cameraProjectionMatrix.mul(cameraViewMatrix);
    const edge = viewProjection.mul(vec4(positionGeometry, 1.0));
    const centre = viewProjection.mul(vec4(positionGeometry.sub(sideOffset), 1.0));
    const halfWidthPx = length(edge.xy.div(edge.w).sub(centre.xy.div(centre.w)).mul(screenSize).mul(0.5));
    const inFront = step(0.05, min(edge.w, centre.w));
    return clamp(float(0.75).div(max(halfWidthPx, 0.001)), 1.0, 16.0).mul(inFront).max(1.0);
  })();
  mat.positionNode = positionGeometry.add(sideOffset.mul(widen.sub(1.0)));

  // Exact box filter of the dashes (on for `duty` of each period) over the pixel footprint
  const t = paint.x.div(paint.y);
  const footprint = max(fwidth(t), 0.0001);
  const duty = paint.z;
  const onSoFar = (x) => floor(x).mul(duty).add(clamp(fract(x).sub(float(1.0).sub(duty).mul(0.5)), 0.0, duty));
  const dashes = onSoFar(t.add(footprint.mul(0.5))).sub(onSoFar(t.sub(footprint.mul(0.5)))).div(footprint);

  const xz = positionWorld.xz;
  const detail = smoothstep(70.0, 15.0, length(positionWorld.sub(cameraPosition)));
  const wear = mix(float(0.5), noise2D(xz.mul(0.8)).mul(0.6).add(noise2D(xz.mul(2.3)).mul(0.4)), detail);
  mat.opacityNode = dashes.mul(varying(float(1.0).div(widen))).mul(smoothstep(0.1, 0.6, wear).mul(0.4).add(0.55));
  mat.roughnessNode = float(0.62);
  return mat;
}

/**
 * Sidewalk paving: concrete flags 0.6 m square with scored, anti-aliased joints and grooved relief, per-flag tone, and
 * the odd darker patch where flags have been relaid (New York's createSidewalkMaterial, dry, Nairobi's smaller flags in
 * grey concrete). `tone` picks the paving: 0 the sidewalks, 1 the paler footpaths.
 */
function createSidewalkMaterial(tone = 0) {
  const mat = lift(new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.88 }));
  const cConcreteA = color(tone ? 0xb0a792 : 0x9c9c98);
  const cConcreteB = color(tone ? 0x958c78 : 0x7e7e7b);
  const panel = 0.6;
  const pixelSize = length(fwidth(positionWorld.xz));

  mat.colorNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const detail = smoothstep(190.0, 16.0, length(positionWorld.sub(cameraPosition)));
    const panelHash = hash2D(floor(vec2(wx.div(panel), wz.div(panel))));
    const shade = noise2D(vec2(wx.mul(0.48), wz.mul(0.48)));
    const relaid = step(0.82, noise2D(vec2(wx.mul(0.11), wz.mul(0.11)).add(31.7))).mul(0.12);
    const grit = noise2D(vec2(wx.mul(14.0), wz.mul(14.0))).sub(0.5).mul(0.08).mul(detail).mul(smoothstep(0.07, 0.02, pixelSize));
    const joints = max(gridLine(wx, panel, 0.02), gridLine(wz, panel, 0.02)).mul(detail);
    return mix(cConcreteB, cConcreteA, shade)
      .mul(panelHash.sub(0.5).mul(0.16).add(1.0))
      .mul(float(1.0).sub(relaid))
      .add(grit)
      .mul(float(1.0).sub(joints.mul(0.4)));
  })();

  mat.roughnessNode = Fn(() => float(0.9).sub(hash2D(floor(vec2(positionWorld.x.div(panel), positionWorld.z.div(panel)))).mul(0.06)))();

  mat.normalNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const detail = smoothstep(140.0, 14.0, length(positionWorld.sub(cameraPosition)));
    const joints = max(gridLine(wx, panel, 0.02), gridLine(wz, panel, 0.02));
    const grain = noise2D(vec2(wx.mul(4.5), wz.mul(4.5))).sub(0.5).mul(0.003);
    return bumpNormal(grain.sub(joints.mul(0.008)).mul(detail));
  })();
  return mat;
}

/**
 * Concrete kerbstones: 1 m units with joints, the road-facing face grimier than the top (New York's createCurbMaterial
 * in Nairobi's pale precast concrete)
 */
function createCurbMaterial() {
  const mat = lift(new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.8 }));
  mat.colorNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const detail = smoothstep(180.0, 16.0, length(positionWorld.sub(cameraPosition)));
    const tone = noise2D(vec2(wx.mul(0.6), wz.mul(0.6)));
    const speckle = noise2D(vec2(wx.mul(18.0), wz.mul(18.0))).sub(0.5).mul(0.06).mul(detail);
    const stone = mix(color(0x8a867c), color(0xa39e92), tone).add(speckle);
    const joints = max(gridLine(wx, 1.0, 0.012), gridLine(wz, 1.0, 0.012)).mul(detail);
    return stone.mul(float(1.0).sub(joints.mul(0.35)));
  })();
  mat.normalNode = Fn(() => {
    const wx = positionWorld.x;
    const wz = positionWorld.z;
    const detail = smoothstep(120.0, 12.0, length(positionWorld.sub(cameraPosition)));
    return bumpNormal(noise2D(vec2(wx.mul(5.5), wz.mul(5.5))).sub(0.5).mul(0.0022).mul(detail));
  })();
  return mat;
}

export {
  cityUniforms, hash2D, noise2D, bumpNormal, gridLine,
  createContactShadowMaterial, createRoadSurfaceMaterial, createRoadPaintMaterial, createSidewalkMaterial, createCurbMaterial
};
