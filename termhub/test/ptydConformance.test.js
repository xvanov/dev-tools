'use strict';

// Protocol conformance: ONE black-box suite, run against ptyd and against
// sessiond with its PTYs in ptyd (the only host; the in-process node-pty leg
// was retired in Exit 5). Every case speaks only HTTP and WebSocket to a target
// on a free loopback port; nothing in here knows which implementation it is
// talking to except the `entry` it reports.
//
// What is covered (the session protocol): ping identity, info features, the
// request guard (X-Termhub, simple Content-Types, Host, Origin, websocket
// Origin), session create/list/patch/delete, env spec (env/unsetEnv) and noRc,
// links metadata (E1: cleaned on create, merged and removed by PATCH), the
// initial command run inside the shell, TERMHUB_SESSION_ID, the cwd fallback,
// HTTP input (submit and staged), the terminal stream (replay first, then
// output; input; resize as a size claim seen by every client; the owner leaving
// frees the size), busy/idle activity, exit (message, alive, exitCode) and kill.
// Not covered: sessiond-only features ptyd does not host (voice, idle episodes,
// uploads, the archive and restore); with TERMHUB_PTYD=1 sessiond keeps doing
// those itself on top of ptyd.
//
// ptyd leg: needs a built binary. PTYD_BIN, else ../ptyd/target/{release,debug}.
// Without one this leg SKIPs with a note, unless PTYD_REQUIRED=1 (CI's ptyd job),
// which turns a missing binary into a failure. CONFORMANCE_TARGETS=ptyd (or
// sessiond+ptyd) runs one leg only. `sessiond` alone was the node-pty leg and
// is refused.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const spare = require('./spareTermhub');

const { freePort, getJson } = spare;
// CONFORMANCE_TRACE=1 prints how long every wait took: where a slow leg spends it.
async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  await spare.waitFor(fn, timeoutMs, what);
  if (process.env.CONFORMANCE_TRACE === '1') console.log(`       ${Date.now() - t0} ms  ${String(what).slice(0, 40)}`);
}

const ROOT = path.join(__dirname, '..');
const EXE = process.platform === 'win32' ? 'ptyd.exe' : 'ptyd';

function findPtyd() {
  if (process.env.PTYD_BIN) return fs.existsSync(process.env.PTYD_BIN) ? process.env.PTYD_BIN : null;
  for (const profile of ['release', 'local', 'debug']) {
    const p = path.join(ROOT, '..', 'ptyd', 'target', profile, EXE);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function launch(argv0, args, env) {
  const child = spawn(argv0, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  child.output = () => out;
  child.exited = new Promise((r) => child.once('exit', r));
  return child;
}

// The environment both targets run in: a marker to unset, a temp data dir so
// sessiond's archive/idle files stay out of the real one, and no rc files for
// the shell (fast, and identical between the two).
function targetEnv(dir) {
  const env = { ...process.env, TERMHUB_DATA_DIR: dir, CONF_UNSET_ME: 'present', CONF_KEEP_ME: 'kept' };
  delete env.TERMHUB_BIND;
  delete env.TERMHUB_PTYD;
  return env;
}

async function startSessiond(dir, extraEnv = {}) {
  const port = await freePort();
  const child = launch(process.execPath,
    ['-e', `require('./sessiond').startSessiond({ port: ${port}, entry: 'sessiond' })`], { ...targetEnv(dir), ...extraEnv });
  await waitFor(async () => (await getJson(port, '/api/ping')).status === 200, 20_000, 'sessiond');
  return { name: 'sessiond', entry: 'sessiond', port, child, stop: async () => { child.kill(); await child.exited; } };
}

async function startPtyd(dir, bin) {
  const child = launch(bin, ['--port', '0'], targetEnv(dir));
  let port = null;
  await waitFor(() => {
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(child.output());
    if (m) port = Number(m[1]);
    return !!port;
  }, 20_000, `ptyd to listen (output: ${child.output().slice(0, 300)})`);
  await waitFor(async () => (await getJson(port, '/api/ping')).status === 200, 10_000, 'ptyd ping');
  return { name: 'ptyd', entry: 'ptyd', port, child, stop: async () => { child.kill(); await child.exited; } };
}

// sessiond with TERMHUB_PTYD=1: the Node tier serving the protocol, its PTYs in
// a ptyd beside it. The cutover configuration, held to the same suite.
async function startSessiondOnPtyd(dir, bin) {
  const pd = await startPtyd(dir, bin);
  const sd = await startSessiond(dir, { TERMHUB_PTYD: '1', TERMHUB_PTYD_PORT: String(pd.port), TERMHUB_PTYD_BIN: bin });
  const ping = await getJson(sd.port, '/api/ping');
  assert.strictEqual(ping.body.ptyHost, 'ptyd');
  return { ...sd, name: 'sessiond+ptyd', stop: async () => { await sd.stop(); await pd.stop(); } };
}

module.exports = { findPtyd, startPtyd, startSessiond, strip, term, nodePrint };

// ---- protocol helpers --------------------------------------------------------

function strip(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>78DEHMc]/g, '')
    .replace(/\r/g, '');
}

/** A terminal client: every message, plus the text of replay + output. */
function term(port, id, { origin } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${encodeURIComponent(id)}`, origin ? { origin } : {});
  const t = { ws, msgs: [], text: '', closed: false };
  t.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
  });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    t.msgs.push(m);
    if ((m.type === 'replay' || m.type === 'output') && typeof m.data === 'string') t.text += m.data;
  });
  ws.on('close', () => (t.closed = true));
  ws.on('error', () => {});
  t.plain = () => strip(t.text);
  t.send = (m) => ws.send(JSON.stringify(m));
  t.of = (type) => t.msgs.filter((m) => m.type === type);
  t.close = () => new Promise((r) => {
    if (ws.readyState === WebSocket.CLOSED) return r();
    ws.once('close', r);
    ws.close();
  });
  return t;
}

// A line whose OUTPUT can be told apart from its echo: the shell echoes the
// typed `'A'+'B'`, only node prints `AB`. Works in bash, sh, pwsh and cmd.
function nodePrint(expr) {
  return `node -e "console.log(${expr})"`;
}

function rawRequest(port, p, { method = 'GET', headers = {}, body } = {}) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, text: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---- the suite ----------------------------------------------------------------

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('ping carries identity', async ({ port, entry }) => {
  const r = await getJson(port, '/api/ping');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(typeof r.body.pid, 'number');
  assert.strictEqual(r.body.port, port);
  assert.strictEqual(r.body.entry, entry);
  assert.strictEqual(typeof r.body.sessions, 'number');
  assert.strictEqual(typeof r.body.startedAt, 'number');
  assert.ok(r.body.machine);
});

test('info reports platform and session features', async ({ port }) => {
  const r = await getJson(port, '/api/info');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.platform, process.platform);
  assert.ok(r.body.home && r.body.machine);
  for (const f of ['session-env', 'session-norc', 'session-links']) assert.ok(r.body.features.includes(f), `feature ${f}`);
});

test('request guard', async ({ port }) => {
  const noHeader = await rawRequest(port, '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.strictEqual(noHeader.status, 403);
  assert.match(noHeader.text, /X-Termhub/);
  const plain = await rawRequest(port, '/api/sessions', { method: 'POST', headers: { 'x-termhub': '1', 'content-type': 'text/plain' }, body: '{}' });
  assert.strictEqual(plain.status, 415);
  const rebound = await rawRequest(port, '/api/sessions', { headers: { host: 'evil.example' } });
  assert.strictEqual(rebound.status, 403);
  const xorigin = await rawRequest(port, '/api/sessions', { headers: { origin: 'http://evil.example' } });
  assert.strictEqual(xorigin.status, 403);
  const same = await rawRequest(port, '/api/sessions', { headers: { origin: `http://127.0.0.1:${port}` } });
  assert.strictEqual(same.status, 200);
  const unknown = await getJson(port, '/api/nope');
  assert.strictEqual(unknown.status, 404);
});

test('create validates env, noRc', async ({ port }) => {
  const badEnv = await getJson(port, '/api/sessions', { method: 'POST', body: { env: { '1BAD': 'x' } } });
  assert.strictEqual(badEnv.status, 400);
  assert.match(badEnv.body.error, /bad variable name/);
  const badUnset = await getJson(port, '/api/sessions', { method: 'POST', body: { unsetEnv: 'X' } });
  assert.strictEqual(badUnset.status, 400);
  const badRc = await getJson(port, '/api/sessions', { method: 'POST', body: { noRc: 'yes' } });
  assert.strictEqual(badRc.status, 400);
  assert.strictEqual(badRc.body.error, 'noRc must be a boolean');
  const badJson = await rawRequest(port, '/api/sessions', { method: 'POST', headers: { 'x-termhub': '1', 'content-type': 'application/json' }, body: '{nope' });
  assert.strictEqual(badJson.status, 400);
});

test('a session: create, env, command, stream, input, resize, patch, exit', async ({ port, dir }) => {
  const created = await getJson(port, '/api/sessions', {
    method: 'POST',
    timeoutMs: 15_000,
    body: {
      cwd: dir, title: 'conformance', cols: 100, rows: 30, noRc: true,
      env: { CONF_SET: 'set-value' }, unsetEnv: ['CONF_UNSET_ME'],
      links: { card: 42, job: 'app:dir', bogus: 'x', step: 'not ok!' },
      command: nodePrint(`'CMD'+'RAN:'+process.env.TERMHUB_SESSION_ID`),
    },
  });
  assert.strictEqual(created.status, 201, created.text);
  const s = created.body;
  assert.ok(s.id);
  assert.strictEqual(s.alive, true);
  assert.strictEqual(s.title, 'conformance');
  assert.strictEqual(s.cols, 100);
  assert.strictEqual(s.rows, 30);
  assert.strictEqual(s.kind, 'shell');
  assert.strictEqual(path.resolve(s.cwd), path.resolve(dir));
  assert.strictEqual(s.envApplied, true);
  assert.strictEqual(typeof s.rcSkipped, 'boolean');
  assert.deepStrictEqual(s.links, { card: '42', job: 'app:dir' });
  for (const k of ['shell', 'created', 'exitCode', 'busy', 'paused', 'command']) assert.ok(k in s, `info has ${k}`);

  const listed = await getJson(port, '/api/sessions');
  assert.strictEqual(listed.status, 200);
  assert.ok(Array.isArray(listed.body.restorable));
  const mine = listed.body.sessions.find((x) => x.id === s.id);
  assert.ok(mine, 'listed');
  assert.deepStrictEqual(mine.links, { card: '42', job: 'app:dir' });

  const a = term(port, s.id);
  await a.opened;
  // The initial command ran inside the shell, with the session's own id.
  await waitFor(() => a.plain().includes(`CMDRAN:${s.id}`), 40_000, `the initial command (saw: ${JSON.stringify(a.plain().slice(-300))})`);
  const first = a.msgs[0];
  assert.strictEqual(first.type, 'replay', 'replay comes first');
  assert.strictEqual(first.cols, 100);
  assert.strictEqual(first.rows, 30);
  assert.ok(first.you, 'replay names the client');
  assert.ok('owner' in first && 'screen' in first);

  // Env spec reached the PTY: set, removed, the rest inherited.
  a.send({ type: 'input', data: nodePrint(`'ENV'+'='+[process.env.CONF_SET,process.env.CONF_UNSET_ME||'gone',process.env.CONF_KEEP_ME].join(',')`) + '\r' });
  await waitFor(() => a.plain().includes('ENV=set-value,gone,kept'), 15_000, { toString: () => `env output (saw: ${JSON.stringify(a.plain().slice(-400))})` });

  // HTTP input: submitted, then staged (no return pressed).
  const bad = await getJson(port, `/api/sessions/${s.id}/input`, { method: 'POST', body: { data: 5 } });
  assert.strictEqual(bad.status, 400);
  const none = await getJson(port, '/api/sessions/nope/input', { method: 'POST', body: { data: 'x' } });
  assert.strictEqual(none.status, 404);
  const sent = await getJson(port, `/api/sessions/${s.id}/input`, { method: 'POST', body: { data: nodePrint(`'HT'+'TP'`) } });
  assert.strictEqual(sent.status, 200);
  assert.strictEqual(sent.body.ok, true);
  assert.strictEqual(sent.body.bytes, Buffer.byteLength(nodePrint(`'HT'+'TP'`)));
  await waitFor(() => a.plain().includes('HTTP'), 15_000, 'http input output');
  const staged = await getJson(port, `/api/sessions/${s.id}/input`, { method: 'POST', body: { data: nodePrint(`'STA'+'GED'`), submit: false } });
  assert.strictEqual(staged.status, 200);
  await waitFor(() => a.plain().includes(`'STA'`), 10_000, 'staged text echoed');
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(!a.plain().includes('STAGED'), 'staged input was executed');
  a.send({ type: 'input', data: '\x03' }); // abandon the staged line
  await new Promise((r) => setTimeout(r, 300));

  // Replay: a second client gets what the first saw so far, then live output.
  const b = term(port, s.id);
  await b.opened;
  await waitFor(() => b.msgs.length > 0, 5000, 'replay to the second client');
  assert.strictEqual(b.msgs[0].type, 'replay');
  assert.ok(strip(b.msgs[0].data).includes('CMDRAN'), 'replay holds earlier output');
  assert.notStrictEqual(b.msgs[0].you, first.you, 'clients have distinct ids');

  // Resize is a size claim every client hears about.
  a.send({ type: 'resize', cols: 90, rows: 25 });
  await waitFor(() => b.of('size').some((m) => m.cols === 90 && m.rows === 25 && m.owner === first.you), 5000, 'size to the other client');
  await waitFor(() => a.of('size').some((m) => m.owner === first.you), 5000, 'size back to the claimant');
  const resized = (await getJson(port, '/api/sessions')).body.sessions.find((x) => x.id === s.id);
  assert.strictEqual(resized.cols, 90);
  assert.strictEqual(resized.rows, 25);
  // The owner leaving frees the size.
  await a.close();
  await waitFor(() => b.of('size').some((m) => m.owner === null), 5000, 'owner released on detach');

  // Activity: output makes it busy; quiet makes it not.
  b.send({ type: 'input', data: nodePrint(`'BU'+'SY'`) + '\r' });
  await waitFor(async () => (await getJson(port, '/api/sessions')).body.sessions.find((x) => x.id === s.id).busy === true, 10_000, 'busy');
  await waitFor(async () => (await getJson(port, '/api/sessions')).body.sessions.find((x) => x.id === s.id).busy === false, 15_000, 'idle again');

  // PATCH: title, links merge/remove, paused.
  const p1 = await getJson(port, `/api/sessions/${s.id}`, { method: 'PATCH', body: { title: 'renamed', links: { card: null, pr: 'https://github.com/o/r/pull/7' }, paused: true } });
  assert.strictEqual(p1.status, 200);
  assert.strictEqual(p1.body.title, 'renamed');
  assert.deepStrictEqual(p1.body.links, { job: 'app:dir', pr: 'https://github.com/o/r/pull/7' });
  assert.strictEqual(p1.body.paused, true);
  const p2 = await getJson(port, `/api/sessions/${s.id}`, { method: 'PATCH', body: { title: '   ', paused: false } });
  assert.strictEqual(p2.body.title, 'renamed', 'blank title ignored');
  assert.strictEqual(p2.body.paused, false);
  const p404 = await getJson(port, '/api/sessions/nope', { method: 'PATCH', body: { title: 'x' } });
  assert.strictEqual(p404.status, 404);

  // Exit: the shell ends, every client hears it, the list says so.
  b.send({ type: 'input', data: 'exit\r' });
  await waitFor(() => b.of('exit').length > 0, 15_000, 'exit message');
  await waitFor(async () => {
    const x = (await getJson(port, '/api/sessions')).body.sessions.find((y) => y.id === s.id);
    return x && x.alive === false;
  }, 10_000, 'alive false');
  const ended = (await getJson(port, '/api/sessions')).body.sessions.find((y) => y.id === s.id);
  assert.strictEqual(ended.busy, false);
  assert.ok(ended.exitCode === null || typeof ended.exitCode === 'number');
  // A client attaching to an exited session gets the replay, then the exit.
  const c = term(port, s.id);
  await c.opened;
  await waitFor(() => c.of('exit').length > 0, 5000, 'exit on late attach');
  assert.strictEqual(c.msgs[0].type, 'replay');
  await Promise.all([b.close(), c.close()]);

  const del = await getJson(port, `/api/sessions/${s.id}`, { method: 'DELETE', timeoutMs: 15_000 });
  assert.strictEqual(del.status, 200);
  assert.ok(!(await getJson(port, '/api/sessions')).body.sessions.some((x) => x.id === s.id), 'deleted');
});

test('cwd fallback, kill, idempotent delete, websocket refusals', async ({ port }) => {
  const missing = path.join(os.tmpdir(), `ptyd-conf-missing-${process.pid}`);
  const r = await getJson(port, '/api/sessions', { method: 'POST', timeoutMs: 15_000, body: { cwd: missing, noRc: true, command: nodePrint(`'LONG'+'RUN'`) + '; node -e "setTimeout(()=>{},60000)"' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(path.resolve(r.body.cwd), path.resolve(os.homedir()));
  const t = term(port, r.body.id);
  await t.opened;
  await waitFor(() => /not found/.test(t.plain()), 10_000, 'cwd fallback notice');

  // Upgrades: a foreign Origin and an unknown session are both refused.
  const foreign = term(port, r.body.id, { origin: 'http://evil.example' });
  await assert.rejects(foreign.opened);
  const ghost = term(port, 'no-such-session');
  await assert.rejects(ghost.opened);

  const del = await getJson(port, `/api/sessions/${r.body.id}`, { method: 'DELETE', timeoutMs: 15_000 });
  assert.strictEqual(del.status, 200);
  assert.deepStrictEqual(del.body, { ok: true });
  await waitFor(() => t.of('exit').length > 0 || t.closed, 10_000, 'killed session ends its stream');
  const again = await getJson(port, `/api/sessions/${r.body.id}`, { method: 'DELETE' });
  assert.strictEqual(again.status, 200, 'delete is idempotent');
  await t.close();
});

// ---- runner -----------------------------------------------------------------

async function runAgainst(target) {
  let failed = 0;
  for (const c of cases) {
    const t0 = Date.now();
    try {
      await c.fn(target);
      console.log(`  ok   ${target.name}: ${c.name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${target.name}: ${c.name}\n${String(e && e.stack || e).split('\n').map((l) => '       ' + l).join('\n')}`);
    }
  }
  return failed;
}

/** null when the ptyd legs may run; else why not (a SKIP, or a failure under PTYD_REQUIRED=1). */
function ptydMissing(bin) {
  if (bin) return null;
  const why = 'no ptyd binary (cargo build in ptyd/, or set PTYD_BIN)';
  if (process.env.PTYD_REQUIRED === '1') throw new Error(`PTYD_REQUIRED=1 but ${why}`);
  return why;
}

async function main() {
  const want = (process.env.CONFORMANCE_TARGETS || 'ptyd,sessiond+ptyd').split(',').map((s) => s.trim());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-conf-'));
  const bin = findPtyd();
  const starters = {
    sessiond: () => { throw new Error('the node-pty sessiond leg was retired (Exit 5); use ptyd or sessiond+ptyd'); },
    ptyd: (d) => startPtyd(d, bin),
    'sessiond+ptyd': (d) => startSessiondOnPtyd(d, bin),
  };
  let failed = 0;
  const summary = [];
  try {
    for (const name of want) {
      if (!starters[name]) throw new Error(`unknown target ${name}`);
      const missing = ptydMissing(bin);
      if (missing) {
        console.log(`SKIP ${name} leg: ${missing}`);
        summary.push(`${name} skipped`);
        continue;
      }
      const t = await starters[name](fs.mkdtempSync(path.join(dir, 'srv-')));
      t.dir = fs.mkdtempSync(path.join(dir, 'cwd-'));
      try {
        const f = await runAgainst(t);
        failed += f;
        summary.push(`${name} ${cases.length - f}/${cases.length}`);
      } finally {
        await t.stop();
      }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a shell may still hold a cwd on Windows */ }
  }
  console.log(`ptydConformance: ${summary.join(', ')}`);
  return failed;
}

if (require.main === module) {
  main().then((failed) => process.exit(failed ? 1 : 0), (err) => {
    console.error(err);
    process.exit(1);
  });
}
