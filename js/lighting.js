import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  vec4,
  uniform,
  mix,
  fog,
  pmremTexture,
  positionWorld,
  cameraPosition,
  length,
  normalize,
  max,
  exp,
  abs,
  select
} from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';
import { cityUniforms } from './tsl-materials.js';

// Slop New York's lighting.js (MIT, © 2026 Mr.doob), as Slop Singapore runs it on the same three.js commit: the
// physical Preetham sky with clouds, baked by PMREMGenerator into scene.environment (the light every surface takes from
// the sky, and what glass and metal reflect), the two-cascade SunLight, a hemisphere fill, and sky-matched aerial haze.
// The presets are New York's, the sun where it is over Nairobi: 1.3° south of the equator it rises in the east and sets
// in the west at much the same time all year, passing almost overhead at noon. World frame: x = east, y = up, z = south.
//
// scene.background stays null: SkyMesh is the sky. A background (colour or node) makes the renderer clear before each
// render, the shadow cascades' included, so the second cascade's render would wipe the first.

const TIME_PRESETS = {
  golden: {
    id: 'golden',
    sunDir: new THREE.Vector3(-0.78, 0.5, 0.25).normalize(), // in the west, an hour and a half before sunset
    sunColor: 0xffca92,
    sunIntensity: 5.8,
    hemiSky: 0x9abbe6,
    hemiGround: 0xc88a62, // warm bounce off the dusty ground and the cream and ochre walls
    hemiIntensity: 1.48,
    skyTop: 0x2c568c,
    skyHorizon: 0xebd1b5,
    fogColor: 0xdcc5ae,
    fogDensity: 0.00024,
    interiorGlow: 0.48,
    roadWetness: 0.0,
    envIntensity: 0.54,
    canyonBounce: 0.52,
    turbidity: 8.0,
    rayleigh: 2.8,
    mieCoefficient: 0.008,
    mieDirectionalG: 0.88,
    cloudCoverage: 0.36,
    cloudDensity: 0.38,
    skyExposure: 0.148,
    nightFactor: 0.0
  },
  midday: {
    id: 'midday',
    sunDir: new THREE.Vector3(0.3, 0.92, 0.22).normalize(), // high, a little north-east of overhead after noon
    sunColor: 0xfff5e8,
    sunIntensity: 6.6,
    hemiSky: 0xaad2ff,
    hemiGround: 0xb89678,
    hemiIntensity: 1.58,
    skyTop: 0x225ea8,
    skyHorizon: 0xc8dff5,
    fogColor: 0xc6dcf2,
    fogDensity: 0.00018,
    interiorGlow: 0.24,
    roadWetness: 0.0,
    envIntensity: 0.58,
    canyonBounce: 0.58,
    turbidity: 6.5,
    rayleigh: 2.4,
    mieCoefficient: 0.006,
    mieDirectionalG: 0.86,
    cloudCoverage: 0.32,
    cloudDensity: 0.35,
    skyExposure: 0.142,
    nightFactor: 0.0
  },
  twilight: {
    id: 'twilight',
    sunDir: new THREE.Vector3(-0.86, 0.34, 0.2).normalize(), // low in the west: the sky's colours, the streets in shade
    sunColor: 0xff9466,
    sunIntensity: 3.1,
    hemiSky: 0x4c6ca8,
    hemiGround: 0x6e5048,
    hemiIntensity: 0.85,
    skyTop: 0x102248,
    skyHorizon: 0xb86b6c,
    fogColor: 0x353c58,
    fogDensity: 0.00032,
    interiorGlow: 1.25,
    roadWetness: 0.0,
    envIntensity: 0.36,
    canyonBounce: 0.32,
    turbidity: 9.5,
    rayleigh: 3.4,
    mieCoefficient: 0.01,
    mieDirectionalG: 0.9,
    cloudCoverage: 0.4,
    cloudDensity: 0.42,
    skyExposure: 0.115,
    nightFactor: 0.28
  },
  midnight: {
    id: 'midnight',
    sunDir: new THREE.Vector3(0.42, 0.68, -0.6).normalize(), // the moon
    sunColor: 0x8cb0e8,
    sunIntensity: 1.45,
    hemiSky: 0x263a62,
    hemiGround: 0x382e36,
    hemiIntensity: 0.72,
    skyTop: 0x060c1a,
    skyHorizon: 0x182640,
    fogColor: 0x0c1424,
    fogDensity: 0.00036,
    interiorGlow: 1.55,
    roadWetness: 0.0,
    envIntensity: 0.3,
    canyonBounce: 0.18,
    turbidity: 4.0,
    rayleigh: 1.5,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.8,
    cloudCoverage: 0.22,
    cloudDensity: 0.25,
    skyExposure: 0.022,
    nightFactor: 0.86
  }
};

class LightingSystem {
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.activePresetId = 'midday';

    // Assign SunLight its node implementation for WebGPURenderer (Light.registerNode since r187; r186 used the library)
    if (SunLight.registerNode) {
      SunLight.registerNode(SunLightNode);
    } else if (renderer && renderer.library) {
      renderer.library.addLight(SunLightNode, SunLight);
    }

    this.scene.fog = new THREE.FogExp2(0xc6dcf2, 0.00018);
    this.scene.background = null;
    this.scene.backgroundNode = null;

    // Physical Preetham SkyMesh + Beer-Powder Clouds. Its unit box must contain the camera wherever it flies (it renders
    // at the far plane whatever its size)
    this.sky = new SkyMesh();
    this.sky.scale.setScalar(200000);
    this.sky.cloudScale.value = 0.00018;
    this.sky.cloudSpeed.value = 0.000015;
    this.sky.cloudElevation.value = 0.52;

    // Calibrate SkyMesh raw radiance (EE=1000 * 0.04) into standard exposure=1.0 HDR range
    this.uSkyExposure = uniform(0.142);
    this.uNightFactor = uniform(0.0);
    this.uNightSkyColor = uniform(new THREE.Color(0x0b1528));
    const rawSkyNode = this.sky.material.colorNode;
    this.sky.material.colorNode = Fn(() => {
      const dayCol = rawSkyNode.rgb.mul(this.uSkyExposure);
      return vec4(mix(dayCol, this.uNightSkyColor, this.uNightFactor), float(1.0));
    })();

    // In reversedDepthBuffer mode ([1..0]), camera.far is z = 0.0 (whereas SkyMesh defaults to z = w)
    if (renderer && renderer.reversedDepthBuffer) {
      const rawSkyVertexNode = this.sky.material.vertexNode;
      this.sky.material.vertexNode = Fn(() => {
        const pos = rawSkyVertexNode.toVar();
        pos.z.assign(0.0);
        return pos;
      })();
    }
    this.scene.add(this.sky);

    // Reusable PMREMGenerator & offscreen envScene
    this.pmremGenerator = renderer ? new THREE.PMREMGenerator(renderer) : null;
    this.envScene = new THREE.Scene();
    this.envRenderTarget = null;

    // SunLight with its automatic 2-cascade shadow map (SunLightShadow + SunShadowNode), shining from its position
    // towards the origin. 3072 px per cascade where a 6144 px atlas fits, else 2048
    this.sunLight = new SunLight(0xfff5e8, 6.6);
    this.sunLight.castShadow = true;
    const maxTex = renderer?.backend?.device?.limits?.maxTextureDimension2D || 4096;
    const tile = maxTex >= 6144 ? 3072 : 2048;
    this.sunLight.shadow.mapSize.set(tile, tile);
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 300;
    // no acne along the surface, so kerbs, cars, trees and people keep crisp contact shadows
    this.sunLight.shadow.normalBias = 0.05;
    this.scene.add(this.sunLight);

    // A subtle hemisphere fill, kept well under the sun so shadows stay deep
    this.hemiLight = new THREE.HemisphereLight(0xaad2ff, 0xb89678, 1.05);
    this.hemiLight.position.set(0, 300, 0);
    this.scene.add(this.hemiLight);

    this.applyPreset('midday', true);

    // Sky-matched aerial perspective: distant surfaces fade into the baked sky just above the horizon in their view
    // direction (sun glow included), through an exponential haze layer, so views from the air stay clearer than the
    // horizon
    this.uFogDensity = uniform(TIME_PRESETS.midday.fogDensity);
    this.uFogHeight = uniform(900.0);
    if (this.envRenderTarget) this.scene.fogNode = this.createAerialFogNode();
  }

  createAerialFogNode() {
    const toFrag = positionWorld.sub(cameraPosition);
    const dist = length(toFrag);
    const dir = toFrag.div(max(dist, 0.001));
    const horizonDir = normalize(vec3(dir.x, max(dir.y, 0.015), dir.z));
    const skyColor = pmremTexture(this.envRenderTarget.texture, horizonDir, float(0.3)).rgb;
    // Mean haze density exp(-y / H) along the ray between the fragment and the camera (heights over KICC's ground:
    // the valleys are 30 m below it, the ridges 75 m above, so the haze is a touch thicker in the valleys)
    const H = this.uFogHeight;
    const ya = max(positionWorld.y.add(40.0), 0.0);
    const yb = max(cameraPosition.y.add(40.0), 0.0);
    const dy = yb.sub(ya);
    const ea = exp(ya.div(H).negate());
    const eb = exp(yb.div(H).negate());
    const meanDensity = select(abs(dy).greaterThan(1.0), ea.sub(eb).mul(H).div(dy), ea);
    const tau = this.uFogDensity.mul(dist).mul(meanDensity);
    return fog(skyColor, float(1.0).sub(exp(tau.mul(tau).negate())));
  }

  bakeEnvironmentMap() {
    if (!this.pmremGenerator) return;
    // Bake the sky (without the sun's disc) into scene.environment, into the same render target every time so the
    // texture never changes identity
    this.sky.showSunDisc.value = 0;
    this.envScene.add(this.sky);
    this.envRenderTarget = this.pmremGenerator.fromScene(this.envScene, 0, 0.1, 100, { renderTarget: this.envRenderTarget });
    this.scene.environment = this.envRenderTarget.texture;
    this.sky.showSunDisc.value = 1;
    this.scene.add(this.sky);
  }

  applyPreset(presetId, force = false) {
    const p = TIME_PRESETS[presetId] || TIME_PRESETS.midday;
    if (!force && this.activePresetId === p.id && this.envRenderTarget !== null) return;
    this.activePresetId = p.id;

    this.sunLight.color.setHex(p.sunColor);
    this.sunLight.intensity = p.sunIntensity;
    this.sunLight.position.copy(p.sunDir);
    this.sunLight.updateMatrixWorld();

    this.hemiLight.color.setHex(p.hemiSky);
    this.hemiLight.groundColor.setHex(p.hemiGround);
    this.hemiLight.intensity = p.hemiIntensity;

    this.scene.fog.color.setHex(p.fogColor);
    this.scene.fog.density = p.fogDensity;
    if (this.uFogDensity) this.uFogDensity.value = p.fogDensity;

    this.sky.turbidity.value = p.turbidity;
    this.sky.rayleigh.value = p.rayleigh;
    this.sky.mieCoefficient.value = p.mieCoefficient;
    this.sky.mieDirectionalG.value = p.mieDirectionalG;
    this.sky.cloudCoverage.value = p.cloudCoverage;
    this.sky.cloudDensity.value = p.cloudDensity;
    this.sky.sunPosition.value.copy(p.sunDir);
    this.uSkyExposure.value = p.skyExposure;
    this.uNightFactor.value = p.nightFactor;

    cityUniforms.uSunColor.value.setHex(p.sunColor);
    cityUniforms.uSkyTopColor.value.setHex(p.skyTop);
    cityUniforms.uSkyHorizonColor.value.setHex(p.skyHorizon);
    cityUniforms.uSkySunDir.value.copy(p.sunDir);
    cityUniforms.uInteriorGlow.value = p.interiorGlow;
    cityUniforms.uRoadWetness.value = p.roadWetness;
    cityUniforms.uCanyonBounce.value = p.canyonBounce;

    this.scene.environmentIntensity = p.envIntensity;
    this.bakeEnvironmentMap();
  }

  update(focusPos) {
    // SunLightShadow fits and texel-snaps its two cascades to the view every frame (SunShadowNode.renderShadow),
    // the near one ending at about far / 4. Far stays at 300 m at street level, so the near cascade is sharp, and
    // grows with height over the ground (the helicopter, the towers' roofs) so shadows still reach the street.
    const altitude = focusPos && Number.isFinite(focusPos.y) ? Math.max(0, focusPos.y - (focusPos.groundY || 0)) : 0;
    this.sunLight.shadow.camera.far = Math.max(300, Math.min(720, 260 + altitude * 1.6));
  }
}

export { LightingSystem, TIME_PRESETS };
