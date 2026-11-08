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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
/** Injectable for tests; a handle is whatever their setTimeout returns. */
type Timers = { setTimeout: (fn: () => void, ms: number) => any; clearTimeout: (handle: any) => void };
type PacerOptions = {
  run: () => unknown;
  nextMs: () => number | Promise<number>;
  minGapMs?: number;
  onError?: (err: unknown) => void;
  timers?: Timers;
  clock?: () => number;
};
type Pacer = {
  start(firstMs?: number): void;
  kick(): void;
  hurry(ms: number): void;
  stop(): void;
  busy(quietMs?: number): boolean;
};
type ReadFile = (p: string) => string;
type FsWatcher = { on?: (event: string, fn: () => void) => unknown; close: () => void };
type Watch = (dir: string, options: { persistent: boolean }, listener: (type: string, file: string | Buffer | null) => void) => FsWatcher;

const fs = require('fs');
const os = require('os');
const path = require('path');

const MOVING = new Set(['queued', 'triaging', 'in_progress']);

/** Pure. Whether any job in a `job list` is moving. */
function moving(jobs: unknown): boolean {
  return (Array.isArray(jobs) ? jobs : []).some((j: Json | null | undefined) => MOVING.has(j?.state));
}

/** Pure. Milliseconds to the next pass. */
function nextDelayMs({ jobs, slowSeconds, fastSeconds }: { jobs: unknown; slowSeconds: number; fastSeconds: number }): number {
  return (moving(jobs) ? Math.min(fastSeconds, slowSeconds) : slowSeconds) * 1000;
}

/**
 * Runs `run()` (the pass; resolves when it is done) on its own schedule:
 * nextMs() after each pass ends, and at once on kick(). A kick during a pass
 * runs one more pass right after it; kicks closer than minGapMs to the last
 * pass's end wait out the gap. Never two passes at a time.
 */
function createPacer({ run, nextMs, minGapMs = 500, onError = () => {}, timers = { setTimeout, clearTimeout }, clock = Date.now }: PacerOptions): Pacer {
  let timer: any = null;
  let running = false;
  let again = false;
  let stopped = false;
  let lastEnd = 0;
  let dueAt = Infinity;

  function at(ms: number): void {
    if (stopped) return;
    timers.clearTimeout(timer);
    dueAt = clock() + Math.max(0, ms);
    timer = timers.setTimeout(tick, Math.max(0, ms));
    timer?.unref?.();
  }

  async function tick(): Promise<void> {
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
    let wait: number;
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
    hurry(ms: number) {
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
function localStateDir(
  factoryConfig: { machine?: string | null; path?: string | null } | null | undefined,
  { hostname = os.hostname(), exists = fs.existsSync, readFile }: { hostname?: string; exists?: (p: string) => boolean; readFile?: ReadFile } = {},
): string | null {
  const machine = String(factoryConfig?.machine || '').trim();
  if (machine && machine.toLowerCase() !== hostname.toLowerCase()) return null;
  if (!factoryConfig?.path) return null;
  const dir = resolveStateDir(factoryConfig.path, readFile ? { readFile } : {});
  return exists(dir) ? dir : null;
}

/**
 * A factory root's state directory: the absolute path in its `.state-dir`
 * pointer (written by `factory state migrate`, which moves state out of the
 * repo), else `<root>/state`. Mirrors software-factory/factory/state_dir.py.
 */
function resolveStateDir(factoryPath: string, { readFile = (p: string) => fs.readFileSync(p, 'utf8') }: { readFile?: ReadFile } = {}): string {
  try {
    const text = String(readFile(path.join(factoryPath, '.state-dir')) || '').trim();
    if (text && path.isAbsolute(text)) return text;
  } catch {
    // no pointer: an unmigrated root
  }
  return path.join(factoryPath, 'state');
}

/**
 * Calls onChange() when the factory's database changes, unless ignore() says
 * the write was ours. Returns the stop function, or null when the directory
 * cannot be watched.
 */
function watchState(dir: string, { onChange, ignore = () => false, watch = fs.watch }: { onChange: () => void; ignore?: () => boolean; watch?: Watch }): (() => void) | null {
  let w: FsWatcher;
  try {
    w = watch(dir, { persistent: false }, (_type, file) => {
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

module.exports = { moving, nextDelayMs, createPacer, localStateDir, resolveStateDir, watchState, MOVING };
