// The live game view on /field and /stadium: draws the ground, moves the ball through the play-by-play and
// runs the commentary. Plays come from the playbyplay op as the match clock reaches them; the view runs a few
// seconds behind the server so each play has arrived before it's shown. Finished games can be replayed.
(function () {
  const DELAY = 4000; // ms behind the live clock
  const css = `
.lv{background:#08130d;border:1px solid var(--line);border-radius:18px;overflow:hidden}
.lv canvas{display:block;width:100%}
.lv-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border-top:1px solid rgba(255,255,255,.08);font-family:var(--mono);font-size:12px;color:rgba(243,251,245,.8)}
.lv-bar .lv-st{flex:1;min-width:160px}
.lv-bar button{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);color:#f3fbf5;border-radius:999px;padding:5px 12px;font:inherit;font-size:11.5px;cursor:pointer}
.lv-bar button:hover{background:rgba(255,255,255,.16)}
.lv-live{display:inline-flex;align-items:center;gap:6px;color:#ff6b6b;font-weight:600}
.lv-live:before{content:'';width:8px;height:8px;border-radius:50%;background:#ff4b4b;animation:lvp 1.2s infinite}
@keyframes lvp{50%{opacity:.25}}
.lv-feed{list-style:none;margin:0;padding:6px 14px 12px;display:grid;gap:2px;max-height:216px;overflow:hidden}
.lv-feed li{display:grid;grid-template-columns:64px 1fr;gap:10px;font-size:13px;line-height:1.45;color:rgba(243,251,245,.88);padding:3px 0}
.lv-feed li.new{animation:lvin .35s ease}
.lv-feed li b{font-family:var(--mono);font-weight:500;font-size:11px;color:rgba(243,251,245,.5);padding-top:2px}
.lv-feed li.big{color:#fff;font-weight:600}
.lv-feed li.big span{border-left:3px solid var(--c,#ffb04a);padding-left:8px}
.lv-feed li.mk{color:#ffb04a}
@keyframes lvin{from{opacity:0;transform:translateY(-4px)}}
@media (prefers-reduced-motion:reduce){.lv-feed li.new{animation:none}.lv-live:before{animation:none}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const short = (n) => String(n || '').split(' ').slice(-1)[0];

  window.LiveView = function (root, sport) {
    const gridiron = sport === 'gridiron';
    root.innerHTML = '<div class="lv"><canvas aria-label="Live view of the game"></canvas><div class="lv-bar"><span class="lv-st"></span><span class="lv-act"></span></div><ol class="lv-feed" aria-live="polite"></ol></div>';
    const cv = root.querySelector('canvas'), stEl = root.querySelector('.lv-st'), actEl = root.querySelector('.lv-act'), feedEl = root.querySelector('.lv-feed');
    const ctx = cv.getContext('2d');
    let W = 0, H = 0, dpr = 1;
    let mode = 'idle';       // idle | live | replay | done
    let game = null;         // { id, home, away, kickoff, end, T, status }
    let plays = [], skew = 0, fetching = false, replayAt = 0, replaySpeed = 1, shownIdx = -2, info = { live: null, last: null, next: null };
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    function size() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = root.clientWidth || 600; H = Math.round(Math.max(190, Math.min(360, W * 0.46)));
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + 'px';
    }
    size(); addEventListener('resize', () => { size(); });

    function start(g, m) {
      game = { id: g.id, home: g.home, away: g.away, kickoff: g.kickoff, end: null, T: null, status: g.status };
      plays = []; shownIdx = -2; feedEl.innerHTML = ''; mode = m;
      if (m === 'replay') replayAt = performance.now();
      pull();
    }
    async function pull() {
      if (!game || fetching) return;
      if (mode === 'replay' && game.status === 'ft' && game.T != null) return; // a finished game comes in one go
      fetching = true;
      try {
        const r = await fetch('/api/agents/playbyplay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ match: game.id, from: plays.length }) });
        const j = await r.json();
        if (j.ok && j.id === game.id) {
          skew = j.now - Date.now();
          Object.assign(game, { kickoff: j.kickoff, end: j.end, T: j.T, status: j.state, home: j.home || game.home, away: j.away || game.away });
          if (j.from === plays.length) plays.push(...j.plays); else if (j.from === 0) plays = j.plays;
        }
      } catch {} finally { fetching = false; }
    }
    setInterval(() => { if (mode === 'live' || mode === 'replay') pull(); }, 2000);

    // Game minutes on display right now.
    function clockT() {
      if (!game || game.T == null || !game.end) return null;
      const dur = game.end - game.kickoff;
      if (mode === 'replay') return ((performance.now() - replayAt) * replaySpeed / dur) * game.T;
      if (mode === 'done') return game.T + 1;
      return ((Date.now() + skew - DELAY - game.kickoff) / dur) * game.T;
    }
    const realOf = (t) => (t / game.T) * (game.end - game.kickoff); // game minutes -> ms
    function clockLabel(t) {
      if (t == null || t < 0) return 'Kick-off';
      if (gridiron) {
        if (t > 60 && game.T > 60) return 'OT';
        const q = Math.min(4, Math.max(1, Math.ceil(t / 15))), left = Math.max(0, q * 15 - t);
        const m = Math.floor(left), s = Math.floor((left - m) * 60);
        return `Q${q} ${m}:${String(s).padStart(2, '0')}`;
      }
      const m = Math.max(1, Math.ceil(t));
      return m > 90 ? `90+${m - 90}'` : `${m}'`;
    }

    // ---------------------------------------------------------------- the ground
    function drawGround(home, away) {
      const pad = 14, top = 44, fw = W - pad * 2, fh = H - top - pad;
      const g = ctx;
      g.fillStyle = '#0b1a10'; g.fillRect(0, 0, W, H);
      if (gridiron) {
        const ez = fw / 12, px = (x) => pad + ez + (x / 100) * (fw - 2 * ez);
        for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? '#2b7f40' : '#2f8a45'; g.fillRect(px(i * 10), top, px((i + 1) * 10) - px(i * 10), fh); }
        g.fillStyle = home.col || '#1f5fa0'; g.globalAlpha = 0.75; g.fillRect(pad, top, ez, fh);
        g.fillStyle = away.col || '#b8402f'; g.fillRect(pad + fw - ez, top, ez, fh); g.globalAlpha = 1;
        g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2; g.strokeRect(pad, top, fw, fh);
        for (let yd = 0; yd <= 100; yd += 5) { g.lineWidth = yd % 10 ? 1 : 2; g.strokeStyle = yd % 10 ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.75)'; g.beginPath(); g.moveTo(px(yd), top); g.lineTo(px(yd), top + fh); g.stroke(); }
        g.fillStyle = 'rgba(255,255,255,.75)'; g.font = `600 ${Math.max(10, Math.round(fh / 13))}px Inter, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        for (let yd = 10; yd < 100; yd += 10) { const lab = String(yd <= 50 ? yd : 100 - yd); g.fillText(lab, px(yd), top + fh * 0.14); g.fillText(lab, px(yd), top + fh * 0.86); }
        g.save(); g.fillStyle = 'rgba(255,255,255,.9)'; g.font = `800 ${Math.max(11, Math.round(ez * 0.36))}px Inter, sans-serif`;
        g.translate(pad + ez / 2, top + fh / 2); g.rotate(-Math.PI / 2); g.fillText(short(home.name).toUpperCase(), 0, 0); g.restore();
        g.save(); g.fillStyle = 'rgba(255,255,255,.9)'; g.font = `800 ${Math.max(11, Math.round(ez * 0.36))}px Inter, sans-serif`;
        g.translate(pad + fw - ez / 2, top + fh / 2); g.rotate(Math.PI / 2); g.fillText(short(away.name).toUpperCase(), 0, 0); g.restore();
        return { px, py: (y) => top + fh * (0.3 + (y / 100) * 0.4), top, fh };
      }
      const px = (x) => pad + (x / 100) * fw, py = (y) => top + (y / 100) * fh;
      for (let i = 0; i < 12; i++) { g.fillStyle = i % 2 ? '#2b7f40' : '#2f8a45'; g.fillRect(pad + (fw * i) / 12, top, fw / 12 + 0.5, fh); }
      g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 2;
      g.strokeRect(pad, top, fw, fh);
      g.beginPath(); g.moveTo(px(50), top); g.lineTo(px(50), top + fh); g.stroke();
      g.beginPath(); g.arc(px(50), py(50), fh * 0.16, 0, Math.PI * 2); g.stroke();
      const bw = fw * 0.15, bh = fh * 0.56, sw = fw * 0.055, sh = fh * 0.28;
      g.strokeRect(pad, py(50) - bh / 2, bw, bh); g.strokeRect(pad + fw - bw, py(50) - bh / 2, bw, bh);
      g.strokeRect(pad, py(50) - sh / 2, sw, sh); g.strokeRect(pad + fw - sw, py(50) - sh / 2, sw, sh);
      g.fillStyle = home.col || '#fff'; g.fillRect(pad - 6, py(50) - fh * 0.08, 5, fh * 0.16);
      g.fillStyle = away.col || '#fff'; g.fillRect(pad + fw + 1, py(50) - fh * 0.08, 5, fh * 0.16);
      return { px, py, top, fh };
    }
    function drawBug(score, label, home, away, liveNow) {
      const g = ctx; g.textBaseline = 'middle';
      const y = 22;
      g.font = '600 13px Inter, sans-serif'; g.textAlign = 'left';
      g.fillStyle = home.col || '#fff'; g.fillRect(14, y - 9, 6, 18);
      g.fillStyle = '#f3fbf5'; g.fillText(W < 420 ? short(home.name) : home.name, 26, y);
      g.textAlign = 'right'; g.fillStyle = away.col || '#fff'; g.fillRect(W - 20, y - 9, 6, 18);
      g.fillStyle = '#f3fbf5'; g.fillText(W < 420 ? short(away.name) : away.name, W - 26, y);
      g.textAlign = 'center'; g.font = '700 20px "JetBrains Mono", monospace'; g.fillStyle = '#fff';
      g.fillText(`${score[0]} – ${score[1]}`, W / 2, y - 1);
      g.font = '600 10.5px "JetBrains Mono", monospace'; g.fillStyle = liveNow ? '#ff8a8a' : 'rgba(243,251,245,.6)';
      g.fillText(label, W / 2, y + 15);
    }

    // ---------------------------------------------------------------- the frame
    let trail = [];
    function frame() {
      requestAnimationFrame(frame);
      if (!W) return;
      if (Math.abs((root.clientWidth || W) - W) > 1) size();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const home = game?.home || info.next?.home || { name: 'Home' }, away = game?.away || info.next?.away || { name: 'Away' };
      const geo = drawGround(home, away);
      const t = clockT();
      // nothing to show yet: the next kick-off
      if (!game || t == null || !plays.length || t < plays[0].t) {
        drawBug([0, 0], game ? (game.status === 'scheduled' || (t != null && t < 0) ? 'KICK-OFF SOON' : 'LOADING') : 'NO GAME ON', home, away, false);
        ctx.fillStyle = 'rgba(4,16,10,.72)'; ctx.fillRect(0, geo.top + geo.fh / 2 - 24, W, 48);
        ctx.fillStyle = '#f3fbf5'; ctx.font = '600 15px Inter, sans-serif'; ctx.textAlign = 'center';
        const nx = info.next;
        ctx.fillText(game && mode === 'live' ? 'Kick-off! The first plays are on their way…' : nx ? `Next up: ${nx.home.name} v ${nx.away.name}, kick-off in ${inFor(nx.kickoff)}` : 'No game scheduled right now.', W / 2, geo.top + geo.fh / 2);
        status(t); return;
      }
      // the play on screen and the one before it
      let i = plays.length - 1; while (i > 0 && plays[i].t > t) i--;
      const cur = plays[i], prev = plays[Math.max(0, i - 1)];
      const sinceMs = mode === 'done' ? 1e9 : (realOf(t - cur.t) / (mode === 'replay' ? replaySpeed : 1));
      const k = reduce ? 1 : ease(Math.min(1, sinceMs / 700));
      const wob = (n) => (gridiron ? ((n * 37) % 21) - 10 : 0); // a little sideways movement on the gridiron
      const bx = prev.x + (cur.x - prev.x) * k, by = prev.y + wob(Math.max(0, i - 1)) + (cur.y + wob(i) - prev.y - wob(Math.max(0, i - 1))) * k;
      const X = geo.px(bx), Y = geo.py(by);
      if (!trail.length || Math.hypot(trail.at(-1)[0] - X, trail.at(-1)[1] - Y) > 2) { trail.push([X, Y]); if (trail.length > 14) trail.shift(); }
      const g = ctx;
      if (gridiron && cur.fd != null && !['td', 'xp', 'xpmiss', 'final', 'marker'].includes(cur.kind)) {
        g.strokeStyle = 'rgba(255,214,64,.95)'; g.lineWidth = 3; g.beginPath(); g.moveTo(geo.px(cur.fd), geo.top); g.lineTo(geo.px(cur.fd), geo.top + geo.fh); g.stroke();
        g.strokeStyle = 'rgba(90,170,255,.9)'; g.beginPath(); g.moveTo(geo.px(prev.x), geo.top); g.lineTo(geo.px(prev.x), geo.top + geo.fh); g.stroke();
      }
      for (let j = 1; j < trail.length; j++) { g.strokeStyle = `rgba(255,255,255,${(j / trail.length) * 0.35})`; g.lineWidth = 2; g.beginPath(); g.moveTo(trail[j - 1][0], trail[j - 1][1]); g.lineTo(trail[j][0], trail[j][1]); g.stroke(); }
      const owner = cur.side ? game[cur.side] : null;
      if (owner) { g.fillStyle = owner.col || '#fff'; g.globalAlpha = 0.35; g.beginPath(); g.arc(X, Y, 15, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
      if (gridiron) {
        g.save(); g.translate(X, Y); g.rotate(-0.5); g.fillStyle = '#7a3f1d'; g.beginPath(); g.ellipse(0, 0, 9, 5.5, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(-3.5, 0); g.lineTo(3.5, 0); g.stroke(); g.restore();
      } else {
        g.fillStyle = '#fff'; g.beginPath(); g.arc(X, Y, 6, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#1b1b1b'; g.lineWidth = 1.5; g.stroke();
      }
      // down & distance tag
      if (gridiron && cur.dd && cur.kind === 'play') {
        g.font = '600 11px "JetBrains Mono", monospace'; const tw = g.measureText(cur.dd).width + 12;
        g.fillStyle = 'rgba(4,16,10,.82)'; g.fillRect(Math.min(W - tw - 6, Math.max(6, X - tw / 2)), geo.top + geo.fh - 24, tw, 18);
        g.fillStyle = '#ffd640'; g.textAlign = 'center'; g.fillText(cur.dd, Math.min(W - tw / 2 - 6, Math.max(6 + tw / 2, X)), geo.top + geo.fh - 15);
      }
      // the big moment
      const big = [...plays.slice(0, i + 1)].reverse().find((p) => ['td', 'goal', 'fg', 'turnover', 'final'].includes(p.kind));
      if (big) {
        const age = mode === 'done' ? (big.kind === 'final' ? 0 : 1e9) : realOf(t - big.t) / (mode === 'replay' ? replaySpeed : 1);
        if (age < 2600 || (big.kind === 'final' && age < 1e8)) {
          const a = big.kind === 'final' ? 1 : Math.min(1, (2600 - age) / 500);
          const word = { td: 'TOUCHDOWN!', goal: 'GOAL!', fg: 'FIELD GOAL', turnover: 'TURNOVER!', final: gridiron ? 'FINAL' : 'FULL TIME' }[big.kind];
          const col = big.side ? game[big.side].col : '#ffb04a';
          g.globalAlpha = a; g.fillStyle = 'rgba(4,10,8,.7)'; g.fillRect(0, geo.top + geo.fh / 2 - 34, W, 68);
          g.fillStyle = col; g.fillRect(0, geo.top + geo.fh / 2 - 34, W, 4); g.fillRect(0, geo.top + geo.fh / 2 + 30, W, 4);
          g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = `800 ${Math.round(Math.min(34, W / 14))}px Inter, sans-serif`;
          g.fillText(word, W / 2, geo.top + geo.fh / 2 - 6);
          g.font = '600 13px Inter, sans-serif'; g.fillStyle = 'rgba(255,255,255,.85)';
          g.fillText(big.kind === 'final' ? `${home.name} ${cur.s[0]} – ${cur.s[1]} ${away.name}` : big.who ? `${big.who}, ${game[big.side].name}` : game[big.side]?.name || '', W / 2, geo.top + geo.fh / 2 + 17);
          g.globalAlpha = 1;
        }
      }
      drawBug(cur.s, mode === 'done' || cur.kind === 'final' ? (gridiron ? 'FINAL' : 'FULL TIME') : clockLabel(t), home, away, mode === 'live');
      if (i !== shownIdx) { shownIdx = i; feed(i); }
      if (mode === 'replay' && t > game.T + 0.5) { mode = 'done'; }
      status(t);
    }
    function feed(i) {
      const rows = plays.slice(Math.max(0, i - 7), i + 1).reverse();
      feedEl.innerHTML = rows.map((p, n) => {
        const bigK = ['td', 'goal', 'fg', 'turnover', 'final'].includes(p.kind);
        const col = p.side && game[p.side] ? game[p.side].col : '#ffb04a';
        return `<li class="${bigK ? 'big' : p.kind === 'marker' ? 'mk' : ''}${n === 0 ? ' new' : ''}" style="--c:${esc(col)}"><b>${esc(p.kind === 'final' ? 'END' : p.kind === 'marker' && !gridiron && p.t === 45 ? 'HT' : clockLabel(p.t))}</b><span>${esc(p.text)}</span></li>`;
      }).join('');
    }
    let lastStatus = '';
    function status(t) {
      const L = info.live, last = info.last;
      let s, act = '';
      const ground = gridiron ? 'Skyline Field' : 'Sunfall Arena';
      if (mode === 'live') s = `<span class="lv-live">LIVE</span> &nbsp;${esc(game.home.name)} v ${esc(game.away.name)} · ${ground}`;
      else if (mode === 'replay') { s = `Replay · ${esc(game.home.name)} v ${esc(game.away.name)}`; act = `<button data-lv="speed">${replaySpeed}× speed</button> <button data-lv="stop">Stop</button>`; }
      else if (mode === 'done' && game) s = `Final · ${esc(game.home.name)} v ${esc(game.away.name)}${info.next && !L ? ` · next kick-off in ${inFor(info.next.kickoff)}` : ''}`;
      else s = info.next ? `Next kick-off in ${inFor(info.next.kickoff)}` : 'No game on';
      if (L && mode !== 'live') act += ` <button data-lv="live">Watch live</button>`;
      else if (mode !== 'live' && mode !== 'replay' && last) act = `<button data-lv="replay">Replay the last game</button>`;
      const key = s + act;
      if (key !== lastStatus) { lastStatus = key; stEl.innerHTML = s; actEl.innerHTML = act; }
    }
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lv]'); if (!b) return;
      const a = b.dataset.lv;
      if (a === 'replay' && info.last) start(info.last, 'replay');
      else if (a === 'live' && info.live) start(info.live, 'live');
      else if (a === 'stop') mode = 'done';
      else if (a === 'speed') { const t = clockT(); replaySpeed = replaySpeed === 1 ? 2 : replaySpeed === 2 ? 4 : 1; replayAt = performance.now() - (realOf(t) / replaySpeed); }
      trail = []; lastStatus = '';
    });
    function inFor(ts) {
      const s = Math.max(0, Math.round((ts - (Date.now() + skew)) / 1000)); if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60); return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
    }
    requestAnimationFrame(frame);

    return {
      // called by the page each time it loads the fixtures
      update({ live, last, next, skew: sk }) {
        if (typeof sk === 'number' && !game) skew = sk;
        info = { live, last, next };
        if (live && mode !== 'replay' && (mode !== 'live' || game?.id !== live.id)) { trail = []; start(live, 'live'); return; }
        if (!live && mode === 'live' && game && game.status !== 'live') {
          // the game has finished: let the last plays run out, then hold the final score
          const t = clockT(); if (t != null && game.T != null && t > game.T + 0.3) mode = 'done';
        }
        if (!live && mode === 'live' && game && game.status === 'live') pull();
        if (mode === 'idle' && !game && last) { /* show the latest result until something kicks off */ start(last, 'replay'); replayAt = performance.now() - 1e9; }
      },
    };
  };
})();
