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
})();
