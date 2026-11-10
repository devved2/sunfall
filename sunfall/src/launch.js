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
