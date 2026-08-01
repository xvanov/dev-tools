'use strict';

// Self-install the watchdog when termhub starts (Linux only).
//
// WHY THIS EXISTS AT ALL
//
// The ⟳ Update button runs a command string composed by the *running* front, so that
// string always encodes the OLD version's idea of how to update. lib/update.js now
// delegates to linux/update.sh, which fixes that going forward — but it cannot fix the
// FIRST update on a machine that is still running the old inline command:
//
//     git pull --ff-only && { claude update || true; } && systemctl --user restart termhub
//
// That command pulls the new code and then restarts the service, and the restart is
// what starts the new code. So a hook here — in the new code — is the one thing that
// runs on that first click. After it, linux/update.sh handles it directly and this
// becomes a cheap no-op that also re-asserts the watchdog after every reboot.
//
// WHY LINUX ONLY
//
// On Windows the watchdog is registered by windows\install.ps1 and re-confirmed by
// windows\update.ps1, which are the only two ways termhub is deployed there — so the
// hook would be redundant. It would also be actively risky: the front is restarted by
// update.ps1 itself, so the new front would run Confirm-WatchdogTask concurrently with
// the updater doing the same thing, racing over one Register-ScheduledTask. And a
// non-elevated front could only create an Interactive task, quietly settling for less
// than the S4U principal an elevated install would have given. None of that applies to
// a systemd --user timer, which needs no privileges and is reconciled by content.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.join(__dirname, '..');

// Startup is not the place to block on anything, and a watchdog installer is not
// urgent: let the port bind and the first requests be served first.
const DELAY_MS = 5000;

let done = false;

function ensureWatchdog() {
  if (done) return;
  done = true;

  if (process.platform === 'win32') return;          // see the header
  if (process.env.TERMHUB_NO_WATCHDOG_SETUP === '1') return;
  // A dev instance on its own ports must not touch the machine's real supervisor.
  if (process.env.TERMHUB_PORT && Number(process.env.TERMHUB_PORT) !== 7000) return;

  const script = path.join(PROJECT_DIR, 'watchdog', 'install-watchdog.sh');
  if (!fs.existsSync(script)) return;

  const timer = setTimeout(() => {
    // --ensure is idempotent and silent unless it changed something, so the common
    // case adds one no-op subprocess per start and no output.
    execFile('bash', [script, '--ensure'], { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err) {
        // Never fatal, never loud: termhub serving is what matters, and a machine
        // that could not install a timer is still a working termhub.
        console.error(`[termhub] watchdog install skipped: ${err.message}`);
        if (out) console.error(`[termhub] ${out.split('\n').slice(0, 4).join(' | ')}`);
        return;
      }
      if (out) for (const line of out.split('\n').slice(0, 8)) console.log(`[termhub] ${line}`);
    });
  }, DELAY_MS);
  // Don't hold the event loop open on this alone.
  if (timer.unref) timer.unref();
}

module.exports = { ensureWatchdog };
