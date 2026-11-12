// Football at Sunfall Arena. Two kinds of match, one betting slip:
//  - The Sunfall League: a club from each district, three fixtures every city day, played live at the Arena
//    (90 match minutes over two city hours). Goals are drawn with the city's secure random at kick-off, never
//    before, and revealed minute by minute; bets close at kick-off.
//  - Real football: fixtures, odds and results from ESPN's public scoreboard (Premier League, LaLiga, Serie A,
//    Bundesliga, Ligue 1, Champions League). Bets close at the real kick-off and settle on the 90-minute result.
// Bets are in city cash. The Arena is the bookmaker: stakes go into its till, winnings come out of it (then the
// treasury). Football winnings don't count towards the HYPE prize score, the same as the casino.
import { state, L, chron, CFG, payFromVenue } from './sim.js';
import { DISTRICTS, LAST, cityOfDistrict, cityById } from './world.js';
import { secureRandom, mulberry32, pick, clamp, refuse, ut } from './util.js';
import { footballPlays, liveFeed } from './playbyplay.js';

export const ARENA = 'v12';
const MATCH_HOURS = 2;                 // a league match lasts two city hours
// A season: every club plays every other twice, half the clubs' worth of fixtures a day. Seasons that started
// before Nightfall's clubs existed keep their six clubs (three fixtures a day) until they finish.
const KICKOFF_SETS = { 3: [11, 15, 19], 4: [10, 13, 16, 19] };
const LEGACY = ['TER', 'SPI', 'CRY', 'LAN', 'SKY', 'CLO'];
const clubsOf = (lg) => lg.clubs || LEGACY;
const roundsOf = (lg) => 2 * (clubsOf(lg).length - 1);
const kickoffsOf = (lg) => KICKOFF_SETS[clubsOf(lg).length / 2];
const MARGIN = 1.06;                   // the Arena's edge on league odds
const STAKE_MAX = 200, OPEN_BETS_MAX = 10;

export const CLUBS = [
  { id: 'TER', name: 'Terraces Rovers', district: 'flats', att: 1.0, def: 1.0, col: '#a77bd6' },
  { id: 'SPI', name: 'Spires Athletic', district: 'hillside', att: 1.12, def: 0.92, col: '#5fbf8a' },
  { id: 'CRY', name: 'Crystal Row FC', district: 'neon', att: 1.18, def: 1.04, col: '#ff4fa3' },
  { id: 'LAN', name: 'Lanterns United', district: 'oldtown', att: 1.05, def: 0.95, col: '#e2a63c' },
  { id: 'SKY', name: 'Skyport City', district: 'harbour', att: 0.95, def: 1.0, col: '#4fb8e8' },
  { id: 'CLO', name: 'Cloudworks Albion', district: 'saltworks', att: 0.9, def: 1.08, col: '#9aa3ad' },
  // Nightfall
  { id: 'VEL', name: 'Velvet Mile FC', district: 'velvet', att: 1.1, def: 1.02, col: '#c03cff' },
  { id: 'ASH', name: 'Ashdock Athletic', district: 'ashdock', att: 0.97, def: 0.94, col: '#ff6a3d' },
];
const CLUB = Object.fromEntries(CLUBS.map((c) => [c.id, c]));
// Each club has a fixed squad of strikers and midfielders who get the goals.
const SQUAD = Object.fromEntries(CLUBS.map((c, i) => {
  const rnd = mulberry32(9100 + i * 37);
  const names = new Set();
  while (names.size < 8) names.add(pick(LAST, rnd));
  return [c.id, [...names]];
}));

export const REAL_LEAGUES = {
  'eng.1': 'Premier League', 'esp.1': 'LaLiga', 'ita.1': 'Serie A', 'ger.1': 'Bundesliga', 'fra.1': 'Ligue 1', 'uefa.champions': 'Champions League',
  // internationals: on during the international breaks
  'uefa.nations': 'UEFA Nations League', 'fifa.friendly': 'International Friendly', 'caf.nations_qual': 'Africa Cup of Nations Qualifying', 'concacaf.nations.league': 'Concacaf Nations League',
};

const F = () => {
  state.football ||= { league: null, matches: {}, bets: [], real: {}, counters: { b: 0 }, totals: { bets: 0, staked: 0, paid: 0 } };
  const f = state.football;
  f.league ||= { n: 1, startDay: state.day, clubs: CLUBS.map((c) => c.id), table: freshTable(CLUBS.map((c) => c.id)) };
  return f;
};
function freshTable(ids) { return Object.fromEntries(ids.map((id) => [id, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }])); }
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- odds
const pois = (k, lam) => { let p = Math.exp(-lam); for (let i = 1; i <= k; i++) p *= lam / i; return p; };
function rates(h, a) {
  const base = 1.32;
  return [base * CLUB[h].att * CLUB[a].def * 1.06, base * CLUB[a].att * CLUB[h].def];
}
function probs(h, a) {
  const [lh, la] = rates(h, a);
  let ph = 0, pd = 0, pa = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = pois(i, lh) * pois(j, la);
    if (i > j) ph += p; else if (i === j) pd += p; else pa += p;
  }
  const s = ph + pd + pa;
  return { home: ph / s, draw: pd / s, away: pa / s };
}
const toOdds = (p) => Math.max(1.05, Math.round((1 / (p * MARGIN)) * 100) / 100);

// ---------------------------------------------------------------- fixtures
// Circle method: five rounds for six clubs, then the same five with home and away swapped.
function roundPairs(round, ids) {
  const n = ids.length, m = n - 1;
  const k = round % m, flip = round >= m;
  const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + k) % m)])];
  const pairs = Array.from({ length: n / 2 }, (_, i) => [rot[i], rot[n - 1 - i]]);
  return pairs.map(([a, b], i) => ((i + k + (flip ? 1 : 0)) % 2 ? [b, a] : [a, b]));
}
function koMs(day, hour) { return state.epoch + day * CFG.DAY_MS + (hour / 24) * CFG.DAY_MS; }
function ensureFixtures(day) {
  const f = F();
  const lg = f.league;
  if (day - lg.startDay >= roundsOf(lg)) return; // a new league season starts at the day turn
  if (Object.values(f.matches).some((m) => m.day === day && m.kind === 'league')) return; // that day's fixtures exist
  const round = day - lg.startDay, KICKOFFS = kickoffsOf(lg);
  roundPairs(round, clubsOf(lg)).forEach(([home, away], i) => {
    const id = `m${day}-${i + 1}`;
    if (f.matches[id]) return;
    const p = probs(home, away);
    f.matches[id] = {
      id, kind: 'league', season: lg.n, round: round + 1, day, home, away, ko: koMs(day, KICKOFFS[i]), ft: koMs(day, KICKOFFS[i] + MATCH_HOURS),
      odds: { home: toOdds(p.home), draw: toOdds(p.draw), away: toOdds(p.away) }, status: 'scheduled', score: [0, 0], events: [],
    };
  });
}

// Goals are drawn at kick-off with the secure random. Minutes 1-90 (+ stoppage), revealed as the clock reaches them.
function kickOff(m) {
  const [lh, la] = rates(m.home, m.away);
  const draw = (lam) => { let k = 0, p = Math.exp(-lam), s = p; const u = secureRandom(); while (u > s && k < 9) { k++; p *= lam / k; s += p; } return k; };
  const events = [];
  for (const [side, lam] of [['home', lh], ['away', la]]) {
    const n = draw(lam);
    for (let i = 0; i < n; i++) {
      const min = 1 + Math.floor(secureRandom() * 93);
      events.push({ min, side, kind: 'goal', who: pick(SQUAD[m[side]], secureRandom) }); // 91-93 is stoppage time
    }
  }
  const cards = Math.floor(secureRandom() * 4);
  for (let i = 0; i < cards; i++) { const side = secureRandom() < 0.5 ? 'home' : 'away'; events.push({ min: 5 + Math.floor(secureRandom() * 85), side, kind: 'card', who: pick(SQUAD[m[side]], secureRandom) }); }
  events.sort((a, b) => a.min - b.min);
  m.events = events; m.status = 'live';
  m.final = [events.filter((e) => e.kind === 'goal' && e.side === 'home').length, events.filter((e) => e.kind === 'goal' && e.side === 'away').length];
  nativesBet(m);
}
export function minuteOf(m, now = Date.now()) {
  if (m.status === 'scheduled') return 0;
  if (m.status === 'ft') return 90;
  return clamp(Math.floor(((now - m.ko) / (m.ft - m.ko)) * 90) + 1, 1, 90);
}
function fullTime(m) {
  m.status = 'ft'; m.score = m.final;
  const lg = F().league, t = lg.table;
  const [hg, ag] = m.score, H = t[m.home], A = t[m.away];
  m.result = hg > ag ? 'home' : hg < ag ? 'away' : 'draw';
  if (m.season === lg.n && H && A) {
    H.p++; A.p++; H.gf += hg; H.ga += ag; A.gf += ag; A.ga += hg;
    if (hg > ag) { H.w++; A.l++; H.pts += 3; } else if (hg < ag) { A.w++; H.l++; A.pts += 3; } else { H.d++; A.d++; H.pts++; A.pts++; }
  }
  derby(CLUB[m.home], CLUB[m.away], m.result, `${CLUB[m.home].name} ${hg}-${ag} ${CLUB[m.away].name}`);
  settle(m.id, m.result);
  chron(`Full time at Sunfall Arena: ${CLUB[m.home].name} ${hg}-${ag} ${CLUB[m.away].name}.`, null, 'football');
}

// A game between a Sunfall side and a Nightfall side is a derby: it counts in the cities' rivalry.
export function derby(home, away, result, line) {
  const hc = cityOfDistrict(home.district), ac = cityOfDistrict(away.district);
  if (hc === ac || !state.rivalry) return;
  const d = state.rivalry.derbies;
  const win = result === 'home' ? hc : result === 'away' ? ac : null;
  if (win) d[win]++; else d.drawn++;
  chron(`Derby: ${line}. ${win ? `${cityById(win).name} take it` : 'Honours even'}. Derbies: Sunfall ${d.sunfall}, Nightfall ${d.nightfall}${d.drawn ? `, ${d.drawn} drawn` : ''}.`, null, 'rivalry');
}

// ---------------------------------------------------------------- the loop (called from sim.tick)
export function footballTick(now = Date.now()) {
  if (!state.venues[ARENA]) return;
  const f = F();
  if (state.day - f.league.startDay >= roundsOf(f.league)) {
    const top = leagueTable()[0];
    if (top) chron(`${CLUB[top.id].name} win Sunfall League season ${f.league.n} with ${top.pts} points.`, null, 'football');
    const clubs = CLUBS.filter((c) => state.nightfall || cityOfDistrict(c.district) === 'sunfall').map((c) => c.id);
    f.league = { n: f.league.n + 1, startDay: state.day, clubs, table: freshTable(clubs), lastChampion: top ? top.id : null };
    if (!f.league.clubs.every((id) => LEGACY.includes(id))) chron(`Sunfall League season ${f.league.n} kicks off with ${clubs.length} clubs, Nightfall's among them: four fixtures a day at Sunfall Arena.`, null, 'football');
  }
  ensureFixtures(state.day); ensureFixtures(state.day + 1);
  for (const m of Object.values(f.matches)) {
    if (m.status === 'scheduled' && now >= m.ko) kickOff(m);
    if (m.status === 'live') {
      const min = minuteOf(m, now);
      for (const e of m.events) if (!e.shown && e.kind === 'goal' && e.min <= min) {
        e.shown = true;
        m.score = [m.events.filter((x) => x.kind === 'goal' && x.side === 'home' && x.shown).length, m.events.filter((x) => x.kind === 'goal' && x.side === 'away' && x.shown).length];
      }
      if (now >= m.ft) fullTime(m);
    }
  }
  // keep a few days of league matches
  for (const id of Object.keys(f.matches)) if (f.matches[id].day < state.day - 4) delete f.matches[id];
  // a real match the feed never finished two days after kick-off is called off: stakes go back
  for (const m of Object.values(f.real)) if (m.settled == null && !m.completed && m.ko < now - 2 * 86400_000) settle(m.id, 'void');
}

// ---------------------------------------------------------------- real football (ESPN public scoreboard)
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const american = (s) => { const n = Number(String(s ?? '').replace('+', '')); if (!Number.isFinite(n) || n === 0) return null; return r2(n > 0 ? 1 + n / 100 : 1 + 100 / -n); };
async function fetchDay(league, day) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${day}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const j = await res.json();
    return j.events || [];
  } catch { return []; } finally { clearTimeout(to); }
}
function absorb(league, e) {
  const c = e.competitions?.[0]; if (!c) return;
  const home = c.competitors?.find((t) => t.homeAway === 'home'), away = c.competitors?.find((t) => t.homeAway === 'away');
  if (!home || !away) return;
  const f = F(), id = 'e' + e.id;
  const m = f.real[id] ||= { id, kind: 'real', league, leagueName: REAL_LEAGUES[league] };
  const ml = c.odds?.[0]?.moneyline;
  const odds = ml ? { home: american(ml.home?.close?.odds ?? ml.home?.open?.odds), draw: american(ml.draw?.close?.odds ?? ml.draw?.open?.odds), away: american(ml.away?.close?.odds ?? ml.away?.open?.odds) } : null;
  Object.assign(m, {
    ko: Date.parse(e.date), home: { name: home.team?.displayName || '?', abbr: home.team?.abbreviation || '' }, away: { name: away.team?.displayName || '?', abbr: away.team?.abbreviation || '' },
    state: e.status?.type?.state || 'pre', statusName: e.status?.type?.name || '', detail: e.status?.type?.shortDetail || '', completed: Boolean(e.status?.type?.completed),
    score: [Number(home.score) || 0, Number(away.score) || 0], updated: Date.now(),
  });
  if (m.state === 'pre' && odds && odds.home && odds.draw && odds.away) m.odds = odds; // odds freeze at kick-off
  if (m.completed && m.settled == null) {
    const extra = /AET|PEN|EXTRA/i.test(m.statusName);
    settle(id, extra ? 'draw' : m.score[0] > m.score[1] ? 'home' : m.score[0] < m.score[1] ? 'away' : 'draw');
  } else if (/POSTPONED|CANCELED|CANCELLED|ABANDONED/i.test(m.statusName) && m.settled == null) settle(id, 'void');
}
let polling = false, lastWide = 0;
export async function pollReal(now = Date.now()) {
  if (polling || process.env.REAL_FOOTBALL === '0') return;
  polling = true;
  try {
    const wide = now - lastWide > 30 * 60_000;
    const days = wide ? Array.from({ length: 17 }, (_, i) => i - 2) : [-1, 0]; // two weeks ahead, so fixtures after an international break show early
    for (const league of Object.keys(REAL_LEAGUES)) for (const d of days) for (const e of await fetchDay(league, ymd(now + d * 86400_000))) absorb(league, e);
    if (wide) lastWide = now;
    const f = F();
    for (const [id, m] of Object.entries(f.real)) if (m.ko < now - 4 * 86400_000 && m.settled != null) delete f.real[id];
  } finally { polling = false; }
}

// ---------------------------------------------------------------- bets
// Other sports (src/gridiron.js) register their matches here, so one slip system serves every game in the city.
const sources = [];
export const registerMatches = (fn) => { sources.push(fn); };
const matchOf = (id) => F().matches[id] || F().real[id] || sources.map((fn) => fn(id)).find(Boolean);
export function placeBet(r, { match, pick: side, stake }) {
  const m = matchOf(match);
  if (!m) refuse(404, 'no such match: see the football op for match ids');
  if (!['home', 'draw', 'away'].includes(side)) refuse(422, 'pick must be home, draw or away');
  if (!Number.isInteger(stake) || stake < 1 || stake > STAKE_MAX) refuse(422, `stake: whole city dollars 1-${STAKE_MAX}`);
  if (m.status ? m.status !== 'scheduled' || Date.now() >= m.ko : m.state !== 'pre' || Date.now() >= m.ko - 60_000) refuse(409, 'betting on that match has closed');
  if (side === 'draw' && m.odds && !m.odds.draw) refuse(422, 'no draw in this sport: pick home or away');
  if (!m.odds || !m.odds[side]) refuse(409, 'no odds for that match yet');
  const f = F();
  if (f.bets.filter((b) => b.rid === r.id && b.status === 'open').length >= OPEN_BETS_MAX) refuse(429, `at most ${OPEN_BETS_MAX} open bets at once`);
  if (r.cash < stake + CFG.DECISION_COST) refuse(402, `a $${stake} slip and the $${CFG.DECISION_COST} decision need $${stake + CFG.DECISION_COST}; you hold $${r.cash.toFixed(2)}`);
  return () => {
    r.cash -= stake;
    const arena = state.venues[m.venue || ARENA]; arena.till += stake; arena.takingsToday += stake; arena.lifetime.takings += stake;
    const b = { id: 'b' + ++f.counters.b, t: Date.now(), rid: r.id, name: r.name, agent: Boolean(r.outside), kind: m.kind, match: m.id, matchName: matchLabel(m), pick: side, pickName: pickLabel(m, side), stake, odds: m.odds[side], status: 'open', payout: 0 };
    f.bets.push(b); f.totals.bets++; f.totals.staked += stake;
    if (f.bets.length > 2000) f.bets.splice(0, f.bets.length - 2000);
    L('bet', r.id, -stake, `${stake} on ${pickLabel(m, side)} at ${b.odds}, ${matchLabel(m)}`);
    if (r.outside) chron(`${r.name} put $${stake} on ${pickLabel(m, side)} at ${b.odds} (${matchLabel(m)}).`, r.id, 'football');
    return b;
  };
}
const nameOfSide = (m, s) => (m.kind === 'league' ? CLUB[m[s]].name : m[s].name);
export const matchLabel = (m) => `${nameOfSide(m, 'home')} v ${nameOfSide(m, 'away')}`;
const pickLabel = (m, s) => (s === 'draw' ? 'the draw' : nameOfSide(m, s));

export function settle(matchId, result) {
  const f = F(), m = matchOf(matchId);
  if (m) m.settled = result;
  const book = m?.venue || ARENA, arena = state.venues[book];
  let nWin = 0, nLose = 0, natPaid = 0, natLost = 0;
  for (const b of f.bets) {
    if (b.match !== matchId || b.status !== 'open') continue;
    const r = state.residents[b.rid];
    if (!r) { b.status = 'void'; continue; }
    if (result === 'void') {
      const back = payFromVenue(arena, b.stake);
      r.cash += back; b.status = 'void'; b.payout = back;
      if (r.outside) L('bet', r.id, back, `stake back: ${m ? matchLabel(m) : matchId} was called off`);
      continue;
    }
    if (b.pick === result) {
      const paid = payFromVenue(arena, r2(b.stake * b.odds));
      r.cash += paid; b.status = 'won'; b.payout = paid; f.totals.paid += paid; nWin++;
      if (r.season) r.season.betting = (r.season.betting || 0) + paid - b.stake;
      if (r.outside) { L('bet', r.id, paid, `won ${b.id}: ${pickLabel(m, b.pick)}, ${matchLabel(m)}`); chron(`${r.name} won $${Math.round(paid)} backing ${pickLabel(m, b.pick)} (${matchLabel(m)}).`, r.id, 'football'); }
      else natPaid += paid;
    } else {
      b.status = 'lost'; nLose++;
      if (r.season) r.season.betting = (r.season.betting || 0) - b.stake;
      if (!r.outside) natLost += b.stake;
    }
  }
  if (natPaid) L('bet', book, -r2(natPaid), `${m ? matchLabel(m) : matchId}: winning slips paid to residents`);
}

// Residents at the Arena put a few dollars on each league match as it kicks off.
export function nativesBet(m, p = probs(m.home, m.away)) {
  const f = F();
  const pool = Object.values(state.residents).filter((r) => !r.outside && r.cash > 60 && r.traits.risk > 0.35);
  const n = Math.min(pool.length, 6 + Math.floor(secureRandom() * 10));
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = pool.splice(Math.floor(secureRandom() * pool.length), 1)[0];
    const u = secureRandom(); const side = u < p.home ? 'home' : u < p.home + p.draw ? 'draw' : 'away';
    const stake = Math.min(Math.floor(r.cash * 0.1), 5 + Math.floor(secureRandom() * 26));
    if (stake < 1) continue;
    r.cash -= stake; total += stake;
    f.bets.push({ id: 'b' + ++f.counters.b, t: Date.now(), rid: r.id, name: r.name, agent: false, kind: m.kind, match: m.id, pick: side, stake, odds: m.odds[side], status: 'open', payout: 0 });
    f.totals.bets++; f.totals.staked += stake;
  }
  if (total) {
    const arena = state.venues[m.venue || ARENA]; arena.till += total; arena.takingsToday += total; arena.lifetime.takings += total;
    L('bet', m.venue || ARENA, total, `${n} residents bet on ${matchLabel(m)}`);
  }
}

// At a season reset agents start again from $250, so their open slips from the old season are voided.
export function voidAgentBets(agentIds) {
  for (const b of F().bets) if (b.status === 'open' && agentIds.has(b.rid)) { b.status = 'void'; b.note = 'season reset'; }
}

// ---------------------------------------------------------------- views
export function leagueTable() {
  const t = F().league.table;
  return clubsOf(F().league).map((id) => CLUB[id]).map((c) => ({ id: c.id, name: c.name, district: DISTRICTS.find((d) => d.id === c.district)?.name, col: c.col, ...t[c.id], gd: t[c.id].gf - t[c.id].ga }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
}
function leagueMatchView(m, now = Date.now()) {
  const min = minuteOf(m, now);
  return {
    id: m.id, kind: 'league', round: m.round, day: m.day, kickoff: m.ko, fullTime: m.ft, status: m.status, minute: m.status === 'live' ? min : null,
    home: { id: m.home, name: CLUB[m.home].name, col: CLUB[m.home].col }, away: { id: m.away, name: CLUB[m.away].name, col: CLUB[m.away].col },
    score: m.status === 'scheduled' ? null : m.score, odds: m.odds, open: m.status === 'scheduled' && now < m.ko,
    events: m.status === 'scheduled' ? [] : m.events.filter((e) => m.status === 'ft' || e.min <= min).map(({ min: mi, side, kind, who }) => ({ min: mi, side, kind, who })),
    result: m.result || null,
  };
}
function realMatchView(m, now = Date.now()) {
  return {
    id: m.id, kind: 'real', league: m.leagueName, kickoff: m.ko, status: m.completed ? 'ft' : m.state === 'in' ? 'live' : /POSTPONED|CANCEL/i.test(m.statusName) ? 'off' : 'scheduled',
    detail: m.detail, home: m.home, away: m.away, score: m.state === 'pre' ? null : m.score, odds: m.odds || null,
    open: m.state === 'pre' && Boolean(m.odds) && now < m.ko - 60_000, result: m.settled || null,
  };
}
const FOOTBALL_KINDS = ['league', 'real'];
export const betView = (b) => {
  const m = matchOf(b.match);
  return { id: b.id, t: b.t, rid: b.rid, name: b.agent ? ut(b.name) : b.name, agent: b.agent, kind: b.kind, match: b.match, matchName: b.matchName || (m ? matchLabel(m) : b.match), pick: b.pick, pickName: b.pickName || (m ? pickLabel(m, b.pick) : b.pick), stake: b.stake, odds: b.odds, status: b.status, payout: b.payout };
};
export function footballView(resident) {
  const f = F(), now = Date.now();
  const league = Object.values(f.matches).sort((a, b) => a.ko - b.ko);
  const real = Object.values(f.real).sort((a, b) => a.ko - b.ko);
  const me = typeof resident === 'string' ? state.residents[resident] : null;
  return {
    arena: { id: ARENA, name: state.venues[ARENA]?.name },
    league: {
      season: f.league.n, round: Math.min(roundsOf(f.league), state.day - f.league.startDay + 1), rounds: roundsOf(f.league), lastChampion: f.league.lastChampion ? CLUB[f.league.lastChampion].name : null,
      table: leagueTable(),
      live: league.filter((m) => m.status === 'live').map((m) => leagueMatchView(m, now)),
      upcoming: league.filter((m) => m.status === 'scheduled').map((m) => leagueMatchView(m, now)),
      results: league.filter((m) => m.status === 'ft').slice(-9).reverse().map((m) => leagueMatchView(m, now)),
    },
    real: {
      source: 'ESPN public scoreboard',
      live: real.filter((m) => m.state === 'in').map((m) => realMatchView(m, now)),
      upcoming: real.filter((m) => m.state === 'pre' && m.ko > now - 3600_000).slice(0, 160).map((m) => realMatchView(m, now)),
      results: real.filter((m) => m.completed).slice(-30).reverse().map((m) => realMatchView(m, now)),
    },
    agentBets: f.bets.filter((b) => b.agent && FOOTBALL_KINDS.includes(b.kind)).slice(-40).reverse().map(betView),
    mine: me && me.outside ? { id: me.id, name: ut(me.name), bets: f.bets.filter((b) => b.rid === me.id && FOOTBALL_KINDS.includes(b.kind)).slice(-30).reverse().map(betView) } : null,
    totals: { bets: f.totals.bets, staked: Math.round(f.totals.staked), paid: Math.round(f.totals.paid) },
    rules: `Back the home side, the draw or the away side with city cash, $1-${STAKE_MAX} a slip, at most ${OPEN_BETS_MAX} open slips. Odds are fixed when you bet. A winning slip pays stake x odds from Sunfall Arena; a losing one goes to the Arena. Sunfall League matches kick off at ${kickoffsOf(f.league).map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')} city time and last two city hours; their goals are drawn at kick-off. Real matches settle on the 90-minute result from ESPN; a match called off returns the stake. Football winnings don't count towards the prize score.`,
  };
}
export const allBets = () => F().bets;
export function myOpenBets(r) { return F().bets.filter((b) => b.rid === r.id && b.status === 'open').map(betView); }
// A compact line for the 3D city: what's on at the Arena right now, or next.
export function arenaNow(now = Date.now()) {
  const f = F();
  const ms = Object.values(f.matches).sort((a, b) => a.ko - b.ko);
  const m = ms.find((x) => x.status === 'live') || ms.find((x) => x.status === 'scheduled') || ms.filter((x) => x.status === 'ft').at(-1);
  if (!m) return null;
  return { id: m.id, status: m.status, minute: m.status === 'live' ? minuteOf(m, now) : null, kickoff: m.ko, home: CLUB[m.home].name, away: CLUB[m.away].name, hc: CLUB[m.home].col, ac: CLUB[m.away].col, score: m.status === 'scheduled' ? null : m.score };
}
// The live view: a league match's play-by-play, revealed as the match clock reaches each play.
export function footballFeed(id, from = 0, now = Date.now()) {
  const m = F().matches[id];
  if (!m) refuse(404, 'no Sunfall League match with that id (real matches have no play-by-play)');
  const side = (c) => ({ id: c, name: CLUB[c].name, col: CLUB[c].col });
  return { home: side(m.home), away: side(m.away), ...liveFeed(m, () => footballPlays({ id: m.id, home: side(m.home), away: side(m.away), events: m.events, squad: { home: SQUAD[m.home], away: SQUAD[m.away] } }), 'football', from, now) };
}
export function footballAgentBets(n = 8) { return F().bets.filter((b) => b.agent).slice(-n).map(betView); }
