import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { createPostProcessing } from './post-processing.js';
import { GEO } from './nairobi-geodata.js';
import { heightAt } from './terrain.js';
import { buildGround } from './ground.js';
import { buildBuildings, roofOf } from './buildings.js';
import { buildBridges } from './bridges.js';
import { buildStreets } from './streets.js';
import { buildColliders } from './colliders.js';
import { ThirdPersonControllerManager, roadSpawn } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CAMERA_PRESETS, CameraSystem } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { NairobiMapSystem } from './nairobi-map.js';
import { createTrafficSystem } from './traffic.js';
import { SIGNALS, TELEPORT_LOCATIONS, getLocation, getLocationLabel, isTypingInField } from './city-config.js';

// Nairobi Tour: the CBD at 1:1 on its real terrain. World frame: 1 unit = 1 m, x = east, y = up, z = south, origin at
// KICC's ground (GEO.terrain.base m above sea level). The HUD is Slop New York's (main.js, index.html, css/style.css).

const START = { from: [-980, 130, 560], at: [0, 50, -80] }; // free camera: over Uhuru Park's south-west corner, looking at KICC and the CBD

const loadingOverlay = document.getElementById('loading-overlay');
// (a reversed depth buffer, as Slop New York's: the streets lie centimetres over the terrain, and their paint over them)
const renderer = new THREE.WebGPURenderer({ antialias: true, reversedDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
// (clustered lights, as New York's: the headlamps and the police lights, hundreds of point lights for the cost of a few)
renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
renderer.setSize(innerWidth, innerHeight);
document.getElementById('canvas-container').appendChild(renderer.domElement);
await renderer.init();

// Equatorial light (lighting.js): a high sun in the physical sky, which lights everything and is what glass reflects,
// and warm light bounced off the dusty ground, or the HUD's other times of day
const scene = new THREE.Scene();
const lighting = new LightingSystem(scene, renderer);

const t0 = performance.now();
const ground = buildGround(renderer);
ground.receiveShadow = true;
scene.add(ground);
const buildings = await buildBuildings();
scene.add(buildings);
const bridges = buildBridges();
bridges.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
scene.add(bridges);
const world = buildColliders(bridges.userData.piers);
console.log(`[nairobi] scene built in ${Math.round(performance.now() - t0)} ms: ${GEO.buildings.length} buildings, ${bridges.userData.roads} elevated road pieces, ${bridges.userData.piers.length} piers, ${world.walls} wall colliders`);

// Traffic on the road graph (no sidewalks or obstacles yet: every lane is open), signalised at city-config's SIGNALS
const traffic = createTrafficSystem(scene, [], [], SIGNALS);
const streets = buildStreets(scene, traffic.network, traffic.zebras);
streets.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
// vehicles and people throw shadows too
traffic.group.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
console.log(`[nairobi] traffic: ${traffic.network.edges.length} road edges, ${traffic.network.nodes.filter((n) => n.signal).length} signalised junctions, ${traffic.cars.filter((c) => !c.isMatatu).length} cars, ${traffic.cars.filter((c) => c.isMatatu).length} matatus, ${traffic.bodas.length} boda bodas, ${traffic.buses.length} buses`);

// The player: on foot, in a car, on a bicycle or in a helicopter, and the cameras that follow them
const controllers = new ThirdPersonControllerManager(scene, world);
const cameras = new CameraSystem(renderer.domElement, controllers);
const camera = cameras.camera;

// Slop New York's render pipeline: the scene with its normals, metalness and roughness alongside (transparent decals
// write none, tsl-materials.js _transparentEffectMRT), half-resolution screen-space reflections on the glossy surfaces
// near the camera, then bloom and the time of day's colour grade (post-processing.js)
const scenePass = pass(scene, camera);
// (the multisampled colour attachments only need resolving, never storing; SSR reads the depth, so it stays stored)
scenePass.renderTarget.storeMultisampledColorBuffer = false;
const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
const maxSSRRoughness = 0.75;
const sceneMRT = mrt({
  output,
  normal: normalView,
  metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
});
sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
scenePass.setMRT(sceneMRT);
const scenePassColor = scenePass.getTextureNode('output');
const scenePassMetalRough = scenePass.getTextureNode('metalRough');
const ssrPass = ssr(scenePassColor, scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), {
  metalnessNode: scenePassMetalRough.r,
  roughnessNode: scenePassMetalRough.g,
  camera
});
ssrPass.resolutionScale = 0.5;
ssrPass.blurQuality = 1;
ssrPass.maxDistance.value = 42;
ssrPass.thickness.value = 0.85;
// (a few coarse steps, then the hits refined, so reflection edges stay precise)
ssrPass.quality.value = 0.25;
ssrPass.binaryRefine = true;
ssrPass.intensity.value = 0.5;
ssrPass.screenEdgeFadeBlack = true;
// the roughness blur must not spread reflections onto matte surfaces
const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
const colorGrade = createPostProcessing(renderer, scenePassColor, ssrPass.mul(reflectionMask));
const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);
scene.add(camera);
const PLAYER_STATE = 'nairobi-player-state';
// Saved players come back at rest, close to where they were (teleport placement keeps them clear of the buildings)
try {
  const saved = JSON.parse(localStorage.getItem(PLAYER_STATE));
  if (saved?.version === 1) {
    for (const mode of Object.keys(controllers.entities)) {
      const p = saved.entities?.[mode];
      if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
      controllers.setMode(mode);
      controllers.teleportActiveTo(p.x, p.z, p.heading, p.y);
    }
    controllers.setMode(Object.hasOwn(controllers.entities, saved.activeMode) ? saved.activeMode : 'car');
  }
} catch { /* Missing or unavailable storage does not prevent playing. */ }
function savePlayerState() {
  try {
    const entities = Object.fromEntries(Object.entries(controllers.entities).map(([mode, e]) => [mode, {
      x: e.position.x, y: e.position.y, z: e.position.z, heading: e.heading
    }]));
    localStorage.setItem(PLAYER_STATE, JSON.stringify({ version: 1, activeMode: controllers.activeMode, entities }));
  } catch { /* Storage may be disabled or full. */ }
}
addEventListener('pagehide', savePlayerState);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });
const touchControls = new TouchControls(controllers);

// ---------------------------------------------------------------------------------------------------------------------
// HUD (Strictly using safe DOM APIs: textContent, classList, addEventListener)
// ---------------------------------------------------------------------------------------------------------------------

const modeButtons = document.querySelectorAll('[data-mode]');
const timeButtons = document.querySelectorAll('[data-time]');
const hudToggleBtn = document.getElementById('btn-toggle-hud');
const modeSwitch = document.getElementById('mode-switch');
touchControls.onAvailabilityChange = placeModeIndicator;

const elFps = document.getElementById('hud-fps');
const elMode = document.getElementById('hud-active-mode');
const elCamera = document.getElementById('hud-active-camera');
const elSpeed = document.getElementById('hud-speed');
const elSpeedMeter = document.getElementById('hud-speed-meter');
const elAltitude = document.getElementById('hud-altitude');
const elLocation = document.getElementById('hud-location');
const elControlsHint = document.getElementById('hud-controls-hint');
const gamepadControls = new GamepadControls(controllers, cameras, {
  onCycleMode: (step) => {
    const modes = ['person', 'car', 'cyclist', 'helicopter'];
    selectMode(modes[(modes.indexOf(controllers.activeMode) + step + modes.length) % modes.length]);
  },
  onCycleCamera: cycleCamera,
  onToggleMap: () => mapSystem.toggleFullMap(!mapSystem.isFullMapOpen),
  onCloseMap: () => mapSystem.toggleFullMap(false)
});

// The camera menu, from CAMERA_PRESETS: the follow cameras, the scenic ones and the free camera, with their keys
const CAMERA_KEYS = { Digit5: 'chase', Digit6: 'action', Digit7: 'pov', Digit8: 'kicc', Digit9: 'uhuruPark', Digit0: 'drone' };
const keyOfCamera = Object.fromEntries(Object.entries(CAMERA_KEYS).map(([code, id]) => [id, code.slice(5)]));
keyOfCamera.free = 'F';
const cameraPopover = document.getElementById('camera-popover');
for (const [category, title] of [['follow', 'Follow'], ['scenic', 'Scenic'], ['free', 'Free']]) {
  const heading = document.createElement('div');
  heading.className = 'pop-title';
  heading.textContent = title;
  cameraPopover.appendChild(heading);
  for (const preset of CAMERA_PRESETS.filter((p) => p.category === category)) {
    const btn = document.createElement('button');
    btn.className = 'pop-item cam-btn';
    btn.type = 'button';
    btn.dataset.camera = preset.id;
    const name = document.createElement('span');
    name.className = 'pop-name';
    name.textContent = preset.name;
    btn.appendChild(name);
    if (keyOfCamera[preset.id]) {
      const kbd = document.createElement('kbd');
      kbd.textContent = keyOfCamera[preset.id];
      btn.appendChild(kbd);
    }
    cameraPopover.appendChild(btn);
  }
}
const cameraButtons = document.querySelectorAll('[data-camera]');

// The teleport menu, from TELEPORT_LOCATIONS
const teleportPopover = document.getElementById('teleport-popover');
for (const [id, loc] of Object.entries(TELEPORT_LOCATIONS)) {
  const btn = document.createElement('button');
  btn.className = 'pop-item tp-btn';
  btn.type = 'button';
  btn.dataset.teleport = id;
  for (const [cls, text] of [['pop-name', loc.name], ['pop-sub', loc.sub]]) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    btn.appendChild(span);
  }
  teleportPopover.appendChild(btn);
}
const teleportButtons = document.querySelectorAll('[data-teleport]');

// Keyboard guide for each mode, and for the free camera: [keys, action]
const controlHints = {
  person: [[['W', 'S'], 'Walk / Run'], [['A', 'D'], 'Turn'], [['Space'], 'Jump'], [['Drag'], 'Orbit'], [['F'], 'Free camera']],
  car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['Drag'], 'Orbit'], [['F'], 'Free camera']],
  cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn'], [['Drag'], 'Orbit'], [['F'], 'Free camera']],
  helicopter: [[['W', 'S'], 'Pitch'], [['A', 'D'], 'Yaw'], [['Space', 'E'], 'Ascend'], [['Q', 'C'], 'Descend'], [['F'], 'Free camera']],
  free: [[['Click'], 'Look'], [['W', 'A', 'S', 'D'], 'Move'], [['Space', 'C'], 'Up / Down'], [['Shift'], 'Fast'], [['⇧', '1–9'], 'Towers'], [['F'], 'Back']]
};
// Top speeds in km/h (controllers.js caps them at 8.2, 36, 19 & 52 m/s): full scale of the speed meter
const topSpeedKmh = { person: 30, car: 130, cyclist: 68, helicopter: 187, free: 300 };

function renderControlHints() {
  if (!elControlsHint) return;
  const hints = controlHints[cameras.activePresetId === 'free' ? 'free' : controllers.activeMode] || [];
  const items = hints.map(([keys, action]) => {
    const item = document.createElement('span');
    item.className = 'hint';
    for (const key of keys) {
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      item.appendChild(kbd);
    }
    const label = document.createElement('span');
    label.className = 'hint-label';
    label.textContent = action;
    item.appendChild(label);
    return item;
  });
  elControlsHint.replaceChildren(...items);
}

// The PSV-yellow pill under the selected mode glides from button to button
function placeModeIndicator() {
  const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
  if (!active) return;
  modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
  modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
}

// Touch and gamepad drive the player, so they rest while the map or the free camera is up
function updateInputSources() {
  const enabled = !mapSystem.isFullMapOpen && cameras.activePresetId !== 'free';
  touchControls.setEnabled(enabled);
  gamepadControls.setEnabled(enabled);
}

function selectMode(mode) {
  controllers.setMode(mode);
  touchControls.setMode(controllers.activeMode);
  gamepadControls.reset();
  modeButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
  document.body.dataset.mode = mode;
  placeModeIndicator();
  renderControlHints();
  // If currently on a scenic or the free camera, switch to the chase camera so the player is in view
  if (cameras.getActivePreset().category !== 'follow') selectCamera('chase', false);
}

function selectCamera(camId, snap = false) {
  cameras.setCameraPreset(camId, snap);
  cameraButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-camera') === camId);
  });
  if (elCamera) elCamera.textContent = cameras.getActivePreset().name;
  document.body.classList.toggle('free-camera', camId === 'free');
  renderControlHints();
  updateInputSources();
}

// Steps through CAMERA_PRESETS (V / Shift+V, and the arrows either side of the camera name)
function cycleCamera(step) {
  const n = CAMERA_PRESETS.length;
  const idx = CAMERA_PRESETS.findIndex((p) => p.id === cameras.activePresetId);
  selectCamera(CAMERA_PRESETS[(idx + step + n) % n].id, true);
}

let followPreset = 'chase'; // what F goes back to
function toggleFree() {
  if (cameras.activePresetId === 'free') selectCamera(followPreset, true);
  else {
    followPreset = cameras.activePresetId;
    selectCamera('free', true);
  }
}

function selectTime(timeId) {
  lighting.applyPreset(timeId);
  colorGrade.applyPreset(lighting.activePresetId);
  timeButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-time') === timeId);
  });
}

// Popovers (native [popover]: light dismiss & Esc for free) open against the control that toggles them: data-anchor
// names the element they sit above / below, data-align the one whose right edge they line up with
const popovers = document.querySelectorAll('.popover[popover]');
const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
function closePopovers() {
  if (!supportsPopover) return;
  popovers.forEach((pop) => {
    if (pop.matches(':popover-open')) pop.hidePopover();
  });
}
popovers.forEach((pop) => {
  const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
  pop.addEventListener('beforetoggle', (e) => {
    const open = e.newState === 'open';
    if (invoker) invoker.classList.toggle('is-open', open);
    if (!open) return;
    const anchor = document.getElementById(pop.dataset.anchor) || invoker;
    const align = document.getElementById(pop.dataset.align) || invoker;
    if (!anchor || !align) return;
    const r = anchor.getBoundingClientRect();
    const spaceAbove = Math.max(0, r.top - 20);
    const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
    let above = pop.dataset.side === 'above';
    // The camera control moves to the top on touch screens; open toward the available space.
    if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
    pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
    if (above) {
      pop.style.top = 'auto';
      pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
      pop.style.maxHeight = `${spaceAbove}px`;
    } else {
      pop.style.bottom = 'auto';
      pop.style.top = `${r.bottom + 8}px`;
      pop.style.maxHeight = `${spaceBelow}px`;
    }
  });
});

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    selectMode(btn.getAttribute('data-mode'));
  });
});

cameraButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-camera');
    // (the free camera through toggleFree, which remembers the camera F goes back to)
    if (id === 'free' && cameras.activePresetId !== 'free') toggleFree();
    else selectCamera(id, true);
    closePopovers();
  });
});

const camPrevBtn = document.getElementById('cam-prev');
const camNextBtn = document.getElementById('cam-next');
if (camPrevBtn) camPrevBtn.addEventListener('click', () => cycleCamera(-1));
if (camNextBtn) camNextBtn.addEventListener('click', () => cycleCamera(1));

timeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    selectTime(btn.getAttribute('data-time'));
  });
});

// A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('button') : null;
  if (btn && e.detail > 0) btn.blur();
});

// Where you are: the place's name over its street corner, drawn as street-name signs
let locationText = '';
function renderLocation(x, z) {
  const { place, streets, near } = getLocation(x, z);
  const key = `${place}|${streets.join('|')}|${near}`;
  if (!elLocation || key === locationText) return;
  locationText = key;
  const nodes = [];
  if (place) {
    const el = document.createElement('div');
    el.className = 'location-place';
    el.textContent = place;
    nodes.push(el);
  }
  if (streets.length) {
    const row = document.createElement('div');
    row.className = 'location-signs';
    if (near) {
      const label = document.createElement('span');
      label.className = 'location-near';
      label.textContent = 'near';
      row.appendChild(label);
    }
    for (const name of streets) {
      const sign = document.createElement('span');
      sign.className = 'street-sign';
      sign.textContent = name;
      row.appendChild(sign);
    }
    nodes.push(row);
  }
  elLocation.replaceChildren(...nodes);
}

function teleportTo(x, z, heading = Math.PI) {
  const destination = controllers.teleportActiveTo(x, z, heading);
  touchControls.reset();
  gamepadControls.reset();
  cameras.resetForTeleport();
  selectCamera('chase', true);
  mapSystem.waypoint = {
    x: destination.x,
    z: destination.z,
    name: getLocationLabel(destination.x, destination.z)
  };
  return destination;
}

const mapSystem = new NairobiMapSystem({
  controllerManager: controllers,
  cameraSystem: cameras,
  trafficSystem: traffic,
  onToggle: (open) => {
    controllers.resetInput();
    updateInputSources();
    const mapHint = document.getElementById('fullmap-hover-info');
    if (open && touchControls.available && mapHint) {
      mapHint.textContent = 'Tap to teleport · Drag to pan · Use + / − to zoom';
    }
  },
  onTeleport: teleportTo
});

teleportButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const loc = TELEPORT_LOCATIONS[btn.getAttribute('data-teleport')];
    if (loc) {
      // on the destination's road, in its left lane, facing along it
      const [x, z, heading] = roadSpawn(loc.road, loc.x, loc.z);
      teleportTo(x, z, heading);
    }
    closePopovers();
  });
});

const openMapBtn = document.getElementById('btn-open-map');
if (openMapBtn) openMapBtn.addEventListener('click', () => mapSystem.toggleFullMap(true));

if (hudToggleBtn) {
  hudToggleBtn.addEventListener('click', () => {
    document.body.classList.toggle('hud-minimized');
    const isMin = document.body.classList.contains('hud-minimized');
    hudToggleBtn.setAttribute('aria-pressed', String(isMin));
    hudToggleBtn.setAttribute('aria-label', isMin ? 'Show HUD' : 'Hide HUD');
    hudToggleBtn.title = isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]';
    if (isMin) closePopovers();
  });
}

// Global keyboard shortcuts: modes (1–4), cameras (5–0, V cycles them, F the free camera), the HUD (H); Shift+1–9 fly
// the free camera to the tallest towers, Shift+0 back to the start view (the map's M & Esc are nairobi-map.js's)
const MODES = ['person', 'car', 'cyclist', 'helicopter'];
const TOWERS = GEO.landmarks.filter((l) => l.kind === 'building' && l.h).slice(0, 9);
window.addEventListener('keydown', (e) => {
  if (isTypingInField(e) || e.metaKey || e.ctrlKey || e.altKey || mapSystem.isFullMapOpen) return;
  const digit = /^Digit(\d)$/.exec(e.code)?.[1];
  if (e.shiftKey && digit) {
    if (cameras.activePresetId !== 'free') toggleFree();
    const t = TOWERS[digit - 1];
    if (digit === '0') cameras.fly.lookFrom(...START.from, ...START.at);
    else if (t) {
      // stand off to the south-west at the tower's mid-height
      const g = heightAt(t.x, t.z);
      cameras.fly.lookFrom(t.x - 0.9 * t.h - 90, g + t.h * 0.7, t.z + 0.9 * t.h + 90, t.x, g + t.h * 0.55, t.z);
    }
  } else if (digit >= '1' && digit <= '4') selectMode(MODES[digit - 1]);
  else if (CAMERA_KEYS[e.code]) selectCamera(CAMERA_KEYS[e.code], true);
  else if (e.code === 'KeyV') cycleCamera(e.shiftKey ? -1 : 1);
  else if (e.code === 'KeyF' && !e.repeat) toggleFree();
  else if (e.code === 'KeyH' && hudToggleBtn) hudToggleBtn.click();
});

addEventListener('resize', () => {
  cameras.onResize(innerWidth, innerHeight);
  renderer.setSize(innerWidth, innerHeight);
  placeModeIndicator();
  if (mapSystem.isFullMapOpen) {
    mapSystem.resizeFullCanvas();
    mapSystem.renderFullMap();
  }
});

// Initialize the UI and chase camera around the restored player, or the car on a first visit.
selectMode(controllers.activeMode);
selectCamera('chase', true);
selectTime('midday');
// the web fonts change the buttons' widths once they arrive
if (document.fonts) document.fonts.ready.then(placeModeIndicator);
// Debugging, from the console: nairobi.roof('times') puts the active player on the roof of the tallest building whose
// name has that text, nairobi.roof(x, z) on the building at (x, z), nairobi.roof(n) on the nth tallest of all
function roof(what, z) {
  let b = null;
  const tallest = (list) => list.reduce((a, c) => (!a || c.h > a.h ? c : a), null);
  if (typeof what === 'string') {
    const q = what.toLowerCase();
    b = tallest(GEO.buildings.filter((c) => c.name && c.name.toLowerCase().includes(q)));
  } else if (typeof what === 'number' && Number.isFinite(z)) {
    b = tallest(GEO.buildings.filter((c) => inRingOf(c.ring, what, z)));
  } else if (typeof what === 'number') {
    b = GEO.buildings.filter((c) => !c.part).sort((p, q) => q.h - p.h)[what - 1];
  }
  if (!b) return 'no such building';
  const r = roofOf(b);
  controllers.teleportActiveTo(r.x, r.z, controllers.getActiveEntity().heading, r.y + 0.3);
  touchControls.reset();
  gamepadControls.reset();
  cameras.resetForTeleport();
  selectCamera('chase', true);
  return `${b.name || `Building ${b.id}`}: on its roof, ${Math.round(b.h)} m up (${Math.round(GEO.terrain.base + r.y).toLocaleString('en-GB')} m above sea level)`;
}
function inRingOf(ring, x, z) {
  let inside = false;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}
window.nairobi = { scene, camera, cameras, controllers, world, GEO, traffic, lighting, map: mapSystem, streets: streets.userData.layout, roof };

// Debug menu: "Teleport to a roof". While it is on, a click (not a drag: dragging still orbits the camera) on a
// building puts the active player on its roof. The ray from the camera through the cursor is marched in 0.5 m steps
// until it enters a building's collider (colliders.js) or meets the ground.
const debugRoofBtn = document.getElementById('debug-roof');
const debugBanner = document.getElementById('debug-banner');
let roofPick = false;
function setRoofPick(on) {
  roofPick = on;
  document.body.classList.toggle('debug-roof', on);
  debugBanner.hidden = !on;
  debugBanner.textContent = 'Click a building to teleport onto its roof · Esc to stop';
  debugRoofBtn.classList.toggle('active', on);
  debugRoofBtn.setAttribute('aria-pressed', String(on));
}
debugRoofBtn.addEventListener('click', () => {
  setRoofPick(!roofPick);
  closePopovers();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && roofPick) setRoofPick(false);
});
const pickRay = new THREE.Raycaster();
const pickNdc = new THREE.Vector2();
function buildingUnder(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pickNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  pickRay.setFromCamera(pickNdc, camera);
  const { origin: o, direction: d } = pickRay.ray;
  for (let t = 0; t < 4000; t += 0.5) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    if (y < heightAt(x, z)) return null; // the ground first: no building there
    if (world.solidAt(x, z, y)) return { x, z };
  }
  return null;
}
let pickDown = null;
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  if (roofPick && e.button === 0) pickDown = { x: e.clientX, y: e.clientY };
}, { capture: true });
canvas.addEventListener('pointerup', (e) => {
  if (!roofPick || !pickDown || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - pickDown.x, e.clientY - pickDown.y);
  pickDown = null;
  if (moved > 5) return; // a drag: the camera's
  const hit = buildingUnder(e.clientX, e.clientY);
  debugBanner.textContent = hit ? roof(hit.x, hit.z) : 'No building there · click a building, or Esc to stop';
}, { capture: true }); // for poking at from the console

// ---------------------------------------------------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------------------------------------------------

const timer = new THREE.Timer();
let frameCount = 0;
let fpsTimer = 0;
let nextSave = 0;
let shown = false;
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const rawDt = timer.getDelta();
  const dt = Math.min(rawDt, 0.1);
  const elapsed = timer.getElapsed();
  gamepadControls.update(dt);
  controllers.update(dt, elapsed);
  cameras.update(dt, elapsed);
  camera.groundY = heightAt(camera.position.x, camera.position.z); // (for the shadow cascades' reach)
  lighting.update(camera);
  const player = controllers.getActiveEntity();
  const parked = Object.values(controllers.entities).filter((e) => e !== player);
  traffic.update(dt, elapsed, cameras.currentPos, player, controllers.activeMode, camera, parked);
  mapSystem.update();
  if (!document.hidden && time >= nextSave) {
    savePlayerState();
    nextSave = time + 5000;
  }
  renderPipeline.render();
  if (!shown) {
    // The loading screen stays up until the GPU has got through the first frame, i.e. until the city is on screen
    shown = true;
    const device = renderer.backend.device;
    Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => loadingOverlay.classList.add('hidden'));
  }

  // Telemetry uses wall time, not the clamped simulation step, so slow frames and high-refresh displays report their
  // actual frame rate (updates DOM every 250ms).
  frameCount++;
  fpsTimer += Math.max(0, rawDt);
  if (fpsTimer >= 0.25) {
    const currentFps = Math.round(frameCount / fpsTimer);
    frameCount = 0;
    fpsTimer = 0;
    const free = cameras.activePresetId === 'free';
    const mode = free ? 'free' : controllers.activeMode;
    const kmh = Math.round((free ? cameras.fly.speed : Math.abs(player.speed)) * 3.6);
    if (elFps) {
      elFps.textContent = String(currentFps);
      elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
    }
    if (elMode) elMode.textContent = free ? 'Free camera' : player.label;
    if (elSpeed) elSpeed.textContent = String(kmh);
    if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, kmh / topSpeedKmh[mode])})`;
    if (elAltitude) elAltitude.textContent = Math.round(GEO.terrain.base + player.position.y).toLocaleString('en-GB');
    // The street corner of the player on the follow cameras, of the camera itself on the others
    const where = cameras.getActivePreset().category === 'follow' ? player.position : cameras.currentPos;
    renderLocation(where.x, where.z);
  }
});
