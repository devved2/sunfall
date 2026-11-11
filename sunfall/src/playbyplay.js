// Play-by-play for the city's league games, so people can watch them live.
// Nothing here changes a result. Each game's plays are built from the result drawn at kick-off (football.js,
// gridiron.js) plus filler plays from a stream seeded by the game id, so every viewer, and every restart, sees
// the same game. Plays are only handed out once the game clock has reached them.
// Ball positions run 0-100 along the ground: the home side attacks towards 100.
import { mulberry32, clamp } from './util.js';

const seedOf = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const other = (s) => (s === 'home' ? 'away' : 'home');
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;

// After the plays are sorted: running score, and text that needs the score at that moment.
function finish(plays) {
  plays.sort((a, b) => a.t - b.t);
  const s = [0, 0];
  let x = 50, y = 50;
  return plays.map((p) => {
    if (p.pts) s[p.side === 'home' ? 0 : 1] += p.pts;
    if (p.x != null) { x = p.x; y = p.y ?? 50; }
    const out = { t: r2(p.t), kind: p.kind, side: p.side || null, x: r1(x), y: r1(y), s: [...s], text: typeof p.text === 'function' ? p.text(s) : p.text };
    if (p.fd != null) out.fd = r1(p.fd);
    if (p.dd) out.dd = p.dd;
    if (p.who) out.who = p.who;
    return out;
  });
}

// ---------------------------------------------------------------- American football (Skyline Field)
// g: { id, home: { name }, away: { name }, events: [{ min, side, kind: 'td' | 'fg', pts, who, ot }], roster: { home: [], away: [] } }
export function gridironPlays(g) {
  const rnd = mulberry32(seedOf(g.id + ':pbp'));
  const R = (a, b) => a + rnd() * (b - a);
  const RI = (a, b) => Math.floor(R(a, b + 1));
  const name = (side) => g[side].name;
  const who = (side) => g.roster[side][Math.floor(rnd() * g.roster[side].length)];
  const fx = (side, y) => (side === 'home' ? y : 100 - y);
  const spot = (y) => (Math.round(y) === 50 ? 'midfield' : y < 50 ? `their own ${Math.round(y)}` : `the opponent's ${Math.round(100 - y)}`);
  const plays = [];
  const add = (p) => plays.push(p);

  // One drive: returns where the other side starts its next drive (yards from its own goal line).
  function drive(side, ts, te, start, outcome, ev) {
    const steps = [];
    let y = start, down = 1, first = Math.min(100, y + 10);
    const dd = () => `${['1st', '2nd', '3rd', '4th'][down - 1]} & ${first >= 100 ? 'goal' : Math.max(1, Math.round(first - y))}`;
    const target = outcome === 'td' ? 100 : outcome === 'fg' ? R(58, 80) : outcome === 'punt' ? R(start + 4, Math.max(start + 6, 55)) : R(Math.max(start + 5, 35), 72);
    const snap = (gain, text) => {
      const label = dd(), lineOf = fx(side, first);
      y = clamp(y + gain, 1, 100);
      steps.push({ kind: 'play', side, x: fx(side, y), fd: lineOf, dd: label, text });
      if (y >= first) { down = 1; first = Math.min(100, y + 10); } else down++;
    };
    const runOrPass = (gain) => {
      const p = who(side);
      if (gain === 0 && rnd() < 0.6) return `Pass incomplete, intended for ${p}.`;
      if (gain < 0) return `${p} is dropped for a loss of ${-gain}.`;
      if (rnd() < 0.5) return `${p} runs for ${gain} yard${gain === 1 ? '' : 's'}.`;
      return gain >= 20 ? `Deep ball! ${p} hauls it in for ${gain} yards.` : `${p} catches it for ${gain} yard${gain === 1 ? '' : 's'}.`;
    };
    // move the ball towards the target, converting third downs so the drive keeps going
    let guard = 0;
    while (y < target - 0.5 && guard++ < 18) {
      let gain = rnd() < 0.16 ? 0 : Math.round(R(-3, 2) + Math.pow(rnd(), 1.5) * 24);
      if (down === 3 && y + gain < first) gain = Math.ceil(first - y + R(0, 6));
      if (outcome === 'td' && y + gain >= 100) break; // the scoring play comes below
      gain = Math.min(gain, Math.ceil(target - y));
      if (outcome !== 'td' && y + gain >= 99) gain = Math.floor(98 - y);
      snap(gain, runOrPass(gain));
    }
    // three plays that go nowhere, for drives that end on fourth down
    const stall = () => { while (down < 4) { const g = Math.max(0, Math.min(RI(0, 3), Math.floor(first - y - 1))); snap(g, runOrPass(g)); } };
    let next;
    if (outcome === 'td') {
      const label = dd(), lineOf = fx(side, first), gain = Math.round(100 - y);
      const pass = rnd() < 0.55;
      steps.push({ kind: 'td', side, pts: 6, who: ev.who, x: fx(side, 100), fd: lineOf, dd: label,
        text: `TOUCHDOWN ${name(side).toUpperCase()}! ${ev.who} ${pass ? `catches a ${gain}-yard pass in the end zone` : `runs it in from ${gain} yard${gain === 1 ? '' : 's'} out`}.` });
      if (!ev.ot) steps.push({ kind: ev.pts === 7 ? 'xp' : 'xpmiss', side, pts: ev.pts === 7 ? 1 : 0, x: fx(side, 100), text: ev.pts === 7 ? 'The extra point is good.' : 'The extra point is no good! Wide right.', after: 0.05 });
      next = 25;
    } else if (outcome === 'fg') {
      const dist = Math.round(100 - y + 17);
      steps.push({ kind: 'fg', side, pts: 3, who: ev.who, x: fx(side, y), dd: dd(), text: `${ev.who} kicks a ${dist}-yard field goal. It's good! Three points for the ${name(side)}.` });
      next = 25;
    } else if (outcome === 'punt') {
      stall();
      const dist = RI(36, 52), land = y + dist;
      steps.push({ kind: 'punt', side, x: fx(side, Math.min(land, 100)), text: land >= 100 ? `${who(side)} punts ${dist} yards into the end zone. Touchback.` : `${who(side)} punts ${dist} yards, fair catch at the ${name(other(side))} ${Math.round(100 - land)}.` });
      next = land >= 100 ? 20 : 100 - land;
    } else if (outcome === 'int') {
      const ret = RI(0, 18);
      steps.push({ kind: 'turnover', side: other(side), x: fx(side, Math.max(1, y - ret)), text: `INTERCEPTED! ${who(other(side))} picks it off${ret > 4 ? ` and returns it ${ret} yards` : ''}. ${name(other(side))} ball.` });
      next = clamp(100 - y + ret, 5, 95);
    } else if (outcome === 'fumble') {
      steps.push({ kind: 'turnover', side: other(side), x: fx(side, y), text: `FUMBLE! ${who(side)} loses the ball and ${who(other(side))} falls on it. ${name(other(side))} ball.` });
      next = clamp(100 - y, 5, 95);
    } else if (outcome === 'downs') {
      while (down < 4) { const g = Math.max(0, Math.min(RI(0, 3), Math.floor(first - y - 1))); snap(g, runOrPass(g)); }
      steps.push({ kind: 'turnover', side: other(side), x: fx(side, y), dd: dd(), text: `The ${name(side)} go for it on ${dd()}... stopped short! Turnover on downs.` });
      next = clamp(100 - y, 5, 95);
    } else { // missed field goal
      stall();
      const dist = Math.round(100 - y + 17);
      steps.push({ kind: 'miss', side, x: fx(side, y), text: `${who(side)} tries a ${dist}-yard field goal... no good!` });
      next = clamp(100 - y + 7, 20, 95);
    }
    // spread the drive's plays across its time; the last one lands on te
    const main = steps.filter((s) => !s.after), n = main.length;
    main.forEach((s, i) => { s.t = ts + ((i + 1) * (te - ts)) / n; });
    steps.filter((s) => s.after).forEach((s) => { s.t = te + s.after; });
    steps[0].text = `${name(side)} ball at ${spot(start)}. ` + steps[0].text;
    for (const s of steps) add(s);
    return next;
  }
  const fillOutcome = () => { const u = rnd(); return u < 0.55 ? 'punt' : u < 0.67 ? 'int' : u < 0.75 ? 'fumble' : u < 0.85 ? 'downs' : 'miss'; };

  // the drives: scoring drives end on the minute their score was drawn; other drives fill the gaps,
  // with the ball changing hands so the side that scores always has it
  let c = 0.15, poss, start = 25;
  function segment(events, end) {
    for (const e of events) {
      const te = Math.max(c + 0.4, e.min - R(0.15, 0.85));
      let ts = Math.max(c, te - R(1.8, 4.2));
      let n = Math.round((ts - c) / 3);
      if ((n % 2 === 1) !== (poss !== e.side)) n += n > 0 && rnd() < 0.5 ? -1 : 1;
      if (n > 0) ts = Math.min(te - 0.4, c + Math.max(ts - c, 0.5 * n));
      for (let i = 0; i < n; i++) {
        const a = c + ((ts - c) * i) / n, b = c + ((ts - c) * (i + 1)) / n;
        start = drive(poss, a, b - 0.05, start, fillOutcome());
        poss = other(poss);
      }
      add({ t: ts, kind: 'start', side: poss, x: fx(poss, start), text: null, hidden: true });
      start = drive(poss, ts + 0.02, te, start, e.kind, e);
      add({ t: te + 0.1, kind: 'kickoff', side: other(poss), x: fx(other(poss), start), text: `${who(poss)} kicks off. ${name(other(poss))} start at their own ${start}.` });
      poss = other(poss); c = te + 0.15;
    }
    if (end != null) {
      const n = Math.max(0, Math.round((end - c) / 3));
      for (let i = 0; i < n; i++) {
        const a = c + ((end - c) * i) / n, b = c + ((end - c) * (i + 1)) / n;
        start = drive(poss, a, b - 0.05, start, fillOutcome());
        poss = other(poss);
      }
      if (!n && end - c > 0.2) add({ t: end - 0.1, kind: 'play', side: poss, x: fx(poss, start), text: `${name(poss)} take a knee to run out the clock.` });
      c = end;
    }
  }
  const reg = g.events.filter((e) => !e.ot), ot = g.events.filter((e) => e.ot);
  poss = rnd() < 0.5 ? 'home' : 'away';
  add({ t: 0, kind: 'kickoff', side: poss, x: fx(poss, start), text: `Kick-off at Skyline Field! The ${name(poss)} receive and start at their own 25.` });
  segment(reg, 60);
  add({ t: 15, kind: 'marker', text: 'End of the first quarter.' });
  add({ t: 30, kind: 'marker', text: (s) => `Half-time: ${name('home')} ${s[0]}, ${name('away')} ${s[1]}.` });
  add({ t: 45, kind: 'marker', text: 'End of the third quarter.' });
  let T = 60;
  if (ot.length) {
    add({ t: 60, kind: 'marker', text: (s) => `End of regulation, tied at ${s[0]}. We're going to overtime!` });
    poss = 'home'; start = 25; c = 60.15;
    segment(ot, null);
    T = Math.max(...ot.map((e) => e.min));
  }
  T = Math.max(T, ...plays.map((p) => p.t + 0.05)); // a late score can run a few seconds past the hour
  add({ t: T, kind: 'final', text: (s) => `FINAL: ${name('home')} ${s[0]}, ${name('away')} ${s[1]}.` });
  return { T, plays: finish(plays.filter((p) => !p.hidden)) };
}

// ---------------------------------------------------------------- football (Sunfall Arena)
// m: { id, home: { name }, away: { name }, events: [{ min, side, kind: 'goal' | 'card', who }], squad: { home: [], away: [] } }
export function footballPlays(m) {
  const T = 93;
  const rnd = mulberry32(seedOf(m.id + ':pbp'));
  const R = (a, b) => a + rnd() * (b - a);
  const name = (side) => m[side].name;
  const who = (side) => m.squad[side][Math.floor(rnd() * m.squad[side].length)];
  const fx = (side, a) => (side === 'home' ? a : 100 - a); // a: how far up the pitch the side is attacking
  const plays = [];
  const add = (p) => plays.push(p);
  const goals = m.events.filter((e) => e.kind === 'goal').map((e) => ({ ...e, t: Math.min(T - 0.2, e.min - R(0.1, 0.9)) })).sort((a, b) => a.t - b.t);
  // each goal gets a short build-up; filler play stays out of those windows
  const windows = [];
  for (const g of goals) {
    const prevEnd = windows.length ? windows.at(-1).end : 0.3;
    const start = Math.max(prevEnd + 0.1, g.t - R(1.2, 2.4));
    windows.push({ g, start: Math.min(start, g.t - 0.05), end: g.t + 0.7 });
  }
  add({ t: 0, kind: 'kickoff', side: 'home', x: 50, y: 50, text: `We're under way at Sunfall Arena! ${name('home')} v ${name('away')}.` });
  let t = 0.4, side = rnd() < 0.5 ? 'home' : 'away', a = 45, w = 0, half2 = false;
  const filler = () => {
    if (rnd() < 0.3) { side = other(side); a = 100 - a; }
    a = clamp(a + R(-8, 24), 8, 96);
    const y = R(10, 90), p = who(side), q = who(other(side));
    let text, kind = 'play';
    if (a > 82) {
      const u = rnd();
      if (u < 0.3) text = `${p} shoots... saved by the ${name(other(side))} goalkeeper!`;
      else if (u < 0.52) text = `${p} lets fly from the edge of the box. Just wide!`;
      else if (u < 0.68) text = `${p} heads it over the bar.`;
      else if (u < 0.84) text = `Corner to ${name(side)}. ${q} heads it clear.`;
      else text = `${p}'s shot is blocked by ${q}.`;
      kind = 'chance';
      add({ t, kind, side, x: fx(side, Math.min(a + 6, 97)), y: R(35, 65), text });
      side = other(side); a = 100 - Math.min(a, 92) + R(0, 6); // the other side has it back near its own goal
      return;
    }
    if (a > 62) text = pick3(rnd, [`${p} skips past ${q} down the ${y < 50 ? 'left' : 'right'}.`, `${p} whips in a cross. ${q} gets there first.`, `A clever through ball, but ${p} is flagged offside.`, `${p} drives into the final third.`]);
    else if (a > 35) text = pick3(rnd, [`${p} switches play to the ${y < 50 ? 'left' : 'right'}.`, `${q} wins it back with a strong tackle.`, `Foul on ${p}. Free kick in midfield.`, `${name(side)} keep the ball, patient passing in midfield.`]);
    else text = pick3(rnd, [`${name(side)} play it out from the back.`, `${p} goes long towards the front line.`, `The ${name(side)} goalkeeper rolls it out.`, `${q} closes down, ${p} clears it upfield.`]);
    add({ t, kind, side, x: fx(side, a), y, text });
  };
  while (t < T - 0.3 || w < windows.length) {
    if (!half2 && t >= 45) {
      add({ t: 45, kind: 'marker', text: (s) => `Half-time: ${name('home')} ${s[0]}-${s[1]} ${name('away')}.` });
      add({ t: 45.6, kind: 'kickoff', side: 'away', x: 50, y: 50, text: 'The second half is under way.' });
      half2 = true; side = 'away'; a = 50; t = Math.max(t, 46);
    }
    const win = windows[w];
    if (win && t >= win.start - 0.6) {
      const { g } = win, s = g.side, n = 2 + Math.floor(rnd() * 2);
      let aa = R(40, 60);
      for (let i = 0; i < n; i++) {
        aa = Math.min(90, aa + R(10, 18));
        const p = who(s);
        add({ t: win.start + ((g.t - win.start) * i) / n, kind: 'play', side: s, x: fx(s, aa), y: R(20, 80),
          text: i === n - 1 ? pick3(rnd, [`${p} finds ${g.who} in the box...`, `${p} crosses towards ${g.who}...`, `${g.who} gets a yard on the defender...`]) : pick3(rnd, [`${name(s)} break forward.`, `${p} carries it through midfield.`, `${p} plays a quick one-two.`]) });
      }
      add({ t: g.t, kind: 'goal', side: s, pts: 1, who: g.who, x: fx(s, 100), y: R(42, 58), text: (sc) => `GOAL! ${g.who} scores for ${name(s)}! ${name('home')} ${sc[0]}-${sc[1]} ${name('away')}.` });
      if (g.t < T - 1) add({ t: g.t + 0.6, kind: 'kickoff', side: other(s), x: 50, y: 50, text: `${name(other(s))} kick off again.` });
      side = other(s); a = 50; t = win.end + R(0.3, 0.8); w++;
      continue;
    }
    filler();
    t += R(0.9, 2.1);
    if (windows[w] && t > windows[w].start - 0.6) t = windows[w].start - 0.6;
  }
  for (const e of m.events.filter((x) => x.kind === 'card')) add({ t: e.min - 0.5, kind: 'card', side: e.side, text: `Yellow card for ${e.who} (${name(e.side)}).` });
  add({ t: T, kind: 'final', text: (s) => `FULL TIME: ${name('home')} ${s[0]}-${s[1]} ${name('away')}.` });
  return { T, plays: finish(plays) };
}
const pick3 = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

// ---------------------------------------------------------------- serving it
const cache = new Map();
// m: a league game (ko, ft, status); build: () => { T, plays }. `from` lets a viewer fetch only the new plays.
export function liveFeed(m, build, sport, from = 0, now = Date.now()) {
  const base = { id: m.id, sport, state: m.status, kickoff: m.ko, end: m.ft, now }; // not `status`: the server reads that as the HTTP code
  if (m.status === 'scheduled') return { ...base, T: null, total: 0, from: 0, plays: [] };
  let c = cache.get(m.id);
  if (!c) { c = build(); cache.set(m.id, c); if (cache.size > 40) cache.delete(cache.keys().next().value); }
  const upto = m.status === 'ft' ? Infinity : clamp((now - m.ko) / (m.ft - m.ko), 0, 1) * c.T;
  const shown = c.plays.filter((p) => p.t <= upto);
  const f = clamp(Math.floor(Number(from) || 0), 0, shown.length);
  return { ...base, T: c.T, total: shown.length, from: f, plays: shown.slice(f) };
}
