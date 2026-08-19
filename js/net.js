// net.js — client-side mirror of the server's world.
//
// It rebuilds a Game-shaped object from snapshots, so render.js draws an online
// match with exactly the same code it uses offline. The client owns nothing:
// it sends inputs and interpolates what comes back.

function NetGame(url, name, mode, hooks) {
  this.url = url;
  this.name = name;
  this.modeKey = mode;
  this.hooks = hooks || {};
  this.connected = false;

  // --- the Game-shaped surface render.js reads ---
  this.tick = 0;
  this.mode = GAMEMODES[mode] || GAMEMODES.ffa;
  this.arena = { left: -11150, right: 11150, top: -11150, bottom: 11150, size: 22300 };
  this.entities = [];
  this.leaderboard = [];
  this.notifications = [];
  this.walls = [];
  this.bases = [];
  this.leader = null;
  this.player = this.blankPlayer();

  this.byId = new Map();
  this.overlay = [];
  this.myId = 0;
  this.lastPacket = 0;
  this.pingSentAt = 0;
  this.ping = 0;

  this.connect();
}

NetGame.prototype.blankPlayer = function () {
  var p = {
    id: 0, type: 'tank', x: 0, y: 0, px: 0, py: 0, angle: 0, pa: 0, size: 50, psize: 50,
    sides: 1, fill: C.blue, stroke: C.blueS, opacity: 1,
    tankId: 0, def: TANK_DEFS[0], level: 1, score: 0,
    stats: [0, 0, 0, 0, 0, 0, 0, 0], statsAvailable: 0, queued: [],
    pendingUpgrades: [], autoFire: false, autoSpin: false,
    dead: false, killedBy: null, spawnTick: 0, kills: 0,
    health: 1, maxHealth: 1, hurtFlash: 0, damageReduction: 1,
    scaleFactor: 1, guardAngle: 0, barrels: [], turrets: [],
    fov: 0.35, input: { up: 0, down: 0, left: 0, right: 0, fire: 0, altFire: 0 },
    mouse: { x: 0, y: 0 }
  };
  return p;
};

NetGame.prototype.connect = function () {
  var self = this;
  var ws;
  try { ws = new WebSocket(this.url); } catch (e) { this.fail('Bad server address'); return; }
  this.ws = ws;
  ws.binaryType = 'arraybuffer';

  ws.onopen = function () {
    self.connected = true;
    var b = new Buf(128);
    b.u8(OP.JOIN); b.str(self.name); b.str(self.modeKey);
    ws.send(b.bytes());
    if (self.hooks.onOpen) self.hooks.onOpen();
  };
  ws.onmessage = function (ev) {
    try { self.read(new Buf(new Uint8Array(ev.data))); }
    catch (e) { console.warn('bad packet', e); }
  };
  ws.onclose = function () { self.connected = false; self.fail('Disconnected from server'); };
  ws.onerror = function () { /* onclose follows */ };
};

NetGame.prototype.fail = function (msg) {
  if (this.failed) return;
  this.failed = true;
  if (this.hooks.onError) this.hooks.onError(this.closeNotice || msg);
};

NetGame.prototype.read = function (b) {
  var op = b.ru8();
  if (op === SV.WELCOME) return this.readWelcome(b);
  if (op === SV.UPDATE) return this.readUpdate(b);
  if (op === SV.NOTIFY) {
    var txt = b.rstr();
    // remember why we are about to be dropped, so the menu can say so
    if (/closed/i.test(txt)) this.closeNotice = txt;
    this.notifications.push({ text: txt, ttl: 100 });
    return;
  }
  if (op === SV.DEATH) return this.readDeath(b);
  if (op === SV.MAPSTATE) return this.readMapState(b);
  if (op === SV.CHAT) {
    var kind = CHATKIND[b.ru8()] || 'system';
    var who = b.rstr(), text = b.rstr();
    CHAT.push(kind, who, text, rgb(b.ru8(), b.ru8(), b.ru8()));
    return;
  }
};

// Objective overlay for the minimap: tiles, dominators, motherships, flags.
NetGame.prototype.readMapState = function (b) {
  var n = b.ru16(), out = [];
  for (var i = 0; i < n; i++) {
    out.push({
      x: b.ri16(), y: b.ri16(), w: b.ru16(), h: b.ru16(),
      kind: b.ru8(), fill: rgb(b.ru8(), b.ru8(), b.ru8())
    });
  }
  this.overlay = out;
};

NetGame.prototype.readWelcome = function (b) {
  this.modeKey = b.rstr();
  this.mode = GAMEMODES[this.modeKey] || GAMEMODES.ffa;
  var size = b.rf32(), h = size / 2;
  this.arena = { left: -h, right: h, top: -h, bottom: h, size: size };
  this.myId = b.ru32();
  var n = b.ru16(), i;
  this.walls = [];
  for (i = 0; i < n; i++) this.walls.push({ x: b.ri16(), y: b.ri16(), size: b.ru16(), width: b.ru16() });
  n = b.ru16();
  this.bases = [];
  for (i = 0; i < n; i++) {
    var base = { x: b.ri16(), y: b.ri16(), size: b.ru16(), width: b.ru16() };
    base.fill = rgb(b.ru8(), b.ru8(), b.ru8());
    this.bases.push(base);
  }
  this.player.dead = false;
  this.player.killedBy = null;
  this.byId.clear();
  if (this.hooks.onReady) this.hooks.onReady();
};

function rgb(r, g, b) { return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1); }

NetGame.prototype.readDeath = function (b) {
  var p = this.player;
  p.killedBy = b.rstr();
  p.score = b.ru32();
  p.level = b.ru8();
  p.tankId = b.ru8();
  p.def = TANK_DEFS[p.tankId] || TANK_DEFS[0];
  var alive = b.ru32();
  p.spawnTick = this.tick - alive;
  p.kills = b.ru8();
  p.dead = true;
  p.queued.length = 0;
};

NetGame.prototype.readUpdate = function (b) {
  var i, n, id;
  this.tick = b.ru32();
  this.myId = b.ru32();
  var fov = b.rf32();
  var camX = b.ri16(), camY = b.ri16();
  var p = this.player;
  p.fov = fov;

  var alive = b.ru8();
  if (alive) {
    p.dead = false;
    p.score = b.ru32();
    p.level = b.ru8();
    p.tankId = b.ru8();
    p.def = TANK_DEFS[p.tankId] || TANK_DEFS[0];
    p.statsAvailable = b.ru8();
    for (i = 0; i < 8; i++) p.stats[i] = b.ru8();
    n = b.ru8();
    p.pendingUpgrades = [];
    for (i = 0; i < n; i++) p.pendingUpgrades.push(b.ru8());
    p.autoFire = !!b.ru8();
    p.autoSpin = !!b.ru8();
    p.spawnTick = b.ru32();
    p.kills = b.ru8();
    p.scaleFactor = Math.pow(1.01, p.level - 1);
    // drop queued points the server has already granted
    while (p.queued.length && p.statsAvailable === 0) p.queued.shift();
  }

  // /view: the build of whoever we are watching. Just enough of a tank for the
  // stat panel to lay out and grey — it is read-only, so nothing else is needed.
  this.watched = null;
  if (b.ru8()) {
    var wid = b.ru8(), wlvl = b.ru8(), ws = [];
    for (i = 0; i < 8; i++) ws.push(b.ru8());
    this.watched = {
      tankId: wid, def: TANK_DEFS[wid] || TANK_DEFS[0], level: wlvl,
      stats: ws, statsAvailable: 0, queued: [], dead: false
    };
  }

  // leaderboard
  n = b.ru8();
  this.leaderboard = [];
  for (i = 0; i < n; i++) {
    var name = b.rstr(), score = b.ru32(), tankId = b.ru8(), lid = b.ru32();
    var fill = rgb(b.ru8(), b.ru8(), b.ru8());
    this.leaderboard.push({ name: name, score: score, tankId: tankId, id: lid, fill: fill, team: null });
  }
  this.leader = null;
  if (b.ru8()) {
    var lx = b.ri16(), ly = b.ri16(), leaderId = b.ru32();
    this.leader = { x: lx, y: ly, id: leaderId, dead: false };
  }

  // deletes / creates / updates
  n = b.ru16();
  for (i = 0; i < n; i++) { id = b.ru32(); this.byId.delete(id); }
  n = b.ru16();
  for (i = 0; i < n; i++) this.create(b);
  n = b.ru16();
  for (i = 0; i < n; i++) this.update(b);

  // mirror our own tank's transform onto the HUD player object
  var mine = this.byId.get(this.myId);
  if (mine) {
    p.px = p.x; p.py = p.y; p.pa = p.angle;
    p.x = mine.x; p.y = mine.y; p.angle = mine.angle; p.size = mine.size;
    p.fill = mine.fill; p.stroke = mine.stroke;
  } else if (!alive) {
    p.x = camX; p.y = camY;
  }
  if (this.leader && this.leader.id === this.myId) this.leader = null;

  this.entities = Array.from(this.byId.values());
  var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // Track how far apart snapshots actually land. A server running a hair slow
  // than MSPT leaves the lerp pinned at 1 for the tail of every tick, which
  // reads as a stutter on every other tank.
  if (this.lastPacket) {
    var gap = now - this.lastPacket;
    // The window is wide enough to cover a /timewarp-slowed arena, which sends a
    // snapshot only on the ticks it actually stepped. A one-off hitch still gets
    // in, but the 0.9 EMA walks it back out within a second.
    if (gap < MSPT * 24) this.packetDt = this.packetDt ? this.packetDt * 0.9 + gap * 0.1 : gap;
  }
  this.lastPacket = now;
};

// Unpack the per-entity flag byte. `team` is only ever compared against null
// client-side (unclaimed tile vs owned), so a placeholder stands in for "owned".
function applyFlags(e, ef) {
  e.damageReduction = (ef & 1) ? 0 : 1;
  e.hurtFlash = (ef & 2) ? 3 : 0;
  e.isStar = !!(ef & 4);
  e.dead = !!(ef & 8);
  e.warning = !!(ef & 16);
  e.team = (ef & 32) ? null : 'owned';
  e.rainbow = !!(ef & 64);          // /rainbow, cycled in the renderer
}

NetGame.prototype.create = function (b) {
  var e = {};
  e.id = b.ru32();
  e.type = ETYPES[b.ru8()] || 'bullet';
  e.sides = b.ru8();
  var flags = b.ru8();
  var isTank = !!(flags & 1), hasName = !!(flags & 2), isRect = !!(flags & 4);
  e.x = b.ri16(); e.y = b.ri16();
  e.angle = unpackAngle(b.ru8());
  e.size = b.ru16() / 4;
  e.fill = rgb(b.ru8(), b.ru8(), b.ru8());
  e.stroke = rgb(b.ru8(), b.ru8(), b.ru8());
  e.maxHealth = 1;
  e.health = b.ru8() / 255;
  e.opacity = b.ru8() / 255;
  var ef = b.ru8();
  applyFlags(e, ef);

  if (isTank) {
    var idOrBoss = b.ru8();
    e.level = b.ru8();
    var scale = b.ru16() / 1024;
    if (e.type === 'boss') this.attachBoss(e, idOrBoss);
    else this.attachTank(e, idOrBoss);
    e.scaleFactor = scale;            // attach* seeds it; the server has the last word
  } else {
    e.scaleFactor = 1;
  }
  if (isRect) e.width = b.ru16() / 4;
  if (hasName) { e.name = b.rstr(); e.score = b.ru32(); }
  this.readTurretAngles(b, e);

  e.hiddenHealthbar = !isTank && e.type !== 'shape' && e.type !== 'skimmer' && e.type !== 'rocket' && e.type !== 'glider' && e.type !== 'firework';
  e.guardAngle = 0;
  e.px = e.x; e.py = e.y; e.pa = e.angle; e.psize = e.size;
  this.byId.set(e.id, e);
  return e;
};

NetGame.prototype.attachTank = function (e, tankId) {
  e.tankId = tankId;
  e.def = TANK_DEFS[tankId] || TANK_DEFS[0];
  e.scaleFactor = Math.pow(1.01, (e.level || 1) - 1);
  e.barrels = e.def.barrels.map(function (d) { return { def: d, recoilAnim: 0 }; });
  e.turrets = buildTurrets(e, turretCount(TANK_DEFS, ADDONS, tankId));
};

NetGame.prototype.attachBoss = function (e, bossIndex) {
  var spec = BOSSES[bossIndex] || BOSSES[0];
  e.bossIndex = bossIndex;
  e.def = null;                                    // bosses are not tank defs
  e.scaleFactor = spec.sides === 1 ? spec.size / 50 : 1;
  var defs = spec.tankId !== undefined ? TANK_DEFS[spec.tankId].barrels : spec.barrels;
  e.barrels = defs.map(function (d) { return { def: d, recoilAnim: 0 }; });
  e.turrets = buildTurrets(e, spec.turrets || 0);
};

function buildTurrets(parent, count) {
  var out = [];
  for (var i = 0; i < count; i++) {
    out.push({
      parent: parent, index: i, arc: count > 1,
      base: count === 1 ? 0 : (Math.PI * 2 * i) / count,
      angle: 0,                                      // the renderer mounts these off the parent pose
      barrel: { def: TURRET_BARREL, recoilAnim: 0 }
    });
  }
  return out;
}

NetGame.prototype.readTurretAngles = function (b, e) {
  if (e.type !== 'tank' || !e.turrets || !e.turrets.length) return;
  for (var i = 0; i < e.turrets.length; i++) e.turrets[i].angle = unpackAngle(b.ru8());
};

NetGame.prototype.update = function (b) {
  var id = b.ru32();
  var e = this.byId.get(id);
  // Read the record whether or not we know the entity, so the stream stays aligned.
  var x = b.ri16(), y = b.ri16(), ang = unpackAngle(b.ru8());
  var size = b.ru16() / 4, health = b.ru8() / 255, opacity = b.ru8() / 255, ef = b.ru8();
  var isTank = e ? (e.type === 'tank' || e.type === 'boss') : false;
  var level = null;
  var scale = null;
  var idOrBoss = null;
  if (e && isTank) { idOrBoss = b.ru8(); level = b.ru8(); scale = b.ru16() / 1024; }
  if (e && e.name) e.score = b.ru32();
  if (!e) return;                       // unknown id: turret angles can't be sized, bail

  e.px = e.x; e.py = e.y; e.pa = e.angle; e.psize = e.size;
  e.x = x; e.y = y; e.angle = ang; e.size = size;
  e.health = health; e.opacity = opacity;
  applyFlags(e, ef);
  if (level !== null) e.level = level;
  // A class change (upgrade, /class) keeps the same entity id, so rebuild the
  // barrels, body shape and turrets here — before the turret angles are read,
  // since their count comes from the new class.
  if (idOrBoss !== null && e.type === 'tank' && idOrBoss !== e.tankId) {
    this.attachTank(e, idOrBoss);
    e.sides = e.def.sides;
  }
  if (scale !== null) e.scaleFactor = scale;
  this.readTurretAngles(b, e);
};

// --- outbound ------------------------------------------------------------
NetGame.prototype.sendInput = function (input, mouse, extra) {
  if (!this.connected) return;
  var bits = 0;
  if (input.fire) bits |= IN.FIRE;
  if (input.up) bits |= IN.UP;
  if (input.left) bits |= IN.LEFT;
  if (input.down) bits |= IN.DOWN;
  if (input.right) bits |= IN.RIGHT;
  if (input.altFire) bits |= IN.ALTFIRE;
  if (extra && extra.suicide) bits |= IN.SUICIDE;
  if (extra && extra.god) bits |= IN.GOD;
  if (extra && extra.levelup) bits |= IN.LEVELUP;
  var b = new Buf(16);
  b.u8(OP.INPUT); b.u16(bits);
  b.i16(clamp16(mouse.x)); b.i16(clamp16(mouse.y));
  this.ws.send(b.bytes());
};
function clamp16(v) { return Math.max(-32768, Math.min(32767, Math.round(v || 0))); }

NetGame.prototype.send1 = function (op, value) {
  if (!this.connected) return;
  var b = new Buf(4);
  b.u8(op); b.u8(value);
  this.ws.send(b.bytes());
};
NetGame.prototype.upgradeStat = function (wire) { this.send1(OP.STAT, wire); };
NetGame.prototype.upgradeTo = function (tankId) { this.send1(OP.UPGRADE, tankId); };
NetGame.prototype.toggle = function (which) { this.send1(OP.TOGGLE, which); };
NetGame.prototype.possess = function () { this.send1(OP.POSSESS, 0); };
NetGame.prototype.sendChat = function (text) {
  if (!this.connected) return;
  var b = new Buf(4 + 3 * CHAT_MAX);
  b.u8(OP.CHAT); b.str(text);
  this.ws.send(b.bytes());
};
NetGame.prototype.respawn = function () {
  if (!this.connected) return;
  var b = new Buf(2); b.u8(OP.RESPAWN);
  this.ws.send(b.bytes());
};

// Called every animation frame: age notifications and spin guard shells locally.
NetGame.prototype.clientTick = function () {
  for (var i = this.notifications.length - 1; i >= 0; i--)
    if (--this.notifications[i].ttl <= 0) this.notifications.splice(i, 1);
  for (var j = 0; j < this.entities.length; j++) {
    var e = this.entities[j];
    if (e.guardAngle !== undefined) e.guardAngle += 1;
  }
};

// Fraction of a tick since the last snapshot, for render interpolation.
// ponytail: single-snapshot lerp (~40ms behind). A multi-snapshot buffer would
// ride out jitter better; add one if packet loss becomes visible.
NetGame.prototype.alpha = function () {
  var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return Math.max(0, Math.min(1, (now - this.lastPacket) / (this.packetDt || MSPT)));
};

NetGame.prototype.close = function () { this.failed = true; if (this.ws) try { this.ws.close(); } catch (e) {} };

if (typeof module !== 'undefined') module.exports = { NetGame: NetGame };
