// Small helpers so the sample needs nothing beyond Node itself: a .env
// loader, an in-memory session store, request-body reading, HTML escaping,
// and unwrapping Batiyao's API results.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Loads KEY=value lines from .env into process.env (existing values win). */
function loadEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/**
 * Sessions live in memory, keyed by an unguessable cookie. Tokens never reach
 * the browser — only this cookie does. A real app would use a persistent,
 * encrypted store; restarting the sample signs everyone out.
 */
class SessionStore {
  constructor({ maxAgeMs = 8 * 60 * 60 * 1000 } = {}) {
    this.sessions = new Map();
    this.maxAgeMs = maxAgeMs;
  }

  get(req, res) {
    const sid = parseCookies(req.headers.cookie).sid;
    let entry = sid && this.sessions.get(sid);
    if (entry && Date.now() - entry.touched > this.maxAgeMs) {
      this.sessions.delete(sid);
      entry = null;
    }
    if (!entry) {
      const id = crypto.randomBytes(32).toString('hex');
      entry = { id, touched: Date.now(), data: {} };
      this.sessions.set(id, entry);
      res.setHeader('Set-Cookie', `sid=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${this.maxAgeMs / 1000}`);
    }
    entry.touched = Date.now();
    return entry.data;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Reads a request body, refusing anything over maxBytes. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Everything shown from Batiyao is user-authored: escape all of it. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Batiyao's API answers {"result": "..."}. Read endpoints put a one-line
 * label ("UNTRUSTED PLATFORM DATA (feed) — …") before a JSON document — a
 * reminder that what follows was written by people, not by Batiyao. This
 * returns the parsed document, or the text as it came for anything else.
 */
function unwrap(data) {
  const result = data && typeof data.result === 'string' ? data.result : null;
  if (result === null) return data;
  const newline = result.indexOf('\n');
  if (result.startsWith('UNTRUSTED PLATFORM DATA') && newline > 0) {
    try {
      return JSON.parse(result.slice(newline + 1));
    } catch {
      return result.slice(newline + 1);
    }
  }
  return result;
}

/**
 * uploadMedia answers with a sentence whose last line is the media reference;
 * pass that string, unchanged, in a post's media_urls.
 */
function mediaReference(data) {
  const text = typeof data?.result === 'string' ? data.result : '';
  const lines = text.trim().split('\n');
  return lines[lines.length - 1].trim();
}

module.exports = { loadEnv, SessionStore, parseCookies, readBody, esc, unwrap, mediaReference };
