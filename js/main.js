import * as THREE from 'three/webgpu';
import { GEO } from './nairobi-geodata.js';
import { heightAt } from './terrain.js';
import { buildGround } from './ground.js';
import { buildBuildings } from './buildings.js';
import { buildBridges } from './bridges.js';
import { FlyCamera } from './fly-camera.js';
import { createTrafficSystem } from './traffic.js';
import { SIGNALS } from './city-config.js';

// Nairobi Tour: the CBD at 1:1 on its real terrain. World frame: 1 unit = 1 m, x = east, y = up, z = south, origin at
// KICC's ground (GEO.terrain.base m above sea level).

const SKY = new THREE.Color('#9cc3e6');
const START = { from: [-980, 130, 560], at: [0, 50, -80] }; // over Uhuru Park's south-west corner, looking at KICC and the CBD

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 1200, 7000);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 20000);
scene.add(camera);

// Equatorial light: a high sun, a bright sky and warm light bounced off the dusty ground
scene.add(new THREE.HemisphereLight('#cfe3f5', '#9a8a6c', 1.4));
const sun = new THREE.DirectionalLight('#fff4e0', 2.6);
sun.position.set(900, 2200, -600);
scene.add(sun);

const t0 = performance.now();
scene.add(buildGround(renderer));
const buildings = buildBuildings();
scene.add(buildings);
const bridges = buildBridges();
scene.add(bridges);
console.log(`[nairobi] scene built in ${Math.round(performance.now() - t0)} ms: ${GEO.buildings.length} buildings, ${bridges.userData.roads} elevated road pieces, ${bridges.userData.piers} piers`);

// Traffic on the road graph (no sidewalks or obstacles yet: every lane is open), signalised at city-config's SIGNALS
const traffic = createTrafficSystem(scene, [], [], SIGNALS);
console.log(`[nairobi] traffic: ${traffic.network.edges.length} road edges, ${traffic.network.nodes.filter((n) => n.signal).length} signalised junctions, ${traffic.cars.filter((c) => !c.isMatatu).length} cars, ${traffic.cars.filter((c) => c.isMatatu).length} matatus, ${traffic.bodas.length} boda bodas, ${traffic.buses.length} buses`);

const fly = new FlyCamera(camera, renderer.domElement);
fly.lookFrom(...START.from, ...START.at);
window.nairobi = { scene, camera, fly, GEO, traffic }; // for poking at from the console

// 1–9 fly to the tallest towers, 0 back to the start
const TOWERS = GEO.landmarks.filter((l) => l.kind === 'building' && l.h).slice(0, 9);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Digit0') fly.lookFrom(...START.from, ...START.at);
  const n = /^Digit([1-9])$/.exec(e.code);
  const t = n && TOWERS[n[1] - 1];
  if (!t) return;
  const g = heightAt(t.x, t.z);
  // stand off to the south-west at the tower's mid-height
  fly.lookFrom(t.x - 0.9 * t.h - 90, g + t.h * 0.7, t.z + 0.9 * t.h + 90, t.x, g + t.h * 0.55, t.z);
});

// HUD
const place = document.getElementById('place');
const stats = document.getElementById('stats');
document.getElementById('loading').hidden = true;
document.getElementById('hud').hidden = false;
function nearestName(x, z) {
  let best = null;
  let bd = 450;
  for (const l of GEO.landmarks) {
    const d = Math.hypot(l.x - x, l.z - z);
    if (d < bd) [best, bd] = [l.name, d];
  }
  return best ? `Near ${best}` : 'Nairobi';
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const timer = new THREE.Timer();
let frames = 0;
let fpsTime = 0;
let fps = 0;
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  fly.update(dt);
  traffic.update(dt, timer.getElapsed(), camera.position, null, 'fly', camera);
  renderer.render(scene, camera);

  frames++;
  fpsTime += dt;
  if (fpsTime > 0.5) {
    fps = Math.round(frames / fpsTime);
    frames = 0;
    fpsTime = 0;
    const p = camera.position;
    const ground = heightAt(p.x, p.z);
    place.textContent = nearestName(p.x, p.z);
    stats.textContent = `${fps} fps · ${Math.round(GEO.terrain.base + ground)} m above sea level · ${Math.round(p.y - ground)} m up · ${Math.round(fly.speed)} m/s · ${[...traffic.cars, ...traffic.buses, ...traffic.bodas].filter((v) => v.edge).length} vehicles · ${traffic.peds.filter((p) => p.placed).length} people`;
  }
});
