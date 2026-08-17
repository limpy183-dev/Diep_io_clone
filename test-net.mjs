// Network integration test. `node test-net.mjs`
// Starts the real server and drives the real client decoder (js/net.js) against
// it over a real socket, so the encoder and decoder are tested as a pair.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import WS from 'ws';

const PORT = 8199;
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
  for (const f of ['js/tankdefs.js', 'js/tankdefs-extra.js', 'js/data.js', 'js/protocol.js', 'js/engine.js', 'js/modes.js', 'js/net.js'])
    vm.runInContext(readFileSync(new URL(f, import.meta.url), 'utf8'), ctx, { filename: f });

  ctx.__name = name; ctx.__mode = mode; ctx.__port = port || PORT;
  return vm.runInContext(`new NetGame('ws://localhost:'+__port, __name, __mode, {})`, ctx);
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
