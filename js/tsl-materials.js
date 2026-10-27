import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, color, uniform, uv, attribute, varying, abs, floor, fract, sin, dot, min, max, clamp, mix,
  step, smoothstep, length, fwidth, normalize, reflect, pow, positionGeometry, positionWorld, positionView, normalView,
  normalWorldGeometry, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, screenSize
} from 'three/tsl';

// Pieces of Slop New York's tsl-materials.js (MIT, © 2026 Mr.doob): the shared time-of-day uniforms its vehicle
// materials read, the soft contact shadow under each vehicle, and the street surfaces (asphalt, road paint, sidewalk
// paving, kerbs) with the noise, bump and anti-aliased line helpers they use. New York's wet roads (puddles, the rain
// film, screen-space reflections) and its street-canyon sky occlusion are left out: Nairobi's streets are dry.

// Shared live uniforms controlled by the lighting / time-of-day presets (lighting.js): the sun's colour and direction,
// the sky's colours (what glass reflects) and how brightly windows and headlamps are lit (0.24 at midday: off)
const cityUniforms = {
  uSunColor: uniform(new THREE.Color(0xfff4e0)),
  uSunDir: uniform(new THREE.Vector3(0.37, 0.9, -0.25)),
  uSkyTopColor: uniform(new THREE.Color(0x4f88c6)),
  uSkyHorizonColor: uniform(new THREE.Color(0xb4d1ec)),
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

// Box-filtered periodic pulse: fraction of a footprint `w` wide around `x` where fract() lies in [a, b]. Exact
// anti-aliasing that settles to the mean coverage (b - a) once a period shrinks below a pixel, so facade grids don't
// shimmer at distance or grazing angles. Pass the in-cell coordinate (fract) for precision.
const filteredPulse = Fn(([x, a, b, w]) => {
  const p = float(x).toVar();
  const lo = float(a).toVar();
  const hi = float(b).toVar();
  const hw = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(hi.sub(lo)).add(clamp(fract(t), lo, hi).sub(lo));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
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
    // faint wear stains and tar seams (New York's are bolder) and a little dust in broad patches
    const oilyStain = smoothstep(0.6, 0.9, noise2D(vec2(wx.mul(0.42), wz.mul(0.42)))).mul(detail);
    const tarSeam = float(1.0).sub(smoothstep(0.0, 0.03, abs(patchNoise.sub(0.52)))).mul(0.14).mul(detail);
    const dust = smoothstep(0.55, 0.9, noise2D(vec2(wx.mul(0.06), wz.mul(0.06)))).mul(0.06);

    const baseAsphalt = mix(cAsphaltDark, cAsphaltLight, fineGrain.mul(0.36).add(microAggregate.mul(0.22)).add(patchNoise.mul(0.12).add(0.07)))
      .mul(float(1.0).sub(oilyStain.mul(0.1)))
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

/**
 * Building facades (buildings.js): windows on a grid of bays and storeys, with a taller shopfront ground floor, drawn
 * from each wall's own frame (`wuv`: metres along it and up it; `wall`: its width, height, style and seed; `dims`: the
 * building's storey height and bay width; `tint`: its colour). Styles (buildings.js STYLE): painted render with punched
 * windows and sills, concrete offices with piers and ribbon windows between floor bands, glass curtain walls with
 * mullions and spandrels, roofs, and plain walls. Glass mirrors the sky and the sun (as light of its own, so panes in
 * shade still show the sky); at night (cityUniforms.uInteriorGlow)
 * a share of the windows light up warm. Windows are recessed with bumpNormal; grids are box-filtered so they settle to
 * their mean at distance instead of shimmering.
 */
function createFacadeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.85 });
  const tint = attribute('tint', 'vec3');
  const wuv = attribute('wuv', 'vec2');
  const wall = attribute('wall', 'vec4');
  const dims = attribute('dims', 'vec2');
  const cWarmLight = color(0xffe1a6);
  const cGlassDark = color(0x26323d);

  const kind = wall.z;
  const is = (k) => step(k - 0.5, kind).mul(float(1.0).sub(step(k + 0.5, kind)));
  const isRender = is(0);
  const isConcrete = is(1);
  const isRoof = is(3);
  const isPlain = is(4);
  const isRibbon = is(5);
  const isFins = is(6);
  const isGlass = max(is(2), isFins); // the finned towers are glass between their fins
  const wallW = wall.x;
  const wallH = wall.y;
  const seed = wall.w;
  const floorH = dims.x;
  const bayW0 = dims.y;
  const s = wuv.x;
  const v = wuv.y;

  // Bays: a whole number along each wall, between corner piers (wider on the concrete offices, none on glass or
  // ribbon windows)
  const pier = mix(mix(float(0.45), min(float(1.2), wallW.mul(0.15)), isConcrete), float(0.0), max(isGlass, isRibbon));
  const inner = max(wallW.sub(pier.mul(2.0)), 0.5);
  const bays = max(floor(inner.div(bayW0).add(0.5)), 1.0);
  const bayW = inner.div(bays);
  const gridU = s.sub(pier).div(bayW).add(seed);
  const inPier = float(1.0).sub(step(pier, s).mul(step(s, wallW.sub(pier))));
  // Storeys: the ground floor a shopfront, a metre taller than the rest
  const groundH = floorH.add(1.0);
  const gridV = v.lessThan(groundH).select(v.div(groundH), v.sub(groundH).div(floorH).add(1.0));
  const floorIdx = floor(gridV);
  const isGround = float(1.0).sub(step(1.0, gridV));
  const cellId = vec2(floor(gridU), floorIdx);
  const cellUV = vec2(fract(gridU), fract(gridV));
  const fw = vec2(fwidth(gridU), fwidth(gridV));
  // No windows in the parapet (the top 0.8 m), in a storey the wall cuts short, in the piers, or on plain walls
  const top = wallH.sub(0.8);
  const floorTop = floorIdx.lessThan(1.0).select(groundH, groundH.add(floorIdx.mul(floorH)));
  const solid = max(max(step(top, v), step(top.add(0.01), floorTop)), max(inPier.mul(float(1.0).sub(isGround)), isPlain));

  // The window in its cell, by style (x0, x1, y0, y1 of the cell), the shopfront on the ground floor: punched windows
  // in render, wide ones between the concrete piers, panes between mullions (or fins) on glass, and continuous strips
  // between the ribbon bands
  const wx0 = mix(mix(mix(float(0.28), float(0.1), isConcrete), float(0.04), isGlass), float(0.0), isRibbon).add(isFins.mul(0.1));
  const wx1 = mix(float(1.0).sub(wx0), float(1.0), isRibbon);
  const wy0 = mix(mix(mix(float(0.24), float(0.3), isConcrete), float(0.3), isGlass), float(0.4), isRibbon);
  const wy1 = mix(mix(mix(float(0.78), float(0.84), isConcrete), float(0.95), isGlass), float(0.85), isRibbon);
  const gx0 = mix(float(0.08), float(0.04), isGlass), gx1 = float(1.0).sub(gx0);
  const x0 = mix(wx0, gx0, isGround), x1 = mix(wx1, gx1, isGround);
  const y0 = mix(wy0, float(0.08), isGround), y1 = mix(wy1, float(0.86), isGround);
  // (the ribbon's strip runs on through the bays, broken only by a slim mullion)
  const ribbonMullion = filteredPulse(cellUV.x, 0.0, 0.03, fw.x).mul(isRibbon);
  const windowMask = filteredPulse(cellUV.x, x0, x1, fw.x).mul(filteredPulse(cellUV.y, y0, y1, fw.y))
    .mul(float(1.0).sub(ribbonMullion)).mul(float(1.0).sub(solid)).mul(float(1.0).sub(isRoof));

  // Lit windows at night: a share of the apartments and offices, the shops more often
  const litProb = mix(float(0.3), float(0.6), isGround);
  const lit = step(float(1.0).sub(litProb), hash2D(cellId.add(vec2(seed.mul(0.37), 5.1))));
  const warmth = hash2D(cellId.add(vec2(2.3, seed)));

  // The glass's reflection of the sky (the time of day's colours, lighting.js) and of the sun: light of its own
  // (emissiveNode), not lit colour, since a pane in shade still mirrors the bright sky; how much of it, by the angle
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const reflectDir = reflect(viewDir.negate(), normalWorldGeometry);
  const fresnel = pow(clamp(float(1.0).sub(abs(dot(viewDir, normalWorldGeometry))), 0.0, 1.0), 2.0);
  const reflectance = fresnel.mul(0.7).add(0.15);
  const skyReflect = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, clamp(reflectDir.y.mul(1.2).add(0.2), 0.0, 1.0));
  const sunSpec = pow(max(dot(reflectDir, normalize(cityUniforms.uSunDir)), 0.0), 40.0).mul(0.6);

  mat.colorNode = Fn(() => {
    // glass: the building's tint on the curtain walls, dark glazing on the others, less of it the more it reflects
    const paneBase = mix(mix(cGlassDark, tint.mul(mix(float(0.8), float(1.05), isFins)), isGlass), color(0x4f6c82), isRibbon);
    const glass = paneBase.mul(float(1.0).sub(reflectance.mul(0.5)));
    const shopGlass = mix(cGlassDark.mul(1.3), cWarmLight.mul(0.35), lit.mul(0.5));
    const pane = mix(glass, shopGlass, isGround.mul(float(1.0).sub(isGlass)));

    // walls: the tint, weathered (streaks of grime from the sills and the rain, darker at the foot), floor bands on the
    // concrete offices, spandrels and mullions on the glass
    const streak = noise2D(vec2(s.mul(1.1).add(seed), v.mul(0.07))).mul(noise2D(vec2(s.mul(0.3), v.mul(0.5)))).mul(0.3);
    const foot = float(1.0).sub(smoothstep(0.0, 1.2, v)).mul(0.12);
    const band = filteredPulse(cellUV.y, 0.0, 0.05, fw.y).mul(isConcrete).mul(0.18);
    const sill = filteredPulse(cellUV.x, wx0.sub(0.03), wx1.add(0.03), fw.x).mul(filteredPulse(cellUV.y, wy0.sub(0.05), wy0, fw.y)).mul(isRender).mul(float(1.0).sub(isGround)).mul(0.1);
    const mullion = max(filteredPulse(cellUV.x, 0.0, 0.04, fw.x), filteredPulse(cellUV.y, 0.0, 0.3, fw.y)).mul(isGlass);
    const frame = tint.mul(0.3);
    let surface = tint.mul(float(1.0).sub(streak).sub(foot).sub(band).add(sill));
    surface = mix(surface, mix(tint.mul(0.5), frame, step(0.5, mullion)), isGlass);
    // the fins and spandrels of the finned towers are pale concrete, whatever the glass's tint
    const fin = filteredPulse(cellUV.x, 0.0, 0.14, fw.x).mul(isFins);
    surface = mix(surface, color(0xe2e2dc).mul(float(1.0).sub(streak.mul(0.5))), max(fin, isFins.mul(float(1.0).sub(step(0.5, mullion))).mul(0.9)));
    // the ribbon bands: the concrete, lightly weathered, with a shadow line under each strip of windows
    const bandShade = filteredPulse(cellUV.y, 0.85, 0.9, fw.y).mul(0.15).add(filteredPulse(cellUV.y, 0.36, 0.4, fw.y).mul(0.08));
    surface = mix(surface, tint.mul(float(1.0).sub(streak.mul(0.6)).sub(foot).sub(bandShade)), isRibbon);
    const plain = tint.mul(0.92).mul(float(1.0).sub(foot));
    surface = mix(surface, plain, isPlain);

    // roofs: grey concrete and gravel, weathered
    const roofNoise = noise2D(positionWorld.xz.mul(0.35));
    const roof = mix(color(0x6d6a64), color(0x8c8984), roofNoise).mul(noise2D(positionWorld.xz.mul(6.0)).mul(0.12).add(0.94));

    return mix(mix(surface, pane, windowMask), roof, isRoof);
  })();

  mat.roughnessNode = mix(mix(float(0.86), float(0.14), windowMask), float(0.92), isRoof);
  // (barely metallic: with no environment map to reflect, metal goes black in shade; the reflection is the emissive's)
  mat.metalnessNode = windowMask.mul(0.08);

  // Recessed windows (and raised mullions), fading with distance and when the grid is under a few pixels
  mat.normalNode = Fn(() => {
    const camDist = length(positionWorld.sub(cameraPosition));
    const fade = float(1.0).sub(smoothstep(20.0, 160.0, camDist)).mul(float(1.0).sub(smoothstep(0.03, 0.1, max(fw.x, fw.y)))).mul(float(1.0).sub(isRoof));
    const ramp = fw.mul(2.0).max(0.02);
    const recess = filteredPulse(cellUV.x, x0.add(0.01), x1.sub(0.01), ramp.x).mul(filteredPulse(cellUV.y, y0.add(0.01), y1.sub(0.01), ramp.y)).mul(float(1.0).sub(solid));
    return bumpNormal(recess.mul(mix(float(-0.05), float(0.012), isGlass)).mul(fade));
  })();

  mat.emissiveNode = Fn(() => {
    const transmission = float(1.0).sub(fresnel.mul(0.7));
    const glow = mix(cWarmLight, color(0xd8e6ff), step(0.8, warmth)).mul(mix(float(0.45), float(1.0), warmth));
    const lights = glow.mul(lit).mul(transmission).mul(smoothstep(0.3, 1.2, cityUniforms.uInteriorGlow)).mul(0.9);
    // the sky and sun mirrored in the panes (not the shops' windows, which show their insides)
    const mirror = skyReflect.mul(reflectance).mul(0.55).add(cityUniforms.uSunColor.mul(sunSpec)).mul(float(1.0).sub(isGround.mul(float(1.0).sub(isGlass))));
    return lights.add(mirror).mul(windowMask);
  })();
  return mat;
}

export {
  cityUniforms, hash2D, noise2D, bumpNormal, gridLine, filteredPulse,
  createContactShadowMaterial, createRoadSurfaceMaterial, createRoadPaintMaterial, createSidewalkMaterial, createCurbMaterial,
  createFacadeMaterial
};
