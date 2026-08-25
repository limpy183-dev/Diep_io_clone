// modefx.js — the Mode Lab's visual layer.
//
// Two tables, both keyed by mode:
//
//   MODE_FX[key].world   drawn in world space, after the entities, under the
//                        name plates. Use r.toScreen() and r.scaling().
//   MODE_FX[key].screen  drawn over the whole canvas, under the HUD.
//   MODE_THUMB[key]      the animated tile in the Mode Lab menu.
//
// Only modes that actually need a look have an entry. Score Attack and Blood
// Money are the same arena with different arithmetic; dressing them up would
// be noise. Fog, Nightfall, Singularity and the rest are unrecognisable
// without their effects, so those get real ones.
//
// Everything here reads the sim and writes nothing back. A throwing effect is
// caught by the renderer, so a bad frame can never take the game down.

var MODE_FX = {};
var MODE_THUMB = {};

// --- shared primitives ---------------------------------------------------

function fxTint(c, w, h, color, alpha, op) {
  c.save();
  c.globalAlpha = alpha;
  if (op) c.globalCompositeOperation = op;
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  c.restore();
}

// A soft hole in whatever was just drawn — the light around your own tank.
function fxHole(c, x, y, r, soft) {
  var gr = c.createRadialGradient(x, y, r * (soft === undefined ? 0.25 : soft), x, y, r);
  gr.addColorStop(0, 'rgba(0,0,0,1)');
  gr.addColorStop(0.65, 'rgba(0,0,0,0.55)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  c.save();
  c.globalCompositeOperation = 'destination-out';
  c.fillStyle = gr;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.restore();
}

// Edge darkening. `bite` is how far in it reaches, 0..1.
function fxVignette(c, w, h, bite, color) {
  var cx = w / 2, cy = h / 2, out = Math.hypot(cx, cy);
  var gr = c.createRadialGradient(cx, cy, out * (1 - bite), cx, cy, out);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(1, color || 'rgba(0,0,0,0.85)');
  c.save(); c.fillStyle = gr; c.fillRect(0, 0, w, h); c.restore();
}

function fxRing(c, x, y, r, color, width, alpha) {
  c.save();
  c.globalAlpha = alpha === undefined ? 1 : alpha;
  c.strokeStyle = color; c.lineWidth = width;
  c.beginPath(); c.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); c.stroke();
  c.restore();
}

function fxGlow(c, x, y, r, color, alpha) {
  var gr = c.createRadialGradient(x, y, 0, x, y, Math.max(1, r));
  gr.addColorStop(0, color);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = alpha === undefined ? 1 : alpha;
  c.fillStyle = gr;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.restore();
}

function fxPoly(c, x, y, r, sides, rot) {
  c.beginPath();
  if (sides <= 1) { c.arc(x, y, r, 0, Math.PI * 2); c.closePath(); return; }
  for (var i = 0; i < sides; i++) {
    var a = rot + Math.PI * 2 * (i / sides);
    var px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.closePath();
}

function fxFill(c, fill, stroke, lw) {
  c.fillStyle = fill; c.fill();
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw || 3; c.stroke(); }
}

// A big banner across the middle of the screen for a beat. `age` in seconds.
function fxBanner(c, w, h, text, sub, age, color) {
  if (age > 2.4) return;
  var k = age < 0.25 ? age / 0.25 : age > 2 ? (2.4 - age) / 0.4 : 1;
  c.save();
  c.globalAlpha = Math.max(0, Math.min(1, k));
  c.textAlign = 'center'; c.textBaseline = 'middle';
  var y = h * 0.32;
  c.font = 'bold ' + Math.round(h * 0.075) + 'px Ubuntu, Verdana, sans-serif';
  c.lineWidth = h * 0.014; c.strokeStyle = 'rgba(0,0,0,0.65)';
  c.strokeText(text, w / 2, y);
  c.fillStyle = color || '#FFF';
  c.fillText(text, w / 2, y);
  if (sub) {
    c.font = 'bold ' + Math.round(h * 0.028) + 'px Ubuntu, Verdana, sans-serif';
    c.lineWidth = h * 0.008;
    c.strokeText(sub, w / 2, y + h * 0.062);
    c.fillStyle = '#FFF';
    c.fillText(sub, w / 2, y + h * 0.062);
  }
  c.restore();
}

// The camera's own tank on screen, for anything that lights it.
function fxSelf(r) {
  var g = r.game;
  var p = (g.player && g.player.possessing && !g.player.possessing.dead) ? g.player.possessing : g.player;
  if (g.viewing && g.spectate && !g.spectate.dead) p = g.spectate;
  if (!p || p.dead) return null;
  var sp = r.toScreen(p.x, p.y);
  return { e: p, x: sp.x, y: sp.y };
}

// A low-resolution offscreen buffer stretched back up. That stretch IS the
// blur, which is how a fog bank gets drawn at 25 Hz without a blur filter
// costing the frame.
var _fxBuf = null;
function fxLayer(w, h, scale) {
  var bw = Math.max(2, Math.ceil(w / scale)), bh = Math.max(2, Math.ceil(h / scale));
  if (!_fxBuf) {
    _fxBuf = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    if (!_fxBuf) return null;
  }
  if (_fxBuf.width !== bw || _fxBuf.height !== bh) { _fxBuf.width = bw; _fxBuf.height = bh; }
  var bc = _fxBuf.getContext('2d');
  bc.setTransform(1, 0, 0, 1, 0, 0);
  bc.clearRect(0, 0, bw, bh);
  return { canvas: _fxBuf, c: bc, w: bw, h: bh, k: 1 / scale };
}

// =========================================================================
// Fog of War
// =========================================================================

// Drifting fog banks, drawn into the low-res buffer and stretched back over
// the canvas. Eight cells on two counter-drifting layers reads as weather
// rather than as eight circles.
function drawFogBank(r, c, g, t, density, tintTop, tintBottom) {
  var w = r.canvas.width, h = r.canvas.height;
  var buf = fxLayer(w, h, 10);
  if (!buf) return;
  var seed = (g.fx && g.fx.seed) || 0;
  var bc = buf.c;
  bc.globalCompositeOperation = 'source-over';
  for (var layer = 0; layer < 2; layer++) {
    var dir = layer ? -1 : 1, sp = layer ? 0.021 : 0.033;
    for (var i = 0; i < 7; i++) {
      var ph = seed * 0.37 + i * 2.3 + layer * 11;
      // World-anchored, so the fog sits still while the camera moves through it
      var wx = (Math.sin(ph) * 0.5 + 0.5) * g.arena.size - g.arena.size / 2 + Math.cos(t * sp + ph) * 2600 * dir;
      var wy = (Math.cos(ph * 1.7) * 0.5 + 0.5) * g.arena.size - g.arena.size / 2 + Math.sin(t * sp * 0.8 + ph) * 2600 * dir;
      var s = r.toScreen(wx, wy);
      var rad = (2600 + Math.sin(t * 0.15 + i) * 700) * r.scaling() * buf.k;
      var gr = bc.createRadialGradient(s.x * buf.k, s.y * buf.k, 0, s.x * buf.k, s.y * buf.k, Math.max(2, rad));
      gr.addColorStop(0, layer ? tintTop : tintBottom);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      bc.fillStyle = gr;
      bc.beginPath(); bc.arc(s.x * buf.k, s.y * buf.k, Math.max(2, rad), 0, Math.PI * 2); bc.fill();
    }
  }
  c.save();
  c.globalAlpha = density;
  c.imageSmoothingEnabled = true;
  c.drawImage(buf.canvas, 0, 0, buf.w, buf.h, 0, 0, w, h);
  c.restore();
}

MODE_FX.fog = {
  screen: function (r, c, g, t) {
    var w = r.canvas.width, h = r.canvas.height, me = fxSelf(r);
    // 1. the murk itself, world-anchored so you move through it
    drawFogBank(r, c, g, t, 0.85, 'rgba(196,204,214,0.30)', 'rgba(148,158,172,0.36)');
    // 2. a flat dark layer with your own lantern punched out of it
    c.save();
    c.fillStyle = 'rgba(24,30,40,0.62)';
    c.fillRect(0, 0, w, h);
    if (me) fxHole(c, me.x, me.y, Math.min(w, h) * 0.34, 0.05);
    c.restore();
    // 3. muzzle flashes bloom through it — firing tells everyone roughly where
    //    you are, which is the trade the mode is built on
    for (var i = 0; i < g.entities.length; i++) {
      var e = g.entities[i];
      if (e.type !== 'tank' || e.dead || !e.barrels) continue;
      var lit = 0;
      for (var b = 0; b < e.barrels.length; b++) if (e.barrels[b].recoilAnim > 0.35) lit = Math.max(lit, e.barrels[b].recoilAnim);
      if (!lit) continue;
      var s = r.toScreen(e.x, e.y);
      fxGlow(c, s.x, s.y, 260 * lit, 'rgba(255,228,150,0.5)', 0.75);
    }
    if (me) fxGlow(c, me.x, me.y, Math.min(w, h) * 0.16, 'rgba(180,215,255,0.13)', 1);
    fxVignette(c, w, h, 0.62, 'rgba(10,14,20,0.9)');
  }
};

// =========================================================================
// Nightfall — the same idea, running on a clock, and colder
// =========================================================================

MODE_FX.nightfall = {
  screen: function (r, c, g, t) {
    var w = r.canvas.width, h = r.canvas.height;
    var f = (g.fx && g.fx.night) || 0;
    if (f <= 0.02) return;
    var me = fxSelf(r);
    // sky first: warm dusk sliding to deep blue
    var sky = c.createLinearGradient(0, 0, 0, h);
    var warm = Math.max(0, 1 - f * 2.2);
    sky.addColorStop(0, 'rgba(' + Math.round(30 + warm * 90) + ',' + Math.round(28 + warm * 40) + ',' + Math.round(64 + warm * 20) + ',' + (f * 0.78) + ')');
    sky.addColorStop(1, 'rgba(6,8,20,' + (f * 0.9) + ')');
    c.save(); c.fillStyle = sky; c.fillRect(0, 0, w, h);
    if (me) fxHole(c, me.x, me.y, Math.min(w, h) * (0.42 - f * 0.24), 0.05);
    c.restore();
    drawFogBank(r, c, g, t, f * 0.5, 'rgba(90,110,170,0.26)', 'rgba(40,54,96,0.3)');
    if (me) fxGlow(c, me.x, me.y, Math.min(w, h) * (0.2 - f * 0.09), 'rgba(150,190,255,' + (0.08 + f * 0.14) + ')', 1);
    // a cold moon rising as it gets late
    if (f > 0.3) {
      var mx = w * 0.86, my = h * (0.34 - (f - 0.3) * 0.16);
      fxGlow(c, mx, my, 190, 'rgba(190,215,255,0.30)', f);
      c.save(); c.globalAlpha = f;
      c.beginPath(); c.arc(mx, my, 34, 0, Math.PI * 2);
      c.fillStyle = '#E9F1FF'; c.fill();
      c.restore();
    }
    fxVignette(c, w, h, 0.35 + f * 0.4, 'rgba(2,4,12,' + (0.55 + f * 0.4) + ')');
  }
};

// =========================================================================
// Singularity
// =========================================================================

MODE_FX.singularity = {
  world: function (r, c, g, t) {
    var fx = g.fx;
    if (!fx || !fx.sing) return;
    var k = r.scaling(), o = r.toScreen(0, 0);
    var R = fx.sing * k, reach = fx.reach * k, f = fx.f;

    // reach boundary — where the pull starts to matter
    fxRing(c, o.x, o.y, reach, 'rgba(140,120,255,0.16)', Math.max(1, 3 * k * 40), 1);

    // accretion disc: counter-rotating arcs, hotter toward the horizon
    c.save();
    c.translate(o.x, o.y);
    for (var i = 0; i < 5; i++) {
      var rr = R * (1.35 + i * 0.52);
      var spin = t * (0.5 - i * 0.06) * (i % 2 ? -1 : 1);
      var hot = 1 - i / 5;
      c.save(); c.rotate(spin);
      c.globalCompositeOperation = 'lighter';
      c.strokeStyle = 'rgba(' + Math.round(255) + ',' + Math.round(120 + hot * 110) + ',' + Math.round(40 + (1 - hot) * 180) + ',' + (0.10 + hot * 0.26) + ')';
      c.lineWidth = Math.max(1, R * 0.22 * hot);
      c.beginPath();
      c.arc(0, 0, rr, 0, Math.PI * 1.55);
      c.stroke();
      c.restore();
    }
    c.restore();

    // lensing ring, then the horizon itself
    fxGlow(c, o.x, o.y, R * 2.6, 'rgba(255,170,90,' + (0.10 + f * 0.2) + ')', 1);
    fxRing(c, o.x, o.y, R * 1.06, 'rgba(255,236,190,0.85)', Math.max(1.5, R * 0.045), 1);
    c.save();
    c.fillStyle = '#04030A';
    c.beginPath(); c.arc(o.x, o.y, R, 0, Math.PI * 2); c.fill();
    c.restore();

    // infalling debris — deterministic, so it does not sparkle at random
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (i = 0; i < 60; i++) {
      var ph = i * 0.618, life = (t * (0.16 + (i % 7) * 0.02) + ph) % 1;
      var d = reach * (1 - life * life);
      if (d < R) continue;
      var ang = ph * Math.PI * 2 + t * 0.55 * (1 + (reach / Math.max(1, d)) * 0.12);
      var px = o.x + Math.cos(ang) * d, py = o.y + Math.sin(ang) * d;
      c.globalAlpha = 0.5 * (1 - life);
      c.fillStyle = i % 3 ? '#FFD08A' : '#9FD8FF';
      c.fillRect(px, py, Math.max(1, 2.5 * k * 30), Math.max(1, 2.5 * k * 30));
    }
    c.restore();
  },
  screen: function (r, c, g) {
    var fx = g.fx;
    if (!fx || !fx.f) return;
    fxVignette(c, r.canvas.width, r.canvas.height, 0.25 + fx.f * 0.45, 'rgba(6,2,16,' + (0.3 + fx.f * 0.5) + ')');
  }
};

// =========================================================================
// Juggernaut
// =========================================================================

MODE_FX.juggernaut = {
  world: function (r, c, g, t) {
    var j = g.fx && g.fx.jugg;
    if (!j || j.dead) return;
    var k = r.scaling(), s = r.toScreen(j.x, j.y), rad = j.size * k;
    // a heavy dark aura, breathing
    fxGlow(c, s.x, s.y, rad * 3.4, 'rgba(120,20,40,0.30)', 1);
    for (var i = 0; i < 3; i++) {
      var ph = (t * 0.55 + i / 3) % 1;
      fxRing(c, s.x, s.y, rad * (1.15 + ph * 1.7), 'rgba(255,70,80,' + (0.45 * (1 - ph)) + ')', Math.max(1, rad * 0.09), 1);
    }
    // twelve slow orbiting motes, one per side of the hull
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (i = 0; i < 12; i++) {
      var a = t * 0.4 + Math.PI * 2 * (i / 12);
      var d = rad * (1.55 + Math.sin(t * 1.1 + i) * 0.12);
      c.globalAlpha = 0.55;
      c.fillStyle = '#FF5A62';
      c.beginPath(); c.arc(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, Math.max(1, rad * 0.055), 0, Math.PI * 2); c.fill();
    }
    c.restore();
  },
  screen: function (r, c, g) {
    var j = g.fx && g.fx.jugg;
    var w = r.canvas.width, h = r.canvas.height;
    if (!j || j.dead) return;
    // arena-wide health bar: the whole point is that everyone can see it drop
    var bw = Math.min(760, w * 0.55), x = (w - bw) / 2, y = 62;
    var f = Math.max(0, j.health / j.maxHealth);
    c.save();
    c.globalAlpha = 0.9;
    c.fillStyle = '#2B2B33';
    if (c.roundRect) { c.beginPath(); c.roundRect(x - 4, y - 4, bw + 8, 26, 13); c.fill(); }
    else c.fillRect(x - 4, y - 4, bw + 8, 26);
    c.fillStyle = '#F14E54';
    if (c.roundRect) { c.beginPath(); c.roundRect(x, y, bw * f, 18, 9); c.fill(); }
    else c.fillRect(x, y, bw * f, 18);
    c.globalAlpha = 1;
    c.font = 'bold 15px Ubuntu, Verdana, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 3; c.strokeStyle = '#000';
    c.strokeText(j.name || 'JUGGERNAUT', w / 2, y + 9);
    c.fillStyle = '#FFF';
    c.fillText(j.name || 'JUGGERNAUT', w / 2, y + 9);
    c.restore();
    // and a red edge when it is close enough to be your problem
    var me = fxSelf(r);
    if (me && me.e !== j) {
      var d = Math.hypot(me.e.x - j.x, me.e.y - j.y);
      if (d < 2600) fxVignette(c, w, h, 0.3, 'rgba(160,10,25,' + (0.45 * (1 - d / 2600)) + ')');
    }
  }
};

// =========================================================================
// Sumo — the ring is the mode, so it has to be unmissable
// =========================================================================

MODE_FX.sumo = {
  world: function (r, c, g, t) {
    var ring = g.fx && g.fx.ring;
    if (!ring) return;
    var k = r.scaling(), o = r.toScreen(0, 0), R = ring * k;
    c.save();
    // everything outside the line is death, so paint it as death
    c.beginPath();
    c.rect(0, 0, r.canvas.width, r.canvas.height);
    c.arc(o.x, o.y, R, 0, Math.PI * 2, true);
    c.fillStyle = 'rgba(200,40,50,0.20)';
    c.fill('evenodd');
    c.restore();
    // hazard chevrons marching around the edge
    c.save();
    c.translate(o.x, o.y);
    c.rotate(t * 0.12);
    c.strokeStyle = 'rgba(255,222,67,0.85)';
    c.lineWidth = Math.max(2, R * 0.02);
    c.setLineDash([Math.max(6, R * 0.09), Math.max(6, R * 0.06)]);
    c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    c.restore();
    fxRing(c, o.x, o.y, R * 0.985, 'rgba(255,255,255,0.35)', Math.max(1, R * 0.008), 1);
    fxGlow(c, o.x, o.y, R * 0.5, 'rgba(255,222,67,0.05)', 1);
  }
};

// =========================================================================
// Diep Ball
// =========================================================================

MODE_FX.diepball = {
  world: function (r, c, g, t) {
    var k = r.scaling();
    if (g.goals) for (var i = 0; i < g.goals.length; i++) {
      var gl = g.goals[i], s = r.toScreen(gl.x, gl.y);
      var gr = c.createLinearGradient(s.x - gl.size * k, s.y, s.x + gl.size * k, s.y);
      var col = i === 0 ? '0,178,225' : '241,78,84';
      gr.addColorStop(0, 'rgba(' + col + ',0)');
      gr.addColorStop(0.5, 'rgba(' + col + ',' + (0.28 + 0.1 * Math.sin(t * 2 + i)) + ')');
      gr.addColorStop(1, 'rgba(' + col + ',0)');
      c.save(); c.fillStyle = gr;
      c.fillRect(s.x - gl.size * k, s.y - gl.width * k, gl.size * 2 * k, gl.width * 2 * k);
      c.restore();
    }
    if (g.ball && !g.ball.dead) {
      var b = r.toScreen(g.ball.x, g.ball.y), br = g.ball.size * k;
      fxGlow(c, b.x, b.y, br * 2.4, 'rgba(255,255,255,0.22)', 1);
      // speed streak, so a well-struck ball reads as struck
      var sp = Math.hypot(g.ball.vx, g.ball.vy);
      if (sp > 1.5) {
        var a = Math.atan2(-g.ball.vy, -g.ball.vx);
        c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = Math.min(0.6, sp / 22);
        c.strokeStyle = '#FFF'; c.lineWidth = br * 0.8; c.lineCap = 'round';
        c.beginPath(); c.moveTo(b.x, b.y);
        c.lineTo(b.x + Math.cos(a) * br * (1 + sp * 0.5), b.y + Math.sin(a) * br * (1 + sp * 0.5));
        c.stroke(); c.restore();
      }
      // centre line and halo rings
      for (var n = 0; n < 2; n++) {
        var ph = (t * 0.8 + n / 2) % 1;
        fxRing(c, b.x, b.y, br * (1 + ph * 1.1), 'rgba(255,255,255,' + (0.28 * (1 - ph)) + ')', Math.max(1, br * 0.06), 1);
      }
    }
  },
  screen: function (r, c, g) {
    var fx = g.fx;
    if (!fx || !fx.goal) return;
    var age = (g.tick - fx.goal) / TPS;
    fxBanner(c, r.canvas.width, r.canvas.height, 'GOAL', (fx.side === 'blue' ? 'Blue' : 'Red') + ' scores',
      age, fx.side === 'blue' ? '#00B2E1' : '#F14E54');
  }
};

// =========================================================================
// Red Light, Green Light
// =========================================================================

MODE_FX.redlight = {
  screen: function (r, c, g, t) {
    var fx = g.fx;
    if (!fx) return;
    var w = r.canvas.width, h = r.canvas.height, green = fx.light === 1;
    fxVignette(c, w, h, 0.5, green ? 'rgba(20,120,60,0.35)' : 'rgba(150,10,20,0.55)');
    if (!green) fxTint(c, w, h, '#8A0F18', 0.12 + 0.05 * Math.sin(t * 9));
    // the light itself, top centre, big enough to see out of the corner of an eye
    var cx = w / 2, cy = 96, R = 34;
    c.save();
    c.globalAlpha = 0.92;
    c.fillStyle = '#1D2128';
    if (c.roundRect) { c.beginPath(); c.roundRect(cx - R - 14, cy - R - 14, (R + 14) * 2, (R + 14) * 2, 16); c.fill(); }
    else c.fillRect(cx - R - 14, cy - R - 14, (R + 14) * 2, (R + 14) * 2);
    c.restore();
    var col = green ? '#28E070' : '#FF3B44';
    fxGlow(c, cx, cy, R * (fx.warn ? 3.4 : 2.4), green ? 'rgba(40,224,112,0.5)' : 'rgba(255,59,68,0.55)', 1);
    c.save();
    c.globalAlpha = fx.warn ? 0.55 + 0.45 * Math.abs(Math.sin(t * 12)) : 1;
    c.fillStyle = col;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
    c.restore();
  }
};

// =========================================================================
// Infection / Vampire / Ice Rink / Locust — atmosphere, cheap
// =========================================================================

MODE_FX.infection = {
  screen: function (r, c, g, t) {
    var f = (g.fx && g.fx.infection) || 0;
    if (f <= 0) return;
    var w = r.canvas.width, h = r.canvas.height;
    fxVignette(c, w, h, 0.25 + f * 0.4, 'rgba(120,10,18,' + (0.25 + f * 0.5) + ')');
    // a sickly pulse that quickens as the horde grows
    fxTint(c, w, h, '#6E0F14', f * 0.10 * (0.6 + 0.4 * Math.sin(t * (1.4 + f * 4))));
  }
};

MODE_FX.vampire = {
  screen: function (r, c, g, t) {
    var w = r.canvas.width, h = r.canvas.height, me = fxSelf(r);
    fxVignette(c, w, h, 0.3, 'rgba(80,4,10,0.45)');
    if (!me) return;
    // the vignette closes in as you bleed out, so health is felt not read
    var hurt = 1 - Math.max(0, Math.min(1, me.e.health / me.e.maxHealth));
    if (hurt > 0.25) {
      fxVignette(c, w, h, 0.2 + hurt * 0.45, 'rgba(150,8,16,' + (hurt * 0.6 * (0.75 + 0.25 * Math.sin(t * 5))) + ')');
    }
  }
};

MODE_FX.icerink = {
  screen: function (r, c, g) {
    var w = r.canvas.width, h = r.canvas.height, me = fxSelf(r);
    fxTint(c, w, h, '#BFE6FF', 0.07, 'screen');
    fxVignette(c, w, h, 0.42, 'rgba(180,225,255,0.30)');
    // frost creeps in from the edges when you are actually sliding fast
    if (!me) return;
    var sp = Math.hypot(me.e.vx, me.e.vy);
    if (sp > 3) fxVignette(c, w, h, 0.2 + Math.min(0.35, sp / 40), 'rgba(255,255,255,' + Math.min(0.35, sp / 60) + ')');
  }
};

MODE_FX.locust = {
  screen: function (r, c, g, t) {
    var w = r.canvas.width, h = r.canvas.height;
    fxTint(c, w, h, '#8A6A2E', 0.07);
    fxVignette(c, w, h, 0.45, 'rgba(60,44,14,0.4)');
    // drifting dust motes over the top
    c.save();
    c.globalAlpha = 0.16; c.fillStyle = '#FFE8A0';
    for (var i = 0; i < 44; i++) {
      var x = ((i * 137.5 + t * (18 + i % 9) * 3) % (w + 60)) - 30;
      var y = ((i * 79.7 + t * 9) % (h + 60)) - 30;
      c.fillRect(x, y, 2 + (i % 3), 2 + (i % 3));
    }
    c.restore();
  }
};

// =========================================================================
// Prop Hunt / Hide and Seek
// =========================================================================

MODE_FX.prophunt = {
  world: function (r, c, g, t) {
    var me = fxSelf(r);
    if (!me || !me.e.propKind) return;
    // only YOU see the shimmer on your own disguise, as a reminder it is one
    var k = r.scaling(), rad = me.e.size * k * ROOT2;
    fxRing(c, me.x, me.y, rad * (1.18 + 0.06 * Math.sin(t * 2.2)), 'rgba(0,178,225,0.35)', Math.max(1, rad * 0.05), 1);
  },
  screen: function (r, c, g) {
    var me = fxSelf(r);
    var w = r.canvas.width, h = r.canvas.height;
    if (!me) return;
    if (me.e.isSeeker) {
      fxVignette(c, w, h, 0.35, 'rgba(120,20,24,0.35)');
    } else if (me.e.propKind) {
      fxVignette(c, w, h, 0.3, 'rgba(10,60,90,0.30)');
      c.save();
      c.font = 'bold 14px Ubuntu, Verdana, sans-serif';
      c.textAlign = 'center';
      c.globalAlpha = 0.8;
      c.fillStyle = '#CFEBFF';
      c.fillText('you are a ' + me.e.propKind + ' — right-click to re-roll', w / 2, h - 92);
      c.restore();
    }
  }
};

MODE_FX.hideseek = {
  screen: function (r, c, g, t) {
    var me = fxSelf(r), w = r.canvas.width, h = r.canvas.height;
    fxVignette(c, w, h, 0.45, 'rgba(24,10,44,0.5)');
    if (!me) return;
    if (me.e.isSeeker) {
      // a slow radar sweep for the seekers, purely atmospheric
      var sw = (t * 0.5) % 1;
      fxRing(c, w / 2, h / 2, sw * Math.hypot(w, h) * 0.55, 'rgba(190,140,255,' + (0.22 * (1 - sw)) + ')', 3, 1);
    } else {
      var vis = me.e.opacity;
      fxVignette(c, w, h, 0.3, 'rgba(60,20,110,' + (0.2 + vis * 0.35) + ')');
    }
  }
};

// =========================================================================
// King of the Hill / Payload / Nest Wars / Alpha Hunt / Bounty King
// =========================================================================

MODE_FX.koth = {
  world: function (r, c, g, t) {
    var fx = g.fx;
    if (!fx || !fx.hill) return;
    var k = r.scaling(), hl = fx.hill, s = r.toScreen(hl.x, hl.y);
    var w = hl.size * k, h = hl.width * k;
    var col = fx.contested ? '255,255,255' : fx.owner === 'blue' ? '0,178,225' : fx.owner === 'red' ? '241,78,84' : '255,222,67';
    c.save();
    var gr = c.createRadialGradient(s.x, s.y, 0, s.x, s.y, Math.max(w, h));
    gr.addColorStop(0, 'rgba(' + col + ',0.22)');
    gr.addColorStop(1, 'rgba(' + col + ',0)');
    c.fillStyle = gr;
    c.fillRect(s.x - w, s.y - h, w * 2, h * 2);
    c.restore();
    // a beacon column and expanding rings, so it is findable from range
    for (var i = 0; i < 3; i++) {
      var ph = (t * (fx.contested ? 1.6 : 0.6) + i / 3) % 1;
      fxRing(c, s.x, s.y, w * (0.5 + ph * 1.3), 'rgba(' + col + ',' + (0.5 * (1 - ph)) + ')', Math.max(1, w * 0.03), 1);
    }
    fxGlow(c, s.x, s.y, w * 0.9, 'rgba(' + col + ',0.10)', 1);
  }
};

MODE_FX.payload = {
  world: function (r, c, g, t) {
    var fx = g.fx;
    if (!fx || !fx.payload || fx.payload.dead) return;
    var k = r.scaling(), p = fx.payload, s = r.toScreen(p.x, p.y);
    // the track it runs on, drawn end to end
    var l = r.toScreen(g.payGoal.red, 0), rr = r.toScreen(g.payGoal.blue, 0);
    c.save();
    c.strokeStyle = 'rgba(0,0,0,0.14)';
    c.lineWidth = Math.max(2, 90 * k);
    c.setLineDash([Math.max(6, 220 * k), Math.max(6, 160 * k)]);
    c.lineDashOffset = -t * 40 * k * (fx.hold === 'blue' ? 1 : fx.hold === 'red' ? -1 : 0);
    c.beginPath(); c.moveTo(l.x, l.y); c.lineTo(rr.x, rr.y); c.stroke();
    c.setLineDash([]);
    c.restore();
    var col = fx.hold === 'blue' ? '0,178,225' : fx.hold === 'red' ? '241,78,84' : '200,200,200';
    fxGlow(c, s.x, s.y, p.size * k * 2.6, 'rgba(' + col + ',0.24)', 1);
    // escort ring: how many of yours are close enough to be pushing
    fxRing(c, s.x, s.y, 900 * k, 'rgba(' + col + ',0.30)', Math.max(1, 8 * k), 1);
    if (fx.hold) {
      var dir = fx.hold === 'blue' ? 1 : -1;
      c.save(); c.globalCompositeOperation = 'lighter';
      for (var i = 0; i < 3; i++) {
        var ph = (t * 1.2 + i / 3) % 1;
        c.globalAlpha = 0.5 * (1 - ph);
        c.fillStyle = fx.hold === 'blue' ? '#00B2E1' : '#F14E54';
        var ax = s.x + dir * (p.size * k * 1.4 + ph * 220 * k);
        c.beginPath();
        c.moveTo(ax + dir * 34 * k * 3, s.y);
        c.lineTo(ax, s.y - 26 * k * 3);
        c.lineTo(ax, s.y + 26 * k * 3);
        c.closePath(); c.fill();
      }
      c.restore();
    } else {
      c.save();
      c.font = 'bold ' + Math.max(11, 90 * k) + 'px Ubuntu, Verdana, sans-serif';
      c.textAlign = 'center';
      c.globalAlpha = 0.55 + 0.35 * Math.sin(t * 4);
      c.fillStyle = '#FFF';
      c.fillText('CONTESTED', s.x, s.y - p.size * k * 1.9);
      c.restore();
    }
  }
};

MODE_FX.nestwars = {
  world: function (r, c, g, t) {
    var R = (g.fx && g.fx.nest) || 0;
    if (!R) return;
    var k = r.scaling(), o = r.toScreen(0, 0);
    c.save();
    var gr = c.createRadialGradient(o.x, o.y, R * k * 0.2, o.x, o.y, R * k);
    gr.addColorStop(0, 'rgba(118,141,252,0.16)');
    gr.addColorStop(1, 'rgba(118,141,252,0)');
    c.fillStyle = gr;
    c.beginPath(); c.arc(o.x, o.y, R * k, 0, Math.PI * 2); c.fill();
    c.restore();
    fxRing(c, o.x, o.y, R * k, 'rgba(118,141,252,' + (0.5 + 0.2 * Math.sin(t * 1.5)) + ')', Math.max(2, 26 * k), 1);
  }
};

MODE_FX.alphahunt = {
  world: function (r, c, g, t) {
    var a = g.fx && g.fx.alpha;
    if (!a || a.dead) return;
    var k = r.scaling(), s = r.toScreen(a.x, a.y), rad = a.size * k * ROOT2;
    fxGlow(c, s.x, s.y, rad * 2.6, 'rgba(118,141,252,0.30)', 1);
    for (var i = 0; i < 3; i++) {
      var ph = (t * 0.7 + i / 3) % 1;
      fxRing(c, s.x, s.y, rad * (1 + ph * 1.6), 'rgba(160,180,255,' + (0.55 * (1 - ph)) + ')', Math.max(1, rad * 0.06), 1);
    }
    // an off-screen pointer, because the whole mode is "go there now"
    var w = r.canvas.width, h = r.canvas.height;
    if (s.x < 0 || s.y < 0 || s.x > w || s.y > h) {
      var ang = Math.atan2(s.y - h / 2, s.x - w / 2);
      var px = w / 2 + Math.cos(ang) * Math.min(w, h) * 0.42;
      var py = h / 2 + Math.sin(ang) * Math.min(w, h) * 0.42;
      c.save();
      c.translate(px, py); c.rotate(ang);
      c.fillStyle = '#768DFC';
      c.beginPath(); c.moveTo(20, 0); c.lineTo(-14, -13); c.lineTo(-14, 13); c.closePath(); c.fill();
      c.restore();
    }
  }
};

MODE_FX.bountyking = {
  world: function (r, c, g, t) {
    var kg = g.fx && g.fx.king;
    if (!kg || kg.dead) return;
    var k = r.scaling(), s = r.toScreen(kg.x, kg.y), rad = kg.size * k * ROOT2;
    fxGlow(c, s.x, s.y, rad * 3, 'rgba(255,214,60,0.28)', 1);
    fxRing(c, s.x, s.y, rad * (1.3 + 0.06 * Math.sin(t * 2)), 'rgba(255,222,67,0.7)', Math.max(1, rad * 0.08), 1);
    // an actual crown, drawn above the plate
    var cw = rad * 0.9, cy = s.y - rad * 1.75;
    c.save();
    c.fillStyle = '#FFDE43'; c.strokeStyle = '#BFA732'; c.lineWidth = Math.max(1, rad * 0.05);
    c.beginPath();
    c.moveTo(s.x - cw, cy + cw * 0.55);
    c.lineTo(s.x - cw, cy - cw * 0.35);
    c.lineTo(s.x - cw * 0.45, cy + cw * 0.12);
    c.lineTo(s.x, cy - cw * 0.62);
    c.lineTo(s.x + cw * 0.45, cy + cw * 0.12);
    c.lineTo(s.x + cw, cy - cw * 0.35);
    c.lineTo(s.x + cw, cy + cw * 0.55);
    c.closePath();
    c.fill(); c.stroke();
    c.restore();
  }
};

// =========================================================================
// The arena modes
// =========================================================================

MODE_FX.musicaltiles = {
  world: function (r, c, g, t) {
    if (!g.mtiles) return;
    var k = r.scaling();
    for (var i = 0; i < g.mtiles.length; i++) {
      var tl = g.mtiles[i], s = r.toScreen(tl.x, tl.y);
      var w = tl.size * k, h = tl.width * k;
      if (s.x + w < 0 || s.x - w > r.canvas.width || s.y + h < 0 || s.y - h > r.canvas.height) continue;
      if (!tl.alive) {
        // a hole, not a tile: paint the void under the floor
        c.save();
        var gr = c.createLinearGradient(s.x, s.y - h, s.x, s.y + h);
        gr.addColorStop(0, 'rgba(10,10,16,0.92)');
        gr.addColorStop(1, 'rgba(30,30,42,0.92)');
        c.fillStyle = gr;
        c.fillRect(s.x - w, s.y - h, w * 2, h * 2);
        c.restore();
        continue;
      }
      if (!tl.warnAt) continue;
      var left = Math.max(0, (tl.warnAt - g.tick) / TPS);
      var beat = 0.35 + 0.65 * Math.abs(Math.sin(t * (6 + (3 - left) * 4)));
      c.save();
      c.globalAlpha = 0.5 * beat;
      c.fillStyle = '#F14E54';
      c.fillRect(s.x - w, s.y - h, w * 2, h * 2);
      c.globalAlpha = beat;
      c.strokeStyle = '#FFDE43';
      c.lineWidth = Math.max(2, 14 * k);
      c.strokeRect(s.x - w, s.y - h, w * 2, h * 2);
      c.restore();
    }
  }
};

MODE_FX.portals = {
  world: function (r, c, g, t) {
    if (!g.portals) return;
    var k = r.scaling();
    for (var i = 0; i < g.portals.length; i++) {
      var p = g.portals[i], s = r.toScreen(p.x, p.y), rad = p.size * k;
      var warm = i < 2, col = warm ? '191,127,245' : '0,225,110';
      var fresh = Math.max(0, 1 - (g.tick - p.lastUse) / (TPS * 1.2));
      fxGlow(c, s.x, s.y, rad * (2.2 + fresh * 1.4), 'rgba(' + col + ',' + (0.22 + fresh * 0.3) + ')', 1);
      // a spiral: three arms winding in, spinning opposite ways per pair
      c.save();
      c.translate(s.x, s.y);
      c.rotate(t * (warm ? 1.1 : -1.1));
      c.globalCompositeOperation = 'lighter';
      for (var arm = 0; arm < 3; arm++) {
        c.beginPath();
        for (var st = 0; st <= 22; st++) {
          var f = st / 22;
          var a = arm * Math.PI * 2 / 3 + f * Math.PI * 2.1;
          var rr = rad * (1.05 - f * 0.95);
          var px = Math.cos(a) * rr, py = Math.sin(a) * rr;
          if (st) c.lineTo(px, py); else c.moveTo(px, py);
        }
        c.strokeStyle = 'rgba(' + col + ',' + (0.55 + fresh * 0.4) + ')';
        c.lineWidth = Math.max(1, rad * 0.09);
        c.stroke();
      }
      c.restore();
      fxRing(c, s.x, s.y, rad, 'rgba(' + col + ',0.8)', Math.max(1, rad * 0.08), 1);
    }
  }
};

MODE_FX.labyrinth = {
  screen: function (r, c, g) {
    var w = r.canvas.width, h = r.canvas.height;
    fxVignette(c, w, h, 0.5, 'rgba(12,10,20,0.5)');
  }
};

MODE_FX.gauntlet = {
  screen: function (r, c, g, t) {
    var w = r.canvas.width, h = r.canvas.height;
    var fx = g.fx;
    if (!g.gauntletWave) return;
    var pulse = 0.5 + 0.5 * Math.sin(t * 3);
    fxVignette(c, w, h, 0.4, 'rgba(180,20,30,' + (0.22 + pulse * 0.2) + ')');
    if (fx && fx.closers) fxBanner(c, w, h, 'CLOSERS INBOUND', 'they do not stop', (g.tick - fx.closers) / TPS, '#FF5A62');
  }
};

MODE_FX.siege = {
  screen: function (r, c, g) {
    var f = g.fx && g.fx.siege;
    if (f === undefined || f === null) return;
    var w = r.canvas.width, h = r.canvas.height;
    var bw = Math.min(700, w * 0.5), x = (w - bw) / 2, y = 62;
    c.save();
    c.globalAlpha = 0.9;
    c.fillStyle = '#2B2B33';
    if (c.roundRect) { c.beginPath(); c.roundRect(x - 4, y - 4, bw + 8, 24, 12); c.fill(); }
    else c.fillRect(x - 4, y - 4, bw + 8, 24);
    c.fillStyle = f < 0.3 ? '#F14E54' : '#FFDE43';
    if (c.roundRect) { c.beginPath(); c.roundRect(x, y, bw * Math.max(0, f), 16, 8); c.fill(); }
    else c.fillRect(x, y, bw * Math.max(0, f), 16);
    c.globalAlpha = 1;
    c.font = 'bold 13px Ubuntu, Verdana, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 3; c.strokeStyle = '#000';
    c.strokeText('CORE', w / 2, y + 8); c.fillStyle = '#FFF'; c.fillText('CORE', w / 2, y + 8);
    c.restore();
    if (f < 0.25) fxVignette(c, w, h, 0.35, 'rgba(180,30,40,' + (0.3 * (1 - f / 0.25)) + ')');
  }
};

MODE_FX.grandprix = {
  world: function (r, c, g, t) {
    if (!g.gates) return;
    var k = r.scaling(), me = fxSelf(r);
    // the racing line, so the route is never in doubt
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = Math.max(2, 60 * k);
    c.setLineDash([Math.max(6, 200 * k), Math.max(6, 200 * k)]);
    c.lineDashOffset = -t * 120 * k;
    c.beginPath();
    for (var i = 0; i <= g.gates.length; i++) {
      var gt = g.gates[i % g.gates.length], s = r.toScreen(gt.x, gt.y);
      if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y);
    }
    c.stroke();
    c.setLineDash([]);
    c.restore();
    for (i = 0; i < g.gates.length; i++) {
      var gate = g.gates[i], p = r.toScreen(gate.x, gate.y), rad = gate.size * k;
      var mine = me && (me.e.raceGate || 0) === i;
      fxRing(c, p.x, p.y, rad * (mine ? 1 + 0.07 * Math.sin(t * 4) : 1), mine ? 'rgba(255,222,67,0.95)' : 'rgba(143,227,255,0.5)',
        Math.max(1, rad * (mine ? 0.16 : 0.09)), 1);
      if (mine) fxGlow(c, p.x, p.y, rad * 2, 'rgba(255,222,67,0.25)', 1);
      c.save();
      c.font = 'bold ' + Math.max(10, rad * 0.5) + 'px Ubuntu, Verdana, sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.globalAlpha = 0.75;
      c.fillStyle = i === 0 ? '#FFDE43' : '#FFF';
      c.fillText(i === 0 ? 'START' : String(i), p.x, p.y);
      c.restore();
    }
  }
};

MODE_FX.duel = {
  world: function (r, c, g, t) {
    if (!g.duelPits) return;
    var k = r.scaling();
    for (var i = 0; i < g.duelPits.length; i++) {
      var pit = g.duelPits[i];
      if (pit.done) continue;
      var s = r.toScreen(pit.cx, pit.cy), rad = pit.r * k;
      c.save();
      var gr = c.createRadialGradient(s.x, s.y, rad * 0.2, s.x, s.y, rad);
      gr.addColorStop(0, 'rgba(255,222,67,0.05)');
      gr.addColorStop(1, 'rgba(255,222,67,0.14)');
      c.fillStyle = gr;
      c.fillRect(s.x - rad, s.y - rad, rad * 2, rad * 2);
      c.restore();
      fxRing(c, s.x, s.y, rad * (0.98 + 0.01 * Math.sin(t * 2 + i)), 'rgba(255,222,67,0.25)', Math.max(1, 10 * k), 1);
    }
  }
};

MODE_FX.bombtag = {
  world: function (r, c, g, t) {
    var fx = g.fx;
    if (!fx) return;
    if (fx.blast) {
      var age = (g.tick - fx.blast) / TPS;
      if (age < 1) {
        var b = r.toScreen(fx.bx, fx.by), k2 = r.scaling();
        fxGlow(c, b.x, b.y, 700 * k2 * (0.3 + age * 1.4), 'rgba(255,140,40,' + (0.8 * (1 - age)) + ')', 1);
        fxRing(c, b.x, b.y, 700 * k2 * age, 'rgba(255,220,120,' + (1 - age) + ')', Math.max(2, 30 * k2), 1);
      }
    }
    var bomb = fx.bomb;
    if (!bomb || bomb.dead) return;
    var k = r.scaling(), s = r.toScreen(bomb.x, bomb.y), rad = bomb.size * k * ROOT2;
    var left = Math.max(0, (fx.fuse || 0) / TPS);
    var urgency = left < 5 ? 1 - left / 5 : 0;
    var beat = Math.abs(Math.sin(t * (2.4 + urgency * 9)));
    fxGlow(c, s.x, s.y, rad * (2.2 + beat * 1.4 + urgency), 'rgba(255,' + Math.round(90 - urgency * 60) + ',40,' + (0.32 + urgency * 0.4) + ')', 1);
    fxRing(c, s.x, s.y, rad * (1.25 + beat * 0.5), 'rgba(255,70,40,' + (0.55 + urgency * 0.45) + ')', Math.max(1.5, rad * 0.1), 1);
    c.save();
    c.font = 'bold ' + Math.max(13, rad * 0.65) + 'px Ubuntu, Verdana, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = Math.max(2, rad * 0.14); c.strokeStyle = '#000';
    var txt = Math.ceil(left) + '';
    c.strokeText(txt, s.x, s.y - rad * 2.1);
    c.fillStyle = urgency > 0.5 ? '#FF4A3D' : '#FFDE43';
    c.fillText(txt, s.x, s.y - rad * 2.1);
    c.restore();
  }
};

MODE_FX.bossrush = {
  screen: function (r, c, g) {
    var fx = g.fx;
    if (!fx || !fx.waveFlash) return;
    fxBanner(c, r.canvas.width, r.canvas.height, 'WAVE ' + g.wave, g.waveLive.length + ' hostiles',
      (g.tick - fx.waveFlash) / TPS, '#FF8A3D');
  }
};

MODE_FX.randomizer = {
  screen: function (r, c, g) {
    var fx = g.fx;
    if (!fx || !fx.flash) return;
    var age = (g.tick - fx.flash) / TPS;
    if (age > 0.6) return;
    fxTint(c, r.canvas.width, r.canvas.height, '#FFFFFF', (1 - age / 0.6) * 0.5);
    fxBanner(c, r.canvas.width, r.canvas.height, 'REROLL', 'everyone got something new', age, '#BF7FF5');
  }
};

MODE_FX.gungame = {
  screen: function (r, c, g) {
    var me = fxSelf(r);
    if (!me || me.e.gunRung === undefined || typeof GUN_CHAIN === 'undefined') return;
    // a ladder of pips down the right edge: yours filled, the rest hollow
    var w = r.canvas.width, h = r.canvas.height;
    var n = GUN_CHAIN.length, gap = Math.min(16, (h * 0.5) / n);
    var x = w - 34, y0 = h * 0.5 - (n * gap) / 2;
    c.save();
    for (var i = 0; i < n; i++) {
      var on = i <= me.e.gunRung;
      c.globalAlpha = on ? 0.95 : 0.28;
      c.fillStyle = i === me.e.gunRung ? '#FFDE43' : on ? '#00E16E' : '#FFF';
      c.beginPath(); c.arc(x, y0 + i * gap, i === me.e.gunRung ? 5.5 : 3.4, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 0.9;
    c.font = 'bold 12px Ubuntu, Verdana, sans-serif';
    c.textAlign = 'center'; c.fillStyle = '#FFF';
    c.fillText((me.e.gunRung + 1) + '/' + n, x, y0 - 12);
    c.restore();
  }
};

MODE_FX.chaos = {
  screen: function (r, c, g, t) {
    var fx = g.fx;
    if (!fx) return;
    var w = r.canvas.width, h = r.canvas.height;
    if (fx.disco) {
      // a slow colour wash, additive, so the arena reads as lit not repainted
      var hue = (t * 40) % 360;
      c.save();
      c.globalCompositeOperation = 'overlay';
      c.globalAlpha = 0.22;
      c.fillStyle = 'hsl(' + hue + ',95%,55%)';
      c.fillRect(0, 0, w, h);
      c.restore();
      fxVignette(c, w, h, 0.5, 'hsla(' + ((hue + 180) % 360) + ',90%,30%,0.35)');
    }
    if (fx.flashAt) fxBanner(c, w, h, fx.chaos || '', 'chaos rotation', (g.tick - fx.flashAt) / TPS, '#FFDE43');
    if (fx.chaos) {
      c.save();
      c.font = 'bold 15px Ubuntu, Verdana, sans-serif';
      c.textAlign = 'right'; c.globalAlpha = 0.7;
      c.fillStyle = '#FFDE43';
      c.fillText(fx.chaos, w - 22, 92);
      c.restore();
    }
  }
};

MODE_FX.instagib = {
  screen: function (r, c, g) {
    fxVignette(c, r.canvas.width, r.canvas.height, 0.35, 'rgba(90,0,10,0.35)');
  }
};

MODE_FX.mirror = {
  screen: function (r, c, g) {
    if (g.mirrorId === undefined || typeof TANK_DEFS === 'undefined' || !TANK_DEFS[g.mirrorId]) return;
    var w = r.canvas.width;
    c.save();
    c.font = 'bold 15px Ubuntu, Verdana, sans-serif';
    c.textAlign = 'right'; c.globalAlpha = 0.65; c.fillStyle = '#FFF';
    c.fillText('everyone is a ' + TANK_DEFS[g.mirrorId].name, w - 22, 92);
    c.restore();
  }
};

// =========================================================================
// Thumbnails — one animated tile per mode for the Mode Lab
// =========================================================================

// The tiles share a vocabulary so the wall reads as one set: the diep grid,
// flat polygons with heavy strokes, and the game's own palette.

function tBG(c, w, h, fill) {
  c.save();
  c.fillStyle = fill || '#C7C7C7';
  c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(0,0,0,0.055)';
  c.lineWidth = 1;
  for (var x = 0; x <= w; x += 14) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); c.stroke(); }
  for (var y = 0; y <= h; y += 14) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); c.stroke(); }
  c.restore();
}

function tShape(c, x, y, r, sides, rot, fill, stroke) {
  fxPoly(c, x, y, r, sides, rot);
  c.fillStyle = fill; c.fill();
  c.strokeStyle = stroke; c.lineWidth = Math.max(1.5, r * 0.18); c.stroke();
}

// A tank: barrel first so the body sits on top, exactly as the game draws it.
function tTank(c, x, y, r, ang, fill, stroke, guns) {
  c.save();
  c.translate(x, y); c.rotate(ang);
  var bl = r * 1.65, bw = r * 0.62;
  guns = guns === undefined ? 1 : guns;
  for (var i = 0; i < guns; i++) {
    c.save();
    if (guns > 1) c.rotate((i - (guns - 1) / 2) * 0.42);
    c.fillStyle = '#999'; c.strokeStyle = '#727272'; c.lineWidth = Math.max(1, r * 0.14);
    c.beginPath(); c.rect(0, -bw / 2, bl, bw); c.closePath();
    c.fill(); c.stroke();
    c.restore();
  }
  c.restore();
  tShape(c, x, y, r, 1, 0, fill, stroke);
}

function tText(c, x, y, text, size, color, align) {
  c.save();
  c.font = 'bold ' + size + 'px Ubuntu, Verdana, sans-serif';
  c.textAlign = align || 'center'; c.textBaseline = 'middle';
  c.lineWidth = size * 0.2; c.strokeStyle = 'rgba(0,0,0,0.55)';
  c.strokeText(text, x, y);
  c.fillStyle = color || '#FFF';
  c.fillText(text, x, y);
  c.restore();
}

// deterministic pseudo-random, so a tile does not shimmer between frames
function tRand(i) { var s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); }

var SQ = ['#FFE869', '#BFAE4E'], TR = ['#FC7677', '#BD5859'], PE = ['#768DFC', '#5869BD'];
var BLUE = ['#00B2E1', '#0085A8'], RED = ['#F14E54', '#B43A3F'], GRN = ['#00E16E', '#00A852'], PUR = ['#BF7FF5', '#8F5FB7'];

MODE_THUMB.chaos = function (c, w, h, t) {
  tBG(c, w, h);
  var hue = (t * 70) % 360;
  c.save(); c.globalAlpha = 0.4; c.fillStyle = 'hsl(' + hue + ',90%,60%)'; c.fillRect(0, 0, w, h); c.restore();
  for (var i = 0; i < 9; i++) {
    var a = t * (0.6 + i * 0.13) + i;
    var x = w / 2 + Math.cos(a) * (w * 0.18 + i * 5), y = h / 2 + Math.sin(a * 1.3) * (h * 0.24);
    tShape(c, x, y, 9 + (i % 3) * 3, 3 + (i % 4), a, 'hsl(' + ((hue + i * 40) % 360) + ',90%,62%)', 'rgba(0,0,0,0.35)');
  }
  tText(c, w / 2, h - 16, 'ANYTHING GOES', 12, '#FFF');
};

MODE_THUMB.fog = function (c, w, h, t) {
  tBG(c, w, h, '#A8AEB6');
  tTank(c, w / 2, h / 2, 13, Math.sin(t * 0.6) * 0.5, BLUE[0], BLUE[1]);
  c.save();
  c.fillStyle = 'rgba(30,36,46,0.72)'; c.fillRect(0, 0, w, h);
  fxHole(c, w / 2, h / 2, w * 0.3, 0.08);
  c.restore();
  for (var i = 0; i < 6; i++) {
    var x = ((i * 61 + t * (9 + i * 3)) % (w + 90)) - 45;
    var y = h * (0.2 + tRand(i) * 0.65);
    fxGlow(c, x, y, 40 + i * 7, 'rgba(200,208,220,0.13)', 1);
  }
  fxVignette(c, w, h, 0.6, 'rgba(12,16,24,0.85)');
};

MODE_THUMB.nightfall = function (c, w, h, t) {
  var f = (Math.sin(t * 0.5) * 0.5 + 0.5);
  tBG(c, w, h, '#B8BCC4');
  tTank(c, w * 0.42, h * 0.6, 12, 0.3, BLUE[0], BLUE[1]);
  var sky = c.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, 'rgba(' + Math.round(30 + (1 - f) * 90) + ',30,70,' + (0.35 + f * 0.5) + ')');
  sky.addColorStop(1, 'rgba(6,8,22,' + (0.45 + f * 0.5) + ')');
  c.save(); c.fillStyle = sky; c.fillRect(0, 0, w, h);
  fxHole(c, w * 0.42, h * 0.6, w * (0.3 - f * 0.14), 0.06);
  c.restore();
  fxGlow(c, w * 0.8, h * 0.26, 34, 'rgba(190,215,255,0.4)', f);
  c.save(); c.globalAlpha = f; c.fillStyle = '#E9F1FF';
  c.beginPath(); c.arc(w * 0.8, h * 0.26, 9, 0, Math.PI * 2); c.fill(); c.restore();
  fxVignette(c, w, h, 0.45 + f * 0.3, 'rgba(2,4,14,0.85)');
};

MODE_THUMB.scoreattack = function (c, w, h, t) {
  tBG(c, w, h);
  var left = 300 - Math.floor(t * 10) % 300;
  tText(c, w / 2, h * 0.44, Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2), 46, '#FFF');
  c.save(); c.globalAlpha = 0.85;
  for (var i = 0; i < 3; i++) {
    var bw = w * (0.62 - i * 0.13);
    c.fillStyle = [BLUE[0], RED[0], GRN[0]][i];
    if (c.roundRect) { c.beginPath(); c.roundRect((w - bw) / 2, h * 0.66 + i * 13, bw, 9, 5); c.fill(); }
    else c.fillRect((w - bw) / 2, h * 0.66 + i * 13, bw, 9);
  }
  c.restore();
};

MODE_THUMB.instagib = function (c, w, h, t) {
  tBG(c, w, h, '#B9A0A2');
  var ph = (t * 1.4) % 1;
  tTank(c, w * 0.2, h / 2, 12, 0, BLUE[0], BLUE[1]);
  var bx = w * 0.2 + ph * w * 0.6;
  c.save(); c.fillStyle = '#00B2E1'; c.strokeStyle = '#0085A8'; c.lineWidth = 2;
  c.beginPath(); c.arc(bx, h / 2, 6, 0, Math.PI * 2); c.fill(); c.stroke(); c.restore();
  var hit = ph > 0.86;
  if (hit) fxGlow(c, w * 0.82, h / 2, 46, 'rgba(255,90,60,0.85)', 1);
  else tTank(c, w * 0.82, h / 2, 12, Math.PI, RED[0], RED[1]);
  tText(c, w / 2, h - 16, 'ONE SHOT', 12, '#FFD5D5');
};

MODE_THUMB.vampire = function (c, w, h, t) {
  tBG(c, w, h, '#9E7377');
  tTank(c, w * 0.36, h / 2, 14, 0.2, '#8E1E28', '#5E1219');
  tTank(c, w * 0.7, h / 2, 11, Math.PI, RED[0], RED[1]);
  c.save(); c.globalCompositeOperation = 'lighter';
  for (var i = 0; i < 7; i++) {
    var ph = (t * 1.1 + i / 7) % 1;
    var x = w * 0.7 - (w * 0.34) * ph, y = h / 2 + Math.sin(ph * 6 + i) * 12;
    c.globalAlpha = 0.8 * (1 - ph);
    c.fillStyle = '#FF3B46';
    c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2); c.fill();
  }
  c.restore();
  fxVignette(c, w, h, 0.45, 'rgba(80,4,10,0.6)');
};

MODE_THUMB.icerink = function (c, w, h, t) {
  tBG(c, w, h, '#D3E8F5');
  c.save(); c.globalAlpha = 0.5; c.strokeStyle = '#FFF'; c.lineWidth = 3; c.lineCap = 'round';
  for (var i = 0; i < 4; i++) {
    var y = h * (0.22 + i * 0.19), off = ((t * 40 + i * 50) % (w + 80)) - 40;
    c.beginPath(); c.moveTo(off - 40, y); c.lineTo(off, y); c.stroke();
  }
  c.restore();
  var x = w * 0.5 + Math.sin(t * 0.8) * w * 0.26;
  tTank(c, x, h * 0.55, 13, Math.sin(t * 0.8) > 0 ? 0 : Math.PI, BLUE[0], BLUE[1]);
  fxVignette(c, w, h, 0.4, 'rgba(200,235,255,0.5)');
};

MODE_THUMB.bloodmoney = function (c, w, h, t) {
  tBG(c, w, h);
  c.save(); c.globalAlpha = 0.35;
  tShape(c, w * 0.24, h * 0.34, 15, 4, t * 0.3, SQ[0], SQ[1]);
  tShape(c, w * 0.78, h * 0.72, 13, 5, -t * 0.25, PE[0], PE[1]);
  c.restore();
  c.save(); c.strokeStyle = '#B43A3F'; c.lineWidth = 4; c.lineCap = 'round';
  [[w * 0.24, h * 0.34, 20], [w * 0.78, h * 0.72, 18]].forEach(function (p) {
    c.beginPath(); c.moveTo(p[0] - p[2], p[1] - p[2]); c.lineTo(p[0] + p[2], p[1] + p[2]); c.stroke();
    c.beginPath(); c.moveTo(p[0] + p[2], p[1] - p[2]); c.lineTo(p[0] - p[2], p[1] + p[2]); c.stroke();
  });
  c.restore();
  tTank(c, w * 0.42, h * 0.58, 13, 0.1, BLUE[0], BLUE[1]);
  tTank(c, w * 0.62, h * 0.44, 13, Math.PI + 0.1, RED[0], RED[1]);
  tText(c, w / 2, h - 15, 'KILLS ONLY', 12, '#FFD5D5');
};

MODE_THUMB.locust = function (c, w, h, t) {
  tBG(c, w, h, '#C4B183');
  for (var i = 0; i < 48; i++) {
    var a = t * (0.4 + tRand(i) * 0.9) + i;
    var x = (tRand(i) * w + Math.cos(a) * 20 + t * 14 * (1 + tRand(i + 9))) % (w + 30) - 15;
    var y = (tRand(i + 5) * h + Math.sin(a) * 16) % (h + 20) - 10;
    var k = i % 3;
    tShape(c, x, y, 5 + (i % 3) * 2, k === 0 ? 3 : k === 1 ? 4 : 5, a,
      k === 0 ? TR[0] : k === 1 ? SQ[0] : PE[0], k === 0 ? TR[1] : k === 1 ? SQ[1] : PE[1]);
  }
  tTank(c, w / 2, h / 2, 13, t * 0.5, BLUE[0], BLUE[1]);
  fxVignette(c, w, h, 0.45, 'rgba(60,44,14,0.45)');
};

MODE_THUMB.gungame = function (c, w, h, t) {
  tBG(c, w, h);
  var n = 7, step = Math.floor(t * 1.2) % n;
  for (var i = 0; i < n; i++) {
    var x = w * (0.12 + i * 0.127), y = h * 0.55 - i * 4;
    var on = i <= step;
    c.save(); c.globalAlpha = on ? 1 : 0.3;
    tTank(c, x, y, 8 + i * 0.8, -0.5, on ? (i === step ? '#FFDE43' : GRN[0]) : '#DDD', on ? (i === step ? '#BFA732' : GRN[1]) : '#AAA', 1 + (i % 3));
    c.restore();
  }
  tText(c, w / 2, h - 16, 'RUNG ' + (step + 1) + ' / ' + n, 12, '#FFF');
};

MODE_THUMB.draft = function (c, w, h, t) {
  tBG(c, w, h);
  var flip = (t * 1.6) % 3;
  for (var i = 0; i < 3; i++) {
    var x = w * (0.24 + i * 0.26), sel = Math.floor(flip) === i;
    var cw = 40, ch = 54;
    c.save();
    c.globalAlpha = sel ? 1 : 0.3;
    c.translate(x, h * 0.48);
    c.scale(sel ? 1 + 0.08 * Math.sin(t * 6) : 0.88, sel ? 1 + 0.08 * Math.sin(t * 6) : 0.88);
    c.fillStyle = [BLUE[0], GRN[0], PUR[0]][i];
    if (c.roundRect) { c.beginPath(); c.roundRect(-cw / 2, -ch / 2, cw, ch, 6); c.fill(); }
    else c.fillRect(-cw / 2, -ch / 2, cw, ch);
    c.restore();
    if (sel) tTank(c, x, h * 0.48, 10, -Math.PI / 2, '#FFF', '#DDD', 2);
  }
  tText(c, w / 2, h - 15, 'ONE CARD', 12, '#FFF');
};

MODE_THUMB.mirror = function (c, w, h, t) {
  tBG(c, w, h);
  for (var i = 0; i < 6; i++) {
    var x = w * (0.16 + (i % 3) * 0.34), y = h * (0.34 + Math.floor(i / 3) * 0.34);
    tTank(c, x, y, 12, t * 0.6 + i * 0.1, BLUE[0], BLUE[1], 3);
  }
  tText(c, w / 2, h - 14, 'SAME CLASS', 12, '#FFF');
};

MODE_THUMB.randomizer = function (c, w, h, t) {
  tBG(c, w, h);
  var beat = t % 2;
  for (var i = 0; i < 5; i++) {
    var a = Math.PI * 2 * (i / 5) + t * 0.4;
    var x = w / 2 + Math.cos(a) * w * 0.26, y = h / 2 + Math.sin(a) * h * 0.28;
    var guns = 1 + (Math.floor(t * 1.5 + i) % 4);
    tTank(c, x, y, 11, a, [BLUE, RED, GRN, PUR, SQ][i][0], [BLUE, RED, GRN, PUR, SQ][i][1], guns);
  }
  if (beat > 1.6) fxTint(c, w, h, '#FFF', (beat - 1.6) / 0.4 * 0.5);
  tText(c, w / 2, h - 14, 'REROLL', 12, '#E8D5FF');
};

MODE_THUMB.juggernaut = function (c, w, h, t) {
  tBG(c, w, h, '#9C9CA6');
  fxGlow(c, w / 2, h * 0.5, 62, 'rgba(140,20,40,0.5)', 1);
  for (var i = 0; i < 5; i++) {
    var a = Math.PI * 2 * (i / 5) + t * 0.5;
    tTank(c, w / 2 + Math.cos(a) * w * 0.34, h * 0.5 + Math.sin(a) * h * 0.36, 8, a + Math.PI, BLUE[0], BLUE[1]);
  }
  var ph = (t * 0.8) % 1;
  fxRing(c, w / 2, h * 0.5, 26 + ph * 34, 'rgba(255,70,80,' + (0.6 * (1 - ph)) + ')', 3, 1);
  c.save();
  c.translate(w / 2, h * 0.5); c.rotate(t * 0.22);
  for (i = 0; i < 6; i++) {
    c.save(); c.rotate(Math.PI * 2 * (i / 6));
    c.fillStyle = '#999'; c.strokeStyle = '#5A5A64'; c.lineWidth = 2;
    c.beginPath(); c.rect(0, -5, 40, 10); c.fill(); c.stroke();
    c.restore();
  }
  tShape(c, 0, 0, 25, 12, 0, '#2B2B33', '#16161B');
  c.restore();
  tText(c, w / 2, h - 14, 'KILL IT AND BECOME IT', 11, '#FFC0C4');
};

MODE_THUMB.infection = function (c, w, h, t) {
  tBG(c, w, h, '#A88083');
  var turned = Math.min(5, Math.floor((t % 6) * 1));
  for (var i = 0; i < 6; i++) {
    var x = w * (0.13 + i * 0.15), y = h * (0.45 + Math.sin(t + i) * 0.12);
    var z = i < turned;
    tTank(c, x, y, 11, z ? 0 : Math.PI, z ? RED[0] : BLUE[0], z ? RED[1] : BLUE[1], z ? 0 : 1);
    if (z) fxGlow(c, x, y, 22, 'rgba(255,60,70,0.4)', 1);
  }
  fxVignette(c, w, h, 0.4, 'rgba(110,10,18,0.5)');
  tText(c, w / 2, h - 14, (6 - turned) + ' HUMANS LEFT', 12, '#FFD5D5');
};

MODE_THUMB.bossrush = function (c, w, h, t) {
  tBG(c, w, h, '#B0A9BE');
  tShape(c, w * 0.7, h * 0.42, 30, 3, t * 0.35, TR[0], TR[1]);
  tShape(c, w * 0.7, h * 0.42, 18, 3, -t * 0.5, '#C0C0C0', '#909090');
  for (var i = 0; i < 4; i++) {
    var a = t * 0.7 + i * 1.6;
    tTank(c, w * 0.24 + Math.cos(a) * 22, h * 0.55 + Math.sin(a) * 20, 9, a, BLUE[0], BLUE[1]);
  }
  tText(c, w / 2, 18, 'WAVE ' + (1 + Math.floor(t * 0.4) % 12), 14, '#FFB07A');
  tText(c, w / 2, h - 14, 'CO-OP', 12, '#FFF');
};

MODE_THUMB.siege = function (c, w, h, t) {
  tBG(c, w, h);
  c.save(); c.fillStyle = 'rgba(241,78,84,0.22)'; c.fillRect(w * 0.58, 0, w * 0.42, h); c.restore();
  tShape(c, w * 0.82, h * 0.5, 22, 4, 0, '#B45A5F', '#8A4348');
  tShape(c, w * 0.66, h * 0.28, 12, 6, t * 0.3, '#F14E54', '#B43A3F');
  tShape(c, w * 0.66, h * 0.72, 12, 6, -t * 0.3, '#F14E54', '#B43A3F');
  for (var i = 0; i < 3; i++) {
    tTank(c, w * (0.1 + i * 0.08), h * (0.3 + i * 0.2), 10, 0, BLUE[0], BLUE[1], 2);
    var bx = w * (0.22 + i * 0.08) + ((t * 90 + i * 30) % (w * 0.4));
    c.save(); c.fillStyle = BLUE[0]; c.beginPath(); c.arc(bx, h * (0.3 + i * 0.2), 4, 0, Math.PI * 2); c.fill(); c.restore();
  }
  tText(c, w / 2, h - 14, 'ATTACK / DEFEND', 12, '#FFF');
};

MODE_THUMB.gauntlet = function (c, w, h, t) {
  tBG(c, w, h, '#B69699');
  var ph = (t * 0.35) % 1;
  for (var i = 0; i < 8; i++) {
    var a = Math.PI * 2 * (i / 8) + t * 0.1;
    var d = (0.62 - ph * 0.4);
    tShape(c, w / 2 + Math.cos(a) * w * d, h / 2 + Math.sin(a) * h * d * 1.1, 13, 3, a + Math.PI / 2, '#3A3A3A', '#1E1E1E');
  }
  tTank(c, w / 2, h / 2, 11, t, BLUE[0], BLUE[1]);
  fxVignette(c, w, h, 0.5, 'rgba(150,20,26,' + (0.28 + 0.16 * Math.sin(t * 3)) + ')');
  tText(c, w / 2, h - 14, 'THEY DO NOT STOP', 11, '#FFC0C4');
};

MODE_THUMB.bossroyale = function (c, w, h, t) {
  tBG(c, w, h, '#AFAAC0');
  tShape(c, w * 0.28, h * 0.4, 24, 3, t * 0.4, TR[0], TR[1]);
  tShape(c, w * 0.72, h * 0.36, 22, 4, -t * 0.3, '#FCC376', '#BD9259');
  tShape(c, w * 0.5, h * 0.74, 20, 1, 0, '#C0C0C0', '#909090');
  for (var i = 0; i < 5; i++) {
    var a = t + i * 1.25;
    tShape(c, w * 0.72 + Math.cos(a) * 34, h * 0.36 + Math.sin(a) * 30, 5, 4, a, '#FCC376', '#BD9259');
  }
  tText(c, w / 2, h - 14, 'ALL FIVE BOSSES', 12, '#FFF');
};

MODE_THUMB.sumo = function (c, w, h, t) {
  tBG(c, w, h, '#C9B99A');
  var R = Math.min(w, h) * 0.42;
  c.save();
  c.beginPath(); c.rect(0, 0, w, h); c.arc(w / 2, h / 2, R, 0, Math.PI * 2, true);
  c.fillStyle = 'rgba(200,40,50,0.25)'; c.fill('evenodd');
  c.restore();
  c.save(); c.strokeStyle = '#FFDE43'; c.lineWidth = 4; c.setLineDash([10, 7]); c.lineDashOffset = -t * 18;
  c.beginPath(); c.arc(w / 2, h / 2, R, 0, Math.PI * 2); c.stroke(); c.restore();
  var push = Math.sin(t * 1.4) * 22;
  tTank(c, w / 2 - 24 + push, h / 2, 13, 0, BLUE[0], BLUE[1]);
  tTank(c, w / 2 + 24 + push, h / 2, 13, Math.PI, RED[0], RED[1]);
  tText(c, w / 2, h - 14, 'NO DAMAGE — ONLY SHOVE', 11, '#FFF');
};

MODE_THUMB.diepball = function (c, w, h, t) {
  tBG(c, w, h, '#9ED6A8');
  c.save();
  c.fillStyle = 'rgba(0,178,225,0.3)'; c.fillRect(0, h * 0.22, 16, h * 0.56);
  c.fillStyle = 'rgba(241,78,84,0.3)'; c.fillRect(w - 16, h * 0.22, 16, h * 0.56);
  c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(w / 2, h); c.stroke();
  c.beginPath(); c.arc(w / 2, h / 2, 26, 0, Math.PI * 2); c.stroke();
  c.restore();
  var bx = w / 2 + Math.sin(t * 0.9) * w * 0.3, by = h / 2 + Math.cos(t * 1.3) * h * 0.2;
  tTank(c, bx - 42, by + 12, 11, 0, BLUE[0], BLUE[1]);
  tTank(c, bx + 40, by - 14, 11, Math.PI, RED[0], RED[1]);
  fxGlow(c, bx, by, 30, 'rgba(255,255,255,0.35)', 1);
  tShape(c, bx, by, 15, 1, 0, '#F5F5F5', '#B4B4B4');
  tText(c, w / 2, h - 14, '2 - 1', 13, '#FFF');
};

MODE_THUMB.grandprix = function (c, w, h, t) {
  tBG(c, w, h);
  c.save();
  c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 22;
  c.beginPath(); c.ellipse(w / 2, h / 2, w * 0.34, h * 0.3, 0, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 2; c.setLineDash([8, 10]); c.lineDashOffset = -t * 30;
  c.beginPath(); c.ellipse(w / 2, h / 2, w * 0.34, h * 0.3, 0, 0, Math.PI * 2); c.stroke();
  c.restore();
  for (var i = 0; i < 3; i++) {
    var a = t * (1.1 - i * 0.14) + i * 0.7;
    var x = w / 2 + Math.cos(a) * w * 0.34, y = h / 2 + Math.sin(a) * h * 0.3;
    tTank(c, x, y, 10, a + Math.PI / 2, [BLUE, RED, GRN][i][0], [BLUE, RED, GRN][i][1]);
  }
  tShape(c, w / 2 + w * 0.34, h / 2, 9, 6, t, '#FFDE43', '#BFA732');
  tText(c, w / 2, h - 14, 'LAP 2 / 3', 12, '#FFF');
};

MODE_THUMB.redlight = function (c, w, h, t) {
  var green = (t % 4) < 2.2;
  tBG(c, w, h, green ? '#B6D3B8' : '#D3B0B0');
  for (var i = 0; i < 5; i++) {
    var base = w * 0.16 + i * 22;
    var x = green ? base + ((t * 26 + i * 11) % (w * 0.42)) : base + 26;
    tTank(c, x, h * (0.34 + i * 0.11), 9, 0, green ? GRN[0] : RED[0], green ? GRN[1] : RED[1]);
  }
  fxGlow(c, w * 0.86, h * 0.24, 30, green ? 'rgba(40,224,112,0.6)' : 'rgba(255,59,68,0.6)', 1);
  c.save(); c.fillStyle = green ? '#28E070' : '#FF3B44';
  c.beginPath(); c.arc(w * 0.86, h * 0.24, 13, 0, Math.PI * 2); c.fill(); c.restore();
  tText(c, w / 2, h - 14, green ? 'GREEN LIGHT' : 'RED LIGHT', 12, '#FFF');
};

MODE_THUMB.singularity = function (c, w, h, t) {
  tBG(c, w, h, '#8E8AA0');
  var f = (t * 0.16) % 1;
  var R = 4 + f * f * f * Math.min(w, h) * 0.55;
  var cx = w / 2, cy = h / 2;
  c.save(); c.globalCompositeOperation = 'lighter';
  for (var i = 0; i < 4; i++) {
    c.save(); c.translate(cx, cy); c.rotate(t * (0.6 - i * 0.1) * (i % 2 ? -1 : 1));
    c.strokeStyle = 'rgba(255,' + (150 + i * 20) + ',60,' + (0.3 - i * 0.05) + ')';
    c.lineWidth = Math.max(1, R * 0.3);
    c.beginPath(); c.arc(0, 0, R * (1.5 + i * 0.6), 0, Math.PI * 1.5); c.stroke();
    c.restore();
  }
  c.restore();
  for (i = 0; i < 26; i++) {
    var ph = (t * 0.3 + i * 0.038) % 1, d = (Math.min(w, h) * 0.55) * (1 - ph * ph);
    if (d < R) continue;
    var a = i * 0.618 * Math.PI * 2 + t * 0.7;
    c.save(); c.globalAlpha = 0.6 * (1 - ph); c.fillStyle = i % 3 ? '#FFD08A' : '#9FD8FF';
    c.fillRect(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2, 2); c.restore();
  }
  fxGlow(c, cx, cy, R * 2.6, 'rgba(255,170,90,0.35)', 1);
  fxRing(c, cx, cy, R * 1.08, 'rgba(255,236,190,0.9)', Math.max(1, R * 0.08), 1);
  c.save(); c.fillStyle = '#04030A'; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill(); c.restore();
  fxVignette(c, w, h, 0.3 + f * 0.4, 'rgba(6,2,16,0.75)');
};

MODE_THUMB.prophunt = function (c, w, h, t) {
  tBG(c, w, h);
  for (var i = 0; i < 7; i++) {
    var x = w * (0.12 + tRand(i) * 0.76), y = h * (0.18 + tRand(i + 3) * 0.6);
    var k = i % 3;
    tShape(c, x, y, 13, k === 0 ? 4 : k === 1 ? 3 : 5, t * 0.2 + i,
      k === 0 ? SQ[0] : k === 1 ? TR[0] : PE[0], k === 0 ? SQ[1] : k === 1 ? TR[1] : PE[1]);
  }
  // the impostor: a square that is moving with purpose
  var px = w * 0.3 + Math.sin(t * 0.9) * w * 0.28, py = h * 0.62;
  tShape(c, px, py, 13, 4, 0, SQ[0], SQ[1]);
  fxRing(c, px, py, 20 + 2 * Math.sin(t * 3), 'rgba(0,178,225,0.6)', 2, 1);
  tTank(c, w * 0.82, h * 0.28, 12, Math.PI * 0.85, RED[0], RED[1], 2);
  tText(c, w / 2, h - 14, 'ONE OF THESE IS A TANK', 11, '#FFF');
};

MODE_THUMB.hideseek = function (c, w, h, t) {
  tBG(c, w, h, '#9C90B4');
  for (var i = 0; i < 4; i++) {
    var x = w * (0.16 + i * 0.24), y = h * (0.3 + Math.sin(t * 0.5 + i) * 0.2);
    var op = 0.1 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.7 + i * 2));
    c.save(); c.globalAlpha = op;
    tTank(c, x, y, 11, t * 0.3 + i, BLUE[0], BLUE[1]);
    c.restore();
  }
  var sw = (t * 0.5) % 1;
  fxRing(c, w * 0.78, h * 0.66, sw * w * 0.6, 'rgba(190,140,255,' + (0.4 * (1 - sw)) + ')', 3, 1);
  tTank(c, w * 0.78, h * 0.66, 13, -2.2, PUR[0], PUR[1], 2);
  fxVignette(c, w, h, 0.5, 'rgba(24,10,44,0.55)');
};

MODE_THUMB.koth = function (c, w, h, t) {
  tBG(c, w, h);
  var hx = w / 2 + Math.sin(t * 0.35) * w * 0.16, hy = h * 0.5;
  var hw = 46, hh = 34;
  c.save(); c.globalAlpha = 0.4; c.fillStyle = '#FFDE43';
  c.fillRect(hx - hw, hy - hh, hw * 2, hh * 2); c.restore();
  for (var i = 0; i < 3; i++) {
    var ph = (t * 0.7 + i / 3) % 1;
    fxRing(c, hx, hy, hw * (0.5 + ph * 1.3), 'rgba(255,222,67,' + (0.55 * (1 - ph)) + ')', 2.5, 1);
  }
  tTank(c, hx - 16, hy + 6, 11, 0.4, BLUE[0], BLUE[1]);
  tTank(c, hx + 20, hy - 8, 11, Math.PI + 0.3, RED[0], RED[1]);
  tText(c, w / 2, h - 14, 'HOLD THE ZONE', 12, '#FFF');
};

MODE_THUMB.payload = function (c, w, h, t) {
  tBG(c, w, h);
  c.save();
  c.strokeStyle = 'rgba(0,0,0,0.16)'; c.lineWidth = 20;
  c.setLineDash([16, 12]); c.lineDashOffset = -t * 26;
  c.beginPath(); c.moveTo(w * 0.1, h / 2); c.lineTo(w * 0.9, h / 2); c.stroke();
  c.restore();
  var px = w * (0.32 + 0.2 * (Math.sin(t * 0.5) * 0.5 + 0.5));
  fxGlow(c, px, h / 2, 40, 'rgba(0,178,225,0.3)', 1);
  tShape(c, px, h / 2, 21, 6, t * 0.2, '#2E86AB', '#1E5D78');
  for (var i = 0; i < 3; i++) tTank(c, px - 34 - i * 15, h / 2 + (i - 1) * 20, 9, 0, BLUE[0], BLUE[1]);
  tTank(c, px + 46, h / 2 - 12, 10, Math.PI, RED[0], RED[1]);
  c.save(); c.globalAlpha = 0.6 + 0.3 * Math.sin(t * 5); c.fillStyle = '#00B2E1';
  c.beginPath(); c.moveTo(px + 34, h / 2); c.lineTo(px + 22, h / 2 - 10); c.lineTo(px + 22, h / 2 + 10); c.closePath(); c.fill();
  c.restore();
  tText(c, w / 2, h - 14, 'ESCORT IT', 12, '#FFF');
};

MODE_THUMB.alphahunt = function (c, w, h, t) {
  tBG(c, w, h);
  var ax = w / 2, ay = h * 0.46;
  for (var i = 0; i < 3; i++) {
    var ph = (t * 0.7 + i / 3) % 1;
    fxRing(c, ax, ay, 30 * (1 + ph * 1.6), 'rgba(160,180,255,' + (0.55 * (1 - ph)) + ')', 2.5, 1);
  }
  fxGlow(c, ax, ay, 60, 'rgba(118,141,252,0.35)', 1);
  tShape(c, ax, ay, 30, 5, t * 0.14, PE[0], PE[1]);
  for (i = 0; i < 5; i++) {
    var a = t * 0.6 + i * 1.26;
    tTank(c, ax + Math.cos(a) * 58, ay + Math.sin(a) * 46, 9, a + Math.PI, [BLUE, RED, GRN, PUR, SQ][i][0], [BLUE, RED, GRN, PUR, SQ][i][1]);
  }
  tText(c, w / 2, h - 14, 'LAST HIT TAKES IT', 11, '#FFF');
};

MODE_THUMB.nestwars = function (c, w, h, t) {
  tBG(c, w, h);
  var R = Math.min(w, h) * 0.36;
  c.save();
  var gr = c.createRadialGradient(w / 2, h / 2, R * 0.2, w / 2, h / 2, R);
  gr.addColorStop(0, 'rgba(118,141,252,0.3)'); gr.addColorStop(1, 'rgba(118,141,252,0)');
  c.fillStyle = gr; c.beginPath(); c.arc(w / 2, h / 2, R, 0, Math.PI * 2); c.fill();
  c.restore();
  fxRing(c, w / 2, h / 2, R, 'rgba(118,141,252,0.8)', 3, 1);
  for (var i = 0; i < 6; i++) {
    var a = t * 0.2 + i * 1.05, d = R * (0.3 + (i % 3) * 0.22);
    tShape(c, w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d, i % 3 === 0 ? 16 : 10, 5, a, PE[0], PE[1]);
  }
  tTank(c, w / 2 - R * 0.8, h / 2, 11, 0, BLUE[0], BLUE[1]);
  tTank(c, w / 2 + R * 0.8, h / 2, 11, Math.PI, RED[0], RED[1]);
  tText(c, w / 2, h - 14, 'ONLY THE MIDDLE PAYS', 11, '#FFF');
};

MODE_THUMB.roamdom = function (c, w, h, t) {
  tBG(c, w, h);
  for (var i = 0; i < 4; i++) {
    var a = t * 0.3 * (i % 2 ? -1 : 1) + i * 1.57, d = 26 + i * 12;
    var x = w / 2 + Math.cos(a) * d, y = h / 2 + Math.sin(a) * d * 0.8;
    c.save(); c.globalAlpha = 0.25; c.strokeStyle = '#666'; c.lineWidth = 1;
    c.beginPath(); c.ellipse(w / 2, h / 2, d, d * 0.8, 0, 0, Math.PI * 2); c.stroke(); c.restore();
    tShape(c, x, y, 15, 6, a, i < 2 ? BLUE[0] : i < 3 ? RED[0] : '#FFE869', i < 2 ? BLUE[1] : i < 3 ? RED[1] : '#BFAE4E');
    tShape(c, x, y, 9, 4, -a, '#999', '#727272');
  }
  tText(c, w / 2, h - 14, 'THE POINTS MOVE', 12, '#FFF');
};

MODE_THUMB.bountyking = function (c, w, h, t) {
  tBG(c, w, h);
  var kx = w / 2, ky = h * 0.52;
  fxGlow(c, kx, ky, 52, 'rgba(255,214,60,0.4)', 1);
  fxRing(c, kx, ky, 26 + 2 * Math.sin(t * 2), 'rgba(255,222,67,0.8)', 3, 1);
  for (var i = 0; i < 5; i++) {
    var a = t * 0.5 + i * 1.26;
    tTank(c, kx + Math.cos(a) * w * 0.32, ky + Math.sin(a) * h * 0.34, 9, a + Math.PI, RED[0], RED[1]);
  }
  tTank(c, kx, ky, 15, Math.sin(t) * 0.7, '#FFDE43', '#BFA732', 2);
  c.save();
  c.fillStyle = '#FFDE43'; c.strokeStyle = '#BFA732'; c.lineWidth = 2;
  c.beginPath();
  c.moveTo(kx - 16, ky - 26); c.lineTo(kx - 16, ky - 38); c.lineTo(kx - 7, ky - 30);
  c.lineTo(kx, ky - 42); c.lineTo(kx + 7, ky - 30); c.lineTo(kx + 16, ky - 38); c.lineTo(kx + 16, ky - 26);
  c.closePath(); c.fill(); c.stroke();
  c.restore();
  tText(c, w / 2, h - 14, 'EVERYONE WANTS THE CROWN', 11, '#FFF');
};

MODE_THUMB.labyrinth = function (c, w, h, t) {
  tBG(c, w, h, '#C4C4C4');
  c.save();
  c.fillStyle = '#BBB'; c.strokeStyle = '#8C8C8C'; c.lineWidth = 2;
  var cell = 20, shrink = (Math.sin(t * 0.4) * 0.5 + 0.5) * 2;
  for (var gx = 0; gx * cell < w; gx++) for (var gy = 0; gy * cell < h; gy++) {
    if (tRand(gx * 31 + gy * 7) > 0.62) {
      var inset = shrink * cell;
      if (gx * cell < inset || gy * cell < inset || gx * cell > w - inset || gy * cell > h - inset) continue;
      c.fillRect(gx * cell + 2, gy * cell + 2, cell - 4, cell - 4);
      c.strokeRect(gx * cell + 2, gy * cell + 2, cell - 4, cell - 4);
    }
  }
  c.restore();
  tTank(c, w * 0.32, h * 0.44, 9, t * 0.4, BLUE[0], BLUE[1]);
  tTank(c, w * 0.68, h * 0.62, 9, Math.PI + t * 0.3, RED[0], RED[1]);
  fxVignette(c, w, h, 0.45, 'rgba(12,10,20,0.5)');
  tText(c, w / 2, h - 14, 'ONE LIFE', 12, '#FFF');
};

MODE_THUMB.musicaltiles = function (c, w, h, t) {
  tBG(c, w, h, '#B4B4B4');
  var n = 6, cw = w / n, ch = h / n;
  for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
    var seed = i * 13 + j * 5;
    var phase = (t * 0.35 + tRand(seed)) % 1;
    var gone = phase > 0.7, warn = phase > 0.55 && !gone;
    c.save();
    if (gone) { c.fillStyle = '#14141C'; }
    else if (warn) { c.fillStyle = 'rgba(241,78,84,' + (0.4 + 0.5 * Math.abs(Math.sin(t * 9))) + ')'; }
    else c.fillStyle = (i + j) % 2 ? '#C8C8C8' : '#BEBEBE';
    c.fillRect(i * cw + 2, j * ch + 2, cw - 4, ch - 4);
    if (warn) { c.strokeStyle = '#FFDE43'; c.lineWidth = 2; c.strokeRect(i * cw + 2, j * ch + 2, cw - 4, ch - 4); }
    c.restore();
  }
  tTank(c, w * 0.42, h * 0.42, 11, t * 0.5, BLUE[0], BLUE[1]);
  tText(c, w / 2, h - 14, 'THE FLOOR IS GOING', 11, '#FFF');
};

MODE_THUMB.portals = function (c, w, h, t) {
  tBG(c, w, h);
  var spots = [[w * 0.2, h * 0.28, 1], [w * 0.8, h * 0.72, 1], [w * 0.8, h * 0.28, 0], [w * 0.2, h * 0.72, 0]];
  for (var i = 0; i < spots.length; i++) {
    var s = spots[i], col = s[2] ? '191,127,245' : '0,225,110';
    fxGlow(c, s[0], s[1], 34, 'rgba(' + col + ',0.35)', 1);
    c.save(); c.translate(s[0], s[1]); c.rotate(t * (s[2] ? 1.2 : -1.2));
    c.globalCompositeOperation = 'lighter';
    for (var arm = 0; arm < 3; arm++) {
      c.beginPath();
      for (var st = 0; st <= 20; st++) {
        var f = st / 20, a = arm * 2.09 + f * 6.6, rr = 20 * (1.05 - f * 0.95);
        var px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (st) c.lineTo(px, py); else c.moveTo(px, py);
      }
      c.strokeStyle = 'rgba(' + col + ',0.8)'; c.lineWidth = 2; c.stroke();
    }
    c.restore();
    fxRing(c, s[0], s[1], 20, 'rgba(' + col + ',0.9)', 2, 1);
  }
  var jump = (t * 0.7) % 1;
  var from = spots[0], to = spots[1];
  if (jump < 0.5) tTank(c, from[0] + (w * 0.14) * (jump / 0.5), from[1] + 14 * (jump / 0.5), 10, 0.6, BLUE[0], BLUE[1]);
  else tTank(c, to[0] - (w * 0.14) * (1 - (jump - 0.5) / 0.5), to[1] - 14 * (1 - (jump - 0.5) / 0.5), 10, 0.6, BLUE[0], BLUE[1]);
  tText(c, w / 2, h - 14, 'SHORTCUTS', 12, '#FFF');
};

MODE_THUMB.squads = function (c, w, h, t) {
  tBG(c, w, h);
  var cols = [BLUE, GRN, PUR, RED];
  for (var s = 0; s < 4; s++) {
    var bx = w * (0.2 + (s % 2) * 0.6), by = h * (0.28 + Math.floor(s / 2) * 0.46);
    for (var i = 0; i < 4; i++) {
      var a = t * 0.4 + i * 1.57 + s;
      tTank(c, bx + Math.cos(a) * 17, by + Math.sin(a) * 15, 8, a, cols[s][0], cols[s][1]);
    }
  }
  c.save(); c.strokeStyle = 'rgba(0,0,0,0.2)'; c.lineWidth = 3;
  var R = Math.min(w, h) * (0.52 - 0.06 * Math.sin(t * 0.6));
  c.beginPath(); c.arc(w / 2, h / 2, R, 0, Math.PI * 2); c.stroke(); c.restore();
  tText(c, w / 2, h - 14, '4 x 5, ONE LIFE', 11, '#FFF');
};

MODE_THUMB.duel = function (c, w, h, t) {
  tBG(c, w, h, '#C8C4B4');
  for (var i = 0; i < 4; i++) {
    var px = w * (0.26 + (i % 2) * 0.48), py = h * (0.3 + Math.floor(i / 2) * 0.42);
    var pw = w * 0.19, ph = h * 0.17;
    c.save();
    c.globalAlpha = i === 0 ? 0.9 : 0.5;
    c.strokeStyle = '#8C8C8C'; c.lineWidth = 5;
    c.strokeRect(px - pw, py - ph, pw * 2, ph * 2);
    c.fillStyle = 'rgba(255,222,67,0.10)';
    c.fillRect(px - pw, py - ph, pw * 2, ph * 2);
    c.restore();
    var sw = Math.sin(t * 1.6 + i) * 8;
    tTank(c, px - pw * 0.45 + sw, py, 9, 0, BLUE[0], BLUE[1]);
    tTank(c, px + pw * 0.45 + sw, py, 9, Math.PI, RED[0], RED[1]);
  }
  tText(c, w / 2, h - 14, 'BRACKET', 12, '#FFF');
};

MODE_THUMB.bombtag = function (c, w, h, t) {
  tBG(c, w, h);
  var hold = Math.floor(t * 0.7) % 4;
  for (var i = 0; i < 4; i++) {
    var a = Math.PI * 2 * (i / 4) + t * 0.3;
    var x = w / 2 + Math.cos(a) * w * 0.26, y = h / 2 + Math.sin(a) * h * 0.28;
    var mine = i === hold;
    if (mine) {
      var beat = Math.abs(Math.sin(t * 6));
      fxGlow(c, x, y, 26 + beat * 16, 'rgba(255,70,40,0.6)', 1);
      fxRing(c, x, y, 18 + beat * 8, 'rgba(255,70,40,0.9)', 2.5, 1);
    }
    tTank(c, x, y, 11, a + Math.PI, mine ? '#FF6A3D' : BLUE[0], mine ? '#B84A2A' : BLUE[1]);
  }
  tText(c, w / 2, h / 2, String(3 - Math.floor(t * 2) % 3), 26, '#FF4A3D');
  tText(c, w / 2, h - 14, 'PASS IT ON', 12, '#FFF');
};

if (typeof module !== 'undefined') module.exports = { MODE_FX: MODE_FX, MODE_THUMB: MODE_THUMB };
