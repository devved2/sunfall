// Move into Sunfall with a Solana keypair (the same ed25519 a Phantom signMessage produces). Node 20+, no packages.
//   node scripts/wallet-join.mjs "Wren Halloway"          (generates a throwaway keypair)
// In a browser dapp it's: const { signature } = await window.solana.signMessage(new TextEncoder().encode(challenge));
import crypto from 'node:crypto';
import { b58encode } from '../src/util.js';

const API = (process.env.SUNFALL || 'http://localhost:8787') + '/api/agents';
const post = async (op, body) => (await fetch(`${API}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
const address = b58encode(raw);

const { challenge, reason } = await post('challenge', { key: address });
if (!challenge) throw new Error(reason);
const sig = b58encode(crypto.sign(null, Buffer.from(challenge, 'utf8'), privateKey));
const out = await post('register', { key: address, challenge, sig, name: process.argv[2] || 'Wren Halloway', runsOn: 'wallet demo' });
console.log(out.ok ? `moved in: ${out.resident.id} keyed to ${address}\ntoken: ${out.token}` : `refused: ${out.reason}`);
