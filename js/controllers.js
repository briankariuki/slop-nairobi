import * as THREE from 'three/webgpu';
import { isTypingInField } from './city-config.js';
import { cityUniforms, createContactShadowMaterial } from './tsl-materials.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildSteerableWheelGeo,
  createLoftedCarMaterial,
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial
} from './actor-models.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import { wallContact } from './colliders.js';
import { GEO } from './nairobi-geodata.js';

// Slop New York's controllers.js (MIT, © 2026 Mr.doob), adapted for Nairobi: player models, animation and movement for
// walking, driving, cycling and flying, on the terrain and the Expressway decks, with the buildings as colliders
// (colliders.js). Cars and bikes roll down hills and fall off what they drive over the edge of; the helicopter can land
// on the roofs.

const GRAVITY = 9.81;

// The detailed area: GEO.terrain's extent. Walking, driving and cycling stay EDGE m inside it; the helicopter may fly
// on over the ground beyond, where the terrain's edge heights carry on.
const T = GEO.terrain;
const EDGE = 30;
const BOUNDS = { minX: T.x0, minZ: T.z0, maxX: T.x0 + (T.nx - 1) * T.cell, maxZ: T.z0 + (T.nz - 1) * T.cell };
const HELI_MARGIN = 3000;
const HELI_CEILING = 600; // m over KICC's ground

// A point on the named road nearest (x, z), in its left lane, facing the way it runs (the spawn and the teleports).
// Returns [x, z, heading, left x, left z] (left: the unit vector to the kerb on the left).
export function roadSpawn(name, x, z) {
  let best = null;
  let bd = Infinity;
  for (const l of GEO.roadGraph.links) {
    if (l.name !== name) continue;
    const p = l.pts;
    for (let i = 0; i < p.length - 2; i += 2) {
      const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < bd) [bd, best] = [d, { l, x: ax + dx * t, z: az + dz * t, dx, dz }];
    }
  }
  const len = Math.hypot(best.dx, best.dz);
  const fx = best.dx / len, fz = best.dz / len;
  // Kenya drives on the left: on a two-way road, half a lane's width left of the centre line
  const off = best.l.oneway ? -best.l.w / 4 : best.l.w / 4;
  return [best.x + fz * off, best.z - fx * off, Math.atan2(fx, fz), fz, -fx];
}

// Spawn on Kenyatta Avenue, heading south-east towards Moi Avenue
const SPAWN = roadSpawn('Kenyatta Avenue', -110, -505);
const spawnAt = (ahead, left) => [SPAWN[0] + Math.sin(SPAWN[2]) * ahead + SPAWN[3] * left, SPAWN[1] + Math.cos(SPAWN[2]) * ahead + SPAWN[4] * left];
const groundCollider = { type: 'ground' };

const CAR_DRIVE = {
  speed: 36, reverseSpeed: 10.5, acceleration: 4.5,
  powerSpeed: 14.5, // Above 52 km/h, engine power limits acceleration.
  rolling: 0.18, drag: 0.0012, coast: 0.6, brake: 9,
  wheelbase: 2.76, grip: 9.5, cornering: 10.5 // Wheelbase (m), tire and steering acceleration limits (m/s²).
};
const BICYCLE_DRIVE = {
  speed: 19, reverseSpeed: 4.5, acceleration: 9,
  rolling: 0.08, drag: 0.004, coast: 0.2, brake: 7.5 // Backward input is scaled to 0.6, giving 4.5 m/s² braking.
};

function driveSpeed(speed, throttle, dt, drive) {
  // Turning can project tiny sideways motion back into speed after braking to zero.
  // Treat a crawl as stopped when changing direction, so this cannot hold the brakes forever.
  if (speed * throttle < 0 && Math.abs(speed) < 0.05) speed = 0;
  const braking = speed * throttle < 0;
  const magnitude = Math.abs(speed);
  // Extra resistance on release gives a stronger slowdown while coasting.
  const deceleration = drive.rolling + (!throttle ? drive.coast : braking ? Math.abs(throttle) * drive.brake : 0);
  // Constant rolling resistance and quadratic air drag, without crossing zero or large-dt instability.
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || braking) return Math.sign(speed) * coasting;

  const limit = throttle < 0 ? drive.reverseSpeed : drive.speed;
  let acceleration = drive.acceleration;
  if (drive.powerSpeed) acceleration *= drive.powerSpeed / Math.max(drive.powerSpeed, magnitude);
  // Collision momentum above the powered limit decays naturally instead of being clamped.
  return Math.sign(throttle) * Math.min(Math.max(limit, coasting), coasting + Math.abs(throttle) * acceleration * dt);
}

// Walking surface for the player's pedestrian (its rig samples it around its feet)
// The player's feet, like the pedestrians' (pedestrian-system.js), stand a couple of centimetres up so they don't sink
// into the terrain's triangles
const personGround = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person', controllers.entities.person.position.y) + 0.02;

function collisionBody(mode, radius, heading, margin = 0) {
  const car = mode === 'car';
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const hx = 0.86 + margin, hz = 2.18 + margin;
  return {
    car, sin, cos, hx, hz, radius: radius + margin,
    extX: car ? Math.abs(cos) * hx + Math.abs(sin) * hz : radius + margin,
    extZ: car ? Math.abs(sin) * hx + Math.abs(cos) * hz : radius + margin,
    bottom: mode === 'helicopter' ? -0.25 : 0,
    top: mode === 'helicopter' ? 3.2 : car ? 1.8 : 1.9
  };
}

class ThirdPersonControllerManager {
  // world: colliders.js's buildColliders()
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.inputEnabled = true; // off while the free camera has the keyboard
    this.activeMode = 'car'; // 'person' | 'car' | 'cyclist' | 'helicopter'

    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false
    };

    this.entities = {
      person: this.createPersonEntity(),
      car: this.createCarEntity(),
      cyclist: this.createCyclistEntity(),
      helicopter: this.createHelicopterEntity()
    };

    Object.values(this.entities).forEach((ent) => {
      if (ent.mesh) {
        ent.mesh.traverse((child) => {
          if (
            child.isMesh &&
            !child.material?.isMeshBasicNodeMaterial &&
            child.material?.type !== 'MeshBasicNodeMaterial' &&
            !child.material?.transparent
          ) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
      }
    });

    this.bindKeyboard();
  }

  setCollisionListener(listener) {
    this._collisionListener = typeof listener === 'function' ? listener : null;
    this._collisionEvent ??= { a: null, b: null, kind: '', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
  }

  // Reuse one synchronous event; consumers must copy retained fields. Normal points from b toward a.
  reportCollision(a, b, kind, x, y, z, nx, ny, nz, speed) {
    if (!this._collisionListener || speed <= 0.5) return;
    const event = this._collisionEvent;
    event.a = a; event.b = b; event.kind = kind;
    event.x = x; event.y = y; event.z = z;
    event.nx = nx; event.ny = ny; event.nz = nz; event.speed = speed;
    this._collisionListener(event);
  }

  bindKeyboard() {
    const bindings = {
      forward: ['KeyW', 'ArrowUp'],
      backward: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      up: ['Space', 'KeyE'],
      down: ['KeyQ', 'KeyC']
    };
    const actionsByCode = new Map(Object.entries(bindings).flatMap(([action, codes]) => codes.map((code) => [code, action])));
    this._pressedCodes = new Set();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};

    const onKey = (e, isDown) => {
      const action = actionsByCode.get(e.code);
      if (!action || (isDown && (isTypingInField(e) || !this.inputEnabled))) return;
      if (isDown) this._pressedCodes.add(e.code);
      else this._pressedCodes.delete(e.code);
      // Releasing one binding must not cancel another key held for the same action.
      this._keyboardKeys[action] = bindings[action].some((code) => this._pressedCodes.has(code));
      this._blendInput(action);
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => this.resetInput());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetInput();
    });
  }

  _blendInput(action) {
    const keyboard = this._keyboardKeys[action] || false;
    const touch = this._touchKeys[action] || false;
    const gamepad = this._gamepadKeys[action] || false;
    const strength = Math.max(keyboard, touch, gamepad);
    // Preserve digital button values while allowing either analog source to be strongest.
    this.keys[action] = keyboard === true || touch === true || gamepad === true ? true : strength || false;
  }

  _setAnalogInput(source, action, value) {
    if (!Object.hasOwn(this.keys, action)) return;
    const strength = Number(value);
    source[action] = typeof value === 'boolean' ? value : Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this._blendInput(action);
  }

  setTouchInput(action, value) {
    this._setAnalogInput(this._touchKeys, action, value);
  }

  setGamepadInput(action, value) {
    this._setAnalogInput(this._gamepadKeys, action, value);
  }

  clearTouchInput() {
    this._touchKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  clearGamepadInput() {
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  resetInput() {
    this._pressedCodes.clear();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
  }

  setMode(mode) {
    if (!this.entities[mode]) return;
    this.activeMode = mode;
    const car = this.entities.car;
    if (mode !== 'car' && car?.carState) car.carState.value.x = car.carState.value.w = 0;
  }

  getActiveEntity() {
    return this.entities[this.activeMode];
  }

  teleportActiveTo(x, z, heading = Math.PI, savedAltitude = null) {
    const ent = this.getActiveEntity();
    this.resetInput();
    if (!Number.isFinite(heading)) heading = ent.heading;
    const heli = this.activeMode === 'helicopter';
    // the helicopter arrives at its saved height, else at its own if that is at least 92 m over the ground there (and
    // never below a roof)
    const altitude = (px, pz) => {
      const floor = this.world.surfaceAt(px, pz, Infinity, true) + 0.25;
      return Math.max(floor, Math.min(HELI_CEILING, savedAltitude ?? Math.max(this.world.surfaceAt(px, pz) + 92, ent.position.y)));
    };
    // on foot or wheels, the surface a saved (or nairobi.roof()) height stands on: a deck or a roof
    const ground = (px, pz) => this.getGroundHeight(px, pz, this.activeMode, savedAltitude ?? Infinity);
    const destination = this.findTeleportPosition(x, z, heading, altitude, ground);
    if (destination) {
      ent.position.x = destination.x;
      ent.position.z = destination.z;
      ent.heading = heading;
      ent.position.y = heli ? altitude(destination.x, destination.z)
        : this.getGroundHeight(destination.x, destination.z, this.activeMode, savedAltitude ?? -Infinity);
    }
    ent.speed = 0;
    ent.verticalVel = 0;
    ent.pitch = 0;
    if (this.activeMode === 'person') {
      ent.verticalVel = 0;
      ent.rig.reset(ent.position.x, ent.position.z, ent.heading, personGround, this);
      ent.crowd.begin();
      ent.crowd.add(ent.rig, 0);
      ent.crowd.end();
    } else if (this.activeMode === 'car') {
      ent.prevX = ent.position.x;
      ent.prevZ = ent.position.z;
      ent.vx = ent.vz = ent.angularVel = ent.steerAngle = 0;
      ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
      ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
      ent.chassisPivot.position.y = 0;
      ent.lastCollisionSpark = null;
      for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
      if (ent.carState) ent.carState.value.x = ent.carState.value.w = 0;
    } else if (this.activeMode === 'cyclist') {
      ent.leanAngle = ent.leanPivot.rotation.z = 0;
    } else if (heli) {
      ent.verticalSpeed = ent.pitchAngle = ent.rollAngle = 0;
      ent.tiltPivot.rotation.x = ent.tiltPivot.rotation.z = 0;
      ent.tiltPivot.position.y = 0;
    }
    ent.mesh.position.copy(ent.position);
    ent.mesh.rotation.y = ent.heading;
    return { x: ent.position.x, z: ent.position.z };
  }

  // Find a fully clear arrival before moving the player. Sequential collision pushes can leave a player trapped
  // between overlapping buildings, so test whole candidate footprints instead; retain the old position if none fits.
  // altitude(x, z): the helicopter's arrival height there; ground(x, z): anyone else's.
  findTeleportPosition(x, z, heading, altitude, ground = (px, pz) => this.getGroundHeight(px, pz, this.activeMode)) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = this.activeMode === 'helicopter';
    const radius = heli ? 4.5 : this.activeMode === 'person' ? 0.48 : 0.65;
    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const shape = collisionBody(this.activeMode, radius, heading, 0.1);
    const reach = Math.max(shape.extX, shape.extZ);
    const entity = this.getActiveEntity();
    // Conservative body cylinders, including the taxi's corners, bicycle wheels and helicopter tail/rotor.
    const body = { person: [0.48, 1.9], car: [2.4, 1.9], cyclist: [1.0, 1.9], helicopter: [6.2, 3.2] };
    const others = Object.values(this.entities).filter(e => e !== entity).map(e => ({
      x: e.position.x, z: e.position.z, radius: body[e.type][0],
      bottom: e.position.y - (e.type === 'helicopter' ? 0.7 : 0), top: e.position.y + body[e.type][1]
    }));
    const cameraBack = Math.cos(0.09) * entity.chaseDistance;
    const cameraUp = entity.chaseHeight + Math.sin(0.09) * entity.chaseDistance * 0.85;
    const inset = heli ? -HELI_MARGIN : EDGE;
    const clampPoint = (px, pz) => ({
      x: Math.max(BOUNDS.minX + inset, Math.min(BOUNDS.maxX - inset, px)),
      z: Math.max(BOUNDS.minZ + inset, Math.min(BOUNDS.maxZ - inset, pz))
    });
    const clear = (p) => {
      const baseY = heli ? altitude(p.x, p.z) : ground(p.x, p.z);
      // Keep other player models out of both the arrival and its default chase view. A corridor also prevents a
      // parked car between camera and character from hiding the character even when the camera itself is outside it.
      const viewTop = baseY + Math.max(body[entity.type][1], cameraUp);
      for (const other of others) {
        if (other.bottom > viewTop + 0.3 || other.top < baseY - (heli ? 0.7 : 0) - 0.3) continue;
        const dx = other.x - p.x, dz = other.z - p.z;
        const back = Math.max(0, Math.min(cameraBack, -dx * sinH - dz * cosH));
        if (Math.hypot(dx + sinH * back, dz + cosH * back) < other.radius + Math.max(body[entity.type][0], 0.5) + 0.1) return false;
      }
      const contact = this._teleportContact ??= { nx: 0, nz: 0, depth: 0 };
      for (const w of this.world.nearWalls(p.x, p.z, reach)) {
        if (wallContact(w, p.x, baseY, p.z, shape, contact)) return false;
      }
      return !this.world.solidAt(p.x, p.z, baseY + shape.bottom, baseY + shape.top);
    };
    const origin = clampPoint(x, z);
    if (clear(origin)) return origin;
    // Four-metre rings cover nearby streets and courtyards, with bounded work even for a click inside a large block.
    const cx = origin.x, cz = origin.z;
    for (let distance = 4; distance <= 256; distance += 4) {
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        const p = clampPoint(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance);
        if (clear(p)) return p;
      }
    }
    return null;
  }

  // =========================================================================
  // 1. PERSON (SKINNED PEDESTRIAN WITH PLANTED-FOOTSTEP IK GAIT, see pedestrians.js)
  // =========================================================================
  createPersonEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerPerson';

    // One skinned person, posed in world space every frame by its rig (walk, run, turn, jump)
    const crowd = new PersonCrowd(1, { farDistance: Infinity });
    crowd.meshes.forEach((m) => this.scene.add(m));
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });
    const [x, z] = spawnAt(10, 7); // on the pavement beside the car

    // Soft Under-Foot Contact Shadow (AO)
    const shadowGeo = new THREE.PlaneGeometry(0.95, 0.95);
    shadowGeo.rotateX(-Math.PI * 0.5);
    const pedShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
    pedShadow.position.y = 0.02;
    pedShadow.renderOrder = 998;
    root.add(pedShadow);

    this.scene.add(root);

    return {
      type: 'person',
      label: 'On foot',
      mesh: root,
      crowd,
      rig,
      position: new THREE.Vector3(x, this.world.surfaceAt(x, z), z),
      heading: SPAWN[2],
      speed: 0,
      verticalVel: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 4.3,
      chaseHeight: 1.95
    };
  }

  // =========================================================================
  // 2. CAR (3D LOFTED SALOON IN KENYAN NUMBER PLATES, see actor-models.js)
  // =========================================================================
  createCarEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCar';

    const chassisPivot = new THREE.Group();
    root.add(chassisPivot);

    // A saloon in deep green, so it stands out among the white and silver of the traffic
    const spec = BODY_SPECS.sedan;
    const carLoftMat = createLoftedCarMaterial(spec, 0x1f6f4a);

    // 1. 3D Lofted Body + Curved Windscreens + Crowned Roof + Side Mirrors (plates and lamps are in the material)
    const carBodyGeo = buildCarGeometry(spec, false);
    const carBodyMesh = new THREE.Mesh(carBodyGeo, carLoftMat);
    carBodyMesh.castShadow = true;
    carBodyMesh.receiveShadow = true;
    chassisPivot.add(carBodyMesh);

    // 2. Brake, reverse & turn lights are lit by the car material from its carState uniform (see updateCar)
    const carState = carLoftMat.userData.carState;

    // 3. Steerable & Spinning 3D LatheGeometry Tyres + Recessed 5-Spoke Alloy Wheels
    const leftWheelGeo = buildSteerableWheelGeo(spec, -1);
    const rightWheelGeo = buildSteerableWheelGeo(spec, 1);

    const wheels = [];
    const wheelCoords = [
      { side: -1, z: spec.wheelZ, isFront: true },
      { side: 1, z: spec.wheelZ, isFront: true },
      { side: -1, z: -spec.wheelZ, isFront: false },
      { side: 1, z: -spec.wheelZ, isFront: false }
    ];
    for (const wc of wheelCoords) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(wc.side * spec.wheelX, spec.wheelRadius, wc.z);
      const tire = new THREE.Mesh(wc.side < 0 ? leftWheelGeo : rightWheelGeo, carLoftMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      steerPivot.add(tire);
      root.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront: wc.isFront });
    }

    // 4. Ground contact shadow and paired headlight spotlights
    const carShadowGeo = new THREE.PlaneGeometry(2.22, 5.05);
    carShadowGeo.rotateX(-Math.PI * 0.5);
    const carShadow = new THREE.Mesh(carShadowGeo, createContactShadowMaterial());
    carShadow.position.set(0, 0.02, 0.0);
    carShadow.renderOrder = 998;
    root.add(carShadow);

    const headLights = [];
    for (const side of [-1, 1]) {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      chassisPivot.add(spot, spot.target);
      headLights.push(spot);
    }

    this.scene.add(root);
    const [x, z] = spawnAt(0, 0);

    return {
      type: 'car',
      verticalVel: 0,
      pitch: 0,
      label: 'Car',
      mesh: root,
      chassisPivot,
      carState,
      headLights,
      wheels,
      position: new THREE.Vector3(x, this.world.surfaceAt(x, z), z),
      prevX: x,
      prevZ: z,
      heading: SPAWN[2],
      speed: 0,
      vx: 0,
      vz: 0,
      angularVel: 0,
      pitchVel: 0,
      rollVel: 0,
      heaveY: 0,
      heaveVel: 0,
      lastCollisionSpark: null,
      steerAngle: 0,
      wheelSpin: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.96, 0),
      chaseDistance: 6.9,
      chaseHeight: 2.12
    };
  }

  // =========================================================================
  // 3. CYCLIST (SKINNED RIDER + ROAD BICYCLE)
  // =========================================================================
  createCyclistEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCyclist';

    const leanPivot = new THREE.Group();
    root.add(leanPivot);

    const frameMat = new THREE.MeshStandardNodeMaterial({ color: 0xd8262e, roughness: 0.32, metalness: 0.35 });
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x181a1e,
      roughness: 0.60
    });
    const chromeMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe0e8f0,
      roughness: 0.16,
      metalness: 0.78
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1c2028,
      roughness: 0.55
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf4f7fb,
      emissive: 0x181c22,
      roughness: 0.22,
      metalness: 0.25
    });

    const wheelTorusGeo = new THREE.TorusGeometry(0.35, 0.038, 12, 24);
    wheelTorusGeo.rotateY(Math.PI * 0.5);
    const rimTorusGeo = new THREE.TorusGeometry(0.31, 0.018, 8, 24);
    rimTorusGeo.rotateY(Math.PI * 0.5);

    const frontWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    frontWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    frontWheel.position.set(0, 0.38, 0.58);
    leanPivot.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    rearWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    rearWheel.position.set(0, 0.38, -0.58);
    leanPivot.add(rearWheel);

    // Rear red LED safety strobe on seatpost
    const tailLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff1e26 })
    );
    tailLed.position.set(0, 0.86, -0.32);
    leanPivot.add(tailLed);

    const topTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 10), frameMat);
    topTube.rotation.x = Math.PI * 0.46;
    topTube.position.set(0, 0.78, 0.04);
    leanPivot.add(topTube);

    const downTube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.78, 10), frameMat);
    downTube.rotation.x = Math.PI * 0.28;
    downTube.position.set(0, 0.58, 0.16);
    leanPivot.add(downTube);

    const seatTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.64, 10), frameMat);
    seatTube.rotation.x = -0.22;
    seatTube.position.set(0, 0.66, -0.22);
    leanPivot.add(seatTube);

    const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 10), shortsMat);
    saddle.rotation.x = Math.PI * 0.5;
    saddle.scale.set(1.15, 1.0, 0.55);
    saddle.position.set(0, 0.96, -0.28);
    leanPivot.add(saddle);

    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.016, 0.68, 10), chromeMat);
    fork.rotation.x = -0.24;
    fork.position.set(0, 0.68, 0.48);
    leanPivot.add(fork);

    const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 10), chromeMat);
    handlebar.rotation.z = Math.PI * 0.5;
    handlebar.position.set(0, 0.98, 0.40);
    leanPivot.add(handlebar);

    // Pedal cranks at the bottom bracket (they turn with the pedal phase, the pedals stay level)
    const bikeFrame = {
      seat: new THREE.Vector3(0, 0.98, -0.28),
      bars: new THREE.Vector3(0, 0.98, 0.4),
      gripHalf: 0.22,
      bracket: new THREE.Vector3(0, 0.34, -0.145),
      crankLength: 0.17
    };
    const crankPivot = new THREE.Group();
    crankPivot.position.copy(bikeFrame.bracket);
    const crankGeo = new THREE.BoxGeometry(0.016, bikeFrame.crankLength, 0.03).translate(0, -bikeFrame.crankLength / 2, 0);
    const pedalGeo = new THREE.BoxGeometry(0.09, 0.018, 0.07);
    const pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.rotation.x = side > 0 ? 0 : Math.PI;
      const crank = new THREE.Mesh(crankGeo, chromeMat);
      crank.position.x = side * 0.065;
      const pedal = new THREE.Mesh(pedalGeo, tireMat);
      pedal.position.set(side * 0.1, -bikeFrame.crankLength, 0);
      arm.add(crank, pedal);
      crankPivot.add(arm);
      pedals.push(pedal);
    }
    leanPivot.add(crankPivot);

    // Skinned rider (see pedestrians.js), posed every frame with its hands on the grips and feet on the pedals; the
    // helmet rides on its head
    const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
    riderCrowd.meshes.forEach((m) => this.scene.add(m));
    const riderRig = new PersonRig({ seed: 12.8, scale: 1.0, girth: 0.97, hair: 0.1 });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMat);
    helmet.scale.set(0.95, 0.68, 1.28);
    this.scene.add(helmet);

    const bikeShadowGeo = new THREE.PlaneGeometry(0.85, 2.25);
    bikeShadowGeo.rotateX(-Math.PI * 0.5);
    const bikeShadow = new THREE.Mesh(bikeShadowGeo, createContactShadowMaterial());
    bikeShadow.position.set(0, 0.02, 0.0);
    bikeShadow.renderOrder = 998;
    root.add(bikeShadow);

    const headLight = new THREE.SpotLight(0xf2f7ff, 0, 20, 0.34, 0.76, 1.25);
    headLight.position.set(0, 1.32, 0.62);
    headLight.target.position.set(0, 0.0, 7.6);
    leanPivot.add(headLight, headLight.target);

    this.scene.add(root);
    const [x, z] = spawnAt(-12, 0.6);

    return {
      type: 'cyclist',
      verticalVel: 0,
      pitch: 0,
      label: 'Bicycle',
      mesh: root,
      leanPivot,
      frontWheel,
      rearWheel,
      crankPivot,
      pedals,
      bikeFrame,
      riderCrowd,
      riderRig,
      helmet,
      headLight,
      position: new THREE.Vector3(x, this.world.surfaceAt(x, z), z),
      heading: SPAWN[2],
      speed: 0,
      leanAngle: 0,
      pedalPhase: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.35, 0),
      chaseDistance: 4.8,
      chaseHeight: 2.05
    };
  }

  // =========================================================================
  // 4. HELICOPTER (3D LOFTED SIGHTSEEING TWIN-TURBINE CHOPPER)
  // =========================================================================
  createHelicopterEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerHelicopter';

    const tiltPivot = new THREE.Group();
    root.add(tiltPivot);

    const heliLoftMat = createLoftedHelicopterMaterial();
    const blurDiscMat = new THREE.MeshBasicNodeMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 1. 3D Lofted Monocoque Fuselage + Tailboom + Twin-Turbine Cowling + Swept Fin + Stabilizers + Tubular Skids
    const heliBodyGeo = buildHelicopterBodyGeometry();
    const heliBodyMesh = new THREE.Mesh(heliBodyGeo, heliLoftMat);
    heliBodyMesh.castShadow = true;
    heliBodyMesh.receiveShadow = true;
    tiltPivot.add(heliBodyMesh);

    // 2. 4-Blade Main Rotor Assembly with Swashplate, Hub Dome & Yellow Safety Blade Tips
    const mainRotorPivot = new THREE.Group();
    mainRotorPivot.position.set(0, 2.66, -0.35);
    const mainRotorGeo = buildHelicopterMainRotorGeometry();
    const mainRotorMesh = new THREE.Mesh(mainRotorGeo, heliLoftMat);
    mainRotorMesh.castShadow = true;
    mainRotorPivot.add(mainRotorMesh);

    const blurDisc = new THREE.Mesh(new THREE.CylinderGeometry(4.85, 4.85, 0.015, 32), blurDiscMat);
    mainRotorPivot.add(blurDisc);
    tiltPivot.add(mainRotorPivot);

    // 3. 4-Blade Tail Rotor Assembly on Swept Vertical Fin
    const tailRotorPivot = new THREE.Group();
    tailRotorPivot.position.set(0.18, 2.02, -5.62);
    const tailRotorGeo = buildHelicopterTailRotorGeometry();
    const tailRotorMesh = new THREE.Mesh(tailRotorGeo, heliLoftMat);
    tailRotorPivot.add(tailRotorMesh);
    tiltPivot.add(tailRotorPivot);

    // 4. FAA Port (Red), Starboard (Green) & Anti-Collision Fin Beacon (Red) Navigation Strobes
    const navRed = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff2b2b })
    );
    navRed.position.set(-1.09, 1.54, -4.35);
    const navGreen = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0x22ff66 })
    );
    navGreen.position.set(1.09, 1.54, -4.35);
    const navTail = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff3b2b })
    );
    navTail.position.set(0, 2.84, -6.04);
    tiltPivot.add(navRed, navGreen, navTail);

    this.scene.add(root);
    // Hovering over Uhuru Park, north-west of KICC, turned towards the CBD
    const [x, z] = [-560, 80];

    return {
      type: 'helicopter',
      verticalVel: 0,
      pitch: 0,
      label: 'Sightseeing Helicopter',
      mesh: root,
      tiltPivot,
      mainRotorPivot,
      tailRotorPivot,
      position: new THREE.Vector3(x, this.world.surfaceAt(x, z) + 90, z),
      heading: Math.atan2(560, -80),
      speed: 0,
      verticalSpeed: 0,
      pitchAngle: 0,
      rollAngle: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 11.4,
      chaseHeight: 3.3
    };
  }

  // The surface under (x, z) for a body now at height y (colliders.js): the terrain, a deck it can step onto, and for
  // the helicopter the roofs. Without y, the terrain or a deck there (the highest one).
  // The surface under a body at height y: the terrain, a deck, or a roof it is on (the helicopter lands on roofs; on
  // foot or wheels one is only on a roof when put there: nairobi.roof() in main.js)
  getGroundHeight(x, z, mode = 'person', y = Infinity) {
    return this.world.surfaceAt(x, z, y, mode === 'helicopter' || Number.isFinite(y));
  }

  // Grade (rise per metre) of the surface under an entity along its heading, from halfL ahead to halfL behind, and its
  // pitch with it, eased (rotation.x: positive dips the nose, see update()). Like the traffic it doesn't roll: across
  // a street the terrain grid's slopes are noise.
  followSlope(e, halfL, dt) {
    const sin = Math.sin(e.heading), cos = Math.cos(e.heading);
    const g = (ahead) => this.getGroundHeight(e.position.x + sin * ahead, e.position.z + cos * ahead, e.type, e.position.y);
    const grade = (g(halfL) - g(-halfL)) / (2 * halfL);
    e.pitch += (-Math.atan(grade) - e.pitch) * Math.min(1, dt * 12);
    return grade;
  }

  // Stand a vehicle on the surface under it, or let it fall if that is further down than a slope would take it
  settle(e, dt) {
    const ground = this.getGroundHeight(e.position.x, e.position.z, e.type, e.position.y);
    if (e.position.y - ground > 0.3 || e.verticalVel > 0) {
      e.verticalVel -= GRAVITY * dt;
      e.position.y += e.verticalVel * dt;
    }
    if (e.position.y <= ground + 0.3 && e.verticalVel <= 0) {
      e.position.y = ground;
      e.verticalVel = 0;
    }
  }

  resolveHorizontalCollision(pos, radius, carEntity = null, entity = carEntity) {
    // The detailed area (the helicopter may roam out over the ground around it)
    const heli = this.activeMode === 'helicopter';
    const inset = heli ? -HELI_MARGIN : EDGE;
    const x = Math.max(BOUNDS.minX + inset, Math.min(BOUNDS.maxX - inset, pos.x));
    const z = Math.max(BOUNDS.minZ + inset, Math.min(BOUNDS.maxZ - inset, pos.z));
    if ((x !== pos.x || z !== pos.z) && carEntity && carEntity.speed) carEntity.speed *= 0.4;
    pos.x = x;
    pos.z = z;

    const body = collisionBody(this.activeMode, radius, carEntity ? carEntity.heading : 0);
    const { sin: sinH, cos: cosH, extX, extZ } = body;
    const contact = this._buildingContact ??= { nx: 0, nz: 0, depth: 0 };

    const reach = Math.max(extX, extZ) + 6;
    let gx = pos.x;
    let gz = pos.z;
    let near = [...this.world.nearWalls(gx, gz, reach)];
    // Inside a footprint (dropped there, or through a corner between two walls): out through the nearest wall first
    const solid = this.world.solidAt(pos.x, pos.z, pos.y + body.bottom, pos.y + body.top);
    if (solid) this.leaveSolid(pos, solid, radius);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (wallContact(c, pos.x, pos.y, pos.z, body, contact)) {
        const { nx, nz, depth } = contact;
        pos.x += nx * depth;
        pos.z += nz * depth;

        if (this._collisionListener && entity && entity.type !== 'person') {
          const sin = carEntity ? sinH : Math.sin(entity.heading);
          const cos = carEntity ? cosH : Math.cos(entity.heading);
          const approachSpeed = -((sin * entity.speed + (entity.vx || 0)) * nx + (cos * entity.speed + (entity.vz || 0)) * nz);
          const support = carEntity ? Math.abs(nx * cos - nz * sin) * 0.86 + Math.abs(nx * sin + nz * cos) * 2.18 : radius;
          this.reportCollision(entity, c, 'building', pos.x - nx * support, pos.y + (heli ? 1.1 : 0.56), pos.z - nz * support,
            nx, 0, nz, approachSpeed);
        }

        if (carEntity) {
          const totalVx = sinH * carEntity.speed + (carEntity.vx || 0);
          const totalVz = cosH * carEntity.speed + (carEntity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          if (vn > 0.5) {
            const headOn = Math.abs(sinH * nx + cosH * nz);
            const sideDot = cosH * nx - sinH * nz;
            carEntity.vx = (carEntity.vx || 0) + nx * vn * 0.42;
            carEntity.vz = (carEntity.vz || 0) + nz * vn * 0.42;
            if (headOn > 0.72) {
              carEntity.speed = -carEntity.speed * 0.25;
            } else {
              carEntity.speed *= (1.0 - 0.62 * headOn);
              carEntity.angularVel = (carEntity.angularVel || 0) + sideDot * (sinH * nx + cosH * nz >= 0 ? -1 : 1) * Math.min(3.2, vn * 0.22);
            }
            carEntity.pitchVel = (carEntity.pitchVel || 0) + (sinH * nx + cosH * nz) * Math.min(14.0, vn) * 0.16;
            carEntity.rollVel = (carEntity.rollVel || 0) - sideDot * Math.min(14.0, vn) * 0.22;
            carEntity.heaveVel = (carEntity.heaveVel || 0) + Math.min(1.4, vn * 0.11);
            if (vn > 2.2) {
              carEntity.lastCollisionSpark = {
                x: pos.x - nx * extX * 0.92,
                y: pos.y + 0.56,
                z: pos.z - nz * extZ * 0.92,
                nx,
                nz,
                speed: vn
              };
            }
          }
        }

        // A push that carried it far from where the walls were gathered: gather them again around where it is now
        if (Math.abs(pos.x - gx) > 5 || Math.abs(pos.z - gz) > 5) {
          gx = pos.x;
          gz = pos.z;
          near = [...this.world.nearWalls(gx, gz, reach)];
          i = -1;
        }
      }
    }
  }

  // Move pos out of footprint `solid` through its nearest wall, `clearance` m beyond it
  leaveSolid(pos, solid, clearance) {
    let best = Infinity, bx = 0, bz = 0;
    for (const ring of [solid.ring, ...solid.holes]) {
      for (let i = 0, n = ring.length / 2; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[2 * i], az = ring[2 * i + 1], dx = ring[2 * j] - ax, dz = ring[2 * j + 1] - az;
        const t = Math.max(0, Math.min(1, ((pos.x - ax) * dx + (pos.z - az) * dz) / (dx * dx + dz * dz || 1)));
        const qx = ax + dx * t, qz = az + dz * t;
        const d = Math.hypot(qx - pos.x, qz - pos.z);
        if (d < best) [best, bx, bz] = [d, qx, qz];
      }
    }
    if (best === Infinity) return;
    const ux = (bx - pos.x) / (best || 1), uz = (bz - pos.z) / (best || 1);
    pos.x = bx + ux * (clearance + 0.05);
    pos.z = bz + uz * (clearance + 0.05);
  }

  // Pose the skinned characters once every entity has moved: the pedestrian's rig walks (or runs, turns, jumps) it to
  // where it now is, planting its feet on the ground; the cyclist sits on the bike, hands on the grips, feet on the
  // pedals, helmet on its head
  poseCharacters(dt) {
    const p = this.entities.person;
    const air = p.position.y - this.getGroundHeight(p.position.x, p.position.z, 'person', p.position.y);
    p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, air > 0.02 ? air : 0);
    p.crowd.begin();
    p.crowd.add(p.rig, 0);
    p.crowd.end();

    const b = this.entities.cyclist;
    b.riderRig.ride(b.leanPivot, b.pedalPhase, b.bikeFrame);
    b.riderCrowd.begin();
    b.riderCrowd.add(b.riderRig, 0);
    b.riderCrowd.end();
    b.helmet.quaternion.copy(b.riderRig.headQuaternion);
    b.helmet.position.set(0, 0.175, -0.012).applyQuaternion(b.helmet.quaternion).add(b.riderRig.headPosition);
  }

  update(dt, elapsed) {
    const heli = this.entities.helicopter;
    heli.mainRotorPivot.rotation.y += dt * 24.0;
    heli.tailRotorPivot.rotation.x += dt * 32.0;

    // The others wait where they were left
    if (this.activeMode === 'person') {
      this.updatePerson(dt, elapsed);
    } else if (this.activeMode === 'car') {
      this.updateCar(dt, elapsed);
    } else if (this.activeMode === 'cyclist') {
      this.updateCyclist(dt, elapsed);
    } else if (this.activeMode === 'helicopter') {
      this.updateHelicopter(dt, elapsed);
    }

    // Vehicles pitch with the ground under them, about their own x
    for (const key of Object.keys(this.entities)) {
      const e = this.entities[key];
      e.mesh.position.copy(e.position);
      e.mesh.rotation.set(e.pitch || 0, e.heading, 0, 'YXZ');
    }

    // Modulate clustered vehicle & bike lights by time of day (off during Midday & Golden Hour; fade in at Dusk & Night)
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = Math.min(1.28, Math.max(0.0, (glow - 0.60) * 1.45));
    const car = this.entities.car;
    if (car.headLights) {
      for (const spot of car.headLights) {
        // Accelerating does not change the headlamp output or range.
        spot.intensity = HEADLIGHTS.intensity * beamScale;
      }
    }
    const bike = this.entities.cyclist;
    if (bike.headLight) {
      const bikeActive = this.activeMode === 'cyclist';
      bike.headLight.intensity = bikeActive ? 115 * beamScale : 0;
    }

    this.poseCharacters(dt);
  }

  updatePerson(dt) {
    const p = this.entities.person;
    const maxSpeed = 8.2;
    const turnRate = 2.6;

    let targetSpeed = 0;
    if (this.keys.forward) targetSpeed = maxSpeed * this.keys.forward;
    else if (this.keys.backward) targetSpeed = -maxSpeed * 0.65 * this.keys.backward;

    if (this.keys.left) p.heading += turnRate * dt * this.keys.left;
    if (this.keys.right) p.heading -= turnRate * dt * this.keys.right;

    const accelerating = Math.abs(targetSpeed) > Math.abs(p.speed) && p.speed * targetSpeed >= 0;
    const acceleration = accelerating ? 5.5 * Math.abs(targetSpeed) / maxSpeed : 12;
    p.speed += Math.max(-acceleration * dt, Math.min(acceleration * dt, targetSpeed - p.speed));

    p.position.x += Math.sin(p.heading) * p.speed * dt;
    p.position.z += Math.cos(p.heading) * p.speed * dt;
    this.resolveHorizontalCollision(p.position, 0.48);

    const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person', p.position.y);
    if (this.keys.up && p.position.y <= groundY + 0.02) {
      p.verticalVel = 5.2;
    }
    p.verticalVel -= 14.5 * dt;
    p.position.y += p.verticalVel * dt;
    if (p.position.y < groundY) {
      p.position.y = groundY;
      p.verticalVel = 0;
    }
  }

  updateCar(dt) {
    if (dt <= 0) return;
    const c = this.entities.car;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -this.keys.backward;

    const braking = c.speed * throttle < 0;

    let steerInput = 0;
    if (this.keys.left) steerInput = this.keys.left;
    if (this.keys.right) steerInput = -this.keys.right;

    const prevX = c.position.x;
    const prevZ = c.position.z;
    c.prevX = prevX;
    c.prevZ = prevZ;
    // Hills pull the car back (or on) along its heading; a car standing still with no throttle holds on its brake
    const grade = this.followSlope(c, 1.4, dt);
    const roll = !c.verticalVel && (throttle || Math.abs(c.speed) > 0.5) ? GRAVITY * grade / Math.sqrt(1 + grade * grade) : 0;
    // Short steps keep grip, impacts and suspension consistent at different display rates.
    const steps = Math.ceil(dt * 120);
    const step = dt / steps;
    const steerResponse = 1 - Math.exp(-10 * step);
    const yawResponse = 1 - Math.exp(-5 * step);
    const tireResponse = 1 - Math.exp(-4 * step);
    for (let i = 0; i < steps; i++) {
      const sin = Math.sin(c.heading), cos = Math.cos(c.heading);
      const vx = sin * c.speed + c.vx, vz = cos * c.speed + c.vz;
      const forward = vx * sin + vz * cos;
      const sideways = vx * cos - vz * sin;
      const speed = driveSpeed(forward, throttle, step, CAR_DRIVE) - roll * step;
      const acceleration = (speed - forward) / step;
      // Braking and cornering share tire grip; air resistance does not use it.
      const tireAcceleration = acceleration + CAR_DRIVE.drag * forward * Math.abs(forward);
      const grip = Math.sqrt(Math.max(0, CAR_DRIVE.grip ** 2 - tireAcceleration ** 2));
      // A handbrake slide preserves steering while reducing lateral grip; fade it out at low speed.
      const handbrake = forward * throttle < 0 ? Math.abs(throttle) * Math.min(1, Math.abs(forward) / 5) : 0;
      const lateralGrip = grip * (1 - 0.7 * handbrake);
      const steeringGrip = grip + (CAR_DRIVE.grip - grip) * handbrake;

      // Full lock at parking speeds, progressively less steering at road speeds.
      const turn = CAR_DRIVE.wheelbase * CAR_DRIVE.cornering;
      const maxSteer = Math.atan(turn / Math.max(speed * speed, turn / Math.tan(0.60)));
      c.steerAngle += (steerInput * maxSteer - c.steerAngle) * steerResponse;
      const yawLimit = steeringGrip / Math.max(2, Math.abs(speed));
      const targetYaw = Math.max(-yawLimit, Math.min(yawLimit, speed * Math.tan(c.steerAngle) / CAR_DRIVE.wheelbase));
      // Collision spin remains part of the yaw velocity; the tires gradually regain control.
      const yawStep = steeringGrip * 0.65 * step;
      c.angularVel += Math.max(-yawStep, Math.min(yawStep, (targetYaw - c.angularVel) * yawResponse));
      c.heading += c.angularVel * step;

      // Turning the chassis must not instantly rotate its momentum. Tires remove sideways slip
      // with a bounded force; longitudinal momentum, including impacts, stays in speed.
      const nextSin = Math.sin(c.heading), nextCos = Math.cos(c.heading);
      const worldX = sin * speed + cos * sideways;
      const worldZ = cos * speed - sin * sideways;
      c.speed = worldX * nextSin + worldZ * nextCos;
      const slip = worldX * nextCos - worldZ * nextSin;
      const correction = Math.max(-lateralGrip * step, Math.min(lateralGrip * step, -slip * tireResponse));
      c.vx = nextCos * (slip + correction);
      c.vz = -nextSin * (slip + correction);
      c.position.x += (nextSin * c.speed + c.vx) * step;
      c.position.z += (nextCos * c.speed + c.vz) * step;
      this.resolveHorizontalCollision(c.position, 1.35, c);

      const targetPitch = -Math.max(-1, Math.min(1, acceleration / CAR_DRIVE.acceleration)) * 0.026;
      const targetRoll = Math.max(-0.09, Math.min(0.09, correction / step * 0.012));
      c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * 68 - c.pitchVel * 11.2) * step;
      c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * 68 - c.rollVel * 11.2) * step;
      c.chassisPivot.rotation.x = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.x + c.pitchVel * step));
      c.chassisPivot.rotation.z = Math.max(-0.26, Math.min(0.26, c.chassisPivot.rotation.z + c.rollVel * step));
      c.heaveVel += (-c.heaveY * 85 - c.heaveVel * 12) * step;
      c.heaveY = Math.max(-0.08, Math.min(0.14, c.heaveY + c.heaveVel * step));
    }
    this.settle(c, dt);
    c.chassisPivot.position.y = c.heaveY;

    if (c.carState) {
      c.carState.value.x = braking ? 1 : 0;
      c.carState.value.w = c.speed < -0.2 ? 1 : 0;
    }

    const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
    const rawWheelStep = forwardDist / 0.35;
    const wheelStep = Math.sign(rawWheelStep) * Math.min(Math.abs(rawWheelStep), 0.48);
    c.wheelSpin = (c.wheelSpin + wheelStep) % (Math.PI * 2);
    for (const w of c.wheels) {
      w.tire.rotation.x = c.wheelSpin + (w.isFront ? 0.0 : 0.55);
      if (w.isFront) {
        w.steerPivot.rotation.y = c.steerAngle;
      }
    }
  }

  updateCyclist(dt) {
    const b = this.entities.cyclist;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -0.6 * this.keys.backward;

    const grade = this.followSlope(b, 0.58, dt);
    b.speed = driveSpeed(b.speed, throttle, dt, BICYCLE_DRIVE);
    if (!b.verticalVel && (throttle || Math.abs(b.speed) > 0.5)) b.speed -= GRAVITY * grade / Math.sqrt(1 + grade * grade) * dt;

    let turnInput = 0;
    if (this.keys.left) turnInput = this.keys.left;
    if (this.keys.right) turnInput = -this.keys.right;

    if (Math.abs(b.speed) > 0.15) {
      const dirSign = b.speed >= 0 ? 1 : -1;
      b.heading += turnInput * 2.15 * dirSign * dt;
    }

    b.position.x += Math.sin(b.heading) * b.speed * dt;
    b.position.z += Math.cos(b.heading) * b.speed * dt;
    this.resolveHorizontalCollision(b.position, 0.65, null, b);
    this.settle(b, dt);

    const targetLean = -turnInput * Math.min(1.0, Math.abs(b.speed) / 9.0) * 0.34;
    b.leanAngle += (targetLean - b.leanAngle) * Math.min(1, dt * 9);
    b.leanPivot.rotation.z = b.leanAngle;

    const wheelDelta = (b.speed / 0.35) * dt;
    b.frontWheel.rotation.x += wheelDelta;
    b.rearWheel.rotation.x += wheelDelta;

    // The cranks turn with the rear wheel through the gears while pedalling (~110 rpm at cruising speed) and
    // freewheel otherwise; the rider's feet follow the pedals (see poseCharacters)
    if (throttle > 0 && wheelDelta > 0) b.pedalPhase += wheelDelta / 3.2;
    b.crankPivot.rotation.x = b.pedalPhase;
    for (const pedal of b.pedals) pedal.rotation.x = -b.pedalPhase;
  }

  updateHelicopter(dt, elapsed) {
    const h = this.entities.helicopter;
    const maxHorizSpeed = 52.0;
    const maxVertSpeed = 16.0;

    let fwdInput = 0;
    if (this.keys.forward) fwdInput = this.keys.forward;
    else if (this.keys.backward) fwdInput = -this.keys.backward;

    let yawInput = 0;
    if (this.keys.left) yawInput = this.keys.left;
    if (this.keys.right) yawInput = -this.keys.right;

    let vertInput = 0;
    if (this.keys.up) vertInput = this.keys.up;
    else if (this.keys.down) vertInput = -this.keys.down;

    if (fwdInput !== 0) {
      h.speed += fwdInput * 24.0 * dt;
      h.speed = Math.max(-maxHorizSpeed * 0.6, Math.min(maxHorizSpeed, h.speed));
    } else {
      h.speed *= Math.max(0, 1 - dt * 1.8);
    }

    if (vertInput !== 0) {
      h.verticalSpeed += vertInput * 22.0 * dt;
      h.verticalSpeed = Math.max(-maxVertSpeed, Math.min(maxVertSpeed, h.verticalSpeed));
    } else {
      h.verticalSpeed *= Math.max(0, 1 - dt * 3.5);
    }

    h.heading += yawInput * 1.45 * dt;

    h.position.x += Math.sin(h.heading) * h.speed * dt;
    h.position.z += Math.cos(h.heading) * h.speed * dt;
    h.position.y += h.verticalSpeed * dt;

    // Down to the ground or a roof (it lands on them), and no higher than the ceiling
    const floor = this.getGroundHeight(h.position.x, h.position.z, 'helicopter', h.position.y) + 0.25;
    if (h.position.y < floor) {
      this.reportCollision(h, groundCollider, 'ground', h.position.x, floor, h.position.z, 0, 1, 0, -h.verticalSpeed);
      h.verticalSpeed = Math.max(0, h.verticalSpeed);
    }
    h.position.y = Math.max(floor, Math.min(HELI_CEILING, h.position.y));
    this.resolveHorizontalCollision(h.position, 4.5, null, h);

    const targetPitch = (h.speed / maxHorizSpeed) * 0.24;
    const targetRoll = -yawInput * 0.28;
    h.pitchAngle += (targetPitch - h.pitchAngle) * Math.min(1, dt * 5);
    h.rollAngle += (targetRoll - h.rollAngle) * Math.min(1, dt * 5);

    h.tiltPivot.rotation.x = h.pitchAngle;
    h.tiltPivot.rotation.z = h.rollAngle;
    h.tiltPivot.position.y = Math.sin(elapsed * 2.6) * 0.18;
  }
}

export { ThirdPersonControllerManager };
