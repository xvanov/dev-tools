'use strict';

// When the worker's factory pass runs (plan item 0.4). It used to run every
// PA_FACTORY_POLL_SECONDS (120 s), so Build learnt of a job's next stage up to
// two minutes late. Now:
//
//  - while any job is moving (queued, triaging, in_progress) the pass runs
//    every PA_FACTORY_ACTIVE_POLL_SECONDS (5 s); otherwise every
//    PA_FACTORY_POLL_SECONDS. A job parked on a human (needs_human, blocked)
//    is not moving: its approval goes through the PA, which refreshes then.
//  - when the factory runs on this machine, its state directory is watched:
//    the factory writes every transition to state/factory.db (SQLite, WAL),
//    and a write there runs the pass at once. That is the sub-second path for
//    local stacks; it needs no factory change and never reads the factory's
//    database (JOBS-API.md: the PA only calls the CLI). Our own `job list`
//    can touch those files too, so writes during a pass and just after it are
//    ignored — otherwise the watcher would feed itself.
//
// The pass writes factory_board and the run rows; their triggers put the
// change on the live feed (sql/034_events_notify.sql).

const fs = require('fs');
const os = require('os');
const path = require('path');

const MOVING = new Set(['queued', 'triaging', 'in_progress']);

/** Pure. Whether any job in a `job list` is moving. */
function moving(jobs) {
  return (Array.isArray(jobs) ? jobs : []).some((j) => MOVING.has(j?.state));
}

/** Pure. Milliseconds to the next pass. */
function nextDelayMs({ jobs, slowSeconds, fastSeconds }) {
  return (moving(jobs) ? Math.min(fastSeconds, slowSeconds) : slowSeconds) * 1000;
}

/**
 * Runs `run()` (the pass; resolves when it is done) on its own schedule:
 * nextMs() after each pass ends, and at once on kick(). A kick during a pass
 * runs one more pass right after it; kicks closer than minGapMs to the last
 * pass's end wait out the gap. Never two passes at a time.
 */
function createPacer({ run, nextMs, minGapMs = 500, onError = () => {}, timers = { setTimeout, clearTimeout }, clock = Date.now }) {
  let timer = null;
  let running = false;
  let again = false;
  let stopped = false;
  let lastEnd = 0;
  let dueAt = Infinity;

  function at(ms) {
    if (stopped) return;
    timers.clearTimeout(timer);
    dueAt = clock() + Math.max(0, ms);
    timer = timers.setTimeout(tick, Math.max(0, ms));
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    dueAt = Infinity;
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    again = false;
    try {
      await run();
    } catch (err) {
      onError(err);
    }
    running = false;
    lastEnd = clock();
    if (stopped) return;
    if (again) return at(minGapMs);
    let wait;
    try {
      wait = await nextMs();
    } catch (err) {
      onError(err);
      wait = 60_000;
    }
    if (!running && !timer) at(wait);
  }

  return {
    start(firstMs = 0) {
      at(firstMs);
    },
    kick() {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      at(lastEnd + minGapMs - clock());
    },
    /** The next pass within `ms` at the latest (a job was just submitted: it moves now). */
    hurry(ms) {
      if (stopped || running) return;
      if (dueAt - clock() > ms) at(Math.max(ms, lastEnd + minGapMs - clock()));
    },
    stop() {
      stopped = true;
      timers.clearTimeout(timer);
    },
    /** True during a pass and for quietMs after it (the watcher ignores those writes). */
    busy(quietMs = 1000) {
      return running || clock() - lastEnd < quietMs;
    },
  };
}

/**
 * The factory's state directory when the factory runs on this machine and
 * the directory is there, else null (a remote factory is paced by polling).
 */
function localStateDir(factoryConfig, { hostname = os.hostname(), exists = fs.existsSync } = {}) {
  const machine = String(factoryConfig?.machine || '').trim();
  if (machine && machine.toLowerCase() !== hostname.toLowerCase()) return null;
  if (!factoryConfig?.path) return null;
  const dir = path.join(factoryConfig.path, 'state');
  return exists(dir) ? dir : null;
}

/**
 * Calls onChange() when the factory's database changes, unless ignore() says
 * the write was ours. Returns the stop function, or null when the directory
 * cannot be watched.
 */
function watchState(dir, { onChange, ignore = () => false, watch = fs.watch }) {
  let w;
  try {
    w = watch(dir, { persistent: false }, (type, file) => {
      if (file && !/^factory\.db/.test(String(file))) return;
      if (ignore()) return;
      onChange();
    });
  } catch {
    return null;
  }
  w.on?.('error', () => {});
  return () => w.close();
}

module.exports = { moving, nextDelayMs, createPacer, localStateDir, watchState, MOVING };
