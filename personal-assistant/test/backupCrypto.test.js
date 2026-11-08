'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../src/backupCrypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-crypto-'));
const f = (n) => path.join(dir, n);
const key = c.generateKey();

function roundTrip(name, bytes) {
  fs.writeFileSync(f(name), bytes);
  c.encryptFile(f(name), f(`${name}.enc`), key);
  assert.ok(c.isEncrypted(f(`${name}.enc`)) && !c.isEncrypted(f(name)));
  c.decryptFile(f(`${name}.enc`), f(`${name}.out`), key);
  assert.ok(fs.readFileSync(f(`${name}.out`)).equals(bytes), `${name} round trip`);
}

roundTrip('empty', Buffer.alloc(0));
roundTrip('small', Buffer.from('PGDMP secret-looking content'));
roundTrip('exact', crypto.randomBytes(c.CHUNK));
roundTrip('multi', crypto.randomBytes(c.CHUNK * 2 + 17));

const plain = Buffer.from('needle-needle-needle');
fs.writeFileSync(f('p'), plain);
c.encryptFile(f('p'), f('p.enc'), key);
assert.ok(!fs.readFileSync(f('p.enc')).includes(plain), 'plaintext is not in the file');
c.encryptFile(f('p'), f('p2.enc'), key);
assert.ok(!fs.readFileSync(f('p.enc')).equals(fs.readFileSync(f('p2.enc'))), 'fresh nonce per file');

const refuses = (name, re) => {
  assert.throws(() => c.decryptFile(f(name), f('bad.out'), key), re, name);
  assert.ok(!fs.existsSync(f('bad.out')) && !fs.existsSync(f('bad.out.partial')), `${name}: no plaintext left behind`);
};

// Wrong key.
assert.throws(() => c.decryptFile(f('p.enc'), f('bad.out'), c.generateKey()), /authentication/);

// Modified byte, truncation, dropped final chunk, reordered chunks, trailing junk.
const multi = fs.readFileSync(f('multi.enc'));
const flipped = Buffer.from(multi);
flipped[flipped.length - 40] ^= 1;
fs.writeFileSync(f('flip'), flipped);
refuses('flip', /authentication/);

fs.writeFileSync(f('trunc'), multi.subarray(0, multi.length - 5));
refuses('trunc', /truncated|authentication/);

const chunkLen = 4 + c.CHUNK + 16;
const hdr = 6 + 12;
fs.writeFileSync(f('dropfinal'), multi.subarray(0, hdr + 2 * chunkLen));
refuses('dropfinal', /authentication/);

const swapped = Buffer.concat([multi.subarray(0, hdr), multi.subarray(hdr + chunkLen, hdr + 2 * chunkLen), multi.subarray(hdr, hdr + chunkLen), multi.subarray(hdr + 2 * chunkLen)]);
fs.writeFileSync(f('swap'), swapped);
refuses('swap', /authentication/);

fs.writeFileSync(f('junk'), Buffer.concat([multi, Buffer.from('xx')]));
refuses('junk', /truncated|corrupt|authentication/);

fs.writeFileSync(f('notenc'), 'plain text, not a backup');
refuses('notenc', /not an encrypted backup/);

// Keys.
assert.strictEqual(c.parseKey(key.toString('base64')).length, 32);
assert.throws(() => c.parseKey('short'), (e) => /32 bytes/.test(e.message) && !e.message.includes('short'));

fs.rmSync(dir, { recursive: true, force: true });
console.log('backupCrypto ok');
