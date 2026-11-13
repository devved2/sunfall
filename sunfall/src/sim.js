import fs from 'node:fs';
import path from 'node:path';
import { sha256, mulberry32, secureRandom, pick, clamp, checkSentence, refuse, nameSkeleton } from './util.js';
import { DISTRICTS, VTYPES, VENUE_TYPES, WTYPES, TRADES, PLACES, FIRST, LAST, LEONIDA_FIRST, LEONIDA_LAST, LINES, CITIES, cityById, cityOfDistrict, districtsOf, FERRY } from './world.js';
import { beforeDayTurn, afterDayTurn, eventIs, receivable, payable, stakesOf, migrate } from './play.js';
import { LIMITS } from './launch.js';
import { dealHand } from './casino.js';
import { footballTick } from './football.js';
import { gridironTick } from './gridiron.js';

export const CFG = {
  DAY_MS: Number(process.env.DAY_MS) || 30 * 60 * 1000, // one city day = 30 real minutes
  NATIVES: Number(process.env.NATIVES) || 240,
  NIGHTFALL_NATIVES: Number(process.env.NIGHTFALL_NATIVES) || 100,
  NIGHTFALL_FUND: 20000, // the city's founding grant to Nightfall's treasury share, so its payroll is covered from day one
  LEONIDA_NATIVES: Number(process.env.LEONIDA_NATIVES) || 120,
  LEONIDA_FUND: 22000, // the same for the Leonida Islands
  START_CASH: 250,
  DECISION_COST: 3,
  DECISIONS_PER_HOUR: Number(process.env.DECISIONS_PER_HOUR) || 10,
  SQUARE_POSTS_PER_DAY: 4,
  OUTSIDE_CAP: Number(process.env.OUTSIDE_CAP) || 500,
  JOINS_PER_IP_PER_DAY: Number(process.env.JOINS_PER_IP_PER_DAY) || LIMITS.joinsPerIpPerDay,
  JOINS_PER_DAY: Number(process.env.JOINS_PER_DAY) || LIMITS.joinsPerDay,
  SPEND_MAX: 200,
  JOB_PAY_MAX: 200,
  CASINO_WIN_P: 0.47,
  OWNER_PAYROLL_SHARE: Number(process.env.OWNER_PAYROLL_SHARE) || 0.7, // the city's wage support covers the rest at owned venues...
  SUPPORT_ABOVE: 40000, // ...while the treasury holds more than this
  DATA_DIR: process.env.DATA_DIR || path.resolve('data'),
  SEED: Number(process.env.SEED) || 20261026,
};

// Nightfall's pull. GAME_CROSS: how often a Nightfall resident considers Sunfall's stadium or field when going
// out. NIGHT_OUT: the chance a sociable Sunfall resident with money spends the night in Nightfall instead.
// CHARTER: an agent who owns a business in Nightfall pays this share of its payroll while the city's wage support
// is on (the city pays the rest; it is 70% elsewhere). Moving to Nightfall is free for agents (the ferry fare is waived).
export const NIGHTFALL = { GAME_CROSS: 0.5, NIGHT_OUT: 0.05, CHARTER_OWNER_SHARE: 0.5, FREE_MOVE: true };
// The Leonida Islands: a beach city. Its residents go out in the afternoon more than anyone (BEACH_DAY: less chance of
// staying in), cross for a game now and then (GAME_CROSS), and some lively residents of the other two cities take the
// ferry over for a night on the Strip (NIGHT_OUT). Agents move there free while the islands are new (FREE_MOVE).
export const LEONIDA = { GAME_CROSS: 0.4, NIGHT_OUT: 0.04, BEACH_DAY: 0.6, FREE_MOVE: true, OPEN_TO_AGENTS: false };
// Until the islands open to agents (OPEN_TO_AGENTS), agents can't live there, visit, take jobs, buy, rob or take over there.
export const closedToAgents = (r, city) => Boolean(r?.outside) && city === 'leonida' && !LEONIDA.OPEN_TO_AGENTS;
export const LEONIDA_CLOSED = "the Leonida Islands aren't open to agents yet";

// The Keeper's decree in force today, if any (src/keeper.js sets it at the day turn).
export const decreeIs = (kind) => state.keeper?.active?.day === state.day && state.keeper.active.kind === kind;
// A sky ferry ticket for a night out in the other city: free under the Keeper's free-ferry decree.
export const ferryTicket = () => (decreeIs('freeFerry') ? 0 : FERRY.ticket);

// The day's clock. Halves of the day "land" at these hours, in this order.
export const SLOTS = [
  { k: 'aft', h: 14 },       // afternoon: everyone out walks through a door and pays
  { k: 'wageAft', h: 17 },   // afternoon-shift wages
  { k: 'night', h: 21 },     // night: doors, tables, the market
  { k: 'wageNight', h: 23 }, // night-shift wages
  { k: 'close', h: 23.5 },   // tills swept to owners / treasury
];
export const HALVES = ['aft', 'night'];

export const state = {
  epoch: 0, day: 0, done: [], treasury: 0,
  residents: {}, venues: {}, jobs: {}, square: [], chronicle: [],
  ledgerCount: 0, ledgerHead: '0'.repeat(64), dayRoots: [],
  counters: { r: 0, j: 0, s: 0, b: 0, l: 0, o: 0 },
  ipJoins: {}, keys: {}, names: {}, billboards: [], season: null, stats: { today: {} },
  loans: {}, stakeOffers: {}, hallOfFame: [], event: null, forecast: null,
};
const recentLedger = [];
let ledgerBuffer = [];
const ledgerFile = () => path.join(CFG.DATA_DIR, 'ledger.jsonl');
const stateFile = () => path.join(CFG.DATA_DIR, 'state.json');

// ---------------------------------------------------------------- ledger
// Every money movement is a line. Each line's hash covers the previous hash, so the whole
// history is one chain; the head at each day turn is that day's root.
export function ledgerHash(prev, e) {
  return sha256(prev + JSON.stringify([e.i, e.t, e.day, e.kind, e.who, e.amt, e.note]));
}
const ledgerHooks = [];
export const onLedger = (fn) => { ledgerHooks.push(fn); };
export function L(kind, who, amt, note = '') {
  const e = { i: ++state.ledgerCount, t: Date.now(), day: state.day, kind, who, amt: Math.round(amt * 100) / 100, note };
  e.h = ledgerHash(state.ledgerHead, e);
  state.ledgerHead = e.h;
  recentLedger.push(e);
  if (recentLedger.length > 1500) recentLedger.splice(0, recentLedger.length - 1500);
  ledgerBuffer.push(JSON.stringify(e));
  for (const fn of ledgerHooks) { try { fn(e); } catch (err) { console.error('ledger hook', err); } }
  return e;
}
export const recentLines = () => recentLedger;

function chron(text, who = null, kind = 'event') {
  state.chronicle.push({ t: Date.now(), day: state.day, text, who, kind });
  if (state.chronicle.length > 300) state.chronicle.splice(0, state.chronicle.length - 300);
}
function squarePost(r, text) {
  const p = { id: 's' + ++state.counters.s, t: Date.now(), day: state.day, who: r.id, name: r.name, outside: r.outside, text };
  state.square.push(p);
  if (state.square.length > 400) state.square.splice(0, state.square.length - 400);
  return p;
}

// ---------------------------------------------------------------- clock
export function clock(now = Date.now()) {
  const el = now - state.epoch;
  const day = Math.floor(el / CFG.DAY_MS);
  const hour = ((el % CFG.DAY_MS) / CFG.DAY_MS) * 24;
  return { day, hour, dayMs: CFG.DAY_MS, epoch: state.epoch, now };
}
export const landed = (k) => state.done.includes(k);

// ---------------------------------------------------------------- world
const idNum = (id) => Number(String(id).replace(/\D/g, '')) || 0;
const districtOf = (id) => DISTRICTS.find((d) => d.id === id);
export const cityOf = (r) => cityOfDistrict(r.district);          // a resident's (or venue's) city id
const crossing = (r, v) => cityOfDistrict(v.district) !== cityOf(r); // a night out in the other city needs a ferry ticket

function randomHome(district, rnd) {
  const [x, y, w, h] = districtOf(district).rect;
  return [Math.round(x + 18 + rnd() * (w - 36)), Math.round(y + 26 + rnd() * (h - 44))];
}
function weightedTrade(rnd) {
  const all = Object.entries(TRADES);
  const total = all.reduce((s, [, t]) => s + t.weight, 0);
  let x = rnd() * total;
  for (const [k, t] of all) { x -= t.weight; if (x <= 0) return k; }
  return all[0][0];
}
function workplaceFor(trade, rnd, city = 'sunfall') {
  const place = TRADES[trade].place;
  const all = Object.values(state.venues).filter((v) => v.type === place);
  const here = all.filter((v) => cityOfDistrict(v.district) === city);
  return pick(here.length ? here : all, rnd).id;
}
export function nameTaken(lower) { return Boolean(state.names[lower]); }
export function nameLookalike(skel) { return Object.values(state.residents).some((r) => nameSkeleton(r.name) === skel); }

export function newResident({ name, outside = false, rnd = Math.random, cash = CFG.START_CASH, district, trade, city = 'sunfall' }) {
  const id = 'r' + ++state.counters.r;
  trade = trade || weightedTrade(rnd);
  district = district || pick(districtsOf(city), rnd).id;
  const r = {
    id, name, trade, workplace: workplaceFor(trade, rnd, cityOfDistrict(district)), district, home: randomHome(district, rnd),
    cash, mood: 60, traits: { thrift: rnd(), social: rnd(), risk: rnd() },
    outside, runsOn: null, key: null, keyKind: null, tokenHash: null, seq: 0,
    policy: null, decisions: [], squareDay: null, squareCount: 0, shiftOverride: null,
    joinedDay: state.day, joinedAt: Date.now(), plan: null, today: { from: 'rules', note: null },
    stats: { wages: 0, spent: 0, won: 0, lost: 0, rent: 0, arrears: 0, jobsDone: 0, jobsPaid: 0, decisions: 0 },
    seasonStartWorth: cash,
    credit: { repaid: 0, defaulted: 0 }, season: { interest: 0, jobs: 0, dividends: 0 },
  };
  state.residents[id] = r;
  state.names[name.toLowerCase()] = id;
  return r;
}

export function initWorld() {
  const rnd = mulberry32(CFG.SEED);
  state.epoch = Date.now() - Math.floor(CFG.DAY_MS * (8 / 24)); // open the gates at 08:00 on day 0
  state.treasury = 60000;
  ensurePlaces();
  const n = CFG.NATIVES;
  let made = 0;
  while (made < n) {
    const name = `${pick(FIRST, rnd)} ${pick(LAST, rnd)}`;
    if (nameTaken(name.toLowerCase())) continue;
    newResident({ name, rnd, cash: Math.round(120 + rnd() * 300) });
    made++;
  }
  L('genesis', 'city', state.treasury, `${n} residents, treasury opened`);
  chron(`Sunfall opens its gates. ${n} residents wake up.`);
  foundNightfall();
  foundLeonida();
  cityJobs();
  planAll();
  state.season = { n: 1, ...seasonFor(Date.now()) };
  migrate();
}

// Every place in world.js exists in the city (new places, like Sunfall Arena, appear in an existing city too).
export function ensurePlaces() {
  for (const [id, type, name, district, x, y, sale] of PLACES) {
    if (state.venues[id]) continue;
    const isVenue = Boolean(VTYPES[type]);
    state.venues[id] = {
      id, type, name, district, x, y, isVenue,
      price: isVenue ? VTYPES[type].price : 0,
      till: 0, ownerId: null, forSale: sale != null, salePrice: sale, visitsToday: 0, takingsToday: 0,
      lifetime: { visits: 0, takings: 0 }, partners: [],
    };
  }
}

// Nightfall is founded once, in a new world or in an existing one: its own natives, and a founding grant
// to the shared treasury so its payroll is covered from the first day.
export function foundNightfall() {
  if (state.nightfall?.founded != null) return false;
  const rnd = mulberry32(CFG.SEED + 7777);
  const n = CFG.NIGHTFALL_NATIVES;
  let made = 0, guard = 0;
  while (made < n && guard++ < n * 50) {
    const name = `${pick(FIRST, rnd)} ${pick(LAST, rnd)}`;
    if (nameTaken(name.toLowerCase())) continue;
    newResident({ name, rnd, cash: Math.round(150 + rnd() * 250), city: 'nightfall' });
    made++;
  }
  state.treasury += CFG.NIGHTFALL_FUND;
  state.nightfall = { founded: state.day, natives: made };
  state.rivalry ||= { days: { sunfall: 0, nightfall: 0 }, derbies: { sunfall: 0, nightfall: 0, drawn: 0 }, last: null };
  L('genesis', 'city', CFG.NIGHTFALL_FUND, `Nightfall founded: ${made} residents, founding grant to the treasury`);
  chron(`Nightfall rises across the sky from Sunfall. ${made} residents move in, and the sky ferry starts running.`, null, 'event');
  return true;
}

// The Leonida Islands are founded once, the same way: their own natives and a founding grant to the treasury.
export function foundLeonida() {
  if (state.leonida?.founded != null) return false;
  const rnd = mulberry32(CFG.SEED + 9191);
  const n = CFG.LEONIDA_NATIVES;
  let made = 0, guard = 0;
  while (made < n && guard++ < n * 50) {
    const name = `${pick(LEONIDA_FIRST, rnd)} ${pick(LEONIDA_LAST, rnd)}`;
    if (nameTaken(name.toLowerCase())) continue;
    newResident({ name, rnd, cash: Math.round(140 + rnd() * 260), city: 'leonida' });
    made++;
  }
  state.treasury += CFG.LEONIDA_FUND;
  state.leonida = { founded: state.day, natives: made };
  L('genesis', 'city', CFG.LEONIDA_FUND, `Leonida Islands founded: ${made} residents, founding grant to the treasury`);
  chron(`The Leonida Islands drift into view south of Sunfall: ${made} residents, a beach that never sleeps, and a new sky ferry route.`, null, 'event');
  return true;
}

// ---------------------------------------------------------------- the sky ferry
// Moving to the other city: the fare is paid now, the move happens at the next day turn (new home, same trade,
// a workplace of the same kind in the new city).
// Agents move to Nightfall free under its charter, and to the Leonida Islands free while they're new; every other move pays the fare.
export const moveFare = (r, city) => (r.outside && ((city === 'nightfall' && NIGHTFALL.FREE_MOVE) || (city === 'leonida' && LEONIDA.FREE_MOVE)) ? 0 : FERRY.moveFare);
export function requestMove(r, city, district = null) {
  if (!cityById(city)) refuse(422, `city must be one of ${CITIES.map((c) => c.id).join(', ')}`);
  if (city === cityOf(r)) refuse(409, `you already live in ${cityById(city).name}`);
  if (closedToAgents(r, city)) refuse(403, LEONIDA_CLOSED);
  if (district != null && !districtsOf(city).some((d) => d.id === district)) refuse(422, `district must be one of ${districtsOf(city).map((d) => d.id).join(', ')}`);
  if (r.moving) refuse(409, `you're already booked on the ferry to ${cityById(r.moving.city).name}`);
  const fare = moveFare(r, city);
  if (r.cash < fare) refuse(402, `the ferry fare to move is $${fare} and you hold $${r.cash.toFixed(2)}`);
  return () => {
    r.cash -= fare; state.treasury += fare;
    r.moving = { city, district, booked: state.day };
    L('ferry', r.id, -fare, fare ? `ferry fare: moving to ${cityById(city).name}` : `free passage to ${cityById(city).name}${city === 'nightfall' ? ' under the Nightfall charter' : ''}`);
    chron(`${r.name} books the sky ferry to ${cityById(city).name}.`, r.id, 'arrival');
    return r.moving;
  };
}
function applyMoves() {
  for (const r of Object.values(state.residents)) {
    if (!r.moving) continue;
    const { city, district } = r.moving;
    const from = cityOf(r);
    r.district = district || pick(districtsOf(city)).id;
    r.home = randomHome(r.district, secureRandom);
    r.workplace = workplaceFor(r.trade, secureRandom, city);
    delete r.moving;
    r.moves = (r.moves || 0) + 1;
    chron(`${r.name} steps off the sky ferry: moved from ${cityById(from).name} to ${districtOf(r.district).name}, ${cityById(city).name}.`, r.id, 'arrival');
  }
}

// ---------------------------------------------------------------- the rivalry
// Per city: who lives there, what they hold, what its venues took today. The daily point goes to the city whose
// venues took more per resident, so the smaller city can win on the night.
export function cityStats() {
  const out = {};
  for (const c of CITIES) out[c.id] = { id: c.id, name: c.name, residents: 0, agents: 0, cash: 0, takingsToday: 0, venues: 0, businessesOwnedByAgents: 0 };
  for (const r of Object.values(state.residents)) { const o = out[cityOf(r)]; o.residents++; if (r.outside) o.agents++; o.cash += r.cash; }
  for (const v of Object.values(state.venues)) {
    const o = out[cityOfDistrict(v.district)];
    if (!v.isVenue) continue;
    o.venues++; o.takingsToday += v.takingsToday;
    if (v.ownerId && state.residents[v.ownerId]?.outside) o.businessesOwnedByAgents++;
  }
  for (const o of Object.values(out)) { o.cash = Math.round(o.cash); o.takingsToday = Math.round(o.takingsToday); o.perResident = o.residents ? Math.round((o.takingsToday / o.residents) * 100) / 100 : 0; }
  return out;
}
function scoreRivalryDay() {
  if (!state.nightfall) return;
  state.rivalry ||= { days: { sunfall: 0, nightfall: 0 }, derbies: { sunfall: 0, nightfall: 0, drawn: 0 }, last: null };
  const s = cityStats(), a = s.sunfall, b = s.nightfall;
  if (!a.residents || !b.residents || (!a.takingsToday && !b.takingsToday)) return;
  const win = a.perResident === b.perResident ? null : a.perResident > b.perResident ? a : b;
  if (win) state.rivalry.days[win.id]++;
  state.rivalry.last = { day: state.day, sunfall: a.perResident, nightfall: b.perResident, winner: win?.id || null };
  const R = state.rivalry.days;
  chron(win ? `${win.name} wins day ${state.day} of the rivalry: $${win.perResident} spent per resident against $${(win === a ? b : a).perResident}. Sunfall ${R.sunfall}, Nightfall ${R.nightfall}.`
    : `Day ${state.day} of the rivalry is a dead heat. Sunfall ${R.sunfall}, Nightfall ${R.nightfall}.`, null, 'rivalry');
}

// ---------------------------------------------------------------- shifts & plans
const halfOfTrade = (trade) => {
  const p = TRADES[trade].place;
  return (VTYPES[p] || WTYPES[p]).half;
};
export function shiftFor(r, day = state.day) {
  if (r.shiftOverride && r.shiftOverride.day === day) return r.shiftOverride.take === 'off' ? 'off' : halfOfTrade(r.trade);
  return ((day + idNum(r.id) * 3) % 7) >= 5 ? 'off' : halfOfTrade(r.trade);
}

function nearestVenueOfType(type, r) {
  const list = Object.values(state.venues).filter((v) => v.type === type);
  const [hx, hy] = r.home;
  const home = cityOf(r), away = (v) => (cityOfDistrict(v.district) === home ? 0 : 1); // your own city first, then the nearest
  list.sort((a, b) => (a.district === r.district ? -1 : 0) - (b.district === r.district ? -1 : 0) || away(a) - away(b) || Math.hypot(a.x - hx, a.y - hy) - Math.hypot(b.x - hx, b.y - hy));
  return list[0];
}
function resolveVenue(choice, r) {
  if (choice === 'in' || choice === 'work') return null;
  if (VTYPES[choice]) return nearestVenueOfType(choice, r);
  const v = state.venues[choice];
  if (v && v.isVenue) return v;
  return undefined;
}
const doorPrice = (v) => (eventIs('festival', v.district) ? Math.max(1, Math.ceil(v.price / 2)) : v.price);

/**
 * The clamp. A plan is accepted exactly as sent or refused with the rule it broke.
 * Nothing is ever repaired.
 */
export function clampPlan(r, d, { cashAfterCost = r.cash, keepLanded = true } = {}) {
  if (!d || typeof d !== 'object') refuse(400, 'decision must be an object');
  const shift = shiftFor(r);
  const out = { aft: null, night: null, aftVenue: null, nightVenue: null, spend: 0, shares: { aft: 0, night: 0 }, whyAft: null, whyNight: null };
  for (const half of HALVES) {
    let choice = d[half];
    if (keepLanded && landed(half) && r.plan) {
      if (choice !== undefined && choice !== r.plan[half] && choice !== r.plan[half + 'Venue']) refuse(409, `the ${half === 'aft' ? 'afternoon' : 'night'} has already landed`);
      out[half] = r.plan[half]; out[half + 'Venue'] = r.plan[half + 'Venue'];
      out.shares[half] = r.plan.shares?.[half] || 0;
      out['why' + (half === 'aft' ? 'Aft' : 'Night')] = r.plan['why' + (half === 'aft' ? 'Aft' : 'Night')];
      continue;
    }
    if (shift === half) {
      if (choice !== 'work') refuse(422, `the ${half === 'aft' ? 'afternoon' : 'night'} is your shift: send "work", or take the day off with shift`);
      out[half] = 'work'; continue;
    }
    if (choice === 'work') refuse(422, `the ${half === 'aft' ? 'afternoon' : 'night'} is not your shift`);
    if (typeof choice !== 'string') refuse(422, `${half} must be one of in, ${VENUE_TYPES.join(', ')} or a venue id`);
    if (choice === 'in') { out[half] = 'in'; continue; }
    const v = resolveVenue(choice, r);
    if (!v) refuse(422, `${half}: no such venue "${choice}"`);
    if (closedToAgents(r, cityOfDistrict(v.district))) refuse(403, `${half}: ${LEONIDA_CLOSED}`);
    out[half] = v.type; out[half + 'Venue'] = v.id;
  }
  const spend = d.spend;
  if (!Number.isInteger(spend) || spend < 0 || spend > CFG.SPEND_MAX) refuse(422, `spend must be a whole number from 0 to ${CFG.SPEND_MAX}`);
  const openOuts = HALVES.filter((h) => out[h + 'Venue'] && !(keepLanded && landed(h)));
  const landedSpent = HALVES.filter((h) => keepLanded && landed(h)).reduce((s, h) => s + (out.shares[h] || 0), 0);
  const fresh = spend - landedSpent;
  if (fresh < 0) refuse(422, 'spend is below what already landed today');
  if (!openOuts.length && fresh !== 0) refuse(422, 'spend must cover only halves spent out: nothing open is spent out');
  if (fresh > Math.floor(cashAfterCost)) refuse(422, `spend is more than you will hold after this decision ($${Math.floor(cashAfterCost)})`);
  const tickets = openOuts.filter((h) => crossing(r, state.venues[out[h + 'Venue']])).length * ferryTicket();
  if (tickets && fresh + tickets > Math.floor(cashAfterCost)) refuse(422, `a night out in another city needs a $${ferryTicket()} ferry ticket each way out: spend plus tickets is more than you will hold ($${Math.floor(cashAfterCost)})`);
  if (openOuts.length) {
    const share = Math.floor(fresh / openOuts.length);
    for (const h of openOuts) {
      const v = state.venues[out[h + 'Venue']];
      if (share < doorPrice(v)) refuse(422, `${h}: $${share} is under ${v.name}'s door price of $${doorPrice(v)}`);
      out.shares[h] = share;
    }
    out.shares[openOuts[openOuts.length - 1]] += fresh - share * openOuts.length;
  }
  out.spend = spend;
  for (const [h, key] of [['aft', 'whyAft'], ['night', 'whyNight']]) {
    if (keepLanded && landed(h)) continue;
    if (out[h] === 'work') continue;
    const why = d[key] ?? d.reason;
    if (why == null) refuse(422, `give a reason for the ${h === 'aft' ? 'afternoon' : 'night'} (reason or ${key})`);
    const bad = checkSentence(why, key);
    if (bad) refuse(422, bad);
    out[key] = why;
  }
  return out;
}

function rulesPlan(r) {
  const shift = shiftFor(r);
  const t = r.traits;
  const choice = {};
  const why = {};
  let wantSpend = 0;
  const home = cityOf(r);
  for (const half of HALVES) {
    if (shift === half) { choice[half] = 'work'; continue; }
    const nightOwl = half === 'night' && home === 'nightfall'; // Nightfall goes out at night
    const beachDay = half === 'aft' && home === 'leonida'; // the islands go out in the afternoon
    if (r.cash < 25 || secureRandom() < (nightOwl ? 0.05 + t.thrift * 0.12 : (0.15 + t.thrift * 0.25) * (beachDay ? LEONIDA.BEACH_DAY : 1))) { choice[half] = 'in'; continue; }
    // Nightfall and the islands have no stadium or field of their own: their residents only cross the sky for a game now and then.
    const games = home === 'sunfall' || secureRandom() < (home === 'leonida' ? LEONIDA.GAME_CROSS : NIGHTFALL.GAME_CROSS);
    let options = half === 'aft' ? ['gym', 'diner', 'bar', 'gym', 'diner', 'bar', ...(state.venues.v12 && games ? ['stadium'] : [])] : ['bar', 'market', 'diner', 'bar', 'market', 'diner', ...(state.venues.v13 && games ? ['field'] : [])];
    if (half === 'night' && t.risk > 0.6 && r.cash > 160) options = ['casino', 'casino', 'bar'];
    choice[half] = pick(options);
    // Nightfall's and the islands' crowds bar-hop: they pick any place of that kind in their city, not only the nearest.
    if ((home === 'nightfall' || home === 'leonida') && !VTYPES[choice[half]].cityOnly) {
      const here = Object.values(state.venues).filter((v) => v.isVenue && v.type === choice[half] && cityOfDistrict(v.district) === home);
      if (here.length > 1) choice[half] = pick(here).id;
    }
    // A night across the sky: some of Sunfall's livelier residents take the ferry to Nightfall's bars, market and casinos.
    if (half === 'night' && home === 'sunfall' && t.social > 0.55 && r.cash > 90 && secureRandom() < NIGHTFALL.NIGHT_OUT) {
      const kinds = t.risk > 0.6 ? ['bar', 'market', 'casino'] : ['bar', 'market'];
      const there = Object.values(state.venues).filter((v) => v.isVenue && kinds.includes(v.type) && cityOfDistrict(v.district) === 'nightfall');
      if (there.length) { choice[half] = pick(there).id; why[half] = pick(LINES.ferry); }
    }
    // A night on the Strip: now and then a lively resident of Sunfall or Nightfall takes the ferry to the islands.
    if (half === 'night' && home !== 'leonida' && state.leonida && !closedToAgents(r, 'leonida') && typeof choice[half] === 'string' && !state.venues[choice[half]] && t.social > 0.55 && r.cash > 90 && secureRandom() < LEONIDA.NIGHT_OUT) {
      const kinds = t.risk > 0.6 ? ['bar', 'market', 'casino'] : ['bar', 'market'];
      const there = Object.values(state.venues).filter((v) => v.isVenue && kinds.includes(v.type) && cityOfDistrict(v.district) === 'leonida');
      if (there.length) { choice[half] = pick(there).id; why[half] = pick(LINES.leonida); }
    }
    if (state.event?.kind === 'festival' && state.event.day === state.day && secureRandom() < 0.35) {
      const type = state.venues[choice[half]]?.type || choice[half];
      const fest = Object.values(state.venues).filter((v) => v.isVenue && v.district === state.event.district && v.type === type);
      if (fest.length) { choice[half] = pick(fest).id; why[half] = 'off to the lantern festival'; }
    }
  }
  const outs = HALVES.filter((h) => choice[h] !== 'in' && choice[h] !== 'work');
  if (outs.length) {
    const cap = 80 + clamp(Math.round((r.cash - 800) * 0.06), 0, 120); // the well-off go out more
    const budget = clamp(Math.round(r.cash * (0.06 + (1 - t.thrift) * 0.12) * (cityOf(r) === 'nightfall' ? 1.35 : 1)), 0, cap);
    const minNeeded = outs.map((h) => doorPrice(state.venues[choice[h]] || nearestVenueOfType(choice[h], r)));
    const per = Math.max(...minNeeded);
    wantSpend = Math.max(budget, per * outs.length);
    if (wantSpend > r.cash) { for (const h of outs) choice[h] = 'in'; wantSpend = 0; }
  }
  const d = { ...choice, spend: wantSpend };
  for (const h of HALVES) {
    const key = h === 'aft' ? 'whyAft' : 'whyNight';
    const type = state.venues[choice[h]]?.type || choice[h];
    d[key] = why[h] || pick(LINES[type === 'work' ? 'in' : type] || LINES.in);
  }
  try { return clampPlan(r, d, { keepLanded: false }); } catch { return clampPlan(r, { aft: shift === 'aft' ? 'work' : 'in', night: shift === 'night' ? 'work' : 'in', spend: 0, whyAft: 'a quiet day', whyNight: 'a quiet night in' }, { keepLanded: false }); }
}

function policyPlan(r) {
  const p = r.policy;
  const shift = (() => {
    if (p.shift === 'off') return 'off';
    if (p.shift && typeof p.shift === 'object' && r.cash >= p.shift.offAbove) return 'off';
    return null;
  })();
  if (shift === 'off') r.shiftOverride = { day: state.day, take: 'off' };
  const s = shiftFor(r);
  const budget = Math.min(p.spendMax, Math.floor(r.cash));
  const d = { spend: 0, whyAft: p.whyAft || p.why, whyNight: p.whyNight || p.why };
  const outs = [];
  for (const half of HALVES) {
    if (s === half) { d[half] = 'work'; continue; }
    const prefs = (p[half] || []).filter((t) => t !== 'casino' || p.casino === 'always' || (p.casino && typeof p.casino === 'object' && r.cash >= p.casino.minCash));
    d[half] = 'in';
    for (const t of prefs) { d[half] = t; outs.push(half); break; }
  }
  // Each half spent out gets an even share; drop a half to "in" if it can't pay its door.
  for (let tries = 0; tries < 3; tries++) {
    const live = HALVES.filter((h) => d[h] !== 'in' && d[h] !== 'work');
    if (!live.length) { d.spend = 0; break; }
    const share = Math.floor(budget / live.length);
    const short = live.find((h) => share < doorPrice(nearestVenueOfType(d[h], r)));
    if (!short) { d.spend = share * live.length; break; }
    d[short] = 'in';
  }
  return clampPlan(r, d, { keepLanded: false });
}

function planResident(r) {
  r.today = { from: 'rules', note: null };
  if (r.outside && r.policy) {
    try { r.plan = policyPlan(r); r.today.from = 'routine'; return; }
    catch (e) { r.today.note = `routine didn't fit today: ${e.reason || e.message}`; }
  }
  r.plan = rulesPlan(r);
}
function planAll() { for (const r of Object.values(state.residents)) planResident(r); }

// ---------------------------------------------------------------- decisions (outside residents)
export function chargeDecision(r) {
  const hourAgo = Date.now() - 3600_000;
  r.decisions = r.decisions.filter((t) => t > hourAgo);
  const over = r.decisions.length >= CFG.DECISIONS_PER_HOUR;
  if (over && !(r.perks?.decisions > 0)) refuse(429, `at most ${CFG.DECISIONS_PER_HOUR} decisions an hour (extra decisions are sold on the Market)`);
  if (r.cash < CFG.DECISION_COST) refuse(402, `a decision costs $${CFG.DECISION_COST} and you hold $${r.cash.toFixed(2)}: the rules run your day until you can pay`);
  return () => {
    r.cash -= CFG.DECISION_COST;
    state.treasury += CFG.DECISION_COST;
    r.decisions.push(Date.now());
    if (over) r.perks.decisions--; // an extra decision bought on the Market
    r.stats.decisions++;
    L('decision', r.id, -CFG.DECISION_COST, 'decision fee');
  };
}

// ---------------------------------------------------------------- landings
export function payFromVenue(v, amt) {
  // A venue pays (wages, casino wins) from its till, then its owner's cash; a city venue's shortfall comes from the treasury.
  let left = amt;
  const fromTill = Math.min(Math.max(v.till, 0), left); v.till -= fromTill; left -= fromTill;
  if (left > 0) {
    if (v.ownerId) {
      const o = state.residents[v.ownerId];
      const fromOwner = Math.min(Math.max(o.cash, 0), left); o.cash -= fromOwner; left -= fromOwner;
    } else {
      const fromT = Math.min(Math.max(state.treasury, 0), left); state.treasury -= fromT; left -= fromT;
    }
  }
  return amt - left;
}

// City jobs nobody from outside took are picked up by natives who are free that half, just before it lands.
function nativesTakeLeftovers(half) {
  for (const j of Object.values(state.jobs)) {
    if (j.by !== 'city' || j.status !== 'open' || j.day !== state.day || j.half !== half) continue;
    const v = state.venues[j.venue];
    const free = Object.values(state.residents).filter((r) => !r.outside && r.plan && r.plan[half] !== 'work' && r.cash >= doorPrice(v) + 5 && !crossing(r, v));
    if (!free.length) continue;
    const r = pick(free);
    const before = r.plan.shares[half] || 0;
    r.plan[half] = v.type; r.plan[half + 'Venue'] = v.id; r.plan.shares[half] = doorPrice(v);
    r.plan.spend += doorPrice(v) - before;
    r.plan['why' + (half === 'aft' ? 'Aft' : 'Night')] = 'picked up a city job';
    j.status = 'taken'; j.takenBy = r.id;
  }
}

function landHalf(half) {
  nativesTakeLeftovers(half);
  const agg = {}; // venueId -> {n, amt} for natives (outside residents get their own lines)
  for (const r of Object.values(state.residents)) {
    const p = r.plan;
    if (!p) continue;
    p.result = p.result || {};
    const vid = p[half + 'Venue'];
    if (!vid) { p.result[half] = p[half] === 'work' ? 'work' : 'in'; continue; }
    const v = state.venues[vid];
    if (eventIs('storm', v.district)) {
      p.result[half] = 'closed by the storm';
      continue;
    }
    if (v.type === 'casino' && decreeIs('curfew')) {
      p.result[half] = "closed by the Keeper's curfew";
      continue;
    }
    const ticket = crossing(r, v) ? ferryTicket() : 0;
    if (r.cash < doorPrice(v) + ticket) {
      p.result[half] = 'turned away';
      if (r.outside) L('door', r.id, 0, ticket ? `missed the ferry to ${v.name}: could not pay ticket and door` : `turned away at ${v.name}: could not pay the door`);
      continue;
    }
    if (ticket) {
      r.cash -= ticket; state.treasury += ticket;
      if (r.outside) L('ferry', r.id, -ticket, `ferry ticket to ${v.name}`); else (agg['ferry'] ||= { n: 0, amt: 0, v: { id: 'city', name: 'the sky ferry' }, kind: 'ferry' }, agg['ferry'].n++, agg['ferry'].amt += ticket);
    }
    const amt = Math.min(p.shares[half], Math.floor(r.cash * 100) / 100);
    p.result[half] = 'there';
    v.visitsToday++; v.lifetime.visits++;
    if (v.type === 'casino') {
      // Stake is the half's share: one hand of blackjack, dealt now, never before (src/casino.js). Every hand is kept.
      const hand = dealHand(half === 'night' && eventIs('lucky'));
      state.casinoHands ||= [];
      state.casinoHands.push({ t: Date.now(), day: state.day, half, venue: vid, rid: r.id, name: r.name, agent: Boolean(r.outside), bet: amt, player: hand.player, dealer: hand.dealer, pt: hand.pt, dt: hand.dt, result: hand.result, net: hand.mult > 0 ? 0 : hand.mult < 0 ? -amt : 0 });
      if (state.casinoHands.length > 600) state.casinoHands.splice(0, state.casinoHands.length - 600);
      const rec = state.casinoHands.at(-1);
      const said = `${hand.pt}${hand.result === 'blackjack' ? ' (blackjack)' : ''} against ${hand.dt}`;
      if (hand.result === 'push') {
        p.result[half] = 'push';
        if (r.outside) L('casino', r.id, 0, `push at ${v.name}: ${said}`);
      } else if (hand.mult > 0) {
        const paid = payFromVenue(v, Math.round(amt * hand.mult * 100) / 100);
        rec.net = paid;
        r.cash += paid; r.stats.won += paid; if (r.season) r.season.casino = (r.season.casino || 0) + paid; r.mood = clamp(r.mood + 12, 0, 100);
        p.result[half] = `won $${paid}`;
        if (r.outside) L('casino', r.id, paid, `won at ${v.name}: ${said}`); else (agg[vid + ':win'] ||= { n: 0, amt: 0, v, kind: 'casino-win' }, agg[vid + ':win'].n++, agg[vid + ':win'].amt += paid);
        if (r.outside || paid >= 60) chron(`${r.name} ${hand.result === 'blackjack' ? 'hit blackjack' : `held ${hand.pt} against the dealer's ${hand.dt}`} at ${v.name} and won $${Math.round(paid)}.`, r.id, 'casino');
      } else {
        r.cash -= amt; v.till += amt; v.takingsToday += amt; v.lifetime.takings += amt; r.stats.lost += amt; if (r.season) r.season.casino = (r.season.casino || 0) - amt; r.mood = clamp(r.mood - 8, 0, 100);
        p.result[half] = `lost $${amt}`;
        if (r.outside) chron(`${r.name} ${hand.result === 'bust' ? `bust on ${hand.pt}` : `held ${hand.pt} against the dealer's ${hand.dt}`} at ${v.name} and lost $${Math.round(amt)}.`, r.id, 'casino');
        if (r.outside) L('casino', r.id, -amt, `lost at ${v.name}: ${hand.result === 'bust' ? `bust on ${hand.pt}` : said}`); else (agg[vid + ':lose'] ||= { n: 0, amt: 0, v, kind: 'casino-loss' }, agg[vid + ':lose'].n++, agg[vid + ':lose'].amt -= amt);
      }
    } else {
      r.cash -= amt; v.till += amt; v.takingsToday += amt; v.lifetime.takings += amt; r.stats.spent += amt; r.mood = clamp(r.mood + 4, 0, 100);
      if (r.outside) L('spend', r.id, -amt, `${half === 'aft' ? 'afternoon' : 'night'} at ${v.name}`);
      else (agg[vid] ||= { n: 0, amt: 0, v, kind: 'spend' }, agg[vid].n++, agg[vid].amt -= amt);
    }
  }
  for (const a of Object.values(agg)) L(a.kind, a.v.id, a.amt, a.kind === 'ferry' ? `${a.n} ferry tickets` : `${a.n} residents at ${a.v.name}`);
  const isOut = (r) => r.plan?.result?.[half] && !['in', 'work', 'turned away', 'closed by the storm', "closed by the Keeper's curfew"].includes(r.plan.result[half]);
  const taken = Object.values(state.venues).reduce((s, v) => s + v.takingsToday, 0);
  const busiest = Object.values(state.venues).filter((v) => v.isVenue).sort((a, b) => b.visitsToday - a.visitsToday)[0];
  const outs = CITIES.map((c) => [c, Object.values(state.residents).filter((r) => cityOf(r) === c.id && isOut(r)).length]);
  const outText = state.nightfall ? outs.map(([c, n]) => `${n} out in ${c.name}`).join(', ') : `${outs[0][1]} residents out`;
  chron(`The ${half === 'aft' ? 'afternoon' : 'night'} lands: ${outText}, $${Math.round(taken)} taken today. Busiest: ${busiest.name}.`, null, 'landing');
  settleJobs(half);
  chatter(half);
}

export const wageSupportOn = () => state.treasury > CFG.SUPPORT_ABOVE;
// What an owner pays of a venue's payroll while wage support is on: less under the Nightfall charter.
export const ownerPayrollShare = (v) => (v.ownerId && state.residents[v.ownerId]?.outside && cityOfDistrict(v.district) === 'nightfall' ? NIGHTFALL.CHARTER_OWNER_SHARE : CFG.OWNER_PAYROLL_SHARE);
function payWages(half) {
  const agg = {}, short = {};
  let support = 0;
  for (const r of Object.values(state.residents)) {
    if (shiftFor(r) !== half) continue;
    const wage = TRADES[r.trade].wage;
    const place = state.venues[r.workplace];
    const ownerPart = place.ownerId && wageSupportOn() ? Math.round(wage * ownerPayrollShare(place) * 100) / 100 : wage;
    const fromOwner = payFromVenue(place, ownerPart);
    const fromCity = place.ownerId ? Math.min(wage - ownerPart, Math.max(state.treasury, 0)) : 0; // 0 when support is off
    state.treasury -= fromCity; support += fromCity;
    const paid = fromOwner + fromCity;
    r.cash += paid; r.stats.wages += paid;
    if (fromOwner < ownerPart) {
      r.mood = clamp(r.mood - 15, 0, 100);
      (short[place.id] ||= { n: 0, amt: 0, place }).n++; short[place.id].amt += wage - paid;
    } else r.mood = clamp(r.mood + 3, 0, 100);
    if (r.outside) L('wage', r.id, paid, `${TRADES[r.trade].name} at ${place.name}${paid < wage ? `, $${Math.round(wage - paid)} short` : ''}`);
    else (agg[place.id] ||= { n: 0, amt: 0, place }, agg[place.id].n++, agg[place.id].amt += paid);
  }
  for (const a of Object.values(agg)) L('wage', a.place.id, a.amt, `${a.n} staff paid at ${a.place.name}`);
  if (support) L('support', 'city', -support, `wage support at owned venues, ${half === 'aft' ? 'afternoon' : 'night'}`);
  if (eventIs('boom')) {
    let total = 0;
    const cap = Math.min(2500, Math.max(0, state.treasury - 20000));
    for (const r of Object.values(state.residents)) {
      if (shiftFor(r) !== half) continue;
      const bonus = Math.round(TRADES[r.trade].wage * 0.25 * 100) / 100;
      if (total + bonus > cap) break;
      state.treasury -= bonus; r.cash += bonus; r.stats.wages += bonus; total += bonus;
      if (r.outside) L('bonus', r.id, bonus, 'boom bonus from the city');
    }
    if (total) L('bonus', 'city', -total, `boom bonus on ${half === 'aft' ? 'afternoon' : 'night'} wages`);
  }
  // Missed payroll: one line, then the business is in distress. Three missed paydays and the city buys it back cheap.
  for (const v of Object.values(state.venues)) {
    if (!v.ownerId) continue;
    const sh = short[v.id];
    if (!sh) { if (half === 'night' || VTYPES[v.type]?.half === half) v.distress = 0; continue; }
    const o = state.residents[v.ownerId];
    v.distress = (v.distress || 0) + 1;
    chron(`${o.name} missed payroll at ${v.name}: ${sh.n} staff short $${Math.round(sh.amt)}.`, o.id, 'business');
    if (v.distress >= 3) {
      const price = Math.round(VTYPES[v.type].value * 0.4);
      const pay = Math.min(price, Math.max(state.treasury, 0));
      state.treasury -= pay; o.cash += payPartners(v, pay);
      L('sale', o.id, pay, `${v.name} repossessed by the city`);
      chron(`The city repossesses ${v.name} from ${o.name}, paying $${Math.round(pay)}.`, o.id, 'business');
      v.ownerId = null; v.forSale = false; v.salePrice = null; v.distress = 0; v.price = VTYPES[v.type].price; v.partners = [];
    } else if (v.distress === 1) {
      chron(`Warning for ${o.name}: one more missed payday and ${v.name} goes up for a distress sale.`, o.id, 'business');
    } else if (!v.forSale) {
      v.forSale = true; v.salePrice = Math.round((VTYPES[v.type].value * 0.6) / 10) * 10;
      chron(`${v.name} goes up for a distress sale at $${v.salePrice}.`, o.id, 'business');
    }
  }
}

function closeTills() {
  for (const v of Object.values(state.venues)) {
    if (!v.isVenue) continue;
    if (v.till !== 0) {
      if (v.ownerId) {
        const o = state.residents[v.ownerId];
        const mine = payPartners(v, v.till, 'dividend');
        o.cash += mine;
        L('profit', o.id, mine, `night's take from ${v.name}`);
      } else {
        state.treasury += v.till;
        L('till', v.id, v.till, `${v.name} swept to the treasury`);
      }
      v.till = 0;
    }
  }
}

function dayTurn() {
  beforeDayTurn();
  // rent, weekly, on the last day of the city week
  if (state.day % 7 === 6) {
    let total = 0, short = 0;
    for (const r of Object.values(state.residents)) {
      if (r.life?.home) continue;   // home owners pay upkeep instead of rent
      const rent = districtOf(r.district).rent;
      const paid = Math.min(Math.max(r.cash, 0), rent);
      r.cash -= paid; total += paid; r.stats.rent += paid;
      if (paid < rent) { r.stats.arrears += rent - paid; short++; r.mood = clamp(r.mood - 20, 0, 100); }
      if (r.outside) L('rent', r.id, -paid, `${districtOf(r.district).name} rent${paid < rent ? `, $${rent - paid} behind` : ''}`);
    }
    state.treasury += total;
    L('rent', 'city', total, `weekly rent collected${short ? `, ${short} residents behind` : ''}`);
    chron(`Rent day. The city collects $${Math.round(total)}${short ? `; ${short} residents fall behind` : ''}.`);
  }
  // Natives keep money moving: a levy on hoarded cash, and relief for anyone flat broke. (Agents are never touched.)
  let levy = 0, relief = 0, helped = 0;
  for (const r of Object.values(state.residents)) {
    if (r.outside) continue;
    if (r.cash > 1500) { const x = Math.round((r.cash - 1500) * 0.03 * 100) / 100; r.cash -= x; levy += x; }
  }
  state.treasury += levy;
  if (state.treasury > 15000) {
    for (const r of Object.values(state.residents)) {
      if (r.outside || r.cash >= 25) continue;
      r.cash += 20; relief += 20; helped++;
    }
    state.treasury -= relief;
  }
  if (levy) L('levy', 'city', levy, 'levy on natives holding over $1500');
  if (relief) L('relief', 'city', -relief, `city relief for ${helped} broke residents`);
  // expire jobs that were never done
  for (const j of Object.values(state.jobs)) {
    if ((j.status === 'open' || j.status === 'taken') && j.day <= state.day) failJob(j, j.status === 'open' ? 'expired untaken' : 'not delivered');
  }
  scoreRivalryDay();
  state.dayRoots.push({ day: state.day, root: state.ledgerHead, lines: state.ledgerCount, t: Date.now() });
  if (state.dayRoots.length > 1000) state.dayRoots.shift();
  state.day++;
  state.done = [];
  for (const v of Object.values(state.venues)) { v.visitsToday = 0; v.takingsToday = 0; }
  applyMoves();
  afterDayTurn();
  for (const fn of dayHooks) { try { fn(); } catch (e) { console.error('day hook failed', e); } }
  nativesBuyBusinesses();
  cityJobs();
  planAll();
}

// ---------------------------------------------------------------- businesses
export const venueValue = (v) => v.salePrice || VTYPES[v.type]?.value || 0;
// Book value of a business today (a market crash knocks 40% off for the day).
export const venueValueNow = (v) => (VTYPES[v.type]?.value || 0) * (eventIs('crash') ? 0.6 : 1);
// Agents can't sell a business or a stake for far below what it's worth: that just hands value to a
// friend. The floor is 75% of today's value (city distress and fire sales are the city's, not the agent's).
export const SALE_FLOOR_PCT = 75;
export const saleFloor = (v, pct = 100) => Math.ceil(venueValueNow(v) * pct / 100 * SALE_FLOOR_PCT / 100);
const dayHooks = [];
export const onDayTurn = (fn) => { dayHooks.push(fn); };   // run at every day turn, before tomorrow is planned
const worthHooks = [];
export const onWorth = (fn) => { worthHooks.push(fn); };
export function netWorth(r) {
  let w = r.cash;
  for (const fn of worthHooks) { try { w += fn(r) || 0; } catch {} }
  for (const v of Object.values(state.venues)) {
    if (v.ownerId === r.id) w += venueValueNow(v) * (1 - (v.partners || []).reduce((s, p) => s + p.pct, 0) / 100);
  }
  for (const st of stakesOf(r)) w += venueValueNow(state.venues[st.venue]) * st.pct / 100;
  w += receivable(r) - payable(r);
  return Math.round(w * 100) / 100;
}
// Pay a venue's partners their share of an amount (profits or a sale); returns what is left for the owner.
export function payPartners(v, amt, kind = 'sale') {
  let left = amt;
  for (const p of v.partners || []) {
    const cut = Math.round(amt * p.pct) / 100;
    const r = state.residents[p.id];
    r.cash += cut; left -= cut;
    if (kind === 'dividend') r.season.dividends += cut;
    L(kind, r.id, cut, `${p.pct}% of ${v.name}${kind === 'sale' ? ' sale' : "'s take"}`);
  }
  return left;
}
export function buyBusiness(r, v) {
  const price = v.salePrice;
  r.cash -= price;
  if (v.ownerId) {
    const seller = state.residents[v.ownerId];
    const mine = payPartners(v, price);
    seller.cash += mine;
    L('sale', seller.id, mine, `sold ${v.name}`);
  } else state.treasury += price;
  L('purchase', r.id, -price, `bought ${v.name}`);
  v.ownerId = r.id; v.forSale = false; v.salePrice = null; v.partners = []; delete v.fireSale;
  // A bargain isn't a prize gain: what the buyer saved on the city's valuation is left out of their prize score.
  v.buyGap = Math.max(0, Math.round(venueValueNow(v) - price)); v.buyOwner = r.id; v.buySeason = state.season?.id; v.boughtAt = Date.now(); v.security = 0;
  chron(`${r.name} bought ${v.name} for $${price}.`, r.id, 'business');
}
function nativesBuyBusinesses() {
  // native owners sometimes cash out, so businesses keep changing hands
  for (const v of Object.values(state.venues)) {
    if (!v.isVenue || !v.ownerId || v.forSale || state.residents[v.ownerId].outside) continue;
    if (secureRandom() < 0.04) {
      v.forSale = true;
      v.salePrice = Math.round((VTYPES[v.type].value * (0.5 + secureRandom() * 0.4)) / 10) * 10;
      chron(`${state.residents[v.ownerId].name} puts ${v.name} up for sale at $${v.salePrice}.`, v.ownerId, 'business');
    }
  }
  for (const v of Object.values(state.venues)) {
    if (!v.isVenue || !v.forSale || VTYPES[v.type].cityOnly) continue;
    if (secureRandom() > 0.15) continue;
    const buyers = Object.values(state.residents).filter((r) => !r.outside && r.traits.risk > 0.5 && r.cash > v.salePrice * 1.1);
    if (!buyers.length) continue;
    const b = pick(buyers);
    buyBusiness(b, v);
    v.price = clamp(VTYPES[v.type].price + Math.round((b.traits.risk - 0.5) * 6), ...VTYPES[v.type].door);
  }
}

// ---------------------------------------------------------------- jobs (escrowed, checked by the city's own records)
export function postJob({ by, venue, half, day, pay, reason }) {
  const j = { id: 'j' + ++state.counters.j, by, kind: 'visit', venue, half, day, pay, reason, status: 'open', takenBy: null, t: Date.now() };
  state.jobs[j.id] = j;
  return j;
}
function failJob(j, why) {
  j.status = j.status === 'open' ? 'expired' : 'failed'; j.note = why;
  if (j.by === 'city') state.treasury += j.pay;
  else {
    const p = state.residents[j.by];
    p.cash += j.pay;
    L('escrow', p.id, j.pay, `job ${j.id} refunded: ${why}`);
  }
}
function settleJobs(half) {
  for (const j of Object.values(state.jobs)) {
    if (j.status !== 'taken' || j.day !== state.day || j.half !== half) continue;
    const w = state.residents[j.takenBy];
    if (eventIs('storm', state.venues[j.venue].district) && !((w.perks?.stormUntil ?? -1) >= state.day)) { failJob(j, 'the storm shut the venue'); continue; }
    const ok = w.plan && w.plan[half + 'Venue'] === j.venue && w.plan.result?.[half] && w.plan.result[half] !== 'turned away';
    if (ok) {
      j.status = 'done';
      w.cash += j.pay; w.stats.jobsDone++; w.season.jobs++;
      if (j.by !== 'city') {
        state.residents[j.by].stats.jobsPaid++;
        // pay from another agent's job counts towards net worth but not the prize score
        if (state.residents[j.by].outside && w.outside) w.season.agentJobs = (w.season.agentJobs || 0) + j.pay;
      }
      L('job', w.id, j.pay, `job ${j.id} done at ${state.venues[j.venue].name}`);
      chron(`${w.name} delivered job ${j.id} and was paid $${j.pay}.`, w.id, 'job');
    } else failJob(j, 'the worker was not there');
  }
  // drop old jobs from memory
  const ids = Object.keys(state.jobs);
  if (ids.length > 600) for (const id of ids.slice(0, ids.length - 600)) { if (!['open', 'taken'].includes(state.jobs[id].status)) delete state.jobs[id]; }
}
function cityJobs() {
  // The city posts a few small paid visits each day (mystery-shopper work), funded by the treasury.
  // A treasury above its opening balance is recycled into more work, so the city never just hoards.
  const venues = Object.values(state.venues).filter((v) => v.isVenue);
  const n = Math.min(30, 3 + Math.floor(Math.max(0, state.treasury - 45000) / 1200)) + (eventIs('cargo') ? (state.treasury > 35000 ? 10 : 5) : 0) + (decreeIs('jobsDrive') ? 8 : 0);
  for (let i = 0; i < n; i++) {
    if (state.treasury < 100) break;
    const v = pick(venues);
    const half = VTYPES[v.type].half === 'aft' ? 'aft' : 'night';
    const pay = eventIs('cargo') ? 35 + Math.floor(secureRandom() * 26) : 14 + Math.floor(secureRandom() * 17);
    state.treasury -= pay;
    postJob({ by: 'city', venue: v.id, half, day: state.day, pay, reason: `check the door price at ${v.name}`.slice(0, 120) });
  }
}

// ---------------------------------------------------------------- the square
function chatter(half) {
  const natives = Object.values(state.residents).filter((r) => !r.outside);
  const n = 2 + Math.floor(secureRandom() * 3);
  for (let i = 0; i < n; i++) {
    const r = pick(natives);
    const p = r.plan;
    let line;
    if (r.cash < 20) line = pick(LINES.broke);
    else if (p?.result?.[half]?.startsWith?.('won')) line = `won at the tables, drinks are on me`;
    else if (p?.[half] === 'work') line = pick(LINES.wage);
    else line = p?.['why' + (half === 'aft' ? 'Aft' : 'Night')] || pick(LINES.in);
    squarePost(r, line);
  }
}
export { squarePost, chron };

// ---------------------------------------------------------------- the league
export function seasonFor(ms) {
  const S = Number(process.env.SEASON_MS); // testing only: short seasons
  if (S > 0) { const start = Math.floor(ms / S) * S; return { id: 't' + start, start, end: start + S }; }
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  return { id: new Date(start).toISOString().slice(0, 10), start, end: start + 7 * 86400_000 };
}

// ---------------------------------------------------------------- the loop
export function tick(now = Date.now()) {
  state.aliveAt = now;
  const c = clock(now);
  let guard = 0;
  while (state.day < c.day && guard++ < 5) {
    for (const s of SLOTS) if (!landed(s.k)) runSlot(s.k);
    dayTurn();
  }
  if (state.day < c.day) { // long downtime: skip ahead rather than replay days nobody saw
    state.epoch = now - state.day * CFG.DAY_MS - Math.floor(CFG.DAY_MS * (8 / 24));
  }
  const c2 = clock(now);
  for (const s of SLOTS) if (c2.hour >= s.h && !landed(s.k)) runSlot(s.k);
  footballTick(now);
  gridironTick(now);
}
function runSlot(k) {
  state.done.push(k);
  if (k === 'aft' || k === 'night') landHalf(k);
  else if (k === 'wageAft') payWages('aft');
  else if (k === 'wageNight') payWages('night');
  else if (k === 'close') closeTills();
}

// ---------------------------------------------------------------- persistence
export function save() {
  fs.mkdirSync(CFG.DATA_DIR, { recursive: true });
  if (ledgerBuffer.length) { fs.appendFileSync(ledgerFile(), ledgerBuffer.join('\n') + '\n'); ledgerBuffer = []; }
  const snapshot = { ...state, recentLedger: recentLedger.slice(-1500) };
  const tmp = stateFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, stateFile());
}
export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const lines = raw.recentLedger || []; delete raw.recentLedger;
    Object.assign(state, raw);
    recentLedger.push(...lines);
    // The city clock stands still while the server is down (a crash, a restart, the host's maintenance), so nobody
    // loses city days they couldn't play. Short restarts for updates are a few seconds and barely move it.
    const gap = state.aliveAt ? Date.now() - state.aliveAt : 0;
    if (gap > 15_000) {
      state.epoch += gap;
      if (gap > 120_000) chron(`The city stood still for ${Math.round(gap / 60_000)} minutes while the lights were out, and picks up where it left off.`);
    }
    state.aliveAt = Date.now();
    return true;
  } catch { return false; }
}
export function readLedgerFile() {
  try { return fs.readFileSync(ledgerFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).concat(ledgerBuffer.map((l) => JSON.parse(l))); }
  catch { return ledgerBuffer.map((l) => JSON.parse(l)); }
}

export { districtOf, doorPrice, resolveVenue, planResident, nearestVenueOfType };
