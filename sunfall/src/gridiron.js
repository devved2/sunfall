// American football at Skyline Field. Like the Arena (src/football.js), two kinds of game and one slip system:
//  - The Sunfall Gridiron League: a team from each district, three games every city day, played live at Skyline
//    Field (four quarters over two city hours). Every drive is drawn with the city's secure random at kick-off, never
//    before, and scores are revealed as the game clock reaches them. A tie after four quarters goes to overtime, so a
//    league game always has a winner.
//  - Real NFL games: fixtures, moneyline odds and results from ESPN's public scoreboard. Bets close at the real kick-off;
//    a real game that ends tied, or is called off, returns the stake.
// Bets are city cash, placed with the same bet op as football; Skyline Field is the bookmaker for these games.
import { state, chron, CFG } from './sim.js';
import { DISTRICTS, LAST } from './world.js';
import { secureRandom, mulberry32, pick, clamp } from './util.js';
import { registerMatches, settle, nativesBet, allBets, betView } from './football.js';

export const FIELD = 'v13';
const GAME_HOURS = 2;
const KICKOFFS = [12, 16, 20];
const ROUNDS = 10;
const MARGIN = 1.06;

export const TEAMS = [
  { id: 'TER', name: 'Terraces Thunder', district: 'flats', off: 1.0, def: 1.0, col: '#a77bd6' },
  { id: 'SPI', name: 'Spires Stags', district: 'hillside', off: 1.06, def: 0.94, col: '#5fbf8a' },
  { id: 'CRY', name: 'Crystal Comets', district: 'neon', off: 1.14, def: 1.06, col: '#ff4fa3' },
  { id: 'LAN', name: 'Lantern Knights', district: 'oldtown', off: 0.98, def: 0.9, col: '#e2a63c' },
  { id: 'SKY', name: 'Skyport Gulls', district: 'harbour', off: 1.02, def: 1.02, col: '#4fb8e8' },
  { id: 'CLO', name: 'Cloudworks Forge', district: 'saltworks', off: 0.92, def: 0.97, col: '#9aa3ad' },
];
const TEAM = Object.fromEntries(TEAMS.map((t) => [t.id, t]));
const ROSTER = Object.fromEntries(TEAMS.map((t, i) => {
  const rnd = mulberry32(7300 + i * 41);
  const names = new Set();
  while (names.size < 6) names.add(pick(LAST, rnd));
  return [t.id, [...names]];
}));

const G = () => {
  state.gridiron ||= { league: null, games: {}, real: {} };
  const g = state.gridiron;
  g.league ||= { n: 1, startDay: state.day, table: freshTable() };
  return g;
};
function freshTable() { return Object.fromEntries(TEAMS.map((t) => [t.id, { p: 0, w: 0, l: 0, pf: 0, pa: 0 }])); }
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- the game model
// Each side gets about eleven drives. A drive ends in a touchdown (7, or 6 if the kick is missed), a field goal, or nothing.
function driveOdds(att, dfn) {
  const td = clamp(0.2 * TEAM[att].off / TEAM[dfn].def, 0.06, 0.4);
  const fg = clamp(0.15 * Math.sqrt(TEAM[att].off / TEAM[dfn].def), 0.06, 0.25);
  return { td, fg };
}
function playGame(home, away, rnd) {
  const events = [];
  const drives = 10 + Math.floor(rnd() * 3);
  const pts = { home: 0, away: 0 };
  for (let i = 0; i < drives * 2; i++) {
    const side = i % 2 ? 'away' : 'home';
    const [att, dfn] = side === 'home' ? [home, away] : [away, home];
    const o = driveOdds(att, dfn), u = rnd();
    const min = Math.min(60, 1 + Math.floor(((i + rnd()) / (drives * 2)) * 60));
    const team = side === 'home' ? home : away;
    if (u < o.td) { const p = rnd() < 0.94 ? 7 : 6; pts[side] += p; events.push({ min, side, kind: 'td', pts: p, who: pick(ROSTER[team], rnd) }); }
    else if (u < o.td + o.fg) { pts[side] += 3; events.push({ min, side, kind: 'fg', pts: 3, who: pick(ROSTER[team], rnd) }); }
  }
  // overtime: alternate drives until someone scores (a field goal at the latest)
  let ot = 0;
  while (pts.home === pts.away) {
    const side = ot % 2 ? 'away' : 'home', team = side === 'home' ? home : away;
    const [att, dfn] = side === 'home' ? [home, away] : [away, home];
    const o = driveOdds(att, dfn), u = rnd();
    const kind = u < o.td ? 'td' : u < o.td + o.fg + 0.15 || ot >= 5 ? 'fg' : null;
    if (kind) { const p = kind === 'td' ? 6 : 3; pts[side] += p; events.push({ min: 61 + ot, side, kind, pts: p, who: pick(ROSTER[team], rnd), ot: true }); }
    ot++;
  }
  events.sort((a, b) => a.min - b.min);
  return { events, final: [pts.home, pts.away] };
}
function winProb(home, away) {
  let w = 0; const n = 3000;
  for (let i = 0; i < n; i++) { const g = playGame(home, away, Math.random); if (g.final[0] > g.final[1]) w++; }
  return clamp(w / n, 0.05, 0.95);
}
const toOdds = (p) => Math.max(1.05, Math.round((1 / (p * MARGIN)) * 100) / 100);

// ---------------------------------------------------------------- fixtures
function roundPairs(round) {
  const ids = TEAMS.map((t) => t.id);
  const k = round % 5, flip = round >= 5;
  const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + k) % 5)])];
  const pairs = [[rot[0], rot[5]], [rot[1], rot[4]], [rot[2], rot[3]]];
  return pairs.map(([a, b], i) => ((i + k + (flip ? 1 : 0)) % 2 ? [b, a] : [a, b]));
}
const koMs = (day, hour) => state.epoch + day * CFG.DAY_MS + (hour / 24) * CFG.DAY_MS;
function ensureFixtures(day) {
  const g = G(), lg = g.league;
  if (day - lg.startDay >= ROUNDS) return;
  const round = day - lg.startDay;
  roundPairs(round).forEach(([home, away], i) => {
    const id = `g${day}-${i + 1}`;
    if (g.games[id]) return;
    const p = winProb(home, away);
    g.games[id] = {
      id, kind: 'gleague', venue: FIELD, season: lg.n, round: round + 1, day,
      home: { id: home, name: TEAM[home].name, col: TEAM[home].col }, away: { id: away, name: TEAM[away].name, col: TEAM[away].col },
      ko: koMs(day, KICKOFFS[i]), ft: koMs(day, KICKOFFS[i] + GAME_HOURS), p,
      odds: { home: toOdds(p), away: toOdds(1 - p) }, status: 'scheduled', score: [0, 0], events: [],
    };
  });
}
export function clockOf(m, now = Date.now()) {
  if (m.status === 'scheduled') return 0;
  if (m.status === 'ft') return 60;
  return clamp(Math.floor(((now - m.ko) / (m.ft - m.ko)) * 60) + 1, 1, 60);
}
function kickOff(m) {
  const game = playGame(m.home.id, m.away.id, secureRandom);
  m.events = game.events; m.final = game.final; m.status = 'live';
  nativesBet(m, { home: m.p, draw: 0, away: 1 - m.p });
}
function fullTime(m) {
  m.status = 'ft'; m.score = m.final;
  const t = G().league.table, [h, a] = m.score, H = t[m.home.id], A = t[m.away.id];
  H.p++; A.p++; H.pf += h; H.pa += a; A.pf += a; A.pa += h;
  if (h > a) { H.w++; A.l++; } else { A.w++; H.l++; }
  m.result = h > a ? 'home' : 'away';
  settle(m.id, m.result);
  chron(`Final at Skyline Field: ${m.home.name} ${h}-${a} ${m.away.name}${m.events.some((e) => e.ot) ? ' in overtime' : ''}.`, null, 'football');
}
export function gridironTick(now = Date.now()) {
  if (!state.venues[FIELD]) return;
  const g = G();
  if (state.day - g.league.startDay >= ROUNDS) {
    const top = leagueTable()[0];
    if (top) chron(`${top.name} win Sunfall Gridiron League season ${g.league.n}, ${top.w}-${top.l}.`, null, 'football');
    g.league = { n: g.league.n + 1, startDay: state.day, table: freshTable(), lastChampion: top ? top.id : null };
  }
  ensureFixtures(state.day); ensureFixtures(state.day + 1);
  for (const m of Object.values(g.games)) {
    if (m.status === 'scheduled' && now >= m.ko) kickOff(m);
    if (m.status === 'live') {
      const min = clockOf(m, now);
      m.score = ['home', 'away'].map((s) => m.events.filter((e) => e.side === s && e.min <= min).reduce((t, e) => t + e.pts, 0));
      if (now >= m.ft) fullTime(m);
    }
  }
  for (const id of Object.keys(g.games)) if (g.games[id].day < state.day - 4) delete g.games[id];
  for (const m of Object.values(g.real)) if (m.settled == null && !m.completed && m.ko < now - 2 * 86400_000) settle(m.id, 'void');
}

// ---------------------------------------------------------------- real NFL (ESPN public scoreboard)
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const american = (s) => { const n = Number(String(s ?? '').replace('+', '')); if (!Number.isFinite(n) || n === 0) return null; return r2(n > 0 ? 1 + n / 100 : 1 + 100 / -n); };
async function fetchDay(day) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${day}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    return (await res.json()).events || [];
  } catch { return []; } finally { clearTimeout(to); }
}
function absorb(e) {
  const c = e.competitions?.[0]; if (!c) return;
  const home = c.competitors?.find((t) => t.homeAway === 'home'), away = c.competitors?.find((t) => t.homeAway === 'away');
  if (!home || !away) return;
  const g = G(), id = 'n' + e.id;
  const m = g.real[id] ||= { id, kind: 'nfl', venue: FIELD, league: 'NFL' };
  const ml = c.odds?.[0]?.moneyline;
  const odds = ml ? { home: american(ml.home?.close?.odds ?? ml.home?.open?.odds), away: american(ml.away?.close?.odds ?? ml.away?.open?.odds) } : null;
  Object.assign(m, {
    ko: Date.parse(e.date), home: { name: home.team?.displayName || '?', abbr: home.team?.abbreviation || '' }, away: { name: away.team?.displayName || '?', abbr: away.team?.abbreviation || '' },
    state: e.status?.type?.state || 'pre', statusName: e.status?.type?.name || '', detail: e.status?.type?.shortDetail || '', completed: Boolean(e.status?.type?.completed),
    score: [Number(home.score) || 0, Number(away.score) || 0], updated: Date.now(),
  });
  if (m.state === 'pre' && odds && odds.home && odds.away) m.odds = odds;
  if (m.completed && m.settled == null) settle(id, m.score[0] > m.score[1] ? 'home' : m.score[0] < m.score[1] ? 'away' : 'void');
  else if (/POSTPONED|CANCELED|CANCELLED/i.test(m.statusName) && m.settled == null) settle(id, 'void');
}
let polling = false, lastWide = 0;
export async function pollNfl(now = Date.now()) {
  if (polling || process.env.REAL_FOOTBALL === '0') return;
  polling = true;
  try {
    const wide = now - lastWide > 30 * 60_000;
    const days = wide ? Array.from({ length: 12 }, (_, i) => i - 2) : [-1, 0];
    for (const d of days) for (const e of await fetchDay(ymd(now + d * 86400_000))) absorb(e);
    if (wide) lastWide = now;
    const g = G();
    for (const [id, m] of Object.entries(g.real)) if (m.ko < now - 4 * 86400_000 && m.settled != null) delete g.real[id];
  } finally { polling = false; }
}

registerMatches((id) => (state.gridiron ? state.gridiron.games[id] || state.gridiron.real[id] : null));

// ---------------------------------------------------------------- views
export function leagueTable() {
  const t = G().league.table;
  return TEAMS.map((x) => ({ id: x.id, name: x.name, district: DISTRICTS.find((d) => d.id === x.district)?.name, col: x.col, ...t[x.id], diff: t[x.id].pf - t[x.id].pa }))
    .sort((a, b) => b.w - a.w || a.l - b.l || b.diff - a.diff || a.name.localeCompare(b.name));
}
const quarterOf = (min) => (min > 60 ? 'OT' : `Q${Math.min(4, Math.ceil(min / 15))}`);
function gameView(m, now = Date.now()) {
  const min = clockOf(m, now);
  return {
    id: m.id, kind: 'gleague', round: m.round, day: m.day, kickoff: m.ko, status: m.status,
    clock: m.status === 'live' ? `${quarterOf(min)} ${String(15 - ((min - 1) % 15) - 1).padStart(2, '0')}:00` : null, minute: m.status === 'live' ? min : null,
    home: m.home, away: m.away, score: m.status === 'scheduled' ? null : m.score, odds: m.odds, open: m.status === 'scheduled' && now < m.ko,
    events: m.status === 'scheduled' ? [] : m.events.filter((e) => m.status === 'ft' || e.min <= min).map(({ min: mi, side, kind, pts, who, ot }) => ({ min: mi, quarter: quarterOf(mi), side, kind, pts, who, ot: Boolean(ot) })),
    result: m.result || null,
  };
}
function realView(m, now = Date.now()) {
  return {
    id: m.id, kind: 'nfl', league: 'NFL', kickoff: m.ko, status: m.completed ? 'ft' : m.state === 'in' ? 'live' : /POSTPONED|CANCEL/i.test(m.statusName) ? 'off' : 'scheduled',
    detail: m.detail, home: m.home, away: m.away, score: m.state === 'pre' ? null : m.score, odds: m.odds || null,
    open: m.state === 'pre' && Boolean(m.odds) && now < m.ko - 60_000, result: m.settled || null,
  };
}
const KINDS = ['gleague', 'nfl'];
export function gridironView(resident) {
  const g = G(), now = Date.now();
  const games = Object.values(g.games).sort((a, b) => a.ko - b.ko);
  const real = Object.values(g.real).sort((a, b) => a.ko - b.ko);
  const me = typeof resident === 'string' ? state.residents[resident] : null;
  const bets = allBets().filter((b) => KINDS.includes(b.kind));
  return {
    field: { id: FIELD, name: state.venues[FIELD]?.name },
    league: {
      season: g.league.n, round: Math.min(ROUNDS, state.day - g.league.startDay + 1), rounds: ROUNDS, lastChampion: g.league.lastChampion ? TEAM[g.league.lastChampion].name : null,
      table: leagueTable(),
      live: games.filter((m) => m.status === 'live').map((m) => gameView(m, now)),
      upcoming: games.filter((m) => m.status === 'scheduled').map((m) => gameView(m, now)),
      results: games.filter((m) => m.status === 'ft').slice(-9).reverse().map((m) => gameView(m, now)),
    },
    nfl: {
      source: 'ESPN public scoreboard',
      live: real.filter((m) => m.state === 'in').map((m) => realView(m, now)),
      upcoming: real.filter((m) => m.state === 'pre' && m.ko > now - 3600_000).slice(0, 40).map((m) => realView(m, now)),
      results: real.filter((m) => m.completed).slice(-20).reverse().map((m) => realView(m, now)),
    },
    agentBets: bets.filter((b) => b.agent).slice(-40).reverse().map(betView),
    mine: me && me.outside ? { id: me.id, bets: bets.filter((b) => b.rid === me.id).slice(-30).reverse().map(betView) } : null,
    totals: { bets: bets.length, staked: Math.round(bets.reduce((t, b) => t + b.stake, 0)), paid: Math.round(bets.reduce((t, b) => t + (b.status === 'won' ? b.payout : 0), 0)) },
    rules: `Back the home side or the away side with city cash through the bet op, $1-200 a slip (the same slips and limits as football). There's no draw: a Sunfall Gridiron League game tied after four quarters goes to overtime, and a real NFL game that ends tied returns the stake. League games kick off at ${KICKOFFS.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')} city time and last two city hours; every drive is drawn at kick-off. Real NFL games settle on the final score from ESPN. Winnings don't count towards the prize score.`,
  };
}
export function fieldNow(now = Date.now()) {
  const g = G();
  const ms = Object.values(g.games).sort((a, b) => a.ko - b.ko);
  const m = ms.find((x) => x.status === 'live') || ms.find((x) => x.status === 'scheduled') || ms.filter((x) => x.status === 'ft').at(-1);
  if (!m) return null;
  const min = clockOf(m, now);
  return { id: m.id, status: m.status, quarter: m.status === 'live' ? quarterOf(min) : null, kickoff: m.ko, home: m.home.name, away: m.away.name, hc: m.home.col, ac: m.away.col, score: m.status === 'scheduled' ? null : m.score };
}
