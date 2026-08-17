// data.js — constants, palette, curves, shape/addon/boss tables.
// Every formula here is quoted from the build spec; [code] values come from the
// reference server, [measured] from community measurement.

var TPS = 25;
var MSPT = 40;
var GRID = 50;                 // background grid cell, diep units
var ARENA_PADDING = 200;       // walkable grey margin outside the play field
var MAX_LEVEL = 45;
var SPAWN_PROTECT_TICKS = 374; // ~15s
var HYPER_REGEN_DELAY = 750;   // 30s undamaged
var HASH_CELL = 128;           // 2^7
var BOSS_INTERVAL = 45 * 60 * TPS;
var SHINY_CHANCE = 1 / 1000000;
var ROOT2 = Math.SQRT2;

// --- palette -----------------------------------------------------------
// fill/stroke pairs read from the real client.
var C = {
  border:   '#555555',
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

// stat bar colours, indexed in UI order (top to bottom)
var STAT_COLORS = ['#E8B478', '#E070E0', '#A878E8', '#6EA8E8', '#E8D878', '#E87878', '#8AE878', '#78E8E0'];
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
  for (var i = 2; i <= MAX_LEVEL + 1; i++) t[i] = t[i - 1] + (40 / 9) * Math.pow(1.06, i - 2) * Math.min(31, i - 1);
  return t;
})();

function levelFromScore(score) {
  var lvl = 1;
  while (lvl < MAX_LEVEL && score >= LEVEL_SCORE[lvl + 1]) lvl++;
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
  crasherS: { health: 10,   size: 35 * Math.SQRT1_2,  sides: 3, damage: 2, score: 15,   fill: C.crasher,  stroke: C.crasherS,  absorb: 2,    push: 8,  speed: 5.2 },
  crasherL: { health: 30,   size: 55 * Math.SQRT1_2,  sides: 3, damage: 2, score: 25,   fill: C.crasher,  stroke: C.crasherS,  absorb: 0.1,  push: 12, speed: 5.28 }
};
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
  autoturret:  { turrets: 1 },
  auto3:       { turrets: 3, arc: true },
  auto5:       { turrets: 5, arc: true },
  pronounced:  { nub: { angle: Math.PI, size: 55, width: 42, dir: Math.PI } },
  dompronounced:{ nub: { angle: Math.PI, size: 60, width: 50, dir: Math.PI } },
  launcher:    { hood: { lengthRatio: 1.31, widthRatio: 0.672 } }
};
var TURRET = { barrelLen: 1.1, barrelWidth: 0.588, base: 0.5, dist: 0.8 };
var TURRET_BARREL = {
  angle: 0, offset: 0, size: 55, width: 29.4, delay: 0.01, reload: 1, recoil: 0.3,
  isTrapezoid: false, trapezoidDirection: 0, addon: null,
  bullet: { type: 'bullet', sizeRatio: 1, health: 1, damage: 0.3, speed: 1.2, scatterRate: 1, lifeLength: 1, absorbtionFactor: 1 }
};
var PASSIVE_ROTATION = 0.01;

// --- missiles ----------------------------------------------------------
// Measured flight times. These are absolute, not derived from lifeLength: the
// projectile's own lifeLength drives its barrels, not how long the missile lives.
var MISSILE_LIFE = { skimmer: 5 * TPS, rocket: 4 * TPS, glider: 5 * TPS };

// Barrels carried BY a projectile. Rendered in the team colour, unlike normal barrels.
var MISSILE_BARRELS = {
  skimmer: [
    { angle: Math.PI / 2, offset: 0, size: 70, width: 42, delay: 0, reload: 0.5, recoil: 0, isTrapezoid: false, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 0.3, damage: 0.5, speed: 1.5, scatterRate: 1, lifeLength: 0.75, absorbtionFactor: 1 } },
    { angle: -Math.PI / 2, offset: 0, size: 70, width: 42, delay: 0, reload: 0.5, recoil: 0, isTrapezoid: false, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 0.3, damage: 0.5, speed: 1.5, scatterRate: 1, lifeLength: 0.75, absorbtionFactor: 1 } }
  ],
  rocket: [
    { angle: Math.PI, offset: 0, size: 70, width: 42, delay: 0, reload: 0.3, recoil: 3, isTrapezoid: true, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 0.3, damage: 0.5, speed: 1, scatterRate: 3, lifeLength: 0.4, absorbtionFactor: 1 } }
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
    speed: 0.9, spin: false, faceVelocity: true,
    barrels: [{ angle: Math.PI, offset: 0, size: 100, width: 71.4, delay: 0, reload: 0.36, recoil: 1, isTrapezoid: true, trapezoidDirection: 0, addon: null, droneCount: 24, canControlDrones: true,
      bullet: { type: 'drone', sizeRatio: 21 / (71.4 / 2), health: 12.5, damage: 0.56, speed: 1.7, scatterRate: 1, lifeLength: 1.5, absorbtionFactor: 1 } }]
  },
  {
    name: 'Summoner', sides: 4, size: 150, fill: C.square, stroke: C.squareS, speed: 0.6, spin: true,
    barrels: [0, 1, 2, 3].map(function (i) {
      return { angle: 2 * Math.PI * (i / 4), offset: 0, size: 135, width: 71.4, delay: 0, reload: 0.36, recoil: 1, isTrapezoid: true, trapezoidDirection: 0, addon: null, droneCount: 7, canControlDrones: true,
        bullet: { type: 'drone', sizeRatio: (55 * Math.SQRT1_2) / (71.4 / 2), health: 12.5, damage: 0.56, speed: 1.7, scatterRate: 1, lifeLength: -1, absorbtionFactor: 1, color: C.necro, stroke: C.necroS, sides: 4 } };
    })
  },
  {
    name: 'Defender', sides: 3, size: 150, fill: C.triangle, stroke: C.triangleS, speed: 0.2, spin: true, viewRange: 0, turrets: 3,
    barrels: [0, 1, 2].map(function (i) {
      return { angle: 2 * Math.PI * (i / 3 + 1 / 6), offset: 0, size: 120, width: 71.4, delay: 0, reload: 5, recoil: 2, isTrapezoid: false, trapezoidDirection: 0, addon: 'trapLauncher', forceFire: true,
        bullet: { type: 'trap', sizeRatio: 0.8, health: 12.5, damage: 4, speed: 5, scatterRate: 1, lifeLength: 8, absorbtionFactor: 1, color: C.neutral, stroke: C.neutralS } };
    })
  },
  { name: 'Fallen Overlord', sides: 1, size: 130, fill: C.fallen, stroke: C.fallenS, speed: 0.7, tankId: 12, droneOverride: 3 },
  { name: 'Fallen Booster', sides: 1, size: 120, fill: C.fallen, stroke: C.fallenS, speed: 2.2, tankId: 23 }
];
var BOSS_HEALTH = 3000, BOSS_DAMAGE = 10, BOSS_SCORE = 30000; // 10 * maxMult(4 vs shape / 6 vs tank) -> 40/60

// Base drones: 2000 HP each, reload 0 (spawn as fast as the engine allows).
var BASE_DRONE_BARREL = {
  angle: 0, offset: 0, size: 95, width: 42, delay: 0, reload: 0.2, recoil: 0,
  isTrapezoid: true, trapezoidDirection: 0, addon: null, droneCount: 12, canControlDrones: false,
  bullet: { type: 'drone', sizeRatio: 1, health: 1000, damage: 1, speed: 2.7, scatterRate: 1, lifeLength: -1, absorbtionFactor: 1 }
};

var GAMEMODES = {
  ffa:        { name: 'FFA',              teams: null,                               size: 22300, xp: 1, bases: false },
  team2:      { name: '2 Teams',          teams: ['blue', 'red'],                    size: 22300, xp: 1, bases: true },
  team4:      { name: '4 Teams',          teams: ['blue', 'green', 'purple', 'red'], size: 22300, xp: 1, bases: true },
  maze:       { name: 'Maze',             teams: null,                               size: 22300, xp: 1, bases: false, maze: true, noBoss: true },
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

var MOTHERSHIP = {
  id: 27,
  level: 140,
  maxHealth: 3000,             // TODO: never published; boss-tier is the closest anchor
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
  flagSize: 45
};

var TAG = {
  shrinkInterval: 12.5 * TPS,  // arena loses ~2 units per side on this cadence
  shrinkAmount: 2,
  minOpacity: 0.25             // invisibility is only partial, so nobody can stall forever
};

var ROUND_END_DELAY = 12 * TPS;

if (typeof module !== 'undefined') module.exports = {
  TPS: TPS, MSPT: MSPT, GRID: GRID, C: C, SHAPES: SHAPES, ADDONS: ADDONS, BOSSES: BOSSES,
  LEVEL_SCORE: LEVEL_SCORE, levelFromScore: levelFromScore, statCount: statCount,
  respawnLevel: respawnLevel, uiToWire: uiToWire, GAMEMODES: GAMEMODES, MAX_LEVEL: MAX_LEVEL
};
