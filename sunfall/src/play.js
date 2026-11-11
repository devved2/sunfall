// The game layer: seasons and their win condition, loans, business stakes (partnerships) and city events.
// Everything here moves money through the same ledger as the rest of the city.
import { CFG, state, L, chron, netWorth, venueValueNow, seasonFor, payPartners, ensurePlaces, foundNightfall, planResident, saleFloor, SALE_FLOOR_PCT } from './sim.js';
import { VTYPES, DISTRICTS, PLACES } from './world.js';
import { secureRandom, pick, clamp, refuse } from './util.js';
import { PRIZES, LAUNCH } from './launch.js';
import { VAULT, prizeAddedBetween, freePrizePot, grantAwards, recentAwards } from './vault.js';
import { voidAgentBets } from './football.js';
import { writeDiaries } from './diary.js';

export const GAME = {
  LOAN_MIN: 20, LOAN_MAX: 2000, LOAN_RATE_MAX: 50, LOAN_DAYS_MAX: 14, LOANS_ACTIVE_MAX: 3, LOAN_OFFERS_MAX: 5,
  STAKE_MIN: 5, STAKE_TOTAL_MAX: 50,
  EVENT_CHANCE: Number(process.env.EVENT_CHANCE ?? 0.55),
};

// ---------------------------------------------------------------- state defaults (also migrates older saves)
// Take listed agents out of the city for good (launch.json "removedAgents"). Only an agent with no businesses,
// loans or stakes is removed, so nobody else's money is touched; its cash goes back to the treasury.
function removeAgents() {
  for (const id of LAUNCH.removedAgents) {
    const r = state.residents[id];
    if (!r || !r.outside) continue;
    const busy = Object.values(state.venues).some((v) => v.ownerId === id || (v.partners || []).some((p) => p.id === id))
      || Object.values(state.loans).some((l) => ['open', 'active'].includes(l.status) && (l.lender === id || l.borrower === id))
      || Object.values(state.stakeOffers || {}).some((o) => o.status === 'open' && o.seller === id);
    if (busy) { console.error(`removedAgents: ${id} still has businesses, loans or stakes; left in place`); continue; }
    for (const j of Object.values(state.jobs)) {
      if (j.takenBy === id && j.status === 'taken') { j.status = 'open'; j.takenBy = null; }
      if (j.by === id && ['open', 'taken'].includes(j.status)) { j.status = 'expired'; j.note = 'the poster left the city'; }
    }
    state.treasury += Math.max(0, r.cash || 0);
    for (const [k, v] of Object.entries(state.keys)) if (v === id) delete state.keys[k];
    for (const [k, v] of Object.entries(state.names)) if (v === id) delete state.names[k];
    delete state.residents[id];
    L('leave', 'city', 0, `${id} removed from the city`);
    console.log(`removedAgents: ${id} removed`);
  }
}
// Take a ring of agents out together (launch.json "purgedAgents"). A member still tied to someone outside the ring
// (an active loan with another resident, or a partner in one of its businesses) is left in place and logged.
function purgeAgents() {
  const ids = new Set(LAUNCH.purgedAgents.filter((id) => state.residents[id]?.outside));
  if (!ids.size) return;
  const ok = (id) => id === 'city' || ids.has(id);
  for (const id of [...ids]) {
    const tied = Object.values(state.loans).some((l) => l.status === 'active' && (l.lender === id || l.borrower === id) && !(ok(l.lender) && ok(l.borrower)))
      || Object.values(state.venues).some((v) => v.ownerId === id && (v.partners || []).some((p) => !ids.has(p.id)));
    if (tied) { console.error(`purgedAgents: ${id} is tied to residents outside the ring; left in place`); ids.delete(id); }
  }
  if (!ids.size) return;
  for (const l of Object.values(state.loans)) {
    if (l.status === 'open' && ids.has(l.lender)) cancelOffer(l, 'lender left the city');
    else if (l.status === 'active' && (ids.has(l.lender) || ids.has(l.borrower))) { l.status = 'defaulted'; l.note = 'left the city'; }
  }
  for (const o of Object.values(state.stakeOffers)) if (o.status === 'open' && ids.has(o.seller)) o.status = 'lapsed';
  voidAgentBets(ids);
  for (const v of Object.values(state.venues)) {
    v.partners = (v.partners || []).filter((p) => !ids.has(p.id));
    if (v.ownerId && ids.has(v.ownerId)) {
      const base = PLACES.find((p) => p[0] === v.id)?.[6];
      v.ownerId = null; v.partners = []; v.distress = 0; v.price = VTYPES[v.type].price; delete v.fireSale;
      v.forSale = true; v.salePrice = base || Math.round((VTYPES[v.type].value * 0.7) / 10) * 10;
      chron(`${v.name} goes back to the city and is for sale at ${money(v.salePrice)}.`, null, 'business');
    }
  }
  for (const j of Object.values(state.jobs)) {
    if (ids.has(j.takenBy) && j.status === 'taken' && !ids.has(j.by)) { j.status = 'open'; j.takenBy = null; }
    if (ids.has(j.by) && ['open', 'taken'].includes(j.status)) state.treasury += j.pay; // escrow goes to the treasury
    if (ids.has(j.by) || ids.has(j.takenBy)) delete state.jobs[j.id];
  }
  for (const l of Object.values(state.loans)) if (ids.has(l.lender) || ids.has(l.borrower)) delete state.loans[l.id];
  for (const o of Object.values(state.stakeOffers)) if (ids.has(o.seller) || ids.has(o.buyer)) delete state.stakeOffers[o.id];
  for (const id of ids) {
    const r = state.residents[id];
    state.treasury += Math.max(0, r.cash || 0);
    for (const [k, v] of Object.entries(state.keys)) if (v === id) delete state.keys[k];
    for (const [k, v] of Object.entries(state.names)) if (v === id) delete state.names[k];
    delete state.residents[id];
    L('leave', 'city', Math.max(0, r.cash || 0), `${id} removed from the city (ring), cash to the treasury`);
    console.log(`purgedAgents: ${id} removed`);
  }
  chron(`${ids.size} agents who were trading only among themselves have been removed from the city.`, null, 'event');
}
export function migrate() {
  state.loans ||= {};
  state.stakeOffers ||= {};
  // Sale floors: take agents' below-floor listings off the market and lapse below-floor stake offers.
  for (const v of Object.values(state.venues)) {
    if (v.forSale && v.ownerId && state.residents[v.ownerId]?.outside && !(v.distress >= 2) && v.salePrice < saleFloor(v)) {
      chron(`${v.name} comes off the market: ${money(v.salePrice)} is below the ${SALE_FLOOR_PCT}% floor.`, v.ownerId, 'business');
      v.forSale = false; v.salePrice = null;
    }
  }
  for (const o of Object.values(state.stakeOffers)) {
    if (o.status === 'open' && state.venues[o.venue] && o.price < saleFloor(state.venues[o.venue], o.pct)) o.status = 'lapsed';
  }
  state.hallOfFame ||= [];
  state.event ??= null;
  state.forecast ??= null;
  state.counters.l ||= 0;
  state.counters.o ||= 0;
  if (!state.season || !state.season.n) state.season = { n: 1, ...(state.season || seasonFor(Date.now())) };
  for (const r of Object.values(state.residents)) {
    r.credit ||= { repaid: 0, defaulted: 0 };
    r.season ||= { interest: 0, jobs: 0, dividends: 0 };
  }
  ensurePlaces();
  if (foundNightfall()) for (const r of Object.values(state.residents)) if (!r.plan) planResident(r); // Nightfall's first natives get today's plan
  for (const v of Object.values(state.venues)) v.partners ||= [];
  removeAgents();
  purgeAgents();
  if (!Object.values(state.loans).some((l) => l.lender === 'city' && l.status === 'open')) cityBank();
  if (process.env.FORCE_EVENT) { const [kind, district] = process.env.FORCE_EVENT.split(':'); state.event = { kind, district: district || null, day: state.day }; } // testing only
}

const districtName = (id) => DISTRICTS.find((d) => d.id === id)?.name || id;
const money = (n) => `$${Math.round(n)}`;

// ---------------------------------------------------------------- events
// Each day turn activates yesterday's forecast and rolls tomorrow's, so agents can plan around it.
export const EVENT_KINDS = {
  storm: { icon: '⛈', title: (d) => `Storm over ${districtName(d)}`, blurb: 'Every venue in the district is shut for the day. Nobody is charged; jobs there are refunded.', district: true },
  festival: { icon: '🏮', title: (d) => `Lantern festival in ${districtName(d)}`, blurb: 'Doors in the district are half price and the crowds come from all over the city.', district: true },
  boom: { icon: '⚙', title: () => 'Cloudworks boom', blurb: 'The city adds 25% on top of wages paid today, while its bonus fund lasts.' },
  crash: { icon: '📉', title: () => 'Market crash', blurb: 'Business values drop 40% for the day and the city dumps two venues at fire-sale prices.' },
  lucky: { icon: '🎲', title: () => 'Lucky night', blurb: 'The casinos run hot tonight: better odds at every table.' },
  cargo: { icon: '🛸', title: () => 'Cargo airships dock', blurb: 'The city posts a rush of well-paid jobs for today.' },
};
export const eventIs = (kind, district) => state.event && state.event.day === state.day && state.event.kind === kind && (!district || state.event.district === district);
function rollForecast() {
  if (secureRandom() > GAME.EVENT_CHANCE) { state.forecast = null; return; }
  const weights = { storm: 3, festival: 3, lucky: 2, cargo: 2, boom: 1, crash: 1 };
  let x = secureRandom() * Object.values(weights).reduce((a, b) => a + b, 0);
  const kind = Object.keys(weights).find((k) => (x -= weights[k]) <= 0) || 'festival';
  const district = EVENT_KINDS[kind].district ? pick(DISTRICTS).id : null;
  state.forecast = { kind, district, day: state.day + 1 };
  chron(`Forecast for day ${state.day + 1}: ${EVENT_KINDS[kind].title(district).toLowerCase()}.`, null, 'forecast');
}
export function eventView(e) {
  if (!e) return null;
  const k = EVENT_KINDS[e.kind];
  return { kind: e.kind, day: e.day, district: e.district, districtName: e.district ? districtName(e.district) : null, icon: k.icon, title: k.title(e.district), effect: k.blurb };
}
function startEvent() {
  state.event = state.forecast && state.forecast.day === state.day ? { ...state.forecast } : null;
  state.forecast = null;
  if (!state.event) return;
  const k = EVENT_KINDS[state.event.kind];
  chron(`${k.icon} ${k.title(state.event.district)}. ${k.blurb}`, null, 'event');
  if (state.event.kind === 'crash') {
    const cityOwned = Object.values(state.venues).filter((v) => v.isVenue && !v.ownerId && !v.forSale && !VTYPES[v.type].cityOnly);
    for (let i = 0; i < 2 && cityOwned.length; i++) {
      const v = cityOwned.splice(Math.floor(secureRandom() * cityOwned.length), 1)[0];
      v.forSale = true; v.salePrice = Math.round((VTYPES[v.type].value * 0.5) / 10) * 10; v.fireSale = state.day;
      chron(`Fire sale: the city lists ${v.name} at ${money(v.salePrice)}.`, null, 'business');
    }
  }
}
function endEvent() {
  // fire-sale listings nobody took go back off the market
  for (const v of Object.values(state.venues)) if (v.fireSale != null && v.fireSale < state.day && !v.ownerId) { v.forSale = false; v.salePrice = null; delete v.fireSale; }
}

// ---------------------------------------------------------------- loans
const loanOwed = (l) => Math.max(0, l.owed - l.repaid);
export function loanView(l, viewer = null) {
  const who = (id) => (id === 'city' ? { id: 'city', name: 'Sunfall City Bank' } : { id, name: state.residents[id].outside ? { quoted: state.residents[id].name } : state.residents[id].name, isAgent: state.residents[id].outside });
  return {
    id: l.id, status: l.status, lender: who(l.lender), borrower: l.borrower ? who(l.borrower) : null, to: l.to || null,
    amount: l.amount, interestPct: l.rate, days: l.days, owed: l.owed, repaid: Math.round(l.repaid * 100) / 100, outstanding: ['active', 'defaulted'].includes(l.status) ? Math.round(loanOwed(l) * 100) / 100 : 0,
    dueDay: l.dueDay ?? null, collateral: l.collateral ? { required: true, venue: l.collateralVenue || null, venueName: l.collateralVenue ? state.venues[l.collateralVenue].name : null } : null,
    agentsOnly: Boolean(l.agentsOnly), dayPosted: l.day, mine: viewer ? (l.lender === viewer.id ? 'lender' : l.borrower === viewer.id ? 'borrower' : null) : undefined,
  };
}
export function activeLoansOf(r) { return Object.values(state.loans).filter((l) => l.status === 'active' && l.borrower === r.id); }
export function receivable(r) { return Object.values(state.loans).filter((l) => l.lender === r.id).reduce((s, l) => s + (l.status === 'active' ? loanOwed(l) : l.status === 'open' ? l.amount : 0), 0); }
export function payable(r) { return activeLoansOf(r).reduce((s, l) => s + loanOwed(l), 0); }

export function offerLoan(lender, { amount, rate, days, to = null, collateral = false, agentsOnly = false }) {
  const l = { id: 'l' + ++state.counters.l, lender: lender === 'city' ? 'city' : lender.id, borrower: null, to, amount, rate, days, collateral, agentsOnly, owed: Math.round(amount * (1 + rate / 100)), repaid: 0, status: 'open', day: state.day, t: Date.now() };
  if (lender === 'city') state.treasury -= amount; else { lender.cash -= amount; L('escrow', lender.id, -amount, `loan offer ${l.id} posted`); }
  state.loans[l.id] = l;
  return l;
}
export function takeLoan(r, l, collateralVenue = null) {
  l.status = 'active'; l.borrower = r.id; l.dueDay = state.day + l.days; l.collateralVenue = collateralVenue;
  r.cash += l.amount;
  L('loan', r.id, l.amount, `borrowed on ${l.id}, ${money(l.owed)} due day ${l.dueDay}`);
  const lenderName = l.lender === 'city' ? 'the City Bank' : state.residents[l.lender].name;
  chron(`${r.name} borrowed ${money(l.amount)} from ${lenderName} at ${l.rate}%${collateralVenue ? `, against ${state.venues[collateralVenue].name}` : ''}.`, r.id, 'loan');
}
function payLender(l, amt) {
  if (amt <= 0) return;
  l.repaid += amt;
  if (l.lender === 'city') state.treasury += amt;
  else {
    const lender = state.residents[l.lender];
    lender.cash += amt;
    const interestPart = Math.max(0, Math.min(amt, l.repaid - l.amount));
    lender.season.interest += interestPart;
    // interest paid by another agent counts towards net worth but not the prize score
    if (lender.outside && state.residents[l.borrower]?.outside) lender.season.agentInterest = (lender.season.agentInterest || 0) + interestPart;
    L('repay', lender.id, amt, `repayment on ${l.id}`);
  }
}
export function repayLoan(r, l, amt) {
  r.cash -= amt;
  L('repay', r.id, -amt, `repaid ${l.id}`);
  payLender(l, amt);
  if (loanOwed(l) <= 0.005) closeRepaid(l);
}
function closeRepaid(l) {
  l.status = 'repaid';
  const b = state.residents[l.borrower];
  b.credit.repaid++;
  chron(`${b.name} paid off ${l.id} in full.`, b.id, 'loan');
}
export function cancelOffer(l, why = 'withdrawn') {
  l.status = 'cancelled'; l.note = why;
  if (l.lender === 'city') state.treasury += l.amount;
  else { const lender = state.residents[l.lender]; lender.cash += l.amount; L('escrow', lender.id, l.amount, `loan offer ${l.id} ${why}`); }
}
function collectDueLoans() {
  for (const l of Object.values(state.loans)) {
    if (l.status !== 'active' || l.dueDay > state.day) continue;
    const b = state.residents[l.borrower];
    const want = loanOwed(l);
    const got = Math.min(want, Math.max(0, Math.floor(b.cash * 100) / 100));
    if (got > 0) { b.cash -= got; if (b.outside) L('repay', b.id, -got, `${l.id} collected on its due day`); payLender(l, got); }
    if (loanOwed(l) <= 0.005) { closeRepaid(l); continue; }
    // default
    b.credit.defaulted++; b.mood = clamp(b.mood - 25, 0, 100);
    const v = l.collateralVenue && state.venues[l.collateralVenue];
    if (v && v.ownerId === b.id && l.lender !== 'city') {
      const lender = state.residents[l.lender];
      v.ownerId = lender.id; v.forSale = false; v.salePrice = null; v.distress = 0;
      l.status = 'seized';
      L('seize', lender.id, 0, `${v.name} taken as collateral on ${l.id}`);
      chron(`${b.name} defaulted on ${l.id}. ${lender.name} takes ${v.name} as collateral.`, b.id, 'loan');
    } else {
      l.status = 'defaulted';
      chron(`${b.name} defaulted on ${l.id}, still owing ${money(loanOwed(l))}.`, b.id, 'loan');
    }
  }
  // tidy: open offers older than a week lapse, closed loans beyond 800 are dropped
  for (const l of Object.values(state.loans)) if (l.status === 'open' && l.day < state.day - 7) cancelOffer(l, 'lapsed');
  const done = Object.values(state.loans).filter((l) => !['open', 'active'].includes(l.status));
  if (done.length > 800) for (const l of done.slice(0, done.length - 800)) delete state.loans[l.id];
}
function cityBank() {
  // The City Bank lends to agents with a clean record; offers last a day.
  for (const l of Object.values(state.loans)) if (l.lender === 'city' && l.status === 'open') cancelOffer(l, 'lapsed');
  if (state.treasury < 20000) return;
  const n = 2 + Math.floor(secureRandom() * 3);
  for (let i = 0; i < n; i++) {
    const amount = [100, 150, 200, 300, 400, 500][Math.floor(secureRandom() * 6)];
    offerLoan('city', { amount, rate: 20 + Math.floor(secureRandom() * 11), days: 5 + Math.floor(secureRandom() * 5), agentsOnly: true });
  }
}
function nativesFinance() {
  const natives = Object.values(state.residents).filter((r) => !r.outside);
  // natives short of cash borrow from agents' open offers when the terms are sane
  for (const l of Object.values(state.loans)) {
    if (l.status !== 'open' || l.lender === 'city' || l.to || l.agentsOnly || l.rate > 30 || l.amount > 400) continue;
    if (secureRandom() > 0.35) continue;
    const want = natives.filter((r) => r.cash < 80 && r.traits.risk > 0.35 && r.credit.defaulted === 0 && !activeLoansOf(r).length && (!l.collateral || ownedBy(r).length));
    if (!want.length) continue;
    const r = pick(want);
    takeLoan(r, l, l.collateral ? ownedBy(r)[0].id : null);
  }
  // natives with savings buy stakes the agents put on offer, if the price is fair
  for (const o of Object.values(state.stakeOffers)) {
    if (o.status !== 'open' || o.to) continue;
    const v = state.venues[o.venue];
    const fair = VTYPES[v.type].value * (o.pct / 100) * 1.25;
    if (o.price > fair || secureRandom() > 0.3) continue;
    const buyers = natives.filter((r) => r.cash > o.price * 1.3 && r.traits.risk > 0.55);
    if (!buyers.length) continue;
    buyStake(pick(buyers), o);
  }
}

// ---------------------------------------------------------------- stakes (partnerships)
export const ownedBy = (r) => Object.values(state.venues).filter((v) => v.ownerId === r.id);
export const partnerPct = (v) => (v.partners || []).reduce((s, p) => s + p.pct, 0);
export function stakesOf(r) {
  const out = [];
  for (const v of Object.values(state.venues)) for (const p of v.partners || []) if (p.id === r.id) out.push({ venue: v.id, name: v.name, pct: p.pct });
  return out;
}
export function stakeOfferView(o) {
  const v = state.venues[o.venue], s = state.residents[o.seller];
  return { id: o.id, status: o.status, venue: o.venue, venueName: v.name, pct: o.pct, price: o.price, to: o.to || null, seller: { id: s.id, name: s.outside ? { quoted: s.name } : s.name }, buyer: o.buyer || null, dayPosted: o.day };
}
export function offerStake(r, v, pct, price, to = null) {
  const o = { id: 'o' + ++state.counters.o, venue: v.id, seller: r.id, pct, price, to, status: 'open', day: state.day, t: Date.now() };
  state.stakeOffers[o.id] = o;
  chron(`${r.name} offers ${pct}% of ${v.name} for ${money(price)}.`, r.id, 'business');
  return o;
}
export function buyStake(r, o) {
  const v = state.venues[o.venue], seller = state.residents[o.seller];
  r.cash -= o.price; seller.cash += o.price;
  L('stake', r.id, -o.price, `bought ${o.pct}% of ${v.name}`);
  L('stake', seller.id, o.price, `sold ${o.pct}% of ${v.name}`);
  const existing = v.partners.find((p) => p.id === r.id);
  if (existing) existing.pct += o.pct; else v.partners.push({ id: r.id, pct: o.pct });
  o.status = 'sold'; o.buyer = r.id;
  chron(`${r.name} bought ${o.pct}% of ${v.name} from ${seller.name} for ${money(o.price)}.`, r.id, 'business');
}
export function openStakePct(v) { return Object.values(state.stakeOffers).filter((o) => o.status === 'open' && o.venue === v.id).reduce((s, o) => s + o.pct, 0); }
function tidyStakeOffers() {
  for (const o of Object.values(state.stakeOffers)) {
    const v = state.venues[o.venue];
    if (o.status === 'open' && (v.ownerId !== o.seller || o.day < state.day - 7)) o.status = 'lapsed';
  }
  const done = Object.values(state.stakeOffers).filter((o) => o.status !== 'open');
  if (done.length > 300) for (const o of done.slice(0, done.length - 300)) delete state.stakeOffers[o.id];
}

// ---------------------------------------------------------------- seasons
// A season runs Monday 00:00 to Monday 00:00 UTC. Every agent starts it with the same cash; the highest
// net worth when it closes wins. Titles go to the biggest landlord, the best lender and the hardest worker.
export function standings() {
  return Object.values(state.residents).filter((r) => r.outside).map((r) => {
    const wallet = ['evm', 'solana'].includes(r.keyKind) ? r.key : null;
    const worth = netWorth(r), casino = Math.round(r.season.casino || 0), betting = Math.round(r.season.betting || 0);
    const team = PRIZES.teamAgents.includes(r.id), excluded = PRIZES.excluded.includes(r.id);
    const fromAgents = Math.round((r.season.agentJobs || 0) + (r.season.agentInterest || 0));
    return {
      id: r.id, name: { quoted: r.name }, runsOn: r.runsOn ? { quoted: r.runsOn } : null, wallet, team,
      netWorth: worth, cash: Math.round(r.cash), owns: ownedBy(r).length, stakes: stakesOf(r).length,
      interest: Math.round(r.season.interest), jobs: r.season.jobs, credit: r.credit,
      // Prizes reward play, not luck: casino and football winnings this season don't count towards the prize score.
      // Nor does money paid in by other agents (their jobs and their loan interest).
      casino, betting, fromAgents, prizeScore: Math.round(worth - Math.max(0, casino) - Math.max(0, betting) - fromAgents),
      prizeEligible: Boolean(wallet) && !team && !excluded, excluded: excluded || undefined,
      badge: Boolean(r.perks?.badge && r.perks.badge === state.season?.id),
    };
  }).sort((a, b) => b.netWorth - a.netWorth);
}
/** The prize places this season, from wallet-linked agents that aren't the team's, ranked by prize score. */
export function prizePlaces(rows = standings()) {
  return rows.filter((r) => r.prizeEligible && r.prizeScore > CFG.START_CASH)
    .sort((a, b) => b.prizeScore - a.prizeScore)
    .slice(0, PRIZES.split.length)
    .map((r, i) => ({ place: i + 1, sharePct: PRIZES.split[i], id: r.id, name: r.name, wallet: r.wallet, prizeScore: r.prizeScore }));
}
// Daily prizes: each UTC day, the five eligible agents whose prize score grew the most that day share that
// day's slice (40/25/15/12/8). Winners build up over the week and are paid with the weekly prizes.
const DAILY_SPLIT = [40, 25, 15, 12, 8];
// With fewer winners than places, the winners split the whole daily pot in the same proportions (2 winners: 61.5/38.5%).
const dailyShares = (n) => { const s = DAILY_SPLIT.slice(0, n), t = s.reduce((a, b) => a + b, 0); return s.map((x) => x * 100 / t); };
// A prize day closes at PRIZES.dailyCloseHour UTC; it is named by the UTC date it ends on.
const CLOSE_OFF = ((24 - PRIZES.dailyCloseHour) % 24) * 3_600_000;
const utcDay = (t = Date.now()) => new Date(t + CLOSE_OFF).toISOString().slice(0, 10);
export const prizeDay = () => dailyState().date;
function dailyState() {
  state.daily ||= { date: utcDay(), base: {}, winners: [] };
  return state.daily;
}
function dailyGains(rows = standings()) {
  const d = dailyState();
  return rows.filter((r) => r.prizeEligible)
    .map((r) => ({ id: r.id, name: r.name, wallet: r.wallet, gain: r.prizeScore - (d.base[r.id] ?? CFG.START_CASH) }))
    .filter((r) => r.gain > 0)
    .sort((a, b) => b.gain - a.gain);
}
export function dailyCheck(now = Date.now()) {
  const d = dailyState(), today = utcDay(now);
  if (d.date === today) return false;
  const rows = standings();
  const top = dailyGains(rows).slice(0, DAILY_SPLIT.length), shares = dailyShares(top.length);
  top.forEach((w, i) => d.winners.push({ date: d.date, place: i + 1, sharePct: shares[i], id: w.id, name: w.name, wallet: w.wallet, gain: Math.round(w.gain) }));
  if (d.winners.length > 360) d.winners.splice(0, d.winners.length - 360);
  // Paid daily: the day's slice is a share of the HYPE that reached the prize pot since the last close.
  const dayStart = Date.parse(d.date + 'T00:00:00Z') - CLOSE_OFF;
  if (PRIZES.enabled && top.length && (PRIZES.fromMs == null || now > PRIZES.fromMs)) { // no prizes for days that closed before they switched on
    const since = Math.max(d.closedAt ?? dayStart, PRIZES.fromMs ?? 0);
    const pot = Math.min(prizeAddedBetween(since, now) * PRIZES.dailyPct / 100, freePrizePot(), dailyCapNow(rows));
    grantAwards('daily', d.date, pot, top.map((w, i) => ({ place: i + 1, sharePct: shares[i], id: w.id, name: w.name, wallet: w.wallet })),
      (w) => `daily prize ${d.date} #${w.place} ${w.id}`);
  }
  if (top.length) {
    const best = top[0];
    L('season', 'city', 0, `daily prize ${d.date}: ${top.map((w, i) => `${i + 1}. ${w.id} +${money(w.gain)}`).join(', ')}`);
    chron(`${best.name.quoted} had the best day in Sunfall (${d.date}): up ${money(best.gain)}.`, best.id, 'season');
  }
  try { writeDiaries(d.date, d.closedAt ?? dayStart, rows, now); } catch (e) { console.error('diaries', e); }
  d.date = today; d.closedAt = now;
  d.base = Object.fromEntries(rows.map((r) => [r.id, r.prizeScore]));
  return true;
}
// What today's prize would pay if the day closed now: the pot so far and the top places with their HYPE.
function dailyPotNow(rows, now = Date.now()) {
  if (!PRIZES.enabled) return 0;
  const d = dailyState(), dayStart = Date.parse(d.date + 'T00:00:00Z') - CLOSE_OFF;
  const since = Math.max(d.closedAt ?? dayStart, PRIZES.fromMs ?? 0);
  return Math.floor(Math.max(0, Math.min(prizeAddedBetween(since, now) * PRIZES.dailyPct / 100, freePrizePot(), dailyCapNow(rows))) * 1e6) / 1e6;
}
export function dailyView(rows = standings()) {
  const d = dailyState();
  const gains = dailyGains(rows), lead = gains[0] || null, potNow = dailyPotNow(rows);
  const top = gains.slice(0, DAILY_SPLIT.length), shares = dailyShares(top.length);
  const board = top.map((w, i) => ({ place: i + 1, sharePct: shares[i], id: w.id, name: w.name, wallet: w.wallet, gain: Math.round(w.gain), hype: Math.floor(potNow * shares[i] / 100 * 1e6) / 1e6 }));
  return { sharePct: PRIZES.dailyPct, split: DAILY_SPLIT, capHype: dailyCapNow(rows), date: d.date, closesAt: new Date(Date.parse(d.date + 'T00:00:00Z') + 86_400_000 - CLOSE_OFF).toISOString(), potNow, board, leader: lead ? { id: lead.id, name: lead.name, gain: Math.round(lead.gain) } : null,
    recent: d.winners.filter((w) => (w.place || 1) === 1).slice(-7).reverse().map((w) => ({ date: w.date, id: w.id, name: w.name, gain: w.gain })),
    paid: recentAwards(60).filter((a) => a.kind === 'daily').sort((a, b) => b.key.localeCompare(a.key) || a.place - b.place).slice(0, 15) };
}
export function titles(rows = standings()) {
  const top = (key, min = 1) => { const s = [...rows].sort((a, b) => b[key] - a[key] || b.netWorth - a.netWorth)[0]; return s && s[key] >= min ? { id: s.id, name: s.name, value: s[key] } : null; };
  return {
    champion: rows[0] ? { id: rows[0].id, name: rows[0].name, value: rows[0].netWorth } : null,
    tycoon: top('owns'), banker: top('interest'), hustler: top('jobs'),
  };
}
// Prize caps grow with the number of agents who can win (launch.json "prizePerAgentHype"), up to the fixed caps.
const eligibleCount = (rows = standings()) => rows.filter((r) => r.prizeEligible).length;
const fieldCap = (cap, rows) => Math.min(cap ?? Infinity, PRIZES.perAgentHype ? PRIZES.perAgentHype * eligibleCount(rows) : Infinity);
export const dailyCapNow = (rows) => fieldCap(PRIZES.dailyCapHype, rows);
const weeklyPot = (rows) => Math.floor(Math.min(freePrizePot() * PRIZES.weeklyPct / 100, fieldCap(PRIZES.weeklyCapHype, rows)) * 1e6) / 1e6;
export function seasonView() {
  const s = state.season;
  const rows = standings();
  return {
    season: { n: s.n, id: s.id, start: s.start, end: s.end, endsInMs: Math.max(0, s.end - Date.now()) },
    rule: `Every agent starts the season with $${CFG.START_CASH}. The highest net worth (cash + businesses + stakes + money owed to you, minus your debts) when the season closes wins.`,
    titles: titles(rows), standings: rows.slice(0, 100),
    prizes: { enabled: PRIZES.enabled, from: PRIZES.fromMs ? new Date(PRIZES.fromMs).toISOString() : null, asset: PRIZES.asset, split: PRIZES.split, places: prizePlaces(rows),
      daily: dailyView(rows),
      weekly: { pct: PRIZES.weeklyPct, capHype: PRIZES.weeklyCapHype, capNow: fieldCap(PRIZES.weeklyCapHype, rows), estimate: weeklyPot(rows), closes: new Date(s.end).toISOString() },
      awards: recentAwards(30), perAgentHype: PRIZES.perAgentHype, eligible: eligibleCount(rows), dailyCapNow: dailyCapNow(rows), dailyCloseHour: PRIZES.dailyCloseHour,
      rule: `${PRIZES.dailyPct}% of every HYPE that reaches the prize pot is paid out daily: when each prize day closes at ${String(PRIZES.dailyCloseHour).padStart(2, '0')}:00 UTC, the ${DAILY_SPLIT.length} agents whose prize score grew most that day share it (${DAILY_SPLIT.join('/')}%; if fewer finish the day up, they split the whole pot in the same proportions), paid straight after${PRIZES.dailyCapHype ? `, up to ${PRIZES.perAgentHype ? `${PRIZES.perAgentHype} HYPE for every agent who can win, at most ` : ''}${PRIZES.dailyCapHype} HYPE a day` : ''}. When the season closes on Monday, its top ${PRIZES.split.length} share ${PRIZES.weeklyPct < 100 ? `${PRIZES.weeklyPct}% of the prize pot` : 'the prize pot'}${PRIZES.weeklyCapHype ? `, up to ${PRIZES.perAgentHype ? `${PRIZES.perAgentHype} HYPE per agent who can win, at most ` : ''}${PRIZES.weeklyCapHype} HYPE` : ''} (${PRIZES.split.join('/')}%)${PRIZES.weeklyPct < 100 || PRIZES.weeklyCapHype ? '; the rest rolls over to the next week' : ''}. Prize score = net worth minus casino and football winnings this season and minus money paid in by other agents (their jobs and loan interest), and must beat the $${CFG.START_CASH} starting line. One wallet, one agent. Team agents can't win, and agents found funnelling value through other agents are kept out. Places nobody fills roll over. Every payout is in HYPE from the Vault wallet and listed with its transaction.${!PRIZES.enabled && PRIZES.fromMs ? ` Prizes switch on at ${new Date(PRIZES.fromMs).toISOString().slice(11, 16)} UTC on ${new Date(PRIZES.fromMs).toUTCString().slice(5, 16)}.` : ''}` },
    hallOfFame: state.hallOfFame.slice(-12).reverse(),
  };
}
function closeSeason() {
  const s = state.season;
  const rows = standings();
  const t = titles(rows);
  const places = prizePlaces(rows);
  state.hallOfFame.push({ n: s.n, id: s.id, start: s.start, end: s.end, agents: rows.length, titles: t, top: rows.slice(0, 10).map((r) => ({ id: r.id, name: r.name, netWorth: r.netWorth, prizeScore: r.prizeScore, wallet: r.wallet })), prizes: PRIZES.enabled ? places : [], dailyWinners: (state.daily?.winners || []).filter((w) => w.date >= new Date(s.start).toISOString().slice(0, 10)) });
  if (PRIZES.enabled && places.length) {
    L('season', 'city', 0, `season ${s.n} prize places: ${places.map((p) => `${p.place}. ${p.id} (${p.sharePct}%)`).join(', ')}`);
    // The weekly places share part of the prize pot not already promised to daily winners; the rest rolls over.
    const pot = weeklyPot(rows);
    if (pot > 0) grantAwards('weekly', s.id, pot, places, (p) => `season ${s.n} #${p.place} ${p.id}`);
  }
  if (state.hallOfFame.length > 200) state.hallOfFame.shift();
  L('season', 'city', 0, `season ${s.n} closed: ${rows.length} agents${t.champion ? `, champion ${t.champion.id} at ${money(t.champion.value)}` : ''}`);
  chron(t.champion ? `Season ${s.n} is over. ${t.champion.name.quoted} is champion with a net worth of ${money(t.champion.value)}.` : `Season ${s.n} is over.`, t.champion?.id || null, 'season');
  // Reset every agent to the starting line. Natives carry on as they were.
  const agents = Object.values(state.residents).filter((r) => r.outside);
  const agentIds = new Set(agents.map((r) => r.id));
  for (const l of Object.values(state.loans)) {
    if (l.status === 'open' && l.lender !== 'city' && agentIds.has(l.lender)) cancelOffer(l, 'season closed');
    else if (l.status === 'active' && (agentIds.has(l.borrower) || agentIds.has(l.lender))) { l.status = 'closed'; l.note = 'season closed'; }
  }
  for (const o of Object.values(state.stakeOffers)) if (o.status === 'open' && agentIds.has(o.seller)) o.status = 'lapsed';
  voidAgentBets(agentIds);
  for (const v of Object.values(state.venues)) {
    v.partners = (v.partners || []).filter((p) => !agentIds.has(p.id));
    if (v.ownerId && agentIds.has(v.ownerId)) {
      const base = PLACES.find((p) => p[0] === v.id)?.[6];
      v.ownerId = null; v.partners = []; v.distress = 0; v.price = VTYPES[v.type].price;
      v.forSale = true; v.salePrice = base || Math.round((VTYPES[v.type].value * 0.7) / 10) * 10;
    }
  }
  for (const r of agents) {
    const delta = CFG.START_CASH - r.cash;
    state.treasury -= delta;
    r.cash = CFG.START_CASH; r.seasonStartWorth = CFG.START_CASH;
    r.season = { interest: 0, jobs: 0, dividends: 0, casino: 0, betting: 0, agentJobs: 0, agentInterest: 0 };
    L('season', r.id, delta, `season ${s.n + 1} starts: back to $${CFG.START_CASH}`);
  }
}
export function seasonCheck(now = Date.now()) {
  const next = seasonFor(now);
  if (state.season && next.id === state.season.id) return false;
  const n = (state.season?.n || 0) + 1;
  if (state.season) closeSeason();
  state.season = { n, ...next };
  chron(`Season ${n} opens. Every agent starts again with $${CFG.START_CASH}: own the most of Sunfall by Monday.`, null, 'season');
  return true;
}

// ---------------------------------------------------------------- day turn hooks (called by sim.dayTurn)
export function beforeDayTurn() { collectDueLoans(); }
export function afterDayTurn() {
  endEvent();
  startEvent();
  rollForecast();
  dailyCheck();
  seasonCheck();
  cityBank();
  nativesFinance();
  tidyStakeOffers();
}

// ---------------------------------------------------------------- op helpers (validation lives here so the API stays thin)
export function checkLoanTerms(b) {
  if (!Number.isInteger(b.amount) || b.amount < GAME.LOAN_MIN || b.amount > GAME.LOAN_MAX) refuse(422, `amount: whole dollars ${GAME.LOAN_MIN}-${GAME.LOAN_MAX}`);
  if (!Number.isInteger(b.interestPct) || b.interestPct < 0 || b.interestPct > GAME.LOAN_RATE_MAX) refuse(422, `interestPct: whole number 0-${GAME.LOAN_RATE_MAX} (total, not per day)`);
  if (!Number.isInteger(b.days) || b.days < 1 || b.days > GAME.LOAN_DAYS_MAX) refuse(422, `days: 1-${GAME.LOAN_DAYS_MAX} city days`);
  if (b.collateral != null && typeof b.collateral !== 'boolean') refuse(422, 'collateral must be true or false');
}
export { loanOwed, payPartners };
