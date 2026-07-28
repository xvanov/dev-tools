'use strict';

// The Claude Code CLI as a *dependency of termhub*, not just something the user
// happens to run in a terminal.
//
// termhub reaches into Claude Code's private surface in several places: it pins a
// conversation with `--session-id`, resumes it with `--resume` (see
// lib/restore.js), and reads the on-disk transcript at
// ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl for the model badge, spoken
// announcements, and turn summaries (lib/claudeModel.js, lib/claudeTranscript.js).
// None of that is a stable public API. When the CLI changed the rules for
// combining --session-id with --resume, session restore broke on every machine
// running a current CLI while continuing to work on one running an older
// build — a failure that looked like "termhub is flaky on Linux" for weeks.
//
// So termhub records the CLI version it is known to work with (package.json
// `termhub.claudeCli`), reports what is actually installed, and can update it —
// the same "check, then apply in a visible terminal" flow the tool already uses
// for its own git updates.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkg = require('../package.json');

// The pin lives in package.json so it travels with the commit that adopted it —
// a version bump is then a reviewable one-line diff, not tribal knowledge.
const PIN = (pkg.termhub && pkg.termhub.claudeCli) || {};
const MIN_VERSION = PIN.minVersion || null;
const VERIFIED_VERSION = PIN.verifiedVersion || MIN_VERSION;

const CACHE_TTL_MS = 5 * 60 * 1000; // `claude --version` costs ~200ms; don't pay it per poll
let cache = { at: 0, data: null };

// Where to find the CLI. `claude` on PATH is the normal answer, but termhub's
// front can run from a systemd --user service whose PATH is the systemd default
// (no ~/.local/bin), and the native installer puts the launcher exactly there —
// so a bare spawn would report "not installed" on a machine that plainly has it.
// Order: explicit override, then PATH, then the installers' known locations.
function candidates() {
  const home = os.homedir();
  const out = [];
  if (process.env.TERMHUB_CLAUDE_BIN) out.push(process.env.TERMHUB_CLAUDE_BIN);
  out.push('claude'); // resolved via PATH by execFile
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    out.push(path.join(local, 'Programs', 'claude', 'claude.exe'));
    out.push(path.join(home, '.local', 'bin', 'claude.exe'));
    out.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'));
  } else {
    out.push(path.join(home, '.local', 'bin', 'claude'));
    out.push('/usr/local/bin/claude');
    out.push(path.join(home, '.claude', 'local', 'claude')); // legacy local install
  }
  return out;
}

function run(bin, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
    });
  });
}

// `claude --version` prints e.g. "2.1.220 (Claude Code)".
function parseVersion(out) {
  const m = /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(out || '');
  return m ? m[1] : null;
}

// Numeric-segment compare: -1 / 0 / 1, with a missing segment treated as 0 so
// "2.1" < "2.1.220". A pre-release suffix ("2.2.0-beta.1") compares on its
// numeric part only — close enough for a >= floor, and it never throws.
function compareVersions(a, b) {
  const seg = (v) => String(v).split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = seg(a);
  const y = seg(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Locate and interrogate the CLI. Returns { version, bin } or { error }.
async function probe() {
  let sawCandidate = false;
  for (const bin of candidates()) {
    // Skip absolute paths that don't exist so a missing file doesn't cost a spawn;
    // bare `claude` always gets tried, since PATH resolution is execFile's job.
    if (bin !== 'claude' && path.isAbsolute(bin) && !fs.existsSync(bin)) continue;
    sawCandidate = true;
    const r = await run(bin, ['--version']);
    const version = parseVersion(r.out || r.err);
    if (version) return { version, bin };
  }
  return { error: sawCandidate ? 'claude CLI found but did not report a version' : 'claude CLI not found on PATH' };
}

// What the UI and the updaters both read: the installed version, the pin, and
// whether the pin is met. `satisfied` is deliberately true when the version is
// unknown — termhub must not nag about a CLI it merely failed to locate (a
// service PATH quirk is not a broken install), and `error` says so instead.
async function status({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const found = await probe();
  const installed = found.version || null;
  const data = {
    installed,
    bin: found.bin || null,
    minVersion: MIN_VERSION,
    verifiedVersion: VERIFIED_VERSION,
    satisfied: !installed || !MIN_VERSION || compareVersions(installed, MIN_VERSION) >= 0,
    error: found.error || null,
    updateCommand: updateCommand(),
    checkedAt: Date.now(),
  };
  cache = { at: Date.now(), data };
  return data;
}

// How to bring the CLI up to date, as a command a user watches run in a termhub
// terminal. `claude update` is the CLI's own self-update (native installer or
// npm global, whichever it was installed as) — always preferred over guessing at
// a package manager. `claude install <version>` exists too, but pinning the
// machine to an exact old build is the wrong default: the floor is a minimum, and
// newer is normally fine.
function updateCommand() {
  return 'claude update';
}

// One line for a terminal or a log: "Claude CLI 2.1.220 (pinned >=2.1.220)".
function describe(s) {
  if (!s || !s.installed) return `Claude CLI not found${MIN_VERSION ? ` (termhub expects >=${MIN_VERSION})` : ''}`;
  const pin = s.minVersion ? ` (pinned >=${s.minVersion})` : '';
  return `Claude CLI ${s.installed}${pin}${s.satisfied ? '' : ' — TOO OLD'}`;
}

module.exports = {
  status, describe, compareVersions, parseVersion, updateCommand,
  MIN_VERSION, VERIFIED_VERSION,
};
