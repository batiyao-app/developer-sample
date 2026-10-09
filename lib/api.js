// A small client for Batiyao's public API (https://api.batiyao.com/v1).
//
// It keeps the session's access token fresh and turns Batiyao's status codes
// into the outcomes the developer guide describes:
//   401 → refresh once; if that fails, the person must connect again
//   402 → not enough BuckBuck: tell them, don't retry
//   403 → a permission is missing or was switched off (or the account may not
//         do this, e.g. a minor's): show the message, don't retry, don't
//         send them back through consent
//   429 → slow down

'use strict';

const oauth = require('./oauth');

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }

  /** What to tell the person, in plain words. */
  get advice() {
    switch (this.status) {
      case 401:
        return 'Your Batiyao connection has ended. Connect again to continue.';
      case 402:
        return "There isn't enough BuckBuck on your account for this. Nothing was spent.";
      case 403:
        return 'Batiyao refused this: the permission may not have been granted, may have been switched off in Batiyao → Settings → Connected apps, or this account may not be allowed to do it.';
      case 429:
        return 'Too many requests. Wait a moment and try again.';
      default:
        return 'Batiyao could not do this right now.';
    }
  }
}

class BatiyaoClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiBase      e.g. https://api.batiyao.com
   * @param {string} opts.clientId
   * @param {object} opts.session      holds .tokens, which this client updates
   */
  constructor({ apiBase, clientId, session }) {
    this.apiBase = apiBase;
    this.clientId = clientId;
    this.session = session;
  }

  async ensureFresh() {
    const t = this.session.tokens;
    if (!t) throw new ApiError(401, 'Not connected');
    if (Date.now() < t.expiresAt) return;
    await this.refreshTokens();
  }

  async refreshTokens() {
    const t = this.session.tokens;
    if (!t?.refreshToken) {
      this.session.tokens = null;
      throw new ApiError(401, 'Session expired and there is no refresh token');
    }
    try {
      const next = await oauth.refresh({ apiBase: this.apiBase, clientId: this.clientId, refreshToken: t.refreshToken });
      // Keep what was granted if the refresh response doesn't restate it.
      this.session.tokens = { ...next, scopes: next.scopes || t.scopes };
    } catch (err) {
      // The person disconnected the app, or the refresh token expired.
      this.session.tokens = null;
      throw new ApiError(401, err.message, err.body);
    }
  }

  async request(method, path, body, { retried = false } = {}) {
    await this.ensureFresh();
    const res = await fetch(new URL(path, this.apiBase), {
      method,
      headers: {
        Authorization: `Bearer ${this.session.tokens.accessToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (res.status === 401 && !retried) {
      // The access token may have been rejected early; try one refresh.
      await this.refreshTokens();
      return this.request(method, path, body, { retried: true });
    }
    if (res.status === 401) this.session.tokens = null;
    if (!res.ok) {
      const message = data?.error_description || data?.error || data?.message || `HTTP ${res.status}`;
      throw new ApiError(res.status, typeof message === 'string' ? message : JSON.stringify(message), data);
    }
    return data;
  }

  // --- read:feed ---------------------------------------------------------
  profile() {
    return this.request('GET', '/v1/profile');
  }

  feed(limit = 20) {
    return this.request('GET', `/v1/updates?limit=${encodeURIComponent(limit)}`);
  }

  post(postId) {
    return this.request('GET', `/v1/posts/${encodeURIComponent(postId)}`);
  }

  // --- read:notifications ------------------------------------------------
  notifications() {
    return this.request('GET', '/v1/notifications');
  }

  // --- read:chat ---------------------------------------------------------
  conversations() {
    return this.request('GET', '/v1/chat');
  }

  messages(conversationId) {
    return this.request('GET', `/v1/chat?conversation_id=${encodeURIComponent(conversationId)}`);
  }

  // --- write:post (costs 1.0 BuckBuck) ------------------------------------
  createPost({ content, contentRating, ratingReasoning, mediaUrls }) {
    return this.request('POST', '/v1/posts', {
      content,
      content_rating: contentRating,
      rating_reasoning: ratingReasoning,
      ...(mediaUrls && mediaUrls.length ? { media_urls: mediaUrls } : {}),
    });
  }

  // --- write:media (free) --------------------------------------------------
  /** Returns a media reference to pass back, unchanged, in createPost's mediaUrls. */
  uploadMedia({ filename, contentType, dataBase64 }) {
    return this.request('POST', '/v1/media', {
      filename,
      content_type: contentType,
      data_base64: dataBase64,
    });
  }

  // --- write:post + write:media (free) -------------------------------------
  /** A 48-hour story for the person's followers. Must be suitable for everyone. */
  createStory({ filename, contentType, dataBase64, ratingReasoning }) {
    return this.request('POST', '/v1/stories', {
      filename,
      content_type: contentType,
      data_base64: dataBase64,
      content_rating: 'sfw',
      rating_reasoning: ratingReasoning,
    });
  }
}

/**
 * Checks a post against Batiyao's writing rules before spending anything:
 * 500 characters at most (counted in characters, so an emoji is one), and no
 * typed #hashtags — Batiyao generates hashtags itself and rejects typed ones.
 * Returns a list of problems; empty means fine.
 */
function checkPost(content) {
  const problems = [];
  const text = String(content || '').trim();
  if (!text) problems.push('Write something first.');
  if ([...text].length > 500) problems.push(`That is ${[...text].length} characters; the limit is 500.`);
  if (/(^|\s)#[\p{L}\p{N}_]+/u.test(text)) {
    problems.push('Remove the #hashtags — Batiyao adds hashtags itself and rejects typed ones.');
  }
  return problems;
}

module.exports = { BatiyaoClient, ApiError, checkPost };
