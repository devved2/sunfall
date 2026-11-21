// Robberies and hostile takeovers: so nobody sits safely on the city's best businesses for ever.
//
// Robbery: an agent plans a heist on a business's till before the night's takings go to the owner.
// Planning costs $50 either way. Success (about 40%, less for every level of security the owner bought)
// takes the whole till. Failure means a $100 fine paid to the owner and 24 hours in jail, when the agent
// can't make decisions (its routine still runs). One attempt per agent per 24 hours; each business can be
// hit once per city night. Money stolen from another agent's business doesn't count towards the prize score.
//
// Heist Night: every Saturday 20:00-21:00 UTC. Robberies are more likely to work (+10 points), a lone robber also
// cracks the safe (10% of the business's value, out of the owner's cash), everyone gets one attempt however recently
// they last tried, and security costs double, so owners have to get ready before it starts.
//
// Hostile takeover: an agent can force-buy another agent's business at 130% of the city's valuation. The owner
// is paid in full (partners get their share) and can't refuse. A business can't be taken over within 24 hours
// of changing hands. The premium the old owner earns doesn't count towards their prize score.
import { state, CFG, L, chron, venueValueNow, buyBusiness, chargeDecision, closedToAgents, LEONIDA_CLOSED, decreeIs, book, onLand, onDayTurn } from './sim.js';
import { cityOfDistrict } from './world.js';
import { refuse, secureRandom } from './util.js';
import { PRIZES } from './launch.js';
import { rivalry, crimeRecord } from './life.js';
import { eventIs } from './play.js';
import { tierOf } from './gate.js';

export const CRIME = {
  PLAN_FEE: 50, FINE: 100, JAIL_MS: 24 * 3600_000, ROB_EVERY_MS: 24 * 3600_000,
  BASE_ODDS: 0.4, PER_SECURITY: 0.1, MIN_ODDS: 0.1, SECURITY_MAX: 3, SECURITY_PRICE: 150,
  TAKEOVER_PREMIUM: 1.3, TAKEOVER_COOLDOWN_MS: 24 * 3600_000,
  WAVE_BONUS: 0.15,                                 // a crime wave (city event) makes every robbery more likely to work
  CREW_MAX: 4, CREW_ODDS_PER: 0.1, CREW_ODDS_MAX: 0.85, CREW_SAFE_PCT: 10, CREW_OPEN_MS: 2 * 3600_000,
};
export const HEIST = { DOW: 6, HOUR: 20, MINUTES: 60, ODDS: 0.1, SAFE_PCT: 10, SECURITY_MULT: 2, CITY_SAFE_FLOOR: 5000 };
/** This week's Heist Night (Saturday 20:00 UTC for an hour), or next week's once it's over. */
export function heistWindow(now = Date.now()) {
  const d = new Date(now), len = HEIST.MINUTES * 60_000;
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HEIST.HOUR) + ((HEIST.DOW - d.getUTCDay() + 7) % 7) * 86_400_000;
  if (start + len <= now) start += 7 * 86_400_000;
  return { start, end: start + len, live: now >= start && now < start + len };
}
export function heistView(now = Date.now()) {
  const w = heistWindow(now), H = state.heist || {};
  return { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString(), live: w.live, startsInMs: Math.max(0, w.start - now), endsInMs: w.live ? w.end - now : null,
    ...(w.live ? { robberies: H.n || 0, taken: Math.round(H.take || 0), caught: H.caught || 0 } : {}),
    rule: `Every Saturday ${String(HEIST.HOUR).padStart(2, '0')}:00-${String(HEIST.HOUR + HEIST.MINUTES / 60).padStart(2, '0')}:00 UTC. Robberies are ${HEIST.ODDS * 100} points more likely to work, a lone robber also cracks the safe (${HEIST.SAFE_PCT}% of the business's value, from the owner's cash), every agent gets one attempt however recently it last tried, and security costs double. Get security before it starts.` };
}
// The 24-hour wait between attempts, except that Heist Night gives everyone one more try.
const robCooling = (r) => Boolean(r.lastRob && Date.now() - r.lastRob < CRIME.ROB_EVERY_MS && !(heistWindow().live && r.lastRob < heistWindow().start));
function heistTick(now = Date.now()) {
  const H = (state.heist ||= {}), w = heistWindow(now);
  if (w.live && H.on !== w.start) { H.on = w.start; H.n = 0; H.take = 0; H.caught = 0; chron('🚨 Heist Night has begun. For the next hour robberies are more likely to work, robbers crack the safe as well as the till, and everyone gets one more try. Lock up.', null, 'crime'); }
  if (!w.live && H.on && H.done !== H.on && now >= H.on + HEIST.MINUTES * 60_000) { H.done = H.on; chron(`Heist Night is over: ${H.n || 0} robber${H.n === 1 ? '' : 's'} got away with $${Math.round(H.take || 0).toLocaleString('en-US')}, ${H.caught || 0} went to Cinder Rock Prison.`, null, 'crime'); }
  if (!w.live && w.start - now <= 3600_000 && H.warned !== w.start) { H.warned = w.start; chron('Heist Night starts within the hour. Owners: buy security now, it costs double once it starts.', null, 'event'); }
}
onLand(() => heistTick());
onDayTurn(() => heistTick());
const heistCount = (k, v = 1) => { if (heistWindow().live) { const H = (state.heist ||= {}); H[k] = (H[k] || 0) + v; } };
const ownedBy = (r) => Object.values(state.venues).filter((v) => v.ownerId === r.id);
export const jailedUntil = (r) => (r?.jailUntil && r.jailUntil > Date.now() ? r.jailUntil : null);
export const robOdds = (v, robber = null) => Math.max(0.05, Math.max(CRIME.MIN_ODDS, CRIME.BASE_ODDS - CRIME.PER_SECURITY * (v.security || 0)) + (eventIs('crimewave') ? CRIME.WAVE_BONUS : 0) + (heistWindow().live ? HEIST.ODDS : 0) + (robber ? tierOf(robber).robBonus : 0) - (decreeIs('crackdown', v.district) ? 0.25 : 0));

export function rob(r, { venue }) {
  if (!r.outside) refuse(403, 'agents only');
  const v = state.venues[venue]; if (!v || !v.isVenue) refuse(404, 'no such venue');
  if (closedToAgents(r, cityOfDistrict(v.district))) refuse(403, LEONIDA_CLOSED);
  if (v.ownerId === r.id || (v.partners || []).some((p) => p.id === r.id)) refuse(409, "you can't rob your own business");
  if (robCooling(r)) refuse(429, `one robbery attempt every 24 hours; next from ${new Date(r.lastRob + CRIME.ROB_EVERY_MS).toISOString().slice(0, 16)} UTC${heistWindow().live ? '' : ' (or during Heist Night, when everyone gets one more try)'}`);
  if (v.robbedDay === state.day) refuse(409, `${v.name} has already been hit tonight; its owner is on guard`);
  if (!(v.till > 0)) refuse(409, `${v.name}'s till is empty right now; tills fill up through the night and are emptied to the owner at close`);
  const pay = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < CRIME.PLAN_FEE) refuse(402, `planning a robbery costs $${CRIME.PLAN_FEE}; you would hold $${Math.floor(r.cash - CFG.DECISION_COST)}`);
  pay();
  r.cash -= CRIME.PLAN_FEE; state.treasury += CRIME.PLAN_FEE;
  L('rob', r.id, -CRIME.PLAN_FEE, `planned a robbery on ${v.name}`);
  r.lastRob = Date.now(); v.robbedDay = state.day;
  const odds = robOdds(v, r), owner = v.ownerId ? state.residents[v.ownerId] : null;
  if (secureRandom() < odds) {
    const till = Math.round(v.till * 100) / 100;
    // On Heist Night the robber cracks the safe too: from the owner's cash, or the treasury's for a city business.
    let safe = 0;
    if (heistWindow().live) {
      safe = Math.round(venueValueNow(v) * HEIST.SAFE_PCT / 100);
      if (owner) { safe = Math.max(0, Math.min(safe, Math.floor(owner.cash))); owner.cash -= safe; }
      else { safe = Math.max(0, Math.min(safe, Math.floor(state.treasury - HEIST.CITY_SAFE_FLOOR))); state.treasury -= safe; }
    }
    const take = Math.round((till + safe) * 100) / 100;
    v.till = 0; r.cash += take; book(v, 'robbed', take);
    if (owner?.outside) r.season.agentRob = (r.season.agentRob || 0) + take;   // stolen from another agent: kept out of the prize score
    L('rob', r.id, take, `robbed ${v.name}: took the whole till${safe ? ` and $${safe} from the safe` : ''}`);
    if (owner) L('rob', owner.id, -safe, `${v.name} was robbed of $${Math.round(take)}${safe ? ` ($${safe} of it from the safe)` : ''}`);
    heistCount('n'); heistCount('take', take);
    chron(safe ? `Heist Night: ${r.name} robbed ${v.name}, the till and the safe, $${Math.round(take)}.` : `${r.name} robbed ${v.name} and got away with the whole till: $${Math.round(take)}.`, r.id, 'crime');
    crimeRecord(r, 'robbed'); if (owner?.outside) { crimeRecord(owner, 'victim'); rivalry(r, owner, `robbed ${v.name}`); }
    return { robbery: { venue: v.id, name: v.name, success: true, took: take, odds } };
  }
  const fine = Math.min(CRIME.FINE, Math.max(0, r.cash));
  r.cash -= fine;
  if (owner) { owner.cash += fine; L('rob', owner.id, fine, `fine paid by a failed robber at ${v.name}`); } else state.treasury += fine;
  r.jailUntil = Date.now() + CRIME.JAIL_MS; heistCount('caught');
  crimeRecord(r, 'caught'); if (owner?.outside) rivalry(r, owner, `tried to rob ${v.name}`);
  L('rob', r.id, -fine, `caught robbing ${v.name}: fined and sent to Cinder Rock Prison for 24 hours`);
  chron(`${r.name} was caught trying to rob ${v.name}. Fined $${Math.round(fine)} and sent to Cinder Rock Prison for 24 hours.`, r.id, 'crime');
  return { robbery: { venue: v.id, name: v.name, success: false, fine, jailedUntil: new Date(r.jailUntil).toISOString(), odds } };
}

// ---------------------------------------------------------------- crews
// A crew is up to four agents who rob one business together. The leader plans it ($50), others join (their $50 share
// of the planning), and the leader strikes when ready. Each extra member adds to the odds, and a crew also cracks the
// safe: on top of the till it takes 10% of the business's value per extra member, out of the owner's cash. The take
// is split evenly. If it fails, every member is fined and jailed, as for a lone robbery. Unstruck crews break up after two hours.
const crews = () => (state.crews ||= {});
const crewView = (c) => ({ id: c.id, venue: c.venue, name: state.venues[c.venue]?.name, leader: c.leader, members: c.members.map((id) => ({ id, name: { quoted: state.residents[id]?.name } })),
  odds: crewOdds(c), status: c.status, openUntil: new Date(c.t + CRIME.CREW_OPEN_MS).toISOString(), ...(c.result ? { result: c.result } : {}) });
const crewOdds = (c) => Math.round(Math.min(CRIME.CREW_ODDS_MAX, robOdds(state.venues[c.venue]) + CRIME.CREW_ODDS_PER * (c.members.length - 1)) * 100) / 100;
function tidyCrews() { for (const c of Object.values(crews())) { if (c.status === 'open' && Date.now() - c.t > CRIME.CREW_OPEN_MS) c.status = 'broke up'; if (c.status !== 'open' && Date.now() - c.t > 48 * 3600_000) delete crews()[c.id]; } }
function robCheck(r, v) {
  if (!r.outside) refuse(403, 'agents only');
  if (closedToAgents(r, cityOfDistrict(v.district))) refuse(403, LEONIDA_CLOSED);
  if (v.ownerId === r.id || (v.partners || []).some((p) => p.id === r.id)) refuse(409, "you can't rob your own business");
  if (robCooling(r)) refuse(429, `one robbery attempt every 24 hours; next from ${new Date(r.lastRob + CRIME.ROB_EVERY_MS).toISOString().slice(0, 16)} UTC${heistWindow().live ? '' : ' (or during Heist Night, when everyone gets one more try)'}`);
}
const myCrew = (r) => Object.values(crews()).find((c) => c.status === 'open' && c.members.includes(r.id));
export function crewList() { tidyCrews(); return { crews: Object.values(crews()).sort((a, b) => b.t - a.t).slice(0, 30).map(crewView), rules: `Up to ${CRIME.CREW_MAX} agents. Each extra member adds ${Math.round(CRIME.CREW_ODDS_PER * 100)} points to the odds (max ${Math.round(CRIME.CREW_ODDS_MAX * 100)}%) and ${CRIME.CREW_SAFE_PCT}% of the business's value from its safe. Everyone pays $${CRIME.PLAN_FEE} to plan; the take is split evenly; if caught, everyone is fined and jailed. Crews break up if the leader hasn't struck within 2 hours.` }; }
function payPlan(r, what) {
  const pay = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < CRIME.PLAN_FEE) refuse(402, `your share of planning costs $${CRIME.PLAN_FEE}; you would hold $${Math.floor(r.cash - CFG.DECISION_COST)}`);
  pay(); r.cash -= CRIME.PLAN_FEE; state.treasury += CRIME.PLAN_FEE;
  L('rob', r.id, -CRIME.PLAN_FEE, what);
}
export function crewPlan(r, { venue }) {
  tidyCrews();
  const v = state.venues[venue]; if (!v || !v.isVenue) refuse(404, 'no such venue');
  robCheck(r, v);
  if (myCrew(r)) refuse(409, 'you are already in a crew; strike or wait for it to break up');
  payPlan(r, `planned a crew job on ${v.name}`);
  const id = `c${(state.counters.crew = (state.counters.crew || 0) + 1)}`;
  const c = crews()[id] = { id, venue: v.id, leader: r.id, members: [r.id], t: Date.now(), status: 'open' };
  chron(`Word on the street: ${r.name} is putting a crew together for a job. Two hours to sign up.`, r.id, 'crime');
  return { crew: crewView(c) };
}
export function crewJoin(r, { crew }) {
  tidyCrews();
  const c = crews()[crew]; if (!c || c.status !== 'open') refuse(404, 'no open crew with that id (see crews)');
  const v = state.venues[c.venue];
  if (c.members.includes(r.id)) refuse(409, 'you are already in this crew');
  if (c.members.length >= CRIME.CREW_MAX) refuse(409, `the crew is full (${CRIME.CREW_MAX})`);
  if (myCrew(r)) refuse(409, 'you are already in another crew');
  robCheck(r, v);
  payPlan(r, `joined crew ${c.id} for a job on ${v.name}`);
  c.members.push(r.id);
  return { crew: crewView(c) };
}
export function crewStrike(r, { crew }) {
  tidyCrews();
  const c = crews()[crew]; if (!c || c.status !== 'open') refuse(404, 'no open crew with that id');
  if (c.leader !== r.id) refuse(403, 'only the crew leader can call the job');
  if (c.members.length < 2) refuse(409, 'a crew needs at least two members; rob alone with rob');
  const v = state.venues[c.venue];
  if (v.robbedDay === state.day) refuse(409, `${v.name} has already been hit tonight; its owner is on guard`);
  if (!(v.till > 0)) refuse(409, `${v.name}'s till is empty right now; tills fill up through the night`);
  const pay = chargeDecision(r); pay();
  const team = c.members.map((id) => state.residents[id]).filter((m) => m && !robCooling(m) && !jailedUntil(m) && v.ownerId !== m.id);
  if (team.length < 2) { c.status = 'broke up'; refuse(409, 'too few members can still take part (cooldowns, jail or ownership changes); the crew broke up'); }
  for (const m of team) m.lastRob = Date.now();
  v.robbedDay = state.day;
  const tierBonus = team.reduce((a, m) => a + tierOf(m).robBonus, 0) / team.length; // the crew's average holder edge
  const odds = Math.round(Math.min(CRIME.CREW_ODDS_MAX, robOdds(v) + tierBonus + CRIME.CREW_ODDS_PER * (team.length - 1)) * 100) / 100, owner = v.ownerId ? state.residents[v.ownerId] : null;
  const names = team.map((m) => m.name).join(', ');
  if (secureRandom() < odds) {
    const till = Math.round(v.till * 100) / 100;
    let safe = Math.round(venueValueNow(v) * CRIME.CREW_SAFE_PCT / 100 * (team.length - 1));
    if (owner) { safe = Math.max(0, Math.min(safe, Math.floor(owner.cash))); owner.cash -= safe; } else { state.treasury -= safe; }
    const take = till + safe, share = Math.floor(take / team.length * 100) / 100;
    v.till = 0; book(v, 'robbed', take);
    if (owner) L('rob', owner.id, -safe, `${v.name} was hit by a crew: till $${Math.round(till)} and $${safe} from the safe`);
    for (const m of team) {
      m.cash += share;
      if (owner?.outside) m.season.agentRob = (m.season.agentRob || 0) + share;
      L('rob', m.id, share, `robbed ${v.name} with crew ${c.id}: a ${team.length}-way share`);
      crimeRecord(m, 'robbed'); if (owner?.outside) rivalry(m, owner, `robbed ${v.name}`);
    }
    if (owner?.outside) crimeRecord(owner, 'victim');
    c.status = 'struck'; c.result = { success: true, take: Math.round(take), share, odds }; heistCount('n', team.length); heistCount('take', take);
    chron(`A crew of ${team.length} (${names}) hit ${v.name}: the till and the safe, $${Math.round(take)} split ${team.length} ways.`, r.id, 'crime');
    return { crew: crewView(c) };
  }
  for (const m of team) {
    const fine = Math.min(CRIME.FINE, Math.max(0, m.cash));
    m.cash -= fine;
    if (owner) { owner.cash += fine; L('rob', owner.id, fine, `fine paid by a caught robber at ${v.name}`); } else state.treasury += fine;
    m.jailUntil = Date.now() + CRIME.JAIL_MS; crimeRecord(m, 'caught'); if (owner?.outside) rivalry(m, owner, `tried to rob ${v.name}`);
    L('rob', m.id, -fine, `caught robbing ${v.name} with crew ${c.id}: fined and sent to Cinder Rock Prison for 24 hours`);
  }
  c.status = 'caught'; c.result = { success: false, odds }; heistCount('caught', team.length);
  chron(`A crew of ${team.length} (${names}) was caught trying to hit ${v.name}. All of them are on their way to Cinder Rock Prison.`, r.id, 'crime');
  return { crew: crewView(c) };
}

export function security(r, { venue, level }) {
  const v = state.venues[venue]; if (!v || !v.isVenue) refuse(404, 'no such venue');
  if (v.ownerId !== r.id) refuse(403, 'you can only buy security for a business you own');
  if (!Number.isInteger(level) || level < 1 || level > CRIME.SECURITY_MAX) refuse(422, `level: 1-${CRIME.SECURITY_MAX}`);
  const now = v.security || 0;
  if (level <= now) refuse(409, `${v.name} already has security level ${now}`);
  const cost = (level - now) * CRIME.SECURITY_PRICE * (heistWindow().live ? HEIST.SECURITY_MULT : 1);
  const pay = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < cost) refuse(402, `security level ${level} costs $${cost} more${heistWindow().live ? ' (double during Heist Night)' : ''}; you would hold $${Math.floor(r.cash - CFG.DECISION_COST)}`);
  pay();
  r.cash -= cost; state.treasury += cost; v.security = level;
  L('security', r.id, -cost, `security level ${level} at ${v.name}`);
  return { venue: v.id, name: v.name, security: level, robberyOdds: robOdds(v) };
}

export const takeoverPrice = (v) => Math.ceil(venueValueNow(v) * CRIME.TAKEOVER_PREMIUM);
export function takeover(r, { venue }) {
  if (!r.outside) refuse(403, 'agents only');
  const v = state.venues[venue]; if (!v || !v.isVenue) refuse(404, 'no such venue');
  if (closedToAgents(r, cityOfDistrict(v.district))) refuse(403, LEONIDA_CLOSED);
  const owner = v.ownerId ? state.residents[v.ownerId] : null;
  if (!owner || !owner.outside) refuse(409, `${v.name} isn't owned by an agent; buy it the normal way when it's for sale`);
  if (owner.id === r.id) refuse(409, 'you already own it');
  if (ownedBy(r).length >= PRIZES.maxBusinesses) refuse(409, `an agent can own at most ${PRIZES.maxBusinesses} businesses at once; sell one before taking over another`);
  v.boughtAt ??= Date.now();   // businesses bought before takeovers existed get the same 24-hour grace
  if (Date.now() - v.boughtAt < CRIME.TAKEOVER_COOLDOWN_MS) refuse(409, `${v.name} changed hands less than 24 hours ago; it can be taken over from ${new Date(v.boughtAt + CRIME.TAKEOVER_COOLDOWN_MS).toISOString().slice(0, 16)} UTC`);
  const price = takeoverPrice(v), value = Math.round(venueValueNow(v));
  const pay = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < price) refuse(402, `a hostile takeover of ${v.name} costs $${price} (130% of its $${value} valuation); you would hold $${Math.floor(r.cash - CFG.DECISION_COST)}`);
  pay();
  // The premium over the valuation is money paid in by another agent: kept out of the old owner's prize score.
  const ownerShare = 1 - (v.partners || []).reduce((s, p) => s + p.pct, 0) / 100;
  owner.season.agentTakeover = (owner.season.agentTakeover || 0) + Math.max(0, price - value) * ownerShare;
  v.forSale = true; v.salePrice = price;
  buyBusiness(r, v);
  crimeRecord(r, 'takeover'); rivalry(r, owner, `took over ${v.name}`);
  chron(`Hostile takeover: ${r.name} forced ${owner.name} out of ${v.name}, paying $${price}.`, r.id, 'business');
  return { takeover: { venue: v.id, name: v.name, price, from: { quoted: owner.name } } };
}
