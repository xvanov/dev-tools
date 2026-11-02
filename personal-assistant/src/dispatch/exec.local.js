'use strict';

// The local-only half of `src/dispatch/exec.js`: run a command on THIS machine
// and hand back what it printed. Same signature as exec.js's `runCommand`, so
// callers (src/dispatch/factory.js) never know which one they got:
//
//   runCommand(machineName | null, argv, {cwd, timeoutMs}) → Promise<{code, stdout, stderr}>
//
// `null` (or this machine's hostname) runs `argv` with child_process — no
// shell, argv passed verbatim. A non-zero exit is not a throw: the factory's
// `--json` commands put an error object on stdout and exit non-zero, and that
// object is the answer. A command that cannot start at all, or overruns
// `timeoutMs`, does throw.
//
// Any other machine is refused here: reaching one goes through termhub and is
// exec.js's job. factory.js prefers exec.js when it exists and falls back to
// this file, so the two can be merged without either rewriting the other.

const os = require('os');
const { execFile } = require('child_process');

function runCommand(machineName, argv, { cwd, timeoutMs = 120_000 } = {}) {
  if (machineName && machineName !== os.hostname()) {
    return Promise.reject(new Error(`exec.local runs on this machine only; "${machineName}" needs src/dispatch/exec.js`));
  }
  if (!Array.isArray(argv) || !argv.length) return Promise.reject(new Error('runCommand needs an argv array'));
  return new Promise((resolve, reject) => {
    execFile(
      argv[0],
      argv.slice(1),
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err && (typeof err.code !== 'number' || err.killed)) {
          // Not started (ENOENT), or killed by the timeout.
          const e = new Error(err.killed ? `${argv[0]} timed out after ${timeoutMs} ms` : `${argv[0]}: ${err.message}`);
          e.cause = err;
          return reject(e);
        }
        resolve({ code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

module.exports = { runCommand };
