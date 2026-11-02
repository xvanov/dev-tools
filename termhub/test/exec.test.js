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
const { parseSpec, runSpec, MAX_TIMEOUT_MS } = require('../lib/exec');
const { checkProgrammaticRequest, hostAllowed, hostnameOf } = require('../lib/requestGuard');
const { createFront } = require('../front');

const node = process.execPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-exec-'));

// ---- the guard (pure) -------------------------------------------------------

assert.strictEqual(hostnameOf('127.0.0.1:7000'), '127.0.0.1');
assert.strictEqual(hostnameOf('[::1]:7000'), '::1');
assert.strictEqual(hostnameOf('Box.Tail1234.TS.NET:7000'), 'box.tail1234.ts.net');
const env = { TERMHUB_MACHINE: 'build-vm', TERMHUB_ALLOWED_HOSTS: 'termhub.lan' };
for (const ok of ['127.0.0.1:7000', 'localhost:7000', '[::1]:7000', '100.101.102.103:7000', 'build-vm:7000',
  'build-vm.tail1234.ts.net', 'termhub.lan:7000', `${os.hostname()}:7000`]) {
  assert.ok(hostAllowed(ok, env), `allowed: ${ok}`);
}
for (const bad of ['evil.example:7000', 'build-vm.evil.example', '', 'ts.net.evil.example']) {
  assert.ok(!hostAllowed(bad, env), `refused: ${bad}`);
}

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

    console.log('exec.test.js ok');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
