'use strict';

// The update command is the one string that has to be right on every machine: it is
// what the ⟳ Update button runs, and a machine that cannot update itself cannot be
// fixed by shipping a fix. It also has to be a SCRIPT IN THE REPO rather than an
// inline sequence, because the string is composed by the running (old) build — so an
// inline command can never carry a change to the update procedure itself. Linux was
// an inline one-liner for exactly that reason and never picked up new steps.
//
// No framework, no deps, same shape as the other tests here.

const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  OK    ${name}`); }
  else { failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  FAIL  ${name}`); }
}

// process.platform is read at call time, so it can be swapped per assertion. Restore
// it afterwards: a leaked override would silently mislead any later test in the run.
const realPlatform = process.platform;
function asPlatform(p, fn) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try { return fn(); } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
}

const { updateCommand, PROJECT_DIR } = require('../lib/update');

console.log('\nupdate command');

// ---- the scripts it points at must exist ------------------------------------
// A command naming a script that isn't there is the failure this catches: the whole
// point of delegating is that the pull brings the procedure with it.
const winScript = path.join(PROJECT_DIR, 'windows', 'update.ps1');
const linScript = path.join(PROJECT_DIR, 'linux', 'update.sh');
check('windows/update.ps1 exists', fs.existsSync(winScript), winScript);
check('linux/update.sh exists', fs.existsSync(linScript), linScript);

// ---- windows ----------------------------------------------------------------
const win = asPlatform('win32', updateCommand);
check('win32 runs update.ps1', win.includes('update.ps1'), win);
check('win32 quotes the script path', win.includes(`"${winScript}"`), win);
check('win32 bypasses the execution policy', /-ExecutionPolicy Bypass/.test(win), win);

// ---- linux ------------------------------------------------------------------
const lin = asPlatform('linux', updateCommand);
check('linux delegates to linux/update.sh', lin.includes('linux' + path.sep + 'update.sh') || lin.includes('linux/update.sh'), lin);
check('linux quotes the script path', lin.includes(`"${linScript}"`), lin);
// These are the tells of the OLD inline command. Their absence is the actual
// regression guard: if any of them comes back, the procedure has stopped being
// self-applying and every machine needs a manual step again.
check('linux no longer inlines git pull', !lin.includes('git pull'), lin);
check('linux no longer inlines systemctl restart', !lin.includes('systemctl'), lin);
check('linux no longer inlines claude update', !lin.includes('claude update'), lin);

// ---- the restart must be last in the Linux script ---------------------------
// On Linux termhub is one process and the updater runs inside a termhub PTY, so the
// restart kills the script. Anything sequenced after it never runs — which is why the
// watchdog step has to come BEFORE the restart, and why this ordering is a test rather
// than a comment.
const sh = fs.readFileSync(linScript, 'utf8');
// The path is quoted in the script ("…/install-watchdog.sh" --ensure), so match the
// call shape rather than a bare substring.
const ensureMatches = [...sh.matchAll(/install-watchdog\.sh"?\s+--ensure/g)];
const lastEnsure = ensureMatches.length ? ensureMatches[ensureMatches.length - 1].index : -1;
// Anchor the ordering on the REAL hand-off, which is systemd-run — not on
// setsid, which is now only the fallback branch beneath it. Anchoring on setsid
// would keep passing if the fix were reverted.
const handoff = sh.indexOf('systemd-run');
check('linux/update.sh installs the watchdog', lastEnsure !== -1);
check('linux/update.sh hands the restart to a detached --finish phase', sh.includes('--finish'));
check('the watchdog step precedes the detached restart hand-off',
  lastEnsure !== -1 && handoff !== -1 && lastEnsure < handoff,
  `ensure@${lastEnsure} systemd-run@${handoff}`);

// The detach must escape the CGROUP, not just the terminal. termhub is a systemd
// --user service with the default KillMode=control-group, so `systemctl --user
// restart` SIGTERMs every process in the unit's cgroup — and a PTY child is in
// it. setsid changes session and process group and leaves the cgroup alone, so
// the verify-and-rollback phase used to kill itself on its own restart line.
// Proven with an isolated transient unit: the setsid child kept the unit's
// cgroup and died with it. The failure is invisible when the update works and
// only bites when a rollback was needed, so it gets a test rather than a comment.
check('the --finish phase is launched into its own systemd unit',
  /systemd-run\s+--user\s+--unit=/.test(sh), sh.slice(handoff, handoff + 160));
check('the transient unit is --collect (no accumulation of one unit per update)',
  /systemd-run[^\n]*--collect/.test(sh));
check('setsid survives only as the documented fallback, not as the hand-off',
  sh.indexOf('systemd-run') < sh.lastIndexOf('setsid'),
  `systemd-run@${sh.indexOf('systemd-run')} setsid@${sh.lastIndexOf('setsid')}`);

// ---- platform override hygiene ---------------------------------------------
check('process.platform was restored', process.platform === realPlatform, process.platform);

// ---- the button must never be left without a command --------------------------
// The UI enables Update on `command`. A check that could not compare refs (no
// upstream, offline, not a git tree, or compute() throwing) used to return no
// command, which left the button dead exactly when the update was needed.
// Also: update.ps1 runs under Windows PowerShell 5.1 with ErrorActionPreference
// Stop, where `& git ... 2>&1` throws on git's first stderr line. The pull must go
// through Invoke-Git, or the script dies before it can heal a diverged branch.
(async () => {
  const { checkForUpdate } = require('../lib/update');
  const info = await checkForUpdate({ force: true });
  check('every check answer carries the update command', !!info.command, JSON.stringify(info).slice(0, 200));
  check('every check answer carries the cwd', info.cwd === PROJECT_DIR);

  const ps = fs.readFileSync(winScript, 'utf8');
  const code = ps.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  check('update.ps1 pulls via Invoke-Git, not a raw redirected git call',
    /Invoke-Git[^\n]*'pull'/.test(code) && !/&\s*git[^\n]*\bpull\b[^\n]*2>/.test(code));
  check('update.ps1 never redirects a native command\'s stderr (fatal under PS 5.1 + Stop)',
    !/&\s*(git|tailscale)\b[^\n]*2>(&1|\$null)/.test(code));
  check('update.ps1 stashes uncommitted work instead of refusing it', /Save-LocalChanges/.test(code));
  check('update.ps1 rolls back via Reset-TreeTo, never a bare reset --hard', !/reset --hard/.test(code));

  console.log(`\nupdate: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  FAIL ' + f);
    process.exit(1);
  }
})();
