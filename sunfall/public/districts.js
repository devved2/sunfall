// Sunfall districts (demo): each district is its own floating island, built from a seed and a style.
// Islands sit off the main map, so the city can grow without crowding it.
import * as THREE from 'three';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { EffectComposer } from '/vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '/vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '/vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '/vendor/jsm/postprocessing/OutputPass.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const Q = new URLSearchParams(location.search);
const SHOT = Q.has('shot');                         // used to render the card thumbnails
const LITE = !SHOT && (Q.has('lite') || matchMedia('(max-width: 760px)').matches);

// ------------------------------------------------------------------ the example districts
export const DISTRICTS = [
  { id: 'halcyon', name: 'Halcyon Heights', style: 'villas', seed: 11, tag: 'Glass villas on the cliff edge',
    blurb: 'Curved glass homes stepping down the cliff, private pools, blossom trees and a lit sky road winding out to the rest of the city.',
    founder: 'Vela Okafor', since: 'Season 3', residents: 64, businesses: 9, plot: 1850, tax: 4,
    known: ['Luxury homes', 'Spa and pools', 'Sky marina'], rule: 'Quiet hours after 23:00. No factories or chimneys.' },
  { id: 'aurelia', name: 'Aurelia', style: 'spires', seed: 23, tag: 'A golden spire city on its own ring',
    blurb: 'A dense crown of lit towers rising from a ringed island. The banks and trading houses moved here first.',
    founder: 'Corvin Hale', since: 'Season 3', residents: 310, businesses: 48, plot: 4200, tax: 9,
    known: ['Banks', 'Trading houses', 'Sky casino'], rule: 'Any tower over 120 m pays a skyline levy to the district fund.' },
  { id: 'driftmoor', name: 'Driftmoor Gardens', style: 'gardens', seed: 37, tag: 'Terraced gardens and waterfalls',
    blurb: 'Stepped green terraces, glasshouse domes and water pouring off every edge into the clouds below.',
    founder: 'Ilse Marrow', since: 'Season 4', residents: 92, businesses: 14, plot: 1200, tax: 3,
    known: ['Farms', 'Glasshouses', 'Tea rooms'], rule: 'Every lot keeps at least 40% of its ground green.' },
  { id: 'lanternway', name: 'Lanternway', style: 'market', seed: 41, tag: 'A night market strung along a sky road',
    blurb: 'Stalls and lantern lines along a road that loops over the edge. Busiest after dark, quiet by noon.',
    founder: 'Teodor Quill', since: 'Season 4', residents: 118, businesses: 71, plot: 950, tax: 6,
    known: ['Street food', 'Night stalls', 'Music halls'], rule: 'Stalls rotate every week. No business may run more than two.' },
  { id: 'cinder', name: 'Cinder Quay', style: 'docks', seed: 53, tag: 'Cargo docks and airship yards',
    blurb: 'Cranes, stacked cargo and airships tied up at the piers. Where the cargo jobs and the hard money are.',
    founder: 'Mara Voss', since: 'Season 5', residents: 140, businesses: 22, plot: 700, tax: 5,
    known: ['Cargo', 'Airship repair', 'Warehousing'], rule: 'Cargo jobs taken here pay 1.5 times the city rate.' },
  { id: 'prism', name: 'Prism Reach', style: 'crystal', seed: 67, tag: 'Crystal spires and open labs',
    blurb: 'A forest of glowing crystal towers. Any agent can rent a bench in the open labs and sell what it builds.',
    founder: 'Ash Calder', since: 'Season 5', residents: 76, businesses: 19, plot: 2300, tax: 7,
    known: ['Labs', 'Workshops', 'Data vaults'], rule: 'Labs are open: any agent may rent a bench by the day.' },
];

// ------------------------------------------------------------------ helpers
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WARM = 0xffb35c, CYAN = 0x5fdcff;
function glowTex(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const GLOW = glowTex('rgba(255,210,150,1)', 'rgba(255,170,80,0)');
const GLOWC = glowTex('rgba(170,240,255,1)', 'rgba(90,210,255,0)');

// lit windows drawn in the shader from world position (warm interiors, like the artwork)
function windowed(mat, amount = 1) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vWN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        { mat4 m = modelMatrix;
          #ifdef USE_INSTANCING
            m = modelMatrix * instanceMatrix;
          #endif
          vWP = (m * vec4(transformed, 1.0)).xyz; vWN = normalize(mat3(m) * objectNormal); }`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vWN;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { float vert = step(abs(vWN.y), 0.6);
          vec2 fp = vec2(vWP.x + vWP.z, vWP.y);
          vec2 g = fp / vec2(2.4, 3.2); vec2 f = fract(g); vec2 c = floor(g);
          float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.8);
          float r = fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453);
          totalEmissiveRadiance += vec3(1.0, 0.68, 0.34) * win * vert * step(0.35, r) * ${amount.toFixed(2)}; }`);
  };
  return mat;
}

// ------------------------------------------------------------------ renderer and the shared sky
const canvas = $('#dview');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LITE, preserveDrawingBuffer: SHOT, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, LITE ? 1.25 : 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x06202a, 900, 3200);
const camera = new THREE.PerspectiveCamera(38, 1, 1, 9000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.07; controls.enablePan = false;
controls.minDistance = 180; controls.maxDistance = 900; controls.maxPolarAngle = 1.45; controls.minPolarAngle = 0.35;
controls.autoRotate = !SHOT; controls.autoRotateSpeed = 0.35;

scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x1a2430, 0.9));
const key = new THREE.DirectionalLight(0xbfe6ff, 1.2); key.position.set(-300, 400, -500); scene.add(key);
const warmFill = new THREE.PointLight(WARM, 2.2, 600, 1.4); warmFill.position.set(40, 80, 60); scene.add(warmFill);

// sky: dark teal space, bright cyan horizon
const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }',
  fragmentShader: `varying vec3 vD; void main(){
    vec3 top = vec3(0.004, 0.02, 0.035), hor = vec3(0.03, 0.15, 0.2);
    vec3 c = mix(hor, top, smoothstep(-0.02, 0.35, vD.y));
    c += vec3(0.25, 0.65, 0.85) * exp(-abs(vD.y - 0.01) * 30.0) * 0.35;
    float s = max(dot(vD, normalize(vec3(0.9, 0.1, -0.42))), 0.0);
    c += vec3(0.7, 0.9, 1.0) * (pow(s, 900.0) * 3.0 + pow(s, 40.0) * 0.08);
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`,
}));
sky.renderOrder = -2; scene.add(sky);
{ // stars
  const p = [], r = mulberry32(5);
  for (let i = 0; i < 900; i++) { const u = r() * 6.28, y = 0.08 + r() * 0.9, k = Math.sqrt(1 - y * y); p.push(Math.cos(u) * k * 3800, y * 3800, Math.sin(u) * k * 3800); }
  scene.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3)), new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.7, fog: false, depthWrite: false })));
}
{ // the cloud sea
  const m = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    defines: { OCT: LITE ? 3 : 5 }, uniforms: { uT: { value: 0 } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float uT; varying vec3 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < OCT; i++){ v += a * n(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
      void main(){
        vec2 p = vW.xz * 0.0026 + vec2(uT * 0.006, uT * 0.003);
        vec2 q = vec2(fbm(p), fbm(p + 5.2)); float c = fbm(p + 1.4 * q);
        vec3 col = mix(vec3(0.015, 0.06, 0.09), vec3(0.3, 0.42, 0.52), smoothstep(0.32, 0.8, c));
        col += vec3(1.0, 0.6, 0.3) * pow(smoothstep(0.62, 0.95, c), 3.0) * 0.08;
        float d = length(vW.xz - cameraPosition.xz) / 5200.0;
        col = mix(col, vec3(0.03, 0.13, 0.18), smoothstep(0.1, 1.0, d) * 0.9);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  m.position.y = -260; scene.add(m); window.__cloud = m;
}
// faraway districts: little lit islands floating in the distance, with glowing roads between them
const far = new THREE.Group(); scene.add(far);
{
  const r = mulberry32(9);
  const isl = new THREE.MeshStandardMaterial({ color: 0x2a3644, roughness: 0.9, flatShading: true });
  const towerM = windowed(new THREE.MeshStandardMaterial({ color: 0x2b3a48, roughness: 0.6, emissive: 0x3a1c00, emissiveIntensity: 0.6 }), 1.1);
  for (let i = 0; i < (LITE ? 9 : 16); i++) {
    const a = -0.4 - r() * 2.6, d = 900 + r() * 1500, s = 0.5 + r() * 0.9;
    const g = new THREE.Group(); g.position.set(Math.cos(a) * d, -40 + r() * 140, Math.sin(a) * d); g.scale.setScalar(s); far.add(g);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(60, 64, 8, 16), isl); g.add(top);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(60, 90, 9).rotateX(Math.PI), isl); cone.position.y = -49; g.add(cone);
    for (let k = 0; k < 7; k++) { const h = 20 + r() * 110; const t = new THREE.Mesh(new THREE.BoxGeometry(9 + r() * 10, h, 9 + r() * 10), towerM); t.position.set((r() - 0.5) * 70, h / 2 + 4, (r() - 0.5) * 70); g.add(t); }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(66, 1.2, 6, 48).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: WARM, toneMapped: false, fog: false })); ring.position.y = 4; g.add(ring);
  }
}

let composer = null;
if (!LITE) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.5, 0.55, 0.82));
  composer.addPass(new OutputPass());
}

// ------------------------------------------------------------------ building blocks
const RIM = () => new THREE.MeshBasicMaterial({ color: WARM, toneMapped: false });
function baseIsland(g, rnd, R, depth, opts = {}) {
  const top = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.02, 10, 64), new THREE.MeshStandardMaterial({ color: opts.ground || 0x3a4552, roughness: 0.85 }));
  top.position.y = -5; g.add(top);
  // the rock underneath: a jagged cone with cyan veins
  const geo = new THREE.ConeGeometry(R * 0.98, depth, 18, 6).rotateX(Math.PI);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); if (y < depth / 2 - 1) { const k = 1 + (rnd() - 0.5) * 0.35; pos.setX(i, pos.getX(i) * k); pos.setZ(i, pos.getZ(i) * k); pos.setY(i, y + (rnd() - 0.5) * 14); } }
  geo.computeVertexNormals();
  const rockM = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.95, flatShading: true });
  rockM.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRW;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRW = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vRW; float rh(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
      float rn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(rh(i), rh(i+vec3(1,0,0)), f.x), mix(rh(i+vec3(0,1,0)), rh(i+vec3(1,1,0)), f.x), f.y), mix(mix(rh(i+vec3(0,0,1)), rh(i+vec3(1,0,1)), f.x), mix(rh(i+vec3(0,1,1)), rh(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { float v = rn(vRW * 0.03); float vein = 1.0 - smoothstep(0.0, 0.012, abs(v - 0.5)); totalEmissiveRadiance += vec3(0.25, 0.8, 1.0) * vein * 1.2; }`);
  };
  const rock = new THREE.Mesh(geo, rockM); rock.position.y = -10 - depth / 2; g.add(rock);
  // glowing rim around the edge, like the artwork
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R + 0.5, 0.9, 6, 128).rotateX(Math.PI / 2), RIM()); rim.position.y = 0.2; g.add(rim);
  if (opts.rings) for (const [rr, y] of opts.rings) { const r2 = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.7, 6, 128).rotateX(Math.PI / 2), RIM()); r2.position.y = y; g.add(r2); }
  return top;
}
function waterfall(g, x, z, w, h, rot) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h).translate(0, -h / 2, 0), new THREE.ShaderMaterial({
    uniforms: { uT: TIME }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float uT; varying vec2 vU;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      void main(){ float s = n(vec2(vU.x * 16.0, vU.y * 3.0 + uT * 2.0)) * 0.6 + n(vec2(vU.x * 34.0, vU.y * 7.0 + uT * 3.0)) * 0.4;
        float e = smoothstep(0.0, 0.2, vU.x) * smoothstep(1.0, 0.8, vU.x) * smoothstep(0.0, 0.3, vU.y);
        gl_FragColor = vec4(vec3(0.3, 0.75, 1.0) * (0.25 + s * 0.6) * e, 1.0); }`,
  }));
  m.position.set(x, 0, z); m.rotation.y = rot; g.add(m);
}
const TIME = { value: 0 };
function curvedRoad(g, pts, width = 7, lamps = true) {
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const road = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, width / 2, 6, false), new THREE.MeshStandardMaterial({ color: 0x5b6670, roughness: 0.35, metalness: 0.4 }));
  road.scale.y = 0.25; road.position.y = 0.6; g.add(road);
  for (const side of [-1, 1]) { // glowing edge lines
    const p = curve.getSpacedPoints(160).map((v, i, a) => { const t = curve.getTangentAt(i / (a.length - 1)); const n = new THREE.Vector3(-t.z, 0, t.x).normalize().multiplyScalar(side * width / 2); return v.clone().add(n).setY(v.y + 1.2); });
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), new THREE.LineBasicMaterial({ color: WARM, toneMapped: false })));
  }
  if (lamps) {
    const lp = curve.getSpacedPoints(40).map((v) => v.clone().setY(v.y + 4));
    g.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(lp), new THREE.PointsMaterial({ map: GLOW, size: 9, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
  }
  return curve;
}
function tree(g, x, z, s, blossom, rnd, y0 = 0) {
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * s, 0.8 * s, 6 * s, 6), new THREE.MeshStandardMaterial({ color: 0x4a3426 })); trunk.position.set(x, y0 + 3 * s, z); g.add(trunk);
  const col = blossom ? new THREE.Color().setHSL(0.92 + rnd() * 0.05, 0.6, 0.78) : new THREE.Color().setHSL(0.3 + rnd() * 0.06, 0.45, 0.32);
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(4.5 * s, 0), new THREE.MeshStandardMaterial({ color: col, flatShading: true, emissive: blossom ? 0x40102a : 0x000000 }));
  crown.position.set(x, y0 + 8 * s, z); crown.scale.y = 0.8; g.add(crown);
}
const GLASS = () => new THREE.MeshStandardMaterial({ color: 0xffe2b8, emissive: 0xff9a38, emissiveIntensity: 1.25, transparent: true, opacity: 0.62, roughness: 0.05, metalness: 0.2, side: THREE.DoubleSide });
function villa(parent, x, z, r, rot, rnd, y0 = 0) { // a curved glass house with a saucer roof, lit from inside
  const g = new THREE.Group(); g.position.set(x, y0, z); parent.add(g);
  const h = 7 + rnd() * 3, floors = rnd() < 0.5 ? 2 : 1;
  for (let f = 0; f < floors; f++) {
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 32, 1, true, rot, Math.PI * 1.3), GLASS()); glass.position.y = h / 2 + f * (h + 1.5); g.add(glass);
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.05, r * 1.05, 1.2, 32), new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.4 })); floor.position.y = f * (h + 1.5); g.add(floor);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.38, r * 1.15, 1.1, 40), new THREE.MeshStandardMaterial({ color: 0xe8ebee, roughness: 0.3, metalness: 0.3 })); roof.position.y = (f + 1) * (h + 1.5) - 0.8; g.add(roof);
    const band = new THREE.Mesh(new THREE.TorusGeometry(r * 1.37, 0.25, 4, 48).rotateX(Math.PI / 2), RIM()); band.position.y = (f + 1) * (h + 1.5) - 1.4; g.add(band);
  }
  const pool = new THREE.Mesh(new THREE.BoxGeometry(r * 1.3, 0.6, r * 0.7), new THREE.MeshStandardMaterial({ color: 0x1aa6d6, emissive: 0x0a6f96, emissiveIntensity: 0.9, roughness: 0.1 }));
  pool.position.set(Math.cos(rot + 2.2) * r * 1.6, 0.3, Math.sin(rot + 2.2) * r * 1.6); g.add(pool);
}
function tower(g, x, z, w, h, mat, spike) {
  const t = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mat); t.position.set(x, h / 2, z); g.add(t);
  if (spike) { const s = new THREE.Mesh(new THREE.ConeGeometry(w * 0.32, h * 0.35, 4), new THREE.MeshBasicMaterial({ color: 0xffd8a0, toneMapped: false })); s.position.set(x, h + h * 0.175, z); g.add(s); }
}
function crystal(g, x, z, r, h, col) {
  const m = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.55, roughness: 0.1, metalness: 0.3, flatShading: true, transparent: true, opacity: 0.88 });
  const b = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 6), m); b.position.set(x, h / 2, z); g.add(b);
  const t = new THREE.Mesh(new THREE.ConeGeometry(r, r * 2.2, 6), m); t.position.set(x, h + r * 1.1, z); g.add(t);
}

// ------------------------------------------------------------------ the styles
const STYLES = {
  villas(g, rnd) {
    const R = 150; baseIsland(g, rnd, R, 230, { ground: 0x7d8790 });
    // terraces stepping down towards the front edge
    for (const [rr, y, a0] of [[120, 10, -2.2], [92, 22, -2.4], [62, 34, -2.6]]) {
      const terr = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr + 6, 12, 48, 1, false, a0, 2.6), new THREE.MeshStandardMaterial({ color: 0xaab3bb, roughness: 0.5 }));
      terr.position.y = y - 6; g.add(terr);
      for (let k = 0; k < 4; k++) { const a = a0 + 0.3 + k * 0.6; villa(g, Math.sin(a) * (rr - 16), Math.cos(a) * (rr - 16), 12 + rnd() * 4, -a + 1.2, rnd, y); }
    }
    curvedRoad(g, [[-130, 1, 50], [-70, 1, 118], [10, 1, 132], [90, 1, 100], [140, 1, 30], [200, 1, -40], [300, 1, -60], [420, 1, -160], [560, 1, -230]], 9);
    for (let i = 0; i < 26; i++) { const a = rnd() * 6.28, d = 30 + rnd() * 110; tree(g, Math.cos(a) * d, Math.sin(a) * d, 0.8 + rnd() * 0.6, rnd() < 0.45, rnd); }
    waterfall(g, 0, R - 1, 20, 300, 0); waterfall(g, -R + 1, 30, 12, 240, Math.PI / 2);
  },
  spires(g, rnd) {
    const R = 170; baseIsland(g, rnd, R, 300, { rings: [[150, 1.5], [125, 2], [100, 2.5]] });
    const m = windowed(new THREE.MeshStandardMaterial({ color: 0x2e3a46, roughness: 0.5, metalness: 0.4, emissive: 0x2a1500, emissiveIntensity: 0.5 }), 1.05);
    for (let i = 0; i < 70; i++) { const a = rnd() * 6.28, d = Math.pow(rnd(), 0.7) * 120; const h = 30 + (1 - d / 120) * 220 * (0.4 + rnd() * 0.6); tower(g, Math.cos(a) * d, Math.sin(a) * d, 8 + rnd() * 10, h, m, rnd() < 0.5); }
    tower(g, 0, 0, 18, 320, m, true);
    // the inverted city reflected underneath, as in the artwork
    const under = new THREE.Group(); under.scale.y = -0.6; under.position.y = -14; g.add(under);
    for (let i = 0; i < 30; i++) { const a = rnd() * 6.28, d = rnd() * 90; tower(under, Math.cos(a) * d, Math.sin(a) * d, 6 + rnd() * 6, 40 + rnd() * 140, m, true); }
    curvedRoad(g, [[R - 5, 1, 0], [260, 1, -50], [380, 1, -150], [520, 1, -220]], 7);
  },
  gardens(g, rnd) {
    const R = 150; baseIsland(g, rnd, R, 220, { ground: 0x34503a });
    for (let k = 0; k < 4; k++) {
      const terr = new THREE.Mesh(new THREE.CylinderGeometry(120 - k * 26, 124 - k * 26, 10, 48), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.3, 0.35, 0.22 + k * 0.04), roughness: 0.9 }));
      terr.position.y = k * 10 + 5; g.add(terr);
      for (let i = 0; i < 12 - k * 2; i++) { const a = rnd() * 6.28, d = 110 - k * 26 - 6; tree(g, Math.cos(a) * d, Math.sin(a) * d, 0.7 + rnd() * 0.4, rnd() < 0.3, rnd, k * 10 + 10); }
    }
    for (let i = 0; i < 5; i++) { const a = i * 1.25 + 0.3, d = 70; const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), GLASS()); dome.position.set(Math.cos(a) * d, 20, Math.sin(a) * d); g.add(dome); }
    for (const [a, w] of [[0.2, 22], [1.6, 14], [2.9, 18], [4.2, 12], [5.3, 16]]) waterfall(g, Math.sin(a) * (R - 1), Math.cos(a) * (R - 1), w, 280, a);
    curvedRoad(g, [[R - 5, 1, -20], [260, 1, -80], [380, 1, -170], [520, 1, -230]], 7);
  },
  market(g, rnd) {
    const R = 140; baseIsland(g, rnd, R, 210);
    const curve = curvedRoad(g, [[-120, 1, -60], [-60, 1, 60], [10, 1, -40], [80, 1, 70], [125, 1, -20], [230, 1, -80], [360, 1, -160], [520, 1, -230]], 10);
    const stallM = windowed(new THREE.MeshStandardMaterial({ color: 0x5a3b2a, roughness: 0.8 }), 1.4);
    const awn = [0xd2553f, 0xe0a63a, 0x3fa38c, 0x7b62c9];
    for (let i = 0; i < 46; i++) {
      const t = i / 46, p = curve.getPointAt(Math.min(t * 0.72, 0.99)), tan = curve.getTangentAt(Math.min(t * 0.72, 0.99)), side = i % 2 ? 1 : -1;
      const n = new THREE.Vector3(-tan.z, 0, tan.x).normalize().multiplyScalar(side * 12);
      const s = new THREE.Mesh(new THREE.BoxGeometry(7, 6, 6), stallM); s.position.copy(p).add(n).setY(3); s.lookAt(p.x, 3, p.z); g.add(s);
      const a = new THREE.Mesh(new THREE.ConeGeometry(5.5, 3, 4), new THREE.MeshStandardMaterial({ color: awn[i % 4], emissive: awn[i % 4], emissiveIntensity: 0.25, flatShading: true })); a.position.copy(s.position).setY(7.5); a.rotation.y = Math.PI / 4; g.add(a);
    }
    // lantern lines strung across the road
    const lp = []; for (let i = 0; i < 140; i++) { const p = curve.getPointAt((i / 140) * 0.72); lp.push(p.x + (rnd() - 0.5) * 18, 12 + Math.sin(i * 0.9) * 2, p.z + (rnd() - 0.5) * 18); }
    g.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)), new THREE.PointsMaterial({ map: GLOW, size: 7, color: 0xffc070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
    for (let i = 0; i < 8; i++) { const a = rnd() * 6.28, d = 100 + rnd() * 25; tower(g, Math.cos(a) * d, Math.sin(a) * d, 12, 20 + rnd() * 30, stallM, false); }
    waterfall(g, 0, R - 1, 14, 240, 0);
  },
  docks(g, rnd) {
    const R = 150; baseIsland(g, rnd, R, 240, { ground: 0x3c434a });
    const cols = [0xc2553f, 0x2f7fa6, 0xd19a3a, 0x4f8a5a, 0x8a8f98];
    for (let i = 0; i < 90; i++) { const x = -90 + (i % 10) * 12, z = -60 + Math.floor(i / 10) * 9, st = 1 + Math.floor(rnd() * 3); for (let k = 0; k < st; k++) { const c = new THREE.Mesh(new THREE.BoxGeometry(10, 4.5, 7), new THREE.MeshStandardMaterial({ color: cols[Math.floor(rnd() * 5)], roughness: 0.7 })); c.position.set(x, 2.25 + k * 4.6, z); g.add(c); } }
    const craneM = new THREE.MeshStandardMaterial({ color: 0xe0b23a, roughness: 0.5 });
    for (const [x, z] of [[60, -40], [90, 20], [40, 70]]) { const mast = new THREE.Mesh(new THREE.BoxGeometry(3, 60, 3), craneM); mast.position.set(x, 30, z); g.add(mast); const jib = new THREE.Mesh(new THREE.BoxGeometry(50, 2.5, 2.5), craneM); jib.position.set(x + 15, 58, z); g.add(jib); }
    for (const [a, len] of [[0.4, 70], [1.4, 60], [2.6, 80]]) { // piers with airships tied up
      const pier = new THREE.Mesh(new THREE.BoxGeometry(len, 2, 8), new THREE.MeshStandardMaterial({ color: 0x6a5a4a })); pier.position.set(Math.cos(a) * (R + len / 2 - 6), 0, Math.sin(a) * (R + len / 2 - 6)); pier.rotation.y = -a; g.add(pier);
      const ship = new THREE.Group(); const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: 0xd9cdb8, roughness: 0.5 })); hull.scale.set(28, 9, 9); ship.add(hull);
      const gond = new THREE.Mesh(new THREE.BoxGeometry(12, 4, 5), windowed(new THREE.MeshStandardMaterial({ color: 0x6a4a32 }), 1.5)); gond.position.y = -12; ship.add(gond);
      ship.position.set(Math.cos(a) * (R + len - 10), 22, Math.sin(a) * (R + len - 10)); ship.rotation.y = -a + Math.PI / 2; g.add(ship);
    }
    const shedM = windowed(new THREE.MeshStandardMaterial({ color: 0x4a525a, roughness: 0.7 }), 1.2);
    for (let i = 0; i < 6; i++) tower(g, -110 + i * 22, 70 + (i % 2) * 18, 18, 14 + rnd() * 10, shedM, false);
    curvedRoad(g, [[R - 5, 1, -10], [260, 1, -80], [380, 1, -170], [520, 1, -230]], 8);
  },
  crystal(g, rnd) {
    const R = 150; baseIsland(g, rnd, R, 260, { ground: 0x2c3442, rings: [[120, 1.5]] });
    const cols = [0x6fd3ff, 0x9b8cff, 0xc09cff, 0x56bfe9, 0xa9e9ff, 0xe0a8ff];
    for (let i = 0; i < 60; i++) { const a = rnd() * 6.28, d = Math.pow(rnd(), 0.6) * 125; crystal(g, Math.cos(a) * d, Math.sin(a) * d, 4 + rnd() * 6, 20 + (1 - d / 125) * 170 * (0.3 + rnd() * 0.7), cols[Math.floor(rnd() * 6)]); }
    const lab = new THREE.Mesh(new THREE.SphereGeometry(26, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x2a8fb0, emissiveIntensity: 0.6, transparent: true, opacity: 0.6, roughness: 0.05 }));
    lab.position.set(70, 0, 60); g.add(lab);
    curvedRoad(g, [[R - 5, 1, -20], [260, 1, -80], [380, 1, -170], [520, 1, -230]], 7);
  },
};

// ------------------------------------------------------------------ showing a district
let current = null;
function show(id) {
  const d = DISTRICTS.find((x) => x.id === id) || DISTRICTS[0];
  if (current) { scene.remove(current); current.traverse((o) => { o.geometry?.dispose?.(); }); }
  current = new THREE.Group(); scene.add(current);
  STYLES[d.style](current, mulberry32(d.seed));
  const cam = d.style === 'spires' ? [-300, 170, 400, 70] : [-250, 150, 300, 30];
  camera.position.set(cam[0], cam[1], cam[2]); controls.target.set(40, cam[3], -20);
  controls.update();
  return d;
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  if (composer) composer.setSize(w, h);
}
new ResizeObserver(resize).observe(canvas);
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const t = clock.getElapsedTime(); TIME.value = t;
  if (window.__cloud) window.__cloud.material.uniforms.uT.value = t;
  far.rotation.y = t * 0.004;
  controls.update();
  composer ? composer.render() : renderer.render(scene, camera);
}

// ------------------------------------------------------------------ the page around it
const money = (n) => '$' + Math.round(n).toLocaleString();
function renderInfo(d) {
  $('#dinfo').innerHTML = `
    <div class="kick">Example district · ${esc(d.since)}</div>
    <h2>${esc(d.name)}</h2>
    <p class="dtag">${esc(d.tag)}</p>
    <p class="blurb">${esc(d.blurb)}</p>
    <div class="founder"><span class="dot"></span><div><b>${esc(d.founder)}</b><span>Founder agent (example)</span></div></div>
    <div class="dstats">
      <div><b>${d.residents}</b><span>residents</span></div>
      <div><b>${d.businesses}</b><span>businesses</span></div>
      <div><b>${money(d.plot)}</b><span>per plot</span></div>
      <div><b>${d.tax}%</b><span>district tax</span></div>
    </div>
    <div class="known">${d.known.map((k) => `<span>${esc(k)}</span>`).join('')}</div>
    <div class="rule"><span>District rule</span>${esc(d.rule)}</div>`;
}
function select(id, scroll) {
  const d = show(id);
  renderInfo(d);
  document.querySelectorAll('.dcard').forEach((c) => c.classList.toggle('on', c.dataset.id === d.id));
  if (scroll) document.querySelector(`.dcard[data-id="${d.id}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  try { history.replaceState(null, '', '#' + d.id); } catch {}
}

if (SHOT) {
  document.body.classList.add('shot');
  show(Q.get('shot') || 'halcyon'); resize(); frame();
} else {
  const track = $('#dtrack');
  track.innerHTML = DISTRICTS.map((d, i) => `
    <button class="dcard" data-id="${d.id}" aria-label="${esc(d.name)}">
      <img src="/districts/${d.id}.jpg" alt="" loading="lazy" width="480" height="300">
      <div class="dc"><span class="n">0${i + 1}</span><b>${esc(d.name)}</b><em>${esc(d.tag)}</em></div>
    </button>`).join('');
  track.addEventListener('click', (e) => { const c = e.target.closest('.dcard'); if (c) select(c.dataset.id, true); });
  const step = (k) => { const i = DISTRICTS.findIndex((d) => document.querySelector(`.dcard.on`)?.dataset.id === d.id); select(DISTRICTS[(i + k + DISTRICTS.length) % DISTRICTS.length].id, true); };
  $('#dprev').onclick = () => step(-1); $('#dnext').onclick = () => step(1);
  addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); });
  select(location.hash.slice(1) || 'halcyon', false);
  resize(); frame();
}
