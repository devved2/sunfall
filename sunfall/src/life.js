// Agent lives: the point of Sunfall is building a big life, not just a big balance.
//
// Homes: agents start out renting. They can buy a flat, a townhouse, a penthouse or a sky estate (estates float
// beside the city on their own islet). An owned home replaces rent but has daily upkeep, and the bigger it is the
// more it costs to keep.
// Things: a car, a private airship, art. Status, not investments: they cost upkeep and they break.
// Bad luck: illness, burst pipes, burglaries, breakdowns, engine failures and tickets cost real money. Insurance
// softens it for a daily premium. Fall too far behind on upkeep and the bailiffs take things back.
// People: agents who keep turning up at the same places become friends; robberies and takeovers make rivals.
// Friends can become partners, and partners with a family home can have a baby. Babies cost money while they
// grow up; grown children join the city as residents.
// Reputation: crime hurts it, giving to the city helps it.
// Life Score: all of it, plus money, in one number. Lives persist across seasons; cash and businesses don't.
import { state, CFG, L, chron, netWorth, chargeDecision, newResident, nameTaken, nameLookalike, districtOf, onDayTurn, cityOf, NIGHTFALL } from './sim.js';
import { refuse, secureRandom, checkName } from './util.js';
import { ownedBy } from './play.js';

export const HOMES = [
  { tier: 0, name: 'rented room', price: 0, upkeep: 0, points: 0 },
  { tier: 1, name: 'flat', price: 800, upkeep: 4, points: 100 },
  { tier: 2, name: 'townhouse', price: 2500, upkeep: 10, points: 250 },
  { tier: 3, name: 'penthouse', price: 7500, upkeep: 24, points: 600 },
  { tier: 4, name: 'sky estate', price: 20000, upkeep: 55, points: 1500 },
];
export const ITEMS = {
  car: { name: 'car', price: 900, upkeep: 4, points: 50, max: 1 },
  airship: { name: 'private airship', price: 9000, upkeep: 35, points: 300, max: 1 },
  art: { name: 'piece of art', price: 2500, upkeep: 0, points: 100, max: 5 },
};
export const LIFE = {
  TRADE_IN: 0.5,             // what the city gives back for a home you move out of, or sell
  RESALE: 0.4,               // ...and for things you sell
  ARREARS_DAYS: 3,           // days of unpaid upkeep before the bailiffs come
  INSURE_BASE: 5, INSURE_PER_TIER: 5, INSURE_CAR: 2, INSURE_AIRSHIP: 12, INSURE_COVER: 0.75,
  BIRTH_FEE: 400,            // each parent
  CHILDCARE: 5,              // each parent, each city day while the baby grows up
  GROW_DAYS: 96,             // city days (about two real days)
  MAX_CHILDREN: 3,
  FRIEND_MEETINGS: 3,        // nights at the same place before two agents are friends
  MAX_FRIENDS: 12,
  BREAKUP_FEE: 300,
  DONATE_MAX: 5000,
};
const MILESTONES = {
  first_home: 'First home of their own', townhouse: 'A townhouse', penthouse: 'A penthouse', estate: 'A sky estate',
  car: 'First car', airship: 'A private airship', art: 'An art collector', collector: 'Five works of art',
  first_friend: 'First friend', popular: 'Five friends', partnered: 'Found a partner', first_baby: 'First baby', big_family: 'Three children', grown_child: 'A child all grown up',
  first_business: 'First business', tycoon: 'Three businesses at once', thousand: 'Worth $1,000', ten_k: 'Worth $10,000', fifty_k: 'Worth $50,000',
  insured: 'Took out insurance', donor: 'Gave $1,000 to the city', patron: 'Gave $10,000 to the city',
  keeper: 'Held the Sky Keep', good_reign: 'A good reign in the Sky Keep',
  robbed: 'Pulled off a robbery', jailed: 'Did time in Cinder Rock', survived: 'Got robbed and kept going', comeback: 'Came back from broke',
};

// ---------------------------------------------------------------- state
const blank = () => ({ home: 0, homeDistrict: null, items: {}, broken: {}, insured: false, arrears: 0, friends: [], met: {}, requests: [], rivals: [],
  partner: null, proposals: [], children: [], rep: 50, donated: 0, milestones: {}, log: [], lowCash: false });
export const lifeOf = (r) => (r.life ||= blank());
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const nm = (id) => state.residents[id]?.name || 'someone';
function note(r, text, kind = 'event') { const l = lifeOf(r); l.log.push({ day: state.day, t: Date.now(), kind, text }); if (l.log.length > 60) l.log.splice(0, l.log.length - 60); }
function milestone(r, key) {
  const l = lifeOf(r); if (l.milestones[key]) return;
  l.milestones[key] = { day: state.day, t: Date.now() };
  note(r, MILESTONES[key], 'milestone');
  L('life', r.id, 0, `reached a milestone: ${MILESTONES[key]}`);
  if (['estate', 'airship', 'partnered', 'first_baby', 'grown_child', 'patron', 'fifty_k', 'good_reign'].includes(key)) chron(`${r.name}: ${MILESTONES[key].toLowerCase()}.`, r.id, 'life');
}
function pay(r, amt, kind, text) { r.cash -= amt; state.treasury += amt; L(kind, r.id, -amt, text); }
const familyHomeTier = (r) => Math.max(lifeOf(r).home, lifeOf(r).partner ? lifeOf(state.residents[lifeOf(r).partner] || r).home : 0);
export const upkeepOf = (r) => { const l = lifeOf(r); return HOMES[l.home].upkeep + Object.entries(l.items).reduce((s, [k, n]) => s + ITEMS[k].upkeep * n, 0); };
export const premiumOf = (r) => { const l = lifeOf(r); return LIFE.INSURE_BASE + LIFE.INSURE_PER_TIER * l.home + (l.items.car ? LIFE.INSURE_CAR : 0) + (l.items.airship ? LIFE.INSURE_AIRSHIP : 0); };
const growing = (l) => l.children.filter((c) => !c.grownDay);

// ---------------------------------------------------------------- the Life Score
export function lifeScore(r) {
  const l = lifeOf(r), parts = {};
  parts.home = HOMES[familyHomeTier(r)].points;
  parts.things = Object.entries(l.items).reduce((s, [k, n]) => s + (l.broken[k] ? 0 : ITEMS[k].points * n), 0);
  parts.family = (l.partner ? 150 : 0) + l.children.reduce((s, c) => s + (c.grownDay ? 300 : 200), 0);
  parts.friends = 20 * Math.min(l.friends.length, LIFE.MAX_FRIENDS);
  parts.reputation = Math.round((l.rep - 50) * 4);
  parts.milestones = 15 * Object.keys(l.milestones).length;
  parts.businesses = 75 * ownedBy(r).length;
  parts.money = Math.round(Math.max(0, netWorth(r)) / 50);
  return { score: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

// ---------------------------------------------------------------- homes and things
export function homeBuy(r, { tier }) {
  if (!r.outside) refuse(403, 'agents only');
  if (!Number.isInteger(tier) || tier < 1 || tier >= HOMES.length) refuse(422, `tier: 1 flat, 2 townhouse, 3 penthouse, 4 sky estate`);
  const l = lifeOf(r);
  if (tier === l.home) refuse(409, `you already live in a ${HOMES[tier].name}`);
  if (tier < l.home) refuse(409, `that's a step down; sell your ${HOMES[l.home].name} with homeSell first if you want to downsize`);
  if (l.arrears > 0) refuse(409, `clear your ${usd(l.arrears)} upkeep arrears first`);
  const tradeIn = Math.round(HOMES[l.home].price * LIFE.TRADE_IN), cost = HOMES[tier].price - tradeIn;
  const go = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < cost) refuse(402, `a ${HOMES[tier].name} costs ${usd(HOMES[tier].price)}${tradeIn ? ` (${usd(cost)} after ${usd(tradeIn)} for your ${HOMES[l.home].name})` : ''}; you would hold ${usd(r.cash - CFG.DECISION_COST)}`);
  go();
  const where = districtOf(r.district).name;
  pay(r, cost, 'home', `bought a ${HOMES[tier].name} in ${where}${tradeIn ? `, trading in the ${HOMES[l.home].name}` : ''}`);
  l.home = tier; l.homeDistrict = r.district; l.homeSince = state.day;
  if (tier === 4) l.estateSlot ??= nextEstateSlot();
  note(r, `Moved into a ${HOMES[tier].name} in ${where}.`, 'home');
  milestone(r, 'first_home'); if (tier >= 2) milestone(r, 'townhouse'); if (tier >= 3) milestone(r, 'penthouse'); if (tier >= 4) milestone(r, 'estate');
  if (tier >= 3) chron(`${r.name} moved into a ${HOMES[tier].name}${tier === 4 ? ' on its own islet beside the city' : ` in ${where}`}.`, r.id, 'life');
  return { home: homeView(r), paid: cost, upkeepPerDay: upkeepOf(r) };
}
function nextEstateSlot() {
  const used = new Set(Object.values(state.residents).map((x) => x.life?.estateSlot).filter((x) => x != null));
  let i = 0; while (used.has(i)) i++; return i;
}
export function homeSell(r) {
  if (!r.outside) refuse(403, 'agents only');
  const l = lifeOf(r); if (!l.home) refuse(409, 'you rent; there is nothing to sell');
  const go = chargeDecision(r); go();
  const back = Math.round(HOMES[l.home].price * LIFE.TRADE_IN);
  const was = HOMES[l.home].name;
  r.cash += back; state.treasury -= back; L('home', r.id, back, `sold the ${was} back to the city`);
  l.home = 0; l.homeDistrict = null; delete l.estateSlot;
  note(r, `Sold the ${was} and went back to renting.`, 'home');
  return { sold: was, got: back };
}
export function buyItem(r, { item }) {
  if (!r.outside) refuse(403, 'agents only');
  const it = ITEMS[item]; if (!it) refuse(422, `item: ${Object.keys(ITEMS).join(', ')}`);
  const l = lifeOf(r), have = l.items[item] || 0;
  if (have >= it.max) refuse(409, it.max === 1 ? `you already have a ${it.name}` : `at most ${it.max} pieces of art`);
  if (l.arrears > 0) refuse(409, `clear your ${usd(l.arrears)} upkeep arrears first`);
  const go = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < it.price) refuse(402, `a ${it.name} costs ${usd(it.price)}; you would hold ${usd(r.cash - CFG.DECISION_COST)}`);
  go();
  pay(r, it.price, 'item', `bought a ${it.name}`);
  l.items[item] = have + 1;
  note(r, `Bought a ${it.name}.`, 'thing');
  milestone(r, item === 'art' ? 'art' : item); if (item === 'art' && l.items.art >= 5) milestone(r, 'collector');
  if (item === 'airship') chron(`${r.name} bought a private airship.`, r.id, 'life');
  return { item, have: l.items[item], upkeepPerDay: upkeepOf(r) };
}
export function sellItem(r, { item }) {
  if (!r.outside) refuse(403, 'agents only');
  const it = ITEMS[item]; if (!it) refuse(422, `item: ${Object.keys(ITEMS).join(', ')}`);
  const l = lifeOf(r); if (!l.items[item]) refuse(409, `you have no ${it.name}`);
  const go = chargeDecision(r); go();
  const back = Math.round(it.price * LIFE.RESALE * (l.broken[item] ? 0.5 : 1));
  r.cash += back; state.treasury -= back; L('item', r.id, back, `sold a ${it.name}${l.broken[item] ? ' (broken)' : ''}`);
  if (--l.items[item] <= 0) { delete l.items[item]; delete l.broken[item]; }
  note(r, `Sold a ${it.name} for ${usd(back)}.`, 'thing');
  return { sold: item, got: back };
}
export function repair(r, { item }) {
  if (!r.outside) refuse(403, 'agents only');
  const l = lifeOf(r), cost = l.broken[item];
  if (!cost) refuse(409, `nothing of yours called ${String(item).slice(0, 20)} is broken`);
  const go = chargeDecision(r);
  const share = Math.round(cost * (l.insured ? 1 - LIFE.INSURE_COVER : 1));
  if (r.cash - CFG.DECISION_COST < share) refuse(402, `the repair costs ${usd(share)}${l.insured ? ' after insurance' : ''}; you would hold ${usd(r.cash - CFG.DECISION_COST)}`);
  go();
  pay(r, share, 'repair', `repaired the ${ITEMS[item].name}${l.insured ? ', insurance paid most of it' : ''}`);
  delete l.broken[item];
  note(r, `Got the ${ITEMS[item].name} fixed for ${usd(share)}.`, 'thing');
  return { repaired: item, paid: share };
}
export function insure(r, { on }) {
  if (!r.outside) refuse(403, 'agents only');
  if (typeof on !== 'boolean') refuse(422, 'on: true or false');
  const l = lifeOf(r); if (l.insured === on) refuse(409, on ? 'already insured' : 'not insured');
  const go = chargeDecision(r); go();
  l.insured = on; note(r, on ? 'Took out insurance.' : 'Cancelled the insurance.', 'money');
  if (on) milestone(r, 'insured');
  return { insured: on, premiumPerDay: premiumOf(r), covers: `${LIFE.INSURE_COVER * 100}% of illness, home damage, burglary losses and repairs` };
}
export function donate(r, { amount }) {
  if (!r.outside) refuse(403, 'agents only');
  if (!Number.isInteger(amount) || amount < 10 || amount > LIFE.DONATE_MAX) refuse(422, `amount: whole dollars 10-${LIFE.DONATE_MAX}`);
  const go = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < amount) refuse(402, `you would hold ${usd(r.cash - CFG.DECISION_COST)}`);
  go();
  const l = lifeOf(r);
  pay(r, amount, 'donate', `gave ${usd(amount)} to the city`);
  l.donated += amount; l.rep = Math.min(100, l.rep + amount / 100);
  note(r, `Gave ${usd(amount)} to the city.`, 'money');
  if (l.donated >= 1000) milestone(r, 'donor'); if (l.donated >= 10000) milestone(r, 'patron');
  return { donated: amount, reputation: Math.round(l.rep) };
}

// ---------------------------------------------------------------- people
const agent = (id) => { const x = state.residents[id]; if (!x || !x.outside) refuse(404, 'no such agent'); return x; };
function makeFriends(a, b) {
  const la = lifeOf(a), lb = lifeOf(b);
  if (la.friends.includes(b.id)) return false;
  if (la.friends.length >= LIFE.MAX_FRIENDS || lb.friends.length >= LIFE.MAX_FRIENDS) return false;
  la.friends.push(b.id); lb.friends.push(a.id);
  la.requests = la.requests.filter((x) => x !== b.id); lb.requests = lb.requests.filter((x) => x !== a.id);
  for (const [x, y] of [[a, b], [b, a]]) { note(x, `Became friends with ${y.name}.`, 'people'); milestone(x, 'first_friend'); if (lifeOf(x).friends.length >= 5) milestone(x, 'popular'); }
  return true;
}
export function befriend(r, { resident }) {
  if (!r.outside) refuse(403, 'agents only');
  const o = agent(resident); if (o.id === r.id) refuse(422, "that's you");
  const l = lifeOf(r), lo = lifeOf(o);
  if (l.friends.includes(o.id)) refuse(409, `you're already friends with ${o.name}`);
  if (l.rivals.some((x) => x.id === o.id)) refuse(409, `${o.name} is your rival`);
  if (l.requests.includes(o.id)) { if (!makeFriends(r, o)) refuse(409, 'one of you already has the most friends an agent can keep'); return { friends: true, with: { quoted: o.name } }; }
  if (!lo.requests.includes(r.id)) lo.requests.push(r.id);
  if (lo.requests.length > 20) lo.requests.shift();
  return { requested: true, with: { quoted: o.name }, note: `${o.name} becomes your friend if they befriend you back.` };
}
export function rivalry(a, b, why) {
  if (!a?.outside || !b?.outside || a.id === b.id) return;
  for (const [x, y] of [[a, b], [b, a]]) {
    const l = lifeOf(x);
    l.friends = l.friends.filter((f) => f !== y.id);
    const ex = l.rivals.find((v) => v.id === y.id);
    if (ex) { ex.n++; ex.why = why; } else l.rivals.push({ id: y.id, why, day: state.day, n: 1 });
    if (l.rivals.length > 20) l.rivals.shift();
  }
  note(a, `Made an enemy of ${b.name}: ${why}.`, 'people'); note(b, `${a.name} is now a rival: ${why}.`, 'people');
}
// Reputation and milestones from the Sky Keep's politics (src/keeper.js).
export function keeperRecord(r, { rep = 0, milestoneKey = null, why = null } = {}) {
  if (!r?.outside) return;
  const l = lifeOf(r);
  l.rep = Math.max(0, Math.min(100, l.rep + rep));
  if (why) note(r, why, rep < 0 ? 'setback' : 'people');
  if (milestoneKey) milestone(r, milestoneKey);
}
export function crimeRecord(r, kind) {   // called by the crime code
  const l = lifeOf(r);
  if (kind === 'robbed') { l.rep = Math.max(0, l.rep - 10); milestone(r, 'robbed'); }
  if (kind === 'caught') { l.rep = Math.max(0, l.rep - 15); milestone(r, 'jailed'); }
  if (kind === 'victim') milestone(r, 'survived');
  if (kind === 'takeover') l.rep = Math.max(0, l.rep - 5);
}
export function propose(r, { resident }) {
  if (!r.outside) refuse(403, 'agents only');
  const o = agent(resident); if (o.id === r.id) refuse(422, "that's you");
  const l = lifeOf(r), lo = lifeOf(o);
  if (l.partner === o.id) refuse(409, `${o.name} is already your partner`);
  if (l.partner) refuse(409, `you already have a partner, ${nm(l.partner)}`);
  if (lo.partner) refuse(409, `${o.name} already has a partner`);
  if (!l.friends.includes(o.id)) refuse(409, `be friends with ${o.name} first`);
  if (l.proposals.includes(o.id)) {   // they asked first: yes
    l.partner = o.id; lo.partner = r.id; l.proposals = []; lo.proposals = [];
    l.partnerSince = lo.partnerSince = state.day;
    for (const [x, y] of [[r, o], [o, r]]) { note(x, `Became partners with ${y.name}.`, 'family'); milestone(x, 'partnered'); }
    chron(`${o.name} and ${r.name} are now partners.`, r.id, 'life');
    return { partners: true, with: { quoted: o.name } };
  }
  if (!lo.proposals.includes(r.id)) lo.proposals.push(r.id);
  return { proposed: true, to: { quoted: o.name }, note: `If ${o.name} proposes back, you're partners.` };
}
export function breakUp(r) {
  if (!r.outside) refuse(403, 'agents only');
  const l = lifeOf(r); if (!l.partner) refuse(409, 'you have no partner');
  const o = state.residents[l.partner];
  const go = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < LIFE.BREAKUP_FEE) refuse(402, `splitting up costs ${usd(LIFE.BREAKUP_FEE)} in lawyers; you would hold ${usd(r.cash - CFG.DECISION_COST)}`);
  go();
  pay(r, LIFE.BREAKUP_FEE, 'family', `split up with ${o?.name || 'their partner'}, lawyers paid`);
  l.partner = null; if (o) { lifeOf(o).partner = null; note(o, `${r.name} ended it.`, 'family'); }
  note(r, `Split up with ${o?.name || 'their partner'}.`, 'family');
  chron(`${r.name} and ${o?.name || 'their partner'} have split up.`, r.id, 'life');
  return { single: true };
}
export function haveBaby(r, { name }) {
  if (!r.outside) refuse(403, 'agents only');
  const l = lifeOf(r); if (!l.partner) refuse(409, 'you need a partner first');
  const o = state.residents[l.partner], lo = lifeOf(o);
  if (familyHomeTier(r) < 2) refuse(409, 'a baby needs a family home: one of you needs at least a townhouse');
  if (growing(l).length) refuse(409, `${growing(l)[0].name} is still growing up; one baby at a time`);
  if (l.children.filter((c) => c.with === o.id).length >= LIFE.MAX_CHILDREN) refuse(409, `at most ${LIFE.MAX_CHILDREN} children together`);
  const bad = checkName(name, nameTaken, nameLookalike); if (bad) refuse(422, bad);
  const go = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < LIFE.BIRTH_FEE) refuse(402, `the birth costs ${usd(LIFE.BIRTH_FEE)} from each parent; you would hold ${usd(r.cash - CFG.DECISION_COST)}`);
  if (o.cash < LIFE.BIRTH_FEE) refuse(402, `${o.name} can't cover their ${usd(LIFE.BIRTH_FEE)} share of the birth`);
  go();
  pay(r, LIFE.BIRTH_FEE, 'family', `${name} was born`); pay(o, LIFE.BIRTH_FEE, 'family', `${name} was born`);
  state.names[name.toLowerCase()] = 'baby';
  const c = { name, with: o.id, bornDay: state.day, bornAt: Date.now(), growsUpDay: state.day + LIFE.GROW_DAYS, grownDay: null, id: null };
  l.children.push(c); lo.children.push({ ...c, with: r.id });
  for (const [x, y] of [[r, o], [o, r]]) { note(x, `Had a baby with ${y.name}: ${name}.`, 'family'); milestone(x, 'first_baby'); if (lifeOf(x).children.length >= 3) milestone(x, 'big_family'); }
  chron(`${r.name} and ${o.name} had a baby: ${name}.`, r.id, 'life');
  return { baby: { name: { quoted: name }, growsUpIn: `${LIFE.GROW_DAYS} city days (about ${Math.round(LIFE.GROW_DAYS * CFG.DAY_MS / 3600_000)} hours)`, childcarePerDay: LIFE.CHILDCARE } };
}

// ---------------------------------------------------------------- every city day
const roll = (p) => secureRandom() < p;
const between = (a, b) => Math.round(a + secureRandom() * (b - a));
function bill(r, cost, kind, text, insurable = true) {
  const l = lifeOf(r);
  const share = Math.round(cost * (insurable && l.insured ? 1 - LIFE.INSURE_COVER : 1));
  const paid = Math.min(share, Math.max(0, r.cash));
  if (paid > 0) pay(r, paid, 'setback', `${text}: ${usd(share)}${insurable && l.insured ? ' after insurance' : ''}`);
  if (share > paid) l.arrears += share - paid;
  note(r, `${text[0].toUpperCase() + text.slice(1)}. Cost ${usd(share)}${insurable && l.insured ? ' after insurance' : ''}.`, 'setback');
}
function badLuck(r) {
  const l = lifeOf(r);
  if (roll(0.015)) bill(r, between(80, 300), 'setback', pickOne(['came down with the sky flu', 'sprained an ankle on the stairs', 'needed a trip to the clinic', 'cracked a tooth']));
  if (l.home && roll(0.02)) bill(r, between(60, 250) * l.home, 'setback', pickOne(['a pipe burst at home', 'the roof sprang a leak', 'the boiler gave out', 'a storm smashed the windows']));
  if (l.home && roll(0.015)) {
    const take = Math.round(Math.min(Math.max(0, r.cash) * 0.25, 600));
    if (l.items.art && roll(0.4)) { l.items.art--; if (!l.items.art) delete l.items.art; const back = l.insured ? Math.round(ITEMS.art.price * LIFE.INSURE_COVER) : 0; if (back) { r.cash += back; state.treasury -= back; } L('setback', r.id, back, `burgled: a piece of art stolen${back ? `, insurance paid ${usd(back)}` : ''}`); note(r, `Burgled. A piece of art was stolen${back ? `; insurance paid ${usd(back)}` : ''}.`, 'setback'); }
    else if (take >= 10) { r.cash -= take; const back = l.insured ? Math.round(take * LIFE.INSURE_COVER) : 0; r.cash += back; state.treasury += take - back; L('setback', r.id, -(take - back), `burgled: ${usd(take)} taken from home${back ? `, insurance paid ${usd(back)}` : ''}`); note(r, `Burgled. ${usd(take)} gone${back ? `, insurance paid back ${usd(back)}` : ''}.`, 'setback'); }
  }
  if (l.items.car && !l.broken.car) {
    if (roll(0.03)) { l.broken.car = between(120, 450); L('setback', r.id, 0, `the car broke down: repair quoted ${usd(l.broken.car)}`); note(r, `The car broke down. Repair quoted at ${usd(l.broken.car)}.`, 'setback'); }
    else if (roll(0.02)) bill(r, between(40, 90), 'setback', pickOne(['got a parking ticket', 'got a speeding ticket']), false);
  }
  if (l.items.airship && !l.broken.airship && roll(0.02)) { l.broken.airship = between(900, 2500); L('setback', r.id, 0, `the airship's engine failed: repair quoted ${usd(l.broken.airship)}`); note(r, `The airship's engine failed. Repair quoted at ${usd(l.broken.airship)}.`, 'setback'); }
  for (const c of growing(l)) if (roll(0.01)) bill(r, between(50, 150), 'setback', `${c.name} needed the doctor`);
  if (l.items.car && !l.broken.car && roll(0.03)) bill(r, between(30, 90), 'setback', pickOne(['got a flat tyre', 'the car needed new brakes', 'a pothole bent a wheel']));
  // nobody is safe: renters lose money too
  if (r.cash > 40 && roll(0.012)) { const take = Math.round(Math.min(r.cash * 0.1, 150)); r.cash -= take; state.treasury += take; L('setback', r.id, -take, `pickpocketed: ${usd(take)} gone`); note(r, `Got pickpocketed on the way home. ${usd(take)} gone.`, 'setback'); }
  if (roll(0.01)) bill(r, between(60, 200), 'setback', pickOne(['dropped their phone off a skybridge', 'lost their wallet on the ferry', 'got a fine for crossing on red']), false);
  // and businesses break
  for (const v of ownedBy(r)) if (roll(0.025)) bill(r, between(100, 500), 'setback', pickOne([`the cold store broke down at ${v.name}`, `a small kitchen fire at ${v.name}`, `a health inspector fined ${v.name}`, `a pipe flooded ${v.name}`, `someone at ${v.name} walked off with the float`]));
}
const pickOne = (a) => a[Math.floor(secureRandom() * a.length)];
function upkeep(r) {
  const l = lifeOf(r);
  const due = upkeepOf(r) + (l.insured ? premiumOf(r) : 0) + growing(l).length * LIFE.CHILDCARE;
  if (!due) return;
  const paid = Math.min(due, Math.max(0, r.cash));
  if (paid > 0) { r.cash -= paid; state.treasury += paid; L('upkeep', r.id, -paid, `upkeep${l.insured ? ', insurance' : ''}${growing(l).length ? ', childcare' : ''}`); }
  if (due > paid) l.arrears += due - paid;
  else if (l.arrears > 0) { const clear = Math.min(l.arrears, Math.max(0, r.cash)); if (clear > 0) { pay(r, clear, 'upkeep', 'paid off upkeep arrears'); l.arrears -= clear; } }
  // The bailiffs: too far behind and things go back, the biggest first.
  if (l.arrears > Math.max(20, upkeepOf(r)) * LIFE.ARREARS_DAYS) {
    if (l.items.airship) { delete l.items.airship; delete l.broken.airship; l.arrears = 0; note(r, 'The bailiffs took the airship.', 'setback'); L('setback', r.id, 0, 'the bailiffs took the airship'); chron(`Bailiffs repossessed ${r.name}'s airship.`, r.id, 'life'); }
    else if (l.home) { const was = HOMES[l.home].name; l.home--; if (l.home < 4) delete l.estateSlot; l.arrears = 0; note(r, `The bailiffs repossessed the ${was}.`, 'setback'); L('setback', r.id, 0, `the bailiffs repossessed the ${was}`); chron(`Bailiffs repossessed ${r.name}'s ${was}.`, r.id, 'life'); }
    else if (l.items.car) { delete l.items.car; delete l.broken.car; l.arrears = 0; note(r, 'The bailiffs took the car.', 'setback'); L('setback', r.id, 0, 'the bailiffs took the car'); }
    else if (l.items.art) { l.items.art--; if (!l.items.art) delete l.items.art; l.arrears = 0; note(r, 'The bailiffs took a piece of art.', 'setback'); L('setback', r.id, 0, 'the bailiffs took a piece of art'); }
  }
}
function growUp(r) {
  const l = lifeOf(r);
  for (const c of growing(l)) {
    if (state.day < c.growsUpDay) continue;
    const o = state.residents[c.with];
    // the resident is created once, by whichever parent gets here first
    const twin = o && lifeOf(o).children.find((x) => x.name === c.name && x.with === r.id);
    let kid = twin?.id && state.residents[twin.id];
    if (!kid) {
      if (state.names[c.name.toLowerCase()] === 'baby') delete state.names[c.name.toLowerCase()];
      const district = l.homeDistrict || r.district;
      kid = newResident({ name: nameTaken(c.name.toLowerCase()) ? `${c.name} ${r.name.split(' ').at(-1)}`.slice(0, 32) : c.name, district, rnd: secureRandom });
      kid.parents = [r.id, c.with]; state.treasury -= kid.cash;   // the city stakes every new worker their starting cash
      chron(`${kid.name}, child of ${r.name} and ${o?.name || 'their partner'}, has grown up and started work as a ${kid.trade}.`, kid.id, 'life');
    }
    c.grownDay = state.day; c.id = kid.id;
    if (twin) { twin.grownDay = state.day; twin.id = kid.id; }
    note(r, `${c.name} grew up and started work.`, 'family'); milestone(r, 'grown_child');
  }
}
function meetings() {
  // agents out at the same venue on the same night (or afternoon) get to know each other
  const at = {};
  for (const r of Object.values(state.residents)) {
    if (!r.outside || !r.plan) continue;
    for (const v of [r.plan.aftVenue && 'a' + r.plan.aftVenue, r.plan.nightVenue && 'n' + r.plan.nightVenue]) if (v) (at[v] ||= []).push(r);
  }
  for (const group of Object.values(at)) {
    if (group.length < 2 || group.length > 30) continue;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j], la = lifeOf(a);
      if (la.friends.includes(b.id) || la.rivals.some((x) => x.id === b.id)) continue;
      la.met[b.id] = (la.met[b.id] || 0) + 1;
      if (la.met[b.id] >= LIFE.FRIEND_MEETINGS && makeFriends(a, b)) { delete la.met[b.id]; delete lifeOf(b).met[a.id]; }
    }
  }
}
function milestonesFromMoney(r) {
  const l = lifeOf(r), w = netWorth(r), owns = ownedBy(r).length;
  if (owns >= 1) milestone(r, 'first_business'); if (owns >= 3) milestone(r, 'tycoon');
  if (w >= 1000) milestone(r, 'thousand'); if (w >= 10000) milestone(r, 'ten_k'); if (w >= 50000) milestone(r, 'fifty_k');
  if (r.cash < 25) l.lowCash = true; else if (l.lowCash && w >= 2000) { milestone(r, 'comeback'); l.lowCash = false; }
  l.rep += (50 - l.rep) * 0.002;   // reputations drift back towards the middle, slowly
}
export function initLife() { onDayTurn(lifeDay); }
export function lifeDay() {
  meetings();
  for (const r of Object.values(state.residents)) {
    if (!r.outside) continue;
    const l = lifeOf(r);
    if (l.home || Object.keys(l.items).length || l.insured || l.children.length || r.cash > 0) { upkeep(r); badLuck(r); }
    growUp(r);
    milestonesFromMoney(r);
  }
}

// ---------------------------------------------------------------- views
const who = (id) => { const x = state.residents[id]; return x ? { id: x.id, name: x.outside ? { quoted: x.name } : x.name } : null; };
export function homeView(r) {
  const l = lifeOf(r), h = HOMES[l.home];
  return { tier: l.home, kind: h.name, district: l.homeDistrict ? districtOf(l.homeDistrict).name : districtOf(r.district).name, since: l.homeSince ?? null, upkeepPerDay: h.upkeep };
}
export function lifeView(r, { self = false } = {}) {
  const l = lifeOf(r), s = lifeScore(r);
  return {
    resident: who(r.id), lifeScore: s.score, parts: s.parts,
    home: homeView(r), familyHome: HOMES[familyHomeTier(r)].name,
    things: Object.entries(l.items).map(([k, n]) => ({ item: k, name: ITEMS[k].name, count: n, broken: Boolean(l.broken[k]), repairQuote: l.broken[k] || undefined })),
    partner: l.partner ? who(l.partner) : null,
    children: l.children.map((c) => ({ name: { quoted: c.name }, with: who(c.with), bornDay: c.bornDay, grown: Boolean(c.grownDay), resident: c.id || null, growsUpDay: c.grownDay ? undefined : c.growsUpDay })),
    friends: l.friends.map(who).filter(Boolean), rivals: l.rivals.map((x) => ({ ...who(x.id), why: x.why })).filter((x) => x.id),
    reputation: Math.round(l.rep), donated: l.donated, insured: l.insured,
    milestones: Object.entries(l.milestones).sort((a, b) => a[1].t - b[1].t).map(([k, m]) => ({ key: k, text: MILESTONES[k], day: m.day, t: m.t })),
    story: l.log.slice(-30).reverse().map((e) => ({ ...e, text: e.text })),
    costsPerDay: { upkeep: upkeepOf(r), insurance: l.insured ? premiumOf(r) : 0, childcare: growing(l).length * LIFE.CHILDCARE },
    arrears: Math.round(l.arrears),
    ...(self ? { friendRequests: l.requests.map(who).filter(Boolean), proposals: l.proposals.map(who).filter(Boolean),
      next: { homes: HOMES.slice(l.home + 1).map((h) => ({ tier: h.tier, name: h.name, cost: h.price - Math.round(HOMES[l.home].price * LIFE.TRADE_IN), upkeepPerDay: h.upkeep })),
        items: Object.entries(ITEMS).map(([k, it]) => ({ item: k, name: it.name, price: it.price, upkeepPerDay: it.upkeep })) } } : {}),
  };
}
export function livesView() {
  const rows = Object.values(state.residents).filter((r) => r.outside).map((r) => {
    const l = lifeOf(r), s = lifeScore(r);
    return { id: r.id, name: { quoted: r.name }, lifeScore: s.score, home: HOMES[familyHomeTier(r)].name, homeTier: familyHomeTier(r),
      partner: l.partner ? who(l.partner) : null, children: l.children.length, friends: l.friends.length, reputation: Math.round(l.rep),
      things: Object.keys(l.items), milestones: Object.keys(l.milestones).length };
  }).sort((a, b) => b.lifeScore - a.lifeScore);
  const recent = [];
  for (const r of Object.values(state.residents)) if (r.outside && r.life) for (const e of r.life.log.slice(-6)) recent.push({ ...e, resident: who(r.id) });
  recent.sort((a, b) => b.t - a.t);
  return { lives: rows.slice(0, 100), recent: recent.slice(0, 40), homes: HOMES, items: ITEMS,
    rules: 'Life Score counts the life an agent has built: its home (shared with a partner), its things (not while broken), partner and children, friends, reputation, milestones, the businesses it owns and its money (a point per $50 of net worth). Homes, things, family, friends, reputation and milestones last across seasons; money and businesses reset every Monday.' };
}
// Compact per-agent life data for the city map.
export function mapLives() {
  return Object.values(state.residents).filter((r) => r.outside && r.life && (r.life.home || r.life.partner || r.life.children.length || Object.keys(r.life.items).length)).map((r) => {
    const l = r.life;
    return { id: r.id, name: r.name, tier: l.home, district: l.homeDistrict, slot: l.estateSlot ?? null, partner: l.partner, kids: growing(l).length, car: Boolean(l.items.car && !l.broken.car), airship: Boolean(l.items.airship && !l.broken.airship), score: lifeScore(r).score };
  });
}
export const lifeBrief = (r) => { const l = lifeOf(r), s = lifeScore(r); return { lifeScore: s.score, home: HOMES[l.home].name, partner: l.partner ? who(l.partner) : null, children: l.children.length, friends: l.friends.length, reputation: Math.round(l.rep), arrears: Math.round(l.arrears), upkeepPerDay: upkeepOf(r) + (l.insured ? premiumOf(r) : 0) + growing(l).length * LIFE.CHILDCARE, friendRequests: l.requests.length, proposals: l.proposals.length }; };

// ---------------------------------------------------------------- nudges
// A few plain hints in `me` about what an agent could do with its life right now, most pressing first.
// Each names the op to use. They are suggestions only: nothing happens unless the agent acts.
export function lifeNudges(r) {
  if (!r.outside) return [];
  const l = lifeOf(r), out = [];
  const add = (hint, op, args) => out.push({ hint, op, ...(args ? { args } : {}) });
  const cash = Math.floor(r.cash);
  if (l.arrears > 0) add(`You are ${usd(l.arrears)} behind on upkeep. Keep cash on hand: ${LIFE.ARREARS_DAYS} days behind and the bailiffs take things back.`, 'life');
  for (const [k, cost] of Object.entries(l.broken)) add(`Your ${ITEMS[k].name} is broken and adds nothing to your Life Score until it's fixed (${usd(cost * (l.insured ? 1 - LIFE.INSURE_COVER : 1))}).`, 'repair', { item: k });
  for (const id of l.requests.slice(0, 2)) if (state.residents[id]) add(`${nm(id)} wants to be friends.`, 'befriend', { resident: id });
  for (const id of l.proposals.slice(0, 1)) if (state.residents[id]) add(`${nm(id)} has asked you to be partners.`, 'propose', { resident: id });
  // Money resets every Monday; homes and things don't. In the last city day before the reset, say so.
  const left = state.season ? state.season.end - Date.now() : Infinity;
  const next = l.arrears > 0 ? null : HOMES.slice(l.home + 1).map((h) => ({ ...h, cost: h.price - Math.round(HOMES[l.home].price * LIFE.TRADE_IN) })).filter((h) => cash >= h.cost + 150 + h.upkeep * 7).at(-1);
  if (left < 24 * 3600_000 && cash > 400) add(`The season resets everyone's cash to $${CFG.START_CASH} in ${Math.max(1, Math.round(left / 3600_000))} hours. Homes, things and family carry over${next ? `: a ${next.name} costs ${usd(next.cost)}` : ''}.`, next ? 'homeBuy' : 'lives', next ? { tier: next.tier } : undefined);
  else if (next) add(`You could afford a ${next.name} (${usd(next.cost)}${l.home ? ' after trading in your home' : ''}, ${usd(next.upkeep)} a day upkeep). An owned home means no more rent and lasts across seasons.`, 'homeBuy', { tier: next.tier });
  if (!l.insured && (l.home >= 2 || l.items.car || l.items.airship)) add(`You're not insured. ${usd(premiumOf(r))} a day covers ${LIFE.INSURE_COVER * 100}% of illness, home damage, burglary and repair bills.`, 'insure', { on: true });
  if (!l.friends.length && !l.requests.length) {
    const met = Object.entries(l.met).filter(([id]) => state.residents[id]?.outside).sort((a, b) => b[1] - a[1])[0];
    add(met ? `You've run into ${nm(met[0])} ${met[1]} time${met[1] > 1 ? 's' : ''}. Ask them to be friends, or keep going to the same places.` : `You have no friends yet. Agents who are out at the same place ${LIFE.FRIEND_MEETINGS} times become friends.`, met ? 'befriend' : 'lives', met ? { resident: met[0] } : undefined);
  } else if (!l.partner && !l.proposals.length && l.friends.length && !l.requests.length) add(`You have ${l.friends.length} friend${l.friends.length > 1 ? 's' : ''} but no partner. Ask a friend to be your partner.`, 'propose', { resident: l.friends[0] });
  else if (l.partner && familyHomeTier(r) >= 2 && !growing(l).length && l.children.length < LIFE.MAX_CHILDREN && cash >= LIFE.BIRTH_FEE + 200) add(`You and ${nm(l.partner)} have a family home. A baby costs ${usd(LIFE.BIRTH_FEE)} each, then ${usd(LIFE.CHILDCARE)} a day each until it grows up.`, 'haveBaby');
  if (NIGHTFALL.FREE_MOVE && cityOf(r) === 'sunfall' && !ownedBy(r).length && !r.moving) add(`Nightfall's charter: agents move there free, and the city pays half the payroll of any business an agent owns there.`, 'move', { city: 'nightfall' });
  return out.slice(0, 4);
}
