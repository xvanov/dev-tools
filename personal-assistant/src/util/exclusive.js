'use strict';

// Named passes that never overlap themselves (the worker's scheduler).
//
// `run(name, fn)` runs fn unless a pass of that name is running, and resolves
// to whether it ran — a timer tick that finds its pass busy is skipped, since
// the next tick sees the same work.
//
// `soon(name, fn)` is for work that must not wait for the next tick: the
// Teams fast path, distilling a DM a second after it arrived. When the pass
// is idle it runs now; when it is busy, fn runs once as soon as the running
// pass ends. Skipping instead (what `run` does) left a fresh DM waiting for
// the next 90-second distill tick whenever it landed during a scheduled
// distill — that pass had already chosen its items. Several `soon` calls
// during one busy pass collapse into one follow-up (the newest fn), and every
// caller's promise resolves when that follow-up has run.

function passes({ onError = () => {} } = {}) {
  const running = new Set();
  const queued = new Map(); // name -> { fn, waiters }

  async function run(name, fn) {
    if (running.has(name)) return false;
    running.add(name);
    try {
      await fn();
    } catch (err) {
      onError(name, err);
    } finally {
      running.delete(name);
      const q = queued.get(name);
      if (q) {
        queued.delete(name);
        run(name, q.fn).then((ran) => q.waiters.forEach((w) => w(ran)));
      }
    }
    return true;
  }

  function soon(name, fn) {
    if (!running.has(name)) return run(name, fn);
    return new Promise((resolve) => {
      const q = queued.get(name) || { fn, waiters: [] };
      q.fn = fn;
      q.waiters.push(resolve);
      queued.set(name, q);
    });
  }

  return { run, soon, isRunning: (name) => running.has(name) };
}

module.exports = { passes };
