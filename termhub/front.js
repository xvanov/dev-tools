'use strict';

// termhub front — the SWAPPABLE tier.
//
// Serves the web UI (web/) and reverse-proxies everything else to sessiond:
//   - HTTP  /api/*        -> http://127.0.0.1:<sessiondPort>/api/*
//   - WS    /ws/term/:id  -> raw socket pipe to the same sessiond
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
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: sessiondPort, path: '/api/ping', timeout: timeoutMs }, (r) => {
      let raw = '';
      r.on('data', (c) => { raw += c; });
      r.on('end', () => {
        if (r.statusCode !== 200) return reject(new Error(`sessiond /api/ping -> ${r.statusCode}`));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('sessiond ping timeout')));
    req.on('error', reject);
  });
}

function createFront({ sessiondPort }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    // Local health check — proves the front is up AND can reach sessiond. The
    // updater polls this on the green port before flipping Tailscale Serve.
    if (req.method === 'GET' && pathname === '/api/health') {
      return pingSessiond(sessiondPort)
        .then((info) => sendJson(res, 200, { ok: true, front: true, sessiond: info }))
        .catch((e) => sendJson(res, 503, { ok: false, front: true, error: String(e.message || e) }));
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
    if (!/^\/ws\/term\/[^/]+$/.test(url.pathname)) return clientSocket.destroy();

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

function startFront({ port = DEFAULT_FRONT_PORT, sessiondPort = DEFAULT_SESSIOND_PORT, host } = {}) {
  const bindHost = host || resolveBindAddress();
  const server = createFront({ sessiondPort });
  server.listen(port, bindHost, () => {
    console.log(`[front] listening on http://${bindHost}:${port} -> sessiond 127.0.0.1:${sessiondPort}`);
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
  claimPidFile(`front-${port}`, port);
  startFront({ port, sessiondPort });
}
