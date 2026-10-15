// Everything standing on the AO: the village of OBJ IRON (walled compounds, one- and two-storey
// houses with real interiors), the farm, the friendly assembly area, the enemy observation post
// on Hill 431, vehicles, sentries on patrol and instanced trees and rocks.
//
// Buildings are axis-aligned so walking collision and sight-line occlusion are cheap 2D box tests
// (`this.walls`). Each building is a group with walls, a door gap, windows, a roof slab and its
// contents; `userData.sensor` on each part says how hot it is and what the X-ray view shows.

import * as THREE from 'three';
import { rng, clamp, vnoise } from './util.js';
import { PLACES, HALF } from './terrain.js';

// ---------------------------------------------------------------- shared textures + materials
function stuccoTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#d9cbb0'; g.fillRect(0, 0, 256, 256);
  const id = g.getImageData(0, 0, 256, 256);
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
    const n = vnoise(i / 9, j / 9, 3) * 0.5 + vnoise(i / 2.5, j / 2.5, 5) * 0.3 + vnoise(i / 40, j / 40, 9) * 0.4;
    const o = (j * 256 + i) * 4, k = 0.78 + n * 0.3 - (j > 220 ? (j - 220) / 140 : 0);
    id.data[o] *= k; id.data[o + 1] *= k; id.data[o + 2] *= k;
  }
  g.putImageData(id, 0, 0);
  // rain streaks
  g.globalAlpha = 0.08; g.fillStyle = '#4a3c28';
  for (let k = 0; k < 40; k++) g.fillRect(Math.random() * 256, 0, 1 + Math.random() * 3, 40 + Math.random() * 120);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const M = {};
function mats() {
  if (M.ready) return M;
  const stucco = stuccoTexture();
  const wall = (hex) => new THREE.MeshStandardMaterial({ color: hex, map: stucco, roughness: 0.95 });
  M.walls = [wall(0xf2e3c6), wall(0xe7cfa4), wall(0xd8c3a5), wall(0xefe8dc), wall(0xcdb08a)];
  M.roof = new THREE.MeshStandardMaterial({ color: 0x9c8f7c, map: stucco, roughness: 1 });
  M.window = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.35, metalness: 0.2 });
  M.door = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.8 });
  M.metal = new THREE.MeshStandardMaterial({ color: 0x6b7072, roughness: 0.5, metalness: 0.6 });
  M.cloth = [0x4b5a3c, 0x6d6450, 0x3d3f44, 0x7a5c44, 0x2f3b4c, 0x8a8577].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
  M.skin = [0xc89a74, 0xa8784f, 0x8c5f3c].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }));
  M.friendly = new THREE.MeshStandardMaterial({ color: 0x59613f, roughness: 0.85 });
  M.truck = [0xd6d2c8, 0x8b2f25, 0x2b4f6e, 0xc9b98f].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.3 }));
  M.tyre = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
  M.glass = new THREE.MeshStandardMaterial({ color: 0x223038, roughness: 0.1, metalness: 0.6 });
  M.crate = new THREE.MeshStandardMaterial({ color: 0x5b5a3a, roughness: 0.8 });
  M.wood = new THREE.MeshStandardMaterial({ color: 0x6e5236, roughness: 0.9 });
  M.rug = new THREE.MeshStandardMaterial({ color: 0x7d2a24, roughness: 1 });
  M.sand = new THREE.MeshStandardMaterial({ color: 0xa89470, roughness: 1 });
  M.net = new THREE.MeshStandardMaterial({ color: 0x5c6440, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.92 });
  M.ready = true;
  return M;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
BOX.translate(0, 0.5, 0); // origin at the base
function box(mat, w, h, d, x, y, z, sensor) {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  if (sensor) m.userData.sensor = sensor;
  return m;
}

// ---------------------------------------------------------------- people
const CAP = new THREE.CapsuleGeometry(0.17, 0.5, 4, 8);
const HEAD = new THREE.SphereGeometry(0.12, 12, 10);
const LIMB = new THREE.CapsuleGeometry(0.065, 0.62, 3, 6);
const ARM = new THREE.CapsuleGeometry(0.05, 0.5, 3, 6);
const RIFLE = new THREE.BoxGeometry(0.06, 0.08, 0.85);

export function makePerson(r, { friendly = false, armed = false, pose = 'stand' } = {}) {
  const m = mats();
  const g = new THREE.Group();
  const cloth = friendly ? M.friendly : r.pick(M.cloth), skin = r.pick(M.skin);
  const hot = { heat: 0.95, xray: 'occupant' };
  const body = new THREE.Mesh(CAP, cloth); body.position.y = 1.18; body.userData.sensor = { heat: 0.86, xray: 'occupant' };
  const head = new THREE.Mesh(HEAD, skin); head.position.y = 1.62; head.userData.sensor = hot;
  const legL = new THREE.Mesh(LIMB, cloth), legR = new THREE.Mesh(LIMB, cloth);
  for (const [leg, x] of [[legL, -0.09], [legR, 0.09]]) {
    leg.geometry = LIMB; leg.position.set(x, 0.45, 0); leg.userData.sensor = { heat: 0.8, xray: 'occupant' };
  }
  const armL = new THREE.Mesh(ARM, cloth), armR = new THREE.Mesh(ARM, cloth);
  armL.position.set(-0.24, 1.2, 0); armR.position.set(0.24, 1.2, 0);
  armL.userData.sensor = armR.userData.sensor = { heat: 0.86, xray: 'occupant' };
  g.add(body, head, legL, legR, armL, armR);
  if (armed) {
    const gun = new THREE.Mesh(RIFLE, M.metal); gun.position.set(0.12, 1.15, 0.28); gun.rotation.x = -0.25;
    gun.userData.sensor = { heat: 0.42, xray: 'dense' };
    g.add(gun);
  }
  for (const c of g.children) c.castShadow = true;
  if (pose === 'sit') { g.scale.y = 0.72; legL.rotation.x = legR.rotation.x = -1.2; legL.position.z = legR.position.z = 0.25; }
  g.userData.parts = { legL, legR, armL, armR };
  g.userData.kind = 'person';
  return g;
}

export function animateWalk(p, phase, speed) {
  const { legL, legR, armL, armR } = p.userData.parts;
  const s = Math.sin(phase) * 0.55 * clamp(speed, 0, 1.5);
  legL.rotation.x = s; legR.rotation.x = -s; armL.rotation.x = -s * 0.7; armR.rotation.x = s * 0.7;
}

// ---------------------------------------------------------------- vehicles
const WHEEL = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 16).rotateZ(Math.PI / 2);
function makePickup(r, { running = false, armed = false } = {}) {
  mats();
  const g = new THREE.Group();
  const paint = r.pick(M.truck);
  const engine = { heat: running ? 0.88 : 0.4, xray: 'dense' };
  g.add(box(paint, 1.9, 0.7, 4.8, 0, 0.55, 0, { heat: running ? 0.55 : 0.38, xray: 'dense' }));
  const hood = box(paint, 1.86, 0.25, 1.4, 0, 1.25, -1.6, engine); g.add(hood);
  g.add(box(paint, 1.86, 0.95, 1.6, 0, 1.25, -0.2, { heat: running ? 0.52 : 0.38, xray: 'dense' }));
  g.add(box(M.glass, 1.8, 0.55, 0.05, 0, 1.55, -1.02, { heat: 0.3, xray: 'dim' }));
  g.add(box(paint, 0.06, 0.45, 2.1, -0.92, 1.25, 1.35), box(paint, 0.06, 0.45, 2.1, 0.92, 1.25, 1.35), box(paint, 1.9, 0.45, 0.06, 0, 1.25, 2.38));
  for (const [x, z] of [[-0.95, -1.5], [0.95, -1.5], [-0.95, 1.5], [0.95, 1.5]]) {
    const w = new THREE.Mesh(WHEEL, M.tyre); w.position.set(x, 0.42, z); w.castShadow = true;
    w.userData.sensor = { heat: running ? 0.7 : 0.36, xray: 'dense' }; g.add(w);
  }
  const exhaust = box(M.metal, 0.12, 0.12, 0.5, 0.7, 0.3, 2.3, { heat: running ? 0.98 : 0.4, xray: 'dense' });
  g.add(exhaust);
  if (armed) {
    g.add(box(M.metal, 0.12, 0.9, 0.12, 0, 1.25, 1.2, { heat: 0.45, xray: 'dense' }));
    g.add(box(M.metal, 0.14, 0.14, 1.5, 0, 2.1, 0.9, { heat: 0.45, xray: 'dense' }));
  }
  g.userData.kind = 'vehicle';
  g.userData.running = running;
  g.userData.hot = [hood, exhaust];
  return g;
}

function makeMRAP(r) {
  mats();
  const g = new THREE.Group();
  const s = { heat: 0.45, xray: 'dense' };
  g.add(box(M.friendly, 2.5, 1.5, 6.4, 0, 0.9, 0, s));
  g.add(box(M.friendly, 2.4, 0.9, 2.0, 0, 2.4, -1.8, s));
  g.add(box(M.glass, 2.2, 0.45, 0.05, 0, 2.8, -2.82, { heat: 0.3, xray: 'dim' }));
  g.add(box(M.metal, 0.9, 0.6, 0.9, 0, 3.3, 0.6, s));
  for (const z of [-2.1, 0, 2.1]) for (const x of [-1.25, 1.25]) {
    const w = new THREE.Mesh(WHEEL, M.tyre); w.scale.set(1.3, 1.45, 1.45); w.position.set(x, 0.6, z); w.castShadow = true;
    w.userData.sensor = { heat: 0.4, xray: 'dense' }; g.add(w);
  }
  g.userData.kind = 'vehicle';
  return g;
}

// ---------------------------------------------------------------- buildings
function makeBuilding(r, b) {
  mats();
  const g = new THREE.Group();
  const { w, d, floors } = b;
  const H = 3.2 * floors, T = 0.3;
  const wm = r.pick(M.walls);
  const shell = (heat) => ({ heat, xray: 'shell' });
  // Occupied houses leak heat: warmer walls and roof, glowing windows (what IR keys on at night).
  const wallHeat = b.occupied ? 0.53 : 0.46;
  const walls = [];
  const addWall = (x0, z0, x1, z1, h = H, y = 0) => {
    const ww = Math.max(T, x1 - x0), dd = Math.max(T, z1 - z0);
    const m = box(wm, ww, h, dd, (x0 + x1) / 2, y, (z0 + z1) / 2, shell(wallHeat));
    g.add(m);
    if (y === 0) walls.push({ x0, z0, x1, z1 });
    return m;
  };
  // door on the side facing b.door: 'N' 'S' 'E' 'W'
  const dw = 1.1, dh = 2.1;
  const sides = {
    N: [-w / 2, -d / 2 - T / 2, w / 2, -d / 2 + T / 2, 'x'],
    S: [-w / 2, d / 2 - T / 2, w / 2, d / 2 + T / 2, 'x'],
    W: [-w / 2 - T / 2, -d / 2, -w / 2 + T / 2, d / 2, 'z'],
    E: [w / 2 - T / 2, -d / 2, w / 2 + T / 2, d / 2, 'z'],
  };
  for (const [k, [x0, z0, x1, z1, ax]] of Object.entries(sides)) {
    if (k === b.door) {
      const c = b.doorAt ?? 0;
      if (ax === 'x') {
        addWall(x0, z0, c - dw / 2, z1); addWall(c + dw / 2, z0, x1, z1); addWall(c - dw / 2, z0, c + dw / 2, z1, H - dh, dh);
        const door = box(M.door, dw, dh, 0.06, c - (b.open ? 0.5 : 0), 0, (z0 + z1) / 2 + (b.open ? 0.5 : 0), { heat: 0.42, xray: 'shell' });
        if (b.open) door.rotation.y = Math.PI / 2;
        g.add(door);
      } else {
        addWall(x0, z0, x1, c - dw / 2); addWall(x0, c + dw / 2, x1, z1); addWall(x0, c - dw / 2, x1, c + dw / 2, H - dh, dh);
      }
    } else addWall(x0, z0, x1, z1);
    // windows: dark insets on the outer face
    const L = ax === 'x' ? w : d;
    for (let f = 0; f < floors; f++) {
      for (let s = -L / 2 + 1.8; s < L / 2 - 1.2; s += 2.9) {
        if (k === b.door && Math.abs(s - (b.doorAt ?? 0)) < 1.4 && f === 0) continue;
        const y = f * 3.2 + 1.1;
        const out = ax === 'x' ? (z0 + z1) / 2 + Math.sign((z0 + z1) / 2) * (T / 2 + 0.01) : (x0 + x1) / 2 + Math.sign((x0 + x1) / 2) * (T / 2 + 0.01);
        const win = ax === 'x' ? box(M.window, 0.9, 1.1, 0.04, s, y, out, { heat: b.occupied ? 0.74 : 0.4, xray: 'shell' })
          : box(M.window, 0.04, 1.1, 0.9, out, y, s, { heat: b.occupied ? 0.74 : 0.4, xray: 'shell' });
        win.castShadow = false;
        g.add(win);
      }
    }
  }
  // floor slab (the village ground is graded, not perfectly flat)
  g.add(box(M.roof, w, 0.45, d, 0, -0.43, 0, { heat: 0.45, xray: 'dim' }));
  // roof + parapet
  const roof = box(M.roof, w + 0.2, 0.25, d + 0.2, 0, H, 0, { heat: b.occupied ? 0.62 : 0.5, xray: 'shell' });
  g.add(roof);
  for (const [x, z, ww, dd] of [[0, -d / 2, w + 0.2, 0.2], [0, d / 2, w + 0.2, 0.2], [-w / 2, 0, 0.2, d], [w / 2, 0, 0.2, d]]) {
    g.add(box(wm, ww, 0.5, dd, x, H + 0.25, z, shell(0.5)));
  }
  if (floors === 2) g.add(box(M.roof, w - 0.4, 0.2, d - 0.4, 0, 3.1, 0, { heat: 0.45, xray: 'shell' }));
  // A rooftop water tank on some.
  if (r() < 0.5) g.add(box(M.metal, 1.1, 1.0, 1.1, w / 2 - 1.2, H + 0.25, -d / 2 + 1.2, { heat: 0.3, xray: 'dense' }));
  // Interior: rugs, a table, mattresses.
  g.add(box(M.rug, Math.min(3, w - 1), 0.03, Math.min(2.2, d - 1), r.range(-1, 1), 0.01, r.range(-1, 1), { heat: 0.42, xray: 'dim' }));
  g.add(box(M.wood, 1.4, 0.75, 0.8, -w / 2 + 1.4, 0, d / 2 - 1.2, { heat: 0.4, xray: 'dim' }));
  if (b.cache) {
    // weapons cache: stacked crates and a tube rack, room-temperature (IR can't separate it)
    for (let k = 0; k < 6; k++) g.add(box(M.crate, 1.0, 0.5, 0.6, w / 2 - 1.1, (k % 3) * 0.5, -d / 2 + 1 + Math.floor(k / 3) * 0.7, { heat: 0.4, xray: 'dense' }));
    for (let k = 0; k < 4; k++) {
      const tube = box(M.metal, 0.12, 0.12, 1.3, w / 2 - 2.6, 0.2 + k * 0.14, -d / 2 + 1.2, { heat: 0.4, xray: 'dense' });
      g.add(tube);
    }
  }
  g.userData.kind = 'building';
  g.userData.walls = walls;
  return g;
}

/** A compound wall (2.4 m) around a rectangle with a gate gap on one side. */
function compoundWalls(r, c) {
  mats();
  const g = new THREE.Group();
  const mat = M.walls[4];
  const H = 2.4, T = 0.35, { w, d, gate = 'S' } = c;
  const walls = [];
  const add = (x0, z0, x1, z1) => {
    g.add(box(mat, x1 - x0, H, z1 - z0, (x0 + x1) / 2, 0, (z0 + z1) / 2, { heat: 0.46, xray: 'shell' }));
    walls.push({ x0, z0, x1, z1 });
  };
  const gw = 3.6;
  // N
  if (gate === 'N') { add(-w / 2, -d / 2 - T / 2, -gw / 2, -d / 2 + T / 2); add(gw / 2, -d / 2 - T / 2, w / 2, -d / 2 + T / 2); } else add(-w / 2, -d / 2 - T / 2, w / 2, -d / 2 + T / 2);
  if (gate === 'S') { add(-w / 2, d / 2 - T / 2, -gw / 2, d / 2 + T / 2); add(gw / 2, d / 2 - T / 2, w / 2, d / 2 + T / 2); } else add(-w / 2, d / 2 - T / 2, w / 2, d / 2 + T / 2);
  add(-w / 2 - T / 2, -d / 2, -w / 2 + T / 2, d / 2);
  add(w / 2 - T / 2, -d / 2, w / 2 + T / 2, d / 2);
  g.userData.walls = walls;
  return g;
}

// ---------------------------------------------------------------- the world
export class World {
  constructor(terrain) {
    this.t = terrain;
    this.root = new THREE.Group();
    this.walls = []; // world-space 2D boxes {x0,z0,x1,z1,h,y0}
    this.buildings = []; // {id, name, x, z, w, d, occupied, cache, group, area}
    this.people = []; // {group, side, path, speed, ...}
    this.vehicles = [];
    this.taggables = [];
    this.r = rng(2027);
    mats();
    this.buildVillage();
    this.buildFarm();
    this.buildAssemblyArea();
    this.buildEnemyOP();
    this.buildCheckpoint();
    this.buildTrees();
    this.buildRocks();
  }

  place(obj, x, z, rotY = 0, sink = 0.05) {
    obj.position.set(x, this.t.heightAt(x, z) - sink, z);
    obj.rotation.y = rotY;
    this.root.add(obj);
    return obj;
  }

  addWalls(group, x, z) {
    const y0 = this.t.heightAt(x, z);
    for (const w of group.userData.walls || []) this.walls.push({ x0: w.x0 + x, z0: w.z0 + z, x1: w.x1 + x, z1: w.z1 + z, y0 });
  }

  addBuilding(b, area) {
    const g = makeBuilding(this.r, b);
    this.place(g, b.x, b.z, 0, 0.15);
    this.addWalls(g, b.x, b.z);
    const rec = { ...b, group: g, area, id: `B${this.buildings.length + 1}` };
    this.buildings.push(rec);
    g.userData.ref = rec;
    this.taggables.push({ kind: 'building', ref: rec, group: g });
    // occupants
    for (let k = 0; k < (b.occupants || 0); k++) {
      const p = makePerson(this.r, { armed: !!b.armed && k % 2 === 0, pose: k % 3 === 2 ? 'sit' : 'stand' });
      const ox = this.r.range(-b.w / 2 + 1, b.w / 2 - 1), oz = this.r.range(-b.d / 2 + 1, b.d / 2 - 1);
      p.position.set(ox, (k >= 2 && b.floors === 2) ? 3.3 : 0, oz);
      p.rotation.y = this.r() * 6.28;
      g.add(p);
    }
    return rec;
  }

  buildVillage() {
    const r = this.r;
    const { x: cx, z: cz } = PLACES.OBJ_IRON;
    // Street grid: lots on a jittered 3 x 4 block layout, with a main street on z = cz.
    const lots = [];
    for (let bx = -2; bx <= 2; bx++) for (let bz = -2; bz <= 2; bz++) {
      if (Math.abs(bx) === 2 && Math.abs(bz) === 2) continue;
      if (bz === 0 && bx === 0) continue; // market square
      lots.push([cx + bx * 34 + r.range(-4, 4), cz + bz * 30 + (bz > 0 ? 6 : bz < 0 ? -6 : 0) + r.range(-3, 3)]);
    }
    // Which buildings are occupied and where the cache is are fixed (missions grade against them).
    const occupiedIdx = new Set([1, 4, 8, 11, 15, 19]);
    const cacheIdx = 11;
    lots.forEach(([x, z], k) => {
      const floors = k % 4 === 1 || k === cacheIdx ? 2 : 1;
      const w = Math.round(r.range(8, 13)), d = Math.round(r.range(7, 11));
      const door = z > cz ? 'N' : 'S';
      const occ = occupiedIdx.has(k);
      this.addBuilding({ x, z, w, d, floors, door, doorAt: r.range(-w / 4, w / 4), open: occ, occupied: occ, occupants: occ ? 2 + (k % 3) : 0, armed: occ && k % 2 === 1, cache: k === cacheIdx }, 'OBJ IRON');
      // Walled compounds around some houses.
      if (k % 5 === 0 || k === cacheIdx) {
        const cw = compoundWalls(r, { w: w + 9, d: d + 8, gate: door });
        this.place(cw, x, z, 0, 0.2);
        this.addWalls(cw, x, z);
      }
    });
    // Hot vehicles in the square (recently driven) and cold ones parked.
    const v = [[cx - 8, cz + 2, 0.3, true, true], [cx + 9, cz - 3, 1.7, true, false], [cx + 52, cz + 44, 0, false, false], [cx - 60, cz - 40, 1.2, false, false]];
    for (const [x, z, a, running, armed] of v) {
      const g = makePickup(r, { running, armed });
      this.place(g, x, z, a);
      this.vehicles.push({ group: g, running, area: 'OBJ IRON' });
      this.taggables.push({ kind: 'vehicle', ref: { running, area: 'OBJ IRON' }, group: g });
    }
    // Sentries walking loops through the streets (ground rehearsal sees them).
    const loops = [
      [[cx - 50, cz - 15], [cx + 50, cz - 15], [cx + 50, cz + 15], [cx - 50, cz + 15]],
      [[cx - 18, cz - 75], [cx - 18, cz + 75]],
      [[cx + 85, cz - 60], [cx + 85, cz + 60], [cx + 20, cz + 60]],
      [[cx - 90, cz + 50], [cx - 90, cz - 50], [cx - 40, cz - 50]],
    ];
    loops.forEach((path, k) => this.addPatrol(path, k * 0.3, 1.25 + k * 0.1));
    // A pair standing at the market square (static sentries).
    for (const [x, z, a] of [[cx + 2, cz + 9, 2.8], [cx - 3, cz - 8, 0.5]]) this.addPatrol([[x, z]], 0, 0, a);
  }

  addPatrol(path, phase, speed, facing = 0) {
    const g = makePerson(this.r, { armed: true });
    this.place(g, path[0][0], path[0][1], facing, 0);
    const p = { group: g, path, seg: 0, t: phase, speed, facing, side: 'H', phase: this.r() * 6 };
    this.people.push(p);
    return p;
  }

  buildFarm() {
    const { x, z } = PLACES.FARM;
    this.addBuilding({ x: x - 10, z: z - 6, w: 12, d: 8, floors: 1, door: 'S', open: true, occupied: true, occupants: 4 }, 'FARM');
    this.addBuilding({ x: x + 12, z: z + 4, w: 14, d: 9, floors: 1, door: 'W', occupants: 0 }, 'FARM');
    this.addBuilding({ x: x - 2, z: z + 18, w: 7, d: 6, floors: 1, door: 'N', occupants: 0 }, 'FARM');
    const tractor = makePickup(this.r, { running: false });
    this.place(tractor, x + 4, z - 14, 0.9);
  }

  buildAssemblyArea() {
    const { x, z } = PLACES.AA_FALCON;
    for (let k = 0; k < 6; k++) {
      const v = makeMRAP(this.r);
      const a = (k / 6) * Math.PI * 2;
      this.place(v, x + Math.cos(a) * 32, z + Math.sin(a) * 26, -a + Math.PI / 2);
    }
    for (let k = 0; k < 14; k++) {
      const p = makePerson(this.r, { friendly: true, armed: true });
      this.place(p, x + this.r.range(-20, 20), z + this.r.range(-16, 16), this.r() * 6.28, 0);
    }
    // camouflage net
    const net = new THREE.Mesh(new THREE.PlaneGeometry(14, 10, 6, 6), M.net);
    net.rotation.x = -Math.PI / 2;
    net.position.set(x - 6, this.t.heightAt(x - 6, z + 4) + 3.2, z + 4);
    net.userData.sensor = { heat: 0.38, xray: 'faint' };
    net.castShadow = true;
    this.root.add(net);
  }

  buildEnemyOP() {
    const { x, z } = PLACES.HILL_431;
    // Find the summit near the hill centre.
    let best = { x, z, h: -1 };
    for (let dx = -60; dx <= 60; dx += 6) for (let dz = -60; dz <= 60; dz += 6) {
      const h = this.t.heightAt(x + dx, z + dz);
      if (h > best.h) best = { x: x + dx, z: z + dz, h };
    }
    this.enemyOP = { x: best.x, z: best.z, y: best.h + 2.2, name: 'EN OP' };
    const g = new THREE.Group();
    // sandbag ring
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      const s = box(M.sand, 1.4, 0.9, 0.6, Math.cos(a) * 3.2, 0, Math.sin(a) * 3.2, { heat: 0.45, xray: 'dim' });
      s.rotation.y = -a + Math.PI / 2;
      g.add(s);
    }
    const net = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), M.net);
    net.rotation.x = -Math.PI / 2; net.position.y = 2.1; net.userData.sensor = { heat: 0.36, xray: 'faint' };
    g.add(net);
    this.place(g, best.x, best.z);
    for (const [dx, dz, a] of [[-1, 0.5, 2.6], [1.2, -0.4, 3.4]]) {
      const p = makePerson(this.r, { armed: true });
      p.position.set(dx, 0.1, dz); p.rotation.y = a;
      g.add(p);
    }
    this.taggables.push({ kind: 'position', ref: { area: 'HILL 431', name: 'EN OP' }, group: g });
  }

  buildCheckpoint() {
    // An enemy vehicle checkpoint on the road north-east of the bridge.
    const x = 168, z = -12;
    const v = makePickup(this.r, { running: true, armed: true });
    this.place(v, x + 6, z, 0.6);
    this.vehicles.push({ group: v, running: true, area: 'CHECKPOINT' });
    this.taggables.push({ kind: 'vehicle', ref: { running: true, area: 'CHECKPOINT' }, group: v });
    for (const [dx, dz] of [[-2, 1], [-3, -2]]) this.addPatrol([[x + dx, z + dz]], 0, 0, 3.6);
    for (let k = 0; k < 5; k++) {
      const b = box(M.sand, 0.8, 0.8, 0.8, 0, 0, 0, { heat: 0.42, xray: 'dim' });
      this.place(b, x - 6 + k * 1.1, z + 4 - k * 0.6);
    }
    this.checkpoint = { x, z };
  }

  buildTrees() {
    const trees = this.t.trees;
    const coniferG = new THREE.ConeGeometry(2.4, 9, 7); coniferG.translate(0, 7, 0);
    const broadG = new THREE.IcosahedronGeometry(3.4, 1); broadG.scale(1, 0.85, 1); broadG.translate(0, 6.2, 0);
    {
      // jitter the broadleaf crown so it reads as foliage, not a ball
      const p = broadG.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const n = 0.82 + 0.36 * vnoise(p.getX(k) * 1.7 + 3, p.getZ(k) * 1.7 + p.getY(k), 13);
        p.setXYZ(k, p.getX(k) * n, 6.2 + (p.getY(k) - 6.2) * n, p.getZ(k) * n);
      }
      broadG.computeVertexNormals();
    }
    const trunkG = new THREE.CylinderGeometry(0.18, 0.28, 4.5, 6); trunkG.translate(0, 2.25, 0);
    const conMat = new THREE.MeshStandardMaterial({ color: 0x2e4426, roughness: 0.95, flatShading: true });
    const broadMat = new THREE.MeshStandardMaterial({ color: 0x48602f, roughness: 0.95, flatShading: true });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4b3a28, roughness: 1 });
    const con = trees.filter((t) => t.conifer), brd = trees.filter((t) => !t.conifer);
    const mk = (geo, mat, list, heat) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
      list.forEach((t, k) => {
        p.set(t.x, this.t.heightAt(t.x, t.z) - 0.2, t.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
        s.setScalar(t.s);
        m.compose(p, q, s);
        im.setMatrixAt(k, m);
        c.setHSL(0.25 + (t.rot % 0.06), 0.35, 0.8 + (t.s - 1) * 0.4);
        im.setColorAt(k, c);
      });
      im.castShadow = true; im.receiveShadow = true;
      im.userData.sensor = { heat, xray: 'faint' };
      this.root.add(im);
      return im;
    };
    mk(coniferG, conMat, con, 0.3);
    mk(broadG, broadMat, brd, 0.32);
    mk(trunkG, trunkMat, trees, 0.36);
  }

  buildRocks() {
    const r = rng(77);
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a8070, roughness: 1, flatShading: true });
    const pts = [];
    for (let k = 0; k < 6000 && pts.length < 1400; k++) {
      const x = r.range(-HALF, HALF), z = r.range(-HALF, HALF);
      if (this.t.slopeAt(x, z) > 12 || r() < 0.08) pts.push([x, z]);
    }
    const im = new THREE.InstancedMesh(geo, mat, pts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
    pts.forEach(([x, z], k) => {
      const sc = r.range(0.3, 1.4);
      p.set(x, this.t.heightAt(x, z) - sc * 0.3, z);
      q.setFromEuler(e.set(r() * 3, r() * 3, r() * 3));
      s.set(sc * r.range(0.8, 1.6), sc * 0.7, sc);
      m.compose(p, q, s);
      im.setMatrixAt(k, m);
    });
    im.castShadow = im.receiveShadow = true;
    im.userData.sensor = { heat: 0.5, xray: 'dim' };
    this.root.add(im);
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    for (const p of this.people) {
      if (p.path.length < 2 || !p.speed) continue;
      const [ax, az] = p.path[p.seg], [bx, bz] = p.path[(p.seg + 1) % p.path.length];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      p.t += (p.speed * dt) / L;
      if (p.t >= 1) { p.t = 0; p.seg = (p.seg + 1) % p.path.length; continue; }
      const x = ax + (bx - ax) * p.t, z = az + (bz - az) * p.t;
      p.group.position.set(x, this.t.heightAt(x, z), z);
      const target = Math.atan2(bx - ax, bz - az);
      p.facing = target;
      p.group.rotation.y = target;
      p.phase += dt * p.speed * 4.2;
      animateWalk(p.group, p.phase, p.speed);
    }
  }

  /** Do any building or compound walls block the 2D sight line a-b? */
  wallsBlock(ax, az, bx, bz) {
    for (const w of this.walls) {
      if (Math.max(ax, bx) < w.x0 || Math.min(ax, bx) > w.x1 || Math.max(az, bz) < w.z0 || Math.min(az, bz) > w.z1) continue;
      let t0 = 0, t1 = 1;
      const dx = bx - ax, dz = bz - az;
      let hit = true;
      for (const [p, d, lo, hi] of [[ax, dx, w.x0, w.x1], [az, dz, w.z0, w.z1]]) {
        if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) { hit = false; break; } continue; }
        let ta = (lo - p) / d, tb = (hi - p) / d;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) { hit = false; break; }
      }
      if (hit) return true;
    }
    return false;
  }

  /** Push a walker of radius rad out of every wall box. */
  collide(pos, rad = 0.35) {
    for (const w of this.walls) {
      const cx = clamp(pos.x, w.x0, w.x1), cz = clamp(pos.z, w.z0, w.z1);
      const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
      if (d2 < rad * rad) {
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2), k = (rad - d) / d;
          pos.x += dx * k; pos.z += dz * k;
        } else {
          // centre inside the box: push out along the shallowest axis
          const ox = Math.min(pos.x - w.x0, w.x1 - pos.x), oz = Math.min(pos.z - w.z0, w.z1 - pos.z);
          if (ox < oz) pos.x = pos.x - w.x0 < w.x1 - pos.x ? w.x0 - rad : w.x1 + rad;
          else pos.z = pos.z - w.z0 < w.z1 - pos.z ? w.z0 - rad : w.z1 + rad;
        }
      }
    }
  }
}
