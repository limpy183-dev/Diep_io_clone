// modelab.js — the Mode Lab button and its menu.
//
// Self-contained on purpose: markup, styles and behaviour all live here, so
// index.html gains one script tag and main.js gains one line. Nothing in the
// base menu changes.
//
// Three pieces:
//   1. the button, a candy sticker with a tiny tank farming shapes inside it
//      and a canvas of polygons that bloom out of it on hover;
//   2. the wall, 38 live-rendered tiles (MODE_THUMB does the drawing) with
//      family filters;
//   3. the detail view, which the tile FLIPs into — measure, promote to fixed,
//      transition to the target box — with the write-up sliding in beside it.
//
// Only tiles actually on screen are drawn, and the whole loop stops when the
// menu is closed, so an idle main menu costs nothing.

// The tile the painters are written against. Everything they draw is in these
// pixels, so any larger canvas is a scaled version of this composition rather
// than the same drawing marooned in more space.
var THUMB_W = 300, THUMB_H = 190;

var MODELAB = (function () {
  var root = null, wall = null, grid = null, detail = null, tiles = [], raf = 0;
  var open = false, current = null, filter = 'All';
  var api = { onPlay: null, onPlayOnline: null, diff: null };

  // Juggernaut Royale only, for now: the two knobs that decide how long the
  // 140-hull climb takes. Multipliers rather than spans, so they scale the
  // mode's own size out of the table instead of repeating 18000 in here.
  var MAP_SIZES = [
    { k: 'xs', label: 'Extra Small', mul: 0.45, note: 'Knife-fight range. You meet the whole field inside a minute.' },
    { k: 's', label: 'Small', mul: 0.7, note: 'Tight. Farming and fighting happen in the same square.' },
    { k: 'm', label: 'Medium', mul: 1, note: 'The size the mode was tuned at.' },
    { k: 'l', label: 'Large', mul: 1.45, note: 'Room to farm a tier up before anyone finds you.' },
    { k: 'xl', label: 'Extra Large', mul: 2, note: 'Long walks between fights. Bring a hull that moves.' },
    { k: 'colossal', label: 'Colossal', mul: 2.8, note: 'Eight times the floor. A crown can hide out here for a long time, and the sim works for it.' }
  ];
  var mapSize = 'm';
  var botCap = null;                  // null = whatever the mode pins

  // --- styles ------------------------------------------------------------
  var CSS = [
    // ---- the button ----
    // A candy sticker rather than a diep button: a flowing spectrum face, a
    // white rim, a ledge it sits on, and a little tank inside that farms the
    // shapes drifting across it (and fires at your cursor when you hover).
    '#lab-launch{position:relative;display:block;margin:20px auto 6px;width:300px;padding:0;border:0;',
    '  background:none;cursor:pointer;-webkit-tap-highlight-color:transparent;perspective:600px;}',
    '#lab-launch .lab-aura{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
    '  width:430px;height:210px;pointer-events:none;}',
    '#lab-launch .lab-slab{--rx:0deg;--ry:0deg;--lift:0px;--ledge:7px;position:relative;display:flex;',
    '  flex-direction:column;align-items:center;justify-content:center;gap:3px;height:80px;',
    '  border-radius:20px;border:4px solid #FFF;box-sizing:border-box;',
    '  box-shadow:0 var(--ledge) 0 #7A4FB8,0 calc(var(--ledge) + 10px) 22px -6px rgba(70,40,120,.45);',
    '  transform:translateY(var(--lift)) rotateX(var(--rx)) rotateY(var(--ry));',
    '  transition:transform .3s cubic-bezier(.2,.9,.25,1.4),box-shadow .3s cubic-bezier(.2,.9,.25,1.4);}',
    '#lab-launch:hover .lab-slab,#lab-launch:focus-visible .lab-slab{--lift:-4px;--ledge:10px;',
    '  transition:transform .12s ease-out,box-shadow .3s cubic-bezier(.2,.9,.25,1.4);}',
    '#lab-launch:active .lab-slab{--lift:5px;--ledge:2px;transition-duration:.06s;}',
    '#lab-launch .lab-face{position:absolute;inset:0;border-radius:16px;overflow:hidden;',
    '  background:linear-gradient(110deg,#00C8F0,#00E16E,#FFE14D,#FF8A7A,#C47CF7,#7C8CFF,#00C8F0);',
    '  background-size:300% 100%;animation:labflow 7s linear infinite;}',
    '#lab-launch:hover .lab-face{animation-duration:2.6s;}',
    '@keyframes labflow{to{background-position:-300% 0;}}',
    // candy stripes crawling across the face
    '#lab-launch .lab-face::before{content:"";position:absolute;inset:0;',
    '  background:repeating-linear-gradient(-55deg,rgba(255,255,255,.17) 0 12px,transparent 12px 26px);',
    '  background-size:63.4px 100%;animation:labstripe 1.6s linear infinite;}',
    '@keyframes labstripe{to{background-position:63.4px 0;}}',
    // the sheen that sweeps across on hover
    '#lab-launch .lab-face::after{content:"";position:absolute;inset:0;',
    '  background:linear-gradient(105deg,transparent 38%,rgba(255,255,255,.55) 50%,transparent 62%);',
    '  transform:translateX(-130%);transition:transform .75s cubic-bezier(.3,.7,.3,1);}',
    '#lab-launch:hover .lab-face::after{transform:translateX(130%);}',
    '#lab-launch .lab-play{position:absolute;inset:0;width:100%;height:100%;}',
    // chunky diep lettering: white fill, dark outline, each letter on a wave
    '#lab-launch .lab-title{--amp:2;position:relative;z-index:1;pointer-events:none;',
    '  font:700 25px Ubuntu,Verdana,sans-serif;letter-spacing:.08em;color:#FFF;white-space:pre;',
    '  text-shadow:2px 0 #3B2A5C,-2px 0 #3B2A5C,0 2px #3B2A5C,0 -2px #3B2A5C,',
    '  2px 2px #3B2A5C,-2px 2px #3B2A5C,2px -2px #3B2A5C,-2px -2px #3B2A5C,0 4px #3B2A5C;}',
    '#lab-launch .lab-title span{display:inline-block;animation:labwave 1.8s ease-in-out infinite;',
    '  animation-delay:calc(var(--i) * -0.13s);}',
    '#lab-launch:hover .lab-title{--amp:6;}',
    '#lab-launch:hover .lab-title span{animation-duration:.8s;}',
    '@keyframes labwave{0%,100%{transform:translateY(calc(var(--amp) * 1px)) rotate(-2deg);}',
    '  50%{transform:translateY(calc(var(--amp) * -1px)) rotate(2deg);}}',
    '#lab-launch .lab-sub{position:relative;z-index:1;pointer-events:none;',
    '  font:700 10.5px Ubuntu,Verdana,sans-serif;letter-spacing:.12em;text-transform:uppercase;',
    '  color:#FFF;background:rgba(59,42,92,.55);padding:3px 10px;border-radius:99px;}',
    // the count, as a sticker slapped on the corner
    '#lab-launch .lab-badge{position:absolute;z-index:2;top:-16px;right:-14px;width:46px;height:46px;',
    '  display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;',
    '  background:#FFE14D;border:3px solid #FFF;border-radius:50%;color:#3B2A5C;line-height:1;',
    '  box-shadow:0 3px 0 #C9A82A,0 6px 12px -4px rgba(0,0,0,.35);',
    '  font:700 17px Ubuntu,Verdana,sans-serif;animation:labbob 2.2s ease-in-out infinite;}',
    '#lab-launch .lab-badge small{font-size:8px;letter-spacing:.1em;}',
    '#lab-launch:hover .lab-badge{animation:labpop .6s cubic-bezier(.2,.9,.25,1.4) both;}',
    '@keyframes labbob{0%,100%{transform:rotate(12deg) scale(1);}50%{transform:rotate(-6deg) scale(1.08);}}',
    '@keyframes labpop{0%{transform:rotate(12deg) scale(1);}60%{transform:rotate(380deg) scale(1.3);}',
    '  100%{transform:rotate(372deg) scale(1.15);}}',

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
    // the difficulty row
    '#lab-panel .lab-diff{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 22px;}',
    '#lab-panel .lab-dbtn{flex:1 1 auto;min-width:62px;background:rgba(255,255,255,.05);',
    '  border:1px solid rgba(255,255,255,.09);color:#8FA0B8;border-radius:9px;padding:9px 6px;',
    '  font:700 11px Ubuntu,Verdana,sans-serif;letter-spacing:.08em;text-transform:uppercase;',
    '  cursor:pointer;transition:all .18s;}',
    '#lab-panel .lab-dbtn:hover{color:#EAF2FF;border-color:rgba(255,255,255,.24);}',
    '#lab-panel .lab-dbtn.on{color:#08090E;border-color:transparent;font-weight:700;}',
    '#lab-panel .lab-slide{display:flex;align-items:center;gap:14px;margin:0 0 22px;}',
    '#lab-panel .lab-slide input[type=range]{flex:1;height:6px;-webkit-appearance:none;appearance:none;',
    '  background:rgba(255,255,255,.12);border-radius:99px;outline:none;cursor:pointer;}',
    '#lab-panel .lab-slide input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
    '  width:18px;height:18px;border-radius:50%;background:#8FD9FF;cursor:pointer;',
    '  box-shadow:0 2px 8px rgba(0,0,0,.6);}',
    '#lab-panel .lab-slide input[type=range]::-moz-range-thumb{width:18px;height:18px;border:0;',
    '  border-radius:50%;background:#8FD9FF;cursor:pointer;}',
    '#lab-panel .lab-slideval{flex:none;min-width:2.6em;text-align:right;color:#EAF2FF;',
    '  font:700 17px Ubuntu,Verdana,sans-serif;}',
    '#lab-panel .lab-dnote{font:400 13px Ubuntu,Verdana,sans-serif;color:#7C8DA6;margin:-14px 0 22px;min-height:2.6em;}',
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
    '  #lab-launch *,#lab-launch *::before{animation:none !important;}',
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

  // --- the tank inside the button --------------------------------------
  // A tiny diep round: shapes drift in from the right, a tank on the left
  // farms them. Hovered, the barrel follows the cursor and fires fast; a click
  // is a spread shot. Purely decorative, so it skips drawing while the menu is
  // hidden and stays still under reduced motion.
  function playCanvas(btn) {
    var cv = el('canvas', 'lab-play');
    var c = cv.getContext('2d');
    var W = 292, H = 72;                  // the face inside the 4px rim
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    c.scale(dpr, dpr);
    // diep's own shapes: [sides, radius, fill, stroke, hp, xp]
    var KINDS = [[4, 8, '#FFE869', '#BFAE4E', 1, 10], [3, 9, '#FC7677', '#BD585A', 1, 25],
      [5, 11, '#768DFC', '#5869BD', 3, 130]];
    var tank = { x: 26, y: H / 2, ang: 0, recoil: 0 };
    var shapes = [], shots = [], parts = [], texts = [];
    var mouse = { x: 0, y: 0, in: false }, cool = 600, last = 0;
    var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    function addShape(x) {
      var k = KINDS[Math.random() < 0.15 ? 2 : (Math.random() * 2) | 0];
      shapes.push({ x: x, y: 13 + Math.random() * (H - 26), vx: -(0.18 + Math.random() * 0.3),
        k: k, hp: k[4], rot: Math.random() * 6.3, spin: (Math.random() - 0.5) * 0.04, hit: 0, die: -1 });
    }
    for (var i = 0; i < 4; i++) addShape(90 + i * 55);

    function poly(sides, r) {
      c.beginPath();
      for (var s = 0; s < sides; s++) {
        var a = Math.PI * 2 * s / sides;
        if (s) c.lineTo(Math.cos(a) * r, Math.sin(a) * r); else c.moveTo(r, 0);
      }
      c.closePath();
    }
    function fire(spread) {
      var a = tank.ang + spread;
      shots.push({ x: tank.x + Math.cos(a) * 21, y: tank.y + Math.sin(a) * 21,
        vx: Math.cos(a) * 4.6, vy: Math.sin(a) * 4.6 });
      tank.recoil = 4;
    }
    function target() {
      if (mouse.in) return mouse;
      var best = null;
      for (var i = 0; i < shapes.length; i++) {
        var s = shapes[i];
        if (s.die < 0 && s.x > 60 && s.x < W - 6 && (!best || s.x < best.x)) best = s;
      }
      return best;
    }

    function frame(now) {
      if (!still) requestAnimationFrame(frame);
      if (!btn.offsetParent) { last = 0; return; }   // menu hidden: nothing to draw
      var dt = last ? Math.min(50, now - last) : 16; last = now;
      var step = dt / 16.7;
      if (shapes.length < 6 && Math.random() < 0.02 * step) addShape(W + 14);

      var tg = target();
      if (tg) {
        var want = Math.atan2(tg.y - tank.y, tg.x - tank.x);
        var d = Math.atan2(Math.sin(want - tank.ang), Math.cos(want - tank.ang));
        tank.ang += d * Math.min(1, 0.25 * step);
        cool -= dt;
        if (cool <= 0 && Math.abs(d) < 0.3) { fire(0); cool = mouse.in ? 130 : 700; }
      }
      tank.recoil *= Math.pow(0.8, step);

      var i, j, s;
      for (i = shots.length - 1; i >= 0; i--) {
        var b = shots[i];
        b.x += b.vx * step; b.y += b.vy * step;
        var gone = b.x > W + 8 || b.x < -8 || b.y < -8 || b.y > H + 8;
        for (j = 0; j < shapes.length && !gone; j++) {
          s = shapes[j];
          if (s.die >= 0) continue;
          var dx = b.x - s.x, dy = b.y - s.y, rr = s.k[1] + 3.5;
          if (dx * dx + dy * dy > rr * rr) continue;
          gone = true; s.hit = 1; s.x += b.vx * 0.8; s.y += b.vy * 0.8;
          if (--s.hp <= 0) {
            s.die = 0;
            texts.push({ x: s.x, y: s.y, t: 0, s: '+' + s.k[5] });
            for (var p = 0; p < 7; p++) {
              var pa = Math.random() * 6.3, sp = 0.6 + Math.random() * 1.6;
              parts.push({ x: s.x, y: s.y, vx: Math.cos(pa) * sp, vy: Math.sin(pa) * sp, t: 0, col: s.k[2] });
            }
          }
        }
        if (gone) shots.splice(i, 1);
      }

      c.clearRect(0, 0, W, H);
      c.lineJoin = 'round';
      for (i = shapes.length - 1; i >= 0; i--) {
        s = shapes[i];
        s.x += s.vx * step; s.rot += s.spin * step; s.hit *= Math.pow(0.8, step);
        if (s.die >= 0) s.die += step / 14;
        if (s.x < -20 || s.die >= 1) { shapes.splice(i, 1); continue; }
        c.save();
        c.translate(s.x, s.y); c.rotate(s.rot);
        if (s.die >= 0) { c.globalAlpha = 1 - s.die; c.scale(1 + s.die * 0.7, 1 + s.die * 0.7); }
        poly(s.k[0], s.k[1]);
        c.fillStyle = s.k[2]; c.fill();
        if (s.hit > 0.05) { c.fillStyle = 'rgba(255,255,255,' + s.hit * 0.8 + ')'; c.fill(); }
        c.strokeStyle = s.k[3]; c.lineWidth = 2.5; c.stroke();
        c.restore();
      }
      for (i = parts.length - 1; i >= 0; i--) {
        var q = parts[i];
        q.t += step / 26; q.x += q.vx * step; q.y += q.vy * step;
        if (q.t >= 1) { parts.splice(i, 1); continue; }
        c.globalAlpha = 1 - q.t; c.fillStyle = q.col;
        c.fillRect(q.x - 2, q.y - 2, 4, 4);
      }
      c.globalAlpha = 1;
      c.fillStyle = '#00B2E1'; c.strokeStyle = '#0085A8'; c.lineWidth = 1.6;
      for (i = 0; i < shots.length; i++) {
        c.beginPath(); c.arc(shots[i].x, shots[i].y, 3.4, 0, 6.3); c.fill(); c.stroke();
      }
      // the tank: barrel under body, the way diep draws it
      c.save();
      c.translate(tank.x, tank.y); c.rotate(tank.ang);
      c.fillStyle = '#999'; c.strokeStyle = '#727272'; c.lineWidth = 2.5;
      c.fillRect(0, -4.5, 21 - tank.recoil, 9); c.strokeRect(0, -4.5, 21 - tank.recoil, 9);
      c.beginPath(); c.arc(0, 0, 11, 0, 6.3);
      c.fillStyle = '#00B2E1'; c.fill(); c.strokeStyle = '#0085A8'; c.stroke();
      c.restore();
      c.font = '700 11px Ubuntu,Verdana,sans-serif'; c.textAlign = 'center';
      for (i = texts.length - 1; i >= 0; i--) {
        var tx = texts[i];
        tx.t += step / 45;
        if (tx.t >= 1) { texts.splice(i, 1); continue; }
        c.globalAlpha = 1 - tx.t * tx.t;
        c.lineWidth = 3; c.strokeStyle = '#3B2A5C';
        c.strokeText(tx.s, tx.x, tx.y - 6 - tx.t * 16);
        c.fillStyle = '#FFF'; c.fillText(tx.s, tx.x, tx.y - 6 - tx.t * 16);
      }
      c.globalAlpha = 1;
    }
    requestAnimationFrame(frame);

    btn.addEventListener('mousemove', function (e) {
      var r = cv.getBoundingClientRect();
      mouse.x = (e.clientX - r.left) * W / r.width;
      mouse.y = (e.clientY - r.top) * H / r.height;
      mouse.in = true;
    });
    btn.addEventListener('mouseleave', function () { mouse.in = false; });
    btn.addEventListener('click', function () {
      for (var i = -3; i <= 3; i++) fire(i * 0.16);
      if (still) frame(performance.now());
    });
    return cv;
  }

  // The slab leans toward the cursor.
  function tilt(btn, slab) {
    btn.addEventListener('mousemove', function (e) {
      var r = btn.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
      slab.style.setProperty('--rx', (-py * 14).toFixed(2) + 'deg');
      slab.style.setProperty('--ry', (px * 10).toFixed(2) + 'deg');
    });
    btn.addEventListener('mouseleave', function () {
      slab.style.setProperty('--rx', '0deg');
      slab.style.setProperty('--ry', '0deg');
    });
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
    var face = el('div', 'lab-face');
    face.appendChild(playCanvas(btn));
    slab.appendChild(face);
    var title = el('div', 'lab-title');
    'MODE LAB'.split('').forEach(function (ch, i) {
      var sp = el('span', '', ch);
      sp.style.setProperty('--i', i);
      title.appendChild(sp);
    });
    slab.appendChild(title);
    var n = Object.keys(LAB_MODES).length;
    slab.appendChild(el('div', 'lab-sub', 'experimental gamemodes'));
    var badge = el('div', 'lab-badge', String(n));
    badge.appendChild(el('small', '', 'MODES'));
    slab.appendChild(badge);
    btn.appendChild(slab);
    tilt(btn, slab);
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
      var fn2 = MODE_THUMB[current];
      if (fn2) {
        // The painters compose against a fixed 300x190 tile: radii, fonts and
        // offsets are in tile pixels. Handing them a 750x650 box just spreads
        // the same small drawing over more room. Scale the context to COVER
        // the box instead, so everything in the scene grows with it.
        var k = Math.max(box.width / THUMB_W, box.height / THUMB_H);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.save();
        ctx.translate((box.width - THUMB_W * k) / 2, (box.height - THUMB_H * k) / 2);
        ctx.scale(k, k);
        try { fn2(ctx, THUMB_W, THUMB_H, t); } catch (e) { /* ignore */ }
        ctx.restore();
      }
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
    // Bot difficulty, right where you choose the mode. Every mode's bots read
    // the same six skill dials, and the Lab modes lean on them harder than the
    // base game does — an Extreme bot in Grand Prix drives the racing line and
    // shoots you off it.
    if (api.diff) {
      p.appendChild(el('div', 'lab-h', 'Bot difficulty'));
      var row = el('div', 'lab-diff');
      var note = el('div', 'lab-dnote');
      var TONE = { easy: '#7FD8A0', medium: '#8FD9FF', hard: '#FFDE43', veryhard: '#FFA95C', extreme: '#FF6A6A' };
      api.diff.list().forEach(function (d) {
        var b = el('button', 'lab-dbtn' + (d.key === api.diff.get() ? ' on' : ''), d.label);
        if (d.key === api.diff.get()) b.style.background = TONE[d.key] || '#8FD9FF';
        b.addEventListener('click', function () {
          api.diff.set(d.key);
          row.querySelectorAll('.lab-dbtn').forEach(function (x) { x.classList.remove('on'); x.style.background = ''; });
          b.classList.add('on');
          b.style.background = TONE[d.key] || '#8FD9FF';
          note.textContent = d.blurb;
        });
        row.appendChild(b);
      });
      p.appendChild(row);
      var cur = api.diff.list().filter(function (d) { return d.key === api.diff.get(); })[0];
      note.textContent = cur ? cur.blurb : '';
      p.appendChild(note);
    }

    // Map size and field size, offline only: an online match is the server's
    // arena, not yours. Scoped to the one mode whose whole shape is the length
    // of the climb — every other mode is tuned to its own numbers.
    if (m.key === 'juggerroyale') {
      var base = modeSize(m.key);
      p.appendChild(el('div', 'lab-h', 'Map size'));
      var srow = el('div', 'lab-diff');
      var snote = el('div', 'lab-dnote');
      MAP_SIZES.forEach(function (sz) {
        var b = el('button', 'lab-dbtn' + (sz.k === mapSize ? ' on' : ''), sz.label);
        if (sz.k === mapSize) b.style.background = '#8FD9FF';
        b.addEventListener('click', function () {
          mapSize = sz.k;
          srow.querySelectorAll('.lab-dbtn').forEach(function (x) { x.classList.remove('on'); x.style.background = ''; });
          b.classList.add('on');
          b.style.background = '#8FD9FF';
          snote.textContent = sizeNote(sz, base);
        });
        srow.appendChild(b);
      });
      p.appendChild(srow);
      snote.textContent = sizeNote(currentSize(), base);
      p.appendChild(snote);

      p.appendChild(el('div', 'lab-h', 'Bot amount'));
      if (botCap === null) botCap = modeBots(m.key);
      var brow = el('div', 'lab-slide');
      var rng = el('input');
      rng.type = 'range'; rng.min = '0'; rng.max = '100'; rng.step = '1'; rng.value = String(botCap);
      var bval = el('div', 'lab-slideval', String(botCap));
      var bnote = el('div', 'lab-dnote', botNote(botCap));
      rng.addEventListener('input', function () {
        botCap = +rng.value;
        bval.textContent = String(botCap);
        bnote.textContent = botNote(botCap);
      });
      brow.appendChild(rng); brow.appendChild(bval);
      p.appendChild(brow);
      p.appendChild(bnote);
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

  // The mode table is the single source for both defaults; the Lab only scales
  // what it finds there.
  function modeSize(key) {
    var g = typeof GAMEMODES !== 'undefined' ? GAMEMODES[key] : null;
    return (g && g.size) || 22300;
  }
  function modeBots(key) {
    var g = typeof GAMEMODES !== 'undefined' ? GAMEMODES[key] : null;
    return (g && g.rules && typeof g.rules.bots === 'number') ? g.rules.bots : 80;
  }
  function currentSize() {
    return MAP_SIZES.filter(function (s) { return s.k === mapSize; })[0] || MAP_SIZES[2];
  }
  function sizeNote(sz, base) {
    return Math.round(base * sz.mul).toLocaleString() + ' units across · ' + sz.note;
  }
  function botNote(n) {
    if (!n) return 'Nobody else. The arena is yours to walk.';
    return n + ' rival' + (n === 1 ? '' : 's') + ' at most — a kill frees a slot and something respawns into it.';
  }

  function launch(key, online) {
    var fn = online ? api.onPlayOnline : api.onPlay;
    if (!fn) return;
    closeDetail(true);
    hide();
    // Only the mode that owns the knobs sends them, and only offline.
    var extra = (!online && key === 'juggerroyale')
      ? { size: Math.round(modeSize(key) * currentSize().mul), botCap: botCap }
      : undefined;
    fn(key, extra);
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
    init: function (onPlay, onPlayOnline, diff) {
      api.onPlay = onPlay; api.onPlayOnline = onPlayOnline; api.diff = diff || null;
      build();
    },
    open: show, close: hide
  };
})();
