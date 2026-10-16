// The checks Batiyao runs on an uploaded mini app, in JavaScript, so the
// packer can tell you about a problem before you upload. Batiyao's own
// checks are the authority; these follow them (see the Mini apps guide on
// developer.batiyao.com).

'use strict';

const EXTENSIONS = new Set([
  'html', 'htm', 'js', 'mjs', 'css', 'json', 'map', 'txt', 'csv', 'svg',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico',
  'mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'mp4', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'wasm', 'glb', 'gltf', 'bin', 'data',
]);
const CATEGORIES = ['games', 'education', 'tools', 'entertainment', 'lifestyle', 'productivity', 'other'];
const RATINGS = ['4+', '9+', '13+', '16+', '18+'];
const LIMITS = { files: 1000, fileBytes: 20 << 20, totalBytes: 60 << 20, productMax: 20000, accessMax: 50000, priceMin: 100 };

const PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const KNOWN_FIELDS = new Set(['batiyao_miniapp', 'app_id', 'version', 'name', 'summary', 'description', 'category',
  'age_rating', 'entry', 'icon', 'screenshots', 'orientation', 'access', 'products', 'requires', 'capabilities', 'network']);

// Capabilities an admin grants (the same list as the server's): Batiyao's AI
// (SDK 1.4.0) and net.fetch (SDK 1.8.0: read your approved addresses without
// CORS). The latest version of each, and the tools each takes.
const CAPABILITIES = { 'ai.image': { latest: 1, tools: [] }, 'ai.audio': { latest: 1, tools: [] }, 'ai.assistant': { latest: 1, tools: ['web_search'] },
  'net.fetch': { latest: 1, tools: [] } };
const FEATURES = ['storage', 'purchases', 'pay', 'share', 'pickImage', 'pickVideo', 'db', 'nickname', 'multiplayer', 'invite', 'network', 'files', 'shareMedia', 'shareInvite']
  .concat(Object.keys(CAPABILITIES));

// Network (2026-10-16): at most two addresses of your own, each approved by
// a Batiyao admin; everything else stays blocked. An address is an origin
// (https, a domain name, maybe a port), never a path. The same rules as the
// server's.
const MAX_NETWORK = 2;
const RESERVED_HOSTS = ['batiyao.com', 'abhinava.xyz', 'localhost', 'local', 'internal', 'home.arpa', 'invalid', 'test', 'example', 'onion'];
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// A wildcard (https://*.example.com: the domain and all its subdomains) must
// be over a domain somebody owns. Batiyao checks the whole public suffix list
// at upload; the packer knows only these common ones where anybody can have
// a site, and the single-label ones (*.com).
const SHARED_SUFFIXES = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'co.nz', 'co.jp', 'co.za', 'com.br',
  'com.cn', 'com.mx', 'com.sg', 'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com',
  'web.app', 'firebaseapp.com', 'appspot.com', 'cloudfront.net', 'azurewebsites.net', 'onrender.com', 'fly.dev', 'glitch.me',
  'blogspot.com', 'wordpress.com', 'repl.co', 'replit.app', 'surge.sh', 'ngrok.io', 'ngrok-free.app'];

/** "https://API.Example.com/" → "https://api.example.com"; throws with a reason when it can't be one. */
function normalizeOrigin(raw) {
  const fail = (why) => { throw new Error(why); };
  if (typeof raw !== 'string' || raw.trim() !== raw || raw === '') fail(`${JSON.stringify(raw)} must be an address like https://api.example.com, with no spaces`);
  if (raw.length > 200) fail(`${JSON.stringify(raw)} is longer than 200 characters`);
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(raw);
  if (!m) fail(`${JSON.stringify(raw)} isn't an address; write it like https://api.example.com`);
  const [, scheme, authority, path, query, fragment] = m;
  if (scheme.toLowerCase() !== 'https') fail(`${JSON.stringify(raw)} must start with https:// (WebSockets to the same host use wss:// automatically)`);
  if (authority.includes('@')) fail(`${JSON.stringify(raw)} must not contain a user name or password`);
  if ((path !== '' && path !== '/') || query !== undefined || fragment !== undefined) {
    fail(`${JSON.stringify(raw)} must be only the base address (https://host), with no path, ? or #: approval is for the whole site`);
  }
  let host = authority;
  let port = '';
  if (host.startsWith('[')) fail(`${JSON.stringify(raw)}: use a domain name, not an IP address`);
  const colon = host.lastIndexOf(':');
  if (colon >= 0) { port = host.slice(colon + 1); host = host.slice(0, colon); }
  host = host.toLowerCase();
  const wildcard = host.startsWith('*.');
  if (wildcard) host = host.slice(2);
  if (host.includes('*')) fail(`${JSON.stringify(raw)}: a wildcard may only be the whole first part, like https://*.example.com`);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) fail(`${JSON.stringify(raw)}: use a domain name, not an IP address`);
  host = host.replace(/\.$/, '');
  const labels = host.split('.');
  if (labels.length < 2 || host.length > 253) fail(`${JSON.stringify(raw)}: the host must be a full domain name like api.example.com`);
  if (!labels.every((l) => LABEL_RE.test(l))) fail(`${JSON.stringify(raw)}: the host may only use a-z, 0-9 and - (write other scripts in their xn-- form)`);
  if (/^[0-9]+$/.test(labels[labels.length - 1])) fail(`${JSON.stringify(raw)}: the host must be a domain name`);
  if (RESERVED_HOSTS.some((r) => host === r || host.endsWith('.' + r))) {
    fail(`${JSON.stringify(raw)} can't be used: Batiyao's own and private addresses are reached only through the SDK`);
  }
  if (wildcard) {
    if (labels.length < 2 || SHARED_SUFFIXES.includes(host)) {
      fail(`${JSON.stringify(raw)}: a wildcard must be over a domain you own (like *.example.com), not over ${host}, where anybody can have a site`);
    }
    host = '*.' + host;
  }
  let origin = 'https://' + host;
  if (port !== '') {
    const n = Number(port);
    if (!/^[0-9]+$/.test(port) || n < 1 || n > 65535 || String(n) !== port) fail(`${JSON.stringify(raw)} has a port that isn't a number from 1 to 65535`);
    if (n !== 443) origin += ':' + port;
  }
  return origin;
}

/** The manifest's addresses as origins (the valid ones), in its order. */
function origins(m) {
  const out = [];
  for (const n of Array.isArray(m && m.network) ? m.network : []) {
    try { out.push(normalizeOrigin(n && n.url)); } catch (e) { /* reported by checkNetwork */ }
  }
  return out;
}

/** Is this origin a wildcard (the domain and all its subdomains)? */
function isWildcard(o) { return o.startsWith('https://*.'); }

/** What an origin lets through, without the scheme: a wildcard is the domain itself and *. of it. */
function hostsOf(o) {
  const h = o.slice('https://'.length);
  return h.startsWith('*.') ? [h.slice(2), h] : [h];
}

/** How people see it: "api.example.com" or "example.com and all its subdomains". */
function networkLabel(o) {
  const h = hostsOf(o);
  return h.length === 2 ? h[0] + ' and all its subdomains' : h[0];
}

/** May a frame given this origin load this https/wss URL? */
function originAllows(o, u) {
  const m = /^(https|wss):\/\/([^/?#@]+)(?:[/?#]|$)/i.exec(u);
  if (!m) return false;
  let [host, port = ''] = m[2].toLowerCase().split(':');
  if (port === '443') port = '';
  let want = o.slice('https://'.length);
  let wantPort = '';
  const c = want.lastIndexOf(':');
  if (c >= 0) { wantPort = want.slice(c + 1); want = want.slice(0, c); }
  if (port !== wantPort) return false;
  if (want.startsWith('*.')) { const d = want.slice(2); return host === d || host.endsWith('.' + d); }
  return host === want;
}

/** CSP sources for these origins: each as https and as wss on the same host and port (a wildcard: the domain and *. of it). */
function sourceList(list) {
  const out = [];
  for (const o of list) {
    const hs = hostsOf(o);
    for (const scheme of ['https://', 'wss://']) for (const h of hs) out.push(scheme + h);
  }
  return out;
}

/** The Connection-Allowlist header for these origins. */
function connectionAllowlist(list) {
  return '(' + ['response-origin'].concat(sourceList(list).map((s) => `"${s}/*"`)).join(' ') + ')';
}

function checkNetwork(m, problems) {
  const net = m.network === undefined ? [] : m.network;
  if (!Array.isArray(net)) { problems.push('manifest.json: "network" is a list, like [{"url": "https://api.example.com", "purpose": "..."}]'); return; }
  if (net.length > MAX_NETWORK) problems.push(`manifest.json: at most ${MAX_NETWORK} "network" addresses`);
  const seen = new Set();
  net.forEach((n, i) => {
    const label = `network[${i}]`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) { problems.push(`manifest.json: ${label} is an object with "url" and "purpose"`); return; }
    for (const k of Object.keys(n)) if (!['url', 'purpose'].includes(k)) problems.push(`manifest.json: ${label} has unknown field "${k}" (check the spelling)`);
    try {
      const o = normalizeOrigin(n.url);
      if (seen.has(o)) problems.push(`manifest.json: ${label}: ${o} is listed twice`);
      seen.add(o);
    } catch (e) {
      problems.push(`manifest.json: ${label}: ${e.message}`);
    }
    text(problems, `${label}.purpose`, n.purpose, 10, 140);
  });
  if (Array.isArray(m.requires) && m.requires.includes('network') && net.length === 0) {
    problems.push('manifest.json: "requires" has "network", so "network" must list the address the app connects to');
  }
}

function ext(p) {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i + 1).toLowerCase();
}

function validPath(p) {
  return p.length > 0 && p.length <= 180 && PATH_RE.test(p) && p.split('/').length <= 10;
}

/** "2.5" → 2500 millis; null when it isn't a price Batiyao accepts. */
function millis(price) {
  if (typeof price !== 'string' || !/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$/.test(price)) return null;
  const [w, f = ''] = price.split('.');
  return Number(w) * 1000 + Number((f + '000').slice(0, 3));
}

function text(problems, field, value, min, max, multiline) {
  if (typeof value !== 'string') { problems.push(`manifest.json: "${field}" is required`); return; }
  if (value.trim() !== value) problems.push(`manifest.json: "${field}" has spaces at the start or end`);
  const n = [...value.trim()].length;
  if (n < min || n > max) problems.push(`manifest.json: "${field}" must be ${min} to ${max} characters (it is ${n})`);
  const ctrl = multiline
    ? new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f\\u2028\\u2029\\u202e]')
    : new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029\\u202e]');
  if (ctrl.test(value)) problems.push(`manifest.json: "${field}" contains a control character`);
  if (/[<>]/.test(value)) problems.push(`manifest.json: "${field}" must not contain < or >`);
}

function checkManifest(m, problems) {
  for (const k of Object.keys(m)) if (!KNOWN_FIELDS.has(k)) problems.push(`manifest.json: unknown field "${k}" (check the spelling)`);
  if (m.batiyao_miniapp !== 1) problems.push('manifest.json: "batiyao_miniapp" must be 1');
  if (!/^ma_[a-z2-7]{10}$/.test(m.app_id || '')) problems.push('manifest.json: "app_id" must be your app\'s ID, like "ma_abcdefgh23"');
  if (!/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(m.version || '')) problems.push('manifest.json: "version" must look like 1.0.0');
  text(problems, 'name', m.name, 2, 30);
  text(problems, 'summary', m.summary, 10, 80);
  if (m.description !== undefined) text(problems, 'description', m.description, 1, 2000, true);
  // Optional since 2026-10-10: the category is chosen on the app's page.
  if (m.category != null && !CATEGORIES.includes(m.category)) {
    problems.push(`manifest.json: "category" must be one of ${CATEGORIES.join(', ')} (or leave it out and choose it on your app's page)`);
  }
  if (!RATINGS.includes(m.age_rating)) problems.push(`manifest.json: "age_rating" must be one of ${RATINGS.join(', ')}`);
  const entry = m.entry || 'index.html';
  if (!validPath(entry) || !/\.html?$/.test(entry)) problems.push('manifest.json: "entry" must be the path of an .html file');
  if (!validPath(m.icon || '') || ext(m.icon) !== 'png') problems.push('manifest.json: "icon" must be the path of a PNG file');
  if ((m.screenshots || []).length > 5) problems.push('manifest.json: at most 5 "screenshots"');
  const a = m.access || {};
  if (a.type === 'free') {
    if (a.price !== undefined || a.statement !== undefined) problems.push('manifest.json: a free app\'s "access" has no price or statement');
  } else if (a.type === 'one_time' || a.type === 'pass_30d') {
    const v = millis(a.price);
    if (v === null || v < LIMITS.priceMin || v > LIMITS.accessMax) problems.push('manifest.json: access price must be between 0.1 and 50 BuckBuck, at most three decimals');
    text(problems, 'access.statement', a.statement, 10, 140);
  } else {
    problems.push('manifest.json: "access" must be {"type": "free"}, or "one_time" / "pass_30d" with a price and a statement');
  }
  const seen = new Set();
  (m.products || []).forEach((p, i) => {
    if (!/^[a-z0-9_]{1,40}$/.test(p.id || '')) problems.push(`manifest.json: products[${i}] "id" must be lower-case letters, digits and _`);
    else if (seen.has(p.id)) problems.push(`manifest.json: product id "${p.id}" is used twice`);
    seen.add(p.id);
    text(problems, `products[${i}].title`, p.title, 1, 40);
    text(problems, `products[${i}].statement`, p.statement, 10, 140);
    const v = millis(p.price);
    if (v === null || v < LIMITS.priceMin || v > LIMITS.productMax) problems.push(`manifest.json: products[${i}] price must be between 0.1 and 20 BuckBuck, at most three decimals`);
    if (p.kind !== 'consumable' && p.kind !== 'permanent') problems.push(`manifest.json: products[${i}] "kind" must be "consumable" or "permanent"`);
  });
  if ((m.products || []).length > 50) problems.push('manifest.json: at most 50 "products"');
  checkCapabilities(m, problems);
  checkNetwork(m, problems);
}

function checkCapabilities(m, problems) {
  const caps = m.capabilities === undefined ? {} : m.capabilities;
  if (caps === null || typeof caps !== 'object' || Array.isArray(caps)) {
    problems.push('manifest.json: "capabilities" is an object, like {"ai.image": {"version": 1, "purpose": "..."}}');
    return;
  }
  for (const [name, c] of Object.entries(caps)) {
    const spec = CAPABILITIES[name];
    if (!spec) { problems.push(`manifest.json: "capabilities" has "${name}", which isn't a capability; they are ${Object.keys(CAPABILITIES).join(', ')}`); continue; }
    const label = `capabilities["${name}"]`;
    if (!c || typeof c !== 'object') { problems.push(`manifest.json: ${label} is an object with "version" and "purpose"`); continue; }
    for (const k of Object.keys(c)) if (!['version', 'purpose', 'tools'].includes(k)) problems.push(`manifest.json: ${label} has unknown field "${k}" (check the spelling)`);
    // "version" is optional since 2026-10-16: 1 when left out.
    const version = c.version === undefined ? 1 : c.version;
    if (!Number.isInteger(version) || version < 1 || version > spec.latest) problems.push(`manifest.json: ${label} "version" must be a whole number from 1 to ${spec.latest}`);
    text(problems, `${label}.purpose`, c.purpose, 10, 140);
    const tools = c.tools === undefined ? [] : c.tools;
    if (!Array.isArray(tools) || tools.some((t) => !spec.tools.includes(t))) {
      problems.push(spec.tools.length ? `manifest.json: ${label} "tools" may only list ${spec.tools.join(', ')}` : `manifest.json: ${label} takes no "tools"`);
    } else if (new Set(tools).size !== tools.length) problems.push(`manifest.json: ${label} lists a tool twice`);
  }
  const net = Array.isArray(m.network) ? m.network : [];
  if (caps['net.fetch'] && net.length === 0) {
    problems.push('manifest.json: "capabilities" has "net.fetch", which reads your "network" addresses: declare at least one');
  }
  const req = m.requires === undefined ? [] : m.requires;
  if (!Array.isArray(req)) { problems.push('manifest.json: "requires" is a list of feature names'); return; }
  const seen = new Set();
  for (const r of req) {
    if (!FEATURES.includes(r)) { problems.push(`manifest.json: "requires" has "${r}", which isn't a Batiyao feature (check the spelling)`); continue; }
    if (seen.has(r)) problems.push(`manifest.json: "requires" lists "${r}" twice`);
    seen.add(r);
    if (CAPABILITIES[r] && !caps[r]) problems.push(`manifest.json: "requires" has "${r}", so "capabilities" must declare it too, with its version and purpose`);
  }
}

const ABS_ATTR = /\b(src|href|srcset|poster|action|formaction|data|background|manifest|ping|cite|longdesc|xlink:href)\s*=\s*["']?\s*(https?:|\/\/|wss?:|ftp:)/i;
// The same, with the attribute's whole value, to check it against the
// declared addresses.
const ABS_ATTR_VAL = /\b(src|href|srcset|poster|action|formaction|data|background|manifest|ping|cite|longdesc|xlink:href)\s*=\s*("\s*(?:https?:|\/\/|wss?:|ftp:)[^"]*"|'\s*(?:https?:|\/\/|wss?:|ftp:)[^']*'|(?:https?:|\/\/|wss?:|ftp:)[^\s>]*)/gi;
const MEDIA_TAGS = new Set(['img', 'audio', 'video', 'source', 'track']);

function tagBefore(markup, pos) {
  const start = markup.lastIndexOf('<', pos);
  if (start < 0) return '';
  const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(markup.slice(start));
  return m ? m[1].toLowerCase() : '';
}

function onOrigin(u, list) {
  return /^https:\/\//i.test(u) && list.some((o) => originAllows(o, u));
}

// An image, sound or video whose every URL is on a declared address: what
// the sandbox's img-src and media-src let through.
function mediaFromDeclared(tag, attr, value, list) {
  if (!MEDIA_TAGS.has(tag) || !['src', 'srcset', 'poster'].includes(attr) || list.length === 0) return false;
  let urls = [value];
  if (attr === 'srcset') urls = value.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
  return urls.length > 0 && urls.every((u) => onOrigin(u, list));
}
const ROOT_ATTR = /\b(src|href|poster|action|data|background|manifest)\s*=\s*["']?\s*\/([^/"'\s>]|["'\s>]|$)/i;

function checkMarkup(path, src, problems, flags, list = []) {
  const markup = src.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>').replace(/<!--[\s\S]*?-->/g, '');
  if (/<base\b/i.test(markup)) problems.push(`${path}: <base> isn't allowed; use relative paths.`);
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh/i.test(markup)) problems.push(`${path}: meta refresh isn't allowed.`);
  if (/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\b(preconnect|dns-prefetch|prefetch|prerender)\b/i.test(markup)) {
    problems.push(`${path}: preconnect, dns-prefetch, prefetch and prerender hints aren't allowed; mini apps run offline.`);
  }
  const frame = markup.match(/<(iframe|frame|frameset|object|embed|portal)\b/i);
  if (frame) problems.push(`${path}: <${frame[1].toLowerCase()}> isn't allowed in a mini app.`);
  for (const m of markup.matchAll(ABS_ATTR_VAL)) {
    const attr = m[1].toLowerCase();
    const value = m[2].replace(/^["'\s]+|["'\s]+$/g, '');
    if (mediaFromDeclared(tagBefore(markup, m.index), attr, value, list)) continue;
    problems.push(list.length > 0
      ? `${path}: ${m[0].slice(0, 80).trim()}… points to the internet. Only images, sound and video (src, srcset, poster) may come from an address in "network"; bundle everything else and use a relative path.`
      : `${path}: ${m[0].slice(0, 80).trim()}… points to the internet; mini apps run offline, so bundle the file and use a relative path (or declare the address in "network").`);
    break;
  }
  if (ROOT_ATTR.test(markup)) problems.push(`${path}: a path starts with "/"; use paths relative to the page ("js/app.js", not "/js/app.js").`);
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) checkCSS(`${path} <style>`, m[1], problems);
  for (const m of src.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi)) checkJS(m[2], flags, list.length > 0);
}

function checkCSS(path, src, problems) {
  if (/@import\s+(url\(\s*)?["']?\s*(https?:|\/\/)/i.test(src) || /url\(\s*["']?\s*(https?:|\/\/)/i.test(src)) {
    problems.push(`${path}: loads something from the internet (url() or @import); mini apps run offline.`);
  }
  if (/url\(\s*["']?\s*\/[^/]/i.test(src)) problems.push(`${path}: a url() starts with "/"; use a path relative to the stylesheet.`);
}

// online: the manifest declares addresses, so sockets and beacons are what
// the app said it would do; only WebRTC (always removed) is still flagged.
function checkJS(src, flags, online) {
  const rules = [
    [/\b(webkit)?RTCPeerConnection\b/, 'Uses WebRTC (RTCPeerConnection)'],
    [/\bnew\s+WebSocket\b/, 'Opens WebSockets'],
    [/\bEventSource\s*\(/, 'Uses EventSource'],
    [/\bsendBeacon\s*\(/, 'Uses navigator.sendBeacon'],
  ];
  for (const [re, flag] of (online ? rules.slice(0, 1) : rules)) if (re.test(src) && !flags.includes(flag)) flags.push(flag);
}

/** files: [{ path, data: Buffer }] → { problems, flags, manifest } */
function checkBundle(files) {
  const problems = [];
  const flags = [];
  let total = 0;
  const seen = new Map();
  // The declared addresses decide what the markup may point to.
  const mf0 = files.find((f) => f.path === 'manifest.json');
  let declared = [];
  if (mf0) { try { declared = origins(JSON.parse(mf0.data.toString('utf8'))); } catch (e) { /* reported below */ } }
  if (files.length > LIMITS.files) problems.push(`more than ${LIMITS.files} files`);
  for (const f of files) {
    if (!validPath(f.path)) { problems.push(`${f.path}: file names may use only letters, digits, ".", "_" and "-", with no hidden files`); continue; }
    const lower = f.path.toLowerCase();
    if (seen.has(lower)) problems.push(`${seen.get(lower)} and ${f.path} differ only in capital letters`);
    seen.set(lower, f.path);
    if (!EXTENSIONS.has(ext(f.path))) problems.push(`${f.path}: .${ext(f.path)} files aren't allowed in a mini app`);
    if (f.data.length > LIMITS.fileBytes) problems.push(`${f.path} is larger than 20 MB`);
    total += f.data.length;
    const e = ext(f.path);
    const src = ['html', 'htm', 'css', 'svg', 'js', 'mjs'].includes(e) ? f.data.toString('utf8') : '';
    if (e === 'html' || e === 'htm') checkMarkup(f.path, src, problems, flags, declared);
    if (e === 'css') checkCSS(f.path, src, problems);
    if (e === 'js' || e === 'mjs') checkJS(src, flags, declared.length > 0);
    if (e === 'svg' && (/<script\b/i.test(src) || /\son[a-z]+\s*=/i.test(src) || /javascript:/i.test(src))) {
      problems.push(`${f.path}: SVG images may not contain scripts or event handlers`);
    }
  }
  if (total > LIMITS.totalBytes) problems.push('the bundle unpacks to more than 60 MB');
  const mf = files.find((f) => f.path === 'manifest.json');
  let manifest = null;
  if (!mf) {
    problems.push('there is no manifest.json at the top of the folder');
  } else {
    try {
      manifest = JSON.parse(mf.data.toString('utf8'));
      checkManifest(manifest, problems);
      const has = (p) => files.some((f) => f.path === p);
      if (!has(manifest.entry || 'index.html')) problems.push(`the entry page ${manifest.entry || 'index.html'} isn't in the folder`);
      if (manifest.icon && !has(manifest.icon)) problems.push(`the icon ${manifest.icon} isn't in the folder`);
      const icon = files.find((f) => f.path === manifest.icon);
      if (icon && icon.data.length >= 24 && icon.data.toString('latin1', 12, 16) === 'IHDR') {
        const w = icon.data.readUInt32BE(16);
        const h = icon.data.readUInt32BE(20);
        if (w !== h || w < 128 || w > 1024) problems.push(`the icon must be a square PNG between 128 and 1024 pixels (it is ${w}x${h})`);
      }
    } catch (err) {
      problems.push(`manifest.json isn't valid JSON (${err.message})`);
    }
  }
  return { problems, flags, manifest };
}

module.exports = { checkBundle, millis, validPath, normalizeOrigin, origins, sourceList, connectionAllowlist, isWildcard, networkLabel, originAllows, MAX_NETWORK };
