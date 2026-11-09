'use strict';

// Where a production sessiond keeps its PTYs (plan 5.1, Exit 5): in ptyd.
// The in-process node-pty host is retired. There is no fallback.
//
//   node lib/ptyHost.js                 status: the setting, what the next start
//                                       resolves to, what the running sessiond uses
//   node lib/ptyHost.js ptyd            the only setting (effective on the next
//                                       sessiond start)
//   node lib/ptyHost.js install [--dry-run]  copy the newest ptyd build into place
//                                       for ptyd's next start (below)
//
// Stored as `ptyHost` in <dataDir>/settings.json. The only mode is `ptyd`, and
// it is the default when the key is unset or unknown. A stored `auto` (the old
// "ptyd if a binary exists, else node-pty") reads as ptyd: the fallback is gone.
// `node-pty`, and TERMHUB_PTYD=0, are the removed path. They error. They do not
// select a host. Rollback is the previous commit, not a setting.
//
// Applied only by the production entrypoints (`node sessiond.js`, `node
// server.js`: what windows/*.ps1 and the Linux unit run), as TERMHUB_PTYD=1 for
// lib/ptydClient.js. An explicit TERMHUB_PTYD=1 is the same choice, from the
// environment, else termhub/.env or the repo's .env (lib/dotenv.ts). Tests call
// startSessiond() directly and point TERMHUB_PTYD at a spare ptyd.
//
// A long-lived ptyd runs an installed copy, <dataDir>/bin/ptyd-<hash>, named
// by <dataDir>/bin/ptyd-current (`node lib/ptyHost.js install`): a build then
// never writes over the running binary (Windows locks it; Linux refuses with
// ETXTBSY), and the new copy is used from ptyd's next start.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { dataDir } = require('./paths.ts');
const dotenv = require('./dotenv.ts');

const MODES = ['ptyd'];
const EXE = process.platform === 'win32' ? 'ptyd.exe' : 'ptyd';
const REPO = path.join(__dirname, '..', '..');
const RETIRED = 'node-pty was retired (Exit 5); ptyd is the only PTY host. Roll back by checking out the previous commit';

function settingsFile(dir: any = dataDir()) {
  return path.join(dir, 'settings.json');
}

function readSettings(dir: any) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

const DEFAULT_MODE = 'ptyd';

/**
 * The stored mode. `node-pty` is kept visible so the next start can refuse it.
 * `auto` and anything else unset or unknown read as ptyd, the only host.
 */
function readMode(dir?: any) {
  const m = readSettings(dir).ptyHost;
  if (m === 'node-pty') return m;
  if (m === 'auto' || m === 'ptyd') return m === 'auto' ? 'auto' : 'ptyd';
  return DEFAULT_MODE;
}

function writeMode(mode: any, dir: any = dataDir()) {
  if (mode === 'node-pty' || mode === 'auto') throw new Error(`ptyHost=${mode} is not a host. ${RETIRED}`);
  if (!MODES.includes(mode)) throw new Error(`ptyHost must be ptyd. ${RETIRED}`);
  const s = readSettings(dir);
  s.ptyHost = mode;
  fs.mkdirSync(dir, { recursive: true });
  const f = settingsFile(dir);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(`${f}.tmp`, f);
}

type Env = Record<string, string | undefined>;

/**
 * TERMHUB_PTYD (and TERMHUB_PTYD_BIN) as chosen for the next start: the
 * environment, else termhub/.env or the repo's .env. A sessiond exports its own
 * decision (applyToEnv, marked TERMHUB_PTYD_RESOLVED) and every terminal it
 * starts inherits it, so in a script run from a termhub terminal those values
 * describe the running sessiond, not a choice, and are skipped. A terminal
 * (TERMHUB_SESSION_ID) counts as inherited too: a sessiond older than the
 * marker exported TERMHUB_PTYD without it.
 */
function chosen(env: Env = process.env, files: string[] = dotenv.FILES) {
  const own = env.TERMHUB_PTYD_RESOLVED !== '1' && !env.TERMHUB_SESSION_ID;
  const pick = (name: string) => {
    if (own && env[name]) return { value: env[name], source: 'the environment' };
    const f = dotenv.lookup(name, files);
    return f ? { value: f.value, source: path.relative(REPO, f.file) } : { value: undefined, source: '' };
  };
  const v = pick('TERMHUB_PTYD');
  return { value: v.value, source: v.source, bin: pick('TERMHUB_PTYD_BIN').value };
}

function binDir(dir: string = dataDir()) {
  return path.join(dir, 'bin');
}

/** The installed copy `ptyd-current` names, or null. */
function installedBinary(dir: string = dataDir(), exists: (p: string) => boolean = fs.existsSync) {
  let name = '';
  try { name = fs.readFileSync(path.join(binDir(dir), 'ptyd-current'), 'utf8').trim(); } catch { return null; }
  const p = name && path.join(binDir(dir), path.basename(name));
  return p && exists(p) ? p : null;
}

/** The newest build (scripts/build.js's dist/, then cargo's target/release), or null. */
function buildBinary(exists: (p: string) => boolean = fs.existsSync) {
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  return [path.join(REPO, 'dist', platform, EXE), path.join(REPO, 'ptyd', 'target', 'release', EXE)]
    .find((p) => exists(p)) || null;
}

/** A release-grade ptyd binary on this machine, or null. Debug builds don't count. */
function releaseBinary(env: Env = process.env, exists: (p: string) => boolean = fs.existsSync, dir?: string) {
  if (env.TERMHUB_PTYD_BIN && exists(env.TERMHUB_PTYD_BIN)) return env.TERMHUB_PTYD_BIN;
  return installedBinary(dir, exists) || buildBinary(exists);
}

function fileHash(p: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
}

/**
 * Copy the newest build to <dataDir>/bin/ptyd-<hash> and point ptyd-current at
 * it. Never touches a running ptyd; older copies are pruned (the current and
 * the previous stay; Windows also keeps any still running, since it locks them).
 */
function install(dir: string = dataDir(), { dryRun = false, build = buildBinary() }: { dryRun?: boolean; build?: string | null } = {}) {
  if (!build) throw new Error('no ptyd build: node scripts/build.js --only ptyd');
  const name = `ptyd-${fileHash(build)}${process.platform === 'win32' ? '.exe' : ''}`;
  const bdir = binDir(dir);
  const dest = path.join(bdir, name);
  const prev = installedBinary(dir);
  const changed = prev !== dest;
  if (dryRun || !changed) return { build, bin: dest, previous: prev, changed };
  fs.mkdirSync(bdir, { recursive: true });
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(build, `${dest}.tmp`);
    if (process.platform !== 'win32') fs.chmodSync(`${dest}.tmp`, 0o755);
    fs.renameSync(`${dest}.tmp`, dest);
  }
  const cur = path.join(bdir, 'ptyd-current');
  fs.writeFileSync(`${cur}.tmp`, name + '\n');
  fs.renameSync(`${cur}.tmp`, cur);
  const keep = new Set([name, prev && path.basename(prev)]);
  for (const f of fs.readdirSync(bdir)) {
    if (!/^ptyd-[0-9a-f]{12}(\.exe)?$/.test(f) || keep.has(f)) continue;
    try { fs.unlinkSync(path.join(bdir, f)); } catch { /* still running (Windows locks it) */ }
  }
  return { build, bin: dest, previous: prev, changed };
}

/**
 * Pure. What a production start should use. `error` is set when the choice is
 * the removed node-pty path; callers must refuse to start, not pick another host.
 * @returns {{ptyd: boolean, mode: string, bin: string|null, reason: string, error?: string}}
 */
function resolve({ envValue, source, mode, bin }: { envValue?: any; source?: string; mode?: any; bin?: any }) {
  const where = source || 'the environment';
  if (envValue === '0') {
    return { ptyd: false, mode, bin, reason: `TERMHUB_PTYD=0 in ${where}`, error: `TERMHUB_PTYD=0 in ${where} asks for node-pty. ${RETIRED}` };
  }
  if (envValue !== '1' && mode === 'node-pty') {
    return { ptyd: false, mode, bin, reason: 'setting ptyHost=node-pty', error: `setting ptyHost=node-pty. ${RETIRED}` };
  }
  const reason = envValue === '1' ? `TERMHUB_PTYD=1 in ${where}`
    : mode === 'ptyd' ? 'setting ptyHost=ptyd'
    : mode === 'auto' ? 'ptyHost=auto means ptyd (the node-pty fallback is gone)'
    : 'ptyd (the default)';
  return { ptyd: true, mode: mode === 'auto' ? 'auto' : DEFAULT_MODE, bin, reason };
}

/** What the next production start resolves to (status, lib/launch.ts, linux/ptyd-unit.sh). */
function plan(env: Env = process.env) {
  const c = chosen(env);
  return resolve({ envValue: c.value, source: c.source, mode: readMode(), bin: releaseBinary({ TERMHUB_PTYD_BIN: c.bin }) });
}

/** For the entrypoints: decide, export TERMHUB_PTYD=1 (+ _BIN), say so. Throws on the removed path. */
function applyToEnv(env: Env = process.env, log: any = (m: any) => console.log(m)) {
  const r = plan(env);
  if (r.error) {
    log(`[termhub] PTY host: refused (${r.error})`);
    throw new Error(r.error);
  }
  const bin = r.bin;
  if (env.TERMHUB_PTYD_RESOLVED === '1' || env.TERMHUB_SESSION_ID) delete env.TERMHUB_PTYD_BIN;
  env.TERMHUB_PTYD = '1';
  env.TERMHUB_PTYD_RESOLVED = '1';
  if (bin && !env.TERMHUB_PTYD_BIN) env.TERMHUB_PTYD_BIN = bin;
  log(`[termhub] PTY host: ptyd (${r.reason})`);
  return r;
}

function pingSessiond(port: any) {
  return new Promise<any>((resolveP) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res: any) => {
      let b = '';
      res.on('data', (c: any) => (b += c));
      res.on('end', () => { try { resolveP(JSON.parse(b)); } catch { resolveP(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolveP(null));
  });
}

async function main(argv: string[]) {
  const arg = argv[0];
  if (arg === 'install') {
    const r = install(undefined, { dryRun: argv.includes('--dry-run') });
    const verb = argv.includes('--dry-run') ? 'would install' : 'installed';
    console.log(r.changed ? `ptyd: ${verb} ${r.build} as ${r.bin} (used from ptyd's next start)` : `ptyd: ${r.bin} is current`);
    return;
  }
  if (arg && arg !== 'status') {
    writeMode(arg);
    console.log(`ptyHost set to ${arg} in ${settingsFile()}`);
  }
  const mode = readMode();
  const c = chosen();
  const next = plan();
  console.log(`setting:     ${mode}${c.value ? ` (TERMHUB_PTYD=${c.value} in ${c.source} overrides it)` : ''}`);
  console.log(next.error ? `next start:  refused (${next.error})` : `next start:  ptyd (${next.reason})`);
  const port = Number(process.env.TERMHUB_SESSIOND_PORT) || 7010;
  const ping = await pingSessiond(port);
  const running = ping ? ping.ptyHost || 'unknown' : null;
  console.log(`running:     ${running ? `${running} (sessiond pid ${ping.pid} on :${port})` : `no sessiond on :${port}`}`);
  if (next.error) {
    console.log('sessiond will not start on this setting.');
    process.exit(2);
  }
  if (ping && running && running.split(' ')[0] !== 'ptyd') {
    console.log('A sessiond restart is needed. Terminals already in ptyd are adopted; a sessiond still on node-pty ends its terminals once.');
  }
}

module.exports = {
  cli, MODES, DEFAULT_MODE, RETIRED, readMode, writeMode, releaseBinary, installedBinary, buildBinary, install,
  chosen, resolve, plan, applyToEnv, settingsFile,
};

/** `node lib/ptyHost.js [status|...]` (ptyHost.js, the entry the update scripts run). */
function cli(argv: string[] = process.argv.slice(2)) {
  main(argv).catch((e: any) => {
    console.error(e.message || e);
    process.exit(2);
  });
}

if (require.main === module) cli();
