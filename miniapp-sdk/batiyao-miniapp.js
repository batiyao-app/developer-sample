/*!
 * batiyao-miniapp.js — the Batiyao Mini Apps SDK, protocol v1.
 * MIT licensed. https://github.com/batiyao-app/developer-sample
 *
 * Include this file in your bundle (mini apps can't load anything from the
 * internet) and call Batiyao.ready() once your app has drawn its first screen:
 *
 *   <script src="batiyao-miniapp.js"></script>
 *
 * It talks to the Batiyao page around your app with postMessage. Batiyao —
 * never your app — draws anything that involves the person's money or
 * account, so pay() and share() resolve only after the person has decided
 * on Batiyao's own screen. The same goes for the device's photos and videos:
 * pickImage() and pickVideo() open Batiyao's picker, and your app gets only
 * the one the person chose, with its location and other details removed.
 * And for nicknames: getNickname() shows Batiyao's own sheet; your app only
 * ever gets the nickname.
 *
 * 1.2.0 (2026-10-10): pickImage(), pickVideo() and supports().
 * 1.3.0 (2026-10-10): getNickname(), db (a store shared by everyone in your
 *   app) and multiplayer (real-time matches).
 * 1.4.0 (2026-10-13): ai — Batiyao's AI on the person's phone: pictures
 *   (BGen), sounds (BAudio) and answers (Batiyao AI, with web search if you
 *   ask). Declare each in manifest.json "capabilities"; Batiyao decides.
 *   capability() says whether it works here. On the website and on phones
 *   that can't run it, it resolves { status: 'unavailable' }.
 * 1.5.0 (2026-10-16): links and the network. multiplayer.invite() opens
 *   Batiyao's invite sheet with a link to the match
 *   (https://batiyao.com/apps/<slug>?join=CODE); an app opened from such a
 *   link reads getContext().link ({ join: CODE }), and a link followed while
 *   it runs arrives as the 'link' event. Your app may reach at most two
 *   addresses of your own, declared in manifest.json "network" and each
 *   approved by a Batiyao admin; everything else stays blocked. Requests come
 *   from an opaque origin (Origin: null) with no cookies, so your server
 *   answers with CORS (Access-Control-Allow-Origin: *) and authenticates with
 *   what your app sends.
 */
(function (global) {
  'use strict';

  var PROTOCOL = 1;
  var VERSION = '1.5.0';
  var pending = Object.create(null);
  var listeners = Object.create(null);
  var counter = 0;
  var isFramed = global.parent && global.parent !== global;

  function makeError(code, message) {
    var err = new Error(message || code);
    err.code = code;
    return err;
  }

  // Progress callbacks of running ai requests, by request id.
  var progress = Object.create(null);

  function send(method, params, timeoutMs, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!isFramed) {
        reject(makeError('NO_HOST', 'This page is not running inside Batiyao (or the simulator).'));
        return;
      }
      counter += 1;
      var id = 'm' + counter + '-' + Date.now().toString(36);
      var timer = null;
      if (timeoutMs) {
        timer = setTimeout(function () {
          delete pending[id];
          reject(makeError('TIMEOUT', 'Batiyao did not answer ' + method + '.'));
        }, timeoutMs);
      }
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      if (onProgress) progress[id] = onProgress;
      global.parent.postMessage({ batiyao: PROTOCOL, id: id, method: method, params: params || {} }, '*');
    });
  }

  function receive(data) {
    if (!data || typeof data !== 'object' || data.batiyao !== PROTOCOL) return;
    if (typeof data.id === 'string' && pending[data.id]) {
      var p = pending[data.id];
      delete pending[data.id];
      delete progress[data.id];
      if (p.timer) clearTimeout(p.timer);
      if (data.error) p.reject(makeError(data.error.code, data.error.message));
      else p.resolve(data.result);
      return;
    }
    if (data.event === 'ai.progress' && data.data && typeof data.data.request === 'string') {
      var fn = progress[data.data.request];
      if (fn) {
        try { fn({ stage: data.data.stage, done: data.data.done, total: data.data.total }); } catch (e) { /* the app's own error */ }
      }
      return;
    }
    if (typeof data.event === 'string') {
      var fns = listeners[data.event] || [];
      for (var i = 0; i < fns.length; i++) {
        try { fns[i](data.data); } catch (e) { /* a listener's own error */ }
      }
    }
  }

  global.addEventListener('message', function (e) {
    // Only Batiyao (the frame around this app) speaks the protocol.
    if (e.source !== global.parent) return;
    receive(e.data);
  });

  // What every Batiyao has had since protocol v1, and the optional features
  // a Batiyao from before getContext().features had. Anything newer is only
  // there when the host lists it.
  var CORE = ['ready', 'getContext', 'storage', 'storage.get', 'storage.set', 'storage.remove', 'storage.keys',
    'getPurchases', 'consume', 'close', 'on', 'off', 'supports'];
  var LEGACY_FEATURES = ['pay', 'share'];
  // Method names that belong to one listed feature.
  var FEATURE_OF = { getNickname: 'nickname', 'multiplayer.invite': 'invite', 'ai.image.generate': 'ai.image', 'ai.audio.generate': 'ai.audio', 'ai.ask': 'ai.assistant' };
  var AI_CAPABILITIES = ['ai.image', 'ai.audio', 'ai.assistant'];
  var IMAGE_QUALITY = ['fast', 'balanced', 'best'];
  var AUDIO_SECONDS = { music: [8, 15, 30], sound: [3, 6, 12] };

  function checkText(name, v, min, max, optional) {
    if (v == null && optional) return null;
    if (typeof v !== 'string' || v.trim().length < min || v.length > max) {
      return makeError('INVALID', name + ' is text of ' + min + ' to ' + max + ' characters.');
    }
    return null;
  }

  function checkSeed(seed) {
    if (seed == null) return null;
    if (!isWhole(seed) || seed < 0 || seed > 2147483647) return makeError('INVALID', 'seed is a whole number from 0 to 2147483647.');
    return null;
  }

  function context() {
    if (!contextPromise) {
      contextPromise = send('getContext', {}, 10000).catch(function (e) {
        contextPromise = null;
        throw e;
      });
    }
    return contextPromise;
  }
  var contextPromise = null;

  function isWhole(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
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

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  var CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
  var MP_EVENTS = ['joined', 'left', 'message', 'host', 'closed'];

  function checkKey(key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
      throw makeError('INVALID_KEY', 'Storage keys are 1-128 letters, digits, "_", ".", ":" or "-".');
    }
  }

  var Batiyao = {
    version: VERSION,

    /** Tell Batiyao your app is ready; it removes its loading cover. */
    ready: function () {
      return send('ready', {}, 10000);
    },

    /**
     * Who and where: { app_user_id, platform, locale, theme, version,
     * test_mode, access, features, link? }. features lists the optional methods this
     * Batiyao has (e.g. 'pickImage', 'invite', 'network'); an older Batiyao leaves it out.
     * link is { join: 'ABC234' } when the person opened your app from an
     * invite link (multiplayer.invite()); join the match from a tap. app_user_id is the same for this person every
     * time in your app, and different in every other app. Batiyao never gives
     * a mini app the person's name, contacts or location.
     */
    getContext: function () {
      return send('getContext', {}, 10000);
    },

    /**
     * Ask the person to pay for a product listed in your manifest.json.
     * Batiyao shows its own sheet: what they get (your reviewed statement),
     * the total, and that a third party made your app.
     * Resolves { status: 'paid', purchase } | { status: 'cancelled' } |
     * { status: 'failed', reason } | { status: 'pending' }.
     * Call it from a tap: on the web, a request without one is refused.
     */
    pay: function (options) {
      if (!options || typeof options.product !== 'string') {
        return Promise.reject(makeError('INVALID', 'pay() needs { product: "<id from manifest.json>" }.'));
      }
      return send('pay', { product: options.product });
    },

    /**
     * Offer the person something to share as a post or story: a picture your
     * app made (a <canvas> or a PNG/JPEG data: URL, up to 6 MB, 64-4096 px a
     * side) and suggested words (up to 380 characters; no @tags, #hashtags
     * or links). Batiyao shows its own sheet; the person picks Story or Post,
     * may change the words, and decides. Call it from a tap.
     * Resolves {} when the sheet closes. On purpose, your app is never told
     * whether the person shared: never reward sharing or require it.
     */
    share: function (options) {
      options = options || {};
      var image = options.image;
      if (image && typeof image === 'object' && typeof image.toDataURL === 'function') {
        try { image = image.toDataURL('image/png'); } catch (e) {
          return Promise.reject(makeError('INVALID', 'That canvas can\'t be read.'));
        }
      }
      if (image != null && (typeof image !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(image))) {
        return Promise.reject(makeError('INVALID', 'share() image must be a <canvas> or a PNG/JPEG data: URL.'));
      }
      var text = options.text == null ? '' : options.text;
      if (typeof text !== 'string' || text.length > 380) {
        return Promise.reject(makeError('INVALID', 'share() text is a string of at most 380 characters.'));
      }
      if (!image && !text) {
        return Promise.reject(makeError('INVALID', 'share() needs an image, text, or both.'));
      }
      return send('share', { image: image || '', text: text });
    },

    /**
     * Ask the person for a photo. Batiyao shows its own sheet and the device's
     * picker; your app gets only the photo they choose, drawn again from its
     * pixels: upright, no location, camera or time, its longer side at most
     * max_size pixels (64-4096, default 2048; never enlarged). A PNG stays a
     * PNG, anything else becomes a JPEG. Call it from a tap.
     * Resolves { status: 'picked', image: Blob, type, width, height } |
     * { status: 'cancelled' } | { status: 'unavailable' } (this person can't
     * give photos to mini apps; Batiyao has told them why - carry on without).
     * Check supports('pickImage') first: an older Batiyao rejects UNKNOWN_METHOD.
     */
    pickImage: function (options) {
      options = options || {};
      var params = {};
      if (options.max_size != null) {
        if (!isWhole(options.max_size) || options.max_size < 64 || options.max_size > 4096) {
          return Promise.reject(makeError('INVALID', 'pickImage() max_size is a whole number from 64 to 4096.'));
        }
        params.max_size = options.max_size;
      }
      return send('pickImage', params);
    },

    /**
     * Ask the person for a video (MP4, MOV or WebM, up to 100 MB and
     * max_seconds long: 1-600, default 600). Batiyao shows its own sheet and
     * the device's picker; your app gets only the video they choose, with its
     * location, camera details and recording time removed. The picture and
     * sound are not changed. Call it from a tap.
     * Resolves { status: 'picked', video: Blob, type, size, duration, width,
     * height } | { status: 'cancelled' } | { status: 'unavailable' }.
     * Check supports('pickVideo') first: an older Batiyao rejects UNKNOWN_METHOD.
     */
    pickVideo: function (options) {
      options = options || {};
      var params = {};
      if (options.max_seconds != null) {
        var n = options.max_seconds;
        if (typeof n !== 'number' || !isFinite(n) || n < 1 || n > 600) {
          return Promise.reject(makeError('INVALID', 'pickVideo() max_seconds is a number from 1 to 600.'));
        }
        params.max_seconds = n;
      }
      return send('pickVideo', params);
    },

    /**
     * Does the Batiyao your app is running in have this method? Resolves
     * true or false, never rejects. Use it to show a button only where it
     * works: supports('pickImage'), supports('db'), supports('nickname'),
     * supports('multiplayer'). A Batiyao without getContext().features
     * predates all of these. 'multiplayer' is also false where this person
     * can't play online in your app (it's switched off for it).
     */
    supports: function (name) {
      if (CORE.indexOf(name) >= 0) return Promise.resolve(isFramed);
      if (typeof name === 'string') {
        if (FEATURE_OF[name]) name = FEATURE_OF[name];
        else if (/^(db|multiplayer)\./.test(name)) name = name.split('.')[0];
      }
      return context().then(function (ctx) {
        var f = ctx && ctx.features;
        if (Array.isArray(f)) return f.indexOf(name) >= 0;
        return LEGACY_FEATURES.indexOf(name) >= 0;
      }, function () {
        return false;
      });
    },

    /**
     * Can your app use this capability here? Resolves (never rejects)
     * { supported, version, state, tools }:
     *   supported: this Batiyao has it, at the version your manifest asks for;
     *   state: 'ready' | 'needs_download' (Batiyao asks the person to download
     *     the model the first time) | 'unavailable' (not here, or not for this
     *     person — Batiyao never says why);
     *   tools: what you may use with it (e.g. ['web_search']).
     * Use it to show a button only where it works.
     */
    capability: function (name) {
      var none = { supported: false, version: 0, state: 'unavailable', tools: [] };
      if (AI_CAPABILITIES.indexOf(name) < 0) return Promise.resolve(none);
      return context().then(function (ctx) {
        var c = ctx && ctx.capabilities && ctx.capabilities[name];
        var listed = ctx && Array.isArray(ctx.features) && ctx.features.indexOf(name) >= 0;
        if (!c) return none;
        var state = ['ready', 'needs_download'].indexOf(c.state) >= 0 && listed ? c.state : 'unavailable';
        return { supported: listed, version: c.version || 0, state: state, tools: Array.isArray(c.tools) ? c.tools : [] };
      }, function () {
        return none;
      });
    },

    /**
     * Batiyao's AI, on the person's phone. Declare what you use in
     * manifest.json "capabilities" (with your reason, shown to people before
     * they open your app); a Batiyao admin decides. Nothing you ask leaves
     * the phone, except Batiyao AI's web searches, which go through
     * Batiyao. Every answer is { status: ... }:
     *   'made' / 'answered' — here it is;
     *   'cancelled' — the person stopped it (or the app went to the background);
     *   'unavailable' — not here or not for this person: carry on without it;
     *   'blocked' — Batiyao wouldn't make that: ask for something else.
     * Rejections are your app's mistakes: INVALID, NOT_DECLARED (not in your
     * manifest), NEEDS_TAP (call it from a tap), BUSY (one AI request at a
     * time, or a Batiyao sheet is open), UNKNOWN_METHOD (an older Batiyao).
     * onProgress, if given, is called with { stage, done, total }.
     */
    ai: {
      image: {
        /**
         * A picture from words, by BGen: { prompt (1-400 characters), avoid
         * (what to leave out, up to 200), quality: 'fast' | 'balanced' |
         * 'best' (fast is about 40 s on a phone), seed (the same seed and
         * words make the same picture), onProgress }. Call it from a tap.
         * Resolves { status: 'made', image: Blob, type: 'image/png', width,
         * height, seed } or another status. Pictures are 384 x 384 in
         * version 1.
         */
        generate: function (options) {
          options = options || {};
          var err = checkText('prompt', options.prompt, 1, 400) || checkText('avoid', options.avoid, 0, 200, true) || checkSeed(options.seed);
          if (!err && options.quality != null && IMAGE_QUALITY.indexOf(options.quality) < 0) {
            err = makeError('INVALID', 'quality is fast, balanced or best.');
          }
          if (err) return Promise.reject(err);
          var params = { prompt: options.prompt };
          if (options.avoid != null) params.avoid = options.avoid;
          if (options.quality != null) params.quality = options.quality;
          if (options.seed != null) params.seed = options.seed;
          return send('ai.image.generate', params, 0, options.onProgress);
        }
      },
      audio: {
        /**
         * Music or a sound from words, by BAudio: { prompt (1-400
         * characters), kind: 'music' (8, 15 or 30 seconds; default 15) or
         * 'sound' (3, 6 or 12; default 6), seconds, seed, onProgress }. No
         * singing. Call it from a tap. Resolves { status: 'made', audio:
         * Blob, type: 'audio/wav', seconds, seed } or another status.
         */
        generate: function (options) {
          options = options || {};
          var kind = options.kind == null ? 'music' : options.kind;
          var err = checkText('prompt', options.prompt, 1, 400) || checkSeed(options.seed);
          if (!err && !AUDIO_SECONDS[kind]) err = makeError('INVALID', 'kind is music or sound.');
          if (!err && options.seconds != null && AUDIO_SECONDS[kind].indexOf(options.seconds) < 0) {
            err = makeError('INVALID', kind + ' is ' + AUDIO_SECONDS[kind].join(', ') + ' seconds long.');
          }
          if (err) return Promise.reject(err);
          var params = { prompt: options.prompt, kind: kind };
          if (options.seconds != null) params.seconds = options.seconds;
          if (options.seed != null) params.seed = options.seed;
          return send('ai.audio.generate', params, 0, options.onProgress);
        }
      },
      /**
       * An answer from Batiyao AI: { prompt (1-2000 characters), context
       * (text it should use, up to 8000), web_search (true to let it look
       * things up; needs "tools": ["web_search"] in your manifest), format:
       * 'text' | 'json' (then answer with JSON only; it is parsed for you),
       * max_chars (50-1500, default 800), onProgress }. It can't act on the
       * person's account, and it never gives links: only the answer.
       * Resolves { status: 'answered', text, json, searched } or another
       * status; json is the parsed value when format is 'json', else null.
       */
      ask: function (options) {
        options = options || {};
        var err = checkText('prompt', options.prompt, 1, 2000) || checkText('context', options.context, 0, 8000, true);
        if (!err && options.format != null && options.format !== 'text' && options.format !== 'json') {
          err = makeError('INVALID', 'format is text or json.');
        }
        if (!err && options.max_chars != null && (!isWhole(options.max_chars) || options.max_chars < 50 || options.max_chars > 1500)) {
          err = makeError('INVALID', 'max_chars is a whole number from 50 to 1500.');
        }
        if (err) return Promise.reject(err);
        var params = { prompt: options.prompt, web_search: !!options.web_search };
        if (options.context != null) params.context = options.context;
        if (options.format != null) params.format = options.format;
        if (options.max_chars != null) params.max_chars = options.max_chars;
        return send('ai.ask', params, 0, options.onProgress);
      },
      /** Stop your app's AI request, if one is running. Resolves {}. */
      cancel: function () {
        return send('ai.cancel', {}, 10000).then(function () { return {}; });
      }
    },

    /**
     * What this person has bought in your app: { purchases: [{ id, product,
     * kind, purchased_at, consumed_at }], access: { type, active, until } }.
     * There is no server of yours to ask: this is the record.
     */
    getPurchases: function () {
      return send('getPurchases', {}, 20000);
    },

    /**
     * Mark a consumable as delivered. Credit it in your app's state first
     * (and save that), then consume, so a crash in between can't lose it.
     * A consumable nobody consumes within 24 hours is refunded.
     */
    consume: function (purchaseId) {
      return send('consume', { purchase: purchaseId }, 20000);
    },

    /** Saved data, kept by Batiyao for this person in your app. */
    storage: {
      get: function (key) {
        try { checkKey(key); } catch (e) { return Promise.reject(e); }
        return send('storage.get', { key: key }, 20000).then(function (r) { return r ? r.value : null; });
      },
      set: function (key, value) {
        try { checkKey(key); } catch (e) { return Promise.reject(e); }
        if (typeof value !== 'string') return Promise.reject(makeError('INVALID', 'Stored values are strings; use JSON.stringify.'));
        if (value.length > 4096) return Promise.reject(makeError('VALUE_TOO_LONG', 'A stored value is at most 4,096 characters.'));
        return send('storage.set', { key: key, value: value }, 20000).then(function () { return true; });
      },
      remove: function (key) {
        try { checkKey(key); } catch (e) { return Promise.reject(e); }
        return send('storage.remove', { key: key }, 20000).then(function () { return true; });
      },
      keys: function () {
        return send('storage.keys', {}, 20000).then(function (r) { return r ? r.keys : []; });
      }
    },

    /**
     * This person's nickname in your app: resolves { nickname } (a string, or
     * null if they have none yet). With { ask: true } and no nickname yet,
     * Batiyao shows its own sheet (call it from a tap) and resolves with the
     * one they chose, or null if they closed the sheet. Children choose from
     * Batiyao's suggestions. They can change it from Batiyao's menu at any
     * time: listen with Batiyao.on('nickname', fn).
     */
    getNickname: function (options) {
      var ask = !!(options && options.ask);
      return send('getNickname', ask ? { ask: true } : {}, ask ? 0 : 20000);
    },

    /**
     * A store shared by everyone in your app (1 MB in all; test runs have
     * their own). Each person writes only their own records, one per key;
     * everyone can read them. Mark a write replaceable (with a rank, e.g. a
     * score) and Batiyao may replace it when the store is full: no rank
     * before ranked, lower rank first, older first.
     */
    db: {
      /**
       * Write my record under key (value: text, at most 1,024 bytes).
       * Resolves { saved: true }, or { saved: false } when the store is full
       * and this replaceable write ranks below everything replaceable.
       */
      set: function (key, value, options) {
        try { checkKey(key); } catch (e) { return Promise.reject(e); }
        if (typeof value !== 'string') return Promise.reject(makeError('INVALID', 'db values are strings; use JSON.stringify.'));
        if (utf8Bytes(value) > 1024) return Promise.reject(makeError('VALUE_TOO_LONG', 'A db value is at most 1,024 bytes.'));
        options = options || {};
        var params = { key: key, value: value, replaceable: !!options.replaceable };
        if (options.rank != null) {
          if (typeof options.rank !== 'number' || !isFinite(options.rank)) return Promise.reject(makeError('INVALID', 'db rank is a finite number.'));
          params.rank = options.rank;
        }
        return send('db.set', params, 20000);
      },
      /** One record: mine, or { player: id }'s. Resolves the record or null. */
      get: function (key, options) {
        try { checkKey(key); } catch (e) { return Promise.reject(e); }
        var params = { key: key };
        if (options && options.player != null) {
          if (typeof options.player !== 'string') return Promise.reject(makeError('INVALID', 'player is a player id.'));
          params.player = options.player;
        }
        return send('db.get', params, 20000).then(function (r) { return r ? r.record : null; });
      },
      /**
       * Everyone's record under key: { order: 'rank_desc' | 'rank_asc' |
       * 'recent', limit: 1-100 (20), cursor }. Resolves { records, next }.
       */
      list: function (key, options) {
        try { checkKey(key); } catch (e) { return Promise.reject(e); }
        options = options || {};
        var params = { key: key };
        if (options.order != null) {
          if (['rank_desc', 'rank_asc', 'recent'].indexOf(options.order) < 0) return Promise.reject(makeError('INVALID', 'order is rank_desc, rank_asc or recent.'));
          params.order = options.order;
        }
        if (options.limit != null) {
          if (!isWhole(options.limit) || options.limit < 1 || options.limit > 100) return Promise.reject(makeError('INVALID', 'limit is a whole number from 1 to 100.'));
          params.limit = options.limit;
        }
        if (options.cursor != null) {
          if (typeof options.cursor !== 'string') return Promise.reject(makeError('INVALID', 'cursor is the next value from the last page.'));
          params.cursor = options.cursor;
        }
        return send('db.list', params, 20000);
      },
      /** Remove my record under key. */
      remove: function (key) {
        try { checkKey(key); } catch (e) { return Promise.reject(e); }
        return send('db.remove', { key: key }, 20000).then(function () { return true; });
      },
      /** How full the store is: { bytes, limit }. */
      usage: function () {
        return send('db.usage', {}, 20000);
      }
    },

    /**
     * Real-time matches of 2-8 players, relayed by Batiyao. Only for apps a
     * Batiyao admin has allowed; check supports('multiplayer'). Players are
     * { id, nickname }; Batiyao asks for a nickname before the first match.
     */
    multiplayer: {
      /**
       * Start a match: { max_players: 2-8, public: false, meta: {} (256 bytes
       * of JSON at most) }. Call it from a tap. Resolves { status: 'joined',
       * match } | { status: 'cancelled' } | { status: 'unavailable' }.
       */
      host: function (options) {
        options = options || {};
        if (!isWhole(options.max_players) || options.max_players < 2 || options.max_players > 8) {
          return Promise.reject(makeError('INVALID', 'max_players is a whole number from 2 to 8.'));
        }
        var params = { max_players: options.max_players, public: !!options.public };
        if (options.meta != null) {
          var n = isPlainObject(options.meta) ? jsonBytes(options.meta) : -1;
          if (n < 0 || n > 256) return Promise.reject(makeError('INVALID', 'meta is an object of at most 256 bytes as JSON.'));
          params.meta = options.meta;
        }
        return send('mp.host', params);
      },
      /** Join a match by { code } or { match } (an id from list()). Call it from a tap. Same answers as host(). */
      join: function (options) {
        options = options || {};
        var params = {};
        if (typeof options.code === 'string' && options.match == null) {
          var code = options.code.trim().toUpperCase();
          if (!CODE_RE.test(code)) return Promise.reject(makeError('INVALID', 'A match code is 6 letters and digits.'));
          params.code = code;
        } else if (typeof options.match === 'string' && options.code == null) {
          params.match = options.match;
        } else {
          return Promise.reject(makeError('INVALID', 'join() needs { code } or { match }.'));
        }
        return send('mp.join', params);
      },
      /** Open public matches of your app that this person may join. Resolves an array. */
      list: function () {
        return send('mp.list', {}, 20000).then(function (r) { return r ? r.matches : []; });
      },
      /**
       * Send any JSON (1,024 bytes at most) to everyone in the match, or to
       * { to: playerId }. Resolves at once: there is no delivery receipt, and
       * past 20 messages a second the extra ones are dropped.
       */
      send: function (data, options) {
        var n = jsonBytes(data);
        if (n < 0) return Promise.reject(makeError('INVALID', 'send() takes data that can be sent as JSON.'));
        if (n > 1024) return Promise.reject(makeError('MESSAGE_TOO_LARGE', 'A message is at most 1,024 bytes as JSON.'));
        var params = { data: data };
        if (options && options.to != null) {
          if (typeof options.to !== 'string') return Promise.reject(makeError('INVALID', 'to is a player id.'));
          params.to = options.to;
        }
        if (!isFramed) return Promise.reject(makeError('NO_HOST', 'This page is not running inside Batiyao (or the simulator).'));
        counter += 1;
        global.parent.postMessage({ batiyao: PROTOCOL, id: 's' + counter + '-' + Date.now().toString(36), method: 'mp.send', params: params }, '*');
        return Promise.resolve({});
      },
      /**
       * Invite people to the match you're in: Batiyao opens its own sheet
       * with a link to it (https://batiyao.com/apps/<slug>?join=CODE) and the
       * code, to copy, share or send. Whoever opens the link gets your app
       * with getContext().link = { join: CODE }. Call it from a tap, while in
       * a match (NOT_IN_MATCH otherwise). Resolves {} when the sheet closes,
       * whatever the person did: your app is never told whether they shared.
       * Check supports('invite'): older Batiyao apps reject UNKNOWN_METHOD.
       */
      invite: function () {
        return send('mp.invite', {});
      },
      /** Leave the match you're in. */
      leave: function () {
        return send('mp.leave', {}, 20000);
      },
      /**
       * 'joined' ({ player }), 'left' ({ player, reason }), 'message'
       * ({ from, data }), 'host' ({ player }: the host left, this is the new
       * one) and 'closed' ({ reason }: the match is over for you).
       */
      on: function (event, fn) {
        if (MP_EVENTS.indexOf(event) >= 0) Batiyao.on('mp.' + event, fn);
      },
      off: function (event, fn) {
        if (MP_EVENTS.indexOf(event) >= 0) Batiyao.off('mp.' + event, fn);
      }
    },

    /** Close your app. */
    close: function () {
      return send('close', {}, 10000);
    },

    /**
     * Events from Batiyao: 'theme' ({ theme }), 'visibility' ({ visible }),
     * 'nickname' ({ nickname }: the person changed it from Batiyao's menu),
     * 'link' ({ join }: the person followed an invite link to your app while
     * it was open).
     * Multiplayer events arrive as 'mp.joined' etc.; multiplayer.on() is the
     * same thing without the prefix.
     */
    on: function (event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
    },

    off: function (event, fn) {
      var fns = listeners[event] || [];
      var i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    }
  };

  global.Batiyao = Batiyao;
})(typeof window !== 'undefined' ? window : this);
