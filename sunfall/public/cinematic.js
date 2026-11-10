// Sunfall, cinematic view (demo): the artwork as the stage, the live city drawn over it.
// Every light that moves is a real resident, placed from the same schedule the 3D city uses.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const GRID = 40, OFF = 20, XMAX = 980, YMAX = 660;
const snapX = (v) => clamp(OFF + GRID * Math.round((v - OFF) / GRID), OFF, XMAX);
const snapY = (v) => clamp(OFF + GRID * Math.round((v - OFF) / GRID), OFF, YMAX);
const money = (n) => '$' + Math.round(n).toLocaleString();

// ------------------------------------------------------------------ the stage: the artwork, and where the city sits in it
// Two camera locations. "old" maps the city grid onto the artwork with a perspective transform;
// "golden" is painted freely, so places are pinned by hand and people walk its sky road.
const ROAD = [[120, 640], [260, 615], [420, 600], [560, 575], [680, 540], [760, 500], [790, 470], [760, 440], [680, 420], [600, 410], [560, 405],
  [620, 390], [700, 380], [790, 370], [820, 355], [790, 345], [730, 340], [700, 325], [720, 305], [780, 290], [860, 285], [940, 282], [1040, 282], [1150, 280], [1230, 276]];
const SCENES = {
  golden: {
    name: 'Golden Hour', img: '/cine-golden.jpg', crop: { x: 0, y: 30, w: 1280, h: 690 }, paths: true, depth: true,
    spots: [[935, 252], [1040, 258], [860, 288], [1160, 282], [250, 420], [175, 262], [430, 302], [505, 335], [470, 458], [690, 515], [640, 402], [230, 560], [1100, 412], [1228, 218], [520, 258]],
    windows: [[880, 110, 300, 220, 0.9], [60, 200, 420, 270, 0.75]], rim: [[800, 287], [1000, 300], [1230, 278]],
    falls: [[765, 302, 95], [1065, 302, 150], [452, 448, 55], [1180, 418, 60]], clouds: [520, 700, 760],
    // the painting cut into depth layers (far to near); each moves at its own rate as you look around
    base: 0.1,
    layers: [
      { d: 0.42, poly: [[790, 40], [1250, 40], [1280, 250], [1280, 470], [1070, 600], [930, 650], [820, 470], [760, 300]] },
      { d: 0.7, poly: [[840, 500], [1050, 470], [1280, 400], [1280, 720], [820, 720]] },
      { d: 1, poly: [[0, 120], [340, 150], [470, 240], [560, 320], [690, 370], [790, 340], [835, 368], [800, 455], [1000, 560], [1005, 640], [900, 720], [0, 720]] },
    ],
  },
  old: {
    name: 'Old Town', img: '/hero.jpg', crop: { x: 380, y: 170, w: 900, h: 506 }, paths: false, depth: false,
    windows: [[460, 250, 820, 200, 1]], rim: [[468, 462], [1300, 456]], falls: [[763, 470, 150]], clouds: [560, 690, 1500],
  },
};
let SC = SCENES[document.body.dataset.scene === 'golden' ? 'golden' : 'old'];
const EXPLORE = document.body.dataset.explore === '1';
const pip = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const depthAt = (x, y) => { if (!SC.layers) return 0; for (let i = SC.layers.length - 1; i >= 0; i--) if (pip(x, y, SC.layers[i].poly)) return SC.layers[i].d; return SC.base; };
// camera for exploring: centre (art px), zoom, and the parallax it creates
const cam = { x: 700, y: 390, z: 1, tx: 700, ty: 390, tz: 1, px: 0, py: 0, mx: 0, my: 0 };
const IMG = new Image(); IMG.src = SC.img;
let CROP = SC.crop;
// map corners (1000 x 700 city map) -> artwork pixels, measured on the artwork
const H = homography([[15, 686], [985, 686], [15, 14], [985, 14]], [[468, 462], [1300, 456], [492, 292], [1236, 282]]);
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let i = 0; i < 8; i++) { // gaussian elimination
    let m = i; for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
    [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
    for (let r = i + 1; r < 8; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < 8; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const h = Array(8).fill(0);
  for (let i = 7; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < 8; c++) s -= A[i][c] * h[c]; h[i] = s / A[i][i]; }
  return h;
}
const ROADCUM = [0]; for (let i = 1; i < ROAD.length; i++) ROADCUM.push(ROADCUM[i - 1] + Math.hypot(ROAD[i][0] - ROAD[i - 1][0], ROAD[i][1] - ROAD[i - 1][1]));
const roadAt = (d) => { for (let i = 1; i < ROAD.length; i++) if (d <= ROADCUM[i] || i === ROAD.length - 1) { const k = clamp((d - ROADCUM[i - 1]) / (ROADCUM[i] - ROADCUM[i - 1] || 1), 0, 1); return [ROAD[i - 1][0] + (ROAD[i][0] - ROAD[i - 1][0]) * k, ROAD[i - 1][1] + (ROAD[i][1] - ROAD[i - 1][1]) * k]; } return ROAD.at(-1); };
const roadNear = (pt) => { let best = 0, bd = 1e9; for (let d = 0; d <= ROADCUM.at(-1); d += 6) { const q = roadAt(d), dd = Math.hypot(q[0] - pt[0], q[1] - pt[1]); if (dd < bd) { bd = dd; best = d; } } return best; };
let spotOf = {};
function assignSpots() { spotOf = {}; if (!SC.paths || !S) return; [...S.venues].sort((a, b) => b.isVenue - a.isVenue || a.id.localeCompare(b.id, 'en', { numeric: true })).forEach((v, i) => { spotOf[v.id] = SC.spots[i % SC.spots.length]; }); }
const venuePt = (v) => (SC.paths ? spotOf[v.id] || SC.spots[0] : toArt(v.x, v.y));
function anchorOf(p, key) {
  if (key && V[key]) { const sp = venuePt(V[key]), h = hash(p.r[0] + key); return [sp[0] + ((h & 255) / 255 - 0.5) * 36, sp[1] + (((h >> 8) & 255) / 255 - 0.5) * 12]; }
  const h = hash(p.r[0] + 'home'); return roadAt(((h & 1023) / 1023) * ROADCUM.at(-1) * 0.62);   // homes sit along the near half of the road
}
function pathRoute(p, from, to) {
  const key = from + '>' + to; p.routes ||= {}; if (p.routes[key]) return p.routes[key];
  const A = anchorOf(p, from), B = anchorOf(p, to), dA = roadNear(A), dB = roadNear(B), pts = [A];
  const n = Math.max(2, Math.ceil(Math.abs(dB - dA) / 14)); for (let i = 0; i <= n; i++) pts.push(roadAt(dA + (dB - dA) * (i / n)));
  pts.push(B); const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return (p.routes[key] = { pts, cum, len: cum.at(-1) || 1 });
}
function artPos(p, w) {
  if (!SC.paths) return toArt(w.pos[0], w.pos[1]);
  if (w.walk) return along(pathRoute(p, w.from || 'home', w.to || 'home'), w.t);
  const a = anchorOf(p, w.vid), ph = (hash(p.r[0]) & 1023) / 160, tt = performance.now() / 1000;   // small wander around the place they are at
  return [a[0] + Math.sin(tt * 0.35 + ph) * 9, a[1] + Math.sin(tt * 0.27 + ph * 1.7) * 3];
}
const depthK = (ay) => (SC.depth ? 0.45 + clamp((ay - 250) / 470, 0, 1) * 1.5 : 1);
const toArt = (x, y) => { const h = H, w = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };

const cv = $('#stage'), g = cv.getContext('2d');
let W = 0, Hh = 0, DPR = 1, view = { s: 1, ox: 0, oy: 0 };
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = cv.clientWidth; Hh = cv.clientHeight; cv.width = W * DPR; cv.height = Hh * DPR;
}
addEventListener('resize', resize);
// cover-fit the crop, with a slow push-in (Ken Burns), anchored a little right of centre
function updateView(t) {
  if (EXPLORE) {
    cam.x += (cam.tx - cam.x) * 0.12; cam.y += (cam.ty - cam.y) * 0.12; cam.z += (cam.tz - cam.z) * 0.12;
    const s = Math.max(W / CROP.w, Hh / CROP.h) * cam.z * 1.04;
    // keep the painting covering the screen
    const hw = W / 2 / s, hh = Hh / 2 / s;
    cam.x = clamp(cam.x, CROP.x + hw, CROP.x + CROP.w - hw); cam.y = clamp(cam.y, CROP.y + hh, CROP.y + CROP.h - hh);
    cam.tx = clamp(cam.tx, CROP.x + hw, CROP.x + CROP.w - hw); cam.ty = clamp(cam.ty, CROP.y + hh, CROP.y + CROP.h - hh);
    // parallax: how far the camera sits from the middle of the painting, plus a little from the pointer
    const pxT = ((cam.x - (CROP.x + CROP.w / 2)) / (CROP.w / 2)) * -12 + cam.mx * -7, pyT = ((cam.y - (CROP.y + CROP.h / 2)) / (CROP.h / 2)) * -6 + cam.my * -4;
    cam.px += (pxT - cam.px) * 0.1; cam.py += (pyT - cam.py) * 0.1;
    view = { s, ox: W / 2 - cam.x * s, oy: Hh / 2 - cam.y * s };
    return;
  }
  const k = (SC.paths ? 1.02 : 1.04) + 0.03 * Math.sin(t * 0.045);
  const s = Math.max(W / CROP.w, Hh / CROP.h) * k;
  const fx = W < 700 ? (SC.paths ? 0.55 : 0.62) : 0.5;
  view = { s, ox: W * fx - (CROP.x + CROP.w * fx + Math.sin(t * 0.03) * 12) * s, oy: Hh / 2 - (CROP.y + CROP.h / 2) * s };
}
const toScreen = (ax, ay, d) => { if (d == null) d = EXPLORE ? depthAt(ax, ay) : 0; return [ax * view.s + view.ox + cam.px * d * view.s, ay * view.s + view.oy + cam.py * d * view.s]; };
// draw the painting layer by layer, each shifted by its depth (the far layer is the whole picture)
function drawStage() {
  const iw = IMG.width * view.s, ih = IMG.height * view.s;
  if (!EXPLORE || !SC.layers) { g.drawImage(IMG, view.ox, view.oy, iw, ih); return; }
  const b = SC.base; g.drawImage(IMG, view.ox + cam.px * b * view.s - 30, view.oy + cam.py * b * view.s - 20, iw + 60, ih + 40);
  if (!SC.cut || SC.cut.src !== IMG.src) cutLayers();
  SC.layers.forEach((L, i) => { const dx = cam.px * L.d * view.s, dy = cam.py * L.d * view.s; g.drawImage(SC.cut.c[i], view.ox + dx, view.oy + dy, iw, ih); });
}
// each layer is the painting under a soft-edged mask, so the seams between layers do not show
function cutLayers() {
  const c = SC.layers.map((L) => {
    const cv2 = document.createElement('canvas'); cv2.width = IMG.width; cv2.height = IMG.height; const x = cv2.getContext('2d');
    x.filter = 'blur(14px)'; x.fillStyle = '#fff'; x.beginPath(); L.poly.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.closePath(); x.fill();
    x.filter = 'none'; x.globalCompositeOperation = 'source-in'; x.drawImage(IMG, 0, 0); return cv2;
  });
  SC.cut = { src: IMG.src, c };
}

// ------------------------------------------------------------------ the city, from the live snapshot
let S = null, offset = 0, people = [], V = {};
const HOUR = new URLSearchParams(location.search).get('hour');
const cityHour = () => (HOUR != null ? Number(HOUR) : S ? (((Date.now() + offset - S.clock.epoch) % S.clock.dayMs) / S.clock.dayMs) * 24 : 12);
const cityDay = () => (S ? Math.floor((Date.now() + offset - S.clock.epoch) / S.clock.dayMs) : 0);
function sidewalk(x, y, o) { const sx = snapX(x), sy = snapY(y); return Math.abs(x - sx) < Math.abs(y - sy) ? [sx + o, y] : [x, sy + o]; }
function spotFor(vid, id) { const v = vid && V[vid]; if (!v) return null; const h = hash(id + vid); return [v.x - 13 + ((h & 255) / 255) * 26, v.y + 16 + (((h >> 8) & 255) / 255) * 9]; }
function routeOf(P, Q, o) {
  const a = [snapX(P[0]) + o, snapY(P[1]) + o], b = [snapX(Q[0]) + o, snapY(Q[1]) + o];
  const pts = [P, a, [b[0], a[1]], b, Q], cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum.at(-1) || 1 };
}
function along(rt, t) {
  const d = clamp(t, 0, 1) * rt.len;
  for (let i = 1; i < rt.pts.length; i++) if (d <= rt.cum[i] || i === rt.pts.length - 1) {
    const seg = rt.cum[i] - rt.cum[i - 1] || 1, k = clamp((d - rt.cum[i - 1]) / seg, 0, 1);
    return [rt.pts[i - 1][0] + (rt.pts[i][0] - rt.pts[i - 1][0]) * k, rt.pts[i - 1][1] + (rt.pts[i][1] - rt.pts[i - 1][1]) * k];
  }
  return rt.pts.at(-1);
}
function prepare() {
  V = Object.fromEntries(S.venues.map((v) => [v.id, v]));
  const old = Object.fromEntries(people.map((p) => [p.r[0], p]));
  people = S.residents.map((r) => {
    const [id, , hx, hy, aft, night] = r, key = `${aft}|${night}`, p = old[id];
    if (p && p.key === key) { p.r = r; return p; }
    const h = hash(id), o = h & 1 ? 4.6 : -4.6, Hm = sidewalk(hx, hy, o), A = spotFor(aft, id), N = spotFor(night, id);
    return { r, key, H: Hm, A, N, aft, night, stagger: ((h >> 16) & 255) / 255 * 0.6, hue: (h >> 4) & 255, trail: [],
      rHA: A && routeOf(Hm, A, o), rAH: A && routeOf(A, Hm, o), rHN: N && routeOf(Hm, N, o), rNH: N && routeOf(N, Hm, o) };
  });
}
function where(p, h) {
  const s = p.stagger, at = (vid, spot) => (spot ? { pos: spot, vis: true, walk: false, vid } : { vis: false });
  const walk = (rt, t, from, to) => (rt ? { pos: along(rt, t), vis: true, walk: true, vid: to, from, to, t: clamp(t, 0, 1) } : { vis: false });
  if (h < 8 + s) return { vis: false };
  if (h < 9 + s) return walk(p.rHA, h - 8 - s, null, p.aft);
  if (h < 16 + s) return at(p.aft, p.A);
  if (h < 17 + s) return walk(p.rAH, h - 16 - s, p.aft, null);
  if (h < 18 + s) return { vis: false };
  if (h < 19 + s) return walk(p.rHN, h - 18 - s, null, p.night);
  if (h < 23) return at(p.night, p.N);
  if (h < 23.9) return walk(p.rNH, (h - 23) / 0.9, p.night, null);
  return { vis: false };
}
async function poll(first) {
  try {
    S = await (await fetch('/api/state', { cache: 'no-store' })).json();
    offset = S.clock.now - Date.now();
    prepare(); assignSpots(); renderPanels();
    if (first) $('#loading').classList.add('gone');
  } catch (e) { console.warn('poll failed', e); }
}

// ------------------------------------------------------------------ ambient life on the artwork
const R = (() => { let a = 7; return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
let windows = [];
function sceneFX() {
  windows = []; for (const [x0, y0, w, h, warm] of SC.windows) for (let i = 0; i < 150; i++) windows.push({ x: x0 + R() * w, y: y0 + R() * h, ph: R() * 6.28, sp: 0.4 + R() * 2.2, warm: R() < warm + 0.05, r: 0.6 + R() * 1.1 });
  clouds = Array.from({ length: 9 }, () => ({ x: R() * SC.clouds[2] * 1.4 - 100, y: SC.clouds[0] + R() * (SC.clouds[1] - SC.clouds[0]), r: 120 + R() * 160, v: 2 + R() * 5, a: 0.05 + R() * 0.07 }));
}
const rain = Array.from({ length: 160 }, () => ({ x: R(), y: R(), l: 0.02 + R() * 0.04, v: 0.5 + R() * 0.6 }));
let clouds = []; sceneFX();
let showRain = true, clean = false;

// ------------------------------------------------------------------ CAM window: a live close-up of the busiest place
let camAt = 0, camVid = null;
function pickCam(h) {
  const counts = {};
  for (const p of people) { const w = where(p, h); if (w.vis && !w.walk && w.vid) counts[w.vid] = (counts[w.vid] || 0) + 1; }
  const list = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([v]) => v);
  if (!list.length) return null;
  const i = list.indexOf(camVid); return list[(i + 1) % Math.min(list.length, 4)];
}
function drawCam(t, h) {
  const box = $('#cam'); if (!camVid || clean) { box.classList.remove('on'); return; }
  const v = V[camVid]; if (!v) return;
  box.classList.add('on');
  if (!$('#camc').clientWidth) return;   // hidden on phones
  const c = $('#camc'), cg = c.getContext('2d'), w = c.width = c.clientWidth * DPR, hh = c.height = c.clientHeight * DPR;
  const [ax, ay] = venuePt(v), z = (SC.paths ? 2.4 : 3.2) + Math.sin(t * 0.2) * 0.15, sw = w / z / DPR * 1.0, sh = hh / z / DPR;
  cg.drawImage(IMG, ax - sw / 2 + Math.sin(t * 0.3) * 4, ay - sh * 0.7, sw, sh, 0, 0, w, hh);
  // the people at that place, as soft lights
  for (const p of people) { const wv = where(p, h); if (!wv.vis || wv.vid !== camVid || wv.walk) continue; const [px, py] = artPos(p, wv); const sx = (px - (ax - sw / 2)) / sw * w, sy = (py - (ay - sh * 0.7)) / sh * hh; glow(cg, sx, sy, 2.6 * DPR, p.r[6] ? '111,226,255' : '255,196,120', 0.55); }
  cg.fillStyle = 'rgba(0,0,0,.18)'; for (let y = 0; y < hh; y += 3 * DPR) cg.fillRect(0, y, w, DPR); // scanlines
  const inside = people.filter((p) => { const wv = where(p, h); return wv.vis && !wv.walk && wv.vid === camVid; }).length;
  $('#camlbl').innerHTML = `<b>CAM ${String(hash(camVid) % 40 + 1).padStart(2, '0')}</b> · ${esc(v.name)}<span>${inside} inside · ${esc(v.type)}</span>`;
}
function glow(c, x, y, r, rgb, a) {
  const gr = c.createRadialGradient(x, y, 0, x, y, r * 3); gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(0.25, `rgba(${rgb},${a * 0.45})`); gr.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = gr; c.beginPath(); c.arc(x, y, r * 3, 0, 7); c.fill();
}

// ------------------------------------------------------------------ drawing
let hover = null, picked = null, labels = [], pins = [];
function frame(now) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  if (!IMG.complete || !W) return;
  updateView(t);
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.fillStyle = '#020c10'; g.fillRect(0, 0, W, Hh);
  drawStage();
  // night grade and vignette so the lights read
  const vg = g.createRadialGradient(W * 0.55, Hh * 0.45, Math.min(W, Hh) * 0.2, W * 0.5, Hh * 0.5, Math.max(W, Hh) * 0.75);
  vg.addColorStop(0, 'rgba(2,12,16,0)'); vg.addColorStop(1, 'rgba(2,12,16,0.7)'); g.fillStyle = vg; g.fillRect(0, 0, W, Hh);
  g.fillStyle = 'rgba(4,20,30,0.18)'; g.fillRect(0, 0, W, Hh);
  // twinkling windows
  g.globalCompositeOperation = 'lighter';
  for (const w of windows) { const a = 0.25 + 0.35 * Math.max(0, Math.sin(t * w.sp + w.ph)); const [x, y] = toScreen(w.x, w.y); glow(g, x, y, w.r * view.s * 0.9, w.warm ? '255,190,110' : '140,225,255', a * 0.5); }
  // the rim of the island pulses
  { const a = 0.22 + 0.14 * Math.sin(t * 1.3); g.strokeStyle = SC.paths ? `rgba(255,200,120,${a})` : `rgba(95,220,255,${a})`; g.lineWidth = 2.5 * view.s; g.beginPath(); SC.rim.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }); g.stroke(); }
  // the waterfalls shimmer
  for (const [fx, fy, fh] of SC.falls) { const [x, y] = toScreen(fx, fy); for (let i = 0; i < 12; i++) { const yy = y + ((t * 60 + i * 23) % fh) * view.s; g.fillStyle = 'rgba(170,235,255,0.10)'; g.fillRect(x - 10 * view.s + (i % 5) * 5 * view.s, yy, 2 * view.s, 16 * view.s); } }
  g.globalCompositeOperation = 'source-over';
  // drifting cloud banks along the bottom
  for (const c of clouds) { c.x += c.v * 0.016; if (c.x > SC.clouds[2] * 1.4) c.x = -300; const [x, y] = toScreen(c.x, c.y); const gr = g.createRadialGradient(x, y, 0, x, y, c.r * view.s); gr.addColorStop(0, `rgba(200,225,235,${c.a})`); gr.addColorStop(1, 'rgba(200,225,235,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, c.r * view.s, 0, 7); g.fill(); }

  // the residents
  labels = []; pins = [];
  if (S) {
    const h = cityHour();
    g.globalCompositeOperation = 'lighter';
    for (const p of people) {
      const w = where(p, h); p.now = w; if (!w.vis) { p.trail.length = 0; continue; }
      const [ax, ay] = artPos(p, w), [x, y] = toScreen(ax, ay), dk = depthK(ay); p.sx = x; p.sy = y;
      const agent = p.r[6] === 1, rgb = agent ? '111,226,255' : w.walk ? '255,214,150' : '255,170,90';
      if (w.walk) { p.trail.push([x, y]); if (p.trail.length > 14) p.trail.shift(); g.strokeStyle = `rgba(${rgb},0.35)`; g.lineWidth = 1.4; g.beginPath(); p.trail.forEach(([tx, ty], i) => (i ? g.lineTo(tx, ty) : g.moveTo(tx, ty))); g.stroke(); }
      glow(g, x, y, (agent ? 3.2 : w.walk ? 2.2 : 1.3) * Math.max(1, Math.min(view.s, 1.8) * 0.9) * Math.min(dk, 1.4), rgb, agent ? 1 : w.walk ? 0.95 : SC.paths ? 0.5 : 0.32);
    }
    g.globalCompositeOperation = 'source-over';
    // named bubbles: every outside agent, plus the richest residents out right now
    const out = people.filter((p) => p.now?.vis);
    const named = [...out.filter((p) => p.r[6] === 1), ...out.filter((p) => p.r[6] !== 1).sort((a, b) => b.r[7] - a.r[7]).slice(0, W < 700 ? 2 : 4)];
    if (picked && picked.now?.vis && !named.includes(picked)) named.push(picked);
    if (!clean) named.forEach((p, i) => bubble(p, i, t));
    // venue pins with live counts
    if (!clean) for (const v of S.venues) {
      if (!v.isVenue) continue;
      const inside = out.filter((p) => !p.now.walk && p.now.vid === v.id).length;
      const [ax, ay] = venuePt(v), [x, y] = toScreen(ax, ay);
      g.font = `600 ${W < 700 ? 9 : 10.5}px "JetBrains Mono", ui-monospace, monospace`;
      const txt = `${v.name.toUpperCase()}${inside ? ' · ' + inside : ''}`, tw = g.measureText(txt).width;
      const ly = y - 34 - (hash(v.id) % 3) * 12;
      g.strokeStyle = 'rgba(255,190,120,.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x, ly + 8); g.stroke();
      g.fillStyle = 'rgba(3,14,18,.82)'; g.fillRect(x - tw / 2 - 7, ly - 8, tw + 14, 17); pins.push({ v, x0: x - tw / 2 - 7, y0: ly - 8, x1: x + tw / 2 + 7, y1: ly + 9 });
      g.fillStyle = v.ownerOutside ? '#7fe3ff' : '#ffd08a'; g.fillRect(x - tw / 2 - 7, ly - 8, 2, 17);
      g.fillStyle = '#e8eef0'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, x, ly + 0.5);
    }
    if (showRain && !clean) {
      g.strokeStyle = 'rgba(170,220,240,.13)'; g.lineWidth = 1;
      for (const d of rain) { d.y += d.v * 0.012; if (d.y > 1.1) { d.y = -0.1; d.x = Math.random(); } g.beginPath(); g.moveTo(d.x * W, d.y * Hh); g.lineTo(d.x * W - d.l * Hh * 0.25, (d.y + d.l) * Hh); g.stroke(); }
    }
    if (t - camAt > 9) { camAt = t; camVid = pickCam(h); }
    drawCam(t, h);
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    $('#clk').textContent = `Day ${cityDay()} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    $('#out').textContent = out.length; $('#walking').textContent = out.filter((p) => p.now.walk).length;
  }
}
function bubble(p, i, t) {
  const agent = p.r[6] === 1, x = p.sx, y = p.sy, up = 58 + (i % 3) * 22, side = i % 2 ? 1 : -1;
  const bx = x + side * (18 + (i % 2) * 10), by = y - up, r = W < 700 ? 13 : 16;
  const col = agent ? '#6fe2ff' : '#ffb35c';
  g.strokeStyle = col; g.globalAlpha = 0.7; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x, y); g.lineTo(bx, by + r); g.stroke(); g.globalAlpha = 1;
  // portrait disc: initials on a colour from their id
  const gr = g.createLinearGradient(bx, by - r, bx, by + r); gr.addColorStop(0, `hsl(${(hash(p.r[0]) % 360)},35%,38%)`); gr.addColorStop(1, `hsl(${(hash(p.r[0]) % 360)},45%,18%)`);
  g.fillStyle = gr; g.beginPath(); g.arc(bx, by, r, 0, 7); g.fill();
  g.lineWidth = 2.5; g.strokeStyle = col; g.stroke();
  g.fillStyle = '#fff'; g.font = `600 ${r * 0.78}px "DM Sans", system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(p.r[1].split(' ').map((s) => s[0]).join('').slice(0, 2), bx, by + 1);
  // name tag
  g.font = `600 ${W < 700 ? 9.5 : 11}px "JetBrains Mono", ui-monospace, monospace`;
  const name = p.r[1].toUpperCase(), tag = agent ? 'AGENT' : money(p.r[7]), tw = Math.max(g.measureText(name).width, 40);
  const tx = bx + side * (r + 8), ax = side > 0 ? tx : tx - tw - 14;
  g.fillStyle = 'rgba(3,14,18,.86)'; g.fillRect(ax, by - 16, tw + 14, 30);
  g.fillStyle = col; g.fillRect(ax, by + 13, tw + 14, 1.5);
  g.fillStyle = '#e8eef0'; g.textAlign = 'left'; g.fillText(name, ax + 7, by - 7);
  g.fillStyle = col; g.font = `500 ${W < 700 ? 8.5 : 9.5}px "JetBrains Mono", ui-monospace, monospace`; g.fillText(tag + (p.now.walk ? ' · walking' : p.now.vid && V[p.now.vid] ? ' · ' + V[p.now.vid].name : ''), ax + 7, by + 6);
  labels.push({ p, x: bx, y: by, r: r + 4 });
}

// ------------------------------------------------------------------ panels
function renderPanels() {
  const h = cityHour(), out = people.map((p) => ({ p, w: where(p, h) }));
  const at = {}; for (const { w } of out) if (w.vis && !w.walk && w.vid) at[w.vid] = (at[w.vid] || 0) + 1;
  $('#places').innerHTML = S.venues.filter((v) => v.isVenue).sort((a, b) => (at[b.id] || 0) - (at[a.id] || 0)).map((v, i) => `<div class="pl ${camVid === v.id ? 'on' : ''}" data-v="${esc(v.id)}"><span>${String(i + 1).padStart(2, '0')}</span><b>${esc(v.name)}</b><em>${at[v.id] || ''}</em></div>`).join('');
  const feed = [...(S.agentLog || []).slice(0, 4).map((a) => ({ t: a.t, who: 'AGENT', text: `${a.name} ${a.op}${a.ok ? '' : ' (refused)'}`, ag: true })), ...S.chronicle.slice(0, 8).map((c) => ({ t: c.t, who: 'CITY', text: c.text }))].sort((a, b) => b.t - a.t).slice(0, 7);
  $('#feed').innerHTML = feed.map((f) => `<div class="fe"><span class="ft">${new Date(f.t).toISOString().slice(11, 16)}</span><span class="fw ${f.ag ? 'ag' : ''}">${f.who}</span><p>${esc(f.text)}</p></div>`).join('');
  $('#res').textContent = S.residents.length; $('#agents').textContent = S.residents.filter((r) => r[6]).length;
  $('#jobs').textContent = (S.jobs || []).filter((j) => j.status === 'open').length;
}
$('#places').addEventListener('click', (e) => { const r = e.target.closest('.pl'); if (!r) return; if (EXPLORE && V[r.dataset.v]) { flyTo(V[r.dataset.v]); return; } camVid = r.dataset.v; camAt = performance.now() / 1000; renderPanels(); });
function flyTo(v, z = 2.4) { const [ax, ay] = venuePt(v); cam.tx = ax; cam.ty = ay - 20; cam.tz = z; camVid = v.id; camAt = performance.now() / 1000; renderPanels(); }
let drag = null, moved = 0; const ptrs = new Map();
if (EXPLORE) {
  cv.style.cursor = 'grab'; cv.style.touchAction = 'none';
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); drag = { x: e.clientX, y: e.clientY, cx: cam.tx, cy: cam.ty, d: ptrs.size === 2 ? pinchD() : 0, z: cam.tz }; moved = 0; cv.style.cursor = 'grabbing'; });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect(); cam.mx = (e.clientX - r.left) / r.width - 0.5; cam.my = (e.clientY - r.top) / r.height - 0.5;
    if (!drag || !ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 2 && drag.d) { cam.tz = clamp(drag.z * pinchD() / drag.d, 1, 3.5); moved = 99; return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; moved = Math.max(moved, Math.hypot(dx, dy));
    cam.tx = drag.cx - dx / view.s; cam.ty = drag.cy - dy / view.s;
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) { drag = null; cv.style.cursor = 'grab'; } else if (drag) { const [x, y] = [...ptrs.values()][0]; drag = { x, y, cx: cam.tx, cy: cam.ty, d: 0, z: cam.tz }; } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => {
    e.preventDefault(); const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const ax = (mx - view.ox) / view.s, ay = (my - view.oy) / view.s, nz = clamp(cam.tz * Math.exp(-e.deltaY * 0.0015), 1, 3.5);
    // zoom towards the pointer
    cam.tx = ax + (cam.tx - ax) * (cam.tz / nz); cam.ty = ay + (cam.ty - ay) * (cam.tz / nz); cam.tz = nz;
  }, { passive: false });
  addEventListener('keydown', (e) => { if (e.key === '0' || e.key === 'Escape') { cam.tx = 700; cam.ty = 390; cam.tz = 1; } });
}
function pinchD() { const [a, b] = [...ptrs.values()]; return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0; }
cv.addEventListener('click', (e) => {
  if (EXPLORE && moved > 6) return;
  { const r0 = cv.getBoundingClientRect(), px = e.clientX - r0.left, py = e.clientY - r0.top; const pin = pins.find((q) => px >= q.x0 && px <= q.x1 && py >= q.y0 && py <= q.y1); if (pin && EXPLORE) { flyTo(pin.v); return; } }
  const rect = cv.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
  const hit = labels.find((l) => Math.hypot(l.x - x, l.y - y) < l.r) || people.filter((p) => p.now?.vis).sort((a, b) => Math.hypot(a.sx - x, a.sy - y) - Math.hypot(b.sx - x, b.sy - y))[0];
  if (!hit) return;
  const p = hit.p || hit; if (Math.hypot(p.sx - x, p.sy - y) > 40 && !hit.p) return;
  picked = p; const w = p.now, v = w.vid && V[w.vid];
  $('#card').innerHTML = `<button id="cardx" aria-label="Close">×</button><div class="ck">${p.r[6] ? 'Outside agent' : 'Resident'}</div><h3>${esc(p.r[1])}</h3><p>${w.walk ? 'Walking' + (v ? ' to ' + esc(v.name) : ' home') : v ? 'At ' + esc(v.name) : 'Out'}</p><div class="cs"><span>Cash <b>${money(p.r[7])}</b></span><span>Mood <b>${p.r[8]}</b></span></div><a href="/#follow=${encodeURIComponent(p.r[0])}">Follow in the 3D city →</a>`;
  $('#card').classList.add('on'); $('#cardx').onclick = () => { $('#card').classList.remove('on'); picked = null; };
});
function setScene(id) {
  SC = SCENES[id]; CROP = SC.crop; IMG.src = SC.img; sceneFX(); assignSpots();
  for (const p of people) { p.routes = {}; p.trail.length = 0; }
  document.querySelectorAll('[data-scene]').forEach((b) => b.classList.toggle('on', b.dataset.scene === id));
  try { history.replaceState(null, '', id === 'golden' ? location.pathname : '?scene=' + id); } catch {}
}
document.querySelectorAll('#breset').forEach((b) => (b.onclick = () => { cam.tx = 700; cam.ty = 390; cam.tz = 1; }));
$('#bclean').onclick = () => { clean = !clean; document.body.classList.toggle('clean', clean); $('#bclean').classList.toggle('on', clean); };
$('#brain').onclick = () => { showRain = !showRain; $('#brain').classList.toggle('on', showRain); };

resize(); requestAnimationFrame(frame);
IMG.onload = () => resize();
poll(true); setInterval(() => poll(false), 5000);
