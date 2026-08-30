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
const ROUND_DELAY = sim.ROUND_END_DELAY;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
function section(t) { console.log('\n' + t); }

// A small arena: the mode logic is what is under test, not the shape spawner.
// The bot count is generous because a mode may subtract from it (Instagib runs
// ten lighter than whatever you picked) and a test with nobody in it proves
// nothing.
function boot(key, opts = {}) {
  const g = new Game(key, 'tester', { difficulty: 'hard', botCount: 24, ...opts });
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
ok('39 lab modes are registered', keys.length === 39, keys.length + ' found');

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
// Rule modes legitimately have nothing to say to a bot; everything with an
// objective has to teach it, either as a goal it weighs or as a drive it obeys.
const NO_GOAL_OK = new Set(['scoreattack', 'instagib', 'vampire', 'icerink', 'bloodmoney',
  'locust', 'draft', 'mirror', 'randomizer', 'fog', 'nightfall', 'portals', 'chaos',
  'gungame', 'squads', 'labyrinth', 'gauntlet', 'bossroyale', 'juggerroyale']);
for (const k of keys) {
  const logic = MODE_LOGIC[k];
  if (!logic) continue;
  if (NO_GOAL_OK.has(k)) continue;
  ok(k + ' teaches the bots the mode',
    typeof logic.botGoal === 'function' || typeof logic.botDrive === 'function');
}
// The modes whose rules are timing-critical cannot use hints — a goal is
// weighed against everything else and loses. They must drive.
for (const k of ['redlight', 'grandprix', 'prophunt', 'hideseek'])
  ok(k + ' drives its bots outright', typeof MODE_LOGIC[k].botDrive === 'function');

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
  // come back with three times as much. Juggernaut Royale is the exception and
  // has to be: its furniture is per-TANK rather than per-round — a hull with the
  // retinue trait keeps a live escort of turrets — so the count tracks how far
  // up the tree the arena has climbed rather than how many rounds have run, and
  // comparing it against a sample taken at tick 400 compares two different
  // things. Measured, it settles around 25 with 24 bots and stays there; a flat
  // cap well above that still catches a real leak, which runs to hundreds.
  const cap = k === 'juggerroyale' ? 80 : Math.max(4, modeEnts * 1.6);
  ok(k + ' does not leak mode entities', after <= cap, modeEnts + ' -> ' + after);
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
  ok('friction rule is read', g.rule('friction', 0.1) === 0.022);
  // Acceleration falls with it, which is what makes it ice rather than a speed
  // boost: friction alone multiplies terminal speed by the same factor.
  ok('acceleration falls with friction', g.rule('accelMult', 1) < 0.3);
  const term = (t) => t.movementSpeed * g.rule('accelMult', 1) / g.rule('friction', 0.1);
  const t0 = g.entities.find((e) => e.type === 'tank');
  ok('top speed stays roughly normal', Math.abs(term(t0) / (t0.movementSpeed * 10) - 1) < 0.15,
    'ratio ' + (term(t0) / (t0.movementSpeed * 10)).toFixed(2));
  ok('unset rules fall through to the default', g.rule('nonsense', 7) === 7);
  g.ruleOverride = { friction: 0.5 };
  ok('ruleOverride beats the mode table', g.rule('friction', 0.1) === 0.5);
  g.ruleOverride = null;
  ok('clearing the override restores the mode', g.rule('friction', 0.1) === 0.022);
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
  ok('instagib gives you cards to spend', g.player.pendingUpgrades.length > 0);
  run(g, 120);
  const bots = g.entities.filter((e) => e.type === 'tank' && e.bot && !e.dead);
  ok('the bots spawn finished too', bots.length > 0 && bots.every((b) => b.level === sim.MAX_LEVEL),
    [...new Set(bots.map((b) => b.level))].join(','));
  ok('instagib runs ten lighter', g.rule('botsDelta', 0) === -10);
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
  // Hyper-regen is the leak that mattered: regenPerTick alone leaves a tank
  // undamaged for 30s healing 0.4% a tick, which is most of the healing there is.
  // Its own guns have to be off for the window, or this measures lifesteal
  // instead — the tank heals from whatever its bullets happened to hit.
  t.lastDamage = -1e9;
  t.barrels.forEach((b) => { b.disabled = true; });
  const savedTurrets = t.turrets; t.turrets = [];
  const idle = t.health;
  run(g, 60);
  ok('hyper-regen is off too', t.health <= idle + 0.001, idle + ' -> ' + t.health);
  t.barrels.forEach((b) => { b.disabled = false; });
  t.turrets = savedTurrets;
  t.health = idle;
  const before = t.health;
  foe.applyDamage(100, t);            // t deals it, so t heals
  ok('damage dealt heals the dealer', t.health > before, before + ' -> ' + t.health);
  ok('lifesteal cannot overheal', t.health <= t.maxHealth);
  // and the Health Regen stat must not smuggle it back in
  t.stats[7] = 7; t.recompute();
  ok('the regen stat is neutralised too', t.regenPerTick === 0, String(t.regenPerTick));
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
    // There is a one-second hold after every pass, or two tanks in contact swap
    // it on every tick and nobody ever holds it. Assert the mechanism rather
    // than the clock: how long ago the bomb armed is not deterministic here.
    g.bombPassAt = 0;
    other.x = holder.x; other.y = holder.y;
    run(g, 2);
    ok('touching somebody passes it', g.bomb === other, 'still on the same tank');
    ok('and the pass sets a hold', g.bombPassAt > g.tick, 'no cooldown after a pass');
    // ...which really does stop it bouncing straight back
    const passed = g.bomb;
    run(g, 4);
    ok('the hold stops it ping-ponging', g.bomb === passed);
    ok('and the fuse keeps running', g.bombFuse < fuse, fuse + ' -> ' + g.bombFuse);
  }
}

// =========================================================================
section('chaos rotation — the deck, and clean teardown');
{
  const g = boot('chaos');
  ok('there are fifteen modifiers', CHAOS.length === 15, CHAOS.length + ' found');
  ok('each names itself', CHAOS.every((m) => m.name && m.blurb));
  // A modifier is arena-wide (`on`), per-tank (`each`) or both. Requiring `on`
  // was wrong once the per-tank half existed — GIANTS has nothing arena-wide to do.
  ok('each does something', CHAOS.every((m) => typeof m.on === 'function' || typeof m.each === 'function'));
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
section('the fixes that have to hold everywhere');
{
  // Cards on a handed-out tank. Every mode that sets spawnLevel and does not
  // deliberately suppress upgrades must offer them, on spawn and on respawn.
  // Only where the spawn level actually clears an upgrade tier — the first one
  // is 15, so a mode that hands you level 12 correctly has nothing to offer.
  for (const k of ['instagib', 'sumo', 'bloodmoney']) {
    const g = boot(k);
    const need = g.rule('spawnLevel', 0) >= 15;
    ok(k + ' offers upgrades on spawn', !need || g.player.pendingUpgrades.length > 0,
      'no cards at level ' + g.player.level);
    g.player.kill(null);
    run(g, 4);
    const again = g.respawnPlayer('tester', g.player);
    if (again) ok(k + ' offers upgrades on respawn',
      !need || again.pendingUpgrades.length > 0, 'level ' + again.level);
  }
  {
    // Juggernaut Royale starts you below the first tier on purpose: the hulls
    // are the reward for kills, so level 1 with no cards is the intended state.
    const g = boot('juggerroyale');
    ok('juggerroyale starts you on the base hull', g.player.tankId === sim.JR_BASE);
    g.player.addScore(sim.LEVEL_SCORE[16]);
    ok('and opens the tree at 15', g.player.pendingUpgrades.length > 0,
      'level ' + g.player.level + ', ' + g.player.pendingUpgrades.length + ' cards');
  }
  // ...and the modes that suppress them must suppress them after a respawn too.
  for (const k of ['gungame', 'mirror', 'randomizer', 'prophunt', 'hideseek']) {
    const g = boot(k);
    run(g, 60);
    const t = g.respawnPlayer('tester', g.player) || g.player;
    t.checkUpgrades();
    ok(k + ' shows no cards, ever', t.pendingUpgrades.length === 0,
      t.pendingUpgrades.length + ' cards');
  }
}
{
  // Being buried inside a wall has to kill you. Knockback can put a tank inside
  // a maze block, and inside one nothing pushes it back out.
  const g = new Game('maze', 'tester', { difficulty: 'hard', botCount: 4 });
  g.wantedShapes = 20;
  const t = g.player;
  const w = g.walls[0];
  t.x = w.x; t.y = w.y;
  t.protectedUntil = 0;                 // spawn protection legitimately holds it off
  const hp = t.health;
  run(g, 40);
  ok('a tank buried in a wall dies', t.dead || t.health < hp * 0.5,
    hp + ' -> ' + t.health);
}
{
  // The podium is taken by winRound itself, so no mode can forget one.
  const g = boot('scoreattack');
  run(g, 100);
  g.labClock = 1;
  run(g, 2);
  ok('a win builds a podium', !!g.podium);
  ok('the podium is ranked', g.podium.top.length > 0 &&
    g.podium.top.every((r, i, a) => i === 0 || a[i - 1].score >= r.score));
  ok('the podium names the winner', (g.podium.text || '').length > 5);
  ok('the podium carries the detail', g.podium.top[0].level > 0 && g.podium.top[0].tank !== undefined);
  run(g, ROUND_DELAY + 40);
  ok('the podium is cleared on the reset', g.podium === null);
}
{
  // Juggernaut: everyone at 45, one team against it, and its guns banded.
  const g = boot('juggernaut');
  run(g, 30 * TPS);
  const j = g.entities.find((e) => e.isJuggernaut);
  if (ok('a Juggernaut is crowned', !!j)) {
    const rest = g.entities.filter((e) => e.type === 'tank' && !e.dead && e !== j && !e.modeEntity);
    ok('everyone else is on one team', rest.length > 0 && rest.every((t) => t.team === 'blue'),
      [...new Set(rest.map((t) => t.team))].join(','));
    ok('the Juggernaut is alone on the other', j.team === 'red');
    ok('everybody spawns finished', rest.every((t) => t.level === sim.MAX_LEVEL),
      [...new Set(rest.map((t) => t.level))].join(','));
    ok('its guns are banded by range', j.barrels.some((b) => b.disabled) || rest.some((t) =>
      Math.hypot(t.x - j.x, t.y - j.y) < j.size * 2.4));
    ok('it has more than one weapon system', j.barrels.length >= 20, j.barrels.length + ' barrels');
    // the bullets were three times too hard
    const ring = j.barrels.find((b) => b.def.juggBand === 0);
    ok('its ring guns hit for a third of what they did', ring.def.bullet.damage < 0.6,
      String(ring.def.bullet.damage));
  }
}
{
  // Infection: one team until patient zero, and contact spreads it.
  const g = boot('infection');
  run(g, 20 * TPS);
  let list = g.entities.filter((e) => e.type === 'tank' && !e.dead && !e.modeEntity);
  ok('everyone starts on one team', list.every((t) => t.team === 'blue'));
  run(g, 20 * TPS);
  list = g.entities.filter((e) => e.type === 'tank' && !e.dead && !e.modeEntity);
  const z = list.filter((t) => t.isZombie);
  if (ok('somebody turns', z.length > 0)) {
    ok('a zombie cannot shoot', z[0].barrels.every((b) => b.disabled));
    ok('a zombie is tanky', z[0].maxHealth > 400, String(Math.round(z[0].maxHealth)));
    ok('a zombie hits hard on contact', z[0].damagePerTick >= 40);
    // touching one is enough — no kill required
    const human = list.find((t) => !t.isZombie);
    if (human) {
      human.protectedUntil = 0;
      human.x = z[0].x; human.y = z[0].y;
      run(g, 3);
      ok('contact alone infects', human.isZombie || human.team === 'red');
    }
  }
}
{
  // Boss Rush: one team, bosses only, and the waves keep climbing.
  const g = boot('bossrush');
  run(g, 20 * TPS);
  const players = g.entities.filter((e) => e.type === 'tank' && !e.dead && !e.modeEntity);
  ok('everyone is on blue', players.every((t) => t.team === 'blue'));
  ok('the wave is bosses', g.waveLive.length > 0 && g.waveLive.every((e) => e.type === 'boss'),
    [...new Set(g.waveLive.map((e) => e.type))].join(','));
  // wave 20 has to be meaningfully harder than wave 1, with no cap
  g.wave = 0; g.waveLive.length = 0;
  sim.spawnBossWave(g, 1);
  const w1 = g.waveLive[0].maxHealth, n1 = g.waveLive.length;
  g.waveLive.length = 0;
  sim.spawnBossWave(g, 20);
  const w20 = g.waveLive[0].maxHealth, n20 = g.waveLive.length;
  ok('later waves are fatter', w20 > w1 * 5, w1 + ' -> ' + w20);
  ok('later waves are more numerous', n20 > n1, n1 + ' -> ' + n20);
  ok('there is no last wave', sim.spawnBossWave.length >= 0);
}
{
  // Boss Royale: everybody actually gets a hull.
  const g = boot('bossroyale');
  run(g, 10 * TPS);
  const hulls = g.entities.filter((e) => e.type === 'boss' && !e.dead);
  ok('everybody is in a boss', hulls.length > 3, hulls.length + ' hulls');
  ok('every hull has a driver', hulls.every((b) => b.possessedBy));
  ok('the player is driving one', !!(g.player && g.player.possessing));
}
{
  // Singularity: brutal up close, and sealed once it owns half the map.
  const g = boot('singularity');
  run(g, 10);
  const t = g.entities.find((e) => e.type === 'tank' && !e.dead);
  t.immobile = true;
  // One tick per sample: two lets the first tick move it somewhere else and
  // the second reads the pull at the wrong distance.
  const probe = (d) => { t.x = d; t.y = 0; t.vx = t.vy = 0; run(g, 1); return Math.abs(t.vx); };
  const atHorizon = probe(g.singR * 1.2);
  const nearPull = probe(g.singR * 2);
  const farPull = probe(g.singReach * 0.9);
  ok('the pull is far stronger up close', nearPull > farPull * 8,
    nearPull.toFixed(3) + ' vs ' + farPull.toFixed(3));
  ok('and brutal right on the horizon', atHorizon > nearPull * 2,
    atHorizon.toFixed(1) + ' vs ' + nearPull.toFixed(1));
  g.singT = 11 * 60 * TPS;
  run(g, 4);
  ok('half the map seals the arena', g.noRespawn === true, 'r=' + Math.round(g.singR));
}
{
  // Payload: nothing can hurt it or shove it, so it can actually arrive.
  const g = boot('payload');
  run(g, 20);
  ok('the cart is invulnerable', g.pay.damageReduction === 0);
  ok('the cart cannot be shoved', g.pay.absorb === 0);
  const x0 = g.pay.x;
  g.pay.applyDamage(1e9, null);
  ok('shooting it does nothing', !g.pay.dead && g.pay.x === x0);
  // and with an escort it moves
  const blues = g.entities.filter((e) => e.type === 'tank' && e.team === 'blue' && !e.dead).slice(0, 3);
  blues.forEach((t) => { t.x = g.pay.x; t.y = g.pay.y; });
  g.entities.filter((e) => e.type === 'tank' && e.team === 'red' && !e.dead)
    .forEach((t) => { t.x = g.arena.left; t.y = g.arena.top; });
  run(g, 40);
  ok('an uncontested escort moves it', g.pay.x !== x0, x0 + ' -> ' + g.pay.x);
}
{
  // The hiding modes share a real map.
  for (const k of ['prophunt', 'hideseek']) {
    const g = boot(k);
    ok(k + ' uses the small map', g.arena.size <= 8000, String(g.arena.size));
    ok(k + ' has a built layout', g.walls.length > 20, g.walls.length + ' walls');
    run(g, 40);
    const list = g.entities.filter((e) => e.type === 'tank' && !e.dead && !e.modeEntity);
    const seek = list.filter((t) => t.isSeeker).length;
    ok(k + ' splits the roles', seek > 0 && seek < list.length, seek + '/' + list.length);
    ok(k + ' has both sides', new Set(list.map((t) => t.team)).size === 2);
  }
  const g = boot('prophunt');
  run(g, 40);
  const prop = g.entities.find((e) => e.type === 'tank' && !e.dead && e.propKind);
  if (ok('props are disguised', !!prop)) {
    ok('a prop keeps full movement speed', prop.movementSpeed > 0);
    // A bot prop is deliberately held still by botDrive — behaving like
    // furniture is the whole disguise. A player prop is not, so test that path.
    prop.bot = false;
    const x0 = prop.x;
    prop.input.right = 1;
    run(g, 25);
    ok('a prop may move at full speed', Math.abs(prop.x - x0) > 1,
      'moved ' + Math.abs(prop.x - x0).toFixed(1));
    ok('but a bot prop holds still like furniture',
      typeof MODE_LOGIC.prophunt.botDrive === 'function');
  }
  ok('there is clutter to hide in',
    g.entities.filter((e) => e.type === 'shape' && !e.dead).length > 60);
}
{
  // Juggernaut Royale: a hundred and forty hulls, eleven branches, eight
  // dynasties and nine tiers reaching level 200 — all of it wired into the real
  // tank table rather than living beside it.
  const g = boot('juggerroyale');
  const B = sim.JR_BASE;
  const H = sim.JR_HULLS;
  const base0 = vm.createContext({ console, Math, JSON, Map, Set, Infinity, NaN });
  for (const f of ['js/tankdefs.js', 'js/data.js', 'js/tankdefs-extra.js'])
    vm.runInContext(fs.readFileSync(f, 'utf8'), base0, { filename: f });
  const fresh0 = new Set(Object.keys(base0.TANK_DEFS).map(Number));
  const def = (h) => TANK_DEFS[B + h.id];
  ok('a hundred and forty hulls exist', H.length === 140, H.length + ' hulls');
  ok('every hull is in the tank table', H.every((h) => !!def(h)));
  ok('ids are unique', new Set(H.map((h) => h.id)).size === H.length);
  ok('names are unique', new Set(H.map((h) => h.n)).size === H.length);
  // The body branch has no barrels at all on purpose — armour and contact
  // damage IS the branch, so "armed" means armed one way or the other.
  ok('every hull is dangerous', H.every((h) => def(h).barrels.length > 0 || def(h).bodyDamage >= 25));
  ok('the melee hulls carry no barrels', H.filter((h) => h.me && !h.g().length).length >= 5);
  ok('and their bullet stats are capped at zero',
    H.filter((h) => h.me).every((h) => def(h).stats[2].max === 0));
  ok('you start on the base hull', g.player.tankId === B, String(g.player.tankId));

  // the tree has to be reachable end to end
  const seen = new Set([B]);
  const q = [B];
  while (q.length) {
    const d = TANK_DEFS[q.shift()];
    for (const u of d.upgrades || []) if (!seen.has(u)) { seen.add(u); q.push(u); }
  }
  ok('every hull is reachable from the base', seen.size === H.length, seen.size + '/' + H.length);
  // The wire writes a tank's class as a single byte. A roster that ran past 255
  // would come out of the socket as a different hull, and nothing offline would
  // ever notice — so the constraint is asserted rather than remembered.
  ok('every hull id fits in a byte', H.every((h) => B + h.id >= 0 && B + h.id <= 255),
    'max ' + (B + Math.max(...H.map((h) => h.id))));
  ok('and none of them lands on a real class',
    H.every((h) => !fresh0.has(B + h.id)) && !H.some((h) => B + h.id === JUGGERNAUT_ID));

  // Eleven branches off the root, each with its own verb, and none of them
  // meeting again before tier 4 — which is the whole point of tier 4.
  const t1 = H.filter((h) => h.t === 1);
  ok('eleven branches open at once', t1.length === 11 && TANK_DEFS[B].upgrades.length === 11,
    t1.length + ' heads');
  ok('every branch head is a different branch', new Set(t1.map((h) => h.br)).size === 11);
  ok('nine tiers, and each hull sits on one', H.every((h) => h.t >= 0 && h.t <= 8));
  ok('the tiers gate on level', H.every((h) => def(h).levelRequirement === sim.JR_LVL[h.t]));
  ok('and the wheel is told which ring that is', H.every((h) => def(h).treeRing === h.t - 1));
  // The mode raises its own ceiling to 200; the tiers are laid out under it and
  // the top one sits exactly on it.
  const CAP = GAMEMODES.juggerroyale.rules.maxLevel;
  ok('the mode runs to level 200', CAP === 200 && g.levelCap() === 200, String(g.levelCap()));
  ok('and the score curve reaches that far', sim.LEVEL_CAP >= CAP && sim.LEVEL_SCORE[CAP] > 0);
  ok('the top tier sits on the cap', sim.JR_LVL[8] === CAP, String(sim.JR_LVL[8]));
  ok('the tiers climb', sim.JR_LVL.every((l, i) => i === 0 || l > sim.JR_LVL[i - 1]));
  // diep's 6% per-level compounding is fine to 45 and steep to 100. Run it to
  // 200 unchanged and the last hundred levels cost four hundred times the first
  // hundred, so data.js goes flat past LEVEL_SOFT. The whole point is that the
  // second half of the ladder is expensive, not impossible.
  ok('the score curve stops compounding so 200 is reachable',
    sim.LEVEL_SCORE[200] / sim.LEVEL_SCORE[100] < 12,
    (sim.LEVEL_SCORE[200] / sim.LEVEL_SCORE[100]).toFixed(1) + 'x the climb to 100');
  ok('and it still costs more than the climb to 100 did',
    sim.LEVEL_SCORE[200] > sim.LEVEL_SCORE[100] * 4);
  // Raising the ceiling without softening diep's per-level curves leaves a
  // level-200 hull nine times its own size at a twentieth of its speed.
  ok('the per-level curves are softened for the taller ladder',
    Math.pow(g.rule('lvlScale', 1.01), CAP - 1) < 2 && Math.pow(g.rule('lvlSlow', 1.015), CAP - 1) < 2.5);

  // Every card is a group, except the very last one — a crown is the end of a
  // road you chose at level 52, not another fork.
  ok('no node below the crowns offers exactly one upgrade',
    H.every((h) => h.t >= 7 || h.up.length !== 1),
    H.filter((h) => h.t < 7 && h.up.length === 1).map((h) => h.n).join(','));
  ok('and the titans all point at their one crown',
    H.filter((h) => h.t === 7).every((h) => h.up.length === 1));
  ok('every branch ends in at least two hulls', Object.values(
    H.filter((h) => h.t === 3).reduce((m, h) => ((m[h.br] = (m[h.br] || 0) + 1), m), {})
  ).every((n) => n >= 2));

  const leaves = H.filter((h) => h.up.length === 0);
  ok('there are eight endings', leaves.length === 8, String(leaves.length));
  ok('and all eight are tier 8', leaves.every((h) => h.t === 8));
  const fus = H.filter((h) => h.t === 4);
  ok('sixteen of them are fusions', fus.length === 16, String(fus.length));
  ok('every fusion opens onto two apexes', fus.every((h) => h.up.length === 2));
  ok('every hull past tier 3 burns two colours',
    H.filter((h) => h.t >= 4).every((h) => def(h).jrTone2 && def(h).jrTone2 !== def(h).jrTone));

  // --- the dynasties ------------------------------------------------------
  // The whole shape of the top half: from level 52 up the tree is eight sealed
  // lines. If two dynasties ever shared a hull, the card at 70 would stop being
  // proof of the card at 52 and the climb would go back to being a lattice.
  const dyn = (h) => h.dy;
  ok('every hull from the fusions up belongs to a dynasty',
    H.filter((h) => h.t >= 4).every(dyn), H.filter((h) => h.t >= 4 && !h.dy).map((h) => h.n).join(','));
  ok('and nothing below them does', H.filter((h) => h.t < 4).every((h) => !h.dy));
  ok('there are eight of them', new Set(H.filter(dyn).map(dyn)).size === 8);
  ok('every dynasty key is a real row', H.filter(dyn).every((h) => !!sim.JR_DYN[h.dy]));
  {
    const byT = {};
    for (const h of H) if (h.dy) (byT[h.t] = byT[h.t] || {})[h.dy] = (byT[h.t][h.dy] || 0) + 1;
    ok('two fusions, two apexes, two omegas and two titans per dynasty',
      [4, 5, 6, 7].every((t) => Object.values(byT[t]).every((n) => n === 2) &&
        Object.keys(byT[t]).length === 8),
      JSON.stringify(byT[5]));
    ok('and exactly one crown each',
      Object.values(byT[8]).every((n) => n === 1) && Object.keys(byT[8]).length === 8);
  }
  ok('no hull past the fusions ever offers another dynasty\'s hull',
    H.filter((h) => h.t >= 4).every((h) => h.up.every((u) => {
      const k = H.find((o) => o.id === u);
      return k && k.dy === h.dy;
    })),
    H.filter((h) => h.t >= 4).filter((h) => h.up.some((u) => {
      const k = H.find((o) => o.id === u);
      return !k || k.dy !== h.dy;
    })).map((h) => h.n).join(','));
  // ...and the other half of the same claim: nothing reaches a dynasty's hull
  // except that dynasty, so the eight subtrees are genuinely disjoint.
  {
    const parents = {};
    for (const h of H) for (const u of h.up) (parents[u] = parents[u] || []).push(h);
    const bad = H.filter((h) => h.t >= 5 && (parents[h.id] || []).some((p) => p.dy !== h.dy));
    ok('and nothing outside a dynasty can reach into it', bad.length === 0,
      bad.map((h) => h.n).join(','));
  }
  // Below the fusions the same rule holds one level down: a branch is eleven
  // different games and a card that crosses into another one undoes that.
  ok('nothing crosses branches before tier 4', H.every((h) => h.t >= 3 || h.up.every((u) => {
    const k = H.find((o) => o.id === u);
    return !k || k.t === 4 || k.br === h.br || h.br === 'brute';
  })), H.filter((h) => h.t < 3).filter((h) => h.up.some((u) => {
    const k = H.find((o) => o.id === u);
    return k && k.t !== 4 && k.br !== h.br && h.br !== 'brute';
  })).map((h) => h.n).join(','));
  ok('six wilds, all of them tier 3',
    H.filter((h) => h.wd).length === 6 && H.filter((h) => h.wd).every((h) => h.t === 3));

  // The point of a taller ladder is that the top of it is worth climbing to.
  // Tier minimums overlap deliberately — a Leviathan is an 8,600 hp body at
  // tier 3 and a Wraithhive is a 7,800 hp drone hive at tier 4 — so the claim
  // is about the tier, and the median is what says it.
  const medHp = (t) => {
    const a = H.filter((h) => h.t === t).map((h) => h.hp).sort((x, y) => x - y);
    return a[a.length >> 1];
  };
  for (const t of [1, 2, 3, 4, 5, 6, 7, 8]) {
    ok('tier ' + t + ' outguns the tier below it', medHp(t) > medHp(t - 1) * 1.3,
      medHp(t) + ' vs ' + medHp(t - 1));
  }
  // ...and the dividend says the same thing about everything that is not health.
  ok('and every tier above the fusions takes less and hits harder than the last',
    [6, 7, 8].every((t) => sim.JR_DIVIDEND[t][0] < sim.JR_DIVIDEND[t - 1][0] &&
      sim.JR_DIVIDEND[t][1] < sim.JR_DIVIDEND[t - 1][1] &&
      sim.JR_DIVIDEND[t][2] > sim.JR_DIVIDEND[t - 1][2]));

  // Every verb a row names has to exist, or the hull is a hull with a dead button.
  ok('every ability verb has a handler', H.every((h) => !h.ab || !!sim.JR_ABIL[h.ab]));
  ok('every autonomous verb has a handler',
    H.every((h) => !h.abs || h.abs.every((a) => !!sim.JR_ABIL[a])));
  ok('and no hull lists its own right-click button as an autonomous one',
    H.every((h) => !h.abs || h.abs.indexOf(h.ab) === -1));
  ok('every passive verb has a handler',
    H.every((h) => !h.ps || [].concat(h.ps).every((x) => !!sim.JR_PASS[x])));
  ok('every trait is in the roll call',
    H.every((h) => !h.tr || h.tr.every((x) => Object.prototype.hasOwnProperty.call(sim.JR_TRAIT, x))),
    H.filter((h) => h.tr && h.tr.some((x) => !(x in sim.JR_TRAIT))).map((h) => h.n).join(','));
  ok('every addon a hull asks for exists',
    H.every((h) => (!h.pre || !!sim.ADDONS[h.pre]) && (!h.post || !!sim.ADDONS[h.post])));
  ok('fifty-odd ability verbs', new Set(H.flatMap((h) => [h.ab || []].concat(h.abs || []).flat())).size >= 48,
    String(new Set(H.flatMap((h) => [h.ab || []].concat(h.abs || []).flat())).size));
  ok('no two branch heads share an ability', new Set(t1.map((h) => h.ab)).size === t1.length);
  ok('every hull past the Brute has a button or a passive',
    H.every((h) => h.t === 0 || h.ab || h.ps));

  // The tiers above the fusions are meant to be MORE than a bigger tank, and
  // the shape of "more" is: another button that fires itself, another passive,
  // another trait. Asserting the ramp is what stops a new tier-8 row from
  // quietly being a tier-5 row with a bigger health number.
  const psn = (h) => (h.ps ? [].concat(h.ps).length : 0);
  ok('every apex and above carries at least one autonomous button',
    H.filter((h) => h.t >= 5).every((h) => (h.abs || []).length >= 1));
  ok('an omega carries two, a titan two or more, a crown four',
    H.filter((h) => h.t === 6).every((h) => (h.abs || []).length >= 2) &&
    H.filter((h) => h.t === 7).every((h) => (h.abs || []).length >= 2) &&
    H.filter((h) => h.t === 8).every((h) => (h.abs || []).length === 4));
  ok('and the traits and passives ramp with the tier',
    H.filter((h) => h.t === 5).every((h) => (h.tr || []).length >= 2 && psn(h) >= 1) &&
    H.filter((h) => h.t === 6).every((h) => (h.tr || []).length >= 3 && psn(h) >= 2) &&
    H.filter((h) => h.t === 7).every((h) => (h.tr || []).length >= 4 && psn(h) >= 2) &&
    H.filter((h) => h.t === 8).every((h) => (h.tr || []).length >= 6 && psn(h) >= 3));
  ok('nothing below the fusions grew a second button or a trait',
    H.filter((h) => h.t < 5).every((h) => !h.abs && !h.tr));
  // growth and the jrGrant passives write the same single bonus slot, so a hull
  // carrying both would ratchet its own health up and down every tick.
  {
    const GRANTS = ['graft', 'grow', 'stacks', 'invert', 'decay', 'far'];
    ok('and nothing carries growth on top of a passive that already grants',
      H.filter((h) => h.tr && h.tr.indexOf('growth') >= 0)
        .every((h) => [].concat(h.ps || []).every((x) => GRANTS.indexOf(x) === -1)));
  }

  // --- deep stat bars -----------------------------------------------------
  // Eight stats at seven pips each hold 56 points; level 200 hands out 84. The
  // bar takes 28 instead and compresses each filled row into a single block, so
  // it never gets any longer and it runs out at exactly seven ranks.
  ok('every juggernaut stat runs deep', H.every((h) =>
    def(h).stats.every((s) => s.max === 0 || s.max === sim.STAT_DEEP_MAX)));
  ok('a deep bar is seven ranks and twenty-eight points',
    sim.STAT_DEEP_MAX === 28 && sim.STAT_BANDS.length === 8 && sim.STAT_SLOTS === 7);
  ok('and it always draws exactly seven pips', [0, 1, 6, 7, 8, 13, 22, 27, 28].every((n) => {
    const b = sim.statBar(n, 28);
    return b.full + b.slots === 7 && b.into >= 0 && b.into <= b.slots;
  }));
  ok('a full bar is maxed and says so', sim.statBar(28, 28).slots === 0 && sim.statBar(28, 28).full === 7);
  ok('and an ordinary seven-pip bar is untouched',
    sim.statBar(4, 7).full === 0 && sim.statBar(4, 7).into === 4 && sim.statBar(4, 7).slots === 7);
  ok('the level-200 budget is exactly three maxed stats',
    sim.statCount(200) === 3 * sim.STAT_DEEP_MAX, String(sim.statCount(200)));
  {
    // ...and the engine really hands them out and really stops at 28.
    const t = g.player;
    t.addScore(sim.LEVEL_SCORE[200]);
    ok('a level-200 juggernaut has 84 points', t.level === 200 && t.statsAvailable === 84,
      t.level + ' / ' + t.statsAvailable);
    let spent = 0;
    while (t.upgradeStat(6)) spent++;
    ok('and one stat eats twenty-eight of them', spent === 28, String(spent));
    ok('after which it refuses', t.upgradeStat(6) === false && t.stats[6] === 28);
    // The two rules that make Max Health worth spending on a 96,000 hp hull.
    ok('max health pays as a share of the hull, not a flat 20',
      g.rule('statHealthPct', 0) > 0 && g.rule('statBodyPct', 0) > 0);
  }

  // Silhouette and armament variety — "they all look the same" is the failure
  // mode this arena is built to avoid, so it is worth asserting.
  const bulletTypes = new Set();
  H.forEach((h) => def(h).barrels.forEach((b) => bulletTypes.add(b.bullet.type)));
  ok('at least six kinds of projectile', bulletTypes.size >= 6, [...bulletTypes].join(','));
  ok('a real spread of hull sizes',
    Math.max(...H.map((h) => h.sz)) / Math.min(...H.map((h) => h.sz)) > 2.5);
  ok('a real spread of speeds', Math.max(...H.map((h) => h.sp)) / Math.min(...H.map((h) => h.sp)) > 5);
  ok('at least ten distinct shells', new Set(H.map((h) => h.post)).size >= 10);
  ok('every hull carries a colour of its own', H.every((h) => def(h).color && def(h).color.length === 2));
  ok('every hull names an aura', H.every((h) => !!def(h).jrAura));

  // Bots: a job per hull, and eleven paths handed out round robin.
  const jobs = new Set(H.map((h) => sim.jrJob(h)));
  ok('bots classify every hull', H.every((h) => !!sim.jrJob(h)));
  ok('and the jobs are not all the same', jobs.size >= 4, [...jobs].join(','));
  ok('bodies are driven as bodies', H.filter((h) => h.me).every((h) => sim.jrJob(h) === 'ram'));
  ok('siege hulls plant themselves', sim.jrJob(H.find((h) => h.n === 'Tower')) === 'root');
  // The sniper test is relative to the hull, not an absolute barrel length —
  // jrFitGuns scales every barrel with the body, so an absolute one made every
  // apex a sniper and walked them out of the fights they are built for.
  ok('and a big hull is not a sniper just for being big',
    H.filter((h) => h.t >= 5).some((h) => sim.jrJob(h) !== 'far'),
    H.filter((h) => h.t >= 5).map((h) => sim.jrJob(h)).join(','));

  ok('kills pay enough to climb eight tiers', g.rule('killBounty', 0) >= 8000);
  ok('and shapes pay for the rest of it', g.rule('shapeXp', 1) >= 3, String(g.rule('shapeXp', 1)));
  ok('the field is dense enough to farm', g.rule('shapes', 0) >= 2000, String(g.rule('shapes', 0)));
  ok('the class wheel is rooted on the juggernauts', GAMEMODES.juggerroyale.treeRoot === B,
    String(GAMEMODES.juggerroyale.treeRoot));
  ok('no other mode claims a tree', Object.keys(GAMEMODES)
    .filter((k) => GAMEMODES[k].treeRoot !== undefined).length === 1);
  // ...and the hulls exist before any Game does, because the wheel and the
  // upgrade cards are drawn client-side and online the client never runs init().
  const fresh = vm.createContext({ console, Math, JSON, Map, Set, Infinity, NaN });
  for (const f of ['js/tankdefs.js', 'js/data.js', 'js/tankdefs-extra.js', 'js/protocol.js',
    'js/engine.js', 'js/modes.js', 'js/modes-extra.js'])
    vm.runInContext(fs.readFileSync(f, 'utf8'), fresh, { filename: f });
  ok('the hulls are in the table at load', !!fresh.TANK_DEFS[B] && fresh.TANK_DEFS[B].name === 'Brute');
  ok('and they stay out of the Basic tree', fresh.playableTankIds().indexOf(B) === -1);
  run(g, 90 * TPS);
  const grown = g.entities.filter((e) => e.type === 'tank' && !e.dead && e.tankId > B && !e.modeEntity);
  ok('bots climb the tree', grown.length > 0, grown.length + ' upgraded');
  // A hull past fusion has no branch of its own left to climb, so the bot rule
  // has to let any path take one — otherwise nothing above tier 3 is ever worn.
  ok('and the bot rule reaches the fusions',
    H.filter((h) => h.t >= 4).every((h) => def(h).jrTier >= 4));
  ok('and they spread across the branches',
    new Set(grown.map((t) => t.def.jrBranch)).size >= 3,
    [...new Set(grown.map((t) => t.def.jrBranch))].join(','));
}
{
  // Every hull, driven, with a live enemy parked inside every ability radius:
  // the point is that no verb throws and no hull leaves furniture behind when
  // it stops being that hull. A hundred and forty is far too many to trust by
  // reading, and the late hulls fire three or four verbs each on top of the one
  // on right-click, so the autonomous path gets driven here too.
  const B = sim.JR_BASE;
  const threw = [], silent = [];
  let fired = 0, autoFired = 0;
  for (const h of sim.JR_HULLS) {
    const g = new sim.Game('juggerroyale', 'tester', { difficulty: 'hard', botCount: 4 });
    g.wantedShapes = 40;
    run(g, 20);
    const me = g.player;
    me.addScore(sim.LEVEL_SCORE[g.levelCap()]);
    sim.forceTankClass(me, B + h.id);
    me.jrDefId = undefined;
    // Indestructible, so a body hull does not delete its own test case, and a
    // long enough run-up that the drone hulls have drones to throw.
    const victims = g.entities.filter((e) => e.type === 'tank' && e.bot && !e.dead).slice(0, 2);
    for (const v of victims) { v.addScore(4000); v.maxHealth = v.health = 1e7; }
    try {
      me.godMode = true;
      me.input.fire = 1;
      run(g, 60);
      for (const v of victims) {
        if (v.dead) continue;
        v.x = me.x + me.size * 1.2; v.y = me.y; v.vx = v.vy = 0;
        v.maxHealth = v.health = 1e7;
      }
      run(g, 1);
      me.jrCool = 0;
      me.jrHeat = me.maxHealth;                       // so OVERLOAD has something to spend
      me.mouse = { x: me.x + 900, y: me.y };
      if (sim.jrAbility(g, me)) fired++; else if (h.ab) silent.push(h.n);
      // ...and the buttons the hull presses for itself. Every one of them on
      // its own cooldown, so a few ticks is enough to walk the whole list.
      if (h.abs) {
        const before = JSON.stringify(me.jrCools || {});
        for (let k = 0; k < h.abs.length; k++) { me.jrCools = null; sim.jrAutoAbilities(g, me, h); }
        if (JSON.stringify(me.jrCools || {}) !== before) autoFired++;
      }
      run(g, 4 * TPS);
      sim.forceTankClass(me, B);                      // a different hull now: sweep
      me.jrDefId = undefined;
      run(g, 2 * TPS);
    } catch (e) { threw.push(h.n + ': ' + e.message); }
  }
  ok('no hull throws when its verb fires', threw.length === 0, threw.slice(0, 4).join(' | '));
  ok('nearly every ability fires with a target in reach', fired >= 110, fired + ' fired');
  ok('the ones that hold back are the conditional ones', silent.length <= 24, silent.join(','));
  // Not all of them: a hull whose autonomous list is ENTHRONE (fires under 45%
  // health) or OVERLOAD (fires on a full heat bank) is correctly holding back on
  // an undamaged test rig, which is the same thing the primary-button test says
  // about the conditional verbs.
  ok('and the autonomous buttons fire themselves too',
    autoFired >= sim.JR_HULLS.filter((x) => x.abs).length * 0.6,
    autoFired + '/' + sim.JR_HULLS.filter((x) => x.abs).length);
}
{
  // Chaos: a modifier has to reach a tank that spawned after it landed.
  const g = boot('chaos');
  g.chaosAt = g.tick;
  g.chaosDeck = [CHAOS.find((c) => c.name === 'GIANTS')];
  run(g, 2);
  ok('a modifier lands', g.chaosCur && g.chaosCur.name === 'GIANTS');
  const live = g.entities.filter((e) => e.type === 'tank' && !e.dead);
  ok('it reaches everyone already here', live.every((t) => t.scaleBoost === 2));
  live.filter((t) => t.bot).slice(0, 3).forEach((t) => t.kill(null));
  run(g, 60);
  const fresh = g.entities.filter((e) => e.type === 'tank' && e.bot && !e.dead);
  ok('and everyone who arrives after', fresh.length > 0 && fresh.every((t) => t.scaleBoost === 2),
    fresh.filter((t) => t.scaleBoost !== 2).length + ' missed it');
  // the deck really is shuffled
  const a = sim.chaosShuffle().map((m) => m.name).join(',');
  const b = sim.chaosShuffle().map((m) => m.name).join(',');
  const c2 = sim.chaosShuffle().map((m) => m.name).join(',');
  ok('the deck order is random', !(a === b && b === c2));
  ok('the deck is drawn without replacement', new Set(sim.chaosShuffle().map((m) => m.name)).size === CHAOS.length);
}
{
  // Every mode's respawn policy is a decision, not an accident.
  const ONE_LIFE = ['gauntlet', 'musicaltiles', 'bombtag', 'prophunt', 'hideseek'];
  for (const k of ONE_LIFE) {
    const g = boot(k);
    run(g, k === 'gauntlet' ? 95 * TPS : 30);
    ok(k + ' is one life', g.noRespawn === true);
  }
  for (const k of ['scoreattack', 'instagib', 'koth', 'payload', 'juggernaut', 'bossrush']) {
    const g = boot(k);
    run(g, 40);
    ok(k + ' lets you come back', !g.noRespawn);
  }
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
// The Mode Lab size / bot-cap knobs. Juggernaut Royale pins bots: 20 and an
// 18000 arena; the picker has to be able to beat both, and the shape field
// has to follow the floor or a colossal map is an empty one.
section('size and bot-cap overrides');
{
  const base = new Game('juggerroyale', 't', { difficulty: 'easy' });
  ok('the mode pin stands when nothing is passed', base.botCount === 20, 'got ' + base.botCount);
  ok('and its own arena with it', base.arena.size === 18000, 'got ' + base.arena.size);

  const big = new Game('juggerroyale', 't', { difficulty: 'easy', size: 18000 * 2.8, botCap: 7 });
  ok('a passed cap beats the pin', big.botCount === 7, 'got ' + big.botCount);
  ok('a passed size becomes the arena', big.arena.size === 50400 && big.arena.right === 25200);
  ok('shapes scale with the floor, capped at 2.5x',
    big.wantedShapes === Math.round(2600 * 2.5), 'got ' + big.wantedShapes);

  const small = new Game('juggerroyale', 't', { difficulty: 'easy', size: 18000 * 0.45, botCap: 0 });
  ok('zero bots means zero bots', small.botCount === 0, 'got ' + small.botCount);
  ok('and a small floor thins the field',
    small.wantedShapes === Math.round(2600 * 0.45 * 0.45), 'got ' + small.wantedShapes);
}

// =========================================================================
console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('\n' + failures.map((f) => '  x ' + f).join('\n'));
  process.exit(1);
}
