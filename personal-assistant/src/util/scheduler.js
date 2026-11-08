'use strict';

// The worker's schedulers, as one thing that can be started and stopped
// (docs/native/PLAN.md, Z2). Everything periodic or event-driven the worker
// does is declared here first — `every` for timed passes, `service` for
// watchers and in-process workers — and nothing runs until start(). stop()
// clears every timer and stops every service, so a generation that hands the
// lease over (src/util/lease.js) stops starting work at once; start() brings
// them all back (a rollback hands the lease back to it).
//
// Every run goes through `passes` (src/util/exclusive.js: a pass never
// overlaps itself in this process) and then the lease's pass lock (never with
// the same pass in another generation). Without a lease (tests) it runs bare.

function createScheduler({
  passes,
  lease = null,
  log = null,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  firstTickMs = () => 2000 + Math.random() * 3000,
  serviceStopMs = 1500,
} = {}) {
  const defs = [];
  let live = []; // {kind, handle} for timers, {kind: 'service', stop} for services
  let running = false;

  const guarded = (name, fn) => () => (lease ? lease.runPass(name, fn) : fn());

  /** Runs pass `name` now unless it is already running (here or elsewhere). */
  function run(name, fn) {
    if (passes.isRunning(name) && log) log.debug?.('skipping overlapping pass', { name });
    return passes.run(name, guarded(name, fn));
  }

  /** Runs pass `name` now, or right after the run in progress (exclusive.js). */
  function soon(name, fn) {
    return passes.soon(name, guarded(name, fn));
  }

  function startDef(d) {
    if (d.kind === 'every') {
      const tick = () => run(d.name, d.fn);
      // One early pass, so a generation that just took over is useful at once.
      live.push({ kind: 'timeout', handle: timers.setTimeout(tick, firstTickMs()) });
      live.push({ kind: 'interval', handle: timers.setInterval(tick, d.seconds * 1000) });
      return;
    }
    // A service: start() returns its stop — a function, or an object with
    // stop()/close() — or a promise of one.
    const entry = { kind: 'service', name: d.name, stop: null };
    live.push(entry);
    Promise.resolve()
      .then(() => d.start())
      .then((h) => {
        const stop = typeof h === 'function' ? h : h && typeof h.stop === 'function' ? () => h.stop() : h && typeof h.close === 'function' ? () => h.close() : () => {};
        if (live.includes(entry)) entry.stop = stop;
        else stop(); // stopped while it was starting
      })
      .catch((err) => log && log.warn('service not started', { name: d.name, message: err.message }));
  }

  function every(seconds, name, fn) {
    const d = { kind: 'every', seconds, name, fn };
    defs.push(d);
    if (running) startDef(d);
  }

  function service(name, start) {
    const d = { kind: 'service', name, start };
    defs.push(d);
    if (running) startDef(d);
  }

  function start() {
    if (running) return;
    running = true;
    for (const d of defs) startDef(d);
  }

  async function stop() {
    if (!running) return;
    running = false;
    const was = live;
    live = [];
    const stops = [];
    for (const e of was) {
      if (e.kind === 'timeout') timers.clearTimeout(e.handle);
      else if (e.kind === 'interval') timers.clearInterval(e.handle);
      else if (e.stop) {
        stops.push(
          Promise.resolve()
            .then(e.stop)
            .catch((err) => log && log.warn('service stop failed', { name: e.name, message: err.message }))
        );
      }
    }
    // Bounded: an in-process worker finishing a long task must not hold the
    // hand-over up (its tasks are claimed with leases of their own).
    let t;
    await Promise.race([Promise.all(stops), new Promise((r) => (t = timers.setTimeout(r, serviceStopMs)))]);
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
