// 3D Mission Planner: an ATAK-style planning table for a fictional area of operations.
//
// URL options: ?mission=<id> starts a mission (orient, isr, overwatch, route, hlz, rehearsal),
// ?free opens free planning, ?mono forces 2D, ?depth=0-2, ?sensor=EO|IR|XRAY, ?view=MAP|ISR|GROUND.

import * as THREE from 'three';
import { Stage } from './stage.js';
import { Terrain, HALF } from './terrain.js';
import { World } from './world.js';
import { GroundClutter } from './clutter.js';
import { Sensors, SENSOR_UNIFORMS } from './sensors.js';
import { CameraController } from './camera.js';
import { Tools, LINE_MATS, textSprite } from './tools.js';
import { MISSIONS, rating, missionPoints, intel } from './missions.js';
import { clamp, mgrs, MSL, fmtDist, fmtTime, safeStore, DEG, bearing } from './util.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const log = (...a) => console.info('[mission]', ...a);

// ── stage + AO ────────────────────────────────────────────────────────────────────────────────
const canvas = $('stage');
const stage = new Stage(canvas);
const { scene, renderer } = stage;
renderer.toneMappingExposure = 1.0;

const terrain = new Terrain();
const imagery = terrain.paintImagery();
log(`terrain ${Math.round(terrain.genMs)} ms, ${terrain.trees.length} trees`);

const mapTex = new THREE.CanvasTexture(imagery);
mapTex.colorSpace = THREE.SRGBColorSpace;
mapTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const heatTex = new THREE.CanvasTexture(terrain.heatCanvas);

// Terrain material: the imagery, plus close-range detail, overlays, grid and contours.
const TU = {
  uOverlay: { value: null }, uOverlayOn: { value: 0 }, uGrid: { value: 0 }, uContour: { value: 0 }, uDetail: { value: 1 },
};
const terrainMat = new THREE.MeshStandardMaterial({ map: mapTex, roughness: 0.96, metalness: 0 });
terrainMat.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, TU);
  sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = `varying vec3 vWPos; uniform sampler2D uOverlay; uniform float uOverlayOn, uGrid, uContour, uDetail;
    float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(tHash(i), tHash(i + vec2(1, 0)), u.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), u.x), u.y); }
    float gridLine(float v, float w) { float g = abs(fract(v - 0.5) - 0.5) / (fwidth(v) * w); return 1.0 - min(g, 1.0); }
    ` + sh.fragmentShader
    .replace('#include <map_fragment>', `#include <map_fragment>
      float dcam = distance(cameraPosition, vWPos);
      float dn = tNoise(vWPos.xz * 1.1) * 0.5 + tNoise(vWPos.xz * 4.3) * 0.3 + tNoise(vWPos.xz * 13.0) * 0.2;
      diffuseColor.rgb *= mix(1.0, 0.72 + 0.56 * dn, uDetail * (1.0 - smoothstep(25.0, 260.0, dcam)));
      vec4 ov = texture2D(uOverlay, (vWPos.xz + ${HALF.toFixed(1)}) / ${(HALF * 2).toFixed(1)});
      diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, ov.a * uOverlayOn);`)
    .replace('#include <dithering_fragment>', `#include <dithering_fragment>
      vec2 gp = (vWPos.xz + ${HALF.toFixed(1)}) / 100.0;
      float gl = max(gridLine(gp.x, 1.0), gridLine(gp.y, 1.0));
      float gk = max(gridLine(gp.x / 10.0, 1.6), gridLine(gp.y / 10.0, 1.6));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.25, 0.85, 1.0), max(gl * 0.45, gk * 0.85) * uGrid);
      float c10 = gridLine(vWPos.y / 10.0, 1.0), c50 = gridLine(vWPos.y / 50.0, 1.8);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.55, 0.35, 0.15), max(c10 * 0.5, c50 * 0.9) * uContour);`);
};
const terrainMesh = new THREE.Mesh(terrain.buildMesh(), terrainMat);
terrainMesh.receiveShadow = true;
const tMats = Sensors.terrainMaterials(heatTex, mapTex);
terrainMesh.userData.irMaterial = tMats.IR;
terrainMesh.userData.xrMaterial = tMats.XRAY;
scene.add(terrainMesh);

const outer = new THREE.Mesh(terrain.buildOuter(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
outer.userData.sensor = { heat: 0.3, xray: 'dim' };
outer.receiveShadow = false;
scene.add(outer);

const water = new THREE.Mesh(terrain.buildWater(), new THREE.MeshStandardMaterial({ color: 0x2c4a52, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.88 }));
water.userData.sensor = { heat: 0.12, xray: 'faint' };
water.receiveShadow = true;
scene.add(water);

// A plank bridge where the road crosses the river.
{
  const B = terrain.places.BRIDGE;
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 38), new THREE.MeshStandardMaterial({ color: 0x7a7468, roughness: 0.9 }));
  const y = Math.max(terrain.waterY(B.z) + 2.2, terrain.heightAt(B.x, B.z));
  deck.position.y = y;
  deck.castShadow = deck.receiveShadow = true;
  g.add(deck);
  for (const s of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 38), deck.material);
    rail.position.set(s * 2.4, y + 0.75, 0); rail.castShadow = true;
    g.add(rail);
  }
  g.position.set(B.x, 0, B.z);
  g.rotation.y = Math.atan2(160 - -80, 10 - 140); // deck runs along the road
  g.userData.sensor = { heat: 0.45, xray: 'shell' };
  scene.add(g);
}

const world = new World(terrain);
scene.add(world.root);
const points = missionPoints(world);
const clutter = new GroundClutter(terrain, world, imagery);
scene.add(clutter.root);

// ── sky, light, environment ───────────────────────────────────────────────────────────────────
const skyMat = new THREE.ShaderMaterial({
  uniforms: { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() }, sunCol: { value: new THREE.Color() } },
  vertexShader: 'varying vec3 vD; void main(){ vD = normalize((modelMatrix * vec4(position,1.0)).xyz - cameraPosition); gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform vec3 top, hor, sunDir, sunCol; varying vec3 vD;
    void main(){ float h = max(vD.y, 0.0); vec3 c = mix(hor, top, pow(h, 0.55));
      c = mix(c, hor * 0.8, smoothstep(0.0, -0.08, vD.y));
      float s = max(dot(vD, sunDir), 0.0); c += sunCol * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.18);
      gl_FragColor = vec4(c, 1.0); }`,
  side: THREE.BackSide, depthWrite: false, fog: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(8000, 32, 16), skyMat);
sky.renderOrder = -10;
sky.userData.noSensor = true;
sky.frustumCulled = false;
scene.add(sky);

const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.4;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x5b5140, 0.9);
scene.add(hemi);
const SUN_DIR = new THREE.Vector3(-0.45, 0.62, 0.38).normalize(); // from the south-west, mid-afternoon
const MOON_DIR = new THREE.Vector3(0.5, 0.55, -0.3).normalize();

const env = {
  night: false,
  setNight(on) {
    this.night = on;
    const d = on ? MOON_DIR : SUN_DIR;
    skyMat.uniforms.sunDir.value.copy(d);
    if (on) {
      sun.color.set(0x8fa6ff); sun.intensity = 1.0;
      hemi.color.set(0x4a5f88); hemi.groundColor.set(0x161a20); hemi.intensity = 0.8;
      skyMat.uniforms.top.value.set(0x02040a); skyMat.uniforms.hor.value.set(0x0b1320); skyMat.uniforms.sunCol.value.set(0x9fb4ff);
      this.fog = new THREE.FogExp2(0x0e1726, 0.00022);
      SENSOR_UNIFORMS.uSolar.value = 0.0; SENSOR_UNIFORMS.uAmbient.value = 1;
      this.baseExposure = 1.25;
    } else {
      sun.color.set(0xfff1dc); sun.intensity = 2.6;
      hemi.color.set(0xcfe4ff); hemi.groundColor.set(0x5b5140); hemi.intensity = 0.9;
      skyMat.uniforms.top.value.set(0x3f78c0); skyMat.uniforms.hor.value.set(0xc9d8e2); skyMat.uniforms.sunCol.value.set(0xfff0d0);
      this.fog = new THREE.FogExp2(0xbccbd6, 0.00016);
      SENSOR_UNIFORMS.uSolar.value = 0.12; SENSOR_UNIFORMS.uAmbient.value = 0;
      this.baseExposure = 1.0;
    }
    SENSOR_UNIFORMS.uSun.value.copy(d);
    applyBrightness();
    this.applySensor(sensors?.mode || 'EO');
    $('night').textContent = on ? '☾ NIGHT' : '☀ DAY';
    $('night').classList.toggle('on', on);
    $('clock').textContent = on ? '0215 L · NIGHT' : '1530 L · DAY';
  },
  applySensor(mode) {
    sky.visible = mode === 'EO';
    scene.fog = mode === 'EO' ? this.fog : null;
    if (mode === 'EO') scene.background = null;
    else if (mode === 'IR') scene.background = new THREE.Color([0x050505, 0xdedede, 0x04000c][SENSOR_UNIFORMS.uPalette.value]);
    else scene.background = new THREE.Color(0x02070c);
    sun.castShadow = mode === 'EO';
    renderer.setClearColor(scene.background || 0x000000);
  },
};

// ── brightness ─────────────────────────────────────────────────────────────────────────────────
// One control for every view: EO scales the tone-mapping exposure, IR / X-RAY scale the picture.
// [ and ] step it; ?bright=0.5-3 sets it; the last choice is remembered.
let brightness = clamp(+(params.get('bright') ?? safeStore('mp.bright') ?? 1.3) || 1.3, 0.5, 3);
function applyBrightness() {
  renderer.toneMappingExposure = (env.baseExposure ?? 1) * brightness;
  SENSOR_UNIFORMS.uGain.value = 0.7 + 0.3 * brightness;
  const el = $('bright'), lab = $('brightVal');
  if (el) el.value = Math.round(brightness * 100);
  if (lab) lab.textContent = `${Math.round(brightness * 100)}%`;
}
function setBrightness(v) {
  brightness = clamp(v, 0.5, 3);
  safeStore('mp.bright', brightness);
  applyBrightness();
}
$('bright').addEventListener('input', (e) => setBrightness(+e.target.value / 100));
document.querySelectorAll('[data-bright]').forEach((b) => b.addEventListener('click', () => setBrightness(+b.dataset.bright)));

let sensors;
sensors = new Sensors(scene, env);
sensors.register(world.root);
sensors.register(terrainMesh);
sensors.register(outer);
sensors.register(water);
sensors.register(clutter.root);
scene.traverse((o) => { if (o.isMesh && !o.userData.mats && o.parent?.userData.sensor) sensors.register(o); });
env.setNight(false);

// ── camera + tools ────────────────────────────────────────────────────────────────────────────
const cam = new CameraController(stage, terrain, world);
const tools = new Tools(scene, terrain, world, cam);
const graphics = new THREE.Group();
graphics.userData.noSensor = true;
scene.add(graphics);

tools.onOverlay = (kind) => {
  TU.uOverlay.value = kind === 'slope' ? tools.slopeTex : tools.ovTex;
  TU.uOverlayOn.value = kind === 'none' ? 0 : 1;
  document.querySelector('[data-ov="slope"]').classList.toggle('on', kind === 'slope');
};
TU.uOverlay.value = tools.ovTex;

const TOOL_HINTS = {
  select: '',
  marker: 'MARKER: pick an affiliation, then click the map.',
  route: 'ROUTE: click waypoints · Enter or double-click to finish · Backspace undoes the last point.',
  rb: 'RANGE & BEARING: click the start, then the end. Green = line of sight, red = masked.',
  viewshed: 'VIEWSHED: click an observer point. Red ground is seen from it (900 m).',
  tag: 'TAG: click a building or vehicle to spot-tag it; click again to untag.',
  isr: 'ISR: click a point for the drone to orbit.',
  ground: 'GROUND: click where to stand.',
};

function setTool(t) {
  if (t === 'map') { cam.go('MAP'); t = 'select'; }
  tools.mode = t;
  if (t !== 'route' && tools.draft) tools.finishRoute();
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $('affil').classList.toggle('hidden', t !== 'marker');
  const h = TOOL_HINTS[t];
  $('toolhint').textContent = h;
  $('toolhint').classList.toggle('hidden', !h);
  canvas.style.cursor = t === 'select' ? 'grab' : 'crosshair';
}
function setAffil(a) {
  tools.markerType = a;
  document.querySelectorAll('#affil button').forEach((b) => b.classList.toggle('on', b.dataset.a === a));
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('#affil button').forEach((b) => b.addEventListener('click', () => setAffil(b.dataset.a)));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.view;
  if (v === cam.mode) return;
  if (v === 'MAP') cam.go('MAP');
  else { const p = centerGround() || cam.self; cam.go(v, { x: p.x, z: p.z }); }
}));
$('compass').addEventListener('click', () => {
  if (cam.mode === 'MAP') { cam.map.yaw = 0; cam.map.pitch = 89 * DEG; }
  else if (cam.mode === 'GROUND') cam.ground.yaw = 0;
});

const overlayState = { grid: false, contour: false };
document.querySelectorAll('[data-ov]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.ov;
  if (k === 'slope') tools.setOverlay(tools.overlay === 'slope' ? 'none' : 'slope');
  else {
    overlayState[k] = !overlayState[k];
    TU[k === 'grid' ? 'uGrid' : 'uContour'].value = overlayState[k] ? 1 : 0;
    b.classList.toggle('on', overlayState[k]);
  }
}));
document.querySelector('[data-act="clear"]').addEventListener('click', () => { tools.clearAll(); showReadout(null); });

function setSensor(s) {
  sensors.set(s);
}
sensors.onChange = (s) => {
  document.querySelectorAll('#sensorSeg button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
  $('palette').classList.toggle('hidden', s !== 'IR');
  TU.uDetail.value = 1;
};
document.querySelectorAll('#sensorSeg button').forEach((b) => b.addEventListener('click', () => setSensor(b.dataset.s)));
$('palette').addEventListener('click', () => { $('palette').textContent = sensors.cyclePalette(); env.applySensor(sensors.mode); });
$('night').addEventListener('click', () => env.setNight(!env.night));

cam.onMode = (mode) => {
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
  $('isr').classList.toggle('hidden', mode !== 'ISR');
  $('reticle').classList.toggle('hidden', mode !== 'GROUND');
  $('groundhud').classList.toggle('hidden', mode !== 'GROUND');
  log(`view ${mode}`);
};

// ── picking ───────────────────────────────────────────────────────────────────────────────────
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function rayAt(cx, cy) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, stage.cam);
  return ray;
}
function groundAt(cx, cy) {
  const r = rayAt(cx, cy);
  return terrain.raycast(r.ray.origin, r.ray.direction);
}
function centerGround() {
  const r = canvas.getBoundingClientRect();
  return groundAt(r.left + r.width / 2, r.top + r.height / 2);
}
function pickTaggable(cx, cy) {
  const r = rayAt(cx, cy);
  const hits = r.intersectObjects(world.taggables.map((t) => t.group), true);
  if (!hits.length) return null;
  const terrainHit = terrain.raycast(r.ray.origin, r.ray.direction);
  if (terrainHit && terrainHit.distanceTo(r.ray.origin) < hits[0].distance - 2) return null;
  let o = hits[0].object;
  while (o && !world.taggables.some((t) => t.group === o)) o = o.parent;
  return world.taggables.find((t) => t.group === o) || null;
}

// ── pointer input ─────────────────────────────────────────────────────────────────────────────
let down = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.focus();
  canvas.setPointerCapture(e.pointerId);
  down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, button: e.button, moved: false };
  if (tools.mode === 'select') canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  hover = { x: e.clientX, y: e.clientY };
  if (!down) return;
  const dx = e.clientX - down.lx, dy = e.clientY - down.ly;
  if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.moved = true;
  if (down.moved) cam.drag(dx, dy, down.button, e.shiftKey);
  down.lx = e.clientX; down.ly = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  const d = down;
  down = null;
  if (tools.mode === 'select') canvas.style.cursor = 'grab';
  if (!d || d.moved || d.button !== 0) return;
  click(e.clientX, e.clientY);
});
canvas.addEventListener('dblclick', () => { if (tools.mode === 'route') finishRoute(); });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.wheel(e.deltaY); }, { passive: false });
let hover = null;

function click(cx, cy) {
  const m = tools.mode;
  if (m === 'tag') {
    const t = pickTaggable(cx, cy);
    if (t) tools.toggleTag(t); else toast('Nothing taggable there — click a building or vehicle.');
    return;
  }
  const p = groundAt(cx, cy);
  if (!p) return;
  if (m === 'marker') tools.addMarker(tools.markerType, p.x, p.z);
  else if (m === 'route') tools.routeClick(p.x, p.z);
  else if (m === 'rb') tools.rbClick(p.x, p.z);
  else if (m === 'viewshed') {
    toast('Computing viewshed…');
    setTimeout(() => tools.runViewshed(p.x, p.z), 30);
  } else if (m === 'isr') { cam.go('ISR', { x: p.x, z: p.z }); setTool('select'); }
  else if (m === 'ground') { cam.go('GROUND', { x: p.x, z: p.z }); setTool('select'); }
  else if (m === 'select') toast(tools.describePoint(p.x, p.z));
}

function finishRoute() {
  const d = tools.draft;
  if (d && d.pts.length > 2) {
    const [a, b] = d.pts.slice(-2);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4) d.pts.pop(); // double-click adds a duplicate
  }
  const r = tools.finishRoute();
  if (r) toast(`Route planned: ${fmtDist(r.length)}, ${Math.round(r.exposure * 100)} % exposed`, r.exposure < 0.15 ? 'ok' : '');
}

// ── keyboard ──────────────────────────────────────────────────────────────────────────────────
const typing = (e) => /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (!$('help').classList.contains('hidden') && (e.code === 'Escape' || e.code === 'KeyH')) { $('help').classList.add('hidden'); return; }
  cam.keys.add(e.code);
  switch (e.code) {
    case 'Digit1': setSensor('EO'); break;
    case 'Digit2': setSensor('IR'); break;
    case 'Digit3': setSensor('XRAY'); break;
    case 'KeyP': if (sensors.mode === 'IR') $('palette').click(); break;
    case 'KeyN': env.setNight(!env.night); break;
    case 'BracketLeft': setBrightness(brightness - 0.1); break;
    case 'BracketRight': setBrightness(brightness + 0.1); break;
    case 'KeyC': if (cam.mode === 'GROUND') cam.ground.crouch = !cam.ground.crouch; break;
    case 'KeyM': if (cam.mode !== 'MAP') cam.go('MAP'); break;
    case 'KeyH': $('help').classList.toggle('hidden'); break;
    case 'Escape': if (tools.draft) finishRoute(); setTool('select'); break;
    case 'Enter': if (tools.mode === 'route') finishRoute(); break;
    case 'Backspace': if (tools.mode === 'route') { tools.undoWaypoint(); e.preventDefault(); } break;
  }
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => cam.keys.delete(e.code));
window.addEventListener('blur', () => cam.keys.clear());

// ── readout (route profile, R&B, viewshed) ─────────────────────────────────────────────────────
let readout = null;
function showReadout(kind, data) {
  readout = kind ? { kind, data } : null;
  $('readout').classList.toggle('hidden', !kind);
  if (!kind) return;
  const prof = $('profile');
  prof.classList.toggle('hidden', kind !== 'route');
  if (kind === 'route') {
    const r = data;
    $('rtitle').textContent = r.draft ? 'ROUTE (DRAFT)' : 'ROUTE';
    $('rsub').textContent = r.draft ? 'Enter to finish' : '';
    $('rstats').innerHTML = `<span>LEN <b>${fmtDist(r.length)}</b></span><span>CLIMB <b>${Math.round(r.climb)} m</b></span><span>STEEPEST <b>${r.maxSlope.toFixed(0)}°</b></span>`
      + `<span>EXPOSED <b style="color:${r.exposure < 0.15 ? 'var(--ok)' : 'var(--bad)'}">${Math.round(r.exposure * 100)} %</b></span><span>WET XING <b style="color:${r.wetCrossings ? 'var(--bad)' : 'var(--ok)'}">${r.wetCrossings}</b></span>`
      + `<span>FOOT <b>${fmtTime(r.length / 1.1)}</b> h:m @ 4 km/h</span>`;
    drawProfile(prof, r);
  } else if (kind === 'rb') {
    const r = data;
    $('rtitle').textContent = 'RANGE & BEARING'; $('rsub').textContent = '';
    $('rstats').innerHTML = `<span>RANGE <b>${fmtDist(r.range)}</b></span><span>SLANT <b>${fmtDist(r.slant)}</b></span><span>AZ <b>${r.bearing.toFixed(1)}°</b> / <b>${Math.round(r.bearing * 17.7778)} mil</b></span><span>ΔEL <b>${r.dz >= 0 ? '+' : ''}${Math.round(r.dz)} m</b></span><span>LOS <b style="color:${r.los ? 'var(--ok)' : 'var(--bad)'}">${r.los ? 'CLEAR' : 'MASKED'}</b></span>`
      + `<span>FROM <b>${mgrs(r.a.x, r.a.z)}</b></span><span>TO <b>${mgrs(r.b.x, r.b.z)}</b></span>`;
  } else if (kind === 'viewshed') {
    $('rtitle').textContent = 'VIEWSHED'; $('rsub').textContent = '';
    $('rstats').innerHTML = `<span>OBSERVER <b>${mgrs(data.x, data.z)}</b></span><span>SEEN <b>${Math.round(data.frac * 100)} %</b> of 900 m radius</span><span style="color:#ff8a7a">red = visible</span>`;
  }
}

function drawProfile(cv, r) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, s = r.samples;
  g.clearRect(0, 0, W, H);
  if (!s || s.length < 2) return;
  let lo = Infinity, hi = -Infinity;
  for (const p of s) { lo = Math.min(lo, p.h); hi = Math.max(hi, p.h); }
  lo -= 5; hi += 5;
  const L = s[s.length - 1].d || 1, pad = 44;
  const X = (d) => pad + (d / L) * (W - pad - 8), Y = (h) => H - 22 - ((h - lo) / (hi - lo)) * (H - 36);
  g.font = '18px Consolas, monospace'; g.fillStyle = '#8397a6';
  g.fillText(`${Math.round(hi + MSL)}`, 2, 20); g.fillText(`${Math.round(lo + MSL)}`, 2, H - 24);
  g.fillText('0', pad, H - 2); g.fillText(fmtDist(L), W - 110, H - 2);
  for (let k = 1; k < s.length; k++) {
    const a = s[k - 1], b = s[k];
    g.fillStyle = a.vis ? 'rgba(255,92,92,0.55)' : 'rgba(63,208,255,0.28)';
    g.beginPath(); g.moveTo(X(a.d), H - 22); g.lineTo(X(a.d), Y(a.h)); g.lineTo(X(b.d), Y(b.h)); g.lineTo(X(b.d), H - 22); g.fill();
  }
  g.strokeStyle = '#d9f4ff'; g.lineWidth = 2.5; g.beginPath();
  s.forEach((p, k) => (k ? g.lineTo(X(p.d), Y(p.h)) : g.moveTo(X(p.d), Y(p.h))));
  g.stroke();
}

tools.onEvent = (type, data) => {
  if (type === 'route') showReadout('route', data);
  else if (type === 'routeDraft' && data.pts.length > 1) showReadout('route', { ...tools.analyzeRoute(data.pts), draft: true });
  else if (type === 'rb') showReadout('rb', data);
  else if (type === 'rbStart') toast('Range & bearing: now click the end point.');
  else if (type === 'viewshed') showReadout('viewshed', data);
  else if (type === 'tag') toast(tools.tags.has(data) ? `Tagged ${data.kind}` : `Untagged ${data.kind}`);
  else if (type === 'marker') toast(`${data.label} at ${mgrs(data.x, data.z)}`);
};

// ── toasts ────────────────────────────────────────────────────────────────────────────────────
function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  $('toasts').append(t);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => t.remove(), 3600);
}

// ── missions ──────────────────────────────────────────────────────────────────────────────────
const best = safeStore('mp.best') || {};
const run = { m: null, time: 0, done: new Set(), ended: false, free: false, checkT: 0 };
const ctx = {
  t: terrain, world, tools, cam, sensors, env, graphics, points, state: {},
  toast,
  centred(v, tol) {
    stage.cam.updateMatrixWorld();
    const p = v.clone().project(stage.cam);
    return p.z < 1 && Math.abs(p.x) < tol && Math.abs(p.y) < tol;
  },
  complete() {
    const m = run.m, ep = run.epoch;
    // only end the mission that asked (a retry within the delay must not be ended by it)
    if (m && !run.ended) setTimeout(() => { if (run.m === m && run.epoch === ep && !run.ended) endMission(); }, 600);
  },
};

function resetScene() {
  tools.clearAll();
  for (const m of [...tools.markers]) tools.removeMarker(m);
  for (const c of [...graphics.children]) graphics.remove(c);
  tools.threats = [];
  ctx.state = {};
  cam.groundVisited = [];
  sensors.set('EO');
  setTool('select');
  showReadout(null);
}

function renderCards() {
  const cards = $('cards');
  cards.innerHTML = '';
  for (const m of MISSIONS) {
    const b = document.createElement('button');
    b.className = 'card';
    const sc = best[m.id];
    const st = sc !== undefined ? rating(sc).stars : 0;
    b.innerHTML = `<div class="top"><span class="code">${m.code}</span><span class="stars">${[0, 1, 2].map((k) => `<span class="${k < st ? 'on' : ''}">★</span>`).join('')}</span></div>
      <h3>${m.name}</h3><div class="t">${m.tag}${sc !== undefined ? ` · best ${sc} (${rating(sc).code})` : ''}</div><div class="d">${m.brief.task}</div>`;
    b.addEventListener('click', () => openBrief(m));
    cards.append(b);
  }
  const f = document.createElement('button');
  f.className = 'card free';
  f.innerHTML = '<div class="top"><span class="code">FREE</span></div><h3>Free planning</h3><div class="t">All tools · no clock</div><div class="d">Explore AO GRANITE with every tool and sensor, no objectives.</div>';
  f.addEventListener('click', () => startFree());
  cards.append(f);
}

function openPicker() {
  renderCards();
  $('picker').classList.remove('hidden');
}
function openBrief(m) {
  $('picker').classList.add('hidden');
  $('bkick').textContent = `${m.code} · ${m.tag.toUpperCase()}`;
  $('btitle').textContent = m.name;
  $('bsit').textContent = m.brief.situation;
  $('btask').textContent = m.brief.task;
  $('bcon').textContent = m.brief.constraints;
  $('briefing').classList.remove('hidden');
  $('bgo').onclick = () => { $('briefing').classList.add('hidden'); if (run.m !== m || run.ended) startMission(m); };
  $('bback').onclick = () => { $('briefing').classList.add('hidden'); if (!run.m) openPicker(); else openPicker(); };
}

function startMission(m) {
  resetScene();
  run.m = m; run.time = 0; run.done = new Set(); run.ended = false; run.free = false; run.epoch = (run.epoch || 0) + 1;
  m.setup(ctx);
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('rec', m.tools.includes(b.dataset.tool)));
  $('mission').classList.remove('hidden');
  $('mcode').textContent = m.code;
  $('mname').textContent = m.name;
  $('mtag').textContent = m.tag;
  $('submit').textContent = m.ground ? 'End rehearsal' : 'Submit plan';
  $('submit').classList.remove('hidden');
  $('brief').classList.remove('hidden');
  renderObjectives();
  if (m.tools.includes('marker')) setAffil(tools.markerType);
  history.replaceState(null, '', `?mission=${m.id}`);
  log(`mission ${m.id} start`);
}

function startFree() {
  $('picker').classList.add('hidden');
  resetScene();
  run.m = null; run.free = true; run.ended = false;
  // the same intel graphics the missions use
  intel(ctx, { orp: true });
  env.setNight(false);
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.remove('rec'));
  $('mission').classList.remove('hidden');
  $('mcode').textContent = 'FREE';
  $('mname').textContent = 'Planning';
  $('mtag').textContent = 'All tools · no objectives. Missions button for drills.';
  $('objs').innerHTML = '<li><span></span><span><b>Try:</b><small>ISR over OBJ IRON at night in IR (N, 2) · X-RAY (3) through the walls · GROUND at BRIDGE 7 · VIEWSHED from EN OP · a ROUTE with its profile.</small></span></li>';
  $('submit').classList.add('hidden');
  $('brief').classList.add('hidden');
  setAffil('H');
  history.replaceState(null, '', '?free');
}

function renderObjectives() {
  const m = run.m;
  if (!m) return;
  $('objs').innerHTML = m.objectives.map((o) => {
    const d = run.done.has(o.id);
    const prog = o.progress ? `<span class="prog">${o.progress(ctx)}</span>` : '';
    return `<li class="${d ? 'done' : ''}"><span class="box"></span><span><b>${o.text}</b>${prog}${o.hint && !d ? `<small>${o.hint}</small>` : ''}</span></li>`;
  }).join('');
}

function checkObjectives() {
  const m = run.m;
  if (!m || run.ended) return;
  const latch = m.id === 'orient' || m.id === 'rehearsal';
  let changed = false;
  for (const o of m.objectives) {
    let ok = false;
    try { ok = !!o.check(ctx); } catch (e) { ok = false; }
    const had = run.done.has(o.id);
    if (ok && !had) { run.done.add(o.id); toast(`✓ ${o.text}`, 'ok'); changed = true; }
    else if (!ok && had && !latch) { run.done.delete(o.id); changed = true; }
  }
  renderObjectives();
  if (changed && m.id === 'orient' && run.done.size === m.objectives.length) ctx.complete();
}

function endMission() {
  const m = run.m;
  if (!m || run.ended) return;
  checkObjectives();
  run.ended = true;
  const items = m.evaluate(ctx, run.done, run.time);
  const total = clamp(Math.round(items.reduce((s, i) => s + i.pts, 0)), 0, 100);
  const r = rating(total);
  const prev = best[m.id];
  if (prev === undefined || total > prev) { best[m.id] = total; safeStore('mp.best', best); }
  $('atitle').textContent = `${m.code} ${m.name}`;
  $('agrade').textContent = r.code;
  $('ascore').textContent = `${total} / 100`;
  $('aname').textContent = `${r.name}${prev !== undefined ? ` · previous best ${prev}` : ''}${total > (prev ?? -1) ? ' · NEW BEST' : ''}`;
  $('astars').innerHTML = [0, 1, 2].map((k) => `<span class="${k < r.stars ? 'on' : ''}">★</span>`).join(' ');
  $('atable').innerHTML = items.map((i) => `<tr><td>${i.label}</td><td class="p">${i.pts} / ${i.max}</td></tr>`).join('');
  const idx = MISSIONS.indexOf(m);
  $('anext').classList.toggle('hidden', idx === MISSIONS.length - 1);
  $('aar').classList.remove('hidden');
  $('submit').textContent = 'Show AAR';
  log(`mission ${m.id} end score=${total} ${r.code}`);
}

$('submit').addEventListener('click', () => { if (run.ended) $('aar').classList.remove('hidden'); else endMission(); });
$('brief').addEventListener('click', () => run.m && openBrief(run.m));
$('abort').addEventListener('click', () => { run.m = null; run.ended = false; resetScene(); $('mission').classList.add('hidden'); openPicker(); });
$('areview').addEventListener('click', () => $('aar').classList.add('hidden'));
$('aretry').addEventListener('click', () => { $('aar').classList.add('hidden'); startMission(run.m); });
$('alist').addEventListener('click', () => { $('aar').classList.add('hidden'); openPicker(); });
$('anext').addEventListener('click', () => { $('aar').classList.add('hidden'); openBrief(MISSIONS[MISSIONS.indexOf(run.m) + 1]); });
$('missionsBtn').addEventListener('click', openPicker);
$('helpBtn').addEventListener('click', () => $('help').classList.remove('hidden'));
$('helpClose').addEventListener('click', () => $('help').classList.add('hidden'));
for (const id of ['picker', 'briefing', 'help']) $(id).addEventListener('click', (e) => { if (e.target.id === id && (run.m || run.free)) $(id).classList.add('hidden'); });

// ── HUD ───────────────────────────────────────────────────────────────────────────────────────
function hud() {
  // cursor coordinates
  if (hover) {
    const p = groundAt(hover.x, hover.y);
    $('cursor').textContent = p ? `${mgrs(p.x, p.z)}  ·  ${Math.round(p.y + MSL)} m  ·  ${terrain.slopeAt(p.x, p.z).toFixed(0)}°` : '—';
  }
  document.getElementById('rose').setAttribute('transform', `rotate(${-cam.heading} 32 32)`);
  if (cam.mode === 'ISR') {
    const s = cam.isr, c = stage.cam.position;
    const ty = terrain.heightAt(s.x, s.z);
    const slant = Math.hypot(c.x - s.x, c.y - ty, c.z - s.z);
    $('isrTL').textContent = `ISR · UAS-2 "HAWK 1"\n${sensors.mode === 'IR' ? `IR ${sensors.paletteName}` : sensors.mode === 'XRAY' ? 'SAR-PEN (SEE-THROUGH)' : 'EO DAY TV'}\nFOV ${s.fov.toFixed(1)}°  ZOOM ${(45 / s.fov).toFixed(1)}x`;
    $('isrTR').textContent = `ALT ${Math.round(c.y + MSL)} m MSL\nHDG ${String(Math.round(cam.heading)).padStart(3, '0')}°\nORBIT R ${Math.round(s.radius)} m`;
    $('isrBL').textContent = `TGT ${mgrs(s.x, s.z)}\nELEV ${Math.round(ty + MSL)} m\nSLANT ${fmtDist(slant)}`;
    $('isrBR').textContent = `${new Date().toISOString().slice(11, 19)}Z\nAO GRANITE\n${env.night ? 'NIGHT' : 'DAY'}`;
  }
  if (cam.mode === 'GROUND') {
    $('stance').textContent = cam.ground.crouch ? 'CROUCHED' : cam.ground.speed > 3 ? 'RUNNING' : 'STANDING';
    const det = ctx.state.detect ?? 0;
    const showDet = run.m?.id === 'rehearsal';
    $('detect').parentElement.querySelectorAll('span:nth-child(2), #detect, #seen').forEach((el) => el.classList.toggle('hidden', !showDet));
    $('detect').firstElementChild.style.width = `${det}%`;
    $('seen').textContent = ctx.state.seen ? 'SEEN' : '';
  }
  if (run.m && !run.ended) $('mtimer').textContent = fmtTime(run.time);
}

// ── depth / stereo ────────────────────────────────────────────────────────────────────────────
const depthEl = $('depth');
const depth0 = params.has('depth') ? clamp(+params.get('depth') || 0, 0, 2) : 1;
depthEl.value = depth0 * 100;
stage.setDepth(depth0);
depthEl.addEventListener('input', () => stage.setDepth(+depthEl.value / 100));
$('stereo').addEventListener('click', async () => { if (await stage.setStereo(!stage.stereo)) setModeBadge(); });
function setModeBadge() {
  const b = $('badge');
  if (stage.woven) {
    b.textContent = stage.stereo ? '3D' : '3D DISPLAY · 2D';
    b.className = `pill ${stage.stereo ? 'ok' : ''}`;
    $('stereo').classList.toggle('hidden', !stage.displayModesSupported);
    $('stereo').textContent = stage.stereo ? '2D' : '3D';
  } else {
    b.textContent = '2D PREVIEW';
    b.className = 'pill';
    b.title = 'Open in the DisplayXR Browser on a Leia 3D display for glasses-free depth.';
  }
}
stage.onModeChange = () => setModeBadge();

// ── frame loop ────────────────────────────────────────────────────────────────────────────────
let clock = 0, hudT = 0, fpsT = 0, fpsN = 0;
const shadowCenter = new THREE.Vector3();
stage.onTick = (dt) => {
  clock += dt;
  cam.update(dt);
  world.update(dt);
  clutter.update(cam);
  sensors.tick(clock);
  // boundary lines are for the map; on the ground they would read as fences
  const low = cam.mode === 'GROUND' && !cam.flight;
  // and far labels would pile up on the horizon
  const cp = stage.cam.position;
  for (const c of graphics.children) {
    if (c.isLine2) c.visible = !low;
    else if (c.isSprite) c.visible = !low || Math.hypot(c.position.x - cp.x, c.position.z - cp.z) < 260;
  }
  for (const mk of tools.markers) if (mk.fixed) mk.obj.visible = !low || Math.hypot(mk.x - cp.x, mk.z - cp.z) < 420;
  tools.update(stage.cam);
  sky.position.copy(stage.cam.position);
  // shadows follow what the camera looks at
  const f = cam.mode === 'GROUND' ? { x: cam.ground.x, z: cam.ground.z } : cam.mode === 'ISR' ? cam.isr : cam.map;
  const ext = cam.mode === 'GROUND' ? 90 : cam.mode === 'ISR' ? 260 : clamp(cam.map.dist * 0.75, 140, 1000);
  shadowCenter.set(f.x, terrain.heightAt(f.x, f.z), f.z);
  const sc = sun.shadow.camera;
  if (sc.right !== ext) { sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 10; sc.far = 4000; sc.updateProjectionMatrix(); }
  sun.target.position.copy(shadowCenter);
  sun.position.copy(shadowCenter).addScaledVector(env.night ? MOON_DIR : SUN_DIR, 1800);
  // fat lines need the per-eye pixel size
  const ew = stage.woven ? canvas.width / 2 : canvas.width;
  for (const m of LINE_MATS) m.resolution.set(ew, canvas.height);
  if (run.m && !run.ended) {
    run.time += dt;
    run.m.update?.(ctx, dt);
    run.checkT += dt;
    if (run.checkT > 0.25) { run.checkT = 0; checkObjectives(); }
  }
  hudT += dt;
  if (hudT > 0.1) { hudT = 0; hud(); }
  fpsT += dt; fpsN++;
  if (fpsT > 0.5) { $('fps').textContent = `${Math.round(fpsN / fpsT)} fps`; fpsT = fpsN = 0; }
};

// ── start ─────────────────────────────────────────────────────────────────────────────────────
window.planner = { stage, terrain, world, cam, tools, sensors, env, run, ctx, MISSIONS, startMission, endMission, checkNow: checkObjectives };
setTool('select');
setAffil('H');
cam.go('MAP', { x: -100, z: 0, dist: 1700, yaw: 0.45, pitch: 50 * DEG, instant: true });
const { woven, firstWoven } = await stage.start({ mono: params.has('mono') });
setModeBadge();
firstWoven.then((r) => { log(`firstWoven woven=${r.woven} confirmed=${r.confirmed} reason=${r.reason}`); setModeBadge(); });
$('loading').remove();

const pm = MISSIONS.find((m) => m.id === params.get('mission'));
if (pm) startMission(pm);
else if (params.has('free')) startFree();
else openPicker();
if (params.get('sensor')) setSensor(params.get('sensor').toUpperCase());
if (params.get('view') && params.get('view').toUpperCase() !== cam.mode) {
  const v = params.get('view').toUpperCase();
  const at = { x: +(params.get('x') ?? 250), z: +(params.get('z') ?? -180) };
  cam.go(v, { ...at, instant: true });
}
if (params.has('night')) env.setNight(true);
log(`ready woven=${woven}`);
if (params.has('selftest')) import('./selftest.js').then((m) => m.selftest(window.planner)).catch((e) => console.error('[selftest] failed', e));
