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
  const g = new Game('sandbox', 'T', { botCount: 0, difficulty });
  g.wantedShapes = 0;
  g.entities = g.entities.filter((e) => e.type !== 'shape');
  if (skillOverrides) g.botSkill = Object.assign({}, g.botSkill, skillOverrides);
  return g;
}
function place(t, x, y) { t.x = t.px = x; t.y = t.py = y; return t; }
function aimAngle(t) { return Math.atan2(t.mouse.y - t.y, t.mouse.x - t.x); }

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
    t.addScore(LEVEL_SCORE[30]);
    t.aiFarm = g.add(new Shape(g, kind, 300, 0));
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
  botScan(small, SK.extreme);
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

console.log('\nRetreat');
test('hurt bots break off and come back once healed', () => {
  const g = bare('extreme', { react: 9999 });
  const t = place(g.spawnBot(), 0, 0);
  const foe = place(g.spawnBot(), 300, 0);
  t.aiTarget = foe;
  t.health = t.maxHealth * 0.2;
  g.tick = 1; tickBot(t);
  assert.equal(t.fleeing, true);
  assert.equal(t.input.left, 1, 'should be backing away from something at +x');
  t.health = t.maxHealth * 0.9;
  g.tick = 2; tickBot(t);
  assert.equal(t.fleeing, false, 'should re-engage once patched up');
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
function winRate(lo, hi, n = 30) {
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

test('better bots farm better', () => {
  const score = (d) => {
    let total = 0;
    for (let run = 0; run < 5; run++) {
      const g = new Game('ffa', null, { headless: true, botCount: 0, difficulty: d });
      g.mode = Object.assign({}, g.mode, { noBoss: true });
      g.botCount = 0;
      const t = g.spawnBot();
      let peak = 0;
      for (let i = 0; i < 3000 && !t.dead; i++) { g.step(); if (t.score > peak) peak = t.score; }
      total += peak;                       // peak, not final: a late death still earned it
    }
    return total / 5;
  };
  // Loose on purpose. Farming is noisy over a handful of runs, and this guards
  // an inversion, not a percentage — the real gap is nearer 4x over 10 runs.
  const easy = score('easy'), hard = score('hard');
  assert.ok(hard > easy * 1.5, `Hard farmed ${Math.round(hard)} vs Easy ${Math.round(easy)}`);
});

console.log('\n' + passed + ' passed\n');
