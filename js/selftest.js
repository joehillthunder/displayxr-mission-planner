// ?selftest: plays each mission with a scripted planner and logs the grades, so a terrain or
// layout change that makes a mission impossible shows up in the console (and headless runs).

const say = (...a) => console.info('[selftest]', ...a);

export async function selftest(P) {
  const { MISSIONS, startMission, endMission, tools, cam, ctx, run, terrain, world, sensors } = P;
  const objIds = () => [...run.done].join(',');
  const objMet = (m) => m.objectives.map((o) => `${o.id}:${o.check(ctx) ? 'Y' : 'n'}`).join(' ');
  const score = (m) => m.evaluate(ctx, run.done, run.time).reduce((s, i) => s + i.pts, 0);
  const ret = {};

  // M1
  let m = MISSIONS[0];
  startMission(m);
  const A = terrain.places.AA_FALCON, O = terrain.places.OBJ_IRON, B = terrain.places.BRIDGE;
  tools.rbClick(A.x, A.z); tools.rbClick(O.x, O.z);
  tools.addMarker('H', world.checkpoint.x + 5, world.checkpoint.z);
  cam.go('ISR', { x: O.x, z: O.z, instant: true });
  P.checkNow();
  cam.go('GROUND', { x: B.x + 3, z: B.z, instant: true });
  P.checkNow();
  say(`M1 ${objMet(m)} done=${objIds()} score=${score(m)}`);
  ret.orient = score(m);

  // M2: tag ground truth, then find the cache with X-RAY
  m = MISSIONS[1];
  startMission(m);
  for (const t of world.taggables) {
    if ((t.kind === 'building' && t.ref.occupied && t.ref.area === 'OBJ IRON') || (t.kind === 'vehicle' && t.ref.running && t.ref.area === 'OBJ IRON')) tools.toggleTag(t);
  }
  const cache = world.buildings.find((b) => b.cache);
  cam.go('ISR', { x: cache.x, z: cache.z, instant: true });
  cam.isr.fov = 8;
  sensors.set('XRAY');
  cam.update(0.016);
  m.update(ctx, 0.016);
  P.checkNow();
  say(`M2 ${objMet(m)} cacheSeen=${ctx.state.cacheSeen} score=${score(m)}`);
  ret.isr = score(m);

  // M3: search for the best overwatch position
  m = MISSIONS[2];
  startMission(m);
  let best = null;
  for (let x = -700; x <= 780; x += 30) for (let z = -780; z <= 780; z += 30) {
    const d = Math.hypot(x - O.x, z - O.z);
    if (d < 350 || d > 1000) continue;
    const mk = tools.addMarker('OP', x, z);
    const s = score(m);
    if (!best || s > best.s) best = { x, z, s, met: objMet(m) };
    tools.removeMarker(mk);
  }
  say(`M3 best OP ${best && `${best.x},${best.z} score=${best.s} ${best.met}`}`);
  ret.overwatch = best?.s;

  // M5: search for an HLZ
  m = MISSIONS[4];
  startMission(m);
  best = null;
  for (let x = -760; x <= 760; x += 20) for (let z = -760; z <= 760; z += 20) {
    const d = Math.hypot(x - O.x, z - O.z);
    if (d < 600 || d > 1500 || terrain.slopeAt(x, z) > 7) continue;
    const mk = tools.addMarker('HLZ', x, z);
    const s = score(m);
    if (!best || s > best.s) best = { x, z, s, met: objMet(m) };
    tools.removeMarker(mk);
  }
  say(`M5 best HLZ ${best && `${best.x},${best.z} score=${best.s} ${best.met}`}`);
  ret.hlz = best?.s;

  // M4: a few candidate routes
  m = MISSIONS[3];
  startMission(m);
  const F = terrain.places.FORD, ORP = ctx.points.ORP;
  const routes = {
    bridge: [[A.x, A.z], [-380, 330], [-230, 262], [-80, 140], [B.x, B.z], [60, -100], [ORP.x, ORP.z]],
    ford: [[A.x, A.z], [-470, 300], [-430, 50], [-380, -250], [F.x - 20, F.z], [F.x + 20, F.z], [-60, -380], [ORP.x, ORP.z]],
    west: [[A.x, A.z], [-470, 300], [-440, 150], [-330, -60], [-260, -330], [F.x - 20, F.z + 10], [F.x + 25, F.z + 5], [-80, -330], [ORP.x, ORP.z]],
  };
  for (const [name, pts] of Object.entries(routes)) {
    tools.clearRoutes();
    for (const [x, z] of pts) tools.routeClick(x, z);
    const r = tools.finishRoute();
    say(`M4 route ${name}: len=${Math.round(r.length)} exposure=${(r.exposure * 100).toFixed(0)}% wet=${r.wetCrossings} slope=${r.maxSlope.toFixed(0)} score=${score(m)} ${objMet(m)}`);
    ret[`route_${name}`] = score(m);
  }

  // M4: least-exposure path on a 10 m grid (Dijkstra), to prove a good route exists
  {
    const C = 10, N = 160, H = 800, idx = (i, j) => j * N + i;
    const cost = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = -H + (i + 0.5) * C, z = -H + (j + 0.5) * C;
      const wet = terrain.riverDist(x, z) < 11 && ![B, F].some((p) => Math.hypot(p.x - x, p.z - z) < 25);
      cost[idx(i, j)] = wet || terrain.slopeAt(x, z) > 28 ? Infinity : 1 + (tools.threatSees(x, z) ? 25 : 0);
    }
    const toCell = (p) => [Math.floor((p.x + H) / C), Math.floor((p.z + H) / C)];
    const [si, sj] = toCell(A), [ti, tj] = toCell(ORP);
    const dist = new Float32Array(N * N).fill(Infinity), prev = new Int32Array(N * N).fill(-1), done = new Uint8Array(N * N);
    dist[idx(si, sj)] = 0;
    const open = [idx(si, sj)];
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (dist[open[k]] < dist[open[bi]]) bi = k;
      const u = open[bi]; open[bi] = open[open.length - 1]; open.pop();
      if (done[u]) continue; done[u] = 1;
      if (u === idx(ti, tj)) break;
      const ui = u % N, uj = (u / N) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const vi = ui + di, vj = uj + dj;
        if (vi < 0 || vj < 0 || vi >= N || vj >= N) continue;
        const v = idx(vi, vj);
        const w = Math.hypot(di, dj) * (cost[u] + cost[v]) / 2;
        if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; open.push(v); }
      }
    }
    const path = [];
    for (let v = idx(ti, tj); v !== -1; v = prev[v]) path.push([-H + ((v % N) + 0.5) * C, -H + (((v / N) | 0) + 0.5) * C]);
    path.reverse();
    const wps = path.filter(([x, z], k) => k % 6 === 0 || k === path.length - 1 || [B, F].some((p) => Math.hypot(p.x - x, p.z - z) < 45));
    tools.clearRoutes();
    for (const [x, z] of wps) tools.routeClick(x, z);
    const r = tools.finishRoute();
    say(`M4 route dijkstra: wps=${wps.length} len=${Math.round(r.length)} exposure=${(r.exposure * 100).toFixed(0)}% wet=${r.wetCrossings} slope=${r.maxSlope.toFixed(0)} score=${score(m)} ${objMet(m)}`);
    say(`M4 path ${JSON.stringify(wps.map(([x, z]) => [Math.round(x), Math.round(z)]))}`);
    ret.route_dijkstra = score(m);
    ret.bestRoute = wps;
  }

  // M6: a cautious walker: plan around walls on a 1.5 m grid, then only step when no sentry
  // would see the next spot, backing off along the path if one turns toward it.
  m = MISSIONS[5];
  startMission(m);
  const { sentryRate } = await import('./missions.js');
  const C6 = 1.5, X0 = 0, Z0 = -340, NX = 340, NZ = 200;
  const blocked = new Uint8Array(NX * NZ);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const x = X0 + (i + 0.5) * C6, z = Z0 + (j + 0.5) * C6;
    if (world.walls.some((w) => x > w.x0 - 0.5 && x < w.x1 + 0.5 && z > w.z0 - 0.5 && z < w.z1 + 0.5) || terrain.riverDist(x, z) < 8) blocked[j * NX + i] = 1;
  }
  const plan = (a, b) => {
    const cell = (p) => [Math.floor((p.x - X0) / C6), Math.floor((p.z - Z0) / C6)];
    const [ai, aj] = cell(a), [bi, bj] = cell(b);
    const dist = new Float32Array(NX * NZ).fill(Infinity), prev = new Int32Array(NX * NZ).fill(-1);
    const q = [aj * NX + ai]; dist[q[0]] = 0;
    for (let h = 0; h < q.length; h++) { // BFS-ish relax (uniform cost 8-neighbour)
      const u = q[h], ui = u % NX, uj = (u / NX) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const vi = ui + di, vj = uj + dj;
        if ((!di && !dj) || vi < 0 || vj < 0 || vi >= NX || vj >= NZ) continue;
        const v = vj * NX + vi;
        if (blocked[v]) continue;
        const w = dist[u] + Math.hypot(di, dj);
        if (w < dist[v] - 1e-6) { dist[v] = w; prev[v] = u; q.push(v); }
      }
    }
    const out = [];
    for (let v = bj * NX + bi; v !== -1; v = prev[v]) out.push({ x: X0 + ((v % NX) + 0.5) * C6, z: Z0 + (((v / NX) | 0) + 0.5) * C6 });
    return out.reverse();
  };
  const g = cam.ground;
  g.crouch = true; g.speed = 1;
  let t6 = 0, waits = 0;
  for (const leg of [ctx.points.LCP, ctx.points.BREACH, ctx.points.ORP]) {
    const path = plan({ x: g.x, z: g.z }, leg);
    let k = 0;
    while (k < path.length && t6 < 900 && !ctx.state.failed) {
      const dt = 1 / 10;
      t6 += dt;
      world.update(dt);
      const next = path[Math.min(k + 1, path.length - 1)];
      const safeNext = sentryRate(ctx, { ...next, crouch: true, speed: 1 }) === 0;
      const seenNow = sentryRate(ctx, { x: g.x, z: g.z, crouch: true, speed: 1 }) > 0;
      if (safeNext) {
        const dx = next.x - g.x, dz = next.z - g.z, d = Math.hypot(dx, dz);
        if (d < 0.11) k++; else { g.x += (dx / d) * 0.1; g.z += (dz / d) * 0.1; }
      } else if (seenNow && k > 0) { k--; g.x = path[k].x; g.z = path[k].z; waits++; } else waits++;
      g.x = Math.round(g.x * 1000) / 1000;
      run.time = t6;
      m.update(ctx, dt);
      if (k >= path.length - 1 && Math.hypot(leg.x - g.x, leg.z - g.z) < 4) break;
    }
  }
  say(`M6 cautious walk: leg=${ctx.state.leg} failed=${ctx.state.failed} peak=${Math.round(ctx.state.peak)} sim=${Math.round(t6)}s waits=${waits} score=${score(m)}`);
  ret.rehearsal = score(m);
  say('done', JSON.stringify(ret));
  // leave the best route on screen for a screenshot
  startMission(MISSIONS[3]);
  for (const [x, z] of ret.bestRoute) tools.routeClick(x, z);
  tools.finishRoute();
  P.checkNow();
  window.__selftest = ret;
  return ret;
}
