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
