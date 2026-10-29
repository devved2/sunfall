// Solana side of Sunfall. The city never holds a key and never sends a token.
// Tokens only ever flow IN, from a resident's own wallet, and are burnt.

export const TOKEN = {
  ticker: process.env.TOKEN_TICKER || '$SUNFALL',
  mint: process.env.TOKEN_MINT || null,                    // set once the coin exists
  decimals: Number(process.env.TOKEN_DECIMALS || 6),       // pump.fun coins use 6
  billboardBurn: Number(process.env.BILLBOARD_BURN || 25000), // whole tokens burnt per billboard day
  rpc: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  prizesEnabled: process.env.PRIZES_ENABLED === 'true',
  prizeAsset: process.env.PRIZE_ASSET || 'xStocks (tokenized US equities, SPL) — e.g. TSLAx, NVDAx',
};

async function rpc(method, params) {
  const res = await fetch(TOKEN.rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

/**
 * Checks a confirmed transaction burnt at least `minWhole` of the city token,
 * signed by `owner` (the resident's wallet). Fails closed on anything unexpected.
 */
export async function verifyBurn(signature, owner, minWhole) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature || '')) return { ok: false, reason: 'tx must be a transaction signature' };
  let tx;
  try {
    tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  } catch (e) { return { ok: false, reason: `could not read the transaction yet (${e.message}); try again in a moment` }; }
  if (!tx) return { ok: false, reason: 'transaction not found or not confirmed yet' };
  if (tx.meta?.err) return { ok: false, reason: 'transaction failed on chain' };
  const signers = (tx.transaction?.message?.accountKeys || []).filter((k) => k.signer).map((k) => k.pubkey);
  if (!signers.includes(owner)) return { ok: false, reason: 'the burn was not signed by your resident\'s wallet' };
  const all = [...(tx.transaction?.message?.instructions || [])];
  for (const inner of tx.meta?.innerInstructions || []) all.push(...inner.instructions);
  const minRaw = BigInt(Math.round(minWhole)) * 10n ** BigInt(TOKEN.decimals);
  let burnt = 0n;
  for (const ix of all) {
    if (!['spl-token', 'spl-token-2022'].includes(ix.program)) continue;
    const t = ix.parsed?.type;
    if (t !== 'burn' && t !== 'burnChecked') continue;
    const info = ix.parsed.info || {};
    if (info.mint !== TOKEN.mint) continue;
    if ((info.authority || info.multisigAuthority) !== owner) continue;
    const raw = BigInt(info.amount ?? info.tokenAmount?.amount ?? 0);
    burnt += raw;
  }
  if (burnt < minRaw) return { ok: false, reason: `burn of at least ${minWhole} ${TOKEN.ticker} not found in that transaction` };
  return { ok: true, amount: Number(burnt / 10n ** BigInt(TOKEN.decimals)) };
}
