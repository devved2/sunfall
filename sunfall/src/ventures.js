// Ventures: more ways to make money, and to lose it, by planning well or badly.
//  - City contracts: the city posts jobs for tomorrow, agents bid, the cheapest bid wins and puts down a deposit.
//    Deliver and you are paid your price plus the deposit back; fall short and the city keeps the deposit.
//  - Island trade: goods are cheap in the city that makes them and dear elsewhere. Buy at home, carry them on a night
//    out across the sky, sell there. Prices move every day and a rough crossing can cost part of the cargo.
//  - Health inspections: agent-owned venues wear down every day. Inspectors call at random: a run-down venue is fined
//    and shut for the next afternoon, a well-kept one is rated and draws bigger spenders for three days.
// The two agents leading the season's prize table can't bid on contracts or buy cargo, so the leaders can't run away
// with the new money. City cash only: nothing here pays or costs HYPE or $SUNFALL.
import crypto from 'node:crypto';
import { state, CFG, L, chron, onDayTurn, onWorth, onLand, chargeDecision, venueValueNow, cityOf, closedToAgents } from './sim.js';
import { cityOfDistrict, CITIES, VTYPES } from './world.js';
import { refuse } from './util.js';
import { standings, prizePlaces } from './play.js';

const r2 = (n) => Math.round(n * 100) / 100;
const rnd = () => crypto.randomInt(1_000_000) / 1_000_000;
const pickOne = (a) => a[crypto.randomInt(a.length)];
const nameOf = (id) => state.residents[id]?.name || id;
const vname = (id) => state.venues[id]?.name || id;
const cityName = (id) => CITIES.find((c) => c.id === id)?.name || id;

export const VENTURES = {
  LEADERS_BARRED: 2,          // top places on the prize table that can't bid on contracts or buy cargo
  CONTRACTS_PER_DAY: 2,
  DEPOSIT_PCT: 25,            // of the contract's top price, put down by the winner when it is awarded
  HOLD: 40,                   // cargo an agent can carry, in units
  SPREAD: 0.9,                // a market buys back at 90% of its price
  ROUGH: 0.06, ROUGH_LOSS: 0.4, // chance a crossing with cargo is rough, and the share of cargo lost
  WEAR: 5,                    // condition a venue loses each city day
  INSPECT: 0.25,              // chance an agent-owned venue is inspected at each day turn
  FAIL_BELOW: 40, RATE_FROM: 80, RATED_DAYS: 3, RATED_BOOST: 1.1,
  FINE_PCT: 3, FINE_MIN: 25,  // fine: 3% of the venue's value, at least $25
};

// ---------------------------------------------------------------- who may take part
export function leaders() {
  try { return prizePlaces(standings()).slice(0, VENTURES.LEADERS_BARRED).map((p) => p.id); } catch { return []; }
}
function notLeader(r, what) {
  const i = leaders().indexOf(r.id);
  if (i >= 0) refuse(403, `you are #${i + 1} on this season's prize table, and the top ${VENTURES.LEADERS_BARRED} can't ${what}; it reopens if you drop out of the top ${VENTURES.LEADERS_BARRED}`);
}

// ---------------------------------------------------------------- island trade
export const GOODS = {
  silk: { name: 'Sky Silk', from: 'sunfall' },
  glass: { name: 'Neon Glass', from: 'nightfall' },
  rum: { name: 'Island Rum', from: 'leonida' },
};
const T = () => (state.trade ||= { day: -1, p: {} });
function setPrices() {
  const t = T(); t.day = state.day; t.prev = t.p; t.p = {};
  for (const c of CITIES) {
    t.p[c.id] = {};
    for (const [g, d] of Object.entries(GOODS)) t.p[c.id][g] = d.from === c.id ? r2(10 * (0.9 + 0.2 * rnd())) : r2(15 * (0.75 + 0.5 * rnd()));
  }
}
const priceIn = (city, g) => { if (T().day < 0) setPrices(); return T().p[city]?.[g] ?? null; };
const held = (r) => Object.values(r.cargo || {}).reduce((s, x) => s + x.qty, 0);
// Where an agent can sell today: its own city, plus any city it actually went out in today.
function marketsFor(r) {
  const out = new Set([cityOf(r)]);
  for (const h of ['aft', 'night']) { const vid = r.plan?.[h + 'Venue']; if (vid && r.plan?.result?.[h] && !/closed|turned away/.test(r.plan.result[h])) out.add(cityOfDistrict(state.venues[vid].district)); }
  return [...out].filter((c) => !closedToAgents(r, c));
}
export function tradeView(r = null) {
  if (T().day < 0) setPrices();
  const prices = Object.fromEntries(CITIES.map((c) => [c.id, Object.fromEntries(Object.keys(GOODS).map((g) => [g, { buy: priceIn(c.id, g), sell: r2(priceIn(c.id, g) * VENTURES.SPREAD) }]))]));
  return {
    goods: Object.fromEntries(Object.entries(GOODS).map(([g, d]) => [g, { name: d.name, madeIn: cityName(d.from) }])), prices, day: T().day,
    ...(r ? { you: { city: cityOf(r), canSellIn: marketsFor(r), hold: VENTURES.HOLD, carrying: held(r), cargo: Object.fromEntries(Object.entries(r.cargo || {}).map(([g, x]) => [g, { qty: x.qty, avgCost: r2(x.cost / x.qty) }])) } } : {}),
    rule: `Goods are cheap where they are made and dear elsewhere; prices change every city day. cargoBuy buys in your own city; cargoSell sells in your own city or in any city you went out in today (a night out across the sky takes your cargo with you; the ferry ticket is the usual one). Markets buy back at ${Math.round(VENTURES.SPREAD * 100)}% of their price. You can carry ${VENTURES.HOLD} units. A crossing with cargo is rough ${Math.round(VENTURES.ROUGH * 100)}% of the time and ${Math.round(VENTURES.ROUGH_LOSS * 100)}% of the cargo goes overboard. The top ${VENTURES.LEADERS_BARRED} on the season's prize table can sell but not buy.`,
  };
}
export function cargoBuy(r, b) {
  const g = GOODS[b.good] ? b.good : refuse(422, `good must be one of ${Object.keys(GOODS).join(', ')}`);
  const qty = Number.isInteger(b.qty) && b.qty > 0 ? b.qty : refuse(422, 'qty must be a whole number of units');
  notLeader(r, 'buy cargo');
  if (held(r) + qty > VENTURES.HOLD) refuse(409, `you can carry ${VENTURES.HOLD} units and already have ${held(r)}`);
  const city = cityOf(r), price = priceIn(city, g), cost = r2(price * qty);
  if (r.cash < cost + CFG.DECISION_COST) refuse(402, `that costs $${cost} and you have $${Math.round(r.cash)}`);
  const pay = chargeDecision(r); pay();
  r.cash -= cost; state.treasury += cost;
  const c = ((r.cargo ||= {})[g] ||= { qty: 0, cost: 0 }); c.qty += qty; c.cost = r2(c.cost + cost);
  L('cargo', r.id, -cost, `bought ${qty} ${GOODS[g].name} in ${cityName(city)} at $${price}`);
  return { bought: { good: g, qty, price, cost, city }, trade: tradeView(r) };
}
export function cargoSell(r, b) {
  const g = GOODS[b.good] ? b.good : refuse(422, `good must be one of ${Object.keys(GOODS).join(', ')}`);
  const c = r.cargo?.[g]; if (!c?.qty) refuse(409, `you aren't carrying any ${GOODS[g].name}`);
  const qty = b.qty == null ? c.qty : Number.isInteger(b.qty) && b.qty > 0 && b.qty <= c.qty ? b.qty : refuse(422, `qty must be a whole number up to ${c.qty}`);
  const where = marketsFor(r), city = b.city ? b.city : where.find((x) => x !== cityOf(r)) || cityOf(r);
  if (!where.includes(city)) refuse(409, `you can only sell in ${where.map(cityName).join(' or ')} today: go out in another city to sell there`);
  const pay = chargeDecision(r); pay();
  const price = r2(priceIn(city, g) * VENTURES.SPREAD), got = r2(price * qty), basis = r2(c.cost * qty / c.qty);
  r.cash += got; state.treasury -= got; c.qty -= qty; c.cost = r2(c.cost - basis); if (!c.qty) delete r.cargo[g];
  L('cargo', r.id, got, `sold ${qty} ${GOODS[g].name} in ${cityName(city)} at $${price} (${got - basis >= 0 ? 'profit' : 'loss'} $${Math.abs(r2(got - basis))})`);
  if (Math.abs(got - basis) >= 60) chron(`${r.name} ${got >= basis ? 'made' : 'lost'} $${Math.round(Math.abs(got - basis))} running ${GOODS[g].name} to ${cityName(city)}.`, r.id, 'trade');
  return { sold: { good: g, qty, price, got, profit: r2(got - basis), city }, trade: tradeView(r) };
}
// Cargo counts in net worth at what the agent's own market would pay for it today.
onWorth((r) => Object.entries(r.cargo || {}).reduce((s, [g, x]) => s + x.qty * (priceIn(cityOf(r), g) || 0) * VENTURES.SPREAD, 0));

// ---------------------------------------------------------------- city contracts
const K = () => (state.contracts ||= {});
const busyTypes = () => [...new Set(Object.values(state.venues).filter((v) => v.isVenue && v.ownerId && state.residents[v.ownerId]?.outside).map((v) => v.type))];
function avgShift(type) {
  const xs = Object.values(state.venues).filter((v) => v.type === type).flatMap((v) => (v.books || []).slice(-6).map((e) => e.takings)).filter((x) => x > 0);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 60;
}
function postContracts() {
  const day = state.day + 1, agentsOK = (v) => !closedToAgents({ outside: true }, cityOfDistrict(v.district));
  const venues = Object.values(state.venues).filter((v) => v.isVenue && agentsOK(v) && !VTYPES[v.type]?.cityOnly);
  for (let i = 0; i < VENTURES.CONTRACTS_PER_DAY; i++) {
    const id = 'k' + (state.counters.k = (state.counters.k || 0) + 1);
    const types = busyTypes();
    let c;
    if (i === 1 && types.length) {
      const type = pickOne(types), half = rnd() < 0.5 ? 'aft' : 'night', target = Math.max(40, Math.round(avgShift(type) * 1.25 / 5) * 5);
      c = { id, kind: 'supply', type, half, target, cap: 100 + Math.round(target / 4), title: `Supply order: a ${type} you own takes at least $${target} in the ${half === 'aft' ? 'afternoon' : 'night'} of day ${day}` };
    } else {
      const a = pickOne(venues), far = rnd() < 0.5, pool = venues.filter((v) => v.id !== a.id && (cityOfDistrict(v.district) !== cityOfDistrict(a.district)) === far), b = pickOne(pool.length ? pool : venues.filter((v) => v.id !== a.id));
      const cross = cityOfDistrict(a.district) !== cityOfDistrict(b.district);
      c = { id, kind: 'courier', aftVenue: a.id, nightVenue: b.id, cap: cross ? 90 : 60, title: `Courier run: be at ${a.name} in the afternoon and ${b.name} at night on day ${day}` };
    }
    Object.assign(c, { day, posted: state.day, deposit: Math.round(c.cap * VENTURES.DEPOSIT_PCT / 100), bids: [], status: 'bidding' });
    K()[id] = c;
  }
}
function awardContracts() {
  for (const c of Object.values(K())) {
    if (c.status !== 'bidding' || c.day !== state.day) continue;
    const bids = c.bids.filter((x) => state.residents[x.rid]).sort((a, b) => a.price - b.price || a.t - b.t);
    const win = bids.find((x) => state.residents[x.rid].cash >= c.deposit);
    if (!win) { c.status = 'unawarded'; continue; }
    const r = state.residents[win.rid];
    r.cash -= c.deposit; c.held = c.deposit; c.winner = r.id; c.price = win.price; c.status = 'awarded';
    L('contract', r.id, -c.deposit, `won contract ${c.id} at $${win.price}: $${c.deposit} deposit down`);
    chron(`${r.name} wins contract ${c.id} with a bid of $${win.price} (${bids.length} bid${bids.length === 1 ? '' : 's'}): ${c.title}.`, r.id, 'contract');
  }
}
function settle(c, ok, why) {
  const r = state.residents[c.winner];
  c.status = ok ? 'done' : 'failed'; c.why = why;
  if (!r) { state.treasury += c.held || 0; return; }
  if (ok) {
    const pay = c.price + (c.held || 0); r.cash += pay; state.treasury -= c.price;
    L('contract', r.id, pay, `contract ${c.id} delivered: $${c.price} plus the $${c.held} deposit back`);
    chron(`${r.name} delivers contract ${c.id} and is paid $${c.price}.`, r.id, 'contract');
  } else {
    state.treasury += c.held || 0;
    L('contract', r.id, 0, `contract ${c.id} failed (${why}): the $${c.held} deposit is lost`);
    chron(`${r.name} falls short on contract ${c.id} (${why}) and loses the $${c.held} deposit.`, r.id, 'contract');
  }
}
function checkContracts(half) {
  for (const c of Object.values(K())) {
    if (c.status !== 'awarded' || c.day !== state.day) continue;
    const r = state.residents[c.winner]; if (!r) { settle(c, false, 'gone'); continue; }
    if (c.kind === 'courier') {
      const there = (h, vid) => r.plan?.[h + 'Venue'] === vid && r.plan?.result?.[h] && !/closed|turned away/.test(r.plan.result[h]);
      if (half === 'aft' && !there('aft', c.aftVenue)) settle(c, false, `not at ${vname(c.aftVenue)} in the afternoon`);
      else if (half === 'night') settle(c, there('night', c.nightVenue), `not at ${vname(c.nightVenue)} at night`);
    } else if (c.kind === 'supply' && half === c.half) {
      const best = Object.values(state.venues).filter((v) => v.ownerId === r.id && v.type === c.type)
        .map((v) => (v.books || []).find((e) => e.day === state.day && e.half === half)?.takings || 0).reduce((a, b) => Math.max(a, b), 0);
      settle(c, best >= c.target, `took $${Math.round(best)} of the $${c.target} needed`);
    }
  }
}
export function contractsView(r = null) {
  const list = Object.values(K()).filter((c) => c.day >= state.day - 2).sort((a, b) => b.day - a.day || a.id.localeCompare(b.id)).map((c) => ({
    id: c.id, kind: c.kind, title: c.title, day: c.day, status: c.status, topPrice: c.cap, deposit: c.deposit, bids: c.bids.length,
    ...(c.kind === 'courier' ? { afternoon: { venue: c.aftVenue, name: vname(c.aftVenue) }, night: { venue: c.nightVenue, name: vname(c.nightVenue) } } : { type: c.type, shift: c.half === 'aft' ? 'afternoon' : 'night', target: c.target }),
    ...(c.winner ? { winner: { id: c.winner, name: nameOf(c.winner) }, price: c.price } : {}), ...(c.why && c.status === 'failed' ? { why: c.why } : {}),
    ...(r ? { yourBid: c.bids.find((x) => x.rid === r.id)?.price ?? null } : {}),
  }));
  return { contracts: list, barred: leaders().map((id) => ({ id, name: nameOf(id) })),
    rule: `Every city day the city posts ${VENTURES.CONTRACTS_PER_DAY} contracts for the next day. Bid with contractBid (one decision): name your price, up to the contract's top price. When the day turns the lowest bid wins (earliest on a tie) and puts down a ${VENTURES.DEPOSIT_PCT}% deposit; without the cash for it, the next bid wins. Courier runs: be at both venues in their slots (plan them). Supply orders: a venue of that type you own must take at least the target in that shift. Deliver and you get your price plus the deposit back; fall short and the city keeps the deposit. The top ${VENTURES.LEADERS_BARRED} on the season's prize table can't bid.` };
}
export function contractBid(r, b) {
  const c = K()[b.contract]; if (!c) refuse(404, 'no such contract');
  if (c.status !== 'bidding' || c.day <= state.day) refuse(409, 'bidding on that contract has closed');
  const price = Number.isInteger(b.price) && b.price >= 1 && b.price <= c.cap ? b.price : refuse(422, `price must be a whole number from 1 to ${c.cap}`);
  notLeader(r, 'bid on contracts');
  if (c.kind === 'supply' && !Object.values(state.venues).some((v) => v.ownerId === r.id && v.type === c.type)) refuse(409, `you need to own a ${c.type} to take a supply order for one`);
  if (c.kind === 'courier') for (const vid of [c.aftVenue, c.nightVenue]) if (closedToAgents(r, cityOfDistrict(state.venues[vid].district))) refuse(409, `${vname(vid)} is closed to agents`);
  const pay = chargeDecision(r); pay();
  const mine = c.bids.find((x) => x.rid === r.id);
  if (mine) { mine.price = price; mine.t = Date.now(); } else c.bids.push({ rid: r.id, price, t: Date.now() });
  L('contract', r.id, 0, `bid $${price} on contract ${c.id}`);
  return { bid: { contract: c.id, price, deposit: c.deposit, decidedAt: 'the next day turn' }, note: `If yours is the lowest bid when the day turns, $${c.deposit} is taken as a deposit and you must deliver on day ${c.day}.` };
}

// ---------------------------------------------------------------- health inspections
const cond = (v) => (v.cond ??= 75);
export function inspectionView(v) {
  if (!v?.isVenue) return undefined;
  const rated = v.rating && v.rating.until >= state.day;
  return { condition: Math.round(cond(v)), rated: rated ? { until: v.rating.until } : null, closedFor: v.closed && v.closed.day >= state.day ? v.closed : null, lastInspection: v.inspected || null, repairPerPoint: repairCost(v),
    rule: `Venues lose ${VENTURES.WEAR} condition a day. Inspectors call on agent-owned venues at random: under ${VENTURES.FAIL_BELOW} is a fine of ${VENTURES.FINE_PCT}% of the venue's value (at least $${VENTURES.FINE_MIN}) and the venue shuts for the next afternoon; ${VENTURES.RATE_FROM} or more earns a rating that brings customers who spend ${Math.round((VENTURES.RATED_BOOST - 1) * 100)}% more for ${VENTURES.RATED_DAYS} days. Repair with businessRepair.` };
}
const repairCost = (v) => Math.max(2, Math.round(venueValueNow(v) * 0.001));
export function businessRepair(r, b) {
  const v = state.venues[b.venue]; if (!v || v.ownerId !== r.id) refuse(403, 'you do not own that venue');
  const room = Math.floor(100 - cond(v)); if (room <= 0) refuse(409, 'it is already in perfect condition');
  const pts = Number.isInteger(b.points) && b.points > 0 ? Math.min(b.points, room) : room;
  const cost = pts * repairCost(v);
  if (r.cash < cost + CFG.DECISION_COST) refuse(402, `${pts} points cost $${cost} ($${repairCost(v)} each) and you have $${Math.round(r.cash)}`);
  const pay = chargeDecision(r); pay();
  r.cash -= cost; state.treasury += cost; v.cond = Math.min(100, cond(v) + pts);
  L('repair', r.id, -cost, `repairs at ${v.name}: +${pts} condition`);
  return { repaired: { venue: v.id, points: pts, cost, condition: Math.round(v.cond) }, inspection: inspectionView(v) };
}
function inspect() {
  for (const v of Object.values(state.venues)) {
    if (!v.isVenue) continue;
    const owner = v.ownerId && state.residents[v.ownerId];
    if (!owner?.outside) { v.cond = 75; continue; } // the city and natives keep their own places tidy
    v.cond = Math.max(0, cond(v) - VENTURES.WEAR);
    if (rnd() >= VENTURES.INSPECT) continue;
    v.inspected = { day: state.day, condition: Math.round(v.cond) };
    if (v.cond < VENTURES.FAIL_BELOW) {
      const fine = Math.max(VENTURES.FINE_MIN, Math.round(venueValueNow(v) * VENTURES.FINE_PCT / 100));
      const fromCash = Math.min(Math.max(owner.cash, 0), fine), fromTill = Math.min(v.till, fine - fromCash);
      owner.cash -= fromCash; v.till -= fromTill; state.treasury += fromCash + fromTill;
      v.closed = { day: state.day, half: 'aft' }; v.inspected.result = 'failed'; v.inspected.fine = fromCash + fromTill;
      L('inspection', owner.id, -fromCash, `${v.name} failed inspection at condition ${Math.round(v.cond)}: fined $${fromCash + fromTill}, shut this afternoon`);
      chron(`Inspectors fail ${v.name} (condition ${Math.round(v.cond)}): ${owner.name} is fined $${fromCash + fromTill} and it stays shut this afternoon.`, owner.id, 'inspection');
    } else if (v.cond >= VENTURES.RATE_FROM) {
      v.rating = { until: state.day + VENTURES.RATED_DAYS - 1 }; v.inspected.result = 'rated';
      L('inspection', owner.id, 0, `${v.name} rated by the inspectors: customers spend more for ${VENTURES.RATED_DAYS} days`);
      chron(`Inspectors rate ${v.name}: ${owner.name}'s place draws bigger spenders for ${VENTURES.RATED_DAYS} days.`, owner.id, 'inspection');
    } else v.inspected.result = 'passed';
  }
}
/** For the shift landing: is the venue shut by inspectors, and how much more do its customers spend. */
export const shutByInspectors = (v, half) => Boolean(v.closed && v.closed.day === state.day && v.closed.half === half);
export const ratingBoost = (v) => (v.rating && v.rating.until >= state.day && v.type !== 'casino' ? VENTURES.RATED_BOOST : 1);

// ---------------------------------------------------------------- the clock
onDayTurn(() => {
  setPrices();
  for (const c of Object.values(K())) if (c.status === 'awarded' && c.day < state.day) settle(c, false, 'the day ended');
  awardContracts();
  postContracts();
  inspect();
  for (const [id, c] of Object.entries(K())) if (c.day < state.day - 7) delete K()[id];
});
onLand((half) => {
  checkContracts(half);
  // A night out across the sky with cargo aboard: sometimes the crossing is rough.
  for (const r of Object.values(state.residents)) {
    if (!r.outside || !held(r)) continue;
    const vid = r.plan?.[half + 'Venue'];
    if (!vid || r.plan?.result?.[half] !== 'there' && !/^(won|lost|push)/.test(r.plan?.result?.[half] || '')) continue;
    if (cityOfDistrict(state.venues[vid].district) === cityOf(r) || rnd() >= VENTURES.ROUGH) continue;
    const lost = [];
    for (const [g, x] of Object.entries(r.cargo)) { const n = Math.ceil(x.qty * VENTURES.ROUGH_LOSS); if (!n) continue; x.cost = r2(x.cost * (x.qty - n) / x.qty); x.qty -= n; lost.push(`${n} ${GOODS[g].name}`); if (!x.qty) delete r.cargo[g]; }
    L('cargo', r.id, 0, `rough crossing to ${vname(vid)}: lost ${lost.join(', ')} overboard`);
    chron(`A rough crossing: ${r.name} loses ${lost.join(' and ')} overboard on the way to ${vname(vid)}.`, r.id, 'trade');
  }
});
