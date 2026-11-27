'use strict';

// Tests for the Keys API (lib/secretsApi.ts). Uses a throwaway GPG keyring, password
// store, spec file and audit log, so nothing real is touched.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-api-test-'));
process.env.GNUPGHOME = path.join(dir, 'gnupg');
fs.mkdirSync(process.env.GNUPGHOME, { recursive: true, mode: 0o700 });
process.env.PASSWORD_STORE_DIR = path.join(dir, 'store');
process.env.TERMHUB_SECRETS_SPEC = path.join(dir, 'secrets.json');
process.env.TERMHUB_SECRETS_AUDIT = path.join(dir, 'audit.log');

const secrets = require('../lib/secrets.ts');
const api = require('../lib/secretsApi.ts');

let toolsOk = true;
const LOCAL = '127.0.0.1';
const REMOTE = '100.64.1.20';

before(() => {
  const gen = spawnSync('gpg', ['--batch', '--passphrase', '', '--quick-gen-key', 'keys-test <test@localhost>', 'default', 'default', 'never'], { encoding: 'utf8', env: process.env });
  const init = spawnSync('pass', ['init', 'keys-test'], { encoding: 'utf8', env: process.env });
  toolsOk = gen.status === 0 && init.status === 0;
  secrets.upsertSpec({ name: 'TEST_KEY_ONE', description: 'one', destination: 'test', requesters: ['cli'] });
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeReq(method, pathname, { body = null, addr = LOCAL, headers = {} } = {}) {
  const r = new Readable({ read() {} });
  if (body !== null) r.push(JSON.stringify(body));
  r.push(null);
  r.method = method;
  r.url = pathname;
  r.headers = headers;
  r.socket = { remoteAddress: addr };
  return r;
}

/** Run one request through the handler and resolve with { status, body }. */
function run(req, { gate = { enabled: false, verdict: async () => ({ ok: true }) } } = {}) {
  return new Promise((resolve) => {
    const res = {};
    const sendJson = (_res, status, body) => resolve({ status, body, text: JSON.stringify(body) });
    const handled = api.handle(req, res, new URL(req.url, 'http://localhost'), { sendJson, gate });
    assert.equal(handled, true);
  });
}

function skipIfNoTools(t) {
  if (!toolsOk) t.skip('gpg or pass is not available');
}

test('GET lists names and status, never values', { skip: false }, async (t) => {
  skipIfNoTools(t);
  secrets.setSecret('TEST_KEY_ONE', 'listing-secret-456');
  const r = await run(fakeReq('GET', '/api/secrets'));
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('listing-secret-456'));
  const row = r.body.secrets.find((s) => s.name === 'TEST_KEY_ONE');
  assert.equal(row.status, 'present');
  secrets.clearSecret('TEST_KEY_ONE');
});

test('set saves a value, returns no value, and writes an audit line by name', { skip: false }, async (t) => {
  skipIfNoTools(t);
  const r = await run(fakeReq('POST', '/api/secrets/set', { body: { name: 'TEST_KEY_ONE', value: 'typed-via-page-321' }, headers: { 'x-termhub': '1' } }));
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('typed-via-page-321'));
  assert.equal(secrets.getSecret('TEST_KEY_ONE'), 'typed-via-page-321');
  const audit = fs.readFileSync(process.env.TERMHUB_SECRETS_AUDIT, 'utf8');
  assert.match(audit, /set TEST_KEY_ONE/);
  assert.ok(!audit.includes('typed-via-page-321'));
  secrets.clearSecret('TEST_KEY_ONE');
});

test('set refuses a name that is not in the spec', { skip: false }, async (t) => {
  skipIfNoTools(t);
  const r = await run(fakeReq('POST', '/api/secrets/set', { body: { name: 'NOT_IN_SPEC', value: 'x' } }));
  assert.equal(r.status, 500);
  assert.match(r.body.error, /not in the spec/);
});

test('a remote caller is refused when passkeys are off', { skip: false }, async () => {
  const r = await run(fakeReq('GET', '/api/secrets', { addr: REMOTE }));
  assert.equal(r.status, 403);
  assert.match(r.body.error, /PA_PASSKEYS/);
});

test('a remote caller needs a registered passkey and a signed-in session', { skip: false }, async () => {
  const none = { enabled: true, status: async () => ({ registered: 0, signedIn: false }) };
  const r0 = await run(fakeReq('GET', '/api/secrets', { addr: REMOTE }), { gate: none });
  assert.equal(r0.status, 403);
  assert.match(r0.body.error, /Register a passkey/);
  const out = { enabled: true, status: async () => ({ registered: 2, signedIn: false }) };
  const r1 = await run(fakeReq('GET', '/api/secrets', { addr: REMOTE }), { gate: out });
  assert.equal(r1.status, 401);
  const ok = { enabled: true, status: async () => ({ registered: 2, signedIn: true }) };
  const r2 = await run(fakeReq('GET', '/api/secrets', { addr: REMOTE }), { gate: ok });
  assert.equal(r2.status, 200);
});

test('a bad name is refused before anything is written', { skip: false }, async () => {
  const r = await run(fakeReq('POST', '/api/secrets/set', { body: { name: 'bad-name', value: 'x' } }));
  assert.equal(r.status, 400);
});

test('add and remove a spec entry from the page', { skip: false }, async () => {
  const add = await run(fakeReq('POST', '/api/secrets/spec', { body: { name: 'TEST_KEY_TWO', description: 'two', destination: 'x', requesters: ['cli'] } }));
  assert.equal(add.status, 200);
  assert.ok(secrets.findSpec('TEST_KEY_TWO'));
  const rm = await run(fakeReq('POST', '/api/secrets/spec-remove', { body: { name: 'TEST_KEY_TWO' } }));
  assert.equal(rm.status, 200);
  assert.equal(secrets.findSpec('TEST_KEY_TWO'), undefined);
});

test('other paths are not handled here', { skip: false }, () => {
  const handled = api.handle(fakeReq('GET', '/api/sessions'), {}, new URL('http://localhost/api/sessions'), { sendJson() {}, gate: {} });
  assert.equal(handled, false);
});

test('add creates the list entry and saves the value in one step', { skip: false }, async (t) => {
  skipIfNoTools(t);
  const r = await run(fakeReq('POST', '/api/secrets/add', { body: { name: 'TEST_ADD_ONE', value: 'added-value-654' } }));
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('added-value-654'));
  assert.ok(secrets.findSpec('TEST_ADD_ONE'));
  assert.equal(secrets.getSecret('TEST_ADD_ONE'), 'added-value-654');
  secrets.clearSecret('TEST_ADD_ONE');
  secrets.removeSpec('TEST_ADD_ONE');
});
