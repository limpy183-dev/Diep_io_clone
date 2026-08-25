// modelab.js — the Mode Lab button and its menu.
//
// Self-contained on purpose: markup, styles and behaviour all live here, so
// index.html gains one script tag and main.js gains one line. Nothing in the
// base menu changes.
//
// Three pieces:
//   1. the button, which is deliberately not a diep button — an obsidian slab
//      with a rotating spectrum halo and a canvas of polygons that bloom out
//      of it on hover;
//   2. the wall, 38 live-rendered tiles (MODE_THUMB does the drawing) with
//      family filters;
//   3. the detail view, which the tile FLIPs into — measure, promote to fixed,
//      transition to the target box — with the write-up sliding in beside it.
//
// Only tiles actually on screen are drawn, and the whole loop stops when the
// menu is closed, so an idle main menu costs nothing.

var MODELAB = (function () {
  var root = null, wall = null, grid = null, detail = null, tiles = [], raf = 0;
  var open = false, current = null, filter = 'All';
  var api = { onPlay: null, onPlayOnline: null };

  // --- styles ------------------------------------------------------------
  var CSS = [
    // ---- the button ----
    '#lab-launch{position:relative;display:block;margin:16px auto 0;width:290px;padding:0;border:0;',
    '  background:none;cursor:pointer;-webkit-tap-highlight-color:transparent;}',
    '#lab-launch .lab-aura{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
    '  width:430px;height:210px;pointer-events:none;}',
    '#lab-launch .lab-slab{position:relative;display:flex;flex-direction:column;align-items:center;',
    '  justify-content:center;gap:2px;height:66px;border-radius:16px;',
    '  background:linear-gradient(155deg,#191C24 0%,#0E1016 55%,#15121F 100%);',
    '  box-shadow:0 10px 26px -8px rgba(0,0,0,.75),inset 0 1px 0 rgba(255,255,255,.09);',
    '  overflow:hidden;transition:transform .32s cubic-bezier(.2,.9,.25,1.2);}',
    '#lab-launch:hover .lab-slab,#lab-launch:focus-visible .lab-slab{transform:translateY(-3px) scale(1.035);}',
    '#lab-launch:active .lab-slab{transform:translateY(0) scale(.99);}',
    // rotating spectrum ring, sitting just outside the slab
    '#lab-launch .lab-ring{position:absolute;inset:-2px;border-radius:18px;padding:2px;z-index:0;',
    '  background:conic-gradient(from 0deg,#00B2E1,#00E16E,#FFDE43,#F14E54,#BF7FF5,#00B2E1);',
    '  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);',
    '  -webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);',
    '  mask-composite:exclude;animation:labspin 5.5s linear infinite;opacity:.85;}',
    '#lab-launch:hover .lab-ring{opacity:1;animation-duration:2.4s;}',
    '@keyframes labspin{to{transform:rotate(1turn);}}',
    // the sheen that sweeps across on hover
    '#lab-launch .lab-slab::after{content:"";position:absolute;inset:0;',
    '  background:linear-gradient(105deg,transparent 38%,rgba(255,255,255,.16) 50%,transparent 62%);',
    '  transform:translateX(-130%);transition:transform .75s cubic-bezier(.3,.7,.3,1);}',
    '#lab-launch:hover .lab-slab::after{transform:translateX(130%);}',
    '#lab-launch .lab-title{font:700 20px Ubuntu,Verdana,sans-serif;letter-spacing:.16em;',
    '  background:linear-gradient(92deg,#7FE9FF,#B7FFD4 30%,#FFE9A0 62%,#FFB3C8);',
    '  -webkit-background-clip:text;background-clip:text;color:transparent;',
    '  filter:drop-shadow(0 0 12px rgba(120,220,255,.35));position:relative;z-index:1;}',
    '#lab-launch .lab-sub{font:500 11px Ubuntu,Verdana,sans-serif;letter-spacing:.1em;',
    '  color:rgba(210,222,240,.62);position:relative;z-index:1;text-transform:uppercase;}',
    '#lab-launch:hover .lab-sub{color:rgba(232,242,255,.9);}',

    // ---- the overlay ----
    '#lab{position:fixed;inset:0;z-index:60;display:none;opacity:0;',
    '  background:radial-gradient(120% 90% at 50% 0%,#1B2030 0%,#0B0D14 55%,#07080D 100%);',
    '  transition:opacity .3s ease;overflow:hidden;}',
    '#lab.on{display:block;opacity:1;}',
    '#lab .lab-bg{position:absolute;inset:0;pointer-events:none;}',
    '#lab .lab-inner{position:relative;height:100%;display:flex;flex-direction:column;}',
    '#lab .lab-head{flex:none;padding:26px 40px 14px;display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap;}',
    '#lab h2{margin:0;font:700 38px Ubuntu,Verdana,sans-serif;letter-spacing:.06em;',
    '  background:linear-gradient(92deg,#7FE9FF,#B7FFD4 34%,#FFE9A0 66%,#FFB3C8);',
    '  -webkit-background-clip:text;background-clip:text;color:transparent;}',
    '#lab .lab-blurb{color:#8FA0B8;font:400 14px Ubuntu,Verdana,sans-serif;margin:0 0 6px;max-width:52ch;}',
    '#lab .lab-close{margin-left:auto;background:rgba(255,255,255,.07);border:0;color:#CBD6E6;',
    '  font:700 13px Ubuntu,Verdana,sans-serif;letter-spacing:.12em;padding:11px 20px;border-radius:10px;',
    '  cursor:pointer;transition:background .2s,color .2s;}',
    '#lab .lab-close:hover{background:rgba(255,255,255,.15);color:#FFF;}',
    '#lab .lab-chips{flex:none;padding:0 40px 14px;display:flex;gap:8px;flex-wrap:wrap;}',
    '#lab .lab-chip{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);',
    '  color:#93A3BA;font:500 12px Ubuntu,Verdana,sans-serif;letter-spacing:.08em;text-transform:uppercase;',
    '  padding:7px 14px;border-radius:999px;cursor:pointer;transition:all .2s;}',
    '#lab .lab-chip:hover{color:#E6EEFA;border-color:rgba(255,255,255,.22);}',
    '#lab .lab-chip.on{background:linear-gradient(92deg,#00B2E1,#BF7FF5);color:#08090E;border-color:transparent;font-weight:700;}',
    '#lab .lab-grid{flex:1;overflow-y:auto;overflow-x:hidden;padding:4px 40px 48px;',
    '  display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:18px;align-content:start;}',
    '#lab .lab-grid::-webkit-scrollbar{width:10px;}',
    '#lab .lab-grid::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:6px;}',

    // ---- a tile ----
    '.lab-tile{position:relative;aspect-ratio:1/1;border-radius:14px;overflow:hidden;cursor:pointer;',
    '  background:#12151D;border:1px solid rgba(255,255,255,.07);',
    '  transition:transform .28s cubic-bezier(.2,.9,.25,1.15),box-shadow .28s,border-color .28s,opacity .25s;}',
    '.lab-tile:hover{transform:translateY(-5px) scale(1.025);border-color:rgba(255,255,255,.28);',
    '  box-shadow:0 18px 38px -14px rgba(0,0,0,.9),0 0 0 1px rgba(120,200,255,.25);z-index:2;}',
    '.lab-tile.hidden{display:none;}',
    '.lab-tile.ghost{opacity:0;pointer-events:none;}',
    '.lab-tile canvas{position:absolute;inset:0;width:100%;height:66%;object-fit:cover;}',
    '.lab-tile .lab-cap{position:absolute;left:0;right:0;bottom:0;height:38%;padding:12px 14px;',
    '  background:linear-gradient(to top,#12151D 62%,rgba(18,21,29,.86) 84%,rgba(18,21,29,0));',
    '  display:flex;flex-direction:column;justify-content:flex-end;gap:3px;}',
    '.lab-tile .lab-name{font:700 16px Ubuntu,Verdana,sans-serif;color:#F0F5FC;line-height:1.1;}',
    '.lab-tile .lab-tag{font:500 10.5px Ubuntu,Verdana,sans-serif;letter-spacing:.11em;text-transform:uppercase;color:#6FA8C8;}',
    '.lab-tile .lab-fam{position:absolute;top:10px;left:10px;font:700 9.5px Ubuntu,Verdana,sans-serif;',
    '  letter-spacing:.13em;text-transform:uppercase;color:#0A0C12;background:rgba(255,255,255,.72);',
    '  padding:4px 8px;border-radius:5px;}',

    // ---- detail ----
    '#lab-detail{position:fixed;inset:0;z-index:61;display:none;pointer-events:none;}',
    '#lab-detail.on{display:block;pointer-events:auto;}',
    '#lab-detail .lab-scrim{position:absolute;inset:0;background:rgba(5,6,11,.82);opacity:0;transition:opacity .34s ease;}',
    '#lab-detail.shown .lab-scrim{opacity:1;}',
    '#lab-stage{position:fixed;border-radius:14px;overflow:hidden;background:#12151D;',
    '  box-shadow:0 30px 80px -20px rgba(0,0,0,.95);',
    '  transition:left .46s cubic-bezier(.22,.85,.24,1),top .46s cubic-bezier(.22,.85,.24,1),',
    '  width .46s cubic-bezier(.22,.85,.24,1),height .46s cubic-bezier(.22,.85,.24,1),border-radius .46s;}',
    '#lab-stage canvas{position:absolute;inset:0;width:100%;height:100%;}',
    '#lab-stage .lab-stagecap{position:absolute;left:0;right:0;bottom:0;padding:26px 30px;',
    '  background:linear-gradient(to top,rgba(8,10,15,.94),rgba(8,10,15,0));opacity:0;transition:opacity .3s .2s;}',
    '#lab-detail.shown #lab-stage .lab-stagecap{opacity:1;}',
    '#lab-stage .lab-stagename{font:700 34px Ubuntu,Verdana,sans-serif;color:#FFF;letter-spacing:.02em;}',
    '#lab-panel{position:fixed;top:0;right:0;bottom:0;width:min(460px,42vw);',
    '  background:linear-gradient(180deg,#141824 0%,#0C0E15 100%);border-left:1px solid rgba(255,255,255,.07);',
    '  padding:38px 34px;overflow-y:auto;transform:translateX(102%);transition:transform .46s cubic-bezier(.22,.85,.24,1);}',
    '#lab-detail.shown #lab-panel{transform:translateX(0);}',
    '#lab-panel .lab-fam2{font:700 11px Ubuntu,Verdana,sans-serif;letter-spacing:.18em;text-transform:uppercase;',
    '  color:#00B2E1;margin-bottom:8px;}',
    '#lab-panel h3{margin:0 0 4px;font:700 30px Ubuntu,Verdana,sans-serif;color:#F2F6FC;letter-spacing:.01em;}',
    '#lab-panel .lab-tag2{font:500 11px Ubuntu,Verdana,sans-serif;letter-spacing:.14em;text-transform:uppercase;',
    '  color:#7C8DA6;margin-bottom:20px;}',
    '#lab-panel .lab-lede{font:400 15.5px Ubuntu,Verdana,sans-serif;color:#C6D3E4;line-height:1.62;margin:0 0 26px;}',
    '#lab-panel .lab-h{font:700 11px Ubuntu,Verdana,sans-serif;letter-spacing:.18em;text-transform:uppercase;',
    '  color:#6D7E96;margin:0 0 12px;}',
    '#lab-panel ol{margin:0 0 30px;padding:0;list-style:none;counter-reset:lab;}',
    '#lab-panel ol li{counter-increment:lab;position:relative;padding-left:30px;margin-bottom:13px;',
    '  font:400 14.5px Ubuntu,Verdana,sans-serif;color:#A9B8CC;line-height:1.6;}',
    '#lab-panel ol li::before{content:counter(lab);position:absolute;left:0;top:1px;width:20px;height:20px;',
    '  border-radius:6px;background:rgba(0,178,225,.14);color:#4FC7EE;font:700 11px Ubuntu,sans-serif;',
    '  display:flex;align-items:center;justify-content:center;}',
    '#lab-panel .lab-acts{display:flex;gap:10px;flex-wrap:wrap;position:sticky;bottom:-38px;',
    '  padding:14px 0 0;background:linear-gradient(to top,#0C0E15 72%,rgba(12,14,21,0));}',
    '#lab-panel button{flex:1 1 140px;border:0;border-radius:11px;padding:15px 18px;cursor:pointer;',
    '  font:700 15px Ubuntu,Verdana,sans-serif;letter-spacing:.04em;transition:filter .18s,transform .18s;}',
    '#lab-panel button:hover{filter:brightness(1.12);transform:translateY(-2px);}',
    '#lab-panel .lab-go{background:linear-gradient(92deg,#00E16E,#00B2E1);color:#05210F;}',
    '#lab-panel .lab-goon{background:rgba(255,255,255,.08);color:#D4DFEE;}',
    '#lab-panel .lab-back{flex:1 1 100%;background:none;color:#65758C;font-weight:500;padding:10px;}',
    '@media (max-width:820px){',
    '  #lab-panel{width:100%;top:auto;height:56vh;border-left:0;border-top:1px solid rgba(255,255,255,.09);',
    '    transform:translateY(102%);}',
    '  #lab-detail.shown #lab-panel{transform:translateY(0);}',
    '  #lab .lab-head,#lab .lab-chips,#lab .lab-grid{padding-left:18px;padding-right:18px;}',
    '}',
    '@media (prefers-reduced-motion:reduce){',
    '  #lab-launch .lab-ring{animation:none;}',
    '  .lab-tile,#lab-stage,#lab-panel,#lab-detail .lab-scrim{transition-duration:.01ms;}',
    '}'
  ].join('\n');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // --- the button's polygon aura ----------------------------------------
  // Idle it breathes; hovered it blooms. `heat` chases the target so the two
  // states are one continuous animation rather than a swap.
  function auraCanvas(btn) {
    var cv = el('canvas', 'lab-aura');
    var c = cv.getContext('2d');
    var bits = [], heat = 0, want = 0, last = 0, alive = true;
    var W = 430, H = 210;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    c.scale(dpr, dpr);
    var PAL = [['#00B2E1', '#0085A8'], ['#00E16E', '#00A852'], ['#FFE869', '#BFAE4E'],
      ['#F14E54', '#B43A3F'], ['#BF7FF5', '#8F5FB7'], ['#768DFC', '#5869BD']];

    function spawn() {
      var edge = Math.random() * Math.PI * 2;
      var p = PAL[(Math.random() * PAL.length) | 0];
      bits.push({
        x: W / 2 + Math.cos(edge) * 92, y: H / 2 + Math.sin(edge) * 26,
        vx: Math.cos(edge) * (0.28 + Math.random() * 0.7),
        vy: Math.sin(edge) * (0.16 + Math.random() * 0.4) - 0.12,
        r: 4 + Math.random() * 9, sides: 3 + ((Math.random() * 4) | 0),
        rot: Math.random() * 6.3, spin: (Math.random() - 0.5) * 0.07,
        life: 0, max: 90 + Math.random() * 90, fill: p[0], stroke: p[1]
      });
    }

    function frame(now) {
      if (!alive) return;
      requestAnimationFrame(frame);
      var dt = last ? Math.min(60, now - last) : 16; last = now;
      var step = dt / 16.7;
      heat += (want - heat) * (1 - Math.exp(-dt * 0.006));
      c.clearRect(0, 0, W, H);
      // spawn rate scales with heat, with a slow trickle even at rest
      if (Math.random() < (0.045 + heat * 0.5) * step) spawn();
      // a soft bed of light under the slab, only when warm
      if (heat > 0.02) {
        var gr = c.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, 165);
        gr.addColorStop(0, 'rgba(120,200,255,' + (0.13 * heat) + ')');
        gr.addColorStop(1, 'rgba(120,200,255,0)');
        c.fillStyle = gr; c.fillRect(0, 0, W, H);
      }
      for (var i = bits.length - 1; i >= 0; i--) {
        var b = bits[i];
        b.life += step;
        if (b.life > b.max) { bits.splice(i, 1); continue; }
        var f = b.life / b.max;
        var push = 0.35 + heat * 1.5;
        b.x += b.vx * push * step; b.y += b.vy * push * step;
        b.vy += 0.006 * step;                       // a touch of drift downward
        b.rot += b.spin * step * (0.5 + heat);
        c.save();
        c.globalAlpha = (0.16 + heat * 0.72) * Math.sin(f * Math.PI);
        c.translate(b.x, b.y); c.rotate(b.rot);
        c.beginPath();
        for (var s = 0; s < b.sides; s++) {
          var a = Math.PI * 2 * (s / b.sides);
          var px = Math.cos(a) * b.r, py = Math.sin(a) * b.r;
          if (s) c.lineTo(px, py); else c.moveTo(px, py);
        }
        c.closePath();
        c.fillStyle = b.fill; c.fill();
        c.strokeStyle = b.stroke; c.lineWidth = Math.max(1, b.r * 0.22); c.stroke();
        c.restore();
      }
    }
    requestAnimationFrame(frame);
    btn.addEventListener('mouseenter', function () { want = 1; });
    btn.addEventListener('mouseleave', function () { want = 0; });
    btn.addEventListener('focus', function () { want = 1; });
    btn.addEventListener('blur', function () { want = 0; });
    // a burst on click, so the press has weight
    btn.addEventListener('click', function () { for (var i = 0; i < 26; i++) spawn(); });
    cv.stop = function () { alive = false; };
    return cv;
  }

  // --- drifting polygons behind the wall --------------------------------
  function bgCanvas() {
    var cv = el('canvas', 'lab-bg');
    var c = cv.getContext('2d');
    var bits = [], last = 0;
    function size() {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = window.innerWidth * dpr; cv.height = window.innerHeight * dpr;
      cv.style.width = window.innerWidth + 'px'; cv.style.height = window.innerHeight + 'px';
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size();
    window.addEventListener('resize', size);
    for (var i = 0; i < 34; i++) bits.push({
      x: Math.random(), y: Math.random(), r: 12 + Math.random() * 46,
      sides: 3 + ((Math.random() * 4) | 0), rot: Math.random() * 6.3,
      spin: (Math.random() - 0.5) * 0.006, vy: -0.06 - Math.random() * 0.14,
      a: 0.03 + Math.random() * 0.05
    });
    cv.frame = function (now) {
      var w = window.innerWidth, h = window.innerHeight;
      var dt = last ? Math.min(60, now - last) : 16; last = now;
      var step = dt / 16.7;
      c.clearRect(0, 0, w, h);
      for (var i = 0; i < bits.length; i++) {
        var b = bits[i];
        b.y += b.vy * step / h * 60; b.rot += b.spin * step;
        if (b.y < -0.15) { b.y = 1.15; b.x = Math.random(); }
        c.save();
        c.globalAlpha = b.a;
        c.translate(b.x * w, b.y * h); c.rotate(b.rot);
        c.beginPath();
        for (var s = 0; s < b.sides; s++) {
          var a = Math.PI * 2 * (s / b.sides);
          if (s) c.lineTo(Math.cos(a) * b.r, Math.sin(a) * b.r); else c.moveTo(Math.cos(a) * b.r, Math.sin(a) * b.r);
        }
        c.closePath();
        c.strokeStyle = '#9FD8FF'; c.lineWidth = 2; c.stroke();
        c.restore();
      }
    };
    return cv;
  }

  // --- build -------------------------------------------------------------
  function build() {
    if (root) return;
    var style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // the button
    var btn = el('button', '');
    btn.id = 'lab-launch';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open the Mode Lab');
    btn.appendChild(auraCanvas(btn));
    var slab = el('div', 'lab-slab');
    slab.appendChild(el('div', 'lab-ring'));
    slab.appendChild(el('div', 'lab-title', 'MODE LAB'));
    var n = Object.keys(LAB_MODES).length;
    slab.appendChild(el('div', 'lab-sub', n + ' experimental gamemodes'));
    btn.appendChild(slab);
    btn.addEventListener('click', show);
    var anchor = document.getElementById('diffline');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    else document.getElementById('menu').appendChild(btn);

    // the overlay
    root = el('div'); root.id = 'lab';
    var bg = bgCanvas();
    root.appendChild(bg);
    root.bgCanvas = bg;
    var inner = el('div', 'lab-inner');

    var head = el('div', 'lab-head');
    var titleBox = el('div');
    titleBox.appendChild(el('h2', '', 'MODE LAB'));
    titleBox.appendChild(el('p', 'lab-blurb',
      n + ' gamemodes that are not in diep.io. Pick one to read how it works, then play it offline against bots or online against people.'));
    head.appendChild(titleBox);
    var close = el('button', 'lab-close', 'CLOSE');
    close.addEventListener('click', hide);
    head.appendChild(close);
    inner.appendChild(head);

    // family filters, in the order the families were declared
    var fams = ['All'];
    Object.keys(LAB_MODES).forEach(function (k) {
      var f = LAB_MODES[k].family || 'Other';
      if (fams.indexOf(f) === -1) fams.push(f);
    });
    var chips = el('div', 'lab-chips');
    fams.forEach(function (f) {
      var chip = el('button', 'lab-chip' + (f === 'All' ? ' on' : ''), f);
      chip.addEventListener('click', function () {
        filter = f;
        chips.querySelectorAll('.lab-chip').forEach(function (x) { x.classList.remove('on'); });
        chip.classList.add('on');
        applyFilter();
      });
      chips.appendChild(chip);
    });
    inner.appendChild(chips);

    grid = el('div', 'lab-grid');
    Object.keys(LAB_MODES).forEach(function (key) { grid.appendChild(makeTile(key)); });
    inner.appendChild(grid);
    root.appendChild(inner);
    document.body.appendChild(root);

    // the detail layer
    detail = el('div'); detail.id = 'lab-detail';
    detail.appendChild(el('div', 'lab-scrim')).addEventListener('click', closeDetail);
    var stage = el('div'); stage.id = 'lab-stage';
    var scv = el('canvas');
    stage.appendChild(scv);
    var scap = el('div', 'lab-stagecap');
    scap.appendChild(el('div', 'lab-stagename'));
    stage.appendChild(scap);
    detail.appendChild(stage);
    var panel = el('div'); panel.id = 'lab-panel';
    detail.appendChild(panel);
    document.body.appendChild(detail);
    detail.stage = stage; detail.canvas = scv; detail.panel = panel;

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !open) return;
      if (current) closeDetail(); else hide();
      e.stopPropagation();
    }, true);
  }

  function makeTile(key) {
    var m = LAB_MODES[key];
    var t = el('div', 'lab-tile');
    t.dataset.key = key;
    t.dataset.family = m.family || 'Other';
    var cv = el('canvas');
    cv.width = 300; cv.height = 190;
    t.appendChild(cv);
    t.appendChild(el('div', 'lab-fam', m.family || ''));
    var cap = el('div', 'lab-cap');
    cap.appendChild(el('div', 'lab-name', m.name));
    cap.appendChild(el('div', 'lab-tag', m.tag || m.family || ''));
    t.appendChild(cap);
    t.addEventListener('click', function () { openDetail(key, t); });
    tiles.push({ key: key, el: t, cv: cv, c: cv.getContext('2d') });
    return t;
  }

  function applyFilter() {
    for (var i = 0; i < tiles.length; i++) {
      var show = filter === 'All' || tiles[i].el.dataset.family === filter;
      tiles[i].el.classList.toggle('hidden', !show);
    }
  }

  // --- the draw loop -----------------------------------------------------
  // Only tiles inside the scroller are drawn. With the menu shut the loop is
  // cancelled outright, so the main menu's own backdrop game keeps its frames.
  function loop(now) {
    if (!open) { raf = 0; return; }
    raf = requestAnimationFrame(loop);
    var t = now / 1000;
    if (root.bgCanvas && root.bgCanvas.frame) root.bgCanvas.frame(now);
    var gr = grid.getBoundingClientRect();
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      if (tile.el.classList.contains('hidden')) continue;
      var r = tile.el.getBoundingClientRect();
      if (r.bottom < gr.top - 120 || r.top > gr.bottom + 120) continue;
      var fn = MODE_THUMB[tile.key];
      if (!fn) continue;
      tile.c.setTransform(1, 0, 0, 1, 0, 0);
      try { fn(tile.c, tile.cv.width, tile.cv.height, t + i * 0.7); } catch (e) { /* one bad tile is not the wall */ }
    }
    if (current && detail.canvas) {
      var dc = detail.canvas, ctx = dc.getContext('2d');
      var box = detail.stage.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var w = Math.max(2, Math.round(box.width * dpr)), h = Math.max(2, Math.round(box.height * dpr));
      if (dc.width !== w || dc.height !== h) { dc.width = w; dc.height = h; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var fn2 = MODE_THUMB[current];
      if (fn2) try { fn2(ctx, box.width, box.height, t); } catch (e) { /* ignore */ }
    }
  }

  // --- show / hide -------------------------------------------------------
  function show() {
    build();
    open = true;
    root.classList.add('on');
    applyFilter();
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function hide() {
    if (current) closeDetail(true);
    open = false;
    if (root) root.classList.remove('on');
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  // --- detail: the FLIP --------------------------------------------------
  // Measure where the tile is, drop a fixed-position stage exactly on top of
  // it, then let a transition carry it to the target box. The tile itself goes
  // transparent for the duration so nothing doubles up.
  function targetBox() {
    var panelW = window.innerWidth <= 820 ? 0 : Math.min(460, window.innerWidth * 0.42);
    var panelH = window.innerWidth <= 820 ? window.innerHeight * 0.56 : 0;
    var pad = window.innerWidth <= 820 ? 14 : 34;
    return {
      left: pad, top: pad,
      width: Math.max(120, window.innerWidth - panelW - pad * 2),
      height: Math.max(120, window.innerHeight - panelH - pad * 2)
    };
  }

  function openDetail(key, tile) {
    var m = LAB_MODES[key];
    current = key;
    var from = tile.getBoundingClientRect();
    var st = detail.stage;
    st.style.left = from.left + 'px'; st.style.top = from.top + 'px';
    st.style.width = from.width + 'px'; st.style.height = from.height + 'px';
    st.style.borderRadius = '14px';
    st.querySelector('.lab-stagename').textContent = m.name;
    detail.classList.add('on');
    tile.classList.add('ghost');
    detail.fromTile = tile;

    buildPanel(m);

    // One forced reflow pins the start box, then the target styles go on in the
    // same task and the transition carries it. Deliberately not inside a
    // requestAnimationFrame: a hidden or backgrounded tab pauses those, and the
    // panel would be stuck off-screen when the user came back.
    void st.offsetWidth;
    var to = targetBox();
    st.style.left = to.left + 'px'; st.style.top = to.top + 'px';
    st.style.width = to.width + 'px'; st.style.height = to.height + 'px';
    st.style.borderRadius = '18px';
    detail.classList.add('shown');
  }

  function buildPanel(m) {
    var p = detail.panel;
    p.innerHTML = '';
    p.scrollTop = 0;
    p.appendChild(el('div', 'lab-fam2', m.family || 'Mode Lab'));
    p.appendChild(el('h3', '', m.name));
    p.appendChild(el('div', 'lab-tag2', m.tag || ''));
    p.appendChild(el('p', 'lab-lede', m.blurb));
    if (m.how && m.how.length) {
      p.appendChild(el('div', 'lab-h', 'How it works'));
      var ol = el('ol');
      m.how.forEach(function (line) { ol.appendChild(el('li', '', line)); });
      p.appendChild(ol);
    }
    var acts = el('div', 'lab-acts');
    var go = el('button', 'lab-go', 'PLAY OFFLINE');
    go.addEventListener('click', function () { launch(m.key, false); });
    var goOn = el('button', 'lab-goon', 'PLAY ONLINE');
    goOn.addEventListener('click', function () { launch(m.key, true); });
    var back = el('button', 'lab-back', '← back to the wall');
    back.addEventListener('click', function () { closeDetail(); });
    acts.appendChild(go); acts.appendChild(goOn); acts.appendChild(back);
    p.appendChild(acts);
  }

  function launch(key, online) {
    var fn = online ? api.onPlayOnline : api.onPlay;
    if (!fn) return;
    closeDetail(true);
    hide();
    fn(key);
  }

  function closeDetail(instant) {
    if (!current) return;
    var st = detail.stage, tile = detail.fromTile;
    current = null;
    detail.classList.remove('shown');
    if (instant) {
      detail.classList.remove('on');
      if (tile) tile.classList.remove('ghost');
      detail.fromTile = null;
      return;
    }
    if (tile) {
      var back = tile.getBoundingClientRect();
      st.style.left = back.left + 'px'; st.style.top = back.top + 'px';
      st.style.width = back.width + 'px'; st.style.height = back.height + 'px';
      st.style.borderRadius = '14px';
    }
    setTimeout(function () {
      detail.classList.remove('on');
      if (tile) tile.classList.remove('ghost');
      detail.fromTile = null;
    }, 460);
  }

  return {
    init: function (onPlay, onPlayOnline) { api.onPlay = onPlay; api.onPlayOnline = onPlayOnline; build(); },
    open: show, close: hide
  };
})();
