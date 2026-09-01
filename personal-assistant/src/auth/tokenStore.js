'use strict';

// Where the Microsoft refresh token lives.
//
// A refresh token is a long-lived credential for your mail, calendar and chats.
// It does not go in Postgres (where a `pg_dump` would copy it) and it does not
// go in the repo. On Windows it is sealed with DPAPI under the current user
// account, so a copy of the file is useless on any other machine or to any
// other user; elsewhere it falls back to a 0600 file, which is the same
// guarantee the SSH agent settles for.
//
// DPAPI is reached through PowerShell rather than a native module on purpose:
// one more compiled dependency on Windows is one more thing that breaks on a
// Node upgrade, and this path runs at most twice per process.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { config } = require('../config');

const CACHE_FILE = path.join(config.dataDir, 'graph-token-cache.bin');
const ENTROPY = 'personal-assistant/graph';

function ensureDir() {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
}

function ps(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true }
  ).trim();
}

function protect(plain) {
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  return ps(
    `Add-Type -AssemblyName System.Security; ` +
      `$b=[Convert]::FromBase64String('${b64}'); ` +
      `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); ` +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser'))`
  );
}

function unprotect(sealed) {
  const out = ps(
    `Add-Type -AssemblyName System.Security; ` +
      `$b=[Convert]::FromBase64String('${sealed}'); ` +
      `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); ` +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser'))`
  );
  return Buffer.from(out, 'base64').toString('utf8');
}

function read() {
  if (!fs.existsSync(CACHE_FILE)) return '';
  const stored = fs.readFileSync(CACHE_FILE, 'utf8');
  if (!stored) return '';
  if (process.platform !== 'win32') return stored;
  try {
    return unprotect(stored.trim());
  } catch {
    // A cache we cannot open is a cache we do not have. Losing it costs one
    // device-code login; guessing at it costs a confusing auth failure later.
    return '';
  }
}

function write(text) {
  ensureDir();
  if (process.platform !== 'win32') {
    fs.writeFileSync(CACHE_FILE, text, { mode: 0o600 });
    return;
  }
  fs.writeFileSync(CACHE_FILE, protect(text), { mode: 0o600 });
}

function clear() {
  try {
    fs.unlinkSync(CACHE_FILE);
  } catch {
    /* already gone */
  }
}

function exists() {
  return fs.existsSync(CACHE_FILE);
}

// The shape MSAL wants: a plugin that hands the cache in and takes it back out.
function cachePlugin() {
  return {
    async beforeCacheAccess(ctx) {
      const data = read();
      if (data) ctx.tokenCache.deserialize(data);
    },
    async afterCacheAccess(ctx) {
      if (ctx.cacheHasChanged) write(ctx.tokenCache.serialize());
    },
  };
}

module.exports = { cachePlugin, clear, exists, CACHE_FILE };
