// Wingbeat — the reference mini app.
//
// What it shows a developer:
//   1. Batiyao.ready() once the first screen is drawn.
//   2. Batiyao.storage for anything that must survive a restart (a mini app
//      has no localStorage: it runs with no origin of its own).
//   3. Batiyao.pay() from a tap, with a product from manifest.json. Batiyao
//      draws the payment sheet; this code only names the product.
//   4. Purchases as the record: on start, getPurchases(), credit any
//      consumable not yet credited, save that, THEN consume — so a crash in
//      between can't lose or double a purchase.
'use strict';

(function () {
  var W = 360, H = 640;
  var GRAVITY = 1500, FLAP = -430, SPEED = 150, GAP = 165, PIPE_W = 64, SPACING = 210;

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    mode: 'start', // start | playing | over
    bird: { y: H / 2, vy: 0 },
    pipes: [],
    score: 0,
    best: 0,
    feathers: 0,
    credited: [], // purchase ids already turned into feathers
    night: false,
    t: 0
  };

  // ---------------------------------------------------------- persistence --

  function save() {
    return Promise.all([
      Batiyao.storage.set('best', String(state.best)),
      Batiyao.storage.set('feathers', String(state.feathers)),
      Batiyao.storage.set('credited', JSON.stringify(state.credited.slice(-200)))
    ]).catch(function () { /* saving is best-effort while playing */ });
  }

  function load() {
    return Promise.all([
      Batiyao.storage.get('best'),
      Batiyao.storage.get('feathers'),
      Batiyao.storage.get('credited')
    ]).then(function (v) {
      state.best = parseInt(v[0] || '0', 10) || 0;
      state.feathers = parseInt(v[1] || '0', 10) || 0;
      try { state.credited = JSON.parse(v[2] || '[]'); } catch (e) { state.credited = []; }
    });
  }

  // The purchase record is Batiyao's, not ours: restore from it every start.
  function syncPurchases() {
    return Batiyao.getPurchases().then(function (r) {
      var toConsume = [];
      (r.purchases || []).forEach(function (p) {
        if (p.product === 'night_sky') state.night = true;
        if (p.product === 'golden_feathers' && !p.consumed_at) {
          if (state.credited.indexOf(p.id) < 0) {
            state.feathers += 3;
            state.credited.push(p.id);
          }
          toConsume.push(p.id);
        }
      });
      applyTheme();
      return save().then(function () {
        return Promise.all(toConsume.map(function (id) {
          return Batiyao.consume(id).catch(function () {});
        }));
      });
    });
  }

  function applyTheme() {
    document.body.classList.toggle('night', state.night);
    $('buy-night').hidden = state.night;
  }

  // ------------------------------------------------------------- payments --

  function buy(product, button) {
    button.disabled = true;
    say('');
    // Called from the click: on the web, Batiyao refuses a payment request
    // that doesn't come from a tap.
    Batiyao.pay({ product: product }).then(function (r) {
      if (r.status === 'paid') {
        return syncPurchases().then(function () { say('Thanks!'); render(); updatePanels(); });
      }
      if (r.status === 'pending') {
        say('Batiyao is still confirming the payment. It will show up shortly.');
      } else if (r.status === 'failed' && r.reason === 'insufficient_balance') {
        say('Not enough BuckBuck.');
      } else if (r.status === 'failed') {
        say('The payment didn’t go through.');
      }
    }).catch(function (e) {
      say(e.message || 'Couldn’t reach Batiyao.');
    }).then(function () { button.disabled = false; });
  }

  function say(text) { $('message').textContent = text; }

  // ---------------------------------------------------------------- share --

  // A score card the person may post or put in their story. Batiyao shows
  // its own sheet and the person decides; the game is never told whether
  // they shared, and gives nothing for it (Batiyao's rules forbid rewarding
  // or requiring a share).
  function shareScore() {
    var card = document.createElement('canvas');
    card.width = 720;
    card.height = 1280;
    var c = card.getContext('2d');
    var g = c.createLinearGradient(0, 0, 0, card.height);
    g.addColorStop(0, state.night ? '#0b1640' : '#7dd3fc');
    g.addColorStop(1, state.night ? '#312e81' : '#e0f2fe');
    c.fillStyle = g;
    c.fillRect(0, 0, card.width, card.height);
    c.fillStyle = state.night ? '#f8fafc' : '#0f172a';
    c.textAlign = 'center';
    c.font = 'bold 72px system-ui, sans-serif';
    c.fillText('Wingbeat', 360, 300);
    c.font = 'bold 220px system-ui, sans-serif';
    c.fillText(String(state.score), 360, 660);
    c.font = '48px system-ui, sans-serif';
    c.fillText(state.score === 1 ? 'gap' : 'gaps', 360, 740);
    c.fillText('Best: ' + state.best, 360, 860);
    Batiyao.share({
      image: card,
      text: 'I flew through ' + state.score + (state.score === 1 ? ' gap' : ' gaps') + ' in Wingbeat. Can you beat it?'
    }).catch(function (e) { console.warn('share', e.code); });
  }

  // ---------------------------------------------------------------- game --

  function reset() {
    state.bird = { y: H / 2, vy: 0 };
    state.pipes = [];
    state.score = 0;
    state.t = 0;
    for (var i = 0; i < 3; i++) addPipe(W + 120 + i * SPACING);
  }

  function addPipe(x) {
    var top = 90 + Math.random() * (H - GAP - 220);
    state.pipes.push({ x: x, top: top, passed: false });
  }

  function flap() {
    if (state.mode === 'playing') state.bird.vy = FLAP;
  }

  function start() {
    reset();
    state.mode = 'playing';
    updatePanels();
    flap();
  }

  function crash() {
    state.mode = 'over';
    if (state.score > state.best) state.best = state.score;
    save();
    updatePanels();
  }

  function keepFlying() {
    if (state.feathers <= 0) return;
    state.feathers -= 1;
    save();
    // Clear the pipe we hit and carry on with the same score.
    state.pipes = state.pipes.filter(function (p) { return p.x > W / 3 + PIPE_W; });
    if (state.pipes.length === 0) addPipe(W + 60);
    state.bird = { y: H / 2, vy: FLAP };
    state.mode = 'playing';
    updatePanels();
  }

  function step(dt) {
    if (state.mode !== 'playing') return;
    state.t += dt;
    var b = state.bird;
    b.vy += GRAVITY * dt;
    b.y += b.vy * dt;
    var bx = W / 3, r = 15;
    for (var i = 0; i < state.pipes.length; i++) {
      var p = state.pipes[i];
      p.x -= SPEED * dt;
      if (!p.passed && p.x + PIPE_W < bx - r) {
        p.passed = true;
        state.score += 1;
      }
      var inX = bx + r > p.x && bx - r < p.x + PIPE_W;
      if (inX && (b.y - r < p.top || b.y + r > p.top + GAP)) { crash(); return; }
    }
    if (state.pipes.length && state.pipes[0].x < -PIPE_W) {
      state.pipes.shift();
      addPipe(state.pipes[state.pipes.length - 1].x + SPACING);
    }
    if (b.y + r > H - 40 || b.y - r < 0) crash();
  }

  function render() {
    var night = state.night;
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, night ? '#0b1030' : '#5fb3e8');
    g.addColorStop(1, night ? '#27306b' : '#bfe6ff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (night) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      for (var s = 0; s < 40; s++) ctx.fillRect((s * 97) % W, (s * 53) % (H - 200), 2, 2);
      ctx.beginPath();
      ctx.arc(290, 90, 26, 0, Math.PI * 2);
      ctx.fillStyle = '#f4f1d0';
      ctx.fill();
    }
    ctx.fillStyle = night ? '#2f8f5b' : '#34a853';
    state.pipes.forEach(function (p) {
      ctx.fillRect(p.x, 0, PIPE_W, p.top);
      ctx.fillRect(p.x, p.top + GAP, PIPE_W, H - p.top - GAP - 40);
      ctx.fillStyle = night ? '#256f47' : '#2b8a45';
      ctx.fillRect(p.x - 4, p.top - 18, PIPE_W + 8, 18);
      ctx.fillRect(p.x - 4, p.top + GAP, PIPE_W + 8, 18);
      ctx.fillStyle = night ? '#2f8f5b' : '#34a853';
    });
    ctx.fillStyle = night ? '#3a2f22' : '#d9b36c';
    ctx.fillRect(0, H - 40, W, 40);
    // the bird
    var b = state.bird, bx = W / 3;
    var tilt = Math.max(-0.5, Math.min(0.9, b.vy / 600));
    ctx.save();
    ctx.translate(bx, b.y);
    ctx.rotate(tilt);
    ctx.fillStyle = '#ffc425';
    ctx.beginPath(); ctx.ellipse(0, 0, 18, 14, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffe178';
    var wing = Math.sin(state.t * 30) * 5;
    ctx.beginPath(); ctx.ellipse(-4, 2 + wing, 9, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(8, -5, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(9.5, -5, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f06428';
    ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(26, 3); ctx.lineTo(16, 6); ctx.fill();
    ctx.restore();
    $('score').textContent = state.score;
    $('feathers').textContent = '🪶 ' + state.feathers;
  }

  function updatePanels() {
    $('start').hidden = state.mode !== 'start';
    $('over').hidden = state.mode !== 'over';
    $('final').textContent = state.score;
    $('best').textContent = state.best;
    $('best-start').textContent = state.best;
    $('continue').hidden = !(state.mode === 'over' && state.feathers > 0);
  }

  var last = 0;
  function frame(ts) {
    var dt = Math.min(0.033, (ts - last) / 1000 || 0);
    last = ts;
    step(dt);
    render();
    requestAnimationFrame(frame);
  }

  // --------------------------------------------------------------- input --

  canvas.addEventListener('pointerdown', function (e) { e.preventDefault(); flap(); });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); flap(); }
  });
  $('play').addEventListener('click', start);
  $('again').addEventListener('click', start);
  $('continue').addEventListener('click', keepFlying);
  $('buy-feathers').addEventListener('click', function (e) { buy('golden_feathers', e.currentTarget); });
  $('buy-night').addEventListener('click', function (e) { buy('night_sky', e.currentTarget); });
  $('share').addEventListener('click', shareScore);

  Batiyao.on('theme', function () { /* Wingbeat keeps its own sky */ });

  // ---------------------------------------------------------------- boot --

  reset();
  render();
  updatePanels();
  requestAnimationFrame(frame);
  load()
    .then(syncPurchases)
    .catch(function () { /* still playable without saved data */ })
    .then(function () { updatePanels(); return Batiyao.ready(); })
    .catch(function () {});
})();
