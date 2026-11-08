'use strict';

// Single-owner background work (docs/native/PLAN.md, Z2).
//
// During a roll (src/supervisor) two worker generations are alive at once: the
// new one serving, the old one draining. Every scheduler, pass and watcher must
// run in exactly one of them, and the hand-over must not wait for the old
// process to exit — a pass in flight can take minutes (a model call), and
// until it ended nothing ran.
//
// Two kinds of Postgres session advisory lock, both held on one dedicated
// connection so they vanish the instant the process (or the connection) dies:
//
//   the generation lease  pg_advisory_lock(7300)
//     who runs the schedulers. The old generation lets go of it on `drain`,
//     right away, with its passes possibly still running; the new one polls
//     for it every PA_LEASE_POLL_MS (500 ms supervised) and starts its
//     schedulers once it has it.
//
//   a pass lock           pg_advisory_lock(7301, hashtext(<pass name>))
//     held around each run of a pass, so a pass the old generation is still
//     finishing is skipped by the new one (its next tick tries again) while
//     every other pass moves over at once. No overlap, and no waiting on the
//     slowest pass. (The one-int and two-int key spaces do not overlap.)
//
// The old non-supervised guard was the same 7300 lock, held until exit; it
// still is when nothing ever calls release().
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../repo/types.ts').Db;

/** A pg client used only for locks. */
interface LockClient {
  query(...args: unknown[]): Promise<unknown>;
  release(err?: unknown): unknown;
  on?(event: string, fn: (err: Error) => void): unknown;
}
interface LeaseLog {
  info(message: string, fields?: Record<string, unknown>): unknown;
  warn(message: string, fields?: Record<string, unknown>): unknown;
  debug?(message: string, fields?: Record<string, unknown>): unknown;
}
interface Lease {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  held(): boolean;
}
interface OwnershipScheduler {
  start(): unknown;
  stop(): Promise<unknown> | unknown;
  running(): unknown;
}

const WORKER_KEY = 7300;
const PASS_SPACE = 7301;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The lock statements, on the lock connection (src/repo/leases.js). */
function locksOn(client: LockClient | Pick<Db, 'query'>) {
  const { createRepos, clientBackend } = require('../repo');
  return createRepos(clientBackend(client)).leases;
}

/**
 * connect(): resolves to a pg client ({query, release, on}) used only for locks.
 * onLost(err): the lock connection died while the lease was held (the locks
 * went with it); the owner must stop its passes and acquire again.
 */
function createLease({ connect, pollMs = 500, log = null, key = WORKER_KEY, passSpace = PASS_SPACE, onLost = () => {} }: { connect: () => Promise<LockClient>; pollMs?: number; log?: LeaseLog | null; key?: number; passSpace?: number; onLost?: (err: Error) => unknown }) {
  let client: LockClient | null = null;
  let held = false;
  let wanted = false; // an acquire() loop is running and has not been called off
  let attempt = 0; // bumps on every release(), so a stale acquire() loop knows it lost

  async function lockClient(): Promise<LockClient> {
    if (client) return client;
    const raw = await connect();
    // Every pass shares this one connection; pg wants one query at a time on
    // a client (overlapping ones are deprecated, and gone in pg 9), so queue.
    let tail: Promise<unknown> = Promise.resolve();
    const c: LockClient = Object.create(raw);
    c.query = (...args: unknown[]) => {
      const run = tail.then(() => raw.query(...args));
      tail = run.catch(() => {});
      return run;
    };
    c.release = (...args: unknown[]) => (raw.release as (...a: unknown[]) => unknown)(...args);
    c.on = (...args: unknown[]) => (raw.on as ((...a: unknown[]) => unknown) | undefined)?.(...args);
    c.on?.('error', (err: Error) => {
      if (client !== c) return;
      client = null;
      const was = held;
      held = false;
      try {
        c.release(err);
      } catch {
        /* already gone */
      }
      if (was) onLost(err);
    });
    client = c;
    return c;
  }

  /**
   * Waits until this process holds the generation lease. Resolves true once it
   * does, false if release() called the wait off first.
   */
  async function acquire() {
    if (held) return true;
    const mine = ++attempt;
    wanted = true;
    let warned = false;
    while (wanted && mine === attempt) {
      try {
        const c = await lockClient();
        if (await locksOn(c).tryLock(key)) {
          if (mine !== attempt || !wanted) {
            // Called off while the query was in flight: give it straight back.
            await locksOn(c).unlock(key).catch(() => {});
            return false;
          }
          held = true;
          wanted = false;
          return true;
        }
        if (!warned && log) log.info('another worker generation holds the lease — waiting for it');
        warned = true;
      } catch (err) {
        if (log) log.warn('lease check failed — retrying', { message: (err as Error).message });
      }
      await sleep(pollMs);
    }
    return false;
  }

  /** Lets go of the generation lease now. Pass locks stay until their pass ends. */
  async function release() {
    wanted = false;
    attempt++;
    if (!held) return;
    held = false;
    if (client) await locksOn(client).unlock(key).catch(() => {});
  }

  /**
   * Runs fn as pass `name` if this process holds the lease and no other process
   * is running that pass. Resolves to whether it ran.
   */
  async function runPass(name: string, fn: () => unknown) {
    if (!held || !client) return false;
    const c = client;
    let got: boolean;
    try {
      got = await locksOn(c).tryPassLock(passSpace, name);
    } catch (err) {
      if (log) log.warn('pass lock failed — skipping this tick', { name, message: (err as Error).message });
      return false;
    }
    if (!got) {
      if (log) log.debug?.('pass still running in another generation — skipping', { name });
      return false;
    }
    try {
      await fn();
    } finally {
      await locksOn(c).passUnlock(passSpace, name).catch(() => {});
    }
    return true;
  }

  /** Ends the lock connection (and with it every lock). */
  async function close() {
    wanted = false;
    attempt++;
    held = false;
    const c = client;
    client = null;
    if (c) {
      try {
        c.release();
      } catch {
        /* already gone */
      }
    }
  }

  return { acquire, release, runPass, close, held: () => held };
}

/**
 * The worker's side of a roll: take over (acquire the lease, start the
 * schedulers), hand over (stop the schedulers, release the lease), and recover
 * a lost lease. `scheduler` is src/util/scheduler.ts.
 */
function createOwnership({ lease, scheduler, log = null, onOwned = () => {} }: { lease: Lease; scheduler: OwnershipScheduler; log?: LeaseLog | null; onOwned?: () => unknown }) {
  let want = false;
  let taking: Promise<boolean> | null = null;

  function takeOver() {
    want = true;
    if (taking) return taking;
    taking = (async () => {
      const got = await lease.acquire();
      if (got && want) {
        scheduler.start();
        if (log) log.info('holding the worker lease: passes started');
        onOwned();
        return true;
      }
      if (got) await lease.release();
      return false;
    })().finally(() => {
      taking = null;
    });
    return taking;
  }

  // Prompt by design: timers are cleared and the lease is released before any
  // pass in flight finishes (its pass lock keeps the next generation off that
  // one pass until it does). Services get a short grace to stop.
  async function handOver() {
    want = false;
    const t0 = Date.now();
    await scheduler.stop();
    await lease.release();
    if (log) log.info('released the worker lease', { ms: Date.now() - t0, running: scheduler.running() });
  }

  async function lost(err: Error | null | undefined) {
    if (log) log.warn('lost the worker lease (lock connection died) — stopping passes and re-acquiring', { message: err && err.message });
    await scheduler.stop();
    if (want) {
      want = false;
      return takeOver();
    }
    return false;
  }

  return { takeOver, handOver, lost, owning: () => lease.held() && want };
}

module.exports = { createLease, createOwnership, WORKER_KEY, PASS_SPACE };
