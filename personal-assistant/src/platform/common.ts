'use strict';

// Helpers every platform implementation shares. Nothing OS-specific is
// *decided* here — that is each implementation's job — only the plumbing they
// all need: finding a program on PATH without spawning anything, running one
// with its output captured, and starting one detached.
//
// Must not require config.js: config resolves its platform defaults through
// this layer.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Env = Record<string, string | undefined>;
type RunOpts = { input?: string | Buffer | null; timeoutMs?: number; env?: Env };
type RunResult = { stdout: string; stderr: string; status: number | null; error?: string };

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// PATH lookups are cached for the life of the process: the worker asks "is
// pactl here?" every 20 seconds, and the answer only changes when you install
// something, which a worker restart picks up.
const whichCache = new Map<string, string | null>();

function which(bin: string, { env = process.env, platform = process.platform }: { env?: Env; platform?: string } = {}): string | null {
  const key = `${platform}:${bin}`;
  if (whichCache.has(key)) return whichCache.get(key) ?? null;
  let found: string | null = null;
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
function runSync(cmd: string, args: string[], { input, timeoutMs = 10_000, env }: RunOpts = {}): RunResult {
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
function run(cmd: string, args: string[], { input, timeoutMs = 10_000, env }: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: any;
    try {
      child = spawn(cmd, args, { env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (err) {
      resolve({ stdout, stderr, status: null, error: (err as NodeJS.ErrnoException).code || (err as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: null, error: err.code || err.message });
    });
    child.on('close', (status: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolve(signal ? { stdout, stderr, status, error: `killed by ${signal}` } : { stdout, stderr, status });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Starts a program and forgets it. False when it could not be started. */
function spawnDetached(cmd: string, args: string[]): boolean {
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
function pipeTo(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: any;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('close', (code: number | null) => resolve(code === 0));
    child.on('error', () => resolve(false));
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

/**
 * One cached async result per key. Inside `ttlMs` the last value is returned
 * and `fn` does not run. Once it expires, a refresh starts; a value already
 * cached is returned at once and the refresh finishes in the background, so a
 * serving pass does not wait on a process. The first call, with nothing
 * cached, waits. A failed refresh keeps the previous value.
 */
function cachedAsync(ttlMs: number) {
  const slots = new Map<string, { value: unknown; at: number; pending: Promise<unknown> | null }>();
  return function get<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let slot = slots.get(key);
    if (!slot) {
      slot = { value: undefined, at: 0, pending: null };
      slots.set(key, slot);
    }
    if (slot.at && Date.now() - slot.at < ttlMs) return Promise.resolve(slot.value as T);
    if (!slot.pending) {
      const current = slot;
      current.pending = Promise.resolve()
        .then(fn)
        .then((value) => {
          current.value = value;
          current.at = Date.now();
          current.pending = null;
          return value;
        })
        .catch((err: unknown) => {
          current.pending = null;
          throw err;
        });
      // A background refresh has no caller waiting on it.
      if (current.at) current.pending.catch(() => {});
    }
    if (slot.at) return Promise.resolve(slot.value as T);
    return slot.pending as Promise<T>;
  };
}

// Free space changes slowly next to a once-a-minute check, and spawning
// PowerShell to read a drive took 35-40 ms on the serving loop. One statfs,
// remembered per filesystem for a minute.
const FREE_BYTES_TTL_MS = 60_000;
const freeBytesCache = cachedAsync(FREE_BYTES_TTL_MS);

function cachedFreeBytes(dir: string): Promise<number> {
  const root = path.parse(path.resolve(dir || '.')).root || String(dir);
  return freeBytesCache(root, async () => statfsFree(dir));
}

// Free bytes for unprivileged writes on the filesystem holding `dir` (or its
// nearest existing ancestor: the spool may not exist yet). statfs is a single
// syscall, so this is cheap enough to run every minute.
function statfsFree(dir: string): number {
  let p = path.resolve(dir);
  while (!fs.existsSync(p)) {
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  const s = fs.statfsSync(p);
  return Number(s.bavail) * Number(s.bsize);
}

// Which stack this machine runs: 'work' (the Windows laptop) or 'personal'
// (Linux). Secrets in the OS keychain are labelled with it, so Credential
// Manager / Seahorse show whose each entry is. PA_STACK overrides the guess.
function stack({ env = process.env, platform = process.platform }: { env?: Env; platform?: string } = {}): 'work' | 'personal' {
  const v = String(env.PA_STACK || '').trim().toLowerCase();
  if (v === 'work' || v === 'personal') return v;
  return platform === 'win32' ? 'work' : 'personal';
}

module.exports = { stack, which, forgetWhich, runSync, run, spawnDetached, pipeTo, statfsFree, cachedAsync, cachedFreeBytes, FREE_BYTES_TTL_MS };
