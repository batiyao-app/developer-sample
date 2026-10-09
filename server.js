// Batiyao developer sample — "Connect with Batiyao", then use every capability
// the public API offers, from a plain Node server with no dependencies.
//
//   npm start      (Node 18 or newer)
//
// Configuration (environment or a .env file, see .env.example):
//   BATIYAO_CLIENT_ID   from batiyao.com → Settings → Developer → Register an app
//   PORT                default 3000
//   REDIRECT_URI        default http://localhost:<PORT>/callback — must be
//                       registered on the app exactly as written
//   BATIYAO_API         default https://api.batiyao.com

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const oauth = require('./lib/oauth');
const { BatiyaoClient, ApiError, checkPost } = require('./lib/api');
const { loadEnv, SessionStore, readBody, esc, unwrap, mediaReference } = require('./lib/support');

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const CONFIG = {
  apiBase: (process.env.BATIYAO_API || 'https://api.batiyao.com').replace(/\/$/, ''),
  clientId: process.env.BATIYAO_CLIENT_ID || '',
  redirectUri: process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`,
};

const sessions = new SessionStore();
const MAX_FORM_BYTES = 64 * 1024;
// A 100 MB video is ~134 MB once base64-encoded.
const MAX_UPLOAD_BYTES = 140 * 1024 * 1024;

// --- Pages -------------------------------------------------------------------

function layout(session, title, body) {
  const connected = Boolean(session.tokens);
  const flash = session.flash;
  session.flash = null;
  const nav = connected
    ? `<nav>
        <a href="/">Home</a><a href="/profile">Profile</a><a href="/feed">Feed</a>
        <a href="/notifications">Notifications</a><a href="/chats">Chats</a>
        <a href="/post">New post</a><a href="/media">Media &amp; stories</a>
        <form method="post" action="/disconnect" class="inline">
          ${csrfField(session)}<button class="link danger">Disconnect</button>
        </form>
      </nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Batiyao developer sample</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header><a class="brand" href="/">Batiyao developer sample</a>${nav}</header>
<main>
${flash ? `<p class="flash ${esc(flash.kind)}">${esc(flash.text)}</p>` : ''}
${body}
</main>
<footer>A sample app for the <a href="https://developer.batiyao.com">Batiyao API</a>.
Source: <a href="https://github.com/batiyao-app/developer-sample">github.com/batiyao-app/developer-sample</a></footer>
</body>
</html>`;
}

function csrfField(session) {
  if (!session.csrf) session.csrf = crypto.randomBytes(24).toString('hex');
  return `<input type="hidden" name="csrf" value="${session.csrf}">`;
}

function granted(session, scope) {
  const scopes = session.tokens?.scopes;
  return !scopes || scopes.includes(scope); // unknown: let Batiyao decide
}

function needsScope(session, scope) {
  return granted(session, scope)
    ? ''
    : `<p class="flash warn">This needs the <code>${esc(scope)}</code> permission, which was not granted.
       <a href="/">Disconnect and connect again</a> asking for it.</p>`;
}

function setupPage(session) {
  return layout(session, 'Set up', `
<h1>One step before you start</h1>
<ol>
  <li>Sign in at <a href="https://batiyao.com/settings/developer">batiyao.com → Settings → Developer</a>
      and <b>Register an app</b>.</li>
  <li>Add this exact redirect URI to it: <code>${esc(CONFIG.redirectUri)}</code></li>
  <li>Copy <code>.env.example</code> to <code>.env</code>, put the app's client ID in
      <code>BATIYAO_CLIENT_ID</code>, and restart with <code>npm start</code>.</li>
</ol>
<p>Batiyao issues no client secret: the client ID is public, and PKCE secures the sign-in.</p>`);
}

function homePage(session) {
  if (!session.tokens) {
    const boxes = Object.entries(oauth.SCOPES)
      .map(([scope, label]) => `<label class="scope">
          <input type="checkbox" name="scope" value="${esc(scope)}" ${scope === 'read:feed' ? 'checked' : ''}>
          <code>${esc(scope)}</code> ${esc(label)}</label>`)
      .join('\n');
    return layout(session, 'Connect', `
<h1>Connect with Batiyao</h1>
<p>Choose what this app may do, then sign in to Batiyao and approve it. Ask for the fewest permissions
you need — people can switch any of them off later in Batiyao → Settings → Connected apps.</p>
<form method="get" action="/connect" class="card">
${boxes}
<button class="primary">Connect with Batiyao</button>
</form>`);
  }
  const scopes = session.tokens.scopes || [];
  const row = (href, label, scope, note = '') =>
    `<li><a href="${href}" ${granted(session, scope) ? '' : 'class="muted"'}>${label}</a>
       <code>${esc(scope)}</code> ${note}</li>`;
  return layout(session, 'Home', `
<h1>Connected</h1>
<p>Granted: ${scopes.length ? scopes.map((s) => `<code>${esc(s)}</code>`).join(' ') : 'as approved'}</p>
<ul class="caps">
  ${row('/profile', 'Your profile', 'read:feed')}
  ${row('/feed', 'Your home feed', 'read:feed')}
  ${row('/notifications', 'Notifications', 'read:notifications')}
  ${row('/chats', 'Chats', 'read:chat', '(conversations that include a minor are never shown to apps)')}
  ${row('/post', 'Publish a post', 'write:post', '— costs 1.0 BuckBuck')}
  ${row('/media', 'Upload media / post a story', 'write:media', '— free; a story also needs write:post')}
</ul>`);
}

function errorPage(session, err) {
  if (!(err instanceof ApiError) && err.status) {
    // Refused by this sample itself (a stale form, an oversized upload), not by Batiyao.
    return {
      status: err.status,
      html: layout(session, 'Request refused', `<h1>Request refused</h1>
<p>${esc(err.message)}. Go back, reload the page and try again.</p>`),
    };
  }
  const status = err instanceof ApiError ? err.status : 500;
  const advice = err instanceof ApiError ? err.advice : 'Something went wrong in this sample.';
  const reconnect = !session.tokens ? '<p><a class="button" href="/">Connect again</a></p>' : '';
  return {
    status: status === 401 ? 401 : status >= 500 ? 502 : 200,
    html: layout(session, 'Batiyao said no', `
<h1>${status === 401 ? 'Connection ended' : err instanceof ApiError && err.outOfBalance ? 'Not enough BuckBuck' : 'Batiyao said no'}</h1>
<p>${esc(advice)}</p>
<p class="detail">Status ${esc(status)}: ${esc(err.message)}</p>
${reconnect}`),
  };
}

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function postCard(p, { link = true } = {}) {
  const author = p.author || {};
  const name = author.display_name || author.username || 'Someone';
  const badges = [p.followers_only ? 'followers only' : '', p.is_nsfw ? 'NSFW' : ''].filter(Boolean);
  const body = `<p class="content">${esc(p.content)}</p>
    ${Array.isArray(p.media_urls) && p.media_urls.length ? `<p class="detail">${p.media_urls.length} attachment(s)</p>` : ''}`;
  return `<article class="card">
  <div class="meta"><b>${esc(name)}</b> ${author.username ? `@${esc(author.username)}` : ''} · ${esc(when(p.created_at))}
    ${badges.map((b) => `<span class="badge">${esc(b)}</span>`).join(' ')}</div>
  ${p.is_nsfw ? `<details><summary>Show NSFW content</summary>${body}</details>` : body}
  <div class="meta">${Number(p.comment_count) || 0} comments · ${Number(p.reshare_count) || 0} reshares
    ${link ? ` · <a href="/posts/${encodeURIComponent(p.id)}">open</a>` : ''}</div>
</article>`;
}

// --- Routes ------------------------------------------------------------------

const routes = {
  'GET /': async ({ session }) => (CONFIG.clientId ? homePage(session) : setupPage(session)),

  // 1. Start the sign-in: a fresh PKCE pair and state for this attempt only.
  'GET /connect': async ({ session, url }) => {
    if (!CONFIG.clientId) return { redirect: '/' };
    const scopes = url.searchParams.getAll('scope').filter((s) => oauth.SCOPES[s]);
    if (!scopes.length) {
      session.flash = { kind: 'warn', text: 'Choose at least one permission.' };
      return { redirect: '/' };
    }
    const { verifier, challenge } = oauth.createPkcePair();
    const state = oauth.createState();
    session.pending = { verifier, state, scopes, startedAt: Date.now() };
    return {
      redirect: oauth.authorizeUrl({ ...CONFIG, scopes, state, challenge }),
    };
  },

  // 2. Batiyao sends the person back here with a one-time code.
  'GET /callback': async ({ session, url }) => {
    const pending = session.pending;
    session.pending = null;
    if (url.searchParams.get('error')) {
      session.flash = { kind: 'warn', text: `Not connected: ${url.searchParams.get('error_description') || url.searchParams.get('error')}` };
      return { redirect: '/' };
    }
    // The state must be the one this session started with, or this callback
    // belongs to somebody else's sign-in (CSRF).
    if (!pending || url.searchParams.get('state') !== pending.state || Date.now() - pending.startedAt > 10 * 60 * 1000) {
      session.flash = { kind: 'warn', text: 'That sign-in had expired or did not start here. Please try again.' };
      return { redirect: '/' };
    }
    const tokens = await oauth.exchangeCode({ ...CONFIG, code: url.searchParams.get('code'), verifier: pending.verifier });
    session.tokens = { ...tokens, scopes: tokens.scopes || pending.scopes };
    session.flash = { kind: 'ok', text: 'Connected to Batiyao.' };
    return { redirect: '/' };
  },

  'POST /disconnect': async ({ session }) => {
    if (session.tokens) {
      try {
        await oauth.revoke({ ...CONFIG, accessToken: session.tokens.accessToken });
      } catch {
        // Revocation is best effort here; the tokens are dropped either way.
      }
    }
    session.tokens = null;
    session.flash = { kind: 'ok', text: 'Disconnected. Batiyao has revoked this app’s access.' };
    return { redirect: '/' };
  },

  'GET /profile': async ({ session, api }) => {
    const p = unwrap(await api.profile());
    return layout(session, 'Profile', `${needsScope(session, 'read:feed')}
<h1>${esc(p.display_name || p.username)}</h1>
<dl class="card">
  <dt>Username</dt><dd>@${esc(p.username)}</dd>
  <dt>Bio</dt><dd>${esc(p.bio || '—')}</dd>
  <dt>Reputation</dt><dd>${esc(p.reputation_score)}</dd>
  <dt>Member since</dt><dd>${esc(when(p.created_at))}</dd>
</dl>`);
  },

  'GET /feed': async ({ session, api, url }) => {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const feed = unwrap(await api.feed(limit));
    const posts = Array.isArray(feed?.posts) ? feed.posts : [];
    return layout(session, 'Feed', `<h1>Your feed</h1>
${posts.length ? posts.map((p) => postCard(p)).join('\n') : '<p>Nothing in the feed yet.</p>'}
${feed?.has_more ? `<p><a href="/feed?limit=${Math.min(50, limit + 20)}">Show more</a></p>` : ''}`);
  },

  'GET /posts/:id': async ({ session, api, params }) => {
    const p = unwrap(await api.post(params.id));
    const post = p?.post || p;
    return layout(session, 'Post', `<h1>Post</h1>${postCard(post, { link: false })}`);
  },

  'GET /notifications': async ({ session, api }) => {
    const n = unwrap(await api.notifications());
    const list = Array.isArray(n?.notifications) ? n.notifications : [];
    return layout(session, 'Notifications', `<h1>Notifications</h1>
<p>${Number(n?.unread_count) || 0} unread</p>
${list.length ? `<ul class="list">${list.map((x) => `<li class="${x.is_read ? '' : 'unread'}">
    <b>${esc(x.actor_user?.display_name || x.actor_user?.username || '')}</b> ${esc(x.message)}
    <span class="meta">${esc(x.notification_type)} · ${esc(when(x.created_at))}</span></li>`).join('')}</ul>`
    : '<p>No notifications in the last day.</p>'}`);
  },

  'GET /chats': async ({ session, api }) => {
    const c = unwrap(await api.conversations());
    const me = await myId(session, api);
    const convs = [...(c?.pending || []), ...(c?.active || [])];
    return layout(session, 'Chats', `<h1>Chats</h1>
<p class="detail">Apps see conversation ids and member ids, not names. Conversations that include a minor are never
shown to apps.</p>
${convs.length ? `<ul class="list">${convs.map((x) => `<li><a href="/chats/${encodeURIComponent(x.id)}">Conversation ${esc(x.id.slice(0, 8))}</a>
    <span class="meta">${(x.members || []).length} members: ${(x.members || []).map((m) => (m.user_id === me ? 'you' : esc(m.user_id.slice(0, 8)))).join(', ')}</span></li>`).join('')}</ul>`
    : '<p>No conversations an app may read.</p>'}`);
  },

  'GET /chats/:id': async ({ session, api, params }) => {
    const data = unwrap(await api.messages(params.id));
    const me = await myId(session, api);
    const messages = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
    // The API asks apps never to fetch or show a chat attachment's URL: say
    // what it is in words instead.
    const describe = (m) =>
      m.deleted_at ? '<i>This message was deleted</i>'
        : m.content_type === 'text' ? esc(m.body)
        : `<i>[${esc(m.content_type)}${m.media_name ? `: ${esc(m.media_name)}` : ''}]</i>${m.body ? ` ${esc(m.body)}` : ''}`;
    return layout(session, 'Conversation', `<h1>Conversation ${esc(params.id.slice(0, 8))}</h1>
<ul class="list">${messages.map((m) => `<li><b>${m.sender_id === me ? 'You' : esc(String(m.sender_id || '').slice(0, 8))}</b>
  ${describe(m)} <span class="meta">${esc(when(m.sent_at || m.created_at))}</span></li>`).join('') || '<li>No messages in the last 48 hours.</li>'}</ul>
<p><a href="/chats">All chats</a></p>`);
  },

  'GET /post': async ({ session, url }) => postForm(session, { media: url.searchParams.get('media') || '' }),

  'POST /post': async ({ session, api, form }) => {
    const input = {
      content: (form.get('content') || '').trim(),
      contentRating: form.get('content_rating'),
      ratingReasoning: (form.get('rating_reasoning') || '').trim(),
      media: (form.get('media') || '').trim(),
    };
    const problems = checkPost(input.content);
    if (!['sfw', 'suggestive', 'nsfw'].includes(input.contentRating)) problems.push('Choose a content rating.');
    if (!input.ratingReasoning) problems.push('Say in a few words why that rating fits.');
    // Ask before spending: nothing is published without an explicit yes.
    if (form.get('confirm_cost') !== 'yes') problems.push('Tick the box to confirm spending 1.0 BuckBuck.');
    if (problems.length) return postForm(session, input, problems);

    const created = unwrap(await api.createPost({
      content: input.content,
      contentRating: input.contentRating,
      ratingReasoning: input.ratingReasoning,
      mediaUrls: input.media ? [input.media] : [],
    }));
    const post = created?.post || created;
    session.flash = { kind: 'ok', text: 'Published. 1.0 BuckBuck was spent.' };
    return { redirect: post?.id ? `/posts/${encodeURIComponent(post.id)}` : '/feed' };
  },

  'GET /media': async ({ session }) => layout(session, 'Media & stories', `
${needsScope(session, 'write:media')}
<h1>Media &amp; stories</h1>
<section class="card">
  <h2>Upload a photo or video</h2>
  <p>Free. You get back a reference to attach to a post — pass it on unchanged; it is not a URL.</p>
  <input type="file" id="media-file" accept="image/*,video/*">
  <button class="primary" data-upload="/media" data-file="media-file">Upload</button>
  <p id="media-result"></p>
</section>
<section class="card">
  <h2>Post a story</h2>
  <p>Free. One photo (up to 30 MB) or video (up to 30 seconds, 100 MB), shown to your followers for 48 hours.
  Stories reach everyone who follows you, including people under 18, so only post what is suitable for everyone.
  Needs <code>write:post</code> and <code>write:media</code>.</p>
  <input type="file" id="story-file" accept="image/*,video/mp4,video/quicktime">
  <label><input type="checkbox" id="story-ok"> This is suitable for everyone</label>
  <button class="primary" data-upload="/story" data-file="story-file" data-confirm="story-ok">Post story</button>
  <p id="story-result"></p>
</section>
<script>window.CSRF = ${JSON.stringify(session.csrf || (session.csrf = crypto.randomBytes(24).toString('hex')))};</script>
<script src="/upload.js"></script>`),

  // The browser sends the file as base64 JSON, the shape Batiyao's API takes.
  'POST /media': async ({ api, json }) => {
    const data = await api.uploadMedia({ filename: json.filename, contentType: json.content_type, dataBase64: json.data_base64 });
    const reference = mediaReference(data);
    return { json: { ok: true, reference, attach: `/post?media=${encodeURIComponent(reference)}` } };
  },

  'POST /story': async ({ api, json }) => {
    const data = await api.createStory({
      filename: json.filename,
      contentType: json.content_type,
      dataBase64: json.data_base64,
      ratingReasoning: 'The person confirmed it is suitable for everyone.',
    });
    const result = unwrap(data);
    return { json: { ok: true, message: typeof result === 'string' ? result : 'Story posted.' } };
  },
};

function postForm(session, input = {}, problems = []) {
  const rating = input.contentRating || 'sfw';
  return layout(session, 'New post', `${needsScope(session, 'write:post')}
<h1>New post</h1>
${problems.length ? `<ul class="flash warn">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
<form method="post" action="/post" class="card">
  ${csrfField(session)}
  <label>What do you want to say? <span class="detail" id="count"></span>
    <textarea name="content" id="content" rows="5" maxlength="2000" required>${esc(input.content || '')}</textarea></label>
  <p class="detail">Up to 500 characters. No #hashtags — Batiyao adds them itself. Put links bare, each on its own line, at the end.</p>
  <label>Content rating
    <select name="content_rating">
      ${['sfw', 'suggestive', 'nsfw'].map((r) => `<option value="${r}" ${r === rating ? 'selected' : ''}>${r}</option>`).join('')}
    </select></label>
  <p class="detail">Rate honestly; when unsure, pick the more restrictive one. Batiyao uses it to decide who may see the post.</p>
  <label>Why that rating? <input name="rating_reasoning" value="${esc(input.ratingReasoning || '')}" required></label>
  <label>Media reference (optional, from <a href="/media">Media</a>)
    <input name="media" value="${esc(input.media || '')}"></label>
  <label class="confirm"><input type="checkbox" name="confirm_cost" value="yes">
    Publishing costs <b>1.0 BuckBuck</b> from your balance and cannot be undone.</label>
  <button class="primary">Publish</button>
</form>
<script>
  const c = document.getElementById('content'), n = document.getElementById('count');
  const show = () => { n.textContent = [...c.value].length + ' / 500'; };
  c.addEventListener('input', show); show();
</script>`);
}

/** The connected person's id, to label their own chat messages. */
async function myId(session, api) {
  if (session.userId !== undefined) return session.userId;
  if (!granted(session, 'read:feed')) return (session.userId = null);
  try {
    session.userId = unwrap(await api.profile())?.id || null;
  } catch {
    session.userId = null;
  }
  return session.userId;
}

// --- Server ------------------------------------------------------------------

const STATIC = {
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/upload.js': ['upload.js', 'text/javascript; charset=utf-8'],
};

function match(method, pathname) {
  if (routes[`${method} ${pathname}`]) return { handler: routes[`${method} ${pathname}`], params: {} };
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method || !pattern.includes(':')) continue;
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    const found = pathname.match(re);
    if (found) {
      const params = {};
      for (const [k, v] of Object.entries(found.groups)) params[k] = decodeURIComponent(v);
      return { handler: routes[key], params };
    }
  }
  return null;
}

const PUBLIC = new Set(['GET /', 'GET /connect', 'GET /callback', 'POST /disconnect']);

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(path.join(__dirname, 'public', file)).pipe(res);
    return;
  }

  const session = sessions.get(req, res);
  const found = match(req.method, url.pathname);
  if (!found) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(layout(session, 'Not found', '<h1>Not found</h1><p><a href="/">Home</a></p>'));
    return;
  }
  const key = `${req.method} ${url.pathname}`;
  const wantsJson = req.method === 'POST' && (req.headers['content-type'] || '').startsWith('application/json');

  try {
    const ctx = { session, url, params: found.params };
    if (req.method === 'POST') {
      const raw = await readBody(req, wantsJson ? MAX_UPLOAD_BYTES : MAX_FORM_BYTES);
      if (wantsJson) {
        ctx.json = JSON.parse(raw || '{}');
        if (req.headers['x-csrf-token'] !== session.csrf) throw Object.assign(new Error('Bad CSRF token'), { status: 403 });
      } else {
        ctx.form = new URLSearchParams(raw);
        if (ctx.form.get('csrf') !== session.csrf) throw Object.assign(new Error('Bad CSRF token'), { status: 403 });
      }
    }
    if (!PUBLIC.has(key) && !session.tokens) {
      if (wantsJson) return send(res, 401, { json: { ok: false, error: 'Not connected' } });
      return send(res, 302, { redirect: '/' });
    }
    ctx.api = new BatiyaoClient({ apiBase: CONFIG.apiBase, clientId: CONFIG.clientId, session });
    const out = await found.handler(ctx);
    send(res, 200, typeof out === 'string' ? { html: out } : out);
  } catch (err) {
    if (wantsJson) {
      const status = err instanceof ApiError ? err.status : err.status || 500;
      return send(res, status, { json: { ok: false, error: err instanceof ApiError ? `${err.advice} (${err.message})` : err.message } });
    }
    if (!(err instanceof ApiError) && !err.status) console.error(err);
    const page = errorPage(session, err instanceof oauth.OAuthError ? new ApiError(err.status, err.message, err.body) : err);
    send(res, page.status, { html: page.html });
  }
}

function send(res, status, out) {
  if (out.redirect) {
    res.writeHead(302, { Location: out.redirect });
    return res.end();
  }
  if (out.json) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out.json));
  }
  res.writeHead(out.status || status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(out.html);
}

if (require.main === module) {
  http.createServer((req, res) => handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal error');
  })).listen(PORT, () => {
    console.log(`Batiyao developer sample on http://localhost:${PORT}`);
    if (!CONFIG.clientId) console.log('BATIYAO_CLIENT_ID is not set — open the page for setup steps.');
  });
}

module.exports = { handle, CONFIG, routes };
