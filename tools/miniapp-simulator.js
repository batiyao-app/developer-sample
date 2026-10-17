#!/usr/bin/env node
// A stand-in for Batiyao, on your own machine, for building a mini app.
//
//   node tools/miniapp-simulator.js [folder] [--port 3100]
//   (or: npm run miniapp)
//
// Open http://localhost:3100. Your app runs in a sandboxed frame with the
// same rules Batiyao uses: no origin, nothing outside the folder, no network.
// The page around it answers the SDK like Batiyao does — saved data, a
// payment sheet drawn from your manifest, purchases, consume, a share sheet
// and a photo/video picker — and logs every call. Nothing here talks to
// Batiyao, and no BuckBuck moves.
//
// Picking: the simulator draws a photo again on a canvas like Batiyao does
// (upright, scaled, PNG stays PNG, else JPEG), but passes a video through as
// it is. Batiyao also removes a video's location, camera details and time;
// the simulator doesn't. To try the "unavailable" answer (a child whose
// guardian hasn't allowed photos and videos), use the switch on the page or
// open http://localhost:3100/?pick=unavailable.
//
// Nicknames, the shared store and multiplayer live in this Node process, so
// every browser tab is its own player and they all share one store and one
// set of matches, like people on Batiyao. Open two tabs to play against
// yourself. A tab opened with /?age=minor is a child: it chooses a nickname
// from suggestions only, and plays only with other child tabs. The page's
// switch (or /?mp=off, /?mp=ask_guardian) tries multiplayer switched off for
// the app, or a child whose guardian hasn't allowed playing online. Nothing
// is kept when the simulator stops.
//
// Batiyao's AI (SDK 1.4.0): ai.image, ai.audio and ai.ask answer with
// stand-ins — a picture with your words on it, a tone, a canned answer — so
// you can build the flow. The real ones run on a phone. Try the other
// answers with the page's AI switch, or /?ai=needs_download, /?ai=unavailable.
//
// Network (SDK 1.5.0): the addresses your manifest declares in "network"
// are let through as if a Batiyao admin had approved them all (connect-src,
// img-src and media-src, https and wss); every other host stays blocked.
// "Admin review (simulated)" on the page lists each declared address and AI
// capability with Approve / Decline; all start approved.
//
// audio (SDK 1.9.0): the simulator stands in for Batiyao's own player — the
// one voice messages use. The app hands over tracks ({ file } of its own, a
// Blob, or an approved address) and the page plays them, with Batiyao's bar
// above the app and its "Keep playing when you leave?" sheet the first time
// an app asks for background playing (granted only when "media.background"
// is declared and the simulated admin review approves it).
//
// net.fetch (SDK 1.8.0): the simulator stands in for the phone app's native
// request (lib/miniapp-net.js, made from this Node process on your machine),
// under the phone's rules: only when "net.fetch" is declared in
// "capabilities" and approved in the admin review, only to the declared and
// approved addresses (every redirect re-checked), never a private or local
// address, no cookies, Batiyao's User-Agent. On batiyao.com it isn't
// available (a browser can't get around CORS): supports('net') is false.
//
// Links and invites (SDK 1.5.0): open http://localhost:3100/?join=ABC234 to
// start the app as if from an invite link (getContext().link is
// { join: 'ABC234' }); the page's "Follow a link" button sends the 'link'
// event to a running app. multiplayer.invite() shows Batiyao's invite sheet
// with the link to the match.
//
// It is a convenience, not the judge: before you upload, test on Batiyao
// itself (Built by me → your app → Test), which runs the real host.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { checkBundle, origins, sourceList, connectionAllowlist, originAllows } = require('../lib/miniapp-rules');
const netFetch = require('../lib/miniapp-net');
const { readFolder } = require('./pack-miniapp');
const social = require('../lib/miniapp-social');

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
};

// Batiyao removes these before your code runs (CSP can't stop WebRTC). It
// also keeps the device's files away from your app except through
// pickImage()/pickVideo(): no file chooser opens from your page, and
// input.files is always empty. (Batiyao's own guard does more; this is the
// part you'd notice.)
const GUARD = '<script>(function(){["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel"].forEach(function(k){try{delete window[k]}catch(e){}});' +
  'var isF=function(el){return el instanceof HTMLInputElement&&String(el.type).toLowerCase()==="file"};' +
  'var isFL=function(el){return isF(el)||(el instanceof HTMLLabelElement&&isF(el.control))};' +
  'try{var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"files");Object.defineProperty(HTMLInputElement.prototype,"files",{configurable:false,get:function(){return isF(this)?null:d.get.call(this)},set:function(){}})}catch(e){}' +
  'try{var ck=HTMLElement.prototype.click;Object.defineProperty(HTMLElement.prototype,"click",{configurable:false,writable:false,value:function(){if(isFL(this))return;return ck.apply(this,arguments)}})}catch(e){}' +
  'window.addEventListener("click",function(e){var t=e.target;if(!(t instanceof Element))return;var l=t.closest("label");if(isFL(t)||(l&&isFL(l)))e.preventDefault()},true)' +
  '})();</script>';

// net: the declared addresses, as Batiyao names approved ones — data,
// images, sound and video only, never scripts, styles or fonts.
function fileHeaders(base, net = []) {
  const extra = net.length ? ' ' + sourceList(net).join(' ') : '';
  return {
    'Content-Security-Policy': [
      'sandbox allow-scripts allow-forms', "default-src 'none'",
      `script-src ${base} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`, `style-src ${base} 'unsafe-inline'`,
      `img-src ${base} data: blob:${extra}`, `media-src ${base} data: blob:${extra}`, `font-src ${base} data:`,
      `connect-src ${base} data: blob:${extra}`, 'worker-src blob:', "frame-src 'none'", "object-src 'none'",
      "form-action 'none'", "base-uri 'none'",
    ].join('; '),
    'Connection-Allowlist': connectionAllowlist(net),
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
}

// The address Batiyao gives the app (the real one is shown on your app's
// page); the simulator makes one from the name.
const slugOf = (manifest) => String(manifest.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';

const HOST_PAGE = (manifest) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${manifest.name.replace(/[<&]/g, '')} — mini app simulator</title>
<style>
  body{margin:0;font:14px system-ui,sans-serif;display:grid;grid-template-columns:minmax(320px,420px) 1fr;height:100vh;background:#0f172a;color:#e2e8f0}
  #stage{position:relative;display:flex;flex-direction:column;background:#fff}
  #bar{display:flex;gap:8px;align-items:center;padding:8px 12px;background:#fff;color:#0f172a;border-bottom:1px solid #e2e8f0}
  #bar b{flex:1} #bar small{color:#b45309;background:#fef3c7;padding:2px 6px;border-radius:4px;font-weight:600}
  iframe{flex:1;border:0;width:100%}
  #log{overflow:auto;padding:12px;font:12px ui-monospace,monospace;white-space:pre-wrap}
  #log .err{color:#fca5a5} #log .ev{color:#93c5fd}
  #sheet,.sheetlike{position:absolute;inset:0;background:rgba(0,0,0,.5);display:none;align-items:flex-end}
  #sheet .card,.sheetlike .card{background:#fff;color:#0f172a;width:100%;padding:16px;border-radius:16px 16px 0 0}
  .sheetlike .note{font-size:12px;background:#fffbeb;padding:8px;border-radius:8px;margin:10px 0}
  .sheetlike button{padding:10px;border-radius:8px;border:1px solid #cbd5e1;font:inherit;cursor:pointer}
  .sheetlike .pay{background:#2563eb;color:#fff;border-color:#2563eb} .sheetlike .row{display:grid;grid-template-columns:1fr 1.4fr;gap:8px}
  #sheet dl div{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #f1f5f9}
  #sheet dt{color:#64748b} #sheet .note{font-size:12px;background:#fffbeb;padding:8px;border-radius:8px;margin:10px 0}
  #sheet button{padding:10px;border-radius:8px;border:1px solid #cbd5e1;font:inherit;cursor:pointer}
  #sheet .pay{background:#2563eb;color:#fff;border-color:#2563eb} #sheet .row{display:grid;grid-template-columns:1fr 1.4fr;gap:8px}
  #tools{padding:8px 12px;border-bottom:1px solid #1e293b} #tools button{font:inherit;margin-right:6px}
  #admin{padding:8px 12px;border-bottom:1px solid #1e293b;background:#111c33} #admin small{color:#94a3b8}
  #admin .item{display:flex;gap:10px;align-items:center;margin-top:4px} #admin .item code{flex:1;color:#e2e8f0}
  #admin .declined code{color:#fca5a5;text-decoration:line-through}
</style></head><body>
<div id="stage">
  <div id="bar"><b>${manifest.name.replace(/[<&]/g, '')}</b><small>SIMULATOR</small><button id="reload">Reload</button></div>
  <iframe id="app" sandbox="allow-scripts allow-forms" src="/app/${manifest.entry || 'index.html'}"></iframe>
  <div id="share-sheet" class="sheetlike"><div class="card">
    <p><b>Share from ${manifest.name.replace(/[<&]/g, '')}</b><br><small>The sheet Batiyao draws: the person picks Story or Post and may change the words</small></p>
    <img id="sh-img" alt="" style="max-width:100%;max-height:40vh;display:none;border:1px solid #e2e8f0;border-radius:8px">
    <video id="sh-video" controls playsinline style="max-width:100%;max-height:40vh;display:none;border-radius:8px;background:#000"></video>
    <audio id="sh-audio" controls style="width:100%;display:none"></audio>
    <p id="sh-media-note" class="note" style="display:none"></p>
    <p id="sh-text" style="white-space:pre-wrap"></p>
    <p class="note">In the simulator nothing is posted. On Batiyao, your app is never told whether the person shared.</p>
    <div class="row"><button id="sh-cancel">Cancel</button><button id="sh-ok" class="pay">Share</button></div>
  </div></div>
  <div id="pick-sheet" class="sheetlike"><div class="card">
    <p><b id="pk-title"></b><br><small>The sheet Batiyao draws: only the file the person chooses goes to your app</small></p>
    <p id="pk-body" class="note"></p>
    <p id="pk-problem" style="color:#b91c1c;display:none"></p>
    <div class="row"><button id="pk-cancel">Cancel</button><button id="pk-choose" class="pay"></button></div>
    <input id="pk-input" type="file" style="display:none">
  </div></div>
  <div id="nick-sheet" class="sheetlike"><div class="card">
    <p><b>Your nickname in ${manifest.name.replace(/[<&]/g, '')}</b><br><small>The sheet Batiyao draws: the app only gets the nickname</small></p>
    <div id="nk-typed"><input id="nk-input" maxlength="40" placeholder="Type a nickname" style="width:100%;padding:8px;font:inherit;box-sizing:border-box"><button id="nk-save" class="pay" style="margin-top:6px;width:100%">Use this nickname</button><p style="margin:10px 0 4px"><small>or pick one:</small></p></div>
    <div id="nk-sugg" style="display:flex;flex-wrap:wrap;gap:6px"></div>
    <p id="nk-problem" style="color:#b91c1c;display:none"></p>
    <div class="row" style="margin-top:10px"><button id="nk-cancel">Cancel</button><button id="nk-more">More names</button></div>
  </div></div>
  <div id="invite-sheet" class="sheetlike"><div class="card">
    <p><b>Invite to ${manifest.name.replace(/[<&]/g, '')}</b><br><small>The sheet Batiyao draws: copy the link, or share or send it</small></p>
    <p class="note">Code <b id="iv-code"></b><br><span id="iv-link" style="word-break:break-all"></span></p>
    <p class="note">Whoever opens the link gets your app with getContext().link = { join: code }. Your app is only told that the sheet closed.</p>
    <div class="row"><button id="iv-close">Close</button><button id="iv-copy" class="pay">Copy link</button></div>
  </div></div>
  <div id="bg-sheet" class="sheetlike"><div class="card">
    <p><b>Keep playing when you leave?</b><br><small>The sheet Batiyao draws the first time an app plays with background: true</small></p>
    <p class="note">Batiyao can go on playing this app's sound after you leave Batiyao or lock the screen. You can stop it from the bar, the notification or the lock screen, and switch it off in the app's menu.</p>
    <div class="row"><button id="bg-no">Not now</button><button id="bg-yes" class="pay">Keep playing</button></div>
  </div></div>
  <div id="mp-sheet" class="sheetlike"><div class="card">
    <p><b>Playing online</b></p>
    <p class="note">A guardian needs to allow playing online in mini apps for this account. (Simulated: your app will hear "unavailable".)</p>
    <div class="row"><button id="mp-close">Close</button><button id="mp-ask" class="pay">Ask my guardian</button></div>
  </div></div>
  <div id="sheet"><div class="card">
    <p><b id="s-title"></b><br><small>Made by @you · this is the sheet Batiyao draws</small></p>
    <dl><div><dt>You get</dt><dd id="s-statement"></dd></div><div><dt><b>Total</b></dt><dd><b id="s-amount"></b></dd></div></dl>
    <p class="note">${manifest.name.replace(/[<&]/g, '')} is made by you, not by Batiyao. In the simulator no BuckBuck moves.</p>
    <div class="row"><button id="s-cancel">Cancel</button><button id="s-pay" class="pay">Pay</button></div>
  </div></div>
</div>
<div><div id="admin"><b>Admin review (simulated)</b> <small>On Batiyao an admin approves or declines each of these; here everything you declare starts approved. Decline one to see how your app copes.</small><div id="admin-items"></div></div><div id="tools"><button id="clear-storage">Clear saved data</button><button id="clear-purchases">Clear purchases</button><button id="visibility">Send visibility: hidden, then visible</button><label><input type="checkbox" id="pick-unavailable"> Photos and videos: unavailable (a child without the guardian's switch)</label><br>
<button id="nickname">Nickname in this app</button><button id="follow-link">Follow a link…</button><button id="clear-shared">Clear the shared store</button>
<label>Batiyao's AI: <select id="ai-mode"><option value="ready">ready</option><option value="needs_download">needs a download</option><option value="unavailable">unavailable</option></select></label>
<label>Multiplayer: <select id="mp-mode"><option value="on">on</option><option value="off">off for this app</option><option value="ask_guardian">a child without the guardian's switch</option></select></label>
<span id="who"></span></div><div id="log"></div></div>
<script>
const MANIFEST = ${JSON.stringify(manifest).replace(/</g, '\\u003c')};
const frame = document.getElementById('app');
const logEl = document.getElementById('log');
const KEY = 'sim:' + MANIFEST.app_id;
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(KEY + k)) ?? d; } catch (e) { return d; } };
const save = (k, v) => localStorage.setItem(KEY + k, JSON.stringify(v));
function log(text, cls) { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = new Date().toLocaleTimeString() + '  ' + text; logEl.prepend(d); }
function reply(id, result, error) { frame.contentWindow.postMessage(error ? { batiyao: 1, id, error } : { batiyao: 1, id, result }, '*'); log((error ? '✗ ' + error.code + ' ' : '← ') + id + ' ' + JSON.stringify(error ? error.message : result), error ? 'err' : ''); }
let paying = null;
let sharing = null;
let picking = null;
const QS = new URLSearchParams(location.search);
// Opened from an invite link: https://batiyao.com/apps/<slug>?join=CODE.
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const LINK = CODE_RE.test((QS.get('join') || '').toUpperCase()) ? { join: QS.get('join').toUpperCase() } : null;
const SLUG = ${JSON.stringify(slugOf(manifest))};
if (QS.get('pick') === 'unavailable') document.getElementById('pick-unavailable').checked = true;
if (['off', 'ask_guardian'].includes(QS.get('mp'))) document.getElementById('mp-mode').value = QS.get('mp');
const MINOR = QS.get('age') === 'minor';
// Each tab is its own player (a duplicated tab keeps its id: the same person twice).
const PLAYER = sessionStorage.getItem('sim:player') || (() => { const id = 'sim-' + Math.random().toString(36).slice(2, 8); sessionStorage.setItem('sim:player', id); return id; })();
document.getElementById('who').textContent = 'You are ' + PLAYER + (MINOR ? ' (a child, 13-15)' : ' (an adult)');
const mpMode = () => document.getElementById('mp-mode').value;
if (['needs_download', 'unavailable'].includes(QS.get('ai'))) document.getElementById('ai-mode').value = QS.get('ai');
const aiMode = () => document.getElementById('ai-mode').value;
const DECLARED = MANIFEST.capabilities || {};
// Capabilities the simulated admin declined: unavailable, as on Batiyao.
const CAPS_DECLINED = new Set();
const CAP_NOT_AI = ['net.fetch', 'media.background'];
const capState = (n) => (CAPS_DECLINED.has(n) ? 'unavailable' : CAP_NOT_AI.includes(n) ? 'ready' : aiMode());
// net.fetch (1.8.0): declared, and not declined in the simulated admin review.
const netOn = () => !!DECLARED['net.fetch'] && !CAPS_DECLINED.has('net.fetch');
const aiCaps = () => Object.fromEntries(Object.entries(DECLARED).map(([n, c]) => [n, { version: c.version, state: capState(n), tools: c.tools || [] }]));
// media.background (1.9.0): declared, and not declined in the simulated
// admin review. The person's own "Keep playing" is asked for separately,
// the first time the app plays with background: true.
const bgGranted = () => !!DECLARED['media.background'] && !CAPS_DECLINED.has('media.background');
const features = () => ['pay', 'share', 'pickImage', 'pickVideo', 'db', 'nickname', 'network', 'files', 'shareMedia', 'audio'].concat(mpMode() === 'off' ? [] : ['multiplayer', 'invite', 'shareInvite'])
  .concat(aiMode() === 'unavailable' ? [] : Object.keys(DECLARED).filter((n) => n.startsWith('ai.') && !CAPS_DECLINED.has(n)))
  .concat(netOn() ? ['net'] : [])
  .concat(bgGranted() ? ['backgroundAudio'] : []);
let aiRunning = null;
let nicking = null;
const KEYRE = /^[A-Za-z0-9_.:-]{1,128}$/;
// Stand-ins for Batiyao's AI: the shape of the real answers, not their content.
async function finishAI(m, p) {
  if (m.method === 'ai.image.generate') {
    const c = document.createElement('canvas'); c.width = 384; c.height = 384;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 384, 384); grad.addColorStop(0, '#7c3aed'); grad.addColorStop(1, '#f59e0b');
    g.fillStyle = grad; g.fillRect(0, 0, 384, 384);
    g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.textAlign = 'center';
    (String(p.prompt).slice(0, 60).match(/.{1,22}/g) || []).forEach((line, i) => g.fillText(line, 192, 150 + i * 26));
    g.font = '14px sans-serif'; g.fillText('simulated BGen picture', 192, 360);
    const image = await new Promise((res) => c.toBlob(res, 'image/png'));
    return reply(m.id, { status: 'made', image, type: 'image/png', width: 384, height: 384, seed: p.seed ?? Math.floor(Math.random() * 2147483647) });
  }
  if (m.method === 'ai.audio.generate') {
    const seconds = p.seconds || (p.kind === 'sound' ? 6 : 15);
    const rate = 22050, n = rate * seconds, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * (p.kind === 'sound' ? 880 : 440) / rate) * 6000, true);
    return reply(m.id, { status: 'made', audio: new Blob([buf], { type: 'audio/wav' }), type: 'audio/wav', seconds, seed: p.seed ?? 1 });
  }
  const text = p.format === 'json' ? '{"simulated": true}' : 'Simulated Batiyao AI answer to: ' + String(p.prompt).slice(0, 200);
  return reply(m.id, { status: 'answered', text, json: p.format === 'json' ? { simulated: true } : null, searched: !!p.web_search });
}

function handle(m) {
  log('→ ' + m.method + ' ' + JSON.stringify(m.params || {}));
  const p = m.params || {};
  const storage = load(':storage', {});
  const purchases = load(':purchases', []);
  const bad = (code, message) => reply(m.id, null, { code, message });
  switch (m.method) {
    case 'ready': return reply(m.id, {});
    case 'getContext': {
      const ctx = { app_user_id: PLAYER, platform: 'web', locale: navigator.language, theme: 'light', version: MANIFEST.version, test_mode: true, access: { type: MANIFEST.access.type, active: true }, features: features(), capabilities: aiCaps() };
      if (LINK) ctx.link = LINK;
      return reply(m.id, ctx);
    }
    case 'storage.get': if (!KEYRE.test(p.key)) return bad('INVALID_KEY', 'bad key'); return reply(m.id, { value: storage[p.key] ?? null });
    case 'storage.set':
      if (!KEYRE.test(p.key)) return bad('INVALID_KEY', 'bad key');
      if (typeof p.value !== 'string' || p.value.length > 4096) return bad('VALUE_TOO_LONG', 'A stored value is text of at most 4,096 characters.');
      if (!(p.key in storage) && Object.keys(storage).length >= 1024) return bad('STORAGE_FULL', 'An app may keep at most 1024 keys.');
      storage[p.key] = p.value; save(':storage', storage); return reply(m.id, { saved: true });
    case 'storage.remove': delete storage[p.key]; save(':storage', storage); return reply(m.id, { removed: true });
    case 'storage.keys': return reply(m.id, { keys: Object.keys(storage).sort() });
    case 'getPurchases': return reply(m.id, { purchases, access: { type: MANIFEST.access.type, active: true } });
    case 'consume': {
      const pu = purchases.find((x) => x.id === p.purchase);
      if (!pu || pu.kind !== 'consumable' || pu.consumed_at) return bad('NOT_CONSUMABLE', "That purchase was already consumed, or isn't a consumable.");
      pu.consumed_at = new Date().toISOString(); save(':purchases', purchases); return reply(m.id, { consumed: true });
    }
    case 'pay': {
      if (busy()) return bad('BUSY', 'Batiyao is already showing a sheet.');
      if (navigator.userActivation && !navigator.userActivation.isActive) return bad('NEEDS_TAP', 'Call pay() from a tap or click.');
      const pr = (MANIFEST.products || []).find((x) => x.id === p.product);
      if (!pr) return bad('NO_SUCH_PRODUCT', "This app doesn't sell that.");
      if (pr.kind === 'permanent' && purchases.some((x) => x.product === pr.id)) return reply(m.id, { status: 'failed', reason: 'already_owned' });
      paying = { id: m.id, pr };
      document.getElementById('s-title').textContent = pr.title;
      document.getElementById('s-statement').textContent = pr.statement;
      document.getElementById('s-amount').textContent = pr.price + ' BuckBuck';
      document.getElementById('sheet').style.display = 'flex';
      return;
    }
    case 'share': {
      if (busy()) return bad('BUSY', 'Batiyao is already showing a sheet.');
      if (navigator.userActivation && !navigator.userActivation.isActive) return bad('NEEDS_TAP', 'Call share() from a tap or click.');
      const img = typeof p.image === 'string' ? p.image : '';
      const text = typeof p.text === 'string' ? p.text : '';
      // A video or a sound (1.6.0): a Blob; Batiyao re-encodes it.
      const video = p.video instanceof Blob ? p.video : null;
      const audio = p.audio instanceof Blob ? p.audio : null;
      if ((p.video != null && !video) || (p.audio != null && !audio)) return bad('INVALID', 'share() takes a video or a sound as a Blob.');
      if ((video && audio) || (video && img)) return bad('INVALID', 'share() takes one picture, video or sound (a sound may come with a picture).');
      if (video && video.size > 20 * 1024 * 1024) return bad('VIDEO_TOO_LARGE', 'A video to share is at most 20 MB.');
      if (audio && audio.size > 10 * 1024 * 1024) return bad('AUDIO_TOO_LARGE', 'A sound to share is at most 10 MB.');
      if (img && !/^data:image\\/(png|jpeg);base64,/.test(img)) return bad('INVALID_IMAGE', 'The image must be a PNG or JPEG data: URL.');
      if (text.length > 380) return bad('INVALID_TEXT', 'Suggested text is at most 380 characters.');
      if (/(^|[^\\p{L}\\p{N}_])@[\\p{L}\\p{N}_]/u.test(text)) return bad('INVALID_TEXT', 'Suggested text can\\'t tag people (@).');
      if (/(^|[^\\p{L}\\p{N}_&])#[\\p{L}\\p{N}_]/u.test(text)) return bad('INVALID_TEXT', 'Suggested text can\\'t contain hashtags (#).');
      if (/(https?:\\/\\/|www\\.)/i.test(text)) return bad('INVALID_TEXT', 'Suggested text can\\'t contain links.');
      // share({ invite: true }) (1.7.0): the link joins the person's match.
      const invite = p.invite === true;
      if (invite && !(inMatch && matchCode)) return bad('NOT_IN_MATCH', 'share({ invite: true }) works while the person is in a match.');
      if (!img && !text && !video && !audio && !invite) return bad('INVALID', 'share() needs a picture, a video, a sound, text, or a mix.');
      sharing = m.id;
      const media = video || audio;
      const showSheet = (seconds) => {
        const el = document.getElementById('sh-img');
        el.style.display = img ? 'block' : 'none';
        if (img) el.src = img;
        const v = document.getElementById('sh-video'), a = document.getElementById('sh-audio'), note = document.getElementById('sh-media-note');
        v.style.display = video ? 'block' : 'none';
        a.style.display = audio ? 'block' : 'none';
        note.style.display = media ? 'block' : 'none';
        if (video) v.src = URL.createObjectURL(video);
        if (audio) a.src = URL.createObjectURL(audio);
        if (media) {
          const story = seconds <= 30.5 ? 'Story, Post or Chat' : 'Post or Chat (stories are at most 30 seconds)';
          note.textContent = (video ? 'A video' : 'A sound') + ' of ' + Math.round(seconds) + ' s. On Batiyao it is re-encoded first ('
            + (video ? 'MP4, at most 1280 px and 30 frames a second' : 'M4A; in a post or story it becomes a video of '
            + (img ? 'the picture' : 'your app\\'s icon') + ' with the sound') + ') and can go to ' + story + '.';
        }
        document.getElementById('sh-text').textContent = invite
          ? (text || 'Join me in ' + MANIFEST.name + '!') + '\\n\\nJoin my game in ' + MANIFEST.name + ': https://batiyao.com/apps/' + SLUG + '?join=' + matchCode
            + '\\n(Post or Chat; a story cannot carry the link.)'
          : text;
        document.getElementById('share-sheet').style.display = 'flex';
      };
      if (!media) { showSheet(0); return; }
      // How long it is: what the media element says (Batiyao measures the file).
      const probe = document.createElement(video ? 'video' : 'audio');
      const url = URL.createObjectURL(media);
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        const seconds = probe.duration;
        const max = video ? 60 : 300;
        if (!Number.isFinite(seconds) || seconds > max + 0.5) {
          sharing = null;
          return bad(video ? 'VIDEO_TOO_LONG' : 'AUDIO_TOO_LONG', 'A ' + (video ? 'video' : 'sound') + ' to share is at most ' + max + ' seconds.');
        }
        showSheet(seconds);
      };
      probe.onerror = () => {
        URL.revokeObjectURL(url);
        sharing = null;
        bad(video ? 'VIDEO_INVALID' : 'AUDIO_INVALID', 'The ' + (video ? 'video' : 'sound') + ' can\\'t be read.');
      };
      probe.src = url;
      return;
    }
    case 'pickImage':
    case 'pickVideo': {
      const image = m.method === 'pickImage';
      if (busy()) return bad('BUSY', 'Batiyao is already showing a sheet.');
      let limit;
      if (image) {
        limit = p.max_size === undefined ? 2048 : p.max_size;
        if (!Number.isInteger(limit) || limit < 64 || limit > 4096) return bad('INVALID', 'pickImage() max_size is a whole number from 64 to 4096.');
      } else {
        limit = p.max_seconds === undefined ? 600 : p.max_seconds;
        if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1 || limit > 600) return bad('INVALID', 'pickVideo() max_seconds is a number from 1 to 600.');
      }
      if (navigator.userActivation && !navigator.userActivation.isActive) return bad('NEEDS_TAP', 'Call ' + m.method + '() from a tap or click.');
      picking = { id: m.id, image, limit };
      openPick();
      return;
    }
    case 'ai.image.generate':
    case 'ai.audio.generate':
    case 'ai.ask': {
      const cap = m.method === 'ai.ask' ? 'ai.assistant' : m.method.replace('.generate', '');
      if (!DECLARED[cap]) return bad('NOT_DECLARED', 'Add "' + cap + '" to "capabilities" in manifest.json to use it.');
      if (m.method !== 'ai.ask' && navigator.userActivation && !navigator.userActivation.isActive) return bad('NEEDS_TAP', 'Call it from a tap or click.');
      if (aiRunning || busy()) return bad('BUSY', 'One AI request at a time.');
      if (capState(cap) === 'unavailable') return reply(m.id, { status: 'unavailable' });
      if (p.web_search && !(DECLARED[cap].tools || []).includes('web_search')) return bad('NOT_DECLARED', 'Add "tools": ["web_search"] to ai.assistant in manifest.json.');
      if (aiMode() === 'needs_download') log('(Batiyao would ask the person to download the model first)', 'ev');
      aiRunning = { id: m.id, timers: [] };
      const steps = m.method === 'ai.image.generate' ? 5 : 3;
      for (let i = 1; i <= steps; i++) {
        aiRunning.timers.push(setTimeout(() => frame.contentWindow.postMessage({ batiyao: 1, event: 'ai.progress', data: { request: m.id, stage: m.method === 'ai.ask' && p.web_search && i === 1 ? 'searching' : 'making', done: i, total: steps } }, '*'), i * 300));
      }
      aiRunning.timers.push(setTimeout(() => { aiRunning = null; finishAI(m, p).catch((e) => bad('FAILED', String(e))); }, steps * 300 + 200));
      return;
    }
    case 'ai.cancel':
      if (aiRunning) { aiRunning.timers.forEach(clearTimeout); reply(aiRunning.id, { status: 'cancelled' }); aiRunning = null; }
      return reply(m.id, {});
    case 'close': reply(m.id, {}); log('the app asked to close', 'ev'); return;
    default:
      if (SOCIAL[m.method]) return SOCIAL[m.method](m, p).catch((e) => bad((e && e.code) || 'FAILED', String(e && e.message || e)));
      return bad('UNKNOWN_METHOD', 'Batiyao doesn\\'t know "' + m.method + '".');
  }
}
function endPay(result) {
  document.getElementById('sheet').style.display = 'none';
  const p = paying; paying = null;
  if (result.status === 'paid') {
    const purchases = load(':purchases', []);
    const pu = { id: 'sim-' + Date.now().toString(36), product: p.pr.id, kind: p.pr.kind, purchased_at: new Date().toISOString() };
    purchases.push(pu); save(':purchases', purchases); result.purchase = pu;
  }
  reply(p.id, result);
}
document.getElementById('s-pay').onclick = () => endPay({ status: 'paid' });
document.getElementById('s-cancel').onclick = () => endPay({ status: 'cancelled' });
function endShare(how) {
  document.getElementById('share-sheet').style.display = 'none';
  for (const id of ['sh-video', 'sh-audio']) {
    const el = document.getElementById(id);
    if (el.src) { URL.revokeObjectURL(el.src); el.removeAttribute('src'); }
  }
  const id = sharing; sharing = null;
  log('the person chose: ' + how + ' (your app only hears that the sheet closed)', 'ev');
  reply(id, {});
}
document.getElementById('sh-ok').onclick = () => endShare('share');
// --- the picker sheet ---
function openPick() {
  const noun = picking.image ? 'photo' : 'video';
  const unavailable = document.getElementById('pick-unavailable').checked;
  picking.unavailable = unavailable;
  document.getElementById('pk-title').textContent = MANIFEST.name + ' asks for a ' + noun;
  document.getElementById('pk-body').textContent = unavailable
    ? 'A guardian needs to allow giving photos and videos to mini apps for this account. (Simulated: your app will hear "unavailable".)'
    : 'Only the ' + noun + ' you choose goes to the app. Batiyao removes where it was taken, the camera and the time first.' + (picking.image ? '' : ' (The simulator passes videos through unchanged.)');
  document.getElementById('pk-choose').style.display = unavailable ? 'none' : '';
  document.getElementById('pk-choose').textContent = 'Choose a ' + noun;
  document.getElementById('pk-cancel').textContent = unavailable ? 'Close' : 'Cancel';
  document.getElementById('pk-problem').style.display = 'none';
  const input = document.getElementById('pk-input');
  input.accept = picking.image ? 'image/*' : 'video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm';
  document.getElementById('pick-sheet').style.display = 'flex';
}
function endPick(result) {
  document.getElementById('pick-sheet').style.display = 'none';
  const pk = picking; picking = null;
  frame.contentWindow.postMessage({ batiyao: 1, id: pk.id, result }, '*');
  const shown = Object.assign({}, result);
  if (shown.image) shown.image = 'Blob(' + shown.image.size + ' bytes)';
  if (shown.video) shown.video = 'Blob(' + shown.video.size + ' bytes)';
  log('← ' + pk.id + ' ' + JSON.stringify(shown));
}
function pickProblem(message) {
  const el = document.getElementById('pk-problem');
  el.textContent = message; el.style.display = 'block';
  document.getElementById('pk-choose').textContent = 'Choose another ' + (picking.image ? 'photo' : 'video');
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Batiyao can't open this picture. Choose another one.")); };
    img.src = url;
  });
}
async function prepareImage(file, max) {
  if (!/^image\\//.test(file.type) && !/\\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i.test(file.name)) throw new Error("That isn't a picture. Choose a photo.");
  if (file.size > 50 * 1024 * 1024) throw new Error('This picture is over 50 MB. Choose a smaller one.');
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale)), height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const png = file.type === 'image/png' || /\\.png$/i.test(file.name);
  if (!png) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); }
  ctx.drawImage(img, 0, 0, width, height);
  const blob = (type, q) => new Promise((res) => canvas.toBlob(res, type, q));
  if (png) {
    const out = await blob('image/png');
    if (out && out.size <= 10 * 1024 * 1024) return { status: 'picked', image: out, type: 'image/png', width, height };
    ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
  }
  return { status: 'picked', image: await blob('image/jpeg', 0.9), type: 'image/jpeg', width, height };
}
function videoFacts(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }); };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Batiyao can't play this video here, so the app couldn't either. Choose another one.")); };
    v.src = url;
  });
}
async function prepareVideo(file, maxSeconds) {
  let type = null;
  if (file.type === 'video/mp4' || /\\.(mp4|m4v)$/i.test(file.name)) type = 'video/mp4';
  else if (file.type === 'video/quicktime' || /\\.mov$/i.test(file.name)) type = 'video/quicktime';
  else if (file.type === 'video/webm' || /\\.webm$/i.test(file.name)) type = 'video/webm';
  if (!type) throw new Error('Choose an MP4, MOV or WebM video.');
  if (file.size > 100 * 1024 * 1024) throw new Error('This video is over 100 MB. Choose a shorter one.');
  const f = await videoFacts(file);
  if (!Number.isFinite(f.duration) || f.duration <= 0) throw new Error("Batiyao can't tell how long this video is. Choose another one.");
  if (f.duration > maxSeconds + 0.5) throw new Error('This app takes videos up to ' + maxSeconds + ' seconds long. Choose a shorter one.');
  // Passed through unchanged here. Batiyao removes the video's metadata.
  const video = new Blob([file], { type });
  return { status: 'picked', video, type, size: video.size, duration: Math.round(f.duration * 1000) / 1000, width: f.width, height: f.height };
}
document.getElementById('pk-choose').onclick = () => { const i = document.getElementById('pk-input'); i.value = ''; i.click(); };
document.getElementById('pk-cancel').onclick = () => endPick({ status: picking.unavailable ? 'unavailable' : 'cancelled' });
document.getElementById('pk-input').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file || !picking) return;
  try {
    endPick(picking.image ? await prepareImage(file, picking.limit) : await prepareVideo(file, picking.limit));
  } catch (err) {
    pickProblem(err.message);
  }
};
document.getElementById('sh-cancel').onclick = () => endShare('cancel');
// --- nicknames, the shared store, multiplayer (state is in the simulator's Node process) ---
const busy = () => !!(paying || sharing || picking || nicking || inviting || bgAsking);
let NET_OK = [];
const tapped = () => !navigator.userActivation || navigator.userActivation.isActive;
// The simulated admin review: one Approve / Decline per declared address
// and AI capability. An address change reloads the app (it is the page's
// CSP); a capability change applies to the next call.
function renderAdmin(state) {
  const box = document.getElementById('admin-items');
  box.textContent = '';
  const items = state.network.map((x) => ({ kind: 'network', label: 'Network ' + x.name, ...x }))
    .concat(state.caps.map((x) => ({ kind: 'caps', label: (x.name === 'net.fetch' ? 'Downloads ' : x.name === 'media.background' ? 'Background playing ' : 'AI ') + x.name, ...x })));
  // The addresses the player may read a track from, as the frame's CSP has them.
  NET_OK = state.network.filter((x) => x.approved).map((x) => x.name);
  if (!items.length) { box.textContent = 'Nothing declared that needs an admin (network, capabilities).'; return; }
  CAPS_DECLINED.clear();
  for (const it of items) {
    if (it.kind === 'caps' && !it.approved) CAPS_DECLINED.add(it.name);
    const row = document.createElement('div');
    row.className = 'item' + (it.approved ? '' : ' declined');
    const code = document.createElement('code');
    code.textContent = it.label;
    row.appendChild(code);
    for (const [label, value] of [['Approve', true], ['Decline', false]]) {
      const l = document.createElement('label');
      const r = document.createElement('input');
      r.type = 'radio'; r.name = it.kind + ':' + it.name; r.checked = it.approved === value;
      r.onchange = async () => {
        const res = await api('admin.set', { kind: it.kind, name: it.name, approved: value });
        log('admin (simulated): ' + (value ? 'approved ' : 'declined ') + it.label + (it.kind === 'network' ? ' — reloading the app' : ''), 'ev');
        renderAdmin(res.result);
        if (it.kind === 'network') frame.src = frame.src;
      };
      l.append(r, ' ' + label);
      row.appendChild(l);
    }
    box.appendChild(row);
  }
}
async function api(op, params) {
  const res = await fetch('/sim/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ op, player: PLAYER, minor: MINOR }, params || {})) });
  return res.json();
}
async function relay(m, op, params) {
  const r = await api(op, params);
  if (r.error) reply(m.id, null, r.error); else reply(m.id, r.result);
}
function event(name, data) {
  frame.contentWindow.postMessage({ batiyao: 1, event: name, data }, '*');
  log('⇠ event ' + name + ' ' + JSON.stringify(data), 'ev');
}
// Batiyao's nickname sheet; resolves the nickname, or null if closed.
function askNickname() {
  return new Promise((resolve) => {
    nicking = { resolve };
    document.getElementById('nk-typed').style.display = MINOR ? 'none' : '';
    document.getElementById('nk-problem').style.display = 'none';
    document.getElementById('nk-input').value = '';
    document.getElementById('nick-sheet').style.display = 'flex';
    loadSuggestions();
  });
}
async function loadSuggestions() {
  const r = await api('nickname.suggestions');
  const box = document.getElementById('nk-sugg');
  box.textContent = '';
  for (const sgg of (r.result ? r.result.suggestions : [])) {
    const b = document.createElement('button');
    b.textContent = sgg.nickname;
    b.onclick = () => saveNickname({ nickname: sgg.nickname, offer: sgg.offer });
    box.appendChild(b);
  }
}
async function saveNickname(params) {
  const r = await api('nickname.set', params);
  if (r.error) { const el = document.getElementById('nk-problem'); el.textContent = r.error.message; el.style.display = 'block'; return; }
  endNick(r.result.nickname);
}
function endNick(nickname) {
  document.getElementById('nick-sheet').style.display = 'none';
  const n = nicking; nicking = null;
  if (n) n.resolve(nickname);
}
document.getElementById('nk-save').onclick = () => saveNickname({ nickname: document.getElementById('nk-input').value });
document.getElementById('nk-more').onclick = () => loadSuggestions();
document.getElementById('nk-cancel').onclick = () => endNick(null);
document.getElementById('nickname').onclick = async () => {
  if (busy()) return;
  const nickname = await askNickname();
  if (nickname) event('nickname', { nickname });
};
document.getElementById('clear-shared').onclick = async () => { await api('db.clear'); log('shared store cleared', 'ev'); };
let es = null, CONN = null, inMatch = false, matchCode = null, inviting = null;
function ensureConn() {
  if (es) return Promise.resolve();
  CONN = 'c' + Math.random().toString(36).slice(2, 10);
  return new Promise((resolve, reject) => {
    es = new EventSource('/sim/mp/events?conn=' + CONN + '&player=' + encodeURIComponent(PLAYER) + '&minor=' + (MINOR ? 1 : 0));
    es.onopen = () => resolve();
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'closed') { inMatch = false; matchCode = null; }
      event('mp.' + ev.type, ev.data);
    };
    es.onerror = () => {
      const was = es; es = null; CONN = null; was.close();
      if (inMatch) { inMatch = false; event('mp.closed', { reason: 'connection_lost' }); }
      reject(new Error('connection lost'));
    };
  });
}
let guarding = null;
document.getElementById('mp-close').onclick = () => { document.getElementById('mp-sheet').style.display = 'none'; const g = guarding; guarding = null; nicking = null; if (g) reply(g, { status: 'unavailable' }); };
document.getElementById('mp-ask').onclick = () => { log('the person asked their guardian (simulated)', 'ev'); document.getElementById('mp-close').onclick(); };
async function enterMatch(m, p, op) {
  if (busy()) return reply(m.id, null, { code: 'BUSY', message: 'Batiyao is already showing a sheet.' });
  if (!tapped()) return reply(m.id, null, { code: 'NEEDS_TAP', message: 'Call multiplayer.' + op.slice(3) + '() from a tap or click.' });
  const mode = mpMode();
  if (mode === 'off') return reply(m.id, { status: 'unavailable' });
  if (mode === 'ask_guardian') { guarding = m.id; nicking = { resolve() {} }; document.getElementById('mp-sheet').style.display = 'flex'; return; }
  const cur = await api('nickname.get');
  if (!(cur.result && cur.result.nickname)) {
    const nickname = await askNickname();
    if (!nickname) return reply(m.id, { status: 'cancelled' });
  }
  try { await ensureConn(); } catch (e) { return reply(m.id, null, { code: 'OFFLINE', message: 'No connection to the simulator.' }); }
  const r = await api(op, Object.assign({}, p, { conn: CONN }));
  if (r.error) return reply(m.id, null, r.error);
  inMatch = true;
  matchCode = r.result.match && r.result.match.code;
  reply(m.id, { status: 'joined', match: r.result.match });
}
// --- Batiyao.files (1.6.0): the app's own pictures, sounds and videos on
// this device. Batiyao keeps them in its own storage, one space per person
// and app; here, in the simulator's IndexedDB. The bytes decide the type.
const FILE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const FILE_MAX = 50 * 1024 * 1024, SPACE_MAX = 200 * 1024 * 1024, SPACE_FILES = 500;
function sniffType(h, hint) {
  const at = (off, codes) => codes.every((c, i) => h[off + i] === c);
  const str = (off, t) => at(off, Array.from(t, (ch) => ch.charCodeAt(0)));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: 'image/png', kind: 'image' };
  if (at(0, [0xff, 0xd8, 0xff])) return { type: 'image/jpeg', kind: 'image' };
  if (str(0, 'GIF87a') || str(0, 'GIF89a')) return { type: 'image/gif', kind: 'image' };
  if (str(0, 'RIFF') && str(8, 'WEBP')) return { type: 'image/webp', kind: 'image' };
  if (str(0, 'RIFF') && str(8, 'WAVE')) return { type: 'audio/wav', kind: 'audio' };
  if (str(0, 'ID3') || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return { type: 'audio/mpeg', kind: 'audio' };
  if (str(0, 'OggS')) return { type: 'audio/ogg', kind: 'audio' };
  if (str(4, 'ftyp')) return str(8, 'M4A ') || str(8, 'M4B ') ? { type: 'audio/mp4', kind: 'audio' } : { type: 'video/mp4', kind: 'video' };
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return String(hint || '').toLowerCase().startsWith('audio/') ? { type: 'audio/webm', kind: 'audio' } : { type: 'video/webm', kind: 'video' };
  return null;
}
const SPACE = PLAYER + ':' + MANIFEST.app_id + ':test';
function filesDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('sim-miniapp-files', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'k' }).createIndex('space', 'space');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(Object.assign(new Error('This browser can’t keep files.'), { code: 'STORAGE_UNAVAILABLE' }));
  });
}
async function filesTx(mode, fn) {
  const db = await filesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => { db.close(); resolve(out); };
    tx.onerror = tx.onabort = () => { db.close(); reject(Object.assign(new Error('Batiyao couldn’t keep the file.'), { code: tx.error && tx.error.name === 'QuotaExceededError' ? 'STORAGE_FULL' : 'STORAGE_UNAVAILABLE' })); };
  });
}
const fileRows = async () => (await filesTx('readonly', (st) => st.index('space').getAll(SPACE))) || [];
const fileInfo = (r) => ({ name: r.name, type: r.type, kind: r.kind, size: r.size, saved_at: r.saved_at });
const fileErr = (code, message) => Object.assign(new Error(message), { code });
// keepFile applies Batiyao's rules to one file (files.save, and net.fetch's
// response: 'file'); it throws an error with the code.
async function keepFile(name, file) {
  if (typeof name !== 'string' || !FILE_NAME_RE.test(name)) throw fileErr('INVALID_NAME', 'A file name is 1-128 letters, digits, "_", "." or "-", not starting with "." or "-".');
  if (!(file instanceof Blob) || file.size === 0) throw fileErr('INVALID', 'files.save() needs a non-empty Blob.');
  if (file.size > FILE_MAX) throw fileErr('FILE_TOO_LARGE', 'A file is at most 50 MB.');
  const t = sniffType(new Uint8Array(await file.slice(0, 16).arrayBuffer()), file.type);
  if (!t) throw fileErr('UNSUPPORTED_TYPE', 'Only pictures (PNG, JPEG, GIF, WebP), sounds (WAV, MP3, M4A, Ogg, WebM) and videos (MP4, WebM) can be kept.');
  const all = await fileRows();
  const old = all.find((r) => r.name === name);
  const used = all.reduce((n, r) => n + r.size, 0) - (old ? old.size : 0);
  if (!old && all.length >= SPACE_FILES) throw fileErr('STORAGE_FULL', 'At most 500 files per app.');
  if (used + file.size > SPACE_MAX) throw fileErr('STORAGE_FULL', 'This app’s 200 MB on this device is full.');
  const row = { k: SPACE + '/' + name, space: SPACE, name, type: t.type, kind: t.kind, size: file.size, saved_at: new Date().toISOString(), blob: file.slice(0, file.size, t.type) };
  await filesTx('readwrite', (st) => st.put(row));
  return fileInfo(row);
}
// --- audio (1.9.0): this page stands in for Batiyao's own player — the one
// voice messages use. The app hands over tracks; the player plays them, with
// Batiyao's bar above the app, and the app never touches the sound. Playing
// on after the person leaves needs the admin's grant (media.background) and
// the person's "Keep playing", exactly as on a phone.
const AUDIO_MAX_TRACKS = 100;
let player = null, queue = [], at = 0, curUrl = null, bgAsking = null, bgAllowed = null, lastSent = { sig: '', t: 0 };
const audioErr = (code, message) => { const e = new Error(message); e.code = code; return e; };
// Background playing: both halves, as the phone asks them.
const bgOn = () => bgGranted() && bgAllowed === true;

function audioState() {
  if (!player || !queue.length) return { state: 'stopped', track: 0, tracks: 0, title: null, artist: null, position_ms: 0, duration_ms: null, background: bgOn() };
  const t = queue[at];
  const dur = isFinite(player.duration) && player.duration > 0 ? Math.round(player.duration * 1000) : null;
  return {
    state: player.ended && at >= queue.length - 1 ? 'stopped' : player.paused ? 'paused' : player.readyState < 3 ? 'loading' : 'playing',
    track: at, tracks: queue.length, title: t.title || null, artist: t.artist || null,
    position_ms: Math.max(0, Math.round(player.currentTime * 1000)), duration_ms: dur, background: bgOn(),
  };
}
// The app hears every change, and the position at most once a second.
function audioEvent() {
  const st = audioState();
  audioStrip(st);
  const sig = st.state + '|' + st.track + '|' + st.tracks;
  const now = Date.now();
  if (sig === lastSent.sig && now - lastSent.t < 1000) return;
  lastSent = { sig: sig, t: now };
  frame.contentWindow.postMessage({ batiyao: 1, event: 'audio.state', data: st }, '*');
}
function audioStrip(st) {
  let el = document.getElementById('audio-strip');
  if (st.state === 'stopped') { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'audio-strip';
    el.style.cssText = 'position:absolute;left:8px;right:8px;top:8px;background:#0f172a;color:#fff;padding:8px 10px;border-radius:10px;display:flex;gap:8px;align-items:center;font-size:13px;z-index:5';
    document.getElementById('stage').appendChild(el);
  }
  el.textContent = '';
  const txt = document.createElement('span');
  txt.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  const secs = (ms) => (ms == null ? '' : Math.floor(ms / 60000) + ':' + String(Math.floor((ms % 60000) / 1000)).padStart(2, '0'));
  txt.textContent = (st.title || MANIFEST.name) + (st.artist ? ' — ' + st.artist : '') + '  ' + (st.state === 'loading' ? 'loading…' : secs(st.position_ms))
    + (st.duration_ms ? ' / ' + secs(st.duration_ms) : '') + (st.tracks > 1 ? '  (' + (st.track + 1) + ' of ' + st.tracks + ')' : '')
    + (st.background ? '  · keeps playing when you leave' : '');
  el.appendChild(txt);
  const add = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; el.appendChild(b); };
  if (st.tracks > 1) add('Prev', () => audioGo(at - 1, !player.paused).then(audioEvent).catch(() => audioEvent()));
  add(st.state === 'paused' ? 'Play' : 'Pause', () => {
    if (player.paused) player.play().catch(() => audioEvent()); else player.pause();
    log('the person used Batiyao’s player', 'ev');
  });
  if (st.tracks > 1) add('Next', () => audioGo(at + 1, !player.paused).then(audioEvent).catch(() => audioEvent()));
  add('Stop', () => { audioStop(); log('the person stopped the sound', 'ev'); audioEvent(); });
}
// The sound a track points at: one of the app's files, a Blob it made, or an
// approved address. Nothing else ever plays.
async function audioSrc(src) {
  if (src instanceof Blob) {
    if (!src.size) throw audioErr('INVALID', 'That sound is empty.');
    if (src.size > FILE_MAX) throw audioErr('FILE_TOO_LARGE', 'A sound is at most 50 MB.');
    const t = sniffType(new Uint8Array(await src.slice(0, 64).arrayBuffer()), src.type);
    if (!t || t.kind !== 'audio') throw audioErr('NOT_AUDIO', 'That is not a sound Batiyao can play.');
    return { url: URL.createObjectURL(src), revoke: true };
  }
  if (src && typeof src === 'object' && typeof src.file === 'string') {
    const row = await filesTx('readonly', (st) => st.get(SPACE + '/' + src.file));
    if (!row) throw audioErr('NOT_FOUND', 'Your app has no file called "' + src.file + '".');
    if (row.kind !== 'audio') throw audioErr('NOT_AUDIO', '"' + row.name + '" is not a sound.');
    return { url: URL.createObjectURL(row.blob), revoke: true };
  }
  const raw = typeof src === 'string' ? src : src && typeof src.url === 'string' ? src.url : null;
  if (!raw) throw audioErr('INVALID', 'A track is { file: name }, a Blob, or an https address on your approved addresses.');
  let u;
  try { u = new URL(raw); } catch (e) { throw audioErr('INVALID', 'That is not an address.'); }
  if (u.protocol !== 'https:') throw audioErr('NET_NOT_ALLOWED', 'Only https addresses play.');
  if (/^(localhost|127\\.|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|\\[?::1)/.test(u.hostname) || !u.hostname.includes('.')) {
    throw audioErr('NET_PRIVATE_ADDRESS', 'Batiyao never reaches this device or its own network.');
  }
  const ok = NET_OK.some((o) => o === u.origin || (o.startsWith('https://*.') && (u.hostname === o.slice(10) || u.hostname.endsWith('.' + o.slice(10)))));
  if (!ok) throw audioErr('NET_NOT_ALLOWED', 'That address is not one of this app’s approved addresses (manifest.json "network").');
  return { url: u.toString(), revoke: false };
}
function audioElement() {
  if (player) return player;
  player = new Audio();
  player.preload = 'auto';
  for (const ev of ['play', 'pause', 'loadedmetadata', 'timeupdate']) player.addEventListener(ev, audioEvent);
  player.addEventListener('ended', () => {
    if (at < queue.length - 1) audioGo(at + 1, true).then(audioEvent).catch(() => audioEvent());
    else audioEvent();
  });
  return player;
}
async function audioGo(index, start) {
  const t = queue[index];
  if (!t) throw audioErr('INVALID', 'There is no such track.');
  const next = await audioSrc(t.src);
  const el = audioElement();
  if (curUrl && curUrl.revoke) URL.revokeObjectURL(curUrl.url);
  curUrl = next; at = index;
  el.src = next.url;
  if (start) {
    try { await el.play(); } catch (e) {
      if (e && e.name === 'NotSupportedError') throw audioErr('NET_FAILED', 'Batiyao could not play that sound.');
      throw audioErr('NEEDS_TAP', 'Play a sound from a tap or click.');
    }
  }
  return audioState();
}
function audioStop() {
  if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
  if (curUrl && curUrl.revoke) URL.revokeObjectURL(curUrl.url);
  curUrl = null; queue = []; at = 0;
  audioStrip({ state: 'stopped' });
}
// Batiyao's sheet: may the sound carry on once the person has left?
function askKeepPlaying() {
  return new Promise((resolve) => {
    bgAsking = resolve;
    document.getElementById('bg-sheet').style.display = 'flex';
  });
}
function endKeepPlaying(yes) {
  document.getElementById('bg-sheet').style.display = 'none';
  bgAllowed = yes;
  const r = bgAsking; bgAsking = null;
  log('the person chose: ' + (yes ? 'keep playing when I leave' : 'not now') + ' (switchable in the app’s menu)', 'ev');
  if (r) r(yes);
}
document.getElementById('bg-yes').onclick = () => endKeepPlaying(true);
document.getElementById('bg-no').onclick = () => endKeepPlaying(false);
const AUDIO = {
  'audio.play': async (m, p) => {
    if (!tapped()) return reply(m.id, null, { code: 'NEEDS_TAP', message: 'Call audio.play() from a tap or click.' });
    const given = Array.isArray(p.tracks) ? p.tracks : [{ src: p.src, title: p.title, artist: p.artist }];
    if (!given.length) return reply(m.id, null, { code: 'INVALID', message: 'play() takes a track, or tracks.' });
    if (given.length > AUDIO_MAX_TRACKS) return reply(m.id, null, { code: 'INVALID', message: 'At most ' + AUDIO_MAX_TRACKS + ' tracks at a time.' });
    const index = Number.isInteger(p.index) ? p.index : 0;
    if (index < 0 || index >= given.length) return reply(m.id, null, { code: 'INVALID', message: 'index is a track in the list.' });
    // Both halves of background playing, as on a phone: the grant, then the
    // person. Asked once a run; after that it is theirs to switch.
    if (p.background) {
      if (!bgGranted()) log('background: true, but media.background is not declared or the simulated admin declined it — the sound will stop with your app', 'ev');
      else if (bgAllowed === null) { if (busy()) return reply(m.id, null, { code: 'BUSY', message: 'Batiyao is already showing a sheet.' }); await askKeepPlaying(); }
    }
    queue = given.map((t) => ({ src: t.src, title: typeof t.title === 'string' ? t.title.slice(0, 120) : '', artist: typeof t.artist === 'string' ? t.artist.slice(0, 120) : null }));
    const st = await audioGo(index, true);
    reply(m.id, st);
    audioEvent();
  },
  'audio.pause': async (m) => { if (player) player.pause(); reply(m.id, audioState()); audioEvent(); },
  'audio.resume': async (m) => {
    if (!player || !queue.length) return reply(m.id, null, { code: 'INVALID', message: 'Nothing of yours is playing.' });
    if (!tapped()) return reply(m.id, null, { code: 'NEEDS_TAP', message: 'Call audio.resume() from a tap or click.' });
    try { await player.play(); } catch (e) { return reply(m.id, null, { code: 'NEEDS_TAP', message: 'Carry on playing from a tap or click.' }); }
    reply(m.id, audioState()); audioEvent();
  },
  'audio.stop': async (m) => { audioStop(); reply(m.id, audioState()); audioEvent(); },
  'audio.seek': async (m, p) => {
    if (!Number.isFinite(p.position_ms) || p.position_ms < 0) return reply(m.id, null, { code: 'INVALID', message: 'position_ms is a number of milliseconds.' });
    if (!player || !queue.length) return reply(m.id, null, { code: 'INVALID', message: 'Nothing of yours is playing.' });
    player.currentTime = p.position_ms / 1000;
    reply(m.id, audioState()); audioEvent();
  },
  'audio.next': async (m) => {
    if (at >= queue.length - 1) return reply(m.id, audioState());
    reply(m.id, await audioGo(at + 1, !player.paused)); audioEvent();
  },
  'audio.previous': async (m) => {
    if (at <= 0) { if (player) player.currentTime = 0; return reply(m.id, audioState()); }
    reply(m.id, await audioGo(at - 1, !player.paused)); audioEvent();
  },
  'audio.state': async (m) => reply(m.id, audioState()),
};
// --- net.fetch (1.8.0): the simulator's Node process stands in for the
// phone app's native request (lib/miniapp-net.js); this page relays it,
// sends progress, and shows Batiyao's "downloading from" strip after 2 s.
const NET_LIMIT = { text: 10485760, json: 10485760, blob: 52428800, file: 52428800 };
const netRunning = new Map();
let netTimes = [], netBytes = 0;
function netStrip() {
  let el = document.getElementById('net-strip');
  const shown = [...netRunning.values()].filter((r) => r.shown);
  if (!shown.length) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'net-strip';
    el.style.cssText = 'position:absolute;left:8px;right:8px;bottom:8px;background:#0f172a;color:#fff;padding:8px 10px;border-radius:10px;display:flex;gap:8px;align-items:center;font-size:13px';
    document.getElementById('stage').appendChild(el);
  }
  const r = shown[0];
  const pct = r.total ? ' ' + Math.round((100 * r.received) / r.total) + '%' : '';
  el.textContent = MANIFEST.name + ' is downloading from ' + r.host + pct + ' ';
  const b = document.createElement('button');
  b.textContent = 'Cancel';
  b.onclick = () => { for (const x of netRunning.values()) x.ctl.abort(); log('net.fetch cancelled by the person', 'ev'); };
  el.appendChild(b);
}
const blobToBase64 = (blob) => new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(blob); });
const NET = {
  'net.fetch': async (m, p) => {
    if (!netOn()) return reply(m.id, null, { code: 'UNKNOWN_METHOD', message: 'net.fetch isn’t declared, or the simulated admin declined it.' });
    if (netRunning.size >= 4) return reply(m.id, null, { code: 'NET_BUSY', message: 'At most 4 net.fetch requests at once.' });
    const now = Date.now();
    netTimes = netTimes.filter((t) => now - t < 60000);
    if (netTimes.length >= 120) return reply(m.id, null, { code: 'NET_RATE_LIMITED', message: 'At most 120 net.fetch requests a minute.' });
    if (netBytes >= 500 * 1048576) return reply(m.id, null, { code: 'NET_QUOTA', message: 'This run has read 500 MB.' });
    netTimes.push(now);
    const response = p.response || 'text';
    if (!NET_LIMIT[response]) return reply(m.id, null, { code: 'INVALID', message: 'response is text, json, blob or file.' });
    if (response === 'file' && (typeof p.name !== 'string' || !FILE_NAME_RE.test(p.name))) return reply(m.id, null, { code: 'INVALID_NAME', message: 'A file name is 1-128 letters, digits, "_", "." or "-".' });
    const rid = typeof p.request_id === 'string' ? p.request_id : m.id;
    let host = '';
    try { host = new URL(p.url).host; } catch (e) { /* the server refuses it */ }
    const run = { ctl: new AbortController(), host, received: 0, total: null, shown: false };
    netRunning.set(rid, run);
    const timer = setTimeout(() => { run.shown = true; netStrip(); }, 2000);
    let lastEvent = 0;
    const progress = (force) => {
      const t = Date.now();
      if (!force && t - lastEvent < 250) return;
      lastEvent = t;
      frame.contentWindow.postMessage({ batiyao: 1, event: 'net.progress', data: { request_id: rid, received: run.received, total: run.total } }, '*');
      if (run.shown) netStrip();
    };
    try {
      const q = { url: p.url, method: p.method, headers: p.headers, response, timeout_ms: p.timeout_ms };
      if (p.body instanceof Blob) q.body_b64 = await blobToBase64(p.body);
      else if (typeof p.body === 'string') q.body_text = p.body;
      const res = await fetch('/sim/net', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q), signal: run.ctl.signal });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))).error || { code: 'NET_FAILED', message: 'The simulator couldn’t make the request.' };
        return reply(m.id, null, e);
      }
      const meta = JSON.parse(atob(res.headers.get('X-Sim-Net')));
      run.total = meta.size;
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        run.received += value.length;
        progress(false);
      }
      progress(true);
      netBytes += run.received;
      const blob = new Blob(chunks, { type: meta.type || 'application/octet-stream' });
      const out = { status: meta.status, status_text: meta.status_text, url: meta.url, headers: meta.headers };
      if (response === 'text') out.text = await blob.text();
      else if (response === 'json') out.json = JSON.parse(await blob.text());
      else if (response === 'blob') Object.assign(out, { blob, type: meta.type, size: blob.size });
      else out.file = await keepFile(p.name, blob);
      reply(m.id, out);
    } catch (e) {
      if (e && e.name === 'AbortError') return reply(m.id, null, { code: 'NET_CANCELLED', message: 'Cancelled.' });
      reply(m.id, null, { code: (e && e.code) || 'NET_FAILED', message: String((e && e.message) || e) });
    } finally {
      clearTimeout(timer);
      netRunning.delete(rid);
      netStrip();
    }
  },
  'net.cancel': async (m, p) => {
    const run = netRunning.get(p.request_id);
    if (run) run.ctl.abort();
    reply(m.id, {});
  },
};
const FILES = {
  ...NET,
  ...AUDIO,
  'files.save': async (m, p) => {
    reply(m.id, Object.assign({ saved: true }, await keepFile(p.name, p.file)));
  },
  'files.get': async (m, p) => {
    if (typeof p.name !== 'string' || !FILE_NAME_RE.test(p.name)) return reply(m.id, null, { code: 'INVALID_NAME', message: 'That isn’t a file name.' });
    const r = await filesTx('readonly', (st) => st.get(SPACE + '/' + p.name));
    reply(m.id, r ? Object.assign(fileInfo(r), { file: r.blob }) : { file: null });
  },
  'files.list': async (m) => reply(m.id, { files: (await fileRows()).map(fileInfo).sort((a, b) => a.name.localeCompare(b.name)) }),
  'files.remove': async (m, p) => {
    if (typeof p.name !== 'string' || !FILE_NAME_RE.test(p.name)) return reply(m.id, null, { code: 'INVALID_NAME', message: 'That isn’t a file name.' });
    await filesTx('readwrite', (st) => st.delete(SPACE + '/' + p.name));
    reply(m.id, { removed: true });
  },
  'files.usage': async (m) => {
    const all = await fileRows();
    reply(m.id, { bytes: all.reduce((n, r) => n + r.size, 0), limit: SPACE_MAX, count: all.length, max_files: SPACE_FILES });
  },
};
const SOCIAL = {
  ...FILES,
  'getNickname': async (m, p) => {
    const ask = !!p.ask, tap = tapped();
    const cur = await api('nickname.get');
    if (cur.error) return reply(m.id, null, cur.error);
    if (cur.result.nickname || !ask) return reply(m.id, { nickname: cur.result.nickname });
    if (busy()) return reply(m.id, null, { code: 'BUSY', message: 'Batiyao is already showing a sheet.' });
    if (!tap) return reply(m.id, null, { code: 'NEEDS_TAP', message: 'Call getNickname({ ask: true }) from a tap or click.' });
    reply(m.id, { nickname: await askNickname() });
  },
  'db.set': (m, p) => relay(m, 'db.set', { key: p.key, value: p.value, replaceable: p.replaceable, rank: p.rank }),
  'db.get': (m, p) => relay(m, 'db.get', { key: p.key, of: p.player }),
  'db.list': (m, p) => relay(m, 'db.list', { key: p.key, order: p.order, limit: p.limit, cursor: p.cursor }),
  'db.remove': (m, p) => relay(m, 'db.remove', { key: p.key }),
  'db.usage': (m) => relay(m, 'db.usage'),
  'mp.host': (m, p) => enterMatch(m, p, 'mp.host'),
  'mp.join': (m, p) => enterMatch(m, p, 'mp.join'),
  'mp.list': async (m) => { if (mpMode() === 'off') return reply(m.id, { matches: [] }); try { await ensureConn(); } catch (e) { return reply(m.id, null, { code: 'OFFLINE', message: 'No connection to the simulator.' }); } return relay(m, 'mp.list', { conn: CONN }); },
  'mp.send': async (m, p) => { if (!CONN) return reply(m.id, null, { code: 'NOT_IN_MATCH', message: "You're not in a match." }); return relay(m, 'mp.send', { conn: CONN, data: p.data, to: p.to }); },
  // Batiyao's invite sheet: the link to this match. Like share(), the app
  // only hears that the sheet closed.
  'mp.invite': async (m) => {
    if (busy()) return reply(m.id, null, { code: 'BUSY', message: 'Batiyao is already showing a sheet.' });
    if (!tapped()) return reply(m.id, null, { code: 'NEEDS_TAP', message: 'Call multiplayer.invite() from a tap or click.' });
    if (!CONN || !inMatch || !matchCode) return reply(m.id, null, { code: 'NOT_IN_MATCH', message: "You're not in a match." });
    inviting = m.id;
    const link = 'https://batiyao.com/apps/' + SLUG + '?join=' + matchCode;
    document.getElementById('iv-code').textContent = matchCode;
    document.getElementById('iv-link').textContent = link;
    document.getElementById('invite-sheet').style.display = 'flex';
  },
  'mp.leave': async (m) => {
    if (!CONN) return reply(m.id, null, { code: 'NOT_IN_MATCH', message: "You're not in a match." });
    const r = await api('mp.leave', { conn: CONN });
    if (!r.error) inMatch = false;
    if (r.error) reply(m.id, null, r.error); else reply(m.id, r.result);
  },
};
function endInvite(how) {
  document.getElementById('invite-sheet').style.display = 'none';
  const id = inviting; inviting = null;
  log('the person chose: ' + how + ' (your app only hears that the sheet closed)', 'ev');
  if (id) reply(id, {});
}
document.getElementById('iv-close').onclick = () => endInvite('close');
document.getElementById('iv-copy').onclick = () => {
  const link = document.getElementById('iv-link').textContent;
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).catch(() => {});
  log('copied ' + link + ' (open it here as ' + location.origin + '/?join=' + matchCode + ')', 'ev');
  endInvite('copy');
};
document.getElementById('follow-link').onclick = () => {
  const code = (prompt('A match code from an invite link (6 letters and digits):') || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) return log('not a match code: ' + code, 'err');
  frame.contentWindow.postMessage({ batiyao: 1, event: 'link', data: { join: code } }, '*');
  log('event link ' + JSON.stringify({ join: code }), 'ev');
};
const loadAdmin = () => api('admin.get').then((r) => r.result && renderAdmin(r.result)).catch(() => {});
loadAdmin();
// Reload also picks up a manifest you edited (new addresses or capabilities).
document.getElementById('reload').onclick = () => { loadAdmin(); frame.src = frame.src; };
document.getElementById('clear-storage').onclick = () => { save(':storage', {}); log('saved data cleared', 'ev'); };
document.getElementById('clear-purchases').onclick = () => { save(':purchases', []); log('purchases cleared', 'ev'); };
document.getElementById('visibility').onclick = () => {
  frame.contentWindow.postMessage({ batiyao: 1, event: 'visibility', data: { visible: false } }, '*');
  setTimeout(() => frame.contentWindow.postMessage({ batiyao: 1, event: 'visibility', data: { visible: true } }, '*'), 1500);
  log('visibility: hidden, then visible', 'ev');
};
window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (!m || m.batiyao !== 1 || typeof m.id !== 'string' || typeof m.method !== 'string') return;
  handle(m);
});
</script></body></html>`;

// ---------------------------------------------------------------------------
// Nicknames, the shared store and multiplayer, kept in this process for every
// tab. Same rules and answers as Batiyao (lib/miniapp-social.js).

const NICK_OFFER_MS = 60 * 60 * 1000;
const MP = { minPlayers: 2, maxPlayers: 8, metaBytes: 256, dataBytes: 1024, perSecond: 20, burst: 40,
  matchesPerApp: 500, idleMs: 10 * 60 * 1000, lifetimeMs: 4 * 60 * 60 * 1000 };

// net.fetch, standing in for the phone app's native request: the page posts
// { url, method, headers, body_b64 | body_text,
// response, timeout_ms }; the answer is the bytes, with what Batiyao says
// about them in X-Sim-Net (base64 JSON). A closed request cancels.
function simNet(req, res, ctx) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 30 * 1024 * 1024) req.destroy(); else chunks.push(c); });
  req.on('end', async () => {
    const answerError = (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: (e && e.code) || 'NET_FAILED', message: String((e && e.message) || e) } }));
    };
    let q;
    try { q = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return answerError({ code: 'INVALID', message: 'Bad request.' }); }
    if (!ctx.on()) return answerError({ code: 'UNKNOWN_METHOD', message: 'net.fetch isn’t declared in "capabilities", or the simulated admin declined it.' });
    const allowed = ctx.origins();
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      const out = await netFetch.fetchOnce({
        url: q.url, method: q.method, headers: q.headers, response: q.response, timeoutMs: q.timeout_ms, slug: ctx.slug,
        body: q.body_b64 != null ? Buffer.from(q.body_b64, 'base64') : q.body_text != null ? q.body_text : null,
        allowed: (u) => allowed.some((o) => originAllows(o, u)), signal: abort.signal,
      });
      const meta = { status: out.status, status_text: out.status_text, url: out.url, headers: out.headers, type: out.type, size: out.body.length };
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'X-Sim-Net': Buffer.from(JSON.stringify(meta)).toString('base64'), 'Content-Length': out.body.length });
      res.end(out.body);
    } catch (e) {
      answerError(e);
    }
  });
}

function createSimState() {
  const sim = { nicknames: new Map(), offers: new Map(), records: new Map(), matches: new Map(), conns: new Map(), testMode: true,
    // The simulated admin's decisions: everything declared is approved
    // until you decline it on the page.
    declined: { network: new Set(), caps: new Set() }, declared: () => ({ network: [], caps: [] }) };
  sim.sweeper = setInterval(() => sweepMatches(sim), 30 * 1000);
  sim.sweeper.unref();
  return sim;
}

const fail = (code, message) => ({ error: { code, message } });
const jsonBytes = (v) => { try { const s = JSON.stringify(v); return typeof s === 'string' ? Buffer.byteLength(s) : -1; } catch (e) { return -1; } };
const playerView = (sim, id) => ({ id, nickname: (sim.nicknames.get(String(id).replace(/~\d+$/, '')) || {}).nickname || null });

function simAPI(sim, req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
  req.on('end', () => {
    let out;
    try { out = simOp(sim, JSON.parse(body || '{}')); } catch (e) { out = fail('INVALID', 'Bad request: ' + e.message); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
  });
}

function simOp(sim, q) {
  const player = typeof q.player === 'string' && q.player ? q.player : 'sim-anonymous';
  const ok = (result) => ({ result });
  switch (q.op) {
    // --- the simulated admin review
    case 'admin.get':
    case 'admin.set': {
      if (q.op === 'admin.set') {
        const set = q.kind === 'network' ? sim.declined.network : q.kind === 'caps' ? sim.declined.caps : null;
        if (!set || typeof q.name !== 'string') return fail('INVALID', 'kind is network or caps, with a name');
        if (q.approved) set.delete(q.name); else set.add(q.name);
      }
      const d = sim.declared();
      return ok({
        network: d.network.map((name) => ({ name, approved: !sim.declined.network.has(name) })),
        caps: d.caps.map((name) => ({ name, approved: !sim.declined.caps.has(name) })),
      });
    }
    // --- nicknames
    case 'nickname.get': {
      const n = sim.nicknames.get(player);
      return ok({ nickname: n ? n.nickname : null, kind: n ? n.kind : null });
    }
    case 'nickname.suggestions': {
      const suggestions = social.suggestNicknames(6).map((nickname) => {
        const offer = require('node:crypto').randomBytes(12).toString('hex');
        sim.offers.set(offer, { player, nickname, until: Date.now() + NICK_OFFER_MS });
        return { nickname, offer };
      });
      return ok({ suggestions, can_type: !q.minor });
    }
    case 'nickname.set': {
      let nickname, kind;
      if (q.offer) {
        const o = sim.offers.get(q.offer);
        if (!o || o.player !== player || o.nickname !== q.nickname || o.until < Date.now()) return fail('NICKNAME_OFFER', 'That suggestion has expired. Pick another.');
        nickname = o.nickname; kind = 'suggested';
      } else {
        if (q.minor) return fail('NICKNAME_OFFER', 'Choose one of the suggested nicknames.');
        const c = social.checkNickname(q.nickname);
        if (c.problem) return fail('NICKNAME_INVALID', c.problem);
        nickname = c.nickname; kind = 'typed';
      }
      sim.nicknames.set(player, { nickname, kind });
      return ok({ nickname, kind });
    }
    // --- the shared store
    case 'db.set': {
      if (!social.KEY_RE.test(q.key)) return fail('INVALID_KEY', 'Keys are 1-128 letters, digits, "_", ".", ":" or "-".');
      if (typeof q.value !== 'string') return fail('INVALID', 'A value is text.');
      if (Buffer.byteLength(q.value) > social.VALUE_LIMIT) return fail('VALUE_TOO_LONG', 'A value is at most 1,024 bytes.');
      const rank = q.rank == null ? null : q.rank;
      if (rank !== null && (typeof rank !== 'number' || !Number.isFinite(rank))) return fail('INVALID', 'rank is a finite number.');
      const incoming = { player, key: q.key, size: social.recordSize(q.key, q.value), rank, replaceable: !!q.replaceable };
      const plan = social.planWrite([...sim.records.values()], incoming);
      if (plan.error) return fail('STORE_FULL', 'The shared store is full and nothing in it may be replaced.');
      if (!plan.save) return ok({ saved: false });
      for (const r of plan.evict) sim.records.delete(r.player + '\n' + r.key);
      sim.records.set(player + '\n' + q.key, { ...incoming, value: q.value, updated_at: Date.now() });
      return ok({ saved: true });
    }
    case 'db.get': {
      if (!social.KEY_RE.test(q.key)) return fail('INVALID_KEY', 'Keys are 1-128 letters, digits, "_", ".", ":" or "-".');
      const owner = typeof q.of === 'string' && q.of ? q.of : player;
      const r = sim.records.get(owner + '\n' + q.key);
      return ok({ record: r ? recordView(sim, r) : null });
    }
    case 'db.list': {
      if (!social.KEY_RE.test(q.key)) return fail('INVALID_KEY', 'Keys are 1-128 letters, digits, "_", ".", ":" or "-".');
      const order = q.order == null ? 'rank_desc' : q.order;
      if (!['rank_desc', 'rank_asc', 'recent'].includes(order)) return fail('INVALID', 'order is rank_desc, rank_asc or recent.');
      const limit = q.limit == null ? 20 : q.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('INVALID', 'limit is a whole number from 1 to 100.');
      const from = q.cursor == null ? 0 : Number(q.cursor);
      if (!Number.isInteger(from) || from < 0) return fail('INVALID', 'cursor is the next value from the last page.');
      const all = [...sim.records.values()].filter((r) => r.key === q.key);
      all.sort((a, b) => {
        if (order === 'recent') return b.updated_at - a.updated_at;
        if ((a.rank == null) !== (b.rank == null)) return a.rank == null ? 1 : -1; // unranked last
        if (a.rank !== b.rank) return order === 'rank_desc' ? b.rank - a.rank : a.rank - b.rank;
        return a.updated_at - b.updated_at; // first to get there first
      });
      const page = all.slice(from, from + limit);
      return ok({ records: page.map((r) => recordView(sim, r)), next: from + limit < all.length ? String(from + limit) : null });
    }
    case 'db.remove':
      if (!social.KEY_RE.test(q.key)) return fail('INVALID_KEY', 'Keys are 1-128 letters, digits, "_", ".", ":" or "-".');
      sim.records.delete(player + '\n' + q.key);
      return ok({ removed: true });
    case 'db.usage':
      return ok({ bytes: [...sim.records.values()].reduce((n, r) => n + r.size, 0), limit: social.STORE_LIMIT });
    case 'db.clear':
      sim.records.clear();
      return ok({});
    // --- multiplayer
    case 'mp.host': case 'mp.join': case 'mp.list': case 'mp.send': case 'mp.leave': {
      const conn = sim.conns.get(q.conn);
      if (!conn) return fail('OFFLINE', 'Not connected.');
      return mpOp(sim, conn, q);
    }
    default:
      return fail('UNKNOWN_METHOD', 'Unknown simulator call.');
  }
}

function recordView(sim, r) {
  return { player: playerView(sim, r.player), key: r.key, value: r.value, rank: r.rank, replaceable: r.replaceable, updated_at: new Date(r.updated_at).toISOString() };
}

function simEvents(sim, url, req, res) {
  const id = url.searchParams.get('conn');
  const player = url.searchParams.get('player') || 'sim-anonymous';
  if (!id || sim.conns.has(id)) { res.writeHead(400); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const conn = { id, player, space: url.searchParams.get('minor') === '1' ? 'minor-13-15' : 'adult', res, match: null, seatId: null,
    tokens: MP.burst, at: Date.now(), windowStart: Date.now(), windowCount: 0 };
  sim.conns.set(id, conn);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    sim.conns.delete(id);
    if (conn.match) leaveMatch(sim, conn, 'disconnected');
  });
}

function emit(conn, type, data) {
  try { conn.res.write('data: ' + JSON.stringify({ type, data }) + '\n\n'); } catch (e) { /* gone */ }
}

const matchPlayers = (sim, m) => m.conns.map((c) => playerView(sim, c.seatId));
function matchView(sim, m, me) {
  return { id: m.id, code: m.code, max_players: m.max, public: m.public, meta: m.meta, host: m.host.seatId, me: me.seatId, players: matchPlayers(sim, m) };
}

function seatFor(m, conn) {
  // The same person twice in one match (a test run): the second seat is "<id>~2".
  let seat = conn.player, n = 1;
  while (m.conns.some((c) => c.seatId === seat)) seat = conn.player + '~' + (++n);
  return seat;
}

function mpOp(sim, conn, q) {
  const ok = (result) => ({ result });
  switch (q.op) {
    case 'mp.host': {
      if (conn.match) return fail('ALREADY_IN_MATCH', "You're already in a match. Leave it first.");
      const max = q.max_players;
      if (!Number.isInteger(max) || max < MP.minPlayers || max > MP.maxPlayers) return fail('INVALID', 'max_players is a whole number from 2 to 8.');
      let meta = q.meta == null ? {} : q.meta;
      if (typeof meta !== 'object' || Array.isArray(meta) || jsonBytes(meta) > MP.metaBytes) return fail('INVALID', 'meta is an object of at most 256 bytes as JSON.');
      if (sim.matches.size >= MP.matchesPerApp) return fail('RATE_LIMITED', 'This app has too many live matches. Try again soon.');
      let code;
      do code = social.matchCode(); while ([...sim.matches.values()].some((m) => m.code === code && m.space === conn.space));
      const m = { id: 'm_' + require('node:crypto').randomBytes(6).toString('hex'), code, max, public: !!q.public, meta, space: conn.space,
        conns: [], host: null, created: Date.now(), lastMessage: Date.now() };
      conn.seatId = seatFor(m, conn);
      m.conns.push(conn); m.host = conn; conn.match = m;
      sim.matches.set(m.id, m);
      return ok({ match: matchView(sim, m, conn) });
    }
    case 'mp.join': {
      if (conn.match) return fail('ALREADY_IN_MATCH', "You're already in a match. Leave it first.");
      let m = null;
      if (typeof q.code === 'string') {
        const code = q.code.trim().toUpperCase();
        if (!social.CODE_RE.test(code)) return fail('INVALID', 'A match code is 6 letters and digits.');
        m = [...sim.matches.values()].find((x) => x.code === code && x.space === conn.space) || null;
      } else if (typeof q.match === 'string') {
        m = sim.matches.get(q.match) || null;
        if (m && m.space !== conn.space) m = null;
      } else return fail('INVALID', 'join() needs { code } or { match }.');
      if (!m) return fail('NO_SUCH_MATCH', 'There is no such match open to you.');
      if (m.conns.length >= m.max) return fail('MATCH_FULL', 'That match is full.');
      conn.seatId = seatFor(m, conn);
      for (const c of m.conns) emit(c, 'joined', { player: playerView(sim, conn.seatId) });
      m.conns.push(conn); conn.match = m;
      return ok({ match: matchView(sim, m, conn) });
    }
    case 'mp.list': {
      const open = [...sim.matches.values()].filter((m) => m.public && m.space === conn.space && m.conns.length < m.max).slice(0, 50);
      return ok({ matches: open.map((m) => ({ id: m.id, players: matchPlayers(sim, m), max_players: m.max, meta: m.meta, host: m.host.seatId })) });
    }
    case 'mp.send': {
      const m = conn.match;
      if (!m) return fail('NOT_IN_MATCH', "You're not in a match.");
      const n = jsonBytes(q.data);
      if (n < 0) return fail('INVALID', 'data must be JSON.');
      if (n > MP.dataBytes) return fail('MESSAGE_TOO_LARGE', 'A message is at most 1,024 bytes as JSON.');
      const now = Date.now();
      if (now - conn.windowStart >= 1000) { conn.windowStart = now; conn.windowCount = 0; }
      conn.windowCount++;
      if (conn.windowCount > MP.perSecond * 3) {
        // Far past the limit: disconnected, like Batiyao.
        emit(conn, 'closed', { reason: 'rate_limited' });
        leaveMatch(sim, conn, 'disconnected');
        return ok({});
      }
      conn.tokens = Math.min(MP.burst, conn.tokens + ((now - conn.at) / 1000) * MP.perSecond);
      conn.at = now;
      if (conn.tokens < 1) return ok({ dropped: true });
      conn.tokens -= 1;
      m.lastMessage = now;
      const from = playerView(sim, conn.seatId);
      for (const c of m.conns) {
        if (c === conn) continue;
        if (q.to != null && c.seatId !== q.to) continue;
        emit(c, 'message', { from, data: q.data });
      }
      return ok({});
    }
    case 'mp.leave':
      if (!conn.match) return fail('NOT_IN_MATCH', "You're not in a match.");
      leaveMatch(sim, conn, 'left');
      return ok({});
  }
  return fail('UNKNOWN_METHOD', 'Unknown simulator call.');
}

function leaveMatch(sim, conn, reason) {
  const m = conn.match;
  if (!m) return;
  const seat = conn.seatId;
  conn.match = null; conn.seatId = null;
  m.conns = m.conns.filter((c) => c !== conn);
  if (m.conns.length === 0) { sim.matches.delete(m.id); return; }
  for (const c of m.conns) emit(c, 'left', { player: playerView(sim, seat), reason });
  if (m.host === conn) {
    m.host = m.conns[0];
    for (const c of m.conns) emit(c, 'host', { player: playerView(sim, m.host.seatId) });
  }
}

function closeMatch(sim, m, reason) {
  for (const c of m.conns) { emit(c, 'closed', { reason }); c.match = null; c.seatId = null; }
  sim.matches.delete(m.id);
}

function sweepMatches(sim, now = Date.now()) {
  for (const m of [...sim.matches.values()]) {
    if (now - m.created > MP.lifetimeMs) closeMatch(sim, m, 'time_limit');
    else if (m.conns.length === 1 && now - m.lastMessage > MP.idleMs) closeMatch(sim, m, 'idle');
  }
}

function main(argv) {
  let dir = path.join(__dirname, '..', 'miniapp', 'wingbeat');
  let port = 3100;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i]);
    else dir = argv[i];
  }
  const files = readFolder(dir);
  const { problems, flags, manifest } = checkBundle(files);
  if (!manifest) {
    console.error(`No usable manifest.json in ${dir}:\n  - ${problems.join('\n  - ')}`);
    return 1;
  }
  for (const p of problems) console.warn(`upload would refuse: ${p}`);
  for (const f of flags) console.warn(`note: ${f} — an admin will look at this before it goes live.`);
  // The simulator plays the app as if a Batiyao admin had already approved
  // everything its manifest declares (owner, 2026-10-16): the addresses in
  // "network", the AI in "capabilities", and multiplayer. The page's
  // switches try the other answers.
  const declaredCaps = Object.keys(manifest.capabilities || {});
  console.log('Approved for this simulation (as if a Batiyao admin had said yes): ' +
    [origins(manifest).length ? `network ${origins(manifest).join(', ')}` : 'no network addresses declared',
      declaredCaps.length ? `capabilities ${declaredCaps.join(', ')}` : null, 'multiplayer'].filter(Boolean).join('; '));
  // The declared addresses are read from manifest.json on every request, so
  // adding or changing "network" shows on Reload, like any other edit (they
  // used to be read once at start, and an address added later stayed blocked).
  let shownNet = '';
  const currentNet = () => {
    let m = manifest;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) { /* keep the last good one */ }
    const net = origins(m);
    const key = net.join(' ');
    if (key !== shownNet) {
      shownNet = key;
      if (!net.length) console.log('network: none declared — every address is blocked');
      for (const o of net) console.log(`network: ${o} is let through (approved in the simulator; on Batiyao, once an admin approves it)`);
    }
    return net;
  };
  currentNet();

  const base = `http://localhost:${port}/app/`;
  const sim = createSimState();
  sim.declared = () => {
    let m = manifest;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) { /* the last good one */ }
    return { network: origins(m), caps: Object.keys((m && m.capabilities) || {}) };
  };
  // What the simulated admin approved, of what is declared now.
  const approvedNet = () => currentNet().filter((o) => !sim.declined.network.has(o));
  // net.fetch (SDK 1.8.0): declared in "capabilities" and not declined in
  // the simulated admin review, and only to the approved addresses.
  const netFetchOn = () => sim.declared().caps.includes('net.fetch') && !sim.declined.caps.has('net.fetch');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === '/sim/api' && req.method === 'POST') return simAPI(sim, req, res);
    if (url.pathname === '/sim/net' && req.method === 'POST') return simNet(req, res, { on: netFetchOn, origins: approvedNet, slug: slugOf(manifest) });
    if (url.pathname === '/sim/mp/events') return simEvents(sim, url, req, res);
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(HOST_PAGE(manifest));
    }
    if (url.pathname.startsWith('/app/')) {
      // Read from disk each time, so a save in your editor shows on Reload.
      const rel = decodeURIComponent(url.pathname.slice(5));
      const full = path.resolve(dir, rel);
      if (!full.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not in the bundle');
      }
      const ext = path.extname(full).slice(1).toLowerCase();
      let data = fs.readFileSync(full);
      if (ext === 'html' || ext === 'htm') {
        const page = data.toString('utf8');
        const m = page.match(/^﻿?\s*<!doctype[^>]*>/i);
        data = Buffer.from(m ? m[0] + GUARD + page.slice(m[0].length) : GUARD + page);
      }
      res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', ...fileHeaders(base, approvedNet()) });
      return res.end(data);
    }
    res.writeHead(404);
    res.end();
  });
  server.on('close', () => clearInterval(sim.sweeper));
  server.listen(port, '127.0.0.1', () => {
    console.log(`Simulating Batiyao for ${manifest.name} ${manifest.version} at http://localhost:${port}`);
  });
  return server;
}

if (require.main === module) {
  const r = main(process.argv.slice(2));
  if (typeof r === 'number') process.exit(r);
}

module.exports = { main, createSimState, simOp, mpOp, sweepMatches, fileHeaders, slugOf };
