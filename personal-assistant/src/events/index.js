'use strict';

// This process's event bus (src/events/bus.js) and what feeds it.
//
// Writers do not publish by hand. Postgres triggers on the tables the views
// show (sql/034_events_notify.sql: commitment, run, proposal, draft,
// factory_board, routine, …) send `pg_notify('pa_events', {topic, table, op,
// id, …})` at commit, so every writer is covered whatever process it runs in:
// the worker's passes, `pa` on the command line, the MCP server Jarvis calls,
// and the previous worker generation still finishing its passes during a roll.
// One dedicated connection LISTENs and republishes each notification on the
// bus; GET /api/events (src/dashboard/events.js) streams the bus.
//
// A supervised generation starts the listener before it says ready (so a
// stream moved to it by a roll can be replayed, bus.js); otherwise it starts
// with the first stream. Either way it is not under the lease: it serves
// the dashboard, which a supervised generation brings up before it holds the
// worker lock, and it is not background work (AGENT.md, "How the worker runs").
//
// The same triggers also write each event to the outbox table (sql/036, plan
// 1.4) under its global number, in the writer's transaction. NOTIFY stays the
// live wake-up; the outbox is what a reconnecting listener backfills from
// (backfill) and what GET /api/events replays a `g<n>` Last-Event-ID from
// after a restart or a roll (fromOutbox). Its SQL is src/repo/events.js.

const { createBus, TOPIC } = require('./bus.ts');
const { logger } = require('../log.ts');

const log = logger('events');
const CHANNEL = 'pa_events';

/** The repositories over one connection (the LISTEN one). */
function reposOn(client) {
  const { createRepos, clientBackend } = require('../repo');
  return createRepos(clientBackend(client));
}

let shared = null;
function bus() {
  if (!shared) shared = createBus();
  return shared;
}

/** Publishes in this process only (a change no table records). */
function publish(topic, payload) {
  return bus().publish(topic, payload);
}

/** Pure. A NOTIFY payload as {topic, payload}, or null when it is not one of ours. */
function fromNotify(text) {
  let o;
  try {
    o = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.topic !== 'string' || !TOPIC.test(o.topic)) return null;
  const { topic, ...payload } = o;
  return { topic, payload };
}

/**
 * LISTENs on CHANNEL over one connection from `connect()` and calls
 * onEvent({topic, payload}) per notification. A dropped connection is
 * reopened (with backoff); notifications sent while it was down are lost, so
 * each reconnect calls onReconnect() and the pages refetch once.
 */
function createListener({ connect, onEvent, onReconnect = () => {}, onListening = async () => {}, retryMs = [500, 1000, 2000, 5000, 15000] }) {
  let current = null;
  let stopped = false;
  let connectedOnce = false;
  let attempt = 0;
  let timer = null;
  let firstUp;
  const listening = new Promise((r) => (firstUp = r));

  function schedule() {
    if (stopped || timer) return;
    const wait = retryMs[Math.min(attempt++, retryMs.length - 1)];
    timer = setTimeout(() => {
      timer = null;
      open();
    }, wait);
    timer.unref?.();
  }

  async function open() {
    if (stopped || current) return;
    let client = null;
    try {
      client = await connect();
      const drop = (err) => {
        if (current !== client) return;
        current = null;
        log.debug('event feed dropped', { message: err?.message || 'ended' });
        Promise.resolve(client.end?.()).catch(() => {});
        schedule();
      };
      client.on('error', drop);
      client.on('end', drop);
      client.on('notification', (n) => {
        if (n.channel !== CHANNEL) return;
        const e = fromNotify(n.payload);
        if (e) onEvent(e);
      });
      await reposOn(client).events.listen(CHANNEL);
      // After LISTEN, not before: see onListening in ensureListening.
      await Promise.resolve(onListening(client)).catch(() => {});
      if (stopped) return Promise.resolve(client.end?.()).catch(() => {});
      current = client;
      attempt = 0;
      if (connectedOnce) onReconnect();
      connectedOnce = true;
      firstUp(true);
    } catch (err) {
      log.debug('event feed not connected — retrying', { message: err.message });
      if (client) Promise.resolve(client.end?.()).catch(() => {});
      schedule();
    }
  }

  open();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      const c = current;
      current = null;
      if (c) return Promise.resolve(c.end?.()).catch(() => {});
      return Promise.resolve();
    },
    connected: () => Boolean(current),
    /** Resolves once the feed first listens (and has its baseline). */
    listening,
  };
}

let listening = null;

/** Starts the Postgres feed for this process's bus, once. */
function ensureListening() {
  if (listening) return listening;
  const { config } = require('../config.ts');
  listening = createListener({
    connect: async () => {
      // PA_DB=sqlite: a session of the store's own backend (LISTEN is in-process
      // there, and other processes' events arrive by its outbox poll), never a
      // connection to PA_DATABASE_URL, which may be a live Postgres.
      const repo = require('../repo');
      if (repo.backend.dialect === 'sqlite') return repo.backend.connect();
      const { Client } = require('pg');
      const c = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10_000 });
      await c.connect();
      return c;
    },
    // seq (sql/035) makes the id global across worker generations (bus.js).
    onEvent: (e) => bus().publish(e.topic, e.payload, { gid: e.payload && e.payload.seq }),
    // The sequence's value once LISTEN is in place: any event numbered at or
    // under it that this process never received was committed before it
    // began listening (bus.js, "baseline"). No sequence yet (before 035): none.
    // Read on the LISTEN connection itself, through the events repository.
    onListening: async (client) => {
      bus().setBaseline(await reposOn(client).events.head());
    },
    // What was committed while the feed was down is in the outbox (1.4):
    // backfill it instead of making every page refetch.
    onReconnect: () => backfill(),
  });
  return listening;
}

/** Pure. An outbox row (src/repo/events.js) as a bus event. */
function outboxEvent(row) {
  return { id: `g${row.seq}`, topic: row.topic, at: new Date(row.at).toISOString(), payload: row.payload ?? {} };
}

/**
 * What came after the global number `n`, from the outbox (sql/036): {gap,
 * events} as bus.since() answers. A gap when more than `limit` are waiting, or
 * when events after `n` may have been pruned (n older than the oldest kept,
 * or an empty outbox behind the sequence): then the client refetches once.
 * Throws when the outbox cannot be read (no database, schema before 036).
 */
async function fromOutbox(n, { topics = null, limit = 1000, store = null } = {}) {
  const s = store || require('../repo').events;
  const [page, oldest, head] = await Promise.all([s.after(n, { topics, limit }), s.oldest(), s.head()]);
  const N = BigInt(n);
  const pruned = oldest == null ? head != null && BigInt(head) > N : N < BigInt(oldest) - 1n;
  if (page.more || pruned) return { gap: true, events: [] };
  return { gap: false, events: page.events.map(outboxEvent) };
}

/** Publishes what the outbox holds past the bus's highest number; a resync when it cannot. */
async function backfill({ b = bus(), store = null } = {}) {
  const from = b.highGid();
  try {
    if (from == null) throw new Error('nothing to backfill from');
    const r = await fromOutbox(from, { store });
    if (r.gap) throw new Error('too far behind');
    for (const e of r.events) b.publish(e.topic, e.payload, { gid: e.id.slice(1) });
    return r.events.length;
  } catch (err) {
    log.debug('event feed backfill failed — resync', { message: err.message });
    b.publish('resync', { reason: 'the event feed reconnected' });
    return null;
  }
}

/** Tests only: a stand-in for ensureListening (the endpoint calls it per stream). */
let listenHook = null;
function _setListen(fn) {
  listenHook = fn;
}
function listen() {
  return listenHook ? listenHook() : ensureListening();
}

module.exports = { bus, publish, fromNotify, createListener, ensureListening, listen, _setListen, CHANNEL, fromOutbox, outboxEvent, backfill };
