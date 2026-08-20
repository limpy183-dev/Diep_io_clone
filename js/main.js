// main.js — input sampling, fixed-timestep loop, menu wiring.
//
// Offline runs the simulation locally. Online sends inputs to the server and
// draws its snapshots. Everything below the input layer is shared: the renderer
// cannot tell the two apart.

(function () {
  var canvas = document.getElementById('game');
  var menu = document.getElementById('menu');
  var nameInput = document.getElementById('name');
  var modeSelect = document.getElementById('mode');
  var serverInput = document.getElementById('server');
  var playBtn = document.getElementById('play');
  var onlineBtn = document.getElementById('playOnline');
  var hint = document.getElementById('hint');
  var status = document.getElementById('status');

  var game = null, renderer = null, net = null, online = false, running = false;
  var keys = Object.create(null);
  var mouse = { x: 0, y: 0, left: false, right: false };
  var modKey = null;   // 'u' queue one, 'm' fill
  var localInput = { up: 0, down: 0, left: 0, right: 0, fire: 0, altFire: 0 };
  var cheats = { suicide: false, god: false, levelup: false };

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------- actions (both modes)
  function player() { return game && game.player; }

  function doStat(wire) {
    var p = player();
    if (!p || p.dead || p.statsAvailable <= 0) return;
    if (p.def.stats[wire].max === 0 || p.stats[wire] >= p.def.stats[wire].max) return;
    if (online) { net.upgradeStat(wire); p.statsAvailable--; p.stats[wire]++; }  // corrected by next snapshot
    else p.upgradeStat(wire);
  }
  function doUpgrade(id) {
    var p = player();
    if (!p || p.dead) return;
    if (online) net.upgradeTo(id); else p.upgradeTo(id);
  }
  function doToggle(which) {
    var p = player();
    if (!p) return;
    if (online) net.toggle(which);
    else if (which === 0) p.autoFire = !p.autoFire;
    else p.autoSpin = !p.autoSpin;
    // Online the flip only lands on the next snapshot, so predict it here.
    var state = which === 0 ? p.autoFire : p.autoSpin;
    if (online) state = !state;
    var label = (which === 0 ? 'Auto Fire' : 'Auto Spin') + ': ' + (state ? 'ON' : 'OFF');
    var list = game.notifications, prefix = label.split(':')[0];
    for (var n = list.length - 1; n >= 0; n--)
      if (list[n].text.indexOf(prefix) === 0) list.splice(n, 1);  // one line per toggle, not a stack
    list.push({ text: label, ttl: 60, color: 'rgba(0,120,220,0.75)' });
  }
  // H: take control of a nearby Dominator or Mothership your team holds, or
  // step back out of the one you are already piloting.
  function doPossess() {
    var p = player();
    if (!p || p.dead) return;
    if (online) { net.possess(); return; }
    if (typeof possess !== 'function') return;
    if (p.possessing) { release(game, p); return; }
    var pool = (game.dominators || []).concat(game.motherships || []);
    var best = null, bestD = 1400 * 1400;
    for (var i = 0; i < pool.length; i++) {
      var c = pool[i];
      if (c.dead || c.possessedBy || c.team !== p.team) continue;
      var d = (c.x - p.x) * (c.x - p.x) + (c.y - p.y) * (c.y - p.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best && possess(game, p, best)) game.notify('Piloting the ' + best.name + ' — press H to step out', 100);
    else if (!best) game.notify('Nothing of yours to take control of nearby', 60);
  }

  // ------------------------------------------------------------- spectating
  // /view and /viewclick. Offline the camera is ours to move; online the server
  // owns it, so the click is relayed as the same /view command the user types.
  function viewing() { return !!(game && game.viewing && game.spectate && !game.spectate.dead); }

  // follow: /viewleader, re-pointed at game.leader every pump.
  function applyView(e, follow) {
    if (e && e === player()) e = null;            // watching your own tank would freeze it
    if (online) net.sendChat(follow ? '/viewleader' : '/view ' + (e && e.name ? e.name : 'off'));
    else { game.spectate = e || null; game.viewing = !!e; game.followLeader = !!follow; }
  }

  function tankAt(wx, wy) {
    var best = null, bd = Infinity;
    game.entities.forEach(function (e) {
      if (e.type !== 'tank' || e.dead || !e.name) return;
      var d = Math.hypot(e.x - wx, e.y - wy);
      if (d < e.size + 20 && d < bd) { bd = d; best = e; }
    });
    return best;
  }

  // ------------------------------------------------------------------ chat
  // Offline the command runs against the local sim; online everything that
  // touches the world is sent to the server, which owns the real answer.
  function openChat(prefill) {
    for (var kk in keys) keys[kk] = false;      // stop moving the moment you type
    mouse.left = mouse.right = false;
    CHAT.open(prefill);
  }

  function myName() {
    var p = player();
    return (p && p.name) || nameInput.value.trim() || 'you';
  }

  function chatContext() {
    var say = function (t) { CHAT.push('system', null, t, null); };
    return {
      game: game, tank: player(), online: online, name: myName(),
      sandbox: !online || cheatsOK(game),
      setView: applyView,
      say: say, broadcast: say
    };
  }

  function sendChat(text) {
    if (online) { net.sendChat(text); return; }
    var p = player();
    CHAT.push('player', myName(), text, p ? p.fill : null);
    // the bots are not smart, but they are opinionated
    if (Math.random() < 0.35) setTimeout(function () {
      if (!running || online) return;
      var r = botReplyLine(game);
      if (r) CHAT.push('player', r.name, r.text, r.fill);
    }, 700 + Math.random() * 2200);
  }

  CHAT.init({ send: sendChat, context: chatContext, online: function () { return online; } });

  function doRespawn() {
    if (online) net.respawn();
    else game.respawnPlayer(nameInput.value.trim());
    renderer.respawnBtn = null;
  }
  function queueStat(wire, fill) {
    var p = player();
    if (!p || p.def.stats[wire].max === 0) return;
    if (fill) {
      while (p.queued.filter(function (q) { return q === wire; }).length + p.stats[wire] < p.def.stats[wire].max) p.queued.push(wire);
    } else p.queued.push(wire);
  }
  function flushQueue() {
    var p = player();
    if (!p || p.dead) return;
    while (p.queued.length && p.statsAvailable > 0) {
      var w = p.queued[0];
      if (p.stats[w] >= p.def.stats[w].max) { p.queued.shift(); continue; }
      p.queued.shift();
      doStat(w);
    }
  }

  // ---------------------------------------------------------------- input
  var STAT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8'];

  window.addEventListener('keydown', function (e) {
    if (!running || CHAT.isOpen()) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // T or Enter opens chat. Everything below is keyboard the game owns, so it
    // has to stop here or the first letter you type also buys an upgrade.
    if (k === 't' || k === 'Enter') { e.preventDefault(); openChat(); return; }
    if (k === '/') { e.preventDefault(); openChat('/'); return; }
    if (keys[k] && (k === 'e' || k === 'c')) return;   // ignore auto-repeat on toggles
    keys[k] = true;
    var p = player();

    if (k === 'u' || k === 'm') { modKey = k; return; }

    var si = STAT_KEYS.indexOf(k);
    if (si >= 0 && p && !p.dead) {
      var wire = uiToWire(si);
      if (p.def.stats[wire].max === 0) return;
      if (modKey === 'm') { queueStat(wire, true); modKey = 'consumed'; }
      else if (modKey === 'u') { queueStat(wire, false); modKey = 'consumed'; }
      else doStat(wire);
      flushQueue();
      e.preventDefault();
      return;
    }

    switch (k) {
      case 'e': doToggle(0); break;
      case 'c': doToggle(1); break;
      case 'y': renderer.showClassTree = true; break;
      case 'h': doPossess(); break;
      case 'o': cheats.suicide = true; if (!online && p) p.selfDestruct = true; break;
      case 'k': cheats.levelup = true; if (!online && cheatsOK(game) && p) p.addScore(Math.max(5, LEVEL_SCORE[Math.min(MAX_LEVEL, p.level + 1)] - p.score + 1)); break;
      case ';':
        cheats.god = !cheats.god;
        if (!online && cheatsOK(game) && p) { p.godMode = !p.godMode; game.notify('God mode ' + (p.godMode ? 'ON' : 'OFF'), 50); }
        break;
      case '\\': if (!online && cheatsOK(game) && p) cycleTank(p); break;
      case 'Escape': leave(); break;
      case ' ': e.preventDefault(); break;
    }
  });

  window.addEventListener('keyup', function (e) {
    if (CHAT.isOpen()) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    keys[k] = false;
    var p = player();
    if (k === 'y' && renderer) renderer.showClassTree = false;
    if (k === 'o') { cheats.suicide = false; if (!online && p) p.selfDestruct = false; }
    if (k === 'k') cheats.levelup = false;
    if (k === 'u' && modKey === 'u' && p) p.queued.length = 0;   // U alone clears the queue
    if (k === 'u' || k === 'm') modKey = null;
  });

  function cycleTank(p) {
    var ids = TANK_DEFS.filter(Boolean).filter(function (d) { return !d.flags.devOnly; })
      .map(function (d) { return d.id; }).sort(function (a, b) { return b - a; });
    var next = ids[(ids.indexOf(p.tankId) + 1) % ids.length];
    p.setTank(next); p.recompute();
    game.notify(TANK_DEFS[next].name, 40);
  }

  canvas.addEventListener('mousemove', function (e) {
    mouse.x = e.clientX; mouse.y = e.clientY;
    var dpr = canvas.width / window.innerWidth;
    renderer.mouseX = e.clientX * dpr; renderer.mouseY = e.clientY * dpr;
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('mousedown', function (e) {
    if (!running) return;
    if (e.button === 2) { mouse.right = true; return; }
    if (e.button !== 0) return;
    if (handleClick(e.clientX, e.clientY)) return;
    mouse.left = true;
  });
  window.addEventListener('mouseup', function (e) {
    if (e.button === 2) mouse.right = false;
    if (e.button === 0) mouse.left = false;
  });
  window.addEventListener('blur', function () {
    mouse.left = mouse.right = false;
    for (var k in keys) keys[k] = false;
  });

  function handleClick(cx, cy) {
    var dpr = canvas.width / window.innerWidth;
    var x = cx * dpr, y = cy * dpr, p = player();
    if (p && p.dead) {
      var b = renderer.respawnBtn;
      if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) doRespawn();
      return true;                                   // swallow clicks behind the death screen
    }
    if (!p) return false;
    var lay = renderer.upgradeLayout(), i;
    function inside(r) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
    if (lay) {
      for (i = 0; i < lay.cards.length; i++) if (inside(lay.cards[i])) { doUpgrade(lay.cards[i].id); return true; }
      if (inside(lay.close) || inside(lay.ignore)) { renderer.upgradeHidden = true; return true; }
      if (inside(lay.panel)) return true;             // panel swallows its own clicks
    }
    // A borrowed build (/view) is drawn read-only, so it must not take clicks
    // either — otherwise clicking their greyed bars spends your own points.
    var stats = (renderer.statsOwner() === p && p.statsAvailable > 0) ? renderer.statRects() : [];
    for (i = 0; i < stats.length; i++) {
      var s = stats[i];
      if (x >= s.x && x <= s.x + s.w + 6 + s.h * 1.35 && y >= s.y && y <= s.y + s.h) { doStat(s.wire); return true; }
    }
    if (game.clickView) {
      var w = renderer.toWorld(x, y);
      applyView(tankAt(w.x, w.y));               // empty ground picks nobody, which is /view off
      return true;
    }
    return false;
  }

  function readKeys() {
    if (viewing()) {                              // watching someone else: your tank sits still
      localInput.up = localInput.down = localInput.left = localInput.right = localInput.fire = localInput.altFire = 0;
      return;
    }
    localInput.up = (keys['w'] || keys['arrowup'] || keys['ArrowUp']) ? 1 : 0;
    localInput.down = (keys['s'] || keys['arrowdown'] || keys['ArrowDown']) ? 1 : 0;
    localInput.left = (keys['a'] || keys['arrowleft'] || keys['ArrowLeft']) ? 1 : 0;
    localInput.right = (keys['d'] || keys['arrowright'] || keys['ArrowRight']) ? 1 : 0;
    localInput.fire = (mouse.left || keys[' ']) ? 1 : 0;
    localInput.altFire = (mouse.right || keys['Shift'] || keys['shift']) ? 1 : 0;
  }

  function mouseWorld() {
    var dpr = canvas.width / window.innerWidth;
    return renderer.toWorld(mouse.x * dpr, mouse.y * dpr);
  }

  // ---------------------------------------------------------------- loop
  var acc = 0, last = 0, netAcc = 0;
  var simTimer = 0, simLast = 0;
  // Wall time a single pump is allowed to replay. Browsers freeze rAF in a
  // hidden tab and throttle background intervals to ~1 Hz, so the sim needs to
  // catch up in bursts or an alt-tabbed arena sits exactly where you left it.
  var SIM_CATCHUP = 2000;
  var closedAt = 0;                 // ms stamp of the offline arena closing; 0 = still open
  var CLOSE_LINGER = 5000;

  // The upgrade cards own the top-left corner too; chat sits under them. Card
  // geometry is canvas pixels, the overlay is CSS pixels.
  function chatTop() {
    var lay = renderer.upgradeLayout();
    if (!lay) return 12;
    var dpr = canvas.width / window.innerWidth;
    return Math.round((lay.panel.y + lay.panel.h) / dpr) + 6;
  }

  // The offline sim runs off its own clock, pumped from both rAF and an interval:
  // rAF alone stops dead in a hidden tab, which is why an arena left alone for
  // five minutes came back with every bot still on its starting score.
  // ponytail: after ~5 min hidden Chrome throttles intervals to 1/min, so the
  // arena falls behind wall time instead of stopping. A worker clock would fix
  // that if it ever matters.
  function simPump() {
    if (!running || online || !game) return;
    var now = performance.now();
    if (!simLast) simLast = now;
    // /timewarp scales sim time against wall time; the step cap scales with it
    // so a sped-up arena is not silently throttled back to real time.
    var warp = game.timeScale || 1;
    acc += Math.min(SIM_CATCHUP, now - simLast) * warp;
    simLast = now;
    var cap = Math.ceil(SIM_CATCHUP * warp / MSPT), steps = 0;
    while (acc >= MSPT && steps < cap) {
      var lp = game.player;
      if (lp && !lp.dead) {
        var ctrl = (lp.possessing && !lp.possessing.dead) ? lp.possessing : lp;
        ctrl.input.up = localInput.up; ctrl.input.down = localInput.down;
        ctrl.input.left = localInput.left; ctrl.input.right = localInput.right;
        ctrl.input.fire = localInput.fire; ctrl.input.altFire = localInput.altFire;
        if (!viewing()) { var mw = mouseWorld(); ctrl.mouse.x = mw.x; ctrl.mouse.y = mw.y; }
      }
      game.step();
      acc -= MSPT; steps++;
    }
    if (steps === cap) acc = 0;
    if (game.followLeader) applyView(game.leader, true);   // the crown moves, the camera follows
    flushQueue();
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (!last) last = now;
    var dt = Math.min(250, now - last);
    last = now;
    CHAT.fps = CHAT.fps * 0.92 + (1000 / Math.max(1, dt)) * 0.08;
    CHAT.setTop(chatTop());
    readKeys();

    if (online) {
      var p = game.player;
      p.input.up = localInput.up; p.input.down = localInput.down;
      p.input.left = localInput.left; p.input.right = localInput.right;
      p.input.fire = localInput.fire; p.input.altFire = localInput.altFire;
      var w = mouseWorld();
      p.mouse.x = w.x; p.mouse.y = w.y;
      netAcc += dt;
      if (netAcc >= MSPT) { netAcc = 0; net.sendInput(localInput, p.mouse, cheats); }
      flushQueue();
      net.clientTick();
      var a = net.alpha();
      renderer.updateCamera(dt, a);
      renderer.render(a);
      return;
    }

    simPump();

    // Closers swept the board: hold the CLOSED banner, then drop back to the
    // menu, which is what "reset" means offline — the next Play is a new arena.
    if (game.closed) {
      if (!closedAt) closedAt = now;
      else if (now - closedAt > CLOSE_LINGER) { leave(); return; }
    }

    var alpha = acc / MSPT;
    renderer.updateCamera(dt, alpha);
    renderer.render(alpha);
  }

  // ------------------------------------------------- menu backdrop
  // diep.io plays a live match behind its menu. Same trick: a headless game
  // (no local player, so the HUD stays quiet) with the camera trailing the leader.
  var bg = null, bgR = null, bgAcc = 0, bgLast = 0;

  function bgFrame(now) {
    if (running || !bg) { bg = bgR = null; return; }
    requestAnimationFrame(bgFrame);
    if (!bgLast) bgLast = now;
    var dt = Math.min(250, now - bgLast); bgLast = now;
    bgAcc += dt;
    for (var n = 0; bgAcc >= MSPT && n < 3; n++) { bg.step(); bgAcc -= MSPT; }
    // No one to watch: drift around the middle on two slow, out-of-phase circles.
    var t = bg.tick / TPS;
    bgR.cam.x = Math.cos(t * 0.10) * 1400;
    bgR.cam.y = Math.sin(t * 0.073) * 1400;
    bgR.render(bgAcc / MSPT);
  }

  function startBackdrop() {
    if (bg || running) return;
    bg = new Game('ffa', '', { headless: true, difficulty: 'medium', botCount: 30 });
    bgR = new Renderer(canvas, bg);
    bgR.cam.fov = 0.32;
    bgAcc = 0; bgLast = 0;
    requestAnimationFrame(bgFrame);
  }

  // ---------------------------------------------------------------- start
  function beginRender(g) {
    bg = bgR = null;
    game = g;
    renderer = new Renderer(canvas, g);
    if (g.player) { renderer.cam.x = g.player.x; renderer.cam.y = g.player.y; }
    menu.style.display = 'none';
    CHAT.show();
    if (!online) CHAT.system('Press T or Enter to chat. Type /help for commands, /cheats for the rest.');
    running = true; last = 0; acc = 0; netAcc = 0; closedAt = 0;
    simLast = 0;
    if (simTimer) clearInterval(simTimer);
    simTimer = online ? 0 : setInterval(simPump, MSPT);
    requestAnimationFrame(frame);
  }

  function saveName() {
    try { localStorage.setItem('ta_name', nameInput.value.trim()); localStorage.setItem('ta_server', serverInput.value.trim()); } catch (e) { /* private mode */ }
  }

  function startOffline() {
    online = false; net = null;
    saveName();
    setStatus('');
    closePicker();
    beginRender(new Game(modeSelect.value, nameInput.value.trim(), {
      difficulty: difficultyArg(), botCount: sel === 'custom' ? botCount : undefined
    }));
    game.notify('Bots: ' + diffLabel(), 90);
  }

  // -------------------------------------------------- bot difficulty picker
  // Two ways in: the Play Offline button, and the "change" link on the menu.
  // Both land here, so the setting is editable without committing to a match.
  var picker = document.getElementById('picker');
  var presetBox = document.getElementById('pk-presets');
  var customBox = document.getElementById('pk-custom');
  var knobBox = document.getElementById('pk-knobs');
  var seedBox = document.getElementById('pk-seed');
  var diffName = document.getElementById('diffname');

  var DIFF_BLURB = {
    easy: 'Barely aims, wanders off, never dodges. Free score.',
    medium: 'Leads its shots a little and fights back. A fair game.',
    hard: 'Kites, strafes, picks its fights and finishes them.',
    veryhard: 'Dodges your fire, hunts you down, retreats to heal.',
    extreme: 'Full intercept aim, no mistakes, and it wants you specifically.'
  };
  // Where each preset sits on the 0-10 sliders, for the seed chips.
  var DIFF_SEED = { easy: 0, medium: 3.5, hard: 6.5, veryhard: 8.5, extreme: 10 };

  var sel = 'medium';
  var custom = { aim: 5, react: 5, dodge: 5, move: 5, aggro: 5, brain: 5 };
  var botCount = 80;

  function difficultyArg() {
    if (sel !== 'custom') return sel;
    var o = { label: 'Custom' };
    BOT_KNOB_GROUPS.forEach(function (grp) { o[grp.key] = custom[grp.key]; });
    return o;
  }
  function diffLabel() { return sel === 'custom' ? 'Custom' : BOT_SKILL[sel].label; }
  function saveDiff() {
    try { localStorage.setItem('ta_diff', JSON.stringify({ sel: sel, custom: custom, botCount: botCount })); } catch (e) { /* private mode */ }
  }
  function loadDiff() {
    var s;
    try { s = JSON.parse(localStorage.getItem('ta_diff') || 'null'); } catch (e) { s = null; }
    if (!s) return;
    if (s.sel === 'custom' || BOT_SKILL[s.sel]) sel = s.sel;
    if (s.custom) BOT_KNOB_GROUPS.forEach(function (g) { if (typeof s.custom[g.key] === 'number') custom[g.key] = s.custom[g.key]; });
    if (typeof s.botCount === 'number') botCount = s.botCount;
  }

  function tile(key, name, blurb, filled, cls) {
    var b = document.createElement('button');
    b.className = 'pk-tile' + (cls ? ' ' + cls : '');
    b.dataset.key = key;
    b.style.setProperty('--c', { easy: '#00E16E', medium: '#00B2E1', hard: '#F8A231', veryhard: '#F14E54' }[key] || '#8A8A8A');
    var pips = '';
    for (var i = 0; i < 5; i++) pips += '<i class="' + (i < filled ? 'f' : '') + '"></i>';
    b.innerHTML = '<span class="pk-name">' + name + '</span><span class="pk-desc">' + blurb +
      '</span><span class="pk-pips">' + pips + '</span>';
    b.addEventListener('click', function () { sel = key; syncPicker(); });
    return b;
  }

  function buildPicker() {
    BOT_DIFFICULTIES.forEach(function (k, i) {
      presetBox.appendChild(tile(k, BOT_SKILL[k].label, DIFF_BLURB[k], i + 1, k === 'extreme' ? 'x' : ''));
    });
    presetBox.appendChild(tile('custom', 'Custom', 'Set all six dials yourself.', 0, 'custom'));

    BOT_DIFFICULTIES.forEach(function (k) {
      var b = document.createElement('button');
      b.textContent = BOT_SKILL[k].label;
      b.addEventListener('click', function () {
        BOT_KNOB_GROUPS.forEach(function (g) { custom[g.key] = DIFF_SEED[k]; });
        syncPicker();
      });
      seedBox.appendChild(b);
    });
    seedBox.insertBefore(Object.assign(document.createElement('span'), {
      textContent: 'start from:', style: 'align-self:center;font-size:12px;color:#555;font-weight:bold'
    }), seedBox.firstChild);

    BOT_KNOB_GROUPS.forEach(function (grp) { knobBox.appendChild(knob(grp.key, grp.label, grp.blurb, 0, 10, 0.5)); });
    knobBox.appendChild(knob('botCount', 'Bot count', 'how many of them are out there', 0, 160, 1));
  }

  function knob(key, label, blurb, min, max, step) {
    var row = document.createElement('div');
    row.className = 'pk-knob';
    row.innerHTML = '<label>' + label + '<small>' + blurb + '</small></label>' +
      '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '"><output></output>';
    var input = row.querySelector('input'), out = row.querySelector('output');
    input.addEventListener('input', function () {
      if (key === 'botCount') botCount = +input.value; else custom[key] = +input.value;
      sel = 'custom';
      syncPicker();
    });
    row.sync = function () {
      input.value = key === 'botCount' ? botCount : custom[key];
      out.textContent = input.value;
    };
    return row;
  }

  function syncPicker() {
    var tiles = presetBox.children;
    for (var i = 0; i < tiles.length; i++) tiles[i].classList.toggle('on', tiles[i].dataset.key === sel);
    customBox.classList.toggle('on', sel === 'custom');
    for (var k = 0; k < knobBox.children.length; k++) knobBox.children[k].sync();
    // the custom tile's pips track the average of the six dials
    var avg = 0;
    BOT_KNOB_GROUPS.forEach(function (g) { avg += custom[g.key]; });
    avg = avg / BOT_KNOB_GROUPS.length;
    var pips = tiles[tiles.length - 1].querySelectorAll('.pk-pips i');
    for (var p = 0; p < pips.length; p++) pips[p].classList.toggle('f', p < Math.round(avg / 2));
    diffName.textContent = diffLabel();
    saveDiff();
  }

  function openPicker() { picker.classList.add('open'); syncPicker(); }
  function closePicker() { picker.classList.remove('open'); }

  document.getElementById('pk-back').addEventListener('click', closePicker);
  document.getElementById('pk-play').addEventListener('click', startOffline);
  document.getElementById('diffedit').addEventListener('click', openPicker);

  var settings = document.getElementById('settings');
  document.getElementById('settingsBtn').addEventListener('click', function () { settings.classList.add('open'); });
  document.getElementById('set-back').addEventListener('click', function () { settings.classList.remove('open'); });

  window.addEventListener('keydown', function (e) {
    if (settings.classList.contains('open')) {
      if (e.key === 'Escape') { settings.classList.remove('open'); e.preventDefault(); }
      return;
    }
    if (!picker.classList.contains('open')) return;
    if (e.key === 'Escape') { closePicker(); e.preventDefault(); }
    else if (e.key === 'Enter') { startOffline(); e.preventDefault(); }
  });

  function startOnline() {
    saveName();
    var url = serverInput.value.trim() || defaultServer();
    if (!/^wss?:\/\//.test(url)) url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + url;
    setStatus('Connecting…');
    onlineBtn.disabled = true;
    var n = new NetGame(url, nameInput.value.trim(), modeSelect.value, {
      onReady: function () {
        onlineBtn.disabled = false;
        setStatus('');
        if (!running) { online = true; net = n; beginRender(n); }
      },
      onError: function (msg) {
        onlineBtn.disabled = false;
        setStatus(msg + ' — is the server running? (npm start)');
        if (running) leave();
      }
    });
  }

  function defaultServer() {
    if (location.protocol === 'file:') return 'ws://localhost:8137';
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  }

  function leave() {
    running = false;
    if (simTimer) { clearInterval(simTimer); simTimer = 0; }
    if (net) { net.close(); net = null; }
    online = false;
    CHAT.hide();
    menu.style.display = '';
    startBackdrop();
  }

  function setStatus(msg) { status.textContent = msg; }

  playBtn.addEventListener('click', openPicker);
  onlineBtn.addEventListener('click', startOnline);
  nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') openPicker(); });

  try {
    nameInput.value = localStorage.getItem('ta_name') || '';
    serverInput.value = localStorage.getItem('ta_server') || '';
  } catch (e) { /* ignore */ }
  if (!serverInput.value) serverInput.value = defaultServer();

  Object.keys(GAMEMODES).forEach(function (k) {
    var o = document.createElement('option');
    o.value = k; o.textContent = GAMEMODES[k].name;
    modeSelect.appendChild(o);
  });

  loadDiff();
  buildPicker();
  syncPicker();
  startBackdrop();
  hint.textContent = TANK_DEFS.filter(Boolean).length + ' tank classes loaded';
})();
