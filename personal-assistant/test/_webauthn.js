'use strict';

// A software authenticator for tests (plan 7.1): a FIXED ES256 key and credential
// id, and the byte layouts of WebAuthn Level 2 written out by hand (CBOR, COSE,
// authenticator data, clientDataJSON), so a test feeds the verifier exactly what
// a browser would, with no browser. The key is a throwaway generated for this
// file; it protects nothing.

const crypto = require('crypto');

const JWK = {
  kty: 'EC', crv: 'P-256',
  x: 'rIT4kXT6swLSi9stnagH1n7yWOk7cwvIMQ-jVHQxmlw',
  y: 'kKt0bOuXaGRxTKlXxEnw2oojXIVtS8rpkjZeTQx0PIg',
  d: 'yMsYyATW5u6Sfr5FC8U8osyr1KfFEZ4OyE_2eDF756k',
};
const CRED_ID = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const ORIGIN = 'http://localhost:7300';
const RP_ID = 'localhost';

const b64 = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ---- the little CBOR we need: uint, negint, bytes, text, map ----------------
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
function cbor(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}

/** The COSE_Key for the fixed key: kty 2 (EC2), alg -7 (ES256), crv 1 (P-256), x, y. */
function coseKey() {
  return cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(JWK.x, 'base64url')], [-3, Buffer.from(JWK.y, 'base64url')]]));
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

function authData({ rpId = RP_ID, flags, counter, attested = false }) {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(counter);
  const parts = [sha256(rpId), Buffer.from([flags]), c];
  if (attested) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(CRED_ID.length);
    parts.push(Buffer.alloc(16), len, CRED_ID, coseKey());
  }
  return Buffer.concat(parts);
}

function clientData(type, challenge, origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/** What navigator.credentials.create() returns, as the JSON the library takes. */
function register({ challenge, origin = ORIGIN, rpId = RP_ID, uv = true }) {
  const ad = authData({ rpId, flags: UP | (uv ? UV : 0) | AT, counter: 0, attested: true });
  const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  return {
    id: b64(CRED_ID),
    rawId: b64(CRED_ID),
    type: 'public-key',
    response: {
      clientDataJSON: b64(clientData('webauthn.create', challenge, origin)),
      attestationObject: b64(attestationObject),
      transports: ['internal'],
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
}

/** What navigator.credentials.get() returns for the fixed passkey. */
function assert({ challenge, counter = 1, origin = ORIGIN, rpId = RP_ID, uv = true, key = JWK }) {
  const ad = authData({ rpId, flags: UP | (uv ? UV : 0), counter });
  const cd = clientData('webauthn.get', challenge, origin);
  const signature = crypto.sign('sha256', Buffer.concat([ad, sha256(cd)]), crypto.createPrivateKey({ key, format: 'jwk' }));
  return {
    id: b64(CRED_ID),
    rawId: b64(CRED_ID),
    type: 'public-key',
    response: { clientDataJSON: b64(cd), authenticatorData: b64(ad), signature: b64(signature), userHandle: b64('pa-owner-v1') },
    clientExtensionResults: {},
  };
}

/** A different key, for "a signature from another authenticator". */
function otherKey() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
}

module.exports = { JWK, CRED_ID, ORIGIN, RP_ID, register, assert, otherKey, b64, coseKeyBytes: coseKey };
