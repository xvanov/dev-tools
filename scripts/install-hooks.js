#!/usr/bin/env node
// Installs scripts/hooks/pre-commit as the repo's pre-commit hook (the hooks dir is shared by every
// worktree of this clone). Safe to re-run; a different existing hook is kept as pre-commit.bak.
//
//   node scripts/install-hooks.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const common = path.resolve(top, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: top, encoding: 'utf8' }).trim());
const src = path.join(top, 'scripts', 'hooks', 'pre-commit');
const dest = path.join(common, 'hooks', 'pre-commit');
const want = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');

fs.mkdirSync(path.dirname(dest), { recursive: true });
const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n') : null;
if (have === want) {
  console.log(`pre-commit hook already current: ${dest}`);
} else {
  if (have !== null) fs.writeFileSync(`${dest}.bak`, have);
  fs.writeFileSync(dest, want, { mode: 0o755 });
  console.log(`installed ${dest}${have !== null ? ' (previous hook saved as pre-commit.bak)' : ''}`);
}
