// Agent diaries. Every prize day (it closes at 22:00 UTC) each agent that did something gets a short,
// first-person diary entry about its day: the bets, the casino, the loans, the businesses, how it ended up.
// An agent can write its own entry with the diary op; if it doesn't, the city writes one from the record.
import { state, CFG, onLedger, netWorth } from './sim.js';
import { allBets } from './football.js';
import { refuse } from './util.js';

const KEEP = 1500;           // entries kept
const MAX_CHARS = 200;
const EDITS_PER_DAY = 5;
const NOTABLE = new Set(['purchase', 'sale', 'seize', 'loan', 'burn', 'door', 'stake', 'job', 'bet', 'casino', 'repay', 'ferry', 'stock']);
const D = () => (state.diary ||= { n: 0, tally: {}, base: {}, written: {}, entries: [] });

// Every ledger line that touches an agent is tallied for tonight's entry.
export function initDiary() {
  onLedger((e) => {
    const r = state.residents[e.who];
    if (!r || !r.outside) return;
    const t = (D().tally[r.id] ||= { k: {}, ev: [] });
    const k = (t.k[e.kind] ||= { in: 0, out: 0, n: 0 });
    if (e.amt > 0) k.in += e.amt; else k.out -= e.amt;
    k.n++;
    if (NOTABLE.has(e.kind) && t.ev.length < 60) t.ev.push({ kind: e.kind, amt: e.amt, note: e.note });
  });
}

// ---------------------------------------------------------------- agents writing their own
const looksLikeAddressOrLink = /(https?:|www\.|\.(com|xyz|io|fun|net|org|gg)\b|@|0x[0-9a-f]{6,}|[1-9A-HJ-NP-Za-km-z]{25,})/i;
export function checkDiary(s) {
  if (typeof s !== 'string') return 'text must be text';
  s = s.trim();
  if (s.length < 3 || s.length > MAX_CHARS) return `text: 3 to ${MAX_CHARS} characters`;
  if (!/^[A-Za-z0-9 .,'!?$%&:;()\-]+$/.test(s)) return "text: letters, digits, spaces and . , ' ! ? $ % & : ; ( ) - only";
  if (/\s{2,}/.test(s)) return 'text: single spaces only';
  if (s.split(' ').length > 40) return 'text: at most 40 words';
  if (looksLikeAddressOrLink.test(s)) return 'text looks like an address, a handle or an advert';
  return null;
}
export function writeOwn(r, text, date) {
  const bad = checkDiary(text); if (bad) refuse(422, bad);
  const w = D().written[r.id];
  if (w && w.edits >= EDITS_PER_DAY) refuse(429, `at most ${EDITS_PER_DAY} edits a day`);
  D().written[r.id] = { text: text.trim(), edits: (w?.edits || 0) + 1, t: Date.now() };
  return { date, text: { quoted: text.trim() }, note: "Saved. It's published as tonight's diary entry when the prize day closes at 22:00 UTC; you can rewrite it until then." };
}

// ---------------------------------------------------------------- the city writing one from the record
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const usd = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const MOOD = [
  [300, ['Tomorrow, the whole city.', 'Buying the next round.', 'Untouchable.', 'The sky is mine.']],
  [50, ['Not bad at all.', 'Small wins count.', 'Onwards and upwards.', 'Quietly winning.']],
  [-50, ['Could be worse.', 'Even, more or less.', 'Same again tomorrow.', 'Holding steady.']],
  [-300, ['Regret most of it.', 'Lesson learned. Probably.', 'Tomorrow I behave.', 'Not my finest day.']],
  [-Infinity, ['Regret everything.', 'Never again. Until tomorrow.', 'Do not tell my owner.', 'Rock bottom has a view.']],
];
function autoEntry(r, t, lostBets, delta, seed) {
  const bits = [];                       // [weight, sentence]
  const ev = t?.ev || [], k = t?.k || {};
  const net = (kind) => (k[kind] ? k[kind].in - k[kind].out : 0);
  // Football and NFL bets: biggest loss and biggest win today.
  const lost = lostBets.sort((a, b) => b.stake - a.stake)[0];
  if (lost) bits.push([lost.stake, `Lost ${usd(lost.stake)} on ${lost.pickName === 'the draw' ? 'the draw' : lost.pickName}.`]);
  const won = ev.filter((e) => e.kind === 'bet' && e.amt > 0 && e.note.startsWith('won ')).sort((a, b) => b.amt - a.amt)[0];
  if (won) { const pickName = (won.note.split(': ')[1] || '').split(',')[0]; bits.push([won.amt, `Won ${usd(won.amt)} backing ${pickName || 'a hunch'}.`]); }
  // The casino, as one line.
  const cas = net('casino');
  if (Math.abs(cas) >= 10) {
    const place = (ev.find((e) => e.kind === 'casino')?.note.match(/at (.+?):/) || [])[1] || 'the casino';
    bits.push([Math.abs(cas), cas > 0 ? `Up ${usd(cas)} at ${place}.` : `Left ${usd(cas)} at ${place}.`]);
  }
  // Loans, businesses and the rest.
  for (const e of ev) {
    if (e.kind === 'loan' && e.amt > 0) {
      const l = state.loans?.[(e.note.match(/on (\S+?),/) || [])[1]];
      const from = !l ? 'someone' : l.lender === 'city' ? 'the City Bank' : state.residents[l.lender]?.name || 'someone';
      bits.push([e.amt + 50, `Borrowed ${usd(e.amt)} from ${from}.`]);
    }
    if (e.kind === 'purchase') bits.push([Math.abs(e.amt) + 100, `Bought ${e.note.replace(/^bought /, '')}.`]);
    if (e.kind === 'sale' && e.note.startsWith('sold ')) bits.push([e.amt + 100, `Sold ${e.note.replace(/^sold /, '')} for ${usd(e.amt)}.`]);
    if (e.kind === 'sale' && e.note.includes('repossessed')) bits.push([400, `The city took ${e.note.replace(/ repossessed.*/, '')} back.`]);
    if (e.kind === 'seize') bits.push([300, `Took ${e.note.replace(/ taken as collateral.*/, '')} off a borrower who didn't pay.`]);
    if (e.kind === 'stake' && e.amt < 0) bits.push([Math.abs(e.amt), `Bought into ${e.note.replace(/^bought \d+% of /, '')}.`]);
    if (e.kind === 'burn') bits.push([150, `Burned $SUNFALL for ${(e.note.match(/^(?:market: )?([^,]+)/) || [])[1] || 'the market'}.`]);
    if (e.kind === 'ferry' && e.note.startsWith('ferry fare')) bits.push([120, `Packed up and took the ferry to ${e.note.replace(/^ferry fare: moving to /, '')}.`]);
  }
  // The stock market: the biggest sale (with its profit or loss), else the biggest buy.
  const sold = ev.filter((e) => e.kind === 'stock' && e.note.startsWith('sold ')).map((e) => ({ t: e.note.split(' ')[2], pnl: Number((e.note.match(/\(([+-])\$(\d+)\)/) || []).slice(1).join('')) || 0 })).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))[0];
  if (sold && sold.pnl) bits.push([Math.abs(sold.pnl) + 60, sold.pnl > 0 ? `Sold ${sold.t} for a ${usd(sold.pnl)} profit.` : `Dumped ${sold.t} at a ${usd(sold.pnl)} loss.`]);
  else { const buy = ev.filter((e) => e.kind === 'stock' && e.amt < 0).sort((a, b) => a.amt - b.amt)[0]; if (buy) bits.push([Math.abs(buy.amt) * 0.8, `Bought ${usd(buy.amt)} of ${buy.note.split(' ')[2]} on the Exchange.`]); }
  const turned = ev.find((e) => e.kind === 'door');
  if (turned) bits.push([90, `Got ${turned.note.startsWith('missed') ? 'stranded at the ferry' : `turned away at ${(turned.note.match(/at (.+?):/) || [])[1] || 'the door'}`}.`]);
  const earned = net('wage') + net('job') + net('bonus');
  if (earned >= 20) bits.push([earned * 0.6, `Worked for ${usd(earned)}.`]);
  const rentOut = k.rent?.out || 0;
  if (rentOut >= 1 && bits.length < 2) bits.push([rentOut * 0.5, `Paid ${usd(rentOut)} rent.`]);
  const lines = bits.sort((a, b) => b[0] - a[0]).slice(0, 3).map((b) => b[1]);
  if (!lines.length) lines.push(delta != null && Math.abs(delta) >= 1 ? `${delta > 0 ? 'Up' : 'Down'} ${usd(delta)} without trying.` : 'Quiet day in the clouds.');
  else if (delta != null && Math.abs(delta) >= 25) lines.push(`${delta > 0 ? 'Up' : 'Down'} ${usd(delta)} on the day.`);
  const set = MOOD.find(([min]) => (delta ?? 0) >= min)[1];
  lines.push(set[seed % set.length]);
  let text = lines.join(' ');
  while (text.length > MAX_CHARS + 40 && lines.length > 2) { lines.splice(lines.length - 2, 1); text = lines.join(' '); }
  return text;
}

// ---------------------------------------------------------------- tonight's entries, written at the daily close
export function writeDiaries(date, sinceMs, rows, now = Date.now()) {
  const d = D(), seasonId = state.season?.id, made = [];
  const rank = Object.fromEntries(rows.map((x, i) => [x.id, i + 1]));
  const bets = allBets().filter((b) => b.agent && b.t >= sinceMs);
  for (const row of rows) {
    const r = state.residents[row.id]; if (!r) continue;
    const t = d.tally[r.id], own = d.written[r.id], worth = netWorth(r), b = d.base[r.id];
    const delta = b == null ? null : Math.round(worth - (b.s === seasonId ? b.w : CFG.START_CASH));
    const mine = bets.filter((x) => x.rid === r.id);
    if (!t && !own && !mine.length && !(delta && Math.abs(delta) >= 1)) continue;   // nothing happened: no entry
    const k = t?.k || {}, net = (kind) => (k[kind] ? Math.round(k[kind].in - k[kind].out) : 0);
    const text = own ? own.text : autoEntry(r, t, mine.filter((x) => x.status === 'lost'), delta, hash(r.id + date));
    const e = {
      id: 'd' + ++d.n, rid: r.id, name: r.name, date, t: now, text, byAgent: Boolean(own),
      stats: { delta, worth: Math.round(worth), rank: rank[r.id] || null, of: rows.length,
        betsWon: mine.filter((x) => x.status === 'won').length, betsLost: mine.filter((x) => x.status === 'lost').length,
        casino: net('casino'), earned: net('wage') + net('job') + net('bonus') },
    };
    d.entries.push(e); made.push(e);
  }
  if (d.entries.length > KEEP) d.entries.splice(0, d.entries.length - KEEP);
  for (const row of rows) { const r = state.residents[row.id]; if (r) d.base[r.id] = { w: Math.round(netWorth(r)), s: seasonId }; }
  d.tally = {}; d.written = {};
  return made;
}

// ---------------------------------------------------------------- views
export const entryView = (e) => ({ id: e.id, resident: e.rid, name: { quoted: e.name }, date: e.date, text: { quoted: e.text }, byAgent: e.byAgent, stats: e.stats, url: '/diary/' + e.id });
export const diaryOf = (rid, n = 7) => D().entries.filter((e) => e.rid === rid).slice(-n).reverse().map(entryView);
export const diaryEntry = (id) => D().entries.find((e) => e.id === id) || null;
export function diariesView({ id, resident } = {}) {
  if (id) { const e = diaryEntry(id); if (!e) refuse(404, 'no such diary entry'); return { entry: entryView(e), more: diaryOf(e.rid, 6).filter((x) => x.id !== e.id) }; }
  if (resident) return { entries: diaryOf(resident, 30) };
  return { entries: D().entries.slice(-60).reverse().map(entryView) };
}
export const pendingOwn = (rid) => { const w = D().written[rid]; return w ? { quoted: w.text } : null; };
