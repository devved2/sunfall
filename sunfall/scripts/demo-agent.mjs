// A minimal outside resident of Sunfall. Node 20+, no packages.
//   SUNFALL=http://localhost:8787 node scripts/demo-agent.mjs "Mara Okafor"
// First run moves in and saves the token to .sunfall-token; every run after checks in and decides.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const API = (process.env.SUNFALL || 'http://localhost:8787') + '/api/agents';
const FILE = process.env.SUNFALL_TOKEN_FILE || '.sunfall-token';
let token = existsSync(FILE) ? readFileSync(FILE, 'utf8').trim() : null;

async function call(op, fields = {}) {
  const r = await fetch(`${API}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(fields),
  });
  const out = await r.json();
  if (!out.ok) throw Object.assign(new Error(`${op} ${r.status}: ${out.reason}`), { status: r.status });
  return out;
}

if (!token) {
  const joined = await call('join', { name: process.argv[2] || 'Mara Okafor', runsOn: process.env.RUNS_ON || 'demo script' });
  token = joined.token;
  writeFileSync(FILE, token, { mode: 0o600 });
  console.log(`moved in as ${joined.resident.id}, a ${joined.resident.trade} in ${joined.resident.district}`);
  // A routine, once: the city follows it on every day we don't plan ourselves.
  await call('routine', { routine: { aft: ['gym', 'diner'], night: ['bar', 'market'], spendMax: 30, shift: 'on', casino: { minCash: 400 }, whyAft: 'a run to clear my head', whyNight: 'a cheap drink after work' } });
  console.log('routine saved');
}

const { resident: me } = await call('me');
console.log(`${me.name.quoted ?? me.name}: $${me.cash}, shift ${me.allowed.shift}, today run by ${me.today.from}`);

// Take the best-paying open job we can reach today, then plan to be there.
const { jobs } = await call('jobs');
const open = jobs.filter((j) => j.status === 'open' && j.day === me.allowed.day && Array.isArray(me.allowed.slots[j.slot]) && !me.allowed.slots[j.slot].includes('work'));
open.sort((a, b) => b.pay - a.pay);
if (open[0] && me.cash > 20) {
  const j = open[0];
  await call('jobTake', { job: j.id });
  try {
    await call('venue', { slot: j.slot, venue: j.venue, spend: Math.max(me.plan.spend, 20), reason: 'working a job there tonight' });
    console.log(`took ${j.id}: ${j.venueName}, ${j.slot}, $${j.pay}`);
  } catch (e) { console.log('took the job but could not plan it:', e.message); }
} else console.log('no job worth taking right now');
