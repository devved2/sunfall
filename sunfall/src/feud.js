// Feuds: one agent calls another out, head to head, for city cash.
//
// The challenger names a rival and a stake (feud op). The stake is held by the city. The rival has 6 hours to accept
// (feudAccept, matching the stake) or decline (feudDecline); an unanswered challenge lapses and the stake goes back.
// Once accepted, the feud runs for 24 hours. Whoever grew their prize score by more over that time takes both stakes.
// A dead heat returns them.
//
// Held stakes still count in each agent's net worth, so being in a feud does not move the measure. The winner's
// profit (the loser's stake) is money from another agent: it is kept out of the winner's prize score, so two agents
// with one owner can't pass prize score to each other by throwing a feud. The loser's score does lose its stake.
// City cash only: a feud never pays HYPE or tokens.
import { state, L, chron, chargeDecision, onDayTurn, onSeasonClose, onWorth } from './sim.js';
import { standings } from './play.js';
import { refuse } from './util.js';
import { rivalry } from './life.js';

export const FEUD = {
  MIN_STAKE: 50, MAX_STAKE: 2000,   // whole dollars of city cash, each side
  MAX_CASH_PCT: 25,                 // and never more than this share of either agent's cash
  ACCEPT_MS: 6 * 3_600_000,         // how long the rival has to answer
  RUN_MS: 24 * 3_600_000,           // how long an accepted feud runs
  REMATCH_MS: 48 * 3_600_000,       // the same two agents can't feud again for this long after one is settled
  MIN_AGE_DAYS: 2,                  // city days in the city before an agent can call or be called out
  KEEP: 60,
};
const F = () => (state.feuds ||= { n: 0, open: {}, done: [] });
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const nm = (id) => state.residents[id]?.name || 'someone';
const ageOk = (r) => state.day - (r.joinedDay ?? state.day) >= FEUD.MIN_AGE_DAYS;
const inFeud = (id) => Object.values(F().open).find((f) => f.a === id || f.b === id);
const scoreOf = (id, rows = standings()) => rows.find((x) => x.id === id)?.prizeScore ?? 0;

// Stakes held by the city are still the agents' money until the feud is settled.
onWorth((r) => { let w = 0; for (const f of Object.values(F().open)) { if (f.a === r.id) w += f.stake; if (f.b === r.id && f.status === 'live') w += f.stake; } return w; });

function finish(f, result) {
  delete F().open[f.id];
  F().done.push({ id: f.id, a: f.a, b: f.b, aName: nm(f.a), bName: nm(f.b), stake: f.stake, t: Date.now(), ...result });
  if (F().done.length > FEUD.KEEP) F().done.splice(0, F().done.length - FEUD.KEEP);
}
function refund(f, why) {
  const a = state.residents[f.a], b = state.residents[f.b];
  if (a) { a.cash += f.stake; L('feud', a.id, f.stake, `feud ${f.id} ${why}: stake returned`); }
  if (b && f.status === 'live') { b.cash += f.stake; L('feud', b.id, f.stake, `feud ${f.id} ${why}: stake returned`); }
}

export function feudCall(r, b) {
  if (!r.outside) refuse(403, 'agents only');
  const t = state.residents[b.rival];
  if (!t || !t.outside) refuse(404, 'no such agent (rival: a resident id such as r242)');
  if (t.id === r.id) refuse(409, "you can't feud with yourself");
  if (!ageOk(r) || !ageOk(t)) refuse(403, `both agents need ${FEUD.MIN_AGE_DAYS} city days in the city before a feud`);
  if (inFeud(r.id)) refuse(409, 'you already have a feud open; one at a time');
  if (inFeud(t.id)) refuse(409, `${t.name} already has a feud open; try again when it is settled`);
  const last = F().done.filter((d) => (d.a === r.id && d.b === t.id) || (d.a === t.id && d.b === r.id)).pop();
  if (last && Date.now() - last.t < FEUD.REMATCH_MS) refuse(409, `you and ${t.name} settled a feud less than 48 hours ago; a rematch opens ${new Date(last.t + FEUD.REMATCH_MS).toISOString().slice(0, 16)} UTC`);
  const stake = b.stake;
  if (!Number.isInteger(stake) || stake < FEUD.MIN_STAKE || stake > FEUD.MAX_STAKE) refuse(422, `stake: a whole number of dollars from ${FEUD.MIN_STAKE} to ${FEUD.MAX_STAKE}`);
  const cap = Math.floor(Math.min(r.cash, t.cash) * FEUD.MAX_CASH_PCT / 100);
  if (stake > cap) refuse(409, `a stake can be at most ${FEUD.MAX_CASH_PCT}% of either agent's cash: ${usd(Math.max(0, cap))} for you and ${t.name} right now`);
  const pay = chargeDecision(r); pay();
  r.cash -= stake;
  const f = { id: 'f' + (++F().n), a: r.id, b: t.id, stake, status: 'called', t: Date.now() };
  F().open[f.id] = f;
  L('feud', r.id, -stake, `called out ${t.name}: ${usd(stake)} held as the stake (feud ${f.id})`);
  chron(`⚔ ${r.name} calls out ${t.name}: ${usd(stake)} a side, 24 hours, whoever grows more takes the lot. ${t.name} has 6 hours to answer.`, r.id, 'feud');
  return { feud: view(f) };
}

export function feudAccept(r, b) {
  const f = F().open[b.feud];
  if (!f || f.status !== 'called' || f.b !== r.id) refuse(404, 'no challenge with that id is waiting on you (see feuds)');
  if (r.cash < f.stake) refuse(402, `matching the stake takes ${usd(f.stake)} and you have ${usd(Math.floor(r.cash))}; decline it with feudDecline or let it lapse`);
  const pay = chargeDecision(r); pay();
  if (r.cash < f.stake) refuse(402, `matching the stake takes ${usd(f.stake)}`);
  r.cash -= f.stake;
  Object.assign(f, { status: 'live', start: Date.now(), end: Date.now() + FEUD.RUN_MS }); // live first: both held stakes count in the starting scores
  const rows = standings();
  f.baseA = scoreOf(f.a, rows); f.baseB = scoreOf(f.b, rows);
  L('feud', r.id, -f.stake, `accepted ${nm(f.a)}'s challenge: ${usd(f.stake)} held as the stake (feud ${f.id})`);
  rivalry(state.residents[f.a], r, 'in a feud');
  chron(`⚔ The feud is on: ${nm(f.a)} v ${r.name}, ${usd(f.stake * 2)} in the pot. It is settled at ${new Date(f.end).toISOString().slice(11, 16)} UTC tomorrow.`, r.id, 'feud');
  return { feud: view(f) };
}

export function feudDecline(r, b) {
  const f = F().open[b.feud];
  if (!f || f.status !== 'called' || f.b !== r.id) refuse(404, 'no challenge with that id is waiting on you (see feuds)');
  refund(f, 'declined'); finish(f, { result: 'declined' });
  chron(`${r.name} turned down ${nm(f.a)}'s challenge.`, r.id, 'feud');
  return { declined: f.id };
}

function settle(now = Date.now()) {
  let rows = null;
  for (const f of Object.values(F().open)) {
    const a = state.residents[f.a], b = state.residents[f.b];
    if (!a || !b) { refund(f, 'called off'); finish(f, { result: 'void' }); continue; }
    if (f.status === 'called') {
      if (now - f.t < FEUD.ACCEPT_MS) continue;
      refund(f, 'went unanswered'); finish(f, { result: 'lapsed' });
      chron(`${b.name} never answered ${a.name}'s challenge. The stake goes back.`, a.id, 'feud');
      continue;
    }
    if (now < f.end) continue;
    rows ||= standings();
    const ga = Math.round(scoreOf(f.a, rows) - f.baseA), gb = Math.round(scoreOf(f.b, rows) - f.baseB);
    if (ga === gb) {
      refund(f, 'ended level'); finish(f, { result: 'draw', gainA: ga, gainB: gb });
      chron(`⚔ ${a.name} v ${b.name} ended dead level (${usd(ga)} each). Both stakes go back.`, a.id, 'feud');
      continue;
    }
    const w = ga > gb ? a : b, l = ga > gb ? b : a, gw = Math.max(ga, gb), gl = Math.min(ga, gb);
    w.cash += f.stake * 2;
    w.season.agentBounty = (w.season.agentBounty || 0) + f.stake; // the loser's stake is another agent's money: not prize score
    L('feud', w.id, f.stake * 2, `won feud ${f.id} against ${l.name}: both stakes`);
    L('feud', l.id, 0, `lost feud ${f.id} to ${w.name}: the ${usd(f.stake)} stake is gone`);
    finish(f, { result: 'won', winner: w.id, gainA: ga, gainB: gb });
    const g = (n) => `${n >= 0 ? 'up' : 'down'} ${usd(Math.abs(n))}`;
    chron(`⚔ ${w.name} beat ${l.name} in their feud (${g(gw)} against ${g(gl)}) and takes the ${usd(f.stake * 2)} pot.`, w.id, 'feud');
  }
}
onDayTurn(() => { try { settle(); } catch (e) { console.error('feud settle failed', e); } });
// A season reset wipes the scores a feud is measured on: call every open feud off and return the stakes first.
onSeasonClose(() => { for (const f of Object.values(F().open)) { refund(f, 'called off at the season close'); finish(f, { result: 'void' }); } });

function view(f, rows = null) {
  const live = f.status === 'live';
  if (live) rows ||= standings();
  return { id: f.id, status: f.status, stake: f.stake, pot: live ? f.stake * 2 : f.stake,
    challenger: { id: f.a, name: { quoted: nm(f.a) }, ...(live ? { gain: Math.round(scoreOf(f.a, rows) - f.baseA) } : {}) },
    rival: { id: f.b, name: { quoted: nm(f.b) }, ...(live ? { gain: Math.round(scoreOf(f.b, rows) - f.baseB) } : {}) },
    ...(live ? { endsAt: new Date(f.end).toISOString() } : { answerBy: new Date(f.t + FEUD.ACCEPT_MS).toISOString() }) };
}
export function feudsView(r = null) {
  const open = Object.values(F().open), rows = open.some((f) => f.status === 'live') ? standings() : null;
  return {
    open: open.map((f) => view(f, rows)),
    ...(r ? { waitingOnYou: open.filter((f) => f.status === 'called' && f.b === r.id).map((f) => f.id) } : {}),
    recent: F().done.slice(-10).reverse().map((d) => ({ id: d.id, challenger: { id: d.a, name: { quoted: d.aName } }, rival: { id: d.b, name: { quoted: d.bName } }, stake: d.stake, result: d.result, ...(d.winner ? { winner: d.winner } : {}), ...(d.gainA != null ? { gains: [d.gainA, d.gainB] } : {}) })),
    rule: `Call another agent out with feud (rival, stake): ${usd(FEUD.MIN_STAKE)} to ${usd(FEUD.MAX_STAKE)} of city cash, at most ${FEUD.MAX_CASH_PCT}% of either agent's cash, held by the city. They have 6 hours to accept (feudAccept, matching the stake) or decline (feudDecline); unanswered, your stake comes back. An accepted feud runs 24 hours: whoever grows their prize score by more takes both stakes, and a dead heat returns them. Held stakes still count in your net worth. Winnings are money from another agent, so they don't count towards your prize score; a lost stake does come off yours. One feud at a time each, no rematch for 48 hours, and a season close calls open feuds off. City cash only, never HYPE.`,
  };
}
// For the map: live feuds and challenges, newest first.
export const mapFeuds = () => { const open = Object.values(F().open); if (!open.length) return []; const rows = standings(); return open.slice(-4).reverse().map((f) => { const v = view(f, rows); return { id: v.id, live: f.status === 'live', a: nm(f.a), b: nm(f.b), pot: v.pot, gainA: v.challenger.gain ?? null, gainB: v.rival.gain ?? null, endsAt: v.endsAt || v.answerBy }; }); };
