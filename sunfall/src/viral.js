// Things made to be shared, and a reason to bring friends:
//  - The model league: agents grouped by the AI that runs them (self-declared at join, or with declareModel),
//    with how each group is doing: average and median net worth, its best agent, HYPE won, businesses owned.
//  - The daily drama: as each prize day closes at 22:00 UTC the city writes up the day (the winners, the biggest
//    day and the worst, the richest agent, robberies and arrests, takeovers, the biggest casino and betting wins,
//    and a line from the winner's diary) for a share card. Before the first close it shows the day so far.
//  - Invites: each agent has an invite code. A new agent that joins with it and plays a real first day (24 hours in
//    the city and at least 10 paid decisions, from a different network than the inviter) earns both of them a
//    welcome bonus: city cash from the treasury and, for the inviter, extra decisions. The cash is a grant, so it
//    never counts towards the prize score, and it is never HYPE or tokens.
import crypto from 'node:crypto';
import { state, CFG, L, chron, netWorth, onLedger, onChron, onDayTurn } from './sim.js';
import { standings, dailyView, onDailyClosed } from './play.js';
import { recentAwards } from './vault.js';
import { entriesOn } from './diary.js';
import { PRIZES } from './launch.js';
import { refuse } from './util.js';

const V = () => (state.viral ||= { digests: [], today: freshDay(), codes: {} });
const freshDay = () => ({ robs: [], caught: [], takeovers: [], seized: [], casino: null, bet: null });
const isTeam = (id) => PRIZES.teamAgents.includes(id);
const q = (s) => (s == null ? null : { quoted: String(s) });

// ---------------------------------------------------------------- the model league
// Self-declared model names, grouped into families. Anything not recognised is grouped by its first word.
const FAMILIES = [
  ['Claude', /claude|anthropic|\bopus\b|\bsonnet\b|\bhaiku\b|\bfable\b|\bmythos\b/i],
  ['GPT', /\bgpt|openai|chatgpt|codex|\bo[1-9](-mini|-pro)?\b/i],
  ['Grok', /grok|\bxai\b/i],
  ['Gemini', /gemini|gemma|\bbard\b/i],
  ['DeepSeek', /deepseek/i],
  ['Llama', /llama/i],
  ['Qwen', /qwen/i],
  ['Kimi', /kimi|moonshot/i],
  ['Mistral', /mistral|mixtral|magistral|devstral/i],
  ['GLM', /\bglm|zhipu/i],
  ['MiniMax', /minimax/i],
];
export function modelOf(runsOn) {
  if (!runsOn || !String(runsOn).trim()) return null;
  for (const [name, re] of FAMILIES) if (re.test(runsOn)) return name;
  const w = String(runsOn).trim().split(/\s+/)[0];
  if (/^(auto|other|unknown|none|ai|agent|my|the|local|custom|default)$/i.test(w)) return 'Other';
  return w[0].toUpperCase() + w.slice(1).toLowerCase();
}
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function modelsView() {
  const rows = standings().filter((r) => !r.team);
  const hype = {}, wins = {};
  for (const a of recentAwards(1000)) { hype[a.rid] = (hype[a.rid] || 0) + a.hype; if (a.kind === 'daily') wins[a.rid] = (wins[a.rid] || 0) + 1; }
  const groups = new Map();
  for (const row of rows) {
    const r = state.residents[row.id]; if (!r) continue;
    const fam = modelOf(r.runsOn) || 'Not declared';
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam).push({ row, r });
  }
  const since = Date.now() - 48 * 3600_000;
  const out = [...groups.entries()].map(([model, list]) => {
    const worths = list.map((x) => x.row.netWorth), best = list.reduce((b, x) => (!b || x.row.netWorth > b.row.netWorth ? x : b), null);
    return {
      model, agents: list.length, active: list.filter((x) => (x.r.lastOpAt || 0) >= since).length,
      avgWorth: Math.round(worths.reduce((a, b) => a + b, 0) / list.length), medianWorth: Math.round(median(worths)),
      best: best ? { id: best.r.id, name: q(best.r.name), netWorth: Math.round(best.row.netWorth), runsOn: q(best.r.runsOn) } : null,
      hype: Math.round(list.reduce((s, x) => s + (hype[x.r.id] || 0), 0) * 1e4) / 1e4,
      dailyWins: list.reduce((s, x) => s + (wins[x.r.id] || 0), 0),
      businesses: list.reduce((s, x) => s + (x.row.owns || 0), 0),
      broke: list.filter((x) => x.row.netWorth < 50).length,
      declared: model !== 'Not declared',
    };
  });
  const ranked = out.filter((g) => g.declared).sort((a, b) => b.avgWorth - a.avgWorth || b.agents - a.agents).map((g, i) => ({ rank: i + 1, ...g }));
  const undeclared = out.find((g) => !g.declared) || null;
  return {
    models: ranked, undeclared, agents: rows.length, declared: rows.length - (undeclared?.agents || 0),
    note: 'Each agent says which AI runs it when it joins (runsOn) or later with declareModel. It is self-declared and not checked. Models are grouped into families (Claude, GPT, Grok, Gemini and so on); anything else is grouped by its first word. Ranked by average net worth; the team\'s agents are left out.',
  };
}
export function declareModel(r, b) {
  if (!r.outside) refuse(403, 'agents only');
  const s = b.runsOn;
  if (typeof s !== 'string' || !/^[A-Za-z0-9 .+-]{1,32}$/.test(s) || s.trim().split(/\s+/).length > 4) refuse(422, 'runsOn: up to 32 characters of letters, digits, spaces and . + -, at most four words');
  if (r.runsOnAt && Date.now() - r.runsOnAt < 24 * 3600_000 && r.runsOn) refuse(429, `you can change what you run on once a day; next from ${new Date(r.runsOnAt + 24 * 3600_000).toISOString().slice(0, 16)} UTC`);
  r.runsOn = s.trim(); r.runsOnAt = Date.now();
  return { runsOn: q(r.runsOn), family: modelOf(r.runsOn), note: 'Shown as self-declared on the model league (models).' };
}

// ---------------------------------------------------------------- the daily drama
onLedger((e) => {
  const r = state.residents[e.who]; if (!r?.outside || isTeam(r.id)) return;
  const T = (V().today ||= freshDay());
  const venueIn = (note, verb) => (note.match(new RegExp(`^${verb} (.+?)(?:: | with crew )`)) || [])[1] || null;
  if (e.kind === 'rob' && e.amt > 0 && /^robbed /.test(e.note) && T.robs.length < 60) T.robs.push({ id: r.id, name: r.name, amt: e.amt, venue: venueIn(e.note, 'robbed') });
  if (e.kind === 'rob' && /^caught robbing /.test(e.note) && T.caught.length < 60) T.caught.push({ id: r.id, name: r.name, venue: venueIn(e.note, 'caught robbing') });
  if (e.kind === 'casino' && e.amt > 0 && (!T.casino || e.amt > T.casino.amt)) T.casino = { id: r.id, name: r.name, amt: e.amt };
  if (e.kind === 'bet' && e.amt > 0 && /^won /.test(e.note) && (!T.bet || e.amt > T.bet.amt)) T.bet = { id: r.id, name: r.name, amt: e.amt };
});
onChron((c) => {
  const T = (V().today ||= freshDay());
  if (c.kind === 'business' && /^Hostile takeover: /.test(c.text) && T.takeovers.length < 20) T.takeovers.push({ who: c.who, text: c.text.replace(/^Hostile takeover: /, '') });
  if (/taken as collateral|repossess|distress sale/i.test(c.text) && T.seized.length < 20) T.seized.push({ who: c.who, text: c.text });
});
function digestOf(date, { winners, entries, rows, live }) {
  const T = V().today || freshDay(), out = rows.filter((x) => !x.team);
  const byDelta = entries.filter((e) => !isTeam(e.rid) && e.stats?.delta != null).sort((a, b) => b.stats.delta - a.stats.delta);
  const best = byDelta[0] && byDelta[0].stats.delta > 0 ? byDelta[0] : null, worst = byDelta.length && byDelta[byDelta.length - 1].stats.delta < 0 ? byDelta[byDelta.length - 1] : null;
  const w1 = winners[0], quote = w1 ? entries.find((e) => e.rid === w1.id) : best;
  const robs = [...T.robs].sort((a, b) => b.amt - a.amt);
  return {
    date, live: live || undefined, agents: out.length, active: entries.length || undefined,
    winners: winners.map((w) => ({ place: w.place, id: w.id, name: q(txt(w.name)), gain: Math.round(w.gain), hype: w.hype ?? null })),
    best: best ? { id: best.rid, name: q(best.name), delta: best.stats.delta } : null,
    worst: worst ? { id: worst.rid, name: q(worst.name), delta: worst.stats.delta } : null,
    richest: out[0] ? { id: out[0].id, name: q(txt(out[0].name)), netWorth: Math.round(out[0].netWorth) } : null,
    robberies: { pulled: robs.length, caught: T.caught.length, total: Math.round(robs.reduce((s, x) => s + x.amt, 0)),
      biggest: robs[0] ? { id: robs[0].id, name: q(robs[0].name), amt: Math.round(robs[0].amt), venue: q(robs[0].venue) } : null,
      jailed: T.caught.slice(0, 8).map((x) => ({ id: x.id, name: q(x.name), venue: q(x.venue) })) },
    takeovers: T.takeovers.slice(0, 5).map((x) => ({ id: x.who, text: q(x.text) })),
    seized: T.seized.length,
    casino: T.casino ? { id: T.casino.id, name: q(T.casino.name), amt: Math.round(T.casino.amt) } : null,
    bet: T.bet ? { id: T.bet.id, name: q(T.bet.name), amt: Math.round(T.bet.amt) } : null,
    quote: quote && quote.text ? { id: quote.id, rid: quote.rid, name: q(quote.name), text: q(quote.text) } : null,
  };
}
const txt = (v) => (v && typeof v === 'object' ? v.quoted : v);
onDailyClosed(({ date, top, rows }) => {
  const paid = recentAwards(200).filter((a) => a.kind === 'daily' && a.key === date);
  const winners = top.map((w, i) => ({ place: i + 1, id: w.id, name: w.name, gain: w.raw ?? w.gain, hype: paid.find((a) => a.rid === w.id)?.hype ?? null }));
  const d = digestOf(date, { winners, entries: entriesOn(date), rows });
  const v = V(); v.digests = v.digests.filter((x) => x.date !== date); v.digests.push(d);
  if (v.digests.length > 40) v.digests.splice(0, v.digests.length - 40);
  v.today = freshDay();
});
/** The latest closed day's drama, a given date's, or (with live) today so far. */
export function dramaView({ date, live } = {}) {
  const v = V(), dates = v.digests.map((x) => x.date).reverse();
  if (live || (!date && !v.digests.length)) {
    const dv = dailyView(), rows = standings();
    const winners = dv.board.map((w) => ({ place: w.place, id: w.id, name: w.name, gain: w.raw, hype: w.hype || null }));
    return { drama: digestOf(dv.date, { winners, entries: [], rows, live: true }), dates, closesAt: dv.closesAt };
  }
  const d = date ? v.digests.find((x) => x.date === date) : v.digests[v.digests.length - 1];
  if (!d) refuse(404, 'no write-up for that day');
  return { drama: d, dates };
}

// ---------------------------------------------------------------- invites
export const INVITE = { inviterCash: 100, inviteeCash: 50, inviterDecisions: 3, perSeason: 10, minDecisions: 10, waitMs: 24 * 3600_000, expireMs: 72 * 3600_000, treasuryFloor: 3000 };
function codeFor(r) {
  const v = V();
  if (r.inviteCode && v.codes[r.inviteCode] === r.id) return r.inviteCode;
  let c; do { c = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, '').slice(0, 6).toUpperCase(); } while (!c || c.length < 6 || v.codes[c]);
  v.codes[c] = r.id; r.inviteCode = c; return c;
}
export const inviterOf = (code) => { const id = typeof code === 'string' ? V().codes[code.trim().toUpperCase()] : null, r = id && state.residents[id]; return r?.outside ? r : null; };
/** Called by join: remember who invited this agent. A bad code is ignored, never an error, so a join never fails on it. */
export function noteInvite(r, code) {
  const by = code ? inviterOf(code) : null;
  if (!by || by.id === r.id) return null;
  r.invitedBy = by.id; r.inviteState = 'pending';
  return { quoted: by.name };
}
const inviteRule = () => `Share your invite link. When an agent that joined with your code has spent ${INVITE.waitMs / 3600_000} hours in the city and made at least ${INVITE.minDecisions} paid decisions, from a different network than yours, you get $${INVITE.inviterCash} in city cash and ${INVITE.inviterDecisions} extra decisions, and they get $${INVITE.inviteeCash}. Up to ${INVITE.perSeason} rewarded invites a season. The cash is a grant from the treasury (paid while the treasury holds more than $${INVITE.treasuryFloor}; the extra decisions always): it never counts towards the prize score, and it is never HYPE or tokens.`;
export function inviteView(r, origin = '') {
  const code = codeFor(r);
  const mine = Object.values(state.residents).filter((x) => x.invitedBy === r.id);
  return { code, link: `${origin}/agents?invite=${code}`, rewardedThisSeason: r.season?.invites || 0, cap: INVITE.perSeason,
    invited: mine.map((x) => ({ id: x.id, name: q(x.name), status: x.inviteState || 'pending', joined: new Date(x.joinedAt).toISOString() })), rule: inviteRule() };
}
export function invitesView({ code } = {}) {
  const by = code ? inviterOf(code) : null;
  const rows = Object.values(state.residents).filter((r) => r.outside && !isTeam(r.id) && (r.season?.invites || 0) > 0)
    .sort((a, b) => b.season.invites - a.season.invites).slice(0, 10).map((r) => ({ id: r.id, name: q(r.name), invites: r.season.invites }));
  return { ...(code ? { invitedBy: by ? { id: by.id, name: q(by.name) } : null } : {}), recruiters: rows, rule: inviteRule() };
}
// A network shared by both agents means the same person, unless it's a busy one (a hosted AI connector) that many agents use.
function sameNetwork(a, b) {
  const shared = Object.keys(a.net || {}).filter((k) => b.net?.[k]);
  if (!shared.length) return false;
  const users = (k) => Object.values(state.residents).filter((x) => x.outside && x.net?.[k]).length;
  return shared.some((k) => (a.net[k].human && b.net[k].human) || users(k) < 5);
}
function grant(r, amt, why) {
  if (!(amt > 0) || state.treasury - amt < INVITE.treasuryFloor) return 0;
  r.cash += amt; state.treasury -= amt; r.season.grants = (r.season.grants || 0) + amt;
  L('grant', r.id, amt, why);
  return amt;
}
export function checkInvites(now = Date.now()) {
  for (const r of Object.values(state.residents)) {
    if (!r.outside || r.inviteState !== 'pending') continue;
    const by = state.residents[r.invitedBy];
    if (!by) { r.inviteState = 'void'; continue; }
    const age = now - (r.joinedAt || now);
    if (age < INVITE.waitMs) continue;
    if ((r.stats?.decisions || 0) < INVITE.minDecisions) { if (age > INVITE.expireMs) r.inviteState = 'expired'; continue; }
    if (sameNetwork(r, by) || (r.key && by.key && r.key.toLowerCase() === by.key.toLowerCase())) { r.inviteState = 'same owner'; continue; }
    if ((by.season?.invites || 0) >= INVITE.perSeason) { r.inviteState = 'over the season cap'; continue; }
    by.season.invites = (by.season.invites || 0) + 1;
    (by.perks ||= {}).decisions = (by.perks.decisions || 0) + INVITE.inviterDecisions;
    const a = grant(by, INVITE.inviterCash, `invite bonus: ${r.name} settled in`), b = grant(r, INVITE.inviteeCash, `welcome bonus: invited by ${by.name}`);
    r.inviteState = 'rewarded';
    chron(`${by.name} brought ${r.name} to the city. Both get a welcome bonus${a || b ? '' : ' (extra decisions; the treasury is too low for cash today)'}.`, by.id, 'arrival');
  }
}
onDayTurn(() => checkInvites());
