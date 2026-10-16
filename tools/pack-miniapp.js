#!/usr/bin/env node
// Packs a mini app folder into the zip you upload to Batiyao, after the same
// checks Batiyao runs, so you hear about a problem before you upload.
//
//   node tools/pack-miniapp.js miniapp/wingbeat [--app-id ma_xxxxxxxxxx] [--out dist]
//
// --app-id writes your app's ID (from Mini apps → Built by me → New app on
// batiyao.com) into the packed manifest without editing the folder.
// No dependencies: Node 18+ only.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { checkBundle, origins } = require('../lib/miniapp-rules');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A plain zip: deflated entries, a central directory, nothing exotic. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const deflated = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 30); // extra, comment lengths
    central.writeUInt32LE(0, 34); // disk, internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function readFolder(root) {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
      if (entry.isSymbolicLink()) throw new Error(`${full} is a symlink; mini apps may contain only ordinary files.`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ path: path.relative(root, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
    }
  })(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function main(argv) {
  const args = { dir: null, appId: null, out: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app-id') args.appId = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else args.dir = argv[i];
  }
  if (!args.dir) {
    console.error('Usage: node tools/pack-miniapp.js <folder> [--app-id ma_xxxxxxxxxx] [--out dist]');
    return 2;
  }
  const files = readFolder(args.dir);
  if (args.appId) {
    const m = files.find((f) => f.path === 'manifest.json');
    if (m) {
      const json = JSON.parse(m.data.toString('utf8'));
      json.app_id = args.appId;
      m.data = Buffer.from(JSON.stringify(json, null, 2) + '\n');
    }
  }
  const { problems, flags, manifest } = checkBundle(files);
  for (const f of flags) console.warn(`note: ${f} — an admin will look at this before it goes live.`);
  for (const o of origins(manifest || {})) {
    console.warn(`note: connects to ${o} — an admin approves each address the first time a version uses it; anything else stays blocked.`);
  }
  if (problems.length) {
    console.error(`Not packed. Fix these first:\n  - ${problems.join('\n  - ')}`);
    return 1;
  }
  fs.mkdirSync(args.out, { recursive: true });
  const name = `${path.basename(path.resolve(args.dir))}-${manifest.version}.zip`;
  const target = path.join(args.out, name);
  const bytes = zip(files);
  fs.writeFileSync(target, bytes);
  console.log(`Packed ${files.length} files into ${target} (${(bytes.length / 1024).toFixed(1)} KB).`);
  if (manifest.app_id === 'ma_replaceme2') {
    console.warn('note: app_id is still the placeholder. Pass --app-id with your app\'s ID before uploading.');
  }
  console.log('Upload it on batiyao.com → Mini apps → Built by me.');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { zip, crc32, readFolder, main };
