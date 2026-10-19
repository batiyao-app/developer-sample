'use strict';
// The mini app tools: the rules match what Batiyao's upload refuses, the
// packer writes a zip any unzip can read, and the simulator serves the
// sample game sealed off.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const zlib = require('node:zlib');
const { checkBundle, millis } = require('../lib/miniapp-rules');
const { zip, crc32, readFolder } = require('../tools/pack-miniapp');
const simulator = require('../tools/miniapp-simulator');

const WINGBEAT = path.join(__dirname, '..', 'miniapp', 'wingbeat');
const withFile = (files, p, text) => files.filter((f) => f.path !== p).concat([{ path: p, data: Buffer.from(text) }]);

test('the sample game passes every rule', () => {
  const { problems, manifest } = checkBundle(readFolder(WINGBEAT));
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(manifest.name, 'Wingbeat');
});

test('anything from outside the bundle is refused', () => {
  const files = readFolder(WINGBEAT);
  const remote = checkBundle(withFile(files, 'index.html', '<!doctype html><script src="https://cdn.example.com/x.js"></script>'));
  assert.ok(remote.problems.some((p) => p.startsWith('index.html')), remote.problems.join('; '));
  const rooted = checkBundle(withFile(files, 'index.html', '<!doctype html><img src="/bird.png">'));
  assert.ok(rooted.problems.some((p) => p.startsWith('index.html')), rooted.problems.join('; '));
  const css = checkBundle(withFile(files, 'style.css', 'body{background:url(https://example.com/a.png)}'));
  assert.ok(css.problems.some((p) => p.startsWith('style.css')), css.problems.join('; '));
});

test('manifest mistakes are all listed at once', () => {
  const files = readFolder(WINGBEAT);
  const m = JSON.parse(files.find((f) => f.path === 'manifest.json').data);
  m.version = 'one';
  m.category = 'casino';
  m.products[0].price = '25';
  const { problems } = checkBundle(withFile(files, 'manifest.json', JSON.stringify(m)));
  assert.ok(problems.length >= 3, problems.join('; '));
});

test('prices are counted in thousandths, never floats', () => {
  assert.strictEqual(millis('0.5'), 500);
  assert.strictEqual(millis('20'), 20000);
  assert.strictEqual(millis('0.123'), 123);
});

test('the packer writes a valid zip', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')) >>> 0, 0xcbf43926);
  const files = readFolder(WINGBEAT);
  const bytes = zip(files);
  assert.strictEqual(bytes.readUInt32LE(0), 0x04034b50);
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.strictEqual(bytes.readUInt16LE(eocd + 10), files.length);
  // Read every entry back from the local headers and compare.
  let off = 0;
  for (const f of files) {
    assert.strictEqual(bytes.readUInt32LE(off), 0x04034b50);
    const method = bytes.readUInt16LE(off + 8);
    const size = bytes.readUInt32LE(off + 18);
    const nameLen = bytes.readUInt16LE(off + 26);
    const extraLen = bytes.readUInt16LE(off + 28);
    const name = bytes.toString('utf8', off + 30, off + 30 + nameLen);
    const start = off + 30 + nameLen + extraLen;
    const raw = bytes.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.strictEqual(name, f.path);
    assert.ok(data.equals(f.data), f.path);
    off = start + size;
  }
});

test('the simulator serves the game sealed off', async () => {
  const server = simulator.main([WINGBEAT, '--port', '31099']);
  await new Promise((r) => server.once('listening', r));
  try {
    const host = await fetch('http://127.0.0.1:31099/');
    const html = await host.text();
    assert.match(html, /sandbox="allow-scripts allow-forms"/);
    // The page's script is built inside a template string; it must still parse.
    new (require('node:vm').Script)(html.split('<script>')[1].split('</script>')[0]);
    const page = await fetch('http://127.0.0.1:31099/app/index.html');
    assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts allow-forms; default-src 'none'/);
    assert.match(await page.text(), /^<!doctype html><script>/i);
    assert.strictEqual((await fetch('http://127.0.0.1:31099/app/../package.json')).status, 404);
    assert.strictEqual((await fetch('http://127.0.0.1:31099/app/%2e%2e/package.json')).status, 404);
  } finally {
    server.close();
  }
});

// The SDK in a stand-in page: `answer(method, params)` plays Batiyao.
function sdkWith(answer, { framed = true } = {}) {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const sent = [];
  let onMessage = null;
  const win = { addEventListener: (type, fn) => { if (type === 'message') onMessage = fn; } };
  win.parent = framed ? {
    postMessage(msg) {
      sent.push(msg);
      const out = answer(msg.method, msg.params);
      setImmediate(() => onMessage({ source: win.parent, data: { batiyao: 1, id: msg.id, ...out } }));
    },
  } : win;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'miniapp-sdk', 'batiyao-miniapp.js'), 'utf8'), { window: win, setTimeout, clearTimeout, Promise, Blob });
  const emit = (event, data) => onMessage({ source: win.parent, data: { batiyao: 1, event, data } });
  return { Batiyao: win.Batiyao, sent, emit };
}
const code = (p) => p.then(() => 'resolved', (e) => e.code);

test('pickImage and pickVideo check their options before asking Batiyao', async () => {
  const { Batiyao, sent } = sdkWith(() => ({ result: { status: 'cancelled' } }));
  assert.strictEqual(Batiyao.version, '1.10.0');
  for (const bad of [10, 5000, 1.5, '512']) assert.strictEqual(await code(Batiyao.pickImage({ max_size: bad })), 'INVALID');
  for (const bad of [0, 601, 'x', Infinity]) assert.strictEqual(await code(Batiyao.pickVideo({ max_seconds: bad })), 'INVALID');
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(JSON.stringify(await Batiyao.pickImage({ max_size: 512 })), '{"status":"cancelled"}');
  await Batiyao.pickImage();
  await Batiyao.pickVideo({ max_seconds: 30 });
  // (Objects from the SDK's own realm: compare as JSON.)
  assert.strictEqual(JSON.stringify(sent.map((m) => [m.method, m.params])), JSON.stringify([['pickImage', { max_size: 512 }], ['pickImage', {}], ['pickVideo', { max_seconds: 30 }]]));
});

test('supports() reads features, and knows what an older Batiyao had', async () => {
  let asked = 0;
  const now = sdkWith((m) => { if (m === 'getContext') asked++; return { result: { platform: 'web', features: ['pay', 'share', 'pickImage', 'pickVideo'] } }; }).Batiyao;
  assert.strictEqual(await now.supports('pickImage'), true);
  assert.strictEqual(await now.supports('pickVideo'), true);
  assert.strictEqual(await now.supports('teleport'), false);
  assert.strictEqual(await now.supports('storage.get'), true);
  assert.strictEqual(asked, 1, 'getContext is asked once');

  const older = sdkWith(() => ({ result: { platform: 'android' } })).Batiyao;
  assert.strictEqual(await older.supports('pickImage'), false);
  assert.strictEqual(await older.supports('pickVideo'), false);
  assert.strictEqual(await older.supports('pay'), true);
  assert.strictEqual(await older.supports('share'), true);

  const broken = sdkWith(() => ({ error: { code: 'FAILED', message: 'no' } })).Batiyao;
  assert.strictEqual(await broken.supports('pickImage'), false);

  const outside = sdkWith(() => ({}), { framed: false }).Batiyao;
  assert.strictEqual(await outside.supports('pickImage'), false);
  assert.strictEqual(await outside.supports('ready'), false);
  assert.strictEqual(await code(outside.pickImage()), 'NO_HOST');
});

test('the simulator offers the picker and lists its features', async () => {
  const server = simulator.main([WINGBEAT, '--port', '31098']);
  await new Promise((r) => server.once('listening', r));
  try {
    const html = await (await fetch('http://127.0.0.1:31098/?pick=unavailable')).text();
    assert.match(html, /id="pick-sheet"/);
    assert.match(html, /features: features\(\)/);
    assert.match(html, /case 'pickImage':/);
    const page = await (await fetch('http://127.0.0.1:31098/app/index.html')).text();
    assert.match(page, /HTMLInputElement\.prototype,"files"/);
  } finally {
    server.close();
  }
});

// --- 1.3.0: nicknames, the shared store, multiplayer ---
const social = require('../lib/miniapp-social');
const asJSON = (v) => JSON.stringify(v);

test('db checks keys, values, ranks and list options before asking Batiyao', async () => {
  const { Batiyao, sent } = sdkWith((m) => ({ result: m === 'db.get' ? { record: null } : { saved: true } }));
  assert.strictEqual(await code(Batiyao.db.set('bad key', 'x')), 'INVALID_KEY');
  assert.strictEqual(await code(Batiyao.db.set('best', 42)), 'INVALID');
  assert.strictEqual(await code(Batiyao.db.set('best', 'é'.repeat(513))), 'VALUE_TOO_LONG'); // 1,026 bytes
  assert.strictEqual(await code(Batiyao.db.set('best', 'x', { rank: NaN })), 'INVALID');
  assert.strictEqual(await code(Batiyao.db.set('best', 'x', { rank: '9' })), 'INVALID');
  assert.strictEqual(await code(Batiyao.db.list('best', { order: 'top' })), 'INVALID');
  assert.strictEqual(await code(Batiyao.db.list('best', { limit: 0 })), 'INVALID');
  assert.strictEqual(await code(Batiyao.db.list('best', { limit: 101 })), 'INVALID');
  assert.strictEqual(await code(Batiyao.db.get('best', { player: 7 })), 'INVALID');
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(asJSON(await Batiyao.db.set('best', 'é'.repeat(512), { replaceable: true, rank: 120 })), '{"saved":true}');
  await Batiyao.db.set('note', 'hi');
  assert.strictEqual(await Batiyao.db.get('best'), null);
  assert.strictEqual(asJSON(sent.map((m) => [m.method, m.params])), asJSON([
    ['db.set', { key: 'best', value: 'é'.repeat(512), replaceable: true, rank: 120 }],
    ['db.set', { key: 'note', value: 'hi', replaceable: false }],
    ['db.get', { key: 'best' }],
  ]));
});

test('multiplayer checks its options, sends without waiting, and delivers events', async () => {
  const { Batiyao, sent, emit } = sdkWith((m) => (m === 'mp.send' ? {} : { result: { status: 'cancelled' } }));
  for (const bad of [1, 9, 2.5, '4', undefined]) assert.strictEqual(await code(Batiyao.multiplayer.host({ max_players: bad })), 'INVALID');
  assert.strictEqual(await code(Batiyao.multiplayer.host({ max_players: 2, meta: { pad: 'x'.repeat(300) } })), 'INVALID');
  assert.strictEqual(await code(Batiyao.multiplayer.host({ max_players: 2, meta: [1] })), 'INVALID');
  assert.strictEqual(await code(Batiyao.multiplayer.join()), 'INVALID');
  assert.strictEqual(await code(Batiyao.multiplayer.join({ code: 'ABC' })), 'INVALID');
  assert.strictEqual(await code(Batiyao.multiplayer.join({ code: 'ABCDE1' })), 'INVALID'); // 1 isn't in the alphabet
  assert.strictEqual(await code(Batiyao.multiplayer.join({ code: 'ABCDEF', match: 'm_1' })), 'INVALID');
  assert.strictEqual(await code(Batiyao.multiplayer.send({ big: 'x'.repeat(2000) })), 'MESSAGE_TOO_LARGE');
  assert.strictEqual(await code(Batiyao.multiplayer.send(undefined)), 'INVALID');
  assert.strictEqual(sent.length, 0);
  await Batiyao.multiplayer.host({ max_players: 4, public: true, meta: { mode: 'duel' } });
  await Batiyao.multiplayer.join({ code: ' abcdef ' });
  assert.strictEqual(asJSON(await Batiyao.multiplayer.send({ x: 1 }, { to: 'p2' })), '{}');
  assert.strictEqual(asJSON(sent.map((m) => [m.method, m.params])), asJSON([
    ['mp.host', { max_players: 4, public: true, meta: { mode: 'duel' } }],
    ['mp.join', { code: 'ABCDEF' }],
    ['mp.send', { data: { x: 1 }, to: 'p2' }],
  ]));
  const got = [];
  Batiyao.multiplayer.on('message', (d) => got.push(['message', d.data.x]));
  Batiyao.on('nickname', (d) => got.push(['nickname', d.nickname]));
  emit('mp.message', { from: { id: 'p2', nickname: 'Ana' }, data: { x: 5 } });
  emit('nickname', { nickname: 'Blue Fox 12' });
  assert.strictEqual(asJSON(got), asJSON([['message', 5], ['nickname', 'Blue Fox 12']]));
});

test('getNickname asks only when told to', async () => {
  const { Batiyao, sent } = sdkWith(() => ({ result: { nickname: null } }));
  assert.strictEqual(asJSON(await Batiyao.getNickname()), '{"nickname":null}');
  await Batiyao.getNickname({ ask: true });
  assert.strictEqual(asJSON(sent.map((m) => m.params)), asJSON([{}, { ask: true }]));
});

test('supports() knows db, nickname and multiplayer only from features', async () => {
  const now = sdkWith(() => ({ result: { features: ['pay', 'share', 'db', 'nickname', 'multiplayer'] } })).Batiyao;
  for (const f of ['db', 'nickname', 'multiplayer', 'getNickname', 'db.set', 'multiplayer.host']) assert.strictEqual(await now.supports(f), true, f);
  const older = sdkWith(() => ({ result: { features: ['pay', 'share', 'pickImage', 'pickVideo'] } })).Batiyao;
  for (const f of ['db', 'nickname', 'multiplayer', 'getNickname']) assert.strictEqual(await older.supports(f), false, f);
  const oldest = sdkWith(() => ({ result: {} })).Batiyao;
  assert.strictEqual(await oldest.supports('multiplayer'), false);
});

test('a full store replaces what the app marked replaceable, in order', () => {
  const r = (player, key, size, rank, replaceable, updated_at) => ({ player, key, size, rank, replaceable, updated_at });
  // Fits: nothing goes.
  assert.deepStrictEqual(social.planWrite([r('a', 'k', 10, 1, true, 1)], r('b', 'k', 10, 5, true), 100), { save: true, evict: [] });
  const full = [
    r('a', 'best', 30, 50, true, 1), // ranked
    r('b', 'best', 30, 10, true, 2), // ranked, lower
    r('c', 'note', 20, null, true, 3), // unranked: goes first
    r('d', 'save', 20, null, false, 0), // never replaced
  ];
  // 100 used of 100; a 25-byte write needs 25: unranked c (20), then lowest rank b (30).
  let plan = social.planWrite(full, r('e', 'best', 25, 40, true), 100, 10);
  assert.deepStrictEqual(plan.evict.map((x) => x.player), ['c', 'b']);
  // Ranks below everything replaceable that would have to go: not saved, nothing removed.
  plan = social.planWrite(full, r('e', 'best', 25, 5, true), 100, 10);
  assert.deepStrictEqual(plan, { save: false });
  // Not replaceable and too big for what can go: STORE_FULL.
  assert.deepStrictEqual(social.planWrite(full, r('e', 'big', 90, null, false), 100), { error: 'STORE_FULL' });
  // Not replaceable but fits after the replaceable ones go.
  assert.deepStrictEqual(social.planWrite(full, r('e', 'save', 20, null, false), 100).evict.map((x) => x.player), ['c']);
  // Rewriting my own record frees its old size first.
  assert.deepStrictEqual(social.planWrite(full, r('a', 'best', 30, 60, true), 100), { save: true, evict: [] });
  // Same rank: older first.
  plan = social.planWrite([r('a', 'k', 50, 1, true, 5), r('b', 'k', 50, 1, true, 1)], r('c', 'k', 10, 9, true), 100, 10);
  assert.deepStrictEqual(plan.evict.map((x) => x.player), ['b']);
});

test('nicknames: what an adult may type, and what a child picks from', () => {
  assert.deepStrictEqual(social.checkNickname('  Ana   B  '), { nickname: 'Ana B' });
  assert.deepStrictEqual(social.checkNickname('Zoë_9.x-y'), { nickname: 'Zoë_9.x-y' });
  // Any script: Burmese, Chinese (two characters), Hindi, Persian with a joiner, Thai.
  for (const ok of ['မောင်မောင်ဦး', '小明', 'राहुल', 'علی\u200cرضا', 'สมชาย ใจดี']) {
    assert.ok(social.checkNickname(ok).nickname, ok);
  }
  for (const bad of ['a', 'x'.repeat(21), '@ana', 'ana#1', 'www.ana', 'ana.com', 'http ana', 'ana 12345', '9 8 7 6 5 x',
    'BatiyaoFan', 'the admin', 'R3tard!', 'f.a.g.g.o.t', 'ana<b>']) {
    assert.ok(social.checkNickname(bad).problem, bad);
  }
  const names = social.suggestNicknames(6);
  assert.strictEqual(new Set(names).size, 6);
  for (const n of names) {
    assert.match(n, /^[A-Z][a-z]+ [A-Z][a-z]+ [1-9][0-9]$/);
    assert.deepStrictEqual(social.checkNickname(n), { nickname: n });
  }
});

test('match codes use only the unambiguous alphabet', () => {
  assert.strictEqual(social.CODE_ALPHABET, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
  for (let i = 0; i < 300; i++) {
    const c = social.matchCode();
    assert.match(c, social.CODE_RE);
    assert.ok(!/[ILO01]/.test(c), c);
  }
});

test('the simulator keeps nicknames, a shared leaderboard and matches like Batiyao', () => {
  const sim = simulator.createSimState();
  clearInterval(sim.sweeper);
  const op = (q) => simulator.simOp(sim, q);
  // A child can only take a suggestion.
  assert.strictEqual(op({ op: 'nickname.set', player: 'kid', minor: true, nickname: 'Ana' }).error.code, 'NICKNAME_OFFER');
  const offer = op({ op: 'nickname.suggestions', player: 'kid', minor: true }).result;
  assert.strictEqual(offer.can_type, false);
  assert.strictEqual(op({ op: 'nickname.set', player: 'other', nickname: offer.suggestions[0].nickname, offer: offer.suggestions[0].offer }).error.code, 'NICKNAME_OFFER');
  assert.strictEqual(op({ op: 'nickname.set', player: 'kid', minor: true, nickname: offer.suggestions[0].nickname, offer: offer.suggestions[0].offer }).result.kind, 'suggested');
  assert.strictEqual(op({ op: 'nickname.set', player: 'ana', nickname: 'admin ana' }).error.code, 'NICKNAME_INVALID');
  assert.strictEqual(op({ op: 'nickname.set', player: 'ana', nickname: 'Ana' }).result.nickname, 'Ana');
  // A leaderboard: one record per player per key, best first, with nicknames.
  op({ op: 'db.set', player: 'ana', key: 'best', value: '{"s":10}', replaceable: true, rank: 10 });
  op({ op: 'db.set', player: 'kid', key: 'best', value: '{"s":30}', replaceable: true, rank: 30 });
  op({ op: 'db.set', player: 'ana', key: 'best', value: '{"s":20}', replaceable: true, rank: 20 });
  const top = op({ op: 'db.list', player: 'ana', key: 'best' }).result;
  assert.deepStrictEqual(top.records.map((x) => [x.player.id, x.rank]), [['kid', 30], ['ana', 20]]);
  assert.strictEqual(top.records[1].player.nickname, 'Ana');
  assert.strictEqual(op({ op: 'db.get', player: 'kid', key: 'best', of: 'ana' }).result.record.value, '{"s":20}');
  assert.strictEqual(op({ op: 'db.usage', player: 'ana' }).result.bytes, 2 * ('best'.length + 8));
  assert.strictEqual(op({ op: 'db.set', player: 'ana', key: 'x', value: 'é'.repeat(513) }).error.code, 'VALUE_TOO_LONG');
  // A match between two tabs.
  const out = { a: [], b: [] };
  const conn = (id, player, space = 'adult') => {
    const c = { id, player, space, match: null, seatId: null, tokens: 40, at: Date.now(), windowStart: Date.now(), windowCount: 0,
      res: { write: (s) => { if (s.startsWith('data: ')) out[id].push(JSON.parse(s.slice(6))); } } };
    sim.conns.set(id, c);
    return c;
  };
  conn('a', 'ana'); conn('b', 'kid', 'minor-13-15');
  const hosted = op({ op: 'mp.host', player: 'ana', conn: 'a', max_players: 2, public: true }).result.match;
  assert.match(hosted.code, social.CODE_RE);
  // The child tab plays only with children: an adult's match doesn't exist for it.
  assert.strictEqual(op({ op: 'mp.join', player: 'kid', conn: 'b', code: hosted.code }).error.code, 'NO_SUCH_MATCH');
  assert.deepStrictEqual(op({ op: 'mp.list', player: 'kid', conn: 'b' }).result.matches, []);
  sim.conns.get('b').space = 'adult';
  const joined = op({ op: 'mp.join', player: 'kid', conn: 'b', code: hosted.code.toLowerCase() }).result.match;
  assert.deepStrictEqual(joined.players.map((p) => p.id), ['ana', 'kid']);
  assert.strictEqual(out.a[0].type, 'joined');
  conn('c', 'zed');
  assert.strictEqual(op({ op: 'mp.join', player: 'zed', conn: 'c', code: hosted.code }).error.code, 'MATCH_FULL');
  // A child whose guardian approved adults (approved=1) may join an adult's
  // match by code; it becomes private and leaves the list. Another child may not.
  conn('d', 'uma'); conn('e', 'kay', 'minor-13-15'); conn('f', 'kim', 'minor-13-15'); conn('g', 'ola');
  sim.conns.get('e').approved = true;
  const family = op({ op: 'mp.host', player: 'uma', conn: 'd', max_players: 4, public: true }).result.match;
  assert.strictEqual(op({ op: 'mp.list', player: 'ola', conn: 'g' }).result.matches.filter((m) => m.id === family.id).length, 1);
  const kj = op({ op: 'mp.join', player: 'kay', conn: 'e', code: family.code }).result.match;
  assert.strictEqual(kj.public, false);
  assert.strictEqual(op({ op: 'mp.list', player: 'ola', conn: 'g' }).result.matches.filter((m) => m.id === family.id).length, 0);
  assert.strictEqual(op({ op: 'mp.join', player: 'ola', conn: 'g', match: family.id }).error.code, 'NO_SUCH_MATCH');
  assert.strictEqual(op({ op: 'mp.join', player: 'kim', conn: 'f', code: family.code }).error.code, 'NO_SUCH_MATCH');
  op({ op: 'mp.leave', player: 'kay', conn: 'e' }); op({ op: 'mp.leave', player: 'uma', conn: 'd' });
  op({ op: 'mp.send', player: 'kid', conn: 'b', data: { move: 'e4' } });
  assert.deepStrictEqual(out.a.at(-1), { type: 'message', data: { from: { id: 'kid', nickname: offer.suggestions[0].nickname }, data: { move: 'e4' } } });
  assert.strictEqual(op({ op: 'mp.send', player: 'kid', conn: 'b', data: 'x'.repeat(1100) }).error.code, 'MESSAGE_TOO_LARGE');
  // The host leaves: the other player is told, and becomes the host.
  op({ op: 'mp.leave', player: 'ana', conn: 'a' });
  assert.deepStrictEqual(out.b.slice(-2).map((e) => e.type), ['left', 'host']);
  assert.strictEqual(out.b.at(-1).data.player.id, 'kid');
  // One player and no messages for 10 minutes: closed.
  simulator.sweepMatches(sim, Date.now() + 11 * 60 * 1000);
  assert.deepStrictEqual(out.b.at(-1), { type: 'closed', data: { reason: 'idle' } });
  assert.strictEqual(sim.matches.size, 0);
});

test('ai checks its options before asking Batiyao', async () => {
  const { Batiyao, sent } = sdkWith(() => ({ result: { status: 'unavailable' } }));
  for (const bad of [{}, { prompt: '' }, { prompt: 'x'.repeat(401) }, { prompt: 'cat', quality: 'ultra' }, { prompt: 'cat', seed: -1 }, { prompt: 'cat', avoid: 'x'.repeat(201) }]) {
    assert.strictEqual(await code(Batiyao.ai.image.generate(bad)), 'INVALID', JSON.stringify(bad));
  }
  for (const bad of [{ prompt: 'rain', kind: 'speech' }, { prompt: 'rain', kind: 'sound', seconds: 15 }, { prompt: 'rain', seconds: 7 }]) {
    assert.strictEqual(await code(Batiyao.ai.audio.generate(bad)), 'INVALID', JSON.stringify(bad));
  }
  for (const bad of [{ prompt: '' }, { prompt: 'q', format: 'xml' }, { prompt: 'q', max_chars: 10 }, { prompt: 'q', context: 'x'.repeat(8001) }]) {
    assert.strictEqual(await code(Batiyao.ai.ask(bad)), 'INVALID', JSON.stringify(bad));
  }
  assert.strictEqual(sent.length, 0);
  assert.strictEqual((await Batiyao.ai.image.generate({ prompt: 'a red kite', quality: 'best', seed: 7 })).status, 'unavailable');
  await Batiyao.ai.audio.generate({ prompt: 'rain on a roof', kind: 'sound', seconds: 6 });
  await Batiyao.ai.ask({ prompt: 'Three facts about kites', web_search: true, format: 'json' });
  assert.strictEqual(JSON.stringify(sent.map((m) => [m.method, m.params])), JSON.stringify([
    ['ai.image.generate', { prompt: 'a red kite', quality: 'best', seed: 7 }],
    ['ai.audio.generate', { prompt: 'rain on a roof', kind: 'sound', seconds: 6 }],
    ['ai.ask', { prompt: 'Three facts about kites', web_search: true, format: 'json' }],
  ]));
});

test('ai progress reaches only its own request', async () => {
  let ping = null;
  const seen = [];
  const s = sdkWith((m) => {
    if (m === 'ai.image.generate') return { result: { status: 'made' } };
    return { result: {} };
  });
  // Send progress for the request before it is answered.
  const p = s.Batiyao.ai.image.generate({ prompt: 'kite', onProgress: (x) => seen.push(x.done) });
  ping = s.sent[0].id;
  s.emit('ai.progress', { request: ping, stage: 'making', done: 2, total: 5 });
  s.emit('ai.progress', { request: 'someone-else', stage: 'making', done: 9, total: 9 });
  await p;
  assert.deepStrictEqual(seen, [2]);
});

test('capability() says ready, needs_download or unavailable, never why', async () => {
  const ctx = { features: ['pay', 'ai.image', 'ai.assistant'], capabilities: {
    'ai.image': { version: 1, state: 'needs_download', tools: [] },
    'ai.assistant': { version: 1, state: 'ready', tools: ['web_search'] },
    'ai.audio': { version: 1, state: 'unavailable', tools: [] },
  } };
  const { Batiyao } = sdkWith(() => ({ result: ctx }));
  assert.strictEqual(JSON.stringify(await Batiyao.capability('ai.image')), '{"supported":true,"version":1,"state":"needs_download","tools":[]}');
  assert.strictEqual((await Batiyao.capability('ai.assistant')).tools[0], 'web_search');
  assert.strictEqual((await Batiyao.capability('ai.audio')).state, 'unavailable');
  assert.strictEqual((await Batiyao.capability('teleport')).supported, false);
  assert.strictEqual(await Batiyao.supports('ai.ask'), true);
  assert.strictEqual(await Batiyao.supports('ai.audio.generate'), false);
  const older = sdkWith(() => ({ result: { platform: 'android', features: ['pay'] } })).Batiyao;
  assert.strictEqual((await older.capability('ai.image')).state, 'unavailable');
});

test('requires and capabilities follow the server rules', () => {
  const files = readFolder(WINGBEAT);
  const base = JSON.parse(files.find((f) => f.path === 'manifest.json').data);
  const check = (extra) => checkBundle(withFile(files, 'manifest.json', JSON.stringify({ ...base, ...extra }))).problems;
  assert.deepStrictEqual(check({ requires: ['ai.image'], capabilities: { 'ai.image': { version: 1, purpose: 'Draws a card for each level.' } } }), []);
  const one = (extra, want) => assert.ok(check(extra).some((p) => p.includes(want)), `${JSON.stringify(extra)}: ${check(extra).join('; ')}`);
  one({ capabilities: { 'ai.video': { version: 1, purpose: 'Something long enough.' } } }, "isn't a capability");
  one({ capabilities: { 'ai.image': { version: 2, purpose: 'Something long enough.' } } }, '"version"');
  one({ capabilities: { 'ai.image': { version: 1, purpose: 'short' } } }, 'purpose');
  one({ capabilities: { 'ai.image': { version: 1, purpose: 'Something long enough.', tools: ['web_search'] } } }, 'takes no');
  one({ capabilities: { 'ai.assistant': { version: 1, purpose: 'Something long enough.', tools: ['read_page'] } } }, 'may only list');
  one({ capabilities: { 'ai.image': { version: 1, purpose: 'Something long enough.', price: 1 } } }, 'unknown field');
  one({ requires: ['ai.audio'] }, 'must declare it too');
  one({ requires: ['teleport'] }, "isn't a Batiyao feature");
});

// --- 1.5.0: your own addresses ("network"), links and invites ---
const rules = require('../lib/miniapp-rules');

test('network addresses: the same origins the server accepts and refuses', () => {
  const ok = {
    'https://api.example.com': 'https://api.example.com',
    'https://API.Example.com/': 'https://api.example.com',
    'https://api.example.com:443': 'https://api.example.com',
    'https://api.example.com:8443/': 'https://api.example.com:8443',
    'https://xn--80ak6aa92e.com': 'https://xn--80ak6aa92e.com',
    'https://scores.my-game.co.uk': 'https://scores.my-game.co.uk',
    'https://*.Example.com/': 'https://*.example.com',
    'https://*.my-game.co.uk:8443': 'https://*.my-game.co.uk:8443',
  };
  for (const [raw, want] of Object.entries(ok)) assert.strictEqual(rules.normalizeOrigin(raw), want, raw);
  const bad = ['', ' https://a.com', 'http://api.example.com', 'wss://api.example.com', 'api.example.com',
    'https://api.example.com/v1', 'https://api.example.com/?x=1', 'https://api.example.com/#a', 'https://api.example.com?',
    'https://user:pw@api.example.com', 'https://api.*.example.com', 'https://*.*.example.com', 'https://*.com',
    'https://*.co.uk', 'https://*.github.io', 'https://*.vercel.app', 'https://*.batiyao.com', 'https://127.0.0.1', 'https://[::1]',
    'https://localhost', 'https://printer.local', 'https://batiyao.com', 'https://api.batiyao.com',
    'https://miniapps.batiyao.com', 'https://exämple.com', 'https://com', 'https://api.example.com:0',
    'https://api.example.com:99999', 'https://a.example.com:08443', 'https://a.example', 'javascript:alert(1)'];
  for (const raw of bad) assert.throws(() => rules.normalizeOrigin(raw), undefined, raw);
});

test('a wildcard is the domain and all its subdomains, and only that', () => {
  const w = 'https://*.example.com';
  assert.ok(rules.isWildcard(w));
  assert.strictEqual(rules.networkLabel(w), 'example.com and all its subdomains');
  assert.strictEqual(rules.sourceList([w]).join(' '), 'https://example.com https://*.example.com wss://example.com wss://*.example.com');
  assert.strictEqual(rules.connectionAllowlist([w]),
    '(response-origin "https://example.com/*" "https://*.example.com/*" "wss://example.com/*" "wss://*.example.com/*")');
  for (const [u, ok] of Object.entries({ 'https://example.com/a': true, 'https://a.b.example.com/': true, 'wss://live.example.com/x': true,
    'https://notexample.com/': false, 'https://example.com.evil.org/': false, 'https://api.example.com:8443/': false })) {
    assert.strictEqual(rules.originAllows(w, u), ok, u);
  }
  assert.strictEqual(rules.originAllows('https://api.example.com', 'https://x.api.example.com/'), false);
});

test('network in the manifest: at most two, each with a purpose, no repeats', () => {
  const files = readFolder(WINGBEAT);
  const m = JSON.parse(files.find((f) => f.path === 'manifest.json').data);
  const check = (net, requires) => checkBundle(withFile(files, 'manifest.json', JSON.stringify({ ...m, network: net, requires })));
  assert.deepStrictEqual(check([{ url: 'https://api.example.com/', purpose: 'Saves your high scores.' }], ['network']).problems, []);
  const has = (r, s) => r.problems.some((p) => p.includes(s));
  assert.ok(has(check([{ url: 'https://a.example.com', purpose: 'One address here.' }, { url: 'https://A.example.com/', purpose: 'The same one again.' }]), 'listed twice'));
  assert.ok(has(check(['a', 'b', 'c'].map((h) => ({ url: `https://${h}.example.com`, purpose: 'An address of ours.' }))), 'at most 2'));
  assert.ok(has(check([{ url: 'https://a.example.com', purpose: 'short' }]), 'purpose'));
  assert.ok(has(check([{ url: 'https://a.example.com', purpose: 'Long enough here.', why: 1 }]), 'unknown field "why"'));
  assert.ok(has(check(undefined, ['network']), '"requires" has "network"'));
  assert.deepStrictEqual(check(undefined, ['invite', 'multiplayer']).problems, []);
});

test('only media may come from a declared address, and sockets stop being flagged', () => {
  const files = readFolder(WINGBEAT);
  const m = JSON.parse(files.find((f) => f.path === 'manifest.json').data);
  const withNet = withFile(files, 'manifest.json', JSON.stringify({ ...m, network: [{ url: 'https://api.example.com', purpose: 'Saves your high scores.' }] }));
  const page = (html, set = withNet) => checkBundle(withFile(set, 'index.html', '<!doctype html>' + html)).problems.filter((p) => p.startsWith('index.html'));
  assert.deepStrictEqual(page('<img src="https://api.example.com/a.png"><video poster=\'https://api.example.com/p.jpg\' src=https://api.example.com/v.mp4></video>' +
    '<img srcset="https://api.example.com/a.png 1x, https://api.example.com/b.png 2x">'), []);
  for (const html of ['<img src="https://evil.example.org/a.png">', '<img src="https://api.example.com.evil.org/a.png">',
    '<img srcset="https://api.example.com/a.png 1x, https://evil.org/b.png 2x">', '<script src="https://api.example.com/lib.js"></script>',
    '<link rel="stylesheet" href="https://api.example.com/s.css">', '<a href="https://api.example.com/">x</a>',
    '<form action="https://api.example.com/post"></form>']) {
    assert.strictEqual(page(html).length, 1, html);
  }
  assert.strictEqual(page('<img src="https://api.example.com/a.png">', files).length, 1, 'undeclared');
  assert.ok(checkBundle(withFile(withNet, 'style.css', 'a{background:url(https://api.example.com/a.png)}')).problems.some((p) => p.startsWith('style.css')));
  const js = 'new WebSocket("wss://api.example.com"); new RTCPeerConnection()';
  assert.deepStrictEqual(checkBundle(withFile(withNet, 'net.js', js)).flags, ['Uses WebRTC (RTCPeerConnection)']);
  assert.strictEqual(checkBundle(withFile(files, 'net.js', js)).flags.length, 2);
});

test('the sandbox names declared addresses for data and media only', () => {
  const base = 'http://localhost:3100/app/';
  const none = simulator.fileHeaders(base);
  assert.strictEqual(none['Connection-Allowlist'], '(response-origin)');
  assert.match(none['Content-Security-Policy'], /connect-src http:\/\/localhost:3100\/app\/ data: blob:;/);
  const h = simulator.fileHeaders(base, ['https://api.example.com']);
  const csp = h['Content-Security-Policy'];
  for (const d of ['connect-src', 'img-src', 'media-src']) assert.ok(csp.includes(`${d} ${base} data: blob: https://api.example.com wss://api.example.com;`), d);
  for (const part of csp.split(';')) {
    if (/^\s*(script-src|style-src|font-src|worker-src|frame-src)\b/.test(part)) assert.ok(!part.includes('example.com'), part);
  }
  assert.strictEqual(h['Connection-Allowlist'], '(response-origin "https://api.example.com/*" "wss://api.example.com/*")');
  assert.strictEqual(rules.connectionAllowlist(['https://a.example.com:8443']), '(response-origin "https://a.example.com:8443/*" "wss://a.example.com:8443/*")');
});

test('invite() asks Batiyao, and the link and supports() know it', async () => {
  const { Batiyao, sent, emit } = sdkWith((m) => ({ result: m === 'getContext' ? { features: ['multiplayer', 'invite'], link: { join: 'ABC234' } } : {} }));
  assert.strictEqual(asJSON(await Batiyao.multiplayer.invite()), '{}');
  assert.strictEqual(asJSON(sent.map((m) => [m.method, m.params])), asJSON([['mp.invite', {}]]));
  assert.strictEqual((await Batiyao.getContext()).link.join, 'ABC234');
  assert.strictEqual(await Batiyao.supports('invite'), true);
  assert.strictEqual(await Batiyao.supports('multiplayer.invite'), true);
  let got = null;
  Batiyao.on('link', (d) => { got = d; });
  emit('link', { join: 'XYZ789' });
  assert.strictEqual(asJSON(got), '{"join":"XYZ789"}');

  const older = sdkWith((m) => (m === 'getContext' ? { result: { features: ['multiplayer'] } } : { error: { code: 'UNKNOWN_METHOD', message: 'no' } })).Batiyao;
  assert.strictEqual(await older.supports('multiplayer.invite'), false);
  assert.strictEqual(await code(older.multiplayer.invite()), 'UNKNOWN_METHOD');
});

test('the simulator starts from a link, invites, and lets declared addresses through', async () => {
  const dir = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'mini-'));
  for (const f of readFolder(WINGBEAT)) {
    require('node:fs').mkdirSync(path.join(dir, path.dirname(f.path)), { recursive: true });
    let data = f.data;
    if (f.path === 'manifest.json') data = Buffer.from(JSON.stringify({ ...JSON.parse(f.data), network: [{ url: 'https://api.example.com', purpose: 'Saves your high scores.' }] }));
    require('node:fs').writeFileSync(path.join(dir, f.path), data);
  }
  const server = simulator.main([dir, '--port', '31097']);
  await new Promise((r) => server.once('listening', r));
  try {
    const html = await (await fetch('http://127.0.0.1:31097/?join=abc234')).text();
    new (require('node:vm').Script)(html.split('<script>')[1].split('</script>')[0]);
    assert.match(html, /id="invite-sheet"/);
    assert.match(html, /'mp\.invite':/);
    assert.match(html, /if \(LINK\) ctx\.link = LINK;/);
    assert.match(html, /const SLUG = "wingbeat";/);
    const page = await fetch('http://127.0.0.1:31097/app/index.html');
    assert.ok(page.headers.get('content-security-policy').includes('connect-src http://localhost:31097/app/ data: blob: https://api.example.com wss://api.example.com'));
    assert.strictEqual(page.headers.get('connection-allowlist'), '(response-origin "https://api.example.com/*" "wss://api.example.com/*")');
    // An address added while the simulator runs counts on the next load
    // (it used to stay blocked until a restart).
    const mf = path.join(dir, 'manifest.json');
    const m = JSON.parse(require('node:fs').readFileSync(mf, 'utf8'));
    m.network.push({ url: 'https://*.cdn.example.com', purpose: 'Loads the pictures for each level.' });
    require('node:fs').writeFileSync(mf, JSON.stringify(m));
    const again = await fetch('http://127.0.0.1:31097/app/index.html');
    assert.ok(again.headers.get('content-security-policy').includes('https://api.example.com wss://api.example.com https://cdn.example.com https://*.cdn.example.com'));
    assert.match(again.headers.get('connection-allowlist'), /"https:\/\/\*\.cdn\.example\.com\/\*"/);
    // The simulated admin can decline an address; it is blocked on the next load.
    const op = (body) => fetch('http://127.0.0.1:31097/sim/api', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
    const listed = await op({ op: 'admin.get' });
    assert.deepStrictEqual(listed.result.network.map((x) => x.approved), [true, true]);
    await op({ op: 'admin.set', kind: 'network', name: 'https://api.example.com', approved: false });
    const declined = await fetch('http://127.0.0.1:31097/app/index.html');
    assert.ok(!declined.headers.get('content-security-policy').includes('https://api.example.com'));
    assert.ok(declined.headers.get('content-security-policy').includes('https://*.cdn.example.com'));
    await op({ op: 'admin.set', kind: 'network', name: 'https://api.example.com', approved: true });
    const back = await fetch('http://127.0.0.1:31097/app/index.html');
    assert.ok(back.headers.get('content-security-policy').includes('https://api.example.com'));
    const page2 = await (await fetch('http://127.0.0.1:31097/')).text();
    assert.match(page2, /Admin review \(simulated\)/);
  } finally {
    server.close();
  }
});

// --- 1.6.0: files on the device, and sharing a video or a sound ---

test('files: names and Blobs are checked before asking Batiyao, and the answers pass through', async () => {
  const { Batiyao, sent } = sdkWith((m, p) => {
    if (m === 'getContext') return { result: { features: ['files', 'shareMedia'] } };
    if (m === 'files.save') return { result: { saved: true, name: p.name, type: 'image/png', kind: 'image', size: p.file.size, saved_at: 'now' } };
    if (m === 'files.get') return { result: p.name === 'none.png' ? { file: null } : { file: new Blob(['x']), name: p.name } };
    if (m === 'files.list') return { result: { files: [{ name: 'a.png' }] } };
    if (m === 'files.remove') return { result: { removed: true } };
    return { result: { bytes: 1, limit: 209715200, count: 1, max_files: 500 } };
  });
  for (const bad of ['', '.hidden', '-x', 'a/b.png', '../x', 'a b', 'x'.repeat(129), 7]) {
    assert.strictEqual(await code(Batiyao.files.save(bad, new Blob(['x']))), 'INVALID_NAME', String(bad));
  }
  assert.strictEqual(await code(Batiyao.files.save('a.png', 'not a blob')), 'INVALID');
  assert.strictEqual(await code(Batiyao.files.save('a.png', new Blob([]))), 'INVALID');
  assert.strictEqual(await code(Batiyao.files.get('../x')), 'INVALID_NAME');
  assert.strictEqual(sent.length, 0);
  const saved = await Batiyao.files.save('level-3.png', new Blob(['\x89PNG']));
  assert.strictEqual(saved.saved, true);
  assert.ok(sent[0].params.file instanceof Blob, 'the Blob itself goes to Batiyao');
  assert.strictEqual((await Batiyao.files.get('none.png')).file, null);
  assert.deepStrictEqual((await Batiyao.files.list()).map((f) => f.name), ['a.png']);
  assert.strictEqual((await Batiyao.files.remove('a.png')).removed, true);
  assert.strictEqual((await Batiyao.files.usage()).max_files, 500);
  assert.strictEqual(await Batiyao.supports('files'), true);
  assert.strictEqual(await Batiyao.supports('files.save'), true);
  assert.strictEqual(await Batiyao.supports('share.video'), true);
});

test('share() takes one video or sound as a Blob, and never sends it to a Batiyao without shareMedia', async () => {
  const { Batiyao, sent } = sdkWith((m) => (m === 'getContext' ? { result: { features: ['share', 'shareMedia'] } } : { result: {} }));
  const v = new Blob(['video']), a = new Blob(['sound']);
  assert.strictEqual(await code(Batiyao.share({ video: 'x' })), 'INVALID');
  assert.strictEqual(await code(Batiyao.share({ video: v, audio: a })), 'INVALID');
  assert.strictEqual(await code(Batiyao.share({ video: v, image: 'data:image/png;base64,AA==' })), 'INVALID');
  assert.strictEqual(await code(Batiyao.share({ video: new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]) })), 'VIDEO_TOO_LARGE');
  assert.strictEqual(await code(Batiyao.share({ audio: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]) })), 'AUDIO_TOO_LARGE');
  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(await Batiyao.share({ video: v, text: 'Look' }), {});
  const shareMsg = sent.find((x) => x.method === 'share');
  assert.ok(shareMsg.params.video instanceof Blob);
  assert.deepStrictEqual(await Batiyao.share({ audio: a, image: 'data:image/png;base64,AA==' }), {});

  const older = sdkWith((m) => (m === 'getContext' ? { result: { features: ['share'] } } : { result: {} }));
  assert.strictEqual(await code(older.Batiyao.share({ video: v })), 'UNKNOWN_METHOD');
  assert.ok(!older.sent.some((x) => x.method === 'share'), 'a video is never handed to a Batiyao that would drop it');
  assert.deepStrictEqual(await older.Batiyao.share({ text: 'words still work' }), {});
});

test('the simulator keeps files by their bytes and shares videos and sounds', async () => {
  const server = simulator.main([WINGBEAT, '--port', '31096']);
  await new Promise((r) => server.once('listening', r));
  try {
    const html = await (await fetch('http://127.0.0.1:31096/')).text();
    const js = html.split('<script>')[1].split('</script>')[0];
    new (require('node:vm').Script)(js);
    for (const s of ["'files.save'", "'files.get'", "'files.list'", "'files.remove'", "'files.usage'", "'files', 'shareMedia'", 'VIDEO_TOO_LONG', 'AUDIO_TOO_LARGE', 'id="sh-video"', 'id="sh-audio"']) {
      assert.ok(html.includes(s), s);
    }
    // Run the page's own sniffing on real file heads.
    const fnSrc = js.slice(js.indexOf('function sniffType'), js.indexOf('const SPACE ='));
    const sniffType = new Function(fnSrc + '; return sniffType;')();
    const head = (...parts) => { const out = []; for (const p of parts) out.push(...(typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)); while (out.length < 16) out.push(0); return new Uint8Array(out); };
    assert.strictEqual(sniffType(head([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])).type, 'image/png');
    assert.strictEqual(sniffType(head([0xff, 0xd8, 0xff])).type, 'image/jpeg');
    assert.strictEqual(sniffType(head('RIFF', [0, 0, 0, 0], 'WAVE')).type, 'audio/wav');
    assert.strictEqual(sniffType(head('ID3')).type, 'audio/mpeg');
    assert.strictEqual(sniffType(head([0, 0, 0, 0x20], 'ftypM4A ')).type, 'audio/mp4');
    assert.strictEqual(sniffType(head([0, 0, 0, 0x20], 'ftypisom')).type, 'video/mp4');
    assert.strictEqual(sniffType(head([0x1a, 0x45, 0xdf, 0xa3])).type, 'video/webm');
    assert.strictEqual(sniffType(head([0x1a, 0x45, 0xdf, 0xa3]), 'audio/webm').type, 'audio/webm');
    assert.strictEqual(sniffType(head('<html>'), 'image/png'), null);
    assert.strictEqual(sniffType(head('%PDF-1.7')), null);
  } finally {
    server.close();
  }
});

test('files and shareMedia may be listed in "requires"', () => {
  const files = readFolder(WINGBEAT);
  const m = JSON.parse(files.find((f) => f.path === 'manifest.json').data);
  const { problems } = checkBundle(withFile(files, 'manifest.json', JSON.stringify({ ...m, requires: ['files', 'shareMedia'] })));
  assert.deepStrictEqual(problems.filter((p) => /requires/.test(p)), []);
});

// --- 1.7.0: share({ invite: true }) ---
test('share({ invite: true }) needs a Batiyao that has it, and asks for nothing but the flag', async () => {
  const newer = sdkWith((m) => (m === 'getContext' ? { result: { features: ['share', 'shareInvite', 'shareMedia'] } } : { result: {} }));
  assert.strictEqual(await code(newer.Batiyao.share({ invite: true })), 'resolved');
  const shared = newer.sent.find((x) => x.method === 'share');
  assert.strictEqual(JSON.stringify(shared.params), JSON.stringify({ image: '', text: '', invite: true }));
  assert.strictEqual(await code(newer.Batiyao.share({ invite: 'yes' })), 'INVALID');
  const older = sdkWith((m) => (m === 'getContext' ? { result: { features: ['share'] } } : { result: {} }));
  assert.strictEqual(await code(older.Batiyao.share({ invite: true, text: 'Race me' })), 'UNKNOWN_METHOD');
  assert.ok(!older.sent.some((x) => x.method === 'share'), 'an older Batiyao is never asked to share without the link');
});

test('the simulator shares an invite only from a match', async () => {
  const server = simulator.main([WINGBEAT, '--port', '31096']);
  await new Promise((r) => server.once('listening', r));
  try {
    const html = await (await fetch('http://127.0.0.1:31096/')).text();
    assert.match(html, /share\(\{ invite: true \}\) works while the person is in a match/);
    assert.match(html, /'shareInvite'/);
  } finally {
    server.close();
  }
});

// --- 1.9.0: audio on Batiyao's own player ---

test('media.background is a capability; "audio" is a feature; neither needs an address', () => {
  const files = readFolder(WINGBEAT);
  const m = JSON.parse(files.find((f) => f.path === 'manifest.json').data);
  const check = (extra) => checkBundle(withFile(files, 'manifest.json', JSON.stringify({ ...m, ...extra }))).problems;
  const purpose = { purpose: 'Plays the lesson you picked while your screen is off.' };
  assert.deepStrictEqual(check({ capabilities: { 'media.background': purpose } }), []);
  assert.deepStrictEqual(check({ requires: ['audio'] }), []);
  assert.deepStrictEqual(check({ requires: ['audio', 'media.background'], capabilities: { 'media.background': purpose } }), []);
  assert.ok(check({ capabilities: { 'media.background': { version: 2, ...purpose } } }).some((p) => p.includes('"version" must be')));
  assert.ok(check({ capabilities: { 'media.background': { ...purpose, tools: ['web_search'] } } }).some((p) => p.includes('takes no "tools"')));
  // requires it, but never declared it: an admin has nothing to grant.
  assert.ok(check({ requires: ['media.background'] }).some((p) => p.includes('must declare it too')));
});

test('SDK audio checks a track before asking, and needs the feature', async () => {
  const state = { state: 'playing', track: 0, tracks: 1, title: 'Lesson one', artist: null, position_ms: 0, duration_ms: 3000, background: true };
  const withAudio = sdkWith((m) => (m === 'getContext' ? { result: { features: ['audio', 'backgroundAudio'] } } : { result: state }));
  const B = withAudio.Batiyao;
  for (const [options, want] of [
    [{}, 'INVALID'],
    [{ src: 'http://radio.example.com/a.mp3' }, 'INVALID'],
    [{ src: { file: '../secret.mp3' } }, 'INVALID_NAME'],
    [{ tracks: [] }, 'INVALID'],
    [{ tracks: new Array(101).fill({ src: 'https://radio.example.com/a.mp3' }) }, 'INVALID'],
    [{ src: 'https://radio.example.com/a.mp3', index: 3 }, 'INVALID'],
    [{ src: 'https://radio.example.com/a.mp3', title: 'x'.repeat(200) }, 'INVALID'],
    [{ src: new Blob([]) }, 'INVALID'],
  ]) {
    assert.strictEqual(await code(B.audio.play(options)), want, JSON.stringify(Object.keys(options)));
  }
  assert.strictEqual(withAudio.sent.filter((x) => x.method === 'audio.play').length, 0);
  assert.strictEqual((await B.audio.play({ src: { file: 'lesson1.mp3' }, title: 'Lesson one', background: true })).title, 'Lesson one');
  const sent = withAudio.sent.find((x) => x.method === 'audio.play');
  assert.strictEqual(JSON.stringify(sent.params), JSON.stringify({ tracks: [{ src: { file: 'lesson1.mp3' }, title: 'Lesson one' }], background: true }));
  // An https track travels as { url }, so the host has one shape to read.
  await B.audio.play({ tracks: [{ src: 'https://radio.example.com/a.mp3' }, { src: { url: 'https://radio.example.com/b.mp3' }, artist: 'Teacher' }], index: 1 });
  const two = withAudio.sent.filter((x) => x.method === 'audio.play')[1];
  assert.strictEqual(JSON.stringify(two.params.tracks[0].src), JSON.stringify({ url: 'https://radio.example.com/a.mp3' }));
  assert.strictEqual(two.params.index, 1);
  assert.strictEqual(await code(B.audio.seek(-1)), 'INVALID');
  assert.strictEqual(await code(B.audio.seek(1.5)), 'INVALID');
  for (const call of ['pause', 'resume', 'stop', 'next', 'previous', 'state']) assert.strictEqual((await B.audio[call]()).state, 'playing');
  assert.strictEqual(await B.supports('audio'), true);
  assert.strictEqual(await B.supports('backgroundAudio'), true);
  // The 'audio.state' event reaches a listener like any other event.
  const heard = [];
  B.on('audio.state', (s) => heard.push(s.state));
  withAudio.emit('audio.state', { ...state, state: 'paused' });
  assert.deepStrictEqual(heard, ['paused']);
  // A Batiyao without the player: nothing is sent to it.
  const older = sdkWith((m) => (m === 'getContext' ? { result: { features: ['files'] } } : { result: {} }));
  assert.strictEqual(await code(older.Batiyao.audio.play({ src: { file: 'lesson1.mp3' } })), 'UNKNOWN_METHOD');
  assert.strictEqual(await code(older.Batiyao.audio.stop()), 'UNKNOWN_METHOD');
  assert.ok(!older.sent.some((x) => x.method.startsWith('audio.')));
});

// --- 1.8.0: net.fetch ---
const netlib = require('../lib/miniapp-net');

test('net.fetch is a capability; its version is optional; it needs an address', () => {
  const files = readFolder(WINGBEAT);
  const m = JSON.parse(files.find((f) => f.path === 'manifest.json').data);
  const net = [{ url: 'https://radio.example.com', purpose: 'The station list and its streams.' }];
  const check = (extra) => checkBundle(withFile(files, 'manifest.json', JSON.stringify({ ...m, ...extra }))).problems;
  assert.deepStrictEqual(check({ network: net, capabilities: { 'net.fetch': { purpose: 'Reads the station list, which sends no CORS.' } } }), []);
  assert.ok(check({ capabilities: { 'net.fetch': { purpose: 'Reads the station list, which sends no CORS.' } } }).some((p) => p.includes('declare at least one')));
  assert.ok(check({ network: net, capabilities: { 'net.fetch': { version: 2, purpose: 'Reads the station list, which sends no CORS.' } } }).some((p) => p.includes('"version" must be')));
  assert.deepStrictEqual(check({ network: net, requires: ['net.fetch'], capabilities: { 'net.fetch': { purpose: 'Reads the station list, which sends no CORS.' } } }), []);
});

test('SDK net.fetch checks before asking, needs the feature, and routes progress and cancel', async () => {
  const withNet = sdkWith((m) => (m === 'getContext' ? { result: { features: ['net'] } } : m === 'net.fetch' ? { result: { status: 200, status_text: 'OK', url: 'u', headers: {}, text: 'hi' } } : { result: {} }));
  const B = withNet.Batiyao;
  for (const [args, want] of [
    [['http://radio.example.com/x'], 'INVALID'],
    [['https://radio.example.com/x', { headers: { Cookie: 'a=b' } }], 'NET_HEADER_FORBIDDEN'],
    [['https://radio.example.com/x', { headers: { 'Sec-Fetch-Mode': 'cors' } }], 'NET_HEADER_FORBIDDEN'],
    [['https://radio.example.com/x', { body: 'x' }], 'INVALID'],
    [['https://radio.example.com/x', { method: 'TRACE' }], 'INVALID'],
    [['https://radio.example.com/x', { response: 'stream' }], 'INVALID'],
    [['https://radio.example.com/x', { response: 'file' }], 'INVALID_NAME'],
    [['https://radio.example.com/x', { timeout_ms: 10 }], 'INVALID'],
    [['https://radio.example.com/x', { headers: { 'X-A': 'a\nb' } }], 'INVALID'],
  ]) {
    assert.strictEqual(await code(B.net.fetch(...args)), want, JSON.stringify(args));
  }
  const p = B.net.fetch('https://radio.example.com/list', { method: 'post', body: 'q=1', headers: { 'X-Api-Key': 'k' }, response: 'text' });
  assert.match(p.requestId, /^[A-Za-z0-9_.:-]{1,64}$/);
  const r = await p;
  assert.strictEqual(r.text, 'hi');
  const sent = withNet.sent.find((x) => x.method === 'net.fetch');
  assert.strictEqual(JSON.stringify(sent.params), JSON.stringify({ url: 'https://radio.example.com/list', method: 'POST', headers: { 'X-Api-Key': 'k' }, body: 'q=1', response: 'text', request_id: p.requestId }));
  assert.strictEqual(await B.supports('net.fetch'), true);
  await B.net.cancel(p.requestId);
  assert.ok(withNet.sent.some((x) => x.method === 'net.cancel' && x.params.request_id === p.requestId));
  // Progress goes to the callback of its own request.
  const seen = [];
  const slow = sdkWith((m) => (m === 'getContext' ? { result: { features: ['net'] } } : { result: { status: 200, headers: {}, text: '' } }));
  const q = slow.Batiyao.net.fetch('https://radio.example.com/big', { onProgress: (x) => seen.push(x) });
  await new Promise((res) => setImmediate(res));
  slow.emit('net.progress', { request_id: q.requestId, received: 5, total: 10 });
  slow.emit('net.progress', { request_id: 'someone-else', received: 1, total: 1 });
  await q;
  assert.strictEqual(JSON.stringify(seen), JSON.stringify([{ received: 5, total: 10 }]));
  const older = sdkWith((m) => (m === 'getContext' ? { result: { features: ['files'] } } : { result: {} }));
  assert.strictEqual(await code(older.Batiyao.net.fetch('https://radio.example.com/x')), 'UNKNOWN_METHOD');
  assert.ok(!older.sent.some((x) => x.method === 'net.fetch'));
});

test('net.fetch never reaches a private address and refuses what Batiyao refuses', async () => {
  for (const [ip, want] of Object.entries({ '8.8.8.8': true, '2606:4700:4700::1111': true, '127.0.0.1': false, '10.0.0.5': false,
    '192.168.1.1': false, '169.254.169.254': false, '100.64.0.1': false, '::1': false, 'fd00::1': false, 'fe80::1': false,
    '::ffff:127.0.0.1': false, '::ffff:8.8.8.8': true, '64:ff9b::7f00:1': false, '64:ff9b::808:808': true, 'not-an-ip': false })) {
    assert.strictEqual(netlib.isPublicAddress(ip), want, ip);
  }
  assert.ok(netlib.forbiddenHeader('Proxy-Authorization') && netlib.forbiddenHeader('x-forwarded-for') && !netlib.forbiddenHeader('Authorization'));
  const allowed = (u) => u.startsWith('https://radio.example.com/');
  const err = (o) => netlib.fetchOnce({ allowed, ...o }).then(() => 'resolved', (e) => e.code);
  assert.strictEqual(await err({ url: 'https://elsewhere.example.org/' }), 'NET_NOT_ALLOWED');
  assert.strictEqual(await err({ url: 'http://radio.example.com/' }), 'NET_NOT_ALLOWED');
  assert.strictEqual(await err({ url: 'https://radio.example.com/', headers: { Cookie: 'a' } }), 'NET_HEADER_FORBIDDEN');
  assert.strictEqual(await err({ url: 'https://radio.example.com/', body: 'x' }), 'INVALID');
  const toLoopback = (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
  assert.strictEqual(await err({ url: 'https://radio.example.com/', resolve: toLoopback }), 'NET_PRIVATE_ADDRESS');
});

test('net.fetch against a local https server: user agent, cookies, redirects, JSON, limits', async (t) => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netfetch-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=radio.example.com',
      '-addext', 'subjectAltName=DNS:radio.example.com', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  } catch (e) {
    t.skip('openssl not available');
    return;
  }
  const https = require('node:https');
  let seen = {};
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    seen = { ua: req.headers['user-agent'], cookie: req.headers.cookie };
    if (req.url === '/list.json') { res.setHeader('Set-Cookie', 'track=me'); res.setHeader('Content-Type', 'application/json'); return res.end('{"stations":["a"]}'); }
    if (req.url === '/away') { res.writeHead(302, { Location: 'https://elsewhere.example.org/' }); return res.end(); }
    if (req.url === '/near') { res.writeHead(302, { Location: '/list.json' }); return res.end(); }
    if (req.url === '/big') { res.setHeader('Content-Length', String(netlib.MAX_TEXT + 1)); return res.end(); }
    res.end('plain text');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = 'https://radio.example.com:' + port;
  const opts = { allowed: (u) => u.startsWith(base + '/'), slug: 'radio', ca: fs.readFileSync(path.join(dir, 'c.pem')),
    isPublic: () => true, resolve: (host, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) };
  try {
    const j = await netlib.fetchOnce({ ...opts, url: base + '/list.json', response: 'json' });
    assert.strictEqual(j.status, 200);
    assert.strictEqual(j.body.toString(), '{"stations":["a"]}');
    assert.ok(!('set-cookie' in j.headers));
    assert.strictEqual(seen.ua, 'Mozilla/5.0 (compatible; Batiyao-MiniApp/1; +https://batiyao.com/apps/radio)');
    assert.strictEqual(seen.cookie, undefined);
    const near = await netlib.fetchOnce({ ...opts, url: base + '/near', response: 'json' });
    assert.ok(near.url.endsWith('/list.json'));
    const code2 = (o) => netlib.fetchOnce({ ...opts, ...o }).then(() => 'resolved', (e) => e.code);
    assert.strictEqual(await code2({ url: base + '/away' }), 'NET_NOT_ALLOWED');
    assert.strictEqual(await code2({ url: base + '/plain', response: 'json' }), 'NET_NOT_JSON');
    assert.strictEqual(await code2({ url: base + '/big' }), 'NET_TOO_LARGE');
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the simulator lets net.fetch through only when declared and approved', async () => {
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mini-net-'));
  for (const f of readFolder(WINGBEAT)) {
    fs.mkdirSync(path.join(dir, path.dirname(f.path)), { recursive: true });
    let data = f.data;
    if (f.path === 'manifest.json') {
      data = Buffer.from(JSON.stringify({ ...JSON.parse(f.data), network: [{ url: 'https://radio.example.com', purpose: 'The station list and its streams.' }],
        capabilities: { 'net.fetch': { purpose: 'Reads the station list, which sends no CORS.' } } }));
    }
    fs.writeFileSync(path.join(dir, f.path), data);
  }
  const server = simulator.main([dir, '--port', '31095']);
  await new Promise((r) => server.once('listening', r));
  const net = (body) => fetch('http://127.0.0.1:31095/sim/net', { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const op = (body) => fetch('http://127.0.0.1:31095/sim/api', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const html = await (await fetch('http://127.0.0.1:31095/')).text();
    new (require('node:vm').Script)(html.split('<script>')[1].split('</script>')[0]);
    assert.match(html, /'net\.fetch': async/);
    assert.match(html, /is downloading from/);
    const off = await net({ url: 'https://elsewhere.example.org/', response: 'text' });
    assert.strictEqual(off.body.error.code, 'NET_NOT_ALLOWED');
    const listed = await op({ op: 'admin.get' });
    assert.ok(listed.result.caps.some((c) => c.name === 'net.fetch' && c.approved));
    await op({ op: 'admin.set', kind: 'caps', name: 'net.fetch', approved: false });
    const declined = await net({ url: 'https://radio.example.com/', response: 'text' });
    assert.strictEqual(declined.body.error.code, 'UNKNOWN_METHOD');
  } finally {
    server.close();
  }
});

test('YouTube: an approved YouTube address is the whole permission, and video.play takes ids or addresses', async () => {
  const rules = require('../lib/miniapp-rules');
  for (const o of ['https://www.youtube.com', 'https://youtu.be', 'https://*.youtube.com', 'https://www.youtube-nocookie.com']) assert.ok(rules.isYouTubeOrigin(o), o);
  for (const o of ['https://youtube.com:8443', 'https://notyoutube.com', 'https://music.youtube.com', 'https://api.example.com']) assert.ok(!rules.isYouTubeOrigin(o), o);
  const files = readFolder(WINGBEAT);
  const m = JSON.parse(files.find((f) => f.path === 'manifest.json').data);
  const check = (net, requires) => checkBundle(withFile(files, 'manifest.json', JSON.stringify({ ...m, network: net, requires }))).problems;
  assert.deepStrictEqual(check([{ url: 'https://www.youtube.com', purpose: 'Plays the lesson videos.' }], ['youtube']), []);
  assert.ok(check([{ url: 'https://api.example.com', purpose: 'Saves your high scores.' }], ['youtube']).some((p) => p.includes('"requires" has "youtube"')));

  const { Batiyao, sent } = sdkWith((method) => (method === 'getContext' ? { result: { features: ['youtube'] } } : { result: { ended: true, position_ms: 1, duration_ms: 1, watched_ms: 1 } }));
  for (const bad of [undefined, 'short', 'https://vimeo.com/123456', 'https://www.youtube.com/watch?v=tooshort']) assert.strictEqual(await code(Batiyao.video.play({ youtube: bad })), 'INVALID');
  assert.strictEqual(await code(Batiyao.video.play({ youtube: 'dQw4w9WgXcQ', start: 10, end: 5 })), 'INVALID');
  assert.strictEqual(await code(Batiyao.video.play({ youtube: 'dQw4w9WgXcQ', start: 1.5 })), 'INVALID');
  assert.strictEqual(sent.length, 0);
  for (const ok of ['dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=42', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ']) {
    assert.strictEqual(await code(Batiyao.video.play({ youtube: ok })), 'resolved', ok);
  }
  const plays = sent.filter((x) => x.method === 'video.play').map((x) => JSON.stringify(x.params));
  assert.deepStrictEqual(plays, ['{"youtube":"dQw4w9WgXcQ"}', '{"youtube":"dQw4w9WgXcQ","start":42}', '{"youtube":"dQw4w9WgXcQ","start":42}',
    '{"youtube":"dQw4w9WgXcQ"}', '{"youtube":"dQw4w9WgXcQ"}']);
  assert.strictEqual(await Batiyao.supports('video.play'), true);

  const without = sdkWith(() => ({ result: { features: ['pay'] } })).Batiyao;
  assert.strictEqual(await code(without.video.play({ youtube: 'dQw4w9WgXcQ' })), 'UNKNOWN_METHOD');
  assert.strictEqual(await without.supports('youtube'), false);
});
