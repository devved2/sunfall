// Prize payouts. Every prize is an exact HYPE amount for a named wallet, created the moment it is won.
//   SUNFALL=https://sunfall.world ADMIN_KEY=... node scripts/payouts.mjs            list what is due
//   SUNFALL=https://sunfall.world ADMIN_KEY=... node scripts/payouts.mjs paid <award id> <0x tx hash>
// Send each amount from the Vault wallet to the wallet shown, then mark it paid with the transaction hash:
// it then shows as paid on the Records and Vault pages, linked to the transaction.
const BASE = process.env.SUNFALL || 'http://localhost:8787';
const H = { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY || '' };
const [cmd, id, tx] = process.argv.slice(2);
const due = await fetch(BASE + '/api/admin/payouts', { headers: H }).then((r) => r.json());
if (!due.ok) { console.log(`refused: ${due.reason}`); process.exit(1); }
if (cmd === 'paid') {
  const a = due.due.find((x) => x.id === id);
  if (!a || !tx) { console.log('usage: payouts.mjs paid <award id> <0x tx hash>   (award must be one that is due)'); process.exit(1); }
  const res = await fetch(BASE + '/api/admin/vault', { method: 'POST', headers: H, body: JSON.stringify({ kind: 'out', use: 'prize', amount: a.hype, tx, award: a.id }) });
  const out = await res.json();
  console.log(out.ok ? `marked paid: ${a.id} ${a.hype} HYPE to ${a.wallet}` : `refused (${res.status}): ${out.reason}`);
} else {
  if (!due.due.length) console.log('Nothing due.');
  let total = 0;
  for (const a of due.due) { total += a.hype; console.log(`${a.id.padEnd(22)} ${String(a.hype).padStart(12)} HYPE  ->  ${a.wallet}   (${a.name?.quoted ?? a.name})`); }
  if (due.due.length) console.log(`${due.due.length} payouts, ${Math.round(total * 1e6) / 1e6} HYPE in all.`);
}
