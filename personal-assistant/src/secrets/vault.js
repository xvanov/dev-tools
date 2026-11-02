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

const { spawnSync } = require('child_process');
const platform = require('../platform');

const RESOURCE = 'personal-assistant';
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

let backend = platform.vault;

function defaultRunner({ command, args, input }) {
  const r = spawnSync(command, args, { input, windowsHide: true, timeout: 15_000, encoding: 'utf8' });
  if (r.error) return { error: r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message, timedOut: r.error.code === 'ETIMEDOUT' };
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

let runner = defaultRunner;

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
function setRunner(fn) {
  runner = fn || defaultRunner;
  brokenUntil = 0;
}

// Tests pick the backend whose protocol their fake speaks: 'windows' |
// 'linux' | 'darwin' (a platform id), or null for this machine's.
function useBackend(id) {
  const map = { windows: 'win32', linux: 'linux', darwin: 'darwin' };
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

function invocation(request) {
  return backend.invocation(request);
}

function scrub(text, value) {
  let s = String(text ?? '');
  if (value) s = s.split(String(value)).join('<redacted>');
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function call(request) {
  if (!available()) throw new Error(`${backend.label} is not available on this machine — store it in .env instead`);
  if (request.name !== undefined && !NAME_RE.test(request.name)) {
    throw new Error('secret names are UPPER_SNAKE_CASE, e.g. PA_JIRA_API_TOKEN');
  }
  let timedOut = false;
  const watched = (inv) => {
    const r = runner(inv);
    if (r && r.timedOut) timedOut = true;
    return r;
  };
  const parsed = backend.run(request, watched);
  const failedRead = (!parsed || !parsed.ok) && (request.op === 'get' || request.op === 'list');
  if ((timedOut || failedRead) && runner === defaultRunner) brokenUntil = Date.now() + BREAK_MS;
  if (!parsed || !parsed.ok) throw new Error(`${backend.label}: ${scrub(parsed && parsed.error, request.value)}`);
  return parsed;
}

function set(name, value) {
  if (typeof value !== 'string' || !value) throw new Error('an empty value is not stored');
  call({ op: 'set', name, value });
}

// The value, or null. Only config's resolver should call this.
function get(name) {
  const r = call({ op: 'get', name });
  return r.found ? String(r.value) : null;
}

function remove(name) {
  return Boolean(call({ op: 'delete', name }).found);
}

function list() {
  const r = call({ op: 'list' });
  return [].concat(r.names || []).map(String).sort();
}

module.exports = { RESOURCE, NAME_RE, invocation, setRunner, useBackend, available, label, where, scrub, set, get, remove, list };
