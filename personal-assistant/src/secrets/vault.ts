'use strict';

// The operating system's secret store, whichever this machine has:
//
//   Windows  Credential Manager, through WinRT's PasswordVault (PowerShell)
//   Linux    the Secret Service — GNOME Keyring, KWallet — via `secret-tool`
//   macOS    none (see src/platform/darwin.js): env and .env only
//
// The backends live in src/platform/<os>.js. This module is the one API the
// rest of the tool uses, and it enforces what must hold for every backend:
//
//  - **The secret travels on stdin, never in argv.** A command line is
//    readable by every other process on the machine; stdin is not. Each
//    backend's `invocation(request)` is the exact process a request starts,
//    exposed so the tests can check the value is in `input` and nowhere in
//    `args`.
//  - **No value escapes in an error.** Whatever the store said is scrubbed of
//    the value before it becomes a message.
//  - A missing entry is `null`, not an error.
//
// Whatever the backend, its target id is 'credential-manager' — the name the
// dashboard, `pa secret` and stored `secret_request.stored_in` rows use for
// "the OS vault" — and `label()` is what the human reads.
//
// This module must not require config.js: config's `secret()` resolver
// requires it.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Request = Record<string, any>;
type Invocation = { command: string; args: string[]; input?: string };
type RunnerResult = { stdout?: string; stderr?: string; status?: number | null; error?: string; timedOut?: boolean };
type Runner = (inv: Invocation) => RunnerResult;
type AsyncRunner = (inv: Invocation) => Promise<RunnerResult>;

const { spawnSync, execFile } = require('child_process');
const platform = require('../platform');

const RESOURCE = 'personal-assistant';
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

let backend = platform.vault;

function defaultRunner({ command, args, input }: Invocation): RunnerResult {
  const r = spawnSync(command, args, { input, windowsHide: true, timeout: 15_000, encoding: 'utf8' });
  if (r.error) return { error: r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message, timedOut: r.error.code === 'ETIMEDOUT' };
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

let runner: Runner = defaultRunner;

function defaultAsyncRunner({ command, args, input }: Invocation): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (err: any, stdout: string, stderr: string) => {
      if (err && err.killed) return resolve({ error: 'timed out', timedOut: true });
      if (err && typeof err.code !== 'number') return resolve({ error: err.message });
      resolve({ stdout: stdout || '', stderr: stderr || '', status: err ? err.code : 0 });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

// Tests that fake the process get their fake here too, unless they give an async one.
let asyncRunner: AsyncRunner | null = null;
const runAsync = (inv: Invocation) => (asyncRunner ? asyncRunner(inv) : runner === defaultRunner ? defaultAsyncRunner(inv) : Promise.resolve(runner(inv)));

// A store that hangs (a locked keyring with no one to unlock it, on a headless
// box) would block every secret lookup for the timeout, and a locked desktop
// keyring answers a lookup with an unlock prompt — once a minute per missing
// name, if nothing stopped it. So after a read (get/list) times out or fails,
// the vault counts as unavailable for ten minutes and lookups fall through to
// .env. A failed *write* does not trip it: that error goes to the person who
// asked, who can retry.
const BREAK_MS = 10 * 60_000;
let brokenUntil = 0;

// Tests swap the process for a fake; nothing else should.
function setRunner(fn?: Runner | null, asyncFn?: AsyncRunner | null) {
  runner = fn || defaultRunner;
  asyncRunner = asyncFn || null;
  brokenUntil = 0;
}

// Tests pick the backend whose protocol their fake speaks: 'windows' |
// 'linux' | 'darwin' (a platform id), or null for this machine's.
function useBackend(id?: string | null) {
  const map: Record<string, string> = { windows: 'win32', linux: 'linux', darwin: 'darwin' };
  backend = id ? platform.select(map[id] || id).vault : platform.vault;
  brokenUntil = 0;
}

function available() {
  if (runner !== defaultRunner) return true;
  if (Date.now() < brokenUntil) return false;
  return backend.available();
}

// Where a stored value goes, in words: "Windows Credential Manager".
function label() {
  return backend.label;
}

function where() {
  return backend.where;
}

function invocation(request: Request) {
  return backend.invocation(request);
}

function scrub(text: unknown, value?: string) {
  let s = String(text ?? '');
  if (value) s = s.split(String(value)).join('<redacted>');
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function call(request: Request) {
  if (!available()) throw new Error(`${backend.label} is not available on this machine — store it in .env instead`);
  if (request.name !== undefined && !NAME_RE.test(request.name)) {
    throw new Error('secret names are UPPER_SNAKE_CASE, e.g. PA_JIRA_API_TOKEN');
  }
  let timedOut = false;
  const watched = (inv: Invocation) => {
    const r = runner(inv);
    if (r && r.timedOut) timedOut = true;
    return r;
  };
  return settle(request, backend.run(request, watched), timedOut);
}

function settle(request: Request, parsed: any, timedOut: boolean) {
  const failedRead = (!parsed || !parsed.ok) && (request.op === 'get' || request.op === 'list');
  if ((timedOut || failedRead) && runner === defaultRunner) brokenUntil = Date.now() + BREAK_MS;
  if (!parsed || !parsed.ok) throw new Error(`${backend.label}: ${scrub(parsed && parsed.error, request.value)}`);
  return parsed;
}

// call(), with each process the backend asks for run asynchronously. A
// backend's run() is synchronous, so it is replayed: each pass answers the
// processes already run and stops at the first one that is not, which is then
// run off the event loop's back. A read only (no value is ever sent here).
async function callAsync(request: Request) {
  if (!available()) throw new Error(`${backend.label} is not available on this machine — store it in .env instead`);
  const done = new Map<string, RunnerResult>();
  const NEED = Symbol('need');
  for (;;) {
    let need = null as Invocation | null;
    let timedOut = false;
    let parsed: any;
    try {
      parsed = backend.run(request, (inv: Invocation) => {
        const r = done.get(JSON.stringify(inv));
        if (!r) {
          need = inv;
          throw NEED;
        }
        if (r.timedOut) timedOut = true;
        return r;
      });
    } catch (err) {
      if (err !== NEED) throw err;
    }
    if (need) {
      done.set(JSON.stringify(need), await runAsync(need));
      continue;
    }
    return settle(request, parsed, timedOut);
  }
}

function set(name: string, value: string) {
  if (typeof value !== 'string' || !value) throw new Error('an empty value is not stored');
  call({ op: 'set', name, value });
}

// The value, or null. Only config's resolver should call this.
function get(name: string) {
  const r = call({ op: 'get', name });
  return r.found ? String(r.value) : null;
}

function remove(name: string) {
  return Boolean(call({ op: 'delete', name }).found);
}

function list() {
  const r = call({ op: 'list' });
  return [].concat(r.names || []).map(String).sort();
}

/** list(), without holding the event loop for the process (~0.7-1 s of PowerShell on Windows). */
async function listAsync() {
  const r = await callAsync({ op: 'list' });
  return [].concat(r.names || []).map(String).sort();
}

module.exports = { RESOURCE, NAME_RE, invocation, setRunner, useBackend, available, label, where, scrub, set, get, remove, list, listAsync };
