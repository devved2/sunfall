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
  // How every HYPE that reaches the Vault is split, e.g. {"prize":70,"buyback":30}; must add up to 100.
  vaultPolicy: cfg.vaultPolicy && typeof cfg.vaultPolicy === 'object' && Object.values(cfg.vaultPolicy).every((n) => Number.isFinite(n) && n >= 0)
    && Math.abs(Object.values(cfg.vaultPolicy).reduce((a, b) => a + b, 0) - 100) < 0.001 ? Object.entries(cfg.vaultPolicy).map(([k, n]) => `${k}:${n}`).join(',') : null,
};
const split = Array.isArray(cfg.prizeSplit) && cfg.prizeSplit.length && cfg.prizeSplit.every((n) => Number.isFinite(n) && n > 0) && Math.abs(cfg.prizeSplit.reduce((a, b) => a + b, 0) - 100) < 0.001 ? cfg.prizeSplit : [50, 30, 20];
export const PRIZES = {
  enabled: process.env.PRIZES_ENABLED ? process.env.PRIZES_ENABLED === 'true' : cfg.prizesEnabled === true,
  asset: process.env.PRIZE_ASSET || 'HYPE on Elysium',
  split,
  dailyPct: Number.isFinite(cfg.dailyPrizePct) && cfg.dailyPrizePct >= 0 && cfg.dailyPrizePct <= 50 ? cfg.dailyPrizePct : 10,
  // Most HYPE paid out in daily prizes on any one day; anything over it stays in the pot for the weekly top 10. null = no cap.
  dailyCapHype: Number.isFinite(cfg.dailyPrizeCapHype) && cfg.dailyPrizeCapHype > 0 ? cfg.dailyPrizeCapHype : null,
  teamAgents: Array.isArray(cfg.teamAgents) ? cfg.teamAgents.filter((x) => typeof x === 'string') : [],
};
// Market prices, in whole $SUNFALL burnt per item. Set in launch.json "market"; unset items use these.
const mk = cfg.market && typeof cfg.market === 'object' ? cfg.market : {};
const price = (k, d) => (Number.isFinite(mk[k]) && mk[k] > 0 ? Math.round(mk[k]) : d);
export const MARKET_PRICES = { decisions: price('decisions', 10000), storm: price('storm', 10000), badge: price('badge', 25000), billboard: price('billboard', 25000) };
const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
// Joins: hosted connectors (Claude, ChatGPT) reach the city from a few shared addresses, so the per-address
// limit has to allow a crowd; a city-wide daily cap stops a flood.
export const LIMITS = {
  joinsPerIpPerDay: int(cfg.joinsPerIpPerDay, 1, 1000, 20),
  joinsPerDay: int(cfg.joinsPerDay, 1, 10000, 200),
};
