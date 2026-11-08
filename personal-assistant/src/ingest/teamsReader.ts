'use strict';

// Runs teams/read_cache.py: once per call (`oneShot`), or as one resident
// process the worker sends requests to (`resident`).
//
// Why resident: with passes triggered by each write burst, a fresh
// interpreter per pass was the whole cost — 350-500 ms of wall time, a
// process creation and a dozen module loads for an on-access scanner to look
// at, around a read that takes ~20 ms. The resident reader answers a request
// (one JSON array of arguments on stdin) with the same lines a one-shot run
// prints, ending with its `status` line.
//
// Robustness: one request at a time (the caller never overlaps passes, and a
// second request while one is open is refused, not queued). A request that
// times out kills the process; a process that exits for any reason fails the
// open request, and the next request starts a new one. Its stdin is a pipe
// from this process, so when the worker dies, however it dies, the reader
// reads EOF and exits — it never outlives the worker. stderr is discarded: a
// traceback can quote a value it choked on.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const { execFile, spawn } = require('child_process');

function oneShot({ python, script, timeoutMs }: { python?: any | null; script?: any | null; timeoutMs?: any | null }) {
  return {
    request(args: any) {
      return new Promise<any>((resolve, reject) => {
        execFile(
          python,
          ['-I', script, ...args],
          { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
          (err: any, stdout: any) => {
            if (err) reject(new Error(err.killed ? 'reader timed out' : `reader exited ${err.code ?? '?'}`));
            else resolve(stdout);
          }
        );
      });
    },
    stats: () => ({ spawns: 0 }),
    close() {},
  };
}

function resident({ python, script, timeoutMs, spawnFn = spawn }: { python?: any | null; script?: any | null; timeoutMs?: any | null; spawnFn?: any }) {
  let child: any = null;
  let pending: any = null; // { resolve, reject, lines, timer }
  let buf = '';
  let spawns = 0;

  function fail(err: any) {
    const p = pending;
    pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    p.reject(err);
  }

  function start() {
    spawns++;
    const c = spawnFn(python, ['-I', script, '--serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child = c;
    buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk: any) => {
      if (c !== child) return;
      buf += chunk;
      let i: any;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!pending) continue; // nothing asked: stray output
        pending.lines.push(line);
        // The status line ends a response.
        if (line.startsWith('{"t": "status"') || line.startsWith('{"t":"status"')) {
          const p = pending;
          pending = null;
          clearTimeout(p.timer);
          let status: any = null;
          try {
            status = JSON.parse(line);
          } catch {
            /* checked below */
          }
          if (status?.error) p.reject(new Error(`reader failed: ${status.error}`));
          else p.resolve(p.lines.join('\n') + '\n');
        }
      }
    });
    // A dead pipe surfaces as an error on stdin; the exit handler reports it.
    c.stdin.on('error', () => {});
    c.on('error', (err: any) => {
      if (c !== child) return;
      child = null;
      fail(new Error(`reader not started: ${err.code || err.message}`));
    });
    c.on('exit', (code: any) => {
      if (c !== child) return;
      child = null;
      fail(new Error(`reader exited ${code ?? '?'}`));
    });
  }

  return {
    request(args: any) {
      if (pending) return Promise.reject(new Error('reader busy'));
      if (!child) start();
      const c = child;
      return new Promise<any>((resolve, reject) => {
        pending = {
          resolve,
          reject,
          lines: [] as any[],
          timer: setTimeout(() => {
            fail(new Error('reader timed out'));
            if (child === c) child = null;
            c.kill();
          }, timeoutMs),
        };
        c.stdin.write(JSON.stringify(args) + '\n');
      });
    },
    stats: () => ({ spawns, alive: Boolean(child) }),
    close() {
      const c = child;
      child = null;
      fail(new Error('reader closed'));
      if (c) {
        c.stdin.end();
        // EOF ends it; a stuck one is killed.
        setTimeout(() => c.exitCode == null && c.kill(), 2000).unref();
      }
    },
  };
}

module.exports = { oneShot, resident };
