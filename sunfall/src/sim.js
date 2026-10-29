import fs from 'node:fs';
import path from 'node:path';
import { sha256, mulberry32, secureRandom, pick, clamp, checkSentence, refuse } from './util.js';
import { DISTRICTS, VTYPES, VENUE_TYPES, WTYPES, TRADES, PLACES, FIRST, LAST, LINES } from './world.js';

export const CFG = {
  DAY_MS: Number(process.env.DAY_MS) || 30 * 60 * 1000, // one city day = 30 real minutes
  NATIVES: Number(process.env.NATIVES) || 240,
  START_CASH: 250,
  DECISION_COST: 3,
  DECISIONS_PER_HOUR: Number(process.env.DECISIONS_PER_HOUR) || 10,
  SQUARE_POSTS_PER_DAY: 4,
  OUTSIDE_CAP: Number(process.env.OUTSIDE_CAP) || 500,
  JOINS_PER_IP_PER_DAY: Number(process.env.JOINS_PER_IP_PER_DAY) || 3,
  SPEND_MAX: 200,
  JOB_PAY_MAX: 200,
  CASINO_WIN_P: 0.47,
  DATA_DIR: process.env.DATA_DIR || path.resolve('data'),
  SEED: Number(process.env.SEED) || 20261026,
};

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
  counters: { r: 0, j: 0, s: 0, b: 0 },
  ipJoins: {}, keys: {}, names: {}, billboards: [], season: null, stats: { today: {} },
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
export function L(kind, who, amt, note = '') {
  const e = { i: ++state.ledgerCount, t: Date.now(), day: state.day, kind, who, amt: Math.round(amt * 100) / 100, note };
  e.h = ledgerHash(state.ledgerHead, e);
  state.ledgerHead = e.h;
  recentLedger.push(e);
  if (recentLedger.length > 1500) recentLedger.splice(0, recentLedger.length - 1500);
  ledgerBuffer.push(JSON.stringify(e));
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
function workplaceFor(trade, rnd) {
  const place = TRADES[trade].place;
  const options = Object.values(state.venues).filter((v) => v.type === place);
  return pick(options, rnd).id;
}
export function nameTaken(lower) { return Boolean(state.names[lower]); }

export function newResident({ name, outside = false, rnd = Math.random, cash = CFG.START_CASH, district, trade }) {
  const id = 'r' + ++state.counters.r;
  trade = trade || weightedTrade(rnd);
  district = district || pick(DISTRICTS, rnd).id;
  const r = {
    id, name, trade, workplace: workplaceFor(trade, rnd), district, home: randomHome(district, rnd),
    cash, mood: 60, traits: { thrift: rnd(), social: rnd(), risk: rnd() },
    outside, runsOn: null, key: null, keyKind: null, tokenHash: null, seq: 0,
    policy: null, decisions: [], squareDay: null, squareCount: 0, shiftOverride: null,
    joinedDay: state.day, joinedAt: Date.now(), plan: null, today: { from: 'rules', note: null },
    stats: { wages: 0, spent: 0, won: 0, lost: 0, rent: 0, arrears: 0, jobsDone: 0, jobsPaid: 0, decisions: 0 },
    seasonStartWorth: cash,
  };
  state.residents[id] = r;
  state.names[name.toLowerCase()] = id;
  return r;
}

export function initWorld() {
  const rnd = mulberry32(CFG.SEED);
  state.epoch = Date.now() - Math.floor(CFG.DAY_MS * (8 / 24)); // open the gates at 08:00 on day 0
  state.treasury = 60000;
  for (const [id, type, name, district, x, y, sale] of PLACES) {
    const isVenue = Boolean(VTYPES[type]);
    state.venues[id] = {
      id, type, name, district, x, y, isVenue,
      price: isVenue ? VTYPES[type].price : 0,
      till: 0, ownerId: null, forSale: sale != null, salePrice: sale, visitsToday: 0, takingsToday: 0,
      lifetime: { visits: 0, takings: 0 },
    };
  }
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
  cityJobs();
  planAll();
  state.season = seasonFor(Date.now());
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
  list.sort((a, b) => (a.district === r.district ? -1 : 0) - (b.district === r.district ? -1 : 0) || Math.hypot(a.x - hx, a.y - hy) - Math.hypot(b.x - hx, b.y - hy));
  return list[0];
}
function resolveVenue(choice, r) {
  if (choice === 'in' || choice === 'work') return null;
  if (VTYPES[choice]) return nearestVenueOfType(choice, r);
  const v = state.venues[choice];
  if (v && v.isVenue) return v;
  return undefined;
}
const doorPrice = (v) => v.price;

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
  let wantSpend = 0;
  for (const half of HALVES) {
    if (shift === half) { choice[half] = 'work'; continue; }
    if (r.cash < 25 || secureRandom() < 0.15 + t.thrift * 0.25) { choice[half] = 'in'; continue; }
    let options = half === 'aft' ? ['gym', 'diner', 'bar'] : ['bar', 'market', 'diner'];
    if (half === 'night' && t.risk > 0.6 && r.cash > 160) options = ['casino', 'casino', 'bar'];
    choice[half] = pick(options);
  }
  const outs = HALVES.filter((h) => choice[h] !== 'in' && choice[h] !== 'work');
  if (outs.length) {
    const budget = clamp(Math.round(r.cash * (0.06 + (1 - t.thrift) * 0.12)), 0, 80);
    const minNeeded = outs.map((h) => doorPrice(nearestVenueOfType(choice[h], r)));
    const per = Math.max(...minNeeded);
    wantSpend = Math.max(budget, per * outs.length);
    if (wantSpend > r.cash) { for (const h of outs) choice[h] = 'in'; wantSpend = 0; }
  }
  const d = { ...choice, spend: wantSpend };
  for (const h of HALVES) {
    const key = h === 'aft' ? 'whyAft' : 'whyNight';
    d[key] = pick(LINES[choice[h] === 'work' ? 'in' : choice[h]] || LINES.in);
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
  if (r.decisions.length >= CFG.DECISIONS_PER_HOUR) refuse(429, `at most ${CFG.DECISIONS_PER_HOUR} decisions an hour`);
  if (r.cash < CFG.DECISION_COST) refuse(402, `a decision costs $${CFG.DECISION_COST} and you hold $${r.cash.toFixed(2)}: the rules run your day until you can pay`);
  return () => {
    r.cash -= CFG.DECISION_COST;
    state.treasury += CFG.DECISION_COST;
    r.decisions.push(Date.now());
    r.stats.decisions++;
    L('decision', r.id, -CFG.DECISION_COST, 'decision fee');
  };
}

// ---------------------------------------------------------------- landings
function payFromVenue(v, amt) {
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
    const free = Object.values(state.residents).filter((r) => !r.outside && r.plan && r.plan[half] !== 'work' && r.cash >= doorPrice(v) + 5);
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
    if (r.cash < doorPrice(v)) {
      p.result[half] = 'turned away';
      if (r.outside) L('door', r.id, 0, `turned away at ${v.name}: could not pay the door`);
      continue;
    }
    const amt = Math.min(p.shares[half], Math.floor(r.cash * 100) / 100);
    p.result[half] = 'there';
    v.visitsToday++; v.lifetime.visits++;
    if (v.type === 'casino') {
      // Stake is the half's share, played at the house minimum. Dice drawn now, never before.
      const win = secureRandom() < CFG.CASINO_WIN_P;
      if (win) {
        const paid = payFromVenue(v, amt);
        r.cash += paid; r.stats.won += paid; r.mood = clamp(r.mood + 12, 0, 100);
        p.result[half] = `won $${paid}`;
        if (r.outside) L('casino', r.id, paid, `won at ${v.name}`); else (agg[vid + ':win'] ||= { n: 0, amt: 0, v, kind: 'casino-win' }, agg[vid + ':win'].n++, agg[vid + ':win'].amt += paid);
        if (paid >= 60) chron(`${r.name} won $${Math.round(paid)} at ${v.name}.`, r.id, 'casino');
      } else {
        r.cash -= amt; v.till += amt; v.takingsToday += amt; v.lifetime.takings += amt; r.stats.lost += amt; r.mood = clamp(r.mood - 8, 0, 100);
        p.result[half] = `lost $${amt}`;
        if (r.outside) L('casino', r.id, -amt, `lost at ${v.name}`); else (agg[vid + ':lose'] ||= { n: 0, amt: 0, v, kind: 'casino-loss' }, agg[vid + ':lose'].n++, agg[vid + ':lose'].amt -= amt);
      }
    } else {
      r.cash -= amt; v.till += amt; v.takingsToday += amt; v.lifetime.takings += amt; r.stats.spent += amt; r.mood = clamp(r.mood + 4, 0, 100);
      if (r.outside) L('spend', r.id, -amt, `${half === 'aft' ? 'afternoon' : 'night'} at ${v.name}`);
      else (agg[vid] ||= { n: 0, amt: 0, v, kind: 'spend' }, agg[vid].n++, agg[vid].amt -= amt);
    }
  }
  for (const a of Object.values(agg)) L(a.kind, a.v.id, a.amt, `${a.n} residents at ${a.v.name}`);
  const outN = Object.values(state.residents).filter((r) => r.plan?.result?.[half] && !['in', 'work', 'turned away'].includes(r.plan.result[half])).length;
  const taken = Object.values(state.venues).reduce((s, v) => s + v.takingsToday, 0);
  const busiest = Object.values(state.venues).filter((v) => v.isVenue).sort((a, b) => b.visitsToday - a.visitsToday)[0];
  chron(`The ${half === 'aft' ? 'afternoon' : 'night'} lands: ${outN} residents out, $${Math.round(taken)} taken across the city today. Busiest: ${busiest.name}.`, null, 'landing');
  settleJobs(half);
  chatter(half);
}

function payWages(half) {
  const agg = {}, short = {};
  for (const r of Object.values(state.residents)) {
    if (shiftFor(r) !== half) continue;
    const wage = TRADES[r.trade].wage;
    const place = state.venues[r.workplace];
    const paid = payFromVenue(place, wage);
    r.cash += paid; r.stats.wages += paid;
    if (paid < wage) {
      r.mood = clamp(r.mood - 15, 0, 100);
      (short[place.id] ||= { n: 0, amt: 0, place }).n++; short[place.id].amt += wage - paid;
    } else r.mood = clamp(r.mood + 3, 0, 100);
    if (r.outside) L('wage', r.id, paid, `${TRADES[r.trade].name} at ${place.name}${paid < wage ? `, $${Math.round(wage - paid)} short` : ''}`);
    else (agg[place.id] ||= { n: 0, amt: 0, place }, agg[place.id].n++, agg[place.id].amt += paid);
  }
  for (const a of Object.values(agg)) L('wage', a.place.id, a.amt, `${a.n} staff paid at ${a.place.name}`);
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
      state.treasury -= pay; o.cash += pay;
      L('sale', o.id, pay, `${v.name} repossessed by the city`);
      chron(`The city repossesses ${v.name} from ${o.name}, paying $${Math.round(pay)}.`, o.id, 'business');
      v.ownerId = null; v.forSale = false; v.salePrice = null; v.distress = 0; v.price = VTYPES[v.type].price;
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
        o.cash += v.till;
        L('profit', o.id, v.till, `night's take from ${v.name}`);
      } else {
        state.treasury += v.till;
        L('till', v.id, v.till, `${v.name} swept to the treasury`);
      }
      v.till = 0;
    }
  }
}

function dayTurn() {
  // rent, weekly, on the last day of the city week
  if (state.day % 7 === 6) {
    let total = 0, short = 0;
    for (const r of Object.values(state.residents)) {
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
  // expire jobs that were never done
  for (const j of Object.values(state.jobs)) {
    if ((j.status === 'open' || j.status === 'taken') && j.day <= state.day) failJob(j, j.status === 'open' ? 'expired untaken' : 'not delivered');
  }
  state.dayRoots.push({ day: state.day, root: state.ledgerHead, lines: state.ledgerCount, t: Date.now() });
  if (state.dayRoots.length > 1000) state.dayRoots.shift();
  state.day++;
  state.done = [];
  for (const v of Object.values(state.venues)) { v.visitsToday = 0; v.takingsToday = 0; }
  nativesBuyBusinesses();
  cityJobs();
  // a new league season every real Monday 00:00 UTC
  const s = seasonFor(Date.now());
  if (!state.season || s.id !== state.season.id) {
    state.season = s;
    for (const r of Object.values(state.residents)) r.seasonStartWorth = netWorth(r);
    chron(`A new league season opens: ${s.id}.`);
  }
  planAll();
}

// ---------------------------------------------------------------- businesses
export const venueValue = (v) => v.salePrice || VTYPES[v.type]?.value || 0;
export function netWorth(r) {
  let w = r.cash;
  for (const v of Object.values(state.venues)) if (v.ownerId === r.id) w += VTYPES[v.type].value;
  return Math.round(w * 100) / 100;
}
export function buyBusiness(r, v) {
  const price = v.salePrice;
  r.cash -= price;
  if (v.ownerId) {
    const seller = state.residents[v.ownerId];
    seller.cash += price;
    L('sale', seller.id, price, `sold ${v.name}`);
  } else state.treasury += price;
  L('purchase', r.id, -price, `bought ${v.name}`);
  v.ownerId = r.id; v.forSale = false; v.salePrice = null;
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
    if (!v.isVenue || !v.forSale) continue;
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
    const ok = w.plan && w.plan[half + 'Venue'] === j.venue && w.plan.result?.[half] && w.plan.result[half] !== 'turned away';
    if (ok) {
      j.status = 'done';
      w.cash += j.pay; w.stats.jobsDone++;
      if (j.by !== 'city') state.residents[j.by].stats.jobsPaid++;
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
  const n = Math.min(30, 3 + Math.floor(Math.max(0, state.treasury - 45000) / 1200));
  for (let i = 0; i < n; i++) {
    if (state.treasury < 100) break;
    const v = pick(venues);
    const half = VTYPES[v.type].half === 'aft' ? 'aft' : 'night';
    const pay = 14 + Math.floor(secureRandom() * 17);
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
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  return { id: new Date(start).toISOString().slice(0, 10), start, end: start + 7 * 86400_000 };
}

// ---------------------------------------------------------------- the loop
export function tick(now = Date.now()) {
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
    return true;
  } catch { return false; }
}
export function readLedgerFile() {
  try { return fs.readFileSync(ledgerFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).concat(ledgerBuffer.map((l) => JSON.parse(l))); }
  catch { return ledgerBuffer.map((l) => JSON.parse(l)); }
}

export { districtOf, doorPrice, resolveVenue, planResident, nearestVenueOfType };
