'use strict';

// The termhub session client (src/dispatch/termhub.js) against termhub's
// CSRF guard (termhub/lib/requestGuard.js).
//
// What earns a test: termhub refuses a state-changing request without
// `X-Termhub: 1`, so every call the dispatcher makes — create a session, type
// into it, kill it — must carry the header, and the PTY socket the dispatcher
// reads a screen through must still open (it sends no Origin, which the guard
// accepts). Every call goes to a stand-in termhub that records the headers;
// when the sibling termhub checkout is installed, the same calls go through a
// REAL termhub front to a stand-in sessiond that applies termhub's own guard,
// so a drift between the two sides fails here rather than in a dispatched run.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const { client } = require('../src/dispatch/termhub');

const termhubDir = path.join(__dirname, '..', '..', 'termhub');
const haveTermhub = fs.existsSync(path.join(termhubDir, 'lib', 'requestGuard.js'))
  && fs.existsSync(path.join(termhubDir, 'node_modules'));
const guard = haveTermhub ? require(path.join(termhubDir, 'lib', 'requestGuard.js')) : null;

// A stand-in sessiond: answers the few routes the client uses, records every
// request, and — when termhub is installed — refuses exactly what termhub would.
function fakeSessiond() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://x').pathname;
      seen.push({ method: req.method, pathname, headers: req.headers });
      const refused = guard && guard.checkRequest(req, pathname);
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (refused) return send(refused.status, { error: refused.error });
      if (req.method === 'POST' && pathname === '/api/sessions') return send(200, { id: 's1', title: 't' });
      if (req.method === 'GET' && pathname === '/api/sessions') return send(200, { sessions: [{ id: 's1' }] });
      if (req.method === 'POST' && pathname === '/api/sessions/s1/input') return send(200, { ok: true });
      if (req.method === 'DELETE' && pathname === '/api/sessions/s1') return send(200, { ok: true });
      return send(404, { error: 'no such route' });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (guard && guard.checkUpgrade(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ type: 'replay', data: 'hello \x1b[1mscreen\x1b[0m' })));
  });
  return { server, seen };
}

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));

async function exercise(base, seen, label) {
  const hub = client(base);
  const { id } = await hub.createSession({ cwd: '/tmp', command: 'claude', title: 't' });
  assert.strictEqual(id, 's1', `${label}: created`);
  assert.strictEqual(await hub.say(id, 'hello', { submit: false }), true, `${label}: typed`);
  assert.deepStrictEqual((await hub.listSessions()).map((s) => s.id), ['s1']);
  assert.strictEqual(await hub.killSession(id), true, `${label}: killed`);
  assert.match(await hub.screen(id), /hello screen/, `${label}: the PTY socket opened`);

  const writes = seen.filter((r) => r.method !== 'GET');
  assert.deepStrictEqual(writes.map((r) => `${r.method} ${r.pathname}`),
    ['POST /api/sessions', 'POST /api/sessions/s1/input', 'DELETE /api/sessions/s1'], `${label}: every write arrived`);
  for (const r of writes) {
    assert.strictEqual(r.headers['x-termhub'], '1', `${label}: ${r.method} ${r.pathname} carries X-Termhub`);
  }
  for (const r of writes.filter((w) => w.method === 'POST')) {
    assert.match(r.headers['content-type'], /^application\/json/, `${label}: ${r.pathname} is JSON`);
  }
}

(async () => {
  // Direct: the client against a stand-in termhub.
  {
    const { server, seen } = fakeSessiond();
    const port = await listen(server);
    try {
      await exercise(`http://127.0.0.1:${port}`, seen, 'direct');
    } finally {
      server.close();
    }
  }

  // Through a real termhub front, which applies the guard before proxying.
  if (haveTermhub) {
    const { createFront } = require(path.join(termhubDir, 'front.js'));
    const { server: sessiond, seen } = fakeSessiond();
    const sessiondPort = await listen(sessiond);
    const front = createFront({ sessiondPort, port: 0, paUrl: '' });
    const frontPort = await listen(front);
    try {
      await exercise(`http://127.0.0.1:${frontPort}`, seen, 'through termhub');

      // And the same front refuses the cross-site request the guard exists for.
      const res = await fetch(`http://127.0.0.1:${frontPort}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
        body: JSON.stringify({ command: 'id' }),
      });
      assert.strictEqual(res.status, 403, 'a cross-site text/plain POST is refused');
    } finally {
      front.close();
      sessiond.close();
    }
  } else {
    console.log('termhubClient.test.js: termhub not installed alongside — skipped the through-termhub leg');
  }

  console.log('termhubClient.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
