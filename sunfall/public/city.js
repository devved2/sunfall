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
// Nightfall: a second island east of Sunfall in the same map space, its streets on the same 40-unit grid.
const NF = { x0: 1540, x1: 2180, y0: 60, y1: 660, cx: 1860, cy: 360 };
const inNF = (x) => x > 1260;
const snapX = (v) => (inNF(v) ? clamp(OFF + GRID * Math.round((v - OFF) / GRID), NF.x0, NF.x1) : clamp(OFF + GRID * Math.round((v - OFF) / GRID), OFF, XMAX));
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
const skyU = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(1, 0.8, 0.6) }, sunAmt: { value: 0 }, glowCol: { value: new THREE.Color(0x5fd0e8) }, glowAmt: { value: 0.5 } };
const sky = new THREE.Mesh(new THREE.SphereGeometry(4200, 32, 16), new THREE.ShaderMaterial({
  uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }',
  fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol; uniform float sunAmt; uniform vec3 glowCol; uniform float glowAmt; varying vec3 vDir;
    void main(){
      float h = clamp(vDir.y, 0.0, 1.0);
      vec3 c = mix(horizon, top, smoothstep(-0.02, 0.15, vDir.y));
      // a cyan band of light along the horizon, strongest beneath the planet, as in the artwork
      float side = 0.55 + 0.45 * smoothstep(-0.2, 0.9, dot(normalize(vDir.xz), normalize(vec2(0.42, -0.9))));
      c += glowCol * exp(-abs(vDir.y - 0.004) * 38.0) * glowAmt * side;
      c += glowCol * exp(-abs(vDir.y) * 6.0) * glowAmt * 0.12;
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
  neon: { k: 1, h: [55, 150], cols: ['#6fd3ff', '#9b8cff', '#c09cff', '#56bfe9', '#a9e9ff', '#e0a8ff'], split: 0.35 },
  oldtown: { k: 2, h: [14, 30], cols: ['#e2b48f', '#d49e7c', '#ecc59f', '#c99276', '#e8d2b0'] },
  harbour: { k: 1, h: [9, 16], cols: ['#a7c1d3', '#bccfda', '#dccab4', '#a9c3cf'], split: 0.35 },
  saltworks: { k: 1, h: [7, 14], cols: ['#c9c1b4', '#b8bcc4', '#d6cbb7', '#bdb6c7'], chimney: 0.45 },
  // Nightfall: dark towers wrapped in neon, glass spires on the heights, crowded tenements, a smoky dock
  velvet: { k: 1, h: [30, 95], cols: ['#3a2a52', '#4a2f5e', '#2e2440', '#5a3570', '#352a48', '#432b4f'], split: 0.3, neon: 0.85 },
  halo: { k: 1, h: [70, 175], cols: ['#cfd6ee', '#b4c0e4', '#e4e9f7', '#9cadd8', '#c2b8e8'], neon: 0.3, glass: true },
  undertow: { k: 2, h: [10, 28], cols: ['#5a4a5e', '#6a5560', '#4e4658', '#73606a', '#5e5052'], neon: 0.4 },
  ashdock: { k: 1, h: [7, 15], cols: ['#5c5048', '#4a4440', '#6a5a4c', '#544a46'], chimney: 0.55, neon: 0.12 },
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
  { parts: [[1535, 54, 2185, 666]], depth: 300, tex: [1520, 40], nf: true }, // Nightfall (tex: where its streets sit on the road texture)
];
const LANDMARKS = [{ name: 'Central Park', x: 560, y: 120 }, { name: 'The Plaza', x: 680, y: 320 }, { name: 'The Rift', x: 560, y: 480 }, { name: 'Skyport', x: 70, y: 520 }, { name: 'Sky Keep', x: 520, y: -330, h: 250 },
  { name: 'Ferry to Nightfall', x: 1010, y: 400, h: 14 }, { name: 'Ferry to Sunfall', x: 1510, y: 400, h: 14 }, { name: 'NIGHTFALL', x: 1860, y: 360, h: 250, big: true }];
const SLAB = { flats: '#8d8496', hillside: '#7f9a6c', neon: '#8a80a6', oldtown: '#9a8a78', harbour: '#86939e', saltworks: '#8f8a86', velvet: '#3e3448', halo: '#5a6072', undertow: '#4a4248', ashdock: '#4e4842' };
const SPINDLE = '1880,360'; // Nightfall's centrepiece tower stands on this block
const venueMeshes = [];
const islandMeshes = []; // land and rock of each island, so a click on a city brings it into focus
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
    const [tx, ty] = isl.tex || [0, 0];
    t.repeat.set((x1 - x0) / 970, (y1 - y0) / 672); t.offset.set((x0 - tx - 15) / 970, 1 - (y1 - ty - 14) / 672);
    const land = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 4, y1 - y0), [side, side, new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 }), side, side, side]);
    land.position.copy(W((x0 + x1) / 2, (y0 + y1) / 2, -2)); land.receiveShadow = true; scene.add(land);
    land.userData.city = isl.nf ? 'nightfall' : 'sunfall'; land.userData.top = true; islandMeshes.push(land);
    const grass = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0x6f9a52, roughness: 0.95 })); grass.scale.set(x1 - x0 + 3, 1.2, y1 - y0 + 3); grass.position.copy(W((x0 + x1) / 2, (y0 + y1) / 2, -4.6)); scene.add(grass);
    const rock = rockUnder(x0, y0, x1, y1, isl.depth, rnd); rock.userData.city = land.userData.city; islandMeshes.push(rock); scene.add(rock);
  }
  buildElysiumGlow();

  const bld = [], neon = [], chim = [], trees = [], slabs = [], parks = [], roofs = [], acs = [], tanks = [], antennas = [], awnings = [], palms = [], houses = [], benches = [], parkCells = [], crystals = [], domes = [];
  const venueNear = (cx, cy) => S.venues.some((v) => { const [rx, ry] = v.type === 'stadium' || v.type === 'field' ? [70, 50] : [34, 34]; return Math.abs(v.x - cx) < rx && Math.abs(v.y - cy) < ry; });
  const cells = [];
  for (let i = 0; i < 24; i++) for (let j = 0; j < 17; j++) { const cx = OFF + GRID * i + 20, cy = OFF + GRID * j + 20; if (cy <= 676) cells.push([cx, cy]); }
  for (let cx = NF.x0 + 20; cx < NF.x1; cx += GRID) for (let cy = NF.y0 + 20; cy < NF.y1; cy += GRID) cells.push([cx, cy]);
  for (const [cx, cy] of cells) {
    {
      const key = `${cx},${cy}`;
      if (key === SPINDLE) continue;
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
          if ((d.id === 'flats' || d.id === 'oldtown' || d.id === 'undertow') && rnd() < 0.32) tanks.push([lx + (rnd() - 0.5) * topW * 0.4, ly + (rnd() - 0.5) * topD * 0.4, rt]);
          if (topH > 95 && rnd() < 0.8) antennas.push([lx, ly, rt, 10 + rnd() * 12]);
          if ((d.id === 'flats' || d.id === 'oldtown' || d.id === 'undertow') && rnd() < 0.45) awnings.push([lx, ly + dd / 2 + 1.1, w * 0.72, ['#c8423a', '#2f6f5e', '#d9a13a', '#3a5a9c', '#e8ddc8', '#7a3b6e'][Math.floor(rnd() * 6)]]);
        }
        if (st.neon && rnd() < st.neon) {
          const y = 12 + rnd() * (h - 20);
          const ncol = d.id === 'halo' ? ['#7fe8ff', '#b9a4ff'] : d.id === 'velvet' ? ['#ff3d8b', '#c03cff', '#ff2fd0', '#3df2ff', '#a35bff'] : ['#ff3d8b', '#3df2ff', '#a35bff', '#ff8a3d'];
          neon.push([lx, ly, w + 0.6, dd + 0.6, y, ncol[Math.floor(rnd() * ncol.length)]]);
          if (d.id === 'velvet' && h > 40 && rnd() < 0.6) neon.push([lx, ly, w + 0.6, dd + 0.6, 6 + rnd() * (h - 12), ncol[Math.floor(rnd() * ncol.length)]]);
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
    // glassy crystal: dark at the foot, glowing up the shaft, bright facet edges catching the sky
    const crystalMat = (isTip) => {
      const m = new THREE.MeshStandardMaterial({ roughness: 0.12, metalness: 0.35, flatShading: true, transparent: true, opacity: 0.9 });
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uGlow = glowU;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vH; varying vec3 vVd; varying vec3 vNw;')
          .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
            vH = ${isTip ? '1.0' : 'position.y'};
            { vec4 wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0); vVd = normalize(cameraPosition - wp.xyz); vNw = normalize(mat3(modelMatrix * instanceMatrix) * objectNormal); }`);
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlow; varying float vH; varying vec3 vVd; varying vec3 vNw;')
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            { float fres = pow(1.0 - abs(dot(normalize(vNw), normalize(vVd))), 2.0);
              vec3 base = vColor;
              diffuseColor.rgb = mix(base * 0.25, base * 0.8, vH);
              totalEmissiveRadiance += base * base * (0.06 + 0.5 * pow(vH, 1.8)) * (0.3 + uGlow * 0.85);
              totalEmissiveRadiance += vec3(0.55, 0.9, 1.0) * fres * (0.12 + 0.4 * vH) * (0.3 + uGlow * 0.7); }`);
      };
      return m;
    };
    const body = new THREE.InstancedMesh(cg, crystalMat(false), crystals.length), tip = new THREE.InstancedMesh(tg, crystalMat(true), crystals.length);
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
  for (let x = NF.x0; x <= NF.x1; x += GRID) for (let y = NF.y0; y <= NF.y1; y += GRID) lamps.push([x + 6.5, y + 6.5]);
  const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.3, 9, 5).translate(0, 4.5, 0), new THREE.MeshStandardMaterial({ color: 0x2b2b30 }), lamps.length);
  lamps.forEach(([x, y], i) => { m4.compose(W(x, y, 0), q, new THREE.Vector3(1, 1, 1)); pole.setMatrixAt(i, m4); });
  scene.add(pole);
  const lampGeo = new THREE.BufferGeometry().setFromPoints(lamps.map(([x, y]) => W(x, y, 9.4)));
  lampPoints = new THREE.Points(lampGeo, new THREE.PointsMaterial({ map: GLOW, size: 16, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  scene.add(lampPoints);

  // sky docks jutting off the island edges
  const pierMat = new THREE.MeshStandardMaterial({ color: 0x4a3c30, roughness: 0.9 });
  for (const [x, y, w, d] of [[-2, 420, 44, 7], [-2, 500, 52, 7], [-2, 590, 40, 7], [800, 702, 7, 60], [870, 700, 7, 52], [140, 702, 7, 50], [1006, 400, 44, 9], [1514, 400, 44, 9]]) {
    const p = new THREE.Mesh(BOX, pierMat); p.scale.set(w, 1.4, d); p.position.copy(W(x, y, -1)); p.receiveShadow = true; scene.add(p);
  }

  for (const v of S.venues) buildVenue(v, rnd);
  buildNightfall(rnd);
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
  const cTop = new THREE.Color(0x4a4f5c), cMid = new THREE.Color(0x3a4a5e), cLow = new THREE.Color(0x52677e), tmpc = new THREE.Color();
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
  const rm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, side: THREE.DoubleSide });
  rm.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = nightU;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRockW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRockW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      uniform float uNight; varying vec3 vRockW;
      float rh(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float rn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(rh(i), rh(i+vec3(1,0,0)), f.x), mix(rh(i+vec3(0,1,0)), rh(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(rh(i+vec3(0,0,1)), rh(i+vec3(1,0,1)), f.x), mix(rh(i+vec3(0,1,1)), rh(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      { vec3 q = vRockW * vec3(0.016, 0.009, 0.016);
        float v = rn(q) * 0.65 + rn(q * 2.3 + 7.0) * 0.35;
        float vein = 1.0 - smoothstep(0.0, 0.008, abs(v - 0.5));
        float depthFade = smoothstep(-6.0, -60.0, vRockW.y);
        totalEmissiveRadiance += vec3(0.22, 0.78, 1.0) * vein * depthFade * (0.45 + uNight * 1.1); }`);
  };
  const m = new THREE.Mesh(g, rm);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// Elysium glow: cyan light along every island edge and down the middle of every street, brighter at night.
const glowLines = [];
function buildElysiumGlow() {
  const rim = [], streets = [];
  const seg = (arr, ax, ay, bx, by, h) => { const a = W(ax, ay, h), b = W(bx, by, h); arr.push(a.x, a.y, a.z, b.x, b.y, b.z); };
  for (const isl of ISLANDS) for (const [x0, y0, x1, y1] of isl.parts) {
    const o = 1.6;
    for (const h of [0.6, -5.5]) { seg(rim, x0 - o, y0 - o, x1 + o, y0 - o, h); seg(rim, x1 + o, y0 - o, x1 + o, y1 + o, h); seg(rim, x1 + o, y1 + o, x0 - o, y1 + o, h); seg(rim, x0 - o, y1 + o, x0 - o, y0 - o, h); }
    const [gx0, gx1, gy0, gy1] = isl.nf ? [NF.x0, NF.x1, NF.y0, NF.y1] : [OFF, XMAX, OFF, YMAX];
    for (let x = gx0; x <= gx1; x += GRID) if (x > x0 && x < x1) seg(streets, x, y0 + 2, x, y1 - 2, 0.35);
    for (let y = gy0; y <= gy1; y += GRID) if (y > y0 && y < y1) seg(streets, x0 + 2, y, x1 - 2, y, 0.35);
  }
  for (const [arr, color, op] of [[rim, 0x5fdcff, 1], [streets, 0x34b7dd, 0.55]]) {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
    const l = new THREE.LineSegments(geo, mat); l.renderOrder = 2; scene.add(l); glowLines.push({ mat, op });
  }
}

// soft round puff for steam and mist
function softPuffTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// cumulus puff texture: rounded lobes, bright tops, a cooler shaded base
function puffTexture(seed = 11) {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); const r = mulberry32(seed);
  for (let i = 0; i < 34; i++) {
    const t = r(), x = 40 + r() * 176, y = 150 - Math.sin(((x - 40) / 176) * Math.PI) * (40 + r() * 50) + r() * 30, rad = 22 + r() * 46 * (0.5 + Math.sin(((x - 40) / 176) * Math.PI) * 0.6);
    const gr = g.createRadialGradient(x, y, rad * 0.2, x, y, rad); gr.addColorStop(0, 'rgba(255,255,255,0.85)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
  }
  g.globalCompositeOperation = 'source-atop';
  const sh = g.createLinearGradient(0, 60, 0, 220); sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.55, 'rgba(120,150,175,0.15)'); sh.addColorStop(1, 'rgba(60,90,120,0.55)');
  g.fillStyle = sh; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const puffMats = [], puffClones = [];
const mistMat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, color: 0xbff0ff, opacity: 0.8 });
const puffs = [];
let cloudSea = null, planet = null, planetGlow = null, planetRing = null, planetFlare = null;
const PLANET_R = 1500, PLANET_DIR = new THREE.Vector3(0.52, -0.1, -0.85).normalize();
const planetU = { L: { value: new THREE.Vector3() } };
const falls = [], islets = [], airships = [], steam = [];

function waterfall(x, y, top, width, height, facing) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeU, uNight: nightU }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float uTime; uniform float uNight; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      void main(){
        float streak = n(vec2(vUv.x * 18.0, vUv.y * 3.0 + uTime * 2.2)) * 0.6 + n(vec2(vUv.x * 40.0, vUv.y * 6.0 + uTime * 3.4)) * 0.4;
        float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
        float fade = smoothstep(0.0, 0.45, vUv.y);
        float core = 1.0 - abs(vUv.x - 0.5) * 2.0;
        vec3 c = mix(vec3(0.20,0.62,0.85), vec3(0.80,0.97,1.0), streak * 0.7 + core * 0.4) * mix(0.75, 1.15, uNight);
        float tail = smoothstep(0.0, 0.25, vUv.y);
        gl_FragColor = vec4(c * (0.16 + streak * 0.38) * edge * tail, 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, height).translate(0, -height / 2, 0), mat);
  m.position.copy(W(x, y, top)); m.rotation.y = facing; scene.add(m); falls.push(m);
  // a lip of water at the top, and mist at the bottom
  const mist = new THREE.Sprite(mistMat); mist.scale.set(width * 5, width * 3.2, 1); mist.position.copy(W(x, y, top - height + 10)); scene.add(mist);
}

function puff(x, y, h, size, mi = 0) {
  // each puff has its own material so it can fade out when the camera gets close (no grey veil over the view)
  const mat = puffMats[mi].clone(); puffClones.push({ mat, mi });
  const sp = new THREE.Sprite(mat); sp.scale.set(size, size * 0.62, 1); sp.position.copy(W(x, y, h)); scene.add(sp);
  puffs.push({ sp, mat, size, base: sp.position.clone(), ph: Math.random() * 6.28, sp0: 2 + Math.random() * 4 });
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
  // thin orbit rings of light circling Sky Keep
  for (const [rad, tilt, rot, op] of [[175, 0.32, 0.4, 0.75], [205, -0.22, -0.9, 0.4]]) {
    const pts = []; for (let i = 0; i <= 180; i++) { const a = (i / 180) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * rad, 0, Math.sin(a) * rad * 0.8)); }
    const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8fe6ff, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    ring.position.copy(W(530, -345, 70)); ring.rotation.set(tilt, rot, tilt * 0.4); grp.add(ring); glowLines.push({ mat: ring.material, op });
  }
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

// Nightfall's centrepiece, the sky ferry between the two cities, and the island's waterfalls and clouds.
const ferries = [];
function buildNightfall(rnd) {
  const [sx, sy] = SPINDLE.split(',').map(Number);
  const dark = windowed(new THREE.MeshStandardMaterial({ color: 0x2a2140, roughness: 0.35, metalness: 0.55 }));
  const base = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0x3a3346, roughness: 0.8 })); base.scale.set(32, 1.2, 32); base.position.copy(W(sx, sy, 0)); base.receiveShadow = true; scene.add(base);
  const parts = [[13, 10, 58, 0.8], [8.5, 6, 78, 58.8], [4.5, 1.2, 96, 136.8]];
  for (const [r0, r1, h, y0] of parts) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, h, 8).translate(0, h / 2, 0), dark); m.position.copy(W(sx, sy, y0)); m.castShadow = true; scene.add(m);
  }
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.9, 0.5, 2.4), toneMapped: false });
  for (const [r, y] of [[11.2, 58.8], [7.4, 98], [6.4, 136.8], [3.6, 180]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.55, 6, 32).rotateX(Math.PI / 2), ringMat); ring.position.copy(W(sx, sy, y)); scene.add(ring);
  }
  const beacon = new THREE.Points(new THREE.BufferGeometry().setFromPoints([W(sx, sy, 234)]), new THREE.PointsMaterial({ map: GLOW, size: 46, color: 0xd76bff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(beacon); blinkers.push(beacon.material);
  // the sky ferry: two airships shuttling between the piers on Sunfall's east edge and Nightfall's west edge
  for (let i = 0; i < 2; i++) { const g = airshipMesh(0.62, rnd); scene.add(g); ferries.push({ g, off: i * 0.5, lane: i ? 412 : 388 }); }
  waterfall(1535, 560, -3, 14, 260, Math.PI / 2); waterfall(2185, 200, -3, 16, 280, Math.PI / 2); waterfall(1800, 666, -3, 22, 300, 0);
  for (let i = 0; i < (LITE ? 6 : 12); i++) puff(1560 + rnd() * 620, 80 + rnd() * 560, -320 - rnd() * 50, 300 + rnd() * 240, i % 2);
}
function updateFerries(t) {
  const P = 48; // seconds for a round trip: wait, cross, wait, cross back
  for (const f of ferries) {
    const k = ((t / P + f.off) % 1 + 1) % 1;
    let u, back = false;
    if (k < 0.1) u = 0; else if (k < 0.45) u = smooth(0.1, 0.45, k); else if (k < 0.55) u = 1; else { u = 1 - smooth(0.55, 0.9, k); back = true; }
    if (k >= 0.9) { u = 0; back = true; }
    const x = 1036 + (1484 - 1036) * u;
    f.g.position.copy(W(x, f.lane, 26 + Math.sin(u * Math.PI) * 18 + Math.sin(t * 0.8 + f.off * 9) * 0.6));
    f.g.rotation.y = back ? Math.PI : 0;
  }
}

function buildSkyWorld(rnd) {
  puffMats.push(new THREE.SpriteMaterial({ map: puffTexture(), transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.9 }));
  puffMats.push(new THREE.SpriteMaterial({ map: puffTexture(29), transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.85 }));
  // the sea of clouds far below
  cloudSea = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000, 1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    defines: { OCT: LITE ? 3 : 5 },
    uniforms: { uTime: timeU, uLight: { value: skyTint.light }, uShadow: { value: skyTint.shadow }, uHaze: { value: new THREE.Color() }, uGlow: { value: skyU.glowCol.value }, uGlowAmt: skyU.glowAmt, uL: planetU.L },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float uTime; uniform vec3 uLight; uniform vec3 uShadow; uniform vec3 uHaze; uniform vec3 uGlow; uniform float uGlowAmt; uniform vec3 uL; varying vec3 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < OCT; i++){ v += a * n(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
      float field(vec2 p){ vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3))); return fbm(p + 1.4 * q); }
      void main(){
        vec2 p = vW.xz * 0.0019 + vec2(uTime * 0.005, uTime * 0.0025);
        #if OCT > 3
          float c = field(p);
          float e = 0.035; float cx = field(p + vec2(e, 0.0)) - c, cz = field(p + vec2(0.0, e)) - c;
          vec3 nrm = normalize(vec3(-cx * 9.0, 1.0, -cz * 9.0));
          float dif = clamp(dot(nrm, normalize(uL + vec3(0.0, 0.6, 0.0))), 0.0, 1.0);
        #else
          float c = field(p); float dif = 0.55 + 0.45 * smoothstep(0.4, 0.8, c);   // phones: no lighting pass
        #endif
        float puffy = smoothstep(0.30, 0.78, c);
        vec3 col = mix(uShadow, uLight, puffy * (0.55 + 0.6 * dif));
        col += uLight * pow(smoothstep(0.55, 0.9, c), 2.0) * 0.35;
        float d = length(vW.xz - cameraPosition.xz) / 7000.0;
        col = mix(col, uHaze, smoothstep(0.08, 1.0, d) * 0.85);
        col += uGlow * uGlowAmt * smoothstep(0.25, 1.0, d) * 0.55;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  cloudSea.position.y = -330; scene.add(cloudSea);
  // big soft puffs drifting around and below the islands
  // cumulus banks hugging the cloud sea, around the rock tips (as in the artwork), not hanging in the view
  for (let i = 0; i < (LITE ? 24 : 46); i++) {
    const a = rnd() * 6.28, r = 700 + rnd() * 1100;
    puff(500 + Math.cos(a) * r, 350 + Math.sin(a) * r * 0.8, -290 - rnd() * 60, 380 + rnd() * 420, i % 2);
  }
  for (let i = 0; i < (LITE ? 10 : 18); i++) puff(80 + rnd() * 840, 60 + rnd() * 580, -320 - rnd() * 50, 300 + rnd() * 240, i % 2);
  // the giant planet on the horizon: night side, a lit crescent, banded clouds and a cyan atmosphere,
  // with a star flaring on its edge (as in the Sunfall artwork)
  planet = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.ShaderMaterial({
    defines: { OCT: LITE ? 3 : 5 },
    uniforms: { uL: planetU.L, uTime: timeU }, transparent: true, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vObj; uniform vec3 uL; varying vec3 vLv;
      void main(){ vObj = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        vLv = normalize((viewMatrix * vec4(uL, 0.0)).xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vObj; varying vec3 vLv;
      float h(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float n(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(h(i), h(i+vec3(1,0,0)), f.x), mix(h(i+vec3(0,1,0)), h(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(h(i+vec3(0,0,1)), h(i+vec3(1,0,1)), f.x), mix(h(i+vec3(0,1,1)), h(i+vec3(1,1,1)), f.x), f.y), f.z); }
      float fbm(vec3 p){ float v = 0.0, a = 0.5; for (int i = 0; i < OCT; i++){ v += a * n(p); p *= 2.07; a *= 0.5; } return v; }
      void main(){
        // a real-looking sun: granulation, limb darkening (hot white centre, deep orange edge), faculae and a few sunspots
        vec3 p = normalize(vObj);
        float mu = clamp(dot(vN, vV), 0.0, 1.0);
        float ld = 1.0 - 0.6 * (1.0 - pow(mu, 0.55));
        float gran = n(p * 90.0 + vec3(uTime * 0.04, 0.0, uTime * 0.03)) * 0.45 + fbm(p * 26.0 + vec3(0.0, uTime * 0.008, 0.0)) * 0.55;
        float spot = smoothstep(0.74, 0.8, fbm(p * 3.4 + 11.0)) * (1.0 - smoothstep(0.25, 0.55, abs(p.y)));
        float fac = smoothstep(0.6, 0.74, fbm(p * 7.0 + 3.0)) * (1.0 - mu);
        vec3 hot = vec3(1.0, 0.76, 0.34), warm = vec3(1.0, 0.46, 0.1), rim = vec3(0.6, 0.11, 0.02);
        vec3 c = mix(rim, mix(warm, hot, smoothstep(0.35, 0.95, mu)), smoothstep(0.0, 0.45, mu));
        c *= ld * (0.72 + 0.56 * gran);
        c += vec3(1.0, 0.72, 0.42) * fac * 0.3;
        c *= 1.0 - spot * 0.78;
        c *= 0.92;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  planet.scale.setScalar(PLANET_R); planet.renderOrder = -0.5; scene.add(planet);
  // atmosphere halo just beyond the limb, brightest towards the star
  planetGlow = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.ShaderMaterial({
    uniforms: { uL: planetU.L }, transparent: true, depthWrite: false, fog: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vLv; uniform vec3 uL;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vLv = normalize((viewMatrix * vec4(uL, 0.0)).xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV; varying vec3 vLv;
      // soft corona: brightest right at the sun's edge and fading smoothly outwards; nothing drawn over the disc itself
      void main(){ float d = max(dot(-vN, vV), 0.0); const float d0 = 0.745; // the disc's edge, for a shell 1.5x the sun
        float k = clamp(d / d0, 0.0, 1.0); float glow = (pow(k, 5.0) * 0.8 + pow(k, 14.0) * 0.6) * step(d, d0);
        gl_FragColor = vec4(vec3(1.0, 0.48, 0.14) * glow * 0.75, 1.0); }`,
  }));
  planetGlow.scale.setScalar(PLANET_R * 1.5); planetGlow.renderOrder = -0.45; scene.add(planetGlow);
  // thin rings: two fine bright lines rather than a band
  const ringMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vP; void main(){ float r = length(vP);
      float a = exp(-pow((r - 1.28) / 0.005, 2.0)) * 0.9 + exp(-pow((r - 1.36) / 0.0035, 2.0)) * 0.45;
      gl_FragColor = vec4(vec3(0.62, 0.92, 1.0) * a * 0.6, 1.0); }`,
  });
  planetRing = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.45, 256, 1), ringMat);
  planetRing.scale.setScalar(PLANET_R); planetRing.renderOrder = -0.4; scene.add(planetRing);
  // the star on the planet's edge, with a soft halo and a few long rays
  const fc = document.createElement('canvas'); fc.width = fc.height = 512; const fg = fc.getContext('2d');
  let gr = fg.createRadialGradient(256, 256, 0, 256, 256, 256); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.04, 'rgba(240,252,255,0.95)'); gr.addColorStop(0.16, 'rgba(150,225,255,0.35)'); gr.addColorStop(1, 'rgba(90,200,255,0)');
  fg.fillStyle = gr; fg.fillRect(0, 0, 512, 512);
  fg.globalCompositeOperation = 'lighter';
  for (const [ang, len, wid, al] of [[0, 250, 3, 0.55], [Math.PI / 2, 190, 2.4, 0.4], [0.5, 120, 1.5, 0.25], [-0.6, 110, 1.5, 0.22], [1.2, 90, 1.2, 0.2]]) {
    fg.save(); fg.translate(256, 256); fg.rotate(ang);
    const lg = fg.createLinearGradient(-len, 0, len, 0); lg.addColorStop(0, 'rgba(160,230,255,0)'); lg.addColorStop(0.5, `rgba(235,250,255,${al})`); lg.addColorStop(1, 'rgba(160,230,255,0)');
    fg.fillStyle = lg; fg.fillRect(-len, -wid, len * 2, wid * 2); fg.restore();
  }
  const ftex = new THREE.CanvasTexture(fc); ftex.colorSpace = THREE.SRGBColorSpace;
  planetFlare = new THREE.Sprite(new THREE.SpriteMaterial({ map: ftex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  planetFlare.scale.set(PLANET_R * 0.42, PLANET_R * 0.42, 1); planetFlare.renderOrder = -0.3; scene.add(planetFlare);
  // waterfalls off the city's edges and into the rifts
  waterfall(15, 450, -3, 18, 300, Math.PI / 2); waterfall(15, 610, -3, 14, 260, Math.PI / 2);
  waterfall(520, 686, -3, 34, 340, 0); waterfall(880, 686, -3, 14, 240, 0);
  waterfall(985, 140, -3, 16, 260, Math.PI / 2); waterfall(300, 14, -3, 14, 240, 0);
  waterfall(747, 330, -3, 8, 160, Math.PI / 2); waterfall(620, 494, -3, 10, 170, 0);
  buildSkyKeep(rnd);
  for (const [x, y, h, sz] of [[-150, 180, 30, 70], [-120, 560, -30, 54], [1150, 260, 40, 64], [1120, 600, -20, 50], [240, 860, -70, 60], [820, 880, -50, 46], [1060, -120, 70, 58], [-60, -150, 50, 52], [330, -230, 20, 36]]) buildIslet(x, y, h, sz, rnd);
  // airships circling the city
  for (let i = 0; i < (LITE ? 3 : 5); i++) { const g = airshipMesh(0.9 + rnd() * 0.5, rnd); scene.add(g); airships.push({ g, r: 840 + rnd() * 260, h: 150 + rnd() * 90, sp: (0.012 + rnd() * 0.01) * (rnd() < 0.5 ? 1 : -1), a: rnd() * 6.28 }); }
  // chimney steam
  steamTex = softPuffTexture();
  mistMat.map = steamTex; mistMat.needsUpdate = true;
}
let steamTex = null;
function buildSteam() {
  for (const at of steamAt.slice(0, 40)) for (let k = 0; k < 3; k++) {
    const m = new THREE.SpriteMaterial({ map: steamTex, transparent: true, depthWrite: false, opacity: 0.5 });
    const sp = new THREE.Sprite(m); sp.position.copy(at); scene.add(sp); steam.push({ sp, at, t: k / 3 });
  }
}
const _pv = new THREE.Vector3(), _pv2 = new THREE.Vector3(), _pv3 = new THREE.Vector3();
function updateSkyWorld(t, dt) {
  updateFerries(t);
  timeU.value = t;
  for (const p of puffs) {
    p.sp.position.x = p.base.x + Math.sin(t * 0.02 + p.ph) * 30;
    const d = p.sp.position.distanceTo(camera.position);
    p.mat.opacity = puffMats[0].opacity * clamp((d - p.size * 0.45) / (p.size * 0.9), 0, 1);
  }
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
    planet.visible = planetGlow.visible = show; planetRing.visible = planetFlare.visible = false; // a sun has no rings
    planet.position.copy(camera.position).addScaledVector(PLANET_DIR, 4300);
    planetRing.position.copy(planet.position); planetGlow.position.copy(planet.position);
    // the star sits behind the planet's upper-left limb, so the planet shows a lit crescent
    const left = _pv.crossVectors(UP, PLANET_DIR).normalize();
    planetU.L.value.copy(left).multiplyScalar(0.62).addScaledVector(UP, 0.4).addScaledVector(PLANET_DIR, 0.68).normalize();
    const limb = _pv2.copy(planetU.L.value).addScaledVector(PLANET_DIR, -planetU.L.value.dot(PLANET_DIR)).normalize();
    planetFlare.position.copy(planet.position).addScaledVector(limb, PLANET_R * 0.99).addScaledVector(PLANET_DIR, -PLANET_R * 0.2);
    planetRing.quaternion.setFromUnitVectors(_pv3.set(0, 0, 1), _pv3.copy(UP).multiplyScalar(0.8).addScaledVector(PLANET_DIR, -0.22).addScaledVector(left, -0.55).normalize());
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
    const el = document.createElement('div'); el.className = 'lm' + (l.big ? ' big' : ''); el.textContent = l.name;
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
// Skyline Field's big screen, drawn the same way as the Arena's.
const fieldScreen = { canvas: null, tex: null, key: '' };
function drawScoreScreen(scr, title, idle, m) {
  const c = scr.canvas; if (!c) return;
  const key = JSON.stringify(m); if (key === scr.key) return; scr.key = key;
  const g = c.getContext('2d');
  g.fillStyle = '#05080c'; g.fillRect(0, 0, 768, 256);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#ffb04a'; g.font = '600 26px "JetBrains Mono", monospace'; g.fillText(title, 384, 34);
  if (!m) { g.fillStyle = '#f3fbf5'; g.font = '700 54px Inter, sans-serif'; g.fillText(idle, 384, 140); }
  else {
    const short = (s) => s.split(' ').slice(-1)[0].toUpperCase();
    g.font = '700 46px Inter, sans-serif';
    g.fillStyle = m.hc; g.fillRect(40, 92, 14, 70); g.fillStyle = m.ac; g.fillRect(714, 92, 14, 70);
    g.fillStyle = '#f3fbf5'; g.textAlign = 'left'; g.fillText(short(m.home), 68, 128, 220); g.textAlign = 'right'; g.fillText(short(m.away), 700, 128, 220);
    g.textAlign = 'center'; g.font = '700 80px "JetBrains Mono", monospace'; g.fillStyle = '#ffffff'; g.fillText(m.score ? `${m.score[0]}-${m.score[1]}` : 'v', 384, 130);
    g.font = '600 28px "JetBrains Mono", monospace'; g.fillStyle = m.status === 'live' ? '#ff6b6b' : '#9fb3c8';
    g.fillText(m.status === 'live' ? `LIVE ${m.quarter}` : m.status === 'ft' ? 'FINAL' : 'NEXT UP', 384, 214);
  }
  scr.tex.needsUpdate = true;
}
// The Arena's big screen: the live score, or the next kick-off.
const arenaScreen = { canvas: null, tex: null, key: '' };
function drawArenaScreen(m) {
  const c = arenaScreen.canvas; if (!c) return;
  const key = JSON.stringify(m); if (key === arenaScreen.key) return; arenaScreen.key = key;
  const g = c.getContext('2d');
  g.fillStyle = '#05080c'; g.fillRect(0, 0, 768, 256);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#7dffa8'; g.font = '600 26px "JetBrains Mono", monospace'; g.fillText('SUNFALL ARENA', 384, 34);
  if (!m) { g.fillStyle = '#f3fbf5'; g.font = '700 56px Inter, sans-serif'; g.fillText('SUNFALL LEAGUE', 384, 140); }
  else {
    const short = (s) => s.replace(/ (FC|City|United|Athletic|Rovers|Albion)$/, '').toUpperCase();
    g.font = '700 46px Inter, sans-serif';
    g.fillStyle = m.hc; g.fillRect(40, 92, 14, 70); g.fillStyle = m.ac; g.fillRect(714, 92, 14, 70);
    g.fillStyle = '#f3fbf5'; g.textAlign = 'left'; g.fillText(short(m.home), 68, 128, 230); g.textAlign = 'right'; g.fillText(short(m.away), 700, 128, 230);
    g.textAlign = 'center'; g.font = '700 84px "JetBrains Mono", monospace'; g.fillStyle = '#ffffff'; g.fillText(m.score ? `${m.score[0]}-${m.score[1]}` : 'v', 384, 130);
    g.font = '600 28px "JetBrains Mono", monospace';
    g.fillStyle = m.status === 'live' ? '#ff6b6b' : '#9fb3c8';
    g.fillText(m.status === 'live' ? `LIVE ${m.minute}'` : m.status === 'ft' ? 'FULL TIME' : 'NEXT UP', 384, 214);
  }
  arenaScreen.tex.needsUpdate = true;
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
          new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
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
    case 'stadium': {
      // Sunfall Arena: a pitch, three tiers of stands on every side, a roof over the long stands, four floodlights,
      // a crowd, and a big screen showing the live score.
      const pc = document.createElement('canvas'); pc.width = 512; pc.height = 320; const g = pc.getContext('2d');
      for (let i = 0; i < 12; i++) { g.fillStyle = i % 2 ? '#2f8a45' : '#2a7d3e'; g.fillRect(i * 512 / 12, 0, 512 / 12 + 1, 320); }
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 3; g.strokeRect(14, 14, 484, 292); g.beginPath(); g.moveTo(256, 14); g.lineTo(256, 306); g.stroke();
      g.beginPath(); g.arc(256, 160, 40, 0, Math.PI * 2); g.stroke(); g.strokeRect(14, 90, 64, 140); g.strokeRect(434, 90, 64, 140); g.strokeRect(14, 125, 22, 70); g.strokeRect(476, 125, 22, 70);
      const ptex = new THREE.CanvasTexture(pc); ptex.colorSpace = THREE.SRGBColorSpace; ptex.anisotropy = 4;
      const pitch = new THREE.Mesh(new THREE.PlaneGeometry(68, 42), new THREE.MeshStandardMaterial({ map: ptex, roughness: 0.95 }));
      pitch.rotation.x = -Math.PI / 2; pitch.position.y = 0.35; pitch.receiveShadow = true; pitch.userData.vid = v.id; grp.add(pitch); venueMeshes.push(pitch);
      add(std(0x2d3138), 104, 0.3, 66, 0, 0, 0);
      const seat = [std(0x2b4a7a), std(0x30558a), std(0x3a63a0)];
      for (let t = 0; t < 3; t++) {
        const h = 3 + t * 3.2, off = t * 5;
        for (const sz of [-1, 1]) add(seat[t], 78 + off * 2, h, 5, 0, 0, sz * (23.5 + off));
        for (const sx of [-1, 1]) add(seat[t], 5, h, 48 + off * 2, sx * (37.5 + off), 0, 0);
      }
      const wall = std(0x8c93a0); for (const sz of [-1, 1]) add(wall, 100, 13, 1.2, 0, 0, sz * 33.4); for (const sx of [-1, 1]) add(wall, 1.2, 13, 66, sx * 50, 0, 0);
      const roof = new THREE.MeshStandardMaterial({ color: 0xd9dee6, roughness: 0.4, metalness: 0.3, transparent: true, opacity: 0.88 });
      for (const sz of [-1, 1]) { const r = add(roof, 92, 0.8, 13, 0, 15.5, sz * 28); r.rotation.x = sz * 0.12; }
      // floodlights
      const mast = std(0x9aa1ab, { metalness: 0.6, roughness: 0.35 });
      const fl = [];
      for (const [mx, mz] of [[-49, -32], [49, -32], [-49, 32], [49, 32]]) { add(mast, 1.2, 36, 1.2, mx, 0, mz); add(new THREE.MeshStandardMaterial({ color: 0xfafcff, emissive: 0xe8f4ff, emissiveIntensity: 0.6 }), 7, 4, 1, mx, 35, mz); fl.push(new THREE.Vector3(mx, 37, mz)); }
      const lights = new THREE.Points(new THREE.BufferGeometry().setFromPoints(fl), new THREE.PointsMaterial({ map: GLOW, size: 46, color: 0xeaf6ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      grp.add(lights); nightGlows.push(lights.material);
      // the crowd
      const crowd = [], cc = [], palette = [0xa77bd6, 0x5fbf8a, 0xff4fa3, 0xe2a63c, 0x4fb8e8, 0xf2f2f2, 0xffd24a].map((x) => new THREE.Color(x));
      for (let i = 0; i < 900; i++) {
        const t = Math.floor(rnd() * 3), off = t * 5, h = 3.6 + t * 3.2;
        const long = rnd() < 0.62, s = rnd() < 0.5 ? -1 : 1;
        if (long) crowd.push(new THREE.Vector3((rnd() - 0.5) * (76 + off * 2), h, s * (23.5 + off + (rnd() - 0.5) * 3)));
        else crowd.push(new THREE.Vector3(s * (37.5 + off + (rnd() - 0.5) * 3), h, (rnd() - 0.5) * (46 + off * 2)));
        const c = palette[Math.floor(rnd() * palette.length)]; cc.push(c.r, c.g, c.b);
      }
      const cg = new THREE.BufferGeometry().setFromPoints(crowd); cg.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
      grp.add(new THREE.Points(cg, new THREE.PointsMaterial({ size: 1.3, vertexColors: true })));
      // the big screen above the north stand
      arenaScreen.canvas = document.createElement('canvas'); arenaScreen.canvas.width = 768; arenaScreen.canvas.height = 256;
      arenaScreen.tex = new THREE.CanvasTexture(arenaScreen.canvas); arenaScreen.tex.colorSpace = THREE.SRGBColorSpace;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), new THREE.MeshBasicMaterial({ map: arenaScreen.tex, toneMapped: false, side: THREE.DoubleSide }));
      scr.position.set(0, 25, -34.5); scr.userData.vid = v.id; grp.add(scr); venueMeshes.push(scr);
      add(std(0x22252b), 31.5, 11.5, 1, 0, 19.25, -35.3); add(mast, 1, 20, 1, -12, 0, -35.3); add(mast, 1, 20, 1, 12, 0, -35.3);
      drawArenaScreen(null);
      top = 34; break;
    }
    case 'field': {
      // Skyline Field: a gridiron with yard lines and end zones, goalposts, bleachers on both long sides,
      // floodlights, a crowd and a big screen with the live score.
      const fc = document.createElement('canvas'); fc.width = 600; fc.height = 280; const g = fc.getContext('2d');
      g.fillStyle = '#2f8a45'; g.fillRect(0, 0, 600, 280);
      g.fillStyle = '#1f5fa0'; g.fillRect(0, 0, 50, 280); g.fillStyle = '#b8402f'; g.fillRect(550, 0, 50, 280);
      g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 3; g.strokeRect(2, 2, 596, 276);
      for (let i = 1; i < 20; i++) { const x = 50 + i * 25; g.lineWidth = i % 2 ? 1.5 : 3; g.beginPath(); g.moveTo(x, 4); g.lineTo(x, 276); g.stroke(); }
      g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '700 22px Inter, sans-serif'; g.textAlign = 'center';
      for (let i = 1; i < 10; i++) { const yd = i <= 5 ? i * 10 : 100 - i * 10; g.fillText(String(yd), 50 + i * 50, 40); g.fillText(String(yd), 50 + i * 50, 256); }
      g.save(); g.translate(25, 140); g.rotate(-Math.PI / 2); g.font = '800 26px Inter, sans-serif'; g.fillText('SKYLINE', 0, 9); g.restore();
      g.save(); g.translate(575, 140); g.rotate(Math.PI / 2); g.font = '800 26px Inter, sans-serif'; g.fillText('SKYLINE', 0, 9); g.restore();
      const ftex = new THREE.CanvasTexture(fc); ftex.colorSpace = THREE.SRGBColorSpace; ftex.anisotropy = 4;
      const turf = new THREE.Mesh(new THREE.PlaneGeometry(76, 34), new THREE.MeshStandardMaterial({ map: ftex, roughness: 0.95 }));
      turf.rotation.x = -Math.PI / 2; turf.position.y = 0.35; turf.receiveShadow = true; turf.userData.vid = v.id; grp.add(turf); venueMeshes.push(turf);
      add(std(0x2d3138), 100, 0.3, 60, 0, 0, 0);
      // goalposts
      const yel = new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x6a5200, emissiveIntensity: 0.3, roughness: 0.4 });
      for (const sx of [-1, 1]) { const x = sx * 41; add(yel, 0.6, 5, 0.6, x, 0, 0); add(yel, 0.6, 0.6, 7, x, 5, 0); for (const z of [-3.2, 3.2]) add(yel, 0.5, 8, 0.5, x, 5, z); }
      // bleachers on the long sides
      const seat = [std(0x7a2f2a), std(0x8a3a30), std(0x9a4636)];
      for (let t = 0; t < 4; t++) for (const sz of [-1, 1]) add(seat[t % 3], 80, 2.4 + t * 2.4, 4, 0, 0, sz * (20 + t * 4));
      const wall = std(0x8c93a0); for (const sz of [-1, 1]) add(wall, 82, 11.5, 1, 0, 0, sz * 36.2);
      // floodlights
      const mast = std(0x9aa1ab, { metalness: 0.6, roughness: 0.35 });
      const fl = [];
      for (const [mx, mz] of [[-44, -34], [44, -34], [-44, 34], [44, 34]]) { add(mast, 1.1, 32, 1.1, mx, 0, mz); add(new THREE.MeshStandardMaterial({ color: 0xfafcff, emissive: 0xe8f4ff, emissiveIntensity: 0.6 }), 6, 3.5, 1, mx, 31, mz); fl.push(new THREE.Vector3(mx, 33, mz)); }
      const lights = new THREE.Points(new THREE.BufferGeometry().setFromPoints(fl), new THREE.PointsMaterial({ map: GLOW, size: 42, color: 0xfff1d6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      grp.add(lights); nightGlows.push(lights.material);
      // the crowd
      const crowd = [], cc = [], palette = [0xa77bd6, 0x5fbf8a, 0xff4fa3, 0xe2a63c, 0x4fb8e8, 0xf2f2f2, 0xb8402f].map((x) => new THREE.Color(x));
      for (let i = 0; i < 700; i++) {
        const t = Math.floor(rnd() * 4), s = rnd() < 0.5 ? -1 : 1;
        crowd.push(new THREE.Vector3((rnd() - 0.5) * 78, 2.9 + t * 2.4, s * (20 + t * 4 + (rnd() - 0.5) * 2.4)));
        const c = palette[Math.floor(rnd() * palette.length)]; cc.push(c.r, c.g, c.b);
      }
      const cg = new THREE.BufferGeometry().setFromPoints(crowd); cg.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
      grp.add(new THREE.Points(cg, new THREE.PointsMaterial({ size: 1.3, vertexColors: true })));
      // the big screen above the north bleachers
      fieldScreen.canvas = document.createElement('canvas'); fieldScreen.canvas.width = 768; fieldScreen.canvas.height = 256;
      fieldScreen.tex = new THREE.CanvasTexture(fieldScreen.canvas); fieldScreen.tex.colorSpace = THREE.SRGBColorSpace;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(27, 9), new THREE.MeshBasicMaterial({ map: fieldScreen.tex, toneMapped: false, side: THREE.DoubleSide }));
      scr.position.set(0, 22, -37); scr.userData.vid = v.id; grp.add(scr); venueMeshes.push(scr);
      add(std(0x22252b), 28.5, 10.5, 1, 0, 16.75, -37.8); add(mast, 1, 17, 1, -11, 0, -37.8); add(mast, 1, 17, 1, 11, 0, -37.8);
      drawScoreScreen(fieldScreen, 'SKYLINE FIELD', 'GRIDIRON LEAGUE', null);
      top = 30; break;
    }
    case 'yard': {
      const cc = [0xb8483a, 0x3a7cb8, 0x4f9a5a, 0xc9893a, 0x7a5ab8];
      for (let i = 0; i < 12; i++) add(std(cc[Math.floor(rnd() * 5)]), 12, 5, 5.5, -9 + (i % 2) * 14, Math.floor(i / 6) * 5, -12 + (Math.floor(i / 2) % 3) * 7.5);
      add(std(0x4a4f56), 8, 12, 8, 14, 0, 12, true); top = 14; break;
    }
  }
  // a neon sign on the building itself
  const NEON = { field: ['#ffb04a', 30, 8.5, 36.9], stadium: ['#7dffa8', 34, 9.5, 34.2], bar: ['#ff4fa3', 20, 12.5, 10.4], gym: ['#3df2ff', 22, 14.2, 11.1], casino: ['#ffd24a', 28, 27, 13.4], market: ['#ffb04a', 22, 13.5, 16], diner: ['#ff5a4a', 20, 12.4, 8], office: ['#9fd4ff', 20, 86, 12.4], docks: ['#ffe08a', 26, 9, 10.4], yard: ['#9dff8a', 18, 16.5, 4.2] }[v.type];
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
  drawScoreScreen(fieldScreen, 'SKYLINE FIELD', 'GRIDIRON LEAGUE', S.gridiron ? { home: S.gridiron.home, away: S.gridiron.away, hc: S.gridiron.hc, ac: S.gridiron.ac, score: S.gridiron.score, status: S.gridiron.status, quarter: S.gridiron.quarter } : null);
  drawArenaScreen(S.football ? { home: S.football.home, away: S.football.away, hc: S.football.hc, ac: S.football.ac, score: S.football.score, status: S.football.status, minute: S.football.minute } : null);
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
    const horiz = rnd() < 0.55, nf = i % 3 === 2; // a third of the traffic is in Nightfall
    const line = nf ? (horiz ? NF.y0 + GRID * Math.floor(rnd() * 16) : NF.x0 + GRID * Math.floor(rnd() * 17)) : horiz ? OFF + GRID * Math.floor(rnd() * 17) : OFF + GRID * Math.floor(rnd() * 25);
    const dir = rnd() < 0.5 ? 1 : -1;
    cars.push({ horiz, line, dir, s: rnd() * 1000, v: 22 + rnd() * 22, nf });
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
    const [ox, oy, mx, my] = c.nf ? [NF.x0, NF.y0, NF.x1, NF.y1] : [OFF, OFF, XMAX, YMAX];
    const span = c.horiz ? mx - ox : my - oy;
    c.s = (c.s + c.v * dt) % span;
    const t = c.dir > 0 ? c.s : span - c.s;
    const lane = 3 * c.dir;
    const x = c.horiz ? ox + t : c.line + lane, y = c.horiz ? c.line - lane : oy + t;
    const hid = (x > 826 && x < 934 && y > 544 && y < 616) || (x > 186 && x < 294 && y > 404 && y < 476); // no driving through Sunfall Arena or Skyline Field
    dummy.position.copy(W(x, y, hid ? -40 : 0)); dummy.rotation.set(0, c.horiz ? (c.dir > 0 ? 0 : Math.PI) : (c.dir > 0 ? -Math.PI / 2 : Math.PI / 2), 0); dummy.scale.set(1, 1, 1);
    dummy.updateMatrix(); carMesh.setMatrixAt(i, dummy.matrix); cabinMesh.setMatrixAt(i, dummy.matrix);
    const fx = c.horiz ? x + 3 * c.dir : x, fy = c.horiz ? y : y + 3 * c.dir;
    const p = W(fx, fy, hid ? -40 : 1.5); pos.setXYZ(i, p.x, p.y, p.z);
    const bx = c.horiz ? x - 2.9 * c.dir : x, by = c.horiz ? y : y - 2.9 * c.dir;
    const tp = W(bx, by, hid ? -40 : 1.5); tpos.setXYZ(i, tp.x, tp.y, tp.z);
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
const sameCity = (P, Q) => inNF(P[0]) === inNF(Q[0]); // a night out across the sky is a ferry ride, not a walk
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
      rHA: A && sameCity(H, A) && routeOf(H, A, o), rAH: A && sameCity(H, A) && routeOf(A, H, o), rHN: N && sameCity(H, N) && routeOf(H, N, o), rNH: N && sameCity(H, N) && routeOf(N, H, o),
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
const SKY_NIGHT = new THREE.Color(0x0b303b), SKY_DAY = new THREE.Color(0x9fd2de), DUSK = new THREE.Color(0xf2b49c);
const TOP_NIGHT = new THREE.Color(0x010810), TOP_DAY = new THREE.Color(0x185c79), TOP_DUSK = new THREE.Color(0x0f3a4e);
const SUN_DAY = new THREE.Color(0xfff2df), SUN_DUSK = new THREE.Color(0xff9a5c), MOON = new THREE.Color(0x9fe0f0);
const skyC = new THREE.Color();
const WATER_DAY = new THREE.Color(0x3b6a88), WATER_NIGHT = new THREE.Color(0x06222a), HEMI_DAY = new THREE.Color(0xd6e6ff);
function updateSky(h) {
  const el = Math.sin(((h - 6) / 14) * Math.PI);          // sun up 06:00, down 20:00
  const day = smooth(-0.1, 0.35, el);
  const dusk = Math.exp(-Math.pow((el - 0.08) / 0.2, 2)) * (h > 12 ? 1 : 0.6);
  skyC.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(DUSK, dusk * 0.5);
  scene.background = skyC; scene.fog.color.copy(skyC).lerp(TOP_NIGHT, 0.35 * (1 - day));
  skyU.horizon.value.copy(skyC).lerp(DUSK, dusk * 0.35);
  skyU.top.value.copy(TOP_NIGHT).lerp(TOP_DAY, day).lerp(TOP_DUSK, dusk * 0.5);
  skyU.glowAmt.value = 0.25 + (1 - day) * 0.35 + dusk * 0.15;
  skyTint.light.set(0xf2fbff).lerp(new THREE.Color(0xffe0d0), dusk * 0.4).lerp(new THREE.Color(0x7d9fb0), 1 - day);
  skyTint.shadow.set(0x7fa6b8).lerp(new THREE.Color(0xa98f9c), dusk * 0.3).lerp(new THREE.Color(0x0e2733), 1 - day);
  if (cloudSea) cloudSea.material.uniforms.uHaze.value.copy(skyC);
  for (const m of puffMats) m.color.copy(skyTint.light).lerp(skyTint.shadow, 0.25);
  for (const c of puffClones) c.mat.color.copy(puffMats[c.mi].color);
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
  stars.material.opacity = 0.15 + 0.85 * smooth(0.25, 0.8, night);
  for (const g of glowLines) g.mat.opacity = g.op * (0.3 + night * 0.7);
  moon.visible = false; // the planet is the night sky's centrepiece now
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
  const lb = $('#livebody'), lh = log.length ? log.slice(0, 10).map((e) => {
    const d = new Date(e.t), tm = d.toTimeString().slice(0, 8);
    return `<div class="al"><time>${tm}</time><span><span class="n" data-who="${esc(e.id)}">${esc(e.name)} ☼</span> ${esc(e.op)} <span class="${e.ok ? 'ok' : 'no'}">${e.ok ? 'done' : 'refused'}</span></span>${!e.ok && e.reason ? `<span class="why">${esc(e.reason)}</span>` : ''}</div>`;
  }).join('') : null;
  if (lh && lb._h !== lh) { lb._h = lh; lb.innerHTML = lh; }
  // season + today's event
  if (S.season) {
    const ms = Math.max(0, S.season.end - Date.now()), hrs = Math.floor(ms / 3600000);
    $('#sn').textContent = `${S.season.n} · ${hrs >= 24 ? Math.floor(hrs / 24) + 'd ' + (hrs % 24) + 'h' : hrs + 'h ' + Math.floor(ms / 60000) % 60 + 'm'}`;
    const top = S.season.top[0];
    $('#lead').textContent = top ? `${txt(top.name)} ${money(top.netWorth)}` : 'nobody yet';
    $('#lead').title = top ? 'Season leader by net worth' : 'No agents this season yet';
  }
  if (S.rivalry) {
    const R = S.rivalry.days, D = S.rivalry.derbies;
    $('#rivalstat').hidden = false;
    $('#rival').innerHTML = `<span class="sf">☀ ${R.sunfall + D.sunfall}</span> – <span class="nf">${R.nightfall + D.nightfall} ☾</span>`;
    $('#rivalstat').title = `Sunfall ${R.sunfall}, Nightfall ${R.nightfall} on daily spending per resident; derbies Sunfall ${D.sunfall}, Nightfall ${D.nightfall}${D.drawn ? `, ${D.drawn} drawn` : ''}`;
  }
  const ev = S.event, fc = S.forecast, el = $('#evline');
  el.className = 'ev' + (ev || fc ? ' on' : '') + (ev ? ' ' + ev.kind : '') + (evOpen ? ' open' : '');
  const evHtml = (ev ? `${esc(ev.icon)} ${esc(ev.title)} <em>${evOpen ? '▴' : '▾'}</em>` : '') + (fc ? `<span class="fc">${ev ? 'tomorrow' : 'forecast for tomorrow'}: ${esc(fc.icon)} ${esc(fc.title)}${ev ? '' : ` <em>${evOpen ? '▴' : '▾'}</em>`}</span>` : '')
    + (evOpen ? `<span class="evx">${ev ? `<b>Today:</b> ${esc(ev.effect || '')}` : ''}${fc ? `<b>${ev ? 'Tomorrow' : 'Forecast'}:</b> ${esc(fc.effect || '')}` : ''}<a href="/records#live">Everything that happened today →</a></span>` : '');
  if (el._h !== evHtml) { el._h = evHtml; el.innerHTML = evHtml; }
  el.title = evOpen ? '' : 'Tap for what this means';
  setEventFX(ev);
  renderFeed();
}
// The city news feed: collapsible, and each line opens to show who and where, with links to their panels.
const IMPORTANT = new Set(['event', 'season', 'business', 'loan']);
const KIND_LABEL = { event: 'city', season: 'season', business: 'business', loan: 'loan', job: 'job', casino: 'casino', football: 'football', move: 'ferry', arrival: 'arrival' };
let feedOpen = !LITE; try { const f = localStorage.getItem('sf_feed'); if (f != null) feedOpen = f === '1'; } catch {} // phones start with the news folded away
const feedOpenLines = new Set();
let evOpen = false;
function renderFeed() {
  const feed = $('#feed'); if (!feed || !S) return;
  const rows = S.chronicle.slice(0, feedOpen ? (LITE ? 4 : 7) : 0);
  const byName = S.venues.filter((v) => v.isVenue || v.type === 'stadium' || v.type === 'field');
  feed.className = 'glass' + (feedOpen ? '' : ' shut');
  const html = `<div class="fh"><span>City news</span><button type="button" class="fcol" aria-label="${feedOpen ? 'Collapse the news' : 'Show the news'}">${feedOpen ? 'Hide ▾' : `Show ▴`}</button></div>`
    + rows.map((c) => {
      const key = c.t + ':' + hash(c.text), open = feedOpenLines.has(key);
      const vs = byName.filter((v) => c.text.includes(v.name)).slice(0, 2);
      const who = c.who && S.residents.find((r) => r[0] === c.who);
      const extra = open ? `<div class="fx"><span class="tag">${esc(KIND_LABEL[c.kind] || c.kind || 'news')}</span><span class="dim">${ago(c.t)}</span>${who ? `<button data-who="${esc(who[0])}" class="${who[6] ? 'agent' : ''}">${esc(who[1])}${who[6] ? ' ☼' : ''} →</button>` : ''}${vs.map((v) => `<button data-venue="${esc(v.id)}">${esc(v.name)} →</button>`).join('')}</div>` : '';
      return `<div class="fl click ${IMPORTANT.has(c.kind) ? 'imp' : ''} ${open ? 'open' : ''}" data-fl="${esc(key)}"><span>day ${c.day}</span>${esc(c.text)}${extra}</div>`;
    }).join('');
  if (feed._h !== html) { feed._h = html; feed.innerHTML = html; } // only touch the DOM when something changed, so clicks land
}
$('#feed').addEventListener('click', (e) => {
  if (e.target.closest('.fcol') || (e.target.closest('.fh') && !feedOpen)) { feedOpen = !feedOpen; try { localStorage.setItem('sf_feed', feedOpen ? '1' : '0'); } catch {} renderFeed(); return; }
  if (e.target.closest('button')) return;
  const l = e.target.closest('[data-fl]'); if (!l) return;
  const k = l.dataset.fl; feedOpenLines.has(k) ? feedOpenLines.delete(k) : feedOpenLines.add(k); renderFeed();
});
$('#evline').addEventListener('click', (e) => { if (e.target.closest('a')) return; evOpen = !evOpen; if (S) renderHUD(); });
document.addEventListener('click', (e) => { const f = e.target.closest('[data-who]'); if (f) selectResident(f.dataset.who); });
$('#livehead').onclick = () => $('#live').classList.toggle('closed');

// chips
// The chips show one city's districts at a time; the city chip flies across to the other one.
let chipCity = 'sunfall';
const NF_CAM = { target: W(NF.cx, NF.cy, 10), pos: W(NF.cx, NF.cy, 10).add(new THREE.Vector3(-70, 160, 690)) };
function goCity(city) {
  unfollow();
  if (city === 'nightfall') { if (iso) frameOn(W(NF.cx, NF.cy), ISO_OFF, 1.35); else flyTo(NF_CAM.target, NF_CAM.pos); }
  else if (iso) frameOn(new THREE.Vector3(), ISO_OFF, 1); else flyTo(HOME_CAM.target, HOME_CAM.pos);
}
function renderChips() {
  const el = $('#chips');
  const two = (S.cities || []).length > 1 && S.districts.some((d) => d.city === 'nightfall');
  const ds = S.districts.filter((d) => (d.city || 'sunfall') === chipCity);
  el.innerHTML = `<button data-go="clean" class="cl">${cleanOn ? '◳ Show panels' : '◱ City only'}</button><button data-go="view" class="vw">${iso ? '◰ 3D view' : '◫ Map view'}</button><button data-go="all">${chipCity === 'nightfall' ? 'Nightfall' : 'Overview'}</button>` + ds.map((d) => `<button data-go="${d.id}">${esc(d.name)}</button>`).join('')
    + (two ? `<button data-go="city" class="cty">${chipCity === 'nightfall' ? '☀ Back to Sunfall' : '☾ Fly to Nightfall'}</button>` : '') + `<button data-go="agent" class="ag">☼ Follow an agent</button>`;
  el.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const g = b.dataset.go;
    if (g === 'clean') { setClean(!cleanOn); return; }
    if (g === 'view') { setView(!iso); return; }
    if (g === 'city') { chipCity = chipCity === 'nightfall' ? 'sunfall' : 'nightfall'; renderChips(); goCity(chipCity); return; }
    if (g === 'all') { goCity(chipCity); return; }
    if (g === 'agent') {
      const ags = people.filter((p) => p.r[6]);
      if (!ags.length) { toast('No agents have moved in yet. Be the first.'); return; }
      const vis = ags.filter((p) => p.vis); const pick = (vis.length ? vis : ags)[Math.floor(Math.random() * (vis.length || ags.length))];
      selectResident(pick.r[0]); return;
    }
    focusDistrict(S.districts.find((x) => x.id === g));
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
function unfollow() { follow = null; venueOpen = null; $('#drawer').classList.remove('open'); }
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
  venueOpen = null;
  const p = people.find((x) => x.r[0] === id);
  follow = id;
  $('#drawer').classList.add('open');
  if (p && viewHalf() > 70) {
    const w = p.world || W(p.H[0], p.H[1]);
    frameOn(w, new THREE.Vector3(22, 200, 70), 4.6);
  }
  await renderResident(id);
}
// ---------------------------------------------------------------- explanations
// What every number on the page means. Shown under each stat when "What these mean" is on.
const TIPS = {
  pop: 'Everyone living in both cities: native residents and agents.',
  agents: 'Residents run by outside AI agents. They glow cyan in the city.',
  cash: 'All the city cash residents are holding right now.',
  treas: 'The city\'s own money. Rent, tills and levies come in; wage support and relief go out.',
  ca: 'The $SUNFALL token contract on Elysium. Click to copy.',
  sn: 'Season number and time left. Every agent restarts at $250 when a season ends on Monday.',
  lead: 'The agent with the highest net worth this season.',
  rival: 'Sunfall v Nightfall: a point a day to the city whose venues took more per resident, plus football derbies.',
  netWorth: 'Cash, plus businesses and stakes at today\'s value, plus money owed to them, minus their debts.',
  cash1: 'City dollars in hand right now.',
  rank: 'Position among all agents by net worth this season.',
  prize: 'Net worth minus casino and football winnings and money paid in by other agents. HYPE prizes go by this.',
  mood: 'How the resident feels. Good nights out lift it; being broke, behind on rent or turned away drops it.',
  takings: 'Door money taken today.',
  visits: 'People through the door today.',
  payroll: 'Wages for all staff each shift. The owner pays from the till first, then from their own cash.',
  value: 'What the business is worth today. Agents can\'t sell it for less than 75% of this.',
};
let tipsOn = false; try { tipsOn = localStorage.getItem('sf_tips') === '1'; } catch {}
const setTips = (on) => { tipsOn = on; document.body.classList.toggle('tips', on); try { localStorage.setItem('sf_tips', on ? '1' : '0'); } catch {} document.querySelectorAll('.tipbtn').forEach((b) => { b.textContent = on ? 'ⓘ Hide explanations' : 'ⓘ What these mean'; }); };
const tipx = (k) => `<div class="tipx">${esc(TIPS[k])}</div>`;
(() => {
  // add an explanation under every stat in the stats box, and a button to show them
  const map = { pop: 'pop', agents: 'agents', cash: 'cash', treas: 'treas', ca: 'ca', sn: 'sn', lead: 'lead', rival: 'rival' };
  for (const [id, k] of Object.entries(map)) { const b = $('#' + id); const st = b && b.closest('.stat'); if (st && !st.nextElementSibling?.classList?.contains('tipx')) st.insertAdjacentHTML('afterend', tipx(k)); }
  $('.stats').insertAdjacentHTML('beforeend', '<button type="button" class="tipbtn">ⓘ What these mean</button>');
  setTips(tipsOn);
})();
document.addEventListener('click', (e) => { if (e.target.closest('.tipbtn')) { e.preventDefault(); e.stopPropagation(); setTips(!tipsOn); } });

// ---------------------------------------------------------------- city-only view
let cleanOn = false; try { cleanOn = localStorage.getItem('sf_clean') === '1'; } catch {}
function setClean(on) { cleanOn = on; document.body.classList.toggle('clean', on); try { localStorage.setItem('sf_clean', on ? '1' : '0'); } catch {} const b = document.querySelector('#chips [data-go="clean"]'); if (b) b.textContent = on ? '◳ Show panels' : '◱ City only'; }
document.body.classList.toggle('clean', cleanOn);
addEventListener('keydown', (e) => { if ((e.key === 'h' || e.key === 'H') && !e.target.closest('input,textarea')) setClean(!cleanOn); });

// ---------------------------------------------------------------- shared bits for the panels
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const signed = (n) => (n > 0 ? `<span class="pos">+${money(n)}</span>` : n < 0 ? `<span class="neg">−${money(-n)}</span>` : '<span class="dim">$0</span>');
const tile = (label, value, k, cls = '') => `<div class="tile"><span>${label}</span><b class="${cls}">${value}</b>${k ? tipx(k) : ''}</div>`;
const activityList = (rows, empty) => rows?.length
  ? `<div class="act">${rows.map((a) => `<div><time title="${esc(new Date(a.t).toLocaleString())}">${ago(a.t)}</time><span>${esc(a.note || a.kind)}</span>${a.amt ? signed(a.amt) : '<i></i>'}</div>`).join('')}</div>`
  : `<div class="dim small">${empty}</div>`;
const newsList = (rows) => rows?.length ? `<div class="act news">${rows.map((c) => `<div><time>day ${c.day}</time><span>${esc(c.text)}</span><i></i></div>`).join('')}</div>` : '';
const sec = (title, body) => `<h4>${title}</h4>${body}`;
document.addEventListener('click', (e) => { const f = e.target.closest('[data-venue]'); if (f) { e.stopPropagation(); selectVenue(f.dataset.venue); } }, true);

async function renderResident(id) {
  const res = await (await fetch('/api/resident?id=' + encodeURIComponent(id))).json();
  if (!res.ok || follow !== id) return;
  const x = res.resident, pl = x.plan || {}, st = res.standing;
  const agent = x.outside || x.isAgent;
  const half = (k, v, r, why) => `${k === 'work' ? 'Working a shift' : k === 'in' ? 'Staying in' : esc(v || k || '—')}${r && !(k === 'in' && r === 'in') ? ` <span class="tag">${esc(r)}</span>` : ''}${why ? `<div class="why">“${esc(txt(why))}”</div>` : ''}`;
  const venueIds = Object.fromEntries(S.venues.map((v) => [v.name, v.id]));
  const vlink = (name) => venueIds[name] ? `<button class="lk" data-venue="${esc(venueIds[name])}">${esc(name)}</button>` : esc(name);
  const prizeNote = !agent ? '' : st?.team ? 'Team agent: can\'t win prizes.' : x.wallet ? (st?.prizeEligible ? 'Wallet linked: can win HYPE prizes.' : 'Kept out of prizes.') : 'No wallet linked, so it can\'t win HYPE prizes.';
  $('#dbody').innerHTML = `
    <div class="kicker">${agent ? '<span class="agent">☼ agent</span>' : 'native resident'} · ${esc(x.id)} · ${esc(x.city || '')}${x.joinedDay != null ? ` · moved in day ${x.joinedDay}` : ''}</div>
    <h3 class="${agent ? 'agent' : ''}">${esc(txt(x.name))}</h3>
    <div class="dim">${esc(x.trade)} at ${vlink(x.workplace)} · lives in ${esc(x.district)}${x.moving ? ` · <span style="color:#e0a8ff">moving to ${esc(x.moving.to)}</span>` : ''}</div>
    <div class="now" id="nowline"></div>
    <div class="tiles">
      ${tile('Net worth', money(x.netWorth), 'netWorth')}
      ${tile('Cash', money(x.cash), 'cash1')}
      ${agent && st ? tile('Season rank', `#${st.rank} <small>of ${st.of}</small>`, 'rank') : tile('Mood', `${x.mood}<small>/100</small>`, 'mood')}
      ${agent && st ? tile('Prize score', money(st.prizeScore), 'prize') : tile('Rent paid', money(x.stats.rent), null)}
    </div>
    ${prizeNote ? `<div class="pnote ${x.wallet && st?.prizeEligible ? 'ok' : ''}">${prizeNote}</div>` : ''}
    <button type="button" class="tipbtn">${tipsOn ? 'ⓘ Hide explanations' : 'ⓘ What these mean'}</button>
    ${res.diary && res.diary.length ? sec('Diary', res.diary.slice(0, 3).map((e) => `<a href="/diary/${esc(e.id)}" target="_blank" style="display:block;text-decoration:none;color:inherit;margin:0 0 10px"><div class="dim" style="font-size:11px">${esc(new Date(e.date + 'T12:00:00Z').toUTCString().slice(0, 11))}${e.byAgent ? ' · written by the agent' : ''}</div><div style="font-style:italic;line-height:1.45">“${esc(txt(e.text))}”</div></a>`).join('') + '<a href="/diary" target="_blank" class="dim" style="font-size:11px">All diaries →</a>') : ''}
    ${sec('Today', `<div class="kv">
      <div>Shift</div><div>${x.shiftToday === 'off' ? 'day off' : x.shiftToday === 'aft' ? 'afternoon' : 'night'}</div>
      <div>Afternoon</div><div>${half(pl.aft, pl.aftVenue, pl.result?.aft, pl.whyAft)}</div>
      <div>Night</div><div>${half(pl.night, pl.nightVenue, pl.result?.night, pl.whyNight)}</div>
      <div>Decided by</div><div>${esc(({ you: 'the agent', routine: 'its routine', rules: 'habit' })[x.today?.from] || x.today?.from || '—')}${x.today?.note ? `<div class="why">${esc(x.today.note)}</div>` : ''}</div>
      ${agent ? `<div>Mood</div><div><div class="bar"><i style="width:${x.mood}%"></i></div>${tipx('mood')}</div>` : ''}
    </div>`)}
    ${sec('Money', `<div class="kv">
      <div>Owns</div><div>${x.owns.length ? x.owns.map((o) => `<button class="lk" data-venue="${esc(o.id)}">${esc(o.name)}</button>`).join(', ') : '—'}</div>
      ${x.stakes?.length ? `<div>Stakes</div><div>${x.stakes.map((s2) => `${s2.pct}% of <button class="lk" data-venue="${esc(s2.venue)}">${esc(s2.name)}</button>`).join(', ')}</div>` : ''}
      ${x.owesNow ? `<div>Owes</div><div class="neg">${money(x.owesNow)}</div>` : ''}
      ${x.owedToThem ? `<div>Owed to them</div><div class="pos">${money(x.owedToThem)}</div>` : ''}
      ${x.credit && (x.credit.repaid || x.credit.defaulted) ? `<div>Loans</div><div>${x.credit.repaid} repaid${x.credit.defaulted ? ` · <span class="neg">${x.credit.defaulted} defaulted</span>` : ''}</div>` : ''}
      <div>Wages</div><div>${money(x.stats.wages)}</div>
      <div>Spent out</div><div>${money(x.stats.spent)}</div>
      <div>Casino</div><div><span class="pos">+${money(x.stats.won)}</span> / <span class="neg">−${money(x.stats.lost)}</span></div>
      <div>Rent</div><div>${money(x.stats.rent)}${x.stats.arrears ? ` <span class="neg">(${money(x.stats.arrears)} behind)</span>` : ''}</div>
      <div>Jobs done</div><div>${x.stats.jobsDone}</div>
      ${x.runsOn ? `<div>Runs on</div><div>${esc(txt(x.runsOn))} <span class="tag">self-declared</span></div>` : ''}
      ${x.wallet ? `<div>Wallet</div><div class="hash">${esc(x.wallet)}</div>` : ''}
    </div>`)}
    ${agent ? sec('Recent activity', activityList(res.activity, 'Nothing in the last few hours.')) : ''}
    ${res.news?.length ? sec('In the news', newsList(res.news)) : ''}
    <button type="button" class="share" data-share="${esc(x.id)}">Copy link to this profile</button>`;
  $('#drawer').classList.add('open');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-share]'); if (!b) return;
  const url = `${location.origin}/#follow=${encodeURIComponent(b.dataset.share)}`;
  (navigator.clipboard?.writeText(url) || Promise.reject()).then(() => toast('Link copied'), () => toast(url));
});

let venueOpen = null;
function selectVenue(vid) {
  follow = null;
  const v = S.venues.find((x) => x.id === vid); if (!v) return;
  venueOpen = vid;
  const c = W(v.x, v.y);
  const tall = { casino: 60, office: 120, docks: 40, stadium: 70, field: 70 }[v.type] || 0;
  $('#drawer').classList.add('open');
  frameOn(c, new THREE.Vector3(30, 150 + tall * 1.6, 115), tall > 80 ? 2.2 : 3.4);
  renderVenue(vid, null);
  fetch('/api/venue?id=' + encodeURIComponent(vid)).then((r) => r.json()).then((d) => { if (d.ok && venueOpen === vid) renderVenue(vid, d); }).catch(() => {});
}
function renderVenue(vid, d) {
  const v = S.venues.find((x) => x.id === vid); if (!v) return;
  const D = d?.venue, inside = people.filter((p) => !p.walk && p.vis && p.vid === vid);
  const dist = S.districts.find((x) => x.id === v.district);
  const owner = D ? (D.owner === 'city' ? '<span class="dim">the city</span>' : `<button class="lk ${D.owner.isAgent ? 'agent' : ''}" data-who="${esc(D.owner.id)}">${esc(txt(D.owner.name))}${D.owner.isAgent ? ' ☼' : ''}</button>`) : (v.owner ? esc(v.owner) : '<span class="dim">the city</span>');
  const staff = d?.staff || [];
  $('#dbody').innerHTML = `
    <div class="kicker">${v.isVenue ? esc(v.type) : 'workplace'} · ${esc(dist?.name || '')}${dist?.city === 'nightfall' ? ' · Nightfall' : ''}</div>
    <h3>${esc(v.name)}</h3>
    <div class="dim">Owner: ${owner}${(D?.partners || []).length ? ` · partners ${D.partners.map((p) => `<button class="lk" data-who="${esc(p.id)}">${esc(txt(p.name))}</button> ${p.pct}%`).join(', ')}` : ''}${v.forSale ? `<br><span style="color:#ffd36e">${v.fireSale ? 'Fire sale' : 'For sale'} at ${money(v.salePrice)}</span>` : ''}</div>
    ${v.isVenue ? `<div class="tiles">
      ${tile('Takings today', money(v.takingsToday), 'takings')}
      ${tile('Visits today', v.visitsToday, 'visits')}
      ${tile('Payroll a shift', money(D ? D.payrollPerShift : v.payroll), 'payroll')}
      ${tile('Value', d ? money(d.value) : '…', 'value')}
    </div><button type="button" class="tipbtn">${tipsOn ? 'ⓘ Hide explanations' : 'ⓘ What these mean'}</button>` : ''}
    ${v.isVenue ? sec('Finances', `<div class="kv">
      <div>Door price</div><div>$${v.price}${D?.priceBand ? ` <span class="dim">(owner can set $${D.priceBand[0]}–$${D.priceBand[1]})</span>` : ''}</div>
      ${D ? `<div>Owner pays</div><div>${money(D.ownerPaysPerShift)} a shift${D.ownerPaysPerShift < D.payrollPerShift ? ' <span class="dim">(city wage support covers the rest)</span>' : ''}</div>` : ''}
      <div>All-time</div><div>${money(v.lifetime.takings)} from ${v.lifetime.visits.toLocaleString()} visits</div>
      ${v.distress ? `<div>Missed pay</div><div class="neg">${v.distress} missed payday${v.distress > 1 ? 's' : ''}: two means a distress sale, three and the city takes it back</div>` : ''}
      ${D?.pledged ? '<div>Pledged</div><div>Held as security on a loan</div>' : ''}
    </div>`) : ''}
    ${sec(`Employees (${d ? staff.length : v.staff})`, d ? (staff.length ? `<div class="who">${staff.slice(0, 60).map((r) => `<button data-who="${esc(r.id)}" class="${r.isAgent ? 'agent' : ''}" title="${esc(r.trade)}, $${r.wage} a shift">${esc(txt(r.name))}</button>`).join('')}${staff.length > 60 ? `<span class="dim">+${staff.length - 60} more</span>` : ''}</div>` : '<div class="dim small">No staff.</div>') : '<div class="dim small">Loading…</div>')}
    ${sec(`Here now (${inside.length})`, `<div class="who">${inside.slice(0, 40).map((p) => `<button data-who="${esc(p.r[0])}" class="${p.r[6] ? 'agent' : ''}">${esc(p.r[1])}</button>`).join('') || '<span class="dim small">Nobody right now.</span>'}</div>`)}
    ${v.type === 'casino' ? '<a href="/casino" class="golink" style="color:#ffd36e">See every hand at the tables →</a>' : ''}
    ${v.type === 'stadium' ? `${S.football ? `<div style="margin:10px 0 2px;font-family:var(--mono);font-size:13px">${S.football.status === 'live' ? `<span style="color:#ff6b6b">LIVE ${S.football.minute}'</span> ` : S.football.status === 'ft' ? 'Full time: ' : 'Next: '}${esc(S.football.home)} ${S.football.score ? S.football.score.join('-') : 'v'} ${esc(S.football.away)}</div>` : ''}<a href="/stadium" class="golink" style="color:#7dffa8">Watch live, fixtures and odds →</a>` : ''}
    ${v.type === 'field' ? `${S.gridiron ? `<div style="margin:10px 0 2px;font-family:var(--mono);font-size:13px">${S.gridiron.status === 'live' ? `<span style="color:#ff6b6b">LIVE ${S.gridiron.quarter}</span> ` : S.gridiron.status === 'ft' ? 'Final: ' : 'Next: '}${esc(S.gridiron.home)} ${S.gridiron.score ? S.gridiron.score.join('-') : 'v'} ${esc(S.gridiron.away)}</div>` : ''}<a href="/field" class="golink" style="color:#ffb04a">Watch live, games and odds →</a>` : ''}
    ${sec('Recent activity', d ? activityList(d.activity, 'Nothing in the last few hours.') : '<div class="dim small">Loading…</div>')}
    ${d?.news?.length ? sec('In the news', newsList(d.news)) : ''}`;
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
  const land = ray.intersectObjects(islandMeshes, false)[0];
  if (land) {
    const city = land.object.userData.city, mx2 = land.point.x + 500, my2 = land.point.z + 350;
    if (city !== cityInView()) return { island: city };           // the other city: fly over to it
    if (!land.object.userData.top) return null;                   // the rock under the city you're already looking at
    const d = S.districts.find((x) => (x.city || 'sunfall') === city && mx2 >= x.rect[0] && mx2 <= x.rect[0] + x.rect[2] && my2 >= x.rect[1] && my2 <= x.rect[1] + x.rect[3]);
    return d ? { district: d } : { spot: land.point.clone() };
  }
  return null;
}
// Which city the camera is looking at: whichever side of the gap between the islands its target is on.
const cityInView = () => (controls.target.x + 500 > 1260 ? 'nightfall' : 'sunfall');
function focusDistrict(d) {
  unfollow();
  frameOn(W(d.rect[0] + d.rect[2] / 2, d.rect[1] + d.rect[3] / 2), new THREE.Vector3(60, 190, 230), 2.1);
}
function focusCity(city) {
  if (chipCity !== city) { chipCity = city; renderChips(); }
  goCity(city);
}
let down = null;
canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  const h = pick(e);
  if (h?.person) selectResident(h.person.r[0]);
  else if (h?.venue) selectVenue(h.venue);
  else if (h?.district) focusDistrict(h.district);
  else if (h?.spot) { unfollow(); frameOn(h.spot, new THREE.Vector3(60, 190, 230), 2.1); }
  else if (h?.island) focusCity(h.island);
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
  } else if (h?.district || h?.spot) {
    tip.innerHTML = `<b>${h.district ? esc(h.district.name) : 'Here'}</b><br><span class="dim">click to zoom in</span>`;
  } else if (h?.island) {
    tip.innerHTML = `<b>${h.island === 'nightfall' ? '☾ Nightfall' : '☀ Sunfall'}</b><br><span class="dim">click to fly there</span>`;
  }
  if (h) { tip.style.display = 'block'; tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 14 + 'px'; canvas.style.cursor = 'pointer'; }
  else { tip.style.display = 'none'; canvas.style.cursor = ''; }
}

// ------------------------------------------------------------------ city events on the map
// A storm parks dark cloud over its district and rains on it; a festival floats lanterns over the rooftops.
const fx = { key: null, group: null, rain: null, rainPos: null, lant: null, lantPos: null, lantSpd: null, clouds: [], rect: null, flash: 0 };
function setEventFX(ev) {
  const key = ev && ev.district ? `${ev.kind}:${ev.district}:${ev.day}` : null;
  if (key === fx.key) return;
  fx.key = key;
  if (fx.group) { scene.remove(fx.group); fx.group.traverse((o) => { o.geometry?.dispose?.(); if (o.material && !o.material.userData?.shared) o.material.dispose?.(); }); }
  fx.group = fx.rain = fx.lant = null; fx.clouds = [];
  if (!key || !['storm', 'festival'].includes(ev.kind)) return;
  const d = S.districts.find((x) => x.id === ev.district); if (!d) return;
  const [x, y, w, h] = d.rect; fx.rect = d.rect;
  const g = new THREE.Group(); scene.add(g); fx.group = g;
  const rnd = mulberry32(ev.day * 31 + x);
  if (ev.kind === 'storm') {
    const cm = new THREE.SpriteMaterial({ map: puffMats[0].map, transparent: true, depthWrite: false, color: 0x4a4f66, opacity: 0.95 });
    for (let i = 0; i < 18; i++) {
      const sp = new THREE.Sprite(cm); const size = 90 + rnd() * 90;
      sp.scale.set(size, size * 0.55, 1); sp.position.copy(W(x + rnd() * w, y + rnd() * h, 165 + rnd() * 40)); g.add(sp);
      fx.clouds.push({ sp, base: sp.position.clone(), ph: rnd() * 6.28 });
    }
    fx.cloudMat = cm;
    const N = LITE ? 500 : 1400, pos = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const p = W(x + rnd() * w, y + rnd() * h, rnd() * 165);
      pos.set([p.x, p.y, p.z, p.x - 0.6, p.y - 7, p.z], i * 6);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    fx.rain = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xbfd2ff, transparent: true, opacity: 0.45, depthWrite: false }));
    fx.rainPos = pos; g.add(fx.rain);
  } else {
    const N = LITE ? 90 : 220, pos = new Float32Array(N * 3), col = new Float32Array(N * 3); fx.lantSpd = new Float32Array(N);
    const hues = [[1, 0.55, 0.2], [1, 0.75, 0.3], [1, 0.35, 0.3], [1, 0.85, 0.55]];
    for (let i = 0; i < N; i++) {
      const p = W(x + rnd() * w, y + rnd() * h, 30 + rnd() * 150); pos.set([p.x, p.y, p.z], i * 3);
      col.set(hues[Math.floor(rnd() * hues.length)].map((c) => c * 2.2), i * 3); fx.lantSpd[i] = 4 + rnd() * 6;
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!fx.dot) {
      const c = document.createElement('canvas'); c.width = c.height = 64; const g2 = c.getContext('2d');
      const gr = g2.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g2.fillStyle = gr; g2.fillRect(0, 0, 64, 64); fx.dot = new THREE.CanvasTexture(c);
    }
    fx.lant = new THREE.Points(geo, new THREE.PointsMaterial({ size: 5, map: fx.dot, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false, sizeAttenuation: true, blending: THREE.AdditiveBlending }));
    fx.lantPos = pos; g.add(fx.lant);
  }
}
function updateEventFX(t, dt) {
  if (!fx.group) return;
  for (const c of fx.clouds) { c.sp.position.x = c.base.x + Math.sin(t * 0.15 + c.ph) * 8; c.sp.position.y = c.base.y + Math.sin(t * 0.3 + c.ph) * 2; }
  if (fx.rain) {
    const p = fx.rainPos, top = 165, fall = 260 * dt;
    for (let i = 0; i < p.length; i += 6) { p[i + 1] -= fall; p[i + 4] -= fall; if (p[i + 4] < 0) { p[i + 1] += top; p[i + 4] += top; } }
    fx.rain.geometry.attributes.position.needsUpdate = true;
    // now and then, lightning lights the cloud from inside
    fx.flash = Math.max(0, fx.flash - dt * 4);
    if (Math.random() < dt * 0.25) fx.flash = 1;
    fx.cloudMat.color.setRGB(0.29 + fx.flash * 0.6, 0.31 + fx.flash * 0.6, 0.4 + fx.flash * 0.55);
  }
  if (fx.lant) {
    const p = fx.lantPos;
    for (let i = 0, j = 0; i < p.length; i += 3, j++) { p[i + 1] += fx.lantSpd[j] * dt; p[i] += Math.sin(t * 0.7 + j) * dt * 1.5; if (p[i + 1] > 230) p[i + 1] = 25; }
    fx.lant.geometry.attributes.position.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ token contract
// The contract address shows on the intro and in the stats box; a click copies it.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const done = () => toast('Contract address copied');
  try { navigator.clipboard.writeText(b.dataset.copy).then(done, () => toast(b.dataset.copy)); } catch { toast(b.dataset.copy); }
});
function renderCA() {
  const a = S.token?.address, el = $('#castat');
  if (!a || !el) return;
  el.hidden = false; el.dataset.copy = a; el.title = `${S.token.ticker} contract on ${S.chain?.name || 'Elysium'} · click to copy`;
  $('#ca').textContent = `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// ------------------------------------------------------------------ casino pop-ups
// When an agent is dealt a hand, a card slides up with the hand dealt card by card and a link to watch it at
// /casino. Hands already on record when the page opens don't pop up; the viewer's own agent (set on /casino) goes first.
let casinoSeen = null, casinoMore = 0, casinoTimer = 0;
const casinoQ = [];
const myAgent = () => { try { return localStorage.getItem('sf_agent'); } catch { return null; } };
function checkCasino() {
  const hs = S.casino || [];
  const maxT = hs.reduce((m, h) => Math.max(m, h.t), 0);
  if (casinoSeen === null) { casinoSeen = maxT; return; }
  const fresh = hs.filter((h) => h.t > casinoSeen);
  if (!fresh.length) return;
  casinoSeen = maxT;
  const me = myAgent();
  fresh.sort((a, b) => (b.rid === me) - (a.rid === me));
  casinoQ.push(...fresh.slice(0, 3));
  casinoMore += Math.max(0, fresh.length - 3);
  if (!casinoTimer) nextCasino();
}
function nextCasino() {
  const el = $('#cpop');
  clearTimeout(casinoTimer); casinoTimer = 0;
  const h = casinoQ.shift();
  if (!h) { el.classList.remove('on'); return; }
  const more = casinoQ.length ? 0 : casinoMore;
  if (!casinoQ.length) casinoMore = 0;
  const RES = { blackjack: 'Blackjack', win: 'Won', push: 'Push', lose: 'Lost', bust: 'Bust' };
  const money = h.net > 0 ? `+$${Math.round(h.net).toLocaleString()}` : h.net < 0 ? `−$${Math.round(-h.net).toLocaleString()}` : '±$0';
  const step = 0.35, pEnd = 0.25 + h.player.length * step, dEnd = pEnd + h.dealer.length * step;
  const cards = (cs, d0) => cs.map((c, i) => `<b class="pc ${/[♥♦]$/.test(c) ? 'red' : ''}" style="animation-delay:${(d0 + i * step).toFixed(2)}s"><span>${esc(c.slice(0, -1))}</span><i>${esc(c.slice(-1))}</i></b>`).join('');
  const mine = h.rid === myAgent();
  el.innerHTML = `<div class="ch"><span>♠ ${esc(h.venue)}</span><button type="button" aria-label="Close">×</button></div>
    <div class="cn">${mine ? 'Your agent ' : ''}<b>${esc(h.name)}</b> sat down for a hand</div>
    <div class="cr"><i>Player</i><span class="pcs">${cards(h.player, 0.25)}</span><em class="pa" style="animation-delay:${pEnd.toFixed(2)}s">${h.pt}</em></div>
    <div class="cr"><i>Dealer</i><span class="pcs">${cards(h.dealer, pEnd)}</span><em class="pa" style="animation-delay:${dEnd.toFixed(2)}s">${h.dt}</em></div>
    <div class="cres pa" style="animation-delay:${(dEnd + 0.15).toFixed(2)}s"><span class="cb ${esc(h.result)}">${RES[h.result] || esc(h.result)}</span><span class="cm ${h.net > 0 ? 'pos' : h.net < 0 ? 'neg' : ''}">${money}</span></div>
    <a href="/casino?agent=${encodeURIComponent(h.rid)}">Watch the hand →</a>${more ? `<small>+${more} more agent${more === 1 ? '' : 's'} at the tables</small>` : ''}`;
  el.querySelector('button').onclick = nextCasino;
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  casinoTimer = setTimeout(nextCasino, (dEnd + 6) * 1000);
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
    preparePeople(); updateVenues(); drawBillboard(); renderHUD(); checkCasino(); renderCA();
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
  updateEventFX(t, dt);
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
// Labels never sit on top of each other: nearer labels win, a label already showing keeps its place (so nothing
// flickers as the camera moves), and any label that would land on one already placed fades out until there is room.
const labelSize = (el) => { const k = el.className + '|' + el.textContent; if (el._k !== k) { el._k = k; el._w = el.offsetWidth; el._h = el.offsetHeight; } return [el._w, el._h]; };
function placeLabels() {
  const wv = innerWidth, hv = innerHeight, zoomedOut = viewHalf() > 260;
  const items = [];
  const put = (el, at, rank) => {
    tmp.copy(at).project(camera); const x = (tmp.x + 1) / 2 * wv, y = (1 - tmp.y) / 2 * hv;
    const on = tmp.z < 1 && x > -80 && x < wv + 80 && y > -40 && y < hv + 40;
    el.style.display = on ? '' : 'none';
    if (on) { el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`; items.push({ el, x, y, z: tmp.z, rank }); }
  };
  for (const o of Object.values(venueObjs)) { o.sign.el.classList.toggle('small', zoomedOut); const c = o.sign.el.classList; put(o.sign.el, o.sign.at, c.contains('agent') || c.contains('resident') || c.contains('sel') ? 0 : 1); }
  for (const l of landmarkEls) put(l.el, l.at, 2);
  items.sort((a, b) => (a.rank - b.rank) || ((b.el._shown ? 1 : 0) - (a.el._shown ? 1 : 0)) || (a.z - b.z));
  const kept = [], pad = 3;
  for (const it of items) {
    const [w, h] = labelSize(it.el), r = { x0: it.x - w / 2 - pad, x1: it.x + w / 2 + pad, y0: it.y - h - pad, y1: it.y + pad };
    const clash = kept.some((k) => r.x0 < k.x1 && r.x1 > k.x0 && r.y0 < k.y1 && r.y1 > k.y0);
    if (!clash) kept.push(r);
    if (it.el._shown !== !clash) { it.el._shown = !clash; it.el.style.opacity = clash ? '0' : ''; it.el.style.pointerEvents = clash ? 'none' : ''; }
  }
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
window.__sunfall = { setEventFX, selectResident, selectVenue, people: () => people, flyTo, frameOn, setView, W, scene, sky, puffs, get planet() { return planet; }, get planetGlow() { return planetGlow; }, get camera() { return camera; } };
poll(); setInterval(poll, 3000); frame();
