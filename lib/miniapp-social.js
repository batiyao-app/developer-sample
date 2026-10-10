// The rules behind nicknames, the shared store and multiplayer codes, in
// JavaScript, so the simulator behaves like Batiyao. Batiyao's own server is
// the authority; these follow the Mini apps guide on developer.batiyao.com.

'use strict';

const crypto = require('node:crypto');

// ---------------------------------------------------------------- nicknames

// Words an adult's nickname may not contain (any case, anywhere), on top of
// the shape rules below. Batiyao's list of slurs is longer; these are here so
// the simulator refuses something.
const RESERVED = ['batiyao', 'admin', 'moderator', 'official', 'support'];
const SLURS = ['nigger', 'nigga', 'faggot', 'retard', 'chink', 'spic', 'kike', 'tranny', 'paki'];

// checkNickname returns { nickname } (tidied: trimmed, single spaces) or
// { problem } in words the person can act on.
function checkNickname(input) {
  if (typeof input !== 'string') return { problem: 'Type a nickname.' };
  const nickname = input.trim().replace(/\s+/g, ' ');
  const length = [...nickname].length;
  if (length < 3) return { problem: 'A nickname is at least 3 characters.' };
  if (length > 20) return { problem: 'A nickname is at most 20 characters.' };
  if (/[@#]/.test(nickname)) return { problem: "A nickname can't have @ or #." };
  if (/(https?|www\.)|\.[a-z]{2,}\b/i.test(nickname)) return { problem: "A nickname can't be a web address." };
  if (!/^[\p{L}\p{N} ._-]+$/u.test(nickname)) return { problem: 'Use letters, numbers, spaces, dots, dashes and underscores.' };
  if ((nickname.match(/\p{N}/gu) || []).length >= 5) return { problem: "A nickname can't have 5 or more digits (it could be a phone number)." };
  const lower = nickname.toLowerCase();
  if (RESERVED.some((w) => lower.includes(w))) return { problem: 'That nickname is kept for Batiyao. Choose another.' };
  const squashed = lower.replace(/[^\p{L}]/gu, '');
  if (SLURS.some((w) => squashed.includes(w))) return { problem: "That nickname isn't allowed. Choose another." };
  return { nickname };
}

const ADJECTIVES = ['Blue', 'Brave', 'Bright', 'Calm', 'Clever', 'Cosmic', 'Golden', 'Happy', 'Jolly', 'Kind',
  'Lucky', 'Mighty', 'Quick', 'Quiet', 'Silver', 'Sunny', 'Swift', 'Wild', 'Witty', 'Zippy'];
const ANIMALS = ['Falcon', 'Otter', 'Panda', 'Tiger', 'Dolphin', 'Fox', 'Owl', 'Koala', 'Lynx', 'Robin',
  'Turtle', 'Badger', 'Heron', 'Gecko', 'Rabbit', 'Puffin', 'Yak', 'Lemur', 'Bison', 'Squirrel'];

// suggestNicknames makes n different names like "Blue Falcon 27": an
// adjective, an animal and two digits. These are all a child may choose from.
function suggestNicknames(n = 6, rand = Math.random) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const out = new Set();
  while (out.size < n) out.add(`${pick(ADJECTIVES)} ${pick(ANIMALS)} ${10 + Math.floor(rand() * 90)}`);
  return [...out];
}

// --------------------------------------------------------------- the store

const STORE_LIMIT = 1048576; // 1 MB per app (test runs have their own)
const VALUE_LIMIT = 1024; // bytes of UTF-8
const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const recordSize = (key, value) => utf8(key) + utf8(value);

// replacementOrder is the order replaceable records give way in when a write
// doesn't fit: no rank before ranked, lower rank first, older first.
function replacementOrder(a, b) {
  const an = a.rank == null, bn = b.rank == null;
  if (an !== bn) return an ? -1 : 1;
  if (!an && a.rank !== b.rank) return a.rank - b.rank;
  return a.updated_at - b.updated_at;
}

// planWrite decides what one write does to a full store. records: every
// record in the store ({ player, key, size, rank, replaceable, updated_at });
// incoming: the write ({ player, key, size, rank, replaceable }, now).
// Returns { save: true, evict: [records] }, { save: false } (the write is
// replaceable and would itself go first: "didn't make the board") or
// { error: 'STORE_FULL' } (it doesn't fit and nothing replaceable can go).
function planWrite(records, incoming, limit = STORE_LIMIT, now = Date.now()) {
  const same = (r) => r.player === incoming.player && r.key === incoming.key;
  const others = records.filter((r) => !same(r));
  const used = others.reduce((n, r) => n + r.size, 0);
  let over = used + incoming.size - limit;
  if (over <= 0) return { save: true, evict: [] };
  const mine = { ...incoming, updated_at: now, incoming: true };
  const candidates = others.filter((r) => r.replaceable);
  if (incoming.replaceable) candidates.push(mine);
  candidates.sort(replacementOrder);
  const evict = [];
  for (const r of candidates) {
    if (r.incoming) return { save: false };
    evict.push(r);
    over -= r.size;
    if (over <= 0) return { save: true, evict };
  }
  return incoming.replaceable ? { save: false } : { error: 'STORE_FULL' };
}

// ------------------------------------------------------------- multiplayer

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

function matchCode() {
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

module.exports = {
  checkNickname, suggestNicknames, RESERVED, SLURS,
  STORE_LIMIT, VALUE_LIMIT, KEY_RE, recordSize, replacementOrder, planWrite,
  CODE_ALPHABET, CODE_RE, matchCode,
};
