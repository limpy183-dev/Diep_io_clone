// engine.js — fixed 25Hz simulation. Everything gameplay lives here; render.js
// only reads. Runs unmodified in Node (see test.mjs).

// ---------------------------------------------------------------- helpers
function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function sign() { return Math.random() < 0.5 ? -1 : 1; }
function angleDiff(a, b) { var d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
function dist2(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

var NEXT_ID = 1;

// ---------------------------------------------------------------- entity
// One class, tagged by `type`. A hierarchy here buys nothing: every entity
// shares position/physics/health and differs only in its tick().
function Entity(game, o) {
  this.id = NEXT_ID++;
  this.game = game;
  this.type = o.type;
  this.x = o.x || 0; this.y = o.y || 0;
  this.vx = 0; this.vy = 0;
  this.angle = o.angle || 0;
  this.size = o.size || 10;
  this.width = o.width || 0;       // rectangles only
  this.sides = o.sides === undefined ? 1 : o.sides;
  this.team = o.team === undefined ? null : o.team;
  this.owner = o.owner || null;    // root tank for projectiles
  this.fill = o.fill || C.blue;
  this.stroke = o.stroke || C.blueS;
  this.opacity = 1;

  this.maxHealth = o.maxHealth || 1;
  this.health = this.maxHealth;
  this.damagePerTick = o.damage || 0;
  this.damageReduction = 1;
  this.minDmg = o.minDmg === undefined ? 1 : o.minDmg;
  this.maxDmg = o.maxDmg === undefined ? 4 : o.maxDmg;
  this.absorb = o.absorb === undefined ? 1 : o.absorb;
  this.push = o.push === undefined ? 1 : o.push;
  this.scoreReward = o.score || 0;

  this.dead = false;
  this.deathFrame = 0;
  this.lastDamage = -9999;
  this.hurtFlash = 0;
  this.life = o.life || Infinity;   // ticks remaining
  this.age = 0;

  this.noOwnTeamCollision = false;
  this.onlySameOwnerCollision = false;
  this.canEscapeArena = false;
  this.canMoveThroughWalls = false;
  this.isSolidWall = false;
  this.hiddenHealthbar = false;
  this.noDmgIndicator = false;

  // render interpolation
  this.px = this.x; this.py = this.y; this.pa = this.angle; this.psize = this.size;
}

Entity.prototype.addVelocity = function (a, m) { this.vx += Math.cos(a) * m; this.vy += Math.sin(a) * m; };
// Terminal speed under 10% friction is 10x the per-tick acceleration, which is
// what every "maintain speed X" in the game actually means.
Entity.prototype.maintainVelocity = function (a, maxSpeed) { this.addVelocity(a, maxSpeed * 0.1); };

Entity.prototype.applyPhysics = function () {
  var sp = Math.hypot(this.vx, this.vy);
  if (sp < 0.01) { this.vx = 0; this.vy = 0; sp = 0; }
  if (this.dead) { this.vx /= 2; this.vy /= 2; }
  this.x += this.vx; this.y += this.vy;
  // friction: -10% of current velocity. Ice Rink turns this down; nothing else
  // in the base game touches it.
  var fr = this.game.rule('friction', 0.1);
  this.vx -= this.vx * fr; this.vy -= this.vy * fr;

  if (!this.canEscapeArena) {
    var a = this.game.arena, p = ARENA_PADDING;
    if (this.x < a.left - p) this.x = a.left - p;
    if (this.x > a.right + p) this.x = a.right + p;
    if (this.y < a.top - p) this.y = a.top - p;
    if (this.y > a.bottom + p) this.y = a.bottom + p;
  }
};

Entity.prototype.applyDamage = function (dmg, source) {
  if (this.damageReduction === 0) return;
  this.health -= dmg;
  this.lastDamage = this.game.tick;
  // Vampire: every point of damage is the only healing there is. One choke
  // point, so bullets, bodies, drones and traps all feed it the same way.
  var steal = this.game.rule('lifesteal', 0);
  if (steal && source) {
    var v = source; while (v.owner) v = v.owner;
    if (v.type === 'tank' && !v.dead && v !== this)
      v.health = Math.min(v.maxHealth, v.health + dmg * steal * (this.type === 'tank' ? 1 : 0.25));
  }
  // Who is actually fighting us. Reading that off barrel angles is a guess that
  // only holds while they have the trigger down; a bullet landing is not.
  if (source) { var r = source; while (r.owner) r = r.owner; this.lastHitBy = r; }
  if (!this.noDmgIndicator) this.hurtFlash = 4;
  if (this.opacity < 1 && this.invisible) this.opacity = Math.min(1, this.opacity + 0.2);
  // The no-overkill scaling is meant to land the loser exactly on 0, but floats
  // can leave it at +1e-16 and alive. Snap it.
  if (this.health <= 1e-9) { this.health = 0; this.kill(source); }
};

Entity.prototype.kill = function (source) {
  if (this.dead) return;
  this.dead = true;
  this.deathFrame = 5;
  this.health = 0;
  this.opacity = 1 - 1 / 6;
  // A tank pays out a share of what it was carrying; a shape pays its listed
  // reward. The mode multiplier is the arena's *shape* score multiplier — FFA 1x,
  // Mothership 3x — so it has no business scaling a kill.
  // killBounty is a flat payment on top of the share. Without it a mode where
  // shapes pay nothing can never get off zero: everyone starts on 0, a kill
  // hands over a share of 0, and the scoreboard never moves.
  var reward = this.type === 'tank'
    ? this.score * this.game.rule('killShare', KILL_SCORE_SHARE) + this.game.rule('killBounty', 0)
    : this.scoreReward * this.game.mode.xp * this.game.rule('shapeXp', 1);
  if (reward && source) {
    var root = source; while (root.owner) root = root.owner;
    if (root.type === 'tank' && !root.dead && root !== this) root.addScore(reward);
  }
  if (this.onKill) this.onKill(source);
};

// ---------------------------------------------------------------- damage
// No "damage number minus HP". Both sides deal damage simultaneously through a
// pair of multipliers, and neither can overkill.
function handleCollision(a, b) {
  if (a.team !== null && a.team === b.team) return;
  // FFA leaves team === null, so the check above can't catch these two:
  if (a.owner && a.owner === b.owner) return;                // one owner's drones bump, never bite
  if (a.type === 'shape' && b.type === 'shape') return;      // crashers/polygons don't eat each other
  if (a.health <= 0 || b.health <= 0) return;
  if (a.damageReduction === 0 && b.damageReduction === 0) return;
  if ((a.damagePerTick === 0 && a.push === 0) || (b.damagePerTick === 0 && b.push === 0)) return;

  // Instagib multiplies this; Sumo zeroes it. Knockback lives in
  // applyKnockback and is deliberately untouched by either.
  var mult = a.game.rule('dmgMult', 1);
  var common = Math.max(a.minDmg, b.minDmg) * Math.min(a.maxDmg, b.maxDmg) * mult;
  var dAB = a.damagePerTick * common * b.damageReduction;
  var dBA = b.damagePerTick * common * a.damageReduction;

  var ratio = Math.max(dBA > 0 ? 1 - a.health / dBA : -Infinity, dAB > 0 ? 1 - b.health / dAB : -Infinity);
  var scale = Math.min(1, 1 - ratio);
  if (dAB > 0) b.applyDamage(dAB * scale, a);
  if (dBA > 0) a.applyDamage(dBA * scale, b);
}

function applyKnockback(self, other) {
  var mag = self.absorb * other.push;
  if (mag === 0) return;
  var ang = (self.x === other.x && self.y === other.y)
    ? Math.random() * Math.PI * 2
    : Math.atan2(self.y - other.y, self.x - other.x);

  if (other.sides === 2) {                    // rectangles: snap to nearest axis
    if (self.canMoveThroughWalls) return;
    var c = Math.cos(ang) / other.size, s = Math.sin(ang) / other.width;
    ang = Math.abs(c) > Math.abs(s) ? (c > 0 ? 0 : Math.PI) : (s > 0 ? Math.PI / 2 : -Math.PI / 2);
  }
  if (other.isSolidWall) {
    // §9: a maze wall eats projectiles rather than bouncing them. The team test
    // this used to carry never fired — walls are neutral, so every bullet in the
    // maze skidded off one and kept going.
    if (self.owner) { self.kill(other); return; }
    mag /= 0.3;
    if (self.type === 'tank') { self.vx *= 0.3; self.vy *= 0.3; }
  }
  self.addVelocity(ang, mag);
}

function collides(a, b) {
  if (a.sides === 0 || b.sides === 0) return false;
  if (a.dead || b.dead) return false;
  if (a.sides === 2 && b.sides === 2) return false;           // rect vs rect is disabled
  if (a.sides === 2 || b.sides === 2) {
    var r = a.sides === 2 ? a : b, c = a.sides === 2 ? b : a;
    var dx = Math.abs(c.x - r.x), dy = Math.abs(c.y - r.y);
    var cx = Math.min(dx, r.size), cy = Math.min(dy, r.width);
    return (dx - cx) * (dx - cx) + (dy - cy) * (dy - cy) <= c.size * c.size;
  }
  var rr = a.size + b.size;
  return dist2(a, b) <= rr * rr;
}

function canInteract(a, b) {
  if (a.owner === b || b.owner === a) return false;
  if (a.owner && a.owner === b.owner) {
    // your own drones bump each other; your own bullets pass through each other
    if (!(a.onlySameOwnerCollision && b.onlySameOwnerCollision)) return false;
  }
  if (a.team !== null && a.team === b.team) {
    if (a.noOwnTeamCollision || b.noOwnTeamCollision) return false;
    if (a.onlySameOwnerCollision || b.onlySameOwnerCollision) return a.owner === b.owner;
  }
  return true;
}

// ---------------------------------------------------------------- barrels
function Barrel(parent, def, index) {
  this.parent = parent;
  this.def = def;
  this.index = index;
  this.cycle = 0;
  this.children = [];        // live drones/minions from this barrel
  this.recoilAnim = 0;       // 0..1 visual pull-back
}

Barrel.prototype.period = function () {
  return Math.max(1, this.parent.reloadTime * this.def.reload);
};

Barrel.prototype.tick = function (shooting) {
  var d = this.def;
  this.recoilAnim *= 0.8;
  // A mode can switch a barrel group off — the Juggernaut opens different
  // weapons at different ranges. Cheaper and more honest than rebuilding its
  // barrel list on the fly.
  if (this.disabled) { this.cycle = this.period(); return; }
  // Necromancer's two barrels never fire: its drones are reanimated Squares and
  // nothing else. They are declared droneCount 0, which used to fall straight
  // past the child cap below and let left-click mint free, permanent,
  // controllable drones out of thin air — an unbounded army for no shapes.
  if (d.bullet.type === 'necrodrone') return;
  if (d.droneCount) {
    this.children = this.children.filter(function (c) { return !c.dead; });
    if (this.children.length >= this.maxDrones()) { this.cycle = this.period(); return; }
  }
  var p = this.period(), delay = d.delay || 0;
  // The delay fraction sits *past* full reload: a barrel is loaded at p but only
  // pulls the trigger at p*(1+delay), then drops back to p*delay — so its period
  // stays p while its phase is offset by delay*p from a delay-0 sibling. Idling
  // parks every barrel at p rather than at its own threshold, so letting go of
  // fire never collapses a Twin's two barrels into one simultaneous shot.
  var thr = p * (1 + delay), firing = shooting || d.forceFire;
  if (this.cycle < thr) this.cycle += 1;
  if (firing) { if (this.cycle >= thr) { this.shoot(); this.cycle = p * delay; } }
  else if (this.cycle > p) this.cycle = p;
};

Barrel.prototype.maxDrones = function () {
  var t = this.parent;
  // Necromancer's Reload stat is relabelled Drone Count: 11 + points per barrel.
  if (this.def.bullet.type === 'necrodrone') return 11 + t.stats[S_RELOAD];
  return Math.min(this.def.droneCount, 1e6);
};

// mouth position in world space
Barrel.prototype.mouth = function () {
  var t = this.parent, k = t.scaleFactor, a = t.angle + this.def.angle;
  var len = this.def.size * k, off = this.def.offset * k;
  return { x: t.x + Math.cos(a) * len - Math.sin(a) * off,
           y: t.y + Math.sin(a) * len + Math.cos(a) * off, a: a };
};

// Who absorbs a barrel's recoil. A turret has no body of its own, so it pushes
// the tank it is bolted to; a missile pushes *itself*, which is exactly how the
// Rocketeer and Glider propel themselves. Everything else pushes itself.
function recoilTarget(parent) {
  if (typeof parent.addVelocity === 'function') return parent;
  return parent.parent && typeof parent.parent.addVelocity === 'function' ? parent.parent : null;
}

Barrel.prototype.shoot = function () {
  var t = this.parent, g = t.game, d = this.def, b = d.bullet;
  var m = this.mouth();
  this.recoilAnim = 1;
  var st = t.stats;
  var accel = (20 + BSPEED_GAIN * st[S_BSPEED]) * b.speed;
  var last = null;
  // Shotgun-family barrels put a whole volley out on one reload.
  var pellets = d.pellets || 1;
  for (var shot = 0; shot < pellets; shot++) last = this.spawn(m, accel, b, d, t, g);

  // One recoil impulse per trigger pull, not per pellet.
  var target = recoilTarget(t);
  if (target) target.addVelocity(m.a + Math.PI, d.recoil * 2);
  return last;
};

Barrel.prototype.spawn = function (m, accel, b, d, t, g) {
  var st = t.stats;
  // /bulletsize and /damage live on the tank, so a turret asks the tank it is bolted to.
  var host = t.isTurret && t.parent ? t.parent : t;
  var bsize = host.bulletSize || 1, bdmg = host.bulletDamage === undefined ? 1 : host.bulletDamage;
  var bspd = host.bulletSpeed === undefined ? 1 : host.bulletSpeed;
  // Ownership is the *root* tank, never whatever fired this. canInteract() only
  // compares one link, so a shot owned by its carrier — a Skimmer/Rocketeer/Glider
  // missile, a Firework shell, a Factory minion — matched nothing against the tank
  // that launched the carrier and hit it on the way past.
  var root = host; while (root.owner) root = root.owner;
  var scatter = (Math.PI / 180) * b.scatterRate * (Math.random() - 0.5) * 10;
  var ang = m.a + scatter;
  // `shotCap` is a mode's ceiling on how wide one round may be. The broadphase is
  // a uniform 128-unit grid, so a shell's cost goes with the square of its
  // radius — and a level-400 Armageddon hull's hellbore came out 3,400 across
  // and landed in seven hundred cells on its own.
  var proj = new Entity(g, {
    type: b.type === 'necrodrone' ? 'necro' : b.type,
    x: m.x, y: m.y, angle: ang,
    size: Math.max(2, Math.min(g.rule('shotCap', Infinity), (d.width / 2) * b.sizeRatio * t.scaleFactor * bsize)),
    sides: b.sides !== undefined ? b.sides : (b.type === 'drone' || b.type === 'swarm' ? 3 : b.type === 'necrodrone' ? 4 : b.type === 'trap' ? 3 : 1),
    // A turret is not an entity, so its shots must be owned by the tank it is
    // bolted to — otherwise canInteract() never matches and they hit their own
    // tank on the way out (and kills go uncredited).
    team: t.team, owner: root,
    fill: b.color || t.fill, stroke: b.stroke || t.stroke,
    maxHealth: (1.5 * st[S_PEN] + 2) * b.health,
    damage: (7 + st[S_DAMAGE] * 3) * b.damage * bdmg,
    absorb: b.absorbtionFactor,
    push: (7 / 3 + st[S_DAMAGE]) * b.damage * b.absorbtionFactor
  });
  proj.barrel = this;
  proj.accel = accel;
  proj.noDmgIndicator = true;
  proj.hiddenHealthbar = true;

  // Muzzle speed. Every projectile leaves at its own terminal speed + 30 minus a
  // scatter draw; the types that differ override this below.
  var launch = accel + 30 - Math.random() * b.scatterRate;

  switch (b.type) {
    case 'drone': case 'swarm': case 'minion':
      proj.minDmg = 1; proj.maxDmg = 1;
      proj.onlySameOwnerCollision = true;
      proj.accel = accel;
      launch /= 3;                                  // drones dribble out, then accelerate
      proj.push = 4;
      proj.controllable = !!d.canControlDrones;
      proj.life = b.lifeLength === -1 ? Infinity : 88 * b.lifeLength;
      proj.noDmgIndicator = false;
      if (b.type === 'minion') { proj.sides = 1; proj.barrels = [new Barrel(proj, MINION_BARREL, 0)]; proj.statsOwner = t; }
      break;
    case 'necrodrone':
      proj.minDmg = 1; proj.maxDmg = 4;            // a claimed square hits like a shape
      proj.type = 'necro'; proj.sides = 4;
      proj.fill = C.necro; proj.stroke = C.necroS;
      proj.onlySameOwnerCollision = true;
      proj.push = 4;
      proj.controllable = true;
      proj.accel = accel;
      launch = 0;                                   // a reanimated square starts dead still
      proj.life = Infinity;
      proj.scoreReward = 10;
      proj.noDmgIndicator = false;
      break;
    case 'trap':
      proj.minDmg = 0.25; proj.maxDmg = 1;
      // Traps are bullets with the engine off, launched at half speed, so they coast
      // out about ten times their muzzle speed and stop.
      launch = accel / 2 + 30 - Math.random() * b.scatterRate;
      proj.canEscapeArena = true;
      // For the first eighth of its life a trap only collides with the same owner's
      // projectiles: that is the window you can shoot your own fresh traps through.
      proj.onlySameOwnerCollision = true;
      proj.armAt = (75 * b.lifeLength) >> 3;
      proj.isStar = true;
      proj.life = 75 * b.lifeLength;
      break;
    case 'skimmer': case 'rocket': case 'glider':
      proj.minDmg = 0.25; proj.maxDmg = 1;
      proj.noOwnTeamCollision = true;
      proj.canEscapeArena = false;
      proj.life = MISSILE_LIFE[b.type] || 75 * b.lifeLength;
      proj.barrels = MISSILE_BARRELS[b.type].map(function (bd, i) { return new Barrel(proj, bd, i); });
      proj.statsOwner = t;
      proj.spin = b.type === 'skimmer' ? 0.1 : 0;
      proj.hiddenHealthbar = false;
      break;
    case 'firework':
      // A hexagonal shell carrying its own shard barrels, fired all at once on burst.
      proj.minDmg = 0.25; proj.maxDmg = 1;
      proj.noOwnTeamCollision = true;
      proj.canEscapeArena = true;
      proj.sides = 6;
      proj.life = FIREWORK.life;
      proj.barrels = FIREWORK_BARRELS.map(function (bd, i) { return new Barrel(proj, bd, i); });
      proj.statsOwner = t;
      proj.hiddenHealthbar = false;
      proj.noDmgIndicator = false;
      break;
    default: // bullet
      proj.minDmg = 0.25; proj.maxDmg = 1;
      proj.noOwnTeamCollision = true;
      proj.canEscapeArena = true;
      proj.life = 75 * b.lifeLength;
  }

  // /bulletspeed scales cruise speed and the muzzle kick together, so a slowed
  // shot does not still leap out of the barrel.
  proj.accel *= bspd;
  if (launch) proj.addVelocity(ang, launch * bspd);
  if (b.type === 'trap') proj.accel = 0;            // traps coast to a stop and stay put
  g.add(proj);
  if (d.droneCount) this.children.push(proj);
  // A mode's ceiling on how many traps, and how many plain rounds, one tank may
  // have out at once; past it the oldest goes. Juggernaut Armageddon needs both:
  // a Warden-line hull with eighteen launchers on a minute-long fuse held 2,700
  // traps, the Armageddon itself kept 2,900 rounds in the air, and the
  // broadphase spent the tick on them. The queue only ever over-counts (a trap
  // shot down early still holds its place until it reaches the front), so the
  // live number never passes the cap.
  var capKey = b.type === 'trap' ? 'trapCap' : b.type === 'bullet' ? 'bulletCap' : null;
  var cap = capKey ? g.rule(capKey, 0) : 0;
  if (cap) {
    var q = b.type === 'trap' ? (root.capTraps || (root.capTraps = [])) : (root.capShots || (root.capShots = []));
    q.push(proj);
    while (q.length && q[0].dead) q.shift();
    while (q.length > cap) { var old = q.shift(); if (!old.dead) old.kill(null); }
  }
  return proj;
};

// Fire every shard barrel at once, then the shell is spent.
function burstFirework(p) {
  if (p.burst || !p.barrels) return;
  p.burst = true;
  var owner = p.statsOwner || p.owner;
  p.stats = owner ? owner.stats : [0, 0, 0, 0, 0, 0, 0, 0];
  p.reloadTime = owner ? owner.reloadTime : 15;
  p.scaleFactor = 1;
  for (var i = 0; i < p.barrels.length; i++) p.barrels[i].shoot();
  p.kill(null);
}

// diep MinionBarrelDefinition. recoil 1 is real: a firing minion shoves itself back.
var MINION_BARREL = {
  angle: 0, offset: 0, size: 85, width: 50.4, delay: 0, reload: 1, recoil: 1,
  isTrapezoid: false, trapezoidDirection: 0, addon: null,
  bullet: { type: 'bullet', sizeRatio: 1, health: 0.4, damage: 0.4, speed: 0.8, scatterRate: 1, lifeLength: 1, absorbtionFactor: 1 }
};

// ---------------------------------------------------------------- turret
function Turret(parent, index, count, arc, defs) {
  this.parent = parent;
  this.isTurret = true;
  this.index = index;
  this.arc = arc;
  // Bosses mount their turrets between their barrels rather than on top of
  // them, so the ring can be rotated off the body's own vertices.
  this.base = (count === 1 ? 0 : (Math.PI * 2 * index) / count)
    + ((parent.spec && parent.spec.turretOffset) || 0);
  this.angle = 0;
  this.target = null;
  this.barrels = (defs || [TURRET_BARREL]).map(function (d, i) { return new Barrel(this, d, i); }, this);
  this.barrel = this.barrels[0];          // the one that aims; the rest ride along
  this.stats = parent.stats;
  this.reloadTime = parent.reloadTime;
  this.scaleFactor = parent.scaleFactor;
  this.game = parent.game;
  this.team = parent.team;
  this.fill = parent.fill; this.stroke = parent.stroke;
  this.x = parent.x; this.y = parent.y;
}
Turret.prototype.tick = function () {
  var p = this.parent, r = p.size;
  this.stats = p.stats; this.reloadTime = p.reloadTime; this.scaleFactor = p.scaleFactor;
  this.team = p.team; this.fill = p.fill; this.stroke = p.stroke;
  var mount = p.angle * (this.arc ? 1 : 0) + this.base;
  this.x = p.x + (this.arc ? Math.cos(mount) * r * TURRET.dist : 0);
  this.y = p.y + (this.arc ? Math.sin(mount) * r * TURRET.dist : 0);

  if (this.game.tick % 2 === (this.index % 2)) this.target = this.game.findTarget(this, 1700, true);
  if (this.target && !this.target.dead) {
    var b = this.barrel.def.bullet;
    this.angle = interceptAim(this, this.target, (20 + BSPEED_GAIN * this.stats[S_BSPEED]) * b.speed,
                              this.barrel.def.size * this.scaleFactor);
  } else {
    this.angle += PASSIVE_ROTATION;
  }
  var firing = !!(this.target && !this.target.dead);
  for (var i = 0; i < this.barrels.length; i++) this.barrels[i].tick(firing);
};

// Aimbot, for turrets only — bots keep the cheap guess below.
// A bullet's travel over n ticks is exactly S*n + (300 + S)*(1 - 0.9^n): terminal
// speed S (= its accel, under 10% friction) plus the +30 muzzle kick decaying away.
// Solve that for the flight time, move the target along by it, repeat.
function interceptAim(from, t, S, muzzle) {
  // t.vx is post-friction; the tank actually covers vx/0.9 next tick.
  var vx = t.vx / 0.9, vy = t.vy / 0.9, head = 300 + S;
  var tx = t.x, ty = t.y, n = 0;
  for (var i = 0; i < 4; i++) {
    var d = Math.max(0, Math.hypot(tx - from.x, ty - from.y) - muzzle);
    n = d / S;
    for (var j = 0; j < 3; j++) n = Math.max(0, (d - head * (1 - Math.pow(0.9, n))) / S);
    tx = t.x + vx * n; ty = t.y + vy * n;
  }
  return Math.atan2(ty - from.y, tx - from.x);
}

// Cheap intercept: offset the aim point by the target's perpendicular drift.
function predictAim(from, t, speed) {
  var dx = t.x - from.x, dy = t.y - from.y;
  var d = Math.hypot(dx, dy) || 1;
  var base = Math.atan2(dy, dx);
  var perp = -Math.sin(base) * t.vx + Math.cos(base) * t.vy;
  // The cap has to stay under `speed`. Above it the term below goes imaginary,
  // gets floored to 1, and the offset explodes into a shot ninety degrees wide.
  var lim = 0.9 * speed;
  perp = Math.max(-lim, Math.min(lim, perp));
  var direct = Math.sqrt(Math.max(1, speed * speed - perp * perp));
  var off = (perp / direct) * d / 2;
  return Math.atan2(dy + Math.cos(base) * off, dx - Math.sin(base) * off);
}

// ---------------------------------------------------------------- tank
function Tank(game, o) {
  Entity.call(this, game, { type: 'tank', x: o.x, y: o.y, team: o.team, sides: 1, size: 50 });
  this.name = o.name || '';
  this.isPlayer = !!o.isPlayer;
  this.bot = !!o.bot;
  this.score = o.score || 0;
  this.level = levelFromScore(this.score, game.levelCap());
  this.stats = [0, 0, 0, 0, 0, 0, 0, 0];
  this.queued = [];
  this.tankId = 0;
  this.pendingUpgrades = [];
  this.upgradesTaken = [];
  this.input = { up: 0, down: 0, left: 0, right: 0, fire: 0, altFire: 0 };
  this.mouse = { x: o.x + 100, y: o.y };
  this.autoFire = false;
  this.autoSpin = false;
  this.spinAngle = 0;
  this.godMode = false;
  this.kills = 0;
  this.spawnTick = game.tick;
  this.protectedUntil = game.tick + SPAWN_PROTECT_TICKS;
  this.minDmg = 1; this.maxDmg = 6;
  this.guardAngle = 0;
  this.zoomOffset = 0;
  this.setTank(o.tankId || 0);
  this.recompute();
  this.health = this.maxHealth;
}
Tank.prototype = Object.create(Entity.prototype);
Tank.prototype.constructor = Tank;

Tank.prototype.setTank = function (id) {
  var def = TANK_DEFS[id];
  if (!def) return;
  this.tankId = id;
  this.def = def;
  this.sides = def.sides;
  this.isStar = !!def.isStar;             // Tree-Topper; every other body is a polygon
  this.starPoints = def.starPoints || 3;
  this.borderWidth = (def.borderWidth || 15) / 2;   // defs quote it doubled; 15 is the stock tank
  this.baseSize = baseSizeOf(def);
  this.barrels = def.barrels.map(function (b, i) { return new Barrel(this, b, i); }, this);
  this.invisible = !!def.flags.invisibility;
  if (!this.invisible) this.opacity = 1;
  this.game.paintTeam(this);              // a boss class's own colour wins over the team's
  this.recompute();                       // must precede period(), which reads reloadTime
  this.turrets = [];
  var post = ADDONS[def.postAddon];
  if (post && post.turrets) {
    for (var i = 0; i < post.turrets; i++) this.turrets.push(new Turret(this, i, post.turrets, !!post.arc, post.turretBarrels));
  }
  // Loaded but not yet past the delay threshold — see Barrel.tick.
  this.barrels.forEach(function (b) { b.cycle = b.period(); });
};

Tank.prototype.recompute = function () {
  var def = this.def, st = this.stats, L = this.level;
  // scaleBoost is how a mode makes a tank big: diep scales the whole tank, so
  // barrels, collars and guards ride the same factor. Growing baseSize alone
  // left the Dominator with a level-75 cannon bolted to a 160-unit body.
  this.scaleFactor = Math.pow(this.game.rule('lvlScale', 1.01), L - 1) * (this.scaleBoost || 1);
  this.size = this.baseSize * this.scaleFactor;
  // Max Health and Body Damage are the two stats diep pays out as flat numbers,
  // which is fine on a 3,000 hp Overlord and worthless on a 90,000 hp crown: 28
  // points of Max Health would be +560 on a bar that long. These two rules let a
  // mode pay them out as a share of the hull instead, so the stat is worth the
  // same on the first hull as on the last. Both default to 0 — every other mode
  // gets diep's own flat arithmetic, to the point.
  var mh = def.maxHealth * (1 + st[S_HEALTH] * this.game.rule('statHealthPct', 0))
    + 2 * (L - 1) + st[S_HEALTH] * 20;
  if (this.maxHealth) this.health = Math.min(this.health * (mh / this.maxHealth), mh);
  this.maxHealth = mh;
  this.regenPerTick = (mh * 4 * st[S_REGEN] + mh) / 25000 * this.game.rule('regen', 1);
  this.movementSpeed = def.speed * 2.55 * Math.pow(1.07, st[S_SPEED]) / Math.pow(this.game.rule('lvlSlow', 1.015), L - 1);
  this.reloadTime = 15 * Math.pow(0.914, st[S_RELOAD]) * this.game.rule('reloadMult', 1);
  this.damagePerTick = 5 + st[S_BODY]
    + (def.bodyDamage || 0) * (1 + st[S_BODY] * this.game.rule('statBodyPct', 0));
  this.absorb = def.absorbtionFactor;
  // absorbtionFactor is how hard you are *pushed*; pushFactor is how hard you push,
  // and diep leaves every tank on the entity default of 8.
  this.push = 8;
  // Fog of War and Nightfall pull this in; Nightfall moves it every tick, so
  // it reads a live value off the game rather than a fixed rule.
  this.fov = 0.55 * def.fieldFactor / Math.pow(this.game.rule('lvlScale', 1.01), (L - 1) / 2)
    * (this.game.fovScale !== undefined ? this.game.fovScale : this.game.rule('fov', 1));
  // fovSize: a mode whose hulls run far past diep's size range widens the view
  // with the hull, so a huge tank takes a steady share of the screen instead of
  // filling it. 0 (the default) leaves every other mode alone.
  var fovSize = this.game.rule('fovSize', 0);
  if (fovSize && this.size > 78) this.fov *= Math.pow(78 / this.size, fovSize);
  // bonusPoints is the /points cheat; the floor keeps an over-spent build (also
  // a cheat) from wrapping to 255 when it goes out on the wire as a u8.
  this.statsAvailable = Math.max(0, statCount(L) + (this.bonusPoints || 0) - st.reduce(function (a, b) { return a + b; }, 0));
};

Tank.prototype.addScore = function (n) {
  if (this.dead) return;
  this.score += n;
  var nl = levelFromScore(this.score, this.game.levelCap());
  if (nl !== this.level) { this.level = nl; this.recompute(); this.checkUpgrades(); }
  else this.recompute();
  this.flushQueue();
};

Tank.prototype.checkUpgrades = function () {
  var ups = this.def.upgrades || [];
  var avail = ups.filter(function (id) {
    var d = TANK_DEFS[id];
    return d && !d.flags.devOnly && this.level >= d.levelRequirement;
  }, this);
  // Draft Roulette narrows the offer to one card. It runs here rather than in
  // the UI so the server's own gate in upgradeTo refuses the cards it hid.
  var logic = this.game.logic;
  if (logic && logic.filterUpgrades) avail = logic.filterUpgrades(this.game, this, avail);
  this.pendingUpgrades = avail;
};

Tank.prototype.upgradeTo = function (id) {
  if (this.pendingUpgrades.indexOf(id) === -1) return false;   // server-side gate
  var d = TANK_DEFS[id];
  if (!d || this.level < d.levelRequirement) return false;
  var wasSmasher = this.def.stats[S_DAMAGE].max === 0;
  this.setTank(id);
  // Smasher branch refunds points spent on bullet stats.
  if (d.stats[S_DAMAGE].max === 0 && !wasSmasher) {
    this.stats[S_DAMAGE] = 0; this.stats[S_PEN] = 0; this.stats[S_BSPEED] = 0; this.stats[S_RELOAD] = 0;
  }
  for (var i = 0; i < 8; i++) this.stats[i] = Math.min(this.stats[i], d.stats[i].max);
  this.upgradesTaken.push(id);
  this.pendingUpgrades = [];
  this.recompute();
  this.checkUpgrades();
  this.notify(d.upgradeMessage || ('You are now a ' + d.name), 90);
  return true;
};

// Personal notifications. Global ones live on the game; these belong to one
// player, so on a server they go to that client alone rather than the arena.
Tank.prototype.notify = function (text, ticks) {
  // Offline there is one client and no wire, so the local player's notes are
  // simply the arena feed — nothing else renders them.
  if (this.isPlayer && !this.game.headless) return this.game.notify(text, ticks);
  if (!this.notes) this.notes = [];
  this.notes.push({ text: text, ttl: ticks || 100 });
};

Tank.prototype.upgradeStat = function (wire) {
  if (this.statsAvailable <= 0) return false;
  if (this.stats[wire] >= this.def.stats[wire].max) return false;
  this.stats[wire]++;
  this.recompute();
  return true;
};
Tank.prototype.flushQueue = function () {
  while (this.queued.length && this.statsAvailable > 0) {
    var w = this.queued[0];
    if (!this.upgradeStat(w)) { this.queued.shift(); continue; }
    this.queued.shift();
  }
};

Tank.prototype.tick = function () {
  var g = this.game;
  if (this.parked) return;              // its pilot is driving something else

  if (g.tick < this.protectedUntil && !this.moved && !this.shot) this.damageReduction = 0;
  else { this.damageReduction = 1; this.protectedUntil = 0; }
  if (this.godMode) { this.damageReduction = 0; this.absorb = 0; }

  var i = this.input;
  var mx = (i.right - i.left), my = (i.down - i.up);
  if (this.immobile) { mx = 0; my = 0; }   // Dominators are bolted down
  if (mx || my) {
    var m = Math.hypot(mx, my);
    this.addVelocity(Math.atan2(my / m, mx / m), this.movementSpeed * g.rule('accelMult', 1));
    this.moved = true;
  }

  if (this.autoSpin) { this.spinAngle += 0.06; this.angle = this.spinAngle; }
  else this.angle = Math.atan2(this.mouse.y - this.y, this.mouse.x - this.x);

  var shooting = !!(i.fire || this.autoFire);
  if (shooting) this.shot = true;
  for (var b = 0; b < this.barrels.length; b++) this.barrels[b].tick(shooting);
  for (var t = 0; t < this.turrets.length; t++) this.turrets[t].tick();

  // regen. Vampire turns this off, and "off" has to mean the hyper-regen too —
  // regenPerTick alone leaves a 30-second-undamaged tank healing 0.4% a tick,
  // which is most of the healing in the game.
  if (this.health < this.maxHealth && g.rule('regen', 1) !== 0) {
    this.health = Math.min(this.maxHealth, this.health + this.regenPerTick);
    if (g.tick - this.lastDamage >= HYPER_REGEN_DELAY) this.health = Math.min(this.maxHealth, this.health + this.maxHealth / 250);
  }

  // invisibility
  if (this.invisible) {
    var d = this.def;
    if (shooting) this.opacity += d.visibilityRateShooting;
    if (mx || my) this.opacity += d.visibilityRateMoving;
    this.opacity -= d.invisibilityRate;
    this.opacity = Math.max(0, Math.min(1, this.opacity));
  }
  if (this.cheatInvis) this.opacity = 0;   // /invis, which no class can undo by firing

  // Knockback can shove a tank clean inside a wall block, and inside one there
  // is nothing to push it back out — it just sits there, invulnerable and stuck.
  // Being in the wall is fatal, ramping so a graze is survivable and a burial
  // is not.
  if (g.walls.length && !this.canMoveThroughWalls && !this.isCloser
      && g.inWall(this.x, this.y, -this.size * 0.35)) {
    this.wallTicks = (this.wallTicks || 0) + 1;
    this.applyDamage(this.maxHealth * 0.004 * this.wallTicks, null);
  } else this.wallTicks = 0;

  this.guardAngle += 1;
  if (this.hurtFlash > 0) this.hurtFlash--;
  if (this.notes) for (var n = this.notes.length - 1; n >= 0; n--) if (--this.notes[n].ttl <= 0) this.notes.splice(n, 1);
  if (this.selfDestruct && this.level >= 6) this.applyDamage(2 + this.maxHealth / 500, null);
};

Tank.prototype.onKill = function (source) {
  var root = source; while (root && root.owner) root = root.owner;
  this.killedBy = root && root.name ? root.name : 'an unnamed tank';
  // the death screen watches your killer until it dies too
  this.killerEntity = (root && root !== this && root.type === 'tank') ? root : null;
  if (root && root.type === 'tank' && root !== this) {
    root.kills++;
    // Personal, not arena-wide: your kills are yours. Deaths are already on the
    // death screen, so only the killer hears about it.
    root.notify('You killed ' + (this.name || 'an unnamed tank') + '!', 150);
  }
  // Ahead of the respawn queue below, which reads what it decides: Tag moves you
  // onto your killer's team here, and queueing first threw every tag away.
  var logic = this.game.logic;
  if (logic && logic.onTankDeath) logic.onTankDeath(this.game, this, source);
  // A bot comes back the way you do: one rung down, not from scratch, and on the
  // same side. Without this the whole population resets to zero on every death,
  // and at ~200 bot deaths a minute no arena ever levels up — the leaderboard
  // just churns in the low hundreds forever. The count top-up in step() spawns
  // the replacement, so the slot waits in a queue for whoever fills it.
  if (this.bot) {
    var q = this.game.botRespawn;
    q.push({ lvl: respawnLevel(this.level), team: this.nextTeam || this.team });
    while (q.length > this.game.botCount) q.shift();   // /bots 0 must not pile up a backlog
  }
  if (this.possessing && typeof release === 'function') release(this.game, this);
  if (this.possessedBy && typeof release === 'function') release(this.game, this.possessedBy);
  this.game.orphan(this);
  if (this.isPlayer) {
    this.game.spectate = this.killerEntity;   // offline: render.updateCamera follows it
    this.game.onPlayerDeath(this);
  }
};

// ---------------------------------------------------------------- shapes
function Shape(game, kind, x, y) {
  var s = SHAPES[kind];
  var shiny = Math.random() < SHINY_CHANCE;
  Entity.call(this, game, {
    type: 'shape', x: x, y: y, sides: s.sides, size: s.size,
    fill: shiny ? C.shiny : s.fill, stroke: shiny ? C.shinyS : s.stroke,
    maxHealth: s.health * (shiny ? 10 : 1), damage: s.damage,
    score: s.score * (shiny ? 100 : 1), absorb: s.absorb, push: s.push
  });
  this.kind = kind;
  this.shiny = shiny;
  this.minDmg = 1; this.maxDmg = 4;
  this.angle = Math.random() * Math.PI * 2;
  var half = kind === 'pentagon' || kind === 'alpha' ? 0.5 : 1;
  this.rot = sign() * SHAPE_ROTATION * half;
  this.orbitRate = sign() * SHAPE_ORBIT * half;
  this.orbitAngle = Math.random() * Math.PI * 2;
  this.vel = SHAPE_VELOCITY * half;
  this.isCrasher = kind === 'crasherS' || kind === 'crasherL';
  if (this.isCrasher) { this.canMoveThroughWalls = true; this.speed = s.speed; this.target = null; }
}
Shape.prototype = Object.create(Entity.prototype);
Shape.prototype.constructor = Shape;

Shape.prototype.tick = function () {
  var g = this.game;
  if (this.hurtFlash > 0) this.hurtFlash--;
  if (this.health < this.maxHealth && g.tick - this.lastDamage >= HYPER_REGEN_DELAY)
    this.health = Math.min(this.maxHealth, this.health + this.maxHealth / 250);

  if (this.isCrasher) {
    if (g.tick % 25 === this.id % 25) this.target = g.findTarget(this, 2000, false);
    if (this.target && !this.target.dead) {
      this.angle = Math.atan2(this.target.y - this.y, this.target.x - this.x);
      this.maintainVelocity(this.angle, this.speed);
    } else {
      this.angle += this.rot;
      this.maintainVelocity(this.orbitAngle, SHAPE_VELOCITY);   // idles like any other shape
      this.orbitAngle += this.orbitRate;
    }
    return;
  }

  this.angle += this.rot;
  // steer away from the arena edge
  var a = g.arena, near = 0;
  if (this.x < a.left + 400) near = 0; else if (this.x > a.right - 400) near = Math.PI;
  else if (this.y < a.top + 400) near = Math.PI / 2; else if (this.y > a.bottom - 400) near = -Math.PI / 2;
  else near = null;
  if (near !== null) {
    this.turning = TURN_TIMEOUT;
    this.orbitAngle += angleDiff(this.orbitAngle, near) * 0.05;
    this.orbitAngle += this.orbitRate * 11;
  } else {
    this.orbitAngle += this.orbitRate;
  }
  this.maintainVelocity(this.orbitAngle, this.vel);
};

// ---------------------------------------------------------------- projectiles
function tickProjectile(p) {
  var g = p.game;
  p.age++;
  if (p.age >= p.life) {
    if (p.type === 'firework') burstFirework(p); else p.kill(null);
    return;
  }
  if (p.hurtFlash > 0) p.hurtFlash--;

  var owner = p.owner;
  switch (p.type) {
    case 'trap':
      p.angle += 0.02;
      // arms: stops ignoring everyone but its owner, starts ignoring its own team
      if (p.armAt !== undefined && p.age >= p.armAt) {
        p.onlySameOwnerCollision = false; p.noOwnTeamCollision = true; p.armAt = undefined;
      }
      break;

    case 'drone': case 'necro': case 'swarm': case 'minion': {
      if (!owner || owner.dead) { p.kill(null); return; }
      var tx, ty, head, speed = p.accel;
      if (p.controllable && owner.input.fire) { tx = owner.mouse.x; ty = owner.mouse.y; }
      else if (p.controllable && owner.input.altFire) { tx = p.x * 2 - owner.mouse.x; ty = p.y * 2 - owner.mouse.y; }
      else {
        // Auto Fire turns drones into hunters: same homing, longer leash than
        // the 900 du idle guard radius, so they go after whoever is on screen.
        var range = owner.autoFire ? DRONE_HUNT_RANGE : 900;
        if (g.tick % 2 === p.id % 2) p.dTarget = g.findTarget(p, range, true, owner);
        if (p.dTarget && !p.dTarget.dead) { tx = p.dTarget.x; ty = p.dTarget.y; }
        else {
          // diep's two-phase idle cycle: swing out to a point tangent to the owner,
          // and once you have arrived, free-wheel at a sixth thrust with the heading
          // precessing, until you drift back outside the 400 du resting radius.
          var dx = p.x - owner.x, dy = p.y - owner.y;
          var unitDist = (dx * dx + dy * dy) / 160000;          // resting radius squared
          if (unitDist <= 1 && p.restCycle) {
            head = p.angle + 0.01 + 0.012 * unitDist;
            speed = p.accel / 6;
          } else {
            var off = Math.atan2(dy, dx) + Math.PI / 2;
            tx = owner.x + Math.cos(off) * owner.size * 1.2;
            ty = owner.y + Math.sin(off) * owner.size * 1.2;
            if (unitDist < 0.5) speed = p.accel / 3;
            p.restCycle = (tx - p.x) * (tx - p.x) + (ty - p.y) * (ty - p.y) <= 4 * owner.size * owner.size;
          }
        }
      }
      var ang = head === undefined ? Math.atan2(ty - p.y, tx - p.x) : head;
      p.angle = ang;
      p.maintainVelocity(ang, speed);
      if (p.type === 'minion' && p.barrels) {
        p.scaleFactor = 1; p.stats = (p.statsOwner || owner).stats; p.reloadTime = (p.statsOwner || owner).reloadTime;
        var mt = p.dTarget && !p.dTarget.dead;
        p.barrels[0].tick(mt || !!owner.input.fire || !!owner.autoFire);
      }
      break;
    }

    case 'skimmer': case 'rocket': case 'glider': {
      if (!owner || owner.dead) { p.kill(null); return; }
      p.stats = (p.statsOwner || owner).stats;
      p.reloadTime = (p.statsOwner || owner).reloadTime;
      p.scaleFactor = 1;
      if (p.spin) p.angle += owner.input.altFire ? -p.spin : p.spin;
      // Rocketeer and Glider are driven purely by their own barrels' recoil.
      for (var i = 0; i < p.barrels.length; i++) p.barrels[i].tick(true);
      break;
    }

    case 'firework': {
      if (p.heading === undefined) p.heading = p.angle;
      p.angle += 0.06;                              // visual spin only
      p.maintainVelocity(p.heading, p.accel);       // flight path must not spin with it
      // right-click detonates it early
      if (owner && owner.input && owner.input.altFire) burstFirework(p);
      break;
    }

    default: // bullet
      p.maintainVelocity(p.angle, p.accel);
  }
}

// ---------------------------------------------------------------- boss
function Boss(game, spec) {
  Entity.call(this, game, {
    type: 'boss', x: rand(game.arena.left * 0.6, game.arena.right * 0.6), y: rand(game.arena.top * 0.6, game.arena.bottom * 0.6),
    sides: spec.sides, size: spec.sides === 1 ? spec.size : spec.size * Math.SQRT1_2,
    fill: spec.fill, stroke: spec.stroke, team: null,
    maxHealth: BOSS_HEALTH, damage: BOSS_DAMAGE, score: BOSS_SCORE, absorb: 0.05, push: 8
  });
  this.spec = spec;
  this.bossIndex = BOSSES.indexOf(spec);   // clients rebuild barrels from the same table
  this.name = spec.name;
  this.minDmg = 1; this.maxDmg = 6;
  // Barrels scale with the body (size / 50) unless the boss pins them, which
  // only the Guardian and the Summoner do — the Defender's launchers really are
  // half again as long as its body is wide.
  this.scaleFactor = spec.barrelScale !== undefined ? spec.barrelScale : this.size / 50;
  this.stats = [0, 4, 4, 4, 4, 0, 0, 0];
  this.reloadTime = 15 * Math.pow(0.914, 4);
  this.movementSpeed = spec.speed;
  this.regenPerTick = (this.regenPerTick || 0) * game.rule('regen', 1);
  var self = this;
  this.barrels = bossBarrels(spec).map(function (b, i) { return new Barrel(self, b, i); });
  this.turrets = [];
  if (spec.turrets) for (var i = 0; i < spec.turrets; i++) this.turrets.push(new Turret(this, i, spec.turrets, true));
  this.input = { fire: 1, altFire: 0 };
  this.mouse = { x: this.x, y: this.y };
  this.target = null;
}
Boss.prototype = Object.create(Entity.prototype);
Boss.prototype.constructor = Boss;

Boss.prototype.tick = function () {
  var g = this.game, s = this.spec;
  if (this.hurtFlash > 0) this.hurtFlash--;
  // Somebody is driving. Its own AI would fight the wheel for the angle and the
  // throttle every tick, so it stands down entirely.
  if (this.possessedBy && !this.possessedBy.dead) {
    var d = this.possessedBy;
    this.angle = Math.atan2(this.mouse.y - this.y, this.mouse.x - this.x);
    if (s.spin) this.angle += PASSIVE_ROTATION * 2;
    var mx = (this.input.right - this.input.left), my = (this.input.down - this.input.up);
    if (mx || my) { var m = Math.hypot(mx, my); this.maintainVelocity(Math.atan2(my / m, mx / m), this.movementSpeed * 6); }
    for (var bi = 0; bi < this.barrels.length; bi++) this.barrels[bi].tick(!!this.input.fire);
    for (var ti = 0; ti < this.turrets.length; ti++) this.turrets[ti].tick();
    return;
  }
  if (g.tick % 2 === 0 && s.viewRange !== 0) this.target = g.findTarget(this, 3000, true);
  if (this.target && !this.target.dead) {
    var aim = predictAim(this, this.target, 20 + BSPEED_GAIN * this.stats[S_BSPEED]);
    if (!s.spin) this.angle = aim;
    this.mouse.x = this.target.x; this.mouse.y = this.target.y;
    var mv = Math.atan2(this.target.y - this.y, this.target.x - this.x);
    this.maintainVelocity(mv, this.movementSpeed);
    if (s.faceVelocity) this.angle = mv;
  } else {
    this.angle += PASSIVE_ROTATION;
    this.mouse.x = this.x + Math.cos(this.angle) * 500;
    this.mouse.y = this.y + Math.sin(this.angle) * 500;
  }
  if (s.spin) this.angle += PASSIVE_ROTATION * 2;
  for (var i = 0; i < this.barrels.length; i++) this.barrels[i].tick(true);
  for (var t = 0; t < this.turrets.length; t++) this.turrets[t].tick();
  if (this.health < this.maxHealth && g.tick - this.lastDamage >= HYPER_REGEN_DELAY)
    this.health = Math.min(this.maxHealth, this.health + this.maxHealth / 250);
};
Boss.prototype.onKill = function (source) {
  var root = source; while (root && root.owner) root = root.owner;
  this.game.notify('The ' + this.name + ' has been defeated by ' + ((root && root.name) || 'an unnamed tank') + '!', 150);
  this.game.boss = null;
};

// ---------------------------------------------------------------- bot AI
var BOT_NAMES = ['Zephyr', 'Nova', 'Vex', 'Kilo', 'Onyx', 'Rift', 'Sable', 'Juno', 'Pyre', 'Quill', 'Drift', 'Ember',
  'Halo', 'Lynx', 'Mako', 'Nyx', 'Orbit', 'Prism', 'Quasar', 'Rogue', 'Slate', 'Talon', 'Umbra', 'Vault', 'Wraith'];

// ---------------------------------------------------------------- builds
// What kind of tank a class is, read off its own barrels rather than a hand-kept
// list, so a tank added to tankdefs-extra.js classifies itself. The smasher
// family is the one that cannot be read off a barrel it does not have: they are
// exactly the classes whose postAddon carries body guards, or whose bullet stats
// are capped at zero. Auto 3 and Auto 5 also carry no barrels and are *not*
// rammers — their guns are the turrets.
var KIND_BIT = { ram: 1, drone: 2, trap: 4, snipe: 8, gun: 16 };
var BOT_KIND = [];
function botKind(d) {
  if (!d) return 'gun';
  if (BOT_KIND[d.id]) return BOT_KIND[d.id];
  var k;
  if (!d.barrels.length) {
    k = ((ADDONS[d.postAddon] || {}).guards || d.stats[S_DAMAGE].max === 0) ? 'ram' : 'gun';
  } else {
    var b = d.barrels[0].bullet.type;
    // fieldFactor below 1 is a real zoom-out, and diep only pays it to the
    // classes meant to shoot from outside the other tank's screen.
    k = BOT_HOMING[b] ? 'drone' : b === 'trap' ? 'trap' : d.fieldFactor <= 0.9 ? 'snipe' : 'gun';
  }
  return (BOT_KIND[d.id] = k);
}

// How many classes of each kind sit at or below a class in the tree. Counted
// rather than flagged, because a branch that leads to one drone tank and a branch
// that leads to six are not the same offer: Twin reaches a Battleship eventually,
// Sniper reaches the entire Overseer tree, and a bot that wants drones should be
// taking the Sniper. Reachable two ways counts twice, which is fair — it is.
var KIND_LIST = ['ram', 'drone', 'trap', 'snipe', 'gun'];
var KINDS_BELOW = [];
function botKindsBelow(id) {
  if (KINDS_BELOW[id]) return KINDS_BELOW[id];
  var d = TANK_DEFS[id];
  if (!d) return [0, 0, 0, 0, 0];
  var c = KINDS_BELOW[id] = [0, 0, 0, 0, 0];    // seeded before recursing: the tree
  c[KIND_LIST.indexOf(botKind(d))]++;           // is a DAG, but a cycle would hang
  var u = d.upgrades || [];
  for (var i = 0; i < u.length; i++) {
    var s = botKindsBelow(u[i]);
    for (var j = 0; j < 5; j++) c[j] += s[j];
  }
  return c;
}

// Classes below `id` that this build is for.
function botBelow(build, id) {
  var c = botKindsBelow(id), n = 0;
  for (var i = 0; i < 5; i++) if (build.mask & KIND_BIT[KIND_LIST[i]]) n += c[i];
  return n;
}

// Rear-facing recoil per tick: what a Booster actually moves on. This is why the
// ram builds are not only a Smasher thing — the whole Tri-Angle line rams on its
// own recoil, and nothing in the class table says so except the geometry.
var BOT_THRUST = [];
function botThrust(d) {
  if (BOT_THRUST[d.id] !== undefined) return BOT_THRUST[d.id];
  var th = 0;
  for (var i = 0; i < d.barrels.length; i++) {
    var b = d.barrels[i];
    th += Math.max(0, -Math.cos(b.angle || 0)) * (b.recoil || 0) / (b.reload || 1);
  }
  return (BOT_THRUST[d.id] = th);
}

// Priority inside a build: most-wanted stat first, ties broken by the community's
// own stat-by-stat testing — penetration over damage, body damage over max health,
// and the early points of regen and move speed (which are the effective ones) over
// the last points of bullet speed (which are nearly free to skip).
var GUN_PRIO = [S_PEN, S_DAMAGE, S_RELOAD, S_BSPEED, S_SPEED, S_HEALTH, S_BODY, S_REGEN];
var RAM_PRIO = [S_BODY, S_HEALTH, S_SPEED, S_REGEN, S_PEN, S_DAMAGE, S_RELOAD, S_BSPEED];

// A build is a *target*, not a priority list, and that is the whole change here.
// A strict ordering can only ever say "max these four", so it has exactly four
// corners of the stat space to land on — 4/2/4/4/6/6/6/1 and 2/3/2/5/7/7/7/0,
// both standard builds, were unreachable, and every bot on the field converged
// on one of the same handful of tanks.
//
// `pts` is written in the notation the wiki, the build calculator and every guide
// use, which is the wire order reversed:
//   HealthRegen / MaxHealth / BodyDamage / BulletSpeed / Penetration / Damage / Reload / MoveSpeed
// `kinds` is the classes it is for. `ram` is still the hard split, because a role
// commits to body damage or to a gun before it ever sees a class.
function bld(name, ram, kinds, pts) {
  if (typeof pts === 'string') pts = pts.split('/').map(Number).reverse();
  var prio = ram ? RAM_PRIO : GUN_PRIO, mask = 0;
  kinds.split(' ').forEach(function (k) { mask |= KIND_BIT[k] || 0; });
  var order = [0, 1, 2, 3, 4, 5, 6, 7].sort(function (a, b) {
    return (pts[b] - pts[a]) || (prio.indexOf(a) - prio.indexOf(b));
  });
  return { name: name, ram: ram, kinds: kinds, mask: mask, pts: pts, order: order };
}

// The builds the game is actually played with, lifted from the community build
// tables rather than invented. Three archetypes run through them: glass cannons
// (0/0/0/X/X/X/X/X — defence is offence), rammers (X/X/X/0/0/0/X/X), and bullet
// smashers, which drop bullet speed to push a wall of slow shots ahead of them.
// Every entry sums to 33, the level-45 budget; a class that caps a stat lower
// spills the remainder down the same order, so none of them strands a point.
var BOT_BUILDS = [
  // --- glass cannon: all four bullet stats maxed, the single most common build
  bld('Glass Cannon',   0, 'gun snipe trap',  '0/1/2/7/7/7/7/2'),
  bld('Auto Gunner',    0, 'gun',             '3/2/0/7/7/7/7/0'),
  bld('Sprayer',        0, 'gun',             '2/1/0/7/7/7/7/2'),
  bld('Spread Shot',    0, 'gun',             '2/0/0/7/7/7/7/3'),
  bld('Gunner Trapper', 0, 'trap snipe',      '0/2/3/7/7/7/7/0'),
  bld('Stalker',        0, 'snipe',           '1/0/2/7/7/7/7/2'),
  bld('Predator',       0, 'snipe',           '0/2/0/7/7/7/7/3'),
  // --- bullet smasher: bullet speed traded away for a wall you can ram behind
  bld('Bullet Wall',    0, 'gun',             '2/3/2/5/7/7/7/0'),
  bld('Max Pen',        0, 'gun trap',        '3/4/5/0/7/7/7/0'),
  bld('Fighter',        0, 'gun',             '0/3/4/0/7/7/7/5'),
  bld('Trap Wall',      0, 'trap',            '7/5/0/0/7/7/7/0'),
  bld('Octo',           0, 'gun',             '2/1/2/7/5/7/7/2'),
  // --- long guns: bullet speed is range, and range is the whole sniper line
  bld('Marksman',       0, 'snipe',           '3/1/3/7/7/7/5/0'),
  bld('Skirmisher',     0, 'snipe gun',       '2/1/2/7/7/7/0/7'),
  bld('Destroyer',      0, 'gun',             '4/1/2/7/7/7/5/0'),
  // --- drones: reload only sets respawn on a capped swarm, so it goes to legs
  bld('Drone Speed',    0, 'drone',           '3/2/0/7/7/7/0/7'),
  bld('Drone Swarm',    0, 'drone',           '0/1/2/7/7/7/2/7'),
  bld('Battleship',     0, 'drone',           '2/3/0/7/7/7/0/7'),
  bld('Necromancer',    0, 'drone',           '2/0/2/7/7/7/7/1'),
  bld('Overtrapper',    0, 'drone trap',      '3/1/3/5/7/7/7/0'),
  bld('Drone Fortress', 0, 'drone gun',       '5/3/4/7/7/7/0/0'),
  // --- bruisers: enough body to answer a rammer without giving up the gun
  bld('Bruiser',        0, 'gun trap',        '0/7/7/5/5/5/4/0'),
  bld('Hybrid',         0, 'gun snipe',       '4/2/4/4/6/6/6/1'),
  // --- rammers: the smasher line, where bullet stats are capped at zero anyway
  bld('Smasher',        1, 'ram',             '3/10/10/0/0/0/0/10'),
  bld('Landmine',       1, 'ram',             '10/10/10/0/0/0/0/3'),
  bld('Speed Ram',      1, 'ram',             '7/8/8/0/0/0/0/10'),
  bld('Ram Hybrid',     1, 'ram',             '3/8/7/2/2/4/0/7'),
  // --- recoil rammers: a gun class that rams by firing away from where it goes
  bld('Recoil Ram',     1, 'gun',             '7/7/7/0/0/0/7/5'),
  bld('Boost Ram',      1, 'gun',             '5/7/7/0/0/0/7/7'),
  bld('Booster',        1, 'gun',             '7/7/7/0/2/0/3/7'),
  bld('Trap Ram',       1, 'trap',            '7/7/7/0/2/2/3/5')
];

// Not everyone copies a build off a wiki. `wild` is how far this bot strays from
// the one it picked: zero for most of them, a couple of traded points for some,
// and a third of the build rearranged for the few who make their own up.
function botVary(b, wild) {
  if (wild <= 0) return b;
  var pts = b.pts.slice(), n = Math.round(wild * 14), i, from, to;
  for (i = 0; i < n; i++) {
    from = (Math.random() * 8) | 0; to = (Math.random() * 8) | 0;
    if (from !== to && pts[from] > 0 && pts[to] < 10) { pts[from]--; pts[to]++; }
  }
  return bld(b.name + '*', b.ram, b.kinds, pts);
}

// Which of the builds this bot likes suits the tank it is driving now. Asked
// again on every class it takes, because that is what a player does: the drone
// build comes out when the Overseer does, not at spawn.
//
// It gives up on a build only when the branch it is standing on cannot reach it
// any more, and that is the whole subtlety here. Asking "which of these fits the
// tank I am in" at spawn answers "the bullet one" every time — a level-1 Tank is
// a gun class — so a bot that wanted drones would drop the drone build before it
// ever saw the Sniper that leads to one, and the entire field would end up
// shooting bullets. Its first pick is its plan; the rest are what it settles for.
function botPickBuild(t) {
  var likes = t.botLikes, i;
  if (!likes || !likes.length) return t.build || pick(BOT_BUILDS);
  var here = KIND_BIT[botKind(TANK_DEFS[t.tankId])] || 0;
  var fits = function (b) { return (b.mask & here) || botBelow(b, t.tankId); };
  var b = (t.build && likes.indexOf(t.build) >= 0) ? t.build : likes[0];
  if (fits(b)) return b;
  for (i = 0; i < likes.length; i++) if (fits(likes[i])) return likes[i];
  return b;
}

// Spend one point. Targets first, in the build's own order; once every target is
// met — a class caps a stat lower, or the build was mutated down under 33 — the
// same order runs again unbounded, so no bot ever strands a point it holds.
function botSpend(t) {
  var b = t.build, o = b.order, i;
  for (i = 0; i < 8; i++) if (t.stats[o[i]] < b.pts[o[i]] && t.upgradeStat(o[i])) return true;
  for (i = 0; i < 8; i++) if (t.upgradeStat(o[i])) return true;
  return false;
}

// Difficulty is one flat bag of numbers, so a custom difficulty is nothing more
// than a lerp between `easy` and `extreme` — see botSkill().
//   react   ticks between target scans; reaction time, in effect
//   lead    0..1 share of the full intercept solution folded into the aim
//   aimErr  radians of drifting aim bias
//   sight   acquisition radius for tanks
//   farm    multiplier on sight when looking for shapes to farm
//   range   preferred distance as a fraction of its own weapon reach — the
//           knob that turns a Sniper into one instead of a bad Machine Gun
//   strafe  orbit component; 0 walks straight in and stands there
//   dodge   weight of the incoming-fire avoidance vector
//   flee    HP fraction that breaks off a fight; 0 never retreats
//   threat  weighs danger and woundedness against distance when picking a target
//   hunt    extra pull toward human players
//   sense   picks a class that fits its build, and repels drones up close
//   wall    steers around maze walls
// Two of these used to run backwards up the ladder, so Extreme lost to Hard in
// a 1v1: a tight fire arc withheld fire exactly when the strafing was best, and
// a rising flee threshold made the strongest bots run from fights they were
// winning. Both are gone — see test-bots.mjs, which now guards the ordering.
var BOT_SKILL = {
  easy:     { label: 'Easy',      react: 16, lead: 0,    aimErr: 0.38,  sight: 900,  farm: 0.55, range: 0.3,  strafe: 0,   dodge: 0,   flee: 0,    threat: 0,   hunt: 0,   sense: 0,    wall: 0 },
  medium:   { label: 'Medium',    react: 9,  lead: 0.35, aimErr: 0.17,  sight: 1300, farm: 0.85, range: 0.4,  strafe: 0.3, dodge: 0.2, flee: 0.18, threat: 0.3, hunt: 0,   sense: 0.4,  wall: 1 },
  hard:     { label: 'Hard',      react: 5,  lead: 0.65, aimErr: 0.08,  sight: 1650, farm: 1,    range: 0.48, strafe: 0.6, dodge: 0.5, flee: 0.22, threat: 0.7, hunt: 0.3, sense: 0.75, wall: 1 },
  veryhard: { label: 'Very Hard', react: 3,  lead: 0.85, aimErr: 0.035, sight: 2000, farm: 1.1,  range: 0.56, strafe: 0.8, dodge: 0.8, flee: 0.25, threat: 1,   hunt: 0.6, sense: 0.95, wall: 1 },
  extreme:  { label: 'Extreme',   react: 2,  lead: 1,    aimErr: 0,     sight: 2500, farm: 1.25, range: 0.64, strafe: 1,   dodge: 1,   flee: 0.28, threat: 1.4, hunt: 1,   sense: 1,    wall: 1 }
};
var BOT_DIFFICULTIES = ['easy', 'medium', 'hard', 'veryhard', 'extreme'];

// Difficulty says how good a bot is. A role says what it wants, which is a
// different question and the one that stops eighty tanks reading the same
// scoreboard and walking to the same place. Rolled once at spawn and never
// changed, so a bot has a personality you can watch across a life.
//   farm   pull of shapes: how far it will walk for food
//   fight  pull of tanks: how readily it crosses the map for a kill
//   prey   preference for the already-wounded over the merely close
//   greed  how deep into its own health bar it will farm
//   flee   scales the break-off threshold; high leaves early, low dies trying
//   ram    build to roll: 1 body-damage, 0 gun, -1 either
var BOT_ROLES = [
  { key: 'farmer',   label: 'Farmer',   farm: 1.7, fight: 0.4, prey: 0.6, greed: 1.2, flee: 1.6, ram: 0 },
  { key: 'hunter',   label: 'Hunter',   farm: 0.6, fight: 1.7, prey: 1.0, greed: 0.9, flee: 0.9, ram: 0 },
  { key: 'brawler',  label: 'Brawler',  farm: 0.9, fight: 1.3, prey: 0.8, greed: 1.4, flee: 0.5, ram: 1 },
  { key: 'assassin', label: 'Assassin', farm: 1.0, fight: 1.1, prey: 2.4, greed: 0.9, flee: 1.8, ram: 0 },
  { key: 'balanced', label: 'Balanced', farm: 1.0, fight: 1.0, prey: 1.0, greed: 1.0, flee: 1.0, ram: -1 }
];
var BOT_ROLE_DEFAULT = BOT_ROLES[BOT_ROLES.length - 1];
function botRole(t) { return t.botRole || BOT_ROLE_DEFAULT; }

// Fourteen knobs is too many dials for a menu, so the custom screen ships six
// sliders and each one drags its group from the easy value to the extreme one.
var BOT_KNOB_GROUPS = [
  { key: 'aim',   label: 'Aim',        blurb: 'accuracy and how far it leads a moving target', knobs: ['lead', 'aimErr'] },
  { key: 'react', label: 'Reflexes',   blurb: 'how fast it spots you and how far it sees',     knobs: ['react', 'sight'] },
  { key: 'dodge', label: 'Dodging',    blurb: 'stepping out of the path of incoming fire',     knobs: ['dodge'] },
  { key: 'move',  label: 'Footwork',   blurb: 'strafing, spacing, and getting around walls',   knobs: ['strafe', 'range', 'wall'] },
  { key: 'aggro', label: 'Aggression', blurb: 'target choice, hunting you, retreating hurt',   knobs: ['threat', 'hunt', 'flee'] },
  { key: 'brain', label: 'Game sense', blurb: 'class choices, farming, drone control',         knobs: ['sense', 'farm'] }
];

// Accepts a difficulty name, or {aim: 0..10, react: 0..10, ...} from the custom menu.
function botSkill(d) {
  if (typeof d === 'string') return BOT_SKILL[d] || BOT_SKILL.medium;
  if (!d || typeof d !== 'object') return BOT_SKILL.medium;
  var lo = BOT_SKILL.easy, hi = BOT_SKILL.extreme, s = { label: d.label || 'Custom' };
  BOT_KNOB_GROUPS.forEach(function (grp) {
    var f = Math.max(0, Math.min(1, (d[grp.key] === undefined ? 5 : d[grp.key]) / 10));
    grp.knobs.forEach(function (k) { s[k] = lo[k] + (hi[k] - lo[k]) * f; });
  });
  s.react = Math.max(1, Math.round(s.react));
  return s;
}

// The same set as BOT_HOMING, keyed by the type the spawner actually writes on
// the entity — a necrodrone comes out as 'necro'. These are the owned things
// that are worth shooting rather than only sidestepping.
var BOT_SWARM = { drone: 1, necro: 1, swarm: 1, minion: 1 };

// Things worth stepping out of the way of. Crashers are not in here because
// they are shapes, not projectiles — botDodge takes them off isCrasher. Drones
// and necro squares are, and stay ordinary incoming fire: they are owned, so
// none of the crasher handling reaches them.
var BOT_INCOMING = { bullet: 1, trap: 1, drone: 1, necro: 1, swarm: 1, minion: 1, skimmer: 1, rocket: 1, glider: 1, firework: 1 };

// A bullet launches at cruise+30 and is then held at its cruise speed, so it
// runs fast for the first few ticks and settles. Rather than invert that in
// closed form — two attempts at which were wrong by 3x in both directions —
// just step the update the simulation itself runs, and count the ticks.
// Returns 0 if the bullet expires before it covers `d`.
function botFlightTicks(t, d) {
  var b = t.barrels[0];
  if (!b) return 0;
  var bd = b.def.bullet;
  var cruise = (20 + BSPEED_GAIN * t.stats[S_BSPEED]) * bd.speed;
  var life = 75 * (bd.lifeLength === -1 || !bd.lifeLength ? 1 : bd.lifeLength);
  // fireBarrel zeroes accel on a trap, so a trap never holds cruise — it coasts
  // down under friction and parks. Stepping one as if it were a bullet said a
  // maxed Trapper threw its trap 49577 units when it actually stops at 705,
  // which is why every Trapper in the game stood a thousand units off leading a
  // shot that was never going to arrive. A trap also leaves at half muzzle speed.
  var coast = bd.type === 'trap';
  var v = (coast ? cruise / 2 : cruise) + 30 - (bd.scatterRate || 0) / 2, x = 0;
  for (var n = 1; n <= life; n++) {
    if (!coast) v += cruise * 0.1;     // maintainVelocity
    x += v;
    v -= v * 0.1;                      // friction
    if (x >= d) return n;
    if (v < 1) break;                  // parked: it gets no further, and neither does this loop
  }
  return 0;
}

// Drones home, so a spawner bolted to the side still delivers everything it
// makes. A bullet or a trap goes where the barrel points and nowhere else, so
// the four thrusters on the back of a Booster never touch what it is shooting
// at. Counting them whole told a Booster it had five barrels of output when it
// has one, and botWinOdds sent it into fights it loses four to one.
var BOT_HOMING = { drone: 1, swarm: 1, minion: 1, necrodrone: 1 };
function botBarrelFacing(d) {
  if (BOT_HOMING[d.bullet.type]) return 1;
  return Math.max(0, Math.cos(d.angle || 0));
}

// What this tank shoots with. Auto 3 and Auto 5 carry no barrels of their own —
// their guns are the turrets — and reading barrels alone priced a five-gun tank
// as a body and sent it charging in at zero range like a Smasher. Cached on the
// tank because the turret list is rebuilt on every class change.
function botGuns(t) {
  if (t.barrels && t.barrels.length) return t.barrels;
  if (!t.turrets || !t.turrets.length) return null;
  if (!t.aiGuns) t.aiGuns = t.turrets.map(function (u) { return u.barrel; });
  return t.aiGuns;
}

// Roughly what this tank puts out per tick. Only ever used as a ratio between
// candidate targets, so the collision multipliers that scale every one of them
// equally are left out.
function botDps(t) {
  // Drones and traps are candidates too now, and they carry neither — they hit
  // with the body, same as a rammer.
  var g = botGuns(t);
  if (!g || !t.stats) return Math.max(1, t.damagePerTick);
  var dps = 0, dmg = 7 + t.stats[S_DAMAGE] * 3;
  for (var i = 0; i < g.length; i++) {
    var b = g[i];
    dps += botBarrelFacing(b.def) * dmg * b.def.bullet.damage * (b.def.pellets || 1) / b.period();
  }
  return Math.max(0.02, dps);          // floor only guards the divide
}

// Is that one pointed at us, and is it shooting? Both are readable off the
// entity: angle is where its barrel points, and a tank holding fire is about to
// put something down that line. Being lined up on is the difference between a
// fight that can be declined and one that has already started.
function botAimedAt(o, t) {
  if (o.angle === undefined) return false;
  return Math.abs(angleDiff(o.angle, Math.atan2(t.y - o.y, t.x - o.x))) < 0.45;
}
function botShootingAt(o, t) {
  var firing = o.type === 'boss' || !!(o.input && (o.input.fire || o.autoFire));
  return firing && botAimedAt(o, t);
}

// A body-damage tank never fires and does not need to point at anything — a
// Smasher aims where it is going, not at you. What makes it dangerous is that
// it is closing and that touching it hurts. Reading threat off barrels alone
// made the entire Smasher line invisible: bots farmed on while one walked up.
function botClosing(o, t) {
  var dx = t.x - o.x, dy = t.y - o.y, d = Math.hypot(dx, dy) || 1;
  return (o.vx * dx + o.vy * dy) / d > 3;                  // units a tick of approach
}
function botThreatens(o, t) {
  if (botShootingAt(o, t)) return true;
  return !!(o.barrels && o.barrels.length === 0) && botClosing(o, t);
}

// Who wins the damage race. Levels and health bars were only ever a proxy for
// this; the race itself is the thing, and it is the question the bot is really
// asking when it decides whether to take a fight.
function botWinOdds(t, o) {
  var mine = botDps(t), theirs = botDps(o);
  // Body damage is only collected on contact, so a rammer's threat is really a
  // question of whether it can catch you. Counting it as continuous made bots
  // back away from Smashers they could comfortably have kited to death.
  if (o.barrels && o.barrels.length === 0)
    theirs *= Math.max(0.15, Math.min(1.4, o.movementSpeed / Math.max(0.01, t.movementSpeed)));
  var killThem = o.health / Math.max(0.01, mine);
  var killMe = t.health / Math.max(0.01, theirs);
  return killMe / (killMe + killThem);
}

// A kill pays KILL_SCORE_SHARE of what the loser was carrying, so a fight is no
// longer a pure cost — but most tanks are carrying very little, and losing still
// resets you to respawnLevel, so shapes remain the reliable economy. A sharp bot
// fights when the fight is already on it, when it is winning cheaply, when a
// human is in front of it, or when it has nothing left to level for, and
// otherwise walks away and farms.
function botShouldFight(t, tgt, sk) {
  // Nothing left to farm for, so the bar drops to almost nothing — but not to
  // nothing. A fight it is visibly losing still costs a level 45 bot every point
  // it spent a whole life collecting, which is how the strongest tanks on the
  // board ended up with the shortest lives.
  if (t.level >= t.game.levelCap() - 2) return botWinOdds(t, tgt) > 0.25;
  // How readily the odds talk it out of something. At zero it charges whatever
  // it can see, which is most of what being an easy bot means. The role divides
  // it: a Farmer wants a much surer thing than a Hunter does before it stops
  // levelling to go and take a fight.
  var role = botRole(t);
  var floor = 0.45 * sk.sense / role.fight;
  var odds = botWinOdds(t, tgt);
  // Being lined up on is not a fight that can be declined politely — walking
  // away just means eating the shots side-on. Answer unless it is hopeless.
  if (botThreatens(tgt, t) && dist2(t, tgt) < Math.pow(botReach(tgt) * 1.2, 2)) return odds > floor * 0.7;
  // Taking fire, and it is actually costing something. Without the health test
  // a single stray pellet in a crowded arena reads as "I am in a fight", every
  // bot answers, and nobody ever gets back to farming.
  if (t.game.tick - t.lastDamage < 50 && t.health < t.maxHealth * 0.85) return odds > floor * 0.7;
  // Winning it cheaply. Role-divided like the floor, and for the same reason:
  // without this the escape hatch swallowed the whole personality — every role
  // took every fight it was ahead in, which is most fights.
  if (odds > Math.min(0.9, (0.5 + 0.2 * sk.sense) / role.fight)) return true;
  if (tgt.isPlayer && sk.hunt >= 0.5 && odds > floor) return true;
  // How far it will cross to pick a fight. Two things set it: skill, because a
  // dumb bot charges anything it can see and a sharp one only what is already
  // on it — and whether that tank is even looking this way. Something with its
  // barrel pointed elsewhere is a thing to walk around, not a fight.
  var range = botReach(t) * (2.2 - 1.4 * sk.sense) * role.fight
    * (botAimedAt(tgt, t) || botThreatens(tgt, t) ? 1.5 : 0.85);
  return odds > floor && dist2(t, tgt) < range * range;
}

// Not how far a bullet *can* go — a basic Tank's carries 1750 units, and a shot
// with three seconds of hang time hits nothing that moves. This is how far it
// can go and still arrive while the target is roughly where you aimed: one
// second of flight. That is the range bots actually fight at.
function botReach(t) {
  var g = botGuns(t), b = g && g[0];
  if (!b || !t.stats) return 0;
  var bd = b.def.bullet;
  var cruise = (20 + BSPEED_GAIN * t.stats[S_BSPEED]) * bd.speed;
  if (bd.type !== 'trap') return cruise * 25 + 250;
  // A trap is the other case: it never gets a second of flight because it stops
  // long before one. Its reach is simply where it comes to rest, and it leaves the
  // barrel at half muzzle speed.
  var life = 75 * (bd.lifeLength === -1 || !bd.lifeLength ? 1 : bd.lifeLength);
  var v = cruise / 2 + 30, x = 0;
  for (var n = 1; n <= life && v >= 1; n++) { x += v; v -= v * 0.1; }
  return x;
}

// Far enough away to stop being our problem: outside both guns, with margin —
// and outside what the bot can see, because whatever it can see it can pick up
// again. A release line inside its own sight is a release and a re-acquire every
// tick, and a gun that snaps back and forth while the two fight over it.
function botClear2(t, o, sk) {
  var r = Math.max(botReach(t), botReach(o)) * 1.4 + 250;
  return Math.max(r * r, sk.sight * sk.sight);
}

// Where to point. Drones steer themselves at the mouse every tick, so leading
// them is not just wasted, it is wrong — they get the target's actual position.
// ponytail: not interceptAim. That closed form is the turrets' and its
// fixed-point iteration does not converge at the ranges and bullet speeds bots
// fire at — measured, it lands on zero lead at 300 units. Stepping the
// simulation is slower and right.
function botAim(t, goal, sk) {
  var dx = goal.x - t.x, dy = goal.y - t.y;
  var to = Math.atan2(dy, dx);
  if (!sk.lead || t.aiDrone) return to;
  var n = botFlightTicks(t, Math.hypot(dx, dy));
  if (!n) return to;
  // The target moves while the bullet is in the air, which moves the distance,
  // which moves the flight time. If that second point is out of range the
  // target is simply outrunning the shot: take the direct shot rather than
  // walking the barrel out to a spot nothing will ever occupy, which is what a
  // runaway lead looks like from the other end of it.
  var n2 = botFlightTicks(t, Math.hypot(dx + goal.vx * n, dy + goal.vy * n));
  if (!n2) return to;
  return Math.atan2(dy + goal.vy * n2 * sk.lead, dx + goal.vx * n2 * sk.lead);
}

// Cached on every class change: both answers are read every tick.
function botClassify(t) {
  var d = TANK_DEFS[t.tankId];
  t.aiGuns = null;                                // turret list is rebuilt per class
  // A rammer is a class with no gun at all, which is not the same as a class with
  // no barrels: Auto 3 and Auto 5 have five between them, mounted on turrets.
  t.rammer = botKind(d) === 'ram';
  t.aiDrone = d.barrels.some(function (b) { return !!BOT_HOMING[b.bullet.type]; });
  t.claimsSquares = !!d.flags.canClaimSquares;    // Necromancer: a Square is a drone
  t.zoomer = !!d.flags.zoomAbility;               // Predator: right-click moves the camera
  // fieldFactor is a real zoom-out. A Ranger's camera covers ~40% more ground
  // than a Tank's, and a flat sight radius meant no bot ever got the awareness
  // its class pays for — the whole sniper line saw exactly as far as a Twin.
  t.sightScale = 1 / (d.fieldFactor || 1);
}

// Full credit for a class that is what the build wants, half for one that opens
// the branch it lives on. Without the second half a drone build could never get
// to a drone: nothing at level 15 is a drone tank, so it would take the Twin
// with the most barrels every time and never see an Overseer.
function botFit(d, build) {
  if (build.mask & (KIND_BIT[botKind(d)] || 0)) return 12;
  var n = botBelow(build, d.id);
  return n ? Math.min(9, 2 + n) : 0;            // capped under 12: here beats later
}

// Does this class suit the stat build the bot committed to? A rammer build
// upgrading into a Sniper wastes both halves of itself — and so does a drone
// build on a Penta Shot, which is the half this used to miss.
function botClassScore(d, build) {
  if (!d) return -Infinity;
  var fit = botFit(d, build);
  // A ram build is not only a Smasher thing: the Tri-Angle line rams on its own
  // recoil, so thrust counts and a Booster is a real answer to a ram roll.
  if (build.ram) return fit + botThrust(d) * 3 + d.speed * 2 + d.maxHealth * 0.02;
  // Effective barrels, not a headcount: the same facing weight botDps uses. A
  // headcount ranked a Booster's four thrusters and a Quad Tank's three side
  // guns as real output, so gun builds kept upgrading into classes that shoot
  // everywhere except at the thing in front of them.
  var n = 0;
  for (var i = 0; i < d.barrels.length; i++) n += botBarrelFacing(d.barrels[i]);
  // ponytail: still a proxy — it prices where a barrel points, not how hard it
  // hits. Real per-class DPS needs a drone model (a drone's worth is its time
  // alive, not its spawn reload), which is a bigger job with no ground truth.
  return (botKind(d) === 'ram' ? -12 : 6 + Math.min(n, 6)) + fit + d.maxHealth * 0.01;
}

// What a bot is willing to spend on a shape — health above the reserve it keeps
// for a fight. Goes negative when it is hurt, which is the point: at that stage
// nothing on the field is worth touching and it should be shooting from range
// and regenerating instead. A greedy role keeps a thinner reserve, but the
// clamp keeps even the greediest one from calling its last sliver spendable.
function botFarmBudget(t) {
  var r = FARM_HP_RESERVE / botRole(t).greed;
  return t.health - t.maxHealth * Math.max(0.25, Math.min(0.8, r));
}

// What one tick of contact with `e` takes off `t`. The multiplier is read off
// the pair rather than assumed, and vs a shape it comes out at 4 — a Square
// hits a tank for 8, an Alpha Pentagon for 20. That factor is what the old cost
// model was missing in both directions at once, and it is most of why bots
// strolled into their own food and died there. Symmetric, so swapping the
// arguments gives what the tank's body puts back into the shape.
function botTouch(t, e) {
  return e.damagePerTick * Math.max(t.minDmg, e.minDmg) * Math.min(t.maxDmg, e.maxDmg);
}

// Contact is intermittent: a collision shoves both parties apart and the tank
// has to drive back in, so nothing like every tick of a kill is spent touching.
// Both figures are measured in a live arena, over bot-ticks spent overlapping
// the shape being farmed. CONTACT is deliberate ramming, where the tank keeps
// shoving the shape rather than bouncing off it. KITE is the residue: a bot
// standing off and shooting still drifts into its dinner now and then, and over
// a long job that adds up — which is the whole reason a small tank should not
// park in front of a Pentagon for eleven seconds.
// ponytail: one number each for something that varies with class and speed.
// Split per class if rammers ever look too timid or too suicidal.
var CONTACT_SHARE = 0.1;
var KITE_SHARE = 0.02;
// Touches of margin to keep in hand before closing on anything. Damage lands the
// tick contact happens and the push-off needs a tick or two to open the gap
// again, so "it only just fails to kill me" is not a margin.
var CONTACT_TOUCHES = 4;
// Half a minute of chewing is the line between a fat target and a trap.
var FARM_SLOG_TICKS = 900;
// Steering off shapes it is not eating: the share of its remaining bar one
// bounce has to cost before it is worth going around. Swept against a live
// arena from 0.05 to 0.9 — shape deaths, total deaths and mean level all moved
// less than the run-to-run noise, so this is a threshold with a meaning rather
// than a tuned number, and a quarter of the bar is the meaning.
var SHOVE_MIN = 0.25;
// The share of the bar is not the only reason to go around, and on its own it is
// what put bots inside the Pentagon Nest. A Hexagon graze on a level 45 tank
// prices at 8% and reads as free — but base regen is a 17-minute bar and the only
// heal worth having wants HYPER_REGEN_DELAY clean ticks, so that 8% is gone for
// the rest of the life and the graze also restarts the clock on getting it back.
// The second question is whether the shape is still going to be there: a Square
// pops under the bot's own body on the first tick of contact and a Crasher on the
// second, so a field of them is walkable ground, while a Hexagon carries 1500 HP
// and is still charging after the fourth bounce. This is how many ticks of body
// damage a shape has to survive to be worth a detour at any health, and two is
// "it does not pop on contact". Measured across an FFA before this: Hexagons and
// Alphas were 12% of all shape damage taken, at 0% of it spent on one the bot was
// actually farming — every point paid for nothing.
var SHOVE_POP = 2;
// How hard to swerve once it has decided to. Rises with what the bounce costs
// against the bar it has left, but never falls to nothing — the pursuit vector it
// competes with is a unit vector, so a swerve worth making has to be worth about
// as much.
var SHOVE_FLOOR = 0.3;

// There are two ways to eat a shape and they have different bills.
//   kite  stand at gun range and shoot: costs time and nothing else
//   ram   close to contact: body damage joins in at the same 4x multiplier, so
//         a tank puts 4 * (5 + its body stat) into the shape every tick it is
//         touching — and the shape charges its own touch back over those same
//         seconds, less whatever regen covers
// Picking between them is the body-damage/health/regen question asked in health
// instead of in stat points, and it is the whole difference between farming a
// Pentagon and walking into one at 8 HP. A body build closes because closing is
// what it is for; a glass sniper stands off, because for it the same contact is
// most of its bar.
function botContact(t, e) {
  var b0 = t.barrels[0], gun = b0 ? botDps(t) : 0;
  // Bullets are absorbed by what they hit, so a fat shape eats a growing share
  // of each one; penetration is what buys that back.
  var pen = Math.max(0.5, (1.5 * t.stats[S_PEN] + 2) * (b0 ? b0.def.bullet.health : 1));
  var drag = 1 + e.health / (pen * 200);
  var touch = botTouch(t, e), mine = botTouch(e, t);
  var c = {
    touch: touch,
    kite: gun > 0 ? e.health / gun * drag : Infinity,
    ram: e.health / Math.max(0.01, gun + mine * CONTACT_SHARE) * drag
  };
  c.ramCost = Math.max(0, (touch * CONTACT_SHARE - t.regenPerTick) * c.ram);
  // Survivable a touch at a time, affordable out of health it can spare, and
  // worth the walk in the first place. A rammer has no second option, so the
  // last test is moot for it — but the first two still hold, which is what
  // stops a Smasher at 5 HP shouldering a Pentagon.
  c.close = t.health > touch * CONTACT_TOUCHES
    && c.ramCost < botFarmBudget(t)
    && (!b0 || c.ram < c.kite * 0.7);
  // The bill is the plan's, not the worst plan's. Charging a kite the price of
  // a ram is how a level 45 tank talked itself out of a Hexagon it could have
  // shot down from across the room without being touched once.
  c.ticks = c.close ? c.ram : c.kite;
  c.cost = c.close ? c.ramCost : Math.max(0, (touch * KITE_SHARE - t.regenPerTick) * c.kite);
  return c;
}
// Whether to close at all. The rate model on its own never answers this: a bot
// at 6 HP dies to one touch of a Square however favourable the trade reads per
// tick. Measured before this existed — every bot a shape killed was under 15%
// health and still driving into one.
function botCanTank(t, e) { return botContact(t, e).close; }

// One pass answers both questions: who to fight, and what to farm if nobody.
// Predator's zoom moves the view, it does not widen it — the camera hops up to
// PREDATOR_ZOOM units along the barrel and shows the same screen from there. So
// this asks the sight question from the shifted point rather than handing the
// bot a bigger circle, which would be a different and unearned thing.
function botZoomSees(t, e, zx, zy, sight2) {
  if (!zx && !zy) return false;
  var dx = e.x - t.x - zx, dy = e.y - t.y - zy;
  return dx * dx + dy * dy <= sight2;
}

function botScan(t, sk, doShapes) {
  var g = t.game, i, e;
  var sight = sk.sight * (t.sightScale || 1);
  var sight2 = sight * sight;
  var zx = 0, zy = 0;
  if (t.zoomer && t.input.altFire) { zx = Math.cos(t.angle) * PREDATOR_ZOOM; zy = Math.sin(t.angle) * PREDATOR_ZOOM; }
  // No farm radius. Distance is already priced in the value below, and a hard
  // cutoff made the pick flip on whether anything at all happened to fall inside
  // it. The farm knob sets how dearly the walk is charged instead — and it runs
  // this way round, not the other: undervaluing your own time is the dumb
  // mistake. A low weight sends a bot trekking after distant fat shapes, which
  // is where it wastes minutes and where it gets killed. Sharp bots clear what
  // is under them.
  // A farmer will cross ground for a fat shape that a hunter would not look at.
  var role = botRole(t);
  var walk = (1.2 + 2.4 * sk.farm) / role.farm;
  // Pricing every shape in the arena costs a bot 1000 square roots per scan,
  // which at 28 bots and a two-tick react window ate 96% of the frame. Cull at
  // a radius wide enough that the choice never turns on it — a few hundred
  // candidates — and keep the nearest one as a floor so the list is never empty.
  var cull2 = 3000 * 3000, nearS = null, nearD = Infinity;
  var speed = Math.max(1, t.movementSpeed * 10);   // terminal speed under 10% friction
  var bestT = null, bestTS = -Infinity, bestS = null, bestSS = -Infinity, bestAtUs = false;
  var reach2 = Math.pow(botReach(t), 2);           // 0 for a rammer: no gun, no answer to a swarm
  var hitter = g.tick - t.lastDamage < 120 ? t.lastHitBy : null;   // whoever last landed one
  var budget = botFarmBudget(t);

  for (i = 0; i < g.entities.length; i++) {
    e = g.entities[i];
    if (e === t || e.dead || e.sides === 0) continue;
    if (e.team !== null && e.team === t.team) continue;
    // Everything with an owner used to be skipped outright here, which meant no
    // bot had ever fired a shot at a drone. There is no other answer to a swarm:
    // it homes, it persists, and dodging an Overlord's eight forever is only
    // losing slowly. Bullets outrun the answer and a parked trap gets walked
    // around, so only the homing set is worth the trigger time.
    var drone = false, own = null;
    if (e.owner) {
      if (!BOT_SWARM[e.type]) continue;
      own = e.owner; while (own.owner) own = own.owner;
      if (own === t || (own.team !== null && own.team === t.team)) continue;
      drone = true;
    }
    var shape = e.type === 'shape';
    if (shape && !doShapes) continue;
    if (!shape && !drone && e.type !== 'tank' && e.type !== 'boss') continue;
    var d2 = dist2(t, e);
    if (drone) {
      // Only the one already on top of us, and only while it is still closing —
      // chasing a drone across the map is how you get shot by the thing that
      // sent it. And never while its owner is the nearer target: killing the
      // spawner is what actually ends a swarm.
      if (d2 > reach2 || !botClosing(e, t)) continue;
      if (!own.dead && dist2(t, own) < d2) continue;
      var dts = sk.threat * 1.5 - Math.sqrt(d2) / 400;
      if (dts > bestTS) { bestTS = dts; bestT = e; bestAtUs = true; }
      continue;
    }
    if (shape) {
      if (e.id === t.farmBan) continue;                        // tried it, got nowhere
      if (e.kind === 'alpha' && t.level < 25) continue;
      if (d2 < nearD) { nearD = d2; nearS = e; }
      if (d2 > cull2) continue;
      // Measured: a level 30 bot cracks a Hexagon in 235 ticks and a level 15
      // one never does at all. A heavy penalty, not a disqualification —
      // excluding outright left bots with an empty list, and a bot with nothing
      // to shoot at wanders in a random new direction every 90 ticks with its
      // gun silent, which from across the map reads as a broken tank.
      var c = botContact(t, e);
      var over = c.ticks > FARM_SLOG_TICKS ? 0.02 : 1;
      // Value per tick, not value per metre. A level 2 bot grinding a 1500 HP
      // Hexagon earns far less than the same seconds spent on 10 HP Squares,
      // and pricing the kill time says so. As its damage grows the big shapes
      // come back on the menu by themselves — no level gates to hand-tune.
      // The walk is charged above its face value because it earns nothing and
      // is the part of farming that gets you killed, so a Square underfoot beats
      // a Pentagon two screens away even though the Pentagon pays better a shot.
      var kill = c.ticks;
      // And what the attempt costs in health. Rate alone says a Pentagon always
      // beats a Square — it pays 13x for 13x the work — but a small tank spends
      // five minutes pressed against something that hits for 3, which is why
      // low-level bots were dying on the farm. Weighing exposure against its own
      // health pool is what produces Squares, then Triangles, then Pentagons,
      // with no per-level table anywhere.
      // Against the health it has spare, not the bar it would have at full. The
      // old line read the same on a bot at 10% as on a fresh one, which is how
      // they ended up walking into a Hexagon they could not survive.
      // Same penalty shape as `over`: heavy, not disqualifying. Something it
      // cannot survive closing on is still worth shooting from range if it is
      // the only thing on the field, and an empty list is what leaves a bot
      // pacing with its gun off. This is the cliff — one touch it cannot take,
      // or a bill bigger than its whole spendable bar — and `risk` below is the
      // slope that orders the ones it can afford.
      var risk = c.cost / Math.max(1, budget);
      // The residual danger in merely picking something as a destination: one
      // touch that takes most of the bar. Standing off is safe, but shapes
      // drift and crashers chase, so at that health something else is better.
      var safe = t.health > c.touch * CONTACT_TOUCHES ? 1 : 0.05;
      var ss = safe * over * (e.scoreReward || 1) / ((walk * Math.sqrt(d2) / speed + kill) * (1 + risk));
      // A Necromancer does not eat a Square, it recruits it — that conversion is
      // the entire class, and pricing a Square at its score left Necromancer bots
      // grinding Pentagons with an empty drone bar and nothing to fight with.
      if (t.claimsSquares && e.kind === 'square') ss *= 8;
      // A crasher that has locked onto this bot is not really food — it closes
      // on its own at 26 units a tick and the bill arrives whether or not the
      // bot ever chose it. Priced as a shape it loses to whatever Square is
      // underfoot, which is how bots ended up eaten by the mid-map belt. So
      // shoot the thing that is coming, then go back to dinner. Only the one
      // hunting *us*: a crasher crossing the field is an ordinary shape, and
      // the shove pass below is what keeps the bot out of it.
      if (e.isCrasher && e.target === t) ss *= 50;
      if (ss > bestSS) { bestSS = ss; bestS = e; }
      continue;
    }
    // Sight is how far it goes looking for a fight, not how far it can be shot
    // from. A high level gun out-ranges a low tier bot's whole awareness, so
    // dropping distant tanks here blinded it to the one killing it: nothing to
    // latch, nothing to answer, back to the Squares. Being hit is noticing.
    // ponytail: a shot has to land before it notices someone out there — a bot
    // being missed from beyond its sight still knows nothing. Read owners off the
    // incoming bullets in botDodge if that gap ever matters.
    // A globally-marked target is never out of sight. Juggernaut hangs its
    // whole design on the arena converging on one tank, and a bot that cannot
    // see across the map simply farms instead.
    var globalMark = g.bountyGlobal && e === g.bountyTarget && e !== t
      && !(e.team !== null && e.team === t.team);
    if (!globalMark && d2 > sight2 && e !== t.aiEngaged && !(e === hitter && d2 < botClear2(t, e, sk))
        && !botZoomSees(t, e, zx, zy, sight2)) continue;
    if (e.opacity <= 0 && !t.seesInvisible) continue;          // a hidden Stalker is not there
    // Whoever is on us, plus whoever was and has not left yet — tickBot holds
    // the latch through the gaps between their shots. A fight already happening
    // is not a choice, so the odds do not get to price it: out-level a bot and
    // the punching-up penalty below used to rank you under a passing Square.
    var atUs = e === t.aiEngaged || e === hitter || botThreatens(e, t);
    var gap = (e.level || t.game.levelCap()) - t.level;
    // A mode can name one entity as the thing everyone is supposed to be
    // shooting at (the Juggernaut, the bomb carrier, the crowned leader). It
    // outbids the ordinary scoring hard, because "everyone piles on" IS the
    // mode — an unmarked juggernaut just farms the field.
    // `e.team !== t.team` alone is false in an FFA mode, where every team is
    // null — which is exactly where the Juggernaut lives. Mark anything that is
    // not a team mate.
    var mark = (e === t.game.bountyTarget && e !== t && !(e.team !== null && e.team === t.team))
      ? (g.bountyGlobal ? 1e4 : 9 + sk.threat * 3) : 0;
    var ts = -Math.sqrt(d2) / 400
      - (atUs || mark ? 0 : sk.threat * Math.max(0, gap) * 0.22)       // punching up is how bots die
      + sk.threat * (1 - e.health / e.maxHealth) * 2 * role.prey   // finish what is already hurt
      + (e.isPlayer ? sk.hunt * role.fight : 0)
      + (e.type === 'boss' ? sk.threat - 4 : 0)
      + mark
      + (atUs ? sk.threat * (1.5 + Math.max(0, gap) * 0.08) : 0);   // answer whoever is coming for us,
    // and the bigger one first. Among fights already happening the level gap is
    // not a reason to stay out — it is which one is about to kill us.
    // Out of our league — but only worth ignoring if it is also far away and
    // minding its own business. Dropping it from the scan outright is what let
    // a big Smasher walk all the way in without the bot ever reacting.
    if (sk.threat && gap > 12 && ts < 0 && !atUs && !mark
        && d2 > Math.pow(botReach(t) * 1.5, 2)) continue;
    if (ts > bestTS) { bestTS = ts; bestT = e; bestAtUs = atUs; }
  }
  t.aiTarget = bestT;
  // The latch follows the pick whenever the pick is something that is actually
  // fighting us. First-come let one stray bot lining up somewhere behind hold
  // the slot while the player stood in front of us; the score already weighs
  // distance, woundedness and who is coming for us, so it is the better answer.
  if (bestAtUs) t.aiEngaged = bestT;
  // The fallback is whatever is nearest, for the arena corner where nothing
  // scored. What it costs to touch is asked again in tickBot against live
  // health, so the fallback needs no price of its own.
  if (doShapes) t.aiFarm = bestS || nearS;
}

// Accumulate a push away from anything already in the air that is going to
// connect. The broadphase grid is one tick stale here, which at bullet speeds
// is a rounding error.
function botDodge(t, sk, mv) {
  if (!sk.dodge) return;
  // How far ahead it reads the shot. This has to scale with skill too: a fixed
  // horizon means a maxed dodge knob only pushes harder on threats it already
  // saw, which is why the top tiers used to be indistinguishable in a duel.
  var g = t.game, stamp = g.tick * 65537 + t.id, horizon = 10 + 14 * sk.dodge;
  g.nearby(t.x, t.y, 300 + 260 * sk.dodge, function (p) {
    if (p.seenBy === stamp) return;
    p.seenBy = stamp;
    if (p.dead || p.owner === t || !(BOT_INCOMING[p.type] || p.isCrasher)) return;
    if (p.team !== null && p.team === t.team) return;
    var dx = p.x - t.x, dy = p.y - t.y, vx = p.vx, vy = p.vy;
    var vv = vx * vx + vy * vy;
    if (vv < 1) return;                                        // parked trap, walk around it instead
    var tc = -(dx * vx + dy * vy) / vv;                         // ticks to closest approach
    if (tc < 0 || tc > horizon) return;                         // behind us, or not our problem yet
    var cx = dx + vx * tc, cy = dy + vy * tc;
    var miss = Math.hypot(cx, cy);
    if (miss > t.size + p.size + 20) return;                    // already going wide
    var w = (1 - tc / horizon) * sk.dodge * 2.2;
    if (miss < 1) { var s = Math.sqrt(vv); mv.x -= vy / s * w; mv.y += vx / s * w; }  // dead on: sidestep
    else { mv.x -= cx / miss * w; mv.y -= cy / miss * w; }
  });
}

// Line of sight against maze walls. Bots used to shoot straight through them:
// the bullet dies on the wall, so the shot is pure noise plus a muzzle flash
// telling the other side of the corridor exactly where they are. Asked only
// about the one thing already picked, so it costs one wall sweep per bot per
// tick rather than one per candidate, and nothing at all outside Maze and the
// CTF barrier, where g.walls is empty. Segment vs AABB by slab clipping.
function botLOS(t, e) {
  var w = t.game.walls;
  if (!w.length) return true;
  var dx = e.x - t.x, dy = e.y - t.y;
  for (var i = 0; i < w.length; i++) {
    var r = w[i], lo = 0, hi = 1, a, b, k;
    if (dx === 0) { if (Math.abs(t.x - r.x) > r.size) continue; }
    else {
      a = (r.x - r.size - t.x) / dx; b = (r.x + r.size - t.x) / dx;
      if (a > b) { k = a; a = b; b = k; }
      if (a > lo) lo = a;
      if (b < hi) hi = b;
      if (lo > hi) continue;
    }
    if (dy === 0) { if (Math.abs(t.y - r.y) > r.width) continue; }
    else {
      a = (r.y - r.width - t.y) / dy; b = (r.y + r.width - t.y) / dy;
      if (a > b) { k = a; a = b; b = k; }
      if (a > lo) lo = a;
      if (b < hi) hi = b;
      if (lo > hi) continue;
    }
    return false;
  }
  return true;
}

function tickBot(t) {
  var g = t.game, sk = t.botSkill || g.botSkill || BOT_SKILL.medium, i = t.input, k;
  if (!t.build || !t.build.pts) t.build = pick(BOT_BUILDS);
  if (t.aiTankId !== t.tankId) { botClassify(t); t.aiTankId = t.tankId; }   // upgrades, /clone, /class
  // Let go on distance and nothing else. Reading the engagement off botThreatens
  // every tick meant it blinked out the moment you released fire or turned a few
  // degrees, and the bot strolled back to its Square with you still shooting it
  // in the back. Now it keeps firing, backing away, until you are clear of both
  // guns. Released before the scan runs, or the scan re-reads the fight it is
  // about to drop and latches it straight back on.
  var eng = t.aiEngaged;
  if (eng && (eng.dead || (eng.opacity <= 0 && !t.seesInvisible) || dist2(t, eng) > botClear2(t, eng, sk)))
    t.aiEngaged = null;
  // The react window is how long it takes to notice something new, not how long
  // it stands there after its target dies — waiting one out with nothing to
  // shoot at is most of what a broken-looking tank is doing. So scan on schedule
  // and also the moment the goal is gone.
  var lostTank = !t.aiTarget || t.aiTarget.dead;
  var lostFarm = !t.aiFarm || t.aiFarm.dead;
  // Shapes are a thousand entities to price and they do not move much, so they
  // get a lazier cadence than the reaction window — but an immediate look the
  // moment the one being chewed on dies, or the bot stands there with its gun off.
  // A mode can take farming off the table entirely. In Juggernaut there is one
  // thing to do and standing in a field of Squares is not it.
  var doShapes = (g.rule('botFarm', 1) !== 0) && (lostFarm || g.tick % 15 === t.id % 15);
  if (g.rule('botFarm', 1) === 0) { t.aiFarm = null; t.farmBan = 0; }
  if (lostTank || lostFarm || doShapes || g.tick % sk.react === t.id % sk.react) {
    botScan(t, sk, doShapes);
    // What the mode wants of it, refreshed on the same schedule — sweeping 64
    // Breakout tiles every tick for eighty bots is not worth a fresher answer.
    t.aiObjective = (g.logic && g.logic.botGoal && sk.sense >= 0.4) ? g.logic.botGoal(g, t) : null;
  }
  eng = t.aiEngaged;                             // the scan may have just picked one up

  var tgt = t.aiTarget && !t.aiTarget.dead ? t.aiTarget : null;
  var farmable = t.aiFarm && !t.aiFarm.dead ? t.aiFarm : null;
  // A fight it does not have to take is time it is not spending levelling —
  // but declining is not the same as ignoring. Something already closing on us
  // stays the target: the bot keeps shooting it and backs off, which is what to
  // do about a Smasher it cannot out-trade. Turning its back is how it dies.
  var backOff = false;
  if (tgt && farmable && !botShouldFight(t, tgt, sk)) {
    if (tgt === eng) backOff = true;
    else if (eng) { tgt = eng; backOff = true; }  // declined that one; this one is still on us
    else tgt = null;
  }

  // Break off while hurt and come back once the regen has done its work. The
  // gap between the two thresholds stops it flip-flopping on the line, and the
  // level check stops it fleeing a cripple it was two shots from finishing.
  var fleeAt = Math.min(0.6, sk.flee * botRole(t).flee);
  if (tgt && fleeAt && (tgt.level || t.game.levelCap()) >= t.level - 4) {
    if (t.health < t.maxHealth * fleeAt) t.fleeing = true;
    else if (t.health > t.maxHealth * 0.75) t.fleeing = false;
  } else t.fleeing = false;
  if (backOff) t.fleeing = true;                 // fighting retreat, not a turned back

  // Base regen is a 17-minute bar on a build that skipped the stat, so the only
  // heal worth having is hyper-regen, and that wants HYPER_REGEN_DELAY clean
  // ticks. What breaks the clean run is being *hit* — lastDamage is the only
  // thing that moves it. Firing does not, which the first cut of this got wrong
  // and paid for by dropping the goal entirely: measured at up to 45 seconds of
  // a bot walking a straight line with its gun off, which is exactly the "that
  // tank looks broken" report. So healing declines tank fights and keeps its
  // distance — it does not stop playing. Shapes stay on the menu, shot from
  // range, because the spacing rule above already refuses to touch anything at
  // this health.
  // The entry gate is "nothing has landed on me lately", not aiEngaged: that
  // latch holds all the way out to sight range and is set 74% of the time in a
  // crowd, which switched this off entirely on the first cut. Being locked onto
  // from 1200 units away is exactly the case where walking off works.
  // ponytail: 60 and 25 are eyeballed; every value from 50 to 150 measured the
  // same inside run-to-run noise, so there is nothing finer to tune them against
  // without a seeded arena.
  var clean = g.tick - t.lastDamage;
  if (t.regening) {
    // Patched up, or the run plainly is not working: something is still landing
    // hits, so standing off is only dying slower and the fight is better taken.
    // Instant when the thing hitting us is latched on — four seconds of refusing
    // to shoot back at a tank that is visibly on us is its own kind of broken —
    // and on a timer for chip damage from something it never picked up.
    if (t.health > t.maxHealth * 0.75
        || (clean < 25 && (t.aiEngaged || g.tick - t.regenSince > 100))) t.regening = false;
  } else if (t.health < t.maxHealth * REGEN_HP_WAIT && clean > 60) {
    t.regening = true; t.regenSince = g.tick;
  }
  if (t.regening) {
    tgt = null;                                  // no tank fights until the bar is back
    t.fleeing = false;
    // Toward the empty part of the map, not just away from the last shot. Being
    // hurt is what puts a bot at the top of everyone's target list (botScan pays
    // 2x for a wounded one), so a retreat that only backs off one hunter walks
    // straight into the next. Measured: healthy bots clear the 30s line a third
    // of the time, hurt ones 0.1% — the gap is entirely about who is nearby.
    // Sticky heading, so this sweep runs a tenth as often as the retreat does.
    if (t.wander === undefined || g.tick % 10 === t.id % 10) {
      var rx = 0, ry = 0, tag = g.tick * 24593 + t.id;
      g.nearby(t.x, t.y, 1000, function (o) {
        if (o.fledBy === tag) return;
        o.fledBy = tag;
        if (o === t || o.dead || o.owner || (o.type !== 'tank' && o.type !== 'boss')) return;
        if (o.team !== null && o.team === t.team) return;
        var dx = t.x - o.x, dy = t.y - o.y, d2 = dx * dx + dy * dy;
        if (d2 < 1) return;
        rx += dx / d2; ry += dy / d2;             // inverse-square: the close one decides
      });
      if (rx || ry) t.wander = Math.atan2(ry, rx);
      else if (t.lastHitBy && !t.lastHitBy.dead) t.wander = Math.atan2(t.y - t.lastHitBy.y, t.x - t.lastHitBy.x);
      else t.wander = undefined;                  // nobody to leave; let the farm pick the heading
    }
  }

  // Whether a given class can actually crack a given shape is a question about
  // bullet penetration, body damage and regeneration that is not worth
  // modelling — and getting it wrong strands a bot forever. So just watch the
  // health bar: eight seconds of fire for less than a quarter of it is not a
  // long job, it is an impossible one. A level 15 bot cannot kill a Hexagon at
  // all, and this notices without needing to know why.
  if (!tgt && farmable) {
    if (t.farmId !== farmable.id) { t.farmId = farmable.id; t.farmHp = farmable.health; t.farmSince = g.tick; }
    else if (g.tick - t.farmSince > 200) {
      if (t.farmHp - farmable.health < farmable.maxHealth * 0.25) { t.farmBan = farmable.id; farmable = null; }
      else { t.farmHp = farmable.health; t.farmSince = g.tick; }
    }
  }

  // A Dominator or a Mothership is a thing to shoot; a flag or a Breakout tile
  // is a place to stand. Either way it beats another Square — but not a tank
  // already on us, because a bot walking an objective with its back turned is
  // just a donation. The exceptions are the objective that *is* the tank in
  // front of it, and a flag already in hand, which is a run you finish.
  var obj = t.aiObjective;
  if (obj && obj.e && (obj.e.dead || obj.e.team === t.team)) obj = null;
  if (obj && t.regening) obj = null;
  if (obj && tgt && tgt !== obj.e && !obj.hard) obj = null;

  var goal = tgt || farmable;
  if (obj) goal = obj.e || obj;
  var objTouch = !!(obj && obj.touch);
  var mv = { x: 0, y: 0 }, aim, aimDist = 400, d = 0, boost = false;

  if (goal) {
    var gx = goal.x - t.x, gy = goal.y - t.y;
    d = Math.hypot(gx, gy) || 1;
    aimDist = d;
    var to = Math.atan2(gy, gx);
    // Spacing costs walking time, so it has to earn itself. A square or a
    // pentagon dies long before its contact damage matters — close in and farm.
    // An Alpha Pentagon carries 3000 HP at 5 damage a tick and will outlast
    // anything hugging it, so it gets kited exactly like a tank does.
    // Closing on a shape means taking its contact damage for the whole job. That
    // is free with health to spare and fatal without, so the same Square it
    // shouldered aside at full health gets kited once it is down to its reserve.
    // Asked live against current health rather than read off the scan, which
    // runs on a lazier cadence than this does: the whole failure being fixed
    // here is a bot acting on what it could afford fifteen ticks ago.
    var slugfest = !tgt && !objTouch && !botCanTank(t, goal);
    // Extra spacing against a body-damage tank: touching you is its whole weapon.
    var ram = !!(tgt && tgt.barrels && tgt.barrels.length === 0);
    // A rammer that cannot survive the contact has no shot to fall back on, so
    // standing off a shape is only ever a pause: hold at arm's length and let
    // the next scan hand it something it can actually eat.
    var stand = Math.max(220, Math.min(1100, botReach(t) * sk.range)) * (t.fleeing ? 1.8 : 1) * (ram ? 1.5 : 1);
    var ideal = objTouch ? 0                     // a flag is captured by standing on it
      : t.rammer ? (tgt || !slugfest ? 0 : 420)
      : (tgt || slugfest) ? stand
      : 260;
    // Signed, and never zero in the band around `ideal` — the old dead zone is
    // what left bots standing still at exactly the range they were being shot from.
    mv.x += Math.cos(to) * Math.max(-1, Math.min(1, (d - ideal) / 160));
    mv.y += Math.sin(to) * Math.max(-1, Math.min(1, (d - ideal) / 160));
    if (!t.rammer && sk.strafe && tgt) {
      // A fixed 140-tick flip is a metronome: read it once and every shot after
      // lands. The interval is rolled along with the direction, so there is no
      // period left to read off it.
      if (t.strafeDir === undefined || --t.strafeFor <= 0) {
        t.strafeDir = sign();
        t.strafeFor = 40 + Math.floor(Math.random() * 160);
      }
      mv.x += -Math.sin(to) * sk.strafe * t.strafeDir;
      mv.y += Math.cos(to) * sk.strafe * t.strafeDir;
    }
    // Feet and gun part company only here: the legs are carrying a flag home
    // and the barrel stays on whatever is chasing it.
    var at = (objTouch && tgt) ? tgt : goal;
    aim = botAim(t, at, sk);
    if (at !== goal) aimDist = Math.hypot(at.x - t.x, at.y - t.y) || 1;
    boost = sk.sense >= 0.5 && !tgt && !t.rammer && !t.aiDrone && d > 900;
  } else {
    if (t.wander === undefined || (!t.regening && g.tick % 90 === t.id % 90)) t.wander = Math.random() * Math.PI * 2;
    mv.x += Math.cos(t.wander); mv.y += Math.sin(t.wander);
    aim = t.wander;
  }
  // Healing drifts toward the empty part of the map while it shoots. Being hurt
  // is what puts a bot at the top of everyone's target list — botScan pays over
  // 2x for a wounded one — so a retreat that only backs off the last shooter
  // walks straight into the next. Added to the goal rather than replacing it:
  // the gun stays on whatever it was already working on.
  if (t.regening && t.wander !== undefined) {
    mv.x += Math.cos(t.wander) * 1.3; mv.y += Math.sin(t.wander) * 1.3;
  }

  // A bias that drifts rather than jitters — a shot pulled to one side reads as
  // a bad player, per-tick noise reads as a broken one.
  if (sk.aimErr) {
    if (t.aimBias === undefined || g.tick % 17 === t.id % 17) t.aimBias = rand(-sk.aimErr, sk.aimErr);
    aim += t.aimBias;
  }
  // Distance matters: drone classes fly their drones to the mouse, not just at it.
  t.mouse.x = t.x + Math.cos(aim) * aimDist;
  t.mouse.y = t.y + Math.sin(aim) * aimDist;

  botDodge(t, sk, mv);

  // Most bots that lose health to a shape were not farming it. Measured over a
  // default FFA: 76-100% of every contact episode, by shape kind, happened while
  // the bot had a tank target — it backed into one mid-fight, or brushed past on
  // the way somewhere, or crossed the Pentagon Nest to get at something on the
  // far side. Those cost real bar: the worst single Alpha bump took 54% of a tank
  // and the worst Pentagon 72%, none of them on a shape it was farming.
  // The query radius has to cover the widest lean computed below or the pass never
  // sees the shape it is meant to swerve off. The old floor was 180 against an
  // Alpha Pentagon that needs 360 — its hull plus a big tank's plus the standoff
  // band — so whether a bot noticed one came down to which grid cells the query
  // happened to straddle.
  var scan = 380 + 300 * (1 - t.health / t.maxHealth);
  var seen = g.tick * 31337 + t.id;               // a shape spanning four cells is one shape
  g.nearby(t.x, t.y, scan, function (p) {
    if (p.shoved === seen) return;
    p.shoved = seen;
    if (p.dead || p.type !== 'shape') return;
    if (p.team !== null && p.team === t.team) return;
    if (p === goal && botCanTank(t, p)) return;   // this one is the job
    // Ticks of contact before the bot's own body kills it, off live health so the
    // Pentagon it has nearly finished stops being a wall without anything saying so.
    var pop = p.health / Math.max(1, botTouch(p, t));
    // What one bounce costs, as a share of what is left. A bounce is CONTACT_TOUCHES
    // ticks of contact — that is what the margin means — so this is the same
    // currency the closing decision is made in, not a second one.
    var risk = Math.min(1, botTouch(t, p) * CONTACT_TOUCHES / Math.max(1, t.health));
    // Two reasons to go around and a shape only has to give one: the bounce is a
    // real share of the bar, or the shape outlasts the bounce and keeps charging.
    if (risk < SHOVE_MIN && pop < SHOVE_POP) return;
    var w = Math.max(SHOVE_FLOOR, risk);
    // Over the gap between the two bodies, not between their centres. Ramping on
    // centre distance put the peak at zero separation — a place two solid bodies
    // never reach — so the lean was still climbing at the moment the hulls met and
    // came out at 0.6 against a pursuit vector of 1. The bot drove in every time.
    // Measured on the gap it hits full strength exactly as contact happens, which
    // is the only place it has to win.
    var dx = t.x - p.x, dy = t.y - p.y, skin = t.size + p.size;
    var reach = 70 + 260 * w;
    var d = Math.hypot(dx, dy);
    if (d > skin + reach || d < 1) return;
    var f = (1 - Math.max(0, d - skin) / reach) * 4 * w;   // outweighs pursuit once a bounce would hurt
    mv.x += dx / d * f; mv.y += dy / d * f;
  });

  // Maze walls. Pure repulsion, so it rounds corners but will not solve a real
  // labyrinth — the stuck check below is what covers the rest.
  // ponytail: no pathfinding, add A* over the wall grid if maze mode ever needs it
  if (sk.wall && g.walls.length) {
    for (k = 0; k < g.walls.length; k++) {
      var w = g.walls[k];
      var nx = Math.max(w.x - w.size, Math.min(t.x, w.x + w.size));
      var ny = Math.max(w.y - w.width, Math.min(t.y, w.y + w.width));
      var wx = t.x - nx, wy = t.y - ny, wd = Math.hypot(wx, wy);
      if (wd > 190) continue;
      if (wd < 1) { wx = -Math.cos(t.angle); wy = -Math.sin(t.angle); wd = 1; }
      var f = (1 - wd / 190) * 2 * sk.wall;
      mv.x += wx / wd * f; mv.y += wy / wd * f;
    }
  }

  // Wedged on a wall, a corner, or a pile of shapes: bail out sideways for a
  // second. Catches every cause at once, so nothing needs to name them.
  if (g.tick % 10 === t.id % 10) {
    if (t.wasMoving && t.stuckX !== undefined && Math.abs(t.x - t.stuckX) + Math.abs(t.y - t.stuckY) < 25) {
      // Out the way the pile is already pushing. Wedged between two Hexagons a
      // coin flip is as likely to drive deeper in, and mv at this point is the
      // sum of everything shoving it, which points at the gap it came through.
      var em = Math.hypot(mv.x, mv.y);
      t.unstick = 22;
      t.escape = em > 0.2 ? Math.atan2(mv.y, mv.x) : Math.random() * Math.PI * 2;
    }
    t.stuckX = t.x; t.stuckY = t.y;
  }
  if (t.unstick > 0) { t.unstick--; mv.x = Math.cos(t.escape) * 1.5; mv.y = Math.sin(t.escape) * 1.5; }

  var m = Math.hypot(mv.x, mv.y);
  // Recoil is an engine: firing shoves the tank the other way, so crossing open
  // ground with the gun turned around is worth 39% on a Tank and 20% on a
  // Sniper, and pointing it forwards while moving costs about as much again.
  // The catch is that a kick arriving while the tank is still turning fights
  // the steering rather than helping — measured, that made a Destroyer and an
  // Annihilator slower, not faster. So only once it is already up to speed and
  // heading roughly where it means to go.
  if (boost && m > 0.2) {
    var sp = Math.hypot(t.vx, t.vy);
    var drift = sp > 3 ? Math.abs(angleDiff(Math.atan2(t.vy, t.vx), Math.atan2(mv.y, mv.x))) : Math.PI;
    if (drift < 0.5) {
      aim = Math.atan2(-mv.y, -mv.x);
      t.mouse.x = t.x + Math.cos(aim) * 400;
      t.mouse.y = t.y + Math.sin(aim) * 400;
    }
  }
  i.up = i.down = i.left = i.right = 0;
  if (m > 0.02) {
    var ux = mv.x / m, uy = mv.y / m;
    if (ux > 0.35) i.right = 1; else if (ux < -0.35) i.left = 1;
    if (uy > 0.35) i.down = 1; else if (uy < -0.35) i.up = 1;
  }
  // steer back in-bounds — this one overrules everything above it
  var a = g.arena;
  if (t.x < a.left + 300) { i.right = 1; i.left = 0; }
  if (t.x > a.right - 300) { i.left = 1; i.right = 0; }
  if (t.y < a.top + 300) { i.down = 1; i.up = 0; }
  if (t.y > a.bottom - 300) { i.up = 1; i.down = 0; }
  t.wasMoving = !!(i.up || i.down || i.left || i.right);

  // What it settled on. aiTarget is "there is a tank in sight" and aiGoal is
  // "and it decided to do something about it" — two different questions, and
  // only the second one says whether a role is doing anything.
  t.aiGoal = goal;
  // Barrels snap to the mouse in the same tick, so there is never a swing to
  // wait out: anything with a barrel and a target shoots. Rammers hold fire
  // because they have no barrel to fire.
  i.fire = (goal && !t.rammer && botLOS(t, goal)) ? 1 : 0;
  // Drone classes shove their drones off something that got on top of them.
  // Predator holds the zoom while it has no fight, which is the only stretch
  // where a camera 1500 units down the barrel buys it anything.
  i.altFire = (t.aiDrone && sk.sense >= 0.7 && tgt && d < 320) ? 1
    : (t.zoomer && sk.sense >= 0.5 && !tgt) ? 1 : 0;

  // Invisibility is bought with stillness: Tank.step only lets opacity fall on a
  // tick with no movement input and no trigger held. A Stalker that walks and
  // shoots the whole time is a Sniper with worse stats, and a Landmine that does
  // it is a Smasher with worse stats — which is what all three classes carrying
  // the flag were, because nothing in here ever chose to stop. So when the mark
  // is still walking in, stand dead still and let it come.
  if (t.invisible && sk.sense >= 0.5 && tgt && !t.fleeing && !t.regening && clean > 30
      && d > (t.rammer ? (t.size + tgt.size) * 2.5 : botReach(t) * 0.55)
      && botClosing(tgt, t) && (t.ambush || 0) < 250) {
    t.ambush = (t.ambush || 0) + 1;
    i.up = i.down = i.left = i.right = 0;
    i.fire = 0;
    t.wasMoving = false;              // held still on purpose; not wedged on anything
  } else t.ambush = 0;

  // spend points and take upgrades
  if (t.statsAvailable > 0) botSpend(t);
  if (t.pendingUpgrades.length) {
    var choice, best = -Infinity, pool = [], sc = [];
    for (k = 0; k < t.pendingUpgrades.length; k++) {
      sc[k] = botClassScore(TANK_DEFS[t.pendingUpgrades[k]], t.build);
      if (sc[k] > best) best = sc[k];
    }
    // Taking the upgrade is not the only move. Smasher is a level-30 upgrade
    // hanging straight off the basic Tank, so a bot that takes anything at 15 can
    // never reach one — which is why, before this, not one bot in the arena ever
    // became a Smasher, whatever build it rolled. If the class this build wants is
    // on the branch it is standing on but is not open yet, hold and keep levelling.
    //
    // Deliberately outside the roll below. That roll is re-taken every tick, so
    // over the fifteen levels it takes to reach the Smasher the unluckiest tick
    // always wins and the bot blind-picks a Twin within a second of waiting. This
    // is a threshold instead, the same way ambushing and the Predator zoom are:
    // planning a branch is something a bot either does or does not do.
    if (sk.sense >= 0.4 && botWaitsFor(t, best)) return;
    if (Math.random() < sk.sense) {
      // Everything close to the best, not the strict best: the score is a rough
      // proxy, and 28 bots all converging on one class reads as broken. It prices
      // where a barrel points, not how hard it hits, so a Destroyer's one enormous
      // gun reads as worse than a Gunner's four small ones and the whole branch
      // under it — Annihilator, Hybrid, Skimmer, Rocketeer, Glider, Firework —
      // went unplayed. An experimenter's margin is wider, which is what an
      // experimenter is; it is still nowhere near the 24 points between a gun
      // class and a body one, so nobody wanders into a Smasher holding a Sniper.
      var margin = 2 + (t.botWild || 0) * 6;
      for (k = 0; k < t.pendingUpgrades.length; k++) if (sc[k] >= best - margin) pool.push(t.pendingUpgrades[k]);
      choice = pick(pool);
    } else choice = pick(t.pendingUpgrades);
    t.upgradeTo(choice);
    // New class, so the build is worth asking again — the drone build comes out
    // when the Overseer does. Points already spent stay spent, same as a player's.
    t.build = botPickBuild(t);
  }
}

// Is something better than `best` one branch away and a few levels off? Only
// asked about this class's own upgrade list, so it can never hold out for a
// class it has already made unreachable.
function botWaitsFor(t, best) {
  var ups = TANK_DEFS[t.tankId].upgrades || [];
  for (var i = 0; i < ups.length; i++) {
    var d = TANK_DEFS[ups[i]];
    if (!d || d.flags.devOnly || t.level >= d.levelRequirement) continue;
    if (botClassScore(d, t.build) > best + 2) return true;
  }
  return false;
}

// ---------------------------------------------------------------- game
function Game(modeKey, playerName, opts) {
  opts = opts || {};
  this.headless = !!opts.headless;      // server: no local player, clients bring their own
  this.modeKey = modeKey;
  this.mode = GAMEMODES[modeKey] || GAMEMODES.ffa;
  this.tick = 0;
  this.entities = [];
  this.grid = new Map();
  this.notifications = [];
  this.boss = null;
  this.bossTimer = this.mode.sandbox ? 60 * 60 * TPS : BOSS_INTERVAL;
  this.leaderboard = [];
  this.walls = [];
  this.bases = [];
  this.timeScale = 1;               // /timewarp: sim steps per wall-clock tick
  this.ruleOverride = null;         // Chaos Rotation's live modifier layer
  // Rule modes have no tick to set this, and an unlabelled arena leaves you
  // guessing which of the thirty-nine you are in.
  this.modeHud = this.mode.lab ? this.mode.name.toUpperCase() : '';
  this.bountyTarget = null;         // the one thing every bot should be shooting at
  this.fx = null;                   // per-mode screen effect state, read by the renderer

  // opts.size is the map-size picker: an absolute span that replaces the mode's
  // own. Everything downstream reads this.arena, so nothing else has to know.
  var span = opts.size || this.mode.size;
  var h = span / 2;
  this.arena = { left: -h, right: h, top: -h, bottom: h, size: span };
  this.teams = this.mode.teams;

  if (this.mode.maze) this.generateMaze();
  if (this.mode.bases) this.generateBases();

  // Objective modes (Survival, Domination, Tag, Mothership, Breakout, CTF) plug in here.
  this.logic = (this.mode.logic && typeof MODE_LOGIC !== 'undefined') ? MODE_LOGIC[this.mode.logic] : null;
  this.roundEndsAt = 0;
  this.mapDirty = true;
  if (this.logic && this.logic.init) this.logic.init(this);

  // Sumo, Diep Ball and the race modes want a clear floor; Locust wants it
  // knee-deep. Both are the same dial.
  // Shape count follows the arena AREA, so the density a mode was tuned at
  // survives a resize. Capped at 2.5x: a colossal map asks for six times the
  // shapes and the sim will not carry that.
  // ponytail: flat cap, revisit if the shape budget is ever actually measured.
  var areaK = Math.min(2.5, (span * span) / (this.mode.size * this.mode.size));
  this.wantedShapes = Math.round(this.rule('shapes', this.mode.sandbox ? 120 : 1000) * areaK);
  for (var i = 0; i < this.wantedShapes; i++) this.spawnShape();

  if (!this.headless) this.player = this.spawnTank({ name: playerName, isPlayer: true });
  this.setDifficulty(opts.difficulty || 'medium');
  // `bots` pins a count; `botsDelta` nudges whatever the player chose, which is
  // what a mode wants when it only needs a slightly thinner field than usual.
  var chosen = opts.botCount !== undefined ? opts.botCount : 80;
  this.botCount = Math.max(0, this.rule('bots', chosen) + this.rule('botsDelta', 0));
  // ...and `botCap` is the picker's own slider, which outranks both. A number
  // the player set is an answer, not a suggestion, so neither the pin nor the
  // delta gets to argue with it. Deliberately not `botCount`: every existing
  // caller passes that expecting the mode to still win, and a mode tuned for
  // eight tanks is not the place to discover otherwise.
  if (opts.botCap !== undefined) this.botCount = Math.max(0, opts.botCap);
  this.botRespawn = [];                // levels waiting to come back, one per dead bot
  for (var b = 0; b < this.botCount; b++) this.spawnBot();
}

Game.prototype.add = function (e) { this.entities.push(e); return e; };
Game.prototype.notify = function (text, ticks) { this.notifications.push({ text: text, ttl: ticks || 100 }); };

// One lookup for every mode that is a changed constant rather than a changed
// objective — friction, damage, regen, XP shares, spawn level. `ruleOverride`
// is the live layer Chaos Rotation writes to, so a modifier can be switched on
// and off mid-round without touching the mode table.
// The top of the board when a round ends, so the winner screen has something
// to show. Taken at the moment of the win rather than at the moment of the
// draw, because the arena keeps killing each other through the banner.
Game.prototype.snapshotPodium = function (winnerText) {
  var list = [];
  for (var i = 0; i < this.entities.length; i++) {
    var e = this.entities[i];
    if (e.type !== 'tank' || e.modeEntity || e.isCloser) continue;
    if (!e.isPlayer && !e.bot) continue;
    list.push({ name: e.name || 'an unnamed tank', score: Math.round(e.score), level: e.level,
      kills: e.kills || 0, tank: e.def ? e.def.name : '', isPlayer: !!e.isPlayer, dead: !!e.dead });
  }
  list.sort(function (a, b) { return b.score - a.score; });
  this.podium = { text: winnerText || '', top: list.slice(0, 3), players: list.length, tick: this.tick };
  return this.podium;
};

// The level ceiling. 45 everywhere except a mode that says otherwise, and the
// one place every cap check goes through so raising it raises all of them.
Game.prototype.levelCap = function () {
  return Math.min(LEVEL_CAP, this.rule('maxLevel', MAX_LEVEL));
};

Game.prototype.rule = function (key, dflt) {
  var o = this.ruleOverride;
  if (o && o[key] !== undefined) return o[key];
  var r = this.mode.rules;
  return (r && r[key] !== undefined) ? r[key] : dflt;
};

Game.prototype.teamOf = function () {
  if (!this.teams) return null;
  var counts = {}, self = this;
  this.teams.forEach(function (t) { counts[t] = 0; });
  this.entities.forEach(function (e) {
    if (e.type === 'tank' && !e.dead && !e.modeEntity && counts[e.team] !== undefined) counts[e.team]++;
  });
  return this.teams.reduce(function (a, b) { return counts[a] <= counts[b] ? a : b; });
};

// anywhere: skip the outer-ring rule, so bots scatter over the whole map.
Game.prototype.spawnPoint = function (team, anywhere) {
  var a = this.arena;
  if (team) {
    var base = this.bases.filter(function (b) { return b.team === team; })[0];
    if (base) return { x: base.x + rand(-base.size * 0.7, base.size * 0.7), y: base.y + rand(-base.width * 0.7, base.width * 0.7) };
    // Mothership has no bases, and the outer-ring roll below dropped half of
    // each team into the other one's half of the map.
    var ms = (this.motherships || []).filter(function (m) { return m.team === team; })[0];
    if (ms) return { x: ms.x + rand(-1500, 1500), y: ms.y + rand(-1500, 1500) };
  }
  // Scattered bots also keep off each other: half of an even share of the map
  // apiece, re-rolled until it fits. Asking for the full share is perfect
  // packing, which rejection sampling never finds, so every bot would burn its
  // tries and land wherever it last looked.
  var gap = 0;
  if (anywhere) {
    var live = 0;
    for (var j = 0; j < this.entities.length; j++) {
      var t = this.entities[j];
      if (t.type === 'tank' && !t.dead) live++;
    }
    gap = a.size / (2 * Math.sqrt(live + 1));
  }
  for (var i = 0; i < 60; i++) {   // gap rejects ~4 spots in 5, so it needs the tries
    var x = rand(a.left, a.right), y = rand(a.top, a.bottom);
    if (!anywhere && Math.max(Math.abs(x), Math.abs(y)) < a.right / 2) continue;
    if (this.inWall(x, y, 60)) continue;
    if (gap && this.nearTank(x, y, gap)) continue;
    return { x: x, y: y };
  }
  return { x: rand(a.left, a.right), y: rand(a.top, a.bottom) };
};

Game.prototype.spawnTank = function (o) {
  var team = o.team !== undefined ? o.team : this.teamOf();
  var p = this.spawnPoint(team, o.bot);
  var score = o.score || 0;
  // Instagib, Sumo and the duel modes hand out a finished tank rather than a
  // level 1 one. A mode-set score always wins over the rule.
  var lvl = this.rule('spawnLevel', 0);
  if (lvl && !score) score = LEVEL_SCORE[Math.min(this.levelCap(), lvl)];
  var t = new Tank(this, { x: p.x, y: p.y, name: o.name, isPlayer: o.isPlayer, bot: o.bot, team: team, score: score });
  this.paintTeam(t);
  var force = this.rule('forceClass', null);
  var stats = this.rule('forceStats', null);
  if (force !== null) forceTankClass(t, force === 'random' ? randomTankId() : force, stats);
  else if (stats) {
    // A mode can hand out a build without dictating the class — Grand Prix
    // wants every car on maximum speed but does not care what you drive.
    for (var si = 0; si < 8; si++) t.stats[si] = Math.min(stats[si] || 0, t.def.stats[si].max);
    t.recompute();
  }
  this.add(t);
  // Modes dress a fresh tank here: a gun-game rung, a prop-hunt disguise, an
  // infection team. One hook rather than a spawn path per mode.
  if (this.logic && this.logic.onSpawn) this.logic.onSpawn(this, t);
  // Last, and always: a tank handed out at level 45 has upgrades waiting and
  // nothing had ever asked. A mode that does not want cards says so through
  // filterUpgrades, which checkUpgrades runs.
  t.checkUpgrades();
  return t;
};

// Put a tank straight into a class, past the upgrade tree. `stats` is an
// optional wire-order spread; anything over the class's own cap is clamped, the
// same way upgradeTo does it.
function forceTankClass(t, id, stats) {
  var d = TANK_DEFS[id];
  if (!d) return t;
  t.setTank(id);
  if (stats) for (var i = 0; i < 8; i++) t.stats[i] = Math.min(stats[i] || 0, d.stats[i].max);
  else for (i = 0; i < 8; i++) t.stats[i] = Math.min(t.stats[i], d.stats[i].max);
  t.upgradesTaken = [id];
  t.pendingUpgrades = [];
  t.recompute();
  return t;
}

// Every class a player could actually reach, found by walking the upgrade tree
// out from Basic. Reading a flag instead would let Arena Closer, Mothership,
// Dominator and Ball into the pool — they are defs, but they are not classes.
function playableTankIds() {
  if (playableTankIds.pool) return playableTankIds.pool;
  var seen = {}, q = [0], out = [];
  seen[0] = 1;
  while (q.length) {
    var id = q.shift(), d = TANK_DEFS[id];
    if (!d) continue;
    out.push(id);
    var ups = d.upgrades || [];
    for (var i = 0; i < ups.length; i++) {
      if (!seen[ups[i]] && TANK_DEFS[ups[i]] && !TANK_DEFS[ups[i]].flags.devOnly) { seen[ups[i]] = 1; q.push(ups[i]); }
    }
  }
  playableTankIds.pool = out;
  return out;
}
function randomTankId() { return pick(playableTankIds()); }

Game.prototype.paintTeam = function (t) {
  // Boss classes carry their own colour — a Guardian is Crasher pink on every
  // team, exactly as the AI boss is. Checked first so nothing repaints them.
  if (t.def && t.def.color) { t.fill = t.def.color[0]; t.stroke = t.def.color[1]; }
  else if (t.team && TEAM_COLORS[t.team]) { t.fill = TEAM_COLORS[t.team][0]; t.stroke = TEAM_COLORS[t.team][1]; }
  else if (t.isPlayer) { t.fill = C.blue; t.stroke = C.blueS; }        // in FFA you are always blue
  else { t.fill = C.red; t.stroke = C.redS; }                          // and everyone else is red
};

Game.prototype.spawnBot = function () {
  var back = this.botRespawn.length ? this.botRespawn.shift() : null;
  // A mode that hands out a finished tank hands one to the bots as well. The
  // queued level is a rung on the normal ladder, and these modes have no ladder.
  var fixed = this.rule('spawnLevel', 0);
  var lvl = fixed ? Math.min(this.levelCap(), fixed) : (back ? back.lvl : 1);
  var t = this.spawnTank({
    name: pick(BOT_NAMES) + (Math.random() < 0.4 ? ' ' + ((Math.random() * 99) | 0) : ''),
    bot: true, score: LEVEL_SCORE[lvl],
    team: back ? back.team : undefined
  });
  t.autoFire = false;
  t.botRole = pick(BOT_ROLES);
  // A Brawler that rolled a bullet build is a Brawler in name only, so the role
  // picks the build rather than the other way round.
  var want = BOT_BUILDS.filter(function (b) { return t.botRole.ram < 0 || b.ram === t.botRole.ram; });
  if (!want.length) want = BOT_BUILDS;
  // Taste, not a build: one to three the bot likes, and it runs whichever fits
  // whatever class it ends up in. That is what stops the field looking like four
  // tanks copied twenty times — a bot that likes drones and traps plays an
  // Overlord this life and a Tri-Trapper the next, off the same personality.
  // wild is its appetite for going off-meta: zero for a bit over half of them,
  // then a flat tail out to a build of its own making.
  var wild = Math.max(0, Math.random() * 2.2 - 1.2);
  var picked = [];
  for (var n = 1 + ((Math.random() * 3) | 0); n > 0; n--) {
    var b = pick(want);
    if (picked.indexOf(b) === -1) picked.push(b);
  }
  t.botWild = wild;
  t.botLikes = picked.map(function (p) { return botVary(p, wild); });
  t.build = botPickBuild(t);
  // Points and classes are spent one per tick by tickBot, so a level 14 spawn
  // sorts itself out inside a second — checkUpgrades only opens the first door.
  t.checkUpgrades();
  botClassify(t);
  return t;
};

// Takes a difficulty name or a custom {aim, react, dodge, move, aggro, brain} bag.
Game.prototype.setDifficulty = function (d) {
  this.difficulty = d || 'medium';
  this.botSkill = botSkill(this.difficulty);
  return this.botSkill;
};

// inNest restricts the roll to the Pentagon Nest ring, so mid can be topped up
// on its own. The keep-away radius decays across the retries: camping the nest
// otherwise blocks every candidate point in it and nothing ever comes back.
Game.prototype.spawnShape = function (inNest) {
  var a = this.arena, lo = inNest ? -a.right / 10 : a.left, hi = inNest ? a.right / 10 : a.right;
  for (var i = 0; i < 20; i++) {
    var x = rand(lo, hi), y = rand(lo, hi);
    if (this.inWall(x, y, 80)) continue;
    if (this.nearTank(x, y, 1000 - i * 50)) continue;
    return this.add(new Shape(this, this.shapeKindAt(x, y), x, y));
  }
  return null;
};

// Which shape belongs at a position. The zone rings are what make the Pentagon
// Nest and the Crasher belt exist at all.
Game.prototype.shapeKindAt = function (x, y) {
  var a = this.arena, m = Math.max(Math.abs(x), Math.abs(y)), r;
  if (m < a.right / 10) {                                  // Pentagon Nest
    // Hexagon HP/XP (1500/1500) are confirmed; its spawn rate never was. It sits
    // between Pentagon and Alpha in strength, so it nests with them.
    r = Math.random();
    return r < 0.05 ? 'alpha' : r < 0.15 ? 'hexagon' : 'pentagon';   // TODO: 10% unverified
  }
  if (m < a.right / 5) return Math.random() < 0.2 ? 'crasherL' : 'crasherS';   // Crasher ring
  r = Math.random();                                       // fields of shapes
  return r < 0.04 ? 'pentagon' : r < 0.20 ? 'triangle' : 'square';
};

Game.prototype.nearTank = function (x, y, r) {
  var r2 = r * r;
  for (var i = 0; i < this.entities.length; i++) {
    var e = this.entities[i];
    if (e.type !== 'tank' && e.type !== 'boss') continue;
    var dx = e.x - x, dy = e.y - y;
    if (dx * dx + dy * dy < r2) return true;
  }
  return false;
};

Game.prototype.inWall = function (x, y, pad) {
  for (var i = 0; i < this.walls.length; i++) {
    var w = this.walls[i];
    if (Math.abs(x - w.x) < w.size + pad && Math.abs(y - w.y) < w.width + pad) return true;
  }
  return false;
};

// The real game's map (§9): plant wall seeds on the 40x40 cell grid, random-walk
// each one outwards with a chance to turn, branch or stop, fill in whatever the
// walk sealed off from the rest of the arena, then merge the cells into as few
// rectangles as possible. Nothing is carved out for the nest — diep doesn't.
Game.prototype.generateMaze = function () {
  var a = this.arena, n = MAZE.cells, cell = MAZE.cell;
  var m = new Uint8Array(n * n);                   // 0 open, 1 wall, 2 reached, 3 placed
  function get(x, y) { return (x < 0 || y < 0 || x >= n || y >= n) ? 0 : m[y * n + x]; }
  function set(x, y, v) { m[y * n + x] = v; }
  function inner(x, y) { return x > 0 && y > 0 && x < n - 1 && y < n - 1; }

  // One seed per block of cells, jittered inside it. Scattering them at random
  // the way the original does leaves whole quarters of the grid bare.
  var seeds = [], i, j, b = MAZE.seedBlock;
  for (var by = 0; by < n; by += b) {
    for (var bx = 0; bx < n; bx += b) {
      var sx = bx + Math.floor(Math.random() * b), sy = by + Math.floor(Math.random() * b);
      if (!inner(sx, sy)) continue;
      seeds.push({ x: sx, y: sy }); set(sx, sy, 1);
    }
  }
  var cap = seeds.length * MAZE.branchCap;

  // Two wall cells side by side read as a slab rather than a wall, so no cell is
  // ever allowed to complete a 2x2 block. Crossings and T-junctions still pass.
  function slabs(x, y) {
    var was = get(x, y), bad = false;
    set(x, y, 1);
    for (var qx = x - 1; qx <= x && !bad; qx++)
      for (var qy = y - 1; qy <= y; qy++)
        if (get(qx, qy) === 1 && get(qx + 1, qy) === 1 && get(qx, qy + 1) === 1 && get(qx + 1, qy + 1) === 1) { bad = true; break; }
    set(x, y, was);
    return bad;
  }

  var DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  // The two directions square to this one — a turn or a branch picks one of them.
  function perp(d) {
    var opts = [];
    for (var q = 0; q < 4; q++) if (DIRS[q][0] !== d[0] && DIRS[q][1] !== d[1]) opts.push(DIRS[q]);
    return opts[Math.floor(Math.random() * opts.length)];
  }
  for (var s = 0; s < seeds.length; s++) {         // branches are appended as we go
    var seed = seeds[s], dir = DIRS[Math.floor(Math.random() * 4)], roll = 1;
    while (roll >= MAZE.terminationChance) {
      roll = Math.random();
      // Blocked head-on: try the two turns before giving up, or every wall that
      // runs into another one dies there and the map thins out.
      var opts = [dir, perp(dir), perp(dir)], step = null;
      for (j = 0; j < 3 && !step; j++) {
        var tx = seed.x + opts[j][0], ty = seed.y + opts[j][1];
        if (inner(tx, ty) && !slabs(tx, ty)) { dir = opts[j]; step = [tx, ty]; }
      }
      if (!step) break;
      seed.x = step[0]; seed.y = step[1];
      set(seed.x, seed.y, 1);
      if (Math.random() <= MAZE.branchChance) {
        if (seeds.length > cap) continue;          // no runaway tumours
        var p = perp(dir);
        seeds.push({ x: seed.x + p[0], y: seed.y + p[1] });
      } else if (Math.random() <= MAZE.turnChance) dir = perp(dir);
    }
  }

  // A few lone blocks out in the open, well clear of everything else.
  for (i = 0; i < 10; i++) {
    var bx = Math.floor(Math.random() * n - 1), by = Math.floor(Math.random() * n - 1);
    if (!inner(bx, by)) continue;
    var near = false;
    for (var y2 = by - 3; y2 <= by + 3 && !near; y2++)
      for (var x2 = bx - 3; x2 <= bx + 3; x2++) if (get(x2, y2) === 1) { near = true; break; }
    if (!near) set(bx, by, 1);
  }

  // A walk that curls back on itself seals a pocket off, and a pocket is a room
  // nobody can enter. The original fills the room in, which is what welds walls
  // into slabs a tenth of the map wide; knock a door through the side instead.
  // The border ring never takes a wall, so the corner is always open ground.
  for (var pass = 0; pass < 400; pass++) {
    for (i = 0; i < m.length; i++) if (m[i] === 2) m[i] = 0;   // re-flood from scratch
    var queue = [[0, 0]], head = 0;
    set(0, 0, 2);
    while (head < queue.length) {
      var c = queue[head++], nb = [[c[0] - 1, c[1]], [c[0] + 1, c[1]], [c[0], c[1] - 1], [c[0], c[1] + 1]];
      for (j = 0; j < 4; j++) {
        var nx = nb[j][0], ny = nb[j][1];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n || get(nx, ny) !== 0) continue;
        set(nx, ny, 2); queue.push([nx, ny]);
      }
    }
    // Any wall cell with open ground on one side and a pocket on the other is a
    // door. One per pass, picked at random so the holes are not all top-left.
    var doors = [];
    for (i = 0; i < m.length; i++) {
      if (m[i] !== 1) continue;
      var dx2 = i % n, dy2 = (i - dx2) / n, reached = false, sealed = false;
      var sides = [get(dx2 - 1, dy2), get(dx2 + 1, dy2), get(dx2, dy2 - 1), get(dx2, dy2 + 1)];
      for (j = 0; j < 4; j++) { if (sides[j] === 2) reached = true; else if (sides[j] === 0) sealed = true; }
      if (reached && sealed) doors.push(i);
    }
    if (!doors.length) break;
    m[doors[Math.floor(Math.random() * doors.length)]] = 0;
  }
  // Walled in two cells thick, so no single door reaches it: fill it in after all.
  for (i = 0; i < m.length; i++) if (m[i] === 0) m[i] = 1;

  // Merge: run each wall cell right as far as it goes, then push that run down
  // while the whole width holds. One entity per block instead of one per cell.
  for (var gx = 0; gx < n; gx++) {
    for (var gy = 0; gy < n; gy++) {
      if (get(gx, gy) !== 1) continue;
      var cw = 0, ch = 1;
      while (get(gx + cw, gy) === 1) { set(gx + cw, gy, 3); cw++; }
      for (;;) {
        var fits = true;
        for (i = 0; i < cw; i++) if (get(gx + i, gy + ch) !== 1) { fits = false; break; }
        if (!fits) break;
        for (i = 0; i < cw; i++) set(gx + i, gy + ch, 3);
        ch++;
      }
      var w = new Entity(this, {
        type: 'wall', x: a.left + (gx + cw / 2) * cell, y: a.top + (gy + ch / 2) * cell, sides: 2,
        size: cw * cell / 2, width: ch * cell / 2,
        fill: C.box, stroke: C.boxS, maxHealth: Infinity, team: null
      });
      w.isSolidWall = true; w.damageReduction = 0; w.push = 1; w.absorb = 0;
      w.hiddenHealthbar = true;
      this.walls.push(w); this.add(w);
    }
  }
};

Game.prototype.generateBases = function () {
  var a = this.arena, self = this, n = this.teams.length;
  // §9: half the base region, times 0.6 — 2007 du in a 22300 arena.
  var half = Math.round(a.size / 2 / (10 / 3) * 0.6);
  var layouts = n === 2
    ? [{ x: a.left + half, y: 0, size: half, width: a.bottom }, { x: a.right - half, y: 0, size: half, width: a.bottom }]
    : [{ x: a.left + 1800, y: a.top + 1800, size: 1800, width: 1800 }, { x: a.left + 1800, y: a.bottom - 1800, size: 1800, width: 1800 },
       { x: a.right - 1800, y: a.top + 1800, size: 1800, width: 1800 }, { x: a.right - 1800, y: a.bottom - 1800, size: 1800, width: 1800 }];
  this.teams.forEach(function (team, i) {
    var l = layouts[i];
    var b = new Entity(self, { type: 'base', x: l.x, y: l.y, sides: 2, size: l.size, width: l.width, team: team, fill: TEAM_COLORS[team][0], stroke: TEAM_COLORS[team][1], maxHealth: Infinity });
    b.damageReduction = 0; b.push = 0; b.absorb = 0; b.hiddenHealthbar = true; b.isBase = true;
    self.bases.push(b); self.add(b);
    // invisible drone spawner parented to the base
    var sp = new Entity(self, { type: 'basespawner', x: l.x, y: l.y, sides: 0, team: team, maxHealth: Infinity, fill: TEAM_COLORS[team][0], stroke: TEAM_COLORS[team][1] });
    sp.damageReduction = 0; sp.push = 0; sp.absorb = 0; sp.hiddenHealthbar = true;
    sp.scaleFactor = 1; sp.stats = [0, 0, 4, 0, 0, 0, 0, 0]; sp.reloadTime = 15;
    sp.barrels = [new Barrel(sp, BASE_DRONE_BARREL, 0)];
    sp.angle = 0;
    sp.input = { fire: 0, altFire: 0 }; sp.mouse = { x: l.x, y: l.y };
    self.add(sp);
  });
};

// ---------------------------------------------------------------- queries
Game.prototype.findTarget = function (from, range, preferTanks, ownerAnchor) {
  var best = null, bestD = range * range, anchor = ownerAnchor || from;
  var anchorR2 = range * range;
  for (var i = 0; i < this.entities.length; i++) {
    var e = this.entities[i];
    if (e === from || e.dead || e.sides === 0) continue;
    if (e.type === 'base' || e.type === 'wall' || e.type === 'basespawner') continue;
    if (e.owner) continue;                                    // don't chase someone's bullets
    if (e === anchor || e === from.parent) continue;           // never your own tank: in FFA it is teamless, so the team check misses it
    if (e.team !== null && e.team === from.team) continue;
    if (from.isCloser && e.isCloser) continue;                 // closers ignore each other
    if (from.team === null && e.type === 'shape') continue;    // AI turrets ignore shapes when teamless
    if (preferTanks && e.type === 'shape') continue;
    // invisible tanks are unseeable — except to Arena Closers
    if (e.opacity !== undefined && e.opacity <= 0 && !from.seesInvisible) continue;
    var d = dist2(from, e);
    if (d > bestD) continue;
    if (ownerAnchor && dist2(anchor, e) > anchorR2) continue;
    bestD = d; best = e;
  }
  return best;
};

// Orphaned projectiles outlive their owner and can kill them posthumously.
Game.prototype.orphan = function (tank) {
  for (var i = 0; i < this.entities.length; i++) {
    var e = this.entities[i];
    if (e.owner !== tank) continue;
    if (e.type === 'drone' || e.type === 'necro' || e.type === 'minion' || e.type === 'swarm') { e.kill(null); continue; }
    e.owner = null; e.team = null;
  }
};

// ---------------------------------------------------------------- broadphase
Game.prototype.rebuildGrid = function () {
  this.grid.clear();
  for (var i = 0; i < this.entities.length; i++) {
    var e = this.entities[i];
    if (e.sides === 0 || e.dead) continue;
    var r = e.sides === 2 ? Math.max(e.size, e.width) : e.size;
    var x0 = Math.floor((e.x - r) / HASH_CELL), x1 = Math.floor((e.x + r) / HASH_CELL);
    var y0 = Math.floor((e.y - r) / HASH_CELL), y1 = Math.floor((e.y + r) / HASH_CELL);
    for (var gx = x0; gx <= x1; gx++) for (var gy = y0; gy <= y1; gy++) {
      var k = gx * 46337 + gy;
      var cell = this.grid.get(k);
      if (!cell) this.grid.set(k, [e]); else cell.push(e);
    }
  }
};

// Walk the cells covering a circle. Entities spanning several cells arrive more
// than once — callers that count things dedupe with a stamp.
Game.prototype.nearby = function (x, y, r, cb) {
  var x0 = Math.floor((x - r) / HASH_CELL), x1 = Math.floor((x + r) / HASH_CELL);
  var y0 = Math.floor((y - r) / HASH_CELL), y1 = Math.floor((y + r) / HASH_CELL);
  for (var gx = x0; gx <= x1; gx++) for (var gy = y0; gy <= y1; gy++) {
    var cell = this.grid.get(gx * 46337 + gy);
    if (!cell) continue;
    for (var i = 0; i < cell.length; i++) cb(cell[i]);
  }
};

Game.prototype.collisionPass = function () {
  var seen = new Set();
  var self = this;
  this.grid.forEach(function (cell) {
    for (var i = 0; i < cell.length; i++) for (var j = i + 1; j < cell.length; j++) {
      var a = cell[i], b = cell[j];
      if (a.id > b.id) { var t = a; a = b; b = t; }
      var key = a.id * 1e7 + b.id;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!canInteract(a, b)) continue;
      if (!collides(a, b)) continue;

      // Necromancer capture: touching a Square converts it.
      if (self.tryClaim(a, b) || self.tryClaim(b, a)) continue;

      if (b.isBase) { self.baseContact(a, b); continue; }
      if (a.isBase) { self.baseContact(b, a); continue; }

      applyKnockback(a, b);
      applyKnockback(b, a);
      handleCollision(a, b);
    }
  });
};

Game.prototype.tryClaim = function (claimer, shape) {
  if (shape.type !== 'shape' || shape.kind !== 'square' || shape.dead) return false;
  var owner = null;
  if (claimer.type === 'tank' && claimer.def && claimer.def.flags.canClaimSquares) owner = claimer;
  else if (claimer.type === 'necro' && claimer.owner && !claimer.owner.dead) owner = claimer.owner;
  if (!owner) return false;
  var barrel = owner.barrels.filter(function (b) { return b.def.bullet.type === 'necrodrone'; })
    .sort(function (a, b) { return a.children.length - b.children.length; })[0];
  if (!barrel) return false;
  barrel.children = barrel.children.filter(function (c) { return !c.dead; });
  if (barrel.children.length >= barrel.maxDrones()) return false;

  var st = owner.stats, bd = barrel.def.bullet;
  shape.type = 'necro';
  shape.team = owner.team; shape.owner = owner; shape.barrel = barrel;
  shape.controllable = true;
  shape.onlySameOwnerCollision = true;
  // Same entity a necrodrone barrel would have produced, so it gets the same numbers.
  // (diep also scales a claimed shape's damage and health by its own damage/2, but
  // only Squares can be claimed and a Square's is 2, so the factor is 1.)
  shape.minDmg = 1; shape.maxDmg = 4;
  shape.fill = shape.shiny ? C.shiny : C.necro; shape.stroke = shape.shiny ? C.shinyS : C.necroS;
  shape.maxHealth = (1.5 * st[S_PEN] + 2) * bd.health;
  shape.health = shape.maxHealth;
  shape.damagePerTick = (7 + st[S_DAMAGE] * 3) * bd.damage * (owner.bulletDamage === undefined ? 1 : owner.bulletDamage);
  shape.push = 4;
  shape.accel = (20 + BSPEED_GAIN * st[S_BSPEED]) * bd.speed;
  shape.life = Infinity; shape.age = 0;
  shape.scoreReward = shape.shiny ? 1000 : 10;
  barrel.children.push(shape);
  return true;
};

// Enemy tanks take fatal damage inside a base; enemy projectiles dissolve at the edge.
Game.prototype.baseContact = function (e, base) {
  if (base.team === null) return;                 // unclaimed Breakout tile: inert
  if (e.team === base.team) return;
  // Tiles block enemy fire from outside but let enemy tanks walk in.
  // `owner !== undefined` was true of every entity alive, shapes included, so a
  // claimed tile quietly deleted every polygon standing on it, forever.
  if (base.isTile) { if (e.type !== 'tank' && e.type !== 'boss' && e.type !== 'shape') e.kill(base); return; }
  if (e.type === 'tank' || e.type === 'boss') {
    e.applyDamage(e.maxHealth / 12, base);
    var ang = Math.atan2(e.y - base.y, e.x - base.x);
    e.addVelocity(ang, 8);
  } else if (e.owner !== null || e.type === 'bullet' || e.type === 'trap' || e.type === 'drone') {
    e.kill(base);
  }
};

// ---------------------------------------------------------------- main tick
Game.prototype.step = function () {
  this.tick++;
  var i, e;

  for (i = 0; i < this.entities.length; i++) {
    e = this.entities[i];
    e.px = e.x; e.py = e.y; e.pa = e.angle; e.psize = e.size;
    if (e.dead) continue;
    switch (e.type) {
      case 'tank':
        if (e.isCloser) tickCloser(e);
        else if (e.bot && !e.parked && !e.immobile) {
          tickBot(e);
          // A goal is a hint the ordinary AI weighs against everything else.
          // Some modes are not negotiable — a red light, a starting grid, a
          // prop holding still — so a mode may drive the bot outright instead.
          if (this.logic && this.logic.botDrive) this.logic.botDrive(this, e);
        }
        e.tick(); break;
      case 'boss': e.tick(); break;
      case 'shape': e.tick(); break;
      case 'wall': case 'base': case 'tile': case 'flag': break;
      case 'basespawner': e.barrels[0].tick(true); break;
      default: tickProjectile(e);
    }
  }
  if (this.logic && this.logic.tick) this.logic.tick(this);

  this.rebuildGrid();
  this.collisionPass();

  for (i = 0; i < this.entities.length; i++) {
    e = this.entities[i];
    if (e.type === 'wall' || e.type === 'base' || e.type === 'basespawner' || e.type === 'tile' || e.type === 'flag') continue;
    e.applyPhysics();
  }

  // round reset, once the win banner has had its time on screen
  if (this.roundEndsAt && this.tick >= this.roundEndsAt) {
    this.roundEndsAt = 0;
    this.podium = null;
    this.mapDirty = true;
    if (this.logic && this.logic.reset) this.logic.reset(this);
    for (var r = 0; r < this.entities.length; r++) {
      var t = this.entities[r];
      if (t.type === 'tank' && !t.dead && (t.bot || t.isPlayer) && !t.immobile && !t.isMothership) t.kill(null);
    }
    // Those deaths queue a level and a team apiece. A new round is a new board:
    // drop them, so the bots come back at level 1 and Tag re-balances its teams
    // instead of restarting with everyone still on the winner's side.
    this.botRespawn.length = 0;
    this.notify('New round!', 60);
  }

  // deletion animation: 5 frames, scale 1.1 and fade 1/6 per frame
  var alive = [];
  for (i = 0; i < this.entities.length; i++) {
    e = this.entities[i];
    if (!e.dead) { alive.push(e); continue; }
    e.deathFrame--;
    e.size *= 1.1;
    e.opacity = Math.max(0, e.opacity - 1 / 6);
    if (e.deathFrame > 0) alive.push(e);
  }
  this.entities = alive;

  // Top up shapes. The nest has its own quota: it is ~1% of the arena's area, so
  // a farmed-out mid barely registers against the global count and the deficit
  // gets spent refilling the fields instead. Counted and refilled separately.
  var shapeCount = 0, nestCount = 0, nestR = this.arena.right / 10;
  for (i = 0; i < this.entities.length; i++) {
    e = this.entities[i];
    if (e.type !== 'shape') continue;
    shapeCount++;
    if (Math.max(Math.abs(e.x), Math.abs(e.y)) < nestR) nestCount++;
  }
  var wantNest = Math.round(this.wantedShapes * NEST_SHARE);
  if (nestCount < wantNest && this.tick % NEST_REFILL_TICKS === 0 && this.spawnShape(true)) shapeCount++;
  for (i = shapeCount; i < this.wantedShapes; i++) this.spawnShape();

  // respawn bots
  var botCount = 0;
  for (i = 0; i < this.entities.length; i++) { e = this.entities[i]; if (e.type === 'tank' && e.bot && !e.dead) botCount++; }
  // Refill the whole deficit, not one tank a second: bots die faster than that,
  // so a trickle settled the arena around 40 instead of the count that was set.
  if (this.tick % 25 === 0) for (i = botCount; i < this.botCount; i++) this.spawnBot();

  // boss cycle
  if (!this.mode.noBoss) {
    this.bossTimer--;
    if (this.bossTimer <= 0) {
      this.bossTimer = BOSS_INTERVAL;
      if (!this.boss) this.spawnBoss();
    }
  }

  if (this.closing) this.checkClosed();
  if (this.tick % TPS === 0) this.updateLeaderboard();
  for (i = this.notifications.length - 1; i >= 0; i--) if (--this.notifications[i].ttl <= 0) this.notifications.splice(i, 1);
};

// ---------------------------------------------------------------- closing
// Retiring an arena: announce it, ring the map with Arena Closers, stop bots
// respawning, and let them sweep everything off the board.
Game.prototype.close = function () {
  if (this.closing) return;
  this.closing = true;
  this.botCount = 0;
  this.notify('Arena closed: No players can join', 250);
  var a = this.arena;
  var count = Math.floor(Math.sqrt(a.size) / 10);          // 14 for a 22300 arena
  var radius = a.size * Math.SQRT1_2 + 5000;               // ~20770, well outside the field
  for (var i = 0; i < count; i++) {
    var ang = (i / count) * Math.PI * 2;
    this.add(makeArenaCloser(this, Math.cos(ang) * radius, Math.sin(ang) * radius, ang + Math.PI));
  }
  return count;
};

function makeArenaCloser(g, x, y, facing) {
  var t = new Tank(g, { x: x, y: y, team: null, name: 'Arena Closer', tankId: 16 });
  t.level = 45;
  t.stats = [0, 7, 7, 7, 7, 0, 0, 0];                      // maxed bullets: one volley kills
  t.recompute();                                            // everything below must follow recompute
  t.isCloser = true;
  t.seesInvisible = true;                                   // a Stalker cannot hide from these
  t.canEscapeArena = true;                                  // they start outside the field
  t.canMoveThroughWalls = true;
  t.godMode = true;                                         // the engine's own invincibility path
  t.push = 30;
  t.damagePerTick = 1e6;                                    // one-shots anything it touches
  t.movementSpeed = 8;                                      // ~200 units/tick terminal
  t.scoreReward = 0;
  t.protectedUntil = 0;
  t.autoFire = true;
  t.angle = facing;
  t.mouse.x = x + Math.cos(facing) * 1000;
  t.mouse.y = y + Math.sin(facing) * 1000;
  t.fill = C.neutral; t.stroke = C.neutralS;
  t.addScore = function () {};                              // never levels, never recomputes
  return t;
}

function tickCloser(t) {
  var g = t.game;
  if (g.tick % 3 === t.id % 3) t.aiTarget = g.findTarget(t, 1e6, true);
  var goal = (t.aiTarget && !t.aiTarget.dead) ? t.aiTarget : { x: 0, y: 0 };
  var i = t.input;
  i.up = i.down = i.left = i.right = 0;
  t.mouse.x = goal.x; t.mouse.y = goal.y;
  var ang = Math.atan2(goal.y - t.y, goal.x - t.x);
  if (Math.cos(ang) > 0.35) i.right = 1; else if (Math.cos(ang) < -0.35) i.left = 1;
  if (Math.sin(ang) > 0.35) i.down = 1; else if (Math.sin(ang) < -0.35) i.up = 1;
  i.fire = 1;
}

// The arena is CLOSED once nothing but the closers is left standing.
Game.prototype.checkClosed = function () {
  if (!this.closing || this.closed) return;
  for (var i = 0; i < this.entities.length; i++) {
    var e = this.entities[i];
    if (e.type === 'tank' && !e.dead && !e.isCloser) return;
  }
  this.closed = true;
  this.notify('Arena CLOSED', 250);
};

Game.prototype.spawnBoss = function (index) {
  var spec = index === undefined ? pick(BOSSES) : BOSSES[index];
  this.boss = this.add(new Boss(this, spec));
  this.notify('The ' + spec.name + ' has spawned!', 150);
  return this.boss;
};

// With fewer than 10 alive this naturally lists only survivors, which is what
// the closing scoreboard is meant to show.
Game.prototype.updateLeaderboard = function () {
  // Dominators and Motherships are tanks, and used to sit on the scoreboard on
  // nought points alongside the players.
  var list = this.entities.filter(function (e) {
    return e.type === 'tank' && !e.dead && !e.isCloser && !e.modeEntity;
  });
  list.sort(function (a, b) { return b.score - a.score; });
  this.leader = list[0] || null;
  // Objective modes with a per-team tally show that in place of the player list,
  // the same rows the server builds online.
  var counts = this.teamCounts;
  this.leaderboard = counts ? this.teams.map(function (team) {
    return {
      name: team.charAt(0).toUpperCase() + team.slice(1), score: counts[team] || 0,
      team: team, tankId: 0, id: 0, fill: TEAM_COLORS[team][0]
    };
  }).sort(function (a, b) { return b.score - a.score; }) : list.slice(0, 10);
};

Game.prototype.onPlayerDeath = function () { /* wired by main.js */ };

// `old` lets a server respawn one specific client; locally it defaults to the player.
Game.prototype.respawnPlayer = function (name, old) {
  if (old === undefined) old = this.player;
  if (this.noRespawn) return null;                  // Survival: one life a round
  // Survival starts every round from scratch; everywhere else you come back one
  // rung down rather than from nothing.
  // Modes that hand out a finished tank respawn you at the same level rather
  // than one rung down — there is no rung.
  var fixed = this.rule('spawnLevel', 0);
  var lvl = fixed ? Math.min(this.levelCap(), fixed)
    : (old && !this.mode.freshStart ? respawnLevel(old.level) : 1);
  // You come back on your own side; Tag is the one mode that moves you, onto
  // whoever tagged you.
  var team = old ? (old.nextTeam || old.team) : undefined;
  var t = this.spawnTank({ name: name || (old && old.name) || '', isPlayer: true, score: LEVEL_SCORE[lvl], team: team });
  t.checkUpgrades();
  this.spectate = null;
  if (!this.headless) this.player = t;
  return t;
};

if (typeof module !== 'undefined') module.exports = {
  Game: Game, Tank: Tank, Entity: Entity, Shape: Shape, Barrel: Barrel,
  handleCollision: handleCollision, collides: collides, predictAim: predictAim, interceptAim: interceptAim,
  BOT_SKILL: BOT_SKILL, BOT_DIFFICULTIES: BOT_DIFFICULTIES, BOT_KNOB_GROUPS: BOT_KNOB_GROUPS, botSkill: botSkill,
  BOT_ROLES: BOT_ROLES, forceTankClass: forceTankClass, randomTankId: randomTankId, playableTankIds: playableTankIds,
  Boss: Boss, Turret: Turret
};
