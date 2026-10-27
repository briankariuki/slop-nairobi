import * as THREE from 'three/webgpu';
import { uniform, mix, smoothstep, positionWorldDirection } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';

// Time-of-day presets for the HUD's time switch: Slop New York's four (golden hour, midday, blue hour, night): a
// hemisphere light (sky and dusty ground bounce), the sun (or the moon) with its shadows, a gradient sky that the fog
// fades into, and the shared uniforms the facades, glass, windows and headlamps read (tsl-materials.js cityUniforms).
// New York's physical sky and sky-baked environment lighting are still to come.
//
// Shadows: one shadow map that follows the camera's focus (New York's two-cascade SunLight compiles and renders its
// atlas on this three.js commit but shades nothing here), SHADOW_MAP px over a square 2 × SHADOW_REACH m across at
// street level (about 7 cm a texel), widening as the camera climbs, its centre snapped to the texel grid so the shadows
// don't shimmer as the camera moves.
//
// Nairobi is 1.3° south of the equator: the sun rises in the east and sets in the west at much the same time all year
// (about 06:30 and 18:45), passing almost overhead at noon. World frame: x = east, y = up, z = south.

const SHADOW_MAP = 4096;
const SHADOW_REACH = 150; // m from the focus the shadow map covers at street level
const SHADOW_DISTANCE = 600; // m the light stands off the focus along its rays
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();

const TIME_PRESETS = {
  golden: {
    id: 'golden',
    sunDir: new THREE.Vector3(-0.9, 0.3, 0.16).normalize(), // low in the west, an hour before sunset
    sunColor: 0xffc48c,
    sunIntensity: 2.5,
    hemiSky: 0x9fb8da,
    hemiGround: 0xb5865e,
    hemiIntensity: 1.15,
    skyTop: 0x3c6ca6,
    skyHorizon: 0xf0d0aa,
    fog: [900, 6500],
    exposure: 1.0,
    interiorGlow: 0.48
  },
  midday: {
    id: 'midday',
    sunDir: new THREE.Vector3(900, 2200, -600).normalize(),
    sunColor: 0xfff4e0,
    sunIntensity: 2.6,
    hemiSky: 0xcfe3f5,
    hemiGround: 0x9a8a6c,
    hemiIntensity: 1.4,
    skyTop: 0x4f88c6,
    skyHorizon: 0xb4d1ec,
    fog: [1200, 7000],
    exposure: 1.0,
    interiorGlow: 0.24
  },
  twilight: {
    id: 'twilight',
    sunDir: new THREE.Vector3(-0.96, 0.08, 0.12).normalize(), // just set: what is left lights the sky in the west
    sunColor: 0xff9a6e,
    sunIntensity: 0.7,
    hemiSky: 0x5a74aa,
    hemiGround: 0x4c3e42,
    hemiIntensity: 0.8,
    skyTop: 0x15275a,
    skyHorizon: 0xc27a6c,
    fog: [700, 5000],
    exposure: 1.05,
    interiorGlow: 1.25
  },
  midnight: {
    id: 'midnight',
    sunDir: new THREE.Vector3(0.42, 0.68, -0.6).normalize(), // the moon
    sunColor: 0x8cb0e8,
    sunIntensity: 0.5,
    hemiSky: 0x2a3c66,
    hemiGround: 0x2b2630,
    hemiIntensity: 0.5,
    skyTop: 0x050a16,
    skyHorizon: 0x172338,
    fog: [500, 4000],
    exposure: 1.1,
    interiorGlow: 1.55
  }
};

class LightingSystem {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.activePresetId = null;

    // The sky: the horizon colour (the fog's) up to the zenith's, most of the change in the lowest 30°
    this.uSkyTop = uniform(new THREE.Color());
    this.uSkyHorizon = uniform(new THREE.Color());
    scene.backgroundNode = mix(this.uSkyHorizon, this.uSkyTop, smoothstep(-0.02, 0.5, positionWorldDirection.y));
    scene.fog = new THREE.Fog(0xffffff, 1200, 7000);

    this.hemiLight = new THREE.HemisphereLight();
    scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = SHADOW_DISTANCE + 1200; // the tallest towers upwind of the sun, and the valleys
    this.sunLight.shadow.normalBias = 0.06; // no acne along the surface, so kerbs, cars and people keep contact shadows
    this.sunLight.shadow.bias = -0.0002;
    scene.add(this.sunLight, this.sunLight.target);
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.focus = new THREE.Vector3();

    this.applyPreset('midday');
  }

  // Move the shadow map with the camera: a sharp square at street level, a wider one from the air, centred ahead of
  // the camera along its view (on what it is looking at, not on it)
  update(camera) {
    const altitude = camera ? Math.max(0, camera.position.y - (camera.groundY || 0)) : 0;
    const reach = Math.min(SHADOW_REACH * 3, SHADOW_REACH + altitude * 1.2);
    if (camera) {
      camera.getWorldDirection(_dir);
      this.focus.copy(camera.position).addScaledVector(_dir, reach * 0.55);
    }
    // the light's basis: right and up across its rays, to snap the focus to the texel grid in the map's own plane
    const d = this.sunDir;
    const right = _right.set(d.z, 0, -d.x).normalize();
    const up = _up.crossVectors(right, d).normalize();
    const texel = (2 * reach) / SHADOW_MAP;
    const f = this.focus;
    const r = Math.round(f.dot(right) / texel) * texel;
    const u = Math.round(f.dot(up) / texel) * texel;
    const along = f.dot(d);
    f.copy(right).multiplyScalar(r).addScaledVector(up, u).addScaledVector(d, along);
    this.sunLight.target.position.copy(f);
    this.sunLight.position.copy(f).addScaledVector(d, SHADOW_DISTANCE);
    const c = this.sunLight.shadow.camera;
    if (c.right !== reach) {
      c.left = c.bottom = -reach;
      c.right = c.top = reach;
      c.updateProjectionMatrix();
    }
  }

  applyPreset(presetId) {
    const p = TIME_PRESETS[presetId] || TIME_PRESETS.midday;
    this.activePresetId = p.id;
    this.sunLight.color.setHex(p.sunColor);
    this.sunLight.intensity = p.sunIntensity;
    this.sunDir.copy(p.sunDir);
    this.update(null);
    cityUniforms.uSunColor.value.setHex(p.sunColor);
    cityUniforms.uSunDir.value.copy(p.sunDir);
    cityUniforms.uSkyTopColor.value.setHex(p.skyTop);
    cityUniforms.uSkyHorizonColor.value.setHex(p.skyHorizon);
    cityUniforms.uInteriorGlow.value = p.interiorGlow;
    this.hemiLight.color.setHex(p.hemiSky);
    this.hemiLight.groundColor.setHex(p.hemiGround);
    this.hemiLight.intensity = p.hemiIntensity;
    this.uSkyTop.value.setHex(p.skyTop);
    this.uSkyHorizon.value.setHex(p.skyHorizon);
    this.scene.fog.color.setHex(p.skyHorizon);
    [this.scene.fog.near, this.scene.fog.far] = p.fog;
    this.renderer.toneMappingExposure = p.exposure;
  }
}

export { LightingSystem, TIME_PRESETS };
