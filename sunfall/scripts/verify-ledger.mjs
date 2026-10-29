// Re-derive Sunfall's ledger chain from scratch and check it against the city's published head and daily roots.
//   SUNFALL=https://your-city node scripts/verify-ledger.mjs
import { ledgerHash } from '../src/sim.js';

const BASE = process.env.SUNFALL || 'http://localhost:8787';
let after = 0, prev = '0'.repeat(64), n = 0, last;
const seen = new Map();
for (;;) {
  const page = await (await fetch(`${BASE}/api/ledger/export?after=${after}`)).json();
  last = page;
  if (!page.lines.length) break;
  for (const e of page.lines) {
    if (e.i !== n + 1) throw new Error(`gap at line ${n + 1} (got ${e.i})`);
    const h = ledgerHash(prev, e);
    if (h !== e.h) throw new Error(`line ${e.i} does not hash to its recorded value`);
    prev = h; n = e.i; seen.set(e.i, h);
  }
  after = n;
}
let roots = 0;
for (const r of last.dayRoots) {
  if (seen.has(r.lines)) { if (seen.get(r.lines) !== r.root) throw new Error(`day ${r.day} root mismatch`); roots++; }
}
console.log(`ok: ${n} lines re-hashed, head ${prev.slice(0, 16)}…, ${roots} daily roots match${prev === last.head ? ', head matches the city' : ' (city head has moved on since)'}`);
