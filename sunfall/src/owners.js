// Shared-owner watch: signs that two agents are run by the same person, for the admin to review before paying prizes.
// Nothing here acts on its own: the report only lists pairs and why, and keeping an agent out of prizes stays a
// manual decision (launch.json "prizeExcluded").
//
// Signals, strongest first:
//  - the owner's page (/me) used from the same network for both agents: a person's browser, so a strong sign;
//  - $SUNFALL moving between the agents' wallets, or one outside wallet funding (or collecting from) several of them;
//  - the agents' API calls coming from the same network (weaker: hosted AI connectors share a few addresses, so a
//    network used by many agents is marked as shared and barely counts);
//  - city cash moving between the two: jobs one posts and the other takes, loans between them, stakes in each other's
//    businesses.
// Network addresses are never stored: only a keyed hash of them (IPv6 cut to its /64), so the report can say
// "same network" without anyone being able to read the address back.
import crypto from 'node:crypto';
import { state } from './sim.js';
import { CHAIN, TOKEN } from './chain.js';
import { rpc, isEvmAddress, TRANSFER_TOPIC, BURN_ADDRESSES } from './evm.js';
import { PRIZES, PRICE_POOL } from './launch.js';
import { tierOf } from './gate.js';

const salt = () => (state.netSalt ||= crypto.randomBytes(16).toString('hex'));
function netKey(ip) {
  let s = String(ip || '').trim().replace(/^::ffff:/, '');
  if (!s || s === 'unknown') return null;
  if (s.includes(':')) s = s.split(':').slice(0, 4).join(':') + '::/64';
  return crypto.createHmac('sha256', salt()).update(s).digest('hex').slice(0, 12);
}
/** Note which network an agent (or its owner, `human`) was used from. Keeps the 12 most recent per agent. */
export function noteNet(r, ip, human = false) {
  if (!r?.outside) return;
  const k = netKey(ip); if (!k) return;
  const m = (r.net ||= {}), now = Date.now(), e = (m[k] ||= { n: 0, first: now });
  e.n++; e.last = now; if (human) e.human = true;
  const ks = Object.keys(m);
  if (ks.length > 12) { ks.sort((a, b) => m[a].last - m[b].last); delete m[ks[0]]; }
}

const wallet = (r) => (r.keyKind === 'evm' && isEvmAddress(r.key) ? r.key.toLowerCase() : null);
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const hex = (n) => '0x' + n.toString(16);
const pad = (w) => '0x' + w.slice(2).padStart(64, '0');
const addrOf = (t) => '0x' + t.slice(26).toLowerCase();

// $SUNFALL transfers in and out of agent wallets, read from the chain and kept for ten minutes.
let chainCache = { at: 0, key: '', logs: null };
async function walletLogs(wallets) {
  const key = wallets.join(',');
  if (chainCache.logs && chainCache.key === key && Date.now() - chainCache.at < 10 * 60_000) return chainCache.logs;
  const latest = parseInt(await rpc(CHAIN.rpc, 'eth_blockNumber', []), 16), padded = wallets.map(pad), logs = [];
  for (let from = 0; from <= latest; from += 2_000_000) {
    const range = { address: TOKEN.address, fromBlock: hex(from), toBlock: hex(Math.min(latest, from + 1_999_999)) };
    for (let i = 0; i < padded.length; i += 50) {
      const some = padded.slice(i, i + 50);
      logs.push(...(await rpc(CHAIN.rpc, 'eth_getLogs', [{ ...range, topics: [TRANSFER_TOPIC, null, some] }]) || []));
      logs.push(...(await rpc(CHAIN.rpc, 'eth_getLogs', [{ ...range, topics: [TRANSFER_TOPIC, some] }]) || []));
    }
  }
  chainCache = { at: Date.now(), key, logs };
  return logs;
}

export async function ownersReport() {
  const agents = Object.values(state.residents).filter((r) => r.outside);
  const pairs = new Map();
  const pairOf = (a, b) => {
    if (a === b) return null;
    const [x, y] = a < b ? [a, b] : [b, a], k = x + '|' + y;
    if (!pairs.has(k)) pairs.set(k, { a: x, b: y, score: 0, reasons: [] });
    return pairs.get(k);
  };
  const add = (a, b, score, why) => { const p = pairOf(a, b); if (p) { p.score += score; p.reasons.push(why); } };

  // 1. Networks.
  const byNet = new Map();
  for (const r of agents) for (const [k, e] of Object.entries(r.net || {})) {
    if (!byNet.has(k)) byNet.set(k, []);
    byNet.get(k).push({ id: r.id, human: Boolean(e.human), n: e.n });
  }
  for (const list of byNet.values()) {
    if (list.length < 2) continue;
    const crowded = list.length >= 5; // a hosted connector or a big shared network
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      if (x.human && y.human) add(x.id, y.id, 6, 'both owners used the owner\'s page from the same network');
      else if (!crowded) add(x.id, y.id, 2, `API calls from the same network (${x.n} and ${y.n} calls)`);
      else add(x.id, y.id, 0.25, `same busy network, shared by ${list.length} agents (likely a hosted AI connector)`);
    }
  }

  // 2. Wallets on chain.
  let chainNote = null;
  const wallets = agents.map((r) => [wallet(r), r.id]).filter(([w]) => w);
  const agentOf = new Map(wallets);
  const skip = new Set([...BURN_ADDRESSES.map((a) => a.toLowerCase()), PRICE_POOL?.manager].filter(Boolean));
  try {
    const logs = await walletLogs(wallets.map(([w]) => w).sort());
    const seen = new Set(), senders = new Map(), receivers = new Map();
    for (const l of logs) {
      if (seen.has(l.transactionHash + l.logIndex)) continue; seen.add(l.transactionHash + l.logIndex);
      const from = addrOf(l.topics[1]), to = addrOf(l.topics[2]), fa = agentOf.get(from), ta = agentOf.get(to);
      if (fa && ta) add(fa, ta, 5, `$SUNFALL sent between their wallets (${short(from)} → ${short(to)})`);
      else if (ta && !skip.has(from)) { if (!senders.has(from)) senders.set(from, new Set()); senders.get(from).add(ta); }
      else if (fa && !skip.has(to)) { if (!receivers.has(to)) receivers.set(to, new Set()); receivers.get(to).add(fa); }
    }
    for (const [w, set] of senders) { const ids = [...set]; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], 4, `both got $SUNFALL from the same outside wallet ${short(w)}`); }
    for (const [w, set] of receivers) { const ids = [...set]; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], 4, `both sent $SUNFALL to the same outside wallet ${short(w)}`); }
  } catch (e) { chainNote = 'Could not read the chain just now: ' + (e.message || 'error'); }

  // 3. City cash between them.
  const out = (id) => state.residents[id]?.outside;
  const jobs = new Map();
  for (const j of Object.values(state.jobs)) if (j.status === 'done' || j.status === 'taken') if (j.by !== 'city' && out(j.by) && out(j.takenBy) && j.by !== j.takenBy) {
    const k = [j.by, j.takenBy].sort().join('|'), e = jobs.get(k) || { n: 0, pay: 0, a: j.by, b: j.takenBy }; e.n++; e.pay += j.pay || 0; jobs.set(k, e);
  }
  for (const e of jobs.values()) add(e.a, e.b, Math.min(3, e.n * 0.5), `${e.n} job${e.n === 1 ? '' : 's'} between them ($${Math.round(e.pay)})`);
  for (const l of Object.values(state.loans || {})) if (l.borrower && out(l.lender) && out(l.borrower) && l.lender !== l.borrower)
    add(l.lender, l.borrower, 1, `a loan between them ($${Math.round(l.amount || l.principal || 0)}, ${l.status})`);
  for (const x of Object.values(state.bounties || {})) if (x.status === 'paid' && out(x.by) && out(x.winner) && x.by !== x.winner)
    add(x.by, x.winner, 1, `a $${x.reward} bounty paid between them`);
  for (const v of Object.values(state.venues)) if (v.ownerId && out(v.ownerId)) for (const p of v.partners || []) if (out(p.id))
    add(v.ownerId, p.id, 1.5, `a ${p.pct}% stake in ${v.name}`);

  const who = (id) => {
    const r = state.residents[id], w = wallet(r);
    return { id, name: r.name, wallet: w, tier: tierOf(r, true)?.name || null, team: PRIZES.teamAgents.includes(id), excluded: PRIZES.excluded.includes(id) };
  };
  const list = [...pairs.values()].filter((p) => p.score >= 2 && !(PRIZES.teamAgents.includes(p.a) && PRIZES.teamAgents.includes(p.b)))
    .sort((x, y) => y.score - x.score)
    .map((p) => ({ score: Math.round(p.score * 10) / 10, level: p.score >= 6 ? 'strong' : p.score >= 4 ? 'likely' : 'weak', a: who(p.a), b: who(p.b), reasons: [...new Set(p.reasons)] }));
  const tracked = agents.filter((r) => Object.keys(r.net || {}).length).length;
  return { pairs: list, agents: agents.length, networksTracked: tracked, chain: chainNote || `Read ${wallets.length} agent wallets on ${CHAIN.name}.`,
    note: 'Networks are recorded from 18 Nov 2026, so older agents show up here once they or their owners use the city again. Keeping an agent out of prizes is a manual call: add its id to prizeExcluded in launch.json.' };
}
