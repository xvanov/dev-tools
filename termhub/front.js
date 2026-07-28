'use strict';

// termhub front — the SWAPPABLE tier.
//
// Serves the web UI (web/) and reverse-proxies everything else to sessiond:
//   - HTTP  /api/*        -> http://127.0.0.1:<sessiondPort>/api/*
//   - WS    /ws/term/:id  -> raw socket pipe to the same sessiond
//   - WS    /ws/voice     -> same, the voice-announcement feed
// It owns no terminals, so it can be restarted/replaced at will. Updates start a
// second front on the alternate loopback port, health-check it, then re-point
// Tailscale Serve at it — the browser reconnects through the new front to the
// SAME PTYs in sessiond and replays scrollback. Terminals survive.
//
//     node front.js       # listens on $TERMHUB_BIND:$TERMHUB_FRONT_PORT, proxies to sessiond

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { resolveBindAddress } = require('./lib/bind');
const { DEFAULT_FRONT_PORT, DEFAULT_SESSIOND_PORT, claimPidFile } = require('./lib/state');
const { checkForUpdate } = require('./lib/update');
const { probeJson } = require('./lib/probe');
const build = require('./lib/build');

const WEB_DIR = path.join(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\.\.+/g, ''); // basic traversal guard
  const file = path.join(WEB_DIR, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Ask sessiond if it's alive (used by /api/health and the updater's probe).
function pingSessiond(sessiondPort, timeoutMs = 2000) {
  return probeJson({ port: sessiondPort, path: '/api/ping', timeoutMs });
}

function createFront({ sessiondPort, port: serverPort = DEFAULT_FRONT_PORT }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    // Local health check — proves the front is up AND can reach sessiond. The
    // updater polls this on the green port before flipping Tailscale Serve.
    //
    // `self` carries the same identity block sessiond's /api/ping does, so one
    // request answers both "is green healthy?" and "is green actually the new
    // code, talking to the supervisor I think it is?". Present on the 503 path
    // too — a front that can't reach sessiond is exactly when you want to know
    // which front and which port it was looking at.
    if (req.method === 'GET' && pathname === '/api/health') {
      const self = {
        entry: 'front',
        pid: process.pid,
        port: serverPort,
        commit: build.commit(),
        dirty: build.dirty(),
        sessiondPort,
      };
      return pingSessiond(sessiondPort)
        .then((info) => sendJson(res, 200, { ok: true, front: true, self, sessiond: info }))
        .catch((e) => sendJson(res, 503, { ok: false, front: true, self, error: String(e.message || e) }));
    }

    // Update check is the front's own business (it owns the git checkout and is
    // the tier that gets swapped) — answer it here, don't proxy to sessiond.
    if (req.method === 'GET' && pathname === '/api/update/check') {
      const force = url.searchParams.get('force') === '1';
      return checkForUpdate({ force })
        .then((info) => sendJson(res, 200, info))
        .catch((e) => sendJson(res, 500, { available: false, error: String(e.message || e) }));
    }

    // Everything under /api/* is the supervisor's — proxy it.
    if (pathname.startsWith('/api/')) {
      const proxyReq = http.request(
        { host: '127.0.0.1', port: sessiondPort, method: req.method, path: req.url, headers: req.headers },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', (e) => sendJson(res, 502, { error: `sessiond unreachable: ${e.message}` }));
      return req.pipe(proxyReq);
    }

    return serveStatic(res, pathname);
  });

  // ---- WebSocket upgrade proxy ----------------------------------------------
  // Pipe the raw upgrade socket straight to sessiond, which owns the PTY and
  // does the actual WebSocket handshake. The front never parses WS frames.
  server.on('upgrade', (req, clientSocket, head) => {
    const url = new URL(req.url, 'http://localhost');
    // /ws/term/:id is a PTY stream; /ws/voice is the page-wide announcement feed.
    if (!/^\/ws\/(term\/[^/]+|voice)$/.test(url.pathname)) return clientSocket.destroy();

    const upstream = net.connect(sessiondPort, '127.0.0.1', () => {
      // Replay the request line + headers verbatim so sessiond's WebSocketServer
      // sees an ordinary upgrade request.
      let head1 = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        head1 += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(head1 + '\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return server;
}

// `claimPid` is opt-in and claimed inside the listen callback, for the same
// reason sessiond does it that way: winning the bind is what makes a process the
// front on that port, so a loser must not leave its pid behind — nor delete the
// incumbent's on the way out (see removeOwnPidFile in lib/state.js).
function startFront({ port = DEFAULT_FRONT_PORT, sessiondPort = DEFAULT_SESSIOND_PORT, host, claimPid = false } = {}) {
  const bindHost = host || resolveBindAddress();
  const server = createFront({ sessiondPort, port });
  build.commit(); // warm the cache off the request path
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[front] ${bindHost}:${port} is already in use — another front or a `
        + '`node server.js` owns it. Refusing to start a second front on this port.');
      process.exit(3);
    }
    throw err;
  });
  server.listen(port, bindHost, () => {
    if (claimPid) claimPidFile(`front-${port}`, port);
    console.log(`[front] listening on http://${bindHost}:${port} -> sessiond 127.0.0.1:${sessiondPort} `
      + `(pid ${process.pid}, ${build.shortCommit() || 'no commit'})`);
    if (bindHost === '127.0.0.1' && !process.env.TERMHUB_BIND) {
      console.log('[front] bound to loopback only — publish it with Tailscale Serve, or set TERMHUB_BIND.');
    }
  });
  return server;
}

module.exports = { createFront, startFront, pingSessiond };

// Run directly: claim the pid file and start.
if (require.main === module) {
  const port = DEFAULT_FRONT_PORT;
  const sessiondPort = DEFAULT_SESSIOND_PORT;
  startFront({ port, sessiondPort, claimPid: true });
}
