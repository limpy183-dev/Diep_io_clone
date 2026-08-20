// server.js — authoritative game server. `node server.js [port]`
//
// The client owns nothing: it sends inputs and draws snapshots. All damage,
// XP, levelling, stat spending and class upgrades happen here.
//
// One arena per game mode, created on first join and torn down when empty.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { WebSocketServer } = require('ws');

const P = require('./js/protocol.js');
const { OP, SV, IN, ETYPES, Buf, MAX_PACKET, CHATKIND, packAngle, turretCount } = P;

// ---- load the simulation ------------------------------------------------
// Same trick the tests use: the engine is plain browser script with no browser
// globals, so one shared context is all it needs. No bundler, no duplication.
const sim = vm.createContext({ console, Math, JSON, Map, Set, Infinity, NaN });
for (const f of ['js/tankdefs.js', 'js/tankdefs-extra.js', 'js/data.js', 'js/engine.js', 'js/modes.js', 'js/commands.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sim, { filename: f });

const { Game, GAMEMODES, TANK_DEFS, ADDONS, MSPT, MAX_LEVEL } = sim;
// The command table runs against the sim's own globals, so it comes from there too.
const { COMMANDS, runCommand, chatLines, sanitizeName, sanitizeChat, cheatsOK } = sim;

const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8137;
const CLOSE_AFTER = Number(process.argv[3]) || 0;   // seconds until the server retires itself
const TICK_MS = MSPT;
const CLOSE_LINGER_MS = 5000;      // how long the CLOSED banner sits before the arena retires
const MAX_PLAYERS_PER_ARENA = 50;
const MSG_RATE_LIMIT = 120;        // messages per second per client

// ---- static hosting so one process serves the game and the sockets -------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const httpServer = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(__dirname, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(__dirname)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- arenas -------------------------------------------------------------
// `arenas` routes joins (one live arena per mode); `allArenas` is everything
// still ticking, including arenas that are closing and no longer accept joins.
const arenas = new Map();
const allArenas = new Set();
let shuttingDown = false;

function getArena(modeKey) {
  if (!GAMEMODES[modeKey]) modeKey = 'ffa';
  let a = arenas.get(modeKey);
  if (a && !a.game.closing) return a;
  a = {
    mode: modeKey,
    // Multiplayer arenas are humans only. /bots can still add them on purpose.
    game: new Game(modeKey, null, { headless: true, botCount: 0 }),
    clients: new Set(),
    timer: null,
    idle: 0,
    finished: false
  };
  a.game.onPlayerDeath = (tank) => {
    const c = tank.client;
    if (!c || !c.alive) return;
    if (!c.viewing) c.spectate = tank.killerEntity || null;
    sendDeath(c, tank);
    // Dying in a closing arena moves you off it: there is nothing to respawn into.
    if (a.game.closing) evict(c, 'This arena has closed — press Play to join a new one');
  };
  a.timer = setInterval(() => tickArena(a), TICK_MS);
  arenas.set(modeKey, a);
  allArenas.add(a);
  console.log(`[arena] ${modeKey} created`);
  return a;
}

function closeArena(a) {
  if (a.game.closing) return;
  const n = a.game.close();
  if (arenas.get(a.mode) === a) arenas.delete(a.mode);   // joins now open a fresh one
  console.log(`[arena] ${a.mode} closing (${n} arena closers)`);
}

function evict(client, message) {
  sendNotify(client, message);
  setTimeout(() => { try { client.ws.close(); } catch (e) { /* already gone */ } }, 1500);
}

function dropArena(a, force) {
  if (!force && a.clients.size > 0) return;
  clearInterval(a.timer);
  if (arenas.get(a.mode) === a) arenas.delete(a.mode);
  allArenas.delete(a);
  console.log(`[arena] ${a.mode} released`);
  if (shuttingDown && allArenas.size === 0) {
    console.log('all arenas closed, exiting');
    process.exit(0);
  }
}

// ---- per-client view ----------------------------------------------------
// Linear scan over entities. At ~1100 entities x 50 clients that is 55k box
// tests per tick, well inside budget.
// ponytail: swap to a hash-grid range query if client counts grow past ~100.
// While piloting a Dominator or Mothership, the camera and inputs follow that
// entity instead of your parked tank.
function controlled(client) {
  const t = client.tank;
  if (t && t.possessing && !t.possessing.dead) return t.possessing;
  return t;
}

// Whose eyes you are borrowing: /view picks one on purpose, and dying puts you
// behind your killer until it dies too. Never what your inputs drive — that
// stays `controlled`, or /view would let you fly somebody else's tank.
function watching(client) {
  const s = client.spectate;
  if (!s || s.dead) return null;
  return (client.viewing || (client.tank && client.tank.dead)) ? s : null;
}
function cameraOf(client) { return watching(client) || controlled(client); }

// Death snaps the view to 0.4 regardless of whose tank the camera is riding.
function fovOf(client) {
  const t = client.tank;
  if (!t || t.dead) return 0.4;
  const c = cameraOf(client);
  return c && !c.dead ? c.fov : 0.4;
}

function viewOf(client) {
  const fov = fovOf(client);
  return {
    x: client.camX, y: client.camY,
    hw: (1920 / fov) / 1.5, hh: (1080 / fov) / 1.5
  };
}

function visible(e, v) {
  if (e.sides === 0) return false;
  if (e.opacity !== undefined && e.opacity <= 0 && e.type === 'tank') return false;  // never send invisible tanks
  const r = e.sides === 2 ? Math.max(e.size, e.width) : e.size;
  return Math.abs(e.x - v.x) <= v.hw + r && Math.abs(e.y - v.y) <= v.hh + r;
}

function healthByte(e) {
  if (!e.maxHealth || !isFinite(e.maxHealth)) return 255;
  return Math.max(0, Math.min(255, Math.round((e.health / e.maxHealth) * 255)));
}

function entityFlags(e) {
  let f = 0;
  if (e.damageReduction === 0) f |= 1;      // spawn protection / god mode blink
  if (e.hurtFlash > 0) f |= 2;
  if (e.isStar) f |= 4;
  if (e.dead) f |= 8;
  if (e.warning) f |= 16;                   // Breakout tile about to collapse
  if (e.team === null) f |= 32;             // unclaimed tile / neutral Dominator
  if (e.rainbow || (e.owner && e.owner.rainbow)) f |= 64;   // /rainbow: the client cycles the hue
  return f;
}

// scaleFactor drives barrel length and bullet size, and /size moves it off the
// level curve, so it ships rather than being re-derived from the level.
function scaleWord(e) {
  return Math.max(1, Math.min(65535, Math.round((e.scaleFactor || 1) * 1024)));
}

// Every human spawns blue server-side, so colour is a per-viewer decision:
// in FFA you are blue and everyone else is red, exactly as offline. Team modes
// paint their own colours and are left alone.
function viewFill(e, client) {
  if (e.fill !== sim.C.blue) return null;              // team-painted, shape, boss: as-is
  let root = e;
  while (root.owner) root = root.owner;                // bullets/drones follow their tank
  if (client.tank && root === client.tank) return null;
  return [sim.C.red, sim.C.redS];
}

function writeCreate(b, e, client) {
  b.u32(e.id);
  b.u8(Math.max(0, ETYPES.indexOf(e.type)));
  b.u8(e.sides);
  const isTank = e.type === 'tank' || e.type === 'boss';
  b.u8((isTank ? 1 : 0) | (e.name ? 2 : 0) | (e.sides === 2 ? 4 : 0));
  b.i16(Math.round(e.x)); b.i16(Math.round(e.y));
  b.u8(packAngle(e.angle));
  b.u16(Math.min(65535, Math.round(e.size * 4)));
  const swap = viewFill(e, client);
  const fill = hex(swap ? swap[0] : e.fill), stroke = hex(swap ? swap[1] : e.stroke);
  b.u8(fill[0]); b.u8(fill[1]); b.u8(fill[2]);
  b.u8(stroke[0]); b.u8(stroke[1]); b.u8(stroke[2]);
  b.u8(healthByte(e));
  b.u8(Math.round((e.opacity === undefined ? 1 : e.opacity) * 255));
  b.u8(entityFlags(e));
  // Bosses carry a boss-table index instead of a tank id; the client rebuilds
  // their barrels from the same BOSSES table.
  if (isTank) { b.u8(e.type === 'boss' ? (e.bossIndex | 0) : (e.tankId === undefined ? 0 : e.tankId)); b.u8(Math.min(255, e.level || 1)); b.u16(scaleWord(e)); }
  if (e.sides === 2) b.u16(Math.min(65535, Math.round(e.width * 4)));
  if (e.name) { b.str(e.name); b.u32(Math.max(0, e.score | 0)); }
  writeTurrets(b, e);
}

function writeUpdate(b, e) {
  b.u32(e.id);
  b.i16(Math.round(e.x)); b.i16(Math.round(e.y));
  b.u8(packAngle(e.angle));
  b.u16(Math.min(65535, Math.round(e.size * 4)));
  b.u8(healthByte(e));
  b.u8(Math.round((e.opacity === undefined ? 1 : e.opacity) * 255));
  b.u8(entityFlags(e));
  // The class id rides every update, not just the create: upgrading (or /class)
  // mutates a tank the client has already seen, and without it the old barrels,
  // body shape and turret count stick around forever.
  if (e.type === 'tank' || e.type === 'boss') { b.u8(e.type === 'boss' ? (e.bossIndex | 0) : (e.tankId === undefined ? 0 : e.tankId)); b.u8(Math.min(255, e.level || 1)); b.u16(scaleWord(e)); }
  if (e.name) b.u32(Math.max(0, e.score | 0));
  writeTurrets(b, e);
}

// Turret count is derived from the tank table on both ends, so only angles ship.
function writeTurrets(b, e) {
  if (e.type !== 'tank' || !e.turrets) return;
  const n = turretCount(TANK_DEFS, ADDONS, e.tankId);
  for (let i = 0; i < n; i++) b.u8(packAngle(e.turrets[i] ? e.turrets[i].angle : 0));
}

const hexCache = new Map();
function hex(h) {
  let v = hexCache.get(h);
  if (v) return v;
  const n = parseInt(String(h || '#000000').slice(1), 16);
  v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  hexCache.set(h, v);
  return v;
}

function sendUpdate(client, arena) {
  const g = arena.game, t = client.tank;
  const ctrl = cameraOf(client);
  if (ctrl && !ctrl.dead) { client.camX = ctrl.x; client.camY = ctrl.y; }
  const v = viewOf(client);

  const nowVisible = new Map();
  for (const e of g.entities) {
    if (!visible(e, v)) continue;
    nowVisible.set(e.id, e);
  }
  if (t && t.sides !== 0) nowVisible.set(t.id, t);   // always send your own tank
  if (ctrl && ctrl !== t) nowVisible.set(ctrl.id, ctrl);

  const creates = [], updates = [], deletes = [];
  for (const [id, e] of nowVisible) (client.seen.has(id) ? updates : creates).push(e);
  for (const id of client.seen) if (!nowVisible.has(id)) deletes.push(id);

  // Generous fixed buffer; entity records are bounded and we bail if we'd overflow.
  const b = new Buf(64 + creates.length * 96 + updates.length * 24 + deletes.length * 4 + 512);
  b.u8(SV.UPDATE);
  b.u32(g.tick);
  b.u32(ctrl ? ctrl.id : 0);                      // the entity the camera rides
  b.f32(fovOf(client));
  b.i16(Math.round(client.camX)); b.i16(Math.round(client.camY));

  // your own tank's HUD state
  const alive = t && !t.dead;
  b.u8(alive ? 1 : 0);
  if (alive) {
    b.u32(Math.max(0, Math.round(t.score)));
    b.u8(t.level);
    b.u8(t.tankId);
    b.u8(t.statsAvailable);
    for (let i = 0; i < 8; i++) b.u8(t.stats[i]);
    b.u8(t.pendingUpgrades.length);
    for (const id of t.pendingUpgrades) b.u8(id);
    b.u8(t.autoFire ? 1 : 0);
    b.u8(t.autoSpin ? 1 : 0);
    b.u32(t.spawnTick);
    b.u8(Math.min(255, t.kills));
  }

  // /view: the build of whoever you are watching, so the client can draw their
  // stat panel greyed out. Ten bytes, and only while you are deliberately
  // watching someone — dying onto your killer leaves the corner alone.
  const seen = client.viewing ? watching(client) : null;
  b.u8(seen && seen.stats ? 1 : 0);
  if (seen && seen.stats) {
    b.u8(seen.tankId === undefined ? 0 : seen.tankId);
    b.u8(Math.min(255, seen.level || 1));
    for (let i = 0; i < 8; i++) b.u8(seen.stats[i] || 0);
    // Your own parked tank: the camera rides the target, so this is the only
    // way the client still knows where to put your arrow on the minimap.
    b.i16(Math.round(t ? t.x : 0)); b.i16(Math.round(t ? t.y : 0));
    b.u8(packAngle(t ? t.angle : 0));
  }

  // Leaderboard. The arena re-ranks once a second, but scores keep moving, so
  // re-sort at send time or the rows arrive visibly out of order.
  // Objective modes replace the player list with a per-team tally (Tag shows
  // player counts, Breakout territory %, CTF captures) — same packet shape.
  let lb;
  if (g.teamCounts) {
    lb = g.teams.map((team) => ({
      name: team.charAt(0).toUpperCase() + team.slice(1),
      score: g.teamCounts[team] || 0, tankId: 0, id: 0,
      fill: sim.TEAM_COLORS[team][0]
    })).sort((p, q) => q.score - p.score);
  } else {
    lb = g.leaderboard.slice(0, 10).sort((p, q) => q.score - p.score);
  }
  b.u8(lb.length);
  for (const p of lb) {
    b.str(p.name); b.u32(Math.max(0, Math.round(p.score))); b.u8(p.tankId); b.u32(p.id);
    // Same rule as the world: your row is blue, the rest are red.
    const own = t && p.id === t.id;
    const c = hex(p.fill === sim.C.blue && !own ? sim.C.red : p.fill);
    b.u8(c[0]); b.u8(c[1]); b.u8(c[2]);
  }
  const leader = g.leader;
  b.u8(leader ? 1 : 0);
  if (leader) { b.i16(Math.round(leader.x)); b.i16(Math.round(leader.y)); b.u32(leader.id); }

  b.u16(deletes.length);
  for (const id of deletes) b.u32(id);
  b.u16(creates.length);
  for (const e of creates) writeCreate(b, e, client);
  b.u16(updates.length);
  for (const e of updates) writeUpdate(b, e);

  client.seen = new Set(nowVisible.keys());
  send(client, b.bytes());
}

function sendWelcome(client, arena) {
  const g = arena.game;
  const b = new Buf(64 + (g.walls.length + g.bases.length) * 24);
  b.u8(SV.WELCOME);
  b.str(arena.mode);
  b.f32(g.arena.size);
  b.u32(client.tank ? client.tank.id : 0);
  b.u16(g.walls.length);
  for (const w of g.walls) { b.i16(Math.round(w.x)); b.i16(Math.round(w.y)); b.u16(Math.round(w.size)); b.u16(Math.round(w.width)); }
  b.u16(g.bases.length);
  for (const s of g.bases) {
    b.i16(Math.round(s.x)); b.i16(Math.round(s.y)); b.u16(Math.round(s.size)); b.u16(Math.round(s.width));
    const c = hex(s.fill); b.u8(c[0]); b.u8(c[1]); b.u8(c[2]);
  }
  send(client, b.bytes());
}

// Objective overlay for the minimap: Breakout tiles, Dominator plinths, CTF
// flags, Motherships. Only sent when the layout changes.
function buildMapState(g) {
  const items = [];
  const push = (e, kind, w, h) => {
    const c = hex(e.fill);
    items.push({ x: Math.round(e.x), y: Math.round(e.y), w: Math.round(w), h: Math.round(h), kind, r: c[0], g: c[1], b: c[2] });
  };
  if (g.tiles) for (const t of g.tiles) push(t, t.warning ? 2 : 0, t.size, t.width);
  if (g.dominators) for (const d of g.dominators) push(d, 1, d.size, d.size);
  if (g.motherships) for (const m of g.motherships) if (!m.dead) push(m, 1, m.size, m.size);
  if (g.flags) for (const f of g.flags) push(f, 3, f.size, f.size);
  return items;
}

function sendMapState(client, g) {
  const items = buildMapState(g);
  const b = new Buf(8 + items.length * 14);
  b.u8(SV.MAPSTATE);
  b.u16(items.length);
  for (const it of items) {
    b.i16(it.x); b.i16(it.y); b.u16(it.w); b.u16(it.h);
    b.u8(it.kind); b.u8(it.r); b.u8(it.g); b.u8(it.b);
  }
  send(client, b.bytes());
}

// ---- chat ---------------------------------------------------------------
// kind indexes CHATKIND: 0 player, 1 system, 2 whisper, 3 notice.
function sendChat(client, kind, who, text, fill) {
  const c = hex(fill || '#FFFFFF');
  for (const line of chatLines(text)) {
    const b = new Buf(600);
    b.u8(SV.CHAT); b.u8(kind); b.str(who || ''); b.str(line);
    b.u8(c[0]); b.u8(c[1]); b.u8(c[2]);
    send(client, b.bytes());
  }
}

function chatAll(arena, kind, who, text, fill, from) {
  for (const c of arena.clients) if (c.alive)
    sendChat(c, kind, who, text, fill === sim.C.blue && c.tank !== from ? sim.C.red : fill);
}

// Commands run against the arena's own game, so a cheat is applied by the
// authority rather than trusted from a client. `sandbox` is the cheat gate.
function commandCtx(client, arena) {
  const g = arena.game, t = client.tank;
  return {
    game: g, tank: t, online: true,
    name: (t && t.name) || 'an unnamed tank',
    sandbox: cheatsOK(g),
    setView: (e, follow) => {
      client.followLeader = !!follow;             // /viewleader: tickArena re-points it
      if (e === client.tank) e = null;            // watching your own tank would freeze it
      client.spectate = e || null; client.viewing = !!e;
    },
    say: (text) => sendChat(client, 1, null, text, '#FFDE43'),
    broadcast: (text) => chatAll(arena, 1, null, text, '#85E8A0'),
    whisper: (name, text) => {
      if (!text) return 'Say what?';
      const to = [...arena.clients].find((c) => c.alive && c.tank && c.tank.name.toLowerCase() === String(name).toLowerCase())
        || [...arena.clients].find((c) => c.alive && c.tank && c.tank.name.toLowerCase().startsWith(String(name).toLowerCase()));
      if (!to) return 'Nobody here is called "' + name + '".';
      sendChat(to, 2, ctxName(client) + ' -> you', text, '#F177DD');
      sendChat(client, 2, 'you -> ' + ctxName(to), text, '#F177DD');
    }
  };
}
function ctxName(client) { return (client.tank && client.tank.name) || 'an unnamed tank'; }

function handleChat(client, raw) {
  const arena = client.arena;
  const now = Date.now();
  if (now - (client.lastChat || 0) < 400) return;      // one line every 400ms
  client.lastChat = now;
  const text = sanitizeChat(raw);
  if (!text) return;
  if (text[0] === '/') {
    console.log(`[cmd] ${ctxName(client)}: ${text}`);
    runCommand(commandCtx(client, arena), text);
    return;
  }
  console.log(`[chat] ${ctxName(client)}: ${text}`);
  chatAll(arena, 0, ctxName(client), text, client.tank.fill, client.tank);
}

function sendNotify(client, text) {
  const b = new Buf(300);
  b.u8(SV.NOTIFY); b.str(text);
  send(client, b.bytes());
}

function sendDeath(client, tank) {
  const b = new Buf(128);
  b.u8(SV.DEATH);
  b.str(tank.killedBy || 'an unnamed tank');
  b.u32(Math.max(0, Math.round(tank.score)));
  b.u8(tank.level);
  b.u8(tank.tankId);
  b.u32(Math.max(0, tank.game.tick - tank.spawnTick));
  b.u8(Math.min(255, tank.kills));
  send(client, b.bytes());
}

function send(client, bytes) {
  if (!client.alive || client.ws.readyState !== 1) return;
  try { client.ws.send(bytes); } catch (e) { /* socket died mid-send */ }
}

// ---- tick ---------------------------------------------------------------
function tickArena(a) {
  const g = a.game;
  // /timewarp. Sped up, one wire tick carries several sim steps and the client
  // interpolates across the bigger jump. Slowed, a tick that steps nothing sends
  // nothing either — the client measures the gap between snapshots, so the whole
  // arena simply moves in slow motion.
  a.warp = (a.warp || 0) + (g.timeScale || 1);
  const steps = Math.min(10, Math.floor(a.warp));
  a.warp -= steps;
  if (!steps) return;
  try { for (let i = 0; i < steps; i++) g.step(); } catch (err) { console.error('[sim]', err); return; }

  // Arena-wide notifications go to everyone exactly once. Mark them all before
  // the client loop, or only the first client would see them.
  const fresh = g.notifications.filter((n) => !n.sent);
  for (const n of fresh) n.sent = true;

  for (const c of a.clients) {
    if (!c.alive) continue;
    for (const n of fresh) sendNotify(c, n.text);
    if (c.tank && c.tank.notes) {
      for (const n of c.tank.notes) if (!n.sent) { n.sent = true; sendNotify(c, n.text); }
    }
    if (g.mapDirty) sendMapState(c, g);
    if (c.followLeader) {                         // /viewleader: whoever is #1 right now
      c.spectate = g.leader && g.leader !== c.tank ? g.leader : null;
      c.viewing = !!c.spectate;
    }
    sendUpdate(c, a);
  }
  g.mapDirty = false;

  // Sweep complete: everything but the closers is gone. Let the CLOSED banner
  // sit for a few seconds, then move the stragglers off and retire the arena —
  // the next join builds a fresh one (closeArena already unrouted this mode).
  if (g.closed && !a.finished) {
    a.finished = true;
    console.log(`[arena] ${a.mode} CLOSED`);
    setTimeout(() => {
      for (const c of a.clients) if (c.alive) evict(c, 'Arena CLOSED — press Play to join a new one');
      setTimeout(() => dropArena(a, true), 3000);
    }, CLOSE_LINGER_MS);
  }

  if (a.clients.size === 0 && !a.finished) { if (++a.idle > 25 * 60) dropArena(a); }
  else if (a.clients.size > 0) a.idle = 0;
}

// ---- connections --------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer, maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  const client = {
    ws, alive: true, tank: null, arena: null,
    seen: new Set(), camX: 0, camY: 0,
    msgCount: 0, windowStart: Date.now(),
    ip: (req.socket.remoteAddress || '?')
  };

  ws.binaryType = 'arraybuffer';

  ws.on('message', (data, isBinary) => {
    // rate limit
    const now = Date.now();
    if (now - client.windowStart > 1000) { client.windowStart = now; client.msgCount = 0; }
    if (++client.msgCount > MSG_RATE_LIMIT) return;
    if (!isBinary || data.byteLength > MAX_PACKET) return;
    try { handle(client, new Buf(new Uint8Array(data))); }
    catch (e) { /* malformed packet: ignore, never trust the wire */ }
  });

  ws.on('close', () => {
    client.alive = false;
    const who = ctxName(client);
    if (client.tank && !client.tank.dead) client.tank.kill(null);
    if (client.tank) client.tank.client = null;
    if (client.arena) {
      client.arena.clients.delete(client);
      chatAll(client.arena, 3, null, `${who} left`, '#85E8A0');
    }
  });
  ws.on('error', () => { client.alive = false; });
});

function handle(client, b) {
  const op = b.ru8();

  if (op === OP.JOIN) {
    if (client.arena) return;                       // one join per socket
    const name = sanitize(b.rstr());
    const mode = b.rstr();
    const arena = getArena(mode);
    if (arena.clients.size >= MAX_PLAYERS_PER_ARENA) { sendNotify(client, 'Server full'); return; }
    client.arena = arena;
    arena.clients.add(client);
    arena.idle = 0;
    spawn(client, name);
    console.log(`[join] ${name} -> ${arena.mode} (${arena.clients.size} players)`);
    chatAll(arena, 3, null, `${name || 'an unnamed tank'} joined the arena`, '#85E8A0');
    sendChat(client, 1, null, `Welcome to ${arena.game.mode.name}. Press T or Enter to chat, /help for commands.`, '#FFDE43');
    return;
  }

  if (!client.arena || !client.tank) return;
  const t = client.tank;

  switch (op) {
    case OP.INPUT: {
      if (t.dead) return;
      const bits = b.ru16();
      const mx = b.ri16(), my = b.ri16();
      const c = controlled(client);       // inputs drive whatever you are piloting
      if (watching(client)) {             // /view: you are a camera, not a driver
        c.input.fire = c.input.up = c.input.left = c.input.down = c.input.right = c.input.altFire = 0;
        return;
      }
      c.input.fire = bits & IN.FIRE ? 1 : 0;
      c.input.up = bits & IN.UP ? 1 : 0;
      c.input.left = bits & IN.LEFT ? 1 : 0;
      c.input.down = bits & IN.DOWN ? 1 : 0;
      c.input.right = bits & IN.RIGHT ? 1 : 0;
      c.input.altFire = bits & IN.ALTFIRE ? 1 : 0;
      c.mouse.x = clampCoord(mx, client.arena.game); c.mouse.y = clampCoord(my, client.arena.game);
      t.selfDestruct = !!(bits & IN.SUICIDE);
      // Sandbox-only cheats, enforced here rather than trusted from the client.
      if (cheatsOK(client.arena.game)) {
        // The god bit is a held toggle on the client, so only its rising edge flips
        // god mode. Reading it as an absolute would stomp /god from chat every tick.
        const godBit = !!(bits & IN.GOD);
        if (godBit && !client.godBit) t.godMode = !t.godMode;
        client.godBit = godBit;
        if (bits & IN.LEVELUP && t.level < MAX_LEVEL) t.addScore(Math.max(5, sim.LEVEL_SCORE[t.level + 1] - t.score + 1));
      }
      break;
    }
    case OP.POSSESS: {
      if (t.dead) return;
      if (t.possessing) { sim.release(client.arena.game, t); break; }
      const g = client.arena.game;
      const pool = (g.dominators || []).concat(g.motherships || []);
      let best = null, bestD = 1400 * 1400;
      for (const cand of pool) {
        if (cand.dead || cand.possessedBy || cand.team !== t.team) continue;
        const d = (cand.x - t.x) * (cand.x - t.x) + (cand.y - t.y) * (cand.y - t.y);
        if (d < bestD) { bestD = d; best = cand; }
      }
      if (best && sim.possess(g, t, best)) t.notify('You are piloting the ' + best.name + ' — press H to step out', 100);
      else if (!best) t.notify('Nothing of yours to take control of nearby', 60);
      break;
    }
    case OP.STAT: {
      const wire = b.ru8();
      if (wire < 8) t.upgradeStat(wire);            // validates points and caps
      break;
    }
    case OP.UPGRADE: {
      const id = b.ru8();
      t.upgradeTo(id);                              // validates the class is actually offered
      break;
    }
    case OP.RESPAWN: {
      if (!t.dead) return;
      if (client.arena.game.closing) { evict(client, 'This arena has closed — press Play to join a new one'); return; }
      spawn(client, t.name, t);
      break;
    }
    case OP.TOGGLE: {
      const which = b.ru8();
      if (which === 0) t.autoFire = !t.autoFire;
      else if (which === 1) t.autoSpin = !t.autoSpin;
      break;
    }
    case OP.CHAT: {
      handleChat(client, b.rstr());
      break;
    }
  }
}

function clampCoord(v, g) {
  const lim = g.arena.size;
  return Math.max(-lim, Math.min(lim, v));
}

const sanitize = sanitizeName;   // one name rule, shared with /nick

function spawn(client, name, old) {
  const g = client.arena.game;
  const t = old ? g.respawnPlayer(name, old) : g.spawnTank({ name: sanitize(name), isPlayer: true });
  t.client = client;
  if (old) old.client = null;
  client.tank = t;
  client.spectate = null;
  client.viewing = false;
  client.followLeader = false;
  client.seen = new Set();
  client.camX = t.x; client.camY = t.y;
  sendWelcome(client, client.arena);
  sendMapState(client, g);              // new arrivals need the objective layout at once
}

httpServer.listen(PORT, () => {
  console.log(`Tank Arena server on http://localhost:${PORT}`);
  console.log(`WebSocket on ws://localhost:${PORT}`);
  if (CLOSE_AFTER) console.log(`retiring in ${CLOSE_AFTER}s`);
});

// Retiring the server: close every arena, let the closers clear the board, and
// exit once they are all empty. Ctrl+C twice exits immediately.
function gracefulShutdown() {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  console.log('\nretiring server: closing all arenas');
  httpServer.close();
  if (allArenas.size === 0) process.exit(0);
  for (const a of [...allArenas]) closeArena(a);
  setTimeout(() => { console.log('shutdown timed out'); process.exit(0); }, 180000).unref();
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// `node server.js [port] [closeAfterSeconds]` — a scheduled retirement, which is
// also how the tests drive the close sequence without relying on signals.
if (CLOSE_AFTER) setTimeout(gracefulShutdown, CLOSE_AFTER * 1000);
