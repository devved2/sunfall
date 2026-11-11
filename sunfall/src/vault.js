// The vault: every bit of real money Sunfall takes in, and exactly where it goes.
// Inflows (creator fees, service fees, compute, seeding) are split by a public policy into buckets:
// the weekly prize pot for players and $SUNFALL buy-and-burn. Every inflow and every payout is a line in the
// city's hash-chained ledger and carries the Elysium transaction that proves it. Amounts are in HYPE.
import { state, L } from './sim.js';
import { refuse } from './util.js';
import { TOKEN, CHAIN, TX_HASH_RE, hypeBalance, txUrl, addressUrl } from './chain.js';
import { isEvmAddress, checksum, rpc } from './evm.js';
import { LAUNCH } from './launch.js';

const parsePolicy = (s) => Object.fromEntries(String(s).split(',').map((kv) => kv.split(':')).map(([k, v]) => [k.trim(), Number(v)]));
export const VAULT = {
  wallet: isEvmAddress(process.env.VAULT_WALLET || LAUNCH.vaultWallet || '') ? checksum(process.env.VAULT_WALLET || LAUNCH.vaultWallet) : null,
  policy: parsePolicy(process.env.VAULT_POLICY || LAUNCH.vaultPolicy || 'prize:70,buyback:30'),
  prizeMin: Number(process.env.PRIZE_MIN_HYPE || 1),
  adminKey: process.env.ADMIN_KEY || null,
};
{
  const total = Object.values(VAULT.policy).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 100) > 0.001) throw new Error(`VAULT_POLICY must add up to 100 (got ${total})`);
}
export const SOURCES = {
  creator_fees: 'Creator fees from $SUNFALL trading',
  seed: 'Seeded by the team',
  service_fees: 'Fees on paid agent services',
  compute: 'Owners buying better AI for their agents',
  season_entry: 'Season entries',
  other: 'Other',
};
export const USES = { prize: 'Prize pot for players', buyback: `${TOKEN.ticker} buyback & burn`, burn: `${TOKEN.ticker} burns`, ops: 'Team' };

const v = () => (state.vault ||= { entries: [], n: 0 });
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const amt = (e) => e.amount ?? e.sol ?? 0;

/** Record a flow. kind 'in' needs a source; kind 'out' needs a use (a bucket). Amounts in HYPE. */
export function recordFlow({ kind, source, use, amount, sol, tx, note, award, to, overdraw }) {
  amount ??= sol; // older clients sent `sol`
  if (kind !== 'in' && kind !== 'out') refuse(422, 'kind must be in or out');
  if (!(typeof amount === 'number' && amount > 0 && amount < 1e7)) refuse(422, 'amount must be a positive number of HYPE');
  if (kind === 'in' && !SOURCES[source]) refuse(422, `source must be one of ${Object.keys(SOURCES).join(', ')}`);
  if (kind === 'out' && !VAULT.policy[use]) refuse(422, `use must be one of ${Object.keys(VAULT.policy).join(', ')}`);
  if (to != null && (kind !== 'in' || !VAULT.policy[to])) refuse(422, `to: an inflow can go all to one of ${Object.keys(VAULT.policy).join(', ')}`);
  if (!TX_HASH_RE.test(tx || '')) refuse(422, 'tx must be the 0x Elysium transaction hash that proves it');
  if (v().entries.some((e) => e.tx.toLowerCase() === tx.toLowerCase() && e.kind === kind)) refuse(409, 'that transaction is already recorded');
  if (note != null && (typeof note !== 'string' || note.length > 140)) refuse(422, 'note: up to 140 characters');
  if (kind === 'out' && !overdraw) {
    const s = summary();
    const avail = s.buckets[use].pending;
    if (amount > avail + 1e-9) refuse(422, `the ${use} bucket only has ${avail} HYPE owed to it`);
  }
  let aw = null;
  if (award != null) {
    aw = awards().find((a) => a.id === award);
    if (!aw) refuse(404, `no prize award ${award}`);
    if (kind !== 'out' || use !== 'prize') refuse(422, 'an award is paid as kind out, use prize');
    if (aw.tx) refuse(409, `award ${award} is already paid (tx ${aw.tx})`);
    if (Math.abs(amount - aw.hype) > 1e-6) refuse(422, `award ${award} is ${aw.hype} HYPE, not ${amount}`);
  }
  const e = { i: ++v().n, t: Date.now(), day: state.day, kind, source: source || null, use: use || null, to: to || null, amount: r4(amount), tx, note: note || (aw ? aw.label : null), award: aw ? aw.id : null };
  v().entries.push(e);
  if (aw) { aw.tx = tx; aw.paidAt = e.t; }
  L('vault', 'vault', kind === 'in' ? e.amount : -e.amount, `${kind === 'in' ? `in: ${source}` : `out: ${use}`} ${e.amount} HYPE, tx ${tx.slice(0, 14)}`);
  return e;
}

export function summary() {
  const es = v().entries;
  const inflow = es.filter((e) => e.kind === 'in').reduce((a, e) => a + amt(e), 0);
  const bySource = {};
  for (const e of es) if (e.kind === 'in') bySource[e.source] = r4((bySource[e.source] || 0) + amt(e));
  const buckets = {};
  // An inflow marked "to" goes wholly to that bucket; the rest is split by the policy.
  const split = es.filter((e) => e.kind === 'in' && !e.to).reduce((a, e) => a + amt(e), 0);
  for (const [k, pct] of Object.entries(VAULT.policy)) {
    const owed = (split * pct) / 100 + es.filter((e) => e.kind === 'in' && e.to === k).reduce((a, e) => a + amt(e), 0);
    const paid = es.filter((e) => e.kind === 'out' && e.use === k).reduce((a, e) => a + amt(e), 0);
    buckets[k] = { pct, label: USES[k] || k, owed: r4(owed), paid: r4(paid), pending: r4(Math.max(0, owed - paid)) };
  }
  // Prize money already promised to named winners but not yet sent is held back from the free pot.
  if (buckets.prize) {
    const committed = r4(awards().filter((a) => !a.tx).reduce((s, a) => s + a.hype, 0));
    buckets.prize.committed = committed;
    buckets.prize.free = r4(Math.max(0, buckets.prize.pending - committed));
  }
  return {
    inflow: r4(inflow), outflow: r4(es.filter((e) => e.kind === 'out').reduce((a, e) => a + amt(e), 0)),
    bySource, buckets, sources: SOURCES,
    milestone: { label: 'First weekly prize unlocks', target: VAULT.prizeMin, unit: 'HYPE', have: buckets.prize ? buckets.prize.pending : 0 },
  };
}

// On-chain HYPE balance of the vault wallet, cached for a minute.
let balCache = { t: 0, v: null };
async function walletBalance() {
  if (!VAULT.wallet) return null;
  if (Date.now() - balCache.t < 60_000) return balCache.v;
  try { balCache = { t: Date.now(), v: await hypeBalance(VAULT.wallet) }; } catch { balCache = { t: Date.now(), v: null }; }
  return balCache.v;
}

export async function vaultView() {
  return {
    chain: { name: CHAIN.name, id: CHAIN.id, unit: CHAIN.gas, explorer: CHAIN.explorer },
    wallet: VAULT.wallet, walletUrl: VAULT.wallet ? addressUrl(VAULT.wallet) : null, walletBalance: await walletBalance(),
    token: TOKEN.ticker, tokenAddress: TOKEN.address, tokenUrl: TOKEN.address ? addressUrl(TOKEN.address) : null,
    policy: VAULT.policy, uses: USES, ...summary(),
    entries: v().entries.slice(-150).reverse().map((e) => ({ ...e, amount: amt(e), txUrl: txUrl(e.tx) })),
    awards: recentAwards(),
    ...(() => { const bal = balCache.v; const pot = summary().buckets.prize?.pending || 0; return bal == null ? {} : { prizeCovered: bal + 0.01 >= pot, prizeShortBy: Math.max(0, Math.round((pot - bal) * 1e4) / 1e4) // 0.01 HYPE slack for gas }; })(),
  };
}

// ---------------------------------------------------------------- prize awards
// Every prize is turned into an exact HYPE amount for a named wallet the moment it is won, so it can be paid
// straight away and shown as paid (with its transaction) or still due.
const awards = () => (v().awards ||= []);
const prizePct = () => (VAULT.policy.prize || 0) / 100;
/** HYPE that reached the prize pot between two moments (by when the inflow was recorded). */
export function prizeAddedBetween(t0, t1) {
  // a seed can be recorded early but count for the prize day it was meant for (countsFrom)
  return v().entries.filter((e) => e.kind === 'in' && (e.countsFrom ?? e.t) > t0 && (e.countsFrom ?? e.t) <= t1).reduce((s, e) => s + (e.to ? (e.to === 'prize' ? amt(e) : 0) : amt(e) * prizePct()), 0);
}
export function freePrizePot() { return summary().buckets.prize?.free || 0; }
/** Create awards for a list of winners [{place, sharePct, id, name, wallet}] from a pot of HYPE. Shares of empty places stay in the pot. */
export function grantAwards(kind, key, pot, winners, labelOf) {
  const made = [];
  for (const w of winners) {
    const hype = Math.floor(pot * w.sharePct / 100 * 1e6) / 1e6;
    if (!(hype > 0) || !w.wallet) continue;
    const a = { id: `${kind === 'daily' ? 'd' : 'w'}:${key}:${w.place}`, kind, key, place: w.place, rid: w.id, name: w.name, wallet: w.wallet, hype, t: Date.now(), tx: null, label: labelOf(w) };
    if (awards().some((x) => x.id === a.id)) continue;
    awards().push(a); made.push(a);
  }
  const unpaid = awards().filter((a) => !a.tx), paid = awards().filter((a) => a.tx);
  if (paid.length > 600) v().awards = [...paid.slice(-600), ...unpaid];
  if (made.length) L('vault', 'vault', 0, `${kind} prizes ${key}: ${made.map((a) => `${a.rid} ${a.hype} HYPE`).join(', ')}`);
  return made;
}
export const dueAwards = () => awards().filter((a) => !a.tx);
export const recentAwards = (n = 40) => awards().slice(-n).reverse().map((a) => ({ id: a.id, kind: a.kind, key: a.key, place: a.place, rid: a.rid, name: a.name, wallet: a.wallet, hype: a.hype, tx: a.tx, txUrl: a.tx ? txUrl(a.tx) : null }));

// ---------------------------------------------------------------- creator fees, recorded automatically
// Every time the Vault wallet claims $SUNFALL creator fees, the launchpad logs the claim (launch.json "feeClaims").
// The city reads those logs from Elysium and records each claim as an inflow, with its transaction as proof,
// so the prize pot fills without anyone typing amounts in. Claims before "from" are left out.
const CHUNK = 200_000;
let scanning = false;
// A one-off top-up (launch.json "vaultSeed"): recorded once, at its start time, e.g. HYPE already in the wallet put to prizes.
function applySeed() {
  const sd = LAUNCH.vaultSeed;
  if (!sd || Date.now() < sd.atMs) return;
  const had = v().entries.find((e) => e.kind === 'in' && e.seedId === sd.id);
  if (had) { if (sd.countsFromMs && had.countsFrom !== sd.countsFromMs) had.countsFrom = sd.countsFromMs; return; } // a moved start date applies to the recorded seed too
  try { const e = recordFlow({ kind: 'in', source: 'seed', amount: sd.amount, tx: sd.tx, note: sd.note, to: sd.to }); e.seedId = sd.id; if (sd.countsFromMs > e.t) e.countsFrom = sd.countsFromMs; }
  catch (err) { console.error('vault seed', err.message); }
}
// ---------------------------------------------------------------- money out, recorded automatically
// Every transaction the Vault wallet sends is found by its nonce (a binary search on the nonce over blocks), then:
// a payment to a winner's wallet for the HYPE they're owed marks that prize paid; anything else that moves HYPE
// is recorded as team spending, labelled with where it went (launch.json "outScan": {fromNonce, labels}).
let scanningOut = false;
const hx = (n) => '0x' + n.toString(16);
export async function scanOutflows() {
  const os = LAUNCH.outScan;
  if (!os || !VAULT.wallet || scanningOut) return 0;
  scanningOut = true;
  let added = 0;
  try {
    const st = (v().outScan ||= { nonce: os.fromNonce, block: null });
    const W = VAULT.wallet.toLowerCase();
    const nonceAt = async (b) => parseInt(await rpc(CHAIN.rpc, 'eth_getTransactionCount', [VAULT.wallet, hx(b)]), 16);
    const head = parseInt(await rpc(CHAIN.rpc, 'eth_blockNumber', []), 16);
    const nNow = await nonceAt(head);
    if (nNow <= st.nonce) return 0;
    let lo0 = st.block ?? Math.max(0, head - 3_000_000);
    if (await nonceAt(lo0) > st.nonce) lo0 = 0;
    for (let k = st.nonce; k < nNow; k++) {
      let lo = lo0, hi = head; // nonceAt(lo) <= k < nonceAt(hi): the tx with nonce k is in block hi
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (await nonceAt(mid) > k) hi = mid; else lo = mid; }
      const b = await rpc(CHAIN.rpc, 'eth_getBlockByNumber', [hx(hi), true]);
      const tx = (b?.transactions || []).find((t) => t.from?.toLowerCase() === W && parseInt(t.nonce, 16) === k);
      if (tx) {
        const rc = await rpc(CHAIN.rpc, 'eth_getTransactionReceipt', [tx.hash]);
        if (rc?.status === '0x1') { try { added += recordOut(tx); } catch (e) { console.error('vault out', tx.hash, e.message); } }
      }
      st.nonce = k + 1; st.block = hi; lo0 = hi;
    }
  } finally { scanningOut = false; }
  return added;
}
function recordOut(tx) {
  const value = Number(BigInt(tx.value) / 10n ** 12n) / 1e6;
  if (!(value > 0)) return 0; // contract calls such as fee claims move no HYPE out
  if (v().entries.some((e) => e.kind === 'out' && e.tx.toLowerCase() === tx.hash.toLowerCase())) return 0;
  const to = (tx.to || '').toLowerCase();
  const aw = awards().find((a) => !a.tx && a.wallet.toLowerCase() === to && Math.abs(a.hype - value) <= Math.max(1e-5, a.hype * 0.01));
  if (aw) { recordFlow({ kind: 'out', use: 'prize', amount: aw.hype, tx: tx.hash, award: aw.id }); return 1; }
  const label = (LAUNCH.outScan.labels || {})[to] || `sent to ${to.slice(0, 6)}…${to.slice(-4)}`;
  recordFlow({ kind: 'out', use: 'ops', amount: value, tx: tx.hash, note: `${label} (recorded automatically)`, overdraw: true });
  return 1;
}

export async function scanFeeClaims() {
  applySeed();
  scanOutflows().catch((e) => console.error('vault out scan', e.message));
  const fc = LAUNCH.feeClaims;
  if (!fc || !VAULT.wallet || scanning) return 0;
  scanning = true;
  let added = 0;
  try {
    const st = (v().feeScan ||= { block: null });
    const head = parseInt(await rpc(CHAIN.rpc, 'eth_blockNumber', []), 16);
    let from = st.block == null ? Math.max(0, head - 1_000_000) : st.block + 1; // first run: look back ~40 hours
    const who = '0x' + VAULT.wallet.slice(2).toLowerCase().padStart(64, '0');
    const times = new Map();
    while (from <= head) {
      const to = Math.min(head, from + CHUNK - 1);
      const logs = await rpc(CHAIN.rpc, 'eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), address: fc.contract, topics: [fc.event, fc.pool, who] }], 20_000);
      for (const l of logs) {
        if (l.removed) continue;
        let t = times.get(l.blockNumber);
        if (t == null) { t = parseInt((await rpc(CHAIN.rpc, 'eth_getBlockByNumber', [l.blockNumber, false])).timestamp, 16) * 1000; times.set(l.blockNumber, t); }
        if (t < fc.fromMs) continue;
        if (v().entries.some((e) => e.kind === 'in' && e.tx.toLowerCase() === l.transactionHash.toLowerCase())) continue;
        const hype = Number(BigInt(l.data.slice(0, 66)) / 10n ** 12n) / 1e6;
        if (!(hype > 0)) continue;
        try { recordFlow({ kind: 'in', source: 'creator_fees', amount: hype, tx: l.transactionHash, note: 'creator fees claimed (recorded automatically)' }); added++; }
        catch (e) { console.error('fee claim', l.transactionHash, e.message); }
      }
      st.block = to;
      from = to + 1;
    }
  } finally { scanning = false; }
  return added;
}

export function checkAdmin(key) {
  if (!VAULT.adminKey) refuse(503, 'recording is off: set ADMIN_KEY on the server');
  if (key !== VAULT.adminKey) refuse(401, 'wrong admin key');
}
