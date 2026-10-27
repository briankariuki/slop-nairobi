// Slop New York's tests/cameras.test.cjs (MIT, © 2026 Mr.doob), ported to Nairobi: the same orbit, pinch and teleport
// checks, on terrain, plus the Nairobi follow cameras' rules (keeping out of buildings, the action camera on the road
// side for left-hand traffic) and the free camera's hand-over of the keyboard.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/cameras.js'), 'utf8');

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v) { return this.set(this.x - v.x, this.y - v.y, this.z - v.z); }
  subVectors(a, b) { return this.copy(a).sub(b); }
  lerp(v, t) { return this.set(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t); }
  addScaledVector(v, s) { return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s); }
  divideScalar(s) { return this.set(this.x / s, this.y / s, this.z / s); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  applyQuaternion() { return this; }
}

// fly-camera.js's interface, recording the hand-overs
class FlyCamera {
  constructor(camera) { this.camera = camera; this.keys = new Set(); this.enabled = true; this.speed = 40; }
  lookFrom(...args) { this.lookedFrom = args; this.camera.position.set(args[0], args[1], args[2]); }
  update() { this.updates = (this.updates || 0) + 1; }
}

class PerspectiveCamera {
  constructor(fov, aspect) {
    this.fov = fov;
    this.aspect = aspect;
    this.position = new Vector3();
    this.target = new Vector3();
  }
  updateProjectionMatrix() {}
  lookAt(v) { this.target.copy(v); }
}
PerspectiveCamera.prototype.quaternion = {};

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

// ground(x, z): the terrain; solidAt(x, z, y): the building there, if any (colliders.js)
function cameraHarness(entity = {
  position: new Vector3(0, 0, 100), heading: 0, speed: 0, type: 'car',
  chaseDistance: 6.9, chaseHeight: 2.12, cameraTargetOffset: new Vector3(0, 1, 0)
}, { ground = () => 0, solidAt = () => null } = {}) {
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false };
  const canvas = { ...eventTarget(), style: {} };
  const controls = eventTarget();
  const captured = new Set();
  canvas.setPointerCapture = (id) => captured.add(id);
  canvas.hasPointerCapture = (id) => captured.has(id);
  canvas.releasePointerCapture = (id) => {
    captured.delete(id);
    canvas.dispatch('lostpointercapture', { pointerId: id });
  };
  window.innerWidth = 1600;
  window.innerHeight = 900;
  const { CameraSystem } = loadModule(source, {
    globals: { window, document },
    imports: { 'three/webgpu': { Vector3, PerspectiveCamera }, './terrain.js': { heightAt: ground }, './fly-camera.js': { FlyCamera } }
  });
  const player = { getActiveEntity: () => entity, world: { solidAt }, inputEnabled: true, resetInput() { this.reset = true; } };
  const camera = new CameraSystem(canvas, player);
  return {
    camera, canvas, controls, window, document, captured, entity, player,
    pointer(target, type, id, x, y = 0, pointerType = 'touch', button = 0) {
      const event = {
        pointerId: id, clientX: x, clientY: y, pointerType, button,
        prevented: false, preventDefault() { this.prevented = true; }
      };
      // Captured pointers keep reaching the canvas after moving over the controls.
      (captured.has(id) ? canvas : target).dispatch(type, event);
      window.dispatch(type, event);
      return event;
    }
  };
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
}

test('UI touches neither move nor release an active canvas orbit', () => {
  const h = cameraHarness();
  assert.equal(h.canvas.style.touchAction, 'none');
  h.pointer(h.controls, 'pointerdown', 1, 20);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  assert.equal(h.captured.has(1), false);
  assert.equal(h.captured.has(2), true);

  h.pointer(h.controls, 'pointermove', 1, 300);
  close(h.camera.orbitYawOffset, 0);
  h.pointer(h.controls, 'pointerup', 1, 300);
  assert.equal(h.camera.isDragging, true);
  h.pointer(h.controls, 'pointermove', 2, 110);
  close(h.camera.orbitYawOffset, -0.065);
  h.pointer(h.controls, 'pointerup', 2, 110);
  assert.equal(h.camera.isDragging, false);
});

test('two canvas touches pinch without orbiting and one remaining touch resumes smoothly', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  h.pointer(h.canvas, 'pointermove', 2, 200);
  close(h.camera.zoomMultiplier, 0.5);
  close(h.camera.orbitYawOffset, 0);
  close(h.camera.orbitPitchOffset, 0.09);
  h.pointer(h.canvas, 'pointermove', 1, 100);
  close(h.camera.zoomMultiplier, 1);
  h.pointer(h.canvas, 'pointerup', 2, 200);
  h.pointer(h.canvas, 'pointermove', 1, 110);
  close(h.camera.orbitYawOffset, -0.065);
  close(h.camera.zoomMultiplier, 1);
});

test('extra fingers are ignored and coincident pinch points keep zoom finite', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  h.pointer(h.canvas, 'pointerdown', 3, 300);
  h.pointer(h.canvas, 'pointermove', 3, 500);
  close(h.camera.zoomMultiplier, 1);
  h.pointer(h.canvas, 'pointermove', 2, 0);
  h.pointer(h.canvas, 'pointermove', 2, 10);
  assert.equal(Number.isFinite(h.camera.zoomMultiplier), true);
  h.pointer(h.canvas, 'pointerup', 3, 500);
  assert.equal(h.camera.isDragging, true);
});

for (const interruption of ['pointercancel', 'lostpointercapture', 'blur', 'hidden']) {
  test(`${interruption} ends capture without a stuck drag or jump on the next gesture`, () => {
    const h = cameraHarness();
    h.pointer(h.canvas, 'pointerdown', 1, 0);
    h.pointer(h.canvas, 'pointermove', 1, 10);
    if (interruption === 'blur' || interruption === 'hidden') h.pointer(h.canvas, 'pointerdown', 3, 100);
    if (interruption === 'blur') h.window.dispatch('blur');
    else if (interruption === 'hidden') {
      h.document.hidden = true;
      h.document.dispatch('visibilitychange');
    } else if (interruption === 'lostpointercapture') h.canvas.releasePointerCapture(1);
    else h.pointer(h.canvas, interruption, 1, 10);
    assert.equal(h.camera.isDragging, false);
    assert.equal(h.captured.size, 0);
    h.pointer(h.canvas, 'pointermove', 1, 500);
    close(h.camera.orbitYawOffset, -0.065);
    h.pointer(h.canvas, 'pointerdown', 2, 600);
    h.pointer(h.canvas, 'pointermove', 2, 610);
    close(h.camera.orbitYawOffset, -0.13);
  });
}

test('cancelling one pinch pointer leaves the other ready for orbit', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  h.pointer(h.canvas, 'pointermove', 1, 20);
  h.pointer(h.canvas, 'pointercancel', 2, 100);
  assert.equal(h.camera.isDragging, true);
  h.pointer(h.canvas, 'pointermove', 1, 30);
  close(h.camera.orbitYawOffset, -0.065);
});

test('mouse orbit and wheel zoom retain their behavior and bounds', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0, 0, 'mouse', 2);
  assert.equal(h.camera.isDragging, false);
  h.pointer(h.canvas, 'pointerdown', 1, 0, 0, 'mouse');
  h.pointer(h.canvas, 'pointermove', 1, 10, 20, 'mouse');
  close(h.camera.orbitYawOffset, -0.065);
  close(h.camera.orbitPitchOffset, 0.19);
  h.pointer(h.canvas, 'pointerup', 1, 10, 20, 'mouse');
  let prevented = false;
  h.canvas.dispatch('wheel', { deltaY: 100, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  close(h.camera.zoomMultiplier, 1.1);
  h.canvas.dispatch('wheel', { deltaY: -10000, preventDefault() {} });
  close(h.camera.zoomMultiplier, 0.45);
  h.canvas.dispatch('wheel', { deltaY: 10000, preventDefault() {} });
  close(h.camera.zoomMultiplier, 2.4);
});

for (const preset of ['chase', 'kicc', 'drone', 'free']) {
  test(`teleport after driving, orbiting and ${preset} snaps to a fresh chase view`, () => {
    const h = cameraHarness();
    h.entity.speed = 45;
    for (let i = 0; i < 180; i++) h.camera.update(1 / 60, i / 60);
    assert.ok(h.camera.smoothedSpeed > 44);
    h.pointer(h.canvas, 'pointerdown', 1, 0);
    h.pointer(h.canvas, 'pointermove', 1, 200, 80);
    h.pointer(h.canvas, 'pointerup', 1, 200, 80);
    h.canvas.dispatch('wheel', { deltaY: 1000, preventDefault() {} });
    h.camera.setCameraPreset(preset, true);
    h.camera.update(1 / 60, 4);

    h.entity.position.set(-200, 20, 5300);
    h.entity.heading = -Math.PI / 2;
    h.entity.speed = 0;
    h.camera.resetForTeleport();
    const fresh = cameraHarness(h.entity).camera;
    assert.equal(h.camera.activePresetId, 'chase');
    assert.equal(h.camera.camera.fov, fresh.camera.fov);
    // Compare arrival, follow re-anchoring, and movement after arrival, including a change in height.
    for (let i = 0; i < 3; i++) {
      if (i === 2) h.entity.position.set(-205, 23, 5304);
      h.camera.update(1 / 60, 5 + i / 60);
      fresh.update(1 / 60, 5 + i / 60);
      for (const field of ['currentPos', 'currentLookAt']) {
        for (const axis of ['x', 'y', 'z']) close(h.camera[field][axis], fresh[field][axis]);
      }
      for (const axis of ['x', 'y', 'z']) {
        close(h.camera.camera.position[axis], fresh.camera.position[axis]);
        close(h.camera.camera.target[axis], fresh.camera.target[axis]);
      }
    }
  });
}

test('teleport releases every camera pointer and ignores old gestures before accepting a new drag', () => {
  const h = cameraHarness();
  h.pointer(h.canvas, 'pointerdown', 1, 0);
  h.pointer(h.canvas, 'pointermove', 1, 20, 40);
  h.pointer(h.canvas, 'pointerdown', 2, 100);
  h.pointer(h.canvas, 'pointermove', 2, 200);
  assert.equal(h.captured.size, 2);
  h.camera.resetForTeleport();
  assert.equal(h.captured.size, 0);
  assert.equal(h.camera.isDragging, false);
  assert.equal(h.camera.userOrbitTimer, 0);
  for (const id of [1, 2]) {
    h.pointer(h.canvas, 'pointermove', id, 500, 500);
    h.pointer(h.canvas, 'pointerup', id, 500, 500);
  }
  close(h.camera.orbitYawOffset, 0);
  close(h.camera.orbitPitchOffset, 0.09);
  close(h.camera.zoomMultiplier, 1);
  h.pointer(h.canvas, 'pointerdown', 3, 600);
  h.pointer(h.canvas, 'pointermove', 3, 610);
  close(h.camera.orbitYawOffset, -0.065);
  assert.equal(h.camera.isDragging, true);
});

// Nairobi

function settle(h, seconds = 3) {
  for (let i = 0; i < seconds * 60; i++) h.camera.update(1 / 60, i / 60);
}

test('the action camera rides on the right, over the middle of the road, as Kenya drives on the left', () => {
  const h = cameraHarness();
  h.camera.setCameraPreset('action', true);
  settle(h);
  // heading 0 faces +z, so the car's right is -x
  assert.ok(h.camera.currentPos.x < -2, 'to the right of the car');
  assert.ok(h.camera.currentPos.z < h.entity.position.z, 'and behind it');
});

test('the first-person car camera sits in the right-hand driving seat', () => {
  const h = cameraHarness();
  h.camera.setCameraPreset('pov', true);
  h.camera.update(1 / 60, 0);
  close(h.camera.currentPos.x, -0.36);
  close(h.camera.currentPos.z, 100.55);
});

test('the follow cameras stay over hilly ground', () => {
  const hill = (x, z) => 0.3 * (100 - z); // rising behind the car, so the chase camera would be in it
  const entity = {
    position: new Vector3(0, hill(0, 100), 100), heading: 0, speed: 0, type: 'car',
    chaseDistance: 6.9, chaseHeight: 2.12, cameraTargetOffset: new Vector3(0, 1, 0)
  };
  const h = cameraHarness(entity, { ground: hill });
  h.camera.orbitPitchOffset = -0.32; // dragged down as far as it goes
  settle(h);
  const p = h.camera.currentPos;
  assert.ok(p.y >= hill(p.x, p.z) + 0.4 - 1e-9, 'never below the ground under it');
});

test('a chase camera with a building behind the player comes in front of it', () => {
  // a wall 4 m behind the car (z < 96), which the 6.9 m chase camera would be inside
  const h = cameraHarness(undefined, { solidAt: (x, z, y) => (z < 96 && y < 30 ? {} : null) });
  settle(h);
  assert.ok(h.camera.currentPos.z >= 96 - 1e-9, 'pulled in to the near side of the wall');
  assert.ok(h.camera.currentPos.z < 100, 'still behind the car');
  close(h.camera.currentLookAt.z, 105.2);
});

test('the free camera takes the keyboard from the player and gives it back', () => {
  const h = cameraHarness();
  settle(h, 1);
  h.camera.setCameraPreset('free');
  assert.equal(h.camera.fly.enabled, true);
  assert.equal(h.player.inputEnabled, false);
  assert.equal(h.player.reset, true, 'keys held for the player are let go');
  assert.deepEqual(h.camera.fly.lookedFrom.slice(0, 3), [h.camera.camera.position.x, h.camera.camera.position.y, h.camera.camera.position.z],
    'it starts from where the camera was');
  const yaw = h.camera.orbitYawOffset;
  h.pointer(h.canvas, 'pointerdown', 1, 0, 0, 'mouse');
  h.pointer(h.canvas, 'pointermove', 1, 50, 0, 'mouse');
  assert.equal(h.camera.orbitYawOffset, yaw, 'drags are the free camera\'s');
  h.camera.update(1 / 60, 1);
  assert.equal(h.camera.fly.updates, 1);

  h.camera.setCameraPreset('chase');
  assert.equal(h.camera.fly.enabled, false);
  assert.equal(h.player.inputEnabled, true);
  h.camera.update(1 / 60, 2);
  close(h.camera.currentPos.z, h.entity.position.z - Math.cos(0.09) * 6.9);
});
