'use strict';

// The one-command install (plan 7.7): install.ps1 at the repo root and its read-only helper
// scripts/install-facts.js. The helper's node_modules-vs-lockfile check runs everywhere; the
// script itself runs only as -DryRun, against throwaway repo trees (DEVTOOLS_INSTALL_ROOT) with a
// fake PA config and a fake task list (DEVTOOLS_INSTALL_TASKS_FILE), every service port pointed at
// a closed one. It asserts the decisions: a fresh tree gets npm ci, the new-system .env defaults,
// a generated store key and the per-tool installers; an installed tree is left as it is; a
// PA_DB line, a Postgres-installed PA and a keyless store are never switched; and nothing in the
// tree changes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');
const { deps } = require('../../scripts/install-facts');

const REPO = path.join(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'install.ps1');
const WIN = process.platform === 'win32';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const json = (file, v) => write(file, JSON.stringify(v, null, 2));
function lockfile(dir, pkgs) {
  json(path.join(dir, 'package.json'), { name: path.basename(dir), version: '1.0.0' });
  json(path.join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: { '': { name: path.basename(dir) }, ...pkgs } });
}
function installed(dir, name, version) {
  json(path.join(dir, 'node_modules', name, 'package.json'), { name, version });
}

// --- install-facts deps -------------------------------------------------------------------------

{
  const dir = tmp('install-deps-');
  try {
    lockfile(dir, {
      'node_modules/a': { version: '1.0.0' },
      'node_modules/a/node_modules/b': { version: '2.0.0' },
      'node_modules/dev-only': { version: '1.0.0', dev: true },
      'node_modules/@scope/win32-bin': { version: '3.0.0', optional: true },
      'node_modules/linked': { resolved: '../elsewhere', link: true },
    });
    assert.strictEqual(deps(dir).state, 'missing', 'no node_modules');

    installed(dir, 'a', '1.0.0');
    installed(dir, 'a/node_modules/b', '2.0.0');
    let r = deps(dir);
    assert.strictEqual(r.state, 'stale', 'a dev package is missing');
    assert.deepStrictEqual(r.stale, ['dev-only@1.0.0 (missing)']);
    r = deps(dir, { omitDev: true });
    assert.strictEqual(r.state, 'fresh', `--omit-dev skips dev packages: ${JSON.stringify(r)}`);
    assert.strictEqual(r.checked, 2, 'an absent optional package and a link are not counted');

    installed(dir, 'dev-only', '1.0.0');
    assert.strictEqual(deps(dir).state, 'fresh');
    installed(dir, '@scope/win32-bin', '2.9.0');
    r = deps(dir);
    assert.strictEqual(r.state, 'stale', 'an optional package that is there counts');
    assert.deepStrictEqual(r.stale, ['@scope/win32-bin@3.0.0 (have 2.9.0)']);

    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{ not json');
    assert.strictEqual(deps(dir).state, 'no-lock');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (!WIN) {
  console.log('install.test.js: install-facts ok; install.ps1 is Windows-only, its dry runs skipped');
  process.exit(0);
}

// --- install.ps1 --------------------------------------------------------------------------------

for (const f of [SCRIPT, path.join(REPO, 'personal-assistant', 'windows', 'install.ps1')]) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e); $e | % { "$($_.Extent.StartLineNumber): $($_.Message)" }`],
  { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.stdout.trim(), '', `${path.relative(REPO, f)} parses: ${r.stdout}${r.stderr}`);
}

const CLOSED = '1';

// A repo tree install.ps1 can inspect: the three npm packages, and a PA config (src/config.ts,
// plain CommonJS so any Node loads it) that reads the store path and key sources from facts.json.
function tree({ fresh }) {
  const root = tmp('install-root-');
  const local = tmp('install-local-');
  const pa = path.join(root, 'personal-assistant');
  for (const d of ['personal-assistant', 'jarvisd', 'termhub']) {
    lockfile(path.join(root, d), { 'node_modules/a': { version: '1.0.0' } });
    if (!fresh) installed(path.join(root, d), 'a', '1.0.0');
  }
  write(path.join(pa, '.env.example'), '# example\n');
  write(path.join(pa, 'src', 'config.ts'), [
    "const fs = require('fs'), path = require('path');",
    "const f = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'facts.json'), 'utf8'));",
    'module.exports = { config: { sqlitePath: f.sqlitePath }, secretSource: (n) => f.secrets[n] || null };',
    '',
  ].join('\n'));
  const sqlitePath = path.join(local, 'personal-assistant', 'pa.sqlite');
  const facts = { sqlitePath, secrets: {} };
  let tasks = [];
  if (!fresh) {
    write(path.join(pa, '.env'), `PA_DISPATCH_PORT=${CLOSED}\r\nPA_RUNTIME=jarvisd\r\nPA_DB=sqlite\r\n`);
    write(path.join(root, 'termhub', '.env'), 'TERMHUB_FRONT=jarvisd\nTERMHUB_PTYD=1\n');
    write(sqlitePath, 'store');
    facts.secrets = { PA_SQLITE_KEY: 'credential-manager', PA_BACKUP_KEY: 'credential-manager' };
    write(path.join(root, 'jarvisd', 'dist', 'jarvisd-abc1234.exe'), '');
    write(path.join(root, 'jarvisd', 'dist', 'current'), 'jarvisd-abc1234.exe\n');
    write(path.join(local, 'personal-assistant', 'teams-venv', 'Scripts', 'python.exe'), '');
    tasks = [
      { TaskName: 'pa-worker', State: 'Ready', Arguments: `conhost.exe --headless powershell.exe -File "${pa}\\windows\\pa-launch.ps1"` },
      { TaskName: 'pa-capture-mic', State: 'Running', Arguments: 'audio\\capture.py --stream mic' },
      { TaskName: 'pa-capture-loopback', State: 'Running', Arguments: 'audio\\capture.py --stream loopback' },
      { TaskName: 'Termhub', State: 'Ready', Arguments: `conhost.exe --headless powershell.exe -File "${root}\\termhub\\windows\\start.ps1"` },
      { TaskName: 'TermhubWatchdog', State: 'Ready', Arguments: `-File "${root}\\termhub\\watchdog\\watchdog.ps1"` },
      { TaskName: 'factory-serve', State: 'Running', Arguments: `${root}\\software-factory\\.venv\\Scripts\\python.exe -m factory serve` },
    ];
  }
  json(path.join(root, 'facts.json'), facts);
  const data = path.join(local, 'termhub');
  json(path.join(data, 'state.json'), { sessiondPort: Number(CLOSED), activeFrontPort: Number(CLOSED), publishPort: Number(CLOSED) });
  const tasksFile = path.join(local, 'tasks.json');
  json(tasksFile, tasks);
  return { root, local, pa, facts, tasksFile, sqlitePath };
}

// PowerShell and the CLIs it runs keep their own caches under LOCALAPPDATA: only ours are compared.
const OURS = new Set(['personal-assistant', 'termhub', 'tasks.json']);
function snapshot(dir, onlyOurs = false) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (onlyOurs && d === dir && !OURS.has(e.name)) continue;
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function dryRun(t, args = []) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(PA_|TERMHUB_|FACTORY_|DEVTOOLS_)/.test(k)) delete env[k];
  Object.assign(env, {
    DEVTOOLS_INSTALL_ROOT: t.root,
    DEVTOOLS_INSTALL_TASKS_FILE: t.tasksFile,
    DEVTOOLS_INSTALL_NO_LOGIN_CHECK: '1',
    LOCALAPPDATA: t.local,
    TERMHUB_DATA_DIR: path.join(t.local, 'termhub'),
    PA_DISPATCH_PORT: CLOSED,
    TERMHUB_PTYD_PORT: CLOSED,
    FACTORY_SERVE_PORT: CLOSED,
  });
  const before = { root: snapshot(t.root), local: snapshot(t.local, true) };
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-DryRun', ...args],
      { encoding: 'utf8', env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = stdout + stderr;
        assert.strictEqual(err ? err.code : 0, 0, `install.ps1 -DryRun ${args.join(' ')} exits 0:\n${out}`);
        assert.deepStrictEqual({ root: snapshot(t.root), local: snapshot(t.local, true) }, before, `a dry run changes nothing:\n${out}`);
        resolve(out);
      });
  });
}

const section = (out, from, to) => out.slice(out.indexOf(`== ${from}`), to ? out.indexOf(`== ${to}`) : undefined);
const has = (out, re, what) => assert.match(out, re, `${what}:\n${out}`);
const hasNot = (out, re, what) => assert.doesNotMatch(out, re, `${what}:\n${out}`);
const woulds = (out) => out.split(/\r?\n/).filter((l) => /^install: would /.test(l));

(async () => {
  const trees = [];
  const make = (o) => { const t = tree(o); trees.push(t); return t; };
  try {
    const fresh = make({ fresh: true });
    const done = make({ fresh: false });

    // Decision variants on the installed tree's shape.
    const postgresLine = make({ fresh: false });
    write(path.join(postgresLine.pa, '.env'), `PA_DISPATCH_PORT=${CLOSED}\nPA_RUNTIME=jarvisd\nPA_DB=postgres\n`);
    fs.rmSync(postgresLine.sqlitePath);

    const postgresInstalled = make({ fresh: false });
    write(path.join(postgresInstalled.pa, '.env'), `PA_DISPATCH_PORT=${CLOSED}\nPA_RUNTIME=jarvisd\n`);
    fs.rmSync(postgresInstalled.sqlitePath);

    const keyless = make({ fresh: false });
    write(path.join(keyless.pa, '.env'), `PA_DISPATCH_PORT=${CLOSED}\nPA_RUNTIME=jarvisd\n`);
    json(path.join(keyless.root, 'facts.json'), { ...keyless.facts, secrets: { PA_BACKUP_KEY: 'credential-manager' } });

    const adopt = make({ fresh: false });
    write(path.join(adopt.pa, '.env'), `PA_DISPATCH_PORT=${CLOSED}\nPA_RUNTIME=node\n`);
    write(path.join(adopt.root, 'termhub', '.env'), 'TERMHUB_FRONT=\nTERMHUB_PTYD=0\n');

    // Tasks registered from an elevated shell (their files belong to Administrators).
    const elevated = make({ fresh: false });
    const elevatedTasks = JSON.parse(fs.readFileSync(elevated.tasksFile, 'utf8')).map((t) => (
      ['pa-worker', 'TermhubWatchdog', 'factory-serve'].includes(t.TaskName) ? { ...t, Admin: true } : t));
    elevatedTasks.find((t) => t.TaskName === 'factory-serve').Arguments = 'C:\\elsewhere\\.venv\\Scripts\\python.exe -m factory serve';
    json(elevated.tasksFile, elevatedTasks);

    const customServe = make({ fresh: false });
    json(customServe.tasksFile, JSON.parse(fs.readFileSync(customServe.tasksFile, 'utf8')).map((t) => (
      t.TaskName === 'factory-serve' ? { ...t, Arguments: `${t.Arguments} --supervise --interval 120 --app sample` } : t)));

    const [a, b, c, d, e, f, g, h, k] = await Promise.all([
      dryRun(fresh), dryRun(done), dryRun(postgresLine), dryRun(postgresInstalled), dryRun(keyless), dryRun(adopt),
      dryRun(done, ['-Reinstall']), dryRun(elevated, ['-Reinstall']), dryRun(customServe, ['-Reinstall']),
    ]);

    // A fresh tree: everything to do, each by its own tool.
    has(a, /would npm ci --no-audit --no-fund in personal-assistant \(no node_modules\)/, 'fresh: npm ci in the PA');
    has(a, /would npm ci --no-audit --no-fund in jarvisd/, 'fresh: npm ci in jarvisd');
    has(a, /would npm ci --no-audit --no-fund --omit=dev --ignore-scripts in termhub/, "fresh: termhub's npm ci as its installer does it");
    has(a, /would write personal-assistant\\\.env from \.env\.example/, 'fresh: a PA .env');
    has(a, /would add PA_RUNTIME=jarvisd to personal-assistant\\\.env/, 'fresh: PA_RUNTIME');
    has(a, /would add TERMHUB_FRONT=jarvisd to termhub\\\.env/, 'fresh: TERMHUB_FRONT');
    has(a, /would add TERMHUB_PTYD=1 to termhub\\\.env/, 'fresh: TERMHUB_PTYD');
    has(a, /would build jarvisd/, 'fresh: the jarvisd build, PA_RUNTIME being jarvisd');
    has(a, /would generate PA_SQLITE_KEY .*never printed/, 'fresh: a generated store key');
    has(a, /would create the encrypted store at /, 'fresh: the store');
    has(a, /would add PA_DB=sqlite to personal-assistant\\\.env/, 'fresh: PA_DB');
    has(a, /would create PA_BACKUP_KEY in the vault \(pa backup key init\)/, 'fresh: the backup key');
    has(a, /would run personal-assistant\\windows\\install\.ps1 -SkipDatabase.* \(pa-worker is missing\)/, "fresh: the PA's installer");
    has(a, /would run termhub\\windows\\ptyd\.ps1 -Ensure/, 'fresh: ptyd');
    has(a, /would run termhub\\windows\\install\.ps1 \(the Termhub task is missing\)/, "fresh: termhub's installer");
    has(a, /would run software-factory\\scripts\\windows\\install-serve\.ps1 -SkipSync \(factory-serve is missing\)/, "fresh: the factory's installer");
    has(a, /PA: nothing answers on :1; would run windows\\redeploy\.ps1 -Restart/, 'fresh: the PA started');
    has(a, /termhub: sessiond down, front down; would run windows\\start\.ps1/, 'fresh: termhub started');
    has(a, /factory: nothing answers on :1; would run Start-ScheduledTask factory-serve/, 'fresh: serve started');

    // Installed: every setup step finds its work done (the services themselves are down here).
    const setup = section(b, 'settings', 'start');
    assert.deepStrictEqual(woulds(setup).filter((l) => !/ptyd\.ps1 -Ensure/.test(l)), [], `installed: nothing to do:\n${setup}`);
    has(b, /PA_RUNTIME=jarvisd \(personal-assistant\\\.env\): kept/, 'installed: PA_RUNTIME kept');
    has(b, /TERMHUB_FRONT=jarvisd \(termhub\\\.env\): kept/, 'installed: TERMHUB_FRONT kept');
    has(b, /PA_DB=sqlite \(personal-assistant\\\.env\) and the store exists: kept/, 'installed: the store kept');
    has(b, /personal-assistant: node_modules matches package-lock\.json/, 'installed: deps kept');
    has(b, /jarvisd: jarvisd-abc1234\.exe is built/, 'installed: the build kept');
    has(b, /pa-worker runs this checkout's windows\\pa-launch\.ps1/, 'installed: pa-worker kept');
    has(b, /factory-serve runs this checkout's factory serve: kept/, 'installed: factory-serve kept');

    // A PA_DB line is never overridden, whatever it says.
    has(c, /PA_DB=postgres \(personal-assistant\\\.env\): kept/, 'PA_DB=postgres kept');
    hasNot(c, /would (create the encrypted store|add PA_DB)/, 'PA_DB=postgres: no store');

    // An installed PA with no store runs on Postgres: the cutover moves it, not this.
    has(d, /it runs on Postgres\. Not switched; docs\/native\/CUTOVER-SQLITE\.md/, 'Postgres PA: not switched');
    hasNot(d, /would (create the encrypted store|add PA_DB|generate PA_SQLITE_KEY)/, 'Postgres PA: no store');

    // A store nobody can open: PA_DB stays unset, the owner is told. An empty KEY= line is a setting.
    has(e, /a store exists but PA_SQLITE_KEY is not set anywhere: PA_DB left unset/, 'keyless store: warned');
    has(e, /needs you: put the store's key in the vault/, 'keyless store: the owner is told');
    hasNot(e, /would (add PA_DB|generate PA_SQLITE_KEY|create the encrypted store)/, 'keyless store: no new key over it');

    // Settings already there, even ones that are not the new defaults, are kept; a store with its
    // key and no PA_DB line is adopted.
    has(f, /PA_RUNTIME=node \(personal-assistant\\\.env\): kept/, 'PA_RUNTIME=node kept');
    has(f, /TERMHUB_FRONT= \(termhub\\\.env\): kept/, 'an empty line kept');
    has(f, /TERMHUB_PTYD=0 \(termhub\\\.env\): kept/, 'TERMHUB_PTYD=0 kept');
    has(f, /jarvisd: PA_RUNTIME is node: no executable needed/, 'no jarvisd build on node');
    has(f, /would add PA_DB=sqlite to personal-assistant\\\.env/, 'a keyed store adopted');
    hasNot(f, /would (generate PA_SQLITE_KEY|create the encrypted store)/, 'the adopted store is not recreated');

    // -Reinstall: the installers run again and the services restart; data stays.
    has(g, /reinstall, dry run/, 'reinstall: says so');
    has(g, /would build jarvisd/, 'reinstall: rebuilds jarvisd');
    has(g, /would run personal-assistant\\windows\\install\.ps1 -SkipDatabase.* \(reinstall\)/, "reinstall: the PA's installer");
    has(g, /would run termhub\\watchdog\\install-watchdog\.ps1 \(re-register\)/, 'reinstall: the watchdog');
    has(g, /would run software-factory\\scripts\\windows\\install-serve\.ps1 -SkipSync \(reinstall\)/, "reinstall: the factory's installer");
    hasNot(g, /would (npm |add |generate |create the encrypted)/, 'reinstall: no deps, settings or keys redone');
    hasNot(g, /would run termhub\\windows\\install\.ps1/, "reinstall: termhub's installer (it stops the tiers) not rerun over a good task");

    // From a normal shell, a task registered elevated is kept when right and named when wrong:
    // re-registering it would fail with access denied.
    has(h, /pa-worker was registered from an elevated shell: kept/, 'elevated pa-worker kept');
    has(h, /would run personal-assistant\\windows\\install\.ps1 -SkipDatabase -NoWorker/, 'the PA installer leaves pa-worker alone');
    has(h, /TermhubWatchdog runs this checkout's watchdog\.ps1; registered from an elevated shell: kept/, 'elevated watchdog kept');
    hasNot(h, /would run termhub\\watchdog\\install-watchdog\.ps1/, 'elevated watchdog not re-registered');
    has(h, /needs you: factory-serve is elsewhere and was registered from an elevated shell/, 'a wrong elevated task is named');
    hasNot(h, /would run software-factory\\scripts\\windows\\install-serve\.ps1/, 'and not re-registered');

    // install-serve.ps1 registers its defaults: a serve task with its own --app/--interval is kept.
    has(k, /factory-serve runs this checkout's factory serve with its own --app\/--interval: kept/, 'custom serve args kept');
    hasNot(k, /would run software-factory\\scripts\\windows\\install-serve\.ps1/, 'custom serve not re-registered');

    console.log('install.test.js: ok');
  } finally {
    for (const t of trees) for (const d of [t.root, t.local]) fs.rmSync(d, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
