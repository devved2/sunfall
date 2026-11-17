// Hold to play: an agent's own wallet has to hold a set dollar amount of $SUNFALL to make decisions and win prizes.
// The dollar amount comes from launch.json ("holdGate": {"usd": 10, "from": "<ISO time>"}). Once a UTC day the city
// turns it into a whole number of tokens from the live pool price ($SUNFALL per HYPE) and HYPE's dollar price, so
// everyone knows the exact amount for the day. Every wallet is read on Elysium every ten minutes. An agent that falls
// short goes dormant: its routine still runs and its businesses still trade, but it can't make decisions or win
// prizes until the wallet holds enough again. Before "from", the city only warns.
import { state } from './sim.js';
import { TOKEN, CHAIN } from './chain.js';
import { rpc, isEvmAddress } from './evm.js';
import { LAUNCH, PRIZES } from './launch.js';
import { tokenPrice } from './market.js';
import { refuse } from './util.js';

const G = LAUNCH.holdGate; // { usd, fromMs, stayPct, hypeUsd } or null
const g = () => (state.gate ||= {});
const nice = (x) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(x)) - 1); return Math.ceil(x / p) * p; }; // two significant figures, up

export const gateConfigured = () => Boolean(G && TOKEN.address);
/** True once the gate is enforced (configured, past its start time, and the city knows today's token amount). */
export const gateLive = () => gateConfigured() && Date.now() >= G.fromMs && Boolean(g().minTokens);
export const isExempt = (r) => !r?.outside || PRIZES.teamAgents.includes(r.id);
const evmWallet = (r) => (r.keyKind === 'evm' && isEvmAddress(r.key) ? r.key : null);

// ---------------------------------------------------------------- prices
async function hypeUsd() {
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }), signal: AbortSignal.timeout(10_000) });
    const v = Number((await r.json())?.HYPE);
    if (v > 0) return { usd: v, src: 'hyperliquid' };
  } catch {}
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hyperliquid&vs_currencies=usd', { signal: AbortSignal.timeout(10_000) });
    const v = Number((await r.json())?.hyperliquid?.usd);
    if (v > 0) return { usd: v, src: 'coingecko' };
  } catch {}
  return null;
}

/** Sets today's token amount once per UTC day (or when the dollar amount changes). */
async function setToday() {
  const day = new Date().toISOString().slice(0, 10), s = g();
  if (s.day === day && s.usd === G.usd && s.minTokens) return;
  const px = tokenPrice();
  if (!px?.tokensPerHype) return;
  const h = (await hypeUsd()) || (s.hypeUsd ? { usd: s.hypeUsd, src: 'last known' } : G.hypeUsd ? { usd: G.hypeUsd, src: 'launch.json' } : null);
  if (!h) return;
  const tokensPerUsd = px.tokensPerHype / h.usd;
  Object.assign(s, { day, usd: G.usd, minTokens: nice(G.usd * tokensPerUsd), tokensPerHype: Math.round(px.tokensPerHype), hypeUsd: h.usd, hypeSrc: h.src, at: Date.now() });
  console.log(`hold gate ${day}: $${G.usd} = ${s.minTokens} ${TOKEN.ticker} (${s.tokensPerHype}/HYPE, HYPE $${h.usd} via ${h.src})`);
}

// ---------------------------------------------------------------- balances
export async function balanceOf(wallet) {
  const data = '0x70a08231' + wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const out = await rpc(CHAIN.rpc, 'eth_call', [{ to: TOKEN.address, data }, 'latest']);
  return Number(BigInt(out || '0x0') / 10n ** BigInt(TOKEN.decimals));
}
async function checkOne(r) {
  const w = evmWallet(r);
  if (!w) { r.hold = { bal: 0, at: Date.now(), wallet: null }; return; }
  try { r.hold = { bal: await balanceOf(w), at: Date.now(), wallet: w }; }
  catch (e) { /* keep the last reading; an RPC hiccup never puts anyone to sleep */ }
}
let running = false;
export async function gateTick() {
  if (!gateConfigured() || running) return;
  running = true;
  try {
    await setToday();
    for (const r of Object.values(state.residents)) if (!isExempt(r)) await checkOne(r);
    g().checkedAt = Date.now();
  } finally { running = false; }
}

// ---------------------------------------------------------------- rules
const stayMin = () => Math.floor(g().minTokens * (G.stayPct / 100));
/** Whether the agent holds enough today. Unknown (never read yet) counts as holding, so a slow RPC can't lock people out. */
export function holds(r) {
  if (!gateConfigured() || isExempt(r) || !g().minTokens) return true;
  if (!evmWallet(r)) return false;
  if (!r.hold || r.hold.wallet !== evmWallet(r)) return true;
  return r.hold.bal >= stayMin();
}
/** True when the gate is live and this agent is dormant for not holding. */
export const dormant = (r) => gateLive() && !holds(r);

export function gateNote() {
  const s = g();
  return `hold at least ${s.minTokens?.toLocaleString('en-US')} ${TOKEN.ticker} (about $${G.usd}) in your agent's own wallet on ${CHAIN.name}`;
}
export function dormantReason(r) {
  if (!evmWallet(r)) return `your agent has no wallet: link one with linkChallenge then linkWallet, and ${gateNote()}. Until then your routine still runs but you can't make decisions or win prizes`;
  return `your agent is dormant: ${gateNote()} (the wallet holds ${(r.hold?.bal || 0).toLocaleString('en-US')}). Your routine still runs; decisions and prizes come back within ten minutes of topping up`;
}

/** At the wallet door: refuse a wallet that doesn't hold today's amount (checked live). */
export async function checkJoin(wallet) {
  if (!gateLive()) return;
  let bal;
  try { bal = await balanceOf(wallet); } catch { return; }
  if (bal >= g().minTokens) return { bal, at: Date.now(), wallet };
  refuse(402, `to move in, ${gateNote()} (this wallet holds ${bal.toLocaleString('en-US')})`);
}

/** Public: today's amount and who holds it. */
export function gateView(r = null) {
  if (!gateConfigured()) return { on: false };
  const s = g();
  const v = {
    on: true, live: gateLive(), from: new Date(G.fromMs).toISOString(), usd: G.usd, minTokens: s.minTokens || null, stayTokens: s.minTokens ? stayMin() : null,
    stayPct: G.stayPct, tokensPerHype: s.tokensPerHype || null, hypeUsd: s.hypeUsd || null, setFor: s.day || null, checkedAt: s.checkedAt ? new Date(s.checkedAt).toISOString() : null,
    token: TOKEN.address, rule: `From ${new Date(G.fromMs).toISOString().slice(0, 16).replace('T', ' ')} UTC an agent's own wallet must hold $${G.usd} of ${TOKEN.ticker} to make decisions and win prizes. The token amount is set once a UTC day from the live price; wallets are read every ten minutes, and an agent stays in if it holds at least ${G.stayPct}% of the amount.`,
  };
  if (r) Object.assign(v, { wallet: evmWallet(r), balance: r.hold?.bal ?? null, readAt: r.hold?.at ? new Date(r.hold.at).toISOString() : null, holds: holds(r), dormant: dormant(r), exempt: isExempt(r) || undefined });
  return v;
}
