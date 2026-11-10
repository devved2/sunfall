// The vault: every bit of real money Sunfall takes in, and exactly where it goes.
// Inflows (creator fees, service fees, compute, seeding) are split by a public policy into buckets:
// the weekly prize pot for players and $SUNFALL buy-and-burn. Every inflow and every payout is a line in the
// city's hash-chained ledger and carries the Elysium transaction that proves it. Amounts are in HYPE.
import { state, L } from './sim.js';
import { refuse } from './util.js';
import { TOKEN, CHAIN, TX_HASH_RE, hypeBalance, txUrl, addressUrl } from './chain.js';
import { isEvmAddress, checksum } from './evm.js';
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
export function recordFlow({ kind, source, use, amount, sol, tx, note, award }) {
  amount ??= sol; // older clients sent `sol`
  if (kind !== 'in' && kind !== 'out') refuse(422, 'kind must be in or out');
  if (!(typeof amount === 'number' && amount > 0 && amount < 1e7)) refuse(422, 'amount must be a positive number of HYPE');
  if (kind === 'in' && !SOURCES[source]) refuse(422, `source must be one of ${Object.keys(SOURCES).join(', ')}`);
  if (kind === 'out' && !VAULT.policy[use]) refuse(422, `use must be one of ${Object.keys(VAULT.policy).join(', ')}`);
  if (!TX_HASH_RE.test(tx || '')) refuse(422, 'tx must be the 0x Elysium transaction hash that proves it');
  if (v().entries.some((e) => e.tx.toLowerCase() === tx.toLowerCase() && e.kind === kind)) refuse(409, 'that transaction is already recorded');
  if (note != null && (typeof note !== 'string' || note.length > 140)) refuse(422, 'note: up to 140 characters');
  if (kind === 'out') {
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
  const e = { i: ++v().n, t: Date.now(), day: state.day, kind, source: source || null, use: use || null, amount: r4(amount), tx, note: note || (aw ? aw.label : null), award: aw ? aw.id : null };
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
  for (const [k, pct] of Object.entries(VAULT.policy)) {
    const owed = (inflow * pct) / 100;
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
  };
}

// ---------------------------------------------------------------- prize awards
// Every prize is turned into an exact HYPE amount for a named wallet the moment it is won, so it can be paid
// straight away and shown as paid (with its transaction) or still due.
const awards = () => (v().awards ||= []);
const prizePct = () => (VAULT.policy.prize || 0) / 100;
/** HYPE that reached the prize pot between two moments (by when the inflow was recorded). */
export function prizeAddedBetween(t0, t1) {
  return v().entries.filter((e) => e.kind === 'in' && e.t > t0 && e.t <= t1).reduce((s, e) => s + amt(e), 0) * prizePct();
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

export function checkAdmin(key) {
  if (!VAULT.adminKey) refuse(503, 'recording is off: set ADMIN_KEY on the server');
  if (key !== VAULT.adminKey) refuse(401, 'wrong admin key');
}
