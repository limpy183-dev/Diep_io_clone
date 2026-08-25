// test-modes.mjs — the Mode Lab's 38 arenas.
//
// The soak that matters is not "does it tick" — every mode ticked on the first
// try. It is the round reset: a mode that leaks entities, walls or flags into
// its next round looks fine for five minutes and then quietly rots the arena.
// So each mode is booted, ticked, forced through a full win-and-reset cycle,
// and measured on the other side.
//
// Run: node test-modes.mjs

import fs from 'node:fs';
import vm from 'node:vm';

const sim = vm.createContext({ console, Math, JSON, Map, Set, Infinity, NaN });
for (const f of ['js/tankdefs.js', 'js/data.js', 'js/tankdefs-extra.js', 'js/protocol.js',
  'js/engine.js', 'js/modes.js', 'js/modes-extra.js', 'js/modefx.js'])
  vm.runInContext(fs.readFileSync(f, 'utf8'), sim, { filename: f });

const { Game, GAMEMODES, LAB_MODES, MODE_LOGIC, MODE_THUMB, TANK_DEFS, TPS,
  JUGGERNAUT_ID, GUN_CHAIN, CHAOS, playableTankIds } = sim;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
function section(t) { console.log('\n' + t); }

// A small arena: the mode logic is what is under test, not the shape spawner.
function boot(key, opts = {}) {
  const g = new Game(key, 'tester', { difficulty: 'hard', botCount: 10, ...opts });
  g.wantedShapes = Math.min(g.wantedShapes, 60);
  return g;
}
function run(g, n) { for (let i = 0; i < n; i++) g.step(); }

// Push a mode through winRound -> the delay -> logic.reset(), the way step()
// does, without waiting out a real round.
function forceRound(g) {
  g.roundEndsAt = g.tick + 2;
  run(g, 4);
}

// =========================================================================
section('registration');
const keys = Object.keys(LAB_MODES);
ok('38 lab modes are registered', keys.length === 38, keys.length + ' found');

for (const k of keys) {
  const m = GAMEMODES[k];
  if (!ok('GAMEMODES has ' + k, !!m)) continue;
  ok(k + ' is flagged lab', m.lab === true);
  ok(k + ' has a family', !!LAB_MODES[k].family);
  ok(k + ' has a blurb', (LAB_MODES[k].blurb || '').length > 30);
  ok(k + ' explains itself', (LAB_MODES[k].how || []).length >= 3,
    (LAB_MODES[k].how || []).length + ' steps');
  ok(k + ' has a thumbnail', typeof MODE_THUMB[k] === 'function');
}
// The eleven shipped modes must stay out of the Lab, and out of nothing else.
for (const k of ['ffa', 'survival', 'team2', 'team4', 'maze', 'domination', 'tag',
  'mothership', 'breakout', 'ctf', 'sandbox'])
  ok('base mode ' + k + ' is untouched', GAMEMODES[k] && !GAMEMODES[k].lab);

// Every objective mode has to tell the bots what to do, or the offline arena
// walks past its own objective. Rule modes legitimately have nothing to say.
const NO_GOAL_OK = new Set(['scoreattack', 'instagib', 'vampire', 'icerink', 'bloodmoney',
  'locust', 'draft', 'mirror', 'randomizer', 'fog', 'nightfall', 'portals', 'chaos',
  'gungame', 'hideseek', 'infection', 'squads', 'labyrinth', 'gauntlet', 'bossroyale']);
for (const k of keys) {
  const logic = MODE_LOGIC[k];
  if (!logic) continue;
  if (NO_GOAL_OK.has(k)) continue;
  ok(k + ' gives the bots a goal', typeof logic.botGoal === 'function');
}

// =========================================================================
section('boot, tick and reset');
for (const k of keys) {
  let g;
  try { g = boot(k); } catch (e) { ok(k + ' boots', false, e.message); continue; }
  ok(k + ' boots', true);
  try { run(g, 400); } catch (e) { ok(k + ' ticks', false, e.message); continue; }
  ok(k + ' ticks', true);

  const before = g.entities.length;
  let modeEnts = g.entities.filter((e) => e.modeEntity).length;
  try { forceRound(g); run(g, 200); } catch (e) { ok(k + ' resets', false, e.message); continue; }
  ok(k + ' resets', true);
  // Two resets back to back is where a leak shows: the sweep has to remove the
  // furniture the previous init() built, from g.walls as well as g.entities.
  try { forceRound(g); run(g, 200); forceRound(g); run(g, 200); }
  catch (e) { ok(k + ' survives three resets', false, e.message); continue; }
  ok(k + ' survives three resets', true);
  const after = g.entities.filter((e) => e.modeEntity).length;
  // Modes that spawn per-round furniture rebuild the same amount; nothing should
  // come back with three times as much.
  ok(k + ' does not leak mode entities', after <= Math.max(4, modeEnts * 1.6),
    modeEnts + ' -> ' + after);
  ok(k + ' does not leak walls', g.walls.length <= (GAMEMODES[k].maze ? 4000 : 200),
    g.walls.length + ' walls');
}

// =========================================================================
// The server runs every arena headless — no local player at all. A mode that
// reaches for g.player boots fine offline and takes the server down.
section('headless (the server path)');
for (const k of keys) {
  try {
    const g = new Game(k, '', { headless: true, difficulty: 'hard', botCount: 8 });
    g.wantedShapes = Math.min(g.wantedShapes, 60);
    ok(k + ' boots headless', !g.player);
    run(g, 300);
    forceRound(g);
    run(g, 120);
    ok(k + ' runs headless', true);
    // and the HUD line has to be wire-safe: the map-state string caps at 253 bytes
    ok(k + ' HUD line fits the wire', (g.modeHud || '').length < 200,
      (g.modeHud || '').length + ' chars');
  } catch (e) { ok(k + ' runs headless', false, e.message); }
}

// =========================================================================
section('rule lookups');
{
  const g = boot('icerink');
  ok('friction rule is read', g.rule('friction', 0.1) === 0.02);
  ok('unset rules fall through to the default', g.rule('nonsense', 7) === 7);
  g.ruleOverride = { friction: 0.5 };
  ok('ruleOverride beats the mode table', g.rule('friction', 0.1) === 0.5);
  g.ruleOverride = null;
  ok('clearing the override restores the mode', g.rule('friction', 0.1) === 0.02);
}
{
  const g = boot('ffa');
  ok('a mode with no rules gets the defaults', g.rule('friction', 0.1) === 0.1);
}

// =========================================================================
section('instagib / sumo — damage multiplier at both ends');
{
  const g = boot('instagib');
  ok('instagib spawns you finished', g.player.level === sim.MAX_LEVEL, 'level ' + g.player.level);
  ok('instagib multiplies damage', g.rule('dmgMult', 1) === 30);
  // Assert the arithmetic, not an emergent fight: two level 45 tanks in a
  // 9,000-unit arena may simply not have met inside the test window.
  const a = g.entities.find((e) => e.type === 'tank' && !e.dead);
  const b = g.entities.filter((e) => e.type === 'tank' && !e.dead)[1];
  a.x = 0; a.y = 0; b.x = a.size * 1.1; b.y = 0;
  a.team = null; b.team = null;
  const hpB = b.health;
  sim.handleCollision(a, b);
  ok('one touch is fatal', b.health <= 0 || b.dead || hpB - b.health > hpB * 0.9,
    hpB + ' -> ' + b.health);
}
{
  const g = boot('sumo');
  ok('sumo turns damage off', g.rule('dmgMult', 1) === 0);
  // Knockback is applied separately from damage, so it has to survive dmgMult 0.
  const a = g.entities.find((e) => e.type === 'tank' && !e.dead);
  const b = g.entities.filter((e) => e.type === 'tank' && !e.dead)[1];
  a.x = 0; a.y = 0; a.vx = a.vy = 0;
  b.x = a.size * 1.2; b.y = 0; b.vx = b.vy = 0;
  const hpA = a.health;
  run(g, 3);
  ok('sumo still shoves', Math.abs(a.vx) + Math.abs(a.vy) + Math.abs(b.vx) + Math.abs(b.vy) > 0.05,
    'no knockback');
  ok('sumo deals no contact damage', a.health >= hpA - 0.001, hpA + ' -> ' + a.health);
  // and the ring has to actually close
  const r0 = g.ring;
  run(g, 400);
  ok('the sumo ring shrinks', g.ring < r0, r0 + ' -> ' + g.ring);
}

// =========================================================================
section('vampire — one choke point for every source of damage');
{
  const g = boot('vampire');
  ok('regen is off', g.rule('regen', 1) === 0);
  const t = g.entities.find((e) => e.type === 'tank' && !e.dead);
  const foe = g.entities.filter((e) => e.type === 'tank' && !e.dead)[1];
  ok('regenPerTick really is zero', t.regenPerTick === 0, String(t.regenPerTick));
  t.health = t.maxHealth * 0.4;
  const before = t.health;
  foe.applyDamage(100, t);            // t deals it, so t heals
  ok('damage dealt heals the dealer', t.health > before, before + ' -> ' + t.health);
  ok('lifesteal cannot overheal', t.health <= t.maxHealth);
}

// =========================================================================
section('gun game — the ladder');
{
  const g = boot('gungame');
  ok('the ladder is 21 rungs', GUN_CHAIN.length === 21);
  const playable = new Set(playableTankIds());
  ok('every rung is a class a player could reach', GUN_CHAIN.every((id) => playable.has(id)),
    GUN_CHAIN.filter((id) => !playable.has(id)).join(','));
  const a = g.entities.find((e) => e.type === 'tank' && !e.dead && e.bot);
  const b = g.entities.filter((e) => e.type === 'tank' && !e.dead && e.bot)[1];
  const rung0 = a.gunRung || 0;
  b.kill(a);                          // a killed b
  ok('a kill climbs a rung', (a.gunRung || 0) === rung0 + 1, rung0 + ' -> ' + a.gunRung);
  ok('the class follows the rung', a.tankId === GUN_CHAIN[a.gunRung],
    a.tankId + ' vs ' + GUN_CHAIN[a.gunRung]);
  ok('a kill tops you up', a.health === a.maxHealth);
  // and a death drops one, floored at the bottom
  const c = g.entities.filter((e) => e.type === 'tank' && !e.dead && e.bot)[2];
  a.gunRung = 0;
  a.kill(c);
  ok('the rung never goes below zero', a.gunRung === 0, String(a.gunRung));
}

// =========================================================================
section('draft roulette — one card, and the same card');
{
  const g = boot('draft');
  const t = g.entities.find((e) => e.type === 'tank' && !e.dead);
  t.score = sim.LEVEL_SCORE[20];
  t.level = 20;
  t.setTank(0);
  t.checkUpgrades();
  const first = t.pendingUpgrades.slice();
  ok('exactly one card is offered', first.length === 1, first.length + ' cards');
  t.checkUpgrades();
  ok('asking again deals the same card', t.pendingUpgrades[0] === first[0],
    first[0] + ' then ' + t.pendingUpgrades[0]);
  ok('the card is a real upgrade of this class',
    (TANK_DEFS[0].upgrades || []).indexOf(first[0]) !== -1);
  // the server-side gate must refuse what was not dealt
  const notDealt = (TANK_DEFS[0].upgrades || []).find((id) => id !== first[0]);
  if (notDealt !== undefined) ok('a card that was not dealt is refused', t.upgradeTo(notDealt) === false);
}

// =========================================================================
section('juggernaut — the custom hull, and the bots noticing it');
{
  const g = boot('juggernaut');
  run(g, 20 * TPS);
  const def = TANK_DEFS[JUGGERNAUT_ID];
  ok('the Juggernaut def is built', !!def);
  ok('it sits past every real id', JUGGERNAUT_ID > TANK_DEFS.length - 40 || !TANK_DEFS[JUGGERNAUT_ID - 1]);
  ok('it is twelve-sided', def.sides === 12, String(def.sides));
  ok('it is armed all round', def.barrels.length >= 9, def.barrels.length + ' barrels');
  ok('it is not in the upgrade tree', playableTankIds().indexOf(JUGGERNAUT_ID) === -1);
  const j = g.entities.find((e) => e.isJuggernaut);
  if (ok('a Juggernaut was crowned', !!j)) {
    ok('it is genuinely oversized', j.size > 150, 'size ' + Math.round(j.size));
    ok('it has boss-tier health', j.maxHealth >= 9000, String(j.maxHealth));
    ok('it shrugs off knockback', j.absorb <= 0.1, String(j.absorb));
    ok('it is the arena bounty', g.bountyTarget === j);
    // The bounty term has to actually move a bot's target choice, and everyone
    // here is teamless — the case the mark has to survive. Ring them around it
    // rather than stacking them: nine tanks on one point body-damage each other
    // to death inside a second and respawn across the map.
    const ring = g.entities.filter((e) => e.type === 'tank' && e.bot && !e.dead && e !== j);
    ring.forEach((e, i) => {
      const a = Math.PI * 2 * (i / ring.length);
      e.x = j.x + Math.cos(a) * 900; e.y = j.y + Math.sin(a) * 900;
      e.vx = e.vy = 0;
    });
    run(g, 30);
    const aiming = ring.filter((e) => !e.dead && e.aiTarget === j).length;
    ok('bots prioritise the Juggernaut', aiming > 0, aiming + ' bots targeting it');
    // and killing it must move the crown, not end the mode
    const killer = g.entities.find((e) => e.type === 'tank' && e.bot && !e.dead && e !== j);
    j.applyDamage(1e9, killer);
    run(g, 8 * TPS);
    const j2 = g.entities.find((e) => e.isJuggernaut && !e.dead);
    ok('the crown moves on', !!j2 && j2 !== j);
  }
}

// =========================================================================
section('prop hunt — the disguise is real, and you can move');
{
  const g = boot('prophunt');
  run(g, 60);
  const hider = g.entities.find((e) => e.type === 'tank' && !e.dead && e.propKind);
  if (ok('somebody is disguised', !!hider)) {
    const s = sim.SHAPES[hider.propKind];
    ok('the disguise takes the shape\'s sides', hider.sides === s.sides,
      hider.sides + ' vs ' + s.sides);
    ok('and roughly its size', Math.abs(hider.size - s.size) < s.size * 0.25,
      Math.round(hider.size) + ' vs ' + Math.round(s.size));
    ok('the name plate is suppressed', hider.hideName === true);
    ok('the barrels are suppressed', hider.hideBarrels === true);
    ok('it is painted as the shape', hider.fill === s.fill);
    // the brief is explicit that props may move
    ok('a prop keeps full movement speed', hider.movementSpeed > 0);
    const x0 = hider.x;
    hider.input.right = 1;
    run(g, 25);
    ok('a prop really does move', Math.abs(hider.x - x0) > 1,
      'moved ' + Math.abs(hider.x - x0).toFixed(1));
    ok('a prop cannot shoot', hider.input.fire === 0 && hider.autoFire === false);
  }
  const seeker = g.entities.find((e) => e.type === 'tank' && !e.dead && e.isSeeker);
  if (ok('somebody is seeking', !!seeker)) {
    ok('seekers see invisible', seeker.seesInvisible === true);
    // shooting a genuine polygon has to cost
    const shape = g.entities.find((e) => e.type === 'shape' && !e.dead);
    const hp = seeker.health;
    shape.lastHitBy = seeker;
    shape.kill(seeker);
    run(g, 2);
    ok('a wrong shot costs the seeker', seeker.health < hp, hp + ' -> ' + seeker.health);
  }
}

// =========================================================================
section('singularity — small and weak, then everything');
{
  const g = boot('singularity');
  run(g, 5);
  const r0 = g.singR, p0 = g.singPull;
  ok('it starts tiny', r0 < 60, 'r=' + Math.round(r0));
  ok('and almost powerless', p0 < 0.06, 'pull=' + p0.toFixed(4));
  run(g, 60 * TPS);
  ok('it grows', g.singR > r0, Math.round(r0) + ' -> ' + Math.round(g.singR));
  ok('its pull grows with it', g.singPull > p0);
  // a tank inside the reach must actually be dragged inward
  const t = g.entities.find((e) => e.type === 'tank' && !e.dead && !e.bot) ||
    g.entities.find((e) => e.type === 'tank' && !e.dead);
  t.x = g.singR * 2.2; t.y = 0; t.vx = t.vy = 0;
  t.immobile = true;                    // isolate the pull from its own thrust
  run(g, 5);
  ok('the well pulls things in', t.vx < 0, 'vx=' + t.vx.toFixed(3));
  // ...and by the end it has to reach the whole board
  g.singT = 12 * 60 * TPS;
  run(g, 2);
  ok('it ends up swallowing the arena', g.singR > g.arena.size * 0.5,
    Math.round(g.singR) + ' vs arena ' + g.arena.size);
}

// =========================================================================
section('portals, tiles, ball, bomb');
{
  const g = boot('portals');
  const t = g.entities.find((e) => e.type === 'tank' && !e.dead);
  const p = g.portals[0], far = g.portals[2];
  t.x = p.x; t.y = p.y; t.portalCool = 0;
  run(g, 2);
  ok('a portal moves you across the map',
    Math.hypot(t.x - far.x, t.y - far.y) < Math.hypot(t.x - p.x, t.y - p.y) + 1e-6
    && Math.hypot(t.x - p.x, t.y - p.y) > 100,
    'ended ' + Math.round(Math.hypot(t.x - p.x, t.y - p.y)) + ' from the entry');
  ok('and puts a cooldown on you', t.portalCool > g.tick);
  // The thing that must not happen is a one-frame smear across the arena. The
  // previous position is reset on the jump, so the gap stays movement-sized.
  ok('interpolation is snapped, not streaked', Math.hypot(t.x - t.px, t.y - t.py) < 200,
    'gap ' + Math.round(Math.hypot(t.x - t.px, t.y - t.py)));
}
{
  const g = boot('musicaltiles');
  ok('the floor is a 10x10 grid', g.mtiles.length === 100, g.mtiles.length + ' tiles');
  run(g, 40 * TPS);
  const gone = g.mtiles.filter((t) => !t.alive).length;
  ok('tiles start dropping', gone > 0, gone + ' gone');
  ok('a dropped tile is a hole, not a tile', g.mtiles.filter((t) => !t.alive).every((t) => t.sides === 0));
}
{
  const g = boot('diepball');
  ok('there is a ball', !!g.ball && !g.ball.dead);
  ok('the ball takes no damage', g.ball.damageReduction === 0);
  ok('the ball deals none either', g.ball.damagePerTick === 0);
  ok('but it is shoved easily', g.ball.absorb > 1);
  // a goal has to actually score
  g.ball.x = g.goals[1].x; g.ball.y = g.goals[1].y;
  run(g, 2);
  ok('putting it in the far goal scores', g.ballScore.blue === 1,
    JSON.stringify(g.ballScore));
}
{
  const g = boot('bombtag');
  run(g, 10 * TPS);
  if (ok('a bomb gets armed', !!g.bomb)) {
    const holder = g.bomb;
    const other = g.entities.find((e) => e.type === 'tank' && !e.dead && e !== holder && !e.modeEntity);
    const fuse = g.bombFuse;
    other.x = holder.x; other.y = holder.y;
    run(g, 2);
    ok('touching somebody passes it', g.bomb === other, 'still on the same tank');
    ok('and the fuse keeps running', g.bombFuse < fuse, fuse + ' -> ' + g.bombFuse);
  }
}

// =========================================================================
section('chaos rotation — the deck, and clean teardown');
{
  const g = boot('chaos');
  ok('there are fifteen modifiers', CHAOS.length === 15, CHAOS.length + ' found');
  ok('each names itself', CHAOS.every((m) => m.name && m.blurb));
  ok('each does something', CHAOS.every((m) => typeof m.on === 'function'));
  const seen = new Set();
  // Walk several full cycles: the deck is shuffled and drained, so every
  // modifier must come up before any repeats.
  for (let i = 0; i < 40 && seen.size < CHAOS.length; i++) {
    g.chaosAt = g.tick;
    run(g, 2);
    if (g.chaosCur) seen.add(g.chaosCur.name);
  }
  ok('the whole deck comes up', seen.size === CHAOS.length, seen.size + '/' + CHAOS.length);
  // and the arena has to be handed back clean
  g.chaosAt = g.tick;
  run(g, 4);
  if (g.chaosCur) { g.chaosAt = g.tick; run(g, 2); }
  ok('the clock is handed back', g.timeScale === 1, 'timeScale ' + g.timeScale);
  ok('the rule layer is handed back', g.ruleOverride === null);
  ok('the shape quota is handed back', g.wantedShapes <= 1000, String(g.wantedShapes));
}

// =========================================================================
section('the visual layer');
{
  // The thumbnails have to survive being called with a stub context — the site
  // and the menu both drive them from a real canvas, but a crash in one must
  // never be able to take out the wall.
  const calls = [];
  const stub = new Proxy({}, {
    get(_, k) {
      if (k === 'canvas') return { width: 300, height: 190 };
      if (k === 'measureText') return () => ({ width: 40 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient')
        return () => ({ addColorStop() {} });
      if (k === 'getImageData') return () => ({ data: new Uint8Array(4) });
      return (...a) => { calls.push(k); return undefined; };
    },
    set() { return true; }
  });
  let broke = null;
  for (const k of keys) {
    try { MODE_THUMB[k](stub, 300, 190, 3.7); }
    catch (e) { broke = k + ': ' + e.message; break; }
  }
  ok('every thumbnail draws', !broke, broke || '');
  ok('and actually draws something', calls.length > 200, calls.length + ' canvas calls');
}
{
  const withFx = keys.filter((k) => sim.MODE_FX[k]);
  ok('the modes that need a look have one', withFx.length >= 30, withFx.length + ' of ' + keys.length);
  ok('no effect is registered for a mode that does not exist',
    Object.keys(sim.MODE_FX).every((k) => !!LAB_MODES[k]));
}

// =========================================================================
console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('\n' + failures.map((f) => '  x ' + f).join('\n'));
  process.exit(1);
}
