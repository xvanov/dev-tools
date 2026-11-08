'use strict';

// POST /api/exec (lib/exec.js) and the guard in front of it (lib/requestGuard.js).
//
// What earns a test: argv is never handed to a shell; exit codes, stderr and
// stdin travel intact; the timeout kills the whole process group; output is
// capped; cwd must be a real absolute directory; and a browser cannot reach the
// route — not from another origin (CSRF), not through a rebound DNS name, not
// without the JSON content type and the X-Termhub header that force a preflight.
// It runs through the real front, so the wiring in front.js is covered too.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { handle: execHandle, parseSpec, runSpec, MAX_TIMEOUT_MS, MAX_CONCURRENT, BODY_TIMEOUT_MS } = require('../lib/exec.ts');
const { checkProgrammaticRequest, hostAllowed, hostnameOf, setLearnedNames, selfNamesFromStatus, learnSelfNames } = require('../lib/requestGuard.ts');
const { createFront } = require('../front.ts');

const node = process.execPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-exec-'));

// ---- the guard (pure) -------------------------------------------------------

assert.strictEqual(hostnameOf('127.0.0.1:7000'), '127.0.0.1');
assert.strictEqual(hostnameOf('[::1]:7000'), '::1');
assert.strictEqual(hostnameOf('Box.Tail1234.TS.NET:7000'), 'box.tail1234.ts.net');
const env = { TERMHUB_MACHINE: 'build-vm', TERMHUB_ALLOWED_HOSTS: 'termhub.lan' };
// This machine's own MagicDNS name, as `tailscale status --json` reports it
// (Self.DNSName, trailing dot and all). Set directly so no test spawns tailscale.
assert.deepStrictEqual([...selfNamesFromStatus({ Self: { DNSName: 'Build-VM.tail1234.ts.net.' } })], ['build-vm.tail1234.ts.net']);
assert.deepStrictEqual([...selfNamesFromStatus(null)], []);
assert.deepStrictEqual([...selfNamesFromStatus({ Self: {} })], []);
setLearnedNames(['build-vm.tail1234.ts.net.']);
for (const ok of ['127.0.0.1:7000', 'localhost:7000', '[::1]:7000', '100.101.102.103:7000', 'build-vm:7000',
  'build-vm.tail1234.ts.net', 'BUILD-VM.Tail1234.TS.NET:7443', 'build-vm.tail1234.ts.net.:7000',
  'termhub.lan:7000', 'TermHub.LAN', `${os.hostname()}:7000`]) {
  assert.ok(hostAllowed(ok, env), `allowed: ${ok}`);
}
// Regression: `*.ts.net` used to pass as a suffix. Only this machine's exact
// MagicDNS name may — not another machine, another tailnet, or a Funnel name.
for (const bad of ['evil.example:7000', 'build-vm.evil.example', '', 'ts.net.evil.example',
  'evil.tail9999.ts.net', 'other-box.tail1234.ts.net:7000', 'build-vm.tail9999.ts.net', 'x.build-vm.tail1234.ts.net',
  'ts.net', 'evil.termhub.lan', 'termhub.lan.evil.example']) {
  assert.ok(!hostAllowed(bad, env), `refused: ${bad}`);
}
assert.ok(!hostAllowed('box.tail1234.ts.net', {}), 'no wildcard even with nothing configured');

const good = { host: '127.0.0.1:7000', 'content-type': 'application/json', 'x-termhub': '1' };
const verdict = (headers) => checkProgrammaticRequest({ method: 'POST', headers }, { env });
assert.strictEqual(verdict(good), null);
assert.strictEqual(verdict({ ...good, 'content-type': 'application/json; charset=utf-8' }), null);
assert.strictEqual(verdict({ ...good, origin: 'http://127.0.0.1:7000' }), null, 'same origin is fine');
assert.strictEqual(verdict({ ...good, host: 'evil.example:7000' }).status, 403, 'DNS rebinding');
assert.strictEqual(verdict({ ...good, origin: 'https://evil.example' }).status, 403, 'CSRF from another origin');
assert.strictEqual(verdict({ ...good, origin: 'null' }).status, 403, 'sandboxed/opaque origin');
assert.strictEqual(verdict({ ...good, 'content-type': 'text/plain' }).status, 415, 'a simple (no-preflight) request');
assert.strictEqual(verdict({ host: good.host, 'content-type': 'application/json' }).status, 403, 'no X-Termhub');

// ---- the spec (pure) ----------------------------------------------------------

assert.match(parseSpec({}).error, /argv/);
assert.match(parseSpec({ argv: 'ls -la' }).error, /argv/, 'a string is not argv');
assert.match(parseSpec({ argv: ['ls', 3] }).error, /string/);
assert.match(parseSpec({ argv: [''] }).error, /program/);
assert.match(parseSpec({ argv: ['ls', 'a\0b'] }).error, /NUL/);
assert.match(parseSpec({ argv: ['ls'], cwd: 'relative/dir' }).error, /absolute/);
assert.match(parseSpec({ argv: ['ls'], timeoutMs: -1 }).error, /timeoutMs/);
assert.match(parseSpec({ argv: ['ls'], env: { 'BAD NAME': 'x' } }).error, /env/);
assert.match(parseSpec({ argv: ['ls'], stdin: 42 }).error, /stdin/);
{
  const s = parseSpec({ argv: ['ls'] }, { home: tmp });
  assert.strictEqual(s.cwd, tmp, 'cwd defaults to home');
  assert.strictEqual(s.timeoutMs, 60_000);
  assert.strictEqual(parseSpec({ argv: ['ls'], timeoutMs: 1e12 }).timeoutMs, MAX_TIMEOUT_MS, 'timeout is clamped');
}

// ---- through the real front -------------------------------------------------

function post(port, body, headers = {}, { host } = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/exec', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Termhub': '1', 'Content-Length': Buffer.byteLength(data),
        ...(host ? { Host: host } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  // learnSelfNames reads `tailscale status`; a failed read keeps the previous answer.
  await learnSelfNames({ readStatus: async () => ({ Self: { DNSName: 'learned-box.tail42.ts.net.' } }) });
  assert.ok(hostAllowed('learned-box.tail42.ts.net:7000', {}), 'the learned name passes');
  assert.ok(!hostAllowed('build-vm.tail1234.ts.net', {}), 'and replaces the old one');
  await learnSelfNames({ readStatus: async () => null });
  assert.ok(hostAllowed('learned-box.tail42.ts.net', {}), 'tailscale down: the last good name is kept');
  await learnSelfNames({ readStatus: async () => { throw new Error('boom'); } });
  assert.ok(hostAllowed('learned-box.tail42.ts.net', {}), 'and a throwing read changes nothing');
  setLearnedNames(['build-vm.tail1234.ts.net']);

  // sessiond is never consulted for /api/exec: point the front at a dead port.
  const server = createFront({ sessiondPort: 1, port: 0, paUrl: '' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // argv reaches the program verbatim — no shell, no globbing, no expansion.
    const tricky = ['$HOME', '*', '; rm -rf /', '"quoted" \'single\'', '`id`', 'a b'];
    const echo = await post(port, { argv: [node, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky], cwd: tmp });
    assert.strictEqual(echo.status, 200);
    assert.deepStrictEqual(JSON.parse(echo.json.stdout), tricky);
    assert.strictEqual(echo.json.code, 0);

    // exit code, stderr, cwd, stdin and env all travel.
    const r = await post(port, {
      argv: [node, '-e', 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(process.cwd()+"|"+s+"|"+process.env.EXEC_T);process.stderr.write("oops");process.exit(3)})'],
      cwd: tmp, stdin: 'ünï\nline', env: { EXEC_T: 'yes' },
    });
    assert.strictEqual(r.json.code, 3);
    assert.strictEqual(r.json.stdout, `${fs.realpathSync(tmp)}|ünï\nline|yes`);
    assert.strictEqual(r.json.stderr, 'oops');
    assert.strictEqual(r.json.timedOut, false);

    // A program that does not exist is an error, not a crash.
    const missing = await post(port, { argv: ['definitely-not-a-program-xyz'], cwd: tmp });
    assert.strictEqual(missing.status, 200);
    assert.strictEqual(missing.json.code, null);
    assert.match(missing.json.error, /ENOENT/);

    // cwd that is not a directory.
    const badCwd = await post(port, { argv: [node, '-e', ''], cwd: path.join(tmp, 'nope') });
    assert.match(badCwd.json.error, /not a directory/);

    // Output is capped and says so.
    const big = await post(port, { argv: [node, '-e', 'process.stdout.write("x".repeat(50000))'], cwd: tmp, maxOutputBytes: 1000 });
    assert.strictEqual(big.json.stdout.length, 1000);
    assert.strictEqual(big.json.truncated.stdout, true);
    assert.strictEqual(big.json.code, 0, 'draining past the cap does not wedge the child');

    // The timeout kills the group: a grandchild must not survive it.
    if (process.platform !== 'win32') {
      const pidFile = path.join(tmp, 'grandchild.pid');
      const t0 = Date.now();
      const slow = await post(port, {
        argv: [node, '-e', `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`],
        cwd: tmp, timeoutMs: 800,
      });
      assert.strictEqual(slow.json.timedOut, true);
      assert.strictEqual(slow.json.code, null);
      assert.ok(Date.now() - t0 < 5000, 'answered promptly after the deadline');
      const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
      await new Promise((res) => setTimeout(res, 200));
      let alive = true;
      try { process.kill(gpid, 0); } catch { alive = false; }
      assert.ok(!alive, 'the grandchild died with the group');
    }

    // ---- refusals, through the front ----
    assert.strictEqual((await post(port, { argv: ['ls'] }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.strictEqual((await post(port, { argv: ['ls'] }, { 'X-Termhub': '' })).status, 403);
    assert.strictEqual((await post(port, { argv: ['ls'] }, { Origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await post(port, { argv: ['ls'] }, {}, { host: 'evil.example:7000' })).status, 403);
    assert.strictEqual((await post(port, 'not json')).status, 400);
    assert.strictEqual((await post(port, { argv: 'ls -la' })).status, 400);
    const opts = await new Promise((resolve) => {
      http.request({ host: '127.0.0.1', port, path: '/api/exec', method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } }, (res) => {
        res.resume();
        resolve(res);
      }).end();
    });
    assert.strictEqual(opts.statusCode, 405, 'a preflight is not answered');
    assert.ok(!opts.headers['access-control-allow-origin'], 'and carries no CORS grant');

    // ---- the body is read before a concurrency slot is taken ----
    //
    // Regression: the slot used to be taken BEFORE the body was read, so
    // MAX_CONCURRENT requests that never finish their body locked /api/exec
    // for everyone (429) for as long as they cared to hold the sockets.
    assert.strictEqual(BODY_TIMEOUT_MS, 10_000, 'default body deadline');
    const sendJsonT = (res, status, body) => {
      if (res.headersSent) return res.destroy();
      const data = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
      res.end(data);
    };
    const slowServer = http.createServer((req, res) => {
      execHandle(req, res, new URL(req.url, 'http://x'), { sendJson: sendJsonT, env: {}, home: tmp, bodyTimeoutMs: 400 });
    });
    await new Promise((r) => slowServer.listen(0, '127.0.0.1', r));
    const sPort = slowServer.address().port;
    // Opens a request, sends part of a body, never ends it. Resolves its outcome.
    const stall = (extra = {}) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: sPort, path: '/api/exec', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Termhub': '1', ...extra } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
      });
      req.on('error', (e) => resolve({ error: e.code }));
      req.write('{"argv":');
      req.flushHeaders();
    });
    try {
      const t0 = Date.now();
      const stalled = Array.from({ length: MAX_CONCURRENT + 2 }, () => stall());
      await new Promise((r) => setTimeout(r, 100));
      const through = await post(sPort, { argv: [node, '-e', 'process.stdout.write("ran")'], cwd: tmp });
      assert.strictEqual(through.status, 200, `stalled bodies hold no slot: ${JSON.stringify(through.json)}`);
      assert.strictEqual(through.json.stdout, 'ran');
      const outcomes = await Promise.all(stalled);
      for (const o of outcomes) {
        assert.strictEqual(o.status, 408, `a body that never ends gets 408: ${JSON.stringify(o)}`);
        assert.strictEqual(o.headers.connection, 'close');
      }
      assert.ok(Date.now() - t0 < 3000, 'and promptly, at the deadline');

      // A chunked body (no Content-Length) over the cap: 413 as soon as it crosses it.
      const huge = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: sPort, path: '/api/exec', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Termhub': '1' } }, (res) => { res.resume(); resolve(res.statusCode); });
        // The front cuts the connection while the client is still writing: on Windows that is a TCP reset
        // that can eat the 413 on its way, so a reset counts as refused. Never hang on it.
        req.on('error', (e) => resolve(e.code || 'error'));
        setTimeout(() => resolve('no answer in 5 s'), 5000).unref();
        req.write('{"argv":["x"],"stdin":"');
        req.write('x'.repeat(5 * 1024 * 1024));
      });
      assert.ok(huge === 413 || huge === 'ECONNRESET' || huge === 'EPIPE', `a body over the cap is refused, got ${huge}`);

      // The slot limit itself still holds for real runs: MAX_CONCURRENT
      // sleepers in flight, the next one is refused.
      const sleepers = Array.from({ length: MAX_CONCURRENT },
        () => post(sPort, { argv: [node, '-e', 'setTimeout(()=>{},1500)'], cwd: tmp }));
      await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual((await post(sPort, { argv: [node, '-e', ''], cwd: tmp })).status, 429, 'the cap still applies to runs');
      for (const r of await Promise.all(sleepers)) assert.strictEqual(r.status, 200);
      assert.strictEqual((await post(sPort, { argv: [node, '-e', ''], cwd: tmp })).status, 200, 'and slots come back');
    } finally {
      slowServer.close();
      slowServer.closeAllConnections?.();
    }

    console.log('exec.test.js ok');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); // a just-exited child can still hold its cwd
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
