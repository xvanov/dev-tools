'use strict';

// Helpers every platform implementation shares. Nothing OS-specific is
// *decided* here — that is each implementation's job — only the plumbing they
// all need: finding a program on PATH without spawning anything, running one
// with its output captured, and starting one detached.
//
// Must not require config.js: config resolves its platform defaults through
// this layer.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// PATH lookups are cached for the life of the process: the worker asks "is
// pactl here?" every 20 seconds, and the answer only changes when you install
// something, which a worker restart picks up.
const whichCache = new Map();

function which(bin, { env = process.env, platform = process.platform } = {}) {
  const key = `${platform}:${bin}`;
  if (whichCache.has(key)) return whichCache.get(key);
  let found = null;
  if (path.isAbsolute(bin)) {
    found = fs.existsSync(bin) ? bin : null;
  } else {
    const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
    const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
    outer: for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, bin + ext);
        try {
          const st = fs.statSync(p);
          if (st.isFile() && (platform === 'win32' || (st.mode & 0o111) !== 0)) {
            found = p;
            break outer;
          }
        } catch {
          // not here
        }
      }
    }
  }
  whichCache.set(key, found);
  return found;
}

function forgetWhich() {
  whichCache.clear();
}

/**
 * Runs a program to completion and returns what it printed. Never throws:
 * `{stdout, stderr, status, error}`. `input` goes to its stdin.
 */
function runSync(cmd, args, { input, timeoutMs = 10_000, env } = {}) {
  const r = spawnSync(cmd, args, {
    input,
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, error: r.error.code || r.error.message };
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

/** Async twin of runSync, for passes that must not block the worker's loop. */
function run(cmd, args, { input, timeoutMs = 10_000, env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (err) {
      resolve({ stdout, stderr, status: null, error: err.code || err.message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: null, error: err.code || err.message });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve(signal ? { stdout, stderr, status, error: `killed by ${signal}` } : { stdout, stderr, status });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Starts a program and forgets it. False when it could not be started. */
function spawnDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Feeds `text` to a program's stdin and waits for it to exit. */
function pipeTo(cmd, args, text) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

// Free bytes for unprivileged writes on the filesystem holding `dir` (or its
// nearest existing ancestor: the spool may not exist yet). statfs is a single
// syscall, so this is cheap enough to run every minute.
function statfsFree(dir) {
  let p = path.resolve(dir);
  while (!fs.existsSync(p)) {
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  const s = fs.statfsSync(p);
  return Number(s.bavail) * Number(s.bsize);
}

module.exports = { which, forgetWhich, runSync, run, spawnDetached, pipeTo, statfsFree };
