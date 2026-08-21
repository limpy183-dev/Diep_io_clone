// modes.js — the five objective game modes.
//
// Each entry gets init(g) once, tick(g) every frame, and optionally
// onTankDeath / reset. Loaded after engine.js; Game looks the table up by name.
// Entities a mode creates are tagged .modeEntity so a round reset can sweep them.

function teamLabel(team) { return team ? team.charAt(0).toUpperCase() + team.slice(1) : 'nobody'; }

function paintTeamColors(e, team) {
  if (team && TEAM_COLORS[team]) { e.fill = TEAM_COLORS[team][0]; e.stroke = TEAM_COLORS[team][1]; }
  else { e.fill = C.neutral; e.stroke = C.neutralS; }
}

function winRound(g, text) {
  if (g.roundEndsAt) return;
  g.notify(text, ROUND_END_DELAY);
  g.roundEndsAt = g.tick + ROUND_END_DELAY;
}

// Sweep everything a mode built, so init() can run again cleanly.
function clearModeEntities(g) {
  for (var i = 0; i < g.entities.length; i++) {
    var e = g.entities[i];
    if (e.modeEntity) { e.dead = true; e.deathFrame = 0; }
  }
  g.entities = g.entities.filter(function (e) { return !e.modeEntity; });
  g.dominators = null; g.tiles = null; g.flags = null; g.motherships = null;
  g.mapDirty = true;
}

// --- possession (H) ------------------------------------------------------
// Piloting parks your own tank rather than destroying it, so you keep your
// score and get it back when you step out.
function possess(g, tank, target) {
  if (!tank || tank.dead || !target || target.dead) return false;
  if (target.possessedBy || tank.possessing) return false;
  if (target.team === null || target.team !== tank.team) return false;
  tank.possessing = target;
  target.possessedBy = tank;
  tank.parked = true;
  tank.sides = 0;                       // no collider, and never serialised to other clients
  tank.input.up = tank.input.down = tank.input.left = tank.input.right = 0;
  tank.input.fire = tank.input.altFire = 0;
  return true;
}

function release(g, tank) {
  var target = tank && tank.possessing;
  if (!target) return false;
  target.possessedBy = null;
  target.input.fire = 0;
  tank.possessing = null;
  tank.parked = false;
  tank.sides = tank.def.sides;
  tank.x = target.x + rand(-target.size, target.size);
  tank.y = target.y + target.size * 2.2;
  tank.vx = tank.vy = 0;
  return true;
}

// Called when a possessable dies or changes hands.
function ejectPilot(g, target) {
  if (target.possessedBy) release(g, target.possessedBy);
}

// --- shared: a stationary or slow AI gun platform -------------------------
function tickPlatformAI(g, t, range) {
  if (t.possessedBy) return;            // a player is driving
  if (g.tick % 5 === t.id % 5) t.aiTarget = g.findTarget(t, range, true);
  var tgt = t.aiTarget;
  if (tgt && !tgt.dead) {
    var aim = predictAim(t, tgt, 20 + BSPEED_GAIN * t.stats[S_BSPEED]);
    t.mouse.x = t.x + Math.cos(aim) * 500;
    t.mouse.y = t.y + Math.sin(aim) * 500;
    t.input.fire = 1;
  } else {
    t.input.fire = 0;
    t.aiSweep = (t.aiSweep || 0) + PASSIVE_ROTATION;
    t.mouse.x = t.x + Math.cos(t.aiSweep) * 500;
    t.mouse.y = t.y + Math.sin(t.aiSweep) * 500;
  }
}

// A tank that never levels: neutering addScore stops recompute() from
// clobbering the overridden body damage and speed every time it kills something.
function lockTank(t) {
  t.addScore = function () {};
  t.scoreReward = 0;
}

// --- Domination ----------------------------------------------------------
function makeDominator(g, x, y) {
  var t = new Tank(g, { x: x, y: y, team: null, name: 'Dominator', tankId: pick(DOMINATOR.ids) });
  t.level = DOMINATOR.level;
  t.baseSize = DOMINATOR.size / Math.pow(1.01, DOMINATOR.level - 1);
  t.recompute();
  t.health = t.maxHealth;
  t.damagePerTick = DOMINATOR.damage;
  t.absorb = 0;                          // immovable: the "100% knockback resistance"
  t.push = 20;
  t.immobile = true;
  t.isDominator = true;
  t.modeEntity = true;
  t.protectedUntil = 0;
  t.minDmg = 1; t.maxDmg = 6;
  lockTank(t);
  paintTeamColors(t, null);
  t.onKill = function (source) { captureDominator(g, t, source); };
  return g.add(t);
}

function captureDominator(g, dom, source) {
  var root = source; while (root && root.owner) root = root.owner;
  var team = root && root.type === 'tank' && root.team ? root.team : null;

  // Dominators never actually die: they revive on the spot under new ownership.
  dom.dead = false; dom.deathFrame = 0; dom.opacity = 1;
  dom.health = dom.maxHealth;
  for (var i = 0; i < g.entities.length; i++) if (g.entities[i].owner === dom) g.entities[i].kill(null);
  ejectPilot(g, dom);

  if (dom.team === null && team) {
    dom.team = team;
    paintTeamColors(dom, team);
    g.notify('The Dominator is now controlled by ' + teamLabel(team) + '!', DOMINATOR.captureMsg);
  } else {
    dom.team = null;
    paintTeamColors(dom, null);
    g.notify('The Dominator is being contested', DOMINATOR.captureMsg);
  }
  g.mapDirty = true;
}

// --- what the bots are supposed to be doing -------------------------------
// Every mode below gets an optional botGoal(g, t): the thing this bot should be
// working on that is not a Square. Without it the whole population played FFA in
// an objective arena — a Dominator is level 75 and a Mothership 140, so botScan's
// punching-up cull dropped both on sight, and nothing anywhere read g.flags or
// g.tiles. Four modes that no bot could win except by walking into a flag.
//
// Big objectives are for grown tanks: a level 6 bot charging a Dominator is a
// donation, and its own levelling is what makes it useful ten levels later.
function botGrown(t, lvl) { return t.level >= lvl && t.health > t.maxHealth * 0.55; }

// Nearest of a list, by whatever test the mode cares about.
function botNearest(t, list, ok) {
  var best = null, bd = Infinity;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!ok(e)) continue;
    var d = dist2(t, e);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// A place to stand rather than a thing to shoot. vx/vy so botAim can lead it
// like anything else instead of aiming at NaN.
function botSpot(e, hard) { return { x: e.x, y: e.y, vx: 0, vy: 0, touch: true, hard: !!hard }; }

var MODE_LOGIC = {};

MODE_LOGIC.domination = {
  init: function (g) {
    g.dominators = DOMINATOR.spots.map(function (p) { return makeDominator(g, p[0], p[1]); });
    g.mapDirty = true;
  },
  tick: function (g) {
    for (var i = 0; i < g.dominators.length; i++) tickPlatformAI(g, g.dominators[i], 2200);
    if (g.roundEndsAt) return;
    var owner = g.dominators[0].team;
    if (!owner) return;
    for (i = 1; i < g.dominators.length; i++) if (g.dominators[i].team !== owner) return;
    winRound(g, teamLabel(owner) + ' controls every Dominator — ' + teamLabel(owner) + ' wins!');
  },
  reset: function (g) { clearModeEntities(g); MODE_LOGIC.domination.init(g); },
  // Take whichever Dominator is not already ours. It shoots back hard, so this
  // is deliberately a grown-tank job.
  botGoal: function (g, t) {
    if (!g.dominators || !t.team || !botGrown(t, 20)) return null;
    var d = botNearest(t, g.dominators, function (e) { return !e.dead && e.team !== t.team; });
    return d ? { e: d } : null;
  }
};

// --- Tag -----------------------------------------------------------------
MODE_LOGIC.tag = {
  init: function (g) { g.nextShrink = TAG.shrinkInterval; },
  onTankDeath: function (g, victim, killer) {
    var root = killer; while (root && root.owner) root = root.owner;
    // Dying to a player moves you onto their team; dying to a shape does not.
    if (root && root.type === 'tank' && root.team && root.team !== victim.team) victim.nextTeam = root.team;
  },
  tick: function (g) {
    if (--g.nextShrink <= 0) {
      g.nextShrink = TAG.shrinkInterval;
      var a = g.arena, d = TAG.shrinkAmount;
      if (a.right - a.left > 4000) {
        a.left += d; a.right -= d; a.top += d; a.bottom -= d;
        a.size = a.right - a.left;
      }
    }
    var counts = {}, alive = 0, i, e;
    for (i = 0; i < g.teams.length; i++) counts[g.teams[i]] = 0;
    for (i = 0; i < g.entities.length; i++) {
      e = g.entities[i];
      if (e.type !== 'tank' || e.dead || e.parked) continue;
      // Invisibility is only partial here, so nobody can stall the round out.
      if (e.invisible && e.opacity < TAG.minOpacity) e.opacity = TAG.minOpacity;
      if (counts[e.team] !== undefined) { counts[e.team]++; alive++; }
    }
    g.teamCounts = counts;
    if (g.roundEndsAt || alive < 2) return;
    for (i = 0; i < g.teams.length; i++) {
      if (counts[g.teams[i]] === alive) {
        winRound(g, teamLabel(g.teams[i]) + ' has tagged everyone — ' + teamLabel(g.teams[i]) + ' wins!');
        return;
      }
    }
  },
  reset: function (g) {
    var h = GAMEMODES.tag.size / 2;
    g.arena.left = -h; g.arena.right = h; g.arena.top = -h; g.arena.bottom = h; g.arena.size = h * 2;
    g.nextShrink = TAG.shrinkInterval;
  }
};

// --- Mothership ----------------------------------------------------------
function makeMothership(g, team, x, y) {
  var t = new Tank(g, { x: x, y: y, team: team, name: teamLabel(team) + ' Mothership', tankId: MOTHERSHIP.id });
  t.level = MOTHERSHIP.level;
  t.stats = [7, 7, 7, 7, 7, 7, 7, 0];    // everything maxed except Health Regen
  t.recompute();
  t.maxHealth = MOTHERSHIP.maxHealth;
  t.health = t.maxHealth;
  t.absorb = 0;                          // ~100% knockback resistance
  t.push = 24;
  t.damagePerTick = 20;
  t.modeEntity = true;
  t.isMothership = true;
  t.protectedUntil = 0;
  t.minDmg = 1; t.maxDmg = 6;
  lockTank(t);
  paintTeamColors(t, team);
  return g.add(t);
}

MODE_LOGIC.mothership = {
  init: function (g) {
    var a = g.arena;
    g.motherships = [
      makeMothership(g, g.teams[0], a.left * 0.62, 0),
      makeMothership(g, g.teams[1], a.right * 0.62, 0)
    ];
    g.nextPilotSwap = MOTHERSHIP.pilotRotation;
    g.mapDirty = true;
  },
  tick: function (g) {
    var i, ms;
    for (i = 0; i < g.motherships.length; i++) {
      ms = g.motherships[i];
      if (!ms.dead) tickPlatformAI(g, ms, 3000);
    }
    if (--g.nextPilotSwap <= 0) {
      g.nextPilotSwap = MOTHERSHIP.pilotRotation;
      for (i = 0; i < g.motherships.length; i++) rotatePilot(g, g.motherships[i]);
    }
    // motherships move, so refresh their minimap marker once a second
    if (g.tick % TPS === 0) g.mapDirty = true;
    g.teamCounts = {};
    for (i = 0; i < g.motherships.length; i++) {
      ms = g.motherships[i];
      g.teamCounts[ms.team] = ms.dead ? 0 : Math.round((ms.health / ms.maxHealth) * 100);
    }
    if (g.roundEndsAt) return;
    for (i = 0; i < g.motherships.length; i++) {
      ms = g.motherships[i];
      if (!ms.dead) continue;
      var winner = g.teams[i === 0 ? 1 : 0];
      winRound(g, 'The ' + teamLabel(ms.team) + ' Mothership has fallen — ' + teamLabel(winner) + ' wins!');
      return;
    }
  },
  reset: function (g) { clearModeEntities(g); MODE_LOGIC.mothership.init(g); },
  // Killing theirs is the entire win condition, and no bot had ever shot at one.
  botGoal: function (g, t) {
    if (!g.motherships || !t.team || !botGrown(t, 20)) return null;
    var ms = botNearest(t, g.motherships, function (e) { return !e.dead && e.team !== t.team; });
    return ms ? { e: ms } : null;
  }
};

// Hand the wheel to the highest-scoring living player on that team.
function rotatePilot(g, ms) {
  if (ms.dead) return;
  var best = null;
  for (var i = 0; i < g.entities.length; i++) {
    var e = g.entities[i];
    if (e.type !== 'tank' || e.dead || e.parked || e === ms) continue;
    if (e.team !== ms.team || !e.isPlayer) continue;
    if (e.possessing) continue;
    if (!best || e.score > best.score) best = e;
  }
  if (!best) return;
  if (ms.possessedBy === best) return;
  ejectPilot(g, ms);
  if (possess(g, best, ms)) best.notify('You are piloting the Mothership — press H to step out', 120);
}

// --- Breakout ------------------------------------------------------------
MODE_LOGIC.breakout = {
  init: function (g) {
    var a = g.arena;
    var tw = a.size / BREAKOUT.cols / 2, th = a.size / BREAKOUT.rows / 2;
    g.tiles = [];
    for (var c = 0; c < BREAKOUT.cols; c++) {
      for (var r = 0; r < BREAKOUT.rows; r++) {
        var t = new Entity(g, {
          type: 'tile', sides: 2,
          x: a.left + tw * (2 * c + 1), y: a.top + th * (2 * r + 1),
          size: tw, width: th, team: null, maxHealth: Infinity,
          fill: C.box, stroke: C.boxS
        });
        t.damageReduction = 0; t.push = 0; t.absorb = 0;
        t.hiddenHealthbar = true; t.isBase = true; t.isTile = true; t.modeEntity = true;
        t.col = c; t.row = r;
        // each side starts holding its own edge column
        if (c === 0) claimTile(g, t, g.teams[0]);
        else if (c === BREAKOUT.cols - 1) claimTile(g, t, g.teams[1]);
        g.tiles.push(t);
        g.add(t);
      }
    }
    g.mapDirty = true;
  },
  tick: function (g) {
    if (g.tick % 5 !== 0) return;
    var i, e;
    for (i = 0; i < g.entities.length; i++) {
      e = g.entities[i];
      if (e.type !== 'tank' || e.dead || e.parked || !e.team) continue;
      var tile = tileAt(g, e.x, e.y);
      if (!tile) { e.tileKey = null; e.tileTicks = 0; continue; }
      var key = tile.col + ',' + tile.row;
      if (e.tileKey !== key) { e.tileKey = key; e.tileTicks = 0; }
      e.tileTicks += 5;

      if (tile.team === null) {
        // you can only take ground touching ground you already hold
        if (adjacentToTeam(g, tile, e.team) && e.tileTicks >= BREAKOUT.claimTicks) {
          claimTile(g, tile, e.team);
          e.tileTicks = 0;
        }
      } else if (tile.team === e.team) {
        if (e.tileTicks > BREAKOUT.campWarnTicks && !tile.warning) { tile.warning = true; g.mapDirty = true; }
        if (e.tileTicks > BREAKOUT.campWarnTicks + BREAKOUT.campCollapseTicks) collapseTile(g, tile);
      } else {
        e.tileTicks = 0;
      }
    }
    // a tile with nobody camping it stops flashing
    for (i = 0; i < g.tiles.length; i++) {
      var t2 = g.tiles[i];
      if (!t2.warning) continue;
      if (!anyTankCamping(g, t2)) { t2.warning = false; g.mapDirty = true; }
    }
    // scoreboard shows territory held, as a percentage
    g.teamCounts = {};
    for (i = 0; i < g.teams.length; i++) g.teamCounts[g.teams[i]] = 0;
    for (i = 0; i < g.tiles.length; i++) if (g.tiles[i].team) g.teamCounts[g.tiles[i].team]++;
    for (i = 0; i < g.teams.length; i++)
      g.teamCounts[g.teams[i]] = Math.round(g.teamCounts[g.teams[i]] / g.tiles.length * 100);

    if (g.roundEndsAt) return;
    var owner = g.tiles[0].team, all = true;
    for (i = 0; i < g.tiles.length; i++) if (g.tiles[i].team !== owner) { all = false; break; }
    if (all && owner) winRound(g, teamLabel(owner) + ' holds the whole board — ' + teamLabel(owner) + ' wins!');
  },
  reset: function (g) { clearModeEntities(g); MODE_LOGIC.breakout.init(g); },
  // Ground is taken by standing on it, and only ground touching ground we hold
  // counts — so head for the nearest neutral tile on our own frontier. No level
  // gate worth the name: walking onto a square of floor costs nothing.
  botGoal: function (g, t) {
    if (!g.tiles || !t.team || !botGrown(t, 8)) return null;
    var tile = botNearest(t, g.tiles, function (e) {
      return e.team === null && adjacentToTeam(g, e, t.team);
    });
    return tile ? botSpot(tile) : null;
  }
};

function claimTile(g, tile, team) {
  tile.team = team;
  tile.warning = false;
  paintTeamColors(tile, team);
  g.mapDirty = true;
}

function collapseTile(g, tile) {
  for (var i = 0; i < g.entities.length; i++) {
    var e = g.entities[i];
    if (e.type !== 'tank' || e.dead) continue;
    if (Math.abs(e.x - tile.x) <= tile.size && Math.abs(e.y - tile.y) <= tile.width) {
      e.tileTicks = 0;
      e.applyDamage(1e9, tile);         // camping collapses the tile under you
    }
  }
  tile.team = null;
  tile.warning = false;
  paintTeamColors(tile, null);
  tile.fill = C.box; tile.stroke = C.boxS;
  g.mapDirty = true;
}

function anyTankCamping(g, tile) {
  for (var i = 0; i < g.entities.length; i++) {
    var e = g.entities[i];
    if (e.type !== 'tank' || e.dead) continue;
    if (e.tileKey === tile.col + ',' + tile.row && e.tileTicks > BREAKOUT.campWarnTicks) return true;
  }
  return false;
}

function tileAt(g, x, y) {
  var a = g.arena;
  var tw = a.size / BREAKOUT.cols, th = a.size / BREAKOUT.rows;
  var c = Math.floor((x - a.left) / tw), r = Math.floor((y - a.top) / th);
  if (c < 0 || r < 0 || c >= BREAKOUT.cols || r >= BREAKOUT.rows) return null;
  return g.tiles[c * BREAKOUT.rows + r];
}

function adjacentToTeam(g, tile, team) {
  var d = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (var i = 0; i < 4; i++) {
    var c = tile.col + d[i][0], r = tile.row + d[i][1];
    if (c < 0 || r < 0 || c >= BREAKOUT.cols || r >= BREAKOUT.rows) continue;
    if (g.tiles[c * BREAKOUT.rows + r].team === team) return true;
  }
  return false;
}

// --- Capture the Flag ----------------------------------------------------
MODE_LOGIC.ctf = {
  init: function (g) {
    var a = g.arena;
    g.flags = [];
    g.captures = {};
    g.teams.forEach(function (team, side) {
      g.captures[team] = 0;
      var baseX = side === 0 ? a.left + 2600 : a.right - 2600;
      for (var i = 0; i < CTF.perSide; i++) {
        var f = new Entity(g, {
          type: 'flag', sides: 5, size: CTF.flagSize,
          x: baseX, y: a.top + (a.size / (CTF.perSide + 1)) * (i + 1),
          team: team, maxHealth: Infinity
        });
        f.damageReduction = 0; f.push = 0; f.absorb = 0;
        f.hiddenHealthbar = true; f.modeEntity = true;
        f.homeX = f.x; f.homeY = f.y; f.carrier = null;
        paintTeamColors(f, team);
        g.flags.push(f);
        g.add(f);
      }
    });
    // a barrier splits the map for the first five minutes
    var bar = new Entity(g, {
      type: 'wall', sides: 2, x: 0, y: 0, size: 60, width: a.size / 2,
      fill: C.box, stroke: C.boxS, maxHealth: Infinity, team: null
    });
    bar.isSolidWall = true; bar.damageReduction = 0; bar.push = 1; bar.absorb = 0;
    bar.hiddenHealthbar = true; bar.modeEntity = true;
    g.ctfBarrier = bar;
    g.walls.push(bar);
    g.add(bar);
    g.barrierUntil = g.tick + CTF.barrierTicks;
    g.mapDirty = true;
  },
  tick: function (g) {
    var i, j;
    if (g.ctfBarrier && g.tick >= g.barrierUntil) {
      g.ctfBarrier.kill(null);
      g.walls = g.walls.filter(function (w) { return w !== g.ctfBarrier; });
      g.ctfBarrier = null;
      g.notify('The barrier is down!', 100);
      g.mapDirty = true;
    }

    for (i = 0; i < g.flags.length; i++) {
      var f = g.flags[i];
      if (f.carrier) {
        if (f.carrier.dead || f.carrier.parked) { returnFlag(g, f); continue; }
        f.x = f.carrier.x; f.y = f.carrier.y - f.carrier.size - f.size;
        // home base reached?
        var home = baseOf(g, f.carrier.team);
        if (home && Math.abs(f.carrier.x - home.x) <= home.size && Math.abs(f.carrier.y - home.y) <= home.width) {
          g.captures[f.carrier.team] = (g.captures[f.carrier.team] || 0) + 1;
          g.notify(teamLabel(f.carrier.team) + ' captured a flag (' + g.captures[f.carrier.team] + '/' + CTF.perSide + ')', 60);
          returnFlag(g, f);
        }
        continue;
      }
      // pickup: an enemy tank touching an unheld flag takes it
      for (j = 0; j < g.entities.length; j++) {
        var e = g.entities[j];
        if (e.type !== 'tank' || e.dead || e.parked || !e.team || e.team === f.team) continue;
        var rr = e.size + f.size;
        if ((e.x - f.x) * (e.x - f.x) + (e.y - f.y) * (e.y - f.y) <= rr * rr) {
          f.carrier = e;
          g.notify(teamLabel(e.team) + ' took a ' + teamLabel(f.team) + ' flag!', 60);
          break;
        }
      }
    }

    g.teamCounts = g.captures;          // scoreboard shows captures per team
    if (g.roundEndsAt) return;
    for (i = 0; i < g.teams.length; i++) {
      if ((g.captures[g.teams[i]] || 0) >= CTF.perSide) {
        winRound(g, teamLabel(g.teams[i]) + ' captured every flag — ' + teamLabel(g.teams[i]) + ' wins!');
        return;
      }
    }
  },
  reset: function (g) { clearModeEntities(g); MODE_LOGIC.ctf.init(g); },
  // Carrying one is the one objective that outranks a fight: stopping to trade
  // shots with whoever is chasing is how a flag gets returned. Otherwise walk
  // onto the nearest enemy flag nobody has picked up.
  // ponytail: no defending — nobody guards our own flag or chases their carrier
  // beyond the ordinary target scoring. Add a defender role if it reads passive.
  botGoal: function (g, t) {
    if (!g.flags || !t.team) return null;
    for (var i = 0; i < g.flags.length; i++) {
      if (g.flags[i].carrier !== t) continue;
      var home = baseOf(g, t.team);
      return home ? botSpot(home, true) : null;
    }
    if (!botGrown(t, 8)) return null;
    var f = botNearest(t, g.flags, function (e) { return e.team !== t.team && !e.carrier; });
    return f ? botSpot(f) : null;
  }
};

function returnFlag(g, f) {
  f.carrier = null;
  f.x = f.homeX; f.y = f.homeY;
}

function baseOf(g, team) {
  for (var i = 0; i < g.bases.length; i++) if (g.bases[i].team === team) return g.bases[i];
  return null;
}

if (typeof module !== 'undefined') module.exports = { MODE_LOGIC: MODE_LOGIC, possess: possess, release: release };
