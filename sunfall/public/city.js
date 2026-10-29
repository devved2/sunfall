// Sunfall in 3D. Every resident walks the streets between home, work and wherever their plan sends them.
import * as THREE from 'three';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { EffectComposer } from '/vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '/vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '/vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '/vendor/jsm/postprocessing/OutputPass.js';
import { GLTFLoader } from '/vendor/jsm/loaders/GLTFLoader.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const txt = (v) => (v && typeof v === 'object' ? (v.quoted ?? '') : v);
const money = (n) => '$' + Math.round(n).toLocaleString();
const LITE = new URLSearchParams(location.search).has('lite') || matchMedia('(max-width: 700px)').matches;

// ------------------------------------------------------------------ helpers
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const W = (x, y, h = 0) => new THREE.Vector3(x - 500, h, y - 350); // map space (1000 x 700) -> world
const GRID = 40, OFF = 20, XMAX = 980, YMAX = 660;
const snapX = (v) => clamp(OFF + GRID * Math.round((v - OFF) / GRID), OFF, XMAX);
const snapY = (v) => clamp(OFF + GRID * Math.round((v - OFF) / GRID), OFF, YMAX);

// ------------------------------------------------------------------ renderer, scene, camera
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LITE, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, LITE ? 1.25 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = !LITE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0a0b1c, 800, 2000);
const PORTRAIT = innerWidth < innerHeight;
const persp = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 9000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -6000, 9000);
const ISO_H = PORTRAIT ? 560 : 330;                       // half the city height visible at zoom 1
const ISO_OFF = new THREE.Vector3(1, 1.05, 1).normalize().multiplyScalar(2400);
function fitOrtho() { const a = innerWidth / innerHeight; Object.assign(ortho, { left: -ISO_H * a, right: ISO_H * a, top: ISO_H, bottom: -ISO_H }); ortho.updateProjectionMatrix(); }
fitOrtho();
const HOME_CAM = PORTRAIT ? { pos: new THREE.Vector3(-40, 420, 1380), target: new THREE.Vector3(0, -30, 0) } : { pos: new THREE.Vector3(-90, 190, 900), target: new THREE.Vector3(10, 10, 20) };
let iso = (() => { try { return localStorage.getItem('sf_view') === 'iso'; } catch { return false; } })();
if (new URLSearchParams(location.search).get('view') === '3d') iso = false;
if (new URLSearchParams(location.search).get('view') === 'iso') iso = true;
let camera = iso ? ortho : persp;
persp.position.copy(HOME_CAM.pos);
ortho.position.copy(new THREE.Vector3(0, 0, 0).add(ISO_OFF));
const controls = new OrbitControls(camera, canvas);
controls.target.copy(iso ? new THREE.Vector3(0, 0, 0) : HOME_CAM.target);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 22; controls.maxDistance = 2200; controls.minZoom = 0.7; controls.maxZoom = 11;
controls.screenSpacePanning = false;
controls.zoomSpeed = 1.1;
let renderPass = null;
function applyView() {
  controls.object = camera;
  if (iso) {
    controls.minPolarAngle = controls.maxPolarAngle = Math.acos(ISO_OFF.y / ISO_OFF.length());
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  } else {
    controls.minPolarAngle = 0; controls.maxPolarAngle = 1.62;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }
  if (renderPass) renderPass.camera = camera;
  const help = document.querySelector('.help');
  if (help) help.innerHTML = iso ? 'drag to pan · right-drag to rotate · scroll to zoom<br>click anyone to follow them · esc to let go' : 'drag to orbit · right-drag to pan · scroll to zoom<br>click anyone to follow them · esc to let go';
}
// switch between the isometric map and the 3D camera, keeping the same spot in view
function setView(toIso) {
  if (toIso === iso) return;
  const t = controls.target.clone();
  if (toIso) {
    const dist = persp.position.distanceTo(t);
    ortho.zoom = clamp((ISO_H * 2.2) / dist, controls.minZoom, controls.maxZoom); ortho.updateProjectionMatrix();
    ortho.position.copy(t).add(ISO_OFF);
  } else {
    const dist = clamp((ISO_H * 2.2) / ortho.zoom, 60, 1300);
    persp.position.copy(t).add(new THREE.Vector3(0.18, 0.72, 0.88).normalize().multiplyScalar(dist));
  }
  iso = toIso; camera = iso ? ortho : persp; fly = null;
  try { localStorage.setItem('sf_view', iso ? 'iso' : '3d'); } catch {}
  applyView(); controls.update(); renderChips();
}

const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2018, 0.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -640, right: 640, top: 640, bottom: -640, near: 10, far: 3000 });
sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

// Sky: a gradient dome with a sun disc, stars and a moon that follow the camera.
const skyU = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(1, 0.8, 0.6) }, sunAmt: { value: 0 } };
const sky = new THREE.Mesh(new THREE.SphereGeometry(4200, 32, 16), new THREE.ShaderMaterial({
  uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }',
  fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol; uniform float sunAmt; varying vec3 vDir;
    void main(){
      float h = clamp(vDir.y, 0.0, 1.0);
      vec3 c = mix(horizon, top, smoothstep(-0.04, 0.3, vDir.y));
      float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
      c += sunCol * (pow(s, 900.0) * 4.0 + pow(s, 10.0) * 0.4) * sunAmt;
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
}));
sky.renderOrder = -1; sky.frustumCulled = false;
scene.add(sky);
const starPos = [];
{ const r = mulberry32(99); for (let i = 0; i < 1400; i++) { const u = r() * Math.PI * 2, v = 0.06 + r() * 0.94; const y = v, k = Math.sqrt(1 - y * y); starPos.push(Math.cos(u) * k * 4000, y * 4000, Math.sin(u) * k * 4000); } }
const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3)),
  new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
stars.frustumCulled = false; scene.add(stars);
function moonTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  const halo = g.createRadialGradient(128, 128, 20, 128, 128, 128); halo.addColorStop(0, 'rgba(200,215,255,0.55)'); halo.addColorStop(1, 'rgba(200,215,255,0)');
  g.fillStyle = halo; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#eef2ff'; g.beginPath(); g.arc(128, 128, 22, 0, 7); g.fill();
  g.fillStyle = 'rgba(160,170,200,0.35)'; for (const [x, y, r] of [[120, 122, 5], [135, 134, 4], [126, 138, 3]]) { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTexture(), color: 0xdfe6ff, transparent: true, opacity: 0, depthWrite: false, fog: false }));
moon.scale.set(420, 420, 1); scene.add(moon);

let composer = null, bloom = null;
if (!LITE) {
  composer = new EffectComposer(renderer);
  renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.55, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}

// Windows: drawn in the shader from world position, lit at night.
const nightU = { value: 0 };
function windowed(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = nightU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNorm;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        { mat4 m = modelMatrix;
          #ifdef USE_INSTANCING
            m = modelMatrix * instanceMatrix;
          #endif
          vWPos = (m * vec4(transformed, 1.0)).xyz; vWNorm = normalize(mat3(m) * objectNormal); }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight; varying vec3 vWPos; varying vec3 vWNorm;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { float vert = step(abs(vWNorm.y), 0.5);
          vec2 fp = abs(vWNorm.x) > 0.5 ? vec2(vWPos.z, vWPos.y) : vec2(vWPos.x, vWPos.y);
          vec2 bid = floor(vWPos.xz * 0.05);
          float bh = fract(sin(dot(bid, vec2(41.3, 289.1))) * 15731.7);
          vec2 cell = mix(vec2(3.2, 4.2), vec2(2.4, 4.2), step(0.5, bh));
          vec2 g = fp / cell; vec2 f = fract(g); vec2 c = floor(g);
          float wx = mix(0.22, 0.10, step(0.75, bh));
          float above = step(4.6, vWPos.y);
          float win = step(wx, f.x) * step(f.x, 1.0 - wx) * step(0.28, f.y) * step(f.y, 0.80) * above;
          float ledge = step(0.92, f.y) * above;
          float r = fract(sin(dot(c + bid * 13.0, vec2(12.9898, 78.233))) * 43758.5453);
          float lit = step(0.46, r);
          float shop = (1.0 - above) * step(1.4, vWPos.y) * step(0.4, fract(sin(dot(vec2(floor(fp.x / 7.0)) + bid, vec2(7.1, 3.7))) * 9137.3));
          float ao = mix(0.6, 1.0, smoothstep(0.5, 9.0, vWPos.y));
          diffuseColor.rgb *= ao * (1.0 - 0.5 * win * vert) * (1.0 - 0.25 * ledge * vert) * (1.0 - 0.6 * shop * vert);
          vec3 warm = mix(vec3(1.0, 0.72, 0.40), vec3(0.70, 0.85, 1.0), step(0.86, r));
          totalEmissiveRadiance += warm * win * vert * lit * uNight * 1.6;
          totalEmissiveRadiance += vec3(1.0, 0.62, 0.32) * shop * vert * (0.08 + uNight * 0.9);
        }`);
  };
  return mat;
}
applyView();
const BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
function glowTexture(inner = 'rgba(255,190,120,1)', outer = 'rgba(255,140,60,0)') {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const GLOW = glowTexture();

// ------------------------------------------------------------------ state from the city
let S = null, offset = 0, built = false;
const HOUR_OVERRIDE = Number(new URLSearchParams(location.search).get('hour'));
const cityHour = () => (Number.isFinite(HOUR_OVERRIDE) && new URLSearchParams(location.search).has('hour') ? HOUR_OVERRIDE : S ? (((Date.now() + offset - S.clock.epoch) % S.clock.dayMs) / S.clock.dayMs) * 24 : 12);
const cityDay = () => (S ? Math.floor((Date.now() + offset - S.clock.epoch) / S.clock.dayMs) : 0);
const districtAt = (x, y) => S.districts.find((d) => x >= d.rect[0] && x <= d.rect[0] + d.rect[2] && y >= d.rect[1] && y <= d.rect[1] + d.rect[3]);

// ------------------------------------------------------------------ the city itself
const STYLE = {
  flats: { k: 2, h: [16, 46], cols: ['#d4c2d4', '#c4cee2', '#e6cfbb', '#cbbfe2', '#bcd6cf'] },
  hillside: { k: 2, h: [7, 11], cols: ['#f6ead6', '#f2d6d9', '#dbe7f2', '#f3e2bd', '#e3f0dc'], trees: 0.55, empty: 0.25 },
  neon: { k: 1, h: [55, 150], cols: ['#b9a6ff', '#9fe3ff', '#ffc2e6', '#c7f5ff', '#d4b8ff'], split: 0.35 },
  oldtown: { k: 2, h: [14, 30], cols: ['#e2b48f', '#d49e7c', '#ecc59f', '#c99276', '#e8d2b0'] },
  harbour: { k: 1, h: [9, 16], cols: ['#a7c1d3', '#bccfda', '#dccab4', '#a9c3cf'], split: 0.35 },
  saltworks: { k: 1, h: [7, 14], cols: ['#c9c1b4', '#b8bcc4', '#d6cbb7', '#bdb6c7'], chimney: 0.45 },
};
// Hand-placed landmarks (map coordinates of 40x40 cells)
const CENTRAL_PARK = new Set(['520,80', '560,80', '520,120', '560,120', '520,160', '560,160']);
const PLAZA = new Set(['680,320']);
const isCanal = (cx, cy) => (cy === 480 && cx >= 360) || (cx === 760 && cy < 466);
// The city is three floating islands split by two rifts; every street that crosses a rift has a bridge.
const inRift = (mx, my) => (mx > 747 && mx < 765 && my < 466) || (my > 466 && my < 494 && mx > 340);
const ISLANDS = [
  { parts: [[15, 14, 747, 466], [15, 466, 340, 686]], depth: 320 },
  { parts: [[765, 14, 985, 466]], depth: 250 },
  { parts: [[340, 494, 985, 686]], depth: 220 },
];
const LANDMARKS = [{ name: 'Central Park', x: 560, y: 120 }, { name: 'The Plaza', x: 680, y: 320 }, { name: 'The Rift', x: 560, y: 480 }, { name: 'Skyport', x: 70, y: 520 }, { name: 'Sky Keep', x: 520, y: -330, h: 250 }];
const SLAB = { flats: '#8d8496', hillside: '#7f9a6c', neon: '#8a80a6', oldtown: '#9a8a78', harbour: '#86939e', saltworks: '#8f8a86' };
const venueMeshes = [];
const venueObjs = {};
let billboardTex = null, billboardCanvas = null;

function build() {
  const rnd = mulberry32(7);
  // water and land
  // the sky world: cloud sea, puffs, islands with rocky undersides, waterfalls, Sky Keep, islets, airships
  buildSkyWorld(rnd);
  const side = new THREE.MeshStandardMaterial({ color: 0x7a5f45, roughness: 0.95 });
  const roadTex = roadTexture();
  for (const isl of ISLANDS) for (const [x0, y0, x1, y1] of isl.parts) {
    const t = roadTex.clone(); t.needsUpdate = true;
    t.repeat.set((x1 - x0) / 970, (y1 - y0) / 672); t.offset.set((x0 - 15) / 970, 1 - (y1 - 14) / 672);
    const land = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 4, y1 - y0), [side, side, new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 }), side, side, side]);
    land.position.copy(W((x0 + x1) / 2, (y0 + y1) / 2, -2)); land.receiveShadow = true; scene.add(land);
    const grass = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0x6f9a52, roughness: 0.95 })); grass.scale.set(x1 - x0 + 3, 1.2, y1 - y0 + 3); grass.position.copy(W((x0 + x1) / 2, (y0 + y1) / 2, -4.6)); scene.add(grass);
    scene.add(rockUnder(x0, y0, x1, y1, isl.depth, rnd));
  }

  const bld = [], neon = [], chim = [], trees = [], slabs = [], parks = [], roofs = [], acs = [], tanks = [], antennas = [], awnings = [], palms = [], houses = [], benches = [], parkCells = [], crystals = [], domes = [];
  const venueNear = (cx, cy) => S.venues.some((v) => Math.abs(v.x - cx) < 34 && Math.abs(v.y - cy) < 34);
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 17; j++) {
      const cx = OFF + GRID * i + 20, cy = OFF + GRID * j + 20;
      if (cy > 676) continue;
      const key = `${cx},${cy}`;
      if (isCanal(cx, cy)) continue;
      if (CENTRAL_PARK.has(key)) { parkCells.push([cx, cy]); continue; }
      if (PLAZA.has(key)) { plazaAt = [cx, cy]; continue; }
      const d = districtAt(cx, cy);
      if (!d) { parks.push([cx, cy]); continue; }
      slabs.push([cx, cy, SLAB[d.id] || '#2a2a2a']);
      if (venueNear(cx, cy)) continue;
      const st = STYLE[d.id];
      let k = st.k;
      if (st.split && rnd() < st.split) k = 2;
      const lot = (28 - (k - 1) * 2) / k;
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
        const lx = cx - 14 + lot / 2 + a * (lot + 2), ly = cy - 14 + lot / 2 + b * (lot + 2);
        if (st.empty && rnd() < st.empty) { trees.push([lx, ly, 1 + rnd() * 0.5]); continue; }
        if (d.id === 'neon') { let h = 55 + Math.pow(rnd(), 1.4) * 95; if (S.venues.some((v) => Math.hypot(v.x - lx, v.y - ly) < 120)) h = Math.min(h, 44); crystals.push([lx, ly, lot * (0.55 + rnd() * 0.3), h, st.cols[Math.floor(rnd() * st.cols.length)], rnd() * Math.PI]); if (rnd() < 0.6) crystals.push([lx + (rnd() - 0.5) * lot * 0.6, ly + (rnd() - 0.5) * lot * 0.6, lot * 0.3, h * (0.35 + rnd() * 0.3), st.cols[Math.floor(rnd() * st.cols.length)], rnd() * Math.PI]); continue; }
        const shrink = rnd() * 2.5;
        let [h0, h1] = st.h;
        if (d.id === 'harbour' && k === 2) { h0 = 14; h1 = 28; }
        let h = h0 + Math.pow(rnd(), 1.6) * (h1 - h0);
        if (S.venues.some((v) => Math.hypot(v.x - lx, v.y - ly) < 75)) h = Math.min(h, 42);
        const w = lot - shrink, dd = lot - rnd() * 2.5;
        const col = st.cols[Math.floor(rnd() * st.cols.length)];
        const tiered = d.id !== 'hillside' && h > 34 && rnd() < 0.45;
        const pitched = !tiered && ((d.id === 'hillside') || (d.id === 'oldtown' && rnd() < 0.8) || (d.id === 'flats' && h < 28 && rnd() < 0.55) || (d.id === 'harbour' && rnd() < 0.4));
        bld.push([lx, ly, w, dd, h, col, 0, d.id, !tiered, pitched]);
        if (pitched) { const rc = d.id === 'hillside' ? ['#5d6fa8', '#c25b4a', '#4f8f8a', '#7a5ea8'] : ['#b5523b', '#9c4a36', '#c0613f', '#5b6378', '#4f7a8a']; roofs.push([lx, ly, w, dd, 0.8 + h, rc[Math.floor(rnd() * rc.length)], (d.id === 'hillside' ? 0.75 : 0.32) * Math.min(w, dd) + rnd() * 2]); if (d.id === 'hillside' && rnd() < 0.6) chim.push([lx + w * 0.25, ly - dd * 0.2, h + 3 + rnd() * 3, 0.45]); }
        let topH = h, topW = w, topD = dd;
        if (tiered) { const th = h * (0.18 + rnd() * 0.25); bld.push([lx, ly, w * 0.68, dd * 0.68, th, col, h + 0.9, d.id, true]); topH = h + 0.9 + th; topW = w * 0.68; topD = dd * 0.68; }
        if (!pitched && (d.id === 'flats' || d.id === 'oldtown') && topH > 30 && rnd() < 0.4) domes.push([lx, ly, Math.min(topW, topD) * 0.8, 0.8 + topH + 0.9, ['#5fb3a8', '#d8b45a', '#9b88d0', '#6f9ad8'][Math.floor(rnd() * 4)]]);
        if (pitched) {}
        else {
          const rt = 0.8 + topH + 0.9;
          if (rnd() < 0.5) acs.push([lx + topW * 0.22, ly - topD * 0.22, rt, 3.6]);
          const nAc = rnd() < 0.65 ? 1 + Math.floor(rnd() * 3) : 0;
          for (let a2 = 0; a2 < nAc; a2++) acs.push([lx + (rnd() - 0.5) * topW * 0.6, ly + (rnd() - 0.5) * topD * 0.6, rt, 1.6 + rnd() * 1.6]);
          if ((d.id === 'flats' || d.id === 'oldtown') && rnd() < 0.32) tanks.push([lx + (rnd() - 0.5) * topW * 0.4, ly + (rnd() - 0.5) * topD * 0.4, rt]);
          if (topH > 95 && rnd() < 0.8) antennas.push([lx, ly, rt, 10 + rnd() * 12]);
          if ((d.id === 'flats' || d.id === 'oldtown') && rnd() < 0.45) awnings.push([lx, ly + dd / 2 + 1.1, w * 0.72, ['#c8423a', '#2f6f5e', '#d9a13a', '#3a5a9c', '#e8ddc8', '#7a3b6e'][Math.floor(rnd() * 6)]]);
        }
        if (st.neon && rnd() < st.neon) {
          const y = 12 + rnd() * (h - 20);
          neon.push([lx, ly, w + 0.6, dd + 0.6, y, ['#ff3d8b', '#3df2ff', '#a35bff', '#ff8a3d'][Math.floor(rnd() * 4)]]);
          if (h > 110) neon.push([lx, ly, w + 0.6, dd + 0.6, h - 2, '#ff3d8b']);
        }
        if (st.chimney && rnd() < st.chimney) { chim.push([lx + w / 4, ly - dd / 4, 26 + rnd() * 22]); steamAt.push(W(lx + w / 4, ly - dd / 4, 0.8 + 26 + 11)); }
        if (st.trees && rnd() < st.trees) trees.push([lx + lot / 2, ly + lot / 2, 0.8 + rnd() * 0.4]);
      }
    }
  }
  // sidewalks / blocks
  const slabMesh = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ roughness: 0.9 }), slabs.length + parks.length);
  // waterfront palms (harbour edge, the south promenade, saltworks quay)
  for (let y = 380; y <= 660; y += 40) palms.push([24, y + 20, 0.9 + rnd() * 0.25]);
  for (let x = 40; x <= 960; x += 40) if (rnd() < 0.8) trees.push([x + (rnd() - 0.5) * 8, 680, 0.8 + rnd() * 0.3, 1]);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c3 = new THREE.Color();
  let n = 0;
  for (const [x, y, col] of slabs) { m4.compose(W(x, y, 0), q, new THREE.Vector3(30, 0.8, 30)); slabMesh.setMatrixAt(n, m4); slabMesh.setColorAt(n++, c3.set(col)); }
  for (const [x, y] of parks) {
    m4.compose(W(x, y, 0), q, new THREE.Vector3(30, 0.8, 30)); slabMesh.setMatrixAt(n, m4); slabMesh.setColorAt(n++, c3.set('#355e34'));
    for (let t = 0; t < 3; t++) trees.push([x - 10 + rnd() * 20, y - 10 + rnd() * 20, 0.75 + rnd() * 0.5]);
  }
  slabMesh.receiveShadow = true; scene.add(slabMesh);

  // buildings
  const bMat = windowed(new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.08 }));
  const bMesh = new THREE.InstancedMesh(BOX, bMat, bld.length);
  bld.forEach(([x, y, w, d, h, col, base], i) => { m4.compose(W(x, y, 0.8 + base), q, new THREE.Vector3(w, h, d)); bMesh.setMatrixAt(i, m4); bMesh.setColorAt(i, c3.set(col)); });
  bMesh.castShadow = bMesh.receiveShadow = true; scene.add(bMesh);
  // roof caps (slightly lighter, gives the skyline an edge)
  const capped = bld.filter((b) => !b[9]);
  const capMesh = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ roughness: 0.9 }), Math.max(capped.length, 1));
  capped.forEach(([x, y, w, d, h, col, base], i) => { m4.compose(W(x, y, 0.8 + base + h), q, new THREE.Vector3(w + 0.6, 0.9, d + 0.6)); capMesh.setMatrixAt(i, m4); capMesh.setColorAt(i, c3.set(col).multiplyScalar(0.62)); });
  capMesh.castShadow = true; scene.add(capMesh);
  // hip roofs on the hillside villas
  const roofMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.7071, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), Math.max(roofs.length, 1));
  roofs.forEach(([x, y, w, d, top, col, rh], i) => { m4.compose(W(x, y, top), q, new THREE.Vector3(w * 1.12, rh, d * 1.12)); roofMesh.setMatrixAt(i, m4); roofMesh.setColorAt(i, c3.set(col)); });
  roofMesh.castShadow = true; scene.add(roofMesh);
  // rooftop clutter: AC units, water tanks, antennas with blinking lights
  const acMesh = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.3 }), Math.max(acs.length, 1));
  acs.forEach(([x, y, top, sz], i) => { m4.compose(W(x, y, top), q, new THREE.Vector3(sz, sz * 0.7, sz * 0.8)); acMesh.setMatrixAt(i, m4); });
  acMesh.castShadow = true; scene.add(acMesh);
  const tankBody = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.7, 1.7, 3.2, 12).translate(0, 3.4, 0), new THREE.MeshStandardMaterial({ color: 0x6b4a34, roughness: 0.9 }), Math.max(tanks.length, 1));
  const tankTop = new THREE.InstancedMesh(new THREE.ConeGeometry(1.9, 1.3, 12).translate(0, 5.65, 0), new THREE.MeshStandardMaterial({ color: 0x4a3a30, roughness: 0.9 }), Math.max(tanks.length, 1));
  const tankLegs = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ color: 0x2e2a28 }), Math.max(tanks.length, 1));
  tanks.forEach(([x, y, top], i) => { m4.compose(W(x, y, top), q, new THREE.Vector3(1, 1, 1)); tankBody.setMatrixAt(i, m4); tankTop.setMatrixAt(i, m4); m4.compose(W(x, y, top), q, new THREE.Vector3(2.6, 1.8, 2.6)); tankLegs.setMatrixAt(i, m4); });
  for (const m of [tankBody, tankTop, tankLegs]) { m.castShadow = true; scene.add(m); }
  if (antennas.length) {
    const ant = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.3, 1, 5).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x3a3a40 }), antennas.length);
    antennas.forEach(([x, y, top, hh], i) => { m4.compose(W(x, y, top), q, new THREE.Vector3(1, hh, 1)); ant.setMatrixAt(i, m4); });
    scene.add(ant);
    const tips = new THREE.Points(new THREE.BufferGeometry().setFromPoints(antennas.map(([x, y, top, hh]) => W(x, y, top + hh + 0.3))),
      new THREE.PointsMaterial({ map: GLOW, size: 10, color: 0xff3030, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(tips); blinkers.push(tips.material);
  }
  // shop awnings over the street
  if (awnings.length) {
    const aw = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.35, 2.4).translate(0, 0, 0), new THREE.MeshStandardMaterial({ roughness: 0.7 }), awnings.length);
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.28, 0, 0));
    awnings.forEach(([x, y, w, col], i) => { m4.compose(W(x, y, 5.6), tilt, new THREE.Vector3(w, 1, 1)); aw.setMatrixAt(i, m4); aw.setColorAt(i, c3.set(col)); });
    aw.castShadow = true; scene.add(aw);
  }
  // neon bands
  if (neon.length) {
    const nMesh = new THREE.InstancedMesh(BOX, new THREE.MeshBasicMaterial({ toneMapped: false }), neon.length);
    neon.forEach(([x, y, w, d, h, col], i) => { m4.compose(W(x, y, h), q, new THREE.Vector3(w, 0.7, d)); nMesh.setMatrixAt(i, m4); nMesh.setColorAt(i, c3.set(col).multiplyScalar(2.4)); });
    scene.add(nMesh);
  }
  // chimneys
  if (chim.length) {
    const g = new THREE.CylinderGeometry(1.4, 2, 1, 10).translate(0, 0.5, 0);
    const cMesh = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0x6d5c52, roughness: 0.9 }), chim.length);
    chim.forEach(([x, y, h, sc = 1], i) => { m4.compose(W(x, y, 0.8), q, new THREE.Vector3(sc, h, sc)); cMesh.setMatrixAt(i, m4); });
    cMesh.castShadow = true; scene.add(cMesh);
  }
  // crystal spires on Crystal Row: hex prisms with pointed tips that glow after dark
  if (crystals.length) {
    const cg = new THREE.CylinderGeometry(0.5, 0.5, 1, 6).translate(0, 0.5, 0), tg = new THREE.ConeGeometry(0.5, 1, 6).translate(0, 0.5, 0);
    const cm = glowing(new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.1, flatShading: true }));
    const body = new THREE.InstancedMesh(cg, cm, crystals.length), tip = new THREE.InstancedMesh(tg, cm, crystals.length);
    const tips = [];
    crystals.forEach(([x, y, r, h, col, rot], i) => {
      qq0.setFromAxisAngle(UP, rot);
      m4.compose(W(x, y, 0.8), qq0, new THREE.Vector3(r, h, r)); body.setMatrixAt(i, m4); body.setColorAt(i, c3.set(col));
      m4.compose(W(x, y, 0.8 + h), qq0, new THREE.Vector3(r, r * 1.6, r)); tip.setMatrixAt(i, m4); tip.setColorAt(i, c3.set(col).offsetHSL(0, 0, 0.08));
      if (h > 60) tips.push(W(x, y, 0.8 + h + r * 1.6));
    });
    body.castShadow = tip.castShadow = true; scene.add(body, tip);
    const tp = new THREE.Points(new THREE.BufferGeometry().setFromPoints(tips), new THREE.PointsMaterial({ map: GLOW, size: 14, color: 0xd8c8ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(tp); nightGlows.push(tp.material);
  }
  // domes on the taller towers
  if (domes.length) {
    const dm = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.35 }), domes.length);
    domes.forEach(([x, y, r, top, col], i) => { m4.compose(W(x, y, top), q, new THREE.Vector3(r, r * 0.9, r)); dm.setMatrixAt(i, m4); dm.setColorAt(i, c3.set(col)); });
    dm.castShadow = true; scene.add(dm);
  }
  // landmarks: Central Park, the Plaza, the canal
  buildLandmarks(rnd, parkCells, trees, palms, benches);
  // trees: chunky cube canopies
  const greens = ['#3f7a3a', '#4f8a42', '#356a33', '#5d9a4c', '#2f5e30'];
  const crown = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }), trees.length * 3);
  const trunk = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ color: 0x5a3e2a, roughness: 0.9 }), trees.length);
  trees.forEach(([x, y, s], i) => {
    m4.compose(W(x, y, 0.8), q, new THREE.Vector3(0.9 * s, 3.4 * s, 0.9 * s)); trunk.setMatrixAt(i, m4);
    const g = trees[i][3] || rnd() < 0.14 ? ['#f2a7c3', '#f7c1d4', '#e98fb5'][Math.floor(rnd() * 3)] : greens[Math.floor(rnd() * greens.length)];
    const parts = [[0, 3.0, 0, 5.4], [(rnd() - 0.5) * 3, 5.6 + rnd(), (rnd() - 0.5) * 3, 3.6], [(rnd() - 0.5) * 4, 2.6, (rnd() - 0.5) * 4, 3.2]];
    parts.forEach(([ox, oy, oz, sz], k) => { m4.compose(W(x + ox * s, y + oz * s, 0.8 + oy * s), q, new THREE.Vector3(sz * s, sz * s * 0.9, sz * s)); crown.setMatrixAt(i * 3 + k, m4); crown.setColorAt(i * 3 + k, c3.set(g).offsetHSL(0, 0, (rnd() - 0.5) * 0.06)); });
  });
  crown.castShadow = trunk.castShadow = true; scene.add(crown, trunk);
  // palms
  if (palms.length) {
    const ptrunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.6, 1, 6).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.9 }), palms.length);
    const leaf = new THREE.InstancedMesh(new THREE.BoxGeometry(7, 0.3, 1.8).translate(3.5, 0, 0), new THREE.MeshStandardMaterial({ color: 0x3f8a4a, roughness: 0.8, flatShading: true }), palms.length * 6);
    const e = new THREE.Euler(), qq = new THREE.Quaternion();
    palms.forEach(([x, y, s], i) => {
      const h = 13 * s;
      qq.setFromEuler(e.set((rnd() - 0.5) * 0.12, 0, (rnd() - 0.5) * 0.12));
      m4.compose(W(x, y, 0.8), qq, new THREE.Vector3(s, h, s)); ptrunk.setMatrixAt(i, m4);
      for (let k = 0; k < 6; k++) { qq.setFromEuler(e.set(0, k * 1.047 + rnd() * 0.3, -0.42 - rnd() * 0.2, 'YXZ')); m4.compose(W(x, y, 0.8 + h), qq, new THREE.Vector3(s, s, s)); leaf.setMatrixAt(i * 6 + k, m4); leaf.setColorAt(i * 6 + k, c3.set(k % 2 ? '#3f8a4a' : '#4d9a52')); }
    });
    ptrunk.castShadow = leaf.castShadow = true; scene.add(ptrunk, leaf);
  }
  // benches
  if (benches.length) {
    const bench = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.8 }), benches.length);
    benches.forEach(([x, y, rot], i) => { qq0.setFromAxisAngle(UP, rot); m4.compose(W(x, y, 0.8), qq0, new THREE.Vector3(5, 1.2, 1.6)); bench.setMatrixAt(i, m4); });
    scene.add(bench);
  }
  // Hillside houses from Kenney's city kit (MIT), loaded in the background
  buildTrafficLights(rnd);

  // streetlights at intersections, glow at night
  const lamps = [];
  for (let x = OFF; x <= XMAX; x += GRID) for (let y = OFF; y <= YMAX; y += GRID) if (!inRift(x + 6.5, y + 6.5)) lamps.push([x + 6.5, y + 6.5]);
  const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.3, 9, 5).translate(0, 4.5, 0), new THREE.MeshStandardMaterial({ color: 0x2b2b30 }), lamps.length);
  lamps.forEach(([x, y], i) => { m4.compose(W(x, y, 0), q, new THREE.Vector3(1, 1, 1)); pole.setMatrixAt(i, m4); });
  scene.add(pole);
  const lampGeo = new THREE.BufferGeometry().setFromPoints(lamps.map(([x, y]) => W(x, y, 9.4)));
  lampPoints = new THREE.Points(lampGeo, new THREE.PointsMaterial({ map: GLOW, size: 16, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  scene.add(lampPoints);

  // sky docks jutting off the island edges
  const pierMat = new THREE.MeshStandardMaterial({ color: 0x4a3c30, roughness: 0.9 });
  for (const [x, y, w, d] of [[-2, 420, 44, 7], [-2, 500, 52, 7], [-2, 590, 40, 7], [800, 702, 7, 60], [870, 700, 7, 52], [140, 702, 7, 50]]) {
    const p = new THREE.Mesh(BOX, pierMat); p.scale.set(w, 1.4, d); p.position.copy(W(x, y, -1)); p.receiveShadow = true; scene.add(p);
  }

  for (const v of S.venues) buildVenue(v, rnd);
  buildLandmarkLabels();
  buildBillboard();
  buildCars(rnd);
  buildBoats(rnd);
  buildSteam();
  built = true;
  $('#loading').classList.add('gone');
}
let lampPoints = null, waterMat = null, canalMat = null, plazaAt = null;
const steamAt = [];
const UP = new THREE.Vector3(0, 1, 0), qq0 = new THREE.Quaternion();
const nightGlows = [], blinkers = [], beams = [], boats = [];


// ================================================================== the sky world
const timeU = { value: 0 };
const skyTint = { light: new THREE.Color(0xffe3d6), shadow: new THREE.Color(0x9b8fc4) };
// glowing materials: emissive takes the instance colour, scaled by night
const glowU = { value: 0.1 };
function glowing(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = glowU;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_COLOR
          totalEmissiveRadiance += vColor * uGlow;
        #else
          totalEmissiveRadiance += diffuseColor.rgb * uGlow;
        #endif`);
  };
  return mat;
}

// A rocky underside hanging from a rectangle of land: rings shrinking to a jagged tip.
function rockUnder(x0, y0, x1, y1, depth, rnd) {
  const per = [], step = 14;
  for (let x = x0; x < x1; x += step) per.push([x, y0]);
  for (let y = y0; y < y1; y += step) per.push([x1, y]);
  for (let x = x1; x > x0; x -= step) per.push([x, y1]);
  for (let y = y1; y > y0; y -= step) per.push([x0, y]);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, L = 8, N = per.length;
  const pos = [], col = [], idx = [];
  const cTop = new THREE.Color(0x9a7650), cMid = new THREE.Color(0xb0a0c4), cLow = new THREE.Color(0xe2d8f2), tmpc = new THREE.Color();
  for (let k = 0; k <= L; k++) {
    const t = k / L, sc = 1 - Math.pow(t, 0.8) * 0.9;
    for (let i = 0; i < N; i++) {
      const [px, py] = per[i];
      const jx = k ? (rnd() - 0.5) * (8 + 26 * t) : 0, jy = k ? (rnd() - 0.5) * (8 + 26 * t) : 0;
      const v = W(cx + (px - cx) * sc + jx, cy + (py - cy) * sc + jy, -4 - depth * Math.pow(t, 1.1) - (k ? rnd() * 14 : 0));
      pos.push(v.x, v.y, v.z);
      tmpc.copy(cTop).lerp(cMid, Math.min(1, t * 2)).lerp(cLow, Math.max(0, t * 2 - 1)); col.push(tmpc.r, tmpc.g, tmpc.b);
    }
  }
  const tip = W(cx + (rnd() - 0.5) * 30, cy + (rnd() - 0.5) * 30, -4 - depth * 1.18);
  pos.push(tip.x, tip.y, tip.z); col.push(cLow.r, cLow.g, cLow.b);
  for (let k = 0; k < L; k++) for (let i = 0; i < N; i++) {
    const a = k * N + i, b = k * N + (i + 1) % N, c = (k + 1) * N + i, d = (k + 1) * N + (i + 1) % N;
    idx.push(a, c, b, b, c, d);
  }
  const tipI = (L + 1) * N; for (let i = 0; i < N; i++) idx.push(L * N + i, tipI, L * N + (i + 1) % N);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, side: THREE.DoubleSide }));
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// soft cloud puff texture
function puffTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); const r = mulberry32(11);
  for (let i = 0; i < 26; i++) {
    const x = 70 + r() * 116, y = 90 + r() * 90, rad = 30 + r() * 60;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const puffMats = [];
const puffs = [];
let cloudSea = null, planet = null, planetGlow = null, planetRing = null;
const falls = [], islets = [], airships = [], steam = [];

function waterfall(x, y, top, width, height, facing) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeU, uNight: nightU }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float uTime; uniform float uNight; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      void main(){
        float streak = n(vec2(vUv.x * 18.0, vUv.y * 3.0 + uTime * 2.2)) * 0.6 + n(vec2(vUv.x * 40.0, vUv.y * 6.0 + uTime * 3.4)) * 0.4;
        float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
        float fade = smoothstep(0.0, 0.45, vUv.y);
        vec3 c = mix(vec3(0.78,0.9,1.0), vec3(1.0), streak) * mix(1.0, 0.45, uNight);
        gl_FragColor = vec4(c, (0.35 + streak * 0.6) * edge * fade);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, height).translate(0, -height / 2, 0), mat);
  m.position.copy(W(x, y, top)); m.rotation.y = facing; scene.add(m); falls.push(m);
  // a lip of water at the top, and mist at the bottom
  const mist = new THREE.Sprite(puffMats[0]); mist.scale.set(width * 3.5, width * 2.2, 1); mist.position.copy(W(x, y, top - height + 10)); scene.add(mist);
}

function puff(x, y, h, size, mi = 0) {
  const sp = new THREE.Sprite(puffMats[mi]); sp.scale.set(size, size * 0.62, 1); sp.position.copy(W(x, y, h)); scene.add(sp);
  puffs.push({ sp, base: sp.position.clone(), ph: Math.random() * 6.28, sp0: 2 + Math.random() * 4 });
  return sp;
}

function cottage(grp, x, z, w, h, rnd) {
  const body = new THREE.Mesh(BOX, windowed(new THREE.MeshStandardMaterial({ color: ['#f6ead6', '#f2d6d9', '#dbe7f2', '#f3e2bd'][Math.floor(rnd() * 4)], roughness: 0.85 })));
  body.scale.set(w, h, w * 0.85); body.position.set(x, 0, z); body.castShadow = body.receiveShadow = true; grp.add(body);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.7071, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: ['#5d6fa8', '#c25b4a', '#4f8f8a'][Math.floor(rnd() * 3)], flatShading: true }));
  roof.scale.set(w * 1.15, w * 0.8, w); roof.position.set(x, h, z); roof.castShadow = true; grp.add(roof);
}

function tower(grp, x, z, r, h, roofH, roofCol, rnd, win = true) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xe9dfcf, roughness: 0.85 });
  const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, h, 14).translate(0, h / 2, 0), win ? windowed(mat) : mat);
  t.position.set(x, 0, z); t.castShadow = t.receiveShadow = true; grp.add(t);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.18, r * 1.18, 1.6, 14), new THREE.MeshStandardMaterial({ color: 0xd2c6b4 })); ring.position.set(x, h, z); grp.add(ring);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 1.3, roofH, 14).translate(0, roofH / 2, 0), new THREE.MeshStandardMaterial({ color: roofCol, roughness: 0.6, metalness: 0.15 }));
  cone.position.set(x, h + 0.8, z); cone.castShadow = true; grp.add(cone);
  const flag = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0xffd36e, emissive: 0xffb02e, emissiveIntensity: 0.4 })); flag.scale.set(0.3, 6, 0.3); flag.position.set(x, h + 0.8 + roofH, z); grp.add(flag);
  return h + roofH;
}

function buildSkyKeep(rnd) {
  // the castle island, floating above and behind the city
  const [x0, y0, x1, y1] = [420, -440, 640, -240], lift = 70;
  const grp = new THREE.Group(); grp.position.set(0, lift, 0); scene.add(grp);
  const under = rockUnder(x0, y0, x1, y1, 300, rnd); grp.add(under);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 9), new THREE.MeshStandardMaterial({ color: 0x79a85a, roughness: 0.95, flatShading: true }));
  top.scale.set(118, 6, 104); top.position.copy(W(530, -340, -3)); top.receiveShadow = true; grp.add(top);
  const keep = new THREE.Group(); keep.position.copy(W(530, -345, 0)); grp.add(keep);
  const wallM = windowed(new THREE.MeshStandardMaterial({ color: 0xe9dfcf, roughness: 0.85 }));
  const hall = new THREE.Mesh(BOX, wallM); hall.scale.set(46, 34, 38); hall.castShadow = hall.receiveShadow = true; keep.add(hall);
  const hallRoof = new THREE.Mesh(new THREE.ConeGeometry(0.7071, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x5d6fa8, flatShading: true }));
  hallRoof.scale.set(50, 26, 42); hallRoof.position.y = 34; keep.add(hallRoof);
  tower(keep, 0, 0, 7, 120, 46, 0x6b7fc0, rnd);           // the great spire
  for (const [tx, tz, r, h] of [[-27, -22, 6, 72], [27, -22, 6, 80], [-27, 22, 6.5, 64], [27, 22, 6, 70], [-44, 0, 4.5, 50], [44, 0, 4.5, 56], [0, -36, 5, 92], [14, 36, 4, 48]]) tower(keep, tx, tz, r, h, r * 4.2, [0x6b7fc0, 0x7a5ea8, 0x4f8f8a][Math.floor(rnd() * 3)], rnd);
  for (const [wx, wz, ww, wd] of [[0, -30, 54, 3], [0, 30, 54, 3], [-30, 0, 3, 54], [30, 0, 3, 54]]) { const wall = new THREE.Mesh(BOX, wallM); wall.scale.set(ww, 16, wd); wall.position.set(wx, 0, wz); wall.castShadow = true; keep.add(wall); }
  for (let i = 0; i < 12; i++) { const a = rnd() * 6.28, r = 60 + rnd() * 40; cottage(keep, Math.cos(a) * r, Math.sin(a) * r * 0.85, 7 + rnd() * 3, 6 + rnd() * 3, rnd); }
  // waterfalls pouring off the castle island
  for (const [fx, fy, rot] of [[470, -240, 0], [600, -240, 0], [640, -330, Math.PI / 2]]) waterfall(fx, fy + (rot ? 0 : 2), lift - 2, 16, 280, rot);
  for (let i = 0; i < 5; i++) puff(430 + rnd() * 200, -230 + rnd() * 40, lift - 60 - rnd() * 80, 160 + rnd() * 120, 1);
}

function buildIslet(x, y, h, size, rnd) {
  const g = new THREE.Group(); scene.add(g);
  g.add(rockUnder(x - size / 2, y - size / 2, x + size / 2, y + size / 2, size * 1.6, rnd));
  const top = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.62, size * 0.66, 5, 8), new THREE.MeshStandardMaterial({ color: 0x79a85a, flatShading: true }));
  top.position.copy(W(x, y, -2.5)); top.receiveShadow = true; g.add(top);
  const inner = new THREE.Group(); inner.position.copy(W(x, y, 0)); g.add(inner);
  if (rnd() < 0.55) cottage(inner, 0, 0, size * 0.22, size * 0.18, rnd);
  for (let i = 0; i < 2 + Math.floor(rnd() * 3); i++) {
    const a = rnd() * 6.28, r = size * (0.18 + rnd() * 0.25), s = 0.7 + rnd() * 0.6;
    const trunk = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0x5a3e2a })); trunk.scale.set(0.9 * s, 3.4 * s, 0.9 * s); trunk.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); inner.add(trunk);
    const cr = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: rnd() < 0.3 ? 0xf2a7c3 : 0x4f8a42, flatShading: true })); cr.scale.set(5.4 * s, 4.8 * s, 5.4 * s); cr.position.set(Math.cos(a) * r, 3 * s, Math.sin(a) * r); cr.castShadow = true; inner.add(cr);
  }
  g.position.y = h;
  islets.push({ g, y0: h, ph: rnd() * 6.28 });
}

function airshipMesh(scale, rnd) {
  const g = new THREE.Group();
  const col = [0xf0c9b0, 0xd9cdf2, 0xbfe0e8, 0xf2e2b8][Math.floor(rnd() * 4)];
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: col, roughness: 0.55 })); hull.scale.set(26, 9, 9); hull.castShadow = true; g.add(hull);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(9.1, 9.1, 2, 20).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a6a4a })); g.add(band);
  const gond = new THREE.Mesh(BOX, windowed(new THREE.MeshStandardMaterial({ color: 0x7a5a3e }))); gond.scale.set(12, 4.5, 5); gond.position.y = -13.5; g.add(gond);
  for (const sx of [-4, 4]) { const rope = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0x3a2a20 })); rope.scale.set(0.25, 6, 0.25); rope.position.set(sx, -9.5, 0); g.add(rope); }
  for (const [fy, fz, rx] of [[7, 0, 0], [-7, 0, 0], [0, 7, Math.PI / 2], [0, -7, Math.PI / 2]]) { const fin = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0xc25b4a })); fin.scale.set(7, 0.5, 5); fin.position.set(-24, fy * 0.6, fz * 0.6); fin.rotation.x = rx; g.add(fin); }
  const lamp = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(6, -15, 0), new THREE.Vector3(-6, -15, 0), new THREE.Vector3(26, 0, 0)]), new THREE.PointsMaterial({ map: GLOW, size: 8, color: 0xffd08a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  g.add(lamp); nightGlows.push(lamp.material);
  g.scale.setScalar(scale);
  return g;
}

function buildSkyWorld(rnd) {
  puffMats.push(new THREE.SpriteMaterial({ map: puffTexture(), transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.9 }));
  puffMats.push(new THREE.SpriteMaterial({ map: puffMats[0].map, transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.75 }));
  // the sea of clouds far below
  cloudSea = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000, 1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    uniforms: { uTime: timeU, uLight: { value: skyTint.light }, uShadow: { value: skyTint.shadow }, uHaze: { value: new THREE.Color() } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float uTime; uniform vec3 uLight; uniform vec3 uShadow; uniform vec3 uHaze; varying vec3 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a * n(p); p *= 2.03; a *= 0.5; } return v; }
      void main(){
        vec2 p = vW.xz * 0.0028 + vec2(uTime * 0.006, uTime * 0.003);
        float c = fbm(p) * 0.65 + fbm(p * 2.7 - 3.1) * 0.35;
        vec3 col = mix(uShadow, uLight, smoothstep(0.32, 0.78, c));
        float d = length(vW.xz) / 6500.0;
        col = mix(col, uHaze, smoothstep(0.15, 1.0, d));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  cloudSea.position.y = -330; scene.add(cloudSea);
  // big soft puffs drifting around and below the islands
  for (let i = 0; i < (LITE ? 30 : 55); i++) {
    const a = rnd() * 6.28, r = 680 + rnd() * 900;
    puff(500 + Math.cos(a) * r, 350 + Math.sin(a) * r * 0.8, -170 - rnd() * 160, 260 + rnd() * 360, i % 2);
  }
  for (let i = 0; i < 12; i++) puff(rnd() * 1000, rnd() * 700, -220 - rnd() * 100, 260 + rnd() * 200, 1);
  // the giant moon hanging in the sky
  const pc = document.createElement('canvas'); pc.width = pc.height = 512; const pg = pc.getContext('2d');
  const grd = pg.createLinearGradient(0, 0, 512, 512); grd.addColorStop(0, '#e6e9ff'); grd.addColorStop(1, '#b4a9e6'); pg.fillStyle = grd; pg.fillRect(0, 0, 512, 512);
  const pr = mulberry32(21); for (let i = 0; i < 70; i++) { pg.fillStyle = `rgba(120,110,170,${0.05 + pr() * 0.12})`; pg.beginPath(); pg.arc(pr() * 512, pr() * 512, 6 + pr() * 40, 0, 7); pg.fill(); }
  const ptex = new THREE.CanvasTexture(pc); ptex.colorSpace = THREE.SRGBColorSpace;
  planet = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ map: ptex, transparent: true, opacity: 0.85, fog: false, depthWrite: false }));
  planet.scale.setScalar(650); planet.renderOrder = -0.5; scene.add(planet);
  planetRing = new THREE.Mesh(new THREE.RingGeometry(1.35, 2.1, 96), new THREE.MeshBasicMaterial({ color: 0xf3e6ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide, fog: false, depthWrite: false }));
  planetRing.scale.setScalar(650); planetRing.rotation.set(1.25, 0.2, 0.35); planetRing.renderOrder = -0.4; scene.add(planetRing);
  planetGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(240,230,255,0.7)', 'rgba(240,230,255,0)'), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
  planetGlow.material.opacity = 0.45; planetGlow.scale.set(1000, 1000, 1); scene.add(planetGlow);
  // waterfalls off the city's edges and into the rifts
  waterfall(15, 450, -3, 18, 300, Math.PI / 2); waterfall(15, 610, -3, 14, 260, Math.PI / 2);
  waterfall(520, 686, -3, 20, 300, 0); waterfall(880, 686, -3, 14, 240, 0);
  waterfall(985, 140, -3, 16, 260, Math.PI / 2); waterfall(300, 14, -3, 14, 240, 0);
  waterfall(747, 330, -3, 8, 160, Math.PI / 2); waterfall(620, 494, -3, 10, 170, 0);
  buildSkyKeep(rnd);
  for (const [x, y, h, sz] of [[-150, 180, 30, 70], [-120, 560, -30, 54], [1150, 260, 40, 64], [1120, 600, -20, 50], [240, 860, -70, 60], [820, 880, -50, 46], [1060, -120, 70, 58], [-60, -150, 50, 52], [330, -230, 20, 36]]) buildIslet(x, y, h, sz, rnd);
  // airships circling the city
  for (let i = 0; i < (LITE ? 3 : 5); i++) { const g = airshipMesh(0.9 + rnd() * 0.5, rnd); scene.add(g); airships.push({ g, r: 840 + rnd() * 260, h: 150 + rnd() * 90, sp: (0.012 + rnd() * 0.01) * (rnd() < 0.5 ? 1 : -1), a: rnd() * 6.28 }); }
  // chimney steam
  steamTex = puffMats[0].map;
}
let steamTex = null;
function buildSteam() {
  for (const at of steamAt.slice(0, 40)) for (let k = 0; k < 3; k++) {
    const m = new THREE.SpriteMaterial({ map: steamTex, transparent: true, depthWrite: false, opacity: 0.5 });
    const sp = new THREE.Sprite(m); sp.position.copy(at); scene.add(sp); steam.push({ sp, at, t: k / 3 });
  }
}
function updateSkyWorld(t, dt) {
  timeU.value = t;
  for (const p of puffs) p.sp.position.x = p.base.x + Math.sin(t * 0.02 + p.ph) * 30;
  for (const i of islets) i.g.position.y = i.y0 + Math.sin(t * 0.35 + i.ph) * 4;
  for (const a of airships) {
    a.a += a.sp * dt;
    a.g.position.set(Math.cos(a.a) * a.r, a.h + Math.sin(t * 0.4 + a.r) * 4, Math.sin(a.a) * a.r * 0.85);
    a.g.rotation.y = -a.a + (a.sp > 0 ? -Math.PI / 2 : Math.PI / 2);
  }
  for (const st of steam) {
    st.t = (st.t + dt * 0.12) % 1;
    st.sp.position.set(st.at.x + st.t * 6, st.at.y + st.t * 22, st.at.z);
    const sz = 6 + st.t * 18; st.sp.scale.set(sz, sz * 0.7, 1);
    st.sp.material.opacity = 0.55 * (1 - st.t);
  }
  if (planet) {
    const show = !iso;
    planet.visible = planetRing.visible = planetGlow.visible = show;
    const dir = new THREE.Vector3(0.3, 0.0, -0.95).normalize();
    planet.position.copy(camera.position).addScaledVector(dir, 3700);
    planetRing.position.copy(planet.position); planetGlow.position.copy(planet.position);
  }
  if (cloudSea) { cloudSea.position.x = camera.position.x; cloudSea.position.z = camera.position.z; }
}

// ------------------------------------------------------------------ landmarks
function buildLandmarks(rnd, parkCells, trees, palms, benches) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  const slab = (x, y, w, h, d, col, y0 = 0) => { const m = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: col, roughness: 0.9 })); m.scale.set(w, h, d); m.position.copy(W(x, y, y0)); m.receiveShadow = true; scene.add(m); return m; };
  // Central Park: one green across its blocks, gravel paths, a pond, dense trees, benches
  for (const [x, y] of parkCells) {
    slab(x, y, 30, 0.9, 30, '#3f6f3a');
    slab(x, y, 30, 0.95, 2.4, '#b8a888'); slab(x, y, 2.4, 0.95, 30, '#b8a888');
    if (!(x === 560 && y === 120)) for (let t = 0; t < 4; t++) { const a = rnd() * 6.28, r = 6 + rnd() * 6; trees.push([x + Math.cos(a) * r, y + Math.sin(a) * r, 0.8 + rnd() * 0.5]); }
    benches.push([x + 4, y + 2.4, 0], [x - 2.4, y - 5, Math.PI / 2]);
  }
  if (parkCells.length) {
    const [px, py] = [560, 120];
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(12.5, 12.5, 1.2, 28), new THREE.MeshStandardMaterial({ color: 0x9a907e, roughness: 0.9 })); rim.position.copy(W(px, py, 0.6)); scene.add(rim);
    const pond = new THREE.Mesh(new THREE.CylinderGeometry(11.2, 11.2, 1.25, 28), new THREE.MeshStandardMaterial({ color: 0x3b7d95, roughness: 0.15, metalness: 0.3 })); pond.position.copy(W(px, py, 0.65)); scene.add(pond); pondMat = pond.material;
    for (let k = 0; k < 6; k++) { const a = k * 1.047; trees.push([px + Math.cos(a) * 15, py + Math.sin(a) * 15, 0.7]); }
  }
  // The Plaza: paving, Kenney fountain, palms, benches
  if (plazaAt) {
    const [x, y] = plazaAt;
    slab(x, y, 30, 0.9, 30, '#8f857a');
    for (let i = -12; i <= 12; i += 4) slab(x + i, y, 0.25, 0.92, 30, '#7c7368');
    loadModel('pavement-fountain', (geo, mat) => { const f = new THREE.Mesh(geo, mat); f.scale.set(13, 10, 13); f.position.copy(W(x, y, 0.9)); f.receiveShadow = f.castShadow = true; scene.add(f); });
    palms.push([x - 12, y - 12, 0.85], [x + 12, y - 12, 0.85], [x - 12, y + 12, 0.85], [x + 12, y + 12, 0.85]);
    benches.push([x - 9, y, Math.PI / 2], [x + 9, y, Math.PI / 2], [x, y - 9, 0], [x, y + 9, 0]);
  }
  // Stone bridges over the rifts, one on every street that crosses them
  const stone = new THREE.MeshStandardMaterial({ color: 0xd9cfc0, roughness: 0.9 });
  const bridge = (cx, cy, alongX, span) => {
    const g = new THREE.Group(); g.position.copy(W(cx, cy, 0));
    const deck = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0x4a4752, roughness: 0.9 })); deck.scale.set(12.4, 1.2, span); deck.position.y = -0.6; g.add(deck);
    const keel = new THREE.Mesh(BOX, stone); keel.scale.set(12.6, 3.2, span); keel.position.y = -3.6; g.add(keel);
    for (const s2 of [-6.4, 6.4]) {
      const rail = new THREE.Mesh(BOX, stone); rail.scale.set(0.6, 1.6, span); rail.position.set(s2, 0, 0); g.add(rail);
      for (const k of [-span / 2, span / 2]) { const post = new THREE.Mesh(BOX, stone); post.scale.set(1.2, 3.4, 1.2); post.position.set(s2, 0, k); g.add(post); }
    }
    g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
    if (alongX) g.rotation.y = Math.PI / 2;
    scene.add(g);
  };
  for (let x = 340; x <= 980; x += GRID) bridge(x, 480, false, 34);
  for (let y = OFF; y <= 460; y += GRID) bridge(756, y, true, 26);
}
function buildLandmarkLabels() {
  for (const l of LANDMARKS) {
    const el = document.createElement('div'); el.className = 'lm'; el.textContent = l.name;
    $('#labels').appendChild(el); landmarkEls.push({ el, at: W(l.x, l.y, l.h ?? 4) });
  }
}
const landmarkEls = [];
let pondMat = null;

// Kenney City Kit models (MIT): one mesh each, baked so the tile sits on y=0, centred
const gltfCache = {};
function loadModel(name, cb) {
  if (gltfCache[name]) return gltfCache[name].then((r) => r && cb(r.geo, r.mat));
  gltfCache[name] = new Promise((resolve) => {
    new GLTFLoader().load(`/models/${name}.glb`, (g) => {
      let mesh = null; g.scene.updateMatrixWorld(true); g.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
      if (!mesh) return resolve(null);
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox(); const bb = geo.boundingBox;
      geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
      const s0 = 1 / Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z); geo.scale(s0, s0, s0);  // unit footprint
      const mat = mesh.material; if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
      resolve({ geo, mat });
    }, undefined, () => resolve(null));
  });
  gltfCache[name].then((r) => r && cb(r.geo, r.mat));
}
function loadHouses(houses) {
  const names = ['building-small-a', 'building-small-b', 'building-small-c', 'building-small-d'];
  names.forEach((name, v) => {
    const list = houses.filter((h) => h[3] === v); if (!list.length) return;
    loadModel(name, (geo, mat) => {
      const m = new THREE.InstancedMesh(geo, mat, list.length), m4 = new THREE.Matrix4(), qq = new THREE.Quaternion();
      list.forEach(([x, y, size, , rot], i) => { qq.setFromAxisAngle(UP, rot * Math.PI / 2); m4.compose(W(x, y, 0.8), qq, new THREE.Vector3(size, size * 0.95, size)); m.setMatrixAt(i, m4); });
      m.castShadow = m.receiveShadow = true; scene.add(m);
      // porch lights so the hillside isn't dark at night
      const pl = new THREE.Points(new THREE.BufferGeometry().setFromPoints(list.map(([x, y, size]) => W(x, y + size * 0.52, 3.2))),
        new THREE.PointsMaterial({ map: GLOW, size: 6, color: 0xffc27a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      scene.add(pl); porchLights.push(pl.material);
    });
  });
}
const porchLights = [];

// Traffic lights on the busier districts' junctions, cycling red/green by axis
let tlPoints = null, tlPhase = [];
function buildTrafficLights(rnd) {
  const spots = [];
  for (let x = OFF + GRID; x < XMAX; x += GRID) for (let y = OFF + GRID; y < YMAX; y += GRID) {
    const d = districtAt(x + 20, y + 20); if (!d || !['oldtown', 'neon', 'flats', 'harbour'].includes(d.id)) continue;
    if (inRift(x - 6.6, y - 6.6) || inRift(x - 0.8, y - 5.9)) continue;
    spots.push([x, y]);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  const pole = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ color: 0x2a2a2e }), spots.length * 3);
  const pts = [];
  spots.forEach(([x, y], i) => {
    m4.compose(W(x - 6.6, y - 6.6, 0), q, new THREE.Vector3(0.45, 8.5, 0.45)); pole.setMatrixAt(i * 3, m4);
    m4.compose(W(x - 3.6, y - 6.6, 8.2), q, new THREE.Vector3(6, 0.35, 0.35)); pole.setMatrixAt(i * 3 + 1, m4);
    m4.compose(W(x - 0.8, y - 6.6, 6.6), q, new THREE.Vector3(0.9, 1.8, 0.9)); pole.setMatrixAt(i * 3 + 2, m4);
    pts.push(W(x - 0.8, y - 5.9, 7.1), W(x - 6.0, y - 6.6, 5.6));
    tlPhase.push(rnd() * 14);
  });
  scene.add(pole);
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pts.length * 3), 3));
  tlPoints = new THREE.Points(geo, new THREE.PointsMaterial({ map: GLOW, size: 5, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(tlPoints);
}
function updateTrafficLights(t) {
  if (!tlPoints) return;
  const col = tlPoints.geometry.attributes.color;
  for (let i = 0; i < tlPhase.length; i++) {
    const ns = Math.floor((t + tlPhase[i]) / 7) % 2 === 0;
    const a = ns ? [0.2, 1.4, 0.4] : [1.5, 0.15, 0.1], b = ns ? [1.5, 0.15, 0.1] : [0.2, 1.4, 0.4];
    col.setXYZ(i * 2, ...a); col.setXYZ(i * 2 + 1, ...b);
  }
  col.needsUpdate = true;
}

// Asphalt with lane markings and zebra crossings, painted once onto the ground.
function roadTexture() {
  const PX = LITE ? 2.2 : 3.2, Wd = Math.round(970 * PX), Ht = Math.round(672 * PX);
  const c = document.createElement('canvas'); c.width = Wd; c.height = Ht;
  const g = c.getContext('2d');
  const X = (x) => (x - 15) * PX, Y = (y) => (y - 14) * PX;
  g.fillStyle = '#2c2b30'; g.fillRect(0, 0, Wd, Ht);
  const r = mulberry32(5);
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(255,255,255,${r() * 0.035})`; g.fillRect(r() * Wd, r() * Ht, 2 + r() * 6, 2 + r() * 6); }
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(0,0,0,${0.08 + r() * 0.1})`; g.beginPath(); g.ellipse(r() * Wd, r() * Ht, 6 + r() * 26, 4 + r() * 14, r() * 3, 0, 7); g.fill(); }
  const xs = [], ys = [];
  for (let x = OFF; x <= XMAX; x += GRID) xs.push(x);
  for (let y = OFF; y <= YMAX; y += GRID) ys.push(y);
  g.fillStyle = 'rgba(232,224,205,0.55)';
  // centre dashes, skipping the intersections
  for (const x of xs) for (let y = 14; y < 686; y += 6) { if (ys.some((yy) => Math.abs(yy - y) < 8)) continue; g.fillRect(X(x) - 0.22 * PX, Y(y), 0.44 * PX, 3 * PX); }
  for (const y of ys) for (let x = 15; x < 985; x += 6) { if (xs.some((xx) => Math.abs(xx - x) < 8)) continue; g.fillRect(X(x), Y(y) - 0.22 * PX, 3 * PX, 0.44 * PX); }
  // zebra crossings on every approach
  g.fillStyle = 'rgba(240,234,220,0.7)';
  for (const x of xs) for (const y of ys) {
    for (const sgn of [-1, 1]) {
      for (let k = -4; k <= 4; k += 1.6) {
        g.fillRect(X(x + k) - 0.4 * PX, Y(y + sgn * 7) - 1.2 * PX, 0.8 * PX, 2.4 * PX);
        g.fillRect(X(x + sgn * 7) - 1.2 * PX, Y(y + k) - 0.4 * PX, 2.4 * PX, 0.8 * PX);
      }
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// ------------------------------------------------------------------ venues
const OWN = { city: '#ff8a3d', resident: '#e8607a', agent: '#4fd6c4' };
const ownerKind = (v) => (!v.owner ? 'city' : v.ownerOutside ? 'agent' : 'resident');
function signTexture(v, prev) {
  const c = prev?.image || document.createElement('canvas'); c.width = 512; c.height = 168;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 168);
  const col = OWN[ownerKind(v)];
  g.fillStyle = 'rgba(14,11,16,0.86)'; roundRect(g, 4, 4, 504, 160, 18); g.fill();
  g.lineWidth = 6; g.strokeStyle = col; roundRect(g, 4, 4, 504, 160, 18); g.stroke();
  g.fillStyle = '#f4ebe0'; g.font = '600 46px Inter, system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText(v.name, 256, 66, 480);
  g.font = '500 28px "JetBrains Mono", ui-monospace, monospace'; g.fillStyle = col;
  const sub = v.isVenue ? `${v.type.toUpperCase()} · DOOR $${v.price} · ${v.visitsToday} IN TODAY` : { docks: 'DOCKS · WORKPLACE', office: 'OFFICES · WORKPLACE', yard: 'FREIGHT · WORKPLACE' }[v.type];
  g.fillText(sub, 256, 112, 480);
  if (v.forSale) { g.fillStyle = '#ffd36e'; g.font = '700 24px "JetBrains Mono", monospace'; g.fillText(`FOR SALE · $${v.salePrice}`, 256, 148); }
  else if (v.owner) { g.fillStyle = '#9a8f99'; g.font = '400 22px Inter, sans-serif'; g.fillText(`owned by ${v.owner}`, 256, 148, 470); }
  if (prev) { prev.needsUpdate = true; return prev; }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const neonMats = [];
function neonTexture(text, col) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,8,14,0.82)'; roundRect(g, 8, 8, 1008, 240, 26); g.fill();
  g.lineWidth = 6; g.strokeStyle = col; g.shadowColor = col; g.shadowBlur = 24; roundRect(g, 14, 14, 996, 228, 22); g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 130; g.font = `700 ${size}px "Inter", system-ui, sans-serif`;
  while (g.measureText(text.toUpperCase()).width > 900 && size > 40) { size -= 6; g.font = `700 ${size}px "Inter", system-ui, sans-serif`; }
  for (const [blur, alpha] of [[40, 0.9], [18, 1], [0, 1]]) { g.shadowBlur = blur; g.fillStyle = alpha === 1 && blur === 0 ? '#fff6ea' : col; g.fillText(text.toUpperCase(), 512, 132); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

function buildVenue(v, rnd) {
  const grp = new THREE.Group();
  grp.position.copy(W(v.x, v.y, 0.8));
  const std = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...opts });
  const add = (mat, w, h, d, x = 0, y = 0, z = 0, win = false) => {
    const m = new THREE.Mesh(BOX, win ? windowed(mat) : mat);
    m.scale.set(w, h, d); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; m.userData.vid = v.id;
    grp.add(m); venueMeshes.push(m); return m;
  };
  const accent = new THREE.MeshStandardMaterial({ color: 0xff8a3d, emissive: 0xff8a3d, emissiveIntensity: 0.2, roughness: 0.5 });
  let top = 20;
  switch (v.type) {
    case 'bar': {
      add(std(0x5a2f2a), 24, 16, 20, 0, 0, 0, true); add(accent, 24, 1, 5, 0, 5, 12);
      for (const tx of [-8, 0, 8]) { const tb = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.3, 10), std(0x3b2a20)); tb.position.set(tx, 2.6, 17); tb.castShadow = true; grp.add(tb); const lg = new THREE.Mesh(BOX, std(0x2a2020)); lg.scale.set(0.3, 2.5, 0.3); lg.position.set(tx, 0, 17); grp.add(lg); }
      const garland = new THREE.Points(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 16 }, (_, i) => { const t = i / 15; return new THREE.Vector3(-12 + t * 24, 8 - Math.sin(t * Math.PI) * 1.6, 13); })),
        new THREE.PointsMaterial({ map: GLOW, size: 5, color: 0xffcf8a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      grp.add(garland); nightGlows.push(garland.material);
      top = 17; break;
    }
    case 'gym': add(std(0x4f7488, { metalness: 0.1, roughness: 0.35 }), 30, 11, 22, 0, 0, 0, true); add(accent, 30, 1.2, 1, 0, 9.5, 11.2); top = 12; break;
    case 'casino': {
      add(std(0x3a2f4a), 30, 34, 26, 0, 0, 0, true);
      add(new THREE.MeshStandardMaterial({ color: 0xffc94a, emissive: 0xffb02e, emissiveIntensity: 0.7, metalness: 0.6, roughness: 0.3 }), 32, 3, 28, 0, 34);
      add(accent, 30, 2, 6, 0, 6, 15); top = 38;
      for (const sx of [-11, 11]) {
        const bm = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 11, 260, 18, 1, true).translate(0, 130, 0),
          new THREE.MeshBasicMaterial({ color: 0xfff1cc, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
        bm.position.set(sx, 37, 0); grp.add(bm); beams.push({ m: bm, ph: sx > 0 ? 0 : 2.1 });
      }
      break;
    }
    case 'market': {
      const cols = [0xd8584a, 0xe2a63c, 0x4a9fd8, 0x5ab36a, 0xc75ad8, 0xe2d23c];
      for (let i = 0; i < 6; i++) {
        const t = new THREE.Mesh(new THREE.ConeGeometry(6.5, 5, 4).translate(0, 2.5, 0), std(cols[i]));
        t.rotation.y = Math.PI / 4; t.position.set(-10 + (i % 3) * 10, 5, -6 + Math.floor(i / 3) * 12); t.castShadow = true; t.userData.vid = v.id; grp.add(t); venueMeshes.push(t);
        add(std(0x3b2a20), 0.6, 5, 0.6, -10 + (i % 3) * 10, 0, -6 + Math.floor(i / 3) * 12);
      }
      const lanterns = new THREE.Points(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 24 }, (_, i) => new THREE.Vector3(-15 + (i % 12) * 2.7, 8.5 + Math.sin(i) * 0.6, i < 12 ? -12 : 13))),
        new THREE.PointsMaterial({ map: GLOW, size: 7, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffd08a }));
      grp.add(lanterns); nightGlows.push(lanterns.material); top = 12; break;
    }
    case 'diner': add(std(0xd9cdb6), 24, 9, 18, 0, 0, 0, true); add(new THREE.MeshStandardMaterial({ color: 0xd13a3a, emissive: 0xd13a3a, emissiveIntensity: 0.3 }), 24.4, 1.6, 18.4, 0, 9); top = 11; break;
    case 'office': add(std(0x5d6f86, { metalness: 0.15, roughness: 0.45 }), 24, 96, 24, 0, 0, 0, true); add(std(0x76869a), 18, 10, 18, 0, 96); top = 108; break;
    case 'docks': {
      add(std(0x5a5f66), 34, 6, 20, 0, 0, 0, true);
      const yel = std(0xe2b13c); add(yel, 2, 42, 2, -10, 0, 18); add(yel, 2, 42, 2, -4, 0, 18); add(yel, 36, 2.5, 3, 6, 40, 18); add(std(0x4a4f56), 3, 10, 3, 22, 30, 18);
      const cc = [0xb8483a, 0x3a7cb8, 0x4f9a5a, 0xc9893a];
      for (let i = 0; i < 6; i++) add(std(cc[i % 4]), 12, 5, 5, 8, 6 + Math.floor(i / 3) * 5, -8 + (i % 3) * 5.5);
      top = 46; break;
    }
    case 'yard': {
      const cc = [0xb8483a, 0x3a7cb8, 0x4f9a5a, 0xc9893a, 0x7a5ab8];
      for (let i = 0; i < 12; i++) add(std(cc[Math.floor(rnd() * 5)]), 12, 5, 5.5, -9 + (i % 2) * 14, Math.floor(i / 6) * 5, -12 + (Math.floor(i / 2) % 3) * 7.5);
      add(std(0x4a4f56), 8, 12, 8, 14, 0, 12, true); top = 14; break;
    }
  }
  // a neon sign on the building itself
  const NEON = { bar: ['#ff4fa3', 20, 12.5, 10.4], gym: ['#3df2ff', 22, 14.2, 11.1], casino: ['#ffd24a', 28, 27, 13.4], market: ['#ffb04a', 22, 13.5, 16], diner: ['#ff5a4a', 20, 12.4, 8], office: ['#9fd4ff', 20, 86, 12.4], docks: ['#ffe08a', 26, 9, 10.4], yard: ['#9dff8a', 18, 16.5, 4.2] }[v.type];
  if (NEON) {
    const [col, w, y, z] = NEON;
    const sm = new THREE.MeshBasicMaterial({ map: neonTexture(v.name, col), transparent: true, toneMapped: false, alphaTest: 0.04, side: THREE.DoubleSide });
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), sm); sg.position.set(0, y, z); sg.userData.vid = v.id; grp.add(sg); venueMeshes.push(sg); neonMats.push(sm);
    if (v.type === 'market') { for (const px of [-w / 2, w / 2]) { const post = new THREE.Mesh(BOX, std(0x2a2420)); post.scale.set(0.6, y + 2, 0.6); post.position.set(px, 0, z - 0.3); grp.add(post); } }
    if (v.type === 'gym' || v.type === 'diner' || v.type === 'yard') { const fr = new THREE.Mesh(BOX, std(0x222026)); fr.scale.set(w + 0.6, 0.6, 0.6); fr.position.set(0, y - w / 8 - 0.6, z - 0.35); grp.add(fr); }
  }
  scene.add(grp);
  // a crisp HTML label that follows the building on screen
  const el = document.createElement('button'); el.className = 'vl'; el.dataset.vid = v.id;
  el.addEventListener('click', (e) => { e.stopPropagation(); selectVenue(v.id); });
  $('#labels').appendChild(el);
  const sign = { el, at: W(v.x, v.y, top + 8) };
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  glow.scale.set(90, 60, 1); glow.position.copy(W(v.x, v.y + 14, 8));
  if (v.isVenue) scene.add(glow);
  venueObjs[v.id] = { v, sign, glow, key: '' };
}
function updateVenues() {
  for (const v of S.venues) {
    const o = venueObjs[v.id]; if (!o) continue;
    const key = [v.price, v.visitsToday, v.owner, v.forSale, v.salePrice].join('|');
    if (key !== o.key) {
      o.key = key; o.v = v;
      const kind = ownerKind(v);
      o.sign.el.className = `vl ${kind}${v.forSale ? ' sale' : ''}`;
      o.sign.el.innerHTML = `<b>${esc(v.name)}</b><span>${v.isVenue ? `${esc(v.type)} · $${v.price} · ${v.visitsToday} in` : 'workplace'}${v.forSale ? ` · <em>for sale $${v.salePrice}</em>` : ''}</span>`;
    }
  }
}

// ------------------------------------------------------------------ the billboard
function buildBillboard() {
  const at = [756, 238];
  const frame = new THREE.Group(); frame.position.copy(W(at[0], at[1], 0.8));
  { const rock = rockUnder(746, 226, 766, 250, 60, mulberry32(3)); scene.add(rock); const top = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0x6f9a52 })); top.scale.set(20, 1.6, 24); top.position.copy(W(756, 238, -0.8)); scene.add(top); }
  const leg = new THREE.MeshStandardMaterial({ color: 0x2b2b30 });
  for (const x of [-12, 12]) { const l = new THREE.Mesh(BOX, leg); l.scale.set(1.2, 26, 1.2); l.position.x = x; l.castShadow = true; frame.add(l); }
  billboardCanvas = document.createElement('canvas'); billboardCanvas.width = 1024; billboardCanvas.height = 420;
  billboardTex = new THREE.CanvasTexture(billboardCanvas); billboardTex.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(36, 14.8), new THREE.MeshBasicMaterial({ map: billboardTex, toneMapped: false }));
  face.position.set(0, 33, 0.7); frame.add(face);
  const back = new THREE.Mesh(BOX, leg); back.scale.set(37.5, 16, 1); back.position.y = 25; back.castShadow = true; frame.add(back);
  scene.add(frame);
  drawBillboard();
}
let lastBillboard = '';
function drawBillboard() {
  const b = S.billboard, key = JSON.stringify(b) + S.token.ticker;
  if (!billboardCanvas || key === lastBillboard) return;
  lastBillboard = key;
  const g = billboardCanvas.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 1024, 420); grd.addColorStop(0, '#1b1020'); grd.addColorStop(1, '#2a1410');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 420);
  g.strokeStyle = '#ff8a3d'; g.lineWidth = 10; g.strokeRect(5, 5, 1014, 410);
  g.textAlign = 'center';
  if (b) {
    g.fillStyle = '#f4ebe0'; g.font = 'italic 400 76px "Instrument Serif", Georgia, serif'; wrap(g, `“${b.text}”`, 512, 170, 940, 84);
    g.fillStyle = '#4fd6c4'; g.font = '600 34px "JetBrains Mono", monospace'; g.fillText(`☼ ${b.name}`, 512, 360);
  } else {
    g.fillStyle = '#f4ebe0'; g.font = 'italic 400 92px "Instrument Serif", Georgia, serif'; g.fillText('Your words here.', 512, 190);
    g.fillStyle = '#ff8a3d'; g.font = '600 34px "JetBrains Mono", monospace'; g.fillText(`ONE CITY DAY · BURN ${S.token.ticker}`, 512, 290);
    g.fillStyle = '#9a8f99'; g.font = '400 28px Inter, sans-serif'; g.fillText('wallet-keyed residents only', 512, 345);
  }
  billboardTex.needsUpdate = true;
}
function wrap(g, s, x, y, max, lh) {
  const words = s.split(' '); let line = '', yy = y;
  for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > max && line) { g.fillText(line, x, yy); line = w; yy += lh; } else line = t; }
  g.fillText(line, x, yy);
}

// ------------------------------------------------------------------ boats
function buildBoats(rnd) {
  // airships moored at the sky docks, bobbing gently
  for (const [x, y, rot] of [[-30, 420, 0], [-38, 500, 0], [-28, 590, 0], [800, 735, Math.PI / 2], [870, 730, Math.PI / 2], [140, 735, Math.PI / 2]]) {
    const g = airshipMesh(0.45, rnd); g.position.copy(W(x, y, 10)); g.rotation.y = rot; scene.add(g);
    boats.push({ g, ph: rnd() * 6.28, y0: 10 });
  }
}

// ------------------------------------------------------------------ traffic
const cars = [];
let carMesh = null, carLights = null, cabinMesh = null, tailLights = null;
function buildCars(rnd) {
  const N = LITE ? 24 : 48;
  const cols = ['#c9c4bd', '#2b2f36', '#8a2f2f', '#2f4f8a', '#d9b23c', '#e9e4dc', '#3f6b4f'];
  carMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(5.4, 1.5, 2.8).translate(0, 1.2, 0), new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.5 }), N);
  carMesh.castShadow = true;
  cabinMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.9, 1.15, 2.5).translate(-0.3, 2.5, 0), new THREE.MeshStandardMaterial({ color: 0x1c2430, roughness: 0.15, metalness: 0.7 }), N);
  cabinMesh.castShadow = true; scene.add(cabinMesh);
  tailLights = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3)),
    new THREE.PointsMaterial({ map: GLOW, size: 6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xff2a2a, opacity: 0 }));
  scene.add(tailLights);
  const c3 = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const horiz = rnd() < 0.55;
    const line = horiz ? OFF + GRID * Math.floor(rnd() * 17) : OFF + GRID * Math.floor(rnd() * 25);
    const dir = rnd() < 0.5 ? 1 : -1;
    cars.push({ horiz, line, dir, s: rnd() * 1000, v: 22 + rnd() * 22 });
    carMesh.setColorAt(i, c3.set(cols[Math.floor(rnd() * cols.length)]));
  }
  scene.add(carMesh);
  carLights = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3)),
    new THREE.PointsMaterial({ map: GLOW, size: 10, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xfff1d0, opacity: 0 }));
  scene.add(carLights);
}
const dummy = new THREE.Object3D();
function updateCars(dt) {
  if (!carMesh) return;
  const pos = carLights.geometry.attributes.position, tpos = tailLights.geometry.attributes.position;
  cars.forEach((c, i) => {
    const span = c.horiz ? XMAX - OFF : YMAX - OFF;
    c.s = (c.s + c.v * dt) % span;
    const t = c.dir > 0 ? c.s : span - c.s;
    const lane = 3 * c.dir;
    const x = c.horiz ? OFF + t : c.line + lane, y = c.horiz ? c.line - lane : OFF + t;
    dummy.position.copy(W(x, y, 0)); dummy.rotation.set(0, c.horiz ? (c.dir > 0 ? 0 : Math.PI) : (c.dir > 0 ? -Math.PI / 2 : Math.PI / 2), 0); dummy.scale.set(1, 1, 1);
    dummy.updateMatrix(); carMesh.setMatrixAt(i, dummy.matrix); cabinMesh.setMatrixAt(i, dummy.matrix);
    const fx = c.horiz ? x + 3 * c.dir : x, fy = c.horiz ? y : y + 3 * c.dir;
    const p = W(fx, fy, 1.5); pos.setXYZ(i, p.x, p.y, p.z);
    const bx = c.horiz ? x - 2.9 * c.dir : x, by = c.horiz ? y : y - 2.9 * c.dir;
    const tp = W(bx, by, 1.5); tpos.setXYZ(i, tp.x, tp.y, tp.z);
  });
  carMesh.instanceMatrix.needsUpdate = true; cabinMesh.instanceMatrix.needsUpdate = true; pos.needsUpdate = true; tpos.needsUpdate = true;
}

// ------------------------------------------------------------------ residents
let people = [];          // [{r, route cache, ...}]
let natMesh = null, agMesh = null, agMark = null, headMesh = null;
const SKIN = ['#f1c7a5', '#e0ac85', '#c48b62', '#9a6643', '#6e4630', '#4e3122'].map((c) => new THREE.Color(c));
const venueById = () => Object.fromEntries(S.venues.map((v) => [v.id, v]));
function sidewalk(x, y, o) {
  const sx = snapX(x), sy = snapY(y);
  return Math.abs(x - sx) < Math.abs(y - sy) ? [sx + o, y] : [x, sy + o];
}
function spotFor(vid, id, V) {
  const v = vid && V[vid]; if (!v) return null;
  const h = hash(id + vid);
  return [v.x - 13 + ((h & 255) / 255) * 26, v.y + 16 + (((h >> 8) & 255) / 255) * 9];
}
function routeOf(P, Q, o) {
  const a = [snapX(P[0]) + o, snapY(P[1]) + o], b = [snapX(Q[0]) + o, snapY(Q[1]) + o];
  const pts = [P, a, [b[0], a[1]], b, Q];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum.at(-1) || 1 };
}
function along(rt, t) {
  const d = clamp(t, 0, 1) * rt.len;
  for (let i = 1; i < rt.pts.length; i++) {
    if (d <= rt.cum[i] || i === rt.pts.length - 1) {
      const seg = rt.cum[i] - rt.cum[i - 1] || 1, k = clamp((d - rt.cum[i - 1]) / seg, 0, 1);
      return [rt.pts[i - 1][0] + (rt.pts[i][0] - rt.pts[i - 1][0]) * k, rt.pts[i - 1][1] + (rt.pts[i][1] - rt.pts[i - 1][1]) * k];
    }
  }
  return rt.pts.at(-1);
}
function preparePeople() {
  const V = venueById();
  const old = Object.fromEntries(people.map((p) => [p.r[0], p]));
  people = S.residents.map((r) => {
    const [id, , hx, hy, aft, night] = r;
    const key = `${aft}|${night}`;
    const p = old[id];
    if (p && p.key === key) { p.r = r; return p; }
    const h = hash(id), o = (h & 1 ? 4.6 : -4.6);
    const H = sidewalk(hx, hy, o);
    const A = spotFor(aft, id, V), N = spotFor(night, id, V);
    return {
      r, key, H, A, N, stagger: ((h >> 16) & 255) / 255 * 0.6, phase: (h & 1023) / 1023 * 6.28,
      color: new THREE.Color().setHSL(((h >> 4) & 255) / 255, 0.5, 0.42 + ((h >> 12) & 15) / 60), skin: SKIN[(h >>> 20) % SKIN.length],
      rHA: A && routeOf(H, A, o), rAH: A && routeOf(A, H, o), rHN: N && routeOf(H, N, o), rNH: N && routeOf(N, H, o),
      aftVid: aft, nightVid: night, pos: [H[0], H[1]], vis: false, walk: false, state: 'home',
    };
  });
  const nats = people.filter((p) => !p.r[6]), ags = people.filter((p) => p.r[6]);
  if (!natMesh || natMesh.count !== nats.length || !agMesh || agMesh.userData.n !== ags.length || headMesh.count !== people.length) {
    for (const m of [natMesh, agMesh, agMark, headMesh]) if (m) { scene.remove(m); m.dispose(); }
    const body = new THREE.CapsuleGeometry(1.15, 2.2, 4, 8).translate(0, 2.25, 0);
    headMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.95, 10, 8), new THREE.MeshStandardMaterial({ roughness: 0.7 }), Math.max(people.length, 1));
    headMesh.castShadow = true;
    natMesh = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 0.6 }), Math.max(nats.length, 1));
    natMesh.castShadow = true;
    agMesh = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ color: 0x4fd6c4, emissive: 0x2bb5a5, emissiveIntensity: 0.9, roughness: 0.4 }), Math.max(ags.length, 1));
    agMesh.userData.n = ags.length; agMesh.castShadow = true;
    agMark = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.25, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.6, 0.55), toneMapped: false }), Math.max(ags.length, 1));
    for (const m of [natMesh, agMesh, agMark, headMesh]) { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
    if (!ags.length) { agMesh.count = 0; agMark.count = 0; }
  }
  nats.forEach((p, i) => { p.mesh = natMesh; p.i = i; natMesh.setColorAt(i, p.color); });
  ags.forEach((p, i) => { p.mesh = agMesh; p.i = i; });
  people.forEach((p, i) => { p.gi = i; headMesh.setColorAt(i, p.skin); });
  if (natMesh.instanceColor) natMesh.instanceColor.needsUpdate = true;
  if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;
}
function schedule(p, h) {
  const s = p.stagger;
  const at = (vid, spot, label) => (spot ? { pos: spot, vis: true, walk: false, state: label, vid } : { pos: p.H, vis: false, walk: false, state: 'home' });
  const walk = (rt, t, to) => (rt ? { pos: along(rt, t), vis: true, walk: true, state: 'walking', vid: to } : { pos: p.H, vis: false, walk: false, state: 'home' });
  if (h < 8 + s) return { pos: p.H, vis: false, walk: false, state: 'home' };
  if (h < 9 + s) return walk(p.rHA, h - 8 - s, p.aftVid);
  if (h < 16 + s) return at(p.aftVid, p.A, 'aft');
  if (h < 17 + s) return walk(p.rAH, h - 16 - s, null);
  if (h < 18 + s) return { pos: p.H, vis: false, walk: false, state: 'home' };
  if (h < 19 + s) return walk(p.rHN, h - 18 - s, p.nightVid);
  if (h < 23) return at(p.nightVid, p.N, 'night');
  if (h < 23.9) return walk(p.rNH, (h - 23) / 0.9, null);
  return { pos: p.H, vis: false, walk: false, state: 'home' };
}
function updatePeople(h, time) {
  if (!natMesh) return;
  let ai = 0;
  for (const p of people) {
    const st = schedule(p, h);
    Object.assign(p, st);
    const bob = st.walk ? Math.abs(Math.sin(time * 9 + p.phase)) * 0.45 : 0;
    const w = W(st.pos[0], st.pos[1], 0.8 + bob);
    dummy.position.copy(w); dummy.rotation.set(0, 0, 0);
    const sc = st.vis ? (p.r[6] ? 1.25 : 1) : 0;
    dummy.scale.set(sc, sc, sc); dummy.updateMatrix();
    p.mesh.setMatrixAt(p.i, dummy.matrix);
    dummy.position.y += 5.35 * sc; dummy.updateMatrix(); headMesh.setMatrixAt(p.gi, dummy.matrix);
    p.world = w;
    if (p.r[6]) {
      dummy.position.y = 0.8 + 9.5 + Math.sin(time * 2 + p.phase) * 0.5; dummy.rotation.y = time * 1.5; dummy.updateMatrix();
      agMark.setMatrixAt(ai++, dummy.matrix);
    }
  }
  natMesh.instanceMatrix.needsUpdate = true; agMesh.instanceMatrix.needsUpdate = true; agMark.instanceMatrix.needsUpdate = true; headMesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------ sky & light
const SKY_NIGHT = new THREE.Color(0x231a4a), SKY_DAY = new THREE.Color(0xeccbd6), DUSK = new THREE.Color(0xff9478);
const TOP_NIGHT = new THREE.Color(0x0d0a26), TOP_DAY = new THREE.Color(0x4a82d0), TOP_DUSK = new THREE.Color(0x5b4ea6);
const SUN_DAY = new THREE.Color(0xfff2df), SUN_DUSK = new THREE.Color(0xff9a5c), MOON = new THREE.Color(0x8fa6ff);
const skyC = new THREE.Color();
const WATER_DAY = new THREE.Color(0x3b6a88), WATER_NIGHT = new THREE.Color(0x0b1622), HEMI_DAY = new THREE.Color(0xd6e6ff);
function updateSky(h) {
  const el = Math.sin(((h - 6) / 14) * Math.PI);          // sun up 06:00, down 20:00
  const day = smooth(-0.1, 0.35, el);
  const dusk = Math.exp(-Math.pow((el - 0.08) / 0.2, 2)) * (h > 12 ? 1 : 0.6);
  skyC.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(DUSK, dusk * 0.5);
  scene.background = skyC; scene.fog.color.copy(skyC);
  skyU.horizon.value.copy(skyC).lerp(DUSK, dusk * 0.35);
  skyU.top.value.copy(TOP_NIGHT).lerp(TOP_DAY, day).lerp(TOP_DUSK, dusk * 0.5);
  skyTint.light.set(0xfff1ea).lerp(new THREE.Color(0xffc9b8), dusk * 0.6).lerp(new THREE.Color(0x5c4f8f), 1 - day);
  skyTint.shadow.set(0xb3a7d6).lerp(new THREE.Color(0xd08aa0), dusk * 0.4).lerp(new THREE.Color(0x1d1640), 1 - day);
  if (cloudSea) cloudSea.material.uniforms.uHaze.value.copy(skyC);
  for (const m of puffMats) m.color.copy(skyTint.light).lerp(skyTint.shadow, 0.25);
  glowU.value = 0.12 + (1 - day) * 0.75 + dusk * 0.2;
  if (waterMat) waterMat.color.copy(WATER_NIGHT).lerp(WATER_DAY, day).lerp(DUSK, dusk * 0.15);
  const az = ((h - 6) / 14) * Math.PI;
  skyU.sunDir.value.set(Math.cos(az), Math.max(el, -0.2) + 0.02, -0.45).normalize();
  skyU.sunAmt.value = smooth(-0.08, 0.05, el);
  skyU.sunCol.value.copy(SUN_DUSK).lerp(SUN_DAY, smooth(0.05, 0.5, el));
  if (el > -0.04) { sun.position.set(Math.cos(az) * 900, 140 + Math.max(el, 0) * 900, -420); sun.color.copy(SUN_DUSK).lerp(SUN_DAY, smooth(0.05, 0.5, el)); sun.intensity = 0.6 + 2.6 * day; }
  else { sun.position.set(-500, 800, 380); sun.color.copy(MOON); sun.intensity = 0.9; }
  hemi.intensity = 0.7 + 0.9 * day;
  hemi.color.copy(MOON).lerp(HEMI_DAY, day);
  const night = clamp(1 - day * 1.1 + dusk * 0.45, 0, 1);
  nightU.value = night;
  renderer.toneMappingExposure = 1.05 + 0.2 * (1 - day);
  if (lampPoints) lampPoints.material.opacity = night * 0.9;
  stars.material.opacity = smooth(0.5, 0.95, night);
  moon.material.opacity = smooth(0.5, 0.95, night) * 0.95;
  for (const m of nightGlows) m.opacity = 0.2 + night * 0.8;
  for (const m of neonMats) m.color.setScalar(0.85 + night * 1.5);
  for (const m of porchLights) m.opacity = night;
  if (canalMat) canalMat.color.copy(WATER_NIGHT).lerp(new THREE.Color(0x2d6a80), day);
  if (pondMat) pondMat.color.copy(WATER_NIGHT).lerp(new THREE.Color(0x4a9ab0), day);
  for (const b of beams) b.m.material.opacity = night * 0.07;
  if (tailLights) tailLights.material.opacity = 0.25 + night * 0.75;
  if (bloom) { bloom.strength = 0.06 + night * 0.38; bloom.threshold = 3.0 - night * 1.75; bloom.radius = 0.32; }
  if (carLights) carLights.material.opacity = night;
  for (const o of Object.values(venueObjs)) o.glow.material.opacity = night * 0.55;
  return { el, day, night };
}

// ------------------------------------------------------------------ HUD
const PHASE = (h) => (h < 6 ? 'The city sleeps' : h < 9 ? 'Morning: everyone heads out' : h < 14 ? 'The afternoon shift' : h < 17 ? 'Afternoon spending lands' : h < 19 ? 'Wages in, heading out' : h < 21 ? 'Sunset: bars filling up' : h < 23 ? 'Night: the tables are dealing' : 'Last orders, heading home');
function renderHUD() {
  $('#pop').textContent = S.residents.length;
  $('#agents').textContent = S.residents.filter((r) => r[6]).length;
  $('#cash').textContent = money(S.cashInCity);
  $('#treas').textContent = money(S.treasury);
  const log = S.agentLog || [];
  $('#livecount').textContent = log.length ? `${S.residents.filter((r) => r[6]).length} in the city` : '';
  if (log.length) $('#livebody').innerHTML = log.slice(0, 10).map((e) => {
    const d = new Date(e.t), tm = d.toTimeString().slice(0, 8);
    return `<div class="al"><time>${tm}</time><span><span class="n" data-who="${esc(e.id)}">${esc(e.name)} ☼</span> ${esc(e.op)} <span class="${e.ok ? 'ok' : 'no'}">${e.ok ? 'done' : 'refused'}</span></span>${!e.ok && e.reason ? `<span class="why">${esc(e.reason)}</span>` : ''}</div>`;
  }).join('');
  const feed = $('#feed');
  feed.innerHTML = S.chronicle.slice(0, LITE ? 3 : 6).map((c) => `<div class="fl ${c.who ? 'click' : ''}" ${c.who ? `data-who="${esc(c.who)}"` : ''}><span>day ${c.day}</span>${esc(c.text)}</div>`).join('');
}
document.addEventListener('click', (e) => { const f = e.target.closest('[data-who]'); if (f) selectResident(f.dataset.who); });
$('#livehead').onclick = () => $('#live').classList.toggle('closed');

// chips
function renderChips() {
  const el = $('#chips');
  el.innerHTML = `<button data-go="view" class="vw">${iso ? '◰ 3D view' : '◫ Map view'}</button><button data-go="all">Overview</button>` + S.districts.map((d) => `<button data-go="${d.id}">${esc(d.name)}</button>`).join('') + `<button data-go="agent" class="ag">☼ Follow an agent</button>`;
  el.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const g = b.dataset.go;
    if (g === 'view') { setView(!iso); return; }
    if (g === 'all') { unfollow(); if (iso) frameOn(new THREE.Vector3(), ISO_OFF, 1); else flyTo(HOME_CAM.target, HOME_CAM.pos); return; }
    if (g === 'agent') {
      const ags = people.filter((p) => p.r[6]);
      if (!ags.length) { toast('No agents have moved in yet. Be the first.'); return; }
      const vis = ags.filter((p) => p.vis); const pick = (vis.length ? vis : ags)[Math.floor(Math.random() * (vis.length || ags.length))];
      selectResident(pick.r[0]); return;
    }
    const d = S.districts.find((x) => x.id === g); unfollow();
    const c = W(d.rect[0] + d.rect[2] / 2, d.rect[1] + d.rect[3] / 2);
    frameOn(c, new THREE.Vector3(60, 190, 230), 2.1);
  };
}
let fly = null;
function flyTo(target, pos) { fly = { point: target.clone(), offset: pos.clone().sub(target), zoom: clamp(ISO_H / (pos.distanceTo(target) * 0.42), 0.8, 9) }; }
// With the side panel open on a wide screen, frame the selection left of centre.
const _right = new THREE.Vector3();
const viewHalf = () => (iso ? ISO_H / camera.zoom : camera.position.distanceTo(controls.target) * 0.384);
function panelShift() {
  if (!$('#drawer').classList.contains('open')) return new THREE.Vector3();
  const half = viewHalf();
  if (innerWidth <= 860) { // bottom sheet: put the selection in the top part of the screen
    camera.getWorldDirection(_right); _right.setY(0).normalize();
    return _right.multiplyScalar(-half * (iso ? 0.75 : 0.45));
  }
  _right.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  return _right.multiplyScalar(half * (innerWidth / innerHeight) * 0.3);
}
// fly to a point: perspective uses an offset, isometric a zoom level
function frameOn(point, offset, zoom) {
  fly = { point: point.clone(), offset: offset.clone(), zoom: zoom ?? clamp(ISO_H / (offset.length() * 0.42), 1.2, 9) };
}
controls.addEventListener('start', () => { fly = null; });

let toastT = 0;
function toast(s) { const t = $('#toast'); t.textContent = s; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

// selection
let follow = null;
function unfollow() { follow = null; $('#drawer').classList.remove('open'); }
$('#dclose').onclick = unfollow;
addEventListener('keydown', (e) => { if (e.key === 'Escape') unfollow(); });

function whereNow(p, V) {
  if (!p) return '';
  if (p.state === 'home') return 'Indoors at home';
  if (p.state === 'walking') return p.vid && V[p.vid] ? `Walking to ${V[p.vid].name}` : 'Walking home';
  const v = V[p.vid];
  if (!v) return 'Out';
  return v.isVenue ? `At ${v.name}` : `At work, ${v.name}`;
}
async function selectResident(id) {
  const p = people.find((x) => x.r[0] === id);
  follow = id;
  $('#drawer').classList.add('open');
  if (p && viewHalf() > 70) {
    const w = p.world || W(p.H[0], p.H[1]);
    frameOn(w, new THREE.Vector3(22, 200, 70), 4.6);
  }
  await renderResident(id);
}
async function renderResident(id) {
  const res = await (await fetch('/api/resident?id=' + encodeURIComponent(id))).json();
  if (!res.ok || follow !== id) return;
  const x = res.resident, pl = x.plan || {};
  const half = (k, v, r, why) => `${k === 'work' ? 'Working a shift' : k === 'in' ? 'Staying in' : esc(v || k)}${r ? ` <span class="tag">${esc(r)}</span>` : ''}${why ? `<div class="why">“${esc(txt(why))}”</div>` : ''}`;
  $('#dbody').innerHTML = `
    <div class="kicker">${x.outside ? '<span class="agent">☼ agent</span>' : 'native resident'} · ${esc(x.id)}</div>
    <h3 class="${x.outside ? 'agent' : ''}">${esc(txt(x.name))}</h3>
    <div class="dim">${esc(x.trade)} at ${esc(x.workplace)} · lives in ${esc(x.district)}</div>
    <div class="now" id="nowline"></div>
    <div class="kv">
      <div>Cash</div><div>${money(x.cash)}</div>
      <div>Net worth</div><div>${money(x.netWorth)}</div>
      <div>Mood</div><div><div class="bar"><i style="width:${x.mood}%"></i></div></div>
      <div>Shift</div><div>${x.shiftToday === 'off' ? 'day off' : x.shiftToday === 'aft' ? 'afternoon' : 'night'}</div>
      <div>Afternoon</div><div>${half(pl.aft, pl.aftVenue, pl.result?.aft, pl.whyAft)}</div>
      <div>Night</div><div>${half(pl.night, pl.nightVenue, pl.result?.night, pl.whyNight)}</div>
      <div>Today run by</div><div>${esc(({ you: 'the agent', routine: 'its routine', rules: 'habit' })[x.today?.from] || x.today?.from)}${x.today?.note ? `<div class="why">${esc(x.today.note)}</div>` : ''}</div>
      ${x.runsOn ? `<div>Runs on</div><div>${esc(txt(x.runsOn))} <span class="tag">self-declared</span></div>` : ''}
      ${x.wallet ? `<div>Wallet</div><div class="hash">${esc(x.wallet)}</div>` : ''}
      <div>Owns</div><div>${x.owns.length ? x.owns.map((o) => esc(o.name)).join(', ') : '—'}</div>
      <div>Wages</div><div>${money(x.stats.wages)}</div>
      <div>Spent out</div><div>${money(x.stats.spent)}</div>
      <div>Casino</div><div><span class="pos">+${money(x.stats.won)}</span> / <span class="neg">−${money(x.stats.lost)}</span></div>
      <div>Rent paid</div><div>${money(x.stats.rent)}${x.stats.arrears ? ` <span class="neg">(${money(x.stats.arrears)} behind)</span>` : ''}</div>
      <div>Jobs done</div><div>${x.stats.jobsDone}</div>
    </div>`;
  $('#drawer').classList.add('open');
}
function selectVenue(vid) {
  follow = null;
  const v = S.venues.find((x) => x.id === vid); if (!v) return;
  const c = W(v.x, v.y);
  const tall = { casino: 60, office: 120, docks: 40 }[v.type] || 0;
  $('#drawer').classList.add('open');
  frameOn(c, new THREE.Vector3(30, 150 + tall * 1.6, 115), tall > 80 ? 2.2 : 3.4);
  const inside = people.filter((p) => !p.walk && p.vis && p.vid === vid);
  const kind = ownerKind(v);
  $('#dbody').innerHTML = `
    <div class="kicker">${v.isVenue ? esc(v.type) : 'workplace'} · ${esc(v.id)}</div>
    <h3>${esc(v.name)}</h3>
    <div class="dim">${v.owner ? `Owned by <span class="${kind === 'agent' ? 'agent' : ''}">${esc(v.owner)}</span>` : 'City-owned'}${v.forSale ? ` · <span style="color:#ffd36e">for sale at $${v.salePrice}</span>` : ''}</div>
    <div class="kv">
      ${v.isVenue ? `<div>Door</div><div>$${v.price}</div><div>Today</div><div>${v.visitsToday} visits · ${money(v.takingsToday)} taken</div><div>Staff</div><div>${v.staff} · payroll ${money(v.payroll)} a shift</div><div>Lifetime</div><div>${v.lifetime.visits.toLocaleString()} visits · ${money(v.lifetime.takings)}</div>${v.distress ? `<div>Distress</div><div class="neg">${v.distress} missed payday${v.distress > 1 ? 's' : ''}</div>` : ''}` : `<div>Staff</div><div>${v.staff}</div>`}
      <div>Here now</div><div>${inside.length}</div>
    </div>
    <div class="who">${inside.slice(0, 40).map((p) => `<button data-who="${esc(p.r[0])}" class="${p.r[6] ? 'agent' : ''}">${esc(p.r[1])}</button>`).join('') || '<span class="dim">Nobody right now.</span>'}</div>`;
  $('#drawer').classList.add('open');
}

// picking: residents by screen distance, venues by ray
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), tmp = new THREE.Vector3();
function pick(e) {
  const b = canvas.getBoundingClientRect();
  const mx = e.clientX - b.left, my = e.clientY - b.top;
  let best = null, bd = LITE ? 22 : 14;
  for (const p of people) {
    if (!p.vis || !p.world) continue;
    tmp.copy(p.world); tmp.y += 2.5; tmp.project(camera);
    if (tmp.z > 1) continue;
    const sx = (tmp.x + 1) / 2 * b.width, sy = (1 - tmp.y) / 2 * b.height;
    const d = Math.hypot(sx - mx, sy - my);
    if (d < bd) { bd = d; best = p; }
  }
  if (best) return { person: best };
  ndc.set((mx / b.width) * 2 - 1, -(my / b.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(venueMeshes, false)[0];
  if (hit) return { venue: hit.object.userData.vid };
  return null;
}
let down = null;
canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  const h = pick(e);
  if (h?.person) selectResident(h.person.r[0]);
  else if (h?.venue) selectVenue(h.venue);
});
let hoverQ = null;
canvas.addEventListener('pointermove', (e) => { hoverQ = e; });
canvas.addEventListener('pointerleave', () => { hoverQ = null; $('#tip').style.display = 'none'; });
function doHover() {
  if (!hoverQ || !S) return;
  const e = hoverQ; hoverQ = null;
  const h = pick(e), tip = $('#tip');
  const V = venueById();
  if (h?.person) {
    const r = h.person.r;
    tip.innerHTML = `<b class="${r[6] ? 'agent' : ''}">${esc(r[1])}</b>${r[6] ? ' <span class="agent">☼</span>' : ''}<br><span class="dim">$${r[7]} · ${esc(whereNow(h.person, V))}</span>`;
  } else if (h?.venue) {
    const v = V[h.venue];
    tip.innerHTML = `<b>${esc(v.name)}</b><br><span class="dim">${v.isVenue ? `door $${v.price} · ${v.visitsToday} in today` : 'workplace'}</span>`;
  }
  if (h) { tip.style.display = 'block'; tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 14 + 'px'; canvas.style.cursor = 'pointer'; }
  else { tip.style.display = 'none'; canvas.style.cursor = ''; }
}

// ------------------------------------------------------------------ loop
let pollN = 0;
async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    S = await r.json();
    offset = S.clock.now - Date.now();
    const first = !built;
    if (first) { build(); renderChips(); }
    preparePeople(); updateVenues(); drawBillboard(); renderHUD();
    if (follow && $('#drawer').classList.contains('open') && (pollN++ % 2 === 0)) renderResident(follow);
    if (first && location.hash.startsWith('#follow=')) selectResident(decodeURIComponent(location.hash.slice(8)));
  } catch (e) { console.warn('poll failed', e); }
}
const clock = new THREE.Clock();
let fpsAcc = 0, frames = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  if (!S || !built) return;
  const h = cityHour();
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  $('#clk').textContent = `Day ${cityDay()} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  $('#phase').textContent = PHASE(h);
  $('#sunicon').textContent = h >= 6 && h < 20 ? '☀' : '☾';
  updateSky(h);
  updatePeople(h, t);
  updateCars(dt);
  updateSkyWorld(t, dt);
  sky.position.copy(camera.position); stars.position.copy(camera.position);
  moon.position.copy(camera.position).add(new THREE.Vector3(-1500, 1700, -1900));
  for (const b of boats) { b.g.position.y = b.y0 + Math.sin(t * 0.8 + b.ph) * 1.2; b.g.rotation.z = Math.sin(t * 0.6 + b.ph) * 0.03; }
  for (const b of beams) { b.m.rotation.z = Math.sin(t * 0.35 + b.ph) * 0.45; b.m.rotation.x = Math.cos(t * 0.27 + b.ph) * 0.3; }
  for (const m of blinkers) m.opacity = (Math.sin(t * 2.6) > 0.55 ? 1 : 0.12);
  if (agMark) agMark.count = agMesh.userData.n;
  if (follow) {
    const p = people.find((x) => x.r[0] === follow);
    if (p?.world) {
      const prev = controls.target.clone();
      if (!fly) controls.target.lerp(p.world.clone().add(panelShift()), 1 - Math.exp(-dt * 5));
      camera.position.add(controls.target.clone().sub(prev));
      const nl = $('#nowline'); if (nl) nl.textContent = whereNow(p, venueById());
    }
  }
  if (fly) {
    const k = 1 - Math.exp(-dt * 3.2);
    const tgt = fly.point.clone().add(panelShift());
    if (iso) {
      const prev = controls.target.clone(); controls.target.lerp(tgt, k); camera.position.add(controls.target.clone().sub(prev));
      camera.zoom += (fly.zoom - camera.zoom) * k; camera.updateProjectionMatrix();
      if (controls.target.distanceTo(tgt) < 0.8 && Math.abs(camera.zoom - fly.zoom) < 0.02) fly = null;
    } else {
      const pos = tgt.clone().add(fly.offset);
      controls.target.lerp(tgt, k); camera.position.lerp(pos, k);
      if (camera.position.distanceTo(pos) < 2) fly = null;
    }
  }
  controls.update();
  if (iso) { scene.fog.near = 1e5; scene.fog.far = 2e5; }
  else { const d = camera.position.distanceTo(controls.target); scene.fog.near = Math.max(700, d * 1.2); scene.fog.far = Math.max(2600, d * 3.6); }
  placeLabels();
  updateTrafficLights(t);
  doHover();
  if (composer) composer.render(); else renderer.render(scene, camera);
  // adaptive: if the machine struggles, drop shadows
  fpsAcc += dt; frames++;
  if (fpsAcc > 4) { const fps = frames / fpsAcc; if (fps < 24 && !SLOWOK) { if (renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); composer?.setPixelRatio(1); } else if (composer) composer = null; } fpsAcc = 0; frames = 0; }
}
const SLOWOK = new URLSearchParams(location.search).has('hq');
function placeLabels() {
  const wv = innerWidth, hv = innerHeight, zoomedOut = viewHalf() > 260;
  const put = (el, at) => { tmp.copy(at).project(camera); const x = (tmp.x + 1) / 2 * wv, y = (1 - tmp.y) / 2 * hv; const on = tmp.z < 1 && x > -80 && x < wv + 80 && y > -40 && y < hv + 40; el.style.display = on ? '' : 'none'; if (on) el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`; };
  for (const o of Object.values(venueObjs)) { put(o.sign.el, o.sign.at); o.sign.el.classList.toggle('small', zoomedOut); }
  for (const l of landmarkEls) put(l.el, l.at);
}
addEventListener('resize', () => { fitOrtho(); persp.aspect = innerWidth / innerHeight; persp.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); composer?.setSize(innerWidth, innerHeight); });

// opening screen over the live world
(() => {
  const intro = $('#intro'); if (!intro) return;
  let seen = false; try { seen = sessionStorage.getItem('sf_intro') === '1'; } catch {}
  if (seen || location.hash.startsWith('#follow=') || new URLSearchParams(location.search).has('nointro')) { intro.remove(); return; }
  document.body.classList.add('intro');
  if (!iso) { controls.autoRotate = true; controls.autoRotateSpeed = 0.35; }
  const close = () => { document.body.classList.remove('intro'); intro.classList.add('gone'); controls.autoRotate = false; try { sessionStorage.setItem('sf_intro', '1'); } catch {} setTimeout(() => intro.remove(), 700); };
  $('#enter').onclick = close;
  $('#intro-agent').onclick = () => { try { sessionStorage.setItem('sf_intro', '1'); } catch {} };
})();
window.__sunfall = { selectResident, selectVenue, people: () => people, flyTo, frameOn, setView, W, scene, sky, puffs, get planet() { return planet; }, get planetGlow() { return planetGlow; }, get camera() { return camera; } };
poll(); setInterval(poll, 3000); frame();
