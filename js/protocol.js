// protocol.js — binary wire format, shared by server.js and js/net.js.
// Loaded as a plain script in the browser and required in Node.
//
// Why binary: a full view is ~150 entities at 25 Hz. As JSON that's ~1.2 Mbps;
// packed it's ~390 kbps.

var OP = { JOIN: 1, INPUT: 2, STAT: 3, UPGRADE: 4, RESPAWN: 5, TOGGLE: 6, POSSESS: 7, CHAT: 8 };
// MAPSTATE only goes out when the objective layout actually changes (a capture,
// a tile flip), so the minimap stays live without costing bandwidth every tick.
var SV = { WELCOME: 1, UPDATE: 2, NOTIFY: 3, DEATH: 4, MAPSTATE: 5, CHAT: 6 };

// Chat line kinds, matching the CSS classes in index.html.
var CHATKIND = ['player', 'system', 'whisper', 'notice'];

// Input bitfield, matching the spec's layout.
var IN = { FIRE: 1, UP: 2, LEFT: 4, DOWN: 8, RIGHT: 16, GOD: 32, SUICIDE: 64, ALTFIRE: 128, LEVELUP: 256, SWITCHTANK: 1024 };

// Entity type <-> index. Append only; never reorder.
var ETYPES = ['tank', 'bullet', 'drone', 'necro', 'trap', 'minion', 'skimmer', 'rocket', 'swarm', 'shape', 'boss', 'wall', 'base', 'tile', 'flag', 'glider', 'firework'];

var MAX_PACKET = 1 << 20;   // 1 MB ceiling on anything we accept

function Buf(sizeOrBytes) {
  if (typeof sizeOrBytes === 'number') {
    this.view = new DataView(new ArrayBuffer(sizeOrBytes));
    this.len = 0;
  } else {
    var u = sizeOrBytes;
    this.view = new DataView(u.buffer, u.byteOffset, u.byteLength);
    this.len = u.byteLength;
  }
  this.off = 0;
}
Buf.prototype.u8 = function (v) { this.view.setUint8(this.off++, v); return this; };
Buf.prototype.i8 = function (v) { this.view.setInt8(this.off++, v); return this; };
Buf.prototype.u16 = function (v) { this.view.setUint16(this.off, v); this.off += 2; return this; };
Buf.prototype.i16 = function (v) { this.view.setInt16(this.off, v); this.off += 2; return this; };
Buf.prototype.u32 = function (v) { this.view.setUint32(this.off, v); this.off += 4; return this; };
Buf.prototype.f32 = function (v) { this.view.setFloat32(this.off, v); this.off += 4; return this; };
// The length prefix is one byte, so 255 bytes is the ceiling. Stop before the
// last character that could overflow it rather than cutting mid-character —
// truncating a UTF-8 sequence would corrupt the decode.
// Name limits belong in the server's sanitize(), not here: notifications are
// full sentences and must survive intact.
Buf.prototype.str = function (s) {
  s = String(s == null ? '' : s);
  var bytes = [];
  for (var i = 0; i < s.length; i++) {
    if (bytes.length > 252) break;
    var c = s.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  this.u8(bytes.length);
  for (i = 0; i < bytes.length; i++) this.u8(bytes[i]);
  return this;
};

Buf.prototype.ru8 = function () { return this.view.getUint8(this.off++); };
Buf.prototype.ri8 = function () { return this.view.getInt8(this.off++); };
Buf.prototype.ru16 = function () { var v = this.view.getUint16(this.off); this.off += 2; return v; };
Buf.prototype.ri16 = function () { var v = this.view.getInt16(this.off); this.off += 2; return v; };
Buf.prototype.ru32 = function () { var v = this.view.getUint32(this.off); this.off += 4; return v; };
Buf.prototype.rf32 = function () { var v = this.view.getFloat32(this.off); this.off += 4; return v; };
Buf.prototype.rstr = function () {
  var n = this.ru8(), out = '', i = 0;
  while (i < n) {
    var c = this.ru8(); i++;
    if (c < 128) out += String.fromCharCode(c);
    else if (c < 224) { out += String.fromCharCode(((c & 31) << 6) | (this.ru8() & 63)); i++; }
    else { var b = this.ru8(), d = this.ru8(); i += 2; out += String.fromCharCode(((c & 15) << 12) | ((b & 63) << 6) | (d & 63)); }
  }
  return out;
};
Buf.prototype.bytes = function () { return new Uint8Array(this.view.buffer, 0, this.off); };
Buf.prototype.remaining = function () { return this.len - this.off; };

// Angles ride as one byte; 1.4 degrees is finer than anyone can see at 25 Hz.
function packAngle(a) { return ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * 255 & 255; }
function unpackAngle(b) { return b / 255 * Math.PI * 2; }

// How many auto-turret angles a tank id carries. Both sides derive this from
// the tank table rather than sending a count.
function turretCount(defs, addons, tankId) {
  var d = defs[tankId];
  if (!d) return 0;
  var a = addons[d.postAddon];
  return a && a.turrets ? a.turrets : 0;
}

if (typeof module !== 'undefined') module.exports = {
  OP: OP, SV: SV, IN: IN, ETYPES: ETYPES, Buf: Buf, MAX_PACKET: MAX_PACKET, CHATKIND: CHATKIND,
  packAngle: packAngle, unpackAngle: unpackAngle, turretCount: turretCount
};
