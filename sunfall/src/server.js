import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CFG, state, clock, tick, save, load, initWorld, recentLines, readLedgerFile, netWorth, cityStats, venueValueNow } from './sim.js';
import { runOp, spec, leaderboard, residentView, venueView, staffOf } from './api.js';
import { mcpHandler } from './mcp.js';
import { vaultView, recordFlow, checkAdmin, dueAwards, scanFeeClaims } from './vault.js';
import { refreshTokenPrice } from './market.js';
import { Refusal } from './util.js';
import { TOKEN, CHAIN } from './chain.js';
import { migrate, seasonCheck, dailyCheck, eventView, standings, titles } from './play.js';
import { pollReal, arenaNow } from './football.js';
import { pollNfl, fieldNow } from './gridiron.js';
import { execFile } from 'node:child_process';
import { DISTRICTS, TRADES, CITIES, FERRY } from './world.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8787;

if (!load()) { initWorld(); save(); console.log('new city generated'); } else { migrate(); console.log(`city loaded: day ${state.day}, ${Object.keys(state.residents).length} residents, season ${state.season.n}`); }
seasonCheck();
tick();
setInterval(() => { try { tick(); } catch (e) { console.error('tick', e); } }, 500);
setInterval(() => { try { dailyCheck(); } catch (e) { console.error('daily close', e); } }, 5000); // close each prize day on the dot, not at the next city day turn
setInterval(() => { try { save(); } catch (e) { console.error('save', e); } }, 5000);
// Real football fixtures, odds and results: the next week every half hour, today's scores every three minutes.
setTimeout(() => pollReal().catch((e) => console.error('football feed', e)), 5000);
setInterval(() => pollReal().catch((e) => console.error('football feed', e)), 3 * 60_000);
setTimeout(() => pollNfl().catch((e) => console.error('nfl feed', e)), 20_000);
// the live $SUNFALL price for the Market, read from its pool every five minutes
setTimeout(() => refreshTokenPrice().catch((e) => console.error('token price', e.message)), 10_000);
setInterval(() => refreshTokenPrice().catch((e) => console.error('token price', e.message)), 5 * 60_000);
// creator-fee claims into the Vault, read from Elysium every two minutes
if (process.env.FEE_SCAN !== 'off') {
  setTimeout(() => scanFeeClaims().catch((e) => console.error('fee scan', e.message)), 15_000);
  setInterval(() => scanFeeClaims().catch((e) => console.error('fee scan', e.message)), 2 * 60_000);
}
setInterval(() => pollNfl().catch((e) => console.error('nfl feed', e)), 3 * 60_000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { save(); } finally { process.exit(0); } });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

const gz = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');
function sendRaw(req, res, status, body, headers) {
  if (gz(req) && body.length > 1024) {
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    return res.end(zlib.gzipSync(body, { level: 6 }));
  }
  res.writeHead(status, headers);
  res.end(body);
}
function send(res, status, obj, extra = {}) {
  sendRaw(res.req || { headers: {} }, res, status, Buffer.from(JSON.stringify(obj)), { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...extra });
}
// The spectate snapshot is the hot path: build it at most once a second, gzip it once.
let snapCache = { at: 0, raw: null, gz: null };
function sendSnapshot(req, res) {
  const now = Date.now();
  if (now - snapCache.at > 1000) {
    const raw = Buffer.from(JSON.stringify(snapshot()));
    snapCache = { at: now, raw, gz: zlib.gzipSync(raw, { level: 6 }) };
  }
  const h = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (gz(req)) { res.writeHead(200, { ...h, 'content-encoding': 'gzip', vary: 'accept-encoding' }); return res.end(snapCache.gz); }
  res.writeHead(200, h); res.end(snapCache.raw);
}
// Static files, gzipped once and kept in memory (the whole public folder is ~1.5 MB).
const staticCache = new Map();
function sendStatic(req, res, file) {
  let c = staticCache.get(file);
  if (!c) {
    const raw = fs.readFileSync(file);
    const ext = path.extname(file);
    const zip = ['.html', '.js', '.css', '.md', '.json', '.svg', '.glb', '.txt', '.ttf'].includes(ext);
    c = { raw, gz: zip ? zlib.gzipSync(raw, { level: 9 }) : null, type: MIME[ext] || 'application/octet-stream',
      cache: /[\\/](vendor|models|fonts)[\\/]/.test(file) || ext === '.png' ? 'public, max-age=86400' : 'no-cache' };
    staticCache.set(file, c);
  }
  const h = { 'content-type': c.type, 'cache-control': c.cache };
  if (c.type.startsWith('text/html')) {
    // Share cards need absolute URLs; fill in this site's own address.
    const body = Buffer.from(c.raw.toString('utf8').replaceAll('%ORIGIN%', originOf(req)));
    return sendRaw(req, res, 200, body, h);
  }
  if (c.gz && gz(req)) { res.writeHead(200, { ...h, 'content-encoding': 'gzip', vary: 'accept-encoding' }); return res.end(c.gz); }
  res.writeHead(200, h); res.end(c.raw);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 16384) { reject(new Refusal(413, 'body too large')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
const originOf = (req) => (process.env.PUBLIC_URL || `${(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`).replace(/\/$/, '');
const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : null; };

// Compact snapshot for the spectate page.
function snapshot() {
  const c = clock();
  const residents = Object.values(state.residents).map((r) => [
    r.id, r.name, r.home[0], r.home[1], r.plan?.aft === 'work' ? r.workplace : r.plan?.aftVenue || null,
    r.plan?.night === 'work' ? r.workplace : r.plan?.nightVenue || null, r.outside ? 1 : 0, Math.round(r.cash), r.mood,
  ]);
  const billboard = state.billboards.find((b) => b.day === state.day);
  return {
    clock: { day: state.day, hour: c.hour, dayMs: CFG.DAY_MS, epoch: state.epoch, now: c.now, landed: state.done },
    treasury: Math.round(state.treasury), cashInCity: Math.round(Object.values(state.residents).reduce((s, r) => s + r.cash, 0)),
    districts: DISTRICTS,
    cities: CITIES, ferry: FERRY, cityStats: state.nightfall ? cityStats() : null, rivalry: state.rivalry || null,
    venues: Object.values(state.venues).map((v) => ({ id: v.id, type: v.type, name: v.name, district: v.district, x: v.x, y: v.y, isVenue: v.isVenue, price: v.price, owner: v.ownerId ? state.residents[v.ownerId].name : null, ownerOutside: v.ownerId ? state.residents[v.ownerId].outside : false, partners: (v.partners || []).map((p) => ({ name: state.residents[p.id].name, pct: p.pct, outside: state.residents[p.id].outside })), fireSale: v.fireSale != null, forSale: v.forSale, salePrice: v.salePrice, visitsToday: v.visitsToday, takingsToday: Math.round(v.takingsToday), lifetime: v.lifetime, staff: Object.values(state.residents).filter((r) => r.workplace === v.id).length, payroll: Object.values(state.residents).filter((r) => r.workplace === v.id).reduce((t, r) => t + TRADES[r.trade].wage, 0), distress: v.distress || 0 })),
    residents,
    chronicle: state.chronicle.slice(-40).reverse(),
    football: arenaNow(),
    gridiron: fieldNow(),
    casino: (state.casinoHands || []).filter((h) => h.agent).slice(-8).map((h) => ({ t: h.t, day: h.day, rid: h.rid, name: h.name, player: h.player, dealer: h.dealer, pt: h.pt, dt: h.dt, result: h.result, net: h.net, venue: state.venues[h.venue]?.name || 'the casino' })),
    square: state.square.slice(-40).reverse().map((p) => ({ name: p.name, outside: p.outside, text: p.text, day: p.day, who: p.who })),
    jobs: Object.values(state.jobs).slice(-40).reverse().map((j) => ({ id: j.id, by: j.by === 'city' ? 'city' : state.residents[j.by].name, venue: state.venues[j.venue].name, half: j.half, day: j.day, pay: j.pay, status: j.status, takenBy: j.takenBy && state.residents[j.takenBy].name })),
    league: leaderboard(),
    ledger: { head: state.ledgerHead, count: state.ledgerCount, recent: recentLines().slice(-30).reverse(), dayRoots: state.dayRoots.slice(-10).reverse() },
    billboard: billboard ? { name: billboard.name, text: billboard.text } : null,
    agentLog: (state.agentLog || []).slice(-30).reverse(),
    season: (() => { const rows = standings(); return { n: state.season.n, id: state.season.id, end: state.season.end, agents: rows.length, top: rows.slice(0, 10), titles: titles(rows) }; })(),
    event: eventView(state.event && state.event.day === state.day ? state.event : null), forecast: eventView(state.forecast),
    bank: { openLoans: Object.values(state.loans).filter((l) => l.status === 'open').length, activeLoans: Object.values(state.loans).filter((l) => l.status === 'active').length, stakeOffers: Object.values(state.stakeOffers).filter((o) => o.status === 'open').length },
    token: { ticker: TOKEN.ticker, live: Boolean(TOKEN.address), address: TOKEN.address },
    chain: { name: CHAIN.name, id: CHAIN.id, explorer: CHAIN.explorer },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' });
      return res.end();
    }
    if (p === '/mcp') {
      const body = req.method === 'POST' ? await readBody(req) : '';
      return mcpHandler(req, res, body, { ip: ipOf(req), token: bearer(req) });
    }
    if (p === '/healthz') return send(res, 200, { ok: true, day: state.day, residents: Object.keys(state.residents).length });
    if (p === '/api/state') return sendSnapshot(req, res);
    if (p === '/api/spec' || (p === '/api/agents' && req.method === 'GET')) return send(res, 200, spec());
    if (p === '/api/resident') {
      const r = state.residents[url.searchParams.get('id')];
      if (!r) return send(res, 404, { ok: false, reason: 'no such resident' });
      // the profile page: recent money lines, chronicle mentions and (for agents) the season standing
      const out = { ok: true, resident: residentView(r) };
      out.activity = recentLines().filter((e) => e.who === r.id).slice(-25).reverse().map((e) => ({ t: e.t, day: e.day, kind: e.kind, amt: e.amt, note: e.note }));
      out.news = state.chronicle.filter((c) => c.who === r.id).slice(-8).reverse();
      if (r.outside) {
        const rows = standings(), i = rows.findIndex((x) => x.id === r.id);
        if (i >= 0) out.standing = { rank: i + 1, of: rows.length, prizeScore: rows[i].prizeScore, prizeEligible: rows[i].prizeEligible, team: rows[i].team, fromAgents: rows[i].fromAgents, casino: rows[i].casino, betting: rows[i].betting };
      }
      return send(res, 200, out);
    }
    if (p === '/api/venue') {
      const v = state.venues[url.searchParams.get('id')];
      if (!v) return send(res, 404, { ok: false, reason: 'no such venue' });
      const out = { ok: true, venue: venueView(v), value: Math.round(venueValueNow(v)) };
      out.staff = staffOf(v).map((r) => ({ id: r.id, name: r.outside ? { quoted: r.name } : r.name, isAgent: r.outside, trade: TRADES[r.trade].name, wage: TRADES[r.trade].wage }));
      out.activity = recentLines().filter((e) => e.who === v.id || (e.note || '').includes(v.name)).slice(-25).reverse().map((e) => ({ t: e.t, day: e.day, kind: e.kind, who: e.who, amt: e.amt, note: e.note }));
      out.news = state.chronicle.filter((c) => c.text.includes(v.name)).slice(-8).reverse();
      return send(res, 200, out);
    }
    if (p === '/api/vault' && req.method === 'GET') return send(res, 200, { ok: true, ...(await vaultView()) });
    if (p === '/api/admin/payouts' && req.method === 'GET') {
      checkAdmin(req.headers['x-admin-key']);
      return send(res, 200, { ok: true, due: dueAwards() });
    }
    if (p === '/api/admin/vault' && req.method === 'POST') {
      checkAdmin(req.headers['x-admin-key']);
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { ok: false, reason: 'body must be JSON' }); }
      return send(res, 201, { ok: true, entry: recordFlow(body) });
    }
    if (p === '/api/ledger/export') {
      const after = Number(url.searchParams.get('after') || 0);
      const lines = readLedgerFile().filter((e) => e.i > after).slice(0, 5000);
      return send(res, 200, { ok: true, lines, head: state.ledgerHead, count: state.ledgerCount, dayRoots: state.dayRoots });
    }
    if (p.startsWith('/api/agents')) {
      if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'POST only' });
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, reason: 'body must be JSON' }); }
      const op = p.split('/')[3] || body.op;
      const { op: _op, ...fields } = body;
      const out = await runOp(op, fields, { ip: ipOf(req), token: bearer(req) || fields.token });
      return send(res, out.status || 200, out);
    }
    // The Districts page has been retired; old links land on the city.
    if (p === '/districts' || p === '/districts.html') { res.writeHead(301, { location: '/' }); return res.end(); }
    // static
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(path.join(PUBLIC, file));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { ok: false });
    if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    return sendStatic(req, res, file);
  } catch (e) {
    if (e instanceof Refusal) return send(res, e.status, { ok: false, reason: e.reason });
    console.error(e);
    return send(res, 500, { ok: false, reason: 'internal error' });
  }
});
// Self-update: when the server runs from a git checkout, it checks for new commits every few minutes,
// pulls them, saves the city and exits so the process manager starts the new version. AUTO_UPDATE=0 turns it off.
const REPO_ROOT = path.resolve(ROOT, '..');
const gitDir = [ROOT, REPO_ROOT].find((d) => fs.existsSync(path.join(d, '.git')));
const git = (args) => new Promise((resolve) => execFile('git', ['-C', gitDir, ...args], { timeout: 60_000 }, (err, out) => resolve(err ? null : String(out).trim())));
if (gitDir && process.env.AUTO_UPDATE !== '0') {
  const every = Math.max(0.1, Number(process.env.AUTO_UPDATE_MIN) || 5) * 60_000;
  setInterval(async () => {
    if (await git(['fetch', '--quiet']) === null) return;
    const [here, there] = await Promise.all([git(['rev-parse', 'HEAD']), git(['rev-parse', '@{u}'])]);
    if (!here || !there || here === there) return;
    if (await git(['pull', '--ff-only', '--quiet']) === null) { console.error('auto-update: pull failed'); return; }
    console.log(`auto-update: ${here.slice(0, 7)} -> ${there.slice(0, 7)}, restarting`);
    try { save(); } finally { process.exit(0); }
  }, every);
  console.log(`auto-update on: checking ${gitDir} every ${every / 60000} min`);
}

server.listen(PORT, () => console.log(`Sunfall on http://localhost:${PORT}  (MCP: /mcp, day = ${CFG.DAY_MS / 60000} min)`));
