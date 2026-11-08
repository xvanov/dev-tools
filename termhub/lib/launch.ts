'use strict';

// What this machine's termhub tiers run (plan 4.1's front, plan 5.1's ptyd),
// asked by windows/*.ps1, linux/update.sh and server.js so the scripts and the
// processes cannot disagree. Each switch, and its rollback, is one line in
// termhub/.env (or the repo's .env; the environment wins, lib/dotenv.ts):
//
//   TERMHUB_FRONT=node|jarvisd   the front tier: `node front.js` (the default), or
//                                jarvisd's front role from source on the Bun
//                                jarvisd/package.json pins (`bun jarvisd/src/main.ts
//                                front`). Restarting the front never touches a
//                                terminal, so this switch costs a reconnect.
//   TERMHUB_PTYD=1|0             where sessiond keeps its PTYs (lib/ptyHost.ts; unset,
//                                the ptyHost setting decides)
//
//   node lib/launch.js [plan]            both decisions, and why
//   node lib/launch.js front --json      the front's command, for the scripts
//   node lib/launch.js ensure-bun [--dry-run]   install the pinned Bun into
//                                jarvisd/.bun/<version>/ when the front needs it
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('./dotenv.ts');
const ptyHost = require('./ptyHost.ts');

type Env = Record<string, string | undefined>;

const TERMHUB = path.join(__dirname, '..');
const JARVISD = path.join(TERMHUB, '..', 'jarvisd');
const MAIN = path.join(JARVISD, 'src', 'main.ts');
const FRONTS = ['node', 'jarvisd'];

/** A setting from the environment, else termhub/.env or the repo's .env. */
function setting(name: string, env: Env = process.env, files: string[] = dotenv.FILES) {
  if (env[name]) return { value: env[name] as string, source: 'the environment' };
  const f = dotenv.lookup(name, files);
  return f ? { value: f.value, source: path.relative(path.join(TERMHUB, '..'), f.file) } : { value: '', source: '' };
}

function pinnedVersion(jarvisd: string = JARVISD) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(jarvisd, 'package.json'), 'utf8'));
    const v = String((pkg.devDependencies || {}).bun || '');
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function packageVersion(binExe: string) {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(binExe), '..', 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * The pinned Bun on this machine: jarvisd/.bun/<version>/ (a deploy's or
 * ensure-bun's install, never locked by `npm ci`), else jarvisd/node_modules
 * when it holds that version. `exe` is null when neither does.
 */
function pinnedBun(jarvisd: string = JARVISD, exists: (p: string) => boolean = fs.existsSync, version: (exe: string) => string | null = packageVersion) {
  const pin = pinnedVersion(jarvisd);
  if (!pin) return { version: null, exe: null, installDir: null, problem: 'jarvisd/package.json pins no Bun' };
  const installDir = path.join(jarvisd, '.bun', pin);
  const own = path.join(installDir, 'node_modules', 'bun', 'bin', 'bun.exe');
  if (exists(own)) return { version: pin, exe: own, installDir, problem: '' };
  const npm = path.join(jarvisd, 'node_modules', 'bun', 'bin', 'bun.exe');
  if (exists(npm)) {
    const v = version(npm);
    if (v === pin) return { version: pin, exe: npm, installDir, problem: '' };
    return { version: pin, exe: null, installDir, problem: `jarvisd/node_modules has Bun ${v || 'of an unknown version'}, ${pin} is pinned` };
  }
  return { version: pin, exe: null, installDir, problem: `Bun ${pin} is not installed` };
}

/**
 * What the front tier runs. `exe` null means "the scripts' own node, front.js".
 * Asking for jarvisd without its Bun falls back to Node and says so: a missing
 * Bun must never leave the stack without a front.
 */
function frontPlan(env: Env = process.env, { files = dotenv.FILES, bun = pinnedBun() }: { files?: string[]; bun?: ReturnType<typeof pinnedBun> } = {}) {
  const s = setting('TERMHUB_FRONT', env, files);
  const wanted = s.value || 'node';
  const node = { runtime: 'node', wanted, exe: null as string | null, args: ['front.js'], bun };
  if (!FRONTS.includes(wanted)) return { ...node, fallback: true, reason: `TERMHUB_FRONT=${wanted} in ${s.source} is not ${FRONTS.join(' or ')}: node front.js` };
  if (wanted === 'node') return { ...node, fallback: false, reason: s.value ? `TERMHUB_FRONT=node in ${s.source}` : 'TERMHUB_FRONT unset: node front.js (the default)' };
  if (!bun.exe) return { ...node, fallback: true, reason: `TERMHUB_FRONT=jarvisd in ${s.source}, but ${bun.problem} (node lib/launch.js ensure-bun): node front.js instead` };
  return { runtime: 'jarvisd', wanted, exe: bun.exe, args: [MAIN, 'front'], bun, fallback: false, reason: `TERMHUB_FRONT=jarvisd in ${s.source}: jarvisd front on Bun ${bun.version}` };
}

/**
 * Install the pinned Bun into jarvisd/.bun/<version>/ when the front wants
 * jarvisd, even if jarvisd/node_modules holds that version: a front running
 * node_modules' bun.exe would lock it, and `npm ci` in jarvisd/ then fails on
 * Windows (EPERM, as the 2d7fdbf deploy did).
 */
function ensureBun({ dryRun = false, env = process.env }: { dryRun?: boolean; env?: Env } = {}) {
  const wanted = setting('TERMHUB_FRONT', env).value === 'jarvisd';
  const bun = pinnedBun();
  if (!wanted) return { installed: false, reason: 'TERMHUB_FRONT is not jarvisd: no Bun needed' };
  if (!bun.installDir) return { installed: false, reason: bun.problem };
  const own = bun.exe && bun.exe.startsWith(bun.installDir);
  if (own) return { installed: false, reason: `Bun ${bun.version} at ${bun.exe}` };
  if (dryRun) return { installed: false, reason: `would install Bun ${bun.version} into ${bun.installDir}` };
  fs.mkdirSync(bun.installDir, { recursive: true });
  const args = ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', bun.installDir, `bun@${bun.version}`];
  const opts = { cwd: bun.installDir, stdio: 'inherit', windowsHide: true };
  // npm is npm.cmd on Windows, which needs a shell: one string, its arguments quoted
  // (quoting npm.cmd itself makes cmd resolve npm's own files against the cwd).
  const r = process.platform === 'win32'
    ? spawnSync(['npm.cmd', ...args.map((a) => `"${a}"`)].join(' '), { ...opts, shell: true })
    : spawnSync('npm', args, opts);
  // Run it: npm may skip bun's postinstall (install-scripts), and a placeholder
  // that cannot start must not become the front's runtime.
  const exe = pinnedBun().exe || '';
  const v = exe.startsWith(bun.installDir) ? spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true }) : null;
  const got = v && v.status === 0 ? String(v.stdout).trim() : '';
  if (r.status !== 0 || got !== bun.version) {
    fs.rmSync(bun.installDir, { recursive: true, force: true });
    throw new Error(`installing Bun ${bun.version} failed (npm exited ${r.status}${got ? `, it reports ${got}` : ', the binary does not run'}); the front stays on node`);
  }
  return { installed: true, reason: `installed Bun ${bun.version} into ${bun.installDir}` };
}

function cli(argv: string[] = process.argv.slice(2)) {
  const cmd = argv.find((a) => !a.startsWith('--')) || 'plan';
  const json = argv.includes('--json');
  try {
    if (cmd === 'front') {
      const f = frontPlan();
      console.log(json ? JSON.stringify(f) : `front: ${f.runtime} (${f.reason})`);
    } else if (cmd === 'ensure-bun') {
      console.log(`bun: ${ensureBun({ dryRun: argv.includes('--dry-run') }).reason}`);
    } else if (cmd === 'plan') {
      const f = frontPlan();
      const p = ptyHost.plan();
      if (json) console.log(JSON.stringify({ front: f, ptyd: p }));
      else {
        console.log(`front: ${f.runtime === 'jarvisd' ? `jarvisd front (${f.exe} ${MAIN} front)` : 'node front.js'} (${f.reason})`);
        console.log(`ptys:  ${p.ptyd ? `ptyd (${p.bin || 'no release binary'})` : 'node-pty in sessiond'} (${p.reason})`);
      }
    } else {
      throw new Error(`usage: node lib/launch.js [plan|front|ensure-bun] [--json] [--dry-run]`);
    }
  } catch (e: any) {
    console.error(e.message || e);
    process.exit(2);
  }
}

module.exports = { cli, setting, pinnedVersion, pinnedBun, frontPlan, ensureBun, MAIN };
