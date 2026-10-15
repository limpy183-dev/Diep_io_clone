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

// Only erase an isolated effect layer, never the arena beneath it.
var _fxDarkCanvas = null;
function fxDarkLayer(w, h) {
  if (!_fxDarkCanvas) _fxDarkCanvas = document.createElement('canvas');
  if (_fxDarkCanvas.width !== w) _fxDarkCanvas.width = w;
  if (_fxDarkCanvas.height !== h) _fxDarkCanvas.height = h;
  var c = _fxDarkCanvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  return c;
}

// A clear core and a smooth, eased falloff into the surrounding darkness.
function fxHole(c, x, y, r, soft) {
  var gr = c.createRadialGradient(x, y, r * (soft === undefined ? 0.25 : soft), x, y, r);
  gr.addColorStop(0, 'rgba(0,0,0,1)');
  for (var i = 1; i < 16; i++) {
    var u = i / 16;
    gr.addColorStop(u, 'rgba(0,0,0,' + (1 - u * u * (3 - 2 * u)) + ')');
  }
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

// An arrow at the edge of the screen pointing at something you cannot see.
// Every mode with one thing that matters needs this: without it a 22,300-unit
// arena hides the objective and the mode reads as "nothing is happening".
// Returns true if it drew, i.e. if the target really is off screen.
function fxPointer(r, c, wx, wy, color, label) {
  var w = r.canvas.width, h = r.canvas.height;
  var s = r.toScreen(wx, wy), pad = 62;
  if (s.x > pad && s.y > pad && s.x < w - pad && s.y < h - pad) return false;
  var cx = w / 2, cy = h / 2;
  var ang = Math.atan2(s.y - cy, s.x - cx);
  // Clamp to the screen rectangle rather than to a circle, so the arrow sits on
  // the edge you are actually looking at.
  var m = Math.min((w / 2 - pad) / Math.max(1e-3, Math.abs(Math.cos(ang))),
                   (h / 2 - pad) / Math.max(1e-3, Math.abs(Math.sin(ang))));
  var px = cx + Math.cos(ang) * m, py = cy + Math.sin(ang) * m;
  c.save();
  c.globalAlpha = 0.92;
  c.translate(px, py);
  c.rotate(ang);
  c.fillStyle = color;
  c.strokeStyle = 'rgba(0,0,0,0.45)';
  c.lineWidth = 3;
  c.beginPath(); c.moveTo(21, 0); c.lineTo(-15, -14); c.lineTo(-15, 14); c.closePath();
  c.fill(); c.stroke();
  c.restore();
  if (label) {
    c.save();
    c.font = 'bold 12px Ubuntu, Verdana, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    var lx = cx + Math.cos(ang) * (m - 34), ly = cy + Math.sin(ang) * (m - 34);
    c.lineWidth = 3.4; c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.strokeText(label, lx, ly);
    c.fillStyle = '#FFF'; c.fillText(label, lx, ly);
    c.restore();
  }
  return true;
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
    var scene = c;
    c = fxDarkLayer(w, h);
    // 1. the murk itself, world-anchored so you move through it
    drawFogBank(r, c, g, t, 0.45, 'rgba(115,139,160,0.22)', 'rgba(63,83,107,0.28)');
    // 2. a flat dark layer with your own lantern punched out of it
    c.save();
    c.fillStyle = 'rgba(24,30,40,0.62)';
    c.fillRect(0, 0, w, h);
    c.restore();
    fxVignette(c, w, h, 0.62, 'rgba(10,14,20,0.9)');
    if (me) fxHole(c, me.x, me.y, Math.min(w, h) * 0.42, 0.22);
    scene.drawImage(c.canvas, 0, 0);
    // Add flashes to the finished scene so the darkness cannot desaturate
    // them and the player's clear sight area cannot erase them.
    for (var i = 0; i < g.entities.length; i++) {
      var e = g.entities[i];
      if (e.type !== 'tank' || e.dead || !e.barrels) continue;
      var p = ipos(e, r.alpha || 0), scale = e.scaleFactor || 1;
      for (var b = 0; b < e.barrels.length; b++) {
        var barrel = e.barrels[b], lit = barrel.recoilAnim;
        if (lit <= 0.35) continue;
        // Match drawBarrel's interpolated pose, lateral offset and recoil.
        var d = barrel.def, a = p.a + d.angle;
        var len = d.size * scale * (1 - lit * 0.12), off = d.offset * scale;
        if (d.addon === 'trapLauncher') len += d.size * scale * 0.28;
        var s = r.toScreen(p.x + Math.cos(a) * len - Math.sin(a) * off,
                           p.y + Math.sin(a) * len + Math.cos(a) * off);
        var radius = Math.max(18, d.width * scale * r.scaling() * 2.2) * lit;
        fxGlow(scene, s.x, s.y, radius, 'rgba(255,205,70,0.5)', 0.75);
      }
    }
  }
};

// =========================================================================
// Nightfall — the same idea, running on a clock, and colder
// =========================================================================

MODE_FX.nightfall = {
  screen: function (r, c, g, t) {
    var w = r.canvas.width, h = r.canvas.height;
    var f = (g.fx && g.fx.night) || 0;
    if (f <= 0) return;
    var me = fxSelf(r);
    var scene = c;
    c = fxDarkLayer(w, h);
    // sky first: warm dusk sliding to deep blue
    var sky = c.createLinearGradient(0, 0, 0, h);
    var warm = Math.max(0, 1 - f * 2.2);
    sky.addColorStop(0, 'rgba(' + Math.round(30 + warm * 90) + ',' + Math.round(28 + warm * 40) + ',' + Math.round(64 + warm * 20) + ',' + (f * 0.78) + ')');
    sky.addColorStop(1, 'rgba(6,8,20,' + (f * 0.9) + ')');
    c.save(); c.fillStyle = sky; c.fillRect(0, 0, w, h);
    c.restore();
    drawFogBank(r, c, g, t, f * 0.5, 'rgba(90,110,170,0.26)', 'rgba(40,54,96,0.3)');
    // a cold moon rising as it gets late
    if (f > 0.3) {
      var mx = w * 0.86, my = h * (0.34 - (f - 0.3) * 0.16);
      fxGlow(c, mx, my, 190, 'rgba(190,215,255,0.30)', f);
      c.save(); c.globalAlpha = f;
      c.beginPath(); c.arc(mx, my, 34, 0, Math.PI * 2);
      c.fillStyle = '#E9F1FF'; c.fill();
      c.restore();
    }
    fxVignette(c, w, h, 0.35 + f * 0.4, 'rgba(2,4,12,' + (f * 0.9) + ')');
    if (me) fxHole(c, me.x, me.y, Math.min(w, h) * (0.46 - f * 0.22), 0.26);
    scene.drawImage(c.canvas, 0, 0);
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
    var fx = g.fx || {}, j = fx.jugg;
    if (!j || j.dead) return;
    var k = r.scaling(), s = r.toScreen(j.x, j.y), rad = j.size * k;
    var rage = !!fx.rage;

    // The spike line: cross it and the collar opens up. Drawn because the rule
    // is enforced, so it should also be legible.
    if (fx.spikeR) {
      var sr = fx.spikeR * k;
      c.save();
      c.setLineDash([Math.max(5, sr * 0.10), Math.max(5, sr * 0.07)]);
      c.lineDashOffset = -t * 40;
      c.strokeStyle = fx.band >= 3 ? 'rgba(255,80,60,0.85)' : 'rgba(255,170,70,0.35)';
      c.lineWidth = Math.max(1.5, sr * 0.015);
      c.beginPath(); c.arc(s.x, s.y, sr, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
      c.restore();
    }
    // SLAM: an expanding shock ring where it landed
    if (fx.juggFx && fx.juggFx.slam) {
      var age = (g.tick - fx.juggFx.slam) / TPS;
      if (age < 0.9) {
        var sp = r.toScreen(fx.juggFx.x, fx.juggFx.y), sR = fx.juggFx.r * k;
        fxRing(c, sp.x, sp.y, sR * (0.2 + age * 1.3), 'rgba(255,220,140,' + (1 - age / 0.9) + ')', Math.max(3, sR * 0.09), 1);
        fxGlow(c, sp.x, sp.y, sR * (0.5 + age), 'rgba(255,150,60,' + (0.6 * (1 - age / 0.9)) + ')', 1);
      }
    }
    // SHOCKWAVE: a wider, slower ring
    if (fx.juggFx && fx.juggFx.wave) {
      var wage = (g.tick - fx.juggFx.wave) / TPS;
      if (wage < 1.4) {
        var wp = r.toScreen(fx.juggFx.x, fx.juggFx.y);
        fxRing(c, wp.x, wp.y, rad * (1 + wage * 7), 'rgba(255,90,90,' + (0.8 * (1 - wage / 1.4)) + ')', Math.max(2, rad * 0.14), 1);
      }
    }
    // a heavy dark aura, breathing — hotter and faster when it is cornered
    fxGlow(c, s.x, s.y, rad * 3.4, rage ? 'rgba(200,30,30,0.42)' : 'rgba(120,20,40,0.30)', 1);
    for (var i = 0; i < 3; i++) {
      var ph = (t * (rage ? 1.3 : 0.55) + i / 3) % 1;
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
    // Nobody should have to search a 22,300-unit arena for the thing the whole
    // mode is about.
    fxPointer(r, c, j.x, j.y, '#F14E54', 'JUGGERNAUT');
    if (g.fx && g.fx.rage) {
      c.save();
      c.font = 'bold 13px Ubuntu, Verdana, sans-serif';
      c.textAlign = 'center'; c.globalAlpha = 0.85;
      c.fillStyle = '#FF6A5A';
      c.fillText('CORNERED', w / 2, 96);
      c.restore();
    }
  }
};

// =========================================================================
// Juggernaut Royale
// =========================================================================
//
// Nothing in here knows a hull by name. Every juggernaut carries its own
// costume on its def — jrTone is the branch colour, jrTone2 is the second
// colour a fusion hull burns, jrAura names the painter and jrTier is how loud
// it all gets — so adding a hull to the roster adds its aura for free.
//
// Three layers, drawn in this order:
//   ground     burning patches and ice sheets the mode laid down
//   hulls      the aura, then whatever statuses are riding the tank, then the
//              links it is holding (a tether, a beam, a dome, an orbiting mass)
//   bursts     the ability effects, out of a ring buffer on the game

function jrRGBA(tone, a) { return 'rgba(' + tone + ',' + a + ')'; }

// A ring of n points on a circle, rotated. Half the painters below are this.
function jrDots(c, x, y, rad, n, rot, dot, fill) {
  c.fillStyle = fill;
  for (var i = 0; i < n; i++) {
    var a = Math.PI * 2 * (i / n) + rot;
    c.beginPath();
    c.arc(x + Math.cos(a) * rad, y + Math.sin(a) * rad, dot, 0, Math.PI * 2);
    c.fill();
  }
}

// A ring of n triangular barbs pointing outward.
function jrBarbs(c, x, y, rad, n, rot, len, fill, stroke, lw) {
  for (var i = 0; i < n; i++) {
    var a = Math.PI * 2 * (i / n) + rot, s = 0.34;
    c.beginPath();
    c.moveTo(x + Math.cos(a - s) * rad, y + Math.sin(a - s) * rad);
    c.lineTo(x + Math.cos(a) * (rad + len), y + Math.sin(a) * (rad + len));
    c.lineTo(x + Math.cos(a + s) * rad, y + Math.sin(a + s) * rad);
    c.closePath();
    c.fillStyle = fill; c.fill();
    if (stroke) { c.lineWidth = lw; c.strokeStyle = stroke; c.stroke(); }
  }
}

var JR_AURA = {

  // The Brute: two slow breaths and nothing else. It has not decided yet.
  ring: function (c, x, y, R, A, B, t, e, tier) {
    for (var i = 0; i < 2; i++) {
      var ph = (t * 0.35 + i / 2) % 1;
      fxRing(c, x, y, R * (1.05 + ph * 0.55), jrRGBA(A, 0.34 * (1 - ph)), Math.max(1, R * 0.04), 1);
    }
  },

  // WARDEN: a collar of barbs turning slowly, and low green light on the ground.
  thorn: function (c, x, y, R, A, B, t, e, tier) {
    fxGlow(c, x, y, R * 2.4, jrRGBA(A, 0.15 + tier * 0.04), 1);
    jrBarbs(c, x, y, R * 1.14, 6 + tier * 2, t * 0.25, R * (0.22 + tier * 0.05),
      jrRGBA(A, 0.5), jrRGBA(A, 0.85), Math.max(1, R * 0.025));
  },

  // REAPER: motes on two counter-turning orbits, like a flock that has not left yet.
  swarm: function (c, x, y, R, A, B, t, e, tier) {
    fxGlow(c, x, y, R * 2.5, jrRGBA(A, 0.16 + tier * 0.04), 1);
    jrDots(c, x, y, R * 1.38, 5 + tier, t * 0.9, Math.max(1.5, R * 0.075), jrRGBA(A, 0.8));
    jrDots(c, x, y, R * 1.8, 4 + tier, -t * 0.55 + 0.4, Math.max(1, R * 0.055), jrRGBA(A, 0.5));
  },

  // BULWARK: the ground gives. A heavy pulse and short radial cracks.
  quake: function (c, x, y, R, A, B, t, e, tier) {
    fxGlow(c, x, y, R * 2.3, jrRGBA(A, 0.17 + tier * 0.04), 1);
    var ph = (t * 0.5) % 1;
    fxRing(c, x, y, R * (1.0 + ph * 0.9), jrRGBA(A, 0.5 * (1 - ph)), Math.max(2, R * 0.09 * (1 - ph)), 1);
    c.save();
    c.strokeStyle = jrRGBA(A, 0.4); c.lineWidth = Math.max(1.5, R * 0.038); c.lineCap = 'round';
    for (var i = 0; i < 8; i++) {
      var a = Math.PI * 2 * (i / 8) + 0.3;
      var l = R * (1.15 + 0.25 * Math.abs(Math.sin(t * 1.2 + i)));
      c.beginPath();
      c.moveTo(x + Math.cos(a) * R * 1.02, y + Math.sin(a) * R * 1.02);
      c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      c.stroke();
    }
    c.restore();
  },

  // LODESTONE: motes falling inward on a spiral, over a hole that eats light.
  void: function (c, x, y, R, A, B, t, e, tier) {
    c.save();
    c.globalCompositeOperation = 'multiply';
    fxGlow(c, x, y, R * 2.4, 'rgba(20,22,48,0.62)', 1);
    c.restore();
    fxRing(c, x, y, R * 1.5, jrRGBA(A, 0.4), Math.max(1.5, R * 0.06), 1);
    var n = 8 + tier * 3;
    c.fillStyle = jrRGBA(A, 0.7);
    for (var i = 0; i < n; i++) {
      var ph = (t * 0.55 + i / n) % 1;
      var rad = R * (2.4 - ph * 1.35), a = Math.PI * 2 * (i / n) + ph * 2.6;
      c.globalAlpha = ph * ph;
      c.beginPath();
      c.arc(x + Math.cos(a) * rad, y + Math.sin(a) * rad, Math.max(1, R * 0.045 * (0.4 + ph)), 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  },

  // CINDER: tongues of flame off the shell, and heat sitting on it.
  ember: function (c, x, y, R, A, B, t, e, tier) {
    fxGlow(c, x, y, R * (2.3 + tier * 0.22), jrRGBA(A, 0.22 + tier * 0.05), 1);
    c.save();
    c.globalCompositeOperation = 'lighter';
    var n = 7 + tier * 2;
    for (var i = 0; i < n; i++) {
      var seed = i * 2.399;
      var ph = (t * 1.15 + i / n) % 1;
      var a = seed + Math.sin(t * 1.7 + i) * 0.22;
      var rad = R * (1.0 + ph * 0.85);
      var s = Math.max(1, R * 0.17 * (1 - ph) * (0.6 + tier * 0.16));
      c.fillStyle = jrRGBA(ph < 0.45 ? '255,236,150' : A, 0.75 * (1 - ph));
      c.beginPath();
      c.arc(x + Math.cos(a) * rad, y + Math.sin(a) * rad, s, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  },

  // RIME: fixed crystal shards, a pale rim, and the air going still.
  frost: function (c, x, y, R, A, B, t, e, tier) {
    fxGlow(c, x, y, R * 2.3, jrRGBA(A, 0.18 + tier * 0.04), 1);
    var n = 6 + tier;
    c.save();
    c.lineWidth = Math.max(1.5, R * 0.06); c.strokeStyle = jrRGBA(A, 0.8); c.lineCap = 'round';
    for (var i = 0; i < n; i++) {
      var a = Math.PI * 2 * (i / n) + t * 0.08;
      var l = R * (1.25 + 0.14 * Math.sin(t * 0.9 + i * 1.3));
      c.beginPath();
      c.moveTo(x + Math.cos(a) * R * 0.98, y + Math.sin(a) * R * 0.98);
      c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      c.stroke();
      // the little cross-hatch that makes it read as a crystal and not a spike
      var mx = x + Math.cos(a) * (R + l) * 0.5, my = y + Math.sin(a) * (R + l) * 0.5;
      c.beginPath();
      c.moveTo(mx - Math.sin(a) * R * 0.1, my + Math.cos(a) * R * 0.1);
      c.lineTo(mx + Math.sin(a) * R * 0.1, my - Math.cos(a) * R * 0.1);
      c.stroke();
    }
    c.restore();
    fxRing(c, x, y, R * 1.06, jrRGBA(A, 0.5), Math.max(1, R * 0.036), 1);
  },

  // LEECH: a wet pulse, and threads reaching for something to hold.
  blood: function (c, x, y, R, A, B, t, e, tier) {
    var beat = 0.5 + 0.5 * Math.pow(Math.abs(Math.sin(t * 1.6)), 3);
    fxGlow(c, x, y, R * (2.1 + beat * 0.7), jrRGBA(A, 0.2 + tier * 0.05 + beat * 0.1), 1);
    c.save();
    c.strokeStyle = jrRGBA(A, 0.6); c.lineWidth = Math.max(1.5, R * 0.055); c.lineCap = 'round';
    var n = 5 + tier;
    for (var i = 0; i < n; i++) {
      var a = Math.PI * 2 * (i / n) + t * 0.2;
      var l = R * (1.15 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.2 + i * 2)));
      c.beginPath();
      c.moveTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
      c.quadraticCurveTo(
        x + Math.cos(a + 0.3) * l * 0.8, y + Math.sin(a + 0.3) * l * 0.8,
        x + Math.cos(a) * l, y + Math.sin(a) * l);
      c.stroke();
    }
    c.restore();
  },

  // EFFIGY: three echoes of the hull, none of them quite where it is.
  ghost: function (c, x, y, R, A, B, t, e, tier) {
    c.save();
    for (var i = 0; i < 3; i++) {
      var ph = (t * 0.6 + i / 3) % 1;
      var a = Math.PI * 2 * (i / 3) + t * 0.5;
      c.globalAlpha = 0.34 * (1 - ph);
      fxPoly(c, x + Math.cos(a) * R * ph * 1.1, y + Math.sin(a) * R * ph * 1.1,
        R * (1 - ph * 0.2) * 1.41, e.sides || 8, e.angle || 0);
      c.fillStyle = jrRGBA(A, 1); c.fill();
    }
    c.restore();
    fxGlow(c, x, y, R * 2.2, jrRGBA(A, 0.15 + tier * 0.04), 1);
  },

  // METRONOME: twelve ticks and a hand. The hand tells you which beat it is on.
  clock: function (c, x, y, R, A, B, t, e, tier) {
    fxGlow(c, x, y, R * 2.2, jrRGBA(A, 0.16 + tier * 0.04), 1);
    jrDots(c, x, y, R * 1.28, 12, 0, Math.max(1, R * 0.045), jrRGBA(A, 0.7));
    var heavy = e.jrBeat;
    var sweep = t * (heavy ? 0.8 : 2.6);
    c.save();
    c.strokeStyle = jrRGBA(A, 0.95); c.lineWidth = Math.max(2, R * 0.06); c.lineCap = 'round';
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(sweep) * R * 1.24, y + Math.sin(sweep) * R * 1.24);
    c.stroke();
    c.restore();
    fxRing(c, x, y, R * 1.28, jrRGBA(A, heavy ? 0.75 : 0.38), Math.max(1, R * 0.028), 1);
  },

  // ARSENAL: four brackets and a range sweep. When it roots, they lock square.
  steel: function (c, x, y, R, A, B, t, e, tier) {
    var locked = !!e.jrRoot || e.jrDug > 25;
    var rad = R * (locked ? 1.16 : 1.34 + 0.05 * Math.sin(t * 2));
    c.save();
    c.strokeStyle = jrRGBA(A, locked ? 0.95 : 0.7);
    c.lineWidth = Math.max(2, R * 0.065); c.lineCap = 'round';
    for (var i = 0; i < 4; i++) {
      var a0 = Math.PI / 2 * i + (locked ? Math.PI / 4 : t * 0.35);
      c.beginPath(); c.arc(x, y, rad, a0 - 0.28, a0 + 0.28); c.stroke();
    }
    c.restore();
    if (locked) fxGlow(c, x, y, R * 2.3, jrRGBA(A, 0.22), 1);
    else {
      var sw = t * 1.1 % (Math.PI * 2);
      c.save();
      c.strokeStyle = jrRGBA(A, 0.38); c.lineWidth = Math.max(1, R * 0.026);
      c.beginPath(); c.arc(x, y, R * 1.55, sw, sw + 0.7); c.stroke();
      c.restore();
    }
  },

  // PARASITE: blisters that swell and go.
  bile: function (c, x, y, R, A, B, t, e, tier) {
    fxGlow(c, x, y, R * 2.2, jrRGBA(A, 0.18 + tier * 0.04), 1);
    var n = 6 + tier * 2;
    for (var i = 0; i < n; i++) {
      var ph = (t * 0.75 + i * 0.37) % 1;
      var a = i * 2.399 + t * 0.15;
      var rad = R * (1.05 + ph * 0.45);
      c.fillStyle = jrRGBA(A, 0.75 * (1 - ph));
      c.beginPath();
      c.arc(x + Math.cos(a) * rad, y + Math.sin(a) * rad, Math.max(1.5, R * 0.13 * (0.3 + ph)), 0, Math.PI * 2);
      c.fill();
    }
  },

  // TIER 4: two branches burning at once, on rings that turn against each other.
  fusion: function (c, x, y, R, A, B, t, e, tier) {
    B = B || A;
    fxGlow(c, x, y, R * 2.9, jrRGBA(A, 0.2), 1);
    fxGlow(c, x, y, R * 1.9, jrRGBA(B, 0.2), 1);
    jrBarbs(c, x, y, R * 1.16, 10, t * 0.32, R * 0.26, jrRGBA(A, 0.55), jrRGBA(A, 0.9), Math.max(1, R * 0.022));
    jrDots(c, x, y, R * 1.68, 8, -t * 0.5, Math.max(1.5, R * 0.075), jrRGBA(B, 0.85));
    for (var i = 0; i < 2; i++) {
      var ph = (t * 0.45 + i / 2) % 1;
      fxRing(c, x, y, R * (1.1 + ph * 1.0), jrRGBA(i ? B : A, 0.45 * (1 - ph)), Math.max(1, R * 0.05 * (1 - ph)), 1);
    }
    // a bright core, because a tier-4 hull should read as lit from inside
    c.save();
    c.globalCompositeOperation = 'lighter';
    fxGlow(c, x, y, R * 0.7, jrRGBA('255,255,255', 0.16 + 0.06 * Math.sin(t * 3)), 1);
    c.restore();
  },

  // TIER 7: a court. The fusion aura with a second, much wider ring of barbs
  // turning against it and a standing wheel of motes — a titan should read as
  // "the arena is arranged around this" from further away than it can shoot.
  sovereign: function (c, x, y, R, A, B, t, e, tier) {
    B = B || A;
    fxGlow(c, x, y, R * 3.4, jrRGBA(A, 0.2), 1);
    fxGlow(c, x, y, R * 2.2, jrRGBA(B, 0.22), 1);
    jrBarbs(c, x, y, R * 1.2, 12, t * 0.24, R * 0.3, jrRGBA(A, 0.55), jrRGBA(A, 0.95), Math.max(1, R * 0.02));
    jrBarbs(c, x, y, R * 1.76, 8, -t * 0.16, R * 0.22, jrRGBA(B, 0.4), jrRGBA(B, 0.8), Math.max(1, R * 0.016));
    jrDots(c, x, y, R * 2.15, 16, t * 0.1, Math.max(1.5, R * 0.055), jrRGBA(B, 0.7));
    for (var i = 0; i < 3; i++) {
      var ph = (t * 0.4 + i / 3) % 1;
      fxRing(c, x, y, R * (1.1 + ph * 1.4), jrRGBA(i % 2 ? B : A, 0.4 * (1 - ph)), Math.max(1, R * 0.055 * (1 - ph)), 1);
    }
    c.save();
    c.globalCompositeOperation = 'lighter';
    fxGlow(c, x, y, R * 0.85, jrRGBA('255,255,255', 0.2 + 0.08 * Math.sin(t * 3)), 1);
    c.restore();
  },

  // TIER 8: the crown. Everything the sovereign has, plus a solid outer wheel
  // that does not pulse — it is simply there, all the time, and it is the one
  // aura in the mode you can read at any zoom the camera will give you.
  crown: function (c, x, y, R, A, B, t, e, tier) {
    B = B || A;
    fxGlow(c, x, y, R * 4.2, jrRGBA(A, 0.2), 1);
    fxGlow(c, x, y, R * 2.6, jrRGBA(B, 0.24), 1);
    jrBarbs(c, x, y, R * 1.22, 16, t * 0.18, R * 0.34, jrRGBA(A, 0.6), jrRGBA(A, 1), Math.max(1, R * 0.018));
    jrBarbs(c, x, y, R * 1.9, 10, -t * 0.12, R * 0.26, jrRGBA(B, 0.45), jrRGBA(B, 0.9), Math.max(1, R * 0.015));
    fxRing(c, x, y, R * 2.5, jrRGBA(A, 0.55), Math.max(1.5, R * 0.03), 1);
    fxRing(c, x, y, R * 2.62, jrRGBA(B, 0.35), Math.max(1, R * 0.016), 1);
    jrDots(c, x, y, R * 2.56, 24, -t * 0.07, Math.max(1.5, R * 0.045), jrRGBA('255,255,255', 0.8));
    for (var i = 0; i < 4; i++) {
      var ph = (t * 0.35 + i / 4) % 1;
      fxRing(c, x, y, R * (1.15 + ph * 1.9), jrRGBA(i % 2 ? B : A, 0.42 * (1 - ph)), Math.max(1, R * 0.06 * (1 - ph)), 1);
    }
    c.save();
    c.globalCompositeOperation = 'lighter';
    fxGlow(c, x, y, R * 1.05, jrRGBA('255,255,255', 0.26 + 0.1 * Math.sin(t * 2.4)), 1);
    c.restore();
  }
};

// Statuses. These ride on top of whatever aura the hull has, and they are the
// same shapes whoever applied them: burning is burning.
function jrPaintStatus(r, c, g, e, x, y, R, t) {
  if (e.jrBurn && g.tick < e.jrBurn) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 6; i++) {
      var ph = (t * 1.6 + i / 6) % 1, a = i * 2.399 + t * 0.6;
      c.fillStyle = jrRGBA(ph < 0.5 ? '255,220,120' : '255,110,40', 0.7 * (1 - ph));
      c.beginPath();
      c.arc(x + Math.cos(a) * R * 0.8, y + Math.sin(a) * R * 0.8 - ph * R * 1.1,
        Math.max(1, R * 0.2 * (1 - ph)), 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
  if (e.jrHold && g.tick < e.jrHold) {
    fxGlow(c, x, y, R * 1.6, 'rgba(180,235,255,0.20)', 1);
    c.save();
    c.strokeStyle = 'rgba(225,248,255,0.7)'; c.lineWidth = Math.max(1.5, R * 0.05);
    fxPoly(c, x, y, R * 1.32, 6, t * 0.2); c.stroke();
    c.fillStyle = 'rgba(190,235,255,0.09)'; c.fill();
    c.restore();
  } else if (e.jrChill && g.tick < e.jrChill) {
    fxRing(c, x, y, R * 1.12, 'rgba(170,225,255,0.5)', Math.max(1, R * 0.05), 1);
  }
  if (e.jrBleed) {
    c.save();
    c.fillStyle = 'rgba(210,40,60,0.7)';
    for (i = 0; i < 3; i++) {
      var p2 = (t * 1.1 + i / 3) % 1, a2 = i * 2.1 + 1.2;
      c.beginPath();
      c.arc(x + Math.cos(a2) * R * 0.9, y + Math.sin(a2) * R * 0.9 + p2 * R * 1.2,
        Math.max(1, R * 0.09 * (1 - p2)), 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
  // --- the late-tier states -----------------------------------------------
  // AEGIS reads as a hard shell that shrinks as it is eaten, so "the shield is
  // nearly gone" is something you can see rather than something you infer.
  if (e.jrShieldMax > 0 && e.jrShield > 0) {
    var f = Math.min(1, e.jrShield / e.jrShieldMax);
    c.save();
    c.strokeStyle = 'rgba(190,225,255,' + (0.25 + 0.5 * f) + ')';
    c.lineWidth = Math.max(1.5, R * 0.05 * (0.4 + f));
    c.beginPath(); c.arc(x, y, R * (1.16 + 0.12 * f), 0, Math.PI * 2 * f); c.stroke();
    c.restore();
  }
  // BLINKSTEP: it is not there. Nothing lands and the hull says so.
  if (e.jrPhaseUntil && g.tick < e.jrPhaseUntil) {
    fxRing(c, x, y, R * (1.3 + 0.4 * Math.sin(t * 9)), 'rgba(235,255,255,0.55)', Math.max(1, R * 0.05), 1);
    fxGlow(c, x, y, R * 1.9, 'rgba(220,245,255,0.18)', 1);
  }
  // AVATAR: eight seconds of being twice the tank.
  if (e.jrAvaOn) {
    fxGlow(c, x, y, R * 2.8, 'rgba(255,225,170,0.24)', 1);
    fxRing(c, x, y, R * 1.4, 'rgba(255,235,190,0.7)', Math.max(1.5, R * 0.06), 1);
  }
  // DOMINION: the window where everything it kills gets back up.
  if (e.jrDominion && g.tick < e.jrDominion)
    jrDots(c, x, y, R * 1.55, 8, -t * 0.8, Math.max(1.5, R * 0.06), 'rgba(200,60,90,0.8)');
}

// The links a hull is holding: a chain to whoever it tethered, a beam it is
// channelling, the dome it threw up, the mass on the end of its arm.
function jrPaintLinks(r, c, g, e, s, R, t, k) {
  var i;
  if (e.jrTether && !e.jrTether.dead) {
    var o = r.toScreen(e.jrTether.x, e.jrTether.y);
    c.save();
    c.strokeStyle = 'rgba(200,240,90,0.55)'; c.lineWidth = Math.max(2, R * 0.09); c.lineCap = 'round';
    c.setLineDash([Math.max(4, R * 0.32), Math.max(4, R * 0.26)]);
    c.lineDashOffset = -t * 60;
    c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(o.x, o.y); c.stroke();
    c.setLineDash([]);
    c.restore();
  }
  if (e.jrHost && !e.jrHost.dead) {
    var h = r.toScreen(e.jrHost.x, e.jrHost.y);
    c.save();
    c.strokeStyle = 'rgba(200,240,90,0.75)'; c.lineWidth = Math.max(1.5, R * 0.06);
    c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(h.x, h.y); c.stroke();
    c.restore();
  }
  if (e.jrBeam && g.tick < e.jrBeam) {
    var a = e.jrBeamA || e.angle, len = 3000 * k;
    var gr = c.createLinearGradient(s.x, s.y, s.x + Math.cos(a) * len, s.y + Math.sin(a) * len);
    gr.addColorStop(0, 'rgba(230,250,255,0.95)');
    gr.addColorStop(0.35, 'rgba(150,225,255,0.55)');
    gr.addColorStop(1, 'rgba(150,225,255,0)');
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = gr; c.lineWidth = R * (0.7 + 0.25 * Math.sin(t * 22)); c.lineCap = 'round';
    c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x + Math.cos(a) * len, s.y + Math.sin(a) * len); c.stroke();
    c.lineWidth = R * 0.22; c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x + Math.cos(a) * len, s.y + Math.sin(a) * len); c.stroke();
    c.restore();
  }
  if (e.jrBubble && g.tick < e.jrBubble) {
    var br = R * 5;
    c.save();
    c.fillStyle = 'rgba(150,225,255,0.08)';
    c.beginPath(); c.arc(s.x, s.y, br, 0, Math.PI * 2); c.fill();
    c.restore();
    fxRing(c, s.x, s.y, br, 'rgba(190,240,255,' + (0.55 + 0.2 * Math.sin(t * 4)) + ')', Math.max(2, R * 0.08), 1);
    jrDots(c, s.x, s.y, br, 16, t * 0.4, Math.max(1, R * 0.05), 'rgba(220,248,255,0.5)');
  }
  if (e.jrHarden && g.tick < e.jrHarden) {
    fxRing(c, s.x, s.y, R * 1.5, 'rgba(255,255,255,0.9)', Math.max(2, R * 0.14), 1);
    fxGlow(c, s.x, s.y, R * 2.0, 'rgba(255,255,255,0.2)', 1);
  }
  if (e.jrRoot) {
    c.save();
    c.strokeStyle = 'rgba(190,205,225,0.75)'; c.lineWidth = Math.max(1.5, R * 0.07); c.lineCap = 'round';
    for (i = 0; i < 4; i++) {
      var ra = Math.PI / 2 * i + Math.PI / 4;
      c.beginPath();
      c.moveTo(s.x + Math.cos(ra) * R * 1.0, s.y + Math.sin(ra) * R * 1.0);
      c.lineTo(s.x + Math.cos(ra) * R * 1.7, s.y + Math.sin(ra) * R * 1.7);
      c.stroke();
    }
    c.restore();
  }
  // the arm that holds an orbiting mass — otherwise the ball reads as debris
  if (e.jrOrbs && e.jrOrbs.length) {
    c.save();
    c.strokeStyle = jrRGBA(e.def.jrTone, 0.5); c.lineWidth = Math.max(1.5, R * 0.09); c.lineCap = 'round';
    for (i = 0; i < e.jrOrbs.length; i++) {
      var ob = e.jrOrbs[i];
      if (!ob || ob.dead) continue;
      var op = r.toScreen(ob.x, ob.y);
      c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(op.x, op.y); c.stroke();
    }
    c.restore();
  }
  if (e.jrLit) fxPointer(r, c, e.x, e.y, 'rgb(' + e.def.jrTone + ')', (e.def.name || 'BEACON').toUpperCase());
  if ((e.def.jrTier || 0) > 8 || e.jaLift) jaPaintLinks(r, c, g, e, s, R, t, k);
}

// Burning ground and ice sheets. Drawn here rather than as entities, because a
// flat twelve-sided polygon is not what a burning patch looks like.
//
// Off-screen patches are skipped, and only the first ten burning patches on
// screen get a glow: a crown that leaves fire behind it lays thirty of them on
// top of each other, and thirty additive glows over a light floor is a white
// smear that also costs the frame several milliseconds. The embers still draw
// for every one of them, so the ground reads as just as much on fire.
function jrPaintFields(r, c, g, t, k) {
  if (!g.jrFields || !g.jrFields.length) return;
  var glows = 0, W = r.canvas.width, H = r.canvas.height;
  for (var i = 0; i < g.jrFields.length; i++) {
    var f = g.jrFields[i];
    if (f.dead) continue;
    var s = r.toScreen(f.x, f.y), R = f.size * k;
    if (s.x < -R * 2.7 || s.y < -R * 2.7 || s.x > W + R * 2.7 || s.y > H + R * 2.7) continue;
    var life = Math.max(0.001, f.jrDie - f.jrBorn);
    var fade = Math.max(0, Math.min(1, (f.jrDie - g.tick) / life));
    if (f.jrKind === 'well') { jaPaintWell(r, c, g, f, s, R, t, Math.min(1, fade * 4)); continue; }
    if (f.jrKind === 'burn') {
      c.save();
      c.globalCompositeOperation = 'lighter';
      if (glows++ < 10) fxGlow(c, s.x, s.y, R * 1.2, 'rgba(255,110,40,' + (0.22 * fade) + ')', 1);
      for (var j = 0; j < 9; j++) {
        var ph = (t * 1.3 + j * 0.31) % 1, a = j * 2.399 + f.id;
        var rad = R * (0.15 + 0.8 * ((j * 7 % 10) / 10));
        c.fillStyle = 'rgba(255,' + (150 + ((j * 37) % 90)) + ',60,' + (0.5 * fade * (1 - ph)) + ')';
        c.beginPath();
        c.arc(s.x + Math.cos(a) * rad, s.y + Math.sin(a) * rad - ph * R * 0.5,
          Math.max(1, R * 0.16 * (1 - ph)), 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
      fxRing(c, s.x, s.y, R, 'rgba(255,140,60,' + (0.35 * fade) + ')', Math.max(1, R * 0.03), 1);
    } else {
      c.save();
      c.fillStyle = 'rgba(150,225,255,' + (0.14 * fade) + ')';
      c.beginPath(); c.arc(s.x, s.y, R, 0, Math.PI * 2); c.fill();
      c.restore();
      fxRing(c, s.x, s.y, R, 'rgba(200,245,255,' + (0.5 * fade) + ')', Math.max(1, R * 0.02), 1);
      // hairline cracks, so a sheet of ice reads as ice and not as a puddle
      c.save();
      c.strokeStyle = 'rgba(230,250,255,' + (0.35 * fade) + ')';
      c.lineWidth = Math.max(1, Math.min(2.5, R * 0.012));
      for (j = 0; j < 7; j++) {
        var ca = j * 2.399 + f.id * 0.7;
        c.beginPath();
        c.moveTo(s.x + Math.cos(ca) * R * 0.15, s.y + Math.sin(ca) * R * 0.15);
        c.lineTo(s.x + Math.cos(ca + 0.25) * R * 0.92, s.y + Math.sin(ca + 0.25) * R * 0.92);
        c.stroke();
      }
      c.restore();
    }
  }
}

// How each ability burst is painted. `m` is the shape of it, everything else is
// how loud: out, in, a line, or the barricade's ring of dropped traps.
var JR_BURST = {
  slam:      { m: 'out', k: 1.5, w: 0.09 },
  quake:     { m: 'out', k: 1.9, w: 0.14, n: 3 },
  overload:  { m: 'out', k: 2.4, w: 0.16, n: 3, hot: 1 },
  ignite:    { m: 'out', k: 1.5, w: 0.10, hot: 1 },
  shed:      { m: 'out', k: 1.7, w: 0.12, hot: 1 },
  freeze:    { m: 'out', k: 1.2, w: 0.09, dots: 14 },
  slick:     { m: 'out', k: 1.0, w: 0.06, dots: 18 },
  repel:     { m: 'out', k: 1.8, w: 0.11, dots: 12 },
  reap:      { m: 'in',  k: 1.3, w: 0.09 },
  pull:      { m: 'in',  k: 1.6, w: 0.10 },
  dilate:    { m: 'in',  k: 1.4, w: 0.07, dots: 12 },
  graft:     { m: 'in',  k: 1.2, w: 0.08, dots: 8 },
  raise:     { m: 'out', k: 1.2, w: 0.07, dots: 10 },
  bloom:     { m: 'out', k: 1.0, w: 0.06, dots: 8 },
  decoy:     { m: 'out', k: 1.4, w: 0.06, dots: 6 },
  rewind:    { m: 'in',  k: 1.8, w: 0.08, dots: 12 },
  harden:    { m: 'out', k: 1.0, w: 0.16 },
  deploy:    { m: 'out', k: 1.1, w: 0.12 },
  turrets:   { m: 'out', k: 1.3, w: 0.08, dots: 6 },
  mortar:    { m: 'out', k: 1.6, w: 0.10, hot: 1 },
  bubble:    { m: 'out', k: 1.0, w: 0.10, dots: 16 },
  shatter:   { m: 'out', k: 2.0, w: 0.10, dots: 4 },
  mark:      { m: 'out', k: 2.2, w: 0.05, dots: 16 },
  barricade: { m: 'trap' },
  swarm:     { m: 'line' },
  infest:    { m: 'line' },
  tether:    { m: 'line' },
  hijack:    { m: 'out', k: 1.4, w: 0.07, dots: 10 },
  blink:     { m: 'jump' }
};

MODE_FX.juggerroyale = {
  world: function (r, c, g, t) {
    var k = r.scaling(), i;
    if (typeof JR_BASE === 'undefined') return;

    jrPaintFields(r, c, g, t, k);

    // --- the hulls -------------------------------------------------------
    for (i = 0; i < g.entities.length; i++) {
      var e = g.entities[i];
      if (e.type !== 'tank' || e.dead || !e.def || e.def.jrAura === undefined) continue;
      if (e.opacity <= 0.02) continue;
      var s = r.toScreen(e.x, e.y), R = e.size * k;
      if (s.x < -R * 6 || s.y < -R * 6 || s.x > r.canvas.width + R * 6 || s.y > r.canvas.height + R * 6) continue;
      var tier = e.def.jrTier || 0;
      var A = e.def.jrTone, B = e.def.jrTone2;
      var paint = JR_AURA[e.def.jrAura] || JR_AURA.ring;
      c.save();
      c.globalAlpha = e.opacity;
      if (!e.jrIsDecoy) paint(c, s.x, s.y, R, A, B, t, e, tier);
      // a ready ability reads as a thin bright collar; a spent one does not
      if (e.jrCool !== undefined && g.tick >= e.jrCool && e.def.jrAbility)
        fxRing(c, s.x, s.y, R * 1.24, jrRGBA(A, 0.6), Math.max(1, R * 0.035), 1);
      jrPaintStatus(r, c, g, e, s.x, s.y, R, t);
      if (!e.jrIsDecoy) jrPaintLinks(r, c, g, e, s, R, t, k);
      c.restore();
    }

    // --- the bursts ------------------------------------------------------
    var list = g.jrFx || (g.fx && g.fx.jrFx) || [];
    for (i = 0; i < list.length; i++) {
      var fx = list[i], age = (g.tick - fx.at) / TPS;
      // Armageddon's verbs carry painters of their own, each with its own life.
      var ja = JA_BURST[fx.kind];
      if (ja) {
        if (age >= 0 && age <= ja.life) {
          c.save();
          ja.draw(r, c, g, fx, r.toScreen(fx.x, fx.y), age, 1 - age / ja.life, k, t);
          c.restore();
        }
        continue;
      }
      if (age < 0 || age > 1.1) continue;
      var spec = JR_BURST[fx.kind] || JR_BURST.slam;
      var fade = 1 - age / 1.1, tone = fx.tone || '255,255,255';
      var p = r.toScreen(fx.x, fx.y);

      if (spec.m === 'line') {
        var to = r.toScreen(fx.tx, fx.ty);
        c.save();
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = fade * 0.85;
        c.strokeStyle = 'rgb(' + tone + ')'; c.lineWidth = Math.max(2, 30 * k); c.lineCap = 'round';
        c.setLineDash([Math.max(6, 90 * k), Math.max(6, 70 * k)]);
        c.lineDashOffset = -age * 320 * k;
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(to.x, to.y); c.stroke();
        c.setLineDash([]);
        c.restore();
        fxRing(c, to.x, to.y, 220 * k * (0.3 + age), jrRGBA(tone, fade), Math.max(2, 22 * k), 1);

      } else if (spec.m === 'jump') {
        var t2 = r.toScreen(fx.tx, fx.ty);
        c.save();
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = fade;
        c.strokeStyle = jrRGBA(tone, 0.8); c.lineWidth = Math.max(1, 16 * k * fade); c.lineCap = 'round';
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(t2.x, t2.y); c.stroke();
        c.restore();
        fxRing(c, p.x, p.y, 90 * k * (1 + age * 2), jrRGBA(tone, fade * 0.8), Math.max(1, 10 * k), 1);
        fxRing(c, t2.x, t2.y, 130 * k * (1.4 - age), jrRGBA(tone, fade), Math.max(1, 12 * k), 1);

      } else if (spec.m === 'trap') {
        var rr = fx.r * k * (0.4 + age * 0.9);
        fxRing(c, p.x, p.y, rr, jrRGBA(tone, fade), Math.max(2, fx.r * k * 0.07), 1);
        jrDots(c, p.x, p.y, rr, 10, age * 0.6, Math.max(2, fx.r * k * 0.05), jrRGBA(tone, fade));

      } else {
        var grow = spec.m === 'in' ? (1.6 - age * 1.3) : (0.25 + age * spec.k);
        var R2 = fx.r * k * grow;
        var n = spec.n || 1;
        for (var q = 0; q < n; q++) {
          var off = q * 0.16;
          if (age < off) continue;
          fxRing(c, p.x, p.y, fx.r * k * (spec.m === 'in' ? grow + off : grow - off),
            jrRGBA(tone, fade * (1 - q * 0.28)), Math.max(2, fx.r * k * spec.w * fade), 1);
        }
        fxGlow(c, p.x, p.y, R2 * 0.9, jrRGBA(spec.hot ? '255,150,60' : tone, 0.5 * fade),
          JA_SOFT.dim ? jaCover(c, R2 * 0.9) : 1);
        if (spec.dots) jrDots(c, p.x, p.y, R2, spec.dots, age * (spec.m === 'in' ? -1.4 : 1.1),
          Math.max(1.5, fx.r * k * 0.045), jrRGBA(tone, fade));
      }
    }
    // Everything past the crowns drew its soft light into a quarter-res buffer.
    jaFlushSoft(c);
  },

  // Bottom-centre: what you are flying, what it does, and whether the button is
  // loaded. A hundred and forty hulls is too many to remember, so the mode says
  // — and past the fusions a hull is not one button any more, so the panel grows
  // a row of pips for the verbs firing themselves and a line for the traits.
  screen: function (r, c, g) {
    var p = g.player;
    if (!p || p.dead || !p.def || p.def.jrAura === undefined) return;
    if (!p.def.jrAbility) return;                 // the Brute has no button to report
    var w = r.canvas.width, h = r.canvas.height, i;
    var tone = p.def.jrTone, ready = g.tick >= (p.jrCool || 0);
    var left = Math.max(0, ((p.jrCool || 0) - g.tick) / TPS);
    var autos = p.def.jrAuto || [], traits = p.def.jrTraits || [];
    var extra = (autos.length ? 22 : 0) + (traits.length ? 15 : 0);
    // Wide enough for the pills: four fit in 320, ten (an Armageddon) do not.
    var bw = Math.max(320, autos.length * 66 + 20), bh = 46 + extra, bx = w / 2 - bw / 2, by = h - 108 - extra;

    c.save();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = 'rgba(0,0,0,0.58)';
    c.beginPath(); c.roundRect(bx, by, bw, bh, 8); c.fill();
    if (ready) {
      c.strokeStyle = jrRGBA(tone, 0.9); c.lineWidth = 2.5;
      c.beginPath(); c.roundRect(bx, by, bw, bh, 8); c.stroke();
    } else {
      c.fillStyle = jrRGBA(tone, 0.28);
      c.beginPath();
      c.roundRect(bx, by, bw * (1 - Math.min(1, left / 20)), 46, 8);
      c.fill();
    }
    c.font = 'bold 15px Ubuntu, Verdana, sans-serif';
    c.lineWidth = 3.5; c.lineJoin = 'round'; c.strokeStyle = 'rgba(0,0,0,0.75)';
    var line = (p.def.jrAbility || '—').toUpperCase() + (ready ? '  ·  RIGHT-CLICK' : '  ·  ' + left.toFixed(1) + 's');
    c.strokeText(line, w / 2, by + 16);
    c.fillStyle = ready ? 'rgb(' + tone + ')' : 'rgba(255,255,255,0.75)';
    c.fillText(line, w / 2, by + 16);
    c.font = '11px Ubuntu, Verdana, sans-serif';
    var sub = p.def.name + (p.def.jrPassive ? '  ·  ' + p.def.jrPassive : '');
    c.lineWidth = 3; c.strokeText(sub, w / 2, by + 34);
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.fillText(sub, w / 2, by + 34);

    // The autonomous verbs. One pill each, lit when loaded, and they are not
    // asking for a press — they are telling you what the hull is about to do.
    if (autos.length) {
      var pw = Math.min(76, (bw - 20) / autos.length - 5), y2 = by + 50;
      var x0 = w / 2 - (autos.length * (pw + 5) - 5) / 2;
      c.font = 'bold 9px Ubuntu, Verdana, sans-serif';
      for (i = 0; i < autos.length; i++) {
        var cd = (p.jrCools && p.jrCools[autos[i]]) || 0, up = g.tick >= cd;
        var px = x0 + i * (pw + 5);
        c.beginPath(); c.roundRect(px, y2, pw, 15, 4);
        c.fillStyle = up ? jrRGBA(tone, 0.55) : 'rgba(255,255,255,0.13)';
        c.fill();
        c.lineWidth = 2.4; c.strokeStyle = 'rgba(0,0,0,0.7)';
        c.strokeText(autos[i].toUpperCase(), px + pw / 2, y2 + 8);
        c.fillStyle = up ? '#FFF' : 'rgba(255,255,255,0.55)';
        c.fillText(autos[i].toUpperCase(), px + pw / 2, y2 + 8);
      }
    }
    if (traits.length) {
      c.font = '10px Ubuntu, Verdana, sans-serif';
      c.lineWidth = 2.6; c.strokeStyle = 'rgba(0,0,0,0.7)';
      var tl = traits.join(' · ');
      c.strokeText(tl, w / 2, by + bh - 10);
      c.fillStyle = jrRGBA(p.def.jrTone2 || tone, 0.95);
      c.fillText(tl, w / 2, by + bh - 10);
    }
    c.restore();
  }
};

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
      // Panels and a seam, so it reads as a ball rather than a big white circle.
      c.save();
      c.translate(b.x, b.y);
      c.rotate(g.ball.angle || 0);
      c.strokeStyle = 'rgba(60,60,70,0.55)';
      c.lineWidth = Math.max(1, br * 0.07);
      c.beginPath(); c.arc(0, 0, br * 0.62, 0, Math.PI * 2); c.stroke();
      for (var pnl = 0; pnl < 5; pnl++) {
        var pa = Math.PI * 2 * (pnl / 5);
        c.beginPath();
        c.moveTo(Math.cos(pa) * br * 0.62, Math.sin(pa) * br * 0.62);
        c.lineTo(Math.cos(pa) * br * 0.99, Math.sin(pa) * br * 0.99);
        c.stroke();
      }
      c.fillStyle = 'rgba(60,60,70,0.5)';
      fxPoly(c, 0, 0, br * 0.30, 5, -Math.PI / 2);
      c.fill();
      c.restore();
      for (var n = 0; n < 2; n++) {
        var ph = (t * 0.8 + n / 2) % 1;
        fxRing(c, b.x, b.y, br * (1 + ph * 1.1), 'rgba(255,255,255,' + (0.28 * (1 - ph)) + ')', Math.max(1, br * 0.06), 1);
      }
      fxPointer(r, c, g.ball.x, g.ball.y, '#FFFFFF', 'BALL');
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
    // The two-second grace, as a bar that empties. Without it you cannot tell
    // whether the rule is live yet, which is the whole tension of the mode.
    if (!green && fx.grace > 0) {
      var bw = 200, bx = cx - bw / 2, by = cy + R + 22;
      c.save();
      c.fillStyle = 'rgba(0,0,0,0.5)';
      c.fillRect(bx - 3, by - 3, bw + 6, 16);
      c.fillStyle = '#FFDE43';
      c.fillRect(bx, by, bw * fx.grace, 10);
      c.globalAlpha = 0.9;
      c.font = 'bold 12px Ubuntu, Verdana, sans-serif';
      c.textAlign = 'center'; c.fillStyle = '#FFF';
      c.fillText('STOP', cx, by + 28);
      c.restore();
    } else if (!green) {
      c.save();
      c.font = 'bold 15px Ubuntu, Verdana, sans-serif';
      c.textAlign = 'center';
      c.globalAlpha = 0.6 + 0.4 * Math.abs(Math.sin(t * 6));
      c.fillStyle = '#FF5A5A';
      c.fillText('DO NOT MOVE', cx, cy + R + 34);
      c.restore();
    }
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
  // The floor, drawn in world space under everything: a frozen sheet with
  // pressure cracks, so it reads as ice rather than as a blue filter.
  world: function (r, c, g, t) {
    var k = r.scaling(), w = r.canvas.width, h = r.canvas.height;
    // pale sheet with a slow sheen sliding across it
    var sheen = c.createLinearGradient(0, 0, w, h);
    var ph = (t * 0.05) % 1;
    sheen.addColorStop(Math.max(0, ph - 0.25), 'rgba(214,240,255,0)');
    sheen.addColorStop(ph, 'rgba(236,250,255,0.30)');
    sheen.addColorStop(Math.min(1, ph + 0.25), 'rgba(214,240,255,0)');
    c.save();
    c.fillStyle = 'rgba(206,234,250,0.42)';
    c.fillRect(0, 0, w, h);
    c.fillStyle = sheen;
    c.fillRect(0, 0, w, h);
    c.restore();

    // Cracks, anchored in world space so they slide past as you move rather
    // than swimming with the camera. Deterministic from the index, so the sheet
    // is the same sheet every frame.
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.5)';
    c.lineWidth = Math.max(1, 6 * k);
    c.lineCap = 'round';
    var span = g.arena.size;
    for (var i = 0; i < 42; i++) {
      var sx = (Math.sin(i * 12.9898) * 0.5 + 0.5) * span - span / 2;
      var sy = (Math.sin(i * 78.233) * 0.5 + 0.5) * span - span / 2;
      var p0 = r.toScreen(sx, sy);
      if (p0.x < -300 || p0.y < -300 || p0.x > w + 300 || p0.y > h + 300) continue;
      c.beginPath();
      c.moveTo(p0.x, p0.y);
      var a = i * 2.399, len = 260 + (i % 5) * 190;
      for (var seg = 0; seg < 3; seg++) {
        a += Math.sin(i + seg) * 0.9;
        sx += Math.cos(a) * len; sy += Math.sin(a) * len;
        var pn = r.toScreen(sx, sy);
        c.lineTo(pn.x, pn.y);
      }
      c.stroke();
    }
    c.restore();
  },
  screen: function (r, c, g) {
    var w = r.canvas.width, h = r.canvas.height, me = fxSelf(r);
    fxVignette(c, w, h, 0.42, 'rgba(180,225,255,0.30)');
    if (!me) return;
    var sp = Math.hypot(me.e.vx, me.e.vy);
    if (sp > 3) fxVignette(c, w, h, 0.2 + Math.min(0.35, sp / 40), 'rgba(255,255,255,' + Math.min(0.32, sp / 62) + ')');
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
    fxPointer(r, c, hl.x, hl.y, '#FFDE43', 'THE HILL');
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
    fxPointer(r, c, p.x, p.y, fx.hold === 'blue' ? '#00B2E1' : fx.hold === 'red' ? '#F14E54' : '#DDD', 'PAYLOAD');
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
    // the whole mode is "go there now", so it gets a pointer with a distance
    fxPointer(r, c, a.x, a.y, '#768DFC', 'ALPHA');
  }
};

MODE_FX.bountyking = {
  world: function (r, c, g, t) {
    var kg = g.fx && g.fx.king;
    if (!kg || kg.dead) return;
    fxPointer(r, c, kg.x, kg.y, '#FFDE43', 'THE KING');
    // The crown rides the INTERPOLATED position, not the raw one. Reading kg.x
    // directly steps at the 25 Hz sim rate while the tank under it is drawn
    // interpolated, which is exactly what "the crown jitters" looks like.
    var k = r.scaling(), ip = ipos(kg, r.alpha || 0), s = r.toScreen(ip.x, ip.y);
    var rad = ip.s * k * ROOT2;
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
  screen: function (r, c, g) {
    var n = g.fx && g.fx.lights;
    if (!n) return;
    var w = r.canvas.width, h = r.canvas.height;
    // Five lights, going out one at a time — the count you actually read.
    var R = 22, gap = 58, x0 = w / 2 - gap * 2, y = 110;
    for (var i = 0; i < 5; i++) {
      var on = i < Math.min(5, n);
      c.save();
      c.globalAlpha = 0.9;
      c.fillStyle = '#14161C';
      c.beginPath(); c.arc(x0 + i * gap, y, R + 6, 0, Math.PI * 2); c.fill();
      c.restore();
      if (on) fxGlow(c, x0 + i * gap, y, R * 2.2, 'rgba(255,60,60,0.5)', 1);
      c.save();
      c.fillStyle = on ? '#FF3B44' : '#2A2E36';
      c.beginPath(); c.arc(x0 + i * gap, y, R, 0, Math.PI * 2); c.fill();
      c.restore();
    }
  },
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
    fxPointer(r, c, bomb.x, bomb.y, '#FF6A3D', 'BOMB ' + Math.ceil(left) + 's');
  }
};

MODE_FX.bossrush = {
  world: function (r, c, g) {
    if (!g.waveLive) return;
    for (var i = 0; i < g.waveLive.length && i < 6; i++) {
      var e = g.waveLive[i];
      if (!e || e.dead) continue;
      fxPointer(r, c, e.x, e.y, '#FF8A3D', e.name || 'HOSTILE');
    }
  },
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
  var scene = c;
  c = fxDarkLayer(w, h);
  c.save();
  c.fillStyle = 'rgba(30,36,46,0.72)'; c.fillRect(0, 0, w, h);
  c.restore();
  for (var i = 0; i < 6; i++) {
    var x = ((i * 61 + t * (9 + i * 3)) % (w + 90)) - 45;
    var y = h * (0.2 + tRand(i) * 0.65);
    fxGlow(c, x, y, 40 + i * 7, 'rgba(200,208,220,0.13)', 1);
  }
  fxVignette(c, w, h, 0.6, 'rgba(12,16,24,0.85)');
  fxHole(c, w / 2, h / 2, w * 0.38, 0.22);
  scene.drawImage(c.canvas, 0, 0);
};

MODE_THUMB.nightfall = function (c, w, h, t) {
  var f = (Math.sin(t * 0.5) * 0.5 + 0.5);
  tBG(c, w, h, '#B8BCC4');
  tTank(c, w * 0.42, h * 0.6, 12, 0.3, BLUE[0], BLUE[1]);
  var scene = c;
  c = fxDarkLayer(w, h);
  var sky = c.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, 'rgba(' + Math.round(30 + (1 - f) * 90) + ',30,70,' + (0.35 + f * 0.5) + ')');
  sky.addColorStop(1, 'rgba(6,8,22,' + (0.45 + f * 0.5) + ')');
  c.save(); c.fillStyle = sky; c.fillRect(0, 0, w, h);
  c.restore();
  fxGlow(c, w * 0.8, h * 0.26, 34, 'rgba(190,215,255,0.4)', f);
  c.save(); c.globalAlpha = f; c.fillStyle = '#E9F1FF';
  c.beginPath(); c.arc(w * 0.8, h * 0.26, 9, 0, Math.PI * 2); c.fill(); c.restore();
  fxVignette(c, w, h, 0.45 + f * 0.3, 'rgba(2,4,14,0.85)');
  fxHole(c, w * 0.42, h * 0.6, w * (0.38 - f * 0.14), 0.26);
  scene.drawImage(c.canvas, 0, 0);
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

MODE_THUMB.juggerroyale = function (c, w, h, t) {
  tBG(c, w, h, '#9A9AA6');
  // Eleven branches around one fusion hull. Each spoke is drawn as the thing
  // that branch actually is — a hooded launcher, a flared hangar, a bare shell,
  // a halo, a flame, a shard — so the thumbnail says "eleven games" at a glance.
  var cx = w / 2, cy = h * 0.46, R = Math.min(w, h) * 0.33;
  var BR = [
    { tone: '150,220,140', fill: '#46543C', sides: 6,  kind: 'trap' },
    { tone: '205,140,255', fill: '#4A3556', sides: 8,  kind: 'drone' },
    { tone: '255,150,90',  fill: '#4A3A2E', sides: 14, kind: 'body' },
    { tone: '130,150,255', fill: '#2C3866', sides: 10, kind: 'halo' },
    { tone: '255,140,55',  fill: '#63301E', sides: 7,  kind: 'fire' },
    { tone: '150,225,255', fill: '#26566B', sides: 6,  kind: 'ice' },
    { tone: '255,80,105',  fill: '#5E2230', sides: 5,  kind: 'fang' },
    { tone: '150,255,230', fill: '#2F5257', sides: 9,  kind: 'ghost' },
    { tone: '255,220,120', fill: '#5F5220', sides: 12, kind: 'gear' },
    { tone: '190,205,225', fill: '#3A424E', sides: 4,  kind: 'frame' },
    { tone: '200,240,90',  fill: '#46561F', sides: 3,  kind: 'fang' }
  ];
  var i, b, a, x, y, rr = Math.max(5, R * 0.20);

  // spokes first, so the hulls sit on top of them
  c.save();
  c.strokeStyle = 'rgba(255,255,255,0.16)';
  c.lineWidth = Math.max(1, R * 0.02);
  for (i = 0; i < BR.length; i++) {
    a = Math.PI * 2 * (i / BR.length) - Math.PI / 2 + t * 0.06;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); c.stroke();
  }
  c.restore();

  for (i = 0; i < BR.length; i++) {
    var o = BR[i];
    a = Math.PI * 2 * (i / BR.length) - Math.PI / 2 + t * 0.06;
    x = cx + Math.cos(a) * R; y = cy + Math.sin(a) * R;
    fxGlow(c, x, y, rr * 2.4, 'rgba(' + o.tone + ',0.30)', 1);
    c.save();
    c.translate(x, y);
    c.rotate(a + t * 0.2);
    c.fillStyle = '#999'; c.strokeStyle = '#5A5A64'; c.lineWidth = 1.5;
    if (o.kind === 'trap') {
      for (b = 0; b < 4; b++) {
        c.save(); c.rotate(Math.PI / 2 * b);
        c.beginPath(); c.rect(0, -rr * 0.3, rr * 1.15, rr * 0.6); c.fill(); c.stroke();
        c.beginPath(); c.rect(rr * 1.15, -rr * 0.44, rr * 0.28, rr * 0.88); c.fill(); c.stroke();
        c.restore();
      }
    } else if (o.kind === 'drone') {
      for (b = 0; b < 2; b++) {
        c.save(); c.rotate(Math.PI + (b - 0.5) * 1.1);
        c.beginPath();
        c.moveTo(0, -rr * 0.3); c.lineTo(rr * 1.1, -rr * 0.58);
        c.lineTo(rr * 1.1, rr * 0.58); c.lineTo(0, rr * 0.3);
        c.closePath(); c.fill(); c.stroke();
        c.restore();
      }
    } else if (o.kind === 'body') {
      for (b = 0; b < 2; b++) {
        fxPoly(c, 0, 0, rr * (1.26 + b * 0.08), 6, t * (0.4 + b * 0.2));
        c.fillStyle = '#8E8E96'; c.fill(); c.strokeStyle = '#5A5A64'; c.stroke();
      }
    } else if (o.kind === 'halo') {
      c.strokeStyle = 'rgba(' + o.tone + ',0.85)'; c.lineWidth = Math.max(1, rr * 0.12);
      c.beginPath(); c.arc(0, 0, rr * 1.35, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(0, 0, rr * 1.02, 0, Math.PI * 2); c.stroke();
    } else if (o.kind === 'fire') {
      c.globalCompositeOperation = 'lighter';
      for (b = 0; b < 5; b++) {
        var fp = (t * 1.2 + b / 5) % 1, fa = b * 2.4;
        c.fillStyle = 'rgba(255,' + (150 + b * 18) + ',60,' + (0.8 * (1 - fp)) + ')';
        c.beginPath();
        c.arc(Math.cos(fa) * rr * (1 + fp), Math.sin(fa) * rr * (1 + fp) - fp * rr, rr * 0.3 * (1 - fp), 0, Math.PI * 2);
        c.fill();
      }
      c.globalCompositeOperation = 'source-over';
    } else if (o.kind === 'ice') {
      c.strokeStyle = 'rgba(' + o.tone + ',0.9)'; c.lineWidth = Math.max(1, rr * 0.14); c.lineCap = 'round';
      for (b = 0; b < 6; b++) {
        c.save(); c.rotate(Math.PI * 2 * (b / 6));
        c.beginPath(); c.moveTo(rr * 0.9, 0); c.lineTo(rr * 1.55, 0); c.stroke();
        c.restore();
      }
    } else if (o.kind === 'gear') {
      for (b = 0; b < 2; b++) {
        fxPoly(c, 0, 0, rr * 1.2, 8, b * Math.PI / 8 + t * (b ? -0.5 : 0.5));
        c.fillStyle = '#8E8E96'; c.fill(); c.strokeStyle = '#5A5A64'; c.stroke();
      }
    } else if (o.kind === 'frame') {
      for (b = 0; b < 2; b++) {
        fxPoly(c, 0, 0, rr * (1.3 - b * 0.16), 4, b * Math.PI / 4);
        c.fillStyle = '#8E8E96'; c.fill(); c.strokeStyle = '#5A5A64'; c.stroke();
      }
    } else if (o.kind === 'ghost') {
      c.globalAlpha = 0.4;
      tShape(c, rr * 0.7, rr * 0.5, rr * 0.9, o.sides, 0, o.fill, '#1E3236');
      c.globalAlpha = 1;
    } else {
      for (b = 0; b < 2; b++) {
        fxPoly(c, 0, 0, rr * 1.26, 3, b * Math.PI / 3 + t * (b ? -0.9 : 0.9));
        c.fillStyle = '#8E8E96'; c.fill(); c.strokeStyle = '#5A5A64'; c.stroke();
      }
    }
    tShape(c, 0, 0, rr, o.sides, 0, o.fill, '#20202A');
    c.restore();
  }

  // the fusion hull in the middle: two branches burning at once
  var cr = rr * 1.7;
  fxGlow(c, cx, cy, cr * 2.6, 'rgba(255,140,55,0.28)', 1);
  fxGlow(c, cx, cy, cr * 1.9, 'rgba(150,225,255,0.24)', 1);
  c.save();
  for (b = 0; b < 10; b++) {
    var ba = Math.PI * 2 * (b / 10) + t * 0.3;
    c.beginPath();
    c.moveTo(cx + Math.cos(ba - 0.3) * cr, cy + Math.sin(ba - 0.3) * cr);
    c.lineTo(cx + Math.cos(ba) * cr * 1.42, cy + Math.sin(ba) * cr * 1.42);
    c.lineTo(cx + Math.cos(ba + 0.3) * cr, cy + Math.sin(ba + 0.3) * cr);
    c.closePath();
    c.fillStyle = 'rgba(255,180,120,0.55)'; c.fill();
  }
  c.restore();
  tShape(c, cx, cy, cr, 13, t * 0.1, '#5A2E63', '#2A1430');
  fxRing(c, cx, cy, cr * 1.1, 'rgba(255,255,255,0.6)', 2, 1);

  tText(c, w / 2, h - 13, '140 HULLS  ·  11 BRANCHES  ·  8 DYNASTIES', 10, '#DCE6F5');
};

// Last Juggernaut is the Royale seen from one hull, so it is drawn by the
// Royale: the auras, the fields and the ability card all read the def and the
// player rather than the mode key.
MODE_FX.lastjugg = MODE_FX.juggerroyale;

// Juggernaut's ring of hunters around Royale's growing hull. The hull steps up a
// tier on a loop and the level runs with it, because what the mode is about is
// that neither of them ever resets.
MODE_THUMB.lastjugg = function (c, w, h, t) {
  tBG(c, w, h, '#9A9AA6');
  var cx = w / 2, cy = h * 0.46, i;
  var step = Math.floor((t * 0.5) % 5);
  var R = Math.min(w, h) * (0.10 + step * 0.035);
  for (i = 0; i < 7; i++) {
    var a = Math.PI * 2 * (i / 7) + t * 0.45, d = Math.min(w, h) * 0.4;
    tTank(c, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 8, a + Math.PI, BLUE[0], BLUE[1]);
  }
  fxGlow(c, cx, cy, R * 2.4, 'rgba(255,140,55,0.30)', 1);
  fxGlow(c, cx, cy, R * 1.7, 'rgba(150,150,255,0.22)', 1);
  tShape(c, cx, cy, R, 12 + step * 2, t * 0.12, '#2B2B33', '#16161B');
  fxRing(c, cx, cy, R * 1.5, 'rgba(255,90,90,0.45)', 2, 1);
  tText(c, cx, cy - R - 12, 'LVL ' + (45 + step * 39), 11, '#FFD9A0');
  tText(c, w / 2, h - 13, 'IT NEVER CHANGES HANDS', 11, '#FFC0C4');
};

// =========================================================================
// Juggernaut Armageddon
// =========================================================================
//
// The Royale's painters still draw every hull up to the crowns. Everything here
// is what comes after: five auras, each one the aura below it with another layer
// bolted on the outside, so a tier is legible from how much of the screen it
// lights; the ground and links the new verbs leave; a burst painter per verb;
// and a screen layer that flashes, desaturates and shakes when the arena is
// being unmade near you.

function jaHash(i) { var s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

// Lightning from one point to another: a jagged line whose kinks re-roll every
// time the seed changes, a wide soft pass in the caster's colour under a thin
// white core.
function jaBolt(c, x1, y1, x2, y2, seed, w, tone, alpha) {
  var dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  var nx = -dy / len, ny = dx / len, n = Math.max(4, Math.min(14, Math.round(len / 40)));
  var pts = [x1, y1], i;
  for (i = 1; i < n; i++) {
    var f = i / n, j = (jaHash(seed * 31 + i) - 0.5) * len * 0.22 * Math.sin(f * Math.PI);
    pts.push(x1 + dx * f + nx * j, y1 + dy * f + ny * j);
  }
  pts.push(x2, y2);
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (var pass = 0; pass < 2; pass++) {
    c.globalAlpha = (alpha === undefined ? 1 : alpha) * (pass ? 0.95 : 0.5);
    c.strokeStyle = pass ? 'rgba(255,255,255,0.95)' : jrRGBA(tone || '200,220,255', 0.9);
    c.lineWidth = Math.max(1, pass ? w * 0.35 : w);
    c.beginPath(); c.moveTo(pts[0], pts[1]);
    for (i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    c.stroke();
  }
  c.restore();
}

// A star of n points between two radii.
function jaStar(c, x, y, r0, r1, n, rot) {
  c.beginPath();
  for (var i = 0; i < n * 2; i++) {
    var a = rot + Math.PI * i / n, rr = i % 2 ? r1 : r0;
    var px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.closePath();
}

// God rays: n wedges of light from r0 out toward r1, each breathing in length.
function jaRays(c, x, y, r0, r1, n, rot, tone, alpha, t, width) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  var wd = width || 0.06;
  for (var i = 0; i < n; i++) {
    var a = rot + Math.PI * 2 * (i / n), fl = 0.72 + 0.28 * Math.sin(t * 4.3 + i * 1.7);
    var len = r0 + (r1 - r0) * fl;
    var gr = c.createLinearGradient(x + Math.cos(a) * r0, y + Math.sin(a) * r0, x + Math.cos(a) * len, y + Math.sin(a) * len);
    gr.addColorStop(0, jrRGBA(tone, alpha));
    gr.addColorStop(1, jrRGBA(tone, 0));
    c.fillStyle = gr;
    c.beginPath();
    c.moveTo(x + Math.cos(a - wd) * r0, y + Math.sin(a - wd) * r0);
    c.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    c.lineTo(x + Math.cos(a + wd) * r0, y + Math.sin(a + wd) * r0);
    c.closePath(); c.fill();
  }
  c.restore();
}

// Sparks lifting off a hull and burning out.
function jaSparks(c, x, y, R, tone, t, n, reach) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (var i = 0; i < n; i++) {
    var ph = (t * (0.35 + jaHash(i) * 0.3) + jaHash(i + 50)) % 1;
    var a = jaHash(i + 9) * Math.PI * 2 + t * 0.05, d = R * (1.1 + ph * reach);
    c.fillStyle = jrRGBA(ph < 0.3 ? '255,255,255' : tone, 0.85 * (1 - ph));
    c.beginPath();
    c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d - ph * R * 0.8, Math.max(1, R * 0.05 * (1 - ph)), 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

// The dark a top-tier hull is lit against: an annulus from just outside the
// shell outward, so the arena around it dims and the hull itself does not.
function jaDark(c, x, y, r0, r1, alpha) {
  var gr = c.createRadialGradient(x, y, r0, x, y, r1);
  gr.addColorStop(0, 'rgba(8,4,16,' + alpha + ')');
  gr.addColorStop(0.5, 'rgba(8,4,16,' + alpha * 0.45 + ')');
  gr.addColorStop(1, 'rgba(8,4,16,0)');
  c.save();
  c.fillStyle = gr;
  c.beginPath(); c.arc(x, y, r1, 0, Math.PI * 2); c.arc(x, y, r0, 0, Math.PI * 2, true); c.fill('evenodd');
  c.restore();
}

// --- the soft layer -----------------------------------------------------------
// Every glow, god-ray and darkening up here covers most of the screen, and on a
// rasterised canvas that is what a frame pays for: measured, each full-screen
// gradient cost 2-3 ms, and the Armageddon stacked ten of them for 33 ms of aura
// alone. So they are drawn into two quarter-resolution buffers — one additive,
// one darkening — and laid over the arena once at the end of the world layer.
// A soft gradient upscaled is still a soft gradient, and the cost no longer
// grows with how many of them there are.
var JA_SOFT = { k: 0.25, light: null, dark: null, usedL: false, usedD: false, dim: false };

// How much of a burst's glow survives, given how much of the screen it covers.
// A glow wider than the screen is not a glow any more, it is the screen turning
// white; past that point it fades in proportion, and the rings and rays — which
// are what the burst actually looks like — are left alone.
function jaCover(c, R) {
  var diag = Math.hypot(c.canvas.width, c.canvas.height);
  return Math.min(1, diag * 0.8 / Math.max(1, R));
}

function jaSoftCtx(kind, w, h) {
  if (typeof document === 'undefined') return null;
  var S = JA_SOFT, bw = Math.max(2, Math.ceil(w * S.k)), bh = Math.max(2, Math.ceil(h * S.k));
  if (!S.light) { S.light = document.createElement('canvas'); S.dark = document.createElement('canvas'); }
  if (S.light.width !== bw || S.light.height !== bh) {
    S.light.width = S.dark.width = bw; S.light.height = S.dark.height = bh;
    S.usedL = S.usedD = false;
  }
  var dark = kind === 'dark', bc = (dark ? S.dark : S.light).getContext('2d');
  if (!bc) return null;
  if (dark ? !S.usedD : !S.usedL) {
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalAlpha = 1;
    bc.globalCompositeOperation = 'source-over';
    bc.clearRect(0, 0, bw, bh);
    if (dark) S.usedD = true; else S.usedL = true;
  }
  bc.globalCompositeOperation = dark ? 'source-over' : 'lighter';
  return bc;
}

// fxGlow, into the additive buffer. Respects the hull's own opacity.
function jaGlow(c, x, y, r, color, alpha) {
  var bc = jaSoftCtx('light', c.canvas.width, c.canvas.height);
  if (!bc) return fxGlow(c, x, y, r, color, alpha);
  var k = JA_SOFT.k, rr = Math.max(1, r * k);
  var gr = bc.createRadialGradient(x * k, y * k, 0, x * k, y * k, rr);
  gr.addColorStop(0, color);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  bc.globalAlpha = (alpha === undefined ? 1 : alpha) * (c.globalAlpha === undefined ? 1 : c.globalAlpha);
  bc.fillStyle = gr;
  bc.beginPath(); bc.arc(x * k, y * k, rr, 0, Math.PI * 2); bc.fill();
  bc.globalAlpha = 1;
}

// jaRays, into the additive buffer.
function jaSoftRays(c, x, y, r0, r1, n, rot, tone, alpha, t, width) {
  var bc = jaSoftCtx('light', c.canvas.width, c.canvas.height), k = JA_SOFT.k;
  if (!bc) return jaRays(c, x, y, r0, r1, n, rot, tone, alpha, t, width);
  bc.globalAlpha = c.globalAlpha === undefined ? 1 : c.globalAlpha;
  jaRays(bc, x * k, y * k, r0 * k, r1 * k, n, rot, tone, alpha, t, width);
  bc.globalAlpha = 1;
}

// jaDark, into the darkening buffer.
function jaSoftDark(c, x, y, r0, r1, alpha) {
  var bc = jaSoftCtx('dark', c.canvas.width, c.canvas.height), k = JA_SOFT.k;
  if (!bc) return jaDark(c, x, y, r0, r1, alpha);
  jaDark(bc, x * k, y * k, r0 * k, r1 * k, alpha * (c.globalAlpha === undefined ? 1 : c.globalAlpha));
}

// Lay both buffers over the arena and empty them. Called once, at the end of
// the world layer, and a no-op on any frame nothing past the crowns drew.
function jaFlushSoft(c) {
  var S = JA_SOFT;
  if (!S.usedL && !S.usedD) return;
  var w = c.canvas.width, h = c.canvas.height;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.imageSmoothingEnabled = true;
  if (S.usedD) { c.globalCompositeOperation = 'source-over'; c.drawImage(S.dark, 0, 0, w, h); }
  // 'screen' rather than 'lighter': it brightens toward white without ever
  // reaching it, which on diep's light floor is the difference between light
  // and a white-out once three verbs land on the same frame.
  if (S.usedL) { c.globalCompositeOperation = 'screen'; c.drawImage(S.light, 0, 0, w, h); }
  c.restore();
  S.usedL = S.usedD = false;
}

// The crown's own layers with its glows moved into the soft buffer: the base
// every aura past it is built on.
function jaCrown(c, x, y, R, A, B, t) {
  jaGlow(c, x, y, R * 4.2, jrRGBA(A, 0.2), 1);
  jaGlow(c, x, y, R * 2.6, jrRGBA(B, 0.24), 1);
  jrBarbs(c, x, y, R * 1.22, 16, t * 0.18, R * 0.34, jrRGBA(A, 0.6), jrRGBA(A, 1), Math.max(1, R * 0.018));
  jrBarbs(c, x, y, R * 1.9, 10, -t * 0.12, R * 0.26, jrRGBA(B, 0.45), jrRGBA(B, 0.9), Math.max(1, R * 0.015));
  fxRing(c, x, y, R * 2.5, jrRGBA(A, 0.55), Math.max(1.5, R * 0.03), 1);
  fxRing(c, x, y, R * 2.62, jrRGBA(B, 0.35), Math.max(1, R * 0.016), 1);
  jrDots(c, x, y, R * 2.56, 24, -t * 0.07, Math.max(1.5, R * 0.045), jrRGBA('255,255,255', 0.8));
  for (var i = 0; i < 4; i++) {
    var ph = (t * 0.35 + i / 4) % 1;
    fxRing(c, x, y, R * (1.15 + ph * 1.9), jrRGBA(i % 2 ? B : A, 0.42 * (1 - ph)), Math.max(1, R * 0.06 * (1 - ph)), 1);
  }
  jaGlow(c, x, y, R * 1.05, 'rgba(255,255,255,' + (0.26 + 0.1 * Math.sin(t * 2.4)) + ')', 1);
}

// TIER 9: the crown with a sunburst behind it, an eight-point star turning over
// the top, and sparks coming off it all the time.
JR_AURA.ascendant = function (c, x, y, R, A, B, t, e, tier) {
  B = B || A;
  jaSoftRays(c, x, y, R * 1.1, R * 4.6, 12, t * 0.12, A, 0.3, t, 0.07);
  jaCrown(c, x, y, R, A, B, t);
  c.save();
  c.strokeStyle = jrRGBA(B, 0.75); c.lineWidth = Math.max(1.5, R * 0.025);
  jaStar(c, x, y, R * 2.95, R * 2.35, 8, -t * 0.1); c.stroke();
  c.restore();
  jaSparks(c, x, y, R, A, t, 12, 2.6);
};

// TIER 10: four wings of light that beat slowly, runes on an orbit, and
// lightning hopping around the outer ring.
JR_AURA.archon = function (c, x, y, R, A, B, t, e, tier) {
  B = B || A;
  JR_AURA.ascendant(c, x, y, R, A, B, t, e, tier);
  var beat = 0.5 + 0.5 * Math.sin(t * 1.6), i;
  c.save();
  c.globalCompositeOperation = 'lighter';
  // One path per colour rather than a fill per feather.
  for (var col = 0; col < 2; col++) {
    c.beginPath();
    for (var wi = 0; wi < 4; wi++) {
      var wa = Math.PI / 4 + Math.PI / 2 * wi + Math.sin(t * 1.4 + wi) * 0.08;
      for (var f = col; f < 7; f += 2) {
        var fa = wa + (f - 3) * 0.11 * (1 + beat * 0.4);
        var fl = R * (2.3 + (3 - Math.abs(f - 3)) * 0.35) * (0.9 + beat * 0.15);
        c.moveTo(x + Math.cos(fa - 0.05) * R * 1.3, y + Math.sin(fa - 0.05) * R * 1.3);
        c.lineTo(x + Math.cos(fa) * fl, y + Math.sin(fa) * fl);
        c.lineTo(x + Math.cos(fa + 0.05) * R * 1.3, y + Math.sin(fa + 0.05) * R * 1.3);
        c.closePath();
      }
    }
    c.fillStyle = jrRGBA(col ? A : B, 0.2);
    c.fill();
  }
  c.restore();
  c.save();
  c.strokeStyle = jrRGBA(A, 0.85); c.lineWidth = Math.max(1.2, R * 0.022);
  c.beginPath();
  for (i = 0; i < 6; i++) {
    var ra = t * 0.4 + i * Math.PI / 3, rx = x + Math.cos(ra) * R * 3.15, ry = y + Math.sin(ra) * R * 3.15;
    var sides = 3 + (i % 3), rot = -t * 0.9 + i;
    for (var s = 0; s <= sides; s++) {
      var sa = rot + Math.PI * 2 * (s / sides);
      if (s) c.lineTo(rx + Math.cos(sa) * R * 0.17, ry + Math.sin(sa) * R * 0.17);
      else c.moveTo(rx + Math.cos(sa) * R * 0.17, ry + Math.sin(sa) * R * 0.17);
    }
  }
  c.stroke();
  c.restore();
  var q = Math.floor(t * 9);
  for (i = 0; i < 3; i++) {
    var a0 = jaHash(q * 7 + i) * Math.PI * 2, a1 = a0 + 0.6 + jaHash(q * 13 + i) * 0.8;
    jaBolt(c, x + Math.cos(a0) * R * 2.5, y + Math.sin(a0) * R * 2.5,
      x + Math.cos(a1) * R * 2.5, y + Math.sin(a1) * R * 2.5, q * 3 + i, Math.max(1.5, R * 0.05), B, 0.8);
  }
};

// TIER 11: two dynasties' light chasing each other round the hull, two
// twelve-point stars turning against each other, and two planets on an orbit.
JR_AURA.primordial = function (c, x, y, R, A, B, t, e, tier) {
  B = B || A;
  var i, k;
  jaGlow(c, x, y, R * 5.2, jrRGBA(A, 0.16), 1);
  jaGlow(c, x + Math.cos(t * 0.7) * R * 0.9, y + Math.sin(t * 0.7) * R * 0.9, R * 3.6, jrRGBA(A, 0.2), 1);
  jaGlow(c, x - Math.cos(t * 0.7) * R * 0.9, y - Math.sin(t * 0.7) * R * 0.9, R * 3.6, jrRGBA(B, 0.2), 1);
  JR_AURA.archon(c, x, y, R, A, B, t, e, tier);
  c.save();
  c.lineWidth = Math.max(1.5, R * 0.03);
  c.strokeStyle = jrRGBA(A, 0.8); jaStar(c, x, y, R * 3.55, R * 2.85, 12, t * 0.15); c.stroke();
  c.strokeStyle = jrRGBA(B, 0.8); jaStar(c, x, y, R * 3.55, R * 2.85, 12, -t * 0.15 + Math.PI / 12); c.stroke();
  c.restore();
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (i = 0; i < 2; i++) {
    var pa = t * 0.9 + i * Math.PI;
    for (k = 0; k < 6; k++) {
      var ta = pa - k * 0.11;
      c.fillStyle = jrRGBA(i ? B : A, 0.55 * (1 - k / 6));
      c.beginPath();
      c.arc(x + Math.cos(ta) * R * 3.95, y + Math.sin(ta) * R * 3.95, Math.max(1, R * 0.2 * (1 - k / 8)), 0, Math.PI * 2);
      c.fill();
    }
    jaGlow(c, x + Math.cos(pa) * R * 3.95, y + Math.sin(pa) * R * 3.95, R * 0.7, jrRGBA(i ? B : A, 0.8), 1);
  }
  c.restore();
  var q = Math.floor(t * 10);
  for (i = 0; i < 6; i++) {
    var b0 = Math.PI * 2 * (i / 6) + t * 0.15, b1 = b0 + Math.PI / 6 + (jaHash(q + i) - 0.5) * 0.4;
    jaBolt(c, x + Math.cos(b0) * R * 3.55, y + Math.sin(b0) * R * 3.55,
      x + Math.cos(b1) * R * 3.55, y + Math.sin(b1) * R * 3.55, q * 6 + i, Math.max(1.5, R * 0.045), i % 2 ? B : A, 0.7);
  }
};

// TIER 12: the arena dims around it, two dozen rays reach past the edge of the
// light, a halo of forty-eight stars, and shock rings that never stop leaving.
JR_AURA.eschaton = function (c, x, y, R, A, B, t, e, tier) {
  B = B || A;
  if (tier < 13) jaSoftDark(c, x, y, R * 1.15, R * 7.5, 0.42);
  jaSoftRays(c, x, y, R * 1.2, R * 7, 24, t * 0.06, A, 0.32, t, 0.04);
  JR_AURA.primordial(c, x, y, R, A, B, t, e, tier);
  jrDots(c, x, y, R * 4.5, 48, t * 0.05, Math.max(1.5, R * 0.04), jrRGBA('255,255,255', 0.85));
  fxRing(c, x, y, R * 4.5, jrRGBA(A, 0.6), Math.max(1.5, R * 0.03), 1);
  fxRing(c, x, y, R * 4.68, jrRGBA(B, 0.4), Math.max(1, R * 0.018), 1);
  for (var i = 0; i < 3; i++) {
    var ph = (t * 0.3 + i / 3) % 1;
    fxRing(c, x, y, R * (2 + ph * 5), jrRGBA(i % 2 ? B : A, 0.5 * (1 - ph)), Math.max(2, R * 0.08 * (1 - ph)), 1);
  }
};

// TIER 13: a black sun. The dark goes further, the corona burns white and red,
// a sigil turns in the middle of it, lightning comes off the shell twelve times
// a second, and a red heartbeat runs out to the edge of the light.
JR_AURA.armageddon = function (c, x, y, R, A, B, t, e, tier) {
  B = B || A;
  var i;
  jaSoftDark(c, x, y, R * 1.1, R * 10, 0.55);
  jaSoftRays(c, x, y, R * 1.05, R * 9, 36, t * 0.05, B, 0.34, t, 0.035);
  jaSoftRays(c, x, y, R * 1.05, R * 5.8, 24, -t * 0.08, '255,255,255', 0.36, t * 1.3, 0.05);
  JR_AURA.eschaton(c, x, y, R, A, B, t, e, tier);
  c.save();
  c.lineWidth = Math.max(2, R * 0.035);
  c.strokeStyle = jrRGBA(B, 0.85); jaStar(c, x, y, R * 5.2, R * 4.1, 24, -t * 0.07); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.7)'; jaStar(c, x, y, R * 1.95, R * 1.45, 12, t * 0.3); c.stroke();
  c.restore();
  fxRing(c, x, y, R * 1.95, jrRGBA(B, 0.7), Math.max(1.5, R * 0.03), 1);
  var q = Math.floor(t * 12);
  for (i = 0; i < 8; i++) {
    var a = jaHash(q * 11 + i) * Math.PI * 2, l = R * (2.5 + jaHash(q * 5 + i) * 4.5);
    var a2 = a + (jaHash(i + q * 3) - 0.5) * 0.6;
    jaBolt(c, x + Math.cos(a) * R, y + Math.sin(a) * R, x + Math.cos(a2) * l, y + Math.sin(a2) * l,
      q * 8 + i, Math.max(2, R * 0.06), i % 3 ? B : A, 0.9);
  }
  var hb = (t / 1.4) % 1;
  fxRing(c, x, y, R * (1.2 + hb * 8.5), jrRGBA(B, 0.7 * (1 - hb)), Math.max(3, R * 0.14 * (1 - hb)), 1);
  jaSparks(c, x, y, R, B, t * 1.4, 18, 5);
  // A black sun has no white core: the light is the corona round the rim.
  fxRing(c, x, y, R * 1.08, 'rgba(255,240,220,' + (0.75 + 0.2 * Math.sin(t * 7)) + ')', Math.max(2, R * 0.05), 1);
  jaGlow(c, x, y, R * 1.7, jrRGBA(B, 0.35 + 0.1 * Math.sin(t * 7)), 1);
};

// --- the ground and the links ---------------------------------------------

// A BLACK HOLE on the floor: a core with no light in it, spiral arms of hot gas
// falling in, motes going with them, and the bright thin ring at the edge.
function jaPaintWell(r, c, g, f, s, R, t, fade) {
  var tone = (f.jrBy && f.jrBy.def && f.jrBy.def.jrTone) || '190,160,255', j;
  var gr = c.createRadialGradient(s.x, s.y, 0, s.x, s.y, R * 2.6);
  gr.addColorStop(0, 'rgba(0,0,0,' + 0.96 * fade + ')');
  gr.addColorStop(0.14, 'rgba(0,0,0,' + 0.92 * fade + ')');
  gr.addColorStop(0.42, 'rgba(10,6,24,' + 0.45 * fade + ')');
  gr.addColorStop(1, 'rgba(10,6,24,0)');
  c.save();
  c.fillStyle = gr; c.beginPath(); c.arc(s.x, s.y, R * 2.6, 0, Math.PI * 2); c.fill();
  c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
  for (var arm = 0; arm < 4; arm++) {
    c.strokeStyle = jrRGBA(arm % 2 ? tone : '255,200,140', 0.5 * fade);
    c.lineWidth = Math.max(1.5, R * 0.06);
    c.beginPath();
    for (j = 0; j <= 24; j++) {
      var u = j / 24, rr = R * (0.36 + u * 2.2), a = t * 2.4 + arm * Math.PI / 2 + u * 3.6;
      if (j) c.lineTo(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr);
      else c.moveTo(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr);
    }
    c.stroke();
  }
  for (j = 0; j < 18; j++) {
    var ph = (t * 0.8 + j / 18) % 1, ma = j * 2.399 + ph * 4, md = R * 2.6 * (1 - ph) + R * 0.3;
    c.fillStyle = jrRGBA(tone, 0.8 * fade * ph);
    c.beginPath(); c.arc(s.x + Math.cos(ma) * md, s.y + Math.sin(ma) * md, Math.max(1, R * 0.05), 0, Math.PI * 2); c.fill();
  }
  c.restore();
  fxRing(c, s.x, s.y, R * 0.36, 'rgba(255,232,200,' + 0.9 * fade + ')', Math.max(1.5, R * 0.04), 1);
}

// What a hull past the crowns is holding: its godray, its blades, the lift
// under anything it has raptured, and the deaths it has left to refuse.
function jaPaintLinks(r, c, g, e, s, R, t, k) {
  var i;
  if (e.jaRay && g.tick < e.jaRay) {
    var a = e.jaRayA === undefined ? e.angle : e.jaRayA, len = (9000 + e.size * 4) * k;
    var ex = s.x + Math.cos(a) * len, ey = s.y + Math.sin(a) * len;
    var gr = c.createLinearGradient(s.x, s.y, ex, ey);
    gr.addColorStop(0, 'rgba(255,255,240,0.8)');
    gr.addColorStop(0.4, jrRGBA(e.def.jrTone2 || e.def.jrTone, 0.5));
    gr.addColorStop(1, jrRGBA(e.def.jrTone2 || e.def.jrTone, 0));
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    c.strokeStyle = gr; c.lineWidth = R * (0.75 + 0.2 * Math.sin(t * 26));
    c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(ex, ey); c.stroke();
    c.lineWidth = R * 0.2; c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(ex, ey); c.stroke();
    c.restore();
    var q = Math.floor(t * 14);
    for (i = 0; i < 3; i++) {
      var f0 = jaHash(q + i * 5) * 0.8, f1 = f0 + 0.08 + jaHash(q * 3 + i) * 0.15;
      jaBolt(c, s.x + (ex - s.x) * f0, s.y + (ey - s.y) * f0, s.x + (ex - s.x) * f1, s.y + (ey - s.y) * f1,
        q * 3 + i, Math.max(2, R * 0.12), e.def.jrTone, 0.8);
    }
    jaGlow(c, s.x, s.y, R * 1.6, 'rgba(255,250,230,0.4)', jaCover(c, R * 1.6));
  }
  if (e.jaBlades && e.jaBlades.length) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = jrRGBA(e.def.jrTone, 0.35); c.lineWidth = Math.max(2, R * 0.12); c.lineCap = 'round';
    for (i = 0; i < e.jaBlades.length; i++) {
      var bl = e.jaBlades[i];
      if (!bl || bl.dead || bl.jrPhase === undefined) continue;
      c.beginPath(); c.arc(s.x, s.y, R * 2.7, bl.jrPhase - 0.55, bl.jrPhase); c.stroke();
      var bp = r.toScreen(bl.x, bl.y);
      fxGlow(c, bp.x, bp.y, bl.size * k * 2.2, jrRGBA(e.def.jrTone2 || e.def.jrTone, 0.5), 1);
    }
    c.restore();
  }
  if (e.jaLift && g.tick - e.jaLift < 1.6 * TPS) {
    var lf = (g.tick - e.jaLift) / (1.6 * TPS);
    var col = c.createLinearGradient(s.x, s.y, s.x, s.y - R * 9);
    col.addColorStop(0, 'rgba(255,250,220,' + 0.55 * (1 - lf * 0.5) + ')');
    col.addColorStop(1, 'rgba(255,250,220,0)');
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = col;
    c.fillRect(s.x - R * 0.9, s.y - R * 9, R * 1.8, R * 9);
    c.restore();
    fxRing(c, s.x, s.y, R * (1.3 + lf * 0.6), 'rgba(255,250,220,0.7)', Math.max(1.5, R * 0.06), 1);
  }
  // IMMORTAL: three pips over the hull, one going dark for each death refused.
  if (e.def.jrTraits && e.def.jrTraits.indexOf('immortal') >= 0) {
    var left = 3 - (e.jaRefused || 0);
    for (i = 0; i < 3; i++) {
      var px = s.x + (i - 1) * R * 0.32, py = s.y - R * 1.55;
      c.save();
      c.beginPath(); c.arc(px, py, Math.max(2, R * 0.09), 0, Math.PI * 2);
      c.fillStyle = i < left ? jrRGBA(e.def.jrTone2 || e.def.jrTone, 0.95) : 'rgba(0,0,0,0.45)';
      c.fill();
      c.lineWidth = Math.max(1, R * 0.02); c.strokeStyle = 'rgba(255,255,255,0.7)'; c.stroke();
      c.restore();
    }
  }
}

// TIME STOP's bullets, hanging in the air with frost on them.
function jaPaintFrozen(r, c, g, t, k) {
  if (!g.jaFrozen || !g.jaFrozen.length) return;
  c.save();
  c.strokeStyle = 'rgba(200,235,255,0.75)';
  for (var i = 0; i < g.jaFrozen.length; i++) {
    var e = g.jaFrozen[i];
    if (e.dead) continue;
    var s = r.toScreen(e.x, e.y), R = Math.max(3, e.size * k);
    c.lineWidth = Math.max(1, R * 0.14);
    fxPoly(c, s.x, s.y, R * 1.45, 6, t * 0.3 + e.id); c.stroke();
  }
  c.restore();
}

// --- the bursts -------------------------------------------------------------
// One painter per verb, each with how long it lasts. The Royale's burst loop
// hands any kind it finds in here to this table instead of its own.
var JA_BURST = {
  supernova: { life: 1.4, draw: function (r, c, g, fx, p, age, fade, k, t) {
    var R = fx.r * k, A = fx.tone || '255,255,255', B = fx.tone2 || A, grow = 0.12 + age * 0.9;
    jaGlow(c, p.x, p.y, R * grow * 0.45, 'rgba(255,255,255,' + 0.3 * fade * fade + ')', jaCover(c, R * grow * 0.45));
    for (var i = 0; i < 3; i++) {
      var off = i * 0.12;
      if (age < off) continue;
      fxRing(c, p.x, p.y, R * (grow - off * 0.8), jrRGBA(i % 2 ? B : A, fade * (1 - i * 0.22)), Math.max(3, Math.min(36, R * 0.05) * fade), 1);
    }
    // Three waves and an echo put six of these on screen at once, so each one is faint.
    jaSoftRays(c, p.x, p.y, R * grow * 0.2, R * grow, 12, age * 0.6, A, 0.12 * fade * jaCover(c, R * grow * 0.5), t, 0.05);
  } },

  overdrive: { life: 1.2, draw: function (r, c, g, fx, p, age, fade, k, t) {
    var R = fx.r * k, A = fx.tone || '255,255,255', B = fx.tone2 || A;
    c.save();
    c.lineWidth = Math.max(2, R * 0.04 * fade);
    c.strokeStyle = jrRGBA(A, fade); jaStar(c, p.x, p.y, R * (0.3 + age * 1.1), R * (0.2 + age * 0.8), 16, age * 2); c.stroke();
    c.strokeStyle = jrRGBA(B, fade); jaStar(c, p.x, p.y, R * (0.25 + age * 0.9), R * (0.16 + age * 0.6), 16, -age * 2); c.stroke();
    c.restore();
    jaSoftRays(c, p.x, p.y, R * 0.2, R * (0.5 + age * 1.2), 16, age, B, 0.18 * fade * jaCover(c, R * (0.5 + age * 1.2)), t, 0.04);
  } },

  blackhole: { life: 1.0, draw: function (r, c, g, fx, p, age, fade, k) {
    var R = fx.r * k;
    for (var i = 0; i < 3; i++) {
      var g2 = Math.max(0.05, 1.4 - age * 1.3 - i * 0.18);
      fxRing(c, p.x, p.y, R * g2, jrRGBA(fx.tone || '190,160,255', fade * (1 - i * 0.25)), Math.max(2, Math.min(24, R * 0.03)), 1);
    }
  } },

  skyfall: { life: 0.9, draw: function (r, c, g, fx, p, age, fade, k, t) {
    var R = fx.r * k, w = Math.max(6, Math.min(90, R * 0.4) * (1 - age * 0.6));
    var col = c.createLinearGradient(p.x, 0, p.x, p.y);
    col.addColorStop(0, jrRGBA(fx.tone || '255,255,255', 0));
    col.addColorStop(0.7, jrRGBA(fx.tone || '255,255,255', 0.35 * fade));
    col.addColorStop(1, 'rgba(255,255,255,' + 0.8 * fade + ')');
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = col;
    c.fillRect(p.x - w / 2, 0, w, p.y);
    c.restore();
    jaGlow(c, p.x, p.y, R * (0.6 + age), 'rgba(255,240,210,' + 0.7 * fade + ')', jaCover(c, R * (0.6 + age)));
    fxRing(c, p.x, p.y, R * (0.3 + age * 1.4), jrRGBA(fx.tone || '255,255,255', fade), Math.max(2, R * 0.08 * fade), 1);
  } },

  timestop: { life: 1.6, draw: function (r, c, g, fx, p, age, fade, k) {
    var R = fx.r * k * Math.min(1, 0.15 + age * 1.6);
    fxRing(c, p.x, p.y, R, 'rgba(190,225,255,' + fade + ')', Math.max(2, fx.r * k * 0.012), 1);
    jrDots(c, p.x, p.y, R, 12, 0, Math.max(2, fx.r * k * 0.012), 'rgba(225,245,255,' + fade + ')');
    c.save();
    c.strokeStyle = 'rgba(225,245,255,' + fade + ')'; c.lineCap = 'round';
    c.lineWidth = Math.max(2, fx.r * k * 0.01);
    c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + Math.cos(-age * 9) * R * 0.8, p.y + Math.sin(-age * 9) * R * 0.8); c.stroke();
    c.lineWidth = Math.max(3, fx.r * k * 0.016);
    c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + Math.cos(-age * 1.5) * R * 0.5, p.y + Math.sin(-age * 1.5) * R * 0.5); c.stroke();
    c.restore();
  } },

  rapture: { life: 1.6, draw: function (r, c, g, fx, p, age, fade, k) {
    var R = fx.r * k;
    fxRing(c, p.x, p.y, R * Math.max(0.05, 1.2 - age * 0.7), 'rgba(255,250,220,' + fade + ')', Math.max(2, R * 0.015), 1);
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 10; i++) {
      var a = jaHash(fx.at + i) * Math.PI * 2, d = R * jaHash(fx.at * 3 + i);
      var x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d, h = R * 0.6 * age;
      c.fillStyle = 'rgba(255,250,220,' + 0.35 * fade + ')';
      c.fillRect(x - R * 0.015, y - h, R * 0.03, h);
    }
    c.restore();
  } },

  genesis: { life: 1.2, draw: function (r, c, g, fx, p, age, fade, k) {
    var R = fx.r * k;
    fxRing(c, p.x, p.y, R * (0.2 + age), jrRGBA(fx.tone || '255,255,255', fade), Math.max(2, Math.min(30, R * 0.05) * fade), 1);
    for (var i = 0; i < 18; i++) {
      var a = Math.PI * 2 * (i / 18) + age * 2, d = R * (0.3 + age * 0.9);
      fxGlow(c, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, R * 0.1, 'rgba(220,255,200,' + 0.8 * fade + ')', 1);
    }
  } },

  bolt: { life: 0.4, draw: function (r, c, g, fx, p, age, fade, k) {
    var w = Math.max(2.5, Math.min(14, (fx.r || 200) * k * 0.05));
    if (fx.sky) {
      jaBolt(c, p.x + (jaHash(fx.at + p.x) - 0.5) * 220, -20, p.x, p.y, fx.at * 7 + Math.floor(age * 30), w, fx.tone, fade);
      fxGlow(c, p.x, p.y, (fx.r || 200) * k * 0.9, 'rgba(230,240,255,' + 0.7 * fade + ')', 1);
    } else {
      var to = r.toScreen(fx.tx, fx.ty);
      jaBolt(c, p.x, p.y, to.x, to.y, fx.at * 5 + Math.floor(age * 30), w, fx.tone, fade);
      fxGlow(c, to.x, to.y, (fx.r || 200) * k * 0.7, 'rgba(230,240,255,' + 0.6 * fade + ')', 1);
    }
  } },

  fissure: { life: 1.1, draw: function (r, c, g, fx, p, age, fade, k) {
    var to = r.toScreen(fx.tx, fx.ty), reach = Math.min(1, age * 4);
    var x2 = p.x + (to.x - p.x) * reach, y2 = p.y + (to.y - p.y) * reach;
    jaBolt(c, p.x, p.y, x2, y2, fx.at + Math.round(fx.tx), Math.max(4, Math.hypot(to.x - p.x, to.y - p.y) * 0.04 * fade),
      fx.tone || '255,150,60', fade);
  } },

  godray: { life: 0.8, draw: function (r, c, g, fx, p, age, fade, k) {
    fxGlow(c, p.x, p.y, fx.r * k * (1 + age), 'rgba(255,250,230,' + 0.6 * fade + ')', 1);
    fxRing(c, p.x, p.y, fx.r * k * (0.5 + age * 1.5), 'rgba(255,250,230,' + fade + ')', Math.max(2, fx.r * k * 0.04), 1);
  } },

  bigbang: { life: 2.0, draw: function (r, c, g, fx, p, age, fade, k, t) {
    var R = fx.r * k, A = fx.tone || '255,255,255', B = fx.tone2 || A;
    for (var i = 0; i < 5; i++) {
      var off = i * 0.1;
      if (age < off) continue;
      fxRing(c, p.x, p.y, R * (age - off) * 0.7, jrRGBA(i % 2 ? B : A, fade), Math.max(4, Math.min(44, R * 0.02) * fade), 1);
    }
    jaSoftRays(c, p.x, p.y, R * 0.05, R * (0.2 + age * 0.6), 32, age * 0.4, B,
      0.25 * fade * jaCover(c, R * (0.1 + age * 0.3)), t, 0.03);
    jaGlow(c, p.x, p.y, R * (0.1 + age * 0.3), 'rgba(255,255,255,' + 0.5 * fade * fade + ')', jaCover(c, R * (0.1 + age * 0.3)));
  } }
};

// How hard each kind of burst shakes the world, in pixels at point-blank.
var JA_SHAKE = { bigbang: 34, supernova: 22, overdrive: 12, fissure: 10, skyfall: 7, rapture: 6,
  apocalypse: 14, overload: 8, quake: 6, slam: 4, rupture: 6, bolt: 2, collapse: 7, meteor: 5 };

// Everything in the screen layer that is not the ability card: the white-out
// when the arena is unmade nearby, the grey-out while the clock is stopped, and
// a red bruise at the edges whenever something past the archons is on screen.
function jaScreen(r, c, g, t) {
  var w = r.canvas.width, h = r.canvas.height, i;
  var list = g.jrFx || [], flash = 0;
  for (i = 0; i < list.length; i++) {
    var fx = list[i], age = (g.tick - fx.at) / TPS;
    var peak = fx.kind === 'bigbang' ? 0.5 : fx.kind === 'supernova' ? 0.16 : fx.kind === 'overdrive' ? 0.08 : 0;
    if (!peak || age < 0 || age > 0.3) continue;
    var p = r.toScreen(fx.x, fx.y);
    var near = Math.max(0, 1 - Math.hypot(p.x - w / 2, p.y - h / 2) / (Math.max(w, h) * 1.2));
    flash = Math.max(flash, peak * near * Math.pow(1 - age / 0.3, 2));
  }
  var ts = g.jaTimestop;
  if (ts && g.tick < ts.until) {
    var s = r.toScreen(ts.x, ts.y), k = r.scaling();
    var on = Math.min(1, (g.tick - ts.at) / 6, (ts.until - g.tick) / 10);
    fxTint(c, w, h, '#808080', 0.8 * on, 'saturation');
    fxTint(c, w, h, 'rgb(120,160,255)', 0.12 * on, 'screen');
    fxRing(c, s.x, s.y, ts.r * k, 'rgba(200,230,255,' + 0.5 * on + ')', Math.max(2, ts.r * k * 0.006), 1);
  }
  var big = 0;
  for (i = 0; i < g.entities.length; i++) {
    var e = g.entities[i];
    if (e.type !== 'tank' || e.dead || !e.def || (e.def.jrTier || 0) < 11) continue;
    var sp = r.toScreen(e.x, e.y), R = e.size * r.scaling();
    if (sp.x < -R * 4 || sp.y < -R * 4 || sp.x > w + R * 4 || sp.y > h + R * 4) continue;
    big = Math.max(big, e.def.jrTier - 10);
  }
  if (big) fxVignette(c, w, h, 0.32 + big * 0.05,
    'rgba(70,0,14,' + (0.22 + big * 0.08 + 0.06 * Math.sin((t || 0) * 2.4)) + ')');
  if (flash > 0.01) fxTint(c, w, h, '#FFFFFF', flash, 'lighter');
}

// The sky darkens when one of these walks in. diep's arena is a light grey, and
// additive light on light grey is white in two layers — so whenever a hull past
// the crowns is near the screen the floor is multiplied down toward a bruised
// purple, harder the higher the tier and the closer it is. Hue survives a
// multiply, so every tank on the screen still reads as its own colour.
function jaDusk(r, c, g) {
  var w = r.canvas.width, h = r.canvas.height, k = r.scaling(), dark = 0, diag = Math.hypot(w, h);
  for (var i = 0; i < g.entities.length; i++) {
    var e = g.entities[i];
    if (e.type !== 'tank' || e.dead || !e.def || (e.def.jrTier || 0) < 9) continue;
    var s = r.toScreen(e.x, e.y);
    var off = Math.max(0, Math.hypot(s.x - w / 2, s.y - h / 2) - e.size * k * 6);
    var near = Math.max(0, 1 - off / diag);
    dark = Math.max(dark, (0.2 + (e.def.jrTier - 9) * 0.07) * near);
  }
  if (dark > 0.01) fxTint(c, w, h, 'rgb(60,44,92)', Math.min(0.5, dark), 'multiply');
}

MODE_FX.juggarmageddon = {
  world: function (r, c, g, t) {
    jaDusk(r, c, g);
    // The Royale's burst painter dims its screen-sized glows while this is set.
    JA_SOFT.dim = true;
    try { MODE_FX.juggerroyale.world(r, c, g, t); } finally { JA_SOFT.dim = false; }
    jaPaintFrozen(r, c, g, t, r.scaling());
  },
  screen: function (r, c, g) {
    jaScreen(r, c, g, g.tick / TPS);
    MODE_FX.juggerroyale.screen(r, c, g);
  },
  // The renderer asks this once a frame and moves the camera that far for the
  // world pass alone. Bursts near the middle of the screen shake it most.
  shake: function (r, g) {
    var list = g.jrFx || [], w = r.canvas.width, h = r.canvas.height, amt = 0;
    for (var i = 0; i < list.length; i++) {
      var fx = list[i], s = JA_SHAKE[fx.kind];
      if (!s) continue;
      var age = (g.tick - fx.at) / TPS;
      if (age < 0 || age > 0.7) continue;
      var p = r.toScreen(fx.x, fx.y);
      var near = Math.max(0, 1 - Math.hypot(p.x - w / 2, p.y - h / 2) / (Math.max(w, h) * 1.4));
      amt += s * near * Math.pow(1 - age / 0.7, 2);
    }
    return amt;
  }
};

// A black sun over a field of crowns, lightning off it, and the level running.
MODE_THUMB.juggarmageddon = function (c, w, h, t) {
  tBG(c, w, h, '#3A1A22');
  var cx = w / 2, cy = h * 0.46, R = Math.min(w, h) * 0.13, i;
  for (i = 0; i < 8; i++) {
    var a = Math.PI * 2 * (i / 8) + t * 0.18, d = Math.min(w, h) * 0.38;
    var x = cx + Math.cos(a) * d * 1.25, y = cy + Math.sin(a) * d * 0.82;
    fxGlow(c, x, y, 18, 'rgba(255,190,140,0.35)', 1);
    tShape(c, x, y, 7, 6 + (i % 3) * 3, t * 0.3 + i, '#4A2A30', '#1A0C10');
  }
  jaDark(c, cx, cy, R * 1.1, R * 3.6, 0.6);
  jaRays(c, cx, cy, R * 1.05, R * 3.4, 24, t * 0.15, '255,70,80', 0.45, t, 0.05);
  jaRays(c, cx, cy, R * 1.05, R * 2.4, 16, -t * 0.22, '255,255,255', 0.4, t * 1.3, 0.06);
  c.save();
  c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,90,100,0.85)';
  jaStar(c, cx, cy, R * 2.05, R * 1.6, 12, t * 0.25); c.stroke();
  c.restore();
  var q = Math.floor(t * 8);
  for (i = 0; i < 4; i++) {
    var ba = jaHash(q * 5 + i) * Math.PI * 2;
    jaBolt(c, cx + Math.cos(ba) * R, cy + Math.sin(ba) * R,
      cx + Math.cos(ba + 0.3) * R * 2.8, cy + Math.sin(ba + 0.3) * R * 2.8, q * 4 + i, 2.4, '255,90,100', 0.9);
  }
  tShape(c, cx, cy, R, 24, t * 0.1, '#1A0B10', '#000000');
  fxGlow(c, cx, cy, R * 1.2, 'rgba(255,255,255,0.35)', 1);
  var hb = (t / 1.4) % 1;
  fxRing(c, cx, cy, R * (1.2 + hb * 2.6), 'rgba(255,60,70,' + (0.8 * (1 - hb)) + ')', 2.5, 1);
  tText(c, cx, cy - R * 2.35, 'LVL ' + (200 + Math.floor((t * 37) % 301)), 11, '#FFD0C0');
  tText(c, w / 2, h - 13, '183 HULLS  ·  LEVEL 500  ·  IT ALL STACKS', 10, '#FFD6DA');
};

if (typeof module !== 'undefined') module.exports = { MODE_FX: MODE_FX, MODE_THUMB: MODE_THUMB };
