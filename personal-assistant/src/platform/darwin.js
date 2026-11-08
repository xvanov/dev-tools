'use strict';

// macOS: enough to run the CLI, the worker and the dashboard, and honest about
// the rest. Not a target the operator runs today (2026-11-02: Linux and
// Windows), so where macOS would need its own native piece it degrades
// explicitly and `pa doctor` says so, rather than guessing:
//
//   secrets   no vault — the Keychain's `security` CLI takes a password only
//             in argv or on a terminal, which the stdin-only rule forbids;
//             env and the gitignored .env are used instead
//   capture   unsupported — CoreAudio has no loopback without a virtual
//             device (BlackHole); the gate and watchdog stand down
//   Teams     the connector only
//
// Store, open, clipboard, toasts and disk space are native.

const os = require('os');
// posix: this file models that OS's paths, whichever OS evaluates it (tests run it on Windows).
const path = require('path').posix;

const common = require('./common');
const linux = require('./linux');

const id = 'darwin';
const label = 'macOS';

const defaults = {
  dataDir: () => path.join(os.homedir(), 'Library', 'Application Support', 'personal-assistant'),
  reposRoot: () => path.join(os.homedir(), 'repos'),
  venvPython: (venvDir) => path.join(venvDir, 'bin', 'python'),
  teamsCacheDir: () => null,
  pgTools: linux.defaults.pgTools,
};

const teamsCache = { supported: false, why: 'not built for macOS — Teams arrives through the Microsoft 365 connector' };

// APFS is case-insensitive by default.
function pathKey(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
}

function openCommand(url) {
  return { cmd: 'open', args: [String(url)] };
}

function openUrl(url) {
  const c = openCommand(url);
  return common.spawnDetached(c.cmd, c.args);
}

function clipboardCommand() {
  return { cmd: 'pbcopy', args: [] };
}

function copyToClipboard(text) {
  return common.pipeTo('pbcopy', [], text);
}

function teamsDesktop() {
  return true;
}

// The title and body are argv items read by the script, never spliced into
// it, so nothing in a message can become AppleScript.
function toastCommand({ title, body }) {
  const lines = String(body || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 4).join('\n');
  return {
    cmd: 'osascript',
    args: [
      '-e', 'on run argv',
      '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e', 'end run',
      String(title ?? '').slice(0, 120),
      lines.slice(0, 600),
    ],
  };
}

async function toast(spec) {
  const c = toastCommand(spec);
  const r = await common.run(c.cmd, c.args, { timeoutMs: 15_000 });
  return !r.error && r.status === 0;
}

const vault = {
  id: 'credential-manager',
  label: 'the macOS Keychain',
  where: 'the macOS Keychain',
  available: () => false,
  invocation() {
    throw new Error('no secret vault on macOS — use .env');
  },
  run() {
    return { ok: false, error: 'no secret vault on macOS — use .env' };
  },
};

const capture = {
  backend: 'unsupported on macOS',
  installed: () => false,
  restartHint: () => 'capture is not supported on macOS',
  restartCommand: () => null,
  async restart() {
    throw new Error('capture is not supported on macOS');
  },
  async micHolders() {
    return [];
  },
};

async function freeBytes(dir) {
  return common.statfsFree(dir);
}

const services = {
  workerStart: 'node src/worker.js',
  workerStop: 'stop the worker process',
  install: '(no installer for macOS)',
  dbProvision: 'docker compose up -d',
};

async function doctor({ audioEnabled = true } = {}) {
  const lines = [{ ok: false, label: 'secret store', detail: 'DEGRADED: no vault on macOS — secrets are read from env and .env only' }];
  if (audioEnabled) lines.push({ ok: false, label: 'capture', detail: 'UNSUPPORTED on macOS — set PA_AUDIO_ENABLED=0' });
  return lines;
}

module.exports = {
  id,
  label,
  defaults,
  teamsCache,
  pathKey,
  openCommand,
  openUrl,
  clipboardCommand,
  copyToClipboard,
  teamsDesktop,
  toastCommand,
  toast,
  vault,
  capture,
  freeBytes,
  services,
  doctor,
};
