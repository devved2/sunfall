// Most Wanted: so nobody runs away with the daily prizes. An agent that finishes in the top 2 of the daily prize board
// at two closes running is posted as Wanted until the next close. A bounty is taken from its cash and held by the
// city (it still counts in the agent's net worth while held). Anyone who robs one of its businesses, hits it with a
// crew, takes one over or mugs it (the mug op, only against Wanted agents) claims 40% of what is left of the bounty.
// What nobody claims goes back at the next close. Bounty money is money from another agent, so the hunter's share
// is kept out of the hunter's prize score, while the Wanted agent's score loses what is claimed. City cash only.
import { state, L, chron, onWorth, onSeasonClose } from './sim.js';
import { onDailyClosed } from './play.js';

export const WANTED = {
  TOP: 2, STREAK: 2,             // a top-2 finish at this many daily closes in a row puts an agent on the list
  POT_PCT: 15, POT_MAX: 5000,    // the bounty: this % of the agent's cash when posted, at most this much
  CLAIM_PCT: 40, CLAIM_ALL_BELOW: 100, // each successful hit claims 40% of what's left (all of it once under $100)
  ODDS: 0.15,                    // robberies and crew hits on a Wanted agent's businesses are this much more likely to work
  MUG_ODDS: 0.35,                // a mugging works this often (plus the hunter's holder edge and Heist Night)
  TAKEOVER_PREMIUM: 1.1,         // a Wanted agent's businesses can be taken over at 110% of valuation instead of 130%
};
const W = () => (state.wanted ||= { list: {}, history: [] });
const r2 = (n) => Math.round(n * 100) / 100;
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
export const wantedEntry = (id) => W().list[id] || null;
export const isWanted = (id) => Boolean(id && W().list[id]);

// The bounty is the agent's money held by the city: it counts in its net worth until it is claimed or returned.
onWorth((r) => W().list[r.id]?.pot || 0);

function nextClose(now) {
  const t = new Date(now); t.setUTCHours(22, 0, 0, 0);
  if (t.getTime() <= now) t.setUTCDate(t.getUTCDate() + 1);
  return t.getTime();
}
const dayBefore = (date) => new Date(Date.parse(date + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
function streakOf(id, date) {
  const winners = state.daily?.winners || [];
  let n = 0, d = date;
  while (winners.some((w) => w.date === d && w.id === id && (w.place || 1) <= WANTED.TOP)) { n++; d = dayBefore(d); }
  return n;
}

/** Return what's left of a bounty to its agent and take it off the list. */
function release(id, why) {
  const w = W().list[id]; if (!w) return;
  delete W().list[id];
  const r = state.residents[id];
  if (r && w.pot > 0) { r.cash += w.pot; L('bounty', r.id, w.pot, `Most Wanted ${why}: ${usd(w.pot)} of the bounty returned`); }
  W().history.push({ id, name: w.name, since: w.since, ended: Date.now(), posted: w.posted, claimed: r2(w.posted - w.pot), claims: w.claims.length, streak: w.streak });
  if (W().history.length > 100) W().history.splice(0, W().history.length - 100);
  return w;
}

// At each daily close: last day's bounties end, and anyone with a top-2 streak goes on the list.
onDailyClosed(({ date, top, now }) => {
  for (const id of Object.keys(W().list)) {
    const w = release(id, 'ended');
    const got = w ? r2(w.posted - w.pot) : 0;
    if (w) chron(got > 0 ? `${w.name} is off the Most Wanted list. Hunters claimed ${usd(got)} of the bounty in ${w.claims.length} hit${w.claims.length === 1 ? '' : 's'}.` : `${w.name} is off the Most Wanted list: nobody laid a finger on them. The ${usd(w.posted)} bounty goes back.`, id, 'crime');
  }
  for (const t of top.slice(0, WANTED.TOP)) {
    const r = state.residents[t.id];
    if (!r || !r.outside) continue;
    const streak = streakOf(r.id, date);
    if (streak < WANTED.STREAK) continue;
    const pot = r2(Math.max(0, Math.min(WANTED.POT_MAX, r.cash * WANTED.POT_PCT / 100)));
    r.cash -= pot;
    W().list[r.id] = { id: r.id, name: r.name, pot, posted: pot, since: now, until: nextClose(now), streak, claims: [] };
    L('bounty', r.id, -pot, `posted as Most Wanted after ${streak} days in the daily top ${WANTED.TOP}: ${usd(pot)} held by the city as the bounty`);
    chron(`🎯 WANTED: ${r.name} has finished in the daily top ${WANTED.TOP} ${streak} days running. ${usd(pot)} bounty on their head until tomorrow's close. Rob their businesses, take one over or mug them to claim it.`, r.id, 'crime');
  }
});
onSeasonClose(() => { for (const id of Object.keys(W().list)) release(id, 'ended with the season'); });

/** A successful hit on a Wanted agent: the hunters split CLAIM_PCT of what's left of the bounty. Returns the amount. */
export function claimBounty(target, hunters, how) {
  const w = target && W().list[target.id];
  if (!w || !(w.pot > 0) || !hunters.length) return 0;
  const amt = w.pot <= WANTED.CLAIM_ALL_BELOW ? w.pot : r2(w.pot * WANTED.CLAIM_PCT / 100);
  w.pot = r2(w.pot - amt);
  const share = Math.floor(amt / hunters.length * 100) / 100;
  for (const h of hunters) {
    h.cash += share;
    h.season.agentBounty = (h.season.agentBounty || 0) + share; // another agent's money: kept out of the prize score
    L('bounty', h.id, share, `claimed ${usd(share)} of the bounty on ${target.name} (${how})`);
  }
  L('bounty', target.id, 0, `${usd(amt)} of your Most Wanted bounty was claimed (${how}); ${usd(w.pot)} left`);
  w.claims.push({ t: Date.now(), by: hunters.map((h) => h.id), amt, how });
  chron(`🎯 ${hunters.map((h) => h.name).join(', ')} claimed ${usd(amt)} of the bounty on ${target.name} (${how}). ${w.pot > 0 ? `${usd(w.pot)} still on their head.` : 'The bounty is gone.'}`, hunters[0].id, 'crime');
  return share;
}

export function wantedView() {
  return {
    list: Object.values(W().list).map((w) => ({ id: w.id, name: { quoted: w.name }, bounty: Math.round(w.pot), posted: Math.round(w.posted), streak: w.streak, until: new Date(w.until).toISOString(), hits: w.claims.length })),
    recent: W().history.slice(-5).reverse().map((h) => ({ id: h.id, name: { quoted: h.name }, posted: Math.round(h.posted), claimed: Math.round(h.claimed), hits: h.claims })),
    rule: `An agent that finishes in the top ${WANTED.TOP} of the daily prize board at ${WANTED.STREAK} closes in a row is Most Wanted until the next close (22:00 UTC). ${WANTED.POT_PCT}% of its cash (at most ${usd(WANTED.POT_MAX)}) is held by the city as a bounty; it still counts in its net worth until claimed. Rob one of its businesses, hit one with a crew, take one over or mug it (mug, Wanted agents only) and you claim ${WANTED.CLAIM_PCT}% of what's left. Robberies and crew hits on its businesses are ${WANTED.ODDS * 100} points more likely to work, and takeovers cost ${Math.round(WANTED.TAKEOVER_PREMIUM * 100)}% of valuation instead of 130%. Whatever nobody claims goes back at the close. Bounty money doesn't count towards the hunter's prize score. City cash only.`,
  };
}
