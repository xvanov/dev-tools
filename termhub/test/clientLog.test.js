'use strict';

// /api/client-log: the phone's failures, written down on the machine.
// Plain node, no deps:  node test/clientLog.test.js
//
// What matters: a well-formed line lands and reads back; a POST without the
// CSRF header is refused by the front's guard (any tailnet page can reach this
// route); junk and oversized bodies are refused; and the rate cap holds, so a
// client loop gone wrong can't fill the disk.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createFront } = require('../front.ts');
const { sanitize, RATE_MAX, MAX_BODY_BYTES } = require('../lib/clientLog.ts');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const GOOD = { 'X-Termhub': '1', 'Content-Type': 'application/json', 'User-Agent': 'iPhone test' };

(async () => {
  // ---- sanitize (pure) -------------------------------------------------------
  assert.strictEqual(sanitize(null), null);
  assert.strictEqual(sanitize([1, 2]), null);
  assert.strictEqual(sanitize({ error: 'network' }), null, 'an `event` is required');
  const s = sanitize({ event: 'speech-error', error: 'network', 'bad key': 1, nested: { a: 1 }, long: 'x'.repeat(5000), ts: 'forged' }, { now: 0, ua: 'UA' });
  assert.strictEqual(s.event, 'speech-error');
  assert.strictEqual(s.ts, '1970-01-01T00:00:00.000Z', 'the server stamps the time, the client cannot');
  assert.strictEqual(s['bad key'], undefined);
  assert.strictEqual(s.nested, '{"a":1}');
  assert.ok(s.long.length < 700, 'long strings are clipped');
  assert.strictEqual(s.ua, 'UA');

  // ---- through the front -----------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-clientlog-'));
  const front = createFront({ sessiondPort: 1, paUrl: '', clientLogDir: dir });
  const port = await listen(front);

  const ok = await request(port, 'POST', '/api/client-log', {
    headers: GOOD, body: JSON.stringify({ event: 'speech-error', error: 'audio-capture', standalone: false }),
  });
  assert.strictEqual(ok.status, 204, `POST: ${ok.status} ${ok.body}`);

  const read = await request(port, 'GET', '/api/client-log?n=5');
  assert.strictEqual(read.status, 200);
  const { entries } = JSON.parse(read.body);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].error, 'audio-capture');
  assert.strictEqual(entries[0].ua, 'iPhone test');

  const noGuard = await request(port, 'POST', '/api/client-log', {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'x' }),
  });
  assert.strictEqual(noGuard.status, 403, 'the CSRF guard covers this route');

  const junk = await request(port, 'POST', '/api/client-log', { headers: GOOD, body: 'not json' });
  assert.strictEqual(junk.status, 400);

  const big = await request(port, 'POST', '/api/client-log', {
    headers: GOOD, body: JSON.stringify({ event: 'x', pad: 'y'.repeat(MAX_BODY_BYTES + 10) }),
  });
  assert.strictEqual(big.status, 413);

  // Rate cap: everything answers 204, only RATE_MAX lines in the window land.
  for (let i = 0; i < RATE_MAX + 15; i++) {
    // eslint-disable-next-line no-await-in-loop
    await request(port, 'POST', '/api/client-log', { headers: GOOD, body: JSON.stringify({ event: 'flood', i }) });
  }
  const lines = fs.readFileSync(path.join(dir, 'client-log.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, RATE_MAX, `rate cap: ${lines.length} lines`);

  front.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('clientLog.test.js ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
