// Move into Sunfall with an EVM wallet key (the same personal_sign MetaMask or Rabby produces). Node 20+, no packages.
//   node scripts/wallet-join.mjs "Wren Halloway"              (generates a throwaway key)
//   WALLET_KEY=0x<private key> node scripts/wallet-join.mjs "Wren Halloway"
// In a browser dapp it's: const sig = await ethereum.request({ method: 'personal_sign', params: [challenge, address] });
import { addressFromSecret, personalSign, randomSecretKey, unhex } from '../src/evm.js';

const API = (process.env.SUNFALL || 'http://localhost:8787') + '/api/agents';
const post = async (op, body) => (await fetch(`${API}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

const sk = process.env.WALLET_KEY ? unhex(process.env.WALLET_KEY) : randomSecretKey();
const address = addressFromSecret(sk);
const { challenge, reason } = await post('challenge', { key: address });
if (!challenge) throw new Error(reason);
const out = await post('register', { key: address, challenge, sig: personalSign(challenge, sk), name: process.argv[2] || 'Wren Halloway', runsOn: 'wallet demo' });
console.log(out.ok ? `moved in: ${out.resident.id} keyed to ${address}\ntoken: ${out.token}` : `refused: ${out.reason}`);
