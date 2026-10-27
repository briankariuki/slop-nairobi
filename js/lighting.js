import * as THREE from 'three/webgpu';
import { uniform, mix, smoothstep, positionWorldDirection } from 'three/tsl';

// Time-of-day presets for the HUD's time switch: Slop New York's four (golden hour, midday, blue hour, night), lighting
// Nairobi the way it is lit now, with a hemisphere light (sky and dusty ground bounce), the sun (or the moon) and a
// gradient sky that the fog fades into. New York's physical sky, cascaded sun shadows and sky-baked environment
// lighting come with the rest of its looks (ROADMAP.md, Phase 5).
//
// Nairobi is 1.3° south of the equator: the sun rises in the east and sets in the west at much the same time all year
// (about 06:30 and 18:45), passing almost overhead at noon. World frame: x = east, y = up, z = south.

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
    exposure: 1.0
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
    exposure: 1.0
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
    exposure: 1.05
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
    exposure: 1.1
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
    this.sunLight = new THREE.DirectionalLight();
    scene.add(this.sunLight);

    this.applyPreset('midday');
  }

  applyPreset(presetId) {
    const p = TIME_PRESETS[presetId] || TIME_PRESETS.midday;
    this.activePresetId = p.id;
    this.sunLight.color.setHex(p.sunColor);
    this.sunLight.intensity = p.sunIntensity;
    this.sunLight.position.copy(p.sunDir).multiplyScalar(2500);
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
