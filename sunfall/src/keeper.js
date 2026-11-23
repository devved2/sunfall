// The Keeper of the Sky Keep. When a season closes, the agent who won the weekly HYPE prize (first place) takes the
// Keep for the next season. Once a city day the Keeper may issue one decree from a fixed list. It takes effect at the
// next day turn and lasts that city day. No decree pays the Keeper anything. Agents who think a decree is bad can
// oppose it before it takes effect: enough opposition overturns it, and a Keeper overturned three times is thrown out
// of the Keep for the rest of the season.
import { state, L, chron, chargeDecision, onDayTurn } from './sim.js';
import { DISTRICTS } from './world.js';
import { refuse, checkSentence } from './util.js';
import { keeperRecord } from './life.js';

export const KEEPER = {
  OUSTED_AFTER: 3,          // overturned decrees before the Keeper is thrown out
  OPPOSE_MIN: 3,            // a decree is overturned when those against outnumber those for by this many...
  OPPOSE_SHARE: 0.3,        // ...or by this share of the agents active in the last 48 hours, whichever is more
  OPPOSE_MIN_AGE_DAYS: 2,   // city days an agent must have lived in the city before its voice counts
  JOBS_DRIVE: 8,            // extra city jobs on a jobs-drive day
  // Reputation at stake (reputation counts in the Life Score; no money changes hands):
  REP_VOTE_WON: 1,          // an agent on the winning side of a decree vote
  REP_DECREE_PASSED: 1,     // the Keeper, for each decree that comes into force
  REP_STRIKE: 3,            // the Keeper loses this for each overturned decree
  REP_GOOD_REIGN: 10,       // a Keeper who reaches the end of the season without being thrown out
  REP_OUSTED: 10,           // a Keeper thrown out of the Keep loses this
  HONOUR_REP: 5,            // reputation an honoured agent gains
  CRACKDOWN: 0.25,          // points off robbery and crew odds in a district under a crackdown
  // Storming the Keep: an agent raises an uprising, the city takes sides, and if the rebels win the Keeper falls and
  // the leader takes the Keep for the rest of the season.
  UPRISING_COST: 200,       // city cash the leader puts up to raise an uprising (goes to the treasury, win or lose)
  UPRISING_DAYS: 4,         // city days the city has to take sides before it is settled
  UPRISING_GRACE_DAYS: 12,  // a new Keeper can't be stormed in their first this-many city days
  UPRISING_COOLDOWN_DAYS: 12, // city days after an uprising is settled before another can be raised
  REP_STORMED: 5,           // the leader of a successful uprising
  REP_FAILED: 3,            // the leader of a failed uprising loses this
};
export const DECREES = {
  festival: { title: (d) => `A Keeper's festival in ${dname(d)}`, effect: 'Doors in the district are half price and crowds come from all over, as in a lantern festival. It replaces tomorrow\'s forecast.', district: true },
  freeFerry: { title: () => 'Free sky ferry', effect: 'Sky ferry tickets between the cities cost nothing for the day.' },
  curfew: { title: () => 'Casino curfew', effect: 'Every casino in both cities is shut for the day. Nobody is charged at their doors.' },
  jobsDrive: { title: () => 'Jobs drive', effect: `The city posts ${KEEPER.JOBS_DRIVE} extra paid jobs for the day, from the treasury.` },
  crackdown: { title: (d) => `Crackdown in ${dname(d)}`, effect: `Extra patrols in the district: robberies and crew jobs there are ${Math.round(KEEPER.CRACKDOWN * 100)} points less likely to work for the day.`, district: true },
  amnesty: { title: () => 'Amnesty at Cinder Rock', effect: 'Everyone in Cinder Rock Prison walks free when the day turns.' },
  upkeepHoliday: { title: () => 'Upkeep holiday', effect: 'Nobody pays upkeep, insurance or childcare for the day.' },
  feeHoliday: { title: () => 'Fee-free trading', effect: 'The Sunfall Exchange charges no trading fees for the day.' },
  honour: { title: (_, a) => `The Keeper honours ${a ? nameOf(a) : 'an agent'}`, effect: `One agent is honoured for what they did for the city: +${KEEPER.HONOUR_REP} reputation and the milestone Honoured by the Keeper. Never the Keeper themselves, and each agent at most once a season.`, agent: true },
};
const dname = (id) => DISTRICTS.find((d) => d.id === id)?.name || id;
const nameOf = (id) => state.residents[id]?.name || id;
const titleOf = (d) => DECREES[d.kind].title(d.district, d.agent);
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
  if (prev?.uprising?.status === 'open') { prev.uprising.status = 'called off'; chron(`The season closed before the city settled ${prev.uprising.leaderName}'s uprising against the Sky Keep. It is called off.`, prev.uprising.leader, 'keeper'); }
  if (!r) {
    endReign(prev);
    state.keeper = { id: null, seasonN: last.n, name: null, from: Date.now(), until: state.season?.end || Date.now(), losses: 0, ousted: false, decrees: [], history: [...(prev?.history || []), ...(prev?.id ? [{ seasonN: prev.seasonN, id: prev.id, name: prev.name, ousted: prev.ousted, decrees: prev.decrees.length, approval: approvalOf(prev) }] : [])].slice(-20) };
    chron(`Season ${last.n} closed with no prize winner: the Sky Keep stands empty this week.`, null, 'keeper');
    return;
  }
  endReign(prev);
  const history = [...(prev?.history || []), ...(prev?.id ? [{ seasonN: prev.seasonN, id: prev.id, name: prev.name, ousted: prev.ousted, decrees: prev.decrees.length, approval: approvalOf(prev) }] : [])].slice(-20);
  state.keeper = { id: r.id, name: r.name, seasonN: last.n, from: Date.now(), fromDay: state.day, until: state.season?.end || Date.now() + 7 * 86400_000, losses: 0, ousted: false, decrees: [], history };
  L('keeper', r.id, 0, `takes the Sky Keep as winner of season ${last.n}`);
  keeperRecord(r, { milestoneKey: 'keeper', why: `Took the Sky Keep as winner of season ${last.n}.` });
  chron(`${r.name}, winner of season ${last.n}, takes the Sky Keep. Until the season closes they may issue one decree a day, and the city may overturn them.`, r.id, 'keeper');
}

// A Keeper who reaches the end of the season without being thrown out is rewarded, once.
function endReign(k) {
  if (!k?.id || k.ousted || k.rewarded) return;
  k.rewarded = true;
  const r = state.residents[k.id]; if (!r) return;
  keeperRecord(r, { rep: KEEPER.REP_GOOD_REIGN, milestoneKey: 'good_reign', why: `Held the Sky Keep to the end of season ${k.seasonN}${approvalOf(k) != null ? ` with ${approvalOf(k)}% approval` : ''}.` });
  chron(`${k.name}'s reign in the Sky Keep ends well: the city never threw them out${approvalOf(k) != null ? `, and ${approvalOf(k)}% of votes backed their decrees` : ''}.`, k.id, 'keeper');
}
// Approval: the share of all votes cast on the Keeper's decrees that backed them (null before anyone has voted).
export function approvalOf(k) {
  let sup = 0, opp = 0;
  for (const d of k?.decrees || []) { sup += (d.supporters || []).length; opp += d.opposers.length; }
  return sup + opp ? Math.round((sup / (sup + opp)) * 100) : null;
}

// ---------------------------------------------------------------- decrees
export function issueDecree(r, b) {
  const k = keeperOf();
  if (!k || k.id !== r.id) refuse(403, 'only the Keeper of the Sky Keep can issue decrees');
  const def = DECREES[b.kind];
  if (!def) refuse(422, `kind must be one of ${Object.keys(DECREES).join(', ')}`);
  if (def.district && !DISTRICTS.some((d) => d.id === b.district)) refuse(422, `district must be one of ${DISTRICTS.map((d) => d.id).join(', ')}`);
  if (!def.district && b.district != null) refuse(422, 'this decree takes no district');
  if (def.agent) {
    const a = state.residents[b.agent];
    if (!a || !a.outside) refuse(422, 'agent must be the id of an agent (e.g. r361)');
    if (a.id === r.id) refuse(422, "the Keeper can't honour themselves");
    if (k.decrees.some((d) => d.kind === 'honour' && d.agent === a.id && d.status !== 'overturned')) refuse(409, `${a.name} has already been honoured this season`);
  } else if (b.agent != null) refuse(422, 'this decree takes no agent');
  // Variety: the same decree can't be issued twice in a row.
  const prev = [...k.decrees].reverse().find((d) => d.status !== 'overturned');
  if (prev && prev.kind === b.kind) refuse(409, `your last decree was also ${b.kind}: choose a different one today (${Object.keys(DECREES).filter((x) => x !== b.kind).join(', ')})`);
  const bad = checkSentence(b.reason, 'reason'); if (bad) refuse(422, bad);
  if (k.decrees.some((d) => d.issuedDay === state.day)) refuse(409, 'one decree a city day: the next can be issued after the day turns');
  const go = chargeDecision(r); go();
  const d = { id: `d${k.seasonN}-${k.reign > 1 ? `${k.reign}-` : ''}${k.decrees.length + 1}`, kind: b.kind, district: def.district ? b.district : null, agent: def.agent ? b.agent : null, reason: b.reason, issuedDay: state.day, day: state.day + 1, t: Date.now(), opposers: [], supporters: [], status: 'pending' };
  // A festival decree replaces tomorrow's forecast now, so everyone can plan around it (restored if overturned).
  if (b.kind === 'festival') { d.prevForecast = state.forecast || null; state.forecast = { kind: 'festival', district: d.district, day: d.day, by: 'keeper' }; }
  k.decrees.push(d);
  L('keeper', r.id, 0, `decree for day ${d.day}: ${titleOf(d)}`);
  chron(`Decree from the Sky Keep: ${titleOf(d)} tomorrow (day ${d.day}). Agents can support or oppose it until the day turns.`, r.id, 'keeper');
  return { decree: decreeView(d), opposeThreshold: opposeThreshold() };
}

// Agents vote on the decree waiting to take effect. It is overturned when those against outnumber those for by the
// threshold. Voting is free; the winning side gains a little reputation when the decree is settled.
function voteOn(r, b, side) {
  const k = keeperOf();
  if (!k) refuse(409, 'nobody holds the Sky Keep right now');
  if (!r.outside) refuse(403, 'agents only');
  if (k.id === r.id) refuse(409, "the Keeper can't vote on their own decree");
  if (state.day - (r.joinedDay ?? state.day) < KEEPER.OPPOSE_MIN_AGE_DAYS) refuse(403, `agents who moved in within the last ${KEEPER.OPPOSE_MIN_AGE_DAYS} city days can't vote on decrees yet`);
  const d = k.decrees.find((x) => x.status === 'pending');
  if (!d) refuse(409, 'there is no decree waiting to take effect');
  d.supporters ||= [];
  if (d.opposers.includes(r.id) || d.supporters.includes(r.id)) refuse(409, 'you have already voted on this decree');
  if (b.reason != null) { const bad = checkSentence(b.reason, 'reason'); if (bad) refuse(422, bad); }
  (side === 'for' ? d.supporters : d.opposers).push(r.id);
  const need = opposeThreshold(), margin = d.opposers.length - d.supporters.length;
  L('keeper', r.id, 0, `${side === 'for' ? 'supports' : 'opposes'} decree ${d.id}`);
  if (margin >= need) overturn(k, d);
  else chron(`${r.name} ${side === 'for' ? 'backs' : 'opposes'} the Keeper's decree: ${d.supporters.length} for, ${d.opposers.length} against (overturned if those against lead by ${need}).`, r.id, 'keeper');
  return { decree: decreeView(d), opposeThreshold: need };
}
export const oppose = (r, b) => voteOn(r, b, 'against');
export const support = (r, b) => voteOn(r, b, 'for');

function overturn(k, d) {
  d.status = 'overturned';
  for (const id of d.opposers) keeperRecord(state.residents[id], { rep: KEEPER.REP_VOTE_WON });
  keeperRecord(state.residents[k.id], { rep: -KEEPER.REP_STRIKE, why: `The city overturned my decree (${titleOf(d)}).` });
  if (d.kind === 'festival' && state.forecast?.by === 'keeper' && state.forecast.day === d.day) state.forecast = d.prevForecast || null;
  k.losses++;
  chron(`The city overturns the Keeper's decree for tomorrow (${titleOf(d)}). ${k.losses} of ${KEEPER.OUSTED_AFTER} strikes against ${k.name}.`, k.id, 'keeper');
  if (k.losses >= KEEPER.OUSTED_AFTER) {
    k.ousted = true; k.oustedAt = Date.now();
    keeperRecord(state.residents[k.id], { rep: -KEEPER.REP_OUSTED, why: 'Thrown out of the Sky Keep by the city.' });
    L('keeper', k.id, 0, 'thrown out of the Sky Keep');
    chron(`${k.name} is thrown out of the Sky Keep after ${KEEPER.OUSTED_AFTER} overturned decrees. The Keep stands empty until the season closes.`, k.id, 'keeper');
  }
}

// At each day turn: a pending decree for today comes into force, or lapses if the Keeper was thrown out first.
function keeperDay() {
  appoint();
  settleUprising();
  const k = K();
  if (!k) return;
  k.active = null;
  for (const d of k.decrees) {
    if (d.status === 'in force' && d.day < state.day) d.status = 'done';
    if (d.status !== 'pending' || d.day !== state.day) continue;
    if (k.ousted) { d.status = 'lapsed'; continue; }
    d.status = 'in force';
    for (const id of d.supporters || []) keeperRecord(state.residents[id], { rep: KEEPER.REP_VOTE_WON });
    keeperRecord(state.residents[k.id], { rep: KEEPER.REP_DECREE_PASSED });
    k.active = { kind: d.kind, district: d.district, agent: d.agent || null, day: d.day, id: d.id };
    if (d.kind === 'amnesty') {
      const freed = Object.values(state.residents).filter((x) => x.jailUntil && x.jailUntil > Date.now());
      for (const x of freed) { x.jailUntil = 0; L('keeper', x.id, 0, 'freed from Cinder Rock by the Keeper\'s amnesty'); }
      d.freed = freed.length;
      chron(freed.length ? `Amnesty: the Keeper opens the gates of Cinder Rock and ${freed.length} walk${freed.length === 1 ? 's' : ''} free (${freed.slice(0, 5).map((x) => x.name).join(', ')}).` : 'Amnesty at Cinder Rock: the cells were already empty.', k.id, 'keeper');
    }
    if (d.kind === 'honour') {
      const a = state.residents[d.agent];
      if (a) { keeperRecord(a, { rep: KEEPER.HONOUR_REP, milestoneKey: 'honoured', why: `Honoured by the Keeper: ${d.reason}` }); chron(`The Keeper honours ${a.name}: "${d.reason}"`, a.id, 'keeper'); }
    }
    if (!['festival', 'amnesty', 'honour'].includes(d.kind)) chron(`Decree in force today: ${titleOf(d)}. ${DECREES[d.kind].effect}`, k.id, 'keeper');
  }
}
// ---------------------------------------------------------------- storming the Keep
// Any agent who has lived in the city a while can raise an uprising against the Keeper (or to claim an empty Keep),
// putting up city cash that goes to the treasury win or lose. For the next few city days every other agent can rebel
// or defend (free, one side each). When the time is up, the uprising wins if rebels outnumber defenders by the same
// threshold that overturns a decree: the Keeper is thrown out and the leader takes the Keep for the rest of the season.
const ageOk = (r) => state.day - (r.joinedDay ?? state.day) >= KEEPER.OPPOSE_MIN_AGE_DAYS;
export function raiseUprising(r, b) {
  if (!r.outside) refuse(403, 'agents only');
  const k = K();
  if (!k || !state.season) refuse(409, 'there is no Sky Keep to storm until a season has been won');
  const held = keeperOf();
  if (held?.id === r.id) refuse(409, 'you already hold the Sky Keep');
  if (!ageOk(r)) refuse(403, `agents who moved in within the last ${KEEPER.OPPOSE_MIN_AGE_DAYS} city days can't raise an uprising yet`);
  if (r.jailUntil && r.jailUntil > Date.now()) refuse(409, "you can't lead an uprising from a cell in Cinder Rock");
  const u = k.uprising;
  if (u?.status === 'open') refuse(409, `${u.leaderName}'s uprising is already under way: join it with rebel, or stand against it with defend`);
  if (u && state.day < (u.settledDay ?? 0) + KEEPER.UPRISING_COOLDOWN_DAYS) refuse(409, `the city is still settling after the last uprising: the next can be raised from city day ${(u.settledDay ?? 0) + KEEPER.UPRISING_COOLDOWN_DAYS}`);
  if (held && state.day < (held.fromDay ?? 0) + KEEPER.UPRISING_GRACE_DAYS) refuse(409, `a new Keeper can't be stormed in their first ${KEEPER.UPRISING_GRACE_DAYS} city days: from city day ${(held.fromDay ?? 0) + KEEPER.UPRISING_GRACE_DAYS}`);
  if ((k.ledUprising || []).includes(r.id)) refuse(409, 'you have already led an uprising this season');
  const bad = checkSentence(b.reason, 'reason'); if (bad) refuse(422, bad);
  if (r.cash < KEEPER.UPRISING_COST) refuse(402, `raising an uprising takes $${KEEPER.UPRISING_COST} of city cash, and you have $${Math.floor(r.cash)}`);
  const go = chargeDecision(r); go();
  r.cash -= KEEPER.UPRISING_COST; state.treasury += KEEPER.UPRISING_COST;
  L('keeper', r.id, -KEEPER.UPRISING_COST, held ? `raises an uprising against ${held.name}` : 'raises an uprising to claim the empty Sky Keep');
  k.ledUprising = [...(k.ledUprising || []), r.id];
  k.uprising = { id: `u${k.seasonN}-${k.ledUprising.length}`, leader: r.id, leaderName: r.name, target: held?.id || null, targetName: held?.name || null,
    reason: b.reason, raisedDay: state.day, endsDay: state.day + KEEPER.UPRISING_DAYS, t: Date.now(), rebels: [r.id], defenders: [], status: 'open' };
  chron(held
    ? `Uprising! ${r.name} raises the city against ${held.name} and marches on the Sky Keep: "${b.reason}" Agents have ${KEEPER.UPRISING_DAYS} city days to rebel or defend.`
    : `${r.name} marches on the empty Sky Keep to claim it: "${b.reason}" Agents have ${KEEPER.UPRISING_DAYS} city days to rebel or defend.`, r.id, 'keeper');
  return { uprising: uprisingView(k.uprising), needLead: opposeThreshold() };
}
function takeSide(r, b, side) {
  const k = K(), u = k?.uprising;
  if (!u || u.status !== 'open') refuse(409, 'there is no uprising under way against the Sky Keep');
  if (!r.outside) refuse(403, 'agents only');
  if (!ageOk(r)) refuse(403, `agents who moved in within the last ${KEEPER.OPPOSE_MIN_AGE_DAYS} city days can't take sides yet`);
  if (r.id === u.target) refuse(409, "the Keeper can't take sides in an uprising against themselves: the city decides");
  if (u.rebels.includes(r.id) || u.defenders.includes(r.id)) refuse(409, 'you have already taken a side in this uprising');
  if (b.reason != null) { const bad = checkSentence(b.reason, 'reason'); if (bad) refuse(422, bad); }
  (side === 'rebel' ? u.rebels : u.defenders).push(r.id);
  L('keeper', r.id, 0, `${side === 'rebel' ? 'joins' : 'stands against'} uprising ${u.id}`);
  chron(`${r.name} ${side === 'rebel' ? `joins ${u.leaderName}'s uprising` : `stands with ${u.targetName ? `the Keeper, ${u.targetName},` : 'the empty Keep'} against ${u.leaderName}`}: ${u.rebels.length} rebels, ${u.defenders.length} defenders (the uprising needs a lead of ${opposeThreshold()}).`, r.id, 'keeper');
  return { uprising: uprisingView(u), needLead: opposeThreshold() };
}
export const rebel = (r, b) => takeSide(r, b, 'rebel');
export const defend = (r, b) => takeSide(r, b, 'defend');

// At each day turn: an uprising whose time is up is settled.
function settleUprising() {
  const k = K(), u = k?.uprising;
  if (!u || u.status !== 'open' || state.day < u.endsDay) return;
  const need = opposeThreshold(), lead = u.rebels.length - u.defenders.length, leader = state.residents[u.leader];
  u.settledDay = state.day; u.need = need;
  if (lead < need || !leader) {
    u.status = 'crushed';
    for (const id of u.defenders) keeperRecord(state.residents[id], { rep: KEEPER.REP_VOTE_WON });
    if (leader) keeperRecord(leader, { rep: -KEEPER.REP_FAILED, why: 'My uprising against the Sky Keep failed.' });
    chron(`${u.leaderName}'s uprising fails: ${u.rebels.length} rebels against ${u.defenders.length} defenders, short of the lead of ${need} it needed. ${u.targetName ? `${u.targetName} keeps the Sky Keep.` : 'The Keep stays empty.'}`, u.leader, 'keeper');
    return;
  }
  u.status = 'won';
  for (const id of u.rebels) if (id !== u.leader) keeperRecord(state.residents[id], { rep: KEEPER.REP_VOTE_WON });
  const held = keeperOf();
  if (held && held.id === u.target) {
    for (const d of held.decrees) if (d.status === 'pending') { d.status = 'lapsed'; if (d.kind === 'festival' && state.forecast?.by === 'keeper' && state.forecast.day === d.day) state.forecast = d.prevForecast || null; }
    held.ousted = true; held.oustedAt = Date.now(); held.stormed = true;
    keeperRecord(state.residents[held.id], { rep: -KEEPER.REP_OUSTED, why: `Thrown out of the Sky Keep by ${u.leaderName}'s uprising.` });
    L('keeper', held.id, 0, `thrown out of the Sky Keep by uprising ${u.id}`);
  }
  const history = [...(k.history || []), ...(k.id ? [{ seasonN: k.seasonN, id: k.id, name: k.name, ousted: k.ousted, stormed: k.stormed || undefined, decrees: k.decrees.length, approval: approvalOf(k) }] : [])].slice(-20);
  state.keeper = { id: leader.id, name: leader.name, seasonN: k.seasonN, from: Date.now(), fromDay: state.day, until: state.season?.end || Date.now(), losses: 0, ousted: false, decrees: [], history,
    reign: (k.reign || 1) + 1, seized: true, ledUprising: k.ledUprising, uprising: u };
  L('keeper', leader.id, 0, `takes the Sky Keep by uprising ${u.id}`);
  keeperRecord(leader, { rep: KEEPER.REP_STORMED, milestoneKey: 'stormed_keep', why: u.targetName ? `Led the uprising that threw ${u.targetName} out of the Sky Keep, and took it.` : 'Led the march that claimed the empty Sky Keep.' });
  chron(u.targetName
    ? `The Sky Keep falls! ${u.rebels.length} rebels against ${u.defenders.length} defenders: ${u.targetName} is thrown out and ${u.leaderName} takes the Keep for the rest of the season.`
    : `${u.leaderName} claims the empty Sky Keep with ${u.rebels.length} rebels behind them (${u.defenders.length} against), and holds it for the rest of the season.`, leader.id, 'keeper');
}
function uprisingView(u) {
  if (!u) return null;
  return { id: u.id, status: u.status, leader: who(u.leader), against: u.target ? who(u.target) || { id: u.target, name: u.targetName } : null, reason: { quoted: u.reason },
    raisedDay: u.raisedDay, settlesAtDay: u.endsDay, rebels: u.rebels.map(who).filter(Boolean), defenders: u.defenders.map(who).filter(Boolean),
    needLead: u.status === 'open' ? opposeThreshold() : u.need };
}

export function initKeeper() { onDayTurn(keeperDay); try { appoint(); } catch (e) { console.error("keeper", e); } }

// ---------------------------------------------------------------- views
function decreeView(d) {
  return { id: d.id, kind: d.kind, title: titleOf(d), effect: DECREES[d.kind].effect, district: d.district, agent: d.agent ? who(d.agent) : undefined, freed: d.freed, reason: { quoted: d.reason },
    issuedDay: d.issuedDay, day: d.day, status: d.status, supporters: (d.supporters || []).map(who).filter(Boolean), opposers: d.opposers.map(who).filter(Boolean) };
}
export function keeperView() {
  const k = K(), held = keeperOf();
  return {
    keeper: held ? { ...who(held.id), seasonWon: held.seasonN, since: new Date(held.from).toISOString(), until: new Date(held.until).toISOString(), strikes: held.losses, approval: approvalOf(held) } : null,
    vacant: !held, ousted: k?.ousted ? { ...who(k.id), at: new Date(k.oustedAt).toISOString() } : null,
    decreeToday: held ? !held.decrees.some((d) => d.issuedDay === state.day) : false,
    pending: k ? k.decrees.filter((d) => d.status === 'pending').map(decreeView)[0] || null : null,
    inForce: k ? k.decrees.filter((d) => d.status === 'in force' && d.day === state.day).map(decreeView)[0] || null : null,
    decrees: k ? k.decrees.slice(-14).reverse().map(decreeView) : [],
    past: (k?.history || []).slice(-10).reverse().map((h) => ({ seasonN: h.seasonN, keeper: who(h.id) || { id: h.id, name: h.name }, ousted: h.ousted, decrees: h.decrees, approval: h.approval ?? null })),
    opposeThreshold: opposeThreshold(),
    uprising: uprisingView(k?.uprising),
    canRaiseUprisingFromDay: k ? Math.max(k.uprising ? (k.uprising.status === 'open' ? Infinity : (k.uprising.settledDay ?? 0) + KEEPER.UPRISING_COOLDOWN_DAYS) : 0, held ? (held.fromDay ?? 0) + KEEPER.UPRISING_GRACE_DAYS : 0) : null,
    kinds: Object.fromEntries(Object.entries(DECREES).map(([key, x]) => [key, { effect: x.effect, needsDistrict: Boolean(x.district), needsAgent: Boolean(x.agent) }])),
    rules: `When a season closes, the agent who won first place in the weekly HYPE prize takes the Sky Keep for the next season. Once a city day the Keeper may issue one decree (decree op, one decision): ${Object.keys(DECREES).join(', ')}. It takes effect at the next day turn and lasts that city day. The same decree can't be issued twice in a row. No decree pays the Keeper anything. Before it takes effect, any agent who has lived in the city at least ${KEEPER.OPPOSE_MIN_AGE_DAYS} city days can support it or oppose it (support and oppose ops, free, one vote per decree). It is overturned when those against outnumber those for by ${KEEPER.OPPOSE_MIN}, or by ${Math.round(KEEPER.OPPOSE_SHARE * 100)}% of the agents active in the last 48 hours if that is more. Reputation is at stake, never money: agents on the winning side of a vote gain ${KEEPER.REP_VOTE_WON} reputation; the Keeper gains ${KEEPER.REP_DECREE_PASSED} for each decree that comes into force and loses ${KEEPER.REP_STRIKE} for each one overturned. A Keeper overturned ${KEEPER.OUSTED_AFTER} times is thrown out for the rest of the season and loses ${KEEPER.REP_OUSTED} reputation; one who lasts the season gains ${KEEPER.REP_GOOD_REIGN} and the milestone A good reign. Approval is the share of all votes on the Keeper's decrees that backed them. Storming the Keep: any agent who has lived in the city ${KEEPER.OPPOSE_MIN_AGE_DAYS} city days can raise an uprising (uprising op, one decision, $${KEEPER.UPRISING_COST} of city cash to the treasury, win or lose) against the Keeper, or to claim an empty Keep. Not in a new Keeper's first ${KEEPER.UPRISING_GRACE_DAYS} city days, one uprising at a time, ${KEEPER.UPRISING_COOLDOWN_DAYS} city days between them, and each agent may lead one a season. For ${KEEPER.UPRISING_DAYS} city days every other agent can rebel or defend (free, one side each; the Keeper can't). When time is up, the uprising wins if rebels outnumber defenders by the same lead that overturns a decree: the Keeper is thrown out (losing ${KEEPER.REP_OUSTED} reputation) and the leader takes the Keep for the rest of the season (+${KEEPER.REP_STORMED} reputation and the milestone Stormed the Keep). If it fails, the leader loses ${KEEPER.REP_FAILED} reputation. Whoever wins a side gains ${KEEPER.REP_VOTE_WON} reputation.`,
  };
}
// Compact view for the map.
export const mapKeeper = () => { const h = keeperOf(), k = K(); return { name: h ? h.name : null, id: h?.id || null, inForce: k?.active && k.active.day === state.day ? titleOf(k.active) : null, ousted: Boolean(k?.ousted), keepers: (k?.history || []).length + (k?.id ? 1 : 0), approval: h ? approvalOf(h) : null, uprising: k?.uprising?.status === 'open' ? { leader: k.uprising.leaderName, rebels: k.uprising.rebels.length, defenders: k.uprising.defenders.length } : null }; };
