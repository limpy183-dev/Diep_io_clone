// tankdefs-extra.js — tanks added to diep after the canonical dump was taken.
//
// js/tankdefs.js is GENERATED and must never be hand-edited; this file patches
// the table at load time instead, so re-fetching the dump keeps these intact.
//
// The stat multipliers below are solved from the published per-point figures
// against the engine's own formulas:
//   penetration = (1.5*P + 2) * bullet.health
//   damage      = (7 + 3*P)   * bullet.damage
// e.g. Firework's published "penetration 8 (+6/pt), damage 4.9 (+2.1/pt)"
// gives health 4 and damage 0.7, and both per-point gains fall out exactly.

(function () {
  var STATS = function (droneNames) {
    var names = droneNames
      ? ['Movement Speed', 'Reload', 'Drone Damage', 'Drone Health', 'Drone Speed', 'Body Damage', 'Max Health', 'Health Regen']
      : ['Movement Speed', 'Reload', 'Bullet Damage', 'Bullet Penetration', 'Bullet Speed', 'Body Damage', 'Max Health', 'Health Regen'];
    return names.map(function (n) { return { name: n, max: 7 }; });
  };

  var BODY = {
    flags: { invisibility: false, zoomAbility: false, canClaimSquares: false, devOnly: false },
    visibilityRateShooting: 0.23, visibilityRateMoving: 0.08, invisibilityRate: 0.03,
    fieldFactor: 1, absorbtionFactor: 1, speed: 1, maxHealth: 50,
    preAddon: null, postAddon: null, sides: 1, borderWidth: 15
  };

  function tank(o) {
    var t = {};
    for (var k in BODY) t[k] = BODY[k];
    t.flags = { invisibility: false, zoomAbility: false, canClaimSquares: false, devOnly: false };
    for (k in o) t[k] = o[k];
    t.stats = t.stats || STATS(false);
    t.upgrades = t.upgrades || [];
    t.upgradeMessage = t.upgradeMessage || '';
    return t;
  }

  // Shotgun pellet: published penetration 1.2 (+0.9/pt), damage 3.5 (+1.5/pt).
  function pellet(extra) {
    var b = { type: 'bullet', sizeRatio: 0.55, health: 0.6, damage: 0.5, speed: 1, scatterRate: 9, lifeLength: 0.55, absorbtionFactor: 1 };
    for (var k in (extra || {})) b[k] = extra[k];
    return b;
  }

  function shotgunBarrel(o) {
    return {
      angle: o.angle || 0, offset: o.offset || 0, size: o.size, width: o.width,
      delay: 0, reload: 4, recoil: o.recoil, isTrapezoid: true, trapezoidDirection: 0,
      addon: null, pellets: o.pellets, bullet: pellet(o.bullet)
    };
  }

  var EXTRA = [
    // --- Tier 3 -----------------------------------------------------------
    // Shotgun: a Machine Gun barrel overlapped by a shorter, wider one, throwing
    // 12 pellets per trigger pull. barrel.reload 4 reproduces the published
    // 60-tick reload and its whole 60 -> 32 upgrade curve.
    tank({
      id: 63, name: 'Shotgun', levelRequirement: 30, upgrades: [61, 62, 66],
      upgradeMessage: 'Point-blank is the only blank',
      barrels: [
        shotgunBarrel({ size: 95, width: 42, recoil: 2.5, pellets: 6 }),
        shotgunBarrel({ size: 70, width: 68, recoil: 2.5, pellets: 6 })
      ]
    }),

    // --- Tier 4 -----------------------------------------------------------
    // Dual-Barrel: two Shotgun mouths, 12 pellets each.
    tank({
      id: 61, name: 'Dual-Barrel', levelRequirement: 45,
      barrels: [
        shotgunBarrel({ offset: -26, size: 90, width: 40, recoil: 2, pellets: 12 }),
        shotgunBarrel({ offset: 26, size: 90, width: 40, recoil: 2, pellets: 12 })
      ]
    }),

    // Pellet Shot: 30 pellets in a single blast.
    tank({
      id: 62, name: 'Pellet Shot', levelRequirement: 45,
      barrels: [
        shotgunBarrel({ size: 85, width: 50, recoil: 3, pellets: 15, bullet: { sizeRatio: 0.45, scatterRate: 12 } }),
        shotgunBarrel({ size: 65, width: 78, recoil: 3, pellets: 15, bullet: { sizeRatio: 0.45, scatterRate: 12 } })
      ]
    }),

    // Auto Shotgun: the ONE tank here that is designed rather than reconstructed.
    // The spec says a third Shotgun-branch tank exists but never names it and gives
    // no stats, geometry or id — there is nothing to solve against. So this follows
    // diep's own Auto-X convention instead of inventing freely: in the shipped data
    // Auto Gunner, Auto Trapper and Auto Smasher are each their base tank's barrels
    // *unchanged* plus a turret. Auto Shotgun is Shotgun under exactly that rule.
    // Id 66 sits past the highest real id (65) so it cannot collide if the canonical
    // table is ever updated. Delete this entry if the real tank is ever documented.
    tank({
      id: 66, name: 'Auto Shotgun', levelRequirement: 45, postAddon: 'autoturret',
      upgradeMessage: 'Covering fire while you close the distance',
      barrels: [
        shotgunBarrel({ size: 95, width: 42, recoil: 2.5, pellets: 6 }),
        shotgunBarrel({ size: 70, width: 68, recoil: 2.5, pellets: 6 })
      ]
    }),

    // Glider: Destroyer-class launcher throwing missiles with two rear barrels
    // 35 degrees apart. Those barrels' recoil is what drives the missile.
    tank({
      id: 64, name: 'Glider', levelRequirement: 45, preAddon: 'launcher',
      barrels: [{
        angle: 0, offset: 0, size: 80, width: 71.4, delay: 0, reload: 4, recoil: 3,
        isTrapezoid: false, trapezoidDirection: 0, addon: null,
        bullet: { type: 'glider', sizeRatio: 1, health: 3, damage: 1, speed: 0.5, scatterRate: 1, lifeLength: 1.3, absorbtionFactor: 1 }
      }]
    }),

    // Firework: a hexagonal shell that bursts into 16 shards on right-click or
    // when its fuse runs out. Published penetration 8 (+6/pt), damage 4.9 (+2.1/pt).
    tank({
      id: 65, name: 'Firework', levelRequirement: 45,
      barrels: [{
        angle: 0, offset: 0, size: 90, width: 60, delay: 0, reload: 4, recoil: 6,
        isTrapezoid: false, trapezoidDirection: 0, addon: null,
        bullet: { type: 'firework', sizeRatio: 1, health: 4, damage: 0.7, speed: 0.8, scatterRate: 1, lifeLength: 1, absorbtionFactor: 0.4 }
      }]
    }),

    // Auto Tank: the basic Tank with a free-rotating turret. The published turret
    // figures (penetration 2 +1.5/pt, damage 2.1 +0.9/pt, speed 1.2x) are exactly
    // the standard auto-turret bullet the engine already uses.
    tank({
      id: 59, name: 'Auto Tank', levelRequirement: 45, postAddon: 'autoturret',
      barrels: [{
        angle: 0, offset: 0, size: 95, width: 42, delay: 0, reload: 1, recoil: 1,
        isTrapezoid: false, trapezoidDirection: 0, addon: null,
        bullet: { type: 'bullet', sizeRatio: 1, health: 1, damage: 1, speed: 1, scatterRate: 1, lifeLength: 1, absorbtionFactor: 1 }
      }]
    })
  ];

  for (var i = 0; i < EXTRA.length; i++) TANK_DEFS[EXTRA[i].id] = EXTRA[i];

  // Wire the new branches into the tree.
  function link(parentId, childIds) {
    var p = TANK_DEFS[parentId];
    if (!p) return;
    for (var j = 0; j < childIds.length; j++)
      if (p.upgrades.indexOf(childIds[j]) === -1) p.upgrades.push(childIds[j]);
  }
  link(7, [63]);       // Machine Gun -> Shotgun
  link(10, [64, 65]);  // Destroyer   -> Glider, Firework
  link(0, [59]);       // skip both upgrades and the basic Tank offers Auto Tank at 45

  // Mothership. The dump's 10.5-wide barrels and 140 border draw it as a
  // thin-spoked sunburst; the ship is 16 stubby plates ringing a 16-gon hull.
  // 18 leaves a clear gap between plates (21, the 8-barrel Dominator's width
  // at the same size 60, has them almost touching). The border is quoted doubled
  // (see setTank), so 4.5 is a hairline once its x4 scale is on it.
  var ms = TANK_DEFS[27];
  ms.borderWidth = 4.5;
  for (var b = 0; b < ms.barrels.length; b++) ms.barrels[b].width = 18;

  // =====================================================================
  // Everything a player can never upgrade into: the bosses, the event
  // bosses, and the two odd tanks that only exist in diep's own code.
  //
  // Nothing below is linked into the upgrade tree except Mega Smasher (which
  // diep really did re-add as a Smasher upgrade), so normal play cannot reach
  // them and bots never offer them — /class is the only door, exactly as in
  // diep, where these are dev-spawn or AI-only. The two that diep gives real
  // ids to keep them (53 Ball, 84 Mega Smasher); the bosses, which have none,
  // start at 100, well past anything a refresh of the dump could add.
  //
  // SIZE. This engine draws a polygon body at baseSize * sqrt(2), so a boss's
  // published radius goes in as baseSizeOverride = radius / sqrt(2). That also
  // lands the barrel/body proportion exactly: both sides of that ratio carry
  // the same scaleFactor, so it cancels and only baseSize decides it — which
  // is the same arithmetic diep's own sizeFactor does. A player still grows 1%
  // per level on top, so the class is boss-sized at level 1 and 1.55x at 45.
  // The round-bodied bosses (the Fallen pair) need no override at all: they are
  // an Overlord and a Booster, and in diep their bulk is simply level 75.
  //
  // COLOUR. def.color is [fill, stroke] and beats the team palette in
  // paintTeam(), so a Guardian is Crasher pink on every team, like the AI one.
  //
  // The five live bosses take their geometry straight off BOSSES in data.js
  // rather than being re-typed, so /boss guardian and /class guardian are the
  // same tank. What they do NOT take is the boss health pool: these are player
  // classes and level their 50 HP normally.

  function bossOf(name) {
    for (var i = 0; i < BOSSES.length; i++) if (BOSSES[i].name === name) return BOSSES[i];
    throw new Error('no boss named ' + name);
  }
  // Barrels off a boss spec, or off a plain class, with per-barrel overrides.
  function copyBarrels(defs, over) {
    return defs.map(function (b) {
      var c = JSON.parse(JSON.stringify(b));
      for (var k in (over || {})) {
        if (k === 'bullet') { for (var j in over.bullet) c.bullet[j] = over.bullet[j]; }
        else c[k] = over[k];
      }
      return c;
    });
  }
  function smasherStats() {
    var max = [10, 0, 0, 0, 0, 10, 10, 10];
    return STATS(false).map(function (s, i) { return { name: s.name, max: max[i] }; });
  }

  var guardian = bossOf('Guardian of the Pentagons');
  var fallenOverlord = bossOf('Fallen Overlord');
  var fallenBooster = bossOf('Fallen Booster');

  var SPECIAL = [
    // --- the two tanks that only exist inside diep's own code --------------
    // Id 53 is diep's fallback tank: a bare circle with no weapons, worn for a
    // frame mid-upgrade and used as the shell you drive a Dominator with. It is
    // nameless in the dump (the wiki page title is a zero-width space); "Ball"
    // is what everyone calls it, and a class with no name is a class /class
    // cannot find. diep flags it devTank so Sandbox cannot wear it; here it is
    // left listable, since /class is already gated on cheats.
    tank({ id: 53, name: 'Ball', levelRequirement: 0, barrels: [] }),

    // Mega Smasher: removed 7th August 2016 when knockback reduction went to the
    // whole Smasher branch, re-added at the 10th anniversary as a Smasher
    // upgrade at 45 — with the extra reduction kept. Its old id was 37 (still
    // null in the dump); 84 is the id it came back under. The wiki puts its hull
    // at 1.13x a Smasher's, which is the megasmasher addon's 1.15 * 1.13.
    // absorbtionFactor is the only knockback knob this engine has and diep has
    // never published a figure for it, so 0.5 is a plain "half of everyone
    // else's" — the direction is right, the number is a guess.
    tank({
      id: 84, name: 'Mega Smasher', levelRequirement: 45,
      postAddon: 'megasmasher', fieldFactor: 0.9, absorbtionFactor: 0.5,
      upgradeMessage: 'Nothing moves you now', stats: smasherStats(), barrels: []
    }),

    // --- the five live bosses ---------------------------------------------
    tank({
      id: 100, name: 'Guardian of the Pentagons', levelRequirement: 45,
      sides: 3, baseSizeOverride: 135 * Math.SQRT1_2, color: [C.crasher, C.crasherS],
      upgradeMessage: 'The Nest is yours to keep',
      stats: STATS(true), barrels: bossBarrels(guardian)
    }),
    tank({
      id: 101, name: 'Summoner', levelRequirement: 45,
      sides: 4, baseSizeOverride: 150 * Math.SQRT1_2, color: [C.square, C.squareS],
      stats: STATS(true), barrels: bossBarrels(bossOf('Summoner'))
    }),
    // The trap launchers carry forceFire, so a Defender lays traps whether or
    // not you hold the trigger — that is the boss's own behaviour, kept. Its
    // three turrets ride the standard auto3 ring (0.8 * size); the real boss
    // mounts them slightly tighter, at 60 units on a 106-unit body.
    tank({
      id: 102, name: 'Defender', levelRequirement: 45,
      sides: 3, baseSizeOverride: 150 * Math.SQRT1_2, color: [C.triangle, C.triangleS],
      postAddon: 'auto3', barrels: bossBarrels(bossOf('Defender'))
    }),
    tank({
      id: 103, name: 'Fallen Overlord', levelRequirement: 45,
      color: [C.fallen, C.fallenS], fieldFactor: 0.9,
      stats: STATS(true), barrels: bossBarrels(fallenOverlord)
    }),
    tank({
      id: 104, name: 'Fallen Booster', levelRequirement: 45,
      color: [C.fallen, C.fallenS], barrels: bossBarrels(fallenBooster)
    }),

    // --- event bosses ------------------------------------------------------
    // These four ran for one event each and the wiki lists their stats as TBA,
    // so shape, colour and weapon counts come off the official renders and the
    // page text; the numbers are the ordinary boss ones. Marked here rather
    // than silently invented.

    // Tree-Topper, 2025 Christmas event: a yellow star, five deployers at the
    // vertices and five mounted turrets. 5,000 HP, 50,000 XP as a boss.
    // Radius is not published — 175 sits it between a Defender and an Alpha
    // Pentagon, which is where the screenshots put it.
    tank({
      id: 105, name: 'Tree-Topper', levelRequirement: 45,
      sides: 5, isStar: true, starPoints: 5,
      baseSizeOverride: 175 * Math.SQRT1_2, color: [C.square, C.squareS],
      postAddon: 'auto5',
      // Deployers sit in the notches between the points, where the star's edge
      // is only 0.55 of its radius out; the turrets have the points themselves
      // (auto5 rings them at i/5 of a turn, which is exactly where they are).
      barrels: [0, 1, 2, 3, 4].map(function (i) {
        return {
          angle: 2 * Math.PI * (i / 5 + 1 / 10), offset: 0, size: 120, width: 65, delay: 0,
          reload: 4, recoil: 1, isTrapezoid: true, trapezoidDirection: 0, addon: null,
          bullet: { type: 'skimmer', sizeRatio: 1, health: 3, damage: 0.7, speed: 0.7, scatterRate: 1, lifeLength: 1.3, absorbtionFactor: 1 }
        };
      })
    }),

    // Decade, 2026 Happy Birthdiep event: a decagon in the green of a shiny
    // polygon (the wiki calls body, drones and their ammunition all identical
    // to green polygons), spawners on five of its ten faces and a Triple Shot
    // mounted turret on top. 10,000 HP, 100,000 XP, ten level-1-30 minions.
    // The radius is read off the official render against the minions beside it:
    // ~3.9x a level-30 tank, so about 210.
    tank({
      id: 106, name: 'Decade', levelRequirement: 45,
      sides: 10, baseSizeOverride: 210 * Math.SQRT1_2, color: [C.shiny, C.shinyS],
      postAddon: 'tripleturret', stats: STATS(true),
      barrels: [0, 1, 2, 3, 4].map(function (i) {
        return {
          angle: 2 * Math.PI * ((2 * i + 0.5) / 10), offset: 0, size: 225, width: 75, delay: 0,
          reload: 3, recoil: 0, isTrapezoid: true, trapezoidDirection: 0, addon: null,
          droneCount: 2, canControlDrones: true,
          bullet: { type: 'minion', sizeRatio: 1, health: 4, damage: 0.7, speed: 0.56, scatterRate: 1, lifeLength: -1, absorbtionFactor: 1, color: C.shiny, stroke: C.shinyS }
        };
      })
    }),

    // --- 16th April 2024, diep's 8th anniversary ---------------------------
    // Five re-cut bosses that ran for the day. Each is its ordinary self plus
    // the weapon the wiki names, so they are built from the live boss's barrels
    // rather than from scratch.

    // Guardian: the Crasher spawner stays, a larger one behind it throws five
    // Minions, each of which is a small Guardian of its own.
    tank({
      id: 107, name: 'Guardian (8th Anniversary)', levelRequirement: 45,
      sides: 3, baseSizeOverride: 135 * Math.SQRT1_2, color: [C.crasher, C.crasherS],
      stats: STATS(true),
      // The Crasher spawner keeps its width (that width is what sizes a Crasher)
      // and only reaches further out; the Minion one is the wide, short plate
      // sitting over it, which is the silhouette the official render shows.
      barrels: copyBarrels(bossBarrels(guardian), { size: 145 }).concat([{
        angle: Math.PI, offset: 0, size: 100, width: 130, delay: 0, reload: 3, recoil: 1,
        isTrapezoid: true, trapezoidDirection: 0, addon: null, droneCount: 5, canControlDrones: false,
        bullet: { type: 'minion', sizeRatio: 1, health: 4, damage: 0.7, speed: 0.56, scatterRate: 1, lifeLength: -1, absorbtionFactor: 1, color: C.crasher, stroke: C.crasherS }
      }])
    }),

    // Summoner: an octagon about the size of a Dominator (160), eight spawners
    // instead of four, and drones at double the regular Summoner's rate.
    tank({
      id: 108, name: 'Summoner (8th Anniversary)', levelRequirement: 45,
      sides: 8, baseSizeOverride: 160 * Math.SQRT1_2, color: [C.square, C.squareS],
      stats: STATS(true),
      barrels: [0, 1, 2, 3, 4, 5, 6, 7].map(function (i) {
        // + 1/16 for the same reason the plain Summoner carries + 1/8: faces, not corners.
        return copyBarrels(bossBarrels(bossOf('Summoner')), { angle: 2 * Math.PI * (i / 8 + 1 / 16), size: 175, reload: 0.18 })[0];
      })
    }),

    // Defender: the three trap launchers and three turrets, plus three spawners
    // that each overlap a launcher. (Its drones are little trap-laying triangles
    // in diep; this engine's minions are round and carry one gun.)
    tank({
      id: 109, name: 'Defender (8th Anniversary)', levelRequirement: 45,
      sides: 3, baseSizeOverride: 150 * Math.SQRT1_2, color: [C.triangle, C.triangleS],
      postAddon: 'auto3',
      barrels: bossBarrels(bossOf('Defender')).concat([0, 1, 2].map(function (i) {
        return {
          angle: 2 * Math.PI * (i / 3 + 1 / 6), offset: 0, size: 95, width: 100, delay: 0,
          reload: 4, recoil: 0, isTrapezoid: true, trapezoidDirection: 0, addon: null,
          droneCount: 2, canControlDrones: false,
          bullet: { type: 'minion', sizeRatio: 1, health: 4, damage: 0.7, speed: 0.56, scatterRate: 1, lifeLength: -1, absorbtionFactor: 1, color: C.square, stroke: C.squareS }
        };
      }))
    }),

    // Fallen Overlord: the same grey Overlord with a Mounted Turret on top and
    // seven drones per spawner instead of the boss's three — 28 out at once.
    tank({
      id: 110, name: 'Fallen Overlord (8th Anniversary)', levelRequirement: 45,
      color: [C.fallen, C.fallenS], fieldFactor: 0.9, postAddon: 'autoturret',
      stats: STATS(true),
      barrels: copyBarrels(bossBarrels(fallenOverlord), { droneCount: 7 })
    }),

    // Fallen Booster: the regular one plus two side cannons, which is exactly
    // Booster crossed with Fighter. The wiki's clockwise gaps from the front
    // cannon — 90, 45, 15, 60, 15, 45, 90 — put the seven at 0, 90, 135, 150,
    // 210, 225 and 270 degrees, and Booster already owns five of those.
    tank({
      id: 111, name: 'Fallen Booster (8th Anniversary)', levelRequirement: 45,
      color: [C.fallen, C.fallenS],
      barrels: bossBarrels(fallenBooster).concat(
        copyBarrels(bossBarrels({ tankId: 24, sides: 1 }).slice(1, 3), {}))   // Fighter's +/-90 pair
    })
  ];

  for (i = 0; i < SPECIAL.length; i++) TANK_DEFS[SPECIAL[i].id] = SPECIAL[i];
  link(36, [84]);      // Smasher -> Mega Smasher, the one entry here that is a real upgrade
})();
