// OAuth 2.1 with PKCE against Batiyao — everything the "Connect with Batiyao"
// button needs, and nothing else.
//
// Batiyao issues no client secret. PKCE is what proves the code exchange came
// from the same app that started the sign-in, which is why the verifier is
// generated per attempt and kept server-side until the callback.

'use strict';

const crypto = require('node:crypto');

// Every permission an app can ask for, and what the person is told it means.
// Ask for the fewest you need: a consent screen asking for everything is one
// people decline.
const SCOPES = {
  'read:feed': 'Read your feed, posts and profile',
  'read:notifications': 'Read your notifications',
  'read:chat': 'Read your private conversations',
  'write:post': 'Publish posts as you (costs BuckBuck)',
  'write:media': 'Upload photos and videos to your account',
};

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh PKCE pair: the verifier stays here, the challenge goes to Batiyao. */
function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  return { verifier, challenge: challengeFor(verifier) };
}

/** S256: base64url(SHA-256(verifier)), RFC 7636 §4.2. */
function challengeFor(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

/** An unguessable value tying the callback to the sign-in this session started. */
function createState() {
  return base64url(crypto.randomBytes(24));
}

function authorizeUrl({ apiBase, clientId, redirectUri, scopes, state, challenge }) {
  const url = new URL('/oauth/authorize', apiBase);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

class OAuthError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function postForm(apiBase, path, fields) {
  const res = await fetch(new URL(path, apiBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { res, body };
}

/** Normalises a token response into what the session keeps. */
function tokenSet(body) {
  if (!body || !body.access_token) {
    throw new OAuthError('Batiyao did not return an access token', 502, body);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : null,
    // Refresh a minute early so a request never races the expiry.
    expiresAt: Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000,
  };
}

/** Trades the one-time code (plus the verifier) for tokens. */
async function exchangeCode({ apiBase, clientId, redirectUri, code, verifier }) {
  const { res, body } = await postForm(apiBase, '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (!res.ok) {
    throw new OAuthError(body?.error_description || body?.error || 'Code exchange failed', res.status, body);
  }
  return tokenSet(body);
}

/**
 * Gets a new access token. Batiyao rotates refresh tokens: the old one stops
 * working the moment a new one is issued, so always keep the one returned.
 */
async function refresh({ apiBase, clientId, refreshToken }) {
  const { res, body } = await postForm(apiBase, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (!res.ok) {
    throw new OAuthError(body?.error_description || body?.error || 'Refresh failed', res.status, body);
  }
  return tokenSet(body);
}

/**
 * Disconnects this app from the person's account. Batiyao revokes the whole
 * connection when it is handed the *access* token; it always answers 200.
 */
async function revoke({ apiBase, clientId, accessToken }) {
  await postForm(apiBase, '/oauth/revoke', { token: accessToken, client_id: clientId });
}

module.exports = {
  SCOPES,
  createPkcePair,
  challengeFor,
  createState,
  authorizeUrl,
  exchangeCode,
  refresh,
  revoke,
  OAuthError,
};
