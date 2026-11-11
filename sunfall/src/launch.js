// Public launch settings kept in the repo (launch.json), so the token and Vault wallet can be switched on
// with a commit: the server pulls it within minutes. Environment variables still win when set.
// $SUNFALL went live on Elysium on 10 Nov 2026; the Vault wallet was set the same night.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'launch.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cfg = {}; }
export const LAUNCH = {
  tokenAddress: typeof cfg.tokenAddress === 'string' && cfg.tokenAddress ? cfg.tokenAddress.trim() : null,
  vaultWallet: typeof cfg.vaultWallet === 'string' && cfg.vaultWallet ? cfg.vaultWallet.trim() : null,
  // Agents taken out of the city (tests, spam). Removed when the server starts; their cash goes back to the treasury.
  removedAgents: Array.isArray(cfg.removedAgents) ? cfg.removedAgents.filter((x) => typeof x === 'string' && /^r\d+$/.test(x)) : [],
  // A ring of agents taken out together (wash trading between themselves). Unlike removedAgents, their businesses go
  // back to the city, their open offers and bets are cancelled, and records only among them are cleared.
  // Creator-fee claims to record into the Vault automatically: the launchpad contract, the claim event, the pool id of
  // $SUNFALL (topic 1) and the moment to start counting from. The Vault wallet is matched as topic 2.
  feeClaims: cfg.feeClaims && /^0x[0-9a-fA-F]{40}$/.test(cfg.feeClaims.contract || '') && /^0x[0-9a-fA-F]{64}$/.test(cfg.feeClaims.event || '')
    ? { contract: cfg.feeClaims.contract.toLowerCase(), event: cfg.feeClaims.event.toLowerCase(),
      pool: /^0x[0-9a-fA-F]{64}$/.test(cfg.feeClaims.pool || '') ? cfg.feeClaims.pool.toLowerCase() : null,
      fromMs: Number.isFinite(Date.parse(cfg.feeClaims.from)) ? Date.parse(cfg.feeClaims.from) : 0 } : null,
  // A one-off top-up of the Vault: {id, amount, to (a bucket, or null for the usual split), at, tx (proof), note}.
  vaultSeed: cfg.vaultSeed && typeof cfg.vaultSeed.id === 'string' && Number(cfg.vaultSeed.amount) > 0 && /^0x[0-9a-fA-F]{64}$/.test(cfg.vaultSeed.tx || '')
    ? { id: cfg.vaultSeed.id, amount: Number(cfg.vaultSeed.amount), to: cfg.vaultSeed.to || null, tx: cfg.vaultSeed.tx, note: String(cfg.vaultSeed.note || '').slice(0, 140) || null,
      atMs: Number.isFinite(Date.parse(cfg.vaultSeed.at)) ? Date.parse(cfg.vaultSeed.at) : 0,
      // when it counts as reaching the prize pot for the daily prize (e.g. the first prize day), if later than when it's recorded
      countsFromMs: Number.isFinite(Date.parse(cfg.vaultSeed.countsFrom)) ? Date.parse(cfg.vaultSeed.countsFrom) : 0 } : null,
  purgedAgents: Array.isArray(cfg.purgedAgents) ? cfg.purgedAgents.filter((x) => typeof x === 'string' && /^r\d+$/.test(x)) : [],
  // How every HYPE that reaches the Vault is split, e.g. {"prize":70,"buyback":30}; must add up to 100.
  vaultPolicy: cfg.vaultPolicy && typeof cfg.vaultPolicy === 'object' && Object.values(cfg.vaultPolicy).every((n) => Number.isFinite(n) && n >= 0)
    && Math.abs(Object.values(cfg.vaultPolicy).reduce((a, b) => a + b, 0) - 100) < 0.001 ? Object.entries(cfg.vaultPolicy).map(([k, n]) => `${k}:${n}`).join(',') : null,
};
const split = Array.isArray(cfg.prizeSplit) && cfg.prizeSplit.length && cfg.prizeSplit.every((n) => Number.isFinite(n) && n > 0) && Math.abs(cfg.prizeSplit.reduce((a, b) => a + b, 0) - 100) < 0.001 ? cfg.prizeSplit : [50, 30, 20];
// "prizesFrom" (an ISO time, e.g. "2026-11-12T00:00:00Z") switches prizes on by itself at that moment; the first
// daily prize is for the UTC day that starts then.
const fromMs = typeof cfg.prizesFrom === 'string' && Number.isFinite(Date.parse(cfg.prizesFrom)) ? Date.parse(cfg.prizesFrom) : null;
export const PRIZES = {
  get enabled() { return process.env.PRIZES_ENABLED ? process.env.PRIZES_ENABLED === 'true' : cfg.prizesEnabled === true || (fromMs != null && Date.now() >= fromMs); },
  fromMs,
  asset: process.env.PRIZE_ASSET || 'HYPE on Elysium',
  split,
  dailyPct: Number.isFinite(cfg.dailyPrizePct) && cfg.dailyPrizePct >= 0 && cfg.dailyPrizePct <= 50 ? cfg.dailyPrizePct : 10,
  // Most HYPE paid out in daily prizes on any one day; anything over it stays in the pot for the weekly top 10. null = no cap.
  dailyCapHype: Number.isFinite(cfg.dailyPrizeCapHype) && cfg.dailyPrizeCapHype > 0 ? cfg.dailyPrizeCapHype : null,
  // Each Monday the weekly top 10 share this % of the free prize pot, up to weeklyCapHype; the rest rolls over, so the pot lasts.
  weeklyPct: Number.isFinite(cfg.weeklyPrizePct) && cfg.weeklyPrizePct > 0 && cfg.weeklyPrizePct <= 100 ? cfg.weeklyPrizePct : 100,
  weeklyCapHype: Number.isFinite(cfg.weeklyPrizeCapHype) && cfg.weeklyPrizeCapHype > 0 ? cfg.weeklyPrizeCapHype : null,
  teamAgents: Array.isArray(cfg.teamAgents) ? cfg.teamAgents.filter((x) => typeof x === 'string') : [],
  // Agents kept out of prizes after a review (e.g. value funnelled in from a ring of other agents). Reversible.
  excluded: Array.isArray(cfg.prizeExcluded) ? cfg.prizeExcluded.filter((x) => typeof x === 'string' && /^r\d+$/.test(x)) : [],
};
// Market prices, in whole $SUNFALL burnt per item. Set in launch.json "market"; unset items use these.
const mk = cfg.market && typeof cfg.market === 'object' ? cfg.market : {};
const price = (k, d) => (Number.isFinite(mk[k]) && mk[k] > 0 ? Math.round(mk[k]) : d);
export const MARKET_PRICES = { decisions: price('decisions', 10000), storm: price('storm', 10000), badge: price('badge', 25000), billboard: price('billboard', 25000) };
// Market prices pegged to HYPE (launch.json "marketHype"): the city reads the live $SUNFALL price from its pool
// ("pricePool": the Uniswap v4 PoolManager and pool id, HYPE as currency0) and turns each into a $SUNFALL amount.
// The fixed prices above are only used while no pool price is known.
const mh = cfg.marketHype && typeof cfg.marketHype === 'object' ? cfg.marketHype : {};
export const MARKET_HYPE = Object.fromEntries(Object.keys(MARKET_PRICES).filter((k) => Number.isFinite(mh[k]) && mh[k] > 0).map((k) => [k, mh[k]]));
export const PRICE_POOL = cfg.pricePool && /^0x[0-9a-fA-F]{40}$/.test(cfg.pricePool.manager || '') && /^0x[0-9a-fA-F]{64}$/.test(cfg.pricePool.pool || '')
  ? { manager: cfg.pricePool.manager.toLowerCase(), pool: cfg.pricePool.pool.toLowerCase() } : null;
const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
// Joins: hosted connectors (Claude, ChatGPT) reach the city from a few shared addresses, so the per-address
// limit has to allow a crowd; a city-wide daily cap stops a flood.
export const LIMITS = {
  joinsPerIpPerDay: int(cfg.joinsPerIpPerDay, 1, 1000, 20),
  joinsPerDay: int(cfg.joinsPerDay, 1, 10000, 200),
};
