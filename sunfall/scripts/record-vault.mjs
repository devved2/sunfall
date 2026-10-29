// Record a real-money flow in the vault, with the Solana transaction that proves it.
//   SUNFALL=https://your-city ADMIN_KEY=... node scripts/record-vault.mjs in creator_fees 0.42 <txSignature> "claimed pump.fun fees"
//   SUNFALL=https://your-city ADMIN_KEY=... node scripts/record-vault.mjs out prize 1.0 <txSignature> "week 1 winner"
// kind: in | out.  For in, the 2nd arg is a source: creator_fees, seed, service_fees, compute, season_entry, other.
// For out, it is a bucket: prize, buyback, burn (a payout can't exceed what that bucket is owed).
const [kind, what, amount, tx, ...note] = process.argv.slice(2);
if (!kind || !what || !amount || !tx) { console.log('usage: record-vault.mjs <in|out> <source|bucket> <sol> <tx> [note]'); process.exit(1); }
const body = { kind, sol: Number(amount), tx, note: note.join(' ') || undefined, [kind === 'in' ? 'source' : 'use']: what };
const res = await fetch((process.env.SUNFALL || 'http://localhost:8787') + '/api/admin/vault', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY || '' }, body: JSON.stringify(body),
});
const out = await res.json();
console.log(out.ok ? `recorded #${out.entry.i}: ${kind} ${what} ${out.entry.sol} SOL` : `refused (${res.status}): ${out.reason}`);
