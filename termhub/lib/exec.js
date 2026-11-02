'use strict';

// Run one command on this machine and return its output and exit code:
//
//   POST /api/exec  {argv, cwd?, timeoutMs?, maxOutputBytes?, stdin?, env?}
//     -> 200 {code, signal, stdout, stderr, timedOut, truncated, durationMs, error?}
//
// Until this existed, the only way to make a machine do something through
// termhub was to open a session and *type* at a shell — and then guess, from
// a screen, whether it worked. The personal assistant sets dispatched runs up
// on other machines this way (personal-assistant/src/dispatch/remote.js), and
// a typed `git worktree add` that failed looked exactly like one still running.
//
// It adds no capability: anyone who can reach termhub can open a shell and run
// the same thing (AGENT.md, *Security notes*). It is guarded like a route that
// starts processes should be anyway — lib/requestGuard.js keeps browsers on
// other origins and rebound DNS names out — and it is bounded:
//
//   - argv is an ARRAY and is never given to a shell (`shell: false`). Nothing
//     in it is interpolated, globbed or split. A caller that wants a shell
//     names one in argv[0] and owns the quoting.
//   - cwd must be an absolute path to an existing directory (default: home).
//   - timeoutMs defaults to 60 s and is clamped to 30 min. On expiry the whole
//     process group is killed (POSIX: a negative-pid SIGKILL on a detached
//     child; Windows: `taskkill /T /F`), so a `git` waiting on an `ssh` child
//     does not outlive its deadline.
//   - stdout and stderr are each capped (default 1 MB, at most 16 MB): past the
//     cap the stream is drained and dropped, and `truncated` says so.
//   - the body is capped (MAX_BODY_BYTES -> 413) and must arrive within
//     BODY_TIMEOUT_MS (-> 408, connection closed).
//   - at most MAX_CONCURRENT runs at once; the next gets 429. A slot is taken
//     only once the body is fully read and valid, so a client that opens a
//     request and trickles (or never finishes) its body cannot hold one.
//   - the client hanging up kills the run.
//
// Served by the FRONT, for the reason lib/transcripts.js is: an update swaps
// the front and never restarts sessiond, so a sessiond route would reach a
// machine only once every terminal there had been killed. Nothing here needs
// to outlive a front — a run is bounded and its caller is waiting on the
// response — so the persistent tier has no claim on it.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkProgrammaticRequest } = require('./requestGuard');

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // argv + stdin, as JSON
const MAX_ARGS = 1024;
const MAX_CONCURRENT = 8;
const BODY_TIMEOUT_MS = 10_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

let running = 0;
const live = new Set();

/**
 * Pure: the request body → a validated spec, or {error}. Exported for tests.
 */
function parseSpec(body, { home = os.homedir() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const { argv } = body;
  if (!Array.isArray(argv) || !argv.length) return { error: 'argv must be a non-empty array of strings' };
  if (argv.length > MAX_ARGS) return { error: `argv has more than ${MAX_ARGS} entries` };
  if (!argv.every((a) => typeof a === 'string')) return { error: 'every argv entry must be a string' };
  if (!argv[0]) return { error: 'argv[0] must name a program' };
  if (argv.some((a) => a.includes('\0'))) return { error: 'argv may not contain NUL' };

  let cwd = home;
  if (body.cwd != null && body.cwd !== '') {
    if (typeof body.cwd !== 'string' || !path.isAbsolute(body.cwd)) return { error: 'cwd must be an absolute path' };
    cwd = body.cwd;
  }

  const num = (v, dflt, max, name) => {
    if (v == null) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return { error: `${name} must be a positive number` };
    return Math.min(Math.floor(n), max);
  };
  const timeoutMs = num(body.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs');
  if (timeoutMs.error) return timeoutMs;
  const maxOutputBytes = num(body.maxOutputBytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES, 'maxOutputBytes');
  if (maxOutputBytes.error) return maxOutputBytes;

  if (body.stdin != null && typeof body.stdin !== 'string') return { error: 'stdin must be a string' };

  let env = null;
  if (body.env != null) {
    if (typeof body.env !== 'object' || Array.isArray(body.env)) return { error: 'env must be an object of strings' };
    env = {};
    for (const [k, v] of Object.entries(body.env)) {
      if (!ENV_NAME.test(k) || typeof v !== 'string' || v.includes('\0')) return { error: `env.${k} is not a NAME=string pair` };
      env[k] = v;
    }
  }
  return { argv, cwd, timeoutMs, maxOutputBytes, stdin: body.stdin == null ? null : body.stdin, env };
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      process.kill(-child.pid, 'SIGKILL'); // the group: detached made the child its leader
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// A front that exits mid-run takes its children with it rather than leaving
// them unbounded: their deadline lived in this process.
process.once('exit', () => { for (const child of live) killTree(child); });

/**
 * Runs a validated spec. Resolves {code, signal, stdout, stderr, timedOut,
 * truncated, durationMs, error?}; never rejects. `onAbort(fn)` registers the
 * caller's "client went away" hook.
 */
function runSpec(spec, { onAbort } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stat;
    try { stat = fs.statSync(spec.cwd); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) {
      return resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false,
        truncated: { stdout: false, stderr: false }, durationMs: 0, error: `cwd ${spec.cwd} is not a directory` });
    }

    let child;
    try {
      child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env ? { ...process.env, ...spec.env } : process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group, so a timeout kills the tree
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // Node refuses some spawns synchronously (e.g. a .cmd/.bat without a
      // shell on Windows — EINVAL since the 2024 batch-file fix).
      return resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false,
        truncated: { stdout: false, stderr: false }, durationMs: 0, error: String(e.message || e) });
    }
    live.add(child);

    const out = { stdout: [], stderr: [] };
    const size = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (chunk) => {
        const room = spec.maxOutputBytes - size[name];
        if (room <= 0) { truncated[name] = true; return; }
        const keep = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (keep.length < chunk.length) truncated[name] = true;
        out[name].push(keep);
        size[name] += keep.length;
      });
      child[name].on('error', () => {});
    }
    child.stdin.on('error', () => {}); // a program that never reads stdin closes it on us
    if (spec.stdin) child.stdin.end(spec.stdin);
    else child.stdin.end();

    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let grace = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // A grandchild that inherited the pipes can keep 'close' from firing
      // even after the group kill (Windows, mostly). Answer anyway.
      grace = setTimeout(() => finish(null, 'SIGKILL'), 5000);
    }, spec.timeoutMs);
    if (onAbort) onAbort(() => { if (!settled) killTree(child); });

    function finish(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      live.delete(child);
      const result = {
        code: timedOut ? null : code,
        signal: signal || null,
        stdout: Buffer.concat(out.stdout).toString('utf8'),
        stderr: Buffer.concat(out.stderr).toString('utf8'),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      };
      if (spawnError) result.error = spawnError;
      else if (timedOut) result.error = `timed out after ${spec.timeoutMs} ms`;
      resolve(result);
    }

    child.on('error', (e) => { spawnError = `${e.code || 'error'}: ${e.message}`; finish(null, null); });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// Read and parse the JSON body. Never hangs: over `maxBytes` answers 413 as
// soon as the cap is crossed, and a body not finished within `timeoutMs`
// answers 408. Either way the caller closes the connection (`close: true`),
// since the rest of the body is not going to be read.
function readJson(req, maxBytes, timeoutMs = BODY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      resolve(v);
    };
    const timer = setTimeout(() => settle({ status: 408, error: `body not received within ${timeoutMs} ms`, close: true }), timeoutMs);
    function onData(c) {
      total += c.length;
      if (total > maxBytes) {
        chunks.length = 0;
        return settle({ status: 413, error: `body is over the ${maxBytes} byte limit`, close: true });
      }
      chunks.push(c);
    }
    req.on('data', onData);
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        return settle({ body: raw ? JSON.parse(raw) : {} });
      } catch {
        return settle({ status: 400, error: 'body is not valid JSON' });
      }
    });
    req.on('error', () => settle({ status: 400, error: 'request failed', close: true }));
    req.on('close', () => settle({ status: 400, error: 'request closed before its body ended', close: true }));
  });
}

/**
 * The route, for the front. Returns true when it answered. Options are for
 * tests: `env` feeds the request guard, `home` the default cwd, `bodyTimeoutMs`
 * the body-read deadline.
 */
function handle(req, res, url, { sendJson, env, home, bodyTimeoutMs = BODY_TIMEOUT_MS } = {}) {
  if (url.pathname !== '/api/exec') return false;
  if (req.method !== 'POST') {
    // No CORS headers, ever: a preflight that gets this fails, which is the point.
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'POST only' });
    req.resume();
    return true;
  }
  const refused = checkProgrammaticRequest(req, { env });
  if (refused) {
    sendJson(res, refused.status, { error: refused.error });
    req.resume();
    return true;
  }
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    res.setHeader('Connection', 'close');
    sendJson(res, 413, { error: `body is over the ${MAX_BODY_BYTES} byte limit` });
    return true;
  }

  (async () => {
    // Read the whole body BEFORE taking a concurrency slot: a slow or endless
    // body must cost the reader a 408, not cost everyone else a slot.
    const read = await readJson(req, MAX_BODY_BYTES, bodyTimeoutMs);
    if (read.error) {
      if (read.close) {
        res.setHeader('Connection', 'close');
        res.on('finish', () => req.destroy());
      }
      return sendJson(res, read.status, { error: read.error });
    }
    const spec = parseSpec(read.body, home ? { home } : {});
    if (spec.error) return sendJson(res, 400, { error: spec.error });
    if (running >= MAX_CONCURRENT) {
      return sendJson(res, 429, { error: `${MAX_CONCURRENT} commands already running` });
    }
    running += 1;
    try {
      const result = await runSpec(spec, {
        onAbort: (kill) => res.on('close', () => { if (!res.writableFinished) kill(); }),
      });
      // Program name and outcome only: argv and output can hold anything.
      console.log(`[exec] ${path.basename(spec.argv[0])} in ${spec.cwd} -> `
        + `${result.timedOut ? 'timeout' : (result.error ? 'error' : result.code)} (${result.durationMs} ms)`);
      return sendJson(res, 200, result);
    } finally {
      running -= 1;
    }
  })().catch((e) => sendJson(res, 500, { error: String(e.message || e) }));
  return true;
}

module.exports = {
  handle, parseSpec, runSpec,
  DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES, MAX_BODY_BYTES, MAX_CONCURRENT,
  BODY_TIMEOUT_MS,
};
