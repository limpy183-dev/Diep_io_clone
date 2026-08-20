// Network integration test. `node test-net.mjs`
// Starts the real server and drives the real client decoder (js/net.js) against
// it over a real socket, so the encoder and decoder are tested as a pair.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import WS from 'ws';

const PORT = Number(process.env.PORT) || 8199;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: got ${a}, want ~${b}`);
let passed = 0;
const test = (name, ok) => { assert.ok(ok === undefined || ok, name); passed++; console.log('  ok  ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- browser-shaped context running the actual client code ---------------
function makeClient(name, mode, port) {
  const ctx = vm.createContext({ console, WebSocket: null, performance });
  ctx.WebSocket = class {
    constructor(url) {
      this.readyState = 0;
      const real = new WS(url);
      real.binaryType = 'arraybuffer';
      this._real = real;
      real.on('open', () => { this.readyState = 1; this.onopen && this.onopen(); });
      real.on('message', (d) => this.onmessage && this.onmessage({ data: new Uint8Array(d).buffer }));
      real.on('close', () => { this.readyState = 3; this.onclose && this.onclose(); });
      real.on('error', () => this.onerror && this.onerror());
    }
    send(bytes) { if (this.readyState === 1) this._real.send(bytes); }
    close() { this._real.close(); }
  };
  // Stand-in for the DOM chat overlay: the decoder only needs somewhere to put
  // a line, and the test needs to read what arrived.
  ctx.CHAT = { fps: 0, lines: [], push(kind, who, text, color) { this.lines.push({ kind, who, text, color }); } };
  for (const f of ['js/tankdefs.js', 'js/tankdefs-extra.js', 'js/data.js', 'js/protocol.js', 'js/engine.js', 'js/modes.js', 'js/commands.js', 'js/net.js'])
    vm.runInContext(readFileSync(new URL(f, import.meta.url), 'utf8'), ctx, { filename: f });

  ctx.__name = name; ctx.__mode = mode; ctx.__port = port || PORT;
  const g = vm.runInContext(`new NetGame('ws://localhost:'+__port, __name, __mode, {})`, ctx);
  g.chat = ctx.CHAT.lines;
  return g;
}

const waitFor = async (fn, ms = 6000, what = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); }
  throw new Error('timed out waiting for ' + what);
};

// ---- boot the server -----------------------------------------------------
const server = spawn(process.execPath, ['server.js', String(PORT)], { cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const CWD = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const killers = [server];
const cleanup = () => { for (const p of killers) { try { p.kill(); } catch (e) { /* already gone */ } } };
process.on('exit', cleanup);

try {
  await waitFor(() => /server on http/.test(serverLog), 8000, 'server start');
  console.log('\nHandshake');
  test('server boots and listens');

  const a = makeClient('Alice', 'ffa');
  await waitFor(() => a.myId !== 0, 6000, 'welcome packet');
  test('client joins and receives WELCOME with an entity id');

  assert.equal(a.arena.size, 22300);
  test('arena dimensions arrive (22300)');

  await waitFor(() => a.entities.length > 0, 6000, 'first snapshot');
  test(`first snapshot decodes (${a.entities.length} entities in view)`);

  console.log('\nWorld replication');
  const mine = a.entities.find((e) => e.id === a.myId);
  assert.ok(mine, 'own tank is always sent');
  assert.equal(mine.type, 'tank');
  assert.equal(mine.name, 'Alice');
  test('own tank present, typed and named');

  const shapes = a.entities.filter((e) => e.type === 'shape');
  assert.ok(shapes.length > 0, 'shapes replicated');
  assert.ok(shapes.every((s) => s.sides >= 3 && s.size > 0 && /^#[0-9a-f]{6}$/i.test(s.fill)), 'shape fields sane');
  test(`shapes replicate with geometry and colour (${shapes.length} visible)`);

  const tanks = a.entities.filter((e) => e.type === 'tank');
  assert.ok(tanks.every((t) => t.def && Array.isArray(t.barrels)), 'barrels rebuilt from the tank table');
  test('remote tanks rebuild barrels client-side from tankId');

  console.log('\nInput is authoritative');
  const p = a.player;
  assert.equal(p.dead, false);
  const x0 = p.x, y0 = p.y;
  for (let i = 0; i < 40; i++) { a.sendInput({ right: 1, fire: 0 }, { x: p.x + 500, y: p.y }, {}); await sleep(20); }
  await waitFor(() => Math.abs(a.player.x - x0) > 40, 4000, 'movement');
  const dx = a.player.x - x0, dy = a.player.y - y0;
  test(`movement input moves the server-side tank (${Math.round(dx)} units east)`);
  // Drifting shapes knock you around, so pin the intent: travel is dominated by
  // the axis actually pressed, rather than an absolute position.
  assert.ok(dx > 0 && Math.abs(dx) > Math.abs(dy) * 3, `dx ${Math.round(dx)} vs dy ${Math.round(dy)}`);
  test('travel follows the pressed axis, not the idle one');

  console.log('\nServer-side validation');
  // Spam far more upgrades than could ever be legal. The level keeps rising as
  // shapes drift in, so assert the invariant rather than a fixed number.
  for (let i = 0; i < 60; i++) a.upgradeStat(3);
  for (let i = 0; i < 60; i++) a.upgradeStat(5);
  await sleep(500);
  const st = a.player.stats, lvl = a.player.level;
  const spent = st.reduce((x, y) => x + y, 0);
  const allowed = lvl <= 28 ? lvl - 1 : Math.floor(lvl / 3) + 18;
  assert.ok(spent <= allowed, `spent ${spent} of ${allowed} legal points at level ${lvl}`);
  test(`stat spam cannot exceed the point budget (${spent}/${allowed} at level ${lvl})`);
  assert.ok(st.every((v, i) => v <= a.player.def.stats[i].max), 'no stat exceeds its cap');
  test('no stat exceeds its per-class cap');

  a.upgradeTo(49);                                    // Annihilator: needs level 45 and the right parent
  await sleep(300);
  assert.notEqual(a.player.tankId, 49, 'not an Annihilator');
  test('illegal class upgrade is refused by the server');

  console.log('\nTwo clients see each other');
  // Sandbox: a 6000-unit arena, so two spawns converge in seconds. In FFA they
  // can start 20000 units apart, which is ~30s of walking even at full speed.
  const c = makeClient('Carol', 'sandbox');
  const d = makeClient('Dave', 'sandbox');
  await waitFor(() => c.entities.length > 0 && d.entities.length > 0, 8000, 'sandbox snapshots');
  assert.equal(c.arena.size, 6000);
  test('two clients join a second arena, created on demand');

  // walk both toward each other
  const steer = (self, other) => self.sendInput({
    right: other.player.x > self.player.x + 30 ? 1 : 0, left: other.player.x < self.player.x - 30 ? 1 : 0,
    down: other.player.y > self.player.y + 30 ? 1 : 0, up: other.player.y < self.player.y - 30 ? 1 : 0
  }, { x: other.player.x, y: other.player.y }, {});

  await waitFor(() => {
    steer(c, d); steer(d, c);
    return c.entities.some((e) => e.name === 'Dave') && d.entities.some((e) => e.name === 'Carol');
  }, 30000, 'the two clients converging');
  test('each client sees the other once inside the view box');

  const daveSeenByCarol = c.entities.find((e) => e.name === 'Dave');
  near(daveSeenByCarol.x, d.player.x, 60, 'replicated x agrees');
  near(daveSeenByCarol.y, d.player.y, 60, 'replicated y agrees');
  test('replicated position agrees between the two clients');
  assert.ok(daveSeenByCarol.def && daveSeenByCarol.barrels.length > 0, 'remote player has barrels');
  test('remote player renders with barrels rebuilt from the tank table');
  const b = d;

  console.log('\nChat and commands');
  const said = (cl, re) => cl.chat.filter((m) => re.test(m.text));
  const chatty = async (cl, text) => { cl.sendChat(text); await sleep(500); };   // 400ms server limit

  await chatty(c, 'hello dave');
  assert.ok(said(d, /hello dave/).length, 'message reached the other client');
  assert.equal(said(d, /hello dave/)[0].who, 'Carol');
  assert.equal(said(d, /hello dave/)[0].kind, 'player');
  test('a chat line reaches every client in the arena, named and coloured');

  await chatty(c, '/roll 6');
  assert.ok(said(d, /Carol rolls \d+ out of 6/).length, 'command output broadcast');
  test('/roll broadcasts its result to the arena');

  await chatty(c, '/w Dave psst');
  const whispers = said(d, /psst/);
  assert.ok(whispers.length === 1 && whispers[0].kind === 'whisper', 'one private line, tagged as a whisper');
  assert.match(whispers[0].who, /Carol/, 'the recipient is told who sent it');
  test('/w delivers a private line to one player');

  await chatty(a, '/god');
  assert.ok(said(a, /is a cheat/).length, 'cheat refused outside sandbox');
  assert.equal(said(a, /God mode ON/).length, 0, 'and definitely not applied');
  test('cheats are refused in a non-sandbox arena');

  await chatty(a, '/cheats on');
  await chatty(a, '/god');
  assert.ok(said(a, /God mode ON/).length, '/cheats on opens a normal arena');
  test('/cheats on enables cheats in a multiplayer arena');

  const meNow = () => a.entities.find((e) => e.id === a.myId);
  const scale0 = meNow().scaleFactor, size0 = meNow().size;
  await chatty(a, '/size 4');
  await waitFor(() => meNow().size > size0 * 3, 6000, 'the bigger body to arrive');
  near(meNow().scaleFactor, scale0 * 4, 0.05, 'barrel scale followed the body over the wire');
  near(meNow().size / meNow().scaleFactor, size0 / scale0, 1, 'body and barrels stay in proportion');
  test('/size scales the barrels as well as the body, online');

  await chatty(a, '/rainbow on');
  await waitFor(() => meNow().rainbow, 6000, 'the rainbow flag');
  test('/rainbow reaches the client as an entity flag');
  await chatty(a, '/size 1');
  await chatty(a, '/rainbow off');

  // Sandbox is a small arena full of bots; Carol may well be dead by now, and a
  // cheat on a corpse is refused by design.
  if (c.player.dead) { c.respawn(); await waitFor(() => !c.player.dead, 6000, 'Carol respawning'); }
  await chatty(c, '/god');
  assert.ok(said(c, /God mode ON/).length, 'cheat applied in sandbox');
  await chatty(c, '/class booster');
  await waitFor(() => c.player.def && c.player.def.name === 'Booster', 4000, 'class cheat applying');
  test('/god and /class apply server-side in a Sandbox arena');

  // A class change mutates a tank every client has already seen, so it has to
  // reach the *entity*, not just the HUD — otherwise you upgrade and keep the
  // old barrels forever.
  const carol = () => c.entities.find((e) => e.id === c.myId);
  await waitFor(() => carol() && carol().def && carol().def.name === 'Booster', 4000, 'the new class on the wire');
  assert.equal(carol().barrels.length, c.player.def.barrels.length, 'barrels rebuilt for the new class');
  test('a class change repaints an already-replicated tank');

  // Auto 5 has no barrels and five turrets: the turret angles are the last
  // field of the record, so a stale count would garble everything after it.
  await chatty(c, '/class auto 5');
  await waitFor(() => carol() && carol().def.name === 'Auto 5', 4000, 'a class with a different turret count');
  assert.equal(carol().turrets.length, 5, 'five auto-turrets rebuilt');
  assert.equal(carol().barrels.length, 0, 'and no barrels left over from Booster');
  const cx0 = carol().x;
  await waitFor(() => {
    c.sendInput({ right: 1 }, { x: carol().x + 500, y: carol().y }, {});
    return Math.abs(carol().x - cx0) > 60;
  }, 8000, 'movement to keep replicating');
  test('the entity stream stays aligned when the turret count changes');

  // /view parks the camera on someone else, so the client's own tank position
  // has to ship separately — the minimap still draws your arrow.
  if (d.player.dead) { d.respawn(); await waitFor(() => !d.player.dead, 6000, 'Dave respawning'); }
  const carolId = c.myId, cx = c.player.x;
  await chatty(c, '/view Dave');
  await waitFor(() => c.watched && c.myId !== carolId, 4000, 'the camera to move onto Dave');
  assert.ok(c.self, 'own tank position ships alongside the watched build');
  near(c.self.x, cx, 400, 'your own tank stays where you left it');
  const watchedByCarol = c.entities.find((e) => e.id === c.myId);
  assert.ok(watchedByCarol && watchedByCarol.name === 'Dave', 'the camera rides Dave, packet still aligned');
  test('/view ships the watched build plus your own tank position');
  await chatty(c, '/view off');

  const before = d.chat.length;
  for (let i = 0; i < 6; i++) c.sendChat('spam ' + i);
  await sleep(600);
  assert.ok(d.chat.length - before <= 2, `rate limited (${d.chat.length - before} lines got through)`);
  test('chat is rate limited to roughly one line per 400ms');

  await chatty(c, '/nonsense');
  assert.ok(said(c, /Unknown command/).length);
  test('an unknown command answers instead of crashing the arena');

  console.log('\nView culling');
  const far = a.entities.filter((e) => Math.abs(e.x - a.player.x) > (1920 / a.player.fov) / 1.5 + 400);
  assert.equal(far.length, 0, 'nothing far outside the view box is sent');
  test('entities outside the view box are culled');

  console.log('\nObjective modes over the wire');
  const dom = makeClient('Dom', 'domination');
  await waitFor(() => dom.entities.length > 0 && dom.overlay.length > 0, 8000, 'domination snapshot');
  assert.equal(dom.overlay.length, 4, 'four Dominator markers reach the minimap');
  assert.ok(dom.overlay.every((o) => o.kind === 1), 'tagged as objective markers');
  test('Domination map state replicates to the minimap');

  // H with nothing nearby must be refused, not crash
  dom.possess();
  await sleep(400);
  assert.ok(!dom.player.dead, 'still alive after a rejected possess');
  test('possess with no target in range is refused cleanly');

  const brk = makeClient('Brk', 'breakout');
  await waitFor(() => brk.overlay.length > 0, 8000, 'breakout map state');
  assert.equal(brk.overlay.length, 64, '8x8 board replicated');
  const claimed = brk.overlay.filter((o) => o.fill !== '#bbbbbb');
  assert.equal(claimed.length, 16, 'both edge columns start claimed');
  test('Breakout board replicates with the starting territory');

  // tile ownership and the collapse warning ride the entity flag byte
  await waitFor(() => brk.entities.some((e) => e.type === 'tile'), 8000, 'tile entities');
  const tiles = brk.entities.filter((e) => e.type === 'tile');
  // Which tiles are in view depends on where you spawned — you can land wholly
  // inside your own territory — so assert the decode, not the mix.
  assert.ok(tiles.every((t) => t.team === null || t.team === 'owned'), 'ownership flag decoded');
  assert.ok(tiles.every((t) => t.warning === false), 'nothing is flashing yet');
  // the board itself is deterministic: two edge columns claimed, 48 free
  assert.equal(brk.overlay.filter((o) => o.fill === '#bbbbbb').length, 48, 'unclaimed tiles on the board');
  test(`tile ownership and warning state replicate (${tiles.length} tiles in view)`);

  await waitFor(() => brk.leaderboard.length === 2, 6000, 'team scoreboard');
  assert.ok(brk.leaderboard.every((r) => r.name === 'Blue' || r.name === 'Red'), 'per-team rows');
  test('objective modes send a per-team scoreboard instead of players');

  const ctf = makeClient('Ctf', 'ctf');
  await waitFor(() => ctf.overlay.length > 0, 8000, 'ctf map state');
  assert.equal(ctf.overlay.filter((o) => o.kind === 3).length, 20, '20 flags on the minimap');
  test('CTF flags replicate to the minimap');

  await waitFor(() => ctf.entities.some((e) => e.type === 'flag' || e.type === 'wall'), 8000, 'ctf entities');
  test('CTF flag and barrier entities decode as their own types');

  const tag = makeClient('Tag', 'tag');
  await waitFor(() => tag.leaderboard.length === 4, 8000, 'tag scoreboard');
  assert.ok(tag.leaderboard.every((r) => ['Blue', 'Green', 'Purple', 'Red'].indexOf(r.name) >= 0));
  test('Tag scoreboard lists the four teams');

  dom.close(); brk.close(); ctf.close(); tag.close();
  await sleep(300);

  console.log('\nArena closing');
  // A second server told to retire itself after 2s. Sandbox keeps the arena small
  // (6000 units, 7 closers) so the sweep finishes in seconds, not a minute.
  const PORT2 = 8200;
  const server2 = spawn(process.execPath, ['server.js', String(PORT2), '2'], { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  let log2 = '';
  server2.stdout.on('data', (x) => { log2 += x; });
  server2.stderr.on('data', (x) => { log2 += x; });
  killers.push(server2);
  await waitFor(() => /server on http/.test(log2), 8000, 'second server start');

  const doomed = makeClient('Doomed', 'sandbox', PORT2);
  await waitFor(() => doomed.entities.length > 0, 8000, 'doomed client snapshot');
  test('client joins a server scheduled to retire');

  // Move, so spawn protection lapses. An idle tank is invulnerable for 15s and
  // would stall the sweep that long — correct, but slow to sit through.
  const nudge = setInterval(() => doomed.sendInput({ right: 1 }, doomed.player.mouse, {}), 40);

  await waitFor(() => doomed.closeNotice, 25000, 'close announcement');
  assert.match(doomed.closeNotice, /No players can join/);
  test('client is told the arena is closing');

  await waitFor(() => doomed.entities.some((e) => e.name === 'Arena Closer'), 45000, 'closers arriving');
  const ac = doomed.entities.find((e) => e.name === 'Arena Closer');
  assert.equal(ac.tankId, 16, 'replicates as the Arena Closer class');
  assert.ok(ac.barrels.length > 0, 'client rebuilt its barrel from the tank table');
  test('Arena Closers replicate into the client view');

  await waitFor(() => !doomed.connected, 90000, 'eviction');
  clearInterval(nudge);
  test('client is evicted once the arena closes');

  await waitFor(() => server2.exitCode !== null, 60000, 'server exit');
  assert.equal(server2.exitCode, 0, 'clean exit');
  assert.match(log2, /CLOSED/, 'server logged the close');
  test('the server exits cleanly once every arena is swept');

  console.log('\nDisconnect');
  b.close();
  await sleep(600);
  assert.ok(!/Error|error:/i.test(serverLog.replace(/\[.*?\]/g, '')), 'server logged no errors');
  test('client disconnect is handled cleanly');

  a.close();
  await sleep(200);
  console.log(`\n${passed} passed\n`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  console.error('--- server log ---\n' + serverLog);
  cleanup();
  process.exit(1);
}
cleanup();
process.exit(0);
