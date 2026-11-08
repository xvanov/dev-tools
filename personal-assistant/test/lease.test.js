'use strict';

// Single-owner background work (src/util/lease.js, src/util/scheduler.ts;
// docs/native/PLAN.md Z2). Two worker generations share one fake Postgres
// whose advisory locks behave like the real ones (per session, re-entrant,
// gone when the session ends), so this needs no database.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createLease, createOwnership } = require('../src/util/lease');
const { createScheduler } = require('../src/util/scheduler.ts');
const { passes } = require('../src/util/exclusive.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for a condition instead of sleeping and hoping: a loaded machine slows timers and queries, and
// this test is about what happens, not how fast. Fails after 15 s with the condition's text.
async function until(cond, what, ms = 15000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail('timed out waiting for: ' + what);
    await sleep(5);
  }
}

// Advisory locks: key -> {session, count}. Same shape of SQL the lease sends.
const overlaps = [];

function fakePg() {
  const locks = new Map();
  let sessions = 0;
  const keyOf = (params) => (params.length === 1 ? `1:${params[0]}` : `2:${params[0]}:${params[1]}`);
  function connect() {
    const session = ++sessions;
    const handlers = {};
    const client = {
      session,
      dead: false,
      on: (ev, fn) => (handlers[ev] = fn),
      async query(text, params) {
        if (client.dead) throw new Error('connection terminated');
        // pg wants one query at a time per client (overlap is gone in pg 9).
        if (client.busy) overlaps.push(text);
        client.busy = true;
        await sleep(1);
        client.busy = false;
        const k = keyOf(params);
        if (/pg_try_advisory_lock/.test(text)) {
          const l = locks.get(k);
          if (l && l.session !== session) return { rows: [{ ok: false }] };
          locks.set(k, { session, count: (l ? l.count : 0) + 1 });
          return { rows: [{ ok: true }] };
        }
        if (/pg_advisory_unlock/.test(text)) {
          const l = locks.get(k);
          if (!l || l.session !== session) return { rows: [{ pg_advisory_unlock: false }] };
          if (--l.count === 0) locks.delete(k);
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        throw new Error(`unexpected sql: ${text}`);
      },
      release() {
        for (const [k, l] of locks) if (l.session === session) locks.delete(k);
      },
      // The server drops the connection: every lock of the session goes.
      kill() {
        client.dead = true;
        client.release();
        handlers.error && handlers.error(new Error('terminated'));
      },
    };
    return Promise.resolve(client);
  }
  return { connect, locks };
}

const quiet = { info() {}, warn() {}, debug() {} };

async function generation(pg, { pollMs = 50 } = {}) {
  const clients = [];
  const lease = createLease({
    connect: () => pg.connect().then((c) => (clients.push(c), c)),
    pollMs,
    onLost: (err) => own.lost(err),
  });
  const sched = createScheduler({ passes: passes(), lease, log: quiet, firstTickMs: () => 0, serviceStopMs: 200 });
  const own = createOwnership({ lease, scheduler: sched });
  return { lease, sched, own, clients };
}

async function testHandOverIsPrompt() {
  const pg = fakePg();
  const a = await generation(pg);
  const b = await generation(pg);

  // Generation A owns the passes; a slow one is in flight when it drains.
  let releaseSlow;
  const slowDone = new Promise((r) => (releaseSlow = r));
  const ran = { a: [], b: [] };
  a.sched.every(3600, 'distill', async () => {
    ran.a.push('distill');
    await slowDone;
  });
  a.sched.every(3600, 'embed', async () => ran.a.push('embed'));
  let aServiceStopped = false;
  a.sched.service('teams-cache', () => () => (aServiceStopped = true));

  b.sched.every(0.05, 'distill', async () => ran.b.push('distill'));
  b.sched.every(0.05, 'embed', async () => ran.b.push('embed'));
  let bServiceStarted = 0;
  b.sched.service('teams-cache', () => {
    bServiceStarted++;
    return () => {};
  });

  assert.strictEqual(await a.own.takeOver(), true);
  // Lock queries are queued on the one lock connection (a few timer ticks).
  await until(() => ran.a.length >= 2, 'A runs both passes');
  assert.deepStrictEqual(ran.a.slice().sort(), ['distill', 'embed']);

  // B waits: nothing of its runs while A holds the lease.
  const bTook = b.own.takeOver();
  await sleep(150);
  assert.strictEqual(b.lease.held(), false, 'B must wait while A holds the lease');
  assert.deepStrictEqual(ran.b, []);
  assert.strictEqual(bServiceStarted, 0, 'no watcher starts before the lease');

  // Drain: A hands over at once, with distill still running.
  const t0 = Date.now();
  await a.own.handOver();
  const handOverMs = Date.now() - t0;
  // The slow pass is only released by this test, so waiting for it would hang: any finite bound proves it.
  assert.ok(handOverMs < 10000, `hand-over took ${handOverMs} ms; it must not wait for the slow pass`);
  assert.strictEqual(aServiceStopped, true, "A's watcher is stopped on drain");
  assert.strictEqual(a.sched.started(), false);

  assert.strictEqual(await bTook, true);
  const takeOverMs = Date.now() - t0;
  assert.ok(takeOverMs < 10000, `B took over ${takeOverMs} ms after the drain (about 2 s on an idle machine)`);
  assert.strictEqual(bServiceStarted, 1);

  // B runs every pass except the one A is still finishing.
  await until(() => ran.b.includes('embed'), 'B runs the passes A is not running');
  await sleep(100); // distill had its chance to start too: it must not have
  assert.ok(ran.b.includes('embed'), 'B runs the passes A is not running');
  assert.ok(!ran.b.includes('distill'), 'B must skip a pass A is still running');
  assert.deepStrictEqual(ran.a.filter((n) => n === 'embed').length, 1, 'A starts nothing after the drain');

  releaseSlow();
  await until(() => ran.b.includes('distill'), 'B runs distill once A has finished it');
  assert.ok(ran.b.includes('distill'), 'B runs distill once A has finished it');

  // Rollback: B hands back, A takes the lease and its passes again.
  await b.own.handOver();
  assert.strictEqual(await a.own.takeOver(), true);
  assert.strictEqual(a.sched.started(), true);
  await a.own.handOver();
  await a.lease.close();
  await b.lease.close();
}

async function testCalledOffWait() {
  const pg = fakePg();
  const a = await generation(pg);
  const b = await generation(pg);
  await a.own.takeOver();
  const waiting = b.own.takeOver();
  await sleep(80);
  // A rollback before B ever got the lease: B is told to drain while waiting.
  await b.own.handOver();
  assert.strictEqual(await waiting, false);
  await a.own.handOver();
  await sleep(150);
  assert.strictEqual(b.lease.held(), false, 'a called-off wait must not take the lease later');
  assert.strictEqual(b.sched.started(), false);
}

async function testLostConnection() {
  const pg = fakePg();
  const a = await generation(pg);
  let ticks = 0;
  a.sched.every(0.03, 'tick', async () => ticks++);
  await a.own.takeOver();
  await until(() => ticks > 0, 'the scheduler ticks');
  a.clients[0].kill(); // Postgres restarted: the lease is gone with the session
  // It stops, re-acquires on a new connection and starts again.
  await until(() => a.clients.length === 2 && a.lease.held() && a.sched.started(), 're-acquire on a new connection');
  assert.strictEqual(a.lease.held(), true, 'the lease is re-acquired on a new connection');
  assert.strictEqual(a.clients.length, 2);
  assert.strictEqual(a.sched.started(), true);
  await a.own.handOver();
  await a.lease.close();
}

async function testSchedulerStops() {
  let ticks = 0;
  const sched = createScheduler({ passes: passes(), firstTickMs: () => 0 });
  sched.every(0.02, 'x', async () => ticks++);
  await sleep(60);
  assert.strictEqual(ticks, 0, 'nothing runs before start()');
  sched.start();
  await until(() => ticks >= 2, 'two ticks after start()');
  await sched.stop();
  const at = ticks;
  await sleep(80);
  assert.strictEqual(ticks, at, 'nothing runs after stop()');
  // A service whose start is still pending when stopped is stopped once it starts.
  let stopped = false;
  sched.start();
  sched.service('slow', () => sleep(50).then(() => () => (stopped = true)));
  await sched.stop();
  await until(() => stopped, 'the late-starting service is stopped');
  assert.strictEqual(stopped, true);
}

// The worker must not start background work outside the scheduler: every
// timer and watcher goes through sched, which runs only under the lease.
function testWorkerDeclaresEverythingOnTheScheduler() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');
  assert.ok(!/\bsetInterval\s*\(/.test(src), 'worker.js must not call setInterval: use every()');
  assert.ok(!/pg_try_advisory_lock/.test(src), 'the lock lives in src/util/lease.js');
  assert.ok(/sched\.service\('teams-cache'/.test(src), 'the Teams watcher is a scheduler service');
  assert.ok(/sched\.service\('durable-worker'/.test(src), 'the durable worker is a scheduler service');
  assert.ok(!/require\('\.\/ingest\/teamsLocal'\)\.watch\(/.test(src.replace(/sched\.service\('teams-cache',[\s\S]*?\n {4}\);/, '')), 'teamsLocal.watch only inside its service');
  assert.ok(!/\.startWorker\(\)/.test(src.replace(/sched\.service\('durable-worker',[\s\S]*?\n {4}\}\);/, '')), 'startWorker only inside its service');
  assert.ok(/m\.type === 'drain'[\s\S]*?handOver\(\)/.test(src), 'drain hands the passes over');
  assert.ok(/m\.type === 'undrain'[\s\S]*?takeOver\(\)/.test(src), 'undrain takes them back');
}

async function main() {
  await testSchedulerStops();
  await testHandOverIsPrompt();
  await testCalledOffWait();
  await testLostConnection();
  testWorkerDeclaresEverythingOnTheScheduler();
  assert.deepStrictEqual(overlaps, [], 'two queries at once on the lock connection');
  console.log('lease: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
