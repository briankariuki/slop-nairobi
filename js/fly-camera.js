import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.js';

// Free-flying camera: click to capture the mouse (pointer lock) and look around, or drag with the mouse held down.
// WASD/arrows move along the view, Space/C rise and sink, Shift goes 4× faster, the wheel scales the base speed.
// The camera never drops below 1.7 m over the ground.

export class FlyCamera {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.yaw = 0;
    this.pitch = 0;
    this.speed = 40; // m/s
    this.keys = new Set();

    dom.addEventListener('click', () => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock?.()?.catch?.(() => {});
    });
    // drag-look needs a press that started on the canvas and a button still held on each move, so neither a mouseup
    // lost outside the window nor a button reported down without a press here can leave the camera turning
    this.dragging = false;
    dom.addEventListener('mousedown', (e) => (this.dragging = e.button === 0));
    dom.addEventListener('mousemove', (e) => {
      if (!(e.buttons & 1)) this.dragging = false;
      if (document.pointerLockElement !== dom && !this.dragging) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.55, 1.55);
    });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.speed = THREE.MathUtils.clamp(this.speed * Math.exp(-e.deltaY * 0.001), 3, 600);
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // place the camera at (x, y, z) looking at a point
  lookFrom(x, y, z, tx, ty, tz) {
    this.camera.position.set(x, y, z);
    const dx = tx - x;
    const dy = ty - y;
    const dz = tz - z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  update(dt) {
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const up = (k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0);
    const v = this.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1) * dt;

    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const p = this.camera.position;
    p.addScaledVector(dir, fwd * v).addScaledVector(right, side * v);
    p.y += up * v;
    p.y = Math.max(p.y, heightAt(p.x, p.z) + 1.7);

    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
}
