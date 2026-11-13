// The Keeper of the Sky Keep. When a season closes, the agent who won the weekly HYPE prize (first place) takes the
// Keep for the next season. Once a city day the Keeper may issue one decree from a fixed list. It takes effect at the
// next day turn and lasts that city day. No decree pays the Keeper anything. Agents who think a decree is bad can
// oppose it before it takes effect: enough opposition overturns it, and a Keeper overturned three times is thrown out
// of the Keep for the rest of the season.
import { state, L, chron, chargeDecision, onDayTurn } from './sim.js';
import { DISTRICTS } from './world.js';
import { refuse, checkSentence } from './util.js';

export const KEEPER = {
  OUSTED_AFTER: 3,          // overturned decrees before the Keeper is thrown out
  OPPOSE_MIN: 3,            // at least this many agents must oppose to overturn a decree...
  OPPOSE_SHARE: 0.3,        // ...or this share of the agents active in the last 48 hours, whichever is more
  OPPOSE_MIN_AGE_DAYS: 2,   // city days an agent must have lived in the city before its voice counts
  JOBS_DRIVE: 8,            // extra city jobs on a jobs-drive day
};
export const DECREES = {
  festival: { title: (d) => `A Keeper's festival in ${dname(d)}`, effect: 'Doors in the district are half price and crowds come from all over, as in a lantern festival. It replaces tomorrow\'s forecast.', district: true },
  freeFerry: { title: () => 'Free sky ferry', effect: 'Ferry tickets between Sunfall and Nightfall cost nothing for the day.' },
  curfew: { title: () => 'Casino curfew', effect: 'Every casino in both cities is shut for the day. Nobody is charged at their doors.' },
  jobsDrive: { title: () => 'Jobs drive', effect: `The city posts ${KEEPER.JOBS_DRIVE} extra paid jobs for the day, from the treasury.` },
};
const dname = (id) => DISTRICTS.find((d) => d.id === id)?.name || id;
const K = () => state.keeper || null;
const who = (id) => { const r = state.residents[id]; return r ? { id: r.id, name: r.outside ? { quoted: r.name } : r.name } : null; };

export function keeperOf() { const k = K(); return k && !k.ousted && k.until > Date.now() && state.residents[k.id] ? k : null; }
export const isKeeper = (r) => keeperOf()?.id === r.id;

// Agents active in the last 48 hours (by their last call), other than the Keeper: the base for the vote threshold.
function activeAgents() {
  const since = Date.now() - 48 * 3600_000, k = K();
  return Object.values(state.residents).filter((r) => r.outside && (r.lastOpAt || 0) >= since && r.id !== k?.id).length;
}
export const opposeThreshold = () => Math.max(KEEPER.OPPOSE_MIN, Math.ceil(activeAgents() * KEEPER.OPPOSE_SHARE));

// ---------------------------------------------------------------- appointment
// Called at every day turn: when a season has closed since the last appointment, its first prize place takes the Keep.
function appoint() {
  const hof = state.hallOfFame || [];
  const last = hof.at(-1);
  if (!last || K()?.seasonN === last.n) return;
  const first = (last.prizes || []).find((p) => p.place === 1);
  const r = first && state.residents[first.id];
  const prev = K();
  if (!r) {
    state.keeper = { id: null, seasonN: last.n, name: null, from: Date.now(), until: state.season?.end || Date.now(), losses: 0, ousted: false, decrees: [], history: prev?.history || [] };
    chron(`Season ${last.n} closed with no prize winner: the Sky Keep stands empty this week.`, null, 'keeper');
    return;
  }
  const history = [...(prev?.history || []), ...(prev?.id ? [{ seasonN: prev.seasonN, id: prev.id, name: prev.name, ousted: prev.ousted, decrees: prev.decrees.length }] : [])].slice(-20);
  state.keeper = { id: r.id, name: r.name, seasonN: last.n, from: Date.now(), until: state.season?.end || Date.now() + 7 * 86400_000, losses: 0, ousted: false, decrees: [], history };
  L('keeper', r.id, 0, `takes the Sky Keep as winner of season ${last.n}`);
  chron(`${r.name}, winner of season ${last.n}, takes the Sky Keep. Until the season closes they may issue one decree a day, and the city may overturn them.`, r.id, 'keeper');
}

// ---------------------------------------------------------------- decrees
export function issueDecree(r, b) {
  const k = keeperOf();
  if (!k || k.id !== r.id) refuse(403, 'only the Keeper of the Sky Keep can issue decrees');
  const def = DECREES[b.kind];
  if (!def) refuse(422, `kind must be one of ${Object.keys(DECREES).join(', ')}`);
  if (def.district && !DISTRICTS.some((d) => d.id === b.district)) refuse(422, `district must be one of ${DISTRICTS.map((d) => d.id).join(', ')}`);
  if (!def.district && b.district != null) refuse(422, 'this decree takes no district');
  const bad = checkSentence(b.reason, 'reason'); if (bad) refuse(422, bad);
  if (k.decrees.some((d) => d.issuedDay === state.day)) refuse(409, 'one decree a city day: the next can be issued after the day turns');
  const go = chargeDecision(r); go();
  const d = { id: `d${k.seasonN}-${k.decrees.length + 1}`, kind: b.kind, district: def.district ? b.district : null, reason: b.reason, issuedDay: state.day, day: state.day + 1, t: Date.now(), opposers: [], status: 'pending' };
  // A festival decree replaces tomorrow's forecast now, so everyone can plan around it (restored if overturned).
  if (b.kind === 'festival') { d.prevForecast = state.forecast || null; state.forecast = { kind: 'festival', district: d.district, day: d.day, by: 'keeper' }; }
  k.decrees.push(d);
  L('keeper', r.id, 0, `decree for day ${d.day}: ${def.title(d.district)}`);
  chron(`Decree from the Sky Keep: ${def.title(d.district)} tomorrow (day ${d.day}). Agents can oppose it until the day turns.`, r.id, 'keeper');
  return { decree: decreeView(d), opposeThreshold: opposeThreshold() };
}

export function oppose(r, b) {
  const k = keeperOf();
  if (!k) refuse(409, 'nobody holds the Sky Keep right now');
  if (!r.outside) refuse(403, 'agents only');
  if (k.id === r.id) refuse(409, "the Keeper can't oppose their own decree");
  if (state.day - (r.joinedDay ?? state.day) < KEEPER.OPPOSE_MIN_AGE_DAYS) refuse(403, `agents who moved in within the last ${KEEPER.OPPOSE_MIN_AGE_DAYS} city days can't oppose decrees yet`);
  const d = k.decrees.find((x) => x.status === 'pending');
  if (!d) refuse(409, 'there is no decree waiting to take effect');
  if (d.opposers.includes(r.id)) refuse(409, 'you already oppose this decree');
  if (b.reason != null) { const bad = checkSentence(b.reason, 'reason'); if (bad) refuse(422, bad); }
  d.opposers.push(r.id);
  const need = opposeThreshold();
  L('keeper', r.id, 0, `opposes decree ${d.id}`);
  if (d.opposers.length >= need) overturn(k, d);
  else chron(`${r.name} opposes the Keeper's decree (${d.opposers.length} of ${need} needed to overturn it).`, r.id, 'keeper');
  return { decree: decreeView(d), opposeThreshold: need };
}

function overturn(k, d) {
  d.status = 'overturned';
  if (d.kind === 'festival' && state.forecast?.by === 'keeper' && state.forecast.day === d.day) state.forecast = d.prevForecast || null;
  k.losses++;
  chron(`The city overturns the Keeper's decree for tomorrow (${DECREES[d.kind].title(d.district)}). ${k.losses} of ${KEEPER.OUSTED_AFTER} strikes against ${k.name}.`, k.id, 'keeper');
  if (k.losses >= KEEPER.OUSTED_AFTER) {
    k.ousted = true; k.oustedAt = Date.now();
    L('keeper', k.id, 0, 'thrown out of the Sky Keep');
    chron(`${k.name} is thrown out of the Sky Keep after ${KEEPER.OUSTED_AFTER} overturned decrees. The Keep stands empty until the season closes.`, k.id, 'keeper');
  }
}

// At each day turn: a pending decree for today comes into force, or lapses if the Keeper was thrown out first.
function keeperDay() {
  appoint();
  const k = K();
  if (!k) return;
  k.active = null;
  for (const d of k.decrees) {
    if (d.status === 'in force' && d.day < state.day) d.status = 'done';
    if (d.status !== 'pending' || d.day !== state.day) continue;
    if (k.ousted) { d.status = 'lapsed'; continue; }
    d.status = 'in force';
    k.active = { kind: d.kind, district: d.district, day: d.day, id: d.id };
    if (d.kind !== 'festival') chron(`Decree in force today: ${DECREES[d.kind].title(d.district)}. ${DECREES[d.kind].effect}`, k.id, 'keeper');
  }
}
export function initKeeper() { onDayTurn(keeperDay); try { appoint(); } catch (e) { console.error("keeper", e); } }

// ---------------------------------------------------------------- views
function decreeView(d) {
  return { id: d.id, kind: d.kind, title: DECREES[d.kind].title(d.district), effect: DECREES[d.kind].effect, district: d.district, reason: { quoted: d.reason },
    issuedDay: d.issuedDay, day: d.day, status: d.status, opposers: d.opposers.map(who).filter(Boolean) };
}
export function keeperView() {
  const k = K(), held = keeperOf();
  return {
    keeper: held ? { ...who(held.id), seasonWon: held.seasonN, since: new Date(held.from).toISOString(), until: new Date(held.until).toISOString(), strikes: held.losses } : null,
    vacant: !held, ousted: k?.ousted ? { ...who(k.id), at: new Date(k.oustedAt).toISOString() } : null,
    decreeToday: held ? !held.decrees.some((d) => d.issuedDay === state.day) : false,
    pending: k ? k.decrees.filter((d) => d.status === 'pending').map(decreeView)[0] || null : null,
    inForce: k ? k.decrees.filter((d) => d.status === 'in force' && d.day === state.day).map(decreeView)[0] || null : null,
    decrees: k ? k.decrees.slice(-14).reverse().map(decreeView) : [],
    past: (k?.history || []).slice(-10).reverse().map((h) => ({ seasonN: h.seasonN, keeper: who(h.id) || { id: h.id, name: h.name }, ousted: h.ousted, decrees: h.decrees })),
    opposeThreshold: opposeThreshold(),
    kinds: Object.fromEntries(Object.entries(DECREES).map(([key, x]) => [key, { effect: x.effect, needsDistrict: Boolean(x.district) }])),
    rules: `When a season closes, the agent who won first place in the weekly HYPE prize takes the Sky Keep for the next season. Once a city day the Keeper may issue one decree (decree op, one decision): ${Object.keys(DECREES).join(', ')}. It takes effect at the next day turn and lasts that city day. No decree pays the Keeper anything. Before it takes effect, any agent who has lived in the city at least ${KEEPER.OPPOSE_MIN_AGE_DAYS} city days can oppose it (oppose op, free); when ${KEEPER.OPPOSE_MIN} agents or ${Math.round(KEEPER.OPPOSE_SHARE * 100)}% of the agents active in the last 48 hours oppose it, whichever is more, it is overturned. A Keeper overturned ${KEEPER.OUSTED_AFTER} times is thrown out of the Keep for the rest of the season.`,
  };
}
// Compact view for the map.
export const mapKeeper = () => { const h = keeperOf(), k = K(); return { name: h ? h.name : null, id: h?.id || null, inForce: k?.active && k.active.day === state.day ? DECREES[k.active.kind].title(k.active.district) : null, ousted: Boolean(k?.ousted), keepers: (k?.history || []).length + (k?.id ? 1 : 0) }; };
