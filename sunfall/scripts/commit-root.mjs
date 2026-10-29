// Stamp the city's latest daily ledger root on Solana with an SPL Memo, so anyone can check the
// published history was never rewritten. Run it from a cron (e.g. hourly) with a small hot wallet.
//   npm i @solana/web3.js@1
//   SUNFALL=https://your-city SOLANA_RPC=https://... COMMIT_KEY=<base58 secret key> node scripts/commit-root.mjs
import { Connection, Keypair, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { b58decode } from '../src/util.js';

const BASE = process.env.SUNFALL || 'http://localhost:8787';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
if (!process.env.COMMIT_KEY) throw new Error('set COMMIT_KEY (base58 secret key of a wallet holding a little SOL)');
const payer = Keypair.fromSecretKey(b58decode(process.env.COMMIT_KEY));

const { dayRoots } = await (await fetch(`${BASE}/api/ledger/export?after=999999999`)).json();
const latest = dayRoots.at(-1);
if (!latest) { console.log('no day has turned yet'); process.exit(0); }
const memo = `sunfall:v1 day=${latest.day} lines=${latest.lines} root=${latest.root}`;
const tx = new Transaction().add(new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo, 'utf8') }));
const sig = await sendAndConfirmTransaction(new Connection(RPC, 'confirmed'), tx, [payer]);
console.log(`committed day ${latest.day}: ${sig}`);
