// Three ways to look at the AO, and animated flights between them.
//
//   MAP     orbit a ground point: pan, rotate, tilt, zoom (the planning table)
//   ISR     an unmanned aircraft loitering over an aim point: slow orbit, narrow zoomable field
//           of view, slew the aim point by dragging (pair it with IR)
//   GROUND  walk at eye height: WASD, Shift to run, C to crouch, drag to look; walls collide
//
// Every mode reduces to a pose {pos, quat, fov}; switching mode flies from the current pose to
// the new one, so "go to ground" is a continuous dive from the map down to eye level.

import * as THREE from 'three';
import { clamp, lerp, easeInOut, DEG } from './util.js';
import { HALF } from './terrain.js';

const UP = new THREE.Vector3(0, 1, 0);

export class CameraController {
  constructor(stage, terrain, world) {
    this.stage = stage;
    this.cam = stage.cam;
    this.t = terrain;
    this.world = world;
    this.mode = 'MAP';
    this.map = { x: 0, z: 0, yaw: 0.35, pitch: 52 * DEG, dist: 1500 };
    this.isr = { x: 250, z: -180, ang: 0, radius: 700, alt: 520, fov: 9, speed: 0.025 };
    this.ground = { x: 0, z: 0, yaw: 0, pitch: 0, crouch: false, eye: 1.7, speed: 0 };
    this.keys = new Set();
    this.flight = null;
    this.focus = 1500;
    this.onMode = () => {};
    this.groundVisited = [];
    this._v = new THREE.Vector3();
  }

  // ---------------------------------------------------------------- poses
  mapPose() {
    const m = this.map;
    const ty = this.t.heightAt(m.x, m.z);
    const ch = Math.cos(m.pitch) * m.dist;
    const pos = new THREE.Vector3(m.x + Math.sin(m.yaw) * ch, ty + Math.sin(m.pitch) * m.dist, m.z + Math.cos(m.yaw) * ch);
    const q = lookQuat(pos, new THREE.Vector3(m.x, ty, m.z));
    return { pos, quat: q, fov: 50, focus: m.dist };
  }

  isrPose() {
    const s = this.isr;
    const ty = this.t.heightAt(s.x, s.z);
    const pos = new THREE.Vector3(s.x + Math.cos(s.ang) * s.radius, ty + s.alt, s.z + Math.sin(s.ang) * s.radius);
    const aim = new THREE.Vector3(s.x, ty + 1, s.z);
    return { pos, quat: lookQuat(pos, aim), fov: s.fov, focus: pos.distanceTo(aim) };
  }

  groundPose() {
    const g = this.ground;
    const pos = new THREE.Vector3(g.x, this.t.heightAt(g.x, g.z) + g.eye, g.z);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(g.pitch, g.yaw, 0, 'YXZ'));
    return { pos, quat: q, fov: 62, focus: this.groundFocus ?? 12 };
  }

  pose(mode = this.mode) {
    return mode === 'MAP' ? this.mapPose() : mode === 'ISR' ? this.isrPose() : this.groundPose();
  }

  // ---------------------------------------------------------------- mode changes
  /** Fly to a mode. opts: {x, z} the point of interest for ISR/GROUND/MAP. */
  go(mode, opts = {}) {
    const from = { pos: this.cam.position.clone(), quat: this.cam.quaternion.clone(), fov: this.cam.fov, focus: this.focus };
    if (mode === 'GROUND') {
      const x = clamp(opts.x ?? this.map.x, -HALF + 5, HALF - 5), z = clamp(opts.z ?? this.map.z, -HALF + 5, HALF - 5);
      Object.assign(this.ground, { x, z, pitch: -2 * DEG, crouch: false, eye: 1.7 });
      // face the way the camera was looking, or toward a given point
      this.ground.yaw = opts.faceX !== undefined ? Math.atan2(-(opts.faceX - x), -(opts.faceZ - z)) : this.mode === 'MAP' ? this.map.yaw : this.ground.yaw;
      const p = new THREE.Vector3(x, 0, z);
      this.world.collide(p, 0.4);
      this.ground.x = p.x; this.ground.z = p.z;
      this.groundVisited.push({ x: this.ground.x, z: this.ground.z });
    } else if (mode === 'ISR') {
      this.isr.x = opts.x ?? this.map.x; this.isr.z = opts.z ?? this.map.z;
      // start the orbit on the side the camera is already on
      this.isr.ang = Math.atan2(this.cam.position.z - this.isr.z, this.cam.position.x - this.isr.x);
    } else if (mode === 'MAP') {
      if (opts.x !== undefined) { this.map.x = opts.x; this.map.z = opts.z; }
      else if (this.mode === 'GROUND') { this.map.x = this.ground.x; this.map.z = this.ground.z; this.map.dist = 260; this.map.yaw = this.ground.yaw; this.map.pitch = 40 * DEG; }
      else if (this.mode === 'ISR') { this.map.x = this.isr.x; this.map.z = this.isr.z; }
      if (opts.dist) this.map.dist = opts.dist;
      if (opts.yaw !== undefined) this.map.yaw = opts.yaw;
      if (opts.pitch !== undefined) this.map.pitch = opts.pitch;
    }
    const prev = this.mode;
    this.mode = mode;
    const dur = opts.instant ? 0 : mode === 'GROUND' || prev === 'GROUND' ? 2.6 : 1.6;
    this.flight = dur ? { from, t: 0, dur, arc: mode === 'GROUND' ? 0 : 0.25 } : null;
    this.onMode(mode, prev);
  }

  // ---------------------------------------------------------------- input
  drag(dx, dy, button, shift) {
    if (this.flight) return;
    if (this.mode === 'MAP') {
      if (button === 2 || shift) {
        this.map.yaw -= dx * 0.005;
        this.map.pitch = clamp(this.map.pitch + dy * 0.004, 12 * DEG, 89 * DEG);
      } else {
        const k = this.map.dist * 0.0016;
        const c = Math.cos(this.map.yaw), s = Math.sin(this.map.yaw);
        this.map.x = clamp(this.map.x - (dx * c + dy * s) * k, -HALF, HALF);
        this.map.z = clamp(this.map.z - (-dx * s + dy * c) * k, -HALF, HALF);
      }
    } else if (this.mode === 'ISR') {
      // slew the aim point in screen space
      const k = this.focus * Math.tan((this.isr.fov * DEG) / 2) * 0.004;
      const r = new THREE.Vector3(1, 0, 0).applyQuaternion(this.cam.quaternion); r.y = 0; r.normalize();
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion); f.y = 0; f.normalize();
      this.isr.x = clamp(this.isr.x - (r.x * dx - f.x * dy) * k, -HALF, HALF);
      this.isr.z = clamp(this.isr.z - (r.z * dx - f.z * dy) * k, -HALF, HALF);
    } else {
      this.ground.yaw -= dx * 0.0035;
      this.ground.pitch = clamp(this.ground.pitch - dy * 0.0035, -80 * DEG, 80 * DEG);
    }
  }

  wheel(dy) {
    if (this.flight) return;
    if (this.mode === 'MAP') this.map.dist = clamp(this.map.dist * Math.exp(dy * 0.0012), 40, 2600);
    else if (this.mode === 'ISR') this.isr.fov = clamp(this.isr.fov * Math.exp(dy * 0.0012), 1.5, 45);
    else this.ground.pitch = clamp(this.ground.pitch - dy * 0.0008, -80 * DEG, 80 * DEG);
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    const k = this.keys;
    if (!this.flight) {
      if (this.mode === 'MAP') {
        const m = this.map, sp = m.dist * 0.7 * dt;
        let fx = 0, fz = 0;
        if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
        if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
        if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
        if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
        const c = Math.cos(m.yaw), s = Math.sin(m.yaw);
        m.x = clamp(m.x + (fx * c + fz * s) * sp, -HALF, HALF);
        m.z = clamp(m.z + (-fx * s + fz * c) * sp, -HALF, HALF);
        if (k.has('KeyQ')) m.yaw += dt * 0.8;
        if (k.has('KeyE')) m.yaw -= dt * 0.8;
        if (k.has('KeyR')) m.pitch = clamp(m.pitch + dt * 0.6, 12 * DEG, 89 * DEG);
        if (k.has('KeyF')) m.pitch = clamp(m.pitch - dt * 0.6, 12 * DEG, 89 * DEG);
        if (k.has('Equal') || k.has('NumpadAdd')) m.dist = clamp(m.dist * Math.exp(-dt * 1.2), 40, 2600);
        if (k.has('Minus') || k.has('NumpadSubtract')) m.dist = clamp(m.dist * Math.exp(dt * 1.2), 40, 2600);
      } else if (this.mode === 'ISR') {
        this.isr.ang += this.isr.speed * dt;
        if (k.has('Equal') || k.has('NumpadAdd')) this.isr.fov = clamp(this.isr.fov * Math.exp(-dt), 1.5, 45);
        if (k.has('Minus') || k.has('NumpadSubtract')) this.isr.fov = clamp(this.isr.fov * Math.exp(dt), 1.5, 45);
      } else {
        const g = this.ground;
        let fwd = 0, side = 0;
        if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
        if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
        if (k.has('KeyA')) side -= 1;
        if (k.has('KeyD')) side += 1;
        if (k.has('ArrowLeft')) g.yaw += dt * 1.6;
        if (k.has('ArrowRight')) g.yaw -= dt * 1.6;
        const run = k.has('ShiftLeft') || k.has('ShiftRight');
        const sp = g.crouch ? 1.0 : run ? 4.2 : 1.7;
        const len = Math.hypot(fwd, side) || 1;
        const vx = ((-Math.sin(g.yaw) * fwd + Math.cos(g.yaw) * side) / len) * sp;
        const vz = ((-Math.cos(g.yaw) * fwd - Math.sin(g.yaw) * side) / len) * sp;
        const moving = fwd || side;
        g.speed = moving ? sp : 0;
        if (moving) {
          const p = this._v.set(g.x + vx * dt, 0, g.z + vz * dt);
          // don't walk up cliffs or into the river
          const s = this.t.slopeAt(p.x, p.z);
          if (s < 38 && this.t.riverDist(p.x, p.z) > 7.5) {
            this.world.collide(p, 0.35);
            g.x = clamp(p.x, -HALF + 2, HALF - 2); g.z = clamp(p.z, -HALF + 2, HALF - 2);
          }
          this.bob = (this.bob || 0) + dt * sp * 2.4;
        }
        g.eye = lerp(g.eye, g.crouch ? 1.0 : 1.7, Math.min(1, dt * 8));
      }
    }

    const target = this.pose();
    let pos = target.pos, quat = target.quat, fov = target.fov, focus = target.focus;
    if (this.mode === 'GROUND' && !this.flight) {
      pos.y += Math.sin(this.bob || 0) * 0.025 * (this.ground.speed > 0 ? 1 : 0);
      // focus: what's straight ahead (terrain or a wall), smoothed
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
      const hit = this.t.raycast(pos, dir, 400);
      let d = hit ? hit.distanceTo(pos) : 120;
      for (let s = 1; s < Math.min(d, 60); s += 1.5) {
        if (this.world.wallsBlock(pos.x, pos.z, pos.x + dir.x * s, pos.z + dir.z * s)) { d = s; break; }
      }
      this.groundFocus = lerp(this.groundFocus ?? d, clamp(d, 2.5, 60), Math.min(1, dt * 3));
      focus = this.groundFocus;
    }
    if (this.flight) {
      const f = this.flight;
      f.t += dt / f.dur;
      const e = easeInOut(clamp(f.t, 0, 1));
      const p = f.from.pos.clone().lerp(pos, e);
      // a gentle arc so map-to-map jumps lift a little
      p.y += Math.sin(Math.PI * e) * f.arc * f.from.pos.distanceTo(pos);
      pos = p;
      quat = f.from.quat.clone().slerp(quat, e);
      fov = lerp(f.from.fov, fov, e);
      focus = lerp(f.from.focus, focus, e);
      // never dip into the ground mid-flight
      const gy = this.t.heightAt(pos.x, pos.z) + 1.2;
      if (pos.y < gy) pos.y = gy;
      if (f.t >= 1) this.flight = null;
    }
    this.cam.position.copy(pos);
    this.cam.quaternion.copy(quat);
    if (Math.abs(this.cam.fov - fov) > 1e-4) { this.cam.fov = fov; this.cam.updateProjectionMatrix(); }
    const near = this.mode === 'GROUND' || pos.y - this.t.heightAt(pos.x, pos.z) < 30 ? 0.15 : clamp(focus * 0.01, 0.5, 8);
    if (Math.abs(this.cam.near - near) > 1e-3) { this.cam.near = near; this.cam.updateProjectionMatrix(); }
    this.focus = focus;
    this.stage.focusDist = focus;
  }

  /** Camera ground position (for the HUD "self" marker). */
  get self() {
    if (this.mode === 'GROUND') return { x: this.ground.x, z: this.ground.z };
    if (this.mode === 'ISR') return { x: this.isr.x, z: this.isr.z };
    return { x: this.map.x, z: this.map.z };
  }

  /** Compass heading the camera faces, degrees. */
  get heading() {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion);
    return ((Math.atan2(f.x, -f.z) / DEG) + 360) % 360;
  }
}

function lookQuat(from, to) {
  const m = new THREE.Matrix4().lookAt(from, to, UP);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
