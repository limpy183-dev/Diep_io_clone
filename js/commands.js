// commands.js — the chat command table, shared by the browser and the server.
//
// One table, both sides: offline the browser runs an entry against its own
// Game, online the server runs the identical entry against the authoritative
// one. Cheats are gated on ctx.sandbox — always true offline, online only in a
// Sandbox arena — so a cheat can never touch a real match.
//
// A command's run(ctx, args, rest) may return a string, which is said back to
// whoever typed it. ctx.broadcast() talks to the whole arena.

var CHAT_MAX = 140;              // characters accepted from a client
var COMMANDS = {};

// names: primary first, then aliases.
function cmd(names, spec) {
  var list = names.split(' ');
  spec.name = list[0];
  spec.alias = list.slice(1);
  list.forEach(function (n) { COMMANDS[n] = spec; });
}

function sanitizeName(s) { return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16); }
function sanitizeChat(s) { return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, CHAT_MAX); }

// One chat line is one packet, and the wire caps a string at 253 bytes. Wrap on
// a space where there is one, so a long /help does not split a command name.
function chatLines(text) {
  var out = [];
  String(text == null ? '' : text).split('\n').forEach(function (line) {
    while (line.length > 180) {
      var cut = line.lastIndexOf(' ', 180);
      if (cut < 60) cut = 180;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, '');
    }
    out.push(line);
  });
  return out;
}

function an(word) { return (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word; }

function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function onOff(a, cur) { return a === 'on' ? true : a === 'off' ? false : !cur; }

// Class lookup: exact id, exact name, prefix, then squashed substring, so
// "/class ovl", "/class overlord" and "/class 12" all land.
function findDef(q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return null;
  if (/^\d+$/.test(q)) return TANK_DEFS[+q] || null;
  var squash = function (s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var all = TANK_DEFS.filter(Boolean);
  return all.filter(function (d) { return d.name.toLowerCase() === q; })[0]
    || all.filter(function (d) { return d.name.toLowerCase().indexOf(q) === 0; })[0]
    || all.filter(function (d) { return squash(d.name).indexOf(squash(q)) >= 0; })[0] || null;
}

function playableDefs() {
  return TANK_DEFS.filter(Boolean).filter(function (d) { return !d.flags.devOnly; });
}

function findTank(g, q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return null;
  var list = g.entities.filter(function (e) { return e.type === 'tank' && !e.dead && e.name; });
  return list.filter(function (e) { return e.name.toLowerCase() === q; })[0]
    || list.filter(function (e) { return e.name.toLowerCase().indexOf(q) === 0; })[0] || null;
}

// Multipliers have to survive recompute(), which rebuilds speed/size/fov from
// stats every time you level or spend a point. Wrap the instance once.
function setMul(t, key, v) {
  t.mul = t.mul || {};
  t.mul[key] = v;
  if (!t.mulWrapped) {
    t.mulWrapped = true;
    t.recompute = function () { Tank.prototype.recompute.call(this); applyMul(this); };
  }
  t.recompute();
}
function applyMul(t) {
  var m = t.mul;
  if (!m) return;
  if (m.speed) t.movementSpeed *= m.speed;
  if (m.size) t.size *= m.size;
  if (m.fov) t.fov *= m.fov;
  if (m.damage) t.damagePerTick *= m.damage;
  if (m.health) { t.maxHealth *= m.health; t.health = Math.min(t.health, t.maxHealth); }
}

function setLevel(t, lvl) {
  lvl = clampN(Math.round(lvl), 1, MAX_LEVEL);
  t.score = LEVEL_SCORE[lvl];
  t.level = lvl;
  t.recompute();
  t.checkUpgrades();
  return lvl;
}

function nearPoint(t, spread) {
  return { x: t.x + rand(-spread, spread), y: t.y + rand(-spread, spread) };
}

// FFA and Sandbox have no teams, and team null means "hostile to everything" —
// both to the targeting scan and to the damage pass. So a squad of allies needs
// a real team: enlist you in blue, the colour you already wear there, and hand
// nextTeam to the respawn path so dying does not turn your own army on you.
function allyTeam(g, t) {
  if (!t.team) { t.team = 'blue'; t.nextTeam = 'blue'; g.paintTeam(t); }
  return t.team;
}

// A bot that fights for you: same team, same colours, parked next to you.
function spawnAlly(g, t, spread) {
  var b = g.spawnBot(), p = nearPoint(t, spread);
  b.x = b.px = p.x; b.y = b.py = p.y;
  b.team = allyTeam(g, t);
  g.paintTeam(b);
  b.addScore(LEVEL_SCORE[Math.min(MAX_LEVEL, t.level)]);
  return b;
}

function randomHex() {
  return '#' + ('00000' + ((Math.random() * 0xFFFFFF) | 0).toString(16)).slice(-6);
}
function darken(h) {
  var n = parseInt(h.slice(1), 16);
  var r = Math.round(((n >> 16) & 255) * 0.75), g = Math.round(((n >> 8) & 255) * 0.75), b = Math.round((n & 255) * 0.75);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function helpList(cat) {
  var out = [];
  Object.keys(COMMANDS).forEach(function (k) {
    var c = COMMANDS[k];
    if (c.name === k && c.cat === cat) out.push('/' + c.name);
  });
  return out.sort().join(' ');
}

// --------------------------------------------------------------- dispatch
function runCommand(ctx, raw) {
  var body = String(raw || '').replace(/^\//, '').trim();
  if (!body) return;
  var key = body.split(/\s+/)[0].toLowerCase();
  var rest = body.slice(key.length).trim();
  var args = rest ? rest.split(/\s+/) : [];
  var c = COMMANDS[key];
  if (!c) return ctx.say('Unknown command /' + key + ' — try /help');
  if (c.cheat && !ctx.sandbox) return ctx.say('/' + c.name + ' is a cheat — offline play or an online Sandbox arena only.');
  if (c.needsTank && (!ctx.tank || ctx.tank.dead)) return ctx.say('You have to be alive for /' + c.name + '.');
  var out;
  try { out = c.run(ctx, args, rest); }
  catch (e) { out = '/' + c.name + ' failed: ' + e.message; }
  if (out) ctx.say(out);
}

// ============================================================ chat & social
cmd('me emote', {
  cat: 'chat', args: '<action>', help: 'Emote in the third person.',
  run: function (ctx, a, rest) { if (!rest) return 'Usage: /me <action>'; ctx.broadcast('* ' + ctx.name + ' ' + rest); }
});
cmd('shrug', {
  cat: 'chat', args: '[message]', help: 'Say something, with a shrug.',
  run: function (ctx, a, rest) { ctx.broadcast(ctx.name + ': ' + (rest ? rest + ' ' : '') + '¯\\_(ツ)_/¯'); }
});
cmd('flip tableflip', {
  cat: 'chat', args: '[message]', help: 'Flip the table.',
  run: function (ctx, a, rest) { ctx.broadcast(ctx.name + ': ' + (rest ? rest + ' ' : '') + '(╯°□°)╯︵ ┻━┻'); }
});
cmd('unflip', {
  cat: 'chat', args: '', help: 'Put the table back.',
  run: function (ctx) { ctx.broadcast(ctx.name + ': ┬─┬ ノ( ゜-゜ノ)'); }
});
cmd('w whisper msg tell', {
  cat: 'chat', args: '<player> <message>', help: 'Send a private message to one player.',
  run: function (ctx, a, rest) {
    if (a.length < 2) return 'Usage: /w <player> <message>';
    if (!ctx.whisper) return 'There is nobody else here to whisper to.';
    return ctx.whisper(a[0], rest.slice(a[0].length).trim());
  }
});
cmd('roll dice r', {
  cat: 'chat', args: '[sides]', help: 'Roll a die. Default 100.',
  run: function (ctx, a) {
    var sides = clampN(Math.round(num(a[0], 100)), 2, 1000000);
    ctx.broadcast(ctx.name + ' rolls ' + (1 + Math.floor(Math.random() * sides)) + ' out of ' + sides);
  }
});
cmd('coin coinflip', {
  cat: 'chat', args: '', help: 'Flip a coin.',
  run: function (ctx) { ctx.broadcast(ctx.name + ' flips: ' + (Math.random() < 0.5 ? 'heads' : 'tails')); }
});
var BALL = ['It is certain', 'Without a doubt', 'Most likely', 'Signs point to yes', 'Ask a Booster',
  'Reply hazy, try again', 'Do not count on it', 'My sources say no', 'Very doubtful',
  'Absolutely not', 'Only if you are a Smasher', 'The Fallen Overlord says no'];
cmd('8ball ball', {
  cat: 'chat', args: '<question>', help: 'Consult the magic 8-ball.',
  run: function (ctx, a, rest) {
    if (!rest) return 'Ask it something.';
    ctx.broadcast(ctx.name + ' asks "' + rest + '" — the 8-ball says: ' + pick(BALL));
  }
});
cmd('rps', {
  cat: 'chat', args: '[rock|paper|scissors]', help: 'Play rock-paper-scissors against the arena.',
  run: function (ctx, a) {
    var opts = ['rock', 'paper', 'scissors'], mine = pick(opts);
    var yours = opts.filter(function (o) { return o.indexOf((a[0] || '').toLowerCase()) === 0 && a[0]; })[0];
    if (!yours) return 'Pick rock, paper or scissors.';
    var d = (opts.indexOf(yours) - opts.indexOf(mine) + 3) % 3;
    ctx.broadcast(ctx.name + ' plays ' + yours + ', arena plays ' + mine + ' — ' +
      (d === 0 ? 'a draw' : d === 1 ? ctx.name + ' wins' : ctx.name + ' loses'));
  }
});
cmd('nick name rename', {
  cat: 'chat', args: '<name>', help: 'Change your display name.',
  needsTank: true,
  run: function (ctx, a, rest) {
    var n = sanitizeName(rest);
    if (!n) return 'Usage: /nick <name>';
    var old = ctx.tank.name || 'an unnamed tank';
    ctx.tank.name = n;
    ctx.broadcast(old + ' is now known as ' + n);
  }
});
cmd('gg', {
  cat: 'chat', args: '', help: 'Good game.',
  run: function (ctx) { ctx.broadcast(ctx.name + ': gg'); }
});

// ==================================================================== info
cmd('help h commands', {
  cat: 'info', local: true, args: '[command]', help: 'List every command, or explain one.',
  run: function (ctx, a) {
    if (a.length) {
      var c = COMMANDS[a[0].replace(/^\//, '').toLowerCase()];
      if (!c) return 'No such command: ' + a[0];
      return '/' + c.name + (c.args ? ' ' + c.args : '') + ' — ' + c.help +
        (c.alias.length ? '  (also /' + c.alias.join(' /') + ')' : '') + (c.cheat ? '  [cheat]' : '');
    }
    return 'CHAT: ' + helpList('chat') +
      '\nINFO: ' + helpList('info') +
      '\nCHEATS: ' + helpList('cheat') +
      '\n/help <command> explains one. T or Enter opens chat, Tab completes, Up recalls.';
  }
});
cmd('cheats', {
  cat: 'info', local: true, args: '', help: 'List the cheat commands.',
  run: function (ctx) {
    return 'CHEATS: ' + helpList('cheat') +
      '\n' + (ctx.sandbox ? 'Cheats are enabled here.' : 'Cheats need offline play or an online Sandbox arena.');
  }
});
cmd('keys controls', {
  cat: 'info', local: true, args: '', help: 'Show the keyboard controls.',
  run: function () {
    return 'WASD move, mouse aim, click/space fire, right-click/shift alt-fire' +
      '\nE auto-fire, C auto-spin, 1-8 stats, U+n queue, M+n fill, Y class tree' +
      '\nH pilot a Dominator/Mothership, O self-destruct, T or Enter chat, Esc menu';
  }
});
cmd('pos coords where', {
  cat: 'info', local: true, args: '', help: 'Report your coordinates.',
  needsTank: true,
  run: function (ctx) {
    var t = ctx.tank;
    return 'You are at ' + Math.round(t.x) + ', ' + Math.round(t.y) +
      ' (arena is ' + Math.round(ctx.game.arena.size) + ' across)';
  }
});
cmd('score', {
  cat: 'info', local: true, args: '', help: 'Report your score, level and kills.',
  run: function (ctx) {
    var t = ctx.tank;
    if (!t) return 'No tank.';
    return 'Level ' + t.level + ' ' + t.def.name + ' — score ' + Math.round(t.score) +
      ', kills ' + (t.kills || 0) + ', ' + (t.statsAvailable || 0) + ' stat points unspent';
  }
});
cmd('top leaderboard lb', {
  cat: 'info', local: true, args: '', help: 'Show the top of the scoreboard.',
  run: function (ctx) {
    var lb = ctx.game.leaderboard || [];
    if (!lb.length) return 'The scoreboard is empty.';
    return lb.slice(0, 6).map(function (e, i) {
      return (i + 1) + '. ' + (e.name || 'unnamed') + ' - ' + Math.round(e.score);
    }).join('\n');
  }
});
cmd('players who online', {
  cat: 'info', args: '', help: 'List the tanks currently in the arena.',
  run: function (ctx) {
    var names = ctx.game.entities.filter(function (e) { return e.type === 'tank' && !e.dead && !e.isCloser; })
      .map(function (e) { return e.name || 'unnamed'; });
    return names.length + ' tanks: ' + names.slice(0, 30).join(', ') + (names.length > 30 ? ' ...' : '');
  }
});
cmd('mode gamemode', {
  cat: 'info', local: true, args: '', help: 'Name the current game mode.',
  run: function (ctx) {
    return 'Mode: ' + ctx.game.mode.name + (ctx.sandbox ? ' (cheats enabled)' : '') +
      (ctx.online ? ' — online' : ' — offline');
  }
});
cmd('uptime tps', {
  cat: 'info', args: '', help: 'How long this arena has been running.',
  run: function (ctx) {
    var s = Math.floor(ctx.game.tick / TPS);
    return 'Arena up ' + Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ' + (s % 60) + 's' +
      ' (' + ctx.game.tick + ' ticks at ' + TPS + '/s), ' + ctx.game.entities.length + ' entities';
  }
});
cmd('whoami', {
  cat: 'info', local: true, args: '', help: 'Who the server thinks you are.',
  run: function (ctx) {
    return 'You are ' + (ctx.name || 'an unnamed tank') + ', ' + an(ctx.tank ? ctx.tank.def.name : 'ghost') +
      (ctx.tank && ctx.tank.dead ? ' (dead)' : '') + (ctx.tank && ctx.tank.team ? ' on team ' + ctx.tank.team : '');
  }
});
cmd('upgrades classes tree', {
  cat: 'info', local: true, args: '[class]', help: 'Show what your class upgrades into.',
  run: function (ctx, a) {
    var def = a.length ? findDef(a.join(' ')) : (ctx.tank && ctx.tank.def);
    if (!def) return 'No such class.';
    var ups = (def.upgrades || []).map(function (id) {
      var d = TANK_DEFS[id];
      return d && !d.flags.devOnly ? d.name + ' (lvl ' + d.levelRequirement + ')' : null;
    }).filter(Boolean);
    return def.name + ' upgrades into: ' + (ups.length ? ups.join(', ') : 'nothing, it is a leaf class');
  }
});
cmd('classlist tanks', {
  cat: 'info', local: true, args: '[search]', help: 'List class names, optionally filtered.',
  run: function (ctx, a) {
    var q = (a.join(' ') || '').toLowerCase();
    var names = playableDefs().map(function (d) { return d.name; })
      .filter(function (n) { return !q || n.toLowerCase().indexOf(q) >= 0; });
    return names.length + ' classes: ' + names.join(', ');
  }
});
cmd('time', {
  cat: 'info', local: true, args: '', help: 'Your local clock.',
  run: function () { return 'It is ' + new Date().toLocaleTimeString() + ' where you are.'; }
});
cmd('version about', {
  cat: 'info', local: true, args: '', help: 'Build info.',
  run: function () {
    var uniq = Object.keys(COMMANDS).filter(function (k) { return COMMANDS[k].name === k; });
    var cheats = uniq.filter(function (k) { return COMMANDS[k].cheat; });
    return 'Tank Arena — ' + playableDefs().length + ' classes, ' + Object.keys(GAMEMODES).length + ' modes, ' +
      uniq.length + ' chat commands (' + cheats.length + ' of them cheats), ' + Object.keys(COMMANDS).length + ' names including aliases.';
  }
});

// ================================================================== cheats
cmd('god invincible', {
  cat: 'cheat', cheat: true, needsTank: true, args: '[on|off]', help: 'Ignore all damage.',
  run: function (ctx, a) {
    ctx.tank.godMode = onOff(a[0], ctx.tank.godMode);
    return 'God mode ' + (ctx.tank.godMode ? 'ON' : 'OFF');
  }
});
cmd('kill suicide die', {
  cat: 'cheat', cheat: true, needsTank: true, args: '', help: 'Kill your own tank at once.',
  run: function (ctx) { ctx.tank.godMode = false; ctx.tank.kill(null); return 'Boom.'; }
});
cmd('heal hp', {
  cat: 'cheat', cheat: true, needsTank: true, args: '', help: 'Refill your health.',
  run: function (ctx) { ctx.tank.health = ctx.tank.maxHealth; return 'Healed to ' + Math.round(ctx.tank.maxHealth) + ' HP.'; }
});
cmd('level setlevel', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<1-45|max>', help: 'Jump straight to a level.',
  run: function (ctx, a) {
    if (!a.length) return 'Usage: /level <1-' + MAX_LEVEL + '|max>';
    return 'You are now level ' + setLevel(ctx.tank, a[0] === 'max' ? MAX_LEVEL : num(a[0], 1)) + '.';
  }
});
cmd('maxlevel', {
  cat: 'cheat', cheat: true, needsTank: true, args: '', help: 'Jump to level 45.',
  run: function (ctx) { setLevel(ctx.tank, MAX_LEVEL); return 'Level ' + MAX_LEVEL + '.'; }
});
cmd('xp addscore', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<amount>', help: 'Add score.',
  run: function (ctx, a) {
    var n = num(a[0], 1000);
    ctx.tank.addScore(n);
    return 'Added ' + Math.round(n) + ' score — now ' + Math.round(ctx.tank.score) + '.';
  }
});
cmd('setscore', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<score>', help: 'Set your score exactly.',
  run: function (ctx, a) {
    var t = ctx.tank;
    t.score = Math.max(0, num(a[0], 0));
    t.level = levelFromScore(t.score);
    t.recompute(); t.checkUpgrades();
    return 'Score ' + Math.round(t.score) + ', level ' + t.level + '.';
  }
});
cmd('class tank become', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<name|id>', help: 'Turn into any class.',
  run: function (ctx, a, rest) {
    var def = findDef(rest);
    if (!def) return 'No class matches "' + rest + '" — try /classlist';
    ctx.tank.setTank(def.id);
    ctx.tank.checkUpgrades();
    return 'You are now ' + an(def.name) + '.';
  }
});
cmd('randomclass', {
  cat: 'cheat', cheat: true, needsTank: true, args: '', help: 'Turn into a random class.',
  run: function (ctx) {
    var def = pick(playableDefs());
    ctx.tank.setTank(def.id); ctx.tank.checkUpgrades();
    return 'Rolled ' + an(def.name) + '.';
  }
});
cmd('nextclass cycle', {
  cat: 'cheat', cheat: true, needsTank: true, args: '', help: 'Step to the next class in the table.',
  run: function (ctx) {
    var ids = playableDefs().map(function (d) { return d.id; }).sort(function (x, y) { return x - y; });
    var def = TANK_DEFS[ids[(ids.indexOf(ctx.tank.tankId) + 1) % ids.length]];
    ctx.tank.setTank(def.id); ctx.tank.checkUpgrades();
    return 'You are now ' + an(def.name) + '.';
  }
});
cmd('stats build', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<max|clear|0/0/0/7/7/7/0/0>',
  help: 'Set your stat spread. The build reads top to bottom, as the bars do.',
  run: function (ctx, a, rest) {
    var t = ctx.tank, i;
    if (!rest) return 'Usage: /stats max | /stats clear | /stats 0/0/0/7/7/7/0/0';
    if (rest === 'max') { for (i = 0; i < 8; i++) t.stats[i] = t.def.stats[i].max; }
    else if (rest === 'clear' || rest === 'reset') { for (i = 0; i < 8; i++) t.stats[i] = 0; }
    else {
      var parts = rest.split(/[\/,\s]+/).filter(function (s) { return s !== ''; });
      if (parts.length !== 8) return 'A build is 8 numbers, top bar first: /stats 0/0/0/7/7/7/0/0';
      for (i = 0; i < 8; i++) {
        var wire = uiToWire(i);
        t.stats[wire] = clampN(Math.round(num(parts[i], 0)), 0, t.def.stats[wire].max);
      }
    }
    t.recompute();
    return 'Build set: ' + [0, 1, 2, 3, 4, 5, 6, 7].map(function (ui) { return t.stats[uiToWire(ui)]; }).join('/');
  }
});
cmd('maxstats', {
  cat: 'cheat', cheat: true, needsTank: true, args: '', help: 'Max every stat your class allows.',
  run: function (ctx) {
    for (var i = 0; i < 8; i++) ctx.tank.stats[i] = ctx.tank.def.stats[i].max;
    ctx.tank.recompute();
    return 'Every stat maxed.';
  }
});
cmd('points', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<n>', help: 'Grant yourself spare stat points.',
  run: function (ctx, a) {
    ctx.tank.bonusPoints = clampN(Math.round(num(a[0], 33)), 0, 255);
    ctx.tank.recompute();
    return ctx.tank.statsAvailable + ' points to spend.';
  }
});
cmd('max godmode', {
  cat: 'cheat', cheat: true, needsTank: true, args: '', help: 'Level 45, stats maxed, god mode on.',
  run: function (ctx) {
    setLevel(ctx.tank, MAX_LEVEL);
    for (var i = 0; i < 8; i++) ctx.tank.stats[i] = ctx.tank.def.stats[i].max;
    ctx.tank.godMode = true;
    ctx.tank.recompute();
    return 'Level ' + MAX_LEVEL + ', stats maxed, god mode ON. Go be a problem.';
  }
});
cmd('speed', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<multiplier>', help: 'Multiply your movement speed.',
  run: function (ctx, a) {
    var m = clampN(num(a[0], 1), 0, 50);
    setMul(ctx.tank, 'speed', m);
    return 'Speed x' + m;
  }
});
cmd('size', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<multiplier>', help: 'Multiply your body size.',
  run: function (ctx, a) {
    var m = clampN(num(a[0], 1), 0.1, 20);
    setMul(ctx.tank, 'size', m);
    return 'Size x' + m;
  }
});
cmd('fov zoom', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<multiplier>', help: 'Multiply your field of view (smaller sees further).',
  run: function (ctx, a) {
    var m = clampN(num(a[0], 1), 0.05, 10);
    setMul(ctx.tank, 'fov', m);
    return 'FOV x' + m;
  }
});
cmd('bodydamage ram', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<multiplier>', help: 'Multiply your body damage.',
  run: function (ctx, a) {
    var m = clampN(num(a[0], 1), 0, 10000);
    setMul(ctx.tank, 'damage', m);
    return 'Body damage x' + m;
  }
});
cmd('maxhealth bulk', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<multiplier>', help: 'Multiply your max health.',
  run: function (ctx, a) {
    var m = clampN(num(a[0], 1), 0.01, 10000);
    setMul(ctx.tank, 'health', m);
    ctx.tank.health = ctx.tank.maxHealth;
    return 'Max health ' + Math.round(ctx.tank.maxHealth) + '.';
  }
});
cmd('invis stalker', {
  cat: 'cheat', cheat: true, needsTank: true, args: '[on|off]', help: 'Go permanently invisible — to everyone, yourself included.',
  run: function (ctx, a) {
    var t = ctx.tank;
    t.cheatInvis = onOff(a[0], t.cheatInvis);
    if (!t.cheatInvis) t.opacity = 1;
    return 'Invisibility ' + (t.cheatInvis ? 'ON — nobody can see you, not even you' : 'OFF');
  }
});
cmd('noclip ghost', {
  cat: 'cheat', cheat: true, needsTank: true, args: '[on|off]', help: 'Walk through walls and out of the arena.',
  run: function (ctx, a) {
    var t = ctx.tank;
    t.canMoveThroughWalls = t.canEscapeArena = onOff(a[0], t.canMoveThroughWalls);
    return 'Noclip ' + (t.canMoveThroughWalls ? 'ON' : 'OFF');
  }
});
cmd('xray seeinvisible', {
  cat: 'cheat', cheat: true, needsTank: true, args: '[on|off]', help: 'Let your drones and auto-turrets target invisible tanks.',
  run: function (ctx, a) {
    var t = ctx.tank;
    t.seesInvisible = onOff(a[0], t.seesInvisible);
    return 'X-ray targeting ' + (t.seesInvisible ? 'ON' : 'OFF');
  }
});
cmd('tp teleport goto', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<x> <y> | <player>', help: 'Teleport to a spot or to a player.',
  run: function (ctx, a, rest) {
    var t = ctx.tank, x, y;
    if (a.length >= 2 && isFinite(parseFloat(a[0])) && isFinite(parseFloat(a[1]))) { x = num(a[0], t.x); y = num(a[1], t.y); }
    else {
      var target = findTank(ctx.game, rest);
      if (!target) return 'Give me "x y" or the name of a live tank.';
      x = target.x + rand(-200, 200); y = target.y + rand(-200, 200);
    }
    var lim = ctx.game.arena.size;
    t.x = t.px = clampN(x, -lim, lim); t.y = t.py = clampN(y, -lim, lim);
    t.vx = t.vy = 0;
    return 'Teleported to ' + Math.round(t.x) + ', ' + Math.round(t.y) + '.';
  }
});
cmd('home center', {
  cat: 'cheat', cheat: true, needsTank: true, args: '', help: 'Teleport to the middle of the arena.',
  run: function (ctx) {
    var t = ctx.tank;
    t.x = t.px = 0; t.y = t.py = 0; t.vx = t.vy = 0;
    return 'Back to the nest.';
  }
});
cmd('boss', {
  cat: 'cheat', cheat: true, args: '[name|index]', help: 'Spawn a boss. No name means a random one.',
  run: function (ctx, a, rest) {
    var idx;
    if (rest) {
      idx = /^\d+$/.test(rest) ? +rest : BOSSES.map(function (b, i) { return { b: b, i: i }; })
        .filter(function (o) { return o.b.name.toLowerCase().indexOf(rest.toLowerCase()) >= 0; }).map(function (o) { return o.i; })[0];
      if (idx === undefined || !BOSSES[idx]) return 'No such boss. Try: ' + BOSSES.map(function (b) { return b.name; }).join(', ');
    }
    var b = ctx.game.spawnBoss(idx);
    if (ctx.tank) { b.x = ctx.tank.x + rand(-900, 900); b.y = ctx.tank.y + rand(-900, 900); }
    return 'Spawned the ' + b.name + '.';
  }
});
cmd('bots', {
  cat: 'cheat', cheat: true, args: '<n>', help: 'Set how many bots the arena keeps alive.',
  run: function (ctx, a) {
    var n = clampN(Math.round(num(a[0], 0)), 0, 120);
    ctx.game.botOverride = n;
    ctx.game.botCount = n;
    return 'Bot count pinned at ' + n + '.';
  }
});
cmd('difficulty diff', {
  cat: 'cheat', cheat: true, args: '<name>', help: 'How good the bots are: ' + BOT_DIFFICULTIES.join(', ') + '.',
  run: function (ctx, a, rest) {
    var want = String(rest || a[0] || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!want) return 'Bots are ' + ctx.game.botSkill.label + '. Options: ' + BOT_DIFFICULTIES.join(', ') + '.';
    var key = BOT_DIFFICULTIES.filter(function (d) { return d.indexOf(want) === 0; })[0];
    if (!key) return 'Pick one of: ' + BOT_DIFFICULTIES.join(', ') + '.';
    return 'Bots are now ' + ctx.game.setDifficulty(key).label + '.';
  }
});
cmd('army', {
  cat: 'cheat', cheat: true, needsTank: true, args: '[n]', help: 'Drop allied bots next to you. They fight for you and cannot hurt you.',
  run: function (ctx, a) {
    var n = clampN(Math.round(num(a[0], 5)), 1, 20);
    for (var i = 0; i < n; i++) spawnAlly(ctx.game, ctx.tank, 600);
    return n + ' friends, freshly printed — team ' + ctx.tank.team + '.';
  }
});
cmd('clone', {
  cat: 'cheat', cheat: true, needsTank: true, args: '[n]', help: 'Spawn allied bots that copy your class and level.',
  run: function (ctx, a) {
    var n = clampN(Math.round(num(a[0], 1)), 1, 20), t = ctx.tank, g = ctx.game;
    for (var i = 0; i < n; i++) {
      var b = spawnAlly(g, t, 500);
      b.name = (t.name || 'clone') + ' ' + (i + 1);
      b.setTank(t.tankId);
      b.stats = t.stats.slice();
      b.recompute();
      b.health = b.maxHealth;
    }
    return n + ' of you. Sorry.';
  }
});
cmd('killbots purge', {
  cat: 'cheat', cheat: true, args: '', help: 'Kill every bot on the field.',
  run: function (ctx) {
    var n = 0;
    ctx.game.entities.forEach(function (e) { if (e.type === 'tank' && e.bot && !e.dead) { e.kill(null); n++; } });
    return n + ' bots removed' + (ctx.game.botCount ? ' — they respawn, /bots 0 to stop that.' : '.');
  }
});
cmd('freeze', {
  cat: 'cheat', cheat: true, args: '[on|off]', help: 'Park every bot where it stands.',
  run: function (ctx, a) {
    var g = ctx.game;
    g.frozen = onOff(a[0], g.frozen);
    g.entities.forEach(function (e) { if (e.type === 'tank' && e.bot) e.parked = g.frozen; });
    return 'Bots ' + (g.frozen ? 'frozen (new arrivals are not)' : 'moving again') + '.';
  }
});
cmd('shapes', {
  cat: 'cheat', cheat: true, args: '<n>', help: 'Set how many shapes the arena keeps stocked.',
  run: function (ctx, a) {
    ctx.game.wantedShapes = clampN(Math.round(num(a[0], 0)), 0, 4000);
    return 'Shape target: ' + ctx.game.wantedShapes;
  }
});
cmd('spawn', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<square|triangle|pentagon|alpha|hexagon|crasherS|crasherL> [n]',
  help: 'Spawn shapes next to you.',
  run: function (ctx, a) {
    var kinds = Object.keys(SHAPES);
    var kind = kinds.filter(function (k) { return k.toLowerCase() === (a[0] || '').toLowerCase(); })[0]
      || kinds.filter(function (k) { return (a[0] || '').length && k.toLowerCase().indexOf(a[0].toLowerCase()) === 0; })[0];
    if (!kind) return 'Shapes: ' + kinds.join(', ');
    var n = clampN(Math.round(num(a[1], 1)), 1, 50);
    for (var i = 0; i < n; i++) {
      var p = nearPoint(ctx.tank, 400);
      ctx.game.add(new Shape(ctx.game, kind, p.x, p.y));
    }
    return n + ' x ' + kind + ' delivered.';
  }
});
cmd('rain', {
  cat: 'cheat', cheat: true, needsTank: true, args: '[n]', help: 'Rain a pile of random shapes around you.',
  run: function (ctx, a) {
    var n = clampN(Math.round(num(a[0], 40)), 1, 300), kinds = Object.keys(SHAPES);
    for (var i = 0; i < n; i++) {
      var p = nearPoint(ctx.tank, 1400);
      ctx.game.add(new Shape(ctx.game, pick(kinds), p.x, p.y));
    }
    ctx.broadcast(ctx.name + ' made it rain polygons.');
  }
});
cmd('clearshapes', {
  cat: 'cheat', cheat: true, args: '', help: 'Sweep every shape off the field.',
  run: function (ctx) {
    var n = 0;
    ctx.game.entities.forEach(function (e) { if (e.type === 'shape' && !e.dead) { e.kill(null); n++; } });
    return n + ' shapes swept. /shapes 0 stops them coming back.';
  }
});
cmd('nuke', {
  cat: 'cheat', cheat: true, needsTank: true, args: '[radius]', help: 'Kill everything around you; the shapes pay out to you.',
  run: function (ctx, a) {
    var r = clampN(num(a[0], 3000), 100, 50000), r2 = r * r, t = ctx.tank, n = 0;
    ctx.game.entities.forEach(function (e) {
      if (e === t || e.dead || e.type === 'wall' || e.type === 'base' || e.type === 'tile' || e.type === 'flag') return;
      if (dist2(e, t) > r2) return;
      e.kill(t); n++;
    });
    ctx.broadcast(ctx.name + ' set off a nuke — ' + n + ' entities gone.');
  }
});
cmd('team', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<blue|red|green|purple|none>', help: 'Switch sides.',
  run: function (ctx, a) {
    var name = (a[0] || '').toLowerCase();
    if (name === 'none') { ctx.tank.team = null; ctx.game.paintTeam(ctx.tank); return 'You are on no team.'; }
    if (!TEAM_COLORS[name]) return 'Teams: ' + Object.keys(TEAM_COLORS).join(', ') + ', none';
    ctx.tank.team = name;
    ctx.game.paintTeam(ctx.tank);
    return 'You are now on ' + name + '.';
  }
});
cmd('color colour', {
  cat: 'cheat', cheat: true, needsTank: true, args: '<#rrggbb|random>', help: 'Repaint your tank.',
  run: function (ctx, a) {
    var c = (a[0] || 'random').toLowerCase();
    if (c === 'random') c = randomHex();
    if (!/^#?[0-9a-f]{6}$/.test(c)) return 'Give me a hex colour like #ff00aa, or "random".';
    if (c[0] !== '#') c = '#' + c;
    ctx.tank.fill = c; ctx.tank.stroke = darken(c);
    return 'Painted ' + c + '.';
  }
});
cmd('disco', {
  cat: 'cheat', cheat: true, args: '', help: 'Repaint every tank on the field at random.',
  run: function (ctx) {
    ctx.game.entities.forEach(function (e) {
      if (e.type !== 'tank' || e.dead) return;
      e.fill = randomHex(); e.stroke = darken(e.fill);
    });
    ctx.broadcast(ctx.name + ' turned the lights down.');
  }
});
cmd('closearena', {
  cat: 'cheat', cheat: true, args: '', help: 'Send in the Arena Closers.',
  run: function (ctx) {
    if (ctx.game.closing) return 'Already closing.';
    ctx.game.close();
    ctx.broadcast(ctx.name + ' called in the Arena Closers.');
  }
});

// --------------------------------------------------------------- bot chat
// Bots only ever talk back to a human line — no unprompted chatter.
var BOT_REPLY = ['lol', 'k', 'sure buddy', 'no u', 'true', 'skill issue', 'agreed', 'whatever you say',
  'thats not what the leaderboard says', 'nobody asked', 'based', 'ok level 3', '^', 'wrong'];

function pickBot(g) {
  var bots = g.entities.filter(function (e) { return e.type === 'tank' && e.bot && !e.dead && e.name; });
  return bots.length ? pick(bots) : null;
}

// A bot talking back to something a human said.
function botReplyLine(g) {
  var b = pickBot(g);
  return b && { name: b.name, text: pick(BOT_REPLY), fill: b.fill };
}

if (typeof module !== 'undefined') module.exports = {
  COMMANDS: COMMANDS, runCommand: runCommand, chatLines: chatLines,
  sanitizeName: sanitizeName, sanitizeChat: sanitizeChat, CHAT_MAX: CHAT_MAX,
  botReplyLine: botReplyLine
};
