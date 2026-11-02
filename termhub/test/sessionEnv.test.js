'use strict';

// Per-session environment (lib/sessionEnv.js): `POST /api/sessions {env,
// unsetEnv}`. The personal assistant starts a run that may not push without
// push credentials, so what earns a test: removals really reach the PTY
// (case-insensitively on Windows), bad names are refused, the change is
// reported back (`envApplied`) so a caller can refuse a termhub that ignored
// it, it survives into the archive entry a restore reads, and the request
// still goes through the CSRF guard like every other POST. Runs a REAL
// sessiond behind a REAL front, with its data dir in a temp directory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-env-'));
process.env.TERMHUB_DATA_DIR = tmp;
delete process.env.TERMHUB_NTFY_TOPIC;

const { parseEnvSpec, applyEnvSpec } = require('../lib/sessionEnv');

// ---- the rules (pure) -------------------------------------------------------

assert.deepStrictEqual(parseEnvSpec({}), { spec: null });
assert.deepStrictEqual(parseEnvSpec({ env: { A: '1' }, unsetEnv: ['GH_TOKEN'] }), { spec: { env: { A: '1' }, unset: ['GH_TOKEN'] } });
for (const bad of [
  { env: 'A=1' }, { env: ['A'] }, { env: { 'A B': '1' } }, { env: { '1A': '1' } }, { env: { A: 1 } }, { env: { A: 'x\0y' } },
  { unsetEnv: 'GH_TOKEN' }, { unsetEnv: ['GH TOKEN'] }, { unsetEnv: [3] }, { unsetEnv: Array.from({ length: 65 }, (_, i) => `V${i}`) },
]) assert.ok(parseEnvSpec(bad).error, JSON.stringify(bad));

const base = { PATH: '/bin', GH_TOKEN: 't', gh_token: 'u', KEEP: 'k', GIT_CONFIG_COUNT: '9' };
const spec = { env: { GIT_CONFIG_COUNT: '1', NEW: 'n' }, unset: ['GH_TOKEN'] };
assert.deepStrictEqual(applyEnvSpec(base, spec, 'linux'), { PATH: '/bin', gh_token: 'u', KEEP: 'k', GIT_CONFIG_COUNT: '1', NEW: 'n' });
assert.deepStrictEqual(applyEnvSpec(base, spec, 'win32'), { PATH: '/bin', KEEP: 'k', GIT_CONFIG_COUNT: '1', NEW: 'n' }, 'Windows names fold case');
assert.deepStrictEqual(applyEnvSpec(base, null), base);
assert.notStrictEqual(applyEnvSpec(base, null), base, 'never mutates the base');

// ---- through a real front and a real sessiond --------------------------------

function request(port, { method = 'GET', path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (process.platform === 'win32') {
    console.log('sessionEnv.test.js: PTY leg skipped on Windows (POSIX shell command)');
    console.log('sessionEnv.test.js ok');
    return;
  }
  try { require('node-pty'); } catch (e) {
    console.log(`sessionEnv.test.js: PTY leg skipped (node-pty unavailable: ${e.message})`);
    console.log('sessionEnv.test.js ok');
    return;
  }
  process.env.GH_TOKEN = 'inherited-secret';
  process.env.PA_TEST_KEEP = 'kept';
  const { createSessiond } = require('../sessiond');
  const { createFront } = require('../front');
  const sessiond = createSessiond({ entry: 'test', port: 0 });
  const sPort = await listen(sessiond);
  const front = createFront({ sessiondPort: sPort, port: 0, paUrl: '' });
  const fPort = await listen(front);
  const ui = { 'Content-Type': 'application/json', 'X-Termhub': '1' };
  const made = [];
  try {
    const info = await request(fPort, { path: '/api/info' });
    assert.ok(info.json.features.includes('session-env'), '/api/info says it can');

    // Refused: a bad name, and a cross-site request (the CSRF guard still applies).
    const bad = await request(fPort, { method: 'POST', path: '/api/sessions', headers: ui, body: JSON.stringify({ cwd: tmp, command: '', unsetEnv: ['A B'] }) });
    assert.strictEqual(bad.status, 400);
    const evil = await request(fPort, {
      method: 'POST', path: '/api/sessions', headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      body: JSON.stringify({ cwd: tmp, command: 'touch pwned', env: { A: '1' } }),
    });
    assert.strictEqual(evil.status, 403);

    // Applied, reported, and really in the PTY.
    const out = path.join(tmp, 'env.txt');
    const command = `printf '%s|%s|%s\\n' "\${GH_TOKEN-unset}" "\${PA_X-unset}" "\${PA_TEST_KEEP-unset}" > '${out}'`;
    const r = await request(fPort, {
      method: 'POST', path: '/api/sessions', headers: ui,
      body: JSON.stringify({ cwd: tmp, command, title: 'env', cols: 80, rows: 24, env: { PA_X: 'set' }, unsetEnv: ['GH_TOKEN'] }),
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    made.push(r.json.id);
    assert.strictEqual(r.json.envApplied, true);
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await sleep(100);
    for (let i = 0; i < 20 && !fs.readFileSync(out, 'utf8').includes('\n'); i++) await sleep(50);
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'unset|set|kept', 'removed, added, the rest inherited');

    // A plain session is unchanged and says nothing about env.
    const plain = await request(fPort, { method: 'POST', path: '/api/sessions', headers: ui, body: JSON.stringify({ cwd: tmp, command: '', title: 'plain' }) });
    made.push(plain.json.id);
    assert.ok(!('envApplied' in plain.json));

    // The archive entry carries the spec, so a restore keeps it.
    const archived = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions.json'), 'utf8'));
    const list = Array.isArray(archived) ? archived : Object.values(archived.sessions || archived);
    const entry = list.find((e) => e && e.id === r.json.id);
    assert.ok(entry, 'archived');
    assert.deepStrictEqual(entry.envSpec, { env: { PA_X: 'set' }, unset: ['GH_TOKEN'] });

    console.log('sessionEnv.test.js ok');
  } finally {
    for (const id of made) await request(fPort, { method: 'DELETE', path: `/api/sessions/${encodeURIComponent(id)}`, headers: { 'X-Termhub': '1' } }).catch(() => {});
    front.close();
    sessiond.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0); // sessiond's idle/voice hubs keep timers alive
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
