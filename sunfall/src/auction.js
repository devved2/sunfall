// Business auctions after a season reset.
//
// At a reset every business the agents owned goes back to the city. Instead of going on sale to whoever is first with
// the cash, each one goes to a sealed-bid auction. The auctions close in waves through the first real day of the
// season, so agents who start late, or need a few hours to build up cash, still get a shot. The highest bid wins and
// pays what it bid to the city treasury; if nobody bids the reserve, the business goes on sale as normal.
//
// Bids are sealed: everyone sees how many bids a business has, never the amounts, until it closes. A bid's cash is held
// (it still counts toward your net worth) and comes back if you lose. You can raise your bid, never lower or withdraw it.
import { state, L, chron, chargeDecision, onDayTurn, onSeasonClose, onWorth, buyBusiness } from './sim.js';
import { VTYPES, cityOfDistrict, DISTRICTS } from './world.js';
import { refuse } from './util.js';
import { PRIZES } from './launch.js';

export const AUCTION = {
  WAVES: [12, 24, 36, 48], // city days after the reset at which each wave of auctions closes (6, 12, 18 and 24 hours)
  MIN_RAISE: 10,           // a raised bid must beat your last by at least this
  KEEP_RESULTS: 40,
};

const A = () => (state.auctions ||= { open: {}, results: [] });
const ownedBy = (r) => Object.values(state.venues).filter((v) => v.ownerId === r.id);
const name = (id) => state.residents[id]?.name || 'someone';
const dname = (d) => DISTRICTS.find((x) => x.id === d)?.name || d;

// Called by the season close, after the agents' businesses have gone back to the city.
export function openAuctions(venueIds) {
  const a = A();
  const list = venueIds.map((id) => state.venues[id]).filter((v) => v && v.isVenue && !v.ownerId)
    .sort((x, y) => (VTYPES[y.type].value - VTYPES[x.type].value) || x.id.localeCompare(y.id));
  list.forEach((v, i) => {
    const closes = state.day + AUCTION.WAVES[i % AUCTION.WAVES.length];
    v.forSale = true; v.heldUntilDay = closes; // no one, agent or native, can buy it outright while it is at auction
    a.open[v.id] = { venue: v.id, reserve: v.salePrice, opened: state.day, closesDay: closes, bids: {}, seasonId: state.season?.id };
  });
  if (list.length) chron(`${list.length} businesses go to auction for the new season. Bids are sealed; the first close in ${AUCTION.WAVES[0]} city days and the last in ${AUCTION.WAVES[AUCTION.WAVES.length - 1]}. See auctions.`, null, 'business');
}

export function auctionBid(r, b) {
  if (!r.outside) refuse(403, 'agents only');
  const au = A().open[b.venue];
  if (!au) refuse(404, 'that business is not at auction (see auctions)');
  const v = state.venues[au.venue];
  const amount = Math.floor(Number(b.amount));
  if (!Number.isFinite(amount) || amount <= 0) refuse(422, 'amount must be a whole number of dollars');
  if (amount < au.reserve) refuse(422, `the reserve on ${v.name} is $${au.reserve}`);
  const mine = au.bids[r.id];
  if (mine && amount < mine.amount + AUCTION.MIN_RAISE) refuse(422, `you already bid $${mine.amount}: a new bid must be at least $${mine.amount + AUCTION.MIN_RAISE} (bids can be raised, never lowered or withdrawn)`);
  if (ownedBy(r).length >= PRIZES.maxBusinesses) refuse(409, `an agent can own at most ${PRIZES.maxBusinesses} businesses at once`);
  const topUp = amount - (mine?.amount || 0);
  const pay = chargeDecision(r);
  if (r.cash - 3 < topUp) refuse(402, `that bid needs $${topUp} more of your cash held until the auction closes; you have $${Math.floor(r.cash)}`);
  pay();
  r.cash -= topUp;
  L('escrow', r.id, -topUp, `bid $${amount} for ${v.name} at auction (held until it closes)`);
  au.bids[r.id] = { amount, t: Date.now() };
  return { auction: auctionView(au, r) };
}

function settle(au) {
  const a = A(), v = state.venues[au.venue];
  delete a.open[au.venue];
  const ranked = Object.entries(au.bids).map(([id, x]) => ({ id, ...x })).sort((p, q) => (q.amount - p.amount) || (p.t - q.t));
  let winner = null;
  for (const x of ranked) {
    const r = state.residents[x.id];
    if (!winner && r && ownedBy(r).length < PRIZES.maxBusinesses && v && !v.ownerId) winner = x;
  }
  for (const x of ranked) { // every held bid comes back first; the winner then pays from it
    const r = state.residents[x.id]; if (!r) continue;
    r.cash += x.amount;
    L('escrow', r.id, x.amount, x === winner ? `bid for ${v?.name} released to pay for it` : `bid for ${v?.name} returned: outbid at auction`);
  }
  const result = { venue: au.venue, name: v?.name, closedDay: state.day, bids: ranked.length, reserve: au.reserve, winner: winner?.id || null, price: winner?.amount || null };
  a.results.unshift(result); a.results.length = Math.min(a.results.length, AUCTION.KEEP_RESULTS);
  if (!v) return;
  v.heldUntilDay = state.day;
  if (winner) {
    v.salePrice = winner.amount;
    buyBusiness(state.residents[winner.id], v);
    chron(`${name(winner.id)} wins ${v.name} at auction for $${winner.amount} (${ranked.length} sealed bid${ranked.length === 1 ? '' : 's'}, reserve $${au.reserve}).`, winner.id, 'business');
  } else chron(`No one met the $${au.reserve} reserve for ${v.name} at auction: it goes on sale to the first buyer.`, null, 'business');
}

function auctionDay() {
  for (const au of Object.values(A().open)) if (state.day >= au.closesDay) settle(au);
}

function auctionView(au, r = null) {
  const v = state.venues[au.venue];
  return { venue: au.venue, name: v?.name, type: v?.type, district: v?.district, districtName: dname(v?.district), city: v ? cityOfDistrict(v.district) : null,
    reserve: au.reserve, closesAtDay: au.closesDay, closesInDays: Math.max(0, au.closesDay - state.day), bids: Object.keys(au.bids).length,
    ...(r ? { yourBid: au.bids[r.id]?.amount ?? null } : {}) };
}

export function auctionsView(r = null) {
  const a = A();
  return {
    open: Object.values(a.open).sort((x, y) => x.closesDay - y.closesDay).map((au) => auctionView(au, r)),
    results: a.results.slice(0, 20).map((x) => ({ ...x, winnerName: x.winner ? name(x.winner) : null })),
    rule: `After each season reset the agents' old businesses go to sealed-bid auctions, closing in waves ${AUCTION.WAVES.join(', ')} city days after the reset. Bid at least the reserve with auctionBid (one decision); your bid's cash is held until the auction closes and still counts toward your net worth. You see how many bids a business has, never the amounts. You can raise a bid by at least $${AUCTION.MIN_RAISE}, never lower or withdraw it. The highest bid wins (the earlier one on a tie) and pays what it bid to the city treasury; losing bids come straight back. A winner already at the ${PRIZES.maxBusinesses}-business limit is skipped for the next highest bid. If nobody meets the reserve, the business goes on sale to the first buyer.`,
  };
}

export const atAuction = (venueId) => Boolean(state.auctions?.open?.[venueId]);

export function initAuctions() {
  onDayTurn(auctionDay);
  // Held bids count toward net worth, so bidding never costs an agent prize score.
  onWorth((r) => Object.values(state.auctions?.open || {}).reduce((s, au) => s + (au.bids[r.id]?.amount || 0), 0));
  // An auction still open when a season closes is called off and every bid returned before cash resets.
  onSeasonClose(() => {
    const a = A();
    for (const au of Object.values(a.open)) {
      for (const [id, x] of Object.entries(au.bids)) { const r = state.residents[id]; if (r) { r.cash += x.amount; L('escrow', id, x.amount, `bid for ${state.venues[au.venue]?.name} returned: the season closed`); } }
      au.bids = {};
    }
    a.carry = Object.keys(a.open); a.open = {};
  });
}
// Businesses whose auction was called off at the close go back to auction with the new season's.
export const carriedOver = () => { const a = A(), ids = a.carry || []; a.carry = []; return ids; };
