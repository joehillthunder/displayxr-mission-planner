// Planning tools, ATAK-style: point markers with MIL-STD-2525-like frames, routes draped on
// the terrain with an elevation profile and exposure to known threats, range & bearing with a
// terrain line-of-sight check, viewshed and slope overlays, and spot tags on what the sensors see.
//
// Everything a mission grades lives here as plain data (markers, routes, measurements, tags);
// the 3D objects are just their drawings.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { bearing, fmtDist, polyLength, mgrs, MSL, DEG } from './util.js';
import { HALF, SIZE } from './terrain.js';

export const LINE_MATS = [];
export function lineMat(color, width = 3, opts = {}) {
  const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity: opts.opacity ?? 1, dashed: !!opts.dashed, dashSize: opts.dash ?? 12, gapSize: opts.gap ?? 8, depthTest: opts.depthTest ?? true });
  LINE_MATS.push(m);
  return m;
}

const LABEL_SPRITES = [];

/** A screen-sized sprite (constant pixel size, scaled for the camera's field of view in update). */
function spriteFrom(canvas, h = 0.05) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });
  const s = new THREE.Sprite(mat);
  s.userData.baseScale = [h * canvas.width / canvas.height, h];
  s.scale.set(...s.userData.baseScale, 1);
  s.renderOrder = 10;
  s.userData.noSensor = true;
  LABEL_SPRITES.push(s);
  return s;
}

export function textSprite(text, { color = '#e8f4ff', bg = 'rgba(8,16,24,0.78)', size = 30, h = 0.032, border = null } = {}) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 20;
  c.width = w; c.height = size + 14;
  g.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(0, 0, w, c.height, 6); g.fill();
  if (border) { g.strokeStyle = border; g.lineWidth = 3; g.stroke(); }
  g.fillStyle = color; g.textBaseline = 'middle';
  g.fillText(text, 10, c.height / 2 + 1);
  return spriteFrom(c, h);
}

export const AFFIL = {
  F: { name: 'Friendly', fill: '#80e0ff', stroke: '#002a40' },
  H: { name: 'Hostile', fill: '#ff8080', stroke: '#400000' },
  U: { name: 'Unknown', fill: '#ffff80', stroke: '#404000' },
  N: { name: 'Neutral', fill: '#aaffaa', stroke: '#004000' },
  OP: { name: 'Observation post', fill: '#80e0ff', stroke: '#002a40' },
  ENOP: { name: 'Enemy OP', fill: '#ff8080', stroke: '#400000' },
  HLZ: { name: 'Landing zone', fill: '#ffffff', stroke: '#1a1a1a' },
  ORP: { name: 'Rally point', fill: '#80e0ff', stroke: '#002a40' },
  OBJ: { name: 'Objective', fill: '#000', stroke: '#000' },
};

/** Draw a 2525-flavoured frame. */
export function symbolCanvas(type, label = '') {
  const c = document.createElement('canvas');
  c.width = 192; c.height = 128;
  const g = c.getContext('2d');
  const a = AFFIL[type] || AFFIL.U;
  const cx = 64, cy = 64;
  g.lineWidth = 6; g.fillStyle = a.fill; g.strokeStyle = a.stroke;
  g.beginPath();
  if (type === 'F') g.rect(cx - 44, cy - 30, 88, 60);
  else if (type === 'H') { g.moveTo(cx, cy - 46); g.lineTo(cx + 46, cy); g.lineTo(cx, cy + 46); g.lineTo(cx - 46, cy); g.closePath(); }
  else if (type === 'N') g.rect(cx - 38, cy - 38, 76, 76);
  else if (type === 'U') { for (const [dx, dy] of [[0, -20], [20, 0], [0, 20], [-20, 0]]) { g.moveTo(cx + dx + 22, cy + dy); g.arc(cx + dx, cy + dy, 22, 0, 7); } }
  else if (type === 'OP' || type === 'ENOP') { g.moveTo(cx, cy - 44); g.lineTo(cx + 44, cy + 34); g.lineTo(cx - 44, cy + 34); g.closePath(); }
  else if (type === 'HLZ' || type === 'ORP') g.arc(cx, cy, 42, 0, 7);
  g.fill(); g.stroke();
  g.fillStyle = a.stroke; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (type === 'OP' || type === 'ENOP') { g.beginPath(); g.arc(cx, cy + 8, 8, 0, 7); g.fill(); }
  if (type === 'HLZ') { g.font = '800 46px system-ui'; g.fillText('H', cx, cy + 3); }
  if (type === 'ORP') { g.font = '800 26px system-ui'; g.fillText('ORP', cx, cy + 2); }
  if (type === 'F' || type === 'H' || type === 'U' || type === 'N') { g.font = '800 30px system-ui'; g.fillText(label.slice(0, 3), cx, cy + 2); }
  if (label && !['F', 'H', 'U', 'N'].includes(type)) {
    g.textAlign = 'left'; g.font = '800 26px system-ui'; g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 5;
    g.strokeText(label, 112, 30); g.fillText(label, 112, 30);
  }
  return c;
}

export class Tools {
  constructor(scene, terrain, world, cam) {
    this.scene = scene;
    this.t = terrain;
    this.world = world;
    this.camCtl = cam;
    this.root = new THREE.Group();
    this.root.userData.noSensor = true;
    scene.add(this.root);
    this.mode = 'select';
    this.markerType = 'H';
    this.markers = [];
    this.routes = [];
    this.draft = null; // route being drawn
    this.rb = null;
    this.rbPending = null;
    this.viewshed = null;
    this.tags = new Set();
    this.overlay = 'none';
    this.onEvent = () => {};
    this.counters = {};
    this.threats = []; // [{x,y,z,range,sector:[from,to] degrees}] known enemy eyes, set by the mission

    // Terrain overlay canvas (viewshed / slope) sampled by the terrain shader.
    this.ovCanvas = document.createElement('canvas');
    this.ovCanvas.width = this.ovCanvas.height = 200;
    this.ovTex = new THREE.CanvasTexture(this.ovCanvas);
    this.ovTex.flipY = false;
    this.ovTex.minFilter = THREE.LinearFilter;
    this.slopeCanvas = document.createElement('canvas');
    this.slopeCanvas.width = this.slopeCanvas.height = 400;
    this.slopeTex = new THREE.CanvasTexture(this.slopeCanvas);
    this.slopeTex.flipY = false;
    this.slopePainted = false;
  }

  // ---------------------------------------------------------------- draped lines
  drape(pts, step = 4, lift = 1.6) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
      for (let k = 0; k < n; k++) {
        const x = ax + (bx - ax) * (k / n), z = az + (bz - az) * (k / n);
        out.push(x, this.t.heightAt(x, z) + lift, z);
      }
    }
    const [lx, lz] = pts[pts.length - 1];
    out.push(lx, this.t.heightAt(lx, lz) + lift, lz);
    return out;
  }

  line(pts, mat, { closed = false, lift = 1.6 } = {}) {
    const p = closed ? [...pts, pts[0]] : pts;
    if (p.length < 2) return null;
    const geo = new LineGeometry();
    geo.setPositions(this.drape(p, 4, lift));
    const l = new Line2(geo, mat);
    l.computeLineDistances();
    l.renderOrder = 5;
    l.userData.noSensor = true;
    return l;
  }

  // ---------------------------------------------------------------- markers
  nextLabel(type) {
    this.counters[type] = (this.counters[type] || 0) + 1;
    return type === 'OP' ? `OP ${this.counters[type]}` : type === 'HLZ' ? `HLZ ${this.counters[type]}` : type === 'ORP' ? 'ORP' : `${type}${this.counters[type]}`;
  }

  addMarker(type, x, z, { label, fixed = false, pole = 14 } = {}) {
    label = label ?? this.nextLabel(type);
    const g = new THREE.Group();
    g.userData.noSensor = true;
    const y = this.t.heightAt(x, z);
    const spr = spriteFrom(symbolCanvas(type, label), 0.05);
    spr.center.set(64 / 192, 0.5);
    spr.position.set(x, y + pole, z);
    const pl = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, y, z), new THREE.Vector3(x, y + pole, z)]), new THREE.LineBasicMaterial({ color: AFFIL[type]?.fill || '#fff', transparent: true, opacity: 0.8 }));
    g.add(spr, pl);
    if (type === 'HLZ') {
      const ring = this.line(circle(x, z, 30, 40), lineMat(0xffffff, 2.5, { dashed: true }), { closed: true, lift: 0.6 });
      g.add(ring);
    }
    this.root.add(g);
    const m = { id: `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, type, x, z, label, obj: g, fixed };
    this.markers.push(m);
    if (!fixed) this.onEvent('marker', m);
    return m;
  }

  removeMarker(m) {
    this.root.remove(m.obj);
    this.markers = this.markers.filter((k) => k !== m);
  }

  // ---------------------------------------------------------------- routes
  routeClick(x, z) {
    if (!this.draft) this.draft = { pts: [], obj: new THREE.Group() };
    this.draft.pts.push([x, z]);
    this.root.add(this.draft.obj);
    this.redrawDraft();
    this.onEvent('routeDraft', this.draft);
  }

  redrawDraft() {
    const d = this.draft;
    d.obj.clear();
    const l = this.line(d.pts, this.draftMat || (this.draftMat = lineMat(0x6fe3ff, 4, { opacity: 0.95 })));
    if (l) d.obj.add(l);
    d.pts.forEach(([x, z], k) => {
      const s = textSprite(k === 0 ? 'SP' : `WP${k}`, { color: '#0b1720', bg: '#6fe3ff', size: 24, h: 0.026 });
      s.position.set(x, this.t.heightAt(x, z) + 6, z);
      d.obj.add(s);
    });
  }

  finishRoute() {
    const d = this.draft;
    if (!d || d.pts.length < 2) return null;
    this.draft = null;
    d.obj.clear();
    const l = this.line(d.pts, lineMat(0x3fb5ff, 5));
    d.obj.add(l);
    d.pts.forEach(([x, z], k) => {
      const last = k === d.pts.length - 1;
      const s = textSprite(k === 0 ? 'SP' : last ? 'RP' : `WP${k}`, { color: '#fff', bg: '#1d6fb8', size: 24, h: 0.026 });
      s.position.set(x, this.t.heightAt(x, z) + 6, z);
      d.obj.add(s);
    });
    const route = { pts: d.pts, obj: d.obj, ...this.analyzeRoute(d.pts) };
    this.routes.push(route);
    this.onEvent('route', route);
    return route;
  }

  undoWaypoint() {
    if (!this.draft) return;
    this.draft.pts.pop();
    if (!this.draft.pts.length) { this.root.remove(this.draft.obj); this.draft = null; } else this.redrawDraft();
  }

  /**
   * Can a known enemy position see a person standing at (x, z)? Each threat observes out to its
   * range and, if it has one, only inside its sector (bearings, clockwise from..to).
   */
  threatSees(x, z, eye = 1.7) {
    const p = { x, y: this.t.heightAt(x, z) + eye, z };
    return this.threats.some((th) => {
      if (Math.hypot(th.x - x, th.z - z) > th.range) return false;
      if (th.sector) {
        const b = bearing(th.x, th.z, x, z), [f, t] = th.sector;
        if (!(f <= t ? b >= f && b <= t : b >= f || b <= t)) return false;
      }
      return this.t.los(th, p);
    });
  }

  /** Length, climb, steepest leg, exposure to threats and river crossings for a route. */
  analyzeRoute(pts) {
    const samples = [];
    let dist = 0, climb = 0, maxSlope = 0, exposed = 0, crossings = 0, prevH = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 10));
      for (let k = 0; k < n; k++) {
        const x = ax + (bx - ax) * (k / n), z = az + (bz - az) * (k / n);
        const h = this.t.heightAt(x, z);
        if (prevH !== null) {
          const dh = h - prevH;
          if (dh > 0) climb += dh;
          maxSlope = Math.max(maxSlope, Math.atan(Math.abs(dh) / (L / n)) / DEG);
        }
        const vis = this.threatSees(x, z);
        if (vis) exposed += L / n;
        samples.push({ d: dist, h, vis, x, z });
        dist += L / n;
        prevH = h;
      }
    }
    // river crossings away from the bridge / ford
    const crossAt = [];
    for (let s = 1; s < samples.length; s++) {
      const a = samples[s - 1], b = samples[s];
      const sa = Math.sign(a.x - riverAt(a.z)), sb = Math.sign(b.x - riverAt(b.z));
      if (sa !== sb) crossAt.push({ x: b.x, z: b.z });
    }
    for (const c of crossAt) {
      const nearCrossing = [this.t.places.BRIDGE, this.t.places.FORD].some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 30);
      if (!nearCrossing) crossings++;
    }
    const last = pts[pts.length - 1];
    samples.push({ d: dist, h: this.t.heightAt(last[0], last[1]), vis: false, x: last[0], z: last[1] });
    return { length: dist, climb, maxSlope, exposure: dist ? exposed / dist : 0, wetCrossings: crossings, samples };
  }

  clearRoutes() {
    for (const r of this.routes) this.root.remove(r.obj);
    if (this.draft) this.root.remove(this.draft.obj);
    this.routes = []; this.draft = null;
  }

  // ---------------------------------------------------------------- range & bearing
  rbClick(x, z) {
    if (!this.rbPending) {
      if (this.rb) { this.root.remove(this.rb.obj); this.rb = null; }
      this.rbPending = { x, z };
      this.onEvent('rbStart', this.rbPending);
      return null;
    }
    const a = this.rbPending, b = { x, z };
    this.rbPending = null;
    const ay = this.t.heightAt(a.x, a.z) + 1.7, by = this.t.heightAt(b.x, b.z) + 1.7;
    const range = Math.hypot(b.x - a.x, b.z - a.z);
    const slant = Math.hypot(range, by - ay);
    const brg = bearing(a.x, a.z, b.x, b.z);
    const los = this.t.los({ x: a.x, y: ay, z: a.z }, { x: b.x, y: by, z: b.z });
    const obj = new THREE.Group();
    // straight sight line in the air between the two eyes, coloured by LOS
    const geo = new LineGeometry();
    geo.setPositions([a.x, ay, a.z, b.x, by, b.z]);
    const l = new Line2(geo, lineMat(los ? 0x7dff8a : 0xff5c5c, 3, { dashed: !los }));
    l.computeLineDistances();
    obj.add(l);
    const lbl = textSprite(`${fmtDist(range)}  ${brg.toFixed(0).padStart(3, '0')}°  ${Math.round(brg * 17.7778)} mil  ${los ? 'LOS' : 'NO LOS'}`, { color: los ? '#bfffc6' : '#ffc2c2', size: 26, h: 0.03 });
    lbl.position.set((a.x + b.x) / 2, (ay + by) / 2 + 12, (a.z + b.z) / 2);
    obj.add(lbl);
    this.root.add(obj);
    this.rb = { a, b, range, slant, bearing: brg, los, dz: by - ay, obj };
    this.onEvent('rb', this.rb);
    return this.rb;
  }

  // ---------------------------------------------------------------- overlays
  runViewshed(x, z, radius = 900) {
    const frac = this.t.paintViewshed(this.ovCanvas, { x, z }, radius);
    this.ovTex.needsUpdate = true;
    if (this.viewshed) this.root.remove(this.viewshed.obj);
    const obj = new THREE.Group();
    const s = textSprite(`VIEWSHED ${Math.round(frac * 100)}% seen in ${fmtDist(radius)}`, { color: '#ffe680', size: 24, h: 0.026 });
    s.position.set(x, this.t.heightAt(x, z) + 22, z);
    obj.add(s);
    this.root.add(obj);
    this.viewshed = { x, z, frac, obj };
    this.setOverlay('viewshed');
    this.onEvent('viewshed', this.viewshed);
  }

  setOverlay(kind) {
    if (kind === 'slope' && !this.slopePainted) { this.t.paintSlope(this.slopeCanvas); this.slopeTex.needsUpdate = true; this.slopePainted = true; }
    this.overlay = kind;
    this.onOverlay?.(kind);
  }

  // ---------------------------------------------------------------- tags
  toggleTag(entry) {
    if (this.tags.has(entry)) {
      this.tags.delete(entry);
      if (entry.tagObj) this.root.remove(entry.tagObj);
    } else {
      this.tags.add(entry);
      const box = new THREE.Box3().setFromObject(entry.group);
      const c = box.getCenter(new THREE.Vector3());
      const n = this.tags.size;
      const s = textSprite(`◆ SPOT ${n} · ${entry.kind.toUpperCase()}`, { color: '#ffd166', size: 24, h: 0.026, border: '#ffd166' });
      s.position.set(c.x, box.max.y + 5, c.z);
      entry.tagObj = s;
      this.root.add(s);
    }
    this.onEvent('tag', entry);
  }

  clearTags() { for (const e of [...this.tags]) this.toggleTag(e); }

  clearAll() {
    for (const m of [...this.markers]) if (!m.fixed) this.removeMarker(m);
    this.clearRoutes();
    if (this.rb) { this.root.remove(this.rb.obj); this.rb = null; }
    this.rbPending = null;
    if (this.viewshed) { this.root.remove(this.viewshed.obj); this.viewshed = null; }
    for (const e of [...this.tags]) { this.tags.delete(e); if (e.tagObj) this.root.remove(e.tagObj); }
    this.counters = {};
    this.setOverlay('none');
  }

  /** Keep screen-space sprites the same size whatever the field of view. */
  update(cam) {
    const k = Math.tan((cam.fov * DEG) / 2) / Math.tan(25 * DEG);
    for (const s of LABEL_SPRITES) {
      const [w, h] = s.userData.baseScale;
      s.scale.set(w * k, h * k, 1);
    }
  }

  describePoint(x, z) {
    return `${mgrs(x, z)} · ${Math.round(this.t.heightAt(x, z) + MSL)} m MSL · slope ${this.t.slopeAt(x, z).toFixed(0)}°`;
  }
}

function riverAt(z) {
  return -40 + 120 * Math.sin(z / 240 + 0.6) + 0.12 * z;
}

export function circle(x, z, r, n = 32) {
  const out = [];
  for (let k = 0; k < n; k++) out.push([x + Math.cos((k / n) * Math.PI * 2) * r, z + Math.sin((k / n) * Math.PI * 2) * r]);
  return out;
}

export { polyLength, HALF, SIZE };
