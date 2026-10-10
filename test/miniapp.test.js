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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'miniapp-sdk', 'batiyao-miniapp.js'), 'utf8'), { window: win, setTimeout, clearTimeout, Promise });
  const emit = (event, data) => onMessage({ source: win.parent, data: { batiyao: 1, event, data } });
  return { Batiyao: win.Batiyao, sent, emit };
}
const code = (p) => p.then(() => 'resolved', (e) => e.code);

test('pickImage and pickVideo check their options before asking Batiyao', async () => {
  const { Batiyao, sent } = sdkWith(() => ({ result: { status: 'cancelled' } }));
  assert.strictEqual(Batiyao.version, '1.3.0');
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
