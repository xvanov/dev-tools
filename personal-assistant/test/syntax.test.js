'use strict';

// Every source file parses. Most modules are only loaded by the CLI or the
// worker, so a syntax error in one passes every unit test and ships â€” this
// is the cheap check that it cannot.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

const root = path.join(__dirname, '..');
const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'bin'))];
assert.ok(files.length > 20);
// Compile in-process with the CommonJS wrapper (no spawn: ~150 files x one node start was 40 s).
// Anything that fails to compile that way is re-checked with `node --check` for the real verdict
// (ES modules, top-level-await files), so this stays exactly as strict as before.
const vm = require('vm');
for (const f of files) {
  try {
    const src = fs.readFileSync(f, 'utf8').replace(/^#!.*/, '');
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: f });
  } catch {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      continue;
    } catch (err) {
      assert.fail(`${path.relative(root, f)} does not parse:\n${String(err.stderr).split('\n').slice(0, 4).join('\n')}`);
    }
  }
}

console.log('syntax ok');
