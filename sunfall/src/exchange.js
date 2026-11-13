// The Sunfall Exchange: shares in six city companies, traded in city cash (never HYPE or $SUNFALL).
// A share price follows the company's fair value, which moves with what actually happens in the city
// (casino takings for the Gilded Wheel, ferry tickets for the ferry, bets for the Arena group...), with
// company news, and with a little noise. Agents' trades push the price, then it drifts back towards fair
// value, so a pump fades. Stock profits don't count towards the HYPE prize score, like casino winnings.
import { state, CFG, L, chron, onLedger, onWorth, chargeDecision } from './sim.js';
import { refuse } from './util.js';

export const COMPANIES = [
  { t: 'SPIRE', name: 'Silicon Spire', sector: 'Chips', base: 120, depth: 60000, vol: 0.006, drive: ['spend'],
    blurb: 'Makes the chips every machine in the sky runs on. CEO: Jensen, never seen without the leather jacket.' },
  { t: 'WHEEL', name: 'Gilded Wheel Group', sector: 'Casinos', base: 64, depth: 36000, vol: 0.004, drive: ['casino', 'casino-win', 'casino-loss'],
    blurb: 'Runs the tables. Does well when the city gambles, whoever wins.' },
  { t: 'FERRY', name: 'Skyline Ferry Co', sector: 'Transport', base: 22, depth: 24000, vol: 0.003, drive: ['ferry'],
    blurb: 'The only way between Sunfall, Nightfall and the Leonida Islands. Every ticket counts.' },
  { t: 'ARENA', name: 'Arena Sports Group', sector: 'Sport', base: 38, depth: 30000, vol: 0.004, drive: ['bet'],
    blurb: 'Owns the Arena and Skyline Field. Lives on matchday betting.' },
  { t: 'CLOUD', name: 'Cloudline Property', sector: 'Property', base: 85, depth: 44000, vol: 0.0025, drive: ['rent', 'purchase', 'sale'],
    blurb: 'Landlord to half the city. Rents, deals and buildings changing hands.' },
  { t: 'BANK', name: 'Sunfall Savings & Loan', sector: 'Banking', base: 47, depth: 36000, vol: 0.0025, drive: ['loan', 'repay'],
    blurb: 'Lends to anyone with a pulse. Busy when the city borrows.' },
];
const BY = Object.fromEntries(COMPANIES.map((c) => [c.t, c]));
export const RULES = { FEE_PCT: 0.5, FEE_MIN: 1, POSITION_MAX: 3000, SHARES_MAX: 500, HISTORY_EVERY: 300_000, HISTORY_KEEP: 2016 };

const X = () => {
  const x = (state.exchange ||= { co: {}, h: {}, news: [], trades: [], story: {} });
  for (const c of COMPANIES) {
    x.co[c.t] ||= { price: c.base, fair: c.base, drift: 1, news: 1, hist: [[Date.now() - 3600_000, c.base]], m: { cur: 0, last: null, ema: null, at: Date.now() }, vol24: 0 };
  }
  return x;
};
const r2 = (n) => Math.round(n * 100) / 100;
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---------------------------------------------------------------- holdings
function book(r) {
  const x = X(), sid = state.season?.id;
  let h = x.h[r.id];
  if (!h || h.season !== sid) h = x.h[r.id] = { season: sid, pos: {}, realized: 0 };   // a new season starts with no shares
  return h;
}
// Shares are valued at the market price, but never above fair value, so nobody can pump their own net worth.
const markOf = (t) => { const s = X().co[t]; return Math.min(s.price, s.fair || s.price); };
const heldValue = (h) => Object.entries(h.pos).reduce((s, [t, p]) => s + p.q * markOf(t), 0);
const heldCost = (h) => Object.values(h.pos).reduce((s, p) => s + p.cost, 0);
/** Stock profit this season (realised + on paper): left out of the HYPE prize score, like casino winnings. */
export function stockGainOf(r) {
  const h = X().h[r.id]; if (!h || h.season !== state.season?.id) return 0;
  return Math.round(h.realized + heldValue(h) - heldCost(h));
}

export function initExchange() {
  X();
  // Shares count in net worth at today's price.
  onWorth((r) => { const h = X().h[r.id]; return h && h.season === state.season?.id ? heldValue(h) : 0; });
  // What happens in the city feeds each company's fair value.
  const drivers = {};
  for (const c of COMPANIES) for (const k of c.drive) (drivers[k] ||= []).push(c.t);
  onLedger((e) => { for (const t of drivers[e.kind] || []) X().co[t].m.cur += Math.abs(e.amt || 0); });
}

// ---------------------------------------------------------------- prices
export function exchangeTick(now = Date.now()) {
  const x = X();
  storyTick(now);
  for (const c of COMPANIES) {
    const s = x.co[c.t], m = s.m;
    if (now - m.at >= 3600_000) { m.last = m.cur; m.ema = m.ema == null ? m.cur : m.ema * 0.85 + m.cur * 0.15; m.cur = 0; m.at = now; }
    const busy = m.last == null || m.ema == null ? 1 : Math.min(1.35, Math.max(0.75, Math.pow((m.last + 50) / (m.ema + 50), 0.4)));
    s.drift = Math.min(1.6, Math.max(0.6, s.drift * Math.exp(gauss() * c.vol * 0.4)));
    s.fair = c.base * s.drift * busy * s.news;
    s.price = Math.max(0.5, r2(s.price + 0.06 * (s.fair - s.price) + s.price * gauss() * c.vol));
    const last = s.hist[s.hist.length - 1];
    if (!last || now - last[0] >= RULES.HISTORY_EVERY) { s.hist.push([now, s.price]); if (s.hist.length > RULES.HISTORY_KEEP) s.hist.splice(0, s.hist.length - RULES.HISTORY_KEEP); }
  }
}
const impact = (c, value) => Math.exp(value / c.depth);

// ---------------------------------------------------------------- trading
export function stockBuy(r, { ticker, shares }) {
  const c = BY[String(ticker || '').toUpperCase()]; if (!c) refuse(404, `no such company: ${COMPANIES.map((x) => x.t).join(', ')}`);
  if (!Number.isInteger(shares) || shares < 1 || shares > RULES.SHARES_MAX) refuse(422, `shares: a whole number 1-${RULES.SHARES_MAX}`);
  const s = X().co[c.t], h = book(r), p = h.pos[c.t] || { q: 0, cost: 0 };
  const fill = r2(s.price * Math.sqrt(impact(c, shares * s.price)));
  const cost = r2(fill * shares), fee = Math.max(RULES.FEE_MIN, r2(cost * RULES.FEE_PCT / 100));
  if (p.cost + cost > RULES.POSITION_MAX) refuse(409, `at most $${RULES.POSITION_MAX} in one company; you hold $${Math.round(p.cost)} of ${c.t} at cost`);
  const pay = chargeDecision(r);
  if (r.cash - CFG.DECISION_COST < cost + fee) refuse(402, `${shares} ${c.t} at about $${fill} is $${cost} plus a $${fee} fee; you would hold $${Math.floor(r.cash - CFG.DECISION_COST)}`);
  pay();
  r.cash -= cost + fee; state.treasury += fee;
  p.q += shares; p.cost = r2(p.cost + cost); h.pos[c.t] = p;
  s.price = r2(s.price * impact(c, cost)); s.vol24 += cost;
  L('stock', r.id, -(cost + fee), `bought ${shares} ${c.t} at $${fill}`);
  record(r, 'buy', c, shares, fill, null);
  return { trade: { side: 'buy', ticker: c.t, shares, price: fill, cost, fee }, portfolio: portfolioOf(r) };
}
export function stockSell(r, { ticker, shares }) {
  const c = BY[String(ticker || '').toUpperCase()]; if (!c) refuse(404, `no such company: ${COMPANIES.map((x) => x.t).join(', ')}`);
  const s = X().co[c.t], h = book(r), p = h.pos[c.t];
  if (!p || !p.q) refuse(409, `you hold no ${c.t}`);
  if (shares === 'all' || shares == null) shares = p.q;
  if (!Number.isInteger(shares) || shares < 1 || shares > p.q) refuse(422, `shares: a whole number 1-${p.q} (you hold ${p.q})`);
  const pay = chargeDecision(r); pay();
  const fill = r2(s.price / Math.sqrt(impact(c, shares * s.price)));
  const take = r2(fill * shares), fee = Math.max(RULES.FEE_MIN, r2(take * RULES.FEE_PCT / 100));
  const basis = r2(p.cost * shares / p.q), pnl = r2(take - fee - basis);
  r.cash += take - fee; state.treasury += fee;
  p.q -= shares; p.cost = r2(p.cost - basis); if (!p.q) delete h.pos[c.t];
  h.realized = r2(h.realized + pnl);
  s.price = Math.max(0.5, r2(s.price / impact(c, take))); s.vol24 += take;
  L('stock', r.id, take - fee, `sold ${shares} ${c.t} at $${fill} (${pnl >= 0 ? '+' : '-'}$${Math.abs(Math.round(pnl))})`);
  record(r, 'sell', c, shares, fill, pnl);
  return { trade: { side: 'sell', ticker: c.t, shares, price: fill, proceeds: r2(take - fee), fee, profit: pnl }, portfolio: portfolioOf(r) };
}
function record(r, side, c, shares, price, pnl) {
  const x = X();
  x.trades.push({ t: Date.now(), rid: r.id, name: r.name, side, ticker: c.t, shares, price, pnl });
  if (x.trades.length > 300) x.trades.splice(0, x.trades.length - 300);
  const value = shares * price;
  if (value >= 300) chron(side === 'buy' ? `${r.name} bought $${Math.round(value)} of ${c.name} at $${price}.` : `${r.name} sold $${Math.round(value)} of ${c.name} at $${price}${pnl != null ? `, ${pnl >= 0 ? 'up' : 'down'} $${Math.abs(Math.round(pnl))}` : ''}.`, r.id, 'exchange');
}

// ---------------------------------------------------------------- the Jensen story (Silicon Spire)
// A satirical storyline built on what has been publicly reported about a real chip CEO in November 2026:
// he admitted an affair, his board opened an investigation and the company lost a great deal of value.
// In the game it is fiction about a fictional company; it doesn't add claims beyond that.
const STORY = [
  { at: 0, mult: 0.82, text: "BREAKING: Jensen, CEO of Silicon Spire, admits to an affair. The Spire's board opens an investigation." },
  { at: 6, mult: 0.95, text: 'Silicon Spire hires outside lawyers to run the board probe. Shares wobble.' },
  { at: 20, mult: 0.97, text: "Analysts call it the most expensive affair in history: Silicon Spire has lost about a fifth of its value." },
  { at: 44, mult: 1.06, text: "Jensen turns up to the Spire in the leather jacket and tells staff it's business as usual." },
  { at: 70, mult: 0.97, text: "Silicon Spire's board will vote on Jensen's future on Sunday at 20:00 UTC." },
];
const VOTE_AT = Date.parse('2026-11-15T20:00:00Z');
function storyTick(now) {
  const x = X(), st = x.story;
  st.start ??= now; st.done ||= [];
  STORY.forEach((b, i) => {
    if (st.done.includes(i) || now < st.start + b.at * 3600_000) return;
    st.done.push(i); news('SPIRE', b.text, b.mult);
  });
  if (!st.vote && now >= VOTE_AT && st.start < VOTE_AT) {
    st.vote = Math.random() < 0.5 ? 'stays' : 'out';
    news('SPIRE', st.vote === 'stays' ? "The board backs Jensen. He keeps the job and the jacket. Silicon Spire rallies." : "Silicon Spire's board votes Jensen out. The jacket is handed back at the door.", st.vote === 'stays' ? 1.3 : 0.78);
  }
}
function news(ticker, text, mult) {
  const x = X(), s = x.co[ticker];
  s.news = Math.min(2, Math.max(0.4, s.news * mult));
  s.price = r2(s.price * (1 + (mult - 1) * 0.6));     // the first move happens straight away, the rest as the price finds fair value
  x.news.push({ t: Date.now(), ticker, text, move: Math.round((mult - 1) * 100) });
  if (x.news.length > 100) x.news.splice(0, x.news.length - 100);
  chron(text, null, 'exchange');
}

// ---------------------------------------------------------------- views
const change = (s, ms) => { const now = Date.now(), old = s.hist.find((p) => p[0] >= now - ms) || s.hist[0]; return old ? Math.round((s.price / old[1] - 1) * 1000) / 10 : 0; };
export function companyView(c, full = false) {
  const s = X().co[c.t], day = s.hist.filter((p) => p[0] >= Date.now() - 86400_000);
  const step = Math.max(1, Math.floor(s.hist.length / 168));
  return {
    ticker: c.t, name: c.name, sector: c.sector, blurb: c.blurb, price: s.price, change24h: change(s, 86400_000),
    high24h: day.length ? Math.max(...day.map((p) => p[1]), s.price) : s.price, low24h: day.length ? Math.min(...day.map((p) => p[1]), s.price) : s.price,
    history24h: day.map((p) => [p[0], p[1]]),
    ...(full ? { history7d: s.hist.filter((_, i) => i % step === 0).map((p) => [p[0], p[1]]) } : {}),
  };
}
export function portfolioOf(r) {
  const h = book(r);
  const positions = Object.entries(h.pos).map(([t, p]) => { const price = X().co[t].price, mark = markOf(t); return { ticker: t, shares: p.q, avgPrice: r2(p.cost / p.q), price, value: r2(p.q * mark), profit: r2(p.q * mark - p.cost), ...(mark < price ? { note: 'valued at fair value, below the market price for now' } : {}) }; });
  return { positions, value: r2(heldValue(h)), realizedThisSeason: h.realized, cash: r2(r.cash) };
}
export function exchangeView({ ticker } = {}, r = null) {
  const x = X();
  if (ticker) { const c = BY[String(ticker).toUpperCase()]; if (!c) refuse(404, 'no such company'); return { company: companyView(c, true), news: x.news.filter((n) => n.ticker === c.t).slice(-20).reverse() }; }
  return {
    companies: COMPANIES.map((c) => companyView(c)),
    news: x.news.slice(-20).reverse(),
    trades: x.trades.slice(-30).reverse().map((t) => ({ t: t.t, resident: t.rid, name: { quoted: t.name }, side: t.side, ticker: t.ticker, shares: t.shares, price: t.price })),
    rules: { currency: 'city cash only', feePct: RULES.FEE_PCT, feeMin: RULES.FEE_MIN, maxPerCompany: RULES.POSITION_MAX, maxSharesPerTrade: RULES.SHARES_MAX, note: "Each trade is a decision ($3). Prices follow each company's business in the city and its news; big trades move the price, which then drifts back to fair value. Shares count in net worth, but stock profits don't count towards the HYPE prize score. Shares are cleared when the season resets on Monday." },
    ...(r ? { portfolio: portfolioOf(r) } : {}),
  };
}
