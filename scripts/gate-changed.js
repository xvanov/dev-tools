#!/usr/bin/env node
// The factory's test gate for the dev-tools monorepo (plan E5.7): run the tests a story's
// change can affect, not every suite.
//
//   node scripts/gate-changed.js [--since REF]        (from the repo root; default REF: origin/main)
//
// Changed = files that differ from the merge base with REF (the story's commits plus any
// uncommitted edits). For every tool whose `npm test` is scripts/run-tests.js and that has a
// changed file: `npm ci` when node_modules is missing (a story worktree has none; skipping would
// be a false green), then `run-tests.js --changed --since <base>`. For software-factory:
// `uv sync --all-extras` when .venv is missing, then `scripts/changed-pytest.py --since <base>`
// (its smoke cap applies; CI runs full suites). Tools run in parallel. Exit 0 only when every
// selected tool is green; a tool that cannot run is a failure, never a skip.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const ref = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : 'origin/main';
const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...a) => execFileSync('git', a, { cwd: top, encoding: 'utf8' });
const lines = (s) => s.split(/\r?\n/).filter(Boolean);

let base;
try {
  base = git('merge-base', 'HEAD', ref).trim();
} catch {
  console.error(`gate: cannot find the merge base with ${ref}`);
  process.exit(2);
}
const changed = new Set([
  ...lines(git('diff', '--name-only', '--no-renames', base, '--')),
  ...lines(git('ls-files', '--others', '--exclude-standard')),
]);
console.error(`gate: ${changed.size} file(s) changed since ${base.slice(0, 8)} (${ref})`);
if (!changed.size) process.exit(0);

// Hooks export GIT_DIR & co.; tests that init their own repos must not inherit them.
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)) delete env[k];

function run(label, cmd, args, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = [];
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' && /^(npm|uv)$/.test(cmd) });
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('error', (e) => resolve({ label, code: 127, ms: Date.now() - t0, text: String(e) }));
    child.on('close', (code) => resolve({ label, code, ms: Date.now() - t0, text: Buffer.concat(out).toString('utf8') }));
  });
}

async function nodeTool(name) {
  const dir = path.join(top, name);
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    const r = await run(`${name} (npm ci)`, 'npm', ['ci', '--no-audit', '--no-fund'], dir);
    if (r.code !== 0) return r;
  }
  return run(name, process.execPath, [path.join(top, 'scripts', 'run-tests.js'), '--changed', '--since', base, '--timeout', '300'], dir);
}

async function factory() {
  const dir = path.join(top, 'software-factory');
  if (!fs.existsSync(path.join(dir, '.venv'))) {
    const r = await run('software-factory (uv sync)', 'uv', ['sync', '--all-extras'], dir);
    if (r.code !== 0) return r;
  }
  const py = path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return run('software-factory', py, [path.join(top, 'scripts', 'changed-pytest.py'), '--since', base], top);
}

const jobs = [];
for (const d of fs.readdirSync(top, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
  const pkg = path.join(top, d.name, 'package.json');
  if (!fs.existsSync(pkg)) continue;
  let test = '';
  try { test = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts?.test || ''; } catch { continue; }
  if (!test.includes('run-tests.js')) continue;
  const prefix = `${d.name}/`;
  const touched = [...changed].some((f) => f.startsWith(prefix) || f === 'scripts/run-tests.js');
  if (touched) jobs.push(nodeTool(d.name));
}
if ([...changed].some((f) => f.startsWith('software-factory/') || f === 'scripts/changed-pytest.py')) jobs.push(factory());
if (!jobs.length) {
  console.error('gate: no tested tool touched; nothing to run');
  process.exit(0);
}

Promise.all(jobs).then((results) => {
  let bad = 0;
  for (const r of results) {
    const summary = r.text.split(/\r?\n/).filter((l) => /changed mode|nothing to run|\d+ passed|\d+ failed/.test(l)).map((l) => l.trim()).join(' | ');
    if (r.code === 0) console.error(`gate: ${r.label}: ok (${(r.ms / 1000).toFixed(1)}s) ${summary}`);
    else {
      bad++;
      console.error(`gate: ${r.label}: FAILED (exit ${r.code}, ${(r.ms / 1000).toFixed(1)}s)`);
      console.error(r.text.trimEnd());
    }
  }
  process.exit(bad ? 1 : 0);
});
