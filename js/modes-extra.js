// modes-extra.js — the 38 Mode Lab arenas.
//
// Loaded after modes.js and shares its helpers verbatim (winRound,
// setArenaSize, clearModeEntities, paintTeamColors, possess, botSpot,
// botNearest, botGrown, lockTank, tickPlatformAI). Nothing here is a fork of
// the base game: a mode is a GAMEMODES row plus, where it needs one, a
// MODE_LOGIC entry.
//
// Two shapes of mode live in here:
//
//   * rule modes — one row, no logic at all. `rules: {...}` is read through
//     Game.rule() at the handful of points in the engine that care (friction,
//     damage, regen, XP shares, spawn level, reload, shape quota). Instagib,
//     Vampire, Ice Rink and Blood Money are each one line of behaviour.
//
//   * objective modes — a MODE_LOGIC entry. Anything visual sets g.fx and the
//     renderer picks it up from MODE_FX in modefx.js; anything the scoreboard
//     should show goes in g.teamCounts; anything a player needs to *read* goes
//     in g.modeHud, which rides the map-state packet.
//
// Every objective mode ships a botGoal. Without one the offline arena walks
// straight past the objective and the mode reads as broken.

var LAB_MODES = {};                 // key -> { name, blurb, how: [...] } for the Mode Lab menu

// Registers a mode in one call: the GAMEMODES row, the MODE_LOGIC entry, and
// the prose the Mode Lab and the website both read.
function labMode(key, spec) {
  var g = { name: spec.name, teams: spec.teams || null, size: spec.size || 22300,
    xp: spec.xp || 1, bases: !!spec.bases, lab: true, family: spec.family };
  if (spec.maze) g.maze = true;
  if (spec.noBoss !== false) g.noBoss = true;
  if (spec.boss) delete g.noBoss;
  if (spec.freshStart) g.freshStart = true;
  if (spec.rules) g.rules = spec.rules;
  // Which tank id the Y wheel grows from. Only a mode with a tree of its own
  // sets it; everything else uses the Basic tank.
  if (spec.treeRoot !== undefined) g.treeRoot = spec.treeRoot;
  // ...and whether that tree is a DAG deep enough that every hull wants drawing
  // once rather than once per path into it.
  if (spec.treeUnique) g.treeUnique = true;
  // ...and any edges the mode adds to that tree which the tank table does not
  // carry: {tankId: [ids]}. Armageddon hangs its tiers off the Royale's crowns.
  if (spec.treeGraft) g.treeGraft = spec.treeGraft;
  if (spec.logic) { g.logic = key; MODE_LOGIC[key] = spec.logic; }
  GAMEMODES[key] = g;
  LAB_MODES[key] = { key: key, name: spec.name, family: spec.family, tag: spec.tag || '',
    blurb: spec.blurb, how: spec.how || [], fx: !!spec.fx };
  return g;
}

// --- shared helpers ------------------------------------------------------

// The tanks a mode actually cares about: real players and bots, alive, on the
// board. Skips mode furniture, parked pilots and Arena Closers.
function labTanks(g, out) {
  out = out || [];
  out.length = 0;
  for (var i = 0; i < g.entities.length; i++) {
    var e = g.entities[i];
    if (e.type === 'tank' && !e.dead && !e.parked && !e.modeEntity && !e.isCloser) out.push(e);
  }
  return out;
}

function labPlayers(g) {
  var out = [];
  for (var i = 0; i < g.entities.length; i++) {
    var e = g.entities[i];
    if (e.type === 'tank' && !e.dead && !e.modeEntity && !e.isCloser && (e.isPlayer || e.bot)) out.push(e);
  }
  return out;
}

// mm:ss off a tick count, for the HUD line.
function clock(ticks) {
  var s = Math.max(0, Math.ceil(ticks / TPS));
  return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
}

// The HUD line rides the map-state packet, so it costs a packet to change.
// Modes call this once a second, not every tick.
function setHud(g, text) {
  if (g.modeHud === text) return;
  g.modeHud = text;
  g.mapDirty = true;
}

// A per-mode countdown that ends the round on the highest score. Used by
// anything with a clock and no other win condition.
function tickClock(g, ticks, label, onEnd) {
  if (g.roundEndsAt) return;
  if (g.labClock === undefined) g.labClock = ticks;
  g.labClock--;
  if (g.tick % 25 === 0) setHud(g, label + '  ' + clock(g.labClock));
  if (g.labClock <= 0) { g.labClock = ticks; onEnd(g); }
}

function labLeader(g) {
  var best = null, list = labPlayers(g);
  for (var i = 0; i < list.length; i++) if (!best || list[i].score > best.score) best = list[i];
  return best;
}

// Kill everything a mode dropped on the board and start it over. Every reset
// below funnels through here so nothing leaks between rounds.
function labReset(g, key) {
  clearModeEntities(g);
  g.labClock = undefined;
  g.bountyTarget = null;
  g.ruleOverride = null;
  g.fovScale = undefined;
  g.fx = null;
  g.modeHud = '';
  g.noRespawn = false;
  setArenaSize(g, GAMEMODES[key].size);
  if (MODE_LOGIC[key].init) MODE_LOGIC[key].init(g);
}

// Give a tank a class outright and hold it there. `stats` is wire order.
function labClass(t, id, stats) {
  if (typeof forceTankClass === 'function') forceTankClass(t, id, stats);
  t.labClass = id;
}

// The rectangle entities every objective mode reuses instead of inventing a
// type: goals, pits, hills, checkpoints. `kind` picks the minimap glyph.
function labRect(g, o) {
  var e = new Entity(g, {
    type: o.type || 'tile', sides: 2, x: o.x, y: o.y, size: o.w, width: o.h,
    team: o.team === undefined ? null : o.team, maxHealth: Infinity,
    fill: o.fill || C.box, stroke: o.stroke || C.boxS
  });
  e.damageReduction = 0; e.push = o.push || 0; e.absorb = 0;
  e.hiddenHealthbar = true; e.isBase = true; e.isTile = true; e.modeEntity = true;
  return g.add(e);
}

// A solid wall a mode built: blocks tanks, eats bullets, and sweeps with the
// rest of the mode furniture. Walls live in two lists and a reset has to clear
// both, which labReset does.
function labWall(g, x, y, w, h, fill, stroke) {
  var e = new Entity(g, {
    type: 'wall', sides: 2, x: x, y: y, size: w, width: h,
    fill: fill || C.box, stroke: stroke || C.boxS, maxHealth: Infinity, team: null
  });
  e.isSolidWall = true; e.damageReduction = 0; e.push = 1; e.absorb = 0;
  e.hiddenHealthbar = true; e.modeEntity = true;
  g.walls.push(e);
  return g.add(e);
}

function labMark(g, o) {   // a round point-of-interest: flags, portals, alphas
  var e = new Entity(g, {
    type: o.type || 'flag', sides: o.sides || 5, size: o.size || 60,
    x: o.x, y: o.y, team: o.team === undefined ? null : o.team, maxHealth: Infinity,
    fill: o.fill || C.neutral, stroke: o.stroke || C.neutralS
  });
  e.damageReduction = 0; e.push = 0; e.absorb = 0;
  e.hiddenHealthbar = true; e.modeEntity = true;
  return g.add(e);
}

// Drive a bot to a full stop. Hint-based goals cannot do this: a goal behind
// the tank still asks the ordinary AI to weigh spacing, strafing and dodging
// against it, and at 25 Hz a tank at terminal speed needs twenty ticks to
// reverse. A mode with a two-second window has to be able to say "stop".
function botHalt(t) {
  t.input.up = t.input.down = t.input.left = t.input.right = 0;
  t.vx *= 0.55; t.vy *= 0.55;
  if (Math.hypot(t.vx, t.vy) < 0.5) { t.vx = 0; t.vy = 0; }
}

// Steer a bot at a point with the movement keys, leaving its aim and its
// trigger to the ordinary AI. This is how a mode makes a bot *commit* to
// something — a racing line, a finish line — instead of weighing it against
// spacing, strafing and whatever polygon is underfoot.
function botDriveTo(t, x, y, dead) {
  var dx = x - t.x, dy = y - t.y;
  if (Math.abs(dx) < (dead || 60) && Math.abs(dy) < (dead || 60)) { botHalt(t); return; }
  var a = Math.atan2(dy, dx), c = Math.cos(a), sn = Math.sin(a);
  t.input.right = c > 0.28 ? 1 : 0; t.input.left = c < -0.28 ? 1 : 0;
  t.input.down = sn > 0.28 ? 1 : 0; t.input.up = sn < -0.28 ? 1 : 0;
}

function touching(a, b, pad) {
  var r = a.size + (b.size || 0) + (pad || 0);
  return (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) <= r * r;
}
function insideRect(e, r, pad) {
  return Math.abs(e.x - r.x) <= r.size + (pad || 0) && Math.abs(e.y - r.y) <= r.width + (pad || 0);
}

// =========================================================================
// Family: rule modes — one row each, no logic
// =========================================================================

labMode('scoreattack', {
  name: 'Score Attack', family: 'Rules', tag: '5 minutes',
  blurb: 'FFA with a clock. Highest score when it runs out takes the round, then everyone starts over.',
  how: [
    'Ordinary free-for-all rules — every class, every shape, every stat.',
    'A five-minute clock runs in the top of the screen for everybody.',
    'At zero the leaderboard is read, the winner is announced, and the arena resets to level 1.',
    'The clock is the whole point: with forty seconds left, farming a Pentagon and hunting the leader stop being the same decision.'
  ],
  logic: {
    init: function (g) { g.labClock = 5 * 60 * TPS; },
    tick: function (g) {
      tickClock(g, 5 * 60 * TPS, 'SCORE ATTACK', function () {
        var best = labLeader(g);
        winRound(g, best ? (best.name || 'An unnamed tank') + ' wins with ' + Math.round(best.score) + '!' : 'Nobody scored.');
      });
    },
    reset: function (g) { labReset(g, 'scoreattack'); }
  }
});

labMode('instagib', {
  name: 'Instagib', family: 'Rules', tag: 'one shot',
  blurb: 'Everyone spawns finished. One hit ends it. The arena is small and the respawn is instant.',
  rules: { dmgMult: 30, spawnLevel: 45, shapes: 120, botsDelta: -10 },
  size: 9000,
  how: [
    'You spawn at level 45 with a full build. So does everyone else.',
    'Damage is multiplied thirty times, so any bullet that lands is fatal.',
    'The arena is 9,000 units instead of 22,300 — there is nowhere to farm and nowhere to hide.',
    'No health snowball means the best player wins every fight and still cannot run away with the match.',
    'Bots spawn and respawn at 45 too — the queued respawn level is a rung on a ladder this mode does not have.',
    'The field runs ten tanks lighter than the rest of the Lab, because a 9,000-unit arena is small.'
  ]
});

labMode('vampire', {
  name: 'Vampire', family: 'Rules', tag: 'no regen',
  blurb: 'Regeneration is switched off entirely. The only way to heal is to hurt something.',
  rules: { regen: 0, lifesteal: 0.6 },
  fx: true,
  how: [
    'Passive and hyper regeneration are both zero. A hurt tank stays hurt.',
    'Damage you deal comes back as health: 60% off a tank, 15% off a shape.',
    'Body damage, bullets, drones and traps all feed it — it is hooked at the single point all damage runs through.',
    'It inverts the retreat instinct: the way out of a fight you are losing is through whoever is winning it.'
  ]
});

labMode('icerink', {
  name: 'Ice Rink', family: 'Rules', tag: 'no friction',
  blurb: 'Friction drops from 10% to 2%. Everything drifts, nothing stops, and recoil becomes steering.',
  rules: { friction: 0.022, accelMult: 0.22 },
  fx: true,
  how: [
    'Damping drops from 10% to 2.2%, so nothing stops on its own any more.',
    'Acceleration is cut by the same factor, which is the part that makes it ice rather than a speed boost — top speed is normal, but it takes five times as long to reach and five times as long to shed.',
    'That matters: friction alone multiplies terminal speed by the same factor, and a tank moving five times faster than the camera can follow reads as vibration rather than as speed.',
    'Braking distance becomes a real thing to think about, and ramming becomes a skill instead of a stat.',
    'Recoil-heavy classes — Booster, Fighter, Tri-Angle, Rocketeer — read completely differently on ice.',
    'The floor is drawn as ice: a frozen sheet with cracks and drifting frost, and skate marks behind anything moving fast.'
  ]
});

labMode('bloodmoney', {
  name: 'Blood Money', family: 'Rules', tag: 'no farming',
  blurb: 'Polygons are worth nothing. The only score in the arena is carried by other tanks.',
  rules: { shapeXp: 0, killShare: 1, killBounty: 12000, spawnLevel: 15 },
  how: [
    'Shapes pay nothing at all. Shooting them is exercise.',
    'A kill pays a flat 12,000 bounty plus everything the loser was carrying.',
    'The flat bounty is the whole mode: everyone starts on nothing, so a share of nothing is nothing, and without it the scoreboard could never move off zero.',
    '12,000 is roughly level 30 from a standing start, so your first kill is a real jump and the leader is genuinely dangerous.',
    'You spawn at level 15 — the first upgrade tier — so you pick a class on the way in and nobody is helpless.',
    'Bots have their farm weighting stripped in this mode, so they come looking too.'
  ],
  logic: {
    init: function () {},
    // Bots weight farming per role; leaving that alone had half the field
    // shouldering Squares for nothing.
    onSpawn: function (g, t) { if (t.bot && t.botRole) t.botRole = { key: t.botRole.key, label: t.botRole.label,
      farm: 0, fight: t.botRole.fight + 0.6, prey: t.botRole.prey, greed: t.botRole.greed, flee: t.botRole.flee, ram: t.botRole.ram }; },
    tick: function (g) { if (g.tick % 25 === 0) setHud(g, 'BLOOD MONEY  ·  polygons pay nothing'); },
    reset: function (g) { labReset(g, 'bloodmoney'); }
  }
});

labMode('locust', {
  name: 'Locust', family: 'Rules', tag: 'swarm',
  blurb: 'The polygon quota goes up tenfold and the tanks go away. Just you and an ocean of shapes.',
  rules: { shapes: 4000, bots: 0 },
  fx: true,
  how: [
    'Four thousand shapes instead of a thousand, with the crasher belt turned up.',
    'No bots at all — nothing in the arena is trying to out-score you.',
    'Pure kinetic farming with genuine pressure behind it, because a wall of crashers still hurts.',
    'It doubles as the honest stress test: if the broadphase survives this it survives anything.'
  ],
  logic: {
    init: function (g) { g.labSwarm = 0; },
    tick: function (g) {
      // Keep a live crasher belt on top of the ordinary quota — the swarm is
      // the mode, and the field spawner alone will not build one.
      if (g.tick % 10 === 0) {
        var n = 0;
        for (var i = 0; i < g.entities.length; i++) if (g.entities[i].type === 'shape' && g.entities[i].isCrasher) n++;
        if (n < 150) for (var k = 0; k < 4; k++) {
          var a = Math.random() * Math.PI * 2, r = g.arena.right * (0.3 + Math.random() * 0.6);
          g.add(new Shape(g, Math.random() < 0.5 ? 'crasherS' : 'crasherL', Math.cos(a) * r, Math.sin(a) * r));
        }
      }
      if (g.tick % 25 === 0) setHud(g, 'LOCUST  ·  survive the field');
    },
    reset: function (g) { labReset(g, 'locust'); }
  }
});

// =========================================================================
// Family: the class tree
// =========================================================================

// A rung ladder that starts easy, ends awkward, and covers every branch on the
// way. Built from playable ids so a table change can never point it at a
// Dominator.
var GUN_CHAIN = [0, 1, 4, 8, 6, 21, 24, 9, 18, 12, 40, 31, 42, 55, 15, 19, 26, 35, 5, 34, 2];
var GUN_STATS = [7, 7, 7, 7, 7, 0, 7, 0];    // wire order; clamped per class

labMode('gungame', {
  name: 'Gun Game', family: 'The Tree', tag: '21 rungs',
  blurb: 'Your class is the scoreboard. Every kill moves you a rung up a fixed ladder; finish it to win.',
  rules: { spawnLevel: 45, shapes: 400, bots: 24 },
  fx: true,
  how: [
    'Everybody is level 45 with the same build, players and bots alike, on every spawn and every respawn.',
    'There are no upgrade cards at all — the ladder is the progression, and a card would let you step off it.',
    'A kill moves you one class up a fixed 21-rung ladder, applied instantly. A death drops you one, never below rung 1.',
    'The ladder runs Basic → Twin → Triplet → Gunner → Sniper → Overlord → Trapper → Booster → Necromancer → Annihilator, and finishes on Smasher.',
    'Because your gun is public, everyone can see how close everyone else is to winning — and the leader is always stuck on the hardest class.',
    'Shapes still pay, so a losing player has something to do, but only kills move the ladder.'
  ],
  logic: {
    init: function (g) { g.gunRung = {}; },
    // The ladder IS the progression. Offering cards on top of it lets a player
    // walk off the ladder entirely, and the panel came back on every respawn.
    filterUpgrades: function () { return []; },
    onSpawn: function (g, t) {
      var r = g.gunRung[t.name] || 0;
      t.gunRung = r;
      labClass(t, GUN_CHAIN[Math.min(r, GUN_CHAIN.length - 1)], GUN_STATS);
    },
    onTankDeath: function (g, victim, killer) {
      var root = killer; while (root && root.owner) root = root.owner;
      if (root && root.type === 'tank' && root !== victim && !root.modeEntity) {
        root.gunRung = (root.gunRung || 0) + 1;
        g.gunRung[root.name] = root.gunRung;
        if (root.gunRung >= GUN_CHAIN.length) {
          winRound(g, (root.name || 'An unnamed tank') + ' climbed the whole ladder — Gun Game over!');
          return;
        }
        labClass(root, GUN_CHAIN[root.gunRung], GUN_STATS);
        root.health = root.maxHealth;
        root.notify('Rung ' + (root.gunRung + 1) + '/' + GUN_CHAIN.length + ' — ' + root.def.name, 90);
      }
      var back = Math.max(0, (victim.gunRung || 0) - 1);
      victim.gunRung = back;
      g.gunRung[victim.name] = back;
    },
    tick: function (g) {
      if (g.tick % 25) return;
      var list = labPlayers(g), best = null;
      for (var i = 0; i < list.length; i++) if (!best || (list[i].gunRung || 0) > (best.gunRung || 0)) best = list[i];
      setHud(g, best ? 'GUN GAME  ·  leader ' + (best.name || '?') + ' on ' + ((best.gunRung || 0) + 1) + '/' + GUN_CHAIN.length : 'GUN GAME');
    },
    reset: function (g) { g.gunRung = {}; labReset(g, 'gungame'); },
    botGoal: function () { return null; }
  }
});

labMode('draft', {
  name: 'Draft Roulette', family: 'The Tree', tag: 'one card',
  blurb: 'At every upgrade tier the game deals you exactly one class. Take it, or stay where you are.',
  fx: true,
  how: [
    'When an upgrade unlocks you are offered a single random card out of the ones your class actually leads to.',
    'You may always decline and stay put — a bad roll at 15 should not end your life.',
    'The roll is fixed per tank per tier, so re-opening the panel will not re-roll it.',
    'It is enforced where the upgrade is granted, not in the UI, so the card you were not dealt is refused outright.',
    'Most players run three branches forever. This is how they end up in the other fifty-three classes.'
  ],
  logic: {
    init: function () {},
    // One card, and the same card every time this tank asks at this tier.
    filterUpgrades: function (g, t, avail) {
      if (!avail.length) return avail;
      if (!t.draftPick) t.draftPick = {};
      var key = t.upgradesTaken.length;
      if (t.draftPick[key] === undefined || avail.indexOf(t.draftPick[key]) === -1)
        t.draftPick[key] = avail[(Math.random() * avail.length) | 0];
      return [t.draftPick[key]];
    },
    tick: function (g) { if (g.tick % 25 === 0) setHud(g, 'DRAFT ROULETTE  ·  one card per tier'); },
    reset: function (g) { labReset(g, 'draft'); }
  }
});

labMode('mirror', {
  name: 'Mirror Match', family: 'The Tree', tag: 'one class',
  blurb: 'The whole arena plays the same class. One roll at the start of the round, and no upgrades.',
  rules: { spawnLevel: 45 },
  how: [
    'A class is drawn when the round starts and every tank in the arena is given it.',
    'Everybody is level 45 with a full spread, clamped to whatever that class allows.',
    'No upgrade cards — the roll is the build.',
    'A round lasts four minutes, then a new class is drawn and the arena starts again.',
    'Thirty Rocketeers in one place teaches you more about Rocketeer than a week of playing it well.'
  ],
  logic: {
    init: function (g) { g.mirrorId = randomTankId(); g.labClock = 4 * 60 * TPS; },
    onSpawn: function (g, t) { labClass(t, g.mirrorId, GUN_STATS); },
    filterUpgrades: function () { return []; },
    tick: function (g) {
      tickClock(g, 4 * 60 * TPS, 'MIRROR: ' + (TANK_DEFS[g.mirrorId] ? TANK_DEFS[g.mirrorId].name.toUpperCase() : ''), function () {
        var best = labLeader(g);
        winRound(g, (best ? (best.name || 'An unnamed tank') : 'Nobody') + ' takes the ' + TANK_DEFS[g.mirrorId].name + ' round!');
      });
    },
    reset: function (g) { labReset(g, 'mirror'); }
  }
});

labMode('randomizer', {
  name: 'Randomizer', family: 'The Tree', tag: 'every 30s',
  blurb: 'Every thirty seconds the entire arena is re-classed at random, mid-fight, with no warning.',
  rules: { spawnLevel: 45 },
  fx: true,
  how: [
    'A timer runs down from thirty. When it hits zero every living tank is dealt a new random class.',
    'Health carries over as a percentage, so the reroll never kills you outright.',
    'Stats are clamped to the new class the same way a normal upgrade clamps them.',
    'The last five seconds are counted down on screen so the whole arena can brace for it.',
    'It tests the only thing diep never measures: what you do in the first two seconds with a weapon you did not pick.'
  ],
  logic: {
    init: function (g) { g.rerollAt = g.tick + 30 * TPS; },
    onSpawn: function (g, t) { labClass(t, randomTankId(), GUN_STATS); },
    filterUpgrades: function () { return []; },
    tick: function (g) {
      var left = g.rerollAt - g.tick;
      if (left <= 0) {
        g.rerollAt = g.tick + 30 * TPS;
        var list = labTanks(g);
        for (var i = 0; i < list.length; i++) {
          var t = list[i], frac = t.health / t.maxHealth;
          labClass(t, randomTankId(), GUN_STATS);
          t.health = t.maxHealth * frac;
        }
        g.notify('REROLL!', 40);
        g.fx = { flash: g.tick };
      } else if (left <= 5 * TPS && left % TPS === 0) {
        g.notify('Reroll in ' + (left / TPS) + '...', TPS);
      }
      if (g.tick % 25 === 0) setHud(g, 'RANDOMIZER  ·  reroll in ' + clock(g.rerollAt - g.tick));
    },
    reset: function (g) { labReset(g, 'randomizer'); }
  }
});

// =========================================================================
// Family: asymmetric power
// =========================================================================

// The one invented tank in the Lab. Everything else here plays with classes
// that already exist; the Juggernaut needed a hull no class tree produces —
// twelve sides, a spiked collar, and guns on every face. Built to the same
// rules as the real table (trapezoid barrels, ratio-scaled addons) so it draws
// like something the game could ship.
var JUGGERNAUT_ID = 255;

// Barrel groups, switched on and off by range. `band` is the index the mode
// enables: everything at or below the current band fires. So a Juggernaut on
// its own plinks with the ring guns, and one being swarmed is running all four
// groups at once.
var JUGG_BAND = { RING: 0, CANNON: 1, SWARM: 2, SPIKE: 3 };

function buildJuggernautDef() {
  if (TANK_DEFS[JUGGERNAUT_ID]) return;
  var bar = [];
  function push(band, def) { def.juggBand = band; bar.push(def); }

  // 0 — the ring. Always on. Six light guns on alternating faces, so it is
  //     never harmless and never oppressive at range.
  for (var i = 0; i < 6; i++) {
    push(JUGG_BAND.RING, {
      angle: Math.PI * 2 * (i / 6), offset: 0, size: 105, width: 60, delay: i % 2 ? 0.5 : 0,
      reload: 1.9, recoil: 0.4, isTrapezoid: false, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 7, damage: 0.47, speed: 1.1, scatterRate: 0.4, lifeLength: 1.1, absorbtionFactor: 0.6 }
    });
  }
  // 1 — the cannons. Two heavy forward guns, aimed where it is looking.
  [-0.16, 0.16].forEach(function (a) {
    push(JUGG_BAND.CANNON, {
      angle: a, offset: 0, size: 128, width: 84, delay: 0, reload: 3.4, recoil: 1.6,
      isTrapezoid: true, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1.15, health: 22, damage: 1.07, speed: 0.95, scatterRate: 0.2, lifeLength: 1.4, absorbtionFactor: 0.35 }
    });
  });
  // 2 — the swarm. A drone hangar out the back, and two trap launchers that
  //     seed the ground around it so nobody circles it for free.
  push(JUGG_BAND.SWARM, {
    angle: Math.PI, offset: 0, size: 90, width: 66, delay: 0, reload: 3, recoil: 0,
    isTrapezoid: true, trapezoidDirection: 1, addon: null, droneCount: 8, canControlDrones: true,
    bullet: { type: 'drone', sizeRatio: 0.9, health: 9, damage: 0.37, speed: 1.35, scatterRate: 1, lifeLength: -1, absorbtionFactor: 1 }
  });
  [Math.PI * 0.72, -Math.PI * 0.72].forEach(function (a) {
    push(JUGG_BAND.SWARM, {
      angle: a, offset: 0, size: 74, width: 62, delay: 0, reload: 4.5, recoil: 0.4,
      isTrapezoid: false, trapezoidDirection: 0, addon: 'trapLauncher',
      bullet: { type: 'trap', sizeRatio: 0.9, health: 18, damage: 0.9, speed: 2.2, scatterRate: 1, lifeLength: 6, absorbtionFactor: 1, color: '#4A4A55', stroke: '#2A2A32' }
    });
  });
  // 3 — the spikes. Twelve short-range shredders, one per face, that only open
  //     up when something is inside the collar. This is the "do not stand next
  //     to it" rule, and it is enforced rather than announced.
  for (i = 0; i < 12; i++) {
    push(JUGG_BAND.SPIKE, {
      angle: Math.PI * 2 * (i / 12) + Math.PI / 12, offset: 0, size: 68, width: 34,
      delay: (i % 4) / 4, reload: 0.85, recoil: 0.1, isTrapezoid: true, trapezoidDirection: 1, addon: null,
      bullet: { type: 'bullet', sizeRatio: 0.75, health: 5, damage: 0.5, speed: 1.5, scatterRate: 1.4, lifeLength: 0.42, absorbtionFactor: 0.4 }
    });
  }

  // Every number a Tank derives lives in the def, not in an override applied
  // after recompute() — recompute runs again on the next kill and would put all
  // of them back. This is the Mothership bug (README 27), written down.
  // At level 45 with the stats below: 8772 + 2*44 + 7*20 = 9000 health,
  // and 5 + 7 + 20 = 32 body damage.
  TANK_DEFS[JUGGERNAUT_ID] = {
    id: JUGGERNAUT_ID, name: 'Juggernaut', upgradeMessage: 'YOU ARE THE JUGGERNAUT', levelRequirement: 0,
    upgrades: [], flags: { invisibility: false, zoomAbility: false, canClaimSquares: false, devOnly: false },
    visibilityRateShooting: 0.23, visibilityRateMoving: 0.08, invisibilityRate: 0.03,
    // fieldFactor is a zoom-OUT divisor: lower sees further (Ranger is 0.7, a
    // plain Tank is 1.0). At 1.12 the Juggernaut was seeing LESS than everyone
    // hunting it, while being 2.1x their size. 0.82 puts it between Assassin
    // and Predator, which is what a hull this big should have.
    fieldFactor: 0.82, absorbtionFactor: 0.05, speed: 0.72, maxHealth: 8772, preAddon: null,
    postAddon: 'spike', sides: 12, borderWidth: 15, baseSizeOverride: 96, bodyDamage: 20,
    stats: [{ name: 'Movement Speed', max: 7 }, { name: 'Reload', max: 7 }, { name: 'Bullet Damage', max: 7 },
      { name: 'Bullet Penetration', max: 7 }, { name: 'Bullet Speed', max: 7 }, { name: 'Body Damage', max: 7 },
      { name: 'Max Health', max: 7 }, { name: 'Health Regen', max: 7 }],
    barrels: bar
  };
}

function makeJuggernaut(g, from) {
  buildJuggernautDef();
  var t = from;
  t.isJuggernaut = true;
  t.score = Math.max(t.score, LEVEL_SCORE[MAX_LEVEL]);
  t.level = MAX_LEVEL;
  // Regen stat 0: (9000*4*0 + 9000) / 25000 = 0.36 a tick, about 9 health a
  // second. At stat 2 it was 3.24 a tick — 81 a second — which is more sustain
  // than twenty-nine tanks could out-damage, and the thing simply never dropped
  // below 98% no matter how many were on it. It is meant to be hard to kill
  // because it has 9,000 health and hits for 32, not because it heals.
  t.scaleBoost = 2.1;
  labClass(t, JUGGERNAUT_ID, [7, 7, 7, 7, 7, 7, 7, 0]);
  t.health = t.maxHealth;
  t.minDmg = 1; t.maxDmg = 5;
  t.push = 22;                       // recompute() pins push at 8, so tick re-applies it
  t.name = (t.name || 'Juggernaut') + ' \u2620';
  t.fill = '#2B2B33'; t.stroke = '#16161B';
  t.protectedUntil = 0;
  t.juggBand = JUGG_BAND.RING;
  t.juggSlam = 0; t.juggWave = 0; t.juggRage = false;
  g.bountyTarget = t;                // every bot in the arena now wants this specifically
  g.mapDirty = true;
  return t;
}

function unJuggernaut(g, t) {
  if (!t || !t.isJuggernaut) return;
  t.isJuggernaut = false;
  t.scaleBoost = 1;
  t.juggBand = undefined;
  t.name = String(t.name || '').replace(' \u2620', '');
  for (var i = 0; i < t.barrels.length; i++) t.barrels[i].disabled = false;
  if (g.bountyTarget === t) g.bountyTarget = null;
}

// How far out the collar reaches, in world units — the radius inside which the
// spike guns open up. Scales with the hull, so it stays honest if the size does.
function juggSpikeRange(j) { return j.size * 2.4; }

// Everything the Juggernaut does that is not a barrel. Called once a tick.
function tickJuggernaut(g, j) {
  if (!j || j.dead) return;
  j.push = 22;                              // the one field recompute() pins

  // What is actually near it, and how near.
  var near = 0, nearest = Infinity, list = labTanks(g);
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (t === j || t.isJuggernaut) continue;
    var d = Math.hypot(t.x - j.x, t.y - j.y);
    if (d < nearest) nearest = d;
    if (d < 2200) near++;
  }
  var spikeR = juggSpikeRange(j);

  // Bands open inward: the closer they get, the more of it is pointed at them.
  var band = JUGG_BAND.RING;
  if (nearest < 3200) band = JUGG_BAND.CANNON;
  if (nearest < 2000 || near >= 3) band = JUGG_BAND.SWARM;
  if (nearest < spikeR) band = JUGG_BAND.SPIKE;
  j.juggBand = band;
  for (i = 0; i < j.barrels.length; i++) {
    var b = j.barrels[i];
    var want = b.def.juggBand === undefined ? 0 : b.def.juggBand;
    // The spikes are close-range only; everything else stays on once opened.
    b.disabled = want > band || (want === JUGG_BAND.SPIKE && nearest > spikeR);
  }
  j.input.fire = 1;
  j.autoFire = true;

  // Cornered: under a third of its health it gets faster and reloads harder,
  // so a mob that commits has to finish rather than chip it down forever.
  var rage = j.health < j.maxHealth * 0.34;
  if (rage !== j.juggRage) {
    j.juggRage = rage;
    j.reloadTime *= rage ? 0.55 : 1 / 0.55;
    j.movementSpeed *= rage ? 1.35 : 1 / 1.35;
    if (rage) g.notify('The Juggernaut is cornered!', 70);
  }

  // SLAM — anything inside the collar is thrown off it and hurt. On a cooldown,
  // so walking in is survivable once and suicidal twice.
  if (j.juggSlam <= g.tick && nearest < spikeR * 0.8) {
    j.juggSlam = g.tick + 7 * TPS;
    g.juggFx = { slam: g.tick, x: j.x, y: j.y, r: spikeR };
    for (i = 0; i < list.length; i++) {
      var e = list[i];
      if (e === j) continue;
      var dd = Math.hypot(e.x - j.x, e.y - j.y);
      if (dd > spikeR) continue;
      e.addVelocity(Math.atan2(e.y - j.y, e.x - j.x), 34 * (1 - dd / spikeR));
      e.applyDamage(e.maxHealth * 0.22, j);
    }
    g.notify('SLAM', 30);
  }

  // SHOCKWAVE — a full 20-shot ring, fired through the ordinary barrel path so
  // it obeys every rule an ordinary shot does. Only while it is being swarmed.
  if (j.juggWave <= g.tick && near >= 4) {
    j.juggWave = g.tick + 11 * TPS;
    g.juggFx = { wave: g.tick, x: j.x, y: j.y };
    var gun = j.barrels[0];
    var keep = gun.def.angle;
    for (i = 0; i < 20; i++) {
      gun.def.angle = Math.PI * 2 * (i / 20);
      gun.shoot();
    }
    gun.def.angle = keep;
    g.notify('The Juggernaut lets loose!', 40);
  }
}

labMode('juggernaut', {
  name: 'Juggernaut', family: 'Asymmetry', tag: '1 vs all', boss: false,
  teams: ['blue', 'red'],
  blurb: 'One player becomes a twelve-sided monster with 9,000 health. Everyone else drops their grudges and fights it together.',
  // botFarm 0: there is one thing to do in this mode. The arena is 15,000
  // rather than 22,300 so the fight is one fight rather than a commute.
  rules: { spawnLevel: 45, bots: 30, shapes: 400, botFarm: 0 },
  size: 15000,
  fx: true,
  how: [
    'Everybody spawns at level 45 with a full build, and everybody respawns at 45 — there is no ladder to climb here.',
    'For the first twelve seconds it is an ordinary free-for-all. Then a Juggernaut is chosen and the arena reorganises: it goes on red, and every other tank in the game goes on blue, together.',
    'The Juggernaut is a hull no class tree produces — twelve sides, a spiked collar, 9,000 health, 32 body damage, double size and near-total knockback resistance.',
    'Its weapons open up by range. Far out it plinks with six ring guns. Inside 3,200 it brings two heavy cannons. Inside 2,000, or with three of you on it, a drone hangar and two trap launchers. Inside the collar, twelve short-range spike guns.',
    'Get closer still and it SLAMS: everything inside the collar is thrown off and takes 22% of its health. Swarm it with four and it fires a full twenty-shot shockwave.',
    'Under a third health it is cornered — 45% faster reload and 35% more speed — so a mob that commits has to finish the job.',
    'Hunters respawn on a ring 2,600 to 4,000 units from it rather than anywhere in the arena, so the pile-on is continuous instead of a queue of people walking in one at a time to die.',
    'Bots drop everything for it. Farming is switched off arena-wide, the Juggernaut is marked globally so they know where it is regardless of sight range, and their target is pinned to it rather than merely weighted toward it — no level gate, no distance gate, no wandering off after a Square.',
    'They still play it well: they hold just outside the reach of the spike guns and shoot in, orbiting rather than standing still, unless they are a body-damage build — in which case going all the way in is the plan.',
    'It barely regenerates. 9,000 health and 32 body damage is what makes it hard to kill; healing 81 a second on top of that made it unkillable no matter how many were on it.',
    'It sees further than anyone hunting it — 0.82 fieldFactor, between Assassin and Predator — because a hull twice everyone else\'s size looking through a smaller window was simply unfair to it.',
    'Land the killing blow and you are the next Juggernaut, at full health, and the teams re-form around you.'
  ],
  logic: {
    init: function (g) { g.jugg = null; g.juggPick = g.tick + 12 * TPS; g.juggFx = null; g.bountyGlobal = false; },
    onSpawn: function (g, t) {
      // Before a Juggernaut exists the arena is a free-for-all, so nobody has a
      // side. After one exists, everybody who is not it is on the same side.
      if (g.jugg && !g.jugg.dead) {
        t.team = 'blue'; g.paintTeam(t);
        // ...and comes back within reach of it. Respawning at a random point in
        // the arena turned the mode into a treadmill: a hunter spent eighteen
        // seconds walking in, died in two, and walked in again, so the
        // Juggernaut never dropped below 99% health with twenty-nine on it.
        // Far enough out to arrive alive, near enough to arrive at all.
        var a = Math.random() * Math.PI * 2, r = 2600 + Math.random() * 1400;
        t.x = g.jugg.x + Math.cos(a) * r;
        t.y = g.jugg.y + Math.sin(a) * r;
        var lim = g.arena.right - 300;
        t.x = Math.max(-lim, Math.min(lim, t.x));
        t.y = Math.max(-lim, Math.min(lim, t.y));
        t.px = t.x; t.py = t.y;
      } else { t.team = null; t.fill = t.isPlayer ? C.blue : C.red; t.stroke = t.isPlayer ? C.blueS : C.redS; }
    },
    onTankDeath: function (g, victim, killer) {
      if (!victim.isJuggernaut) return;
      unJuggernaut(g, victim);
      g.jugg = null;
      var root = killer; while (root && root.owner) root = root.owner;
      if (root && root.type === 'tank' && !root.dead && !root.modeEntity) {
        crownJuggernaut(g, root);
        g.notify((root.name || 'Someone') + ' is the new Juggernaut!', 100);
      } else {
        g.notify('The Juggernaut has fallen.', 80);
        g.juggPick = g.tick + 5 * TPS;
      }
    },
    tick: function (g) {
      if (g.jugg && (g.jugg.dead || !g.jugg.isJuggernaut)) { unJuggernaut(g, g.jugg); g.jugg = null; }
      if (!g.jugg && g.tick > g.juggPick) {
        var list = labTanks(g);
        if (list.length) { crownJuggernaut(g, pick(list)); g.notify((g.jugg.name || 'Someone') + ' is the Juggernaut!', 100); }
        g.juggPick = g.tick + 5 * TPS;
      }
      if (g.jugg) tickJuggernaut(g, g.jugg);
      g.bountyTarget = g.jugg && !g.jugg.dead ? g.jugg : null;
      // Arena-wide: every bot knows where it is regardless of sight range, and
      // the mark outbids every other consideration in their target scoring.
      g.bountyGlobal = !!g.bountyTarget;

      // Everyone who is not it is on the same side, kept true every tick — a
      // bot that respawned mid-round has to be folded in as well.
      var i, list2 = labTanks(g), hunters = 0;
      for (i = 0; i < list2.length; i++) {
        var t = list2[i];
        if (t === g.jugg) { if (t.team !== 'red') { t.team = 'red'; } continue; }
        hunters++;
        if (g.jugg && t.team !== 'blue') { t.team = 'blue'; g.paintTeam(t); }
      }
      g.teamCounts = g.jugg ? { blue: hunters, red: Math.max(0, Math.round(g.jugg.health)) } : {};
      g.fx = g.jugg && !g.jugg.dead
        ? { jugg: g.jugg, band: g.jugg.juggBand, spikeR: juggSpikeRange(g.jugg), rage: g.jugg.juggRage, juggFx: g.juggFx }
        : null;
      if (g.tick % 25 === 0) setHud(g, g.jugg && !g.jugg.dead
        ? 'JUGGERNAUT  \u00b7  ' + (g.jugg.name || '?') + '  ' + Math.max(0, Math.round(g.jugg.health)) + ' hp  \u00b7  ' + hunters + ' hunting'
        : 'JUGGERNAUT  \u00b7  free-for-all until it is chosen');
    },
    reset: function (g) { unJuggernaut(g, g.jugg); g.jugg = null; g.bountyGlobal = false; labReset(g, 'juggernaut'); },
    // Bots hold at the edge of the collar and shoot in. A body-damage build is
    // the exception: ramming it IS the plan for those, so they go all the way.
    // Everybody goes. No level gate, no health gate, no distance gate — the
    // whole point of the mode is the pile-on, and a bot that decided it was too
    // small to help just farmed instead.
    botGoal: function (g, t) {
      var j = g.jugg;
      if (!j || j.dead || t === j) return null;
      var rammer = t.stats[S_BODY] >= 5 || t.stats[S_HEALTH] >= 5;
      var want = rammer ? j.size * 1.1 : juggSpikeRange(j) * 1.9;
      var d = Math.hypot(t.x - j.x, t.y - j.y);
      if (Math.abs(d - want) < 260) return { e: j };      // in position: just fight
      var a = Math.atan2(t.y - j.y, t.x - j.x);
      return { x: j.x + Math.cos(a) * want, y: j.y + Math.sin(a) * want, vx: 0, vy: 0, touch: false, hard: true };
    },
    // Aim and trigger stay with the ordinary AI; the target and the legs do not.
    //
    // A goal alone was not enough. The movement code treats a goal it has not
    // been told to touch as something to KEEP RANGE from, at the bot's own
    // weapon reach — so a level 45 sniper handed "stand 900 from the
    // Juggernaut" parked three thousand units behind that, and the arena sat in
    // a ring at 2,400 to 11,500 units plinking. Driving the legs directly is the
    // difference between targeting it and fighting it.
    botDrive: function (g, t) {
      var j = g.jugg;
      if (!j || j.dead || t === j || t.isJuggernaut) return;
      t.aiTarget = j;
      t.aiEngaged = j;
      t.aiFarm = null;
      t.autoFire = true;
      // Rammers go all the way in; everyone else holds just outside the collar,
      // where the spike guns cannot reach but their own shots still land.
      // Just outside the collar, not on the line of it. At 1.15x they were
      // standing in the spike guns' own range and being deleted before their
      // shots mattered; at 1.9x the spikes cannot reach and a level 45 gun
      // comfortably can.
      var rammer = t.stats[S_BODY] >= 5 || t.stats[S_HEALTH] >= 5;
      var want = rammer ? j.size * 1.05 : juggSpikeRange(j) * 1.9;
      var d = Math.hypot(t.x - j.x, t.y - j.y) || 1;
      var a = Math.atan2(t.y - j.y, t.x - j.x);
      // Inside the ring, back off; outside it, close. A dead band stops them
      // shuffling in and out on the line itself.
      if (Math.abs(d - want) < 160) {
        // in position — strafe around it rather than standing still
        var orbit = a + (t.id % 2 ? 0.35 : -0.35);
        botDriveTo(t, j.x + Math.cos(orbit) * want, j.y + Math.sin(orbit) * want, 40);
      } else {
        botDriveTo(t, j.x + Math.cos(a) * want, j.y + Math.sin(a) * want, 40);
      }
    }
  }
});

// Crowning re-forms the arena: the new Juggernaut is alone on red and every
// other tank is folded onto blue in the same tick, so nobody spends a second
// shooting a team mate.
function crownJuggernaut(g, t) {
  g.jugg = makeJuggernaut(g, t);
  g.jugg.team = 'red';
  paintTeamColors(g.jugg, null);
  g.jugg.fill = '#2B2B33'; g.jugg.stroke = '#16161B';
  g.jugg.health = g.jugg.maxHealth;
  var list = labTanks(g);
  for (var i = 0; i < list.length; i++) {
    if (list[i] === g.jugg) continue;
    list[i].team = 'blue';
    g.paintTeam(list[i]);
  }
  g.mapDirty = true;
}

labMode('infection', {
  name: 'Infection', family: 'Asymmetry', tag: 'patient zero',
  teams: ['blue', 'red'],
  rules: { spawnLevel: 30, bots: 30, shapes: 700 },
  blurb: 'Everyone is on the same side until one of you turns. The infected cannot shoot, but they are enormously tough and their touch spreads it.',
  fx: true,
  how: [
    'For the first thirty seconds every tank in the arena is human and on the same team, so nobody can shoot anybody. Use it to spread out.',
    'Then one tank at random turns. It moves to red, alone, against everyone.',
    'An infected tank cannot fire at all — every barrel is switched off. In exchange it gets four times the health, heavy body damage, more speed, and it sees invisible.',
    'You do not have to be killed to turn. Any contact with an infected tank infects you, and the arena watches for it every tick.',
    'A newly turned tank keeps playing — it respawns immediately as one of the horde rather than sitting out.',
    'Humans win by surviving five minutes. The infected win by taking everybody.',
    'The play area shrinks throughout, so the last humans cannot sit in a corner and wait, and invisibility is floored at 25% for the same reason.'
  ],
  logic: {
    init: function (g) {
      g.infStart = g.tick + 30 * TPS;
      g.labClock = 5 * 60 * TPS + 30 * TPS;
      g.infected = false;
    },
    onSpawn: function (g, t) {
      // Before patient zero, everybody is blue and nobody can shoot anybody.
      // After, a tank that dies to the horde comes back as part of it.
      if (t.nextTeam === 'red' || (g.infected && t.team === 'red')) turnZombie(g, t);
      else { t.team = 'blue'; g.paintTeam(t); }
    },
    onTankDeath: function (g, victim, killer) {
      var root = killer; while (root && root.owner) root = root.owner;
      if (root && root.type === 'tank' && root.isZombie && victim.team !== 'red') victim.nextTeam = 'red';
    },
    tick: function (g) {
      var list = labTanks(g), i, k, humans = 0, zombies = 0, zoms = [];
      for (i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.invisible && t.opacity < 0.25) t.opacity = 0.25;
        if (t.team === 'red') {
          zombies++; zoms.push(t);
          if (!t.isZombie) turnZombie(g, t); else zombieStats(t);
        }
        else { humans++; if (t.team !== 'blue') { t.team = 'blue'; g.paintTeam(t); } }
      }
      g.teamCounts = { blue: humans, red: zombies };

      if (g.tick < g.infStart) {
        if ((g.infStart - g.tick) % TPS === 0) g.notify('Infection begins in ' + Math.ceil((g.infStart - g.tick) / TPS) + '...', TPS);
        if (g.tick % 25 === 0) setHud(g, 'INFECTION  \u00b7  scatter  \u00b7  ' + clock(g.infStart - g.tick));
        return;
      }
      if (!g.infected && list.length) {
        g.infected = true;
        var zero = pick(list);
        turnZombie(g, zero);
        zoms.push(zero);
        g.notify((zero.name || 'Someone') + ' is patient zero!', 120);
        zombies++; humans--;
      }
      // Contact spreads it. A kill is not required — brushing one is enough,
      // which is what makes the horde frightening rather than merely numerous.
      for (i = 0; i < zoms.length; i++) {
        for (k = 0; k < list.length; k++) {
          var h = list[k];
          if (h.team === 'red' || h.dead) continue;
          if (g.tick < h.protectedUntil && !h.moved && !h.shot) continue;
          var rr = h.size + zoms[i].size + 8;
          if ((h.x - zoms[i].x) * (h.x - zoms[i].x) + (h.y - zoms[i].y) * (h.y - zoms[i].y) > rr * rr) continue;
          turnZombie(g, h);
          g.notify((h.name || 'Someone') + ' has been infected!', 50);
          humans--; zombies++;
        }
      }
      if (g.tick % 50 === 0 && g.arena.size > 8000) setArenaSize(g, g.arena.size - 60);
      g.fx = { infection: zombies / Math.max(1, humans + zombies) };
      g.labClock--;
      if (g.tick % 25 === 0) setHud(g, 'INFECTION  \u00b7  ' + humans + ' human' + (humans === 1 ? '' : 's') + ' left  \u00b7  ' + clock(g.labClock));
      if (g.roundEndsAt) return;
      if (g.infected && humans === 0) winRound(g, 'Everyone is infected \u2014 the horde wins!');
      else if (g.labClock <= 0) winRound(g, humans + ' survivor' + (humans === 1 ? '' : 's') + ' held out \u2014 humans win!');
    },
    reset: function (g) {
      var list = labTanks(g);
      for (var i = 0; i < list.length; i++) { list[i].nextTeam = null; unZombie(list[i]); }
      labReset(g, 'infection');
    },
    // Humans run from the nearest zombie; zombies run at the nearest human.
    // Neither needs a gun goal, because only one side has one.
    botGoal: function (g, t) {
      if (!g.infected) return null;
      var list = labTanks(g), best = null, bd = Infinity;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e === t) continue;
        if (t.isZombie ? e.team === 'red' : e.team !== 'red') continue;
        var d = Math.hypot(e.x - t.x, e.y - t.y);
        if (d < bd) { bd = d; best = e; }
      }
      if (!best) return null;
      if (t.isZombie) return botSpot(best, true);
      if (bd > 2600) return null;
      var a = Math.atan2(t.y - best.y, t.x - best.x);
      return { x: t.x + Math.cos(a) * 2000, y: t.y + Math.sin(a) * 2000, vx: 0, vy: 0, touch: false, hard: true };
    }
  }
});

// An infected tank keeps its own hull — the silhouette you knew is still the
// silhouette coming at you — but every barrel is switched off and the numbers
// are rebuilt around contact.
function turnZombie(g, t) {
  if (t.isZombie) return;
  t.isZombie = true;
  t.team = 'red';
  t.seesInvisible = true;
  t.turrets = [];
  t.fill = '#4E8F3A'; t.stroke = '#356226';
  t.hurtFlash = 4;
  zombieStats(t);
  t.health = t.maxHealth;
  g.mapDirty = true;
}

// Re-applied every tick rather than set once. recompute() runs on every score
// change and rebuilds maxHealth, damagePerTick, absorb and movementSpeed
// straight off the tank def — a zombie buffed at the moment it turned was an
// ordinary tank again the first time it touched a polygon.
function zombieStats(t) {
  for (var i = 0; i < t.barrels.length; i++) t.barrels[i].disabled = true;
  var frac = t.maxHealth ? t.health / t.maxHealth : 1;
  t.maxHealth = t.baseMaxHealthForZombie || (t.baseMaxHealthForZombie = t.maxHealth) * 1;
  t.maxHealth = t.baseMaxHealthForZombie * 4;
  t.health = Math.min(t.maxHealth, t.maxHealth * frac);
  t.damagePerTick = 40;
  t.absorb = 0.35;                       // hard to shove off you
}
function unZombie(t) {
  if (!t.isZombie) return;
  t.isZombie = false;
  t.seesInvisible = false;
  t.baseMaxHealthForZombie = 0;
  for (var i = 0; i < t.barrels.length; i++) t.barrels[i].disabled = false;
  t.recompute();
}

labMode('bossrush', {
  name: 'Boss Rush', family: 'Asymmetry', tag: 'endless co-op',
  teams: ['blue', 'red'], xp: 3,
  blurb: 'Everyone against the arena. Wave after wave of bosses, harder every time, for as long as you can hold them.',
  rules: { shapes: 400, bots: 12, spawnLevel: 20 },
  fx: true,
  how: [
    'Every player and every bot is on blue. There is no PvP at all — you cannot damage each other.',
    'Only bosses spawn. Guardians, Summoners, Fallen Overlords, Fallen Boosters and Defenders, drawn from the same table the base game uses.',
    'The waves never end. Wave n fields ceil(n/2) bosses, and every wave multiplies their health, damage, reload and bullet speed a little more — by wave 20 a Guardian has roughly nine times the health it started with.',
    'Clear a wave and the next one arrives eight seconds later. There is no cap; the score is the wave you reached.',
    'Everyone respawns freely while at least one of you is alive. A total wipe ends the run and the arena restarts at wave 1.',
    'Bots are told where the wave is, so they group up on it instead of farming.',
    'It is the only co-operative mode in the build, which is exactly why it exists.'
  ],
  logic: {
    init: function (g) { g.wave = 0; g.waveAt = g.tick + 10 * TPS; g.waveLive = []; },
    onSpawn: function (g, t) { t.team = 'blue'; g.paintTeam(t); },
    tick: function (g) {
      var i;
      for (i = g.waveLive.length - 1; i >= 0; i--) if (g.waveLive[i].dead) g.waveLive.splice(i, 1);
      var alive = 0, list = labTanks(g);
      for (i = 0; i < list.length; i++) if (list[i].team === 'blue') { alive++; }

      if (!g.waveLive.length && g.tick >= g.waveAt) {
        g.wave++;
        g.waveAt = g.tick + 8 * TPS;
        spawnBossWave(g, g.wave);
        g.notify('WAVE ' + g.wave + ' \u2014 ' + g.waveLive.length + ' boss' + (g.waveLive.length === 1 ? '' : 'es'), 80);
        g.fx = { waveFlash: g.tick };
      }
      g.teamCounts = { blue: alive, red: g.waveLive.length };
      if (g.tick % TPS === 0 && g.waveLive.length) g.mapDirty = true;
      if (g.tick % 25 === 0) setHud(g, 'BOSS RUSH  \u00b7  wave ' + Math.max(1, g.wave) + '  \u00b7  ' + g.waveLive.length + ' left  \u00b7  ' + alive + ' alive');
      if (g.roundEndsAt) return;
      // A wipe is everybody dead at once, which the respawn queue undoes within
      // a second — so it only counts once a wave is actually on the board.
      if (g.wave > 0 && alive === 0) winRound(g, 'Wiped on wave ' + g.wave + '.');
    },
    reset: function (g) { g.wave = 0; g.waveLive = []; labReset(g, 'bossrush'); },
    botGoal: function (g, t) {
      if (!g.waveLive || !g.waveLive.length) return null;
      var e = botNearest(t, g.waveLive, function (x) { return !x.dead; });
      return e ? { e: e } : null;
    }
  }
});

// Wave n: ceil(n/2) bosses, each scaled up. The scaling is multiplicative and
// uncapped, which is what "infinite waves" has to mean — there is no last wave,
// only the one you cannot hold.
function spawnBossWave(g, n) {
  var count = Math.ceil(n / 2);
  var hp = Math.pow(1.12, n - 1);
  var dmg = Math.pow(1.06, n - 1);
  for (var i = 0; i < count; i++) {
    var spec = BOSSES[(Math.random() * BOSSES.length) | 0];
    var b = new Boss(g, spec);
    var ang = Math.PI * 2 * ((i + Math.random()) / count);
    var r = g.arena.right * 0.86;
    b.x = Math.cos(ang) * r; b.y = Math.sin(ang) * r;
    b.px = b.x; b.py = b.y;
    b.team = 'red';
    b.modeEntity = true;
    b.maxHealth = Math.round(BOSS_HEALTH * hp);
    b.health = b.maxHealth;
    b.regenPerTick = b.maxHealth / 25000;
    b.damagePerTick = BOSS_DAMAGE * dmg;
    b.scoreReward = Math.round(BOSS_SCORE * (1 + n * 0.15));
    // Reload and bullet speed climb too, so late waves are faster as well as
    // fatter — health alone just makes a wave longer, not harder.
    b.stats = [0, Math.min(7, 4 + Math.floor(n / 3)), Math.min(7, 4 + Math.floor(n / 4)),
      Math.min(7, 4 + Math.floor(n / 4)), Math.min(7, 4 + Math.floor(n / 5)), 0, 0, 0];
    b.reloadTime = 15 * Math.pow(0.914, b.stats[1]);
    b.movementSpeed = (spec.speed || 0.5) * Math.min(2.4, 1 + n * 0.035);
    g.waveLive.push(g.add(b));
  }
  g.mapDirty = true;
}

labMode('siege', {
  name: 'Siege', family: 'Asymmetry', tag: 'attack / defend',
  teams: ['blue', 'red'], bases: true,
  blurb: 'One side holds a fortified base with Dominators and endless respawns. The other has ten minutes.',
  fx: true,
  how: [
    'Red defends: two Dominators bolted to the base, the base drone spawners, and unlimited respawns.',
    'Blue attacks: a ten-minute clock and a shared pool of forty lives for the whole team.',
    'The objective is the Core, a 12,000-health block behind the defence. Break it and the attack wins.',
    'Run out of clock or lives and the defence holds.',
    'Sides swap at the end of a round, so both halves count and the faster attack takes it.',
    'This is the only mode where Trapper classes have an actual job — a wall that builds itself in front of something that cannot move.'
  ],
  logic: {
    init: function (g) {
      var a = g.arena;
      g.siegeSwap = g.siegeSwap || false;
      g.labClock = 10 * 60 * TPS;
      g.siegeLives = 40;
      // A solid block, not a floor tile. It was inheriting labRect's isTile,
      // which draws at 55% opacity and reads as something you can walk over —
      // while colliding as a 760-unit square you cannot.
      g.core = labRect(g, { x: a.right * 0.72, y: 0, w: 300, h: 300, team: 'red', fill: '#B45A5F', stroke: '#8A4348', push: 12 });
      g.core.isTile = false; g.core.isBase = false;
      g.core.maxHealth = 12000; g.core.health = 12000;
      g.core.damageReduction = 1; g.core.hiddenHealthbar = false; g.core.isCore = true;
      g.core.absorb = 0;
      g.core.name = 'Core';
      g.siegeDoms = [
        makeDominator(g, a.right * 0.44, -2600),
        makeDominator(g, a.right * 0.44, 2600)
      ];
      g.siegeDoms.forEach(function (d) { d.team = 'red'; paintTeamColors(d, 'red'); });
      g.mapDirty = true;
    },
    tick: function (g) {
      for (var i = 0; i < g.siegeDoms.length; i++) if (!g.siegeDoms[i].dead) tickPlatformAI(g, g.siegeDoms[i], 2400);
      g.labClock--;
      g.teamCounts = { blue: g.siegeLives, red: Math.max(0, Math.round(g.core.health / g.core.maxHealth * 100)) };
      if (g.tick % 25 === 0) setHud(g, 'SIEGE  ·  core ' + Math.max(0, Math.round(g.core.health)) + '  ·  ' + g.siegeLives + ' lives  ·  ' + clock(g.labClock));
      g.fx = { siege: g.core.health / g.core.maxHealth };
      if (g.roundEndsAt) return;
      if (g.core.dead || g.core.health <= 0) winRound(g, 'The Core is down — the attack wins!');
      else if (g.labClock <= 0 || g.siegeLives <= 0) winRound(g, 'The defence held — red wins!');
    },
    onTankDeath: function (g, victim) { if (victim.team === 'blue') g.siegeLives--; },
    reset: function (g) { g.siegeSwap = !g.siegeSwap; labReset(g, 'siege'); },
    botGoal: function (g, t) {
      if (t.team !== 'blue' || !g.core || g.core.dead || !botGrown(t, 15)) return null;
      return { e: g.core };
    }
  }
});

labMode('gauntlet', {
  name: 'Closer Gauntlet', family: 'Asymmetry', tag: 'unwinnable',
  blurb: 'No objective. The Arena Closers come in ninety seconds and never stop. Score is how long you last.',
  rules: { shapes: 600, bots: 30 },
  fx: true,
  how: [
    'Ninety seconds to level up and pick a class. Then the ring closes.',
    'Arena Closers are invincible, one-shot on contact, pass straight through walls and see invisible — a Stalker cannot wait one out.',
    'Fourteen of them spawn on a circle outside the field and sweep inward, and more arrive every forty seconds.',
    'Spawn protection is waived here: the sweep is the point of the mode.',
    'One life. The moment the first wave spawns the respawn button goes away, for you and for the bots.',
    'Your score is the time you survived. When the last tank is gone the arena restarts.',
    'These exist in the base game only when a server is being retired, which is a waste of the best entity in the codebase.'
  ],
  logic: {
    init: function (g) {
      g.gauntletAt = g.tick + 90 * TPS; g.gauntletWave = 0; g.gauntletStart = g.tick;
      g.noRespawn = false;
    },
    onSpawn: function (g, t) { if (g.gauntletWave > 0) t.protectedUntil = 0; },
    tick: function (g) {
      var i, alive = 0, list = labTanks(g);
      alive = list.length;
      if (g.tick >= g.gauntletAt) {
        g.gauntletAt = g.tick + 40 * TPS;
        g.gauntletWave++;
        // Once the sweep starts there is no coming back. Respawning into an
        // unwinnable chase is not a second chance, it is a shorter one.
        if (!g.noRespawn) { g.noRespawn = true; g.botCount = 0; g.mapDirty = true; }
        var a = g.arena, count = 6 + g.gauntletWave * 2, radius = a.size * Math.SQRT1_2 + 3000;
        for (i = 0; i < count; i++) {
          var ang = (i / count) * Math.PI * 2 + Math.random() * 0.3;
          g.add(makeArenaCloser(g, Math.cos(ang) * radius, Math.sin(ang) * radius, ang + Math.PI));
        }
        g.notify(g.gauntletWave === 1 ? 'THE CLOSERS ARE COMING' : 'More closers inbound — wave ' + g.gauntletWave, 90);
        g.fx = { closers: g.tick };
      }
      var lived = (g.tick - g.gauntletStart) / TPS;
      if (g.tick % 25 === 0) setHud(g, g.gauntletWave ? 'GAUNTLET  ·  ' + clock((g.tick - g.gauntletStart)) + ' survived  ·  ' + alive + ' left'
        : 'GAUNTLET  ·  closers in ' + clock(g.gauntletAt - g.tick));
      if (g.roundEndsAt) return;
      if (g.gauntletWave > 0 && alive === 0) winRound(g, 'Everything swept. Best time: ' + lived.toFixed(1) + 's');
    },
    reset: function (g) {
      for (var i = 0; i < g.entities.length; i++) if (g.entities[i].isCloser) g.entities[i].dead = true;
      g.entities = g.entities.filter(function (e) { return !e.isCloser; });
      labReset(g, 'gauntlet');
    },
    botGoal: function () { return null; }
  }
});

labMode('bossroyale', {
  name: 'Boss Royale', family: 'Asymmetry', tag: 'spectacle',
  rules: { shapes: 300, bots: 12 },
  blurb: 'Nobody plays a tank. Everybody drives one of the five bosses, and none of them were built to fight each other.',
  fx: true,
  how: [
    'On spawn you are put straight inside a boss hull \u2014 Guardian, Summoner, Fallen Overlord, Fallen Booster or Defender, chosen at random.',
    'You drive it with WASD and the mouse exactly like a tank. Press H to step out if you want your own hull back.',
    'No levelling, no upgrades, no stats. The hull is the build.',
    'A bot inside a boss lets the boss fly itself, so an unpiloted Guardian still hunts you.',
    'Die and you come back in a different one, so a round shows you all five.',
    'Guardian outruns everything, Summoner floods the field with necro drones, Defender turtles behind traps.',
    'It will never be balanced. That is not what it is for.'
  ],
  logic: {
    init: function (g) { g.royaleSeat = 0; },
    onSpawn: function (g, t) {
      // Everyone gets their own colour band. possess() asks whether the hull is
      // "mine", and in a team-less arena everybody would have shared one — so
      // each driver gets a private team of one, which also keeps them hostile.
      t.team = 'seat' + (++g.royaleSeat);
      var spec = BOSSES[(Math.random() * BOSSES.length) | 0];
      var b = new Boss(g, spec);
      b.modeEntity = true;
      b.team = t.team;
      b.x = t.x; b.y = t.y; b.px = b.x; b.py = b.y;
      b.name = (t.name || 'Someone') + "'s " + spec.name;
      var pal = [[C.blue, C.blueS], [C.red, C.redS], [C.green, C.greenS], [C.purple, C.purpleS],
        [C.crasher, C.crasherS], [C.square, C.squareS]][g.royaleSeat % 6];
      b.fill = pal[0]; b.stroke = pal[1];
      g.add(b);
      if (!possess(g, t, b)) { b.dead = true; b.deathFrame = 0; return; }
      t.royaleSeat = b;
      t.notify('You are ' + spec.name + ' \u2014 press H to step out', 100);
    },
    tick: function (g) {
      // A hull whose driver stepped out or died is furniture. Sweep it, and put
      // the driver back in a fresh one on the next respawn.
      for (var i = 0; i < g.entities.length; i++) {
        var e = g.entities[i];
        if (e.type !== 'boss' || !e.modeEntity || e.dead) continue;
        if (!e.possessedBy || e.possessedBy.dead) e.kill(null);
      }
      var seats = 0;
      for (i = 0; i < g.entities.length; i++) if (g.entities[i].type === 'boss' && !g.entities[i].dead) seats++;
      if (g.tick % 25 === 0) setHud(g, 'BOSS ROYALE  \u00b7  ' + seats + ' hull' + (seats === 1 ? '' : 's') + ' on the field');
    },
    reset: function (g) { g.royaleSeat = 0; labReset(g, 'bossroyale'); },
    botGoal: function () { return null; }
  }
});

// =========================================================================
// Family: physics
// =========================================================================

labMode('sumo', {
  name: 'Sumo', family: 'Physics', tag: 'ring out',
  rules: { dmgMult: 0, spawnLevel: 45, shapes: 0, regen: 3, bots: 39 },
  size: 12000,
  blurb: 'Bullets do no damage at all — only knockback. The ring shrinks. Step outside it and you are gone.',
  fx: true,
  how: [
    'Damage is multiplied by zero. Knockback is untouched, because it is applied separately from damage.',
    'Forty tanks start in the ring, every one of them level 45 with upgrade cards waiting \u2014 pick your class on the way in.',
    'There are no shapes on the floor at all.',
    'The ring shrinks steadily. Cross the line and you are eliminated instantly.',
    'Nobody dies to attrition, so there is no death spiral — a round is two minutes and the loser had a good two minutes.',
    'The class tree becomes a sumo meta: a Destroyer shell is a cannon shove, Booster recoil is a dash, and Smasher is a wall that cannot be moved.',
    'Ring-outs are the only elimination, so a round always ends.'
  ],
  logic: {
    init: function (g) { g.ring = 5200; g.noRespawn = false; g.sumoStart = g.tick + 5 * TPS; },
    tick: function (g) {
      var list = labTanks(g), i, alive = 0, last = null;
      if (g.tick > g.sumoStart && g.ring > 900) g.ring -= 1.6;
      for (i = 0; i < list.length; i++) {
        var t = list[i];
        if (Math.hypot(t.x, t.y) > g.ring + t.size) {
          if (g.tick > g.sumoStart) { t.applyDamage(1e9, null); g.notify((t.name || 'Someone') + ' went over the edge!', 50); continue; }
          // before the bell, shove them back in rather than killing them
          var a = Math.atan2(t.y, t.x);
          t.x = Math.cos(a) * g.ring * 0.9; t.y = Math.sin(a) * g.ring * 0.9;
        }
        alive++; last = t;
      }
      g.fx = { ring: g.ring };
      if (g.tick % 25 === 0) setHud(g, 'SUMO  ·  ring ' + Math.round(g.ring) + '  ·  ' + alive + ' in');
      if (g.roundEndsAt || alive > 1) return;
      winRound(g, last ? (last.name || 'An unnamed tank') + ' is the last one standing!' : 'The ring is empty.');
    },
    reset: function (g) { labReset(g, 'sumo'); },
    // Shove whoever is closest to the edge — that is the whole game.
    botGoal: function (g, t) {
      var list = labTanks(g), best = null, bestD = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] === t) continue;
        var d = Math.hypot(list[i].x, list[i].y);
        if (d > bestD) { bestD = d; best = list[i]; }
      }
      return best ? { e: best } : null;
    }
  }
});

labMode('diepball', {
  name: 'Diep Ball', family: 'Physics', tag: 'football',
  teams: ['blue', 'red'],
  rules: { shapes: 0, spawnLevel: 30, bots: 11 },
  size: 14000,
  blurb: 'Two teams, one enormous neutral ball, two goals. Shoot it, ram it, push it home. Kills score nothing.',
  fx: true,
  how: [
    'A heavy neutral ball sits at the centre. It takes no damage and deals none — it only takes knockback.',
    'It is a ball and nothing else: no barrels, no turret, no health bar, and it does not drift on its own. It sits where it was last kicked and spins in the direction it is rolling, with stitched panels so it reads as a football rather than a big polygon.',
    'Bullets, bodies, drones and traps all push it. Nothing else in the arena does.',
    'Get it into the goal mouth at the far end. First team to five.',
    'Kills are worthless and you respawn in a few seconds, so shooting people is a way of moving them, not of winning.',
    'Every class pushes differently: a Streamliner nudges, a Destroyer punts it half the pitch, a Booster body-checks it.',
    'It is the only mode here where being bad at aiming at people does not stop you being useful.'
  ],
  logic: {
    init: function (g) {
      var a = g.arena;
      // A Shape rather than a bare Entity: step() dispatches on type, and only
      // Shape has a tick. Everything else about it is overridden here.
      g.ball = new Shape(g, 'alpha', 0, 0);
      g.ball.sides = 1; g.ball.size = g.ball.baseSize = 210;
      g.ball.fill = '#F0F0F0'; g.ball.stroke = '#B4B4B4';
      g.ball.maxHealth = Infinity; g.ball.health = Infinity;
      g.ball.damageReduction = 0; g.ball.damagePerTick = 0;
      g.ball.absorb = 2.6;                       // shoved easily...
      g.ball.push = 3;                           // ...but does not throw tanks around
      g.ball.hiddenHealthbar = true; g.ball.modeEntity = true; g.ball.isBall = true;
      g.ball.scoreReward = 0; g.ball.isCrasher = false;
      g.ball.kind = 'ball';
      // A Shape only for the sake of step()'s dispatch. Its own tick is idle
      // drift and edge steering, which is wrong for something that should sit
      // exactly where it was last kicked.
      g.ball.tick = function () { this.angle += Math.hypot(this.vx, this.vy) * 0.01; };
      g.add(g.ball);
      g.goals = [
        labRect(g, { x: a.left + 340, y: 0, w: 340, h: 1500, team: 'blue' }),
        labRect(g, { x: a.right - 340, y: 0, w: 340, h: 1500, team: 'red' })
      ];
      g.goals.forEach(function (gl, i) { paintTeamColors(gl, g.teams[i]); gl.isGoal = true; });
      g.ballScore = { blue: 0, red: 0 };
      g.ballReset = 0;
      g.mapDirty = true;
    },
    tick: function (g) {
      var b = g.ball;
      if (g.ballReset > 0) { if (--g.ballReset === 0) { b.x = b.y = b.vx = b.vy = 0; } }
      else {
        for (var i = 0; i < g.goals.length; i++) {
          if (!insideRect(b, g.goals[i], b.size * 0.4)) continue;
          // you score in the goal you are attacking, which is the other side's
          var scorer = g.goals[i].team === 'blue' ? 'red' : 'blue';
          g.ballScore[scorer]++;
          g.notify(teamLabel(scorer) + ' scores!  ' + g.ballScore.blue + ' - ' + g.ballScore.red, 80);
          g.ballReset = 2 * TPS;
          g.fx = { goal: g.tick, side: scorer };
          break;
        }
      }
      // A ball parked in a corner ends the game; nudge it back toward the middle.
      if (Math.abs(b.x) > g.arena.right * 0.95 || Math.abs(b.y) > g.arena.bottom * 0.9) b.addVelocity(Math.atan2(-b.y, -b.x), 0.5);
      g.teamCounts = g.ballScore;
      if (g.tick % TPS === 0) g.mapDirty = true;
      if (g.tick % 25 === 0) setHud(g, 'DIEP BALL  ·  ' + g.ballScore.blue + ' - ' + g.ballScore.red);
      if (g.roundEndsAt) return;
      if (g.ballScore.blue >= 5) winRound(g, 'Blue wins 5 - ' + g.ballScore.red + '!');
      else if (g.ballScore.red >= 5) winRound(g, 'Red wins 5 - ' + g.ballScore.blue + '!');
    },
    reset: function (g) { labReset(g, 'diepball'); },
    // Get behind the ball and push it the right way, rather than standing on it.
    botGoal: function (g, t) {
      if (!g.ball || !t.team) return null;
      var goal = g.goals[t.team === 'blue' ? 1 : 0];
      var ang = Math.atan2(g.ball.y - goal.y, g.ball.x - goal.x);
      return { x: g.ball.x + Math.cos(ang) * 420, y: g.ball.y + Math.sin(ang) * 420, vx: 0, vy: 0, touch: true, hard: true };
    }
  }
});

labMode('grandprix', {
  name: 'Grand Prix', family: 'Physics', tag: '2 laps',
  // Max movement speed on every car, so a lap is about a minute rather than
  // whatever the roll gave you.
  rules: { shapes: 0, spawnLevel: 30, bots: 5, dmgMult: 0.28,
    forceStats: [7, 4, 3, 4, 5, 0, 7, 3] },
  size: 15000,
  blurb: 'A walled circuit, five rivals, two laps and a standing start. Weapons are live and knocking the leader off the line is entirely legal.',
  fx: true,
  how: [
    'The arena is an actual race track: an outer wall, an infield block you cannot cut across, and four chicanes in the straights.',
    'Six cars on the grid — you and five rivals — lined up on the start line and held there.',
    'A five-second countdown, then GO. Nobody can move until the lights go out.',
    'Eight gates sit on the racing line and must be taken in order. Cutting a corner does not count, and the wall stops you trying.',
    'Two laps of a 25,000-unit circuit. Your gate and lap are called out on your own screen as you pass each one.',
    'Weapons are live, but they hit at less than a third of normal — a shot shoves you off the line and chips you rather than deleting you, because this is a race.',
    'Dying puts you back at your last gate with your lap count intact, so a race is never over.',
    'Every car is on maximum movement speed, so the field is even and a lap is about a minute.',
    'The bots race properly here: their steering is driven straight down the racing line rather than left to the ordinary target-weighing AI, which treated the next gate as one option among several and stopped to fight. Their aim and their trigger are still the ordinary AI, so they shoot at you on the way past.'
  ],
  logic: {
    init: function (g) {
      // Corridor perimeter about 26,000 units, which at a level-25 tank's
      // terminal speed is roughly a minute a lap — three laps is a race, not
      // an errand.
      var OX = 6200, OY = 4400, T = 380;      // outer box and wall thickness
      var IX = 3300, IY = 1900;               // the infield you cannot cross
      g.gates = []; g.raceLaps = 2;
      labWall(g, 0, -OY, OX + T, T); labWall(g, 0, OY, OX + T, T);
      labWall(g, -OX, 0, T, OY); labWall(g, OX, 0, T, OY);
      labWall(g, 0, 0, IX, IY, '#A8A8A8', '#7E7E7E');
      // four chicanes, alternating sides, so the straights are not flat out
      labWall(g, -2200, -OY + T * 2.3, 560, 200);
      labWall(g, 2200, OY - T * 2.3, 560, 200);
      labWall(g, -OX + T * 2.3, 1800, 200, 560);
      labWall(g, OX - T * 2.3, -1800, 200, 560);
      // the racing line: an oval through the middle of the corridor
      var RX = (OX + IX) / 2, RY = (OY + IY) / 2;
      g.raceRX = RX; g.raceRY = RY;
      for (var i = 0; i < 8; i++) {
        var a = Math.PI * 2 * (i / 8) - Math.PI / 2;
        var m = labMark(g, { x: Math.cos(a) * RX, y: Math.sin(a) * RY, size: 260, sides: 6,
          fill: i === 0 ? '#FFDE43' : '#8FE3FF', stroke: i === 0 ? '#BFA732' : '#5FA8C4' });
        m.gateIndex = i;
        g.gates.push(m);
      }
      g.gridX = 0; g.gridY = -RY;
      g.raceProgress = g.raceProgress || {};
      g.raceStart = g.tick + 6 * TPS;
      g.mapDirty = true;
    },
    onSpawn: function (g, t) {
      var saved = g.raceProgress[t.name];
      if (g.tick < g.raceStart) {           // on the grid, in a staggered line
        var n = labPlayers(g).length;
        t.x = g.gridX - 700 + (n % 3) * 700;
        t.y = g.gridY + Math.floor(n / 3) * 460;
        t.raceGate = 0; t.raceLap = 0;
      } else {
        // Coming back mid-race resumes where the driver was, not where the
        // hull was — a bot respawns as a brand new Tank and the lap count
        // would otherwise die with the old one.
        t.raceGate = saved ? saved.gate : 0;
        t.raceLap = saved ? saved.lap : 0;
        var gt = g.gates[(t.raceGate - 1 + g.gates.length) % g.gates.length];
        t.x = gt.x; t.y = gt.y;
      }
      t.px = t.x; t.py = t.y;
      g.raceProgress[t.name] = { gate: t.raceGate, lap: t.raceLap };
    },
    tick: function (g) {
      var list = labTanks(g), i, best = null;
      // the lights
      if (g.tick < g.raceStart) {
        var left = g.raceStart - g.tick;
        for (i = 0; i < list.length; i++) { list[i].immobile = true; list[i].vx = list[i].vy = 0; }
        if (left % TPS === 0) g.notify(left / TPS <= 3 ? String(Math.ceil(left / TPS)) : 'Get ready...', TPS);
        g.fx = { race: true, lights: Math.ceil(left / TPS) };
        if (g.tick % 25 === 0) setHud(g, 'GRAND PRIX  \u00b7  starts in ' + clock(left));
        return;
      }
      if (g.raceStart === g.tick) { g.notify('GO!', 40); }
      for (i = 0; i < list.length; i++) {
        var t = list[i];
        t.immobile = false;
        if (t.raceGate === undefined) { t.raceGate = 0; t.raceLap = 0; }
        var want = g.gates[t.raceGate];
        if (want && touching(t, want, 90)) {
          t.raceGate = (t.raceGate + 1) % g.gates.length;
          g.raceProgress[t.name] = { gate: t.raceGate, lap: t.raceLap + (t.raceGate === 0 ? 1 : 0) };
          if (t.raceGate === 0) {
            t.raceLap++;
            t.notify('Lap ' + t.raceLap + '/' + g.raceLaps, 70);
            if (t.raceLap >= g.raceLaps && !g.roundEndsAt) {
              g.snapshotPodium((t.name || 'An unnamed tank') + ' takes the chequered flag!');
              winRound(g, (t.name || 'An unnamed tank') + ' takes the chequered flag!');
            }
          } else t.notify('Gate ' + t.raceGate + '/' + g.gates.length, 45);
        }
        var prog = (t.raceLap || 0) * g.gates.length + (t.raceGate || 0);
        if (!best || prog > best.prog) best = { t: t, prog: prog };
      }
      g.fx = { race: true, lights: 0 };
      if (g.tick % 25 === 0) setHud(g, best
        ? 'GRAND PRIX  \u00b7  leader ' + (best.t.name || '?') + '  lap ' + Math.min(g.raceLaps, (best.t.raceLap || 0) + 1) + '/' + g.raceLaps
        : 'GRAND PRIX');
    },
    reset: function (g) {
      var list = labTanks(g);
      for (var i = 0; i < list.length; i++) { list[i].raceGate = 0; list[i].raceLap = 0; list[i].immobile = false; }
      g.raceProgress = {};
      labReset(g, 'grandprix');
    },
    // Nobody creeps off the grid, and once the lights go out they actually
    // race. Left to the ordinary AI they treat the gate as one option among
    // several and stop to fight — a lap took five minutes.
    botDrive: function (g, t) {
      if (g.tick < g.raceStart) { botHalt(t); t.input.fire = 0; return; }
      if (!g.gates) return;
      // Follow the racing line, not the gate. Steering straight at a gate aims
      // through the infield for half of every lap, and a bot pinned against the
      // wall does not get any faster the harder it pushes. The line is an oval,
      // so a point a little further round it is always inside the corridor.
      var th = Math.atan2(t.y / g.raceRY, t.x / g.raceRX) + 0.42;
      botDriveTo(t, Math.cos(th) * g.raceRX, Math.sin(th) * g.raceRY, 40);
      t.autoFire = true;                        // aim stays with the ordinary AI
    },
    // Drive the line. `hard` keeps them on the goal rather than wandering off
    // after a polygon, and there are no polygons here anyway.
    botGoal: function (g, t) {
      if (!g.gates) return null;
      if (g.tick < g.raceStart) return null;
      var want = g.gates[t.raceGate || 0];
      if (!want) return null;
      // Aim a little past the gate so they carry speed through it instead of
      // braking onto it, which is the difference between a racing line and a
      // series of stops.
      var next = g.gates[((t.raceGate || 0) + 1) % g.gates.length];
      return { x: want.x * 0.75 + next.x * 0.25, y: want.y * 0.75 + next.y * 0.25,
        vx: 0, vy: 0, touch: true, hard: true };
    }
  }
});

labMode('redlight', {
  name: 'Red Light, Green Light', family: 'Physics', tag: 'do not move',
  rules: { shapes: 0, spawnLevel: 20, bots: 40 },
  size: 16000,
  blurb: 'Green, run. Red, freeze — but you get two seconds to stop. First one across the far line wins.',
  fx: true,
  how: [
    'Forty-one tanks start against the west wall. The finish is a green line at the east wall.',
    'The light alternates on a random interval and flashes before it changes, so you always get a warning.',
    'When it turns red you have a full two seconds of grace to come to a stop. Only after that does moving kill you.',
    'What counts as moving is a key held down, not a number on a velocity vector \u2014 and while the light is not green nothing can shove you, so your own recoil and a stray bullet can no longer break the rule for you.',
    'The grace is generous on purpose \u2014 at 25 Hz with 10% damping a tank still drifts for a moment after you let go of the key, and dying to that is not a game.',
    'Bullets do nothing here. The light is the only thing that can kill you.',
    'Bots play it properly: they sprint on green, brake the instant the warning shows, and sit dead still through the whole red.',
    'First tank across the line wins the round.'
  ],
  logic: {
    init: function (g) {
      var a = g.arena;
      g.lightGreen = true;
      g.lightAt = g.tick + 5 * TPS;
      g.redAt = 0;
      g.finish = labRect(g, { x: a.right - 500, y: 0, w: 400, h: a.size / 2, fill: '#85E8A0', stroke: '#5FAF74' });
      g.ruleOverride = { dmgMult: 0 };
    },
    onSpawn: function (g, t) {
      t.x = g.arena.left + 600 + Math.random() * 400;
      t.y = (Math.random() - 0.5) * g.arena.size * 0.8;
      t.px = t.x; t.py = t.y;
    },
    tick: function (g) {
      var list = labTanks(g), i, t;
      if (g.tick >= g.lightAt) {
        g.lightGreen = !g.lightGreen;
        if (!g.lightGreen) g.redAt = g.tick + 2 * TPS;    // the grace window
        g.lightAt = g.tick + (g.lightGreen ? 4 + Math.random() * 5 : 4 + Math.random() * 4) * TPS;
        g.notify(g.lightGreen ? 'GREEN LIGHT' : 'RED LIGHT \u2014 two seconds to stop', 40);
      }
      var warn = g.lightAt - g.tick < TPS * 1.5;
      var armed = !g.lightGreen && g.tick >= g.redAt;
      // While the light is not green nobody can be shoved. Recoil from your own
      // gun and a stray bullet were both enough to break the rule for you, which
      // made standing still a matter of luck rather than of nerve.
      for (i = 0; i < list.length; i++) {
        t = list[i];
        if (g.lightGreen) { if (t.frozenAbsorb !== undefined) { t.absorb = t.frozenAbsorb; t.frozenAbsorb = undefined; } }
        else if (t.frozenAbsorb === undefined) { t.frozenAbsorb = t.absorb; t.absorb = 0; }
      }
      if (armed) {
        for (i = 0; i < list.length; i++) {
          t = list[i];
          // Pressing a key is moving. A residual coast is not — the threshold
          // is there so you cannot line up a run and freewheel through the red.
          var pressing = t.input.up || t.input.down || t.input.left || t.input.right;
          if (pressing || Math.hypot(t.vx, t.vy) > 3) {
            t.applyDamage(1e9, null);
            g.notify((t.name || 'Someone') + ' moved.', 40);
          }
        }
      }
      for (i = 0; i < list.length; i++) if (insideRect(list[i], g.finish) && !g.roundEndsAt) {
        g.snapshotPodium((list[i].name || 'An unnamed tank') + ' made it across!');
        winRound(g, (list[i].name || 'An unnamed tank') + ' made it across!');
        break;
      }
      g.fx = { light: g.lightGreen ? 1 : 0, warn: warn, armed: armed,
        grace: g.lightGreen ? 0 : Math.max(0, (g.redAt - g.tick) / (2 * TPS)) };
      if (g.tick % 25 === 0) setHud(g, g.lightGreen ? 'GREEN LIGHT  \u00b7  run'
        : armed ? 'RED LIGHT  \u00b7  do not move' : 'RED LIGHT  \u00b7  stop now');
    },
    reset: function (g) { labReset(g, 'redlight'); },
    // Not a hint. On red, and from the moment the warning shows, a bot stops —
    // full stop, every tick, no negotiation with the rest of its brain.
    botDrive: function (g, t) {
      if (!g.lightGreen || g.lightAt - g.tick < TPS * 1.5) {
        botHalt(t);
        t.input.fire = 0; t.autoFire = false;    // recoil is movement too
      } else if (g.finish) botDriveTo(t, g.finish.x, t.y);
    },
    botGoal: function (g, t) {
      if (!g.lightGreen || g.lightAt - g.tick < TPS * 1.5) return null;
      return g.finish ? { x: g.finish.x, y: t.y, vx: 0, vy: 0, touch: true, hard: true } : null;
    }
  }
});

labMode('singularity', {
  name: 'Singularity', family: 'Physics', tag: 'growing',
  rules: { shapes: 900, bots: 40 },
  blurb: 'A black hole opens at the centre. It starts almost invisible and ends by swallowing the entire arena.',
  fx: true,
  how: [
    'The singularity begins as a 40-unit speck with almost no pull. You will not notice it for the first minute.',
    'It grows continuously for twelve minutes. Radius, reach and pull all scale together, so the map gets slowly, then suddenly, harder to stand in.',
    'Anything that crosses the event horizon is destroyed — tanks, bullets, drones and polygons alike.',
    'Bullets curve as they fly, so long-range classes have to lead into the well as well as onto the target.',
    'The pull is inverse-square inside the near field: far out it is a nudge, a body-length off the horizon it is not survivable.',
    'Once the horizon is half the width of the map, respawning is switched off for everybody \u2014 there is nowhere left to come back to.',
    'By the end it covers the whole arena and there is nowhere left. The round is who lasted longest.',
    'An accretion disc, lensing ring and infalling debris are all drawn from the live pull value, so what you see is what the physics is doing.'
  ],
  logic: {
    init: function (g) { g.singT = 0; g.noRespawn = false; },
    tick: function (g) {
      g.singT++;
      var life = 12 * 60 * TPS;
      var f = Math.min(1, g.singT / life);
      // cubic ramp: nearly nothing for the first third, then it runs away
      var grow = f * f * f;
      var radius = 40 + grow * (g.arena.size * 0.72);
      var reach = radius * 4 + 600 + grow * g.arena.size;
      var pull = 0.02 + grow * 2.4;
      g.singR = radius; g.singReach = reach; g.singPull = pull;

      for (var i = 0; i < g.entities.length; i++) {
        var e = g.entities[i];
        if (e.dead || e.type === 'wall' || e.type === 'base' || e.type === 'tile' || e.type === 'flag') continue;
        var d = Math.hypot(e.x, e.y);
        if (d < radius) { e.kill(null); continue; }
        if (d > reach) continue;
        // Inverse-square inside the near field, linear fade outside it. Far out
        // it is a nudge; a body-length off the horizon it is not survivable,
        // which is what an event horizon is supposed to mean.
        var near = radius * 2.6 + 500;
        var k = d < near
          ? pull * 14 * (near / d) * (near / d)
          : pull * 3 * (1 - (d - near) / Math.max(1, reach - near));
        e.addVelocity(Math.atan2(-e.y, -e.x), Math.max(0, k));
      }
      // Once it is half the width of the map there is nowhere left to spawn,
      // so the round becomes who is still standing rather than who respawns
      // into the well fastest.
      if (!g.noRespawn && radius * 2 >= g.arena.size * 0.5) {
        g.noRespawn = true;
        g.botCount = 0;
        g.notify('The horizon has taken half the map \u2014 no more respawns.', 4 * TPS);
        g.mapDirty = true;
      }
      g.fx = { sing: radius, reach: reach, pull: pull, f: f, sealed: !!g.noRespawn };
      if (g.tick % 25 === 0) setHud(g, 'SINGULARITY  \u00b7  r=' + Math.round(radius)
        + (g.noRespawn ? '  \u00b7  NO RESPAWN' : '') + '  \u00b7  ' + clock(life - g.singT));
      if (g.roundEndsAt) return;
      var alive = labTanks(g).length;
      if (f >= 1 || alive === 0) winRound(g, 'The singularity took everything.');
    },
    reset: function (g) { g.singT = 0; labReset(g, 'singularity'); },
    // Run outward. Not clever, but it is what a tank should be doing.
    botGoal: function (g, t) {
      if (!g.singR) return null;
      var d = Math.hypot(t.x, t.y);
      if (d > g.singR * 2.5) return null;
      var a = Math.atan2(t.y, t.x);
      return { x: Math.cos(a) * g.arena.right * 0.9, y: Math.sin(a) * g.arena.right * 0.9, vx: 0, vy: 0, touch: false, hard: true };
    }
  }
});

// =========================================================================
// Family: deception
// =========================================================================

var PROP_KINDS = ['square', 'triangle', 'pentagon'];

// A hiding map is the opposite of a diep arena. Diep is 22,300 units of open
// ground where the only cover is distance; hiding needs somewhere small enough
// to search and cluttered enough to search badly. This is 7,600 units across —
// a twentieth of the usual area — laid out as a walled village: eight buildings
// with doorways you have to find, four alley walls between them, a central
// plaza, and a great deal of furniture to be mistaken for.
var VILLAGE = { size: 7600, wall: 90 };

// One building: four walls with a gap in one of them for a door.
function villageHouse(g, x, y, w, h, door) {
  var T = VILLAGE.wall, gap = Math.min(w, h) * 0.55;
  var pal = ['#C4B7A8', '#9C8F80'];
  // top / bottom
  if (door === 0) { labWall(g, x - (w + gap) / 2, y - h, (w - gap) / 2, T, pal[0], pal[1]); labWall(g, x + (w + gap) / 2, y - h, (w - gap) / 2, T, pal[0], pal[1]); }
  else labWall(g, x, y - h, w, T, pal[0], pal[1]);
  if (door === 1) { labWall(g, x - (w + gap) / 2, y + h, (w - gap) / 2, T, pal[0], pal[1]); labWall(g, x + (w + gap) / 2, y + h, (w - gap) / 2, T, pal[0], pal[1]); }
  else labWall(g, x, y + h, w, T, pal[0], pal[1]);
  // left / right
  if (door === 2) { labWall(g, x - w, y - (h + gap) / 2, T, (h - gap) / 2, pal[0], pal[1]); labWall(g, x - w, y + (h + gap) / 2, T, (h - gap) / 2, pal[0], pal[1]); }
  else labWall(g, x - w, y, T, h, pal[0], pal[1]);
  if (door === 3) { labWall(g, x + w, y - (h + gap) / 2, T, (h - gap) / 2, pal[0], pal[1]); labWall(g, x + w, y + (h + gap) / 2, T, (h - gap) / 2, pal[0], pal[1]); }
  else labWall(g, x + w, y, T, h, pal[0], pal[1]);
}

// The whole map, plus the furniture. `clutter` is how many loose polygons get
// scattered through it — the crowd a prop disappears into.
function buildVillage(g, clutter) {
  var H = VILLAGE.size / 2, T = VILLAGE.wall * 2.2;
  setArenaSize(g, VILLAGE.size);
  // the outer wall
  labWall(g, 0, -H, H, T); labWall(g, 0, H, H, T);
  labWall(g, -H, 0, T, H); labWall(g, H, 0, T, H);
  // eight buildings in a ring, doors facing different ways
  var spots = [
    [-2350, -2200, 760, 620, 1], [0, -2500, 620, 480, 1], [2350, -2200, 760, 620, 1],
    [-2800, 0, 560, 820, 3], [2800, 0, 560, 820, 2],
    [-2350, 2200, 760, 620, 0], [0, 2500, 620, 480, 0], [2350, 2200, 760, 620, 0]
  ];
  for (var i = 0; i < spots.length; i++) villageHouse(g, spots[i][0], spots[i][1], spots[i][2], spots[i][3], spots[i][4]);
  // alley walls, so the ring is not one open loop
  labWall(g, -1200, -1150, 620, 70, '#B9AC9D', '#8E8172');
  labWall(g, 1200, -1150, 620, 70, '#B9AC9D', '#8E8172');
  labWall(g, -1200, 1150, 620, 70, '#B9AC9D', '#8E8172');
  labWall(g, 1200, 1150, 620, 70, '#B9AC9D', '#8E8172');
  // the plaza: a low block in the middle you can circle
  labWall(g, 0, 0, 520, 400, '#AEB9C4', '#828C96');

  // furniture. Enough that a prop is one of a crowd rather than one of three,
  // clumped rather than evenly spread, because a lone polygon in an empty
  // street is the first thing anybody shoots.
  for (i = 0; i < clutter; i++) {
    var cx = (Math.random() - 0.5) * VILLAGE.size * 0.86;
    var cy = (Math.random() - 0.5) * VILLAGE.size * 0.86;
    if (Math.random() < 0.7) {                       // clump around a seed point
      var sx = (Math.random() - 0.5) * VILLAGE.size * 0.8;
      var sy = (Math.random() - 0.5) * VILLAGE.size * 0.8;
      cx = sx + (Math.random() - 0.5) * 700; cy = sy + (Math.random() - 0.5) * 700;
    }
    if (g.inWall(cx, cy, 80)) continue;
    var sh = new Shape(g, pick(PROP_KINDS), cx, cy);
    sh.modeEntity = true;
    g.add(sh);
  }
  g.mapDirty = true;
}

// A spot in the village that is not inside a wall.
function villageSpot(g) {
  for (var i = 0; i < 60; i++) {
    var x = (Math.random() - 0.5) * VILLAGE.size * 0.82;
    var y = (Math.random() - 0.5) * VILLAGE.size * 0.82;
    if (!g.inWall(x, y, 90)) return { x: x, y: y };
  }
  return { x: 0, y: VILLAGE.size * 0.4 };
}

labMode('prophunt', {
  name: 'Prop Hunt', family: 'Deception', tag: 'hide in plain sight',
  teams: ['blue', 'red'],
  rules: { shapes: 0, spawnLevel: 22, bots: 19 },
  size: VILLAGE.size,
  blurb: 'A walled village barely a twentieth the size of a normal arena, three hundred polygons of clutter, and some of them are you.',
  fx: true,
  how: [
    'The map is custom and small: 7,600 units across, walled, with eight buildings you can walk into through a single doorway each, four alley walls, and a plaza block in the middle.',
    'Three hundred loose polygons are scattered through it in clumps rather than evenly, because a lone shape in an empty street is the first thing anybody shoots.',
    'Roles are drawn at random every round. Anybody can be a prop and anybody can be a hunter, and it is roughly four props to one hunter.',
    'Props are repainted as a Square, Triangle or Pentagon — real sides, real size, real colours, no name plate and no barrels — and they move at full speed. Hiding is about behaving like a shape, not about standing still.',
    'Props cannot fire. Right-click re-rolls your disguise instead, on a five-second cooldown, and it also moves you if you have been made.',
    'A prop that takes damage flashes its true colours, which is usually enough to get it killed.',
    'Hunters get a damage bonus and see invisible, but every shot that hits a genuine polygon costs 40 health. In a village with three hundred of them, spraying is fatal.',
    'Prop bots hold still and drift like furniture, and only shoot back when a hunter is right on top of them and clearly onto them.',
    'One life per round: found is out. Props win on a four-minute clock, hunters win by clearing the board.'
  ],
  logic: {
    init: function (g) {
      g.labClock = 4 * 60 * TPS;
      g.huntStart = g.tick + 20 * TPS;
      g.noRespawn = true;                    // found is out, for the round
      buildVillage(g, 300);
    },
    onSpawn: function (g, t) {
      // Roles are drawn, not assigned by arrival order — anybody can be either.
      var all = labPlayers(g), seekers = 0;
      for (var i = 0; i < all.length; i++) if (all[i].isSeeker) seekers++;
      var want = Math.max(1, Math.round(all.length / 5));
      var beSeeker = seekers < want && (Math.random() < 0.5 || seekers === 0);
      var spot = villageSpot(g);
      t.x = spot.x; t.y = spot.y; t.px = t.x; t.py = t.y;
      if (beSeeker) {
        t.team = 'red'; g.paintTeam(t);
        t.seesInvisible = true; t.damagePerTick += 6; t.isSeeker = true;
      } else {
        t.team = 'blue'; g.paintTeam(t);
        disguise(g, t);
      }
    },
    filterUpgrades: function () { return []; },
    tick: function (g) {
      var list = labTanks(g), i, hiders = 0, seekers = 0;
      for (i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.team === 'red') { seekers++; continue; }
        hiders++;
        t.hideName = true;
        t.input.fire = 0; t.autoFire = false;
        if ((t.input.altFire || t.reDisguise) && g.tick > (t.disguiseAt || 0) + 5 * TPS) {
          disguise(g, t); t.reDisguise = false;
          var mv = villageSpot(g);
          t.x = mv.x; t.y = mv.y; t.px = t.x; t.py = t.y;
        } else if (t.propKind && t.sides !== SHAPES[t.propKind].sides) reDisguise(t);
        if (t.hurtFlash > 0) { t.fill = C.blue; t.stroke = C.blueS; }
        else if (t.propKind) { var sp = SHAPES[t.propKind]; t.fill = sp.fill; t.stroke = sp.stroke; }
      }
      // A hunter that shoots a real polygon pays for it. A rule, not a hit, so
      // spawn protection cannot swallow the penalty.
      for (i = 0; i < g.entities.length; i++) {
        var e = g.entities[i];
        if (e.type !== 'shape' || !e.dead || e.propCharged) continue;
        e.propCharged = true;
        var k = e.lastHitBy;
        if (k && k.isSeeker && !k.dead) {
          k.health = Math.max(1, k.health - 40);
          k.hurtFlash = 4;
          k.notify('That was a real one. -40', 40);
        }
      }
      g.teamCounts = { blue: hiders, red: seekers };
      g.fx = { prop: true };
      if (g.tick < g.huntStart) {
        for (i = 0; i < list.length; i++) if (list[i].team === 'red') { list[i].input.fire = 0; list[i].autoFire = false; }
        if (g.tick % 25 === 0) setHud(g, 'PROP HUNT  \u00b7  hide  \u00b7  ' + clock(g.huntStart - g.tick));
        return;
      }
      g.labClock--;
      if (g.tick % 25 === 0) setHud(g, 'PROP HUNT  \u00b7  ' + hiders + ' hiding  \u00b7  ' + clock(g.labClock));
      if (g.roundEndsAt) return;
      if (hiders === 0 && seekers > 0) { g.snapshotPodium('Every prop found \u2014 the hunters win!'); winRound(g, 'Every prop found \u2014 the hunters win!'); }
      else if (g.labClock <= 0) { g.snapshotPodium(hiders + ' prop' + (hiders === 1 ? '' : 's') + ' survived'); winRound(g, hiders + ' prop' + (hiders === 1 ? '' : 's') + ' survived \u2014 the props win!'); }
    },
    reset: function (g) {
      var list = labTanks(g);
      for (var i = 0; i < list.length; i++) { undisguise(list[i]); list[i].isSeeker = false; list[i].seesInvisible = false; }
      g.noRespawn = false;
      labReset(g, 'prophunt');
    },
    // A prop bot behaves like furniture: it holds still, drifts a little, and
    // only breaks cover when a hunter is close enough to have made it. Left to
    // the ordinary AI it would strafe and dodge, which is the one thing no
    // polygon has ever done.
    botDrive: function (g, t) {
      if (t.team !== 'blue' || !t.propKind) return;
      var threat = nearestSeeker(g, t);
      if (threat && threat.d < 620) {
        // made: run for it, and shoot back only at this range
        botDriveTo(t, t.x + (t.x - threat.e.x), t.y + (t.y - threat.e.y), 20);
        return;
      }
      botHalt(t);
      // an idle shape drifts; a perfectly still one in a moving field is a tell
      if (g.tick % 90 < 30) { t.vx += Math.cos(t.id * 2.4) * 0.06; t.vy += Math.sin(t.id * 2.4) * 0.06; }
    },
    botGoal: function (g, t) {
      if (t.team !== 'blue') return null;
      var threat = nearestSeeker(g, t);
      return threat && threat.d < 900 ? { e: threat.e } : { x: t.x, y: t.y, vx: 0, vy: 0, touch: false, hard: true };
    }
  }
});

function nearestSeeker(g, t) {
  var list = labTanks(g), best = null, bd = Infinity;
  for (var i = 0; i < list.length; i++) {
    if (!list[i].isSeeker || list[i].dead) continue;
    var d = Math.hypot(list[i].x - t.x, list[i].y - t.y);
    if (d < bd) { bd = d; best = list[i]; }
  }
  return best ? { e: best, d: bd } : null;
}

function disguise(g, t) {
  var kind = pick(PROP_KINDS), s = SHAPES[kind];
  t.propKind = kind;
  t.disguiseAt = g.tick;
  t.realSides = t.realSides === undefined ? t.sides : t.realSides;
  t.sides = s.sides;
  t.propSize = s.size;
  t.fill = s.fill; t.stroke = s.stroke;
  t.hideName = true;
  t.hideBarrels = true;
  t.hiddenHealthbar = true;
  t.baseSize = s.size / Math.pow(1.01, t.level - 1);
  t.recompute();
}
// Put the current disguise back on after something reset the body — the same
// values as disguise(), minus the re-roll.
function reDisguise(t) {
  if (!t.propKind) return;
  var s = SHAPES[t.propKind];
  t.sides = s.sides;
  t.fill = s.fill; t.stroke = s.stroke;
  t.hideName = true; t.hideBarrels = true; t.hiddenHealthbar = true;
  t.baseSize = s.size / Math.pow(1.01, t.level - 1);
  t.recompute();
}

function undisguise(t) {
  if (t.realSides === undefined) return;
  t.sides = t.realSides;
  t.realSides = undefined;
  t.propKind = null;
  t.hideName = false; t.hideBarrels = false; t.hiddenHealthbar = false;
  t.baseSize = t.def.baseSizeOverride || (t.def.sides === 4 ? 32.5 * ROOT2 : t.def.sides === 16 ? 25 * ROOT2 : 50);
  t.recompute();
}

labMode('hideseek', {
  name: 'Hide and Seek', family: 'Deception', tag: 'invisible',
  teams: ['blue', 'red'],
  rules: { shapes: 0, spawnLevel: 30, bots: 19 },
  size: VILLAGE.size,
  blurb: 'The same walled village, but the hiders are invisible instead of disguised. Stand still and you are genuinely not there.',
  fx: true,
  how: [
    'The map is the village: 7,600 units, eight buildings with one doorway each, alleys, a plaza block, and two hundred polygons of clutter to break up a sightline.',
    'Roles are drawn at random every round — anybody can hide and anybody can seek, at roughly five hiders to one seeker.',
    'Hiders are locked to Stalker and Landmine. A Stalker fades in 1.3 seconds, a Landmine takes 13.3, and both are the real measured numbers.',
    'A fully faded tank is genuinely never transmitted to other clients, so hiding online is real and cannot be beaten by reading network traffic.',
    'Firing or moving fades you back in. Standing still is the only true camouflage, and the walls are what let you move at all.',
    'Seekers see invisible, move faster and carry a wide field of view.',
    'Hider bots pick a corner, sit in it and stay faded, and only run when a seeker is nearly on them.',
    'Opacity is floored at 25% in the last minute so a round always ends. Hiders win on the clock; seekers win by clearing the board.'
  ],
  logic: {
    init: function (g) {
      g.labClock = 4 * 60 * TPS;
      g.noRespawn = true;
      buildVillage(g, 200);
    },
    onSpawn: function (g, t) {
      var all = labPlayers(g), seekers = 0;
      for (var i = 0; i < all.length; i++) if (all[i].isSeeker) seekers++;
      var want = Math.max(1, Math.round(all.length / 6));
      var beSeeker = seekers < want && (Math.random() < 0.5 || seekers === 0);
      var spot = villageSpot(g);
      t.x = spot.x; t.y = spot.y; t.px = t.x; t.py = t.y;
      if (beSeeker) {
        t.team = 'red'; g.paintTeam(t);
        t.seesInvisible = true; t.isSeeker = true;
        labClass(t, 8, [7, 5, 5, 5, 5, 0, 5, 1]);
        t.movementSpeed *= 1.25;
      } else {
        t.team = 'blue'; g.paintTeam(t);
        t.isSeeker = false;
        labClass(t, Math.random() < 0.7 ? 63 : 41, [7, 4, 4, 4, 4, 0, 6, 3]);
      }
    },
    filterUpgrades: function () { return []; },
    tick: function (g) {
      var list = labTanks(g), i, hiders = 0, seekers = 0;
      var endgame = g.labClock < 60 * TPS;
      for (i = 0; i < list.length; i++) {
        if (list[i].team === 'red') { seekers++; continue; }
        hiders++;
        if (endgame && list[i].opacity < 0.25) list[i].opacity = 0.25;
      }
      g.teamCounts = { blue: hiders, red: seekers };
      g.labClock--;
      g.fx = { seek: endgame ? 1 : 0 };
      if (g.tick % 25 === 0) setHud(g, 'HIDE & SEEK  \u00b7  ' + hiders + ' hidden  \u00b7  ' + clock(g.labClock));
      if (g.roundEndsAt) return;
      if (hiders === 0 && seekers > 0) { g.snapshotPodium('All found \u2014 the seekers win!'); winRound(g, 'All found \u2014 the seekers win!'); }
      else if (g.labClock <= 0) { g.snapshotPodium(hiders + ' still hidden'); winRound(g, hiders + ' still hidden \u2014 the hiders win!'); }
    },
    reset: function (g) {
      var list = labTanks(g);
      for (var i = 0; i < list.length; i++) { list[i].isSeeker = false; list[i].seesInvisible = false; }
      g.noRespawn = false;
      labReset(g, 'hideseek');
    },
    // A hider bot holds absolutely still, because moving is what un-hides it.
    // It bolts only when a seeker is close enough to trip over it.
    botDrive: function (g, t) {
      if (t.team !== 'blue') return;
      var threat = nearestSeeker(g, t);
      if (threat && threat.d < 700) { botDriveTo(t, t.x + (t.x - threat.e.x), t.y + (t.y - threat.e.y), 20); return; }
      botHalt(t);
      t.input.fire = 0; t.autoFire = false;
    },
    botGoal: function (g, t) {
      if (t.team !== 'blue') return null;
      return { x: t.x, y: t.y, vx: 0, vy: 0, touch: false, hard: true };
    }
  }
});

labMode('nightfall', {
  name: 'Nightfall', family: 'Deception', tag: 'darkening',
  rules: { shapes: 900 },
  blurb: 'The lights go out slowly. Your field of view tightens over eight minutes until you can see almost nothing.',
  fx: true,
  how: [
    'The round opens in full daylight with normal vision.',
    'Over eight minutes the field of view contracts to a third and the darkness closes in around your tank.',
    'The tightening is applied to the actual view distance, not just the picture — you really cannot see them coming.',
    'Bot sight is scaled with it, so they go blind at the same rate you do.',
    'The minimap becomes the primary display, Predator\'s zoom becomes a scouting tool, and Stalker becomes the strongest class in the arena.',
    'At full dark the round ends on the highest score and the sun comes back up.'
  ],
  logic: {
    init: function (g) { g.nightT = 0; g.fovScale = 1; },
    tick: function (g) {
      var life = 8 * 60 * TPS;
      g.nightT++;
      var f = Math.min(1, g.nightT / life);
      g.fovScale = 1 - f * 0.68;
      g.dark = f;
      // Everyone's fov is derived, so it has to be recomputed as the sun sets.
      if (g.tick % 10 === 0) {
        var list = labTanks(g);
        for (var i = 0; i < list.length; i++) list[i].recompute();
      }
      g.fx = { night: f };
      if (g.tick % 25 === 0) setHud(g, 'NIGHTFALL  ·  ' + Math.round((1 - f) * 100) + '% light  ·  ' + clock(life - g.nightT));
      if (g.roundEndsAt || f < 1) return;
      var best = labLeader(g);
      winRound(g, (best ? (best.name || 'An unnamed tank') : 'Nobody') + ' survived the night.');
    },
    reset: function (g) { g.nightT = 0; g.fovScale = 1; g.dark = 0; labReset(g, 'nightfall'); },
    botGoal: function () { return null; }
  }
});

labMode('fog', {
  name: 'Fog of War', family: 'Deception', tag: 'blind',
  rules: { fov: 1.5, shapes: 900 },
  blurb: 'Two-thirds view distance, and a real fog bank rolling over the field. You find out about people by being shot.',
  fx: true,
  how: [
    'Field of view is reduced to two-thirds for everybody, permanently.',
    'A layered fog bank drifts across the arena and thickens in patches, so visibility is not even constant.',
    'A soft light falls off around your own tank, and muzzle flashes bloom through the murk — firing gives away roughly where you are.',
    'The minimap is the only reliable information you have, which makes it worth reading for the first time.',
    'Predator\'s right-click zoom stops being a novelty. Stalker becomes genuinely oppressive.',
    'Ambushes exist here. In the ordinary arena you can see anybody who could reach you.'
  ],
  logic: {
    init: function (g) { g.fogSeed = (Math.random() * 1000) | 0; },
    tick: function (g) {
      g.fx = { fog: 1, seed: g.fogSeed };
      if (g.tick % 25 === 0) setHud(g, 'FOG OF WAR');
    },
    reset: function (g) { labReset(g, 'fog'); }
  }
});

// =========================================================================
// Family: territory
// =========================================================================

labMode('koth', {
  name: 'King of the Hill', family: 'Territory', tag: 'hold it',
  teams: ['blue', 'red'],
  blurb: 'One zone worth standing in. Hold it uncontested to bank time. It moves every ninety seconds.',
  fx: true,
  how: [
    'A single hill sits somewhere on the map. Standing on it banks time for your team, one tick per tick.',
    'Contested means nobody banks — if both colours are inside, the clock stops dead.',
    'The hill relocates every ninety seconds, announced ten seconds ahead so there is a scramble rather than a teleport.',
    'First team to three banked minutes wins.',
    'The hill is the only scheduled fight in the game: everybody knows where it is and when, which means you can plan an approach.'
  ],
  logic: {
    init: function (g) {
      g.hill = labRect(g, { x: 0, y: 0, w: 1100, h: 1100, fill: '#FFDE43', stroke: '#BFA732' });
      g.hill.isHill = true;
      g.hillMove = g.tick + 90 * TPS;
      g.hillTime = { blue: 0, red: 0 };
      moveHill(g);
    },
    tick: function (g) {
      var list = labTanks(g), i, inside = { blue: 0, red: 0 };
      for (i = 0; i < list.length; i++) if (insideRect(list[i], g.hill)) inside[list[i].team] = (inside[list[i].team] || 0) + 1;
      var owner = inside.blue && !inside.red ? 'blue' : inside.red && !inside.blue ? 'red' : null;
      if (owner) g.hillTime[owner]++;
      paintTeamColors(g.hill, owner);
      if (!owner) { g.hill.fill = inside.blue && inside.red ? '#E8E8E8' : '#FFDE43'; g.hill.stroke = '#BFA732'; }

      if (g.tick >= g.hillMove) { moveHill(g); g.hillMove = g.tick + 90 * TPS; }
      else if (g.hillMove - g.tick === 10 * TPS) g.notify('The hill moves in 10 seconds', 60);

      g.teamCounts = { blue: Math.floor(g.hillTime.blue / TPS), red: Math.floor(g.hillTime.red / TPS) };
      g.fx = { hill: g.hill, owner: owner, contested: !!(inside.blue && inside.red) };
      if (g.tick % 25 === 0) setHud(g, 'KING OF THE HILL  ·  ' + clock(180 * TPS - g.hillTime.blue) + ' / ' + clock(180 * TPS - g.hillTime.red));
      if (g.roundEndsAt) return;
      for (i = 0; i < g.teams.length; i++) if (g.hillTime[g.teams[i]] >= 180 * TPS)
        winRound(g, teamLabel(g.teams[i]) + ' held the hill for three minutes — ' + teamLabel(g.teams[i]) + ' wins!');
    },
    reset: function (g) { labReset(g, 'koth'); },
    botGoal: function (g, t) { return g.hill && t.team ? botSpot(g.hill) : null; }
  }
});

function moveHill(g) {
  var a = g.arena;
  g.hill.x = (Math.random() - 0.5) * a.size * 0.62;
  g.hill.y = (Math.random() - 0.5) * a.size * 0.62;
  g.notify('The hill has moved!', 60);
  g.mapDirty = true;
}

labMode('payload', {
  name: 'Payload', family: 'Territory', tag: 'escort',
  teams: ['blue', 'red'], bases: true,
  rules: { bots: 24 },
  blurb: 'A slow armoured hulk crawls toward the enemy base while your team stands near it, and stops when contested.',
  fx: true,
  how: [
    'The payload starts in the middle and moves toward whichever team has more tanks within 900 units of it.',
    'Its speed scales with how many of you are escorting: one tank is a crawl, five is a march.',
    'Even numbers on both sides stop it dead, so a stalemate is a real state you can see.',
    'It shoots back with a Dominator gun, at whichever side does not currently hold it.',
    'The cart takes no damage and no knockback at all. It is a cart \u2014 shooting it only used to stall the round, and a single shove sent it further back than an escort could push it forward.',
    'Abandoned for twenty seconds it rolls slowly back to the middle, so a stalemate resolves instead of freezing.',
    'Push it 62% of the way to the enemy side to win. The whole map state is legible from the minimap alone.'
  ],
  logic: {
    init: function (g) {
      var a = g.arena;
      g.pay = makeDominator(g, 0, 0);
      g.pay.immobile = false;
      g.pay.name = 'Payload';
      // It is a cart, not a combatant. Shooting it did nothing but stall the
      // round, and knockback shoved it back down the track faster than an
      // escort could push it forward — so it takes neither.
      // Tank.tick rewrites damageReduction to 1 on every single tick unless
      // godMode is set — setting it once at build time lasted exactly one frame.
      // godMode also pins absorb at 0, which is the other half of what a cart needs.
      g.pay.godMode = true;
      g.pay.absorb = 0;
      g.pay.hiddenHealthbar = true;
      g.pay.isPayload = true;
      g.pay.health = g.pay.maxHealth = 20000;
      g.payGoal = { blue: a.right * 0.62, red: a.left * 0.62 };
      g.payHold = null;
      g.payIdle = 0;
    },
    tick: function (g) {
      var p = g.pay;
      if (!p || p.dead) return;
      tickPlatformAI(g, p, 2600);
      var list = labTanks(g), i, near = { blue: 0, red: 0 };
      for (i = 0; i < list.length; i++) if (Math.hypot(list[i].x - p.x, list[i].y - p.y) < 900) near[list[i].team] = (near[list[i].team] || 0) + 1;
      var owner = near.blue > near.red ? 'blue' : near.red > near.blue ? 'red' : null;
      g.payHold = owner;
      p.vx = p.vy = 0;                       // nothing external moves the cart
      if (owner) {
        g.payIdle = 0;
        var speed = Math.min(5.5, 1.6 + Math.abs(near.blue - near.red) * 0.9);
        p.x += (g.payGoal[owner] > p.x ? 1 : -1) * speed;
        p.y += (0 - p.y) * 0.02;             // it stays on its own track
        p.team = owner; paintTeamColors(p, owner);
      } else {
        p.team = null; paintTeamColors(p, null);
        // Abandoned for twenty seconds, it rolls back to the middle rather than
        // parking wherever the last stalemate left it.
        if (++g.payIdle > 20 * TPS) p.x += (0 - p.x) * 0.004;
      }
      var span = g.arena.right * 0.82;
      g.teamCounts = {
        blue: Math.round(Math.max(0, Math.min(1, (p.x + span) / (span * 2))) * 100),
        red: Math.round(Math.max(0, Math.min(1, (span - p.x) / (span * 2))) * 100)
      };
      if (g.tick % TPS === 0) g.mapDirty = true;
      g.fx = { payload: p, hold: owner, near: near };
      if (g.tick % 25 === 0) setHud(g, 'PAYLOAD  ·  ' + (owner ? teamLabel(owner) + ' pushing' : 'CONTESTED'));
      if (g.roundEndsAt) return;
      if (p.x >= g.payGoal.blue) winRound(g, 'Blue delivered the payload — blue wins!');
      else if (p.x <= g.payGoal.red) winRound(g, 'Red delivered the payload — red wins!');
    },
    reset: function (g) { labReset(g, 'payload'); },
    // Escort if you are pushing, block if you are not — standing on it is the
    // whole job either way, so both roles want the same spot for once.
    botGoal: function (g, t) {
      if (!g.pay || g.pay.dead || !t.team) return null;
      var goal = g.payGoal[t.team];
      var ahead = goal > g.pay.x ? -1 : 1;          // sit on the trailing side
      return { x: g.pay.x + ahead * 320, y: g.pay.y, vx: 0, vy: 0, touch: true, hard: true };
    }
  }
});

labMode('alphahunt', {
  name: 'Alpha Hunt', family: 'Territory', tag: 'last hit',
  rules: { shapes: 500 },
  blurb: 'Alpha Pentagons spawn one at a time, announced to the whole arena. Whoever lands the kill takes the point.',
  fx: true,
  how: [
    'Every ninety seconds one Alpha Pentagon spawns somewhere random with 3,000 health and a marker on everybody\'s minimap.',
    'Its health bar is visible arena-wide while it lives.',
    'Whoever lands the killing blow scores the point and gets the full 3,000 XP. Everybody else got exercise.',
    'First to five Alphas wins the round.',
    'Last-hit scoring rewards the leech on purpose — the knife fight at 5% health is the entire mode.'
  ],
  logic: {
    init: function (g) { g.alphaAt = g.tick + 20 * TPS; g.alpha = null; g.alphaScore = {}; },
    onTankDeath: function () {},
    tick: function (g) {
      if (g.alpha && g.alpha.dead) {
        var k = g.alpha.lastHitBy;
        if (k && k.name) {
          g.alphaScore[k.name] = (g.alphaScore[k.name] || 0) + 1;
          g.notify(k.name + ' took the Alpha! (' + g.alphaScore[k.name] + '/5)', 90);
          if (g.alphaScore[k.name] >= 5 && !g.roundEndsAt) winRound(g, k.name + ' hunted five Alphas — the hunt is over!');
        } else g.notify('The Alpha is down.', 60);
        g.alpha = null;
        g.alphaAt = g.tick + 90 * TPS;
        g.mapDirty = true;
      }
      if (!g.alpha && g.tick >= g.alphaAt) {
        var a = g.arena, ang = Math.random() * Math.PI * 2, r = a.right * (0.2 + Math.random() * 0.6);
        g.alpha = new Shape(g, 'alpha', Math.cos(ang) * r, Math.sin(ang) * r);
        g.alpha.modeEntity = true;
        g.add(g.alpha);
        g.notify('An ALPHA has spawned!', 100);
        g.fx = { alphaPing: g.tick };
        g.mapDirty = true;
      }
      if (g.tick % TPS === 0 && g.alpha) g.mapDirty = true;
      g.fx = { alpha: g.alpha && !g.alpha.dead ? g.alpha : null };
      if (g.tick % 25 === 0) setHud(g, g.alpha && !g.alpha.dead
        ? 'ALPHA HUNT  ·  ' + Math.max(0, Math.round(g.alpha.health)) + ' hp'
        : 'ALPHA HUNT  ·  next in ' + clock(g.alphaAt - g.tick));
    },
    reset: function (g) { g.alphaScore = {}; g.alpha = null; labReset(g, 'alphahunt'); },
    botGoal: function (g, t) {
      if (!g.alpha || g.alpha.dead || !botGrown(t, 15)) return null;
      return { e: g.alpha };
    }
  }
});

labMode('nestwars', {
  name: 'Nest Wars', family: 'Territory', tag: 'the middle',
  teams: ['blue', 'red'], bases: true, xp: 2,
  rules: { shapes: 1400 },
  blurb: 'The Pentagon Nest is the only place score exists. Two teams, one middle, no reason to be anywhere else.',
  fx: true,
  how: [
    'Shapes outside the nest ring are worth nothing at all. Inside it they are worth triple.',
    'The nest is stocked far heavier than normal, with Alphas and Hexagons in the deep middle.',
    'A pressure gradient falls out of it for free: the further in you push, the better the polygons and the worse your way out.',
    'First team to 250,000 combined score wins the round.',
    'It compresses a 22,300-unit map into one permanent battlefield without a single rule about where you may stand.'
  ],
  logic: {
    init: function (g) { g.nestR = g.arena.right * 0.28; g.nestScore = { blue: 0, red: 0 }; },
    tick: function (g) {
      // Keep the nest full: the ordinary spawner spreads across the whole map.
      if (g.tick % 12 === 0) {
        var n = 0;
        for (var i = 0; i < g.entities.length; i++) {
          var e = g.entities[i];
          if (e.type === 'shape' && !e.dead && Math.hypot(e.x, e.y) < g.nestR) n++;
        }
        if (n < 180) {
          var ang = Math.random() * Math.PI * 2, r = Math.random() * g.nestR;
          var deep = r < g.nestR * 0.35;
          var kind = deep ? (Math.random() < 0.2 ? 'alpha' : Math.random() < 0.5 ? 'hexagon' : 'pentagon') : 'pentagon';
          g.add(new Shape(g, kind, Math.cos(ang) * r, Math.sin(ang) * r));
        }
      }
      var list = labTanks(g);
      g.nestScore = { blue: 0, red: 0 };
      for (i = 0; i < list.length; i++) if (g.nestScore[list[i].team] !== undefined) g.nestScore[list[i].team] += list[i].score;
      g.teamCounts = { blue: Math.round(g.nestScore.blue / 1000), red: Math.round(g.nestScore.red / 1000) };
      g.fx = { nest: g.nestR };
      if (g.tick % 25 === 0) setHud(g, 'NEST WARS  ·  only the middle pays');
      if (g.roundEndsAt) return;
      for (i = 0; i < g.teams.length; i++) if (g.nestScore[g.teams[i]] >= 250000)
        winRound(g, teamLabel(g.teams[i]) + ' owns the nest — ' + teamLabel(g.teams[i]) + ' wins!');
    },
    reset: function (g) { labReset(g, 'nestwars'); },
    botGoal: function (g, t) {
      if (!t.team) return null;
      var d = Math.hypot(t.x, t.y);
      if (d < g.nestR) return null;
      var a = Math.atan2(t.y, t.x);
      return { x: Math.cos(a) * g.nestR * 0.6, y: Math.sin(a) * g.nestR * 0.6, vx: 0, vy: 0, touch: false, hard: false };
    }
  }
});

// Score only counts inside the nest, and triple. Hooked on the kill path,
// which is where a shape's payout is decided.
var _labShapeKill = Shape.prototype.kill;
Shape.prototype.kill = function (source) {
  var g = this.game;
  if (g.modeKey === 'nestwars' && !this.dead) {
    var inside = Math.hypot(this.x, this.y) < (g.nestR || 0);
    this.scoreReward = inside ? SHAPES[this.kind].score * 3 : 0;
  }
  return _labShapeKill.call(this, source);
};

labMode('roamdom', {
  name: 'Roaming Domination', family: 'Territory', tag: 'moving points',
  teams: ['blue', 'red'], bases: true, xp: 2,
  blurb: 'Four Dominators, exactly as dangerous as always, except now they walk. Hold all four at once.',
  fx: true,
  how: [
    'Four Dominators patrol slow looping routes instead of sitting bolted to the middle.',
    'Capture rules are unchanged: kill a neutral one to take it, and an enemy-held one must be knocked neutral first.',
    'They keep shooting while they move, and two drifting into each other is a fight nobody planned.',
    'Holding all four at the same instant wins, which is now a logistics problem rather than a parking exercise.',
    'Their positions refresh on the minimap once a second, so you can actually track them.'
  ],
  logic: {
    init: function (g) {
      MODE_LOGIC.domination.init(g);
      g.dominators.forEach(function (d, i) {
        d.immobile = false;
        d.roamA = Math.PI * 2 * (i / 4);
        d.roamR = 2600 + i * 700;
      });
    },
    tick: function (g) {
      for (var i = 0; i < g.dominators.length; i++) {
        var d = g.dominators[i];
        if (d.dead) continue;
        d.roamA += 0.0022 * (i % 2 ? -1 : 1);
        d.x = Math.cos(d.roamA) * d.roamR;
        d.y = Math.sin(d.roamA) * d.roamR;
        tickPlatformAI(g, d, 2200);
      }
      if (g.tick % TPS === 0) g.mapDirty = true;
      if (g.tick % 25 === 0) setHud(g, 'ROAMING DOMINATION');
      if (g.roundEndsAt) return;
      var owner = g.dominators[0].team;
      if (!owner) return;
      for (i = 1; i < g.dominators.length; i++) if (g.dominators[i].team !== owner) return;
      winRound(g, teamLabel(owner) + ' controls every Dominator — ' + teamLabel(owner) + ' wins!');
    },
    reset: function (g) { labReset(g, 'roamdom'); },
    botGoal: function (g, t) { return MODE_LOGIC.domination.botGoal(g, t); }
  }
});

labMode('bountyking', {
  name: 'Bounty King', family: 'Territory', tag: 'regicide',
  blurb: 'The leader wears a crown: marked, worth triple, and leaking score. Everybody in the arena wants it.',
  fx: true,
  how: [
    'Whoever is top of the leaderboard is crowned, once a second.',
    'The King is marked on everyone\'s minimap, gets a gold aura, and is registered as the arena bounty — bots will drop what they are doing and come.',
    'Killing the King hands over triple the usual share and the crown along with it.',
    'The crown leaks 0.4% of its score every second, so it cannot be held by hiding in a corner.',
    'The King gets 25% damage reduction, so a coronation is a fight rather than an execution.',
    'It fixes the arena going quiet at exactly the point it should be most interesting.'
  ],
  logic: {
    init: function (g) { g.king = null; },
    tick: function (g) {
      if (g.tick % TPS === 0) {
        var best = labLeader(g);
        if (best !== g.king) {
          if (g.king) { g.king.isKing = false; g.king.damageReduction = 1; }
          g.king = best;
          if (g.king) { g.king.isKing = true; g.notify((g.king.name || 'Someone') + ' wears the crown!', 70); }
          g.mapDirty = true;
        }
      }
      if (g.king && (g.king.dead || !g.king.isKing)) { g.king = null; g.bountyTarget = null; }
      if (g.king) {
        g.king.score = Math.max(0, g.king.score * (1 - 0.004 / TPS));
        g.bountyTarget = g.king;
        g.ruleOverride = { killShare: 0.75 };
      } else g.ruleOverride = null;
      g.fx = { king: g.king };
      if (g.tick % 25 === 0) setHud(g, g.king ? 'BOUNTY KING  ·  ' + (g.king.name || '?') + '  ' + Math.round(g.king.score) : 'BOUNTY KING');
    },
    reset: function (g) { g.king = null; labReset(g, 'bountyking'); },
    botGoal: function (g, t) {
      if (!g.king || g.king.dead || g.king === t || !botGrown(t, 15)) return null;
      return { e: g.king };
    }
  }
});

// =========================================================================
// Family: the arena
// =========================================================================

labMode('labyrinth', {
  name: 'Labyrinth Royale', family: 'The Arena', tag: 'one life',
  maze: true, size: MAZE.cells * MAZE.cell, freshStart: true,
  rules: { shapes: 700 },
  blurb: 'The maze, one life each, and the walls close in until the last two fight in a single room.',
  fx: true,
  how: [
    'The full 25,400-unit maze — forty by forty cells of proper corridors, and walls that eat anything fired at them.',
    'One life. Ten seconds on the clock, then the respawn button goes away.',
    'The boundary advances in whole cells so corridors stay corridors rather than dissolving into a circle.',
    'Blind corners mean a fight starts at two hundred units, and line of sight is honest — bots will not shoot you through a wall.',
    'Last tank standing wins and everyone comes back at level 1 for a new labyrinth.'
  ],
  logic: {
    init: function (g) {
      g.labyStart = g.tick + 10 * TPS;
      g.labyShrink = MAZE.cells * MAZE.cell;
      g.noRespawn = false;
    },
    tick: function (g) {
      var list = labTanks(g), alive = list.length, last = list[0] || null;
      if (g.tick < g.labyStart) {
        if ((g.labyStart - g.tick) % TPS === 0) g.notify('The maze closes in ' + Math.ceil((g.labyStart - g.tick) / TPS) + '...', TPS);
        if (g.tick % 25 === 0) setHud(g, 'LABYRINTH  ·  get ready');
        return;
      }
      if (!g.noRespawn) { g.noRespawn = true; g.botCount = 0; g.notify('One life. Last tank standing.', 3 * TPS); g.mapDirty = true; }
      if (g.tick % 20 === 0 && g.labyShrink > MAZE.cell * 6) {
        g.labyShrink -= MAZE.cell / 8;
        setArenaSize(g, Math.round(g.labyShrink));
      }
      g.fx = { laby: g.labyShrink };
      if (g.tick % 25 === 0) setHud(g, 'LABYRINTH  ·  ' + alive + ' left');
      if (g.roundEndsAt || alive > 1) return;
      winRound(g, last ? (last.name || 'An unnamed tank') + ' walked out of the maze!' : 'Nobody made it out.');
    },
    reset: function (g) { g.botCount = g.botCount || 40; labReset(g, 'labyrinth'); },
    botGoal: function () { return null; }
  }
});

labMode('musicaltiles', {
  name: 'Musical Tiles', family: 'The Arena', tag: 'the floor',
  rules: { shapes: 200, spawnLevel: 30 },
  size: 16000,
  blurb: 'The floor collapses tile by tile on a shrinking timer. Last tank on solid ground wins.',
  fx: true,
  how: [
    'The arena is a 10 x 10 grid of tiles and every one of them is standing at the start.',
    'A tile is chosen, flashes red for three seconds, then drops — killing anything on it.',
    'The interval between drops shortens as the board thins, so the last thirty seconds on four tiles is chaos.',
    'Drop order is uniformly random rather than centre-outward, so standing in the middle is not a strategy.',
    'Falling is the only way to die that matters; weapons are live but knocking someone onto a flashing tile is better.',
    'One life. Last tank on the floor takes it.'
  ],
  logic: {
    init: function (g) {
      var a = g.arena, n = 10, w = a.size / n / 2;
      g.mtiles = [];
      for (var cx = 0; cx < n; cx++) for (var cy = 0; cy < n; cy++) {
        var t = labRect(g, { x: a.left + w * (2 * cx + 1), y: a.top + w * (2 * cy + 1), w: w - 8, h: w - 8,
          fill: (cx + cy) % 2 ? '#C8C8C8' : '#BEBEBE', stroke: '#9A9A9A' });
        t.alive = true; t.warnAt = 0;
        g.mtiles.push(t);
      }
      g.mtNext = g.tick + 8 * TPS;
      g.noRespawn = true;
    },
    tick: function (g) {
      var i, standing = 0;
      for (i = 0; i < g.mtiles.length; i++) if (g.mtiles[i].alive) standing++;
      // drop cadence tightens as the floor runs out
      if (g.tick >= g.mtNext && standing > 1) {
        var live = g.mtiles.filter(function (t) { return t.alive && !t.warnAt; });
        if (live.length) {
          var pickT = live[(Math.random() * live.length) | 0];
          pickT.warnAt = g.tick + 3 * TPS;
          pickT.fill = '#F14E54'; pickT.stroke = '#B43A3F';
          g.mapDirty = true;
        }
        g.mtNext = g.tick + Math.max(6, Math.round(standing / 4)) * (TPS / 4);
      }
      for (i = 0; i < g.mtiles.length; i++) {
        var t = g.mtiles[i];
        if (!t.alive || !t.warnAt || g.tick < t.warnAt) continue;
        t.alive = false;
        t.sides = 0; t.fill = '#6E6E6E';
        var list = labTanks(g);
        for (var k = 0; k < list.length; k++) if (insideRect(list[k], t)) list[k].applyDamage(1e9, null);
        g.mapDirty = true;
      }
      // anyone standing on a hole falls
      var alive = labTanks(g);
      for (i = 0; i < alive.length; i++) {
        var on = tileUnder(g, alive[i]);
        if (!on || !on.alive) alive[i].applyDamage(1e9, null);
      }
      alive = labTanks(g);
      g.fx = { tiles: standing };
      if (g.tick % 25 === 0) setHud(g, 'MUSICAL TILES  ·  ' + standing + ' tiles  ·  ' + alive.length + ' left');
      if (g.roundEndsAt || alive.length > 1) return;
      winRound(g, alive[0] ? (alive[0].name || 'An unnamed tank') + ' had the last tile!' : 'The floor won.');
    },
    reset: function (g) { g.noRespawn = false; labReset(g, 'musicaltiles'); },
    // Head for the middle of the biggest patch of solid floor.
    botGoal: function (g, t) {
      var on = tileUnder(g, t);
      if (on && on.alive && !on.warnAt) return null;
      var safe = g.mtiles.filter(function (x) { return x.alive && !x.warnAt; });
      var best = botNearest(t, safe, function () { return true; });
      return best ? botSpot(best, true) : null;
    }
  }
});

function tileUnder(g, e) {
  for (var i = 0; i < g.mtiles.length; i++) if (insideRect(e, g.mtiles[i], 40)) return g.mtiles[i];
  return null;
}

labMode('portals', {
  name: 'Portals', family: 'The Arena', tag: 'shortcuts',
  rules: { shapes: 900 },
  blurb: 'Four linked pads scattered around the map. Touch one, come out of its partner, half a map away.',
  fx: true,
  how: [
    'Four portals sit in a ring, paired diagonally, so every jump crosses the whole arena.',
    'Tanks, bullets, drones and polygons all pass through — a Streamliner can shoot across the map through a pair.',
    'Each tank has a two-second cooldown after a jump, so you cannot sit in a loop.',
    'It edits the arena\'s distance graph without adding a single rule: escapes become possible, ambushes become possible, and camping an exit becomes a skill.',
    'Portals hum and spiral when something has just come through, so an ambush has a tell if you are watching.'
  ],
  logic: {
    init: function (g) {
      var a = g.arena, r = a.right * 0.6;
      g.portals = [];
      for (var i = 0; i < 4; i++) {
        var ang = Math.PI * 2 * (i / 4) + Math.PI / 4;
        var p = labMark(g, { x: Math.cos(ang) * r, y: Math.sin(ang) * r, size: 190, sides: 8,
          fill: i < 2 ? '#BF7FF5' : '#00E16E', stroke: i < 2 ? '#8F5FB7' : '#00A852' });
        p.pi = i; p.lastUse = 0;
        g.portals.push(p);
      }
    },
    tick: function (g) {
      for (var i = 0; i < g.entities.length; i++) {
        var e = g.entities[i];
        if (e.dead || e.modeEntity || e.type === 'wall' || e.type === 'base' || e.type === 'tile') continue;
        if (g.tick < (e.portalCool || 0)) continue;
        for (var p = 0; p < g.portals.length; p++) {
          var a = g.portals[p];
          if (!touching(e, a, -60)) continue;
          var b = g.portals[(p + 2) % 4];
          var dx = e.x - a.x, dy = e.y - a.y;
          e.x = b.x + dx; e.y = b.y + dy;
          e.px = e.x; e.py = e.y;          // no interpolation streak across the map
          e.portalCool = g.tick + 2 * TPS;
          a.lastUse = b.lastUse = g.tick;
          break;
        }
      }
      g.fx = { portals: g.portals };
      if (g.tick % 25 === 0) setHud(g, 'PORTALS');
    },
    reset: function (g) { labReset(g, 'portals'); }
  }
});

// =========================================================================
// Family: social
// =========================================================================

labMode('squads', {
  name: 'Squads', family: 'Social', tag: '4 x 5',
  teams: ['blue', 'green', 'purple', 'red'], freshStart: true,
  rules: { shapes: 700 },
  blurb: 'Four squads of five. One life each, no reinforcements, a shrinking field. Last squad standing.',
  how: [
    'Four colours, five tanks each, assigned at spawn and sticky for the round.',
    'One life apiece — the respawn button goes away ten seconds in.',
    'The field closes on whoever is left, exactly as Survival sizes itself.',
    'A team wipe is final, so a two-versus-five comeback is a real thing that happens.',
    'Dying early does not end your round: the spectator camera follows your killer, and your squad is still playing.'
  ],
  logic: {
    init: function (g) { g.squadStart = g.tick + 10 * TPS; g.noRespawn = false; },
    tick: function (g) {
      var list = labTanks(g), i, counts = {}, alive = 0;
      for (i = 0; i < g.teams.length; i++) counts[g.teams[i]] = 0;
      for (i = 0; i < list.length; i++) if (counts[list[i].team] !== undefined) { counts[list[i].team]++; alive++; }
      g.teamCounts = counts;
      if (g.tick < g.squadStart) {
        if ((g.squadStart - g.tick) % TPS === 0) g.notify('Squads deploy in ' + Math.ceil((g.squadStart - g.tick) / TPS) + '...', TPS);
        return;
      }
      if (!g.noRespawn) { g.noRespawn = true; g.botCount = 0; g.notify('One life per tank. Last squad standing.', 3 * TPS); g.mapDirty = true; }
      var want = Math.floor(25 * Math.sqrt(Math.max(1, alive))) * 100;
      if (want < g.arena.size) setArenaSize(g, Math.max(want, g.arena.size - 20));
      if (g.tick % 25 === 0) setHud(g, 'SQUADS  ·  ' + alive + ' alive');
      if (g.roundEndsAt) return;
      var live = g.teams.filter(function (t) { return counts[t] > 0; });
      if (live.length === 1) winRound(g, teamLabel(live[0]) + ' squad is the last one standing!');
      else if (live.length === 0 && alive === 0) winRound(g, 'Everyone is gone.');
    },
    reset: function (g) { g.botCount = 20; labReset(g, 'squads'); },
    botGoal: function () { return null; }
  }
});

labMode('duel', {
  name: 'Duel Bracket', family: 'Social', tag: 'tournament',
  rules: { shapes: 0, spawnLevel: 45, bots: 15 },
  size: 20000,
  blurb: 'A real single-elimination tournament. Walled pits, one match per pit, winners advance until one is left.',
  fx: true,
  how: [
    'Everybody in the arena is seeded into a single-elimination bracket at the start of the round.',
    'Pairs are dropped into their own walled pit and fight one-on-one. Byes are handled automatically for odd counts.',
    'Every duellist is level 45 with a full build, so a match is decided by class and hands, not by who farmed longer.',
    'Winners advance and are re-paired for the next round; losers watch, with the camera on the tank that beat them.',
    'There are no shapes and no third parties in a pit. Nothing interferes with a match.',
    'The final produces an actual champion, which is the one thing a scoreboard never does.'
  ],
  logic: {
    init: function (g) {
      g.bracket = null; g.duelRound = 0; g.duelPits = []; g.duelReady = g.tick + 12 * TPS;
    },
    tick: function (g) {
      var i;
      if (!g.bracket && g.tick >= g.duelReady) { seedBracket(g); return; }
      if (!g.bracket) {
        if (g.tick % 25 === 0) setHud(g, 'DUEL  ·  seeding in ' + clock(g.duelReady - g.tick));
        return;
      }
      // Resolve every pit whose match is over.
      var open = 0;
      for (i = 0; i < g.duelPits.length; i++) {
        var pit = g.duelPits[i];
        if (pit.done) continue;
        var aOK = pit.a && !pit.a.dead, bOK = pit.b && !pit.b.dead;
        if (aOK && bOK) { open++; holdInPit(g, pit); continue; }
        pit.done = true;
        pit.winner = aOK ? pit.a : bOK ? pit.b : null;
        if (pit.winner) {
          pit.winner.health = pit.winner.maxHealth;
          g.notify((pit.winner.name || 'Someone') + ' advances.', 70);
        }
      }
      if (!open) advanceBracket(g);
      if (g.tick % 25 === 0) setHud(g, 'DUEL  ·  round ' + g.duelRound + '  ·  ' + open + ' match' + (open === 1 ? '' : 'es') + ' live');
      g.fx = { duel: g.duelPits };
    },
    reset: function (g) { g.bracket = null; g.duelPits = []; labReset(g, 'duel'); },
    botGoal: function (g, t) {
      if (!t.duelPit || t.duelPit.done) return null;
      var foe = t.duelPit.a === t ? t.duelPit.b : t.duelPit.a;
      return foe && !foe.dead ? { e: foe } : null;
    }
  }
});

function seedBracket(g) {
  var list = labTanks(g);
  if (list.length < 2) { g.duelReady = g.tick + 5 * TPS; return; }
  g.bracket = list.slice();
  for (var i = g.bracket.length - 1; i > 0; i--) {   // shuffle the seeding
    var j = (Math.random() * (i + 1)) | 0, t = g.bracket[i]; g.bracket[i] = g.bracket[j]; g.bracket[j] = t;
  }
  g.duelRound = 0;
  advanceBracket(g);
}

function advanceBracket(g) {
  if (!g.bracket) return;
  var winners = [];
  for (var i = 0; i < g.duelPits.length; i++) if (g.duelPits[i].winner && !g.duelPits[i].winner.dead) winners.push(g.duelPits[i].winner);
  for (i = 0; i < g.duelPits.length; i++) {   // sweep the walls of the last round
    var pit = g.duelPits[i];
    pit.walls.forEach(function (w) { w.dead = true; w.deathFrame = 0; });
    g.walls = g.walls.filter(function (w) { return pit.walls.indexOf(w) === -1; });
  }
  g.entities = g.entities.filter(function (e) { return !e.isDuelWall; });
  g.duelPits = [];
  g.mapDirty = true;

  var field = g.duelRound === 0 ? g.bracket : winners;
  field = field.filter(function (t) { return t && !t.dead; });
  if (field.length <= 1 && g.duelRound > 0) {
    if (!g.roundEndsAt) winRound(g, field[0] ? (field[0].name || 'An unnamed tank') + ' wins the tournament!' : 'No champion.');
    g.bracket = null;
    return;
  }
  g.duelRound++;
  g.notify('Round ' + g.duelRound + ' — ' + field.length + ' left', 80);
  var pits = Math.ceil(field.length / 2), cols = Math.ceil(Math.sqrt(pits));
  var span = g.arena.size / cols, half = span / 2 - 200;
  for (i = 0; i < pits; i++) {
    var a = field[i * 2], b = field[i * 2 + 1] || null;
    var cx = g.arena.left + span * ((i % cols) + 0.5), cy = g.arena.top + span * (Math.floor(i / cols) + 0.5);
    var newPit = { a: a, b: b, cx: cx, cy: cy, r: half, walls: [], done: false, winner: null };
    if (!b) { newPit.done = true; newPit.winner = a; if (a) a.notify('Bye — you advance.', 70); g.duelPits.push(newPit); continue; }
    [[cx, cy - half, half, 40], [cx, cy + half, half, 40], [cx - half, cy, 40, half], [cx + half, cy, 40, half]]
      .forEach(function (w) {
        var e = new Entity(g, { type: 'wall', sides: 2, x: w[0], y: w[1], size: w[2], width: w[3],
          fill: C.box, stroke: C.boxS, maxHealth: Infinity, team: null });
        e.isSolidWall = true; e.damageReduction = 0; e.push = 1; e.absorb = 0;
        e.hiddenHealthbar = true; e.modeEntity = true; e.isDuelWall = true;
        g.walls.push(e); g.add(e);
        newPit.walls.push(e);
      });
    a.x = cx - half * 0.6; a.y = cy; a.duelPit = newPit; a.health = a.maxHealth;
    b.x = cx + half * 0.6; b.y = cy; b.duelPit = newPit; b.health = b.maxHealth;
    g.duelPits.push(newPit);
  }
  g.mapDirty = true;
}

// Duellists cannot leave their pit — walls stop tanks, but a knockback spike
// or a portal-shaped bug should not decide a tournament.
function holdInPit(g, pit) {
  [pit.a, pit.b].forEach(function (t) {
    if (!t || t.dead) return;
    var lim = pit.r - 80;
    t.x = Math.max(pit.cx - lim, Math.min(pit.cx + lim, t.x));
    t.y = Math.max(pit.cy - lim, Math.min(pit.cy + lim, t.y));
  });
}

labMode('bombtag', {
  name: 'Bomb Tag', family: 'Social', tag: 'hot potato',
  rules: { shapes: 400, spawnLevel: 30, dmgMult: 0 },
  size: 13000,
  blurb: 'One tank is holding a live bomb. Touch somebody to pass it. At zero it goes off and takes you with it.',
  fx: true,
  how: [
    'A bomb is handed to a random tank when the round starts. It has twenty seconds on it.',
    'Ramming anybody passes it to them — and the fuse does not reset, it keeps running.',
    'The last three seconds are counted down out loud and the carrier is drawn in a growing red pulse everyone can see.',
    'At zero the carrier is eliminated in a blast that also hurts anyone nearby, and a new bomb is armed on a fresh victim.',
    'Bullets do nothing here. The only way to survive is to reach somebody else.',
    'Last tank standing wins.'
  ],
  logic: {
    init: function (g) { g.bomb = null; g.bombFuse = 0; g.bombArm = g.tick + 8 * TPS; g.noRespawn = true; },
    tick: function (g) {
      var list = labTanks(g), i;
      if (g.bomb && (g.bomb.dead || list.indexOf(g.bomb) === -1)) g.bomb = null;
      if (!g.bomb && g.tick >= g.bombArm && list.length > 1) {
        g.bomb = pick(list);
        g.bombFuse = 20 * TPS;
        g.bombPassAt = g.tick + TPS;
        g.notify((g.bomb.name || 'Someone') + ' has the bomb!', 80);
      }
      if (g.bomb) {
        g.bombFuse--;
        // Pass by contact. Cheaper than a collision hook and just as accurate
        // at these sizes.
        // A one-second hold after every pass. Without it two tanks standing in
        // contact swap the bomb every single tick and nobody ever holds it.
        if (g.tick >= (g.bombPassAt || 0)) for (i = 0; i < list.length; i++) {
          var t = list[i];
          if (t === g.bomb) continue;
          if (Math.hypot(t.x - g.bomb.x, t.y - g.bomb.y) < t.size + g.bomb.size + 12) {
            g.bomb = t;
            g.bombPassAt = g.tick + TPS;
            g.notify('Passed to ' + (t.name || 'someone') + '!', 45);
            break;
          }
        }
        if (g.bombFuse <= 3 * TPS && g.bombFuse % TPS === 0 && g.bombFuse > 0) g.notify(String(Math.ceil(g.bombFuse / TPS)), TPS);
        if (g.bombFuse <= 0) {
          var bx = g.bomb.x, by = g.bomb.y;
          g.notify((g.bomb.name || 'Someone') + ' went up!', 70);
          g.fx = { blast: g.tick, bx: bx, by: by };
          g.bomb.applyDamage(1e9, null);
          for (i = 0; i < list.length; i++) if (Math.hypot(list[i].x - bx, list[i].y - by) < 700) list[i].applyDamage(list[i].maxHealth * 0.5, null);
          g.bomb = null;
          g.bombArm = g.tick + 4 * TPS;
        }
      }
      g.fx = g.bomb ? { bomb: g.bomb, fuse: g.bombFuse } : g.fx;
      if (g.tick % 25 === 0) setHud(g, g.bomb ? 'BOMB TAG  ·  ' + (g.bomb.name || '?') + '  ·  ' + Math.ceil(g.bombFuse / TPS) + 's'
        : 'BOMB TAG  ·  arming...');
      var alive = labTanks(g);
      if (g.roundEndsAt || alive.length > 1) return;
      winRound(g, alive[0] ? (alive[0].name || 'An unnamed tank') + ' never held it at zero!' : 'Everyone went up.');
    },
    reset: function (g) { g.bomb = null; g.noRespawn = false; labReset(g, 'bombtag'); },
    // Run at whoever is nearest if you are holding it; run away if you are not.
    botGoal: function (g, t) {
      if (!g.bomb) return null;
      if (g.bomb === t) {
        var list = labTanks(g), best = botNearest(t, list, function (e) { return e !== t; });
        return best ? botSpot(best, true) : null;
      }
      if (Math.hypot(t.x - g.bomb.x, t.y - g.bomb.y) > 2200) return null;
      var a = Math.atan2(t.y - g.bomb.y, t.x - g.bomb.x);
      return { x: t.x + Math.cos(a) * 1800, y: t.y + Math.sin(a) * 1800, vx: 0, vy: 0, touch: false, hard: true };
    }
  }
});

// =========================================================================
// Chaos Rotation — the modifier layer, and the reason not to ship 38 arenas
// =========================================================================

// Each entry pokes the same fields the cheat commands do, but through the mode
// rather than through the cheat gate. Opening the gate to get an effect is how
// a public arena ends up handing /nuke to everyone.
// Every modifier is written as three parts so it can survive a respawn:
//
//   on(g)      once, when it lands  — arena-wide state (rules, clock, quota)
//   each(g,t)  per tank, applied on activation AND on every spawn while it is
//              live, so a bot that respawns mid-modifier arrives already under it
//   off(g)     once, when it lifts   — hands everything back
//
// The middle one is the whole reason for the shape. A modifier applied only to
// the tanks that happened to be alive at the moment it landed quietly stops
// applying to half the arena within thirty seconds, which is exactly how it
// ends up looking like it only affects the player.
var CHAOS = [
  { name: 'GLASS CANNON', blurb: 'triple damage, both ways',
    on: function (g) { g.ruleOverride = { dmgMult: 3 }; } },
  { name: 'BLITZ', blurb: 'the clock runs at double',
    on: function (g) { g.timeScale = 2; }, off: function (g) { g.timeScale = 1; } },
  { name: 'ICE AGE', blurb: 'nothing stops',
    on: function (g) { g.ruleOverride = { friction: 0.022, accelMult: 0.22 }; } },
  { name: 'VAMPIRES', blurb: 'no regen, heal by hurting',
    on: function (g) { g.ruleOverride = { regen: 0, lifesteal: 0.7 }; },
    each: function (g, t) { t.recompute(); } },
  { name: 'OVERDRIVE', blurb: 'reload cut to a third',
    on: function (g) { g.ruleOverride = { reloadMult: 0.33 }; },
    each: function (g, t) { t.recompute(); }, off: chaosRecompute },
  { name: 'POLYGON RAIN', blurb: 'the field floods',
    on: function (g) { g.wantedShapes = 3200; }, off: function (g) { g.wantedShapes = 1000; } },
  { name: 'BLACKOUT', blurb: 'half the view distance',
    on: function (g) { g.fovScale = 0.5; },
    each: function (g, t) { t.recompute(); },
    off: function (g) { g.fovScale = 1; chaosRecompute(g); } },
  { name: 'GIANTS', blurb: 'everything is twice the size',
    each: function (g, t) { t.scaleBoost = 2; t.recompute(); },
    off: function (g) { chaosEach(g, function (t) { t.scaleBoost = 1; t.recompute(); }); } },
  { name: 'FEATHERWEIGHT', blurb: 'knockback goes through the roof',
    each: function (g, t) { t.absorb = 4; },
    off: function (g) { chaosEach(g, function (t) { t.recompute(); }); } },
  { name: 'GHOST TOWN', blurb: 'everybody turns invisible',
    each: function (g, t) { t.cheatInvis = true; },
    off: function (g) { chaosEach(g, function (t) { t.cheatInvis = false; t.opacity = 1; }); } },
  { name: 'REROLL', blurb: 'everyone gets a new class',
    each: function (g, t) {
      var f = t.health / t.maxHealth;
      forceTankClass(t, randomTankId(), GUN_STATS);
      t.health = t.maxHealth * f;
    } },
  { name: 'BOUNTY', blurb: 'the leader is worth everything',
    on: function (g) { g.ruleOverride = { killShare: 0.9, killBounty: 4000 }; g.bountyTarget = labLeader(g); },
    off: function (g) { g.bountyTarget = null; } },
  { name: 'DISCO', blurb: 'the lights go down',
    on: function (g) { g.discoOn = true; },
    each: function (g, t) { t.fill = randomChaosHex(); t.stroke = t.fill; },
    off: function (g) { g.discoOn = false; chaosEach(g, function (t) { g.paintTeam(t); }); } },
  { name: 'BULLET HELL', blurb: 'everything fires by itself',
    on: function (g) { g.ruleOverride = { reloadMult: 0.5 }; },
    each: function (g, t) { t.autoFire = true; t.recompute(); },
    off: function (g) { chaosEach(g, function (t) { if (!t.isPlayer) t.autoFire = false; t.recompute(); }); } },
  { name: 'BOSS DROP', blurb: 'a boss arrives, uninvited',
    on: function (g) { g.spawnBoss(); } }
];

function randomChaosHex() {
  var h = ((Math.random() * 0xFFFFFF) | 0).toString(16);
  while (h.length < 6) h = '0' + h;
  return '#' + h;
}
function chaosEach(g, fn) { var l = labTanks(g); for (var i = 0; i < l.length; i++) fn(l[i]); }
function chaosRecompute(g) { chaosEach(g, function (t) { t.recompute(); }); }

// Fisher-Yates over a fresh copy of the table. Drawing without replacement is
// deliberate — it means you see all fifteen before any repeats, which reads as
// variety rather than as luck. The order inside a deck is genuinely random.
function chaosShuffle() {
  var d = CHAOS.slice();
  for (var i = d.length - 1; i > 0; i--) {
    var j = (Math.random() * (i + 1)) | 0, t = d[i];
    d[i] = d[j]; d[j] = t;
  }
  return d;
}

labMode('chaos', {
  name: 'Chaos Rotation', family: 'Rules', tag: 'every 90s', boss: true,
  blurb: 'A modifier is drawn every ninety seconds and applied to the whole arena. Fifteen of them, shuffled, never twice before you have seen them all.',
  fx: true,
  how: [
    'Ordinary free-for-all, except that every ninety seconds a modifier is drawn from a table of fifteen and applied to the whole arena.',
    'It is announced five seconds before it lands and again when it lifts, so everybody reacts to the same surprise at the same moment.',
    'It applies to everybody. A modifier is written as an arena part and a per-tank part, and the per-tank part is re-applied on every single spawn while it is live — so a bot that respawns mid-modifier arrives already under it instead of quietly playing the base game.',
    'It survives your own death too: respawn under GIANTS and you come back a giant.',
    'The deck is shuffled with Fisher-Yates and drawn without replacement, so the order inside a deck is genuinely random and you see all fifteen before any repeats.',
    'The table: Glass Cannon, Blitz, Ice Age, Vampires, Overdrive, Polygon Rain, Blackout, Giants, Featherweight, Ghost Town, Reroll, Bounty, Disco, Bullet Hell and Boss Drop.',
    'Everything is cleanly handed back when the timer runs out — nothing leaks into the next modifier.',
    'This is the mode that argues against building thirty-eight separate arenas: one well-populated FFA and a modifier table beats eight empty lobbies.'
  ],
  logic: {
    init: function (g) { g.chaosDeck = []; g.chaosAt = g.tick + 30 * TPS; g.chaosCur = null; },
    // The half that makes a modifier stick: anything spawning while one is live
    // gets it on the way in.
    onSpawn: function (g, t) {
      if (g.chaosCur && g.chaosCur.each) g.chaosCur.each(g, t);
    },
    tick: function (g) {
      var left = g.chaosAt - g.tick;
      if (left === 5 * TPS && !g.chaosCur) g.notify('Something is about to change...', 5 * TPS);
      if (left <= 0) {
        if (g.chaosCur) {
          if (g.chaosCur.off) g.chaosCur.off(g);
          g.ruleOverride = null;
          g.fovScale = undefined;
          g.notify(g.chaosCur.name + ' is over.', 50);
          g.chaosCur = null;
          g.chaosAt = g.tick + 20 * TPS;
        } else {
          if (!g.chaosDeck.length) g.chaosDeck = chaosShuffle();
          g.chaosCur = g.chaosDeck.pop();
          if (g.chaosCur.on) g.chaosCur.on(g);
          if (g.chaosCur.each) chaosEach(g, function (t) { g.chaosCur.each(g, t); });
          g.notify(g.chaosCur.name + ' — ' + g.chaosCur.blurb, 90);
          g.chaosAt = g.tick + 90 * TPS;
          g.chaosFlash = g.tick;
        }
      }
      g.fx = { chaos: g.chaosCur ? g.chaosCur.name : null, disco: !!g.discoOn, flashAt: g.chaosFlash || 0 };
      if (g.tick % 25 === 0) setHud(g, g.chaosCur ? 'CHAOS  ·  ' + g.chaosCur.name + '  ·  ' + clock(g.chaosAt - g.tick)
        : 'CHAOS  ·  next in ' + clock(g.chaosAt - g.tick));
    },
    reset: function (g) {
      if (g.chaosCur && g.chaosCur.off) g.chaosCur.off(g);
      g.chaosCur = null; g.chaosDeck = []; g.discoOn = false; g.chaosFlash = 0;
      labReset(g, 'chaos');
    }
  }
});


// =========================================================================
// Juggernaut Royale — everybody is one, and they grow
// =========================================================================
//
// Ninety-six hulls on eleven branches, seven tiers deep and running to level
// 100, and the branches are meant to be eleven different games rather than
// eleven colours of the same one. Each branch owns a verb nothing else in the
// mode has:
//
//   WARDEN    terrain. Fires no bullets — trap walls, barricades, plinths.
//   REAPER    swarm. Drones, more drones, and a brood thrown on command.
//   BULWARK   body. No barrels at all: armour, contact damage, and a slam.
//   LODESTONE gravity. A well bolted to the hull that eats what you shoot.
//   CINDER    heat. Burn stacks, scorched ground, and a detonation.
//   RIME      cold. Slow, freeze, and ice you cannot steer on.
//   LEECH     blood. Everything it damages feeds it; the dead work for it.
//   EFFIGY    deception. Decoys, blinks, invisibility, and dying badly.
//   METRONOME time. A beat you play, a rewind, and a field that slows clocks.
//   ARSENAL   siege. Roots in place and stops being a tank at all.
//   PARASITE  theft. Latches, hijacks drones, and takes what it kills.
//
// The eleven never converge before tier 4 — each ends in two or three tier-3
// hulls of its own. What DOES converge is tier 4: sixteen fusion hulls, each
// the visible marriage of two branches' verbs, and every branch is half of two
// or three of them. Above that the branches are gone entirely: eight apexes at
// level 70 and four Omegas at 100.
//
// Every node in the tree offers a GROUP. Nothing in here hands you a single
// card and calls it an upgrade — the worst case is two and most of it is three,
// which is what the second tier-3 ending on five branches was added for.
//
// Everything below is data. A hull is one row: silhouette (sides, size,
// addons), weapons (a JR_GUNS call), one ability verb, one passive verb, an
// aura, and a bot profile. buildJuggHulls() turns the row into a real
// TANK_DEFS entry with a real upgrades array and a real level gate, so the
// upgrade cards, the class-tree wheel and the server-side gate in upgradeTo
// are all the game's own.

// ids 112..251. Past every real class (the table stops at 111) and clear of the
// Juggernaut, which was parked at 200 and moved to 255 to get out of the way.
// The roster was packed in under 256 back when the wire wrote a class as a u8;
// it is a u16 now, which is what lets Juggernaut Armageddon's tiers live at 256
// and up (JA_BASE) without the Royale's ids moving.
var JR_BASE = 112;
// The level each tier opens at. Nine tiers in the Royale, and the ninth is its
// level cap: a Crown is a thing you spend a whole round becoming, not a thing
// you buy. Tiers 9..13 are Armageddon's and only exist under its 500 cap.
var JR_LVL = [0, 12, 24, 36, 52, 70, 100, 140, 200, 240, 300, 370, 440, 500];

// Lighten (t > 0) or darken (t < 0) a hex. The branch palette is one colour
// per branch and a tier ramp derived from it, rather than ninety-six literals
// nobody can keep consistent.
function jrMix(hex, t) {
  var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  var d = t < 0 ? 0 : 255, a = Math.abs(t);
  r = Math.round(r + (d - r) * a); g = Math.round(g + (d - g) * a); b = Math.round(b + (d - b) * a);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// One row per branch: the hull colour, the rgb the aura is painted in, and
// which aura painter draws it. modefx.js reads `tone` and `aura` straight off
// the def, so a new branch is a new row here and nothing else.
var JR_BR = {
  brute:    { label: 'Brute',     hex: '#4C4C5A', tone: '205,205,220', aura: 'ring' },
  warden:   { label: 'Warden',    hex: '#46543C', tone: '150,220,140', aura: 'thorn' },
  reaper:   { label: 'Reaper',    hex: '#4A3556', tone: '205,140,255', aura: 'swarm' },
  bulwark:  { label: 'Bulwark',   hex: '#4A3A2E', tone: '255,150,90',  aura: 'quake' },
  lode:     { label: 'Lodestone', hex: '#2C3866', tone: '130,150,255', aura: 'void' },
  cinder:   { label: 'Cinder',    hex: '#63301E', tone: '255,140,55',  aura: 'ember' },
  rime:     { label: 'Rime',      hex: '#26566B', tone: '150,225,255', aura: 'frost' },
  siphon:   { label: 'Leech',     hex: '#5E2230', tone: '255,80,105',  aura: 'blood' },
  effigy:   { label: 'Effigy',    hex: '#2F5257', tone: '150,255,230', aura: 'ghost' },
  horo:     { label: 'Metronome', hex: '#5F5220', tone: '255,220,120', aura: 'clock' },
  arsenal:  { label: 'Arsenal',   hex: '#3A424E', tone: '190,205,225', aura: 'steel' },
  parasite: { label: 'Parasite',  hex: '#46561F', tone: '200,240,90',  aura: 'bile' },
  fusion:   { label: 'Fusion',    hex: '#4A2555', tone: '255,235,255', aura: 'fusion' },
  // Tier 5 and 6. Both burn two colours like a fusion does, so both take the
  // fusion painter; what separates them is the shell and how loud the aura is,
  // and jrTier already carries that.
  apex:     { label: 'Apex',      hex: '#5B2438', tone: '255,190,140', aura: 'fusion' },
  omega:    { label: 'Omega',     hex: '#1C1C26', tone: '255,255,255', aura: 'fusion' },
  // Tier 7 and 8 get a painter of their own: a fusion aura is two colours
  // arguing, a sovereign aura is one thing the arena is arranged around.
  titan:    { label: 'Titan',     hex: '#241C2E', tone: '255,235,200', aura: 'sovereign' },
  crown:    { label: 'Crown',     hex: '#14141C', tone: '255,255,255', aura: 'crown' },
  // Juggernaut Armageddon's five. Each has a painter of its own in modefx.js,
  // and each one is louder than the one below it on purpose.
  ascendant:  { label: 'Ascendant',  hex: '#1E1A2A', tone: '255,240,200', aura: 'ascendant' },
  archon:     { label: 'Archon',     hex: '#181428', tone: '220,235,255', aura: 'archon' },
  primordial: { label: 'Primordial', hex: '#120E1E', tone: '255,255,255', aura: 'primordial' },
  eschaton:   { label: 'Eschaton',   hex: '#0C0A14', tone: '255,250,235', aura: 'eschaton' },
  armageddon: { label: 'Armageddon', hex: '#06050A', tone: '255,255,255', aura: 'armageddon' }
};

// --- the dynasties -------------------------------------------------------
// Everything up to level 52 is a lattice: eleven branches that meet at the
// fusions, and a fusion has two parents on purpose. From 52 up it stops being a
// lattice. The fusion you take seals you into one of eight DYNASTIES, and every
// hull above it — the apex at 70, the omega at 100, the titan at 140 and the
// crown at 200 — belongs to that dynasty alone. No other path in the game
// reaches them, no two dynasties share a single hull, and the cards you are
// offered at 70 are proof of what you picked at 52.
//
// Two fusions feed each dynasty. Inside one, every tier is a choice of two,
// right up to the crown — which is the one card in the mode that is not a
// choice, because by then there is one thing left to become.
var JR_DYN = {
  pyre:  { label: 'Pyre',     hex: '#7A2E12', a: '255,150,60',  b: '255,90,40'   },
  rime:  { label: 'Glacier',  hex: '#17415B', a: '170,235,255', b: '210,250,255' },
  titan: { label: 'Titan',    hex: '#5B3A1E', a: '255,190,140', b: '205,205,220' },
  siege: { label: 'Ordnance', hex: '#2E3540', a: '200,215,240', b: '255,220,120' },
  wall:  { label: 'Bastion',  hex: '#3A4A34', a: '170,230,150', b: '255,80,105'  },
  voidd: { label: 'Void',     hex: '#1E2447', a: '150,165,255', b: '150,255,230' },
  time:  { label: 'Chrono',   hex: '#4A421E', a: '255,225,130', b: '150,255,230' },
  flesh: { label: 'Vermin',   hex: '#4A1E2E', a: '235,90,120',  b: '200,240,90'  }
};

// --- weapons -------------------------------------------------------------
// Every gun in the mode comes out of here, so a hull's armament is one call
// and the silhouette rules stay honest: hooded launchers mean traps, flared
// outward trapezoids mean drones, long thin barrels mean range, and a hull
// with no entry at all has no barrels because its body IS the weapon.

function jrBullet(o) {
  o = o || {};
  var b = {
    type: o.type || 'bullet',
    sizeRatio: o.ratio === undefined ? 1 : o.ratio,
    health: o.hp === undefined ? 10 : o.hp,
    damage: o.dmg === undefined ? 1 : o.dmg,
    speed: o.speed === undefined ? 1 : o.speed,
    scatterRate: o.scatter === undefined ? 0.5 : o.scatter,
    lifeLength: o.life === undefined ? 1 : o.life,
    absorbtionFactor: o.absorb === undefined ? 0.6 : o.absorb
  };
  if (o.sides !== undefined) b.sides = o.sides;
  if (o.color) { b.color = o.color; b.stroke = o.stroke || jrMix(o.color, -0.32); }
  return b;
}

function jrBarrel(o) {
  return {
    angle: o.angle || 0, offset: o.offset || 0,
    size: o.size, width: o.width, delay: o.delay || 0,
    reload: o.reload, recoil: o.recoil === undefined ? 0.6 : o.recoil,
    isTrapezoid: !!o.trap, trapezoidDirection: o.trapDir || 0, addon: o.addon || null,
    pellets: o.pellets, droneCount: o.droneCount, canControlDrones: o.control,
    bullet: o.bullet
  };
}

var JR_GUNS = {
  // n light guns evenly around the body — the starter hull's only weapon
  ring: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: Math.PI * 2 * (i / n) + (o.spin || 0),
      size: o.size || 100, width: o.width || 56, delay: i % 2 ? 0.5 : 0,
      reload: o.reload || 1.9, recoil: 0.35,
      bullet: jrBullet({ hp: 7, dmg: o.dmg || 0.5, speed: 1.15, scatter: 0.5, life: 1.1,
        absorb: 0.6, color: o.color, sides: o.sides })
    }));
    return out;
  },

  // The plain forward gun. Wide, trapezoidal, unmistakably a cannon.
  cannon: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * (o.spread === undefined ? 0.2 : o.spread),
      size: o.size || 126, width: o.width || 82, reload: o.reload || 3.2, recoil: 1.5, trap: true,
      bullet: jrBullet({ ratio: o.ratio || 1.12, hp: 20, dmg: o.dmg || 1.1, speed: 0.95,
        scatter: 0.2, life: 1.4, absorb: 0.35, color: o.color, sides: o.sides })
    }));
    return out;
  },

  // A long, thin, high-velocity barrel. Range, and nothing else.
  rifle: function (n, o) {
    o = o || {}; n = n || 1; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * 0.13,
      size: o.size || 158, width: o.width || 52, reload: o.reload || 4.4, recoil: 2.2,
      bullet: jrBullet({ hp: 26, dmg: o.dmg || 2.2, speed: o.speed || 1.9, scatter: 0.05, life: 1.9,
        absorb: 0.2, color: o.color, sides: o.sides })
    }));
    return out;
  },

  // Drone hangars: wide, flared outward, unmistakable at a glance.
  hangar: function (count, o) {
    o = o || {};
    return [jrBarrel({
      angle: o.angle === undefined ? Math.PI : o.angle,
      size: o.size || 96, width: o.width || 78, delay: o.delay || 0, reload: 3, recoil: 0,
      trap: true, trapDir: 1, droneCount: count, control: true,
      bullet: jrBullet({ type: 'drone', ratio: o.ratio || 0.95, hp: o.hp || 9, dmg: o.dmg || 0.4,
        speed: o.speed || 1.35, scatter: 1, life: -1, absorb: 1, color: o.color, sides: o.sides })
    })];
  },

  // Trap launchers: short, wide, hooded. The Warden line's whole vocabulary.
  traps: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: Math.PI * 2 * (i / n) + (o.spin === undefined ? 0 : o.spin),
      size: o.size || 70, width: o.width || 64, delay: (i % 2) * 0.5,
      reload: o.reload || 4, recoil: 0.35, addon: 'trapLauncher',
      bullet: jrBullet({ type: 'trap', ratio: o.ratio || 0.95, hp: o.hp || 20, dmg: o.dmg || 1.0,
        speed: 2.1, scatter: 1, life: o.life || 8, absorb: 1,
        color: o.color || '#5B6B55' })
    }));
    return out;
  },

  // A backward fan whose recoil IS the propulsion.
  thrust: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: Math.PI + (i - (n - 1) / 2) * 0.44,
      size: 92, width: 72, reload: 0.55, recoil: o.recoil || 3.6, trap: true, trapDir: 1,
      bullet: jrBullet({ ratio: 0.9, hp: 4, dmg: 0.3, speed: 0.7, scatter: 2, life: 0.5,
        absorb: 0.5, color: o.color })
    }));
    return out;
  },

  // --- new vocabulary ---------------------------------------------------

  // Shotgun. One trigger pull, a fistful of small fast pellets.
  spread: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * 0.5,
      size: o.size || 96, width: o.width || 96, reload: o.reload || 4.2, recoil: 2.4, trap: true,
      pellets: o.pellets || 7,
      bullet: jrBullet({ ratio: 0.42, hp: 4, dmg: o.dmg || 0.45, speed: 1.35, scatter: 12,
        life: 0.55, absorb: 0.35, color: o.color, sides: o.sides })
    }));
    return out;
  },

  // Flak. One enormous slow shell that shoves as much as it hurts.
  flak: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * 0.34,
      size: o.size || 118, width: o.width || 124, reload: o.reload || 6.5, recoil: 3.4, trap: true,
      bullet: jrBullet({ ratio: o.ratio || 2.1, hp: 46, dmg: o.dmg || 2.0, speed: 0.6, scatter: 0.4,
        life: 1.5, absorb: 0.06, color: o.color, sides: o.sides })
    }));
    return out;
  },

  // The Howitzer's mortar: a hexagonal shell that bursts into shards. Uses the
  // firework path, so right-click detonation and the burst are the game's own.
  mortar: function (o) {
    o = o || {};
    return [jrBarrel({
      size: o.size || 150, width: o.width || 116, reload: o.reload || 7, recoil: 3, trap: true,
      bullet: jrBullet({ type: 'firework', ratio: 1.5, hp: 30, dmg: o.dmg || 1.5, speed: 0.72,
        scatter: 0.3, life: 1.5, absorb: 0.2, color: o.color })
    })];
  },

  // Needles: tiny, fast, relentless. What a parasite shoots.
  needles: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * (o.spread === undefined ? 0.22 : o.spread),
      size: o.size || 128, width: o.width || 34, delay: (i % 2) * 0.5,
      reload: o.reload || 1.1, recoil: 0.3,
      bullet: jrBullet({ ratio: 0.55, hp: 4, dmg: o.dmg || 0.4, speed: 1.55, scatter: 1.2,
        life: 0.95, absorb: 0.3, color: o.color, sides: o.sides })
    }));
    return out;
  },

  // Embers: small, hot, thrown fast and often, in a colour you can smell.
  ember: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: Math.PI * 2 * (i / n) + (o.spin || 0),
      size: o.size || 92, width: o.width || 48, delay: (i % 3) / 3,
      reload: o.reload || 1.5, recoil: 0.4,
      bullet: jrBullet({ ratio: 0.7, hp: 5, dmg: o.dmg || 0.55, speed: 1.4, scatter: 2.4,
        life: 0.8, absorb: 0.4, sides: 3, color: o.color || '#FF7A2E' })
    }));
    return out;
  },

  // Shards: six-sided, pale, slow and heavy. What cold looks like leaving a barrel.
  cryo: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: Math.PI * 2 * (i / n) + (o.spin || 0),
      size: o.size || 104, width: o.width || 64, delay: (i % 2) * 0.5,
      reload: o.reload || 2.6, recoil: 0.8, trap: true, trapDir: 1,
      bullet: jrBullet({ ratio: 1.05, hp: 16, dmg: o.dmg || 0.9, speed: 0.82, scatter: 0.3,
        life: 1.3, absorb: 0.4, sides: 6, color: o.color || '#A9E8FF' })
    }));
    return out;
  },

  // Phantoms: fast, near-white, barely there. The Effigy line's tell.
  phase: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: Math.PI * 2 * (i / n) + (o.spin || 0),
      size: o.size || 112, width: o.width || 42, delay: (i % 2) * 0.5,
      reload: o.reload || 1.7, recoil: 0.25,
      bullet: jrBullet({ ratio: 0.8, hp: 6, dmg: o.dmg || 0.6, speed: 1.7, scatter: 0.6,
        life: 1.2, absorb: 0.25, color: o.color || '#CFF6EC' })
    }));
    return out;
  },

  // Leeches: dark, four-sided, slow. Every one that lands feeds the hull.
  siphon: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * 0.28,
      size: o.size || 110, width: o.width || 70, delay: (i % 2) * 0.5,
      reload: o.reload || 2.4, recoil: 0.9, trap: true,
      bullet: jrBullet({ ratio: 0.95, hp: 14, dmg: o.dmg || 0.85, speed: 1.0, scatter: 0.5,
        life: 1.2, absorb: 0.45, sides: 4, color: o.color || '#C22F4A' })
    }));
    return out;
  },

  // Orbiters: swarm-type motes that circle and chase. Cheap, endless, everywhere.
  orbit: function (count, o) {
    o = o || {};
    return [jrBarrel({
      angle: o.angle === undefined ? Math.PI : o.angle,
      size: o.size || 74, width: o.width || 60, delay: o.delay || 0, reload: 2.2, recoil: 0,
      trap: true, trapDir: 1, droneCount: count, control: true,
      bullet: jrBullet({ type: 'swarm', ratio: 0.62, hp: 5, dmg: o.dmg || 0.28, speed: 1.9,
        scatter: 1.4, life: -1, absorb: 1, color: o.color })
    })];
  },

  // Minions: drones that carry a gun of their own.
  factory: function (count, o) {
    o = o || {};
    return [jrBarrel({
      angle: o.angle === undefined ? 0 : o.angle,
      size: o.size || 108, width: o.width || 104, reload: 5, recoil: 0,
      trap: true, trapDir: 1, droneCount: count, control: true,
      bullet: jrBullet({ type: 'minion', ratio: 1.3, hp: 22, dmg: o.dmg || 0.6, speed: 0.9,
        scatter: 1, life: -1, absorb: 1, color: o.color })
    })];
  },

  // Lances: skimmer missiles that spin and spray as they fly.
  lance: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * 0.3,
      size: o.size || 96, width: o.width || 86, reload: o.reload || 5.5, recoil: 2.6,
      addon: null,
      bullet: jrBullet({ type: 'skimmer', ratio: 1.15, hp: 28, dmg: o.dmg || 1.2, speed: 0.75,
        scatter: 0.4, life: 1.3, absorb: 0.2, color: o.color })
    }));
    return out;
  },

  // --- the late vocabulary ----------------------------------------------
  // Three guns that only exist above the fusions, because a titan firing the
  // same cannon a level-24 Obelisk fires is a level-24 Obelisk with more health.

  // Hellbore: one shell the size of a small tank, thrown slowly, that stops
  // being a projectile and starts being a piece of weather.
  hellbore: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * 0.42,
      size: o.size || 132, width: o.width || 158, reload: o.reload || 8, recoil: 5, trap: true,
      bullet: jrBullet({ ratio: o.ratio || 3.2, hp: 90, dmg: o.dmg || 3.4, speed: 0.5, scatter: 0.25,
        life: 1.8, absorb: 0.02, color: o.color, sides: o.sides })
    }));
    return out;
  },

  // Spine: a rifle long enough to read as a mast, at velocities nothing at a
  // lower tier can lead.
  spine: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * (o.spread === undefined ? 0.1 : o.spread),
      size: o.size || 198, width: o.width || 46, delay: (i % 2) * 0.5,
      reload: o.reload || 3.4, recoil: 2.6,
      bullet: jrBullet({ ratio: 0.85, hp: 40, dmg: o.dmg || 3.2, speed: o.speed || 2.4, scatter: 0.03,
        life: 2.4, absorb: 0.12, color: o.color, sides: o.sides })
    }));
    return out;
  },

  // Starfall: a ring of mortars. Every one of them bursts, and the hull is
  // standing in the middle of its own weather.
  starfall: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: Math.PI * 2 * (i / n) + (o.spin || 0),
      size: o.size || 128, width: o.width || 100, delay: i / n,
      reload: o.reload || 7, recoil: 1.6, trap: true,
      bullet: jrBullet({ type: 'firework', ratio: 1.35, hp: 34, dmg: o.dmg || 1.8, speed: 0.8,
        scatter: 0.4, life: 1.4, absorb: 0.18, color: o.color })
    }));
    return out;
  },

  // --- Armageddon's vocabulary ------------------------------------------
  // Three guns that only exist past the crowns.

  // Godspear: a barrel longer than anything else in the game, and a round that
  // crosses the screen before the shot you dodged last time has landed.
  godspear: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * (o.spread === undefined ? 0.12 : o.spread) + (o.spin || 0),
      size: o.size || 236, width: o.width || 64, delay: (i % 2) * 0.5,
      reload: o.reload || 3.6, recoil: 3.4,
      bullet: jrBullet({ ratio: 1.0, hp: 90, dmg: o.dmg || 6.5, speed: o.speed || 2.9, scatter: 0.02,
        life: 2.8, absorb: 0.05, sides: o.sides, color: o.color || '#FFF4D6' })
    }));
    return out;
  },

  // Nova: a full ring of shells the size of hellbores. There is no side of an
  // Armageddon hull that is safe to stand on.
  nova: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: Math.PI * 2 * (i / n) + (o.spin || 0),
      size: o.size || 138, width: o.width || 132, delay: i / n,
      reload: o.reload || 6.5, recoil: 1.2, trap: true,
      bullet: jrBullet({ ratio: o.ratio || 2.6, hp: 120, dmg: o.dmg || 4.2, speed: 0.62, scatter: 0.2,
        life: 1.9, absorb: 0.02, sides: o.sides, color: o.color })
    }));
    return out;
  },

  // Gatling: a tight forward cluster on a reload measured in frames.
  gatling: function (n, o) {
    o = o || {}; var out = [];
    for (var i = 0; i < n; i++) out.push(jrBarrel({
      angle: (i - (n - 1) / 2) * 0.07 + (o.spin || 0),
      size: o.size || 170, width: o.width || 44, delay: i / n,
      reload: o.reload || 0.55, recoil: 0.25,
      bullet: jrBullet({ ratio: 0.8, hp: 12, dmg: o.dmg || 1.6, speed: 2.1, scatter: 1.4,
        life: 1.2, absorb: 0.15, sides: o.sides, color: o.color })
    }));
    return out;
  }
};

// --- the roster ----------------------------------------------------------
// id, name, branch, tier, sides, size, health, body damage, speed, guns,
// upgrades, ability, passive. Everything not given is filled from the tier
// table in buildJuggHulls, so a row only says what makes it that hull.
//
//   me  melee — no bullet stats at all, the stat panel says so
//   iv  invisible
//   pre/post  addon shells, which is where most of the silhouette lives
//   hx  override the branch's hull colour (every fusion has its own)
//   tone/aura  override the branch's aura (the fusion hulls burn two colours)
//   dy  which dynasty it belongs to, from tier 4 up. This is what seals the
//       top of the tree: a hull only ever offers hulls of its own dynasty.
//   abs autonomous abilities — a list of verbs the hull fires ITSELF the moment
//       each one's own cooldown is up and there is a point. `ab` stays the
//       right-click button; `abs` is why an omega feels like a boss fight.
//   ps  passive verb, or a list of them. Above the fusions hulls carry two or
//       three at once.
//   tr  traits: the things that are not verbs at all. A shield that grows back,
//       a death it refuses, a cap on what any one hit may take, an escort that
//       never expires, a tithe on everything it touches. See JR_TRAIT.

var JRG = JR_GUNS;
var JRPI = Math.PI;

var JR_HULLS = [
  // ---- tier 0 ----------------------------------------------------------
  { id: 0, n: 'Brute', br: 'brute', t: 0, sd: 12, sz: 78, hp: 900, bd: 12, sp: 0.80, post: 'spike',
    g: function () { return JRG.ring(6).concat(JRG.cannon(2)); },
    up: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    bl: 'The hull everybody starts in. Six ring guns and two cannons on twelve sides — deliberately unremarkable, so the branch you pick at level 12 is the first real decision you make.' },

  // ---- tier 1: the eleven branch heads ---------------------------------
  { id: 1, n: 'Warden', br: 'warden', t: 1, sd: 6, sz: 90, hp: 1700, bd: 15, sp: 0.66, post: 'smasher',
    g: function () { return JRG.traps(5, { spin: -JRPI / 2 }); }, up: [12, 13, 14], ab: 'barricade',
    bl: 'Fires no bullets at all. Five hooded launchers on a hexagon, and a BARRICADE it throws down around itself.' },

  { id: 2, n: 'Reaper', br: 'reaper', t: 1, sd: 8, sz: 86, hp: 1300, bd: 12, sp: 0.86, post: 'spike',
    g: function () { return JRG.hangar(8).concat(JRG.cannon(1, { reload: 3.6 })); }, up: [15, 16, 17], ab: 'swarm',
    bl: 'Eight controllable drones out of one wide hangar, and a single cannon for when they are busy.' },

  { id: 3, n: 'Bulwark', br: 'bulwark', t: 1, sd: 14, sz: 98, hp: 2600, bd: 30, sp: 0.82, post: 'smasher', me: true,
    g: function () { return []; }, up: [18, 19, 20], ab: 'slam',
    bl: 'No barrels. None at all. A spiked shell, contact damage that ends people, and a SLAM that throws everything off it.' },

  { id: 4, n: 'Lodestone', br: 'lode', t: 1, sd: 10, sz: 88, hp: 1500, bd: 14, sp: 0.78, post: 'jrhalo',
    g: function () { return JRG.ring(4, { dmg: 0.7, reload: 2.2 }).concat(JRG.cannon(1)); },
    up: [21, 22, 23], ab: 'pull', ps: 'magnet',
    bl: 'A well bolted to the hull. Enemy bullets bend toward it and die on it, and PULL drags whoever fired them in after.' },

  { id: 5, n: 'Cinder', br: 'cinder', t: 1, sd: 7, sz: 84, hp: 1400, bd: 18, sp: 0.88, post: 'jrcore',
    g: function () { return JRG.ember(3); }, up: [24, 25, 26], ab: 'ignite', ps: 'burn',
    bl: 'Everything it touches catches. Contact sets a burn running, and IGNITE lights everything standing near it.' },

  { id: 6, n: 'Rime', br: 'rime', t: 1, sd: 6, sz: 88, hp: 1600, bd: 14, sp: 0.76, post: 'jrshard',
    g: function () { return JRG.cryo(4); }, up: [27, 28, 29], ab: 'freeze', ps: 'chill',
    bl: 'A cold field that halves anything walking in it, and a FREEZE that stops them dead for a second and a half.' },

  { id: 7, n: 'Leech', br: 'siphon', t: 1, sd: 5, sz: 86, hp: 1400, bd: 16, sp: 0.84, post: 'jrfangs',
    g: function () { return JRG.siphon(3); }, up: [30, 31, 32], ab: 'reap', ps: 'drain',
    bl: 'It has no regeneration worth the name. What it has is everyone else\'s: damage feeds it, and REAP tears a mouthful out of everything close.' },

  { id: 8, n: 'Effigy', br: 'effigy', t: 1, sd: 9, sz: 82, hp: 1200, bd: 12, sp: 0.94, post: 'jrveil',
    g: function () { return JRG.phase(4); }, up: [33, 34, 35], ab: 'decoy', ps: 'mirror',
    bl: 'DECOY puts two copies of you on the field that move as you move, deal nothing, and die to one hit. Nobody knows which one to shoot.' },

  { id: 9, n: 'Metronome', br: 'horo', t: 1, sd: 12, sz: 88, hp: 1500, bd: 15, sp: 0.82, post: 'jrgear',
    g: function () { return JRG.ring(4, { reload: 1.6 }).concat(JRG.cannon(2)); }, up: [36, 37, 38], ab: 'rewind', ps: 'beat',
    bl: 'Four seconds armoured and slow, four seconds fragile and fast, forever, and the hull tells you which. REWIND puts you back where you were three seconds ago, health and all.' },

  { id: 10, n: 'Emplacement', br: 'arsenal', t: 1, sd: 4, sz: 92, hp: 1900, bd: 16, sp: 0.62, pre: 'dombase', post: 'jrframe',
    g: function () { return JRG.cannon(2, { reload: 3.6 }); }, up: [39, 40, 41], ab: 'deploy', ps: 'dug',
    bl: 'DEPLOY roots it to the floor: it cannot move at all, and in exchange it reloads twice as fast and takes half damage. A tank that chooses to stop being one.' },

  { id: 11, n: 'Tick', br: 'parasite', t: 1, sd: 3, sz: 78, hp: 1100, bd: 20, sp: 0.98, post: 'jrfangs',
    g: function () { return JRG.needles(3); }, up: [42, 43, 44], ab: 'infest', ps: 'latch',
    bl: 'Small, fast, and attached. While it is touching you its needles drain your score into its own, and INFEST fastens it on properly.' },

  // ---- tier 2: three per branch ----------------------------------------
  // WARDEN
  { id: 12, n: 'Bastion', br: 'warden', t: 2, sd: 8, sz: 106, hp: 3400, bd: 18, sp: 0.42, pre: 'dombase', post: 'auto3',
    g: function () { return JRG.traps(8, { reload: 3.4, life: 10 }); }, up: [45, 72], ab: 'barricade',
    bl: 'A fortress on a plinth. Eight launchers, three auto-turrets that aim themselves, and barely able to walk.' },

  { id: 13, n: 'Thornback', br: 'warden', t: 2, sd: 10, sz: 94, hp: 2300, bd: 26, sp: 0.86, post: 'landmine',
    g: function () { return JRG.traps(3, { spin: JRPI, reload: 2.4, life: 6 }); }, up: [45, 72], ab: 'barricade', ps: 'thorns',
    bl: 'The Warden that runs. Three rear launchers lay a wall behind it while it rams, so chasing one is how you die tired.' },

  { id: 14, n: 'Grafter', br: 'warden', t: 2, sd: 7, sz: 100, hp: 2600, bd: 22, sp: 0.70, post: 'jrplates',
    g: function () { return JRG.traps(4).concat(JRG.ring(2, { spin: JRPI / 2 })); }, up: [45, 72], ab: 'graft', ps: 'graft',
    bl: 'It eats polygons and wears them. Every shape it swallows bolts another plate on, and you can see the hull thicken from across the field.' },

  // REAPER
  { id: 15, n: 'Harvester', br: 'reaper', t: 2, sd: 7, sz: 96, hp: 2000, bd: 14, sp: 0.80, post: 'spike',
    g: function () {
      return JRG.hangar(8, { angle: JRPI })
        .concat(JRG.hangar(6, { angle: JRPI * 0.6, delay: 0.33 }))
        .concat(JRG.hangar(6, { angle: -JRPI * 0.6, delay: 0.66 }));
    }, up: [46, 73], ab: 'swarm',
    bl: 'Twenty drones out of three hangars and not one direct weapon. You do not shoot people with a Harvester. You send them.' },

  { id: 16, n: 'Widow', br: 'reaper', t: 2, sd: 9, sz: 88, hp: 1500, bd: 13, sp: 0.94, post: 'pronounced', iv: true, fov: 0.82,
    g: function () { return JRG.rifle(1).concat(JRG.hangar(10, { size: 84, width: 66 })); }, up: [46, 73], ab: 'swarm',
    bl: 'A juggernaut that vanishes. Stop firing and it fades out, drones and all, and the collared rifle hits from further than anything else at this tier.' },

  { id: 17, n: 'Choirmaster', br: 'reaper', t: 2, sd: 11, sz: 100, hp: 2400, bd: 15, sp: 0.76, post: 'jrhalo',
    g: function () {
      return JRG.hangar(6, { angle: JRPI * 0.75 }).concat(JRG.hangar(6, { angle: -JRPI * 0.75, delay: 0.5 }))
        .concat(JRG.orbit(6, { angle: JRPI }));
    }, up: [46, 73], ab: 'swarm', ps: 'choir',
    bl: 'Its drones make each other braver. Every extra one on the field lifts the whole flock\'s damage, so eighteen are worth far more than three sixes.' },

  // BULWARK
  { id: 18, n: 'Colossus', br: 'bulwark', t: 2, sd: 16, sz: 124, hp: 5200, bd: 42, sp: 0.60, post: 'megasmasher', me: true,
    g: function () { return []; }, up: [47, 56], ab: 'slam',
    bl: 'Five thousand two hundred health, forty-two contact damage, an oversized shell and no weapon of any kind. It does not dodge. It does not need to.' },

  { id: 19, n: 'Wrecker', br: 'bulwark', t: 2, sd: 11, sz: 96, hp: 2600, bd: 36, sp: 0.70, post: 'landmine', me: true,
    g: function () { return JRG.thrust(3); }, up: [47, 60], ab: 'slam', ps: 'momentum',
    bl: 'Three rear thrusters and nothing pointing forward. The recoil is the weapon, and the faster it is going when it lands, the more it takes off you.' },

  { id: 20, n: 'Bramble', br: 'bulwark', t: 2, sd: 13, sz: 104, hp: 3000, bd: 34, sp: 0.72, post: 'jrcrown', me: true,
    g: function () { return []; }, up: [47, 56, 60], ab: 'slam', ps: 'thorns',
    bl: 'Covered in the parts of itself that hurt. Anything close enough to ram it is already bleeding for the privilege.' },

  // LODESTONE
  { id: 21, n: 'Anvil', br: 'lode', t: 2, sd: 8, sz: 108, hp: 3600, bd: 24, sp: 0.56, post: 'jrhalo',
    g: function () { return JRG.flak(1).concat(JRG.ring(3, { spin: JRPI / 2 })); }, up: [48, 61], ab: 'pull', ps: 'eat',
    bl: 'A bullet sponge that gets fatter the more you shoot it: every round its field swallows is converted straight into health.' },

  { id: 22, n: 'Repulsor', br: 'lode', t: 2, sd: 10, sz: 96, hp: 2400, bd: 18, sp: 0.80, post: 'jrhalo',
    g: function () { return JRG.ring(6, { reload: 2.4, dmg: 0.6 }); }, up: [48, 61], ab: 'repel', ps: 'wall',
    bl: 'The well, inverted. Nothing gets close — incoming fire is shoved off course and REPEL clears the whole ring at once. Its own shots leave slower for it.' },

  { id: 23, n: 'Warpsmith', br: 'lode', t: 2, sd: 9, sz: 94, hp: 2200, bd: 16, sp: 0.88, post: 'jrveil',
    g: function () { return JRG.cannon(2).concat(JRG.needles(2, { spread: 0.5 })); }, up: [48, 61], ab: 'warp',
    bl: 'Drops a pad, then drops another, then steps between them. Two personal portals nobody else can use, anywhere on the map.' },

  // CINDER
  { id: 24, n: 'Pyre', br: 'cinder', t: 2, sd: 8, sz: 102, hp: 2600, bd: 26, sp: 0.74, post: 'jrcore',
    g: function () { return JRG.ember(6); }, up: [49, 74], ab: 'overload', ps: 'pyre',
    bl: 'It burns hotter as it dies. The damage ring around a healthy Pyre is a nuisance; the ring around one on its last quarter is a kill zone.' },

  { id: 25, n: 'Ashwalker', br: 'cinder', t: 2, sd: 9, sz: 98, hp: 2400, bd: 24, sp: 0.88, post: 'landmine',
    g: function () { return JRG.traps(3, { spin: JRPI, color: '#9A3F1C', reload: 2.6, life: 6 }); }, up: [49, 74], ab: 'ignite', ps: 'trail',
    bl: 'It leaves the ground on fire behind it. Following an Ashwalker is a decision about how much health you can spare.' },

  { id: 26, n: 'Molt', br: 'cinder', t: 2, sd: 6, sz: 92, hp: 2200, bd: 28, sp: 0.94, post: 'jrcore',
    g: function () { return JRG.ember(4); }, up: [49, 74], ab: 'shed', ps: 'heat',
    bl: 'SHED throws the shell off in a ring of burning debris and leaves something smaller, faster and much angrier standing in it.' },

  // RIME
  { id: 27, n: 'Glacier', br: 'rime', t: 2, sd: 6, sz: 112, hp: 3600, bd: 22, sp: 0.54, post: 'jrshard',
    g: function () { return JRG.cryo(6); }, up: [50, 59], ab: 'freeze', ps: 'chill',
    bl: 'Slow, enormous, and it makes everything near it slow too. FREEZE locks the whole ring solid — they take less damage while held, so it is setup, not execution.' },

  { id: 28, n: 'Quarantine', br: 'rime', t: 2, sd: 12, sz: 100, hp: 2800, bd: 18, sp: 0.72, post: 'jrhalo',
    g: function () { return JRG.cryo(2).concat(JRG.ring(2, { spin: JRPI / 2 })); }, up: [50, 59], ab: 'bubble',
    bl: 'BUBBLE throws up a dome no projectile crosses in either direction for eight seconds. Whoever is inside it with you is having the same eight seconds you are.' },

  { id: 29, n: 'Hailstorm', br: 'rime', t: 2, sd: 7, sz: 96, hp: 2400, bd: 20, sp: 0.82, post: 'jrshard',
    g: function () { return JRG.spread(2, { color: '#BFEFFF', sides: 6, pellets: 9 }); }, up: [50, 59], ab: 'freeze', ps: 'chill',
    bl: 'Two barrels, eighteen hexagonal shards a volley, and a cold field underneath. At contact range it deletes people.' },

  // LEECH
  { id: 30, n: 'Gravewalker', br: 'siphon', t: 2, sd: 5, sz: 100, hp: 2600, bd: 22, sp: 0.78, post: 'jrfangs',
    g: function () { return JRG.siphon(2).concat(JRG.hangar(4, { color: '#8C2438', angle: JRPI })); }, up: [51, 58], ab: 'raise', ps: 'drain',
    bl: 'Everything it kills gets back up. RAISE turns the nearest corpses and polygons into husks that fight for it until they fall apart.' },

  { id: 31, n: 'Hemorrhage', br: 'siphon', t: 2, sd: 7, sz: 94, hp: 2200, bd: 24, sp: 0.86, post: 'jrfangs',
    g: function () { return JRG.needles(4, { color: '#D4324F' }); }, up: [51, 58], ab: 'reap', ps: 'bleed',
    bl: 'Anything it hurts keeps bleeding until it is full again — and a Hemorrhage sees everything that is bleeding, through fog, through range, through walls.' },

  { id: 32, n: 'Alchemist', br: 'siphon', t: 2, sd: 8, sz: 98, hp: 2500, bd: 18, sp: 0.74, post: 'jrplates',
    g: function () { return JRG.siphon(3, { reload: 2.8 }).concat(JRG.traps(2, { spin: JRPI / 2 })); }, up: [51, 58], ab: 'bloom', ps: 'bloom',
    bl: 'Damage it deals condenses into polygons behind it. It farms the fight it is having, which is either elegant or obscene depending on which end you are on.' },

  // EFFIGY
  { id: 33, n: 'Fracture', br: 'effigy', t: 2, sd: 9, sz: 90, hp: 2000, bd: 16, sp: 0.96, post: 'jrveil',
    g: function () { return JRG.phase(5); }, up: [52, 57], ab: 'blink', ps: 'mirror',
    bl: 'BLINK is six hundred units toward the cursor and a decoy left standing where you were. Take a big enough hit and it fires on its own.' },

  { id: 34, n: 'Beacon', br: 'effigy', t: 2, sd: 10, sz: 104, hp: 3200, bd: 20, sp: 0.80, post: 'jrhalo',
    g: function () { return JRG.ring(6).concat(JRG.cannon(1)); }, up: [52, 57], ab: 'mark', ps: 'beacon',
    bl: 'Everyone on the map can see it at all times. In exchange it earns half again as much from everything, and MARK lights the rest of the field up for a while too.' },

  { id: 35, n: 'Sentinel', br: 'effigy', t: 2, sd: 8, sz: 94, hp: 2200, bd: 16, sp: 0.78, post: 'pronounced', fov: 0.72,
    g: function () { return JRG.rifle(2).concat(JRG.ring(2, { spin: JRPI / 2 })); }, up: [52, 57], ab: 'decoy', ps: 'seer',
    bl: 'It sees the entire arena — every tank, all the time, no sight range at all. The camera pulls so far back that everything on it looks small and reachable.' },

  // METRONOME
  { id: 36, n: 'Rewind', br: 'horo', t: 2, sd: 12, sz: 98, hp: 2600, bd: 20, sp: 0.84, post: 'jrgear',
    g: function () { return JRG.ring(5, { reload: 1.6 }); }, up: [53, 75], ab: 'rewind', ps: 'beat',
    bl: 'Three seconds of history on a ring buffer, and a button that spends it. Position, health, the lot — you were never there and you were never hit.' },

  { id: 37, n: 'Inversion', br: 'horo', t: 2, sd: 10, sz: 96, hp: 2400, bd: 20, sp: 0.80, post: 'jrgear',
    g: function () { return JRG.cannon(3); }, up: [53, 75], ab: 'dilate', ps: 'invert',
    bl: 'Its stats are whoever is winning, mirrored. Beat the leaderboard and it withers; fall behind it and it becomes the answer to the person in front.' },

  { id: 38, n: 'Pauper', br: 'horo', t: 2, sd: 14, sz: 100, hp: 2600, bd: 22, sp: 0.86, post: 'jrplates',
    g: function () { return JRG.ring(8, { reload: 2.1 }); }, up: [53, 75], ab: 'rewind', ps: 'decay',
    bl: 'It respawns richer than it died and spends it: every death takes a slice of its maximum health permanently. One life at full power, then decline.' },

  // ARSENAL
  { id: 39, n: 'Howitzer', br: 'arsenal', t: 2, sd: 5, sz: 104, hp: 2900, bd: 20, sp: 0.50, pre: 'jrplinth', post: 'jrframe',
    g: function () { return JRG.mortar(); }, up: [54, 76], ab: 'mortar', ps: 'dug',
    bl: 'One barrel, one shell, and the shell bursts. MORTAR lobs it where the cursor is instead of where the barrel points, which is what makes a wall a suggestion.' },

  { id: 40, n: 'Obelisk', br: 'arsenal', t: 2, sd: 4, sz: 100, hp: 3000, bd: 22, sp: 0.60, post: 'jrframe',
    g: function () { return JRG.cannon(2, { spread: 0.34 }).concat(JRG.ring(2, { spin: JRPI / 2 })); }, up: [54, 76], ab: 'harden', ps: 'still',
    bl: 'Completely invulnerable while it is standing still and holding fire. A statue that picks the moment it stops being one.' },

  { id: 41, n: 'Tower', br: 'arsenal', t: 2, sd: 6, sz: 116, hp: 4200, bd: 24, sp: 0.16, pre: 'jrplinth', post: 'auto3', fov: 0.74,
    g: function () { return JRG.rifle(2).concat(JRG.cannon(2, { spread: 0.4 })); }, up: [54, 76], ab: 'turrets', ps: 'rooted',
    bl: 'It hardly moves at all — a sixth of a normal tank. What it gets for that is range, four thousand health, three turrets and a camera that sees them coming.' },

  // PARASITE
  { id: 42, n: 'Puppeteer', br: 'parasite', t: 2, sd: 7, sz: 96, hp: 2300, bd: 18, sp: 0.84, post: 'jrfangs',
    g: function () { return JRG.needles(2).concat(JRG.factory(3)); }, up: [55, 77], ab: 'hijack',
    bl: 'HIJACK takes every enemy drone in range and makes them yours for five seconds. Against a Broodmother that is thirty-two of them, briefly.' },

  { id: 43, n: 'Anchor', br: 'parasite', t: 2, sd: 5, sz: 100, hp: 2900, bd: 26, sp: 0.72, post: 'jrtusks',
    g: function () { return JRG.needles(3).concat(JRG.traps(1, { spin: JRPI })); }, up: [55, 77], ab: 'tether', ps: 'chain',
    bl: 'TETHER chains it to the nearest tank. Neither of you gets more than twelve hundred units from the other until one of you is dead. Usually them.' },

  { id: 44, n: 'Gnat', br: 'parasite', t: 2, sd: 3, sz: 58, hp: 1500, bd: 30, sp: 1.50, ar: 0.30, post: 'jrfangs',
    g: function () { return JRG.needles(6, { reload: 0.8, spread: 0.32 }); }, up: [55, 77], ab: 'infest', ps: 'latch',
    bl: 'Half the size of anything else in the mode and three times the speed. Its contact damage ignores armour entirely, which is what a Leviathan is made of.' },

  // ---- tier 3: eleven endings and six wilds ----------------------------
  { id: 45, n: 'Citadel', br: 'warden', t: 3, sd: 14, sz: 132, hp: 6200, bd: 24, sp: 0.40, pre: 'dombase', post: 'auto5',
    g: function () { return JRG.traps(10, { reload: 3, life: 12, hp: 30 }); }, up: [66, 68, 80], ab: 'barricade',
    bl: 'Ten launchers, five auto-turrets, a double plinth and a top speed under half a normal tank. It does not chase you. It becomes somewhere you cannot go.' },

  { id: 46, n: 'Broodmother', br: 'reaper', t: 3, sd: 10, sz: 124, hp: 5000, bd: 18, sp: 0.76, post: 'spike',
    g: function () {
      return JRG.hangar(10, { angle: JRPI, size: 110, width: 92 })
        .concat(JRG.hangar(8, { angle: JRPI * 0.55, delay: 0.25, size: 100, width: 84 }))
        .concat(JRG.hangar(8, { angle: -JRPI * 0.55, delay: 0.5, size: 100, width: 84 }))
        .concat(JRG.hangar(6, { angle: 0, delay: 0.75, size: 96, width: 80, speed: 1.6, dmg: 0.5 }));
    }, up: [63, 67, 82], ab: 'swarm', ps: 'choir',
    bl: 'Thirty-two drones out of four hangars, and a SWARM that throws every one of them at whoever you are looking at.' },

  { id: 47, n: 'Leviathan', br: 'bulwark', t: 3, sd: 20, sz: 152, hp: 8600, bd: 54, sp: 0.58, post: 'megasmasher', me: true,
    g: function () { return []; }, up: [64, 78, 79], ab: 'slam',
    bl: 'Twenty sides, 8,600 health, 54 contact damage, no barrels, and a slam that clears a nine-hundred-unit circle.' },

  { id: 48, n: 'Event Horizon', br: 'lode', t: 3, sd: 12, sz: 128, hp: 5400, bd: 30, sp: 0.62, post: 'jrhalo',
    g: function () { return JRG.ring(3, { dmg: 0.8 }).concat(JRG.flak(1)); }, up: [64, 65, 81], ab: 'pull', ps: 'well',
    bl: 'A real singularity welded to the hull. Bullets curve into it, tanks fall toward it, and anything that crosses the inner ring is simply gone.' },

  { id: 49, n: 'Meltdown', br: 'cinder', t: 3, sd: 8, sz: 122, hp: 5000, bd: 34, sp: 0.72, post: 'jrcore',
    g: function () { return JRG.ember(8); }, up: [62, 63, 79], ab: 'overload', ps: 'heat',
    bl: 'Every point of damage it takes is banked as heat. At full heat OVERLOAD detonates the screen — and drops it to one health instead of killing it. Once per life.' },

  { id: 50, n: 'Permafrost', br: 'rime', t: 3, sd: 6, sz: 130, hp: 5600, bd: 28, sp: 0.56, post: 'jrshard',
    g: function () { return JRG.cryo(8).concat(JRG.traps(2, { spin: JRPI, color: '#BFEFFF' })); }, up: [62, 69, 82], ab: 'slick', ps: 'chill',
    bl: 'SLICK lays a sheet of ice with no friction on it at all. Everyone else is now skating; a hull this slow was never going to be anywhere in a hurry anyway.' },

  { id: 51, n: 'Ossuary', br: 'siphon', t: 3, sd: 9, sz: 124, hp: 5200, bd: 26, sp: 0.70, post: 'jrfangs',
    g: function () { return JRG.hangar(8, { color: '#8C2438', size: 104, width: 88 }).concat(JRG.siphon(2)); }, up: [66, 70], ab: 'raise', ps: 'husks',
    bl: 'The husks stop being a swarm and become a wall: they orbit the hull as armour, and it can eat them for an instant heal when the wall stops being useful.' },

  { id: 52, n: 'Hydra', br: 'effigy', t: 3, sd: 11, sz: 120, hp: 4600, bd: 24, sp: 0.86, post: 'jrveil',
    g: function () { return JRG.phase(7); }, up: [67, 71, 81], ab: 'decoy', ps: 'split',
    bl: 'Killing it is the start of the problem. A Hydra that dies comes apart into three half-size Hydras, and they are all still angry.' },

  { id: 53, n: 'Chronoform', br: 'horo', t: 3, sd: 12, sz: 126, hp: 5200, bd: 26, sp: 0.78, post: 'jrgear',
    g: function () { return JRG.ring(6, { reload: 1.5 }).concat(JRG.cannon(2)); }, up: [68, 71, 83], ab: 'dilate', ps: 'beat',
    bl: 'A field where other people\'s clocks run slow. Their reloads stretch, their bullets crawl, and the Chronoform keeps its own time.' },

  { id: 54, n: 'Fortress', br: 'arsenal', t: 3, sd: 8, sz: 136, hp: 6400, bd: 28, sp: 0.34, pre: 'jrplinth', post: 'auto5', fov: 0.76,
    g: function () { return JRG.cannon(4, { spread: 0.26 }).concat(JRG.mortar()); }, up: [65, 69, 80], ab: 'turrets', ps: 'dug',
    bl: 'Four cannons, a mortar, five turrets and a plinth. TURRETS plants six more that keep firing for fifteen seconds after it walks away, which it does at a third of walking pace.' },

  { id: 55, n: 'Usurper', br: 'parasite', t: 3, sd: 7, sz: 118, hp: 4400, bd: 30, sp: 0.88, post: 'jrfangs',
    g: function () { return JRG.needles(4).concat(JRG.hangar(4)); }, up: [70, 78, 83], ab: 'hijack', ps: 'usurp',
    bl: 'Kill a juggernaut and keep a piece of it: a barrel off the hull you killed is bolted onto yours, permanently. A late-round Usurper is a monstrosity nobody designed.' },

  // the six wilds — reachable off one branch each, and endings in themselves
  { id: 56, n: 'The Hollow', wd: 1, br: 'bulwark', t: 3, sd: 16, sz: 126, hp: 3600, bd: 44, sp: 0.80, post: 'jrcrown', me: true,
    g: function () { return []; }, up: [64, 78, 79], ab: 'slam', ps: 'hollow',
    bl: 'Bullets do not work on it. Not reduced — they stop dead at the shell and fall apart. The only thing that kills a Hollow is another body.' },

  { id: 57, n: 'Tessellate', wd: 1, br: 'effigy', t: 3, sd: 4, sz: 118, hp: 4800, bd: 22, sp: 0.80, post: 'jrplates',
    g: function () { return JRG.phase(4).concat(JRG.orbit(4)); }, up: [67, 71, 81], ab: 'shatter', ps: 'segments',
    bl: 'Its health is not in the hull. It is in four segments orbiting the hull, and you have to break each of them separately — while SHATTER fires them off as shrapnel.' },

  { id: 58, n: 'Kingmaker', wd: 1, br: 'siphon', t: 3, sd: 10, sz: 120, hp: 4600, bd: 24, sp: 0.74, post: 'jrhalo',
    g: function () { return JRG.cannon(3, { spread: 0.24 }).concat(JRG.ring(2, { spin: JRPI / 2 })); }, up: [66, 70], ab: 'reap', ps: 'stacks',
    bl: 'It gets stronger every time anybody anywhere dies, whoever killed them. Patience is the build. The last ten minutes of a round belong to it.' },

  { id: 59, n: 'Nomad', wd: 1, br: 'rime', t: 3, sd: 5, sz: 112, hp: 4000, bd: 26, sp: 1.02, post: 'jrtusks',
    g: function () { return JRG.needles(4).concat(JRG.cannon(1)); }, up: [62, 69, 82], ab: 'blink', ps: 'far',
    bl: 'Everything it has scales with how far it is from the middle of the map. In the nest it is a nuisance. In the corners it is the reason nobody goes there.' },

  { id: 60, n: 'Wrecking Ball', wd: 1, br: 'bulwark', t: 3, sd: 18, sz: 130, hp: 5800, bd: 46, sp: 0.66, post: 'megasmasher', me: true,
    g: function () { return []; }, up: [64, 78, 79], ab: 'quake', ps: 'swing',
    bl: 'A mass on a long chain, orbiting it. The ball hits harder than the hull does, and QUAKE whips it out to twice the radius at twice the speed.' },

  { id: 61, n: 'Devourer', wd: 1, br: 'lode', t: 3, sd: 12, sz: 122, hp: 5200, bd: 32, sp: 0.64, post: 'jrhalo',
    g: function () { return JRG.flak(2); }, up: [64, 65, 81], ab: 'pull', ps: 'grow',
    bl: 'Every projectile its field swallows makes it physically bigger. A well-fed Devourer ends the round too large for the gaps it wanted to fit through.' },

  // ---- tier 4: the fusions ---------------------------------------------
  { id: 62, n: 'Thermocline', br: 'fusion', hx: '#6B4A6E', t: 4, dy: 'rime', sd: 10, sz: 146, hp: 8600, bd: 40, sp: 0.66, post: 'jrcore',
    tone: '255,150,90', tone2: '150,225,255',
    g: function () { return JRG.cryo(4).concat(JRG.ember(4, { spin: JRPI / 4 })); }, up: [85, 97], ab: 'thermal', ps: 'thermal',
    bl: 'CINDER x RIME. It alternates: four seconds of a burning ring, four seconds of a freezing one, and THERMAL fires whichever one it is currently holding.' },

  { id: 63, n: 'Ashbrood', br: 'fusion', hx: '#7A3A3A', t: 4, dy: 'pyre', sd: 9, sz: 142, hp: 8000, bd: 34, sp: 0.74, post: 'jrcore',
    tone: '255,140,55', tone2: '205,140,255',
    g: function () {
      return JRG.hangar(10, { color: '#FF7A2E', angle: JRPI, size: 108, width: 90 })
        .concat(JRG.hangar(8, { color: '#FF9A4E', angle: JRPI * 0.6, delay: 0.4, size: 98, width: 82 }))
        .concat(JRG.ember(4, { spin: JRPI / 8 }));
    }, up: [84, 96], ab: 'swarm', ps: 'ashbrood',
    bl: 'CINDER x REAPER. Eighteen drones that set fire to what they touch. The swarm does not have to kill you; it only has to reach you.' },

  { id: 64, n: 'Worldbreaker', br: 'fusion', hx: '#6B4030', t: 4, dy: 'titan', sd: 22, sz: 168, hp: 11500, bd: 58, sp: 0.54, post: 'jrmega', me: true,
    tone: '255,150,90', tone2: '130,150,255',
    g: function () { return []; }, up: [91, 98], ab: 'quake', ps: 'well',
    bl: 'BULWARK x LODESTONE. The largest thing in the mode, and it pulls you into it. There is no version of this fight where the spacing is yours.' },

  { id: 65, n: 'Voidforge', br: 'fusion', hx: '#37416E', t: 4, dy: 'siege', sd: 8, sz: 156, hp: 9500, bd: 36, sp: 0.34, pre: 'jrplinth', post: 'auto5', fov: 0.74,
    tone: '130,150,255', tone2: '190,205,225',
    g: function () { return JRG.flak(2, { reload: 5.5 }).concat(JRG.mortar()); }, up: [90, 99], ab: 'pull', ps: 'well',
    bl: 'LODESTONE x ARSENAL. It roots, it drags you into range, and then it drops a mortar on the spot you have just been dragged to.' },

  { id: 66, n: 'Necropolis', br: 'fusion', hx: '#4E5B3E', t: 4, dy: 'wall', sd: 16, sz: 152, hp: 9200, bd: 34, sp: 0.44, pre: 'dombase', post: 'auto5',
    tone: '150,220,140', tone2: '255,80,105',
    g: function () {
      return JRG.traps(10, { color: '#7A3346', reload: 3, life: 12, hp: 30 })
        .concat(JRG.hangar(6, { color: '#8C2438', angle: JRPI, size: 100, width: 84 }))
        .concat(JRG.factory(3, { color: '#8C2438', angle: 0 }));
    }, up: [88, 100], ab: 'raise', ps: 'husks',
    bl: 'WARDEN x LEECH. A wall that gets up and follows you. Whatever dies against its traps stands back up on the Necropolis\'s side.' },

  { id: 67, n: 'Wraithhive', br: 'fusion', hx: '#3A5E6B', t: 4, dy: 'voidd', sd: 11, sz: 144, hp: 7800, bd: 28, sp: 0.86, post: 'jrveil', iv: true, fov: 0.80,
    tone: '150,255,230', tone2: '205,140,255',
    g: function () { return JRG.hangar(12, { color: '#CFF6EC', size: 104, width: 88 }).concat(JRG.phase(4)); }, up: [86, 101], ab: 'swarm', ps: 'mirror',
    bl: 'EFFIGY x REAPER. Stop firing and the whole hive fades out — hull, decoys, twelve drones and all. It arrives as an empty patch of map.' },

  { id: 68, n: 'Horologium', br: 'fusion', hx: '#6E5F2E', t: 4, dy: 'time', sd: 14, sz: 150, hp: 9000, bd: 34, sp: 0.56, pre: 'dombase', post: 'jrgear',
    tone: '255,220,120', tone2: '150,220,140',
    g: function () { return JRG.traps(8, { color: '#B8A24A', reload: 3.2, life: 11 }).concat(JRG.ring(4, { reload: 1.5 })); }, up: [89, 102], ab: 'dilate', ps: 'beat',
    bl: 'METRONOME x WARDEN. A trap field with time running slow inside it. Walking into the wall is bad; walking into the wall at half speed is the point.' },

  { id: 69, n: 'Aurora Lance', br: 'fusion', hx: '#3B6B7E', t: 4, dy: 'siege', sd: 7, sz: 148, hp: 8400, bd: 32, sp: 0.48, pre: 'jrplinth', post: 'jrshard', fov: 0.72,
    tone: '150,225,255', tone2: '190,205,225',
    g: function () {
      return JRG.rifle(3, { color: '#BFEFFF', reload: 3.8 })
        .concat(JRG.cryo(2, { reload: 3 }))
        .concat(JRG.lance(2, { color: '#BFEFFF' }));
    }, up: [90, 99], ab: 'beam', ps: 'chill',
    bl: 'RIME x ARSENAL. BEAM is a channelled line of cold that holds for a second and a half, freezes what it touches, and does not care what is between you.' },

  { id: 70, n: 'Plaguelord', br: 'fusion', hx: '#5B6B2A', t: 4, dy: 'flesh', sd: 9, sz: 146, hp: 8200, bd: 38, sp: 0.80, post: 'jrfangs',
    tone: '200,240,90', tone2: '255,80,105',
    g: function () { return JRG.needles(6, { color: '#C8F05A' }).concat(JRG.hangar(6, { color: '#9BBF3A' })); }, up: [87, 103], ab: 'infest', ps: 'plague',
    bl: 'PARASITE x LEECH. Everything within reach is bleeding, and every drop of it is going into the Plaguelord. It does not need to finish anyone.' },

  { id: 71, n: 'Gorgon', br: 'fusion', hx: '#4A5E5A', t: 4, dy: 'time', sd: 13, sz: 144, hp: 8000, bd: 30, sp: 0.88, post: 'jrveil',
    tone: '150,255,230', tone2: '255,220,120',
    g: function () { return JRG.phase(6).concat(JRG.orbit(6, { angle: JRPI })); }, up: [89, 102], ab: 'blink', ps: 'split',
    bl: 'EFFIGY x METRONOME. It blinks, it rewinds, it leaves copies, and when you finally kill the right one it comes apart into three more.' },

  // ---- tier 3, the second ending of the five branches that only had one ----
  // Every branch now ends in at least two hulls, so the card at level 36 is a
  // choice rather than an announcement. Each of these is the opposite number of
  // the ending it stands beside: where the Citadel stops moving, the Labyrinth
  // never does; where the Fortress plants itself, the Ballista walks away.
  { id: 72, n: 'Labyrinth', br: 'warden', t: 3, sd: 9, sz: 120, hp: 4800, bd: 30, sp: 0.80, post: 'jrplates',
    g: function () { return JRG.traps(6, { reload: 2.2, life: 14, hp: 26 }).concat(JRG.ring(3, { spin: JRPI / 3 })); },
    up: [66, 68, 80], ab: 'barricade', ps: 'thorns',
    bl: 'The Warden that will not stand still. Six launchers on a fourteen-second fuse and a hull quick enough to lay them somewhere useful, which is how an open field becomes a corridor with you at the end of it.' },

  { id: 73, n: 'Hivewright', br: 'reaper', t: 3, sd: 12, sz: 122, hp: 4900, bd: 20, sp: 0.80, post: 'jrhalo',
    g: function () {
      return JRG.factory(5).concat(JRG.hangar(8, { angle: JRPI, size: 104, width: 88 }))
        .concat(JRG.orbit(5, { angle: JRPI * 0.5 }));
    }, up: [63, 67, 82], ab: 'swarm', ps: 'choir',
    bl: 'The Broodmother throws children. The Hivewright builds them: five minions off a factory, eight drones out of the hangar and a ring of orbiters that never leaves. It does not swarm you so much as move in.' },

  { id: 74, n: 'Conflagration', br: 'cinder', t: 3, sd: 7, sz: 120, hp: 4700, bd: 36, sp: 0.86, post: 'jrcore',
    g: function () { return JRG.ember(6).concat(JRG.traps(3, { spin: JRPI, color: '#9A3F1C', reload: 2.4, life: 7 })); },
    up: [62, 63, 79], ab: 'ignite', ps: 'trail',
    bl: 'The Meltdown banks its heat and spends it once. The Conflagration never stops spending: burning ground behind it, six embers in front, and a hull fast enough to run the fire wherever it wants it.' },

  { id: 75, n: 'Aeon', br: 'horo', t: 3, sd: 16, sz: 126, hp: 5100, bd: 26, sp: 0.82, post: 'jrgear',
    g: function () { return JRG.ring(8, { reload: 1.4 }).concat(JRG.cannon(3, { spread: 0.22 })); },
    up: [68, 71, 83], ab: 'rewind', ps: 'invert',
    bl: 'It is exactly as strong as the person in front of it is winning. Sit in first place and an Aeon is a nuisance; put it in last and it is the arena’s own correction, with three seconds of history to spend on top.' },

  { id: 76, n: 'Ballista', br: 'arsenal', t: 3, sd: 6, sz: 128, hp: 5500, bd: 26, sp: 0.44, pre: 'jrplinth', post: 'auto5', fov: 0.70,
    g: function () { return JRG.rifle(3, { reload: 3.6 }).concat(JRG.lance(2)).concat(JRG.cryo(1, { reload: 4 })); },
    up: [65, 69, 80], ab: 'deploy', ps: 'dug',
    bl: 'Range instead of walls. Three rifles, two spinning lances and a camera that sees the far side of the fight — and DEPLOY, so it picks the one moment it stops being able to run.' },

  { id: 77, n: 'Changeling', br: 'parasite', t: 3, sd: 8, sz: 118, hp: 4500, bd: 34, sp: 0.94, post: 'jrtusks',
    g: function () { return JRG.needles(5, { reload: 1.0 }).concat(JRG.factory(3, { color: '#C8F05A' })); },
    up: [70, 78, 83], ab: 'tether', ps: 'latch',
    bl: 'The Usurper keeps what it kills. The Changeling keeps what it is holding: chained to you, latched onto you, draining your score while three of its children finish the argument.' },

  // ---- tier 4: six more fusions, so every branch marries at least twice ----
  { id: 78, n: 'Ironmaw', br: 'fusion', hx: '#5B3A2E', t: 4, dy: 'titan', sd: 18, sz: 150, hp: 10500, bd: 52, sp: 0.78, post: 'jrtusks', me: true,
    tone: '255,150,90', tone2: '200,240,90',
    g: function () { return []; }, up: [91, 98], ab: 'infest', ps: 'latch',
    bl: 'BULWARK x PARASITE. No barrels, and it does not need any: it closes, it fastens on, and from then on your score is going somewhere else while the contact damage does the rest.' },

  { id: 79, n: 'Caldera', br: 'fusion', hx: '#7A3A22', t: 4, dy: 'pyre', sd: 12, sz: 154, hp: 10000, bd: 50, sp: 0.68, post: 'jrcore',
    tone: '255,150,90', tone2: '255,140,55',
    g: function () { return JRG.ember(6).concat(JRG.flak(1)); }, up: [84, 96], ab: 'overload', ps: 'pyre',
    bl: 'BULWARK x CINDER. A walking crater. It hits harder the closer it is to dying, and the last quarter of a Caldera’s life is the most dangerous ring of ground in the arena.' },

  { id: 80, n: 'Bastille', br: 'fusion', hx: '#41503E', t: 4, dy: 'wall', sd: 10, sz: 152, hp: 10200, bd: 32, sp: 0.36, pre: 'dombase', post: 'auto7', fov: 0.74,
    tone: '150,220,140', tone2: '190,205,225',
    g: function () {
      return JRG.traps(8, { reload: 3, life: 12, hp: 30 })
        .concat(JRG.cannon(3, { spread: 0.28 })).concat(JRG.mortar());
    }, up: [88, 100], ab: 'turrets', ps: 'dug',
    bl: 'WARDEN x ARSENAL. Eight launchers, three cannons, a mortar, seven turrets and a plinth. It does not hold ground. It replaces it.' },

  { id: 81, n: 'Nullpoint', br: 'fusion', hx: '#2E3A5E', t: 4, dy: 'voidd', sd: 11, sz: 146, hp: 8800, bd: 36, sp: 0.86, post: 'jrveil', iv: true, fov: 0.80,
    tone: '130,150,255', tone2: '150,255,230',
    g: function () { return JRG.phase(5).concat(JRG.flak(1)); }, up: [86, 101], ab: 'blink', ps: 'well',
    bl: 'LODESTONE x EFFIGY. A singularity you cannot see. Your bullets bend toward a patch of empty map, which is the only warning you get.' },

  { id: 82, n: 'Frostbrood', br: 'fusion', hx: '#2C5A70', t: 4, dy: 'rime', sd: 10, sz: 148, hp: 9200, bd: 30, sp: 0.80, post: 'jrshard',
    tone: '150,225,255', tone2: '205,140,255',
    g: function () {
      return JRG.hangar(12, { color: '#BFEFFF', size: 106, width: 90 })
        .concat(JRG.cryo(4, { reload: 2.6 }));
    }, up: [85, 97], ab: 'freeze', ps: 'chill',
    bl: 'RIME x REAPER. Twelve drones and a cold field. You cannot outrun the flock because you cannot run, and the FREEZE lands on whatever is left standing still.' },

  { id: 83, n: 'Cordyceps', br: 'fusion', hx: '#5A5A24', t: 4, dy: 'flesh', sd: 9, sz: 144, hp: 8800, bd: 40, sp: 0.90, post: 'jrfangs',
    tone: '200,240,90', tone2: '255,220,120',
    g: function () { return JRG.needles(6, { color: '#C8F05A' }).concat(JRG.factory(4, { color: '#C8F05A' })); },
    up: [87, 103], ab: 'dilate', ps: 'plague',
    bl: 'PARASITE x METRONOME. Everything near it is bleeding and everything near it is slow. The fight does not get away from a Cordyceps; it just takes longer for you than it does for it.' },

  // ---- tier 5: the apexes ------------------------------------------------
  // Level 70. Two branches married at tier 4; these are what that marriage
  // grows into, and they are not meant to be fair. Every hull past fusion also
  // draws the tier dividend in jrTickTank on top of the numbers written here.
  { id: 84, n: 'Ragnarok', br: 'apex', hx: '#7A3A1E', t: 5, dy: 'pyre', sd: 14, sz: 176, hp: 15000, bd: 62, sp: 0.70, post: 'jrapex',
    tone: '255,140,55', tone2: '255,150,90',
    g: function () { return JRG.ember(8).concat(JRG.flak(2)).concat(JRG.mortar()); },
    up: [93, 104], ab: 'overload', abs: ['ignite'], ps: ['pyre', 'heat'], tr: ['aegis', 'wake'],
    bl: 'Eight embers, two flak guns and a mortar on a hull that burns hotter the closer it gets to dying — and banks every point of damage you land on it to spend back at you in one go.' },

  { id: 85, n: 'Absolute Zero', br: 'apex', hx: '#1E4A63', t: 5, dy: 'rime', sd: 6, sz: 178, hp: 15500, bd: 50, sp: 0.60, post: 'jrapex', fov: 0.72,
    tone: '150,225,255', tone2: '190,205,225',
    g: function () {
      return JRG.cryo(8).concat(JRG.spread(2, { color: '#BFEFFF', sides: 6, pellets: 11 }))
        .concat(JRG.lance(2, { color: '#BFEFFF' }));
    }, up: [105, 106], ab: 'slick', abs: ['freeze'], ps: ['chill', 'sovereign'], tr: ['aegis', 'dread'],
    bl: 'The cold field is no longer a debuff, it is the terrain. Twenty-two shards a volley into a ring where nobody can turn, on ice nobody can steer.' },

  { id: 86, n: 'Oblivion', br: 'apex', hx: '#232C5B', t: 5, dy: 'voidd', sd: 13, sz: 172, hp: 14500, bd: 56, sp: 0.68, post: 'jrapex',
    tone: '130,150,255', tone2: '150,255,230',
    g: function () { return JRG.flak(2, { reload: 5 }).concat(JRG.ring(4, { dmg: 0.9, reload: 2 })); },
    up: [94, 112], ab: 'pull', abs: ['collapse'], ps: ['well'], tr: ['aegis', 'pierce'],
    bl: 'A hull with a real singularity in it. Bullets curve in and die, tanks fall in and do not come out, and PULL simply decides where you were going to be.' },

  { id: 87, n: 'Legion', br: 'apex', hx: '#3E2A5B', t: 5, dy: 'flesh', sd: 12, sz: 168, hp: 13500, bd: 40, sp: 0.84, post: 'jrapex',
    tone: '205,140,255', tone2: '200,240,90',
    g: function () {
      return JRG.hangar(14, { angle: JRPI, size: 112, width: 94 })
        .concat(JRG.hangar(10, { angle: JRPI * 0.55, delay: 0.33, size: 104, width: 86 }))
        .concat(JRG.hangar(10, { angle: -JRPI * 0.55, delay: 0.66, size: 104, width: 86 }))
        .concat(JRG.factory(4));
    }, up: [95, 115], ab: 'swarm', abs: ['conscript'], ps: ['choir'], tr: ['retinue', 'overclock'],
    bl: 'Thirty-four drones, four minions, and a passive that makes each of them better for every one of the others still alive. There is no version of this you fight alone.' },

  { id: 88, n: 'Sepulchre', br: 'apex', hx: '#5B2233', t: 5, dy: 'wall', sd: 11, sz: 172, hp: 14800, bd: 46, sp: 0.66, pre: 'dombase', post: 'jrapex',
    tone: '255,80,105', tone2: '150,220,140',
    g: function () {
      return JRG.hangar(10, { color: '#8C2438', size: 108, width: 90 })
        .concat(JRG.siphon(4)).concat(JRG.traps(6, { color: '#7A3346', reload: 3, life: 11 }));
    }, up: [110, 111], ab: 'raise', abs: ['citadel'], ps: ['husks'], tr: ['aegis', 'regalia'],
    bl: 'Everything that has ever died near it is still working. The husks orbit as armour until it needs the health more than the wall, and then it eats them.' },

  { id: 89, n: 'Paradox', br: 'apex', hx: '#4A4A2E', t: 5, dy: 'time', sd: 15, sz: 166, hp: 13000, bd: 44, sp: 0.92, post: 'jrapex', iv: true, fov: 0.78,
    tone: '255,220,120', tone2: '150,255,230',
    g: function () { return JRG.phase(8).concat(JRG.orbit(6, { angle: JRPI })).concat(JRG.ring(4, { reload: 1.4 })); },
    up: [113, 114], ab: 'dilate', abs: ['stasis'], ps: ['split', 'beat'], tr: ['blinkstep', 'aegis'],
    bl: 'Invisible, in a field where your clock runs slow, and it comes apart into two more of itself when you finally hit the real one. You are not losing this fight; you are losing it twice.' },

  { id: 90, n: 'Ordnance', br: 'apex', hx: '#2E3540', t: 5, dy: 'siege', sd: 8, sz: 180, hp: 16000, bd: 44, sp: 0.26, pre: 'jrplinth', post: 'auto7', fov: 0.68,
    tone: '190,205,225', tone2: '255,220,120',
    g: function () {
      return JRG.cannon(5, { spread: 0.22 }).concat(JRG.mortar())
        .concat(JRG.rifle(3, { reload: 3.4 })).concat(JRG.lance(2));
    }, up: [108, 109], ab: 'turrets', abs: ['meteor'], ps: ['dug'], tr: ['retinue', 'bulwark'],
    bl: 'A quarter of walking pace, sixteen thousand health, and eleven barrels that reach the other side of the screen. It is not a tank. It is a map feature with a firing solution.' },

  { id: 91, n: 'Behemoth', br: 'apex', hx: '#5B3A24', t: 5, dy: 'titan', sd: 24, sz: 196, hp: 20000, bd: 74, sp: 0.62, post: 'jrmega', me: true,
    tone: '255,150,90', tone2: '205,205,220',
    g: function () { return []; }, up: [92, 107], ab: 'quake', abs: ['rupture'], ps: ['swing'], tr: ['bulwark', 'pierce'],
    bl: 'Twenty thousand health, seventy-four contact damage, a wrecking mass on a chain and not one barrel. Whatever you brought, it was not enough of it.' },

  // ---- tier 6: the omegas ------------------------------------------------
  // Level 100, the cap, and the end of the wheel. Four of them, and reaching
  // one is the whole round.
  { id: 92, n: 'Apotheosis', br: 'omega', hx: '#4A2E5B', t: 6, dy: 'titan', sd: 20, sz: 210, hp: 26000, bd: 70, sp: 0.78, post: 'jromega',
    tone: '255,235,255', tone2: '255,220,120',
    g: function () {
      return JRG.ring(8, { reload: 1.2, dmg: 0.9 }).concat(JRG.cannon(4, { spread: 0.22 }))
        .concat(JRG.hangar(8, { angle: JRPI, size: 108, width: 90 }))
        .concat(JRG.ember(4, { spin: JRPI / 8 })).concat(JRG.cryo(4, { spin: JRPI / 4 }));
    }, up: [120, 121], ab: 'ascend', abs: ['judgement', 'arc'], ps: ['choir', 'sovereign'],
    tr: ['aegis', 'revive', 'regalia'],
    bl: 'Every branch at once: ring guns, cannons, a hangar, embers and cryo on one twenty-sided hull — and ASCEND, which fills the bar, burns off every status riding on it and makes it very nearly unkillable for four seconds.' },

  { id: 93, n: 'Extinction', br: 'omega', hx: '#5B2E1E', t: 6, dy: 'pyre', sd: 10, sz: 216, hp: 24000, bd: 62, sp: 0.34, pre: 'jrplinth', post: 'auto9', fov: 0.62,
    tone: '255,140,55', tone2: '190,205,225',
    g: function () {
      return JRG.mortar().concat(JRG.flak(3, { reload: 6 }))
        .concat(JRG.cannon(4, { spread: 0.2 })).concat(JRG.rifle(3, { reload: 3.2 }));
    }, up: [116, 117], ab: 'nova', abs: ['meteor', 'eclipse'], ps: ['dug', 'ruin'],
    tr: ['retinue', 'bulwark', 'wake'],
    bl: 'Nine turrets, eleven barrels, a camera that sees a third of the arena, and NOVA — a detonation the width of the screen that sets fire to everything it does not simply throw off the map.' },

  { id: 94, n: 'Singularity', br: 'omega', hx: '#1E2447', t: 6, dy: 'voidd', sd: 16, sz: 204, hp: 23000, bd: 66, sp: 0.70, post: 'jromega',
    tone: '130,150,255', tone2: '255,255,255',
    g: function () { return JRG.flak(3, { reload: 5.5 }).concat(JRG.ring(6, { dmg: 1.0, reload: 1.8 })).concat(JRG.lance(2)); },
    up: [126, 127], ab: 'pull', abs: ['collapse', 'unmake'], ps: ['well', 'sovereign'],
    tr: ['pierce', 'aegis', 'dread'],
    bl: 'The Event Horizon grown up. Two hundred units of body with a real well inside it: your shots feed it, your tank falls into it, and the inner ring does not damage things so much as end them.' },

  { id: 95, n: 'Ouroboros', br: 'omega', hx: '#4A1E2E', t: 6, dy: 'flesh', sd: 18, sz: 200, hp: 22000, bd: 64, sp: 0.80, post: 'jromega',
    tone: '255,80,105', tone2: '200,240,90',
    g: function () {
      return JRG.hangar(12, { color: '#8C2438', size: 110, width: 92 })
        .concat(JRG.needles(6, { color: '#C8F05A' })).concat(JRG.siphon(4));
    }, up: [130, 131], ab: 'raise', abs: ['conscript', 'warpstorm'], ps: ['split', 'undying'],
    tr: ['vampire', 'tithe', 'revive'],
    bl: 'Killing it is a formality it has already priced in. Everything it hurts feeds it, everything it kills gets back up, and when the hull finally goes it comes apart into two more Ouroboros.' },

  // ---- tier 5: the second apex of every dynasty --------------------------
  // Level 70, and the point where the tree stops being a lattice. The fusion
  // you took at 52 put you in one of eight dynasties, and from here up the
  // cards are that dynasty's and nobody else's. Every hull at this height also
  // carries something the fusions did not: an autonomous button that fires
  // itself, a second passive, and traits — the things that are not verbs at all.
  { id: 96, n: 'Pyroclast', br: 'apex', dy: 'pyre', t: 5, sd: 9, sz: 172, hp: 14200, bd: 58, sp: 0.76, post: 'jrapex',
    g: function () { return JRG.ember(10).concat(JRG.starfall(3)); },
    up: [93, 104], ab: 'eclipse', abs: ['ignite'], ps: ['trail', 'pyre'], tr: ['wake', 'overclock'],
    bl: 'The Ragnarok banks its heat and spends it once. The Pyroclast never banks anything: ten embers, three mortars in a ring, burning ground under everywhere it has been, and an ECLIPSE that puts a lid of fire on top of all of it.' },

  { id: 97, n: 'Whiteout', br: 'apex', dy: 'rime', t: 5, sd: 6, sz: 174, hp: 15200, bd: 46, sp: 0.62, post: 'jrapex', fov: 0.70,
    g: function () { return JRG.cryo(8).concat(JRG.spread(2, { color: '#BFEFFF', sides: 6, pellets: 10 })); },
    up: [105, 106], ab: 'stasis', abs: ['freeze'], ps: ['chill', 'sovereign'], tr: ['dread', 'aegis'],
    bl: 'STASIS stops the screen. Not the ring, not the reach — everything the Whiteout can see stands still for two seconds while twenty shards a volley arrive, and the cold field means nobody was going anywhere fast to begin with.' },

  { id: 98, n: 'Atlas', br: 'apex', dy: 'titan', t: 5, sd: 22, sz: 190, hp: 19000, bd: 70, sp: 0.60, post: 'jrmega', me: true,
    g: function () { return []; },
    up: [92, 107], ab: 'rupture', abs: ['quake'], ps: ['thorns', 'momentum'], tr: ['bulwark', 'growth'],
    bl: 'Nineteen thousand health, no barrels, and a cap on what any one hit is allowed to take off it. RUPTURE tears the ground open in a line to the cursor, and the Atlas keeps getting bigger for as long as it is allowed to stand there.' },

  { id: 99, n: 'Bombard', br: 'apex', dy: 'siege', t: 5, sd: 7, sz: 178, hp: 15800, bd: 44, sp: 0.36, pre: 'jrplinth', post: 'auto7', fov: 0.68,
    g: function () { return JRG.starfall(4).concat(JRG.cannon(4, { spread: 0.2 })).concat(JRG.spine(2)); },
    up: [108, 109], ab: 'meteor', abs: ['turrets'], ps: ['dug'], tr: ['retinue', 'bulwark'],
    bl: 'Four mortars in a ring, two masts, four cannons and seven turrets on a plinth. METEOR is not one shell where the cursor is — it is nine, walked across the whole area, and none of them care what is in the way.' },

  { id: 100, n: 'Rampart', br: 'apex', dy: 'wall', t: 5, sd: 12, sz: 180, hp: 16500, bd: 48, sp: 0.44, pre: 'dombase', post: 'auto7',
    g: function () {
      return JRG.traps(10, { reload: 2.8, life: 13, hp: 32 })
        .concat(JRG.cannon(3, { spread: 0.26 })).concat(JRG.hangar(6, { color: '#8C2438' }));
    },
    up: [110, 111], ab: 'citadel', abs: ['barricade'], ps: ['husks', 'thorns'], tr: ['aegis', 'regalia'],
    bl: 'CITADEL builds a fort out of nothing: a full ring of trap walls, six turrets inside it, and a Rampart in the middle regrowing a slab of armour every time you stop hitting it for five seconds.' },

  { id: 101, n: 'Umbra', br: 'apex', dy: 'voidd', t: 5, sd: 12, sz: 170, hp: 13800, bd: 48, sp: 0.90, iv: true, post: 'jrapex', fov: 0.76,
    g: function () { return JRG.phase(8).concat(JRG.flak(1)).concat(JRG.orbit(6)); },
    up: [94, 112], ab: 'collapse', abs: ['blink'], ps: ['well', 'mirror'], tr: ['blinkstep', 'pierce'],
    bl: 'An invisible well that steps sideways out of the world every seven seconds whether you hit it or not. COLLAPSE drags the entire screen into one point and then lets go of it.' },

  { id: 102, n: 'Epoch', br: 'apex', dy: 'time', t: 5, sd: 16, sz: 168, hp: 13600, bd: 46, sp: 0.90, post: 'jrapex',
    g: function () { return JRG.ring(8, { reload: 1.3 }).concat(JRG.cannon(4, { spread: 0.2 })).concat(JRG.orbit(6)); },
    up: [113, 114], ab: 'stasis', abs: ['rewind'], ps: ['beat', 'invert'], tr: ['blinkstep', 'overclock'],
    bl: 'It rewinds itself without being asked, it phases out of reach on a timer, and the more of you there are around it the faster it fires. Whatever is winning the round, an Epoch is built out of the gap.' },

  { id: 103, n: 'Hollowbrood', br: 'apex', dy: 'flesh', t: 5, sd: 10, sz: 174, hp: 14000, bd: 54, sp: 0.88, post: 'jrapex',
    g: function () {
      return JRG.hangar(14, { color: '#C8F05A' }).concat(JRG.needles(6, { color: '#C8F05A' }))
        .concat(JRG.factory(4, { color: '#C8F05A' }));
    },
    up: [95, 115], ab: 'conscript', abs: ['infest'], ps: ['plague', 'choir'], tr: ['vampire', 'tithe'],
    bl: 'CONSCRIPT turns every polygon and every corpse in reach into something that fights for it, all at once. Everything it damages bleeds, everything that bleeds pays it, and the flock is never the same size twice.' },

  // ---- tier 6: sixteen omegas, two per dynasty ---------------------------
  // Level 100 used to be the end of the wheel. It is now the halfway mark, and
  // the four that were here have been joined by twelve more so that every
  // dynasty gets a fork rather than a coronation. Two autonomous buttons, two
  // passives and three traits each — an omega is not a big tank, it is a boss
  // fight that happens to have a pilot.
  { id: 104, n: 'Solaris', br: 'omega', dy: 'pyre', t: 6, sd: 13, sz: 208, hp: 24500, bd: 66, sp: 0.68, post: 'jromega',
    g: function () { return JRG.ember(10).concat(JRG.hellbore(1)).concat(JRG.starfall(4)); },
    up: [116, 117], ab: 'meteor', abs: ['overload', 'ignite'], ps: ['pyre', 'ruin'],
    tr: ['aegis', 'wake', 'regalia'],
    bl: 'One shell the size of a Colossus, four mortars, ten embers, and ground behind it that never stops burning. It heals like a boss, shields like a boss and calls down a barrage without being told to.' },

  { id: 105, n: 'Fimbulwinter', br: 'omega', dy: 'rime', t: 6, sd: 8, sz: 210, hp: 25500, bd: 60, sp: 0.56, post: 'jromega', fov: 0.68,
    g: function () { return JRG.cryo(10).concat(JRG.hellbore(1)).concat(JRG.lance(2, { color: '#BFEFFF' })); },
    up: [118, 119], ab: 'terraform', abs: ['stasis', 'freeze'], ps: ['chill', 'ruin'],
    tr: ['aegis', 'dread', 'bulwark'],
    bl: 'TERRAFORM stops being weather and becomes geography: a ring of ice, fire and gravity laid down at once, and every one of them is the Fimbulwinter\'s. Nobody standing in it is steering and nobody near it is shooting straight.' },

  { id: 106, n: 'Glasswinter', br: 'omega', dy: 'rime', t: 6, sd: 12, sz: 204, hp: 23000, bd: 64, sp: 0.72, post: 'jromega',
    g: function () {
      return JRG.cryo(8).concat(JRG.spine(3, { color: '#BFEFFF' })).concat(JRG.orbit(8, { color: '#BFEFFF' }));
    },
    up: [118, 119], ab: 'beam', abs: ['slick', 'freeze'], ps: ['chill', 'beat'],
    tr: ['reflect', 'aegis', 'blinkstep'],
    bl: 'Shoot it and your own round comes back at you with your name still on it. Three masts, a channelled beam of cold, and a shell that turns bullets around inside its own radius.' },

  { id: 107, n: 'Godhulk', br: 'omega', dy: 'titan', t: 6, sd: 26, sz: 218, hp: 30000, bd: 88, sp: 0.62, post: 'jrmega', me: true,
    g: function () { return []; },
    up: [120, 121], ab: 'quake', abs: ['rupture', 'warpstorm'], ps: ['swing', 'thorns'],
    tr: ['bulwark', 'aegis', 'revive'],
    bl: 'Thirty thousand health, no weapon, a mass on a chain and a cap on every hit that lands. WARPSTORM drags whoever was keeping their distance into the one place a Godhulk has ever needed anybody to be.' },

  { id: 108, n: 'Annihilation', br: 'omega', dy: 'siege', t: 6, sd: 10, sz: 214, hp: 26000, bd: 58, sp: 0.30, pre: 'jrplinth', post: 'auto9', fov: 0.62,
    g: function () {
      return JRG.hellbore(2).concat(JRG.starfall(5)).concat(JRG.spine(3)).concat(JRG.cannon(4, { spread: 0.2 }));
    },
    up: [122, 123], ab: 'meteor', abs: ['judgement', 'turrets'], ps: ['dug', 'sovereign'],
    tr: ['retinue', 'bulwark', 'aegis'],
    bl: 'Fourteen barrels, nine turrets, four permanent escorts and a third of walking pace. JUDGEMENT does not travel: it takes a share of the maximum health off everything on the screen, and there is no cover from arithmetic.' },

  { id: 109, n: 'Siege Perilous', br: 'omega', dy: 'siege', t: 6, sd: 8, sz: 206, hp: 23500, bd: 62, sp: 0.44, pre: 'dombase', post: 'auto9',
    g: function () {
      return JRG.traps(10, { reload: 2.8, life: 13, hp: 34 }).concat(JRG.starfall(3))
        .concat(JRG.cannon(3, { spread: 0.26 }));
    },
    up: [122, 123], ab: 'citadel', abs: ['meteor', 'turrets'], ps: ['dug', 'ruin'],
    tr: ['retinue', 'aegis', 'dread'],
    bl: 'The Annihilation is a gun emplacement. The Siege Perilous is the siege: walls it builds itself, mortars over the top of them, and a ring of ground around it where everybody else reloads slower than they should.' },

  { id: 110, n: 'Sanctum', br: 'omega', dy: 'wall', t: 6, sd: 14, sz: 212, hp: 27000, bd: 60, sp: 0.40, pre: 'dombase', post: 'auto9',
    g: function () {
      return JRG.traps(12, { reload: 2.6, life: 14, hp: 36 }).concat(JRG.cannon(4, { spread: 0.24 }))
        .concat(JRG.starfall(3));
    },
    up: [124, 125], ab: 'citadel', abs: ['barricade', 'enthrone'], ps: ['husks', 'thorns'],
    tr: ['aegis', 'regalia', 'bulwark'],
    bl: 'Twelve launchers, nine turrets and a husk wall that eats itself for health when the wall stops being the useful half. ENTHRONE fires on its own the moment it is properly hurt: full bar, every cooldown back, and it starts again.' },

  { id: 111, n: 'Necrarch', br: 'omega', dy: 'wall', t: 6, sd: 11, sz: 206, hp: 24000, bd: 68, sp: 0.62, pre: 'dombase', post: 'jromega',
    g: function () {
      return JRG.hangar(12, { color: '#8C2438', size: 108, width: 90 })
        .concat(JRG.traps(8, { color: '#7A3346', reload: 3, life: 12 })).concat(JRG.siphon(4));
    },
    up: [124, 125], ab: 'conscript', abs: ['raise', 'reap'], ps: ['husks', 'drain'],
    tr: ['vampire', 'aegis', 'retinue'],
    bl: 'The Sanctum holds ground. The Necrarch takes yours with it: a fifth of everything it deals comes straight back as health, the wall walks, and CONSCRIPT stands the whole graveyard up at once.' },

  { id: 112, n: 'Null Sovereign', br: 'omega', dy: 'voidd', t: 6, sd: 14, sz: 206, hp: 23500, bd: 62, sp: 0.82, iv: true, post: 'jromega', fov: 0.70,
    g: function () { return JRG.phase(10).concat(JRG.flak(2)).concat(JRG.orbit(8)).concat(JRG.spine(2)); },
    up: [126, 127], ab: 'unmake', abs: ['collapse', 'blink'], ps: ['well', 'split'],
    tr: ['blinkstep', 'pierce', 'aegis'],
    bl: 'UNMAKE deletes every shot on the screen that is not its own — bullets, traps, drones, the lot — and the hull that did it was never visible in the first place. Kill it and it comes apart into two more.' },

  { id: 113, n: 'Eternity', br: 'omega', dy: 'time', t: 6, sd: 18, sz: 204, hp: 23000, bd: 58, sp: 0.86, post: 'jromega',
    g: function () {
      return JRG.ring(10, { reload: 1.15 }).concat(JRG.cannon(4, { spread: 0.2 }))
        .concat(JRG.orbit(8)).concat(JRG.spine(2));
    },
    up: [128, 129], ab: 'epoch', abs: ['stasis', 'rewind'], ps: ['beat', 'sovereign'],
    tr: ['blinkstep', 'aegis', 'regalia'],
    bl: 'EPOCH does to the arena what REWIND did to one tank: everything hostile on the screen is put back where it stood three seconds ago and held there while it works out what happened.' },

  { id: 114, n: 'Zero Hour', br: 'omega', dy: 'time', t: 6, sd: 15, sz: 208, hp: 24500, bd: 66, sp: 0.78, iv: true, post: 'jromega', fov: 0.72,
    g: function () { return JRG.phase(8).concat(JRG.ring(6, { reload: 1.3 })).concat(JRG.lance(2)); },
    up: [128, 129], ab: 'stasis', abs: ['epoch', 'dilate'], ps: ['beat', 'split'],
    tr: ['blinkstep', 'reflect', 'aegis'],
    bl: 'Invisible, on a four-second beat, phasing out of the world on a timer, turning your own bullets around, and it comes apart into two when it dies. Every single thing about a Zero Hour is a reason your shot did not land.' },

  { id: 115, n: 'Hivegod', br: 'omega', dy: 'flesh', t: 6, sd: 12, sz: 206, hp: 23500, bd: 66, sp: 0.84, post: 'jromega',
    g: function () {
      return JRG.hangar(16, { color: '#C8F05A', size: 110, width: 92 }).concat(JRG.factory(5, { color: '#C8F05A' }))
        .concat(JRG.needles(6, { color: '#C8F05A' })).concat(JRG.orbit(8, { color: '#C8F05A' }));
    },
    up: [130, 131], ab: 'conscript', abs: ['swarm', 'dominion'], ps: ['choir', 'plague'],
    tr: ['vampire', 'tithe', 'retinue'],
    bl: 'Sixteen drones, five minions, eight orbiters and four escorts, every one of them better for every other one still alive. DOMINION means that for twelve seconds anything it kills gets back up on its side and stays there.' },

  // ---- tier 7: the titans ------------------------------------------------
  // Level 140. Two per dynasty, and the tier where the numbers stop pretending:
  // forty to fifty-five thousand health, a hundred-odd contact damage, three
  // autonomous buttons, three passives and four traits. The dividend at the
  // bottom of jrTickTank halves incoming damage again on top of all of it.
  { id: 116, n: 'Sunkiller', br: 'titan', dy: 'pyre', t: 7, sd: 16, sz: 246, hp: 44000, bd: 104, sp: 0.66, post: 'jrtitan',
    g: function () { return JRG.ember(12).concat(JRG.hellbore(2)).concat(JRG.starfall(5)); },
    up: [132], ab: 'eclipse', abs: ['meteor', 'overload', 'ignite'], ps: ['pyre', 'ruin', 'sovereign'],
    tr: ['aegis', 'wake', 'regalia', 'pierce'],
    bl: 'Nineteen barrels of fire, a permanent scar of burning ground behind it, and a hull that gets stronger the more of you turn up. It does not aim the barrage. It just keeps calling for it.' },

  { id: 117, n: 'Cataclysm', br: 'titan', dy: 'pyre', t: 7, sd: 11, sz: 240, hp: 41000, bd: 118, sp: 0.74, post: 'jrtitan',
    g: function () {
      return JRG.ember(8).concat(JRG.spread(3, { pellets: 11, color: '#FF7A2E' })).concat(JRG.flak(2));
    },
    up: [132], ab: 'rupture', abs: ['ignite', 'avatar'], ps: ['heat', 'trail', 'pyre'],
    tr: ['wake', 'bulwark', 'overclock', 'vampire'],
    bl: 'AVATAR is eight seconds of being twice the tank: bigger, harder, faster, and hitting like the thing it was already too big to be. Thirty-three pellets a volley, and a fifth of everything it lands comes back as health.' },

  { id: 118, n: 'Everwinter', br: 'titan', dy: 'rime', t: 7, sd: 8, sz: 250, hp: 46000, bd: 98, sp: 0.56, post: 'jrtitan', fov: 0.66,
    g: function () { return JRG.cryo(12).concat(JRG.hellbore(2)).concat(JRG.starfall(4, { color: '#BFEFFF' })); },
    up: [133], ab: 'terraform', abs: ['stasis', 'freeze', 'slick'], ps: ['chill', 'ruin', 'sovereign'],
    tr: ['aegis', 'dread', 'bulwark', 'regalia'],
    bl: 'It does not fight in the arena. It replaces it: ice with no friction, ground that never thaws, a field where you take longer to do everything and it does not, and a stasis on top when it wants the ground clear.' },

  { id: 119, n: 'Rimelord', br: 'titan', dy: 'rime', t: 7, sd: 14, sz: 242, hp: 42000, bd: 110, sp: 0.70, post: 'jrtitan',
    g: function () {
      return JRG.cryo(10).concat(JRG.spine(4, { color: '#BFEFFF' })).concat(JRG.lance(3, { color: '#BFEFFF' }));
    },
    up: [133], ab: 'beam', abs: ['stasis', 'freeze'], ps: ['chill', 'beat'],
    tr: ['reflect', 'pierce', 'aegis', 'overclock'],
    bl: 'Four masts and a beam that does not care what is between you, on a hull that hands your own shots back and hits through armour as though it were not there. The cold is just how it keeps you in the line.' },

  { id: 120, n: 'Worldspine', br: 'titan', dy: 'titan', t: 7, sd: 28, sz: 258, hp: 54000, bd: 132, sp: 0.60, post: 'jrtitan', me: true,
    g: function () { return []; },
    up: [134], ab: 'rupture', abs: ['quake', 'warpstorm', 'avatar'], ps: ['swing', 'thorns', 'sovereign'],
    tr: ['bulwark', 'aegis', 'revive', 'pierce'],
    bl: 'Fifty-four thousand health, a hundred and thirty-two contact damage, twenty-eight sides, no barrels, a death it simply does not take the first time, and a hard ceiling on what any single hit is permitted to remove.' },

  { id: 121, n: 'Colossus Prime', br: 'titan', dy: 'titan', t: 7, sd: 18, sz: 248, hp: 47000, bd: 116, sp: 0.72, post: 'jrtitan',
    g: function () {
      return JRG.hellbore(2).concat(JRG.cannon(4, { spread: 0.24 })).concat(JRG.ring(6, { dmg: 1.0, reload: 1.6 }));
    },
    up: [134], ab: 'avatar', abs: ['quake', 'judgement'], ps: ['momentum', 'thorns'],
    tr: ['bulwark', 'growth', 'overclock', 'retinue'],
    bl: 'The Worldspine gave up its guns for the body. The Colossus Prime refused to: two hellbores on a hull that still rams, four escorts that never expire, and it has not finished growing.' },

  { id: 122, n: 'Siegebreaker', br: 'titan', dy: 'siege', t: 7, sd: 12, sz: 252, hp: 46000, bd: 96, sp: 0.42, pre: 'jrplinth', post: 'auto12', fov: 0.62,
    g: function () {
      return JRG.hellbore(3).concat(JRG.starfall(6)).concat(JRG.spine(4)).concat(JRG.cannon(5, { spread: 0.18 }));
    },
    up: [135], ab: 'meteor', abs: ['judgement', 'turrets', 'unmake'], ps: ['dug', 'sovereign', 'ruin'],
    tr: ['retinue', 'bulwark', 'aegis', 'pierce'],
    bl: 'Eighteen barrels, twelve turrets, six escorts and a camera that reaches most of the map. It deletes the screen\'s worth of incoming fire on a timer and then bills everybody on it for a share of their own maximum health.' },

  { id: 123, n: 'Ordinator', br: 'titan', dy: 'siege', t: 7, sd: 10, sz: 244, hp: 43000, bd: 104, sp: 0.54, pre: 'dombase', post: 'auto12',
    g: function () {
      return JRG.traps(12, { reload: 2.6, life: 14, hp: 36 }).concat(JRG.starfall(4))
        .concat(JRG.lance(3)).concat(JRG.rifle(3, { reload: 3 }));
    },
    up: [135], ab: 'citadel', abs: ['meteor', 'turrets', 'arc'], ps: ['dug', 'ruin'],
    tr: ['retinue', 'aegis', 'dread', 'overclock'],
    bl: 'It builds the fort, garrisons it, and then starts throwing lightning between everybody who came to look at it. ARC does not need a line of sight to the second target, only to the first.' },

  { id: 124, n: 'Aegis Eternal', br: 'titan', dy: 'wall', t: 7, sd: 16, sz: 254, hp: 50000, bd: 92, sp: 0.40, pre: 'dombase', post: 'auto12',
    g: function () {
      return JRG.traps(14, { reload: 2.4, life: 16, hp: 40 }).concat(JRG.cannon(5, { spread: 0.22 }))
        .concat(JRG.starfall(4));
    },
    up: [136], ab: 'citadel', abs: ['barricade', 'enthrone', 'turrets'], ps: ['husks', 'thorns', 'sovereign'],
    tr: ['aegis', 'regalia', 'bulwark', 'reflect'],
    bl: 'Fourteen launchers, twelve turrets, a husk wall, a shield that grows back, a cap on incoming hits, a fifth of your own fire returned to sender, and a throne it climbs back onto every time you nearly take it off.' },

  { id: 125, n: 'Dread Keep', br: 'titan', dy: 'wall', t: 7, sd: 13, sz: 248, hp: 45000, bd: 108, sp: 0.62, pre: 'dombase', post: 'jrtitan',
    g: function () {
      return JRG.hangar(14, { color: '#8C2438', size: 110, width: 92 })
        .concat(JRG.traps(10, { color: '#7A3346', reload: 2.8, life: 13 })).concat(JRG.siphon(5));
    },
    up: [136], ab: 'conscript', abs: ['raise', 'reap', 'dominion'], ps: ['husks', 'drain', 'ruin'],
    tr: ['vampire', 'tithe', 'aegis', 'dread'],
    bl: 'A fortress that follows you. Everything inside its reach fights worse, everything it touches pays it in score, everything it kills gets up again, and the ground it walks over never stops being its.' },

  { id: 126, n: 'Eventide', br: 'titan', dy: 'voidd', t: 7, sd: 15, sz: 250, hp: 45000, bd: 100, sp: 0.74, post: 'jrtitan',
    g: function () { return JRG.hellbore(2).concat(JRG.ring(6, { dmg: 1.1, reload: 1.6 })).concat(JRG.lance(3)); },
    up: [137], ab: 'collapse', abs: ['unmake', 'pull', 'judgement'], ps: ['well', 'sovereign'],
    tr: ['aegis', 'pierce', 'dread', 'bulwark'],
    bl: 'A real horizon on a two-hundred-and-fifty-unit body. Your bullets die on the way in, your tank arrives whether it meant to or not, and COLLAPSE decides where the whole screen is standing when it goes off.' },

  { id: 127, n: 'Abyssal', br: 'titan', dy: 'voidd', t: 7, sd: 13, sz: 244, hp: 41000, bd: 94, sp: 0.86, iv: true, post: 'jrtitan', fov: 0.68,
    g: function () { return JRG.phase(12).concat(JRG.flak(2)).concat(JRG.orbit(10)).concat(JRG.spine(3)); },
    up: [137], ab: 'unmake', abs: ['collapse', 'blink', 'stasis'], ps: ['well', 'split', 'mirror'],
    tr: ['blinkstep', 'pierce', 'aegis', 'reflect'],
    bl: 'Invisible, phasing, decoyed, splitting, reflecting and pulling — six separate reasons the shot you took was the wrong shot, on a hull that erases the rest of them off the board anyway.' },

  { id: 128, n: 'Aeon Engine', br: 'titan', dy: 'time', t: 7, sd: 20, sz: 250, hp: 45000, bd: 96, sp: 0.84, post: 'jrtitan',
    g: function () {
      return JRG.ring(12, { reload: 1.05 }).concat(JRG.cannon(5, { spread: 0.18 }))
        .concat(JRG.orbit(10)).concat(JRG.spine(3));
    },
    up: [138], ab: 'epoch', abs: ['stasis', 'rewind', 'judgement'], ps: ['beat', 'sovereign', 'invert'],
    tr: ['blinkstep', 'aegis', 'regalia', 'overclock'],
    bl: 'Twenty barrels on a four-second beat, a field where your clock runs slow, and a button that puts the arena back three seconds. It is exactly as strong as whoever is beating it, which is a threat rather than a weakness.' },

  { id: 129, n: 'Causality', br: 'titan', dy: 'time', t: 7, sd: 17, sz: 246, hp: 42500, bd: 104, sp: 0.88, iv: true, post: 'jrtitan', fov: 0.68,
    g: function () {
      return JRG.phase(10).concat(JRG.ring(8, { reload: 1.2 })).concat(JRG.lance(3)).concat(JRG.orbit(8));
    },
    up: [138], ab: 'stasis', abs: ['epoch', 'dilate', 'arc'], ps: ['beat', 'split', 'mirror'],
    tr: ['blinkstep', 'reflect', 'aegis', 'pierce'],
    bl: 'You do not get to have the last three seconds. It holds the screen, walks the arena backwards, splits when it dies, and every big hit you land throws another copy of it off to the side.' },

  { id: 130, n: 'Swarm Sovereign', br: 'titan', dy: 'flesh', t: 7, sd: 14, sz: 250, hp: 44000, bd: 98, sp: 0.82, post: 'jrtitan',
    g: function () {
      return JRG.hangar(18, { color: '#C8F05A', size: 112, width: 94 }).concat(JRG.factory(6, { color: '#C8F05A' }))
        .concat(JRG.orbit(12, { color: '#C8F05A' })).concat(JRG.needles(6, { color: '#C8F05A' }));
    },
    up: [139], ab: 'conscript', abs: ['swarm', 'dominion', 'arc'], ps: ['choir', 'plague', 'sovereign'],
    tr: ['vampire', 'tithe', 'retinue', 'aegis'],
    bl: 'Thirty-six of it, and every one of them makes the rest better. It does not kill you so much as run out of room, and everything it does kill is back on the field before the feed has finished saying so.' },

  { id: 131, n: 'Carrion King', br: 'titan', dy: 'flesh', t: 7, sd: 12, sz: 246, hp: 47000, bd: 112, sp: 0.78, post: 'jrtitan',
    g: function () {
      return JRG.siphon(6).concat(JRG.hangar(12, { color: '#8C2438', size: 110, width: 92 }))
        .concat(JRG.needles(8, { color: '#D4324F' }));
    },
    up: [139], ab: 'dominion', abs: ['reap', 'raise', 'conscript'], ps: ['husks', 'bleed', 'undying'],
    tr: ['vampire', 'tithe', 'executioner', 'aegis'],
    bl: 'Everything it hurts bleeds, everything that bleeds it can see, and anything under a tenth of its health that touches the hull simply stops. The lower a Carrion King goes the faster it comes back.' },

  // ---- tier 8: the crowns ------------------------------------------------
  // Level 200, the cap, and the end of every road. Eight of them, one for each
  // dynasty, and the only card in the mode that is not a choice — by this point
  // there is exactly one thing left to become and you decided which at level 52.
  // Four autonomous buttons, three passives and six traits apiece.
  { id: 132, n: 'Solar Tyrant', br: 'crown', dy: 'pyre', t: 8, sd: 20, sz: 300, hp: 84000, bd: 168, sp: 0.70, post: 'jrgod',
    g: function () {
      return JRG.ember(14).concat(JRG.hellbore(3)).concat(JRG.starfall(6)).concat(JRG.spine(3));
    },
    up: [], ab: 'apocalypse', abs: ['meteor', 'eclipse', 'overload', 'enthrone'],
    ps: ['pyre', 'ruin', 'tyrant'], tr: ['aegis', 'revive', 'regalia', 'wake', 'pierce', 'warcry'],
    bl: 'APOCALYPSE sets the visible arena on fire — not a ring, the screen — and the Solar Tyrant is standing in the middle of it healing. While it leads the board everybody else is quietly losing health for the privilege of being in the same round.' },

  { id: 133, n: 'Absolute Winter', br: 'crown', dy: 'rime', t: 8, sd: 6, sz: 306, hp: 88000, bd: 152, sp: 0.60, post: 'jrgod', fov: 0.58,
    g: function () {
      return JRG.cryo(14).concat(JRG.hellbore(3)).concat(JRG.spine(4, { color: '#BFEFFF' }))
        .concat(JRG.starfall(6, { color: '#BFEFFF' }));
    },
    up: [], ab: 'stasis', abs: ['terraform', 'enthrone', 'freeze', 'slick'],
    ps: ['chill', 'ruin', 'tyrant'], tr: ['aegis', 'revive', 'regalia', 'dread', 'bulwark', 'reflect'],
    bl: 'Six sides, three hundred units across, and the arena around it is ice, scar and fog. It holds the screen still, hands your own fire back, caps what any hit may take, and the round belongs to it for as long as it is standing.' },

  { id: 134, n: 'World Engine', br: 'crown', dy: 'titan', t: 8, sd: 30, sz: 320, hp: 96000, bd: 200, sp: 0.62, post: 'jrgod', me: true,
    g: function () { return []; },
    up: [], ab: 'rupture', abs: ['quake', 'warpstorm', 'avatar', 'enthrone'],
    ps: ['swing', 'thorns', 'tyrant'], tr: ['bulwark', 'aegis', 'revive', 'regalia', 'growth', 'executioner'],
    bl: 'Ninety-six thousand health, two hundred contact damage, thirty sides, one wrecking mass on a chain and not a single barrel anywhere on it. Anything badly hurt that touches it is not hurt any more. It is finished.' },

  { id: 135, n: 'Last Word', br: 'crown', dy: 'siege', t: 8, sd: 14, sz: 312, hp: 90000, bd: 150, sp: 0.40, pre: 'jrplinth', post: 'auto12', fov: 0.56,
    g: function () {
      return JRG.hellbore(3).concat(JRG.starfall(6)).concat(JRG.spine(4))
        .concat(JRG.cannon(5, { spread: 0.16 })).concat(JRG.mortar());
    },
    up: [], ab: 'judgement', abs: ['meteor', 'unmake', 'turrets', 'enthrone'],
    ps: ['dug', 'sovereign', 'tyrant'], tr: ['retinue', 'bulwark', 'aegis', 'revive', 'regalia', 'pierce'],
    bl: 'Nineteen barrels, twelve turrets, eight escorts and a camera that sees over half the arena. JUDGEMENT has no travel time, no line of sight and no counterplay: it simply takes a share of everybody\'s maximum health, everywhere, at once.' },

  { id: 136, n: 'Eternal Bastion', br: 'crown', dy: 'wall', t: 8, sd: 18, sz: 308, hp: 92000, bd: 158, sp: 0.42, pre: 'dombase', post: 'jrgod',
    g: function () {
      return JRG.traps(16, { reload: 2.2, life: 18, hp: 44 }).concat(JRG.cannon(6, { spread: 0.2 }))
        .concat(JRG.starfall(6)).concat(JRG.hangar(10, { color: '#8C2438', size: 110, width: 92 }));
    },
    up: [], ab: 'citadel', abs: ['barricade', 'conscript', 'enthrone', 'turrets'],
    ps: ['husks', 'thorns', 'tyrant'], tr: ['aegis', 'regalia', 'bulwark', 'revive', 'reflect', 'retinue'],
    bl: 'It does not take ground. It becomes it: sixteen launchers laying wall, six turret escorts inside the wall, a husk shell around the escorts, and a hull under all of it that grows its armour back faster than most tanks reload.' },

  { id: 137, n: 'Endless Night', br: 'crown', dy: 'voidd', t: 8, sd: 18, sz: 302, hp: 82000, bd: 156, sp: 0.78, iv: true, post: 'jrgod', fov: 0.58,
    g: function () {
      return JRG.hellbore(3).concat(JRG.phase(10)).concat(JRG.orbit(12)).concat(JRG.spine(4)).concat(JRG.flak(2));
    },
    up: [], ab: 'collapse', abs: ['unmake', 'warpstorm', 'enthrone', 'blink'],
    ps: ['well', 'split', 'tyrant'], tr: ['blinkstep', 'pierce', 'aegis', 'revive', 'reflect', 'omniscient'],
    bl: 'Three hundred units of invisible horizon that sees everything, is seen by nothing, deletes the screen\'s fire on a timer, drags you into it, hands your own rounds back, and splits in two if you somehow finish it.' },

  { id: 138, n: 'Final Hour', br: 'crown', dy: 'time', t: 8, sd: 24, sz: 298, hp: 80000, bd: 148, sp: 0.86, post: 'jrgod',
    g: function () {
      return JRG.ring(14, { reload: 0.95, dmg: 1.0 }).concat(JRG.cannon(6, { spread: 0.16 }))
        .concat(JRG.orbit(12)).concat(JRG.spine(4)).concat(JRG.phase(6));
    },
    up: [], ab: 'epoch', abs: ['stasis', 'judgement', 'enthrone', 'rewind'],
    ps: ['beat', 'sovereign', 'tyrant'], tr: ['blinkstep', 'aegis', 'revive', 'regalia', 'reflect', 'overclock'],
    bl: 'Thirty-six barrels on a hull that phases out of the world every seven seconds, holds the screen still whenever it likes, and walks the whole arena back three seconds when it does not like how the last three went.' },

  { id: 139, n: 'The Devouring', br: 'crown', dy: 'flesh', t: 8, sd: 16, sz: 296, hp: 86000, bd: 162, sp: 0.82, post: 'jrgod',
    g: function () {
      return JRG.hangar(20, { color: '#8C2438', size: 114, width: 96 }).concat(JRG.factory(6, { color: '#C8F05A' }))
        .concat(JRG.siphon(6)).concat(JRG.needles(8, { color: '#D4324F' }))
        .concat(JRG.orbit(12, { color: '#C8F05A' }));
    },
    up: [], ab: 'dominion', abs: ['conscript', 'judgement', 'enthrone', 'reap'],
    ps: ['husks', 'plague', 'tyrant'], tr: ['vampire', 'tithe', 'executioner', 'revive', 'aegis', 'regalia'],
    bl: 'Forty-four things on the field and every one of them is it. Everything it damages bleeds into it, everything it kills stands back up for it, anything nearly dead that touches it is simply gone, and it does not accept the first death you hand it.' }
];

// =========================================================================
// Juggernaut Armageddon's roster — five tiers past the crowns
// =========================================================================
//
// The Royale ends at level 200 with eight crowns. Armageddon does not: every
// crown opens onto its dynasty's two ASCENDANTS at 240, they open onto two
// ARCHONS at 300, and then the dynasties that were sealed apart at level 52
// start marrying again. Eight PRIMORDIALS at 370, each the union of two
// neighbouring dynasties on a ring, so every archon chooses which neighbour it
// becomes. Both ESCHATONS at 440 sit on top of all eight, and the one thing at
// 500 sits on top of both:
//
//   9  ascendant   240   16   two per dynasty
//   10 archon      300   16   two per dynasty
//   11 primordial  370    8   pyre-titan-siege-wall-flesh-void-chrono-glacier
//   12 eschaton    440    2   First Light, Last Dark
//   13 armageddon  500    1
//
// The rows are the Royale's own shape (see the key above JR_HULLS) with one
// addition: `lb` names a hull's family when it has no single dynasty to name,
// and `raw` paints the hull exactly the colour written.
//
// Every tier is meant to be MORE than the one below it in every column at
// once — another self-firing verb, another passive, another trait, a bigger
// hull, more health, and a dividend in jrTickTank that is a bigger step than
// the one before it. A crown carries four verbs it fires itself and six traits;
// the Armageddon carries ten and twelve.

var JA_BASE = 256;

var JA_HULLS = [
  // ---- tier 9: the ascendants, level 240 ----------------------------------
  { id: 0, n: 'Helios', br: 'ascendant', dy: 'pyre', t: 9, sd: 22, sz: 344, hp: 158000, bd: 270, sp: 0.70, post: 'jrascend',
    g: function () { return JRG.ember(14).concat(JRG.hellbore(3)).concat(JRG.starfall(6)).concat(JRG.godspear(2)); },
    up: [16, 17], ab: 'supernova', abs: ['apocalypse', 'meteor', 'eclipse', 'overload', 'enthrone'],
    ps: ['pyre', 'ruin', 'corona'], tr: ['aegis', 'revive', 'regalia', 'wake', 'pierce', 'warcry', 'echo'],
    bl: 'The Solar Tyrant set the screen on fire once. Helios does it three times a press, a second apart, and every one of the five verbs it fires itself lands twice.' },

  { id: 1, n: 'Phoenix Throne', br: 'ascendant', dy: 'pyre', t: 9, sd: 14, sz: 336, hp: 150000, bd: 290, sp: 0.80, post: 'jrascend',
    g: function () { return JRG.gatling(6, { color: '#FF9A4E' }).concat(JRG.ember(12)).concat(JRG.nova(6)); },
    up: [16, 17], ab: 'fissure', abs: ['ignite', 'meteor', 'avatar', 'eclipse', 'enthrone'],
    ps: ['trail', 'pyre', 'corona'], tr: ['wake', 'vampire', 'overclock', 'revive', 'pierce', 'regalia', 'echo'],
    bl: 'A gatling, a ring of novas and twelve embers on a hull fast enough to drag the fire wherever it likes. FISSURE splits the ground open in eight directions at once.' },

  { id: 2, n: 'Polar Night', br: 'ascendant', dy: 'rime', t: 9, sd: 6, sz: 352, hp: 166000, bd: 250, sp: 0.60, post: 'jrascend', fov: 0.56,
    g: function () { return JRG.cryo(14).concat(JRG.hellbore(3)).concat(JRG.spine(4, { color: '#BFEFFF' })); },
    up: [18, 19], ab: 'timestop', abs: ['stasis', 'terraform', 'freeze', 'slick', 'enthrone'],
    ps: ['chill', 'ruin', 'sovereign'], tr: ['aegis', 'revive', 'regalia', 'dread', 'bulwark', 'reflect', 'nullify'],
    bl: 'TIME STOP holds the screen for four seconds — tanks AND the shots in the air — and nothing you throw at it sticks: burn, freeze and bleed are gone by the end of its own tick.' },

  { id: 3, n: 'Diamond Dust', br: 'ascendant', dy: 'rime', t: 9, sd: 12, sz: 340, hp: 152000, bd: 270, sp: 0.74, post: 'jrascend',
    g: function () {
      return JRG.cryo(10).concat(JRG.godspear(3, { color: '#DFF8FF' }))
        .concat(JRG.gatling(4, { color: '#BFEFFF' })).concat(JRG.orbit(10, { color: '#BFEFFF' }));
    },
    up: [18, 19], ab: 'godray', abs: ['beam', 'stasis', 'freeze', 'slick', 'skyfall'],
    ps: ['chill', 'beat', 'stormcall'], tr: ['reflect', 'pierce', 'aegis', 'blinkstep', 'overclock', 'revive', 'thunder'],
    bl: 'GODRAY is a line of light nine thousand units long that bills everything in it a share of its own health. Lightning falls on its own every second and a half, and some of its hits call more.' },

  { id: 4, n: 'Continent', br: 'ascendant', dy: 'titan', t: 9, sd: 32, sz: 372, hp: 185000, bd: 320, sp: 0.62, post: 'jrascend', me: true,
    g: function () { return []; },
    up: [20, 21], ab: 'fissure', abs: ['rupture', 'quake', 'warpstorm', 'avatar', 'enthrone'],
    ps: ['swing', 'thorns', 'momentum'], tr: ['bulwark', 'aegis', 'revive', 'regalia', 'growth', 'executioner', 'nullify'],
    bl: 'A hundred and eighty-five thousand health, three hundred and twenty contact damage, thirty-two sides and still not one barrel. It is not a tank so much as a landmass that has decided where you are standing.' },

  { id: 5, n: 'Juggernaut Absolute', br: 'ascendant', dy: 'titan', t: 9, sd: 20, sz: 358, hp: 172000, bd: 300, sp: 0.72, post: 'jrascend',
    g: function () { return JRG.hellbore(3).concat(JRG.nova(6)).concat(JRG.cannon(6, { spread: 0.18 })); },
    up: [20, 21], ab: 'rapture', abs: ['quake', 'judgement', 'avatar', 'rupture', 'genesis'],
    ps: ['momentum', 'thorns', 'maelstrom'], tr: ['bulwark', 'growth', 'overclock', 'retinue', 'aegis', 'revive', 'pierce'],
    bl: 'RAPTURE lifts everything in reach off the floor and drops it a second and a half later from a great height. Six blades on a fast orbit, a ring of novas and an army it makes on demand.' },

  { id: 6, n: 'Doomsday Engine', br: 'ascendant', dy: 'siege', t: 9, sd: 14, sz: 360, hp: 168000, bd: 240, sp: 0.40, pre: 'jrplinth', post: 'jrascend', fov: 0.54,
    g: function () {
      return JRG.hellbore(3).concat(JRG.starfall(8)).concat(JRG.godspear(3)).concat(JRG.cannon(6, { spread: 0.16 }));
    },
    up: [22, 23], ab: 'skyfall', abs: ['judgement', 'meteor', 'unmake', 'turrets', 'enthrone'],
    ps: ['dug', 'sovereign', 'tyrant'], tr: ['retinue', 'bulwark', 'aegis', 'revive', 'regalia', 'pierce', 'echo'],
    bl: 'SKYFALL picks the seven nearest things it dislikes and strikes each one from above. With ECHO it picks them again a second later.' },

  { id: 7, n: 'Iron Rain', br: 'ascendant', dy: 'siege', t: 9, sd: 10, sz: 348, hp: 160000, bd: 250, sp: 0.50, pre: 'dombase', post: 'jrascend',
    g: function () { return JRG.starfall(6).concat(JRG.gatling(6)).concat(JRG.mortar()).concat(JRG.lance(3)); },
    up: [22, 23], ab: 'tempest', abs: ['meteor', 'arc', 'turrets', 'citadel', 'skyfall'],
    ps: ['dug', 'ruin', 'stormcall'], tr: ['retinue', 'aegis', 'dread', 'overclock', 'revive', 'pierce', 'thunder'],
    bl: 'TEMPEST is twelve bolts over three seconds, each forking twice. Six mortars, a gatling battery and three lances underneath it, and the sky never quite clears.' },

  { id: 8, n: 'World Wall', br: 'ascendant', dy: 'wall', t: 9, sd: 20, sz: 362, hp: 176000, bd: 250, sp: 0.42, pre: 'dombase', post: 'jrascend',
    g: function () {
      return JRG.traps(18, { reload: 2, life: 20, hp: 48 }).concat(JRG.cannon(6, { spread: 0.2 })).concat(JRG.starfall(6));
    },
    up: [24, 25], ab: 'genesis', abs: ['citadel', 'barricade', 'enthrone', 'turrets', 'conscript'],
    ps: ['husks', 'thorns', 'tyrant'], tr: ['aegis', 'regalia', 'bulwark', 'revive', 'reflect', 'retinue', 'nullify'],
    bl: 'Eighteen launchers, a husk wall, a fort it builds in one press, and GENESIS — eighteen more husks and six escorts out of nothing. It does not hold ground. It populates it.' },

  { id: 9, n: 'Charnel Throne', br: 'ascendant', dy: 'wall', t: 9, sd: 13, sz: 350, hp: 162000, bd: 280, sp: 0.60, pre: 'dombase', post: 'jrascend',
    g: function () {
      return JRG.hangar(14, { color: '#8C2438', size: 112, width: 94 })
        .concat(JRG.traps(12, { color: '#7A3346', reload: 2.4, life: 15 })).concat(JRG.siphon(6));
    },
    up: [24, 25], ab: 'rapture', abs: ['conscript', 'raise', 'reap', 'dominion', 'genesis'],
    ps: ['husks', 'drain', 'ruin'], tr: ['vampire', 'tithe', 'aegis', 'dread', 'revive', 'regalia', 'echo'],
    bl: 'Everything it kills gets up for it, everything it touches pays it, and every army it raises it raises twice.' },

  { id: 10, n: 'Event Zero', br: 'ascendant', dy: 'voidd', t: 9, sd: 18, sz: 346, hp: 150000, bd: 270, sp: 0.80, iv: true, post: 'jrascend', fov: 0.56,
    g: function () {
      return JRG.hellbore(3).concat(JRG.phase(12)).concat(JRG.orbit(12)).concat(JRG.godspear(2));
    },
    up: [26, 27], ab: 'blackhole', abs: ['collapse', 'unmake', 'warpstorm', 'blink', 'enthrone'],
    ps: ['well', 'mirror', 'tyrant'], tr: ['blinkstep', 'pierce', 'aegis', 'revive', 'reflect', 'omniscient', 'echo'],
    bl: 'BLACK HOLE opens a well under your cursor that is not attached to anything — and Event Zero is the invisible well that already was. Two of them, and you are standing between.' },

  { id: 11, n: 'Starless', br: 'ascendant', dy: 'voidd', t: 9, sd: 16, sz: 354, hp: 164000, bd: 260, sp: 0.70, post: 'jrascend',
    g: function () { return JRG.flak(3).concat(JRG.nova(8)).concat(JRG.spine(4)); },
    up: [26, 27], ab: 'timestop', abs: ['collapse', 'pull', 'judgement', 'unmake', 'blackhole'],
    ps: ['well', 'sovereign', 'corona'], tr: ['aegis', 'pierce', 'dread', 'bulwark', 'revive', 'regalia', 'nullify'],
    bl: 'A ring of novas around a singularity, a corona that takes a share of your own bar a second, and a clock it stops whenever you get close enough to matter.' },

  { id: 12, n: 'Clockwork God', br: 'ascendant', dy: 'time', t: 9, sd: 24, sz: 348, hp: 156000, bd: 260, sp: 0.82, post: 'jrascend',
    g: function () {
      return JRG.ring(16, { reload: 0.85, dmg: 1.1 }).concat(JRG.cannon(6, { spread: 0.16 }))
        .concat(JRG.orbit(12)).concat(JRG.spine(4));
    },
    up: [28, 29], ab: 'timestop', abs: ['epoch', 'stasis', 'judgement', 'rewind', 'enthrone'],
    ps: ['beat', 'sovereign', 'quicken'], tr: ['blinkstep', 'aegis', 'revive', 'regalia', 'reflect', 'overclock', 'echo'],
    bl: 'QUICKEN runs every one of its cooldowns at double time, and ECHO lands every verb twice. Thirty-eight barrels on a four-second beat, holding the screen still in between.' },

  { id: 13, n: 'Paradox Eternal', br: 'ascendant', dy: 'time', t: 9, sd: 19, sz: 342, hp: 150000, bd: 280, sp: 0.86, iv: true, post: 'jrascend', fov: 0.58,
    g: function () {
      return JRG.phase(12).concat(JRG.ring(10, { reload: 1 })).concat(JRG.lance(4)).concat(JRG.orbit(10));
    },
    up: [28, 29], ab: 'overdrive', abs: ['stasis', 'epoch', 'dilate', 'arc', 'rewind'],
    ps: ['beat', 'split', 'mirror'], tr: ['blinkstep', 'reflect', 'aegis', 'pierce', 'revive', 'omniscient', 'thunder'],
    bl: 'OVERDRIVE fires every other button the hull has, all at once, loaded or not. The first ascendant whose right-click is the other five.' },

  { id: 14, n: 'Hive Absolute', br: 'ascendant', dy: 'flesh', t: 9, sd: 14, sz: 352, hp: 158000, bd: 270, sp: 0.80, post: 'jrascend',
    g: function () {
      return JRG.hangar(22, { color: '#C8F05A', size: 116, width: 98 }).concat(JRG.factory(8, { color: '#C8F05A' }))
        .concat(JRG.orbit(14, { color: '#C8F05A' })).concat(JRG.needles(8, { color: '#C8F05A' }));
    },
    up: [30, 31], ab: 'genesis', abs: ['conscript', 'swarm', 'dominion', 'arc', 'judgement'],
    ps: ['choir', 'plague', 'sovereign'], tr: ['vampire', 'tithe', 'retinue', 'aegis', 'revive', 'regalia', 'echo'],
    bl: 'Forty-four of it before it presses anything, every one of them better for every other, and GENESIS adds two dozen more.' },

  { id: 15, n: 'Red King', br: 'ascendant', dy: 'flesh', t: 9, sd: 12, sz: 348, hp: 165000, bd: 300, sp: 0.76, post: 'jrascend',
    g: function () {
      return JRG.siphon(8).concat(JRG.hangar(14, { color: '#8C2438', size: 112, width: 94 }))
        .concat(JRG.needles(10, { color: '#D4324F' }));
    },
    up: [30, 31], ab: 'rapture', abs: ['dominion', 'reap', 'raise', 'conscript', 'enthrone'],
    ps: ['husks', 'bleed', 'undying'], tr: ['vampire', 'tithe', 'executioner', 'aegis', 'revive', 'regalia', 'nullify'],
    bl: 'Everything it lifts it drops, everything it drops bleeds, and everything that bleeds feeds it. The lower it gets the faster it comes back.' },

  // ---- tier 10: the archons, level 300 ------------------------------------
  { id: 16, n: 'Archon of Ash', br: 'archon', dy: 'pyre', t: 10, sd: 24, sz: 396, hp: 296000, bd: 420, sp: 0.70, post: 'jrarchon',
    g: function () {
      return JRG.ember(16).concat(JRG.hellbore(4)).concat(JRG.starfall(8)).concat(JRG.godspear(3));
    },
    up: [32, 39], ab: 'overdrive', abs: ['supernova', 'apocalypse', 'meteor', 'eclipse', 'fissure', 'enthrone'],
    ps: ['pyre', 'ruin', 'corona', 'tyrant'], tr: ['aegis', 'revive', 'regalia', 'wake', 'pierce', 'warcry', 'echo', 'thunder'],
    bl: 'Six self-firing verbs, every one of them landing twice, and a right-click that fires all six again at once. A supernova and an apocalypse in the same second is the quiet part.' },

  { id: 17, n: 'Sunforge', br: 'archon', dy: 'pyre', t: 10, sd: 16, sz: 388, hp: 284000, bd: 450, sp: 0.80, post: 'jrarchon',
    g: function () { return JRG.gatling(8, { color: '#FF9A4E' }).concat(JRG.nova(8)).concat(JRG.ember(12)); },
    up: [32, 39], ab: 'fissure', abs: ['supernova', 'ignite', 'avatar', 'meteor', 'skyfall', 'enthrone'],
    ps: ['trail', 'pyre', 'corona', 'maelstrom'], tr: ['wake', 'vampire', 'overclock', 'revive', 'pierce', 'regalia', 'echo', 'nullify'],
    bl: 'A forge that walks: eight gatlings, eight novas, six blades on the orbit and burning ground behind it. AVATAR doubles all of it for eight seconds.' },

  { id: 18, n: 'Ninth Winter', br: 'archon', dy: 'rime', t: 10, sd: 6, sz: 404, hp: 312000, bd: 400, sp: 0.60, post: 'jrarchon', fov: 0.52,
    g: function () {
      return JRG.cryo(16).concat(JRG.hellbore(4)).concat(JRG.spine(6, { color: '#BFEFFF' }))
        .concat(JRG.starfall(6, { color: '#BFEFFF' }));
    },
    up: [38, 39], ab: 'overdrive', abs: ['timestop', 'stasis', 'terraform', 'freeze', 'slick', 'enthrone'],
    ps: ['chill', 'ruin', 'sovereign', 'quicken'], tr: ['aegis', 'revive', 'regalia', 'dread', 'bulwark', 'reflect', 'nullify', 'echo'],
    bl: 'Every winter before it was a season. This one is a verdict: two time stops, two stases and a terraform in one press, twice.' },

  { id: 19, n: 'Prism Lord', br: 'archon', dy: 'rime', t: 10, sd: 12, sz: 392, hp: 290000, bd: 420, sp: 0.74, post: 'jrarchon',
    g: function () {
      return JRG.cryo(12).concat(JRG.godspear(4, { color: '#DFF8FF' }))
        .concat(JRG.gatling(6, { color: '#BFEFFF' })).concat(JRG.orbit(12, { color: '#BFEFFF' }));
    },
    up: [38, 39], ab: 'godray', abs: ['beam', 'skyfall', 'stasis', 'freeze', 'tempest', 'timestop'],
    ps: ['chill', 'beat', 'stormcall', 'corona'], tr: ['reflect', 'pierce', 'aegis', 'blinkstep', 'overclock', 'revive', 'thunder', 'echo'],
    bl: 'Light, bent until it hurts. Two beams at once, lightning on its own, a tempest when it wants one, and every round you fire at it comes straight back.' },

  { id: 20, n: 'Pangaea', br: 'archon', dy: 'titan', t: 10, sd: 36, sz: 420, hp: 340000, bd: 500, sp: 0.62, post: 'jrarchon', me: true,
    g: function () { return []; },
    up: [32, 33], ab: 'overdrive', abs: ['fissure', 'rupture', 'quake', 'warpstorm', 'avatar', 'enthrone'],
    ps: ['swing', 'thorns', 'momentum', 'maelstrom'], tr: ['bulwark', 'aegis', 'revive', 'regalia', 'growth', 'executioner', 'nullify', 'echo'],
    bl: 'Every continent at once. Five hundred contact damage, a wrecking mass and six blades orbiting a hull with no barrel on it, and a cap on how much any hit is allowed to take.' },

  { id: 21, n: 'Unstoppable', br: 'archon', dy: 'titan', t: 10, sd: 22, sz: 404, hp: 318000, bd: 470, sp: 0.74, post: 'jrarchon',
    g: function () {
      return JRG.hellbore(4).concat(JRG.nova(8)).concat(JRG.cannon(6, { spread: 0.16 })).concat(JRG.gatling(4));
    },
    up: [32, 33], ab: 'rapture', abs: ['quake', 'judgement', 'avatar', 'rupture', 'genesis', 'fissure'],
    ps: ['momentum', 'thorns', 'maelstrom', 'corona'], tr: ['bulwark', 'growth', 'overclock', 'retinue', 'aegis', 'revive', 'pierce', 'thunder'],
    bl: 'The name is a description. It rams, it shoots, it grows, it lifts you up and drops you, and the faster it is going the more of you comes off.' },

  { id: 22, n: 'Final Argument', br: 'archon', dy: 'siege', t: 10, sd: 14, sz: 400, hp: 300000, bd: 380, sp: 0.40, pre: 'jrplinth', post: 'jrarchon', fov: 0.50,
    g: function () {
      return JRG.hellbore(4).concat(JRG.starfall(10)).concat(JRG.godspear(4)).concat(JRG.cannon(6, { spread: 0.16 }));
    },
    up: [33, 34], ab: 'skyfall', abs: ['judgement', 'meteor', 'unmake', 'turrets', 'tempest', 'enthrone'],
    ps: ['dug', 'sovereign', 'tyrant', 'stormcall'], tr: ['retinue', 'bulwark', 'aegis', 'revive', 'regalia', 'pierce', 'echo', 'thunder'],
    bl: 'The Last Word, rebutted. Twenty-four barrels and ten turrets on a plinth, and the sky itself as an eleventh argument.' },

  { id: 23, n: 'Ten Thousand Guns', br: 'archon', dy: 'siege', t: 10, sd: 12, sz: 392, hp: 288000, bd: 400, sp: 0.50, pre: 'dombase', post: 'jrarchon',
    g: function () {
      return JRG.gatling(10).concat(JRG.starfall(6)).concat(JRG.lance(4)).concat(JRG.mortar());
    },
    up: [33, 34], ab: 'overdrive', abs: ['meteor', 'arc', 'turrets', 'citadel', 'skyfall', 'tempest'],
    ps: ['dug', 'ruin', 'stormcall', 'quicken'], tr: ['retinue', 'aegis', 'dread', 'overclock', 'revive', 'pierce', 'thunder', 'echo'],
    bl: 'It is not ten thousand. It only feels like it, because every one of them is firing on a reload measured in frames and it presses its buttons on double time.' },

  { id: 24, n: "Heaven's Gate", br: 'archon', dy: 'wall', t: 10, sd: 22, sz: 410, hp: 326000, bd: 380, sp: 0.42, pre: 'dombase', post: 'jrarchon',
    g: function () {
      return JRG.traps(20, { reload: 1.8, life: 22, hp: 54 }).concat(JRG.cannon(8, { spread: 0.18 })).concat(JRG.starfall(8));
    },
    up: [34, 35], ab: 'genesis', abs: ['citadel', 'barricade', 'enthrone', 'turrets', 'conscript', 'timestop'],
    ps: ['husks', 'thorns', 'tyrant', 'corona'], tr: ['aegis', 'regalia', 'bulwark', 'revive', 'reflect', 'retinue', 'nullify', 'echo'],
    bl: 'Twenty launchers lay a city wall, a fort goes up inside it, an army walks out of the fort, and the clock stops while you work out which of those to shoot first.' },

  { id: 25, n: 'Ossuarch', br: 'archon', dy: 'wall', t: 10, sd: 15, sz: 398, hp: 304000, bd: 440, sp: 0.60, pre: 'dombase', post: 'jrarchon',
    g: function () {
      return JRG.hangar(16, { color: '#8C2438', size: 114, width: 96 })
        .concat(JRG.traps(14, { color: '#7A3346', reload: 2.2, life: 16 })).concat(JRG.siphon(8));
    },
    up: [34, 35], ab: 'rapture', abs: ['conscript', 'raise', 'reap', 'dominion', 'genesis', 'enthrone'],
    ps: ['husks', 'drain', 'ruin', 'undying'], tr: ['vampire', 'tithe', 'aegis', 'dread', 'revive', 'regalia', 'echo', 'executioner'],
    bl: 'A graveyard that walks and a king that reigns over it. Anything under a tenth of its health that touches it is simply finished.' },

  { id: 26, n: 'Hollow Crown', br: 'archon', dy: 'voidd', t: 10, sd: 18, sz: 394, hp: 290000, bd: 420, sp: 0.80, iv: true, post: 'jrarchon', fov: 0.52,
    g: function () {
      return JRG.hellbore(4).concat(JRG.phase(14)).concat(JRG.orbit(14)).concat(JRG.godspear(3));
    },
    up: [36, 37], ab: 'blackhole', abs: ['collapse', 'unmake', 'warpstorm', 'blink', 'timestop', 'enthrone'],
    ps: ['well', 'mirror', 'tyrant', 'corona'], tr: ['blinkstep', 'pierce', 'aegis', 'revive', 'reflect', 'omniscient', 'echo', 'nullify'],
    bl: 'An empty patch of map wearing a crown. You see the black hole it opened. You do not see the one it is.' },

  { id: 27, n: 'Abyss Throne', br: 'archon', dy: 'voidd', t: 10, sd: 16, sz: 402, hp: 310000, bd: 410, sp: 0.70, post: 'jrarchon',
    g: function () { return JRG.flak(4).concat(JRG.nova(10)).concat(JRG.spine(6)); },
    up: [36, 37], ab: 'overdrive', abs: ['blackhole', 'collapse', 'pull', 'judgement', 'unmake', 'timestop'],
    ps: ['well', 'sovereign', 'corona', 'quicken'], tr: ['aegis', 'pierce', 'dread', 'bulwark', 'revive', 'regalia', 'nullify', 'thunder'],
    bl: 'Six ways of dragging you somewhere you did not want to be, pressed all at once, on double time.' },

  { id: 28, n: 'Chronarch', br: 'archon', dy: 'time', t: 10, sd: 26, sz: 396, hp: 296000, bd: 410, sp: 0.82, post: 'jrarchon',
    g: function () {
      return JRG.ring(18, { reload: 0.8, dmg: 1.2 }).concat(JRG.cannon(8, { spread: 0.14 }))
        .concat(JRG.orbit(14)).concat(JRG.spine(4));
    },
    up: [37, 38], ab: 'overdrive', abs: ['timestop', 'epoch', 'stasis', 'judgement', 'rewind', 'enthrone'],
    ps: ['beat', 'sovereign', 'quicken', 'stormcall'], tr: ['blinkstep', 'aegis', 'revive', 'regalia', 'reflect', 'overclock', 'echo', 'thunder'],
    bl: 'The arena keeps its time. Its own clock runs at double speed, the screen is held still twice a press, and the last three seconds are put back whenever it disliked them.' },

  { id: 29, n: 'Ouroboric Hour', br: 'archon', dy: 'time', t: 10, sd: 21, sz: 390, hp: 284000, bd: 430, sp: 0.86, iv: true, post: 'jrarchon', fov: 0.54,
    g: function () {
      return JRG.phase(14).concat(JRG.ring(12, { reload: 0.9 })).concat(JRG.lance(4)).concat(JRG.orbit(12));
    },
    up: [37, 38], ab: 'timestop', abs: ['overdrive', 'stasis', 'epoch', 'dilate', 'arc', 'rewind'],
    ps: ['beat', 'split', 'mirror', 'quicken'], tr: ['blinkstep', 'reflect', 'aegis', 'pierce', 'revive', 'omniscient', 'thunder', 'echo'],
    bl: 'An hour that eats its own tail: invisible, phasing out on a timer, splitting when it dies, and pressing OVERDRIVE by itself whenever you get close.' },

  { id: 30, n: 'Locust God', br: 'archon', dy: 'flesh', t: 10, sd: 16, sz: 400, hp: 296000, bd: 420, sp: 0.80, post: 'jrarchon',
    g: function () {
      return JRG.hangar(24, { color: '#C8F05A', size: 118, width: 100 }).concat(JRG.factory(8, { color: '#C8F05A' }))
        .concat(JRG.orbit(16, { color: '#C8F05A' })).concat(JRG.needles(10, { color: '#C8F05A' }));
    },
    up: [35, 36], ab: 'genesis', abs: ['conscript', 'swarm', 'dominion', 'arc', 'judgement', 'tempest'],
    ps: ['choir', 'plague', 'sovereign', 'corona'], tr: ['vampire', 'tithe', 'retinue', 'aegis', 'revive', 'regalia', 'echo', 'nullify'],
    bl: 'Forty-eight of it at rest, and it is never at rest. The swarm is the weapon, the armour, the score and the weather.' },

  { id: 31, n: 'Crimson Deluge', br: 'archon', dy: 'flesh', t: 10, sd: 13, sz: 394, hp: 306000, bd: 460, sp: 0.76, post: 'jrarchon',
    g: function () {
      return JRG.siphon(10).concat(JRG.hangar(16, { color: '#8C2438', size: 114, width: 96 }))
        .concat(JRG.needles(12, { color: '#D4324F' }));
    },
    up: [35, 36], ab: 'overdrive', abs: ['rapture', 'dominion', 'reap', 'raise', 'conscript', 'enthrone'],
    ps: ['husks', 'bleed', 'undying', 'corona'], tr: ['vampire', 'tithe', 'executioner', 'aegis', 'revive', 'regalia', 'nullify', 'echo'],
    bl: 'Every drop it spills it drinks. A rapture, a reap, a raise and a dominion in one press, and it heals harder than you can hit it.' },

  // ---- tier 11: the primordials, level 370 --------------------------------
  // The dynasties marry again. Eight of them on a ring, each one the union of
  // a dynasty and its neighbour, so an archon chooses which neighbour it becomes.
  { id: 32, n: 'Magma Colossus', br: 'primordial', lb: 'Pyre × Titan', hx: '#6B2A14', t: 11, sd: 34, sz: 448, hp: 560000, bd: 680, sp: 0.66, post: 'jrprimal',
    tone: '255,150,60', tone2: '255,190,140',
    g: function () {
      return JRG.ember(14).concat(JRG.hellbore(4)).concat(JRG.nova(8)).concat(JRG.cannon(6, { spread: 0.16 }));
    },
    up: [40, 41], ab: 'overdrive', abs: ['supernova', 'fissure', 'rupture', 'quake', 'meteor', 'apocalypse', 'enthrone'],
    ps: ['pyre', 'corona', 'maelstrom', 'momentum'], tr: ['bulwark', 'aegis', 'immortal', 'regalia', 'wake', 'pierce', 'echo', 'thunder', 'nullify'],
    bl: 'PYRE x TITAN. A mountain that is also on fire. IMMORTAL means it refuses three deaths a life — and every refusal is a supernova.' },

  { id: 33, n: 'Moving Mountain', br: 'primordial', lb: 'Titan × Ordnance', hx: '#4A3A2A', t: 11, sd: 30, sz: 456, hp: 580000, bd: 640, sp: 0.55, post: 'jrprimal', fov: 0.50,
    tone: '255,190,140', tone2: '200,215,240',
    g: function () {
      return JRG.hellbore(5).concat(JRG.starfall(8)).concat(JRG.godspear(4)).concat(JRG.cannon(6, { spread: 0.16 }));
    },
    up: [40, 41], ab: 'skyfall', abs: ['overdrive', 'judgement', 'rupture', 'quake', 'meteor', 'turrets', 'enthrone'],
    ps: ['momentum', 'dug', 'sovereign', 'stormcall'], tr: ['retinue', 'bulwark', 'aegis', 'immortal', 'regalia', 'pierce', 'echo', 'thunder', 'growth'],
    bl: 'TITAN x ORDNANCE. The siege engine that decided to walk. It has not finished growing, and the sky falls wherever it points.' },

  { id: 34, n: 'Eternal Siege', br: 'primordial', lb: 'Ordnance × Bastion', hx: '#34402E', t: 11, sd: 18, sz: 452, hp: 590000, bd: 600, sp: 0.42, pre: 'dombase', post: 'jrprimal',
    tone: '200,215,240', tone2: '170,230,150',
    g: function () {
      return JRG.traps(18, { reload: 1.8, life: 22, hp: 54 }).concat(JRG.starfall(8))
        .concat(JRG.godspear(3)).concat(JRG.cannon(6, { spread: 0.16 }));
    },
    up: [40, 41], ab: 'genesis', abs: ['citadel', 'skyfall', 'judgement', 'turrets', 'barricade', 'tempest', 'enthrone'],
    ps: ['dug', 'husks', 'tyrant', 'stormcall'], tr: ['retinue', 'bulwark', 'aegis', 'immortal', 'regalia', 'reflect', 'echo', 'dread', 'nullify'],
    bl: 'ORDNANCE x BASTION. The siege that never lifts: walls that lay themselves, a garrison that walks out of them, and artillery over the top.' },

  { id: 35, n: 'Necropolis Rex', br: 'primordial', lb: 'Bastion × Vermin', hx: '#4A1E2A', t: 11, sd: 20, sz: 446, hp: 572000, bd: 660, sp: 0.60, pre: 'dombase', post: 'jrprimal',
    tone: '255,80,105', tone2: '200,240,90',
    g: function () {
      return JRG.hangar(20, { color: '#8C2438', size: 116, width: 98 })
        .concat(JRG.traps(14, { color: '#7A3346', reload: 2, life: 16 }))
        .concat(JRG.siphon(8)).concat(JRG.factory(6, { color: '#C8F05A' }));
    },
    up: [40, 41], ab: 'rapture', abs: ['genesis', 'conscript', 'dominion', 'raise', 'reap', 'citadel', 'enthrone'],
    ps: ['husks', 'plague', 'undying', 'corona'], tr: ['vampire', 'tithe', 'executioner', 'aegis', 'immortal', 'regalia', 'retinue', 'echo', 'nullify'],
    bl: 'BASTION x VERMIN. A city of the dead with a king in the middle of it, and every one of its citizens was somebody you brought.' },

  { id: 36, n: 'Maw of Nothing', br: 'primordial', lb: 'Vermin × Void', hx: '#2A1E3A', t: 11, sd: 17, sz: 440, hp: 548000, bd: 650, sp: 0.78, post: 'jrprimal',
    tone: '200,240,90', tone2: '150,165,255',
    g: function () {
      return JRG.hangar(18, { color: '#C8F05A', size: 114, width: 96 }).concat(JRG.phase(12))
        .concat(JRG.flak(3)).concat(JRG.needles(10, { color: '#C8F05A' }));
    },
    up: [40, 41], ab: 'blackhole', abs: ['overdrive', 'dominion', 'collapse', 'unmake', 'conscript', 'warpstorm', 'judgement'],
    ps: ['well', 'plague', 'choir', 'corona'], tr: ['vampire', 'tithe', 'pierce', 'aegis', 'immortal', 'reflect', 'omniscient', 'echo', 'thunder'],
    bl: 'VERMIN x VOID. A swarm with a singularity for a mouth. Everything the flock catches falls in, and everything that falls in feeds it.' },

  { id: 37, n: 'Null Clock', br: 'primordial', lb: 'Void × Chrono', hx: '#1E2238', t: 11, sd: 24, sz: 438, hp: 540000, bd: 640, sp: 0.84, iv: true, post: 'jrprimal', fov: 0.50,
    tone: '150,165,255', tone2: '255,225,130',
    g: function () {
      return JRG.phase(14).concat(JRG.ring(12, { reload: 0.85 })).concat(JRG.hellbore(3)).concat(JRG.orbit(14));
    },
    up: [40, 41], ab: 'timestop', abs: ['overdrive', 'blackhole', 'epoch', 'collapse', 'unmake', 'stasis', 'blink'],
    ps: ['well', 'beat', 'mirror', 'quicken'], tr: ['blinkstep', 'pierce', 'aegis', 'immortal', 'reflect', 'omniscient', 'echo', 'thunder', 'nullify'],
    bl: 'VOID x CHRONO. The time after time ends. Invisible, phasing, pulling, rewinding the arena and stopping the clock — on double time.' },

  { id: 38, n: 'Frozen Moment', br: 'primordial', lb: 'Chrono × Glacier', hx: '#24405A', t: 11, sd: 28, sz: 444, hp: 556000, bd: 630, sp: 0.72, post: 'jrprimal',
    tone: '255,225,130', tone2: '170,235,255',
    g: function () {
      return JRG.cryo(14).concat(JRG.ring(14, { reload: 0.85 })).concat(JRG.spine(6, { color: '#BFEFFF' }))
        .concat(JRG.orbit(12, { color: '#BFEFFF' }));
    },
    up: [40, 41], ab: 'overdrive', abs: ['timestop', 'epoch', 'stasis', 'terraform', 'freeze', 'godray', 'enthrone'],
    ps: ['beat', 'chill', 'sovereign', 'quicken'], tr: ['blinkstep', 'reflect', 'aegis', 'immortal', 'regalia', 'dread', 'echo', 'thunder', 'nullify'],
    bl: 'CHRONO x GLACIER. Cold enough that time stops. Every press holds the screen, puts it back three seconds and freezes it where it lands.' },

  { id: 39, n: 'Equinox', br: 'primordial', lb: 'Glacier × Pyre', hx: '#4A2E4A', t: 11, sd: 26, sz: 450, hp: 566000, bd: 660, sp: 0.70, post: 'jrprimal',
    tone: '170,235,255', tone2: '255,150,60',
    g: function () {
      return JRG.cryo(10).concat(JRG.ember(12, { spin: JRPI / 12 })).concat(JRG.hellbore(4)).concat(JRG.nova(8));
    },
    up: [40, 41], ab: 'supernova', abs: ['overdrive', 'apocalypse', 'terraform', 'stasis', 'meteor', 'eclipse', 'freeze'],
    ps: ['chill', 'pyre', 'corona', 'ruin'], tr: ['aegis', 'immortal', 'regalia', 'dread', 'wake', 'pierce', 'echo', 'thunder', 'nullify'],
    bl: 'GLACIER x PYRE. Fire and ice in perfect balance, which is to say twice as much of both. The ground around it is never one thing for long.' },

  // ---- tier 12: the eschatons, level 440 ----------------------------------
  { id: 40, n: 'First Light', br: 'eschaton', hx: '#F2D27A', raw: true, t: 12, sd: 30, sz: 492, hp: 1050000, bd: 940, sp: 0.70, post: 'jreschaton', fov: 0.48,
    tone: '255,248,215', tone2: '255,190,110',
    g: function () {
      return JRG.godspear(6).concat(JRG.nova(10, { color: '#FFE7A8' }))
        .concat(JRG.gatling(8, { color: '#FFF4D6' })).concat(JRG.starfall(8, { color: '#FFE7A8' }));
    },
    up: [42], ab: 'overdrive', abs: ['supernova', 'skyfall', 'genesis', 'godray', 'tempest', 'judgement', 'fissure', 'enthrone'],
    ps: ['corona', 'sovereign', 'stormcall', 'quicken', 'tyrant'],
    tr: ['aegis', 'immortal', 'regalia', 'retinue', 'pierce', 'reflect', 'echo', 'thunder', 'nullify', 'warcry'],
    bl: 'The first thing there was. A million health, a hull the colour of the sun, eight verbs it fires itself and a right-click that fires them all again. Everybody can see it, and it earns for the privilege.' },

  { id: 41, n: 'Last Dark', br: 'eschaton', hx: '#24123F', raw: true, t: 12, sd: 18, sz: 500, hp: 1100000, bd: 960, sp: 0.76, post: 'jreschaton', fov: 0.48,
    tone: '190,160,255', tone2: '255,90,120',
    g: function () {
      return JRG.hellbore(5).concat(JRG.phase(14)).concat(JRG.orbit(16)).concat(JRG.flak(4)).concat(JRG.spine(6));
    },
    up: [42], ab: 'blackhole', abs: ['overdrive', 'timestop', 'rapture', 'collapse', 'unmake', 'apocalypse', 'warpstorm', 'judgement'],
    ps: ['well', 'corona', 'maelstrom', 'undying', 'tyrant'],
    tr: ['blinkstep', 'pierce', 'aegis', 'immortal', 'reflect', 'omniscient', 'echo', 'thunder', 'nullify', 'vampire'],
    bl: 'The last thing there will be. It opens black holes, stops the clock, lifts the arena and drops it, and drinks a fifth of everything it does.' },

  // ---- tier 13: Armageddon, level 500 -------------------------------------
  // The only card at 440 is this one, and it is the end of every road in the
  // game: both eschatons, all eight primordials, every dynasty, here.
  { id: 42, n: 'Armageddon', br: 'armageddon', hx: '#1A0B10', raw: true, t: 13, sd: 24, sz: 560, hp: 2200000, bd: 1500, sp: 0.66, post: 'jrarmageddon', fov: 0.44,
    tone: '255,130,80', tone2: '255,40,60',
    g: function () {
      return JRG.godspear(8).concat(JRG.nova(12, { color: '#FF5A5A' }))
        .concat(JRG.gatling(10, { color: '#FFF4D6' })).concat(JRG.hellbore(4)).concat(JRG.starfall(8, { color: '#FF8A5A' }));
    },
    up: [], ab: 'bigbang',
    abs: ['overdrive', 'supernova', 'timestop', 'skyfall', 'blackhole', 'rapture', 'genesis', 'tempest', 'godray', 'judgement'],
    ps: ['corona', 'maelstrom', 'stormcall', 'quicken', 'tyrant', 'sovereign'],
    tr: ['aegis', 'immortal', 'regalia', 'retinue', 'pierce', 'reflect', 'echo', 'thunder', 'nullify', 'warcry', 'omniscient', 'executioner'],
    bl: 'Two point two million health, fifteen hundred contact damage, forty-two barrels, twenty-four turrets, ten verbs that fire themselves and land twice, six passives, twelve traits, and THE BIG BANG on right-click. There is nothing after it.' }
];

// Which ascendants each crown opens onto. A crown is a leaf in the Royale's own
// table and stays one — the Royale ends at 200 — so Armageddon offers these
// through filterUpgrades and the wheel draws them through the mode's treeGraft.
// Two per dynasty, keyed by the crown's real tank id.
var JA_GRAFT = {};
JR_HULLS.forEach(function (h) {
  if (h.t !== 8) return;
  JA_GRAFT[JR_BASE + h.id] = JA_HULLS
    .filter(function (a) { return a.t === 9 && a.dy === h.dy; })
    .map(function (a) { return JA_BASE + a.id; });
});

// Indexed on first use rather than scanned: jrOf runs once a tick for every
// juggernaut on the board and a linear filter over a hundred and forty rows
// allocated an array per call to answer a question with a constant answer.
//
// Keyed on the real tank id, because two rosters live in here: the Royale's at
// JR_BASE and Armageddon's at JA_BASE. Every row learns its own id as `tid`,
// which is what everything below it reads instead of adding a base itself.
var JR_BY_ID = null;
function jrIndex() {
  if (JR_BY_ID) return JR_BY_ID;
  JR_BY_ID = [];
  [[JR_HULLS, JR_BASE], [JA_HULLS, JA_BASE]].forEach(function (r) {
    for (var i = 0; i < r[0].length; i++) { r[0][i].tid = r[1] + r[0][i].id; JR_BY_ID[r[0][i].tid] = r[0][i]; }
  });
  return JR_BY_ID;
}
// A Royale hull by its row id — what the tests and Last Juggernaut ask for.
function jrHull(id) { return jrIndex()[JR_BASE + id]; }
function jrOf(t) { return (t && jrIndex()[t.tankId]) || null; }

// Tier defaults. A row only overrides what makes it that hull.
var JR_TIER = [
  { ar: 0.12, fov: 1.00 },
  { ar: 0.10, fov: 0.96 },
  { ar: 0.07, fov: 0.92 },
  { ar: 0.04, fov: 0.87 },
  { ar: 0.02, fov: 0.82 },
  { ar: 0.01, fov: 0.78 },
  { ar: 0.00, fov: 0.74 },
  { ar: 0.00, fov: 0.70 },
  { ar: 0.00, fov: 0.66 },
  // Armageddon. The camera keeps pulling back, because the hull keeps growing.
  { ar: 0.00, fov: 0.62 },
  { ar: 0.00, fov: 0.58 },
  { ar: 0.00, fov: 0.54 },
  { ar: 0.00, fov: 0.50 },
  { ar: 0.00, fov: 0.46 }
];

// diep quotes every barrel size against a 50-radius body, so bolting a 70-unit
// trap launcher to a 132-radius Citadel buries the hardware inside the hull and
// the silhouette says nothing at all. A juggernaut is a tank scaled up, so its
// guns scale with it. Width only goes up by the square root, for two reasons:
// ten barrels widened in full proportion merge into one grey collar and the
// hull stops being legible under its own hardware, and barrel width is what
// sets projectile size — so this is also what keeps a Voidforge from firing
// shells wider than a Voidforge.
function jrFitGuns(guns, size) {
  var k = size / 50, s = Math.sqrt(k);
  for (var i = 0; i < guns.length; i++) {
    var b = guns[i];
    b.size *= k; b.width *= s; b.offset = (b.offset || 0) * k;
  }
  return guns;
}

function buildJuggHulls() {
  if (TANK_DEFS[JR_BASE]) return;
  jrBuildRoster(JR_HULLS, JR_BASE);
  jrBuildRoster(JA_HULLS, JA_BASE);
}

function jrBuildRoster(rows, base) {
  for (var i = 0; i < rows.length; i++) {
    var h = rows[i], br = JR_BR[h.br], tier = JR_TIER[h.t];
    var dyn = h.dy ? JR_DYN[h.dy] : null;
    var guns = jrFitGuns(h.g(), h.sz);
    // Every stat runs to STAT_DEEP_MAX rather than 7. The pill in the corner is
    // the same width it always was — it compresses each filled row into a single
    // block instead of getting longer (see statBar) — but the mode hands out 84
    // points by level 200 and eight seven-pip bars only hold 56 of them.
    var st = [0, 1, 2, 3, 4, 5, 6, 7].map(function () { return STAT_DEEP_MAX; });
    // A melee hull's bullet stats are capped at zero, so the stat panel says
    // what it is as plainly as the silhouette does — and upgradeTo's smasher
    // refund path picks it up for free.
    if (h.me) { st[S_RELOAD] = guns.length ? STAT_DEEP_MAX : 0; st[S_DAMAGE] = 0; st[S_PEN] = 0; st[S_BSPEED] = 0; }
    // Lightened a step a tier up to the crowns, then no further — an
    // Armageddon hull lightened thirteen steps is white. `raw` takes the colour
    // exactly as written, for the hulls that are meant to be dark.
    var fill = h.raw ? h.hx : jrMix(h.hx || (dyn && dyn.hex) || br.hex, Math.min(h.t, 8) * 0.06);
    TANK_DEFS[base + h.id] = {
      id: base + h.id, name: h.n, levelRequirement: JR_LVL[h.t],
      upgradeMessage: h.t >= 4 ? 'YOU ARE A ' + h.n.toUpperCase() : 'You are a ' + h.n,
      upgrades: h.up.map(function (u) { return base + u; }),
      flags: { invisibility: !!h.iv, zoomAbility: false, canClaimSquares: false, devOnly: false },
      visibilityRateShooting: 0.23, visibilityRateMoving: 0.09, invisibilityRate: 0.025,
      fieldFactor: h.fov || tier.fov, absorbtionFactor: h.ar === undefined ? tier.ar : h.ar, speed: h.sp,
      maxHealth: h.hp, preAddon: h.pre || null, postAddon: h.post || null, sides: h.sd,
      borderWidth: 14, baseSizeOverride: h.sz, bodyDamage: h.bd,
      stats: [{ name: 'Movement Speed', max: st[0] }, { name: 'Reload', max: st[1] }, { name: 'Bullet Damage', max: st[2] },
        { name: 'Bullet Penetration', max: st[3] }, { name: 'Bullet Speed', max: st[4] }, { name: 'Body Damage', max: st[5] },
        { name: 'Max Health', max: st[6] }, { name: 'Health Regen', max: st[7] }],
      barrels: guns,
      // Everything the mode and the renderer read off a hull without needing
      // the row: the wheel's ring, the aura, the verbs, and — from tier 4 up —
      // which dynasty the hull belongs to, which is what seals the top of the
      // tree into eight lines that never meet.
      treeRing: h.t - 1, jrTier: h.t, jrBranch: h.br, jrDynasty: h.dy || null,
      // What the upgrade card writes across the top of itself. Below tier 4 that
      // is the branch you are committing to; from tier 4 up it is the dynasty,
      // which is the only place the card can tell you that this pick closes
      // every door but eight.
      jrLabel: h.lb || (dyn && dyn.label) || br.label,
      jrAbility: h.ab || null,
      jrAuto: h.abs || null,
      jrPassive: h.ps ? [].concat(h.ps).join(' · ') : null,
      jrTraits: h.tr || null,
      jrTone: h.tone || (dyn && dyn.a) || br.tone,
      jrTone2: h.tone2 || (dyn && dyn.b) || null,
      jrAura: h.aura || br.aura,
      // paintTeam hands a class with its own colour straight through, which is
      // how the boss classes stay Crasher pink. Eleven branches use the same door.
      color: [fill, jrMix(fill, -0.34)]
    };
  }
}

// --- shared plumbing -----------------------------------------------------
// Tank.tick rewrites damageReduction every tick, and logic.tick runs after it
// and before the collision pass, so anything written there lands for exactly
// one tick and cleans itself up. reloadTime and damagePerTick are NOT rewritten
// per tick, so those go through jrSet/jrRestore instead: restore first, apply
// second, and a hull that stops doing something stops doing it.
function jrSet(t, key, val) {
  if (!t.jrOv) t.jrOv = {};
  if (t.jrOv[key] === undefined) t.jrOv[key] = t[key];
  t[key] = val;
}
function jrRestore(t) {
  if (!t.jrOv) return;
  for (var k in t.jrOv) t[k] = t.jrOv[k];
  t.jrOv = null;
}

// A maximum-health / size bonus that survives recompute(). Only ever touched
// when the wanted value changes, so it never ratchets health up or down.
function jrGrant(t, hp, sizeMult) {
  var on = t.jrHpOn || 0, sz = t.jrSzOn || 1;
  if (on === hp && sz === sizeMult) return;
  if (on) { t.maxHealth -= on; t.health = Math.min(t.health, t.maxHealth); }
  t.scaleBoost = sizeMult;
  t.recompute();
  if (hp) { t.maxHealth += hp; t.health += Math.max(0, hp - on); }
  // The Pauper's bonus runs negative, so the bar can end up above its own top.
  t.health = Math.min(t.health, t.maxHealth);
  t.jrHpOn = hp; t.jrSzOn = sizeMult;
}

// Everything hostile inside a circle, deduped — g.nearby hands the same entity
// back once per grid cell it straddles.
//
// The stamp is fresh every call. It used to be (tick, caster), which deduped
// across calls as well as within one: whatever a hull's passive had already
// scanned that tick was invisible to the button it pressed next, so a FREEZE
// inside its own chill ring found nobody, and of eight stacked verbs only the
// first hit anything.
var JR_TAG = 0;
function jrEach(g, t, r, types, fn) {
  var tag = ++JR_TAG, n = 0, r2 = r * r;
  function visit(e) {
    if (e === t || e.dead || e.jrTag === tag) return;
    if (!types[e.type]) return;
    var dx = e.x - t.x, dy = e.y - t.y, d2 = dx * dx + dy * dy;
    if (d2 > r2) return;
    e.jrTag = tag;
    n++;
    fn(e, Math.sqrt(d2) || 1);
  }
  // g.nearby walks every grid cell in the box, and a level-500 hull asks about
  // circles wider than the arena. Past the point where the box holds more cells
  // than there are entities, walking the entity list is the cheaper answer.
  var span = 2 * r / HASH_CELL;
  if (span * span > g.entities.length) for (var i = 0; i < g.entities.length; i++) visit(g.entities[i]);
  else g.nearby(t.x, t.y, r, visit);
  return n;
}
var JR_T_TANK = { tank: 1 };
var JR_T_SHOT = { bullet: 1, trap: 1, drone: 1, necro: 1, swarm: 1, minion: 1, skimmer: 1, rocket: 1, glider: 1, firework: 1 };
var JR_T_SHAPE = { shape: 1 };
// What the reflect trait is allowed to turn around: things that were fired and
// forgotten. Not traps, and not anything a hangar is still counting.
var JR_T_REFLECT = { bullet: 1, skimmer: 1, rocket: 1, glider: 1, firework: 1 };

// Hostile tanks only: mode furniture, closers and teammates are not targets.
function jrFoe(t, e) {
  return e.type === 'tank' && !e.dead && !e.modeEntity && !e.isCloser && !e.parked
    && !(e.team !== null && e.team === t.team);
}
function jrOwn(e, t) { var r = e.owner; while (r && r.owner) r = r.owner; return r === t; }

function jrEnemies(g, t, r, fn) {
  return jrEach(g, t, r, JR_T_TANK, function (e, d) { if (jrFoe(t, e)) fn(e, d); });
}
function jrNearestFoe(g, t, r) {
  var best = null, bd = r;
  var list = labTanks(g, JR_SCRATCH);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e === t || !jrFoe(t, e)) continue;
    var d = Math.hypot(e.x - t.x, e.y - t.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
var JR_SCRATCH = [];
var JR_SCRATCH3 = [];

// A detonation somewhere other than on the hull. Every late verb that hits a
// point rather than a ring goes through here, so falloff, knockback and the
// status left behind are written once instead of sixteen times.
function jrBlast(g, t, x, y, r, dmg, o) {
  o = o || {};
  var hit = 0, list = labTanks(g, JR_SCRATCH3);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e === t || !jrFoe(t, e)) continue;
    var reach = r + e.size, d = Math.hypot(e.x - x, e.y - y);
    if (d > reach) continue;
    hit++;
    e.applyDamage(dmg * (1 - (d / reach) * 0.5), t);
    if (o.push) e.addVelocity(Math.atan2(e.y - y, e.x - x) || 0, o.push);
    if (o.burn) jrBurn(e, o.burn * TPS, t.maxHealth * 0.0014 + 5, t);
    if (o.chill) jrChill(e, o.chill * TPS, 0.5);
    if (o.hold) jrHold(e, o.hold * TPS);
  }
  return hit;
}

// --- status effects ------------------------------------------------------
// Four of them, all resolved in one place so a hull that applies burn and a
// hull that applies burn through a drone behave identically.
function jrBurn(e, ticks, dps, by) {
  if (!e || e.dead) return;
  var g = e.game;
  e.jrBurn = Math.max(e.jrBurn || 0, g.tick + ticks);
  e.jrBurnDps = Math.max(e.jrBurnDps || 0, dps);
  e.jrBurnBy = by || null;
}
function jrChill(e, ticks, f) {
  if (!e || e.dead) return;
  e.jrChill = Math.max(e.jrChill || 0, e.game.tick + ticks);
  e.jrChillF = Math.min(e.jrChillF === undefined ? 1 : e.jrChillF, f);
}
function jrHold(e, ticks) {
  if (!e || e.dead) return;
  e.jrHold = Math.max(e.jrHold || 0, e.game.tick + ticks);
}
function jrBleed(e, by) { if (e && !e.dead) { e.jrBleed = by; e.jrBleedAt = e.game.tick; } }

function jrStatus(g, t) {
  if (t.jrBurn) {
    if (g.tick < t.jrBurn) { t.applyDamage(t.jrBurnDps, t.jrBurnBy); t.hurtFlash = 2; }
    else { t.jrBurn = 0; t.jrBurnDps = 0; t.jrBurnBy = null; }
  }
  if (t.jrHold && g.tick < t.jrHold) {
    t.vx = 0; t.vy = 0;
    for (var i = 0; i < t.barrels.length; i++) t.barrels[i].disabled = true;
    t.jrFrozen = true;
  } else {
    if (t.jrFrozen) { for (i = 0; i < t.barrels.length; i++) t.barrels[i].disabled = false; t.jrFrozen = false; }
    t.jrHold = 0;
    if (t.jrChill) {
      if (g.tick < t.jrChill) { var f = t.jrChillF === undefined ? 0.55 : t.jrChillF; t.vx *= f; t.vy *= f; }
      else { t.jrChill = 0; t.jrChillF = 1; }
    }
  }
  if (t.jrBleed) {
    if (t.health < t.maxHealth - 1 && g.tick - t.jrBleedAt < 30 * TPS) t.applyDamage(t.maxHealth * 0.0011, t.jrBleed);
    else t.jrBleed = null;
  }
}

// --- mode furniture ------------------------------------------------------
// A decoy is not a tank — it never ticks and never steps itself, so it costs
// the simulation nothing. The mode drags it along behind its owner.
function jrDecoy(g, t, ang) {
  var e = new Entity(g, {
    type: 'tank', sides: t.sides, size: t.size, x: t.x + Math.cos(ang) * t.size * 2.2,
    y: t.y + Math.sin(ang) * t.size * 2.2, team: t.team, owner: t,
    fill: t.fill, stroke: t.stroke, maxHealth: 1, damage: 1
  });
  // Typed as a tank so the ordinary renderer draws it properly — barrels,
  // guards, colour and all — which is the whole point of a decoy. It is not a
  // Tank: it carries a no-op tick, it is flagged modeEntity so it stays off the
  // leaderboard and out of labTanks, and the mode drags it around by hand. Bots
  // pick it up in botScan exactly as a player's eye does, which is the feature.
  e.tick = function () {};
  e.def = t.def; e.barrels = t.barrels; e.turrets = t.turrets; e.stats = t.stats;
  e.level = t.level; e.scaleFactor = t.scaleFactor; e.borderWidth = t.borderWidth;
  e.guardAngle = t.guardAngle; e.reloadTime = t.reloadTime; e.tankId = t.tankId;
  e.modeEntity = true; e.hiddenHealthbar = true; e.noDmgIndicator = true;
  e.jrIsDecoy = true;
  e.push = 1; e.absorb = 0; e.jrOff = ang; e.angle = t.angle;
  e.jrDie = g.tick + 9 * TPS;
  if (!t.jrDecoys) t.jrDecoys = [];
  t.jrDecoys.push(e);
  return g.add(e);
}

// A deployed turret: a basespawner with one barrel, aimed by the mode. The
// engine already ticks that type's barrel, so this is furniture, not a tank.
function jrTurret(g, t, ang, life) {
  var e = new Entity(g, {
    type: 'basespawner', sides: 6, size: t.size * 0.36,
    x: t.x + Math.cos(ang) * t.size * 1.9, y: t.y + Math.sin(ang) * t.size * 1.9,
    team: t.team, owner: t, fill: t.fill, stroke: t.stroke, maxHealth: 260, damage: 4
  });
  e.modeEntity = true; e.hiddenHealthbar = true; e.jrOwner = t;
  e.stats = t.stats; e.reloadTime = t.reloadTime; e.scaleFactor = 1;
  e.jrDie = g.tick + life;
  e.barrels = [new Barrel(e, jrBarrel({
    size: 96, width: 54, reload: 1.6, recoil: 0,
    bullet: jrBullet({ hp: 9, dmg: 0.7, speed: 1.25, scatter: 1, life: 1.1, absorb: 0.4 })
  }), 0)];
  if (!t.jrTurrets) t.jrTurrets = [];
  t.jrTurrets.push(e);
  return g.add(e);
}

// A ground patch: burning, slick, or a projectile-proof dome. One entity type,
// three behaviours, read back out in the mode tick.
function jrField(g, t, kind, x, y, r, life, fill) {
  var e = new Entity(g, {
    type: 'flag', sides: 0, size: r, x: x, y: y, team: null,
    fill: fill, stroke: jrMix(fill, -0.3), maxHealth: Infinity
  });
  e.modeEntity = true; e.hiddenHealthbar = true; e.damageReduction = 0;
  e.push = 0; e.absorb = 0; e.jrKind = kind; e.jrBy = t; e.jrDie = g.tick + life; e.jrBorn = g.tick;
  if (!g.jrFields) g.jrFields = [];
  g.jrFields.push(e);
  return g.add(e);
}

// Orbiting mass: the Wrecking Ball's ball and the Tessellate's segments are the
// same object with different numbers on it.
function jrOrbiter(g, t, i, n, o) {
  var e = new Entity(g, {
    type: 'flag', sides: o.sides || 6, size: o.size, x: t.x, y: t.y, team: t.team, owner: t,
    fill: o.fill || t.fill, stroke: o.stroke || t.stroke,
    maxHealth: o.hp || 400, damage: o.dmg || 0
  });
  e.modeEntity = true; e.hiddenHealthbar = !!o.hideBar; e.jrPhase = Math.PI * 2 * (i / n);
  e.push = 6; e.absorb = 0; e.minDmg = 0.25; e.maxDmg = 4;
  return g.add(e);
}

function jrKillList(list) {
  if (!list) return;
  for (var i = 0; i < list.length; i++) if (list[i] && !list[i].dead) list[i].kill(null);
  list.length = 0;
}

// Everything a hull left lying around, swept when it becomes a different hull
// or dies. Without this a Tessellate that upgrades keeps four orphan segments.
function jrClear(g, t) {
  jrKillList(t.jrDecoys); jrKillList(t.jrTurrets); jrKillList(t.jrOrbs); jrKillList(t.jrPads);
  t.jrHost = null; t.jrTether = null; t.jrRoot = 0; t.jrHeat = 0; t.jrPlates = 0;
  t.jrHist = null; t.jrBall = null; t.jrCharge = 0; t.jrAscend = 0;
  // The late tiers' own state. A hull that stops being a crown stops having a
  // shield, an escort, a growth stack and four loaded buttons.
  t.jrCools = null; t.jrShield = undefined; t.jrShieldMax = 0; t.jrShieldAt = 0;
  t.jrAvatar = 0; t.jrAvaOn = 0; t.jrPhaseUntil = 0; t.jrDominion = 0;
  t.jrGrown = 0; t.jrCourt = 0; t.jrDread = 0;
  // ...and Armageddon's: the blades, the ray and anything still due to land.
  jrKillList(t.jaBlades); t.jaLater = null; t.jaRay = 0;
  jrGrant(t, 0, 1);
}

function jrFx(g, kind, o) {
  if (!g.jrFx) g.jrFx = [];
  o = o || {}; o.kind = kind; o.at = g.tick;
  g.jrFx.push(o);
  if (g.jrFx.length > (g.jrFxCap || 20)) g.jrFx.shift();
}

// A drone with no barrel behind it. The engine's drone tick does not care where
// one came from, so RAISE and the husk shells cost nothing but an entity.
//
// They rot. A husk has no barrel counting it against a drone cap, so without a
// clock every RAISE, CONSCRIPT and DOMINION kill would add permanently to a
// standing army — measured, a long round ended with thousands of them and the
// arena spent its whole tick budget on the dead. Forty-five seconds is longer
// than any fight and shorter than a round, and the husk-wall passives top their
// wall back up every forty ticks, so a Sepulchre keeps its armour and a
// CONSCRIPT stays a burst rather than an annexation.
var JR_HUSK_LIFE = 45 * TPS;
// ...and no owner keeps more than this many at once, oldest first. The Royale
// never gets near it; an Armageddon pressing GENESIS through ECHO and OVERDRIVE
// stood three hundred and sixty up and kept them.
var JR_HUSK_CAP = 80;
function jrHusk(g, t, x, y, col) {
  var st = t.stats;
  var e = new Entity(g, {
    type: 'drone', sides: 3, size: Math.min(180, Math.max(8, t.size * 0.2)), x: x, y: y,
    team: t.team, owner: t, fill: col || '#8C2438', stroke: jrMix(col || '#8C2438', -0.34),
    maxHealth: (1.5 * st[S_PEN] + 2) * 12, damage: (7 + st[S_DAMAGE] * 3) * 0.5, absorb: 1, push: 4
  });
  e.minDmg = 1; e.maxDmg = 1; e.onlySameOwnerCollision = true;
  e.accel = (20 + BSPEED_GAIN * st[S_BSPEED]) * 1.25;
  e.controllable = true; e.life = Infinity;
  e.jrDie = g.tick + JR_HUSK_LIFE;
  if (!g.jrHusks) g.jrHusks = [];
  g.jrHusks.push(e);
  var mine = t.jrHuskQ || (t.jrHuskQ = []);
  mine.push(e);
  while (mine.length && mine[0].dead) mine.shift();
  while (mine.length > JR_HUSK_CAP) { var old = mine.shift(); if (!old.dead) old.kill(null); }
  return g.add(e);
}

// Swept alongside the burning ground, for the same reason and out of the same
// kind of list.
function jrTickHusks(g) {
  if (!g.jrHusks || !g.jrHusks.length) return;
  var live = [];
  for (var i = 0; i < g.jrHusks.length; i++) {
    var e = g.jrHusks[i];
    if (e.dead) continue;
    if (g.tick > e.jrDie || !e.owner || e.owner.dead) { e.kill(null); continue; }
    live.push(e);
  }
  g.jrHusks = live;
}

// --- the ability verbs ---------------------------------------------------
// One entry per verb. Returns the cooldown in seconds, or 0 for "there was
// nothing to do" — which costs the hull nothing, so a bot mashing SLAM in an
// empty field is not punished for it and a player mis-clicking is not either.
var JR_ABIL = {

  slam: function (g, t) {
    var reach = t.size * 2.7, hit = 0;
    jrEnemies(g, t, reach, function (e, d) {
      hit++;
      e.addVelocity(Math.atan2(e.y - t.y, e.x - t.x), 30 * (1 - d / reach));
      e.applyDamage(t.damagePerTick * 6, t);
    });
    if (!hit) return 0;
    jrFx(g, 'slam', { x: t.x, y: t.y, r: reach, tone: t.def.jrTone });
    t.notify('SLAM', 30);
    return 8;
  },

  // The Wrecking Ball's slam, with the ball thrown out on the end of it.
  quake: function (g, t) {
    var reach = t.size * 4.2, hit = 0;
    jrEnemies(g, t, reach, function (e, d) {
      hit++;
      e.addVelocity(Math.atan2(e.y - t.y, e.x - t.x), 42 * (1 - d / reach));
      e.applyDamage(t.damagePerTick * 8, t);
      jrChill(e, 1.5 * TPS, 0.7);
    });
    t.jrSwing = g.tick + 4 * TPS;
    jrFx(g, 'quake', { x: t.x, y: t.y, r: reach, tone: t.def.jrTone });
    t.notify('QUAKE', 30);
    return hit ? 11 : 6;
  },

  // Ten traps around itself, fired through the ordinary barrel path so they
  // obey every rule an ordinary trap does.
  barricade: function (g, t) {
    var gun = t.barrels[0];
    if (!gun) return 0;
    var keep = gun.def.angle;
    for (var i = 0; i < 10; i++) { gun.def.angle = Math.PI * 2 * (i / 10); gun.shoot(); }
    gun.def.angle = keep;
    jrFx(g, 'barricade', { x: t.x, y: t.y, r: t.size * 3, tone: t.def.jrTone });
    t.notify('BARRICADE', 30);
    return 12;
  },

  swarm: function (g, t) {
    var tgt = jrNearestFoe(g, t, 3400);
    if (!tgt) return 0;
    var sent = 0;
    for (var i = 0; i < g.entities.length; i++) {
      var dr = g.entities[i];
      if (dr.dead || !(dr.type === 'drone' || dr.type === 'swarm' || dr.type === 'minion')) continue;
      if (!jrOwn(dr, t)) continue;
      dr.addVelocity(Math.atan2(tgt.y - dr.y, tgt.x - dr.x), 22);
      dr.dTarget = tgt;
      sent++;
    }
    if (!sent) return 0;
    jrFx(g, 'swarm', { x: t.x, y: t.y, tx: tgt.x, ty: tgt.y, tone: t.def.jrTone });
    t.notify('SWARM', 30);
    return 10;
  },

  pull: function (g, t) {
    var r = t.size * 9, hit = 0;
    jrEnemies(g, t, r, function (e, d) {
      hit++;
      e.addVelocity(Math.atan2(t.y - e.y, t.x - e.x), 26 * (1 - d / r) + 6);
      jrChill(e, 1.2 * TPS, 0.75);
    });
    jrEach(g, t, r, JR_T_SHOT, function (e, d) {
      if (jrOwn(e, t)) return;
      e.addVelocity(Math.atan2(t.y - e.y, t.x - e.x), 22 * (1 - d / r));
    });
    jrFx(g, 'pull', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('PULL', 30);
    return hit ? 9 : 5;
  },

  repel: function (g, t) {
    var r = t.size * 8, hit = 0;
    jrEnemies(g, t, r, function (e, d) {
      hit++;
      e.addVelocity(Math.atan2(e.y - t.y, e.x - t.x), 34 * (1 - d / r) + 8);
    });
    jrEach(g, t, r, JR_T_SHOT, function (e) { if (!jrOwn(e, t)) e.kill(t); });
    jrFx(g, 'repel', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('REPEL', 30);
    return hit ? 9 : 6;
  },

  ignite: function (g, t) {
    var r = t.size * 6, hit = 0;
    jrEnemies(g, t, r, function (e) { hit++; jrBurn(e, 6 * TPS, t.maxHealth * 0.0016 + 3, t); });
    jrField(g, t, 'burn', t.x, t.y, r * 0.9, 6 * TPS, '#8A3B1E');
    jrFx(g, 'ignite', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('IGNITE', 30);
    return 8;
  },

  // Spends banked heat. At a full bank it survives the detonation on one health
  // instead of dying — once, because the bank is then empty.
  overload: function (g, t) {
    var heat = t.jrHeat || 0;
    if (heat < t.maxHealth * 0.15) return 0;
    var r = t.size * (5 + 6 * Math.min(1, heat / t.maxHealth));
    jrEnemies(g, t, r, function (e, d) {
      e.applyDamage(heat * 0.55 * (1 - d / r * 0.6), t);
      e.addVelocity(Math.atan2(e.y - t.y, e.x - t.x), 30);
      jrBurn(e, 5 * TPS, t.maxHealth * 0.002 + 4, t);
    });
    if (heat >= t.maxHealth * 0.9) { t.health = Math.max(t.health, 1); t.notify('MELTDOWN', 60); }
    else t.notify('OVERLOAD', 30);
    t.jrHeat = 0;
    jrFx(g, 'overload', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    return 14;
  },

  freeze: function (g, t) {
    var r = t.size * 6.5, hit = 0;
    jrEnemies(g, t, r, function (e) { hit++; jrHold(e, 1.4 * TPS); });
    if (!hit) return 0;
    jrFx(g, 'freeze', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('FREEZE', 30);
    return 11;
  },

  slick: function (g, t) {
    jrField(g, t, 'ice', t.x, t.y, t.size * 7, 14 * TPS, '#7FD4F0');
    jrFx(g, 'slick', { x: t.x, y: t.y, r: t.size * 7, tone: t.def.jrTone });
    t.notify('SLICK', 30);
    return 10;
  },

  reap: function (g, t) {
    var r = t.size * 5.5, taken = 0;
    jrEnemies(g, t, r, function (e) {
      var bite = Math.min(e.health, t.maxHealth * 0.06 + 20);
      e.applyDamage(bite, t);
      taken += bite;
    });
    if (!taken) return 0;
    t.health = Math.min(t.maxHealth, t.health + taken * 0.8);
    jrFx(g, 'reap', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('REAP', 30);
    return 9;
  },

  // Corpses first, then whatever polygons are lying about. Either way it walks
  // away with a working swarm it did not have to reload for.
  raise: function (g, t) {
    var made = 0, want = 6;
    jrEach(g, t, t.size * 9, JR_T_SHAPE, function (e) {
      if (made >= want || e.kind === 'alpha') return;
      e.kill(t); jrHusk(g, t, e.x, e.y, '#8C2438'); made++;
    });
    while (made < 3) {
      var a = Math.random() * Math.PI * 2;
      jrHusk(g, t, t.x + Math.cos(a) * t.size * 2, t.y + Math.sin(a) * t.size * 2, '#8C2438');
      made++;
    }
    jrFx(g, 'raise', { x: t.x, y: t.y, r: t.size * 9, tone: t.def.jrTone });
    t.notify('RAISE', 30);
    return 12;
  },

  decoy: function (g, t) {
    jrKillList(t.jrDecoys);
    var n = t.def.jrTier >= 3 ? 3 : 2;
    for (var i = 0; i < n; i++) jrDecoy(g, t, Math.PI * 2 * (i / n) + Math.random());
    jrFx(g, 'decoy', { x: t.x, y: t.y, r: t.size * 3, tone: t.def.jrTone });
    t.notify('DECOY', 30);
    return 10;
  },

  blink: function (g, t) {
    var a = Math.atan2(t.mouse.y - t.y, t.mouse.x - t.x);
    var d = Math.min(620, Math.hypot(t.mouse.x - t.x, t.mouse.y - t.y) || 620);
    jrDecoy(g, t, a + Math.PI);
    var from = { x: t.x, y: t.y };
    t.x = Math.max(g.arena.left + t.size, Math.min(g.arena.right - t.size, t.x + Math.cos(a) * d));
    t.y = Math.max(g.arena.top + t.size, Math.min(g.arena.bottom - t.size, t.y + Math.sin(a) * d));
    t.px = t.x; t.py = t.y;                        // no interpolation streak
    jrFx(g, 'blink', { x: from.x, y: from.y, tx: t.x, ty: t.y, tone: t.def.jrTone });
    t.notify('BLINK', 30);
    return 6;
  },

  rewind: function (g, t) {
    var h = t.jrHist && t.jrHist.length ? t.jrHist[0] : null;
    if (!h) return 0;
    t.x = h.x; t.y = h.y; t.px = t.x; t.py = t.y; t.vx = 0; t.vy = 0;
    t.health = Math.min(t.maxHealth, Math.max(t.health, h.hp));
    t.jrHist.length = 0;
    jrFx(g, 'rewind', { x: t.x, y: t.y, r: t.size * 3, tone: t.def.jrTone });
    t.notify('REWIND', 30);
    return 16;
  },

  dilate: function (g, t) {
    var r = t.size * 9, hit = 0;
    jrEnemies(g, t, r, function (e) { hit++; jrChill(e, 4 * TPS, 0.5); e.jrDilate = g.tick + 4 * TPS; });
    jrEach(g, t, r, JR_T_SHOT, function (e) { if (!jrOwn(e, t)) { e.vx *= 0.35; e.vy *= 0.35; e.accel *= 0.5; } });
    jrFx(g, 'dilate', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('DILATE', 30);
    return hit ? 12 : 7;
  },

  deploy: function (g, t) {
    t.jrRoot = t.jrRoot ? 0 : g.tick + 60 * TPS;
    jrFx(g, 'deploy', { x: t.x, y: t.y, r: t.size * 2, on: !!t.jrRoot, tone: t.def.jrTone });
    t.notify(t.jrRoot ? 'DEPLOYED' : 'MOBILE', 30);
    return 2;
  },

  // The shell goes where the cursor is, not where the barrel points: it is
  // fired down the barrel and then given exactly the life it needs to get there.
  mortar: function (g, t) {
    var gun = null;
    for (var i = 0; i < t.barrels.length; i++) if (t.barrels[i].def.bullet.type === 'firework') gun = t.barrels[i];
    if (!gun) gun = t.barrels[0];
    if (!gun) return 0;
    var p = gun.shoot();
    if (!p) return 0;
    var d = Math.hypot(t.mouse.x - t.x, t.mouse.y - t.y);
    var sp = Math.max(6, Math.hypot(p.vx, p.vy));
    p.life = Math.max(6, Math.min(p.life, Math.round(d / sp)));
    jrFx(g, 'mortar', { x: t.mouse.x, y: t.mouse.y, r: 300, tone: t.def.jrTone });
    t.notify('MORTAR', 30);
    return 7;
  },

  turrets: function (g, t) {
    jrKillList(t.jrTurrets);
    var n = t.def.jrTier >= 3 ? 6 : 4;
    for (var i = 0; i < n; i++) jrTurret(g, t, Math.PI * 2 * (i / n), 15 * TPS);
    jrFx(g, 'turrets', { x: t.x, y: t.y, r: t.size * 2.4, tone: t.def.jrTone });
    t.notify('TURRETS', 30);
    return 18;
  },

  infest: function (g, t) {
    var tgt = jrNearestFoe(g, t, t.size * 14);
    if (!tgt) return 0;
    t.jrHost = tgt; t.jrHostUntil = g.tick + 7 * TPS;
    jrBleed(tgt, t);
    jrFx(g, 'infest', { x: t.x, y: t.y, tx: tgt.x, ty: tgt.y, tone: t.def.jrTone });
    t.notify('INFEST', 30);
    return 10;
  },

  hijack: function (g, t) {
    var took = 0;
    jrEach(g, t, t.size * 12, JR_T_SHOT, function (e) {
      if (took >= 24) return;
      if (!(e.type === 'drone' || e.type === 'swarm' || e.type === 'minion' || e.type === 'necro')) return;
      if (jrOwn(e, t) || !e.owner) return;
      e.jrOwner0 = e.owner; e.jrRevert = g.tick + 5 * TPS;
      e.owner = t; e.team = t.team; e.fill = t.fill; e.stroke = t.stroke;
      e.controllable = true; e.dTarget = null;
      took++;
    });
    if (!took) return 0;
    jrFx(g, 'hijack', { x: t.x, y: t.y, r: t.size * 12, tone: t.def.jrTone });
    t.notify('HIJACK x' + took, 30);
    return 14;
  },

  bubble: function (g, t) {
    t.jrBubble = g.tick + 8 * TPS;
    jrFx(g, 'bubble', { x: t.x, y: t.y, r: t.size * 5, tone: t.def.jrTone });
    t.notify('QUARANTINE', 30);
    return 18;
  },

  tether: function (g, t) {
    var tgt = jrNearestFoe(g, t, 2600);
    if (!tgt) return 0;
    t.jrTether = tgt; t.jrTetherUntil = g.tick + 12 * TPS;
    jrFx(g, 'tether', { x: t.x, y: t.y, tx: tgt.x, ty: tgt.y, tone: t.def.jrTone });
    t.notify('TETHERED', 30);
    return 14;
  },

  // Place, place, jump. Three presses, two pads, one shortcut nobody else owns.
  warp: function (g, t) {
    if (!t.jrPads) t.jrPads = [];
    t.jrPads = t.jrPads.filter(function (p) { return !p.dead; });
    if (t.jrPads.length < 2) {
      var p = labMark(g, { x: t.x, y: t.y, size: 120, sides: 8, fill: '#8FA7FF', stroke: '#5B6FBF' });
      p.jrOwner = t;
      t.jrPads.push(p);
      t.notify('PAD ' + t.jrPads.length, 30);
      return 4;
    }
    var a = t.jrPads[0], b = t.jrPads[1];
    var near = Math.hypot(t.x - a.x, t.y - a.y) < Math.hypot(t.x - b.x, t.y - b.y) ? b : a;
    var from = { x: t.x, y: t.y };
    t.x = near.x; t.y = near.y; t.px = t.x; t.py = t.y;
    jrFx(g, 'blink', { x: from.x, y: from.y, tx: t.x, ty: t.y, tone: t.def.jrTone });
    t.notify('WARP', 30);
    return 6;
  },

  graft: function (g, t) {
    var ate = 0;
    jrEach(g, t, t.size * 7, JR_T_SHAPE, function (e) {
      if (ate >= 5) return;
      e.kill(t); ate++;
    });
    if (!ate) return 0;
    t.jrPlates = Math.min(24, (t.jrPlates || 0) + ate);
    jrFx(g, 'graft', { x: t.x, y: t.y, r: t.size * 7, tone: t.def.jrTone });
    t.notify('GRAFT +' + ate, 30);
    return 8;
  },

  harden: function (g, t) {
    t.jrHarden = g.tick + 3 * TPS;
    jrFx(g, 'harden', { x: t.x, y: t.y, r: t.size * 1.8, tone: t.def.jrTone });
    t.notify('HARDEN', 30);
    return 16;
  },

  beam: function (g, t) {
    t.jrBeam = g.tick + 1.5 * TPS;
    t.notify('BEAM', 30);
    return 12;
  },

  // Throws the shell off in a ring of burning debris and leaves something
  // smaller, faster and much angrier standing in it.
  shed: function (g, t) {
    var gun = t.barrels[0];
    if (gun) {
      var keep = gun.def.angle;
      for (var i = 0; i < 12; i++) { gun.def.angle = Math.PI * 2 * (i / 12); gun.shoot(); }
      gun.def.angle = keep;
    }
    jrField(g, t, 'burn', t.x, t.y, t.size * 5, 7 * TPS, '#8A3B1E');
    t.jrShed = g.tick + 6 * TPS;
    jrFx(g, 'shed', { x: t.x, y: t.y, r: t.size * 5, tone: t.def.jrTone });
    t.notify('SHED', 30);
    return 20;
  },

  bloom: function (g, t) {
    for (var i = 0; i < 5; i++) {
      var a = Math.random() * Math.PI * 2, r = t.size * (2 + Math.random() * 3);
      g.add(new Shape(g, Math.random() < 0.3 ? 'hexagon' : 'pentagon', t.x + Math.cos(a) * r, t.y + Math.sin(a) * r));
    }
    jrFx(g, 'bloom', { x: t.x, y: t.y, r: t.size * 5, tone: t.def.jrTone });
    t.notify('BLOOM', 30);
    return 12;
  },

  mark: function (g, t) {
    t.jrMark = g.tick + 12 * TPS;
    jrFx(g, 'mark', { x: t.x, y: t.y, r: t.size * 10, tone: t.def.jrTone });
    g.notify((t.name || 'A Beacon') + ' lit the field up', 50);
    return 20;
  },

  // Fires the health segments off as shrapnel. They come back; the health they
  // were holding does not, until they do.
  shatter: function (g, t) {
    if (!t.jrOrbs || !t.jrOrbs.length) return 0;
    var n = 0;
    for (var i = 0; i < t.jrOrbs.length; i++) {
      var o = t.jrOrbs[i];
      if (!o || o.dead) continue;
      jrEnemies(g, t, t.size * 8, function (e) { e.applyDamage(t.maxHealth * 0.04, t); });
      o.kill(t); n++;
    }
    t.jrOrbs.length = 0;
    t.jrOrbAt = g.tick + 8 * TPS;                  // they grow back
    if (!n) return 0;
    jrFx(g, 'shatter', { x: t.x, y: t.y, r: t.size * 8, tone: t.def.jrTone });
    t.notify('SHATTER', 30);
    return 14;
  },

  // Whichever half of itself the Thermocline is currently holding.
  thermal: function (g, t) {
    var hot = Math.floor(g.tick / (4 * TPS)) % 2 === 0;
    var r = t.size * 6.5, hit = 0;
    jrEnemies(g, t, r, function (e) {
      hit++;
      if (hot) jrBurn(e, 6 * TPS, t.maxHealth * 0.0018 + 4, t);
      else jrHold(e, 1.2 * TPS);
    });
    jrFx(g, hot ? 'ignite' : 'freeze', { x: t.x, y: t.y, r: r, tone: hot ? '255,150,90' : '150,225,255' });
    t.notify(hot ? 'THERMAL — FIRE' : 'THERMAL — ICE', 30);
    return hit ? 9 : 5;
  },

  // The Extinction's button. Every other nova in the mode is a ring around the
  // hull; this one is a ring around the screen, and it does not care whether
  // anything is standing in it — an Omega firing into an empty field is still
  // a field that is now on fire.
  nova: function (g, t) {
    var r = t.size * 11;
    jrEnemies(g, t, r, function (e, d) {
      var falloff = 1 - d / r * 0.55;
      e.applyDamage((t.maxHealth * 0.16 + 220) * falloff, t);
      e.addVelocity(Math.atan2(e.y - t.y, e.x - t.x), 46);
      jrBurn(e, 7 * TPS, t.maxHealth * 0.0022 + 10, t);
      jrChill(e, 4 * TPS, 0.45);
    });
    jrEach(g, t, r, JR_T_SHOT, function (e) { if (!jrOwn(e, t)) e.kill(null); });
    jrField(g, t, 'burn', t.x, t.y, r * 0.8, 10 * TPS, '#8A3B1E');
    jrFx(g, 'overload', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('NOVA', 60);
    return 22;
  },

  // The Apotheosis's button. Not a weapon — a refusal. Full bar, every status
  // burned off, and four seconds where damage barely registers.
  ascend: function (g, t) {
    t.health = t.maxHealth;
    t.jrBurn = 0; t.jrBurnDps = 0; t.jrChill = 0; t.jrChillF = 1; t.jrHold = 0; t.jrBleed = null;
    t.jrAscend = g.tick + 4 * TPS;
    jrFx(g, 'raise', { x: t.x, y: t.y, r: t.size * 4, tone: t.def.jrTone });
    t.notify('ASCEND', 60);
    return 40;
  },

  // --- the late verbs ----------------------------------------------------
  // Everything below belongs to tier 5 and up. The branch verbs are all a ring
  // around the hull, because a branch hull is a tank; these are not, because
  // the things above the fusions are not really tanks any more. They reach the
  // cursor, the screen, or the whole board, and most hulls up here carry three
  // or four of them at once — one on right-click and the rest firing themselves.

  // METEOR: nine shells walked across the area under the cursor.
  meteor: function (g, t) {
    var cx = t.mouse.x, cy = t.mouse.y, spread = t.size * 6, hit = 0;
    for (var i = 0; i < 9; i++) {
      var a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * spread;
      var x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      hit += jrBlast(g, t, x, y, t.size * 1.9, t.maxHealth * 0.022 + 45, { push: 20, burn: 4 });
      if (i % 3 === 0) jrFx(g, 'mortar', { x: x, y: y, r: t.size * 2.4, tone: t.def.jrTone });
    }
    jrField(g, t, 'burn', cx, cy, spread * 0.7, 6 * TPS, '#8A3B1E');
    t.notify('METEOR', 40);
    return 13;
  },

  // ECLIPSE: a lid of fire over the whole area, for eight seconds.
  eclipse: function (g, t) {
    var r = t.size * 8;
    jrField(g, t, 'burn', t.x, t.y, r, 8 * TPS, '#7A2E12');
    jrEnemies(g, t, r, function (e) {
      jrBurn(e, 8 * TPS, t.maxHealth * 0.0022 + 8, t);
      jrChill(e, 3 * TPS, 0.7);
    });
    jrFx(g, 'overload', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('ECLIPSE', 40);
    return 15;
  },

  // COLLAPSE: the whole screen is dragged into one point, and then the point
  // goes off. A well's worth of pull and a nova's worth of arrival in one press.
  collapse: function (g, t) {
    var r = t.size * 13, hit = 0;
    jrEnemies(g, t, r, function (e, d) {
      hit++;
      e.addVelocity(Math.atan2(t.y - e.y, t.x - e.x), Math.min(52, 20 + d * 0.03));
      e.applyDamage(t.maxHealth * 0.04 + 60, t);
      jrHold(e, 0.8 * TPS);
    });
    jrEach(g, t, r, JR_T_SHOT, function (e) { if (!jrOwn(e, t)) e.kill(t); });
    jrFx(g, 'pull', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('COLLAPSE', 40);
    return hit ? 16 : 9;
  },

  // RUPTURE: the ground opens in a line from the hull to the cursor.
  rupture: function (g, t) {
    var a = Math.atan2(t.mouse.y - t.y, t.mouse.x - t.x);
    var reach = Math.min(2600, Math.max(900, Math.hypot(t.mouse.x - t.x, t.mouse.y - t.y)));
    var steps = 7, hit = 0;
    for (var i = 1; i <= steps; i++) {
      var x = t.x + Math.cos(a) * reach * (i / steps), y = t.y + Math.sin(a) * reach * (i / steps);
      hit += jrBlast(g, t, x, y, t.size * 1.6, t.maxHealth * 0.03 + 55, { push: 26, burn: 3 });
      if (i % 2) jrFx(g, 'quake', { x: x, y: y, r: t.size * 2, tone: t.def.jrTone });
    }
    t.notify('RUPTURE', 40);
    return hit ? 14 : 8;
  },

  // CONSCRIPT: RAISE without the modesty. Every polygon and every corpse in a
  // twelve-radius circle gets up on your side, and a squad turns up regardless.
  conscript: function (g, t) {
    var made = 0;
    jrEach(g, t, t.size * 12, JR_T_SHAPE, function (e) {
      if (made >= 14 || e.kind === 'alpha') return;
      e.kill(t); jrHusk(g, t, e.x, e.y, '#8C2438'); made++;
    });
    while (made < 8) {
      var a = Math.random() * Math.PI * 2;
      jrHusk(g, t, t.x + Math.cos(a) * t.size * 2, t.y + Math.sin(a) * t.size * 2, '#8C2438');
      made++;
    }
    jrFx(g, 'raise', { x: t.x, y: t.y, r: t.size * 12, tone: t.def.jrTone });
    t.notify('CONSCRIPT x' + made, 40);
    return 16;
  },

  // STASIS: the screen stops. Not the ring — everything the hull can see, tanks
  // and shots alike, for two seconds.
  stasis: function (g, t) {
    var r = t.size * 12, hit = 0;
    jrEnemies(g, t, r, function (e) { hit++; jrHold(e, 2 * TPS); jrChill(e, 5 * TPS, 0.45); });
    // Velocity only. `accel` is a permanent field on a drone, so scaling it
    // would cripple a hangar for the rest of the round rather than for two
    // seconds — a bullet does not care because it is gone in a second anyway.
    jrEach(g, t, r, JR_T_SHOT, function (e) {
      if (jrOwn(e, t)) return;
      e.vx *= 0.08; e.vy *= 0.08;
    });
    if (!hit) return 0;
    jrFx(g, 'freeze', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('STASIS', 40);
    return 18;
  },

  // AVATAR: eight seconds of being twice the tank. jrTickTank holds the state.
  avatar: function (g, t) {
    t.jrAvatar = g.tick + 8 * TPS;
    jrFx(g, 'raise', { x: t.x, y: t.y, r: t.size * 4, tone: t.def.jrTone });
    t.notify('AVATAR', 60);
    return 26;
  },

  // JUDGEMENT: no travel time, no line of sight, no dodge. A share of the
  // maximum health off everything in a very large circle, taken.
  judgement: function (g, t) {
    var r = t.size * 16, hit = 0;
    jrEnemies(g, t, r, function (e) {
      hit++;
      e.applyDamage(e.maxHealth * 0.11 + t.maxHealth * 0.02, t);
      e.hurtFlash = 6;
    });
    if (!hit) return 0;
    jrFx(g, 'mark', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('JUDGEMENT x' + hit, 50);
    return 20;
  },

  // ARC: lightning that walks from one tank to the next, losing a fifth a hop.
  arc: function (g, t) {
    var from = t, seen = {}, links = 0, dmg = t.maxHealth * 0.05 + 70;
    for (var i = 0; i < 6; i++) {
      var next = null, bd = t.size * 9;
      var list = labTanks(g, JR_SCRATCH3);
      for (var j = 0; j < list.length; j++) {
        var e = list[j];
        if (e === t || seen[e.id] || !jrFoe(t, e)) continue;
        var d = Math.hypot(e.x - from.x, e.y - from.y);
        if (d < bd) { bd = d; next = e; }
      }
      if (!next) break;
      seen[next.id] = 1;
      jrFx(g, 'tether', { x: from.x, y: from.y, tx: next.x, ty: next.y, tone: t.def.jrTone });
      next.applyDamage(dmg, t);
      jrHold(next, 0.4 * TPS);
      from = next; links++; dmg *= 0.82;
    }
    if (!links) return 0;
    t.notify('ARC x' + links, 40);
    return 12;
  },

  // CITADEL: a fort in one press — sixteen walls and eight turrets inside them.
  // It does not sweep the existing turrets, because a retinue hull's escorts
  // are furniture it is supposed to keep.
  citadel: function (g, t) {
    var gun = null, i;
    for (i = 0; i < t.barrels.length; i++)
      if (t.barrels[i].def.bullet.type === 'trap') { gun = t.barrels[i]; break; }
    if (gun) {
      var keep = gun.def.angle;
      for (i = 0; i < 16; i++) { gun.def.angle = Math.PI * 2 * (i / 16); gun.shoot(); }
      gun.def.angle = keep;
    }
    for (i = 0; i < 8; i++) jrTurret(g, t, Math.PI * 2 * (i / 8) + 0.2, 25 * TPS);
    jrFx(g, 'barricade', { x: t.x, y: t.y, r: t.size * 3.4, tone: t.def.jrTone });
    t.notify('CITADEL', 50);
    return 20;
  },

  // UNMAKE: every hostile shot on the screen simply stops existing.
  unmake: function (g, t) {
    var n = 0;
    jrEach(g, t, t.size * 15, JR_T_SHOT, function (e) { if (!jrOwn(e, t)) { e.kill(null); n++; } });
    if (!n) return 0;
    jrFx(g, 'repel', { x: t.x, y: t.y, r: t.size * 15, tone: t.def.jrTone });
    t.notify('UNMAKE x' + n, 40);
    return 15;
  },

  // WARPSTORM: whoever was keeping their distance is not any more.
  warpstorm: function (g, t) {
    var moved = 0, list = labTanks(g, JR_SCRATCH3);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e === t || !jrFoe(t, e)) continue;
      var d = Math.hypot(e.x - t.x, e.y - t.y);
      if (d < t.size * 3.5 || d > t.size * 22) continue;
      var a = Math.random() * Math.PI * 2, rr = t.size * 2.6;
      var nx = t.x + Math.cos(a) * rr, ny = t.y + Math.sin(a) * rr;
      jrFx(g, 'blink', { x: e.x, y: e.y, tx: nx, ty: ny, tone: t.def.jrTone });
      e.x = nx; e.y = ny; e.px = nx; e.py = ny; e.vx = 0; e.vy = 0;
      jrChill(e, 2 * TPS, 0.5);
      moved++;
    }
    if (!moved) return 0;
    t.notify('WARPSTORM x' + moved, 40);
    return 18;
  },

  // TERRAFORM: fire and ice laid down as geography rather than as weather.
  terraform: function (g, t) {
    for (var i = 0; i < 6; i++) {
      var a = Math.PI * 2 * (i / 6);
      jrField(g, t, i % 2 ? 'ice' : 'burn',
        t.x + Math.cos(a) * t.size * 4.5, t.y + Math.sin(a) * t.size * 4.5,
        t.size * 3.2, 16 * TPS, i % 2 ? '#7FD4F0' : '#8A3B1E');
    }
    jrField(g, t, 'ice', t.x, t.y, t.size * 5, 16 * TPS, '#7FD4F0');
    jrFx(g, 'slick', { x: t.x, y: t.y, r: t.size * 8, tone: t.def.jrTone });
    t.notify('TERRAFORM', 50);
    return 22;
  },

  // ENTHRONE: ASCEND grown up. Full bar, every status burned off, the shield
  // back, every cooldown in the hull reset, and five seconds of not caring.
  enthrone: function (g, t) {
    t.health = t.maxHealth;
    t.jrBurn = 0; t.jrBurnDps = 0; t.jrChill = 0; t.jrChillF = 1; t.jrHold = 0; t.jrBleed = null;
    t.jrAscend = g.tick + 5 * TPS;
    t.jrShield = t.jrShieldMax || 0;
    t.jrCool = 0;
    if (t.jrCools) for (var k in t.jrCools) t.jrCools[k] = 0;
    jrFx(g, 'raise', { x: t.x, y: t.y, r: t.size * 5, tone: t.def.jrTone });
    t.notify('ENTHRONE', 70);
    return 45;
  },

  // APOCALYPSE: NOVA was a ring around a hull. This is the screen, and the
  // ground it leaves behind is on fire for fourteen seconds.
  apocalypse: function (g, t) {
    var r = t.size * 18;
    jrEnemies(g, t, r, function (e) {
      e.applyDamage(e.maxHealth * 0.14 + t.maxHealth * 0.05, t);
      e.addVelocity(Math.atan2(e.y - t.y, e.x - t.x), 40);
      jrBurn(e, 10 * TPS, t.maxHealth * 0.0026 + 22, t);
      jrChill(e, 5 * TPS, 0.4);
    });
    jrEach(g, t, r, JR_T_SHOT, function (e) { if (!jrOwn(e, t)) e.kill(null); });
    for (var i = 0; i < 8; i++) {
      var a = Math.PI * 2 * (i / 8);
      jrField(g, t, 'burn', t.x + Math.cos(a) * r * 0.55, t.y + Math.sin(a) * r * 0.55,
        t.size * 4, 14 * TPS, '#8A3B1E');
    }
    jrField(g, t, 'burn', t.x, t.y, t.size * 6, 14 * TPS, '#8A3B1E');
    jrFx(g, 'overload', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    g.notify((t.name || 'Something') + ' set the field on fire', 90);
    t.notify('APOCALYPSE', 80);
    return 30;
  },

  // DOMINION: twelve seconds where everything it kills gets back up for it.
  // jrDeath reads the window; this only opens it.
  dominion: function (g, t) {
    t.jrDominion = g.tick + 12 * TPS;
    jrFx(g, 'raise', { x: t.x, y: t.y, r: t.size * 6, tone: t.def.jrTone });
    t.notify('DOMINION', 60);
    return 26;
  },

  // EPOCH: REWIND, but the arena takes it. Everything hostile on the screen is
  // put back where it stood three seconds ago and held there.
  epoch: function (g, t) {
    var r = t.size * 14, n = 0;
    jrEnemies(g, t, r, function (e) {
      var h = e.jrHist && e.jrHist.length ? e.jrHist[0] : null;
      if (h) { e.x = h.x; e.y = h.y; e.px = e.x; e.py = e.y; e.jrHist.length = 0; }
      e.vx = 0; e.vy = 0;
      jrHold(e, 1.2 * TPS);
      n++;
    });
    if (!n) return 0;
    jrFx(g, 'rewind', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('EPOCH x' + n, 50);
    return 24;
  },

  // --- Armageddon's verbs ------------------------------------------------
  // The five tiers past the crowns. The late verbs above reach the screen; these
  // reach the arena, and most of them keep happening for a while after the
  // press — jaLater is how a button goes on landing for three seconds.

  // OVERDRIVE: every other button on the hull, all at once, cooldown or not.
  // The point of a hull with eight verbs is that sometimes you get all eight.
  overdrive: function (g, t, h) {
    var list = (h && h.abs) || [], n = 0;
    if (!t.jrCools) t.jrCools = {};
    for (var i = 0; i < list.length; i++) {
      if (list[i] === 'overdrive') continue;
      var cd = jrCast(g, t, h, list[i]);
      if (cd) { n++; t.jrCools[list[i]] = g.tick + cd * TPS; }
    }
    if (!n) return 0;
    jrFx(g, 'overdrive', { x: t.x, y: t.y, r: t.size * 7, tone: t.def.jrTone, tone2: t.def.jrTone2 });
    t.notify('OVERDRIVE x' + n, 70);
    return 32;
  },

  // SUPERNOVA: APOCALYPSE was the screen. This is three shockwaves a second
  // apart, each wider than the last, and a ring of fire and ice left behind.
  supernova: function (g, t) {
    var r = t.size * 22;
    function wave(k) {
      if (t.dead) return;
      var rr = r * (0.5 + 0.5 * k);
      jrEnemies(g, t, rr, function (e, d) {
        e.applyDamage((e.maxHealth * 0.08 + t.maxHealth * 0.02) * (1 - d / (rr * 1.6)), t);
        e.addVelocity(Math.atan2(e.y - t.y, e.x - t.x), 44);
        jrBurn(e, 8 * TPS, t.maxHealth * 0.0015 + 30, t);
        jrChill(e, 4 * TPS, 0.4);
      });
      jrEach(g, t, rr, JR_T_SHOT, function (e) { if (!jrOwn(e, t)) e.kill(null); });
      jrFx(g, 'supernova', { x: t.x, y: t.y, r: rr, tone: t.def.jrTone, tone2: t.def.jrTone2 });
    }
    wave(0);
    jaLater(g, t, 1.1 * TPS, function () { wave(0.5); });
    jaLater(g, t, 2.2 * TPS, function () { wave(1); });
    for (var i = 0; i < 10; i++) {
      var a = Math.PI * 2 * (i / 10);
      jrField(g, t, i % 2 ? 'ice' : 'burn', t.x + Math.cos(a) * r * 0.45, t.y + Math.sin(a) * r * 0.45,
        t.size * 2.6, 14 * TPS, i % 2 ? '#7FD4F0' : '#8A3B1E');
    }
    g.notify((t.name || 'Something') + ' went supernova', 90);
    t.notify('SUPERNOVA', 80);
    return 34;
  },

  // BLACK HOLE: a well that is not bolted to anything. It opens under the
  // cursor, drags tanks and shots in, and whatever reaches the middle is taken
  // apart a percentage at a time. jrTickFields runs it.
  blackhole: function (g, t, h, at) {
    var x = at ? at.x : t.mouse.x, y = at ? at.y : t.mouse.y, r = t.size * 4.5;
    jrField(g, t, 'well', x, y, r, 9 * TPS, '#0B0816');
    jrFx(g, 'blackhole', { x: x, y: y, r: r * 2.4, tone: t.def.jrTone });
    t.notify('BLACK HOLE', 50);
    return 16;
  },

  // SKYFALL: the seven nearest things it does not like are struck from above,
  // one after another, wherever they happen to be standing.
  skyfall: function (g, t) {
    var list = labTanks(g, JA_SCRATCH), foes = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e === t || !jrFoe(t, e)) continue;
      var d = Math.hypot(e.x - t.x, e.y - t.y);
      if (d < t.size * 20) foes.push({ e: e, d: d });
    }
    if (!foes.length) return 0;
    foes.sort(function (a, b) { return a.d - b.d; });
    foes.length = Math.min(7, foes.length);
    foes.forEach(function (f, k) {
      jaLater(g, t, k * 5, function () {
        var e = f.e;
        if (e.dead || t.dead) return;
        jrBlast(g, t, e.x, e.y, Math.max(e.size * 1.4, t.size * 0.8),
          e.maxHealth * 0.07 + t.maxHealth * 0.01, { push: 18, burn: 3 });
        jrFx(g, 'skyfall', { x: e.x, y: e.y, r: Math.max(e.size * 2, t.size), tone: t.def.jrTone });
      });
    });
    t.notify('SKYFALL x' + foes.length, 50);
    return 14;
  },

  // TIME STOP: STASIS held the screen for two seconds. This holds it for four,
  // and it holds the shots in the air as well, so the volley you fired at it is
  // still hanging there, pointed at you, when the clock starts again.
  timestop: function (g, t) {
    var r = t.size * 18, hit = 0, until = g.tick + 4 * TPS;
    jrEnemies(g, t, r, function (e) { hit++; jrHold(e, 4 * TPS); jrChill(e, 7 * TPS, 0.4); });
    if (!hit) return 0;
    if (!g.jaFrozen) g.jaFrozen = [];
    jrEach(g, t, r, JR_T_SHOT, function (e) {
      if (jrOwn(e, t)) return;
      e.vx = 0; e.vy = 0; e.jaFrozen = until;
      g.jaFrozen.push(e);
    });
    g.jaTimestop = { at: g.tick, until: until, x: t.x, y: t.y, r: r, tone: t.def.jrTone };
    jrFx(g, 'timestop', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    t.notify('TIME STOP', 60);
    return 24;
  },

  // RAPTURE: everything in reach is lifted off the floor — held, guns dead —
  // and a second and a half later it is dropped from a great height.
  rapture: function (g, t) {
    var r = t.size * 15, caught = [];
    jrEnemies(g, t, r, function (e) { caught.push(e); jrHold(e, 1.6 * TPS); e.jaLift = g.tick; });
    if (!caught.length) return 0;
    jrFx(g, 'rapture', { x: t.x, y: t.y, r: r, tone: t.def.jrTone });
    jaLater(g, t, 1.5 * TPS, function () {
      for (var i = 0; i < caught.length; i++) {
        var e = caught[i];
        if (e.dead) continue;
        e.applyDamage(e.maxHealth * 0.15 + t.maxHealth * 0.008, t);
        e.hurtFlash = 8;
        jrFx(g, 'slam', { x: e.x, y: e.y, r: e.size * 3, tone: t.def.jrTone });
      }
    });
    t.notify('RAPTURE x' + caught.length, 60);
    return 22;
  },

  // GENESIS: it makes an army. Eighteen husks in a ring and six escorts that
  // fly with the hull for twenty seconds.
  genesis: function (g, t) {
    var i;
    for (i = 0; i < 18; i++) {
      var a = Math.PI * 2 * (i / 18);
      jrHusk(g, t, t.x + Math.cos(a) * t.size * 1.8, t.y + Math.sin(a) * t.size * 1.8, jrMix(t.fill, 0.25));
    }
    for (i = 0; i < 6; i++) {
      var u = jrTurret(g, t, Math.PI * 2 * (i / 6), 20 * TPS);
      u.jrEscort = true; u.jrPhase = Math.PI * 2 * (i / 6);
    }
    jrFx(g, 'genesis', { x: t.x, y: t.y, r: t.size * 4, tone: t.def.jrTone });
    t.notify('GENESIS', 60);
    return 26;
  },

  // TEMPEST: twelve bolts over three seconds, each at somebody in reach when
  // it lands, and each one forking on to the two nearest after that.
  tempest: function (g, t) {
    if (!jrNearestFoe(g, t, t.size * 18)) return 0;
    for (var i = 0; i < 12; i++)
      jaLater(g, t, i * 6, function () { jaStrike(g, t, t.size * 18, t.maxHealth * 0.009 + 260, 2); });
    t.notify('TEMPEST', 50);
    return 15;
  },

  // FISSURE: RUPTURE, in eight directions at once.
  fissure: function (g, t) {
    var hit = 0, reach = t.size * 9, spin = g.tick * 0.013;
    for (var k = 0; k < 8; k++) {
      var a = Math.PI * 2 * (k / 8) + spin;
      for (var i = 1; i <= 5; i++) {
        var x = t.x + Math.cos(a) * reach * (i / 5), y = t.y + Math.sin(a) * reach * (i / 5);
        hit += jrBlast(g, t, x, y, t.size * 0.9, t.maxHealth * 0.016 + 140, { push: 22, burn: 3 });
      }
      jrFx(g, 'fissure', { x: t.x, y: t.y, tx: t.x + Math.cos(a) * reach, ty: t.y + Math.sin(a) * reach, tone: t.def.jrTone });
    }
    t.notify('FISSURE', 50);
    return hit ? 13 : 8;
  },

  // GODRAY: BEAM's elder. Two and a half seconds of a line of light that takes
  // a share of the maximum health off anything standing in it. jrTickTank runs it.
  godray: function (g, t) {
    t.jaRay = g.tick + 2.5 * TPS;
    jrFx(g, 'godray', { x: t.x, y: t.y, r: t.size * 3, tone: t.def.jrTone });
    t.notify('GODRAY', 50);
    return 14;
  },

  // THE BIG BANG: the last button in the game. A black hole under its own
  // feet, the clock stopped, a supernova, the sky falling and a storm on top.
  bigbang: function (g, t, h) {
    JR_ABIL.blackhole(g, t, h, { x: t.x, y: t.y });
    JR_ABIL.timestop(g, t, h);
    JR_ABIL.supernova(g, t, h);
    JR_ABIL.skyfall(g, t, h);
    JR_ABIL.tempest(g, t, h);
    jrFx(g, 'bigbang', { x: t.x, y: t.y, r: t.size * 26, tone: t.def.jrTone, tone2: t.def.jrTone2 });
    g.notify('THE BIG BANG', 120);
    return 45;
  }
};

// Something a verb wants to happen later — the second wave of a supernova, the
// drop at the end of a rapture, the next bolt of a tempest. Runs on the hull's
// own tick and is swept with everything else when it dies or changes hull.
function jaLater(g, t, ticks, fn) {
  if (!t.jaLater) t.jaLater = [];
  t.jaLater.push({ at: g.tick + Math.max(0, Math.round(ticks)), fn: fn });
}
var JA_SCRATCH = [];

// One bolt of lightning: a random foe in reach, struck from the sky, and then
// it walks on to the nearest one it has not hit yet `forks` more times.
function jaStrike(g, t, reach, dmg, forks) {
  if (t.dead) return 0;
  var list = labTanks(g, JA_SCRATCH), pool = [], i;
  for (i = 0; i < list.length; i++) {
    var e = list[i];
    if (e !== t && jrFoe(t, e) && Math.hypot(e.x - t.x, e.y - t.y) < reach) pool.push(e);
  }
  if (!pool.length) return 0;
  var from = pool[(Math.random() * pool.length) | 0], seen = [from];
  from.applyDamage(dmg, t); jrHold(from, 0.3 * TPS); from.hurtFlash = 5;
  jrFx(g, 'bolt', { x: from.x, y: from.y, sky: 1, r: from.size * 2, tone: t.def.jrTone });
  for (var f = 0; f < forks; f++) {
    var next = null, bd = Math.max(t.size * 5, 1400);
    for (i = 0; i < pool.length; i++) {
      if (seen.indexOf(pool[i]) >= 0 || pool[i].dead) continue;
      var d = Math.hypot(pool[i].x - from.x, pool[i].y - from.y);
      if (d < bd) { bd = d; next = pool[i]; }
    }
    if (!next) break;
    seen.push(next);
    next.applyDamage(dmg * 0.6, t); jrHold(next, 0.2 * TPS);
    jrFx(g, 'bolt', { x: from.x, y: from.y, tx: next.x, ty: next.y, r: next.size * 1.5, tone: t.def.jrTone });
    from = next;
  }
  return 1;
}

// Every press goes through here, the hull's own and the ones it makes itself,
// so the mode-wide haste and the echo trait apply to all of them the same way.
// Returns the cooldown in seconds, already hastened, or 0 for "nothing to do".
function jrCast(g, t, h, name) {
  var fn = JR_ABIL[name];
  if (!fn) return 0;
  var cd = fn(g, t, h);
  if (!cd) return 0;
  // ECHO: every verb lands a second time a little over a second later. Once —
  // an echo does not echo.
  if (h.tr && h.tr.indexOf('echo') >= 0 && !t.jaEchoing) {
    jaLater(g, t, 1.2 * TPS, function () {
      if (t.dead || jrOf(t) !== h) return;
      t.jaEchoing = true;
      try { fn(g, t, h); } finally { t.jaEchoing = false; }
    });
  }
  return cd * g.rule('jrHaste', 1);
}

// Fire the hull's ability if it has one and the cooldown is up.
function jrAbility(g, t) {
  var h = jrOf(t);
  if (!h || !h.ab) return false;
  if (g.tick < (t.jrCool || 0)) return false;
  var cd = jrCast(g, t, h, h.ab);
  if (!cd) return false;
  t.jrCool = g.tick + cd * TPS;
  return true;
}

// The other buttons. A hull past the fusions carries two, three or four verbs
// on top of the one on right-click, and they fire THEMSELVES: each has its own
// cooldown and each asks the same question a bot asks about the primary — is
// anybody in the right place, and am I hurt enough for this to be worth it.
// That is what makes an omega feel like a boss fight rather than a big tank,
// and it costs no new key, no new wire field and no new input path.
//
// At most one a tick in the Royale, so a crown does not empty its whole list
// into an empty field the moment it spawns. A mode that sets jrStack lets every
// loaded verb go off on the same tick instead — Armageddon does, and stacking
// them is the whole idea.
function jrAutoAbilities(g, t, h) {
  if (!h.abs || !h.abs.length) return;
  if (!t.jrCools) t.jrCools = {};
  var stack = g.rule('jrStack', 0);
  for (var i = 0; i < h.abs.length; i++) {
    var name = h.abs[i];
    if (!JR_ABIL[name] || g.tick < (t.jrCools[name] || 0)) continue;
    if (!jrWants(g, t, name)) continue;
    var cd = jrCast(g, t, h, name);
    if (!cd) continue;
    t.jrCools[name] = g.tick + cd * TPS;
    if (!stack) return;
  }
}

// --- the passive verbs ---------------------------------------------------
// Run once a tick for every juggernaut on the board. Anything that writes to
// reloadTime / damagePerTick / movementSpeed goes through jrSet so it unwinds
// on its own; damageReduction is rewritten by Tank.tick anyway.
var JR_PASS = {

  // LODESTONE — the field. Four flavours of the same idea.
  magnet: function (g, t) {
    var r = t.size * 6;
    jrEach(g, t, r, JR_T_SHOT, function (e, d) {
      if (jrOwn(e, t)) return;
      var a = Math.atan2(t.y - e.y, t.x - e.x);
      e.addVelocity(a, 3.2 * (1 - d / r) + 0.6);
    });
  },
  eat: function (g, t) {
    JR_PASS.magnet(g, t);
    var r = t.size * 1.5, fed = 0;
    jrEach(g, t, r, JR_T_SHOT, function (e) {
      if (jrOwn(e, t) || e.type === 'trap') return;
      fed += Math.max(2, e.damagePerTick * 0.9);
      e.kill(t);
    });
    if (fed) { t.health = Math.min(t.maxHealth, t.health + fed); t.jrFed = g.tick; }
  },
  wall: function (g, t) {
    var r = t.size * 4.4;
    jrEach(g, t, r, JR_T_SHOT, function (e, d) {
      if (jrOwn(e, t)) { e.vx *= 1.03; e.vy *= 1.03; return; }
      var a = Math.atan2(e.y - t.y, e.x - t.x);
      e.addVelocity(a, 5.5 * (1 - d / r));
    });
  },
  well: function (g, t) {
    var horizon = t.size * 1.25, reach = t.size * 11;
    jrEach(g, t, reach, JR_T_SHOT, function (e, d) {
      if (jrOwn(e, t)) return;
      if (d < horizon) { e.kill(t); return; }
      e.addVelocity(Math.atan2(t.y - e.y, t.x - e.x), 4.6 * (horizon / d) * (horizon / d) * 6);
    });
    jrEnemies(g, t, reach, function (e, d) {
      e.addVelocity(Math.atan2(t.y - e.y, t.x - e.x), Math.min(3.2, 2.4 * (t.size * 3 / d) * (t.size * 3 / d)));
    });
  },
  grow: function (g, t) {
    JR_PASS.eat(g, t);
    if (t.jrFed === g.tick) t.jrPlates = Math.min(40, (t.jrPlates || 0) + 1);
    jrGrant(t, (t.jrPlates || 0) * 55, 1 + (t.jrPlates || 0) * 0.012);
  },

  // CINDER — heat.
  burn: function (g, t) {
    jrEnemies(g, t, t.size * 1.45, function (e) { jrBurn(e, 4 * TPS, t.maxHealth * 0.0012 + 2, t); });
  },
  pyre: function (g, t) {
    var miss = 1 - t.health / t.maxHealth;
    var r = t.size * (2.2 + miss * 3.4);
    jrEnemies(g, t, r, function (e) {
      e.applyDamage((2 + t.maxHealth * 0.0004) * (0.5 + miss * 2), t);
      jrBurn(e, 2 * TPS, 2, t);
    });
    t.jrGlowR = r;
  },
  trail: function (g, t) {
    if (g.tick % 14) return;
    if (Math.hypot(t.vx, t.vy) < 1.2) return;
    jrField(g, t, 'burn', t.x, t.y, t.size * 1.5, 5 * TPS, '#8A3B1E');
  },
  heat: function (g, t) {
    var lost = Math.max(0, (t.jrHp0 === undefined ? t.health : t.jrHp0) - t.health);
    t.jrHp0 = t.health;
    if (lost > 0) t.jrHeat = Math.min(t.maxHealth, (t.jrHeat || 0) + lost);
    else t.jrHeat = Math.max(0, (t.jrHeat || 0) - t.maxHealth * 0.0004);
    JR_PASS.burn(g, t);
  },
  ashbrood: function (g, t) {
    JR_PASS.burn(g, t);
    if (g.tick % 5) return;
    var mine = [];
    for (var i = 0; i < g.entities.length; i++) {
      var e = g.entities[i];
      if (!e.dead && (e.type === 'drone' || e.type === 'swarm') && jrOwn(e, t)) mine.push(e);
    }
    if (!mine.length) return;
    var list = labTanks(g, JR_SCRATCH);
    for (i = 0; i < list.length; i++) {
      var o = list[i];
      if (!jrFoe(t, o)) continue;
      for (var j = 0; j < mine.length; j++) {
        var d = Math.hypot(mine[j].x - o.x, mine[j].y - o.y);
        if (d < o.size + mine[j].size + 40) { jrBurn(o, 4 * TPS, t.maxHealth * 0.0013 + 3, t); break; }
      }
    }
  },

  // RIME — cold.
  chill: function (g, t) {
    var r = t.size * (3 + t.def.jrTier * 0.5);
    jrEnemies(g, t, r, function (e) { jrChill(e, 12, 0.55); });
    t.jrGlowR = r;
  },

  // LEECH — blood.
  drain: function (g, t) {
    var r = t.size * 3.4, took = 0;
    jrEnemies(g, t, r, function (e) {
      var bite = 1.5 + t.maxHealth * 0.0003;
      e.applyDamage(bite, t); took += bite;
    });
    if (took) t.health = Math.min(t.maxHealth, t.health + took * 1.1);
    t.jrGlowR = r;
  },
  bleed: function (g, t) {
    JR_PASS.drain(g, t);
    jrEnemies(g, t, t.size * 7, function (e) { jrBleed(e, t); });
    jrSet(t, 'seesInvisible', true);
  },
  husks: function (g, t) {
    var mine = 0;
    for (var i = 0; i < g.entities.length; i++) {
      var e = g.entities[i];
      if (!e.dead && e.type === 'drone' && jrOwn(e, t) && !e.barrel) mine++;
    }
    var want = t.def.jrTier >= 4 ? 10 : 8;
    if (mine < want && g.tick % 40 === t.id % 40) {
      var a = Math.random() * Math.PI * 2;
      jrHusk(g, t, t.x + Math.cos(a) * t.size * 2.2, t.y + Math.sin(a) * t.size * 2.2, '#8C2438');
    }
    // The wall is also a meal: badly hurt, it eats one for an instant heal.
    if (t.health < t.maxHealth * 0.35 && mine > 2 && g.tick % 25 === 0) {
      for (i = 0; i < g.entities.length; i++) {
        e = g.entities[i];
        if (!e.dead && e.type === 'drone' && jrOwn(e, t) && !e.barrel) {
          e.kill(null); t.health = Math.min(t.maxHealth, t.health + t.maxHealth * 0.07); break;
        }
      }
    }
  },
  stacks: function (g, t) {
    if (g.tick % 25 === 0) {
      var n = 0, list = labTanks(g, JR_SCRATCH);
      for (var i = 0; i < list.length; i++) n += list[i].kills || 0;
      t.jrStack = Math.min(60, n);
    }
    jrGrant(t, (t.jrStack || 0) * 90, 1 + (t.jrStack || 0) * 0.004);
  },
  bloom: function (g, t) {
    if (g.tick % (5 * TPS)) return;
    if (!jrNearestFoe(g, t, 1800)) return;
    var a = Math.random() * Math.PI * 2, r = t.size * (2 + Math.random() * 2);
    g.add(new Shape(g, 'pentagon', t.x + Math.cos(a) * r, t.y + Math.sin(a) * r));
  },
  plague: function (g, t) {
    JR_PASS.bleed(g, t);
    jrEnemies(g, t, t.size * 5, function (e) { jrChill(e, 12, 0.7); });
  },

  // EFFIGY — deception.
  mirror: function (g, t) {
    // A big hit throws a copy off on its own, which is the whole trick.
    var lost = Math.max(0, (t.jrHp0 === undefined ? t.health : t.jrHp0) - t.health);
    t.jrHp0 = t.health;
    if (lost > t.maxHealth * 0.09 && (!t.jrDecoys || t.jrDecoys.length < 2) && g.tick > (t.jrMirrorAt || 0)) {
      jrDecoy(g, t, Math.random() * Math.PI * 2);
      t.jrMirrorAt = g.tick + 4 * TPS;
    }
  },
  beacon: function (g, t) {
    var d = t.score - (t.jrScore0 === undefined ? t.score : t.jrScore0);
    if (d > 0) t.addScore(d * 0.5);
    t.jrScore0 = t.score;
    t.jrLit = true;
  },
  seer: function (g, t) { jrSet(t, 'seesInvisible', true); t.jrLit = true; },
  split: function (g, t) { t.jrSplits = t.jrSplinter ? 0 : 2; },
  segments: function (g, t) {
    if (!t.jrOrbs) t.jrOrbs = [];
    t.jrOrbs = t.jrOrbs.filter(function (o) {
      if (o.dead) { t.applyDamage(t.maxHealth * 0.12, o.jrKiller || null); return false; }
      return true;
    });
    if (!t.jrOrbs.length && g.tick > (t.jrOrbAt || 0)) {
      for (var i = 0; i < 4; i++) t.jrOrbs.push(jrOrbiter(g, t, i, 4, {
        sides: 4, size: t.size * 0.42, hp: t.maxHealth * 0.16, dmg: t.damagePerTick * 0.4,
        fill: jrMix(t.fill, 0.2), stroke: t.stroke
      }));
    }
  },

  // METRONOME — time.
  beat: function (g, t) {
    var heavy = Math.floor(g.tick / (4 * TPS)) % 2 === 0;
    t.jrBeat = heavy;
    if (heavy) { jrSet(t, 'movementSpeed', t.movementSpeed * 0.7); t.damageReduction = 0.6; }
    else { jrSet(t, 'movementSpeed', t.movementSpeed * 1.45); t.damageReduction = 1.4; }
    // A hull with the field keeps other people's clocks slow whatever beat it is on.
    if (t.def.jrTier >= 3) {
      var r = t.size * 5.5;
      jrEnemies(g, t, r, function (e) { jrChill(e, 10, 0.72); });
      jrEach(g, t, r, JR_T_SHOT, function (e) { if (!jrOwn(e, t)) { e.vx *= 0.93; e.vy *= 0.93; } });
      t.jrGlowR = r;
    }
  },
  invert: function (g, t) {
    if (g.tick % 25 === 0) {
      var lead = labLeader(g);
      var gap = lead && lead !== t ? Math.max(0, lead.score - t.score) : 0;
      t.jrInv = Math.min(1, gap / 12000);
    }
    jrGrant(t, (t.jrInv || 0) * 4200, 1 + (t.jrInv || 0) * 0.18);
  },
  decay: function (g, t) {
    var age = Math.floor((g.tick - (t.spawnTick || 0)) / (10 * TPS));
    jrGrant(t, -Math.min(t.def.maxHealth * 0.55, age * t.def.maxHealth * 0.03), 1 - Math.min(0.22, age * 0.012));
  },

  // ARSENAL — siege.
  dug: function (g, t) {
    if (Math.hypot(t.vx, t.vy) > 1.1 || t.input.fire) { t.jrDug = 0; return; }
    t.jrDug = (t.jrDug || 0) + 1;
    if (t.jrDug < TPS) return;
    jrSet(t, 'reloadTime', t.reloadTime * 0.7);
    t.damageReduction = 0.68;
  },
  still: function (g, t) {
    var moving = Math.hypot(t.vx, t.vy) > 0.9 || !!t.input.fire;
    t.jrStill = !moving;
    if (!moving) t.damageReduction = 0;
  },
  rooted: function (g, t) {
    jrSet(t, 'reloadTime', t.reloadTime * 0.72);
    t.damageReduction = 0.8;
  },

  // BULWARK — the body.
  thorns: function (g, t) {
    jrEnemies(g, t, t.size * 1.6, function (e) { e.applyDamage(t.damagePerTick * 0.9, t); });
  },
  momentum: function (g, t) {
    var sp = Math.hypot(t.vx, t.vy);
    jrSet(t, 'damagePerTick', t.damagePerTick * (1 + Math.min(1.4, sp / 9)));
    t.jrSpeed = sp;
  },
  swing: function (g, t) {
    if (!t.jrOrbs) t.jrOrbs = [];
    t.jrOrbs = t.jrOrbs.filter(function (o) { return !o.dead; });
    if (!t.jrOrbs.length) t.jrOrbs.push(jrOrbiter(g, t, 0, 1, {
      sides: 10, size: t.size * 0.52, hp: t.maxHealth * 0.5, dmg: t.damagePerTick * 1.35,
      fill: jrMix(t.fill, -0.12), stroke: t.stroke, hideBar: true
    }));
  },
  hollow: function (g, t) {
    // Bullets stop dead at the shell. Only another body kills a Hollow.
    jrEach(g, t, t.size * 1.6, JR_T_SHOT, function (e) { if (!jrOwn(e, t)) e.kill(null); });
  },

  // WARDEN — terrain.
  graft: function (g, t) { jrGrant(t, (t.jrPlates || 0) * 210, 1 + (t.jrPlates || 0) * 0.016); },

  // The Nomad: everything it has is a function of how far out it has walked.
  // Zero in the nest, everything in the corners.
  far: function (g, t) {
    var f = Math.min(1, Math.hypot(t.x, t.y) / (g.arena.right * 0.9));
    t.jrFar = f;
    jrGrant(t, f * 3600, 1 + f * 0.16);
    jrSet(t, 'damagePerTick', t.damagePerTick * (1 + f * 0.9));
    jrSet(t, 'reloadTime', t.reloadTime * (1 - f * 0.3));
  },

  // REAPER — swarm.
  choir: function (g, t) {
    if (g.tick % 5) return;
    var mine = [];
    for (var i = 0; i < g.entities.length; i++) {
      var e = g.entities[i];
      if (!e.dead && (e.type === 'drone' || e.type === 'swarm') && jrOwn(e, t)) mine.push(e);
    }
    var k = 1 + Math.min(1.2, mine.length * 0.045);
    for (i = 0; i < mine.length; i++) {
      if (mine[i].jrBaseDmg === undefined) mine[i].jrBaseDmg = mine[i].damagePerTick;
      mine[i].damagePerTick = mine[i].jrBaseDmg * k;
    }
    t.jrChoir = mine.length;
  },

  // PARASITE — theft.
  latch: function (g, t) {
    var host = null;
    jrEnemies(g, t, t.size + 90, function (e) { if (!host) host = e; });
    if (!host) { t.jrLatched = null; return; }
    t.jrLatched = host;
    if (g.tick % 5) return;
    var take = Math.min(host.score * 0.004, 260);
    if (take > 0) { host.score = Math.max(0, host.score - take); t.addScore(take); }
    host.applyDamage(2 + t.maxHealth * 0.0004, t);
  },
  chain: function (g, t) {
    var o = t.jrTether;
    if (!o || o.dead || g.tick > (t.jrTetherUntil || 0)) { t.jrTether = null; return; }
    var d = Math.hypot(o.x - t.x, o.y - t.y);
    if (d > 1200) {
      var a = Math.atan2(t.y - o.y, t.x - o.x);
      o.addVelocity(a, Math.min(9, (d - 1200) * 0.05));
      t.addVelocity(a + Math.PI, Math.min(4, (d - 1200) * 0.02));
    }
  },
  usurp: function (g, t) { t.jrUsurps = true; },

  // --- the late passives -------------------------------------------------

  // SOVEREIGN — everything it has scales with how many of you turned up. The
  // answer to being focused is to be better at being focused.
  sovereign: function (g, t) {
    var n = 0;
    jrEnemies(g, t, t.size * 12, function () { n++; });
    t.jrCourt = n;
    if (!n) return;
    var k = Math.min(1.4, n * 0.14);
    jrSet(t, 'damagePerTick', t.damagePerTick * (1 + k * 0.6));
    jrSet(t, 'reloadTime', t.reloadTime / (1 + k * 0.5));
    t.damageReduction = Math.min(t.damageReduction, 1 - k * 0.3);
    t.jrGlowR = Math.max(t.jrGlowR || 0, t.size * 12);
  },

  // RUIN — the ground it walks over does not recover. Slower and far longer
  // lived than the Ashwalker's trail: this is a scar, not a wake.
  ruin: function (g, t) {
    if (g.tick % 20) return;
    jrField(g, t, 'burn', t.x, t.y, t.size * 1.8, 12 * TPS, '#6B2E1E');
  },

  // UNDYING — the lower it goes the faster it comes back.
  undying: function (g, t) {
    var miss = 1 - t.health / t.maxHealth;
    if (miss <= 0) return;
    t.health = Math.min(t.maxHealth, t.health + t.maxHealth * 0.0006 * (0.5 + miss * 4));
  },

  // TYRANT — while it is leading the round, being in the round costs everybody
  // else health. There is no way to opt out of it except to take the lead.
  tyrant: function (g, t) {
    t.jrLit = true;
    if (g.tick % 25) return;
    if (labLeader(g) !== t) return;
    var list = labTanks(g, JR_SCRATCH3);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e === t || !jrFoe(t, e)) continue;
      e.applyDamage(e.maxHealth * 0.006, t);
    }
  },

  // --- Armageddon's passives ---------------------------------------------

  // CORONA — standing near it is a share of your own health a second, whoever
  // you are. A pyre ring is a flat number; this is not.
  corona: function (g, t) {
    var r = t.size * (2.6 + Math.max(0, (t.def.jrTier || 9) - 8) * 0.25);
    jrEnemies(g, t, r, function (e) {
      e.applyDamage(e.maxHealth * 0.0011 + t.maxHealth * 0.00006, t);
      jrBurn(e, 2 * TPS, t.maxHealth * 0.0003 + 10, t);
    });
    t.jrGlowR = Math.max(t.jrGlowR || 0, r);
  },

  // MAELSTROM — six blades on a fast orbit. jrTickTank flies them; this only
  // keeps the count topped up, one every twenty ticks.
  maelstrom: function (g, t) {
    if (!t.jaBlades) t.jaBlades = [];
    t.jaBlades = t.jaBlades.filter(function (o) { return !o.dead; });
    if (t.jaBlades.length < 6 && g.tick % 20 === t.id % 20)
      t.jaBlades.push(jrOrbiter(g, t, t.jaBlades.length, 6, {
        sides: 3, size: t.size * 0.28, hp: t.maxHealth * 0.06, dmg: t.damagePerTick * 0.8,
        fill: jrMix(t.fill, 0.35), stroke: t.stroke, hideBar: true
      }));
  },

  // STORMCALL — a bolt out of a clear sky every second and a half, at
  // somebody in reach, forking once.
  stormcall: function (g, t) {
    if (g.tick % 38 !== t.id % 38) return;
    jaStrike(g, t, t.size * 12, t.maxHealth * 0.005 + 160, 1);
  },

  // QUICKEN — its clocks run at double time. Every cooldown on the hull, the
  // right-click and the ones it presses itself, loses an extra tick a tick.
  quicken: function (g, t) {
    if (t.jrCool > g.tick) t.jrCool--;
    if (t.jrCools) for (var k in t.jrCools) if (t.jrCools[k] > g.tick) t.jrCools[k]--;
  },

  // FUSION — the Thermocline alternates the two halves of itself.
  thermal: function (g, t) {
    var hot = Math.floor(g.tick / (4 * TPS)) % 2 === 0;
    t.jrHot = hot;
    var r = t.size * 3.6;
    jrEnemies(g, t, r, function (e) {
      if (hot) { e.applyDamage(3 + t.maxHealth * 0.0004, t); jrBurn(e, 2 * TPS, 3, t); }
      else jrChill(e, 14, 0.5);
    });
    t.jrGlowR = r;
  }
};

// --- traits --------------------------------------------------------------
// A branch hull is a verb and a passive, and to level 52 that is the right
// amount of hull. Past the fusions it stops being enough — and the answer is
// not "a third verb", it is the things that are not verbs at all. A shield that
// grows back. A death it does not take. A ceiling on what any single hit is
// allowed to remove. An escort that never expires. A tithe on everything it
// touches. Armour that does not apply to it.
//
// Half of these run once a tick and live here. The other half only mean
// anything at the moment something lands, so they are resolved in jrTakeDamage
// and carry a 0 in this table — the table is still the roll call, so a row that
// names a trait nobody wrote is a test failure rather than a silent no-op.
var JR_TRAIT = {
  // --- resolved at the moment something lands, in jrTakeDamage ------------
  bulwark: 0,       // no single hit may take more than 3% of the bar
  revive: 0,        // the first death of a life is simply refused
  vampire: 0,       // a fifth of everything it deals comes back as health
  tithe: 0,         // everything it damages pays it, in score
  pierce: 0,        // its damage goes through armour rather than into it
  executioner: 0,   // anything nearly dead that touches it is finished
  immortal: 0,      // refuses three more deaths a life, and goes supernova each time
  thunder: 0,       // what it hits is sometimes struck by lightning as well
  echo: 0,          // every verb lands twice — resolved in jrCast, not here

  // --- resolved once a tick ----------------------------------------------

  // A slab of armour in front of the health bar that regrows once it is left
  // alone for five seconds. jrTakeDamage spends it; this only refills it.
  aegis: function (g, t) {
    var cap = t.maxHealth * (0.22 + 0.06 * Math.max(0, (t.def.jrTier || 0) - 4));
    if (t.jrShield === undefined) t.jrShield = cap;
    t.jrShieldMax = cap;
    if (g.tick - (t.jrShieldAt || 0) > 5 * TPS) t.jrShield = Math.min(cap, t.jrShield + cap / (5 * TPS));
    else t.jrShield = Math.min(cap, t.jrShield);
  },

  // An escort that does not expire. Turrets are furniture, so this is a head
  // count rather than a cooldown; jrTickTank flies them around the hull.
  retinue: function (g, t) {
    if (!t.jrTurrets) t.jrTurrets = [];
    var live = 0;
    for (var i = 0; i < t.jrTurrets.length; i++)
      if (t.jrTurrets[i].jrEscort && !t.jrTurrets[i].dead) live++;
    var want = 2 * Math.max(1, (t.def.jrTier || 5) - 4);
    if (live < want && g.tick % 15 === t.id % 15) {
      var u = jrTurret(g, t, Math.random() * Math.PI * 2, 1e9);
      u.jrEscort = true;
      u.jrPhase = Math.random() * Math.PI * 2;
    }
  },

  // Shots inside the shell are turned around and handed back with the hull's
  // name on them. Traps are left alone — a wall is not a thing you reflect —
  // and so is anything with a hangar behind it: a barrel counts its live
  // children against its own drone cap, so keeping a stolen drone forever would
  // starve the hangar rather than beat it. HIJACK is the verb for those, and it
  // hands them back.
  reflect: function (g, t) {
    jrEach(g, t, t.size * 1.9, JR_T_SHOT, function (e) {
      if (jrOwn(e, t) || !JR_T_REFLECT[e.type]) return;
      e.vx = -e.vx; e.vy = -e.vy;
      e.owner = t; e.team = t.team; e.fill = t.fill; e.stroke = t.stroke;
    });
  },

  // Everything inside the reach fights worse. Marked here and applied on the
  // victim's own tick, so it unwinds through jrRestore like everything else.
  dread: function (g, t) {
    var r = t.size * 7;
    jrEnemies(g, t, r, function (e) { e.jrDread = g.tick; });
    t.jrGlowR = Math.max(t.jrGlowR || 0, r);
  },

  // The ground behind it is never safe.
  wake: function (g, t) {
    if (g.tick % 10) return;
    jrField(g, t, 'burn', t.x, t.y, t.size * 1.4, 4 * TPS, '#7A2E12');
  },

  // It has not finished getting bigger. Never given to a hull whose passive
  // already spends jrGrant — there is one bonus slot and they would fight.
  growth: function (g, t) {
    if (g.tick % 15 === 0) t.jrGrown = Math.min(50, (t.jrGrown || 0) + 1);
    jrGrant(t, (t.jrGrown || 0) * t.def.maxHealth * 0.011, 1 + (t.jrGrown || 0) * 0.0035);
  },

  // It heals like a boss rather than like a tank.
  regalia: function (g, t) {
    if (t.health < t.maxHealth) t.health = Math.min(t.maxHealth, t.health + t.maxHealth * 0.0022);
  },

  // The more of you there are the faster it fires.
  overclock: function (g, t) {
    var n = 0;
    jrEnemies(g, t, t.size * 10, function () { n++; });
    if (!n) return;
    jrSet(t, 'reloadTime', t.reloadTime / (1 + Math.min(1.5, n * 0.17)));
  },

  // It steps sideways out of the world on a timer, hit or not.
  blinkstep: function (g, t) {
    if (g.tick % (7 * TPS) === t.id % 7) t.jrPhaseUntil = g.tick + 1.2 * TPS;
  },

  // Everybody can see it, everywhere, and it earns extra for the privilege.
  warcry: function (g, t) {
    t.jrLit = true;
    var d = t.score - (t.jrScore0 === undefined ? t.score : t.jrScore0);
    if (d > 0) t.addScore(d * 0.3);
    t.jrScore0 = t.score;
  },

  // Nothing hides from it.
  omniscient: function (g, t) { jrSet(t, 'seesInvisible', true); t.jrSeer = true; },

  // Statuses do not stick to it. Burn, chill, the freeze, the bleed and the
  // dread are all gone by the end of its own tick.
  nullify: function (g, t) {
    t.jrBurn = 0; t.jrBurnDps = 0; t.jrChill = 0; t.jrChillF = 1; t.jrHold = 0; t.jrBleed = null;
    t.jrDread = 0;
  }
};

// Installed on every juggernaut at spawn, chained the same way onKill is.
// Everything a hull does at the moment something lands on it is here rather
// than in the engine: the shield eats first, the cap trims what is left, the
// revive refuses the last one outright, and whoever landed it may be paid,
// billed or finished for the trouble.
var JR_NO_TR = [];
function jrTakeDamage(t, dmg, src, base) {
  if (t.dead || t.damageReduction === 0 || !(dmg > 0)) return base.call(t, dmg, src);
  var g = t.game, h = jrOf(t), tr = (h && h.tr) || JR_NO_TR;
  var root = src; while (root && root.owner) root = root.owner;
  var attacker = (root && root.type === 'tank' && !root.dead && root !== t) ? root : null;
  var sh = attacker ? jrOf(attacker) : null;
  var str = (sh && sh.tr) || JR_NO_TR;

  if (str.indexOf('pierce') >= 0) dmg *= 1.6;
  if (str.indexOf('executioner') >= 0 && t.health < t.maxHealth * 0.1) dmg = t.health;

  if (tr.indexOf('aegis') >= 0) {
    t.jrShieldAt = g.tick;                        // the recharge clock restarts
    if (t.jrShield > 0) {
      var eat = Math.min(t.jrShield, dmg);
      t.jrShield -= eat; dmg -= eat;
      t.hurtFlash = 3;
      if (dmg <= 1e-9) return;
    }
  }
  if (tr.indexOf('bulwark') >= 0) dmg = Math.min(dmg, t.maxHealth * 0.03);
  // IMMORTAL: three refusals a life on top of whatever revive gives, and every
  // one of them is a supernova centred on the thing you thought you had killed.
  if (tr.indexOf('immortal') >= 0 && dmg >= t.health && (t.jaRefused || 0) < 3) {
    t.jaRefused = (t.jaRefused || 0) + 1;
    t.health = t.maxHealth * 0.6;
    t.jrBurn = 0; t.jrBurnDps = 0; t.jrChill = 0; t.jrChillF = 1; t.jrHold = 0; t.jrBleed = null;
    JR_ABIL.supernova(g, t);
    g.notify((t.name || 'A juggernaut') + ' refused to die (' + t.jaRefused + '/3)', 80);
    return;
  }
  if (tr.indexOf('revive') >= 0 && dmg >= t.health && !t.jrRevived) {
    t.jrRevived = 1;
    t.health = t.maxHealth * 0.45;
    t.jrBurn = 0; t.jrBurnDps = 0; t.jrChill = 0; t.jrChillF = 1; t.jrHold = 0; t.jrBleed = null;
    JR_ABIL.nova(g, t);
    g.notify((t.name || 'A juggernaut') + ' would not stay down', 70);
    return;
  }
  if (attacker) {
    if (str.indexOf('vampire') >= 0)
      attacker.health = Math.min(attacker.maxHealth, attacker.health + dmg * 0.2);
    if (str.indexOf('tithe') >= 0 && t.score > 0) {
      var take = Math.min(t.score * 0.0015, 500);
      t.score = Math.max(0, t.score - take);
      attacker.addScore(take);
    }
    // THUNDER: one hit in twelve calls a bolt down on whatever it landed on,
    // no more than one every ten ticks. The bolt is its own hit, so the clock
    // is set before it lands or it would call itself.
    if (str.indexOf('thunder') >= 0 && g.tick >= (attacker.jaThunderAt || 0) && Math.random() < 0.083) {
      attacker.jaThunderAt = g.tick + 10;
      jrFx(g, 'bolt', { x: t.x, y: t.y, sky: 1, r: t.size * 2, tone: attacker.def.jrTone });
      jrHold(t, 0.25 * TPS);
      base.call(t, t.maxHealth * 0.012 + attacker.maxHealth * 0.002, attacker);
      if (t.dead) return;
    }
  }
  base.call(t, dmg, src);
}

// --- per-tank tick -------------------------------------------------------
// Everything a juggernaut is, once a tick: statuses, its own furniture, the
// hull's passive, and then the ability if something asked for it.
function jrTickTank(g, t) {
  var h = jrOf(t);
  if (!h) return;
  jrRestore(t);
  if (t.jrDefId !== t.tankId) { jrClear(g, t); t.jrDefId = t.tankId; t.jrCool = 0; }
  jrStatus(g, t);

  // Whatever its verbs left to land later. Swapped out before running, so a
  // callback that schedules another one lands it on the next pass, not this one.
  if (t.jaLater && t.jaLater.length) {
    var due = t.jaLater;
    t.jaLater = [];
    for (var di = 0; di < due.length; di++) {
      if (g.tick >= due[di].at) due[di].fn();
      else t.jaLater.push(due[di]);
    }
  }

  // three seconds of history, sampled five times a second
  if (g.tick % 5 === 0) {
    if (!t.jrHist) t.jrHist = [];
    t.jrHist.push({ x: t.x, y: t.y, hp: t.health });
    if (t.jrHist.length > 15) t.jrHist.shift();
  }

  // AVATAR: eight seconds of being twice the tank.
  if (t.jrAvatar) {
    if (g.tick > t.jrAvatar) { t.jrAvatar = 0; t.jrAvaOn = 0; jrGrant(t, 0, 1); }
    else {
      jrSet(t, 'damagePerTick', t.damagePerTick * 2);
      jrSet(t, 'reloadTime', t.reloadTime * 0.55);
      jrSet(t, 'movementSpeed', t.movementSpeed * 1.3);
      t.damageReduction = Math.min(t.damageReduction, 0.35);
      t.jrAvaOn = 1;
    }
  }
  // BLINKSTEP: 1.2 seconds every seven where nothing lands at all.
  if (t.jrPhaseUntil) {
    if (g.tick > t.jrPhaseUntil) t.jrPhaseUntil = 0;
    else t.damageReduction = 0;
  }
  // DREAD, applied on the victim rather than the caster so it unwinds with
  // everything else jrRestore owns.
  if (g.tick - (t.jrDread || -99) <= 1) {
    jrSet(t, 'reloadTime', t.reloadTime * 1.5);
    jrSet(t, 'damagePerTick', t.damagePerTick * 0.7);
  }

  // rooted, hardened, shedding, beaming — the timed states
  if (t.jrRoot) {
    if (g.tick > t.jrRoot) t.jrRoot = 0;
    else { t.vx = 0; t.vy = 0; jrSet(t, 'reloadTime', t.reloadTime * 0.5); t.damageReduction = 0.5; }
  }
  if (t.jrHarden) {
    if (g.tick > t.jrHarden) t.jrHarden = 0;
    else {
      t.vx = 0; t.vy = 0; t.damageReduction = 0;
      for (var i = 0; i < t.barrels.length; i++) t.barrels[i].disabled = true;
      t.jrSilenced = true;
    }
  } else if (t.jrSilenced && !t.jrFrozen) {
    for (i = 0; i < t.barrels.length; i++) t.barrels[i].disabled = false;
    t.jrSilenced = false;
  }
  if (t.jrShed) {
    if (g.tick > t.jrShed) t.jrShed = 0;
    else { jrSet(t, 'movementSpeed', t.movementSpeed * 1.7); jrSet(t, 'damagePerTick', t.damagePerTick * 1.5); }
  }
  if (t.jrBubble) {
    if (g.tick > t.jrBubble) t.jrBubble = 0;
    else {
      var br = t.size * 5;
      jrEach(g, t, br * 1.25, JR_T_SHOT, function (e, d) {
        if (jrOwn(e, t)) { if (d > br * 0.94) e.kill(null); }
        else e.kill(null);
      });
    }
  }
  if (t.jrBeam) {
    if (g.tick > t.jrBeam) t.jrBeam = 0;
    else {
      var ba = Math.atan2(t.mouse.y - t.y, t.mouse.x - t.x), reach = 3000;
      var list = labTanks(g, JR_SCRATCH);
      for (i = 0; i < list.length; i++) {
        var o = list[i];
        if (!jrFoe(t, o)) continue;
        var rx = o.x - t.x, ry = o.y - t.y;
        var along = rx * Math.cos(ba) + ry * Math.sin(ba);
        if (along < 0 || along > reach) continue;
        var off = Math.abs(-rx * Math.sin(ba) + ry * Math.cos(ba));
        if (off > o.size + t.size * 0.4) continue;
        o.applyDamage(t.maxHealth * 0.006 + 8, t);
        jrChill(o, 20, 0.45);
        if (g.tick % 8 === 0) jrHold(o, 8);
      }
      t.jrBeamA = ba;
    }
  }
  // GODRAY: the beam grown up — wider, longer, and billed as a share of the
  // victim's own bar rather than the caster's, so nothing is too big for it.
  if (t.jaRay) {
    if (g.tick > t.jaRay) t.jaRay = 0;
    else {
      var ga = Math.atan2(t.mouse.y - t.y, t.mouse.x - t.x), greach = 9000 + t.size * 4;
      var glist = labTanks(g, JR_SCRATCH);
      for (i = 0; i < glist.length; i++) {
        var go = glist[i];
        if (!jrFoe(t, go)) continue;
        var gx = go.x - t.x, gy = go.y - t.y;
        var galong = gx * Math.cos(ga) + gy * Math.sin(ga);
        if (galong < 0 || galong > greach) continue;
        if (Math.abs(-gx * Math.sin(ga) + gy * Math.cos(ga)) > go.size + t.size * 0.6) continue;
        go.applyDamage(go.maxHealth * 0.0055 + t.maxHealth * 0.0006, t);
        go.hurtFlash = 3;
        jrBurn(go, 2 * TPS, t.maxHealth * 0.0004 + 20, t);
      }
      t.jaRayA = ga;
    }
  }

  // decoys, orbiters, turrets, tether host — the furniture it is dragging
  if (t.jrDecoys && t.jrDecoys.length) {
    t.jrDecoys = t.jrDecoys.filter(function (d) {
      if (d.dead) return false;
      if (g.tick > (d.jrDie || 0)) { d.kill(null); return false; }
      d.jrOff += 0.014;
      var lag = 1 + 0.35 * Math.sin((g.tick + d.id) * 0.06);
      d.px = d.x; d.py = d.y;
      d.x = t.x + Math.cos(d.jrOff) * t.size * 2.3 * lag;
      d.y = t.y + Math.sin(d.jrOff) * t.size * 2.3 * lag;
      d.angle = t.angle; d.size = t.size; d.sides = t.sides;
      d.fill = t.fill; d.stroke = t.stroke; d.opacity = t.opacity;
      d.def = t.def; d.barrels = t.barrels; d.turrets = t.turrets;
      d.scaleFactor = t.scaleFactor; d.guardAngle = t.guardAngle;
      return true;
    });
  }
  if (t.jrOrbs && t.jrOrbs.length) {
    var boost = g.tick < (t.jrSwing || 0) ? 2 : 1;
    for (i = 0; i < t.jrOrbs.length; i++) {
      var o2 = t.jrOrbs[i];
      if (o2.dead) continue;
      o2.jrPhase += 0.055 * boost;
      var rr = t.size * 2.3 * boost;
      o2.px = o2.x; o2.py = o2.y;
      o2.x = t.x + Math.cos(o2.jrPhase) * rr;
      o2.y = t.y + Math.sin(o2.jrPhase) * rr;
      o2.angle = o2.jrPhase;
    }
  }
  if (t.jaBlades && t.jaBlades.length) {
    for (i = 0; i < t.jaBlades.length; i++) {
      var bl = t.jaBlades[i];
      if (bl.dead) continue;
      bl.jrPhase += 0.075;
      bl.px = bl.x; bl.py = bl.y;
      bl.x = t.x + Math.cos(bl.jrPhase) * t.size * 2.7;
      bl.y = t.y + Math.sin(bl.jrPhase) * t.size * 2.7;
      bl.angle = bl.jrPhase * 3;
    }
  }
  if (t.jrTurrets && t.jrTurrets.length) {
    t.jrTurrets = t.jrTurrets.filter(function (u) {
      if (u.dead) return false;
      if (g.tick > (u.jrDie || 0)) { u.kill(null); return false; }
      u.stats = t.stats; u.reloadTime = t.reloadTime;
      // A retinue escort is not a deployed turret; it flies with the hull.
      if (u.jrEscort) {
        u.jrPhase += 0.021;
        u.px = u.x; u.py = u.y;
        u.x = t.x + Math.cos(u.jrPhase) * t.size * 1.6;
        u.y = t.y + Math.sin(u.jrPhase) * t.size * 1.6;
        u.size = t.size * 0.3;
      }
      var f = jrNearestFoe(g, u, 2200);
      if (f) u.angle = Math.atan2(f.y - u.y, f.x - u.x);
      return true;
    });
  }
  if (t.jrHost) {
    if (t.jrHost.dead || g.tick > (t.jrHostUntil || 0)) t.jrHost = null;
    else {
      var hd = Math.hypot(t.jrHost.x - t.x, t.jrHost.y - t.y);
      if (hd > t.size + t.jrHost.size + 30) t.addVelocity(Math.atan2(t.jrHost.y - t.y, t.jrHost.x - t.x), 3.4);
      t.jrHost.applyDamage(3 + t.maxHealth * 0.0006, t);
      jrBleed(t.jrHost, t);
    }
  }

  // Passives, then traits. A branch hull names one passive and no traits; a
  // crown names three and six. Both accept a bare string as well as a list, so
  // the ninety-six rows that were written before any of this still read right.
  var i2, ps = h.ps;
  if (ps) {
    if (typeof ps === 'string') { if (JR_PASS[ps]) JR_PASS[ps](g, t, h); }
    else for (i2 = 0; i2 < ps.length; i2++) if (JR_PASS[ps[i2]]) JR_PASS[ps[i2]](g, t, h);
  }
  if (h.tr) for (i2 = 0; i2 < h.tr.length; i2++) {
    var trf = JR_TRAIT[h.tr[i2]];
    if (trf) trf(g, t, h);
  }

  // ASCEND: four seconds of very nearly nothing landing.
  if (t.jrAscend) {
    if (g.tick > t.jrAscend) t.jrAscend = 0;
    else {
      t.damageReduction = Math.min(t.damageReduction, 0.12);
      jrSet(t, 'reloadTime', t.reloadTime * 0.5);
    }
  }

  // The tier dividend. Everything past fusion is meant to be unfair, and saying
  // so once here beats writing the same three lines into the forty-four rows
  // above it: a thicker skin, a faster gun and heavier contact damage, and each
  // tier's row is meaningfully worse to be standing in front of than the last.
  // A hull whose own passive already asked for a lower damageReduction (a
  // rooted Ordnance, a swarmed Sovereign) keeps the better of the two.
  var div = JR_DIVIDEND[h.t];
  if (div) {
    t.damageReduction = Math.min(t.damageReduction, div[0]);
    jrSet(t, 'reloadTime', t.reloadTime * div[1]);
    jrSet(t, 'damagePerTick', t.damagePerTick * div[2]);
    // Past the crowns the guns get it too: Barrel.spawn reads bulletDamage off
    // the tank, so every round leaves the barrel this much heavier.
    if (div[3]) jrSet(t, 'bulletDamage', (t.bulletDamage === undefined ? 1 : t.bulletDamage) * div[3]);
  }
}

// [damage taken, reload multiplier, contact multiplier] by tier. Tiers 0-4 draw
// nothing; the rows above it are what "even more overpowered than the last one"
// costs the people fighting them, and a crown takes a third of what lands.
//
// Armageddon's five carry a fourth number, bullet damage, and every row is a
// bigger step than the one before it was: an Armageddon takes a twentieth of
// what lands, fires three and a half times as often and hits twelve times as
// hard with its body and five and a half with its guns.
var JR_DIVIDEND = [null, null, null, null, null,
  [0.86, 0.85, 1.30],   // 5  apex
  [0.70, 0.70, 1.65],   // 6  omega
  [0.50, 0.56, 2.20],   // 7  titan
  [0.33, 0.44, 3.00],   // 8  crown
  [0.24, 0.40, 4.0, 1.5],    // 9  ascendant
  [0.17, 0.37, 5.2, 2.1],    // 10 archon
  [0.12, 0.34, 6.8, 2.9],    // 11 primordial
  [0.08, 0.31, 8.8, 4.0],    // 12 eschaton
  [0.05, 0.28, 12.0, 5.5]];  // 13 armageddon

// --- death ---------------------------------------------------------------
function jrSplinter(g, t) {
  for (var i = 0; i < 2; i++) {
    var s = g.spawnTank({ name: (t.name || 'Hydra') + ' · head', bot: true, score: t.score * 0.3 });
    if (!s) continue;
    forceTankClass(s, t.tankId);
    s.x = t.x + (Math.random() - 0.5) * 300; s.y = t.y + (Math.random() - 0.5) * 300;
    s.px = s.x; s.py = s.y;
    s.jrSplinter = true; s.jrDefId = s.tankId;
    s.scaleBoost = 0.6; s.recompute();
    s.health = s.maxHealth;
  }
  g.notify((t.name || 'A Hydra') + ' came apart', 45);
}

function jrUsurpBarrel(killer, victim) {
  var vd = victim.def;
  if (!vd || !vd.barrels || !vd.barrels.length || killer.barrels.length >= 16) return;
  var bd = vd.barrels[(Math.random() * vd.barrels.length) | 0];
  var copy = {};
  for (var k in bd) copy[k] = bd[k];
  copy.angle = (bd.angle || 0) + (Math.random() - 0.5) * 0.7;
  var b = new Barrel(killer, copy, killer.barrels.length);
  b.cycle = b.period();
  killer.barrels.push(b);
  killer.notify('TAKEN · ' + vd.name, 45);
}

// Does this hull carry that passive? `ps` is a string on the ninety-six rows
// written before the late tiers and a list on the forty-four written after.
function jrPs(h, name) {
  if (!h || !h.ps) return false;
  return typeof h.ps === 'string' ? h.ps === name : h.ps.indexOf(name) >= 0;
}

function jrDeath(g, t, src) {
  jrClear(g, t);
  // Only a mode with a trapCap keeps this queue, so the Royale's traps outlive
  // their owner the way diep's always have.
  jrKillList(t.capTraps);
  var h = jrOf(t);
  if (jrPs(h, 'split') && !t.jrSplinter) jrSplinter(g, t);
  var root = src; while (root && root.owner) root = root.owner;
  if (root && root.type === 'tank' && !root.dead && root !== t) {
    var kh = jrOf(root);
    if (jrPs(kh, 'usurp')) jrUsurpBarrel(root, t);
    // DOMINION: for twelve seconds after the press, whatever it kills gets up
    // again on its side. Four of them, so a corpse is a real reinforcement.
    if (root.jrDominion && g.tick < root.jrDominion)
      for (var i = 0; i < 4; i++) jrHusk(g, root, t.x + (Math.random() - 0.5) * t.size,
        t.y + (Math.random() - 0.5) * t.size, '#8C2438');
  }
}

// --- world upkeep --------------------------------------------------------
// Burning ground, ice, and drones on loan. All three are things the mode put
// on the board that the engine has no opinion about.
var JR_SCRATCH2 = [];

function jrTickFields(g) {
  if (!g.jrFields || !g.jrFields.length) return;
  var live = [], i, j;
  for (i = 0; i < g.jrFields.length; i++) {
    var f = g.jrFields[i];
    if (f.dead) continue;
    if (g.tick > f.jrDie) { f.kill(null); continue; }
    live.push(f);
    if (f.jrKind === 'well') { jaTickWell(g, f); continue; }
    if (g.tick % 5) continue;
    var list = labTanks(g, JR_SCRATCH2);
    for (j = 0; j < list.length; j++) {
      var t = list[j];
      if (t === f.jrBy) continue;
      if (Math.hypot(t.x - f.x, t.y - f.y) > f.size + t.size) continue;
      if (f.jrKind === 'burn') jrBurn(t, 2 * TPS, 4 + (f.jrBy ? f.jrBy.maxHealth * 0.0009 : 0), f.jrBy);
      else if (f.jrKind === 'ice') { t.vx *= 1.09; t.vy *= 1.09; }   // friction, cancelled
    }
  }
  g.jrFields = live;
}

// A BLACK HOLE, every tick: tanks and shots fall toward the middle, shots that
// reach it are gone, and a tank inside the inner third loses a share of its
// own bar. Whoever opened it, and their team, are left alone — and it closes
// when they die, because a well with nobody behind it has no side to be on and
// would bill everyone in reach, its own caster's team included, for nothing.
function jaTickWell(g, f) {
  var by = f.jrBy;
  if (!by || by.dead) { f.kill(null); return; }
  var reach = f.size * 2.6, core = f.size * 0.35, list = labTanks(g, JR_SCRATCH2);
  for (var j = 0; j < list.length; j++) {
    var t = list[j];
    if (t === by || !jrFoe(by, t)) continue;
    var d = Math.hypot(t.x - f.x, t.y - f.y);
    if (d > reach + t.size) continue;
    t.addVelocity(Math.atan2(f.y - t.y, f.x - t.x), Math.min(6, 1.2 + 4 * (1 - d / (reach + t.size))));
    if (d < core + t.size) { t.applyDamage(t.maxHealth * 0.0045, by); t.hurtFlash = 2; }
  }
  jrEach(g, f, reach, JR_T_SHOT, function (e, d) {
    if (jrOwn(e, by)) return;
    if (d < core) { e.kill(null); return; }
    e.addVelocity(Math.atan2(f.y - e.y, f.x - e.x), 5 * (1 - d / reach) + 1);
  });
}

// TIME STOP's shots: held where they were, velocity and clock both, until the
// stop runs out. A bullet's life ticks down on its own tick, so it is handed
// the tick back here.
function jaTickFrozen(g) {
  if (!g.jaFrozen || !g.jaFrozen.length) return;
  var live = [];
  for (var i = 0; i < g.jaFrozen.length; i++) {
    var e = g.jaFrozen[i];
    if (e.dead || g.tick > (e.jaFrozen || 0)) continue;
    e.vx = 0; e.vy = 0;
    if (typeof e.life === 'number' && isFinite(e.life)) e.life++;
    live.push(e);
  }
  g.jaFrozen = live;
  if (g.jaTimestop && g.tick > g.jaTimestop.until) g.jaTimestop = null;
}

function jrTickLoans(g) {
  for (var i = 0; i < g.entities.length; i++) {
    var e = g.entities[i];
    if (e.dead || !e.jrRevert) continue;
    if (g.tick < e.jrRevert) continue;
    e.jrRevert = 0;
    var o = e.jrOwner0;
    if (!o || o.dead) { e.kill(null); continue; }
    e.owner = o; e.team = o.team; e.fill = o.fill; e.stroke = o.stroke; e.dTarget = null;
  }
}

// --- the bot brain -------------------------------------------------------
// The generic AI already knows how to kite a gun, drive a body and shove a
// drone. What it does not know is that this mode has ninety-six hulls with
// eleven different jobs, so this reads the job off the row and says the one
// thing the generic AI cannot work out for itself: where to stand, and when
// the button is worth pressing.
//
// 'ram'   close to zero and stay there — the body IS the gun
// 'close' traps and short guns: inside 500, because a trap wall you laid a
//         screen away is decoration
// 'mid'   the default. Leave the generic spacing alone
// 'far'   snipers and mortars: back off anything inside 900
// 'root'  siege hulls: stop moving once anything is in reach and shoot
function jrJob(h) {
  if (h.jb) return h.jb;
  jrIndex();                                       // stamps h.tid
  var d = TANK_DEFS[h.tid], job = 'mid';
  // A hull is a sniper if it asked for MORE camera than its tier hands out, or
  // if it carries a barrel longer than three body radii. Both of those used to
  // be absolute numbers, and both stopped meaning anything once the tiers
  // started zooming out on their own and jrFitGuns started scaling barrels with
  // the hull: every apex read as a sniper and walked away from fights it was
  // built to be standing in the middle of.
  var traps = 0, drones = 0, guns = 0;
  var snipe = h.fov !== undefined && h.fov < JR_TIER[h.t].fov;
  for (var i = 0; i < d.barrels.length; i++) {
    var b = d.barrels[i].bullet.type;
    if (b === 'trap') traps++;
    else if (b === 'drone' || b === 'swarm' || b === 'minion') drones++;
    else guns++;
    if (d.barrels[i].size >= h.sz * 3) snipe = true;
  }
  if (!d.barrels.length || h.me) job = 'ram';
  else if (jrPs(h, 'latch') || jrPs(h, 'thorns') || jrPs(h, 'momentum')) job = 'ram';
  else if (jrPs(h, 'dug') || jrPs(h, 'rooted') || jrPs(h, 'still') || d.speed <= 0.45) job = 'root';
  else if (snipe) job = 'far';
  else if (traps > guns && traps >= drones) job = 'close';
  else if (drones > guns) job = 'mid';
  return (h.jb = job);
}

// Where the bot should be standing, applied after the generic AI has had its
// say. botDrive is the mode's override hook, so this wins.
function jrBotDrive(g, t) {
  var h = jrOf(t);
  if (!h) return;
  var job = jrJob(h);
  if (t.regening || t.fleeing) return;             // a hurt bot's retreat is not ours to argue with
  var tgt = t.aiGoal && t.aiGoal.type === 'tank' ? t.aiGoal : jrNearestFoe(g, t, 2600);
  if (t.jrRoot || (t.jrHarden && g.tick < t.jrHarden)) { botHalt(t); return; }
  if (!tgt) return;
  var d = Math.hypot(tgt.x - t.x, tgt.y - t.y);
  if (job === 'ram') { botDriveTo(t, tgt.x, tgt.y, 20); if (t.barrels.length) t.input.fire = 1; }
  else if (job === 'close') { if (d > 520) botDriveTo(t, tgt.x, tgt.y, 60); }
  else if (job === 'far') {
    if (d < 900) {
      var a = Math.atan2(t.y - tgt.y, t.x - tgt.x);
      botDriveTo(t, t.x + Math.cos(a) * 700, t.y + Math.sin(a) * 700, 40);
    }
  } else if (job === 'root') { if (d < 2200) botHalt(t); }
}

// Is the button worth pressing right now? The handlers already refuse to fire
// into an empty field, so this only has to answer the questions they cannot:
// how hurt am I, and is anybody in the right place.
function jrBotWants(g, t, h) {
  if (!h.ab || g.tick < (t.jrCool || 0)) return false;
  return jrWants(g, t, h.ab);
}

// The question itself, with no cooldown in it, so the autonomous buttons on a
// tier-5-and-up hull can ask it about their own verb. One table, one answer,
// and a player's hull picks its own moments exactly as a bot's does.
function jrWants(g, t, ab) {
  var hurt = t.health < t.maxHealth * 0.55;
  // A hull past the crowns is several thousand units across and its verbs reach
  // the arena, so it looks as far as they do. Everything at or below a crown
  // keeps the Royale's 3,400.
  var near = jrNearestFoe(g, t, (t.def.jrTier || 0) > 8 ? Math.max(3400, t.size * 20) : 3400);
  var d = near ? Math.hypot(near.x - t.x, near.y - t.y) : Infinity;

  switch (ab) {
    case 'nova':
      return d < t.size * 10;
    case 'ascend':
      return t.health < t.maxHealth * 0.5;
    case 'slam': case 'quake': case 'thermal': case 'reap': case 'graft':
      return d < t.size * 4;
    case 'ignite': case 'freeze': case 'repel': case 'shatter':
      return d < t.size * 6;
    case 'pull': case 'dilate': case 'slick':
      return d < t.size * 9;
    case 'infest': case 'tether':
      return d < t.size * 12 && !t.jrHost && !t.jrTether;
    case 'hijack':
      return d < t.size * 12;
    case 'barricade':
      return d < 1500 || (g.tick % (18 * TPS) < 2);
    case 'swarm':
      return d < 2600;
    case 'overload':
      return (t.jrHeat || 0) > t.maxHealth * 0.45 && d < t.size * 9;
    case 'turrets':
      return d < 1900;
    case 'mortar':
      return d > 500 && d < 3000;
    case 'beam':
      return d < 2600;
    case 'deploy':
      return t.jrRoot ? (d > 2600) : (d < 1700);
    case 'harden': case 'bubble':
      return hurt && d < t.size * 8;
    case 'rewind': case 'shed':
      return t.health < t.maxHealth * 0.35;
    case 'blink':
      return hurt ? d < 900 : d > 1200 && d < 2600;
    case 'decoy':
      return d < 1800;
    case 'raise':
      return d < 2200 || t.health < t.maxHealth * 0.6;
    case 'bloom':
      return d > 2200;
    case 'mark':
      return d < 2600;
    case 'warp':
      return hurt || !near;

    // --- the late verbs ---------------------------------------------------
    case 'apocalypse': case 'judgement':
      return d < t.size * 14;
    case 'collapse': case 'stasis': case 'epoch': case 'unmake': case 'warpstorm':
      return d < t.size * 11;
    case 'eclipse': case 'terraform': case 'citadel': case 'arc':
      return d < t.size * 8;
    case 'rupture': case 'conscript': case 'dominion':
      return d < t.size * 9;
    case 'meteor':
      return d > 400 && d < 3400;
    case 'avatar':
      return d < t.size * 9 || hurt;
    case 'enthrone':
      return t.health < t.maxHealth * 0.45;

    // --- Armageddon's verbs -----------------------------------------------
    case 'overdrive': case 'bigbang': case 'supernova':
      return d < t.size * 14;
    case 'skyfall': case 'tempest':
      return d < t.size * 18;
    case 'timestop': case 'rapture': case 'blackhole': case 'godray':
      return d < t.size * 12;
    case 'fissure':
      return d < t.size * 8;
    case 'genesis':
      return d < t.size * 14 || hurt;
    default:
      return d < 2000;
  }
}

// Which branch this bot is climbing. Handed out round-robin so all eleven get
// driven rather than twenty bots converging on whatever scores best.
var JR_PATHS = ['warden', 'reaper', 'bulwark', 'lode', 'cinder', 'rime', 'siphon', 'effigy', 'horo', 'arsenal', 'parasite'];

// Taken here rather than left to the generic upgrade roll: logic.tick runs
// between the tank tick that grants the cards and the bot tick that would
// spend them, so the mode gets first refusal without touching the engine.
function jrBotUpgrade(g, t) {
  if (!t.pendingUpgrades.length) return;
  var want = t.jrPath, pool = [], any = [];
  for (var i = 0; i < t.pendingUpgrades.length; i++) {
    var d = TANK_DEFS[t.pendingUpgrades[i]];
    if (!d) continue;
    any.push(d.id);
    // Past tier 3 the branches marry and there is no "own branch" left to
    // climb, so anything at fusion or above is fair game for any path.
    if (d.jrBranch === want || d.jrTier >= 4) pool.push(d.id);
  }
  var pickFrom = pool.length ? pool : any;
  if (!pickFrom.length) return;
  t.upgradeTo(pickFrom[(Math.random() * pickFrom.length) | 0]);
}

// =========================================================================

// The Royale's whole tick, shared with Armageddon: every juggernaut's own pass,
// its autonomous verbs and its button, the ground and the husks, the nest kept
// stocked, and the one line of HUD with the mode's name on the front of it.
function jrRoyaleTick(g, title) {
  var list = labTanks(g), i, t;
  for (i = 0; i < list.length; i++) {
    t = list[i];
    if (!jrOf(t)) continue;
    jrTickTank(g, t);
    var h = jrOf(t);
    // The autonomous buttons run for players and bots alike — they are part
    // of the hull, not part of the AI, and a crown a player is flying is the
    // same boss fight a crown a bot is flying is.
    if (h) jrAutoAbilities(g, t, h);
    if (t.bot) {
      jrBotUpgrade(g, t);
      if (h && jrBotWants(g, t, h)) jrAbility(g, t);
    } else if (t.input.altFire) jrAbility(g, t);
  }
  jrTickFields(g);
  jrTickHusks(g);
  jrTickLoans(g);
  // age the effect ring buffer out
  if (g.jrFx && g.jrFx.length) {
    while (g.jrFx.length && g.tick - g.jrFx[0].at > 2 * TPS) g.jrFx.shift();
  }
  // Keep the nest stocked as well as the field: the global top-up spreads
  // over the whole map and the middle is where the big polygons are.
  if (g.tick % 4 === 0) {
    var nestR = g.arena.right * 0.3, n = 0;
    for (i = 0; i < g.entities.length; i++) {
      var e = g.entities[i];
      if (e.type === 'shape' && !e.dead && Math.hypot(e.x, e.y) < nestR) n++;
    }
    if (n < 260) for (var k = 0; k < 3; k++) {
      var a = Math.random() * Math.PI * 2, r = Math.random() * nestR;
      var deep = r < nestR * 0.4;
      g.add(new Shape(g, deep ? (Math.random() < 0.16 ? 'alpha' : 'hexagon') : 'pentagon',
        Math.cos(a) * r, Math.sin(a) * r));
    }
  }
  g.fx = { royale: true, jrFx: g.jrFx };
  if (g.tick % 25) return;
  var best = null, players = labPlayers(g);
  for (i = 0; i < players.length; i++) if (!best || players[i].score > best.score) best = players[i];
  var bd = best && best.def;
  // From the fusions up the label is the dynasty (or, past the archons, the
  // marriage of two), which is what the bracket is for.
  setHud(g, best
    ? title + '  ·  ' + (best.name || '?') + '  ·  ' + (bd ? bd.name : '')
      + (bd && bd.jrTier >= 4 && bd.jrLabel ? '  [' + bd.jrLabel.toUpperCase() + ']' : '')
      + (bd && bd.jrTier ? '  T' + bd.jrTier : '') + '  lvl ' + best.level
    : title);
}

labMode('juggerroyale', {
  name: 'Juggernaut Royale', family: 'Asymmetry', tag: '140 hulls',
  // A thick field: the hulls are expensive and the only way up the tree that
  // does not involve winning fights is farming, so there has to be enough to farm.
  //
  // maxLevel 200 is the whole shape of this mode — nine tiers instead of five,
  // and the top one gated on the cap. The other knobs are the price of it:
  //   shapeXp/killBounty  a lift for the half of the climb that is farming
  //                       rather than fighting. Measured, not derived: the kill
  //                       economy already gets a leader to 100 in about two
  //                       minutes, and the whole 1..200 climb costs 6.7x the
  //                       1..100 one (data.js stops the 6% compounding at 100,
  //                       or level 199 alone would cost four hundred times
  //                       level 100 and the ladder would be a wall).
  //   lvlScale/lvlSlow    diep grows a tank 1% and slows it 1.5% per level. Run
  //                       that to 200 and a crown is nine times its own size at
  //                       a twentieth of its own speed. These land a level-200
  //                       juggernaut a shade past where a level-45 tank sits
  //                       today, which is where the hull rows expect it.
  //   statHealthPct/      Max Health and Body Damage are the only two stats diep
  //   statBodyPct         pays out as flat numbers, which is worthless on a
  //                       96,000 hp World Engine. These pay them as a share of
  //                       the hull instead, so a point is worth the same on the
  //                       first hull as on the last.
  rules: { forceClass: JR_BASE, shapes: 2600, bots: 20, killBounty: 9000, killShare: 0.45,
    shapeXp: 3.2, regen: 0.6, maxLevel: 200, lvlScale: 1.0032, lvlSlow: 1.0042,
    statHealthPct: 0.055, statBodyPct: 0.045 },
  size: 18000,
  treeRoot: JR_BASE,
  treeUnique: true,
  blurb: 'Everybody is a juggernaut, and juggernauts grow — for two hundred levels. A hundred and forty hulls on eleven branches, sixteen fusions where two branches marry, and then eight sealed dynasties that never touch again, each ending in a crown nobody else in the round can reach.',
  fx: true,
  how: [
    'The level cap here is 200, not 45, and the tree is nine tiers deep: Brute at 1, a branch at 12, a specialist at 24, an ending at 36, a fusion at 52, an apex at 70, an omega at 100, a titan at 140 and a crown at 200.',
    'Every card is a group. Nothing in the tree hands you a single hull and calls it an upgrade — the worst case below the cap is a choice of two, and most of it offers three. The one exception is the crown at 200, which is not a choice because by then there is exactly one thing left to become.',
    'THE PICK IS THE POINT. Up to level 52 the tree is a lattice — eleven branches that meet at the fusions. From 52 up it is not: the fusion you take seals you into one of eight DYNASTIES, and the apex, the omega, the titan and the crown above it belong to that dynasty and nothing else. No two dynasties share a hull, and no other path in the game reaches yours. The cards you are offered at 70 are proof of what you took at 52.',
    'The eight are PYRE (fire and scorched ground), GLACIER (cold, ice and stasis), TITAN (body, mass, no barrels at all), ORDNANCE (siege, mortars, twelve turrets), BASTION (walls, husks and a throne it climbs back onto), VOID (gravity, invisibility and deletion), CHRONO (the clock, run backwards) and VERMIN (blood, swarm and everything you kill getting back up).',
    'You spawn as a Brute: twelve sides, six ring guns, two cannons, 900 health. Deliberately unremarkable, because the branch you pick at level 12 is the first real decision.',
    'Eleven branches open at once. WARDEN lays terrain and fires no bullets. REAPER is drones. BULWARK has no barrels at all. LODESTONE bolts a gravity well to the hull. CINDER burns. RIME freezes. LEECH drinks. EFFIGY lies to you. METRONOME plays with the clock. ARSENAL roots itself and stops being a tank. PARASITE takes what is yours.',
    'To level 52 a hull is one ability on right-click and one passive that never stops. Above it that stops being enough: an apex carries a second verb that fires ITSELF whenever its own cooldown is up and there is a point, an omega carries two, a titan three and a crown four. You still drive one button. The hull drives the rest.',
    'And past the fusions hulls carry TRAITS — the things that are not verbs at all. A shield that eats damage and grows back once you leave it alone. A death it simply refuses, once a life. A ceiling on what any single hit is allowed to remove. Turret escorts that never expire. Bullets turned around inside the shell and handed back. A tithe on the score of everything it touches. Armour that does not apply to it. Anything nearly dead that touches it is finished. A crown carries six at once.',
    'Fifty-one ability verbs across the roster. SLAM, PULL, FREEZE, REAP, BLINK, REWIND, DEPLOY, MORTAR, HIJACK, TETHER, OVERLOAD, BEAM and NOVA below the fusions — then METEOR, ECLIPSE, COLLAPSE, RUPTURE, CONSCRIPT, STASIS, AVATAR, JUDGEMENT, ARC, CITADEL, UNMAKE, WARPSTORM, TERRAFORM, ENTHRONE, DOMINION, EPOCH and APOCALYPSE above them.',
    'Statuses are real and they stack across branches: burn ticks health away, chill halves your speed, a freeze stops you dead and shuts your guns, and a bleed does not stop until you are full again.',
    'The field is thick — 2,600 polygons in an 18,000-unit arena — because climbing eight tiers to level 200 costs, and farming is the half of it that does not involve winning fights.',
    'Tier 3 is twenty-three endings — every branch has at least two, so the level-36 card is a fork rather than an announcement. The Hollow, which bullets simply do not work on; Tessellate, whose health lives in four orbiting segments; Kingmaker, which grows every time anybody anywhere dies; the Labyrinth, which lays a corridor while it runs; the Aeon, which is exactly as strong as whoever is winning.',
    'Tier 4 is where the branches touch for the last time: sixteen fusions, each the marriage of two verbs, and every branch is half of two or three of them.',
    'Tier 7 at level 140 is sixteen titans — forty to fifty-five thousand health, a hundred-odd contact damage, three self-firing verbs and four traits apiece, and a dividend that halves what lands on them again.',
    'Tier 8 at level 200 is eight crowns, one per dynasty, and the end of every road. Solar Tyrant fires APOCALYPSE, which sets the visible arena alight. World Engine is ninety-six thousand health and two hundred contact damage with no barrel anywhere on it. Last Word takes a share of everybody\'s maximum health with no travel time and no line of sight. Endless Night is three hundred units of invisible horizon. A crown takes a third of what hits it and does three times the contact damage its numbers say.',
    'YOUR SKILL POINTS KEEP GOING TOO. Every stat in this mode runs to 28 points rather than 7, and the pill in the corner does not get any longer for it: fill all seven pips and they collapse into one lit block, leaving six to fill, which collapse into two, leaving five. Seven ranks — 7+6+5+4+3+2+1 — and then the row is solid and the bar says MAX because there is physically nowhere left to put a point. Level 200 hands out exactly 84 points, which is three stats taken all the way and nothing else.',
    'The melee hulls have their bullet stats capped at zero, so the stat panel says what they are as plainly as the silhouette does, and the points refund like a Smasher\'s.',
    'Bots are handed a branch each and climb it until the branches marry, then follow whichever dynasty their fusion put them in. They read their own hull too: bodies charge, trap hulls close, snipers back off, siege hulls plant themselves, and every one of them knows what its own buttons are for.',
    'Every hull is a real class in the tank table with a real upgrade array, so the cards and the server-side gate are the game\'s own. Press Y and the wheel shows the juggernauts — eight rings, eleven arms, each hull drawn once, not the Basic tank tree you cannot reach a single node of from in here.'
  ],
  logic: {
    init: function (g) {
      buildJuggHulls();
      g.jrFx = []; g.jrFields = []; g.jrHusks = []; g.jrSeat = 0;
    },
    onSpawn: function (g, t) {
      buildJuggHulls();
      if (!jrOf(t)) forceTankClass(t, JR_BASE);
      t.jrCool = 0; t.jrDefId = t.tankId; t.jrHp0 = t.health;
      t.jrHist = null; t.jrPlates = 0; t.jrHeat = 0; t.jrStack = 0;
      t.jrDecoys = null; t.jrTurrets = null; t.jrOrbs = null; t.jrPads = null;
      t.jrHpOn = 0; t.jrSzOn = 1;
      t.jrCools = null; t.jrShield = undefined; t.jrShieldAt = 0; t.jrRevived = 0;
      t.jrAvatar = 0; t.jrPhaseUntil = 0; t.jrDominion = 0; t.jrGrown = 0;
      t.jaRefused = 0; t.jaBlades = null; t.jaLater = null; t.jaRay = 0;
      t.jrPath = JR_PATHS[(g.jrSeat = (g.jrSeat || 0) + 1) % JR_PATHS.length];
      // Chain, don't replace: the prototype's onKill is the kill feed, the kill
      // count, the death screen's killer and the bot respawn queue.
      var baseKill = t.onKill;
      t.onKill = function (src) { jrDeath(g, t, src); baseKill.call(t, src); };
      // Same trick for the damage path. Every trait that only means something at
      // the moment something lands — the shield, the cap, the refused death, the
      // tithe — lives in jrTakeDamage, and this is how it gets there without the
      // engine growing an opinion about a mode.
      var baseDmg = t.applyDamage;
      t.applyDamage = function (d, s) { return jrTakeDamage(this, d, s, baseDmg); };
      t.checkUpgrades();
    },
    tick: function (g) { jrRoyaleTick(g, 'JUGGERNAUT ROYALE'); },
    botDrive: function (g, t) { if (jrOf(t)) jrBotDrive(g, t); },
    // Husks are ordinary drones rather than mode furniture, so clearModeEntities
    // does not see them and dropping the list alone would orphan a live army.
    reset: function (g) {
      jrKillList(g.jrHusks);
      g.jrFx = []; g.jrFields = []; g.jrHusks = []; g.jrSeat = 0;
      labReset(g, 'juggerroyale');
    }
  }
});

// =========================================================================
// Last Juggernaut — the Royale's tree, the Juggernaut's arena
// =========================================================================
//
// The two asymmetry modes crossed. You are the only juggernaut there is and the
// only one there ever will be: the arena runs Juggernaut Royale's hundred and
// forty hulls for you and nobody else, and everything else on the board is an
// ordinary level-45 tank on one team with one job. The crown does not change
// hands when you die, because there is nobody to hand it to — you come back on
// the hull you died on, at the level you died at, and the mob starts over.
//
// Nothing new is invented here. The player side is the Royale's own per-tank
// pass (jrTickTank, the autonomous verbs, the button) and the arena side is the
// Juggernaut's own bot handling (the mark, the ring respawn, the collar range)
// with the target swapped from "whoever is wearing the crown" to "whoever is a
// person". What the two modes did not already have between them is the memo
// below, which is the whole point of the mode.

labMode('lastjugg', {
  name: 'Last Juggernaut', family: 'Asymmetry', tag: 'you keep it',
  teams: ['blue', 'red'],
  // Juggernaut's arena (thirty hunters, no farming, a tight map) on the
  // Royale's economy (a 200-level climb and a percentage stat payout). The one
  // number that is neither mode's is killBounty: in the Royale a kill is worth
  // more every tier because the thing you killed grew too, and here it never
  // does — the hunters are level 45 for the whole round — so the bounty has to
  // carry the top half of the climb by itself.
  rules: { spawnLevel: 45, bots: 30, shapes: 1400, botFarm: 0,
    maxLevel: 200, killBounty: 16000, killShare: 0.45, shapeXp: 3.2, regen: 0.6,
    lvlScale: 1.0032, lvlSlow: 1.0042, statHealthPct: 0.055, statBodyPct: 0.045 },
  size: 16000,
  treeRoot: JR_BASE,
  treeUnique: true,
  fx: true,
  blurb: 'You are the juggernaut and nobody else ever will be. Climb the Royale’s hundred and forty hulls to level 200 while thirty tanks on one team try to stop you — and when they manage it, you get back up on the same hull.',
  how: [
    'You spawn as a Brute on the Juggernaut Royale tree — a hundred and forty hulls, nine tiers, level cap 200 — and you are the only tank in the arena on it.',
    'Everybody else is an ordinary level-45 tank, and every one of them is on the same team, against you. Farming is switched off arena-wide, you are marked globally so they know where you are regardless of sight range, and their target is pinned to you rather than merely weighted toward you.',
    'You start at level 45, which is three cards deep in the tree — branch, specialist, ending — plus 33 stat points. Spend them before you move: spawn protection lasts until you shoot or drive.',
    'THE CROWN DOES NOT MOVE. Kill it and nothing happens to it; there is no next juggernaut. When you die you come back on the same hull, at the same level, with the same build, and the thirty of them start the job over.',
    'Everything the Royale gives a juggernaut is here: the ability on right-click, the passive that never stops, the autonomous verbs an apex and above fire themselves, the traits, and stats that run to 28 points rather than 7.',
    'Your economy is kills and polygons — a hunter is worth 16,000 on top of its score share, because unlike the Royale the things you kill never grow.',
    'The bots hold just outside your collar and shoot in, orbiting rather than standing still, unless they are a body-damage build — in which case going all the way in is the plan. They respawn on a ring 2,600 to 4,000 units out, so the pile-on is continuous instead of a queue of people walking in one at a time.',
    'The collar is read off your hull, so it grows with you: a crown at level 200 holds thirty tanks at arm’s length by being five hundred units across.',
    'Press Y and the wheel shows the juggernauts — the same eight rings and eleven arms the Royale draws, and the only tree you can reach a node of in here.'
  ],
  logic: {
    init: function (g) {
      buildJuggHulls();
      g.jrFx = []; g.jrFields = []; g.jrHusks = []; g.jrSeat = 0;
      g.ljTarget = null;
      // What survives your death. Keyed by name, because a mode hook is handed a
      // tank and a tank is a fresh object every respawn.
      // ponytail: two humans sharing a name share a memo; key on tank.client if
      // this mode ever runs a real server lobby.
      g.ljKeep = {};
    },
    onSpawn: function (g, t) {
      buildJuggHulls();
      if (t.isPlayer) {
        var keep = g.ljKeep[t.name || ''];
        if (keep) {
          // Level before class: recompute() reads this.level, and forceTankClass
          // is what runs it.
          t.score = keep.score;
          t.level = levelFromScore(t.score, g.levelCap());
          forceTankClass(t, keep.id, keep.stats);
        }
        // The Royale's own per-tank wiring: the jr* fields, and the onKill and
        // applyDamage chains every trait above the fusions lives in.
        MODE_LOGIC.juggerroyale.onSpawn(g, t);
        t.team = 'red';
        g.paintTeam(t);
        return;
      }
      t.team = 'blue';
      g.paintTeam(t);
      // Hunters come back within reach rather than anywhere in the arena. A
      // hunter that spends eighteen seconds walking in is not hunting, it is
      // commuting, and the juggernaut never drops below 99% health.
      var j = g.ljTarget;
      if (!j || j.dead) return;
      var a = Math.random() * Math.PI * 2, r = 2600 + Math.random() * 1400;
      var lim = g.arena.right - 300;
      t.x = Math.max(-lim, Math.min(lim, j.x + Math.cos(a) * r));
      t.y = Math.max(-lim, Math.min(lim, j.y + Math.sin(a) * r));
      t.px = t.x; t.py = t.y;
    },
    // The memo, taken at the moment of death rather than read off the corpse
    // later: orphan() and the respawn queue run in the same call.
    onTankDeath: function (g, victim) {
      if (!victim.isPlayer || !jrOf(victim)) return;
      g.ljKeep[victim.name || ''] = {
        id: victim.tankId, score: victim.score, stats: victim.stats.slice()
      };
      g.notify('The Juggernaut has fallen. It gets back up.', 80);
    },
    tick: function (g) {
      var list = labTanks(g), i, t, j = null, hunters = 0;
      for (i = 0; i < list.length; i++) {
        t = list[i];
        var h = jrOf(t);
        if (h) {
          jrTickTank(g, t);
          jrAutoAbilities(g, t, h);
          if (!t.bot && t.input.altFire) jrAbility(g, t);
          t.team = 'red';
          if (!j && t.isPlayer) j = t;
          continue;
        }
        hunters++;
        if (t.team !== 'blue') { t.team = 'blue'; g.paintTeam(t); }
      }
      jrTickFields(g);
      jrTickHusks(g);
      jrTickLoans(g);
      if (g.jrFx && g.jrFx.length) {
        while (g.jrFx.length && g.tick - g.jrFx[0].at > 2 * TPS) g.jrFx.shift();
      }
      g.fx = { royale: true, jrFx: g.jrFx };
      // botDrive runs before logic.tick, so the bots read last tick's answer. A
      // tank reference one frame old is fine; scanning the entity list thirty
      // times a tick to avoid it is not.
      g.ljTarget = j;
      g.bountyTarget = j;
      g.bountyGlobal = !!j;
      g.teamCounts = j ? { blue: hunters, red: Math.max(0, Math.round(j.health)) } : {};
      if (g.tick % 25) return;
      var d = j && j.def;
      setHud(g, j
        ? 'LAST JUGGERNAUT  ·  ' + (d ? d.name : '?') + (d && d.jrTier ? '  T' + d.jrTier : '')
          + '  lvl ' + j.level + '  ·  ' + Math.max(0, Math.round(j.health)) + ' hp  ·  '
          + hunters + ' hunting'
        : 'LAST JUGGERNAUT  ·  nobody is wearing it');
    },
    reset: function (g) {
      jrKillList(g.jrHusks);
      g.jrFx = []; g.jrFields = []; g.jrHusks = [];
      g.bountyGlobal = false;
      labReset(g, 'lastjugg');
    },
    // Both halves of Juggernaut's bot handling, pointed at the person rather
    // than at whoever is wearing the crown. The goal is the hint; the drive is
    // what makes them actually close, because the movement code treats a goal it
    // was not told to touch as something to keep range from.
    botGoal: function (g, t) {
      var j = g.ljTarget;
      if (!j || j.dead || t === j) return null;
      var rammer = t.stats[S_BODY] >= 5 || t.stats[S_HEALTH] >= 5;
      var want = rammer ? j.size * 1.1 : juggSpikeRange(j) * 1.9;
      var d = Math.hypot(t.x - j.x, t.y - j.y);
      if (Math.abs(d - want) < 260) return { e: j };
      var a = Math.atan2(t.y - j.y, t.x - j.x);
      return { x: j.x + Math.cos(a) * want, y: j.y + Math.sin(a) * want, vx: 0, vy: 0, touch: false, hard: true };
    },
    botDrive: function (g, t) {
      var j = g.ljTarget;
      if (!j || j.dead || t === j || jrOf(t)) return;
      t.aiTarget = j;
      t.aiEngaged = j;
      t.aiFarm = null;
      t.autoFire = true;
      var rammer = t.stats[S_BODY] >= 5 || t.stats[S_HEALTH] >= 5;
      var want = rammer ? j.size * 1.05 : juggSpikeRange(j) * 1.9;
      var d = Math.hypot(t.x - j.x, t.y - j.y) || 1;
      var a = Math.atan2(t.y - j.y, t.x - j.x);
      if (Math.abs(d - want) < 160) {
        var orbit = a + (t.id % 2 ? 0.35 : -0.35);
        botDriveTo(t, j.x + Math.cos(orbit) * want, j.y + Math.sin(orbit) * want, 40);
      } else {
        botDriveTo(t, j.x + Math.cos(a) * want, j.y + Math.sin(a) * want, 40);
      }
    }
  }
});


// =========================================================================
// Juggernaut Armageddon — the Royale, and then five more tiers
// =========================================================================
//
// Everything the Royale is, to the hull: the same Brute, the same eleven
// branches, the same sixteen fusions and eight sealed dynasties, the same
// crowns at level 200. Then it keeps going. The cap is 500, the crowns open
// onto JA_HULLS through filterUpgrades, and the five tiers up there are each a
// bigger step than any step below them — more health, more hull, another verb
// that fires itself, another passive, another trait, and a dividend that grows
// faster than the one before it did.
//
// Two rules that are not the Royale's:
//   jrStack  every loaded autonomous verb goes off on the same tick, rather
//            than one a tick, so a hull with eight of them stacks all eight
//   jrHaste  every cooldown in the mode is three-quarters as long
labMode('juggarmageddon', {
  name: 'Juggernaut Armageddon', family: 'Asymmetry', tag: '183 hulls',
  //   maxLevel 500 and the score curve: level 500 costs 3.6x what level 200
  //     does, and the climb is meant to cost about that much longer. Polygons
  //     pay less than in the Royale, because the nest refill is the Royale's
  //     too and the hulls up here clear it with one verb: at 11x a bot banked
  //     140k a second and reached level 455 inside the first minute, and at
  //     3.6x one still went from 220 to 500 in sixty seconds. Kills pay 2.7x,
  //     because the things you kill up here grew too.
  //   lvlScale/lvlSlow: softer again than the Royale's. At these numbers a
  //     level-500 tank is 4.5x its own size and a third of its own speed.
  //   statHealthPct/statBodyPct: a little richer, because a level-500 build is
  //     184 points and two of the stats are Max Health and Body Damage.
  //   size 28000, because the hull at the top is four thousand units across.
  //   shotCap 360: no round wider than that, however big the hull firing it.
  //     Uncapped, one archon's hellbores cost the collision pass 100 ms a tick.
  //   trapCap/bulletCap: how many traps and rounds one tank may have out at
  //     once. Uncapped, a Bastion-line hull held 2,700 traps and the Armageddon
  //     2,900 rounds, and the arena ran at a tenth of real time. A juggernaut's
  //     capped traps also go down with it rather than standing for a minute.
  rules: { forceClass: JR_BASE, shapes: 2600, bots: 22, killBounty: 24000, killShare: 0.45,
    shapeXp: 2.6, regen: 0.6, maxLevel: 500, lvlScale: 1.003, lvlSlow: 1.0022,
    statHealthPct: 0.07, statBodyPct: 0.06, jrStack: 1, jrHaste: 0.75, shotCap: 360, trapCap: 90, bulletCap: 450 },
  size: 28000,
  treeRoot: JR_BASE,
  treeUnique: true,
  treeGraft: JA_GRAFT,
  fx: true,
  blurb: 'Juggernaut Royale, and then it keeps going. The same hundred and forty hulls to level 200 — then five more tiers, forty-three more hulls, a cap of 500, and abilities that stack: every loaded verb on the hull goes off at once.',
  how: [
    'Everything in Juggernaut Royale is here, hull for hull: the Brute, eleven branches, sixteen fusions, eight sealed dynasties and the crowns at level 200. The crown is not the end any more.',
    'The level cap is 500, and above the crowns there are five more tiers. ASCENDANT at 240 (sixteen, two per dynasty), ARCHON at 300 (sixteen), PRIMORDIAL at 370 (eight), ESCHATON at 440 (two) and ARMAGEDDON at 500 — one hull, the end of every road in the game.',
    'THE DYNASTIES MARRY AGAIN. They were sealed apart at level 52. At 370 they meet on a ring — Pyre, Titan, Ordnance, Bastion, Vermin, Void, Chrono, Glacier and back to Pyre — and each Primordial is the union of two neighbours, so every Archon chooses which neighbour it becomes.',
    'ABILITIES STACK. In the Royale a hull fires one of its own verbs a tick. Here every loaded verb goes off on the same tick, so a hull with eight of them can land all eight at once. Every cooldown in the arena is also three-quarters as long.',
    'Every tier is more than the one under it in every column at once. A crown fires four verbs itself and carries six traits; an Ascendant fires five and carries seven; an Archon six and eight; a Primordial seven and nine; an Eschaton eight and ten; the Armageddon ten and twelve.',
    'And every tier is a bigger step than the last. Past the crowns the tier dividend grows the guns too: an Ascendant takes a quarter of what lands and hits one and a half times as hard with every bullet; the Armageddon takes a twentieth, fires three and a half times as often, rams twelve times as hard and shoots five and a half.',
    'Eleven new verbs. OVERDRIVE fires every other button on the hull at once. SUPERNOVA is three shockwaves wider than the screen. BLACK HOLE opens a well under the cursor. SKYFALL strikes the seven nearest things from above. TIME STOP holds tanks and bullets in the air for four seconds. RAPTURE lifts the arena and drops it. GENESIS makes an army. TEMPEST is twelve forking bolts. FISSURE splits the ground eight ways. GODRAY is a line of light nine thousand units long. THE BIG BANG is all of them.',
    'New passives — CORONA, a share of your own bar a second just for standing near it; MAELSTROM, six blades on a fast orbit; STORMCALL, lightning out of a clear sky; QUICKEN, double-time cooldowns — and new traits: IMMORTAL refuses three deaths a life and goes supernova each time, ECHO lands every verb twice, THUNDER calls lightning down on what it hits, NULLIFY shrugs every status off.',
    'The hulls get BIG. A level-500 tank is four and a half times its own size and the Armageddon is a 560-unit hull before that, so the arena is 28,000 units across and the camera keeps pulling back with every tier.',
    'The climb is three and a half times as long as the Royale’s and it is paid for mostly in kills: 24,000 a kill on top of nearly half the victim’s score, and polygons at 2.6 times their usual worth with the nest kept stocked.',
    'Press Y and the wheel shows all of it — thirteen rings, the Royale’s eight and Armageddon’s five, every hull drawn once.'
  ],
  logic: {
    init: function (g) {
      MODE_LOGIC.juggerroyale.init(g);
      // Eleven verbs firing at once on a dozen hulls is more than twenty bursts.
      g.jrFxCap = 96;
      g.jaFrozen = []; g.jaTimestop = null;
    },
    onSpawn: function (g, t) { MODE_LOGIC.juggerroyale.onSpawn(g, t); },
    // A crown is a leaf in the tank table. Here it is not.
    filterUpgrades: function (g, t, avail) {
      var more = JA_GRAFT[t.tankId];
      if (!more) return avail;
      return avail.concat(more.filter(function (id) { return t.level >= TANK_DEFS[id].levelRequirement; }));
    },
    tick: function (g) {
      jrRoyaleTick(g, 'JUGGERNAUT ARMAGEDDON');
      jaTickFrozen(g);
    },
    botDrive: function (g, t) { if (jrOf(t)) jrBotDrive(g, t); },
    reset: function (g) {
      jrKillList(g.jrHusks);
      g.jrFx = []; g.jrFields = []; g.jrHusks = []; g.jrSeat = 0;
      g.jaFrozen = []; g.jaTimestop = null;
      labReset(g, 'juggarmageddon');
    }
  }
});


// Built at load rather than in init(): the class-tree overlay and the upgrade
// cards are drawn by the client, and online the client never runs a mode's
// init() at all — it only mirrors snapshots. The builder is idempotent.
buildJuggHulls();


if (typeof module !== 'undefined') module.exports = {
  LAB_MODES: LAB_MODES, CHAOS: CHAOS, GUN_CHAIN: GUN_CHAIN, JUGGERNAUT_ID: JUGGERNAUT_ID,
  buildJuggernautDef: buildJuggernautDef, JR_BASE: JR_BASE, JR_HULLS: JR_HULLS,
  buildJuggHulls: buildJuggHulls, jrHull: jrHull, jrAbility: jrAbility,
  JA_BASE: JA_BASE, JA_HULLS: JA_HULLS, JA_GRAFT: JA_GRAFT, jrCast: jrCast,
  JR_BR: JR_BR, JR_DYN: JR_DYN, JR_LVL: JR_LVL, JR_ABIL: JR_ABIL, JR_PASS: JR_PASS,
  JR_TRAIT: JR_TRAIT, JR_GUNS: JR_GUNS, JR_TIER: JR_TIER, JR_DIVIDEND: JR_DIVIDEND,
  jrOf: jrOf, jrJob: jrJob, jrAutoAbilities: jrAutoAbilities,
  chaosShuffle: chaosShuffle, VILLAGE: VILLAGE
};
