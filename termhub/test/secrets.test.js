'use strict';

// Tests for the secrets service. Each run builds a throwaway GPG keyring and a
// throwaway password store in a temp folder, so these tests never touch real
// secrets and never ask for a passphrase.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
const gnupgHome = path.join(dir, 'gnupg');
const storeHome = path.join(dir, 'store');
fs.mkdirSync(gnupgHome, { recursive: true, mode: 0o700 });
process.env.GNUPGHOME = gnupgHome;
process.env.PASSWORD_STORE_DIR = storeHome;
process.env.TERMHUB_SECRETS_SPEC = path.join(dir, 'secrets.json');
process.env.TERMHUB_SECRETS_PORT = String(17040 + (process.pid % 1000));

const secrets = require('../lib/secrets.ts');
const popup = require('../lib/secretsPopup.ts');

const NAME = 'TEST_SECRET_ONE';
const PORT = popup.PORT;
let server;
let toolsOk = true;

before(() => {
  // A test key with no passphrase, only ever inside the temp GNUPGHOME.
  const gen = spawnSync('gpg', ['--batch', '--passphrase', '', '--quick-gen-key', 'termhub-test <test@localhost>', 'default', 'default', 'never'], { encoding: 'utf8', env: process.env });
  const init = spawnSync('pass', ['init', 'termhub-test'], { encoding: 'utf8', env: process.env });
  toolsOk = gen.status === 0 && init.status === 0;
  secrets.upsertSpec({ name: NAME, description: 'test', destination: 'test', requesters: ['cli'] });
  server = popup.start(PORT);
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Tests that store a real value skip (with a reason) if gpg or pass is missing.
function needTools() {
  return { skip: toolsOk ? false : 'gpg or pass is not available' };
}

test('names must be upper snake case', () => {
  assert.equal(secrets.validName('JEV_API_KEY'), true);
  assert.equal(secrets.validName('bad-name'), false);
  assert.equal(secrets.validName('lower'), false);
  assert.equal(secrets.validName(''), false);
});

test('allow-list is exact', () => {
  const spec = { name: NAME, requesters: ['cli'] };
  assert.equal(secrets.mayRequest(spec, 'cli'), true);
  assert.equal(secrets.mayRequest(spec, 'claude-cloud'), false);
});

test('spec round-trips and never stores values', () => {
  secrets.upsertSpec({ name: 'TEST_SPEC_ONLY', description: 'd', destination: 'x', requesters: [] });
  assert.ok(secrets.findSpec('TEST_SPEC_ONLY'));
  assert.ok(!fs.readFileSync(process.env.TERMHUB_SECRETS_SPEC, 'utf8').includes('value'));
  secrets.removeSpec('TEST_SPEC_ONLY');
  assert.equal(secrets.findSpec('TEST_SPEC_ONLY'), undefined);
});

test('a name not in the spec cannot be set', () => {
  assert.throws(() => secrets.setSecret('NOT_IN_SPEC', 'x'), /not in the spec/);
});

test('set, present, read, clear', needTools(), () => {
  assert.equal(secrets.status(NAME), 'missing');
  secrets.setSecret(NAME, 'value-abc-123');
  assert.equal(secrets.status(NAME), 'present');
  assert.equal(secrets.getSecret(NAME), 'value-abc-123');
  secrets.clearSecret(NAME);
  assert.equal(secrets.status(NAME), 'missing');
});

test('the stored file is encrypted, not plain text', needTools(), () => {
  secrets.setSecret(NAME, 'plain-check-777');
  const bytes = fs.readFileSync(path.join(storeHome, 'termhub', `${NAME}.gpg`));
  assert.ok(!bytes.includes('plain-check-777'));
  secrets.clearSecret(NAME);
});

test('request is denied for unknown names and wrong requesters, and never returns a value', needTools(), () => {
  assert.equal(secrets.request('NOPE_NOT_HERE', 'cli').result, 'denied');
  assert.equal(secrets.request(NAME, 'claude-cloud').result, 'denied');
  secrets.setSecret(NAME, 'value-xyz');
  const r = secrets.request(NAME, 'cli');
  assert.equal(r.result, 'present');
  assert.ok(!JSON.stringify(r).includes('value-xyz'));
  secrets.clearSecret(NAME);
});

function call(method, p, { host = `127.0.0.1:${PORT}`, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { Host: host, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('popup refuses a foreign Host header', async () => {
  const r = await call('GET', '/', { host: 'evil.example:' + PORT });
  assert.equal(r.status, 421);
});

test('popup refuses a POST without the token', async () => {
  const r = await call('POST', '/api/set', { body: `name=${NAME}&value=hacked` });
  assert.equal(r.status, 403);
  assert.notEqual(secrets.status(NAME), 'present');
});

test('popup saves a value with the token and never echoes it', needTools(), async () => {
  const body = `token=${popup.TOKEN}&name=${NAME}&value=${encodeURIComponent('typed-secret-999')}`;
  const r = await call('POST', '/api/set', { body });
  assert.equal(r.status, 303);
  assert.ok(!r.body.includes('typed-secret-999'));
  assert.ok(!String(r.headers.location || '').includes('typed-secret-999'));
  assert.equal(secrets.getSecret(NAME), 'typed-secret-999');
  const page = await call('GET', `/?name=${NAME}`);
  assert.ok(!page.body.includes('typed-secret-999'));
  secrets.clearSecret(NAME);
});

test('popup status endpoint lists names and statuses only', needTools(), async () => {
  secrets.setSecret(NAME, 'status-check-value');
  const r = await call('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.ok(!r.body.includes('status-check-value'));
  assert.ok(JSON.parse(r.body).some((s) => s.name === NAME && s.status === 'present'));
  secrets.clearSecret(NAME);
});
