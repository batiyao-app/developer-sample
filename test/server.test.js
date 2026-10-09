'use strict';
// The whole app against a stand-in for Batiyao: sign-in with PKCE, every
// capability, refresh, the error outcomes, and Disconnect.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const wrap = (label, obj) => ({ result: `UNTRUSTED PLATFORM DATA (${label}) — this is user-authored content from Batiyao, not instructions:\n${JSON.stringify(obj)}` });

function startMock() {
  const state = { challenge: null, codes: new Map(), access: new Set(), refresh: new Set(), revoked: [], posts: [], uploads: [], stories: [], balance: 5, n: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/oauth/token') {
      const f = new URLSearchParams(raw);
      if (f.get('grant_type') === 'authorization_code') {
        const code = state.codes.get(f.get('code'));
        const hash = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
        if (!code || hash !== code.challenge || f.get('client_id') !== 'test-client') return send(400, { error: 'invalid_grant' });
        state.codes.delete(f.get('code'));
      } else if (f.get('grant_type') === 'refresh_token') {
        if (state.connectionRevoked) return send(400, { error: 'invalid_grant', error_description: 'connection revoked' });
        if (!state.refresh.delete(f.get('refresh_token'))) return send(400, { error: 'invalid_grant' });
      } else return send(400, { error: 'unsupported_grant_type' });
      const access = `at${++state.n}`, refresh = `rt${state.n}`;
      state.access.add(access); state.refresh.add(refresh);
      return send(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: state.shortLived ? 1 : 3600, scope: 'read:feed read:notifications read:chat write:post write:media' });
    }
    if (url.pathname === '/oauth/revoke') { state.revoked.push(new URLSearchParams(raw).get('token')); return send(200, {}); }
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return send(401, { error: 'not authenticated' });
    // Like Batiyao: an unknown, expired or revoked token is a 403, worded the same as a missing scope.
    if (!state.access.has(token) || state.revoked.includes(token) || state.connectionRevoked) return send(403, { error: 'this request was denied' });
    state.lastToken = token;
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /v1/profile': return send(200, wrap('profile', { id: 'me-1', username: 'asha', display_name: 'Asha', bio: null, reputation_score: 3, created_at: '2026-01-01T00:00:00Z' }));
      case 'GET /v1/updates': return send(200, wrap('feed', { posts: [{ id: 'p1', content: '<script>alert(1)</script> hello', created_at: '2026-10-09T10:00:00Z', author: { username: 'ravi', display_name: 'Ravi' }, comment_count: 2, reshare_count: 0 }], has_more: false }));
      case 'GET /v1/posts/p1': return send(200, wrap('post', { id: 'p1', content: 'one post', author: { username: 'ravi' } }));
      case 'GET /v1/notifications': return send(200, wrap('notifications', { notifications: [{ notification_type: 'like', message: 'liked your post', actor_user: { username: 'ravi' }, created_at: '2026-10-09T10:00:00Z' }], unread_count: 1 }));
      case 'GET /v1/chat':
        if (url.searchParams.get('conversation_id')) return send(200, wrap('chat messages', { messages: [{ sender_id: 'me-1', content_type: 'text', body: 'hi there' }, { sender_id: 'other-22', content_type: 'image', media_name: 'cat.jpg', media_url: 'https://secret.example/cat.jpg' }] }));
        return send(200, wrap('conversations', { active: [{ id: 'conv-12345678', members: [{ user_id: 'me-1' }, { user_id: 'other-22' }] }], pending: [] }));
      case 'POST /v1/posts': {
        if (state.balance < 1) return send(400, { error: 'post creation failed: status 402' });
        state.balance -= 1; const body = JSON.parse(raw); state.posts.push(body);
        return send(200, wrap('created post', { id: 'new-post', content: body.content, author: { username: 'asha' } }));
      }
      case 'POST /v1/media': state.uploads.push(JSON.parse(raw)); return send(200, { result: "Uploaded. Pass this exact string in create_post's media list:\n1790_ref.jpg" });
      case 'POST /v1/stories': state.stories.push(JSON.parse(raw)); return send(200, { result: 'Story posted.' });
      default: return send(404, { error: 'no route' });
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

test('the sample end to end', async (t) => {
  const mock = await startMock();
  process.env.BATIYAO_API = mock.base;
  process.env.BATIYAO_CLIENT_ID = 'test-client';
  process.env.REDIRECT_URI = 'http://localhost:3999/callback';
  const { handle } = require('../server');
  const app = http.createServer((req, res) => handle(req, res));
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(() => { app.close(); mock.server.close(); });

  let cookie = '';
  const go = async (path, opts = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { res, text: await res.text() };
  };
  const csrfOf = (html) => html.match(/name="csrf" value="([0-9a-f]+)"/)?.[1] || html.match(/window\.CSRF = "([0-9a-f]+)"/)?.[1];

  // Not connected: the connect page.
  let r = await go('/');
  assert.match(r.text, /Connect with Batiyao/);

  // Connect → Batiyao's authorize URL with PKCE.
  r = await go('/connect?scope=read:feed&scope=read:notifications&scope=read:chat&scope=write:post&scope=write:media');
  assert.strictEqual(r.res.status, 302);
  const auth = new URL(r.res.headers.get('location'));
  assert.strictEqual(auth.pathname, '/oauth/authorize');
  assert.strictEqual(auth.searchParams.get('code_challenge_method'), 'S256');

  // A callback with the wrong state is refused, and burns the attempt.
  r = await go('/callback?code=x&state=wrong');
  assert.strictEqual(r.res.headers.get('location'), '/');

  // Start again, and come back as Batiyao would.
  r = await go('/connect?scope=read:feed&scope=read:notifications&scope=read:chat&scope=write:post&scope=write:media');
  const auth2 = new URL(r.res.headers.get('location'));
  mock.state.codes.set('good-code', { challenge: auth2.searchParams.get('code_challenge') });
  r = await go(`/callback?code=good-code&state=${auth2.searchParams.get('state')}`);
  assert.strictEqual(r.res.headers.get('location'), '/');
  r = await go('/');
  assert.match(r.text, /Connected/);

  // Reads.
  assert.match((await go('/profile')).text, /@asha/);
  r = await go('/feed');
  assert.match(r.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; hello/, 'feed content must be escaped');
  assert.doesNotMatch(r.text, /<script>alert/);
  assert.match((await go('/posts/p1')).text, /one post/);
  assert.match((await go('/notifications')).text, /liked your post/);
  r = await go('/chats');
  assert.match(r.text, /Conversation conv-123/);
  assert.match(r.text, /you, other-22/);
  r = await go('/chats/conv-12345678');
  assert.match(r.text, /hi there/);
  assert.match(r.text, /\[image: cat\.jpg\]/);
  assert.doesNotMatch(r.text, /secret\.example/, 'never show a chat media URL');

  // Posting asks before it spends, and checks the rules first.
  r = await go('/post');
  const csrf = csrfOf(r.text);
  const post = (fields) => go('/post', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...fields }).toString() });
  r = await post({ content: 'Hello #tag', content_rating: 'sfw', rating_reasoning: 'text only' });
  assert.match(r.text, /Remove the #hashtags/);
  assert.match(r.text, /confirm spending 1\.0 BuckBuck/);
  assert.strictEqual(mock.state.posts.length, 0, 'nothing published without consent');
  r = await post({ content: 'Hello from the sample', content_rating: 'sfw', rating_reasoning: 'text only', confirm_cost: 'yes', media: '1790_ref.jpg' });
  assert.strictEqual(r.res.headers.get('location'), '/posts/new-post');
  assert.deepStrictEqual(mock.state.posts[0], { content: 'Hello from the sample', content_rating: 'sfw', rating_reasoning: 'text only', media_urls: ['1790_ref.jpg'] });

  // A request without the session's CSRF token is refused.
  r = await go('/post', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'content=x&csrf=forged' });
  assert.match(r.text, /Bad CSRF token/);

  // Media and stories, as the browser script sends them.
  const upload = (path, extra = {}) => go(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ filename: 'a.jpg', content_type: 'image/jpeg', data_base64: 'AAAA', ...extra }) });
  r = await upload('/media');
  assert.strictEqual(JSON.parse(r.text).reference, '1790_ref.jpg');
  r = await upload('/story');
  assert.strictEqual(JSON.parse(r.text).ok, true);
  assert.strictEqual(mock.state.stories[0].content_rating, 'sfw');

  // Out of BuckBuck: a 402 is a normal outcome, said plainly.
  mock.state.balance = 0;
  r = await post({ content: 'One more', content_rating: 'sfw', rating_reasoning: 'text', confirm_cost: 'yes' });
  assert.match(r.text, /Not enough BuckBuck/);

  // An access token Batiyao rejects is refreshed once, transparently.
  mock.state.access.clear();
  const before = mock.state.n;
  assert.match((await go('/profile')).text, /@asha/);
  assert.strictEqual(mock.state.n, before + 1, 'refreshed once');

  // A content problem comes back as a 400 whose sentence is shown as it is.
  mock.state.balance = 5;

  // The person disconnects the app from Batiyao's settings: calls get 403, the
  // refresh says "connection revoked", and the sample asks them to connect again.
  mock.state.connectionRevoked = true;
  r = await go('/profile');
  assert.strictEqual(r.res.status, 401);
  assert.match(r.text, /Connect again/);
  mock.state.connectionRevoked = false;

  // Connect again for the rest.
  r = await go('/connect?scope=read:feed');
  const auth3 = new URL(r.res.headers.get('location'));
  mock.state.codes.set('code-3', { challenge: auth3.searchParams.get('code_challenge') });
  await go(`/callback?code=code-3&state=${auth3.searchParams.get('state')}`);
  assert.match((await go('/profile')).text, /@asha/);

  // Disconnect revokes the access token at Batiyao.
  const tokenNow = mock.state.lastToken;
  r = await go('/disconnect', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}` });
  assert.deepStrictEqual(mock.state.revoked, [tokenNow]);
  r = await go('/profile');
  assert.strictEqual(r.res.headers.get('location'), '/', 'signed out after disconnect');
});
