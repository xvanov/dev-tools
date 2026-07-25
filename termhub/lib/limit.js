'use strict';

// A minimal concurrency gate for spawning child processes from inside sessiond.
//
// sessiond owns the user's live terminals, so an unbounded fan-out of children
// is not a performance question but a reliability one: `/api/tts` and
// `/api/sessions/:id/voice/summary` are reachable by any tailnet peer through
// the front's generic /api/* proxy, and a frontend retry loop shouldn't be able
// to fork a piper (or a `claude -p`) per request in the process holding the
// PTYs. Measured before this existed: 10 concurrent /api/tts spawned 10 pipers
// and pushed /api/ping to a 148 ms round-trip.
//
// Queue overflow rejects rather than waits — a caller that's been queued behind
// a dozen others has almost certainly given up, and a spoken announcement is
// worthless late.

function createLimiter({ max, queue, name }) {
  let active = 0;
  const waiting = [];

  const next = () => {
    if (active >= max || !waiting.length) return;
    const job = waiting.shift();
    active += 1;
    // The task is only started here, so nothing runs over the limit.
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => { active -= 1; next(); });
  };

  // run(task) -> Promise of task's result. Rejects immediately when the queue
  // is full; the error is shaped so callers can map it to a 503.
  const run = (task) => new Promise((resolve, reject) => {
    if (waiting.length >= queue) {
      const err = new Error(`${name} is busy`);
      err.busy = true;
      return reject(err);
    }
    waiting.push({ task, resolve, reject });
    next();
  });

  run.stats = () => ({ active, queued: waiting.length });
  return run;
}

module.exports = { createLimiter };
