'use strict';
// net.fetch for the simulator (SDK 1.8.0): stands in for the request the
// Batiyao phone app makes on the phone for a mini app (net.fetch is phone
// only), made here on your machine under the phone's rules (app
// requirements §106.3):
//   - only the app's approved addresses (https), every redirect re-checked,
//     at most 5;
//   - never a private address: every address the name resolves to must be
//     public, and the connection goes to the address that was checked;
//   - no cookies (none sent, Set-Cookie removed), Batiyao's own User-Agent;
//   - text/JSON at most 10 MB, a blob or file at most 50 MB, a body 20 MB.

const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const MAX_TEXT = 10 * 1024 * 1024;
const MAX_BLOB = 50 * 1024 * 1024;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const FORBIDDEN = ['host', 'cookie', 'origin', 'referer', 'user-agent', 'connection', 'content-length',
  'transfer-encoding', 'accept-encoding', 'expect', 'via', 'forwarded', 'date', 'dnt', 'te', 'trailer', 'upgrade', 'keep-alive'];

const fail = (code, message) => Object.assign(new Error(message), { code });

function forbiddenHeader(name) {
  const n = String(name).trim().toLowerCase();
  return FORBIDDEN.includes(n) || /^(proxy-|sec-|x-forwarded-)/.test(n);
}

// The ranges Batiyao refuses (loopback, private, link-local, CGNAT, ULA,
// multicast, documentation and reserved).
const blocked = new net.BlockList();
for (const [a, p, t] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'], ['2001:db8::', 32, 'ipv6'],
]) blocked.addSubnet(a, p, t);

/** Is this address one Batiyao may connect to? IPv4-mapped and NAT64 are judged by the IPv4 inside. */
function isPublicAddress(ip) {
  if (net.isIPv4(ip)) return !blocked.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicAddress(mapped[1]);
  const nat64 = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (nat64) {
    const hi = parseInt(nat64[1], 16), lo = parseInt(nat64[2], 16);
    return isPublicAddress([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
  }
  const dotted = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return isPublicAddress(dotted[1]);
  return !blocked.check(ip, 'ipv6');
}

// A dns lookup that refuses a name resolving to any private address.
function checkedLookup(isPublic, resolve) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    (resolve || dns.lookup)(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs.length) return cb(fail('NET_FAILED', 'No address for ' + hostname));
      for (const a of addrs) if (!isPublic(a.address)) return cb(fail('NET_PRIVATE_ADDRESS', 'That address resolves to a private network.'));
      if (options && options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

/**
 * One request, redirects followed by hand (each re-checked). opts: url,
 * method, headers, body (Buffer|string), response, timeoutMs, allowed(url) →
 * bool, slug, signal; for tests: isPublic, resolve, ca. Resolves
 * { status, status_text, url, headers, type, body: Buffer }; rejects with
 * an error carrying a NET_* code.
 */
async function fetchOnce(opts) {
  const method = String(opts.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw fail('INVALID', 'method is GET, HEAD, POST, PUT, PATCH or DELETE.');
  const response = opts.response || 'text';
  const limit = response === 'blob' || response === 'file' ? MAX_BLOB : MAX_TEXT;
  const headers = opts.headers || {};
  const names = Object.keys(headers);
  if (names.length > 32) throw fail('INVALID', 'At most 32 headers.');
  for (const n of names) {
    if (forbiddenHeader(n)) throw fail('NET_HEADER_FORBIDDEN', 'Batiyao sets or refuses the header ' + n + '.');
    if (typeof headers[n] !== 'string' || headers[n].length > 8192 || /[\r\n]/.test(n + headers[n])) throw fail('INVALID', 'A header name or value isn’t allowed.');
  }
  let body = opts.body == null ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
  if (body && (method === 'GET' || method === 'HEAD')) throw fail('INVALID', 'GET and HEAD take no body.');
  if (body && body.length > MAX_BODY) throw fail('NET_TOO_LARGE', 'A body is at most 20 MB.');
  const isPublic = opts.isPublic || isPublicAddress;
  const lookup = checkedLookup(isPublic, opts.resolve);
  const ua = 'Mozilla/5.0 (compatible; Batiyao-MiniApp/1; +https://batiyao.com/apps/' + (opts.slug || 'app') + ')';
  const deadline = Date.now() + (opts.timeoutMs || (limit === MAX_BLOB ? 600000 : 60000));

  let url = String(opts.url);
  let m = method;
  for (let hop = 0; ; hop++) {
    let u;
    try { u = new URL(url); } catch (e) { throw fail('NET_NOT_ALLOWED', 'That isn’t an address.'); }
    if (u.protocol !== 'https:' || u.username || u.password || !opts.allowed(u.href)) {
      throw fail('NET_NOT_ALLOWED', hop ? 'It redirects to an address this app may not reach.' : 'net.fetch reads only this app’s approved https addresses.');
    }
    const res = await new Promise((resolve, reject) => {
      const req = https.request(u, {
        method: m, lookup, ca: opts.ca, agent: false, signal: opts.signal,
        headers: Object.assign({}, headers, { 'User-Agent': ua }, body ? { 'Content-Length': body.length } : {}),
        timeout: Math.max(1, deadline - Date.now()),
      }, resolve);
      req.on('timeout', () => req.destroy(fail('NET_TIMEOUT', 'The address didn’t answer in time.')));
      req.on('error', (e) => {
        if (e.code && /^NET_/.test(e.code)) return reject(e);
        if (e.name === 'AbortError') return reject(fail('NET_CANCELLED', 'Cancelled.'));
        reject(fail('NET_FAILED', 'The address couldn’t be reached: ' + e.message));
      });
      if (body) req.write(body);
      req.end();
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (hop + 1 > MAX_REDIRECTS) throw fail('NET_TOO_MANY_REDIRECTS', 'More than 5 redirects.');
      url = new URL(res.headers.location, u).href;
      if (res.statusCode !== 307 && res.statusCode !== 308) { m = m === 'HEAD' ? 'HEAD' : 'GET'; body = null; }
      continue;
    }
    const declared = Number(res.headers['content-length']);
    if (declared > limit) { res.destroy(); throw fail('NET_TOO_LARGE', 'The answer is over ' + (limit >> 20) + ' MB.'); }
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      res.on('data', (c) => {
        size += c.length;
        if (size > limit) { res.destroy(); reject(fail('NET_TOO_LARGE', 'The answer is over ' + (limit >> 20) + ' MB.')); return; }
        if (opts.onData) opts.onData(size, Number.isFinite(declared) ? declared : null);
        chunks.push(c);
      });
      res.on('end', resolve);
      res.on('error', (e) => reject(e.code && /^NET_/.test(e.code) ? e : fail('NET_FAILED', 'The answer couldn’t be read.')));
    });
    const out = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (k === 'set-cookie' || k === 'set-cookie2') continue;
      out[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    const data = Buffer.concat(chunks);
    if (response === 'json') {
      try { JSON.parse(data.toString('utf8')); } catch (e) { throw fail('NET_NOT_JSON', 'The answer isn’t JSON.'); }
    }
    return { status: res.statusCode, status_text: res.statusMessage || '', url, headers: out, type: res.headers['content-type'] || '', body: data };
  }
}

module.exports = { fetchOnce, isPublicAddress, forbiddenHeader, MAX_TEXT, MAX_BLOB, MAX_BODY };
