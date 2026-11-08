'use strict';

// Where a production sessiond keeps its PTYs (plan 5.1 / Exit 5 cutover): in
// ptyd, or in-process with node-pty. The setting is persistent and rolls back
// with one command:
//
//   node lib/ptyHost.js                 status: the setting, what the next start
//                                       resolves to, what the running sessiond uses
//   node lib/ptyHost.js auto|ptyd|node-pty   change the setting (effective on the
//                                       next sessiond start; restart-sessiond.ps1 on
//                                       Windows, `systemctl --user restart termhub`
//                                       on Linux; either ends live terminals once)
//
// Stored as `ptyHost` in <dataDir>/settings.json. The modes:
//
//   node-pty (default)  never ptyd: today's behaviour, and the rollback
//   ptyd            always ptyd (sessions fail loudly if it cannot be started).
//                   The cutover is setting this, explicitly.
//   auto            ptyd when a release ptyd binary is on this machine
//                   (TERMHUB_PTYD_BIN, dist/<os>-<arch>/ from scripts/build.js, or
//                   ptyd/target/release), else node-pty. Opt-in only: it is NOT
//                   the default, because then merely building ptyd in a deployed
//                   checkout (a deploy, a test run) would switch the host at the
//                   next sessiond restart and end every live terminal.
//
// Applied only by the production entrypoints (`node sessiond.js`, `node
// server.js`: what windows/*.ps1 and the Linux unit run), as TERMHUB_PTYD for
// lib/ptydClient.js. An explicit TERMHUB_PTYD in the environment wins. Tests
// call startSessiond() directly and never consult the setting.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { dataDir } = require('./paths');

const MODES = ['auto', 'ptyd', 'node-pty'];
const EXE = process.platform === 'win32' ? 'ptyd.exe' : 'ptyd';
const REPO = path.join(__dirname, '..', '..');

function settingsFile(dir = dataDir()) {
  return path.join(dir, 'settings.json');
}

function readSettings(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

const DEFAULT_MODE = 'node-pty';

/** The stored mode, or the default (node-pty) when unset or unknown. */
function readMode(dir) {
  const m = readSettings(dir).ptyHost;
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

function writeMode(mode, dir = dataDir()) {
  if (!MODES.includes(mode)) throw new Error(`ptyHost must be one of ${MODES.join(', ')}`);
  const s = readSettings(dir);
  s.ptyHost = mode;
  fs.mkdirSync(dir, { recursive: true });
  const f = settingsFile(dir);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(`${f}.tmp`, f);
}

/** A release-grade ptyd binary on this machine, or null. Debug builds don't count. */
function releaseBinary(env = process.env, exists = fs.existsSync) {
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const candidates = [
    env.TERMHUB_PTYD_BIN,
    path.join(REPO, 'dist', platform, EXE),
    path.join(REPO, 'ptyd', 'target', 'release', EXE),
  ].filter(Boolean);
  return candidates.find((p) => exists(p)) || null;
}

/**
 * Pure. What a production start should use.
 * @returns {{ptyd: boolean, mode: string, bin: string|null, reason: string}}
 */
function resolve({ envValue, mode, bin }) {
  if (envValue === '1') return { ptyd: true, mode, bin, reason: 'TERMHUB_PTYD=1 in the environment' };
  if (envValue === '0') return { ptyd: false, mode, bin, reason: 'TERMHUB_PTYD=0 in the environment' };
  if (mode === 'ptyd') return { ptyd: true, mode, bin, reason: 'setting ptyHost=ptyd' };
  if (mode === 'auto') {
    return bin
      ? { ptyd: true, mode, bin, reason: `auto: release binary at ${bin}` }
      : { ptyd: false, mode, bin, reason: 'auto: no release ptyd binary on this machine' };
  }
  // node-pty, unset or anything else: the default never switches by itself.
  return { ptyd: false, mode, bin, reason: `setting ptyHost=${mode || DEFAULT_MODE} (the default; switch with: node lib/ptyHost.js ptyd)` };
}

/** For the entrypoints: decide, export TERMHUB_PTYD (+ _BIN), say so. */
function applyToEnv(env = process.env, log = (m) => console.log(m)) {
  const bin = releaseBinary(env);
  const r = resolve({ envValue: env.TERMHUB_PTYD, mode: readMode(), bin });
  env.TERMHUB_PTYD = r.ptyd ? '1' : '0';
  if (r.ptyd && bin && !env.TERMHUB_PTYD_BIN) env.TERMHUB_PTYD_BIN = bin;
  log(`[termhub] PTY host: ${r.ptyd ? 'ptyd' : 'node-pty'} (${r.reason})`);
  return r;
}

function pingSessiond(port) {
  return new Promise((resolveP) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolveP(JSON.parse(b)); } catch { resolveP(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolveP(null));
  });
}

async function main(argv) {
  const arg = argv[0];
  if (arg && arg !== 'status') {
    writeMode(arg);
    console.log(`ptyHost set to ${arg} in ${settingsFile()}`);
  }
  const mode = readMode();
  const bin = releaseBinary();
  const next = resolve({ envValue: process.env.TERMHUB_PTYD, mode, bin });
  console.log(`setting:     ${mode}`);
  console.log(`next start:  ${next.ptyd ? 'ptyd' : 'node-pty'} (${next.reason})`);
  const port = Number(process.env.TERMHUB_SESSIOND_PORT) || 7010;
  const ping = await pingSessiond(port);
  const running = ping ? ping.ptyHost || 'node-pty (a sessiond older than ptyHost reporting)' : null;
  console.log(`running:     ${running ? `${running} (sessiond pid ${ping.pid} on :${port})` : `no sessiond on :${port}`}`);
  if (ping && running && running.split(' ')[0] !== (next.ptyd ? 'ptyd' : 'node-pty')) {
    console.log('A sessiond restart is needed for the change to take effect, and it ends the live terminals once.');
  }
}

module.exports = { MODES, DEFAULT_MODE, readMode, writeMode, releaseBinary, resolve, applyToEnv, settingsFile };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message || e);
    process.exit(2);
  });
}
