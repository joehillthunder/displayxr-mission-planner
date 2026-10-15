// Sensor modes. Every mesh in the AO carries `userData.sensor = { heat, xray }` and keeps its
// daylight (EO) material; switching sensor swaps each mesh to a cached material for that mode.
//
//   EO     ordinary lit colour (day or night lighting)
//   IR     long-wave thermal: per-object temperature + solar loading on sun-facing faces,
//          rim cooling, sensor grain. White-hot, black-hot or ironbow palette.
//   XRAY   a see-through "structure penetrating" view: walls and roofs become glass shells,
//          people show as warm solids and dense metal (weapons, vehicles) as amber solids.

import * as THREE from 'three';

export const SENSOR_UNIFORMS = {
  uPalette: { value: 0 }, // 0 white-hot, 1 black-hot, 2 ironbow
  uTime: { value: 0 },
  uSolar: { value: 0.1 }, // solar loading (day) — near 0 at night
  uSun: { value: new THREE.Vector3(0.5, 0.7, 0.3).normalize() },
  uAmbient: { value: 0 }, // night: the ground cools, people stand out more
  uGain: { value: 1 }, // the Brightness control, for the IR and X-RAY pictures
};

const VERT = /* glsl */ `
  varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  void main() {
    vec4 p = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 w = modelMatrix * p;
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * n);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const COMMON = /* glsl */ `
  uniform float uPalette; uniform float uTime; uniform float uSolar; uniform vec3 uSun; uniform float uAmbient; uniform float uGain;
  varying vec3 vN; varying vec3 vW; varying vec2 vUv;
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec3 palette(float t) {
    t = clamp(t, 0.0, 1.0);
    if (uPalette < 0.5) return vec3(pow(t, 1.15));
    if (uPalette < 1.5) return vec3(pow(1.0 - t, 1.15));
    vec3 c = mix(vec3(0.0, 0.0, 0.05), vec3(0.25, 0.0, 0.45), smoothstep(0.0, 0.3, t));
    c = mix(c, vec3(0.8, 0.05, 0.35), smoothstep(0.28, 0.5, t));
    c = mix(c, vec3(1.0, 0.45, 0.0), smoothstep(0.5, 0.72, t));
    c = mix(c, vec3(1.0, 0.9, 0.35), smoothstep(0.72, 0.9, t));
    return mix(c, vec3(1.0), smoothstep(0.9, 1.0, t));
  }
  float grain() { return (hash12(gl_FragCoord.xy + fract(uTime * 7.3) * 517.0) - 0.5) * 0.04; }
  float rim() { vec3 V = normalize(cameraPosition - vW); return 1.0 - abs(dot(normalize(vN), V)); }
`;

const THERMAL_FRAG = /* glsl */ `
  ${COMMON}
  uniform float uHeat;
  void main() {
    float t = uHeat;
    float ext = 1.0 - step(0.8, uHeat); // living things don't sun-load much
    t += max(dot(normalize(vN), uSun), 0.0) * uSolar * ext;
    t -= pow(rim(), 3.0) * 0.07;
    t -= uAmbient * 0.16 * ext;
    t += grain();
    gl_FragColor = vec4(min(palette(t) * uGain, 1.0), 1.0);
  }
`;

const TERRAIN_THERMAL_FRAG = /* glsl */ `
  ${COMMON}
  uniform sampler2D uHeatMap;
  void main() {
    float t = texture2D(uHeatMap, vUv).r * 0.85;
    t += max(dot(normalize(vN), uSun), 0.0) * uSolar * 1.2;
    t += (hash12(floor(vW.xz * 1.5)) - 0.5) * 0.03;
    t -= uAmbient * 0.17;
    float d = distance(cameraPosition, vW);
    t = mix(t, 0.28, smoothstep(900.0, 2600.0, d)); // atmosphere washes out far terrain
    t += grain();
    gl_FragColor = vec4(min(palette(t) * uGain, 1.0), 1.0);
  }
`;

const XRAY_FRAG = /* glsl */ `
  ${COMMON}
  uniform vec3 uColor; uniform float uBase; uniform float uRim; uniform float uPulse;
  void main() {
    float r = rim();
    float a = uBase + uRim * pow(r, 2.0);
    a *= 1.0 + uPulse * 0.25 * sin(uTime * 4.0 + vW.x * 0.3);
    gl_FragColor = vec4(uColor * a * uGain, 1.0);
  }
`;

const TERRAIN_XRAY_FRAG = /* glsl */ `
  ${COMMON}
  uniform sampler2D uMap;
  void main() {
    vec3 c = texture2D(uMap, vUv).rgb;
    float l = dot(c, vec3(0.3, 0.55, 0.15));
    vec3 col = vec3(0.05, 0.14, 0.2) * (0.5 + l * 1.6);
    float sh = max(dot(normalize(vN), uSun), 0.0);
    col *= 0.55 + 0.6 * sh;
    float cy = vW.y / 5.0; float gc = abs(fract(cy - 0.5) - 0.5) / fwidth(cy);
    col += vec3(0.0, 0.35, 0.45) * (1.0 - min(gc, 1.0)) * 0.35;
    gl_FragColor = vec4(col * uGain, 1.0);
  }
`;

const thermalCache = new Map();
function thermalMat(heat) {
  const key = Math.round(heat * 100);
  if (!thermalCache.has(key)) {
    thermalCache.set(key, new THREE.ShaderMaterial({
      uniforms: { ...SENSOR_UNIFORMS, uHeat: { value: key / 100 } },
      vertexShader: VERT,
      fragmentShader: THERMAL_FRAG,
    }));
  }
  return thermalCache.get(key);
}

const XRAY_KINDS = {
  shell: { color: 0x39d5ff, base: 0.03, rim: 0.75, transparent: true },
  faint: { color: 0x2f8a6a, base: 0.015, rim: 0.12, transparent: true },
  occupant: { color: 0xff6a2a, base: 0.9, rim: 0.7, pulse: 1 },
  dense: { color: 0xffc53a, base: 0.75, rim: 0.6, pulse: 1 },
  dim: { color: 0x5b7d99, base: 0.22, rim: 0.4 },
};
const xrayCache = new Map();
function xrayMat(kind) {
  if (!xrayCache.has(kind)) {
    const k = XRAY_KINDS[kind] || XRAY_KINDS.dim;
    xrayCache.set(kind, new THREE.ShaderMaterial({
      uniforms: { ...SENSOR_UNIFORMS, uColor: { value: new THREE.Color(k.color) }, uBase: { value: k.base }, uRim: { value: k.rim }, uPulse: { value: k.pulse || 0 } },
      vertexShader: VERT,
      fragmentShader: XRAY_FRAG,
      transparent: !!k.transparent,
      blending: k.transparent ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: !k.transparent,
      side: k.transparent ? THREE.DoubleSide : THREE.FrontSide,
    }));
  }
  return xrayCache.get(kind);
}

export class Sensors {
  constructor(scene, env) {
    this.scene = scene;
    this.env = env; // { setSky(mode), fog }
    this.mode = 'EO';
    this.meshes = [];
    this.used = { IR: false, XRAY: false };
    this.onChange = () => {};
  }

  register(root) {
    root.traverse((o) => {
      if (!o.isMesh || o.userData.noSensor) return;
      const s = o.userData.sensor || (o.parent?.userData.sensor) || {};
      o.userData.mats = {
        EO: o.material,
        IR: o.userData.irMaterial || thermalMat(s.heat ?? 0.4),
        XRAY: o.userData.xrMaterial || xrayMat(s.xray || 'dim'),
      };
      if (this.mode !== 'EO') o.material = o.userData.mats[this.mode];
      this.meshes.push(o);
    });
  }

  /** Re-point one mesh after its heat changed (e.g. an engine that started). */
  setHeat(mesh, heat) {
    mesh.userData.sensor = { ...(mesh.userData.sensor || {}), heat };
    if (mesh.userData.mats) {
      mesh.userData.mats.IR = thermalMat(heat);
      if (this.mode === 'IR') mesh.material = mesh.userData.mats.IR;
    }
  }

  static terrainMaterials(heatTex, mapTex) {
    return {
      IR: new THREE.ShaderMaterial({ uniforms: { ...SENSOR_UNIFORMS, uHeatMap: { value: heatTex } }, vertexShader: VERT, fragmentShader: TERRAIN_THERMAL_FRAG }),
      XRAY: new THREE.ShaderMaterial({ uniforms: { ...SENSOR_UNIFORMS, uMap: { value: mapTex } }, vertexShader: VERT, fragmentShader: TERRAIN_XRAY_FRAG }),
    };
  }

  set(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'EO') this.used[mode] = true;
    for (const m of this.meshes) m.material = m.userData.mats[mode];
    this.env.applySensor(mode);
    this.onChange(mode);
  }

  cyclePalette() {
    SENSOR_UNIFORMS.uPalette.value = (SENSOR_UNIFORMS.uPalette.value + 1) % 3;
    return ['WHT', 'BLK', 'IRON'][SENSOR_UNIFORMS.uPalette.value];
  }
  get paletteName() { return ['WHT', 'BLK', 'IRON'][SENSOR_UNIFORMS.uPalette.value]; }

  tick(t) { SENSOR_UNIFORMS.uTime.value = t; }
}
