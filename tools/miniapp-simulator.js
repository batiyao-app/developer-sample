#!/usr/bin/env node
// A stand-in for Batiyao, on your own machine, for building a mini app.
//
//   node tools/miniapp-simulator.js [folder] [--port 3100]
//   (or: npm run miniapp)
//
// Open http://localhost:3100. Your app runs in a sandboxed frame with the
// same rules Batiyao uses: no origin, nothing outside the folder, no network.
// The page around it answers the SDK like Batiyao does — saved data, a
// payment sheet drawn from your manifest, purchases, consume — and logs
// every call. Nothing here talks to Batiyao, and no BuckBuck moves.
//
// It is a convenience, not the judge: before you upload, test on Batiyao
// itself (Built by me → your app → Test), which runs the real host.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { checkBundle } = require('../lib/miniapp-rules');
const { readFolder } = require('./pack-miniapp');

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
};

// Batiyao removes these before your code runs (CSP can't stop WebRTC).
const GUARD = '<script>(function(){["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel"].forEach(function(k){try{delete window[k]}catch(e){}})})();</script>';

function fileHeaders(base) {
  return {
    'Content-Security-Policy': [
      'sandbox allow-scripts allow-forms', "default-src 'none'",
      `script-src ${base} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`, `style-src ${base} 'unsafe-inline'`,
      `img-src ${base} data: blob:`, `media-src ${base} data: blob:`, `font-src ${base} data:`,
      `connect-src ${base} data: blob:`, 'worker-src blob:', "frame-src 'none'", "object-src 'none'",
      "form-action 'none'", "base-uri 'none'",
    ].join('; '),
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
}

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
  #sheet{position:absolute;inset:0;background:rgba(0,0,0,.5);display:none;align-items:flex-end}
  #sheet .card{background:#fff;color:#0f172a;width:100%;padding:16px;border-radius:16px 16px 0 0}
  #sheet dl div{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #f1f5f9}
  #sheet dt{color:#64748b} #sheet .note{font-size:12px;background:#fffbeb;padding:8px;border-radius:8px;margin:10px 0}
  #sheet button{padding:10px;border-radius:8px;border:1px solid #cbd5e1;font:inherit;cursor:pointer}
  #sheet .pay{background:#2563eb;color:#fff;border-color:#2563eb} #sheet .row{display:grid;grid-template-columns:1fr 1.4fr;gap:8px}
  #tools{padding:8px 12px;border-bottom:1px solid #1e293b} #tools button{font:inherit;margin-right:6px}
</style></head><body>
<div id="stage">
  <div id="bar"><b>${manifest.name.replace(/[<&]/g, '')}</b><small>SIMULATOR</small><button id="reload">Reload</button></div>
  <iframe id="app" sandbox="allow-scripts allow-forms" src="/app/${manifest.entry || 'index.html'}"></iframe>
  <div id="sheet"><div class="card">
    <p><b id="s-title"></b><br><small>Made by @you · this is the sheet Batiyao draws</small></p>
    <dl><div><dt>You get</dt><dd id="s-statement"></dd></div><div><dt><b>Total</b></dt><dd><b id="s-amount"></b></dd></div></dl>
    <p class="note">${manifest.name.replace(/[<&]/g, '')} is made by you, not by Batiyao. In the simulator no BuckBuck moves.</p>
    <div class="row"><button id="s-cancel">Cancel</button><button id="s-pay" class="pay">Pay</button></div>
  </div></div>
</div>
<div><div id="tools"><button id="clear-storage">Clear saved data</button><button id="clear-purchases">Clear purchases</button><button id="visibility">Send visibility: hidden, then visible</button></div><div id="log"></div></div>
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
const KEYRE = /^[A-Za-z0-9_.:-]{1,128}$/;
function handle(m) {
  log('→ ' + m.method + ' ' + JSON.stringify(m.params || {}));
  const p = m.params || {};
  const storage = load(':storage', {});
  const purchases = load(':purchases', []);
  const bad = (code, message) => reply(m.id, null, { code, message });
  switch (m.method) {
    case 'ready': return reply(m.id, {});
    case 'getContext': return reply(m.id, { app_user_id: 'simulator-user', platform: 'web', locale: navigator.language, theme: 'light', version: MANIFEST.version, test_mode: true, access: { type: MANIFEST.access.type, active: true } });
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
      if (paying) return bad('BUSY', 'Batiyao is already showing a payment.');
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
    case 'close': reply(m.id, {}); log('the app asked to close', 'ev'); return;
    default: return bad('UNKNOWN_METHOD', 'Batiyao doesn\\'t know "' + m.method + '".');
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
document.getElementById('reload').onclick = () => { frame.src = frame.src; };
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

  const base = `http://localhost:${port}/app/`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
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
      res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', ...fileHeaders(base) });
      return res.end(data);
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Simulating Batiyao for ${manifest.name} ${manifest.version} at http://localhost:${port}`);
  });
  return server;
}

if (require.main === module) {
  const r = main(process.argv.slice(2));
  if (typeof r === 'number') process.exit(r);
}

module.exports = { main };
