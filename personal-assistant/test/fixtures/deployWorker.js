'use strict';

// A worker generation for the deploy test's spare mode (src/e2e/deployTest.js,
// plan Z6), without Postgres. It speaks the supervisor's protocol like
// src/worker.js and serves the parts a deploy must not break, with the real
// code where it matters:
//
//   GET /healthz, /api/version   as the dashboard does
//   GET /api/events               the real SSE endpoint (src/dashboard/events.js)
//                                 over a real bus (src/events/bus.js)
//
// The database's NOTIFY feed is stood in for by DEPLOY_FEED, a URL the test
// serves: one line per event, {seq, topic, n}, to every generation listening,
// in the same order, after a first line {baseline} (the sequence's value when
// this generation began listening). As in src/worker.js, a generation listens
// before it says ready.
//
// (It used to tail a shared file; on Windows an append to a file another
// process keeps reading could block the writer for ~10 s.)

const http = require('http');
const { createBus } = require('../../src/events/bus.ts');
const { stream } = require('../../src/dashboard/events.ts');

const GEN = process.env.PA_SUPERVISOR_GENERATION || '0';
const bus = createBus({ epoch: `gen${GEN}x${Date.now().toString(36)}` });

let listening = false;
const listened = new Promise((resolve) => {
  const feed = new URL(process.env.DEPLOY_FEED);
  http.get({ host: feed.hostname, port: feed.port, path: feed.pathname }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.baseline != null) {
          bus.setBaseline(String(e.baseline));
          listening = true;
          resolve();
        } else bus.publish(e.topic, { n: e.n, seq: e.seq }, { gid: e.seq });
      }
    });
  });
});

let ready = false;
let draining = false;
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return json(res, ready && !draining ? 200 : 503, { ready: ready && !draining, listening, commit: `gen-${GEN}` });
  if (url.pathname === '/api/version') return json(res, 200, { commit: `gen-${GEN}` });
  if (url.pathname === '/api/events') return stream(req, res, url, { bus, listen: () => {}, pingMs: 5000 });
  json(res, 404, { error: 'not found' });
});

process.on('message', (m) => {
  if (m && m.type === 'drain') draining = true;
  if (m && m.type === 'undrain') draining = false;
  if (m && m.type === 'stop') process.exit(0);
});
process.on('disconnect', () => process.exit(0));

server.listen(0, '127.0.0.1', async () => {
  process.send({ type: 'listening', port: server.address().port });
  await listened;
  setTimeout(() => (ready = true), Number(process.env.DEPLOY_READY_MS) || 300);
});
