// chat.js — the in-game chat overlay and the client half of chat commands.
//
// DOM, not canvas: a real <input> gets caret, selection, clipboard, IME and
// mobile keyboards for free, and the log is a div that CSS fades on its own.
// The renderer never learns chat exists.

var CHAT = (function () {
  var box, log, input, isOpen = false;
  var history = [], histIdx = -1, draft = '', lastSent = 0;
  var muted = Object.create(null);
  var hooks = {};                    // { send, context, online }
  var MAX_ROWS = 60;

  function init(h) {
    hooks = h || {};
    box = document.getElementById('chat');
    log = document.getElementById('chatlog');
    input = document.getElementById('chatinput');

    input.addEventListener('keydown', function (e) {
      e.stopPropagation();           // the game must never see what you type
      if (e.key === 'Enter') { e.preventDefault(); submit(input.value); close(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') { e.preventDefault(); complete(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); recall(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); recall(-1); }
    });
    input.addEventListener('keyup', function (e) { e.stopPropagation(); });
    input.addEventListener('keypress', function (e) { e.stopPropagation(); });
    input.addEventListener('blur', function () { if (isOpen) close(); });
  }

  // Explicit values, not '': the stylesheet's own default for both is none.
  function show() { box.style.display = 'block'; }
  function hide() { close(); box.style.display = 'none'; clear(); }

  function open(prefill) {
    if (isOpen) return;
    isOpen = true;
    box.classList.add('open');
    input.style.display = 'block';
    input.value = prefill || '';
    histIdx = -1;
    input.focus();
    log.scrollTop = log.scrollHeight;          // opening reveals the backlog at the bottom
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    box.classList.remove('open');
    input.style.display = 'none';
    input.value = '';
    input.blur();
  }

  // Tab: complete the command word being typed.
  function complete() {
    var v = input.value;
    if (v[0] !== '/' || /\s/.test(v)) return;
    var q = v.slice(1).toLowerCase();
    var hits = Object.keys(COMMANDS).filter(function (k) { return k.indexOf(q) === 0; }).sort();
    if (!hits.length) return;
    if (hits.length === 1) { input.value = '/' + hits[0] + ' '; return; }
    input.value = '/' + hits[0];
    system('/' + hits.slice(0, 20).join('  /'));
  }

  function recall(dir) {
    if (!history.length) return;
    if (histIdx === -1 && dir > 0) draft = input.value;
    histIdx = Math.max(-1, Math.min(history.length - 1, histIdx + dir));
    input.value = histIdx === -1 ? draft : history[histIdx];
    input.setSelectionRange(input.value.length, input.value.length);
  }

  // --------------------------------------------------------------- output
  function push(kind, name, text, color) {
    if (kind === 'player' && name && muted[name.toLowerCase()]) return;
    chatLines(text).forEach(function (line) { row(kind, name, line, color); });
  }
  function system(text) { push('system', null, text, null); }

  function row(kind, name, text, color) {
    var el = document.createElement('div');
    el.className = 'msg ' + kind;
    if (kind === 'player' || kind === 'whisper') {
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = name + ': ';
      if (color) who.style.color = color;
      el.appendChild(who);
    }
    el.appendChild(document.createTextNode(text));
    log.appendChild(el);
    while (log.childNodes.length > MAX_ROWS) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;          // newest line always in view
    setTimeout(function () { el.classList.add('faded'); }, 14000);
  }
  function clear() { while (log.firstChild) log.removeChild(log.firstChild); }

  // -------------------------------------------------------------- sending
  function submit(text) {
    text = String(text || '').replace(/\s+$/, '').slice(0, CHAT_MAX);
    if (!text) return;
    history.unshift(text);
    if (history.length > 40) history.pop();
    var key = text[0] === '/' ? text.slice(1).trim().split(/\s+/)[0].toLowerCase() : null;
    var c = key === null ? null : COMMANDS[key];
    // Cheats and anything that touches the world run on the server when online;
    // the local-only ones never leave the browser.
    if (c && c.local) { runCommand(hooks.context(), text); return; }
    if (!hooks.online()) {
      if (key === null) hooks.send(text); else runCommand(hooks.context(), text);
      return;
    }

    // The server drops anything inside its own 400ms window, so say so here
    // rather than let a line vanish without a word.
    var now = Date.now();
    if (now - lastSent < 420) { system('Slow down — one line every 0.4s.'); return; }
    lastSent = now;
    hooks.send(text);
  }

  // The client-only commands live here: they touch chat state, not the world.
  cmd('clear cls', {
    cat: 'info', local: true, args: '', help: 'Clear your chat log.',
    run: function () { clear(); return 'Chat cleared.'; }
  });
  cmd('mute ignore', {
    cat: 'info', local: true, args: '<name>', help: 'Hide messages from a player.',
    run: function (ctx, a, rest) {
      if (!rest) return 'Usage: /mute <name>';
      muted[rest.toLowerCase()] = true;
      return 'Muted ' + rest + '.';
    }
  });
  cmd('unmute', {
    cat: 'info', local: true, args: '<name|all>', help: 'Unmute a player.',
    run: function (ctx, a, rest) {
      if (rest === 'all') { muted = Object.create(null); return 'Everyone unmuted.'; }
      delete muted[rest.toLowerCase()];
      return 'Unmuted ' + rest + '.';
    }
  });
  cmd('muted', {
    cat: 'info', local: true, args: '', help: 'List who you have muted.',
    run: function () {
      var k = Object.keys(muted);
      return k.length ? 'Muted: ' + k.join(', ') : 'You have not muted anyone.';
    }
  });
  cmd('fps', {
    cat: 'info', local: true, args: '', help: 'Report your frame rate.',
    run: function () { return Math.round(CHAT.fps) + ' fps'; }
  });
  cmd('ping', {
    cat: 'info', local: true, args: '', help: 'Report the gap between server snapshots.',
    run: function (ctx) {
      if (!ctx.online) return 'Offline — the simulation is running in this tab.';
      return 'Snapshots landing every ' + Math.round(ctx.game.packetDt || MSPT) + ' ms (server ticks every ' + MSPT + ' ms).';
    }
  });

  return {
    init: init, show: show, hide: hide, open: open, close: close,
    isOpen: function () { return isOpen; },
    push: push, system: system, clear: clear, submit: submit,
    fps: 0,
    // Slide clear of the upgrade cards, which own the same corner.
    setTop: function (px) { box.style.top = px + 'px'; }
  };
})();
