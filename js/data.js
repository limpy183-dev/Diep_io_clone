// data.js — constants, palette, curves, shape/addon/boss tables.
// Every formula here is quoted from the build spec; [code] values come from the
// reference server, [measured] from community measurement.

var TPS = 25;
var MSPT = 40;
var GRID = 50;                 // background grid cell, diep units
var ARENA_PADDING = 200;       // walkable grey margin outside the play field
var MAX_LEVEL = 45;
// A mode may raise its own ceiling with the `maxLevel` rule (Juggernaut Royale
// runs to 200). LEVEL_SCORE is built this far so the curve is there when it does.
var LEVEL_CAP = 200;
// diep's per-level cost compounds at 6%, which is fine to 45 and merely steep to
// 100. Run it to 200 and level 199 alone costs four hundred times level 100 —
// the ladder stops being a climb and becomes a wall. So the compounding stops
// here and the cost goes flat: past this level every rung costs the same as this
// one, which lands the whole 1..200 climb at 6.7x the 1..100 climb rather than
// 400x. Nothing under level 100 moves by a single point.
var LEVEL_SOFT = 100;
var SPAWN_PROTECT_TICKS = 374; // ~15s
var HYPER_REGEN_DELAY = 750;   // 30s undamaged
var HASH_CELL = 128;           // 2^7
var DRONE_HUNT_RANGE = 1700;   // Auto Fire leash for drones/minions (idle guard radius is 900)
var BOSS_INTERVAL = 45 * 60 * TPS;
var SHINY_CHANCE = 1 / 1000000;
var NEST_SHARE = 0.015;        // share of the shape quota reserved for the Pentagon Nest
var NEST_REFILL_TICKS = 75;    // one nest shape every 3s, so a farmed mid stays farmed a while
var ROOT2 = Math.SQRT2;

// --- palette -----------------------------------------------------------
// fill/stroke pairs read from the real client.
var C = {
  border:   '#555555', borderS: '#404040',   // guard hulls and the Dominator plinth
  barrel:   '#999999', barrelS: '#727272',
  blue:     '#00B2E1', blueS:   '#0085A8',
  red:      '#F14E54', redS:    '#B43A3F',
  green:    '#00E16E', greenS:  '#00A852',
  purple:   '#BF7FF5', purpleS: '#8F5FB7',
  shiny:    '#8AFF69', shinyS:  '#68BF4E',
  square:   '#FFE869', squareS: '#BFAE4E',
  triangle: '#FC7677', triangleS:'#BD5859',
  pentagon: '#768DFC', pentagonS:'#5869BD',
  crasher:  '#F177DD', crasherS:'#B459A5',
  neutral:  '#FFE869', neutralS:'#BFAE4E',
  necro:    '#FCC376', necroS:  '#BD9259',
  fallen:   '#C0C0C0', fallenS: '#909090',
  box:      '#BBBBBB', boxS:    '#8C8C8C',
  gridFill: '#CDCDCD',
  scoreBar: '#85E8A0',
  levelBar: '#FFDE43',
  healthBar:'#85E37D'
};

var TEAM_COLORS = {
  blue:   [C.blue, C.blueS],
  red:    [C.red, C.redS],
  green:  [C.green, C.greenS],
  purple: [C.purple, C.purpleS]
};

// stat bar colours, indexed in UI order (top to bottom): Health Regen, Max
// Health, Body Damage, Bullet Speed, Bullet Penetration, Bullet Damage, Reload,
// Movement Speed. Read off the real client (DIEP_CONSTANTS.md 3.1).
var STAT_COLORS = ['#FCAD76', '#F943FF', '#8543FF', '#437FFF', '#FFDE43', '#FF4343', '#82FF43', '#43FFF9'];
// upgrade card colour cycle
var CARD_COLORS = ['#00B2E1', '#00E16E', '#F14E54', '#FFDE43', '#4F42B5', '#BF7FF5', '#F177DD', '#C0C0C0'];

// Wire stat order (what tank defs use): 0 MoveSpeed 1 Reload 2 BulletDmg
// 3 BulletPen 4 BulletSpeed 5 BodyDmg 6 MaxHealth 7 HealthRegen.
// UI order is exactly that reversed, so uiIndex -> wireIndex is 7 - i.
var S_SPEED = 0, S_RELOAD = 1, S_DAMAGE = 2, S_PEN = 3, S_BSPEED = 4, S_BODY = 5, S_HEALTH = 6, S_REGEN = 7;
function uiToWire(i) { return 7 - i; }

// --- progression -------------------------------------------------------
// scoreAtLevel[i] = scoreAtLevel[i-1] + (40/9) * 1.06^(i-2) * min(31, i-1)
var LEVEL_SCORE = (function () {
  var t = [0, 0];
  for (var i = 2; i <= LEVEL_CAP + 1; i++)
    t[i] = t[i - 1] + (40 / 9) * Math.pow(1.06, Math.min(i, LEVEL_SOFT) - 2) * Math.min(31, i - 1);
  return t;
})();

function levelFromScore(score, cap) {
  var top = cap || MAX_LEVEL;
  var lvl = 1;
  while (lvl < top && score >= LEVEL_SCORE[lvl + 1]) lvl++;
  return lvl;
}
function statCount(level) {
  if (level <= 0) return 0;
  if (level <= 28) return level - 1;
  return Math.floor(level / 3) + 18;
}
function respawnLevel(level) {
  return Math.min(Math.max(level - 1, 1), Math.floor(Math.sqrt(level) * 3.2796));
}

// --- deep stat bars ----------------------------------------------------
// A stat pill is seven pips wide and that is not negotiable — it is a 210px
// strip in the bottom-left corner and there are eight of them. A mode that runs
// to level 200 hands out 84 points, which is more than the 56 that eight
// seven-pip bars can hold, so the bar has to take more without getting longer.
//
// It compresses. Fill all seven pips and they collapse into ONE lit block on
// the left; the row is seven pips wide again, but only six of them are empty.
// Fill those six and they collapse into a second block, leaving five. And so
// on: 7 + 6 + 5 + 4 + 3 + 2 + 1 = 28 points, at which point all seven pips are
// compressed blocks, there is no room left in the row, and the stat is maxed —
// the bar says so because it physically cannot say anything else.
//
// 28 * 3 = 84, which is exactly the level-200 budget: a full build at the cap is
// three stats taken all the way and nothing else, so the last hundred levels of
// the ladder are a real decision rather than a formality.
var STAT_SLOTS = 7;                              // pips in a row, always
var STAT_BANDS = (function () {                  // points at which a rank closes
  var t = [0];
  for (var i = 0; i < STAT_SLOTS; i++) t.push(t[i] + (STAT_SLOTS - i));
  return t;                                      // [0,7,13,18,22,25,27,28]
})();
var STAT_DEEP_MAX = STAT_BANDS[STAT_SLOTS];      // 28

// How the pill draws `cur` points: `full` compressed blocks on the left, then
// `into` lit pips out of `slots` empty ones. A classic bar returns full 0 and
// the pip count it always had, so nothing outside Juggernaut Royale changes.
function statBar(cur, max) {
  if (max <= STAT_SLOTS) return { full: 0, into: Math.min(cur, max), slots: max, rank: 1 };
  var full = 0;
  while (full < STAT_SLOTS && cur >= STAT_BANDS[full + 1]) full++;
  return { full: full, into: cur - STAT_BANDS[full], slots: STAT_SLOTS - full, rank: full + 1 };
}

// --- shapes ------------------------------------------------------------
// `size` is the COLLISION radius; the client draws polygons at size * sqrt(2),
// which is why the drawn radii come out as the round numbers players measure.
var SHAPES = {
  square:   { health: 10,   size: 55 * Math.SQRT1_2,  sides: 4, damage: 2, score: 10,   fill: C.square,   stroke: C.squareS,   absorb: 1,    push: 8 },
  triangle: { health: 30,   size: 55 * Math.SQRT1_2,  sides: 3, damage: 2, score: 25,   fill: C.triangle, stroke: C.triangleS, absorb: 1,    push: 8 },
  pentagon: { health: 100,  size: 75 * Math.SQRT1_2,  sides: 5, damage: 3, score: 130,  fill: C.pentagon, stroke: C.pentagonS, absorb: 0.5,  push: 11 },
  alpha:    { health: 3000, size: 200 * Math.SQRT1_2, sides: 5, damage: 5, score: 3000, fill: C.pentagon, stroke: C.pentagonS, absorb: 0.05, push: 11 },
  // Hexagon geometry was never published; 1500 HP / 1500 XP is confirmed.
  hexagon:  { health: 1500, size: 130 * Math.SQRT1_2, sides: 6, damage: 4, score: 1500, fill: C.pentagon, stroke: C.pentagonS, absorb: 0.2,  push: 11 }, // TODO: unverified size/damage
  crasherS: { health: 10,   size: 35 * Math.SQRT1_2,  sides: 3, damage: 2, score: 15,   fill: C.crasher,  stroke: C.crasherS,  absorb: 2,    push: 8,  speed: 26 },
  crasherL: { health: 30,   size: 55 * Math.SQRT1_2,  sides: 3, damage: 2, score: 25,   fill: C.crasher,  stroke: C.crasherS,  absorb: 0.1,  push: 12, speed: 26.4 }
};
// bullet-speed stat gain per point. diep's value: terminal speed = (20 + 3P) * M du/t.
var BSPEED_GAIN = 3;
// Share of a tank's score that goes to whoever killed it. The share is the one
// figure in here with no published source behind it, so it is a knob rather than
// a constant: under 1 so a kill is a reward and not a transfer, and so score
// leaves the arena on every death instead of pooling in one runaway leader.
var KILL_SCORE_SHARE = 0.25;   // TODO: unverified, tune to taste
// Share of max health a bot keeps back to fight with rather than spend on the
// farm. Measured: every bot that died on a shape was already under half health,
// so the thing being protected is the ability to walk away from one.
var FARM_HP_RESERVE = 0.5;
// Below this a bot with nobody on it stops playing and goes to heal. Set under
// the farm reserve: half health is "stop shouldering shapes", this is "leave".
var REGEN_HP_WAIT = 0.35;
var SHAPE_ROTATION = 0.01, SHAPE_ORBIT = 0.005, SHAPE_VELOCITY = 1, TURN_TIMEOUT = 300;

// --- addons ------------------------------------------------------------
// Guard shells: size ratios multiply the tank's current radius, so they scale free.
var ADDONS = {
  dombase:      { guards: [{ sides: 6, ratio: 1.24, spin: 0 }] },
  smasher:      { guards: [{ sides: 6, ratio: 1.15, spin: 0.10 }] },
  landmine:     { guards: [{ sides: 6, ratio: 1.15, spin: 0.10 }, { sides: 6, ratio: 1.15, spin: 0.05 }] },
  spike:        { guards: [{ sides: 3, ratio: 1.3, spin: 0.17, offset: 0 },
                           { sides: 3, ratio: 1.3, spin: 0.17, offset: Math.PI / 3 },
                           { sides: 3, ratio: 1.3, spin: 0.17, offset: Math.PI / 6 },
                           { sides: 3, ratio: 1.3, spin: 0.17, offset: Math.PI / 2 }] },
  autosmasher: { guards: [{ sides: 6, ratio: 1.15, spin: 0.10 }], turrets: 1 },
  // Mega Smasher: the wiki puts its hull at 1.13x a Smasher's, so 1.15 * 1.13.
  megasmasher: { guards: [{ sides: 6, ratio: 1.3, spin: 0.10 }] },
  autoturret:  { turrets: 1 },
  auto3:       { turrets: 3, arc: true },
  auto5:       { turrets: 5, arc: true },
  auto7:       { turrets: 7, arc: true },
  auto9:       { turrets: 9, arc: true },
  // The "pronounced" collar sits over the FRONT of the barrel, widening back
  // toward the body — it is what tells a Ranger from a Stalker. diep parks it at
  // offsetRatio * size with a half-length of sizeRatio * size and a half-width of
  // widthRatio * size, all off the body radius, so both figures below are
  // (offset + size) and 2 * width in body radii.
  pronounced:  { nub: { lengthRatio: 40 / 50 + 50 / 50, widthRatio: 2 * 42 / 50 } },
  dompronounced:{ nub: { lengthRatio: 50 / 50 + 22 / 50, widthRatio: 2 * 35 / 50 } },
  launcher:    { hood: { lengthRatio: 1.31, widthRatio: 0.672 } },

  // Juggernaut Royale's shells. Guards are drawn beneath the body in the border
  // grey, so a branch is legible from its outline alone before any colour or
  // aura reaches you: thorns, a halo, a reactor core, tusks, gears, ice shards,
  // armour plates, a siege frame, fangs, a veil, and the apex crown.
  jrcrown:     { guards: [{ sides: 3, ratio: 1.36, spin: 0.13, offset: 0 },
                          { sides: 3, ratio: 1.36, spin: 0.13, offset: Math.PI / 3 },
                          { sides: 3, ratio: 1.30, spin: 0.13, offset: Math.PI / 6 }] },
  jrhalo:      { guards: [{ sides: 12, ratio: 1.24, spin: -0.05 },
                          { sides: 12, ratio: 1.10, spin: 0.09 }] },
  jrcore:      { guards: [{ sides: 4, ratio: 1.22, spin: 0.18 },
                          { sides: 4, ratio: 1.22, spin: -0.18, offset: Math.PI / 4 }] },
  jrtusks:     { guards: [{ sides: 3, ratio: 1.44, spin: 0.04 }] },
  jrgear:      { guards: [{ sides: 8, ratio: 1.22, spin: 0.10 },
                          { sides: 8, ratio: 1.22, spin: -0.10, offset: Math.PI / 8 },
                          { sides: 8, ratio: 1.08, spin: 0.16 }] },
  jrshard:     { guards: [{ sides: 6, ratio: 1.30, spin: 0.03 },
                          { sides: 6, ratio: 1.14, spin: -0.06, offset: Math.PI / 6 },
                          { sides: 3, ratio: 1.38, spin: 0.02, offset: Math.PI / 2 }] },
  jrplates:    { guards: [{ sides: 5, ratio: 1.22, spin: 0.06 },
                          { sides: 5, ratio: 1.22, spin: 0.06, offset: Math.PI / 5 }] },
  jrframe:     { guards: [{ sides: 4, ratio: 1.32, spin: 0 },
                          { sides: 4, ratio: 1.16, spin: 0, offset: Math.PI / 4 }] },
  jrfangs:     { guards: [{ sides: 3, ratio: 1.28, spin: 0.24 },
                          { sides: 3, ratio: 1.28, spin: -0.24, offset: Math.PI / 3 }] },
  jrveil:      { guards: [{ sides: 12, ratio: 1.32, spin: 0.02 }] },
  jrmega:      { guards: [{ sides: 10, ratio: 1.30, spin: 0.07 },
                          { sides: 5, ratio: 1.48, spin: -0.04 },
                          { sides: 5, ratio: 1.48, spin: -0.04, offset: Math.PI / 5 }] },
  jrplinth:    { guards: [{ sides: 8, ratio: 1.38, spin: 0 }] },
  // The two tiers above fusion. An apex wears a double crown of blades; an omega
  // wears three counter-turning rings on top of it, and is meant to be legible
  // as "that is not a hull you are allowed to fight" from a screen away.
  jrapex:      { guards: [{ sides: 3, ratio: 1.52, spin: 0.09, offset: 0 },
                          { sides: 3, ratio: 1.52, spin: 0.09, offset: Math.PI / 3 },
                          { sides: 6, ratio: 1.30, spin: -0.12 },
                          { sides: 6, ratio: 1.14, spin: 0.16, offset: Math.PI / 6 }] },
  jromega:     { guards: [{ sides: 3, ratio: 1.66, spin: 0.05, offset: 0 },
                          { sides: 3, ratio: 1.66, spin: 0.05, offset: Math.PI / 3 },
                          { sides: 12, ratio: 1.40, spin: -0.08 },
                          { sides: 12, ratio: 1.24, spin: 0.14 },
                          { sides: 6, ratio: 1.10, spin: -0.20 }] },
  // ...and the two above those. A titan wears a six-bladed sunburst over the
  // omega's rings; a crown wears the lot plus a solid outer wheel, so the
  // silhouette alone says how much of the round the pilot spent on it.
  jrtitan:     { guards: [{ sides: 3, ratio: 1.80, spin: 0.04, offset: 0 },
                          { sides: 3, ratio: 1.80, spin: 0.04, offset: Math.PI / 3 },
                          { sides: 3, ratio: 1.62, spin: -0.07, offset: Math.PI / 6 },
                          { sides: 3, ratio: 1.62, spin: -0.07, offset: Math.PI / 2 },
                          { sides: 12, ratio: 1.36, spin: 0.11 },
                          { sides: 6, ratio: 1.16, spin: -0.18 }] },
  jrgod:       { guards: [{ sides: 3, ratio: 1.96, spin: 0.03, offset: 0 },
                          { sides: 3, ratio: 1.96, spin: 0.03, offset: Math.PI / 3 },
                          { sides: 3, ratio: 1.74, spin: -0.05, offset: Math.PI / 6 },
                          { sides: 3, ratio: 1.74, spin: -0.05, offset: Math.PI / 2 },
                          { sides: 24, ratio: 1.48, spin: 0.06 },
                          { sides: 12, ratio: 1.30, spin: -0.12 },
                          { sides: 6, ratio: 1.12, spin: 0.22 }] },
  auto12:      { turrets: 12, arc: true }
};
// A mounted turret is a fixed 25-radius base carrying a 55 x 29.4 barrel, grown
// only by the tank's LEVEL scale — diep sizes it off scaleFactor, never off the
// body. barrelLen/barrelWidth/base are those figures over the 50 of a stock
// tank, so a level-1 Auto Gunner is unchanged either way; only a class whose
// body is not 50 (the bosses, the Mothership) tells the two apart. dist is the
// odd one out and really is a fraction of the body: diep rings auto3/auto5 at
// 0.8 * size.
var TURRET = { barrelLen: 1.1, barrelWidth: 0.588, base: 0.5, dist: 0.8 };
var TURRET_BARREL = {
  angle: 0, offset: 0, size: 55, width: 29.4, delay: 0.01, reload: 1, recoil: 0.3,
  isTrapezoid: false, trapezoidDirection: 0, addon: null,
  // scatterRate 1 is diep's. interceptAim still solves exactly; the spread is applied on
  // top of the solution, which is also what diep's turrets do.
  bullet: { type: 'bullet', sizeRatio: 1, health: 1, damage: 0.3, speed: 1.2, scatterRate: 1, lifeLength: 1, absorbtionFactor: 1 }
};
var PASSIVE_ROTATION = 0.01;

// A turret carries one barrel unless its addon lists more. The Decade's mounted
// turret is the only thing in the game that does: a Triple Shot on a swivel.
ADDONS.tripleturret = {
  turrets: 1,
  turretBarrels: [-1, 0, 1].map(function (i) {
    var b = {};
    for (var k in TURRET_BARREL) b[k] = TURRET_BARREL[k];
    b.angle = i * (Math.PI / 4);           // Triple Shot's own +/-45 degree fan
    return b;
  })
};

// --- missiles ----------------------------------------------------------
// diep's Skimmer/Rocket are plain Bullets that happen to carry barrels, so their
// life is the ordinary 75 * lifeLength off the firing barrel (Skimmer 1.3 -> 97.5t,
// Rocketeer 1 -> 75t). Only the Glider, which diep has no equivalent of, is listed.
var MISSILE_LIFE = { glider: 5 * TPS };

// Barrels carried BY a projectile. Rendered in the team colour, unlike normal barrels.
var MISSILE_BARRELS = {
  // diep SkimmerBarrelDefinition, twice, second rotated by PI.
  skimmer: [
    { angle: 0, offset: 0, size: 70, width: 42, delay: 0, reload: 0.35, recoil: 0, isTrapezoid: false, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 0.3, damage: 3 / 5, speed: 1.1, scatterRate: 1, lifeLength: 0.25, absorbtionFactor: 1 } },
    { angle: Math.PI, offset: 0, size: 70, width: 42, delay: 0, reload: 0.35, recoil: 0, isTrapezoid: false, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 0.3, damage: 3 / 5, speed: 1.1, scatterRate: 1, lifeLength: 0.25, absorbtionFactor: 1 } }
  ],
  // diep RocketBarrelDefinition. recoil 3.3 at reload 0.15 is the whole engine.
  rocket: [
    { angle: Math.PI, offset: 0, size: 70, width: 36, delay: 0, reload: 0.15, recoil: 3.3, isTrapezoid: true, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 0.3, damage: 3 / 5, speed: 1.5, scatterRate: 5, lifeLength: 0.1, absorbtionFactor: 1 } }
  ],
  // Glider: two rear barrels 35 degrees apart (so +/- 17.5 from straight back).
  glider: [
    { angle: Math.PI - 0.3054, offset: 0, size: 65, width: 42, delay: 0, reload: 0.6, recoil: 2, isTrapezoid: true, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 0.4, damage: 0.5, speed: 1, scatterRate: 2, lifeLength: 0.5, absorbtionFactor: 1 } },
    { angle: Math.PI + 0.3054, offset: 0, size: 65, width: 42, delay: 0, reload: 0.6, recoil: 2, isTrapezoid: true, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 0.4, damage: 0.5, speed: 1, scatterRate: 2, lifeLength: 0.5, absorbtionFactor: 1 } }
  ]
};

// --- Firework ----------------------------------------------------------
// The main shell is a hexagon that bursts into 16 shards, either on right-click
// or when its life runs out. The shards are ordinary barrels on the shell, so
// the burst reuses the normal firing path instead of a bespoke spawner.
var FIREWORK = { shards: 16, life: 2.4 * TPS };
var FIREWORK_BARRELS = (function () {
  var out = [];
  for (var i = 0; i < 16; i++) {
    out.push({
      angle: (i / 16) * Math.PI * 2, offset: 0, size: 40, width: 30, delay: 0,
      reload: 1, recoil: 0, isTrapezoid: false, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 0.5, damage: 0.35, speed: 0.9, scatterRate: 1, lifeLength: 0.7, absorbtionFactor: 1 }
    });
  }
  return out;
})();

// --- bosses ------------------------------------------------------------
// Appendix C.3. Shared: 3000 HP, 40 effective body damage, 30000 XP.
var BOSSES = [
  {
    name: 'Guardian of the Pentagons', sides: 3, size: 135, fill: C.crasher, stroke: C.crasherS,
    barrelScale: 1, speed: 0.9, spin: false, faceVelocity: true,
    barrels: [{ angle: Math.PI, offset: 0, size: 100, width: 71.4, delay: 0, reload: 0.36, recoil: 1, isTrapezoid: true, trapezoidDirection: 0, addon: null, droneCount: 24, canControlDrones: true,
      bullet: { type: 'drone', sizeRatio: 21 / (71.4 / 2), health: 12.5, damage: 0.56, speed: 1.7, scatterRate: 1, lifeLength: 1.5, absorbtionFactor: 1 } }]
  },
  {
    name: 'Summoner', sides: 4, size: 150, fill: C.square, stroke: C.squareS, speed: 0.6, spin: true, barrelScale: 1,
    barrels: [0, 1, 2, 3].map(function (i) {
      return { angle: 2 * Math.PI * (i / 4), offset: 0, size: 135, width: 71.4, delay: 0, reload: 0.36, recoil: 1, isTrapezoid: true, trapezoidDirection: 0, addon: null, droneCount: 7, canControlDrones: true,
        bullet: { type: 'drone', sizeRatio: (55 * Math.SQRT1_2) / (71.4 / 2), health: 12.5, damage: 0.56, speed: 1.7, scatterRate: 1, lifeLength: -1, absorbtionFactor: 1, color: C.necro, stroke: C.necroS, sides: 4 } };
    })
  },
  // Defender (§8): a triangle with a trap launcher out of each CORNER and an
  // auto-turret on each face between them. Two things had it drawing as a
  // six-spoke star rather than a triangle: the barrels sat on the faces (the
  // +1/6 offset) where the turrets belong, and at scaleFactor size/50 = 2.12 a
  // `size: 120` barrel rendered 254 units long against a 150-unit body. The
  // launchers are now the real Trapper's proportions against their own body —
  // a Trapper is size 60 / width 42 on a 50-radius hull, so 1.2x and 0.84x.
  {
    name: 'Defender', sides: 3, size: 150, fill: C.triangle, stroke: C.triangleS, speed: 0.2,
    spin: true, viewRange: 0, turrets: 3, turretOffset: Math.PI / 3, barrelScale: 1.7,
    barrels: [0, 1, 2].map(function (i) {
      return { angle: 2 * Math.PI * (i / 3), offset: 0, size: 62, width: 50, delay: 0, reload: 5, recoil: 2, isTrapezoid: false, trapezoidDirection: 0, addon: 'trapLauncher', forceFire: true,
        bullet: { type: 'trap', sizeRatio: 0.8, health: 12.5, damage: 4, speed: 5, scatterRate: 1, lifeLength: 8, absorbtionFactor: 1, color: C.neutral, stroke: C.neutralS } };
    })
  },
  { name: 'Fallen Overlord', sides: 1, size: 130, fill: C.fallen, stroke: C.fallenS, speed: 0.7, tankId: 12, droneOverride: 3 },
  { name: 'Fallen Booster', sides: 1, size: 120, fill: C.fallen, stroke: C.fallenS, speed: 2.2, tankId: 23 }
];
var BOSS_HEALTH = 3000, BOSS_DAMAGE = 10, BOSS_SCORE = 30000; // 10 * maxMult(4 vs shape / 6 vs tank) -> 40/60

// The barrels a boss actually carries. The two Fallen bosses are a host class
// up-gunned and repainted; the rest carry their own. One function so the AI boss
// and the /class version of it can never drift apart — both call this.
function bossBarrels(spec) {
  var fromTank = spec.tankId !== undefined;
  var defs = fromTank ? TANK_DEFS[spec.tankId].barrels : spec.barrels;
  return defs.map(function (b) {
    var copy = JSON.parse(JSON.stringify(b));
    if (fromTank) {
      copy.bullet.color = C.fallen; copy.bullet.stroke = C.fallenS;
      if (spec.droneOverride && copy.droneCount) copy.droneCount = spec.droneOverride;
      copy.bullet.health *= 3; copy.bullet.damage *= 1.5;
    }
    return copy;
  });
}

// Base drones: 2000 HP each, reload 0 (spawn as fast as the engine allows).
var BASE_DRONE_BARREL = {
  angle: 0, offset: 0, size: 95, width: 42, delay: 0, reload: 0.2, recoil: 0,
  isTrapezoid: true, trapezoidDirection: 0, addon: null, droneCount: 12, canControlDrones: false,
  bullet: { type: 'drone', sizeRatio: 1, health: 1000, damage: 1, speed: 2.7, scatterRate: 1, lifeLength: -1, absorbtionFactor: 1 }
};

// Maze: 40 x 40 cells of 635 du, so the arena is 25400 across (§1). The rest is
// the real generator's own tuning (§9) — see Game.generateMaze.
var MAZE = { cells: 40, cell: 635, seedBlock: 5, branchCap: 2, turnChance: 0.2, branchChance: 0.2, terminationChance: 0.2 };

var GAMEMODES = {
  ffa:        { name: 'FFA',              teams: null,                               size: 22300, xp: 1, bases: false },
  survival:   { name: 'Survival',         teams: null,                               size: 22300, xp: 3, bases: false, logic: 'survival', noBoss: true, freshStart: true },
  team2:      { name: '2 Teams',          teams: ['blue', 'red'],                    size: 22300, xp: 1, bases: true },
  team4:      { name: '4 Teams',          teams: ['blue', 'green', 'purple', 'red'], size: 22300, xp: 1, bases: true },
  maze:       { name: 'Maze',             teams: null,                               size: MAZE.cells * MAZE.cell, xp: 1, bases: false, maze: true, noBoss: true },
  domination: { name: 'Domination',       teams: ['blue', 'red'],                    size: 22300, xp: 2, bases: true,  logic: 'domination' },
  tag:        { name: 'Tag',              teams: ['blue', 'green', 'purple', 'red'], size: 22300, xp: 3, bases: false, logic: 'tag', noBoss: true },
  mothership: { name: 'Mothership',       teams: ['blue', 'red'],                    size: 22300, xp: 3, bases: false, logic: 'mothership' },
  breakout:   { name: 'Breakout',         teams: ['blue', 'red'],                    size: 22300, xp: 2, bases: false, logic: 'breakout', noBoss: true },
  ctf:        { name: 'Capture the Flag', teams: ['blue', 'red'],                    size: 22300, xp: 1, bases: true,  logic: 'ctf', noBoss: true },
  sandbox:    { name: 'Sandbox',          teams: null,                               size: 6000,  xp: 1, bases: false, sandbox: true }
};

// --- mode entities -----------------------------------------------------
var DOMINATOR = {
  ids: [45, 46, 47],           // Destroyer / Gunner / Trapper flavours
  level: 75,
  size: 160,
  damage: 10,                  // 60 vs tanks, 40 vs shapes
  spots: [[-2500, -2500], [2500, -2500], [-2500, 2500], [2500, 2500]],
  captureMsg: 7.5 * TPS
};

// Predator's right-click pushes the camera this far along the barrel. The bots
// read it too, so it lives here rather than inline in the renderer.
var PREDATOR_ZOOM = 1500;

var MOTHERSHIP = {
  id: 27,
  level: 140,
  maxHealth: 7000,             // §9. absorbtionFactor (0.01) and pushFactor (8) come off the def.
  pilotRotation: 5 * 60 * TPS  // pilots rotate every 5 minutes
};

var BREAKOUT = {
  cols: 8, rows: 8,
  claimTicks: 3 * TPS,         // dwell needed to take an adjacent unclaimed tile
  campWarnTicks: 30 * TPS,     // camping your own tile this long triggers the warning
  campCollapseTicks: 5 * TPS   // ...then it collapses, killing whoever is inside
};

var CTF = {
  perSide: 10,                 // flags each team defends, and captures needed to win
  barrierTicks: 5 * 60 * TPS,  // the map is split for the first five minutes
  flagSize: 45,
  flagStandoff: 400            // how far clear of the base the flag line stands
};

var TAG = {
  shrinkInterval: 12.5 * TPS,  // arena loses ~2 units per side on this cadence
  shrinkAmount: 2,
  minOpacity: 0.25             // invisibility is only partial, so nobody can stall forever
};

// Survival: one life each, and the field is sized to whoever is still standing
// (§1 arena, §5 shape quota). Both shrink on their own as the round thins out.
var SURVIVAL = {
  countdown: 10 * TPS,         // §1 countdown before the round starts
  shrinkRate: 20,              // du/tick the field closes in by, 500 du/s
  cullRate: 8                  // shapes swept per tick once the quota drops
};
function survivalArena(players) { return Math.floor(25 * Math.sqrt(Math.max(1, players))) * 100; }
function survivalShapes(width) { return Math.floor(12.5 * Math.ceil(Math.pow(width / 2500, 2))); }

var ROUND_END_DELAY = 12 * TPS;

if (typeof module !== 'undefined') module.exports = {
  TPS: TPS, MSPT: MSPT, GRID: GRID, C: C, SHAPES: SHAPES, ADDONS: ADDONS, BOSSES: BOSSES,
  LEVEL_SCORE: LEVEL_SCORE, levelFromScore: levelFromScore, statCount: statCount,
  respawnLevel: respawnLevel, uiToWire: uiToWire, GAMEMODES: GAMEMODES, MAX_LEVEL: MAX_LEVEL,
  LEVEL_CAP: LEVEL_CAP, LEVEL_SOFT: LEVEL_SOFT,
  STAT_SLOTS: STAT_SLOTS, STAT_BANDS: STAT_BANDS, STAT_DEEP_MAX: STAT_DEEP_MAX,
  statBar: statBar
};
