'use strict';

// Event-loop stall detector. A worker whose loop is blocked answers nothing —
// /healthz included — and a deploy (src/supervisor/deploy.js) reads that as an
// unhealthy generation and rolls back. This logs every stall over `thresholdMs`
// with what was running, so the next one names its cause.
//
// A chained setTimeout, unref'd: it never keeps the process alive.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

interface LagLog {
  warn(message: string, fields?: Record<string, unknown>): unknown;
}
interface LagTimers {
  setTimeout(fn: () => void, ms: number): { unref?: () => unknown };
  clearTimeout(t: unknown): unknown;
}

function watchLag({ log, everyMs = 250, thresholdMs = 1000, running = () => [], timers = { setTimeout, clearTimeout }, now = Date.now }: { log?: LagLog | null; everyMs?: number; thresholdMs?: number; running?: () => unknown; timers?: LagTimers; now?: () => number } = {}) {
  let t: { unref?: () => unknown } | null = null;
  let stopped = false;
  let worst = 0;
  const tick = (expected: number): void => {
    if (stopped) return;
    const lag = now() - expected;
    if (lag > worst) worst = lag;
    if (lag >= thresholdMs && log) log.warn('event loop blocked', { ms: lag, running: running() });
    const next = now() + everyMs;
    t = timers.setTimeout(() => tick(next), everyMs);
    t.unref?.();
  };
  const first = now() + everyMs;
  t = timers.setTimeout(() => tick(first), everyMs);
  t.unref?.();
  return {
    stop() {
      stopped = true;
      timers.clearTimeout(t);
    },
    worst: () => worst,
  };
}

module.exports = { watchLag };
