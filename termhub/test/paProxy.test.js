'use strict';

// The front's /pa/* proxy to the personal assistant's dashboard.
//
// The assertions that matter are the ones the PA's own guards depend on: Host
// must arrive as the PA's loopback host:port (it 403s anything else, by
// design), and X-PA must arrive at all (it 403s every POST without it). Get
// either wrong and the hub's PA buttons fail with an error that looks like the
// PA's fault. The rest — prefix strip, /pa -> /pa/, a fast 502 when the PA is
// down, off when TERMHUB_PA_URL is empty — is what makes the buttons usable.

const assert = require('assert');
const http = require('http');
const net = require('net');
const { createFront } = require('../front');
const { resolvePaUrl } = require('../lib/paProxy');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

// A port nothing listens on: bind one, note it, let it go.
async function deadPort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

(async () => {
  // resolvePaUrl: unset -> default, empty -> disabled, junk -> disabled.
  assert.strictEqual(resolvePaUrl({}).origin, 'http://127.0.0.1:7300');
  assert.strictEqual(resolvePaUrl({ TERMHUB_PA_URL: '' }), null);
  assert.strictEqual(resolvePaUrl({ TERMHUB_PA_URL: '   ' }), null);
  assert.strictEqual(resolvePaUrl({ TERMHUB_PA_URL: 'not a url' }), null);
  assert.strictEqual(resolvePaUrl({ TERMHUB_PA_URL: 'http://127.0.0.1:7399' }).port, '7399');

  // A fake PA: echoes what it received, and redirects /go to a path-absolute URL.
  const seen = [];
  const pa = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, xpa: req.headers['x-pa'], body: raw });
      if (req.url === '/go') { res.writeHead(302, { Location: '/landed' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ url: req.url, host: req.headers.host, xpa: req.headers['x-pa'] || null }));
    });
  });
  const paPort = await listen(pa);
  // sessiond isn't involved in any of this; a dead port proves /pa/* never goes there.
  const sessiondPort = await deadPort();

  const front = createFront({ sessiondPort, paUrl: `http://127.0.0.1:${paPort}` });
  const frontPort = await listen(front);

  // Prefix stripped, query kept, Host rewritten to the PA's own host:port.
  let r = await request(frontPort, { path: '/pa/api/state?x=1', headers: { Host: 'mybox.tailnet.ts.net:7000' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  let got = JSON.parse(r.body);
  assert.strictEqual(got.url, '/api/state?x=1');
  assert.strictEqual(got.host, `127.0.0.1:${paPort}`, 'Host must be the PA\'s loopback host, or its anti-rebinding guard 403s');

  // The dashboard root.
  r = await request(frontPort, { path: '/pa/' });
  assert.strictEqual(JSON.parse(r.body).url, '/');

  // POST: method, body and X-PA all arrive.
  r = await request(frontPort, {
    method: 'POST', path: '/pa/api/chat/open',
    headers: { 'X-PA': '1', 'Content-Type': 'application/json' }, body: '{"hello":true}',
  });
  assert.strictEqual(r.status, 200);
  const post = seen[seen.length - 1];
  assert.strictEqual(post.method, 'POST');
  assert.strictEqual(post.url, '/api/chat/open');
  assert.strictEqual(post.xpa, '1', 'X-PA must be forwarded — the PA refuses every POST without it');
  assert.strictEqual(post.body, '{"hello":true}');

  // /pa -> /pa/ (relative api/... URLs only resolve under a trailing slash).
  r = await request(frontPort, { path: '/pa?tab=memory' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/pa/?tab=memory');

  // A path-absolute redirect from the PA stays inside the prefix.
  r = await request(frontPort, { path: '/pa/go' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/pa/landed');

  // Not ours: /pax and /api/* are untouched by the PA proxy.
  const before = seen.length;
  r = await request(frontPort, { path: '/pax' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(seen.length, before, '/pax must not reach the PA');

  front.close();

  // PA down: a prompt 502, JSON for a script, a page for a browser.
  const down = createFront({ sessiondPort, paUrl: `http://127.0.0.1:${await deadPort()}` });
  const downPort = await listen(down);
  const t0 = Date.now();
  r = await request(downPort, { path: '/pa/api/state' });
  assert.strictEqual(r.status, 502, JSON.stringify(r));
  assert.ok(JSON.parse(r.body).error.includes('PA not running'));
  assert.ok(Date.now() - t0 < 2500, 'a PA that is down must answer fast, not hang');
  r = await request(downPort, { path: '/pa/', headers: { Accept: 'text/html,*/*' } });
  assert.strictEqual(r.status, 502);
  assert.ok(/text\/html/.test(r.headers['content-type']));
  assert.ok(r.body.includes('PA not running'));
  down.close();

  // Disabled through the environment: TERMHUB_PA_URL='' turns /pa/* off.
  const saved = process.env.TERMHUB_PA_URL;
  process.env.TERMHUB_PA_URL = '';
  const off = createFront({ sessiondPort });
  if (saved === undefined) delete process.env.TERMHUB_PA_URL; else process.env.TERMHUB_PA_URL = saved;
  const offPort = await listen(off);
  const n = seen.length;
  r = await request(offPort, { path: '/pa/api/state' });
  assert.strictEqual(r.status, 404);
  assert.ok(JSON.parse(r.body).error.includes('disabled'));
  assert.strictEqual(seen.length, n);
  off.close();

  pa.close();
  console.log('paProxy.test.js ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
