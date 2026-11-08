#!/usr/bin/env node
'use strict';

// One command that builds everything this repo compiles (plan T7):
//
//   node scripts/build.js [--release|--local|--debug] [--only <target>[,<target>]] [--out <dir>] [--list]
//
// Profiles: --release (LTO; the default in CI, what artifacts are made from),
// --local (the default elsewhere: release-speed code without LTO, incremental,
// so a one-file change rebuilds in seconds: ptyd measured 9 s, a no-op 0.4 s),
// --debug.
//
// Targets build in parallel, each into dist/<os>-<arch>/, with a manifest.json
// (name, file, bytes, sha256, commit, profile, seconds) beside them. CI runs it
// per OS and publishes dist/ as a build artifact.
//
// Targets today:
//   ptyd     cargo build. Locally incremental; in CI (CARGO_INCREMENTAL=0) through
//            sccache when it is on PATH (RUSTC_WRAPPER is set only if unset).
//   desktop  the Tauri desktop shell (plan 7.6). --release bundles installers
//            (NSIS .exe on Windows, .deb on Linux); other profiles build the
//            binary only (`tauri build --debug --no-bundle`). Needs `npm ci` in
//            desktop/ (the Tauri CLI), and on Linux the WebKitGTK dev packages.
//   jarvisd  `bun build --compile` of jarvisd/src/main.ts (plan 4.1): one executable
//            with the Bun runtime and the PA worker's whole module graph bundled in.
//            Needs `npm ci` in jarvisd/ (Bun comes from npm) and personal-assistant/.
//
// Signing is plan 7.4. The hook is here already: with DEVTOOLS_SIGN_CMD set,
// every artifact is passed to it (`<cmd> <file>`, run through the shell) after
// it is built, and the manifest records `signed: true`. Unset, nothing is
// signed and the manifest says `signed: false`.
//
// Exit code: non-zero if any target that was not skipped failed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const TAURI_CLI = path.join(REPO, 'desktop', 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const PLATFORM =`${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;

function onPath(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function cargoBin() {
  if (onPath('cargo')) return 'cargo';
  const home = path.join(os.homedir(), '.cargo', 'bin', `cargo${EXE}`);
  return fs.existsSync(home) ? home : null;
}

const TARGETS = {
  ptyd: {
    describe: 'Rust terminal host (ptyd/), cargo + sccache',
    available() {
      return cargoBin() ? null : 'no cargo (install rustup: https://rustup.rs)';
    },
    command({ profile }) {
      const env = { ...process.env };
      // CI sets CARGO_INCREMENTAL=0: sccache cannot cache incremental units.
      if (!env.RUSTC_WRAPPER && env.CARGO_INCREMENTAL === '0' && onPath('sccache')) env.RUSTC_WRAPPER = 'sccache';
      return {
        cmd: cargoBin(),
        args: ['build', '--locked', '--profile', profile === 'debug' ? 'dev' : profile],
        cwd: path.join(REPO, 'ptyd'),
        env,
        artifacts: [path.join(REPO, 'ptyd', 'target', profile, `ptyd${EXE}`)],
      };
    },
  },
  desktop: {
    describe: 'Jarvis desktop shell (desktop/, Tauri 2): installers on --release',
    available() {
      if (!cargoBin()) return 'no cargo (install rustup: https://rustup.rs)';
      if (!fs.existsSync(TAURI_CLI)) return 'no Tauri CLI (npm ci in desktop/)';
      return null;
    },
    command({ profile }) {
      const release = profile === 'release';
      const target = path.join(REPO, 'desktop', 'src-tauri', 'target');
      const env = { ...process.env };
      if (!env.RUSTC_WRAPPER && env.CARGO_INCREMENTAL === '0' && onPath('sccache')) env.RUSTC_WRAPPER = 'sccache';
      // cargo has to be findable by the Tauri CLI too.
      const cargo = cargoBin();
      if (cargo && cargo !== 'cargo') env.PATH = `${path.dirname(cargo)}${path.delimiter}${env.PATH || ''}`;
      return {
        cmd: process.execPath,
        // Release builds the installers (NSIS on Windows, .deb on Linux); the
        // other profiles build the bare binary, so a local rebuild stays incremental.
        args: [TAURI_CLI, 'build', ...(release ? [] : ['--debug', '--no-bundle'])],
        cwd: path.join(REPO, 'desktop'),
        env,
        artifacts: () => {
          if (!release) return [path.join(target, 'debug', `jarvis-desktop${EXE}`)];
          const out = [];
          for (const [dir, ext] of [['nsis', '.exe'], ['deb', '.deb']]) {
            const d = path.join(target, 'release', 'bundle', dir);
            if (!fs.existsSync(d)) continue;
            for (const f of fs.readdirSync(d)) if (f.endsWith(ext)) out.push(path.join(d, f));
          }
          return out;
        },
      };
    },
  },
  jarvisd: {
    describe: 'TypeScript/Bun core, `bun build --compile` (plan 4.1; jarvisd/, docs/native/JARVISD.md)',
    available() {
      if (!fs.existsSync(path.join(REPO, 'jarvisd', 'node_modules', 'bun', 'bin', 'bun.exe'))) return 'jarvisd/node_modules missing (npm ci in jarvisd/ and personal-assistant/)';
      if (!fs.existsSync(path.join(REPO, 'personal-assistant', 'node_modules'))) return 'personal-assistant/node_modules missing (npm ci there: the worker is bundled in)';
      return null;
    },
    command({ profile }) {
      // The npm package's own binary (bin/bun.exe on every OS), not the .cmd shim spawn() cannot run.
      const bun = path.join(REPO, 'jarvisd', 'node_modules', 'bun', 'bin', 'bun.exe');
      const out = path.join(REPO, 'jarvisd', 'dist', 'jarvisd');
      const args = ['build', '--compile', 'src/main.ts', '--outfile', out];
      if (profile !== 'debug') args.push('--minify-syntax', '--minify-whitespace');
      return { cmd: bun, args, cwd: path.join(REPO, 'jarvisd'), env: { ...process.env }, artifacts: [`${out}${EXE}`] };
    },
  },
};

function parseArgs(argv) {
  const o = { profile: process.env.CI ? 'release' : 'local', only: null, out: path.join(REPO, 'dist'), list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--debug') o.profile = 'debug';
    else if (a === '--release') o.profile = 'release';
    else if (a === '--local') o.profile = 'local';
    else if (a === '--list') o.list = true;
    else if (a === '--only') o.only = argv[++i].split(',');
    else if (a.startsWith('--only=')) o.only = a.slice(7).split(',');
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a.startsWith('--out=')) o.out = path.resolve(a.slice(6));
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.only) for (const t of o.only) if (!TARGETS[t]) throw new Error(`unknown target ${t} (have: ${Object.keys(TARGETS).join(', ')})`);
  return o;
}

function run({ cmd, args, cwd, env }, name) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    let log = '';
    const tee = (c) => {
      log += c;
      for (const line of String(c).split(/\r?\n/)) if (line.trim()) process.stdout.write(`[${name}] ${line}\n`);
    };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);
    child.on('error', (e) => resolve({ code: -1, log: log + String(e) }));
    child.on('exit', (code) => resolve({ code, log }));
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function commit() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Plan 7.4 hook: sign one artifact in place. Returns true when it was signed. */
function sign(file) {
  const cmd = process.env.DEVTOOLS_SIGN_CMD;
  if (!cmd) return false;
  const r = spawnSync(`${cmd} "${file}"`, { shell: true, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`DEVTOOLS_SIGN_CMD failed for ${file} (${r.status})`);
  return true;
}

async function buildOne(name, opts, outDir) {
  const t = TARGETS[name];
  const why = t.available();
  if (why) return { name, status: 'skipped', note: why, seconds: 0 };
  const spec = t.command(opts);
  const t0 = Date.now();
  const { code } = await run(spec, name);
  const seconds = (Date.now() - t0) / 1000;
  if (code !== 0) return { name, status: 'failed', note: `exit ${code}`, seconds };
  const artifacts = [];
  const sources = typeof spec.artifacts === 'function' ? spec.artifacts() : spec.artifacts;
  if (!sources.length) return { name, status: 'failed', note: 'built, but produced no artifact', seconds };
  for (const src of sources) {
    if (!fs.existsSync(src)) return { name, status: 'failed', note: `no artifact at ${src}`, seconds };
    const dest = path.join(outDir, path.basename(src));
    fs.copyFileSync(src, dest);
    const signed = sign(dest);
    artifacts.push({ file: path.basename(dest), bytes: fs.statSync(dest).size, sha256: sha256(dest), signed });
  }
  return { name, status: 'ok', seconds, artifacts };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const [n, t] of Object.entries(TARGETS)) console.log(`${n.padEnd(10)} ${t.describe}${t.available() ? `  [${t.available()}]` : ''}`);
    return 0;
  }
  const names = opts.only || Object.keys(TARGETS);
  const outDir = path.join(opts.out, PLATFORM);
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const results = await Promise.all(names.map((n) => buildOne(n, opts, outDir)));
  const manifest = {
    platform: PLATFORM,
    profile: opts.profile,
    commit: commit(),
    builtAt: new Date().toISOString(),
    targets: results,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log('\ntarget     result   time     artifacts');
  for (const r of results) {
    const arts = (r.artifacts || []).map((a) => `${a.file} (${(a.bytes / 1048576).toFixed(1)} MB)`).join(', ');
    console.log(`${r.name.padEnd(10)} ${r.status.padEnd(8)} ${(r.seconds.toFixed(1) + 's').padEnd(8)} ${arts || r.note || ''}`);
  }
  console.log(`\n${PLATFORM} ${manifest.profile} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.relative(REPO, outDir) || outDir}`);
  return results.some((r) => r.status === 'failed') ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(2);
  });
}

module.exports = { TARGETS, parseArgs, PLATFORM };
