'use strict';

// /api/transcribe: a WAV in, whisper's text out — through this machine's
// whisper server, a peer termhub's, or a clear 503.
// Plain node, no deps:  node test/transcribe.test.js
//
// The whisper server is faked with its real protocol (voice-dictation/
// transcribe_server.py): a TCP socket that reads an absolute path, half-close,
// answers the text and closes. The fake reads the file it was handed, so the
// test also proves the upload was written whole and removed afterwards.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { createFront } = require('../front');
const T = require('../lib/transcribe');
const VC = require('../web/voiceCapture');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// A fake transcribe_server.py. `answer(path, bytes)` decides the reply.
function fakeWhisper(answer) {
  const seen = [];
  const server = net.createServer((sock) => {
    let data = '';
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => {
      const file = data.trim();
      if (!file) return sock.end();
      let bytes = null;
      try { bytes = fs.readFileSync(file); } catch {}
      seen.push({ file, bytes });
      sock.end(answer(file, bytes));
    });
    sock.on('error', () => {});
  });
  return { server, seen };
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const wav = () => Buffer.from(VC.encodeWav(new Float32Array(16000).fill(0.1), 16000));
const WAV_HEADERS = { 'X-Termhub': '1', 'Content-Type': 'audio/wav' };
const noPeers = { listPeers: () => [], fetchJson: async () => null };

(async () => {
  // ---- pure: backend selection ---------------------------------------------------
  assert.deepStrictEqual(T.chooseBackend({ localUp: true, peers: [{ url: 'p', local: true }] }), { kind: 'local' },
    'local wins over a peer');
  assert.deepStrictEqual(T.chooseBackend({ localUp: false, peers: [{ url: 'a', local: false }, { url: 'b', local: true }] }),
    { kind: 'peer', url: 'b' }, 'the first peer that has one');
  let c = T.chooseBackend({ localUp: false, peers: [{ url: 'b', local: true }], hop: true });
  assert.strictEqual(c.kind, 'none', 'a forwarded request never forwards again');
  c = T.chooseBackend({ localUp: false, peers: [], port: 47821 });
  assert.strictEqual(c.kind, 'none');
  assert.match(c.reason, /127\.0\.0\.1:47821.*no peer termhub is configured/);
  c = T.chooseBackend({ localUp: false, peers: [{ url: 'a', local: false }] });
  assert.match(c.reason, /none of 1 configured peer has one/);
  assert.strictEqual(T.chooseBackend({ enabled: false, localUp: true }).kind, 'none');

  const urls = ['https://lap-us101.example.ts.net:7000', 'https://k-911-x17.example.ts.net:7443'];
  assert.deepStrictEqual(T.eligiblePeers(urls, ''), urls);
  assert.deepStrictEqual(T.eligiblePeers(urls, 'off'), []);
  assert.deepStrictEqual(T.eligiblePeers(urls, 'lap-us101'), [urls[0]]);
  assert.deepStrictEqual(T.eligiblePeers(urls, 'k-911-x17.example.ts.net'), [urls[1]]);
  assert.deepStrictEqual(T.eligiblePeers(urls, 'https://evil.example:7000'), [], 'a pin outside the peer list matches nothing');

  assert.strictEqual(T.wavProblem(wav()), null);
  assert.strictEqual(T.wavProblem(Buffer.alloc(10)), 'no audio');
  assert.strictEqual(T.wavProblem(Buffer.alloc(100)), 'not a WAV file');

  assert.strictEqual(T.settings({}).port, 47821, 'voice-dictation\'s default port');
  assert.strictEqual(T.settings({ TRANSCRIBE_PORT: '5000' }).port, 5000, 'voice-dictation\'s own variable is honoured');
  assert.strictEqual(T.settings({ TRANSCRIBE_PORT: '5000', TERMHUB_TRANSCRIBE_PORT: '6000' }).port, 6000);

  // ---- a front with a local whisper ------------------------------------------------
  const whisper = fakeWhisper((file, bytes) => (bytes && bytes.toString('ascii', 0, 4) === 'RIFF' ? ' hello from the phone ' : 'ERROR: bad file'));
  const whisperPort = await listen(whisper.server);
  const envA = { TERMHUB_TRANSCRIBE_PORT: String(whisperPort) };
  const frontA = createFront({ sessiondPort: 1, paUrl: '', transcribe: { env: envA, ...noPeers } });
  const portA = await listen(frontA);

  let r = await request(portA, 'GET', '/api/transcribe');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.available, true);
  assert.strictEqual(r.body.backend, 'local');
  assert.strictEqual(r.body.local.port, whisperPort);

  r = await request(portA, 'POST', '/api/transcribe', { headers: WAV_HEADERS, body: wav() });
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.text, 'hello from the phone');
  assert.strictEqual(r.body.backend, 'local');
  const handed = whisper.seen[whisper.seen.length - 1];
  assert.ok(handed.bytes && handed.bytes.equals(wav()), 'whisper got the exact upload');
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(!fs.existsSync(handed.file), 'the temp file is removed afterwards');

  // The guard: the CSRF header, and no "simple" content type.
  r = await request(portA, 'POST', '/api/transcribe', { headers: { 'Content-Type': 'audio/wav' }, body: wav() });
  assert.strictEqual(r.status, 403, 'no X-Termhub: refused by the request guard');
  r = await request(portA, 'POST', '/api/transcribe', { headers: { 'X-Termhub': '1', 'Content-Type': 'text/plain' }, body: wav() });
  assert.strictEqual(r.status, 415);
  r = await request(portA, 'POST', '/api/transcribe', { headers: { 'X-Termhub': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 415, 'only audio/wav');
  r = await request(portA, 'POST', '/api/transcribe', { headers: { ...WAV_HEADERS, Origin: 'https://evil.example' }, body: wav() });
  assert.strictEqual(r.status, 403, 'a foreign Origin is refused');
  r = await request(portA, 'POST', '/api/transcribe', { headers: WAV_HEADERS, body: Buffer.alloc(200) });
  assert.strictEqual(r.status, 400, 'not a WAV');
  const before = whisper.seen.length;
  r = await request(portA, 'POST', '/api/transcribe', { headers: WAV_HEADERS, body: Buffer.alloc(T.MAX_AUDIO_BYTES + 1024) });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(whisper.seen.length, before, 'nothing oversized reaches whisper');
  r = await request(portA, 'PUT', '/api/transcribe', { headers: WAV_HEADERS, body: wav() });
  assert.strictEqual(r.status, 405);

  // A whisper error is a 502 with its message.
  const bad = fakeWhisper(() => 'ERROR: CUDA out of memory');
  const badPort = await listen(bad.server);
  const frontBad = createFront({ sessiondPort: 1, paUrl: '', transcribe: { env: { TERMHUB_TRANSCRIBE_PORT: String(badPort) }, ...noPeers } });
  const portBad = await listen(frontBad);
  r = await request(portBad, 'POST', '/api/transcribe', { headers: WAV_HEADERS, body: wav() });
  assert.strictEqual(r.status, 502);
  assert.match(r.body.error, /CUDA out of memory/);

  // ---- no whisper anywhere: 503 with the reason --------------------------------------
  const deadPort = await freePort();
  const frontNone = createFront({ sessiondPort: 1, paUrl: '', transcribe: { env: { TERMHUB_TRANSCRIBE_PORT: String(deadPort) }, ...noPeers } });
  const portNone = await listen(frontNone);
  r = await request(portNone, 'GET', '/api/transcribe');
  assert.strictEqual(r.body.available, false);
  assert.match(r.body.reason, /no whisper server/);
  r = await request(portNone, 'POST', '/api/transcribe', { headers: WAV_HEADERS, body: wav() });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.reason, 'no-backend');

  // TERMHUB_TRANSCRIBE=off: unavailable even with a whisper up.
  const frontOff = createFront({ sessiondPort: 1, paUrl: '', transcribe: { env: { ...envA, TERMHUB_TRANSCRIBE: 'off' }, ...noPeers } });
  const portOff = await listen(frontOff);
  r = await request(portOff, 'GET', '/api/transcribe');
  assert.strictEqual(r.body.available, false);
  assert.match(r.body.reason, /TERMHUB_TRANSCRIBE=off/);

  // ---- through a peer: B has no whisper, A (configured as B's peer) does -----------------
  const peerA = `http://127.0.0.1:${portA}`;
  const peers = require('../lib/peers');
  const frontB = createFront({
    sessiondPort: 1, paUrl: '',
    transcribe: { env: { TERMHUB_TRANSCRIBE_PORT: String(deadPort) }, listPeers: () => [peerA], fetchJson: peers.fetchJson },
  });
  const portB = await listen(frontB);
  r = await request(portB, 'GET', '/api/transcribe');
  assert.strictEqual(r.body.available, true, JSON.stringify(r.body));
  assert.strictEqual(r.body.backend, 'peer');
  assert.strictEqual(r.body.peer, peerA);
  r = await request(portB, 'POST', '/api/transcribe', { headers: WAV_HEADERS, body: wav() });
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.text, 'hello from the phone');
  assert.strictEqual(r.body.backend, 'peer');

  // A forwarded request (the hop header) is answered locally or not at all.
  r = await request(portB, 'POST', '/api/transcribe', { headers: { ...WAV_HEADERS, 'X-Termhub-Transcribe-Hop': '1' }, body: wav() });
  assert.strictEqual(r.status, 503, 'B must not forward a request that was already forwarded');
  r = await request(portB, 'GET', '/api/transcribe?local=1');
  assert.strictEqual(r.body.available, false, '?local=1 reports the local backend only');

  // TERMHUB_TRANSCRIBE_PEER=off: no forwarding.
  const frontC = createFront({
    sessiondPort: 1, paUrl: '',
    transcribe: { env: { TERMHUB_TRANSCRIBE_PORT: String(deadPort), TERMHUB_TRANSCRIBE_PEER: 'off' }, listPeers: () => [peerA], fetchJson: peers.fetchJson },
  });
  const portC = await listen(frontC);
  r = await request(portC, 'GET', '/api/transcribe');
  assert.strictEqual(r.body.available, false);

  // ---- the rate cap ------------------------------------------------------------------
  const frontR = createFront({ sessiondPort: 1, paUrl: '', transcribe: { env: envA, ...noPeers, rateMax: 2 } });
  const portR = await listen(frontR);
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await request(portR, 'POST', '/api/transcribe', { headers: WAV_HEADERS, body: wav() })).status);
  assert.deepStrictEqual(codes, [200, 200, 429]);

  for (const s of [frontA, frontBad, frontNone, frontOff, frontB, frontC, frontR, whisper.server, bad.server]) s.close();
  console.log('transcribe: ok');
})().catch((e) => { console.error(e); process.exit(1); });
