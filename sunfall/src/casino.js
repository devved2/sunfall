// The casino deals real blackjack. Every visit is one hand, dealt the moment the night lands with the city's secure
// random, and every hand is kept so anyone can see the cards that decided it (sunfall.world/casino, where new hands
// are dealt onto the table card by card; the city page pops up each agent's hand as it lands).
// Residents play the dealer's own rule (hit below 17); blackjack pays 3:2. On a lucky night they play proper
// strategy and a blackjack pays 2:1, which is what "better odds at every table" means.
import { secureRandom } from './util.js';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const card = () => RANKS[Math.floor(secureRandom() * 13)] + SUITS[Math.floor(secureRandom() * 4)];
const value = (c) => { const r = c.slice(0, -1); return r === 'A' ? 11 : ['J', 'Q', 'K'].includes(r) ? 10 : Number(r); };
export function total(hand) {
  let t = 0, aces = 0;
  for (const c of hand) { const v = value(c); t += v; if (v === 11) aces++; }
  while (t > 21 && aces > 0) { t -= 10; aces--; }
  return t;
}
const upValue = (c) => value(c);
const mimic = (t) => t < 17;
const basic = (t, up) => t <= 11 || (t <= 16 && up >= 7) || (t === 12 && (up === 2 || up === 3));

/** Deal one hand. Returns the cards, totals, the result and the payout multiple of the stake (−1 lose, 0 push, 1 win, 1.5 or 2 blackjack). */
export function dealHand(lucky = false) {
  const player = [card(), card()], dealer = [card(), card()];
  const pbj = total(player) === 21, dbj = total(dealer) === 21;
  let result;
  if (pbj || dbj) result = pbj && dbj ? 'push' : pbj ? 'blackjack' : 'lose';
  else {
    const hit = lucky ? basic : mimic;
    while (hit(total(player), upValue(dealer[0]))) player.push(card());
    if (total(player) > 21) result = 'bust';
    else {
      while (total(dealer) < 17) dealer.push(card());
      const pt = total(player), dt = total(dealer);
      result = dt > 21 || pt > dt ? 'win' : pt === dt ? 'push' : 'lose';
    }
  }
  const mult = { blackjack: lucky ? 2 : 1.5, win: 1, push: 0, lose: -1, bust: -1 }[result];
  return { player, dealer, pt: total(player), dt: total(dealer), result, mult };
}
