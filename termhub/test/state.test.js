'use strict';

// pid-file ownership tests. Plain node, no framework, no deps:
//   node test/state.test.js
//
// These encode the rule a real outage came down to. sessiond claimed its pid file
// BEFORE binding the port, so when a duplicate launch lost the bind (a leftover
// `node server.js` already owned 7010) the loser had already overwritten the
// file — and then its exit handler DELETED it. The healthy supervisor was left
// with no pid file, the next update read that as "no sessiond running", launched
// another duplicate, and the cycle repeated. Two invariants prevent it:
//
//   1. a pid file is only ever removed by the process it names (removeOwnPidFile)
//   2. a live holder is distinguishable from a stale record (pidFileHolder)
//
// The pid file is bookkeeping either way — the authoritative duplicate check is
// the port bind — so nothing here may refuse to start; it only has to stop lying.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the data dir at a scratch directory BEFORE requiring the module: paths.js
// reads TERMHUB_DATA_DIR per call, but keeping the whole run isolated is simpler.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-state-test-'));
process.env.TERMHUB_DATA_DIR = TMP;

const state = require('../lib/state');

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function reset(name) {
  state.removePidFile(name);
}

// A pid that is certain not to exist. Pids are 32-bit on Windows and bounded by
// /proc/sys/kernel/pid_max on Linux; this is above both in practice.
const DEAD_PID = 0x7ffffffe;

// ---- 1. liveness ------------------------------------------------------------

eq('own pid is alive', state.isProcessAlive(process.pid), true);
eq('absurd pid is not alive', state.isProcessAlive(DEAD_PID), false);
eq('pid 0 is not a process', state.isProcessAlive(0), false);
eq('negative pid is rejected', state.isProcessAlive(-1), false);
eq('NaN pid is rejected', state.isProcessAlive(NaN), false);

// ---- 2. reading a pid file --------------------------------------------------

reset('t-read');
eq('missing pid file reads as null', state.readPidFile('t-read'), null);
eq('missing pid file has no holder', state.pidFileHolder('t-read'), null);

state.writePidFile('t-read', 7010);
const read = state.readPidFile('t-read');
check('written pid file round-trips', read && read.pid === process.pid && read.port === 7010,
  JSON.stringify(read));

const holder = state.pidFileHolder('t-read');
check('a file naming a live process has a holder', holder && holder.pid === process.pid,
  JSON.stringify(holder));

// A record naming a dead process is stale, not a holder. This is the case that
// used to read as "sessiond is running" and block a legitimate start.
fs.writeFileSync(path.join(TMP, 't-read.pid'), `${DEAD_PID}\n7010\n`);
eq('a file naming a dead process has no holder', state.pidFileHolder('t-read'), null);
check('a stale file is still readable (so the caller can report it)',
  state.readPidFile('t-read').pid === DEAD_PID);

// ---- 3. ownership on removal ------------------------------------------------
// The core fix. A process must not delete a pid file that names somebody else,
// no matter how it exits.

reset('t-own');
fs.writeFileSync(path.join(TMP, 't-own.pid'), `${DEAD_PID}\n7010\n`);
state.removeOwnPidFile('t-own');
eq("another process's pid file survives our cleanup",
  fs.existsSync(path.join(TMP, 't-own.pid')), true);

state.writePidFile('t-own', 7010);
state.removeOwnPidFile('t-own');
eq('our own pid file is removed by our cleanup',
  fs.existsSync(path.join(TMP, 't-own.pid')), false);

// Idempotent: a second cleanup pass (exit after SIGTERM already ran it) is fine.
state.removeOwnPidFile('t-own');
eq('removing an already-removed pid file is a no-op',
  fs.existsSync(path.join(TMP, 't-own.pid')), false);

// The duplicate-launch sequence end to end, with the roles the outage had: the
// incumbent's file is present, a would-be duplicate claims it, then dies.
reset('t-dup');
fs.writeFileSync(path.join(TMP, 't-dup.pid'), `${DEAD_PID}\n7010\n`); // "incumbent"
state.claimPidFile('t-dup', 7010);                                    // duplicate wins the file
eq('claiming overwrites the record', state.readPidFile('t-dup').pid, process.pid);
// ...but the duplicate is the one that dies, and it only clears its own record.
state.removeOwnPidFile('t-dup');
eq('the duplicate takes only its own record with it',
  fs.existsSync(path.join(TMP, 't-dup.pid')), false);
// Which is why claiming must happen AFTER the port bind: a process that never
// binds never gets to write the file at all, so the incumbent's record survives.

// ---- 4. port helpers --------------------------------------------------------

eq('otherFrontPort(7001) is 7002', state.otherFrontPort(7001), 7002);
eq('otherFrontPort(7002) is 7001', state.otherFrontPort(7002), 7001);
eq('otherFrontPort of an unknown port falls back to the first',
  state.otherFrontPort(7000), 7001);
eq('publish port is never a front port', state.FRONT_PORTS.includes(7000), false);

// ---- cleanup + report -------------------------------------------------------

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* scratch dir */ }

console.log(`\nstate: ${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(1);
}
