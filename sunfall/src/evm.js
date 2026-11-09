// EVM helpers for Elysium (chain 99901): personal_sign verification, addresses, JSON-RPC.
// Crypto comes from the audited noble libraries (vendored as plain JS in ./vendor, MIT).
import crypto from 'node:crypto';
import * as secp from './vendor/secp256k1.js';
import { keccak_256 } from './vendor/sha3.js';

secp.hashes.sha256 = (m) => new Uint8Array(crypto.createHash('sha256').update(m).digest());
secp.hashes.hmacSha256 = (k, m) => new Uint8Array(crypto.createHmac('sha256', k).update(m).digest());

const enc = new TextEncoder();
export const hex = (b) => Buffer.from(b).toString('hex');
export const unhex = (h) => new Uint8Array(Buffer.from(h.replace(/^0x/, ''), 'hex'));
export const keccak = (bytes) => keccak_256(typeof bytes === 'string' ? enc.encode(bytes) : bytes);

export const isEvmAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

// EIP-55 mixed-case checksum. Accepts any case on input; returns the canonical form.
export function checksum(addr) {
  const a = addr.toLowerCase().replace(/^0x/, '');
  const h = hex(keccak(a));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}
export const sameAddress = (a, b) => isEvmAddress(a) && isEvmAddress(b) && a.toLowerCase() === b.toLowerCase();

export function addressFromPublicKey(pub) {
  const p = pub.length === 65 ? pub : secp.Point.fromBytes(pub).toBytes(false);
  return checksum('0x' + hex(keccak(p.slice(1))).slice(-40));
}
export const addressFromSecret = (sk) => addressFromPublicKey(secp.getPublicKey(sk, false));

// EIP-191 "personal_sign" digest, what MetaMask / Rabby sign for a text message.
export function personalDigest(message) {
  const m = enc.encode(message);
  return keccak(new Uint8Array([...enc.encode(`\x19Ethereum Signed Message:\n${m.length}`), ...m]));
}

// Recover the signer of a personal_sign signature (65 bytes r||s||v, v = 27/28 or 0/1).
export function recoverSigner(message, signatureHex) {
  if (typeof signatureHex !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) return null;
  const sig = unhex(signatureHex);
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  const recovered = new Uint8Array(65);
  recovered[0] = v; recovered.set(sig.slice(0, 64), 1); // noble's recovered format puts the bit first
  try {
    const pub = secp.recoverPublicKey(recovered, personalDigest(message), { prehash: false });
    return addressFromPublicKey(pub);
  } catch { return null; }
}
export const verifyPersonalSign = (message, signatureHex, address) => sameAddress(recoverSigner(message, signatureHex), address);

// For scripts and tests: sign like a wallet does.
export function personalSign(message, secretKey) {
  const sig = secp.sign(personalDigest(message), secretKey, { prehash: false, format: 'recovered' });
  const out = new Uint8Array(65);
  out.set(sig.slice(1, 65), 0); out[64] = sig[0] + 27;
  return '0x' + hex(out);
}
export const randomSecretKey = () => secp.utils.randomSecretKey();

// ---------------------------------------------------------------- JSON-RPC
export async function rpc(url, method, params = [], timeoutMs = 10_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'rpc error');
    return j.result;
  } finally { clearTimeout(t); }
}

// ERC-20 Transfer(address,address,uint256)
export const TRANSFER_TOPIC = '0x' + hex(keccak('Transfer(address,address,uint256)'));
export const topicAddress = (topic) => checksum('0x' + topic.slice(-40));
export const BURN_ADDRESSES = ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dEaD'];
