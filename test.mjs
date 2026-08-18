// Acceptance tests from the build spec, section 24. `node test.mjs`
// Loads the browser scripts into one shared context — no bundler, no framework.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ctx = vm.createContext({ console, Math, JSON, Map, Set, Infinity, NaN });
for (const f of ['js/tankdefs.js', 'js/tankdefs-extra.js', 'js/data.js', 'js/protocol.js', 'js/engine.js', 'js/modes.js'])
  vm.runInContext(readFileSync(new URL(f, import.meta.url), 'utf8'), ctx, { filename: f });

const G = (expr) => vm.runInContext(expr, ctx);
const { Game, Tank, Entity, handleCollision } = ctx;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: got ${a}, want ~${b}`);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

console.log('\nPhase 0 — data');
test('61 tanks load (54 from the dump + 7 added), Trapper is id 31', () => {
  assert.equal(G('TANK_DEFS.filter(Boolean).length'), 61);
  assert.equal(G('TANK_DEFS[31].name'), 'Trapper');
  // Sniper -> Assassin / Overseer / Hunter / Trapper. Settles the Trapper=30 vs 31 conflict.
  assert.equal(G('JSON.stringify(TANK_DEFS[6].upgrades)'), '[15,11,19,31]');
});

console.log('\nPhase 1 — physics');
test('constant acceleration settles at 10x accel per tick of travel', () => {
  const g = new Game('sandbox', 'T');
  const e = new Entity(g, { type: 'bullet', x: 0, y: 0 });
  e.canEscapeArena = true;
  for (let i = 0; i < 400; i++) { e.addVelocity(0, 3); e.applyPhysics(); }
  const before = e.x;
  e.addVelocity(0, 3); e.applyPhysics();
  near(e.x - before, 30, 0.01, 'distance travelled per tick');   // position integrates pre-friction
});
test('deletion animation is 5 frames', () => {
  const g = new Game('sandbox', 'T');
  const e = g.add(new Entity(g, { type: 'bullet', x: 0, y: 0, maxHealth: 1 }));
  e.kill(null);
  let frames = 0;
  while (g.entities.includes(e) && frames < 20) { g.step(); frames++; }
  assert.equal(frames, 5);
});

console.log('\nPhase 2 — damage model');
const mk = (g, o) => new Entity(g, o);
test('tank rams shape -> exactly 20 at 0 body-damage points', () => {
  const g = new Game('sandbox', 'T');
  const tank = mk(g, { type: 'tank', damage: 5, maxHealth: 1000, minDmg: 1, maxDmg: 6 });
  const shape = mk(g, { type: 'shape', damage: 2, maxHealth: 1000, minDmg: 1, maxDmg: 4 });
  handleCollision(tank, shape);
  near(1000 - shape.health, 20, 1e-9, 'tank->shape');
  near(1000 - tank.health, 8, 1e-9, 'shape->tank');   // 2 * 4
});
test('tank rams tank -> exactly 30', () => {
  const g = new Game('sandbox', 'T');
  const a = mk(g, { type: 'tank', damage: 5, maxHealth: 1000, minDmg: 1, maxDmg: 6 });
  const b = mk(g, { type: 'tank', damage: 5, maxHealth: 1000, minDmg: 1, maxDmg: 6 });
  handleCollision(a, b);
  near(1000 - b.health, 30, 1e-9, 'tank->tank');
});
test('basic bullet deals exactly 7; body deals 5 back', () => {
  const g = new Game('sandbox', 'T');
  const tank = mk(g, { type: 'tank', damage: 5, maxHealth: 1000, minDmg: 1, maxDmg: 6 });
  const bullet = mk(g, { type: 'bullet', damage: 7, maxHealth: 1000, minDmg: 0.25, maxDmg: 1 });
  handleCollision(tank, bullet);
  near(1000 - tank.health, 7, 1e-9, 'bullet->tank');
  near(1000 - bullet.health, 5, 1e-9, 'body->bullet');
});
test('bullet vs bullet is quartered', () => {
  const g = new Game('sandbox', 'T');
  const a = mk(g, { type: 'bullet', damage: 7, maxHealth: 1000, minDmg: 0.25, maxDmg: 1 });
  const b = mk(g, { type: 'bullet', damage: 7, maxHealth: 1000, minDmg: 0.25, maxDmg: 1 });
  handleCollision(a, b);
  near(1000 - b.health, 1.75, 1e-9, '0.25x');
});
test('drone vs bullet: both deal full damage', () => {
  const g = new Game('sandbox', 'T');
  const drone = mk(g, { type: 'drone', damage: 7, maxHealth: 1000, minDmg: 1, maxDmg: 1 });
  const bullet = mk(g, { type: 'bullet', damage: 7, maxHealth: 1000, minDmg: 0.25, maxDmg: 1 });
  handleCollision(drone, bullet);
  near(1000 - bullet.health, 7, 1e-9, 'drone->bullet');
  near(1000 - drone.health, 7, 1e-9, 'bullet->drone');
});
test('no overkill: damage scales so the loser lands exactly on 0', () => {
  const g = new Game('sandbox', 'T');
  const strong = mk(g, { type: 'tank', damage: 5, maxHealth: 1000, minDmg: 1, maxDmg: 6 });
  const weak = mk(g, { type: 'shape', damage: 2, maxHealth: 10, minDmg: 1, maxDmg: 4 });
  handleCollision(strong, weak);
  near(weak.health, 0, 1e-9, 'weak dies exactly');
  near(1000 - strong.health, 8 * (10 / 20), 1e-9, 'strong takes scaled-down damage');
});

console.log('\nPhase 3 — barrels, bullets, recoil');
test('basic tank at 0 reload fires every 15 ticks', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  near(t.reloadTime, 15, 1e-9, 'reloadTime');
  near(t.barrels[0].period(), 15, 1e-9, 'barrel period');
  near(15 * Math.pow(0.914, 7), 8, 0.01, '7 points -> 8 ticks = 0.32s');
});
test('bullet stat formulas', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  t.input.fire = 1;
  for (let i = 0; i < 16; i++) t.barrels[0].tick(true);
  const b = g.entities.filter(e => e.type === 'bullet')[0];
  assert.ok(b, 'a bullet was fired');
  near(b.maxHealth, 2, 1e-9, 'penetration (1.5*0+2)*1');
  near(b.damagePerTick, 7, 1e-9, 'damage (7+0)*1');
  near(b.size, 21, 1e-9, 'size = width/2 * sizeRatio');
  near(b.life, 75, 1e-9, 'lifeLength 1 -> 75 ticks = 3.0s');
});
test('Twin Flank nets zero recoil; Annihilator kicks 6.8 grid squares', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  t.setTank(13); t.recompute();                       // Twin Flank: 2 front, 2 rear
  t.angle = 0; t.vx = 0; t.vy = 0;
  t.barrels.slice(0, 2).forEach(b => b.shoot());
  const frontOnly = Math.hypot(t.vx, t.vy);
  near(frontOnly, 4, 0.05, 'front pair alone kicks recoil*2 each');
  t.vx = 0; t.vy = 0;
  t.barrels.forEach(b => b.shoot());
  // Recoil uses the scattered angle, so all four cancel to shot noise, not to exactly 0.
  assert.ok(Math.hypot(t.vx, t.vy) < frontOnly / 4, 'opposed barrels cancel');

  t.setTank(49); t.recompute();                       // Annihilator
  t.angle = 0; t.vx = 0; t.vy = 0;
  t.barrels[0].shoot();
  // total displacement under 10% friction = v / 0.1
  near(Math.hypot(t.vx, t.vy) / 0.1 / 50, 6.8, 0.05, 'grid squares travelled');
});
test('Octo Tank barrels alternate in two sets of four', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  t.setTank(5); t.recompute();
  const phases = t.barrels.map(b => Math.round(b.cycle));
  const distinct = [...new Set(phases)];
  assert.equal(distinct.length, 2, 'two firing phases');
  assert.equal(phases.filter(p => p === distinct[0]).length, 4);
});

console.log('\nPhase 4 — progression');
test('XP table matches the published values', () => {
  const L = G('LEVEL_SCORE');
  const want = { 2: 4, 3: 13, 4: 28, 5: 50, 15: 787, 30: 6184, 40: 16000, 45: 23536 };
  for (const [lvl, score] of Object.entries(want))
    assert.equal(Math.floor(L[lvl]), score, `level ${lvl}`);
});
test('skill points: 27 by L28, plateau to L30, 33 at L45', () => {
  const sc = G('statCount');
  assert.equal(sc(28), 27);
  assert.equal(sc(29), 27);
  assert.equal(sc(30), 28);
  assert.equal(sc(45), 33);
});
test('level 45 tank is 1.549x a level 1 tank and moves at 52%', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  const s1 = t.movementSpeed;
  t.score = G('LEVEL_SCORE[45]'); t.level = 45; t.recompute();
  near(t.scaleFactor, 1.549, 0.001, 'scale');
  near(t.size, 50 * 1.549, 0.05, 'radius');
  near(t.movementSpeed / s1, 1 / Math.pow(1.015, 44), 1e-9, 'speed penalty');
  near(t.movementSpeed / s1, 0.519, 0.001, '~52%');
});
test('respawn level: 45 -> 22, 10 -> 9, 4 -> 3', () => {
  const r = G('respawnLevel');
  assert.equal(r(45), 22); assert.equal(r(10), 9); assert.equal(r(4), 3);
});
test('health: L1 = 50.0, L45 = 138, each Max Health point = +20', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  near(t.maxHealth, 50, 1e-9, 'level 1');
  t.level = 45; t.recompute();
  near(t.maxHealth, 138, 1e-9, 'level 45');
  t.stats[6] = 7; t.recompute();
  near(t.maxHealth, 138 + 140, 1e-9, '7 points');
});
test('regen: 0 points = 0.1%/s, each point adds 0.4%/s', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  near(t.regenPerTick * 25 / t.maxHealth * 100, 0.1, 1e-9, 'base');
  t.stats[7] = 1; t.recompute();
  near(t.regenPerTick * 25 / t.maxHealth * 100, 0.5, 1e-9, '1 point');
});

console.log('\nPhase 5 — shapes');
test('shape draw radii are the round numbers players measure', () => {
  const S = G('SHAPES');
  near(S.square.size * Math.SQRT2, 55, 1e-9, 'square');
  near(S.pentagon.size * Math.SQRT2, 75, 1e-9, 'pentagon');
  near(S.alpha.size * Math.SQRT2, 200, 1e-9, 'alpha');
});
test('basic tank kills: Square in 2, Triangle in 5, Pentagon in 22', () => {
  const g = new Game('sandbox', 'T');
  const shoot = (kind) => {
    const S = G('SHAPES')[kind];
    let hp = S.health, shots = 0;
    while (hp > 0 && shots < 100) {
      // one bullet: 2 HP, 7 dmg/tick, vs a shape (common multiplier 1)
      let bulletHp = 2;
      while (bulletHp > 0 && hp > 0) {
        const dToShape = 7, dToBullet = S.damage * 1;
        const ratio = Math.max(1 - bulletHp / dToBullet, 1 - hp / dToShape);
        const k = Math.min(1, 1 - ratio);
        hp -= dToShape * k; bulletHp -= dToBullet * k;
      }
      shots++;
    }
    return shots;
  };
  assert.equal(shoot('square'), 2);
  assert.equal(shoot('triangle'), 5);
  assert.equal(shoot('pentagon'), 22);
});
test('spawn zones: nest is pentagons, ring is crashers, field is 80/16/4', () => {
  const g = new Game('ffa', 'T');
  const a = g.arena;
  const zone = e => {
    const m = Math.max(Math.abs(e.x), Math.abs(e.y));
    return m < a.right / 10 ? 'nest' : m < a.right / 5 ? 'ring' : 'field';
  };
  const shapes = g.entities.filter(e => e.type === 'shape');
  assert.equal(shapes.length, 1000, '1000 shapes maintained');
  const nest = shapes.filter(e => zone(e) === 'nest');
  const ring = shapes.filter(e => zone(e) === 'ring');
  const field = shapes.filter(e => zone(e) === 'field');
  assert.ok(nest.every(e => e.kind === 'pentagon' || e.kind === 'alpha' || e.kind === 'hexagon'), 'nest is the pentagon family');
  assert.ok(ring.every(e => e.isCrasher), 'ring is crashers');
  const squares = field.filter(e => e.kind === 'square').length / field.length;
  near(squares, 0.80, 0.05, 'field square share');
});

console.log('\nPhase 6 — class tree');
test('every upgrade is reachable at the right level from the right parent', () => {
  const defs = G('TANK_DEFS').filter(Boolean);
  let edges = 0;
  for (const d of defs) for (const up of d.upgrades || []) {
    const u = G(`TANK_DEFS[${up}]`);
    assert.ok(u, `${d.name} -> ${up} exists`);
    assert.ok(u.levelRequirement > d.levelRequirement, `${d.name}(${d.levelRequirement}) -> ${u.name}(${u.levelRequirement})`);
    edges++;
  }
  assert.ok(edges > 40, `${edges} upgrade edges`);
});
test('upgradeTo refuses a class that is not offered', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  assert.equal(t.upgradeTo(49), false, 'Annihilator not reachable from Tank');
  t.level = 15; t.checkUpgrades();
  assert.equal(t.upgradeTo(1), true, 'Twin is');
  assert.equal(t.tankId, 1);
});
test('Smasher hides bullet stats and caps the rest at 10', () => {
  const s = G('TANK_DEFS[36].stats');
  assert.equal(s[2].max, 0); assert.equal(s[3].max, 0); assert.equal(s[4].max, 0); assert.equal(s[1].max, 0);
  assert.equal(s[0].max, 10); assert.equal(s[5].max, 10); assert.equal(s[6].max, 10); assert.equal(s[7].max, 10);
  assert.equal(G('TANK_DEFS[50].stats').every(x => x.max === 10), true, 'Auto Smasher caps all 8 at 10');
});
test('Necromancer captures a Square, up to 11 + reload points per barrel', () => {
  const g = new Game('sandbox', 'N');
  const t = g.player;
  t.level = 45; t.setTank(17); t.recompute();          // Necromancer
  assert.equal(t.barrels[0].maxDrones(), 11);
  t.stats[1] = 7; assert.equal(t.barrels[0].maxDrones(), 18);
  const sq = g.entities.filter(e => e.type === 'shape' && e.kind === 'square')[0];
  assert.ok(sq, 'a square exists');
  assert.equal(g.tryClaim(t, sq), true);
  assert.equal(sq.type, 'necro');
  assert.equal(sq.owner, t);
  assert.equal(t.barrels[0].children.length, 1);
});
test('invisibility fades at 1/invisibilityRate ticks', () => {
  const secs = (id) => Math.ceil(1 / G(`TANK_DEFS[${id}].invisibilityRate`)) / 25;
  near(secs(38), 13.0, 0.5, 'Landmine');   // matches the measured ~13.0s
  // Stalker's shipped rate (0.03) gives 1.33s, not the community-measured 2.2s.
  // Landmine matching exactly says the model is right, so the data table wins.
  near(secs(21), 1.33, 0.05, 'Stalker per shipped data');
  near(secs(26), 1.33, 0.05, 'Manager per shipped data');
});
test('opacity actually reaches 0 and invisible tanks cannot be targeted', () => {
  const g = new Game('sandbox', 'S');
  const t = g.player;
  t.level = 45; t.setTank(21); t.recompute();          // Stalker
  t.protectedUntil = 0;                                 // spawn protection zeroes damageReduction
  for (let i = 0; i < 40; i++) t.tick();
  assert.equal(t.opacity, 0, 'fully invisible when idle');
  const hunter = mk(g, { type: 'tank', x: t.x + 100, y: t.y, team: 'red' });
  assert.notEqual(g.findTarget(hunter, 1700, true), t, 'invisible tank is not targeted');
  t.opacity = 1;
  assert.equal(g.findTarget(hunter, 1700, true), t, 'but the same tank is once visible');
  t.opacity = 0;
  t.applyDamage(1, null);
  near(t.opacity, 0.2, 1e-9, 'taking damage reveals by +0.2');
});

console.log('\nPhase 7/8 — entities and modes');
test('a boss is worth 30000 XP and has 3000 HP', () => {
  const g = new Game('ffa', 'T');
  const b = g.spawnBoss(0);
  assert.equal(b.maxHealth, 3000);
  assert.equal(b.scoreReward, 30000);
  assert.ok(g.notifications.some(n => /has spawned/.test(n.text)));
});
test('one boss at a time, on the 45 minute reset', () => {
  const g = new Game('ffa', 'T');
  assert.equal(g.bossTimer, 45 * 60 * 25);
  g.spawnBoss(1);
  const first = g.boss;
  g.bossTimer = 1; g.step();
  assert.equal(g.boss, first, 'no second boss while one lives');
});
test('team modes: friendly fire is impossible', () => {
  const g = new Game('team2', 'T');
  assert.equal(g.teams.length, 2);
  const a = mk(g, { type: 'tank', team: 'blue', damage: 5, maxHealth: 100, minDmg: 1, maxDmg: 6 });
  const b = mk(g, { type: 'tank', team: 'blue', damage: 5, maxHealth: 100, minDmg: 1, maxDmg: 6 });
  handleCollision(a, b);
  assert.equal(a.health, 100); assert.equal(b.health, 100);
});
test('enemy projectiles dissolve at a base edge, enemy tanks are hurt and ejected', () => {
  const g = new Game('team2', 'T');
  const base = g.bases[0];
  const bullet = mk(g, { type: 'bullet', team: 'red', x: base.x, y: base.y, maxHealth: 10 });
  bullet.owner = null;
  g.baseContact(bullet, base);
  assert.equal(bullet.dead, true);
  const tank = mk(g, { type: 'tank', team: 'red', x: base.x + 10, y: base.y, maxHealth: 240 });
  g.baseContact(tank, base);
  assert.ok(tank.health < 240 && Math.hypot(tank.vx, tank.vy) > 0, 'damaged and flung');
});
test('maze walls snap to the 50-unit grid', () => {
  const g = new Game('maze', 'T');
  assert.ok(g.walls.length > 0);
  assert.ok(g.walls.every(w => w.x % 50 === 0 && w.y % 50 === 0));
  assert.equal(g.mode.noBoss, true);
});

test('Hexagons exist and actually spawn in the nest', () => {
  const g = new Game('ffa', 'T');
  const h = new ctx.Shape(g, 'hexagon', 0, 0);
  assert.equal(h.maxHealth, 1500, 'confirmed HP');
  assert.equal(h.scoreReward, 1500, 'confirmed XP');
  assert.equal(h.sides, 6);

  const n = 20000, seen = {};
  for (let i = 0; i < n; i++) { const k = g.shapeKindAt(0, 0); seen[k] = (seen[k] || 0) + 1; }
  near(seen.alpha / n, 0.05, 0.01, 'alpha share');
  near(seen.hexagon / n, 0.10, 0.015, 'hexagon share');
  near(seen.pentagon / n, 0.85, 0.02, 'pentagon share');
  // nest ends at right/10 (1115), crasher ring at right/5 (2230), fields beyond
  assert.equal(g.shapeKindAt(1500, 0).slice(0, 7), 'crasher', 'crasher ring unchanged');
  assert.ok(['square', 'triangle', 'pentagon'].includes(g.shapeKindAt(9000, 0)), 'fields unchanged');
});

console.log('\nAdded tanks');
const countNew = (g, type) => g.entities.filter((e) => e.type === type).length;
const fireAll = (g, id) => {
  const t = g.player;
  t.level = 45; t.setTank(id); t.recompute();
  t.angle = 0; t.vx = 0; t.vy = 0;
  const before = g.entities.length;
  t.barrels.forEach((b) => b.shoot());
  return { tank: t, spawned: g.entities.length - before };
};

test('the seven added tanks slot into the right branches', () => {
  const want = { 63: ['Shotgun', 30], 61: ['Dual-Barrel', 45], 62: ['Pellet Shot', 45], 64: ['Glider', 45], 65: ['Firework', 45], 59: ['Auto Tank', 45], 66: ['Auto Shotgun', 45] };
  for (const [id, [name, lvl]] of Object.entries(want)) {
    const d = G(`TANK_DEFS[${id}]`);
    assert.ok(d, `${name} exists`);
    assert.equal(d.name, name);
    assert.equal(d.levelRequirement, lvl);
  }
  assert.ok(G('TANK_DEFS[7].upgrades').includes(63), 'Machine Gun -> Shotgun');
  assert.ok(G('TANK_DEFS[63].upgrades').includes(61), 'Shotgun -> Dual-Barrel');
  assert.ok(G('TANK_DEFS[63].upgrades').includes(62), 'Shotgun -> Pellet Shot');
  assert.ok(G('TANK_DEFS[63].upgrades').includes(66), 'Shotgun -> Auto Shotgun');
  assert.ok(G('TANK_DEFS[10].upgrades').includes(64), 'Destroyer -> Glider');
  assert.ok(G('TANK_DEFS[10].upgrades').includes(65), 'Destroyer -> Firework');
  assert.ok(G('TANK_DEFS[0].upgrades').includes(59), 'basic Tank -> Auto Tank');
});
test('Shotgun throws 12 pellets a shot and matches the published reload curve', () => {
  const g = new Game('sandbox', 'T');
  const { tank, spawned } = fireAll(g, 63);
  assert.equal(spawned, 12, '12 pellets per trigger pull');
  // published: 60 ticks at 0 points, falling to 32 at 7
  near(tank.reloadTime * tank.barrels[0].def.reload, 60, 0.01, '0 points');
  tank.stats[1] = 7; tank.recompute();
  near(tank.reloadTime * tank.barrels[0].def.reload, 32, 0.05, '7 points');
});
test('Shotgun pellet penetration and damage match the published figures', () => {
  const g = new Game('sandbox', 'T');
  const { tank } = fireAll(g, 63);
  const pellet = g.entities.filter((e) => e.type === 'bullet')[0];
  near(pellet.maxHealth, 1.2, 1e-9, 'penetration at 0 points');
  near(pellet.damagePerTick, 3.5, 1e-9, 'damage at 0 points');
  tank.stats[3] = 1; tank.stats[2] = 1;
  const p2 = tank.barrels[0].shoot();
  near(p2.maxHealth, 1.2 + 0.9, 1e-9, '+0.9 penetration per point');
  near(p2.damagePerTick, 3.5 + 1.5, 1e-9, '+1.5 damage per point');
});
test('Auto Shotgun follows the Auto-X convention the shipped data uses', () => {
  // In the real table every Auto variant is its base tank's barrels *unchanged*
  // plus a turret. Auto Shotgun is designed, not documented, so pin it to that rule.
  for (const [base, auto] of [[20, 39], [31, 44], [63, 66]]) {
    assert.equal(G(`JSON.stringify(TANK_DEFS[${base}].barrels)`), G(`JSON.stringify(TANK_DEFS[${auto}].barrels)`),
      `${G(`TANK_DEFS[${auto}].name`)} keeps its base barrels`);
    assert.equal(G(`TANK_DEFS[${auto}].postAddon`), 'autoturret');
  }
  const g = new Game('sandbox', 'T');
  const { tank, spawned } = fireAll(g, 66);
  assert.equal(spawned, 12, 'still a 12-pellet shotgun');
  assert.equal(tank.turrets.length, 1, 'plus one turret');
  assert.equal(G('TANK_DEFS[66].upgrades').length, 0, 'a leaf of the tree');
});
test('turret aim is an intercept solve, not a guess: it leads a crossing target onto the bullet', () => {
  // Fly the bullet with the exact integrator the sim uses (accel, then move, then
  // 10% friction) and check the closest approach lands inside a tank's hitbox.
  const aim = G('interceptAim');
  const S = 24, muzzle = 55;                      // turret bullet at 0 bullet-speed points
  for (const [dx, dy, vx, vy] of [[900, 0, 0, 12], [1500, 0, 0, -18], [600, 600, 9, -9], [300, 0, 20, 0], [120, 0, 0, 6]]) {
    const t = { x: dx, y: dy, vx, vy };
    const a = aim({ x: 0, y: 0 }, t, S, muzzle);
    let bx = Math.cos(a) * muzzle, by = Math.sin(a) * muzzle, v = S + 30;
    let tx = t.x, ty = t.y, best = Infinity;
    for (let n = 0; n < 75; n++) {
      v += S * 0.1;                                // maintainVelocity
      bx += Math.cos(a) * v; by += Math.sin(a) * v;
      v *= 0.9;                                    // friction
      tx += vx / 0.9; ty += vy / 0.9;
      best = Math.min(best, Math.hypot(bx - tx, by - ty));
    }
    assert.ok(best < 50, `leads (${dx},${dy}) moving (${vx},${vy}): missed by ${best.toFixed(1)}`);
  }
});
test('turret shots belong to the tank, not the turret, so they leave without hurting it', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  t.level = 45; t.setTank(59); t.recompute();     // Auto Tank: barrels + one turret
  t.health = t.maxHealth; t.godMode = false;
  const shot = t.turrets[0].barrel.shoot();
  assert.equal(shot.owner, t, 'owner is the tank (kill credit walks .owner)');
  assert.equal(G('canInteract')(shot, t), false, 'and so it passes through its own body');
});
test('Dual-Barrel fires 24, Pellet Shot fires 30', () => {
  assert.equal(fireAll(new Game('sandbox', 'T'), 61).spawned, 24);
  assert.equal(fireAll(new Game('sandbox', 'T'), 62).spawned, 30);
});
test('one recoil impulse per shot, not one per pellet', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  t.level = 45; t.setTank(62); t.recompute();     // Pellet Shot: 30 pellets
  t.angle = 0; t.vx = 0; t.vy = 0;
  t.barrels[0].shoot();
  near(Math.hypot(t.vx, t.vy), t.barrels[0].def.recoil * 2, 0.05, 'recoil * 2 once');
});
// An empty arena: no shapes, no bots. A Firework shell that collides with
// something dies from damage without bursting (which is correct — it bursts on
// right-click or fuse end, not when shot down), so the fuse test needs isolation.
const quietGame = () => {
  const g = new Game('sandbox', 'T');
  g.wantedShapes = 0; g.botCount = 0;
  g.entities = g.entities.filter((e) => e === g.player);
  return g;
};

test('Firework bursts into 16 shards, on right-click and when the fuse ends', () => {
  const g = quietGame();
  const { tank } = fireAll(g, 65);
  const shell = g.entities.filter((e) => e.type === 'firework')[0];
  assert.ok(shell, 'shell fired');
  assert.equal(shell.sides, 6, 'renders as a hexagon');
  near(shell.maxHealth, 8, 1e-9, 'published penetration 8');
  near(shell.damagePerTick, 4.9, 1e-9, 'published damage 4.9');

  // count only this shell's shards — bots in the arena are firing too
  const shardsOf = (game, shell) => game.entities.filter((e) => e.owner === shell).length;
  tank.input.altFire = 1;
  g.step();
  assert.equal(shardsOf(g, shell), 16, '16 shards on right-click');
  assert.equal(shell.dead, true, 'shell is spent');

  // and again via the fuse
  const g2 = quietGame();
  fireAll(g2, 65);
  const shell2 = g2.entities.filter((e) => e.type === 'firework')[0];
  for (let i = 0; i < shell2.life + 2 && !shell2.dead; i++) g2.step();
  assert.equal(shardsOf(g2, shell2), 16, '16 shards at end of life');
});
test('Glider missiles carry two rear barrels 35 degrees apart', () => {
  const g = new Game('sandbox', 'T');
  fireAll(g, 64);
  const m = g.entities.filter((e) => e.type === 'glider')[0];
  assert.ok(m, 'missile launched');
  assert.equal(m.barrels.length, 2);
  const spread = Math.abs(m.barrels[0].def.angle - m.barrels[1].def.angle);
  near(spread * 180 / Math.PI, 35, 0.1, 'degrees apart');
});
test('missile lifetimes match the measured figures', () => {
  const L = G('MISSILE_LIFE');
  near(L.skimmer / 25, 5, 0.01, 'Skimmer ~5s');
  near(L.rocket / 25, 4, 0.01, 'Rocketeer ~4s');
  near(L.glider / 25, 5, 0.01, 'Glider ~5s');
});
test('Auto Tank is the basic Tank plus a turret, with the published turret bullet', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  t.level = 45; t.setTank(59); t.recompute();
  assert.equal(t.turrets.length, 1);
  assert.equal(t.barrels.length, 1, 'still the basic cannon');
  const shot = t.turrets[0].barrel.shoot();
  near(shot.maxHealth, 2, 1e-9, 'published penetration 2');
  near(shot.damagePerTick, 2.1, 1e-9, 'published damage 2.1');
  near(t.turrets[0].barrel.def.bullet.speed, 1.2, 1e-9, '1.2x tank bullet speed');
});
test('regression: turret barrels fire without crashing, and push their tank', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  for (const id of [41, 40, 39, 44, 50, 59, 66]) {           // Auto 3/5/Gunner/Trapper/Smasher/Tank
    t.level = 45; t.setTank(id); t.recompute();
    t.vx = 0; t.vy = 0;
    assert.ok(t.turrets.length > 0, TANK_NAME(id) + ' has turrets');
    t.turrets[0].barrel.shoot();                          // used to throw: root.addVelocity
    assert.ok(Math.hypot(t.vx, t.vy) > 0, 'turret recoil pushes the tank it is mounted on');
  }
});
function TANK_NAME(id) { return G(`TANK_DEFS[${id}].name`); }
test('regression: missile barrel recoil propels the missile, not the player', () => {
  const g = new Game('sandbox', 'T');
  const t = g.player;
  t.level = 45; t.setTank(55); t.recompute();             // Rocketeer
  const missile = t.barrels[0].shoot();
  missile.statsOwner = t; missile.stats = t.stats; missile.reloadTime = t.reloadTime; missile.scaleFactor = 1;
  t.vx = 0; t.vy = 0; missile.vx = 0; missile.vy = 0;
  missile.barrels[0].shoot();
  near(Math.hypot(t.vx, t.vy), 0, 1e-9, 'player is untouched');
  assert.ok(Math.hypot(missile.vx, missile.vy) > 0, 'the missile is what moves');
});
test('every added tank runs 200 ticks of live fire without NaN', () => {
  for (const id of [63, 61, 62, 64, 65, 59, 66]) {
    const g = new Game('sandbox', 'T');
    const t = g.player;
    t.level = 45; t.setTank(id); t.recompute();
    t.autoFire = true;
    for (let i = 0; i < 200; i++) g.step();
    assert.ok(g.entities.every((e) => Number.isFinite(e.x) && Number.isFinite(e.y)), TANK_NAME(id) + ': no NaN');
  }
});

console.log('\nObjective modes');
test('Domination: four neutral Dominators, 6148 HP, bolted down', () => {
  const g = new Game('domination', 'T');
  assert.equal(g.dominators.length, 4);
  assert.equal(g.mode.xp, 2);
  for (const d of g.dominators) {
    assert.equal(d.team, null, 'starts neutral');
    assert.equal(d.maxHealth, 6000 + 2 * 74, 'def 6000 + level 75');
    assert.equal(d.immobile, true);
    assert.equal(d.absorb, 0, 'immovable');
    near(d.size, 160, 0.5, 'radius');
    assert.equal(d.damagePerTick, 10, '60 vs tanks, 40 vs shapes');
  }
});
test('Domination: killing a neutral Dominator captures it; killing it again contests it', () => {
  const g = new Game('domination', 'T');
  const dom = g.dominators[0];
  const blue = mk(g, { type: 'tank', team: 'blue' });
  blue.name = 'Blue'; blue.team = 'blue';
  dom.applyDamage(1e9, blue);
  assert.equal(dom.team, 'blue', 'captured');
  assert.equal(dom.dead, false, 'revived in place, never actually dies');
  assert.equal(dom.health, dom.maxHealth, 'health restored');
  assert.ok(g.notifications.some((n) => /now controlled by Blue/.test(n.text)));

  const red = mk(g, { type: 'tank', team: 'red' });
  red.team = 'red';
  dom.applyDamage(1e9, red);
  assert.equal(dom.team, null, 'an owned Dominator reverts to neutral first');
  assert.ok(g.notifications.some((n) => /being contested/.test(n.text)));
});
test('Domination: holding all four wins the round', () => {
  const g = new Game('domination', 'T');
  for (const d of g.dominators) { d.team = 'red'; }
  g.step();
  assert.ok(g.roundEndsAt > 0, 'round scheduled to end');
  assert.ok(g.notifications.some((n) => /Red wins/.test(n.text)));
});

test('Tag: dying to a player puts you on their team, dying to a shape does not', () => {
  const g = new Game('tag', 'T');
  assert.equal(g.teams.length, 4);
  assert.equal(g.mode.xp, 3);
  const victim = g.entities.find((e) => e.type === 'tank' && e.bot);
  victim.team = 'blue';
  const killer = mk(g, { type: 'tank', team: 'purple' });
  killer.team = 'purple';
  g.logic.onTankDeath(g, victim, killer);
  assert.equal(victim.nextTeam, 'purple', 'joins the killer');

  const victim2 = g.entities.filter((e) => e.type === 'tank' && e.bot)[1];
  victim2.team = 'blue';
  g.logic.onTankDeath(g, victim2, g.entities.find((e) => e.type === 'shape'));
  assert.equal(victim2.nextTeam, undefined, 'shapes do not reassign you');
});
test('Tag: respawn honours the killer team, and the arena shrinks', () => {
  const g = new Game('tag', 'T');
  const old = g.player;
  old.nextTeam = 'green';
  const fresh = g.respawnPlayer('T', old);
  assert.equal(fresh.team, 'green');

  const w0 = g.arena.size;
  g.nextShrink = 1;
  g.step();
  assert.ok(g.arena.size < w0, `arena shrank ${w0} -> ${g.arena.size}`);
});
test('Tag: invisibility is only partial, so nobody can stall the round', () => {
  const g = new Game('tag', 'T');
  const t = g.player;
  t.level = 45; t.setTank(21); t.recompute();   // Stalker
  t.opacity = 0;
  g.step();
  assert.equal(t.opacity, 0.25, 'clamped to the Tag floor');
});

test('Mothership: one per team, 16 sides, destroying one ends it', () => {
  const g = new Game('mothership', 'T');
  assert.equal(g.motherships.length, 2);
  assert.equal(g.mode.xp, 3);
  assert.equal(g.motherships[0].team, 'blue');
  assert.equal(g.motherships[1].team, 'red');
  assert.equal(g.motherships[0].sides, 16);
  assert.equal(g.motherships[0].maxHealth, 3000);
  assert.equal(g.motherships[0].absorb, 0, 'immovable');
  assert.equal(g.motherships[0].barrels.length, 16);

  g.motherships[0].applyDamage(1e9, null);
  g.step();
  assert.ok(g.notifications.some((n) => /Red wins/.test(n.text)), 'the other team wins');
});

test('Breakout: 8x8 board with each side holding its edge column', () => {
  const g = new Game('breakout', 'T');
  assert.equal(g.tiles.length, 64);
  const blue = g.tiles.filter((t) => t.team === 'blue');
  const red = g.tiles.filter((t) => t.team === 'red');
  const free = g.tiles.filter((t) => t.team === null);
  assert.equal(blue.length, 8); assert.equal(red.length, 8); assert.equal(free.length, 48);
  assert.ok(blue.every((t) => t.col === 0), 'blue holds the west column');
  assert.ok(red.every((t) => t.col === 7), 'red holds the east column');
});
test('Breakout: you can only claim ground touching ground you already hold', () => {
  const g = new Game('breakout', 'T');
  const adjacent = g.tiles.find((t) => t.col === 1 && t.row === 3);
  const distant = g.tiles.find((t) => t.col === 4 && t.row === 3);
  assert.equal(ctx.adjacentToTeam(g, adjacent, 'blue'), true);
  assert.equal(ctx.adjacentToTeam(g, distant, 'blue'), false);

  const t = g.player;
  t.team = 'blue';
  t.x = adjacent.x; t.y = adjacent.y;
  for (let i = 0; i < 100 && adjacent.team === null; i++) { t.x = adjacent.x; t.y = adjacent.y; g.step(); }
  assert.equal(adjacent.team, 'blue', 'claimed after the dwell time');
});
test('Breakout: camping your own tile collapses it and kills you', () => {
  const g = new Game('breakout', 'T');
  const home = g.tiles.find((t) => t.col === 0 && t.row === 4);
  const t = g.player;
  t.team = 'blue'; t.protectedUntil = 0;
  const ticks = (30 + 5) * 25 + 100;
  for (let i = 0; i < ticks && !t.dead; i++) { t.x = home.x; t.y = home.y; g.step(); }
  assert.equal(home.team, null, 'tile reverted to unclaimed');
  assert.equal(t.dead, true, 'the camper died with it');
});

test('CTF: 10 flags a side, a 5-minute barrier, pickup and capture', () => {
  const g = new Game('ctf', 'T');
  assert.equal(g.flags.length, 20);
  assert.equal(g.flags.filter((f) => f.team === 'blue').length, 10);
  assert.ok(g.ctfBarrier, 'barrier present');
  assert.equal(g.barrierUntil, 5 * 60 * 25);

  const flag = g.flags.find((f) => f.team === 'red');
  const thief = g.player;
  thief.team = 'blue';
  thief.x = flag.x; thief.y = flag.y;
  g.step();
  assert.equal(flag.carrier, thief, 'an enemy tank picks it up');

  const home = g.bases.find((b) => b.team === 'blue');
  thief.x = home.x; thief.y = home.y;
  g.step();
  assert.equal(g.captures.blue, 1, 'scored on reaching home');
  assert.equal(flag.carrier, null, 'flag returned');
  near(flag.x, flag.homeX, 0.01, 'back at its post');
});
test('CTF: the barrier drops after five minutes', () => {
  const g = new Game('ctf', 'T');
  g.barrierUntil = g.tick + 1;
  g.step(); g.step();
  assert.equal(g.ctfBarrier, null);
  assert.ok(g.notifications.some((n) => /barrier is down/.test(n.text)));
});

test('possession parks your tank and hands the inputs over', () => {
  const g = new Game('domination', 'T');
  const dom = g.dominators[0];
  const p = g.player;
  p.team = 'blue'; dom.team = 'blue';
  assert.equal(ctx.possess(g, p, dom), true);
  assert.equal(p.parked, true);
  assert.equal(p.sides, 0, 'parked tanks have no collider and are never serialised');
  assert.equal(dom.possessedBy, p);
  assert.equal(ctx.possess(g, g.entities.find((e) => e.type === 'tank' && e.bot), dom), false, 'only one pilot');

  ctx.release(g, p);
  assert.equal(p.parked, false);
  assert.equal(p.sides, TANK_DEFS_SIDES(g, p), 'collider restored');
  assert.equal(dom.possessedBy, null);
});
function TANK_DEFS_SIDES(g, p) { return p.def.sides; }
test('possession is refused across teams and released on death', () => {
  const g = new Game('domination', 'T');
  const dom = g.dominators[1];
  const p = g.player;
  p.team = 'blue'; dom.team = 'red';
  assert.equal(ctx.possess(g, p, dom), false, 'cannot pilot an enemy Dominator');
  dom.team = 'blue';
  ctx.possess(g, p, dom);
  p.protectedUntil = 0;
  p.applyDamage(1e9, null);
  assert.equal(dom.possessedBy, null, 'pilot dying frees the Dominator');
});

test('every objective mode runs 400 ticks without NaN or crashes', () => {
  for (const mode of ['domination', 'tag', 'mothership', 'breakout', 'ctf']) {
    const g = new Game(mode, 'T');
    for (let i = 0; i < 400; i++) g.step();
    assert.ok(g.entities.every((e) => Number.isFinite(e.x) && Number.isFinite(e.y)), mode + ': no NaN positions');
    assert.ok(g.entities.every((e) => Number.isFinite(e.health) || e.health === Infinity), mode + ': no NaN health');
    assert.ok(g.entities.length > 50, mode + ': world populated');
  }
});

test('the death camera locks onto your killer, then stays put when it dies', () => {
  const g = new Game('ffa', 'T');
  const victim = g.player;
  victim.protectedUntil = 0;
  const killer = g.entities.find((e) => e.type === 'tank' && e.bot);
  victim.applyDamage(1e9, killer);
  assert.equal(victim.dead, true);
  assert.equal(g.spectate, killer, 'camera follows the killer');
  assert.equal(victim.killedBy, killer.name);

  killer.kill(null);
  assert.equal(g.spectate.dead, true, 'render stops following once it dies');

  g.respawnPlayer('T', victim);
  assert.equal(g.spectate, null, 'cleared on respawn');
});
test('shapes and orphaned bullets leave no killer to spectate', () => {
  const g = new Game('ffa', 'T');
  const victim = g.player;
  victim.protectedUntil = 0;
  const shape = g.entities.find((e) => e.type === 'shape');
  victim.applyDamage(1e9, shape);
  assert.equal(g.spectate, null, 'a polygon is not a tank to watch');
});

console.log('\nWire format');
test('strings survive the wire intact, and the cap never splits a character', () => {
  const roundTrip = (s) => {
    const w = new ctx.Buf(600);
    w.str(s);
    return new ctx.Buf(w.bytes()).rstr();
  };
  // 33 chars: used to come back as 'Arena closed: No players can joi'
  assert.equal(roundTrip('Arena closed: No players can join'), 'Arena closed: No players can join');
  const boss = 'The Guardian of the Pentagons has been defeated by Somebody!';
  assert.equal(roundTrip(boss), boss);
  assert.equal(roundTrip(''), '');
  // multi-byte characters must not be cut in half at the 255-byte ceiling
  const out = roundTrip('é'.repeat(300));
  assert.ok(out.length > 0 && !/�/.test(out), 'no replacement characters at the boundary');
});

console.log('\nArena closing');
test('closing rings the arena with 14 closers, all facing inward', () => {
  const g = new Game('ffa', 'T');
  const n = g.close();
  assert.equal(n, 14, 'floor(sqrt(22300)/10)');
  const closers = g.entities.filter((e) => e.isCloser);
  assert.equal(closers.length, 14);
  const radius = 22300 * Math.SQRT1_2 + 5000;             // ~20770, outside the field
  for (const c of closers) {
    near(Math.hypot(c.x, c.y), radius, 1, 'on the spawn circle');
    near(Math.cos(c.angle - Math.atan2(-c.y, -c.x)), 1, 1e-9, 'aimed at the centre');
  }
  assert.ok(g.notifications.some((x) => /No players can join/.test(x.text)));
  assert.equal(g.botCount, 0, 'bots stop respawning');
});
test('closers are invincible, fast, and see through invisibility', () => {
  const g = new Game('ffa', 'T');
  g.close();
  const c = g.entities.filter((e) => e.isCloser)[0];
  g.step();
  assert.equal(c.damageReduction, 0, 'invincible');
  c.applyDamage(1e9, null);
  assert.equal(c.dead, false, 'shrugs off a killing blow');
  assert.ok(c.movementSpeed > 5, 'extremely fast');
  assert.equal(c.canMoveThroughWalls, true);
  assert.equal(c.canEscapeArena, true, 'spawns outside the field');

  const stalker = g.player;
  stalker.level = 45; stalker.setTank(21); stalker.recompute();
  stalker.opacity = 0;                                     // fully invisible
  stalker.x = c.x + 200; stalker.y = c.y;
  assert.equal(g.findTarget(c, 1e6, true), stalker, 'a Stalker cannot hide from a closer');
});
test('closers ignore each other', () => {
  const g = new Game('ffa', 'T');
  g.close();
  const [c0, c1] = g.entities.filter((e) => e.isCloser);
  c1.x = c0.x + 100; c1.y = c0.y;
  assert.notEqual(g.findTarget(c0, 1e6, true), c1);
});
test('closers never appear on the scoreboard', () => {
  const g = new Game('ffa', 'T');
  g.close();
  g.updateLeaderboard();
  assert.ok(g.leaderboard.length > 0, 'players still listed');
  assert.ok(g.leaderboard.every((t) => !t.isCloser));
});
test('the arena reports CLOSED once nothing but closers is left', () => {
  const g = new Game('ffa', 'T');
  g.close();
  for (const e of g.entities) if (e.type === 'tank' && !e.isCloser) e.kill(null);
  g.step();
  assert.equal(g.closed, true);
  assert.ok(g.notifications.some((n) => /Arena CLOSED/.test(n.text)));
});
test('closers actually sweep the arena clear', () => {
  const g = new Game('ffa', 'T');
  const before = g.entities.filter((e) => e.type === 'tank' && !e.dead).length;
  g.close();
  let ticks = 0;
  while (!g.closed && ticks < 25 * 150) { g.step(); ticks++; }
  assert.equal(g.closed, true, `swept ${before} tanks in ${(ticks / 25).toFixed(0)}s`);
});

console.log('\nIntegration');
test('600 ticks of FFA with 28 bots stays stable', () => {
  const g = new Game('ffa', 'Me');
  for (let i = 0; i < 600; i++) g.step();
  assert.ok(g.entities.length > 900, 'world populated: ' + g.entities.length);
  assert.ok(g.entities.every(e => Number.isFinite(e.x) && Number.isFinite(e.y)), 'no NaN positions');
  assert.ok(g.entities.every(e => Number.isFinite(e.health)), 'no NaN health');
  assert.ok(g.leaderboard.length > 0, 'leaderboard populated');
  const bots = g.entities.filter(e => e.type === 'tank' && e.bot);
  assert.ok(bots.some(b => b.level > 1), 'bots are farming and levelling');
  assert.ok(g.entities.filter(e => e.type === 'shape').length === 1000, 'shape count held');
});
test('a tank killed by an orphaned bullet is credited to an unnamed tank', () => {
  const g = new Game('ffa', 'Me');
  const shooter = g.entities.filter(e => e.type === 'tank' && e.bot)[0];
  const bullet = g.add(mk(g, { type: 'bullet', damage: 7, maxHealth: 5 }));
  bullet.owner = shooter;
  g.orphan(shooter);
  assert.equal(bullet.owner, null);
  const victim = mk(g, { type: 'tank', damage: 5, maxHealth: 3, minDmg: 1, maxDmg: 6 });
  victim.name = 'Victim';
  victim.onKill = ctx.Tank.prototype.onKill;
  victim.game = g;
  handleCollision(bullet, victim);
  assert.equal(victim.killedBy, 'an unnamed tank');
});

// The command table is browser script too, so it drops into the same context.
vm.runInContext(readFileSync(new URL('js/commands.js', import.meta.url), 'utf8'), ctx, { filename: 'js/commands.js' });
const { runCommand, cheatsOK } = ctx;
const cmdCtx = (g) => {
  const said = [];
  return { game: g, tank: g.player, online: true, name: 'Me', said,
    get sandbox() { return cheatsOK(g); },
    say: (t) => said.push(t), broadcast: (t) => said.push(t) };
};

console.log('\nChat commands');
test('cheats are shut in a normal arena until /cheats on opens it', () => {
  const g = new Game('ffa', 'Me', { botCount: 0 });
  const c = cmdCtx(g);
  runCommand(c, '/god');
  assert.match(c.said.pop(), /is a cheat/);
  assert.ok(!g.player.godMode);
  runCommand(c, '/cheats on');
  runCommand(c, '/god');
  assert.equal(g.player.godMode, true);
  runCommand(c, '/cheats off');
  assert.equal(cheatsOK(g), false);
});
test('a Sandbox is always open and will not be shut', () => {
  const g = new Game('sandbox', 'Me', { botCount: 0 });
  runCommand(cmdCtx(g), '/cheats off');
  assert.equal(cheatsOK(g), true);
});
test('/size grows the barrels with the body, and survives a recompute', () => {
  const g = new Game('sandbox', 'Me', { botCount: 0 });
  const c = cmdCtx(g), t = g.player;
  const size0 = t.size, scale0 = t.scaleFactor;
  runCommand(c, '/size 3');
  assert.equal(t.size, size0 * 3);
  assert.equal(t.scaleFactor, scale0 * 3);      // barrels and fresh bullets read this
  runCommand(c, '/level 20');                   // recompute() rebuilds both from scratch
  assert.ok(Math.abs(t.scaleFactor / Math.pow(1.01, 19) - 3) < 1e-9, 'still x3 after relevelling');
});
test('/firerate divides the reload, /bulletsize multiplies what comes out', () => {
  const g = new Game('sandbox', 'Me', { botCount: 0 });
  const c = cmdCtx(g), t = g.player;
  const reload0 = t.reloadTime;
  runCommand(c, '/firerate 4');
  assert.ok(Math.abs(t.reloadTime - reload0 / 4) < 1e-9);
  runCommand(c, '/maxstats');                   // another recompute
  assert.ok(t.reloadTime < reload0 / 3, 'fire rate outlives a stat change');
  const shot = () => { t.barrels[0].shoot(); return g.entities[g.entities.length - 1].size; };
  const plain = shot();
  runCommand(c, '/bulletsize 5');
  assert.ok(Math.abs(shot() - plain * 5) < 1e-6, 'shots five times the size');
});
test('/botspawn random scatters over the map with a gap between them', () => {
  const g = new Game('ffa', 'Me', { botCount: 0 });
  const c = cmdCtx(g);
  runCommand(c, '/cheats on');
  runCommand(c, '/botspawn 12 random');
  const b = g.entities.filter(e => e.type === 'tank' && e.bot && !e.dead);
  assert.equal(b.length, 12);
  let closest = Infinity;
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++)
    closest = Math.min(closest, Math.hypot(b[i].x - b[j].x, b[i].y - b[j].y));
  const gap = g.arena.size / (2 * Math.sqrt(13));
  assert.ok(closest >= gap * 0.9, 'kept apart: closest pair ' + Math.round(closest) + ' vs gap ' + Math.round(gap));
  const span = Math.max(...b.map(e => e.x)) - Math.min(...b.map(e => e.x));
  assert.ok(span > g.arena.size * 0.5, 'spread wide, not clustered: ' + Math.round(span));
});
test('/botspawn is one-off, /botrespawn decides whether they come back', () => {
  const g = new Game('ffa', 'Me', { botCount: 0 });
  const c = cmdCtx(g);
  const bots = () => g.entities.filter(e => e.type === 'tank' && e.bot && !e.dead).length;
  runCommand(c, '/cheats on');
  runCommand(c, '/botspawn 6');
  assert.equal(bots(), 6);
  runCommand(c, '/botrespawn on');
  assert.equal(g.botCount, 6);
  assert.equal(g.botOverride, 6);                     // the server re-reads this every tick
  g.entities.filter(e => e.type === 'tank' && e.bot).slice(0, 3).forEach(e => e.kill(null));
  for (let i = 0; i < 150; i++) g.step();
  assert.ok(bots() >= 5, 'topped back up towards 6, got ' + bots());
  runCommand(c, '/botrespawn off');
  const left = bots();
  g.entities.filter(e => e.type === 'tank' && e.bot && !e.dead).slice(0, 2).forEach(e => e.kill(null));
  for (let i = 0; i < 150; i++) g.step();
  assert.ok(bots() <= left - 2, 'no replacements, got ' + bots());
});

console.log(`\n${passed} passed\n`);
