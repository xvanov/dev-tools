'use strict';

// The CSRF / DNS-rebinding / cross-site-WebSocket guard (lib/requestGuard.js)
// on every route of both tiers.
//
// What earns a test: the attack the guard exists for — a page on another origin
// POSTing a `text/plain` JSON-looking body to `/api/sessions` with a `command`,
// which no browser preflights — is refused by the front AND by sessiond's own
// loopback port, and starts nothing; a foreign-Origin websocket to a live PTY
// is refused on both tiers; a rebound `Host` cannot even READ the session list;
// and the legitimate callers still get through: the web UI's own requests
// (same Origin, `X-Termhub: 1`, JSON or a binary upload type), a bodyless
// DELETE, a peer termhub's reads (lib/peers.js, no Origin), and a program's
// websocket (no Origin). Runs a REAL sessiond behind a REAL front, with its
// data dir in a temp directory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-csrf-'));
process.env.TERMHUB_DATA_DIR = tmp;       // never touch the live archive / idle log
delete process.env.TERMHUB_NTFY_TOPIC;     // and never push a notification

const WebSocket = require('ws');
const { checkRequest, checkUpgrade, setLearnedNames } = require('../lib/requestGuard');
const { createSessiond } = require('../sessiond');
const { createFront } = require('../front');
const peers = require('../lib/peers');

// ---- the rules (pure) -------------------------------------------------------

const env = { TERMHUB_MACHINE: 'build-vm' };
setLearnedNames(['box.tail1234.ts.net']); // this machine's MagicDNS name (tailscale status Self.DNSName)
const H = '127.0.0.1:7000';
const ui = { host: H, origin: `http://${H}`, 'x-termhub': '1', 'content-type': 'application/json' };
const v = (method, p, headers) => checkRequest({ method, headers }, p, { env });

assert.strictEqual(v('POST', '/api/sessions', ui), null, 'the UI creating a session');
assert.strictEqual(v('POST', '/api/sessions', { host: H, 'x-termhub': '1', 'content-type': 'application/json' }), null, 'a program (no Origin)');
assert.strictEqual(v('DELETE', '/api/sessions/x', { host: H, 'x-termhub': '1' }), null, 'a bodyless DELETE');
assert.strictEqual(v('POST', '/api/sessions/x/clipboard-image', { ...ui, 'content-type': 'image/png' }), null, 'an image upload');
assert.strictEqual(v('POST', '/api/sessions/x/upload-file', { ...ui, 'content-type': 'application/octet-stream' }), null, 'a file upload');
assert.strictEqual(v('GET', '/api/sessions', { host: 'box.tail1234.ts.net:7000' }), null, 'a peer or a phone over MagicDNS');
assert.strictEqual(v('GET', '/api/sessions', { host: 'other.tail1234.ts.net:7000' }).status, 403, 'not any *.ts.net name: only this machine\'s own');
assert.strictEqual(v('GET', '/', { host: 'evil.example' }), null, 'static UI files are not guarded');
assert.strictEqual(v('OPTIONS', '/api/sessions', { host: H, origin: 'https://evil.example' }), null, 'OPTIONS is left to the routes (none grants CORS)');

const csrf = { host: H, origin: 'https://evil.example', 'content-type': 'text/plain' };
assert.strictEqual(v('POST', '/api/sessions', csrf).status, 403, 'the classic cross-site simple POST');
assert.strictEqual(v('POST', '/api/sessions', { host: H, 'content-type': 'text/plain' }).status, 403, 'no Origin, no X-Termhub');
assert.strictEqual(v('POST', '/api/sessions', { host: H, 'x-termhub': '1', 'content-type': 'text/plain' }).status, 415, 'a simple Content-Type');
for (const t of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'TEXT/PLAIN;charset=utf-8']) {
  assert.strictEqual(v('POST', '/api/sessions', { ...ui, 'content-type': t }).status, 415, `refused: ${t}`);
}
for (const [m, p] of [['POST', '/api/sessions/x/input'], ['PATCH', '/api/sessions/x'], ['DELETE', '/api/sessions/x'],
  ['POST', '/api/sessions/x/restore'], ['POST', '/api/sessions/x/voice'], ['POST', '/api/tts'], ['POST', '/api/idle/focus'],
  ['POST', '/api/idle/reopen'], ['POST', '/api/peers'], ['POST', '/api/clipboard-probe'], ['PUT', '/api/anything']]) {
  assert.strictEqual(v(m, p, { ...ui, 'x-termhub': undefined }).status, 403, `${m} ${p} needs X-Termhub`);
  assert.strictEqual(v(m, p, ui), null, `${m} ${p} passes for the UI`);
}
assert.strictEqual(v('GET', '/api/sessions', { host: 'evil.example:7000' }).status, 403, 'a rebound Host cannot read');
assert.strictEqual(v('GET', '/api/claude/transcripts', { host: H, origin: 'https://evil.example' }).status, 403, 'nor a foreign Origin');
assert.strictEqual(v('POST', '/pa/api/chat/open', { host: 'evil.example:7000', 'x-pa': '1' }).status, 403, '/pa/* is Host-checked');
assert.strictEqual(v('GET', '/pa', { host: 'evil.example:7000' }).status, 403, '/pa itself too');
assert.strictEqual(v('POST', '/pa/api/chat/open', { host: H, origin: `http://${H}`, 'x-pa': '1', 'content-type': 'application/json' }), null,
  '/pa/* POSTs are left to the PA\'s own X-PA rule');

const up = (headers) => checkUpgrade({ headers }, { env });
assert.strictEqual(up({ host: H, origin: `http://${H}` }), null, 'the UI\'s own websocket');
assert.strictEqual(up({ host: H }), null, 'a program\'s websocket (no Origin)');
assert.strictEqual(up({ host: 'box.tail1234.ts.net:7000', origin: 'https://box.tail1234.ts.net:7000' }), null, 'over Serve');
assert.strictEqual(up({ host: H, origin: 'https://evil.example' }).status, 403, 'cross-site websocket hijacking');
assert.strictEqual(up({ host: H, origin: 'null' }).status, 403, 'an opaque origin');
assert.strictEqual(up({ host: 'evil.example:7000', origin: 'http://evil.example:7000' }).status, 403, 'a rebound websocket');
assert.strictEqual(up({ host: 'evil.tail9999.ts.net', origin: 'https://evil.tail9999.ts.net' }).status, 403, 'a foreign MagicDNS/Funnel name');

// ---- through a real front and a real sessiond -----------------------------

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

// Resolves 'open', or the HTTP status of a refused handshake.
function wsOutcome(port, p, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('error', () => resolve('error'));
  });
}

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));

(async () => {
  const sessiond = createSessiond({ entry: 'test', port: 0 });
  const sPort = await listen(sessiond);
  const front = createFront({ sessiondPort: sPort, port: 0, paUrl: '' });
  const fPort = await listen(front);
  const live = async () => (await request(fPort, { path: '/api/sessions' })).json.sessions.length;
  let created = null;

  try {
    // The attack: a cross-site text/plain POST with a command. Both tiers.
    const evilBody = JSON.stringify({ command: 'touch pwned', cwd: tmp, cols: 80, rows: 24 });
    for (const [tier, port] of [['front', fPort], ['sessiond', sPort]]) {
      const r = await request(port, {
        method: 'POST', path: '/api/sessions', body: evilBody,
        headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      });
      assert.strictEqual(r.status, 403, `${tier}: cross-site text/plain POST /api/sessions is refused`);
      // The same body, sent the way a <form> would with no Origin.
      const r2 = await request(port, { method: 'POST', path: '/api/sessions', body: evilBody, headers: { 'Content-Type': 'text/plain' } });
      assert.strictEqual(r2.status, 403, `${tier}: and without an Origin`);
    }
    assert.strictEqual(await live(), 0, 'nothing was started');
    assert.ok(!fs.existsSync(path.join(tmp, 'pwned')));

    // The UI's own request: same Origin, X-Termhub, JSON. A real PTY.
    const uiHeaders = { 'Content-Type': 'application/json', 'X-Termhub': '1', Origin: `http://127.0.0.1:${fPort}` };
    const made = await request(fPort, {
      method: 'POST', path: '/api/sessions', headers: uiHeaders,
      body: JSON.stringify({ cwd: tmp, command: '', title: 'csrf-test', cols: 80, rows: 24 }),
    });
    assert.strictEqual(made.status, 201, `the UI can create a session: ${JSON.stringify(made.json)}`);
    created = made.json.id;
    assert.strictEqual(await live(), 1);

    // Typing: the PA's REST route, refused cross-site, accepted with the header.
    const inputPath = `/api/sessions/${encodeURIComponent(created)}/input`;
    assert.strictEqual((await request(fPort, { method: 'POST', path: inputPath, body: '{"data":"x"}',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' } })).status, 403);
    assert.strictEqual((await request(fPort, { method: 'POST', path: inputPath, body: '{"data":"echo hi","submit":false}',
      headers: { 'Content-Type': 'application/json', 'X-Termhub': '1' } })).status, 200, 'a program can type');

    // Websockets into that PTY, on both tiers.
    const term = `/ws/term/${encodeURIComponent(created)}`;
    for (const [tier, port] of [['front', fPort], ['sessiond', sPort]]) {
      assert.strictEqual(await wsOutcome(port, term, { Origin: 'https://evil.example' }), 403, `${tier}: foreign-Origin ws refused`);
      assert.strictEqual(await wsOutcome(port, '/ws/voice', { Origin: 'https://evil.example' }), 403, `${tier}: voice feed too`);
      assert.strictEqual(await wsOutcome(port, term, { Origin: `http://127.0.0.1:${port}` }), 'open', `${tier}: same-origin ws opens`);
      assert.strictEqual(await wsOutcome(port, term), 'open', `${tier}: a program's ws (no Origin) opens`);
    }

    // A rebound Host can't even read.
    assert.strictEqual((await request(fPort, { path: '/api/sessions', headers: { Host: 'evil.example:7000' } })).status, 403);
    assert.strictEqual((await request(sPort, { path: '/api/sessions', headers: { Host: 'evil.example:7010' } })).status, 403);

    // A peer termhub reading this one (lib/peers.js: plain GETs, no Origin).
    const ping = await peers.fetchJson(`http://127.0.0.1:${fPort}/api/ping`, { timeoutMs: 20_000 }) /* 2.5 s default starves under a loaded box */;
    assert.ok(ping && ping.entry === 'test', 'a peer can identify this machine');
    assert.ok(await peers.fetchJson(`http://127.0.0.1:${fPort}/api/idle`, { timeoutMs: 20_000 }), 'and read its idle data');

    // Rename and kill, the UI's way.
    const idPath = `/api/sessions/${encodeURIComponent(created)}`;
    assert.strictEqual((await request(fPort, { method: 'PATCH', path: idPath, body: '{"title":"x"}',
      headers: { 'Content-Type': 'text/plain' } })).status, 403, 'rename needs the header');
    assert.strictEqual((await request(fPort, { method: 'PATCH', path: idPath, body: '{"title":"renamed"}', headers: uiHeaders })).status, 200);
    assert.strictEqual((await request(fPort, { method: 'DELETE', path: idPath })).status, 403, 'kill needs the header');
    assert.strictEqual(await live(), 1, 'and a refused kill killed nothing');
    assert.strictEqual((await request(fPort, { method: 'DELETE', path: idPath, headers: { 'X-Termhub': '1', Origin: `http://127.0.0.1:${fPort}` } })).status, 200);
    created = null;

    console.log('csrf.test.js ok');
  } finally {
    if (created) await request(fPort, { method: 'DELETE', path: `/api/sessions/${encodeURIComponent(created)}`, headers: { 'X-Termhub': '1' } }).catch(() => {});
    front.close();
    sessiond.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a just-killed PTY can hold the dir a moment
  }
  process.exit(0); // sessiond's idle/voice hubs keep timers alive
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// No tailnet name learned and none configured: a startup warning naming TERMHUB_ALLOWED_HOSTS.
{
  const { selfNamesWarning } = require('../lib/requestGuard');
  const w = selfNamesWarning(new Set(), {});
  require('assert').match(w, /TERMHUB_ALLOWED_HOSTS/);
  require('assert').match(w, /tailscale/);
  require('assert').strictEqual(selfNamesWarning(new Set(['box.tail1.ts.net']), {}), null);
  require('assert').strictEqual(selfNamesWarning(new Set(), { TERMHUB_ALLOWED_HOSTS: 'box.tail1.ts.net' }), null);
  console.log('csrf: tailnet-name warning ok');
}
