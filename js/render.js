// render.js — canvas 2D drawing. Reads the sim, never writes to it.
// Draw order follows the real client: grid, borders, leader arrow, entities,
// names, health bars, UI. Names and bars come after ALL entities so nothing
// occludes them.

function Renderer(canvas, game) {
  this.canvas = canvas;
  this.ctx = canvas.getContext('2d');
  this.game = game;
  this.cam = { x: 0, y: 0, fov: 0.35 };
  this.gridPattern = null;
  this.showClassTree = false;
  this.alpha = 0;
  this.statsT = 0;      // 0 = panel parked off-screen left, 1 = fully in
  this.statsTime = 0;
}

// Canvas dimensions, not window — devicePixelRatio changes the answer.
Renderer.prototype.windowScaling = function () {
  var a = this.canvas.height / 1080, b = this.canvas.width / 1920;
  return b < a ? a : b;
};
Renderer.prototype.scaling = function () { return this.cam.fov * this.windowScaling(); };
Renderer.prototype.toScreen = function (x, y) {
  var k = this.scaling();
  return { x: (x - this.cam.x) * k + this.canvas.width / 2, y: (y - this.cam.y) * k + this.canvas.height / 2 };
};
Renderer.prototype.toWorld = function (sx, sy) {
  var k = this.scaling();
  return { x: (sx - this.canvas.width / 2) / k + this.cam.x, y: (sy - this.canvas.height / 2) / k + this.cam.y };
};

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) { var d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; }
function ipos(e, t) { return { x: lerp(e.px, e.x, t), y: lerp(e.py, e.y, t), a: lerpAngle(e.pa, e.angle, t), s: lerp(e.psize, e.size, t) }; }

Renderer.prototype.updateCamera = function (dt) {
  var p = this.game.player;
  // offline, piloting a Dominator/Mothership moves the camera onto it
  if (p && p.possessing && !p.possessing.dead) p = p.possessing;
  if (p && !p.dead) {
    var tx = p.x, ty = p.y;
    // Predator's right-click pushes the camera up to 1500 units toward the cursor
    if (p.def.flags.zoomAbility && p.input.altFire) {
      var d = Math.hypot(p.mouse.x - p.x, p.mouse.y - p.y);
      var k = Math.min(1500, d) / (d || 1);
      tx += (p.mouse.x - p.x) * k; ty += (p.mouse.y - p.y) * k;
    }
    this.cam.x = lerp(this.cam.x, tx, 0.25);
    this.cam.y = lerp(this.cam.y, ty, 0.25);
    this.cam.fov = lerp(this.cam.fov, p.fov, 0.05);
  } else if (p) {
    this.cam.fov = lerp(this.cam.fov, 0.4, 0.05);
    var k2 = this.game.spectate;
    if (k2 && !k2.dead) { this.cam.x = lerp(this.cam.x, k2.x, 0.1); this.cam.y = lerp(this.cam.y, k2.y, 0.1); }
  }
};

// --- primitives ---------------------------------------------------------
function polyPath(ctx, x, y, r, sides, angle) {
  ctx.beginPath();
  if (sides <= 1) { ctx.arc(x, y, r, 0, Math.PI * 2); return; }
  for (var i = 0; i < sides; i++) {
    var a = angle + (i / sides) * Math.PI * 2;
    var px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}
function starPath(ctx, x, y, r, points, angle) {
  ctx.beginPath();
  for (var i = 0; i < points * 2; i++) {
    var a = angle + (i / (points * 2)) * Math.PI * 2;
    var rr = i % 2 ? r * 0.55 : r;
    var px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

Renderer.prototype.fillStroke = function (fill, stroke, lw) {
  var c = this.ctx;
  c.fillStyle = fill; c.fill();
  c.lineWidth = lw; c.strokeStyle = stroke; c.lineJoin = 'round'; c.stroke();
};

// --- grid ---------------------------------------------------------------
Renderer.prototype.drawGrid = function () {
  var c = this.ctx, k = this.scaling(), w = this.canvas.width, h = this.canvas.height;
  c.fillStyle = C.gridFill;
  c.fillRect(0, 0, w, h);
  var step = GRID * k;
  if (step < 4) return;
  c.save();
  c.globalAlpha = Math.min(1, k) * 0.1;
  c.strokeStyle = '#000000';
  c.lineWidth = 1;
  c.beginPath();
  var ox = (w / 2 - this.cam.x * k) % step, oy = (h / 2 - this.cam.y * k) % step;
  for (var x = ox; x < w; x += step) { c.moveTo(x | 0, 0); c.lineTo(x | 0, h); }
  for (var y = oy; y < h; y += step) { c.moveTo(0, y | 0); c.lineTo(w, y | 0); }
  c.stroke();
  c.restore();
};

// The 200-unit walkable margin outside the field renders as darker grey.
Renderer.prototype.drawBorders = function () {
  var c = this.ctx, a = this.game.arena;
  var tl = this.toScreen(a.left, a.top), br = this.toScreen(a.right, a.bottom);
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.12)';
  c.beginPath();
  c.rect(0, 0, this.canvas.width, this.canvas.height);
  c.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  c.fill('evenodd');
  c.restore();
};

// --- barrels ------------------------------------------------------------
Renderer.prototype.drawBarrel = function (e, b, ex, ey, ea, scale, colorFill, colorStroke) {
  var c = this.ctx, k = this.scaling(), d = b.def;
  var a = ea + d.angle;
  var len = d.size * scale * k;
  var w = d.width * scale * k / 2;
  var off = d.offset * scale * k;
  var pull = 1 - b.recoilAnim * 0.12;
  var sp = this.toScreen(ex, ey);
  c.save();
  c.translate(sp.x, sp.y);
  c.rotate(a);
  c.translate(0, off);
  var narrow = w * 0.7;
  c.beginPath();
  if (d.isTrapezoid) {
    if (d.trapezoidDirection === 0) { c.moveTo(0, -narrow); c.lineTo(len * pull, -w); c.lineTo(len * pull, w); c.lineTo(0, narrow); }
    else { c.moveTo(0, -w); c.lineTo(len * pull, -narrow); c.lineTo(len * pull, narrow); c.lineTo(0, w); }
  } else {
    c.rect(0, -w, len * pull, w * 2);
  }
  c.closePath();
  this.fillStroke(colorFill || C.barrel, colorStroke || C.barrelS, Math.max(1, 6 * scale * k));
  // trapper hood sits at the mouth
  if (d.addon === 'trapLauncher') {
    var hw = w * 1.25, hl = len * 0.28;
    c.beginPath();
    c.moveTo(len * pull, -w); c.lineTo(len * pull + hl, -hw); c.lineTo(len * pull + hl, hw); c.lineTo(len * pull, w);
    c.closePath();
    this.fillStroke(C.barrel, C.barrelS, Math.max(1, 6 * scale * k));
  }
  c.restore();
};

Renderer.prototype.drawTurret = function (t, ex, ey, scale) {
  var c = this.ctx, k = this.scaling();
  var base = t.parent.size * TURRET.base * k;
  var sp = this.toScreen(t.x, t.y);
  // barrel
  var b = t.barrel.def;
  var len = t.parent.size * TURRET.barrelLen * k;
  var w = t.parent.size * TURRET.barrelWidth * k / 2;
  c.save();
  c.translate(sp.x, sp.y);
  c.rotate(t.angle);
  c.beginPath(); c.rect(0, -w, len * (1 - t.barrel.recoilAnim * 0.12), w * 2); c.closePath();
  this.fillStroke(C.barrel, C.barrelS, Math.max(1, 6 * this.scaling() * (t.parent.size / 50)));
  c.restore();
  // mount
  polyPath(c, sp.x, sp.y, base, 1, 0);
  this.fillStroke(C.barrel, C.barrelS, Math.max(1, 6 * this.scaling() * (t.parent.size / 50)));
};

// --- entities -----------------------------------------------------------
Renderer.prototype.drawEntity = function (e, t) {
  var c = this.ctx, k = this.scaling();
  var p = ipos(e, t);
  var sp = this.toScreen(p.x, p.y);
  var r = p.s * k;
  // cull
  var pad = r + 200;
  if (sp.x < -pad || sp.y < -pad || sp.x > this.canvas.width + pad || sp.y > this.canvas.height + pad) return;

  c.save();
  c.globalAlpha = e.opacity;
  var lw = Math.max(1, (e.borderWidth || 7.5) * (e.scaleFactor || 1) * k);

  var fill = e.fill, stroke = e.stroke;
  if (e.hurtFlash > 0) { fill = mixHex(fill, '#FFFFFF', 0.55); stroke = mixHex(stroke, '#FFFFFF', 0.35); }

  if (e.type === 'wall' || e.type === 'base' || e.type === 'tile') {
    var tl = this.toScreen(p.x - e.size, p.y - e.width), br = this.toScreen(p.x + e.size, p.y + e.width);
    if (e.type === 'base') c.globalAlpha = 0.22;
    else if (e.type === 'tile') {
      // unclaimed tiles read as maze wall; a camped tile flashes before it collapses
      c.globalAlpha = e.team === null ? 0.55 : 0.3;
      if (e.warning) { c.globalAlpha = 0.35 + 0.3 * Math.sin(this.game.tick * 0.5); fill = C.neutral; }
    }
    c.beginPath(); c.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y); c.closePath();
    this.fillStroke(fill, stroke, e.type === 'wall' ? Math.max(1, 8 * k) : 0);
    if (e.type === 'tile') {
      c.globalAlpha = 0.5; c.lineWidth = Math.max(1, 4 * k); c.strokeStyle = stroke;
      c.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    }
    c.restore(); return;
  }
  if (e.sides === 0) { c.restore(); return; }

  var isTank = e.type === 'tank' || e.type === 'boss';
  var scale = e.scaleFactor || 1;

  // guard shells (smasher/landmine/spike) draw beneath the body
  if (isTank && e.def && ADDONS[e.def.postAddon] && ADDONS[e.def.postAddon].guards) {
    var guards = ADDONS[e.def.postAddon].guards;
    for (var gi = 0; gi < guards.length; gi++) {
      var g = guards[gi];
      polyPath(c, sp.x, sp.y, r * g.ratio * ROOT2 * 0.72, g.sides, (g.offset || 0) + e.guardAngle * g.spin);
      this.fillStroke(mixHex(fill, '#000000', 0.12), stroke, lw);
    }
  }
  // dominator plinth
  if (isTank && e.def && ADDONS[e.def.preAddon] && ADDONS[e.def.preAddon].guards) {
    var pg = ADDONS[e.def.preAddon].guards[0];
    polyPath(c, sp.x, sp.y, r * pg.ratio * ROOT2 * 0.72, pg.sides, 0);
    this.fillStroke(mixHex(fill, '#000000', 0.12), stroke, lw);
  }

  // Barrels under the body. A Firework shell carries 16 shard barrels purely so
  // the burst can reuse the firing path — they are not hardware, so don't draw
  // them, or the shell renders as a starburst instead of a plain hexagon.
  if (e.barrels && e.type !== 'firework') {
    // missiles render their barrels in the team colour, the only coloured barrels in the game
    var isMissile = e.type === 'skimmer' || e.type === 'rocket' || e.type === 'glider';
    var bf = isMissile ? fill : null, bs = isMissile ? stroke : null;
    var bscale = isTank ? scale : (p.s / (e.barrels[0] ? e.barrels[0].def.width / 2 : 21));
    for (var i = 0; i < e.barrels.length; i++) this.drawBarrel(e, e.barrels[i], p.x, p.y, p.a, isTank ? scale : bscale, bf, bs);
  }
  // pronounced nub (Ranger / Dominator)
  if (isTank && e.def && ADDONS[e.def.postAddon] && ADDONS[e.def.postAddon].nub) {
    var n = ADDONS[e.def.postAddon].nub;
    this.drawBarrel(e, { def: { angle: n.angle, offset: 0, size: n.size, width: n.width, isTrapezoid: true, trapezoidDirection: n.dir, addon: null }, recoilAnim: 0 }, p.x, p.y, p.a, scale);
  }
  // launcher hood (Skimmer / Rocketeer)
  if (isTank && e.def && e.def.preAddon === 'launcher') {
    var lh = ADDONS.launcher.hood;
    this.drawBarrel(e, { def: { angle: 0, offset: 0, size: 50 * lh.lengthRatio, width: 50 * lh.widthRatio * 2, isTrapezoid: true, trapezoidDirection: 0, addon: null }, recoilAnim: 0 }, p.x, p.y, p.a, scale);
  }

  // body — polygons draw at circumradius size*sqrt(2), circles at size
  if (e.isStar) starPath(c, sp.x, sp.y, r * ROOT2, 3, p.a);
  else polyPath(c, sp.x, sp.y, e.sides === 1 ? r : r * ROOT2, e.sides, p.a);
  this.fillStroke(fill, stroke, lw);

  // turrets on top
  if (e.turrets) for (var ti = 0; ti < e.turrets.length; ti++) this.drawTurret(e.turrets[ti], p.x, p.y, scale);

  // spawn protection blink
  if (isTank && e.damageReduction === 0 && !e.godMode) {
    c.globalAlpha = 0.25 + 0.2 * Math.sin(this.game.tick * 0.4);
    polyPath(c, sp.x, sp.y, e.sides === 1 ? r : r * ROOT2, e.sides, p.a);
    c.fillStyle = '#FFFFFF'; c.fill();
  }
  c.restore();
};

function mixHex(a, b, t) {
  var ai = parseInt(a.slice(1), 16), bi = parseInt(b.slice(1), 16);
  var r = Math.round(((ai >> 16) & 255) * (1 - t) + ((bi >> 16) & 255) * t);
  var g = Math.round(((ai >> 8) & 255) * (1 - t) + ((bi >> 8) & 255) * t);
  var bl = Math.round((ai & 255) * (1 - t) + (bi & 255) * t);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
}

Renderer.prototype.drawHealthBar = function (e, t) {
  if (e.hiddenHealthbar || e.dead) return;
  if (e.health >= e.maxHealth - 0.01) return;
  var c = this.ctx, k = this.scaling(), p = ipos(e, t);
  var sp = this.toScreen(p.x, p.y);
  var r = p.s * k * (e.sides === 1 ? 1 : ROOT2);
  var w = r * 2, h = Math.max(3, 9 * k * (e.scaleFactor || 1));
  var y = sp.y + r + h * 1.6;
  if (sp.x + w < 0 || sp.x - w > this.canvas.width || y < 0 || y > this.canvas.height) return;
  c.save();
  c.globalAlpha = e.opacity;
  c.lineCap = 'round';
  c.lineWidth = h; c.strokeStyle = 'rgba(0,0,0,0.25)';
  c.beginPath(); c.moveTo(sp.x - w / 2, y); c.lineTo(sp.x + w / 2, y); c.stroke();
  c.lineWidth = h * 0.62; c.strokeStyle = C.healthBar;
  var frac = Math.max(0, e.health / e.maxHealth);
  c.beginPath(); c.moveTo(sp.x - w / 2, y); c.lineTo(sp.x - w / 2 + w * frac, y); c.stroke();
  c.restore();
};

Renderer.prototype.drawName = function (e, t) {
  if (!e.name || e.dead) return;
  var c = this.ctx, k = this.scaling(), p = ipos(e, t);
  var sp = this.toScreen(p.x, p.y);
  var r = p.s * k * (e.sides === 1 ? 1 : ROOT2);
  if (sp.x < -200 || sp.x > this.canvas.width + 200) return;
  var size = Math.max(10, 34 * k * (e.scaleFactor || 1));
  c.save();
  c.globalAlpha = e.opacity;
  c.font = 'bold ' + size + 'px Ubuntu, Verdana, sans-serif';
  c.textAlign = 'center';
  c.lineWidth = size * 0.22; c.strokeStyle = '#000';
  c.strokeText(e.name, sp.x, sp.y - r - size * 0.55);
  c.fillStyle = '#FFF';
  c.fillText(e.name, sp.x, sp.y - r - size * 0.55);
  c.restore();
};

Renderer.prototype.drawLeaderArrow = function () {
  var g = this.game, l = g.leader, p = g.player;
  if (!l || !p || l === p || l.dead) return;
  var c = this.ctx;
  var sp = this.toScreen(l.x, l.y);
  var cx = this.canvas.width / 2, cy = this.canvas.height / 2;
  var dx = sp.x - cx, dy = sp.y - cy;
  var d = Math.hypot(dx, dy);
  var margin = Math.min(cx, cy) * 0.86;
  if (d < margin) return;
  var a = Math.atan2(dy, dx);
  var x = cx + Math.cos(a) * margin, y = cy + Math.sin(a) * margin;
  c.save();
  c.translate(x, y); c.rotate(a);
  c.globalAlpha = Math.min(1, (d - margin) / 400);
  c.beginPath(); c.moveTo(18, 0); c.lineTo(-12, -14); c.lineTo(-12, 14); c.closePath();
  this.fillStroke('#000000', '#000000', 2);
  c.restore();
};

// --- HUD ----------------------------------------------------------------
function abbrev(n) {
  n = Math.floor(n);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

Renderer.prototype.bar = function (x, y, w, h, frac, color, label) {
  var c = this.ctx;
  c.save();
  c.lineCap = 'round';
  c.lineWidth = h; c.strokeStyle = 'rgba(0,0,0,0.72)';
  c.beginPath(); c.moveTo(x + h / 2, y); c.lineTo(x + w - h / 2, y); c.stroke();
  if (frac > 0) {
    c.lineWidth = h * 0.78; c.strokeStyle = color;
    c.beginPath(); c.moveTo(x + h / 2, y);
    c.lineTo(x + h / 2 + Math.max(0, (w - h)) * Math.min(1, frac), y); c.stroke();
  }
  if (label) {
    c.font = 'bold ' + (h * 0.72) + 'px Ubuntu, Verdana, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = h * 0.16; c.strokeStyle = '#000';
    c.strokeText(label, x + w / 2, y + 1);
    c.fillStyle = '#FFF'; c.fillText(label, x + w / 2, y + 1);
  }
  c.restore();
};

Renderer.prototype.drawScoreboard = function () {
  var g = this.game, c = this.ctx;
  var w = 240, x = this.canvas.width - w - 20, y = 46;
  c.save();
  c.font = 'bold 24px Ubuntu, Verdana, sans-serif'; c.textAlign = 'center';
  c.lineWidth = 5; c.strokeStyle = '#000'; c.strokeText('Scoreboard', x + w / 2, y - 12);
  c.fillStyle = '#FFF'; c.fillText('Scoreboard', x + w / 2, y - 12);
  var max = g.leaderboard.length ? g.leaderboard[0].score : 1;
  for (var i = 0; i < g.leaderboard.length; i++) {
    var t = g.leaderboard[i];
    var by = y + i * 26, bh = 20;
    var col = t.team && TEAM_COLORS[t.team] ? TEAM_COLORS[t.team][0] : C.scoreBar;
    var frac = Math.min(1, Math.max(0.04, t.score / (max || 1)));
    this.bar(x, by, w, bh, frac, col, null);
    // each entry's tank rides the tip of its own fill
    var def = t.def || TANK_DEFS[t.tankId];
    if (def) this.drawTankIcon(def, x + bh / 2 + (w - bh) * frac, by, bh * 0.36);
    c.font = 'bold 14px Ubuntu, Verdana, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    var label = (t.name ? t.name + ' - ' : '') + abbrev(t.score);
    c.lineWidth = 3.2; c.strokeStyle = '#000'; c.strokeText(label, x + w / 2, by + 1);
    c.fillStyle = '#FFF'; c.fillText(label, x + w / 2, by + 1);
  }
  c.restore();
};

Renderer.prototype.drawMinimap = function () {
  var g = this.game, c = this.ctx, a = g.arena;
  var s = 180, x = this.canvas.width - s - 20, y = this.canvas.height - s - 20;
  c.save();
  // "diep.io / N players" caption sits above the minimap
  var count = 0;
  for (var ei = 0; ei < g.entities.length; ei++) if (g.entities[ei].type === 'tank' && !g.entities[ei].dead) count++;
  c.textAlign = 'right'; c.textBaseline = 'alphabetic';
  c.font = 'bold 22px Ubuntu, Verdana, sans-serif';
  c.lineWidth = 4.5; c.strokeStyle = '#000';
  c.strokeText('diep.io', x + s, y - 32); c.fillStyle = '#FFF'; c.fillText('diep.io', x + s, y - 32);
  c.font = 'bold 15px Ubuntu, Verdana, sans-serif'; c.lineWidth = 3.5;
  c.strokeText(count + ' players', x + s, y - 12);
  c.fillStyle = '#FFF'; c.fillText(count + ' players', x + s, y - 12);
  c.globalAlpha = 0.75;
  c.fillStyle = C.gridFill; c.fillRect(x, y, s, s);
  c.lineWidth = 3; c.strokeStyle = C.border; c.strokeRect(x, y, s, s);
  var k = s / a.size;
  var mx = function (wx) { return x + (wx - a.left) * k; }, my = function (wy) { return y + (wy - a.top) * k; };
  g.bases.forEach(function (b) {
    c.globalAlpha = 0.4; c.fillStyle = b.fill;
    c.fillRect(mx(b.x - b.size), my(b.y - b.width), b.size * 2 * k, b.width * 2 * k);
  });
  c.globalAlpha = 0.5; c.fillStyle = '#8C8C8C';
  g.walls.forEach(function (w) { c.fillRect(mx(w.x - w.size), my(w.y - w.width), w.size * 2 * k, w.width * 2 * k); });

  // objective overlay: 0 tile, 1 dominator/mothership, 2 collapsing tile, 3 flag
  // Online it arrives as a packet; offline we read the live entities directly.
  var overlay = g.overlay || localOverlay(g);
  for (var i = 0; i < overlay.length; i++) {
    var o = overlay[i];
    c.fillStyle = o.fill;
    if (o.kind === 0 || o.kind === 2) {
      c.globalAlpha = o.kind === 2 ? 0.3 + 0.4 * Math.sin(g.tick * 0.5) : 0.5;
      c.fillRect(mx(o.x - o.w), my(o.y - o.h), o.w * 2 * k, o.h * 2 * k);
    } else {
      c.globalAlpha = 0.95;
      var rr = Math.max(o.kind === 3 ? 2 : 4, o.w * k);
      c.beginPath(); c.arc(mx(o.x), my(o.y), rr, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1; c.lineWidth = 1.5; c.strokeStyle = '#000'; c.stroke();
    }
  }
  var p = g.player;
  if (p && !p.dead) {
    c.globalAlpha = 1; c.fillStyle = '#000';
    c.save(); c.translate(mx(p.x), my(p.y)); c.rotate(p.angle);
    c.beginPath(); c.moveTo(7, 0); c.lineTo(-4, -5); c.lineTo(-4, 5); c.closePath(); c.fill();
    c.restore();
  }
  c.restore();
};

function localOverlay(g) {
  var out = [];
  var add = function (e, kind, w, h) { out.push({ x: e.x, y: e.y, w: w, h: h, kind: kind, fill: e.fill }); };
  if (g.tiles) for (var i = 0; i < g.tiles.length; i++) add(g.tiles[i], g.tiles[i].warning ? 2 : 0, g.tiles[i].size, g.tiles[i].width);
  if (g.dominators) for (i = 0; i < g.dominators.length; i++) add(g.dominators[i], 1, g.dominators[i].size, g.dominators[i].size);
  if (g.motherships) for (i = 0; i < g.motherships.length; i++) if (!g.motherships[i].dead) add(g.motherships[i], 1, g.motherships[i].size, g.motherships[i].size);
  if (g.flags) for (i = 0; i < g.flags.length; i++) add(g.flags[i], 3, g.flags[i].size, g.flags[i].size);
  return out;
}

Renderer.prototype.drawStatus = function () {
  var g = this.game, p = g.player, c = this.ctx;
  if (!p) return;
  var w = 420, x = (this.canvas.width - w) / 2, y = this.canvas.height - 44;
  var span = LEVEL_SCORE[Math.min(MAX_LEVEL, p.level) + 1] - LEVEL_SCORE[p.level];
  var into = p.level >= MAX_LEVEL ? 1 : (p.score - LEVEL_SCORE[p.level]) / (span || 1);
  // gold plate is a static nameplate; the green bar above is the XP progress
  this.bar(x, y, w, 26, 1, C.levelBar, 'Lvl ' + p.level + ' ' + p.def.name);
  this.bar(x + 40, y - 30, w - 80, 22, into, C.scoreBar, 'Score: ' + abbrev(p.score));
};

Renderer.prototype.statRects = function () {
  var p = this.game.player;
  if (!p) return [];
  if (this.statsT < 0.01) return [];
  var out = [], bw = 210, bh = 22, gap = 5;
  var x = 20 - (1 - this.statsT) * (bw + 80), y0 = this.canvas.height - 42;
  for (var ui = 0; ui < 8; ui++) {
    var wire = uiToWire(ui);
    if (p.def.stats[wire].max === 0) continue;
    out.push({ ui: ui, wire: wire, x: x, y: 0, w: bw, h: bh });
  }
  // real client lists [1] Health Regen at the top down to [8] Movement Speed
  for (var i = 0; i < out.length; i++) out[i].y = y0 - (out.length - 1 - i) * (bh + gap);
  return out;
};

Renderer.prototype.drawStats = function () {
  var g = this.game, p = g.player, c = this.ctx;
  var now = performance.now(), dt = Math.min(0.1, (now - this.statsTime) / 1000 || 0);
  this.statsTime = now;
  // slide+fade in only while there are points to spend
  var target = (p && !p.dead && p.statsAvailable > 0) ? 1 : 0;
  this.statsT += (target - this.statsT) * (1 - Math.exp(-dt * 9));
  if (Math.abs(target - this.statsT) < 0.005) this.statsT = target;
  if (!p || p.dead) return;
  var rects = this.statRects();
  if (!rects.length) return;
  c.save();
  c.globalAlpha = this.statsT;
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i], wire = r.wire, def = p.def.stats[wire];
    var cur = p.stats[wire], max = def.max;
    var col = STAT_COLORS[r.ui];
    var rad = r.h / 2;
    c.beginPath(); c.roundRect(r.x, r.y, r.w, r.h, rad);
    c.fillStyle = 'rgba(0,0,0,0.72)'; c.fill();
    // pips clipped to the pill so the ends stay rounded
    c.save(); c.clip();
    var pipW = (r.w - 4) / max;
    for (var k = 0; k < max; k++) {
      var queuedCount = p.queued.filter(function (q) { return q === wire; }).length;
      if (k < cur) c.fillStyle = col;
      else if (k < cur + queuedCount) c.fillStyle = 'rgba(255,255,255,0.35)';
      else continue;
      c.fillRect(r.x + 2 + k * pipW + 1, r.y + 2, pipW - 2, r.h - 4);
    }
    c.restore();
    // label right-aligned, key number last: "Health Regen [1]"
    c.font = 'bold 12px Ubuntu, Verdana, sans-serif'; c.textAlign = 'right'; c.textBaseline = 'middle';
    c.lineWidth = 3; c.strokeStyle = '#000';
    var label = def.name + ' [' + (r.ui + 1) + ']';
    c.strokeText(label, r.x + r.w - 10, r.y + r.h / 2);
    c.fillStyle = '#FFF'; c.fillText(label, r.x + r.w - 10, r.y + r.h / 2);
    // + button is always present in the real client, dimmed when unspendable
    var bx = r.x + r.w + 5, bw2 = r.h * 1.28;
    var live = p.statsAvailable > 0 && cur < max;
    c.globalAlpha = this.statsT * (live ? 1 : 0.45);
    c.beginPath(); c.roundRect(bx, r.y, bw2, r.h, 5);
    c.fillStyle = col; c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 2; c.stroke();
    // plus is a solid black cross, not a glyph
    var arm = r.h * 0.28, th = r.h * 0.15, px = bx + bw2 / 2, py = r.y + r.h / 2;
    c.fillStyle = '#000';
    c.fillRect(px - arm, py - th / 2, arm * 2, th);
    c.fillRect(px - th / 2, py - arm, th, arm * 2);
    c.globalAlpha = this.statsT;
  }
  if (p.statsAvailable > 0 && rects.length) {
    // tilted "xN" sits above the + column, like the real client
    var top = rects[0], txt = 'x' + p.statsAvailable;
    c.save();
    c.translate(top.x + top.w + 34, top.y - 20); c.rotate(-0.3);
    c.font = 'bold 22px Ubuntu, Verdana, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 5; c.strokeStyle = '#000'; c.strokeText(txt, 0, 0);
    c.fillStyle = '#FFF'; c.fillText(txt, 0, 0);
    c.restore();
  }
  c.restore();
};

Renderer.prototype.upgradeRects = function () {
  var p = this.game.player;
  if (!p || !p.pendingUpgrades.length) return [];
  var out = [], size = 108, gap = 8;
  for (var i = 0; i < p.pendingUpgrades.length; i++) {
    out.push({ id: p.pendingUpgrades[i], x: 20 + (i % 4) * (size + gap), y: 20 + Math.floor(i / 4) * (size + gap), w: size, h: size, idx: i });
  }
  return out;
};

Renderer.prototype.drawUpgrades = function () {
  var rects = this.upgradeRects(), c = this.ctx;
  if (!rects.length) return;
  c.save();
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i], def = TANK_DEFS[r.id];
    c.fillStyle = CARD_COLORS[r.idx % CARD_COLORS.length];
    c.fillRect(r.x, r.y, r.w, r.h);
    c.lineWidth = 3; c.strokeStyle = '#000'; c.globalAlpha = 0.5; c.strokeRect(r.x, r.y, r.w, r.h); c.globalAlpha = 1;
    this.drawTankIcon(def, r.x + r.w / 2, r.y + r.h / 2 - 6, r.w * 0.30);
    c.font = 'bold 12px Ubuntu, Verdana, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.lineWidth = 3; c.strokeStyle = '#000';
    c.strokeText(def.name, r.x + r.w / 2, r.y + r.h - 8);
    c.fillStyle = '#FFF'; c.fillText(def.name, r.x + r.w / 2, r.y + r.h - 8);
    c.font = 'bold 10px Ubuntu'; c.fillStyle = 'rgba(255,255,255,0.8)';
    c.fillText('[' + (r.idx + 1) + ']', r.x + 12, r.y + 14);
  }
  c.restore();
};

// Small schematic of a tank: body + barrels, used on cards and the class tree.
Renderer.prototype.drawTankIcon = function (def, x, y, r) {
  var c = this.ctx, scale = r / 50;
  c.save(); c.translate(x, y);
  var guards = ADDONS[def.postAddon] && ADDONS[def.postAddon].guards;
  if (guards) for (var gi = 0; gi < guards.length; gi++) {
    polyPath(c, 0, 0, r * guards[gi].ratio, guards[gi].sides, guards[gi].offset || 0);
    c.fillStyle = '#9E9E9E'; c.fill(); c.lineWidth = Math.max(1, 2 * scale); c.strokeStyle = '#727272'; c.stroke();
  }
  for (var i = 0; i < def.barrels.length; i++) {
    var b = def.barrels[i];
    c.save(); c.rotate(b.angle); c.translate(0, b.offset * scale);
    var len = b.size * scale, w = b.width * scale / 2, nw = w * 0.7;
    c.beginPath();
    if (b.isTrapezoid) {
      if (b.trapezoidDirection === 0) { c.moveTo(0, -nw); c.lineTo(len, -w); c.lineTo(len, w); c.lineTo(0, nw); }
      else { c.moveTo(0, -w); c.lineTo(len, -nw); c.lineTo(len, nw); c.lineTo(0, w); }
    } else c.rect(0, -w, len, w * 2);
    c.closePath();
    c.fillStyle = C.barrel; c.fill(); c.lineWidth = Math.max(1, 2.5 * scale); c.strokeStyle = C.barrelS; c.stroke();
    c.restore();
  }
  polyPath(c, 0, 0, def.sides === 1 ? r : r * ROOT2 * 0.8, def.sides, 0);
  c.fillStyle = C.blue; c.fill(); c.lineWidth = Math.max(1, 3 * scale); c.strokeStyle = C.blueS; c.stroke();
  c.restore();
};

// Y overlay: concentric rings, tier 2 inner -> tier 4 outer.
Renderer.prototype.drawClassTree = function () {
  var p = this.game.player, c = this.ctx;
  if (!p) return;
  var cx = this.canvas.width / 2, cy = this.canvas.height / 2;
  var rot = this.game.tick * 0.002;
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(0, 0, this.canvas.width, this.canvas.height);
  var tiers = [[], [], []];
  TANK_DEFS.forEach(function (d) {
    if (!d || d.flags.devOnly || d.levelRequirement === 0) return;
    if (d.levelRequirement === 15) tiers[0].push(d);
    else if (d.levelRequirement === 30) tiers[1].push(d);
    else tiers[2].push(d);
  });
  var base = Math.min(cx, cy);
  var radii = [base * 0.28, base * 0.55, base * 0.85];
  for (var t = 0; t < 3; t++) {
    var ring = tiers[t], R = radii[t];
    for (var i = 0; i < ring.length; i++) {
      var a = rot + (i / ring.length) * Math.PI * 2;
      var x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      var reachable = p.level >= ring[i].levelRequirement;
      c.globalAlpha = reachable ? 1 : 0.28;
      this.drawTankIcon(ring[i], x, y, base * 0.028);
      c.globalAlpha = reachable ? 0.9 : 0.25;
      c.font = 'bold 10px Ubuntu'; c.textAlign = 'center';
      c.fillStyle = '#FFF'; c.fillText(ring[i].name, x, y + base * 0.055);
    }
  }
  c.globalAlpha = 1;
  this.drawTankIcon(p.def, cx, cy, base * 0.05);
  c.restore();
};

Renderer.prototype.drawNotifications = function () {
  var g = this.game, c = this.ctx;
  c.save();
  c.textAlign = 'center';
  for (var i = 0; i < g.notifications.length; i++) {
    var n = g.notifications[i];
    var y = 90 + i * 40;
    c.globalAlpha = Math.min(1, n.ttl / 25);
    var w = Math.max(260, c.measureText(n.text).width + 60);
    c.font = 'bold 18px Ubuntu, Verdana, sans-serif';
    w = c.measureText(n.text).width + 44;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(this.canvas.width / 2 - w / 2, y - 22, w, 34);
    c.fillStyle = '#FFF';
    c.textBaseline = 'middle';
    c.fillText(n.text, this.canvas.width / 2, y - 4);
  }
  c.restore();
};

Renderer.prototype.drawDeathScreen = function () {
  var g = this.game, p = g.player, c = this.ctx;
  if (!p || !p.dead) return;
  var cx = this.canvas.width / 2, cy = this.canvas.height / 2;
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(0, 0, this.canvas.width, this.canvas.height);
  c.textAlign = 'center';
  c.font = 'bold 40px Ubuntu, Verdana, sans-serif';
  c.fillStyle = '#FFF';
  c.fillText('You were killed by:', cx, cy - 150);
  c.font = 'bold 52px Ubuntu, Verdana, sans-serif';
  c.fillText(p.killedBy || 'an unnamed tank', cx, cy - 95);
  if ((p.killedBy || '') === 'an unnamed tank') {
    c.font = 'italic 16px Ubuntu, Verdana, sans-serif'; c.fillStyle = '#CCC';
    c.fillText('They seem to prefer to keep an air of mystery about them', cx, cy - 66);
  }
  var secs = Math.floor((g.tick - p.spawnTick) / TPS);
  var time = Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm ' + (secs % 60) + 's';
  this.drawTankIcon(p.def, cx, cy + 5, 42);
  c.font = 'bold 20px Ubuntu, Verdana, sans-serif'; c.fillStyle = '#FFF';
  c.fillText(p.def.name, cx, cy + 78);
  c.font = '18px Ubuntu, Verdana, sans-serif';
  c.fillText('Score: ' + abbrev(p.score) + '     Level: ' + p.level + '     Kills: ' + p.kills, cx, cy + 108);
  c.fillText('Time alive: ' + time, cx, cy + 134);
  // respawn button
  var bw = 240, bh = 54, bx = cx - bw / 2, by = cy + 160;
  this.respawnBtn = { x: bx, y: by, w: bw, h: bh };
  c.fillStyle = C.blue; c.fillRect(bx, by, bw, bh);
  c.fillStyle = C.blueS; c.fillRect(bx, by + bh - 8, bw, 8);
  c.fillStyle = '#FFF'; c.font = 'bold 24px Ubuntu, Verdana, sans-serif';
  c.textBaseline = 'middle';
  c.fillText('Respawn', cx, by + bh / 2 - 2);
  c.restore();
};

// --- frame --------------------------------------------------------------
Renderer.prototype.render = function (alpha) {
  var g = this.game, c = this.ctx;
  this.alpha = alpha;
  c.setTransform(1, 0, 0, 1, 0, 0);
  this.drawGrid();
  this.drawBorders();
  this.drawLeaderArrow();

  // walls and bases first, then everything else; shooters draw above their bullets
  var ents = g.entities;
  var order = { base: 0, wall: 1, trap: 2, bullet: 3, drone: 4, necro: 4, swarm: 4, minion: 5, skimmer: 5, rocket: 5, shape: 6, tank: 7, boss: 8 };
  var sorted = ents.slice().sort(function (a, b) { return (order[a.type] || 3) - (order[b.type] || 3); });
  for (var i = 0; i < sorted.length; i++) this.drawEntity(sorted[i], alpha);
  for (i = 0; i < sorted.length; i++) if (sorted[i].name) this.drawName(sorted[i], alpha);
  for (i = 0; i < sorted.length; i++) this.drawHealthBar(sorted[i], alpha);

  this.drawScoreboard();
  this.drawMinimap();
  this.drawStatus();
  this.drawStats();
  this.drawUpgrades();
  this.drawNotifications();
  if (this.showClassTree) this.drawClassTree();
  this.drawDeathScreen();
};
