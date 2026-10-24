/*!
 * batiyao-cast.js — the SDK for a mini app's TV page, protocol v1.
 * MIT licensed. https://github.com/batiyao-app/developer-sample
 *
 * A mini app can have a TV view: a second page in its bundle, named in
 * manifest.json, that Batiyao shows on a TV when the person taps Batiyao's
 * TV button.
 *
 *   "cast": { "entry": "tv.html", "purpose": "Shows the board so the room can watch." }
 *
 * Include this file in that page (the TV page loads nothing from the
 * internet either) and call BatiyaoCast.ready() once it has drawn:
 *
 *   <script src="batiyao-cast.js"></script>
 *
 * Your app on the phone talks to it with Batiyao.cast.send() (SDK 1.12.0);
 * it hears that here as 'message', and BatiyaoCast.send() answers back. The
 * page runs on a Chromecast (in Batiyao's TV page) and, on an iPhone casting
 * to an Apple TV, in a second web view on the phone: one environment either
 * way. It is sandboxed like your app, with your app's approved addresses
 * only. It has no person, no account and no storage of Batiyao's, and no
 * Batiyao.* calls.
 *
 * When to have one: a view the whole room shares — the board, the scores, a
 * replay, the question everyone answers. Never the private parts of a game
 * (a player's hand, the answer, anything one person shouldn't show the
 * others): the TV page is reviewed with your app, and it is the one thing of
 * it a room full of people sees.
 *
 * Limits, both ways: a message is at most 16 KB as JSON and there are at
 * most 30 a second (CAST_LIMIT beyond). Messages take a moment to arrive (a
 * home network, sometimes the internet): send the state of the game and let
 * this page draw and animate it itself. It is not a video of the phone, and
 * not for frame-by-frame updates.
 *
 * Design for 1920 x 1080, seen from across a room: big type, strong
 * contrast, nothing that needs a tap or a hover (a TV has no touch), and
 * nothing important near the edges (some TVs crop them).
 *
 * 1.1.0 (2026-10-24): this page's uncaught errors and unhandled promise
 *   rejections go to the phone that is casting, into its own log, so a
 *   problem on a TV in somebody's living room can be found (at most 20 a
 *   minute; the error's text and stack only, nothing of your page's data).
 * 1.2.0 (2026-10-24): sound. A TV page's sound starts by itself — nobody can
 *   tap a TV, and Batiyao lets the page play without a tap. An AudioContext
 *   still suspended a moment after ready() (or after it is made) is resumed
 *   once, and reported to the phone's log if it stays suspended.
 */
(function (global) {
  'use strict';

  var PROTOCOL = 1;
  var VERSION = '1.2.0';
  var MAX_BYTES = 16384;
  var PER_SECOND = 30;
  var pending = Object.create(null);
  var listeners = { message: [], ended: [] };
  var sentTimes = [];
  var counter = 0;
  var isFramed = global.parent && global.parent !== global;

  function makeError(code, message) {
    var err = new Error(message || code);
    err.code = code;
    return err;
  }

  function send(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!isFramed) {
        reject(makeError('NO_HOST', 'This page is not running on a Batiyao TV (or the simulator\'s TV pane).'));
        return;
      }
      counter += 1;
      var id = 't' + counter + '-' + Date.now().toString(36);
      var timer = setTimeout(function () {
        delete pending[id];
        reject(makeError('TIMEOUT', 'Batiyao did not answer ' + method + '.'));
      }, timeoutMs);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      global.parent.postMessage({ batiyao: PROTOCOL, id: id, method: method, params: params || {} }, '*');
    });
  }

  // Bytes of UTF-8 in a string (no TextEncoder needed).
  function utf8Bytes(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  // JSON size in bytes, or -1 when the value can't be sent as JSON.
  function jsonBytes(v) {
    var s;
    try { s = JSON.stringify(v); } catch (e) { return -1; }
    return typeof s === 'string' ? utf8Bytes(s) : -1;
  }

  function emit(name, data) {
    var fns = listeners[name].slice();
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](data); } catch (e) { /* a listener's own error */ }
    }
  }

  global.addEventListener('message', function (e) {
    // Only Batiyao (the frame around this page) speaks the protocol.
    if (e.source !== global.parent) return;
    var data = e.data;
    if (!data || typeof data !== 'object' || data.batiyao !== PROTOCOL) return;
    if (typeof data.id === 'string' && pending[data.id]) {
      var p = pending[data.id];
      delete pending[data.id];
      clearTimeout(p.timer);
      if (data.error) p.reject(makeError(data.error.code, data.error.message));
      else p.resolve(data.result);
      return;
    }
    if (data.event === 'cast.message') emit('message', data.data);
    else if (data.event === 'cast.ended') emit('ended', data.data || {});
  });

  // This page's own errors, reported to the phone's log (1.1.0). A TV has
  // no console anybody can see. Never retried, never in the way.
  var logTimes = [];
  function report(text, stack, level) {
    var now = Date.now();
    while (logTimes.length && now - logTimes[0] >= 60000) logTimes.shift();
    if (!isFramed || logTimes.length >= 20) return;
    logTimes.push(now);
    send('cast.log', { level: level === 'warn' ? 'warn' : 'error', text: String(text).slice(0, 1000), stack: stack ? String(stack).slice(0, 4000) : '' }, 10000)
      .catch(function () { /* an older Batiyao: UNKNOWN_METHOD */ });
  }
  global.addEventListener('error', function (e) {
    if (!e || (!e.error && !e.message)) return; // a file that didn't load
    var err = e.error;
    report((err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : e.message) +
      (e.lineno ? ' (' + (e.filename ? String(e.filename).split('/').pop() : '') + ':' + e.lineno + ':' + e.colno + ')' : ''),
      err && err.stack);
  });
  global.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    report('Unhandled rejection: ' + (r && r.message ? (r.name ? r.name + ': ' : '') + r.message : String(r)), r && r.stack);
  });

  // Sound (1.2.0): every AudioContext the page makes is watched, so one the
  // TV keeps suspended is resumed once and, failing that, reported.
  var contexts = [];
  var isReady = false;
  function checkAudio(c) {
    if (!c || c.__batiyaoChecked) return;
    c.__batiyaoChecked = true;
    setTimeout(function () {
      if (c.state !== 'suspended') return;
      var p;
      try { p = c.resume(); } catch (e) { /* closed */ }
      setTimeout(function () {
        if (c.state === 'suspended') {
          report('An AudioContext stayed suspended on the TV: its sound is blocked.', '', 'warn');
        }
      }, 1000);
      if (p && p.catch) p.catch(function () { /* reported above */ });
    }, 2000);
  }
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var AC = global[name];
    if (typeof AC !== 'function') return;
    var Watched = function (options) {
      var c = arguments.length ? new AC(options) : new AC();
      contexts.push(c);
      if (isReady) checkAudio(c);
      return c;
    };
    Watched.prototype = AC.prototype;
    try { global[name] = Watched; } catch (e) { /* read-only: not watched */ }
  });

  var BatiyaoCast = {
    version: VERSION,

    /** Tell Batiyao the page has drawn; the TV's loading screen goes. */
    ready: function () {
      if (!isReady) {
        isReady = true;
        contexts.forEach(checkAudio);
      }
      return send('cast.ready', {}, 10000);
    },

    /**
     * Send JSON to your app on the phone (it hears 'cast.message').
     * Resolves {} once Batiyao has it. At most 16 KB as JSON and 30 a
     * second: CAST_LIMIT beyond.
     */
    send: function (data) {
      var n = jsonBytes(data);
      if (n < 0) return Promise.reject(makeError('INVALID', 'send() takes data that can be sent as JSON.'));
      if (n > MAX_BYTES) return Promise.reject(makeError('CAST_LIMIT', 'A message is at most 16 KB as JSON.'));
      var now = Date.now();
      while (sentTimes.length && now - sentTimes[0] >= 1000) sentTimes.shift();
      if (sentTimes.length >= PER_SECOND) return Promise.reject(makeError('CAST_LIMIT', 'At most 30 messages a second.'));
      if (isFramed) sentTimes.push(now);
      return send('cast.send', { data: data }, 10000);
    },

    /**
     * 'message' (data: what your app sent with Batiyao.cast.send) and
     * 'ended' (the person stopped showing it: Batiyao shows its own screen
     * next, so there is nothing to clean up but your own timers).
     */
    on: function (event, fn) {
      if (listeners[event] && typeof fn === 'function') listeners[event].push(fn);
    },

    off: function (event, fn) {
      var fns = listeners[event] || [];
      var i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    }
  };

  global.BatiyaoCast = BatiyaoCast;
})(typeof window !== 'undefined' ? window : this);
