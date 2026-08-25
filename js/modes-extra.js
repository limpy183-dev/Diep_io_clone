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
  rules: { dmgMult: 30, spawnLevel: 45, shapes: 120 },
  size: 9000,
  how: [
    'You spawn at level 45 with a full build. So does everyone else.',
    'Damage is multiplied thirty times, so any bullet that lands is fatal.',
    'The arena is 9,000 units instead of 22,300 — there is nowhere to farm and nowhere to hide.',
    'No health snowball means the best player wins every fight and still cannot run away with the match.'
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
  rules: { friction: 0.02 },
  fx: true,
  how: [
    'The velocity damping every entity runs through is turned down five-fold.',
    'Tanks, bullets, drones and polygons all keep their momentum.',
    'Braking distance becomes a real thing to think about, and ramming becomes a skill instead of a stat.',
    'Recoil-heavy classes — Booster, Fighter, Tri-Angle, Rocketeer — read completely differently on ice.'
  ]
});

labMode('bloodmoney', {
  name: 'Blood Money', family: 'Rules', tag: 'no farming',
  blurb: 'Polygons are worth nothing. The only score in the arena is carried by other tanks.',
  rules: { shapeXp: 0, killShare: 0.7 },
  how: [
    'Shapes pay nothing at all. Shooting them is exercise.',
    'A kill hands over 70% of what the loser was carrying, up from the usual 25%.',
    'Score therefore only moves between players — the map has exactly one resource and it shoots back.',
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
  rules: { spawnLevel: 45, shapes: 400 },
  fx: true,
  how: [
    'Everybody is level 45 with the same build. The only difference between two players is which rung they are on.',
    'A kill moves you one class up a fixed 21-rung ladder, applied instantly. A death drops you one, never below rung 1.',
    'The ladder runs Basic → Twin → Triplet → Gunner → Sniper → Overlord → Trapper → Booster → Necromancer → Annihilator, and finishes on Smasher.',
    'Because your gun is public, everyone can see how close everyone else is to winning — and the leader is always stuck on the hardest class.',
    'Shapes still pay, so a losing player has something to do, but only kills move the ladder.'
  ],
  logic: {
    init: function (g) { g.gunRung = {}; },
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
var JUGGERNAUT_ID = 200;
function buildJuggernautDef() {
  if (TANK_DEFS[JUGGERNAUT_ID]) return;
  var ring = [];
  for (var i = 0; i < 6; i++) {
    ring.push({
      angle: Math.PI * 2 * (i / 6), offset: 0, size: 105, width: 60, delay: i % 2 ? 0.5 : 0,
      reload: 1.6, recoil: 0.4, isTrapezoid: false, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1, health: 7, damage: 1.4, speed: 1.1, scatterRate: 0.4, lifeLength: 1.1, absorbtionFactor: 0.6 }
    });
  }
  // Two heavy forward cannons, so it reads as facing somewhere.
  [-0.16, 0.16].forEach(function (a) {
    ring.push({
      angle: a, offset: 0, size: 128, width: 84, delay: 0, reload: 3.4, recoil: 1.6,
      isTrapezoid: true, trapezoidDirection: 0, addon: null,
      bullet: { type: 'bullet', sizeRatio: 1.15, health: 22, damage: 3.2, speed: 0.95, scatterRate: 0.2, lifeLength: 1.4, absorbtionFactor: 0.35 }
    });
  });
  // And a drone escort, because a juggernaut everyone can kite is not one.
  ring.push({
    angle: Math.PI, offset: 0, size: 90, width: 66, delay: 0, reload: 3, recoil: 0,
    isTrapezoid: true, trapezoidDirection: 1, addon: null, droneCount: 6, canControlDrones: true,
    bullet: { type: 'drone', sizeRatio: 0.9, health: 9, damage: 1.1, speed: 1.35, scatterRate: 1, lifeLength: -1, absorbtionFactor: 1 }
  });
  // Every number a Tank derives lives in the def, not in an override applied
  // after recompute() — recompute runs again on the next kill and would put all
  // of them back. This is the Mothership bug (README 27), written down.
  // At level 45 with the stats below: 8772 + 2*44 + 7*20 = 9000 health,
  // and 5 + 7 + 20 = 32 body damage.
  TANK_DEFS[JUGGERNAUT_ID] = {
    id: JUGGERNAUT_ID, name: 'Juggernaut', upgradeMessage: 'YOU ARE THE JUGGERNAUT', levelRequirement: 0,
    upgrades: [], flags: { invisibility: false, zoomAbility: false, canClaimSquares: false, devOnly: false },
    visibilityRateShooting: 0.23, visibilityRateMoving: 0.08, invisibilityRate: 0.03,
    fieldFactor: 1.12, absorbtionFactor: 0.05, speed: 0.72, maxHealth: 8772, preAddon: null,
    postAddon: 'spike', sides: 12, borderWidth: 15, baseSizeOverride: 96, bodyDamage: 20,
    stats: [{ name: 'Movement Speed', max: 7 }, { name: 'Reload', max: 7 }, { name: 'Bullet Damage', max: 7 },
      { name: 'Bullet Penetration', max: 7 }, { name: 'Bullet Speed', max: 7 }, { name: 'Body Damage', max: 7 },
      { name: 'Max Health', max: 7 }, { name: 'Health Regen', max: 7 }],
    barrels: ring
  };
}

function makeJuggernaut(g, from) {
  buildJuggernautDef();
  var t = from;
  t.isJuggernaut = true;
  t.score = Math.max(t.score, LEVEL_SCORE[MAX_LEVEL]);
  t.level = MAX_LEVEL;
  // Regen at 2 rather than 7: it has to heal through chip damage without
  // healing through a focused six. (9000*4*2 + 9000) / 25000 = 3.2 a tick.
  t.scaleBoost = 2.1;
  labClass(t, JUGGERNAUT_ID, [7, 7, 7, 7, 7, 7, 7, 2]);
  t.health = t.maxHealth;
  t.minDmg = 1; t.maxDmg = 5;
  t.push = 22;                       // recompute() pins push at 8, so tick re-applies it
  t.name = (t.name || 'Juggernaut') + ' ☠';
  t.fill = '#2B2B33'; t.stroke = '#16161B';
  t.protectedUntil = 0;
  g.bountyTarget = t;                // every bot in the arena now wants this specifically
  g.mapDirty = true;
  return t;
}

function unJuggernaut(g, t) {
  if (!t || !t.isJuggernaut) return;
  t.isJuggernaut = false;
  t.scaleBoost = 1;
  t.name = String(t.name || '').replace(' ☠', '');
  if (g.bountyTarget === t) g.bountyTarget = null;
}

labMode('juggernaut', {
  name: 'Juggernaut', family: 'Asymmetry', tag: '1 vs all', boss: false,
  blurb: 'One player is a twelve-sided monster with 9,000 health. Everyone else is level 30. Land the kill and it is you.',
  rules: { spawnLevel: 30 },
  fx: true,
  how: [
    'The Juggernaut is a custom hull built for this mode: twelve sides, a spiked collar, six ring cannons, two heavy forward guns and a drone escort.',
    '9,000 health, 32 body damage, double size, and near-total knockback resistance. It is meant to be unfair.',
    'Everyone else spawns at level 30 with their own build and a normal respawn.',
    'Whoever lands the killing blow becomes the next Juggernaut, at full health, and the old one drops back to level 30.',
    'Bots are told about it explicitly — the Juggernaut is registered as the arena bounty, so their target scoring outbids everything else and they gang up instead of farming.',
    'Its health bar is public. A single player cannot take it; six can.'
  ],
  logic: {
    init: function (g) { g.jugg = null; g.juggPick = g.tick + 12 * TPS; },
    onSpawn: function (g, t) {
      // The seat is never empty for long: if the round has no Juggernaut and a
      // fresh tank turns up, it gets the hull.
      if (!g.jugg && g.tick > g.juggPick && !t.isPlayer) { g.jugg = makeJuggernaut(g, t); }
    },
    onTankDeath: function (g, victim, killer) {
      if (!victim.isJuggernaut) return;
      unJuggernaut(g, victim);
      g.jugg = null;
      var root = killer; while (root && root.owner) root = root.owner;
      if (root && root.type === 'tank' && !root.dead && !root.modeEntity) {
        g.jugg = makeJuggernaut(g, root);
        root.health = root.maxHealth;
        g.notify((root.name || 'Someone') + ' is the new Juggernaut!', 100);
      } else {
        g.notify('The Juggernaut has fallen.', 80);
        g.juggPick = g.tick + 5 * TPS;
      }
    },
    tick: function (g) {
      if (g.jugg && (g.jugg.dead || !g.jugg.isJuggernaut)) g.jugg = null;
      if (!g.jugg && g.tick > g.juggPick) {
        var list = labTanks(g);
        if (list.length) { g.jugg = makeJuggernaut(g, pick(list)); g.notify((g.jugg.name || 'Someone') + ' is the Juggernaut!', 100); }
        g.juggPick = g.tick + 5 * TPS;
      }
      g.bountyTarget = g.jugg && !g.jugg.dead ? g.jugg : null;
      if (g.jugg && !g.jugg.dead) g.jugg.push = 22;   // the one field recompute() pins
      g.fx = g.jugg && !g.jugg.dead ? { jugg: g.jugg } : null;
      if (g.tick % 25 === 0) setHud(g, g.jugg && !g.jugg.dead
        ? 'JUGGERNAUT  ·  ' + (g.jugg.name || '?') + '  ' + Math.max(0, Math.round(g.jugg.health)) + ' hp'
        : 'JUGGERNAUT  ·  choosing...');
    },
    reset: function (g) { g.jugg = null; labReset(g, 'juggernaut'); },
    // Bots travel to it; the bounty term in the target scan does the shooting.
    botGoal: function (g, t) {
      if (!g.jugg || g.jugg.dead || t === g.jugg || !botGrown(t, 12)) return null;
      return { e: g.jugg };
    }
  }
});

labMode('infection', {
  name: 'Infection', family: 'Asymmetry', tag: 'zombies',
  teams: ['blue', 'red'],
  blurb: 'Everyone starts human. Patient zero turns after thirty seconds. Die to the infected and you join them.',
  fx: true,
  how: [
    'Thirty seconds to scatter, then one player at random turns red.',
    'The infected are locked to a rammer hull with no guns, heavy body damage, more speed and see-invisible.',
    'Anyone killed by an infected respawns infected. Dying to a shape does not turn you.',
    'Humans keep their own build and win by surviving five minutes. The infected win by taking everyone.',
    'The play area shrinks throughout, so the last humans cannot simply sit in a corner and wait.',
    'Invisibility is capped at 25% opacity, the same anti-stall rule Tag uses.'
  ],
  logic: {
    init: function (g) {
      g.infStart = g.tick + 30 * TPS;
      g.labClock = 5 * 60 * TPS + 30 * TPS;
      g.infected = false;
    },
    onSpawn: function (g, t) {
      if (t.team === 'red') { labClass(t, 23, [7, 0, 0, 0, 0, 7, 7, 3]); t.seesInvisible = true; t.damagePerTick += 12; }
    },
    onTankDeath: function (g, victim, killer) {
      var root = killer; while (root && root.owner) root = root.owner;
      if (root && root.type === 'tank' && root.team === 'red' && victim.team !== 'red') victim.nextTeam = 'red';
    },
    tick: function (g) {
      var list = labTanks(g), i, humans = 0, zombies = 0;
      for (i = 0; i < list.length; i++) {
        if (list[i].invisible && list[i].opacity < 0.25) list[i].opacity = 0.25;
        if (list[i].team === 'red') zombies++; else { humans++; list[i].team = 'blue'; }
      }
      g.teamCounts = { blue: humans, red: zombies };
      if (g.tick < g.infStart) {
        if ((g.infStart - g.tick) % TPS === 0) g.notify('Infection begins in ' + Math.ceil((g.infStart - g.tick) / TPS) + '...', TPS);
        if (g.tick % 25 === 0) setHud(g, 'INFECTION  ·  scatter');
        return;
      }
      if (!g.infected && list.length) {
        g.infected = true;
        var zero = pick(list);
        zero.team = 'red'; g.paintTeam(zero);
        labClass(zero, 23, [7, 0, 0, 0, 0, 7, 7, 3]);
        zero.seesInvisible = true;
        g.notify((zero.name || 'Someone') + ' is patient zero!', 120);
        zombies++; humans--;
      }
      if (g.tick % 50 === 0 && g.arena.size > 8000) setArenaSize(g, g.arena.size - 60);
      g.fx = { infection: zombies / Math.max(1, humans + zombies) };
      g.labClock--;
      if (g.tick % 25 === 0) setHud(g, 'INFECTION  ·  ' + humans + ' left  ·  ' + clock(g.labClock));
      if (g.roundEndsAt) return;
      if (g.infected && humans === 0) winRound(g, 'Everyone is infected — the horde wins!');
      else if (g.labClock <= 0) winRound(g, humans + ' survivor' + (humans === 1 ? '' : 's') + ' held out — humans win!');
    },
    reset: function (g) {
      for (var i = 0; i < g.entities.length; i++) if (g.entities[i].type === 'tank') g.entities[i].nextTeam = null;
      labReset(g, 'infection');
    },
    botGoal: function () { return null; }
  }
});

labMode('bossrush', {
  name: 'Boss Rush', family: 'Asymmetry', tag: 'co-op',
  teams: ['blue'], xp: 3,
  blurb: 'Everybody on one team against the arena. Waves of crashers, squads and bosses, until you wipe.',
  rules: { shapes: 300 },
  fx: true,
  how: [
    'Every player and bot is on the blue team. There is no PvP at all.',
    'Waves arrive on a timer with a breather between them: crasher swarms first, then hostile red squads at rising difficulty, then one boss, then two, then all five.',
    'Bot difficulty is turned up by wave, so wave 9 is the same enemies playing at Extreme.',
    'Levels carry across waves, so your power climbs with the threat.',
    'Score is the wave you reached. A total wipe ends the run and the arena restarts at wave 1.',
    'It is the only co-operative mode in the build, which is exactly why it exists.'
  ],
  logic: {
    init: function (g) { g.wave = 0; g.waveAt = g.tick + 10 * TPS; g.waveLive = []; },
    tick: function (g) {
      var i;
      for (i = g.waveLive.length - 1; i >= 0; i--) if (g.waveLive[i].dead) g.waveLive.splice(i, 1);
      var alive = 0, list = labTanks(g);
      for (i = 0; i < list.length; i++) if (list[i].team === 'blue') alive++;

      if (!g.waveLive.length && g.tick >= g.waveAt) {
        g.wave++;
        g.waveAt = g.tick + 8 * TPS;
        spawnWave(g, g.wave);
        g.notify('WAVE ' + g.wave, 80);
        g.fx = { waveFlash: g.tick };
      }
      if (g.tick % 25 === 0) setHud(g, 'BOSS RUSH  ·  wave ' + Math.max(1, g.wave) + '  ·  ' + g.waveLive.length + ' left');
      if (g.roundEndsAt) return;
      if (g.wave > 0 && alive === 0) winRound(g, 'Wiped on wave ' + g.wave + '.');
    },
    reset: function (g) { g.wave = 0; g.waveLive = []; labReset(g, 'bossrush'); },
    botGoal: function (g, t) {
      if (!g.waveLive || !g.waveLive.length || t.team !== 'blue') return null;
      var e = botNearest(t, g.waveLive, function (x) { return !x.dead; });
      return e ? { e: e } : null;
    }
  }
});

function spawnWave(g, n) {
  var a = g.arena, i, ang, r;
  var hard = Math.min(1, n / 10);
  g.setDifficulty(n < 3 ? 'medium' : n < 6 ? 'hard' : n < 9 ? 'veryhard' : 'extreme');
  if (n % 4 === 0 || n >= 9) {                     // boss wave
    var count = n >= 13 ? 3 : n >= 9 ? 2 : 1;
    for (i = 0; i < count; i++) { g.spawnBoss(); if (g.boss) { g.boss.modeEntity = true; g.waveLive.push(g.boss); g.boss = null; } }
  }
  if (n % 4 !== 0) {                               // squad wave
    var squad = 3 + Math.round(n * 1.4);
    for (i = 0; i < squad; i++) {
      ang = Math.random() * Math.PI * 2; r = a.right * 0.85;
      var t = new Tank(g, { x: Math.cos(ang) * r, y: Math.sin(ang) * r, name: 'Raider', bot: true, team: 'red',
        score: LEVEL_SCORE[Math.min(MAX_LEVEL, 12 + Math.round(hard * 33))] });
      t.botRole = BOT_ROLES[1];
      t.modeEntity = true;
      g.paintTeam(t);
      t.checkUpgrades();
      while (t.pendingUpgrades.length) t.upgradeTo(pick(t.pendingUpgrades));
      for (var s = 0; s < 8 && t.statsAvailable > 0; s++) while (t.statsAvailable > 0 && t.upgradeStat((s * 5 + 3) % 8)) { /* spread */ }
      g.waveLive.push(g.add(t));
    }
  }
  var crash = 6 + n * 3;                           // and a crasher belt on every wave
  for (i = 0; i < crash; i++) {
    ang = Math.random() * Math.PI * 2; r = a.right * (0.5 + Math.random() * 0.45);
    var c = new Shape(g, n > 5 ? 'crasherL' : 'crasherS', Math.cos(ang) * r, Math.sin(ang) * r);
    c.modeEntity = true;
    g.waveLive.push(g.add(c));
  }
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
      g.core = labRect(g, { x: a.right * 0.72, y: 0, w: 380, h: 380, team: 'red', fill: '#B45A5F', stroke: '#8A4348', push: 12 });
      g.core.maxHealth = 12000; g.core.health = 12000;
      g.core.damageReduction = 1; g.core.hiddenHealthbar = false; g.core.isCore = true;
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
  rules: { shapes: 600 },
  fx: true,
  how: [
    'Ninety seconds to level up and pick a class. Then the ring closes.',
    'Arena Closers are invincible, one-shot on contact, pass straight through walls and see invisible — a Stalker cannot wait one out.',
    'Fourteen of them spawn on a circle outside the field and sweep inward, and more arrive every forty seconds.',
    'Spawn protection is waived here: the sweep is the point of the mode.',
    'Your score is the time you survived. When the last tank is gone the arena restarts.',
    'These exist in the base game only when a server is being retired, which is a waste of the best entity in the codebase.'
  ],
  logic: {
    init: function (g) { g.gauntletAt = g.tick + 90 * TPS; g.gauntletWave = 0; g.gauntletStart = g.tick; },
    onSpawn: function (g, t) { if (g.gauntletWave > 0) t.protectedUntil = 0; },
    tick: function (g) {
      var i, alive = 0, list = labTanks(g);
      alive = list.length;
      if (g.tick >= g.gauntletAt) {
        g.gauntletAt = g.tick + 40 * TPS;
        g.gauntletWave++;
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
  blurb: 'Nobody plays a tank. Everybody drives one of the five bosses, and none of them were built to fight each other.',
  fx: true,
  how: [
    'On spawn you are put straight inside a boss hull — Guardian, Summoner, Fallen Overlord, Fallen Booster or Defender — chosen at random.',
    'No levelling, no upgrades, no stats. The hull is the build.',
    'Die and you come back in a different one, so a round shows you all five.',
    'Guardian outruns everything, Summoner floods the field with necro drones, Defender turtles behind traps.',
    'It will never be balanced. That is not what it is for.'
  ],
  logic: {
    init: function (g) { g.royaleSeats = []; },
    onSpawn: function (g, t) {
      var b = new Boss(g, BOSSES[(Math.random() * BOSSES.length) | 0]);
      b.modeEntity = true;
      b.team = t.team;
      b.x = t.x; b.y = t.y;
      g.add(b);
      if (!possess(g, t, b)) { b.dead = true; return; }
      t.royaleSeat = b;
      t.notify('You are ' + b.name + ' — press H to step out', 100);
    },
    tick: function (g) {
      // A seat whose driver stepped out or died is furniture; sweep it so the
      // arena does not fill with unpiloted bosses.
      for (var i = 0; i < g.entities.length; i++) {
        var e = g.entities[i];
        if (e.type === 'boss' && e.modeEntity && !e.dead && !e.possessedBy) e.kill(null);
      }
      if (g.tick % 25 === 0) setHud(g, 'BOSS ROYALE');
    },
    reset: function (g) { labReset(g, 'bossroyale'); },
    botGoal: function () { return null; }
  }
});

// =========================================================================
// Family: physics
// =========================================================================

labMode('sumo', {
  name: 'Sumo', family: 'Physics', tag: 'ring out',
  rules: { dmgMult: 0, spawnLevel: 45, shapes: 0, regen: 3 },
  size: 12000,
  blurb: 'Bullets do no damage at all — only knockback. The ring shrinks. Step outside it and you are gone.',
  fx: true,
  how: [
    'Damage is multiplied by zero. Knockback is untouched, because it is applied separately from damage.',
    'Every tank is level 45 with a full build and there are no shapes on the floor.',
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
  rules: { shapes: 0, spawnLevel: 30 },
  size: 14000,
  blurb: 'Two teams, one enormous neutral ball, two goals. Shoot it, ram it, push it home. Kills score nothing.',
  fx: true,
  how: [
    'A heavy neutral ball sits at the centre. It takes no damage and deals none — it only takes knockback.',
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
      g.ball.scoreReward = 0; g.ball.isCrasher = false; g.ball.spin = 0.004;
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
  name: 'Grand Prix', family: 'Physics', tag: '3 laps',
  rules: { shapes: 150, spawnLevel: 25 },
  blurb: 'A ring of gates, three laps, weapons live. Shooting the leader off the racing line is entirely legal.',
  fx: true,
  how: [
    'Eight gates sit on a circle around the arena. You must take them in order — cutting the corner does not count.',
    'Three laps. Your gate and lap are shown on your own screen as you pass each one.',
    'Weapons are live the whole time. Knocking somebody backwards past a gate genuinely costs them.',
    'Dying puts you back at your last gate rather than at spawn, so a race is never over.',
    'Booster, Fighter, Tri-Angle and Rocketeer are built entirely out of recoil, and this is the only mode that rewards it.'
  ],
  logic: {
    init: function (g) {
      var a = g.arena, n = 8, r = a.right * 0.72;
      g.gates = [];
      for (var i = 0; i < n; i++) {
        var ang = Math.PI * 2 * (i / n) - Math.PI / 2;
        var m = labMark(g, { x: Math.cos(ang) * r, y: Math.sin(ang) * r, size: 300, sides: 6,
          fill: i === 0 ? '#FFDE43' : '#8FE3FF', stroke: i === 0 ? '#BFA732' : '#5FA8C4' });
        m.gateIndex = i;
        g.gates.push(m);
      }
      g.raceLaps = 3;
    },
    onSpawn: function (g, t) {
      if (t.raceGate === undefined) { t.raceGate = 0; t.raceLap = 0; }
      else { var gt = g.gates[(t.raceGate - 1 + g.gates.length) % g.gates.length]; t.x = gt.x; t.y = gt.y; }
    },
    tick: function (g) {
      var list = labTanks(g), i, best = null;
      for (i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.raceGate === undefined) { t.raceGate = 0; t.raceLap = 0; }
        var want = g.gates[t.raceGate];
        if (want && touching(t, want, 60)) {
          t.raceGate = (t.raceGate + 1) % g.gates.length;
          if (t.raceGate === 0) {
            t.raceLap++;
            t.notify('Lap ' + t.raceLap + '/' + g.raceLaps, 70);
            if (t.raceLap >= g.raceLaps && !g.roundEndsAt) {
              winRound(g, (t.name || 'An unnamed tank') + ' takes the chequered flag!');
            }
          } else t.notify('Gate ' + t.raceGate + '/' + g.gates.length, 45);
        }
        var prog = (t.raceLap || 0) * g.gates.length + (t.raceGate || 0);
        if (!best || prog > best.prog) best = { t: t, prog: prog };
      }
      g.fx = { race: true };
      if (g.tick % 25 === 0) setHud(g, best ? 'GRAND PRIX  ·  leader ' + (best.t.name || '?') + '  lap ' + ((best.t.raceLap || 0) + 1) + '/' + g.raceLaps : 'GRAND PRIX');
    },
    reset: function (g) {
      for (var i = 0; i < g.entities.length; i++) if (g.entities[i].type === 'tank') { g.entities[i].raceGate = 0; g.entities[i].raceLap = 0; }
      labReset(g, 'grandprix');
    },
    botGoal: function (g, t) {
      if (!g.gates) return null;
      var want = g.gates[t.raceGate || 0];
      return want ? botSpot(want, true) : null;
    }
  }
});

labMode('redlight', {
  name: 'Red Light, Green Light', family: 'Physics', tag: 'do not move',
  rules: { shapes: 0, spawnLevel: 20, bots: 40 },
  size: 16000,
  blurb: 'Green, run. Red, freeze. Anything still moving when the light turns is deleted. Reach the far wall to win.',
  fx: true,
  how: [
    'Everybody starts against the west wall. The finish is a line at the east wall.',
    'The light alternates between green and red on a random interval, and flashes amber for a beat before it changes.',
    'While the light is red, any tank with real velocity is killed instantly. A small tolerance is allowed, because at 25 Hz you still drift for a moment after letting go of the key.',
    'Bullets do nothing here — the light is the only thing that can kill you.',
    'First tank across the line wins the round.',
    'It works with forty bots and zero coordination, which is more than most party modes manage.'
  ],
  logic: {
    init: function (g) {
      var a = g.arena;
      g.lightGreen = true;
      g.lightAt = g.tick + 5 * TPS;
      g.finish = labRect(g, { x: a.right - 500, y: 0, w: 400, h: a.size / 2, fill: '#85E8A0', stroke: '#5FAF74' });
      g.ruleOverride = { dmgMult: 0 };
    },
    onSpawn: function (g, t) { t.x = g.arena.left + 600 + Math.random() * 400; t.y = (Math.random() - 0.5) * g.arena.size * 0.8; },
    tick: function (g) {
      var list = labTanks(g), i, t;
      if (g.tick >= g.lightAt) {
        g.lightGreen = !g.lightGreen;
        g.lightAt = g.tick + (g.lightGreen ? 3 + Math.random() * 5 : 2 + Math.random() * 4) * TPS;
        g.notify(g.lightGreen ? 'GREEN LIGHT' : 'RED LIGHT', 35);
      }
      var warn = g.lightAt - g.tick < TPS;
      if (!g.lightGreen && g.tick > g.lightAt - 1e9) {
        for (i = 0; i < list.length; i++) {
          t = list[i];
          if (Math.hypot(t.vx, t.vy) > 1.1) { t.applyDamage(1e9, null); g.notify((t.name || 'Someone') + ' moved.', 40); }
        }
      }
      for (i = 0; i < list.length; i++) if (insideRect(list[i], g.finish) && !g.roundEndsAt) {
        winRound(g, (list[i].name || 'An unnamed tank') + ' made it across!');
        break;
      }
      g.fx = { light: g.lightGreen ? 1 : 0, warn: warn };
      if (g.tick % 25 === 0) setHud(g, g.lightGreen ? 'GREEN LIGHT  ·  run' : 'RED LIGHT  ·  freeze');
    },
    reset: function (g) { labReset(g, 'redlight'); },
    // Bots respect the light: they only get a goal while it is green.
    botGoal: function (g, t) {
      if (!g.lightGreen) return { x: t.x, y: t.y, vx: 0, vy: 0, touch: false, hard: true };
      return g.finish ? { x: g.finish.x, y: t.y, vx: 0, vy: 0, touch: true, hard: true } : null;
    }
  }
});

labMode('singularity', {
  name: 'Singularity', family: 'Physics', tag: 'growing',
  rules: { shapes: 900 },
  blurb: 'A black hole opens at the centre. It starts almost invisible and ends by swallowing the entire arena.',
  fx: true,
  how: [
    'The singularity begins as a 40-unit speck with almost no pull. You will not notice it for the first minute.',
    'It grows continuously for twelve minutes. Radius, reach and pull all scale together, so the map gets slowly, then suddenly, harder to stand in.',
    'Anything that crosses the event horizon is destroyed — tanks, bullets, drones and polygons alike.',
    'Bullets curve as they fly, so long-range classes have to lead into the well as well as onto the target.',
    'By the end it covers the whole arena and there is nowhere left. The round is who lasted longest.',
    'An accretion disc, lensing ring and infalling debris are all drawn from the live pull value, so what you see is what the physics is doing.'
  ],
  logic: {
    init: function (g) { g.singT = 0; },
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
        // inverse-ish falloff, capped so a distant tank is nudged not yanked
        var k = pull * Math.min(1, (radius + 400) / d) * (1 - d / reach);
        e.addVelocity(Math.atan2(-e.y, -e.x), k);
      }
      g.fx = { sing: radius, reach: reach, pull: pull, f: f };
      if (g.tick % 25 === 0) setHud(g, 'SINGULARITY  ·  r=' + Math.round(radius) + '  ·  ' + clock(life - g.singT));
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

labMode('prophunt', {
  name: 'Prop Hunt', family: 'Deception', tag: 'hide in plain sight',
  teams: ['blue', 'red'],
  rules: { shapes: 1400, spawnLevel: 20 },
  blurb: 'Hiders are disguised as polygons and can move freely. Seekers pay in health for every wrong shot.',
  fx: true,
  how: [
    'Hiders (blue) are repainted as a Square, Triangle or Pentagon — real sides, real size, real colours, and no name plate.',
    'You can move exactly as fast as normal. Hiding is about behaving like a shape, not about standing still.',
    'Hiders cannot fire. Press fire to re-roll your disguise instead, on a five-second cooldown.',
    'Seekers (red) get a small permanent damage bonus and a wide view, but every shot that hits a genuine polygon costs them 40 health.',
    'A hider that takes damage flashes its true colours for a moment, which is usually enough to get it killed.',
    'The shape field is normally wallpaper you farm without looking at. Here it is the most dangerous part of the map.',
    'Hiders win on a four-minute clock; seekers win by finding everybody.'
  ],
  logic: {
    init: function (g) { g.labClock = 4 * 60 * TPS; g.huntStart = g.tick + 15 * TPS; },
    onSpawn: function (g, t) {
      // Two thirds hide. The seeker pool is deliberately small.
      var seekers = 0, all = labPlayers(g);
      for (var i = 0; i < all.length; i++) if (all[i].team === 'red') seekers++;
      var beSeeker = seekers < Math.max(1, Math.round(all.length / 3));
      t.team = beSeeker ? 'red' : 'blue';
      g.paintTeam(t);
      if (beSeeker) { t.seesInvisible = true; t.damagePerTick += 6; t.isSeeker = true; return; }
      disguise(g, t);
    },
    tick: function (g) {
      var list = labTanks(g), i, hiders = 0, seekers = 0;
      for (i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.team === 'red') { seekers++; continue; }
        hiders++;
        t.hideName = true;
        // Fire re-rolls the disguise instead of shooting.
        t.input.fire = 0; t.autoFire = false;
        if (t.wantDisguise === undefined) t.wantDisguise = 0;
        if ((t.input.altFire || t.reDisguise) && g.tick > (t.disguiseAt || 0) + 5 * TPS) { disguise(g, t); t.reDisguise = false; }
        // Levelling up calls setTank, which puts the real sides and base size
        // back. The disguise has to be re-asserted rather than set once.
        else if (t.propKind && t.sides !== SHAPES[t.propKind].sides) reDisguise(t);
        // Damage briefly blows the cover: the flash uses the real team colour.
        if (t.hurtFlash > 0) { t.fill = C.blue; t.stroke = C.blueS; }
        else if (t.propKind) { var s = SHAPES[t.propKind]; t.fill = s.fill; t.stroke = s.stroke; }
      }
      // A seeker that shoots a real polygon pays for it.
      for (i = 0; i < g.entities.length; i++) {
        var e = g.entities[i];
        if (e.type !== 'shape' || !e.dead || e.propCharged) continue;
        e.propCharged = true;
        var k = e.lastHitBy;
        // A rule, not a hit: applyDamage is refused outright while spawn
        // protection is up, and the penalty has to land either way.
        if (k && k.isSeeker && !k.dead) {
          k.health = Math.max(1, k.health - 40);
          k.hurtFlash = 4;
          k.notify('That was a real one. -40', 40);
        }
      }
      g.teamCounts = { blue: hiders, red: seekers };
      g.fx = { prop: true };
      if (g.tick < g.huntStart) {
        if (g.tick % 25 === 0) setHud(g, 'PROP HUNT  ·  hide  ·  ' + clock(g.huntStart - g.tick));
        for (i = 0; i < list.length; i++) if (list[i].team === 'red') { list[i].input.fire = 0; list[i].autoFire = false; }
        return;
      }
      g.labClock--;
      if (g.tick % 25 === 0) setHud(g, 'PROP HUNT  ·  ' + hiders + ' hiding  ·  ' + clock(g.labClock));
      if (g.roundEndsAt) return;
      if (hiders === 0 && seekers > 0) winRound(g, 'Every prop found — the seekers win!');
      else if (g.labClock <= 0) winRound(g, hiders + ' prop' + (hiders === 1 ? '' : 's') + ' survived — the hiders win!');
    },
    reset: function (g) {
      var list = labTanks(g);
      for (var i = 0; i < list.length; i++) undisguise(list[i]);
      labReset(g, 'prophunt');
    },
    // A hider changing class mid-round blows its own cover the moment the
    // barrels come back, so nobody upgrades in here.
    filterUpgrades: function () { return []; },
    botGoal: function (g, t) {
      if (t.team !== 'blue') return null;
      // Hiding bots drift toward the thickest part of the shape field rather
      // than fighting, which is the only way a bot can pass for a polygon.
      if (g.tick % 100 > 60) return null;
      var a = Math.random() * Math.PI * 2, r = g.arena.right * (0.35 + Math.random() * 0.5);
      return { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, touch: false, hard: false };
    }
  }
});

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
  rules: { shapes: 900, spawnLevel: 30 },
  blurb: 'Almost everybody is a Stalker. Two or three seekers see invisible and have four minutes to find them.',
  fx: true,
  how: [
    'Hiders are locked to Stalker and Landmine — a Stalker fades in 1.3 seconds, a Landmine takes 13.3, and both numbers are the real measured ones.',
    'A fully faded tank is genuinely never sent to other clients, so hiding online is real and cannot be defeated by reading network traffic.',
    'Seekers see invisible, move faster, and carry a wide field of view.',
    'Firing or moving fades you back in. Standing still is the only true camouflage.',
    'Opacity is floored at 25% in the last minute so a round always ends.',
    'Hiders win on the clock; seekers win by clearing the board.'
  ],
  logic: {
    init: function (g) { g.labClock = 4 * 60 * TPS; },
    onSpawn: function (g, t) {
      var all = labPlayers(g), seekers = 0;
      for (var i = 0; i < all.length; i++) if (all[i].team === 'red') seekers++;
      if (seekers < Math.max(1, Math.round(all.length / 8))) {
        t.team = 'red'; g.paintTeam(t);
        t.seesInvisible = true; t.isSeeker = true;
        labClass(t, 8, [7, 5, 5, 5, 5, 0, 5, 1]);
        t.movementSpeed *= 1.25;
      } else {
        t.team = 'blue'; g.paintTeam(t);
        labClass(t, Math.random() < 0.7 ? 63 : 41, [7, 4, 4, 4, 4, 0, 6, 3]);
      }
    },
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
      if (g.tick % 25 === 0) setHud(g, 'HIDE & SEEK  ·  ' + hiders + ' hidden  ·  ' + clock(g.labClock));
      if (g.roundEndsAt) return;
      if (hiders === 0 && seekers > 0) winRound(g, 'All found — the seekers win!');
      else if (g.labClock <= 0) winRound(g, hiders + ' still hidden — the hiders win!');
    },
    reset: function (g) { labReset(g, 'hideseek'); },
    botGoal: function () { return null; }
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
  rules: { fov: 0.5, shapes: 900 },
  blurb: 'Half the view distance, and a real fog bank rolling over the field. You find out about people by being shot.',
  fx: true,
  how: [
    'Field of view is halved for everybody, permanently.',
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
  blurb: 'A slow armoured hulk crawls toward the enemy base while your team stands near it, and stops when contested.',
  fx: true,
  how: [
    'The payload starts in the middle and moves toward whichever team has more tanks within 900 units of it.',
    'Its speed scales with how many of you are escorting: one tank is a crawl, five is a march.',
    'Even numbers on both sides stop it dead, so a stalemate is a real state you can see.',
    'It shoots back with a Dominator gun, at whichever side does not currently hold it.',
    'Push it all the way into the enemy base to win. The whole map state is legible from the minimap alone.'
  ],
  logic: {
    init: function (g) {
      var a = g.arena;
      g.pay = makeDominator(g, 0, 0);
      g.pay.immobile = false;
      g.pay.name = 'Payload';
      g.pay.absorb = 0;
      g.pay.isPayload = true;
      g.pay.health = g.pay.maxHealth = 20000;
      g.payGoal = { blue: a.right * 0.82, red: a.left * 0.82 };
      g.payHold = null;
    },
    tick: function (g) {
      var p = g.pay;
      if (!p || p.dead) return;
      tickPlatformAI(g, p, 2600);
      var list = labTanks(g), i, near = { blue: 0, red: 0 };
      for (i = 0; i < list.length; i++) if (Math.hypot(list[i].x - p.x, list[i].y - p.y) < 900) near[list[i].team] = (near[list[i].team] || 0) + 1;
      var owner = near.blue > near.red ? 'blue' : near.red > near.blue ? 'red' : null;
      g.payHold = owner;
      if (owner) {
        var speed = Math.min(4.2, 1.1 + Math.abs(near.blue - near.red) * 0.7);
        p.x += (g.payGoal[owner] > p.x ? 1 : -1) * speed;
        p.team = owner; paintTeamColors(p, owner);
      } else { p.team = null; paintTeamColors(p, null); }
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
    botGoal: function (g, t) { return g.pay && !g.pay.dead && t.team ? botSpot(g.pay) : null; }
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
var CHAOS = [
  { name: 'GLASS CANNON', blurb: 'triple damage, both ways', on: function (g) { g.ruleOverride = { dmgMult: 3 }; } },
  { name: 'BLITZ', blurb: 'the clock runs at double', on: function (g) { g.timeScale = 2; }, off: function (g) { g.timeScale = 1; } },
  { name: 'ICE AGE', blurb: 'nothing stops', on: function (g) { g.ruleOverride = { friction: 0.022 }; } },
  { name: 'VAMPIRES', blurb: 'no regen, heal by hurting', on: function (g) { g.ruleOverride = { regen: 0, lifesteal: 0.7 }; } },
  { name: 'OVERDRIVE', blurb: 'reload cut to a third', on: function (g) { g.ruleOverride = { reloadMult: 0.33 }; chaosRecompute(g); }, off: chaosRecompute },
  { name: 'POLYGON RAIN', blurb: 'the field floods', on: function (g) { g.wantedShapes = 3200; }, off: function (g) { g.wantedShapes = 1000; } },
  { name: 'BLACKOUT', blurb: 'half the view distance', on: function (g) { g.fovScale = 0.5; chaosRecompute(g); }, off: function (g) { g.fovScale = 1; chaosRecompute(g); } },
  { name: 'GIANTS', blurb: 'everything is twice the size', on: function (g) { chaosScale(g, 2); }, off: function (g) { chaosScale(g, 1); } },
  { name: 'FEATHERWEIGHT', blurb: 'knockback goes through the roof', on: function (g) { chaosEach(g, function (t) { t.absorb = 4; }); }, off: function (g) { chaosEach(g, function (t) { t.recompute(); }); } },
  { name: 'GHOST TOWN', blurb: 'everybody turns invisible', on: function (g) { chaosEach(g, function (t) { t.cheatInvis = true; }); }, off: function (g) { chaosEach(g, function (t) { t.cheatInvis = false; t.opacity = 1; }); } },
  { name: 'REROLL', blurb: 'everyone gets a new class', on: function (g) { chaosEach(g, function (t) { var f = t.health / t.maxHealth; forceTankClass(t, randomTankId(), GUN_STATS); t.health = t.maxHealth * f; }); } },
  { name: 'BOUNTY', blurb: 'the leader is worth everything', on: function (g) { g.ruleOverride = { killShare: 0.9 }; g.bountyTarget = labLeader(g); }, off: function (g) { g.bountyTarget = null; } },
  { name: 'DISCO', blurb: 'the lights go down', on: function (g) { chaosEach(g, function (t) { t.fill = '#' + ((Math.random() * 0xFFFFFF) | 0).toString(16).padStart(6, '0'); t.stroke = t.fill; }); g.discoOn = true; }, off: function (g) { g.discoOn = false; chaosEach(g, function (t) { g.paintTeam(t); }); } },
  { name: 'BULLET HELL', blurb: 'everything fires by itself', on: function (g) { chaosEach(g, function (t) { t.autoFire = true; }); g.ruleOverride = { reloadMult: 0.5 }; chaosRecompute(g); }, off: function (g) { chaosEach(g, function (t) { if (!t.isPlayer) t.autoFire = false; }); chaosRecompute(g); } },
  { name: 'BOSS DROP', blurb: 'a boss arrives, uninvited', on: function (g) { g.spawnBoss(); } }
];

function chaosEach(g, fn) { var l = labTanks(g); for (var i = 0; i < l.length; i++) fn(l[i]); }
function chaosRecompute(g) { chaosEach(g, function (t) { t.recompute(); }); }
function chaosScale(g, k) { chaosEach(g, function (t) { t.scaleBoost = k; t.recompute(); }); }

labMode('chaos', {
  name: 'Chaos Rotation', family: 'Rules', tag: 'every 90s', boss: true,
  blurb: 'A modifier is drawn every ninety seconds and announced to the arena. Fifteen of them, never twice in a row.',
  fx: true,
  how: [
    'Ordinary free-for-all, except that every ninety seconds a modifier is drawn from a table of fifteen and applied to the whole arena.',
    'It is announced in chat and on screen five seconds before it lands, and again when it ends, so everybody reacts to the same surprise at the same moment.',
    'The table: Glass Cannon, Blitz, Ice Age, Vampires, Overdrive, Polygon Rain, Blackout, Giants, Featherweight, Ghost Town, Reroll, Bounty, Disco, Bullet Hell and Boss Drop.',
    'The deck is shuffled rather than rolled, so you see all fifteen before any repeats.',
    'Everything is cleanly undone when the timer runs out — nothing leaks into the next modifier.',
    'This is the mode that argues against building thirty-eight separate arenas: one well-populated FFA and a modifier table beats eight empty lobbies.'
  ],
  logic: {
    init: function (g) { g.chaosDeck = []; g.chaosAt = g.tick + 30 * TPS; g.chaosCur = null; },
    tick: function (g) {
      var left = g.chaosAt - g.tick;
      if (left === 5 * TPS && !g.chaosCur) g.notify('Something is about to change...', 5 * TPS);
      if (left <= 0) {
        if (g.chaosCur) {
          if (g.chaosCur.off) g.chaosCur.off(g);
          g.ruleOverride = null;
          g.notify(g.chaosCur.name + ' is over.', 50);
          g.chaosCur = null;
          g.chaosAt = g.tick + 20 * TPS;
        } else {
          if (!g.chaosDeck.length) {
            g.chaosDeck = CHAOS.slice();
            for (var i = g.chaosDeck.length - 1; i > 0; i--) {
              var j = (Math.random() * (i + 1)) | 0, t = g.chaosDeck[i]; g.chaosDeck[i] = g.chaosDeck[j]; g.chaosDeck[j] = t;
            }
          }
          g.chaosCur = g.chaosDeck.pop();
          g.chaosCur.on(g);
          g.notify(g.chaosCur.name + ' — ' + g.chaosCur.blurb, 90);
          g.chaosAt = g.tick + 90 * TPS;
          g.fx = { chaosFlash: g.tick };
        }
      }
      g.fx = { chaos: g.chaosCur ? g.chaosCur.name : null, disco: !!g.discoOn, flashAt: (g.fx && g.fx.chaosFlash) || 0 };
      if (g.tick % 25 === 0) setHud(g, g.chaosCur ? 'CHAOS  ·  ' + g.chaosCur.name + '  ·  ' + clock(g.chaosAt - g.tick)
        : 'CHAOS  ·  next in ' + clock(g.chaosAt - g.tick));
    },
    reset: function (g) {
      if (g.chaosCur && g.chaosCur.off) g.chaosCur.off(g);
      g.chaosCur = null; g.chaosDeck = []; g.discoOn = false;
      labReset(g, 'chaos');
    }
  }
});

if (typeof module !== 'undefined') module.exports = {
  LAB_MODES: LAB_MODES, CHAOS: CHAOS, GUN_CHAIN: GUN_CHAIN, JUGGERNAUT_ID: JUGGERNAUT_ID,
  buildJuggernautDef: buildJuggernautDef
};
