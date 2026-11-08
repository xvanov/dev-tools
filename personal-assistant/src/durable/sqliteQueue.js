'use strict';

// Durable tasks on SQLite (plan 3.1, D19): a small queue of our own with the
// slice of absurd-sdk's interface src/durable uses, so the tasks (chase,
// runReview) and their spawners run unchanged on either store. Postgres keeps
// Absurd until the 3.5 cutover.
//
//   registerTask({name, queue, defaultMaxAttempts}, handler)
//   spawn(name, params, {idempotencyKey, runAt})   once per key
//   emitEvent(name, payload)                        first emit wins, kept
//   startWorker({concurrency, pollInterval})        -> {close()}
//
// A handler gets (params, ctx):
//   ctx.step(name, fn)               runs fn once; its JSON result is saved, a
//                                    rerun (after a sleep, crash or retry) returns it
//   ctx.sleepFor(name, seconds)      suspends the task until then
//   ctx.awaitEvent(event, {stepName, timeout})
//                                    the event's payload; suspends until it is
//                                    emitted, or throws absurd-sdk's TimeoutError
//                                    once `timeout` seconds have passed
//
// A task that throws is retried with exponential backoff (5 s doubling, at
// most an hour) until its max attempts, then left failed. Which worker runs a
// task is a lease row (space durable:<queue>) held on the worker's session:
// two worker generations, or two processes, never run one task at once, and a
// worker that dies frees its tasks for the next poll. Tables:
// sql-sqlite/006_durable.sql; statements: src/repo/sqlite/durable.js.

const crypto = require('crypto');
const { TimeoutError } = require('absurd-sdk');

/** Thrown inside a handler to park the task; never seen by task code. */
class Suspend {
  constructor(runAt, event = null) {
    this.runAt = runAt;
    this.event = event;
  }
}

const BACKOFF_MS = 5000;
const BACKOFF_MAX_MS = 3600_000;

function iso(ms) {
  return new Date(ms).toISOString();
}

class SqliteQueue {
  /**
   * @param {{queueName: string, connect: () => Promise<object>, repos?: object, log?: object}} o
   *   connect: a session for the worker's leases (src/durable/index.js hands
   *   it the pool's connect); repos: the repository set (default: src/repo).
   */
  constructor({ queueName, connect, repos = null, log = null }) {
    this.queue = queueName;
    this.repos = repos || require('../repo');
    this.connect = connect;
    this.log = log || { warn() {}, info() {}, debug() {} };
    this.handlers = new Map();
  }

  registerTask({ name, defaultMaxAttempts = 5 }, handler) {
    this.handlers.set(name, { handler, maxAttempts: defaultMaxAttempts });
  }

  async spawn(name, params, { idempotencyKey, runAt = null } = {}) {
    const t = this.handlers.get(name);
    const key = idempotencyKey || `${name}:${crypto.randomUUID()}`;
    const r = await this.repos.durable.spawnTask({ queue: this.queue, name, params, key, maxAttempts: t ? t.maxAttempts : 5, runAt: runAt ? iso(new Date(runAt).getTime()) : null });
    return { taskID: r.id, created: r.created };
  }

  async emitEvent(name, payload = {}) {
    return this.repos.durable.emitEvent(this.queue, name, payload);
  }

  /** The context a handler gets for task row `task`. */
  // Checkpoints are kept as absurd-sdk keeps them, so a task copied from
  // Postgres (pa db export, plan 3.3) resumes where it was: a name used again
  // in one run is `name#2`, `name#3`...; a step's value is its JSON result; a
  // sleep's is its wake time (ISO text); an event wait's is the payload. The
  // wait's deadline and a timeout that fired are kept beside it (`@deadline`,
  // `@timeout`), which Absurd holds in its own tables.
  context(task) {
    const d = this.repos.durable;
    const id = task.id;
    const used = new Map();
    const cpName = (name) => {
      const n = (used.get(name) || 0) + 1;
      used.set(name, n);
      return n === 1 ? name : `${name}#${n}`;
    };
    return {
      taskID: id,
      async step(name, fn) {
        const cp = cpName(name);
        const had = await d.checkpoint(id, cp);
        if (had) return had.value;
        const v = await fn();
        // What a step returns is kept as JSON (a Date comes back a string), as in Absurd.
        const saved = v === undefined ? null : JSON.parse(JSON.stringify(v));
        await d.saveCheckpoint(id, cp, saved);
        return saved;
      },
      async sleepFor(name, seconds) {
        const cp = cpName(name);
        const had = await d.checkpoint(id, cp);
        const until = had && typeof had.value === 'string' ? Date.parse(had.value) : Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
        if (!had) await d.saveCheckpoint(id, cp, iso(until));
        if (Date.now() >= until) return;
        throw new Suspend(iso(until));
      },
      awaitEvent: async (event, { stepName = null, timeout = null } = {}) => {
        const cp = cpName(stepName || `$awaitEvent:${event}`);
        const had = await d.checkpoint(id, cp);
        if (had) return had.value;
        if (await d.checkpoint(id, `${cp}@timeout`)) throw new TimeoutError(`Timed out waiting for event "${event}"`);
        const got = await d.event(this.queue, event);
        if (got) {
          await d.saveCheckpoint(id, cp, got.payload);
          return got.payload;
        }
        let deadline = null;
        if (timeout != null && Number.isFinite(Number(timeout))) {
          const dl = await d.checkpoint(id, `${cp}@deadline`);
          deadline = dl && typeof dl.value === 'string' ? Date.parse(dl.value) : Date.now() + Math.max(0, Number(timeout)) * 1000;
          if (!dl) await d.saveCheckpoint(id, `${cp}@deadline`, iso(deadline));
          if (Date.now() >= deadline) {
            await d.saveCheckpoint(id, `${cp}@timeout`, true);
            throw new TimeoutError(`Timed out waiting for event "${event}"`);
          }
        }
        throw new Suspend(deadline == null ? null : iso(deadline), event);
      },
    };
  }

  /** Runs one claimed task to its next stop: done, parked, retried or failed. */
  async runTask(task) {
    const d = this.repos.durable;
    const t = this.handlers.get(task.task_name);
    if (!t) {
      await d.failRun(task.id, { error: `no handler for task ${task.task_name}`, attempts: task.attempts + 1, final: true });
      return 'failed';
    }
    await d.markRunning(task.id);
    try {
      const result = await t.handler(task.params || {}, this.context(task));
      await d.complete(task.id, result);
      return 'completed';
    } catch (err) {
      if (err instanceof Suspend) {
        await d.suspend(task.id, err.runAt, err.event);
        return 'sleeping';
      }
      const attempts = task.attempts + 1;
      const final = attempts >= task.max_attempts;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (attempts - 1));
      await d.failRun(task.id, { error: err && (err.stack || err.message || err), attempts, runAt: iso(Date.now() + wait), final });
      this.log.warn(`durable task ${task.task_name} #${task.id} failed (attempt ${attempts} of ${task.max_attempts}): ${err && err.message}`);
      return final ? 'failed' : 'pending';
    }
  }

  /**
   * Polls for due tasks and runs up to `concurrency` at once, each under a
   * lease on this worker's session. Resolves {close()}; close() stops polling,
   * waits for the tasks in flight and lets go of the session.
   */
  async startWorker({ concurrency = 2, pollInterval = 2 } = {}) {
    const session = await this.connect();
    const { createRepos, clientBackend } = require('../repo');
    const leases = createRepos(clientBackend(session)).leases;
    const space = `durable:${this.queue}`;
    const mine = new Map(); // task id -> its run
    let stopped = false;
    let timer = null;
    // One poll at a time: the lease is re-entrant for its holder, so two
    // overlapping polls of this worker could otherwise both start one task.
    let polling = null;
    let again = false;

    const poll = async () => {
      if (polling) {
        again = true;
        return polling;
      }
      polling = pollOnce();
      try {
        await polling;
      } finally {
        polling = null;
      }
      if (again && !stopped) {
        again = false;
        await poll();
      }
    };

    const pollOnce = async () => {
      if (stopped) return;
      try {
        const room = concurrency - mine.size;
        if (room > 0) {
          for (const task of await this.repos.durable.runnable(this.queue, room * 4 + mine.size)) {
            if (mine.size >= concurrency || stopped) break;
            if (mine.has(task.id)) continue;
            if (!(await leases.tryPassLock(space, String(task.id)))) continue; // another worker has it
            // Read again under the lease: it may have finished since the list.
            const fresh = await this.repos.durable.taskById(task.id);
            const due = fresh && (fresh.state === 'running' || (['pending', 'sleeping'].includes(fresh.state) && new Date(fresh.run_at) <= new Date()));
            if (!due) {
              await leases.passUnlock(space, String(task.id));
              continue;
            }
            const run = this.runTask(fresh)
              .catch((err) => this.log.warn(`durable worker: task #${task.id}: ${err.message}`))
              .finally(async () => {
                mine.delete(task.id);
                await leases.passUnlock(space, String(task.id)).catch(() => {});
                if (!stopped) setImmediate(poll); // a freed slot, or a task that is due again
              });
            mine.set(task.id, run);
          }
        }
      } catch (err) {
        this.log.warn(`durable worker poll: ${err.message}`);
      }
      if (!stopped) {
        clearTimeout(timer);
        timer = setTimeout(poll, pollInterval * 1000);
      }
    };
    await poll();

    return {
      close: async () => {
        stopped = true;
        clearTimeout(timer);
        await Promise.allSettled([...mine.values()]);
        session.release();
      },
      /** Polls now (tests, and after an emit in this process). */
      poll,
    };
  }
}

module.exports = { SqliteQueue, Suspend };
