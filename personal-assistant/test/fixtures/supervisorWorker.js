'use strict';

// A stand-in worker for test/supervisor.test.js: it speaks the supervisor's
// protocol (src/supervisor) like src/worker.js does, without Postgres.
//   DUMMY_DIR/fail-next present → it is removed and this generation dies
//   before it gets ready (a broken build).
//   SUPERVISOR_TEST_LIFELINE=<port> → it holds a socket to the test from
//   before it listens; the socket's close is this process's exit (a pid
//   cannot say that on Windows, which reuses one within seconds).

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');

const GEN = process.env.PA_SUPERVISOR_GENERATION;
let lifeline = null;
if (process.env.SUPERVISOR_TEST_LIFELINE) {
  lifeline = net.connect(Number(process.env.SUPERVISOR_TEST_LIFELINE), '127.0.0.1');
  lifeline.on('error', () => {});
  lifeline.write(`${process.pid}\n`);
}
const dir = process.env.DUMMY_DIR;
const failFlag = path.join(dir, 'fail-next');
if (fs.existsSync(failFlag)) {
  fs.rmSync(failFlag, { force: true });
  setTimeout(() => process.exit(3), 100);
  return;
}

let ready = false;
let draining = false;
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return json(res, ready && !draining ? 200 : 503, { ready: ready && !draining });
  if (url.pathname === '/api/version') return json(res, 200, { commit: `gen-${GEN}`, pid: process.pid });
  if (url.pathname.startsWith('/api/slow')) return setTimeout(() => json(res, 200, { commit: `gen-${GEN}` }), Number(url.searchParams.get('ms')) || 100);
  if (url.pathname === '/api/echo' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => json(res, 200, { commit: `gen-${GEN}`, body }));
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write(`event: hello\ndata: ${JSON.stringify({ gen: GEN, lastEventId: req.headers['last-event-id'] || null })}\n\n`);
    let k = 0;
    const t = setInterval(() => res.write(`id: ${GEN}-${++k}\ndata: ${JSON.stringify({ gen: GEN, k })}\n\n`), 30);
    return req.on('close', () => clearInterval(t));
  }
  json(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`gen-${GEN}:${m}`)));
});

process.on('message', (m) => {
  if (m && m.type === 'drain') draining = true;
  if (m && m.type === 'undrain') draining = false;
  if (m && m.type === 'stop') process.exit(0);
});
process.on('disconnect', () => process.exit(0));

// A short idle timeout makes the supervisor reuse sockets this side just closed.
if (process.env.KEEPALIVE_MS) server.keepAliveTimeout = Number(process.env.KEEPALIVE_MS);

const listen = () =>
  server.listen(0, '127.0.0.1', () => {
    process.send({ type: 'listening', port: server.address().port });
    setTimeout(() => (ready = true), 300);
  });
if (lifeline) lifeline.once('connect', listen);
else listen();
