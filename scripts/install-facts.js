#!/usr/bin/env node
'use strict';

// Read-only facts for the one-command install (install.ps1, plan 7.7). Prints one JSON object;
// changes nothing.
//
//   node scripts/install-facts.js deps <dir> [--omit-dev]
//     {state: 'missing' | 'no-lock' | 'stale' | 'fresh', checked, stale: [first few]}
//     <dir>/node_modules against <dir>/package-lock.json: every locked package the install would
//     place is there at the locked version. Optional and peer packages count only when present
//     (another platform's binaries never install); --omit-dev skips dev-only ones, as termhub's
//     own installer installs (npm install --omit=dev).
//   node scripts/install-facts.js pa <repo>
//     {sqlitePath, storeExists, sqliteKey, backupKey}: the PA's store path and where its two keys
//     come from ('env' | 'credential-manager' | '.env' | 'repo .env' | null), through the PA's own
//     config (src/config.ts: the environment, the OS vault, .env). Never a value.

const fs = require('fs');
const path = require('path');

function deps(dir, { omitDev = false } = {}) {
  const lockFile = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(path.join(dir, 'node_modules'))) return { state: 'missing', checked: 0, stale: [] };
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return { state: 'no-lock', checked: 0, stale: [] };
  }
  const stale = [];
  let checked = 0;
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key.includes('node_modules/') || entry.link) continue;
    if (omitDev && entry.dev) continue;
    const ifPresent = entry.optional || entry.devOptional || entry.peer;
    let version = null;
    try {
      version = JSON.parse(fs.readFileSync(path.join(dir, key, 'package.json'), 'utf8')).version;
    } catch {
      /* not installed */
    }
    if (version === null && ifPresent) continue;
    checked++;
    if (version !== entry.version) stale.push(`${key.slice(key.lastIndexOf('node_modules/') + 13)}@${entry.version}${version ? ` (have ${version})` : ' (missing)'}`);
  }
  return { state: stale.length ? 'stale' : 'fresh', checked, stale: stale.slice(0, 5) };
}

function pa(repo) {
  const cfg = require(path.join(path.resolve(repo), 'personal-assistant', 'src', 'config.ts'));
  const sqlitePath = cfg.config.sqlitePath;
  return {
    sqlitePath,
    storeExists: fs.existsSync(sqlitePath),
    sqliteKey: cfg.secretSource('PA_SQLITE_KEY') || null,
    backupKey: cfg.secretSource('PA_BACKUP_KEY') || null,
  };
}

function cli(argv = process.argv.slice(2)) {
  const [cmd, target] = argv;
  try {
    if (cmd === 'deps' && target) return console.log(JSON.stringify(deps(path.resolve(target), { omitDev: argv.includes('--omit-dev') })));
    if (cmd === 'pa' && target) return console.log(JSON.stringify(pa(target)));
    console.error('usage: node scripts/install-facts.js deps <dir> [--omit-dev] | pa <repo>');
    process.exitCode = 2;
  } catch (e) {
    console.error(e && e.message ? e.message : String(e));
    process.exitCode = 1;
  }
}

module.exports = { deps, pa };

if (require.main === module) cli();
