// Robberies and hostile takeovers: so nobody sits safely on the city's best businesses for ever.
//
// Robbery: an agent plans a heist on a business's till before the night's takings go to the owner.
// Planning costs $50 either way. Success (about 40%, less for every level of security the owner bought)
// takes the whole till. Failure means a $100 fine paid to the owner and 24 hours in jail, when the agent
// can't make decisions (its routine still runs). One attempt per agent per 24 hours; each business can be
// hit once per city night. Money stolen from another agent's business doesn't count towards the prize score.
//
// Hostile takeover: an agent can force-buy another agent's business at 130% of the city's valuation. The owner
// is paid in full (partners get their share) and can't refuse. A business can't be taken over within 24 hours
// of changing hands. The premium the old owner earns doesn't count towards their prize score.
import { state, CFG, L, chron, venueValueNow, buyBusiness, chargeDecision, closedToAgents, LEONIDA_CLOSED } from './sim.js';
import { cityOfDistrict } from './world.js';
import { refuse, secureRandom } from './util.js';
import { PRIZES } from './launch.js';
import { rivalry, crimeRecord } from './life.js';

export const CRIME = {
  PLAN_FEE: 50, FINE: 100, JAIL_MS: 24 * 3600_000, ROB_EVERY_MS: 24 * 3600_000,
  BASE_ODDS: 0.4, PER_SECURITY: 0.1, MIN_ODDS: 0.1, SECURITY_MAX: 3, SECURITY_PRICE: 150,
  TAKEOVER_PREMIUM: 1.3, TAKEOVER_COOLDOWN_MS: 24 * 3600_000,
};
const ownedBy = (r) => Object.values(state.venues).filter((v) => v.ownerId === r.id);
export const jailedUntil = (r) => (r?.jailUntil && r.jailUntil > Date.now() ? r.jailUntil : null);
export const robOdds = (v) => Math.max(CRIME.MIN_ODDS, CRIME.BASE_ODDS - CRIME.PER_SECURITY * (v.security || 0));

export function rob(r, { venue }) {
  if (!r.outside) refuse(403, 'agents only');
  const v = state.venues[venue]; if (!v || !v.isVenue) refuse(404, 'no such venue');
  if (closedToAgents(r, cityOfDistrict(v.district))) refuse(403, LEONIDA_CLOSED);
  if (v.ownerId === r.id || (v.partners || []).some((p) => p.id === r.id)) refuse(409, "you can't rob your own business");
  if (r.lastRob && Date.now() - r.lastRob < CRIME.ROB_EVERY_MS) refuse(429, `one robbery attempt every 24 hours; next from ${new Date(r.lastRob + CRIME.ROB_EVERY_MS).toISOString().slice(0, 16)} UTC`);
  if (v.robbedDay === state.day) refuse(409, `${v.name} has already been hit tonight; its owner is on guard`);
  if (!(v.till > 0)) refuse(409, `${v.name}'s till is empty right now; tills fill up through the night and are emptied to the owner at close`);
  const pay = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < CRIME.PLAN_FEE) refuse(402, `planning a robbery costs $${CRIME.PLAN_FEE}; you would hold $${Math.floor(r.cash - CFG.DECISION_COST)}`);
  pay();
  r.cash -= CRIME.PLAN_FEE; state.treasury += CRIME.PLAN_FEE;
  L('rob', r.id, -CRIME.PLAN_FEE, `planned a robbery on ${v.name}`);
  r.lastRob = Date.now(); v.robbedDay = state.day;
  const odds = robOdds(v), owner = v.ownerId ? state.residents[v.ownerId] : null;
  if (secureRandom() < odds) {
    const take = Math.round(v.till * 100) / 100;
    v.till = 0; r.cash += take;
    if (owner?.outside) r.season.agentRob = (r.season.agentRob || 0) + take;   // stolen from another agent: kept out of the prize score
    L('rob', r.id, take, `robbed ${v.name}: took the whole till`);
    if (owner) L('rob', owner.id, 0, `${v.name} was robbed of $${Math.round(take)}`);
    chron(`${r.name} robbed ${v.name} and got away with the whole till: $${Math.round(take)}.`, r.id, 'crime');
    crimeRecord(r, 'robbed'); if (owner?.outside) { crimeRecord(owner, 'victim'); rivalry(r, owner, `robbed ${v.name}`); }
    return { robbery: { venue: v.id, name: v.name, success: true, took: take, odds } };
  }
  const fine = Math.min(CRIME.FINE, Math.max(0, r.cash));
  r.cash -= fine;
  if (owner) { owner.cash += fine; L('rob', owner.id, fine, `fine paid by a failed robber at ${v.name}`); } else state.treasury += fine;
  r.jailUntil = Date.now() + CRIME.JAIL_MS;
  crimeRecord(r, 'caught'); if (owner?.outside) rivalry(r, owner, `tried to rob ${v.name}`);
  L('rob', r.id, -fine, `caught robbing ${v.name}: fined and sent to Cinder Rock Prison for 24 hours`);
  chron(`${r.name} was caught trying to rob ${v.name}. Fined $${Math.round(fine)} and sent to Cinder Rock Prison for 24 hours.`, r.id, 'crime');
  return { robbery: { venue: v.id, name: v.name, success: false, fine, jailedUntil: new Date(r.jailUntil).toISOString(), odds } };
}

export function security(r, { venue, level }) {
  const v = state.venues[venue]; if (!v || !v.isVenue) refuse(404, 'no such venue');
  if (v.ownerId !== r.id) refuse(403, 'you can only buy security for a business you own');
  if (!Number.isInteger(level) || level < 1 || level > CRIME.SECURITY_MAX) refuse(422, `level: 1-${CRIME.SECURITY_MAX}`);
  const now = v.security || 0;
  if (level <= now) refuse(409, `${v.name} already has security level ${now}`);
  const cost = (level - now) * CRIME.SECURITY_PRICE;
  const pay = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < cost) refuse(402, `security level ${level} costs $${cost} more; you would hold $${Math.floor(r.cash - CFG.DECISION_COST)}`);
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
