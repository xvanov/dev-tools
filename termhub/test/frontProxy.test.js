'use strict';

// The front's /api/* proxy must survive sessiond dropping a connection
// mid-response.
//
// The case that earned its place: sessiond answered (headers already relayed
// to the browser), then the upstream socket died before the body finished. The
// proxy's error handler tried to send a fresh 502 on a response whose headers
// were already out, `writeHead` threw ERR_HTTP_HEADERS_SENT, nothing caught it,
// and the whole front exited — every tab on the machine went to "connection
// refused" while sessiond and its PTYs sat there perfectly healthy. A front
// that dies on one bad upstream response takes the whole UI with it, so the
// assertion that matters is the last one: the front still answers afterwards.

const assert = require('assert');
const http = require('http');
const { createFront } = require('../front');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, complete: res.complete }));
      res.on('error', (e) => resolve({ status: res.statusCode, body, error: e.code || e.message }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    // A response the front never finishes is a failure too, not a hang.
    req.setTimeout(2000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

(async () => {
  // A fake sessiond: /api/drop sends headers and half a body, then kills the
  // socket; /api/ok answers normally; /api/refuse closes before answering.
  const sessiond = http.createServer((req, res) => {
    if (req.url === '/api/drop') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 100 });
      res.write('{"partial":');
      return setTimeout(() => req.socket.destroy(), 20);
    }
    if (req.url === '/api/refuse') return req.socket.destroy();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  });
  const sessiondPort = await listen(sessiond);
  const front = createFront({ sessiondPort });
  const frontPort = await listen(front);

  let uncaught = null;
  process.on('uncaughtException', (e) => { uncaught = e; });

  const dropped = await get(frontPort, '/api/drop');
  assert.notStrictEqual(dropped.error, 'timeout', 'a dropped upstream must end the client response, not leave it hanging');
  assert.notStrictEqual(dropped.complete, true, 'a truncated upstream body must not look complete');

  // Upstream gone before answering: nothing has been sent yet, so a 502 is right.
  const refused = await get(frontPort, '/api/refuse');
  assert.strictEqual(refused.status, 502);

  // Several in a row — the original crash needed only one.
  await Promise.all([1, 2, 3].map(() => get(frontPort, '/api/drop')));

  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(uncaught, null, `front threw: ${uncaught && uncaught.stack}`);

  const ok = await get(frontPort, '/api/ok');
  assert.strictEqual(ok.status, 200, 'the front must still answer after upstream drops');
  assert.strictEqual(ok.body, '{"ok":true}');

  front.close();
  sessiond.close();
  console.log('frontProxy.test.js ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
