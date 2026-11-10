#!/usr/bin/env node
// Pre-commit: run only the tests a commit can affect (changed-files mode), after the public-repo guard.
//
//   node scripts/pre-commit-tests.js
//
// For every tool whose `npm test` is scripts/run-tests.js, runs `run-tests.js --changed` (tests that
// transitively import a file changed against HEAD, staged or not). For software-factory, runs
// scripts/changed-pytest.py the same way. Tools run in parallel; typical commit: a few seconds.
// CI still runs the full suites.
//
// Emergency skip (humans only; agents never skip, and never use --no-verify):
//   DEVTOOLS_SKIP_TESTS=1 git commit ...
// The skip is printed, and CI is the backstop. See scripts/README.md.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

if (process.env.DEVTOOLS_SKIP_TESTS) {
  console.error('tests: SKIPPED by DEVTOOLS_SKIP_TESTS (emergency only; CI runs the full suites)');
  process.exit(0);
}

const lines = (s) => s.split(/\r?\n/).filter(Boolean);
const changed = new Set([
  ...lines(execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD', '--'], { cwd: top, encoding: 'utf8' })),
  ...lines(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: top, encoding: 'utf8' })),
]);
// Docs-only commits (markdown, LICENSE) reach no test worth a hook run; CI runs everything.
const isDoc = (f) => /\.md$/i.test(f) || f === 'LICENSE';
for (const f of [...changed]) if (isDoc(f)) changed.delete(f);
if (!changed.size) {
  console.error('tests: docs-only change, nothing to run');
  process.exit(0);
}

function run(label, cmd, args, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = [];
    // Git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE to hooks. Tests that `git init` and commit
    // in their own repos must not inherit them: they would operate on the repo being committed to.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|QUARANTINE_PATH)$/.test(k)) delete env[k];
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('error', (e) => resolve({ label, code: 127, ms: Date.now() - t0, text: String(e) }));
    child.on('close', (code) => resolve({ label, code, ms: Date.now() - t0, text: Buffer.concat(out).toString('utf8') }));
  });
}

const jobs = [];
for (const d of fs.readdirSync(top, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
  const pkg = path.join(top, d.name, 'package.json');
  if (!fs.existsSync(pkg)) continue;
  let test = '';
  try { test = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts?.test || ''; } catch { continue; }
  if (!test.includes('run-tests.js')) continue;
  if (!fs.existsSync(path.join(top, d.name, 'node_modules'))) {
    console.error(`tests: ${d.name}: node_modules missing, not run (npm install there)`);
    continue;
  }
  jobs.push(run(d.name, process.execPath, [path.join(top, 'scripts', 'run-tests.js'), '--changed', '--timeout', '300'], path.join(top, d.name)));
}
const factoryTouched = [...changed].some((f) => f.startsWith('software-factory/') || f === 'scripts/changed-pytest.py');
if (factoryTouched) {
  const py = process.platform === 'win32' ? ['python'] : ['python3', 'python'];
  jobs.push(run('software-factory', py[0], [path.join(top, 'scripts', 'changed-pytest.py'), '--no-sync'], top));
}

Promise.all(jobs).then((results) => {
  let bad = 0;
  for (const r of results) {
    // run-tests.js prints "changed mode: ..." / "N passed, ..." lines; show a one-line verdict per tool.
    const summary = r.text.split(/\r?\n/).filter((l) => /changed mode|nothing to run|\d+ passed|\d+ failed/.test(l)).map((l) => l.trim()).join(' | ');
    if (r.code === 0) console.error(`tests: ${r.label}: ok (${(r.ms / 1000).toFixed(1)}s) ${summary}`);
    else {
      bad++;
      console.error(`tests: ${r.label}: FAILED (exit ${r.code}, ${(r.ms / 1000).toFixed(1)}s)`);
      console.error(r.text.trimEnd());
    }
  }
  if (bad) {
    console.error('\ncommit blocked: fix the tests above (DEVTOOLS_SKIP_TESTS=1 skips this hook; humans, emergencies only).');
    process.exit(1);
  }
});
