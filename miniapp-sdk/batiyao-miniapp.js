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
 *
 * 1.2.0 (2026-10-10): pickImage(), pickVideo() and supports().
 */
(function (global) {
  'use strict';

  var PROTOCOL = 1;
  var VERSION = '1.2.0';
  var pending = Object.create(null);
  var listeners = Object.create(null);
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
      global.parent.postMessage({ batiyao: PROTOCOL, id: id, method: method, params: params || {} }, '*');
    });
  }

  function receive(data) {
    if (!data || typeof data !== 'object' || data.batiyao !== PROTOCOL) return;
    if (typeof data.id === 'string' && pending[data.id]) {
      var p = pending[data.id];
      delete pending[data.id];
      if (p.timer) clearTimeout(p.timer);
      if (data.error) p.reject(makeError(data.error.code, data.error.message));
      else p.resolve(data.result);
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
  var contextPromise = null;

  function isWhole(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
  }

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
     * test_mode, access, features }. features lists the optional methods this
     * Batiyao has (e.g. 'pickImage'); an older Batiyao leaves it out. app_user_id is the same for this person every
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
     * works: supports('pickImage'). A Batiyao without getContext().features
     * predates pickImage and pickVideo.
     */
    supports: function (name) {
      if (CORE.indexOf(name) >= 0) return Promise.resolve(isFramed);
      if (!contextPromise) {
        contextPromise = send('getContext', {}, 10000).catch(function (e) {
          contextPromise = null;
          throw e;
        });
      }
      return contextPromise.then(function (ctx) {
        var f = ctx && ctx.features;
        if (Array.isArray(f)) return f.indexOf(name) >= 0;
        return LEGACY_FEATURES.indexOf(name) >= 0;
      }, function () {
        return false;
      });
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

    /** Close your app. */
    close: function () {
      return send('close', {}, 10000);
    },

    /** Events from Batiyao: 'theme' ({ theme }), 'visibility' ({ visible }). */
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
