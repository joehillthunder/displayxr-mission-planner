// AO GRANITE: a fictional 1.6 x 1.6 km area of operations, generated once from fixed seeds.
//
// The heightfield is a 513 x 513 grid (3.125 m posts) that the mesh, the ray marcher, the
// line-of-sight test and every placed object share, so a marker dropped on a hillside sits on
// the same surface that is drawn. The "aerial imagery" is a 2048 px canvas painted per pixel
// (biome, slope, river, forest floor) and then with vector strokes (roads, fields, tree crowns).
// A matching 512 px heat map drives the thermal sensor's ground temperatures.

import * as THREE from 'three';
import { clamp, lerp, smoothstep, fbm, vnoise, rng, polyDist, segDist } from './util.js';

export const HALF = 800;
export const SIZE = HALF * 2;
export const N = 512; // grid segments per side
const CELL = SIZE / N;

// ---------------------------------------------------------------- the AO's named features
export const riverX = (z) => -40 + 120 * Math.sin(z / 240 + 0.6) + 0.12 * z;
export const RIVER_W = 9; // half-width of the water

export const PLACES = {
  OBJ_IRON: { x: 250, z: -180, name: 'OBJ IRON' },
  AA_FALCON: { x: -520, z: 450, name: 'AA FALCON' },
  HILL_431: { x: 120, z: -600, name: 'HILL 431' },
  HILL_388: { x: 600, z: 130, name: 'HILL 388' },
  HILL_352: { x: -250, z: -150, name: 'HILL 352' },
  BRIDGE: { x: riverX(100), z: 100, name: 'BRIDGE 7' },
  FORD: { x: riverX(-470), z: -470, name: 'FORD' },
  FARM: { x: -220, z: 262, name: 'FARM' },
};

const HILLS = [
  { x: 120, z: -600, h: 78, rx: 210, rz: 190 },
  { x: 600, z: 130, h: 58, rx: 170, rz: 190 },
  { x: -250, z: -150, h: 50, rx: 150, rz: 170 },
  { x: -600, z: -60, h: 62, rx: 120, rz: 320 },
  { x: -660, z: -620, h: 48, rx: 220, rz: 200 },
  { x: -80, z: 640, h: 30, rx: 240, rz: 160 },
  { x: 620, z: -560, h: 40, rx: 200, rz: 180 },
];

const FLATS = [
  { x: 250, z: -180, r: 150, w: 70 }, // village
  { x: -520, z: 450, r: 100, w: 60 }, // assembly area
  { x: -220, z: 262, r: 90, w: 60 }, // farm
  { x: -440, z: 160, r: 70, w: 70 }, // open field (a good HLZ)
  { x: 470, z: 330, r: 55, w: 60 }, // open field (a poor HLZ: exposed)
];

export const ROADS = [
  [[-800, 620], [-640, 500], [-520, 450], [-380, 330], [-230, 262], [-80, 140], [PLACES.BRIDGE.x, 100], [160, 10], [220, -110], [250, -180], [330, -262], [480, -380], [640, -480], [800, -540]],
  [[250, -180], [228, -330], [180, -460], [132, -585]],
  [[-230, 262], [-150, 380], [-60, 520], [40, 690], [100, 800]],
  [[160, 10], [350, 62], [520, 112], [600, 135]],
  [[-520, 450], [-470, 300], [-440, 160]],
];

// Fields: centre, size, angle, kind (0 green crop, 1 stubble, 2 fallow).
const FIELDS = [];
{
  const r = rng(42);
  const anchors = [[-220, 262, 9], [480, 330, 3], [-420, 520, 4], [60, 380, 5], [420, -60, 3]];
  for (const [ax, az, n] of anchors) {
    for (let i = 0; i < n; i++) {
      FIELDS.push({ x: ax + r.range(-170, 170), z: az + r.range(-140, 140), w: r.range(60, 130), d: r.range(40, 90), a: r.range(-0.5, 0.5), kind: Math.floor(r() * 3) });
    }
  }
}
export { FIELDS };

const inField = (x, z) => {
  for (const f of FIELDS) {
    const c = Math.cos(-f.a), s = Math.sin(-f.a);
    const lx = (x - f.x) * c - (z - f.z) * s, lz = (x - f.x) * s + (z - f.z) * c;
    if (Math.abs(lx) < f.w / 2 && Math.abs(lz) < f.d / 2) return f;
  }
  return null;
};

const roadDist = (x, z) => {
  let d = Infinity;
  for (const r of ROADS) d = Math.min(d, polyDist(x, z, r));
  return d;
};

// ---------------------------------------------------------------- heightfield
function baseHeight(x, z) {
  let h = 38 + 24 * (fbm(x / 320 + 11, z / 320 + 7, 5, 3) - 0.5) * 2;
  h += 2.5 * (vnoise(x / 26, z / 26, 77) - 0.5);
  for (const k of HILLS) {
    const dx = (x - k.x) / k.rx, dz = (z - k.z) / k.rz;
    h += k.h * Math.exp(-(dx * dx + dz * dz) * 1.6) * (0.85 + 0.3 * fbm(x / 90, z / 90, 3, 5));
  }
  return h;
}

function rawHeight(x, z) {
  let h = baseHeight(x, z);
  for (const f of FLATS) {
    const d = Math.hypot(x - f.x, z - f.z);
    const t = 1 - smoothstep(f.r, f.r + f.w, d);
    if (t > 0) h = lerp(h, f.h0 ?? (f.h0 = baseHeight(f.x, f.z)), t * 0.92);
  }
  // A broad valley, then the channel.
  const dr = Math.abs(x - riverX(z));
  h -= 10 * (1 - smoothstep(30, 220, dr));
  h -= 6 * (1 - smoothstep(RIVER_W, RIVER_W + 26, dr));
  // Road beds are graded a little.
  return h;
}

export class Terrain {
  constructor() {
    const t0 = performance.now();
    const n1 = N + 1;
    this.h = new Float32Array(n1 * n1);
    for (let j = 0; j < n1; j++) {
      for (let i = 0; i < n1; i++) this.h[j * n1 + i] = rawHeight(-HALF + i * CELL, -HALF + j * CELL);
    }
    // Water surface along the river (the bed varies, so the water does too).
    this.waterY = (z) => rawHeightWater(z);
    const rawHeightWater = (z) => rawHeight(riverX(z), z) + 1.6;
    this.places = PLACES;
    this.trees = [];
    this.scatterTrees();
    this.treeGrid = new Uint8Array(256 * 256);
    for (const t of this.trees) {
      const gi = Math.floor((t.x + HALF) / SIZE * 256), gj = Math.floor((t.z + HALF) / SIZE * 256);
      if (gi >= 0 && gi < 256 && gj >= 0 && gj < 256) this.treeGrid[gj * 256 + gi] = Math.min(255, this.treeGrid[gj * 256 + gi] + 1);
    }
    this.genMs = performance.now() - t0;
  }

  heightAt(x, z) {
    const fx = clamp((x + HALF) / CELL, 0, N - 0.0001), fz = clamp((z + HALF) / CELL, 0, N - 0.0001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, n1 = N + 1;
    const a = this.h[j * n1 + i], b = this.h[j * n1 + i + 1], c = this.h[(j + 1) * n1 + i], d = this.h[(j + 1) * n1 + i + 1];
    // Same triangle split as the mesh (diagonal from (i,j+1) to (i+1,j)).
    if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
    return d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }

  /** Slope in degrees. */
  slopeAt(x, z) {
    const e = 2;
    const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
  }

  inBounds(x, z, m = 0) { return Math.abs(x) <= HALF - m && Math.abs(z) <= HALF - m; }

  treesAt(x, z) {
    const gi = Math.floor((x + HALF) / SIZE * 256), gj = Math.floor((z + HALF) / SIZE * 256);
    if (gi < 0 || gi >= 256 || gj < 0 || gj >= 256) return 0;
    return this.treeGrid[gj * 256 + gi];
  }

  riverDist(x, z) { return Math.abs(x - riverX(z)); }

  /**
   * Terrain (and optionally forest canopy) line of sight between two world points.
   * Canopy: more than ~35 m of the sight line through tree crowns counts as blocked.
   */
  los(a, b, { trees = true } = {}) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const L = Math.hypot(dx, dz);
    const n = Math.max(2, Math.ceil(L / 3));
    let canopy = 0;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = a.x + dx * t, z = a.z + dz * t, y = a.y + dy * t;
      const g = this.heightAt(x, z);
      if (y < g + 0.3) return false;
      if (trees && y < g + 11 && L * t > 12 && L * (1 - t) > 12 && this.treesAt(x, z) > 0) {
        canopy += L / n;
        if (canopy > 35) return false;
      }
    }
    return true;
  }

  /** March a ray to the terrain; returns a THREE.Vector3 or null. */
  raycast(origin, dir, maxT = 9000) {
    let t = 0, prev = 0;
    const p = new THREE.Vector3();
    for (let k = 0; k < 4000 && t < maxT; k++) {
      p.copy(dir).multiplyScalar(t).add(origin);
      if (!this.inBounds(p.x, p.z) && ((p.x > HALF && dir.x > 0) || (p.x < -HALF && dir.x < 0) || (p.z > HALF && dir.z > 0) || (p.z < -HALF && dir.z < 0))) return null;
      const g = this.heightAt(p.x, p.z);
      const above = p.y - g;
      if (above < 0) {
        let lo = prev, hi = t;
        for (let s = 0; s < 24; s++) {
          const m = (lo + hi) / 2;
          p.copy(dir).multiplyScalar(m).add(origin);
          if (p.y < this.heightAt(p.x, p.z)) hi = m; else lo = m;
        }
        p.copy(dir).multiplyScalar(hi).add(origin);
        p.y = this.heightAt(p.x, p.z);
        return this.inBounds(p.x, p.z) ? p : null;
      }
      prev = t;
      t += Math.max(0.4, above * 0.6);
    }
    return null;
  }

  scatterTrees() {
    const r = rng(1234);
    const ok = (x, z) => {
      if (!this.inBounds(x, z, 4)) return false;
      if (this.riverDist(x, z) < RIVER_W + 6) return false;
      if (roadDist(x, z) < 8) return false;
      if (inField(x, z)) return false;
      for (const f of FLATS) if (Math.hypot(x - f.x, z - f.z) < f.r * (f === FLATS[0] ? 1.05 : 0.9)) return false;
      return true;
    };
    const add = (x, z, big = 1) => {
      if (!ok(x, z)) return;
      const conifer = this.heightAt(x, z) > 70 || r() < 0.25;
      this.trees.push({ x, z, s: r.range(0.75, 1.3) * big, conifer, rot: r() * 6.28 });
    };
    // Forest stands from a low-frequency mask, denser on the hills.
    for (let k = 0; k < 26000 && this.trees.length < 5200; k++) {
      const x = r.range(-HALF, HALF), z = r.range(-HALF, HALF);
      const m = fbm(x / 230 + 3, z / 230 - 9, 3, 9) + (this.heightAt(x, z) - 50) / 260;
      if (m > 0.6) add(x, z);
    }
    // Riparian woodline along both banks.
    for (let z = -HALF; z < HALF; z += 7) {
      for (const side of [-1, 1]) {
        if (r() < 0.55) add(riverX(z) + side * r.range(RIVER_W + 7, RIVER_W + 32), z + r.range(-3, 3), 1.1);
      }
    }
    // Hedgerows along field edges and road verges.
    for (const f of FIELDS) {
      for (let s = -0.5; s <= 0.5; s += 0.06) {
        if (r() < 0.5) continue;
        const lx = s * f.w, lz = f.d / 2 + 4;
        add(f.x + lx * Math.cos(f.a) - lz * Math.sin(f.a), f.z + lx * Math.sin(f.a) + lz * Math.cos(f.a), 0.8);
      }
    }
    // Hill 352 is wooded on top: it screens the western fields from Hill 431.
    for (let k = 0; k < 500; k++) {
      const a = r() * 6.28, d = Math.sqrt(r()) * 120;
      add(PLACES.HILL_352.x + Math.cos(a) * d, PLACES.HILL_352.z + Math.sin(a) * d * 1.2);
    }
  }

  // ---------------------------------------------------------------- imagery
  paintImagery() {
    const W = 2048, PPM = W / SIZE;
    const cv = document.createElement('canvas');
    cv.width = cv.height = W;
    const g = cv.getContext('2d');
    const img = g.createImageData(W, W);
    const D = img.data;
    const HW = 512, HP = W / HW;
    const heat = new Uint8Array(HW * HW * 4);
    const grass = [92, 108, 58], dry = [152, 140, 96], rock = [128, 118, 104], mud = [104, 92, 70], water = [44, 66, 70], floor = [58, 70, 42];
    for (let j = 0; j < W; j++) {
      const z = -HALF + (j + 0.5) / PPM;
      const rx = riverX(z);
      for (let i = 0; i < W; i++) {
        const x = -HALF + (i + 0.5) / PPM;
        const h = this.heightAt(x, z);
        const n2 = vnoise(x / 110, z / 110, 4);
        const n1 = vnoise(x / 14, z / 14, 6) * 0.6 + vnoise(x / 3.5, z / 3.5, 8) * 0.4;
        let t = smoothstep(0.35, 0.75, n2 + (h - 40) / 180);
        let c0 = lerp(grass[0], dry[0], t), c1 = lerp(grass[1], dry[1], t), c2 = lerp(grass[2], dry[2], t);
        let ht = 0.36 + 0.1 * t;
        // slope -> rock, computed from the grid at 2 m
        const s = (i & 1) === 0 ? (this._s = this.slopeAt(x, z)) : this._s;
        const rk = smoothstep(16, 30, s);
        c0 = lerp(c0, rock[0], rk); c1 = lerp(c1, rock[1], rk); c2 = lerp(c2, rock[2], rk);
        ht = lerp(ht, 0.52, rk);
        if (this.treesAt(x, z) > 1) {
          c0 = lerp(c0, floor[0], 0.6); c1 = lerp(c1, floor[1], 0.6); c2 = lerp(c2, floor[2], 0.6);
          ht = lerp(ht, 0.26, 0.7);
        }
        const dr = Math.abs(x - rx);
        if (dr < RIVER_W + 9) {
          const m = 1 - smoothstep(RIVER_W, RIVER_W + 9, dr);
          c0 = lerp(c0, mud[0], m); c1 = lerp(c1, mud[1], m); c2 = lerp(c2, mud[2], m);
          ht = lerp(ht, 0.3, m);
        }
        if (dr < RIVER_W) { c0 = water[0]; c1 = water[1]; c2 = water[2]; ht = 0.14; }
        const k = 0.84 + 0.32 * n1;
        const o = (j * W + i) * 4;
        D[o] = c0 * k; D[o + 1] = c1 * k; D[o + 2] = c2 * k; D[o + 3] = 255;
        if (i % HP === 0 && j % HP === 0) {
          const ho = ((j / HP) * HW + i / HP) * 4;
          const v = clamp(ht + (n1 - 0.5) * 0.04, 0, 1) * 255;
          heat[ho] = heat[ho + 1] = heat[ho + 2] = v; heat[ho + 3] = 255;
        }
      }
    }
    g.putImageData(img, 0, 0);
    const P = (x) => (x + HALF) * PPM;

    // Fields with crop rows.
    const r = rng(7);
    const fieldCols = [['#6f8a3e', '#5f7a34'], ['#b5a36a', '#a8955c'], ['#8c7655', '#7d6849']];
    for (const f of FIELDS) {
      g.save();
      g.translate(P(f.x), P(f.z));
      g.rotate(f.a);
      const [a, b] = fieldCols[f.kind];
      g.fillStyle = a;
      g.globalAlpha = 0.9;
      g.fillRect(-f.w / 2 * PPM, -f.d / 2 * PPM, f.w * PPM, f.d * PPM);
      g.strokeStyle = b;
      g.lineWidth = 1;
      for (let y = -f.d / 2; y < f.d / 2; y += 2.2) {
        g.beginPath(); g.moveTo(-f.w / 2 * PPM, y * PPM); g.lineTo(f.w / 2 * PPM, y * PPM); g.stroke();
      }
      g.globalAlpha = 0.35;
      g.fillStyle = r() < 0.5 ? '#000' : '#fff';
      g.fillRect(-f.w / 2 * PPM, -f.d / 2 * PPM, f.w * PPM * r(), f.d * PPM);
      g.restore();
    }
    g.globalAlpha = 1;
    // Settlement ground: packed earth.
    for (const [p, rad] of [[PLACES.OBJ_IRON, 125], [PLACES.FARM, 45], [PLACES.AA_FALCON, 80]]) {
      const grd = g.createRadialGradient(P(p.x), P(p.z), 0, P(p.x), P(p.z), rad * PPM);
      grd.addColorStop(0, 'rgba(168,150,118,0.95)');
      grd.addColorStop(0.75, 'rgba(160,142,110,0.7)');
      grd.addColorStop(1, 'rgba(160,142,110,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(P(p.x), P(p.z), rad * PPM, 0, 7); g.fill();
    }
    // Roads: verge, bed, wheel ruts.
    const strokeRoads = (w, col) => {
      g.strokeStyle = col; g.lineWidth = w * PPM; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const rd of ROADS) {
        g.beginPath();
        rd.forEach(([x, z], k) => (k ? g.lineTo(P(x), P(z)) : g.moveTo(P(x), P(z))));
        g.stroke();
      }
    };
    strokeRoads(9, 'rgba(120,104,80,0.55)');
    strokeRoads(6, '#b4a586');
    strokeRoads(1.2, 'rgba(120,106,84,0.6)');
    // Tree crowns from directly above, with shadows toward the north-west.
    for (const t of this.trees) {
      const rad = (t.conifer ? 2.4 : 3.4) * t.s * PPM;
      g.fillStyle = 'rgba(20,26,14,0.55)';
      g.beginPath(); g.arc(P(t.x) - rad * 0.5, P(t.z) - rad * 0.4, rad, 0, 7); g.fill();
      g.fillStyle = t.conifer ? '#2c3d22' : '#3d5228';
      g.beginPath(); g.arc(P(t.x), P(t.z), rad * 0.85, 0, 7); g.fill();
    }

    // Heat: roads and packed earth hold warmth.
    const hc = document.createElement('canvas');
    hc.width = hc.height = HW;
    const hg = hc.getContext('2d');
    const hi = hg.createImageData(HW, HW);
    hi.data.set(heat);
    hg.putImageData(hi, 0, 0);
    const HPM = HW / SIZE, HPx = (x) => (x + HALF) * HPM;
    hg.strokeStyle = 'rgb(150,150,150)'; hg.lineWidth = 6 * HPM; hg.lineCap = 'round';
    for (const rd of ROADS) {
      hg.beginPath();
      rd.forEach(([x, z], k) => (k ? hg.lineTo(HPx(x), HPx(z)) : hg.moveTo(HPx(x), HPx(z))));
      hg.stroke();
    }
    for (const f of FIELDS) {
      hg.save(); hg.translate(HPx(f.x), HPx(f.z)); hg.rotate(f.a);
      hg.fillStyle = ['rgb(80,80,80)', 'rgb(120,120,120)', 'rgb(110,110,110)'][f.kind];
      hg.fillRect(-f.w / 2 * HPM, -f.d / 2 * HPM, f.w * HPM, f.d * HPM);
      hg.restore();
    }
    hg.fillStyle = 'rgba(135,135,135,0.8)';
    hg.beginPath(); hg.arc(HPx(PLACES.OBJ_IRON.x), HPx(PLACES.OBJ_IRON.z), 110 * HPM, 0, 7); hg.fill();

    this.imagery = cv;
    this.heatCanvas = hc;
    return cv;
  }

  /** Slope classes for helicopter landing zones: green < 7 deg, amber < 15, red beyond. */
  paintSlope(cv) {
    const W = cv.width, g = cv.getContext('2d'), img = g.createImageData(W, W);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const x = -HALF + (i + 0.5) * SIZE / W, z = -HALF + (j + 0.5) * SIZE / W;
      const s = this.slopeAt(x, z), o = (j * W + i) * 4;
      const c = s < 7 ? [40, 220, 90] : s < 15 ? [250, 200, 40] : [235, 60, 50];
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 120;
    }
    g.putImageData(img, 0, 0);
  }

  /** Viewshed from an observer: green where seen, nothing where hidden. Returns the seen fraction. */
  paintViewshed(cv, obs, radius = 900, eye = 2) {
    const W = cv.width, g = cv.getContext('2d'), img = g.createImageData(W, W);
    const o = { x: obs.x, y: this.heightAt(obs.x, obs.z) + eye, z: obs.z };
    let seen = 0, total = 0;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const x = -HALF + (i + 0.5) * SIZE / W, z = -HALF + (j + 0.5) * SIZE / W;
      const d = Math.hypot(x - o.x, z - o.z), k = (j * W + i) * 4;
      if (d > radius) continue;
      total++;
      const v = this.los(o, { x, y: this.heightAt(x, z) + 1.5, z });
      if (v) seen++;
      if (v) { img.data[k] = 255; img.data[k + 1] = 70; img.data[k + 2] = 50; img.data[k + 3] = 105; }
      else { img.data[k] = 20; img.data[k + 1] = 30; img.data[k + 2] = 60; img.data[k + 3] = 70; }
    }
    g.putImageData(img, 0, 0);
    // range ring
    g.strokeStyle = 'rgba(255,220,80,0.9)'; g.lineWidth = 1.5;
    g.beginPath(); g.arc((o.x + HALF) / SIZE * W, (o.z + HALF) / SIZE * W, radius / SIZE * W, 0, 7); g.stroke();
    return total ? seen / total : 0;
  }

  // ---------------------------------------------------------------- meshes
  buildMesh() {
    const n1 = N + 1;
    const pos = new Float32Array(n1 * n1 * 3), uv = new Float32Array(n1 * n1 * 2);
    for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
      const k = j * n1 + i;
      pos[k * 3] = -HALF + i * CELL; pos[k * 3 + 1] = this.h[k]; pos[k * 3 + 2] = -HALF + j * CELL;
      uv[k * 2] = i / N; uv[k * 2 + 1] = 1 - j / N;
    }
    const idx = new Uint32Array(N * N * 6);
    let q = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    return geo;
  }

  /** A low, untextured ring out to 6 km so the ground view has a horizon. */
  buildOuter() {
    const geo = new THREE.PlaneGeometry(12000, 12000, 96, 96);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position, col = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), z = p.getZ(k);
      const inside = Math.max(Math.abs(x), Math.abs(z)) < HALF + 40;
      const edge = Math.max(0, Math.max(Math.abs(x), Math.abs(z)) - HALF);
      const y = inside ? -20 : 30 + 60 * fbm(x / 900, z / 900, 4, 31) + Math.min(edge, 800) * 0.04 - 20 * Math.exp(-edge / 60);
      p.setY(k, y);
      const n = 0.8 + 0.3 * vnoise(x / 400, z / 400, 2), gr = vnoise(x / 260, z / 260, 12);
      col[k * 3] = (0.36 + 0.16 * (1 - gr)) * n; col[k * 3 + 1] = (0.4 + 0.06 * gr) * n; col[k * 3 + 2] = (0.24 + 0.04 * (1 - gr)) * n;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return geo;
  }

  /** The river as a ribbon whose surface follows the valley floor. */
  buildWater() {
    const zs = [];
    for (let z = -HALF - 10; z <= HALF + 10; z += 6) zs.push(z);
    const pos = new Float32Array(zs.length * 2 * 3);
    zs.forEach((z, k) => {
      const x = riverX(z), y = this.waterY(z);
      // perpendicular to the river direction
      const dx = riverX(z + 1) - x, L = Math.hypot(dx, 1), nx = 1 / L, nz = -dx / L;
      const w = RIVER_W + 10; // the banks rise through the surface, so the shoreline follows them
      pos.set([x - nx * w, y, z - nz * w, x + nx * w, y, z + nz * w], k * 6);
    });
    const idx = [];
    for (let k = 0; k < zs.length - 1; k++) {
      const a = k * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }
}

export { roadDist, inField, segDist };
