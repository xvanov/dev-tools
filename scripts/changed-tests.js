'use strict';
// Changed-files mode for scripts/run-tests.js: which test files can a change touch?
//
//   affected({ cwd, testFiles, touches, since }) -> { all, reason, selected, changed }
//
// A test file is selected when it is itself changed, or when anything it can reach changed. What it
// can reach is a static graph built with a few regexes (no parser, no dependencies):
//   - require('./x'), import ... from './x', import('./x'), export ... from './x' (relative only;
//     packages are not edges), resolved like Node does (.js .cjs .mjs .json, /index.js);
//   - any quoted file name in a reached file (`'talk.page.js'`, `'../src/x.html'`): tests read plenty
//     of files with fs instead of require, so a string that names a file counts as an edge to every
//     changed file with that base name. Over-selecting is fine; under-selecting is the bug;
//   - `touches` from <tool>/test/runner.config.js: { 'x.test.js': ['src/', 'bin/'] } for tests that
//     walk a directory instead of naming files (syntax.test.js);
//   - `narrow` (same shape): for a slow test that reaches nearly everything through one entry point,
//     ONLY its own file and the listed paths select it. The full suite (CI) still runs it.
// Changes to the runner itself, the tool's package.json / lockfile or its runner.config.js select
// everything. "Changed" is `git diff HEAD` (staged + unstaged) plus untracked files; `since` swaps
// HEAD for another ref (CI: the merge base).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXTS = ['', '.js', '.cjs', '.mjs', '.json'];
const SPEC_RES = [
  /\brequire\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
  /\bimport\s+(?:[^'";]*?\s+from\s+)?(['"])([^'"\n]+)\1/g,
  /\bimport\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
  /\bexport\s+[^'";]*?\s+from\s+(['"])([^'"\n]+)\1/g,
];
const FILE_LITERAL = /['"`]([^'"`\n]*?[\w-]\.(?:js|cjs|mjs|json|html|css|md|py|sql|ps1|sh|ya?ml|txt|svg))['"`]/g;

const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function changedFiles(cwd, since = 'HEAD') {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const lines = (s) => s.split(/\r?\n/).filter(Boolean);
  const names = new Set([
    ...lines(git(top, ['diff', '--name-only', '--no-renames', since, '--'])),
    ...lines(git(top, ['ls-files', '--others', '--exclude-standard'])),
  ]);
  return { top, files: [...names].map((n) => path.join(top, n)) };
}

// The existing files `spec` (written in `from`) can mean, plus the never-existing candidates
// (a deleted module still counts as touched).
function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return { found: [], ghost: [] };
  const base = path.resolve(path.dirname(from), spec);
  const found = [];
  const ghost = [];
  for (const c of [...EXTS.map((e) => base + e), ...EXTS.slice(1).map((e) => path.join(base, 'index' + e))]) {
    let isFile = false;
    try { isFile = fs.statSync(c).isFile(); } catch { /* not there */ }
    (isFile ? found : ghost).push(c);
  }
  return { found, ghost };
}

function scan(file, cache) {
  if (cache.has(file)) return cache.get(file);
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { /* deleted or binary */ }
  const found = new Set();
  const ghost = new Set();
  const names = new Set();
  if (/\.(?:[cm]?js|ts|json)$/.test(file)) {
    for (const re of SPEC_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const r = resolveSpec(file, m[2]);
        r.found.forEach((f) => found.add(f));
        r.ghost.forEach((g) => ghost.add(g));
      }
    }
    FILE_LITERAL.lastIndex = 0;
    let m;
    while ((m = FILE_LITERAL.exec(src))) names.add(path.basename(m[1]).toLowerCase());
  }
  const out = { found: [...found], ghost: [...ghost], names: [...names] };
  cache.set(file, out);
  return out;
}

function affected({ cwd, testFiles, touches = {}, narrow = {}, since = 'HEAD' }) {
  const { top, files } = changedFiles(cwd, since);
  const changed = new Set(files.map(norm));
  const byBase = new Map();
  for (const f of files) {
    const b = path.basename(f).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(norm(f));
  }
  const rel = (f) => path.relative(top, f).replace(/\\/g, '/');

  const everything = [
    path.join(top, 'scripts', 'run-tests.js'),
    path.join(top, 'scripts', 'changed-tests.js'),
    path.join(cwd, 'package.json'),
    path.join(cwd, 'package-lock.json'),
    path.join(cwd, 'test', 'runner.config.js'),
  ].find((f) => changed.has(norm(f)));
  if (everything) return { all: true, reason: `${rel(everything)} changed`, selected: testFiles, changed: files.map(rel) };
  if (!files.length) return { all: false, reason: 'no changes against ' + since, selected: [], changed: [] };

  const cache = new Map();
  const selected = [];
  for (const t of testFiles) {
    const testPath = path.join(cwd, 'test', t);
    const seen = new Set();
    const stack = [testPath];
    let hit = false;
    // A narrow test (slow, and reaches the world through one big entry point) is selected only by its
    // own file and the paths listed for it, never by the import graph; CI still runs it every time.
    const narrowed = Object.prototype.hasOwnProperty.call(narrow, t);
    for (const prefix of [...(touches[t] || []), ...(narrow[t] || [])]) {
      const abs = norm(path.resolve(cwd, prefix));
      for (const c of changed) if (c === abs || c.startsWith(abs + path.sep)) hit = true;
    }
    if (narrowed) stack.length = 0;
    if (narrowed && changed.has(norm(testPath))) hit = true;
    while (stack.length && !hit) {
      const f = stack.pop();
      const key = norm(f);
      if (seen.has(key)) continue;
      seen.add(key);
      if (changed.has(key)) { hit = true; break; }
      const { found, ghost, names } = scan(f, cache);
      if (ghost.some((g) => changed.has(norm(g)))) { hit = true; break; }
      for (const n of names) {
        const same = byBase.get(n);
        if (same && same.some((c) => c.startsWith(norm(top) + path.sep))) { hit = true; break; }
      }
      stack.push(...found);
    }
    if (hit) selected.push(t);
  }
  return { all: false, reason: null, selected, changed: files.map(rel) };
}

module.exports = { affected, changedFiles };
