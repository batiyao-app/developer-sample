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
  'age_rating', 'entry', 'icon', 'screenshots', 'orientation', 'access', 'products', 'requires', 'capabilities']);

// Batiyao's AI (SDK 1.4.0): what an app may ask for, the latest version of
// each, and the tools each takes. The same list as the server's.
const CAPABILITIES = { 'ai.image': { latest: 1, tools: [] }, 'ai.audio': { latest: 1, tools: [] }, 'ai.assistant': { latest: 1, tools: ['web_search'] } };
const FEATURES = ['storage', 'purchases', 'pay', 'share', 'pickImage', 'pickVideo', 'db', 'nickname', 'multiplayer'].concat(Object.keys(CAPABILITIES));

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
    if (!Number.isInteger(c.version) || c.version < 1 || c.version > spec.latest) problems.push(`manifest.json: ${label} "version" must be a whole number from 1 to ${spec.latest}`);
    text(problems, `${label}.purpose`, c.purpose, 10, 140);
    const tools = c.tools === undefined ? [] : c.tools;
    if (!Array.isArray(tools) || tools.some((t) => !spec.tools.includes(t))) {
      problems.push(spec.tools.length ? `manifest.json: ${label} "tools" may only list ${spec.tools.join(', ')}` : `manifest.json: ${label} takes no "tools"`);
    } else if (new Set(tools).size !== tools.length) problems.push(`manifest.json: ${label} lists a tool twice`);
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
const ROOT_ATTR = /\b(src|href|poster|action|data|background|manifest)\s*=\s*["']?\s*\/([^/"'\s>]|["'\s>]|$)/i;

function checkMarkup(path, src, problems, flags) {
  const markup = src.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>').replace(/<!--[\s\S]*?-->/g, '');
  if (/<base\b/i.test(markup)) problems.push(`${path}: <base> isn't allowed; use relative paths.`);
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh/i.test(markup)) problems.push(`${path}: meta refresh isn't allowed.`);
  if (/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\b(preconnect|dns-prefetch|prefetch|prerender)\b/i.test(markup)) {
    problems.push(`${path}: preconnect, dns-prefetch, prefetch and prerender hints aren't allowed; mini apps run offline.`);
  }
  const frame = markup.match(/<(iframe|frame|frameset|object|embed|portal)\b/i);
  if (frame) problems.push(`${path}: <${frame[1].toLowerCase()}> isn't allowed in a mini app.`);
  if (ABS_ATTR.test(markup)) problems.push(`${path}: something points to the internet; bundle the file and use a relative path.`);
  if (ROOT_ATTR.test(markup)) problems.push(`${path}: a path starts with "/"; use paths relative to the page ("js/app.js", not "/js/app.js").`);
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) checkCSS(`${path} <style>`, m[1], problems);
  for (const m of src.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi)) checkJS(m[2], flags);
}

function checkCSS(path, src, problems) {
  if (/@import\s+(url\(\s*)?["']?\s*(https?:|\/\/)/i.test(src) || /url\(\s*["']?\s*(https?:|\/\/)/i.test(src)) {
    problems.push(`${path}: loads something from the internet (url() or @import); mini apps run offline.`);
  }
  if (/url\(\s*["']?\s*\/[^/]/i.test(src)) problems.push(`${path}: a url() starts with "/"; use a path relative to the stylesheet.`);
}

function checkJS(src, flags) {
  const rules = [
    [/\b(webkit)?RTCPeerConnection\b/, 'Uses WebRTC (RTCPeerConnection)'],
    [/\bnew\s+WebSocket\b/, 'Opens WebSockets'],
    [/\bEventSource\s*\(/, 'Uses EventSource'],
    [/\bsendBeacon\s*\(/, 'Uses navigator.sendBeacon'],
  ];
  for (const [re, flag] of rules) if (re.test(src) && !flags.includes(flag)) flags.push(flag);
}

/** files: [{ path, data: Buffer }] → { problems, flags, manifest } */
function checkBundle(files) {
  const problems = [];
  const flags = [];
  let total = 0;
  const seen = new Map();
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
    if (e === 'html' || e === 'htm') checkMarkup(f.path, src, problems, flags);
    if (e === 'css') checkCSS(f.path, src, problems);
    if (e === 'js' || e === 'mjs') checkJS(src, flags);
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

module.exports = { checkBundle, millis, validPath };
