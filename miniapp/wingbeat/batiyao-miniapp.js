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
 * on Batiyao's own screen.
 */
(function (global) {
  'use strict';

  var PROTOCOL = 1;
  var VERSION = '1.1.0';
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
     * test_mode, access }. app_user_id is the same for this person every
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
