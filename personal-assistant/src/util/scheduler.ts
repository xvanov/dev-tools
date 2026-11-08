'use strict';

// The worker's schedulers, as one thing that can be started and stopped
// (docs/native/PLAN.md, Z2). Everything periodic or event-driven the worker
// does is declared here first — `every` for timed passes, `service` for
// watchers and in-process workers — and nothing runs until start(). stop()
// clears every timer and stops every service, so a generation that hands the
// lease over (src/util/lease.js) stops starting work at once; start() brings
// them all back (a rollback hands the lease back to it).
//
// Every run goes through `passes` (src/util/exclusive.ts: a pass never
// overlaps itself in this process) and then the lease's pass lock (never with
// the same pass in another generation). Without a lease (tests) it runs bare.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type PassFn = () => unknown;
type Stop = () => unknown;
type ServiceHandle = Stop | { stop?: Stop; close?: Stop } | null | undefined | void;

interface Passes {
  run(name: string, fn: PassFn): Promise<boolean>;
  soon(name: string, fn: PassFn): Promise<boolean>;
  isRunning(name: string): boolean;
}

interface SchedLog {
  debug?: (msg: string, data?: object) => void;
  warn: (msg: string, data?: object) => void;
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

type Def =
  | { kind: 'every'; seconds: number; name: string; fn: PassFn }
  | { kind: 'service'; name: string; start: () => ServiceHandle | Promise<ServiceHandle> };

type Live =
  | { kind: 'timeout' | 'interval'; handle: unknown }
  | { kind: 'service'; name: string; stop: Stop | null };

interface SchedulerOptions {
  passes: Passes;
  lease?: { runPass(name: string, fn: PassFn): Promise<boolean> } | null;
  log?: SchedLog | null;
  timers?: Timers;
  firstTickMs?: () => number;
  serviceStopMs?: number;
}

function createScheduler({
  passes,
  lease = null,
  log = null,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval } as unknown as Timers,
  firstTickMs = () => 2000 + Math.random() * 3000,
  serviceStopMs = 1500,
}: SchedulerOptions) {
  const defs: Def[] = [];
  let live: Live[] = [];
  let running = false;

  const guarded = (name: string, fn: PassFn): PassFn => () => (lease ? lease.runPass(name, fn) : fn());

  /** Runs pass `name` now unless it is already running (here or elsewhere). */
  function run(name: string, fn: PassFn): Promise<boolean> {
    if (passes.isRunning(name) && log) log.debug?.('skipping overlapping pass', { name });
    return passes.run(name, guarded(name, fn));
  }

  /** Runs pass `name` now, or right after the run in progress (exclusive.js). */
  function soon(name: string, fn: PassFn): Promise<boolean> {
    return passes.soon(name, guarded(name, fn));
  }

  function startDef(d: Def): void {
    if (d.kind === 'every') {
      const tick = () => run(d.name, d.fn);
      // One early pass, so a generation that just took over is useful at once.
      live.push({ kind: 'timeout', handle: timers.setTimeout(tick, firstTickMs()) });
      live.push({ kind: 'interval', handle: timers.setInterval(tick, d.seconds * 1000) });
      return;
    }
    // A service: start() returns its stop — a function, or an object with
    // stop()/close() — or a promise of one.
    const entry: Live = { kind: 'service', name: d.name, stop: null };
    live.push(entry);
    Promise.resolve()
      .then(() => d.start())
      .then((h: ServiceHandle) => {
        const stop: Stop = typeof h === 'function' ? h : h && typeof h.stop === 'function' ? h.stop.bind(h) : h && typeof h.close === 'function' ? h.close.bind(h) : () => {};
        if (live.includes(entry)) entry.stop = stop;
        else stop(); // stopped while it was starting
      })
      .catch((err: Error) => log && log.warn('service not started', { name: d.name, message: err.message }));
  }

  function every(seconds: number, name: string, fn: PassFn): void {
    const d: Def = { kind: 'every', seconds, name, fn };
    defs.push(d);
    if (running) startDef(d);
  }

  function service(name: string, start: () => ServiceHandle | Promise<ServiceHandle>): void {
    const d: Def = { kind: 'service', name, start };
    defs.push(d);
    if (running) startDef(d);
  }

  function start(): void {
    if (running) return;
    running = true;
    for (const d of defs) startDef(d);
  }

  async function stop(): Promise<void> {
    if (!running) return;
    running = false;
    const was = live;
    live = [];
    const stops: Array<Promise<unknown>> = [];
    for (const e of was) {
      if (e.kind === 'timeout') timers.clearTimeout(e.handle);
      else if (e.kind === 'interval') timers.clearInterval(e.handle);
      else if (e.kind === 'service' && e.stop) {
        const name = e.name;
        stops.push(
          Promise.resolve()
            .then(e.stop)
            .catch((err: Error) => log && log.warn('service stop failed', { name, message: err.message }))
        );
      }
    }
    // Bounded: an in-process worker finishing a long task must not hold the
    // hand-over up (its tasks are claimed with leases of their own).
    let t: unknown;
    await Promise.race([Promise.all(stops), new Promise<void>((r) => (t = timers.setTimeout(r, serviceStopMs)))]);
    timers.clearTimeout(t);
  }

  return {
    every,
    service,
    run,
    soon,
    start,
    stop,
    started: () => running,
    running: () => defs.filter((d) => d.kind === 'every' && passes.isRunning(d.name)).map((d) => d.name),
    names: () => defs.map((d) => d.name),
  };
}

module.exports = { createScheduler };
