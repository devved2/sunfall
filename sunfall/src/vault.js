// The vault: every bit of real money Sunfall takes in, and exactly where it goes.
// Inflows (creator fees, service fees, compute, seeding) are split by a public policy into buckets:
// the weekly prize pot, $SUNFALL buybacks, and burns. Every inflow and every payout is a line in the
// city's hash-chained ledger and carries the Solana transaction that proves it.
import { state, L } from './sim.js';
import { refuse, isSolanaAddress } from './util.js';
import { TOKEN } from './chain.js';

const parsePolicy = (s) => Object.fromEntries(String(s).split(',').map((kv) => kv.split(':')).map(([k, v]) => [k.trim(), Number(v)]));
export const VAULT = {
  wallet: process.env.VAULT_WALLET || null,
  policy: parsePolicy(process.env.VAULT_POLICY || 'prize:50,buyback:30,burn:20'),
  prizeMinSol: Number(process.env.PRIZE_MIN_SOL || 1),
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
export const USES = { prize: 'Weekly prize pot', buyback: `${TOKEN.ticker} buybacks`, burn: `${TOKEN.ticker} burns` };

const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const v = () => (state.vault ||= { entries: [], n: 0 });
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** Record a flow. kind 'in' needs a source; kind 'out' needs a use (a bucket). Amounts in SOL. */
export function recordFlow({ kind, source, use, sol, tx, note }) {
  if (kind !== 'in' && kind !== 'out') refuse(422, 'kind must be in or out');
  if (!(typeof sol === 'number' && sol > 0 && sol < 1e6)) refuse(422, 'sol must be a positive number');
  if (kind === 'in' && !SOURCES[source]) refuse(422, `source must be one of ${Object.keys(SOURCES).join(', ')}`);
  if (kind === 'out' && !VAULT.policy[use]) refuse(422, `use must be one of ${Object.keys(VAULT.policy).join(', ')}`);
  if (!TX_RE.test(tx || '')) refuse(422, 'tx must be the Solana transaction signature that proves it');
  if (v().entries.some((e) => e.tx === tx && e.kind === kind)) refuse(409, 'that transaction is already recorded');
  if (note != null && (typeof note !== 'string' || note.length > 140)) refuse(422, 'note: up to 140 characters');
  if (kind === 'out') {
    const s = summary();
    const avail = s.buckets[use].pending;
    if (sol > avail + 1e-9) refuse(422, `the ${use} bucket only has ${avail} SOL owed to it`);
  }
  const e = { i: ++v().n, t: Date.now(), day: state.day, kind, source: source || null, use: use || null, sol: r4(sol), tx, note: note || null };
  v().entries.push(e);
  L('vault', 'vault', kind === 'in' ? e.sol : -e.sol, `${kind === 'in' ? `in: ${source}` : `out: ${use}`} ${e.sol} SOL, tx ${tx.slice(0, 12)}`);
  return e;
}

export function summary() {
  const es = v().entries;
  const inflow = es.filter((e) => e.kind === 'in').reduce((a, e) => a + e.sol, 0);
  const bySource = {};
  for (const e of es) if (e.kind === 'in') bySource[e.source] = r4((bySource[e.source] || 0) + e.sol);
  const buckets = {};
  for (const [k, pct] of Object.entries(VAULT.policy)) {
    const owed = (inflow * pct) / 100;
    const paid = es.filter((e) => e.kind === 'out' && e.use === k).reduce((a, e) => a + e.sol, 0);
    buckets[k] = { pct, label: USES[k] || k, owed: r4(owed), paid: r4(paid), pending: r4(Math.max(0, owed - paid)) };
  }
  return {
    inflow: r4(inflow), outflow: r4(es.filter((e) => e.kind === 'out').reduce((a, e) => a + e.sol, 0)),
    bySource, buckets, sources: SOURCES,
    milestone: { label: 'First weekly prize unlocks', target: VAULT.prizeMinSol, have: buckets.prize ? buckets.prize.pending : 0 },
  };
}

// On-chain balance of the vault wallet, cached for a minute.
let balCache = { t: 0, sol: null };
async function walletBalance() {
  if (!VAULT.wallet || !isSolanaAddress(VAULT.wallet)) return null;
  if (Date.now() - balCache.t < 60_000) return balCache.sol;
  try {
    const res = await fetch(TOKEN.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [VAULT.wallet, { commitment: 'confirmed' }] }) });
    const j = await res.json();
    balCache = { t: Date.now(), sol: typeof j?.result?.value === 'number' ? j.result.value / 1e9 : null };
  } catch { balCache = { t: Date.now(), sol: null }; }
  return balCache.sol;
}

export async function vaultView() {
  return {
    wallet: VAULT.wallet, walletBalance: await walletBalance(), token: TOKEN.ticker, mint: TOKEN.mint,
    policy: VAULT.policy, uses: USES, ...summary(),
    entries: v().entries.slice(-150).reverse(),
  };
}

export function checkAdmin(key) {
  if (!VAULT.adminKey) refuse(503, 'recording is off: set ADMIN_KEY on the server');
  if (key !== VAULT.adminKey) refuse(401, 'wrong admin key');
}
