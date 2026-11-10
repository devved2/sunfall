// The Market: owners buy things for their agents by burning $SUNFALL. The city never takes the tokens; they go
// to 0x…dEaD from the buyer's own wallet, and the city checks the burn on Elysium before handing anything over.
// Any wallet can buy for any agent (a gift works too). Every sale is public, with its transaction.
import { state, L, chron } from './sim.js';
import { TOKEN, CHAIN, verifyBurn, TX_HASH_RE, txUrl } from './chain.js';
import { MARKET_PRICES } from './launch.js';
import { checkSentence, ut, refuse } from './util.js';

export const ITEMS = {
  decisions: { name: 'Extra decisions', blurb: 'Ten decisions on top of the hourly limit, used only once the limit is reached. They never expire.' },
  storm: { name: 'Storm cover', blurb: 'For the next 7 city days, jobs your agent took still pay out if a storm shuts the venue.' },
  badge: { name: 'Gold badge', blurb: 'A gold badge beside your agent on every leaderboard until the season ends.' },
  billboard: { name: 'Billboard line', blurb: 'One line of your words on the city billboard for a city day, in the next free slot.', needsText: true },
};
const m = () => (state.market ||= { sales: [], burnt: 0 });
const usedTx = (tx) => m().sales.some((s) => s.tx.toLowerCase() === tx.toLowerCase()) || (state.billboards || []).some((b) => b.tx.toLowerCase() === tx.toLowerCase());

export function marketView() {
  const s = m();
  return {
    live: Boolean(TOKEN.address), token: TOKEN.ticker, tokenAddress: TOKEN.address, decimals: TOKEN.decimals,
    chain: { name: CHAIN.name, id: CHAIN.id, rpc: CHAIN.rpc, explorer: CHAIN.explorer },
    burnTo: '0x000000000000000000000000000000000000dEaD',
    items: Object.entries(ITEMS).map(([id, it]) => ({ id, name: it.name, blurb: it.blurb, price: MARKET_PRICES[id], needsText: Boolean(it.needsText) })),
    burnt: s.burnt, sales: s.sales.length,
    recent: s.sales.slice(-20).reverse().map((x) => ({ ...x, name: ut(x.name), txUrl: txUrl(x.tx) })),
  };
}

/** Apply a purchase once its burn is confirmed on chain. */
export async function marketBuy({ item, resident, tx, text }) {
  if (!TOKEN.address) refuse(503, 'the Market opens when the token is live');
  const it = ITEMS[item];
  if (!it) refuse(400, `item must be one of ${Object.keys(ITEMS).join(', ')}`);
  const r = state.residents[resident];
  if (!r || !r.outside) refuse(404, 'resident must be the id of an agent in the city (e.g. r242)');
  if (!TX_HASH_RE.test(tx || '')) refuse(400, 'tx must be the 0x hash of your burn transaction');
  if (it.needsText) { if (typeof text !== 'string' || !text.trim()) refuse(422, 'a billboard line needs its text'); const bad = checkSentence(text, 'text'); if (bad) refuse(422, bad); }
  if (usedTx(tx)) refuse(409, 'that burn has already been used');
  const price = MARKET_PRICES[item];
  const res = await verifyBurn(tx, null, price);
  if (!res.ok) refuse(422, res.reason);
  if (usedTx(tx)) refuse(409, 'that burn has already been used'); // checked again after the wait on chain
  r.perks ||= {};
  let note;
  if (item === 'decisions') { r.perks.decisions = (r.perks.decisions || 0) + 10; note = `${r.perks.decisions} extra decisions banked`; }
  if (item === 'storm') { r.perks.stormUntil = Math.max(r.perks.stormUntil ?? -1, state.day) + 7; note = `storm cover until city day ${r.perks.stormUntil}`; }
  if (item === 'badge') { r.perks.badge = state.season?.id || true; note = 'gold badge for this season'; }
  if (item === 'billboard') {
    state.billboards ||= [];
    const day = Math.max(state.day + 1, ...state.billboards.map((x) => x.day + 1));
    state.billboards.push({ day, who: r.id, name: r.name, text, tx, burnt: res.amount });
    note = `billboard on city day ${day}`;
  }
  const sale = { t: Date.now(), day: state.day, item, itemName: it.name, rid: r.id, name: r.name, from: res.from, burnt: res.amount, tx, note };
  m().sales.push(sale); m().burnt += res.amount;
  if (m().sales.length > 2000) m().sales.splice(0, m().sales.length - 2000);
  L('burn', r.id, 0, `market: ${it.name}, ${res.amount} ${TOKEN.ticker} burnt, tx ${tx.slice(0, 14)}`);
  chron(`${r.name} picked up ${it.name.toLowerCase()} at the Market: ${res.amount.toLocaleString()} ${TOKEN.ticker} burnt.`, r.id, 'market');
  return { sale: { ...sale, name: ut(sale.name), txUrl: txUrl(tx) } };
}
