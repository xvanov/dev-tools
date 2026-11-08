'use strict';

// Authenticated encryption for backup files (AES-256-GCM, Node's own crypto).
//
// A backup holds everything the assistant knows, so a copy that leaves the
// machine (a USB stick, a cloud folder, a restored-elsewhere drill) must be
// unreadable without the key. The key is a random 32 bytes held in the OS
// keychain as the PA_BACKUP_KEY secret (labelled by stack, src/secrets), never
// beside the backups.
//
// Format, so a multi-GB dump streams in constant memory and a tampered or
// truncated file is detected before its plaintext is trusted:
//
//   "PABK1\n"                      magic + format version
//   12 bytes                       random base nonce
//   repeated chunks:
//     4 bytes BE                   ciphertext length (<= CHUNK)
//     ciphertext, then 16-byte GCM tag
//
// Each chunk's nonce is the base nonce with its last 4 bytes XORed with the
// chunk counter; its AAD is the 8-byte counter plus a final-chunk flag. The
// counter stops chunks being reordered or dropped from the middle; the flag
// stops a truncated file passing as complete.
//
// Decryption writes to a partial file and renames it on success: plaintext
// that failed authentication is never left looking like a good file.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('./repo/types.ts').Row;
type Db = import('./repo/types.ts').Db;

const crypto = require('crypto');
const fs = require('fs');

const MAGIC = Buffer.from('PABK1\n');
const CHUNK = 1024 * 1024;
const TAG = 16;

function generateKey() {
  return crypto.randomBytes(32);
}

/** The key as stored (base64). Throws on anything but 32 bytes, naming no value. */
function parseKey(text: string) {
  const key = Buffer.from(String(text || '').trim(), 'base64');
  if (key.length !== 32) throw new Error('the backup key is not 32 bytes of base64');
  return key;
}

function nonce(base: Buffer, counter: number) {
  const n = Buffer.from(base);
  n.writeUInt32BE((n.readUInt32BE(8) ^ counter) >>> 0, 8);
  return n;
}

function aad(counter: number | bigint, final: unknown) {
  const b = Buffer.alloc(9);
  b.writeBigUInt64BE(BigInt(counter), 0);
  b[8] = final ? 1 : 0;
  return b;
}

function readFull(fd: number, buf: Buffer, position: number) {
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return got;
}

function sealChunk(key: Buffer, base: Buffer, counter: number, plain: Buffer, final: boolean) {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce(base, counter));
  c.setAAD(aad(counter, final));
  const body = Buffer.concat([c.update(plain), c.final()]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body, c.getAuthTag()]);
}

/** Encrypts `src` to `dst` (written whole, then renamed). Returns the bytes written. */
function encryptFile(src: string, dst: string, key: Buffer) {
  const partial = `${dst}.partial`;
  const inFd = fs.openSync(src, 'r');
  const outFd = fs.openSync(partial, 'w', 0o600);
  try {
    const base = crypto.randomBytes(12);
    fs.writeSync(outFd, MAGIC);
    fs.writeSync(outFd, base);
    const size = fs.fstatSync(inFd).size;
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    let counter = 0;
    do {
      const n = readFull(inFd, buf, pos);
      pos += n;
      // The last chunk (possibly empty) is the one that reaches the end.
      fs.writeSync(outFd, sealChunk(key, base, counter, buf.subarray(0, n), pos >= size));
      counter += 1;
    } while (pos < size);
  } catch (err) {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
    fs.rmSync(partial, { force: true });
    throw err;
  }
  fs.closeSync(inFd);
  fs.closeSync(outFd);
  fs.renameSync(partial, dst);
  return fs.statSync(dst).size;
}

/**
 * Decrypts `src` to `dst`. Throws (and leaves no `dst`) on a wrong key, a
 * modified byte, a reordered or truncated file.
 */
function decryptFile(src: string, dst: string, key: Buffer) {
  const partial = `${dst}.partial`;
  const inFd = fs.openSync(src, 'r');
  const total = fs.fstatSync(inFd).size;
  let outFd = null;
  try {
    const head = Buffer.alloc(MAGIC.length + 12);
    if (readFull(inFd, head, 0) < head.length || !head.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('not an encrypted backup (bad header)');
    }
    const base = head.subarray(MAGIC.length);
    outFd = fs.openSync(partial, 'w', 0o600);
    let pos = head.length;
    let counter = 0;
    let sawFinal = false;
    while (pos < total) {
      if (sawFinal) throw new Error('backup has data after its last chunk');
      const lenBuf = Buffer.alloc(4);
      if (readFull(inFd, lenBuf, pos) < 4) throw new Error('backup is truncated');
      const len = lenBuf.readUInt32BE(0);
      if (len > CHUNK || pos + 4 + len + TAG > total) throw new Error('backup is truncated or corrupt');
      const body = Buffer.alloc(len + TAG);
      readFull(inFd, body, pos + 4);
      pos += 4 + len + TAG;
      const final = pos >= total;
      const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(base, counter));
      d.setAAD(aad(counter, final));
      d.setAuthTag(body.subarray(len));
      let plain;
      try {
        plain = Buffer.concat([d.update(body.subarray(0, len)), d.final()]);
      } catch {
        throw new Error('backup failed authentication: wrong key, or the file was modified or truncated');
      }
      fs.writeSync(outFd, plain);
      sawFinal = final;
      counter += 1;
    }
    if (!sawFinal) throw new Error('backup is truncated');
  } catch (err) {
    fs.closeSync(inFd);
    if (outFd !== null) fs.closeSync(outFd);
    fs.rmSync(partial, { force: true });
    throw err;
  }
  fs.closeSync(inFd);
  fs.closeSync(outFd);
  fs.renameSync(partial, dst);
}

function isEncrypted(file: string) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(MAGIC.length);
      return readFull(fd, b, 0) === MAGIC.length && b.equals(MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

module.exports = { generateKey, parseKey, encryptFile, decryptFile, isEncrypted, CHUNK };
