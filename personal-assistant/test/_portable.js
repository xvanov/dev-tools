'use strict';

// Helpers that let tests written against POSIX tools run on a Windows box too.
// Not a test itself (the runner only globs *.test.js).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WIN = process.platform === 'win32';

// On Windows, puts Git for Windows' POSIX tools (sh, cat, wc, base64, ...) on this process's PATH,
// so child processes that spawn `sh` work. Returns true when `sh` is usable afterwards. A no-op
// elsewhere. Git ships them whenever git itself is installed, so no extra dependency.
function ensurePosixTools() {
  if (!WIN) return true;
  const have = () => !spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore', windowsHide: true }).error;
  if (have()) return true;
  const found = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  const candidates = [];
  for (const g of (found.stdout || '').split(/\r?\n/).filter(Boolean)) {
    candidates.push(path.join(path.dirname(g), '..', 'usr', 'bin'), path.join(path.dirname(g), '..', '..', 'usr', 'bin'));
  }
  candidates.push('C:\\Program Files\\Git\\usr\\bin');
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'sh.exe'))) {
      process.env.PATH = `${path.resolve(dir)}${path.delimiter}${process.env.PATH}`;
      return have();
    }
  }
  return false;
}

// On Windows, puts Git for Windows' real git.exe (ucrt64/mingw64 bin) ahead of the cmd\git.exe
// launcher on PATH, for this process and its children. The launcher starts a second process for
// every call: about a third of each git call's ~0.3 s here, and git-heavy tests make hundreds.
// Same git, same version; returns the directory used, or null (a no-op elsewhere).
function preferDirectGit() {
  if (!WIN) return null;
  const found = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  const roots = new Set(['C:\\Program Files\\Git']);
  for (const g of (found.stdout || '').split(/\r?\n/).filter(Boolean)) roots.add(path.resolve(path.dirname(g), '..'));
  for (const root of roots) {
    for (const sub of ['ucrt64', 'mingw64', 'clangarm64']) {
      const dir = path.join(root, sub, 'bin');
      if (fs.existsSync(path.join(dir, 'git.exe'))) {
        process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
        return dir;
      }
    }
  }
  return null;
}

// `python3` on Linux/macOS, `python` on Windows (where python3 is only a Store stub, if present).
function pythonCommand() {
  for (const c of WIN ? ['python', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(c, ['-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'], { stdio: 'ignore', windowsHide: true });
    if (!r.error && r.status === 0) return c;
  }
  throw new Error('no python 3 on PATH');
}

module.exports = { ensurePosixTools, preferDirectGit, pythonCommand, WIN };
