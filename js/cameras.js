import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.js';
import { FlyCamera } from './fly-camera.js';

// Slop New York's cameras.js (MIT, © 2026 Mr.doob), adapted for Nairobi: chase, action, cockpit, fixed-location and
// aerial cameras, with mouse/touch orbit and zoom, plus the free-flying camera (fly-camera.js). The follow cameras keep
// over the terrain and in front of the buildings between them and the player.

const CAMERA_PRESETS = [
  { id: 'chase',       name: 'Chase',                      category: 'follow', fov: 56 },
  { id: 'action',      name: 'Low-angle action',           category: 'follow', fov: 60 },
  { id: 'pov',         name: 'First person',               category: 'follow', fov: 68 },
  { id: 'kicc',        name: 'City Square & KICC',         category: 'scenic', fov: 52 },
  { id: 'kenyattaAve', name: 'Down Kenyatta Avenue',       category: 'scenic', fov: 50 },
  { id: 'uhuruPark',   name: 'Uhuru Park & the skyline',   category: 'scenic', fov: 48 },
  { id: 'upperHill',   name: 'From Upper Hill',            category: 'scenic', fov: 46 },
  { id: 'drone',       name: 'Aerial',                     category: 'scenic', fov: 50 },
  { id: 'free',        name: 'Free camera',                category: 'free',   fov: 60 }
];

// Scenic views at a height over the ground under them: [x, metres up, z]
const over = (v, x, up, z) => v.set(x, heightAt(x, z) + up, z);

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.35, 20000);
    this.fly = new FlyCamera(this.camera, domElement);
    this.fly.enabled = false;

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._dir = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (this.activePresetId === 'free') return; // the free camera does its own looking
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      if (this.activePresetId === 'free') return;
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const wasFree = this.activePresetId === 'free';
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    // The free camera takes over the keyboard and mouse from where the camera is now, and hands them back to the player
    const free = preset.id === 'free';
    if (free && !wasFree) {
      const p = this.camera.position;
      this._dir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.fly.lookFrom(p.x, p.y, p.z, p.x + this._dir.x, p.y + this._dir.y, p.z + this._dir.z);
    }
    if (!free && wasFree && document.pointerLockElement === this.domElement) document.exitPointerLock();
    this.fly.enabled = free;
    this.fly.keys.clear();
    this.controllerManager.inputEnabled = !free;
    if (free) this.controllerManager.resetInput();
    if (snapImmediately || wasFree) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // Pull a follow camera at `pos` in towards `target` until no building stands between them, and keep it over the ground
  keepInView(target, pos) {
    const world = this.controllerManager.world;
    const dir = this._dir.subVectors(pos, target);
    const dist = dir.length();
    dir.divideScalar(dist || 1);
    for (let d = 0.5; d <= dist; d += 0.5) {
      const x = target.x + dir.x * d, y = target.y + dir.y * d, z = target.z + dir.z * d;
      if (world.solidAt(x, z, y)) {
        pos.copy(target).addScaledVector(dir, Math.max(0.3, d - 0.6));
        break;
      }
    }
    pos.y = Math.max(pos.y, heightAt(pos.x, pos.z) + 0.4);
  }

  update(dt, elapsed) {
    if (this.activePresetId === 'free') {
      this.fly.update(dt);
      this.currentPos.copy(this.camera.position);
      return;
    }

    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const totalYaw = entity.heading + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          entity.position.y + height,
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        // aiming 5.2 m beyond the entity along the camera's own line of sight (straight ahead of it when the camera is
        // behind), so an orbit keeps it centred and swings round it in a circle
        const lookUpBias = entity.type === 'helicopter' ? 0.2 : (entity.type === 'car' ? 0.52 : 1.55);
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 5.2,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(totalYaw) * 5.2
        );
        break;
      }

      case 'action': {
        // Off to the right, over the middle of the road: Kenya drives on the left (New York's camera sits to the left)
        const sideOffset = -(entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95));
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          lowY,
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        let rightOffset = 0;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
          rightOffset = 0.36; // the driver's seat of a right-hand drive car
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset - Math.cos(entity.heading) * rightOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset + Math.sin(entity.heading) * rightOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'kicc': {
        // City Square, by the Jomo Kenyatta statue, looking up at KICC's tower and its saucer
        const sway = Math.sin(elapsed * 0.25) * 2.0;
        over(desiredPos, -95 + sway, 3.5, 115);
        over(desiredLook, 2, 62, -15);
        break;
      }

      case 'kenyattaAve': {
        // On Kenyatta Avenue by Uhuru Highway, looking east along it into the CBD
        const sway = Math.sin(elapsed * 0.3) * 1.5;
        over(desiredPos, -585, 7, -250 + sway);
        over(desiredLook, -160, 22, -472);
        break;
      }

      case 'uhuruPark': {
        // Over the boating lake in Uhuru Park, looking across to the CBD skyline
        const drift = Math.sin(elapsed * 0.15) * 25.0;
        over(desiredPos, -760 + drift, 32, 260);
        over(desiredLook, -60, 60, -160);
        break;
      }

      case 'upperHill': {
        // Above Upper Hill's towers, looking north-east down to the CBD
        const pan = Math.sin(elapsed * 0.18) * 60.0;
        over(desiredPos, -1180, 175, 1330);
        over(desiredLook, -150 + pan, 40, -220);
        break;
      }

      case 'drone': {
        const angle = elapsed * 0.07 + 0.65;
        const radius = 900.0 + Math.sin(elapsed * 0.23) * 160.0;
        const alt = 330.0 + Math.cos(elapsed * 0.19) * 90.0;
        desiredPos.set(Math.cos(angle) * radius - 250.0, alt, Math.sin(angle) * radius - 50.0);
        desiredLook.set(-250.0, 60.0, -50.0);
        break;
      }
    }

    const follow = this.activePresetId === 'chase' || this.activePresetId === 'action';
    if (follow) {
      this._target ??= new THREE.Vector3();
      this._target.copy(entity.position).add(entity.cameraTargetOffset);
      this.keepInView(this._target, desiredPos);
    }

    if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (follow) {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (hills, ramps, jumps, the helicopter climbing).
      //
      // The camera's offset is eased as an angle round the entity, a distance and a height, not as a vector: eased in a
      // straight line, an orbit drag (or a sharp turn) cut across the circle and swung the camera in close.
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      const want = desiredPos.sub(entity.position);
      const o = this.followOffset;
      const r0 = Math.hypot(o.x, o.z), r1 = Math.hypot(want.x, want.z);
      const a0 = Math.atan2(o.x, o.z), a1 = Math.atan2(want.x, want.z);
      let da = a1 - a0;
      da -= Math.round(da / (Math.PI * 2)) * Math.PI * 2;
      const a = a0 + da * k, r = r0 + (r1 - r0) * k;
      o.set(Math.sin(a) * r, o.y + (want.y - o.y) * k, Math.cos(a) * r);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(heightAt(this.currentPos.x, this.currentPos.z) + 0.4, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}

export { CAMERA_PRESETS, CameraSystem };
