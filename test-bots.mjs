// Bot AI checks. `node test-bots.mjs`
// Same vm-context trick as test.mjs — the browser scripts, no bundler.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ctx = vm.createContext({ console, Math, JSON, Map, Set, Infinity, NaN });
for (const f of ['js/tankdefs.js', 'js/tankdefs-extra.js', 'js/data.js', 'js/protocol.js', 'js/engine.js', 'js/modes.js'])
  vm.runInContext(readFileSync(new URL(f, import.meta.url), 'utf8'), ctx, { filename: f });

const { Game, Entity, Shape, BOT_SKILL, BOT_DIFFICULTIES, botSkill } = ctx;
const { BOT_BUILDS, botClassScore, botReach, botFlightTicks, tickBot, TANK_DEFS, LEVEL_SCORE } = ctx;
const { botScan, botDps, botShouldFight, SHAPES, BOT_SKILL: SK } = ctx;
const { botAimedAt, botShootingAt, botThreatens, botWinOdds, angleDiff, TANK_DEFS: DEFS } = ctx;
const { botClear2, botFarmBudget, SHAPES: SH, respawnLevel, Shape: Sh, REGEN_HP_WAIT } = ctx;
const { BOT_ROLES, botContact, botCanTank, botRole, CONTACT_TOUCHES, botClassify } = ctx;

// A role is rolled at spawn and shifts what a bot wants. Every test that is not
// about roles is measuring the AI itself, so pin the neutral one here and let
// the role tests set it deliberately — a random personality is noise elsewhere.
const ROLE = (k) => BOT_ROLES.filter((r) => r.key === k)[0];
const BALANCED = ROLE('balanced');
const rawSpawnBot = ctx.Game.prototype.spawnBot;
ctx.Game.prototype.spawnBot = function () { const t = rawSpawnBot.call(this); t.botRole = BALANCED; return t; };

// One bot in an empty arena, plus a ring of whatever shapes the caller wants.
function withShapes(difficulty, level, kinds, radius) {
  const g = bare(difficulty, { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.build = BOT_BUILDS.filter((b) => !b.ram)[0];   // pin it: a rammer roll has no gun to measure
  t.addScore(LEVEL_SCORE[level]);
  for (let i = 0; i < 80; i++) for (const w of t.build.order) if (t.upgradeStat(w)) break;
  kinds.forEach((k, i) => {
    const a = (i / kinds.length) * Math.PI * 2;
    const sh = g.add(new Shape(g, k, Math.cos(a) * radius, Math.sin(a) * radius));
    sh.shiny = false;
    sh.scoreReward = SHAPES[k].score;
    sh.health = sh.maxHealth = SHAPES[k].health;
  });
  return { g, t };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

// An empty arena with one bot in it, so nothing wanders into the measurement.
function bare(difficulty, skillOverrides) {
  // headless, like every other setup here: it is the flag that stops the arena
  // spawning a player tank of its own, which otherwise sits at a random spot
  // inside sight range and occasionally becomes the target being measured.
  const g = new Game('sandbox', null, { headless: true, botCount: 0, difficulty });
  g.wantedShapes = 0;
  g.entities = g.entities.filter((e) => e.type !== 'shape');
  if (skillOverrides) g.botSkill = Object.assign({}, g.botSkill, skillOverrides);
  return g;
}
function place(t, x, y) { t.x = t.px = x; t.y = t.py = y; return t; }
function aimAngle(t) { return Math.atan2(t.mouse.y - t.y, t.mouse.x - t.x); }
// botClassify caches the per-class facts the AI reads every tick, and tickBot
// only calls it on a class change — so a test that pokes botScan directly has
// to stand in for that itself.
function setClass(t, n) {
  t.setTank(byName(n).id); t.recompute();
  botClassify(t); t.aiTankId = t.tankId;
  return t;
}
function byName(n) {
  const d = TANK_DEFS.filter(Boolean).filter((x) => x.name === n)[0];
  assert.ok(d, 'no tank called ' + n);
  return d;
}

console.log('\nDifficulty table');
test('every preset defines every knob, and they order easy -> extreme', () => {
  const keys = Object.keys(BOT_SKILL.easy);
  for (const d of BOT_DIFFICULTIES) {
    assert.ok(BOT_SKILL[d], d + ' is missing');
    for (const k of keys) assert.notEqual(BOT_SKILL[d][k], undefined, d + '.' + k + ' is missing');
  }
  const rising = ['lead', 'sight', 'strafe', 'dodge', 'threat', 'sense', 'range'];
  for (let i = 1; i < BOT_DIFFICULTIES.length; i++) {
    const lo = BOT_SKILL[BOT_DIFFICULTIES[i - 1]], hi = BOT_SKILL[BOT_DIFFICULTIES[i]];
    for (const k of rising) assert.ok(hi[k] >= lo[k], `${k} must not fall from ${lo.label} to ${hi.label}`);
    assert.ok(hi.react <= lo.react, 'reaction must not slow down');
    assert.ok(hi.aimErr <= lo.aimErr, 'aim must not get worse');
  }
});

test('custom sliders lerp the presets, 0 = easy and 10 = extreme', () => {
  const all = (v) => ({ aim: v, react: v, dodge: v, move: v, aggro: v, brain: v });
  const lo = botSkill(all(0)), hi = botSkill(all(10)), mid = botSkill(all(5));
  for (const k of ['lead', 'sight', 'dodge', 'strafe', 'threat', 'sense', 'aimErr']) {
    assert.equal(lo[k], BOT_SKILL.easy[k], k + ' at 0 should match Easy');
    assert.equal(hi[k], BOT_SKILL.extreme[k], k + ' at 10 should match Extreme');
  }
  assert.ok(mid.lead > lo.lead && mid.lead < hi.lead, 'mid should land between');
  assert.ok(Number.isInteger(mid.react) && mid.react >= 1, 'react is a tick count');
  assert.equal(botSkill('nonsense').label, 'Medium');   // unknown name falls back
});

console.log('\nStat builds');
test('a level 45 bot spends all 33 points, whatever its build', () => {
  const g = bare('hard');
  for (const build of BOT_BUILDS) {
    const t = g.spawnBot();
    t.build = build;
    t.addScore(LEVEL_SCORE[45]);
    for (let i = 0; i < 300; i++) { g.tick++; tickBot(t); }
    assert.equal(t.level, 45);
    assert.equal(t.statsAvailable, 0, 'build ' + JSON.stringify(build.order) + ' stranded points');
  }
});

test('class choice follows the build the bot committed to', () => {
  const ram = BOT_BUILDS.filter((b) => b.ram)[0], gun = BOT_BUILDS.filter((b) => !b.ram)[0];
  const smasher = TANK_DEFS.filter(Boolean).filter((d) => d.barrels.length === 0)[0];
  const gunner = TANK_DEFS.filter(Boolean).filter((d) => d.barrels.length > 1)[0];
  assert.ok(botClassScore(smasher, ram) > botClassScore(gunner, ram), 'ram build should want the smasher');
  assert.ok(botClassScore(gunner, gun) > botClassScore(smasher, gun), 'gun build should not');
});

console.log('\nAim');
test('lead: Extreme leads a crossing target, Easy fires where it already was', () => {
  for (const [d, leads] of [['easy', false], ['extreme', true]]) {
    const g = bare(d, { aimErr: 0, react: 9999, strafe: 0 });
    const t = place(g.spawnBot(), 0, 0);
    const foe = place(g.spawnBot(), 300, 0);       // inside a basic Tank's 500-unit carry
    foe.vy = 9; foe.vx = 0;
    t.aiTarget = foe;
    g.tick = 1; tickBot(t);
    const off = aimAngle(t);                       // straight at it would be 0
    if (leads) assert.ok(off > 0.05, 'Extreme should aim ahead of it, got ' + off.toFixed(3));
    else assert.equal(off, 0, 'Easy should aim straight at it');
  }
});

test('the flight-time model matches the bullets the sim actually fires', () => {
  // Every aiming bug so far came from a ballistics model that did not describe
  // the simulation. So check it against one: fire a bullet, watch it fly.
  const g = bare('hard', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.bot = false;                          // drive it by hand, not through tickBot
  t.autoFire = true;
  t.mouse.x = t.x + 4000; t.mouse.y = t.y;
  let shot = null;
  for (let i = 0; i < 200 && !shot; i++) { g.step(); shot = g.entities.filter((e) => e.type === 'bullet')[0]; }
  assert.ok(shot, 'expected a bullet');
  const start = shot.x;
  const marks = [400, 800, 1200];
  const seen = {};
  let n = 0;
  while (!shot.dead && n < 200) {
    g.step(); n++;
    for (const m of marks) if (seen[m] === undefined && shot.x - start >= m) seen[m] = n;
  }
  for (const m of marks) {
    assert.notEqual(seen[m], undefined, `bullet never reached ${m}`);
    const predicted = botFlightTicks(t, m);
    assert.ok(Math.abs(predicted - seen[m]) <= 2,
      `predicted ${predicted} ticks to ${m}, took ${seen[m]}`);
  }
  // And the range bots choose to fight at stays inside what actually carries.
  assert.ok(botReach(t) < Math.abs(shot.x - start), 'fighting range should sit inside the carry');
});

test('never leads further ahead than the target could actually get', () => {
  // The reported bug: hold one direction long enough and the aim ran away far
  // past anything reachable. `perp` was compared against a bullet speed the
  // predictor had been handed wrong, and once your velocity passed it the
  // intercept term went imaginary, got floored to 1, and the offset exploded.
  for (const d of ['hard', 'veryhard', 'extreme']) {
    for (const speed of [8, 18, 27, 40]) {                 // slow walk to flat-out
      const g = bare(d, { react: 9999, aimErr: 0, strafe: 0 });
      const t = place(g.spawnBot(), 0, 0);
      const foe = place(g.spawnBot(), 400, 0);
      foe.vx = 0; foe.vy = speed;                          // straight line, forever
      t.aiTarget = foe;
      g.tick = 1; tickBot(t);
      const lead = Math.tan(aimAngle(t)) * 400;            // units up-range it points
      const ticks = botFlightTicks(t, Math.hypot(400, lead));
      assert.ok(lead >= 0, `${d} @${speed} led the wrong way`);
      assert.ok(lead <= speed * ticks * 1.2 + 1,
        `${d} @${speed} led ${Math.round(lead)} units; in that flight the target only covers ${Math.round(speed * ticks)}`);
    }
  }
});

test('aim error drifts instead of jittering every tick', () => {
  const g = bare('easy', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.aiTarget = place(g.spawnBot(), 600, 0);
  const seen = new Set();
  for (let i = 0; i < 16; i++) { g.tick = i; tickBot(t); seen.add(aimAngle(t).toFixed(4)); }
  assert.ok(seen.size <= 3, 'bias should hold for a stretch, saw ' + seen.size + ' values in 16 ticks');
  assert.ok([...seen].some((v) => Math.abs(+v) > 0.001), 'and it should actually be off target');
});

console.log('\nMovement');
test('a bot sitting at its preferred range still moves — no stationary targets', () => {
  // Whatever `range` works out to for this class, some distance is exactly it.
  for (let gap = 240; gap <= 1100; gap += 40) {
    const g = bare('hard', { react: 9999 });
    const t = place(g.spawnBot(), 0, 0);
    t.aiTarget = place(g.spawnBot(), gap, 0);
    g.tick = 1; tickBot(t);
    assert.ok(t.input.up || t.input.down || t.input.left || t.input.right,
      'stood still at range ' + gap);
  }
});

test('range scales with the class: a longer-reaching gun stands further off', () => {
  const g = bare('extreme', { react: 9999 });
  const near = place(g.spawnBot(), 0, 0), far = place(g.spawnBot(), 0, 4000);
  const sniper = TANK_DEFS.filter(Boolean).filter((d) => d.name === 'Sniper')[0];
  assert.ok(sniper, 'expected a Sniper in the tank list');
  far.setTank(sniper.id); far.recompute();
  assert.ok(botReach(far) > botReach(near), 'a Sniper should out-range a Tank');
});

test('closes on a pentagon but keeps its distance from an Alpha', () => {
  // Farming distance used to be one constant, so the high tiers — the only ones
  // that hunt Alphas at all — walked into 3000 HP of contact damage and died
  // more often than Easy did.
  for (const [kind, closes] of [['pentagon', true], ['alpha', false]]) {
    const g = bare('hard', { react: 9999 });
    const t = place(g.spawnBot(), 0, 0);
    t.build = BOT_BUILDS.filter((b) => !b.ram)[0];
    t.addScore(LEVEL_SCORE[30]);
    // Spend the points: a level 30 bot holding all 28 of them is not a thing the
    // game produces, and an unbuilt one has the damage and the health pool of a
    // level 1, which changes what it can afford to stand next to.
    for (let i = 0; i < 80; i++) for (const w of t.build.order) if (t.upgradeStat(w)) break;
    g.add(new Shape(g, kind, 300, 0));      // found and priced by the scan, as in play
    g.tick = 1; tickBot(t);
    assert.equal(t.input.right === 1, closes, `should ${closes ? 'close on' : 'back off from'} a ${kind}`);
  }
});

test('dodge: sidesteps a bullet on a collision course, and Easy does not', () => {
  for (const [d, dodges] of [['easy', false], ['extreme', true]]) {
    const g = bare(d, { react: 9999, strafe: 0, aimErr: 0 });
    const t = place(g.spawnBot(), 0, 0);
    const foe = place(g.spawnBot(), 900, 0);
    t.aiTarget = foe;
    const b = g.add(new Entity(g, { type: 'bullet', x: 100, y: 0, size: 10 }));
    b.owner = foe; b.vx = -22; b.vy = 0;                    // straight down the line at us
    g.rebuildGrid();
    g.tick = 1; tickBot(t);
    assert.equal(!!(t.input.up || t.input.down), dodges, d + ' dodge behaviour');
  }
});

test('dodge: crashers are dodged like fire, other shapes are not', () => {
  // Reported: bots stood there and let the mid-map Crasher belt run them down.
  // A crasher is a homing projectile that happens to be a shape, so it goes
  // through the same closest-approach test the bullets do.
  for (const [kind, dodges] of [['crasherS', true], ['triangle', false]]) {
    const g = bare('extreme', { react: 9999, strafe: 0, aimErr: 0 });
    const t = place(g.spawnBot(), 0, 0);
    const sh = g.add(new Shape(g, kind, 200, 0));   // dead down the +x line at us
    sh.shiny = false; sh.vx = -26; sh.vy = 0; sh.target = t;
    g.rebuildGrid();
    g.tick = 1; tickBot(t);
    assert.equal(!!(t.input.up || t.input.down), dodges, kind + ' dodge behaviour');
  }
});

test('the crasher hunting this bot outranks the square underfoot', () => {
  // Priced as food a crasher loses to whatever is closest, and the bill arrives
  // anyway because it closes on its own. Only the one locked onto *us*: a
  // crasher crossing the field stays an ordinary shape.
  const g = bare('extreme', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  const sq = g.add(new Shape(g, 'square', 250, 0));
  const cr = g.add(new Shape(g, 'crasherS', 0, 700));
  for (const sh of [sq, cr]) { sh.shiny = false; sh.scoreReward = SHAPES[sh.kind].score; }

  cr.target = t;
  botScan(t, SK.extreme, true);
  assert.equal(t.aiFarm, cr, 'should answer the one coming for it');

  cr.target = null;                                  // hunting someone else
  botScan(t, SK.extreme, true);
  assert.equal(t.aiFarm, sq, 'a passing crasher is just a shape');
});

test('a bot pinned against a wall shakes itself loose', () => {
  const g = bare('hard', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.aiTarget = place(g.spawnBot(), 900, 0);
  for (let i = 0; i < 30; i++) { g.tick = i; tickBot(t); }   // never moves: looks stuck
  assert.ok(t.unstick > 0, 'should have noticed it was not going anywhere');
});

console.log('\nFarming');
test('a small bot will not commit to a shape it cannot chew through', () => {
  // Reported: low-level bots walked past the Squares to grind 1500 HP Hexagons.
  // Scoring by value-per-metre made a Hexagon look 150x better than a Square;
  // pricing the kill time instead makes the size of the thing count against it.
  const kinds = ['square', 'triangle', 'pentagon', 'hexagon'];
  const { t: small } = withShapes('extreme', 2, kinds, 600);
  botScan(small, SK.extreme, true);
  assert.ok(small.aiFarm, 'should have found something to farm');
  assert.notEqual(small.aiFarm.kind, 'hexagon', 'a level 2 bot picked a Hexagon');
  assert.ok(SHAPES.hexagon.health > botDps(small) * 900, 'and it should be priced out of reach');

  // The gate is capability, not a hardcoded level: it opens as damage grows.
  const { t: big } = withShapes('extreme', 45, kinds, 600);
  assert.ok(botDps(big) > botDps(small) * 3, 'a level 45 bot should out-damage a level 2 one');
});

test('a bot that is getting nowhere gives up and finds something else', () => {
  // Whether a class can crack a given shape depends on penetration and body
  // damage in ways not worth modelling — measured, a level 15 bot never kills a
  // Hexagon at all. So the backstop watches the health bar instead of guessing.
  const g = new Game('ffa', null, { headless: true, botCount: 0, difficulty: 'extreme' });
  g.wantedShapes = 0; g.botCount = 0;
  g.entities = g.entities.filter((e) => e.type !== 'shape');
  g.mode = Object.assign({}, g.mode, { noBoss: true });
  const t = place(g.spawnBot(), 0, 0);
  t.addScore(LEVEL_SCORE[20]);
  const bad = g.add(new Shape(g, 'pentagon', 400, 0));
  bad.shiny = false; bad.scoreReward = 130; bad.health = bad.maxHealth = 100;
  bad.damageReduction = 0;                      // immune: the stream goes nowhere
  for (let i = 0; i < 400; i++) {
    g.step();
    bad.x = 400; bad.y = 0; bad.vx = bad.vy = 0; bad.health = 100;
  }
  assert.equal(t.farmBan, bad.id, 'should have written that one off');
  assert.notEqual(t.aiFarm, bad, 'and stopped aiming at it');
});

test('takes the fights worth taking, and levels when they are not', () => {
  // Killing a tank awards no score in this game, so a fight it can walk away
  // from is time it is not spending getting bigger.
  const g = bare('extreme', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.addScore(LEVEL_SCORE[10]);
  const foe = place(g.spawnBot(), 2000, 0);
  foe.addScore(LEVEL_SCORE[12]);
  t.lastDamage = -9999;

  assert.equal(botShouldFight(t, foe, SK.extreme), false, 'should go farm instead');

  // How far it will cross for a fight is the difficulty knob: a dumb bot
  // charges anything it can see, a sharp one only what is already on it.
  place(foe, 1200, 0);
  assert.equal(botShouldFight(t, foe, SK.easy), true, 'easy bots charge from range');
  assert.equal(botShouldFight(t, foe, SK.extreme), false, 'sharp ones go back to farming');

  place(foe, 300, 0);
  assert.equal(botShouldFight(t, foe, SK.extreme), true, 'but not when it is already on top of it');

  place(foe, 2000, 0);
  t.lastDamage = t.game.tick;                   // clipped, but nothing that matters
  assert.equal(botShouldFight(t, foe, SK.extreme), false, 'a scratch is not a fight');

  t.health = t.maxHealth * 0.7;                 // now it is actually costing something
  assert.equal(botShouldFight(t, foe, SK.extreme), true, 'fight back when it hurts');
  t.health = t.maxHealth;

  t.lastDamage = -9999;
  foe.health = foe.maxHealth * 0.05;            // nearly dead and worth finishing
  assert.equal(botShouldFight(t, foe, SK.extreme), true, 'take the free one');
});

test('keeps shooting whoever is on it, even once you out-level it', () => {
  // Reported: get a few levels above a bot and it stops acknowledging you.
  // The odds say the fight is not worth taking, which is fine — but declining
  // used to drop the target outright, and the check that kept it (botThreatens)
  // is only true while you are holding fire and pointed at it. Release the
  // trigger for a reload and the bot went back to farming mid-fight.
  const g = bare('extreme', { react: 1 });
  const t = place(g.spawnBot(), 0, 0);
  t.build = BOT_BUILDS.filter((b) => !b.ram)[0];
  t.addScore(LEVEL_SCORE[10]);
  const you = place(g.spawnBot(), 500, 0);
  you.bot = false;                                      // drive it by hand
  you.isPlayer = true;
  you.addScore(LEVEL_SCORE[45]);
  you.stats = [0, 7, 7, 7, 0, 0, 7, 5]; you.recompute();
  you.angle = Math.PI; you.input.fire = 1;              // pointed at it, shooting
  const sq = g.add(new Shape(g, 'square', 0, 350));       // and something to run off and farm
  sq.health = sq.maxHealth = 1e6;                       // that a stray shot cannot delete mid-test
  assert.ok(botWinOdds(t, you) < 0.3, 'the fight should read as a losing one');

  g.step();
  // Loose: it is leading its shots, and you are being knocked about by them.
  const toYou = () => Math.abs(angleDiff(aimAngle(t), Math.atan2(you.y - t.y, you.x - t.x)));
  assert.ok(toYou() < 0.35, 'should shoot back at you, not at the square');
  assert.equal(t.input.fire, 1);

  you.input.fire = 0;                                   // reloading: used to be enough to forget you
  for (let i = 0; i < 30; i++) g.step();
  assert.ok(toYou() < 0.35, 'still on you between your shots');
  assert.equal(t.fleeing, true, 'backing off while it does it, not standing in it');
  assert.ok(t.x < -50, 'and actually retreating, got x=' + t.x.toFixed(0));

  place(you, 6000, 0);                                  // clear of both guns
  g.step();
  assert.equal(t.aiEngaged, null, 'then it lets go');
  assert.notEqual(t.aiTarget, you, 'and goes back to its own business');
  assert.equal(t.input.fire, 1, 'shooting at something else, not standing there');
});

test('a stray tank lining up cannot take the fight off the one on you', () => {
  // Reported: chase a bot for a while and every so often it drops you for a
  // Square. The fight lived in a single slot, claimed by whoever happened to be
  // pointed this way when the scan ran — so any third tank could take it, and
  // the fight it then declined fell straight through to farming.
  const g = bare('hard', { react: 1 });
  const t = place(g.spawnBot(), 0, 0);
  t.build = BOT_BUILDS.filter((b) => !b.ram)[0];
  t.addScore(LEVEL_SCORE[12]);
  t.godMode = true;              // which fight it picks, not whether it lives through two of them
  const you = place(g.spawnBot(), 450, 0);
  you.bot = false; you.isPlayer = true;
  you.addScore(LEVEL_SCORE[45]);
  you.stats = [0, 7, 7, 7, 0, 0, 7, 5]; you.recompute();
  const stray = place(g.spawnBot(), 0, 1100);           // way off, and also pointed at us
  stray.bot = false;
  const sq = g.add(new Shape(g, 'square', 300, -300));
  sq.health = sq.maxHealth = 1e6;
  for (let i = 0; i < 30; i++) {
    for (const o of [you, stray]) { o.mouse.x = t.x; o.mouse.y = t.y; o.input.fire = 1; }
    g.step();
  }
  assert.equal(t.aiEngaged, you, 'the one in front of it, not the one behind');
  const off = Math.abs(angleDiff(aimAngle(t), Math.atan2(you.y - t.y, you.x - t.x)));
  assert.ok(off < 0.35, 'gun should still be on you, off by ' + off.toFixed(2));
});

test('a shot that lands is what makes it a fight, trigger held or not', () => {
  // The other half of the same bug: whether someone was fighting us was read off
  // their barrel angle while they held fire, so noticing took a scan tick landing
  // inside the moment they happened to be shooting. A hit needs no such luck.
  const g = bare('hard', { react: 1 });
  const t = place(g.spawnBot(), 0, 0);
  t.build = BOT_BUILDS.filter((b) => !b.ram)[0];
  t.addScore(LEVEL_SCORE[12]);
  const you = place(g.spawnBot(), 600, 0);
  you.bot = false; you.isPlayer = true;
  you.addScore(LEVEL_SCORE[45]);
  you.stats = [0, 7, 7, 7, 0, 0, 7, 5]; you.recompute();
  you.angle = 0; you.input.fire = 0;                    // facing away, gun quiet
  const sq = g.add(new Shape(g, 'square', 0, 300));
  sq.health = sq.maxHealth = 1e6;
  assert.equal(botThreatens(you, t), false, 'nothing about it reads as a threat');

  t.applyDamage(3, you);                                // but it just put one in us
  g.tick = 1; tickBot(t);
  assert.equal(t.aiEngaged, you, 'the hit is what settles it');
  const off = Math.abs(angleDiff(aimAngle(t), Math.atan2(you.y - t.y, you.x - t.x)));
  assert.ok(off < 0.35, 'and the gun comes round, off by ' + off.toFixed(2));
});

test('a gun that out-ranges its sight still gets answered', () => {
  // Reported: as a Smasher the bots handle you fine, as a high level gun they go
  // back to ignoring you. A rammer has to close to touch you, so it is always
  // inside sight; a big gun shoots from outside it. Sight was checked before
  // anything else, so the tank landing the shots was dropped from the scan and
  // there was nothing left to latch on to.
  const g = bare('medium', { react: 1 });                 // sight 1300
  const t = place(g.spawnBot(), 0, 0);
  t.build = BOT_BUILDS.filter((b) => !b.ram)[0];
  t.addScore(LEVEL_SCORE[8]);
  const you = place(g.spawnBot(), 1400, 0);               // beyond it, and out-levelling it
  you.bot = false; you.isPlayer = true;
  you.addScore(LEVEL_SCORE[45]);
  you.stats = [0, 7, 7, 7, 7, 0, 5, 0]; you.recompute();  // bullet speed: the reach to stand out there
  const sq = g.add(new Shape(g, 'square', 0, 300));
  sq.health = sq.maxHealth = 1e6;

  g.tick = 1; tickBot(t);
  assert.equal(t.aiTarget, null, 'out of sight and it has not been touched: nothing to see');

  t.applyDamage(3, you);                                  // then a shot arrives out of nowhere
  g.tick = 2; tickBot(t);
  assert.equal(t.aiEngaged, you, 'being hit is how it finds out');
  const off = Math.abs(angleDiff(aimAngle(t), Math.atan2(you.y - t.y, you.x - t.x)));
  assert.ok(off < 0.35, 'and the gun comes round, off by ' + off.toFixed(2));

  // But it is not a tracker: get properly clear and it goes back to its Squares.
  place(you, 9000, 0);
  g.tick = 3; tickBot(t);
  assert.equal(t.aiEngaged, null, 'let go once well out of range');
  assert.equal(t.aiTarget, null, 'and stopped scanning it entirely');
});

test('a fight is not let go at a range it can be picked straight back up', () => {
  // Reported: bot guns jittering in bursts for no visible reason. The line a
  // fight was released at sat inside the bot's own sight, so a tank in that band
  // got dropped on the ticks between scans and re-latched on the scan ticks —
  // and each flip took the target away, turned the recoil engine on, and swung
  // the gun through 180 degrees.
  const sk = SK.hard;
  const g = bare('hard', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.build = BOT_BUILDS.filter((b) => !b.ram)[0];
  t.addScore(LEVEL_SCORE[12]);
  const you = place(g.spawnBot(), 1400, 0);        // past both guns, still well in view
  you.bot = false; you.isPlayer = true;
  you.addScore(LEVEL_SCORE[45]);
  you.stats = [0, 7, 7, 7, 0, 0, 7, 5]; you.recompute();
  you.angle = Math.PI; you.input.fire = 1;
  const sq = g.add(new Shape(g, 'square', 0, 400));  // gives it a farm, so scans stay on their cadence
  sq.health = sq.maxHealth = 1e6;

  assert.ok(botClear2(t, you, sk) >= sk.sight * sk.sight,
    'the release line must sit outside sight, or the two fight over it every tick');

  g.tick = 1; tickBot(t);
  assert.equal(t.aiEngaged, you, 'latched on');
  let changes = 0, last = t.aiEngaged, swings = 0, lastAim = aimAngle(t);
  for (let i = 2; i < 40; i++) {
    g.tick = i; tickBot(t);
    if (t.aiEngaged !== last) changes++;
    last = t.aiEngaged;
    if (Math.abs(angleDiff(aimAngle(t), lastAim)) > 0.8) swings++;
    lastAim = aimAngle(t);
  }
  assert.equal(changes, 0, 'held the whole way, dropped and re-took it ' + changes + ' times');
  assert.equal(swings, 0, 'and the gun stayed put, swung ' + swings + ' times');
});

test('a bot on its own always has something to shoot at', () => {
  // Reported: bots far from the player paced back and forth with their guns
  // silent. With no goal the movement code picks a fresh random heading every
  // 90 ticks and holds fire, so anything that empties the target list shows up
  // as a tank that looks broken. Nothing may leave it with an empty list.
  for (const d of ['medium', 'hard', 'extreme']) {
    const g = new Game('ffa', null, { headless: true, botCount: 0, difficulty: d });
    g.botCount = 0;
    g.mode = Object.assign({}, g.mode, { noBoss: true });
    const t = g.spawnBot();
    let blind = 0, quiet = 0, n = 0;
    for (let i = 0; i < 1500 && !t.dead; i++) {
      g.step();
      n++;
      if (!(t.aiTarget && !t.aiTarget.dead) && !(t.aiFarm && !t.aiFarm.dead)) blind++;
      if (!t.input.fire) quiet++;
    }
    assert.ok(blind / n < 0.10, d + ' had no target for ' + (blind / n * 100).toFixed(0) + '% of ticks');
    assert.ok(quiet / n < 0.10, d + ' held fire for ' + (quiet / n * 100).toFixed(0) + '% of ticks');
  }
});

console.log('\nContact');
test('one touch is priced at what it actually takes off the bar', () => {
  // The multiplier vs a shape is 4, not 1: min is max(1, 1) and max is
  // min(6, 4). A Square hits a tank for 8 and an Alpha Pentagon for 20, and
  // missing that factor is what had bots strolling into their own food.
  const g = bare('hard', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  const touch = (kind) => {
    const sh = g.add(new Sh(g, kind, 400, 0));
    sh.health = sh.maxHealth = SH[kind].health;
    return botContact(t, sh).touch;
  };
  assert.equal(touch('square'), 8, 'a Square hits for 8');
  assert.equal(touch('pentagon'), 12);
  assert.equal(touch('alpha'), 20, 'and an Alpha Pentagon takes 20 a tick');
});

test('never closes on something a few touches would kill it with', () => {
  // The reported bug: bots walking through Squares and Triangles at a sliver of
  // health and dying on them. Measured over 10k ticks before this, every bot a
  // shape killed was under 15% health and still driving.
  const g = bare('hard', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.addScore(LEVEL_SCORE[20]);
  const sh = g.add(new Sh(g, 'square', 400, 0));
  sh.health = sh.maxHealth = SH.square.health;
  t.health = t.maxHealth;
  assert.equal(botCanTank(t, sh), true, 'a healthy tank shoulders a Square aside');
  t.health = botContact(t, sh).touch * CONTACT_TOUCHES - 0.01;
  assert.equal(botCanTank(t, sh), false, 'at a few touches left it keeps its distance');
  assert.equal(botCanTank(t, sh), botContact(t, sh).close, 'and both spellings agree');
});

test('body damage, health and regen are what buy the right to close', () => {
  // What the difference between farming a shape and dying on one is made of.
  // Same class, same level, same shape — only the stats move.
  const shapeFor = (t, kind) => {
    const sh = t.game.add(new Sh(t.game, kind, 400, 0));
    sh.health = sh.maxHealth = SH[kind].health;
    return sh;
  };
  const build = (stats) => {
    const g = bare('hard', { react: 9999 });
    const t = place(g.spawnBot(), 0, 0);
    t.addScore(LEVEL_SCORE[30]);
    t.stats = stats.slice(); t.recompute(); t.health = t.maxHealth;
    return t;
  };
  //            speed rel dmg pen bspd BODY HEALTH REGEN
  const glass = build([0, 0, 0, 0, 0, 0, 0, 0]);
  const tanky = build([0, 0, 0, 0, 0, 7, 7, 7]);
  const pg = shapeFor(glass, 'pentagon'), pt = shapeFor(tanky, 'pentagon');
  assert.ok(botContact(tanky, pt).ram < botContact(glass, pg).ram * 0.6,
    'body damage kills it markedly faster at contact');
  assert.ok(botContact(tanky, pt).cost < botContact(glass, pg).cost,
    'and health plus regen makes the same seconds cheaper');
  assert.equal(botCanTank(tanky, pt), true, 'so the body build closes');

  // And the same tank, hurt, stops being that tank.
  tanky.health = tanky.maxHealth * 0.12;
  assert.equal(botCanTank(tanky, pt), false, 'until the bar says otherwise');
});

test('drives through what it can absorb and steers off what it cannot', () => {
  // Most bots that lose health to a shape were not farming it — they backed into
  // one mid-fight or brushed past on the way somewhere, and against a big shape
  // one graze is a quarter of the bar with nothing bought for it. Two reasons to
  // go around and a shape only has to give one: what a bounce costs against the
  // bar left, or whether the shape is even going to still be there — a Square
  // dies under the bot's own body on the first tick of contact, a Hexagon does not.
  // Probed with the hulls already touching, because that is the only place the
  // answer matters and the place the old push was weakest: it ramped on the
  // distance between centres, so it peaked at a separation two solid bodies can
  // never reach and came out at 0.6 against a pursuit vector of 1.
  const push = (healthStat, hp, kind, shapeHp) => {
    // Strafe and dodge off: this is the head-on radial balance, and a bot circling
    // its target measures where the orbit happened to be, not what it decided.
    const g = bare('hard', { react: 9999, strafe: 0, dodge: 0 });
    const t = g.spawnBot();
    t.addScore(LEVEL_SCORE[30]);
    // Pin the tank — spawnBot rolls a class and a build off the shared RNG.
    t.build = BOT_BUILDS.filter((b) => !b.ram)[0];
    t.pendingUpgrades = []; t.upgradeTo = () => {};
    t.stats = [0, 0, 0, 0, 0, 0, healthStat, 0]; t.statsAvailable = 0; t.recompute();
    t.health = t.maxHealth * hp;
    // A tank to chase, dead ahead, with the shape parked hull-to-hull in between.
    t.aiTarget = t.aiEngaged = place(g.spawnBot(), 1400, 0);
    const wall = g.add(new Sh(g, kind, 0, 0));
    wall.maxHealth = SH[kind].health;
    wall.health = wall.maxHealth * (shapeHp === undefined ? 1 : shapeHp);
    place(t, -(t.size + wall.size), 0);
    g.rebuildGrid();
    g.tick = 1; tickBot(t);
    return t.input.right === 1;                    // 1 = still driving into it
  };
  // Ground it can walk over: a Square is gone on the first tick of contact, so
  // swerving off one would cost more than it saves — a bot that did could not
  // cross its own farm. The share-of-the-bar rule still owns this case, and the
  // pop rule only ever adds a reason to go around, never takes one away: the same
  // Square is a third of a 108 HP bar, and that bot goes round it.
  assert.equal(push(7, 1, 'square'), true, 'a deep bar walks through a Square');
  assert.equal(push(0, 1, 'square'), false, 'a thin one goes around the same Square');

  // Anything that outlasts the bounce is a wall, whatever the build and whatever
  // is in the bar. There is nothing to buy by touching it: it is not being eaten,
  // going around is free, and the health does not come back — base regen is a
  // 17-minute bar and the graze restarts the clock on the only real heal.
  assert.equal(push(7, 1, 'pentagon'), false, 'a health build at full goes around a Pentagon');
  assert.equal(push(7, 1, 'hexagon'), false, 'and around a Hexagon, which it could never chew through');
  assert.equal(push(7, 1, 'alpha'), false, 'and around an Alpha, whose graze is a quarter of the bar');

  // Read off the shape's live health, not a table of kinds: the Pentagon it has
  // nearly finished stops being a wall on its own, because now it does pop.
  assert.equal(push(7, 1, 'pentagon', 0.05), true, 'a nearly-dead Pentagon is walkable again');
});

console.log('\nRoles');
test('every role is a complete bag, and they pull in different directions', () => {
  const keys = ['key', 'label', 'farm', 'fight', 'prey', 'greed', 'flee', 'ram'];
  for (const r of BOT_ROLES) for (const k of keys)
    assert.notEqual(r[k], undefined, (r.key || '?') + '.' + k + ' is missing');
  const farm = BOT_ROLES.map((r) => r.farm), fight = BOT_ROLES.map((r) => r.fight);
  assert.ok(Math.max(...farm) / Math.min(...farm) > 2, 'the farm pull has to actually spread');
  assert.ok(Math.max(...fight) / Math.min(...fight) > 2, 'and so does the fight pull');
  assert.equal(botRole({}).key, 'balanced', 'anything unrolled reads as neutral');
});

test('a Farmer declines the fight a Hunter takes', () => {
  const g = bare('extreme', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  const foe = place(g.spawnBot(), 700, 0);
  t.addScore(LEVEL_SCORE[20]); foe.addScore(LEVEL_SCORE[20]);
  t.stats = [4, 4, 4, 4, 4, 4, 4, 5]; t.recompute(); t.health = t.maxHealth;
  foe.stats = [4, 4, 4, 4, 4, 4, 4, 5]; foe.recompute();
  foe.health = foe.maxHealth * 0.55;               // ahead, but not a rout
  const odds = botWinOdds(t, foe);
  assert.ok(odds > 0.5 && odds < 0.9, 'an even-ish fight is the interesting case, got ' + odds.toFixed(2));
  t.botRole = ROLE('hunter');
  assert.equal(botShouldFight(t, foe, SK.extreme), true, 'a Hunter crosses the gap for it');
  t.botRole = ROLE('farmer');
  assert.equal(botShouldFight(t, foe, SK.extreme), false, 'a Farmer goes back to its Pentagon');
});

test('roles pick the build that matches them', () => {
  // A Brawler that rolled a bullet build is a Brawler in name only.
  const g = bare('hard');
  for (let i = 0; i < 60; i++) {
    const t = rawSpawnBot.call(g);                 // unpinned: the real roll
    assert.ok(t.botRole, 'every bot gets one');
    if (t.botRole.ram >= 0) assert.equal(t.build.ram, t.botRole.ram, t.botRole.key + ' got the wrong build');
  }
});

test('roles play visibly different games in the same arena', () => {
  // The reported symptom: every bot beelined for every other bot and the arena
  // was one rolling scrum. Measured as what each one is actually pointed at,
  // pressing forward rather than backing away — level is the same claim but a
  // dozen times noisier, and it made this test flap.
  // Respawn stays on and the roles alternate as the arena refills. With a fixed
  // pod the population drains, the survivors carry the whole sample, and the
  // measurement flaps — half the runs read a spread that is not there.
  const g = new Game('ffa', null, { headless: true, botCount: 0, difficulty: 'hard' });
  g.mode = Object.assign({}, g.mode, { noBoss: true });
  const pressing = { farmer: 0, hunter: 0 }, ticks = { farmer: 0, hunter: 0 };
  let flip = 0;
  g.spawnBot = function () {
    const t = rawSpawnBot.call(this);
    t.botRole = ROLE(flip++ % 2 ? 'hunter' : 'farmer');
    return t;
  };
  g.botCount = 30;
  for (let i = 0; i < 30; i++) g.spawnBot();
  for (let i = 0; i < 4000; i++) {
    g.step();
    for (const t of g.entities) {
      if (t.type !== 'tank' || !t.bot || t.dead || !t.aiGoal) continue;
      const key = t.botRole.key;
      if (ticks[key] === undefined) continue;
      ticks[key]++;
      if (t.aiGoal.type !== 'shape' && !t.fleeing) pressing[key]++;
    }
  }
  const share = (k) => pressing[k] / Math.max(1, ticks[k]);
  assert.ok(share('hunter') > share('farmer') * 2,
    'hunters pressed ' + (share('hunter') * 100).toFixed(0) + '% of ticks, farmers '
    + (share('farmer') * 100).toFixed(0) + '% — the roles are decoration');
  assert.ok(share('farmer') < 0.35, 'a Farmer that fights a third of the time is not a Farmer');
});

console.log('\nReading the other tank');
test('a hurt bot stops leaning on the shape it is eating', () => {
  // Reported: a bot with less health than a Hexagon walked into it and died.
  // Measured over 10k ticks: every bot that died on a shape was already under
  // half health. Farm risk was priced against maxHealth, so a bot at 10% read
  // the job exactly the same as a fresh one did.
  const closes = (hp) => {
    const g = bare('hard', { react: 9999 });
    const t = place(g.spawnBot(), 0, 0);
    t.build = BOT_BUILDS.filter((b) => !b.ram)[0];
    t.addScore(LEVEL_SCORE[20]);
    for (let i = 0; i < 80; i++) for (const w of t.build.order) if (t.upgradeStat(w)) break;
    t.health = t.maxHealth * hp;
    const sh = g.add(new Shape(g, 'triangle', 300, 0));
    sh.health = sh.maxHealth = SH.triangle.health;
    g.tick = 1; tickBot(t);
    assert.equal(t.aiFarm, sh, 'the only thing on the field');
    return t.input.right === 1;                    // 1 = closing on it, 0 = holding off
  };
  assert.equal(closes(1), true, 'at full health a Triangle is just food');
  assert.equal(closes(0.2), false, 'at a fifth it should shoot from where it stands');
});

test('the health it will spend is what it has over the reserve', () => {
  const g = bare('hard', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.addScore(LEVEL_SCORE[20]);
  t.health = t.maxHealth;
  assert.ok(botFarmBudget(t) > 0, 'a healthy bot has something to spend');
  t.health = t.maxHealth * 0.5;
  assert.ok(botFarmBudget(t) <= 0, 'at the reserve it is done spending');
  t.health = t.maxHealth * 0.1;
  assert.ok(botFarmBudget(t) < 0, 'and below it everything on the field is too expensive');
});

test('engages on the odds and on whether that tank is even looking', () => {
  // Reported: bots locked onto anything that entered a radius. Three things
  // decide it now — who wins the damage race, how far away it is, and whether
  // that barrel is pointed this way. Something facing elsewhere is scenery.
  const setup = (dist, angle, firing, theirLevel) => {
    const g = new Game('ffa', null, { headless: true, botCount: 0, difficulty: 'extreme' });
    g.botCount = 0;
    const a = g.spawnBot(), b = g.spawnBot();
    place(a, 0, 0); place(b, dist, 0);
    a.addScore(LEVEL_SCORE[20]); b.addScore(LEVEL_SCORE[theirLevel]);
    a.stats = [4, 4, 4, 4, 4, 4, 4, 5]; a.recompute();
    b.stats = [4, 4, 4, 4, 4, 4, 4, 5]; b.recompute();
    a.lastDamage = -9999;
    b.angle = angle; b.input.fire = firing ? 1 : 0;
    return { a, b };
  };
  const AT = Math.PI, AWAY = 0;                  // b sits at +x, so PI faces us

  let { a, b } = setup(900, AT, true, 20);
  assert.equal(botShootingAt(b, a), true, 'should read it as shooting at us');
  assert.equal(botShouldFight(a, b, SK.extreme), true, 'and answer it');

  ({ a, b } = setup(900, AWAY, true, 20));
  assert.equal(botAimedAt(b, a), false, 'facing away is not aimed at us');
  assert.equal(botShouldFight(a, b, SK.extreme), false, 'so keep farming');

  ({ a, b } = setup(1800, AT, true, 20));
  assert.equal(botShouldFight(a, b, SK.extreme), false, 'lined up from outside its own range is not a threat');

  // And the odds are the damage race, not a level comparison.
  ({ a, b } = setup(900, AT, true, 20));
  const even = botWinOdds(a, b);
  assert.ok(Math.abs(even - 0.5) < 0.08, 'mirror match should be a coin flip, got ' + even.toFixed(2));
  b.health = b.maxHealth * 0.1;
  assert.ok(botWinOdds(a, b) > 0.8, 'a cripple should read as won');
  a.health = a.maxHealth * 0.1; b.health = b.maxHealth;
  assert.ok(botWinOdds(a, b) < 0.2, 'and being the cripple should read as lost');
});

test('turns the gun around to use recoil as an engine while crossing ground', () => {
  // Firing shoves the tank the other way. Measured over 25 pinned runs, aiming
  // backwards on a transit leg cut the crossing by 67% on an Annihilator and 9%
  // on a Tank; aiming forwards while moving costs about as much again.
  const leg = (difficulty) => {
    const g = new Game('ffa', null, { headless: true, botCount: 0, difficulty });
    g.entities = g.entities.filter((e) => e.type !== 'shape');
    g.wantedShapes = 0; g.botCount = 0;
    g.mode = Object.assign({}, g.mode, { noBoss: true });
    const t = place(g.spawnBot(), 0, 0);
    const def = DEFS.filter(Boolean).filter((d) => d.name === 'Destroyer')[0];
    t.addScore(LEVEL_SCORE[45]); t.setTank(def.id);
    t.stats = [7, 7, 7, 7, 5, 0, 0, 0]; t.recompute();
    t.aiTankId = undefined;
    const far = g.add(new Shape(g, 'pentagon', 3000, 0));
    far.shiny = false; far.scoreReward = 130; far.health = far.maxHealth = 1e9;
    let backwards = 0, n = 0;
    for (let i = 0; i < 300; i++) {
      far.x = 3000; far.y = 0; far.vx = far.vy = 0; far.health = 1e9;
      // The health pin is what makes this a fixed-length walk, and it is also
      // exactly what the give-up rule watches for. Keep it off the books, or a
      // slow leg trips the ban at tick 200 and the bot wanders with a random aim.
      t.farmBan = undefined; t.farmSince = g.tick;
      t.pendingUpgrades = [];
      g.step();
      if (Math.hypot(t.x - 3000, t.y) < 900) break;      // arrived: transit over
      const aim = Math.atan2(t.mouse.y - t.y, t.mouse.x - t.x);
      if (Math.abs(angleDiff(aim, 0)) > 2) backwards++;  // the goal is due east
      n++;
    }
    return n ? backwards / n : 0;
  };
  assert.ok(leg('extreme') > 0.3, 'a sharp bot should be boosting for much of the leg');
  assert.ok(leg('easy') < 0.1, 'a dull one should not know the trick, got ' + leg('easy').toFixed(2));
});

test('notices a rammer walking at it, and does not turn its back', () => {
  // Reported: a player Smasher could walk all the way in and the bots carried on
  // farming. Two causes. A rammer never fires and points where it is going, so
  // reading threat off barrels missed it entirely. And a big one tripped the
  // out-of-our-league rule, which dropped it from the scan altogether — so the
  // bot never even tracked the thing that was killing it.
  const g = new Game('ffa', 'Player', { headless: false, botCount: 0, difficulty: 'extreme' });
  g.botCount = 0;
  g.mode = Object.assign({}, g.mode, { noBoss: true });
  const p = g.player;
  const sm = DEFS.filter(Boolean).filter((d) => d.name === 'Smasher')[0];
  p.addScore(LEVEL_SCORE[45]); p.setTank(sm.id);
  p.stats = [7, 0, 0, 0, 0, 7, 7, 5]; p.recompute();
  place(p, 1000, 0);
  const bot = place(g.spawnBot(), 0, 0);
  bot.build = BOT_BUILDS.filter((b) => !b.ram)[0];   // pin: a rammer bot rams back, correctly
  bot.addScore(LEVEL_SCORE[30]);

  // A Smasher is a threat without ever firing or aiming — it is closing.
  p.vx = -20; p.vy = 0;
  assert.equal(botShootingAt(p, bot), false, 'it has no gun to shoot with');
  assert.equal(botThreatens(p, bot), true, 'but closing on us is the threat');

  let tracked = 0, fired = 0, n = 0;
  for (let i = 0; i < 200 && !bot.dead && !p.dead; i++) {   // stop when there is nothing left to track
    const ang = Math.atan2(bot.y - p.y, bot.x - p.x);
    p.input.right = Math.cos(ang) > 0.35 ? 1 : 0; p.input.left = Math.cos(ang) < -0.35 ? 1 : 0;
    p.input.down = Math.sin(ang) > 0.35 ? 1 : 0; p.input.up = Math.sin(ang) < -0.35 ? 1 : 0;
    p.mouse.x = bot.x; p.mouse.y = bot.y;
    bot.pendingUpgrades = [];                       // pin the class, not the point here
    g.step();
    // Only while it bears down — wide enough to cover the whole approach now that
    // a bot being run down holds its distance instead of standing there.
    if (Math.hypot(p.x - bot.x, p.y - bot.y) > 1500) continue;
    if (bot.aiTarget === p) tracked++;
    if (bot.input.fire) fired++;
    n++;
  }
  assert.ok(n > 30, 'expected a decent stretch of the approach, got ' + n + ' ticks');
  assert.ok(tracked / n > 0.5, 'should have it tracked most of the time, got ' + (tracked / n * 100).toFixed(0) + '%');
  assert.ok(fired / n > 0.8, 'and should be shooting, got ' + (fired / n * 100).toFixed(0) + '%');
});

test('a rammer it can outrun is not the same threat as one it cannot', () => {
  // Contact damage only ever lands if the thing can catch you, so the odds have
  // to weigh it that way — otherwise bots flee Smashers they could kite down.
  const g = new Game('ffa', null, { headless: true, botCount: 0, difficulty: 'extreme' });
  g.botCount = 0;
  const bot = place(g.spawnBot(), 0, 0);
  bot.addScore(LEVEL_SCORE[30]);
  const ram = place(g.spawnBot(), 500, 0);
  ram.addScore(LEVEL_SCORE[30]);
  const sm = DEFS.filter(Boolean).filter((d) => d.name === 'Smasher')[0];
  ram.setTank(sm.id); ram.recompute();

  ram.movementSpeed = bot.movementSpeed * 2;        // it will catch us
  const fast = botWinOdds(bot, ram);
  ram.movementSpeed = bot.movementSpeed * 0.3;      // it never will
  const slow = botWinOdds(bot, ram);
  assert.ok(slow > fast, 'a rammer that cannot catch us should read as less dangerous');
});

console.log('\nRetreat');
test('hurt bots break off and come back once healed', () => {
  const g = bare('extreme', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  const foe = place(g.spawnBot(), 300, 0);
  t.aiTarget = t.aiEngaged = foe;                 // latched: it is in a fight, not picking one
  t.health = t.maxHealth * 0.2;
  g.tick = 1; t.lastDamage = g.tick;              // and taking fire, which is what makes it one
  tickBot(t);
  assert.equal(t.fleeing, true);
  assert.equal(t.input.fire, 1, 'a fighting retreat still shoots');
  assert.equal(t.input.left, 1, 'should be backing away from something at +x');
  t.health = t.maxHealth * 0.9;
  g.tick = 2; t.lastDamage = g.tick; tickBot(t);
  assert.equal(t.fleeing, false, 'should re-engage once patched up');
  assert.ok(!t.regening, 'never heals through someone shooting at it');
});

test('a badly hurt bot declines the fight and drifts off, but keeps shooting', () => {
  // Reported: bots alone in a corner pacing a small patch, not farming and not
  // firing. That was this: healing used to drop the goal outright, which turned
  // the gun off for up to 45 seconds at a stretch. Only being *hit* delays
  // hyper-regen — firing never has — so healing declines tank fights and opens
  // the gap, and goes on shooting shapes the whole way.
  const g = bare('hard', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  const food = g.add(new Sh(g, 'square', 300, 0));
  food.health = food.maxHealth = SH.square.health;
  t.aiFarm = food;
  // A tank in sight but not yet on it: something to leave, nothing latched on.
  t.lastHitBy = t.aiTarget = place(g.spawnBot(), 400, 0);
  t.health = t.maxHealth * (REGEN_HP_WAIT - 0.05);
  g.tick = 1; tickBot(t);
  assert.equal(t.regening, true, 'under the wait line with nothing latched on');
  assert.equal(t.input.fire, 1, 'gun stays on — a silent tank is the bug, not the fix');
  assert.equal(t.input.left, 1, 'opening the gap from whoever hit it');
  assert.equal(t.fleeing, false, 'this is leaving, not a fighting retreat');

  // The gap up to 0.75 is what stops it going back into a fight at 36% and
  // getting knocked straight down again.
  t.health = t.maxHealth * 0.6;
  g.tick = 2; tickBot(t);
  assert.equal(t.regening, true, 'not done until it is actually patched up');

  t.health = t.maxHealth * 0.8;
  g.tick = 3; tickBot(t);
  assert.equal(t.regening, false, 'back to work');
  assert.equal(t.input.fire, 1, 'and still on the square');

  // Alone with the shapes: nothing to walk away from, so it just farms from
  // range. This is the case that used to read as a broken pacing tank.
  const g2 = bare('hard', { react: 9999 });
  const t2 = place(g2.spawnBot(), 0, 0);
  const food2 = g2.add(new Sh(g2, 'square', 300, 0));
  food2.health = food2.maxHealth = SH.square.health;
  t2.health = t2.maxHealth * 0.1;
  g2.tick = 1; tickBot(t2);
  assert.equal(t2.input.fire, 1, 'gun stays on');
  assert.ok(t2.wasMoving, 'and it is going somewhere, not standing still');
});

test('a healing bot never stops playing for long', () => {
  // The measured symptom, end to end: one bot alone with shapes, badly hurt.
  // Before the fix it spent whole 900-tick stretches with the gun off.
  const g = new Game('ffa', null, { headless: true, botCount: 0, difficulty: 'hard' });
  g.botCount = 0;
  g.mode = Object.assign({}, g.mode, { noBoss: true });
  const t = g.spawnBot();
  t.health = t.maxHealth * 0.15;
  let quiet = 0, run = 0, worst = 0;
  for (let i = 0; i < 1200 && !t.dead; i++) {
    g.step();
    if (t.input.fire) run = 0; else { quiet++; run++; worst = Math.max(worst, run); }
  }
  assert.ok(worst < 60, 'longest silent stretch was ' + worst + ' ticks');
  assert.ok(quiet / 1200 < 0.15, 'held fire for ' + (quiet / 12).toFixed(0) + '% of the run');
});

console.log('\nStability');
test('every difficulty runs 400 ticks of FFA with 28 bots, no NaN', () => {
  for (const d of BOT_DIFFICULTIES) {
    const g = new Game('ffa', 'T', { difficulty: d });
    for (let i = 0; i < 400; i++) g.step();
    for (const e of g.entities) assert.ok(Number.isFinite(e.x) && Number.isFinite(e.y), d + ' produced a NaN');
  }
});

test('maze bots keep out of the walls', () => {
  const g = new Game('maze', 'T', { difficulty: 'extreme' });
  for (let i = 0; i < 400; i++) g.step();
  const inside = g.entities.filter((e) => e.type === 'tank' && e.bot && !e.dead && g.inWall(e.x, e.y, 0));
  assert.equal(inside.length, 0, inside.length + ' bots ended up inside a wall');
});

console.log('\nThe ladder actually climbs');
// The guard that would have caught the original tuning: two knobs scaled the
// wrong way up the table, so Extreme lost duels to Hard. Adjacent tiers are too
// close to separate cheaply, so this checks tiers two and three apart.
function fight(skA, skB, swap) {
  // Headless and empty: no player, no shapes, nothing else to shoot at.
  const g = new Game('ffa', null, { headless: true, botCount: 0 });
  g.wantedShapes = 0;
  g.entities = g.entities.filter((e) => e.type !== 'shape');
  const a = g.spawnBot(), b = g.spawnBot();
  a.botSkill = swap ? skB : skA;
  b.botSkill = swap ? skA : skB;
  a.team = b.team = null;
  a.x = a.px = -450; a.y = a.py = 0;
  b.x = b.px = 450; b.y = b.py = 0;
  a.addScore(LEVEL_SCORE[30]); b.addScore(LEVEL_SCORE[30]);
  a.protectedUntil = b.protectedUntil = 0;
  g.botCount = 0;
  g.mode = Object.assign({}, g.mode, { noBoss: true });
  for (let i = 0; i < 2000 && !a.dead && !b.dead; i++) g.step();
  if (a.dead === b.dead) return null;                    // timeout or mutual kill
  return ((a.dead ? b : a) === a) === !swap ? 'a' : 'b';
}
// n=30 put the 60% bar about one sigma from the true ~70%, so this failed on
// roughly one run in five with nothing wrong. Fights are two tanks in an empty
// arena and cost almost nothing; buy the confidence interval instead.
function winRate(lo, hi, n = 120) {
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const r = fight(BOT_SKILL[lo], BOT_SKILL[hi], i % 2 === 1);   // swap sides each fight
    if (r === 'a') a++; else if (r === 'b') b++;
  }
  return b / Math.max(1, a + b);
}
test('the higher tier wins the duel: easy < hard, medium < extreme', () => {
  for (const [lo, hi] of [['easy', 'hard'], ['medium', 'extreme']]) {
    const r = winRate(lo, hi);
    assert.ok(r > 0.6, `${hi} only won ${(r * 100).toFixed(0)}% against ${lo}`);
  }
});

test('works up to bigger shapes as its damage grows, never before', () => {
  // The reported bug, as an assertion: small bots walked past the Squares to
  // grind Hexagons. Ranking by value-per-metre made a Hexagon look 150x better
  // than a Square; ranking by value-per-tick, against what its gun can actually
  // chew and what the exposure costs its health pool, produces Squares, then
  // Triangles, then Pentagons — with no per-level table anywhere.
  const kinds = ['square', 'triangle', 'pentagon', 'hexagon'];
  let prev = 0, first = null;
  for (const lvl of [1, 4, 6, 9, 12, 20, 30, 45]) {
    const { t } = withShapes('hard', lvl, kinds, 500);
    botScan(t, SK.hard, true);
    assert.ok(t.aiFarm, 'level ' + lvl + ' found nothing to farm');
    assert.ok(t.aiFarm.maxHealth >= prev,
      'level ' + lvl + ' dropped back to a ' + t.aiFarm.kind + ' after a bigger one');
    prev = t.aiFarm.maxHealth;
    if (first === null) first = t.aiFarm.kind;
  }
  // Not "Squares", specifically: the collision multiplier vs a shape is 4, so a
  // level 1 tank puts 20 a tick into a Triangle by leaning on it and eats 30 HP
  // of it in half a second for 10 of its own. Squares and Triangles are both the
  // right answer at that size; a Pentagon at eleven seconds of standing still is
  // not, and neither is anything above it.
  assert.ok(first === 'square' || first === 'triangle', 'the smallest tank was on ' + first);

  // And it holds when the big one is the closest thing on the map, which is
  // where a nearest-first fallback used to put small bots straight back on it.
  const { g, t } = withShapes('hard', 2, [], 0);
  const near = g.add(new Shape(g, 'hexagon', 300, 0));
  near.shiny = false; near.scoreReward = SHAPES.hexagon.score;
  near.health = near.maxHealth = SHAPES.hexagon.health;
  const far = g.add(new Shape(g, 'square', 1500, 0));
  far.shiny = false; far.scoreReward = SHAPES.square.score;
  far.health = far.maxHealth = SHAPES.square.health;
  botScan(t, SK.hard, true);
  assert.equal(t.aiFarm, far, 'took the near Hexagon over a Square five times further out');
});

console.log('\nRespawn');
test('a dead bot comes back one rung down, not from scratch', () => {
  // The whole arena resetting to zero on every death is why a Very Hard board
  // used to churn in the low hundreds forever: ~200 bot deaths a minute against
  // a population that always restarted at level 1.
  const g = new Game('ffa', null, { headless: true, botCount: 1, difficulty: 'medium' });
  const dead = g.entities.filter((e) => e.type === 'tank' && e.bot)[0];
  dead.addScore(LEVEL_SCORE[20] - dead.score);
  assert.equal(dead.level, 20);
  dead.kill(null);
  assert.equal(g.botRespawn.join(), String(respawnLevel(20)));
  const back = g.spawnBot();
  assert.equal(back.level, respawnLevel(20), 'came back at level ' + back.level);
  assert.ok(back.level > 1 && back.level < 20, 'respawn must cost something, and not everything');
  assert.equal(g.botRespawn.length, 0, 'the slot was consumed');
  assert.equal(g.spawnBot().level, 1, 'an empty queue still spawns fresh bots');
});

test('the queue cannot outgrow the bot count', () => {
  // /bots 0 stops respawns; deaths must not pile up a backlog that all walks
  // back in at once the moment bots are turned on again.
  const g = new Game('ffa', null, { headless: true, botCount: 8, difficulty: 'medium' });
  for (const t of g.entities.filter((e) => e.type === 'tank' && e.bot)) t.kill(null);
  assert.ok(g.botRespawn.length <= 8, g.botRespawn.length + ' queued for 8 slots');
  g.botCount = 0;
  g.spawnBot().kill(null);
  assert.equal(g.botRespawn.length, 0);
});

console.log('\nBallistics and output');
test('a trap is modelled as a trap: it coasts to a stop, it does not fly', () => {
  // fireBarrel zeroes accel on a trap, so it never holds cruise. The model
  // stepped one as if it did and came out at 49577 units of carry against a real
  // 1115, which is why Trappers stood a thousand units off leading a shot that
  // was never going to arrive.
  const g = bare('hard', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  setClass(t, 'Trapper');
  t.bot = false; t.autoFire = true;
  t.mouse.x = t.x + 4000; t.mouse.y = t.y;
  let trap = null;
  for (let i = 0; i < 200 && !trap; i++) { g.step(); trap = g.entities.filter((e) => e.type === 'trap')[0]; }
  assert.ok(trap, 'expected a trap');
  const start = trap.x;
  let carry = 0, n = 0;
  while (!trap.dead && n < 800) { g.step(); n++; carry = Math.max(carry, trap.x - start); }
  assert.ok(carry > 0, 'the trap never moved');
  assert.ok(Math.abs(botReach(t) - carry) < carry * 0.3,
    'reach says ' + Math.round(botReach(t)) + ', the trap stops at ' + Math.round(carry));
  // And the model refuses to promise a flight time it cannot deliver.
  assert.equal(botFlightTicks(t, carry * 3), 0, 'claimed a trap reaches three times as far as it does');
});

test('a barrel that points backwards is not counted as output', () => {
  // A Booster has one gun and four thrusters. Counting all five told it it
  // out-DPSed everything, and botWinOdds sent it into fights it loses.
  const g = bare('hard', { react: 9999 });
  const boost = place(g.spawnBot(), 0, 0), twin = place(g.spawnBot(), 900, 0);
  setClass(boost, 'Booster');
  setClass(twin, 'Twin');
  const fwd = boost.barrels.filter((b) => Math.abs(b.def.angle) < 0.1).length;
  assert.equal(boost.barrels.length - fwd, 4, 'expected four thrusters on a Booster');
  assert.ok(botDps(boost) < botDps(twin),
    'a Booster with one forward gun should not out-DPS a Twin with two');
});

test('class choice ranks effective barrels, not a headcount', () => {
  const gun = BOT_BUILDS.filter((b) => !b.ram)[0];
  assert.ok(botClassScore(byName('Triplet'), gun) > botClassScore(byName('Booster'), gun),
    'three forward guns should outrank one gun and four thrusters');
});

console.log('\nSwarms');
test('shoots the drone that is on it, and the spawner when that is nearer', () => {
  // Everything with an owner used to be skipped in the scan outright, so no bot
  // had ever fired at a drone: an Overlord's eight had no answer but running.
  const g = bare('extreme', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.addScore(LEVEL_SCORE[30]);
  const foe = place(g.spawnBot(), 2400, 0);
  const drone = g.add(new Entity(g, { type: 'drone', x: 500, y: 0, size: 12, damage: 5 }));
  drone.owner = foe; drone.vx = -8; drone.vy = 0;          // closing on the bot at the origin
  g.rebuildGrid(); botScan(t, SK.extreme, false);
  assert.equal(t.aiTarget, drone, 'ignored a drone closing from 500 units');

  // Same drone, owner now the nearer of the two: kill the spawner instead.
  place(foe, 300, 0);
  g.rebuildGrid(); botScan(t, SK.extreme, false);
  assert.equal(t.aiTarget, foe, 'shot the drone while its owner stood closer');
});

test('bullets and parked traps are dodged, never chased', () => {
  for (const kind of ['bullet', 'trap']) {
    const g = bare('extreme', { react: 9999 });
    const t = place(g.spawnBot(), 0, 0);
    t.addScore(LEVEL_SCORE[30]);
    const foe = place(g.spawnBot(), 2400, 0);
    const p = g.add(new Entity(g, { type: kind, x: 500, y: 0, size: 10, damage: 5 }));
    p.owner = foe; p.vx = -8; p.vy = 0;
    g.rebuildGrid(); botScan(t, SK.extreme, false);
    assert.notEqual(t.aiTarget, p, 'went after a ' + kind);
  }
});

console.log('\nClass abilities');
test('the sniper line gets the awareness its field of view pays for', () => {
  const sees = (name) => {
    const g = bare('hard', { react: 9999 });
    const t = place(g.spawnBot(), 0, 0);
    setClass(t, name);
    const foe = place(g.spawnBot(), 1900, 0);
    g.rebuildGrid(); botScan(t, SK.hard, false);
    return t.aiTarget === foe;
  };
  assert.equal(sees('Tank'), false, 'a Tank should not see 1900 units on Hard');
  assert.equal(sees('Ranger'), true, "a Ranger's camera covers that and then some");
});

test('Predator zoom moves the view down the barrel, it does not widen it', () => {
  const look = (angle) => {
    const g = bare('hard', { react: 9999 });
    const t = place(g.spawnBot(), 0, 0);
    setClass(t, 'Predator');
    t.angle = angle; t.input.altFire = 1;
    const foe = place(g.spawnBot(), 2600, 0);           // out past sight, dead ahead
    g.rebuildGrid(); botScan(t, SK.hard, false);
    return t.aiTarget === foe;
  };
  assert.equal(look(0), true, 'zoomed down the barrel and still missed it');
  assert.equal(look(Math.PI), false, 'saw behind itself while zoomed the other way');
});

test('a Stalker holds still to disappear; a Sniper never does', () => {
  const run = (name) => {
    const g = bare('extreme', { react: 9999, aimErr: 0, strafe: 0 });
    const t = place(g.spawnBot(), 0, 0);
    setClass(t, name);
    t.aiTarget = place(g.spawnBot(), 1400, 0);
    t.aiTarget.vx = -12;                                  // walking straight at us
    g.tick = 1; tickBot(t);
    return { moved: !!(t.input.up || t.input.down || t.input.left || t.input.right), fire: t.input.fire };
  };
  const stalk = run('Stalker');
  assert.equal(stalk.moved, false, 'a Stalker that keeps walking never goes invisible');
  assert.equal(stalk.fire, 0, 'and firing undoes it faster than anything else');
  assert.equal(run('Sniper').fire, 1, 'a Sniper has nothing to hide and should shoot');
});

test('a Necromancer wants Squares, not the fattest shape on the board', () => {
  const pickFor = (name) => {
    const { g, t } = withShapes('hard', 30, ['square', 'pentagon'], 600);
    setClass(t, name);
    g.rebuildGrid(); botScan(t, SK.hard, true);
    return t.aiFarm && t.aiFarm.kind;
  };
  assert.equal(pickFor('Necromancer'), 'square', 'a Square is a drone, not a snack');
  assert.equal(pickFor('Overlord'), 'pentagon', 'anything else should still take the fatter shape');
});

console.log('\nHabits');
test('the strafe has no period to read off it', () => {
  const g = bare('extreme', { react: 9999, aimErr: 0 });
  const t = place(g.spawnBot(), 0, 0);
  t.aiTarget = place(g.spawnBot(), 700, 0);
  const flips = [];
  let last, since = 0;
  for (let i = 1; i < 4000; i++) {
    g.tick = i; tickBot(t); since++;
    if (last !== undefined && t.strafeDir !== last) { flips.push(since); since = 0; }
    last = t.strafeDir;
  }
  assert.ok(flips.length > 8, 'only ' + flips.length + ' flips in 4000 ticks');
  assert.ok(new Set(flips).size > 3, 'flipped on a fixed interval: ' + flips.join(','));
});

test('a maxed bot still declines a fight it plainly loses', () => {
  // "Nothing left to farm for" used to mean "take every fight", which is how the
  // strongest tanks on the board ended up with the shortest lives.
  const g = bare('hard', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  t.addScore(LEVEL_SCORE[45]);
  const foe = place(g.spawnBot(), 1400, 0);
  foe.addScore(LEVEL_SCORE[45]);
  // Both fully built, so the odds turn on health alone and nothing else.
  for (const who of [t, foe])
    for (let i = 0; i < 80; i++) for (const w of BOT_BUILDS[0].order) if (who.upgradeStat(w)) break;
  t.health = t.maxHealth * 0.05;                          // a sliver, against a maxed gun
  assert.equal(botShouldFight(t, foe, SK.hard), false);
  t.health = t.maxHealth;
  assert.equal(botShouldFight(t, foe, SK.hard), true, 'and takes it back once healthy');
});

console.log('\nObjectives');
// Bots played FFA in all four objective modes: a Dominator is level 75 and a
// Mothership 140, so botScan's punching-up cull dropped both, and nothing
// anywhere read g.flags or g.tiles.
function objBot(mode, level) {
  const g = new Game(mode, null, { headless: true, botCount: 0, difficulty: 'extreme' });
  g.wantedShapes = 0;
  g.entities = g.entities.filter((e) => e.type !== 'shape');
  const t = g.spawnBot();
  t.team = g.teams[0];
  t.addScore(LEVEL_SCORE[level === undefined ? 30 : level]);
  return { g, t };
}
function objective(g, t) { return g.logic.botGoal(g, t); }

test('domination: a grown bot goes for a Dominator it does not own', () => {
  const { g, t } = objBot('domination');
  const o = objective(g, t);
  assert.ok(o && o.e && o.e.isDominator, 'no Dominator picked');
  assert.notEqual(o.e.team, t.team);
  g.dominators.forEach((d) => { d.team = t.team; });
  assert.equal(objective(g, t), null, 'kept attacking one it already holds');
});

test('domination: a small bot levels first instead of donating', () => {
  const { g, t } = objBot('domination', 4);
  assert.equal(objective(g, t), null);
});

test('mothership: the enemy Mothership is the job', () => {
  const { g, t } = objBot('mothership');
  const o = objective(g, t);
  assert.ok(o && o.e && o.e.isMothership, 'no Mothership picked');
  assert.notEqual(o.e.team, t.team);
});

test('breakout: heads for neutral ground touching ground we hold', () => {
  const { g, t } = objBot('breakout');
  place(t, 0, 0);
  const o = objective(g, t);
  assert.ok(o && o.touch, 'no tile picked');
  const tile = g.tiles.filter((x) => x.x === o.x && x.y === o.y)[0];
  assert.ok(tile && tile.team === null, 'picked ground somebody already holds');
});

// NB: this checks what the bot decides, not that a capture lands — a CTF flag
// sits 200 units inside the defending base, and baseContact hits anything from
// the other team for maxHealth/12 a tick and shoves it back out. Driving a level
// 30 tank straight at one dies at 239 units with the pickup radius at 118, so
// nobody — bot or player — can currently take a flag. That is an arena layout
// bug, not an AI one, and it is why ctf is missing from the end-to-end test below.
test('ctf: walks onto a loose enemy flag, and runs a carried one home', () => {
  const { g, t } = objBot('ctf');
  place(t, 0, 0);
  let o = objective(g, t);
  assert.ok(o && o.touch, 'no flag picked');
  const flag = g.flags.filter((f) => f.x === o.x && f.y === o.y)[0];
  assert.ok(flag && flag.team !== t.team, 'went for its own flag');
  assert.ok(!o.hard, 'a flag on the ground is not worth ignoring a fight for');

  flag.carrier = t;
  o = objective(g, t);
  const home = g.bases.filter((b) => b.team === t.team)[0];
  assert.ok(o && o.hard && o.x === home.x && o.y === home.y, 'did not run it home');
});

test('a carried flag keeps the legs going home and the gun on the chaser', () => {
  const { g, t } = objBot('ctf');
  place(t, 0, 0);
  const home = g.bases.filter((b) => b.team === t.team)[0];
  g.flags.filter((f) => f.team !== t.team)[0].carrier = t;
  const chaser = place(g.spawnBot(), 0, 900);
  chaser.team = g.teams[1];
  t.aiTarget = chaser; t.aiEngaged = chaser;
  g.tick = 1; tickBot(t);
  const toHome = Math.atan2(home.y - t.y, home.x - t.x);
  const moving = Math.atan2(t.input.down - t.input.up, t.input.right - t.input.left);
  assert.ok(Math.abs(angleDiff(moving, toHome)) < 1.0, 'walked the wrong way with the flag');
  assert.ok(Math.abs(angleDiff(aimAngle(t), Math.atan2(chaser.y - t.y, chaser.x - t.x))) < 0.6,
    'stopped covering the tank chasing it');
});

test('every objective mode actually moves its scoreboard with bots alone', () => {
  // The end-to-end version: no players, no hand-placed goals, just bots. Each of
  // these was flat at zero for the whole run before botGoal existed.
  for (const [mode, read] of [
    ['domination', (g) => g.dominators.filter((d) => d.team).length],
    ['mothership', (g) => g.motherships.reduce((a, m) => a + (m.maxHealth - m.health), 0)],
    ['breakout', (g) => g.tiles.filter((x) => x.team).length]
  ]) {
    const g = new Game(mode, null, { headless: true, botCount: 24, difficulty: 'extreme' });
    for (const t of g.entities.filter((e) => e.type === 'tank' && e.bot)) t.addScore(LEVEL_SCORE[30]);
    const before = read(g);
    for (let i = 0; i < 4000; i++) g.step();
    assert.ok(read(g) > before, mode + ' never moved: ' + before + ' -> ' + read(g));
  }
});

console.log('\n' + passed + ' passed\n');
