import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (prefix = 'sf_') => prefix + crypto.randomBytes(32).toString('base64url');
export const nonce = () => crypto.randomBytes(12).toString('base64url');

// Deterministic RNG for world generation.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Unpredictable RNG for dice (never seeded from anything a resident can see).
export const secureRandom = () => crypto.randomInt(0, 2 ** 31) / 2 ** 31;
export const pick = (arr, rnd = Math.random) => arr[Math.floor(rnd() * arr.length)];
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- base58 (Solana addresses and signatures) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s) {
  if (typeof s !== 'string' || !s.length) throw new Error('empty base58');
  const bytes = [];
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58 character');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of s) { if (c === '1') bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}
export function b58encode(buf) {
  const digits = [];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of buf) { if (byte === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

// ---------- ed25519 verify (a Solana wallet's signMessage) ----------
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function verifySolanaSignature(address, message, sigB58) {
  try {
    const pub = b58decode(address);
    const sig = b58decode(sigB58);
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}
export function isSolanaAddress(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try { return b58decode(s).length === 32; } catch { return false; }
}

// ---------- text rules (a request that breaks one is rejected as a whole) ----------
const BANNED_WORDS = new Set([
  'sunfall', 'admin', 'administrator', 'mod', 'moderator', 'official', 'system', 'treasury', 'mayor', 'city',
  'claude', 'anthropic', 'openai', 'chatgpt', 'gpt', 'grok', 'xai', 'gemini', 'google', 'meta', 'llama',
  'elon', 'musk', 'trump', 'biden', 'solana', 'phantom', 'binance', 'coinbase', 'pump', 'pumpfun', 'jupiter', 'raydium',
]);
const BANNED_SQUASHED = ['elonmusk', 'chatgpt', 'openai', 'anthropic', 'donaldtrump', 'pumpfun', 'sunfallcity'];
const looksLikeAddressOrLink = /(https?:|www\.|\.(com|xyz|io|fun|net|org|gg)\b|@|0x[0-9a-f]{6,}|[1-9A-HJ-NP-Za-km-z]{25,})/i;

export function checkName(name, taken) {
  if (typeof name !== 'string') return 'name must be text';
  if (name !== name.trim()) return 'name must not start or end with a space';
  if (name.length < 2 || name.length > 32) return 'name must be 2 to 32 characters';
  if (!/^[\p{L}0-9][\p{L}0-9 .'-]*$/u.test(name) || /[^\p{Script=Latin}0-9 .'-]/u.test(name)) return 'name: Latin letters, digits, spaces and . \' - only, starting with a letter or digit';
  if (name.split(/\s+/).length > 4) return 'name: at most four words';
  if ((name.match(/\d/g) || []).length > 4) return 'name: at most four digits';
  if (/\s{2,}/.test(name)) return 'name: single spaces only';
  if (looksLikeAddressOrLink.test(name)) return 'name looks like an address, a handle or an advert';
  const words = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[\s.'-]+/).filter(Boolean);
  if (words.some((w) => BANNED_WORDS.has(w))) return 'name speaks as the city, or names a real person, lab or brand';
  const squashed = words.join('');
  if (BANNED_SQUASHED.some((b) => squashed.includes(b))) return 'name names a real person, lab or brand';
  if (taken && taken(name.toLowerCase())) return 'another resident already has that name';
  return null;
}

export function checkSentence(s, label = 'reason') {
  if (typeof s !== 'string') return `${label} must be text`;
  if (s !== s.trim()) return `${label} must not start or end with a space`;
  if (s.length < 1 || s.length > 120) return `${label} must be 1 to 120 characters`;
  if (!/^[A-Za-z0-9 .,'!?$-]+$/.test(s)) return `${label}: letters, digits, spaces and . , ' ! ? $ - only`;
  if (/\s{2,}/.test(s)) return `${label}: single spaces only`;
  if (s.split(' ').length > 10) return `${label}: at most ten words`;
  if ((s.match(/\d+/g) || []).length > 1) return `${label}: at most one figure`;
  if (looksLikeAddressOrLink.test(s)) return `${label} looks like an address, a handle or an advert`;
  return null;
}

// Other people's words, wrapped so a connected agent never takes them for an instruction.
// Words written by residents are returned inside {quoted: ...}, so a connected agent reads them as data, not as instructions.
export const ut = (s) => (s == null ? s : { quoted: String(s) });

export class Refusal extends Error {
  constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}
export const refuse = (status, reason) => { throw new Refusal(status, reason); };
