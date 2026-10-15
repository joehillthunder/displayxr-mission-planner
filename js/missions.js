// Missions: short, graded planning drills in AO GRANITE. Each one is a brief (situation,
// task, constraints), live objectives that tick as the planner works, and an after-action
// review that scores the plan against the actual terrain and the actual (hidden) ground truth.
//
// Ratings follow the Army's T / P / U training scale (Trained, Practiced, Untrained).

import * as THREE from 'three';
import { clamp, fmtDist, fmtTime, DEG } from './util.js';
import { PLACES } from './terrain.js';
import { lineMat, textSprite, circle } from './tools.js';

export function rating(score) {
  if (score >= 90) return { code: 'T', name: 'Trained', stars: 3 };
  if (score >= 75) return { code: 'T-', name: 'Trained (minus)', stars: 3 };
  if (score >= 60) return { code: 'P', name: 'Practiced', stars: 2 };
  if (score >= 40) return { code: 'P-', name: 'Practiced (minus)', stars: 1 };
  return { code: 'U', name: 'Untrained', stars: 0 };
}

const near = (a, b, r) => a && b && Math.hypot(a.x - b.x, a.z - b.z) <= r;
const timeBonus = (t, par, max) => Math.round(max * clamp(1 - (t - par) / (par * 1.5), 0, 1));

/** Common intel graphics: OBJ IRON, AA FALCON, known enemy positions. */
export function intel(ctx, { op = true, ckp = true, orp = false } = {}) {
  const { tools, t, world } = ctx;
  const o = PLACES.OBJ_IRON;
  const objLine = tools.line(circle(o.x, o.z, 135, 48), lineMat(0x111111, 4), { closed: true, lift: 2 });
  const objIn = tools.line(circle(o.x, o.z, 131, 48), lineMat(0xff4d4d, 2, { dashed: true }), { closed: true, lift: 2 });
  ctx.graphics.add(objLine, objIn);
  const lb = textSprite('OBJ IRON', { color: '#ffb3b3', bg: 'rgba(30,0,0,0.75)', size: 32, h: 0.036, border: '#ff4d4d' });
  lb.position.set(o.x, t.heightAt(o.x, o.z) + 45, o.z - 135);
  const a = PLACES.AA_FALCON;
  const aaLine = tools.line(circle(a.x, a.z, 85, 32), lineMat(0x3fb5ff, 3), { closed: true, lift: 2 });
  const la = textSprite('AA FALCON', { color: '#cbeaff', bg: 'rgba(0,20,40,0.75)', size: 30, h: 0.032, border: '#3fb5ff' });
  la.position.set(a.x, t.heightAt(a.x, a.z) + 40, a.z + 85);
  ctx.graphics.add(lb, aaLine, la);
  for (const p of [PLACES.BRIDGE, PLACES.FORD, PLACES.HILL_431, PLACES.HILL_388, PLACES.HILL_352]) {
    const s = textSprite(p.name, { color: '#dfe9f2', bg: 'rgba(10,14,18,0.6)', size: 22, h: 0.022 });
    s.position.set(p.x, t.heightAt(p.x, p.z) + (p === PLACES.HILL_431 ? 8 : 30), p.z + (p === PLACES.HILL_431 ? 60 : 0));
    ctx.graphics.add(s);
  }
  if (op) tools.addMarker('ENOP', world.enemyOP.x, world.enemyOP.z, { label: 'EN OP', fixed: true, pole: 20 });
  if (ckp) tools.addMarker('H', world.checkpoint.x, world.checkpoint.z, { label: 'CKP', fixed: true });
  if (orp) tools.addMarker('ORP', ctx.points.ORP.x, ctx.points.ORP.z, { label: '', fixed: true });
  ctx.tools.threats = [];
  if (op) {
    const th = { x: world.enemyOP.x, y: world.enemyOP.y, z: world.enemyOP.z, range: THREAT.op.range, sector: THREAT.op.sector };
    ctx.tools.threats.push(th);
    ctx.graphics.add(...threatFan(ctx, th, 0xff5c5c));
  }
  if (ckp) {
    const th = { x: world.checkpoint.x, y: t.heightAt(world.checkpoint.x, world.checkpoint.z) + 2.5, z: world.checkpoint.z, range: THREAT.ckp.range, sector: null };
    ctx.tools.threats.push(th);
    ctx.graphics.add(...threatFan(ctx, th, 0xff9c5c));
  }
}

function threatSees(ctx, x, z, eye = 1.7) {
  return ctx.tools.threatSees(x, z, eye);
}

/** What intel says each enemy position can observe. */
export const THREAT = {
  op: { range: 1200, sector: [170, 240] }, // faces the bridge and the main road
  ckp: { range: 400 },
};

/** Draw a threat's observation limits: a sector fan or a range ring. */
function threatFan(ctx, th, color) {
  const pts = [];
  if (th.sector) {
    const [f, t] = th.sector;
    pts.push([th.x, th.z]);
    for (let b = f; b <= t; b += 5) pts.push([th.x + Math.sin(b * DEG) * th.range, th.z - Math.cos(b * DEG) * th.range]);
    pts.push([th.x, th.z]);
  } else pts.push(...circle(th.x, th.z, th.range, 48), circle(th.x, th.z, th.range, 48)[0]);
  const clip = pts.map(([x, z]) => [clamp(x, -799, 799), clamp(z, -799, 799)]);
  const l = ctx.tools.line(clip, lineMat(color, 2, { dashed: true, opacity: 0.85 }), { lift: 3 });
  return l ? [l] : [];
}

export const MISSIONS = [
  // ------------------------------------------------------------------ 1
  {
    id: 'orient',
    code: 'M1',
    name: 'Terrain Walk',
    tag: 'Orientation · Day',
    par: 240,
    tools: ['select', 'rb', 'marker', 'isr', 'ground'],
    brief: {
      situation: 'Your platoon arrived at AA FALCON last night. Higher reports enemy activity in the village of OBJ IRON and a vehicle checkpoint (CKP) on the road north-east of BRIDGE 7.',
      task: 'Get to know the AO before the planning cycle starts. Measure the objective, mark the checkpoint, look at the objective from the ISR aircraft, and walk BRIDGE 7 on the ground.',
      constraints: 'Day. All sensors available. Par time 4:00.',
    },
    setup(ctx) {
      intel(ctx, { ckp: false });
      ctx.env.setNight(false);
      ctx.cam.go('MAP', { x: -200, z: 150, dist: 1500, yaw: 0.5, pitch: 55 * DEG, instant: true });
      ctx.tools.markerType = 'H';
    },
    objectives: [
      { id: 'rb', text: 'Range & bearing from AA FALCON to OBJ IRON', hint: 'R&B tool: click in AA FALCON, then in OBJ IRON.', check: (c) => near(c.tools.rb?.a, PLACES.AA_FALCON, 90) && near(c.tools.rb?.b, PLACES.OBJ_IRON, 130) },
      { id: 'ckp', text: 'Find the checkpoint and drop a Hostile marker on it', hint: 'Follow the road NE from BRIDGE 7. Zoom in: a pickup and two sentries.', check: (c) => c.tools.markers.some((m) => m.type === 'H' && !m.fixed && near(m, c.world.checkpoint, 40)) },
      { id: 'isr', text: 'Put the ISR orbit over OBJ IRON', hint: 'ISR tool, then click the village.', check: (c) => c.cam.mode === 'ISR' && near(c.cam.isr, PLACES.OBJ_IRON, 160) },
      { id: 'ground', text: 'Go to ground at BRIDGE 7', hint: 'GROUND tool, then click the bridge. WASD to walk, drag to look.', check: (c) => c.cam.groundVisited.some((g) => near(g, PLACES.BRIDGE, 45)) },
    ],
    evaluate(ctx, done, time) {
      const items = this.objectives.map((o) => ({ label: o.text, pts: done.has(o.id) ? 22 : 0, max: 22 }));
      if (ctx.tools.rb) {
        const err = Math.abs(ctx.tools.rb.range - Math.hypot(PLACES.AA_FALCON.x - PLACES.OBJ_IRON.x, PLACES.AA_FALCON.z - PLACES.OBJ_IRON.z));
        items.push({ label: `Measured ${fmtDist(ctx.tools.rb.range)} (centre-to-centre error ${Math.round(err)} m)`, pts: err < 60 ? 4 : 0, max: 4 });
      }
      items.push({ label: `Time ${fmtTime(time)} (par ${fmtTime(this.par)})`, pts: timeBonus(time, this.par, 8), max: 8 });
      return items;
    },
  },

  // ------------------------------------------------------------------ 2
  {
    id: 'isr',
    code: 'M2',
    name: 'Pattern of Life',
    tag: 'ISR · Thermal · Night',
    par: 420,
    tools: ['select', 'tag', 'isr', 'marker'],
    brief: {
      situation: 'Night. An ISR aircraft is on station over OBJ IRON. Human intelligence says fighters bed down in several houses and a weapons cache is hidden inside a two-storey house in a walled compound.',
      task: 'Using the thermal (IR) and structure-penetrating (X-RAY) sensors, spot-tag every occupied building and every vehicle with a hot engine. Locate the cache by holding it in the X-RAY view.',
      constraints: 'Night: EO is nearly useless. Tag only what you can confirm; false tags cost points. Par time 7:00.',
    },
    setup(ctx) {
      intel(ctx);
      ctx.env.setNight(true);
      ctx.cam.go('ISR', { x: PLACES.OBJ_IRON.x, z: PLACES.OBJ_IRON.z, instant: true });
      ctx.sensors.set('IR');
      ctx.state.cacheSeen = false;
    },
    update(ctx) {
      // The cache is "located" when its building is near the middle of the X-RAY picture, zoomed in.
      if (ctx.state.cacheSeen || ctx.sensors.mode !== 'XRAY') return;
      const cache = ctx.world.buildings.find((b) => b.cache);
      if (ctx.centred(new THREE.Vector3(cache.x, ctx.t.heightAt(cache.x, cache.z) + 2, cache.z), 0.12) && ctx.cam.cam.fov < 20) {
        ctx.state.cacheSeen = true;
        ctx.toast('CACHE LOCATED — dense metal in the compound house (X-RAY)', 'ok');
      }
    },
    objectives: [
      { id: 'occ', text: 'Tag occupied buildings in OBJ IRON (5 of 6)', hint: 'IR: warm bodies glow through open doors and windows; X-RAY shows them through walls.', check: (c) => occTagged(c) >= 5, progress: (c) => `${occTagged(c)}/6` },
      { id: 'veh', text: 'Tag the two vehicles with hot engines', hint: 'In IR a running engine block and exhaust glow white.', check: (c) => hotTagged(c) >= 2, progress: (c) => `${hotTagged(c)}/2` },
      { id: 'cache', text: 'Locate the weapons cache (X-RAY, zoomed in)', hint: 'Switch to X-RAY, zoom the ISR camera under 20°, and hold the compound house in the centre.', check: (c) => c.state.cacheSeen },
      { id: 'clean', text: 'No more than one false tag', hint: 'Untag with a second click.', check: (c) => falseTags(c) <= 1 && c.tools.tags.size > 0, progress: (c) => `${falseTags(c)} false` },
    ],
    evaluate(ctx, done, time) {
      const occ = occTagged(ctx), hot = hotTagged(ctx), ft = falseTags(ctx);
      return [
        { label: `Occupied buildings tagged ${occ}/6`, pts: Math.round((occ / 6) * 40), max: 40 },
        { label: `Hot vehicles tagged ${hot}/2`, pts: hot * 8, max: 16 },
        { label: ctx.state.cacheSeen ? 'Cache located with X-RAY' : 'Cache not located', pts: ctx.state.cacheSeen ? 24 : 0, max: 24 },
        { label: `False tags: ${ft}`, pts: Math.max(0, 12 - ft * 6), max: 12 },
        { label: `Time ${fmtTime(time)} (par ${fmtTime(this.par)})`, pts: timeBonus(time, this.par, 8), max: 8 },
      ];
    },
  },

  // ------------------------------------------------------------------ 3
  {
    id: 'overwatch',
    code: 'M3',
    name: 'Overwatch',
    tag: 'Line of sight · Day',
    par: 360,
    tools: ['select', 'marker', 'rb', 'viewshed', 'ground'],
    brief: {
      situation: 'The assault on OBJ IRON needs a support-by-fire / overwatch position that sees into the village while staying out of sight of the enemy OP on HILL 431 and the checkpoint.',
      task: 'Place an OP marker. It must see the four key points of OBJ IRON (marked K1–K4), stand off 350–1,000 m from the village centre, and be masked from known enemy positions.',
      constraints: 'EN OP watches the red fan (bearings 170°–240°, out to 1.2 km); the checkpoint sees 400 m around it. Use VIEWSHED from a candidate to check what it sees. Line of sight includes forest canopy. Par time 6:00.',
    },
    setup(ctx) {
      intel(ctx);
      ctx.env.setNight(false);
      ctx.cam.go('MAP', { x: 330, z: -40, dist: 1300, yaw: -0.4, pitch: 50 * DEG, instant: true });
      ctx.tools.markerType = 'OP';
      ctx.state.keys = keyPoints(ctx);
      ctx.state.keys.forEach((k, i) => {
        const s = textSprite(`K${i + 1}`, { color: '#fff', bg: '#b3261e', size: 24, h: 0.026 });
        s.position.set(k.x, k.y + 10, k.z);
        ctx.graphics.add(s);
      });
    },
    objectives: [
      { id: 'place', text: 'Place an OP marker', hint: 'MARKER tool with type OP.', check: (c) => !!lastOf(c, 'OP') },
      { id: 'los', text: 'OP sees at least 3 of 4 key points', hint: 'High ground east or south of the village. Watch the treelines.', check: (c) => opLos(c) >= 3, progress: (c) => `${opLos(c)}/4` },
      { id: 'stand', text: 'Stand-off 350–1,000 m from OBJ IRON', check: (c) => { const o = lastOf(c, 'OP'); const d = o && Math.hypot(o.x - PLACES.OBJ_IRON.x, o.z - PLACES.OBJ_IRON.z); return d >= 350 && d <= 1000; }, progress: (c) => { const o = lastOf(c, 'OP'); return o ? fmtDist(Math.hypot(o.x - PLACES.OBJ_IRON.x, o.z - PLACES.OBJ_IRON.z)) : '—'; } },
      { id: 'mask', text: 'Masked from EN OP and the checkpoint', hint: 'Run VIEWSHED from EN OP: red is what it sees.', check: (c) => { const o = lastOf(c, 'OP'); return o && !threatSees(c, o.x, o.z); } },
    ],
    evaluate(ctx, done, time) {
      const o = lastOf(ctx, 'OP');
      const los = opLos(ctx);
      const d = o ? Math.hypot(o.x - PLACES.OBJ_IRON.x, o.z - PLACES.OBJ_IRON.z) : 0;
      const masked = o && !threatSees(ctx, o.x, o.z);
      return [
        { label: o ? `OP at ${ctx.tools.describePoint(o.x, o.z)}` : 'No OP placed', pts: o ? 5 : 0, max: 5 },
        { label: `Sees ${los}/4 key points`, pts: los * 12, max: 48 },
        { label: `Stand-off ${o ? fmtDist(d) : '—'}`, pts: d >= 350 && d <= 1000 ? 15 : d > 250 && d < 1200 ? 7 : 0, max: 15 },
        { label: masked ? 'Masked from known enemy' : 'Visible to known enemy', pts: masked ? 24 : 0, max: 24 },
        { label: `Time ${fmtTime(time)} (par ${fmtTime(this.par)})`, pts: timeBonus(time, this.par, 8), max: 8 },
      ];
    },
  },

  // ------------------------------------------------------------------ 4
  {
    id: 'route',
    code: 'M4',
    name: 'Infiltration Route',
    tag: 'Route · Exposure · Day',
    par: 480,
    tools: ['select', 'route', 'viewshed', 'rb', 'slope', 'ground'],
    brief: {
      situation: 'The assault force moves on foot from AA FALCON to the objective rally point (ORP) east of OBJ IRON tonight. The enemy OP on HILL 431 and the checkpoint watch the main road and BRIDGE 7.',
      task: 'Plan a dismounted route: start (SP) in AA FALCON, end (RP) at the ORP. Minimise time in view of known enemy, cross the river only at BRIDGE 7 or the FORD, and keep legs walkable.',
      constraints: 'EN OP watches the red fan out to 1.2 km; the checkpoint sees 400 m. Exposure under 15 %, no wet crossings, steepest leg under 30°, under 3.2 km. The elevation profile shows exposed stretches in red. Par time 8:00.',
    },
    setup(ctx) {
      intel(ctx, { orp: true });
      ctx.env.setNight(false);
      ctx.cam.go('MAP', { x: -150, z: 50, dist: 1650, yaw: 0.25, pitch: 62 * DEG, instant: true });
    },
    objectives: [
      { id: 'sp', text: 'Route starts in AA FALCON and ends at the ORP', hint: 'ROUTE tool: click points, Enter or double-click to finish.', check: (c) => { const r = lastRoute(c); return r && near(xz(r.pts[0]), PLACES.AA_FALCON, 90) && near(xz(r.pts[r.pts.length - 1]), c.points.ORP, 45); } },
      { id: 'exp', text: 'Exposure to known enemy under 15 %', check: (c) => lastRoute(c)?.exposure < 0.15, progress: (c) => (lastRoute(c) ? `${Math.round(lastRoute(c).exposure * 100)} %` : '—') },
      { id: 'wet', text: 'River crossed only at BRIDGE 7 or the FORD', check: (c) => lastRoute(c) && lastRoute(c).wetCrossings === 0 },
      { id: 'walk', text: 'Steepest leg under 30°, length under 3.2 km', check: (c) => { const r = lastRoute(c); return r && r.maxSlope < 30 && r.length < 3200; }, progress: (c) => { const r = lastRoute(c); return r ? `${r.maxSlope.toFixed(0)}° · ${fmtDist(r.length)}` : '—'; } },
    ],
    evaluate(ctx, done, time) {
      const r = lastRoute(ctx);
      if (!r) return [{ label: 'No route finished', pts: 0, max: 100 }];
      const ok = done.has('sp');
      return [
        { label: ok ? 'SP in AA FALCON, RP at ORP' : 'Route does not connect AA FALCON to the ORP', pts: ok ? 20 : 0, max: 20 },
        { label: `Exposure ${Math.round(r.exposure * 100)} % of ${fmtDist(r.length)}`, pts: Math.round(36 * clamp((0.35 - r.exposure) / 0.3, 0, 1)), max: 36 },
        { label: r.wetCrossings ? `${r.wetCrossings} wet crossing(s)` : 'Dry crossings only', pts: r.wetCrossings ? 0 : 14, max: 14 },
        { label: `Steepest leg ${r.maxSlope.toFixed(0)}°, climb ${Math.round(r.climb)} m`, pts: r.maxSlope < 30 ? 10 : r.maxSlope < 40 ? 5 : 0, max: 10 },
        { label: `Length ${fmtDist(r.length)}`, pts: r.length < 3200 ? 12 : r.length < 4000 ? 6 : 0, max: 12 },
        { label: `Time ${fmtTime(time)} (par ${fmtTime(this.par)})`, pts: timeBonus(time, this.par, 8), max: 8 },
      ];
    },
  },

  // ------------------------------------------------------------------ 5
  {
    id: 'hlz',
    code: 'M5',
    name: 'Landing Zone',
    tag: 'Slope · Obstacles · Day',
    par: 360,
    tools: ['select', 'marker', 'slope', 'viewshed', 'rb', 'ground'],
    brief: {
      situation: 'A casualty evacuation and resupply helicopter needs a landing zone that supports the OBJ IRON assault.',
      task: 'Place an HLZ marker. The 30 m touchdown circle must be flat (under 7°), clear of trees and buildings, 600–1,500 m from OBJ IRON, and masked from known enemy positions.',
      constraints: 'Use the SLOPE overlay (green < 7°, amber < 15°, red steeper). Stay outside what EN OP (red fan) and the checkpoint (400 m) can see. Go to ground to check for obstacles. Par time 6:00.',
    },
    setup(ctx) {
      intel(ctx);
      ctx.env.setNight(false);
      ctx.cam.go('MAP', { x: -150, z: 150, dist: 1500, yaw: 0.3, pitch: 58 * DEG, instant: true });
      ctx.tools.markerType = 'HLZ';
    },
    objectives: [
      { id: 'place', text: 'Place an HLZ marker', check: (c) => !!lastOf(c, 'HLZ') },
      { id: 'flat', text: 'Touchdown circle under 7° everywhere', hint: 'SLOPE overlay: keep the whole 30 m ring on green.', check: (c) => hlzSlope(c) < 7, progress: (c) => (lastOf(c, 'HLZ') ? `${hlzSlope(c).toFixed(1)}°` : '—') },
      { id: 'clear', text: 'No trees or buildings within 35 m', check: (c) => hlzObstacles(c) === 0, progress: (c) => (lastOf(c, 'HLZ') ? `${hlzObstacles(c)} obstacles` : '—') },
      { id: 'dist', text: '600–1,500 m from OBJ IRON', check: (c) => { const d = hlzDist(c); return d >= 600 && d <= 1500; }, progress: (c) => (lastOf(c, 'HLZ') ? fmtDist(hlzDist(c)) : '—') },
      { id: 'mask', text: 'Masked from EN OP and the checkpoint', check: (c) => { const h = lastOf(c, 'HLZ'); return h && !threatSees(c, h.x, h.z, 4); } },
    ],
    evaluate(ctx, done, time) {
      const h = lastOf(ctx, 'HLZ');
      if (!h) return [{ label: 'No HLZ placed', pts: 0, max: 100 }];
      const s = hlzSlope(ctx), ob = hlzObstacles(ctx), d = hlzDist(ctx), masked = !threatSees(ctx, h.x, h.z, 4);
      return [
        { label: `Max slope ${s.toFixed(1)}°`, pts: s < 7 ? 26 : s < 12 ? 12 : 0, max: 26 },
        { label: `${ob} obstacles inside 35 m`, pts: Math.max(0, 22 - ob * 4), max: 22 },
        { label: `${fmtDist(d)} from OBJ IRON`, pts: d >= 600 && d <= 1500 ? 16 : 6, max: 16 },
        { label: masked ? 'Masked from known enemy' : 'Visible to known enemy', pts: masked ? 28 : 0, max: 28 },
        { label: `Time ${fmtTime(time)} (par ${fmtTime(this.par)})`, pts: timeBonus(time, this.par, 8), max: 8 },
      ];
    },
  },

  // ------------------------------------------------------------------ 6
  {
    id: 'rehearsal',
    code: 'M6',
    name: 'Ground Rehearsal',
    tag: 'First person · Night',
    par: 300,
    tools: ['select'],
    ground: true,
    brief: {
      situation: 'Rehearsal of the final approach. You are at the ORP at night. Sentries patrol OBJ IRON; two more stand in the market square.',
      task: 'Walk the approach: reach the LAST COVERED POSITION, then the BREACH POINT at the cache compound, then return to the ORP — without being detected.',
      constraints: 'WASD to move, drag to look, C to crouch (slower, much harder to see), Shift to run (louder). Use IR (key 2) to see sentries. Detection at 100 % ends the rehearsal. Par time 5:00.',
    },
    setup(ctx) {
      intel(ctx, { orp: true });
      ctx.env.setNight(true);
      ctx.sensors.set('IR');
      const { ORP, LCP, BREACH } = ctx.points;
      ctx.cam.go('GROUND', { x: ORP.x, z: ORP.z, faceX: LCP.x, faceZ: LCP.z, instant: true });
      ctx.state.leg = 0;
      ctx.state.detect = 0;
      ctx.state.peak = 0;
      ctx.state.failed = false;
      for (const [p, name, col] of [[LCP, 'LAST COVERED POSITION', 0x6fe3ff], [BREACH, 'BREACH POINT', 0xffd166]]) {
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 60, 12, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
        beam.position.set(p.x, ctx.t.heightAt(p.x, p.z) + 30, p.z);
        beam.userData.noSensor = true;
        const s = textSprite(name, { color: '#0b1720', bg: `#${col.toString(16).padStart(6, '0')}`, size: 22, h: 0.024 });
        s.position.set(p.x, ctx.t.heightAt(p.x, p.z) + 4, p.z);
        ctx.graphics.add(beam, s);
      }
    },
    update(ctx, dt) {
      const st = ctx.state;
      if (st.failed || ctx.cam.mode !== 'GROUND') return;
      const g = ctx.cam.ground;
      const legs = [ctx.points.LCP, ctx.points.BREACH, ctx.points.ORP];
      if (st.leg < 3 && near(g, legs[st.leg], 4)) {
        st.leg++;
        ctx.toast(['Last covered position reached', 'Breach point reached — now back to the ORP', 'Back at the ORP. Rehearsal complete.'][st.leg - 1], 'ok');
        if (st.leg === 3) ctx.complete();
      }
      const rate = sentryRate(ctx, g);
      st.seen = rate > 0;
      st.detect = clamp(st.detect + (rate > 0 ? rate * dt : -8 * dt), 0, 100);
      st.peak = Math.max(st.peak, st.detect);
      if (st.detect >= 100) {
        st.failed = true;
        ctx.toast('COMPROMISED — a sentry saw you. Rehearsal ends.', 'bad');
        ctx.complete();
      }
    },
    objectives: [
      { id: 'lcp', text: 'Reach the LAST COVERED POSITION', check: (c) => c.state.leg >= 1 },
      { id: 'breach', text: 'Reach the BREACH POINT', check: (c) => c.state.leg >= 2 },
      { id: 'exfil', text: 'Return to the ORP', check: (c) => c.state.leg >= 3 },
      { id: 'quiet', text: 'Stay undetected', check: (c) => !c.state.failed && c.state.leg >= 3, progress: (c) => `${Math.round(c.state.detect || 0)} %` },
    ],
    evaluate(ctx, done, time) {
      const st = ctx.state;
      return [
        { label: `Legs completed ${st.leg}/3`, pts: st.leg * 16, max: 48 },
        { label: st.failed ? 'Compromised' : `Peak detection ${Math.round(st.peak)} %`, pts: st.failed ? 0 : Math.round(32 * (1 - st.peak / 100)), max: 32 },
        { label: `Time ${fmtTime(time)} (par ${fmtTime(this.par)})`, pts: st.leg >= 3 ? timeBonus(time, this.par, 20) : 0, max: 20 },
      ];
    },
  },
];

/**
 * How fast the sentries are noticing a walker at g = {x, z, crouch, speed}: detection % per second.
 * Each sentry has a 130° cone, shorter at night and far shorter for a crouched walker; a running
 * walker is heard close by whatever way the sentry faces. Walls and terrain block sight.
 */
export function sentryRate(ctx, g) {
  const eyeY = ctx.t.heightAt(g.x, g.z) + (g.crouch ? 1.0 : 1.6);
  const running = g.speed > 3;
  let rate = 0;
  for (const p of ctx.world.people) {
    const pp = p.group.position;
    const dx = g.x - pp.x, dz = g.z - pp.z, d = Math.hypot(dx, dz);
    const range = g.crouch ? 13 : running ? 40 : 24;
    if (d > range) continue;
    const ang = Math.abs(((Math.atan2(dx, dz) - p.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const heard = running && d < 18;
    if (ang > 65 * DEG && !heard) continue;
    if (ctx.world.wallsBlock(pp.x, pp.z, g.x, g.z)) continue;
    if (!ctx.t.los({ x: pp.x, y: pp.y + 1.6, z: pp.z }, { x: g.x, y: eyeY, z: g.z }, { trees: false })) continue;
    rate += (1 - d / range) * 100 + 12;
  }
  return rate;
}

// ---------------------------------------------------------------- grading helpers
const xz = (p) => ({ x: p[0], z: p[1] });
const lastOf = (c, type) => [...c.tools.markers].reverse().find((m) => m.type === type && !m.fixed);
const lastRoute = (c) => c.tools.routes[c.tools.routes.length - 1];

function villageBuildingOf(entry) { return entry.kind === 'building' && entry.ref.area === 'OBJ IRON' ? entry.ref : null; }
function occTagged(c) { let n = 0; for (const e of c.tools.tags) { const b = villageBuildingOf(e); if (b?.occupied) n++; } return n; }
function hotTagged(c) { let n = 0; for (const e of c.tools.tags) if (e.kind === 'vehicle' && e.ref.running && e.ref.area === 'OBJ IRON') n++; return n; }
function falseTags(c) {
  let n = 0;
  for (const e of c.tools.tags) {
    if (e.kind === 'building' && !e.ref.occupied) n++;
    else if (e.kind === 'building' && e.ref.area !== 'OBJ IRON') n++;
    else if (e.kind === 'vehicle' && !e.ref.running) n++;
  }
  return n;
}

function keyPoints(ctx) {
  const o = PLACES.OBJ_IRON, cache = ctx.world.buildings.find((b) => b.cache);
  return [
    { x: o.x, z: o.z }, // market square
    { x: cache.x, z: cache.z + (cache.door === 'N' ? -cache.d / 2 - 5 : cache.d / 2 + 5) }, // cache compound gate
    { x: 228, z: -315 }, // north road exit
    { x: 175, z: -60 }, // south-west entry from the bridge road
  ].map((p) => ({ ...p, y: ctx.t.heightAt(p.x, p.z) + 1.5 }));
}
function opLos(c) {
  const o = lastOf(c, 'OP');
  if (!o) return 0;
  const eye = { x: o.x, y: c.t.heightAt(o.x, o.z) + 2, z: o.z };
  return (c.state.keys || keyPoints(c)).filter((k) => c.t.los(eye, k)).length;
}
function hlzSlope(c) {
  const h = lastOf(c, 'HLZ');
  if (!h) return 99;
  let s = c.t.slopeAt(h.x, h.z);
  for (let r = 10; r <= 30; r += 10) for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    s = Math.max(s, c.t.slopeAt(h.x + Math.cos(a) * r, h.z + Math.sin(a) * r));
  }
  return s;
}
function hlzObstacles(c) {
  const h = lastOf(c, 'HLZ');
  if (!h) return 99;
  let n = c.t.trees.filter((t) => Math.hypot(t.x - h.x, t.z - h.z) < 35).length;
  n += c.world.buildings.filter((b) => Math.hypot(b.x - h.x, b.z - h.z) < 35 + Math.max(b.w, b.d) / 2).length;
  return n;
}
function hlzDist(c) {
  const h = lastOf(c, 'HLZ');
  return h ? Math.hypot(h.x - PLACES.OBJ_IRON.x, h.z - PLACES.OBJ_IRON.z) : 0;
}

/** Named rehearsal points, derived from the generated village. */
export function missionPoints(world) {
  const cache = world.buildings.find((b) => b.cache);
  const gateZ = cache.door === 'N' ? cache.z - cache.d / 2 - 6.5 : cache.z + cache.d / 2 + 6.5;
  return {
    ORP: { x: 480, z: -300 }, // east of the village: outside EN OP's sector and the checkpoint's 400 m
    LCP: { x: 392, z: -238 },
    BREACH: { x: cache.x, z: gateZ },
  };
}
