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
    if (!running) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
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
      case 'k': cheats.levelup = true; if (!online && game.mode.sandbox && p) p.addScore(Math.max(5, LEVEL_SCORE[Math.min(MAX_LEVEL, p.level + 1)] - p.score + 1)); break;
      case ';':
        cheats.god = !cheats.god;
        if (!online && game.mode.sandbox && p) { p.godMode = !p.godMode; game.notify('God mode ' + (p.godMode ? 'ON' : 'OFF'), 50); }
        break;
      case '\\': if (!online && game.mode.sandbox && p) cycleTank(p); break;
      case 'Escape': leave(); break;
      case ' ': e.preventDefault(); break;
    }
  });

  window.addEventListener('keyup', function (e) {
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

  canvas.addEventListener('mousemove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; });
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
    var cards = renderer.upgradeRects(), i;
    for (i = 0; i < cards.length; i++) {
      var r = cards[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { doUpgrade(r.id); return true; }
    }
    var stats = renderer.statRects();
    for (i = 0; i < stats.length; i++) {
      var s = stats[i];
      if (x >= s.x && x <= s.x + s.w + 6 + s.h * 1.35 && y >= s.y && y <= s.y + s.h) { doStat(s.wire); return true; }
    }
    return false;
  }

  function readKeys() {
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

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (!last) last = now;
    var dt = Math.min(250, now - last);
    last = now;
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
      renderer.updateCamera(dt);
      renderer.render(net.alpha());
      return;
    }

    acc += dt;
    var steps = 0;
    while (acc >= MSPT && steps < 5) {
      var lp = game.player;
      if (lp && !lp.dead) {
        var ctrl = (lp.possessing && !lp.possessing.dead) ? lp.possessing : lp;
        ctrl.input.up = localInput.up; ctrl.input.down = localInput.down;
        ctrl.input.left = localInput.left; ctrl.input.right = localInput.right;
        ctrl.input.fire = localInput.fire; ctrl.input.altFire = localInput.altFire;
        var mw = mouseWorld();
        ctrl.mouse.x = mw.x; ctrl.mouse.y = mw.y;
      }
      game.step();
      acc -= MSPT; steps++;
    }
    if (steps === 5) acc = 0;
    flushQueue();
    renderer.updateCamera(dt);
    renderer.render(acc / MSPT);
  }

  // ---------------------------------------------------------------- start
  function beginRender(g) {
    game = g;
    renderer = new Renderer(canvas, g);
    if (g.player) { renderer.cam.x = g.player.x; renderer.cam.y = g.player.y; }
    menu.style.display = 'none';
    running = true; last = 0; acc = 0; netAcc = 0;
    requestAnimationFrame(frame);
  }

  function saveName() {
    try { localStorage.setItem('ta_name', nameInput.value.trim()); localStorage.setItem('ta_server', serverInput.value.trim()); } catch (e) { /* private mode */ }
  }

  function startOffline() {
    online = false; net = null;
    saveName();
    setStatus('');
    beginRender(new Game(modeSelect.value, nameInput.value.trim()));
  }

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
    if (net) { net.close(); net = null; }
    online = false;
    menu.style.display = '';
  }

  function setStatus(msg) { status.textContent = msg; }

  playBtn.addEventListener('click', startOffline);
  onlineBtn.addEventListener('click', startOnline);
  nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') startOffline(); });

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
  hint.textContent = TANK_DEFS.filter(Boolean).length + ' tank classes loaded';
})();
