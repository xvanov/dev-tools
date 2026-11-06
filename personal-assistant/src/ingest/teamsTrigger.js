'use strict';

// When to read the Teams cache: a debounce over file-change events.
//
// Teams writes a message into LevelDB as one or a few appends to the active
// `.log`, a burst of a few milliseconds; a flush or compaction is a longer
// burst of table writes. Reading on the first event of a burst would read
// half of it and then read again; reading on a timer is either slow or
// constant work. So a pass runs once the directory has been quiet for
// `quietMs` after the last event — but never later than `maxWaitMs` after the
// first, so a long compaction (or a chatty client that never goes quiet)
// cannot hold a message back.
//
// Passes never overlap. Events that arrive while one is running are kept,
// and when it finishes the next pass is due by the same rule: the running
// pass may have opened the log before those bytes landed, so they get a
// read of their own rather than waiting for the next event or the fallback.
//
// The state machine is pure (now is passed in) so the rules are testable
// without timers; `scheduler` drives it with real (or fake) ones.

function initial() {
  return { first: null, last: null, running: false };
}

// An event at `now` (a file changed, or a fallback poll asked for a pass).
function onEvent(s, now) {
  return { ...s, first: s.first ?? now, last: now };
}

// When the pending burst is due, or null when nothing is pending or a pass
// is running (it will be asked again when that pass is done).
function dueAt(s, { quietMs, maxWaitMs }) {
  if (s.running || s.first == null) return null;
  return Math.min(s.last + quietMs, s.first + maxWaitMs);
}

// A timer fired at `now`: start a pass if one is due. The events up to now
// are the pass's; anything later starts a new burst.
function onTimer(s, now, opts) {
  const due = dueAt(s, opts);
  if (due == null || now < due) return { state: s, run: false };
  return { state: { first: null, last: null, running: true }, run: true };
}

function onDone(s) {
  return { ...s, running: false };
}

// Drives the machine. `run` is the pass (a promise); `timers` and `now` are
// injectable for tests. `poke()` is an event; `stop()` cancels what is
// pending and lets a running pass finish.
function scheduler({ run, quietMs = 400, maxWaitMs = 1500, now = Date.now, timers = { setTimeout, clearTimeout } }) {
  const opts = { quietMs, maxWaitMs };
  let s = initial();
  let timer = null;
  let stopped = false;

  function arm() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const due = dueAt(s, opts);
    if (due == null) return;
    timer = timers.setTimeout(fire, Math.max(0, due - now()));
  }

  function fire() {
    timer = null;
    const r = onTimer(s, now(), opts);
    s = r.state;
    if (!r.run) return arm();
    Promise.resolve()
      .then(run)
      .catch(() => {}) // the pass reports its own failures
      .finally(() => {
        s = onDone(s);
        arm();
      });
  }

  return {
    poke() {
      if (stopped) return;
      s = onEvent(s, now());
      arm();
    },
    stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
    get state() {
      return s;
    },
  };
}

module.exports = { initial, onEvent, dueAt, onTimer, onDone, scheduler };
