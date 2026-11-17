// Hold to play, with tiers. An agent's own wallet has to hold a share of the $SUNFALL supply to make decisions and win
// prizes, and holding more puts it in a higher tier with small in-game edges (never HYPE, never prize points).
//
// The share needed falls as the market cap rises, in brackets, so the entry doesn't become unaffordable:
// 0.25% of supply under a $100k market cap, then 0.2%, 0.15% ... down to 0.025% from $5M. The amount only ever steps
// DOWN: the market cap has to stay above a bracket's line for a full 24 hours to unlock it, and a later fall never
// raises the amount again, so no holder is pushed out by a price drop. Tiers are fixed multiples of the entry.
//
// Small wallets can play too: a Starter holds at least a tenth of the entry and makes decisions as normal, but can't win
// HYPE prizes or get tier perks; prizes need the full entry. Wallets are read on Elysium every ten minutes. Below the
// Starter amount an agent goes dormant: its routine and businesses keep running, but it can't make decisions or win
// prizes until the wallet tops up. Its tier uses the LOWEST balance seen in
// the last 24 hours, so buying just before a reading and selling straight after gets you nothing.
// launch.json "holdGate": {"from": "<ISO time>", "brackets": [[mcapUsd, pct], ...], "tokens": fixed entry (optional)}.
import { state } from './sim.js';
import { TOKEN, CHAIN } from './chain.js';
import { rpc, isEvmAddress } from './evm.js';
import { LAUNCH, PRIZES } from './launch.js';
import { tokenPrice } from './market.js';
import { refuse } from './util.js';

const G = LAUNCH.holdGate; // { fromMs, brackets, tokens } or null
const g = () => (state.gate ||= {});
const SUPPLY = 1_000_000_000;
const DAY = 86400_000;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (n) => +(n / SUPPLY * 100).toFixed(4);

// ---------------------------------------------------------------- tiers
// Each tier needs this multiple of the entry. Perks are small on purpose and stop at Gold, so no wallet can buy
// its way to running the city; prize scores never count any of it.
export const TIERS = [
  { id: 'resident', name: 'Resident', mult: 1, decisions: 0, restartBonus: 0, robBonus: 0, upkeepOff: 0, earlyDays: 0, spins: 1 },
  { id: 'bronze', name: 'Bronze', mult: 2, decisions: 1, restartBonus: 100, robBonus: 0.02, upkeepOff: 0.05, earlyDays: 0, spins: 2 },
  { id: 'silver', name: 'Silver', mult: 4, decisions: 2, restartBonus: 200, robBonus: 0.04, upkeepOff: 0.10, earlyDays: 1, spins: 3 },
  { id: 'gold', name: 'Gold', mult: 8, decisions: 3, restartBonus: 350, robBonus: 0.06, upkeepOff: 0.15, earlyDays: 2, spins: 4 },
];
const STARTER = { id: 'starter', name: 'Starter', mult: 0, decisions: 0, restartBonus: 0, robBonus: 0, upkeepOff: 0, earlyDays: 0, spins: 0 };
const NONE = { id: null, name: null, mult: 0, decisions: 0, restartBonus: 0, robBonus: 0, upkeepOff: 0, earlyDays: 0, spins: 0 };

export const gateConfigured = () => Boolean(G && TOKEN.address);
export const isExempt = (r) => !r?.outside || PRIZES.teamAgents.includes(r.id);
const evmWallet = (r) => (r.keyKind === 'evm' && isEvmAddress(r.key) ? r.key : null);

/** The entry amount in whole tokens, from the unlocked bracket (or the fixed amount). */
export const entryTokens = () => (G?.tokens ? G.tokens : Math.round(SUPPLY * G.brackets[Math.min(g().bracket || 0, G.brackets.length - 1)][1] / 100));
export const tierTokens = () => TIERS.map((t) => t.mult * entryTokens());
/** The least a wallet can hold to play at all (as a Starter): a share of the entry, so it steps down with it. */
export const starterTokens = () => Math.round(entryTokens() * (G?.starterShare ?? 0.1));
/** Enforced once configured and past its start time. */
export const gateLive = () => gateConfigured() && Date.now() >= G.fromMs;

// ---------------------------------------------------------------- prices and the market cap
async function hypeUsd() {
  if (Number(process.env.HYPE_USD) > 0) return { usd: Number(process.env.HYPE_USD), src: 'env' };
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

/** Reads the market cap, logs it, and unlocks a lower bracket once the cap has held above its line for 24 hours. */
async function readMarket() {
  const s = g(), px = tokenPrice();
  if (!px?.tokensPerHype) return;
  const h = await hypeUsd();
  if (h) s.hypeUsd = h.usd;
  if (!s.hypeUsd) return;
  const mcap = (SUPPLY / px.tokensPerHype) * s.hypeUsd;
  const now = Date.now();
  s.mcapLog = [...(s.mcapLog || []).filter((x) => x.t > now - DAY - 3600_000), { t: now, mcap: Math.round(mcap) }];
  Object.assign(s, { mcap: Math.round(mcap), tokensPerHype: Math.round(px.tokensPerHype), priceAt: now });
  if (G.tokens) return;
  const day = s.mcapLog.filter((x) => x.t > now - DAY);
  const spans = s.mcapLog[0].t <= now - DAY + 15 * 60_000; // readings go back a full day
  if (!spans) return;
  const low = Math.min(...day.map((x) => x.mcap));
  let b = s.bracket || 0;
  while (b + 1 < G.brackets.length && low >= G.brackets[b + 1][0]) b++;
  if (b > (s.bracket || 0)) {
    console.log(`hold gate: market cap held above $${fmt(G.brackets[b][0])} for 24h; entry now ${G.brackets[b][1]}% of supply`);
    s.bracket = b; s.bracketAt = now;
  }
}

// ---------------------------------------------------------------- balances
export async function balanceOf(wallet) {
  const data = '0x70a08231' + wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const out = await rpc(CHAIN.rpc, 'eth_call', [{ to: TOKEN.address, data }, 'latest']);
  return Number(BigInt(out || '0x0') / 10n ** BigInt(TOKEN.decimals));
}
function record(r, bal, wallet) {
  const now = Date.now();
  if (r.hold?.wallet !== wallet) r.holdLog = [];
  r.hold = { bal, at: now, wallet };
  r.holdLog = [...(r.holdLog || []).filter((x) => x.t > now - DAY), { t: now, bal }];
}
async function checkOne(r) {
  const w = evmWallet(r);
  if (!w) { r.hold = { bal: 0, at: Date.now(), wallet: null }; r.holdLog = []; return; }
  try { record(r, await balanceOf(w), w); }
  catch { /* keep the last reading; an RPC hiccup never puts anyone to sleep */ }
}
let running = false;
export async function gateTick() {
  if (!gateConfigured() || running) return;
  running = true;
  try {
    try { await readMarket(); } catch (e) { console.error('hold gate market', e.message); }
    for (const r of Object.values(state.residents)) if (!isExempt(r)) await checkOne(r);
    g().checkedAt = Date.now();
  } finally { running = false; }
}

// ---------------------------------------------------------------- rules
/** Whether the agent's wallet holds at least `need` now. Never read yet counts as holding, so a slow RPC can't lock anyone out. */
function hasNow(r, need) {
  if (!gateConfigured() || isExempt(r)) return true;
  if (!evmWallet(r)) return false;
  if (!r.hold || r.hold.wallet !== evmWallet(r)) return true;
  return r.hold.bal >= need;
}
/** Holds enough to play (the Starter amount). */
export const holds = (r) => hasNow(r, starterTokens());
/** Holds the full entry: can win HYPE prizes. */
export const holdsEntry = (r) => hasNow(r, entryTokens());
/** True when the gate is live and this agent is dormant for holding less than the Starter amount. */
export const dormant = (r) => gateLive() && !holds(r);
/** Whether the hold rule lets this agent win prizes (always, until the gate is live). */
export const prizeReady = (r) => !gateLive() || holdsEntry(r);
/** The balance a tier is judged on: the lowest reading in the last 24 hours (and now). */
const tierBalance = (r) => Math.min(r.hold?.bal ?? 0, ...(r.holdLog || []).map((x) => x.bal));
/** The agent's tier and its perks. Only while the gate is live, and only for agents that hold the entry now. */
export function tierOf(r, preview = false) {
  if ((!preview && !gateLive()) || !gateConfigured() || !r?.outside || isExempt(r) || !evmWallet(r) || !r.hold || !holds(r)) return NONE;
  const bal = tierBalance(r), need = tierTokens();
  let t = NONE;
  if (!holdsEntry(r)) return STARTER; // plays, but no perks and no prizes
  for (let i = 0; i < TIERS.length; i++) if (bal >= need[i]) t = TIERS[i];
  return t === NONE ? TIERS[0] : t; // holds the entry now, but dipped under it in the last day: still a Resident
}

const amountLine = (n) => { const s = g(), usd = s.mcap ? Math.round(s.mcap * n / SUPPLY) : null; return `${fmt(n)} ${TOKEN.ticker} (${pct(n)}% of supply${usd ? `, about $${usd} today` : ''})`; };
export function gateNote() {
  return `hold at least ${amountLine(starterTokens())} in your agent's own wallet on ${CHAIN.name} to play, and ${amountLine(entryTokens())} to win HYPE prizes`;
}
export function dormantReason(r) {
  if (!evmWallet(r)) return `your agent has no wallet: link one with linkChallenge then linkWallet, and ${gateNote()}. Until then your routine still runs but you can't make decisions or win prizes`;
  return `your agent is dormant: ${gateNote()} (the wallet holds ${fmt(r.hold?.bal || 0)}). Your routine still runs; decisions come back within ten minutes of topping up`;
}

/** At the wallet door: refuse a wallet that doesn't hold the entry (checked live). */
export async function checkJoin(wallet) {
  if (!gateLive()) return;
  let bal;
  try { bal = await balanceOf(wallet); } catch { return; }
  if (bal >= starterTokens()) return { bal, wallet };
  refuse(402, `to move in, ${gateNote()} (this wallet holds ${fmt(bal)})`);
}
/** Record the reading taken at the door, so a new agent starts with its true balance. */
export const recordJoin = (r, reading) => { if (reading) record(r, reading.bal, reading.wallet); };

const perkLine = (t) => [
  t.decisions && `+${t.decisions} decision${t.decisions > 1 ? 's' : ''} an hour`,
  t.restartBonus && `+$${t.restartBonus} at each season reset (not counted in the prize score)`,
  t.robBonus && `+${Math.round(t.robBonus * 100)} points on robbery and crew odds`,
  t.upkeepOff && `${Math.round(t.upkeepOff * 100)}% off upkeep`,
  t.earlyDays && `buys relisted businesses ${t.earlyDays} city day${t.earlyDays > 1 ? 's' : ''} early after a reset`,
  t.spins && `${t.spins} daily wheel spin${t.spins > 1 ? 's' : ''} (when the wheel opens)`,
].filter(Boolean).join('; ') || (t.id === 'starter' ? 'plays and makes decisions as normal; no HYPE prizes and no tier perks until the wallet holds the entry' : '');

/** Public: the amounts, the brackets, the tiers, and (with a resident) its own reading and tier. */
export function gateView(r = null) {
  if (!gateConfigured()) return { on: false };
  const s = g(), e = entryTokens(), need = tierTokens(), b = s.bracket || 0;
  const usdOf = (n) => (s.mcap ? Math.round(s.mcap * n / SUPPLY) : null);
  const v = {
    on: true, live: gateLive(), from: new Date(G.fromMs).toISOString(), token: TOKEN.address,
    starter: { tokens: starterTokens(), pctOfSupply: pct(starterTokens()), usdToday: usdOf(starterTokens()), note: 'the least a wallet can hold to play; Starters can\'t win HYPE prizes' },
    entry: { tokens: e, pctOfSupply: pct(e), usdToday: usdOf(e), note: 'needed to win HYPE prizes and for the tiers' },
    tiers: TIERS.map((t, i) => ({ id: t.id, name: t.name, tokens: need[i], pctOfSupply: pct(need[i]), usdToday: usdOf(need[i]), perks: perkLine(t) })),
    marketCapUsd: s.mcap || null, tokensPerHype: s.tokensPerHype || null, hypeUsd: s.hypeUsd || null,
    brackets: G.tokens ? null : G.brackets.map(([cap, p], i) => ({ fromMarketCapUsd: cap, entryPctOfSupply: p, entryTokens: Math.round(SUPPLY * p / 100), unlocked: i <= b, current: i === b })),
    checkedAt: s.checkedAt ? new Date(s.checkedAt).toISOString() : null,
    rule: `From ${new Date(G.fromMs).toISOString().slice(0, 16).replace('T', ' ')} UTC an agent's own wallet must hold ${fmt(starterTokens())} ${TOKEN.ticker} (${pct(starterTokens())}% of supply) to play as a Starter, and ${fmt(e)} (${pct(e)}% of supply) to win HYPE prizes. `
      + (G.tokens ? '' : 'The share needed steps down as the market cap grows (it must hold above the next line for 24 hours) and never steps back up. ')
      + 'Holding 2x, 4x and 8x the entry makes an agent Bronze, Silver or Gold, with small in-game edges; a tier is judged on the lowest balance in the last 24 hours. Wallets are read every ten minutes. Tiers never pay HYPE or add to the prize score.',
  };
  if (r) {
    const t = tierOf(r, true);
    Object.assign(v, { wallet: evmWallet(r), balance: r.hold?.bal ?? null, lowest24h: r.hold ? tierBalance(r) : null, readAt: r.hold?.at ? new Date(r.hold.at).toISOString() : null,
      holds: holds(r), holdsEntry: holdsEntry(r), canWinPrizes: prizeReady(r), dormant: dormant(r), tier: t.id, tierName: t.name, myPerks: t.id ? perkLine(t) : null, exempt: isExempt(r) || undefined });
  }
  return v;
}
