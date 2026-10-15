// Close-range ground detail for the walking view: grass tufts and pebbles scattered in a ring
// around the walker, tinted from the aerial imagery under each one, re-scattered as they move.
// The 0.8 m/px imagery is fine from the air; at eye height this is what makes it read as ground.

import * as THREE from 'three';

import { HALF, SIZE, roadDist, RIVER_W } from './terrain.js';

const RADIUS = 75;
const hash = (i, j, k) => {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const TUFTS = 9000;
const PEBBLES = 1600;

export class GroundClutter {
  constructor(terrain, world, imagery) {
    this.t = terrain;
    this.world = world;
    const g = imagery.getContext('2d');
    this.img = g.getImageData(0, 0, imagery.width, imagery.height).data;
    this.W = imagery.width;
    this.root = new THREE.Group();
    this.root.visible = false;

    // a tuft: five thin blades fanned around the centre
    const blade = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2, lean = 0.12;
      const cx = Math.cos(a), cz = Math.sin(a), px = -cz * 0.035, pz = cx * 0.035;
      blade.push(px, 0, pz, -px, 0, -pz, cx * lean, 0.42 + (k % 2) * 0.12, cz * lean);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(blade, 3));
    tg.computeVertexNormals();
    const tm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide });
    this.tufts = new THREE.InstancedMesh(tg, tm, TUFTS);
    this.tufts.userData.sensor = { heat: 0.3, xray: 'faint' };
    this.tufts.frustumCulled = false;
    const pg = new THREE.DodecahedronGeometry(0.12, 0);
    this.pebbles = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0x9a8f7e, roughness: 1, flatShading: true }), PEBBLES);
    this.pebbles.userData.sensor = { heat: 0.45, xray: 'dim' };
    this.pebbles.frustumCulled = false;
    this.pebbles.receiveShadow = true;
    this.root.add(this.tufts, this.pebbles);
    this.center = null;
  }

  colorAt(x, z, c) {
    const i = Math.min(this.W - 1, Math.max(0, Math.floor((x + HALF) / SIZE * this.W)));
    const j = Math.min(this.W - 1, Math.max(0, Math.floor((z + HALF) / SIZE * this.W)));
    const o = (j * this.W + i) * 4;
    return c.setRGB(this.img[o] / 255, this.img[o + 1] / 255, this.img[o + 2] / 255, THREE.SRGBColorSpace);
  }

  /**
   * Placement is a hashed grid (one candidate per cell), so the same tuft is always at the same
   * spot: re-scattering as the walker moves only adds and drops tufts at the ring's edge.
   */
  scatter(cx, cz) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0), e = new THREE.Euler();
    const pass = (cell, max, fn) => {
      let n = 0;
      const i0 = Math.floor((cx - RADIUS) / cell), i1 = Math.floor((cx + RADIUS) / cell);
      const j0 = Math.floor((cz - RADIUS) / cell), j1 = Math.floor((cz + RADIUS) / cell);
      for (let j = j0; j <= j1 && n < max; j++) for (let i = i0; i <= i1 && n < max; i++) {
        const h = (k) => hash(i, j, k);
        const x = (i + h(1)) * cell, z = (j + h(2)) * cell;
        if ((x - cx) ** 2 + (z - cz) ** 2 > RADIUS * RADIUS) continue;
        if (fn(n, x, z, h)) n++;
      }
      return n;
    };
    this.tufts.count = pass(1.5, TUFTS, (n, x, z, h) => {
      if (!this.ok(x, z)) return false;
      this.colorAt(x, z, c);
      // tufts where the imagery is vegetated (green dominant), sparse on bare earth
      if (c.g - (c.r + c.b) / 2 < 0 && h(3) > 0.12) return false;
      p.set(x, this.t.heightAt(x, z) - 0.02, z);
      q.setFromAxisAngle(up, h(4) * 6.28);
      const sc = 0.6 + h(5) * 0.9;
      s.set(sc, sc * (0.7 + h(6) * 0.7), sc);
      this.tufts.setMatrixAt(n, m.compose(p, q, s));
      c.offsetHSL(0.02 * (h(7) - 0.5), 0.05, 0.04 + 0.08 * (h(8) - 0.5));
      this.tufts.setColorAt(n, c);
      return true;
    });
    this.tufts.instanceMatrix.needsUpdate = true;
    if (this.tufts.instanceColor) this.tufts.instanceColor.needsUpdate = true;
    this.pebbles.count = pass(3.2, PEBBLES, (n, x, z, h) => {
      if (h(3) > 0.45 || !this.ok(x, z, true)) return false;
      p.set(x, this.t.heightAt(x, z) - 0.04, z);
      q.setFromEuler(e.set(h(4) * 3, h(5) * 3, h(6) * 3));
      const sc = 0.3 + h(7) * 1.4;
      s.set(sc * 1.3, sc * 0.6, sc);
      this.pebbles.setMatrixAt(n, m.compose(p, q, s));
      return true;
    });
    this.pebbles.instanceMatrix.needsUpdate = true;
    this.center = { x: cx, z: cz };
  }
  ok(x, z, road = false) {
    if (!this.t.inBounds(x, z, 1)) return false;
    if (this.t.riverDist(x, z) < RIVER_W + 1) return false;
    if (!road && roadDist(x, z) < 3.5) return false;
    for (const w of this.world.walls) if (x > w.x0 - 0.3 && x < w.x1 + 0.3 && z > w.z0 - 0.3 && z < w.z1 + 0.3) return false;
    for (const b of this.world.buildings) if (Math.abs(x - b.x) < b.w / 2 + 0.3 && Math.abs(z - b.z) < b.d / 2 + 0.3) return false;
    return true;
  }

  update(camCtl) {
    const on = camCtl.mode === 'GROUND' || (camCtl.cam.position.y - this.t.heightAt(camCtl.cam.position.x, camCtl.cam.position.z) < 60);
    this.root.visible = on;
    if (!on) return;
    const p = camCtl.cam.position;
    if (!this.center || Math.hypot(p.x - this.center.x, p.z - this.center.z) > 22) this.scatter(p.x, p.z);
  }
}
