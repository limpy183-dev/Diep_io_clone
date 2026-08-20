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
  this.vx -= this.vx * 0.1; this.vy -= this.vy * 0.1;   // friction: -10% of current velocity

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
  var reward = this.type === 'tank'
    ? this.score * KILL_SCORE_SHARE
    : this.scoreReward * this.game.mode.xp;
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

  var common = Math.max(a.minDmg, b.minDmg) * Math.min(a.maxDmg, b.maxDmg);
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
    if (self.owner && other.team !== null && self.team !== other.team) { self.kill(other); return; }
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
  // /bulletsize lives on the tank, so a turret asks the tank it is bolted to.
  var bsize = ((t.isTurret && t.parent ? t.parent : t).bulletSize) || 1;
  var scatter = (Math.PI / 180) * b.scatterRate * (Math.random() - 0.5) * 10;
  var ang = m.a + scatter;
  var proj = new Entity(g, {
    type: b.type === 'necrodrone' ? 'necro' : b.type,
    x: m.x, y: m.y, angle: ang,
    size: Math.max(2, (d.width / 2) * b.sizeRatio * t.scaleFactor * bsize),
    sides: b.sides !== undefined ? b.sides : (b.type === 'drone' || b.type === 'swarm' ? 3 : b.type === 'necrodrone' ? 4 : b.type === 'trap' ? 3 : 1),
    // A turret is not an entity, so its shots must be owned by the tank it is
    // bolted to — otherwise canInteract() never matches and they hit their own
    // tank on the way out (and kills go uncredited).
    team: t.team, owner: t.isTurret ? t.parent : t,
    fill: b.color || t.fill, stroke: b.stroke || t.stroke,
    maxHealth: (1.5 * st[S_PEN] + 2) * b.health,
    damage: (7 + st[S_DAMAGE] * 3) * b.damage,
    absorb: b.absorbtionFactor,
    push: (7 / 3 + st[S_DAMAGE]) * b.damage * b.absorbtionFactor
  });
  proj.barrel = this;
  proj.accel = accel;
  proj.noDmgIndicator = true;
  proj.hiddenHealthbar = true;

  switch (b.type) {
    case 'drone': case 'swarm': case 'minion':
      proj.minDmg = 1; proj.maxDmg = 1;
      proj.onlySameOwnerCollision = true;
      proj.accel = (b.type === 'minion' ? accel / 3 : accel) * 2;
      proj.push = 4;
      proj.controllable = !!d.canControlDrones;
      proj.life = b.lifeLength === -1 ? Infinity : 88 * b.lifeLength;
      proj.noDmgIndicator = false;
      if (b.type === 'minion') { proj.sides = 1; proj.barrels = [new Barrel(proj, MINION_BARREL, 0)]; proj.statsOwner = t; }
      break;
    case 'necrodrone':
      proj.minDmg = 1; proj.maxDmg = 1;
      proj.type = 'necro'; proj.sides = 4;
      proj.fill = C.necro; proj.stroke = C.necroS;
      proj.onlySameOwnerCollision = true;
      proj.push = 4;
      proj.controllable = true;
      proj.accel = accel * 2;
      proj.life = Infinity;
      proj.scoreReward = 10;
      proj.noDmgIndicator = false;
      break;
    case 'trap':
      proj.minDmg = 0.25; proj.maxDmg = 1;
      proj.noOwnTeamCollision = true;
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

  proj.addVelocity(ang, accel + 30 - Math.random() * b.scatterRate);
  if (b.type === 'trap') proj.accel = 0;            // traps coast to a stop and stay put
  g.add(proj);
  if (d.droneCount) this.children.push(proj);
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

var MINION_BARREL = {
  angle: 0, offset: 0, size: 55, width: 42, delay: 0, reload: 2, recoil: 0,
  isTrapezoid: false, trapezoidDirection: 0, addon: null,
  bullet: { type: 'bullet', sizeRatio: 1, health: 0.7, damage: 0.5, speed: 0.9, scatterRate: 1, lifeLength: 1, absorbtionFactor: 1 }
};

// ---------------------------------------------------------------- turret
function Turret(parent, index, count, arc) {
  this.parent = parent;
  this.isTurret = true;
  this.index = index;
  this.arc = arc;
  this.base = count === 1 ? 0 : (Math.PI * 2 * index) / count;
  this.angle = 0;
  this.target = null;
  this.barrel = new Barrel(this, TURRET_BARREL, 0);
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
    var b = TURRET_BARREL.bullet;
    this.angle = interceptAim(this, this.target, (20 + BSPEED_GAIN * this.stats[S_BSPEED]) * b.speed,
                              TURRET_BARREL.size * this.scaleFactor);
  } else {
    this.angle += PASSIVE_ROTATION;
  }
  this.barrel.tick(!!(this.target && !this.target.dead));
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
  this.level = levelFromScore(this.score);
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
  this.baseSize = def.baseSizeOverride || (def.sides === 4 ? 32.5 * ROOT2 : def.sides === 16 ? 25 * ROOT2 : 50);
  this.barrels = def.barrels.map(function (b, i) { return new Barrel(this, b, i); }, this);
  this.invisible = !!def.flags.invisibility;
  if (!this.invisible) this.opacity = 1;
  this.recompute();                       // must precede period(), which reads reloadTime
  this.turrets = [];
  var post = ADDONS[def.postAddon];
  if (post && post.turrets) {
    for (var i = 0; i < post.turrets; i++) this.turrets.push(new Turret(this, i, post.turrets, !!post.arc));
  }
  // Loaded but not yet past the delay threshold — see Barrel.tick.
  this.barrels.forEach(function (b) { b.cycle = b.period(); });
};

Tank.prototype.recompute = function () {
  var def = this.def, st = this.stats, L = this.level;
  this.scaleFactor = Math.pow(1.01, L - 1);
  this.size = this.baseSize * this.scaleFactor;
  var mh = def.maxHealth + 2 * (L - 1) + st[S_HEALTH] * 20;
  if (this.maxHealth) this.health = Math.min(this.health * (mh / this.maxHealth), mh);
  this.maxHealth = mh;
  this.regenPerTick = (mh * 4 * st[S_REGEN] + mh) / 25000;
  this.movementSpeed = def.speed * 2.55 * Math.pow(1.07, st[S_SPEED]) / Math.pow(1.015, L - 1);
  this.reloadTime = 15 * Math.pow(0.914, st[S_RELOAD]);
  this.damagePerTick = 5 + st[S_BODY] + (def.bodyDamage || 0);
  this.absorb = def.absorbtionFactor;
  this.push = def.absorbtionFactor;
  this.fov = 0.55 * def.fieldFactor / Math.pow(1.01, (L - 1) / 2);
  // bonusPoints is the /points cheat; the floor keeps an over-spent build (also
  // a cheat) from wrapping to 255 when it goes out on the wire as a u8.
  this.statsAvailable = Math.max(0, statCount(L) + (this.bonusPoints || 0) - st.reduce(function (a, b) { return a + b; }, 0));
};

Tank.prototype.addScore = function (n) {
  if (this.dead) return;
  this.score += n;
  var nl = levelFromScore(this.score);
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
    this.addVelocity(Math.atan2(my / m, mx / m), this.movementSpeed);
    this.moved = true;
  }

  if (this.autoSpin) { this.spinAngle += 0.06; this.angle = this.spinAngle; }
  else this.angle = Math.atan2(this.mouse.y - this.y, this.mouse.x - this.x);

  var shooting = !!(i.fire || this.autoFire);
  if (shooting) this.shot = true;
  for (var b = 0; b < this.barrels.length; b++) this.barrels[b].tick(shooting);
  for (var t = 0; t < this.turrets.length; t++) this.turrets[t].tick();

  // regen
  if (this.health < this.maxHealth) {
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
  if (this.possessing && typeof release === 'function') release(this.game, this);
  if (this.possessedBy && typeof release === 'function') release(this.game, this.possessedBy);
  var logic = this.game.logic;
  if (logic && logic.onTankDeath) logic.onTankDeath(this.game, this, source);
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
      this.maintainVelocity(this.orbitAngle, this.speed / 2);
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
      break;

    case 'drone': case 'necro': case 'swarm': case 'minion': {
      if (!owner || owner.dead) { p.kill(null); return; }
      var tx, ty, speed = p.accel;
      if (p.controllable && owner.input.fire) { tx = owner.mouse.x; ty = owner.mouse.y; }
      else if (p.controllable && owner.input.altFire) { tx = p.x * 2 - owner.mouse.x; ty = p.y * 2 - owner.mouse.y; }
      else {
        // Auto Fire turns drones into hunters: same homing, longer leash than
        // the 900 du idle guard radius, so they go after whoever is on screen.
        var range = owner.autoFire ? DRONE_HUNT_RANGE : 900;
        if (g.tick % 2 === p.id % 2) p.dTarget = g.findTarget(p, range, true, owner);
        if (p.dTarget && !p.dTarget.dead) { tx = p.dTarget.x; ty = p.dTarget.y; }
        else {
          // idle orbit around the owner
          var d = Math.hypot(p.x - owner.x, p.y - owner.y);
          if (d < 400) {
            p.orbit = (p.orbit || Math.atan2(p.y - owner.y, p.x - owner.x)) + 0.01 + 0.012 * (d / 400);
            tx = owner.x + Math.cos(p.orbit) * owner.size * 1.2 * 3;
            ty = owner.y + Math.sin(p.orbit) * owner.size * 1.2 * 3;
            speed = p.accel / 6 + p.accel / 2;
          } else { tx = owner.x; ty = owner.y; speed = p.accel / 3 * 2; }
        }
      }
      var ang = Math.atan2(ty - p.y, tx - p.x);
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
  var tankLike = spec.tankId !== undefined;
  Entity.call(this, game, {
    type: 'boss', x: rand(game.arena.left * 0.6, game.arena.right * 0.6), y: rand(game.arena.top * 0.6, game.arena.bottom * 0.6),
    sides: spec.sides, size: spec.sides === 1 ? spec.size : spec.size * Math.SQRT1_2,
    fill: spec.fill, stroke: spec.stroke, team: null,
    maxHealth: BOSS_HEALTH, damage: BOSS_DAMAGE, score: BOSS_SCORE, absorb: 0.05, push: 12
  });
  this.spec = spec;
  this.bossIndex = BOSSES.indexOf(spec);   // clients rebuild barrels from the same table
  this.name = spec.name;
  this.minDmg = 1; this.maxDmg = 6;
  this.scaleFactor = spec.sides === 1 ? spec.size / 50 : 1;
  this.stats = [0, 4, 4, 4, 4, 0, 0, 0];
  this.reloadTime = 15 * Math.pow(0.914, 4);
  this.movementSpeed = spec.speed;
  var defs = tankLike ? TANK_DEFS[spec.tankId].barrels : spec.barrels;
  var self = this;
  this.barrels = defs.map(function (b, i) {
    var copy = JSON.parse(JSON.stringify(b));
    if (tankLike) {
      copy.bullet.color = C.fallen; copy.bullet.stroke = C.fallenS;
      if (spec.droneOverride && copy.droneCount) copy.droneCount = spec.droneOverride;
      copy.bullet.health *= 3; copy.bullet.damage *= 1.5;
    }
    return new Barrel(self, copy, i);
  });
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

// Full 8-stat orders. The tail matters: a bot at level 45 holds 33 points and
// a short list leaves the remainder unspendable forever, so every build ranks
// all eight. Stats a class cannot take (a Smasher's bullet stats, max 0) are
// refused by upgradeStat and fall through to the next entry on their own.
// `ram` marks a body-damage build, which decides the class it upgrades into.
var BOT_BUILDS = [
  { ram: 0, order: [S_PEN, S_DAMAGE, S_RELOAD, S_BSPEED, S_HEALTH, S_SPEED, S_BODY, S_REGEN] },
  { ram: 1, order: [S_BODY, S_HEALTH, S_SPEED, S_REGEN, S_PEN, S_DAMAGE, S_RELOAD, S_BSPEED] },
  { ram: 0, order: [S_RELOAD, S_DAMAGE, S_PEN, S_SPEED, S_HEALTH, S_BSPEED, S_REGEN, S_BODY] },
  { ram: 0, order: [S_HEALTH, S_PEN, S_DAMAGE, S_REGEN, S_BODY, S_RELOAD, S_SPEED, S_BSPEED] }
];

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

// Things worth stepping out of the way of.
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
  var v = cruise + 30 - (bd.scatterRate || 0) / 2, x = 0;
  for (var n = 1; n <= life; n++) {
    v += cruise * 0.1;                 // maintainVelocity
    x += v;
    v -= v * 0.1;                      // friction
    if (x >= d) return n;
  }
  return 0;
}

// Roughly what this tank puts out per tick. Only ever used as a ratio between
// candidate targets, so the collision multipliers that scale every one of them
// equally are left out.
function botDps(t) {
  if (!t.barrels.length) return Math.max(1, t.damagePerTick);      // rammers hit with the body
  var dps = 0, dmg = 7 + t.stats[S_DAMAGE] * 3;
  for (var i = 0; i < t.barrels.length; i++) {
    var b = t.barrels[i];
    dps += dmg * b.def.bullet.damage * (b.def.pellets || 1) / b.period();
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
  if (t.level >= MAX_LEVEL - 2) return true;                       // nothing left to farm for
  // How readily the odds talk it out of something. At zero it charges whatever
  // it can see, which is most of what being an easy bot means.
  var floor = 0.45 * sk.sense;
  var odds = botWinOdds(t, tgt);
  // Being lined up on is not a fight that can be declined politely — walking
  // away just means eating the shots side-on. Answer unless it is hopeless.
  if (botThreatens(tgt, t) && dist2(t, tgt) < Math.pow(botReach(tgt) * 1.2, 2)) return odds > floor * 0.7;
  // Taking fire, and it is actually costing something. Without the health test
  // a single stray pellet in a crowded arena reads as "I am in a fight", every
  // bot answers, and nobody ever gets back to farming.
  if (t.game.tick - t.lastDamage < 50 && t.health < t.maxHealth * 0.85) return odds > floor * 0.7;
  if (odds > 0.5 + 0.2 * sk.sense) return true;                    // winning it cheaply
  if (tgt.isPlayer && sk.hunt >= 0.5 && odds > floor) return true;
  // How far it will cross to pick a fight. Two things set it: skill, because a
  // dumb bot charges anything it can see and a sharp one only what is already
  // on it — and whether that tank is even looking this way. Something with its
  // barrel pointed elsewhere is a thing to walk around, not a fight.
  var range = botReach(t) * (2.2 - 1.4 * sk.sense)
    * (botAimedAt(tgt, t) || botThreatens(tgt, t) ? 1.5 : 0.85);
  return odds > floor && dist2(t, tgt) < range * range;
}

// Not how far a bullet *can* go — a basic Tank's carries 1750 units, and a shot
// with three seconds of hang time hits nothing that moves. This is how far it
// can go and still arrive while the target is roughly where you aimed: one
// second of flight. That is the range bots actually fight at.
function botReach(t) {
  var b = t.barrels[0];
  if (!b) return 0;
  return (20 + BSPEED_GAIN * t.stats[S_BSPEED]) * b.def.bullet.speed * 25 + 250;
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
  t.rammer = d.barrels.length === 0;
  t.aiDrone = d.barrels.some(function (b) {
    var k = b.bullet.type;
    return k === 'drone' || k === 'swarm' || k === 'minion' || k === 'necrodrone';
  });
}

// Does this class suit the stat build the bot committed to at spawn? A rammer
// build upgrading into a Sniper wastes both halves of itself.
function botClassScore(d, build) {
  if (!d) return -Infinity;
  var ram = d.barrels.length === 0;
  if (build.ram) return (ram ? 12 : 0) + d.speed * 2 + d.maxHealth * 0.02;
  return (ram ? -12 : 6 + Math.min(d.barrels.length, 6)) + d.maxHealth * 0.01;
}

// One pass answers both questions: who to fight, and what to farm if nobody.
function botScan(t, sk, doShapes) {
  var g = t.game, i, e;
  var sight2 = sk.sight * sk.sight;
  // No farm radius. Distance is already priced in the value below, and a hard
  // cutoff made the pick flip on whether anything at all happened to fall inside
  // it. The farm knob sets how dearly the walk is charged instead — and it runs
  // this way round, not the other: undervaluing your own time is the dumb
  // mistake. A low weight sends a bot trekking after distant fat shapes, which
  // is where it wastes minutes and where it gets killed. Sharp bots clear what
  // is under them.
  var walk = 1.2 + 2.4 * sk.farm;
  // Pricing every shape in the arena costs a bot 1000 square roots per scan,
  // which at 28 bots and a two-tick react window ate 96% of the frame. Cull at
  // a radius wide enough that the choice never turns on it — a few hundred
  // candidates — and keep the nearest one as a floor so the list is never empty.
  var cull2 = 3000 * 3000, nearS = null, nearD = Infinity;
  var dps = botDps(t), speed = Math.max(1, t.movementSpeed * 10);   // terminal speed under 10% friction
  var b0 = t.barrels[0];
  var pen = Math.max(0.5, (1.5 * t.stats[S_PEN] + 2) * (b0 ? b0.def.bullet.health : 1));
  var bestT = null, bestTS = -Infinity, bestS = null, bestSS = -Infinity, bestAtUs = false;
  var hitter = g.tick - t.lastDamage < 120 ? t.lastHitBy : null;   // whoever last landed one

  for (i = 0; i < g.entities.length; i++) {
    e = g.entities[i];
    if (e === t || e.dead || e.sides === 0 || e.owner) continue;
    if (e.team !== null && e.team === t.team) continue;
    var shape = e.type === 'shape';
    if (shape && !doShapes) continue;
    if (!shape && e.type !== 'tank' && e.type !== 'boss') continue;
    var d2 = dist2(t, e);
    if (shape) {
      if (e.id === t.farmBan) continue;                        // tried it, got nowhere
      if (e.kind === 'alpha' && t.level < 25) continue;
      if (d2 < nearD) { nearD = d2; nearS = e; }
      if (d2 > cull2) continue;
      // Measured: a level 30 bot cracks a Hexagon in 235 ticks and a level 15
      // one never does at all. Half a minute of chewing is the line between a
      // fat target and a trap — but it is a heavy penalty, not a disqualification.
      // Excluding outright left bots with an empty list, and a bot with nothing
      // to shoot at wanders in a random new direction every 90 ticks with its
      // gun silent, which from across the map reads as a broken tank.
      var over = e.health > dps * 900 * (1 + t.stats[S_PEN] * 0.4) ? 0.02 : 1;
      // Value per tick, not value per metre. A level 2 bot grinding a 1500 HP
      // Hexagon earns far less than the same seconds spent on 10 HP Squares,
      // and pricing the kill time says so. As its damage grows the big shapes
      // come back on the menu by themselves — no level gates to hand-tune.
      // The walk is charged above its face value because it earns nothing and
      // is the part of farming that gets you killed, so a Square underfoot beats
      // a Pentagon two screens away even though the Pentagon pays better a shot.
      var kill = e.health / dps * (1 + e.health / (pen * 200));
      // And what the attempt costs in health. Rate alone says a Pentagon always
      // beats a Square — it pays 13x for 13x the work — but a small tank spends
      // five minutes pressed against something that hits for 3, which is why
      // low-level bots were dying on the farm. Weighing exposure against its own
      // health pool is what produces Squares, then Triangles, then Pentagons,
      // with no per-level table anywhere.
      var risk = e.damagePerTick * kill / Math.max(1, t.maxHealth);
      var ss = over * (e.scoreReward || 1) / ((walk * Math.sqrt(d2) / speed + kill) * (1 + risk));
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
    if (d2 > sight2 && e !== t.aiEngaged && !(e === hitter && d2 < botClear2(t, e, sk))) continue;
    if (e.opacity <= 0 && !t.seesInvisible) continue;          // a hidden Stalker is not there
    // Whoever is on us, plus whoever was and has not left yet — tickBot holds
    // the latch through the gaps between their shots. A fight already happening
    // is not a choice, so the odds do not get to price it: out-level a bot and
    // the punching-up penalty below used to rank you under a passing Square.
    var atUs = e === t.aiEngaged || e === hitter || botThreatens(e, t);
    var gap = (e.level || MAX_LEVEL) - t.level;
    var ts = -Math.sqrt(d2) / 400
      - (atUs ? 0 : sk.threat * Math.max(0, gap) * 0.22)       // punching up is how bots die
      + sk.threat * (1 - e.health / e.maxHealth) * 2           // finish what is already hurt
      + (e.isPlayer ? sk.hunt : 0)
      + (e.type === 'boss' ? sk.threat - 4 : 0)
      + (atUs ? sk.threat * (1.5 + Math.max(0, gap) * 0.08) : 0);   // answer whoever is coming for us,
    // and the bigger one first. Among fights already happening the level gap is
    // not a reason to stay out — it is which one is about to kill us.
    // Out of our league — but only worth ignoring if it is also far away and
    // minding its own business. Dropping it from the scan outright is what let
    // a big Smasher walk all the way in without the bot ever reacting.
    if (sk.threat && gap > 12 && ts < 0 && !atUs
        && d2 > Math.pow(botReach(t) * 1.5, 2)) continue;
    if (ts > bestTS) { bestTS = ts; bestT = e; bestAtUs = atUs; }
  }
  t.aiTarget = bestT;
  // The latch follows the pick whenever the pick is something that is actually
  // fighting us. First-come let one stray bot lining up somewhere behind hold
  // the slot while the player stood in front of us; the score already weighs
  // distance, woundedness and who is coming for us, so it is the better answer.
  if (bestAtUs) t.aiEngaged = bestT;
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
    if (p.dead || p.owner === t || !BOT_INCOMING[p.type]) return;
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

function tickBot(t) {
  var g = t.game, sk = t.botSkill || g.botSkill || BOT_SKILL.medium, i = t.input, k;
  if (!t.build || !t.build.order) t.build = pick(BOT_BUILDS);
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
  var doShapes = lostFarm || g.tick % 15 === t.id % 15;
  if (lostTank || lostFarm || doShapes || g.tick % sk.react === t.id % sk.react) botScan(t, sk, doShapes);
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
  if (tgt && sk.flee && (tgt.level || MAX_LEVEL) >= t.level - 4) {
    if (t.health < t.maxHealth * sk.flee) t.fleeing = true;
    else if (t.health > t.maxHealth * 0.75) t.fleeing = false;
  } else t.fleeing = false;
  if (backOff) t.fleeing = true;                 // fighting retreat, not a turned back

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

  var goal = tgt || farmable;
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
    var slugfest = !tgt && goal.health * goal.damagePerTick > 2000;
    // Extra spacing against a body-damage tank: touching you is its whole weapon.
    var ram = !!(tgt && tgt.barrels && tgt.barrels.length === 0);
    var ideal = t.rammer ? 0
      : (tgt || slugfest) ? Math.max(220, Math.min(1100, botReach(t) * sk.range)) * (t.fleeing ? 1.8 : 1) * (ram ? 1.5 : 1)
      : 260;
    // Signed, and never zero in the band around `ideal` — the old dead zone is
    // what left bots standing still at exactly the range they were being shot from.
    mv.x += Math.cos(to) * Math.max(-1, Math.min(1, (d - ideal) / 160));
    mv.y += Math.sin(to) * Math.max(-1, Math.min(1, (d - ideal) / 160));
    if (!t.rammer && sk.strafe && tgt) {
      if (t.strafeDir === undefined || g.tick % 140 === t.id % 140) t.strafeDir = sign();
      mv.x += -Math.sin(to) * sk.strafe * t.strafeDir;
      mv.y += Math.cos(to) * sk.strafe * t.strafeDir;
    }
    aim = botAim(t, goal, sk);
    boost = sk.sense >= 0.5 && !tgt && !t.rammer && !t.aiDrone && d > 900;
  } else {
    if (t.wander === undefined || g.tick % 90 === t.id % 90) t.wander = Math.random() * Math.PI * 2;
    mv.x += Math.cos(t.wander); mv.y += Math.sin(t.wander);
    aim = t.wander;
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
      t.unstick = 22; t.escape = Math.random() * Math.PI * 2;
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

  // Barrels snap to the mouse in the same tick, so there is never a swing to
  // wait out: anything with a barrel and a target shoots. Rammers hold fire
  // because they have no barrel to fire.
  i.fire = (goal && !t.rammer) ? 1 : 0;
  i.altFire = (t.aiDrone && sk.sense >= 0.7 && tgt && d < 320) ? 1 : 0;   // repel, don't feed them

  // spend points and take upgrades
  if (t.statsAvailable > 0) {
    for (k = 0; k < t.build.order.length; k++) if (t.upgradeStat(t.build.order[k])) break;
  }
  if (t.pendingUpgrades.length) {
    var choice;
    if (Math.random() < sk.sense) {
      // Everything close to the best, not the strict best: the score is a rough
      // proxy, and 28 bots all converging on one class reads as broken. The
      // margin is under the rammer bonus, so a body build still goes body.
      var best = -Infinity, pool = [], sc = [];
      for (k = 0; k < t.pendingUpgrades.length; k++) {
        sc[k] = botClassScore(TANK_DEFS[t.pendingUpgrades[k]], t.build);
        if (sc[k] > best) best = sc[k];
      }
      for (k = 0; k < t.pendingUpgrades.length; k++) if (sc[k] >= best - 2) pool.push(t.pendingUpgrades[k]);
      choice = pick(pool);
    } else choice = pick(t.pendingUpgrades);
    t.upgradeTo(choice);
  }
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

  var h = this.mode.size / 2;
  this.arena = { left: -h, right: h, top: -h, bottom: h, size: this.mode.size };
  this.teams = this.mode.teams;

  if (this.mode.maze) this.generateMaze();
  if (this.mode.bases) this.generateBases();

  // Objective modes (Domination, Tag, Mothership, Breakout, CTF) plug in here.
  this.logic = (this.mode.logic && typeof MODE_LOGIC !== 'undefined') ? MODE_LOGIC[this.mode.logic] : null;
  this.roundEndsAt = 0;
  this.mapDirty = true;
  if (this.logic && this.logic.init) this.logic.init(this);

  this.wantedShapes = this.mode.sandbox ? 120 : 1000;
  for (var i = 0; i < this.wantedShapes; i++) this.spawnShape();

  if (!this.headless) this.player = this.spawnTank({ name: playerName, isPlayer: true });
  this.setDifficulty(opts.difficulty || 'medium');
  this.botCount = opts.botCount !== undefined ? opts.botCount : (this.mode.sandbox ? 64 : 80);
  for (var b = 0; b < this.botCount; b++) this.spawnBot();
}

Game.prototype.add = function (e) { this.entities.push(e); return e; };
Game.prototype.notify = function (text, ticks) { this.notifications.push({ text: text, ttl: ticks || 100 }); };

Game.prototype.teamOf = function () {
  if (!this.teams) return null;
  var counts = {}, self = this;
  this.teams.forEach(function (t) { counts[t] = 0; });
  this.entities.forEach(function (e) { if (e.type === 'tank' && !e.dead && counts[e.team] !== undefined) counts[e.team]++; });
  return this.teams.reduce(function (a, b) { return counts[a] <= counts[b] ? a : b; });
};

// anywhere: skip the outer-ring rule, so bots scatter over the whole map.
Game.prototype.spawnPoint = function (team, anywhere) {
  var a = this.arena;
  if (team) {
    var base = this.bases.filter(function (b) { return b.team === team; })[0];
    if (base) return { x: base.x + rand(-base.size * 0.7, base.size * 0.7), y: base.y + rand(-base.width * 0.7, base.width * 0.7) };
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
  var t = new Tank(this, { x: p.x, y: p.y, name: o.name, isPlayer: o.isPlayer, bot: o.bot, team: team, score: o.score || 0 });
  this.paintTeam(t);
  return this.add(t);
};

Game.prototype.paintTeam = function (t) {
  if (t.team && TEAM_COLORS[t.team]) { t.fill = TEAM_COLORS[t.team][0]; t.stroke = TEAM_COLORS[t.team][1]; }
  else if (t.isPlayer) { t.fill = C.blue; t.stroke = C.blueS; }        // in FFA you are always blue
  else { t.fill = C.red; t.stroke = C.redS; }                          // and everyone else is red
};

Game.prototype.spawnBot = function () {
  var t = this.spawnTank({ name: pick(BOT_NAMES) + (Math.random() < 0.4 ? ' ' + ((Math.random() * 99) | 0) : ''), bot: true });
  t.autoFire = false;
  t.build = pick(BOT_BUILDS);
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

Game.prototype.generateMaze = function () {
  var a = this.arena, step = 500;
  for (var x = a.left + step; x < a.right - step; x += step) {
    for (var y = a.top + step; y < a.bottom - step; y += step) {
      if (Math.random() > 0.16) continue;
      if (Math.max(Math.abs(x), Math.abs(y)) < a.right / 8) continue;   // keep the nest open
      var wx = Math.round(x / GRID) * GRID, wy = Math.round(y / GRID) * GRID;
      var long = Math.random() < 0.5;
      var w = new Entity(this, {
        type: 'wall', x: wx, y: wy, sides: 2,
        size: long ? 375 : 125, width: long ? 125 : 375,
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
  var layouts = n === 2
    ? [{ x: a.left + 1400, y: 0, size: 1400, width: a.bottom }, { x: a.right - 1400, y: 0, size: 1400, width: a.bottom }]
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
  shape.minDmg = 1; shape.maxDmg = 1;
  shape.fill = shape.shiny ? C.shiny : C.necro; shape.stroke = shape.shiny ? C.shinyS : C.necroS;
  shape.maxHealth = (1.5 * st[S_PEN] + 2) * bd.health;
  shape.health = shape.maxHealth;
  shape.damagePerTick = (7 + st[S_DAMAGE] * 3) * bd.damage;
  shape.push = 4;
  shape.accel = ((20 + BSPEED_GAIN * st[S_BSPEED]) * bd.speed) / 3;
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
  if (base.isTile) { if (e.owner !== undefined && e.type !== 'tank' && e.type !== 'boss') e.kill(base); return; }
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
        else if (e.bot && !e.parked && !e.immobile) tickBot(e);
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
    if (this.logic && this.logic.reset) this.logic.reset(this);
    for (var r = 0; r < this.entities.length; r++) {
      var t = this.entities[r];
      if (t.type === 'tank' && !t.dead && (t.bot || t.isPlayer) && !t.immobile && !t.isMothership) t.kill(null);
    }
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
  var list = this.entities.filter(function (e) { return e.type === 'tank' && !e.dead && !e.isCloser; });
  list.sort(function (a, b) { return b.score - a.score; });
  this.leaderboard = list.slice(0, 10);
  this.leader = list[0] || null;
};

Game.prototype.onPlayerDeath = function () { /* wired by main.js */ };

// `old` lets a server respawn one specific client; locally it defaults to the player.
Game.prototype.respawnPlayer = function (name, old) {
  if (old === undefined) old = this.player;
  var lvl = old ? respawnLevel(old.level) : 1;
  // Tag hands you your killer's colours on respawn.
  var team = old && old.nextTeam ? old.nextTeam : undefined;
  var t = this.spawnTank({ name: name || (old && old.name) || '', isPlayer: true, score: LEVEL_SCORE[lvl], team: team });
  t.checkUpgrades();
  this.spectate = null;
  if (!this.headless) this.player = t;
  return t;
};

if (typeof module !== 'undefined') module.exports = {
  Game: Game, Tank: Tank, Entity: Entity, Shape: Shape, Barrel: Barrel,
  handleCollision: handleCollision, collides: collides, predictAim: predictAim, interceptAim: interceptAim,
  BOT_SKILL: BOT_SKILL, BOT_DIFFICULTIES: BOT_DIFFICULTIES, BOT_KNOB_GROUPS: BOT_KNOB_GROUPS, botSkill: botSkill
};
