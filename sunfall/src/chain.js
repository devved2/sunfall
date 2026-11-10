// Elysium side of Sunfall (Kinetiq's Arbitrum Orbit L2 on Hyperliquid, chain 99901, gas in HYPE).
// The city never holds a key and never sends a token. Tokens only ever flow IN, from a resident's
// own wallet, and are burnt.
import { rpc, isEvmAddress, checksum, sameAddress, TRANSFER_TOPIC, topicAddress, BURN_ADDRESSES } from './evm.js';
import { LAUNCH } from './launch.js';

export const CHAIN = {
  name: 'Elysium',
  id: Number(process.env.CHAIN_ID || 99901),
  rpc: process.env.ELYSIUM_RPC || 'https://rpc.elysium.kinetiq.xyz',
  gas: 'HYPE',
  // Kinetiq's mainnet explorer (live since 9 Nov 2026): /tx/<hash>, /address/<addr>. EXPLORER_URL=off disables links.
  explorer: process.env.EXPLORER_URL === 'off' ? null : (process.env.EXPLORER_URL || 'https://elysium.kinetiq.xyz').replace(/\/$/, ''),
};
export const txUrl = (hash) => (CHAIN.explorer ? `${CHAIN.explorer}/tx/${hash}` : null);
export const addressUrl = (a) => (CHAIN.explorer ? `${CHAIN.explorer}/address/${a}` : null);

const tokenAddress = process.env.TOKEN_ADDRESS || process.env.TOKEN_MINT || LAUNCH.tokenAddress || null;
export const TOKEN = {
  ticker: process.env.TOKEN_TICKER || '$SUNFALL',
  address: tokenAddress && isEvmAddress(tokenAddress) ? checksum(tokenAddress) : null, // set once the coin exists
  decimals: Number(process.env.TOKEN_DECIMALS || 18),       // ERC-20 standard; launchpad coins use 18
  billboardBurn: Number(process.env.BILLBOARD_BURN || 25000), // whole tokens burnt per billboard day
  prizesEnabled: process.env.PRIZES_ENABLED === 'true',
  prizeAsset: process.env.PRIZE_ASSET || 'HYPE on Elysium',
};
if (tokenAddress && !TOKEN.address) console.error('TOKEN_ADDRESS is not a valid 0x address; billboards stay off');

export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Checks a confirmed Elysium transaction, sent by `owner` (the resident's wallet), moved at least
 * `minWhole` of the city token to a burn address (0x0 or 0x…dEaD). Fails closed on anything unexpected.
 */
export async function verifyBurn(hash, owner, minWhole) {
  if (!TX_HASH_RE.test(hash || '')) return { ok: false, reason: 'tx must be a 0x transaction hash' };
  let rc;
  try { rc = await rpc(CHAIN.rpc, 'eth_getTransactionReceipt', [hash]); }
  catch (e) { return { ok: false, reason: `could not read the transaction yet (${e.message}); try again in a moment` }; }
  if (!rc) return { ok: false, reason: 'transaction not found or not confirmed yet' };
  if (rc.status !== '0x1') return { ok: false, reason: 'transaction failed on chain' };
  if (!sameAddress(rc.from, owner)) return { ok: false, reason: 'the burn was not sent from your resident\'s wallet' };
  const minRaw = BigInt(Math.round(minWhole)) * 10n ** BigInt(TOKEN.decimals);
  let burnt = 0n;
  for (const log of rc.logs || []) {
    if (!sameAddress(log.address, TOKEN.address)) continue;
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    if (!sameAddress(topicAddress(log.topics[1]), owner)) continue;
    if (!BURN_ADDRESSES.some((b) => sameAddress(topicAddress(log.topics[2]), b))) continue;
    burnt += BigInt(log.data);
  }
  if (burnt < minRaw) return { ok: false, reason: `a burn of at least ${minWhole} ${TOKEN.ticker} from your wallet was not found in that transaction` };
  return { ok: true, amount: Number(burnt / 10n ** BigInt(TOKEN.decimals)) };
}

/** Native HYPE balance of an address, in HYPE. */
export async function hypeBalance(address) {
  const wei = BigInt(await rpc(CHAIN.rpc, 'eth_getBalance', [address, 'latest']));
  return Number(wei / 10n ** 12n) / 1e6;
}
