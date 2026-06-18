'use strict';

// Shared deployment state for the two-tier (sessiond + front) layout.
//
//   state.json    -> { sessiondPort, activeFrontPort }   (which loopback port
//                     Tailscale Serve currently targets — the "blue" front)
//   <name>.pid    -> "PID\nPORT\n"  per running process (sessiond, front-<port>)
//
// Both the Node processes and the PowerShell/shell scripts read these. The
// formats are intentionally trivial (plain JSON, two-line pid files) so the
// install/start/update scripts can parse them without spawning node.

const fs = require('fs');
const path = require('path');
const { ensureDataDir } = require('./paths');

const DEFAULT_SESSIOND_PORT = Number(process.env.TERMHUB_SESSIOND_PORT) || 7010;
const DEFAULT_FRONT_PORT = Number(process.env.TERMHUB_FRONT_PORT) || 7001;
// The two loopback ports the front alternates between for blue/green swaps.
const FRONT_PORTS = [7001, 7002];

function statePath() {
  return path.join(ensureDataDir(), 'state.json');
}

function readState() {
  const defaults = { sessiondPort: DEFAULT_SESSIOND_PORT, activeFrontPort: DEFAULT_FRONT_PORT };
  try {
    const data = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (data && typeof data === 'object') return { ...defaults, ...data };
  } catch {
    // missing or corrupt — fall back to defaults
  }
  return defaults;
}

// Merge a patch into state.json (read-modify-write). Returns the new state.
function writeState(patch) {
  const next = { ...readState(), ...patch };
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2));
  return next;
}

// Given the currently-active front port, return the other port to deploy onto.
function otherFrontPort(active) {
  const a = Number(active);
  return FRONT_PORTS.find((p) => p !== a) || FRONT_PORTS[0];
}

// ---- pid files ------------------------------------------------------------

function pidPath(name) {
  return path.join(ensureDataDir(), `${name}.pid`);
}

function writePidFile(name, port) {
  fs.writeFileSync(pidPath(name), `${process.pid}\n${port}\n`);
}

function readPidFile(name) {
  try {
    const [pid, port] = fs.readFileSync(pidPath(name), 'utf8').split(/\s+/);
    return { pid: Number(pid), port: Number(port) };
  } catch {
    return null;
  }
}

function removePidFile(name) {
  try { fs.unlinkSync(pidPath(name)); } catch { /* already gone */ }
}

// Register a pid file for this process and tear it down on exit so a stale file
// never outlives the process. Cleared on normal exit and on Ctrl-C / SIGTERM.
function claimPidFile(name, port) {
  writePidFile(name, port);
  const cleanup = () => removePidFile(name);
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(0); });
  }
}

module.exports = {
  DEFAULT_SESSIOND_PORT,
  DEFAULT_FRONT_PORT,
  FRONT_PORTS,
  statePath,
  readState,
  writeState,
  otherFrontPort,
  pidPath,
  writePidFile,
  readPidFile,
  removePidFile,
  claimPidFile,
};
