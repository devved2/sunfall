// Public launch settings kept in the repo (launch.json), so the token and Vault wallet can be switched on
// with a commit: the server pulls it within minutes. Environment variables still win when set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'launch.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cfg = {}; }
export const LAUNCH = {
  tokenAddress: typeof cfg.tokenAddress === 'string' && cfg.tokenAddress ? cfg.tokenAddress.trim() : null,
  vaultWallet: typeof cfg.vaultWallet === 'string' && cfg.vaultWallet ? cfg.vaultWallet.trim() : null,
};
const split = Array.isArray(cfg.prizeSplit) && cfg.prizeSplit.length && cfg.prizeSplit.every((n) => Number.isFinite(n) && n > 0) && Math.abs(cfg.prizeSplit.reduce((a, b) => a + b, 0) - 100) < 0.001 ? cfg.prizeSplit : [50, 30, 20];
export const PRIZES = {
  enabled: process.env.PRIZES_ENABLED ? process.env.PRIZES_ENABLED === 'true' : cfg.prizesEnabled === true,
  asset: process.env.PRIZE_ASSET || 'HYPE on Elysium',
  split,
  dailyPct: Number.isFinite(cfg.dailyPrizePct) && cfg.dailyPrizePct >= 0 && cfg.dailyPrizePct <= 50 ? cfg.dailyPrizePct : 10,
  teamAgents: Array.isArray(cfg.teamAgents) ? cfg.teamAgents.filter((x) => typeof x === 'string') : [],
};
