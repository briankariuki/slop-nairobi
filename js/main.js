import * as THREE from 'three/webgpu';
import { GEO } from './nairobi-geodata.js';
import { heightAt } from './terrain.js';
import { buildGround } from './ground.js';
import { buildBuildings } from './buildings.js';
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
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('canvas-container').appendChild(renderer.domElement);
await renderer.init();

// Equatorial light (lighting.js): a high sun, a bright sky and warm light bounced off the dusty ground, or the HUD's
// other times of day
const scene = new THREE.Scene();
const lighting = new LightingSystem(scene, renderer);

const t0 = performance.now();
const ground = buildGround(renderer);
ground.receiveShadow = true;
scene.add(ground);
const buildings = buildBuildings();
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
window.nairobi = { scene, camera, cameras, controllers, world, GEO, traffic, lighting, map: mapSystem, streets: streets.userData.layout }; // for poking at from the console

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
  camera.groundY = heightAt(camera.position.x, camera.position.z); // (for the shadow map's reach)
  lighting.update(camera);
  const player = controllers.getActiveEntity();
  const parked = Object.values(controllers.entities).filter((e) => e !== player);
  traffic.update(dt, elapsed, cameras.currentPos, player, controllers.activeMode, camera, parked);
  mapSystem.update();
  if (!document.hidden && time >= nextSave) {
    savePlayerState();
    nextSave = time + 5000;
  }
  renderer.render(scene, camera);
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
